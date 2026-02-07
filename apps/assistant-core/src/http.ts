import type { AuditPort, WorkItemStore } from "@delegate/ports";
import { Effect } from "effect";
import type { AppConfig } from "./config";
import { runTracer } from "./runtime";

type Deps = {
  config: AppConfig;
  workItemStore: WorkItemStore;
  auditPort: AuditPort;
};

const json = (payload: unknown, status = 200): Response =>
  Response.json(payload, { status });

export const startHttpServer = ({
  config,
  workItemStore,
  auditPort,
}: Deps): void => {
  Bun.serve({
    port: config.port,
    fetch: async (request: Request) => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, status: "alive" });
      }

      if (request.method === "GET" && url.pathname === "/ready") {
        const checks = await runReadinessChecks({ workItemStore, auditPort });
        if (checks.ok) {
          return json({ ok: true, status: "ready" });
        }
        return json(
          {
            ok: false,
            status: "not_ready",
            reasons: checks.reasons,
          },
          503,
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/internal/tracer" &&
        config.enableInternalRoutes
      ) {
        try {
          const result = await Effect.runPromise(
            runTracer({ workItemStore, auditPort }),
          );

          return json(
            {
              ok: true,
              workItemId: result.workItem.id,
              traceId: result.workItem.traceId,
              eventId: result.event.eventId,
            },
            201,
          );
        } catch {
          return json(
            {
              ok: false,
              error: "tracer_failed",
            },
            500,
          );
        }
      }

      return json({ ok: false, error: "not_found" }, 404);
    },
  });
};

const runReadinessChecks = async ({
  workItemStore,
  auditPort,
}: {
  workItemStore: WorkItemStore;
  auditPort: AuditPort;
}): Promise<{ ok: true } | { ok: false; reasons: string[] }> => {
  const reasons: string[] = [];

  try {
    await workItemStore.ping();
  } catch {
    reasons.push("db_unreachable");
  }

  try {
    await auditPort.ping();
  } catch {
    reasons.push("audit_unwritable");
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  return { ok: true };
};
