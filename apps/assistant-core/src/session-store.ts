import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type SessionMapping = {
  sessionKey: string;
  opencodeSessionId: string;
  lastUsedAt: string;
  status: "active" | "stale";
};

export class SqliteSessionStore {
  private db: Database | null = null;

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath, { create: true, strict: true });
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_mappings (
        session_key TEXT PRIMARY KEY,
        opencode_session_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_state (
        state_key TEXT PRIMARY KEY,
        state_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS topic_workspace_bindings (
        topic_key TEXT PRIMARY KEY,
        active_workspace_path TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS topic_workspace_history (
        topic_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        PRIMARY KEY (topic_key, workspace_path)
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS session_mappings_last_used_idx
      ON session_mappings(last_used_at);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS workspace_history_topic_used_idx
      ON topic_workspace_history(topic_key, last_used_at);
    `);
    this.db = db;
  }

  async ping(): Promise<void> {
    this.ensureDb().query("SELECT 1 as ok").get();
  }

  async getSession(sessionKey: string): Promise<SessionMapping | null> {
    const row = this.ensureDb()
      .query(
        `
          SELECT session_key, opencode_session_id, last_used_at, status
          FROM session_mappings
          WHERE session_key = $session_key
        `,
      )
      .get({ session_key: sessionKey }) as {
      session_key: string;
      opencode_session_id: string;
      last_used_at: string;
      status: string;
    } | null;

    if (!row) {
      return null;
    }

    return {
      sessionKey: row.session_key,
      opencodeSessionId: row.opencode_session_id,
      lastUsedAt: row.last_used_at,
      status: row.status === "active" ? "active" : "stale",
    };
  }

  async upsertSession(mapping: SessionMapping): Promise<void> {
    this.ensureDb()
      .query(
        `
          INSERT INTO session_mappings (session_key, opencode_session_id, last_used_at, status)
          VALUES ($session_key, $opencode_session_id, $last_used_at, $status)
          ON CONFLICT(session_key) DO UPDATE SET
            opencode_session_id = excluded.opencode_session_id,
            last_used_at = excluded.last_used_at,
            status = excluded.status
        `,
      )
      .run({
        session_key: mapping.sessionKey,
        opencode_session_id: mapping.opencodeSessionId,
        last_used_at: mapping.lastUsedAt,
        status: mapping.status,
      });
  }

  async markStale(sessionKey: string, updatedAt: string): Promise<void> {
    this.ensureDb()
      .query(
        `
          UPDATE session_mappings
          SET status = 'stale', last_used_at = $updated_at
          WHERE session_key = $session_key
        `,
      )
      .run({ session_key: sessionKey, updated_at: updatedAt });
  }

  async deleteSession(sessionKey: string): Promise<void> {
    this.ensureDb()
      .query(`DELETE FROM session_mappings WHERE session_key = $session_key`)
      .run({ session_key: sessionKey });
  }

  async getTopicWorkspace(topicKey: string): Promise<string | null> {
    const row = this.ensureDb()
      .query(
        `
          SELECT active_workspace_path
          FROM topic_workspace_bindings
          WHERE topic_key = $topic_key
        `,
      )
      .get({ topic_key: topicKey }) as {
      active_workspace_path: string;
    } | null;

    return row?.active_workspace_path ?? null;
  }

  async setTopicWorkspace(
    topicKey: string,
    workspacePath: string,
    updatedAt: string,
  ): Promise<void> {
    this.ensureDb()
      .query(
        `
          INSERT INTO topic_workspace_bindings (topic_key, active_workspace_path, updated_at)
          VALUES ($topic_key, $active_workspace_path, $updated_at)
          ON CONFLICT(topic_key) DO UPDATE SET
            active_workspace_path = excluded.active_workspace_path,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        topic_key: topicKey,
        active_workspace_path: workspacePath,
        updated_at: updatedAt,
      });

    await this.touchTopicWorkspace(topicKey, workspacePath, updatedAt);
  }

  async touchTopicWorkspace(
    topicKey: string,
    workspacePath: string,
    updatedAt: string,
  ): Promise<void> {
    this.ensureDb()
      .query(
        `
          INSERT INTO topic_workspace_history (topic_key, workspace_path, last_used_at)
          VALUES ($topic_key, $workspace_path, $last_used_at)
          ON CONFLICT(topic_key, workspace_path) DO UPDATE SET
            last_used_at = excluded.last_used_at
        `,
      )
      .run({
        topic_key: topicKey,
        workspace_path: workspacePath,
        last_used_at: updatedAt,
      });
  }

  async listTopicWorkspaces(topicKey: string): Promise<string[]> {
    const rows = this.ensureDb()
      .query(
        `
          SELECT workspace_path
          FROM topic_workspace_history
          WHERE topic_key = $topic_key
          ORDER BY last_used_at DESC
        `,
      )
      .all({ topic_key: topicKey }) as Array<{ workspace_path: string }>;

    return rows.map((row) => row.workspace_path);
  }

  async setCursor(cursor: number): Promise<void> {
    this.ensureDb()
      .query(
        `
          INSERT INTO runtime_state (state_key, state_value, updated_at)
          VALUES ('telegram_cursor', $state_value, $updated_at)
          ON CONFLICT(state_key) DO UPDATE SET
            state_value = excluded.state_value,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        state_value: String(cursor),
        updated_at: new Date().toISOString(),
      });
  }

  async getCursor(): Promise<number | null> {
    const row = this.ensureDb()
      .query(
        `
          SELECT state_value
          FROM runtime_state
          WHERE state_key = 'telegram_cursor'
        `,
      )
      .get() as { state_value: string } | null;

    if (!row) {
      return null;
    }

    const parsed = Number(row.state_value);
    return Number.isInteger(parsed) ? parsed : null;
  }

  private ensureDb(): Database {
    if (!this.db) {
      throw new Error("SqliteSessionStore is not initialized");
    }
    return this.db;
  }
}
