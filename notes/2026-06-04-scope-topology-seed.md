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

## OPEN before implementation

**Pin the exact fetch trigger.** Prereq-2 says `the_deck` enters `requestedIds`
via the value-trace; the delivery trace says the gateway resolves it via
Directory → owner → RPC. But the trace reads `world.objects` only, and on a cold
shard `the_deck` is NOT local — so confirm whether `the_deck` enters
`requestedIds` from the gateway's own trace (after it has `the_chatroom`) or from
the `the_chatroom` owner's authority-slice RESPONSE (off-mode lineage ref the
gateway then re-resolves). The fix only works if seeding `the_deck` + catalog
chain makes the classifier treat it local. A reproduction test instruments
`requestedIds`/`reconstructionReason` to confirm before the larger change.

## Status

- CA11.2 spec delta written; CA11.1 currency note added (A5 removed the
  in-memory checkpoint).
- Implementation + the 5 CA11.2 conformance tests pending the fetch-trigger
  confirmation.
