/**
 * Upstream proxy chaining e2e tests.
 *
 * Some openclaw deployments sit behind a corporate HTTP proxy. The user can
 * configure `ssrfProxy.userProxy` to point at it; Caddy then chains all
 * outbound traffic through that upstream proxy AFTER applying its ACL.
 *
 * This test verifies:
 *   1. Caddy starts cleanly with `upstreamProxy` configured
 *   2. The generated config contains the upstream directive
 *   3. The ACL still applies (private IPs still blocked even with upstream)
 */

import { createServer } from "node:http";
import { setGlobalDispatcher, ProxyAgent, Agent as UndiciAgent, getGlobalDispatcher } from "undici";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildCaddySsrFProxyConfig } from "./caddy-config.js";
import type { CaddyProxyHandle } from "./proxy-process.js";
import {
  startTestSsrFProxy,
  stopTestSsrFProxy,
  isTestCaddyAvailable,
} from "./test-helpers/caddy-test-fixture.js";

const TEST_TIMEOUT_MS = 30_000;

describe("Caddy config — upstreamProxy", () => {
  it("includes the upstream directive in the handler config", () => {
    const config = buildCaddySsrFProxyConfig({
      port: 8080,
      upstreamProxy: "http://corp-proxy:3128",
    }) as Record<string, unknown>;

    // Walk to the handler config — it's nested in the apps.http config
    const apps = config["apps"] as Record<string, unknown>;
    const httpApp = apps["http"] as Record<string, unknown>;
    const servers = httpApp["servers"] as Record<string, unknown>;
    const proxyServer = servers["ssrf-proxy"] as Record<string, unknown>;
    const routes = proxyServer["routes"] as Array<Record<string, unknown>>;
    const route = routes[0]!;
    const handlers = route["handle"] as Array<Record<string, unknown>>;
    const handler = handlers[0]!;

    expect(handler["upstream"]).toBe("http://corp-proxy:3128");
  });

  it("omits the upstream directive when not set", () => {
    const config = buildCaddySsrFProxyConfig({ port: 8080 }) as Record<string, unknown>;
    const apps = config["apps"] as Record<string, unknown>;
    const httpApp = apps["http"] as Record<string, unknown>;
    const servers = httpApp["servers"] as Record<string, unknown>;
    const proxyServer = servers["ssrf-proxy"] as Record<string, unknown>;
    const routes = proxyServer["routes"] as Array<Record<string, unknown>>;
    const handlers = routes[0]!["handle"] as Array<Record<string, unknown>>;

    expect(handlers[0]!["upstream"]).toBeUndefined();
  });
});

describe.skipIf(!isTestCaddyAvailable())(
  "SSRF Upstream Proxy E2E — Caddy chains through user-supplied proxy",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    let caddy: CaddyProxyHandle;
    let upstreamServer: ReturnType<typeof createServer>;
    let upstreamPort: number;
    let upstreamHits: string[] = [];
    let savedDispatcher: ReturnType<typeof getGlobalDispatcher>;

    beforeAll(async () => {
      savedDispatcher = getGlobalDispatcher();

      // Spin up a test "upstream proxy" — a simple HTTP server that records
      // incoming forward-proxy requests
      upstreamServer = createServer((req, res) => {
        upstreamHits.push(req.url ?? "");
        res.statusCode = 200;
        res.end("UPSTREAM_REACHED");
      });
      await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
      upstreamPort = (upstreamServer.address() as { port: number }).port;

      caddy = await startTestSsrFProxy({
        upstreamProxy: `http://127.0.0.1:${upstreamPort}`,
        // Allow the upstream itself so Caddy can reach it for chaining
        extraAllowedHosts: ["127.0.0.1"],
      });
      setGlobalDispatcher(new ProxyAgent(caddy.proxyUrl));
    });

    afterAll(async () => {
      setGlobalDispatcher(savedDispatcher ?? new UndiciAgent());
      await stopTestSsrFProxy(caddy);
      await new Promise<void>((resolve, reject) => {
        if (
          typeof (upstreamServer as { closeAllConnections?: () => void }).closeAllConnections ===
          "function"
        ) {
          (upstreamServer as { closeAllConnections: () => void }).closeAllConnections();
        }
        upstreamServer.close((err) => (err ? reject(err) : resolve()));
      });
    });

    it("Caddy with upstreamProxy starts cleanly and is listening", () => {
      expect(caddy.port).toBeGreaterThan(0);
      expect(caddy.proxyUrl).toContain("127.0.0.1");
    });

    it("ACL still blocks private IPs even when upstreamProxy is configured", async () => {
      // 169.254.169.254 (AWS metadata) is in the default blocklist —
      // ACL must apply BEFORE the upstream forwarding step
      const before = upstreamHits.length;
      const r = await fetch("http://169.254.169.254/latest/meta-data/").catch(() => null);
      if (r) {
        expect(r.status).toBeGreaterThanOrEqual(400);
      }
      // The upstream server must NOT have been contacted — Caddy blocked it locally
      expect(upstreamHits.length).toBe(before);
    });
  },
);
