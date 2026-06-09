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

## Verification

- `npm run typecheck` clean (both tsconfigs).
- `npm run smoke:cf-local` 4/4 (shared scenario via fake transport).
- `npm run smoke:cf-dev` 11/11 against `wrangler dev` workerd.
- `tests/smoke-walkthrough-harness.test.ts` 4/4 (deployed-lane exports preserved).
