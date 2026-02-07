import type {
  ExecutionPlanDraft,
  GenerateInput,
  GenerateResult,
  ModelTurnResponse,
} from "@delegate/domain";
import type { ModelPort, PlanInput, RespondInput } from "@delegate/ports";

type OpencodeModelAdapterOptions = {
  binaryPath?: string;
  model?: string;
  repoPath?: string;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const parseJsonObject = <T>(raw: string): T => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("Model returned empty output");
  }

  const normalized = trimmed.startsWith("```")
    ? trimmed
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim()
    : trimmed;

  return JSON.parse(normalized) as T;
};

const assertRepoRelativePath = (value: string): string => {
  const path = value.trim();
  if (path.length === 0) {
    throw new Error("Generated artifact path is empty");
  }
  if (path.startsWith("/") || path.startsWith("~") || path.includes("\\")) {
    throw new Error("Generated artifact path must be repo-relative");
  }
  if (path.split("/").some((segment) => segment === "..")) {
    throw new Error("Generated artifact path cannot escape repository root");
  }
  return path;
};

const toPlanPrompt = (input: PlanInput): string =>
  [
    "You are a planning assistant. Return strict JSON only.",
    "No markdown. No explanation.",
    "",
    "Return shape:",
    '{"intentSummary":"string","assumptions":["string"],"ambiguities":["string"],"proposedNextStep":"string","riskLevel":"LOW|MEDIUM|HIGH|CRITICAL","sideEffects":["none|local_code_changes|external_publish"],"requiresApproval":true|false}',
    "",
    `workItemId: ${input.workItemId}`,
    `request: ${input.text}`,
  ].join("\n");

const toGeneratePrompt = (input: GenerateInput): string =>
  [
    "You are a coding assistant. Return strict JSON only.",
    "No markdown. No explanation.",
    "Generate exactly one repo-relative file change.",
    "",
    "Return shape:",
    '{"artifact":{"path":"string","content":"string","summary":"string"}}',
    "",
    `workItemId: ${input.workItemId}`,
    `request: ${input.text}`,
    `intentSummary: ${input.plan.intentSummary}`,
    `proposedNextStep: ${input.plan.proposedNextStep}`,
    `riskLevel: ${input.plan.riskLevel}`,
    `sideEffects: ${input.plan.sideEffects.join(",")}`,
  ].join("\n");

const toRespondPrompt = (input: RespondInput): string =>
  [
    "You are a coding assistant over chat. Return strict JSON only.",
    "No markdown. No explanation.",
    "If request is conversational, return chat_reply.",
    "If request asks for concrete side-effecting implementation, return execution_proposal.",
    "For execution_proposal include one repo-relative artifact path.",
    "Confidence is 0..1.",
    "Return shape:",
    '{"mode":"chat_reply|execution_proposal","replyText":"string","confidence":0.0,"plan":{"intentSummary":"string","assumptions":["string"],"ambiguities":["string"],"proposedNextStep":"string","riskLevel":"LOW|MEDIUM|HIGH|CRITICAL","sideEffects":["none|local_code_changes|external_publish"],"requiresApproval":true|false},"artifact":{"path":"string","content":"string","summary":"string"}}',
    "Only include plan/artifact when mode=execution_proposal.",
    "",
    `chatId: ${input.chatId}`,
    `pendingProposalWorkItemId: ${input.pendingProposalWorkItemId ?? "none"}`,
    `message: ${input.text}`,
    `recentContext: ${input.context.join(" || ")}`,
  ].join("\n");

export class OpencodeCliModelAdapter implements ModelPort {
  private readonly binaryPath: string;
  private readonly model: string;
  private readonly repoPath: string;

  constructor(options: OpencodeModelAdapterOptions = {}) {
    this.binaryPath = options.binaryPath ?? "opencode";
    this.model = options.model ?? "openai/gpt-5.3-codex";
    this.repoPath = options.repoPath ?? process.cwd();
  }

  async respond(input: RespondInput): Promise<ModelTurnResponse> {
    const prompt = toRespondPrompt(input);
    const result = await this.runOpencode(prompt);
    if (result.exitCode !== 0) {
      throw new Error(this.formatExecutionFailure("respond", result));
    }

    const decoded = parseJsonObject<ModelTurnResponse>(result.stdout);
    if (
      !decoded ||
      (decoded.mode !== "chat_reply" &&
        decoded.mode !== "execution_proposal") ||
      typeof decoded.replyText !== "string" ||
      typeof decoded.confidence !== "number"
    ) {
      throw new Error("Model returned invalid respond JSON payload");
    }

    if (decoded.mode === "execution_proposal") {
      if (
        !decoded.plan ||
        !decoded.artifact ||
        !decoded.plan.intentSummary ||
        !Array.isArray(decoded.plan.assumptions) ||
        !Array.isArray(decoded.plan.ambiguities) ||
        !decoded.plan.proposedNextStep ||
        !Array.isArray(decoded.plan.sideEffects) ||
        typeof decoded.plan.requiresApproval !== "boolean"
      ) {
        throw new Error("Model returned invalid execution proposal payload");
      }
      decoded.artifact.path = assertRepoRelativePath(decoded.artifact.path);
    }

    return decoded;
  }

  async plan(input: PlanInput): Promise<ExecutionPlanDraft> {
    const prompt = toPlanPrompt(input);
    const result = await this.runOpencode(prompt);
    if (result.exitCode !== 0) {
      throw new Error(this.formatExecutionFailure("plan", result));
    }

    const decoded = parseJsonObject<ExecutionPlanDraft>(result.stdout);
    if (
      !decoded.intentSummary ||
      !Array.isArray(decoded.assumptions) ||
      !Array.isArray(decoded.ambiguities) ||
      !decoded.proposedNextStep ||
      !decoded.riskLevel ||
      !Array.isArray(decoded.sideEffects) ||
      typeof decoded.requiresApproval !== "boolean"
    ) {
      throw new Error("Model returned invalid plan JSON payload");
    }

    return decoded;
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const prompt = toGeneratePrompt(input);
    const result = await this.runOpencode(prompt);
    if (result.exitCode !== 0) {
      throw new Error(this.formatExecutionFailure("generate", result));
    }

    const decoded = parseJsonObject<GenerateResult>(result.stdout);
    if (
      !decoded.artifact ||
      typeof decoded.artifact.content !== "string" ||
      typeof decoded.artifact.summary !== "string" ||
      typeof decoded.artifact.path !== "string"
    ) {
      throw new Error("Model returned invalid generate JSON payload");
    }

    decoded.artifact.path = assertRepoRelativePath(decoded.artifact.path);
    return decoded;
  }

  private async runOpencode(prompt: string): Promise<CommandResult> {
    const proc = Bun.spawn({
      cmd: [this.binaryPath, "run", "--model", this.model, prompt],
      cwd: this.repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      stdout,
      stderr,
      exitCode,
    };
  }

  private formatExecutionFailure(
    step: "plan" | "generate" | "respond",
    result: CommandResult,
  ) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const details = stderr || stdout || "no output";
    return `opencode ${step} failed with exit=${result.exitCode}: ${details}`;
  }
}
