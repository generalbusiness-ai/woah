# C2 + C3: bounded-turn structural gates and scenario coverage

**Date**: 2026-06-09
**Branch**: c2c3-gates-scenario
**Plan**: notes/2026-06-09-cf-cross-scope-architecture-plan.md (Track C)

## What was built

### C2: structural gates in tests/worker/cf-local-structural.test.ts

New test: "C2: measures cross-scope envelope bytes, dangling refs, RPC counts, and sessions (enforced + tracked gates)".

Two sessions (alice + bob) open in the chatroom. Alice traverses chatroom → deck → pinboard → deck → chatroom. Bob is idle (present but not acting). The test separately measures movement turns and a same-scope `say` turn.

#### ENFORCED gates (fail the build if violated)

1. **Same-scope envelope authority_bytes == 0**: The `say` turn must carry zero authority bytes when `WOO_V2_SLIM_WARM_ENVELOPE=1`. Measured via `v2_envelope_bytes.authority_bytes` (breakdown metric). In the fake lane, `v2_envelope.request_bytes` is always 0 because the gateway constructs requests via `new Request(url, {body})` without a `content-length` header; the breakdown metric uses `jsonByteLength(input.authority)` on the parsed object and is accurate.

   Current measurement: `authority_bytes=0, sessions_bytes=189` — slim path confirmed working.

2. **Warm turn structural invariants** on movement turns: `attempts==1`, `authority_calls≤1`, zero `warm_turn_refresh`/`missing_state_repair`, exactly one `/v2/envelope` per accepted turn. Run via `assertWarmTurnStructuralGate` on the 4 movement turns only (not `say`, because with 2 sessions `say` fans to `scoped_shards=2` which is correct but would violate the single-session fanout gate).

3. **dangling_parent_ref == 0** on movement-only turns. Movement turns (enter/leave/traverse) never involve `$portable` objects; any dangling ref here is a regression. The A2 debt (portable lineage not reaching gateway shard relay) is tracked via carry-across-rooms (C3), not here.

4. **sessions_for_scopes ≤ actors + 1** in the fake lane. The fake Directory is clean — no stale-session accumulation (the A1 production problem). If this fails, a new code path is creating extra sessions.

#### TRACKED gates (print measured value; fail only when invariant UNEXPECTEDLY passes)

- **B-i: cross-scope envelope authority_bytes**: Currently ~840KB-1.1MB per movement turn (planned-transcript commits carry the full authority slice). Target: < 256KB after B-i (read-closure envelopes). Current measurement greatly exceeds 256KB — TRACKED correctly.

- **D2: cross-host RPC count per warm turn**: Logged but NO TRACKED/PROMOTE check. In the fake lane RPCs are in-process (not real cross-colo calls); the fake-lane count (~2.5/turn) is not comparable to production (~8+/turn). A gross-regression ceiling (6 = 2× D2 target) is enforced as a floor check only. Real D2 tracking belongs in smoke-cf-dev.ts.

- **A1: sessions_for_scopes**: Converted from TRACKED to ENFORCED (see above). A1 production stale-session accumulation is not visible in the fake lane.

#### byte measurement design note

`WOO_V2_ENVELOPE_BYTE_BREAKDOWN=1` is now set in:
- `CommitScopeDO` env (in `createStructuralHarness`): enables the breakdown metric with accurate `authority_bytes`
- outer `env` (for consistency; the gateway itself does not read this flag)

The breakdown metric adds synchronous CPU for `jsonByteLength(authority)` but that is acceptable in the structural harness.

#### timeout

The C2 test has a 120 s per-test timeout (vs 45 s global). Two sessions on separate gateway shards means two cold world installs (~17s each) plus 10+ turns, giving ~14s in practice but requiring headroom.

### C3: scenario coverage in scripts/smoke/scenario.ts

Two new optional steps added to `SmokeScenarioOptions`:

#### carry-across-rooms (→ A2)

Alice takes `the_mug` in `the_chatroom`, traverses `southeast` to `the_deck`, calls `read mug` (exercises verb dispatch on a carried `$portable` object across scope boundary), then drops the mug. Bob (also on the deck) waits for the `dropped` observation. A restoration step (bob takes the mug back to chatroom) ends the sequence.

