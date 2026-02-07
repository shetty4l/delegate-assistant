import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecutionPlan, WorkItem } from "@delegate/domain";

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
});
