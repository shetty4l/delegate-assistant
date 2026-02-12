/**
 * Types for the T1 viability benchmark.
 *
 * Tests whether qwen2.5:14b via Ollama can produce acceptable responses
 * for chat-only (no tool use) tasks, optionally augmented with Engram memories.
 */

// --- Prompt definitions ---

export type PromptCategory =
  | "knowledge"
  | "drafting"
  | "planning"
  | "conversational"
  | "memory";

export interface BenchmarkPrompt {
  /** Unique identifier, e.g. "knowledge-01" */
  id: string;
  /** Task category for aggregate analysis */
  category: PromptCategory;
  /** The user message to send to both models */
  prompt: string;
  /** Optional: Engram query to recall memories before sending to Ollama */
  engram_query?: string;
  /** Why this prompt was chosen (not sent to models) */
  notes?: string;
}

// --- Result types ---

export interface VariantResult {
  /** Full response text */
  response: string;
  /** Wall-clock latency in milliseconds */
  latency_ms: number;
  /** Input/prompt tokens consumed */
  tokens_in: number;
  /** Output/completion tokens generated */
  tokens_out: number;
  /** Tokens per second (Ollama only, from eval_duration) */
  tokens_per_sec: number | null;
  /** Model identifier */
  model: string;
  /** Provider name */
  provider: "ollama" | "groq";
}

export interface PromptResult {
  /** References BenchmarkPrompt.id */
  prompt_id: string;
  /** Copied from prompt for convenience */
  category: PromptCategory;
  /** The original prompt text */
  prompt: string;
  /** Ollama without Engram context */
  ollama_bare: VariantResult;
  /** Ollama with Engram memories prepended (only for prompts with engram_query) */
  ollama_engram: VariantResult | null;
  /** Control model via Groq API */
  control: VariantResult;
  /** Engram memories that were injected (if any) */
  engram_memories: string[] | null;
}

export interface BenchmarkRun {
  /** ISO timestamp of the run */
  timestamp: string;
  /** Configuration used */
  config: {
    ollama_url: string;
    ollama_model: string;
    ollama_num_ctx: number;
    engram_url: string;
    control_provider: string;
    control_model: string;
  };
  /** Results per prompt */
  results: PromptResult[];
}
