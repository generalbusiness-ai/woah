# Net presence-roster scaling: who_all E_BUDGET at 30 occupants (2026-07-12)

The isolated deployed canary (`woah-net-canary`, 8 shards) surfaced a real
deploy-only net-scaling limit that the workerd-local lanes cannot show. This is
the canary doing its job. Two findings, one blocking gate #2, one informing #3.

## Finding 1 (gate #2 blocker): who_all's roster build is O(occupants) RPCs

`load:net-canary --actors 30 --enforce-who`: all 30 `who_all` turns failed
`unreachable` (the check reports `partial:true` via `unreachable`, NOT a
missing-roster `max_missing` — the roster would be complete; the turns die
building it). A single-guest `who_all` **succeeds** with a correct roster.

**Exact mechanism (traced to the line):**
- `who_all` (bootstrap.ts `PLAYER_WHO_ALL_SOURCE`) builds each roster row with
  `session_metadata(who)` + `location(who)` + `who.name` per co-present actor.
- `who_all` already declares `readsRoomPresence: true`, so
  `presencePlanningCells` (gateway-do.ts:3224) seeds each co-present actor's
  `session` + `object_live` + `object_lineage` from the presence-row bodies →
  `session_metadata` and `location` are **local** (no RPC). Good.
- **`who.name` is the sole remaining per-actor RPC.** The name lives in
  `object_lineage` (bridge.ts:17 `{parent, owner, name, ...}`), and
  `presencePlanningCells` *does* seed `object_lineage` — **but only if the
  presence-row body carried `actor_lineage`**, and it usually does NOT:
  - The body is derived at `relations.ts:100` from `applied.post`
    (`scope.ts:519`), which is the **room** scope's post-state.
  - `enter` writes `object_live` (location) but NOT `object_lineage` (identity
    is unchanged), and the actor's `object_lineage` lives at the actor's
    **cluster** scope — so `post.get(object_lineage:actor)` (room scope) misses
    it, `actor_lineage` is dropped, the name isn't seeded, and `who.name` RPCs.
  - `actor_live` (location) IS captured because `enter` writes it → the body
    reliably carries location but not name. Matches the observed behavior.
- Net: N co-present actors → N `who.name` RPCs. At 30 that exceeds the 32-RPC
  per-turn budget (`E_BUDGET`), 100% of the time.

**The fix (bounded, but real cross-layer work — do carefully + canary-verify):**
Carry the actor's `object_lineage` into the presence projection so `who.name`
is local. The value is available where `object_lineage` cells exist — the
net planning world during the `enter` turn (the gateway read it) — but NOT at
the scope-DO derivation point (`applied.post` is room-scoped, and
`transcript.reads` are `{key, version}` without values). So the plumbing is:
capture `object_lineage:actor`'s value in the net plan/submit path for a
session-scope transition, thread it onto `transcript.sessionScopeTransition`,
and use it at `relations.ts:103` (`transition.actor_lineage ?? post.get(...)`).
`presencePlanningCells` already seeds it → `who.name` becomes local → O(N)
local reads, no RPC. Add a targeted net test that a co-present peer's name is
served without a cross-scope pull. (Capturing only the name is unsafe — seed
the FULL lineage {parent, owner, name, anchor, flags} or `isa`/parent reads on
the seeded actor break.)

## Finding 2 (gate #3 scale evidence): rooms are RPC-hot at 30 occupants

The same run: say/look had **29/630 E_BUDGET (~5%)** with `sync_rpc` 22–32 —
i.e. even plain turns approach the budget at 30 occupants, and `enter` on a
room with ~30 presence rows measured **31 sync_rpc**. So room operations carry
an O(occupants) cross-DO RPC component at scale (fanout audience and/or presence
reconstruction), independent of who_all. This is exactly the ">30-occupant
room" measurement gate #3 calls for, and it shows a real ceiling: the current
net path is marginal at 30-occupant rooms and needs the O(occupants) per-turn
RPC component reduced before large rooms are supported. Separately, the driver
should surface the who_all turn's error CODE in `who_partial_view` (it currently
only says `UNREACHABLE`), and distinguish `unreachable` (turn failed) from
`partial` (roster incomplete) in its message.

