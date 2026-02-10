import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@assistant-core/src/config";

const tmpDir = mkdtempSync(join(tmpdir(), "config-test-"));

/** Minimal valid config file content. */
const minimalConfig = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    port: 3000,
    sqlitePath: join(tmpDir, "test.db"),
    telegramBotToken: null,
    telegramPollIntervalMs: 2000,
    modelProvider: "pi_agent",
    assistantRepoPath: tmpDir,
    ...overrides,
  });

/**
 * Env vars that loadConfig inspects. We save originals and restore after each
 * test to avoid cross-contamination.
 */
const envKeys = [
  "DELEGATE_CONFIG_PATH",
  "MODEL_PROVIDER",
  "PI_AGENT_API_KEY",
  "PI_AGENT_PROVIDER",
  "PI_AGENT_MODEL",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "CEREBRAS_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ASSISTANT_REPO_PATH",
] as const;

type EnvSnapshot = Record<string, string | undefined>;

const saveEnv = (): EnvSnapshot => {
  const snap: EnvSnapshot = {};
  for (const k of envKeys) snap[k] = process.env[k];
  return snap;
};

const restoreEnv = (snap: EnvSnapshot): void => {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

/** Write a temp config file and point DELEGATE_CONFIG_PATH at it. */
const writeConfig = (content: string): string => {
  const path = join(tmpDir, `config-${Date.now()}-${Math.random()}.json`);
  writeFileSync(path, content);
  process.env.DELEGATE_CONFIG_PATH = path;
  return path;
};

let envSnap: EnvSnapshot;

afterEach(() => {
  restoreEnv(envSnap);
});

// --- Tests ---

describe("pi_agent API key validation", () => {
  test("accepts PI_AGENT_API_KEY as universal key", () => {
    envSnap = saveEnv();
    writeConfig(minimalConfig());
    process.env.PI_AGENT_API_KEY = "sk-test-universal";

    const config = loadConfig();
    expect(config.piAgentApiKey).toBe("sk-test-universal");
    expect(config.modelProvider).toBe("pi_agent");
  });

  test("accepts OPENROUTER_API_KEY for openrouter provider (default)", () => {
    envSnap = saveEnv();
    writeConfig(minimalConfig());
    delete process.env.PI_AGENT_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    const config = loadConfig();
    // API key comes from env var at the pi-ai layer, not from config
    expect(config.piAgentApiKey).toBeNull();
    expect(config.piAgentProvider).toBe("openrouter");
  });

  test("accepts GROQ_API_KEY for groq provider", () => {
    envSnap = saveEnv();
    writeConfig(minimalConfig({ piAgentProvider: "groq" }));
    delete process.env.PI_AGENT_API_KEY;
    process.env.GROQ_API_KEY = "gsk-test";

    const config = loadConfig();
    expect(config.piAgentApiKey).toBeNull();
    expect(config.piAgentProvider).toBe("groq");
  });

  test("accepts GEMINI_API_KEY for google provider", () => {
    envSnap = saveEnv();
    writeConfig(minimalConfig({ piAgentProvider: "google" }));
    delete process.env.PI_AGENT_API_KEY;
    process.env.GEMINI_API_KEY = "ai-test";

    const config = loadConfig();
    expect(config.piAgentApiKey).toBeNull();
    expect(config.piAgentProvider).toBe("google");
  });

  test("accepts CEREBRAS_API_KEY for cerebras provider", () => {
    envSnap = saveEnv();
    writeConfig(minimalConfig({ piAgentProvider: "cerebras" }));
    delete process.env.PI_AGENT_API_KEY;
    process.env.CEREBRAS_API_KEY = "csk-test";

    const config = loadConfig();
    expect(config.piAgentApiKey).toBeNull();
    expect(config.piAgentProvider).toBe("cerebras");
  });

  test("accepts OPENAI_API_KEY for openai provider", () => {
    envSnap = saveEnv();
    writeConfig(minimalConfig({ piAgentProvider: "openai" }));
    delete process.env.PI_AGENT_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";

    const config = loadConfig();
    expect(config.piAgentApiKey).toBeNull();
    expect(config.piAgentProvider).toBe("openai");
  });

  test("accepts ANTHROPIC_API_KEY for anthropic provider", () => {
    envSnap = saveEnv();
    writeConfig(minimalConfig({ piAgentProvider: "anthropic" }));
    delete process.env.PI_AGENT_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    const config = loadConfig();
    expect(config.piAgentApiKey).toBeNull();
    expect(config.piAgentProvider).toBe("anthropic");
  });

  test("throws when no applicable key is set for a known provider", () => {
    envSnap = saveEnv();
    writeConfig(minimalConfig({ piAgentProvider: "groq" }));
    delete process.env.PI_AGENT_API_KEY;
    delete process.env.GROQ_API_KEY;

    expect(() => loadConfig()).toThrow(
      'Set piAgentApiKey (or GROQ_API_KEY env var) when model provider is "pi_agent" (provider: groq).',
    );
  });

  test("throws with helpful message for openrouter when no key is set", () => {
    envSnap = saveEnv();
    writeConfig(minimalConfig());
    delete process.env.PI_AGENT_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    expect(() => loadConfig()).toThrow(
      'Set piAgentApiKey (or OPENROUTER_API_KEY env var) when model provider is "pi_agent" (provider: openrouter).',
    );
  });

  test("throws with generic message for unknown provider", () => {
    envSnap = saveEnv();
    writeConfig(minimalConfig({ piAgentProvider: "custom-provider" }));
    delete process.env.PI_AGENT_API_KEY;

    expect(() => loadConfig()).toThrow(
      'Set piAgentApiKey when model provider is "pi_agent" (provider: custom-provider).',
    );
  });

  test("does not validate API key when modelProvider is not pi_agent", () => {
    envSnap = saveEnv();
    writeConfig(minimalConfig({ modelProvider: "stub" }));
    delete process.env.PI_AGENT_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    const config = loadConfig();
    expect(config.modelProvider).toBe("stub");
  });
});

describe("pi_agent default values", () => {
  test("defaults piAgentProvider to openrouter", () => {
    envSnap = saveEnv();
    writeConfig(minimalConfig());
    process.env.PI_AGENT_API_KEY = "sk-test";

    const config = loadConfig();
    expect(config.piAgentProvider).toBe("openrouter");
  });

  test("defaults piAgentModel to openrouter/auto", () => {
    envSnap = saveEnv();
    writeConfig(minimalConfig());
    process.env.PI_AGENT_API_KEY = "sk-test";

    const config = loadConfig();
    expect(config.piAgentModel).toBe("openrouter/auto");
  });

  test("config file overrides defaults", () => {
    envSnap = saveEnv();
    writeConfig(
      minimalConfig({ piAgentProvider: "groq", piAgentModel: "llama-3.3-70b" }),
    );
    process.env.PI_AGENT_API_KEY = "sk-test";

    const config = loadConfig();
    expect(config.piAgentProvider).toBe("groq");
    expect(config.piAgentModel).toBe("llama-3.3-70b");
  });

  test("env vars override config file values", () => {
    envSnap = saveEnv();
    writeConfig(
      minimalConfig({ piAgentProvider: "groq", piAgentModel: "llama-3.3-70b" }),
    );
    process.env.PI_AGENT_API_KEY = "sk-test";
    process.env.PI_AGENT_PROVIDER = "google";
    process.env.PI_AGENT_MODEL = "gemini-2.5-flash";

    const config = loadConfig();
    expect(config.piAgentProvider).toBe("google");
    expect(config.piAgentModel).toBe("gemini-2.5-flash");
  });
});
