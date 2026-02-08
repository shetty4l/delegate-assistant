import { describe, expect, test } from "bun:test";

import {
  classifyWorkerExit,
  reclaimPortFromPriorAssistant,
  startWithPortTakeover,
} from "./main";

describe("startWithPortTakeover", () => {
  test("returns immediately when first bind succeeds", async () => {
    let reclaimCalls = 0;
    let startCalls = 0;

    const result = await startWithPortTakeover({
      port: 3000,
      start: () => {
        startCalls += 1;
        return "server";
      },
      reclaim: async () => {
        reclaimCalls += 1;
        return { ok: true, pids: [111], forcedPids: [] };
      },
    });

    expect(result).toBe("server");
    expect(startCalls).toBe(1);
    expect(reclaimCalls).toBe(0);
  });

  test("reclaims port and retries once on EADDRINUSE", async () => {
    let startCalls = 0;
    let reclaimCalls = 0;

    const result = await startWithPortTakeover({
      port: 3000,
      start: () => {
        startCalls += 1;
        if (startCalls === 1) {
          throw { code: "EADDRINUSE" };
        }
        return "server";
      },
      reclaim: async () => {
        reclaimCalls += 1;
        return { ok: true, pids: [111], forcedPids: [111] };
      },
    });

    expect(result).toBe("server");
    expect(startCalls).toBe(2);
    expect(reclaimCalls).toBe(1);
  });

  test("does not reclaim on non-EADDRINUSE startup error", async () => {
    let reclaimCalls = 0;

    await expect(
      startWithPortTakeover({
        port: 3000,
        start: () => {
          throw new Error("boom");
        },
        reclaim: async () => {
          reclaimCalls += 1;
          return { ok: true, pids: [111], forcedPids: [] };
        },
      }),
    ).rejects.toThrow("boom");

    expect(reclaimCalls).toBe(0);
  });

  test("fails when reclaim cannot free the port", async () => {
    await expect(
      startWithPortTakeover({
        port: 3000,
        start: () => {
          throw { code: "EADDRINUSE" };
        },
        reclaim: async () => ({ ok: false, pids: [111], forcedPids: [111] }),
      }),
    ).rejects.toThrow("Failed to reclaim busy port 3000");
  });
});

describe("reclaimPortFromPriorAssistant", () => {
  test("sends SIGKILL when pid survives SIGTERM", async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await reclaimPortFromPriorAssistant(3000, {
      findListeningPids: () => [42],
      signalPid: (pid, signal) => {
        signals.push({ pid, signal });
      },
      isAlive: () => {
        return !signals.some((entry) => entry.signal === "SIGKILL");
      },
      wait: async () => {},
      currentPid: 999,
    });

    expect(result.ok).toBeTrue();
    expect(result.pids).toEqual([42]);
    expect(result.forcedPids).toEqual([42]);
    expect(signals).toEqual([
      { pid: 42, signal: "SIGTERM" },
      { pid: 42, signal: "SIGKILL" },
    ]);
  });

  test("returns not-ok when no listener pid is found", async () => {
    const result = await reclaimPortFromPriorAssistant(3000, {
      findListeningPids: () => [],
      signalPid: () => {},
      isAlive: () => false,
      wait: async () => {},
      currentPid: 999,
    });

    expect(result).toEqual({ ok: false, pids: [], forcedPids: [] });
  });
});

describe("classifyWorkerExit", () => {
  test("classifies restart code", () => {
    expect(classifyWorkerExit(75)).toBe("requested_restart");
  });

  test("classifies zero as clean stop", () => {
    expect(classifyWorkerExit(0)).toBe("clean_stop");
  });

  test("classifies non-zero non-restart as unexpected", () => {
    expect(classifyWorkerExit(1)).toBe("unexpected_exit");
  });
});
