import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

const MAX_FILE_SIZE = 256 * 1024; // 256 KB

/**
 * A denylist entry pairs a regex pattern with a human-readable label
 * so error messages shown to the LLM remain understandable.
 */
export type DenylistEntry = {
  readonly pattern: RegExp;
  readonly label: string;
};

/**
 * Hardcoded patterns blocked from execute_shell.
 * Uses regex with word boundaries to avoid false positives on legitimate
 * commands like `rm -rf /tmp/build` or variable names like `halt_processing`.
 */
export const SHELL_COMMAND_DENYLIST: readonly DenylistEntry[] = [
  { pattern: /\brm\s+-rf\s+\/(?!\S)/, label: "rm -rf /" },
  { pattern: /\bmkfs\b/, label: "mkfs" },
  { pattern: /\bdd\s+if=\/dev\//, label: "dd if=/dev/" },
  { pattern: /\bshutdown\b/, label: "shutdown" },
  { pattern: /\breboot\b/, label: "reboot" },
  { pattern: /\bhalt\b/, label: "halt" },
  { pattern: /\bpoweroff\b/, label: "poweroff" },
  { pattern: /:\(\)\{.*:\|:&\};:/, label: "fork bomb" },
  { pattern: />\s*\/dev\/sd/, label: "> /dev/sd*" },
  { pattern: /\bchmod\s+-R\s+777\s+\/(?!\S)/, label: "chmod -R 777 /" },
  { pattern: /\bchown\s+-R\s+\S+\s+\/(?!\S)/, label: "chown -R ... /" },
  { pattern: /\bmv\s+\/\s/, label: "mv /" },
  { pattern: /\bwget\b.*\|\s*\bsh\b/, label: "wget | sh" },
  { pattern: /\bcurl\b.*\|\s*\bsh\b/, label: "curl | sh" },
];

/**
 * Returns the human-readable label of the first denylist entry matched by the
 * command, or null if the command is allowed.
 */
export const matchesDenylist = (
  command: string,
  denylist: readonly DenylistEntry[] = SHELL_COMMAND_DENYLIST,
): string | null => {
  for (const entry of denylist) {
    if (entry.pattern.test(command)) {
      return entry.label;
    }
  }
  return null;
};

/**
 * Env vars that are safe to expose to AI-spawned shell commands.
 * Notably excludes TELEGRAM_BOT_TOKEN, PI_AGENT_API_KEY, and other secrets.
 */
const SHELL_ENV_ALLOWLIST = [
  // System essentials
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  // Bun/Node toolchain
  "BUN_INSTALL",
  "NODE_PATH",
  // Git identity (set via secrets.env on the delegate's process)
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

/**
 * Build a sanitized environment for AI-spawned shell commands.
 * Only allowlisted vars are passed through. DELEGATE_GITHUB_TOKEN is
 * re-mapped to GH_TOKEN so `gh` CLI uses the delegate's identity.
 */
export const buildShellEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of SHELL_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Map DELEGATE_GITHUB_TOKEN -> GH_TOKEN for gh CLI auth
  const ghToken = process.env.DELEGATE_GITHUB_TOKEN;
  if (ghToken) {
    env.GH_TOKEN = ghToken;
  }
  return env;
};

const isWithinWorkspace = (
  workspacePath: string,
  targetPath: string,
): boolean => {
  const resolvedTarget = resolve(workspacePath, targetPath);
  const resolvedWorkspace = resolve(workspacePath);
  return (
    resolvedTarget === resolvedWorkspace ||
    resolvedTarget.startsWith(`${resolvedWorkspace}/`)
  );
};

const resolveSafePath = (
  workspacePath: string,
  userPath: string,
): string | null => {
  const target = isAbsolute(userPath)
    ? userPath
    : resolve(workspacePath, userPath);
  if (!isWithinWorkspace(workspacePath, target)) {
    return null;
  }
  // Resolve symlinks on existing paths to prevent symlink escapes
  try {
    const real = realpathSync(target);
    return isWithinWorkspace(workspacePath, real) ? real : null;
  } catch (err: unknown) {
    // Path doesn't exist yet (e.g. write_file creating a new file).
    // Check the parent directory for symlink escapes instead.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        const realParent = realpathSync(dirname(target));
        return isWithinWorkspace(workspacePath, realParent)
          ? resolve(realParent, basename(target))
          : null;
      } catch {
        // Parent also doesn't exist — fall back to the initial resolve-only check
        // which already passed the isWithinWorkspace test above.
        return target;
      }
    }
    // Permission errors or other OS failures → deny
    return null;
  }
};

