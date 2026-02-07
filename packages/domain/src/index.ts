export type InboundMessage = {
  chatId: string;
  threadId?: string | null;
  text: string;
  receivedAt: string;
  sourceMessageId?: string;
};

export type OutboundMessage = {
  chatId: string;
  threadId?: string | null;
  text: string;
};

export type ModelTurnResponse = {
  replyText: string;
  sessionId?: string;
  mode?: "chat_reply" | "execution_proposal";
  confidence?: number;
};

export type WorkItemStatus =
  | "delegated"
  | "triaged"
  | "approval_pending"
  | "approved"
  | "denied"
  | "cancelled";

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