This step intentionally triggers `dangling_parent_ref` for the `$portable` class lineage on the gateway shard relay (A2 debt). It is:
- **OFF** in `cf-local-walkthrough.test.ts` (same reason as `includeTakeDrop: false` — dangling ref breaks the zero-dangling gate)
- **TRACKED A2** in `smoke-cf-dev.ts` (expected to fail until A2 ships)

#### tool-surface-after-move (→ A2)

Alice enters `the_pinboard` after having moved scopes, calls `woo_list_reachable_tools`, and asserts `{object:"the_pinboard", verb:"add_note"}` appears in the result. Alice then leaves the pinboard. This verifies tool surface reachability after a cross-scope transition.

Also TRACKED in cf-dev for same reason as carry-across-rooms.

#### carry-across-rooms restoration note

The scenario restores world state: after alice drops the mug in the_deck, bob picks it up and returns it to the_chatroom. This ensures the mug is back in its seed location after the test, preventing interference with other scenario steps.

### cf-dev lane tracked-fail infrastructure in scripts/smoke-cf-dev.ts

`CF_DEV_TRACKED_FAIL_STEPS` map:
- `"carry-across-rooms"` → `"→ A2"`
- `"tool-surface-after-move"` → `"→ A2"`

When a step in the map fails: logged as `TRACKED-FAIL [→ A2]`, does not count toward `anyFailed`.
When a step in the map passes: logged as `TRACKED-OK (promote to ENFORCED)`, counted as an unexpected pass (forces investigation).

Summary output separates unexpected failures (affect exit code) from tracked failures (printed for visibility).

## Per-lane behavior

| Gate | cf-local-structural | cf-dev smoke | deployed |
|------|---------------------|--------------|----------|
| warm turn invariants (attempts/auth/repair/envelope) | ENFORCED | via scenario | via scenario |
| same-scope authority_bytes == 0 | ENFORCED | (content-length works in workerd) | same |
| cross-scope authority_bytes < 256KB | TRACKED B-i | TRACKED B-i | TRACKED B-i |
| dangling_parent_ref movement turns | ENFORCED 0 | (not in structural) | — |
| dangling_parent_ref carry-across-rooms | — | TRACKED A2 | TRACKED A2 |
| cross-host RPC per turn | floor only (not comparable) | TRACKED D2 | — |
| sessions_for_scopes ≤ actors+1 | ENFORCED (fake lane clean) | TRACKED A1 | — |

## Files changed

- `tests/worker/cf-local-structural.test.ts` — C2 test added; `WOO_V2_ENVELOPE_BYTE_BREAKDOWN` in CommitScopeDO env; byte measurement switched from `request_bytes` to `authority_bytes`; per-test timeout 120 s
- `scripts/smoke/scenario.ts` — C3 steps `carry-across-rooms` and `tool-surface-after-move`
- `scripts/smoke-cf-dev.ts` — tracked-fail infrastructure for C3 steps
- `tests/worker/cf-local-walkthrough.test.ts` — `includeCarryAcrossRooms: false, includeToolSurfaceAfterMove: false` (same guard as `includeTakeDrop: false`)
- `package.json` — `tests/worker/cf-local-structural.test.ts` added to `npm test` curated gate

## Test results

```
npm test: 38 test files, 515 tests — all pass
npm run typecheck: clean (both tsconfigs)
npm run test:files tests/worker/cf-local-structural.test.ts: 5/5 pass
```

## Promoted-to-enforced adjustments from initial plan

The initial plan listed A1 (sessions) and D2 (RPC count) as TRACKED in the fake lane. In practice:
- **sessions_for_scopes**: fake lane Directory is clean and accurate; there are never stale sessions. PROMOTED to ENFORCED in the fake lane (added a regression gate at ≤ actors+1). A1 production stale-session tracking remains in cf-dev.
- **cross-host RPC count**: fake-lane count (~2.5/turn) is not comparable to production (~8+/turn) because in-process DO calls have different overhead. Converted to a gross-regression floor check only (ceiling 6 = 2× D2 target). Real D2 tracking in cf-dev.
- **dangling_parent_ref for movement turns**: movement-only scenario doesn't touch `$portable` objects; dangling refs don't fire. Gate correctly ENFORCED to 0 for movement turns. The A2 tracking moves to carry-across-rooms (C3).
