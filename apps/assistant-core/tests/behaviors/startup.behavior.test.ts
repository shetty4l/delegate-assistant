import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTelegramWorker } from "@assistant-core/src/worker";
import { SqliteSessionStore } from "@delegate/adapters-session-store-sqlite";
import {
  ContextAwareModel,
  defaultBuildInfo,
  MockChatPort,
  waitUntil,
} from "./test-harness";

describe("startup announcement", () => {
  test("sends version announcement when startupAnnounceChatId is configured", async () => {
    const chatPort = new MockChatPort();
    const model = new ContextAwareModel();
    const tmpDir = mkdtempSync(join(tmpdir(), "delegate-startup-"));
    const sessionStore = new SqliteSessionStore(join(tmpDir, "test.db"));
    await sessionStore.init();

    const controller = new AbortController();
    const workerPromise = startTelegramWorker(
      { chatPort, modelPort: model, sessionStore },
      50,
      {
        stopSignal: controller.signal,
        defaultWorkspacePath: tmpDir,
        buildInfo: defaultBuildInfo,
        startupAnnounceChatId: "announce-chat",
        startupAnnounceThreadId: "42",
      },
    );

    await waitUntil(() => chatPort.getAllReplies().length > 0, 3000);

    const announcement = chatPort.getAllReplies()[0]!;
    expect(announcement.chatId).toBe("announce-chat");
    expect(announcement.threadId).toBe("42");
    expect(announcement.text).toContain("v0.1.0");
    expect(announcement.text).toContain("is online");

    controller.abort();
    await workerPromise;
  });

  test("does not send announcement when startupAnnounceChatId is null", async () => {
    const chatPort = new MockChatPort();
    const model = new ContextAwareModel();
    const tmpDir = mkdtempSync(join(tmpdir(), "delegate-startup-"));
    const sessionStore = new SqliteSessionStore(join(tmpDir, "test.db"));
    await sessionStore.init();

    // Inject a message so we know the worker has started processing
    chatPort.injectUpdate({
      chatId: "chat-1",
      text: "hello",
      receivedAt: new Date().toISOString(),
    });

    const controller = new AbortController();
    const workerPromise = startTelegramWorker(
      { chatPort, modelPort: model, sessionStore },
      50,
      {
        stopSignal: controller.signal,
        defaultWorkspacePath: tmpDir,
        buildInfo: defaultBuildInfo,
        startupAnnounceChatId: null,
      },
    );

    await waitUntil(() => chatPort.getReplies("chat-1").length > 0, 3000);

    // No announcement messages -- only the reply to "hello"
    const allReplies = chatPort.getAllReplies();
    const announcements = allReplies.filter((r) =>
      r.text.includes("is online"),
    );
    expect(announcements).toHaveLength(0);

    controller.abort();
    await workerPromise;
  });

  test("worker continues when announcement send fails", async () => {
    const chatPort = new MockChatPort();
    const originalSend = chatPort.send.bind(chatPort);
    let firstCall = true;
    chatPort.send = async (message) => {
      if (firstCall) {
        firstCall = false;
        throw new Error("Telegram API unavailable");
      }
      return originalSend(message);
    };

    const model = new ContextAwareModel();
    const tmpDir = mkdtempSync(join(tmpdir(), "delegate-startup-"));
    const sessionStore = new SqliteSessionStore(join(tmpDir, "test.db"));
    await sessionStore.init();

    chatPort.injectUpdate({
      chatId: "chat-1",
      text: "hello after failure",
      receivedAt: new Date().toISOString(),
    });

    const controller = new AbortController();
    const workerPromise = startTelegramWorker(
      { chatPort, modelPort: model, sessionStore },
      50,
      {
        stopSignal: controller.signal,
        defaultWorkspacePath: tmpDir,
        buildInfo: defaultBuildInfo,
        startupAnnounceChatId: "announce-chat",
      },
    );

    // Worker should still process messages despite announcement failure
    await waitUntil(() => chatPort.getReplies("chat-1").length > 0, 3000);

    expect(chatPort.getReplies("chat-1").length).toBeGreaterThan(0);

    controller.abort();
    await workerPromise;
  });
});
