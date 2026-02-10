import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RespondInput } from "@delegate/ports";
import { PiAgentModelAdapter } from "../src/index";

const SKIP = !process.env.OPENROUTER_API_KEY;
const TIMEOUT = 30_000;

const makeInput = (overrides: Partial<RespondInput> = {}): RespondInput => ({
  chatId: "test-chat",
  text: "hello",
  context: [],
  pendingProposalWorkItemId: null,
  ...overrides,
});

describe.skipIf(SKIP)("PiAgentModelAdapter integration", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-agent-integ-"));

  const makeAdapter = (overrides: Record<string, unknown> = {}) =>
    new PiAgentModelAdapter({
      provider: "openrouter",
      model: "openrouter/auto",
      maxSteps: 15,
      workspacePath: tmpDir,
      ...overrides,
    });

  test(
    "returns a non-empty reply for a simple prompt",
    async () => {
      const adapter = makeAdapter();
      const result = await adapter.respond(
        makeInput({ text: "What is 2+2? Reply with just the number." }),
      );

      expect(result.replyText).toBeTruthy();
      expect(result.replyText.length).toBeGreaterThan(0);
      expect(result.sessionId).toBeTruthy();
      expect(result.mode).toBe("chat_reply");
    },
    TIMEOUT,
  );

  test(
    "reports token usage and cost",
    async () => {
      const adapter = makeAdapter();
      const result = await adapter.respond(
        makeInput({ text: "Say hello in one word." }),
      );

      expect(result.usage).toBeDefined();
      expect(result.usage!.inputTokens).toBeGreaterThan(0);
      expect(result.usage!.outputTokens).toBeGreaterThan(0);
      // openrouter/auto reports negative sentinel cost values for variable routing;
      // we just verify cost is a finite number
      expect(Number.isFinite(result.usage!.cost)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "uses read_file tool when asked to read a file",
    async () => {
      const testContent = "delegate-integration-test-content-42";
      writeFileSync(join(tmpDir, "hello.txt"), testContent);

      const adapter = makeAdapter();
      const result = await adapter.respond(
        makeInput({
          text: 'Use the read_file tool to read the file "hello.txt" and tell me its exact contents.',
          workspacePath: tmpDir,
        }),
      );

      expect(result.replyText).toContain(testContent);
    },
    TIMEOUT,
  );

  test(
    "retains context across turns in the same session",
    async () => {
      const adapter = makeAdapter();
      const sessionId = "integ-session-continuity";

      await adapter.respond(
        makeInput({
          text: "My name is DelegateTestBot. Remember this name exactly.",
          sessionId,
        }),
      );

      const result = await adapter.respond(
        makeInput({
          text: "What is my name? Reply with just the name.",
          sessionId,
        }),
      );

      expect(result.replyText.toLowerCase()).toContain("delegatetestbot");
    },
    TIMEOUT * 2,
  );

  test(
    "stops after maxSteps is reached",
    async () => {
      const adapter = makeAdapter({ maxSteps: 1 });
      const result = await adapter.respond(
        makeInput({
          text: "List all files in the workspace, then read each one and summarize them all.",
          workspacePath: tmpDir,
        }),
      );

      // Should return something (not hang), even if truncated
      expect(result.replyText).toBeTruthy();
    },
    TIMEOUT,
  );
});
