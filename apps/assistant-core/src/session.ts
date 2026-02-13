import type { WorkerContext } from "@assistant-core/src/worker-context";
import type { WorkerDeps } from "@assistant-core/src/worker-types";

const upsertSessionInMemory = (
  ctx: WorkerContext,
  sessionKey: string,
  sessionId: string,
  touchedAtMs: number,
): void => {
  ctx.sessionByKey.set(sessionKey, {
    sessionId,
    lastUsedAt: touchedAtMs,
  });
};

export const evictIdleSessions = async (
  ctx: WorkerContext,
  deps: WorkerDeps,
  idleTimeoutMs: number,
  maxConcurrent: number,
): Promise<void> => {
  const now = Date.now();

  for (const [sessionKey, state] of ctx.sessionByKey.entries()) {
    if (now - state.lastUsedAt <= idleTimeoutMs) {
      continue;
    }
    ctx.sessionByKey.delete(sessionKey);
    if (deps.sessionStore) {
      await deps.sessionStore.markStale(
        sessionKey,
        new Date(now).toISOString(),
      );
    }
  }

  if (ctx.sessionByKey.size <= maxConcurrent) {
    return;
  }

  const ordered = [...ctx.sessionByKey.entries()].sort(
    (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
  );
  while (ctx.sessionByKey.size > maxConcurrent && ordered.length > 0) {
    const evicted = ordered.shift();
    if (!evicted) {
      break;
    }
    ctx.sessionByKey.delete(evicted[0]);
    if (deps.sessionStore) {
      await deps.sessionStore.markStale(
        evicted[0],
        new Date(now).toISOString(),
      );
    }
  }
};

export const loadSessionId = async (
  ctx: WorkerContext,
  deps: WorkerDeps,
  sessionKey: string,
): Promise<string | null> => {
  const inMemory = ctx.sessionByKey.get(sessionKey);
  if (inMemory) {
    inMemory.lastUsedAt = Date.now();
    return inMemory.sessionId;
  }

  if (!deps.sessionStore) {
    return null;
  }

  const persisted = await deps.sessionStore.getSession(sessionKey);
  if (!persisted || persisted.status === "stale") {
    return null;
  }

  upsertSessionInMemory(ctx, sessionKey, persisted.sessionId, Date.now());
  return persisted.sessionId;
};

export const persistSessionId = async (
  ctx: WorkerContext,
  deps: WorkerDeps,
  sessionKey: string,
  sessionId: string,
): Promise<void> => {
  const now = Date.now();
  upsertSessionInMemory(ctx, sessionKey, sessionId, now);

  if (!deps.sessionStore) {
    return;
  }

  await deps.sessionStore.upsertSession({
    sessionKey,
    sessionId: sessionId,
    lastUsedAt: new Date(now).toISOString(),
    status: "active",
  });
};
