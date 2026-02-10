import { sleep } from "@assistant-core/src/timers";

type EnsureServerOptions = {
  binaryPath: string;
  attachUrl: string;
  host: string;
  port: number;
  workingDirectory: string;
  transportPing: () => Promise<void>;
  startupTimeoutMs?: number;
  spawnServer?: () => void;
  waitMs?: (ms: number) => Promise<void>;
};

export const probeOpencodeReachability = async (
  attachUrl: string,
  timeoutMs = 1_500,
): Promise<void> => {
  const response = await fetch(attachUrl, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response) {
    throw new Error(`OpenCode endpoint did not respond at ${attachUrl}`);
  }
};

export const ensureOpencodeServer = async (
  options: EnsureServerOptions,
): Promise<{ started: boolean }> => {
  const waitMs = options.waitMs ?? sleep;
  const spawnServer =
    options.spawnServer ??
    (() => {
      Bun.spawn({
        cmd: [
          options.binaryPath,
          "serve",
          "--hostname",
          options.host,
          "--port",
          String(options.port),
        ],
        cwd: options.workingDirectory,
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        detached: true,
      }).unref();
    });

  try {
    await options.transportPing();
    return { started: false };
  } catch {
    // continue to spawn
  }

  spawnServer();

  const timeoutMs = options.startupTimeoutMs ?? 15_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await options.transportPing();
      return { started: true };
    } catch {
      await waitMs(500);
    }
  }

  throw new Error(
    `Timed out waiting for reachable OpenCode endpoint at ${options.attachUrl}`,
  );
};
