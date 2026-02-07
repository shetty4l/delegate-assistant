import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AppConfig = {
  configSourcePath: string;
  envOverridesApplied: number;
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
  executionIntentConfidenceThreshold: number;
  previewDiffFirst: boolean;
};

type RawConfigFile = {
  port?: number;
  nodeEnv?: string;
  enableInternalRoutes?: boolean;
  sqlitePath?: string;
  auditLogPath?: string;
  telegramBotToken?: string | null;
  telegramPollIntervalMs?: number;
  modelProvider?: "stub" | "opencode_cli";
  opencodeBin?: string;
  modelName?: string;
  assistantRepoPath?: string;
  githubBaseBranch?: string | null;
  executionIntentConfidenceThreshold?: number;
  previewDiffFirst?: boolean;
};

const defaultConfigPath = "~/.config/delegate-assistant/config.json";
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

const parseConfigFile = (resolvedPath: string): RawConfigFile => {
  let rawText: string;

  try {
    rawText = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    throw new Error(
      `Config file is required at ${resolvedPath}. Create it from config/config.example.json or set DELEGATE_CONFIG_PATH. Cause: ${String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `Config file at ${resolvedPath} is invalid JSON: ${String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file at ${resolvedPath} must be a JSON object`);
  }

  return parsed as RawConfigFile;
};

const asOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asOptionalNullableString = (
  value: unknown,
): string | null | undefined => {
  if (value === null) {
    return null;
  }
  return asOptionalString(value);
};

const asOptionalBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
};

const asOptionalNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
};

const asModelProvider = (value: unknown): "stub" | "opencode_cli" => {
  if (value === "stub" || value === "opencode_cli") {
    return value;
  }
  throw new Error(
    `MODEL_PROVIDER must be one of: stub, opencode_cli (received ${String(value)})`,
  );
};

const asPositiveInt = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

const asConfidence = (value: number): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      "EXECUTION_INTENT_CONFIDENCE_THRESHOLD must be between 0 and 1",
    );
  }
  return value;
};

export const loadConfig = (): AppConfig => {
  const configSourcePath = expandHome(
    process.env.DELEGATE_CONFIG_PATH?.trim() || defaultConfigPath,
  );
  const fileConfig = parseConfigFile(configSourcePath);

  const overriddenKeys = [
    "PORT",
    "NODE_ENV",
    "ENABLE_INTERNAL_ROUTES",
    "SQLITE_PATH",
    "AUDIT_LOG_PATH",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_POLL_INTERVAL_MS",
    "MODEL_PROVIDER",
    "OPENCODE_BIN",
    "MODEL_NAME",
    "ASSISTANT_REPO_PATH",
    "GITHUB_BASE_BRANCH",
    "EXECUTION_INTENT_CONFIDENCE_THRESHOLD",
    "PREVIEW_DIFF_FIRST",
  ].filter((key) => process.env[key] !== undefined).length;

  const port = Number(
    process.env.PORT ?? asOptionalNumber(fileConfig.port) ?? "3000",
  );
  const nodeEnv =
    process.env.NODE_ENV ??
    asOptionalString(fileConfig.nodeEnv) ??
    "development";
  const telegramPollIntervalMs = Number(
    process.env.TELEGRAM_POLL_INTERVAL_MS ??
      asOptionalNumber(fileConfig.telegramPollIntervalMs) ??
      "2000",
  );
  const enableInternalRoutes =
    (process.env.ENABLE_INTERNAL_ROUTES?.trim() === "true" ||
      asOptionalBoolean(fileConfig.enableInternalRoutes)) ??
    nodeEnv === "development";

  const modelProvider = asModelProvider(
    process.env.MODEL_PROVIDER ?? fileConfig.modelProvider ?? "stub",
  );
  const executionIntentConfidenceThreshold = asConfidence(
    Number(
      process.env.EXECUTION_INTENT_CONFIDENCE_THRESHOLD ??
        asOptionalNumber(fileConfig.executionIntentConfidenceThreshold) ??
        "0.75",
    ),
  );
  const previewDiffFirst =
    process.env.PREVIEW_DIFF_FIRST?.trim() === "true" ||
    asOptionalBoolean(fileConfig.previewDiffFirst) ||
    false;

  const telegramBotToken =
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    asOptionalNullableString(fileConfig.telegramBotToken) ||
    null;
  const sqlitePath = expandHome(
    process.env.SQLITE_PATH ??
      asOptionalString(fileConfig.sqlitePath) ??
      defaultSqlitePath,
  );
  const auditLogPath = expandHome(
    process.env.AUDIT_LOG_PATH ??
      asOptionalString(fileConfig.auditLogPath) ??
      defaultAuditPath,
  );
  const opencodeBin =
    process.env.OPENCODE_BIN?.trim() ||
    asOptionalString(fileConfig.opencodeBin) ||
    "opencode";
  const modelName =
    process.env.MODEL_NAME?.trim() ||
    asOptionalString(fileConfig.modelName) ||
    "openai/gpt-5.3-codex";
  const assistantRepoPath = expandHome(
    process.env.ASSISTANT_REPO_PATH ||
      asOptionalString(fileConfig.assistantRepoPath) ||
      process.cwd(),
  );
  const githubBaseBranch =
    process.env.GITHUB_BASE_BRANCH?.trim() ||
    asOptionalNullableString(fileConfig.githubBaseBranch) ||
    null;

  asPositiveInt(port, "PORT");
  asPositiveInt(telegramPollIntervalMs, "TELEGRAM_POLL_INTERVAL_MS");

  return {
    configSourcePath,
    envOverridesApplied: overriddenKeys,
    port,
    nodeEnv,
    enableInternalRoutes,
    sqlitePath,
    auditLogPath,
    telegramBotToken,
    telegramPollIntervalMs,
    modelProvider,
    opencodeBin,
    modelName,
    assistantRepoPath,
    githubBaseBranch,
    executionIntentConfidenceThreshold,
    previewDiffFirst,
  };
};
