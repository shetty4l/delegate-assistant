import { addChunkMetadata, splitMessage } from "@assistant-core/src/chunking";
import { logInfo } from "@assistant-core/src/logging";
import type { WorkerContext } from "@assistant-core/src/worker-context";
import type { LogFields } from "@assistant-core/src/worker-types";
import { TelegramApiError } from "@delegate/adapters-telegram";
import type { ChatPort } from "@delegate/ports";

const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Send a message to a chat, automatically chunking long text into multiple
 * Telegram messages. Each chunk fits within 4096 characters and preserves
 * markdown structure (paragraphs, code fences).
 *
 * If costFooter is provided, it is appended to the last chunk only.
 * Multi-chunk messages get part indicators: " (1/3)", " (2/3)", " (3/3)".
 */
export const sendMessage = async (
  ctx: WorkerContext,
  chatPort: ChatPort,
  outbound: { chatId: string; threadId?: string | null; text: string },
  fields: LogFields,
  costFooter?: string,
): Promise<void> => {
  const rawChunks = splitMessage(
    outbound.text,
    TELEGRAM_MAX_LENGTH,
    costFooter?.length ?? 0,
  );
  const chunks = addChunkMetadata(rawChunks, costFooter);

  if (chunks.length > 1) {
    logInfo("chat.message.chunked", {
      chatId: outbound.chatId,
      originalLength: outbound.text.length + (costFooter?.length ?? 0),
      chunks: chunks.length,
    });
  }

  let threadId =
    outbound.threadId === undefined
      ? (ctx.lastThreadId.get(outbound.chatId) ?? null)
      : outbound.threadId;

  for (let i = 0; i < chunks.length; i += 1) {
    const text = chunks[i]!;
    const payload =
      threadId === null
        ? { chatId: outbound.chatId, text }
        : { chatId: outbound.chatId, threadId, text };

    try {
      await chatPort.send(payload);
    } catch (error) {
      const shouldRetryWithoutThread =
        threadId !== null &&
        error instanceof TelegramApiError &&
        error.statusCode === 400;
      if (!shouldRetryWithoutThread) {
        if (i > 0) {
          logInfo("chat.message.partial_send", {
            chatId: outbound.chatId,
            chunksSent: i,
            chunksTotal: chunks.length,
          });
        }
        throw error;
      }

      await chatPort.send({ chatId: outbound.chatId, text });
      logInfo("chat.message.sent_retry_without_thread", {
        chatId: outbound.chatId,
        droppedThreadId: threadId,
        reason: "telegram_400",
      });
      // Clear threadId so remaining chunks don't repeat the failed attempt.
      threadId = null;
    }
  }

  logInfo("chat.message.sent", {
    chatId: outbound.chatId,
    chars: chunks.reduce((sum, c) => sum + c.length, 0),
    ...fields,
  });
};
