import type { ModelTurnResponse } from "@delegate/domain";
import type { ModelPort, RespondInput } from "@delegate/ports";

type OpencodeModelAdapterOptions = {
  binaryPath?: string;
  model?: string;
  repoPath?: string;
  attachUrl?: string | null;
  responseTimeoutMs?: number;
};

type SessionCommandResult = {
  textOutput: string;
  sessionId: string | null;
  stderr: string;
  exitCode: number;
};

export class OpencodeCliModelAdapter implements ModelPort {
  private readonly binaryPath: string;
  private readonly model: string;
  private readonly repoPath: string;
  private readonly attachUrl: string | null;
  private readonly responseTimeoutMs: number;

  constructor(options: OpencodeModelAdapterOptions = {}) {
    this.binaryPath = options.binaryPath ?? "opencode";
    this.model = options.model ?? "openai/gpt-5.3-codex";
    this.repoPath = options.repoPath ?? process.cwd();
    this.attachUrl = options.attachUrl ?? null;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 30_000;
  }

  async respond(input: RespondInput): Promise<ModelTurnResponse> {
    const result = await this.runOpencodeSession(
      input.text,
      input.sessionId ?? null,
    );
    if (result.exitCode !== 0) {
      const details = result.stderr.trim() || result.textOutput || "no output";
      throw new Error(
        `opencode relay failed with exit=${result.exitCode}: ${details}`,
      );
    }

    if (!result.textOutput) {
      throw new Error(
        "opencode relay produced no user-facing text output (possibly blocked tool call)",
      );
    }

    return {
      mode: "chat_reply",
      replyText: result.textOutput || "(no response)",
      confidence: 1,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    };
  }

  async ping(): Promise<void> {
    if (this.attachUrl) {
      const result = await this.runOpencodeSession(
        "Reply with exactly: pong",
        null,
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || "opencode attach check failed");
      }
      return;
    }

    const proc = Bun.spawn({
      cmd: [this.binaryPath, "--version"],
      cwd: this.repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error("opencode binary is not ready");
    }
  }

  private async runOpencodeSession(
    message: string,
    sessionId: string | null,
  ): Promise<SessionCommandResult> {
    const cmd = [
      this.binaryPath,
      "run",
      "--model",
      this.model,
      "--format",
      "json",
    ];
    if (this.attachUrl) {
      cmd.push("--attach", this.attachUrl);
    }
    if (sessionId) {
      cmd.push("--session", sessionId);
    }
    cmd.push(message);

    const proc = Bun.spawn({
      cmd,
      cwd: this.repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      [stdout, stderr, exitCode] = await Promise.race([
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            try {
              proc.kill();
            } catch {
              // no-op
            }
            reject(
              new Error(
                `opencode relay timed out after ${this.responseTimeoutMs}ms`,
              ),
            );
          }, this.responseTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }

    let parsedSessionId: string | null = null;
    const textParts: string[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const event = JSON.parse(trimmed) as {
          sessionID?: string;
          type?: string;
          part?: { text?: string };
        };
        if (typeof event.sessionID === "string" && event.sessionID.length > 0) {
          parsedSessionId = event.sessionID;
        }
        if (event.type === "text" && typeof event.part?.text === "string") {
          textParts.push(event.part.text);
        }
      } catch {
        // ignore non-json lines
      }
    }

    return {
      textOutput: textParts.join("\n").trim(),
      sessionId: parsedSessionId,
      stderr,
      exitCode,
    };
  }
}
