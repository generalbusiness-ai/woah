# B-iv: bounded checkpoints + tail budget

Origin: 2026-06-10. Plan item B-iv from
[2026-06-09-cf-cross-scope-architecture-plan.md](2026-06-09-cf-cross-scope-architecture-plan.md).

## What was done

### 1. Enable WOO_V2_CHECKPOINT_BOUNDED in production and lane configs

`WOO_V2_CHECKPOINT_BOUNDED = "1"` and `WOO_V2_CHECKPOINT_FRAME_INTERVAL = "32"` added to:
- `wrangler.toml` (production)
- `wrangler.smoke.toml` (cf-dev smoke lane)
- `wrangler.cf-e2e.toml` (cf-e2e browser lane)

The `guard:smoke-wrangler` WOO_* parity check passes on all three.

### 2. Threshold rationale: interval = 32

The code default (in `checkpointFrameInterval`) is already 32; we are making it
explicit in config. The rationale:

- Default mode (checkpoint every commit) rebuilt the ~3 MB checkpoint on every
  accepted commit to the CommitScopeDO. This accounts for an estimated 10–15% of
  per-turn CommitScopeDO cpuTime.
- 32 is large enough to amortize the checkpoint cost: the scope writes one
  checkpoint every ~32 turns instead of every turn. For a room at 1 turn/s, that
  is one checkpoint per ~32 seconds — well within a DO's idle-eviction window, so
  the checkpoint is always recent and cold-replay cost is bounded.
- 32 frames bounds worst-case tail-only cold replay to a small, bounded window.
  With per-frame sizes of a few KB to ~50 KB, 31 uncovered frames is at most
  ~1.5 MB of tail replay before a fresh checkpoint arrives.
- The first commit after a cold activation ALWAYS checkpoints (checkpointedSeq is
  null → due = true), bounding the absolute worst case (DO evicted exactly at
  frame N where N % 32 ≠ 0) to one full replay of the interval.
- Set `WOO_V2_CHECKPOINT_FRAME_INTERVAL = 1000000` to measure the CPU floor
  (effectively never checkpoint on commit); the deployed value is 32.

### 3. Correctness test: rehydration mid-interval

Added test "P1′ bounded mode: evicted DO rehydrates correctly from checkpoint +
tail (frames beyond last checkpoint)" in
`tests/worker/commit-scope-checkpoint-tail.test.ts`.

The test seeds: seq 1 with a persisted checkpoint, seqs 2–3 as tail-only frames
(no checkpoint). A new DO instance (simulating eviction) on the same storage
must serve head.seq = 3 and a frame-mode transfer carrying both seq 2 and seq 3
when opened with known_head = seq 1. This verifies that `loadRowSnapshot`
correctly rehydrates from checkpoint + tail and that `relayFor` / the checkpoint-
open path returns the correct head.

### 4. Tail retention budget

`SHADOW_TAIL_RETENTION_BYTES` reduced from 16 MB to 4 MB (per table; combined
ceiling is 8 MB). Previously 16 MB per table (32 MB combined) was too lax: the
b7-tail run showed `the_chatroom` at 17.6 MB combined retention, caused by
covered frames not being pruned quickly enough when the checkpoint build lagged.

With bounded mode (interval 32) checkpoints fire regularly, enabling more
aggressive pruning. The 4 MB budget ensures covered frames are pruned quickly
once a checkpoint lands.

`SHADOW_TAIL_RETENTION_MS` reduced from 7 days to 1 hour. The age-based pruning
applies ONLY to covered frames (seq ≤ checkpointHeadSeq). Uncovered frames are
ALWAYS preserved regardless of age — a rehydrating DO must be able to replay
all frames since the last durable checkpoint. 1 hour is generous: DOs typically
rehydrate within seconds, and the checkpoint floor provides the correctness
guarantee, not the age limit.

### 5. Cursor-floor determination: MOOT

The D1 design brief raised the concern that tail pruning must not outrun an
in-flight delivery (the "cursor floor" rule). Investigation confirms this concern
is **moot** for the CommitScopeDO relay tail:

- The D1 outbox lives in `v2_fanout_pending` on the **gateway DO**
  (`PersistentObjectDO`), not on the `CommitScopeDO`.
- `v2_fanout_pending` rows carry **self-contained payloads** (full commit +
  transcript + fanout list serialized into the `payload` column).
- The `drainFanoutPending` drain function never reads from `v2_commit_scope_accepted_frame`
  or `v2_commit_scope_transcript_tail`. It only reads from `v2_fanout_pending`.
- Therefore pruning the CommitScopeDO relay tail cannot outrun an in-flight D1
  delivery. The cursor-floor rule does not apply here.

Evidence: `src/worker/persistent-object-do.ts` `drainFanoutPending` (~6509) reads
only `v2_fanout_pending`; `deliverMcpCommitFanout` receives the commit/transcript
from the deserialized `payload` field, not from the CommitScopeDO.

### 6. v2_fanout_pending cleanup sweep

Added a retention sweep at the start of every `drainFanoutPending` pass:

```sql
DELETE FROM v2_fanout_pending WHERE delivered = 1 AND queued_at_ms < now - 24h
```

Previously the per-success cleanup ran only after a successful delivery (7-day
retention). Abandoned rows (marked `delivered=1` after MAX_DRAIN_ATTEMPTS) and
rows from scopes with persistently-failing deliveries would accumulate for up to
7 days before the next success triggered cleanup. The new sweep at drain-start
ensures delivered/abandoned rows are pruned within 24 hours regardless of whether
new deliveries succeed, bounding the table to at most one day of history.

The per-success 7-day cleanup at the bottom of a successful delivery is
retained as a belt-and-suspenders path (idempotent with the sweep).

### 7. Metrics

Task 4 (observability) is satisfied by existing metrics:

- `authority_tail` metric: `tail_rows_pruned` (prune actions per commit) and
  `tail_bytes_retained` (current total bytes in both tail tables). Already emitted
  in `saveEnvelopeDelta`; visible in the AE dashboard.
- `v2_open_step` with `phase: "checkpoint_build"` and `reason:
  "accepted_commit_bounded_skip"`: emitted on every skipped checkpoint, tracking
  cadence. `reason: "accepted_commit_bounded"` on every actual checkpoint build.

No new metric kinds were required.

## Retention policy summary

```
CheckpointFloor = persisted checkpoint head seq (from v2_commit_scope_checkpoint)

For seq > CheckpointFloor: ALWAYS retained (checkpoint-floor hard constraint).
For seq ≤ CheckpointFloor: retained if within 4 MB per table AND within 1 hour.
v2_fanout_pending: delivered=1 rows pruned at drain-start if queued_at_ms < 24h ago.
```

## Validation

- `node scripts/guard-smoke-wrangler.mjs`: green (4/4)
- `npm run test:files -- tests/worker/commit-scope-checkpoint-tail.test.ts`: 14/14
- `npm run typecheck`: clean
- `npm test`: ~582
- `npm run test:worker`: ~286
- `npm run smoke:cf-dev` ×2: 13/13
