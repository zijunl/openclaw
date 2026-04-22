/**
 * SSRF network proxy module — public API surface.
 *
 * This module provides network-level SSRF protection via a Caddy forward proxy
 * sidecar. It enforces IP blocklists at TOU (time-of-use), after DNS resolution
 * and TCP connection establishment, which eliminates the DNS-rebinding TOCTOU
 * window present in application-level DNS pinning.
 *
 * Integration:
 *   1. Call startSsrFProxy(config?.ssrfProxy) early in daemon/CLI startup.
 *   2. The proxy injects HTTP_PROXY / HTTPS_PROXY env vars and resets the
 *      undici global dispatcher so all subsequent HTTP traffic is routed through
 *      the Caddy sidecar.
 *   3. On shutdown, call stopSsrFProxy(handle).
 *
 * Graceful degradation:
 *   If Caddy is not installed or fails to start, startSsrFProxy() returns null
 *   and logs a warning. Application-level fetchWithSsrFGuard protections remain
 *   fully active as a defence-in-depth fallback.
 */

export { startSsrFProxy, stopSsrFProxy } from "./proxy-lifecycle.js";
export type { SsrFProxyHandle } from "./proxy-lifecycle.js";

export { startCaddyProxy, pickFreeLocalhostPort, resolveCaddyBinaryPath } from "./proxy-process.js";
export type { CaddyProcessOptions, CaddyProxyHandle } from "./proxy-process.js";

export {
  buildCaddySsrFProxyConfig,
  buildCaddySsrFProxyConfigJson,
  DEFAULT_BLOCKED_CIDRS,
  DEFAULT_BLOCKED_HOSTNAMES,
} from "./caddy-config.js";
export type { CaddySsrFProxyConfigOptions } from "./caddy-config.js";

export { SsrFProxyConfigSchema } from "./proxy-config-schema.js";
export type { SsrFProxyConfig } from "./proxy-config-schema.js";
