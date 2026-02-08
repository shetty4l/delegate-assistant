import { describe, expect, test } from "bun:test";

import { ensureOpencodeServer } from "@assistant-core/src/opencode-server";

describe("ensureOpencodeServer", () => {
  test("does not spawn when transport is already reachable", async () => {
    let spawnCalls = 0;

    const result = await ensureOpencodeServer({
      binaryPath: "opencode",
      attachUrl: "http://127.0.0.1:4096",
      host: "127.0.0.1",
      port: 4096,
      workingDirectory: "/tmp",
      transportPing: async () => {},
      spawnServer: () => {
        spawnCalls += 1;
      },
      waitMs: async () => {},
    });

    expect(result.started).toBeFalse();
    expect(spawnCalls).toBe(0);
  });

  test("spawns and waits until transport is reachable", async () => {
    let spawnCalls = 0;
    let pingCalls = 0;

    const result = await ensureOpencodeServer({
      binaryPath: "opencode",
      attachUrl: "http://127.0.0.1:4096",
      host: "127.0.0.1",
      port: 4096,
      workingDirectory: "/tmp",
      transportPing: async () => {
        pingCalls += 1;
        if (pingCalls < 3) {
          throw new Error("not reachable yet");
        }
      },
      spawnServer: () => {
        spawnCalls += 1;
      },
      waitMs: async () => {},
      startupTimeoutMs: 5_000,
    });

    expect(result.started).toBeTrue();
    expect(spawnCalls).toBe(1);
    expect(pingCalls).toBe(3);
  });

  test("fails with transport-specific timeout error", async () => {
    await expect(
      ensureOpencodeServer({
        binaryPath: "opencode",
        attachUrl: "http://127.0.0.1:4096",
        host: "127.0.0.1",
        port: 4096,
        workingDirectory: "/tmp",
        transportPing: async () => {
          throw new Error("still down");
        },
        spawnServer: () => {},
        waitMs: async () => {},
        startupTimeoutMs: 1,
      }),
    ).rejects.toThrow("reachable OpenCode endpoint");
  });
});
