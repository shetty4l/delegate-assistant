export type WorkItemStatus = "delegated" | "triaged" | "cancelled";

export type WorkItem = {
  id: string;
  traceId: string;
  status: WorkItemStatus;
  summary: string;
  createdAt: string;
  updatedAt: string;
};

export type AuditEventType = "work_item.delegated";

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
  delegated: new Set(["triaged", "cancelled"]),
  triaged: new Set(["cancelled"]),
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
