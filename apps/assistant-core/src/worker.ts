import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Semaphore, TopicQueueMap } from "@assistant-core/src/concurrency";
import { logError, logInfo, nowIso } from "@assistant-core/src/logging";
import { sendMessage } from "@assistant-core/src/messaging";
import {
  buildRelayFailureText,
  classifyRelayError,
  runWithProgress,
  withTimeout,
} from "@assistant-core/src/relay";
import {
  evictIdleSessions,
  loadSessionId,
  persistSessionId,
} from "@assistant-core/src/session";
import {
  expandSlashCommand,
  isRestartIntent,
  isSlashCommand,
} from "@assistant-core/src/slash-commands";
import { flushPendingStartupAck } from "@assistant-core/src/startup-ack";
import { formatVersionFingerprint } from "@assistant-core/src/version";
import { WorkerContext } from "@assistant-core/src/worker-context";
import {
  buildSessionKey,
  buildTopicKey,
  loadActiveWorkspace,
  setActiveWorkspace,
} from "@assistant-core/src/workspace";
import type { InboundMessage } from "@delegate/domain";

export { WorkerContext } from "@assistant-core/src/worker-context";
export type {
  LogFields,
  RelayErrorClass,
  SessionStoreLike,
  WorkerDeps,
  WorkerOptions,
} from "@assistant-core/src/worker-types";

import type {
  RelayErrorClass,
  WorkerDeps,
  WorkerOptions,
} from "@assistant-core/src/worker-types";

export { flushPendingStartupAck };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const formatTokenCount = (count: number): string => {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return String(count);
};

const formatCostFooter = (usage: {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}): string => {
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const costStr =
    usage.cost < 0.01
      ? `$${usage.cost.toFixed(4)}`
      : `$${usage.cost.toFixed(2)}`;
  return `\n\n---\n💰 ${costStr} | ${formatTokenCount(totalTokens)} tokens`;
};

export const handleChatMessage = async (
  ctx: WorkerContext,
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

  await evictIdleSessions(
    ctx,
    deps,
    sessionIdleTimeoutMs,
    sessionMaxConcurrent,
  );

  const priorMessageCount = ctx.chatMessageCount.get(message.chatId) ?? 0;
  ctx.chatMessageCount.set(message.chatId, priorMessageCount + 1);
  ctx.lastThreadId.set(message.chatId, message.threadId ?? null);

  logInfo("chat.message.received", {
    chatId: message.chatId,
    sourceMessageId: message.sourceMessageId ?? null,
    chars: message.text.length,
  });

  if (message.text.trim().toLowerCase() === "/start") {
    if (priorMessageCount === 0) {
      await sendMessage(
        ctx,
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
      ctx,
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
    ctx,
    deps,
    topicKey,
    defaultWorkspacePath,
  );

  if (message.text.trim() === "/version") {
    await sendMessage(
      ctx,
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

  if (message.text.trim().startsWith("/workspace")) {
    const parts = message.text.trim().split(/\s+/);
    if (parts.length > 1) {
      const targetPath = resolve(parts[1] ?? ".");
      if (!existsSync(targetPath)) {
        await sendMessage(
          ctx,
          deps.chatPort,
          {
            chatId: message.chatId,
            threadId: message.threadId ?? null,
            text: `Workspace path does not exist: ${parts[1]}`,
          },
          { action: "runtime", stage: "workspace_invalid_path" },
        );
        return;
      }
      setActiveWorkspace(ctx, topicKey, targetPath);
      if (deps.sessionStore?.setTopicWorkspace) {
        await deps.sessionStore.setTopicWorkspace(
          topicKey,
          targetPath,
          nowIso(),
        );
      }
      await sendMessage(
        ctx,
        deps.chatPort,
        {
          chatId: message.chatId,
          threadId: message.threadId ?? null,
          text: `Workspace set to: ${targetPath}`,
        },
        { action: "runtime", stage: "workspace_set" },
      );
      return;
    }
    // No argument: show current workspace
    await sendMessage(
      ctx,
      deps.chatPort,
      {
        chatId: message.chatId,
        threadId: message.threadId ?? null,
        text: `Current workspace: ${activeWorkspacePath}`,
      },
      { action: "runtime", stage: "workspace_show" },
    );
    return;
  }

  if (isSlashCommand(message.text)) {
    await sendMessage(
      ctx,
      deps.chatPort,
      {
        chatId: message.chatId,
        threadId: message.threadId ?? null,
        text: "Unknown slash command. Supported: /start, /restart, /version, /workspace",
      },
      { action: "runtime", stage: "unknown_slash" },
    );
    return;
  }

  const sessionKey = buildSessionKey(topicKey);
  if (deps.sessionStore?.touchTopicWorkspace) {
    await deps.sessionStore.touchTopicWorkspace(
      topicKey,
      activeWorkspacePath,
      nowIso(),
    );
  }
  const semaphore = options.concurrencySemaphore;
  if (semaphore) {
    await semaphore.acquire();
  }
  try {
    const baseInput = {
      chatId: message.chatId,
      threadId: message.threadId ?? null,
      text: relayText,
      context: [] as string[],
      pendingProposalWorkItemId: null,
      workspacePath: activeWorkspacePath,
    };

    let sessionId = await loadSessionId(ctx, deps, sessionKey);
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
              ctx,
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
          await persistSessionId(ctx, deps, sessionKey, response.sessionId);
        }

        const replyText = response.usage
          ? response.replyText + formatCostFooter(response.usage)
          : response.replyText;

        await sendMessage(
          ctx,
          deps.chatPort,
          {
            chatId: message.chatId,
            threadId: message.threadId ?? null,
            text: replyText,
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
        logError(
          classification === "timeout" ? "relay.timeout" : "relay.error",
          {
            chatId: message.chatId,
            sessionKey,
            attempt,
            resumedSession: attemptedSessionId !== null,
            classification,
            error: errorText,
          },
        );

        const shouldResetSession =
          attemptedSessionId !== null && classification === "session_invalid";
        if (shouldResetSession) {
          sessionId = null;
          ctx.sessionByKey.delete(sessionKey);
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
      ctx,
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
  } finally {
    if (semaphore) {
      semaphore.release();
    }
  }
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
  const ctx = new WorkerContext();
  const isStopping = (): boolean => options.stopSignal?.aborted ?? false;
  let cursor: number | null = null;
  const queueMap = new TopicQueueMap();
  const maxConcurrent = options.maxConcurrentTopics ?? 3;
  const semaphore =
    options.concurrencySemaphore ?? new Semaphore(maxConcurrent);
  const optionsWithSemaphore = { ...options, concurrencySemaphore: semaphore };

  const loop = async (): Promise<void> => {
    try {
      await flushPendingStartupAck(ctx, deps);
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
          const topicKey = buildTopicKey(update.message);
          queueMap.getOrCreate(topicKey).enqueue(async () => {
            await handleChatMessage(
              ctx,
              deps,
              update.message,
              optionsWithSemaphore,
            );
          });
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

    logInfo("worker.stopping", { pendingQueues: queueMap.size });
    await queueMap.drainAll();
    logInfo("worker.stopped", {});
  };

  return loop();
};
