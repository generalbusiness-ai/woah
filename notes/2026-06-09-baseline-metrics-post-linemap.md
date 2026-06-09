# Post-line_map baseline metrics + next-step validation

Origin: 2026-06-09. Context: phases 0–1 of
[2026-06-09-stable-baseline-plan.md](2026-06-09-stable-baseline-plan.md).

Status note, later 2026-06-09: this is the historical post-line_map baseline
used to scope B7. The B7 deploy candidate is rebased onto main `45244cb`; its
implementation and re-attributed `smoke:cf-dev --measure` results are recorded
in [2026-06-09-b7-gateway-install.md](2026-06-09-b7-gateway-install.md).

## State

- `authority-warm-assembly` (CA12.2 line_map-blind page hashing + delivery
  strip) fast-forward merged to main as `8525092`, pushed. Prod runs the same
  code (deploy `abfa1866`).
- Deployed smoke: **8/10**, strictly better than the prior deploy's 6/10 —
  the two outliner steps that previously failed (E_VERBNF / E_PERM, i.e.
  timed out past the cross-colo RPC budget) now pass with the smaller slices.
  No commit_rejected / hash-mismatch anywhere: the CA12.2 one-time reseed
  converged cleanly on rollout.
- The 2 remaining deployed failures are the standing cross-room lineage gaps,
  pre-existing and unrelated to the byte work:
  - pinboard:add_note → E_VERBNF (cross-room enter reachability)
  - tasks cross-room entered → E_OBJNF: the_garden (room lineage not on shard)

## smoke:cf-dev --measure on merged main (this run)

11/11 steps, cold and warm passes. 34 turns/pass:

| metric | cold | warm |
|---|---:|---:|
| total_ms | 13,289 | 12,855 |
| ensure_client_ms | 6,997 | 6,509 |
| authority_ms | 1,049 | 1,037 |
| submit_ms | 2,406 | 2,368 |
| vm_ms | 299 | 384 |
| — planning.seed_authority | 2,937 | 2,742 |
| — planning.initial.open_rpc | 1,520 | 1,422 |
| — planning.owner_prefetch_authority | 1,274 | 1,231 |
| repair turns (attempts≠1) | **0** | **0** |
| slice reconstructions | 58 | 58 |
| — reason=warm_turn_refresh | 21 | 21 |
| first-touch turns (ensure>0) | 20 | 20 |
| warm-repeat turns (ensure==0) | 14 | 14 |
| envelope request_bytes max | 1.24 MB | 1.25 MB |

Phase ms here is a single-process floor, not a prod number; the
transport-independent levers are request_bytes and reconstruction counts.

## What this validates

1. **Warm-repeat turns are already free** (ensure==0 on 14/34). The remaining
   cost is structural, not waste on the repeat path: first-touch scope
   seeding (20 turns pay `seed_authority` + `open_rpc`) and the 21
   per-movement `warm_turn_refresh` / `owner_prefetch` reconstructions.
   ensure_client is ~52% of the local turn wall — the same shape the prod
   attribution showed for the authority side.
2. **Repair attempts are 0 in workerd-local.** The prod ~2-attempts repair
   loop does not reproduce in this lane — collapsing it is a deploy-only
   measurable win. Local gates cannot prove or disprove B7's repair-loop
   benefit; only the reconstruction counters can be validated locally.
3. **Byte lever confirmed in-lane**: max envelope 1.24 MB vs ~1.8 MB+ full
   slice pre-strip (see 2026-06-09-authority-linemap-lever.md), with the prod
   smoke improvement as the end-to-end confirmation.

## Next step: B7 gateway install (scoped)

Investigation (read-only pass over the merged tree) pinned the gap:

- The warm cache **is** populated after every accepted commit
  (`gateway.ts:926` installShadowAcceptedWriteTransferIntoRelayCache,
  cell_pages source:"cache") and a consumer exists
  (`cachedWarmCommitAuthority`, `gateway.ts:1249`), but its guards are
  narrow (`gateway.ts:789-800`: slimWarmEnvelope flag AND non-preplan AND
  sessionOpen). Any miss falls through to full `v2AuthorityPayload`
  reconstruction (`gateway.ts:814`), tagged `warm_turn_refresh` /
  `owner_prefetch` — the 58 reconstructions above.
- Missing entirely: sourcing first-attempt authority from the CommitScopeDO
  head when the gateway-side guards miss. `persistent-object-do.ts:5254`
  has only a stale-snapshot fallback, disabled on retry.
- Prior attempts (2026-06-03 layer-1 Directory routing, 2026-06-04
  relocation prewarm) moved the cost between phases instead of eliminating
  the reconstruction; neither touched the `gateway.ts:814` fallthrough.
- Minimal change set: widen the cached-authority guard (sessionOpen OR
  commit-scope head known), add CommitScopeDO-head sourcing as the
  first-attempt authority source with per-host reconstruction only for cells
  the head lacks; ~80–120 LOC across `gateway.ts`,
  `persistent-object-do.ts`, plus a test asserting a warm turn's
  first-attempt authority carries source:"cache" pages and no
  authority-slice partition RPC.
- Safety backstop confirmed: stale warm cells are caught by transcript
  cell-version validation → normal retryable mismatch
  (`persistent-object-do.ts:~5245`), and `stale_head` replies refresh
  `client.relay.commit_scope.head` (`gateway.ts:842`).

**Success metrics** (must move, measured by this same instrument + deploy):
- slice reconstructions/pass: 58 → ~20 (warm_turn_refresh 21 → ~0)
- first-touch seeding unchanged locally (it's a genuine first fetch);
  prod: attempts ~2 → ~1, submit+authority share of turn wall down
  accordingly; deployed smoke ≥ 8/10 maintained.

## Remaining to reach the <2s prod warm-turn target

Ordered: (1) B7 install above; (2) checkpoint bounding
(WOO_V2_CHECKPOINT_BOUNDED) once reconstruction noise is gone;
(3) the cross-room lineage gaps (the 2 standing smoke failures) — a
correctness fix, likely the same lineage-closure family as the earlier
dangling_parent_ref work, worth its own focused pass.
