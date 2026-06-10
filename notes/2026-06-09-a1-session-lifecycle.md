# A1: Session Lifecycle — Investigation and Change Log

Origin: 2026-06-09, worktree `a1-session-lifecycle`.
Implements piece A1 from [2026-06-09-cf-cross-scope-architecture-plan.md](2026-06-09-cf-cross-scope-architecture-plan.md).

## Investigation map

### Session close/reap paths

1. **`world.endSession(sessionId)`** — called by:
   - `closeMcpWooSession` in `persistent-object-do.ts:4198` (on the world/gateway host)
   - `world.sessionAlive()` (on expiry check)
   - REST protocol `onSessionEnded` callback
   - REST protocol `onSessionsEnded` callback (for batch)
   - `revokeApiKey` → `closeSessionsForApiKey` → `reapSession`
   - MCP WS disconnect → `closeMcpWooSession`

2. **`world.reapSession(sessionId)`** (private) — called by:
   - `endSession`
   - `reapExpiredSessions` (timer / audit path, called at auth time and from operators)
   - `purgeInactiveGuests`
   - `closeSessionsForApiKey`
   - `closeSessionsForActor`
   - `auth()` on expired session resume attempt

3. **`reapSession` does:** clears attachedSockets, kills READ tasks, removes session
   presence, deletes from `world.sessions`, deletes from persisted storage. If it was
   the primary non-guest session, calls `promoteActorPrimaryLocation`.

4. **On the MCP shard (sparse transport world):**
   - `closeMcpWooSession` on the shard calls `world.sessions.delete(sessionId)` directly
     (not `endSession`) since the shard is not the world host. Then forwards to
     `/__internal/end-session` on the world host.
   - **Gap**: `world.sessions.delete()` bypasses `removeSessionPresence` — the shard's
     presence index is not cleaned up. Fixed by this change: shards now mark `closedAt`
     and filter it in queries.

5. **Directory unregistration** (`unregisterSessionRoute`): called from:
   - `closeMcpWooSession` after the session is ended
   - REST `onSessionEnded` / `onSessionsEnded`
   - `purgeInactiveGuests` (for each reaped session)
   - Fires best-effort (catch-all swallows errors). The Directory row persists until
     its `expires_at` if the fire fails.

6. **Shard relay cache** (`deleteLocalGatewaySessionCache`): called from
   `closeMcpWooSession` only. Deletes `gateway_projection_session` and
   `gateway_session_tool_manifest` rows. If the actor is now sessionless on the shard,
   also calls `pruneGatewayProjectionActor` to scrub object/scope rows.

### Session liveness consumers

1. **`primarySessionForActor`** — picks the oldest non-expired session. Used in:
   - `movetoActorChecked` (the physical-move gate, see below)
   - `promoteActorPrimaryLocation` (on session reap, promote the next primary)
   - `world.call` options.sessionId fallback
   - `sessionPresenceId` (for presence key when no sessionId is provided)

2. **Directory `/sessions-for-scopes`** — queries `session_route` filtered by
   `expires_at > now AND last_seen_at > now - PRESENCE_LIVE_WINDOW_MS`. Already
   excludes stale-but-unexpired rows via the presence lease. Closed sessions are
   removed by `unregisterSessionRoute` (best-effort). If the call fails, the row
   lingers until `expires_at`. With A1, world-side `closedAt` prevents stale closed
   sessions from being used locally even before the Directory row is purged.

3. **`observationAudienceActors` / fanout audience** — uses `presenceActorsIn`
   which reads `sessionSubscribersIndex` (a live in-memory index keyed by sessionId).
   `removeSessionPresence` is called from `reapSession` so this is already correct
   when `reapSession` runs. But on sparse shards, direct `world.sessions.delete()`
   skips it.

4. **`liveSessionsForActor`**, **`hasLiveSessions`**, **`actorIsConnected`**,
   **`actorLastInputAt`** — all iterate `world.sessions`, checking `sessionExpired`.

5. **`allLocationsForActor`** — iterates all sessions (including expired). Used by
   observer resolution. Already safe because expired sessions have location that was
   cleared at reap time, but with A1 we also filter closed sessions.