const textResult = (text: string): AgentToolResult<void> => ({
  content: [{ type: "text", text }],
  details: undefined,
});

const errorResult = (text: string): AgentToolResult<void> => ({
  content: [{ type: "text", text: `Error: ${text}` }],
  details: undefined,
});

export const createReadFileTool = (workspacePath: string): AgentTool<any> => ({
  name: "read_file",
  label: "Read File",
  description:
    "Read the contents of a file at the given path relative to the workspace.",
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to workspace" }),
  }),
  execute: async (_toolCallId, params: { path: string }) => {
    const safePath = resolveSafePath(workspacePath, params.path);
    if (!safePath) {
      return errorResult("Path is outside the workspace. Access denied.");
    }
    try {
      const content = readFileSync(safePath, "utf8");
      if (content.length > MAX_FILE_SIZE) {
        return textResult(
          `${content.slice(0, MAX_FILE_SIZE)}\n\n[truncated: file exceeds ${MAX_FILE_SIZE} bytes]`,
        );
      }
      return textResult(content);
    } catch (err) {
      return errorResult(`Failed to read file: ${String(err)}`);
    }
  },
});

export const createWriteFileTool = (workspacePath: string): AgentTool<any> => ({
  name: "write_file",
  label: "Write File",
  description:
    "Write content to a file at the given path relative to the workspace. Creates parent directories as needed.",
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to workspace" }),
    content: Type.String({ description: "File content to write" }),
  }),
  execute: async (_toolCallId, params: { path: string; content: string }) => {
    const safePath = resolveSafePath(workspacePath, params.path);
    if (!safePath) {
      return errorResult("Path is outside the workspace. Access denied.");
    }
    try {
      mkdirSync(dirname(safePath), { recursive: true });
      writeFileSync(safePath, params.content, "utf8");
      return textResult(
        `Wrote ${params.content.length} bytes to ${params.path}`,
      );
    } catch (err) {
      return errorResult(`Failed to write file: ${String(err)}`);
    }
  },
});

/**
 * Security note: execute_shell gives the AI agent unrestricted command
 * execution via `bash -c`. While the env allowlist (SHELL_ENV_ALLOWLIST)
 * prevents secret leakage and the workdir is scoped to the workspace,
 * the command itself is NOT sandboxed -- the agent can read files outside
 * the workspace, access the network, or run arbitrary programs.
 *
 * This is an intentional design choice for a single-user, trusted
 * deployment (personal assistant on a private machine). If exposed to
 * untrusted users, disable this tool via `enableShellTool: false` in
 * the adapter config or `PI_AGENT_ENABLE_SHELL_TOOL=false` env var.
 */
export const createExecuteShellTool = (
  workspacePath: string,
  timeoutMs = 30_000,
): AgentTool<any> => ({
  name: "execute_shell",
  label: "Execute Shell",
  description:
    "Execute a shell command in the workspace directory. Returns stdout and stderr.",
  parameters: Type.Object({
    command: Type.String({ description: "Shell command to execute" }),
    workdir: Type.Optional(
      Type.String({
        description:
          "Working directory relative to workspace (defaults to workspace root)",
      }),
    ),
  }),
  execute: async (
    _toolCallId,
    params: { command: string; workdir?: string },
  ) => {
    const blocked = matchesDenylist(params.command);
    if (blocked) {
      return errorResult(
        `Command blocked by denylist (matched pattern: "${blocked}"). This command is not allowed.`,
      );
    }
    let cwd = workspacePath;
    if (params.workdir) {
      const safeCwd = resolveSafePath(workspacePath, params.workdir);
      if (!safeCwd) {
        return errorResult(
          "Working directory is outside the workspace. Access denied.",
        );
      }
      cwd = safeCwd;
    }
    try {
      const proc = Bun.spawn({
        cmd: ["bash", "-c", params.command],
        cwd,
        env: buildShellEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });

      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // no-op
          }
          reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      const [stdout, stderr, exitCode] = await Promise.race([
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]),
        timeoutPromise,
      ]);
      if (timer) clearTimeout(timer);

      const parts: string[] = [];
      if (stdout.trim()) parts.push(`stdout:\n${stdout.trim()}`);
      if (stderr.trim()) parts.push(`stderr:\n${stderr.trim()}`);
      parts.push(`exit code: ${exitCode}`);
      return textResult(parts.join("\n\n"));
    } catch (err) {
      return errorResult(`Shell execution failed: ${String(err)}`);
    }
  },
});

