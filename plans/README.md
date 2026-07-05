# Implementation Plans

Execute in the order below unless dependencies say otherwise. Each executor
must read the plan fully before starting, honor its STOP conditions, and
update the status row when done. (Index started by the improve skill
2026-06-28.)

## Execution order and status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001 | Establish a functional performant baseline | P1 | L | - | DONE (superseded tail — see 002) |
| 002 | The simplest deployable system (coherence layer) | P1 | XL | 001 | TODO (approved 2026-07-05) |

Status values: TODO | IN PROGRESS | DONE | BLOCKED | REJECTED

## Dependency notes

- Plan 002 is the active program: keep the world engine, new-build the
  `src/net/` coherence layer, delete the v2 distribution layer at cutover.
  Full text in `notes/2026-07-04-simplest-system-plan.md` (rev 3); owner
  approved all its §8 decisions on 2026-07-05, including a standing **v2
  freeze**: no further v2 state-path deploys while 002 runs.
- Plan 001 delivered its baseline: local/workerd green candidate 2026-06-29;
  deployed baseline passed after the `b8e55f9` cycle (owner review,
  2026-07-05). Its remaining classification tail is subsumed by 002's
  freeze; its validation regime carries forward into 002 unchanged.
- Runtime implementation must remain aligned with `spec/`; the plan calls out
  the specific spec/docs checkpoints that need updates if behavior or gates
  change.

## Findings considered and rejected

- Reuse the abandoned `gateway-session-presence` worktree: rejected. The note in
  `notes/2026-06-16-gateway-session-presence-verdict.md` shows it leaked live
  session ids in client-visible error payloads and did not prove a failing path
  on main.
- Return to source-only seeds: rejected. Recent memory records that this lever
  regressed and was reverted. The current committed direction is epoch-stamped
  repair and anchored host seed snapshots.
- Treat broad-suite timeouts as product failures without isolation: rejected.
  The current evidence says the relevant tests pass in isolation, so scheduler
  pressure and runtime behavior must be separated with targeted tests plus the
  full gate.
- Do browser polish before deployed responsiveness: rejected. The open
  commitment remains functional deployed MCP/browser responsiveness and
  state-path convergence.
