import type { AuditEvent, WorkItem } from "@delegate/domain";
import type { AuditPort, WorkItemStore } from "@delegate/ports";
import { Effect } from "effect";

type TracerResult = {
  workItem: WorkItem;
  event: AuditEvent;
};

const nowIso = (): string => new Date().toISOString();

export const runTracer = (deps: {
  workItemStore: WorkItemStore;
  auditPort: AuditPort;
}): Effect.Effect<TracerResult, Error> =>
  Effect.gen(function* () {
    const workItem: WorkItem = {
      id: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      status: "delegated",
      summary: "Synthetic delegated work item for M1 tracer",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const event: AuditEvent = {
      eventId: crypto.randomUUID(),
      eventType: "work_item.delegated",
      workItemId: workItem.id,
      actor: "assistant",
      timestamp: nowIso(),
      traceId: workItem.traceId,
      payload: {
        summary: workItem.summary,
        source: "internal.tracer",
      },
    };

    yield* Effect.tryPromise({
      try: () => deps.workItemStore.create(workItem),
      catch: (cause) =>
        new Error(`Failed to persist synthetic work item: ${String(cause)}`),
    });

    yield* Effect.tryPromise({
      try: () => deps.auditPort.append(event),
      catch: (cause) =>
        new Error(`Failed to append audit event: ${String(cause)}`),
    });

    return { workItem, event };
  });
