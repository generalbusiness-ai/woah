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
  lease (can't self-refresh). Touches throttled to ~W/2 (2.5 min) to keep the
  dedupe write-storm protection.

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

## Not done / next

- CF smoke re-run to confirm the 26→~2 / 17→~2 reduction lands on prod and the
  cold turn wall drops back under the 20s ceiling. (Do not re-run CF without a
  new signal; this branch is the new signal.)
- DO-class / migration check: no `wrangler.toml` binding change (internal
  session_route ALTER only), so no `cf-do-NNNN` tag needed.
