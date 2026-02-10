import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BehaviorTestHarness } from "./test-harness";

describe("slash command behaviors", () => {
  test("/start on first interaction shows welcome", async () => {
    const harness = new BehaviorTestHarness();
    await harness.start();

    await harness.sendMessage("chat-slash-1", "/start");

    const replies = harness.getReplies("chat-slash-1");
    expect(replies.length).toBe(1);
    expect(replies[0]?.text).toContain("ready");
  });

  test("/start after prior messages is silent", async () => {
    const harness = new BehaviorTestHarness();
    await harness.start();

    await harness.sendMessage("chat-slash-2", "/start");
    const afterFirst = harness.getReplies("chat-slash-2").length;

    await harness.sendMessage("chat-slash-2", "/start");
    const afterSecond = harness.getReplies("chat-slash-2").length;

    expect(afterSecond).toBe(afterFirst);
  });

  test("/version shows version info", async () => {
    const harness = new BehaviorTestHarness();
    await harness.start();

    await harness.sendMessage("chat-slash-3", "/version");

    const replies = harness.getReplies("chat-slash-3");
    expect(replies.length).toBe(1);
    expect(replies[0]?.text).toContain("delegate-assistant");
    expect(replies[0]?.text).toContain("0.1.0");
  });

  test("/restart acknowledges and triggers restart", async () => {
    const harness = new BehaviorTestHarness();
    await harness.start();

    await harness.sendMessage("chat-slash-4", "/restart");

    const replies = harness.getReplies("chat-slash-4");
    expect(replies.length).toBe(1);
    expect(replies[0]?.text).toContain("restarting");
  });

  test("unknown slash command shows help", async () => {
    const harness = new BehaviorTestHarness();
    await harness.start();

    await harness.sendMessage("chat-slash-7", "/unknown");

    const replies = harness.getReplies("chat-slash-7");
    expect(replies.length).toBe(1);
    expect(replies[0]?.text).toContain("Unknown slash command");
  });

  test("/workspace with valid path", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "delegate-ws-valid-"));
    const harness = new BehaviorTestHarness();
    await harness.start();

    await harness.sendMessage("chat-ws-1", `/workspace ${tmpDir}`);

    const replies = harness.getReplies("chat-ws-1");
    expect(replies.length).toBe(1);
    expect(replies[0]?.text).toContain(tmpDir);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("/workspace with invalid path", async () => {
    const harness = new BehaviorTestHarness();
    await harness.start();

    await harness.sendMessage(
      "chat-ws-2",
      "/workspace /nonexistent/path/abc123",
    );

    const replies = harness.getReplies("chat-ws-2");
    expect(replies.length).toBe(1);
    expect(replies[0]?.text).toMatch(/not found|does not exist/i);
  });

  test("/workspace with no argument", async () => {
    const harness = new BehaviorTestHarness();
    await harness.start();

    await harness.sendMessage("chat-ws-3", "/workspace");

    const replies = harness.getReplies("chat-ws-3");
    expect(replies.length).toBe(1);
    // Should show the current workspace path (the temp dir from the harness)
    expect(replies[0]?.text).toContain("/");
  });
});
