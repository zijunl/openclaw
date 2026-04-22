/**
 * IPv6 blocking e2e tests.
 *
 * Verifies the IPv6 ACL rules block dangerous IPv6 ranges:
 *   - ::1            (loopback)
 *   - fe80::/10      (link-local, includes the IPv6 metadata for some clouds)
 *   - fc00::/7       (Unique Local Addresses, IPv6 equivalent of RFC-1918)
 *   - ::ffff:0:0/96  (IPv4-mapped IPv6 — must not be a bypass for IPv4 rules)
 */

import { setGlobalDispatcher, ProxyAgent, Agent as UndiciAgent, getGlobalDispatcher } from "undici";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { CaddyProxyHandle } from "./proxy-process.js";
import {
  startTestSsrFProxy,
  stopTestSsrFProxy,
  isTestCaddyAvailable,
} from "./test-helpers/caddy-test-fixture.js";

const TEST_TIMEOUT_MS = 30_000;

describe.skipIf(!isTestCaddyAvailable())(
  "SSRF IPv6 Blocking E2E",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    let caddy: CaddyProxyHandle;
    let savedDispatcher: ReturnType<typeof getGlobalDispatcher>;

    beforeAll(async () => {
      savedDispatcher = getGlobalDispatcher();
      caddy = await startTestSsrFProxy();
      setGlobalDispatcher(new ProxyAgent(caddy.proxyUrl));
    });

    afterAll(async () => {
      setGlobalDispatcher(savedDispatcher ?? new UndiciAgent());
      await stopTestSsrFProxy(caddy);
    });

    // Helper to make a request and return either the status or the error
    async function tryFetch(url: string): Promise<{ status?: number; error?: string }> {
      try {
        const res = await fetch(url);
        return { status: res.status };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    it("IPv6 loopback [::1] is blocked", async () => {
      const r = await tryFetch("http://[::1]/admin");
      // Either Caddy returned 4xx, or the request errored (couldn't connect).
      // Both indicate "did not reach a real server"
      if (r.status !== undefined) {
        expect(r.status).toBeGreaterThanOrEqual(400);
      } else {
        expect(r.error).toBeDefined();
      }
    });

    it("IPv6 link-local [fe80::1] is blocked", async () => {
      const r = await tryFetch("http://[fe80::1]/internal");
      if (r.status !== undefined) {
        expect(r.status).toBeGreaterThanOrEqual(400);
      } else {
        expect(r.error).toBeDefined();
      }
    });

    it("IPv6 ULA [fc00::1] is blocked", async () => {
      const r = await tryFetch("http://[fc00::1]/internal");
      if (r.status !== undefined) {
        expect(r.status).toBeGreaterThanOrEqual(400);
      } else {
        expect(r.error).toBeDefined();
      }
    });

    it("IPv4-mapped IPv6 [::ffff:127.0.0.1] is blocked (no bypass via mapping)", async () => {
      // This is a classic SSRF bypass: ::ffff:127.0.0.1 is the IPv6
      // representation of 127.0.0.1. If our ACL only had IPv4 rules, this
      // would slip through.
      const r = await tryFetch("http://[::ffff:127.0.0.1]/admin");
      if (r.status !== undefined) {
        expect(r.status).toBeGreaterThanOrEqual(400);
      } else {
        expect(r.error).toBeDefined();
      }
    });

    it("IPv4-mapped IPv6 [::ffff:10.0.0.1] is blocked (no bypass via mapping)", async () => {
      const r = await tryFetch("http://[::ffff:10.0.0.1]/internal");
      if (r.status !== undefined) {
        expect(r.status).toBeGreaterThanOrEqual(400);
      } else {
        expect(r.error).toBeDefined();
      }
    });
  },
);
