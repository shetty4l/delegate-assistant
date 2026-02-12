import { describe, expect, test } from "bun:test";
import {
  Semaphore,
  TopicQueue,
  TopicQueueMap,
} from "@assistant-core/src/concurrency";

describe("Semaphore", () => {
  test("acquire and release basic flow", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.available).toBe(0);

    sem.release();
    expect(sem.available).toBe(1);

    await sem.acquire();
    expect(sem.available).toBe(0);
  });

  test("blocks when exhausted, unblocks on release", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    let secondResolved = false;
    const secondAcquire = sem.acquire().then(() => {
      secondResolved = true;
    });

    // Give microtask queue a chance to resolve if it could
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondResolved).toBe(false);

    sem.release();
    await secondAcquire;
    expect(secondResolved).toBe(true);
  });

  test("respects max concurrency count", async () => {
    const sem = new Semaphore(2);
    const resolved: number[] = [];

    const p1 = sem.acquire().then(() => resolved.push(1));
    const p2 = sem.acquire().then(() => resolved.push(2));
    const p3 = sem.acquire().then(() => resolved.push(3));
    const p4 = sem.acquire().then(() => resolved.push(4));

    // Let microtasks settle
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved).toEqual([1, 2]);

    sem.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved).toEqual([1, 2, 3]);

    sem.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolved).toEqual([1, 2, 3, 4]);
  });

  test("available and pendingCount getters", async () => {
    const sem = new Semaphore(3);
    expect(sem.available).toBe(3);
    expect(sem.pendingCount).toBe(0);

    await sem.acquire();
    await sem.acquire();
    expect(sem.available).toBe(1);
    expect(sem.pendingCount).toBe(0);

    // Third acquire uses last slot
    const p3 = sem.acquire();
    await p3;

    // Fourth acquire will block
    const p4 = sem.acquire();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sem.available).toBe(0);
    expect(sem.pendingCount).toBe(1);

    sem.release();
    await p4;
    expect(sem.pendingCount).toBe(0);
  });

  test("rejects acquire when queue exceeds maxQueueSize", async () => {
    const sem = new Semaphore(1, 2);
    await sem.acquire(); // Takes the slot

    // These two will queue successfully
    const p1 = sem.acquire();
    const p2 = sem.acquire();
    expect(sem.pendingCount).toBe(2);

    // Third queued acquire should be rejected
    await expect(sem.acquire()).rejects.toThrow(/Semaphore queue is full/);

    // Clean up
    sem.release();
    sem.release();
    sem.release();
    await Promise.all([p1, p2]);
  });

  test("uses default maxQueueSize of 100", async () => {
    const sem = new Semaphore(1);
    await sem.acquire(); // Takes the slot

    // Queue up 100 waiters (should all succeed)
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(sem.acquire());
    }
    expect(sem.pendingCount).toBe(100);

    // 101st should fail
    await expect(sem.acquire()).rejects.toThrow(/Semaphore queue is full/);

    // Clean up
    for (let i = 0; i <= 100; i++) {
      sem.release();
    }
    await Promise.all(promises);
  });
});

describe("TopicQueue", () => {
  test("processes items serially", async () => {
    const queue = new TopicQueue();
    const results: number[] = [];
    const done = new Promise<void>((resolve) => {
      let remaining = 3;
      for (const i of [1, 2, 3]) {
        queue.enqueue(async () => {
          await new Promise((r) => setTimeout(r, 10));
          results.push(i);
          remaining--;
          if (remaining === 0) resolve();
        });
      }
    });

    await done;
    expect(results).toEqual([1, 2, 3]);
  });

  test("error in one item does not block subsequent items", async () => {
    const queue = new TopicQueue();
    const results: string[] = [];

    const done = new Promise<void>((resolve) => {
      queue.enqueue(async () => {
        throw new Error("boom");
      });
      queue.enqueue(async () => {
        results.push("ok");
        resolve();
      });
    });

    await done;
    expect(results).toEqual(["ok"]);
  });

  test("calls onError callback when a task fails", async () => {
    const errors: unknown[] = [];
    const queue = new TopicQueue(undefined, (error) => {
      errors.push(error);
    });

    const done = new Promise<void>((resolve) => {
      queue.enqueue(async () => {
        throw new Error("task-failure");
      });
      queue.enqueue(async () => {
        resolve();
      });
    });

    await done;
    expect(errors.length).toBe(1);
    expect(String(errors[0])).toContain("task-failure");
  });

  test("size and isProcessing getters", async () => {
    const queue = new TopicQueue();
    expect(queue.size).toBe(0);
    expect(queue.isProcessing).toBe(false);

    let resolveTask!: () => void;
    const taskPromise = new Promise<void>((r) => {
      resolveTask = r;
    });

    queue.enqueue(async () => {
      await taskPromise;
    });

    // Let drain start
    await new Promise((r) => setTimeout(r, 5));
    expect(queue.isProcessing).toBe(true);

    resolveTask();
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.isProcessing).toBe(false);
  });
});

describe("TopicQueueMap", () => {
  test("auto-removes idle queues after drain", async () => {
    const map = new TopicQueueMap();
    expect(map.size).toBe(0);

    const q = map.getOrCreate("topic-1");
    expect(map.size).toBe(1);

    const done = new Promise<void>((resolve) => {
      q.enqueue(async () => {
        resolve();
      });
    });

    await done;
    // Let the drain finish and onIdle fire
    await new Promise((r) => setTimeout(r, 10));
    expect(map.size).toBe(0);
  });

  test("recreates queue after auto-removal", async () => {
    const map = new TopicQueueMap();
    const q1 = map.getOrCreate("topic-1");

    const done1 = new Promise<void>((resolve) => {
      q1.enqueue(async () => resolve());
    });
    await done1;
    await new Promise((r) => setTimeout(r, 10));
    expect(map.size).toBe(0);

    // Getting the same key creates a fresh queue
    const q2 = map.getOrCreate("topic-1");
    expect(map.size).toBe(1);
    expect(q2).not.toBe(q1);
  });

  test("drainAll waits for all queues to finish", async () => {
    const map = new TopicQueueMap();
    const results: string[] = [];

    map.getOrCreate("a").enqueue(async () => {
      await new Promise((r) => setTimeout(r, 20));
      results.push("a");
    });
    map.getOrCreate("b").enqueue(async () => {
      results.push("b");
    });

    await map.drainAll();
    expect(results).toContain("a");
    expect(results).toContain("b");
  });

  test("getOrCreate passes onError callback to new queues", async () => {
    const map = new TopicQueueMap();
    const errors: unknown[] = [];

    map
      .getOrCreate("topic-err", (err) => {
        errors.push(err);
      })
      .enqueue(async () => {
        throw new Error("queue boom");
      });

    await map.drainAll();
    expect(errors.length).toBe(1);
    expect(String(errors[0])).toContain("queue boom");
  });
});
