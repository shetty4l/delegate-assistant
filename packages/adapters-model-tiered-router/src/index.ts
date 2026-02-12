import type { ModelTurnResponse } from "@delegate/domain";
import type { ModelPort, RespondInput } from "@delegate/ports";
import { ollamaChat, ollamaHealthCheck } from "./ollama-client";
import { T1_SYSTEM_PROMPT } from "./system-prompt";
import type { TieredRouterConfig } from "./types";

export type {
  ClassifierConfig,
  EngramConfig,
  T1Config,
  TieredRouterConfig,
} from "./types";

const log = (event: string, fields: Record<string, unknown>): void => {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
};

/**
 * Tiered model router that implements ModelPort.
 *
 * Slice 1: Always routes to T1 (Ollama) for all requests.
 * Future slices add T0 classification, T2 fallback, and Engram augmentation.
 */
export class TieredRouterAdapter implements ModelPort {
  private readonly config: TieredRouterConfig;
  private readonly activeRequests = new Map<string, AbortController>();

  constructor(config: TieredRouterConfig) {
    this.config = config;
  }

  async respond(input: RespondInput): Promise<ModelTurnResponse> {
    const sessionKey =
      input.sessionId ?? `${input.chatId}:${input.threadId ?? "root"}`;

    const abortController = new AbortController();
    this.activeRequests.set(sessionKey, abortController);

    try {
      return await this.handleT1(input, sessionKey, abortController.signal);
    } finally {
      this.activeRequests.delete(sessionKey);
    }
  }

  async ping(): Promise<void> {
    const { ollamaUrl, model } = this.config.t1;
    const result = await ollamaHealthCheck(ollamaUrl, model);
    if (!result.ok) {
      throw new Error(`T1 health check failed: ${result.error}`);
    }
  }

  /** Abort a running request for the given session. */
  abort(sessionKey: string): void {
    const controller = this.activeRequests.get(sessionKey);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(sessionKey);
    }
  }

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
}
