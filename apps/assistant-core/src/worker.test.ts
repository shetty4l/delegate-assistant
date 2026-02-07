import { describe, expect, test } from "bun:test";

import type {
  AuditEvent,
  ExecutionPlan,
  ExecutionPlanDraft,
  InboundMessage,
  OutboundMessage,
  WorkItem,
  WorkItemStatus,
} from "@delegate/domain";
import type {
  AuditPort,
  ChatPort,
  ChatUpdate,
  ModelPort,
  PlanInput,
  PlanStore,
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

const inbound = (text: string): InboundMessage => ({
  chatId: "123",
  text,
  receivedAt: new Date().toISOString(),
});

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
  test("creates work item, persists plan, and responds with preview", async () => {
    const workItemStore = new InMemoryWorkItemStore();
    const planStore = new InMemoryPlanStore();
    const chatPort = new CapturingChatPort();
    const auditPort = new CapturingAuditPort();

    await handleChatMessage(
      {
        chatPort,
        modelPort: new HighRiskModelStub(),
        workItemStore,
        planStore,
        auditPort,
      },
      inbound("Please publish a PR for this refactor"),
    );

    const items = workItemStore.all();
    expect(items.length).toBe(1);
    expect(items[0]?.status).toBe("triaged");

    const plan = await planStore.getPlanByWorkItemId(items[0]!.id);
    expect(plan?.requiresApproval).toBe(true);
    expect(chatPort.sent[0]?.text.includes("Approval preview")).toBe(true);
    expect(auditPort.events.map((event) => event.eventType)).toEqual([
      "work_item.delegated",
      "plan.created",
      "work_item.triaged",
    ]);
  });

  test("returns status for existing work item", async () => {
    const workItemStore = new InMemoryWorkItemStore();
    const planStore = new InMemoryPlanStore();
    const chatPort = new CapturingChatPort();

    await workItemStore.create({
      id: "work-123",
      traceId: "trace-123",
      status: "triaged",
      summary: "A task",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await handleChatMessage(
      {
        chatPort,
        modelPort: new HighRiskModelStub(),
        workItemStore,
        planStore,
        auditPort: new CapturingAuditPort(),
      },
      inbound("/status work-123"),
    );

    expect(chatPort.sent[0]?.text).toContain("status=triaged");
  });
});
