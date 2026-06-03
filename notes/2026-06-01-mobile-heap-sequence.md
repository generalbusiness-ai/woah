# 2026-06-01 — Sequence toward the gossip-routed mobile actor-local heap

**Target (ratified):** *deterministic VM turns over a mobile, actor-local object
heap.* Authority is the ordered effect-transcript stream; execution is placed
wherever the whole turn runs cheapest; state follows execution by caching every
miss; routing is capability gossip, not a location oracle; placement carries no
semantic meaning.

**Status note (2026-06-03):** This is the sequence document, not the as-built
ledger. Current implementation status is recorded in
`notes/2026-06-01-a0-a1-landed.md`,
`notes/2026-06-01-b6-write-set-scope.md`,
`notes/2026-06-01-b7-state-transfer-warmfill.md`, and
`notes/2026-06-01-b8-b9-gossip-browser.md`.

Supersedes the earlier option-(b) framing. The early steps are the same work, but
their **end state differs**: not "one copy," but **many derived copies, exactly
one authority per cell.** Mobility *requires* that discipline — a node
that may hold any subset of cells, receive transfers from untrusted peers, and
have execution migrate to it cannot tolerate hand-maintained parallel state or
convention-only hint/authority distinction.

## Two ordering invariants (both must hold for every step)

1. **Foundation, not throwaway.** Every step builds a substrate the mobile heap
   needs. Nothing here is a compromise toward fixed assignment that gets ripped
   out later.
2. **Remove-before-honor.** Each step removes a structural invariant before the
   next step would otherwise have to honor it in N places. The mobility machinery
   (Phase B) must not be built on incoherent copies — that is the exact
   multiplication trap that produced the current bugs.

**Standing rule:** no new mechanism on the sparse-shard / cache path (no new
phase, cache, or pre-step) until Phase A completes. A fix now replicates across
copies; the same fix after A touches one derivation.

---

## Phase A — Substrate the mobile heap cannot exist without

These establish claims 1–2 of the model (authority = effect stream; turn =
atomicity unit) and the cell discipline (3 storage roles, content-addressing)
that claims 3–5 ride on.

### A0 — Ratify target in spec (paper)
Write the mobile-heap target as the normative head of
`spec/protocol/v2-turn-network.md`, demoting the DO-per-scope reading to "current
partial deployment." Mark which existing `shadow-*` modules are
substrate-for-the-target vs single-node scaffolding to be generalized.
*Kind: decision. Closes: ambiguity that lets fixes serve the wrong architecture.*

### A1 — Multi-node simulator as the inner-loop gate (pure addition)
Promote the Phase-2 "single-process v2 node simulator" (multiple nodes, forced
cache misses, state transfer, ad routing — `shadow-turn-network` already sketches
it) to a **required pre-commit gate** for any authority/cache/fanout/routing
change, fast enough for the inner loop (`npm run gate:nodes`). The current
`cf-local-walkthrough` is the minimum viable version; the target is a harness
where execution placement, transfer, and refusal are all exercised.
*Why first: every Phase-A/B change is behavior-changing on multi-node topology;
`npm test` is single-process and cannot see "two copies disagreed" or "turn
mis-routed." This is the only thing that makes the rest gate-validatable. Zero
behavior risk.* *Closes: green-but-wrong on multi-node.*

### A2 — Transcript is the sole authority; one applier (bedrock of claim 1)
Derive **every** materialization (executable view, projection rows, edge caches)
from the same applied effect transcript. Delete the parallel hand-maintained
applier (the "keep parallel with `applyPropWrite`" twin). Until this holds,
"placement carries no meaning" is false: the executable mirror is mutated
independently of the stream.
*Why before everything below: claims 3–5 (write-set scopes, gossip, transfer)
all assume state is a pure function of the transcript stream. Build them on a
hand-maintained mirror and every mobility feature inherits the drift.* *Closes:
dual-write drift (transcript-apply vs projection-write divergence).*

### A3 — Provenance + content-address as non-optional cell/page types
Every cell/page carries `{source: authoritative | projection | cache | fallback,
content_hash, source_head}` as a **required discriminator**. The planner
**structurally refuses** to plan from non-`authoritative` cells. This replaces
the scattered `isMcpGatewayShardHost(...)` checks and prose with one type.
*Why here: in a mobile heap, nodes gossip ads and receive transfers from peers
that may be stale or untrusted — "is this row authority or a cache hint?" must be
a type the receiver checks, not a host-identity convention. This is where the
merged `preplan-authority` insight ("sparse stub ≠ authority") is decomposed and
relanded as a type.* *Closes: cache/stub read as authority — the root confusion
behind step-2, the checkpoint thrash, and the preplan regression.*

### A4 — contents-as-projection, location-as-truth (CA2/CA3)
`live:location:<obj>` is the single authoritative write a movement validates;
`contents(room)` is a derived per-member projection, **never on the
commit-validation path.** Retire the single mutable ordered `contents` cell as
authority.
*Why required by the target specifically: in the mobile heap a room's contents is
"a projection assembled from multiple actor shards" — it cannot be one
authoritative mutable cell. This is not a fixed-assignment convenience; the
target's containment model demands it.* *Closes: the entire `read_version_mismatch`
/ contents-order / contents-drift / live-snapshot-rebase family — including the
merged preplan regression.*