export const createListDirectoryTool = (
  workspacePath: string,
): AgentTool<any> => ({
  name: "list_directory",
  label: "List Directory",
  description:
    "List the contents of a directory relative to the workspace. Defaults to workspace root.",
  parameters: Type.Object({
    path: Type.Optional(
      Type.String({
        description:
          "Directory path relative to workspace (defaults to workspace root)",
      }),
    ),
  }),
  execute: async (_toolCallId, params: { path?: string }) => {
    const targetPath = params.path || ".";
    const safePath = resolveSafePath(workspacePath, targetPath);
    if (!safePath) {
      return errorResult("Path is outside the workspace. Access denied.");
    }
    try {
      const entries = readdirSync(safePath, { withFileTypes: true });
      const formatted = entries
        .map((entry) => {
          const suffix = entry.isDirectory() ? "/" : "";
          return `${entry.name}${suffix}`;
        })
        .join("\n");
      return textResult(formatted || "(empty directory)");
    } catch (err) {
      return errorResult(`Failed to list directory: ${String(err)}`);
    }
  },
});

export const createSearchFilesTool = (
  workspacePath: string,
): AgentTool<any> => ({
  name: "search_files",
  label: "Search Files",
  description:
    "Search file contents using a regex pattern within the workspace. Returns matching lines with context.",
  parameters: Type.Object({
    pattern: Type.String({ description: "Regex pattern to search for" }),
    path: Type.Optional(
      Type.String({
        description:
          "Directory to search in, relative to workspace (defaults to workspace root)",
      }),
    ),
  }),
  execute: async (_toolCallId, params: { pattern: string; path?: string }) => {
    const searchDir = params.path || ".";
    const safePath = resolveSafePath(workspacePath, searchDir);
    if (!safePath) {
      return errorResult("Path is outside the workspace. Access denied.");
    }
    try {
      const proc = Bun.spawn({
        cmd: ["grep", "-rn", "-E", params.pattern, safePath],
        cwd: workspacePath,
        env: buildShellEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });

      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeoutMs = 30_000;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // no-op
          }
          reject(new Error(`Search timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      const [stdout] = await Promise.race([
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]),
        timeoutPromise,
      ]);
      if (timer) clearTimeout(timer);

      if (!stdout.trim()) {
        return textResult("No matches found.");
      }

      // relativize paths
      const lines = stdout
        .trim()
        .split("\n")
        .map((line) => {
          const resolvedWorkspace = resolve(workspacePath);
          if (line.startsWith(resolvedWorkspace)) {
            return line.slice(resolvedWorkspace.length + 1);
          }
          return line;
        })
        .slice(0, 100);

      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(`Search failed: ${String(err)}`);
    }
  },
});

export type WorkspaceToolOptions = {
  /** Enable the execute_shell tool (default: true). */
  enableShellTool?: boolean;
};

export const createWorkspaceTools = (
  workspacePath: string,
  options: WorkspaceToolOptions = {},
): AgentTool<any>[] => {
  // Resolve workspace symlinks once at construction time so all tools
  // use the real path for bounds checks (e.g. /tmp -> /private/tmp on macOS).
  let realWorkspacePath: string;
  try {
    realWorkspacePath = realpathSync(workspacePath);
  } catch {
    realWorkspacePath = resolve(workspacePath);
  }
  const { enableShellTool = true } = options;
  const tools: AgentTool<any>[] = [
    createReadFileTool(realWorkspacePath),
    createWriteFileTool(realWorkspacePath),
    createListDirectoryTool(realWorkspacePath),
    createSearchFilesTool(realWorkspacePath),
  ];
  if (enableShellTool) {
    tools.splice(2, 0, createExecuteShellTool(realWorkspacePath));
  }
  return tools;
};
