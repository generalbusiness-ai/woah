# 2026-06-04 — Quasi-static topology pre-seeding (cold-start neighbor lineage)

## Problem

Post-presence-lease, the cold cross-actor MCP smoke wall is `ensure` (54%) +
`submit` (43%), not authority. Inside `ensure`, a measured `~2.8s
authority-slice → the_deck` cross-host RPC fires on a cold `the_chatroom:enter`.
`the_deck` is a *neighbor* room (an exit destination), never written by `enter`
— it is only a quasi-static read dependency (CA5.4: exits, lineage, destination
`acceptable`). The fetch is avoidable: the topology is known, near-static, small.

Same class as the long-standing `dangling_parent_ref` (scope-instance lineage
not reaching shards). Perf-plan step 1 (universal `$actor`/`$thing` class lineage
closure) is done; this is the deferred step-2 residual: **scope-instance
topology**.

## Design (agreed with user, refined during investigation)

Pre-seed the bounded one-hop topology closure of served scopes into the cold
gateway world as **owner-deferring** provenance pages. Spec: `cell-authority.md`
**CA11.2**.

### Confirmed facts (this investigation)

1. **Provenance vocabulary already exists** (`shadow-state-pages.ts:76`):
   `AuthorityPageSource = "authoritative" | "projection" | "fallback" | "cache" |
   "gossip"`. CA11 precedence ranks `authoritative > projection > cache >
   fallback > gossip` (`cell-authority.md:490`). Owner-authoritative is admitted
   unconditionally even for a held id (`persistent-object-do.ts:4744`), so a
   repair turn refreshes a seeded page; a seeded page never displaces an owner
   row.

2. **The chase is narrow.** Cold `the_chatroom:enter` reads (prereq-2 trace):
   the entered room's `exits` cell, the exit objects' `dest`, and one-hop
   destination `object_lineage` ONLY. Destination `contents`/`exits`/verbs are
   NOT read on enter (they're second-hop). Catalog `$`-class verb bytecode
   (`acceptable`/`enterfunc`) is durable-catalog state delivered on first open,
   not a per-cell chase.

3. **The entered scope is the commit scope.** `the_chatroom`'s own authority
   (incl. dynamic `next_seq`/`subscribers`) must come from its owner for the
   write — that fetch is unavoidable and MUST NOT be seeded (dynamic cells would
   be stale immediately). Only NEIGHBOR lineage (never-written) is seedable.

4. **Bundled topology is available in-process.** `createWorld({})` (default
   catalogs) materializes `the_chatroom`/`the_deck`/`the_garden`/`the_hot_tub`/
   `the_taskboard` + exit objects (118 objects total, cheap, cacheable).
   `createWorld({ catalogs: false })` (what `mcpGatewayActorSupportObjects` uses)
   has none. So the bundled scope topology can be computed once, like the
   actor-support closure, generically ("scopes with an `exits` property"), not a
   hardcoded room list — respecting layering.

5. **The local/remote classifier requires the full chain.**
   `mcpGatewayLocalAuthorityPayload` → `localObjectLineageIsComplete`
   (`persistent-object-do.ts:6708`) keeps a non-`$` id local only if EVERY
   ancestor to `parent:null` is resident. A cold shard holds only `$actor`/
   `$thing` (+ session actors). `the_deck → $chatroom → $room → $space` — the
   catalog classes are ABSENT. So the closure must ALSO seed the shared
   catalog-class chain (`$space`/`$room`/`$chatroom` + room subclasses) as
   owner-deferring rows, so `localObjectLineageIsComplete(the_deck)` passes. The
   chain is small and shared across all rooms. This does NOT broaden the
   universal support ROOTS set (`MCP_GATEWAY_ACTOR_SUPPORT_ROOTS` stays
   `$actor`/`$thing`); the roots guard stays green. Separate, orthogonal
   invariant.

### Injection points (from delivery-wiring trace)

- (a) Make neighbor lineage locally resolvable: merge the served-scope topology
  closure into `objects` in `mcpGatewayShardSerializedWorld`
  (`persistent-object-do.ts:6790`, beside the actor-support merge), bounded to
  the shard's served scopes (sessions' `activeScope`). Value-trace + parent walk
  read `world.objects` only (no side-store), so the rows must land there.
- (b) Stamp owner-deferring at slice export: NOT in `world.ts:6583`
  (`exportAuthoritySlice` correctly stamps genuinely-resident rows
  `authoritative`). Re-stamp in `mcpGatewayLocalAuthorityPayload` after
  `exportAuthoritySlice` via `withAuthorityPageProvenance` (`authority-slice.ts:161`)
  with a per-page callback returning `{ source: "projection"|"cache",
  source_host: <real owner> }` for seeded topology ids.

