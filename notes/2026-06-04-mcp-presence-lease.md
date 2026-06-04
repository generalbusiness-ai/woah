# 2026-06-04 — MCP presence lease (bound the fanout/authority audience)

Branch `mcp-presence-index`, from `main` (082c32e, B7 merged). Follow-on from
the b7-authority-warmfill smoke review.

## Symptom

`deploy-15942b1` CF smoke: 1/3 steps, then HALT. alice `enter` 12s (pass), bob
`enter` >20s timeout → session reset cascade → `E_NOSESSION`. Cold turn wall
~15–20s: `ensure` 61%, `submit` 38%, `authority` only 1% (B7's pre-plan refresh
removal worked).

## Root cause (verified in tail + code)

Stale/over-broad Directory presence, NOT inherent cold-start:

- `directory_sessions_for_scopes` returned **26 sessions** for a 2-actor smoke
  (+ 3× 5s `E_TIMEOUT`). `mcp_fanout`: `shards:16, audience_session_shards:17,
  scoped_shards:0, subscriber_shards:0` for one observation.
- `expires_at` is the **auth-validity gate** (apikey/bearer = 24h;
  `resolve-session` deletes+invalidates on expiry). The true recency signal
  (`lastInputAt`) lives only in per-shard memory, never in Directory. So
  `/sessions-for-scopes` could only filter on the 24h lease → 26 stale rows.
- `enter` is `reads_room_presence:true` (it returns `roster: room_roster()` →
  `active_actors()`), so its `directorySessionScopes` pull routes through
  `loadDirectorySessionsForScopes` → `/sessions-for-scopes`, dragging all 26
  into the commit authority. The fanout then woke one cold gateway shard per
  distinct session (`stableHash(sessionId)%32`).
- The 94 cold `PersistentObjectDO` constructors were largely a *consequence* of
  waking 16–17 shards, not a fixed tax.

## Fix — presence lease (oracle-guided)

Implement A "as a presence lease, not persisted lastInputAt": a coarse
Directory routing field refreshed only by valid client ingress.

- `session_route.last_seen_at` (idempotent ALTER + backfill from `updated_at`;
  presence-window index). `expires_at` stays purely auth; `resolveSession`
  gates on it alone.
- `/sessions-for-scopes`, `/mcp-shards-for-scopes`, `/mcp-sessions-for-shard`
  also require `last_seen_at > now − PRESENCE_LIVE_WINDOW_MS` (5 min =
  `IDLE_PRESENCE_LIVE_WINDOW_MS`).
