/**
 * Manages the Caddy forward proxy subprocess lifecycle for openclaw's
 * network-level SSRF protection.
 *
 * Responsibilities:
 *  - Pick a free loopback port
 *  - Locate the caddy binary
 *  - Spawn caddy with our generated config (via stdin)
 *  - Monitor for unexpected exits and emit warnings
 *  - Gracefully shut down on request
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { logInfo, logWarn } from "../../../logger.js";
import { buildCaddySsrFProxyConfigJson } from "./caddy-config.js";
import type { CaddySsrFProxyConfigOptions } from "./caddy-config.js";

export type CaddyProcessOptions = Omit<CaddySsrFProxyConfigOptions, "port"> & {
  /** Override path to the caddy binary. Defaults to resolving from PATH. */
  binaryPath?: string;
};

export type CaddyProxyHandle = {
  /** The port Caddy is listening on. */
  port: number;
  /** The proxy URL to set in environment variables. */
  proxyUrl: string;
  /** Gracefully stop the Caddy process. */
  stop: () => Promise<void>;
};

const CADDY_STARTUP_TIMEOUT_MS = 10_000;
const CADDY_HEALTHCHECK_INTERVAL_MS = 500;
const CADDY_GRACEFUL_STOP_TIMEOUT_MS = 5_000;

/**
 * Picks a random free TCP port on the loopback interface.
 * Resolves to the port number.
 */
export async function pickFreeLocalhostPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to determine free port"));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
    server.on("error", reject);
  });
}

/**
 * Resolves the path to the caddy binary.
 * Priority: explicit binaryPath option → OPENCLAW_CADDY_BINARY env var → 'caddy' (from PATH).
 */
export function resolveCaddyBinaryPath(binaryPath?: string): string {
  if (binaryPath) {
    return binaryPath;
  }
  const envPath = process.env["OPENCLAW_CADDY_BINARY"];
  if (typeof envPath === "string" && envPath.trim().length > 0) {
    return envPath.trim();
  }
  return "caddy";
}

/**
 * Waits until the Caddy proxy is accepting TCP connections on the given port,
 * or throws if the timeout is exceeded or the process exits unexpectedly.
 */
async function waitForCaddyReady(params: {
  port: number;
  process: ChildProcess;
  timeoutMs: number;
}): Promise<void> {
  const { port, process: proc, timeoutMs } = params;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Check if the process has already exited
    if (proc.exitCode !== null || proc.killed) {
      throw new Error(
        `Caddy process exited unexpectedly during startup (exit code: ${proc.exitCode})`,
      );
    }

    // Try connecting to the proxy port
    const ready = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.setTimeout(CADDY_HEALTHCHECK_INTERVAL_MS, () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (ready) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, CADDY_HEALTHCHECK_INTERVAL_MS));
  }

  throw new Error(`Caddy proxy did not become ready within ${timeoutMs}ms on port ${port}`);
}

/**
 * Spawns the Caddy forward proxy as a child process, waits for it to be ready,
 * and returns a handle to control it.
 *
 * Throws if caddy is not found or fails to start within the timeout.
 */
export async function startCaddyProxy(options: CaddyProcessOptions): Promise<CaddyProxyHandle> {
  const port = await pickFreeLocalhostPort();
  const binaryPath = resolveCaddyBinaryPath(options.binaryPath);

  const configJson = buildCaddySsrFProxyConfigJson({
    port,
    extraBlockedCidrs: options.extraBlockedCidrs,
    extraAllowedHosts: options.extraAllowedHosts,
    upstreamProxy: options.upstreamProxy,
  });

  logInfo(`ssrf-proxy: starting Caddy on 127.0.0.1:${port} (binary: ${binaryPath})`);

  let proc: ChildProcess;
  try {
    proc = spawn(binaryPath, ["run", "--config", "-", "--adapter", ""], {
      // Pass config via stdin
      stdio: ["pipe", "pipe", "pipe"],
      // Inherit a clean environment; don't let Caddy pick up unexpected proxy env vars
      env: {
        HOME: process.env["HOME"],
        PATH: process.env["PATH"],
        TMPDIR: process.env["TMPDIR"],
        TMP: process.env["TMP"],
        TEMP: process.env["TEMP"],
      },
    });
  } catch (err) {
    throw new Error(`ssrf-proxy: failed to spawn caddy binary "${binaryPath}": ${String(err)}`, { cause: err });
  }

  if (!proc.stdin) {
    proc.kill();
    throw new Error("ssrf-proxy: Caddy process stdin not available");
  }

  // Write the config JSON to Caddy's stdin and close it
  proc.stdin.write(configJson);
  proc.stdin.end();

  // Relay Caddy's stderr to our logger
  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) {
      logWarn(`ssrf-proxy [caddy]: ${line}`);
    }
  });

  // Relay Caddy's stdout to our logger (verbose info)
  proc.stdout?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) {
      logInfo(`ssrf-proxy [caddy]: ${line}`);
    }
  });

  let stopped = false;

  proc.on("exit", (code, signal) => {
    if (!stopped) {
      logWarn(
        `ssrf-proxy: Caddy exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}). ` +
          `SSRF network-level protection is degraded — application-level guards remain active.`,
      );
    }
  });

  // Wait for Caddy to accept connections
  try {
    await waitForCaddyReady({
      port,
      process: proc,
      timeoutMs: CADDY_STARTUP_TIMEOUT_MS,
    });
  } catch (err) {
    proc.kill("SIGTERM");
    throw err;
  }

  logInfo(`ssrf-proxy: Caddy ready on 127.0.0.1:${port}`);

  const proxyUrl = `http://127.0.0.1:${port}`;

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;

    if (proc.exitCode !== null || proc.killed) {
      return;
    }

    logInfo("ssrf-proxy: stopping Caddy");

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logWarn("ssrf-proxy: Caddy did not stop gracefully, sending SIGKILL");
        proc.kill("SIGKILL");
        resolve();
      }, CADDY_GRACEFUL_STOP_TIMEOUT_MS);

      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      proc.kill("SIGTERM");
    });
  };

  return { port, proxyUrl, stop };
}
