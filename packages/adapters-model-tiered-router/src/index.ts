import type { ModelTurnResponse } from "@delegate/domain";
import type { ModelPort, RespondInput } from "@delegate/ports";
import { ollamaChat, ollamaHealthCheck } from "./ollama-client";
import { T1_SYSTEM_PROMPT } from "./system-prompt";
import type { HealthState, TieredRouterConfig } from "./types";

export type {
  ClassifierConfig,
  EngramConfig,
  HealthState,
  T1Config,
  TieredRouterConfig,
} from "./types";

const HEALTH_CHECK_INTERVAL_MS = 30_000;

const log = (event: string, fields: Record<string, unknown>): void => {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
};

const logWarn = (event: string, fields: Record<string, unknown>): void => {
  console.warn(JSON.stringify({ level: "warn", event, ...fields }));
};

/**
 * Tiered model router that implements ModelPort.
 *
 * Routes requests to T1 (local Ollama) when healthy, falling back to
 * T2 (cloud model via injected ModelPort) when T1 is unreachable.
 */
export class TieredRouterAdapter implements ModelPort {
  private readonly config: TieredRouterConfig;

  /** AbortControllers for T1 requests, keyed by session. */
  private readonly activeRequests = new Map<string, AbortController>();

  /** Sessions currently being handled by T2, for abort forwarding. */
  private readonly t2ActiveSessions = new Set<string>();

  /** Cached T1 Ollama health state. */
  private t1Health: HealthState = {
    healthy: true,
    lastCheckedAt: 0,
  };

  constructor(config: TieredRouterConfig) {
    this.config = config;
  }

  async respond(input: RespondInput): Promise<ModelTurnResponse> {
    const sessionKey =
      input.sessionId ?? `${input.chatId}:${input.threadId ?? "root"}`;

    // Check if T1 is healthy before attempting local inference
    const t1Available = await this.isT1Healthy();

    if (!t1Available) {
      return this.handleT2(input, sessionKey, "t1_unhealthy");
    }

    // Attempt T1, fall back to T2 on error
    const abortController = new AbortController();
    this.activeRequests.set(sessionKey, abortController);

    try {
      return await this.handleT1(input, sessionKey, abortController.signal);
    } catch (error) {
      // If the request was intentionally aborted, don't fall back
      if (abortController.signal.aborted) {
        throw error;
      }

      // T1 failed unexpectedly — mark unhealthy and fall back to T2
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

      return this.handleT2(input, sessionKey, "t1_error");
    } finally {
      this.activeRequests.delete(sessionKey);
    }
  }

  async ping(): Promise<void> {
    const t1Result = await ollamaHealthCheck(
      this.config.t1.ollamaUrl,
      this.config.t1.model,
    );

    // T1 failure is non-fatal for ping — we can still operate via T2
    if (!t1Result.ok) {
      logWarn("tiered_router.ping.t1_unavailable", {
        error: t1Result.error,
      });
    }

    // T2 ping is required — if the cloud backend is down, we're degraded
    if (this.config.t2Backend.ping) {
      await this.config.t2Backend.ping();
    }
  }

  /** Abort a running request for the given session. */
  abort(sessionKey: string): void {
    // Try aborting T1 (Ollama fetch)
    const controller = this.activeRequests.get(sessionKey);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(sessionKey);
      return;
    }

    // Try forwarding abort to T2 backend
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
  // Health check
  // ---------------------------------------------------------------------------

  private async isT1Healthy(): Promise<boolean> {
    const now = Date.now();
    const age = now - this.t1Health.lastCheckedAt;

    // Use cached result if fresh enough
    if (age < HEALTH_CHECK_INTERVAL_MS) {
      return this.t1Health.healthy;
    }

    // Perform a fresh health check
    const result = await ollamaHealthCheck(
      this.config.t1.ollamaUrl,
      this.config.t1.model,
    );

    const wasUnhealthy = !this.t1Health.healthy;

    this.t1Health = {
      healthy: result.ok,
      lastCheckedAt: now,
      error: result.ok ? undefined : result.error,
    };

    if (result.ok && wasUnhealthy) {
      log("tiered_router.t1.recovered", {});
    } else if (!result.ok) {
      logWarn("tiered_router.t1.unhealthy", {
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
  ): Promise<ModelTurnResponse> {
    const { ollamaUrl, model, numCtx } = this.config.t1;

    log("tiered_router.t1.start", {
      sessionKey,
      model,
      promptChars: input.text.length,
    });

    const result = await ollamaChat({
      url: ollamaUrl,
      model,
      messages: [
        { role: "system", content: T1_SYSTEM_PROMPT },
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
      usage: {
        inputTokens: result.tokensIn,
        outputTokens: result.tokensOut,
        cost: 0,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // T2 handler (cloud model fallback)
  // ---------------------------------------------------------------------------

  private async handleT2(
    input: RespondInput,
    sessionKey: string,
    reason: "t1_unhealthy" | "t1_error",
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

      return response;
    } finally {
      this.t2ActiveSessions.delete(sessionKey);
    }
  }
}
