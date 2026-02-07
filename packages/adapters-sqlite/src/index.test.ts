import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApprovalRecord, ExecutionPlan, WorkItem } from "@delegate/domain";

import { SqliteWorkItemStore } from "./index";

describe("SqliteWorkItemStore", () => {
  let dirPath = "";
  let dbPath = "";
  let store: SqliteWorkItemStore;

  beforeEach(async () => {
    dirPath = await mkdtemp(join(tmpdir(), "delegate-assistant-test-"));
    dbPath = join(dirPath, "assistant.db");
    store = new SqliteWorkItemStore(dbPath);
    await store.init();
  });

  afterEach(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });

  test("persists and reads plans by work item id", async () => {
    const now = new Date().toISOString();
    const workItem: WorkItem = {
      id: "work-item-1",
      traceId: "trace-1",
      status: "delegated",
      summary: "Rename function and open PR",
      createdAt: now,
      updatedAt: now,
    };

    const plan: ExecutionPlan = {
      id: "plan-1",
      workItemId: workItem.id,
      createdAt: now,
      intentSummary: "Create a small rename patch",
      assumptions: ["Repository is available"],
      ambiguities: ["Target branch not specified"],
      proposedNextStep: "Prepare a patch for review",
      riskLevel: "HIGH",
      sideEffects: ["local_code_changes", "external_publish"],
      requiresApproval: true,
    };

    await store.create(workItem);
    await store.createPlan(plan);
    await store.updateStatus(workItem.id, "triaged", now);

    const savedWorkItem = await store.getById(workItem.id);
    const savedPlan = await store.getPlanByWorkItemId(workItem.id);

    expect(savedWorkItem?.status).toBe("triaged");
    expect(savedPlan).toEqual(plan);
  });

  test("persists approvals and supports status updates", async () => {
    const now = new Date().toISOString();
    const workItem: WorkItem = {
      id: "work-item-approval",
      traceId: "trace-approval",
      status: "approval_pending",
      summary: "Publish a PR",
      createdAt: now,
      updatedAt: now,
    };

    const approval: ApprovalRecord = {
      id: "approval-1",
      workItemId: workItem.id,
      actionType: "publish_pr",
      payloadHash: "abc123",
      status: "pending",
      requestedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumedAt: null,
      decisionReason: null,
    };

    await store.create(workItem);
    await store.createApproval(approval);

    const pending = await store.getApprovalById(approval.id);
    expect(pending).toEqual(approval);

    await store.updateApprovalStatus(approval.id, "approved", now, "APPROVED");

    const latest = await store.getLatestApprovalByWorkItemId(workItem.id);
    expect(latest?.status).toBe("approved");
    expect(latest?.decisionReason).toBe("APPROVED");
  });

  test("lists pending approvals for recovery", async () => {
    const now = new Date().toISOString();
    const workItem: WorkItem = {
      id: "work-item-recovery",
      traceId: "trace-recovery",
      status: "approval_pending",
      summary: "Recover pending approvals",
      createdAt: now,
      updatedAt: now,
    };

    await store.create(workItem);
    await store.createApproval({
      id: "approval-pending",
      workItemId: workItem.id,
      actionType: "publish_pr",
      payloadHash: "hash-pending",
      status: "pending",
      requestedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumedAt: null,
      decisionReason: null,
    });
    await store.createApproval({
      id: "approval-approved",
      workItemId: workItem.id,
      actionType: "publish_pr",
      payloadHash: "hash-approved",
      status: "approved",
      requestedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumedAt: now,
      decisionReason: "APPROVED",
    });

    const pending = await store.listPendingApprovals();
    expect(pending.map((approval) => approval.id)).toEqual([
      "approval-pending",
    ]);
  });

  test("persists generated artifact by work item", async () => {
    const now = new Date().toISOString();
    const workItem: WorkItem = {
      id: "work-item-artifact",
      traceId: "trace-artifact",
      status: "triaged",
      summary: "Generate one file",
      createdAt: now,
      updatedAt: now,
    };

    await store.create(workItem);
    await store.saveArtifact(
      workItem.id,
      {
        path: "delegate-work-items/work-item-artifact.md",
        content: "# generated",
        summary: "Generated artifact summary",
      },
      now,
    );

    const artifact = await store.getArtifactByWorkItemId(workItem.id);
    expect(artifact).toEqual({
      path: "delegate-work-items/work-item-artifact.md",
      content: "# generated",
      summary: "Generated artifact summary",
    });
  });
});
