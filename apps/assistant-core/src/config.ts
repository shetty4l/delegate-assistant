import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AppConfig = {
  configSourcePath: string;
  envOverridesApplied: number;
  port: number;
  sqlitePath: string;
  telegramBotToken: string | null;
  telegramPollIntervalMs: number;
  modelProvider: "stub" | "opencode_cli";
  opencodeBin: string;
  modelName: string;
  assistantRepoPath: string;
  opencodeAttachUrl: string;
  opencodeAutoStart: boolean;
  opencodeServeHost: string;
  opencodeServePort: number;
  sessionIdleTimeoutMs: number;
  sessionMaxConcurrent: number;
  sessionRetryAttempts: number;
  relayTimeoutMs: number;
  progressFirstMs: number;
  progressEveryMs: number;
  progressMaxCount: number;
};

type RawConfigFile = {
  port?: number;
  sqlitePath?: string;
  telegramBotToken?: string | null;
  telegramPollIntervalMs?: number;
  modelProvider?: "stub" | "opencode_cli";
  opencodeBin?: string;
  modelName?: string;
  assistantRepoPath?: string;
  opencodeAttachUrl?: string;
  opencodeAutoStart?: boolean;
  opencodeServeHost?: string;
  opencodeServePort?: number;
  sessionIdleTimeoutMs?: number;
  sessionMaxConcurrent?: number;
  sessionRetryAttempts?: number;
  relayTimeoutMs?: number;
  progressFirstMs?: number;
  progressEveryMs?: number;
  progressMaxCount?: number;
};

const defaultConfigPath = "~/.config/delegate-assistant/config.json";
const defaultSqlitePath = "~/.local/share/delegate-assistant/data/assistant.db";

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

export const loadConfig = (): AppConfig => {
  const configSourcePath = expandHome(
    process.env.DELEGATE_CONFIG_PATH?.trim() || defaultConfigPath,
  );
  const fileConfig = parseConfigFile(configSourcePath);

  const overriddenKeys = [
    "PORT",
    "SQLITE_PATH",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_POLL_INTERVAL_MS",
    "MODEL_PROVIDER",
    "OPENCODE_BIN",
    "MODEL_NAME",
    "ASSISTANT_REPO_PATH",
    "OPENCODE_ATTACH_URL",
    "OPENCODE_AUTO_START",
    "OPENCODE_SERVE_HOST",
    "OPENCODE_SERVE_PORT",
    "SESSION_IDLE_TIMEOUT_MS",
    "SESSION_MAX_CONCURRENT",
    "SESSION_RETRY_ATTEMPTS",
    "RELAY_TIMEOUT_MS",
    "PROGRESS_FIRST_MS",
    "PROGRESS_EVERY_MS",
    "PROGRESS_MAX_COUNT",
  ].filter((key) => process.env[key] !== undefined).length;

  const port = Number(
    process.env.PORT ?? asOptionalNumber(fileConfig.port) ?? "3000",
  );
  const telegramPollIntervalMs = Number(
    process.env.TELEGRAM_POLL_INTERVAL_MS ??
      asOptionalNumber(fileConfig.telegramPollIntervalMs) ??
      "2000",
  );
  const modelProvider = asModelProvider(
    process.env.MODEL_PROVIDER ?? fileConfig.modelProvider ?? "stub",
  );
  const opencodeAttachUrl =
    process.env.OPENCODE_ATTACH_URL?.trim() ||
    asOptionalString(fileConfig.opencodeAttachUrl) ||
    "http://127.0.0.1:4096";
  const opencodeAutoStart =
    process.env.OPENCODE_AUTO_START?.trim() === "true" ||
    asOptionalBoolean(fileConfig.opencodeAutoStart) ||
    true;
  const opencodeServeHost =
    process.env.OPENCODE_SERVE_HOST?.trim() ||
    asOptionalString(fileConfig.opencodeServeHost) ||
    "127.0.0.1";
  const opencodeServePort = Number(
    process.env.OPENCODE_SERVE_PORT ??
      asOptionalNumber(fileConfig.opencodeServePort) ??
      "4096",
  );
  const sessionIdleTimeoutMs = Number(
    process.env.SESSION_IDLE_TIMEOUT_MS ??
      asOptionalNumber(fileConfig.sessionIdleTimeoutMs) ??
      `${45 * 60 * 1000}`,
  );
  const sessionMaxConcurrent = Number(
    process.env.SESSION_MAX_CONCURRENT ??
      asOptionalNumber(fileConfig.sessionMaxConcurrent) ??
      "5",
  );
  const sessionRetryAttempts = Number(
    process.env.SESSION_RETRY_ATTEMPTS ??
      asOptionalNumber(fileConfig.sessionRetryAttempts) ??
      "1",
  );
  const relayTimeoutMs = Number(
    process.env.RELAY_TIMEOUT_MS ??
      asOptionalNumber(fileConfig.relayTimeoutMs) ??
      `${5 * 60 * 1000}`,
  );
  const progressFirstMs = Number(
    process.env.PROGRESS_FIRST_MS ??
      asOptionalNumber(fileConfig.progressFirstMs) ??
      "10000",
  );
  const progressEveryMs = Number(
    process.env.PROGRESS_EVERY_MS ??
      asOptionalNumber(fileConfig.progressEveryMs) ??
      "30000",
  );
  const progressMaxCount = Number(
    process.env.PROGRESS_MAX_COUNT ??
      asOptionalNumber(fileConfig.progressMaxCount) ??
      "3",
  );

  const telegramBotToken =
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    asOptionalNullableString(fileConfig.telegramBotToken) ||
    null;
  const sqlitePath = expandHome(
    process.env.SQLITE_PATH ??
      asOptionalString(fileConfig.sqlitePath) ??
      defaultSqlitePath,
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

  if (!existsSync(assistantRepoPath)) {
    throw new Error(`ASSISTANT_REPO_PATH does not exist: ${assistantRepoPath}`);
  }
  asPositiveInt(port, "PORT");
  asPositiveInt(telegramPollIntervalMs, "TELEGRAM_POLL_INTERVAL_MS");
  asPositiveInt(opencodeServePort, "OPENCODE_SERVE_PORT");
  asPositiveInt(sessionIdleTimeoutMs, "SESSION_IDLE_TIMEOUT_MS");
  asPositiveInt(sessionMaxConcurrent, "SESSION_MAX_CONCURRENT");
  asPositiveInt(sessionRetryAttempts, "SESSION_RETRY_ATTEMPTS");
  asPositiveInt(relayTimeoutMs, "RELAY_TIMEOUT_MS");
  asPositiveInt(progressFirstMs, "PROGRESS_FIRST_MS");
  asPositiveInt(progressEveryMs, "PROGRESS_EVERY_MS");
  asPositiveInt(progressMaxCount, "PROGRESS_MAX_COUNT");

  return {
    configSourcePath,
    envOverridesApplied: overriddenKeys,
    port,
    sqlitePath,
    telegramBotToken,
    telegramPollIntervalMs,
    modelProvider,
    opencodeBin,
    modelName,
    assistantRepoPath,
    opencodeAttachUrl,
    opencodeAutoStart,
    opencodeServeHost,
    opencodeServePort,
    sessionIdleTimeoutMs,
    sessionMaxConcurrent,
    sessionRetryAttempts,
    relayTimeoutMs,
    progressFirstMs,
    progressEveryMs,
    progressMaxCount,
  };
};
