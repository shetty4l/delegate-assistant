import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadBuildInfo } from "./version";

describe("loadBuildInfo", () => {
  test("uses package version and falls back when git is unavailable", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "delegate-version-"));
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify({ name: "delegate-assistant", version: "0.2.0" }),
      "utf8",
    );

    try {
      const buildInfo = loadBuildInfo({
        repoRoot,
        env: { BUILD_TIME_UTC: "2026-02-08T12:00:00.000Z" },
      });
      expect(buildInfo.service).toBe("delegate-assistant");
      expect(buildInfo.releaseVersion).toBe("0.2.0");
      expect(buildInfo.displayVersion).toBe("0.2.0");
      expect(buildInfo.gitSha).toBe("unknown");
      expect(buildInfo.gitBranch).toBe("unknown");
      expect(buildInfo.commitTitle).toBe("unknown");
      expect(buildInfo.buildTimeUtc).toBe("2026-02-08T12:00:00.000Z");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("uses env-provided git metadata when present", () => {
    const buildInfo = loadBuildInfo({
      repoRoot: process.cwd(),
      now: () => new Date("2026-02-08T01:02:03.000Z"),
      env: {
        GIT_SHA: "68ca6cd437276a993500787a2e809e38ad3ae598",
        GIT_BRANCH: "main",
        GIT_COMMIT_TITLE: "add supervisor-managed graceful restart flow",
      },
    });

    expect(buildInfo.gitSha).toBe("68ca6cd437276a993500787a2e809e38ad3ae598");
    expect(buildInfo.gitShortSha).toBe("68ca6cd");
    expect(buildInfo.gitBranch).toBe("main");
    expect(buildInfo.commitTitle).toBe(
      "add supervisor-managed graceful restart flow",
    );
    expect(buildInfo.displayVersion.endsWith("+68ca6cd")).toBeTrue();
  });
});
