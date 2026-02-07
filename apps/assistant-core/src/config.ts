import { homedir } from "node:os";
import { join } from "node:path";

export type AppConfig = {
  port: number;
  nodeEnv: string;
  enableInternalRoutes: boolean;
  sqlitePath: string;
  auditLogPath: string;
  telegramBotToken: string | null;
  telegramPollIntervalMs: number;
  modelProvider: "stub" | "opencode_cli";
  opencodeBin: string;
  modelName: string;
  assistantRepoPath: string;
  githubBaseBranch: string | null;
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
  const telegramPollIntervalMs = Number(
    process.env.TELEGRAM_POLL_INTERVAL_MS ?? "2000",
  );

  if (
    !Number.isInteger(telegramPollIntervalMs) ||
    telegramPollIntervalMs <= 0
  ) {
    throw new Error("TELEGRAM_POLL_INTERVAL_MS must be a positive integer");
  }

  const enableInternalRoutes =
    process.env.ENABLE_INTERNAL_ROUTES === "true" || nodeEnv === "development";
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
  const modelProviderRaw = process.env.MODEL_PROVIDER?.trim() || "stub";
  const modelProvider =
    modelProviderRaw === "opencode_cli" ? "opencode_cli" : "stub";

  return {
    port,
    nodeEnv,
    enableInternalRoutes,
    sqlitePath: expandHome(process.env.SQLITE_PATH ?? defaultSqlitePath),
    auditLogPath: expandHome(process.env.AUDIT_LOG_PATH ?? defaultAuditPath),
    telegramBotToken,
    telegramPollIntervalMs,
    modelProvider,
    opencodeBin: process.env.OPENCODE_BIN?.trim() || "opencode",
    modelName: process.env.MODEL_NAME?.trim() || "openai/gpt-5.3-codex",
    assistantRepoPath: expandHome(
      process.env.ASSISTANT_REPO_PATH ?? process.cwd(),
    ),
    githubBaseBranch: process.env.GITHUB_BASE_BRANCH?.trim() || null,
  };
};
