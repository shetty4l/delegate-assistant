export type PiAgentAdapterConfig = {
  provider: string;
  model: string;
  apiKey?: string;
  maxSteps: number;
  workspacePath: string;
  systemPromptPath?: string;
  /** GitHub username used in the system prompt for git identity (e.g. "suyash-delegate"). */
  gitIdentity?: string;
  /** Enable the execute_shell tool (default: true). Set to false to disable arbitrary shell access. */
  enableShellTool?: boolean;
  /** Enable the web_fetch tool (default: true). Set to false to disable web access. */
  enableWebFetchTool?: boolean;
  /** Enable the web_search tool (default: true). Set to false to disable web search. */
  enableWebSearchTool?: boolean;
  /** Provider for the web_fetch summarizer model (default: same as `provider`). */
  webFetchProvider?: string;
  /** Model for the web_fetch summarizer (default: same as `model`). */
  webFetchModel?: string;
  /** Evict cached agents after this many ms of inactivity (default: 45 min). */
  agentIdleTimeoutMs?: number;
};
