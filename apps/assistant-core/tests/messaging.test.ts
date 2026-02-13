import { describe, expect, test } from "bun:test";
import { addChunkMetadata, splitMessage } from "@assistant-core/src/chunking";
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

// ---------------------------------------------------------------------------
// splitMessage — unit tests
// ---------------------------------------------------------------------------

describe("splitMessage", () => {
  test("returns single chunk for short text", () => {
    const chunks = splitMessage("Hello, world!", 4096);
    expect(chunks).toEqual(["Hello, world!"]);
  });

  test("returns single chunk for text exactly at limit", () => {
    const text = "x".repeat(4096);
    const chunks = splitMessage(text, 4096);
    expect(chunks).toEqual([text]);
  });

  test("splits on paragraph boundary", () => {
    const para1 = "a".repeat(3000);
    const para2 = "b".repeat(3000);
    const text = `${para1}\n\n${para2}`;

    const chunks = splitMessage(text, 4096);
    expect(chunks.length).toBe(2);
    // First chunk should contain only a's (split at the paragraph boundary).
    expect(chunks[0]).toBe(para1);
    // Second chunk should contain only b's.
    expect(chunks[1]).toBe(para2);
  });

  test("splits on line boundary when no paragraph break available", () => {
    // Build a long text with only single-newline separators.
    const lines = Array.from(
      { length: 100 },
      (_, i) => `Line ${String(i)}: ${"x".repeat(50)}`,
    );
    const text = lines.join("\n");

    const chunks = splitMessage(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should fit.
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
    // Reconstruct: joining all chunks should reproduce all original lines.
    const reconstructed = chunks.join("\n");
    for (const line of lines) {
      expect(reconstructed).toContain(line);
    }
  });

  test("handles code fences — closes and reopens at chunk boundary", () => {
    // Create a code block large enough to force splitting (> 4086 chars).
    const codeContent = Array.from(
      { length: 200 },
      (_, i) =>
        `  const value_${String(i)} = ${String(i)}; // ${"x".repeat(30)}`,
    ).join("\n");
    const text = `Some intro text.\n\n\`\`\`typescript\n${codeContent}\n\`\`\`\n\nSome outro.`;

    expect(text.length).toBeGreaterThan(4096);

    const chunks = splitMessage(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk should fit within the limit.
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }

    // The first chunk with code should have an opening fence.
    // Intermediate/continuation chunks should also have opening fences
    // (from the reopen logic).
    const allText = chunks.join("\n");
    expect(allText).toContain("```typescript");
  });

  test("hard-cuts when no newlines available", () => {
    const text = "x".repeat(10000);
    const chunks = splitMessage(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  test("does not produce empty chunks", () => {
    const text = `${"a".repeat(4000)}\n\n${"b".repeat(4000)}`;
    const chunks = splitMessage(text, 4096);
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// addChunkMetadata — unit tests
// ---------------------------------------------------------------------------

describe("addChunkMetadata", () => {
  test("single chunk with no footer returns unchanged", () => {
    const result = addChunkMetadata(["hello"]);
    expect(result).toEqual(["hello"]);
  });

  test("single chunk with footer appends it", () => {
    const result = addChunkMetadata(["hello"], "\n---\ncost");
    expect(result).toEqual(["hello\n---\ncost"]);
  });

  test("multiple chunks get part indicators", () => {
    const result = addChunkMetadata(["chunk1", "chunk2", "chunk3"]);
    expect(result[0]).toBe("chunk1 (1/3)");
    expect(result[1]).toBe("chunk2 (2/3)");
    expect(result[2]).toBe("chunk3 (3/3)");
  });

  test("cost footer goes on last chunk only", () => {
    const result = addChunkMetadata(["chunk1", "chunk2"], "\n---\n$0.05");
    expect(result[0]).toBe("chunk1 (1/2)");
    expect(result[1]).toBe("chunk2\n---\n$0.05 (2/2)");
  });

  test("empty array returns empty", () => {
    const result = addChunkMetadata([]);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sendMessage — integration tests
// ---------------------------------------------------------------------------

describe("sendMessage chunking", () => {
  test("sends short messages as a single call", async () => {
    const ctx = new WorkerContext();
    const chatPort = new CapturingChatPort();

    await sendMessage(
      ctx,
      chatPort,
      { chatId: "c1", text: "Hello, world!" },
      { action: "test" },
    );

    expect(chatPort.sent.length).toBe(1);
    expect(chatPort.sent[0]!.text).toBe("Hello, world!");
  });

  test("sends exactly 4096-char messages as a single call", async () => {
    const ctx = new WorkerContext();
    const chatPort = new CapturingChatPort();
    const text = "y".repeat(4096);

    await sendMessage(
      ctx,
      chatPort,
      { chatId: "c1", text },
      { action: "test" },
    );

    expect(chatPort.sent.length).toBe(1);
    expect(chatPort.sent[0]!.text).toBe(text);
  });

  test("chunks long messages into multiple sends", async () => {
    const ctx = new WorkerContext();
    const chatPort = new CapturingChatPort();
    const text = "x".repeat(10000);

    await sendMessage(
      ctx,
      chatPort,
      { chatId: "c1", text },
      { action: "test" },
    );

    expect(chatPort.sent.length).toBeGreaterThan(1);
    for (const msg of chatPort.sent) {
      expect(msg.text.length).toBeLessThanOrEqual(4096);
    }
    // Last chunk should have part indicator.
    const last = chatPort.sent[chatPort.sent.length - 1]!;
    expect(last.text).toMatch(/\(\d+\/\d+\)$/);
  });

  test("cost footer appears only on last chunk", async () => {
    const ctx = new WorkerContext();
    const chatPort = new CapturingChatPort();
    const text = `${"a".repeat(4000)}\n\n${"b".repeat(4000)}`;
    const footer = "\n\n---\n💰 $0.05 | 12.5k tokens";

    await sendMessage(
      ctx,
      chatPort,
      { chatId: "c1", text },
      { action: "test" },
      footer,
    );

    expect(chatPort.sent.length).toBeGreaterThan(1);
    // Only last message should contain the cost footer.
    for (let i = 0; i < chatPort.sent.length - 1; i++) {
      expect(chatPort.sent[i]!.text).not.toContain("$0.05");
    }
    const last = chatPort.sent[chatPort.sent.length - 1]!;
    expect(last.text).toContain("$0.05");
  });

  test("cost footer on short message works normally", async () => {
    const ctx = new WorkerContext();
    const chatPort = new CapturingChatPort();
    const footer = "\n\n---\n💰 $0.01";

    await sendMessage(
      ctx,
      chatPort,
      { chatId: "c1", text: "Short reply" },
      { action: "test" },
      footer,
    );

    expect(chatPort.sent.length).toBe(1);
    expect(chatPort.sent[0]!.text).toBe("Short reply\n\n---\n💰 $0.01");
  });
});
