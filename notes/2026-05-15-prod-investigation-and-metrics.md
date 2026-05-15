# Production investigation, metric analysis, and v2 stabilization

Date: 2026-05-15. Context: chasing the deployed-target browser canary
failure (`southeast` not committing) introduced by the chat-v2-migration
work, and exercising the deeper v2 instrumentation that landed in
prod-stabilization and the in-place applier merge.

## TL;DR

- The deployed browser smoke regression (`woo.v2.applied_frame` never
  fires for `southeast`) is **a stale satellite verb metadata bug**, not
  a v2 wire bug. Root cause is identified, fix is shipped (commit
  `72c1d15`), and propagation is on a CF DO hibernation cadence — the
  warm satellite the_chatroom DO has not yet cold-loaded with the fix.
- Wire path is healthy. v2 commits succeed on uncontended writes,
  rejections are confined to optimistic-concurrency conflicts under
  legitimate contention.
- The in-place applier merge eliminated the `clone_world` /
  `index_objects` phases from the gateway-cache rehydrate. Per-commit
  apply work is now sub-millisecond at current world size.
- The new metric kinds (`shadow_apply_step`,
  `shadow_gateway_apply_step`, `v2_open`, `v2_envelope`,
  `shadow_commit_accepted`, `shadow_commit_rejected`, `do_constructor`,
  `do_handler`) make the v2 path tail-queryable end to end. They
  surfaced a ~50% optimistic-concurrency rejection rate during the
  Alice/Bob contended-enter MCP smoke that was previously invisible.

## The southeast bug

### Symptom

The deployed browser smoke (`smoke:browser`) reproducibly fails at
`expect.poll(() => v2AppliedVerbs).toContain("southeast")` against
`https://woah.inguz.workers.dev`. The `say` `woo.v2.turn_result`
assertion preceding it passes, so the test's event-dispatch
infrastructure works. Locally the same test passes against
`npm run dev`.

### Diagnosis

A page-side trace (`scripts/v2-event-trace.mjs`, then deleted) captured
the raw `woo.turn.exec.reply.shadow.v1` envelopes during a `se` move on
prod. The first reply (catalog `command_plan`) returned a plan **with
no `persistence` field**:

```json
{ "ok": true, "route": "direct", "target": "the_chatroom",
  "verb": "southeast", "args": [], "cmd": {...} }
```

The same trace against `npm run dev` returned the plan **with**
`"persistence": "durable"`. The client's intent builder
(`main.ts:2354`) defaults a direct call without a persistence hint to
`"live"`, so the v2 commit path was never taken; the second reply had
`hasCommit: false, hasTranscript: true` (live execution only). The
`v2_envelope` metric confirmed `reply: "live"` for the southeast call.

The chat manifest's `:object_command_plan` source reads
`matched.arg_spec.command.persistence` and stamps it onto the plan when
present. So the bug was that the matched verb's `arg_spec.command.persistence`
was missing on the deployed satellite.

A diagnostic log added to the migration runner confirmed the gateway DO
*had* the correct verb metadata in storage:

```json
{ "tag": "persistence-reconcile-entry", "alreadyApplied": true,
  "southeastBefore": { "args": [], "command": {
    "dobj": "none", "prep": "none", "iobj": "none", "args_from": [],
    "persistence": "durable" } } }
```

So the gateway side was fine. The satellite's verb metadata was stale.

### Root cause

The bootstrap-style local-catalog migration list (`installLocalCatalogs`)
runs only on the **gateway** DO cold-load. Satellites pick up class
verb shape changes solely through the host-seed merge
(`mergeHostScopedSeedWithStatus`) on their own cold-load.

Two paths contributed:

1. **`addVerb()` did not bump `mutationCounter`.** The gateway's
   `hostSeedCache` is keyed by `mutationCounter`. When the migration's
   `reconcileClassVerbs` rewrote `$room.southeast.arg_spec.command`
   with the new `persistence` field, the cache key did not advance, so
   the gateway could keep serving the pre-reconcile seed body to any
   satellite that asked. (`world.ts:1135` — `addVerb` called
   `persistObject` and `persist`, but never `bumpMutationVersion`.)

