type EnsureServerOptions = {
  binaryPath: string;
  attachUrl: string;
  host: string;
  port: number;
  workingDirectory: string;
  modelPing: () => Promise<void>;
  startupTimeoutMs?: number;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const ensureOpencodeServer = async (
  options: EnsureServerOptions,
): Promise<{ started: boolean }> => {
  try {
    await options.modelPing();
    return { started: false };
  } catch {
    // continue to spawn
  }

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

  const timeoutMs = options.startupTimeoutMs ?? 15_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await options.modelPing();
      return { started: true };
    } catch {
      await sleep(500);
    }
  }

  throw new Error(
    `Timed out waiting for opencode server at ${options.attachUrl}`,
  );
};
