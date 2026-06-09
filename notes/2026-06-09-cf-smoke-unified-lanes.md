# Unified smoke scenario + local workerd lane (2026-06-09)

## Why

A deploy (prod version c3359e16) passed `smoke:cf-local` (4/4) and then failed
4 steps of the deployed walkthrough: `pinboard:add_note` (E_NEED_STATE,
`contents needs owner-authoritative contents for the_pinboard`),
`outliner:enter` (E_VERBNF, `the_outline:enter` not reachable),
`outliner:add_item` (E_PERM, `set_position`), and `tasks: cross-room entered`
(E_OBJNF, `the_garden`). All four are cross-DO authority/lineage-propagation
failures.

Root cause of the *missed catch*: "cf-local" is not Cloudflare. It is a
hand-written in-process fake (`tests/worker/fake-do.ts`) where
`FakeDurableObjectNamespace.get(name).fetch()` invokes the target DO as a direct
synchronous function call. Every DO is a live in-memory object sharing one fully
imported world; there is no network, cold start, RPC timeout, per-DO storage
isolation, or serialization boundary. The class of "lineage/cell didn't
propagate to the shard in time" cannot manifest there.

Compounding it, the two walkthroughs were *parallel reimplementations* of the
same scenario — `scripts/smoke-walkthrough.ts` (deployed, HTTP) and
`cf-local-walkthrough.test.ts::runWalkthrough` (fake) — maintained twice and
free to drift.

## What changed (items 1 + 2 from the RCA)

**Item 2 — one scenario, three drivers.** The ordered steps and cross-actor
assertions now live once in `scripts/smoke/scenario.ts::runSmokeWalkthrough`,
operating on a transport-parameterized session (`scripts/smoke/session.ts::SmokeSession`).
The only per-lane difference is the **transport** (how a `/mcp` request reaches
the worker) plus two flags:
- `includeTakeDrop` — the same-room mug take/drop fanout step.
- `includeConcurrentMove` — the B6 concurrent-through-shared-destination step.

Lanes:
| Lane | File | Transport | Flags |
|---|---|---|---|
| fake DO (`smoke:cf-local`) | `tests/worker/cf-local-walkthrough.test.ts` | in-process `harness.request -> worker.fetch` | concurrentMove on, takeDrop **off** (dangling_parent_ref==0 ratchet) |
| **workerd (`smoke:cf-dev`)** | `scripts/smoke-cf-dev.ts` | `wrangler dev` over HTTP | both on |
| deployed (`smoke:walkthrough`) | `scripts/smoke-walkthrough.ts` | deployed URL over HTTP | takeDrop on |

Each lane keeps its own *step-runner policy*: the deployed lane records results,
resets sessions, and halts on a timeout cascade; the fake lane throws to fail the
vitest case; the workerd lane records-and-continues so the operator sees the full
failure surface. The fake lane's metric/coherence-invariant (VTN0) assertions are
unchanged — only its session/walkthrough plumbing now comes from the shared
modules.

**Item 1 — local workerd lane (`smoke:cf-dev`).** Boots the real worker entry in
real workerd via `wrangler dev` (`wrangler.smoke.toml`), with real per-DO sqlite
storage, real cross-DO RPC, real host-seed merge and contents repair, then runs
the shared scenario over MCP HTTP. Config notes: distinct worker `name`
("woah-smoke") so local DO storage never collides with a deploy; no `[assets]`
(skips the `dist/` build — the smoke only hits `/healthz` and `/mcp`); no AE; the
two local-only secrets inlined as `[vars]`. Chosen over
`@cloudflare/vitest-pool-workers` because it needs no new dependency / separate
vitest project and reuses the exact HTTP transport the deployed lane uses.

Wired into `scripts/deploy.sh` preflight (after `npm test`, before build),
gated by `WOO_DEPLOY_CF_DEV` (default on) and skipped under `--skip-tests`.

