import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TurnEvent, TurnEventType } from "@delegate/domain";

export type SessionMapping = {
  sessionKey: string;
  sessionId: string;
  lastUsedAt: string;
  status: "active" | "stale";
};

export type PendingStartupAck = {
  chatId: string;
  threadId: string | null;
  requestedAt: string;
  attemptCount: number;
  lastError: string | null;
};

export type SessionListFilters = {
  q?: string;
  status?: "active" | "stale";
  topicKey?: string;
  workspacePath?: string;
  page?: number;
  pageSize?: number;
};

export type SessionListItem = SessionMapping & {
  id: string;
  topicKey: string;
  workspacePath: string;
};

export type SessionListPage = {
  items: SessionListItem[];
  page: number;
  pageSize: number;
  total: number;
};

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

type SessionKeyParts = {
  topicKey: string;
  workspacePath: string;
};

const clampInt = (value: number | undefined, fallback: number): number => {
  if (!value || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
};

const normalizePageInput = (
  page: number | undefined,
  pageSize: number | undefined,
): { page: number; pageSize: number } => {
  const normalizedPage = clampInt(page, 1);
  const normalizedPageSize = Math.min(
    clampInt(pageSize, DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
  };
};

export const encodeSessionKeyId = (sessionKey: string): string =>
  Buffer.from(sessionKey, "utf8").toString("base64url");

export const decodeSessionKeyId = (id: string): string | null => {
  const trimmed = id.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const decoded = Buffer.from(trimmed, "base64url").toString("utf8");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
};

export const parseSessionKey = (sessionKey: string): SessionKeyParts | null => {
  // Try JSON array format first (legacy/test format)
  try {
    const parsed = JSON.parse(sessionKey) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2) {
      const topicKey = parsed[0];
      const workspacePath = parsed[1];
      if (typeof topicKey === "string" && typeof workspacePath === "string") {
        return { topicKey, workspacePath };
      }
    }
  } catch {
    // Not JSON — treat as plain topicKey string
  }
  // Plain string format: session_key IS the topicKey
  if (sessionKey.length > 0) {
    return { topicKey: sessionKey, workspacePath: "" };
  }
  return null;
};

const asSessionListItem = (row: {
  session_key: string;
  session_id: string;
  last_used_at: string;
  status: string;
  topic_key: string | null;
  workspace_path: string | null;
}): SessionListItem => {
  const parsed = parseSessionKey(row.session_key);
  const topicKey = row.topic_key ?? parsed?.topicKey ?? "unknown:root";
  const workspacePath =
    row.workspace_path ?? parsed?.workspacePath ?? "unknown";

  return {
    id: encodeSessionKeyId(row.session_key),
    sessionKey: row.session_key,
    sessionId: row.session_id,
    lastUsedAt: row.last_used_at,
    status: row.status === "active" ? "active" : "stale",
    topicKey,
    workspacePath,
  };
};

export class SqliteSessionStore {
  private db: Database | null = null;

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath, { create: true, strict: true });
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec("PRAGMA busy_timeout=5000;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_mappings (
        session_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS turn_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS turn_events_session_ts_idx
      ON turn_events(session_key, timestamp);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS turn_events_turn_id_idx
      ON turn_events(turn_id);
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
           SELECT session_key, session_id, last_used_at, status
          FROM session_mappings
          WHERE session_key = $session_key
        `,
      )
      .get({ session_key: sessionKey }) as {
      session_key: string;
      session_id: string;
      last_used_at: string;
      status: string;
    } | null;

    if (!row) {
      return null;
    }

    return {
      sessionKey: row.session_key,
      sessionId: row.session_id,
      lastUsedAt: row.last_used_at,
      status: row.status === "active" ? "active" : "stale",
    };
  }

  async getSessionById(id: string): Promise<SessionListItem | null> {
    const sessionKey = decodeSessionKeyId(id);
    if (!sessionKey) {
      return null;
    }

    const row = this.ensureDb()
      .query(
        `
          SELECT
            sm.session_key,
            sm.session_id,
            sm.last_used_at,
            sm.status,
            sm.session_key as topic_key,
            twb.active_workspace_path as workspace_path
          FROM session_mappings sm
          LEFT JOIN topic_workspace_bindings twb
            ON twb.topic_key = sm.session_key
          WHERE sm.session_key = $session_key
        `,
      )
      .get({ session_key: sessionKey }) as {
      session_key: string;
      session_id: string;
      last_used_at: string;
      status: string;
      topic_key: string | null;
      workspace_path: string | null;
    } | null;

    if (!row) {
      return null;
    }

    return asSessionListItem(row);
  }

  async listSessions(
    filters: SessionListFilters = {},
  ): Promise<SessionListPage> {
    const { page, pageSize } = normalizePageInput(
      filters.page,
      filters.pageSize,
    );
    const whereParts: string[] = [];
    const params: Record<string, string | number> = {
      limit: pageSize,
      offset: (page - 1) * pageSize,
    };

    if (filters.status) {
      whereParts.push("sm.status = $status");
      params.status = filters.status;
    }

    if (filters.topicKey) {
      whereParts.push("sm.session_key = $topic_key");
      params.topic_key = filters.topicKey;
    }

    if (filters.workspacePath) {
      whereParts.push("twb.active_workspace_path = $workspace_path");
      params.workspace_path = filters.workspacePath;
    }

    if (filters.q) {
      whereParts.push(`
        (
          LOWER(sm.session_key) LIKE $q
          OR LOWER(sm.session_id) LIKE $q
          OR LOWER(COALESCE(twb.active_workspace_path, '')) LIKE $q
        )
      `);
      params.q = `%${filters.q.toLowerCase()}%`;
    }

    const whereClause =
      whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

    const items = this.ensureDb()
      .query(
        `
          SELECT
            sm.session_key,
            sm.session_id,
            sm.last_used_at,
            sm.status,
            sm.session_key as topic_key,
            twb.active_workspace_path as workspace_path
          FROM session_mappings sm
          LEFT JOIN topic_workspace_bindings twb
            ON twb.topic_key = sm.session_key
          ${whereClause}
          ORDER BY sm.last_used_at DESC
          LIMIT $limit OFFSET $offset
        `,
      )
      .all(params) as Array<{
      session_key: string;
      session_id: string;
      last_used_at: string;
      status: string;
      topic_key: string | null;
      workspace_path: string | null;
    }>;

    const total = this.ensureDb()
      .query(
        `
          SELECT COUNT(*) as total
          FROM session_mappings sm
          LEFT JOIN topic_workspace_bindings twb
            ON twb.topic_key = sm.session_key
          ${whereClause}
        `,
      )
      .get(params) as { total: number };

    return {
      items: items.map(asSessionListItem),
      page,
      pageSize,
      total: total.total,
    };
  }

  async upsertSession(mapping: SessionMapping): Promise<void> {
    this.ensureDb()
      .query(
        `
          INSERT INTO session_mappings (session_key, session_id, last_used_at, status)
          VALUES ($session_key, $session_id, $last_used_at, $status)
          ON CONFLICT(session_key) DO UPDATE SET
            session_id = excluded.session_id,
            last_used_at = excluded.last_used_at,
            status = excluded.status
        `,
      )
      .run({
        session_key: mapping.sessionKey,
        session_id: mapping.sessionId,
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

  async insertTurnEvent(event: TurnEvent): Promise<void> {
    this.ensureDb()
      .query(
        `
          INSERT INTO turn_events (turn_id, session_key, event_type, timestamp, data)
          VALUES ($turn_id, $session_key, $event_type, $timestamp, $data)
        `,
      )
      .run({
        turn_id: event.turnId,
        session_key: event.sessionKey,
        event_type: event.eventType,
        timestamp: event.timestamp,
        data: JSON.stringify(event.data),
      });
  }

  async getTurnEvents(turnId: string): Promise<TurnEvent[]> {
    const rows = this.ensureDb()
      .query(
        `
          SELECT turn_id, session_key, event_type, timestamp, data
          FROM turn_events
          WHERE turn_id = $turn_id
          ORDER BY id ASC
        `,
      )
      .all({ turn_id: turnId }) as Array<{
      turn_id: string;
      session_key: string;
      event_type: string;
      timestamp: string;
      data: string;
    }>;

    return rows.map((row) => ({
      turnId: row.turn_id,
      sessionKey: row.session_key,
      eventType: row.event_type as TurnEventType,
      timestamp: row.timestamp,
      data: JSON.parse(row.data) as Record<string, unknown>,
    }));
  }

  async listTurns(sessionKey: string): Promise<
    Array<{
      turnId: string;
      sessionKey: string;
      firstEventType: TurnEventType;
      lastEventType: TurnEventType;
      startedAt: string;
      endedAt: string;
      eventCount: number;
      inputPreview: string | null;
      totalCost: number | null;
    }>
  > {
    const rows = this.ensureDb()
      .query(
        `
          SELECT
            turn_id,
            session_key,
            MIN(timestamp) as started_at,
            MAX(timestamp) as ended_at,
            COUNT(*) as event_count,
            MIN(CASE WHEN id = (SELECT MIN(id) FROM turn_events t2 WHERE t2.turn_id = turn_events.turn_id) THEN event_type END) as first_event_type,
            MAX(CASE WHEN id = (SELECT MAX(id) FROM turn_events t2 WHERE t2.turn_id = turn_events.turn_id) THEN event_type END) as last_event_type,
            MIN(CASE WHEN event_type = 'turn_started' THEN json_extract(data, '$.inputText') END) as input_preview,
            MAX(CASE WHEN event_type IN ('turn_completed', 'turn_failed') THEN json_extract(data, '$.totalCost') END) as total_cost
          FROM turn_events
          WHERE session_key = $session_key
          GROUP BY turn_id
          ORDER BY started_at DESC
        `,
      )
      .all({ session_key: sessionKey }) as Array<{
      turn_id: string;
      session_key: string;
      started_at: string;
      ended_at: string;
      event_count: number;
      first_event_type: string;
      last_event_type: string;
      input_preview: string | null;
      total_cost: number | null;
    }>;

    return rows.map((row) => ({
      turnId: row.turn_id,
      sessionKey: row.session_key,
      firstEventType: row.first_event_type as TurnEventType,
      lastEventType: row.last_event_type as TurnEventType,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      eventCount: row.event_count,
      inputPreview: row.input_preview,
      totalCost: row.total_cost,
    }));
  }

  async listTurnEvents(sessionKey: string): Promise<TurnEvent[]> {
    const rows = this.ensureDb()
      .query(
        `
          SELECT turn_id, session_key, event_type, timestamp, data
          FROM turn_events
          WHERE session_key = $session_key
          ORDER BY id ASC
        `,
      )
      .all({ session_key: sessionKey }) as Array<{
      turn_id: string;
      session_key: string;
      event_type: string;
      timestamp: string;
      data: string;
    }>;

    return rows.map((row) => ({
      turnId: row.turn_id,
      sessionKey: row.session_key,
      eventType: row.event_type as TurnEventType,
      timestamp: row.timestamp,
      data: JSON.parse(row.data) as Record<string, unknown>,
    }));
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

  async getPendingStartupAck(): Promise<PendingStartupAck | null> {
    const row = this.ensureDb()
      .query(
        `
          SELECT state_value
          FROM runtime_state
          WHERE state_key = 'pending_startup_ack'
        `,
      )
      .get() as { state_value: string } | null;

    if (!row) {
      return null;
    }

    try {
      const parsed = JSON.parse(row.state_value) as {
        chatId?: string;
        threadId?: string | null;
        requestedAt?: string;
        attemptCount?: number;
        lastError?: string | null;
      };
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      if (typeof parsed.chatId !== "string" || parsed.chatId.length === 0) {
        return null;
      }

      return {
        chatId: parsed.chatId,
        threadId: typeof parsed.threadId === "string" ? parsed.threadId : null,
        requestedAt:
          typeof parsed.requestedAt === "string"
            ? parsed.requestedAt
            : new Date().toISOString(),
        attemptCount:
          typeof parsed.attemptCount === "number" &&
          Number.isInteger(parsed.attemptCount) &&
          parsed.attemptCount >= 0
            ? parsed.attemptCount
            : 0,
        lastError:
          typeof parsed.lastError === "string" ? parsed.lastError : null,
      };
    } catch {
      return null;
    }
  }

  async upsertPendingStartupAck(entry: PendingStartupAck): Promise<void> {
    this.ensureDb()
      .query(
        `
          INSERT INTO runtime_state (state_key, state_value, updated_at)
          VALUES ('pending_startup_ack', $state_value, $updated_at)
          ON CONFLICT(state_key) DO UPDATE SET
            state_value = excluded.state_value,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        state_value: JSON.stringify(entry),
        updated_at: new Date().toISOString(),
      });
  }

  async clearPendingStartupAck(): Promise<void> {
    this.ensureDb()
      .query(
        `DELETE FROM runtime_state WHERE state_key = 'pending_startup_ack'`,
      )
      .run();
  }

  private ensureDb(): Database {
    if (!this.db) {
      throw new Error("SqliteSessionStore is not initialized");
    }
    return this.db;
  }
}
