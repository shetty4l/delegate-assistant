#!/usr/bin/env bun
/**
 * T1 Viability Benchmark Runner
 *
 * Tests whether qwen2.5:14b via Ollama can handle chat-only tasks,
 * optionally augmented with Engram memories.
 *
 * Usage:
 *   bun run benchmark/run-benchmark.ts --secrets ~/.config/delegate-assistant/secrets.env
 *   bun run benchmark/run-benchmark.ts --prompts benchmark/prompts-smoke.json --secrets ...
 *   bun run benchmark/run-benchmark.ts                # reads GROQ_API_KEY from env
 *
 * Environment variables (all optional, have defaults):
 *   OLLAMA_URL          - default http://127.0.0.1:11434
 *   ENGRAM_URL          - default http://127.0.0.1:7749
 *   OLLAMA_MODEL        - default qwen2.5:14b-instruct-q4_K_M
 *   OLLAMA_NUM_CTX      - default 16384
 *   GROQ_API_KEY        - required (or pass --secrets <path>)
 *   CONTROL_PROVIDER    - default groq
 *   CONTROL_MODEL       - default qwen/qwen3-32b
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { KnownProvider } from "@mariozechner/pi-ai";
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { engramHealthCheck, engramRecall } from "./lib/engram-client";
import { ollamaChat, ollamaHealthCheck } from "./lib/ollama-client";
import type {
  BenchmarkPrompt,
  BenchmarkRun,
  PromptResult,
  VariantResult,
} from "./lib/types";

// ── Config ──────────────────────────────────────────────────────────────────

function parseArgs(): { secretsPath?: string; promptsPath?: string } {
  const args = process.argv.slice(2);
  const result: { secretsPath?: string; promptsPath?: string } = {};

  const secretsIdx = args.indexOf("--secrets");
  if (secretsIdx !== -1 && args[secretsIdx + 1]) {
    result.secretsPath = args[secretsIdx + 1];
  }

  const promptsIdx = args.indexOf("--prompts");
  if (promptsIdx !== -1 && args[promptsIdx + 1]) {
    result.promptsPath = args[promptsIdx + 1];
  }

  return result;
}

function loadSecrets(path: string): void {
  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // Don't overwrite existing env vars
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function getConfig() {
  const { secretsPath, promptsPath } = parseArgs();
  if (secretsPath) {
    loadSecrets(secretsPath);
  }

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    console.error(
      "Error: GROQ_API_KEY not set. Either set it in env or pass --secrets <path>",
    );
    process.exit(1);
  }

  return {
    ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
    engramUrl: process.env.ENGRAM_URL ?? "http://127.0.0.1:7749",
    ollamaModel: process.env.OLLAMA_MODEL ?? "qwen2.5:14b-instruct-q4_K_M",
    ollamaNumCtx: Number(process.env.OLLAMA_NUM_CTX ?? "16384"),
    controlProvider: (process.env.CONTROL_PROVIDER ?? "groq") as KnownProvider,
    controlModel: process.env.CONTROL_MODEL ?? "qwen/qwen3-32b",
    groqApiKey,
    promptsPath,
  };
}

// ── System prompt ───────────────────────────────────────────────────────────

const T1_SYSTEM_PROMPT = `You are a personal chief of staff. Your role is to handle tasks delegated to you efficiently and proactively.

You handle a wide range of tasks -- research, analysis, drafting, planning, brainstorming, and anything else delegated to you.

Guidelines:
- Be concise and direct.
- If a request is ambiguous, ask for clarification rather than guessing.
- When you don't know something, say so honestly.`;

// ── Control model (Groq via pi-ai) ─────────────────────────────────────────

async function runControl(
  prompt: string,
  config: ReturnType<typeof getConfig>,
): Promise<VariantResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi-ai generics require literal model IDs
  const model = getModel(
    config.controlProvider as any,
    config.controlModel as any,
  ) as any;

  const start = performance.now();

  const assistantMsg = await completeSimple(
    model,
    {
      systemPrompt: T1_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    {
      apiKey: config.groqApiKey,
      maxTokens: 2048,
      signal: AbortSignal.timeout(60_000),
    },
  );

  const latencyMs = performance.now() - start;

  const responseText = assistantMsg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  return {
    response: responseText,
    latency_ms: Math.round(latencyMs),
    tokens_in: assistantMsg.usage.input,
    tokens_out: assistantMsg.usage.output,
    tokens_per_sec: null,
    model: config.controlModel,
    provider: "groq",
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const config = getConfig();

  // Load prompts
  const promptsPath = config.promptsPath
    ? resolve(config.promptsPath)
    : resolve(dirname(import.meta.path), "prompts.json");
  const prompts: BenchmarkPrompt[] = JSON.parse(
    readFileSync(promptsPath, "utf-8"),
  );

  console.error(`\n=== T1 Viability Benchmark ===\n`);
  console.error(`Prompts:  ${promptsPath}`);
  console.error(`Ollama:   ${config.ollamaUrl} (${config.ollamaModel})`);
  console.error(`Engram:   ${config.engramUrl}`);
  console.error(`Control:  ${config.controlProvider}/${config.controlModel}`);
  console.error(`Prompts:  ${prompts.length}`);
  console.error(`Ctx size: ${config.ollamaNumCtx}`);
  console.error("");

  // Health checks
  console.error("Running health checks...");

  const ollamaHealth = await ollamaHealthCheck(
    config.ollamaUrl,
    config.ollamaModel,
  );
  if (!ollamaHealth.ok) {
    console.error(`  Ollama: FAIL - ${ollamaHealth.error}`);
    process.exit(1);
  }
  console.error(`  Ollama: OK`);

  const engramHealth = await engramHealthCheck(config.engramUrl);
  const engramAvailable = engramHealth.ok;
  if (engramAvailable) {
    console.error(`  Engram: OK`);
  } else {
    console.error(`  Engram: UNAVAILABLE - ${engramHealth.error}`);
    console.error(`  (Memory-augmented variants will be skipped)`);
  }

  // Verify control model works with a minimal test
  console.error("  Control: testing...");
  try {
    await runControl("Say OK", config);
    console.error("  Control: OK");
  } catch (err) {
    console.error(
      `  Control: FAIL - ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  console.error("");

  // Run benchmark
  const results: PromptResult[] = [];
  const totalVariants =
    prompts.length * 2 +
    prompts.filter((p) => p.engram_query && engramAvailable).length;
  let completedVariants = 0;

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const progress = `[${i + 1}/${prompts.length}]`;
    console.error(`${progress} ${prompt.id} (${prompt.category})`);

    // 1. Ollama bare
    console.error(`  Ollama bare...`);
    let ollamaBare: VariantResult;
    try {
      ollamaBare = await ollamaChat({
        url: config.ollamaUrl,
        model: config.ollamaModel,
        systemPrompt: T1_SYSTEM_PROMPT,
        userMessage: prompt.prompt,
        numCtx: config.ollamaNumCtx,
      });
      completedVariants++;
      console.error(
        `    ${ollamaBare.latency_ms}ms, ${ollamaBare.tokens_out} tokens, ${ollamaBare.tokens_per_sec ?? "?"} tok/s`,
      );
    } catch (err) {
      console.error(
        `    FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Create a failed result rather than crashing the whole benchmark
      ollamaBare = {
        response: `[ERROR: ${err instanceof Error ? err.message : String(err)}]`,
        latency_ms: 0,
        tokens_in: 0,
        tokens_out: 0,
        tokens_per_sec: null,
        model: config.ollamaModel,
        provider: "ollama",
      };
    }

    // 2. Ollama + Engram (only for memory prompts with engram available)
    let ollamaEngram: VariantResult | null = null;
    let engramMemories: string[] | null = null;

    if (prompt.engram_query && engramAvailable) {
      console.error(`  Engram recall: "${prompt.engram_query}"...`);
      const recalled = await engramRecall({
        url: config.engramUrl,
        query: prompt.engram_query,
        limit: 5,
        min_strength: 0.3,
      });

      if (recalled.memories.length > 0) {
        engramMemories = recalled.contents;
        const augmentedSystemPrompt = `${recalled.formatted}\n\n---\n\n${T1_SYSTEM_PROMPT}`;

        console.error(
          `    ${recalled.memories.length} memories recalled (${recalled.fallback_mode ? "FTS fallback" : "semantic"})`,
        );
        console.error(`  Ollama + Engram...`);

        try {
          ollamaEngram = await ollamaChat({
            url: config.ollamaUrl,
            model: config.ollamaModel,
            systemPrompt: augmentedSystemPrompt,
            userMessage: prompt.prompt,
            numCtx: config.ollamaNumCtx,
          });
          completedVariants++;
          console.error(
            `    ${ollamaEngram.latency_ms}ms, ${ollamaEngram.tokens_out} tokens, ${ollamaEngram.tokens_per_sec ?? "?"} tok/s`,
          );
        } catch (err) {
          console.error(
            `    FAILED: ${err instanceof Error ? err.message : String(err)}`,
          );
          ollamaEngram = {
            response: `[ERROR: ${err instanceof Error ? err.message : String(err)}]`,
            latency_ms: 0,
            tokens_in: 0,
            tokens_out: 0,
            tokens_per_sec: null,
            model: config.ollamaModel,
            provider: "ollama",
          };
        }
      } else {
        console.error(`    No memories found, skipping augmented variant`);
      }
    }

    // 3. Control (Groq)
    console.error(`  Control (${config.controlProvider})...`);
    let control: VariantResult;
    try {
      control = await runControl(prompt.prompt, config);
      completedVariants++;
      console.error(
        `    ${control.latency_ms}ms, ${control.tokens_out} tokens`,
      );
    } catch (err) {
      console.error(
        `    FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
      control = {
        response: `[ERROR: ${err instanceof Error ? err.message : String(err)}]`,
        latency_ms: 0,
        tokens_in: 0,
        tokens_out: 0,
        tokens_per_sec: null,
        model: config.controlModel,
        provider: "groq",
      };
    }

    results.push({
      prompt_id: prompt.id,
      category: prompt.category,
      prompt: prompt.prompt,
      ollama_bare: ollamaBare,
      ollama_engram: ollamaEngram,
      control,
      engram_memories: engramMemories,
    });

    console.error("");
  }

  // Write results
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = resolve(dirname(import.meta.path), "results");
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }
  const outputPath = resolve(resultsDir, `${timestamp}.json`);

  const run: BenchmarkRun = {
    timestamp: new Date().toISOString(),
    config: {
      ollama_url: config.ollamaUrl,
      ollama_model: config.ollamaModel,
      ollama_num_ctx: config.ollamaNumCtx,
      engram_url: config.engramUrl,
      control_provider: config.controlProvider,
      control_model: config.controlModel,
    },
    results,
  };

  writeFileSync(outputPath, JSON.stringify(run, null, 2));

  // Print summary
  console.error(`\n=== Summary ===\n`);
  console.error(`Results written to: ${outputPath}`);
  console.error(`Prompts: ${prompts.length}`);
  console.error(`Variants completed: ${completedVariants}`);

  const ollamaLatencies = results
    .map((r) => r.ollama_bare.latency_ms)
    .filter((l) => l > 0);
  const controlLatencies = results
    .map((r) => r.control.latency_ms)
    .filter((l) => l > 0);

  if (ollamaLatencies.length > 0) {
    const avgOllama =
      ollamaLatencies.reduce((a, b) => a + b, 0) / ollamaLatencies.length;
    console.error(`Ollama avg latency: ${Math.round(avgOllama)}ms`);
  }
  if (controlLatencies.length > 0) {
    const avgControl =
      controlLatencies.reduce((a, b) => a + b, 0) / controlLatencies.length;
    console.error(`Control avg latency: ${Math.round(avgControl)}ms`);
  }

  const engramResults = results.filter((r) => r.ollama_engram !== null);
  if (engramResults.length > 0) {
    console.error(`Engram-augmented variants: ${engramResults.length}`);
  }

  console.error(
    `\nRun 'bun run benchmark/review.ts ${outputPath}' to review results.`,
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
