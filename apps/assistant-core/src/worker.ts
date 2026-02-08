import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { InboundMessage } from "@delegate/domain";
import type { ChatPort, ModelPort } from "@delegate/ports";
import { type BuildInfo, formatVersionFingerprint } from "./version";

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
  enqueueScheduledMessage?(entry: {
    chatId: string;
    threadId: string | null;
    text: string;
    sendAt: string;
    createdAt: string;
  }): Promise<number>;
  listDueScheduledMessages?(input: { nowIso: string; limit: number }): Promise<
    Array<{
      id: number;
      chatId: string;
      threadId: string | null;
      text: string;
      sendAt: string;
      attemptCount: number;
    }>
  >;
  markScheduledMessageDelivered?(input: {
    id: number;
    deliveredAt: string;
  }): Promise<void>;
  markScheduledMessageFailed?(input: {
    id: number;
    error: string;
    nextAttemptAt: string;
  }): Promise<void>;
  upsertPendingScheduledDeliveryAck?(entry: {
    id: number;
    chatId: string;
    deliveredAt: string;
    nextAttemptAt: string;
  }): Promise<void>;
  listPendingScheduledDeliveryAcks?(limit: number): Promise<
    Array<{
      id: number;
      chatId: string;
      deliveredAt: string;
      nextAttemptAt: string;
    }>
  >;
  clearPendingScheduledDeliveryAck?(id: number): Promise<void>;
};

type SessionStoreWithPersistentScheduling = SessionStoreLike & {
  enqueueScheduledMessage(entry: {
    chatId: string;
    threadId: string | null;
    text: string;
    sendAt: string;
    createdAt: string;
  }): Promise<number>;
  listDueScheduledMessages(input: { nowIso: string; limit: number }): Promise<
    Array<{
      id: number;
      chatId: string;
      threadId: string | null;
      text: string;
      sendAt: string;
      attemptCount: number;
    }>
  >;
  markScheduledMessageDelivered(input: {
    id: number;
    deliveredAt: string;
  }): Promise<void>;
  markScheduledMessageFailed(input: {
    id: number;
    error: string;
    nextAttemptAt: string;
  }): Promise<void>;
  upsertPendingScheduledDeliveryAck(entry: {
    id: number;
    chatId: string;
    deliveredAt: string;
    nextAttemptAt: string;
  }): Promise<void>;
  listPendingScheduledDeliveryAcks(limit: number): Promise<
    Array<{
      id: number;
      chatId: string;
      deliveredAt: string;
      nextAttemptAt: string;
    }>
  >;
  clearPendingScheduledDeliveryAck(id: number): Promise<void>;
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
const inMemoryScheduledMessages: Array<{
  id: number;
  chatId: string;
  threadId: string | null;
  text: string;
  sendAt: string;
  attemptCount: number;
  nextAttemptAt: string | null;
}> = [];
let nextInMemoryScheduleId = 1;

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

const normalizeWorkspacePath = (
  rawInput: string,
  basePath: string,
): string | null => {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return null;
  }
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  if (!unquoted) {
    return null;
  }

  return isAbsolute(unquoted) ? resolve(unquoted) : resolve(basePath, unquoted);
};

const isDirectoryPath = (path: string): boolean => {
  if (!existsSync(path)) {
    return false;
  }
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

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

const setActiveWorkspace = async (
  deps: WorkerDeps,
  topicKey: string,
  workspacePath: string,
): Promise<void> => {
  activeWorkspaceByTopicKey.set(topicKey, workspacePath);
  rememberWorkspace(topicKey, workspacePath);
  const timestamp = nowIso();
  if (deps.sessionStore?.setTopicWorkspace) {
    await deps.sessionStore.setTopicWorkspace(
      topicKey,
      workspacePath,
      timestamp,
    );
  }
  if (deps.sessionStore?.touchTopicWorkspace) {
    await deps.sessionStore.touchTopicWorkspace(
      topicKey,
      workspacePath,
      timestamp,
    );
  }
};

const listKnownWorkspaces = async (
  deps: WorkerDeps,
  topicKey: string,
  activeWorkspacePath: string,
): Promise<string[]> => {
  const known = new Set<string>([activeWorkspacePath]);
  for (const item of workspaceHistoryByTopicKey.get(topicKey) ?? []) {
    known.add(item);
  }
  if (deps.sessionStore?.listTopicWorkspaces) {
    for (const item of await deps.sessionStore.listTopicWorkspaces(topicKey)) {
      known.add(item);
    }
  }
  return [...known].sort((a, b) => a.localeCompare(b));
};

type WorkspaceIntent =
  | { kind: "use_repo"; rawPath: string }
  | { kind: "where_am_i" }
  | { kind: "list_repos" }
  | { kind: "version" }
  | { kind: "schedule_reminder"; whenText: string; reminderText: string }
  | { kind: "none" };

const SYNC_MAIN_COMMAND = "/sync-main";
const SYNC_MAIN_PROMPT =
  "Merged. Go back to main, rebase from origin and confirm.";

const parseWorkspaceIntent = (text: string): WorkspaceIntent => {
  const trimmed = text.trim();
  const remindMatch = /^remind\s+me\s+(?:on|at)\s+(.+?)\s+to\s+(.+)$/i.exec(
    trimmed,
  );
  if (remindMatch) {
    return {
      kind: "schedule_reminder",
      whenText: (remindMatch[1] ?? "").trim(),
      reminderText: (remindMatch[2] ?? "").trim(),
    };
  }
  const useMatch = /^use\s+repo\s+(.+)$/i.exec(trimmed);
  if (useMatch) {
    return { kind: "use_repo", rawPath: useMatch[1] ?? "" };
  }
  if (/^(where\s+am\s+i|pwd)$/i.test(trimmed)) {
    return { kind: "where_am_i" };
  }
  if (/^(list\s+repos|repos)$/i.test(trimmed)) {
    return { kind: "list_repos" };
  }
  if (/^(version|app\s+version|assistant\s+version)$/i.test(trimmed)) {
    return { kind: "version" };
  }
  return { kind: "none" };
};

const ISO_SCHEDULE_PATTERN =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})/;

