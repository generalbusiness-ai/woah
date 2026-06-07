# Gateway projection-cache coherency — the real defect behind "stale fixtures"

## Reframe (user, 2026-06-05)
Slim is the EXPOSURE, not the cause. Slim removed the accidental self-healing that
full per-turn authority payloads provided. The underlying DEFECT: gateway
projection/cache state is allowed to drift and is then used for VISIBILITY / TOOL
RESOLUTION, where the spec requires execution/auth paths to stay AUTHORITATIVE.

## Evidence (prod, deploy 97a6d83)
Two reads of `the_chatroom.contents` diverge:
- `$programmer:eval contents(#the_chatroom)` (routes to the OWNER, authoritative):
  clean 8 members, includes the_mug.
- `/api/objects/the_chatroom` (gateway/cluster view): ~50 stale `guest_*` +
  MISSING the_mug.
So `take mug` (whose tool/contents resolution hits the gateway view) fails
"I don't see mug here", while the owner is correct. The owner bounce-repair
(moveto the_mug out/in) fixed the owner (already correct), NOT the gateway cache.

## Priority plan (do in order; force-rebuild is LAST)
1. **Confirm the serving path** before wiping anything. Directory route for
   the_chatroom/the_mug; tail host_key for public `/api/objects/the_chatroom` and
   the MCP `take`. If public reads / tool resolution hit world/gateway/stale
   satellite instead of the_chatroom's owner, that mis-routing is part of the root.
2. **Narrow cache-inspection probe** (non-destructive). Per host/scope:
   gateway_projection_scope head; gateway_projection_object row for the_chatroom;
   contents count/sample; the_mug presence; guest_* count; tool-surface coverage.
   Makes the stale host identifiable without a destructive rebuild.
3. **Gateway projection coherency fix.** Gateway cache apply must update derived
   container contents from accepted `transcript.moves` EVEN when no full container
   object row is in projection_writes. (The owner-host durability fix eefd200 is
   hostKey-gated — it deliberately does NOT repair gateway cache paths.)
4. **Lifecycle/prune for gateway cache.** `pruneSerializedSessionsWithoutActorRows`
   prunes serialized worlds, not persisted `gateway_projection_object.contents`
   rows. Departed actors need a projection-cache cleanup tied to session
   end/expiry/fanout, or room contents re-bloats.
5. **THEN** `/api/admin/force-rebuild-host` on identified stale shard(s) — recovery
   AFTER the leak is understood/fixed, not the primary fix (else it re-drifts).

## Regression test to land (prod-shaped, cheap)
Seed a gateway projection cache for the_chatroom MISSING the_mug and CONTAINING
stale guests; run slim MCP `take mug`; assert it owner-refreshes/repairs before
resolution rather than trusting the stale cache.

## Code-confirmed gaps (steps 1-2 done via trace, non-destructive)
Stale store = `gateway_projection_object` / `gateway_scope_member` (persistent
gateway cache), serving descriptor/tool-surface reads. persistent-object-do.ts:
- **Step-3 gap** — `applyGatewayProjectionWrites` (724): signature is
  `(position, writes, source, delta)` — NO transcript. It applies projection ROWS
  only; cannot apply `transcript.moves`. So a cross-host move (foreign container,
  no full-row write) never updates the cached container contents (the_mug never
  added; a departed guest's move-out never removed). Fix: thread the transcript +
  apply move-derived contents to cached container rows (mirror eefd200 owner fix).
- **Step-4 gap** — member removal from a room's cached contents
  (`gateway_scope_member` / object contents, line 769-770) fires ONLY on object
  RECYCLE (`op:"delete"`). closeMcpWooSession (4047) + end-session (4087) delete
  the `gateway_projection_session` row but do NOT remove the guest from the room's
  cached contents → departed-actor bloat. Fix: on session end/expiry (and/or
  presence fanout), prune the actor from its room's cached contents.
- **Spec point** — line 733 already declares "auth and execution use authoritative
  paths, not these stale-tolerant rows," yet tool/visibility resolution (take's
  `$match`) reads them. The deeper fix is that resolution must owner-refresh/repair
  before trusting drifted cache (the regression test asserts exactly this).

