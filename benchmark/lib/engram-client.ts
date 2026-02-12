/**
 * Minimal Engram HTTP client for the benchmark.
 * Uses POST /recall to retrieve relevant memories.
 */

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

interface EngramRecallOptions {
  /** Engram HTTP base URL, e.g. http://127.0.0.1:7749 */
  url: string;
  /** Semantic search query */
  query: string;
  /** Max memories to return (default 5) */
  limit?: number;
  /** Minimum strength threshold (default 0.3) */
  min_strength?: number;
}

export interface RecalledMemories {
  /** Raw memory objects */
  memories: EngramMemory[];
  /** Whether Engram fell back to FTS (no embeddings) */
  fallback_mode: boolean;
  /** Pre-formatted string block for injection into system prompt */
  formatted: string;
  /** Just the content strings, for storing in results */
  contents: string[];
}

/**
 * Recall memories from Engram. Returns empty result on connection failure
 * (graceful degradation -- logs warning but does not throw).
 */
export async function engramRecall(
  opts: EngramRecallOptions,
): Promise<RecalledMemories> {
  const empty: RecalledMemories = {
    memories: [],
    fallback_mode: false,
    formatted: "",
    contents: [],
  };

  try {
    const res = await fetch(`${opts.url}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: opts.query,
        limit: opts.limit ?? 5,
        min_strength: opts.min_strength ?? 0.3,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[engram] recall failed (${res.status}): ${body}`);
      return empty;
    }

    const data = (await res.json()) as EngramRecallResponse;

    if (data.memories.length === 0) {
      return empty;
    }

    const formatted = formatMemories(data.memories);
    const contents = data.memories.map((m) => m.content);

    return {
      memories: data.memories,
      fallback_mode: data.fallback_mode,
      formatted,
      contents,
    };
  } catch (err) {
    console.error(
      `[engram] cannot reach ${opts.url}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return empty;
  }
}

/**
 * Format recalled memories into a context block for the system prompt.
 */
function formatMemories(memories: EngramMemory[]): string {
  const blocks = memories.map((m) => {
    const tag = m.category ? ` category="${m.category}"` : "";
    // Truncate very long memories to keep context reasonable
    const content =
      m.content.length > 2000
        ? `${m.content.slice(0, 2000)}\n[...truncated]`
        : m.content;
    return `<memory${tag} relevance="${m.relevance.toFixed(2)}">\n${content}\n</memory>`;
  });

  return `Here is relevant context from prior conversations:\n\n${blocks.join("\n\n")}`;
}

/**
 * Check if Engram HTTP server is reachable.
 */
export async function engramHealthCheck(
  url: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { ok: false, error: `Engram returned ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Cannot reach Engram at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
