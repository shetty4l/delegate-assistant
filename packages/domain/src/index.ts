export type InboundMessage = {
  chatId: string;
  threadId?: string | null;
  text: string;
  receivedAt: string;
  sourceMessageId?: string;
};

export type OutboundMessage = {
  chatId: string;
  threadId?: string | null;
  text: string;
};

export type ModelTurnResponse = {
  replyText: string;
  sessionId?: string;
  mode?: "chat_reply" | "execution_proposal";
  confidence?: number;
  /** Which model tier handled the request (e.g. "t1", "t2"). */
  tier?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
  };
};

export type TurnEventType =
  | "turn_started"
  | "tool_call"
  | "tool_result"
  | "step_complete"
  | "step_error"
  | "turn_completed"
  | "turn_failed";

// ---------------------------------------------------------------------------
// Model error classification
// ---------------------------------------------------------------------------

export type ModelErrorClassification =
  | "billing"
  | "auth"
  | "rate_limit"
  | "capacity"
  | "internal"
  | "max_steps"
  | "aborted";

const CLASSIFICATION_PATTERNS: readonly [RegExp, ModelErrorClassification][] = [
  [/insufficient.?credits|402/i, "billing"],
  [/unauthorized|invalid.{0,6}key|401/i, "auth"],
  [/rate.?limit|429/i, "rate_limit"],
  [/capacity|overloaded|503/i, "capacity"],
];

/** Classify a raw upstream error message into a known category. */
export function classifyModelError(
  rawMessage: string,
): ModelErrorClassification {
  for (const [pattern, classification] of CLASSIFICATION_PATTERNS) {
    if (pattern.test(rawMessage)) return classification;
  }
  return "internal";
}

/**
 * Structured error thrown when the model provider returns an error.
 * Carries a classification for routing (retry vs surface to user) and
 * the original upstream message for diagnostics.
 */
export class ModelError extends Error {
  readonly classification: ModelErrorClassification;
  readonly upstream: string;

  constructor(
    classification: ModelErrorClassification,
    upstream: string,
    options?: ErrorOptions,
  ) {
    super(`Model error [${classification}]: ${upstream}`, options);
    this.name = "ModelError";
    this.classification = classification;
    this.upstream = upstream;
  }
}

export type TurnEvent = {
  turnId: string;
  sessionKey: string;
  eventType: TurnEventType;
  timestamp: string;
  data: Record<string, unknown>;
};
