import type { ModelPort } from "@delegate/ports";
import type { AppConfig } from "./config";
import { probeOpencodeReachability } from "./opencode-server";

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
        const checks = await runReadinessChecks({
          config,
          sessionStore,
          modelPort,
        });
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

export const runReadinessChecks = async ({
  config,
  sessionStore,
  modelPort,
  opencodeProbe,
}: {
  config: AppConfig;
  sessionStore: { ping(): Promise<void> };
  modelPort: ModelPort;
  opencodeProbe?: (attachUrl: string) => Promise<void>;
}): Promise<{ ok: true } | { ok: false; reasons: string[] }> => {
  const reasons: string[] = [];
  const probe = opencodeProbe ?? probeOpencodeReachability;

  try {
    await sessionStore.ping();
  } catch {
    reasons.push("session_store_unreachable");
  }

  if (config.modelProvider === "opencode_cli") {
    try {
      await probe(config.opencodeAttachUrl);
    } catch {
      reasons.push("opencode_unreachable");
    }

    if (reasons.includes("opencode_unreachable")) {
      return { ok: false, reasons };
    }

    if (modelPort.ping) {
      try {
        await modelPort.ping();
      } catch {
        reasons.push("opencode_model_unavailable");
      }
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  return { ok: true };
};
