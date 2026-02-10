import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildShellEnv,
  createExecuteShellTool,
  createListDirectoryTool,
  createReadFileTool,
  createSearchFilesTool,
  createWriteFileTool,
} from "../src/tools";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "pi-agent-tools-"));
  writeFileSync(join(workspace, "hello.txt"), "hello world\n", "utf8");
  mkdirSync(join(workspace, "subdir"), { recursive: true });
  writeFileSync(
    join(workspace, "subdir", "nested.txt"),
    "nested content\n",
    "utf8",
  );
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("tool path scoping", () => {
  test("read_file rejects path traversal", async () => {
    const tool = createReadFileTool(workspace);
    const result = await tool.execute("tc-1", { path: "../../etc/passwd" });
    expect(result.content[0]).toBeDefined();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("outside the workspace");
  });

  test("write_file rejects paths outside workspace", async () => {
    const tool = createWriteFileTool(workspace);
    const result = await tool.execute("tc-2", {
      path: "/tmp/escape-attempt.txt",
      content: "bad",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("outside the workspace");
  });

  test("execute_shell uses workspace as cwd", async () => {
    const tool = createExecuteShellTool(workspace);
    const result = await tool.execute("tc-3", { command: "pwd" });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(workspace);
  });
});

describe("read_file", () => {
  test("reads file within workspace", async () => {
    const tool = createReadFileTool(workspace);
    const result = await tool.execute("tc-4", { path: "hello.txt" });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("hello world");
  });
});

describe("write_file", () => {
  test("creates file and parent dirs within workspace", async () => {
    const tool = createWriteFileTool(workspace);
    const result = await tool.execute("tc-5", {
      path: "deep/nested/file.txt",
      content: "created content",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Wrote");
    const written = readFileSync(
      join(workspace, "deep/nested/file.txt"),
      "utf8",
    );
    expect(written).toBe("created content");
  });
});

describe("execute_shell", () => {
  test("captures output", async () => {
    const tool = createExecuteShellTool(workspace);
    const result = await tool.execute("tc-6", {
      command: "echo 'test output'",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("test output");
    expect(text).toContain("exit code: 0");
  });

  test("respects timeout", async () => {
    const tool = createExecuteShellTool(workspace, 50);
    const result = await tool.execute("tc-7", { command: "sleep 10" });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("timed out");
  });

  test("does not leak secrets to spawned commands", async () => {
    const original = process.env.TELEGRAM_BOT_TOKEN;
    try {
      process.env.TELEGRAM_BOT_TOKEN = "secret-token-12345";
      const tool = createExecuteShellTool(workspace);
      const result = await tool.execute("tc-env", {
        command: 'echo "TOKEN=$TELEGRAM_BOT_TOKEN"',
      });
      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("TOKEN=");
      expect(text).not.toContain("secret-token-12345");
    } finally {
      if (original !== undefined) {
        process.env.TELEGRAM_BOT_TOKEN = original;
      } else {
        delete process.env.TELEGRAM_BOT_TOKEN;
      }
    }
  });

  test("exposes GH_TOKEN from DELEGATE_GITHUB_TOKEN", async () => {
    const original = process.env.DELEGATE_GITHUB_TOKEN;
    try {
      process.env.DELEGATE_GITHUB_TOKEN = "ghp_testvalue";
      const tool = createExecuteShellTool(workspace);
      const result = await tool.execute("tc-gh", {
        command: 'echo "GH=$GH_TOKEN"',
      });
      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("GH=ghp_testvalue");
    } finally {
      if (original !== undefined) {
        process.env.DELEGATE_GITHUB_TOKEN = original;
      } else {
        delete process.env.DELEGATE_GITHUB_TOKEN;
      }
    }
  });
});

describe("list_directory", () => {
  test("lists workspace contents", async () => {
    const tool = createListDirectoryTool(workspace);
    const result = await tool.execute("tc-8", {});
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("hello.txt");
    expect(text).toContain("subdir/");
  });
});

describe("search_files", () => {
  test("finds matches", async () => {
    const tool = createSearchFilesTool(workspace);
    const result = await tool.execute("tc-9", { pattern: "nested" });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("nested content");
  });
});

describe("buildShellEnv", () => {
  test("includes safe system vars from process.env", () => {
    const env = buildShellEnv();
    // PATH and HOME should always be present on any system
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
  });

  test("excludes secrets from process.env", () => {
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    const originalApiKey = process.env.PI_AGENT_API_KEY;
    try {
      process.env.TELEGRAM_BOT_TOKEN = "secret-telegram-token";
      process.env.PI_AGENT_API_KEY = "secret-api-key";
      const env = buildShellEnv();
      expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(env.PI_AGENT_API_KEY).toBeUndefined();
    } finally {
      if (originalToken !== undefined) {
        process.env.TELEGRAM_BOT_TOKEN = originalToken;
      } else {
        delete process.env.TELEGRAM_BOT_TOKEN;
      }
      if (originalApiKey !== undefined) {
        process.env.PI_AGENT_API_KEY = originalApiKey;
      } else {
        delete process.env.PI_AGENT_API_KEY;
      }
    }
  });

  test("maps DELEGATE_GITHUB_TOKEN to GH_TOKEN", () => {
    const original = process.env.DELEGATE_GITHUB_TOKEN;
    try {
      process.env.DELEGATE_GITHUB_TOKEN = "ghp_test123";
      const env = buildShellEnv();
      expect(env.GH_TOKEN).toBe("ghp_test123");
      expect(env.DELEGATE_GITHUB_TOKEN).toBeUndefined();
    } finally {
      if (original !== undefined) {
        process.env.DELEGATE_GITHUB_TOKEN = original;
      } else {
        delete process.env.DELEGATE_GITHUB_TOKEN;
      }
    }
  });

  test("includes git identity vars when set", () => {
    const originals = {
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
    };
    try {
      process.env.GIT_AUTHOR_NAME = "suyash-delegate";
      process.env.GIT_AUTHOR_EMAIL = "suyash.delegate@gmail.com";
      process.env.GIT_COMMITTER_NAME = "suyash-delegate";
      process.env.GIT_COMMITTER_EMAIL = "suyash.delegate@gmail.com";
      const env = buildShellEnv();
      expect(env.GIT_AUTHOR_NAME).toBe("suyash-delegate");
      expect(env.GIT_AUTHOR_EMAIL).toBe("suyash.delegate@gmail.com");
      expect(env.GIT_COMMITTER_NAME).toBe("suyash-delegate");
      expect(env.GIT_COMMITTER_EMAIL).toBe("suyash.delegate@gmail.com");
    } finally {
      for (const [key, value] of Object.entries(originals)) {
        if (value !== undefined) {
          process.env[key] = value;
        } else {
          delete process.env[key];
        }
      }
    }
  });
});
