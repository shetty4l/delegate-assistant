export type WorkItemStatus =
  | "delegated"
  | "triaged"
  | "approval_pending"
  | "approved"
  | "denied"
  | "cancelled";

export type WorkItem = {
  id: string;
  traceId: string;
  status: WorkItemStatus;
  summary: string;
  createdAt: string;
  updatedAt: string;
};

export type PlanRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type PlanSideEffectType =
  | "none"
  | "local_code_changes"
  | "external_publish";

export type ExecutionPlanDraft = {
  intentSummary: string;
  assumptions: string[];
  ambiguities: string[];
  proposedNextStep: string;
  riskLevel: PlanRiskLevel;
  sideEffects: PlanSideEffectType[];
  requiresApproval: boolean;
};

export type ExecutionPlan = {
  id: string;
  workItemId: string;
  createdAt: string;
} & ExecutionPlanDraft;

export type PolicyDecisionType = "allow" | "deny" | "requires_approval";

export type PolicyReasonCode =
  | "LOW_RISK_ALLOWED"
  | "MISSING_APPROVAL"
  | "GUARDRAIL_PROTECTED_PATH"
  | "DENIED_PREVIOUSLY"
  | "INSUFFICIENT_SCOPE";

export type PolicyDecision = {
  decision: PolicyDecisionType;
  reasonCode: PolicyReasonCode;
};

export type ApprovalActionType = "publish_pr";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type ApprovalRecord = {
  id: string;
  workItemId: string;
  actionType: ApprovalActionType;
  payloadHash: string;
  status: ApprovalStatus;
  requestedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  decisionReason: string | null;
};

export type ApprovalRejectReason =
  | "NOT_FOUND"
  | "EXPIRED"
  | "REPLAYED"
  | "MISMATCH"
  | "ALREADY_DENIED";

export type InboundMessage = {
  chatId: string;
  text: string;
  receivedAt: string;
  sourceMessageId?: string;
};

export type OutboundMessage = {
  chatId: string;
  text: string;
};

export type AuditEventType =
  | "work_item.delegated"
  | "work_item.triaged"
  | "plan.created"
  | "approval.requested"
  | "approval.granted"
  | "approval.denied"
  | "approval.rejected";

export type AuditEvent = {
  eventId: string;
  eventType: AuditEventType;
  workItemId: string;
  actor: "assistant" | "system" | "user";
  timestamp: string;
  traceId: string;
  payload: Record<string, unknown>;
};

const allowedTransitions: Record<
  WorkItemStatus,
  ReadonlySet<WorkItemStatus>
> = {
  delegated: new Set(["triaged", "approval_pending", "cancelled"]),
  triaged: new Set(["approval_pending", "approved", "cancelled"]),
  approval_pending: new Set(["approved", "denied", "cancelled"]),
  approved: new Set(["cancelled"]),
  denied: new Set(["cancelled"]),
  cancelled: new Set([]),
};

export type TransitionResult =
  | { ok: true; next: WorkItemStatus }
  | { ok: false; reason: "INVALID_TRANSITION" | "NO_OP" };

export const transitionStatus = (
  current: WorkItemStatus,
  next: WorkItemStatus,
): TransitionResult => {
  if (current === next) {
    return { ok: false, reason: "NO_OP" };
  }

  if (!allowedTransitions[current].has(next)) {
    return { ok: false, reason: "INVALID_TRANSITION" };
  }

  return { ok: true, next };
};