const parseIsoScheduleDate = (rawInput: string): Date | null => {
  const trimmed = rawInput.trim();
  if (!trimmed.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)) {
    return null;
  }
  const match = trimmed.match(ISO_SCHEDULE_PATTERN);
  if (!match || match[0] !== trimmed) {
    return null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
};

const resolveScheduleDateViaModel = async (
  deps: WorkerDeps,
  input: {
    chatId: string;
    threadId: string | null;
    whenText: string;
    workspacePath: string;
    now: Date;
  },
): Promise<Date | null> => {
  const directIso = parseIsoScheduleDate(input.whenText);
  if (directIso) {
    return directIso;
  }

  const resolutionPrompt = [
    "Convert reminder time text into one exact timestamp.",
    "Return only one line:",
    "- ISO8601 timestamp with timezone offset (example: 2026-02-13T19:00:00-08:00)",
    "- or INVALID",
    "Rules:",
    "- Interpret natural language relative to the provided current time.",
    "- If timezone is omitted, use server local timezone.",
    "- Do not include explanations.",
    `Current server local time: ${input.now.toString()}`,
    `Reminder text: ${input.whenText}`,
  ].join("\n");

  let responseText = "";
  try {
    const response = await deps.modelPort.respond({
      chatId: input.chatId,
      threadId: input.threadId,
      text: resolutionPrompt,
      context: [],
      pendingProposalWorkItemId: null,
      workspacePath: input.workspacePath,
    });
    responseText = response.replyText.trim();
  } catch {
    return null;
  }

  if (responseText.toUpperCase() === "INVALID") {
    return null;
  }

  const resolvedIso = responseText.match(ISO_SCHEDULE_PATTERN)?.[0] ?? "";
  if (!resolvedIso) {
    return null;
  }

  const parsed = new Date(resolvedIso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
};

const getPersistentScheduleStore = (
  sessionStore: SessionStoreLike | undefined,
): SessionStoreWithPersistentScheduling | null => {
  if (
    !sessionStore?.enqueueScheduledMessage ||
    !sessionStore.listDueScheduledMessages ||
    !sessionStore.markScheduledMessageDelivered ||
    !sessionStore.markScheduledMessageFailed ||
    !sessionStore.upsertPendingScheduledDeliveryAck ||
    !sessionStore.listPendingScheduledDeliveryAcks ||
    !sessionStore.clearPendingScheduledDeliveryAck
  ) {
    return null;
  }
  return sessionStore as SessionStoreWithPersistentScheduling;
};

const isRestartIntent = (text: string): boolean =>
  /^(restart assistant|restart)$/i.test(text.trim());

const expandSlashCommand = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === SYNC_MAIN_COMMAND) {
    return SYNC_MAIN_PROMPT;
  }
  return text;
};

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

