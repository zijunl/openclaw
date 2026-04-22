/**
 * Test fixture for spawning a real Caddy process in e2e tests.
 *
 * Uses the test caddy binary built by scripts/build-test-caddy.sh which
 * includes the forwardproxy plugin. If the binary is missing, the fixture
 * throws with instructions to run the build script.
 */

import { existsSync, accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaddySsrFProxyConfigOptions } from "../caddy-config.js";
import { startCaddyProxy, type CaddyProxyHandle } from "../proxy-process.js";

/** Path to the test caddy binary (built by scripts/build-test-caddy.sh) */
export function getTestCaddyBinaryPath(): string {
  // Resolve relative to the worktree root
  // __dirname equivalent in ESM:
  const here = fileURLToPath(new URL(".", import.meta.url));
  // src/infra/net/ssrf-proxy/test-helpers → repo root
  return resolve(here, "../../../../../.test-fixtures/caddy-with-forwardproxy");
}

export class TestCaddyMissingError extends Error {
  constructor(path: string) {
    super(
      `Test caddy binary not found at ${path}.\n` +
        `Run: ./scripts/build-test-caddy.sh from the repo root.\n` +
        `(Requires Go 1.21+ — the build takes 1-2 minutes the first time.)`,
    );
    this.name = "TestCaddyMissingError";
  }
}

/**
 * Verify the test caddy binary exists and is executable. Throws a helpful
 * error if it's missing or unusable.
 */
export function ensureTestCaddyAvailable(): string {
  const path = getTestCaddyBinaryPath();
  if (!existsSync(path)) {
    throw new TestCaddyMissingError(path);
  }
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`Test caddy binary at ${path} is not executable`);
  }
  return path;
}

/**
 * Start a real Caddy proxy for use in e2e tests.
 *
 * @param opts - Optional overrides for the Caddy config (extraBlockedCidrs etc.)
 * @returns Handle that must be passed to stopTestSsrFProxy in afterEach/afterAll
 */
export async function startTestSsrFProxy(
  opts?: Omit<CaddySsrFProxyConfigOptions, "port"> & { binaryPath?: string },
): Promise<CaddyProxyHandle> {
  const binaryPath = opts?.binaryPath ?? ensureTestCaddyAvailable();
  return startCaddyProxy({
    binaryPath,
    extraBlockedCidrs: opts?.extraBlockedCidrs,
    extraAllowedHosts: opts?.extraAllowedHosts,
    upstreamProxy: opts?.upstreamProxy,
  });
}

/**
 * Stop a Caddy test proxy. Safe to call with null/undefined.
 */
export async function stopTestSsrFProxy(
  handle: CaddyProxyHandle | null | undefined,
): Promise<void> {
  if (handle) {
    await handle.stop();
  }
}

/**
 * Skip a test gracefully if the test caddy binary is missing.
 * Use in beforeAll: `if (!isTestCaddyAvailable()) ctx.skip();`
 */
export function isTestCaddyAvailable(): boolean {
  try {
    ensureTestCaddyAvailable();
    return true;
  } catch {
    return false;
  }
}
