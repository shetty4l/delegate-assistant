import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  InboundMessage,
  ModelTurnResponse,
  OutboundMessage,
} from "@delegate/domain";
import type {
  ChatPort,
  ChatUpdate,
  ModelPort,
  RespondInput,
} from "@delegate/ports";
import type { BuildInfo } from "./version";
import {
  flushDueScheduledMessages,
  flushPendingStartupAck,
  handleChatMessage,
  startTelegramWorker,
} from "./worker";

class CapturingChatPort implements ChatPort {
  readonly sent: OutboundMessage[] = [];

  async receiveUpdates(_cursor: number | null): Promise<ChatUpdate[]> {
    return [];
  }

  async send(message: OutboundMessage): Promise<void> {
    this.sent.push(message);
  }
}

class FailingChatPort extends CapturingChatPort {
  async send(_message: OutboundMessage): Promise<void> {
    throw new Error("send failed");
  }
}

class Thread400ThenSuccessChatPort extends CapturingChatPort {
  override async send(message: OutboundMessage): Promise<void> {
    if (message.threadId) {
      throw new Error("Telegram sendMessage failed: 400");
    }
    this.sent.push(message);
  }
}

class LoopingChatPort extends CapturingChatPort {
  constructor(private readonly onReceive: (calls: number) => void) {
    super();
  }

  private receiveCalls = 0;

  override async receiveUpdates(_cursor: number | null): Promise<ChatUpdate[]> {
    this.receiveCalls += 1;
    this.onReceive(this.receiveCalls);
    return [];
  }
}

class ScriptedModel implements ModelPort {
  constructor(
    private readonly respondFn: (
      input: RespondInput,
    ) => Promise<ModelTurnResponse>,
  ) {}

  async respond(input: RespondInput): Promise<ModelTurnResponse> {
    return this.respondFn(input);
  }
}

class MemorySessionStore {
  private readonly sessions = new Map<
    string,
    { opencodeSessionId: string; lastUsedAt: string }
  >();
  readonly staleMarks: string[] = [];
  readonly topicWorkspace = new Map<string, string>();
  readonly workspaceHistory = new Map<string, Set<string>>();
  pendingStartupAck: {
    chatId: string;
    threadId: string | null;
    requestedAt: string;
    attemptCount: number;
    lastError: string | null;
  } | null = null;
  scheduledMessages: Array<{
    id: number;
    chatId: string;
    threadId: string | null;
    text: string;
    sendAt: string;
    createdAt: string;
    deliveredAt: string | null;
    lastError: string | null;
    attemptCount: number;
    nextAttemptAt: string | null;
    status: "pending" | "sent";
  }> = [];
  pendingDeliveryAcks = new Map<
    number,
    {
      id: number;
      chatId: string;
      deliveredAt: string;
      nextAttemptAt: string;
    }
  >();
  private nextScheduledId = 1;

  async getSession(sessionKey: string) {
    return this.sessions.get(sessionKey) ?? null;
  }

  async upsertSession(mapping: {
    sessionKey: string;
    opencodeSessionId: string;
    lastUsedAt: string;
    status: "active" | "stale";
  }) {
    this.sessions.set(mapping.sessionKey, {
      opencodeSessionId: mapping.opencodeSessionId,
      lastUsedAt: mapping.lastUsedAt,
    });
  }

  async markStale(sessionKey: string, _updatedAt: string) {
    this.staleMarks.push(sessionKey);
  }
  async getCursor(): Promise<number | null> {
    return null;
  }
  async setCursor(_cursor: number): Promise<void> {}

  async getTopicWorkspace(topicKey: string): Promise<string | null> {
    return this.topicWorkspace.get(topicKey) ?? null;
  }

  async setTopicWorkspace(
    topicKey: string,
    workspacePath: string,
    _updatedAt: string,
  ): Promise<void> {
    this.topicWorkspace.set(topicKey, workspacePath);
    const known = this.workspaceHistory.get(topicKey) ?? new Set<string>();
    known.add(workspacePath);
    this.workspaceHistory.set(topicKey, known);
  }

  async touchTopicWorkspace(
    topicKey: string,
    workspacePath: string,
    _updatedAt: string,
  ): Promise<void> {
    const known = this.workspaceHistory.get(topicKey) ?? new Set<string>();
    known.add(workspacePath);
    this.workspaceHistory.set(topicKey, known);
  }

