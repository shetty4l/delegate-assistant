import { readFileSync } from "node:fs";
import { join } from "node:path";

export type VersionPolicyInput = {
  env?: Record<string, string | undefined>;
  packageVersion: string;
};

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const shaPattern = /^[a-f0-9]{40}$/;

const asNonEmpty = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const getTagVersion = (ref: string | undefined): string | null => {
  if (!ref?.startsWith("refs/tags/v")) {
    return null;
  }
  return ref.slice("refs/tags/v".length);
};

const requiresCiMetadata = (env: Record<string, string | undefined>): boolean =>
  env.CI === "true";

export const validateVersionPolicy = (
  input: VersionPolicyInput,
): string[] => {
  const env = input.env ?? process.env;
  const errors: string[] = [];
  const packageVersion = input.packageVersion;

  if (!semverPattern.test(packageVersion)) {
    errors.push(
      `package.json version must be valid SemVer (received ${packageVersion})`,
    );
  }

  const tagVersion = getTagVersion(env.GITHUB_REF);
  if (tagVersion !== null) {
    if (!semverPattern.test(tagVersion)) {
      errors.push(`release tag must match vX.Y.Z SemVer (received ${tagVersion})`);
    }

    if (tagVersion !== packageVersion) {
      errors.push(
        `release tag version (${tagVersion}) must match package.json version (${packageVersion})`,
      );
    }
  }

  if (!requiresCiMetadata(env)) {
    return errors;
  }

  const gitSha = asNonEmpty(env.GIT_SHA);
  if (!gitSha || !shaPattern.test(gitSha)) {
    errors.push("GIT_SHA must be set to a full 40-char lowercase git commit sha");
  }

  const gitBranch = asNonEmpty(env.GIT_BRANCH);
  if (!gitBranch || gitBranch === "unknown") {
    errors.push("GIT_BRANCH must be set and not 'unknown'");
  }

  const commitTitle = asNonEmpty(env.GIT_COMMIT_TITLE);
  if (!commitTitle || commitTitle === "unknown") {
    errors.push("GIT_COMMIT_TITLE must be set and not 'unknown'");
  }

  return errors;
};

const loadRootPackageVersion = (): string => {
  const rootPackagePath = join(import.meta.dir, "..", "package.json");
  const raw = readFileSync(rootPackagePath, "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error("package.json version field must be a string");
  }
  return parsed.version;
};

const run = (): void => {
  const packageVersion = loadRootPackageVersion();
  const errors = validateVersionPolicy({ packageVersion });

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`version-policy: ${error}`);
    }
    process.exit(1);
  }

  console.log("version-policy: ok");
};

if (import.meta.main) {
  run();
}
