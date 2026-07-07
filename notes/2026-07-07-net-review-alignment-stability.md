# Plan 002 Phases 0-4 — alignment & stability review (main a998380)

Date: 2026-07-07. Two independent read-only passes (alignment vs the
ratified direction; stability vs deployment reality), coordinated
synthesis. This note is the input to the deployment-gate decision.

## Verdict

**The direction held in the code; it slipped in the governance.** The
architecture is genuinely the target: one write path per fact (verified
per fact), no unregistered state copies, one turn pipeline inside the
net stack, host-agnostic core with exactly the two named v2 bridge
points, no architecture flags, Big-World-clean validation paths.
The drift concentrated in self-enforcement (promised gates unbuilt,
budgets unmeasured, plan text not re-baselined) — the exact failure
mode the method section warned about. The stability pass found the
deployment blockers the lanes structurally cannot show: bootstrap,
growth, and rate/amplification.

## Alignment findings (D=drift, T=debt)

- D1 The CO12 gate suite is mostly aspirational: no registry gate
  (12.2), CI gate is a single-cell spot check, no taxonomy gate (and
  hydration epoch-mismatch throws outside the enum), the src/net
  engine-boundary "grep gate" is a stale comment (sessions.ts imports
  core/repository unlisted) with no guard script.
- D2 Three of five CO10 structural budgets (≤3 sync RPC, ≤8 row writes,
  0 reconstructions) have no counter or assertion anywhere; warm
  attempt=1 is lane-only; envelope ceilings + repair budget are the two
  genuinely enforced ones.
- D3 Phase 4 was rescoped (parallel surface, not cutover; MCP +
  tool-surface + SPA adoption deferred) without amending the plan —
  the system now has FOUR transport surfaces until Phase 5, and the
  real pinboard/outliner UIs remain on the v2 feed.
- D4 SqliteHost silently dropped (against the plan's named-not-silent
  rule).
- T1 /net/session-open is a second, smaller submit loop (sibling-drift
  pattern regrowing); lacks the main loop's transport-death resubmit.
- T2 Scope subscriber registry is append-only (no lease/unsubscribe) —
  delivery trends to O(every shard that EVER subscribed).
- T3 Per-turn O(view) work on the gateway (view clone + full
  SerializedWorld assembly per attempt; catalogKnownKeys walk;
  presence-table scan per fanout) — the v2 cost shape reappearing,
  unmeasured because of D2.
- T4 Echo overlay is intent-pending (documented); §3.6 predicted-write
  overlay unbuilt.
- T5 Spec-ahead-of-code in named places (copy #4 in-memory only, copy
  #5 Directory projection nonexistent, tool-surface in CO5 unbuilt;
  CO2.3 "one async RPC" is per-owner; rebuildRelations' foreign-drop
  depends on per-submit hints — latent).
- T6 tests/worker/net-* (CO13/14/16 + budget coverage) run under
  test:worker, not the curated npm test — against CO12's own rule.

## Stability findings (H=fix before/at staging, M=before cutover, L=note)

- H1 **No production bootstrap/subscribe path.** The gateway never
  subscribes to scopes; only the /net-smoke doorway can seed/subscribe,
  and it is either 404'd (WOO_AE_DATASET set) or UNAUTHENTICATED
  (anyone can overwrite $system.api_keys, subscribe rogue destinations,
  schedule turns). Blocks or compromises any deploy as-is. The
  "maintained on session open" subscribe is unimplemented.
- H2 **Unbounded durable growth loaded wholesale at cold start**:
  net_scope_reply (1 row/turn, forever, fully hydrated), gateway pins,
  and IMMORTAL session cells (expiry checked, never reaped; every mint
  adds cells to cluster + gateway + memory). No reaper exists anywhere.
- H3 **One gateway DO serves everything** (`net-api` shard) and
  ensureView loads its entire accumulated world (union of all visited
  rooms + clusters + catalog closure ~1.1MiB+) into memory per cold
  start; all sockets share it; repair loops head-of-line-block it.
- H4 **No rate limiting on /net-api or WS** vs a 12s×6-attempt
  amplifier per doomed turn incl. full-closure reseeds; session-mint
  spam is a durable-commit amplifier. wire.md's 50 ops/s rule
  unimplemented here.
- H5 **pushObservations scans ALL presence rows per fanout** (no owner
  filter) and stale presence rows are never removed — cost grows with
  total-sessions-ever, times chat rate.
- M6 Apikey revocation never propagates (identity cell cached until
  missing; no TTL/subscription).
- M7 Abandoned outbox rows: permanent, unrepaired divergence; receiver
  gap metric has no reseed policy — wire gap→pull minimum.
- M8 Convention probes mint durable junk DOs from client-influenceable
  names (8 CREATE TABLEs before refusal) — cost/growth, not
  correctness.
- M9 Cross-partition catalog_epoch divergence = unrecoverable E_BUDGET
  treadmill (retryable verdict that can never converge); deserves a
  distinct terminal surface + a seeding guard.
- M10 NetFeed session expiry dead-end: no re-mint on E_NOSESSION;
  synchronized 401 retry storms; silently dead client after TTL.
- L11 apikey-id existence oracle (message/timing); L12 permanent
  credential in the WS URL (per-connection ticket before cutover).

## Refuted (verified sound)

Hibernation degrades to one duplicate frame absorbed by the client
guard; echo overlay cannot leak; outbox memory transient; turn-id LRU
bounded (512); no v2/net shared mutable state; WS frames cannot
escalate sessions; body caps present; convention names cannot alias
object ids; clock skew immaterial at current TTLs.

## Recommended sequencing

1. **Pre-deploy fix set (blocks staging)**: H1 (a real bootstrap/admin
   path: authenticated seeding + gateway scope-subscription on session
   open/turn anchor; net-smoke stays lane-only), H4 (per-key rate
   limit, wire.md numbers), H2 minimum viable (reply-cache pruning
   keyed off tail trim + session reaper via the existing scope alarm),
   M9 guard (seed-time epoch check), M10 (feed re-mint).
2. **At-staging measurements**: D2's missing counters (RPC/writes/
   reconstructions per turn) implemented as metrics BEFORE the deploy
   so staging produces the CO10 evidence.
3. **Before cutover**: H3 sharding (session-hash shards + view scoping),
   H5 owner-filtered push + presence reaping, M6-M8, T1/T2/T6, D1 gate
   suite, D3/D4 plan re-baseline, L12 ticket auth.
