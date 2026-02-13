import type { ModelTurnResponse } from "@delegate/domain";
import type { ModelPort, RespondInput } from "@delegate/ports";
import { classify } from "./classifier";
import { engramHealthCheck, engramRecall } from "./engram-client";
import { MemoryQueue } from "./memory-queue";
import { ollamaChat, ollamaHealthCheck } from "./ollama-client";
import { T1_SYSTEM_PROMPT } from "./system-prompt";
import type {
  ClassificationResult,
  HealthState,
  TieredRouterConfig,
} from "./types";

export type {
  ClassificationResult,
  ClassifierConfig,
  EngramConfig,
  HealthState,
  T1Config,
  TieredRouterConfig,
} from "./types";

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_RECHECK_INTERVAL_MS = 10_000;

type T2Reason =
  | "classifier_unhealthy"
  | "classifier_error"
  | "classified_t2"
  | "low_confidence"
  | "t1_unhealthy"
  | "t1_error";

const log = (event: string, fields: Record<string, unknown>): void => {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
};

const logWarn = (event: string, fields: Record<string, unknown>): void => {
  console.warn(JSON.stringify({ level: "warn", event, ...fields }));
};

/** Truncate a prompt for log output. */
const promptPreview = (text: string, maxLen = 80): string =>
  text.length <= maxLen ? text : `${text.slice(0, maxLen)}…`;

/**
 * Tiered model router that implements ModelPort.
 *
 * Classifies requests via T0 (3B model on Mac Mini), then routes to
 * T1 (14B on GPU) for simple tasks or T2 (cloud) for complex ones.
 * Falls back to T2 when any local component is unavailable.
 */
export class TieredRouterAdapter implements ModelPort {
  private readonly config: TieredRouterConfig;

  /** AbortControllers for T1 requests, keyed by session. */
  private readonly activeRequests = new Map<string, AbortController>();

  /** Sessions currently being handled by T2, for abort forwarding. */
  private readonly t2ActiveSessions = new Set<string>();

  /** Buffered queue for storing routing decisions to Engram. */
  private readonly memoryQueue: MemoryQueue;

  /** Cached T1 Ollama health state (GPU). */
  private t1Health: HealthState = {
    healthy: true,
    lastCheckedAt: 0,
  };

  /** Cached classifier Ollama health state (Mac Mini). */
  private classifierHealth: HealthState = {
    healthy: true,
    lastCheckedAt: 0,
  };

  /** Cached Engram health state. */
  private engramHealth: HealthState = {
    healthy: true,
    lastCheckedAt: 0,
  };

  constructor(config: TieredRouterConfig) {
    this.config = config;
    this.memoryQueue = new MemoryQueue(config.engram.url);
    this.memoryQueue.start();
  }

