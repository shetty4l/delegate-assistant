import type { ModelTurnResponse } from "@delegate/domain";
import { classifyModelError, ModelError } from "@delegate/domain";
import type { ModelPort, RespondInput } from "@delegate/ports";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, KnownProvider } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import { loadSystemPrompt } from "./system-prompt";
import { createWorkspaceTools } from "./tools";
import type { PiAgentAdapterConfig } from "./types";

export { loadSystemPrompt } from "./system-prompt";
export { createWorkspaceTools } from "./tools";
export type { PiAgentAdapterConfig } from "./types";

const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes
const EVICTION_SIZE_THRESHOLD = 50;

const nowIso = (): string => new Date().toISOString();

type CachedAgent = { agent: Agent; lastUsedAt: number; workspacePath: string };

export class PiAgentModelAdapter implements ModelPort {
  private readonly config: PiAgentAdapterConfig;
  private readonly agents = new Map<string, CachedAgent>();

  constructor(config: PiAgentAdapterConfig) {
    this.config = config;
  }

  private evictIdleAgents(): void {
    const ttl = this.config.agentIdleTimeoutMs ?? DEFAULT_AGENT_IDLE_TIMEOUT_MS;
    const now = Date.now();
    for (const [key, entry] of this.agents) {
      if (now - entry.lastUsedAt > ttl) {
        this.agents.delete(key);
      }
    }
  }

  private getOrCreateAgent(sessionKey: string): Agent {
    if (this.agents.size > EVICTION_SIZE_THRESHOLD) {
      this.evictIdleAgents();
    }

    const existing = this.agents.get(sessionKey);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.agent;
    }

    // Cast needed: provider/model are dynamic strings, but getModel() requires
    // specific literal types from its KnownProvider + model-id generic params.
    const provider: KnownProvider = this.config.provider as KnownProvider;
    const model = getModel(provider as any, this.config.model as any);
    if (!model) {
      throw new Error(
        `Model "${this.config.model}" not found in provider "${this.config.provider}" registry. ` +
          `Check that piAgentProvider and piAgentModel are valid in your config.`,
      );
    }
    const systemPrompt = loadSystemPrompt({
      workspacePath: this.config.workspacePath,
      systemPromptPath: this.config.systemPromptPath,
      gitIdentity: this.config.gitIdentity,
    });
    const tools = createWorkspaceTools(this.config.workspacePath, {
      enableShellTool: this.config.enableShellTool,
      enableWebFetchTool: this.config.enableWebFetchTool,
      enableWebSearchTool: this.config.enableWebSearchTool,
      webFetchConfig: {
        provider: this.config.webFetchProvider ?? this.config.provider,
        model: this.config.webFetchModel ?? this.config.model,
        getApiKey: () => this.config.apiKey,
        sessionKey,
      },
    });

    const agent = new Agent({
      getApiKey: () => this.config.apiKey,
    });
    agent.setModel(model);
    agent.setSystemPrompt(systemPrompt);
    agent.setTools(tools);

