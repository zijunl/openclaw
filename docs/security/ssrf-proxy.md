# SSRF Network Proxy

openclaw ships with a **network-level SSRF (Server-Side Request Forgery) protection layer** powered by a [Caddy](https://caddyserver.com/) forward proxy sidecar. This is a defence-in-depth complement to the application-level `fetchWithSsrFGuard` DNS-pinning mechanism.

## Why a Network-Level Proxy?

Application-level DNS pinning (the existing `fetchWithSsrFGuard`) has a **TOCTOU (time-of-check / time-of-use) window**: it resolves DNS at check time and pins the IP, but a sufficiently fast DNS rebinding attack can swap the IP between the check and the actual TCP connection.

The Caddy sidecar eliminates this window by enforcing IP blocklists **at TOU** — after the TCP connection is established and the kernel has resolved the IP — making it impossible for a rebinding attack to bypass the block.

## How It Works

```
openclaw process
  ├─ Layer A: undici/fetch     ──┐
  │  (setGlobalDispatcher)        │
  │                                ▼
  ├─ Layer B: node:http/https  ──→ Caddy sidecar (loopback) ──→ Public Internet
  │  (global-agent bootstrap)      │
  │                          (Blocks RFC-1918, loopback,
  │                           link-local, CGNAT, etc. at TOU)
  └─ All other code...
```

### Dual-Stack Enforcement

openclaw uses **two complementary enforcement layers** to ensure all HTTP traffic
goes through the Caddy sidecar — because no single mechanism in Node.js covers
both `fetch()` and `node:http`/`node:https` simultaneously:

| Layer | Mechanism | Covers |
|-------|-----------|--------|
| **A** | undici `setGlobalDispatcher(new ProxyAgent(...))` | `fetch()` (Node 18+ built-in) and direct `undici.request()` calls |
| **B** | `global-agent` bootstrap (monkey-patches `http.request`/`https.request`) | axios, got, node-fetch, superagent, Stripe SDK, and **anything else** using the `node:http`/`node:https` modules |

Together these cover essentially all HTTP traffic in the Node.js process.
Bootstrapping order at startup:

1. Caddy subprocess launches on a random loopback port.
2. openclaw injects:
   - `http_proxy` / `https_proxy` (Layer A — picked up by undici's `EnvHttpProxyAgent`)
   - `GLOBAL_AGENT_HTTP_PROXY` / `GLOBAL_AGENT_HTTPS_PROXY` (Layer B — picked up by `global-agent`)
   - `no_proxy` / `GLOBAL_AGENT_NO_PROXY` (loopback exclusions)
3. `forceResetGlobalDispatcher()` activates Layer A.
4. `bootstrap()` from `global-agent` activates Layer B.
5. From this point, **every** outbound HTTP request from any code in the process
   flows through Caddy.
6. On shutdown, env vars are removed and Caddy is gracefully stopped.

### What's NOT Covered

The two known gaps (intentional, very low-risk):

- **Native C++ addons** that make raw HTTP calls via system libraries — openclaw
  does not use any such addons for outbound HTTP.
- **Child processes spawning external binaries** like `curl` or `wget` — openclaw
  does not do this for outbound HTTP either.

For environments requiring 100% kernel-level guarantees (e.g. running as a
shared service), see "OS-level enforcement" below.

## Prerequisites

The Caddy proxy requires the **[caddy-forwardproxy](https://github.com/caddyserver/forwardproxy)** plugin. Standard `caddy` distributions do not include this plugin by default.

### Installing Caddy with forwardproxy

**Option 1 — Build with xcaddy:**
```bash
xcaddy build --with github.com/caddyserver/forwardproxy
sudo mv caddy /usr/local/bin/caddy
```

**Option 2 — Download a pre-built binary:**
Visit [caddyserver.com/download](https://caddyserver.com/download) and add the `github.com/caddyserver/forwardproxy` plugin.

## Configuration

All options are under the `ssrfProxy` key in your openclaw config file:

```yaml
ssrfProxy:
  # Whether to enable the network-level proxy. Default: true.
  # Set to false to rely solely on application-level SSRF guards.
  enabled: true

  # Optional: path to the caddy binary.
  # Default: resolves 'caddy' from PATH, or the OPENCLAW_CADDY_BINARY env var.
  binaryPath: /usr/local/bin/caddy

  # Optional: additional CIDR ranges to block (added to built-in defaults).
  extraBlockedCidrs:
    - 203.0.113.0/24

  # Optional: hostnames to explicitly allow through (e.g. internal corporate services).
  # These bypass the CIDR blocklists — use sparingly.
  extraAllowedHosts:
    - internal-api.corp.example.com

  # Optional: upstream proxy URL for corporate proxy environments.
  # Caddy will forward requests through this proxy instead of connecting directly.
  userProxy: http://proxy.corp.example.com:8080
```

## Default Blocked Ranges

The following IP ranges are blocked by default:

| Range | Description |
|-------|-------------|
| `127.0.0.0/8` | IPv4 loopback |
| `169.254.0.0/16` | IPv4 link-local |
| `10.0.0.0/8` | RFC-1918 private |
| `172.16.0.0/12` | RFC-1918 private |
| `192.168.0.0/16` | RFC-1918 private |
| `100.64.0.0/10` | CGNAT / shared address space |
| `224.0.0.0/4` | IPv4 multicast |
| `240.0.0.0/4` | IPv4 reserved |
| `::1/128` | IPv6 loopback |
| `fe80::/10` | IPv6 link-local |
| `fc00::/7` | IPv6 ULA (private) |
| `ff00::/8` | IPv6 multicast |

The following hostnames are always blocked regardless of their resolved IP:

- `localhost`
- `localhost.localdomain`
- `metadata.google.internal`

## Graceful Degradation

If Caddy is not installed or fails to start, openclaw **does not crash**. Instead:

1. A warning is logged explaining how to install Caddy.
2. openclaw continues operating with the existing application-level `fetchWithSsrFGuard` protections.

To suppress the warning if you intentionally don't want the proxy:
```yaml
ssrfProxy:
  enabled: false
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENCLAW_CADDY_BINARY` | Override path to the caddy binary (alternative to `ssrfProxy.binaryPath`) |

## Security Notes

- The Caddy sidecar listens **only on the loopback interface** (`127.0.0.1`), not on any external network interface.
- Caddy's admin API is **disabled** — there is no management surface.
- The proxy does **not** log request contents — only warnings for blocked requests.
- Both the network-level (Caddy) and application-level (`fetchWithSsrFGuard`) protections are active simultaneously, providing defence-in-depth.
