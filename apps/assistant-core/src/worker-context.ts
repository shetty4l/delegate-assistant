/**
 * Holds all per-process mutable state for the worker.
 *
 * Passing a `WorkerContext` through the call chain (instead of relying on
 * module-level globals) makes the state explicit, testable, and safe to
 * instantiate multiple times in the same process (e.g. parallel test suites).
 */
export class WorkerContext {
  /** Tracks how many messages each chatId has received (for /start first-message logic). */
  readonly chatMessageCount = new Map<string, number>();

  /** In-memory session cache keyed by session key. */
  readonly sessionByKey = new Map<
    string,
    { sessionId: string; lastUsedAt: number }
  >();

  /** Current active workspace per topic. */
  readonly activeWorkspace = new Map<string, string>();

  /** All workspaces ever used per topic (for future history features). */
  readonly workspaceHistory = new Map<string, Set<string>>();

  /** Last threadId seen per chatId (for reply thread inference). */
  readonly lastThreadId = new Map<string, string | null>();
}
