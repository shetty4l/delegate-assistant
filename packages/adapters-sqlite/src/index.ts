import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ExecutionPlan,
  PlanSideEffectType,
  WorkItem,
} from "@delegate/domain";
import type { PlanStore, WorkItemStore } from "@delegate/ports";

type WorkItemRow = {
  id: string;
  trace_id: string;
  status: string;
  summary: string;
  created_at: string;
  updated_at: string;
};

type PlanRow = {
  id: string;
  work_item_id: string;
  intent_summary: string;
  assumptions_json: string;
  ambiguities_json: string;
  proposed_next_step: string;
  risk_level: string;
  side_effects_json: string;
  requires_approval: number;
  created_at: string;
};

export class SqliteWorkItemStore implements WorkItemStore, PlanStore {
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        intent_summary TEXT NOT NULL,
        assumptions_json TEXT NOT NULL,
        ambiguities_json TEXT NOT NULL,
        proposed_next_step TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        side_effects_json TEXT NOT NULL,
        requires_approval INTEGER NOT NULL,
        created_at TEXT NOT NULL
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

  async updateStatus(
    id: string,
    status: WorkItem["status"],
    updatedAt: string,
  ): Promise<void> {
    this.ensureDb()
      .query(
        `
          UPDATE work_items
          SET status = $status, updated_at = $updated_at
          WHERE id = $id
        `,
      )
      .run({
        id,
        status,
        updated_at: updatedAt,
      });
  }

  async createPlan(plan: ExecutionPlan): Promise<void> {
    this.ensureDb()
      .query(
        `
          INSERT INTO plans (
            id,
            work_item_id,
            intent_summary,
            assumptions_json,
            ambiguities_json,
            proposed_next_step,
            risk_level,
            side_effects_json,
            requires_approval,
            created_at
          ) VALUES (
            $id,
            $work_item_id,
            $intent_summary,
            $assumptions_json,
            $ambiguities_json,
            $proposed_next_step,
            $risk_level,
            $side_effects_json,
            $requires_approval,
            $created_at
          )
        `,
      )
      .run({
        id: plan.id,
        work_item_id: plan.workItemId,
        intent_summary: plan.intentSummary,
        assumptions_json: JSON.stringify(plan.assumptions),
        ambiguities_json: JSON.stringify(plan.ambiguities),
        proposed_next_step: plan.proposedNextStep,
        risk_level: plan.riskLevel,
        side_effects_json: JSON.stringify(plan.sideEffects),
        requires_approval: plan.requiresApproval ? 1 : 0,
        created_at: plan.createdAt,
      });
  }

  async getPlanByWorkItemId(workItemId: string): Promise<ExecutionPlan | null> {
    const row = this.ensureDb()
      .query(
        `
          SELECT
            id,
            work_item_id,
            intent_summary,
            assumptions_json,
            ambiguities_json,
            proposed_next_step,
            risk_level,
            side_effects_json,
            requires_approval,
            created_at
          FROM plans
          WHERE work_item_id = $work_item_id
        `,
      )
      .get({ work_item_id: workItemId }) as PlanRow | null;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      workItemId: row.work_item_id,
      intentSummary: row.intent_summary,
      assumptions: JSON.parse(row.assumptions_json) as string[],
      ambiguities: JSON.parse(row.ambiguities_json) as string[],
      proposedNextStep: row.proposed_next_step,
      riskLevel: row.risk_level as ExecutionPlan["riskLevel"],
      sideEffects: JSON.parse(row.side_effects_json) as PlanSideEffectType[],
      requiresApproval: row.requires_approval === 1,
      createdAt: row.created_at,
    };
  }

  private ensureDb(): Database {
    if (!this.db) {
      throw new Error("SqliteWorkItemStore is not initialized");
    }
    return this.db;
  }
}
