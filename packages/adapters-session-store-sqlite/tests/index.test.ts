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