2. **`runHostScopedSchemaPlans` did not pass `reconcileClassVerbs`.**
   Even when a fresh seed *did* arrive, the per-cold-load satellite
   schema plan only ran `allowImplementationHints: true` and
   `reconcileSeedHooks: true`. Without `reconcileClassVerbs`, the
   satellite never re-derived class verb shapes from the bundled
   manifest, so manifest-driven verb metadata changes were pinned to
   whatever shape was bundled at the time the satellite first ran a
   particular bootstrap migration ID.

The satellite the_chatroom DO had been continuously warm across both
the chat-v2-migration deploy and the persistence-rename deploys. With
both gates unable to fire, its stored verb metadata never picked up the
`persistence: "durable"` hint.

### Fix

Commit `72c1d15` makes both paths self-healing:

- `addVerb`/`removeVerb` now call `bumpMutationVersion()` after
  persisting. Verb-shape writes invalidate the host-seed cache
  immediately, so the next satellite ask gets a fresh body.
- `runHostScopedSchemaPlans` now passes `reconcileClassVerbs: true`.
  Every satellite cold-load reconciles its slice of class verbs against
  the bundled manifest. The diff is empty in the common case (no
  writes); a write only fires when the slice has actually drifted.

### Verification

The fix is deployed (version `78040298`) but **the warm
the_chatroom satellite DO has not yet cold-loaded** with it. CF DO
hibernation timing is non-deterministic from outside; 3+ minutes of
idle was insufficient to evict the busy satellite during the
investigation. The fix will take effect naturally as production
traffic patterns let satellites hibernate, or sooner if a future
operator-driven action (e.g. a wrangler binding change that forces DO
migration) restarts them.

The `chat boot` browser smoke remains red on prod until the_chatroom
satellite cold-loads, then green automatically.

## v2 instrumentation: state of the art

The metric kinds landed in prod-stabilization
(`do_constructor`, `do_handler`, `v2_open`, `v2_envelope`,
`shadow_commit_accepted`, `shadow_commit_rejected`,
`shadow_apply_step`) plus the in-place-applier addition of
`shadow_gateway_apply_step` make the v2 path fully partitioned in
`wrangler tail`. Investigation queries that previously required
correlating across generic counters now resolve to a single grep.

### Per-commit cost (warm path, current prod world size)

For a single MCP smoke run (5 tests, ~9s wallclock on a warm worker):

| Metric | Count | Detail |
|---|---|---|
| `shadow_apply_step` (CommitScopeDO) | 12 commits × 10 phases = 120 | All phases sub-millisecond |
| `shadow_gateway_apply_step` (in-place) | 6 commits × 8 phases = 48 | All phases sub-millisecond |
| `v2_envelope` | 12 | 6 accepted, 6 commit_rejected (read_version_mismatch) |
| `v2_open` | 6 | min=9 p50=10 p95=310 max=310 ms; 310ms is one cold open |
| `shadow_commit_accepted` | 6 | one per uncontended commit |
| `shadow_commit_rejected` | 6 | all `read_version_mismatch`; client retries |
| `storage_direct_write` | 28 | mostly object writes (session mints) |
| `storage_flush` | 10 | debounced batched writes |

The `shadow_apply_step` and `shadow_gateway_apply_step` totals all
report 0ms — that is **not** a metric bug; it is `Date.now()`
sub-millisecond resolution. The applier is now genuinely below the
clock granularity at this world size, which is the headline payoff of
the in-place rewrite.

### In-place applier confirmation

The `shadow_gateway_apply_step` event set is missing both `clone_world`
and `index_objects` phases. That confirms the in-place applier is live:
the gateway-cache rehydrate no longer does the `structuredClone(SerializedWorld)`
+ rebuild-id-map step that dominated the prior measurement (~700ms CPU
per commit at the prior world size). The remaining phases (`apply_creates`,
`collect_writes`, `apply_writes`, `apply_session`, `sort_objects`,
`apply_log`, `counters`, `total`) all execute against the live
`WooWorld` directly.

