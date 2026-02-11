import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildShellEnv,
  checkRateLimit,
  createExecuteShellTool,
  createListDirectoryTool,
  createReadFileTool,
  createSearchFilesTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteFileTool,
  isPrivateIP,
  matchesDenylist,
  parseDuckDuckGoResults,
  resetRateLimits,
  resolveAndValidateHost,
  SHELL_COMMAND_DENYLIST,
  stripHtml,
  validateUrl,
} from "../src/tools";

let workspace: string;

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "pi-agent-tools-")));
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

  test("read_file rejects symlink escape", async () => {
    // Create a symlink inside workspace pointing outside
    symlinkSync("/etc", join(workspace, "sneaky-link"));
    const tool = createReadFileTool(workspace);
    const result = await tool.execute("tc-symlink", {
      path: "sneaky-link/hosts",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("outside the workspace");
  });

  test("write_file through symlinked directory is blocked", async () => {
    symlinkSync("/tmp", join(workspace, "escape-dir"));
    const tool = createWriteFileTool(workspace);
    const result = await tool.execute("tc-symlink-write", {
      path: "escape-dir/evil.txt",
      content: "bad",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("outside the workspace");
  });

  test("write_file to genuinely new path is allowed", async () => {
    const tool = createWriteFileTool(workspace);
    const result = await tool.execute("tc-new-path", {
      path: "brand-new-dir/new-file.txt",
      content: "fresh content",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Wrote");
    const written = readFileSync(
      join(workspace, "brand-new-dir/new-file.txt"),
      "utf8",
    );
    expect(written).toBe("fresh content");
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

describe("matchesDenylist", () => {
  test("returns null for safe commands", () => {
    expect(matchesDenylist("ls -la")).toBeNull();
    expect(matchesDenylist("git status")).toBeNull();
    expect(matchesDenylist("echo hello")).toBeNull();
  });

  test("blocks rm -rf /", () => {
    expect(matchesDenylist("rm -rf /")).toBe("rm -rf /");
  });

  test("blocks rm -rf / embedded in a larger command", () => {
    expect(matchesDenylist("echo hi && rm -rf / --no-preserve-root")).toBe(
      "rm -rf /",
    );
  });

  test("blocks mkfs commands", () => {
    expect(matchesDenylist("mkfs.ext4 /dev/sda1")).toBe("mkfs");
  });

  test("blocks dd from device files", () => {
    expect(matchesDenylist("dd if=/dev/zero of=/dev/sda")).toBe("dd if=/dev/");
  });

  test("blocks shutdown", () => {
    expect(matchesDenylist("shutdown -h now")).toBe("shutdown");
  });

  test("blocks fork bomb", () => {
    expect(matchesDenylist(":(){:|:&};:")).toBe("fork bomb");
  });

  test("blocks chmod -R 777 /", () => {
    expect(matchesDenylist("chmod -R 777 / something")).toBe("chmod -R 777 /");
  });

  test("allows rm -rf on non-root paths", () => {
    expect(matchesDenylist("rm -rf ./build")).toBeNull();
  });

  // False-positive regression tests (#58)
  test("allows rm -rf /tmp/build (absolute non-root)", () => {
    expect(matchesDenylist("rm -rf /tmp/build")).toBeNull();
  });

  test("allows halt_processing variable assignment", () => {
    expect(matchesDenylist("halt_processing=true")).toBeNull();
  });

  test("allows reboot_counter variable", () => {
    expect(matchesDenylist("reboot_counter=0")).toBeNull();
  });

  test("allows echo shutdown_mode", () => {
    expect(matchesDenylist("echo shutdown_mode")).toBeNull();
  });

  test("allows chown -R on non-root paths", () => {
    expect(matchesDenylist("chown -R user:group ./dir")).toBeNull();
  });

  test("allows dd with regular files", () => {
    expect(matchesDenylist("dd if=input.txt of=output.txt")).toBeNull();
  });
});

describe("execute_shell denylist integration", () => {
  test("blocks denied commands and returns error result", async () => {
    const tool = createExecuteShellTool(workspace);
    const result = await tool.execute("tc-deny-1", {
      command: "rm -rf / --no-preserve-root",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("blocked by denylist");
    expect(text).toContain("rm -rf /");
  });

  test("allows safe commands through", async () => {
    const tool = createExecuteShellTool(workspace);
    const result = await tool.execute("tc-deny-2", {
      command: "echo safe",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("safe");
    expect(text).toContain("exit code: 0");
  });

  test("allows commands that were false positives with substring matching", async () => {
    const tool = createExecuteShellTool(workspace);
    const result = await tool.execute("tc-deny-3", {
      command: "rm -rf /tmp/test-build",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toContain("blocked by denylist");
  });
});

// ---------------------------------------------------------------------------
// validateUrl
// ---------------------------------------------------------------------------

describe("validateUrl", () => {
  test("accepts https URLs", () => {
    const result = validateUrl("https://example.com/path?q=1");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.parsed.hostname).toBe("example.com");
    }
  });

  test("accepts http URLs", () => {
    const result = validateUrl("http://example.com");
    expect(result.valid).toBe(true);
  });

  test("rejects file:// scheme", () => {
    const result = validateUrl("file:///etc/passwd");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("http");
    }
  });

  test("rejects ftp:// scheme", () => {
    const result = validateUrl("ftp://ftp.example.com/file.txt");
    expect(result.valid).toBe(false);
  });

  test("rejects javascript: scheme", () => {
    const result = validateUrl("javascript:alert(1)");
    expect(result.valid).toBe(false);
  });

  test("rejects empty string", () => {
    const result = validateUrl("");
    expect(result.valid).toBe(false);
  });

  test("rejects non-URL strings", () => {
    const result = validateUrl("not a url at all");
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateIP
// ---------------------------------------------------------------------------

describe("isPrivateIP", () => {
  test("blocks 127.0.0.1 (loopback)", () => {
    expect(isPrivateIP("127.0.0.1")).toBe(true);
  });

  test("blocks 127.0.0.2 (loopback range)", () => {
    expect(isPrivateIP("127.0.0.2")).toBe(true);
  });

  test("blocks 10.0.0.1 (RFC1918)", () => {
    expect(isPrivateIP("10.0.0.1")).toBe(true);
  });

  test("blocks 172.16.0.1 (RFC1918)", () => {
    expect(isPrivateIP("172.16.0.1")).toBe(true);
  });

  test("blocks 172.31.255.255 (RFC1918 upper bound)", () => {
    expect(isPrivateIP("172.31.255.255")).toBe(true);
  });

  test("allows 172.32.0.1 (outside RFC1918 range)", () => {
    expect(isPrivateIP("172.32.0.1")).toBe(false);
  });

  test("blocks 192.168.1.1 (RFC1918)", () => {
    expect(isPrivateIP("192.168.1.1")).toBe(true);
  });

  test("blocks 169.254.169.254 (link-local / cloud metadata)", () => {
    expect(isPrivateIP("169.254.169.254")).toBe(true);
  });

  test("blocks 0.0.0.0", () => {
    expect(isPrivateIP("0.0.0.0")).toBe(true);
  });

  test("allows 8.8.8.8 (public)", () => {
    expect(isPrivateIP("8.8.8.8")).toBe(false);
  });

  test("allows 1.1.1.1 (public)", () => {
    expect(isPrivateIP("1.1.1.1")).toBe(false);
  });

  test("blocks ::1 (IPv6 loopback)", () => {
    expect(isPrivateIP("::1")).toBe(true);
  });

  test("blocks :: (IPv6 unspecified)", () => {
    expect(isPrivateIP("::")).toBe(true);
  });

  test("blocks fc00::1 (IPv6 unique local)", () => {
    expect(isPrivateIP("fc00::1")).toBe(true);
  });

  test("blocks fd12::1 (IPv6 unique local)", () => {
    expect(isPrivateIP("fd12::1")).toBe(true);
  });

  test("blocks fe80::1 (IPv6 link-local)", () => {
    expect(isPrivateIP("fe80::1")).toBe(true);
  });

  test("allows 2607:f8b0:4004:800::200e (public IPv6)", () => {
    expect(isPrivateIP("2607:f8b0:4004:800::200e")).toBe(false);
  });

  test("blocks IPv4-mapped IPv6 for private IP", () => {
    expect(isPrivateIP("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIP("::ffff:10.0.0.1")).toBe(true);
  });

  test("allows IPv4-mapped IPv6 for public IP", () => {
    expect(isPrivateIP("::ffff:8.8.8.8")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveAndValidateHost
// ---------------------------------------------------------------------------

describe("resolveAndValidateHost", () => {
  test("rejects IP literal 127.0.0.1", async () => {
    expect(await resolveAndValidateHost("127.0.0.1")).toBeNull();
  });

  test("rejects IP literal 10.0.0.1", async () => {
    expect(await resolveAndValidateHost("10.0.0.1")).toBeNull();
  });

  test("rejects IP literal 169.254.169.254", async () => {
    expect(await resolveAndValidateHost("169.254.169.254")).toBeNull();
  });

  test("accepts IP literal 8.8.8.8", async () => {
    expect(await resolveAndValidateHost("8.8.8.8")).toBe("8.8.8.8");
  });

  test("resolves example.com to a public IP", async () => {
    const result = await resolveAndValidateHost("example.com");
    expect(result).not.toBeNull();
  });

  test("returns null for unresolvable hostname", async () => {
    const result = await resolveAndValidateHost(
      "this-domain-definitely-does-not-exist-abc123xyz.invalid",
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stripHtml
// ---------------------------------------------------------------------------

describe("stripHtml", () => {
  test("removes script tags and content", () => {
    const html = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
    const result = stripHtml(html);
    expect(result).toContain("Hello");
    expect(result).toContain("World");
    expect(result).not.toContain("alert");
    expect(result).not.toContain("script");
  });

  test("removes style tags and content", () => {
    const html = "<p>Text</p><style>body { color: red; }</style><p>More</p>";
    const result = stripHtml(html);
    expect(result).toContain("Text");
    expect(result).toContain("More");
    expect(result).not.toContain("color");
    expect(result).not.toContain("style");
  });

  test("removes HTML comments", () => {
    const html = "<p>Before</p><!-- secret comment --><p>After</p>";
    const result = stripHtml(html);
    expect(result).toContain("Before");
    expect(result).toContain("After");
    expect(result).not.toContain("secret");
  });

  test("strips all HTML tags", () => {
    const html = '<div class="main"><a href="http://test.com">Link</a></div>';
    const result = stripHtml(html);
    expect(result).toContain("Link");
    expect(result).not.toContain("<div");
    expect(result).not.toContain("<a ");
    expect(result).not.toContain("href");
  });

  test("decodes &amp; &lt; &gt; &quot; &apos;", () => {
    const html = "&amp; &lt; &gt; &quot; &apos;";
    const result = stripHtml(html);
    expect(result).toBe("& < > \" '");
  });

  test("decodes &nbsp;", () => {
    const html = "hello&nbsp;world";
    const result = stripHtml(html);
    expect(result).toBe("hello world");
  });

  test("decodes decimal numeric entities", () => {
    const html = "&#65;&#66;&#67;"; // ABC
    expect(stripHtml(html)).toBe("ABC");
  });

  test("decodes hex numeric entities", () => {
    const html = "&#x41;&#x42;&#x43;"; // ABC
    expect(stripHtml(html)).toBe("ABC");
  });

  test("preserves plain text content", () => {
    const text = "Just plain text with no HTML.";
    expect(stripHtml(text)).toBe(text);
  });

  test("handles malformed HTML gracefully", () => {
    const html = "<p>Unclosed tag <b>bold text <p>Another paragraph";
    const result = stripHtml(html);
    expect(result).toContain("Unclosed tag");
    expect(result).toContain("bold text");
    expect(result).toContain("Another paragraph");
  });

  test("removes script tags with whitespace before closing >", () => {
    const html = '<p>Safe</p><script >alert("xss")</script ><p>OK</p>';
    const result = stripHtml(html);
    expect(result).toContain("Safe");
    expect(result).toContain("OK");
    expect(result).not.toContain("alert");
  });

  test("removes script tags with attributes in closing tag", () => {
    const html = '<p>Safe</p><script>alert("xss")</script\t\n bar><p>OK</p>';
    const result = stripHtml(html);
    expect(result).toContain("Safe");
    expect(result).toContain("OK");
    expect(result).not.toContain("alert");
  });

  test("does not double-unescape &amp;lt;", () => {
    const html = "&amp;lt;div&amp;gt;";
    const result = stripHtml(html);
    // Should produce &lt;div&gt; (literal text), NOT <div> (decoded twice)
    expect(result).toBe("&lt;div&gt;");
  });

  test("collapses excessive whitespace", () => {
    const html = "<p>  Hello  </p>  <p>  World  </p>\n\n\n\n<p>  End  </p>";
    const result = stripHtml(html);
    // Should not have more than 2 consecutive newlines
    expect(result).not.toMatch(/\n{3,}/);
  });
});

// ---------------------------------------------------------------------------
// web_fetch tool — unit tests with mocks
// ---------------------------------------------------------------------------

describe("web_fetch tool", () => {
  test("rejects invalid URL schemes", async () => {
    const tool = createWebFetchTool({
      provider: "openrouter",
      model: "openrouter/auto",
    });
    const result = await tool.execute("tc-wf-1", {
      url: "file:///etc/passwd",
      query: "contents",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Error");
    expect(text).toContain("http");
  });

  test("rejects javascript: scheme", async () => {
    const tool = createWebFetchTool({
      provider: "openrouter",
      model: "openrouter/auto",
    });
    const result = await tool.execute("tc-wf-2", {
      url: "javascript:alert(1)",
      query: "test",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Error");
  });

  test("rejects empty URL", async () => {
    const tool = createWebFetchTool({
      provider: "openrouter",
      model: "openrouter/auto",
    });
    const result = await tool.execute("tc-wf-3", {
      url: "",
      query: "test",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Error");
  });

  test("rejects URLs pointing to private IPs", async () => {
    const tool = createWebFetchTool({
      provider: "openrouter",
      model: "openrouter/auto",
    });
    const result = await tool.execute("tc-wf-4", {
      url: "http://127.0.0.1/admin",
      query: "admin panel",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Error");
    expect(text).toContain("private");
  });

  test("rejects URLs to cloud metadata endpoint", async () => {
    const tool = createWebFetchTool({
      provider: "openrouter",
      model: "openrouter/auto",
    });
    const result = await tool.execute("tc-wf-5", {
      url: "http://169.254.169.254/latest/meta-data/",
      query: "credentials",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Error");
    expect(text).toContain("private");
  });

  test("includes web_fetch in createWorkspaceTools when webFetchConfig is provided", () => {
    // Import createWorkspaceTools to verify web_fetch is included
    const { createWorkspaceTools } = require("../src/tools");
    const tools = createWorkspaceTools(workspace, {
      enableShellTool: false,
      enableWebFetchTool: true,
      webFetchConfig: {
        provider: "openrouter",
        model: "openrouter/auto",
      },
    });
    const toolNames = tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("web_fetch");
  });

  test("excludes web_fetch when enableWebFetchTool is false", () => {
    const { createWorkspaceTools } = require("../src/tools");
    const tools = createWorkspaceTools(workspace, {
      enableShellTool: false,
      enableWebFetchTool: false,
      webFetchConfig: {
        provider: "openrouter",
        model: "openrouter/auto",
      },
    });
    const toolNames = tools.map((t: { name: string }) => t.name);
    expect(toolNames).not.toContain("web_fetch");
  });

  test("excludes web_fetch when webFetchConfig is not provided", () => {
    const { createWorkspaceTools } = require("../src/tools");
    const tools = createWorkspaceTools(workspace, {
      enableShellTool: false,
      enableWebFetchTool: true,
      // no webFetchConfig
    });
    const toolNames = tools.map((t: { name: string }) => t.name);
    expect(toolNames).not.toContain("web_fetch");
  });
});

// ---------------------------------------------------------------------------
// checkRateLimit
// ---------------------------------------------------------------------------

describe("checkRateLimit", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  test("allows requests within limit", () => {
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit("session-rl-1")).toBe(true);
    }
  });

  test("blocks the 11th request within the same minute", () => {
    for (let i = 0; i < 10; i++) {
      checkRateLimit("session-rl-2");
    }
    expect(checkRateLimit("session-rl-2")).toBe(false);
  });

  test("different session keys are independent", () => {
    for (let i = 0; i < 10; i++) {
      checkRateLimit("session-rl-3a");
    }
    // session-rl-3a is at limit
    expect(checkRateLimit("session-rl-3a")).toBe(false);
    // session-rl-3b is fresh
    expect(checkRateLimit("session-rl-3b")).toBe(true);
  });

  test("allows requests when no session key is provided", () => {
    // undefined session key = no rate limiting
    for (let i = 0; i < 20; i++) {
      expect(checkRateLimit(undefined)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// parseDuckDuckGoResults
// ---------------------------------------------------------------------------

describe("parseDuckDuckGoResults", () => {
  // Sample HTML matching the real DDG HTML lite structure
  const sampleDdgHtml = `
    <div class="result results_links results_links_deep web-result ">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Fpage1&amp;rut=abc123">Example Page One</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Fpage1&amp;rut=abc123">This is the first result snippet.</a>
        <div class="clear"></div>
      </div>
    </div>
    <div class="result results_links results_links_deep web-result ">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.org%2Fpage2&amp;rut=def456">Example &amp; Page Two</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.org%2Fpage2&amp;rut=def456">Second result with <b>bold</b> text.</a>
        <div class="clear"></div>
      </div>
    </div>
  `;

  test("extracts titles, snippets, and real URLs", () => {
    const results = parseDuckDuckGoResults(sampleDdgHtml);
    expect(results.length).toBe(2);

    expect(results[0].title).toBe("Example Page One");
    expect(results[0].url).toBe("https://www.example.com/page1");
    expect(results[0].snippet).toContain("first result snippet");

    expect(results[1].title).toBe("Example & Page Two");
    expect(results[1].url).toBe("https://www.example.org/page2");
    expect(results[1].snippet).toContain("Second result");
    expect(results[1].snippet).toContain("bold");
    // HTML tags should be stripped from snippet
    expect(results[1].snippet).not.toContain("<b>");
  });

  test("returns empty array for non-DDG HTML", () => {
    const results = parseDuckDuckGoResults(
      "<html><body><p>Just a random page</p></body></html>",
    );
    expect(results.length).toBe(0);
  });

  test("handles missing snippets gracefully", () => {
    const html = `
      <div class="result results_links results_links_deep web-result ">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&amp;rut=xyz">No Snippet Page</a>
          </h2>
          <div class="clear"></div>
        </div>
      </div>
    `;
    const results = parseDuckDuckGoResults(html);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("No Snippet Page");
    expect(results[0].url).toBe("https://example.com");
    expect(results[0].snippet).toBe("");
  });

  test("limits to 10 results", () => {
    // Generate 15 result blocks
    const blocks = Array.from(
      { length: 15 },
      (_, i) => `
      <div class="result results_links results_links_deep web-result ">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F${i}&amp;rut=r${i}">Result ${i}</a>
          </h2>
          <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F${i}&amp;rut=r${i}">Snippet ${i}</a>
          <div class="clear"></div>
        </div>
      </div>
    `,
    ).join("\n");
    const results = parseDuckDuckGoResults(blocks);
    expect(results.length).toBe(10);
  });

  test("decodes URL-encoded uddg parameter", () => {
    const html = `
      <div class="result results_links results_links_deep web-result ">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Fpath%3Fq%3Dtest%26lang%3Den&amp;rut=abc">Encoded URL</a>
          </h2>
          <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.com%2Fpath%3Fq%3Dtest%26lang%3Den&amp;rut=abc">Test snippet</a>
          <div class="clear"></div>
        </div>
      </div>
    `;
    const results = parseDuckDuckGoResults(html);
    expect(results.length).toBe(1);
    expect(results[0].url).toBe("https://www.example.com/path?q=test&lang=en");
  });
});

// ---------------------------------------------------------------------------
// web_search tool — unit tests
// ---------------------------------------------------------------------------

describe("web_search tool", () => {
  test("rejects empty query", async () => {
    const tool = createWebSearchTool({
      provider: "openrouter",
      model: "openrouter/auto",
    });
    const result = await tool.execute("tc-ws-1", { query: "" });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Error");
    expect(text).toContain("empty");
  });

  test("rejects whitespace-only query", async () => {
    const tool = createWebSearchTool({
      provider: "openrouter",
      model: "openrouter/auto",
    });
    const result = await tool.execute("tc-ws-2", { query: "   " });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Error");
    expect(text).toContain("empty");
  });

  test("includes web_search in createWorkspaceTools when enabled", () => {
    const { createWorkspaceTools } = require("../src/tools");
    const tools = createWorkspaceTools(workspace, {
      enableShellTool: false,
      enableWebSearchTool: true,
      webFetchConfig: {
        provider: "openrouter",
        model: "openrouter/auto",
      },
    });
    const toolNames = tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("web_search");
  });

  test("excludes web_search when enableWebSearchTool is false", () => {
    const { createWorkspaceTools } = require("../src/tools");
    const tools = createWorkspaceTools(workspace, {
      enableShellTool: false,
      enableWebSearchTool: false,
      webFetchConfig: {
        provider: "openrouter",
        model: "openrouter/auto",
      },
    });
    const toolNames = tools.map((t: { name: string }) => t.name);
    expect(toolNames).not.toContain("web_search");
  });

  test("excludes web_search when webFetchConfig is not provided", () => {
    const { createWorkspaceTools } = require("../src/tools");
    const tools = createWorkspaceTools(workspace, {
      enableShellTool: false,
      enableWebSearchTool: true,
    });
    const toolNames = tools.map((t: { name: string }) => t.name);
    expect(toolNames).not.toContain("web_search");
  });

  test("includes both web_fetch and web_search by default", () => {
    const { createWorkspaceTools } = require("../src/tools");
    const tools = createWorkspaceTools(workspace, {
      enableShellTool: false,
      webFetchConfig: {
        provider: "openrouter",
        model: "openrouter/auto",
      },
    });
    const toolNames = tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("web_fetch");
    expect(toolNames).toContain("web_search");
  });
});
