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
  | "turn_completed"
  | "turn_failed";

export type TurnEvent = {
  turnId: string;
  sessionKey: string;
  eventType: TurnEventType;
  timestamp: string;
  data: Record<string, unknown>;
};
