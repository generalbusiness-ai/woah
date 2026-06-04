# 2026-06-01 — B7: state transfer as first-class verifiable cache-fill

Second step of Phase B, on branch `mobile-heap-a0a1`, after B6 (commit 791f754).
B7 is VTN0 claim 5: *remote execution returns state as verifiable cache-fill;
state transfer never grants write authority.*

## Finding before writing code (Explore map of the state-transfer impl)

- The **reverse warm-fill was missing**. State transfer existed only as a
  *pre-execution* repair (fill an executor that returned `missing_state`) and, on
  the browser relay path, as a half-measure. The core executor `successReply`
  carried **no** `state_transfer`; the `accepted_write_cells` transfer purpose
  was reserved but **unbuilt**. So a turn that executed on a remote owner never
  warmed the *caller* — the next same-object turn delegated remotely again.
- A5 deleted the in-memory `authorityCheckpoints` (a RAM cache of the projection
  cache that missed its prod budget) **intending B7's content-addressed
  read-through to replace it**. B7 is that replacement, done verifiably.
- The `cell_pages` build/install machinery, `source:"cache"` provenance stamping
  (`recordExecutionNodeCellProvenance`), and the PlanningWorld admission gate (A3:
  a cache cell can't satisfy a commit-validation read) already existed.
- `closure` mode was effectively dead: produced only for an in-process retry that
  defaults to `cell_pages`, never attached to a reply, and rejected by the browser
  (`must use cell_pages`).

## Part 1 — commit-reply warm cache-fill (commit 0f4bedc)

`buildShadowCommitWarmTransfer`: after an accepted **durable** commit, an
**authoritative** executor (one that owns the committed post-state) builds a
`cell_pages` transfer of the committed turn's full `TurnKey` closure
(`purpose: "accepted_write_cells"`, recipient `"*"`, anchor-MAC proof) and
attaches it to the success reply (`successReply` gained an optional transfer arg;
attached in both authoritative success paths). A sparse executor returns none —
**zero impact on the sparse MCP gateway hot path**.

The caller installs it as `source:"cache"` (a content-addressed read-through at
the post-commit head). The next same-object turn plans locally with **no second
remote state fetch** and still commits at the owner's scope — a `source:"cache"`
cell never satisfies a commit-validation read, so it carries no write authority.

**Gate** (`tests/v2-state-transfer-warmfill.test.ts`, in the npm test list): the
two-node case the B7 note requires — remote execute on authoritative owner B →
install reply transfer into sparse caller A → A's next same-object turn is local
with **zero** transfers; A's installed rows are all `source:"cache"`; the commit
head still advances at the owner. Negative control: a cold caller needs ≥1
transfer (proving the warm-fill is what removes the round-trip).

## Part 2 — retire the dead `closure` mode (commit a452ddd)

`closure` (a whole-serialized-world bundle) is retired in favor of `cell_pages`
(only the touched closure, content-addressed). Removed the producer and type
surface across `shadow-turn-exec.ts`, `shadow-turn-network.ts`,
`shadow-browser-node.ts`, `client/v2-browser-cache.ts`; kept the defensive
ignore/reject paths that the legacy-mode tests verify (browser ignores a
`closure` it receives and requests `cell_pages`). `object_records` remains the
internal executor-repair fallback. The one test exercising closure *acceptance*
converted to `cell_pages`; the two browser tests exercising closure *rejection*
keep their loose-typed literals and still pass.

## Spec

- `spec/protocol/v2-turn-network.md` §VTN12.1 — commit-reply warm cache-fill
  contract. §VTN12 mode types drop `closure`; a retired-mode note records the
  supersession.

## Validation

typecheck clean; `npm test` 301/301 (23 files); `gate:authority` 2/2.

## Production follow-up (2026-06-04, branch `b7-authority-warmfill`)

- **Production gateway-install wiring is now implemented.** MCP and REST install
  accepted `accepted_write_cells` `cell_pages` transfers into their relay caches
  as `source:"cache"`. Planned-transcript commits now attach the same warm
  transfer as executor-run accepts, so cross-scope MCP movement warms the caller
  after success.
- **MCP planning is warm-cache-first.** The gateway no longer pays the
  unconditional pre-plan authority refresh on every turn. Local planning
  `E_NEED_STATE` / sparse lookup misses still trigger a bounded pre-plan repair;
  commit submission still carries the bounded validation authority payload and
  uses CommitScopeDO snapshot fallback on the first envelope attempt.
- The four transfer *modes* are resolved (projection/delta/cell_pages live;
  closure retired; object_records internal).

Next: B8 (capability gossip routing) per `notes/2026-06-01-a0-a1-landed.md`.
