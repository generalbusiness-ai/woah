# Cold-open cliff + execution-capsule eval — 2026-05-26

Status: investigation + eval done; **for discussion before any prod change**.
Worktree: `.claude/worktrees/capsule-eval` (branched at `eab666f`).

## TL;DR

- The "748881c degraded cross-actor" incident is **not** caused by the browser-holder
  code. The hot path (`/v2/open` → `openShadowBrowserScope`) is byte-for-byte
  unchanged by 748881c, and the browser path is dormant (`WOO_BROWSER_PROJECTION_HOLDER`
  is unset in prod). The degradation is a **pre-existing cold-open CPU cliff**:
  a full-miss scope open assembles a ~700-page / ~1MB executable seed and burns
  **~10s CPU** in the CF isolate. A CommitScopeDO is single-threaded, so two
  actors entering the same room serialize and blow past the 20s client timeout →
  CF "Durable Object is overloaded". The deploy's mandatory DO cold-start cleared
  warm caches and tipped this into a sustained storm.
- A **second, independent** defect (the `woah`→`woah1` 308 redirect) broke WS
  clients on the landing host. Already fixed by `eab666f` (API/`/__internal/`
  paths now bypass the redirect). MCP was never broken by it (follows the 308).
- `WOO_V2_EXECUTION_CAPSULE` is a **real fix for the warm/post-deploy path** and
  is **safe cross-host** per the eval below. It is complementary to a cold-path
  seed-install fix.

## Root cause, with evidence

### It is the open path, and it is CPU-bound

`wrangler tail --format json` during a repro (woah1, bypassing the redirect):

| path | median cpu | max cpu |
|---|---|---|
| `/v2/open` | 8.7s | 10.4s |
| `/__internal/enumerate-tools` | 6.0s | 7.8s |
| `/__internal/authority-slice` | 6.2s | 6.9s |
| `/__internal/apply-v2-commit` | 5.9s | 5.9s |
| `/v2/envelope` | 2.8s | 3.1s |

`exceptions: []` everywhere — nothing throws; it is pure CPU. Every open is
`cache=miss, transfer_mode=projection, ~700 pages, ~1MB seed, 59 preseeded objects`.

**Instrumentation gotcha that hid this for a while:** Cloudflare freezes
`Date.now()`/`performance.now()` during synchronous compute, so the
`v2_open_step` logs all read `ms: 0` and `v2_open` reports `ms: 161` while the
invocation actually burned ~10s. Only `cpuTime` in `wrangler tail` exposes it.
AE `sum_ms`/`p95_ms` are blind to this class of regression, and AE error counts
do not show it either — overloaded/timed-out requests never reach the metric
emit, so AE shows only the slow-but-`status=ok` completions.

### It is not 748881c

- `git show 748881c -- src/worker/commit-scope-do.ts` shows **no change** to the
  `/v2/open` handler; `openShadowBrowserScope` lives in `shadow-browser-node.ts`,
  untouched by 748881c. `enumerate-tools`/`authority-slice`/`apply-v2-commit`
  also untouched.
- 748881c's browser data path is gated on `WOO_BROWSER_PROJECTION_HOLDER`, which
  is neither a `wrangler.toml` var nor a secret in prod → dormant.
- `/v2/open` (8–10s) is *worse* than `apply-v2-commit` (5.9s), yet open applies no
  frames — so even the one unconditional 748881c change (`projectionWritesAreAuthorityRows`
  gate in `applyAcceptedShadowFrame`) cannot be the primary cause.

### Where the open cost actually is (local bench, real timers)

`createWorld` with the full prod catalog set, then `openShadowBrowserScope` with a
per-phase metric logger (Node, unfrozen timers):

```
FULL openShadowBrowserScope total ~680ms (fresh 118-object world)
  open_seed_install          282ms   install executable seed into the PER-OPEN execution node
  preseed_catalog_install    280ms   install the 59 catalog objects into the PER-OPEN execution node
  open_seed_full_build       117ms   assemble the seed transfer
  <everything else>          <12ms
```

`serializedFor` is cached (AE: 0 `serialized_world_materialized` per open), so
materialization is *not* the cost. Prod ~10s ≈ this scaled by the CF isolate
(~10–14×) plus the CommitScopeDO cold `relay_for` (SQL load), `full_save`
(SQL write), and `response_encode` (`JSON.stringify` ~1.5MB) — all O(world) on
one DO thread.

**Scaling landmine** (`/tmp/scale-bench.ts`): the open seed grows **~20 pages per
object in the scope's `contents`**:

| extra scope contents | objects | open | seed pages | seed KB |
|---|---|---|---|---|
| 0 | 118 | 680ms | 454 | 578 |
| 100 | 218 | 1010ms | 2,454 | 1,727 |
| 1000 | 1,130 | 4,638ms | 20,454 | 12,131 |

So a busy room / large board / big outliner makes opens catastrophic, regardless
of any deploy. `shadowBrowserOpenExecutableSeedPreimages` adds a `target:` +
cell expansion per content object, even though the code comment says
content-specific cells should arrive via missing-state repair.

## The execution-capsule eval

