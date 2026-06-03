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

## Projection-mode parity — partition extracted, branch deferred (2026-06-03)

`projectionWritesByHost` is now shared: `partitionProjectionWritesByHost(writes,
scope, fallbackHost, resolveHost)` in `object-host-write-through.ts`, and CF's
`PersistentObjectDO.projectionWritesByHost` delegates to it (byte-identical;
test:worker 202). This is the partition half of projection-mode parity, ready for
localdev to use.

**localdev projection-mode branch is NOT landed.** Attempted it (localdev
branching on `commit.projection_delta` → `world.applyProjectionWrites` fan-out)
and surfaced two real latent issues to fix first:

1. **`applyProjectionWrites` sessions clobber live sockets.** `hydrateSession`
   always resets `attachedSockets`/`lastInputAt`; a sessions projection write onto
   a live session would drop the open WS. Needs: preserve live runtime state when
   the session already exists, before localdev can use projection-mode.
2. **`mergeScopedProjectionObject` drops created members from contents.** It
   rebuilds `contents` from `existing + contents-writes + moves` but never adds
   `creates` whose `location` is the container (only `children` for
   `create.parent`). A created note/item is missing from its room's contents
   projection on a host materializing via projection rows. Latent CF-relevant bug.

**Validation blocker:** the e2e that would prove projection-mode parity for object
creation — `pinboard shares created notes…` / `outliner shares committed items…`
— is **pre-existing-failing on main** (`062b2fb` and `f86a2b0`), in transcript
mode, before any of this work. It cannot currently distinguish a projection-mode
regression from the standing breakage. That cross-user tool-space sharing failure
should be triaged (real bug vs stale/flaky — these e2e are not in
`npm test`/`test:full`) before landing projection-mode parity.

- **Route lag.** `resolveHost` is static in localdev; a time-of-check/time-of-use
  route change mid-fanout is not yet simulated. The `onRemoteForward` hook is the
  place to add it.

## Gates

typecheck clean · npm test 356 · test:worker 202 · gate:authority stable ·
test:full 1451 · e2e se gates pass · new tests/object-host-write-through.test.ts (5).
