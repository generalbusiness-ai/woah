# Pre-deploy fix set — the revised deployment gate

Date: 2026-07-07. Branch: `net-predeploy` (from main `04e7e08`).
Gate (owner-revised): fix the blockers below + add their regression
tests + rerun the full gate chain, THEN a staging deploy scoped to
measuring cold-start/cross-colo behavior. Inputs: two internal reviews
(`notes/2026-07-07-net-review-alignment-stability.md`) + an external
security/correctness review (2026-07-07).

## The blockers (must land before staging)

### B1 — Unauthorized reads expose arbitrary cells incl. credentials [SECURITY]
`/net-api/relation` (gateway-do.ts ~991) and `/net-api/cell` (~999) are
authenticated but NOT authorized: any valid key reads any gateway-view
cell — including `property_cell:$system:api_keys` (salted-hash records)
that auth itself pulls into the view (~1036).
Fix: (a) hard-deny credential/system cells — `$system` object, any
`api_keys`/`bearer_tokens`/session-secret shaped key, and verb_bytecode
(no reason a client reads bytecode); (b) scope reads to what the caller
may see: relation reads require the caller to be a member of, or the
owner-scope's presence to include, the requested owner (start strict:
allow only relations whose owner is a scope the caller's session is
present in, plus its own actor/session cells); cell reads allow only
the caller's own actor/session cells + objects in a room the caller is
present in. Deny-by-default; named 403.
Tests: a key cannot read $system api_keys; cannot read another actor's
private cell; CAN read its own + co-present room contents.

### B2 — Idempotent replay can fabricate fresh nondeterministic output [CORRECTNESS]
CommitReply omits result/observations (scope.ts:80); replay returns the
recorded reply (scope.ts:230); the gateway decides "replay" only by
post-state digest match (gateway-do.ts:699) and then returns a NEWLY
planned result/observations (~710) — with now()/random() (world.ts:876)
a retry that touches no cells returns different output for the "same"
committed turn.
Fix (chosen): mark every gateway-detected replay explicitly and OMIT
freshly-planned output on it — the reply already carries `replayed:true`
per item-1; make the gateway set it whenever it served a recorded scope
reply (not only on digest mismatch) and strip result/observations in
that case. (Persisting output in the scope reply is the fuller fix but
widens the sequencer types + every reply row; the omit-on-replay rule
is correct and small. Document the tradeoff.)
Tests: two identical submits under one key — second returns
`replayed:true` with NO fabricated result/observations; head unchanged.

### B3 — Long-lived apikey secret in the WS URL [SECURITY]
`?token=apikey:<id>:<secret>` (client-auth.ts:53; net-feed.ts:501)
leaks the PERMANENT credential via history/logs/traces.
Fix: a short-lived WS ticket. `POST /net-api/ws-ticket` (authenticated
over HTTP) mints an opaque single-use, ~60s ticket bound to
(session, actor), stored in the gateway (bounded, TTL-reaped); the WS
upgrade accepts `?ticket=` only; the apikey never rides the URL.
NetFeed mints a ticket then connects. Keep `?token=` refused.
Tests: upgrade with a valid ticket succeeds once; reused/expired ticket
refused; apikey-in-URL refused.

## Growth/liveness blockers (from the internal H-review; land with B*)

- H1 — production bootstrap/subscribe: gateway subscribes to a scope on
  session-open/first-turn-anchor (so peer push works without the
  lane doorway); net-smoke stays test-lane-only (already deploy-refused
  — verify the unauth branch cannot run in staging: require the
  internal secret on net-smoke too, or bind it off in staging config).
- H2 — reapers: prune net_scope_reply alongside the tail bound (keep
  replies only for the retained tail window + a bounded recent set);
  a session reaper on the scope alarm deletes expired session cells +
  their presence rows. Bound the gateway pin table.
- H4 — rate limit /net-api (REST + WS frames) per key: wire.md 50 ops/s
  sustained, burst 100, named E_RATE; session-mint gets a tighter
  bound (durable-commit amplifier).
- M9 — seed-time catalog_epoch guard: refuse partition seeds whose
  epoch disagrees with the catalog scope; make a live epoch mismatch a
  distinct terminal surface, not a retryable treadmill.
- M10 — NetFeed re-mints its session on E_NOSESSION/expired instead of
  looping the 401'd upgrade forever.
- D2 — implement the missing CO10 counters (sync RPC/turn, scope-row
  writes/turn, reconstructions/turn) as metrics NOW so staging emits
  the evidence; add the warm-structure assertion to a curated test.

## Deferred to before-cutover (NOT this set; tracked)

Sharding (H3/M5), revocation propagation (M6), gap→pull (M7),
junk-DO probe hygiene (M8), apikey-id oracle (L11), the CO12 gate
suite (D1), plan re-baseline (D3/D4), SqliteHost naming, T1/T2/T3/T6.
Recorded in the review note; not gating staging (staging is a
measurement deploy, single-shard, on a fresh namespace with a small
seeded world).

## Sequence

1. B2 (smallest, correctness) → 2. B1 (authorization) → 3. B3 (ticket)
→ 4. H1+H4 (bootstrap+rate) → 5. H2 (reapers) → 6. M9+M10+D2.
Each: code + regression test + gates; commit per fix. Final: full
`npm test` + `test:worker` + `smoke:net-dev` + `e2e:net` + typecheck +
diff --check, then hand the staging-deploy decision back.
