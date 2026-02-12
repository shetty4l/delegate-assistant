import type { ModelPort, TurnEventSink } from "@delegate/ports";

export type ClassifierConfig = {
  /** Ollama URL for the classifier model (T0). Default: http://127.0.0.1:11434 */
  ollamaUrl: string;
  /** Classifier model name. Default: qwen2.5:3b */
  model: string;
  /** Context window for classification. Default: 4096 */
  numCtx: number;
  /** Minimum confidence to accept a T1 classification. Default: 0.7 */
  confidenceThreshold: number;
};

export type T1Config = {
  /** Ollama URL for the T1 model. Default: http://127.0.0.1:11434 */
  ollamaUrl: string;
  /** T1 model name. Default: qwen2.5:14b-instruct-q4_K_M */
  model: string;
  /** Context window for T1 generation. Default: 16384 */
  numCtx: number;
};

export type EngramConfig = {
  /** Engram HTTP API URL. Default: http://127.0.0.1:7749 */
  url: string;
  /** Maximum memories to recall. Default: 3 */
  maxMemories: number;
  /** Minimum memory strength threshold. Default: 0.3 */
  minStrength: number;
};

export type TieredRouterConfig = {
  classifier: ClassifierConfig;
  t1: T1Config;
  engram: EngramConfig;
  /** T2 backend (cloud model with tool support), injected as a ModelPort. */
  t2Backend: ModelPort;
  /** Optional sink for emitting turn observability events. */
  turnEventSink?: TurnEventSink;
};

/** Result from an Ollama /api/chat call. */
export type OllamaChatResult = {
  /** The model's response text. */
  text: string;
  /** Total latency including network + inference (ms). */
  latencyMs: number;
  /** Number of input (prompt eval) tokens. */
  tokensIn: number;
  /** Number of output (eval) tokens. */
  tokensOut: number;
  /** Output tokens per second, or null if unavailable. */
  tokensPerSec: number | null;
};
