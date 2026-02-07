import type { AuditEvent, WorkItem } from "@delegate/domain";

export interface WorkItemStore {
  init(): Promise<void>;
  ping(): Promise<void>;
  create(workItem: WorkItem): Promise<void>;
  getById(id: string): Promise<WorkItem | null>;
}

export interface AuditPort {
  init(): Promise<void>;
  ping(): Promise<void>;
  append(event: AuditEvent): Promise<void>;
}
