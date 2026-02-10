import { beforeEach, describe, expect, test } from "bun:test";
import type { ModelTurnResponse } from "@delegate/domain";
import type { RespondInput } from "@delegate/ports";
import {
  BehaviorTestHarness,
  DelayedModel,
  FailingModel,
  NeverResolvingModel,
} from "./test-harness";

describe("relay behaviors", () => {
  let harness: BehaviorTestHarness;

  test("user sends a message and receives a reply", async () => {
    harness = new BehaviorTestHarness({
      modelRespondFn: async (input: RespondInput) => ({
        mode: "chat_reply",
        confidence: 1,
        replyText: `response to: ${input.text}`,
        sessionId: "ses-1",
      }),
    });
    await harness.start();

    await harness.sendMessage("chat-relay-1", "hello");

    const replies = harness.getReplies("chat-relay-1");
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const finalReply = replies[replies.length - 1];
    expect(finalReply?.text).toContain("response to: hello");
  });

  test("reply is sent to the same thread as the message", async () => {
    harness = new BehaviorTestHarness({
      modelRespondFn: async () => ({
        mode: "chat_reply",
        confidence: 1,
        replyText: "threaded reply",
        sessionId: "ses-2",
      }),
    });
    await harness.start();

    await harness.sendMessage("chat-relay-2", "hello", "thread-42");

    const replies = harness.getReplies("chat-relay-2");
    const finalReply = replies[replies.length - 1];
    expect(finalReply?.text).toBe("threaded reply");
    expect(finalReply?.threadId).toBe("thread-42");
  });

  test("bot shows a progress indicator for slow model responses", async () => {
    harness = new BehaviorTestHarness({
      modelPort: new DelayedModel(40, {
        mode: "chat_reply",
        confidence: 1,
        replyText: "slow-done",
        sessionId: "ses-slow",
      }),
      progressFirstMs: 5,
      progressEveryMs: 100,
      progressMaxCount: 1,
      relayTimeoutMs: 200,
    });
    await harness.start();

    await harness.sendMessage("chat-relay-3", "slow request");

    const replies = harness.getReplies("chat-relay-3");
    expect(replies.length).toBe(2);
    expect(replies[0]?.text).toContain("Still working");
    expect(replies[1]?.text).toBe("slow-done");
  });

  test("bot replies with a timeout error when model is unresponsive", async () => {
    harness = new BehaviorTestHarness({
      modelPort: new NeverResolvingModel(),
      relayTimeoutMs: 20,
      sessionRetryAttempts: 0,
    });
    await harness.start();

    await harness.sendMessage("chat-relay-4", "hanging request");

    const replies = harness.getReplies("chat-relay-4");
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const lastReply = replies[replies.length - 1];
    expect(lastReply?.text).toContain("did not finish within");
  });

  test("bot retries and eventually replies with an error on persistent model failure", async () => {
    harness = new BehaviorTestHarness({
      modelPort: new FailingModel("transport error"),
      relayTimeoutMs: 200,
      sessionRetryAttempts: 1,
    });
    await harness.start();

    await harness.sendMessage("chat-relay-5", "failing request");

    const replies = harness.getReplies("chat-relay-5");
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const lastReply = replies[replies.length - 1];
    expect(lastReply?.text).toContain("transport/delivery issue");
  });
});
