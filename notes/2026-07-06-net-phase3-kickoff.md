# Plan 002 Phase 3 kickoff — CF hosts + the proving harness

Date: 2026-07-06. Contract: `spec/protocol/coherence.md` (CO1, CO5, CO7,
CO12.5/12.6). Registration: `plans/002-simplest-deployable-system.md`.
Branch: `net-phase3` (from main `0e4fa51` — Phases 0-2 merged).
Prior stage: `notes/2026-07-05-net-phase2-kickoff.md` (all 9 steps done).

## What Phase 3 delivers

`src/net/` gains its deployment shells and — **before any deploy** — the
proving lanes the v2 era never had: a multi-DO harness with fault
injection at the Host seam, and the aged-world lane. Exit gates (plan
§Phase 3): all lanes green including faults; SLO structure gates met in
workerd under 100 ms injected RPC latency; a parked task survives DO
eviction and resumes via the scope alarm; `smoke:cf-dev` capable of
driving the new path.

## Build order

1. **Durability: `ScopeStore`** — persistence for the sequencer's five
   row families (authority cells, reply cache, recovery tail, scheduled
   queue, meta head/epoch) behind a small synchronous storage interface
   (DO SQLite is sync; same contract as `ObjectRepository`'s sync rule).
   In-memory impl + hydrate/write-through/crash tests first; the DO
   SQLite impl rides in step 2. Write-through happens after each accepted
   `submit()` (touched cells + head + reply + tail row in one
   transaction) and on schedule/cancel/dueTurns.
2. **`WorkerdHost` + DO shells** — `src/worker/scope-do-net.ts`
   (`ScopeDO`) and `src/worker/gateway-do-net.ts` (`GatewayDO`), thin
   over `src/net/` modules. WorkerdHost: `now`=Date.now, `defer`=
   ctx.waitUntil, `setAlarm`=DO alarm API, plus the **`rpc` surface**
   (added to the Host interface in this phase — every cross-DO call goes
   through it, which makes fault injection a one-place seam instead of
   v2's scattered patch points). Internal auth via the existing
   `verifyInternalRequest`. Wrangler: add `SCOPE`/`GATEWAY`
   `new_sqlite_classes` to **all three configs** (`wrangler.toml`,
   `wrangler.smoke.toml`, `wrangler.cf-e2e.toml` — `guard:smoke-wrangler`
   enforces parity) + `npm run cf:migrations` tag. Old v2 classes stay.
3. **Gateway machinery** — the CO6-taxonomy-driven repair loop
   (`stale_head` → refetch head+closure; `read_version_mismatch` →
   refresh exactly `mismatched_reads`; `missing_state` → closure
   transfer; budget `repair_budget_ms`=12 000 with the E_BUDGET attempt
   trace), the **rider-adoption forward** (the job the Phase-2
   differential did inline: accepted rider cells → owning ScopeDO via
   the durable outbox), gateway cache (CO5 copy #2, epoch-stamped,
   `E_STALE_EPOCH` reseed), and KV seeds (copy #3).
4. **Multi-DO lanes** —
   a. fast: `tests/worker/net-*.test.ts` over the existing fake-DO
      namespace (verify per-instance storage isolation for the NEW
      classes; do not inherit v2's collapsed-world shape);
   b. real: workerd via `wrangler dev` driving GatewayDO/ScopeDO
      directly (scenario script), **with fault injection**: env-config
      faults applied inside `WorkerdHost.rpc`/`defer` (latency 100 ms /
      1 s, error, kill-after-commit, eviction between turns) — porting
      the `rpc-fault-inject.ts` seam pattern onto the one Host choke
      point. Parked-task eviction gate lives here.
5. **Aged-world lane** (CO12.6) — build a world through history
   (install catalogs vN, play turns, bump `catalog_epoch`, replay),
   assert convergence happens via named reseeds (`E_STALE_EPOCH` counts)
   and zero unnamed divergence.

## Design decisions fixed now

- **The sequencer stays in-memory + write-through; the DO hydrates it
  on cold start.** No lazy partial hydration in Phase 3 (scopes are
  room-sized; CA12.1 cell-keyed splitting remains the deferred scale
  lever behind the C4 tripwire).
- **RPC surface (all internal-auth'd JSON):**
  - Gateway→Scope: `POST /net/submit` (CommitSubmit→CommitReply),
    `POST /net/closure` (cell keys → lineage-closed CellTransfer),
    `GET /net/head`.
  - Scope→Gateway (outbox drain, via defer): `POST /net/fanout`
    (FanoutBody; receiver no-ops by seq).
  - Scope→Scope (rider adoption, via outbox): `POST /net/adopt`
    (authoritative CellTransfer install; same idempotency).
- **Fanout destinations** in Phase 3 are gateway shards registered per
  scope (a `subscribers` row family in ScopeStore, maintained by the
  gateway on session open) — the Directory presence projection (copy #5)
  joins in Phase 4 with transports.
- **No new flags** (CO7): fault config is test-env-only
  (`WOO_NET_FAULTS` JSON read by WorkerdHost in non-production), budgets
  are constants from coherence.md CO10.
- **v2 untouched.** New DO classes beside the old; the standing v2
  freeze continues; nothing routes production traffic to the new path
  until Phase 5 cutover.

## Progress log (update as steps land)

- [x] 1. ScopeStore persistence — sync five-row-family interface +
      InMemoryScopeStore; sequencer hydrates unconditionally (meta
      validated when present — a scheduled-only scope has no meta yet),
      writes through on accept (one transaction: cells+meta+reply+tail),
      seed, terminal-rejection replies, schedule/cancel/dueTurns;
      no-store behavior byte-identical
- [x] 2. Host.rpc (single fault seam) + WorkerdHost (Date.now/waitUntil/
      single-DO-alarm mapping, WOO_NET_FAULTS parsed once + refused in
      deployed envs) + NetScopeDO (SqliteScopeStore, lazy hydration,
      /net/{submit,closure,head,seed,schedule}, alarm() re-derives from
      durable state) + NetGatewayDO (SQLite derived view + seen
      high-water, /net/{fanout,pull,turn}, env-binding destination
      resolution w/ test override) + wrangler three-config parity +
      cf-do-0004 tag (cf-do-migrations.test.ts expectations updated —
      the pinned class list is that migration kind's own gate) + fake-DO
      lane test (per-instance isolation is REAL for the new classes:
      each FakeDurableObjectState owns its own SQLite)
- [x] 3. Gateway machinery, in three commits:
      **(a)** the CO6-taxonomy repair loop replaces NetGatewayDO.turn's
      single attempt — per-verdict recoveries (E_MISSING_STATE →
      targeted closure fetch of exactly the missing keys; stale_head →
      head refetch + same-transcript resubmit only when the base was the
      whole story; read_version_mismatch/post_state_mismatch → refresh
      exactly the mismatched cells then RE-PLAN; stale_epoch →
      dropStaleEpoch + full reseed, the CO8 path), bounded by
      repair_budget_ms=12 000 (CO10) + a 6-attempt ceiling; E_BUDGET
      carries the AttemptTraceEntry trail into the /net/turn error
      reply; recovery failures annotate their round (recovery_error).
      **(b)** scope-side fanout + CA3 rider adoption — net_scope_
      subscribers + /net/subscribe; durable net_scope_outbox (FanoutRow
      mirror + a route column) enqueued in the SAME transaction as the
      commit write-through; drain shape (the documented choice):
      rehydrate pending SQLite rows into a fresh src/net Outbox per
      drain, restoring persisted attempt/backoff state onto the minted
      rows, so lane/backoff/abandon semantics are identical to
      src/net/outbox.ts; delivered rows deleted (receivers are
      seq-idempotent, CO2.5), abandoned rows kept + woo.metric; drains
      via host.defer + drain-on-reactivation (any request re-kicks
      pending rows); /net/adopt installs authoritative rider cells,
      idempotent by (from_scope, seq) high-water, the adopting head does
      NOT advance. One deliberate shape choice: the submit sibling field
      is `rider_destinations: {scope: {destination, objects}}` — the
      object list rides because only the gateway holds the anchor map
      (a bare `{scope: destination}` cannot say WHICH accepted cells are
      the rider's, and shipping the full closure would mint a second
      authority for room facts); src/net types unchanged.
      resolveNetDestination moved to workerd-host.ts, shared by both
      shells.
      **(c)** KV seeds (CO5 copy #3) — /net/pull tries HOST_SEED_KV
      (`net:seed:<scope>`, structural {get,put} slice) first and
      HEAD-CHECKS against the live scope before trusting; a lagging seed
      logs E_SEED_LAG (informational) and falls back live, which
      OVERWRITES the seed; live pulls write the seed back deferred
      (best-effort, full pulls only — a `known`-relieved pull would
      snapshot a partial closure).
- [ ] 4a. fake-DO fast lane for the new classes
- [ ] 4b. workerd lane + fault injection + parked-task eviction gate
- [ ] 5. aged-world lane
