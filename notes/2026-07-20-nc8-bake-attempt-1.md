# NC8 bake attempt 1 — FAILED acceptance (wall p99); episodic hot-room authority stalls

Date: 2026-07-20/21. Operator sequence context: this was step 1 of the NC9
operator gates (NC8 bake → per-class traffic gate → verified backup) ahead of
merging/deploying branch `prenet-removal`. **NC9 remains blocked at step 1.**

## Run configuration

- Target: prod `woah` (version 5554d6ce, net stack), base host
  `woah1.generalbusiness.ai` (the `woah` 308 breaks WS clients).
- Bake window opened **2026-07-20T22:31:25Z, cold** — verified zero turns in
  `woo_v1_prod` for the preceding 2 h before starting.
- Watch: `npm run metrics:net-ae -- --dataset woo_v1_prod --from
  2026-07-20T22:31:25Z --watch --min-seconds 1800 --max-seconds 3600`
  (default acceptance limits).
- Load 1 (22:31–22:37): `net-canary-load` 30 actors × 40 rounds × 2
  requests, 5 s round delay, room `the_chatroom`, `--enforce-who`.
- Load 2 (22:37–~22:56): 10 actors × 110 rounds × 2, 10 s delay,
  `--enforce-who`.

## Results

**Load 1: clean sweep.** 2400/2400 accepted, 0 failures, 0 server errors, all
HTTP 200; 22 elastic guests; 30/30 sessions closed. `--enforce-who`
conclusive across **all 8 gateway shards**, every responder saw the complete
30-member roster (max_missing 0). Edge p50 922 / p95 1472 / p99 2386 ms.

**Load 2: driver misuse, not a server fault.** The driver hard-codes a
10-minute guest claim TTL (`net-canary-load.ts` claimBody `ttl_ms:
10*60_000`); a 19-minute run outlives its sessions. All sessions expired at
~22:48 (= mint + 10 min, exactly where AE samples plateau); accepted 1082 ≈
54 rounds × 20 = precisely the pre-expiry rounds; the remaining 1118 turns
401'd `E_NOSESSION` (correct named refusal). The who-check "failure" was
`unreachable=10, max_missing=0` — dead bearers, **not** a presence
regression. **Lesson: driver cohorts must fit inside 10 minutes, or the
driver needs re-mint support.**

**AE watch: ABORT at max-seconds (exit 2).** Final report over the window
(3534 weighted turn samples, 8 shards):

- errors 0, rpc_timeouts 0, queue_p99 0, queue refusals 0, outbox delivery
  failures/abandonment 0, fanout gaps 0, degraded install signals 0,
  reconstructions 0, mean attempt 1. 24 elastic guests provisioned;
  1434 outbox drain passes delivered 34 989 rows with 0 failed.
- wall p50 240 / p95 845 / **p99 2920 ms (gate: ≤500)** / max 4944.
- The single ABORT-SIGNAL: `global wall p99 2920ms exceeds 500ms`.

## Diagnosis of the slow tail

All from AE (`woo_v1_prod`) — `wrangler tail` could not hold a stream from
this machine (two attempts, "Tail disconnected"; diagnostic-only anyway).

- 70/3534 weighted turns >1 s. Slow turns are **shape-identical to fast
  ones**: same rpc_depth (~4), same plan_cells (~934), attempt=1, zero
  reconstructions. One RPC dominates: avg rpc_max 2646 ms ≈ avg rpc_ms
  2873 ms (fast turns: 303/165 ms).
- **Not cold start.** The cold open (22:31–22:34, heaviest burst) was clean
  (worst 1071 ms). Slow turns cluster late in load 1 (51 of 70 in
  22:35–22:36) and recur in small groups through load 2.
- **Episodic, authority-side.** At 5 s resolution the slow turns form ~7
  discrete episodes with near-identical wall times per episode; the 22:46:45
  episode has three raw samples from **three different gateways** stalling
  simultaneously at ~2.3 s. Signature: the room scope DO
  (`net-scope:room:the_chatroom`, 3333 of 3534 turns) blocks for 1–5 s;
  every in-flight submit across all gateways waits.
- All slow turns: scope `room:the_chatroom`, status accepted.

Candidate mechanisms (undecidable with current instrumentation):
1. Mid-run DO eviction + re-hydration of the heavy room world (a week of
   accumulated prod state + ~5k new messages that evening).
2. An occasional heavy in-commit write (e.g. space snapshot/rollup) that
   queues all concurrent submits behind it.
3. Alarm-drain / fanout work occupying the DO between requests (34 989
   deliveries, 28 564 presence scans, 27 563 pushes in-window).

