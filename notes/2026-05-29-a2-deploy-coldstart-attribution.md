# 2026-05-29 — post-A2 deploy: cold-start wall attribution

Deployed `main` @ `90efa52` (A2 shared-immutable-bytecode) as CF version
`bd9987f4`. Measured with `RUNS=2 scripts/smoke-with-tail.sh` against
`woah1` immediately after deploy (worst case: KV cache fingerprint changed →
all cold). Artifacts: `.woo/smoke-measurements/a2-measure-015052/`.

## Headline

- **No A2 regression.** Tail shows `"exceptions": []` throughout — the
  freeze/share change throws nowhere on the live v2/MCP paths.
- **Cause B held.** `the_outline:enter`/`add_item` now PASS (28.8s / 16s)
  instead of failing `E_VERBNF`; the tool-surface reverse index for `the_outline`
  is tiny (7 source rows, 1 object, 0 cap hits). They're slow only from cold-load.
- Smoke 7/9 both runs. Failures are **timeouts**, not errors:
  cross-room `entered` (10s wait) and the tasks-board cross-room step
  (MCP POST 20s timeout).
- The deploy's postflight `v2 ws handshake 500` was a single stone-cold
  first-hit; warm traffic a minute later works (no exceptions in tail).

## Where the wall is (answering the four candidates)

| candidate | verdict | evidence |
|---|---|---|
| `/v2/open` executable seed | **NOT involved** | `v2_open` metrics = 0 opens / 0 bytes / 0 pages. The MCP smoke path never hits the browser-holder open-seed. |
| `mcp_gateway_snapshot_fetch` | **expensive phase (14s) but cheap to *build*** | phase `mcp_gateway_snapshot_fetch/do` p95 **13996ms**, yet the WORLD-side build RPC `/__internal/mcp-gateway-world` is only **1357ms** p95, and KV restore-miss is **382ms**. The 14s is wait/serialization + import, not snapshot construction. |
| host seed merge | **yes — major** | phase `host_seed_fetch/do` p95 **17849ms** (max 20092), while the WORLD-side `/__internal/host-seed` build is **873ms**. The gap is the satellite's restore + (double) merge + import. |
| cross-host owner RPCs | **the proximate cause of the failures, but downstream** | `/__internal/enumerate-tools` and `/__internal/authority-slice` **time out at the 5s budget** (3 timeouts). The owner DO is mid-cold-load — `enumerate-tools` handler **cpu_p95 13925ms** — so it can't answer in 5s. |

### Root: synchronous cold-DO world materialization, serialized

- `init/world` p95 **16964ms** (max 20474) — world construction on cold DOs is the tentpole.
- The **catalog compile is NOT the cost**: `kv_catalog_reservoir_build` = **0ms** (memoized, 118 obj / 302 verbs). So compile is free.
- The cost is **importing + merging the full prod world** (storage_full_save = 391 objects / 1826 properties / 894 verbs; commit-apply indexes 504 objects) on each cold DO, under `blockConcurrencyWhile`, with WORLD as a shared serialization point that every gateway/satellite RPCs into while it is itself cold.
- Signature is **contention/CPU**, not bytes: WORLD-side builders are cheap (0.9–1.4s), KV bytes are cheap (0.38s), but the requesting-side cold phases are 14–18s and `enumerate-tools` burns ~14s **CPU** (the owner DO's import/merge charged to the first handler).

## What A2 did and didn't do

A2 (share immutable bytecode, no clone on restore/import) is correct and safe
and removes real per-verb clone CPU — but it did **not** move the cold-start
wall, because the wall is whole-world import + host-seed merge + cold-init
serialization, of which the bytecode clone was a minor slice. Bytes, clones,
and compile are all cheap now; **world materialization volume + serialization**
is the wall.

## Next levers (in impact order)

1. **A3 — don't materialize the whole world on cold activation.** Gateway shard
   needs sessions/routes/seed-lineage, not all 500 objects; satellite needs its
   scope slice. Replace whole-world import/merge with checkpoint/tail or a
   bounded slice. This attacks `init/world` directly.
2. **Fix the satellite double-merge/double-import** in `createHostScopedWorld`
   (pre-merge + post-lifecycle re-merge + second importWorld) — redundant O(world)
   work on every satellite cold-load.
3. **Warm WORLD + shards** (and keep them warm) so the `blockConcurrencyWhile`
   serialization and WORLD-availability wait don't land on user/smoke traffic.
4. **Owner-RPC budget/fallback:** `enumerate-tools`/`authority-slice` should
   return last-known same-host rows on owner-cold timeout instead of failing —
   converts the cross-room timeouts into stale-but-present rows.

Caveat: measured immediately post-deploy (all caches cold) = worst case; warm
re-runs will be faster, but the cross-room timeouts persisted into run 2, so the
wall is not purely first-touch.