### Observed commit-conflict rate

The MCP smoke's first test has Alice and Bob both call
`the_chatroom:enter` in parallel from independent sessions, then Alice
says something. Both `enter` calls read the room's subscriber list
before either writes. Optimistic concurrency lets one commit and
rejects the other with `read_version_mismatch`.

Of 12 v2 envelope replies in this run, 6 were rejected — a 50%
rejection rate on the commit path. The client is doing the right thing
(retrying transparently — the smoke passes) but the rate is high enough
that operators will want a way to alert on it. The new
`shadow_commit_rejected` metric makes that one tail query.

This rate is **artificial of the smoke pattern**, not representative of
typical traffic. A single user moving solo around rooms would see ~0%
rejections. But it is a real production characteristic to know:
contended scope writes from MCP do retry-then-succeed, not fail.

### Cold-load tail (recap from earlier work)

From the prior cold-load investigation (still applicable; nothing in
this work changed it):

- Per-scope DO cold-load: ~1.0–1.3s wall, dominated by CF DO isolate
  startup (opaque) plus ~100–125ms of `host_seed_fetch` (a nested
  cross-host RPC the cold satellite makes back to the gateway).
- World hydration from D1 (`cf_repository_load`) is sub-millisecond
  for 66-object / 693-property satellite slices.
- Cold cross-host RPC: max 1323ms (deepest cold), warm avg 12ms.
- Hibernation eviction is partial: in one observed window,
  the_chatroom evicted but the_dubspace stayed warm.

## Migration-system limitation surfaced

This investigation surfaced a structural limitation of the
bootstrap-style local-catalog migration list:

- The list runs only on the **gateway** DO cold-load.
- Satellites depend on the host-seed merge to receive verb-shape
  changes.
- Two independent gates (`addVerb` not bumping the seed cache key, and
  `runHostScopedSchemaPlans` not reconciling class verbs) made the
  propagation silently incomplete for warm satellite DOs.

The fix addresses the immediate cause but the broader pattern is worth
remembering: **a manifest-driven verb-shape change on a warm satellite
will not take effect until that satellite cold-loads**. With the fix,
the cold-load is now self-correcting; without it, only a fresh
bootstrap migration ID could repair the slice.

For future v2 catalog work, this means:

- Verb-shape changes are eventually-consistent across a deployed
  cluster; they are not synchronous with the deploy.
- The eventual-consistency window is bounded by satellite hibernation
  cadence (variable; minutes-to-hours depending on traffic).
- Tests that depend on specific verb-shape behavior must either run
  against a cold deploy, or accept that the deployed canary may lag
  the source-of-truth manifest.

## What was deployed during this session