  async respond(input: RespondInput): Promise<ModelTurnResponse> {
    const respondStart = performance.now();
    const sessionKey =
      input.sessionId ?? `${input.chatId}:${input.threadId ?? "root"}`;
    const preview = promptPreview(input.text);

    // Step 1: Recall memories from Engram (skip if recently unhealthy)
    let memoryContext: string | undefined;
    const engramAvailable = await this.isEngramHealthy();

    if (engramAvailable) {
      const engramStart = performance.now();
      const { engram } = this.config;
      const memories = await engramRecall({
        url: engram.url,
        query: input.text,
        maxMemories: engram.maxMemories,
        minStrength: engram.minStrength,
      });
      const engramMs = Math.round(performance.now() - engramStart);

      if (memories.count > 0) {
        log("tiered_router.engram.recalled", {
          sessionKey,
          count: memories.count,
          engramMs,
          fallbackMode: memories.fallbackMode,
        });
        memoryContext = memories.formatted || undefined;
      } else if (engramMs >= 1_500) {
        // Slow empty response likely means Engram timed out — mark unhealthy
        // so subsequent requests skip the 2s penalty.
        this.engramHealth = {
          healthy: false,
          lastCheckedAt: Date.now(),
          error: `Engram recall took ${String(engramMs)}ms (likely timeout)`,
        };
      }
    }

    // Step 2: Check if classifier is available
    const classifierAvailable = await this.isClassifierHealthy();

    if (!classifierAvailable) {
      return this.finalize(
        await this.handleT2(input, sessionKey, "classifier_unhealthy"),
        sessionKey,
        preview,
        respondStart,
      );
    }

    // Step 3: Classify the request (with memory context for T0)
    const classifyStart = performance.now();
    let classification: ClassificationResult;
    try {
      classification = await classify(
        this.config.classifier,
        input.text,
        memoryContext,
      );
      const classifyMs = Math.round(performance.now() - classifyStart);

      log("tiered_router.classify.complete", {
        sessionKey,
        tier: classification.tier,
        confidence: classification.confidence,
        reason: classification.reason,
        category: classification.category,
        classifyMs,
      });
    } catch (error) {
      this.classifierHealth = {
        healthy: false,
        lastCheckedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };

      logWarn("tiered_router.classify.error", {
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
        fallback: "t2",
      });

      return this.finalize(
        await this.handleT2(input, sessionKey, "classifier_error"),
        sessionKey,
        preview,
        respondStart,
      );
    }

    // Step 4: Route based on classification
    if (classification.tier === "t2") {
      return this.finalize(
        await this.handleT2(input, sessionKey, "classified_t2"),
        sessionKey,
        preview,
        respondStart,
        classification,
        "classified_t2",
      );
    }

    if (
      classification.confidence < this.config.classifier.confidenceThreshold
    ) {
      log("tiered_router.classify.low_confidence", {
        sessionKey,
        confidence: classification.confidence,
        threshold: this.config.classifier.confidenceThreshold,
        fallback: "t2",
      });
      return this.finalize(
        await this.handleT2(input, sessionKey, "low_confidence"),
        sessionKey,
        preview,
        respondStart,
        classification,
        "low_confidence",
      );
    }

    // Step 5: Classified as T1 — check T1 health and attempt local inference
    const t1Available = await this.isT1Healthy();

    if (!t1Available) {
      return this.finalize(
        await this.handleT2(input, sessionKey, "t1_unhealthy"),
        sessionKey,
        preview,
        respondStart,
        classification,
        "t1_unhealthy",
      );
    }

    const abortController = new AbortController();
    this.activeRequests.set(sessionKey, abortController);

    try {
      const response = await this.handleT1(
        input,
        sessionKey,
        abortController.signal,
        memoryContext,
      );
      return this.finalize(
        response,
        sessionKey,
        preview,
        respondStart,
        classification,
      );
    } catch (error) {
      if (abortController.signal.aborted) {
        throw error;
      }

      this.t1Health = {
        healthy: false,
        lastCheckedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };

      logWarn("tiered_router.t1.error", {
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
        fallback: "t2",
      });

      return this.finalize(
        await this.handleT2(input, sessionKey, "t1_error"),
        sessionKey,
        preview,
        respondStart,
        classification,
        "t1_error",
      );
    } finally {
      this.activeRequests.delete(sessionKey);
    }
  }

  /** Log the end-to-end routing summary and enqueue routing decision. */
  private finalize(
    response: ModelTurnResponse,
    sessionKey: string,
    preview: string,
    respondStart: number,
    classification?: ClassificationResult,
    t2Reason?: T2Reason,
  ): ModelTurnResponse {
    const totalMs = Math.round(performance.now() - respondStart);
    log("tiered_router.respond.complete", {
      sessionKey,
      tier: response.tier,
      totalMs,
      prompt: preview,
    });

    // Enqueue routing decision for async Engram storage.
    // Only store when classification actually happened (skip classifier_unhealthy/error).
    if (classification) {
      const actualTier = response.tier ?? classification.tier;
      const reason = t2Reason
        ? `${classification.reason} [fallback: ${t2Reason}]`
        : classification.reason;

      this.memoryQueue.enqueue({
        content:
          `[routing-decision] tier=${actualTier.toUpperCase()}` +
          ` confidence=${String(classification.confidence)}` +
          ` category=${classification.category}` +
          ` reason="${reason}"` +
          ` prompt="${preview}"`,
        category: "insight",
      });
    }

    return response;
  }

