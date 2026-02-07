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
  relayTimeoutMs?: number;
  progressFirstMs?: number;
  progressEveryMs?: number;
  progressMaxCount?: number;
};

type LogFields = Record<string, string | number | boolean | null>;

type RelayErrorClass =
  | "session_invalid"
  | "timeout"
  | "empty_output"
  | "transport";

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

const classifyRelayError = (error: unknown): RelayErrorClass => {
  const text = String(error).toLowerCase();
  if (text.includes("timed out")) {
    return "timeout";
  }

  if (text.includes("no user-facing text output")) {
    return "empty_output";
  }

  if (
    /stale session|invalid session|session .*not found|unknown session|expired session|session rejected/.test(
      text,
    )
  ) {
    return "session_invalid";
  }

  return "transport";
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const runWithProgress = async <T>(input: {
  task: Promise<T>;
  onProgress: (count: number) => Promise<void>;
  firstMs: number;
  everyMs: number;
  maxCount: number;
}): Promise<T> => {
  const { task, onProgress, firstMs, everyMs, maxCount } = input;
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let count = 0;

  const clearAll = () => {
    stopped = true;
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
  };

  const schedule = (delayMs: number): void => {
    if (stopped || count >= maxCount) {
      return;
    }
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (stopped || count >= maxCount) {
        return;
      }
      count += 1;
      try {
        await onProgress(count);
      } catch {
        // non-blocking progress notification failure
      }

      if (!stopped && count < maxCount) {
        schedule(everyMs);
      }
    }, delayMs);
    timers.add(timer);
  };

  schedule(firstMs);
  try {
    return await task;
  } finally {
    clearAll();
  }
};

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
  const relayTimeoutMs = options.relayTimeoutMs ?? 300_000;
  const progressFirstMs = options.progressFirstMs ?? 10_000;
  const progressEveryMs = options.progressEveryMs ?? 30_000;
  const progressMaxCount = options.progressMaxCount ?? 3;

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
    const attemptedSessionId = sessionId;
    try {
      const response = await runWithProgress({
        task: withTimeout(
          deps.modelPort.respond({
            ...baseInput,
            sessionId,
          }),
          relayTimeoutMs,
          "relay turn",
        ),
        onProgress: async (count) => {
          await sendMessage(
            deps.chatPort,
            {
              chatId: message.chatId,
              threadId: message.threadId ?? null,
              text:
                count === 1
                  ? "Still working on this request..."
                  : "Still working... I'll send the result as soon as it's ready.",
            },
            {
              action: "relay",
              stage: "progress",
              progressCount: count,
              sessionKey,
            },
          );
        },
        firstMs: progressFirstMs,
        everyMs: progressEveryMs,
        maxCount: progressMaxCount,
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
      const errorText = String(error);
      const classification = classifyRelayError(error);
      logError(classification === "timeout" ? "relay.timeout" : "relay.error", {
        chatId: message.chatId,
        sessionKey,
        attempt,
        resumedSession: attemptedSessionId !== null,
        classification,
        error: errorText,
      });

      const shouldResetSession =
        attemptedSessionId !== null && classification === "session_invalid";
      if (shouldResetSession) {
        sessionId = null;
        sessionByKey.delete(sessionKey);
        if (deps.sessionStore) {
          await deps.sessionStore.markStale(sessionKey, nowIso());
        }
        logInfo("relay.session_stale_marked", {
          chatId: message.chatId,
          sessionKey,
          staleSessionId: attemptedSessionId,
        });
      }

      const shouldRetryFresh =
        shouldResetSession && attempt < sessionRetryAttempts;
      if (shouldRetryFresh) {
        logInfo("relay.retry_fresh_session", {
          chatId: message.chatId,
          sessionKey,
          nextAttempt: attempt + 1,
        });
        continue;
      }

      break;
    }
  }

  await sendMessage(
    deps.chatPort,
    {
      chatId: message.chatId,
      threadId: message.threadId ?? null,
      text: "I couldn't reach OpenCode for this request. I reset the session and you can retry now.",
    },
    { action: "relay", stage: "failed", error: String(lastError) },
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
