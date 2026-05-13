# Deploying your own Port world

Port is built to be **fork-and-deploy**. This document is the operator quick reference for:

- local test/single-node deployment (`npm run dev`, local SQLite, and in-memory testing), and
- production deployment on your own Cloudflare account.

For the normative Cloudflare deployment contract, see [spec/reference/cloudflare.md §R14](spec/reference/cloudflare.md#r14-deploying-your-own-world).

---

## Local deployment (tests and single-node systems)

For local dev, secrets live in `.dev.vars` (gitignored) instead of Cloudflare secret storage. Copy the example:

```sh
cp .dev.vars.example .dev.vars
# edit .dev.vars to set values
npm run dev
```

The local dev server reads `.dev.vars` automatically via `tsx`/`vite`. Defaults in the example are safe for local-only experimentation.

For local UI login as `$wiz`, you may provide an explicit dev-only apikey:

```sh
WOO_LOCALDEV_WIZ_API_ID=localwiz
WOO_LOCALDEV_WIZ_API_KEY=localwiz-secret
npm run dev
```

On startup, the dev server ensures that key exists, is bound to `$wiz`,
and prints the username/password pair for the login form. If the id
already exists for `$wiz` with the same secret it is reused; if it exists
for another actor or with another secret, startup fails loudly. This
convenience exists only in `src/server/dev-server.ts`; Cloudflare
deployments do not read these variables.

By default, local development uses the persistent `.woo/dev.sqlite` file:

```sh
WOO_DB=.woo/dev.sqlite
```

For a short-lived in-memory local DB (helpful for CI and throwaway test systems), run:

```sh
WOO_DB=:memory: npm run dev
```

For other local DB locations:

```sh
WOO_DB=.woo/test.sqlite npm run dev
```

For true in-memory world systems (no SQLite at all), use `InMemoryObjectRepository` directly in test runners or scripts:

```ts
import { createWorld } from "./src/core/bootstrap";
import { InMemoryObjectRepository } from "./src/core/repository";

const world = createWorld({ repository: new InMemoryObjectRepository() });
```

That mode resets when the process exits.

When you need production hosting, continue to the Cloudflare section below.

---

## Cloudflare deployment quick start

```sh
# 1. Clone and install
git clone https://github.com/<your-fork>/woo.git
cd woo
npm install

# 2. Authenticate with Cloudflare
npx wrangler login

# 3. Set the required secrets (see "Required configuration" below)
npx wrangler secret put WOO_INITIAL_WIZARD_TOKEN
npx wrangler secret put WOO_INTERNAL_SECRET

# 4. Deploy (runs preflight, build, deploy, postflight checks)
npm run deploy
#    or, low-level:  npx wrangler deploy
#    Hotfix overrides: --dirty, --allow-branch=<x>, --skip-tests, --skip-postflight

# 5. Claim wizard authority (see "Managing the wizard secret" below)
```

After step 5, you have a running core world with you bound to `$wiz`. The Cloudflare config starts clean by default; install catalogs explicitly or opt into bundled local catalogs before first deploy. Runtime authoring endpoints are still local-server-only on the Cloudflare target.

---

## Prerequisites

| Requirement | Why |
|---|---|
| **Cloudflare account on the Workers Paid plan** ($5/month minimum) | Durable Objects, the runtime's persistence primitive, are not available on the free tier. |
| **`wrangler` CLI** | `npm install` brings it in as a dev dependency; use `npx wrangler ...` from the repo root. |
| **A name for your worker** | Defaults to `woo`; change it in `wrangler.toml` if you want a different subdomain. |

If you skip Workers Paid, the deploy succeeds but every request returns `503 E_DO_UNAVAILABLE`. Fail-loud is intentional.

---

## Required configuration

Two secrets are required via `wrangler secret put` (never the `[vars]` block in `wrangler.toml`):

### `WOO_INITIAL_WIZARD_TOKEN`

A random string the operator presents at first auth to claim the `$wiz` binding. Single-use. See [Managing the wizard secret](#managing-the-wizard-secret) below for generation, claim, and rotation.

### `WOO_INTERNAL_SECRET`

A random string used to sign gateway, Directory, and cluster-host internal requests. Generate and set it the same way:

```sh
openssl rand -hex 32
npx wrangler secret put WOO_INTERNAL_SECRET
```

Unsigned or tampered internal requests are rejected before forwarded actor, session, or `progr` fields are trusted.

### Future deterministic ID seed

The v1 Worker does **not** read a seed phrase or salt object-id allocation. Seeded deterministic ULID allocation is deferred until the runtime has a real allocator for newly-created persistent objects. For now, deployed worlds rely on persisted object IDs plus catalog/core manifest IDs; `WOO_SEED_PHRASE` is not a deploy requirement.

### `WOO_AUTO_INSTALL_CATALOGS`

The local Node server leaves this unset by default, which means clone/run first-light installs every bundled catalog discovered under `catalogs/`.

The Cloudflare `wrangler.toml` ships with the full demo bundle so that a fresh fork-and-deploy lands a populated world matching woo.inguz.workers.dev:

```toml
[vars]
WOO_AUTO_INSTALL_CATALOGS = "chat,demoworld,dubspace,help,note,pinboard,prog,taskspace,blocks-demo"
```

Cost: the bundled demos add a few seconds to first-light bootstrap, and the resulting world snapshot — which every later cold-restart reads — is larger by the size of the demo instances. Edit the value before first deploy to override:

```toml
# Foundational classes only (no demo instances). First-light cost drops
# to tens of milliseconds and every cold-restart loads a smaller snapshot:
WOO_AUTO_INSTALL_CATALOGS = "chat,help,note,prog"

# Empty = bare core world (no in-world help, chat, notes, or programming):
WOO_AUTO_INSTALL_CATALOGS = ""
```

The variable is only consulted at first-light bootstrap. Flipping it on an already-deployed world does not remove already-installed catalogs.

This is just an operator filter over catalog directories bundled with the deployment. The runtime does not privilege those catalogs over public GitHub taps.

---

## Optional bindings

Each is **opt-in**: the runtime degrades gracefully when absent.

### Workers Analytics Engine (metrics)

For per-call metrics dashboards, create an AE dataset and bind it:

```toml
# wrangler.toml
[[analytics_engine_datasets]]
binding = "METRICS"
dataset = "woo_v1"
```

If `env.METRICS` is undefined at runtime, all metric writes no-op. Structured logs continue.

### R2 + Logpush (log retention)

`console.log` lines reach `wrangler tail` by default. For durable retention:

1. Create an R2 bucket: `npx wrangler r2 bucket create woo-logs`
2. Configure Logpush via the Cloudflare dashboard or `wrangler logpush create` to push to the R2 bucket.

Without Logpush, logs are visible only via `wrangler tail` while you're connected.

### Custom domain

Default deploy serves at `<worker-name>.<account-subdomain>.workers.dev`. To use a domain you own:

1. Add the zone to your Cloudflare account.
2. Add a route in `wrangler.toml`:

   ```toml
   route = { pattern = "world.example.com/*", custom_domain = true }
   ```

3. Redeploy.

---

## Managing the wizard secret

`WOO_INITIAL_WIZARD_TOKEN` is the deploy-time secret that lets you claim the seeded `$wiz` actor for the first time. It is single-use: the first successful presentation binds your session to `$wiz` and sets `$system.bootstrap_token_used = true`. Subsequent presentations return `401 E_TOKEN_CONSUMED`.

Spec contract: [auth.md §A11](spec/identity/auth.md#a11-initial-wizard-bootstrap).

### 1. Generate

```sh
openssl rand -hex 32
```

Save it in a password manager. The runtime never echoes it back.

### 2. Provision

| Mode | How |
|---|---|
| Cloudflare | `npx wrangler secret put WOO_INITIAL_WIZARD_TOKEN` (paste at prompt) |
| Local SQLite / in-memory | Set `WOO_INITIAL_WIZARD_TOKEN=...` in `.dev.vars` (gitignored) |

### 3. Claim `$wiz`

After deploy (or `npm run dev`), connect to your world and authenticate:

**Via REST**:

```sh
curl -X POST https://your-world.example.com/api/auth \
  -H 'content-type: application/json' \
  -d '{"token": "wizard:YOUR_INITIAL_WIZARD_TOKEN"}'
```

Response: `{ "actor": "$wiz", "session": "<session-id>" }`. Use `Authorization: Session <session-id>` for subsequent requests.

**Via WebSocket**: send `{ "op": "auth", "token": "wizard:YOUR_INITIAL_WIZARD_TOKEN" }`; receive `{ "op": "session", "actor": "$wiz" }`.

### 4. Mint a backup wizard immediately

Before doing anything else, create a second wizard-authority actor (a personal `$player` with `flags.wizard = true`, or a service-account `$bot`). If you lose your `$wiz` session and have no other wizard, you have no in-world path to rotate the secret — recovery becomes a fresh deploy from a backup archive.

### 5. Rotate (when needed)

Rotation is two steps in v1; the single-call `$system:rotate_bootstrap_token` verb is deferred (see auth.md §A12).

1. **Provision a new secret.** Cloudflare: `wrangler secret put WOO_INITIAL_WIZARD_TOKEN` then redeploy. Local: edit `.dev.vars` and restart.
2. **Reset the consumed flag.** From a session bound to a wizard actor, set `$system.bootstrap_token_used = false` via the runtime authoring console. The next presentation of the new secret consumes it normally.

### 6. If you lose all wizard access

There is no "forgot wizard" recovery path. Your options are: restore the world from a backup archive ([spec/operations/backups.md](spec/operations/backups.md)) into a fresh deployment with a new `WOO_INITIAL_WIZARD_TOKEN`, then claim `$wiz` from scratch. This is why step 4 matters.

---

## Installing catalogs

The deployed Worker starts with the clean-core/catalog policy chosen by `WOO_AUTO_INSTALL_CATALOGS`. Public GitHub tap install/update is available through the Worker; private repositories and GitHub API tokens are deferred.

**Update one catalog per maintenance window.** Each catalog's migration is scoped to its own classes — a failing `dubspace v1 → v2` does not affect `chat` or `taskspace`, and rollback is contained. Run install/update, verify with `GET /api/taps` and `migration_state`, smoke-test the affected verbs, *then* move on. Bundling multiple catalog updates into one window means one failure can compound and force a multi-catalog rollback. Spec rule: [catalogs.md §CT14.5](spec/discovery/catalogs.md#ct145-operator-practice-one-catalog-per-window). Catalog updates are independent of runtime/Worker deploys ([deployments.md §DP6](spec/operations/deployments.md#dp6-rolling-vs-bluegreen)).

```sh
curl -X POST https://your-world.example.com/api/tap/install \
  -H 'content-type: application/json' \
  -H 'Authorization: Session YOUR_SESSION_ID' \
  -d '{"tap":"hughpyle/woo-libs","catalog":"dubspace","ref":"dubspace-v1.0.0","as":"dubspace"}'
```

The response is the applied frame from `$catalog_registry`. `GET /api/taps` with the same session returns the installed catalog registry.

To update an installed tap:

```sh
curl -X POST https://your-world.example.com/api/tap/update \
  -H 'content-type: application/json' \
  -H 'Authorization: Session YOUR_SESSION_ID' \
  -d '{"tap":"hughpyle/woo-libs","catalog":"dubspace","ref":"dubspace-v1.1.0","as":"dubspace"}'
```

Major-version updates require `"accept_major": true` and a matching `migration-v<from>-to-v<to>.json` in the catalog directory. Reissuing an exact same-version install returns `E_CATALOG_ALREADY_INSTALLED` rather than appending a duplicate registry log row.

---

## Upgrades (pulling upstream changes)

When you pull updates from upstream and redeploy, the Durable Object class-history
migrations in `wrangler.toml` must remain consistent. These tags are Cloudflare
deployment bookkeeping, not catalog versions and not Port schema versions.

- Run `npm run cf:migrations:check` before deploy, or let `npm run deploy` do it.
- If a new Durable Object class binding was added, run `npm run cf:migrations` to append a deterministic `cf-do-NNNN` migration.
- Do not hand-edit existing `[[migrations]]` blocks. Class deletes are destructive and require an explicit `--allow-delete` run of `scripts/sync-wrangler-do-migrations.mjs`.

If your fork diverges from upstream's migration history, you cannot cleanly
merge. Keep upstream migration history intact and append your own generated CF
DO tags after it.

---

## Pre-deploy testing

Four progressively more thorough ways to validate a deploy before it lands on prod, in order of cost.

### 1. `wrangler deploy --dry-run` — free, ~10 seconds

Builds the Worker bundle, validates `wrangler.toml`, and checks DO migration tags against what's currently deployed. Catches config errors and migration-history drift; does not exercise runtime behavior.

```sh
npm run build && npx wrangler deploy --dry-run
```

Run this before any real deploy. It's the cheapest way to catch a misconfigured binding or a forgotten `npm run cf:migrations`.

### 2. `wrangler dev --remote` — per-request pricing only

Runs local code on Cloudflare's edge, hitting real DO storage in a sandbox namespace separate from production. Good for "does the worker boot, do API calls work, does first-auth land?" smoke testing without touching prod data.

```sh
npx wrangler dev --remote
```

Costs are billed at normal Workers/DO per-request rates, so a 5-minute session is fractions of a cent. The sandbox namespace is isolated; prod data is unaffected.

### 3. Staging worker — low cost, real upgrade path

A second Worker with its own name and its own DO storage namespace, deployed from the same code. Confirms that boot-time migrations, catalog installs, and the Worker entrypoint all behave on a real CF deploy without risking prod.

`wrangler.toml` ships with a commented-out `[env.staging]` block. Uncomment and edit (rename, optionally adjust `WOO_AUTO_INSTALL_CATALOGS`), then:

```sh
# One-time: provision secrets for the staging worker
npx wrangler secret put WOO_INITIAL_WIZARD_TOKEN --env staging
npx wrangler secret put WOO_INTERNAL_SECRET --env staging

# Deploy
npm run build && npx wrangler deploy --env staging
```

Cost: per-request + DO storage proportional to staging data. An idle staging is near-zero; a small test world is cents per month.

### 4. Backup-then-restore drill — highest confidence

Restore a recent prod backup into the staging worker, redeploy staging with the new code, and watch the upgrade-adopt path execute against real prod-shaped data. This is the only way to catch upgrade bugs that depend on production state shape.

```sh
# Export prod (see backups documentation in spec/operations/backups.md)
# Restore the archive into the staging worker
# Then deploy staging with the new code
npm run build && npx wrangler deploy --env staging
```

Cost: staging slot + transfer. Use this before deploys that touch catalog schemas, seed graphs, or migration-bearing changes.

**Recommended cadence**: option 1 every deploy, option 2 for any code change to the Worker entrypoint or DO classes, option 3 for catalog-schema or boot-flow changes, option 4 before a deploy you'd be reluctant to roll back.

---

## Failure modes & troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `503 E_BOOTSTRAP_TOKEN_MISSING` | `WOO_INITIAL_WIZARD_TOKEN` or `WOO_INTERNAL_SECRET` not set | `wrangler secret put WOO_INITIAL_WIZARD_TOKEN`; `wrangler secret put WOO_INTERNAL_SECRET` |
| `503 E_DO_UNAVAILABLE` | Account on Workers Free | Upgrade to Workers Paid |
| `401 E_TOKEN_CONSUMED` on first auth | The bootstrap token was already used | Reuse the `Authorization: Session <id>` from the original claim response. If lost, follow [Managing the wizard secret §5](#5-rotate-when-needed) (rotate) or §6 (no wizard left). |
| Worker deploys but requests time out | DO migration mismatch with prior deploy | Check `wrangler tail` for migration errors; reconcile with the upstream migration history |

---

## Cost expectations

Port runs on:

- **Workers Paid** ($5/mo) — covers Workers and Durable Objects
- DO storage costs scale with the number of objects and their size; small worlds (~hundreds of objects, KB each) are nearly free
- Per-DO 1k req/sec soft limit means a single hot object naturally rate-limits — adversarial saturation against one object cannot bring down your world
- Analytics Engine writes are cheap; one per call is well under cost concern at v1 traffic
- Logpush to R2 has small per-GB charges; budget by retention policy

Concrete production cost numbers depend on your traffic; the CF dashboard is authoritative.

---

## What's not in v1 fork support

- **Multiple worlds in one deploy.** One deploy = one world. Run multiple deploys for multiple worlds.
- **World handoff between accounts.** Possible via the JSON-folder dump format, but not yet a documented flow.
- **Auto-scaling tuning.** CF picks the closest region per DO; there are no knobs to expose yet.
- **Federated worlds.** v2.

---

## Going further

Once your world is running:

- Read [catalogs/dubspace/DESIGN.md](catalogs/dubspace/DESIGN.md), [catalogs/taskspace/DESIGN.md](catalogs/taskspace/DESIGN.md), and [catalogs/chat/DESIGN.md](catalogs/chat/DESIGN.md) to understand the seeded demos.
- Use the IDE tab in the bundled client to author verbs.
- See [spec/authoring/minimal-ide.md](spec/authoring/minimal-ide.md) for the authoring loop.
- File issues against your fork or upstream as you find them.

The runtime is world-visible by design — `wiz:world_metrics()` is always a fan-out call away if you want to know what's happening.
