import type { InboundMessage } from "@delegate/domain";
import type { ChatPort, ModelPort } from "@delegate/ports";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const nowIso = (): string => new Date().toISOString();

type SessionStoreLike = {
  getSession(sessionKey: string): Promise<{
    opencodeSessionId: string;
    lastUsedAt: string;
  } | null>;
  upsertSession(mapping: {
    sessionKey: string;
    opencodeSessionId: string;
    lastUsedAt: string;
    status: "active" | "stale";
  }): Promise<void>;
  markStale(sessionKey: string, updatedAt: string): Promise<void>;
  getCursor(): Promise<number | null>;
  setCursor(cursor: number): Promise<void>;
};

type WorkerDeps = {
  chatPort: ChatPort;
  modelPort: ModelPort;
  sessionStore?: SessionStoreLike;
};

type WorkerOptions = {
  sessionIdleTimeoutMs?: number;
  sessionMaxConcurrent?: number;
  sessionRetryAttempts?: number;
};

type LogFields = Record<string, string | number | boolean | null>;

const chatMessageCountByChatId = new Map<string, number>();
const sessionByKey = new Map<
  string,
  { sessionId: string; lastUsedAt: number }
>();
const lastThreadIdByChatId = new Map<string, string | null>();

const logInfo = (event: string, fields: LogFields = {}): void => {
  console.log(
    JSON.stringify({
      level: "info",
      event,
      ...fields,
    }),
  );
};

const logError = (event: string, fields: LogFields = {}): void => {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      ...fields,
    }),
  );
};

const sendMessage = async (
  chatPort: ChatPort,
  outbound: { chatId: string; threadId?: string | null; text: string },
  fields: LogFields,
): Promise<void> => {
  const threadId =
    outbound.threadId ?? lastThreadIdByChatId.get(outbound.chatId) ?? null;
  await chatPort.send({
    ...outbound,
    ...(threadId ? { threadId } : {}),
  });
  logInfo("chat.message.sent", {
    chatId: outbound.chatId,
    chars: outbound.text.length,
    ...fields,
  });
};

const buildSessionKey = (message: InboundMessage): string =>
  `${message.chatId}:${message.threadId ?? "root"}`;

const upsertSessionInMemory = (
  sessionKey: string,
  sessionId: string,
  touchedAtMs: number,
): void => {
  sessionByKey.set(sessionKey, {
    sessionId,
    lastUsedAt: touchedAtMs,
  });
};

