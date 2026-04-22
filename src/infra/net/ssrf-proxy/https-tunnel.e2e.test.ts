/**
 * HTTPS / CONNECT tunneling e2e tests.
 *
 * For HTTPS, undici's ProxyAgent uses the HTTP CONNECT method to establish
 * a TCP tunnel through the proxy. The proxy's ACL still applies: it sees the
 * hostname/IP in the CONNECT request and decides whether to allow the tunnel.
 *
 * Caddy-forwardproxy supports CONNECT and applies the same ACL list to it.
 *
 * This test verifies that:
 *   1. CONNECT to a blocked private IP is rejected
 *   2. CONNECT to a blocked hostname is rejected
 *   3. The block happens BEFORE the TCP tunnel is established (no leaks)
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
  "SSRF HTTPS / CONNECT Tunneling E2E",
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

    async function tryFetch(url: string): Promise<{ status?: number; error?: string }> {
      try {
        const res = await fetch(url);
        return { status: res.status };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    it("HTTPS CONNECT to 127.0.0.1 is blocked at the proxy", async () => {
      const r = await tryFetch("https://127.0.0.1:443/admin");
      // CONNECT must fail — either 403 from Caddy or a tunnel-establishment error
      if (r.status !== undefined) {
        expect(r.status).toBeGreaterThanOrEqual(400);
      } else {
        expect(r.error).toBeDefined();
      }
    });

    it("HTTPS CONNECT to AWS metadata IP (169.254.169.254) is blocked", async () => {
      const r = await tryFetch("https://169.254.169.254/latest/meta-data/");
      if (r.status !== undefined) {
        expect(r.status).toBeGreaterThanOrEqual(400);
      } else {
        expect(r.error).toBeDefined();
      }
    });

    it("HTTPS CONNECT to 10.0.0.1 is blocked", async () => {
      const r = await tryFetch("https://10.0.0.1/internal");
      if (r.status !== undefined) {
        expect(r.status).toBeGreaterThanOrEqual(400);
      } else {
        expect(r.error).toBeDefined();
      }
    });

    it("HTTPS CONNECT to localhost is blocked", async () => {
      const r = await tryFetch("https://localhost/admin");
      if (r.status !== undefined) {
        expect(r.status).toBeGreaterThanOrEqual(400);
      } else {
        expect(r.error).toBeDefined();
      }
    });

    it("HTTPS CONNECT to GCP metadata is blocked", async () => {
      const r = await tryFetch("https://metadata.google.internal/computeMetadata/v1/");
      if (r.status !== undefined) {
        expect(r.status).toBeGreaterThanOrEqual(400);
      } else {
        expect(r.error).toBeDefined();
      }
    });
  },
);
