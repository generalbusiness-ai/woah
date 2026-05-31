# 2026-05-31 — cell-authority perf remediation plan

Origin: prod `b7915524` (cell-authority, merge `a688b5f`) fixed the `#placement`
crash but smoke is 4/9 with 8–36s/turn latency. Tail-instrumented measurement
run captured the profile (`.woo/smoke-measurements/perf-b7915524/`). This note
records the confirmed cost drivers and the remediation steps.

Not cold-start (`init/world` mean 50ms), not full-world snapshot
(`serialized_world_materialized` ×7). The per-turn cost is a fan-in / repair
storm against incomplete executor slices.

## Confirmed cost drivers (from the tail)

1. **`dangling_parent_ref` ×338 — CONFIRMED ROOT CAUSE.** Every one is
   `start:$root missing:$system tombstoned:false` on `mcp-gateway-N`. The MCP
   gateway shards execute turns but lack `$system` (a universal bootstrap seed
   object) in their local `objects` slice. `parentWalkLookup` (world.ts:1051)
   therefore degrades the `$root → $system` ancestry walk to end-of-chain on
   ~every verb/property resolution. This both degrades resolution and is the
   incomplete-slice condition behind #2/#3.
2. **Authority-slice reconstruction per turn** — `/__internal/authority-slice`
   ~33s aggregate (world 36×, the_chatroom 21×, the_deck 9×…). Executor rebuilds
   slices from multiple hosts each turn. Target: checkpoint/tail transfer +
   cell-keyed reads (spec CA12).
3. **resolve-object storm** — `DirectoryDO /resolve-object` 4,449 calls
   (~500/turn). Bound/batch per-turn route resolution.
4. **mcp-commit-fanout RPC timeouts** — repeated `→ mcp-gateway-N` at the 5000ms
   ceiling with errors. This is the "timeout waiting for matching observation"
   the smoke reported; the fanout/delivery path is failing under load.
5. CPU ~10s/turn in `PersistentObjectDO /mcp` and `CommitScopeDO /v2/envelope`,
   consistent with the above stacking.

## Steps (in order)

1. **Fix the incomplete executor slice (the `$system`/universal-bootstrap gap). —
   DONE (persistent-object-do.ts).** Root cause: `MCP_GATEWAY_ACTOR_SUPPORT_IDS`
   was a hand-maintained allowlist (`$root,$thing,$actor,$player`) that omitted
   `$system` (prod dangle ×338) and the guest/human/agent actor classes (cf-local
   dangle `guest_1 -> $guest` ×1344). Replaced with a self-maintaining **closure**
   of `MCP_GATEWAY_ACTOR_SUPPORT_ROOTS = [$actor, $thing]`: each root's full class
   subtree + ancestors to `$system`. Regression guard added to
   `tests/worker/cf-local-walkthrough.test.ts` (universal-lineage dangles == 0;
   red before fix, green after). NOT yet re-measured on prod — do that only after
   step 2, to avoid a deploy-just-to-measure.

   **New finding promoted to step 2:** with step 1 fixed, the remaining cf-local
   dangle is `the_chatroom -> $chatroom` — a SCOPE INSTANCE whose parent is a
   CATALOG class. Scope/room class lineage is owner authority and must arrive via
   the room's authority slice, NOT the universal support set (the support set
   deliberately excludes scope lineage so a sparse `$space` stub never overwrites
   a real `$chatroom`). So scope-lineage completeness is an authority-slice
   problem → step 2.
2. **Kill authority-slice reconstruction on the turn path** → checkpoint/tail
   transfer + cell-keyed reads (CA12). Bulk of the ~10s/turn.
3. **Bound the resolve-object storm** — cache/batch route resolution per turn.
4. **Multi-DO authority harness (CA16)** with these metrics as assertions:
   dangling_parent_ref == 0, authority-slice reconstructions/turn == 0,
   resolve-object calls bounded, no SerializedWorld materialization on the
   commit path. This is what catches the class locally instead of via prod smoke.

## Discipline

Each step verified against the multi-DO harness and a local measurement before
the next. Prod stays at `b7915524` (no users) until a step demonstrably improves
the profile. Do not re-run the CF smoke for its own sake — re-measure with
`smoke-with-tail.sh` only when a step should move a specific metric.