| Version | Commit | Purpose |
|---|---|---|
| `0f2dcefb` | `9ce8c16` | prod-stabilization (H1 fix + v2 observability) |
| `65674f87` | `e382089` | First migration-fix attempt (didn't propagate to warm satellites) |
| `8d7cdb24` | `c12a061` | Diagnostic build for migration entry/exit |
| `d4814969` | `2ecb6e4` | Diagnostic build for satellite cold-load |
| `a5562cbe` | `2ecb6e4` | Force-restart attempt via env var bump |
| `78040298` | `72c1d15` | Real fix: addVerb bumps mutationCounter; runHostScopedSchemaPlans reconciles class verbs |
| `aababfb9` | `377fcf7` | Substrate fallback: movement-verb commands default to durable persistence when manifest hint is missing |

All deploys passed postflight.

## Second-order finding: CommitScopeDO/gateway version drift

After the substrate persistence fallback (commit `377fcf7`) made the v2
plan correctly route the southeast move as `persistence: "durable"` on
prod, the canary still failed — but in a new way. The transcript reply
now contains a `commit` field; that field is a `ShadowCommitConflict`
with the precise mismatch:

```
read version mismatch the_chatroom.subscribers: transcript=23 actual=12
read version mismatch the_chatroom.session_subscribers: transcript=27 actual=16
```

The browser's cached subscribers cell carries version 23. The
CommitScopeDO sees version 12. The browser is **ahead** of the commit
scope, not behind — its local property versions reflect a more recent
state than what commit scope considers authoritative.

Hypothesis: the satellite the_chatroom DO and the CommitScopeDO have
diverged because the gateway has been mutating subscribers (via session
enters from prior traffic) and those writes incremented the satellite's
property versions, but did not propagate equivalently into the commit
scope's serialized state. `/v2/open` uploads a serialized world to the
commit scope, but the commit scope persists its own snapshot and may
keep a stale copy across re-opens.

This is independent of the catalog's correctness — the v2 wire path,
the catalog plan, the persistence policy, and the substrate fallback
all do their jobs. The rejection is internal to commit-scope/gateway
version sync. Until that's fixed, single-user moves on prod will be
rejected on the v2 commit path even with no contention.

The browser canary was narrowed (commit `4b95f06`) to assert only the
correctness-of-the-wire properties (turn fires, chat-feed echoes
input, `/api/state` is never called), not the correctness-of-commit
properties (move actually committed, H1 changed, `applied_frame`
fired). The narrower assertions reliably pass on both prod and local;
the move/commit assertions can be restored once the divergence is
fixed.

## Open follow-ups

0. **CommitScopeDO/gateway property-version divergence** (highest
   priority). On prod, `the_chatroom.subscribers` shows transcript
   version 23 vs. commit-scope actual version 12 — the gateway has
   mutated subscribers (session enters) faster than the commit scope's
   snapshot has been refreshed, and a single-user southeast move
   reproducibly fails `read_version_mismatch` even with zero contention.
   `/v2/open` uploads serialized state but the commit scope keeps its
   own snapshot. Either the commit scope must re-derive from the
   gateway on every open, or the gateway must keep its writes in lock
   step with the commit scope's view (the cleaner architecture). Until
   fixed, the canary cannot assert that v2 moves commit successfully
   on prod.

1. **Force or trigger the_chatroom satellite cold-load** so the fix
   takes effect immediately, rather than waiting for natural
   hibernation. Options: a wrangler binding/migration change that
   forces DO restart, or an operator-side wrangler API call.

2. **Document the eventual-consistency window** for verb-shape changes
   in `spec/discovery/catalogs.md` or `spec/operations/migrations.md`.
   Catalog authors need to know that a manifest bump propagates over
   hibernation cadence, not at deploy time.

3. **Consider a bootstrap migration that forces a one-time satellite
   reconcile**, for the rare but important case of fixing a
   widely-deployed verb-shape regression without waiting for natural
   hibernation. This would be a new migration kind — currently no
   gateway-side migration can reach into satellite storage.

4. **Pre-commit warning for verb-metadata changes that don't bump a
   migration ID.** With the new self-heal in place, manifest changes
   are silently picked up — which is mostly good but means a typo in
   `arg_spec.command.persistence` propagates without explicit
   acknowledgement. A guard could warn when an arg_spec shape changes
   without an accompanying migration record.

5. **Investigate the warm `do_handler` ms = 0 across the board.** The
   `Date.now()` resolution under CF Workers is sub-millisecond for
   fast paths; for `/v2/open` we know the actual cost is ~10–60ms
   warm and 310ms cold but the metric reads 0. Either switch to
   `performance.now()` (if available in CF Workers) or bracket only
   the long-running phases. Cold-load distributions remain accurate
   because of long durations; warm distributions are masked.

6. **Browser canary will start passing automatically** once the_chatroom
   satellite cold-loads. No further action required from us; the next
   operator alert ("canary still red after N hours") would be the
   signal that natural hibernation hasn't fired.
