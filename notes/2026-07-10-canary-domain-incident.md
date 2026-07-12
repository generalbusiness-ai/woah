# Incident: a named-env canary deploy reassigned the prod custom domains (2026-07-10)

**Impact:** ~few minutes of `1101`/`500` on `woah1.generalbusiness.ai`
(production) during net-canary setup. Resolved by redeploying the
default env. No data loss; the net namespace was empty and untouched.

## What happened

To capture an isolated deployed net canary, an `[env.canary]` block
(`name = "woah-canary"`, `workers_dev = true`, **no `routes` in the env
block**) was appended to the production `wrangler.toml` and deployed with
`wrangler deploy --env canary`.

The deploy output listed `woah.generalbusiness.ai` and
`woah1.generalbusiness.ai` as triggers of the **canary** worker. The
freshly-created canary threw `1101` on boot, so the prod hostnames — now
pointing at the canary — served `1101`.

## Root cause

Cloudflare **custom-domain routes are account-global** and are NOT
scoped to a named wrangler environment the way route *patterns* are. A
`wrangler deploy --env <name>` from a config whose TOP-LEVEL `routes`
declare `custom_domain = true` **reassigns those domains to the named
env's worker**, even though the `[env.<name>]` block declares no routes
of its own. Omitting `routes` in the env block is NOT enough — the
top-level `custom_domain` routes are inherited/claimed.

## Remediation (what restored prod)

`wrangler deploy` (default env, no `--env`) re-applied the default env's
`routes` and reclaimed `woah`/`woah1` for the `woah` worker. Prod
returned `200` immediately. The broken `woah-canary` worker and its KV
were deleted.

## The rule (baked into the tooling)

A deployed acceptance canary MUST use a **dedicated standalone config
file** — `wrangler.net-canary.template.toml` — with:

- its own `name` (`woah-net-canary`),
- `workers_dev = true` for a `*.workers.dev` URL,
- **NO `routes` and NO `custom_domain` anywhere**,
- its own DO storage (separate worker name) + a freshly-created KV,
- `WOO_AE_DATASET = "woo_v1_net_canary"`.

Deploy it with `wrangler deploy -c wrangler.net-canary.template.toml`.
Tear it down with `wrangler delete -c wrangler.net-canary.template.toml`
+ delete its KV. It structurally cannot touch production hostnames.

**Never** deploy a second worker as an `[env.*]` of the production
`wrangler.toml`, and never point a canary at the prod worker's own
`workers.dev` URL. The commented `[env.staging]` block in `wrangler.toml`
carries the same hazard and the same caution.

Referenced by: DEPLOY.md (§Custom domain, §Staging), spec/reference/
cloudflare.md §R14.3.1, wrangler.net-canary.template.toml header.
