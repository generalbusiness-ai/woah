# 2026-06-01 — B6: commit scope chosen by the turn's write set

First step of Phase B (mobile-heap), on branch `mobile-heap-a0a1` after Phase A
(A0–A5) landed. B6 is VTN0 claim 3: *the commit scope is chosen by the turn's
write set, not by a fixed home host.*

## Key finding before writing any code

Instrumented the `gate:authority` walkthrough to log the write-set owner
signature of every committed transcript. Result: **every turn in the current
system reduces to a single ordering authority.** The owner set is always one of:

- pure move (`loc_objs=1, non_loc_auth=0`) → the moved object's own scope (CA3,
  off the room);
- everything else (room props, created objects, or a move *plus* a room write
  like `enter`+roster) → the planning/room scope, which is the natural
  serialization point.

The "two-owner" turns are **never** genuine cross-authority contention — they are
always `{moved object} ∪ {planning scope}`, where the room must serialize anyway.
There are **zero** genuine multi-home turns (two objects relocating to different
non-planning homes) in the current catalogs.

So the pre-B6 binary rule `shadowLocationCommitScopeForTranscript(t) ?? scope`
**already is** the write-set-derived rule — just expressed narrowly, without a
model, and without an explicit multi-scope path.

## What B6 builds (principled consolidation; not full minting)

1. **One selection function** `shadowCommitScopeForTranscript(transcript)` →
   `{ scope, basis, owners }` with an explicit authority-owner model
   (`location:<obj>`→obj; prop/verb/lifecycle + creation→planning scope; contents
   excluded as projection). The chosen `scope` is **provably identical** to the
   pre-B6 rule for every `relocation` and `planning` turn — `relocation` reuses
   `shadowLocationCommitScopeForTranscript` verbatim. Threaded into the single
   shared decision point, `submitTurnIntent` (`src/core/executor.ts`), used by
   every transport (worker MCP, REST relay, dev WS, browser).

2. **Defined `multi` semantics.** A write set reducing to ≥2 distinct
   non-planning owners is classified `multi` and emitted as a `commit_scope_multi`
   metric. Behavior is preserved (commit at the planning scope). The substrate
   cannot yet tell a benign same-scope multi-object move from a true cross-home
   one — that needs B8's route-home model — so enforcement (clean retryable
   conflict vs. minted combined scope) is **deferred to ride on B8/CA10.2**.
   Building combined-scope minting now, before B7's verifiable transfer exists,
   is exactly the "mobility on incomplete substrate" trap the ordering forbids.

3. **CA14.3 conformance gate.** New `gate:authority` walkthrough step: two actors
   move through the same destination concurrently (`Promise.all` move-out to the
   shared deck, then concurrent re-entry to the chatroom), then bidirectional
   `say` proves neither membership was lost. The existing zero-tolerance CI
   ratchet auto-asserts zero `read_version_mismatch`.

## Spec

- `spec/protocol/v2-turn-network.md` §VTN8.2 — the write-set selection rule
  (owner model, the three bases, deferred `multi` enforcement). Status:
  implemented (selection); enforcement deferred to B8.
- `spec/protocol/cell-authority.md` §CA3 — CA3 reframed as the `relocation` case
  of VTN8.2; CA14.3 now noted as concurrently gated.

## Tests

- `tests/shadow-commit-scope.test.ts` — 7 selector unit tests (relocation /
  planning / multi / creation / contents-excluded / legacy-equivalence).
- `tests/worker/cf-local-walkthrough.test.ts` — the concurrent-movement step.

## Validation

`npm run typecheck` clean; `tests/shadow-commit-scope.test.ts` 17/17;
`gate:authority` 2/2 green (zero-tolerance, with the new concurrent step);
`npm test` curated gate green.

## What B6 deliberately does NOT do (rides on later steps)

- No combined/minted temporary scope DO, no lease/epoch-fence acquisition across
  route homes (needs B8 route homes + B7 transfer).
- No change to any catalog's write set (B6 chooses the scope for a given write
  set; it does not reshape write sets — e.g. the outline roster prop staying a
  shared cell vs. becoming a per-member projection is a catalog/A4-style concern,
  not B6).

Next: B7 (state transfer as verifiable cache-fill) per
`notes/2026-06-01-a0-a1-landed.md`.
