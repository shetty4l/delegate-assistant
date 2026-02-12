import { ollamaChat } from "./ollama-client";
import type { ClassificationResult, ClassifierConfig } from "./types";

const CLASSIFIER_TIMEOUT_MS = 2_000;

const CLASSIFIER_SYSTEM_PROMPT = `You are a request classifier for a personal assistant. Analyze the user's message and determine which model tier should handle it.

Tiers:
- T1: Simple tasks requiring no tools. Questions, explanations, drafting, summarizing, brainstorming, planning, conversational replies, general knowledge.
- T2: Complex tasks requiring tools or workspace access. Code changes, file operations, git workflows, web search, shell commands, multi-step implementation tasks.

Signals for T2:
- References to files, code, repositories, branches, PRs, or commits
- Requests to create, fix, implement, deploy, build, test, or refactor code
- Needs web search, file reading/writing, or shell execution
- Multi-step tasks that require planning AND execution

Respond with ONLY valid JSON, no other text:
{"tier":"t1","confidence":0.85,"reason":"general knowledge question","category":"knowledge"}

Categories: knowledge, drafting, planning, conversational, code_change, tool_needed, analysis`;

/**
 * Extract a JSON object from a model response that may contain
 * markdown fences, leading/trailing text, or other noise.
 */
export function extractJson(text: string): string {
  // Try markdown code fence first: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Try to find a raw JSON object
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    return braceMatch[0].trim();
  }

  return text.trim();
}

/**
 * Parse and validate a classifier response into a ClassificationResult.
 * Throws if the response cannot be parsed or is missing required fields.
 */
function parseClassification(raw: string): ClassificationResult {
  const jsonStr = extractJson(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Classifier output is not valid JSON: ${jsonStr}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Classifier output is not a JSON object: ${jsonStr}`);
  }

  const obj = parsed as Record<string, unknown>;

  const tier = obj.tier;
  if (tier !== "t1" && tier !== "t2") {
    throw new Error(
      `Classifier returned invalid tier "${String(tier)}", expected "t1" or "t2"`,
    );
  }

  const confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(
      `Classifier returned invalid confidence "${String(obj.confidence)}", expected 0.0-1.0`,
    );
  }

  const reason =
    typeof obj.reason === "string" ? obj.reason : String(obj.reason ?? "");
  const category =
    typeof obj.category === "string"
      ? obj.category
      : String(obj.category ?? "unknown");

  return { tier, confidence, reason, category };
}

/**
 * Classify a user prompt into a tier using the T0 model via Ollama.
 *
 * Returns a ClassificationResult on success, or throws on failure
 * (network error, timeout, parse error).
 */
export async function classify(
  config: ClassifierConfig,
  userText: string,
  signal?: AbortSignal,
): Promise<ClassificationResult> {
  const result = await ollamaChat({
    url: config.ollamaUrl,
    model: config.model,
    messages: [
      { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
    numCtx: config.numCtx,
    timeoutMs: CLASSIFIER_TIMEOUT_MS,
    signal,
  });

  return parseClassification(result.text);
}
