import { describe, expect, test } from "bun:test";

import { validateVersionPolicy } from "../check-version-policy";

describe("validateVersionPolicy", () => {
  test("passes for valid non-CI local checks", () => {
    const errors = validateVersionPolicy({
      packageVersion: "1.2.3",
      env: {
        CI: "false",
      },
    });

    expect(errors).toHaveLength(0);
  });

  test("fails when package version is not semver", () => {
    const errors = validateVersionPolicy({
      packageVersion: "1.2",
      env: {
        CI: "false",
      },
    });

    expect(errors[0]).toContain("valid SemVer");
  });

  test("fails when release tag version mismatches package version", () => {
    const errors = validateVersionPolicy({
      packageVersion: "1.2.3",
      env: {
        CI: "false",
        GITHUB_REF: "refs/tags/v1.2.4",
      },
    });

    expect(errors).toContain(
      "release tag version (1.2.4) must match package.json version (1.2.3)",
    );
  });

  test("fails in CI when build metadata is missing", () => {
    const errors = validateVersionPolicy({
      packageVersion: "1.2.3",
      env: {
        CI: "true",
        GIT_SHA: "",
        GIT_BRANCH: "unknown",
        GIT_COMMIT_TITLE: "",
      },
    });

    expect(errors).toContain(
      "GIT_SHA must be set to a full 40-char lowercase git commit sha",
    );
    expect(errors).toContain("GIT_BRANCH must be set and not 'unknown'");
    expect(errors).toContain("GIT_COMMIT_TITLE must be set and not 'unknown'");
  });

  test("passes in CI with complete metadata", () => {
    const errors = validateVersionPolicy({
      packageVersion: "1.2.3",
      env: {
        CI: "true",
        GIT_SHA: "68ca6cd437276a993500787a2e809e38ad3ae598",
        GIT_BRANCH: "main",
        GIT_COMMIT_TITLE: "add strict version policy checks",
      },
    });

    expect(errors).toHaveLength(0);
  });
});
