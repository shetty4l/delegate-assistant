/**
 * Engram HTTP client for memory recall and storage.
 *
 * Recall gracefully degrades: never throws on failure, returns empty results.
 * Remember throws on failure — callers (MemoryQueue) handle errors per-item.
 */

const ENGRAM_TIMEOUT_MS = 2_000;

interface EngramMemory {
  id: string;
  content: string;
  category: string | null;
  strength: number;
  relevance: number;
  created_at: string;
  access_count: number;
}

interface EngramRecallResponse {
  memories: EngramMemory[];
  fallback_mode: boolean;
}

/** Result of an Engram recall operation. */
export interface RecalledMemories {
  /** Number of memories retrieved. */
  count: number;
  /** Pre-formatted context block for injection into system prompts. */
  formatted: string;
  /** Whether Engram fell back to FTS (no embeddings). */
  fallbackMode: boolean;
}

const EMPTY_RECALL: RecalledMemories = {
  count: 0,
  formatted: "",
  fallbackMode: false,
};

/**
 * Format recalled memories into an XML-like context block for system prompts.
 */
function formatMemories(memories: EngramMemory[]): string {
  const blocks = memories.map((m) => {
    const tag = m.category ? ` category="${m.category}"` : "";
    const content =
      m.content.length > 2000
        ? `${m.content.slice(0, 2000)}\n[...truncated]`
        : m.content;
    return `<memory${tag} relevance="${m.relevance.toFixed(2)}">\n${content}\n</memory>`;
  });

  return `Here is relevant context from prior conversations:\n\n${blocks.join("\n\n")}`;
}

/**
 * Recall relevant memories from Engram.
 *
 * Returns empty result on any failure (connection error, timeout, bad response).
 * Never throws.
 */
export async function engramRecall(opts: {
  url: string;
  query: string;
  maxMemories: number;
  minStrength: number;
}): Promise<RecalledMemories> {
  try {
    const res = await fetch(`${opts.url}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: opts.query,
        limit: opts.maxMemories,
        min_strength: opts.minStrength,
      }),
      signal: AbortSignal.timeout(ENGRAM_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "engram.recall.http_error",
          status: res.status,
          body: body.slice(0, 200),
        }),
      );
      return EMPTY_RECALL;
    }

    const data = (await res.json()) as EngramRecallResponse;

    if (data.memories.length === 0) {
      return EMPTY_RECALL;
    }

    return {
      count: data.memories.length,
      formatted: formatMemories(data.memories),
      fallbackMode: data.fallback_mode,
    };
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "engram.recall.failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return EMPTY_RECALL;
  }
}

/**
 * Store a memory in Engram.
 *
 * Throws on failure — callers are expected to handle errors (e.g. MemoryQueue
 * catches per-item and logs warnings).
 */
export async function engramRemember(opts: {
  url: string;
  content: string;
  category?: string;
}): Promise<void> {
  const res = await fetch(`${opts.url}/remember`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: opts.content,
      category: opts.category,
    }),
    signal: AbortSignal.timeout(ENGRAM_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Engram remember failed (${String(res.status)}): ${body}`);
  }
}

/**
 * Check if the Engram HTTP server is reachable.
 */
export async function engramHealthCheck(
  url: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(ENGRAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, error: `Engram returned ${String(res.status)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Cannot reach Engram at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
