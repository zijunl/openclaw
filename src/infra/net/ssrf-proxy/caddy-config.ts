/**
 * Generates a Caddy JSON configuration for the openclaw SSRF-blocking forward proxy.
 *
 * The Caddy sidecar is the network-level enforcement point that blocks connections
 * to private/internal IP ranges at TOU (time-of-use), after TCP connection is
 * established. This eliminates the DNS-rebinding TOCTOU window that exists in
 * application-level DNS pinning.
 *
 * Requires the caddy-forwardproxy plugin:
 *   https://github.com/caddyserver/forwardproxy
 */

/** Default CIDRs that are always blocked (RFC-1918, loopback, link-local, CGNAT, etc.) */
export const DEFAULT_BLOCKED_CIDRS: readonly string[] = [
  // IPv4 loopback
  "127.0.0.0/8",
  // IPv4 link-local
  "169.254.0.0/16",
  // RFC-1918 private ranges
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  // CGNAT / shared address space (RFC 6598)
  "100.64.0.0/10",
  // IPv4 multicast
  "224.0.0.0/4",
  // IPv4 reserved / broadcast
  "240.0.0.0/4",
  // IPv6 loopback
  "::1/128",
  // IPv6 link-local
  "fe80::/10",
  // IPv6 ULA (unique local addresses – private)
  "fc00::/7",
  // IPv6 multicast
  "ff00::/8",
];

/** Well-known hostnames that must always be blocked regardless of IP resolution */
export const DEFAULT_BLOCKED_HOSTNAMES: readonly string[] = [
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
];

export type CaddySsrFProxyConfigOptions = {
  /** Port to listen on (loopback only). */
  port: number;
  /**
   * Extra CIDRs to block in addition to the defaults.
   * These are appended to DEFAULT_BLOCKED_CIDRS.
   */
  extraBlockedCidrs?: string[];
  /**
   * Hostnames that should be explicitly allowed through, even if they
   * resolve to addresses that would otherwise be blocked (e.g. corp internal).
   * These are inserted as ALLOW rules before the deny rules.
   */
  extraAllowedHosts?: string[];
  /**
   * If set, Caddy will forward requests to this upstream proxy URL rather
   * than connecting directly to the target. Useful when openclaw itself is
   * behind a corporate proxy.
   */
  upstreamProxy?: string;
};

/**
 * Builds the Caddy JSON config object for the SSRF-blocking forward proxy.
 *
 * ACL evaluation order (Caddy forwardproxy):
 *   1. ALLOW rules for user-specified allowed hosts  ← inserted first
 *   2. DENY rules for blocked CIDRs + hostnames      ← private ranges
 *   3. ALLOW all (pass-through to public internet)   ← final default
 *
 * This means: if a hostname is in extraAllowedHosts, it bypasses the deny
 * rules even if it happens to resolve to a private IP. Everything else that
 * resolves to a blocked CIDR is denied at TOU.
 */
export function buildCaddySsrFProxyConfig(options: CaddySsrFProxyConfigOptions): object {
  const { port, extraBlockedCidrs = [], extraAllowedHosts = [], upstreamProxy } = options;

  const blockedCidrs = [...DEFAULT_BLOCKED_CIDRS, ...extraBlockedCidrs];

  // Build ACL rules — caddy-forwardproxy uses {subjects: [...], allow: bool}
  // Rules are evaluated top-to-bottom; first match wins. Default if no match: deny.
  const acl: object[] = [];

  // 1. Explicit ALLOW rules for user-trusted hosts (highest precedence)
  if (extraAllowedHosts.length > 0) {
    acl.push({ subjects: [...extraAllowedHosts], allow: true });
  }

  // 2. DENY rules: blocked hostnames + private/loopback/link-local CIDRs
  acl.push({
    subjects: [...DEFAULT_BLOCKED_HOSTNAMES, ...blockedCidrs],
    allow: false,
  });

  // 3. Final ALLOW-ALL: everything else through to the public internet
  acl.push({ subjects: ["all"], allow: true });

  const handlerConfig: Record<string, unknown> = {
    handler: "forward_proxy",
    // Do not leak the client's real IP in X-Forwarded-For to the target
    hide_ip: true,
    // Do not send a Via header identifying this as a Caddy proxy
    hide_via: true,
    acl,
  };

  if (upstreamProxy) {
    handlerConfig.upstream = upstreamProxy;
  }

  return {
    apps: {
      http: {
        servers: {
          "ssrf-proxy": {
            listen: [`127.0.0.1:${port}`],
            logs: {
              // Route access logs into Caddy's structured logger
              default_logger_name: "openclaw-ssrf-proxy",
            },
            routes: [
              {
                handle: [handlerConfig],
              },
            ],
          },
        },
      },
      // Disable Caddy's admin API entirely — no management surface needed
      // and we don't want an additional listener.
    },
    admin: {
      disabled: true,
    },
    logging: {
      logs: {
        "openclaw-ssrf-proxy": {
          writer: {
            // Write to stderr so openclaw can capture and relay it
            output: "stderr",
          },
          encoder: {
            format: "json",
          },
          level: "WARN",
        },
      },
    },
  };
}

/**
 * Serializes the Caddy config to JSON for passing to `caddy run --config -`.
 */
export function buildCaddySsrFProxyConfigJson(options: CaddySsrFProxyConfigOptions): string {
  return JSON.stringify(buildCaddySsrFProxyConfig(options), null, 2);
}
