import type { ModelPort } from "@delegate/ports";
import type { AppConfig } from "./config";

type Deps = {
  config: AppConfig;
  sessionStore: { ping(): Promise<void> };
  modelPort: ModelPort;
};

const json = (payload: unknown, status = 200): Response =>
  Response.json(payload, { status });

export const startHttpServer = ({
  config,
  sessionStore,
  modelPort,
}: Deps): void => {
  Bun.serve({
    port: config.port,
    fetch: async (request: Request) => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, status: "alive" });
      }

      if (request.method === "GET" && url.pathname === "/ready") {
        const checks = await runReadinessChecks({ sessionStore, modelPort });
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

      return json({ ok: false, error: "not_found" }, 404);
    },
  });
};

const runReadinessChecks = async ({
  sessionStore,
  modelPort,
}: {
  sessionStore: { ping(): Promise<void> };
  modelPort: ModelPort;
}): Promise<{ ok: true } | { ok: false; reasons: string[] }> => {
  const reasons: string[] = [];

  try {
    await sessionStore.ping();
  } catch {
    reasons.push("session_store_unreachable");
  }

  if (modelPort.ping) {
    try {
      await modelPort.ping();
    } catch {
      reasons.push("opencode_unavailable");
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  return { ok: true };
};
