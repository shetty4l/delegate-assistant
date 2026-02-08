const serveTarget = "http://127.0.0.1:4321";
const serveTimeoutMs = 4_000;

const runServeSetup = (): Bun.Subprocess => {
  const proc = Bun.spawn({
    cmd: [
      "tailscale",
      "serve",
      "--yes",
      "--bg",
      "--https=443",
      serveTarget,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });

  setTimeout(() => {
    if (proc.exitCode === null) {
      console.warn(
        `[session-manager] tailscale serve setup is still waiting. If Serve is disabled on your tailnet, enable it and restart this service. Continuing with local web UI on ${serveTarget}.`,
      );
    }
  }, serveTimeoutMs);

  return proc;
};

const startWebServer = async (serveProc: Bun.Subprocess): Promise<number> => {
  const webProc = Bun.spawn({
    cmd: [process.execPath, "run", "--cwd", "apps/session-manager-web", "dev"],
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  const stop = (signal: NodeJS.Signals): void => {
    try {
      serveProc.kill(signal);
    } catch {
      // no-op
    }
    try {
      webProc.kill(signal);
    } catch {
      // no-op
    }
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  const exitCode = await webProc.exited;
  try {
    serveProc.kill("SIGTERM");
  } catch {
    // no-op
  }
  return exitCode;
};

const serveProc = runServeSetup();
const exitCode = await startWebServer(serveProc);
process.exit(exitCode);
