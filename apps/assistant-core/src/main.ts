import { loadConfig } from "@assistant-core/src/config";
import { startHttpServer } from "@assistant-core/src/http";
import {
  ensureOpencodeServer,
  probeOpencodeReachability,
} from "@assistant-core/src/opencode-server";
import { SqliteSessionStore } from "@assistant-core/src/session-store";
import { sleep } from "@assistant-core/src/timers";
import {
  formatVersionFingerprint,
  loadBuildInfo,
} from "@assistant-core/src/version";
import { startTelegramWorker } from "@assistant-core/src/worker";
import { OpencodeCliModelAdapter } from "@delegate/adapters-model-opencode-cli";
import { PiAgentModelAdapter } from "@delegate/adapters-model-pi-agent";
import { DeterministicModelStub } from "@delegate/adapters-model-stub";
import { TelegramLongPollingAdapter } from "@delegate/adapters-telegram";

const RESTART_EXIT_CODE = 75;
const WORKER_ROLE = "worker";
const PORT_RECLAIM_TERM_TIMEOUT_MS = 4_000;
const PORT_RECLAIM_KILL_TIMEOUT_MS = 1_500;
const PORT_RECLAIM_POLL_INTERVAL_MS = 100;

const isAddressInUseError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }

  return (error as { code?: unknown }).code === "EADDRINUSE";
};

const parsePidList = (raw: string): number[] => {
  const unique = new Set<number>();
  for (const line of raw.split("\n")) {
    const parsed = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      unique.add(parsed);
    }
  }
  return [...unique];
};

type ReclaimPortDeps = {
  findListeningPids: (port: number) => number[];
  signalPid: (pid: number, signal: NodeJS.Signals) => void;
  isAlive: (pid: number) => boolean;
  wait: (ms: number) => Promise<void>;
  currentPid: number;
};

