import type { RelayErrorClass } from "@assistant-core/src/worker-types";
import { ModelError } from "@delegate/domain";

export const classifyRelayError = (error: unknown): RelayErrorClass => {
  // 3a: Detect ModelError instances thrown by the adapter
  if (error instanceof ModelError) {
    const c = error.classification;
    if (c === "rate_limit" || c === "capacity") {
      return "model_transient";
    }

    // Tool-call validation errors from the provider (e.g. Groq's failed_generation).
    // The upstream message is poisoned into agent history — needs a session reset.
    const msg = error.upstream.toLowerCase();
    if (
      msg.includes("failed_generation") ||
      msg.includes("tool call validation") ||
      msg.includes("tool_use_failed") ||
      msg.includes("tool use failed")
    ) {
      return "tool_call_error";
    }

    // billing, auth, internal, max_steps, aborted → non-retryable
    return "model_error";
  }

  const text = String(error).toLowerCase();
  if (text.includes("timed out")) {
    return "timeout";
  }

  if (text.includes("no user-facing text output")) {
    return "empty_output";
  }

  // 3b: Add "already processing" / "agent is busy" to session_invalid
  if (
    /stale session|invalid session|session .*not found|unknown session|expired session|session rejected|already processing|agent is busy/.test(
      text,
    )
  ) {
    return "session_invalid";
  }

  return "transport";
};

export const buildRelayFailureText = (
  classification: RelayErrorClass,
  relayTimeoutMs: number,
  error?: unknown,
): string => {
  if (classification === "timeout") {
    return `The model did not finish within ${(relayTimeoutMs / 1000).toFixed(0)}s. Please retry, or increase RELAY_TIMEOUT_MS for long-running tasks.`;
  }
  if (classification === "empty_output") {
    return "The model finished without user-visible output. It may have completed internal actions; check logs/artifacts and retry if you still need a summary.";
  }
  if (classification === "session_invalid") {
    return "Your previous session expired. I started a fresh session; please retry this request.";
  }
  if (classification === "tool_call_error") {
    return "The model's response was rejected by the provider. I've cleared the conversation — please try again.";
  }
  // 3c: New model-specific messages
  if (classification === "model_error") {
    const upstream =
      error instanceof ModelError ? error.upstream : String(error);
    return `⚠️ ${error instanceof ModelError ? error.classification : "model"} error from the model provider: ${upstream}`;
  }
  if (classification === "model_transient") {
    return "The model provider is temporarily unavailable. Please try again later.";
  }
  return "I hit a transport/delivery issue while relaying this response. Please retry now.";
};

export const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

export const runWithProgress = async <T>(input: {
  task: Promise<T>;
  onProgress: (count: number) => Promise<void>;
  firstMs: number;
  everyMs: number;
  maxCount: number;
}): Promise<T> => {
  const { task, onProgress, firstMs, everyMs, maxCount } = input;
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let count = 0;

  const clearAll = () => {
    stopped = true;
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
  };

  const schedule = (delayMs: number): void => {
    if (stopped || count >= maxCount) {
      return;
    }
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (stopped || count >= maxCount) {
        return;
      }
      count += 1;
      try {
        await onProgress(count);
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "relay.progress_failed",
            progressCount: count,
            error: String(err),
          }),
        );
      }

      if (!stopped && count < maxCount) {
        schedule(everyMs);
      }
    }, delayMs);
    timers.add(timer);
  };

  schedule(firstMs);
  try {
    return await task;
  } finally {
    clearAll();
  }
};
