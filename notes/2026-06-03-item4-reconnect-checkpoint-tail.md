# 2026-06-03 — Item 4: reconnect / idempotency / checkpoint-tail (drift convergence #4)

Fourth item of the localdev↔CF drift-convergence sequence; see
[2026-06-02-localdev-cf-drift-convergence.md](2026-06-02-localdev-cf-drift-convergence.md):
1 durable-turn-path, 2 fanout-topology, 3 object-host-write-through, **4 this**,
5 browser-projection-holder. Goal of the sequence: localdev must exercise the
same machinery as CF so a bug surfaces in a dev test, not only in a CF smoke run.

## What item 4 landed

- **4a — durable relay-tail persistence (MERGED, main `e7b3daa`).** localdev now
  persists the relay tail (`head`, `recently_seen`, `recent_replies`,
  `accepted_frames`, `transcript_tail`) to a `v2_relay_tail` SQLite table via the
  shared `src/core/shadow-relay-tail.ts` serialize/hydrate seam, matching the
  CommitScopeDO. Hydrated on relay creation (`dev-server.ts` `v2RelayForScope`).
- **4a review fixes (MERGED).** Persist the tail BEFORE the client ack / fanout
  across all three dev durable entry points (WS turn, WS state-transfer, REST) —
  parity with CommitScopeDO's save-before-fanout, closing a crash window where an
  already-materialized commit could lose its idempotency reply / frame tail and
  re-commit on retry.
- **4 hardening (this work).** Added a dev-parity test for **state-transfer reply
  idempotency across relay eviction** (`tests/dev-v2-durable-turn-parity.test.ts`).
  The prior eviction test only covered the *turn-exec* reply path. The new test
  drives the WS state-transfer helper's pre-ack persist callback, then rebuilds
  the relay from SQLite and proves the cached cell-page repair reply is replayed
  from the rehydrated `recent_replies` window. This is the test the 4a finding-2
  fix (persist on the WS state-transfer branch) was missing.

## What is covered, and where

- **Reconnect catch-up (delta vs projection)** is the SHARED
  `buildShadowBrowserCatchupTransferForBrowser`; localdev calls it on WS open
  (`dev-server.ts`), and it is unit-tested directly in `shadow-browser-node.test.ts`
  (delta, multi-frame delta, projection fallback when oversized, projection
  fallback when no tail) plus a dev-parity case in `dev-v2-durable-turn-parity.test.ts`.
- **Idempotency replay** (`recently_seen` / `recent_replies` + the `fresh` check)
  is shared in `shadow-browser-node.ts`, including the in-process pruning (TTL +
  count caps `MAX_SHADOW_IDEMPOTENCY_ENTRIES` / `MAX_SHADOW_RECENT_REPLIES_ENTRIES`).
  localdev persists the already-pruned maps, so the blob is bounded the same way
  CF's SQL rows are. Covered for turn-exec AND (now) state-transfer across eviction.
- **Fanout / state-transfer routing** (per-peer-scope live events + projection
  state-transfer targets) converged in item 2 (`v2-fanout-projection.ts`,
  `planDevV2BrowserFanout`); not item-4 work.

## Explicitly DEFERRED: `checkpoint_tail.v1` in dev-server

CF's production client reconnect protocol is `checkpoint_tail.v1` — the SPA
(`src/client/v2-browser-worker.ts`) sends `open_protocol: "checkpoint_tail.v1"`
and reassembles continuation chunks. CommitScopeDO serves it
(`commit-scope-do.ts` `checkpointTailOpenResponse` → `openInitialCheckpointTailTransfer`
/ `openContinuationTransfer` / `openFrameTransfer` / `packageCheckpointTransfer`),
backed by four SQL tables (`v2_commit_scope_checkpoint`, `_checkpoint_page`,
`_checkpoint_frame`, `_accepted_frame`), checkpoint **manifests**, byte-budgeted
page/frame packaging, continuation cursors, and an async `waitUntil`
checkpoint-build scheduler (`scheduleCheckpointBuild` / `persistScopeCheckpoint`).

localdev's dev-server WS open serves only the legacy `openShadowBrowserScope`
path; it does NOT speak `checkpoint_tail.v1`. So the dev interactive reconnect and
dev-parity tests do not exercise checkpoint-tail server-side.

**Why deferred (decision 2026-06-03, with the user):** porting checkpoint_tail.v1
to dev-server is a large, tightly SQL-coupled project — not the small port the
"rest of item 4" first appeared to be — and the protocol itself is already
**worker-integration-tested**: `tests/v2-browser-worker.integration.test.ts`
covers initial transfer, frame transfer, projection-boundary, AND multi-chunk
continuation (`checkpoint-continuation-first` / `-final`), and
`tests/worker/cf-repository.test.ts` asserts the browser open requests
checkpoint/tail. The drift here is "the dev *interactive* path and dev-*parity*
tests don't run it," not "the protocol is untested."

**If converged later** (sketch, following the prior extract→prove→swap pattern):
1. Extract a storage-neutral protocol/packaging primitive from
   `checkpointTailOpenResponse` + `packageFrameTransfer` / `packageCheckpointTransfer`,
   parameterised over a frame/checkpoint *source* (CF = SQL rows; localdev = the
   in-process `accepted_frames` + a built checkpoint). Same shape as item 3's
   `object-host-write-through` abstraction.
2. Give localdev a checkpoint/frame store (could be derived on demand from the
   relay tail rather than four tables, since dev is single-process).
3. Swap the dev WS open to offer `checkpoint_tail.v1`, falling back to legacy.
4. Port the worker continuation tests into a dev-parity lane.

## Status

Item 4 done at the "targeted hardening" scope. Persistence + ordering (4a) merged;
state-transfer idempotency-across-restart test added; checkpoint_tail.v1 dev
convergence explicitly deferred with the rationale above. No spec change: all of
this is internal localdev↔CF parity, not user-visible behavior.

Remaining sequence item: #5 browser projection-holder (already largely separated;
see [[browser_divergent_holder_protocol]] / notes/2026-05-25-browser-holder-node.md).
