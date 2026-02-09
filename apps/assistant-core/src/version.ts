import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const SERVICE_NAME = "delegate-assistant";
const DEV_VERSION = "0.0.0-dev";
const UNKNOWN = "unknown";

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

const readVersionFile = (repoRoot: string): string | null => {
  try {
    const versionPath = join(repoRoot, "VERSION");
    const raw = readFileSync(versionPath, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
};

const resolveRepoRoot = (): string => {
  const cwd = process.cwd();
  try {
    const pkg = readFileSync(join(cwd, "package.json"), "utf8");
    const parsed = JSON.parse(pkg);
    if (parsed?.name === SERVICE_NAME) {
      return cwd;
    }
  } catch {
    // not the repo root
  }
  // fallback: assume we're in apps/assistant-core or similar
  return join(import.meta.dir, "../../..");
};

export const formatVersionFingerprint = (buildInfo: BuildInfo): string =>
  `${buildInfo.service} ${buildInfo.displayVersion} (branch ${buildInfo.gitBranch}, built ${buildInfo.buildTimeUtc})`;

export const loadBuildInfo = (input: BuildInfoInput = {}): BuildInfo => {
  const repoRoot = input.repoRoot ?? resolveRepoRoot();
  const env = input.env ?? process.env;
  const now = input.now ?? (() => new Date());

  const releaseVersion = readVersionFile(repoRoot) ?? DEV_VERSION;
  const gitSha = asNonEmpty(env.GIT_SHA) ?? UNKNOWN;
  const gitBranch = asNonEmpty(env.GIT_BRANCH) ?? UNKNOWN;
  const commitTitle = asNonEmpty(env.GIT_COMMIT_TITLE) ?? UNKNOWN;
  const buildTimeUtc = asNonEmpty(env.BUILD_TIME_UTC) ?? now().toISOString();
  const gitShortSha = shortSha(gitSha);
  const displayVersion = releaseVersion;

  return {
    service: SERVICE_NAME,
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
