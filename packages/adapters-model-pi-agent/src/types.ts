export type PiAgentAdapterConfig = {
  provider: string;
  model: string;
  apiKey?: string;
  maxSteps: number;
  workspacePath: string;
  systemPromptPath?: string;
  /** Evict cached agents after this many ms of inactivity (default: 45 min). */
  agentIdleTimeoutMs?: number;
};
