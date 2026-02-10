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
  /** Evict cached agents after this many ms of inactivity (default: 45 min). */
  agentIdleTimeoutMs?: number;
  /** Substring patterns to block in shell commands. A command containing any pattern is rejected. */
  shellCommandDenylist?: string[];
};
