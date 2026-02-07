import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { WorkItem } from "@delegate/domain";
import type { WorkItemStore } from "@delegate/ports";

type WorkItemRow = {
  id: string;
  trace_id: string;
  status: string;
  summary: string;
  created_at: string;
  updated_at: string;
};

export class SqliteWorkItemStore implements WorkItemStore {
  private db: Database | null = null;

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath, { create: true, strict: true });
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
    this.db = db;
  }

  async ping(): Promise<void> {
    this.ensureDb().query("SELECT 1 as ok").get();
  }

  async create(workItem: WorkItem): Promise<void> {
    this.ensureDb()
      .query(
        `
        INSERT INTO work_items (id, trace_id, status, summary, created_at, updated_at)
        VALUES ($id, $trace_id, $status, $summary, $created_at, $updated_at)
      `,
      )
      .run({
        id: workItem.id,
        trace_id: workItem.traceId,
        status: workItem.status,
        summary: workItem.summary,
        created_at: workItem.createdAt,
        updated_at: workItem.updatedAt,
      });
  }

  async getById(id: string): Promise<WorkItem | null> {
    const row = this.ensureDb()
      .query(
        `
        SELECT id, trace_id, status, summary, created_at, updated_at
        FROM work_items
        WHERE id = $id
      `,
      )
      .get({ id }) as WorkItemRow | null;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      traceId: row.trace_id,
      status: row.status as WorkItem["status"],
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private ensureDb(): Database {
    if (!this.db) {
      throw new Error("SqliteWorkItemStore is not initialized");
    }
    return this.db;
  }
}
