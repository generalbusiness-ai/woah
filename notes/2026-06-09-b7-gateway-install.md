# B7 gateway install — warm first-attempt authority from the commit-scope cache

Origin: 2026-06-09. Phase 1.2 of
[2026-06-09-stable-baseline-plan.md](2026-06-09-stable-baseline-plan.md);
baseline + success metrics in
[2026-06-09-baseline-metrics-post-linemap.md](2026-06-09-baseline-metrics-post-linemap.md).
Branch `b7-gateway-install` off main `8525092`.

## Instrument first: where the 58/21 actually came from

The baseline's "21 warm_turn_refresh reconstructions/pass" was unattributed, so
the first step adds a `trigger` field to `authority_slice_reconstructed`
(threaded from each gateway call site through `v2GatewayAuthorityPayload` to
the metric) and a per-trigger row in the `--measure` table. The attributed
cold pass on the unmodified-behavior tree (this machine):

| trigger | count | what it is |
|---|---:|---|
| slice_served | 37 | owner-side servings of `/__internal/authority-slice` |
| scope_seed | 13 | first-open relay seeding — MISLABELED `warm_turn_refresh`: the worker hook always passes `tolerateRemoteFailures`, so the reason defaulted warm |
| owner_prefetch | 8 | per-movement destination owner prefetch |
| turn_commit | 0 | per-turn commit authority — `cachedWarmCommitAuthority` ALREADY hits on every warm turn |

Two pinned-gap assumptions did not survive contact with the attribution:

- the `gateway.ts` commit-phase "fallthrough" was NOT the warm cost —
  `turn_commit` reconstructions were already zero (`ensureClient` opens the
  session before the commit-phase payload runs, so `sessionOpen` always held);
- 13 of the 21 "warm" reconstructions were first-open scope seeds with a
  mislabeled reason, not per-turn waste. The baseline note itself classifies
  first-touch seeding as a genuine first fetch.

## What changed

1. **Owner-prefetch residue rule** (`ensureV2OwnerAuthorityPrefetch`,
   `src/mcp/gateway.ts`) — CA11.1's "repair only the missing cell/object ids":
   - `warm_local`: an id whose tracked `object_lineage`+`object_live` cells
     (exactly what the CA11.2 movement-destination guard checks) are already
     owner-authoritative in the planning relay needs nothing;
   - `warm_donor`: an id held owner-authoritatively by ANOTHER warm scope
     client on the same gateway is copied between relay caches process-locally
     (`warmRelayAuthoritySliceForObject`): pages re-served with their recorded
     provenance, content-addressed and re-hashed by the same line_map-blind
     preimage owners use (CA12.2), with commit-time cell-version validation as
     the staleness arbiter;
   - only the residue pays a reconstruction, now reported `cold_open` (a first
     fetch of ids this shard never held with owner authority).
   New `mcp_owner_prefetch` metric records requested/warm_local/warm_donor/
   residue per pass.
2. **Repair attempts never serve the warm cache**: `submitTurnIntent`
   (`src/core/executor.ts`) threads `attempt` into the authorityPayload
   context; the gateway's cached-authority guard refuses attempt > 0, so a
   retry after a conflict reconstructs instead of re-serving the cache that
   just failed validation (closes the cache → mismatch → cache loop class).
3. **Guard widening**: the cached path also serves when the relay's
   commit-scope head has advanced past `@0` even if this session's open
   marker is not yet recorded (a second session on a shard whose scope client
   is already warm).
4. **Honest reason taxonomy**: gateway seed sites explicitly pass
   `reconstructionReason: "cold_open"` (`scope_seed` / `snapshot_retry`
   triggers); the per-session re-open authority keeps `warm_turn_refresh`
   (trigger `session_open`) because it is a real warm-path residual this step
   did not eliminate.

