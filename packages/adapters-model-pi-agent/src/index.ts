import type { ModelTurnResponse } from "@delegate/domain";
import type { ModelPort, RespondInput } from "@delegate/ports";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import { loadSystemPrompt } from "./system-prompt";
import { createWorkspaceTools } from "./tools";
import type { PiAgentAdapterConfig } from "./types";

export { loadSystemPrompt } from "./system-prompt";
export { createWorkspaceTools } from "./tools";
export type { PiAgentAdapterConfig } from "./types";

const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes

type CachedAgent = { agent: Agent; lastUsedAt: number };

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
    this.evictIdleAgents();

    const existing = this.agents.get(sessionKey);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.agent;
    }

    const model = getModel(
      this.config.provider as any,
      this.config.model as any,
    );
    const systemPrompt = loadSystemPrompt({
      workspacePath: this.config.workspacePath,
      systemPromptPath: this.config.systemPromptPath,
      gitIdentity: this.config.gitIdentity,
    });
    const tools = createWorkspaceTools(this.config.workspacePath, {
      enableShellTool: this.config.enableShellTool,
    });

    const agent = new Agent({
      getApiKey: () => this.config.apiKey,
    });
    agent.setModel(model);
    agent.setSystemPrompt(systemPrompt);
    agent.setTools(tools);

    this.agents.set(sessionKey, { agent, lastUsedAt: Date.now() });
    return agent;
  }

  async respond(input: RespondInput): Promise<ModelTurnResponse> {
    const sessionKey =
      input.sessionId ?? `${input.chatId}:${input.threadId ?? "root"}`;
    const agent = this.getOrCreateAgent(sessionKey);

    // Update workspace-scoped tools if workspace changed
    if (input.workspacePath) {
      const tools = createWorkspaceTools(input.workspacePath, {
        enableShellTool: this.config.enableShellTool,
      });
      agent.setTools(tools);
      const systemPrompt = loadSystemPrompt({
        workspacePath: input.workspacePath,
        systemPromptPath: this.config.systemPromptPath,
        gitIdentity: this.config.gitIdentity,
      });
      agent.setSystemPrompt(systemPrompt);
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    let hasUsage = false;
    let stepCount = 0;

    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === "turn_end") {
        stepCount += 1;
        const msg = event.message as AssistantMessage;
        if (msg.role === "assistant" && msg.usage) {
          hasUsage = true;
          totalInputTokens += msg.usage.input;
          totalOutputTokens += msg.usage.output;
          totalCost += msg.usage.cost.total;
        }

        // Enforce max steps
        if (stepCount >= this.config.maxSteps) {
          agent.abort();
        }
      }
    });

    try {
      await agent.prompt(input.text);
    } catch (err) {
      unsubscribe();
      throw new Error(`Pi Agent error: ${String(err)}`, { cause: err });
    }

    unsubscribe();

    // Extract final text from agent messages
    const messages = agent.state.messages;
    const lastAssistant = [...messages]
      .reverse()
      .find(
        (m): m is AssistantMessage =>
          (m as AssistantMessage).role === "assistant",
      );

    const replyText =
      lastAssistant?.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n") || "(no response)";

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
    // Verify we can resolve the model
    try {
      getModel(this.config.provider as any, this.config.model as any);
    } catch (err) {
      throw new Error(`Pi Agent configuration error: ${String(err)}`, {
        cause: err,
      });
    }
  }
}