6. **`sessionsForScopeAudience`** (a.k.a. the Directory `sessions-for-scopes` path)
   — only sessions whose `last_seen_at` is within `PRESENCE_LIVE_WINDOW_MS` are
   returned, which is the lease-based filter. Combined with `unregisterSession` on
   close, the Directory side is already guarded. The remaining fix needed is the
   in-memory world side for shards.

### The is_primary physical-move skip

**Origin (commit 81131ef, 2026-05-04):** The multi-session model was introduced.
The design: an actor can have multiple sessions (one per browser tab, or one per
transport). Each session has its own `activeScope` / `currentLocation`. The primary
session (oldest non-expired) drives `actor.location` — the physical containment
cell. Secondary sessions can be in different rooms but `actor.location` tracks the
primary session's room. `promoteActorPrimaryLocation` is called on primary reap to
advance `actor.location` to the next primary's `activeScope`.

**Why the skip was needed (2026-05-04):** Without it, two sessions of one actor
moving independently would both fire `moveObjectChecked`, producing two concurrent
write-to-location cells that would be sequenced independently, potentially leaving
`actor.location` at whichever committed last rather than the primary's room.

**Why it is now wrong (post-CA8, commit 6880c32):** CA8 made the session
active-scope transition a first-class transcript effect
(`TranscriptSessionScopeTransition`). Every materializer (fanout, relay-cache
applier, browser holder) now applies the `session_scope` event to repair presence
projections and session rows. The `object_move` (physical location write) is
separately committed by the actor-location scope (actor's own cell). The two effects
are decoupled.

The bug: `primarySessionForActor` picks the OLDEST non-expired session. On a CF
shard that received the actor's session via Directory load (because an earlier
guest session for the same actor was registered there), the Directory session row
predates the current live session, and `primarySessionForActor` returns the old
session — making the current session `is_primary:false` and skipping
`moveObjectChecked`. The session's `activeScope` updates but `actor.location` stays
at the old room. The next verb fails `E_PERM guest_N is not present in ...`.

**The new rule:** The session executing the move *is* authoritative for the physical
move. There is no "secondary session" concept for movements. The reasons the
original restriction was needed no longer apply:

1. CA8 ensures every materializer repairs presence from the transcript's
   `session_scope` event, not from `actor.location`. The session index is
   already maintained independently of physical location.

