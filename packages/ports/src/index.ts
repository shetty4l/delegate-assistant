import type {
  AuditEvent,
  ExecutionPlan,
  ExecutionPlanDraft,
  InboundMessage,
  OutboundMessage,
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
}
