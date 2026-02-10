import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTelegramWorker } from "@assistant-core/src/worker";
import { SqliteSessionStore } from "@delegate/adapters-session-store-sqlite";
import {
  defaultBuildInfo,
  MockChatPort,
  PerChatDelayModel,
  waitUntil,
} from "./test-harness";

describe("concurrency behaviors", () => {
  test("messages from different topics are processed concurrently", async () => {
    const chatPort = new MockChatPort();
    const model = new PerChatDelayModel({ "chat-c1": 200, "chat-c2": 0 });
    const tmpDir = mkdtempSync(join(tmpdir(), "delegate-conc-"));
    const sessionStore = new SqliteSessionStore(join(tmpDir, "test.db"));
    await sessionStore.init();

    chatPort.injectUpdate({
      chatId: "chat-c1",
      text: "slow message",
      receivedAt: new Date().toISOString(),
    });
    chatPort.injectUpdate({
      chatId: "chat-c2",
      text: "fast message",
      receivedAt: new Date().toISOString(),
    });

    const controller = new AbortController();
    const workerPromise = startTelegramWorker(
      { chatPort, modelPort: model, sessionStore },
      10,
      {
        stopSignal: controller.signal,
        defaultWorkspacePath: tmpDir,
        buildInfo: defaultBuildInfo,
      },
    );

    await waitUntil(
      () =>
        chatPort.getReplies("chat-c1").length > 0 &&
        chatPort.getReplies("chat-c2").length > 0,
      3000,
    );

    const c1Reply = chatPort.getReplies("chat-c1").at(-1)!;
    const c2Reply = chatPort.getReplies("chat-c2").at(-1)!;

    // If processed concurrently, c2 (0ms delay) should finish before c1 (200ms delay)
    expect(c2Reply.capturedAt).toBeLessThan(c1Reply.capturedAt);

    controller.abort();
    await workerPromise;
  });

  test("messages within the same topic are processed in order", async () => {
    const chatPort = new MockChatPort();
    const model = new PerChatDelayModel({}, 0);
    const tmpDir = mkdtempSync(join(tmpdir(), "delegate-conc-"));
    const sessionStore = new SqliteSessionStore(join(tmpDir, "test.db"));
    await sessionStore.init();

    chatPort.injectUpdate({
      chatId: "chat-c3",
      threadId: "thread-1",
      text: "msg-1",
      receivedAt: new Date().toISOString(),
    });
    chatPort.injectUpdate({
      chatId: "chat-c3",
      threadId: "thread-1",
      text: "msg-2",
      receivedAt: new Date().toISOString(),
    });

    const controller = new AbortController();
    const workerPromise = startTelegramWorker(
      { chatPort, modelPort: model, sessionStore },
      10,
      {
        stopSignal: controller.signal,
        defaultWorkspacePath: tmpDir,
        buildInfo: defaultBuildInfo,
      },
    );

    await waitUntil(() => chatPort.getReplies("chat-c3").length >= 2, 3000);

    const replies = chatPort.getReplies("chat-c3");
    expect(replies[0]!.capturedAt).toBeLessThanOrEqual(replies[1]!.capturedAt);

    controller.abort();
    await workerPromise;
  });

  test("slash commands are not blocked by slow model responses", async () => {
    const chatPort = new MockChatPort();
    const model = new PerChatDelayModel({ "chat-c4": 500 });
    const tmpDir = mkdtempSync(join(tmpdir(), "delegate-conc-"));
    const sessionStore = new SqliteSessionStore(join(tmpDir, "test.db"));
    await sessionStore.init();

    chatPort.injectUpdate({
      chatId: "chat-c4",
      text: "slow model message",
      receivedAt: new Date().toISOString(),
    });
    chatPort.injectUpdate({
      chatId: "chat-c5",
      text: "/version",
      receivedAt: new Date().toISOString(),
    });

    const controller = new AbortController();
    const workerPromise = startTelegramWorker(
      { chatPort, modelPort: model, sessionStore },
      10,
      {
        stopSignal: controller.signal,
        defaultWorkspacePath: tmpDir,
        buildInfo: defaultBuildInfo,
      },
    );

    await waitUntil(() => chatPort.getReplies("chat-c5").length > 0, 2000);

    const c5Reply = chatPort.getReplies("chat-c5").at(-1)!;

    // Wait for c4 to also complete
    await waitUntil(() => chatPort.getReplies("chat-c4").length > 0, 3000);
    const c4Reply = chatPort.getReplies("chat-c4").at(-1)!;

    // /version should respond before the slow model finishes
    expect(c5Reply.capturedAt).toBeLessThan(c4Reply.capturedAt);

    controller.abort();
    await workerPromise;
  });

  test("concurrency limit is respected", async () => {
    const chatPort = new MockChatPort();
    const model = new PerChatDelayModel({
      "chat-c6": 200,
      "chat-c7": 200,
      "chat-c8": 200,
    });
    const tmpDir = mkdtempSync(join(tmpdir(), "delegate-conc-"));
    const sessionStore = new SqliteSessionStore(join(tmpDir, "test.db"));
    await sessionStore.init();

    chatPort.injectUpdate({
      chatId: "chat-c6",
      text: "message 1",
      receivedAt: new Date().toISOString(),
    });
    chatPort.injectUpdate({
      chatId: "chat-c7",
      text: "message 2",
      receivedAt: new Date().toISOString(),
    });
    chatPort.injectUpdate({
      chatId: "chat-c8",
      text: "message 3",
      receivedAt: new Date().toISOString(),
    });

    const controller = new AbortController();
    const workerPromise = startTelegramWorker(
      { chatPort, modelPort: model, sessionStore },
      10,
      {
        stopSignal: controller.signal,
        defaultWorkspacePath: tmpDir,
        buildInfo: defaultBuildInfo,
        maxConcurrentTopics: 2,
      },
    );

    await waitUntil(
      () =>
        chatPort.getReplies("chat-c6").length > 0 &&
        chatPort.getReplies("chat-c7").length > 0 &&
        chatPort.getReplies("chat-c8").length > 0,
      3000,
    );

    // Check that at most 2 model calls were active simultaneously
    const log = model.callLog;
    let maxConcurrent = 0;
    for (const entry of log) {
      let concurrent = 0;
      for (const other of log) {
        // Two calls overlap if one started before the other finished
        if (
          other.startedAt < entry.finishedAt &&
          other.finishedAt > entry.startedAt
        ) {
          concurrent++;
        }
      }
      maxConcurrent = Math.max(maxConcurrent, concurrent);
    }

    expect(maxConcurrent).toBeLessThanOrEqual(2);

    controller.abort();
    await workerPromise;
  });
});
