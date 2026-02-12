#!/usr/bin/env bun
/**
 * Benchmark Review Tool (Display Only)
 *
 * Reads benchmark results and displays prompts + responses side-by-side
 * with latency/token stats for human review.
 *
 * Usage:
 *   bun run benchmark/review.ts benchmark/results/<timestamp>.json
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BenchmarkRun, PromptResult, VariantResult } from "./lib/types";

// ── Formatting helpers ──────────────────────────────────────────────────────

const DIVIDER = "─".repeat(80);
const THIN_DIVIDER = "┄".repeat(80);

function wrap(text: string, width: number): string {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length <= width) {
      lines.push(paragraph);
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > width) {
      let breakAt = remaining.lastIndexOf(" ", width);
      if (breakAt === -1) breakAt = width;
      lines.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt + 1);
    }
    if (remaining) lines.push(remaining);
  }
  return lines.join("\n");
}

function formatVariant(label: string, v: VariantResult): string {
  const meta = [
    `${v.latency_ms}ms`,
    `${v.tokens_in}in/${v.tokens_out}out`,
    v.tokens_per_sec ? `${v.tokens_per_sec} tok/s` : null,
    `${v.provider}/${v.model}`,
  ]
    .filter(Boolean)
    .join(" | ");

  return `  [${label}] (${meta})\n${THIN_DIVIDER}\n${wrap(v.response, 78)}\n`;
}

function printResult(result: PromptResult, index: number, total: number): void {
  console.log(`\n${DIVIDER}`);
  console.log(
    `  Prompt ${index + 1}/${total}: ${result.prompt_id} (${result.category})`,
  );
  console.log(DIVIDER);
  console.log(`\n  "${result.prompt}"\n`);

  if (result.engram_memories && result.engram_memories.length > 0) {
    console.log(`  Engram memories injected: ${result.engram_memories.length}`);
    for (const mem of result.engram_memories) {
      const preview = mem.length > 120 ? `${mem.slice(0, 120)}...` : mem;
      console.log(`    - ${preview}`);
    }
    console.log("");
  }

  console.log(formatVariant("OLLAMA BARE", result.ollama_bare));

  if (result.ollama_engram) {
    console.log(formatVariant("OLLAMA + ENGRAM", result.ollama_engram));
  }

  console.log(formatVariant("CONTROL (GROQ)", result.control));
}

// ── Summary stats ───────────────────────────────────────────────────────────

function printSummary(run: BenchmarkRun): void {
  const { results } = run;

  const ollamaLatencies = results
    .map((r) => r.ollama_bare.latency_ms)
    .filter((l) => l > 0);
  const controlLatencies = results
    .map((r) => r.control.latency_ms)
    .filter((l) => l > 0);
  const engramLatencies = results
    .map((r) => r.ollama_engram?.latency_ms ?? 0)
    .filter((l) => l > 0);

  const avg = (arr: number[]) =>
    arr.length > 0
      ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
      : 0;
  const median = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };

  const ollamaTokSec = results
    .map((r) => r.ollama_bare.tokens_per_sec)
    .filter((t): t is number => t !== null);

  console.log(`\n${DIVIDER}`);
  console.log("  SUMMARY");
  console.log(DIVIDER);

  console.log(`\n  Prompts: ${results.length}`);

  console.log(`\n  Latency (ms):`);
  console.log(
    `    Ollama bare:     avg=${avg(ollamaLatencies)}  median=${median(ollamaLatencies)}`,
  );
  if (engramLatencies.length > 0) {
    console.log(
      `    Ollama + Engram: avg=${avg(engramLatencies)}  median=${median(engramLatencies)}`,
    );
  }
  console.log(
    `    Control (Groq):  avg=${avg(controlLatencies)}  median=${median(controlLatencies)}`,
  );

  if (ollamaTokSec.length > 0) {
    console.log(
      `\n  Ollama throughput: avg=${avg(ollamaTokSec)} tok/s  median=${median(ollamaTokSec)} tok/s`,
    );
  }

  const ollamaTokensOut = results.map((r) => r.ollama_bare.tokens_out);
  const controlTokensOut = results.map((r) => r.control.tokens_out);
  console.log(
    `\n  Avg output tokens:  Ollama=${avg(ollamaTokensOut)}  Control=${avg(controlTokensOut)}`,
  );

  // Per-category breakdown
  const categories = [...new Set(results.map((r) => r.category))];
  console.log(`\n  By category:`);
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    const catOllamaLat = catResults
      .map((r) => r.ollama_bare.latency_ms)
      .filter((l) => l > 0);
    const catControlLat = catResults
      .map((r) => r.control.latency_ms)
      .filter((l) => l > 0);
    console.log(
      `    ${cat.padEnd(16)} n=${catResults.length}  ollama=${avg(catOllamaLat)}ms  control=${avg(catControlLat)}ms`,
    );
  }

  console.log("");
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: bun run benchmark/review.ts <results-file.json>");
    process.exit(1);
  }

  const inputPath = resolve(args[0]);
  const run: BenchmarkRun = JSON.parse(readFileSync(inputPath, "utf-8"));

  console.log(`\n=== T1 Viability Benchmark Review ===`);
  console.log(`Run:     ${run.timestamp}`);
  console.log(
    `Ollama:  ${run.config.ollama_model} (ctx: ${run.config.ollama_num_ctx})`,
  );
  console.log(
    `Control: ${run.config.control_provider}/${run.config.control_model}`,
  );
  console.log(`Prompts: ${run.results.length}`);

  for (let i = 0; i < run.results.length; i++) {
    printResult(run.results[i], i, run.results.length);
  }

  printSummary(run);
}

main();
