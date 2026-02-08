import type { AppConfig } from "@assistant-core/src/config";
import { probeOpencodeReachability } from "@assistant-core/src/opencode-server";
import type { BuildInfo } from "@assistant-core/src/version";
import type { ModelPort } from "@delegate/ports";

type Deps = {
  config: AppConfig;
  sessionStore: { ping(): Promise<void> };
  modelPort: ModelPort;
  buildInfo: BuildInfo;
};

const json = (payload: unknown, status = 200): Response =>
  Response.json(payload, { status });

export const startHttpServer = ({
  config,
  sessionStore,
  modelPort,
  buildInfo,
}: Deps): Bun.Server<unknown> => {
  return Bun.serve({
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

      if (request.method === "GET" && url.pathname === "/version") {
        return json({
          ok: true,
          service: buildInfo.service,
          version: buildInfo.releaseVersion,
          displayVersion: buildInfo.displayVersion,
          gitSha: buildInfo.gitSha,
          gitShortSha: buildInfo.gitShortSha,
          gitBranch: buildInfo.gitBranch,
          commitTitle: buildInfo.commitTitle,
          buildTimeUtc: buildInfo.buildTimeUtc,
          runtime: buildInfo.runtime,
        });
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
