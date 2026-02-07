import { homedir } from "node:os";
import { join } from "node:path";

export type AppConfig = {
  port: number;
  nodeEnv: string;
  enableInternalRoutes: boolean;
  sqlitePath: string;
  auditLogPath: string;
};

const defaultSqlitePath = "~/.local/share/delegate-assistant/data/assistant.db";
const defaultAuditPath = "~/.local/share/delegate-assistant/audit/events.jsonl";

const expandHome = (inputPath: string): string => {
  if (inputPath === "~") {
    return homedir();
  }
  if (inputPath.startsWith("~/")) {
    return join(homedir(), inputPath.slice(2));
  }
  return inputPath;
};

export const loadConfig = (): AppConfig => {
  const port = Number(process.env.PORT ?? "3000");

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }

  const nodeEnv = process.env.NODE_ENV ?? "development";
  const enableInternalRoutes =
    process.env.ENABLE_INTERNAL_ROUTES === "true" || nodeEnv === "development";

  return {
    port,
    nodeEnv,
    enableInternalRoutes,
    sqlitePath: expandHome(process.env.SQLITE_PATH ?? defaultSqlitePath),
    auditLogPath: expandHome(process.env.AUDIT_LOG_PATH ?? defaultAuditPath),
  };
};
