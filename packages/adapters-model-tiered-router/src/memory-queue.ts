/**
 * Buffered queue for storing routing decisions to Engram.
 *
 * Batches decisions and flushes at a controlled interval to avoid
 * hammering Engram during noisy/bursty chat sessions. Bounded queue
 * drops oldest entries on overflow.
 */

import { engramRemember } from "./engram-client";

const MAX_QUEUE_SIZE = 50;
const FLUSH_INTERVAL_MS = 5_000;
const DISPOSE_TIMEOUT_MS = 10_000;

export interface MemoryEntry {
  content: string;
  category: string;
}

const logWarn = (event: string, fields: Record<string, unknown>): void => {
  console.warn(JSON.stringify({ level: "warn", event, ...fields }));
};

const log = (event: string, fields: Record<string, unknown>): void => {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
};

export class MemoryQueue {
  private readonly queue: MemoryEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private readonly engramUrl: string;

  constructor(engramUrl: string) {
    this.engramUrl = engramUrl;
  }

  /** Start the periodic flush timer. */
  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);

    // Allow the process to exit even if the timer is running.
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  /** Enqueue a routing decision for async storage. Drops oldest if over capacity. */
  enqueue(entry: MemoryEntry): void {
    this.queue.push(entry);

    while (this.queue.length > MAX_QUEUE_SIZE) {
      this.queue.shift();
    }
  }

  /**
   * Stop the flush timer and drain remaining entries.
   * Returns when the queue is empty or the timeout expires.
   */
  async dispose(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) {
      return;
    }

    log("memory_queue.dispose.draining", { remaining: this.queue.length });

    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_TIMEOUT_MS)),
    ]);

    if (this.queue.length > 0) {
      logWarn("memory_queue.dispose.dropped", {
        dropped: this.queue.length,
      });
      this.queue.length = 0;
    }
  }

  /** Drain the queue, sending each entry to Engram sequentially. */
  private async flush(): Promise<void> {
    // Prevent concurrent flushes (interval could fire while a slow flush is running).
    if (this.flushing || this.queue.length === 0) {
      return;
    }

    this.flushing = true;

    try {
      while (this.queue.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: length check guarantees entry exists
        const entry = this.queue.shift()!;
        try {
          await engramRemember({
            url: this.engramUrl,
            content: entry.content,
            category: entry.category,
          });
        } catch (err) {
          logWarn("memory_queue.flush.item_error", {
            error: err instanceof Error ? err.message : String(err),
          });
          // Continue draining — don't let one failure block the rest.
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
