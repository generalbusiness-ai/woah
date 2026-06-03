# Object-host write-through seam (localdev ↔ CF alignment, item 3)

Reduce the gap between localdev's synchronous local materialization and CF's
object-host write-through, so localdev catches the practical CF failure modes
(internal apply, timeout/retry, partial fanout) without requiring Cloudflare.

## The seam

New `src/core/object-host-write-through.ts`: `fanOutHostWrites<TSlice>()`. It owns
the part identical across runtimes:

1. apply the **local** host's slice (`applyLocal`),
2. **forward** every other host's slice concurrently (`forwardRemote`, `Promise.all`),
3. emit the `v2_host_apply_fanout` metric,
4. throw `E_RETRY` if any forward fails — never a silent partial accept.

It is parameterised over the per-host *slice*: the whole `EffectTranscript` in
transcript mode, that host's `ProjectionWrite[]` in projection mode. Each caller
keeps its own **partition** (host resolution) and supplies apply/forward, so the
runtime-specific transport stays in the caller.

## Callers

- **CF** (`src/worker/persistent-object-do.ts`): `writeThroughV2CommitToObjectHosts`
  and `writeThroughProjectionWritesToObjectHosts` are now thin partitions
  (`resolveObjectHostForWorld` / `projectionWritesByHost`) that call
  `fanOutHostWrites` with the real transport: `runShadowApply` /
  `applyProjectionWrites` for local, `forwardInternalChecked` (DO RPC, 30s
  timeout) for remote. Behaviour is byte-identical (test:worker 202 green).

- **localdev** (`src/server/dev-v2-helpers.ts` `materializeDevV2CommitLocally`):
  now async; the scope's host plays the "local" DO and every other touched host
  is reached through an in-process forward. An optional `onRemoteForward(host)`
  hook lets tests inject RPC-style failures. All call sites await it
  (dev-v2-helpers ×2, dev-server ×1, tests).

## What localdev now exercises (previously CF-only)

- Local-apply-then-forward ordering and the forward step itself.
- A forward failure → `E_RETRY` (timeout/rejection contract).
- Partial fanout: local host materialized, a remote forward throws → `E_RETRY`
  with the local slice already applied (the "accepted but write-through partially
  failed, retry" shape). See `tests/object-host-write-through.test.ts`.

## Deliberately deferred (follow-ups)

- **Projection-mode parity in localdev.** localdev still materializes in
  transcript mode (`applyCommittedShadowTranscriptToHost`) even when the commit
  carries `projection_delta`; CF takes the projection-writes branch. Aligning
  localdev to branch on `projection_delta` (and sharing a `projectionWritesByHost`
  partition) would exercise per-host projection routing locally. Bigger change to
  materialize semantics — left for a follow-up.
- **Route lag.** `resolveHost` is static in localdev; a time-of-check/time-of-use
  route change mid-fanout is not yet simulated. The `onRemoteForward` hook is the
  place to add it.

## Gates

typecheck clean · npm test 356 · test:worker 202 · gate:authority stable ·
test:full 1451 · e2e se gates pass · new tests/object-host-write-through.test.ts (5).
