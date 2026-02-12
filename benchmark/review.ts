#!/usr/bin/env bun
/**
 * Benchmark Review Tool
 *
 * Reads benchmark results and presents prompts + responses side-by-side
 * for human evaluation. Accepts A/B/C ratings and writes rated output.
 *
 * Usage:
 *   bun run benchmark/review.ts benchmark/results/<timestamp>.json
 *   bun run benchmark/review.ts benchmark/results/<timestamp>.json --no-interactive
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type {
  BenchmarkRun,
  PromptCategory,
  PromptResult,
  RatedBenchmarkRun,
  RatedResult,
  RatedVariant,
  Rating,
  VariantResult,
} from "./lib/types";

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

// ── Rating input ────────────────────────────────────────────────────────────

async function promptRating(label: string): Promise<Rating> {
  const validRatings: Rating[] = ["A", "B", "C"];

  while (true) {
    process.stdout.write(
      `  Rate ${label} [A=acceptable, B=borderline, C=unacceptable]: `,
    );

    const line = await readLine();
    const input = line.trim().toUpperCase();

    if (validRatings.includes(input as Rating)) {
      return input as Rating;
    }
    console.log(`  Invalid rating "${input}". Enter A, B, or C.`);
  }
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setEncoding("utf-8");
    stdin.resume();

    const onData = (data: string) => {
      stdin.removeListener("data", onData);
      stdin.pause();
      resolve(data);
    };
    stdin.on("data", onData);
  });
}

// ── Summary ─────────────────────────────────────────────────────────────────

function printSummary(ratings: RatedResult[]): void {
  const bareCount = { A: 0, B: 0, C: 0 };
  const engramCount = { A: 0, B: 0, C: 0 };
  let engramTotal = 0;
  const byCategory: Record<
    string,
    { A: number; B: number; C: number; total: number }
  > = {};

  for (const r of ratings) {
    bareCount[r.ollama_bare.rating]++;

    if (r.ollama_engram) {
      engramCount[r.ollama_engram.rating]++;
      engramTotal++;
    }

    if (!byCategory[r.category]) {
      byCategory[r.category] = { A: 0, B: 0, C: 0, total: 0 };
    }
    byCategory[r.category][r.ollama_bare.rating]++;
    byCategory[r.category].total++;
  }

  const total = ratings.length;
  const pct = (n: number, t: number) =>
    t > 0 ? `${Math.round((n / t) * 100)}%` : "N/A";

  console.log(`\n${DIVIDER}`);
  console.log("  SUMMARY");
  console.log(DIVIDER);

  console.log(`\n  Ollama Bare (${total} prompts):`);
  console.log(
    `    A (acceptable):   ${bareCount.A} (${pct(bareCount.A, total)})`,
  );
  console.log(
    `    B (borderline):   ${bareCount.B} (${pct(bareCount.B, total)})`,
  );
  console.log(
    `    C (unacceptable): ${bareCount.C} (${pct(bareCount.C, total)})`,
  );

  if (engramTotal > 0) {
    console.log(`\n  Ollama + Engram (${engramTotal} prompts):`);
    console.log(
      `    A (acceptable):   ${engramCount.A} (${pct(engramCount.A, engramTotal)})`,
    );
    console.log(
      `    B (borderline):   ${engramCount.B} (${pct(engramCount.B, engramTotal)})`,
    );
    console.log(
      `    C (unacceptable): ${engramCount.C} (${pct(engramCount.C, engramTotal)})`,
    );
  }

  console.log(`\n  By Category (Ollama Bare):`);
  for (const [cat, counts] of Object.entries(byCategory)) {
    console.log(
      `    ${cat.padEnd(16)} A:${pct(counts.A, counts.total).padStart(4)}  B:${pct(counts.B, counts.total).padStart(4)}  C:${pct(counts.C, counts.total).padStart(4)}  (n=${counts.total})`,
    );
  }

  // Verdict
  const acceptableRate = bareCount.A / total;
  console.log(`\n  Verdict:`);
  if (acceptableRate >= 0.7) {
    console.log(
      `    T1 VIABLE - ${pct(bareCount.A, total)} acceptable (threshold: 70%)`,
    );
  } else if (acceptableRate >= 0.5) {
    console.log(
      `    T1 MARGINAL - ${pct(bareCount.A, total)} acceptable (threshold: 70%)`,
    );
  } else {
    console.log(
      `    T1 NOT VIABLE - ${pct(bareCount.A, total)} acceptable (threshold: 70%)`,
    );
  }
  console.log("");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
  const interactive = !flags.includes("--no-interactive");

  if (args.length === 0) {
    console.error(
      "Usage: bun run benchmark/review.ts <results-file.json> [--no-interactive]",
    );
    process.exit(1);
  }

  const inputPath = resolve(args[0]);
  const run: BenchmarkRun = JSON.parse(readFileSync(inputPath, "utf-8"));

  console.log(`\n=== T1 Viability Benchmark Review ===`);
  console.log(`Run: ${run.timestamp}`);
  console.log(
    `Ollama: ${run.config.ollama_model} (ctx: ${run.config.ollama_num_ctx})`,
  );
  console.log(
    `Control: ${run.config.control_provider}/${run.config.control_model}`,
  );
  console.log(`Prompts: ${run.results.length}`);

  if (!interactive) {
    console.log(`\nMode: non-interactive (display only)\n`);
    for (let i = 0; i < run.results.length; i++) {
      printResult(run.results[i], i, run.results.length);
    }
    return;
  }

  console.log(`\nMode: interactive -- rate each Ollama response`);
  console.log(`  A = acceptable (good enough for T1)`);
  console.log(`  B = borderline (right idea, noticeably worse)`);
  console.log(`  C = unacceptable (wrong, incoherent, or useless)\n`);

  const ratings: RatedResult[] = [];

  for (let i = 0; i < run.results.length; i++) {
    const result = run.results[i];
    printResult(result, i, run.results.length);

    const bareRating = await promptRating("OLLAMA BARE");
    let engramRating: RatedVariant | null = null;

    if (result.ollama_engram) {
      const rating = await promptRating("OLLAMA + ENGRAM");
      engramRating = { rating };
    }

    ratings.push({
      prompt_id: result.prompt_id,
      category: result.category,
      ollama_bare: { rating: bareRating },
      ollama_engram: engramRating,
    });
  }

  // Print summary
  printSummary(ratings);

  // Build rated output
  const bareSummary = { A: 0, B: 0, C: 0 };
  const engramSummary = { A: 0, B: 0, C: 0 };
  let hasEngram = false;
  const byCat: Record<
    PromptCategory,
    { A: number; B: number; C: number; total: number }
  > = {} as any;

  for (const r of ratings) {
    bareSummary[r.ollama_bare.rating]++;
    if (r.ollama_engram) {
      engramSummary[r.ollama_engram.rating]++;
      hasEngram = true;
    }
    if (!byCat[r.category]) {
      byCat[r.category] = { A: 0, B: 0, C: 0, total: 0 };
    }
    byCat[r.category][r.ollama_bare.rating]++;
    byCat[r.category].total++;
  }

  const ratedRun: RatedBenchmarkRun = {
    source: inputPath,
    reviewed_at: new Date().toISOString(),
    ratings,
    summary: {
      total: ratings.length,
      ollama_bare: bareSummary,
      ollama_engram: hasEngram ? engramSummary : null,
      by_category: byCat,
    },
  };

  // Write rated results
  const outputName = `${basename(inputPath, ".json")}-rated.json`;
  const outputPath = resolve(dirname(inputPath), outputName);
  writeFileSync(outputPath, JSON.stringify(ratedRun, null, 2));
  console.log(`Ratings saved to: ${outputPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
