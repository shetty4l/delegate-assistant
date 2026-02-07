import { describe, expect, test } from "bun:test";

import type { AppConfig } from "./config";
import { runReadinessChecks } from "./http";

const baseConfig = (): AppConfig => ({
  configSourcePath: "/tmp/config.json",
  envOverridesApplied: 0,
  port: 3000,
  sqlitePath: "/tmp/assistant.db",
  telegramBotToken: null,
  telegramPollIntervalMs: 2_000,
  modelProvider: "opencode_cli",
  opencodeBin: "opencode",
  modelName: "openai/gpt-5.3-codex",
  assistantRepoPath: "/tmp",
  opencodeAttachUrl: "http://127.0.0.1:4096",
  opencodeAutoStart: true,
  opencodeServeHost: "127.0.0.1",
  opencodeServePort: 4096,
  sessionIdleTimeoutMs: 45 * 60 * 1000,
  sessionMaxConcurrent: 5,
  sessionRetryAttempts: 1,
  relayTimeoutMs: 5 * 60 * 1000,
  progressFirstMs: 10_000,
  progressEveryMs: 30_000,
  progressMaxCount: 3,
});

describe("runReadinessChecks", () => {
  test("reports opencode_unreachable when transport probe fails", async () => {
    let modelPingCalls = 0;

    const checks = await runReadinessChecks({
      config: baseConfig(),
      sessionStore: { ping: async () => {} },
      modelPort: {
        respond: async () => ({ replyText: "unused" }),
        ping: async () => {
          modelPingCalls += 1;
        },
      },
      opencodeProbe: async () => {
        throw new Error("down");
      },
    });

    expect(checks.ok).toBeFalse();
    if (!checks.ok) {
      expect(checks.reasons).toEqual(["opencode_unreachable"]);
    }
    expect(modelPingCalls).toBe(0);
  });

  test("reports opencode_model_unavailable when transport is reachable", async () => {
    const checks = await runReadinessChecks({
      config: baseConfig(),
      sessionStore: { ping: async () => {} },
      modelPort: {
        respond: async () => ({ replyText: "unused" }),
        ping: async () => {
          throw new Error("model turn failed");
        },
      },
      opencodeProbe: async () => {},
    });

    expect(checks.ok).toBeFalse();
    if (!checks.ok) {
      expect(checks.reasons).toEqual(["opencode_model_unavailable"]);
    }
  });

  test("includes session store reason independently", async () => {
    const checks = await runReadinessChecks({
      config: baseConfig(),
      sessionStore: {
        ping: async () => {
          throw new Error("sqlite down");
        },
      },
      modelPort: {
        respond: async () => ({ replyText: "unused" }),
        ping: async () => {},
      },
      opencodeProbe: async () => {
        throw new Error("attach down");
      },
    });

    expect(checks.ok).toBeFalse();
    if (!checks.ok) {
      expect(checks.reasons).toEqual([
        "session_store_unreachable",
        "opencode_unreachable",
      ]);
    }
  });
});
