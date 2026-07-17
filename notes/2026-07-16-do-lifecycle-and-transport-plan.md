# DO lifecycle + transport rework — implementation plan

Origin: review of the substrate against Cloudflare's "Rules of Durable
Objects" best practices (2026-07-16). Two priorities came out of it with
spec work now drafted:

- **Track A — scope retirement / storage lifecycle** (spec:
  coherence.md §CO17, cloudflare.md §R1.9, net-cutover.md §NC9, CO6
  `E_SCOPE_RETIRED`). Today no net DO ever calls `deleteAll`; every room
  and actor cluster that ever existed retains billed SQLite storage
  forever. Unbounded cost curve → highest priority.
- **Track B — transport contract and native-RPC binding** (spec:
  protocol/transport.md TR1–TR9). Replace the signed-HTTP-over-`fetch()`
  internal surface with one generic DO-native RPC entrypoint, keeping
  the `Host.rpc` seam so a future non-DO transport is a new `Host`
  binding, not a rewrite. Removes the route-guard-enumeration security
  bug class (the July bearer-leak P0 was an instance).

Also queued from the same review, smaller, not planned here:
constructor DDL version-stamp skip (cold-start latency; CommitScopeDO
17 DDL statements, NetScopeDO PRAGMA migrations, NetGatewayDO
DDL+ALTER on every wake), the spec-vs-code drift on
`PersistentObjectDO`'s absent `alarm()` handler (spec R7), and a check
whether the browser client sends WS heartbeats that defeat gateway
hibernation (if so, wire `setWebSocketAutoResponse`).

Discipline: worktree per track (`.claude/worktrees/scope-retirement`,
`.claude/worktrees/net-transport`), no commits to main, specs and tests
land with the code, migrations idempotent.

---

## Track A — scope retirement

Priority order within the track; A1–A5 are one deliverable (room-scope
retirement end to end), A6+ follow.

**A1. Taxonomy.** Add `E_SCOPE_RETIRED` to `src/net/errors.ts`; the
CO12.7 taxonomy gate picks it up. Terminal classification in the
gateway's error map (not 503 — it must not read as retryable
backpressure).

**A2. Retirement mark.** In the scope shell: when a committed turn's
transcript recycles the scope's anchor root (the projection applier
already sees lifecycle writes), write a `retired_at_head` meta row in
the same `transactionSync` as the commit. All subsequent `/submit`,
`/adopt`, `/relate`, `/seed` handlers check the row first and answer
`E_SCOPE_RETIRED`. `/head` and `/closure` likewise (CO17 lists the
refusing routes; reads refuse too — the tombstone is the durable
answer, not the scope).

**A3. Retirement drive.** Extend the existing alarm-driven outbox drain:
when `retired_at_head` is set and all lanes are empty, run
tombstone-then-reclaim:
  1. write the copy-#3 tombstone — replace `net:seed:<scope>` in
     `HOST_SEED_KV` with `{retired: true, head, catalog_epoch}`
     (gateway currently owns KV seed writes; scope needs the binding or
     asks a gateway — decide in-worktree; simplest is giving the scope
     shell the KV binding, it is already env-visible),
  2. `storage.deleteAlarm()`, `storage.deleteAll()`.
Each step idempotent; re-activation after a crash re-derives position
(meta row present + lanes empty → resume at tombstone; storage empty →
done).

**A4. Gateway cold path.** In `/net/pull` (gateway-do.ts ~824): a KV
read that returns a tombstone surfaces terminal `E_SCOPE_RETIRED`
instead of falling through to live seed; the seed-write path refuses to
overwrite a tombstone at the same epoch. Outbox senders
(`scope-do.ts` drain): treat `E_SCOPE_RETIRED` like the
catalog-mutation terminal-acknowledge — advance high-water, drop the
row.