const defaultReclaimPortDeps = (): ReclaimPortDeps => ({
  findListeningPids: (port: number) => {
    const result = Bun.spawnSync({
      cmd: ["lsof", "-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-t"],
      stdout: "pipe",
      stderr: "pipe",
    });

    if (result.exitCode !== 0) {
      return [];
    }

    return parsePidList(new TextDecoder().decode(result.stdout));
  },
  signalPid: (pid: number, signal: NodeJS.Signals) => {
    process.kill(pid, signal);
  },
  isAlive: (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  wait: sleep,
  currentPid: process.pid,
});

const waitForPidsToExit = async (
  pids: number[],
  timeoutMs: number,
  deps: Pick<ReclaimPortDeps, "isAlive" | "wait">,
): Promise<number[]> => {
  const startedAt = Date.now();
  let pending = pids.filter((pid) => deps.isAlive(pid));

  while (pending.length > 0 && Date.now() - startedAt < timeoutMs) {
    await deps.wait(PORT_RECLAIM_POLL_INTERVAL_MS);
    pending = pending.filter((pid) => deps.isAlive(pid));
  }

  return pending;
};

export const reclaimPortFromPriorAssistant = async (
  port: number,
  deps: ReclaimPortDeps = defaultReclaimPortDeps(),
): Promise<{ ok: boolean; pids: number[]; forcedPids: number[] }> => {
  const listeningPids = deps
    .findListeningPids(port)
    .filter((pid) => pid !== deps.currentPid);

  if (listeningPids.length === 0) {
    return { ok: false, pids: [], forcedPids: [] };
  }

  for (const pid of listeningPids) {
    try {
      deps.signalPid(pid, "SIGTERM");
    } catch {
      // process already gone or no permission; verify later via isAlive
    }
  }

  let survivors = await waitForPidsToExit(
    listeningPids,
    PORT_RECLAIM_TERM_TIMEOUT_MS,
    deps,
  );
  const forcedPids: number[] = [];

  if (survivors.length > 0) {
    for (const pid of survivors) {
      try {
        deps.signalPid(pid, "SIGKILL");
        forcedPids.push(pid);
      } catch {
        // process already gone or no permission; verify later via isAlive
      }
    }

    survivors = await waitForPidsToExit(
      survivors,
      PORT_RECLAIM_KILL_TIMEOUT_MS,
      deps,
    );
  }

  return {
    ok: survivors.length === 0,
    pids: listeningPids,
    forcedPids,
  };
};

export const startWithPortTakeover = async <T>({
  port,
  start,
  reclaim,
}: {
  port: number;
  start: () => T;
  reclaim: (
    port: number,
  ) => Promise<{ ok: boolean; pids: number[]; forcedPids: number[] }>;
}): Promise<T> => {
  try {
    return start();
  } catch (error) {
    if (!isAddressInUseError(error)) {
      throw error;
    }

    console.warn(
      JSON.stringify({
        level: "warn",
        event: "runtime.port_reclaim_start",
        port,
      }),
    );

    const reclaimResult = await reclaim(port);
    if (!reclaimResult.ok) {
      throw new Error(
        `Failed to reclaim busy port ${String(port)}. Listener pids: ${reclaimResult.pids.join(", ") || "none"}`,
        { cause: error },
      );
    }

    console.warn(
      JSON.stringify({
        level: "warn",
        event: "runtime.port_reclaim_complete",
        port,
        pids: reclaimResult.pids,
        forcedPids: reclaimResult.forcedPids,
      }),
    );

    try {
      return start();
    } catch (retryError) {
      throw new Error(
        `Failed to start server on port ${String(port)} after reclaim attempt`,
        { cause: retryError },
      );
    }
  }
};

export const classifyWorkerExit = (
  code: number,
): "requested_restart" | "clean_stop" | "unexpected_exit" => {
  if (code === RESTART_EXIT_CODE) {
    return "requested_restart";
  }

  if (code === 0) {
    return "clean_stop";
  }

  return "unexpected_exit";
};

const runWorkerProcess = async (): Promise<number> => {
  const config = loadConfig();
  const buildInfo = loadBuildInfo();
  const sessionStore = new SqliteSessionStore(config.sqlitePath);
  const modelPort =
    config.modelProvider === "opencode_cli"
      ? new OpencodeCliModelAdapter({
          binaryPath: config.opencodeBin,
          model: config.modelName,
          repoPath: config.assistantRepoPath,
          attachUrl: config.opencodeAttachUrl,
          responseTimeoutMs: config.relayTimeoutMs,
        })
      : config.modelProvider === "pi_agent"
        ? new PiAgentModelAdapter({
            provider: config.piAgentProvider,
            model: config.piAgentModel,
            apiKey: config.piAgentApiKey ?? undefined,
            maxSteps: config.piAgentMaxSteps,
            workspacePath: config.assistantRepoPath,
            systemPromptPath: config.systemPromptPath ?? undefined,
            gitIdentity: process.env.GIT_AUTHOR_NAME,
            enableShellTool: config.piAgentEnableShellTool,
            enableWebFetchTool: config.piAgentEnableWebFetchTool,
            enableWebSearchTool: config.piAgentEnableWebSearchTool,
            webFetchProvider: config.piAgentWebFetchProvider ?? undefined,
            webFetchModel: config.piAgentWebFetchModel ?? undefined,
          })
        : new DeterministicModelStub();

  await sessionStore.init();

  if (config.modelProvider === "opencode_cli" && config.opencodeAutoStart) {
    await ensureOpencodeServer({
      binaryPath: config.opencodeBin,
      attachUrl: config.opencodeAttachUrl,
      host: config.opencodeServeHost,
      port: config.opencodeServePort,
      workingDirectory: config.assistantRepoPath,
      transportPing: async () =>
        probeOpencodeReachability(config.opencodeAttachUrl),
    });
  }

  const server = await startWithPortTakeover({
    port: config.port,
    start: () =>
      startHttpServer({
        config,
        sessionStore,
        modelPort,
        buildInfo,
      }),
    reclaim: reclaimPortFromPriorAssistant,
  });
  const stopController = new AbortController();
  let restartRequested = false;
  let stopping = false;
  let stopResolved = false;
  let resolveStop: (() => void) | null = null;
  const stopPromise = new Promise<void>((resolve) => {
    resolveStop = () => {
      if (stopResolved) {
        return;
      }
      stopResolved = true;
      resolve();
    };
  });

  const requestStop = (reason: string, shouldRestart: boolean): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    restartRequested = shouldRestart;
    stopController.abort();
    resolveStop?.();
    console.log(
      JSON.stringify({
        level: "info",
        event: "runtime.stop_requested",
        reason,
        shouldRestart,
      }),
    );
  };

  process.on("SIGINT", () => requestStop("sigint", false));
  process.on("SIGTERM", () => requestStop("sigterm", false));

  const telegramWorkerPromise = config.telegramBotToken
    ? startTelegramWorker(
        {
          chatPort: new TelegramLongPollingAdapter(config.telegramBotToken),
          modelPort,
          sessionStore,
        },
        config.telegramPollIntervalMs,
        {
          sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
          sessionMaxConcurrent: config.sessionMaxConcurrent,
          sessionRetryAttempts: config.sessionRetryAttempts,
          relayTimeoutMs: config.relayTimeoutMs,
          progressFirstMs: config.progressFirstMs,
          progressEveryMs: config.progressEveryMs,
          progressMaxCount: config.progressMaxCount,
          defaultWorkspacePath: config.assistantRepoPath,
          stopSignal: stopController.signal,
          buildInfo,
          startupAnnounceChatId: config.startupAnnounceChatId,
          startupAnnounceThreadId: config.startupAnnounceThreadId,
          onRestartRequested: async () => {
            requestStop("chat_restart", true);
          },
        },
      )
    : null;

  console.log("assistant worker booted", {
    configSourcePath: config.configSourcePath,
    envOverridesApplied: config.envOverridesApplied,
    port: config.port,
    sqlitePath: config.sqlitePath,
    telegramWorkerEnabled: config.telegramBotToken !== null,
    modelProvider: config.modelProvider,
    assistantRepoPath: config.assistantRepoPath,
    opencodeAttachUrl: config.opencodeAttachUrl,
    opencodeAutoStart: config.opencodeAutoStart,
    version: buildInfo.releaseVersion,
    displayVersion: buildInfo.displayVersion,
    gitSha: buildInfo.gitSha,
    gitBranch: buildInfo.gitBranch,
    buildTimeUtc: buildInfo.buildTimeUtc,
  });
  console.log(`build fingerprint: ${formatVersionFingerprint(buildInfo)}`);

  if (telegramWorkerPromise) {
    await Promise.race([telegramWorkerPromise, stopPromise]);
  } else {
    console.log("telegram worker disabled: TELEGRAM_BOT_TOKEN is not set");
    await stopPromise;
  }

  try {
    server.stop(true);
  } catch {
    // ignore stop failures on shutdown
  }

  return restartRequested ? RESTART_EXIT_CODE : 0;
};

