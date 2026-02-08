import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BuildInfo,
  formatVersionFingerprint,
} from "@assistant-core/src/version";
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
  getTopicWorkspace?(topicKey: string): Promise<string | null>;
  setTopicWorkspace?(
    topicKey: string,
    workspacePath: string,
    updatedAt: string,
  ): Promise<void>;
  listTopicWorkspaces?(topicKey: string): Promise<string[]>;
  touchTopicWorkspace?(
    topicKey: string,
    workspacePath: string,
    updatedAt: string,
  ): Promise<void>;
  getPendingStartupAck?(): Promise<{
    chatId: string;
    threadId: string | null;
    requestedAt: string;
    attemptCount: number;
    lastError: string | null;
  } | null>;
  upsertPendingStartupAck?(entry: {
    chatId: string;
    threadId: string | null;
    requestedAt: string;
    attemptCount: number;
    lastError: string | null;
  }): Promise<void>;
  clearPendingStartupAck?(): Promise<void>;
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
  defaultWorkspacePath?: string;
  stopSignal?: AbortSignal;
  buildInfo?: BuildInfo;
  onRestartRequested?: (input: {
    chatId: string;
    threadId: string | null;
  }) => Promise<void> | void;
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
const activeWorkspaceByTopicKey = new Map<string, string>();
const workspaceHistoryByTopicKey = new Map<string, Set<string>>();

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
    outbound.threadId === undefined
      ? (lastThreadIdByChatId.get(outbound.chatId) ?? null)
      : outbound.threadId;
  const payload =
    threadId === null
      ? {
          chatId: outbound.chatId,
          text: outbound.text,
        }
      : {
          chatId: outbound.chatId,
          threadId,
          text: outbound.text,
        };

  try {
    await chatPort.send(payload);
  } catch (error) {
    const errorText = String(error);
    const shouldRetryWithoutThread =
      threadId !== null &&
      errorText.includes("Telegram sendMessage failed: 400");
    if (!shouldRetryWithoutThread) {
      throw error;
    }

    await chatPort.send({
      chatId: outbound.chatId,
      text: outbound.text,
    });
    logInfo("chat.message.sent_retry_without_thread", {
      chatId: outbound.chatId,
      droppedThreadId: threadId,
      reason: "telegram_400",
    });
  }

  logInfo("chat.message.sent", {
    chatId: outbound.chatId,
    chars: outbound.text.length,
    ...fields,
  });
};

const buildTopicKey = (message: InboundMessage): string =>
  `${message.chatId}:${message.threadId ?? "root"}`;

const buildSessionKey = (topicKey: string, workspacePath: string): string =>
  JSON.stringify([topicKey, workspacePath]);

const rememberWorkspace = (topicKey: string, workspacePath: string): void => {
  const known = workspaceHistoryByTopicKey.get(topicKey) ?? new Set<string>();
  known.add(workspacePath);
  workspaceHistoryByTopicKey.set(topicKey, known);
};

const loadActiveWorkspace = async (
  deps: WorkerDeps,
  topicKey: string,
  defaultWorkspacePath: string,
): Promise<string> => {
  const inMemory = activeWorkspaceByTopicKey.get(topicKey);
  if (inMemory) {
    rememberWorkspace(topicKey, inMemory);
    return inMemory;
  }

  const fromStore = deps.sessionStore?.getTopicWorkspace
    ? await deps.sessionStore.getTopicWorkspace(topicKey)
    : null;
  const resolved = fromStore ?? defaultWorkspacePath;
  activeWorkspaceByTopicKey.set(topicKey, resolved);
  rememberWorkspace(topicKey, resolved);
  if (deps.sessionStore?.touchTopicWorkspace) {
    await deps.sessionStore.touchTopicWorkspace(topicKey, resolved, nowIso());
  }
  return resolved;
};

