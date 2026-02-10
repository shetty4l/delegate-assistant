import { nowIso } from "@assistant-core/src/logging";
import type { WorkerContext } from "@assistant-core/src/worker-context";
import type { WorkerDeps } from "@assistant-core/src/worker-types";
import type { InboundMessage } from "@delegate/domain";

export const buildTopicKey = (message: InboundMessage): string =>
  `${message.chatId}:${message.threadId ?? "root"}`;

const rememberWorkspace = (
  ctx: WorkerContext,
  topicKey: string,
  workspacePath: string,
): void => {
  const known = ctx.workspaceHistory.get(topicKey) ?? new Set<string>();
  known.add(workspacePath);
  ctx.workspaceHistory.set(topicKey, known);
};

export const setActiveWorkspace = (
  ctx: WorkerContext,
  topicKey: string,
  workspacePath: string,
): void => {
  ctx.activeWorkspace.set(topicKey, workspacePath);
  rememberWorkspace(ctx, topicKey, workspacePath);
};

export const loadActiveWorkspace = async (
  ctx: WorkerContext,
  deps: WorkerDeps,
  topicKey: string,
  defaultWorkspacePath: string,
): Promise<string> => {
  const inMemory = ctx.activeWorkspace.get(topicKey);
  if (inMemory) {
    rememberWorkspace(ctx, topicKey, inMemory);
    return inMemory;
  }

  const fromStore = deps.sessionStore?.getTopicWorkspace
    ? await deps.sessionStore.getTopicWorkspace(topicKey)
    : null;
  const resolved = fromStore ?? defaultWorkspacePath;
  ctx.activeWorkspace.set(topicKey, resolved);
  rememberWorkspace(ctx, topicKey, resolved);
  if (deps.sessionStore?.touchTopicWorkspace) {
    await deps.sessionStore.touchTopicWorkspace(topicKey, resolved, nowIso());
  }
  return resolved;
};
