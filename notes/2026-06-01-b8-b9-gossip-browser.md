# 2026-06-01 — B8 (capability gossip) + B9 (browser narrow node)

Phase B continued on `mobile-heap-a0a1` after B6 (791f754), B7 (0f4bedc/a452ddd),
and the B6/B7 review fixes (f146c54).

## B8 — capability gossip routing (VTN0 claim 4 / VTN11) — commit 35f6cbc

**Finding:** the ad model (`covers`/`accepts` Bloom, `factor`), `TurnKey`
extraction, and an in-process ranked-candidate network already existed. Ranking
was `factor`-only; ads weren't used in production routing (the gateway submits to
a statically-selected commit scope). The VTN11 spec already described the full
ranking formula and an `ExecCapabilityAd` with `expires_at`/`head`.

**Built:**
- `capability-ad.ts`: enriched `ShadowCapabilityAd` with the routing-cost
  components + freshness (`latency_ms`, `transfer_cost` (from B7's measurable
  cell_pages transfer), `failure_penalty`, `head`, `issued_at_ms`/`ttl_ms`);
  `capabilityAdRoutingScore` = `latency + factor + transfer_cost + failure_penalty`
  (lower-is-better); `rankCapabilityAdsForTurn(ads, key, {now})` applies the score
  + TTL expiry. Behavior-identical when only `factor` is set, so all existing
  callers/tests are unchanged.
- `shadow-turn-network.ts`: ad builders forward the cost fields (`ShadowAdRoutingCost`).
- Execution **migration** then emerges from the existing ranked network + B7
  warm cache-fill: a cold turn runs at the owner and warms the actor node; the
  next same-object turn ranks the now-warm node best (transfer_cost ≈ 0) and
  routes local with no further transfer. Bloom false positive → executor returns
  `missing_state`, caller warms + retries (bounded, never corrupts; commit proves
  authority).
- Gate `tests/v2-capability-gossip-routing.test.ts`: ranking formula, TTL expiry,
  contended→only-covering-executor (no location oracle / no global enumeration —
  ranking touches only ads+key), and the ≥3-node migration case.
- Spec VTN11: ranking pinned + B8 "implemented" status note.

**Deferred:** retiring the *production* worker's static scope-submission behind
the gossip layer (so the deployed gateway ranks gossiped ads) — highest-reach
change, rides on smoke validation, not the local gate. Until then gossip is the
in-process router and the static route is the production bootstrap. This is also
where B7's deferred production warm-transfer-install lands (install target = the
gossip-selected node).

## B9 — browser as a narrow-authority node (VTN0 / VTN14) — commit 5fd64b0

**Finding:** the browser is ALREADY a narrow node. Every durable commit goes
through server-side `CommitScopeDO`/relay validation (`submitShadowCommit`); there
is no divergent write path; it advertises only a session-local scope ad with
empty Bloom coverage. VTN14 already stated every B9 invariant. So B9 = the spec
fold + an explicit gate, not a rewrite.

**Built:**
- Spec: `browser-host.md` (already `status: legacy`) now points at VTN14 as the
  normative browser node profile and records the "divergent holder" fork closed;
  VTN14 gains a B9 note declaring it subsumes the standalone browser-host protocol
  and inherits B6 (write-set scope) / B7 (warm cache-fill) / B8 (gossip).
- Gate in `tests/shadow-browser-node.test.ts`: the browser advertises no broad
  capability (empty Blooms); a durable browser turn commits at the SERVER scope
  (server-validated); two browsers racing the same cell converge to the single
  server authority — no divergent holder (`worldFor(each) == relay authority`).

## Validation

typecheck clean; `npm test` 306/306; `gate:authority` 2/2; browser-node suite
56/56; spec guard green (no "shadow" token in the v2 spec). Comprehensive local
smoke: `npm run test:full` + `npm run smoke:cf-local` (recorded at session end).

## Phase B status — NOT complete; B10 is BLOCKED

Be precise about what this branch is: a **solid B6/B7 base** (production-relevant
substrate: write-set commit-scope selection, warm cache-fill, closure retirement)
**plus a B8/B9 local + spec slice**. It is **not** a finished Phase B base.

The canonical plan (`notes/2026-06-01-a0-a1-landed.md`) defines B8 as *retiring the
static route table behind gossip* and B10 as *deleting the compensating
mechanisms once B6–B9 hold*. Two production wirings are explicitly **deferred**
and are therefore **not done**:

- **B8 — production static-route retirement.** The deployed worker gateway still
  submits to a statically-selected commit scope; gossip ranking is load-bearing
  only on the in-process/relay + browser-delegation paths. The static route table
  is **not** retired in production.
- **B7 — production warm-transfer install.** The authoritative reply carries the
  verifiable warm transfer, but the deployed MCP/REST gateway does not yet install
  it into its relay client (the install target should be the B8 gossip-selected
  node).

**Therefore B10 is blocked.** B10 deletes scaffolding (preplan-authority pre-step,
the checkpoint→catch-up→repair→seed ladder, the static route table) — but those
only become safe to delete once B8/B7's production wirings replace them on the
deployed path and a real Cloudflare smoke validates it. Deleting them now would
remove the mechanisms still carrying production. The next step is **not** B10; it
is promoting the two deferred wirings to the worker path and smoke-validating
them.