Spec: CA11.1 gained a B7 implementation-status note
(`spec/protocol/cell-authority.md`). Tests: `tests/mcp-warm-authority.test.ts`
(added to the curated `npm test` list) covers the four contracts: warm
same-scope turn = zero hook reconstructions; prefetch residue/donor split
(provenance-downgraded fixtures, since the in-process world exports everything
authoritative); multi-actor same-scope contention converges ≤ 2 attempts with
correct final state; a forced conflict's repair attempt reconstructs through
the hook (`turn_commit`) instead of the cache.

## The regression the gates caught (and the lesson)

The first cut also forced REAL remote owner fetches on repair attempts
(disabling the CommitScopeDO snapshot fallback when attempt > 0).
`tests/worker/cf-repository.test.ts` "fans accepted cross-scope moves to MCP
shards in the destination room" regressed: the refetched slices, merged back
into the relay via applyAuthority, displaced fresher repair-installed rows and
re-tripped the movement-destination guard until the repair budget gave up.
Reverted: the snapshot-fallback contract is unchanged; repair freshness comes
from the pre-plan `missing_state_repair` force-owner refresh and the conflict
reply's applyHead/applyStateTransfer installs, not from the commit-phase
payload. (The "never serve cache on a repair attempt" rule applies to the
warm-cache path only.)

## Measured effect (`smoke:cf-dev --measure`, cold pass; same machine)

| metric | before | after |
|---|---:|---:|
| steps | 11/11 | 11/11 (both passes) |
| slice reconstructions (total) | 58 | **52** |
| — reason=warm_turn_refresh | 21 | **0** |
| — trigger=owner_prefetch | 8 | 6 |
| — trigger=scope_seed | 13 | 13 |
| — trigger=slice_served | 37 | 33 |
| planning.owner_prefetch_authority (ms) | 1306 | **803** |
| ensure_client_ms | 7140 | 6519 |
| repair turns (attempts≠1) | 0 | 0 |
| envelope request_bytes max | 1.24 MB | 1.24 MB |

Honest read against the success metric ("58 → ~20-25, warm_turn_refresh ~0"):

- `warm_turn_refresh` → 0 ✓, but 13 of the 21 got there by the taxonomy fix
  (they were first-open seeds all along), not by eliminated work.
- Real eliminated work in-lane: 2 of 8 owner-prefetch reconstructions plus
  their 4 owner-side `slice_served` servings (58 → 52 total), and −39% of the
  owner-prefetch phase wall. The remaining 6 prefetches are genuine first
  sightings per shard (e.g. the_deck before any deck client exists) — the same
  nature as scope seeds, which the plan classifies as bounded cold cost.
- The "~20-25" target was derived from the misattribution that all 21 warm
  reconstructions (and their owner servings) were per-turn waste. With
  `turn_commit` already at zero and seeds being first fetches, this lane's
  eliminable margin was smaller than the target assumed. The remaining
  honest reduction levers in-lane are the 13 first-open seeds (shrinking the
  seed itself — out of scope here) and `session_open` re-opens on shard reuse.
- Steady-state benefit is understated by this lane: each smoke pass uses
  fresh actors and mostly fresh shards, so warm_local/warm_donor hit rates are
  at their floor. A long-lived gateway with revisited rooms hits the warm
  paths far more often, and the repair-loop rule (never serve cache on retry)
  is a deploy-only measurable win (prod attempts ≈ 2; workerd-local repairs
  are 0).

## Warm-pass flake (pre-existing, characterized — NOT fixed here)

Pass 2 of `--measure` reuses pooled guest actors with fresh sessions. When a
pass-2 session lands on a shard still holding the closed pass-1 session row,
`primarySessionForActor` picks the stale session, `moveto_actor` runs with
`is_primary:false`, the physical move is skipped, and location/activeScope
diverge ("E_PERM guest_N is not present in ..."). Observed on the unmodified
tree (warm pass 5/11) and absent when pass-2 sessions hash to fresh shards
(11/11, as in the baseline note's run and the after-run here): shard
assignment hashes random session ids, so the warm pass is run-to-run
nondeterministic. This is the RC1 session-pruning gap (stable-baseline plan,
Phase 2), orthogonal to this change; cold-pass metrics are the stable
comparator.
