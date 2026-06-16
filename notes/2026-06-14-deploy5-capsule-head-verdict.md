# Deploy #5 verdict — capsule-head reseed fix

Origin: 2026-06-14. Deploy #5 = `c97240f6` (main `a873063`, merge of
`capsule-head-reseed`), live on woah1. Successor evidence to deploy #4
(`e0c760a1`, E1.1).

## What shipped

`CommitScopeDO.validateExecutionCapsule` now maps the two head-freshness
checks (`head.scope`, `head.epoch`) to the retryable `E_SNAPSHOT_REQUIRED`
reseed path instead of terminal `E_PROTOCOL`. Integrity checks
(kind/scope/actor/session) stay terminal. Spec aligned; 3 regression tests.

## Verdict: the fix is correct, working, and NOT implicated in remaining fails

Tailed walkthrough after propagation settled
(`.woo/smoke-measurements/20260615T003553Z-7016`), 7/10:

- **0 occurrences** of `execution capsule head scope/epoch mismatch` in the
  tail — the spurious terminal abort is gone.
- **0 reseed-retry events** (`mcp_envelope_slim_reseed` / `snapshot_retry_seed`)
  on this run: the scopes had already converged, so capsule heads validated
  directly. The remaining failures therefore occur on **direct, non-reseed
  turns** — proving they are independent of this fix and its retry path.
- `pinboard:add_note` now **passes** (28.9s) — the deploy-postflight timeout was
  cold-start, settled out.
- `tasks: cross-room entered` passed in the cold postflight (61s) and the cold
  run; flips with repair-budget pressure.

## The three remaining fails are the pre-existing cross-scope state gaps

The capsule-head E_PROTOCOL had been **masking** these by aborting the turn at
capsule validation before the move/commit executed. With it removed, the real
distributed-state divergence surfaces:

1. **outliner roster → `E_NOSESSION`** "actor moveto requires the calling
   actor's live session" (`exit_deck_west:move`, guest_111). The commit scope's
   live `sessions` map lacks the actor's session — the divergent-session-state
   race (`location":"$nowhere"` observed in the tail). world.ts:5863.
2. **outliner:add_item → `E_OBJNF exit_living_room_outline`** (`the_chatroom:go`,
   guest_112, version 2). The exit instance / scope lineage is absent from the
   gateway shard's served world — the missing cross-room lineage gap.
3. **tasks cross-room → `E_REPAIR_BUDGET the_deck`** — the repair loop exhausts
   because the missing state above cannot be reconciled from the shard
   (17 `missing_state_repair`, 4 `E_NEED_STATE` in the tail).

These match the documented cross-scope class: session presence, contents/roster,
and class/instance lineage not reaching gateway shards
([2026-06-09-cf-cross-scope-architecture-plan.md], [2026-06-11-state-epoch-legibility-plan.md]
E5 "one write path per fact").

## Decision

**Do not roll back.** The fix removed a spurious abort on healthy
(self-healed) scopes; the remaining failures exist with or without it. Staying
on `c97240f6`.

## Next vector

The remaining wall is cross-scope state legibility, not capsule validation:
- **Session presence at the destination scope** (E_NOSESSION): the actor's
  live session must be bound to the commit scope it moves into. Tie to the
  session-scope-transition projection (CA8, already in the presence path) and
  the divergent-session-state race.
- **Lineage to the gateway shard** (E_OBJNF / E_REPAIR_BUDGET): the exit
  instance + class chain for a cross-room destination must reach the shard's
  served world (CA11.2 one-hop topology closure carries lineage-only neighbors,
  but not the live exit instance the actor commits against).
This is the E5 relation-pipeline direction; the epoch plan's E2 (named
divergence taxonomy) would turn these three into one tail line each.