## Status
- Prod: unaffected — `dece153` deployed, net OFF; this is canary-only.
- Canary `woah-net-canary` is LEFT UP for iterating the fix.
- Gate #2 (`--enforce-who`) is NOT passing on real hardware until Finding 1 is
  fixed; Finding 2 is a genuine gate-#3 scale limit. Neither is a regression —
  the O(N) per-actor read predates #2; the RPC-hot-room cost is the net path's
  known cross-scope amplification at scale.
- These are real net-presence/scale fixes, not quick tweaks; they deserve a
  careful, canary-verified implementation pass (cf. the item-4B lesson: a
  rushed presence-adjacent change regressed 5 tests).

## Fix attempt (2026-07-12) — REVERTED; it proved the problem is deeper

Attempted Finding-1's fix: carry the actor's `object_lineage` in the presence
body (capture at plan time in `foldSessionEffects`, thread onto
`transcript.sessionScopeTransition`, consume at `relations.ts:103`) so
`presencePlanningCells` seeds it and `who.name` reads locally. Built,
typechecked, net tests 178/178, deployed to an isolated canary, installed
CLEAN, ran `--enforce-who` at 30 occupants:

- **`responders` 0 → 6**: the fix worked directionally — 6 `who_all` turns now
  fit the RPC budget (name is local). Genuine progress.
- **But 24 still `E_BUDGET`**, and the 6 that succeed see only **18/30**
  (`max_missing: 12`). Reverted — for two decisive reasons:

**Reason 1 — it fights the envelope design.** `plan.ts:252`
(`WARM_ENVELOPE_BYTE_LIMIT = 64 KiB`) treats an oversized envelope as a
*misplan bug*: "shrink the read closure, do not raise the ceiling." My fix
FATTENS the read closure (a full `object_lineage` per occupant), and
`presencePlanningCells` already materializes O(occupants) cells
(session+live). On the polluted room (~90 accumulated stale rows) `enter`
itself threw `E_INTERNAL: oversized warm envelope`. Per-occupant
materialization is the wrong axis — the roster read must be **compact**.

**Reason 2 — a THIRD finding the fix exposed: cross-shard presence is
incomplete.** The 6 successful `who_all` turns saw 18/30. The room's
owner-anchored `session_presence` rows are NOT fully replicated into every
gateway shard's mirror, so a shard's `active_actors(room)` sees only the
subset it has fanned — a CO13 completeness gap (gateway-do.ts:3221 claims the
relation is "complete across gateway shards"; the canary shows it is not at
30 occupants across 8 shards). Even a perfectly-cheap `who_all` would return a
partial roster.

## Corrected fix direction (a real project, not a tweak)
Closing `--enforce-who` needs all three, and none is a quick change:
1. **Compact room-roster projection** — a single owner-maintained cell per
   room carrying `[{actor, name, presence, idle}]` for occupants (O(1) cells,
   O(N) data, one read), replacing both the per-actor `who.name` RPCs AND the
   per-occupant `presencePlanningCells` materialization. Fits the 64 KiB
   closure and the "shrink the read closure" rule.
2. **CO13 cross-shard presence completeness** — every gateway shard's view
   must hold the room's FULL presence (owner fanout / pull-on-miss), or `who`
   is partial by construction. The canary's 18/30 is the concrete gap.
3. **Stale-presence reaping** — closed-session rows must be removed promptly,
   or accumulated presence oversizes the envelope regardless (the ~90-row
   `E_INTERNAL`).

Net: gate #2 (`--enforce-who`) is a genuine net-presence-architecture work
item (compact projection + cross-shard completeness + reaping), not a
`who_all` DSL tweak. The isolated canary is the validation harness for it.
Prod is unaffected throughout (`dece153`, net OFF).

## Implemented correction (post-`bd33f47`, pending deployed confirmation)