const runSupervisor = async (): Promise<number> => {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error("Unable to resolve runtime script path for supervisor");
  }

  let stopping = false;
  let activeChild: Bun.Subprocess | null = null;

  const stopChild = async (): Promise<void> => {
    if (!activeChild) {
      return;
    }

    try {
      activeChild.kill("SIGTERM");
    } catch {
      // child may already be gone
    }

    const timedOut = await Promise.race([
      activeChild.exited.then(() => false),
      sleep(5_000).then(() => true),
    ]);

    if (timedOut) {
      try {
        activeChild.kill("SIGKILL");
      } catch {
        // ignore hard kill failures
      }
      await activeChild.exited;
    }
  };

  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  while (!stopping) {
    activeChild = Bun.spawn({
      cmd: [process.execPath, scriptPath],
      env: {
        ...process.env,
        ASSISTANT_PROCESS_ROLE: WORKER_ROLE,
      },
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });

    const code = await activeChild.exited;
    if (stopping) {
      break;
    }

    const exitKind = classifyWorkerExit(code);
    if (exitKind === "requested_restart") {
      console.log("worker exited for requested restart; starting new worker");
      continue;
    }

    if (exitKind === "clean_stop") {
      console.log("worker exited cleanly; supervisor stopping");
      break;
    }

    console.error(
      `worker exited unexpectedly with code ${String(code)}; restarting`,
    );
    await sleep(750);
  }

  await stopChild();
  return 0;
};

export const runEntrypoint = async (): Promise<number> => {
  const isWorkerRole = process.env.ASSISTANT_PROCESS_ROLE === WORKER_ROLE;
  return isWorkerRole ? runWorkerProcess() : runSupervisor();
};

if (import.meta.main) {
  const exitCode = await runEntrypoint();
  process.exit(exitCode);
}
