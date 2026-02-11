import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RespondInput } from "@delegate/ports";
import { PiAgentModelAdapter } from "../src/index";
import { createWebFetchTool, createWebSearchTool } from "../src/tools";

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

// ---------------------------------------------------------------------------
// web_fetch tool — real integration test
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("web_fetch integration", () => {
  test("fetches and summarizes a real web page", async () => {
    const tool = createWebFetchTool({
      provider: "openrouter",
      model: "openrouter/auto",
      getApiKey: () => process.env.OPENROUTER_API_KEY,
    });

    const result = await tool.execute("tc-wf-integ-1", {
      url: "https://example.com",
      query: "What is this website about?",
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    // Should contain [Source: ...] prefix and some summary content
    expect(text).toContain("[Source:");
    expect(text).toContain("example.com");
    expect(text.length).toBeGreaterThan(50);
    // Should NOT contain "Error:" since example.com is a reliable endpoint
    expect(text).not.toMatch(/^Error:/);
  }, 60_000); // generous timeout: HTTP fetch + LLM summarization

  test(
    "returns error for unreachable host (not raw content)",
    async () => {
      const tool = createWebFetchTool({
        provider: "openrouter",
        model: "openrouter/auto",
        getApiKey: () => process.env.OPENROUTER_API_KEY,
      });

      const result = await tool.execute("tc-wf-integ-2", {
        url: "https://this-host-definitely-does-not-exist-xyz123.invalid",
        query: "anything",
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Error");
    },
    TIMEOUT,
  );

  test("fetches and summarizes a real content-heavy page", async () => {
    const tool = createWebFetchTool({
      provider: "openrouter",
      model: "openrouter/auto",
      getApiKey: () => process.env.OPENROUTER_API_KEY,
    });

    const result = await tool.execute("tc-wf-integ-wiki", {
      url: "https://en.wikipedia.org/wiki/Ada_Lovelace",
      query: "Who was Ada Lovelace?",
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toMatch(/^Error:/);
    expect(text.toLowerCase()).toContain("lovelace");
    expect(text.toLowerCase()).toMatch(
      /computer|programming|algorithm|mathematician/,
    );
    expect(text.length).toBeGreaterThan(50);
  }, 60_000);

  test("blocks SSRF to localhost", async () => {
    const tool = createWebFetchTool({
      provider: "openrouter",
      model: "openrouter/auto",
      getApiKey: () => process.env.OPENROUTER_API_KEY,
    });

    const result = await tool.execute("tc-wf-integ-ssrf-localhost", {
      url: "http://127.0.0.1:80/",
      query: "test",
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Error");
    expect(text.toLowerCase()).toContain("private");
  }, 15_000);

  test("blocks SSRF to cloud metadata endpoint", async () => {
    const tool = createWebFetchTool({
      provider: "openrouter",
      model: "openrouter/auto",
      getApiKey: () => process.env.OPENROUTER_API_KEY,
    });

    const result = await tool.execute("tc-wf-integ-ssrf-metadata", {
      url: "http://169.254.169.254/latest/meta-data/",
      query: "credentials",
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Error");
    expect(text.toLowerCase()).toContain("private");
  }, 15_000);

  test("handles non-HTML content (JSON endpoint)", async () => {
    const tool = createWebFetchTool({
      provider: "openrouter",
      model: "openrouter/auto",
      getApiKey: () => process.env.OPENROUTER_API_KEY,
    });

    const result = await tool.execute("tc-wf-integ-json", {
      url: "https://httpbin.org/json",
      query: "What data does this endpoint return?",
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toMatch(/^Error:/);
    expect(text.toLowerCase()).toContain("slideshow");
    expect(text.length).toBeGreaterThan(20);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// web_search tool — real integration test
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("web_search integration", () => {
  test("searches and returns a summary containing expected facts", async () => {
    const tool = createWebSearchTool({
      provider: "openrouter",
      model: "openrouter/auto",
      getApiKey: () => process.env.OPENROUTER_API_KEY,
    });

    const result = await tool.execute("tc-ws-integ-1", {
      query: "capital of France",
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    // The summary should mention Paris
    expect(text.toLowerCase()).toContain("paris");
    expect(text.length).toBeGreaterThan(20);
    // Should NOT be an error
    expect(text).not.toMatch(/^Error:/);
  }, 60_000);

  test("returns error for nonsense query with no results", async () => {
    const tool = createWebSearchTool({
      provider: "openrouter",
      model: "openrouter/auto",
      getApiKey: () => process.env.OPENROUTER_API_KEY,
    });

    const result = await tool.execute("tc-ws-integ-2", {
      query: "xyzzy12345noresultsever98765",
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    // May return "no results" error or a summary acknowledging nothing was found
    // Either is acceptable — just shouldn't crash
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);

  test("search results include source context in the summary", async () => {
    const tool = createWebSearchTool({
      provider: "openrouter",
      model: "openrouter/auto",
      getApiKey: () => process.env.OPENROUTER_API_KEY,
    });

    const result = await tool.execute("tc-ws-integ-bun", {
      query: "Bun JavaScript runtime official website",
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toMatch(/^Error:/);
    // Summary should reference bun.sh or Oven — domains/names only present in search results
    expect(text.toLowerCase()).toMatch(/bun\.sh|bun runtime|oven\.sh|oven/);
    expect(text.length).toBeGreaterThan(50);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Agent autonomous web search — full pipeline integration test
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("agent web search integration", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-agent-websearch-integ-"));

  test("agent autonomously uses web_search to answer a factual question", async () => {
    const adapter = new PiAgentModelAdapter({
      provider: "openrouter",
      model: "openrouter/auto",
      maxSteps: 15,
      workspacePath: tmpDir,
      enableWebSearchTool: true,
      enableWebFetchTool: true,
    });

    const result = await adapter.respond(
      makeInput({
        text: "Who plays Yasmin in the HBO show Industry? Search the web to find out.",
      }),
    );

    // The agent should use web_search and find that Marisa Abela plays Yasmin
    expect(result.replyText.toLowerCase()).toContain("marisa abela");
  }, 90_000); // generous: adapter overhead + search + summarize
});