The implementation follows the measured constraints but does **not** persist a
second roster cell. The room's owner-sequenced `session_presence` family is
already the projection authority; `POST /net/room-roster` reduces it to one
compact value at read time. Persisting the reduction would add another durable
write/rebuild contract while the response remains O(occupants) bytes.

- `who_all` consumes the generic `room_roster(space)` builtin. Net planning
  installs one transient owner snapshot, so no per-occupant actor
  lineage/session/live cells enter the read closure. Non-net worlds fall back
  to their complete local session table.
- A gateway fetches the snapshot directly from the room authority, never its
  asynchronously replicated mirror.
- An accepted session transition is synchronously expedited to the room owner
  under the same `(from_scope, seq)` idempotency identity as the durable outbox.
  This closes the enter-reply → immediate-who race; the outbox remains recovery.
- Snapshot reduction excludes expired session values. Explicit close and the
  existing alarm reaper continue to retract the durable owner rows locally or
  through `/net/relate`. Self-renames refresh the same presence row through the
  relation derivation path, avoiding transition-time stale display names.

Local evidence now includes a no-deferred-drain cross-gateway test and a
30-occupant planner test: complete result, no per-actor transcript reads, and
the normal 64 KiB envelope ceiling unchanged. The deployed 30-actor
`--enforce-who` canary remains the acceptance decision.

### First deployed iteration (`d09e824`)

The isolated canary proved the owner projection itself: 30/30 responders on
all eight gateway shards saw the complete 30-person roster (`min_seen=30`,
`max_missing=0`, no unreachable responders), and 22 elastic guests provisioned.
It also exposed a remaining superstructure caller: `$room:room_roster` and
`$room:look_self` still used `active_actors` and per-actor dereferences. The
30 concurrent setup enters produced 29 `E_BUDGET` responses; a 10-person
control also produced oversized envelopes. Chat 0.2.13 now adapts the generic
compact builtin for `room_roster`, `look_self`, `who`, and `enter`. The load
report also separates `enter` from sustained `load` outcomes so the two failure
classes cannot be conflated again. A fresh-namespace redeploy is required for
the final acceptance decision.

### Second deployed iteration (`a75189e`) and movement diagnosis

A fresh namespace with chat 0.2.13 accepted all 600 sustained say/look turns
for 30 guests and returned the complete 30-person roster to every responder
(`min_seen=30`, `max_missing=0`; 22 elastic guests). The remaining 29/30 setup
failures were isolated to `enter`, not the compact roster or sustained room
load.

An alternate-room probe disproved the initial "redundant same-room setup"
hypothesis: 26/30 real moves completed, four reached `E_BUDGET`, and the roster
split exactly matched the four actors correctly left in the source room. A
single later move also exhausted 29 synchronous RPCs. Cloudflare trace showed
repeated owner closures returning relation rows but zero cells for the legacy
presence properties.

The cause was a one-write-path violation in planning. `movetoActorChecked`
recorded the authoritative session transition but also called the local
subscriber-mirror updater before the transcript settled. That updater read
`session_subscribers` and `subscribers`, so the submit treated derived relation
projections as authority-cell reads. Targeted repair could never manufacture
those cells and repeated until the 32-RPC cap.

The first correction made recorded movement emit only the session transition;
materialization already derives both compatibility mirrors from that accepted
fact. Direct/local movement keeps eager mirror maintenance. Its deployed probe
still failed, which exposed a second reader in the same bug family:
`observe_to_space` fetched remote subscriber mirrors to stamp an
`_audience_override` before recording both the source-room and destination-room
observations. Recorded observations now carry the owner space and let owner-side
fanout derive the audience from `session_presence`; direct cross-host calls keep
the eager override because they have no accepted owner-side materialization.
Roster prefetch uses a shared receiver's authority for room verbs and the
session active room for actor verbs, derived from topology rather than verb
names. Focused cross-room and v2-browser tests assert the transition,
destination roster, and absence of both legacy projection reads. Deployed
confirmation is still required.
