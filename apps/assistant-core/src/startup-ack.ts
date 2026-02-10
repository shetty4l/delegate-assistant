import { logError, logInfo } from "@assistant-core/src/logging";
import { sendMessage } from "@assistant-core/src/messaging";
import type { WorkerContext } from "@assistant-core/src/worker-context";
import type { WorkerDeps } from "@assistant-core/src/worker-types";

export const flushPendingStartupAck = async (
  ctx: WorkerContext,
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
      ctx,
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
