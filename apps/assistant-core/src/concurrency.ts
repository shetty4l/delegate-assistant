import { logError } from "@assistant-core/src/logging";

const DEFAULT_MAX_QUEUE_SIZE = 100;

export class Semaphore {
  private count: number;
  private readonly waiting: Array<() => void> = [];
  private readonly maxQueueSize: number;

  constructor(max: number, maxQueueSize: number = DEFAULT_MAX_QUEUE_SIZE) {
    this.count = max;
    this.maxQueueSize = maxQueueSize;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    if (this.waiting.length >= this.maxQueueSize) {
      throw new Error(
        `Semaphore queue is full (${this.maxQueueSize} waiting). Rejecting new work.`,
      );
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.count++;
    }
  }

  get available(): number {
    return this.count;
  }

  get pendingCount(): number {
    return this.waiting.length;
  }
}

export class TopicQueue {
  private queue: Array<() => Promise<void>> = [];
  private running = false;
  private drainResolvers: Array<() => void> = [];
  private readonly onIdle?: () => void;
  private readonly onError?: (error: unknown) => void;

  constructor(onIdle?: () => void, onError?: (error: unknown) => void) {
    this.onIdle = onIdle;
    this.onError = onError;
  }

  enqueue(task: () => Promise<void>): void {
    this.queue.push(task);
    if (!this.running) {
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      try {
        await task();
      } catch (error) {
        logError("topic_queue.task_failed", { error: String(error) });
        this.onError?.(error);
      }
    }
    this.running = false;
    for (const resolve of this.drainResolvers) resolve();
    this.drainResolvers = [];
    this.onIdle?.();
  }

  /** Resolves when the queue is idle (empty and not processing). */
  whenIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.drainResolvers.push(resolve));
  }

  get size(): number {
    return this.queue.length;
  }

  get isProcessing(): boolean {
    return this.running;
  }
}

export class TopicQueueMap {
  private readonly queues = new Map<string, TopicQueue>();

  getOrCreate(key: string): TopicQueue {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = new TopicQueue(() => this.queues.delete(key));
      this.queues.set(key, queue);
    }
    return queue;
  }

  /** Wait for all topic queues to finish their in-flight work. */
  async drainAll(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.whenIdle()));
  }

  get size(): number {
    return this.queues.size;
  }
}
