import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type RuntimeInfo = {
  bunVersion: string;
  nodeCompat: string;
};

export type BuildInfo = {
  service: string;
  releaseVersion: string;
  displayVersion: string;
  gitSha: string;
  gitShortSha: string;
  gitBranch: string;
  commitTitle: string;
  buildTimeUtc: string;
  runtime: RuntimeInfo;
};

type BuildInfoInput = {
  repoRoot?: string;
  now?: () => Date;
  env?: Record<string, string | undefined>;
};

const UNKNOWN = "unknown";

const readText = (value: Uint8Array<ArrayBufferLike>): string =>
  new TextDecoder().decode(value).trim();

const readGitValue = (repoRoot: string, args: string[]): string | null => {
  const command = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (command.exitCode !== 0) {
    return null;
  }

  const output = readText(command.stdout);
  return output.length > 0 ? output : null;
};

const resolveRepoRoot = (): string => resolve(import.meta.dir, "../../..");

const readRootPackage = (
  repoRoot: string,
): { name?: string; version?: string } => {
  try {
    const packageJsonPath = join(repoRoot, "package.json");
    const raw = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as { name?: string; version?: string };
  } catch {
    return {};
  }
};

const asNonEmpty = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const shortSha = (sha: string): string => {
  if (sha === UNKNOWN) {
    return UNKNOWN;
  }
  return sha.slice(0, 7);
};

export const formatVersionFingerprint = (buildInfo: BuildInfo): string =>
  `${buildInfo.service} ${buildInfo.displayVersion} (branch ${buildInfo.gitBranch}, built ${buildInfo.buildTimeUtc}) - ${buildInfo.commitTitle}`;

export const loadBuildInfo = (input: BuildInfoInput = {}): BuildInfo => {
  const repoRoot = input.repoRoot ?? resolveRepoRoot();
  const env = input.env ?? process.env;
  const now = input.now ?? (() => new Date());
  const packageJson = readRootPackage(repoRoot);

  const service = asNonEmpty(packageJson.name) ?? "delegate-assistant";
  const releaseVersion = asNonEmpty(packageJson.version) ?? "0.0.0";
  const gitSha =
    asNonEmpty(env.GIT_SHA) ??
    readGitValue(repoRoot, ["rev-parse", "HEAD"]) ??
    UNKNOWN;
  const gitBranch =
    asNonEmpty(env.GIT_BRANCH) ??
    readGitValue(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) ??
    UNKNOWN;
  const commitTitle =
    asNonEmpty(env.GIT_COMMIT_TITLE) ??
    readGitValue(repoRoot, ["log", "-1", "--pretty=%s"]) ??
    UNKNOWN;
  const buildTimeUtc = asNonEmpty(env.BUILD_TIME_UTC) ?? now().toISOString();
  const gitShortSha = shortSha(gitSha);
  const displayVersion =
    gitShortSha === UNKNOWN
      ? releaseVersion
      : `${releaseVersion}+${gitShortSha}`;

  return {
    service,
    releaseVersion,
    displayVersion,
    gitSha,
    gitShortSha,
    gitBranch,
    commitTitle,
    buildTimeUtc,
    runtime: {
      bunVersion: Bun.version,
      nodeCompat: process.versions.node,
    },
  };
};
