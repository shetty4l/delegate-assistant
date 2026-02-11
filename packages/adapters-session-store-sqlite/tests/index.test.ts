import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeSessionKeyId,
  encodeSessionKeyId,
  SqliteSessionStore,
} from "@delegate/adapters-session-store-sqlite";

const buildStore = async (): Promise<{
  store: SqliteSessionStore;
  cleanup: () => Promise<void>;
}> => {
  const dir = await mkdtemp(join(tmpdir(), "delegate-session-store-"));
  const dbPath = join(dir, "assistant.db");
  const store = new SqliteSessionStore(dbPath);
  await store.init();
  return {
    store,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};

describe("SqliteSessionStore admin queries", () => {
  test("lists sessions by recency with filters", async () => {
    const { store, cleanup } = await buildStore();

    try {
      await store.upsertSession({
        sessionKey: JSON.stringify(["chat-a:root", "/repo/a"]),
        sessionId: "ses-a",
        status: "active",
        lastUsedAt: "2026-02-08T01:00:00.000Z",
      });
      await store.upsertSession({
        sessionKey: JSON.stringify(["chat-b:42", "/repo/b"]),
        sessionId: "ses-b",
        status: "stale",
        lastUsedAt: "2026-02-08T02:00:00.000Z",
      });

      const all = await store.listSessions({ page: 1, pageSize: 25 });
      expect(all.total).toBe(2);
      expect(all.items[0]?.sessionId).toBe("ses-b");
      expect(all.items[1]?.sessionId).toBe("ses-a");

      const activeOnly = await store.listSessions({ status: "active" });
      expect(activeOnly.total).toBe(1);
      expect(activeOnly.items[0]?.topicKey).toBe("chat-a:root");

      const searched = await store.listSessions({ q: "/repo/b" });
      expect(searched.total).toBe(1);
      expect(searched.items[0]?.sessionId).toBe("ses-b");
    } finally {
      await cleanup();
    }
  });

  test("resolves detail row by encoded id", async () => {
    const { store, cleanup } = await buildStore();

    try {
      const sessionKey = JSON.stringify(["chat-c:root", "/repo/c"]);
      await store.upsertSession({
        sessionKey,
        sessionId: "ses-c",
        status: "active",
        lastUsedAt: "2026-02-08T03:00:00.000Z",
      });

      const id = encodeSessionKeyId(sessionKey);
      const decoded = decodeSessionKeyId(id);
      expect(decoded).toBe(sessionKey);

      const row = await store.getSessionById(id);
      expect(row?.sessionKey).toBe(sessionKey);
      expect(row?.workspacePath).toBe("/repo/c");
    } finally {
      await cleanup();
    }
  });
});

describe("SqliteSessionStore turn events", () => {
  const sessionKey = JSON.stringify(["chat-t:root", "/repo/t"]);

  test("inserts and retrieves events by turnId", async () => {
    const { store, cleanup } = await buildStore();

    try {
      await store.insertTurnEvent({
        turnId: "turn-1",
        sessionKey,
        eventType: "turn_started",
        timestamp: "2026-02-11T01:00:00.000Z",
        data: { inputText: "hello" },
      });
      await store.insertTurnEvent({
        turnId: "turn-1",
        sessionKey,
        eventType: "tool_call",
        timestamp: "2026-02-11T01:00:01.000Z",
        data: { toolName: "execute_shell", args: { command: "ls" } },
      });
      await store.insertTurnEvent({
        turnId: "turn-1",
        sessionKey,
        eventType: "turn_completed",
        timestamp: "2026-02-11T01:00:02.000Z",
        data: { totalCost: 0.05 },
      });

      const events = await store.getTurnEvents("turn-1");
      expect(events).toHaveLength(3);
      expect(events[0]?.eventType).toBe("turn_started");
      expect(events[0]?.data).toEqual({ inputText: "hello" });
      expect(events[1]?.eventType).toBe("tool_call");
      expect(events[1]?.data).toEqual({
        toolName: "execute_shell",
        args: { command: "ls" },
      });
      expect(events[2]?.eventType).toBe("turn_completed");

      // Different turnId returns empty
      const empty = await store.getTurnEvents("turn-nonexistent");
      expect(empty).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("lists all events for a session key", async () => {
    const { store, cleanup } = await buildStore();

    try {
      await store.insertTurnEvent({
        turnId: "turn-a",
        sessionKey,
        eventType: "turn_started",
        timestamp: "2026-02-11T01:00:00.000Z",
        data: { inputText: "first" },
      });
      await store.insertTurnEvent({
        turnId: "turn-b",
        sessionKey,
        eventType: "turn_started",
        timestamp: "2026-02-11T02:00:00.000Z",
        data: { inputText: "second" },
      });

      const events = await store.listTurnEvents(sessionKey);
      expect(events).toHaveLength(2);
      expect(events[0]?.turnId).toBe("turn-a");
      expect(events[1]?.turnId).toBe("turn-b");

      // Different session key returns empty
      const other = await store.listTurnEvents(
        JSON.stringify(["other:root", "/other"]),
      );
      expect(other).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("lists turn summaries grouped by turnId", async () => {
    const { store, cleanup } = await buildStore();

    try {
      // Turn 1: complete with cost
      await store.insertTurnEvent({
        turnId: "turn-1",
        sessionKey,
        eventType: "turn_started",
        timestamp: "2026-02-11T01:00:00.000Z",
        data: { inputText: "hello" },
      });
      await store.insertTurnEvent({
        turnId: "turn-1",
        sessionKey,
        eventType: "tool_call",
        timestamp: "2026-02-11T01:00:01.000Z",
        data: { toolName: "shell" },
      });
      await store.insertTurnEvent({
        turnId: "turn-1",
        sessionKey,
        eventType: "turn_completed",
        timestamp: "2026-02-11T01:00:05.000Z",
        data: { totalCost: 0.12 },
      });

      // Turn 2: failed
      await store.insertTurnEvent({
        turnId: "turn-2",
        sessionKey,
        eventType: "turn_started",
        timestamp: "2026-02-11T02:00:00.000Z",
        data: { inputText: "do something" },
      });
      await store.insertTurnEvent({
        turnId: "turn-2",
        sessionKey,
        eventType: "turn_failed",
        timestamp: "2026-02-11T02:00:03.000Z",
        data: { error: "timeout" },
      });

      const turns = await store.listTurns(sessionKey);
      expect(turns).toHaveLength(2);

      // Most recent first
      expect(turns[0]?.turnId).toBe("turn-2");
      expect(turns[0]?.eventCount).toBe(2);
      expect(turns[0]?.inputPreview).toBe("do something");
      expect(turns[0]?.lastEventType).toBe("turn_failed");

      expect(turns[1]?.turnId).toBe("turn-1");
      expect(turns[1]?.eventCount).toBe(3);
      expect(turns[1]?.inputPreview).toBe("hello");
      expect(turns[1]?.totalCost).toBe(0.12);
      expect(turns[1]?.lastEventType).toBe("turn_completed");
    } finally {
      await cleanup();
    }
  });

  test("stores unbounded data without truncation", async () => {
    const { store, cleanup } = await buildStore();

    try {
      const largePayload = "x".repeat(100_000);
      await store.insertTurnEvent({
        turnId: "turn-large",
        sessionKey,
        eventType: "tool_result",
        timestamp: "2026-02-11T01:00:00.000Z",
        data: { result: largePayload },
      });

      const events = await store.getTurnEvents("turn-large");
      expect(events).toHaveLength(1);
      expect((events[0]?.data as { result: string }).result).toHaveLength(
        100_000,
      );
    } finally {
      await cleanup();
    }
  });
});