### Staleness safety

Seeded pages carry mint-time cell version. A move's CA5.4 read-dep validation at
the owner detects a topology edit → `E_STALE_AUTHORITY`/read-version retry →
repair-then-replan. Never silent wrong movement. A pure read may observe stale
topology until the next move (CA6 quasi-static window) — accepted, specced.

## Verification trace

The branch first pinned the exact fetch trigger. `the_deck` enters
`requestedIds` through the gateway value-trace once the cold shard has the
served room row, and `mcpGatewayLocalAuthorityPayload` partitions it remotely
because `localObjectLineageIsComplete(the_deck)` fails at the absent
`$chatroom`/`$room`/`$space` chain. Seeding `the_deck` plus the catalog class
chain makes the classifier treat it local, so the read path performs no
cross-host `authority-slice` RPC for the neighbor.

## Trigger CONFIRMED + a deeper constraint found (first impl attempt)

A first implementation attempt (preserved on branch
`scope-topology-seed-agent-wip`, commit `33fee81` — harvest-only, not merged)
confirmed the fetch trigger and surfaced a second-order failure that sharpens
the design.

**Confirmed:** on a cold `the_chatroom:enter`, `the_deck` is partitioned to a
remote owner because `localObjectLineageIsComplete(the_deck)` is false (chain
dangles at the absent `$chatroom`/`$room`/`$space`). New harness-independent
metric `authority_slice_partition` makes this observable (the cf-local harness
masks the wire RPC behind a commit-scope snapshot fallback, so the partition
*decision* is the only reliable signal). Seeding `the_deck` lineage + the shared
catalog-class chain drives it out of the partition. Confirmed good.

**Deeper constraint (the stall):** a seeded lineage-only `the_deck` is correct
as a NEIGHBOR, but it **poisons the relay/commit-scope snapshot** once an actor
later OCCUPIES `the_deck`. When `the_deck` becomes the served/commit scope,
`mcpGatewayLocalAuthorityPayload` exported the seeded lineage-only row into
`localIds`; that row (no `exits`) seeded the `the_deck` commit-scope open
snapshot; a subsequent move *out* of `the_deck` read the exits-less snapshot and
broke. The first attempt tried per-turn EVICTION of the seeded row — which
thrashed (seed/evict churn across turns) and stalled.

**Correct rule (now normative in CA11.2):** no eviction. A pre-seeded id that is
a current served scope (∈ sessions' activeScope) MUST be excluded from local
authority export, so it is fetched fresh from its owner and the open
seed/snapshot carries the owner's full `exits`-bearing row. The resident seed row
may stay (harmless gap-filler for other actors holding it only as a neighbor); it
simply must never be *exported as authority* for the occupant. This touches the
A5 relay/commit-scope-snapshot path the in-memory checkpoint was removed from —
the open seed must not capture a lineage-only pre-seed for a served scope.

## Implementation result

The clean implementation on `scope-topology-seed` keeps the useful pieces from
the stalled attempt (`authority_slice_partition`, `scope_topology_seed`,
`mergeTopologySeedObjects`, and the reproduction test) and drops eviction,
seed/evict churn, and debug probes. It adds:

- bundled-topology closure discovery, bounded to served scopes;
- cold-load injection beside the actor-support merge;
- owner-deferring provenance re-stamp at local export;
- served-scope exclusion from local export and topology refresh-suppression;
- movement-destination owner repair (`missing_state_repair`) for a destination
  that is discovered only while the VM is planning a move;
- opt-in enforcement only for the gateway path, whose repair pass can force an
  owner refresh.

The B6 concurrent movement regression exposed the destination-repair half of
the occupancy rule: bidirectional rooms mean a currently-served room can also be
a seeded neighbor of the room an actor occupies, and the next destination is not
known before the VM resolves the exit. `movetoActorChecked` now raises
repairable `E_NEED_STATE` when a move would enter a projection-sourced scope,
and the repair pass disables topology suppression for the named missing state so
the owner row displaces the seed before replanning.

## Status

- CA11.2 is aligned with the implementation, including the occupancy-transition
  rule, movement-destination repair, full class-chain seeding, and opt-in
  gateway enforcement.
- Local gates on the branch passed before merge review: `npm run typecheck`,
  `npm test`, `npm run test:worker`, `npm run gate:authority`, and
  `npm run test:full`.
- CF performance measurement remains the acceptance signal for whether the
  cold neighbor authority-slice fetch was removed in production without adding
  unacceptable occupancy-repair cost.
