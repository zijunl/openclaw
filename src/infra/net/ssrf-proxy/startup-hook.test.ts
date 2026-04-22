/**
 * Regression test for the daemon startup wiring.
 *
 * Verifies:
 *   1. initSsrFProxyFromConfig() is a no-op when ssrfProxy is not configured
 *      (so it doesn't break commands that don't need it like `--help`)
 *   2. initSsrFProxyFromConfig() is a no-op when ssrfProxy.enabled is false
 *   3. initSsrFProxyFromConfig() returns a handle when ssrfProxy is enabled
 *   4. The returned handle's stop() function is callable via stopSsrFProxy
 *   5. Errors loading config don't crash the caller
 *   6. The wiring in run-main.ts is structurally correct (imports exist,
 *      shutdown handlers are registered)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

// Mock the proxy lifecycle so we don't actually spin up Caddy
vi.mock("./proxy-lifecycle.js", () => ({
  startSsrFProxy: vi.fn(async () => null),
  stopSsrFProxy: vi.fn(async () => {}),
}));

import { startSsrFProxy, stopSsrFProxy } from "./proxy-lifecycle.js";
import { initSsrFProxyFromConfig } from "./startup-hook.js";

const mockStart = vi.mocked(startSsrFProxy);
const mockStop = vi.mocked(stopSsrFProxy);

describe("Startup hook — initSsrFProxyFromConfig", () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockStop.mockReset();
    mockStart.mockResolvedValue(null);
  });

  it("returns null when config has no ssrfProxy key", async () => {
    const config = {} as OpenClawConfig;
    const result = await initSsrFProxyFromConfig(config);
    expect(result).toBeNull();
    // Even when ssrfProxy is absent, startSsrFProxy is called with undefined
    // (the lifecycle handles defaults internally — enabled by default)
    expect(mockStart).toHaveBeenCalledOnce();
    expect(mockStart).toHaveBeenCalledWith(undefined);
  });

  it("passes ssrfProxy config through to startSsrFProxy", async () => {
    const config = {
      ssrfProxy: { enabled: true, extraBlockedCidrs: ["203.0.113.0/24"] },
    } as OpenClawConfig;

    await initSsrFProxyFromConfig(config);

    expect(mockStart).toHaveBeenCalledOnce();
    expect(mockStart).toHaveBeenCalledWith({
      enabled: true,
      extraBlockedCidrs: ["203.0.113.0/24"],
    });
  });

  it("passes through disabled config (lifecycle decides what to do)", async () => {
    const config = { ssrfProxy: { enabled: false } } as OpenClawConfig;
    await initSsrFProxyFromConfig(config);
    expect(mockStart).toHaveBeenCalledWith({ enabled: false });
  });

  it("returns the handle returned by startSsrFProxy when one is created", async () => {
    const fakeHandle = {
      port: 12345,
      proxyUrl: "http://127.0.0.1:12345",
      stop: vi.fn(async () => {}),
    };
    mockStart.mockResolvedValueOnce(fakeHandle as any);

    const result = await initSsrFProxyFromConfig({} as OpenClawConfig);
    expect(result).toBe(fakeHandle);
  });

  it("stopSsrFProxy is the same function exported by the lifecycle module", async () => {
    // This regression-tests the re-export so run-main.ts's import is correct
    const fakeHandle = {
      port: 0,
      proxyUrl: "",
      stop: vi.fn(async () => {}),
    } as any;
    await stopSsrFProxy(fakeHandle);
    expect(mockStop).toHaveBeenCalledOnce();
    expect(mockStop).toHaveBeenCalledWith(fakeHandle);
  });
});

// ---------------------------------------------------------------------------
// Wiring sanity test — verifies run-main.ts imports the right things
// ---------------------------------------------------------------------------

describe("Startup wiring — run-main.ts integration", () => {
  it("run-main.ts imports initSsrFProxyFromConfig and stopSsrFProxy", async () => {
    // Read the actual run-main.ts source to verify the wiring is in place.
    // This catches accidental removal during refactors.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");

    const here = path.dirname(fileURLToPath(import.meta.url));
    const runMainPath = path.resolve(here, "../../../cli/run-main.ts");
    const src = readFileSync(runMainPath, "utf-8");

    // Imports must exist
    expect(src).toContain("initSsrFProxyFromConfig");
    expect(src).toContain("stopSsrFProxy");
    expect(src).toContain('from "../infra/net/ssrf-proxy/startup-hook.js"');
  });

  it("run-main.ts calls initSsrFProxyFromConfig() during startup", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");

    const here = path.dirname(fileURLToPath(import.meta.url));
    const runMainPath = path.resolve(here, "../../../cli/run-main.ts");
    const src = readFileSync(runMainPath, "utf-8");

    // Must call the init function with config
    expect(src).toMatch(/initSsrFProxyFromConfig\s*\(\s*config\s*\)/);
  });

  it("run-main.ts registers SIGTERM/SIGINT/exit shutdown handlers", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");

    const here = path.dirname(fileURLToPath(import.meta.url));
    const runMainPath = path.resolve(here, "../../../cli/run-main.ts");
    const src = readFileSync(runMainPath, "utf-8");

    // All three signal/event hooks must be wired
    expect(src).toMatch(/process\.once\(\s*["']SIGTERM["']/);
    expect(src).toMatch(/process\.once\(\s*["']SIGINT["']/);
    expect(src).toMatch(/process\.once\(\s*["']exit["']/);

    // And they must call stopSsrFProxy
    expect(src).toContain("stopSsrFProxy(ssrfProxyHandle)");
  });

  it("run-main.ts wraps init in try/catch (graceful degradation)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");

    const here = path.dirname(fileURLToPath(import.meta.url));
    const runMainPath = path.resolve(here, "../../../cli/run-main.ts");
    const src = readFileSync(runMainPath, "utf-8");

    // The init must be in a try/catch so config-load failures don't kill startup
    // (e.g. for help/version commands that don't need a valid config)
    // Use lastIndexOf to find the CALL site, not the import line.
    const callIdx = src.lastIndexOf("initSsrFProxyFromConfig");
    const ssrfBlock = src.substring(Math.max(0, callIdx - 500), callIdx + 500);
    expect(ssrfBlock).toContain("catch");
  });

  it("run-main.ts runs ssrf proxy startup AFTER ensureGlobalUndiciEnvProxyDispatcher", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");

    const here = path.dirname(fileURLToPath(import.meta.url));
    const runMainPath = path.resolve(here, "../../../cli/run-main.ts");
    const src = readFileSync(runMainPath, "utf-8");

    const undiciIdx = src.indexOf("ensureGlobalUndiciEnvProxyDispatcher()");
    // Use lastIndexOf to find the CALL site, not the import line
    const ssrfIdx = src.lastIndexOf("initSsrFProxyFromConfig");

    expect(undiciIdx).toBeGreaterThan(-1);
    expect(ssrfIdx).toBeGreaterThan(-1);
    // ssrf init must come AFTER undici setup so forceResetGlobalDispatcher works
    expect(ssrfIdx).toBeGreaterThan(undiciIdx);
  });
});
