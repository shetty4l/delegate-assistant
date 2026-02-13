import type {
  InboundMessage,
  ModelTurnResponse,
  OutboundMessage,
  TurnEvent,
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
  workspacePath?: string;
};

export interface ModelPort {
  respond(input: RespondInput): Promise<ModelTurnResponse>;
  ping?(): Promise<void>;
  /** Clear cached session state (agent, messages) for the given key. */
  resetSession?(sessionKey: string): Promise<void>;
}

export interface TurnEventSink {
  emit(event: TurnEvent): Promise<void>;
}