export const flushDueScheduledMessages = async (
  deps: WorkerDeps,
  now: Date = new Date(),
): Promise<void> => {
  const persistentScheduleStore = getPersistentScheduleStore(deps.sessionStore);
  if (persistentScheduleStore) {
    const nowIso = now.toISOString();
    const pendingDeliveryAcks =
      await persistentScheduleStore.listPendingScheduledDeliveryAcks(200);
    const pendingDeliveryAckIds = new Set(
      pendingDeliveryAcks.map((entry) => entry.id),
    );
    const pendingDeliveryStateUpdates = pendingDeliveryAcks
      .filter((entry) => entry.nextAttemptAt <= nowIso)
      .slice(0, 20);

    for (const pendingAck of pendingDeliveryStateUpdates) {
      try {
        await persistentScheduleStore.markScheduledMessageDelivered({
          id: pendingAck.id,
          deliveredAt: pendingAck.deliveredAt,
        });
        await persistentScheduleStore.clearPendingScheduledDeliveryAck(
          pendingAck.id,
        );
        logInfo("schedule.delivered", {
          scheduleId: pendingAck.id,
          chatId: pendingAck.chatId,
          deliveredAt: pendingAck.deliveredAt,
          persistedOnRetry: true,
        });
      } catch (error) {
        const nextAttemptAt = new Date(now.getTime() + 60_000).toISOString();
        await persistentScheduleStore.upsertPendingScheduledDeliveryAck({
          id: pendingAck.id,
          chatId: pendingAck.chatId,
          deliveredAt: pendingAck.deliveredAt,
          nextAttemptAt,
        });
        logError("schedule.delivery_state_failed", {
          scheduleId: pendingAck.id,
          chatId: pendingAck.chatId,
          error: String(error),
          nextAttemptAt,
        });
      }
    }

    const dueMessages = await persistentScheduleStore.listDueScheduledMessages({
      nowIso,
      limit: 20,
    });

    for (const scheduled of dueMessages) {
      if (pendingDeliveryAckIds.has(scheduled.id)) {
        continue;
      }

      try {
        await sendMessage(
          deps.chatPort,
          {
            chatId: scheduled.chatId,
            threadId: scheduled.threadId,
            text: scheduled.text,
          },
          {
            action: "schedule",
            stage: "deliver",
            scheduleId: scheduled.id,
            attempt: scheduled.attemptCount,
          },
        );
      } catch (error) {
        const nextAttemptAt = new Date(now.getTime() + 60_000).toISOString();
        await persistentScheduleStore.markScheduledMessageFailed({
          id: scheduled.id,
          error: String(error),
          nextAttemptAt,
        });
        logError("schedule.delivery_failed", {
          scheduleId: scheduled.id,
          chatId: scheduled.chatId,
          error: String(error),
          nextAttemptAt,
        });
        continue;
      }

      try {
        await persistentScheduleStore.markScheduledMessageDelivered({
          id: scheduled.id,
          deliveredAt: nowIso,
        });
        logInfo("schedule.delivered", {
          scheduleId: scheduled.id,
          chatId: scheduled.chatId,
          sendAt: scheduled.sendAt,
        });
      } catch (error) {
        const nextAttemptAt = new Date(now.getTime() + 60_000).toISOString();
        await persistentScheduleStore.upsertPendingScheduledDeliveryAck({
          id: scheduled.id,
          chatId: scheduled.chatId,
          deliveredAt: nowIso,
          nextAttemptAt,
        });
        logError("schedule.delivery_state_failed", {
          scheduleId: scheduled.id,
          chatId: scheduled.chatId,
          error: String(error),
          nextAttemptAt,
        });
      }
    }
  }

  const nowIsoMemory = now.toISOString();
  const dueInMemory = inMemoryScheduledMessages
    .filter(
      (item) =>
        item.sendAt <= nowIsoMemory &&
        (item.nextAttemptAt === null || item.nextAttemptAt <= nowIsoMemory),
    )
    .sort((a, b) => a.sendAt.localeCompare(b.sendAt) || a.id - b.id)
    .slice(0, 20);

  for (const scheduled of dueInMemory) {
    try {
      await sendMessage(
        deps.chatPort,
        {
          chatId: scheduled.chatId,
          threadId: scheduled.threadId,
          text: scheduled.text,
        },
        {
          action: "schedule",
          stage: "deliver",
          scheduleId: scheduled.id,
          attempt: scheduled.attemptCount,
          storage: "memory",
        },
      );
      const index = inMemoryScheduledMessages.findIndex(
        (item) => item.id === scheduled.id,
      );
      if (index >= 0) {
        inMemoryScheduledMessages.splice(index, 1);
      }
      logInfo("schedule.delivered", {
        scheduleId: scheduled.id,
        chatId: scheduled.chatId,
        sendAt: scheduled.sendAt,
        storage: "memory",
      });
    } catch (error) {
      const index = inMemoryScheduledMessages.findIndex(
        (item) => item.id === scheduled.id,
      );
      if (index >= 0) {
        inMemoryScheduledMessages[index] = {
          ...inMemoryScheduledMessages[index],
          attemptCount: scheduled.attemptCount + 1,
          nextAttemptAt: new Date(now.getTime() + 60_000).toISOString(),
        };
      }
      logError("schedule.delivery_failed", {
        scheduleId: scheduled.id,
        chatId: scheduled.chatId,
        error: String(error),
        storage: "memory",
      });
    }
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

  const intent = parseWorkspaceIntent(message.text);
  if (intent.kind === "where_am_i") {
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        threadId: message.threadId ?? null,
        text: `Current workspace: ${activeWorkspacePath}`,
      },
      { action: "workspace", stage: "where", topicKey },
    );
    return;
  }

  if (intent.kind === "list_repos") {
    const repos = await listKnownWorkspaces(
      deps,
      topicKey,
      activeWorkspacePath,
    );
    const lines = repos.map((repo) =>
      repo === activeWorkspacePath ? `* ${repo} (active)` : `* ${repo}`,
    );
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        threadId: message.threadId ?? null,
        text: `Known workspaces:\n${lines.join("\n")}`,
      },
      { action: "workspace", stage: "list", topicKey, count: repos.length },
    );
    return;
  }

  if (intent.kind === "version") {
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

  if (intent.kind === "schedule_reminder") {
    if (intent.reminderText.length === 0) {
      await sendMessage(
        deps.chatPort,
        {
          chatId: message.chatId,
          threadId: message.threadId ?? null,
          text: "I need reminder text as well. Try: remind me on <time> to <message>",
        },
        { action: "schedule", stage: "invalid_text" },
      );
      return;
    }

    const parsedDate = await resolveScheduleDateViaModel(deps, {
      chatId: message.chatId,
      threadId: message.threadId ?? null,
      whenText: intent.whenText,
      workspacePath: activeWorkspacePath,
      now: new Date(),
    });
    if (!parsedDate) {
      await sendMessage(
        deps.chatPort,
        {
          chatId: message.chatId,
          threadId: message.threadId ?? null,
          text: "I couldn't parse that schedule time. Try: remind me at tomorrow 7pm to Watch Eternity on Apple TV+",
        },
        { action: "schedule", stage: "invalid_time" },
      );
      return;
    }

    if (parsedDate.getTime() <= Date.now()) {
      await sendMessage(
        deps.chatPort,
        {
          chatId: message.chatId,
          threadId: message.threadId ?? null,
          text: "That time is in the past. Please pick a future time.",
        },
        { action: "schedule", stage: "past_time" },
      );
      return;
    }

    const sendAtIso = parsedDate.toISOString();
    const persistentScheduleStore = getPersistentScheduleStore(
      deps.sessionStore,
    );
    const scheduleId = persistentScheduleStore
      ? await persistentScheduleStore.enqueueScheduledMessage({
          chatId: message.chatId,
          threadId: message.threadId ?? null,
          text: intent.reminderText,
          sendAt: sendAtIso,
          createdAt: nowIso(),
        })
      : (() => {
          const id = nextInMemoryScheduleId;
          nextInMemoryScheduleId += 1;
          inMemoryScheduledMessages.push({
            id,
            chatId: message.chatId,
            threadId: message.threadId ?? null,
            text: intent.reminderText,
            sendAt: sendAtIso,
            attemptCount: 0,
            nextAttemptAt: null,
          });
          return id;
        })();

    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        threadId: message.threadId ?? null,
        text: persistentScheduleStore
          ? `Scheduled reminder (#${scheduleId}) for ${sendAtIso}: ${intent.reminderText}`
          : `Scheduled reminder (#${scheduleId}) for ${sendAtIso}: ${intent.reminderText}\n\nNote: this reminder is in memory and will be lost if the assistant restarts before delivery.`,
      },
      { action: "schedule", stage: "scheduled", scheduleId },
    );
    return;
  }

  if (intent.kind === "use_repo") {
    const normalized = normalizeWorkspacePath(
      intent.rawPath,
      activeWorkspacePath,
    );
    if (!normalized || !isDirectoryPath(normalized)) {
      await sendMessage(
        deps.chatPort,
        {
          chatId: message.chatId,
          threadId: message.threadId ?? null,
          text: `I couldn't switch workspace. Directory not found: ${intent.rawPath.trim() || "(empty)"}`,
        },
        { action: "workspace", stage: "invalid", topicKey },
      );
      return;
    }

    await setActiveWorkspace(deps, topicKey, normalized);
    await sendMessage(
      deps.chatPort,
      {
        chatId: message.chatId,
        threadId: message.threadId ?? null,
        text: `Workspace switched to ${normalized}`,
      },
      { action: "workspace", stage: "switched", topicKey },
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
        await flushDueScheduledMessages(deps);
      } catch (error) {
        logError("schedule.cycle_failed", {
          error: String(error),
        });
      }

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
