import type { InboundMessage, OutboundMessage } from "@delegate/domain";
import type { ChatPort, ChatUpdate } from "@delegate/ports";

type TelegramGetUpdatesResponse = {
  ok: boolean;
  result: Array<{
    update_id: number;
    message?: {
      message_id: number;
      date: number;
      text?: string;
      message_thread_id?: number;
      chat: {
        id: number;
      };
    };
  }>;
};

type TelegramSendMessageResponse = {
  ok: boolean;
};

/**
 * Structured error for Telegram API HTTP failures.
 * Enables reliable error handling via `instanceof` instead of fragile string matching.
 */
export class TelegramApiError extends Error {
  readonly statusCode: number;
  readonly method: string;

  constructor(statusCode: number, method: string) {
    super(`Telegram ${method} failed: ${statusCode}`);
    this.name = "TelegramApiError";
    this.statusCode = statusCode;
    this.method = method;
  }
}

export class TelegramLongPollingAdapter implements ChatPort {
  private readonly baseUrl: string;

  constructor(private readonly botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  async receiveUpdates(cursor: number | null): Promise<ChatUpdate[]> {
    const payload = {
      timeout: 20,
      allowed_updates: ["message"],
      ...(cursor === null ? {} : { offset: cursor }),
    };

    const response = await fetch(`${this.baseUrl}/getUpdates`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new TelegramApiError(response.status, "getUpdates");
    }

    const decoded = (await response.json()) as TelegramGetUpdatesResponse;
    if (!decoded.ok) {
      throw new Error("Telegram getUpdates returned ok=false");
    }

    return decoded.result
      .map((update) => {
        const mapped = this.mapInbound(update.update_id, update.message);
        if (!mapped) {
          return null;
        }
        return {
          updateId: update.update_id,
          message: mapped,
        } satisfies ChatUpdate;
      })
      .filter((entry): entry is ChatUpdate => entry !== null);
  }

  async send(message: OutboundMessage): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: message.chatId,
        text: message.text,
        ...(message.threadId
          ? { message_thread_id: Number(message.threadId) }
          : {}),
      }),
    });

    if (!response.ok) {
      throw new TelegramApiError(response.status, "sendMessage");
    }

    const decoded = (await response.json()) as TelegramSendMessageResponse;
    if (!decoded.ok) {
      throw new Error("Telegram sendMessage returned ok=false");
    }
  }

  private mapInbound(
    updateId: number,
    rawMessage:
      | {
          message_id: number;
          date: number;
          text?: string;
          message_thread_id?: number;
          chat: {
            id: number;
          };
        }
      | undefined,
  ): InboundMessage | null {
    if (!rawMessage?.text) {
      return null;
    }

    return {
      chatId: String(rawMessage.chat.id),
      threadId:
        typeof rawMessage.message_thread_id === "number"
          ? String(rawMessage.message_thread_id)
          : null,
      text: rawMessage.text.trim(),
      receivedAt: new Date(rawMessage.date * 1000).toISOString(),
      sourceMessageId: `${updateId}:${rawMessage.message_id}`,
    };
  }
}
