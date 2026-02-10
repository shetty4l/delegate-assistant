import { logInfo } from "@assistant-core/src/logging";
import type { WorkerContext } from "@assistant-core/src/worker-context";
import type { LogFields } from "@assistant-core/src/worker-types";
import type { ChatPort } from "@delegate/ports";

export const sendMessage = async (
  ctx: WorkerContext,
  chatPort: ChatPort,
  outbound: { chatId: string; threadId?: string | null; text: string },
  fields: LogFields,
): Promise<void> => {
  const threadId =
    outbound.threadId === undefined
      ? (ctx.lastThreadId.get(outbound.chatId) ?? null)
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