**A5. Tests (vitest, fake-DO lane first, then workerd).** The CO17
conformance lane: retire a scope with outbox backlog; kill between each
step pair via `WOO_NET_FAULTS` `kill_after_commit`/`error`; assert
stale-gateway submit → `E_SCOPE_RETIRED`, peer outbox
terminal-acknowledges, tombstoned name refuses re-seed, storage empty
after. Add to the curated `npm test` list (a gate only in `test:full`
does not hold the line). Then `smoke:cf-dev` addition: retire a room in
the shared scenario epilogue.

**A6. Cluster scopes.** Wire actor-account deletion
(identity/provisioning path) to the same mark. Separate PR; room scopes
prove the machinery.

**A7. NC9 decommission (operator work, after NC8 bake).** Traffic gate
via AE by class → code removal deploy → verified export →
`deleted_classes` migration via `npm run cf:migrations`. `CommitScopeDO`
first. This is the reclaim for the *retired stack*; A1–A6 is the
steady-state lifecycle for the live one.

Risks / decisions to make in-worktree:
- Who writes the KV tombstone (scope directly vs via gateway) — A3.
- `/head` refusal ordering vs gateways that cache head: ensure a
  retired answer can't be confused with a cold scope by an old gateway
  build (deploy ordering: gateway understands `E_SCOPE_RETIRED` before
  any scope can emit it — ship A4 recognition in the same deploy or
  earlier).
- Drain liveness when a subscriber is dead: CO17 leans on existing
  dead-subscriber pruning; verify the prune bounds retirement latency.

## Track B — transport

**B1. Typed route map (independent win, no behavior change).** In
`src/net/`: a `NetRouteMap` type (route → `{req, res}` bounded by
`JsonValue`) and a typed wrapper over `Host.rpc`. Callers migrate
mechanically. This is TR3's "type safety from the shared table" and it
improves the *current* HTTP binding immediately.

**B2. `netCall` entrypoint.** `NetScopeDO` and `NetGatewayDO` extend
`DurableObject` (constructor signature `(ctx, env)` — mechanical; they
already take `(state, env)`), add
`async netCall(route, body): Promise<JsonValue>` delegating to the same
internal dispatch the `fetch()` handler uses today. No route logic
moves. Wrangler compat date (2026-04-01) already supports RPC.

**B3. Binding switch.** `WorkerdHost.rpc` gains the native path: resolve
stub, `raceAbort(stub.netCall(route, body), signal)` under the same
`NET_RPC_TIMEOUT_MS` deadline, same metrics, same fault injection
(TR8 applies before the call, binding-independent). Flag-gated
(`WOO_NET_RPC_NATIVE`) only for the transition lanes — the flag dies at
B5 per the CO7 no-alternate-designs posture. Note the semantic
difference: fetch-abort cancels the subrequest, RPC race does not;
TR5/CO2.5 already make that safe (idempotent replay), but the
`net_rpc` timeout metric should distinguish the binding while both
exist.

**B4. Lanes.** Fake-DO harness implements `netCall` directly (simpler
than the fake fetch it replaces); `NET_RESOLVE` returns objects with
`netCall`. Run the shared scenario on fake + workerd with native on;
then the deployed canary lane.

**B5. Close the HTTP surface.** Remove `/net/*` routes from both DOs'
`fetch()` dispatch (fail-closed 404 — TR9.4 gate: a test asserting no
`/net/*` route is fetch-servable). Retire `signInternalRequest` on the
DO-to-DO path. `fetch()` remains solely for the gateway WS upgrade.
`WOO_INTERNAL_SECRET` scope shrinks to whatever edge-worker surfaces
still need it (v2 legacy until NC9) — document remaining consumers when
we get there.

**B6. Gates.** `tests/worker/net-turn-structure.test.ts` must hold
unchanged (RPC count semantics identical); taxonomy gate; TR9.3
type/grep gate (`src/net/` imports nothing from `src/worker/`);
`test:worker` + all three smoke lanes before any deploy.

Ordering across tracks: B1 can land any time. A1–A5 before B2+ (smaller,
higher urgency, and the retirement lane then exercises the native
binding for free when B lands). The deploy that first emits
`E_SCOPE_RETIRED` must not precede the gateway build that understands
it (see A risks).
