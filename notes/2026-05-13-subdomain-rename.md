# Cloudflare account subdomain rename: `hughpyle` → `inguz`

Worker name (`woo`) intentionally retained. Renaming the worker would
create a new DO namespace and orphan the live world; subdomain change
alone keeps storage, secrets, and durable-object identity intact.

## Files updated

Active config (plugs and deploy will break unless updated, since they
hit the URL over the network):

- `catalogs/horoscope/plug/wrangler.toml` — `WOO_BASE_URL`
- `catalogs/weather/plug/wrangler.toml` — `WOO_BASE_URL`
- `scripts/deploy.sh` — postflight smoke `WORKER_URL` default
  (still overridable via `WOO_WORKER_URL` env var)

Cosmetic / docs:

- `index.html` — `og:url` meta tag
- `README.md` — two doc-page mentions
- `DEPLOY.md` — one mention in the catalog-default section
- `docs/getting-started.md` — two mentions
- `docs/agents/connecting.md` — one mention
- `wrangler.toml` — comment about the matching public deploy

Left alone:

- `notes/2026-04-29-impl-cf-deploy.md`,
  `notes/2026-05-12-cold-start-perf.md` — historical implementation
  records, accurate at time of writing per AGENTS.md.
- `spec/reference/cloudflare.md` — already uses the placeholder
  `<worker-name>.<account-subdomain>.workers.dev`, no specifics.

## Deploy sequence after rename

1. Change account subdomain in CF dashboard.
2. Redeploy main worker: `npm run deploy`. DO storage and secrets
   carry over automatically (same account, same worker name).
3. Redeploy each plug from `catalogs/<plug>/plug/`: `npx wrangler
   deploy`. Without this step, `WOO_BASE_URL` in the running plug
   still points at the old hostname and order-deliveries silently
   stop working when CF retires the old subdomain.

## Deferred: switch plugs to CF Service Bindings

The plug→worker call path is still public HTTP over `WOO_BASE_URL`,
which means any future subdomain or worker rename re-breaks the plugs
exactly the same way. The truly-stable design uses
`[[services]]` bindings in each plug's `wrangler.toml`:

```toml
# catalogs/horoscope/plug/wrangler.toml (future)
[[services]]
binding = "WOO"
service = "woo"
```

In the plug code, `env.WOO.fetch(request)` then routes through CF's
in-network worker-to-worker channel — no public hostname, no DNS,
no auth round-trip (signed-internal-request auth still applies, but
travels over the binding instead of public HTTPS).

Reasons to do this:

- Survives subdomain renames, worker renames, and custom-domain
  changes without any plug redeploy.
- Removes the plug→worker dependency from public attack surface
  (rate-limiting against the public URL doesn't apply to internal
  binding traffic).
- One less hop through CF's edge for every order delivery.

Reasons not to do it today:

- Touches `WooClient`'s `baseUrl` assumption (`src/server/woo-client.ts`
  or wherever) and the plug-side fetch path.
- Both plugs and tests would need adjusting (the test suite mocks
  `fetchImpl` against a URL today — the binding form takes a
  Service-like object instead).
- The CF Service Bindings API is straightforward but requires a
  short design pass on how the plug's existing API-key auth flow
  maps onto the binding's request shape.

Out of scope for this rename. Worth queuing as its own change.
