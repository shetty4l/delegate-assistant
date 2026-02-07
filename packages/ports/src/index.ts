import type {
  InboundMessage,
  ModelTurnResponse,
  OutboundMessage,
} from "@delegate/domain";

export type ChatUpdate = {
  updateId: number;
  message: InboundMessage;
};

export interface ChatPort {
  receiveUpdates(cursor: number | null): Promise<ChatUpdate[]>;
  send(message: OutboundMessage): Promise<void>;
}

export type RespondInput = {
  chatId: string;
  threadId?: string | null;
  text: string;
  context: string[];
  pendingProposalWorkItemId: string | null;
  sessionId?: string | null;
};

export interface ModelPort {
  respond(input: RespondInput): Promise<ModelTurnResponse>;
  ping?(): Promise<void>;
}