  async listTopicWorkspaces(topicKey: string): Promise<string[]> {
    return [...(this.workspaceHistory.get(topicKey) ?? new Set<string>())];
  }

  async getPendingStartupAck() {
    return this.pendingStartupAck;
  }

  async upsertPendingStartupAck(entry: {
    chatId: string;
    threadId: string | null;
    requestedAt: string;
    attemptCount: number;
    lastError: string | null;
  }) {
    this.pendingStartupAck = entry;
  }

  async clearPendingStartupAck() {
    this.pendingStartupAck = null;
  }

  async enqueueScheduledMessage(entry: {
    chatId: string;
    threadId: string | null;
    text: string;
    sendAt: string;
    createdAt: string;
  }): Promise<number> {
    const id = this.nextScheduledId;
    this.nextScheduledId += 1;
    this.scheduledMessages.push({
      id,
      ...entry,
      deliveredAt: null,
      lastError: null,
      attemptCount: 0,
      nextAttemptAt: null,
      status: "pending",
    });
    return id;
  }

  async listDueScheduledMessages(input: { nowIso: string; limit: number }) {
    return this.scheduledMessages
      .filter(
        (item) =>
          item.status === "pending" &&
          item.sendAt <= input.nowIso &&
          (item.nextAttemptAt === null || item.nextAttemptAt <= input.nowIso),
      )
      .sort((a, b) => a.sendAt.localeCompare(b.sendAt) || a.id - b.id)
      .slice(0, input.limit)
      .map((item) => ({
        id: item.id,
        chatId: item.chatId,
        threadId: item.threadId,
        text: item.text,
        sendAt: item.sendAt,
        attemptCount: item.attemptCount,
      }));
  }

  async markScheduledMessageDelivered(input: {
    id: number;
    deliveredAt: string;
  }) {
    const message = this.scheduledMessages.find((item) => item.id === input.id);
    if (!message) {
      return;
    }
    message.status = "sent";
    message.deliveredAt = input.deliveredAt;
    message.lastError = null;
    message.nextAttemptAt = null;
  }

  async markScheduledMessageFailed(input: {
    id: number;
    error: string;
    nextAttemptAt: string;
  }) {
    const message = this.scheduledMessages.find((item) => item.id === input.id);
    if (!message) {
      return;
    }
    message.lastError = input.error;
    message.attemptCount += 1;
    message.nextAttemptAt = input.nextAttemptAt;
  }

  async upsertPendingScheduledDeliveryAck(entry: {
    id: number;
    chatId: string;
    deliveredAt: string;
    nextAttemptAt: string;
  }) {
    this.pendingDeliveryAcks.set(entry.id, {
      id: entry.id,
      chatId: entry.chatId,
      deliveredAt: entry.deliveredAt,
      nextAttemptAt: entry.nextAttemptAt,
    });
  }

  async listPendingScheduledDeliveryAcks(limit: number) {
    return [...this.pendingDeliveryAcks.values()]
      .sort(
        (a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt) || a.id - b.id,
      )
      .slice(0, limit)
      .map((entry) => ({ ...entry }));
  }

  async clearPendingScheduledDeliveryAck(id: number) {
    this.pendingDeliveryAcks.delete(id);
  }
}

const inbound = (
  text: string,
  threadId: string | null = null,
  chatId = "chat-1",
): InboundMessage => ({
  chatId,
  threadId,
  text,
  receivedAt: new Date().toISOString(),
});

const defaultWorkspace = process.cwd();

const buildInfoFixture: BuildInfo = {
  service: "delegate-assistant",
  releaseVersion: "0.1.0",
  displayVersion: "0.1.0+abc1234",
  gitSha: "abc1234def567890",
  gitShortSha: "abc1234",
  gitBranch: "main",
  commitTitle: "add supervisor-managed graceful restart flow",
  buildTimeUtc: "2026-02-08T00:00:00.000Z",
  runtime: {
    bunVersion: "1.3.8",
    nodeCompat: "22.0.0",
  },
};

const scopedSessionKey = (
  chatId: string,
  threadId: string | null,
  workspacePath = defaultWorkspace,
): string => JSON.stringify([`${chatId}:${threadId ?? "root"}`, workspacePath]);

