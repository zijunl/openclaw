# SSRF Proxy — Testing Guide

This document explains how to run the SSRF proxy test suite and what each tier of tests verifies.

## Test Tiers

| Tier | Files | Coverage | Requires Caddy? |
|------|-------|----------|-----------------|
| **Unit** | `caddy-config.test.ts`, `proxy-config-schema.test.ts` | Pure functions: config generation, schema validation | No |
| **Integration** | `proxy-lifecycle.test.ts`, `proxy-enforcement.integration.test.ts` | Lifecycle, env injection, dispatcher state | No (mocks) |
| **E2E** | `blocking.e2e.test.ts`, `client-coverage.e2e.test.ts`, `sanity.e2e.test.ts` | **Real Caddy** actually blocks/allows requests | **YES** |

## What the E2E Tests Prove

The E2E suite is the strongest confidence test — it spawns a real Caddy binary
with the `forwardproxy` plugin and verifies that:

1. **Blocking actually works** (`blocking.e2e.test.ts`)
   - `fetch()` to `127.0.0.1`, `10.0.0.1`, `192.168.1.1`, `169.254.169.254`,
     `metadata.google.internal`, `localhost` → **all blocked**
   - `http.request()` to the same IPs → **all blocked**
   - **Critical assertion:** the victim server receives **zero** hits
     (proves the request was dropped at the proxy, not just an error response)

2. **All HTTP clients are intercepted** (`client-coverage.e2e.test.ts`)
   - `fetch()` (global), `undici.request()`, `http.request()`, `http.get()`
   - Bypass attempts (explicit `agent: undefined`, custom dispatcher) all caught

3. **The proxy is what's doing the blocking** (`sanity.e2e.test.ts`)
   - Control case: WITHOUT proxy, requests to `127.0.0.1` succeed
   - WITH proxy, they're blocked
   - Allowlist (`extraAllowedHosts`) lets legitimate traffic through
   - Custom blocklist (`extraBlockedCidrs`) extends the defaults

## Running the Tests

### Prerequisites

The E2E tests require a Caddy binary built with the `forwardproxy` plugin.

**One-time setup:**
```bash
# From the repo root
./scripts/build-test-caddy.sh
```

This:
1. Checks for Go 1.21+ (install via `brew install go` or your package manager)
2. Uses `xcaddy` to build Caddy with the `github.com/caddyserver/forwardproxy` plugin
3. Outputs to `.test-fixtures/caddy-with-forwardproxy`
4. Verifies the `forward_proxy` module is loaded

The build takes 1-2 minutes the first time. Subsequent runs skip if the binary
already exists. Use `--force` to rebuild.

### Running unit + integration tests

These run as part of the standard test suite:
```bash
pnpm test src/infra/net/ssrf-proxy/
```

### Running E2E tests

E2E tests are excluded from the default test run (file pattern `*.e2e.test.ts`).
Run them via the dedicated config:
```bash
node_modules/.bin/vitest run --config test/vitest/vitest.e2e.config.ts \
  src/infra/net/ssrf-proxy/blocking.e2e.test.ts \
  src/infra/net/ssrf-proxy/client-coverage.e2e.test.ts \
  src/infra/net/ssrf-proxy/sanity.e2e.test.ts
```

**Graceful degradation:** If the test caddy binary is missing, all E2E tests
auto-skip with a warning. They will not fail CI on machines without Go.

## Verified Protections

The E2E suite verifies the following protections work end-to-end:

### Default blocklist (always blocked)

| Target | Test | Status |
|--------|------|--------|
| `127.0.0.0/8` (IPv4 loopback) | `blocks fetch() to 127.0.0.1` | ✅ |
| `10.0.0.0/8` (RFC-1918) | `blocks fetch() to 10.0.0.1` | ✅ |
| `172.16.0.0/12` (RFC-1918) | covered by ACL | ✅ |
| `192.168.0.0/16` (RFC-1918) | `blocks fetch() to 192.168.1.1` | ✅ |
| `169.254.0.0/16` (link-local) | `blocks fetch() to 169.254.169.254` | ✅ |
| `100.64.0.0/10` (CGNAT) | covered by ACL | ✅ |
| `localhost` (hostname) | `blocks fetch() to localhost` | ✅ |
| `localhost.localdomain` (hostname) | `blocks fetch() to localhost.localdomain` | ✅ |
| `metadata.google.internal` (hostname) | `blocks fetch() to metadata.google.internal` | ✅ |
| IPv6 loopback (`::1`), link-local (`fe80::/10`), ULA (`fc00::/7`) | covered by ACL | ✅ |

### Client interception coverage

| Client | Layer | Test | Status |
|--------|-------|------|--------|
| Global `fetch()` (Node 18+) | A (undici) | `global fetch() to a blocked IP is rejected` | ✅ |
| `undici.request()` | A (undici) | `undici.request() to a blocked IP is rejected` | ✅ |
| `http.request()` | B (global-agent) | `http.request() to a blocked IP is rejected` | ✅ |
| `http.get()` | B (global-agent) | `http.get() to a blocked IP is rejected` | ✅ |

## CI Integration

To gate PRs on E2E tests, add to your CI workflow:

```yaml
- name: Build test Caddy
  run: ./scripts/build-test-caddy.sh
  
- name: Cache test Caddy binary
  uses: actions/cache@v4
  with:
    path: .test-fixtures/caddy-with-forwardproxy
    key: caddy-forwardproxy-${{ runner.os }}-v1

- name: Run SSRF E2E tests
  run: node_modules/.bin/vitest run --config test/vitest/vitest.e2e.config.ts src/infra/net/ssrf-proxy/
```

The cache step makes subsequent CI runs ~2 minutes faster.

## Troubleshooting

**`Test caddy binary not found`** — Run `./scripts/build-test-caddy.sh`.

**`Go is required to build test Caddy`** — Install Go 1.21+:
```bash
brew install go            # macOS
apt-get install golang-go  # Debian/Ubuntu
```

**E2E test hangs** — Caddy may have failed to start. Check logs by running
the binary manually:
```bash
.test-fixtures/caddy-with-forwardproxy run --config <(node -e "...")
```

**Custom Caddy binary** — Set `OPENCLAW_CADDY_BINARY=/path/to/caddy` to use a
different binary in production. Tests always use `.test-fixtures/...`.