### A5 — Every non-authority view becomes a content-addressed read-through
With one applier (A2), typed provenance (A3), and contents off the validation
path (A4), collapse the **accidental** copies: delete `authorityCheckpoints`
(a RAM cache of the projection cache with a second applier — already missed its
prod budget), fold the REST-relay serialized blob into the single executable
view, drop per-seq snapshot blobs in favor of content-addressed pages + frame
tail. Result is **not** "one copy" — it is many derived caches, each a
content-addressed read-through keyed on `source_head`, exactly one authority per
cell.
*Why last in A: with A2–A4 done this is mostly deletion, not reconciliation. It
produces the substrate mobility rides on — a node may hold any subset of
provenance-marked cells.* *Closes: the "N copies under N freshness rules" family;
removes the surface behind step-2's budget miss.*

**End of Phase A:** authority = the transcript stream; state is a pure derivation
of it; every copy is provenance-typed and content-addressed; the worst cell is
out of validation. This is the mobile heap's substrate — and, not coincidentally,
a correct simple system on its own.

---

## Phase B — The mobile-heap machinery (now buildable safely)

Each of these is one of the model's distinguishing claims. They are deferred to
here because each depends on the clean substrate; building any of them on
Phase-A-incomplete state recreates the multiplication.

### B6 — Commit scope chosen by write-set (claim 3)
Generalize from "single owner DO + CA3 location" to write-set-derived scope
selection: actor-private, quiet-room-collocated, contested-room, service, or a
minted combined/temporary scope; with explicit rules + epoch fencing for
multi-scope turns. *Depends on: A2 (clean apply), A3 (provenance), A4 (location
authority). Closes: home-host-as-atomicity-boundary rigidity.*

### B7 — State transfer as first-class verifiable cache-fill (claim 5)
Make content-addressed projection/delta/closure/page transfer the real
post-execution path: receiver-authorization-filtered, content-hash + receipt
verifiable, never granting write authority. Resolve the four transfer modes
(retire or realize the dead `closure` mode). *Depends on: A3 (content-address +
provenance), A5 (read-through substrate). Closes: per-miss cold remote re-reads;
"warm the caller" becomes structural.*

### B8 — Capability gossip routing (claim 4)
TurnKey extraction from command planning; `ExecCapabilityAd` (`covers`/`accepts`
Bloom + opaque `factor` + scope/epoch/head + TTL); multi-node ranking
(`latency + factor + transfer + failure-penalty`); refuse-cheaply on false
positive. The single-node `capability-ad` / `turn-key` / `shadow-turn-network`
scaffolding becomes the real routing layer; the static route table is retired
behind it. *Depends on EVERYTHING: clean authority (A2), provenance (A3),
transfer (B7), write-set scopes (B6) — which is why it is last among structural
work. Closes: the location-oracle on the hot path; enables discovered/mobile
placement.*

### B9 — Browser/edge as a real narrow-authority node (Execution + Live)
Fold the divergent browser holder into the same node model: a node on the
Execution and Live planes, may execute for its actor/subscribed surfaces, may not
commit without scope validation, receives only authorized transfers, advertises
nothing (or one narrow session-local ad). *Depends on: B6–B8. Closes: the
"browser is a divergent holder protocol" fork.*

### B10 — Retire the compensations (pure deletion)
Once B6–B9 hold: the `preplan-authority` pre-step (its insight is now A3's type,
its regression dissolved by A4); the checkpoint→catch-up→repair→seed ladder
(subsumed by A5 read-through); the static route table (subsumed by B8 gossip);
the single-node-only scaffolding that B7/B8 replaced. *Closes: the compensating
mechanism layer entirely.*

---

## Disposition of merged `preplan-authority`
Keep merged; **decompose during A3–A4**, do not extend. Its correct insight
("sparse stub ≠ authority") relands as the A3 provenance type. Its
`read_version_mismatch` regression is dissolved by A4 (contents off validation).
Do not add a sixth compensating mechanism to harden it in the meantime
(standing rule).

## Interim discipline (prevents regrowth between steps)
- **Invariant ledger:** a maintained list of "things that must agree." PRs that
  *add* an entry need explicit justification; structural steps *remove* entries.
  Multiplication becomes visible.
- **Gate rule:** no authority/cache/fanout/routing change merges without the A1
  multi-node gate green.
- **No-new-mechanism rule:** nothing new on the sparse-shard/cache path until A5.

## One-line order
Ratify (A0) → multi-node gate (A1) → transcript-sole-authority + one applier (A2)
→ provenance/content-address as type (A3) → contents-as-projection (A4) →
read-through collapse (A5) ‖ write-set scopes (B6) → verifiable transfer (B7) →
capability gossip (B8) → browser-as-node (B9) → delete compensations (B10).
Phase A is the substrate the mobile heap requires; Phase B is the mobile heap.
Every step is a foundation, none is throwaway, and no mobility machinery is built
on copies that can disagree.
