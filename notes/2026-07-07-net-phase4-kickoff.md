# Plan 002 Phase 4 kickoff — transports + the client feed

Date: 2026-07-07. Branch: `net-phase4` (from main `28262ce` — Phases 0-3.5
merged; the coherence layer is feature-complete underneath). Contract:
`spec/protocol/coherence.md` CO1-CO16; plan §Phase 4
(`notes/2026-07-04-simplest-system-plan.md`).

## What Phase 4 delivers

Clients reach the coherence layer: one `submitTurn` primitive behind
thin transport adapters, real client authentication, observation
delivery to connected sessions, and the browser feed with the
optimistic-echo overlay. Exit gates (plan): e2e green including the
cross-user pinboard/outliner sharing fix in the new feed;
localdev/browser parity lanes.

## Build order

1. **Turn results reach the caller.** The accepted `/net/turn` reply
   carries the transcript's `result` and `observations` (the gateway
   holds the planned transcript — the 2026-07-06 review's finding 5).
   Small and foundational: every transport needs it.
2. **The production client surface (`/net-api/*`)** on the worker entry,
   routed to GATEWAY_NET — UNLIKE `/net-smoke` this is a real client
   surface: client credentials, not internal signing.
   - AuthN: apikey validated against the identity cell in the catalog
     scope closure (`property_cell:$system:api_keys` — the same
     salt/hash scheme core auth uses, reimplemented narrowly in
     src/worker/net; never import world.ts).
   - `POST /net-api/session` (auth → session-open at the actor's
     cluster), `POST /net-api/turn` (session-carrying TurnRequest →
     submitTurn), `GET /net-api/relation`, `GET /net-api/cell` (reads).
   - The gateway requires sessions on client-originated turns (CO14's
     stated Phase-4 rule).
3. **WS transport + observation push.** WS upgrade at `/net-api/ws`;
   the gateway keeps a session→socket registry (in-memory per shard —
   liveness only, sessions stay cells); the fanout receiver routes
   `body.observations` to sockets whose session appears in the
   `session_presence` relation for the fanout's scope (CO13 audiences
   get their first consumer). Echo: the submitting session receives its
   own turn's observations synchronously on the turn reply (item 1),
   never duplicated via fanout (dedupe by turn id).
4. **The client feed (`src/client/net-feed.ts`)** — plan §3.6: a
   projection consumer + echo overlay over `/net-api` (WS + reads).
   Framework observation reducers re-pointed via an adapter; the v2
   client stack untouched (cutover at Phase 5).
5. **e2e + the cross-user fix.** Playwright e2e over localdev serving
   the net path for a test page; the cross-user pinboard/outliner
   sharing scenario lands HERE (the known browser-side v2 bug is fixed
   in the new feed, not patched into the old one). Lane extension.

## Design decisions fixed now

- Transports are ADAPTERS: no turn logic outside `submitTurn`
  (the /net/turn machinery). MCP adapter is deliberately DEFERRED to a
  follow-up (it carries tool-surface projection weight — PC1) unless
  Phase-5 cutover planning pulls it in; REST+WS suffice for the
  deployment gate.
- Client auth tokens: `apikey:<id>:<secret>` (the existing woo format)
  → gateway verifies against the catalog identity cell; bearer/session
  minting stays the Phase-5 identity-import concern.
- The session→socket registry is per-gateway-shard memory: a dropped
  socket loses only liveness (the session cell persists; reconnect
  re-registers). No new durable copy — CO5 stands at five.
- Observations are at-most-once per socket per turn (turn-id dedupe);
  durability of missed observations is NOT promised in Phase 4
  (documented; the tail/catch-up story is Phase-5 polish if needed).

## Progress log

- [x] 1. turn results + observations on the reply — TurnResult carries
      the planned transcript's `result`/`observations` on accepted
      replies; an idempotent replay detected by post-state digest
      mismatch (a fresh accept always digest-matches its own plan)
      omits them and marks `replayed: true` instead of presenting the
      re-planned execution as the committed one.
- [ ] 2. /net-api REST surface + client auth + session requirement
- [ ] 3. WS + observation push via session_presence
- [ ] 4. client feed + echo overlay + framework adapter
- [ ] 5. e2e + cross-user fix + lane extension
