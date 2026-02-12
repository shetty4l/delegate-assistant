import { logInfo } from "@assistant-core/src/logging";
import type { WorkerContext } from "@assistant-core/src/worker-context";
import type { LogFields } from "@assistant-core/src/worker-types";
import { TelegramApiError } from "@delegate/adapters-telegram";
import type { ChatPort } from "@delegate/ports";

const TELEGRAM_MAX_LENGTH = 4096;
const TRUNCATION_SUFFIX = "\n\n---\n(Message truncated)";
const TRUNCATION_TARGET = TELEGRAM_MAX_LENGTH - TRUNCATION_SUFFIX.length;

export const sendMessage = async (
  ctx: WorkerContext,
  chatPort: ChatPort,
  outbound: { chatId: string; threadId?: string | null; text: string },
  fields: LogFields,
): Promise<void> => {
  // Item 6: Truncate messages that exceed Telegram's 4096-char limit
  let text = outbound.text;
  if (text.length > TELEGRAM_MAX_LENGTH) {
    logInfo("chat.message.truncated", {
      chatId: outbound.chatId,
      originalLength: text.length,
    });
    text = text.slice(0, TRUNCATION_TARGET) + TRUNCATION_SUFFIX;
  }

  const threadId =
    outbound.threadId === undefined
      ? (ctx.lastThreadId.get(outbound.chatId) ?? null)
      : outbound.threadId;
  const payload =
    threadId === null
      ? {
          chatId: outbound.chatId,
          text,
        }
      : {
          chatId: outbound.chatId,
          threadId,
          text,
        };

  try {
    await chatPort.send(payload);
  } catch (error) {
    const shouldRetryWithoutThread =
      threadId !== null &&
      error instanceof TelegramApiError &&
      error.statusCode === 400;
    if (!shouldRetryWithoutThread) {
      throw error;
    }

    await chatPort.send({
      chatId: outbound.chatId,
      text,
    });
    logInfo("chat.message.sent_retry_without_thread", {
      chatId: outbound.chatId,
      droppedThreadId: threadId,
      reason: "telegram_400",
    });
  }

  logInfo("chat.message.sent", {
    chatId: outbound.chatId,
    chars: text.length,
    ...fields,
  });
};
