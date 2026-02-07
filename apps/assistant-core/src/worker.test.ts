import { describe, expect, test } from "bun:test";

import type {
  ApprovalRecord,
  ApprovalStatus,
  AuditEvent,
  ExecutionPlan,
  ExecutionPlanDraft,
  InboundMessage,
  OutboundMessage,
  PolicyDecision,
  WorkItem,
  WorkItemStatus,
} from "@delegate/domain";
import type {
  ApprovalStore,
  AuditPort,
  ChatPort,
  ChatUpdate,
  ModelPort,
  PlanInput,
  PlanStore,
  PolicyEngine,
  WorkItemStore,
} from "@delegate/ports";

import { handleChatMessage, parseCommand } from "./worker";

class InMemoryWorkItemStore implements WorkItemStore {
  private readonly items = new Map<string, WorkItem>();

  async init(): Promise<void> {}

  async ping(): Promise<void> {}

  async create(workItem: WorkItem): Promise<void> {
    this.items.set(workItem.id, workItem);
  }

  async getById(id: string): Promise<WorkItem | null> {
    return this.items.get(id) ?? null;
  }

  async updateStatus(
    id: string,
    status: WorkItemStatus,
    updatedAt: string,
  ): Promise<void> {
    const existing = this.items.get(id);
    if (!existing) {
      return;
    }
    this.items.set(id, {
      ...existing,
      status,
      updatedAt,
    });
  }

  all(): WorkItem[] {
    return [...this.items.values()];
  }
}

class InMemoryPlanStore implements PlanStore {
  private readonly plans = new Map<string, ExecutionPlan>();

  async createPlan(plan: ExecutionPlan): Promise<void> {
    this.plans.set(plan.workItemId, plan);
  }

  async getPlanByWorkItemId(workItemId: string): Promise<ExecutionPlan | null> {
    return this.plans.get(workItemId) ?? null;
  }
}

class InMemoryApprovalStore implements ApprovalStore {
  private readonly approvals = new Map<string, ApprovalRecord>();

  async createApproval(record: ApprovalRecord): Promise<void> {
    this.approvals.set(record.id, record);
  }

  async getApprovalById(approvalId: string): Promise<ApprovalRecord | null> {
    return this.approvals.get(approvalId) ?? null;
  }

  async getLatestApprovalByWorkItemId(
    workItemId: string,
  ): Promise<ApprovalRecord | null> {
    const values = [...this.approvals.values()].filter(
      (approval) => approval.workItemId === workItemId,
    );
    values.sort((a, b) =>
      a.requestedAt < b.requestedAt
        ? 1
        : a.requestedAt > b.requestedAt
          ? -1
          : 0,
    );
    return values[0] ?? null;
  }

  async updateApprovalStatus(
    approvalId: string,
    status: ApprovalStatus,
    consumedAt: string | null,
    decisionReason: string | null,
  ): Promise<void> {
    const existing = this.approvals.get(approvalId);
    if (!existing) {
      return;
    }
    this.approvals.set(approvalId, {
      ...existing,
      status,
      consumedAt,
      decisionReason,
    });
  }

  all(): ApprovalRecord[] {
    return [...this.approvals.values()];
  }

  tamperPayloadHash(approvalId: string, payloadHash: string): void {
    const existing = this.approvals.get(approvalId);
    if (!existing) {
      return;
    }
    this.approvals.set(approvalId, {
      ...existing,
      payloadHash,
    });
  }

  tamperExpiry(approvalId: string, expiresAt: string): void {
    const existing = this.approvals.get(approvalId);
    if (!existing) {
      return;
    }
    this.approvals.set(approvalId, {
      ...existing,
      expiresAt,
    });
  }
}

class CapturingChatPort implements ChatPort {
  readonly sent: OutboundMessage[] = [];

  async receiveUpdates(_cursor: number | null): Promise<ChatUpdate[]> {
    return [];
  }

  async send(message: OutboundMessage): Promise<void> {
    this.sent.push(message);
  }
}

class CapturingAuditPort implements AuditPort {
  readonly events: AuditEvent[] = [];

  async init(): Promise<void> {}

