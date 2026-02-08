import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const defaultConfigPath = "~/.config/delegate-assistant/config.json";
const defaultSqlitePath = "~/.local/share/delegate-assistant/data/assistant.db";

const expandHome = (inputPath: string): string => {
  if (inputPath === "~") {
    return homedir();
  }
  if (inputPath.startsWith("~/")) {
    return join(homedir(), inputPath.slice(2));
  }
  return inputPath;
};

const readConfigSqlitePath = (): string | null => {
  const sourcePath = expandHome(
    process.env.DELEGATE_CONFIG_PATH?.trim() || defaultConfigPath,
  );
  if (!existsSync(sourcePath)) {
    return null;
  }

  try {
    const raw = readFileSync(sourcePath, "utf8");
    const parsed = JSON.parse(raw) as { sqlitePath?: unknown };
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (typeof parsed.sqlitePath !== "string") {
      return null;
    }
    const trimmed = parsed.sqlitePath.trim();
    if (!trimmed) {
      return null;
    }
    return expandHome(trimmed);
  } catch {
    return null;
  }
};

export const resolveSessionDbPath = (): string => {
  const override = process.env.SESSION_MANAGER_SQLITE_PATH?.trim();
  if (override) {
    return expandHome(override);
  }

  return readConfigSqlitePath() ?? expandHome(defaultSqlitePath);
};
