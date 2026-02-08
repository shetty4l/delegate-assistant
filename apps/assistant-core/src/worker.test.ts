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
  readonly topicWorkspace = new Map<string, string>();
  readonly workspaceHistory = new Map<string, Set<string>>();

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
      {
        sessionRetryAttempts: 1,
        relayTimeoutMs: 20,
        defaultWorkspacePath: defaultWorkspace,
      },
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
        defaultWorkspacePath: defaultWorkspace,
      },
    );

    expect(chatPort.sent.length).toBe(2);
    expect(chatPort.sent[0]?.text).toContain("Still working");
    expect(chatPort.sent[1]?.text).toBe("done");
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