`WOO_V2_EXECUTION_CAPSULE` makes the gateway skip `/v2/open` and instead send the
turn with a narrow per-call `execution_capsule` (authority for just that
target/verb). The CommitScopeDO executes against its durable snapshot; if it has
none it returns `E_SNAPSHOT_REQUIRED` and the gateway falls back to a full open
(`persistent-object-do.ts:4018,4265`). Mechanism gate:
`commit-scope-do.ts:initializeRelay` (~520) — capsule works iff `loadSnapshot()`
finds a durable snapshot; `loadSnapshot` rebuilds the DO's *own* relay but never
assembles the client seed transfer (the ~10s term), which is why it is cheaper.

### Single-host results (`tests/worker/capsule-eval.test.ts`, catalogs `chat,help,note,prog`)

```
[capsule ON]  cold session A:   903ms  paths={/v2/envelope:2, /v2/open:1}   miss → fallback open
[capsule ON]  warm session B:   296ms  paths={/v2/envelope:1}               NO /v2/open
[capsule ON]  post-deploy C:    384ms  paths={/v2/envelope:1}               NO /v2/open (fresh gateway+DO over persisted SQL)
[capsule OFF] warm session B:   631ms  paths={/v2/open:1, /v2/envelope:1}   re-opens every session
```

- Warm scopes skip the open (0 vs 1). The skip **survives a deploy** — a fresh
  gateway + freshly cold CommitScopeDO loading its snapshot from persisted SQL
  still skips. So the capsule defuses the post-deploy storm for any scope that
  already has a snapshot.
- **Reduction, not a shift**: 296ms vs 631ms warm at this small scale; the gap
  grows with seed size because the capsule eliminates the seed-assembly term.
- **Cold/first-ever scope is marginally worse**: one wasted capsule round-trip
  before the fallback open builds the snapshot.

### Cross-host results (`tests/worker/capsule-crosshost-eval.test.ts`, catalogs `chat,demoworld,note,blocks-demo`)

Full self-hosting topology: multi-host `WOO` (per-object-host `PersistentObjectDO`)
+ real `COMMIT_SCOPE` + `HOST_SEED_KV` + waitUntil draining. **Discipline: the
capsule-OFF baseline must succeed cross-host first, or the ON numbers are
meaningless.**

```
[OFF] enter the_chatroom   isError=false  opens=1  authoritySlices=2   (topology is real)
[ON]  warm enter           isError=false  opens=0  snapshot_required=0
[ON]  the_chatroom:say          isError=false  opens=0  snapshot_required=0
[ON]  guest_2:set_description   isError=false  opens=0  snapshot_required=0
[ON]  guest_2:examine_detailed  isError=false  opens=0  snapshot_required=0
[ON]  the_chatroom:southeast    isError=false  opens=0  snapshot_required=0
```

The capsule's narrow per-call authority slice **carries enough state across
hosts** — every swept cross-host verb succeeds with 0 opens and 0
`E_SNAPSHOT_REQUIRED`. It still does the `authority-slice` refresh RPCs; it just
skips the seed-assembly open.

### What the eval does NOT cover

- Cross-**actor** fanout delivery (A says → B sees). Not capsule-gated — the
  capsule only touches the open path — but worth a canary check.
- Board verbs on their own self-hosted boards (`pinboard add_note`,
  `outliner add_item`) were not in the sweep.
- Absolute timings are Node, ~10–14× faster than the CF isolate. The structural
  signals (opens avoided, fallback rate, verb success) are what transfer.

## Proposed plan (for discussion)

The capsule and a cold-path fix are complementary and cover both regimes:

1. **Capsule (warm / post-deploy / cross-host):** `WOO_V2_EXECUTION_CAPSULE`.
   Eval-clean. Ship behind a canary that watches the real-traffic
   `E_SNAPSHOT_REQUIRED` fallback rate + a fanout smoke, then global enable.
2. **Seed-install fix (cold / first open):** share the catalog/seed install
   across opens at the relay/DO level instead of rebuilding the per-open
   execution node (~560ms/open of repeated, actor-independent work), and **cap
   the per-content seed expansion** (rely on missing-state repair, as the code
   comment already intends) to defuse the ~20-pages-per-content landmine.
3. **Redirect (done):** `eab666f` exempts API/`/__internal/` from the
   `woah`→`woah1` redirect so WS works on the landing host.

### Open questions

- Do we want the capsule on **by default** once canaried, or keep it flag-gated
  per environment?
- The cold-first regression (wasted capsule round-trip on a never-snapshotted
  scope): acceptable, or do we want the gateway to remember which scopes are
  durable to skip the optimistic-miss round-trip?
- Is the per-content seed expansion (fix 2) safe to cap purely via repair, or are
  there verbs that need content cells present at open time? (The comment claims
  repair suffices; worth confirming against the catalog verb set.)
- Should the two eval tests be promoted into the suite as the capsule's
  regression coverage?

## Artifacts

- `tests/worker/capsule-eval.test.ts` — skip / durability / reduce-vs-shift (single-host).
- `tests/worker/capsule-crosshost-eval.test.ts` — cross-host verb coverage.
- Local benches (gitignored `/tmp`): `open-bench.ts` (phase breakdown),
  `scale-bench.ts` (per-content seed growth).
- Both test files typecheck clean; the existing `v2-cost-budget` capsule test
  still passes.