    this.agents.set(sessionKey, {
      agent,
      lastUsedAt: Date.now(),
      workspacePath: this.config.workspacePath,
    });
    return agent;
  }

  async respond(input: RespondInput): Promise<ModelTurnResponse> {
    const sessionKey =
      input.sessionId ?? `${input.chatId}:${input.threadId ?? "root"}`;
    const agent = this.getOrCreateAgent(sessionKey);

    // Update workspace-scoped tools only if workspace actually changed
    if (input.workspacePath) {
      const cached = this.agents.get(sessionKey);
      if (cached && cached.workspacePath !== input.workspacePath) {
        const tools = createWorkspaceTools(input.workspacePath, {
          enableShellTool: this.config.enableShellTool,
          enableWebFetchTool: this.config.enableWebFetchTool,
          enableWebSearchTool: this.config.enableWebSearchTool,
          webFetchConfig: {
            provider: this.config.webFetchProvider ?? this.config.provider,
            model: this.config.webFetchModel ?? this.config.model,
            getApiKey: () => this.config.apiKey,
            sessionKey,
          },
        });
        agent.setTools(tools);
        const systemPrompt = loadSystemPrompt({
          workspacePath: input.workspacePath,
          systemPromptPath: this.config.systemPromptPath,
          gitIdentity: this.config.gitIdentity,
        });
        agent.setSystemPrompt(systemPrompt);
        cached.workspacePath = input.workspacePath;
      }
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    let hasUsage = false;
    let stepCount = 0;

    const sink = this.config.turnEventSink;
    const turnId = crypto.randomUUID();

    const emitEvent = (
      eventType: import("@delegate/domain").TurnEventType,
      data: Record<string, unknown>,
    ): void => {
      if (!sink) {
        return;
      }
      sink
        .emit({
          turnId,
          sessionKey,
          eventType,
          timestamp: nowIso(),
          data,
        })
        .catch((err: unknown) => {
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "turn_event_sink.emit_failed",
              error: String(err),
            }),
          );
        });
    };

    emitEvent("turn_started", { inputText: input.text });

    let abortedByMaxSteps = false;
    let partialText = "";

    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === "tool_execution_start") {
        emitEvent("tool_call", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
      }

      if (event.type === "tool_execution_end") {
        emitEvent("tool_result", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        });
      }

      if (event.type === "turn_end") {
        stepCount += 1;
        const msg = event.message as AssistantMessage;
        if (msg.role === "assistant" && msg.usage) {
          hasUsage = true;
          totalInputTokens += msg.usage.input;
          totalOutputTokens += msg.usage.output;
          totalCost += msg.usage.cost.total;
        }

        // Accumulate partial text for max-steps degraded success
        if (msg.role === "assistant" && msg.content) {
          const stepText = msg.content
            .filter(
              (c): c is { type: "text"; text: string } => c.type === "text",
            )
            .map((c) => c.text)
            .join("\n");
          if (stepText) {
            partialText = stepText;
          }
        }

        // 2e: Detect step-level errors from the provider
        if (msg.stopReason === "error") {
          emitEvent("step_error", {
            stepCount,
            errorMessage: msg.errorMessage ?? "unknown error",
          });
        }

        emitEvent("step_complete", {
          stepCount,
          inputTokens: msg.usage?.input ?? 0,
          outputTokens: msg.usage?.output ?? 0,
          cost: msg.usage?.cost.total ?? 0,
        });

        // Enforce max steps
        if (stepCount >= this.config.maxSteps) {
          abortedByMaxSteps = true;
          agent.abort();
        }
      }
    });

    try {
      await agent.prompt(input.text);
    } catch (err) {
      unsubscribe();
      emitEvent("turn_failed", {
        error: String(err),
        totalInputTokens,
        totalOutputTokens,
        totalCost,
        stepCount,
      });
      throw new Error(`Pi Agent error: ${String(err)}`, { cause: err });
    }

    unsubscribe();

    // 2a: Detect LLM errors that pi-agent-core swallows silently
    // The library catches API errors internally, creates a synthetic
    // AssistantMessage with stopReason: "error" and errorMessage, and
    // resolves prompt() normally without throwing.
    const messages = agent.state.messages;
    const lastAssistant = [...messages]
      .reverse()
      .find(
        (m): m is AssistantMessage =>
          (m as AssistantMessage).role === "assistant",
      );

    const errorSource =
      agent.state.error ?? lastAssistant?.errorMessage ?? null;
    const isErrorStop = lastAssistant?.stopReason === "error";

    if (errorSource || isErrorStop) {
      const rawMessage = String(errorSource || "unknown model error");
      const classification = classifyModelError(rawMessage);
      emitEvent("turn_failed", {
        error: rawMessage,
        classification,
        totalInputTokens,
        totalOutputTokens,
        totalCost,
        stepCount,
      });
      throw new ModelError(classification, rawMessage);
    }

    // 2b: Max-steps produces a degraded success, not an error
    if (abortedByMaxSteps && partialText) {
      const truncatedReply = `${partialText}\n\n---\n(Reached max steps; response may be incomplete)`;
      emitEvent("turn_completed", {
        replyText: truncatedReply,
        truncated: true,
        totalInputTokens,
        totalOutputTokens,
        totalCost,
        stepCount,
      });

      const result: ModelTurnResponse = {
        mode: "chat_reply",
        confidence: 1,
        replyText: truncatedReply,
        sessionId: sessionKey,
      };
      if (hasUsage) {
        result.usage = {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cost: totalCost,
        };
      }
      return result;
    }

    // Normal success path
    const replyText =
      lastAssistant?.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n") || "(no response)";

    emitEvent("turn_completed", {
      replyText,
      totalInputTokens,
      totalOutputTokens,
      totalCost,
      stepCount,
    });

    const result: ModelTurnResponse = {
      mode: "chat_reply",
      confidence: 1,
      replyText,
      sessionId: sessionKey,
    };

    if (hasUsage) {
      result.usage = {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cost: totalCost,
      };
    }

    return result;
  }

  async ping(): Promise<void> {
    // Verify we can resolve the model — getModel() returns undefined on miss
    const model = getModel(
      this.config.provider as any,
      this.config.model as any,
    );
    if (!model) {
      throw new Error(
        `Pi Agent configuration error: Model "${this.config.model}" not found in provider "${this.config.provider}" registry. ` +
          `Check that piAgentProvider and piAgentModel are valid in your config.`,
      );
    }
  }

  /** Abort a running agent session. Safe to call if no session is active. */
  abort(sessionKey: string): void {
    const cached = this.agents.get(sessionKey);
    if (cached) {
      cached.agent.abort();
    }
  }
}