describe("telegram opencode relay", () => {
  test("handles /start only as first message", async () => {
    const chatPort = new CapturingChatPort();
    const model = new ScriptedModel(async () => ({
      mode: "chat_reply",
      confidence: 1,
      replyText: "unused",
      sessionId: "ses-a",
    }));

    await handleChatMessage({ chatPort, modelPort: model }, inbound("/start"));
    await handleChatMessage({ chatPort, modelPort: model }, inbound("/start"));

    expect(chatPort.sent.length).toBe(1);
    expect(chatPort.sent[0]?.text).toContain("ready");
  });

  test("relays message and persists returned session id", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    const model = new ScriptedModel(async (input) => ({
      mode: "chat_reply",
      confidence: 1,
      replyText: `echo:${input.text}`,
      sessionId: "ses-123",
    }));

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound("hello", "42"),
      { defaultWorkspacePath: defaultWorkspace },
    );

    expect(chatPort.sent[0]?.text).toBe("echo:hello");
    const persisted = await store.getSession(
      scopedSessionKey("chat-1", "42", defaultWorkspace),
    );
    expect(persisted?.opencodeSessionId).toBe("ses-123");
  });

  test("expands /sync-main slash command into common workflow prompt", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    let receivedText = "";
    const model = new ScriptedModel(async (input) => {
      receivedText = input.text;
      return {
        mode: "chat_reply",
        confidence: 1,
        replyText: "done",
        sessionId: "ses-sync",
      };
    });

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound("/sync-main", null, "chat-sync-main"),
      { defaultWorkspacePath: defaultWorkspace },
    );

    expect(receivedText).toBe(
      "Merged. Go back to main, rebase from origin and confirm.",
    );
    expect(chatPort.sent[0]?.text).toBe("done");
  });

  test("retries once with fresh session when resumed session fails", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    await store.upsertSession({
      sessionKey: scopedSessionKey("chat-1", null, defaultWorkspace),
      opencodeSessionId: "ses-old",
      lastUsedAt: new Date().toISOString(),
      status: "active",
    });

    let calls = 0;
    const model = new ScriptedModel(async (input) => {
      calls += 1;
      if (input.sessionId === "ses-old") {
        throw new Error("stale session");
      }
      return {
        mode: "chat_reply",
        confidence: 1,
        replyText: "fresh-session-ok",
        sessionId: "ses-new",
      };
    });

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound("continue"),
      { sessionRetryAttempts: 1, defaultWorkspacePath: defaultWorkspace },
    );

    expect(calls).toBe(2);
    expect(chatPort.sent[0]?.text).toBe("fresh-session-ok");
    const persisted = await store.getSession(
      scopedSessionKey("chat-1", null, defaultWorkspace),
    );
    expect(persisted?.opencodeSessionId).toBe("ses-new");
    expect(store.staleMarks).toContain(
      scopedSessionKey("chat-1", null, defaultWorkspace),
    );
  });

  test("times out a hung resumed session without staling mapping", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    await store.upsertSession({
      sessionKey: scopedSessionKey(
        "chat-timeout-retry",
        null,
        defaultWorkspace,
      ),
      opencodeSessionId: "ses-hung",
      lastUsedAt: new Date().toISOString(),
      status: "active",
    });

    const model = new ScriptedModel(async (input) => {
      if (input.sessionId === "ses-hung") {
        return await new Promise<ModelTurnResponse>(() => {});
      }
      return {
        mode: "chat_reply",
        confidence: 1,
        replyText: "should-not-be-used",
        sessionId: "ses-new",
      };
    });

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound("hello", null, "chat-timeout-retry"),
      {
        sessionRetryAttempts: 1,
        relayTimeoutMs: 20,
        defaultWorkspacePath: defaultWorkspace,
      },
    );

    expect(chatPort.sent[0]?.text).toContain("did not finish within");
    expect(store.staleMarks).toEqual([]);
  });

  test("sends fallback message after timeout and failed retry", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();

    const model = new ScriptedModel(async () => {
      return await new Promise<ModelTurnResponse>(() => {});
    });

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound("hello", null, "chat-timeout-fail"),
      {
        sessionRetryAttempts: 1,
        relayTimeoutMs: 20,
        defaultWorkspacePath: defaultWorkspace,
      },
    );

    expect(chatPort.sent[0]?.text).toContain("did not finish within");
  });

  test("retries delivery without thread on telegram 400", async () => {
    const chatPort = new Thread400ThenSuccessChatPort();
    const store = new MemorySessionStore();
    const model = new ScriptedModel(async () => ({
      mode: "chat_reply",
      confidence: 1,
      replyText: "ok",
      sessionId: "ses-1",
    }));

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound("hello", "129", "chat-telegram-400"),
      { defaultWorkspacePath: defaultWorkspace },
    );

    expect(chatPort.sent).toHaveLength(1);
    expect(chatPort.sent[0]?.threadId).toBeUndefined();
    expect(chatPort.sent[0]?.text).toBe("ok");
  });

  test("sends progress updates for long-running turns", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    const model = new ScriptedModel(
      async () =>
        await new Promise<ModelTurnResponse>((resolve) => {
          setTimeout(() => {
            resolve({
              mode: "chat_reply",
              confidence: 1,
              replyText: "done",
              sessionId: "ses-long",
            });
          }, 30);
        }),
    );

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound("analyze this", null, "chat-progress"),
      {
        relayTimeoutMs: 200,
        progressFirstMs: 5,
        progressEveryMs: 100,
        progressMaxCount: 1,
        defaultWorkspacePath: defaultWorkspace,
      },
    );

    expect(chatPort.sent.length).toBe(2);
    expect(chatPort.sent[0]?.text).toContain("Still working");
    expect(chatPort.sent[1]?.text).toBe("done");
  });

  test("handles restart as deterministic control intent", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    let modelCalls = 0;
    let restartRequested = 0;
    const model = new ScriptedModel(async () => {
      modelCalls += 1;
      return {
        mode: "chat_reply",
        confidence: 1,
        replyText: "unused",
        sessionId: "ses-any",
      };
    });

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound("restart assistant", null, "chat-restart"),
      {
        defaultWorkspacePath: defaultWorkspace,
        onRestartRequested: async () => {
          restartRequested += 1;
        },
      },
    );

    expect(modelCalls).toBe(0);
    expect(restartRequested).toBe(1);
    expect(chatPort.sent[0]?.text).toContain("restarting");
    expect(store.pendingStartupAck).not.toBeNull();
    expect(store.pendingStartupAck?.chatId).toBe("chat-restart");
  });

  test("flushes pending startup ack and clears marker", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    await store.upsertPendingStartupAck({
      chatId: "chat-restart",
      threadId: "42",
      requestedAt: "2026-02-08T00:00:00.000Z",
      attemptCount: 0,
      lastError: null,
    });

    await flushPendingStartupAck({
      chatPort,
      modelPort: new ScriptedModel(async () => ({ replyText: "unused" })),
      sessionStore: store,
    });

    expect(chatPort.sent).toHaveLength(1);
    expect(chatPort.sent[0]?.chatId).toBe("chat-restart");
    expect(chatPort.sent[0]?.threadId).toBe("42");
    expect(chatPort.sent[0]?.text).toContain("Restart complete");
    expect(store.pendingStartupAck).toBeNull();
  });

  test("retains pending startup ack when send fails", async () => {
    const chatPort = new FailingChatPort();
    const store = new MemorySessionStore();
    await store.upsertPendingStartupAck({
      chatId: "chat-restart",
      threadId: null,
      requestedAt: "2026-02-08T00:00:00.000Z",
      attemptCount: 1,
      lastError: null,
    });

    await flushPendingStartupAck({
      chatPort,
      modelPort: new ScriptedModel(async () => ({ replyText: "unused" })),
      sessionStore: store,
    });

    expect(store.pendingStartupAck).not.toBeNull();
    expect(store.pendingStartupAck?.attemptCount).toBe(2);
    expect(store.pendingStartupAck?.lastError).toContain("send failed");
  });

  test("handles version as deterministic control intent", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    let modelCalls = 0;
    const model = new ScriptedModel(async () => {
      modelCalls += 1;
      return {
        mode: "chat_reply",
        confidence: 1,
        replyText: "unused",
        sessionId: "ses-any",
      };
    });

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound("version", null, "chat-version"),
      {
        defaultWorkspacePath: defaultWorkspace,
        buildInfo: buildInfoFixture,
      },
    );

    expect(modelCalls).toBe(0);
    expect(chatPort.sent[0]?.text).toContain("0.1.0+abc1234");
    expect(chatPort.sent[0]?.text).toContain("branch main");
    expect(chatPort.sent[0]?.text).toContain(
      "add supervisor-managed graceful restart flow",
    );
  });

  test("handles workspace switching intents deterministically", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    const baseDir = await mkdtemp(join(tmpdir(), "delegate-worker-"));
    const repoA = join(baseDir, "repo-a");

    await mkdir(repoA, { recursive: true });

    const model = new ScriptedModel(async () => ({
      mode: "chat_reply",
      confidence: 1,
      replyText: "unused",
      sessionId: "ses-any",
    }));

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound(`use repo ${repoA}`, null, "chat-workspace"),
      { defaultWorkspacePath: baseDir },
    );

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound("where am i", null, "chat-workspace"),
      { defaultWorkspacePath: baseDir },
    );

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound("list repos", null, "chat-workspace"),
      { defaultWorkspacePath: baseDir },
    );

    expect(chatPort.sent[0]?.text).toContain("Workspace switched");
    expect(chatPort.sent[1]?.text).toContain(repoA);
    expect(chatPort.sent[2]?.text).toContain(repoA);

    await rm(baseDir, { recursive: true, force: true });
  });

  test("queues a reminder from natural language schedule text", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    let modelCalls = 0;
    const sendAt = new Date(Date.now() + 60_000).toISOString();
    const model = new ScriptedModel(async () => {
      modelCalls += 1;
      return {
        mode: "chat_reply",
        confidence: 1,
        replyText: sendAt,
        sessionId: "ses-any",
      };
    });

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound("remind me at tomorrow 7pm to Watch Eternity on Apple TV+"),
      { defaultWorkspacePath: defaultWorkspace },
    );

    expect(modelCalls).toBe(1);
    expect(store.scheduledMessages).toHaveLength(1);
    expect(store.scheduledMessages[0]?.text).toBe(
      "Watch Eternity on Apple TV+",
    );
    expect(chatPort.sent[0]?.text).toContain("Scheduled reminder");
  });

  test("falls back to in-memory reminders when schedule store is partial", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    const partialStore = store as MemorySessionStore;
    const partialStoreMutable = partialStore as unknown as Record<
      string,
      unknown
    >;
    partialStoreMutable.listDueScheduledMessages = undefined;
    partialStoreMutable.markScheduledMessageDelivered = undefined;
    partialStoreMutable.markScheduledMessageFailed = undefined;

    const sendAt = new Date(Date.now() + 60_000).toISOString();
    const sendAtDate = new Date(sendAt);

    await handleChatMessage(
      {
        chatPort,
        modelPort: new ScriptedModel(async () => ({ replyText: "unused" })),
        sessionStore: partialStore,
      },
      inbound(`remind me on ${sendAt} to Partial store reminder`),
      { defaultWorkspacePath: defaultWorkspace },
    );

    expect(store.scheduledMessages).toHaveLength(0);
    expect(chatPort.sent[0]?.text).toContain("in memory and will be lost");

    await flushDueScheduledMessages(
      {
        chatPort,
        modelPort: new ScriptedModel(async () => ({ replyText: "unused" })),
        sessionStore: partialStore,
      },
      new Date(sendAtDate.getTime() + 1_000),
    );

    expect(chatPort.sent).toHaveLength(2);
    expect(chatPort.sent[1]?.text).toBe("Partial store reminder");
  });

  test("delivers due scheduled reminders", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    const scheduledAt = "2026-02-13T19:00:00.000Z";
    const messageId = await store.enqueueScheduledMessage({
      chatId: "chat-reminder",
      threadId: "42",
      text: "Watch Eternity on Apple TV+",
      sendAt: scheduledAt,
      createdAt: "2026-02-08T00:00:00.000Z",
    });

    await flushDueScheduledMessages(
      {
        chatPort,
        modelPort: new ScriptedModel(async () => ({ replyText: "unused" })),
        sessionStore: store,
      },
      new Date("2026-02-13T19:01:00.000Z"),
    );

    expect(chatPort.sent).toHaveLength(1);
    expect(chatPort.sent[0]?.chatId).toBe("chat-reminder");
    expect(chatPort.sent[0]?.threadId).toBe("42");
    expect(chatPort.sent[0]?.text).toBe("Watch Eternity on Apple TV+");

    const delivered = store.scheduledMessages.find(
      (item) => item.id === messageId,
    );
    expect(delivered?.status).toBe("sent");
    expect(delivered?.deliveredAt).toBe("2026-02-13T19:01:00.000Z");
  });

  test("delivers root reminders without inheriting latest thread id", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    const deps = {
      chatPort,
      modelPort: new ScriptedModel(async () => ({ replyText: "unused" })),
      sessionStore: store,
    };

    await handleChatMessage(
      deps,
      inbound("where am i", "42", "chat-reminder-root"),
      { defaultWorkspacePath: defaultWorkspace },
    );

    const messageId = await store.enqueueScheduledMessage({
      chatId: "chat-reminder-root",
      threadId: null,
      text: "Root reminder",
      sendAt: "2000-01-01T00:00:00.000Z",
      createdAt: "2026-02-08T00:00:00.000Z",
    });

    await flushDueScheduledMessages(deps, new Date("2026-02-13T19:01:00.000Z"));

    expect(chatPort.sent).toHaveLength(2);
    expect(chatPort.sent[0]?.threadId).toBe("42");
    expect(chatPort.sent[1]?.chatId).toBe("chat-reminder-root");
    expect(chatPort.sent[1]?.threadId).toBeUndefined();

    const delivered = store.scheduledMessages.find(
      (item) => item.id === messageId,
    );
    expect(delivered?.status).toBe("sent");
  });

  test("does not resend reminders across restart when delivery state persistence fails", async () => {
    class FlakyDeliveredMarkStore extends MemorySessionStore {
      markDeliveredCalls = 0;
      markFailedCalls = 0;

      override async markScheduledMessageDelivered(input: {
        id: number;
        deliveredAt: string;
      }) {
        this.markDeliveredCalls += 1;
        if (this.markDeliveredCalls === 1) {
          throw new Error("database busy");
        }
        await super.markScheduledMessageDelivered(input);
      }

      override async markScheduledMessageFailed(input: {
        id: number;
        error: string;
        nextAttemptAt: string;
      }) {
        this.markFailedCalls += 1;
        await super.markScheduledMessageFailed(input);
      }
    }

    const chatPort = new CapturingChatPort();
    const store = new FlakyDeliveredMarkStore();
    const deps = {
      chatPort,
      modelPort: new ScriptedModel(async () => ({ replyText: "unused" })),
      sessionStore: store,
    };
    const messageId = await store.enqueueScheduledMessage({
      chatId: "chat-reminder-mark-fail",
      threadId: null,
      text: "No duplicate reminder",
      sendAt: "2000-01-01T00:00:00.000Z",
      createdAt: "2026-02-08T00:00:00.000Z",
    });

    await flushDueScheduledMessages(deps, new Date("2026-02-13T19:01:00.000Z"));

    expect(chatPort.sent).toHaveLength(1);
    expect(store.markDeliveredCalls).toBe(1);
    expect(store.markFailedCalls).toBe(0);
    const pending = store.scheduledMessages.find(
      (item) => item.id === messageId,
    );
    expect(pending?.status).toBe("pending");
    expect(pending?.attemptCount).toBe(0);
    expect(store.pendingDeliveryAcks.size).toBe(1);

    await flushDueScheduledMessages(deps, new Date("2026-02-13T19:01:01.000Z"));

    expect(chatPort.sent).toHaveLength(1);
    expect(store.markDeliveredCalls).toBe(1);

    const restartedChatPort = new CapturingChatPort();
    const restartedDeps = {
      chatPort: restartedChatPort,
      modelPort: new ScriptedModel(async () => ({ replyText: "unused" })),
      sessionStore: store,
    };

    await flushDueScheduledMessages(
      restartedDeps,
      new Date("2026-02-13T19:02:01.000Z"),
    );

    expect(chatPort.sent).toHaveLength(1);
    expect(restartedChatPort.sent).toHaveLength(0);
    expect(store.markDeliveredCalls).toBe(2);
    expect(store.pendingDeliveryAcks.size).toBe(0);
    const delivered = store.scheduledMessages.find(
      (item) => item.id === messageId,
    );
    expect(delivered?.status).toBe("sent");
    expect(delivered?.attemptCount).toBe(0);
  });

  test("delivers reminders that become due after worker starts", async () => {
    class DueOnSecondSweepStore extends MemorySessionStore {
      sweeps = 0;

      override async listDueScheduledMessages(input: {
        nowIso: string;
        limit: number;
      }) {
        this.sweeps += 1;
        if (this.sweeps === 1) {
          return [];
        }
        return super.listDueScheduledMessages(input);
      }
    }

    const controller = new AbortController();
    const chatPort = new LoopingChatPort((calls) => {
      if (calls >= 2) {
        controller.abort();
      }
    });
    const store = new DueOnSecondSweepStore();
    const messageId = await store.enqueueScheduledMessage({
      chatId: "chat-reminder-late",
      threadId: null,
      text: "Late reminder",
      sendAt: "2000-01-01T00:00:00.000Z",
      createdAt: "2026-02-08T00:00:00.000Z",
    });

    await startTelegramWorker(
      {
        chatPort,
        modelPort: new ScriptedModel(async () => ({ replyText: "unused" })),
        sessionStore: store,
      },
      1,
      { stopSignal: controller.signal },
    );

    expect(store.sweeps).toBeGreaterThanOrEqual(2);
    expect(chatPort.sent).toHaveLength(1);
    expect(chatPort.sent[0]?.chatId).toBe("chat-reminder-late");
    expect(chatPort.sent[0]?.text).toBe("Late reminder");

    const delivered = store.scheduledMessages.find(
      (item) => item.id === messageId,
    );
    expect(delivered?.status).toBe("sent");
  });

  test("keeps separate sessions per workspace in one topic", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    const baseDir = await mkdtemp(join(tmpdir(), "delegate-worker-"));
    const repoA = join(baseDir, "repo-a");
    const repoB = join(baseDir, "repo-b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });

    const seenInputs: RespondInput[] = [];
    const model = new ScriptedModel(async (input) => {
      seenInputs.push(input);
      if (input.workspacePath === repoA && !input.sessionId) {
        return {
          mode: "chat_reply",
          confidence: 1,
          replyText: "a-first",
          sessionId: "ses-a",
        };
      }
      if (input.workspacePath === repoB && !input.sessionId) {
        return {
          mode: "chat_reply",
          confidence: 1,
          replyText: "b-first",
          sessionId: "ses-b",
        };
      }
      return {
        mode: "chat_reply",
        confidence: 1,
        replyText: `resume:${input.sessionId ?? "none"}`,
        sessionId: input.sessionId ?? "missing",
      };
    });

    const deps = { chatPort, modelPort: model, sessionStore: store };
    const opts = { defaultWorkspacePath: baseDir };

    await handleChatMessage(
      deps,
      inbound(`use repo ${repoA}`, "42", "chat-multi"),
      opts,
    );
    await handleChatMessage(
      deps,
      inbound("first in a", "42", "chat-multi"),
      opts,
    );
    await handleChatMessage(
      deps,
      inbound(`use repo ${repoB}`, "42", "chat-multi"),
      opts,
    );
    await handleChatMessage(
      deps,
      inbound("first in b", "42", "chat-multi"),
      opts,
    );
    await handleChatMessage(
      deps,
      inbound(`use repo ${repoA}`, "42", "chat-multi"),
      opts,
    );
    await handleChatMessage(
      deps,
      inbound("second in a", "42", "chat-multi"),
      opts,
    );

    expect(seenInputs.length).toBe(3);
    expect(seenInputs[0]?.workspacePath).toBe(repoA);
    expect(seenInputs[0]?.sessionId).toBeNull();
    expect(seenInputs[1]?.workspacePath).toBe(repoB);
    expect(seenInputs[1]?.sessionId).toBeNull();
    expect(seenInputs[2]?.workspacePath).toBe(repoA);
    expect(seenInputs[2]?.sessionId).toBe("ses-a");

    await rm(baseDir, { recursive: true, force: true });
  });
});