- Refreshed only by client ingress: `register-session` carries `touch_presence`
  (default true; `DELETE`/aborted already excluded before the call). Internal
  re-registration must pass `touch_presence:false` → preserves a stale row's
  lease (can't self-refresh). Touches are throttled twice: a gateway-local W/2
  cache avoids a pre-dispatch Directory RPC on every established MCP request,
  and Directory's durable W/2 throttle keeps the dedupe write-storm protection
  across DO lifetimes.

## Why this is the whole fix (#1 and #3 subsumed)

- **#1 (roster out of write-turn authority):** `enter` legitimately needs the
  roster, so `reads_room_presence` is correct — not spurious. The authority pull
  uses the same now-filtered `/sessions-for-scopes`, so it carries only the
  bounded live set (~2). Nothing to strip without breaking the roster. The 5s
  `/sessions-for-scopes` timeouts are mitigated (smaller result).
- **#3 (receiver early-noop):** the sender's shard selection
  (`mcpFanoutAudience` → `/sessions-for-scopes`; `mcpShardHostsForScopes` →
  `/mcp-shards-for-scopes`) is now presence-filtered, so 16–17 → ~participants
  at the SENDER. A receiver noop is redundant and risky: session→shard is
  deterministic, so a noop on a cold-but-real shard would drop catch-up frames
  (peer-not-seeing-observation regression). Deferred; revisit only if post-fix
  smoke still shows `queue_count:0` fanout receipts (already in
  `mcp_remote_commit_received`).

## Tests

`tests/worker/directory-sessions.test.ts` (+5): backfill migration, stale-route
exclusion with auth still resolving, W/2 touch throttle, internal
re-registration not refreshing a stale lease, and a **2-actor regression gate**
(24 stale + 2 live → 2 sessions, 2 shards). 13/13 in file; typecheck clean.

## Spec

`spec/reference/cloudflare.md` — added the presence-lease contract
(last_seen_at vs expires_at; the three filtered readers; touch_presence
ingress-only refresh + throttle; delivery-vs-display separation).

## Review fixes (P1–P3)

External review found three issues; all fixed.

- **P1 (correctness):** presence was refreshed only after `gateway.handle()`
  returned. A stale-but-valid session starting a `woo_wait` (up to 30s) stayed
  absent from `/mcp-shards-for-scopes` for the whole wait; live fanout has no
  replay, so a peer observation during the wait would be silently dropped. Fix:
  `touchEstablishedMcpSessionPresence` refreshes presence at INGRESS (before
  handle) for already-established sessions (keyed off `x-woo-internal-session` /
  `mcp-session-id`; `initialize`, DELETE, aborted excluded), but now consults a
  small gateway-local W/2 `lastTouchedAt` map first so the correctness touch does
  not add a per-turn Directory round trip. Post-response registration still
  handles new sessions + detail/scope changes.
- **P2 (idempotency):** the `last_seen_at` backfill ran only inside the
  column-add branch, so a partial migration (column present, rows NULL) hid those
  rows from presence forever. Fix: the `UPDATE ... WHERE last_seen_at IS NULL`
  now runs unconditionally on every `ensureSchema` (no-op when no NULLs).
- **P3 (contract):** a brand-new route registered with `touch_presence:false`
  still got `last_seen_at = now` (via `!existing`), so a future internal creator
  would enter the fanout audience immediately. Fix: lease is `now` only when
  `touchPresence`; otherwise preserve existing or `0` (new → not present until
  ingress).

Tests: directory-sessions.test.ts +2 (P2 unconditional backfill over a NULL row;
P3 new-route-not-present-until-ingress). 15/15 in file; worker lane 220; npm test
369; typecheck clean.

## Cf-local prod-shape harness reconciliation

Merged into `cf-local-prod-shape` and corrected the stale-session fixture. The
original harness modeled staleness with old `started`/`expires_at` values, which
is correct on `main` but false under the presence lease: `register-session` is a
liveness moment and stamps `last_seen_at = now`. The reconciled gate now:

- registers the 29 seeded MCP Directory rows through the signed internal API
  (real route shape);
- directly ages only those rows' `last_seen_at` values in fake Directory storage
  (the local equivalent of "registered live, then no client ingress for > W"),
  avoiding fake timers because the walkthrough harness uses real `setTimeout`
  for request timeouts and optional delay injection;
- asserts the next two-actor room turn does NOT see `sessions >= 29` and does
  NOT select `audience_session_shards >= 16`; the maximum observed scoped
  session and audience-shard counts must stay bounded by the live room set.

Local validation after reconciliation: targeted worker files (Directory,
CF repository, cf-local walkthrough) passed; `npm run smoke:cf-local` passed;
`npm run typecheck` passed; `npm test` passed. A full `npm run test:worker`
run hit two long integration-test timeouts under suite contention, and both
timeout cases passed when rerun in isolation.

## Ingress-touch throttle correction

The first P1 implementation was semantically correct but added an avoidable
hot-path dependency: every established MCP request synchronously touched
Directory before `gateway.handle()`, even when Directory would dedupe the write.
That doubled the route-registration round trip for warm turns. The correction is
a per-gateway in-memory `session_id -> last ingress touch` cache, capped and
cleared on session unregister / force-rebuild. A successful post-response
registration also refreshes the cache, so the next established request pays only
the existing post-response registration unless the local lease age has reached
W/2. The cf-local walkthrough now asserts an established `woo_wait` emits exactly
one `/register-session` call (post-response), not a second pre-dispatch touch.

## Not done / next

- CF smoke re-run to confirm the 26→~2 / 17→~2 reduction lands on prod and the
  cold turn wall drops back under the 20s ceiling. (Do not re-run CF without a
  new signal; this branch is the new signal.)
- DO-class / migration check: no `wrangler.toml` binding change (internal
  session_route ALTER only), so no `cf-do-NNNN` tag needed.
