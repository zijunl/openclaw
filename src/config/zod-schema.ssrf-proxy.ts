/**
 * Re-export of the ssrfProxy Zod schema for use in the main config schema.
 * The canonical definition lives in infra/net/ssrf-proxy to keep it co-located
 * with the implementation, but the config schema imports it from here to keep
 * the config layer dependency graph clean.
 */
export { SsrFProxyConfigSchema } from "../infra/net/ssrf-proxy/proxy-config-schema.js";
export type { SsrFProxyConfig } from "../infra/net/ssrf-proxy/proxy-config-schema.js";
