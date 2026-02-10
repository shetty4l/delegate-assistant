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
  modelProvider: "stub" | "opencode_cli" | "pi_agent";
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
  piAgentProvider: string;
  piAgentModel: string;
  piAgentApiKey: string | null;
  piAgentMaxSteps: number;
  maxConcurrentTopics: number;
  systemPromptPath: string | null;
  piAgentEnableShellTool: boolean;
  shellCommandDenylist: string[];
};

type RawConfigFile = {
  port?: number;
  sqlitePath?: string;
  telegramBotToken?: string | null;
  telegramPollIntervalMs?: number;
  modelProvider?: "stub" | "opencode_cli" | "pi_agent";
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
  piAgentProvider?: string;
  piAgentModel?: string;
  piAgentApiKey?: string | null;
  piAgentMaxSteps?: number;
  maxConcurrentTopics?: number;
  systemPromptPath?: string | null;
  piAgentEnableShellTool?: boolean;
  shellCommandDenylist?: string[];
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

const asModelProvider = (
  value: unknown,
): "stub" | "opencode_cli" | "pi_agent" => {
  if (value === "stub" || value === "opencode_cli" || value === "pi_agent") {
    return value;
  }
  throw new Error(
    `Model provider must be one of: stub, opencode_cli, pi_agent (received "${String(value)}")`,
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
    "PI_AGENT_PROVIDER",
    "PI_AGENT_MODEL",
    "PI_AGENT_API_KEY",
    "PI_AGENT_MAX_STEPS",
    "MAX_CONCURRENT_TOPICS",
    "SYSTEM_PROMPT_PATH",
    "PI_AGENT_ENABLE_SHELL_TOOL",
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

  const piAgentProvider =
    process.env.PI_AGENT_PROVIDER?.trim() ||
    asOptionalString(fileConfig.piAgentProvider) ||
    "openrouter";
  const piAgentModel =
    process.env.PI_AGENT_MODEL?.trim() ||
    asOptionalString(fileConfig.piAgentModel) ||
    "openrouter/auto";
  const piAgentApiKey =
    process.env.PI_AGENT_API_KEY?.trim() ||
    asOptionalNullableString(fileConfig.piAgentApiKey) ||
    null;
  const piAgentMaxSteps = Number(
    process.env.PI_AGENT_MAX_STEPS ??
      asOptionalNumber(fileConfig.piAgentMaxSteps) ??
      "15",
  );
  const maxConcurrentTopics = Number(
    process.env.MAX_CONCURRENT_TOPICS ??
      asOptionalNumber(fileConfig.maxConcurrentTopics) ??
      "3",
  );
  const systemPromptPath =
    process.env.SYSTEM_PROMPT_PATH?.trim() ||
    asOptionalNullableString(fileConfig.systemPromptPath) ||
    null;
  const piAgentEnableShellTool =
    process.env.PI_AGENT_ENABLE_SHELL_TOOL !== undefined
      ? process.env.PI_AGENT_ENABLE_SHELL_TOOL.trim() !== "false"
      : (asOptionalBoolean(fileConfig.piAgentEnableShellTool) ?? true);
  const shellCommandDenylist: string[] = Array.isArray(
    fileConfig.shellCommandDenylist,
  )
    ? fileConfig.shellCommandDenylist.filter(
        (item): item is string => typeof item === "string",
      )
    : [];

  if (!existsSync(assistantRepoPath)) {
    throw new Error(`Assistant repo path does not exist: ${assistantRepoPath}`);
  }
  asPositiveInt(port, "port");
  asPositiveInt(telegramPollIntervalMs, "telegramPollIntervalMs");
  asPositiveInt(opencodeServePort, "opencodeServePort");
  asPositiveInt(sessionIdleTimeoutMs, "sessionIdleTimeoutMs");
  asPositiveInt(sessionMaxConcurrent, "sessionMaxConcurrent");
  asPositiveInt(sessionRetryAttempts, "sessionRetryAttempts");
  asPositiveInt(relayTimeoutMs, "relayTimeoutMs");
  asPositiveInt(progressFirstMs, "progressFirstMs");
  asPositiveInt(progressEveryMs, "progressEveryMs");
  asPositiveInt(progressMaxCount, "progressMaxCount");

  if (modelProvider === "pi_agent" && !piAgentApiKey) {
    const providerEnvVars: Record<string, string> = {
      openrouter: "OPENROUTER_API_KEY",
      groq: "GROQ_API_KEY",
      google: "GEMINI_API_KEY",
      cerebras: "CEREBRAS_API_KEY",
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
    };
    const expectedVar = providerEnvVars[piAgentProvider];
    const hasProviderKey = expectedVar ? !!process.env[expectedVar] : false;
    if (!hasProviderKey) {
      const hint = expectedVar
        ? `Set piAgentApiKey (or ${expectedVar} env var)`
        : "Set piAgentApiKey";
      throw new Error(
        `${hint} when model provider is "pi_agent" (provider: ${piAgentProvider}).`,
      );
    }
  }

  // Warn about missing delegate identity env vars (non-fatal)
  if (!process.env.GIT_AUTHOR_NAME || !process.env.GIT_AUTHOR_EMAIL) {
    console.warn(
      "[config] WARNING: GIT_AUTHOR_NAME or GIT_AUTHOR_EMAIL not set. " +
        "Git commits from the assistant will use the system default identity. " +
        "Add these to ~/.config/delegate-assistant/secrets.env for proper attribution.",
    );
  }
  if (!process.env.DELEGATE_GITHUB_TOKEN) {
    console.warn(
      "[config] WARNING: DELEGATE_GITHUB_TOKEN not set. " +
        "The assistant will not be able to push branches or create PRs on GitHub. " +
        "Add this to ~/.config/delegate-assistant/secrets.env.",
    );
  }

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
    piAgentProvider,
    piAgentModel,
    piAgentApiKey,
    piAgentMaxSteps,
    maxConcurrentTopics,
    systemPromptPath,
    piAgentEnableShellTool,
    shellCommandDenylist,
  };
};