2. The commit sequencing already serializes concurrent moves for the same actor
   (the actor's location cell is the commit scope for movement). Two concurrent
   move commits from two sessions of the same actor will serialize; the second
   one may conflict (read-version mismatch on the location cell) and repair,
   but it will NOT silently skip the physical move.

3. `promoteActorPrimaryLocation` (called on primary reap) still works: it looks
   up the new primary after the old one is reaped and advances `actor.location`
   to that session's `activeScope`. The A1 `closedAt` change ensures that
   a closed session never wins the primary election and causes spurious
   `promoteActorPrimaryLocation` no-ops.

**Safety argument for removing is_primary gate:**
- If two sessions of one actor move concurrently, both will write the
  actor's location cell in their transcripts. The CommitScopeDO serializes
  these commits; the second will get a `read_version_mismatch` and re-plan.
  Net result: the second session's physical location converges to its target
  after at most one retry. This is correct and matches the user's intent.
- A closed session that lasts in `world.sessions` momentarily (before
  `reapSession` runs) is now explicitly filtered by `closedAt` in
  `primarySessionForActor`. The winning primary is always a live session.
- The pre-CA8 concern (two sessions writing the same physical cell and
  the "wrong" one winning) is now covered by commit sequencing, not by
  a session-primary heuristic that depends on wall-clock start times and
  can be fooled by stale Directory-loaded session rows.

### Session count in Directory sessions-for-scopes

The 2.7-sessions-per-lookup average for a 2-actor run was caused by:
1. Stale MCP session routes lingering after `unregisterSessionRoute` failed
   (network error swallowed). TTL-expiry path eventually cleans them, but not
   within a smoke run (5-minute TTL for guests, 24h for bearer).
2. Multiple sessions per actor from re-connects where the old session was
   not explicitly closed before the new one opened.

A1's `closedAt` field addresses (2) on the world side. The Directory side
already has `last_seen_at` presence-lease filtering (the fix from the
`b7_smoke_rootcause_stale_presence.md` memory note). The gate test (session
count ≤ actors + 1) exercises both.

## What changed

### `src/core/types.ts`
- Added `closedAt?: number` to `Session`. Set when a session is explicitly
  closed (via `reapSession`). In-memory only — not persisted, because a
  closed session is deleted from storage immediately; the field is needed
  only transiently to guard against the small window between "marked closed"
  and "deleted from world.sessions" in async contexts.

  **Why not persisted:** Sessions are deleted from storage in `reapSession`
  via `deletePersistedSession`. The `closedAt` marker is set just before that
  call so that any code reading the session between mark and delete (e.g. in
  async iterators) sees the session as closed. Persisting it would add write
  cost for no benefit; the goal is in-memory correctness.

### `src/core/world.ts`
- `reapSession`: sets `session.closedAt = Date.now()` before clearing sockets,
  presence, and deleting from `world.sessions`. This ensures that any async
  code that held a reference to the session object sees it as closed.
- `primarySessionForActor`: added filter for `session.closedAt !== undefined`.
- `movetoActorChecked`: removed the `is_primary` gate on the physical move.
  The current session always executes the physical move. Left the
  `moveto_actor` metric event intact (it now always has `is_primary: true`),
  with updated comment explaining the CA8 rationale.
- `allLocationsForActor`: added filter for closed sessions.
- MCP shard path `closeMcpWooSession`: changed `world.sessions.delete(sessionId)`
  to call `world.markSessionClosed(sessionId)` (new thin public method) so the
  shard's in-memory presence index is also cleaned up.

### New: `tests/session-lifecycle.test.ts`
- Test: actor with a stale/closed earlier session + fresh session performs a
  move → physical move happens, no E_PERM, location == activeScope.
- Test: 2 actors, sessions opened and closed → sessions-for-scopes-equivalent
  returns ≤ actors + 1 live sessions at any point.
- Test: primarySessionForActor skips closed sessions.
- Registered in the curated `npm test` list.

## Adjacent bugs found
- MCP shard `closeMcpWooSession` used `world.sessions.delete(sessionId)` directly,
  bypassing `removeSessionPresence`. This is now fixed via `markSessionClosed`.
  The shard worlds are deliberately sparse (no owned objects), but their
  `sessionSubscribersIndex` is consulted when building the fanout audience
  on that shard. A session that was never presence-removed would keep showing
  up in the audience until the next reap cycle.

## Post-mortem: DELETE-resume regression (fixed)

The original A1 change made `closeMcpWooSession` call `markSessionClosed`,
which runs `removeSessionPresence` + `removeActorActiveLists` on the gateway
shard world. Those walkers mutate every cached object carrying a
`session_subscribers`/`operators` row — including tool-space rows the shard
merely caches (e.g. `the_pinboard` after a tool-scope connect). On a DO
world, `setProp`/`updateSpaceSubscriberLocal` write through to the durable
repository, which rejects non-hosted objects with
`E_OBJNF "object not hosted here: the_pinboard"` (cf-repository.ts ~714).
The exception aborted `closeMcpWooSession` BEFORE the `/__internal/end-session`
forward and `unregisterSessionRoute`, so the Directory kept the registration
and a request with the closed MCP session id resumed successfully
(tests/worker/cf-local-walkthrough.test.ts:310).

Fix: `sessionCleanupOwned(id)` — close-path cleanup only durably mutates
objects whose durable home (`hostKeyForObject`) is this world's
`executorContext.localHost`; single-host worlds own everything. This mirrors
the projection-apply `hostKey` guard. Skipping cached copies is correct:
the owning host runs the same cleanup in its own reap, dead sessions are
excluded from audiences by liveness regardless of stale cached subscriber
rows, and cached rows converge on the owner's next fanout update.

Race-cluster connection (the nondeterministic cf-dev 7/13 collapse with
E_PERM/E_NOSESSION on peer steps): the same throw fires on ANY shard close
after a session touched a tool space — the C3 tool-surface step plants
exactly such rows — leaving sessions half-closed (gateway map entry removed,
world/Directory state inconsistent). With the throw gone, the close path
always completes; the cluster should disappear from cf-dev. If any residual
flake remains it needs fresh evidence, not this mechanism.

Process note: this regression escaped because the original validation skipped
`npm run test:worker`. Worker-lane tests are mandatory for any change
touching `src/worker/` or session lifecycle.
