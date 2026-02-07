import { DeterministicModelStub } from "@delegate/adapters-model-stub";
import { SqliteWorkItemStore } from "@delegate/adapters-sqlite";
import { TelegramLongPollingAdapter } from "@delegate/adapters-telegram";
import { JsonlAuditPort } from "@delegate/audit";
import { Effect } from "effect";

import { loadConfig } from "./config";
import { startHttpServer } from "./http";
import { startTelegramWorker } from "./worker";

const config = loadConfig();

const workItemStore = new SqliteWorkItemStore(config.sqlitePath);
const auditPort = new JsonlAuditPort(config.auditLogPath);
const modelPort = new DeterministicModelStub();

const boot = Effect.gen(function* () {
  yield* Effect.tryPromise({
    try: () => workItemStore.init(),
    catch: (cause) =>
      new Error(`Failed to initialize sqlite: ${String(cause)}`),
  });

  yield* Effect.tryPromise({
    try: () => auditPort.init(),
    catch: (cause) =>
      new Error(`Failed to initialize audit writer: ${String(cause)}`),
  });

  startHttpServer({
    config,
    workItemStore,
    auditPort,
  });

  if (config.telegramBotToken) {
    const telegramPort = new TelegramLongPollingAdapter(
      config.telegramBotToken,
    );
    void startTelegramWorker(
      {
        chatPort: telegramPort,
        modelPort,
        workItemStore,
        planStore: workItemStore,
        auditPort,
      },
      config.telegramPollIntervalMs,
    );
  } else {
    console.log("telegram worker disabled: TELEGRAM_BOT_TOKEN is not set");
  }

  return {
    port: config.port,
    sqlitePath: config.sqlitePath,
    auditLogPath: config.auditLogPath,
    internalRoutesEnabled: config.enableInternalRoutes,
    telegramWorkerEnabled: config.telegramBotToken !== null,
  };
});

const bootResult = await Effect.runPromise(boot);

console.log("assistant-core booted", bootResult);
