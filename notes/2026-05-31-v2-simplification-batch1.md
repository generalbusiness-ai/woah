# 2026-05-31 — v2 simplification, batch 1 (dead-code + spec)

Branch `v2-simplification`, off `main` (`dbca310`). Implements the safe,
gate-validated subset of the simplification review in this session. Net
**−802 LOC** (13 files, 54 insertions / 856 deletions). Every commit passes
`npm run typecheck` (both tsconfigs) and `npm test`.

## Commits

1. `626e3f5` **Remove withdrawn #placement commit-transaction chain.** The
   placement/MV-A "write-fence" path was stubbed (`shadowPlacementTransactionForTranscript`
   returned `null` unconditionally) since the cell-authority CA3 redesign, so the
   whole chain was unreachable. Removed `ShadowCommitTransaction`, the placement
   validators, `executorTransactionObjectIds`, the `transactionScope` re-plan loop
   in `executor.ts`, the `commitTransaction` spreads in shadow-turn-exec /
   shadow-browser-node, and the `write_fence_missing` conflict reason. **Kept**
   `shadowLocationCommitScopeForTranscript` and `planned_transcript` (the live CA3
   cross-scope path). Tests that asserted the dead helper were updated.
2. `5c11524` **Remove dead `intent` executor strategy.** Every caller passed
   `strategy:"planned-exec"` and an always-identity `intentScope` ternary, so the
   `"intent"` branch was never entered. Collapsed `submitTurnIntent` to a single
   strategy; dropped the `strategy`/`intentScope` options and their no-op args.
3. `1cc9a09` **Delete prototype-only gossip profiler.** Removed
   `shadow-gossip-profile.ts`, its test, and `scripts/profile-shadow-turn-network.ts`
   — none on the production graph. (`turn-replay.ts` was KEPT: it is imported by
   `shadow-turn-exec.ts`, contradicting the original "test-only" assumption.)
   NOTE: this commit deleted the profiler script file but left the `v2:profile`
   entry in `package.json` pointing at it (an orphaned npm script — green because
   typecheck/test don't validate package.json). Fixed in `6ca7129`.
4. `9009630` **Demote MV-A/#placement spec to historical pointer.** Replaced the
   ~70-line withdrawn MV-A contract in `spec/protocol/v2-turn-network.md` §VTN8.1
   with a one-paragraph record, and removed `write_fence_missing` from the protocol
   `CommitConflict.reason` union so spec matches the P0.1 code removal.

## Deliberately NOT done (need a different validation discipline; see review)

- **P3.8 god-file extraction** (host-seed-kv / mcp-gateway-shard / handleInternal
  route table). Behavior-preserving but the free functions are entangled with
  file-local helpers; needs manual import-resolution with **typecheck-first**
  gating before each commit. Two agent attempts thrashed here — `npm test` does
  NOT compile the worker tsconfig, so worker breakage only shows under
  `npm run typecheck`. Do this by hand.
- **P3.9 layering** (`$player`/`$room`/command-word literals in `src/core/world.ts`)
  — behavior-CHANGING (catalogs must set new metadata in lockstep); tests can stay
  green while presence/look/parse break. Needs catalog co-changes + verification.
- **P1.4 delete `authorityCheckpoints`**, **P1.5 cache collapse (17→5 layers)**,
  **P2.6 turn-path convergence** — behavior-changing; must be validated by
  deploy + tail measurement, not green-only (the step-2 prod measurement already
  proved tests pass while prod budgets fail). P1.4 is tied to the failing
  warm_turn_refresh / dangling_parent_ref budget.
- **P3.7 rename** (strip `Shadow`/`shadow` prefix from load-bearing modules) —
  mechanically safe but huge/noisy; the `.shadow.v1` wire discriminators are a
  versioned protocol change, not a blind rename. Best as its own isolated PR.

Full prioritized review is in this session's history; the deep items each warrant
a dedicated session.
