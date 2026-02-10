import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RespondInput } from "@delegate/ports";
import { Agent } from "@mariozechner/pi-agent-core";
import { PiAgentModelAdapter } from "../src/index";

const tmpDir = mkdtempSync(join(tmpdir(), "pi-agent-unit-"));

const makeAdapter = (overrides: Record<string, unknown> = {}) =>
  new PiAgentModelAdapter({
    provider: "openrouter",
    model: "openrouter/auto",
    maxSteps: 15,
    workspacePath: tmpDir,
    ...overrides,
  });

const makeInput = (overrides: Partial<RespondInput> = {}): RespondInput => ({
  chatId: "test-chat",
  text: "hello",
  context: [],
  pendingProposalWorkItemId: null,
  ...overrides,
});

describe("PiAgentModelAdapter", () => {
  describe("error wrapping", () => {
    test("wraps agent.prompt() errors as Pi Agent error", async () => {
      const originalPrompt = Agent.prototype.prompt;
      Agent.prototype.prompt = mock(() => {
        throw new Error("upstream LLM failure");
      }) as any;

      try {
        const adapter = makeAdapter();
        await expect(
          adapter.respond(makeInput({ text: "trigger error" })),
        ).rejects.toThrow(/Pi Agent error/);

        await expect(
          adapter.respond(makeInput({ text: "trigger error" })),
        ).rejects.toThrow(/upstream LLM failure/);
      } finally {
        Agent.prototype.prompt = originalPrompt;
      }
    });

    test("preserves original error as cause", async () => {
      const originalError = new Error("connection refused");
      const originalPrompt = Agent.prototype.prompt;
      Agent.prototype.prompt = mock(() => {
        throw originalError;
      }) as any;

      try {
        const adapter = makeAdapter();
        let caught: Error | undefined;
        try {
          await adapter.respond(makeInput({ text: "trigger error" }));
        } catch (err) {
          caught = err as Error;
        }

        expect(caught).toBeDefined();
        expect(caught!.message).toContain("Pi Agent error");
        expect((caught as any).cause).toBe(originalError);
      } finally {
        Agent.prototype.prompt = originalPrompt;
      }
    });
  });

  describe("session management", () => {
    test("derives session key from chatId and threadId", async () => {
      const originalPrompt = Agent.prototype.prompt;
      // Mock prompt to make the agent appear to have responded
      Agent.prototype.prompt = mock(async function (this: Agent) {
        // Simulate a minimal assistant message in state
        (this.state as any).messages = [
          { role: "assistant", content: [{ type: "text", text: "mocked" }] },
        ];
      }) as any;

      try {
        const adapter = makeAdapter();
        const result = await adapter.respond(
          makeInput({ chatId: "chat-1", threadId: "thread-1" }),
        );
        expect(result.sessionId).toBe("chat-1:thread-1");
      } finally {
        Agent.prototype.prompt = originalPrompt;
      }
    });

    test("uses 'root' when threadId is absent", async () => {
      const originalPrompt = Agent.prototype.prompt;
      Agent.prototype.prompt = mock(async function (this: Agent) {
        (this.state as any).messages = [
          { role: "assistant", content: [{ type: "text", text: "mocked" }] },
        ];
      }) as any;

      try {
        const adapter = makeAdapter();
        const result = await adapter.respond(
          makeInput({ chatId: "chat-1", threadId: undefined }),
        );
        expect(result.sessionId).toBe("chat-1:root");
      } finally {
        Agent.prototype.prompt = originalPrompt;
      }
    });

    test("uses explicit sessionId when provided", async () => {
      const originalPrompt = Agent.prototype.prompt;
      Agent.prototype.prompt = mock(async function (this: Agent) {
        (this.state as any).messages = [
          { role: "assistant", content: [{ type: "text", text: "mocked" }] },
        ];
      }) as any;

      try {
        const adapter = makeAdapter();
        const result = await adapter.respond(
          makeInput({ sessionId: "custom-session-key" }),
        );
        expect(result.sessionId).toBe("custom-session-key");
      } finally {
        Agent.prototype.prompt = originalPrompt;
      }
    });
  });

  describe("response extraction", () => {
    test("returns '(no response)' when agent produces no assistant message", async () => {
      const originalPrompt = Agent.prototype.prompt;
      Agent.prototype.prompt = mock(async function (this: Agent) {
        (this.state as any).messages = [];
      }) as any;

      try {
        const adapter = makeAdapter();
        const result = await adapter.respond(makeInput());
        expect(result.replyText).toBe("(no response)");
      } finally {
        Agent.prototype.prompt = originalPrompt;
      }
    });

    test("sets mode to chat_reply", async () => {
      const originalPrompt = Agent.prototype.prompt;
      Agent.prototype.prompt = mock(async function (this: Agent) {
        (this.state as any).messages = [
          { role: "assistant", content: [{ type: "text", text: "hi" }] },
        ];
      }) as any;

      try {
        const adapter = makeAdapter();
        const result = await adapter.respond(makeInput());
        expect(result.mode).toBe("chat_reply");
        expect(result.confidence).toBe(1);
      } finally {
        Agent.prototype.prompt = originalPrompt;
      }
    });
  });
});
