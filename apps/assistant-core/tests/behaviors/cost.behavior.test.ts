import { describe, expect, test } from "bun:test";
import type { ModelTurnResponse } from "@delegate/domain";
import type { RespondInput } from "@delegate/ports";
import { BehaviorTestHarness } from "./test-harness";

describe("cost behaviors", () => {
  test("bot reply includes cost information when usage is present", async () => {
    const harness = new BehaviorTestHarness({
      modelRespondFn: async (
        input: RespondInput,
      ): Promise<ModelTurnResponse> => ({
        mode: "chat_reply",
        confidence: 1,
        replyText: "Here is the answer.",
        sessionId: input.sessionId ?? "ses-cost-1",
        usage: {
          inputTokens: 850,
          outputTokens: 350,
          cost: 0.0023,
        },
      }),
    });
    await harness.start();

    await harness.sendMessage("chat-cost-1", "tell me something");

    const replies = harness.getReplies("chat-cost-1");
    expect(replies.length).toBe(1);
    expect(replies[0]?.text).toContain("Here is the answer.");
    expect(replies[0]?.text).toContain("$0.0023");
    expect(replies[0]?.text).toContain("1.2k tokens");
  });

  test("bot reply has no cost footer when usage is absent", async () => {
    const harness = new BehaviorTestHarness({
      modelRespondFn: async (
        input: RespondInput,
      ): Promise<ModelTurnResponse> => ({
        mode: "chat_reply",
        confidence: 1,
        replyText: "Simple answer.",
        sessionId: input.sessionId ?? "ses-cost-2",
      }),
    });
    await harness.start();

    await harness.sendMessage("chat-cost-2", "tell me something");

    const replies = harness.getReplies("chat-cost-2");
    expect(replies.length).toBe(1);
    expect(replies[0]?.text).toBe("Simple answer.");
  });

  test("negative cost shows only token count without dollar amount", async () => {
    const harness = new BehaviorTestHarness({
      modelRespondFn: async (
        input: RespondInput,
      ): Promise<ModelTurnResponse> => ({
        mode: "chat_reply",
        confidence: 1,
        replyText: "Auto-routed answer.",
        sessionId: input.sessionId ?? "ses-cost-neg",
        usage: {
          inputTokens: 500,
          outputTokens: 734,
          cost: -0.0835,
        },
      }),
    });
    await harness.start();

    await harness.sendMessage("chat-cost-neg", "tell me something");

    const replies = harness.getReplies("chat-cost-neg");
    expect(replies.length).toBe(1);
    expect(replies[0]?.text).toContain("Auto-routed answer.");
    expect(replies[0]?.text).toContain("1.2k tokens");
    expect(replies[0]?.text).not.toContain("$");
  });

  test("zero cost shows only token count without dollar amount", async () => {
    const harness = new BehaviorTestHarness({
      modelRespondFn: async (
        input: RespondInput,
      ): Promise<ModelTurnResponse> => ({
        mode: "chat_reply",
        confidence: 1,
        replyText: "Free answer.",
        sessionId: input.sessionId ?? "ses-cost-zero",
        usage: {
          inputTokens: 200,
          outputTokens: 100,
          cost: 0,
        },
      }),
    });
    await harness.start();

    await harness.sendMessage("chat-cost-zero", "tell me something");

    const replies = harness.getReplies("chat-cost-zero");
    expect(replies.length).toBe(1);
    expect(replies[0]?.text).toContain("Free answer.");
    expect(replies[0]?.text).toContain("300 tokens");
    expect(replies[0]?.text).not.toContain("$");
  });
});
