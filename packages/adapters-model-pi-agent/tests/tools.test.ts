import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
