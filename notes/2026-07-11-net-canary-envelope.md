# Net path canary envelope — deployed Cloudflare (2026-07-11)

First capture of the net path's behavior on **real Cloudflare DOs** (not
workerd), via an isolated canary worker (`woah-canary`, dedicated
`wrangler.canary.toml`, own DO storage + KV, synthetic bundled world, no
identity carry). Prod and the cutover-target net namespace were never
touched (verified: prod net-api still `E_NOT_INSTALLED`). Canary torn
down after capture.

Load: 6 guest-door sessions, all in `the_chatroom`, 47 rounds of
concurrent `say`+`look` (12 concurrent turns/round) over ~90s = 564
turns.

## Proven on real Cloudflare (milestones, first time off workerd)

- **Full install pipeline**: 20 scopes seeded across real DO instances,
  all heads verified at the install epoch, CAS'd `/net/activate`
  published. `net-install ok`.
- **Identity door end to end**: guest claim → exclusive session mint
  (born present at `cluster:guest_1`) → `command_plan` → dispatch →
  accepted commit at `room:the_chatroom` (head advanced).
- **Named refusals correct in prod shape**: `E_NOT_INSTALLED`
  (pre-install), `guest_pool_exhausted` (503 E_RATE), activation barrier.

## Latency envelope (real Cloudflare, under the concurrent load above)

| Series | p50 | p90 | p99 | max |
|---|---|---|---|---|
| **Warm turn** `net_turn_structure.wall_ms` (uncontended) | 185ms | 217ms | — | 298ms |
| `queue_ms` (hot-scope serializer wait) | 0 | 939ms | — | **1113ms** |
| **NetGatewayDO** wallTime (the single shard) | 292ms | **1651ms** | **2236ms** | 2236ms |
| NetGatewayDO cpuTime | 26ms | 108ms | 195ms | 195ms |
| **NetScopeDO** wallTime | 1ms | 51ms | 168ms | 705ms |
| NetScopeDO cpuTime | 0ms | 1ms | 4ms | 34ms |
| Edge-observed full turn (worker fetch) | 1646ms | 1975ms | 2462ms | 5559ms |

Warm-turn shape: `rpc_depth=3` (head + submit + closure), `sync_rpc`
4–10, `reconstructions=0`, `attempt=1`, `plan_cells≈714`. wall_ms ≈
rpc_ms — **the turn is RPC-bound (cross-DO), not CPU-bound**; scope-DO
cpuTime is trivial (p99 4ms). The net LAYER's per-turn cost is good
(~185ms, 3 serial hops, no reconstruction).

## The headline: 42% HTTP 500 under modest concurrency

329/564 turns accepted; **235 returned HTTP 500**. DO outcomes were all
`ok` (zero DO exceptions), so these are handled `E_INTERNAL` from the
gateway — cross-DO RPC contention under single-shard load. A control
(1 guest × 4 concurrent turns) had 0 errors; the 500s appear only with
concurrent turns from *different* guests to one room. Exact error string
not captured (tail sampled the erroring invocations out; the pool then
exhausted, blocking re-probe), but the correlation is unambiguous.

## Reviewer NC8 predictions — confirmed with real data

- **Finding 8 (single gateway = choke)**: all `/net-api` serializes
  through one `NetGatewayDO`; wallTime p90 1.65s / p99 2.24s at just 12
  concurrent turns.
- **Finding 11 (hot-scope queue, no RPC deadline)**: `queue_ms` to 1.1s;
  the 500s are undeadlined cross-DO RPCs failing under contention.
- **Finding 12 (fixed guest pool immediately capacity-limited)**: 8
  seats exhausted by ONE load run, locking out every new guest for the
  30-min session TTL (`guest_pool_exhausted` fired correctly, but that
  IS the limit).

## Operational finding: tail sampling

Cloudflare `wrangler tail` samples aggressively under load (~7% here — 42
of ~564 gateway invocations, 13 of 564 `net_turn_structure`).
**Insufficient for percentile envelopes.** A canary needs a dedicated
metrics sink — the Analytics Engine dataset with a real `METRICS`
binding, or a `/net-metrics` scrape endpoint — not tail alone.
`scripts/net-metrics-report.ts` parses the CF tail shape correctly but
can only report what tail delivers; the per-DO `wallTime` in every event
(used above) is the fuller signal tail does give.

## Verdict

The net LAYER is sound (correct install/activation/door/commit on real
Cloudflare; ~185ms RPC-bound warm turn). But the **deployment
architecture is not public-ready**: at 6 users in one room it 500s 42%
of the time, gateway p99 is 2.2s, and the guest pool locks out after 8.
This is exactly the NC8 enforceable-envelope gap. Required before a
public route switch (now with numbers, not just prediction):

1. **Gateway sharding** — one `NetGatewayDO` cannot carry `/net-api`.
2. **Per-turn RPC deadlines + cancellation** — the likely 500 source;
   the elapsed-time budget only checks between calls (finding 11 rest).
3. **Elastic guest capacity** — owner-sequenced guest creation beyond a
   fixed pool (finding 12 rest).
4. **A real metrics sink** for the eventual bake canary (AE binding or a
   scrape endpoint), since tail sampling hides the envelope.

The parallel-path deploy stands (v2-equivalent, refusal behavior + door
proven live). The cutover remains gated on the four items above.

---

## RESOLVED (2026-07-12)

All four "Required before a public route switch" items above LANDED and
passed a second deployed acceptance canary:
- gateway sharding → `src/worker/net/gateway-routing.ts` (8-way,
  `NET_API_GATEWAY_SHARDS`);
- per-turn RPC deadlines → `NET_RPC_TIMEOUT_MS` / `E_RPC_TIMEOUT`
  (→ 503 retryable), the fix that turned 42% 5xx into 0%;
- elastic guest capacity → `src/net/guest.ts` (`$system.guest_template`);
- a real metrics sink → the AE `METRICS` dataset + `scripts/net-metrics-ae.ts`.

Accepted envelope (30 concurrent guests, 22 elastic, 600/600 turns, all
8 shards, global p99 397ms, queue p99 0ms, zero 5xx/timeouts/gaps).
Superseded by `spec/operations/net-cutover.md` NC8 and the plan note's
"NC8 SCALE COMPLETE" section. This note is retained as the historical
FIRST-canary failure record that motivated the fixes.