  async ping(): Promise<void> {}

  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class HighRiskModelStub implements ModelPort {
  async plan(_input: PlanInput): Promise<ExecutionPlanDraft> {
    return {
      intentSummary: "Publish a PR with requested changes",
      assumptions: ["Repository access is configured"],
      ambiguities: ["Target branch not specified"],
      proposedNextStep: "Review patch and request approval",
      riskLevel: "HIGH",
      sideEffects: ["local_code_changes", "external_publish"],
      requiresApproval: true,
    };
  }
}

class ApprovalRequiredPolicy implements PolicyEngine {
  async evaluate(_plan: ExecutionPlanDraft): Promise<PolicyDecision> {
    return {
      decision: "requires_approval",
      reasonCode: "MISSING_APPROVAL",
    };
  }
}

const inbound = (text: string): InboundMessage => ({
  chatId: "123",
  text,
  receivedAt: new Date().toISOString(),
});

const setup = () => {
  const workItemStore = new InMemoryWorkItemStore();
  const planStore = new InMemoryPlanStore();
  const approvalStore = new InMemoryApprovalStore();
  const chatPort = new CapturingChatPort();
  const auditPort = new CapturingAuditPort();

  return {
    deps: {
      chatPort,
      modelPort: new HighRiskModelStub(),
      workItemStore,
      planStore,
      approvalStore,
      policyEngine: new ApprovalRequiredPolicy(),
      auditPort,
    },
    workItemStore,
    planStore,
    approvalStore,
    chatPort,
    auditPort,
  };
};

describe("parseCommand", () => {
  test("parses slash commands", () => {
    expect(parseCommand("/status work-1")).toEqual({
      type: "status",
      workItemId: "work-1",
    });
  });

  test("falls back to delegation for plain text", () => {
    expect(parseCommand("ship this change")).toEqual({
      type: "delegate",
      text: "ship this change",
    });
  });
});

describe("handleChatMessage", () => {
  test("creates approval-pending work item and returns approval id", async () => {
    const state = setup();

    await handleChatMessage(
      state.deps,
      inbound("Please publish a PR for this refactor"),
    );

    const items = state.workItemStore.all();
    expect(items.length).toBe(1);
    expect(items[0]?.status).toBe("approval_pending");

    const approval = state.approvalStore.all()[0];
    expect(approval?.status).toBe("pending");
    expect(state.chatPort.sent[0]?.text).toContain(`/approve ${approval?.id}`);
    expect(state.auditPort.events.map((event) => event.eventType)).toEqual([
      "work_item.delegated",
      "approval.requested",
      "plan.created",
      "work_item.triaged",
    ]);
  });

  test("returns approval status in status command", async () => {
    const state = setup();

    await handleChatMessage(
      state.deps,
      inbound("Please publish a PR for this refactor"),
    );

    const workItemId = state.workItemStore.all()[0]!.id;
    await handleChatMessage(state.deps, inbound(`/status ${workItemId}`));

    expect(state.chatPort.sent[1]?.text).toContain("approval=pending");
  });

  test("approves once and rejects replay", async () => {
    const state = setup();

    await handleChatMessage(
      state.deps,
      inbound("Please publish a PR for this refactor"),
    );

    const approvalId = state.approvalStore.all()[0]!.id;
    await handleChatMessage(state.deps, inbound(`/approve ${approvalId}`));
    await handleChatMessage(state.deps, inbound(`/approve ${approvalId}`));

    expect(state.chatPort.sent[1]?.text).toContain("Approval accepted");
    expect(state.chatPort.sent[2]?.text).toContain(
      "Approval rejected: REPLAYED",
    );
  });

  test("denies and marks work item denied", async () => {
    const state = setup();

    await handleChatMessage(
      state.deps,
      inbound("Please publish a PR for this refactor"),
    );

    const approvalId = state.approvalStore.all()[0]!.id;
    await handleChatMessage(state.deps, inbound(`/deny ${approvalId}`));

    const item = state.workItemStore.all()[0]!;
    expect(item.status).toBe("denied");
    expect(state.chatPort.sent[1]?.text).toContain("Approval denied");
  });

  test("rejects expired approvals", async () => {
    const state = setup();

    await handleChatMessage(
      state.deps,
      inbound("Please publish a PR for this refactor"),
    );

    const approvalId = state.approvalStore.all()[0]!.id;
    state.approvalStore.tamperExpiry(approvalId, "2000-01-01T00:00:00.000Z");

    await handleChatMessage(state.deps, inbound(`/approve ${approvalId}`));
    expect(state.chatPort.sent[1]?.text).toContain(
      "Approval rejected: EXPIRED",
    );
  });

  test("rejects mismatched approval hash", async () => {
    const state = setup();

    await handleChatMessage(
      state.deps,
      inbound("Please publish a PR for this refactor"),
    );

    const approvalId = state.approvalStore.all()[0]!.id;
    state.approvalStore.tamperPayloadHash(approvalId, "tampered");

    await handleChatMessage(state.deps, inbound(`/approve ${approvalId}`));
    expect(state.chatPort.sent[1]?.text).toContain(
      "Approval rejected: MISMATCH",
    );
  });
});
