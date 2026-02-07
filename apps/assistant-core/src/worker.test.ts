import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ApprovalRecord,
  ApprovalStatus,
  AuditEvent,
  ExecutionPlan,
  GeneratedFileArtifact,
  InboundMessage,
  ModelTurnResponse,
  OutboundMessage,
  PublishPrInput,
  PublishPrResult,
  WorkItem,
  WorkItemStatus,
} from "@delegate/domain";
import type {
  ApprovalStore,
  ArtifactStore,
  AuditPort,
  ChatPort,
  ChatUpdate,
  ModelPort,
  PlanStore,
  PolicyEngine,
  RespondInput,
  VcsPort,
  WorkItemStore,
} from "@delegate/ports";

import { handleChatMessage, recoverInFlightWorkItems } from "./worker";

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
    if (!existing) return;
    this.items.set(id, { ...existing, status, updatedAt });
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
    return (
      [...this.approvals.values()].find(
        (approval) => approval.workItemId === workItemId,
      ) ?? null
    );
  }
  async listPendingApprovals(): Promise<ApprovalRecord[]> {
    return [...this.approvals.values()].filter(
      (approval) => approval.status === "pending",
    );
  }
  async updateApprovalStatus(
    approvalId: string,
    status: ApprovalStatus,
    consumedAt: string | null,
    decisionReason: string | null,
  ): Promise<void> {
    const existing = this.approvals.get(approvalId);
    if (!existing) return;
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
}

