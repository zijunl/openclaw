/**
 * Zod schema and TypeScript types for the user-facing `ssrfProxy` configuration key.
 */

import { z } from "zod";

export const SsrFProxyConfigSchema = z
  .object({
    /**
     * Whether to enable the Caddy-based network-level SSRF proxy.
     * Default: true (enabled).
     *
     * Set to false to disable the proxy and rely solely on application-level
     * fetchWithSsrFGuard protections. Useful in environments where caddy
     * cannot be installed or the proxy is managed externally.
     */
    enabled: z.boolean().optional(),

    /**
     * Explicit path to the caddy binary.
     * Default: resolves 'caddy' from PATH, or the OPENCLAW_CADDY_BINARY env var.
     *
     * Example: "/usr/local/bin/caddy"
     */
    binaryPath: z.string().optional(),

    /**
     * Additional CIDR ranges to block at the network level, on top of the
     * built-in defaults (RFC-1918, loopback, link-local, CGNAT, etc.).
     *
     * Example: ["203.0.113.0/24"]
     */
    extraBlockedCidrs: z.array(z.string()).optional(),

    /**
     * Hostnames that should be allowed through even if they resolve to
     * addresses in a normally-blocked range (e.g. internal corporate services).
     *
     * These are inserted as explicit ALLOW rules before all DENY rules in the
     * Caddy ACL, so they take precedence.
     *
     * Example: ["internal-api.corp.example.com"]
     */
    extraAllowedHosts: z.array(z.string()).optional(),

    /**
     * Upstream proxy URL to chain through.
     *
     * If your organisation requires all outbound traffic to go through a
     * corporate proxy, set this to that proxy's URL. The Caddy sidecar will
     * forward requests to this upstream proxy instead of connecting directly.
     *
     * Example: "http://proxy.corp.example.com:8080"
     *
     * Note: This is separate from the standard HTTP_PROXY / HTTPS_PROXY
     * environment variables. If you already have those set, openclaw will use
     * them via the TRUSTED_ENV_PROXY mode without needing this option.
     */
    userProxy: z.string().url().optional(),
  })
  .strict()
  .optional();

export type SsrFProxyConfig = z.infer<typeof SsrFProxyConfigSchema>;
