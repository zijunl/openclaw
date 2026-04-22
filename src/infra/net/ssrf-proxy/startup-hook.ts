/**
 * SSRF proxy startup integration for the openclaw daemon/CLI.
 *
 * Call `initSsrFProxyFromConfig(config)` immediately after the openclaw config
 * is loaded and validated (e.g. in the channel runner or daemon entrypoint),
 * before any network requests are made.
 *
 * The proxy handle should be stored and `stopSsrFProxy(handle)` called on clean
 * shutdown (SIGTERM / SIGINT handlers or process.once("exit")).
 *
 * Integration example (in the channel/daemon startup path):
 *
 *   import { initSsrFProxyFromConfig } from "./infra/net/ssrf-proxy/startup-hook.js";
 *
 *   const config = await loadConfig();
 *   const ssrfProxyHandle = await initSsrFProxyFromConfig(config);
 *
 *   process.once("exit", () => {
 *     void stopSsrFProxy(ssrfProxyHandle);
 *   });
 *
 * TODO: Wire this into the primary daemon/channel startup path.
 *   Candidate locations (pick one):
 *   - `src/plugins/cli.ts` → `loadValidatedConfigForPluginRegistration()` return site
 *   - `src/entry.ts` → after config is resolved
 *   - The channel runner entrypoint that calls `loadConfig()`
 */

import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { startSsrFProxy, stopSsrFProxy } from "./proxy-lifecycle.js";
import type { SsrFProxyHandle } from "./proxy-lifecycle.js";

export type { SsrFProxyHandle };
export { stopSsrFProxy };

/**
 * Initialize the SSRF network proxy from an already-loaded openclaw config.
 *
 * Returns a handle (to be passed to stopSsrFProxy on shutdown), or null if
 * the proxy is disabled or Caddy is unavailable.
 */
export async function initSsrFProxyFromConfig(
  config: OpenClawConfig | null | undefined,
): Promise<SsrFProxyHandle | null> {
  return startSsrFProxy(config?.ssrfProxy ?? undefined);
}
