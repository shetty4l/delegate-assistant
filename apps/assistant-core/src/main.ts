import { SqliteWorkItemStore } from "@delegate/adapters-sqlite";
import { JsonlAuditPort } from "@delegate/audit";
import { Effect } from "effect";

import { loadConfig } from "./config";
import { startHttpServer } from "./http";

const config = loadConfig();

const workItemStore = new SqliteWorkItemStore(config.sqlitePath);
const auditPort = new JsonlAuditPort(config.auditLogPath);

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

  return {
    port: config.port,
    sqlitePath: config.sqlitePath,
    auditLogPath: config.auditLogPath,
    internalRoutesEnabled: config.enableInternalRoutes,
  };
});

const bootResult = await Effect.runPromise(boot);

console.log("assistant-core booted", bootResult);
