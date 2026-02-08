import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type SessionMapping = {
  sessionKey: string;
  opencodeSessionId: string;
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

export type PendingScheduledDeliveryAck = {
  id: number;
  chatId: string;
  deliveredAt: string;
  nextAttemptAt: string;
};

export type ScheduledMessage = {
  id: number;
  chatId: string;
  threadId: string | null;
  text: string;
  sendAt: string;
  attemptCount: number;
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
  try {
    const parsed = JSON.parse(sessionKey) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) {
      return null;
    }
    const topicKey = parsed[0];
    const workspacePath = parsed[1];
    if (typeof topicKey !== "string" || typeof workspacePath !== "string") {
      return null;
    }
    return {
      topicKey,
      workspacePath,
    };
  } catch {
    return null;
  }
};

const asSessionListItem = (row: {
  session_key: string;
  opencode_session_id: string;
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
    opencodeSessionId: row.opencode_session_id,
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
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        thread_id TEXT,
        text TEXT NOT NULL,
        send_at TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        last_error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT
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
      CREATE INDEX IF NOT EXISTS scheduled_messages_due_idx
      ON scheduled_messages(status, send_at, next_attempt_at);
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_delivery_acks (
        schedule_id INTEGER PRIMARY KEY,
        chat_id TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        next_attempt_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS scheduled_delivery_acks_next_attempt_idx
      ON scheduled_delivery_acks(next_attempt_at);
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

  async getSessionById(id: string): Promise<SessionListItem | null> {
    const sessionKey = decodeSessionKeyId(id);
    if (!sessionKey) {
      return null;
    }

    const row = this.ensureDb()
      .query(
        `
          SELECT
            session_key,
            opencode_session_id,
            last_used_at,
            status,
            json_extract(session_key, '$[0]') as topic_key,
            json_extract(session_key, '$[1]') as workspace_path
          FROM session_mappings
          WHERE session_key = $session_key
        `,
      )
      .get({ session_key: sessionKey }) as {
      session_key: string;
      opencode_session_id: string;
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
      whereParts.push("status = $status");
      params.status = filters.status;
    }

    if (filters.topicKey) {
      whereParts.push("json_extract(session_key, '$[0]') = $topic_key");
      params.topic_key = filters.topicKey;
    }

    if (filters.workspacePath) {
      whereParts.push("json_extract(session_key, '$[1]') = $workspace_path");
      params.workspace_path = filters.workspacePath;
    }

    if (filters.q) {
      whereParts.push(`
        (
          LOWER(session_key) LIKE $q
          OR LOWER(opencode_session_id) LIKE $q
          OR LOWER(COALESCE(json_extract(session_key, '$[0]'), '')) LIKE $q
          OR LOWER(COALESCE(json_extract(session_key, '$[1]'), '')) LIKE $q
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
            session_key,
            opencode_session_id,
            last_used_at,
            status,
            json_extract(session_key, '$[0]') as topic_key,
            json_extract(session_key, '$[1]') as workspace_path
          FROM session_mappings
          ${whereClause}
          ORDER BY last_used_at DESC
          LIMIT $limit OFFSET $offset
        `,
      )
      .all(params) as Array<{
      session_key: string;
      opencode_session_id: string;
      last_used_at: string;
      status: string;
      topic_key: string | null;
      workspace_path: string | null;
    }>;

    const total = this.ensureDb()
      .query(
        `
          SELECT COUNT(*) as total
          FROM session_mappings
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

  async upsertPendingScheduledDeliveryAck(
    entry: PendingScheduledDeliveryAck,
  ): Promise<void> {
    this.ensureDb()
      .query(
        `
          INSERT INTO scheduled_delivery_acks (
            schedule_id,
            chat_id,
            delivered_at,
            next_attempt_at,
            updated_at
          )
          VALUES (
            $schedule_id,
            $chat_id,
            $delivered_at,
            $next_attempt_at,
            $updated_at
          )
          ON CONFLICT(schedule_id) DO UPDATE SET
            chat_id = excluded.chat_id,
            delivered_at = excluded.delivered_at,
            next_attempt_at = excluded.next_attempt_at,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        schedule_id: entry.id,
        chat_id: entry.chatId,
        delivered_at: entry.deliveredAt,
        next_attempt_at: entry.nextAttemptAt,
        updated_at: new Date().toISOString(),
      });
  }

  async listPendingScheduledDeliveryAcks(
    limit: number,
  ): Promise<PendingScheduledDeliveryAck[]> {
    const rows = this.ensureDb()
      .query(
        `
          SELECT schedule_id, chat_id, delivered_at, next_attempt_at
          FROM scheduled_delivery_acks
          ORDER BY next_attempt_at ASC, schedule_id ASC
          LIMIT $limit
        `,
      )
      .all({ limit }) as Array<{
      schedule_id: number;
      chat_id: string;
      delivered_at: string;
      next_attempt_at: string;
    }>;

    return rows.map((row) => ({
      id: row.schedule_id,
      chatId: row.chat_id,
      deliveredAt: row.delivered_at,
      nextAttemptAt: row.next_attempt_at,
    }));
  }

  async clearPendingScheduledDeliveryAck(id: number): Promise<void> {
    this.ensureDb()
      .query(
        `DELETE FROM scheduled_delivery_acks WHERE schedule_id = $schedule_id`,
      )
      .run({ schedule_id: id });
  }

  async enqueueScheduledMessage(entry: {
    chatId: string;
    threadId: string | null;
    text: string;
    sendAt: string;
    createdAt: string;
  }): Promise<number> {
    const result = this.ensureDb()
      .query(
        `
          INSERT INTO scheduled_messages (
            chat_id,
            thread_id,
            text,
            send_at,
            status,
            created_at,
            delivered_at,
            last_error,
            attempt_count,
            next_attempt_at
          )
          VALUES (
            $chat_id,
            $thread_id,
            $text,
            $send_at,
            'pending',
            $created_at,
            NULL,
            NULL,
            0,
            NULL
          )
        `,
      )
      .run({
        chat_id: entry.chatId,
        thread_id: entry.threadId,
        text: entry.text,
        send_at: entry.sendAt,
        created_at: entry.createdAt,
      });

    return Number(result.lastInsertRowid);
  }

  async listDueScheduledMessages(input: {
    nowIso: string;
    limit: number;
  }): Promise<ScheduledMessage[]> {
    const rows = this.ensureDb()
      .query(
        `
          SELECT id, chat_id, thread_id, text, send_at, attempt_count
          FROM scheduled_messages
          WHERE status = 'pending'
            AND send_at <= $now_iso
            AND (next_attempt_at IS NULL OR next_attempt_at <= $now_iso)
            AND NOT EXISTS (
              SELECT 1
              FROM scheduled_delivery_acks
              WHERE schedule_id = scheduled_messages.id
            )
          ORDER BY send_at ASC, id ASC
          LIMIT $limit
        `,
      )
      .all({
        now_iso: input.nowIso,
        limit: input.limit,
      }) as Array<{
      id: number;
      chat_id: string;
      thread_id: string | null;
      text: string;
      send_at: string;
      attempt_count: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      threadId: row.thread_id,
      text: row.text,
      sendAt: row.send_at,
      attemptCount: row.attempt_count,
    }));
  }

  async markScheduledMessageDelivered(input: {
    id: number;
    deliveredAt: string;
  }): Promise<void> {
    this.ensureDb()
      .query(
        `
          UPDATE scheduled_messages
          SET
            status = 'sent',
            delivered_at = $delivered_at,
            last_error = NULL,
            next_attempt_at = NULL
          WHERE id = $id
        `,
      )
      .run({
        id: input.id,
        delivered_at: input.deliveredAt,
      });
  }

  async markScheduledMessageFailed(input: {
    id: number;
    error: string;
    nextAttemptAt: string;
  }): Promise<void> {
    this.ensureDb()
      .query(
        `
          UPDATE scheduled_messages
          SET
            status = 'pending',
            last_error = $last_error,
            attempt_count = attempt_count + 1,
            next_attempt_at = $next_attempt_at
          WHERE id = $id
        `,
      )
      .run({
        id: input.id,
        last_error: input.error,
        next_attempt_at: input.nextAttemptAt,
      });
  }

  private ensureDb(): Database {
    if (!this.db) {
      throw new Error("SqliteSessionStore is not initialized");
    }
    return this.db;
  }
}
