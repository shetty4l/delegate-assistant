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
};
