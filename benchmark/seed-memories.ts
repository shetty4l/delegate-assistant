#!/usr/bin/env bun
/**
 * Seed Engram with benchmark memories.
 *
 * Inserts focused, factual memories about delegate-assistant into Engram
 * so the memory-augmented benchmark variants have relevant context to recall.
 * All seeded memories are prefixed with [benchmark-seed] for easy cleanup.
 *
 * Usage:
 *   bun run benchmark/seed-memories.ts                        # seed memories
 *   bun run benchmark/seed-memories.ts --dry-run              # preview without inserting
 *   bun run benchmark/seed-memories.ts --clean                # remove seeded memories
 *   bun run benchmark/seed-memories.ts --engram-url http://... # custom Engram URL
 */

const SEED_PREFIX = "[benchmark-seed] ";

interface SeedMemory {
  content: string;
  category: "fact" | "decision";
}

const SEED_MEMORIES: SeedMemory[] = [
  {
    category: "fact",
    content: `${SEED_PREFIX}delegate-assistant session management: Each Telegram chat/thread gets its own TopicQueue with concurrency=1 to serialize messages per conversation. Sessions are managed by the SessionStorePort (SQLite adapter). Sessions have idle timeout (default 45min / 2700000ms) and max concurrency (default 5). The pi-agent Agent instance holds conversation history in memory; when a session is evicted, the Agent is discarded and a fresh one is created on the next message. Session keys combine chatId + threadId. The relay layer handles retries on transient errors (rate limits, capacity) and session invalidation.`,
  },
  {
    category: "decision",
    content: `${SEED_PREFIX}Chose @mariozechner/pi-agent-core + pi-ai over direct LLM API calls for delegate-assistant. Rationale: pi-ai supports 22+ providers (Groq, OpenRouter, Anthropic, OpenAI, Bedrock, Google, etc.) with a unified streaming interface. pi-agent-core provides the agent loop with tool calling, step limiting (default 15 steps), and event streaming. This avoids building and maintaining provider-specific HTTP clients and the agentic loop ourselves. Tradeoff: less control over request construction (e.g., cannot easily add cache_control annotations to tool definitions). The adapter lives in packages/adapters-model-pi-agent and implements the ModelPort interface from packages/ports.`,
  },
  {
    category: "fact",
    content: `${SEED_PREFIX}delegate-assistant production deployment: Runs on Mac Mini M4 (10-core CPU, 10-core GPU, 24GB unified RAM, 500GB SSD) at /Users/suyash/dev/personal/delegate-assistant. Managed by macOS LaunchAgent (com.suyash.delegate-assistant) which auto-starts on boot. An auto-updater checks GitHub releases every 5 minutes, downloads new versions, and restarts the service via launchctl. Config at ~/.config/delegate-assistant/config.json, secrets at ~/.config/delegate-assistant/secrets.env. Telegram bot uses long polling (not webhooks) with 2-second poll interval. Web dashboard (session-manager-web) runs as a separate LaunchAgent on a different port.`,
  },
  {
    category: "fact",
    content: `${SEED_PREFIX}delegate-assistant model configuration: Code defaults are provider="groq", model="qwen/qwen3-32b". Production Mac Mini config.json overrides to provider="openrouter", model="openrouter/auto" with OPENROUTER_API_KEY in secrets.env. OpenRouter/auto dynamically selects the best model based on the request. The pi-agent adapter (packages/adapters-model-pi-agent) wraps pi-ai's streaming API and the pi-agent-core Agent class. The assistant has 7 tools available: read_file, write_file, execute_shell, list_directory, search_files, web_fetch, web_search. Tool availability is configurable via config flags.`,
  },
];

// ── Args ────────────────────────────────────────────────────────────────────

