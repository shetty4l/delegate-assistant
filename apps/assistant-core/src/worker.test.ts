import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { flushPendingStartupAck, handleChatMessage } from "./worker";

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

const runGit = (cwd: string, args: string[]): void => {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    const stdout = new TextDecoder().decode(proc.stdout).trim();
    throw new Error(stderr || stdout || `git ${args.join(" ")} failed`);
  }
};

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

  test("handles /sync with explicit path deterministically on successful git sync", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    const baseDir = await mkdtemp(join(tmpdir(), "delegate-sync-"));
    const remoteRepo = join(baseDir, "remote.git");
    const localRepo = join(baseDir, "local");
    runGit(baseDir, ["init", "--bare", remoteRepo]);
    runGit(baseDir, ["clone", remoteRepo, localRepo]);
    runGit(localRepo, ["config", "user.email", "test@example.com"]);
    runGit(localRepo, ["config", "user.name", "Test User"]);
    await writeFile(join(localRepo, "README.md"), "hello\n", "utf8");
    runGit(localRepo, ["add", "README.md"]);
    runGit(localRepo, ["commit", "-m", "init"]);
    runGit(localRepo, ["branch", "-M", "main"]);
    runGit(localRepo, ["push", "-u", "origin", "main"]);

    let modelCalls = 0;
    const model = new ScriptedModel(async (input) => {
      modelCalls += 1;
      return {
        mode: "chat_reply",
        confidence: 1,
        replyText: `fallback:${input.text}`,
        sessionId: "ses-sync",
      };
    });

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound(`/sync ${localRepo}`, null, "chat-sync"),
      { defaultWorkspacePath: defaultWorkspace },
    );

    expect(modelCalls).toBe(0);
    expect(chatPort.sent[0]?.text).toContain("Rebased onto `origin/main`");
    expect(chatPort.sent[0]?.text).toContain(
      "Branch status: ## main...origin/main",
    );

    await rm(baseDir, { recursive: true, force: true });
  });

  test("returns error for /sync when path does not exist", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    let modelCalls = 0;
    const model = new ScriptedModel(async () => {
      modelCalls += 1;
      return {
        mode: "chat_reply",
        confidence: 1,
        replyText: "should-not-be-called",
        sessionId: "ses-sync-fallback",
      };
    });

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound("/sync /nonexistent/path", null, "chat-sync-invalid"),
      { defaultWorkspacePath: defaultWorkspace },
    );

    expect(modelCalls).toBe(0);
    expect(chatPort.sent[0]?.text).toContain("Directory not found");
  });

  test("returns error for /sync when not in a git repo", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    let modelCalls = 0;
    const model = new ScriptedModel(async () => {
      modelCalls += 1;
      return {
        mode: "chat_reply",
        confidence: 1,
        replyText: "should-not-be-called",
        sessionId: "ses-sync-fallback",
      };
    });

    const nonRepoWorkspace = await mkdtemp(
      join(tmpdir(), "delegate-not-repo-"),
    );

    await handleChatMessage(
      { chatPort, modelPort: model, sessionStore: store },
      inbound(`/sync ${nonRepoWorkspace}`, null, "chat-sync-not-git"),
      { defaultWorkspacePath: defaultWorkspace },
    );

    expect(modelCalls).toBe(0);
    expect(chatPort.sent[0]?.text).toContain("Sync failed");

    await rm(nonRepoWorkspace, { recursive: true, force: true });
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

  test("handles /restart as deterministic control intent", async () => {
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
      inbound("/restart", null, "chat-restart-slash"),
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
    expect(store.pendingStartupAck?.chatId).toBe("chat-restart-slash");
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

  test("handles /version as deterministic control intent", async () => {
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
      inbound("/version", null, "chat-version-slash"),
      {
        defaultWorkspacePath: defaultWorkspace,
        buildInfo: buildInfoFixture,
      },
    );

    expect(modelCalls).toBe(0);
    expect(chatPort.sent[0]?.text).toContain("0.1.0+abc1234");
    expect(chatPort.sent[0]?.text).toContain("branch main");
  });

  test("does not delegate unknown slash command to model", async () => {
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
      inbound("/unknown", null, "chat-unknown-slash"),
      {
        defaultWorkspacePath: defaultWorkspace,
      },
    );

    expect(modelCalls).toBe(0);
    expect(chatPort.sent[0]?.text).toContain("Unknown slash command");
  });

  test("keeps separate sessions per workspace in one topic", async () => {
    const chatPort = new CapturingChatPort();
    const store = new MemorySessionStore();
    const baseDir = await mkdtemp(join(tmpdir(), "delegate-worker-"));
    const repoA = join(baseDir, "repo-a");
    await mkdir(repoA, { recursive: true });

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
      return {
        mode: "chat_reply",
        confidence: 1,
        replyText: `resume:${input.sessionId ?? "none"}`,
        sessionId: input.sessionId ?? "missing",
      };
    });

    // Set up workspace directly via store
    await store.setTopicWorkspace(
      "chat-multi:root",
      repoA,
      new Date().toISOString(),
    );

    const deps = { chatPort, modelPort: model, sessionStore: store };
    const opts = { defaultWorkspacePath: repoA };

    await handleChatMessage(
      deps,
      inbound("first in a", "42", "chat-multi"),
      opts,
    );
    await handleChatMessage(
      deps,
      inbound("second in a", "42", "chat-multi"),
      opts,
    );

    expect(seenInputs.length).toBe(2);
    expect(seenInputs[0]?.workspacePath).toBe(repoA);
    expect(seenInputs[0]?.sessionId).toBeNull();
    expect(seenInputs[1]?.workspacePath).toBe(repoA);
    expect(seenInputs[1]?.sessionId).toBe("ses-a");

    await rm(baseDir, { recursive: true, force: true });
  });
});
