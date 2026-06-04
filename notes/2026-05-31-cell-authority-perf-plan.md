# 2026-05-31 — cell-authority perf remediation plan

Origin: prod `b7915524` (cell-authority, merge `a688b5f`) fixed the `#placement`
crash but smoke is 4/9 with 8–36s/turn latency. Tail-instrumented measurement
run captured the profile (`.woo/smoke-measurements/perf-b7915524/`). This note
records the confirmed cost drivers and the remediation steps.

Not cold-start (`init/world` mean 50ms), not full-world snapshot
(`serialized_world_materialized` ×7). The per-turn cost is a fan-in / repair
storm against incomplete executor slices.

## 2026-06-04 deployed B7 measurement — honest claim

B7's deployed claim is now narrower and proven: it removed the measured
authority/executable-open phase from the MCP turn path, but it did **not** move
the cold-start turn wall enough to make full deployed smoke pass.

Evidence: commit `15942b1` deployed as Cloudflare version
`41acd2ce-fb0b-4f75-a03b-edec4da1f854`; tail run
`deploy-15942b1-b7-head-session-open-20260604T175534Z`. The `head_session.v1`
open path worked: `/v2/open` request JSON was 19.5 KiB, executable seed bytes
were 0, pages were 0, and misses were 0/5. For `the_chatroom:enter`, attempts
fell to 1 and the authority phase was no longer the wall:
`turn_phase_timing` measured total mean 15.136s / p95 19.335s, with
`ensure_client_ms` 9.198s avg (61%), `submit_ms` 5.773s avg (38%), and
`authority_ms` 165ms avg (1%).

The remaining wall is prod-shaped Directory/fanout cold-start pressure, not the
authority warm-fill problem B7 set out to remove. The same run showed repeated
Directory `sessions-for-scopes` calls returning 26-29 MCP sessions for a
two-actor smoke, including 5s timeouts, and each enter selected 16-17
`audience_session_shards` while `scoped_shards=0` and `subscriber_shards=0`.
So B7 is accepted as "authority phase removed / executable open removed"; it is
not accepted as "cold-start wall solved." Next work should make cf-local
reproduce this Directory/fanout shape before more deployed smoke-driven patches.

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
   cell-keyed reads (CA12). — DEPLOYED/PROVEN FOR THE AUTHORITY PHASE, NOT FOR
   THE COLD-START TURN WALL.** This removed the authority/executable-open wall
   on the deployed MCP path, but the same measurement exposed a deeper
   Directory/fanout cold-start wall. The original framing below remains useful
   for why B7 existed, but its acceptance claim is now limited to the measured
   authority phase. Split into verifiable sub-steps, each landed and
   harness-checked before the next:
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
   - **2d — cell-keyed materialization repair only on real misses. [implemented
     in this branch for checkpoint coverage misses]** When a warm request names
     ids beyond a checkpoint's coverage, the gateway repairs only those missing
     ids and merges them into the checkpoint. The path emits
     `warm_checkpoint_repaired` only when the repaired checkpoint is stored, so
     the next identical warm turn becomes a checkpoint hit. It does not
     reconstruct the already-covered slice. If the repair degrades to
     timeout/stale fallback, or the repaired union exceeds the per-checkpoint
     object budget, the served payload may still use those rows for that
     attempt, but it is not stored as the next checkpoint.
   - **Pre-plan authority gate. [implemented in this branch for MCP planned-exec]**
     Sparse gateway shards must refresh/repair authority before local VM
     planning, not only before commit submission. Otherwise a stale relay
     snapshot can raise `E_VERBNF`/`E_OBJNF` locally before the checkpoint repair
     path can act. The pre-plan refresh is MCP-only and does not consume the
     first envelope snapshot-fallback slot. First warm refreshes that
     successfully seed a bounded checkpoint emit `warm_checkpoint_seeded`, so a
     sticky seed is not confused with repeated `warm_turn_refresh` fan-in.
     On MCP gateway shards, local authority export is also restricted to rows
     whose lineage is complete plus this shard's session actor live cells;
     sparse room stubs are routing/cache hints, not authority rows. MCP live
     fanout audience is read from Directory rather than recomputed from the
     sparse local room graph, so movement observations do not reintroduce the
     same incomplete-lineage walk after commit. Follow-up P0: MCP local
     planning now treats a local missing-object frame as a VTN10.1
     materialization miss when pre-plan authority is enabled. A transitive
     object miss (for example `exit_deck_south.dest -> the_garden`) therefore
     repairs the missing id and retries the whole turn instead of surfacing
     local `E_OBJNF`. The first cf-local validation caught a same-turn contents
     mismatch on `the_chatroom:enter`: the verb returns `room_roster()`, so it
     must be declared `reads_room_presence` and hydrate Directory presence before
     pre-plan authority is merged. That metadata is now explicit, and pre-plan
     remote authority requests tolerate cold-owner read timeouts so stale
     planning can still reach the bounded materialization-repair path.
   - **2e — gate then delete the old per-turn full-slice reconstruction path.**
     Gate behind a flag first so 2a instrumentation proves it's no longer hit on
     warm turns, then remove. **Not yet implemented.**
   - **Provenance is a 2-wide invariant (review pt 5):** every installed
     cell/page carries `source: authoritative | projection | fallback | cache`
     plus owner/head. **Fallback/cache cells MUST NOT be persisted as
     authority** — this is the direct guard against the earlier KV stale-byte
     corruption class (stale bytes written through as truth). Checkpoint/tail
     install paths assert this.
   - **Carry source/owner provenance ON the pages (review pt 4). [implemented in
     this branch for authority-slice pages]** The source host labels
     owner-sourced page refs as `source:"authoritative"` and inherited/cache rows
     as `source:"cache"`. Gateways trust owner-sourced pages from the responding
     host without resolving every returned object's host via Directory; cache
     pages can fill local gaps but do not override local rows. This removes the
     storm's structural cause here, so step 3 is only the *remaining*
     route-resolution batching, not cleanup after a new path repeats the same
     mistake.
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
  per walkthrough/turn. **Deployed B7 met the authority/materialization intent,
  but did not meet the end-to-end cold-start wall intent.**
- Tracked separately, tightened over time: p95 local MCP step wall time; CPU
  budget per turn (warm vs cold buckets).

## The next proof (review, agreed)

Step 1 was not deployed alone. Step 2's deployed proof is now complete only for
the authority slice claim: it removed the executable/authority warm cost without
reintroducing sparse-slice authority corruption. The next proof is different:
cf-local must model the prod Directory/fanout shape that still dominates cold
turns, then that harness should drive mitigation before any further CF smoke
loops.

## Discipline

Each (sub-)step verified against the harness and local measurement before the
next. B7 did improve the authority/executable-open profile without authority
corruption, but the deployed full-smoke failure moved the active acceptance
target to Directory session discovery and cross-shard fanout. Do not re-run the
CF smoke for its own sake — re-measure with `smoke-with-tail.sh` only when a
step should move a specific metric.

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