function parseArgs(): {
  engramUrl: string;
  dryRun: boolean;
  clean: boolean;
} {
  const args = process.argv.slice(2);

  let engramUrl = "http://127.0.0.1:7749";
  const urlIdx = args.indexOf("--engram-url");
  if (urlIdx !== -1 && args[urlIdx + 1]) {
    engramUrl = args[urlIdx + 1];
  }

  return {
    engramUrl,
    dryRun: args.includes("--dry-run"),
    clean: args.includes("--clean"),
  };
}

// ── Engram HTTP helpers ─────────────────────────────────────────────────────

async function engramRemember(
  url: string,
  memory: SeedMemory,
): Promise<{ id: string }> {
  const res = await fetch(`${url}/remember`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: memory.content,
      category: memory.category,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Engram remember failed (${res.status}): ${body}`);
  }

  return (await res.json()) as { id: string };
}

async function engramRecallSeeds(
  url: string,
): Promise<Array<{ id: string; content: string }>> {
  // Recall with a query that matches the seed prefix.
  // Quote "benchmark-seed" to prevent FTS5 from parsing the hyphen as a column separator.
  const res = await fetch(`${url}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: '"benchmark-seed" delegate-assistant',
      limit: 50,
      min_strength: 0.0,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Engram recall failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    memories: Array<{ id: string; content: string }>;
  };

  // Filter to only seeded memories
  return data.memories.filter((m) => m.content.startsWith(SEED_PREFIX));
}

async function engramForget(url: string, id: string): Promise<void> {
  const res = await fetch(`${url}/forget`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Engram forget failed (${res.status}): ${body}`);
  }
}

async function engramHealthCheck(url: string): Promise<void> {
  const res = await fetch(`${url}/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    throw new Error(`Engram health check failed (${res.status})`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { engramUrl, dryRun, clean } = parseArgs();

  console.log(`Engram URL: ${engramUrl}`);

  // Health check
  try {
    await engramHealthCheck(engramUrl);
    console.log("Engram: OK\n");
  } catch (err) {
    console.error(
      `Engram unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "Start the Engram HTTP daemon first: cd /path/to/engram && bun run src/cli.ts start",
    );
    process.exit(1);
  }

  if (clean) {
    // Remove seeded memories
    console.log("Cleaning seeded memories...\n");
    let seeds: Array<{ id: string; content: string }> = [];
    try {
      seeds = await engramRecallSeeds(engramUrl);
    } catch {
      // Fresh DB or FTS error -- nothing to clean
    }

    if (seeds.length === 0) {
      console.log("No seeded memories found.");
      return;
    }

    for (const seed of seeds) {
      const preview = seed.content.slice(0, 80);
      if (dryRun) {
        console.log(`  [dry-run] Would forget: ${seed.id} "${preview}..."`);
      } else {
        await engramForget(engramUrl, seed.id);
        console.log(`  Forgot: ${seed.id} "${preview}..."`);
      }
    }

    console.log(
      `\n${dryRun ? "Would remove" : "Removed"} ${seeds.length} seeded memories.`,
    );
    return;
  }

  // Seed memories
  console.log(`Seeding ${SEED_MEMORIES.length} memories...\n`);

  // Check for existing seeds to avoid duplicates
  let existing: Array<{ id: string; content: string }> = [];
  try {
    existing = await engramRecallSeeds(engramUrl);
  } catch {
    // Fresh DB or FTS error -- no existing seeds, proceed
  }
  if (existing.length > 0) {
    console.log(
      `Found ${existing.length} existing seeded memories. Run --clean first to remove them, or they will coexist with new seeds.\n`,
    );
  }

  for (const memory of SEED_MEMORIES) {
    const preview = memory.content.slice(
      SEED_PREFIX.length,
      80 + SEED_PREFIX.length,
    );

    if (dryRun) {
      console.log(`  [dry-run] ${memory.category}: "${preview}..."`);
    } else {
      const result = await engramRemember(engramUrl, memory);
      console.log(`  ${memory.category}: ${result.id} "${preview}..."`);
    }
  }

  console.log(
    `\n${dryRun ? "Would seed" : "Seeded"} ${SEED_MEMORIES.length} memories.`,
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
