import type { OllamaChatResult } from "./types";

/** Shape of an Ollama /api/chat message. */
type OllamaMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** Options for a single Ollama chat call. */
type OllamaChatOptions = {
  url: string;
  model: string;
  messages: OllamaMessage[];
  numCtx: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** Raw response shape from Ollama POST /api/chat (stream: false). */
type OllamaChatResponse = {
  message: { role: string; content: string };
  total_duration: number;
  load_duration: number;
  prompt_eval_count: number;
  prompt_eval_duration: number;
  eval_count: number;
  eval_duration: number;
};

/**
 * Send a chat completion request to Ollama.
 *
 * Uses POST /api/chat with stream: false for a single synchronous response.
 * Supports AbortSignal for cancellation from the router's abort() method.
 */
export async function ollamaChat(
  opts: OllamaChatOptions,
): Promise<OllamaChatResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const start = performance.now();

  // Combine external abort signal with a timeout signal
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

  const signals = opts.signal
    ? [opts.signal, timeoutController.signal]
    : [timeoutController.signal];

  // AbortSignal.any merges multiple signals into one
  const combinedSignal = AbortSignal.any(signals);

  try {
    const response = await fetch(`${opts.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: false,
        options: { num_ctx: opts.numCtx },
      }),
      signal: combinedSignal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama error ${String(response.status)}: ${body}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    const latencyMs = performance.now() - start;

    // eval_duration is in nanoseconds
    const evalDurationSec = data.eval_duration / 1e9;
    const tokensPerSec =
      evalDurationSec > 0 ? data.eval_count / evalDurationSec : null;

    return {
      text: data.message.content,
      latencyMs: Math.round(latencyMs),
      tokensIn: data.prompt_eval_count,
      tokensOut: data.eval_count,
      tokensPerSec: tokensPerSec ? Math.round(tokensPerSec * 10) / 10 : null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Health check result. */
type HealthCheckResult = { ok: true } | { ok: false; error: string };

/**
 * Check if an Ollama instance is reachable and a specific model is available.
 *
 * Returns { ok: true } if the model is found, or { ok: false, error } on failure.
 * Does not throw.
 */
export async function ollamaHealthCheck(
  url: string,
  model: string,
): Promise<HealthCheckResult> {
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { ok: false, error: `Ollama returned ${String(res.status)}` };
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
