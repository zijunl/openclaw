/**
 * Unit tests for proxy-lifecycle.ts — dual-stack env var injection.
 *
 * These tests verify that startSsrFProxy correctly sets the env vars for both
 * enforcement layers without actually spawning a Caddy process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the heavy dependencies before importing the module under test
vi.mock("./proxy-process.js", () => ({
  startCaddyProxy: vi.fn(),
}));

vi.mock("../undici-global-dispatcher.js", () => ({
  forceResetGlobalDispatcher: vi.fn(),
}));

vi.mock("global-agent", () => ({
  bootstrap: vi.fn(),
  createGlobalProxyAgent: vi.fn(),
}));

vi.mock("../../../logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { bootstrap as bootstrapGlobalAgent } from "global-agent";
import { forceResetGlobalDispatcher } from "../undici-global-dispatcher.js";
import {
  startSsrFProxy,
  stopSsrFProxy,
  _resetGlobalAgentBootstrapForTests,
} from "./proxy-lifecycle.js";
import { startCaddyProxy } from "./proxy-process.js";

const mockStartCaddyProxy = vi.mocked(startCaddyProxy);
const mockForceResetGlobalDispatcher = vi.mocked(forceResetGlobalDispatcher);
const mockBootstrapGlobalAgent = vi.mocked(bootstrapGlobalAgent);

function makeFakeHandle(port = 19876) {
  const proxyUrl = `http://127.0.0.1:${port}`;
  return {
    port,
    proxyUrl,
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe("startSsrFProxy — env var injection", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeysToClean = [
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "no_proxy",
    "NO_PROXY",
    "GLOBAL_AGENT_HTTP_PROXY",
    "GLOBAL_AGENT_HTTPS_PROXY",
    "GLOBAL_AGENT_NO_PROXY",
  ];

  beforeEach(() => {
    // Save and clear proxy-related env vars
    for (const key of envKeysToClean) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Reset mocks
    mockStartCaddyProxy.mockReset();
    mockForceResetGlobalDispatcher.mockReset();
    mockBootstrapGlobalAgent.mockReset();
    // Reset the module-level bootstrapped flag so each test gets a clean slate
    _resetGlobalAgentBootstrapForTests();
    (global as Record<string, unknown>)["GLOBAL_AGENT"] = undefined;
  });

  afterEach(() => {
    // Restore env vars
    for (const key of envKeysToClean) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("returns null and does not touch env when disabled: false", async () => {
    const handle = await startSsrFProxy({ enabled: false });
    expect(handle).toBeNull();
    expect(process.env["http_proxy"]).toBeUndefined();
    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBeUndefined();
  });

  it("returns null and logs warning when Caddy fails to start", async () => {
    mockStartCaddyProxy.mockRejectedValue(new Error("caddy not found"));
    const handle = await startSsrFProxy(undefined);
    expect(handle).toBeNull();
    expect(process.env["http_proxy"]).toBeUndefined();
  });

  it("sets Layer A env vars (undici) when Caddy starts successfully", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy(undefined);

    expect(process.env["http_proxy"]).toBe(fake.proxyUrl);
    expect(process.env["https_proxy"]).toBe(fake.proxyUrl);
  });

  it("sets Layer B env vars (global-agent) when Caddy starts successfully", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy(undefined);

    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBe(fake.proxyUrl);
    expect(process.env["GLOBAL_AGENT_HTTPS_PROXY"]).toBe(fake.proxyUrl);
  });

  it("sets NO_PROXY to exclude loopback on both layers", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy(undefined);

    expect(process.env["no_proxy"]).toContain("127.0.0.1");
    expect(process.env["NO_PROXY"]).toContain("127.0.0.1");
    expect(process.env["GLOBAL_AGENT_NO_PROXY"]).toContain("127.0.0.1");
  });

  it("preserves existing NO_PROXY entries when adding loopback exclusions", async () => {
    process.env["NO_PROXY"] = "corp.example.com";
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy(undefined);

    expect(process.env["NO_PROXY"]).toContain("corp.example.com");
    expect(process.env["NO_PROXY"]).toContain("127.0.0.1");
  });

  it("calls forceResetGlobalDispatcher (Layer A activation)", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy(undefined);

    expect(mockForceResetGlobalDispatcher).toHaveBeenCalledOnce();
  });

  it("calls global-agent bootstrap (Layer B activation) on first proxy start", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy(undefined);

    // bootstrap() must be called exactly once (flag is reset in beforeEach)
    expect(mockBootstrapGlobalAgent).toHaveBeenCalledOnce();
  });

  it("does NOT call global-agent bootstrap again on subsequent proxy starts", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    // First start (bootstraps)
    await startSsrFProxy(undefined);
    // Second start (should skip bootstrap since flag is set)
    await startSsrFProxy(undefined);

    expect(mockBootstrapGlobalAgent).toHaveBeenCalledOnce();
  });

  it("removes proxy env vars when handle.stop() is called", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    const handle = await startSsrFProxy(undefined);
    expect(handle).not.toBeNull();

    await stopSsrFProxy(handle);

    expect(process.env["http_proxy"]).toBeUndefined();
    expect(process.env["https_proxy"]).toBeUndefined();
    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBeUndefined();
    expect(process.env["GLOBAL_AGENT_HTTPS_PROXY"]).toBeUndefined();
  });

  it("passes binaryPath from config to startCaddyProxy", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy({ binaryPath: "/custom/caddy" });

    expect(mockStartCaddyProxy).toHaveBeenCalledWith(
      expect.objectContaining({ binaryPath: "/custom/caddy" }),
    );
  });

  it("passes extraBlockedCidrs from config to startCaddyProxy", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy({ extraBlockedCidrs: ["203.0.113.0/24"] });

    expect(mockStartCaddyProxy).toHaveBeenCalledWith(
      expect.objectContaining({ extraBlockedCidrs: ["203.0.113.0/24"] }),
    );
  });

  it("passes extraAllowedHosts from config to startCaddyProxy", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy({ extraAllowedHosts: ["internal.corp"] });

    expect(mockStartCaddyProxy).toHaveBeenCalledWith(
      expect.objectContaining({ extraAllowedHosts: ["internal.corp"] }),
    );
  });

  it("passes userProxy from config as upstreamProxy to startCaddyProxy", async () => {
    const fake = makeFakeHandle();
    mockStartCaddyProxy.mockResolvedValue(fake);

    await startSsrFProxy({ userProxy: "http://corp-proxy.example.com:8080" });

    expect(mockStartCaddyProxy).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamProxy: "http://corp-proxy.example.com:8080" }),
    );
  });

  it("stopSsrFProxy is a no-op when handle is null", async () => {
    await expect(stopSsrFProxy(null)).resolves.toBeUndefined();
  });
});