const evictIdleSessions = async (
  deps: WorkerDeps,
  idleTimeoutMs: number,
  maxConcurrent: number,
): Promise<void> => {
  const now = Date.now();

  for (const [sessionKey, state] of sessionByKey.entries()) {
    if (now - state.lastUsedAt <= idleTimeoutMs) {
      continue;
    }
    sessionByKey.delete(sessionKey);
    if (deps.sessionStore) {
      await deps.sessionStore.markStale(
        sessionKey,
        new Date(now).toISOString(),
      );
    }
  }

  if (sessionByKey.size <= maxConcurrent) {
    return;
  }

  const ordered = [...sessionByKey.entries()].sort(
    (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
  );
  while (sessionByKey.size > maxConcurrent && ordered.length > 0) {
    const evicted = ordered.shift();
    if (!evicted) {
      break;
    }
    sessionByKey.delete(evicted[0]);
    if (deps.sessionStore) {
      await deps.sessionStore.markStale(
        evicted[0],
        new Date(now).toISOString(),
      );
    }
  }
};

const loadSessionId = async (
  deps: WorkerDeps,
  sessionKey: string,
): Promise<string | null> => {
  const inMemory = sessionByKey.get(sessionKey);
  if (inMemory) {
    inMemory.lastUsedAt = Date.now();
    return inMemory.sessionId;
  }

  if (!deps.sessionStore) {
    return null;
  }

  const persisted = await deps.sessionStore.getSession(sessionKey);
  if (!persisted) {
    return null;
  }

  upsertSessionInMemory(sessionKey, persisted.opencodeSessionId, Date.now());
  return persisted.opencodeSessionId;
};

const persistSessionId = async (
  deps: WorkerDeps,
  sessionKey: string,
  sessionId: string,
): Promise<void> => {
  const now = Date.now();
  upsertSessionInMemory(sessionKey, sessionId, now);

  if (!deps.sessionStore) {
    return;
  }

  await deps.sessionStore.upsertSession({
    sessionKey,
    opencodeSessionId: sessionId,
    lastUsedAt: new Date(now).toISOString(),
    status: "active",
  });
};

export const handleChatMessage = async (
  deps: WorkerDeps,
  message: InboundMessage,
  options: WorkerOptions = {},
): Promise<void> => {
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? 45 * 60 * 1000;
  const sessionMaxConcurrent = options.sessionMaxConcurrent ?? 5;
  const sessionRetryAttempts = options.sessionRetryAttempts ?? 1;

  await evictIdleSessions(deps, sessionIdleTimeoutMs, sessionMaxConcurrent);

  const priorMessageCount = chatMessageCountByChatId.get(message.chatId) ?? 0;
  chatMessageCountByChatId.set(message.chatId, priorMessageCount + 1);
  lastThreadIdByChatId.set(message.chatId, message.threadId ?? null);

  logInfo("chat.message.received", {
    chatId: message.chatId,
    sourceMessageId: message.sourceMessageId ?? null,
    chars: message.text.length,
  });

  if (message.text.trim().toLowerCase() === "/start") {
    if (priorMessageCount === 0) {
      await sendMessage(
        deps.chatPort,
        {
          chatId: message.chatId,
          threadId: message.threadId ?? null,
          text: "Hi - I am ready. Tell me what you want to work on.",
        },
        { action: "start", firstMessage: true },
      );
    }
    return;
  }

  const sessionKey = buildSessionKey(message);
  const baseInput = {
    chatId: message.chatId,
    threadId: message.threadId ?? null,
    text: message.text,
    context: [] as string[],
    pendingProposalWorkItemId: null,
  };

  let sessionId = await loadSessionId(deps, sessionKey);
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= sessionRetryAttempts; attempt += 1) {
    try {
      const response = await deps.modelPort.respond({
        ...baseInput,
        sessionId,
      });

      if (response.sessionId) {
        await persistSessionId(deps, sessionKey, response.sessionId);
      }

      await sendMessage(
        deps.chatPort,
        {
          chatId: message.chatId,
          threadId: message.threadId ?? null,
          text: response.replyText,
        },
        {
          action: "relay",
          attempt,
          resumedSession: sessionId !== null,
          sessionKey,
        },
      );
      return;
    } catch (error) {
      lastError = error;
      sessionId = null;
      sessionByKey.delete(sessionKey);
      if (deps.sessionStore) {
        await deps.sessionStore.markStale(sessionKey, nowIso());
      }
    }
  }

  await sendMessage(
    deps.chatPort,
    {
      chatId: message.chatId,
      threadId: message.threadId ?? null,
      text: `OpenCode is unavailable right now: ${String(lastError)}. Please retry in a moment.`,
    },
    { action: "relay", stage: "failed" },
  );
};

export const recoverInFlightWorkItems = async (): Promise<{
  expiredApprovals: number;
  cancelledWorkItems: number;
}> => ({
  expiredApprovals: 0,
  cancelledWorkItems: 0,
});

export const startTelegramWorker = (
  deps: WorkerDeps,
  pollIntervalMs: number,
  options: WorkerOptions = {},
): Promise<never> => {
  let cursor: number | null = null;

  const loop = async (): Promise<never> => {
    if (deps.sessionStore) {
      try {
        cursor = await deps.sessionStore.getCursor();
      } catch (error) {
        logError("worker.cursor.restore_failed", {
          error: String(error),
        });
      }
    }

    while (true) {
      try {
        const updates = await deps.chatPort.receiveUpdates(cursor);
        if (updates.length > 0) {
          logInfo("chat.updates.received", {
            count: updates.length,
            cursor,
          });
        }

        for (const update of updates) {
          cursor = update.updateId + 1;
          if (deps.sessionStore) {
            await deps.sessionStore.setCursor(cursor);
          }
          await handleChatMessage(deps, update.message, options);
        }
      } catch (error) {
        logError("worker.cycle.failed", {
          error: String(error),
        });
      }

      await sleep(pollIntervalMs);
    }
  };

  return loop();
};
