import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent } from "@delegate/domain";
import { ModelError } from "@delegate/domain";
import type { RespondInput, TurnEventSink } from "@delegate/ports";
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

  describe("turn event emission", () => {
    const buildCapturingSink = (): {
      sink: TurnEventSink;
      events: TurnEvent[];
    } => {
      const events: TurnEvent[] = [];
      return {
        sink: {
          emit: async (event: TurnEvent) => {
            events.push(event);
          },
        },
        events,
      };
    };

    test("emits turn_started and turn_completed on success", async () => {
      const originalPrompt = Agent.prototype.prompt;
      Agent.prototype.prompt = mock(async function (this: Agent) {
        (this.state as any).messages = [
          { role: "assistant", content: [{ type: "text", text: "hi" }] },
        ];
      }) as any;

      try {
        const { sink, events } = buildCapturingSink();
        const adapter = makeAdapter({ turnEventSink: sink });
        await adapter.respond(makeInput({ text: "hello world" }));

        // Wait a tick for fire-and-forget promises to resolve
        await new Promise((r) => setTimeout(r, 10));

        const started = events.find((e) => e.eventType === "turn_started");
        expect(started).toBeDefined();
        expect(started!.data.inputText).toBe("hello world");
        expect(started!.turnId).toBeDefined();

        const completed = events.find((e) => e.eventType === "turn_completed");
        expect(completed).toBeDefined();
        expect(completed!.data.replyText).toBe("hi");
        expect(completed!.turnId).toBe(started!.turnId);
      } finally {
        Agent.prototype.prompt = originalPrompt;
      }
    });

    test("emits turn_failed on error", async () => {
      const originalPrompt = Agent.prototype.prompt;
      Agent.prototype.prompt = mock(() => {
        throw new Error("model crash");
      }) as any;

      try {
        const { sink, events } = buildCapturingSink();
        const adapter = makeAdapter({ turnEventSink: sink });

        await expect(adapter.respond(makeInput())).rejects.toThrow(
          /Pi Agent error/,
        );

        await new Promise((r) => setTimeout(r, 10));

        const started = events.find((e) => e.eventType === "turn_started");
        expect(started).toBeDefined();

        const failed = events.find((e) => e.eventType === "turn_failed");
        expect(failed).toBeDefined();
        expect(failed!.data.error).toContain("model crash");
      } finally {
        Agent.prototype.prompt = originalPrompt;
      }
    });

    test("does not break when no sink is provided", async () => {
      const originalPrompt = Agent.prototype.prompt;
      Agent.prototype.prompt = mock(async function (this: Agent) {
        (this.state as any).messages = [
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
        ];
      }) as any;

      try {
        const adapter = makeAdapter(); // no turnEventSink
        const result = await adapter.respond(makeInput());
        expect(result.replyText).toBe("ok");
      } finally {
        Agent.prototype.prompt = originalPrompt;
      }
    });

    test("swallows sink errors silently", async () => {
      const originalPrompt = Agent.prototype.prompt;
      Agent.prototype.prompt = mock(async function (this: Agent) {
        (this.state as any).messages = [
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
        ];
      }) as any;

      try {
        const failingSink: TurnEventSink = {
          emit: async () => {
            throw new Error("disk full");
          },
        };
        const adapter = makeAdapter({ turnEventSink: failingSink });
        // Should not throw despite sink failures
        const result = await adapter.respond(makeInput());
        expect(result.replyText).toBe("ok");
      } finally {
        Agent.prototype.prompt = originalPrompt;
      }
    });

    test("emits tool_call and tool_result when agent uses tools", async () => {
      const originalPrompt = Agent.prototype.prompt;
      const originalSubscribe = Agent.prototype.subscribe;

      // Capture the subscriber so we can fire events
      let subscriber: ((event: any) => void) | null = null;
      Agent.prototype.subscribe = mock(function (
        this: Agent,
        fn: (event: any) => void,
      ) {
        subscriber = fn;
        return () => {
          subscriber = null;
        };
      }) as any;

      Agent.prototype.prompt = mock(async function (this: Agent) {
        // Simulate tool execution events
        if (subscriber) {
          subscriber({
            type: "tool_execution_start",
            toolCallId: "tc-1",
            toolName: "execute_shell",
            args: { command: "ls" },
          });
          subscriber({
            type: "tool_execution_end",
            toolCallId: "tc-1",
            toolName: "execute_shell",
            result: "file1.ts\nfile2.ts",
            isError: false,
          });
          subscriber({
            type: "turn_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              usage: { input: 100, output: 50, cost: { total: 0.01 } },
            },
            toolResults: [],
          });
        }
        (this.state as any).messages = [
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ];
      }) as any;

      try {
        const { sink, events } = buildCapturingSink();
        const adapter = makeAdapter({ turnEventSink: sink });
        await adapter.respond(makeInput());

        await new Promise((r) => setTimeout(r, 10));

        const toolCall = events.find((e) => e.eventType === "tool_call");
        expect(toolCall).toBeDefined();
        expect(toolCall!.data.toolName).toBe("execute_shell");
        expect(toolCall!.data.args).toEqual({ command: "ls" });

        const toolResult = events.find((e) => e.eventType === "tool_result");
        expect(toolResult).toBeDefined();
        expect(toolResult!.data.toolName).toBe("execute_shell");
        expect(toolResult!.data.result).toBe("file1.ts\nfile2.ts");
        expect(toolResult!.data.isError).toBe(false);

        const stepComplete = events.find(
          (e) => e.eventType === "step_complete",
        );
        expect(stepComplete).toBeDefined();
        expect(stepComplete!.data.stepCount).toBe(1);
        expect(stepComplete!.data.cost).toBe(0.01);
      } finally {
        Agent.prototype.prompt = originalPrompt;
        Agent.prototype.subscribe = originalSubscribe;
      }
    });
  });

  describe("LLM error detection (silent errors from pi-agent-core)", () => {
    test("throws ModelError when agent.state.error is set", async () => {
      const originalPrompt = Agent.prototype.prompt;
      Agent.prototype.prompt = mock(async function (this: Agent) {
        (this.state as any).error = "Insufficient credits";
        (this.state as any).messages = [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            stopReason: "error",
            errorMessage: "Insufficient credits",
          },
        ];
      }) as any;

      try {
        const adapter = makeAdapter();
        let caught: Error | undefined;
        try {
          await adapter.respond(makeInput());
        } catch (err) {
          caught = err as Error;
        }

        expect(caught).toBeInstanceOf(ModelError);
        const modelErr = caught as ModelError;
        expect(modelErr.classification).toBe("billing");
        expect(modelErr.upstream).toContain("Insufficient credits");
      } finally {
        Agent.prototype.prompt = originalPrompt;
      }
    });

    test("throws ModelError when stopReason is error even without state.error", async () => {
      const originalPrompt = Agent.prototype.prompt;
      Agent.prototype.prompt = mock(async function (this: Agent) {
        (this.state as any).messages = [
          {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            stopReason: "error",
            errorMessage: "401 Unauthorized",
          },
        ];
      }) as any;

      try {
        const adapter = makeAdapter();
        let caught: Error | undefined;
        try {
          await adapter.respond(makeInput());
        } catch (err) {
          caught = err as Error;
        }

        expect(caught).toBeInstanceOf(ModelError);
        expect((caught as ModelError).classification).toBe("auth");
      } finally {
        Agent.prototype.prompt = originalPrompt;
      }
    });

    test("emits turn_failed with classification on LLM error", async () => {
      const originalPrompt = Agent.prototype.prompt;
      Agent.prototype.prompt = mock(async function (this: Agent) {
        (this.state as any).error = "rate limit exceeded";
        (this.state as any).messages = [
          {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "rate limit exceeded",
          },
        ];
      }) as any;

      try {
        const events: TurnEvent[] = [];
        const sink: TurnEventSink = {
          emit: async (event: TurnEvent) => {
            events.push(event);
          },
        };
        const adapter = makeAdapter({ turnEventSink: sink });

        await expect(adapter.respond(makeInput())).rejects.toThrow(ModelError);
        await new Promise((r) => setTimeout(r, 10));

        const failed = events.find((e) => e.eventType === "turn_failed");
        expect(failed).toBeDefined();
        expect(failed!.data.classification).toBe("rate_limit");
      } finally {
        Agent.prototype.prompt = originalPrompt;
      }
    });
  });

  describe("max-steps partial text", () => {
    test("returns partial text with truncation note on max-steps abort", async () => {
      const originalPrompt = Agent.prototype.prompt;
      const originalSubscribe = Agent.prototype.subscribe;

      let subscriber: ((event: any) => void) | null = null;
      Agent.prototype.subscribe = mock(function (
        this: Agent,
        fn: (event: any) => void,
      ) {
        subscriber = fn;
        return () => {
          subscriber = null;
        };
      }) as any;

      Agent.prototype.prompt = mock(async function (this: Agent) {
        // Simulate a single step that triggers max-steps
        if (subscriber) {
          subscriber({
            type: "turn_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "partial answer" }],
              usage: { input: 100, output: 50, cost: { total: 0.01 } },
            },
            toolResults: [],
          });
        }
        (this.state as any).messages = [
          {
            role: "assistant",
            content: [{ type: "text", text: "partial answer" }],
          },
        ];
      }) as any;

      try {
        const adapter = makeAdapter({ maxSteps: 1 }); // triggers after 1 step
        const result = await adapter.respond(makeInput());

        expect(result.replyText).toContain("partial answer");
        expect(result.replyText).toContain("Reached max steps");
      } finally {
        Agent.prototype.prompt = originalPrompt;
        Agent.prototype.subscribe = originalSubscribe;
      }
    });
  });

  describe("abort()", () => {
    test("calls agent.abort() for an active session", async () => {
      const originalPrompt = Agent.prototype.prompt;
      const originalAbort = Agent.prototype.abort;
      let abortCalled = false;

      Agent.prototype.prompt = mock(async function (this: Agent) {
        (this.state as any).messages = [
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
        ];
      }) as any;
      Agent.prototype.abort = mock(function () {
        abortCalled = true;
      }) as any;

      try {
        const adapter = makeAdapter();
        await adapter.respond(makeInput({ chatId: "c1", threadId: undefined }));

        adapter.abort("c1:root");
        expect(abortCalled).toBe(true);
      } finally {
        Agent.prototype.prompt = originalPrompt;
        Agent.prototype.abort = originalAbort;
      }
    });

    test("is a no-op for unknown session keys", () => {
      const adapter = makeAdapter();
      // Should not throw
      adapter.abort("nonexistent-session");
    });
  });

  describe("step_error emission", () => {
    test("emits step_error when turn_end has stopReason error", async () => {
      const originalPrompt = Agent.prototype.prompt;
      const originalSubscribe = Agent.prototype.subscribe;

      let subscriber: ((event: any) => void) | null = null;
      Agent.prototype.subscribe = mock(function (
        this: Agent,
        fn: (event: any) => void,
      ) {
        subscriber = fn;
        return () => {
          subscriber = null;
        };
      }) as any;

      Agent.prototype.prompt = mock(async function (this: Agent) {
        if (subscriber) {
          subscriber({
            type: "turn_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "Insufficient credits",
              usage: { input: 10, output: 0, cost: { total: 0 } },
            },
            toolResults: [],
          });
        }
        // Set state for the error detection path
        (this.state as any).error = "Insufficient credits";
        (this.state as any).messages = [
          {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "Insufficient credits",
          },
        ];
      }) as any;

      try {
        const events: TurnEvent[] = [];
        const sink: TurnEventSink = {
          emit: async (event: TurnEvent) => {
            events.push(event);
          },
        };
        const adapter = makeAdapter({ turnEventSink: sink });

        await expect(adapter.respond(makeInput())).rejects.toThrow(ModelError);
        await new Promise((r) => setTimeout(r, 10));

        const stepError = events.find((e) => e.eventType === "step_error");
        expect(stepError).toBeDefined();
        expect(stepError!.data.errorMessage).toBe("Insufficient credits");
      } finally {
        Agent.prototype.prompt = originalPrompt;
        Agent.prototype.subscribe = originalSubscribe;
      }
    });
  });
});
