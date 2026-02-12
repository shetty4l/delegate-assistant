import { describe, expect, test } from "bun:test";
import { sendMessage } from "@assistant-core/src/messaging";
import { WorkerContext } from "@assistant-core/src/worker-context";
import type { OutboundMessage } from "@delegate/domain";
import type { ChatPort, ChatUpdate } from "@delegate/ports";

class CapturingChatPort implements ChatPort {
  readonly sent: OutboundMessage[] = [];

  async receiveUpdates(_cursor: number | null): Promise<ChatUpdate[]> {
    return [];
  }

  async send(message: OutboundMessage): Promise<void> {
    this.sent.push(message);
  }
}

describe("sendMessage truncation", () => {
  test("sends short messages unmodified", async () => {
    const ctx = new WorkerContext();
    const chatPort = new CapturingChatPort();
    const text = "Hello, world!";

    await sendMessage(
      ctx,
      chatPort,
      { chatId: "c1", text },
      { action: "test" },
    );

    expect(chatPort.sent[0]!.text).toBe(text);
  });

  test("truncates messages exceeding 4096 chars", async () => {
    const ctx = new WorkerContext();
    const chatPort = new CapturingChatPort();
    const longText = "x".repeat(5000);

    await sendMessage(
      ctx,
      chatPort,
      { chatId: "c1", text: longText },
      { action: "test" },
    );

    const sent = chatPort.sent[0]!.text;
    expect(sent.length).toBeLessThanOrEqual(4096);
    expect(sent).toContain("(Message truncated)");
  });

  test("leaves exactly 4096-char messages untouched", async () => {
    const ctx = new WorkerContext();
    const chatPort = new CapturingChatPort();
    const exactText = "y".repeat(4096);

    await sendMessage(
      ctx,
      chatPort,
      { chatId: "c1", text: exactText },
      { action: "test" },
    );

    expect(chatPort.sent[0]!.text).toBe(exactText);
  });
});
