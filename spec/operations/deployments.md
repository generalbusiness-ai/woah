---
date: 2026-04-30
status: partial
---

# Deployments

> Part of the [woo specification](../../SPEC.md). Layer: **operations**.

How a woo world moves through dev / staging / prod environments and how spec, code, and schema versions propagate in the Cloudflare production profile. The contract for "we have multiple environments and changes flow between them."

For concrete operator commands, bootstrap exchange details, and local test-system setup, see [DEPLOY.md](../../DEPLOY.md).

---

## DP1. Environments

A **deployment** in this section is a runtime instance of woo in the Cloudflare profile: one Worker namespace plus its attached DOs, one Directory, one bootstrap world graph, one set of bound credentials.

Conventional environments:

- **dev** — short-lived; per-developer or per-feature; world reset freely.
- **staging** — long-lived but disposable; mirrors prod's recent state.
- **prod** — long-lived, live; loss-of-state is a disaster.

A world *exists* in a deployment. Moving a world between deployments uses backups ([backups.md](backups.md)).

This section does **not** apply to in-memory or local SQLite modes. Those runtimes are single-target deployments that rely on local process or local database resets/reloads and do not require multi-environment promotion.

### DP1.1 Local test and single-target systems

- **In-memory mode** (tests). Run with `InMemoryObjectRepository` from [`src/core/repository.ts`](../../src/core/repository.ts); no disk persistence and reset on process exit.
- **Local SQLite mode** (single-node local system). Use `npm run dev` (default `WOO_DB=.woo/dev.sqlite`) or set `WOO_DB` for custom path/in-memory behavior.

---

## DP2. Seed distribution

A deployment boots from a seed graph plus configured local catalogs. The universal seed is identical across environments (`$root`, `$space`, `$thing`, etc.); demo surfaces such as `$dubspace` and `$taskspace` come from bundled local catalogs, so a worktree's patch series, an export, and a migration catalog all behave the same way regardless of which environment they target.

Seed graph is delivered with the runtime code; bumping the spec version updates the seed.

---

## DP3. Code deployment vs world content

Verb code (bytecode) lives in the world's persistent state, not in the runtime binary. In the Cloudflare profile, deploying new *runtime* code (a fresh Worker bundle) does not change the verbs already in the world — those are durable.

What changes with a runtime deploy:
- Builtins, opcodes, scheduler, host primitives — anything implemented in TypeScript, not in woo verbs.
- Spec version (`$system.spec_version`) if the runtime carries a newer one.

What does *not* change with a runtime deploy:
- Verbs, properties, schemas, instances. Those move via worktrees and migrations.

This separation matters: a runtime upgrade with no spec changes is a hot-patch; Cloudflare deployments can do it during business hours. A runtime upgrade *with* spec changes is more careful — see DP5.

---

## DP4. Promote-flow across environments

A typical Cloudflare production flow:

```
1. Developer creates worktree on dev.
2. Develops, tests in sandbox.
3. Promotes to dev: live dev now has the change.
4. CI exports dev's affected cluster, restores into staging.
5. Staging is exercised against the new code (acceptance tests, pilot users).
6. If clean, the worktree's patch series is replayed against prod:
   re-prepare patches with prod's expected_versions; rebase if needed.
7. Prod has the change.
```

Patch series are portable. The same patches that promoted to dev can be rebased and applied to prod. This is what makes worktrees + deployments composable.

For schema and data migrations, the same flow applies — the migration runs in each environment in turn, with each run's idempotency making partial-failure safe.

---

## DP5. Spec version coordination

Each Cloudflare deployment records its `$system.spec_version`. Runtime deploys may bump it; the runtime applies migrations from its catalog to bring older worlds forward (per [migrations.md §M6](migrations.md#m6-world-level-spec-versioning)).

Coordination across environments:

- **dev** is allowed to be ahead of prod (developers test new spec features).
- **staging** is typically aligned with prod or at most one minor version ahead.
- **prod** lags by policy (e.g., one minor version behind staging).

A Cloudflare deployment refuses to boot a world whose spec version is *ahead* of the runtime. Operators must upgrade runtime before they can boot a world that requires a newer spec.

---

## DP6. Rolling vs blue/green

Two deployment-replacement patterns:

- **Rolling.** Gradual replacement of runtime instances. Each new instance picks up the new code; old instances continue until they drain. Works for runtime-only upgrades (no spec change).
- **Blue/green.** Parallel deployments; traffic switches atomically. Required for spec upgrades that involve incompatible bytecode or schema; the new deployment runs migrations on a copy, traffic switches when ready.

For spec v1, blue/green is the default for spec-version bumps; rolling is the default for code-only upgrades. The distinction is forced by the per-task bytecode-version invariant ([hosts.md §3.4 (4)](../protocol/hosts.md#34-host-rpc-invariants)) — old in-flight tasks finish on old code; new calls use new code; no one runs against ambiguous code.

---

## DP7. Cross-deployment data sync

For staging that mirrors prod:

```
sync_deployment(source: deployment_id, target: deployment_id, options)
```

- `mode: "snapshot"` — staging is replaced with a recent prod export. Existing staging state is wiped.
- `mode: "incremental"` — staging receives prod's accumulated messages since the last sync. Maintains staging-specific changes.
- `frequency: "manual" | "daily" | "hourly"` — how often.

Sync requires elevated permissions (wizard or platform-admin) on both source and target.

`mode: incremental` is harder than it looks: staging's seq numbers and prod's seq numbers diverge; merging requires re-numbering. Snapshot mode is the recommended default.

---

## DP8. Routing

Different deployments have different URLs:

- `wss://woo-prod.example/connect`
- `wss://woo-staging.example/connect`
- `wss://woo-dev-<feature>.example/connect`

Clients pick which to connect to. A "preview environment" is a per-feature deployment created on PR open and torn down on merge — the per-feature URL embeds the PR id.

In Cloudflare profiles, the auth service is typically shared (one IdP for all environments) but bearer tokens encode the audience (`aud` claim) so a token issued for prod is rejected by staging. Per-environment audience claims compose with the OAuth/OIDC integration in [auth.md](../identity/auth.md).

---

## DP9. What's deferred

- **Multi-region deployments** (one prod world replicated across regions for latency). Cloudflare DOs are per-region by default; multi-region replication requires extra coordination not specced here.
- **Canary deployments** (release new code to 1% of traffic first). Possible via custom routing; deferred.
- **Automated rollback** (revert a deploy if error rate spikes). Requires observability metrics; lives there, not here.
- **Per-actor environment tagging** (an actor sees prod for some calls, staging for others). Useful for testing in production but operationally complex; out of v1.
