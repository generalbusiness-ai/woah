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
   `tests/worker/cf-local-walkthrough.test.ts`. The guard DERIVES the expected
   universal lineage from the bootstrap seed (parent-closure of the exported
   `MCP_GATEWAY_ACTOR_SUPPORT_ROOTS`), not a hardcoded id list, and a companion
   structural test asserts the roots/closure carry the actor/thing chain but
   exclude scope/catalog classes (`$space`, `$chatroom`, `$sequenced_log`) — so a
   scope-lineage dangle can never be "fixed" by broadening the universal set. Red
   before the fix (caught `$system` and `$guest`), green after. NOT yet
   re-measured on prod — do that only after step 2, to avoid a deploy-just-to-
   measure.

   **New finding promoted to step 2:** with step 1 fixed, the remaining cf-local
   dangle is `the_chatroom -> $chatroom` — a SCOPE INSTANCE whose parent is a
   CATALOG class. Scope/room class lineage is owner authority and must arrive via
   the room's authority slice, NOT the universal support set (the support set
   deliberately excludes scope lineage so a sparse `$space` stub never overwrites
   a real `$chatroom`). So scope-lineage completeness is an authority-slice
   problem → step 2.
2. **Replace per-turn authority-slice reconstruction with checkpoint/tail +
   cell-keyed reads (CA12).** Bulk of the ~10s/turn, and owner of the remaining
   `the_chatroom -> $chatroom` scope-lineage dangle. Split into verifiable
   sub-steps, each landed and harness-checked before the next:
   - **2a — instrument. [implemented in this branch]** Record every
     authority-slice reconstruction by
     `{reason, scope, object_count, page_count, source_host}`. Nothing else
     changes; this makes 2b–2e measurable and gives the warm-vs-cold split (3).
   - **2b — reusable scope authority checkpoint. [implemented in this branch,
     in-memory/checkpoint-hit only]** A warm turn may read an in-memory
     per-scope authority checkpoint rather than reconstructing a slice. MCP
     reads that need live Directory session overlays still hit the checkpoint
     and merge fresh Directory session rows into the returned payload; the
     volatile session overlay is not persisted into the checkpoint. Checkpoints
     are bounded by an LRU cap and carry a concrete head sequence watermark;
     degraded stale-fallback payloads are served once but are not stored.
   - **2c — catch-up by retained accepted-frame/transcript tail. [implemented in
     this branch for projection-write fanout]** When an accepted commit touches
     objects/sessions covered by a checkpoint at the same scope, the checkpoint
     is advanced in place from the bounded projection-write tail. Replayed or
     older sequence rows are idempotent/no-op. A commit at a different scope
     that touches covered rows invalidates the checkpoint because the watermark
     is scope-local. Checkpoint hits also overlay this shard's current live
     actor cells before serving, so a local session-location rebase is not
     hidden behind an older cached slice.
   - **2d — cell-keyed materialization repair only on real misses** (a cell the
     checkpoint+tail genuinely lack), reusing the VTN10.1 path. **Not yet
     implemented.** Current checkpoint coverage misses still fall through to the
     existing full refresh path.
   - **2e — gate then delete the old per-turn full-slice reconstruction path.**
     Gate behind a flag first so 2a instrumentation proves it's no longer hit on
     warm turns, then remove. **Not yet implemented.**
   - **Provenance is a 2-wide invariant (review pt 5):** every installed
     cell/page carries `source: authoritative | projection | fallback | cache`
     plus owner/head. **Fallback/cache cells MUST NOT be persisted as
     authority** — this is the direct guard against the earlier KV stale-byte
     corruption class (stale bytes written through as truth). Checkpoint/tail
     install paths assert this.
   - **Carry source/owner provenance ON the pages (review pt 4):** today the
     gateway filters authority-slice pages by resolving every returned object's
     host via Directory — a large slice of the resolve-object storm. With
     per-page owner/source provenance, owner-sourced pages are trusted without a
     per-object Directory lookup. This removes the storm's structural cause here,
     so step 3 is only the *remaining* route-resolution batching, not cleanup
     after a new path repeats the same mistake.
   - **Layering cleanup folded into this step:** fanout projection routing no
     longer hardcodes `subscribers` / `session_subscribers` in
     `src/core/v2-fanout-projection.ts`; it accepts a presence-projection
     predicate supplied from runtime catalog metadata. This keeps core fanout
     scope derivation in the same metadata-declared model as the transcript
     reconciliation work.
3. **Bound the remaining resolve-object route resolution** — batch per-turn route
   lookups; the bulk of the storm should already be gone via 2's page provenance.
4. **Formalize the multi-DO harness (CA16).** `cf-local-walkthrough` already runs
   separate PersistentObjectDO/CommitScopeDO/DirectoryDO instances and captures
   the dangling metric; extend its assertions to the budgets below rather than
   building a new harness.

## Success metrics — warm vs cold are tracked SEPARATELY (review pt 3)

"authority-slice reconstructions/turn == 0" and "no SerializedWorld
materialization" mean **steady-state warm turns**. Cold open and *genuine*
missing-state repair may still fetch bounded cells/checkpoint data — that is a
healthy path and MUST be tracked as a distinct bucket so it never reads as a
regression. The 2a instrumentation's `reason` field is what separates them.

## Fanout is an acceptance gate, not just latency (review pt 6)

Removing latency is insufficient: the smoke is INVALID if movement observations
are dropped. `cf-local-walkthrough` MUST assert, for movement turns:
- intended audience sessions computed;
- selected gateway shards;
- delivered local queues;
- dropped-reason count == 0;
- no `mcp-commit-fanout` timeout.

## Budgets — loose first, tighten as steps land (review pt 7)

- After step 1: zero universal-lineage dangles. **[met]**
- After step 2: zero total `dangling_parent_ref`; no full `SerializedWorld`
  materialization on a warm MCP turn; bounded Directory `resolve-object` calls
  per walkthrough/turn.
- Tracked separately, tightened over time: p95 local MCP step wall time; CPU
  budget per turn (warm vs cold buckets).

## The next proof (review, agreed)

Step 1 is NOT deployed alone. The important proof is that **step 2 removes the
`$chatroom` lineage dangle and the per-turn fan-in WITHOUT reintroducing
sparse-slice authority corruption** (hence the provenance invariant). Verify on
the harness + a single tail measurement once 2 lands — not per sub-step.

## Discipline

Each (sub-)step verified against the harness and local measurement before the
next. Prod stays at `b7915524` (no users) until step 2 demonstrably improves the
profile without authority corruption. Do not re-run the CF smoke for its own
sake — re-measure with `smoke-with-tail.sh` only when a step should move a
specific metric.

## Separate baseline test debt

Two non-gated/order-dependent failures were confirmed against pristine baseline
`4f5062e` and are tracked separately from this branch's acceptance:

- `tests/worker/gateway-projection-cache.test.ts` — "does not fetch world for
  unresolved ids or locally-live actors on sparse MCP shards" still reads
  `["the_chatroom", "world"]` rather than only `["the_chatroom"]`.
- `tests/worker/v2-cost-budget.test.ts` — "returns a compact executable seed
  marker when the open digest matches" can return a full `open_executable_seed`
  transfer instead of the compact cache-hit marker.

Do not use either as evidence for or against the Step 2 checkpoint/fanout
metadata patch until the baseline ordering failures are fixed in their own
change.
