# Dependency audit, 2026-07-28

`npm audit` went from **10 findings (1 low, 3 moderate, 6 high)** to **0**.
This note exists because two of the fixes are `overrides` against versions a
vendor pinned exactly, and the next person to touch `package.json` needs to
know why they are there and when they can go away.

## What was vulnerable, and whether woo reached it

Two independent chains, neither reachable from woo's production request path.

**Chain 1 — `@modelcontextprotocol/sdk` (a real dependency).** `fast-uri`
(high, host confusion), `hono` (moderate, jsx cross-request disclosure +
`cx()` XSS), `@hono/node-server` (moderate, Windows `serve-static` path
traversal), `body-parser` (low, DoS). All arrive through the SDK's
*server-side* HTTP transports and auth helpers — `hono`, `express`, `ajv`.
woo imports the SDK in exactly four places (`src/mcp/net-stdio*.ts` and
`scripts/smoke-mcp-stdio.ts`), and only for stdio framing, JSON-RPC message
types, and the smoke-lane `Client`. The server half of `/net-api/mcp` is
hand-written in `src/worker/net/gateway-do.ts`; `src/worker` contains no SDK
import at all. So none of these were live exploit paths. They are cleared now
because the stateless-MCP migration contemplates using more of the SDK, and
that decision should not have to start by clearing a backlog.

**Chain 2 — `wrangler` (dev only).** `sharp` (high, libvips CVEs) and
`undici` (high, several) via `miniflare`. These run only in the local workerd
lanes; nothing here is in the deployed bundle.

## What changed

| Package | Before | After | How |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | 1.29.0 | 1.30.0 | dependency range `^1.30.0` |
| `fast-uri` | 3.1.2 | 3.1.4 | override (stays on 3.x; 4.x is a major that `ajv` does not ask for) |
| `hono` | 4.12.25 | 4.12.32 | override |
| `@hono/node-server` | 1.19.14 | 2.0.12 | in-range; SDK 1.30.0 widened to `^1.19.9 \|\| ^2.0.5` |
| `body-parser` | 2.2.2 | 2.3.0 | in-range under `express@5.2.1`'s `^2.2.1` |
| `postcss` | 8.5.12 | 8.5.24 | in-range under `vite@7` |
| `sharp` | 0.34.5 | 0.35.3 | **override** |
| `undici` | 7.24.8 / 7.25.0 | 7.29.0 | **override** |

The SDK major (v2 beta) was deliberately **not** taken; that belongs to the
stateless-MCP migration.

## Why `sharp` and `undici` are overrides

`npm audit fix --force` wanted `wrangler@4.114.0`, outside our exact `4.97.0`
pin. That pin also fixes the `workerd` version the smoke lanes run against, so
taking it would swap the runtime under the most expensive validation ladder in
the repo to fix two dev-only advisories. Instead `miniflare`'s exact pins
(`sharp: 0.34.5`, `undici: 7.24.8`) are overridden forward within their own
majors, leaving `wrangler`/`workerd` untouched.

Verified afterwards on the real workerd lane: `npm run smoke:net-mcp` passed
17/17, so the overridden `miniflare` still boots, serves DOs, and does
cross-DO RPC.

**Remove both overrides** the next time `wrangler` is bumped past `4.101.0` —
at that point the vendor ships the fixed versions itself and the overrides are
just drift waiting to happen.
