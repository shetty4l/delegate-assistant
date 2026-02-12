/**
 * Minimal Ollama HTTP client for the benchmark.
 * Uses POST /api/chat with stream: false.
 */

import type { VariantResult } from "./types";

interface OllamaChatOptions {
  /** Ollama base URL, e.g. http://127.0.0.1:11434 */
  url: string;
  /** Model name, e.g. qwen2.5:14b-instruct-q4_K_M */
  model: string;
  /** System prompt */
  systemPrompt: string;
  /** User message */
  userMessage: string;
  /** Context window size */
  numCtx: number;
  /** Request timeout in ms (default 120_000) */
  timeoutMs?: number;
}

interface OllamaChatResponse {
  message: { role: string; content: string };
  total_duration: number;
  load_duration: number;
  prompt_eval_count: number;
  prompt_eval_duration: number;
  eval_count: number;
  eval_duration: number;
}

export async function ollamaChat(
  opts: OllamaChatOptions,
): Promise<VariantResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const start = performance.now();

  const response = await fetch(`${opts.url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: opts.userMessage },
      ],
      stream: false,
      options: {
        num_ctx: opts.numCtx,
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const latencyMs = performance.now() - start;

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as OllamaChatResponse;

  // eval_duration is in nanoseconds
  const evalDurationSec = data.eval_duration / 1e9;
  const tokensPerSec =
    evalDurationSec > 0 ? data.eval_count / evalDurationSec : null;

  return {
    response: data.message.content,
    latency_ms: Math.round(latencyMs),
    tokens_in: data.prompt_eval_count,
    tokens_out: data.eval_count,
    tokens_per_sec: tokensPerSec ? Math.round(tokensPerSec * 10) / 10 : null,
    model: opts.model,
    provider: "ollama",
  };
}

/**
 * Check if Ollama is reachable and the target model is available.
 */
export async function ollamaHealthCheck(
  url: string,
  model: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { ok: false, error: `Ollama returned ${res.status}` };
    }
    const data = (await res.json()) as {
      models: Array<{ name: string }>;
    };
    const available = data.models.map((m) => m.name);
    if (!available.includes(model)) {
      return {
        ok: false,
        error: `Model "${model}" not found. Available: ${available.join(", ")}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Cannot reach Ollama at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