  /** Drain the memory queue. Call on process shutdown. */
  async dispose(): Promise<void> {
    await this.memoryQueue.dispose();
  }

  /** Forward session reset to the T2 backend (which caches agents). */
  async resetSession(sessionKey: string): Promise<void> {
    await this.config.t2Backend.resetSession?.(sessionKey);
  }

  /**
   * Pre-load models on both Ollama instances so the first real request is fast.
   *
   * Sends a trivial chat request to each model, forcing Ollama to load it into
   * memory. Seeds health state based on the results. Blocks until both complete
   * (or fail). Call during boot before accepting requests.
   */
  async warmUp(): Promise<void> {
    const WARMUP_MSG: Array<{ role: "user"; content: string }> = [
      { role: "user", content: "hi" },
    ];

    const classifierWarmUp = async (): Promise<void> => {
      const start = performance.now();
      try {
        await ollamaChat({
          url: this.config.classifier.ollamaUrl,
          model: this.config.classifier.model,
          messages: WARMUP_MSG,
          numCtx: this.config.classifier.numCtx,
          timeoutMs: 15_000,
        });
        this.classifierHealth = { healthy: true, lastCheckedAt: Date.now() };
        const ms = Math.round(performance.now() - start);
        log("tiered_router.warmup.classifier_ready", {
          model: this.config.classifier.model,
          ms,
        });
      } catch (err) {
        this.classifierHealth = {
          healthy: false,
          lastCheckedAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        };
        logWarn("tiered_router.warmup.classifier_failed", {
          model: this.config.classifier.model,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const t1WarmUp = async (): Promise<void> => {
      const start = performance.now();
      try {
        await ollamaChat({
          url: this.config.t1.ollamaUrl,
          model: this.config.t1.model,
          messages: WARMUP_MSG,
          numCtx: this.config.t1.numCtx,
          timeoutMs: 30_000,
        });
        this.t1Health = { healthy: true, lastCheckedAt: Date.now() };
        const ms = Math.round(performance.now() - start);
        log("tiered_router.warmup.t1_ready", {
          model: this.config.t1.model,
          ms,
        });
      } catch (err) {
        this.t1Health = {
          healthy: false,
          lastCheckedAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        };
        logWarn("tiered_router.warmup.t1_failed", {
          model: this.config.t1.model,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    log("tiered_router.warmup.start", {
      classifier: `${this.config.classifier.ollamaUrl} (${this.config.classifier.model})`,
      t1: `${this.config.t1.ollamaUrl} (${this.config.t1.model})`,
    });

    await Promise.allSettled([classifierWarmUp(), t1WarmUp()]);
  }

  async ping(): Promise<void> {
    const classifierResult = await ollamaHealthCheck(
      this.config.classifier.ollamaUrl,
      this.config.classifier.model,
    );
    if (!classifierResult.ok) {
      logWarn("tiered_router.ping.classifier_unavailable", {
        error: classifierResult.error,
      });
    }

    const t1Result = await ollamaHealthCheck(
      this.config.t1.ollamaUrl,
      this.config.t1.model,
    );
    if (!t1Result.ok) {
      logWarn("tiered_router.ping.t1_unavailable", {
        error: t1Result.error,
      });
    }

    // T2 ping is required — if the cloud backend is down, we're fully degraded
    if (this.config.t2Backend.ping) {
      await this.config.t2Backend.ping();
    }
  }

  /** Abort a running request for the given session. */
  abort(sessionKey: string): void {
    const controller = this.activeRequests.get(sessionKey);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(sessionKey);
      return;
    }

    if (this.t2ActiveSessions.has(sessionKey)) {
      const backend = this.config.t2Backend as unknown as Record<
        string,
        unknown
      >;
      if (typeof backend.abort === "function") {
        (backend.abort as (key: string) => void)(sessionKey);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Health checks (separate state per Ollama instance + Engram)
  // ---------------------------------------------------------------------------

  private async isEngramHealthy(): Promise<boolean> {
    const now = Date.now();
    const age = now - this.engramHealth.lastCheckedAt;

    const ttl = this.engramHealth.healthy
      ? HEALTH_CHECK_INTERVAL_MS
      : HEALTH_RECHECK_INTERVAL_MS;
    if (age < ttl) {
      return this.engramHealth.healthy;
    }

    const result = await engramHealthCheck(this.config.engram.url);
    const wasUnhealthy = !this.engramHealth.healthy;

    this.engramHealth.healthy = result.ok;
    this.engramHealth.lastCheckedAt = now;
    this.engramHealth.error = result.ok ? undefined : result.error;

    if (result.ok && wasUnhealthy) {
      log("tiered_router.engram.recovered", {});
    } else if (!result.ok) {
      logWarn("tiered_router.engram.unhealthy", {
        error: result.error,
      });
    }

    return result.ok;
  }

  private async isClassifierHealthy(): Promise<boolean> {
    return this.checkOllamaHealth(
      this.classifierHealth,
      this.config.classifier.ollamaUrl,
      this.config.classifier.model,
      "tiered_router.classifier",
    );
  }

  private async isT1Healthy(): Promise<boolean> {
    return this.checkOllamaHealth(
      this.t1Health,
      this.config.t1.ollamaUrl,
      this.config.t1.model,
      "tiered_router.t1",
    );
  }

  private async checkOllamaHealth(
    state: HealthState,
    url: string,
    model: string,
    logPrefix: string,
  ): Promise<boolean> {
    const now = Date.now();
    const age = now - state.lastCheckedAt;

    const ttl = state.healthy
      ? HEALTH_CHECK_INTERVAL_MS
      : HEALTH_RECHECK_INTERVAL_MS;
    if (age < ttl) {
      return state.healthy;
    }

    const result = await ollamaHealthCheck(url, model);
    const wasUnhealthy = !state.healthy;

    state.healthy = result.ok;
    state.lastCheckedAt = now;
    state.error = result.ok ? undefined : result.error;

    if (result.ok && wasUnhealthy) {
      log(`${logPrefix}.recovered`, {});
    } else if (!result.ok) {
      logWarn(`${logPrefix}.unhealthy`, {
        error: result.error,
        fallback: "t2",
      });
    }

    return result.ok;
  }

  // ---------------------------------------------------------------------------
  // T1 handler (local Ollama)
  // ---------------------------------------------------------------------------

  private async handleT1(
    input: RespondInput,
    sessionKey: string,
    signal: AbortSignal,
    memoryContext?: string,
  ): Promise<ModelTurnResponse> {
    const { ollamaUrl, model, numCtx } = this.config.t1;

    const systemPrompt = memoryContext
      ? `${T1_SYSTEM_PROMPT}\n\n${memoryContext}`
      : T1_SYSTEM_PROMPT;

    log("tiered_router.t1.start", {
      sessionKey,
      model,
      promptChars: input.text.length,
      hasMemories: !!memoryContext,
    });

    const result = await ollamaChat({
      url: ollamaUrl,
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input.text },
      ],
      numCtx,
      signal,
    });

    log("tiered_router.t1.complete", {
      sessionKey,
      model,
      latencyMs: result.latencyMs,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      tokensPerSec: result.tokensPerSec,
    });

    return {
      replyText: result.text,
      sessionId: sessionKey,
      mode: "chat_reply",
      confidence: 1,
      tier: "t1",
      usage: {
        inputTokens: result.tokensIn,
        outputTokens: result.tokensOut,
        cost: 0,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // T2 handler (cloud model)
  // ---------------------------------------------------------------------------

  private async handleT2(
    input: RespondInput,
    sessionKey: string,
    reason: T2Reason,
  ): Promise<ModelTurnResponse> {
    log("tiered_router.t2.start", { sessionKey, reason });

    this.t2ActiveSessions.add(sessionKey);
    try {
      const response = await this.config.t2Backend.respond(input);

      log("tiered_router.t2.complete", {
        sessionKey,
        reason,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        cost: response.usage?.cost,
      });

      return { ...response, tier: "t2" };
    } finally {
      this.t2ActiveSessions.delete(sessionKey);
    }
  }
}