class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, GeneratedFileArtifact>();
  async saveArtifact(
    workItemId: string,
    artifact: GeneratedFileArtifact,
  ): Promise<void> {
    this.artifacts.set(workItemId, artifact);
  }
  async getArtifactByWorkItemId(
    workItemId: string,
  ): Promise<GeneratedFileArtifact | null> {
    return this.artifacts.get(workItemId) ?? null;
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

class ScriptedModel implements ModelPort {
  constructor(
    private readonly respondFn: (input: RespondInput) => ModelTurnResponse,
  ) {}
  async respond(input: RespondInput): Promise<ModelTurnResponse> {
    return this.respondFn(input);
  }
}

class AllowPolicy implements PolicyEngine {
  async evaluate() {
    return { decision: "allow", reasonCode: "LOW_RISK_ALLOWED" } as const;
  }
}

class CapturingVcsPort implements VcsPort {
  readonly calls: PublishPrInput[] = [];
  async publishPr(input: PublishPrInput): Promise<PublishPrResult> {
    this.calls.push(input);
    return {
      branchName: `delegate/${input.workItemId}`,
      pullRequestUrl: `https://example.test/pr/${input.workItemId}`,
    };
  }
}

const inbound = (text: string): InboundMessage => ({
  chatId: "chat-1",
  text,
  receivedAt: new Date().toISOString(),
});

const setup = (respondFn: (input: RespondInput) => ModelTurnResponse) => {
  const workItemStore = new InMemoryWorkItemStore();
  const planStore = new InMemoryPlanStore();
  const approvalStore = new InMemoryApprovalStore();
  const artifactStore = new InMemoryArtifactStore();
  const chatPort = new CapturingChatPort();
  const auditPort = new CapturingAuditPort();
  const vcsPort = new CapturingVcsPort();

  return {
    deps: {
      chatPort,
      modelPort: new ScriptedModel(respondFn),
      workItemStore,
      planStore,
      approvalStore,
      artifactStore,
      policyEngine: new AllowPolicy(),
      auditPort,
      vcsPort,
    },
    workItemStore,
    approvalStore,
    chatPort,
    vcsPort,
  };
};

describe("conversation-first worker", () => {
  test("handles /start only for first message", async () => {
    const state = setup(() => ({
      mode: "chat_reply",
      confidence: 0.1,
      replyText: "hi",
    }));
    await handleChatMessage(state.deps, inbound("/start"));
    await handleChatMessage(state.deps, inbound("/start"));
    expect(state.chatPort.sent.length).toBe(1);
    expect(state.workItemStore.all().length).toBe(0);
  });

  test("casual chat does not create work item", async () => {
    const state = setup(() => ({
      mode: "chat_reply",
      confidence: 0.2,
      replyText: "All good - what should we build?",
    }));

    await handleChatMessage(state.deps, inbound("Hows it going?"));
    expect(state.chatPort.sent[0]?.text).toContain("All good");
    expect(state.workItemStore.all().length).toBe(0);
  });

  test("high-confidence execution proposal creates approval prompt", async () => {
    const state = setup(() => ({
      mode: "execution_proposal",
      confidence: 0.9,
      replyText: "I can implement this and open a PR.",
      plan: {
        intentSummary: "Implement feature",
        assumptions: ["repo exists"],
        ambiguities: [],
        proposedNextStep: "Create patch",
        riskLevel: "HIGH",
        sideEffects: ["local_code_changes", "external_publish"],
        requiresApproval: true,
      },
      artifact: {
        path: "changes/feature.md",
        content: "content",
        summary: "feature patch",
      },
    }));

    await handleChatMessage(state.deps, inbound("open a PR for this"));
    expect(state.workItemStore.all().length).toBe(1);
    expect(state.approvalStore.all().length).toBe(1);
    expect(state.chatPort.sent[0]?.text).toContain("Approve / Revise / Deny");
  });

  test("routine local change applies directly without PR", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "delegate-assistant-"));
    try {
      const state = setup(() => ({
        mode: "execution_proposal",
        confidence: 0.92,
        replyText: "I can create that file locally.",
        plan: {
          intentSummary: "Create TEST_FILE",
          assumptions: [],
          ambiguities: [],
          proposedNextStep: "write file",
          riskLevel: "LOW",
          sideEffects: ["local_code_changes"],
          requiresApproval: false,
        },
        artifact: {
          path: "TEST_FILE",
          content: "hello",
          summary: "create test file",
        },
      }));

      await handleChatMessage(state.deps, inbound("create TEST_FILE"), {
        assistantRepoPath: repoPath,
      });

      const text = await Bun.file(join(repoPath, "TEST_FILE")).text();
      expect(text).toBe("hello");
      expect(state.vcsPort.calls.length).toBe(0);
      expect(state.workItemStore.all().length).toBe(0);
      expect(state.chatPort.sent[0]?.text).toContain("Applied local change");
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });

  test("low-confidence execution proposal stays conversational", async () => {
    const state = setup(() => ({
      mode: "execution_proposal",
      confidence: 0.5,
      replyText: "I might be able to implement that.",
      plan: {
        intentSummary: "Maybe execute",
        assumptions: [],
        ambiguities: [],
        proposedNextStep: "clarify",
        riskLevel: "MEDIUM",
        sideEffects: ["local_code_changes"],
        requiresApproval: true,
      },
      artifact: {
        path: "changes/maybe.md",
        content: "content",
        summary: "draft",
      },
    }));

    await handleChatMessage(state.deps, inbound("can you maybe change stuff"), {
      executionIntentConfidenceThreshold: 0.75,
    });

    expect(state.workItemStore.all().length).toBe(0);
    expect(state.chatPort.sent[0]?.text).toContain("confirm");
  });

  test("approve publishes PR when pending approval exists", async () => {
    const state = setup((input) => {
      if (input.text === "go ahead") {
        return { mode: "chat_reply", confidence: 0.1, replyText: "noop" };
      }
      return {
        mode: "execution_proposal",
        confidence: 0.9,
        replyText: "I can do this.",
        plan: {
          intentSummary: "Implement",
          assumptions: [],
          ambiguities: [],
          proposedNextStep: "patch",
          riskLevel: "HIGH",
          sideEffects: ["external_publish"],
          requiresApproval: true,
        },
        artifact: {
          path: "changes/x.md",
          content: "x",
          summary: "x",
        },
      };
    });

    await handleChatMessage(state.deps, inbound("please open a pr"));
    await handleChatMessage(state.deps, inbound("go ahead"));

    expect(state.vcsPort.calls.length).toBe(1);
    expect(state.chatPort.sent[1]?.text).toContain("PR published");
  });
});

describe("recovery", () => {
  test("expires pending approvals on recovery", async () => {
    const state = setup(() => ({
      mode: "chat_reply",
      confidence: 0.1,
      replyText: "x",
    }));
    const now = Date.now();
    const workItem: WorkItem = {
      id: "work-1",
      traceId: "trace-1",
      status: "approval_pending",
      summary: "summary",
      createdAt: new Date(now - 1000).toISOString(),
      updatedAt: new Date(now - 1000).toISOString(),
    };
    await state.workItemStore.create(workItem);
    await state.approvalStore.createApproval({
      id: "approval-1",
      workItemId: workItem.id,
      actionType: "publish_pr",
      payloadHash: "hash",
      status: "pending",
      requestedAt: new Date(now - 86_400_000).toISOString(),
      expiresAt: new Date(now - 1).toISOString(),
      consumedAt: null,
      decisionReason: null,
    });

    const result = await recoverInFlightWorkItems({
      approvalStore: state.deps.approvalStore,
      workItemStore: state.deps.workItemStore,
      auditPort: state.deps.auditPort,
    });

    expect(result.expiredApprovals).toBe(1);
    expect(result.cancelledWorkItems).toBe(1);
  });
});
