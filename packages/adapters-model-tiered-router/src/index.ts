import type { ModelTurnResponse } from "@delegate/domain";
import type { ModelPort, RespondInput } from "@delegate/ports";
import { classify } from "./classifier";
import { engramRecall } from "./engram-client";
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

  constructor(config: TieredRouterConfig) {
    this.config = config;
  }

  async respond(input: RespondInput): Promise<ModelTurnResponse> {
    const respondStart = performance.now();
    const sessionKey =
      input.sessionId ?? `${input.chatId}:${input.threadId ?? "root"}`;
    const preview = promptPreview(input.text);

    // Step 1: Recall memories from Engram (fire-and-forget on failure)
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
    }

    const memoryContext = memories.formatted || undefined;

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
      return this.finalize(response, sessionKey, preview, respondStart);
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
      );
    } finally {
      this.activeRequests.delete(sessionKey);
    }
  }

  /** Log the end-to-end routing summary. */
  private finalize(
    response: ModelTurnResponse,
    sessionKey: string,
    preview: string,
    respondStart: number,
  ): ModelTurnResponse {
    const totalMs = Math.round(performance.now() - respondStart);
    log("tiered_router.respond.complete", {
      sessionKey,
      tier: response.tier,
      totalMs,
      prompt: preview,
    });
    return response;
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
  // Health checks (separate state per Ollama instance)
  // ---------------------------------------------------------------------------

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

    if (age < HEALTH_CHECK_INTERVAL_MS) {
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