Two hardening fixes after first review:
- **Isolated cold boot.** `wrangler dev` defaults to a persistent `.wrangler/state`,
  so the gate could pass against a world bootstrapped by an earlier run and skip
  cold first-light / catalog install / KV seed / migrations. The lane now creates
  a per-run temp dir and passes `--persist-to <dir>`, removing it on teardown
  (kept under `--keep`). Verified: every host logs `cf_repository_load
  stored:false objects:0` — a true cold boot each run.
- **No DO drift.** `wrangler.smoke.toml` duplicates the production DO bindings +
  migrations, but `cf:migrations:check` only inspects `wrangler.toml`. New guard
  `scripts/guard-smoke-wrangler.mjs` (in `test:guards` + `pretypecheck`) fails if
  the smoke config's DO binding set or migration sequence drifts from production,
  and re-checks the smoke config's own migration consistency.

## Honest fidelity caveat (important)

The workerd lane currently **passes all 11 steps**, including the four that fail
on deploy. `wrangler dev --local` still runs every DO in one workerd process with
fast, reliable, in-process RPC, and its host-seed merge / `derived_contents_repaired`
machinery fills lineage locally. So it raises fidelity a lot — it WILL catch
real per-DO storage, RPC-shape, serialization, and host-seed-merge regressions
the fake cannot — but it does **not** reproduce the prod failures, which are
driven by cross-colo RPC latency / cold-owner 5s-timeout authority gaps (and/or
are masked by the local merge).

Closing that last gap is the deferred **item 3**: fault injection (per-DO
cold-start delay, authority-slice fetch delay/timeout crossing
`WOO_HOST_READ_TIMEOUT_MS`, late/dropped slice) layered onto either the fake or
the workerd lane, run as a "must still converge" variant. The harness already
has the delay plumbing (`directorySessionsForScopesDelayMs`,
`mcpCommitFanoutDelayMs`, `hostReadTimeoutMs`); item 3 extends it to the
authority-slice path and asserts the prod error codes are never produced.

## Warm-pass perf instrument (`smoke:cf-dev --measure`)

`--measure` runs the scenario N passes (default 2) against ONE persisted world —
pass 1 cold-boots, pass 2+ run warm — captures the worker's `turn_phase_timing`
and `v2_envelope` metrics off wrangler stdout, buckets them per pass by time
window, and prints a cold-vs-warm phase/bytes table. This is the before/after
instrument for turn-path perf work. Default gate mode is unchanged (one pass).

First baseline (34 turns/pass, workerd-local single-process):

| metric | cold | warm |
|---|---|---|
| total_ms | 21135 | 20441 |
| ensure_client_ms | 10770 | 10216 |
| planning.seed_authority | 4220 | 4185 |
| planning.initial.open_rpc | 2703 | 2494 |
| planning.owner_prefetch_authority | 1469 | 1345 |
| submit_ms | 3818 | 3747 |
| envelope request_bytes (max) | 1,940,260 | 1,942,635 |
| repair turns (attempts!=1) | 0 | 0 |

**Headline: warm/cold total_ms ratio = 0.97.** Warm pays ~full cold cost. The
dominant `ensure_client` authority assembly (`seed_authority` + `open_rpc` +
`owner_prefetch`) and the ~2 MB envelope slice are paid **per turn**, not
amortized — the warm cheap-path effectively doesn't exist, and
`WOO_V2_SLIM_WARM_ENVELOPE=1` produces no warm byte reduction here. That is the
target for the authority-assembly perf work. (Phase ms is a relative/floor
signal on single-process workerd; `request_bytes`/`authority_calls` are the
transport-independent levers that map to prod latency.)

## Verification

- `npm run typecheck` clean (both tsconfigs).
- `npm run smoke:cf-local` 4/4 (shared scenario via fake transport).
- `npm run smoke:cf-dev` 11/11 against `wrangler dev` workerd.
- `tests/smoke-walkthrough-harness.test.ts` 4/4 (deployed-lane exports preserved).
