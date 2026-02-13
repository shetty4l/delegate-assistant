import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChatMessage, WorkerContext } from "@assistant-core/src/worker";
import type { ModelTurnResponse } from "@delegate/domain";
import type { ModelPort, RespondInput } from "@delegate/ports";
import {
  BehaviorTestHarness,
  ContextAwareModel,
  defaultBuildInfo,
} from "./test-harness";

describe("session behaviors", () => {
  test("bot remembers prior conversation within a topic", async () => {
    const callHistory: RespondInput[] = [];
    const harness = new BehaviorTestHarness({
      modelRespondFn: async (
        input: RespondInput,
      ): Promise<ModelTurnResponse> => {
        callHistory.push(input);
        const contextCount = callHistory.filter(
          (c) => c.chatId === input.chatId,
        ).length;
        return {
          mode: "chat_reply",
          confidence: 1,
          replyText: `context:${contextCount}`,
          sessionId: input.sessionId ?? "ses-session-1",
        };
      },
    });
    await harness.start();

    await harness.sendMessage("chat-session-1", "first message", "topic-a");
    await harness.sendMessage("chat-session-1", "second message", "topic-a");

    const replies = harness.getReplies("chat-session-1");
    // First call: model sees 1 message for this chatId
    expect(replies[0]?.text).toBe("context:1");
    // Second call: model sees 2 messages for this chatId (it was resumed with sessionId)
    expect(replies[1]?.text).toBe("context:2");
    // Second call should have had a sessionId (proving session continuity)
    expect(callHistory[1]?.sessionId).not.toBeNull();
  });

  test("separate topics have independent conversations", async () => {
    const callsByThread = new Map<string, number>();
    const harness = new BehaviorTestHarness({
      modelRespondFn: async (
        input: RespondInput,
      ): Promise<ModelTurnResponse> => {
        const threadKey = `${input.chatId}:${input.threadId ?? "root"}`;
        const count = (callsByThread.get(threadKey) ?? 0) + 1;
        callsByThread.set(threadKey, count);
        return {
          mode: "chat_reply",
          confidence: 1,
          replyText: `context:${count}`,
          sessionId: input.sessionId ?? `ses-${threadKey}`,
        };
      },
    });
    await harness.start();

    await harness.sendMessage("chat-session-2", "msg in topic A", "topic-a");
    await harness.sendMessage("chat-session-2", "msg in topic B", "topic-b");

    const replies = harness.getReplies("chat-session-2");
    // Each topic sees only 1 message (independent contexts)
    expect(replies[0]?.text).toBe("context:1");
    expect(replies[1]?.text).toBe("context:1");
  });

  test("workspace change preserves conversation history", async () => {
    const tmpDir1 = mkdtempSync(join(tmpdir(), "delegate-ws-hist-a-"));
    const tmpDir2 = mkdtempSync(join(tmpdir(), "delegate-ws-hist-b-"));
    const callHistory: RespondInput[] = [];
    const harness = new BehaviorTestHarness({
      modelRespondFn: async (
        input: RespondInput,
      ): Promise<ModelTurnResponse> => {
        callHistory.push(input);
        return {
          mode: "chat_reply",
          confidence: 1,
          replyText: `reply:${callHistory.length}`,
          sessionId: input.sessionId ?? "ses-ws-hist",
        };
      },
    });
    await harness.start();

    // Send first message in default workspace
    await harness.sendMessage("chat-ws-hist", "msg in workspace 1", "topic-ws");

    // Switch workspace
    await harness.sendMessage(
      "chat-ws-hist",
      `/workspace ${tmpDir2}`,
      "topic-ws",
    );

    // Send message in new workspace -- should still have the same session
    await harness.sendMessage("chat-ws-hist", "msg in workspace 2", "topic-ws");

    // The third model call should have a sessionId (proving session continuity despite workspace change)
    const modelCalls = callHistory.filter((c) => c.chatId === "chat-ws-hist");
    expect(modelCalls.length).toBe(2); // Only 2 model calls (the /workspace is a slash command, not relayed)
    expect(modelCalls[1]?.sessionId).toBe("ses-ws-hist"); // Session preserved across workspace switch

    await rm(tmpDir1, { recursive: true, force: true });
    await rm(tmpDir2, { recursive: true, force: true });
  });

  test("conversation survives worker restart", async () => {
    const callHistory: RespondInput[] = [];
    const modelFn = async (input: RespondInput): Promise<ModelTurnResponse> => {
      callHistory.push(input);
      return {
        mode: "chat_reply",
        confidence: 1,
        replyText: `reply:${callHistory.length}`,
        sessionId: input.sessionId ?? "ses-persist-1",
      };
    };

    // First "run": send a message, session gets persisted
    const harness1 = new BehaviorTestHarness({ modelRespondFn: modelFn });
    await harness1.start();
    await harness1.sendMessage(
      "chat-persist",
      "first message",
      "topic-persist",
    );

    // Verify first call had no session (fresh)
    expect(callHistory[0]?.sessionId).toBeNull();
    expect(callHistory.length).toBe(1);

    // Simulate restart: create a fresh WorkerContext (as a real restart would),
    // but reuse the same SQLite-backed sessionStore (as production does).
    const freshCtx = new WorkerContext();

    await handleChatMessage(
      freshCtx,
      {
        chatPort: harness1.chatPort,
        modelPort: new ContextAwareModel(modelFn),
        sessionStore: harness1.sessionStore,
      },
      {
        chatId: "chat-persist",
        threadId: "topic-persist",
        text: "second message after restart",
        receivedAt: new Date().toISOString(),
      },
      {
        defaultWorkspacePath: harness1.defaultWorkspacePath,
        buildInfo: defaultBuildInfo,
      },
    );

    // Second call should have the session ID restored from SQLite
    expect(callHistory.length).toBe(2);
    expect(callHistory[1]?.sessionId).toBe("ses-persist-1");
  });

  test("idle eviction calls resetSession on the model adapter", async () => {
    const resetCalls: string[] = [];
    const callHistory: RespondInput[] = [];

    const model: ModelPort = {
      async respond(input: RespondInput): Promise<ModelTurnResponse> {
        callHistory.push(input);
        return {
          mode: "chat_reply",
          confidence: 1,
          replyText: `echo:${input.text}`,
          sessionId: input.sessionId ?? "ses-evict-test",
        };
      },
      async resetSession(sessionKey: string): Promise<void> {
        resetCalls.push(sessionKey);
      },
    };

    const harness = new BehaviorTestHarness({ modelPort: model });
    await harness.start();

    // Establish a session on topic-a
    await harness.sendMessage("chat-evict", "hello", "topic-a");
    expect(callHistory.length).toBe(1);
    expect(callHistory[0]?.sessionId).toBeNull(); // fresh session

    // Backdate the session so it appears idle
    const entry = harness.ctx.sessionByKey.get("chat-evict:topic-a");
    expect(entry).toBeDefined();
    entry!.lastUsedAt = Date.now() - 60_000; // 60s ago

    // Send a message on a different topic. evictIdleSessions runs at the
    // start of handleChatMessage and should evict the stale topic-a session.
    await handleChatMessage(
      harness.ctx,
      {
        chatPort: harness.chatPort,
        modelPort: model,
        sessionStore: harness.sessionStore,
      },
      {
        chatId: "chat-evict",
        threadId: "topic-b",
        text: "trigger eviction",
        receivedAt: new Date().toISOString(),
      },
      {
        defaultWorkspacePath: harness.defaultWorkspacePath,
        buildInfo: defaultBuildInfo,
        sessionIdleTimeoutMs: 30_000, // 30s — the backdated session (60s ago) qualifies
      },
    );

    // resetSession should have been called for the evicted topic-a session
    expect(resetCalls.length).toBeGreaterThanOrEqual(1);
    expect(resetCalls).toContain("chat-evict:topic-a");
  });
});