## DECISIVE (deploy a9fb908 + force-rebuild, smoke 6/10): move-coherency is the wrong lever for take
- `take mug` runs on a GATEWAY SHARD (mcp-gateway-5), planning the_chatroom from
  the shard's delta-built cache. **the_mug is a SEED FIXTURE** (demoworld manifest,
  alias "mug") — it has NO transcript.move. So owner+gateway move-coherency fixes
  cannot add it (nothing to apply). The shard cache is built from enter-MOVE deltas
  (guests accumulate, never pruned → ~50 bloat) on top of an initial the_chatroom
  row that never carried the seeded mug. Net: caches drift by construction
  (delta-accumulation: miss seeds, keep departed) and resolution trusts them.
- **force-rebuild is NET-NEGATIVE**: it wiped the CA11.2 topology pre-seed →
  southeast regressed (was passing) → 8/10 dropped to 6/10. It did NOT fix the_mug.
  Stop using it as a fix; it's post-fix recovery only.

## Recommendation (supersedes per-cache move-coherency whack-a-mole)
THE FIX IS AUTHORITATIVE RESOLUTION, not more cache coherency:
1. STOP force-rebuilding (destabilizes; reintroduces southeast).
2. Make tool/visibility RESOLUTION reconcile a room's membership against the
   AUTHORITATIVE owner (the_chatroom PersistentObjectDO has correct contents: seeds
   + current members, no bloat) instead of trusting the shard's delta-built cache.
   Fixes seeds (the_mug) AND avoids trusting bloat, at the read boundary, regardless
   of cache state. This is the spec line extended: line-733 says auth/execution are
   authoritative — visibility/tool resolution must be too. With slim, this means the
   resolution-critical room read must fetch authoritative contents (bounded/cached
   by freshness), not reuse the stale relay/cache.
3. Prune departed actors from derived contents caches on session end/expiry (bloat).
4. If keeping caches: (re)seed container contents from FULL authoritative contents,
   not delta-accumulation, so seeds are present.
5. Regression test MUST include a SEED-fixture member (no move) in a stale cache +
   stale guests → slim take resolves via authority. (A move-only test would have
   passed yet missed this.)

Status: lineage and contents-durability fixes are merged; contents-durability
deployed as 97a6d83. This note records the next gateway coherency layer:
authoritative, owner-repaired resolution for sparse MCP planning.

## Follow-up after deploying authoritative resolution (97a8860)
Deploy smoke proved the read-boundary repair: `take mug` no longer failed at
the seed-fixture lookup, and the transcript contained the authoritative
`the_mug` row. Two remaining gaps explained the residual failures:

- Exact `woo_call(the_chatroom, southeast)` can fail before VM planning if the
  sparse shard's cached `gateway_tool_surface` row covers `the_chatroom` but was
  built before the movement verb was visible. A cached object row that lacks the
  requested verb is not a negative-authority answer; exact `woo_call` must force
  a bounded owner refresh before returning `E_VERBNF`.
- Resident owner contents repair was accidentally tied to
  `local_catalog_bundle_fingerprint`. Because the deploy did not change the
  catalog fingerprint, already-current hosts never ran the derived-contents
  repair and authoritative room contents still included historical departed
  actors. The repair needs its own epoch so a code-only repair deploy can run it
  once per resident host without rerunning the catalog-seed repair.
- Local full-suite validation exposed a separate reused-relay auth edge: a REST
  v2 relay can carry session claims from its initial serialized seed even after
  the gateway has a current session record. Reused relays now refresh relay-local
  claims from the current gateway session before open/planning, preserving strict
  token expiry without rebuilding the relay.

Wrangler tail metrics were unavailable in this run because the active Cloudflare
token could deploy but could not open `/tails`. The actionable signal came from
the deploy postflight smoke log rather than tail-backed timing analysis.
