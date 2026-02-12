import type { LogFields } from "@assistant-core/src/worker-types";

export const logInfo = (event: string, fields: LogFields = {}): void => {
  console.log(
    JSON.stringify({
      level: "info",
      event,
      ...fields,
    }),
  );
};

export const logWarn = (event: string, fields: LogFields = {}): void => {
  console.error(
    JSON.stringify({
      level: "warn",
      event,
      ...fields,
    }),
  );
};

export const logError = (event: string, fields: LogFields = {}): void => {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      ...fields,
    }),
  );
};

export const nowIso = (): string => new Date().toISOString();
