import type { Semaphore } from "@assistant-core/src/concurrency";
import type { BuildInfo } from "@assistant-core/src/version";
import type { ChatPort, ModelPort } from "@delegate/ports";

export type SessionStoreLike = {
  getSession(sessionKey: string): Promise<{
    sessionId: string;
    lastUsedAt: string;
  } | null>;
  upsertSession(mapping: {
    sessionKey: string;
    sessionId: string;
    lastUsedAt: string;
    status: "active" | "stale";
  }): Promise<void>;
  markStale(sessionKey: string, updatedAt: string): Promise<void>;
  getCursor(): Promise<number | null>;
  setCursor(cursor: number): Promise<void>;
  getTopicWorkspace?(topicKey: string): Promise<string | null>;
  setTopicWorkspace?(
    topicKey: string,
    workspacePath: string,
    updatedAt: string,
  ): Promise<void>;
  listTopicWorkspaces?(topicKey: string): Promise<string[]>;
  touchTopicWorkspace?(
    topicKey: string,
    workspacePath: string,
    updatedAt: string,
  ): Promise<void>;
  getPendingStartupAck?(): Promise<{
    chatId: string;
    threadId: string | null;
    requestedAt: string;
    attemptCount: number;
    lastError: string | null;
  } | null>;
  upsertPendingStartupAck?(entry: {
    chatId: string;
    threadId: string | null;
    requestedAt: string;
    attemptCount: number;
    lastError: string | null;
  }): Promise<void>;
  clearPendingStartupAck?(): Promise<void>;
};

export type WorkerDeps = {
  chatPort: ChatPort;
  modelPort: ModelPort;
  sessionStore?: SessionStoreLike;
};

export type WorkerOptions = {
  sessionIdleTimeoutMs?: number;
  sessionMaxConcurrent?: number;
  sessionRetryAttempts?: number;
  relayTimeoutMs?: number;
  progressFirstMs?: number;
  progressEveryMs?: number;
  progressMaxCount?: number;
  defaultWorkspacePath?: string;
  stopSignal?: AbortSignal;
  buildInfo?: BuildInfo;
  maxConcurrentTopics?: number;
  concurrencySemaphore?: Semaphore;
  onRestartRequested?: (input: {
    chatId: string;
    threadId: string | null;
  }) => Promise<void> | void;
  startupAnnounceChatId?: string | null;
  startupAnnounceThreadId?: string | null;
};

export type LogFields = Record<string, string | number | boolean | null>;

export type RelayErrorClass =
  | "session_invalid"
  | "tool_call_error"
  | "timeout"
  | "empty_output"
  | "transport"
  | "model_error"
  | "model_transient";
