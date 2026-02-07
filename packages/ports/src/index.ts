import type {
  ApprovalRecord,
  ApprovalRejectReason,
  ApprovalStatus,
  AuditEvent,
  ExecutionPlan,
  ExecutionPlanDraft,
  GenerateInput,
  GenerateResult,
  InboundMessage,
  OutboundMessage,
  PolicyDecision,
  PublishPrInput,
  PublishPrResult,
  WorkItem,
  WorkItemStatus,
} from "@delegate/domain";

export interface WorkItemStore {
  init(): Promise<void>;
  ping(): Promise<void>;
  create(workItem: WorkItem): Promise<void>;
  getById(id: string): Promise<WorkItem | null>;
  updateStatus(
    id: string,
    status: WorkItemStatus,
    updatedAt: string,
  ): Promise<void>;
}

export interface PlanStore {
  createPlan(plan: ExecutionPlan): Promise<void>;
  getPlanByWorkItemId(workItemId: string): Promise<ExecutionPlan | null>;
}

export interface ApprovalStore {
  createApproval(record: ApprovalRecord): Promise<void>;
  getApprovalById(approvalId: string): Promise<ApprovalRecord | null>;
  getLatestApprovalByWorkItemId(
    workItemId: string,
  ): Promise<ApprovalRecord | null>;
  listPendingApprovals(): Promise<ApprovalRecord[]>;
  updateApprovalStatus(
    approvalId: string,
    status: ApprovalStatus,
    consumedAt: string | null,
    decisionReason: string | null,
  ): Promise<void>;
}

export interface AuditPort {
  init(): Promise<void>;
  ping(): Promise<void>;
  append(event: AuditEvent): Promise<void>;
}

export type ChatUpdate = {
  updateId: number;
  message: InboundMessage;
};

export interface ChatPort {
  receiveUpdates(cursor: number | null): Promise<ChatUpdate[]>;
  send(message: OutboundMessage): Promise<void>;
}

export type PlanInput = {
  workItemId: string;
  text: string;
};

export interface ModelPort {
  plan(input: PlanInput): Promise<ExecutionPlanDraft>;
  generate(input: GenerateInput): Promise<GenerateResult>;
}

export interface ArtifactStore {
  saveArtifact(
    workItemId: string,
    artifact: GenerateResult["artifact"],
    createdAt: string,
  ): Promise<void>;
  getArtifactByWorkItemId(
    workItemId: string,
  ): Promise<GenerateResult["artifact"] | null>;
}

export interface PolicyEngine {
  evaluate(plan: ExecutionPlanDraft): Promise<PolicyDecision>;
}

export interface VcsPort {
  publishPr(input: PublishPrInput): Promise<PublishPrResult>;
}

export type ApprovalValidationResult =
  | { ok: true; approval: ApprovalRecord }
  | { ok: false; reason: ApprovalRejectReason };
