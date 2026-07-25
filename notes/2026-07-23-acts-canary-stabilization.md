# Acts canary stabilization

Date: 2026-07-23.

This note records the isolated Acts/Net canary run. It is evidence, not a
replacement for the acceptance contract in `spec/operations/net-cutover.md`.
In particular, browser-observed latency and sampled tail output do not satisfy
the Analytics Engine (AE) latency gate.

## Deployment

- Worker: `woah-net-canary`
- URL: `https://woah-net-canary.inguz.workers.dev`
- Runtime version: `c25710af-eaf3-4583-9460-cf9164c9a7e3`
- Reviewed commit deployed: `23ad64df`
- Configuration: standalone ignored `.wrangler/net-canary.toml`, dedicated KV
  namespace, no custom routes or domains

The production Worker and production data were not changed. The canary remains
deployed for the stabilization bake.

## Defect found and closed

The first post-deploy load exposed a real CO15 envelope defect. A complete
`who_all` reply was 67,706 bytes, above the 64 KiB warm-envelope ceiling. The
failure-only breakdown showed that the turn was otherwise compact:

- transcript: 13,120 bytes
- submit: 13,921 bytes
- attestations: 357 bytes
- live audience: 53,671 bytes

The Net carrier was repeating exact bearer-session audience lists for each
observation. Those lists are useful only inside the executing gateway and can
include derived session history. Commit `23ad64df` keeps the core
`DirectResultFrame` semantics exact, but carries only audience modes and
explicit actor references between Net authorities. Each destination gateway
resolves current sessions from its own presence rows. No bearer session ID now
rides a Net submit.

The production-shaped regression models 40 sessions and 30 roster rows,
requires the compacted envelope to stay below 64 KiB, and proves that no
session identifier leaks into the carrier. Commit `4992d169` also adds
failure-only field accounting so any future oversized submit names its source
without adding success-path telemetry cost.

After the fix, the same complete `who_all` envelope was approximately 19,509
bytes: 3.47 times smaller.

## Stabilization runs

The diagnostic sequence is retained here so that the clean windows are not
read without their preceding failures:

| Runtime/run shape | Turns | Roster result | Explanation |
| --- | ---: | ---: | --- |
| pre-fix, concurrency 16 | 597/600 | 29/30 | three DO resets during a diagnostic deployment; one complete roster exceeded 64 KiB |
| fixed runtime, concurrency 16 | 597/600 | 30/30 | two deployment-overlap resets; one room-attestation timeout |
| fixed warm runtime, concurrency 16 | 596/600 | 30/30 | three 30-second client timeouts; one `E_BUDGET` queue refusal |

The final concurrency-16 run is the meaningful saturation signal: it had no
deployment overlap. Thirty actors produce a 60-turn hot-room burst each round,
which is outside the known zero-timeout operating envelope. `E_BUDGET` is the
specified overload response; queue limits were not raised.

The paced acceptance shape was then run twice:

```sh
npm run load:net-canary -- \
  --base-url https://woah-net-canary.inguz.workers.dev \
  --actors 30 --rounds 10 --requests-per-actor 2 \
  --turn-concurrency 8 --round-delay-ms 500 --enforce-who
```

Both independent windows were clean:

| Run | Turns | Complete rosters | Shards | Session closes | Edge p50/p95/p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `canary-mrz3fhbk` | 600/600 | 30/30 | 8/8 | 30/30 | 344/825/1640 ms |
| `canary-mrz3hfm6` | 600/600 | 30/30 | 8/8 | 30/30 | 378/760/1304 ms |
| `canary-mrz3w2iw` (post-bake) | 600/600 | 30/30 | 7/8 | 30/30 | 402/745/938 ms |

Combined functional evidence is 1,800/1,800 accepted turns, 90/90 complete
co-present rosters, and 90/90 clean session closes. The first two windows each
covered every configured shard; the post-bake window randomly used seven. The
deployed shared walkthrough also passed 11/11 steps, including cross-actor chat
and movement, take/drop, Pinboard, the full Outliner
add/reorder/move/hide/remove/undo sequence, and Tasks presence.

The edge percentiles above include network and driver effects. They are
reported for diagnosis only. Sampled tail showed final `who_all` server wall
times around 134–153 ms, but tail is neither complete nor globally weighted.

## Local release ladder

The exact committed source passed:

- focused Net planner, WebSocket, and session-leak regressions: 30/30
- `npm run typecheck`, unpiped
- `npm run test:acts`: 142/142
- `npm test`: 736/736
- `npm run test:worker`: 262/262
- `npm run test:full`: 1,656/1,656
- `npm run install:net-dev`: 6/6
- `npm run smoke:net-dev`: 26/26
- `npm run e2e:net-dev`: 1/1 browser lifecycle
- `npm run smoke:net-mcp`: 14/14 shared walkthrough steps

The workerd Outliner scale lane also passed its 1,000-row/eight-viewer
budgets: warm view p95 126 ms, 145,510–145,523-byte views, mutation-to-peer
push p95 55 ms, and invalidation-to-current p95 1,008 ms.

## Formal AE result

On 2026-07-24, the dataset query was run over the isolated post-bake window
`2026-07-24T15:39:25Z` through `15:41:30Z`:

```sh
npm run metrics:net-ae -- \
  --dataset woo_v1_net_canary \
  --from 2026-07-24T15:39:25Z --to 2026-07-24T15:41:30Z \
  --min-turns 500
```

The formal NC8 latency and integrity gate passed:

- 704 AE-weighted turn samples across seven gateway shards;
- server wall p50/p95/p99 137/465/1,655 ms, below the 750 ms p95 and
  5,000 ms p99 ceilings;
- queue p99 0 ms;
- zero turn errors, RPC timeouts, queue refusals, reconstructions, fanout
  gaps, degraded installs/adoptions, outbox delivery failures, or
  abandonments; and
- mean attempt exactly 1 on every participating shard.

The weighted sample count is expected to differ from the driver's 600 requests:
the acceptance query applies Analytics Engine's `_sample_interval` weight.
This result closes the previously unevaluated deployed latency half for the
paced 30-actor canary. It does not replace the separate larger-occupancy,
geographic, sustained-rate, memory-growth, or induced-delay work still listed
under NC8.
