import { OpencodeCliModelAdapter } from "@delegate/adapters-model-opencode-cli";
import { DeterministicModelStub } from "@delegate/adapters-model-stub";
import { TelegramLongPollingAdapter } from "@delegate/adapters-telegram";

import { loadConfig } from "./config";
import { startHttpServer } from "./http";
import {
  ensureOpencodeServer,
  probeOpencodeReachability,
} from "./opencode-server";
import { SqliteSessionStore } from "./session-store";
import { formatVersionFingerprint, loadBuildInfo } from "./version";
import { startTelegramWorker } from "./worker";

const RESTART_EXIT_CODE = 75;
const WORKER_ROLE = "worker";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

  const server = startHttpServer({
    config,
    sessionStore,
    modelPort,
    buildInfo,
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

    if (code === RESTART_EXIT_CODE) {
      console.log("worker exited for requested restart; starting new worker");
      continue;
    }

    console.error(
      `worker exited unexpectedly with code ${String(code)}; restarting`,
    );
    await sleep(750);
  }

  await stopChild();
  return 0;
};

const isWorkerRole = process.env.ASSISTANT_PROCESS_ROLE === WORKER_ROLE;
const exitCode = isWorkerRole
  ? await runWorkerProcess()
  : await runSupervisor();
process.exit(exitCode);