const RESTART_COMMAND = "/restart";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const findGitRoot = (startPath: string): string | null => {
  let current = startPath;
  while (current !== "/") {
    if (existsSync(resolve(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
};

const runGitCommand = (
  workspacePath: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string; exitCode: number } => {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: workspacePath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  const stderr = new TextDecoder().decode(proc.stderr).trim();
  return {
    ok: proc.exitCode === 0,
    stdout,
    stderr,
    exitCode: proc.exitCode,
  };
};

const runSyncMainWorkflow = (
  workspacePath: string,
):
  | {
      ok: true;
      statusLine: string;
      headLine: string;
    }
  | {
      ok: false;
      command: string;
      details: string;
    } => {
  const insideRepo = runGitCommand(workspacePath, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (!insideRepo.ok || insideRepo.stdout !== "true") {
    return {
      ok: false,
      command: "git rev-parse --is-inside-work-tree",
      details: insideRepo.stderr || insideRepo.stdout || "not a git repository",
    };
  }

  const steps: Array<{ args: string[]; label: string }> = [
    { args: ["switch", "main"], label: "git switch main" },
    { args: ["fetch", "origin"], label: "git fetch origin" },
    { args: ["rebase", "origin/main"], label: "git rebase origin/main" },
  ];

  for (const step of steps) {
    const result = runGitCommand(workspacePath, step.args);
    if (!result.ok) {
      return {
        ok: false,
        command: step.label,
        details: result.stderr || result.stdout || `exit ${result.exitCode}`,
      };
    }
  }

  const status = runGitCommand(workspacePath, [
    "status",
    "--short",
    "--branch",
  ]);
  if (!status.ok) {
    return {
      ok: false,
      command: "git status --short --branch",
      details: status.stderr || status.stdout || `exit ${status.exitCode}`,
    };
  }
  const statusLine =
    status.stdout.split("\n")[0]?.trim() || "(status unavailable)";

  const head = runGitCommand(workspacePath, [
    "log",
    "-1",
    "--oneline",
    "--decorate",
  ]);
  if (!head.ok) {
    return {
      ok: false,
      command: "git log -1 --oneline --decorate",
      details: head.stderr || head.stdout || `exit ${head.exitCode}`,
    };
  }
  const headLine = head.stdout.split("\n")[0]?.trim() || "(head unavailable)";

  return {
    ok: true,
    statusLine,
    headLine,
  };
};

const isRestartIntent = (text: string): boolean => {
  const trimmed = text.trim();
  return (
    /^\/restart$/i.test(trimmed) ||
    /^(restart assistant|restart)$/i.test(trimmed)
  );
};

const expandSlashCommand = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === RESTART_COMMAND) {
    return "restart assistant";
  }
  return text;
};

const isSlashCommand = (text: string): boolean => text.trim().startsWith("/");

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

const buildRelayFailureText = (
  classification: RelayErrorClass,
  relayTimeoutMs: number,
): string => {
  if (classification === "timeout") {
    return `OpenCode did not finish within ${(relayTimeoutMs / 1000).toFixed(0)}s. Please retry, or increase RELAY_TIMEOUT_MS for long-running tasks.`;
  }
  if (classification === "empty_output") {
    return "OpenCode finished without user-visible output. It may have completed internal actions; check logs/artifacts and retry if you still need a summary.";
  }
  if (classification === "session_invalid") {
    return "Your previous session expired. I started a fresh session; please retry this request.";
  }
  return "I hit a transport/delivery issue while relaying this response. Please retry now.";
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

export const flushPendingStartupAck = async (
  deps: WorkerDeps,
): Promise<void> => {
  if (!deps.sessionStore?.getPendingStartupAck) {
    return;
  }

  const pending = await deps.sessionStore.getPendingStartupAck();
  if (!pending) {
    return;
  }

  try {
    await sendMessage(
      deps.chatPort,
      {
        chatId: pending.chatId,
        threadId: pending.threadId,
        text: "Restart complete. I'm back online.",
      },
      {
        action: "runtime",
        stage: "startup_ack",
      },
    );
    if (deps.sessionStore.clearPendingStartupAck) {
      await deps.sessionStore.clearPendingStartupAck();
    }
    logInfo("startup_ack.sent", {
      chatId: pending.chatId,
      threadId: pending.threadId,
      requestedAt: pending.requestedAt,
      attemptsBeforeSuccess: pending.attemptCount,
    });
  } catch (error) {
    if (deps.sessionStore.upsertPendingStartupAck) {
      await deps.sessionStore.upsertPendingStartupAck({
        ...pending,
        attemptCount: pending.attemptCount + 1,
        lastError: String(error),
      });
    }
    logError("startup_ack.failed", {
      chatId: pending.chatId,
      threadId: pending.threadId,
      requestedAt: pending.requestedAt,
      attemptCount: pending.attemptCount + 1,
      error: String(error),
    });
  }
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
  const defaultWorkspacePath = resolve(
    options.defaultWorkspacePath ?? process.cwd(),
  );
  const versionText = options.buildInfo
    ? formatVersionFingerprint(options.buildInfo)
    : "delegate-assistant version unavailable";

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

  const relayText = expandSlashCommand(message.text);

  if (isRestartIntent(message.text)) {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        threadId: message.threadId ?? null,
        text: "Acknowledged. Draining current work and restarting now.",
      },
      { action: "runtime", stage: "restart_requested" },
    );
    if (deps.sessionStore?.upsertPendingStartupAck) {
      await deps.sessionStore.upsertPendingStartupAck({
        chatId: message.chatId,
        threadId: message.threadId ?? null,
        requestedAt: nowIso(),
        attemptCount: 0,
        lastError: null,
      });
      logInfo("startup_ack.scheduled", {
        chatId: message.chatId,
        threadId: message.threadId ?? null,
      });
    }
    if (options.onRestartRequested) {
      await options.onRestartRequested({
        chatId: message.chatId,
        threadId: message.threadId ?? null,
      });
    }
    return;
  }

  const topicKey = buildTopicKey(message);
  const activeWorkspacePath = await loadActiveWorkspace(
    deps,
    topicKey,
    defaultWorkspacePath,
  );

  if (message.text.trim() === "/version") {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        threadId: message.threadId ?? null,
        text: versionText,
      },
      { action: "runtime", stage: "version" },
    );
    return;
  }

  if (message.text.trim().startsWith("/sync")) {
    const parts = message.text.trim().split(/\s+/);
    let targetPath: string | null;

    if (parts.length > 1) {
      // User provided a path: /sync <path>
      targetPath = resolve(parts[1] ?? ".");
      if (!existsSync(targetPath)) {
        await sendMessage(
          deps.chatPort,
          {
            chatId: message.chatId,
            threadId: message.threadId ?? null,
            text: `Directory not found: ${parts[1]}`,
          },
          { action: "runtime", stage: "sync_invalid_path" },
        );
        return;
      }
    } else {
      // No path provided: find assistant's git root
      const gitRoot = findGitRoot(__dirname);
      if (!gitRoot) {
        await sendMessage(
          deps.chatPort,
          {
            chatId: message.chatId,
            threadId: message.threadId ?? null,
            text: "Could not find assistant's git repository. Please provide a path: /sync <path>",
          },
          { action: "runtime", stage: "sync_no_git_root" },
        );
        return;
      }
      targetPath = gitRoot;
    }

    const syncResult = runSyncMainWorkflow(targetPath);
    if (syncResult.ok) {
      await sendMessage(
        deps.chatPort,
        {
          chatId: message.chatId,
          threadId: message.threadId ?? null,
          text: [
            "Done.",
            "",
            "- Switched to `main`",
            "- Fetched from `origin`",
            "- Rebased onto `origin/main`",
            `- Branch status: ${syncResult.statusLine}`,
            `- Current HEAD: ${syncResult.headLine}`,
          ].join("\n"),
        },
        {
          action: "runtime",
          stage: "sync_main",
          workspacePath: targetPath,
        },
      );
      return;
    }

    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        threadId: message.threadId ?? null,
        text: `Sync failed: ${syncResult.command} - ${syncResult.details}`,
      },
      { action: "runtime", stage: "sync_main_failed" },
    );
    return;
  }

  if (isSlashCommand(message.text)) {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        threadId: message.threadId ?? null,
        text: "Unknown slash command. Supported: /start, /restart, /version, /sync",
      },
      { action: "runtime", stage: "unknown_slash" },
    );
    return;
  }

  const sessionKey = buildSessionKey(topicKey, activeWorkspacePath);
  if (deps.sessionStore?.touchTopicWorkspace) {
    await deps.sessionStore.touchTopicWorkspace(
      topicKey,
      activeWorkspacePath,
      nowIso(),
    );
  }
  const baseInput = {
    chatId: message.chatId,
    threadId: message.threadId ?? null,
    text: relayText,
    context: [] as string[],
    pendingProposalWorkItemId: null,
    workspacePath: activeWorkspacePath,
  };

  let sessionId = await loadSessionId(deps, sessionKey);
  let lastError: unknown = null;
  let lastClassification: RelayErrorClass = "transport";

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
          workspacePath: activeWorkspacePath,
        },
      );
      return;
    } catch (error) {
      lastError = error;
      const errorText = String(error);
      const classification = classifyRelayError(error);
      lastClassification = classification;
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
      text: buildRelayFailureText(lastClassification, relayTimeoutMs),
    },
    {
      action: "relay",
      stage: "failed",
      classification: lastClassification,
      error: String(lastError),
    },
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
): Promise<void> => {
  const isStopping = (): boolean => options.stopSignal?.aborted ?? false;
  let cursor: number | null = null;

  const loop = async (): Promise<void> => {
    try {
      await flushPendingStartupAck(deps);
    } catch (error) {
      logError("startup_ack.cycle_failed", {
        error: String(error),
      });
    }

    if (deps.sessionStore) {
      try {
        cursor = await deps.sessionStore.getCursor();
      } catch (error) {
        logError("worker.cursor.restore_failed", {
          error: String(error),
        });
      }
    }

    while (!isStopping()) {
      try {
        const updates = await deps.chatPort.receiveUpdates(cursor);
        if (updates.length > 0) {
          logInfo("chat.updates.received", {
            count: updates.length,
            cursor,
          });
        }

        for (const update of updates) {
          if (isStopping()) {
            break;
          }
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

      if (isStopping()) {
        break;
      }

      await sleep(pollIntervalMs);
    }

    logInfo("worker.stopped", {});
  };

  return loop();
};
