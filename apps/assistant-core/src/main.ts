import { OpencodeCliModelAdapter } from "@delegate/adapters-model-opencode-cli";
import { DeterministicModelStub } from "@delegate/adapters-model-stub";
import { TelegramLongPollingAdapter } from "@delegate/adapters-telegram";

import { loadConfig } from "./config";
import { startHttpServer } from "./http";
import { ensureOpencodeServer } from "./opencode-server";
import { SqliteSessionStore } from "./session-store";
import { startTelegramWorker } from "./worker";

const config = loadConfig();

const sessionStore = new SqliteSessionStore(config.sqlitePath);
const modelPort =
  config.modelProvider === "opencode_cli"
    ? new OpencodeCliModelAdapter({
        binaryPath: config.opencodeBin,
        model: config.modelName,
        repoPath: config.assistantRepoPath,
        attachUrl: config.opencodeAttachUrl,
      })
    : new DeterministicModelStub();

const boot = async () => {
  try {
    await sessionStore.init();
  } catch (cause) {
    throw new Error(`Failed to initialize session store: ${String(cause)}`);
  }

  if (config.modelProvider === "opencode_cli" && config.opencodeAutoStart) {
    try {
      await ensureOpencodeServer({
        binaryPath: config.opencodeBin,
        attachUrl: config.opencodeAttachUrl,
        host: config.opencodeServeHost,
        port: config.opencodeServePort,
        workingDirectory: config.assistantRepoPath,
        modelPing: async () => {
          if (!modelPort.ping) {
            return;
          }
          await modelPort.ping();
        },
      });
    } catch (cause) {
      throw new Error(`Failed to ensure opencode server: ${String(cause)}`);
    }
  }

  startHttpServer({ config, sessionStore, modelPort });

  if (config.telegramBotToken) {
    const telegramPort = new TelegramLongPollingAdapter(
      config.telegramBotToken,
    );
    void startTelegramWorker(
      { chatPort: telegramPort, modelPort, sessionStore },
      config.telegramPollIntervalMs,
      {
        sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
        sessionMaxConcurrent: config.sessionMaxConcurrent,
        sessionRetryAttempts: config.sessionRetryAttempts,
      },
    );
  } else {
    console.log("telegram worker disabled: TELEGRAM_BOT_TOKEN is not set");
  }

  return {
    configSourcePath: config.configSourcePath,
    envOverridesApplied: config.envOverridesApplied,
    port: config.port,
    sqlitePath: config.sqlitePath,
    telegramWorkerEnabled: config.telegramBotToken !== null,
    modelProvider: config.modelProvider,
    assistantRepoPath: config.assistantRepoPath,
    opencodeAttachUrl: config.opencodeAttachUrl,
    opencodeAutoStart: config.opencodeAutoStart,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
    sessionMaxConcurrent: config.sessionMaxConcurrent,
    sessionRetryAttempts: config.sessionRetryAttempts,
  };
};

const bootResult = await boot();

console.log("assistant-core booted", bootResult);
