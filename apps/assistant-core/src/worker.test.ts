import { describe, expect, test } from "bun:test";

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

import { handleChatMessage } from "./worker";

class CapturingChatPort implements ChatPort {
  readonly sent: OutboundMessage[] = [];

  async receiveUpdates(_cursor: number | null): Promise<ChatUpdate[]> {
    return [];
  }

  async send(message: OutboundMessage): Promise<void> {
    this.sent.push(message);
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
    );

    expect(chatPort.sent[0]?.text).toBe("echo:hello");
    const persisted = await store.getSession("chat-1:42");
    expect(persisted?.opencodeSessionId).toBe("ses-123");
  });

  test("retries once with fresh session when resumed session fails", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    await store.upsertSession({
      sessionKey: "chat-1:root",
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
      { sessionRetryAttempts: 1 },
    );

    expect(calls).toBe(2);
    expect(chatPort.sent[0]?.text).toBe("fresh-session-ok");
    const persisted = await store.getSession("chat-1:root");
    expect(persisted?.opencodeSessionId).toBe("ses-new");
    expect(store.staleMarks).toContain("chat-1:root");
  });

  test("times out a hung resumed session without staling mapping", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    await store.upsertSession({
      sessionKey: "chat-timeout-retry:root",
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
      { sessionRetryAttempts: 1, relayTimeoutMs: 20 },
    );

    expect(chatPort.sent[0]?.text).toContain("I couldn't reach OpenCode");
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
      { sessionRetryAttempts: 1, relayTimeoutMs: 20 },
    );

    expect(chatPort.sent[0]?.text).toContain("I couldn't reach OpenCode");
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
      },
    );

    expect(chatPort.sent.length).toBe(2);
    expect(chatPort.sent[0]?.text).toContain("Still working");
    expect(chatPort.sent[1]?.text).toBe("done");
  });
});
