import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ApprovalRecord,
  ExecutionPlan,
  GeneratedFileArtifact,
  PlanSideEffectType,
  WorkItem,
} from "@delegate/domain";
import type {
  ApprovalStore,
  ArtifactStore,
  PlanStore,
  WorkItemStore,
} from "@delegate/ports";

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

type ApprovalRow = {
  id: string;
  work_item_id: string;
  action_type: string;
  payload_hash: string;
  status: string;
  requested_at: string;
  expires_at: string;
  consumed_at: string | null;
  decision_reason: string | null;
};

type ArtifactRow = {
  work_item_id: string;
  path: string;
  content: string;
  summary: string;
};

export class SqliteWorkItemStore
  implements WorkItemStore, PlanStore, ApprovalStore, ArtifactStore
{
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        decision_reason TEXT
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS approvals_work_item_status_idx
      ON approvals(work_item_id, status);
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS generated_artifacts (
        work_item_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
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

  async createApproval(record: ApprovalRecord): Promise<void> {
    this.ensureDb()
      .query(
        `
          INSERT INTO approvals (
            id,
            work_item_id,
            action_type,
            payload_hash,
            status,
            requested_at,
            expires_at,
            consumed_at,
            decision_reason
          ) VALUES (
            $id,
            $work_item_id,
            $action_type,
            $payload_hash,
            $status,
            $requested_at,
            $expires_at,
            $consumed_at,
            $decision_reason
          )
        `,
      )
      .run({
        id: record.id,
        work_item_id: record.workItemId,
        action_type: record.actionType,
        payload_hash: record.payloadHash,
        status: record.status,
        requested_at: record.requestedAt,
        expires_at: record.expiresAt,
        consumed_at: record.consumedAt,
        decision_reason: record.decisionReason,
      });
  }

  async getApprovalById(approvalId: string): Promise<ApprovalRecord | null> {
    const row = this.ensureDb()
      .query(
        `
          SELECT
            id,
            work_item_id,
            action_type,
            payload_hash,
            status,
            requested_at,
            expires_at,
            consumed_at,
            decision_reason
          FROM approvals
          WHERE id = $id
        `,
      )
      .get({ id: approvalId }) as ApprovalRow | null;

    return row ? this.mapApprovalRow(row) : null;
  }

  async getLatestApprovalByWorkItemId(
    workItemId: string,
  ): Promise<ApprovalRecord | null> {
    const row = this.ensureDb()
      .query(
        `
          SELECT
            id,
            work_item_id,
            action_type,
            payload_hash,
            status,
            requested_at,
            expires_at,
            consumed_at,
            decision_reason
          FROM approvals
          WHERE work_item_id = $work_item_id
          ORDER BY requested_at DESC
          LIMIT 1
        `,
      )
      .get({ work_item_id: workItemId }) as ApprovalRow | null;

    return row ? this.mapApprovalRow(row) : null;
  }

  async updateApprovalStatus(
    approvalId: string,
    status: ApprovalRecord["status"],
    consumedAt: string | null,
    decisionReason: string | null,
  ): Promise<void> {
    this.ensureDb()
      .query(
        `
          UPDATE approvals
          SET status = $status,
              consumed_at = $consumed_at,
              decision_reason = $decision_reason
          WHERE id = $id
        `,
      )
      .run({
        id: approvalId,
        status,
        consumed_at: consumedAt,
        decision_reason: decisionReason,
      });
  }

  async saveArtifact(
    workItemId: string,
    artifact: GeneratedFileArtifact,
    createdAt: string,
  ): Promise<void> {
    this.ensureDb()
      .query(
        `
          INSERT INTO generated_artifacts (work_item_id, path, content, summary, created_at)
          VALUES ($work_item_id, $path, $content, $summary, $created_at)
          ON CONFLICT(work_item_id) DO UPDATE SET
            path = excluded.path,
            content = excluded.content,
            summary = excluded.summary,
            created_at = excluded.created_at
        `,
      )
      .run({
        work_item_id: workItemId,
        path: artifact.path,
        content: artifact.content,
        summary: artifact.summary,
        created_at: createdAt,
      });
  }

  async getArtifactByWorkItemId(
    workItemId: string,
  ): Promise<GeneratedFileArtifact | null> {
    const row = this.ensureDb()
      .query(
        `
          SELECT work_item_id, path, content, summary
          FROM generated_artifacts
          WHERE work_item_id = $work_item_id
        `,
      )
      .get({ work_item_id: workItemId }) as ArtifactRow | null;

    if (!row) {
      return null;
    }

    return {
      path: row.path,
      content: row.content,
      summary: row.summary,
    };
  }

  private mapApprovalRow(row: ApprovalRow): ApprovalRecord {
    return {
      id: row.id,
      workItemId: row.work_item_id,
      actionType: row.action_type as ApprovalRecord["actionType"],
      payloadHash: row.payload_hash,
      status: row.status as ApprovalRecord["status"],
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      decisionReason: row.decision_reason,
    };
  }

  private ensureDb(): Database {
    if (!this.db) {
      throw new Error("SqliteWorkItemStore is not initialized");
    }
    return this.db;
  }
}
