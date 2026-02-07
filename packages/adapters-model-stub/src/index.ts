import type { ModelTurnResponse } from "@delegate/domain";
import type { ModelPort, RespondInput } from "@delegate/ports";

const includesAny = (text: string, needles: string[]): boolean =>
  needles.some((needle) => text.includes(needle));

export class DeterministicModelStub implements ModelPort {
  async respond(input: RespondInput): Promise<ModelTurnResponse> {
    const normalized = input.text.toLowerCase();
    const mentionsWork = includesAny(normalized, [
      "build",
      "fix",
      "create",
      "update",
      "refactor",
      "pr",
      "deploy",
    ]);

    return {
      mode: "chat_reply",
      confidence: mentionsWork ? 0.8 : 0.3,
      replyText: mentionsWork
        ? `Got it. I can help with: ${input.text}`
        : "Doing well - what should we work on next?",
      sessionId: input.sessionId ?? "stub-session",
    };
  }

  async ping(): Promise<void> {}
}
