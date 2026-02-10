import type { RelayErrorClass } from "@assistant-core/src/worker-types";

export const classifyRelayError = (error: unknown): RelayErrorClass => {
  const text = String(error).toLowerCase();
  if (text.includes("timed out")) {
    return "timeout";
  }

  if (text.includes("no user-facing text output")) {
    return "empty_output";
  }

  if (
    /stale session|invalid session|session .*not found|unknown session|expired session|session rejected/.test(
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
  return "I hit a transport/delivery issue while relaying this response. Please retry now.";
};

export const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
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
      } catch {
        // non-blocking progress notification failure
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