**Instrumentation gap (blocks root cause):** net DOs emit no
`do_constructor` metric (v2 DOs did — `writeConstructorMetricToAnalytics`),
and no `net_scope_*` event stamps a duration (double1 ms is 0 on all of
them; `buildAuthoritySql`'s submit percentiles read 0). Authority-side
service time, hydration time, and restarts are invisible in AE. Per project
rules, instrumentation must be improved before further debugging:
- stamp `do_constructor`(+hydration ms) for NetScopeDO/NetGatewayDO;
- stamp service-time ms on `net_scope_submit` (queue-wait vs execute);
- stamp per-pass ms on `net_scope_outbox_drain_pass`;
- stamp ms on any snapshot/rollup write path.

Then re-drive the hot-room shape and read which authority-side ms series
spikes inside the stall episodes.

## Context that keeps this honest

- The previously accepted stable envelope (p99 397 ms) was measured on an
  **isolated fresh canary world**; prod carries real accumulated room state.
  The spec's recorded hot-room burst ceiling (0.83 % hit 5 s RPC deadlines)
  is adjacent behavior; this window hit **zero** deadlines (max 4.94 s, just
  under the 5 s budget) — so nothing here is worse than the recorded
  ceiling, but the 500 ms p99 acceptance gate demonstrably does not hold on
  prod under sustained hot-room load.
- AE adaptive sampling weight-expands episodes (identical wall values), so
  per-episode counts are estimates; the episodic pattern itself is
  multi-sample and solid.

## Operator decision (2026-07-21)

The operator reviewed this result and **accepted the hot-room p99 stall as a
post-deploy follow-up**: the integrity envelope is clean, nothing regressed
versus the recorded burst ceiling, and the cutover (NC9 deploy) is NOT
blocked on the latency gate. The authority-side instrumentation below is to
be added now (it does not block the cutover if unfinished). The original
verdict is preserved below for the record.

## Verdict and consequences

- **NC8 acceptance: NOT met.** Integrity envelope is spotless; the latency
  envelope fails on episodic hot-room authority stalls.
- **NC9 sequence: blocked at step 1.** Do not proceed to the per-class
  traffic gate sign-off, the backup, or the `prenet-removal` deploy on the
  strength of this window. (The traffic-gate *query* can still be run any
  time; it just can't be "across a full accepted bake window" yet.)
- Next steps, in order: (1) land the authority-side instrumentation above
  (normal review/test discipline; needs a deploy to measure prod), (2)
  re-drive the hot-room shape and attribute the stall, (3) fix or formally
  re-scope the acceptance envelope if the stall is inherent to hot-room
  snapshots at this state size, (4) re-run the bake gate.

## NC9 step 2 — per-class traffic gate (run 2026-07-21): PASS

AE (`woo_v1_prod`) since cutover (2026-07-13), enumerated by
host_key/kind/class and by day:

- **Transition traffic ended 2026-07-15.** The three real v2 consumer
  families — the horoscope/weather plug hosts (~10k events/day), the classic
  MCP gateway shards (~14k/day), and CommitScopeDO commits — all read
  **zero from 2026-07-16 through 2026-07-21** (5+ consecutive days). These
  were the known migration-transition consumers (plugs + old MCP clients),
  not dormant crons.
- **The accepted bake window contained zero v2 rows.**
- **Residual tail (Jul 16+, ~dozens total):** internet vulnerability
  scanners probing `/api/.env`, `/api/graphql`, `/api/.git/config` wake the
  `world` PersistentObjectDO through the still-mounted `/api` route, which
  triggers the v2 self-registration cascade (init, startup_storage,
  directory register/resolve round-trips). No legitimate consumer. The
  net-only entry 410s `/api/*` with no DO binding, so the code-removal
  deploy eliminates these wakes entirely.

Verdict: zero un-migrated consumers. `PersistentObjectDO`, `DirectoryDO`,
and `CommitScopeDO` are deletion candidates per NC9 step 1.

## NC9 step 3 — backup (2026-07-21): reduced to disposal record

The accepted position (operator, 2026-07-20): final identity export +
written disposal record, no full B2 exporter. Status:

- A fresh identity export is **not executable**: `WOO_INTERNAL_SECRET` is
  not held anywhere locally (the rotated copy lived in the 2026-07-13
  session scratchpad, since expired; worker secrets are write-only).
  Re-rotating a live prod secret solely to re-run the export was not done.
- It is also **not informative**: AE proves zero v2 identity-mutating
  consumers since 2026-07-15 (auth/session/apikey traffic runs entirely on
  net), so v2 identity state is frozen at what the cutover process already
  consumed. The v2 world (including identity) was declared disposable at
  the FRESH cutover and rollback was formally renounced 2026-07-18.
- **Disposal record:** the storage wiped by `cf-do-0005 deleted_classes`
  (all PersistentObjectDO/CommitScopeDO/DirectoryDO instances) is the
  retired pre-cutover v2 world; no backup beyond this record is retained,
  by operator decision. If the operator wants a belt-and-braces export
  anyway, it requires `wrangler secret put WOO_INTERNAL_SECRET` (new
  value) + `scripts/identity-export.ts` before the code-removal deploy.

## Closure (2026-07-21): NC9 deployed

Prod `woah` version `d8119835` (main `92cd8cc`): net-only entry live,
`cf-do-0005 deleted_classes` applied, full postflight green, `/api/*` 410s
at the worker. The stall-attribution instrumentation is verified flowing in
AE (do_constructor for both net DO classes on all 8 shards,
net_scope_hydrated per scope lifetime, drain-pass `ms` up to 299 ms on the
hot room at 2-guest smoke load). The accepted post-deploy follow-up —
re-drive the hot-room shape and join stall windows against the new duration
series — is now executable.

Evidence: session scratchpad `bake-ae-watch.log` (full final report JSON),
`bake-load.log`, `bake-load2.log`; key numbers reproduced above. AE queries
used weighted aggregates per `scripts/net-metrics-ae.ts` conventions
(`_sample_interval * double2`).
