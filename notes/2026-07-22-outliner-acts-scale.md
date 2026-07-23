# Outliner Acts scale proof

This note records the first production-shaped read/fanout result for the
Outliner Acts migration. The normative contracts are
[`spec/semantics/acts.md`](../spec/semantics/acts.md) and
[`spec/protocol/coherence.md`](../spec/protocol/coherence.md).

## Lane

`npm run bench:outliner-acts` starts real workerd, installs the normal Net world,
and grafts a 1,000-item Outliner plus eight independent API-key actors. Each
actor mints its own session, enters the Outliner through the sequenced domain
path, and opens an authenticated WebSocket. The lane primes all eight gateway
views, measures five warm `tree_view` reads, then runs three structural `hide`
Acts. Each wave requires the Act on the submitter's reply and on all seven peer
pushes before all eight viewers refresh concurrently through `/net-api/turn`.

The path includes Durable Object SQLite, cross-DO RPC, Net transcript
validation, JSON serialization, the semantic-view response, and independent
viewer fanout. It does not model cross-colo latency or claim an unbounded tree.

## Result (2026-07-22, authority-hardening rerun)

| Measure | Result | Budget |
|---|---:|---:|
| Warm `tree_view` p50 | 93 ms | — |
| Warm `tree_view` p95 | 100 ms | < 1,500 ms |
| Response bytes | 145,485–145,491 | < 524,288 |
| Mutation → all 7 peer pushes p95 | 48 ms | — |
| Peer Act push bytes | 276–278 | — |
| Eight-view invalidation → current p95 | 940 ms | < 5,000 ms |

All three peer-push times were 47, 48, and 34 ms; the complete
invalidation-to-current waves were 940, 929, and 915 ms. This rerun includes
the sequenced-ingress guards, source-bound/source-mediated projection rebuild,
and substrate lifecycle-caller correction. The original pre-hardening run was
92/101 ms warm p50/p95, 36 ms peer-push p95, and 928 ms complete-current p95;
the authority closure remains comfortably inside the same pilot budgets.

## Findings forced by the lane

The first run rejected a 1.51 MB warm submit although the user-visible result
was about 145 KB. `tree_view` repeatedly dispatches the same inherited catalog
verbs per item, and the transcript carried thousands of byte-identical read
events. They are one authority proof, so the wire transcript now keeps one
copy of each exact `(cell, version, value)` read. Successful results and planner
state probes remain gateway-local. A complete same-owner closure can also omit
ordinary owner reads, but only under an exact `(seq, hash, generation)` CAS;
session and sequenced-allocation reads stay explicit.

The next run exposed a more important routing error: `/net-api/turn` forced
every request to `sequenced`, including `WooContext.directCall(...,
{serverRead:true})`. Eight readers therefore allocated eight log sequences and
contended on `next_seq`. Net now preserves an explicitly requested direct route,
checks `direct_callable` at ingress, and treats a validated direct transcript
with no durable effects as a read rather than a commit. It does not advance the
scope head or cache an idempotency reply; a retry safely reads current authority.

The complete-head receipt also forced `ScopeHead.generation`. Seed and activation
writes intentionally leave `(seq, hash)` unchanged, so that pair cannot prove
authority stability. Every authoritative mutation now advances `generation`,
and the non-convergence detector includes it. Seed/activation ABA cycles are
covered by real regressions.

## Claim boundary

This establishes the current 1,000-row/eight-view pilot envelope. The server
still computes and returns the whole tree, so work and wire volume remain O(N),
and invalidating V viewers remains O(V·N). The client membership step is now
O(N) via a `Set`, removing the previous O(N²) render term. Before claiming a
larger product envelope, add pagination or an enforced domain cap and rerun the
same lane at that boundary.
