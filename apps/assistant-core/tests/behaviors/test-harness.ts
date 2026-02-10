import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildInfo } from "@assistant-core/src/version";
import {
  handleChatMessage,
  startTelegramWorker,
  WorkerContext,
} from "@assistant-core/src/worker";
import { SqliteSessionStore } from "@delegate/adapters-session-store-sqlite";
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

// --- Types ---

export type CapturedReply = {
  chatId: string;
  threadId?: string | null;
  text: string;
  capturedAt: number;
};

export type ModelRespondFn = (
  input: RespondInput,
) => Promise<ModelTurnResponse>;

// --- Mock ChatPort ---

export class MockChatPort implements ChatPort {
  readonly replies: CapturedReply[] = [];
  private pendingUpdates: ChatUpdate[] = [];
  private nextUpdateId = 1;

  async receiveUpdates(_cursor: number | null): Promise<ChatUpdate[]> {
    const updates = this.pendingUpdates.splice(0);
    return updates;
  }

  async send(message: OutboundMessage): Promise<void> {
    this.replies.push({
      chatId: message.chatId,
      threadId: message.threadId,
      text: message.text,
      capturedAt: Date.now(),
    });
  }

  injectUpdate(message: InboundMessage): void {
    const updateId = this.nextUpdateId;
    this.nextUpdateId += 1;
    this.pendingUpdates.push({ updateId, message });
  }

  getReplies(chatId: string): CapturedReply[] {
    return this.replies.filter((r) => r.chatId === chatId);
  }

  getAllReplies(): CapturedReply[] {
    return [...this.replies];
  }

  clearReplies(): void {
    this.replies.length = 0;
  }
}

// --- Context-Aware Scripted Model ---

export class ContextAwareModel implements ModelPort {
  private readonly respondFn: ModelRespondFn;

  constructor(respondFn?: ModelRespondFn) {
    this.respondFn =
      respondFn ??
      (async (input: RespondInput): Promise<ModelTurnResponse> => ({
        mode: "chat_reply",
        confidence: 1,
        replyText: `echo:${input.text}`,
        sessionId: input.sessionId ?? "test-session",
      }));
  }

  async respond(input: RespondInput): Promise<ModelTurnResponse> {
    return this.respondFn(input);
  }
}

// --- Delayed Model (for progress/timeout tests) ---

export class DelayedModel implements ModelPort {
  constructor(
    private readonly delayMs: number,
    private readonly response?: ModelTurnResponse,
  ) {}

  async respond(_input: RespondInput): Promise<ModelTurnResponse> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return (
      this.response ?? {
        mode: "chat_reply",
        confidence: 1,
        replyText: "delayed-response",
        sessionId: "delayed-session",
      }
    );
  }
}

// --- Never-Resolving Model (for timeout tests) ---

export class NeverResolvingModel implements ModelPort {
  async respond(_input: RespondInput): Promise<ModelTurnResponse> {
    return new Promise<ModelTurnResponse>(() => {});
  }
}

// --- Failing Model (for error tests) ---

export class FailingModel implements ModelPort {
  constructor(private readonly errorMessage: string = "model error") {}

  async respond(_input: RespondInput): Promise<ModelTurnResponse> {
    throw new Error(this.errorMessage);
  }
}

// --- Helpers ---

export const waitUntil = async (
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 10,
): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

// --- PerChatDelayModel (for concurrency tests) ---

export class PerChatDelayModel implements ModelPort {
  private readonly delays: Map<string, number>;
  private readonly defaultDelayMs: number;
  readonly callLog: Array<{
    chatId: string;
    startedAt: number;
    finishedAt: number;
  }> = [];

  constructor(delays: Record<string, number>, defaultDelayMs = 0) {
    this.delays = new Map(Object.entries(delays));
    this.defaultDelayMs = defaultDelayMs;
  }

  async respond(input: RespondInput): Promise<ModelTurnResponse> {
    const delayMs = this.delays.get(input.chatId) ?? this.defaultDelayMs;
    const startedAt = Date.now();
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const finishedAt = Date.now();
    this.callLog.push({ chatId: input.chatId, startedAt, finishedAt });
    return {
      mode: "chat_reply",
      confidence: 1,
      replyText: `reply:${input.chatId}`,
      sessionId: `ses-${input.chatId}`,
    };
  }
}

// --- Harness ---

export type HarnessOptions = {
  modelRespondFn?: ModelRespondFn;
  modelPort?: ModelPort;
  defaultWorkspacePath?: string;
  relayTimeoutMs?: number;
  progressFirstMs?: number;
  progressEveryMs?: number;
  progressMaxCount?: number;
  sessionRetryAttempts?: number;
  buildInfo?: BuildInfo;
};

export const defaultBuildInfo: BuildInfo = {
  service: "delegate-assistant",
  releaseVersion: "0.1.0",
  displayVersion: "0.1.0+abc1234",
  gitSha: "abc1234def567890",
  gitShortSha: "abc1234",
  gitBranch: "main",
  commitTitle: "test build",
  buildTimeUtc: "2026-02-08T00:00:00.000Z",
  runtime: {
    bunVersion: "1.3.8",
    nodeCompat: "22.0.0",
  },
};

export class BehaviorTestHarness {
  readonly chatPort: MockChatPort;
  readonly modelPort: ModelPort;
  readonly sessionStore: SqliteSessionStore;
  readonly ctx: WorkerContext;
  readonly defaultWorkspacePath: string;
  private readonly tmpDir: string;
  private readonly options: HarnessOptions;

  constructor(options: HarnessOptions = {}) {
    this.options = options;
    this.chatPort = new MockChatPort();
    this.modelPort =
      options.modelPort ?? new ContextAwareModel(options.modelRespondFn);
    this.tmpDir = mkdtempSync(join(tmpdir(), "delegate-behavior-"));
    this.defaultWorkspacePath = options.defaultWorkspacePath ?? this.tmpDir;
    this.sessionStore = new SqliteSessionStore(join(this.tmpDir, "test.db"));
    this.ctx = new WorkerContext();
  }

  async start(): Promise<void> {
    await this.sessionStore.init();
  }

  async sendMessage(
    chatId: string,
    text: string,
    threadId?: string | null,
  ): Promise<void> {
    const message: InboundMessage = {
      chatId,
      threadId: threadId ?? null,
      text,
      receivedAt: new Date().toISOString(),
    };

    await handleChatMessage(
      this.ctx,
      {
        chatPort: this.chatPort,
        modelPort: this.modelPort,
        sessionStore: this.sessionStore,
      },
      message,
      {
        defaultWorkspacePath: this.defaultWorkspacePath,
        relayTimeoutMs: this.options.relayTimeoutMs,
        progressFirstMs: this.options.progressFirstMs,
        progressEveryMs: this.options.progressEveryMs,
        progressMaxCount: this.options.progressMaxCount,
        sessionRetryAttempts: this.options.sessionRetryAttempts,
        buildInfo: this.options.buildInfo ?? defaultBuildInfo,
      },
    );
  }

  getReplies(chatId: string): CapturedReply[] {
    return this.chatPort.getReplies(chatId);
  }

  getAllReplies(): CapturedReply[] {
    return this.chatPort.getAllReplies();
  }

  getLastReply(chatId: string): CapturedReply | undefined {
    const replies = this.getReplies(chatId);
    return replies[replies.length - 1];
  }
}
