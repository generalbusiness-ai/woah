---
date: 2026-07-05
status: adopted (normative contract for Plan 002 / `src/net/`; implementation in progress)
---

# The Coherence Layer

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**.
>
> This is the normative contract for `src/net/` — the distribution layer that
> replaces the v2 turn network under
> [Plan 002](../../plans/002-simplest-deployable-system.md). It carries
> forward, unchanged, the ratified semantics of
> [v2-turn-network.md](v2-turn-network.md) (VTN) and
> [cell-authority.md](cell-authority.md) (CA), and drops everything that was
> mechanism rather than semantics. Where this document and those drafts
> overlap, **this document governs**; the older documents remain as design
> history and are marked superseded-by for the carried parts. The rationale
> and the essence/accident analysis live in
> `notes/2026-07-04-simplest-system-plan.md` and its stage notes.
>
> Style rule inherited from VTN0: no section below may introduce a mechanism
> that creates a second write path to a cell, or that lets a
> non-authoritative copy satisfy a plan/commit read (CO2.1). A change that
> hardens today's fixed scope assignment in a way that blocks later mobility
> (CA10/CA13) is a regression against CO11.

## CO1. Roles

Three runtime roles, one turn pipeline (CO7), five named state copies (CO5).

```
client (projection consumer + optimistic echo)
   │ observations / projections        │ intents
   ▼                                   ▼
GATEWAY  — session edge: auth, planning, derived cache (incl. the MCP
           tool-surface projection), fanout delivery
   │ envelope = transcript + read-closure (the only shape; CO7)
   ▼
SCOPE    — the authority: one sequencer per commit scope; validates,
           commits, owns the cells anchored to it; durable outbox;
           scheduled-turn alarms and parked-task resumption (CO2.8)
   │ routing hints + leased presence projection
DIRECTORY — routing hints + leased session/presence projection (never authority)
KV        — epoch-stamped cold-start seeds (read-only fallback)
```

The **scope is the object home**: an object's cells live in exactly one
scope at a time (anchor-cluster model; actors and their carried objects
anchor to the actor's scope per CA6). There is no separate per-host
whole-world image. The pipeline is written against a `Host` interface with
three bindings — in-process (dev server, tests, browser echo), workerd
(Cloudflare DOs), SQLite (local single-process) — so the same composition
runs in every mode and only the Host differs.

## CO2. The invariants

This section is the complete semantic contract. Everything else in this
document is schema, registry, or budget in service of these eight clauses.

### CO2.1 The coherence invariant (CI)

Carried verbatim from VTN0:

> For every durable cell there is **exactly one authority** (the committing
> commit-scope head). Every other materialization of that cell is a
> **derived projection**: content-addressed, carrying explicit `source`
> provenance, and a pure read-through of the transcript stream at a known
> `source_head`. No two copies of a cell may be mutated by independent write
> paths. A derived copy is never used as a write-authority source.

In this layer the CI holds **by construction**: every page type carries its
provenance at the type level from first seed (there is no un-provenanced
state, so the presentation-stub refusal machinery of CA11 has no
counterpart here), and the only durable stores are the five registered
copies of CO5.

### CO2.2 Turn atomicity

The VM turn is the unit of atomicity — not the object, not the user task. A
turn commits or rolls back as a whole; it is never half-local, half-remote.
A state miss is a **pre-execution** failure: abort before committing,
acquire state, retry the whole turn.

### CO2.3 Commit scope by write set, with ride-along

The commit scope is chosen by the turn's write set — the smallest ordering
authority that makes this turn's writes atomic:

- A turn whose writes are all anchored to one scope commits there. Pure
  movement (write set = the moved object's `live:location` cells, CA3)
  commits at the moved object's own scope, off the room sequencer.
- **Ride-along (CA3, carried verbatim):** a turn that also writes a
  shared (room-owned) cell commits at the planning scope, which serializes
  that shared cell; the actor-location write rides along atomically.
- A write set spanning **two distinct shared scopes** is rejected with
  `E_SCOPE_SPLIT` (CO6) — a named limitation, not a silent commit to the
  planning scope. Lifting it is the CA10 growth path (CO11).

**Rider integrity (amendment, 2026-07-06).** Ride-along writes touch cells
whose authority is another scope; three rules keep CO2.4 intact across
that seam:

1. **Attested rider reads.** A transcript that READS a rider cell must
   carry an owner attestation `{cells: [{key, version}], owner_head}`
   fetched from the owning scope at plan time (`POST /net/attest` — one
   async RPC off the validation path). The committing scope validates
   rider reads against the attestation; a rider read with no attestation
   rejects `rider_unattested` (terminal, named). The committing scope's
   `owns` predicate scopes what it validates against its own store.
   The catalog scope has one explicit epoch-validation policy: because CO15
   permits **class-definition cells** to change only with a `catalog_epoch`
   bump, the active epoch itself certifies lineage, property-definition/default,
   and verb cells that the turn's lineage closure proves belong to classes.
   Their versions are content addresses, so a gateway MAY construct the
   attestation from its derived cell only when that cell's own stamp matches the
   turn epoch. A differently stamped copy falls back to live `/net/attest`; a
   live catalog response MUST echo the authority epoch and mismatch fails
   closed. Sessions, identity records, compatibility instances, and every
   non-catalog owner remain per-turn reads of the live authority even when
   their current scope name is `catalog`. Cross-invocation promises MUST NOT
   coalesce authority I/O: they join otherwise-independent platform request
   lineages and can violate the CO2.7 subrequest-depth bound.
2. **Owner-sequenced adoption.** Rider writes reach their owner via
   `/net/adopt` and are applied as owner-ordered events with a per-cell
   prior-version CAS (the attested version the committing turn
   observed). **Adoption is an owner-sequenced commit: the owner's head
   advances and adopted cells stamp the new head**, so owner observers
   and catch-up see it like any commit. CAS match → clean apply.
   Mismatch → **owner wins**, and the conflict is a named, counted event
   (`net_adopt_conflict`) — never a silent overwrite.
3. **The residual tear is named and bounded.** On a conflict, the
   committing scope's transcript already embedded the stale rider value
   in its post-state; that inconsistency is bounded by the attestation
   window, observable via the conflict count, healed by the next
   read-version repair on the cell, and eliminated structurally by CA10
   route migration (CO11). The committing scope's residual copies of
   rider cells are **derived**, never authoritative, at every transfer
   exit.

### CO2.4 Read-version validation

A committed turn's reads must match current authority state at validation
time, unless a scope-epoch validation rule (policy, never a caller hint)
explicitly permits a stale projection read. Until such a rule is installed
for a scope epoch, projection reads validate under the same exact-version
rule as semantic reads.

The implemented net profile installs one such rule for CA4 `contents` reads:
they are reads of the owner-maintained relation projection, not authority
cells, and therefore do not participate in commit validation. This exception
does not extend to the authoritative `object_live` reads that constrain a
move, take, drop, or other semantic mutation; those versions must still match
at the commit scope (or through an owner attestation) under CO2.3/CO4. A
catalog that makes correctness depend only on a `contents` snapshot is
non-conforming: it must also read the authority cells on which the decision
depends. The projection may consequently make a read-only listing briefly
stale, but cannot authorize a stale mutation.

### CO2.5 Idempotency

A replayed idempotency key returns the recorded reply. A redelivered fanout
frame is a no-op by scope head. Accepted frames carry the authority's
acceptance timestamp so retried deliveries never mint fresh wall-clock
values.

Fanout carries two distinct monotonic positions. The authority `seq` gates
derived state application and may skip at one subscriber when an authority
event produces no row for that destination. A per-subscriber `delivery_seq`
gates delivery continuity and advances once for each row enqueued to that
destination. Receivers MUST diagnose a jump in `delivery_seq` as a named
fanout gap; they MUST NOT infer delivery loss from a jump in authority `seq`.
Rows without `delivery_seq` remain valid during rolling upgrades but provide
no delivery-gap evidence.

### CO2.6 Materialization miss is not semantic absence

Under sparse execution, a lookup miss for an unmaterialized id MUST surface
as `E_MISSING_STATE` (acquire closure, retry — CO6), never as `E_OBJNF`.
Only a full-closure executor may report semantic absence directly.

### CO2.7 Fanout guarantee

Committed effects reach every derived copy **at-least-once, ordered per
scope, crash-safe**: fanout rows are durable before the commit reply
returns, self-contained (commit + transcript + lineage-closed body, CO7),
drained after reply with bounded backoff, and resumed on reactivation after
a crash or eviction. Actor reply time and peer-visible delivery latency
MUST be independent of audience size; delivery cost is O(distinct occupant
shards), never O(active_sessions).

Destination lanes have no cross-lane ordering dependency and MUST drain
concurrently, while rows within each destination remain strictly serial in
`delivery_seq` order (which also preserves their authority enqueue order).
A slow or backing-off subscriber cannot add its
delivery latency to healthy subscribers' lanes.

An accepted `/submit` and an incoming outbox delivery MUST NOT synchronously
continue an outbox drain in the same platform request lineage. `/submit`,
`/adopt`, and `/relate` persist their fanout/refan rows, arm an immediate
Durable Object alarm, and return; that fresh alarm event drains the next hop.
The submit boundary is necessary because its caller is a gateway and fanout
includes that same gateway: starting even a deferred task before the reply
leaves the scope can form a `gateway -> scope -> gateway` request cycle. These
event breaks are part of the boundedness contract: without them, a valid
chain of submission, owner adoption, relation delivery, and fanout can exceed
Cloudflare's recursive subrequest-depth limit even though each individual
drain pass is row-bounded.

### CO2.8 Durable continuations

Parked tasks (VM `SUSPEND`/`FORK` with serialized frames) and scheduled
turns are **scope state**. The scope sequencer stores the pending queue
durably, sets its alarm to the earliest `at_logical_time`, wakes itself,
and validates a fired turn exactly as a live-submitted one
(`ScheduledTurnRequest`, VTN18.2 carried as written: `schedules` /
`cancellations` are typed transcript arrays, included in the
`post_state_hash` preimage, never fabricated `TranscriptWrite` ops). A
parked task survives DO eviction and resumes via the scope alarm; this is a
conformance gate (CO12), not an aspiration — the v2 worker never
implemented it, so this layer carries the obligation explicitly.

## CO3. The effect transcript

The canonical record submitted for commit validation, carried unchanged
from VTN7 (`woo.effect_transcript.v1`). **Bridge note (implementation):**
the v2 layer's *implemented* transcript kind is
`woo.effect_transcript.shadow.v1` with additional fields
(`route`/`seq`/`stateProbes`/`sessionScopeTransition`/`projectionWrites`);
during the Plan-002 differential-gate era, `src/net/transcript.ts` consumes
that implemented shape through its single bridge import so the two layers
compare like with like. The schema below is the *target* shape; the kind
string graduates to `woo.effect_transcript.v1` at Phase-5 deletion.

```ts
type EffectTranscript = {
  kind: "woo.effect_transcript.v1";
  id: TurnId;
  scope: ScopeRef;
  base: ScopeHead;
  call: TurnCall;
  vm: {
    engine: string;
    catalog_hashes: Record<string, Hash>;
    verb_hashes: Record<string, Hash>;
  };
  inputs: LogicalInputs;
  reads: TranscriptRead[];
  writes: TranscriptWrite[];
  creates?: TranscriptCreate[];
  moves?: TranscriptMove[];
  recycles?: TranscriptRecycle[];
  schedules?: ScheduledTurnRequest[];      // VTN18.2, carried as written
  cancellations?: string[];                // schedule ids to cancel
  observations: WooObservation[];
  result?: WooValue;
  error?: WooError;
  complete: boolean;
  incomplete_reasons?: string[];
  pre_state_hash?: Hash;
  post_state_hash: Hash;
};
```

`TranscriptRead` / `TranscriptWrite` / `TranscriptCreate` / `TranscriptMove`
/ `TranscriptRecycle` / `RecordedWriteAuthority` are carried byte-for-byte
from VTN7, including its rules: every mutation record names the VM frame
whose effective programmer authority performed it (write authority is
validated per-frame, **never** the union of verb owners in the transcript);
`complete: false` transcripts are never accepted as durable turns.

## CO4. Commit validation

A scope validates a submitted transcript in the VTN8 order, carried
unchanged:

1. Envelope authentication and actor/session authority.
2. Scope and epoch match.
3. Idempotency-key replay check.
4. Transcript is complete and targets this scope.
5. VM/catalog/verb hashes accepted for the scope epoch.
6. Logical inputs valid and not duplicated.
7. Read versions match current state (CO2.4).
8. Permission reads and policy checks present in the read set.
9. Writes authorized per recorded VM frame (and any lease/fence token).
10. **Applying the transcript's writes to a clone of validated pre-state
    yields `post_state_hash`.**
11. Receipt recorded and returned.

Two clarifications this document makes normative (they were implicit or
buried in VTN):

- **Validation is post-state re-derivation, not re-execution.** The scope
  never re-runs verb bytecode; it re-applies recorded writes
  deterministically and constructs authoritative post-state from the
  transcript's creates/writes/moves and sequenced-log outcome. The submit
  carries no executor post-state.
- **Doomed-round short-circuit** is permitted exactly as VTN8 bounds it:
  steps 1–9 are pre-state-only; a rejection they determine
  (`stale_head`, `scope_mismatch`, `permission_denied`, and
  convergence-safe `read_version_mismatch`) may skip the apply.
  `incomplete_transcript` and `nondeterministic` are never short-circuited.
- **A current head is not required when the retained recovery tail proves a
  rebase.** Exact `(seq, hash)` match accepts as before. A behind base may
  continue to steps 7–10 only when the scope's bounded recovery tail proves
  that exact head as an ancestor of the current head. Every tail entry records
  both its prior and resulting head hashes, so this is an authority-local
  proof rather than a caller assertion. Current read-version validation,
  write authorization, create-collision validation, and post-state
  re-derivation then determine whether the transcript applies cleanly to the
  current state. A future base, a same-sequence hash mismatch, an unproved
  base, or a base older than the retained proof window rejects `stale_head`.
  This bounded rebase is what permits independent turns planned concurrently
  at one hot scope to serialize without an unconditional re-execution loop.
  It does not weaken a true read/write conflict, which still rejects
  `read_version_mismatch`.

If validation fails, no write from the transcript commits; the gateway
repairs its planning state (per the reply's taxonomy code) and retries the
whole turn within `repair_budget_ms` (CO10).

## CO5. The named-copy registry

**This table is exhaustive and normative.** Any durable materialization of
world state outside these five copies is a bug by definition; a conformance
gate (CO12) enforces it. Every copy is epoch-stamped (CO8).

| # | Copy | Provenance | Freshness bound | Reseed path |
|---|---|---|---|---|
| 1 | Scope authority (ScopeDO SQLite; includes the parked-task/scheduled queue and a bounded recovery tail *that only the scope itself reads*) | `authoritative` | is the truth | — |
| 2 | Gateway cache (GatewayDO SQLite; includes the MCP tool-surface projection, [projection-cache.md PC1](../semantics/projection-cache.md); in-memory views are reads of this copy, not additional copies) | `derived` | stamped `(scope_head, catalog_epoch)` | `E_STALE_EPOCH` → refetch closure from scope |
| 3 | KV seed | `seed` | stamped epoch; may lag | overwritten on checkpoint; consumers head-check with the scope before trusting |
| 4 | Browser cache (IDB/localStorage) | `derived` + `echo` overlay | stamped as #2 | epoch mismatch → drop and rehydrate |
| 5 | Directory session/presence projection (`session_route`: active scope, focus, display fields) | `derived`, leased | presence-lease TTL | lease expiry drops the row; session re-announce rewrites it |

The v2 layer's checkpoint-page tables, accepted-frame replay tail (as a
consumer-readable copy), separate in-memory relay cache, and per-host
whole-world image have **no counterpart** here.

## CO6. The divergence taxonomy

Every retryable or terminal condition this layer can emit is one of a
closed enum with a defined recovery action; the layer cannot emit unnamed
divergence. Tail metrics count by code.

| Code | Meaning | Recovery |
|---|---|---|
| `E_STALE_HEAD` | submitted `base` is future, hash-mismatched, or too old/unproved for retained-tail rebase (incl. cold/evicted-scope reseed) | refetch head/closure, retry |
| `E_STALE_EPOCH` | consumer copy stamped with an old `(scope_head, catalog_epoch)` | reseed that copy, retry |
| `E_MISSING_STATE` | materialization miss under sparse execution (CO2.6) | acquire read-closure transfer, retry |
| `E_READ_VERSION` | read set conflicts with current authority | re-plan against refreshed cells |
| `E_SCOPE_SPLIT` | write set spans two distinct shared scopes (CO2.3) | terminal; named limitation until CA10 |
| `E_CATALOG_MUTATION` | ordinary turn attempted to mutate an installed catalog class definition without advancing the epoch | terminal; publish through the catalog install pipeline |
| `E_LINEAGE` | transfer lacking lineage closure | cannot occur by construction (CO7); assert/alarm |
| `E_BUDGET` | repair budget exhausted | terminal; reply carries the attempt trace (each attempt's taxonomy code) |
| `E_RPC_TIMEOUT` | a cross-authority RPC exceeded its deadline | terminal for this request; retry with the same idempotency key; an ambiguous submit is first disambiguated by one same-key replay |
| `E_SEED_LAG` | KV seed behind scope head | informational; consumer proceeds via head-check |
| `E_EPOCH_MISMATCH` | durable catalog epochs genuinely disagree: a seed against a scope seeded at another epoch, or a turn whose stamp still differs from the scope's durable epoch AFTER the CO8 reseed | terminal; catalog install/migration reconciles (operator concern), never a retry treadmill |
| `E_SEED_COMMITTED` | a seed targets a scope that has already committed turns | terminal; recover into a fresh namespace rather than resetting authority under an unchanged head |

Retryable codes are turn mechanics and never user-visible as failures;
terminal codes surface to the caller with structured detail and an attempt
trace where repair rounds occurred.

## CO7. Envelope and transfer discipline

- **One envelope shape.** A commit submission is the transcript plus its
  **read-closure** — the actor row, session rows, `read_set` cells, write
  preimages, and their lineage closure. Nothing scope-wide, no authority
  slices, no execution capsule, no alternate warm/slim modes. Byte
  ceilings are enforced by construction and by gate: **< 64 KB** warm
  same-scope, **< 256 KB** cross-scope. `line_map`/debug info never ships
  in an envelope or transfer; it is fetched on demand.
- **Lineage closure is part of the transfer type.** A page transfer that
  does not close over `object_lineage` does not serialize (`E_LINEAGE` is
  an assertion, not an operational error). Dangling parent references are
  therefore unrepresentable, not merely gated to zero.
- **State transfer is verifiable cache-fill** (VTN0 claim 5, carried):
  content-addressed, receiver-authorization-filtered, installs into copy
  #2/#4 with `derived` provenance at a stated `source_head`. It never
  grants write authority.
- **Cold path is the normal path run at higher latency,** not a separate
  mode: a cold scope replies `E_STALE_HEAD`; the gateway seeds from KV
  (copy #3, head-checked) or the scope and retries. There are no
  rollout-style feature flags holding alternate designs; configuration is
  limited to budgets and deployment bindings.

## CO8. Epochs

Every durable artifact in copies #2–#5 stamps the epoch of its inputs:
`(scope_head, catalog_epoch)`. Every consumer checks the stamp before use;
a mismatch is a named self-healing reseed (`E_STALE_EPOCH`), never silent
reuse. `catalog_epoch` advances on catalog install/upgrade; `scope_head`
advances per commit. The reseed heals STALE COPIES only: when the durable
epochs themselves disagree — a seed stamped with a different epoch than an
already-seeded scope's meta, or a turn whose stamp still differs from the
scope's durable epoch after a successful reseed — the condition is the
terminal `E_EPOCH_MISMATCH` (CO6), surfaced with its attempt trace instead
of grinding the repair budget; reconciliation is the catalog
install/migration path's job. Idempotent re-seed at the SAME epoch remains
a success. This generalizes the E1 discipline that landed for v2
scope repair, and makes the aged-world lane (CO12) meaningful: an upgraded
world converges by reseeding stamped copies, with the reseeds visible in
tail metrics by code.

## CO9. One write path per fact

Relations — room/container `contents` (CA4), session/audience rosters,
tool-surface rows, and future indexes — are **derived rows produced by a
single projection applier consuming committed transcripts**. They are never
independently written list properties, never authority cells, and never
consulted by commit validation. Presence-dependent fanout audiences are
computed from the session/audience relation filtered through live sessions
(copy #5 leases), never from a global location scan.

## CO10. Service level objectives

Adopted as the system's ratified, falsifiable goals (previously scattered
across planning notes; consolidated by
`notes/2026-07-04-simplest-system-01-goals.md`). Measured on the deployed
profile; enforced pre-deploy by the CO12 gates at the stated structural
level.

| SLO | Value |
|---|---|
| Warm same-scope turn | p50 < 500 ms, p95 < 2 s |
| Cross-scope (movement) turn | p50 < 1 s, p95 < 4 s |
| Peer-visible delivery | < 1 s, independent of audience size |
| Cold session open | < 3 s |
| Warm turn structure | 1 attempt, 1 envelope, ≤ 3 cross-host RPCs on the synchronous reply path, ≤ 8 scope-row writes, 0 authority reconstructions |
| Envelope bytes | warm < 64 KB; cross-scope < 256 KB |
| Repair budget | `repair_budget_ms` = 12 000 ms |
| Asymptotics | CA13 as written: movement O(churn), fanout O(distinct occupant shards), reads O(result_size); never O(world), O(objects_in_scope), O(occupants²), O(active_sessions) |
| Convergence | zero unnamed divergence (every event carries a CO6 code); lineage danglings unrepresentable |

Post-reply outbox fanout is excluded from the RPC budget (it is O(distinct
occupant shards) by design) and bounded by the delivery SLO instead.

## CO11. Stated limitations and the growth path

Named honestly so they are decisions, not surprises:

1. **Single-sequencer rooms.** One sequencer per scope caps a room at
   **tens of concurrent actors**. The growth path is CA13 hot-room
   decomposition and CA10 per-cell authority migration; the C4 load gate is
   the tripwire that decides when. `route.ts` isolates scope selection so
   CA10 slots in without pipeline change.
2. **`E_SCOPE_SPLIT`** (CO2.3): two-shared-scope turns are rejected, not
   committed. Lifted by CA10.
3. **Fixed scope assignment.** Claim-3/4 mobility (write-set-chosen mobile
   scopes, capability gossip) remains the VTN0 target; this layer
   implements the fixed-assignment special case without hardening it
   against later mobility.
4. **Scale posture.** "Millions of nodes" remains the design discipline —
   no global enumeration anywhere in this layer — not a numeric SLO.
5. **The full (`"*"`) closure is unpaged.** It is reserved for
   repair/maintenance state transfer (the cold-open path pulls targeted —
   Phase 4) and is bounded by scope size (CO11.1's room-sized scopes),
   not by a byte/page budget with continuations. A scope large enough to
   need paged repair transfer is the same scope CA13 decomposition
   addresses; paging lands with that work.

## CO12. Conformance gates

All gates live in the curated `npm test` list or the smoke lanes (a gate
that only runs under `test:full` does not hold the line):

1. **CI gate**: post-turn, every node's derived view of a touched cell
   equals committed authority at the same head (multi-node topology).
2. **Registry gate**: no durable write lands outside the five CO5 stores.
3. **Budget gates**: envelope bytes, scope-row writes, sync RPC count,
   reconstruction count — counted per turn by the gateway (threaded
   through the turn's RPC sites, not a shared instance counter, so the
   count survives await-interleaving), attached to the `TurnResult`, and
   emitted as the `net_turn_structure` metric so the deployed profile
   emits the evidence CO10 is measured against. The curated
   `tests/worker/net-turn-structure.test.ts` asserts the warm same-scope
   structure (1 attempt, ≤ 3 sync RPCs — `/head` + `/submit` + the
   post-accept `installTouched` `/closure` — and 0 reconstructions),
   cross-checked against a per-destination RPC log.
4. **Differential gate** (build-time, Plan 002 Phase 2): v2 and `src/net/`
   produce equal committed state and observation streams on the shared
   smoke scenario; divergence is a stop.
5. **Fault lane**: injected RPC latency (100 ms / 1 s), DO eviction between
   turns, cold-owner timeout, fanout redelivery — scenario stays green;
   a parked task survives eviction and resumes via the scope alarm.
6. **Aged-world lane**: build a world through history (install vN, play,
   upgrade to vN+1, replay), then run the scenario; reseeds appear as
   named CO6/CO8 events, never as failures.
7. **Taxonomy gate**: grep/type-level check that no error surface in
   `src/net/` emits outside the CO6 enum.

## CO13. Relations and the projection applier

One write path per fact (CO9), concretized:

- A **relation row** is `relation:<name>:<owner>:<member>` with a small
  JSON body, stored at the scope that owns the relation's OWNER object
  (a sixth scope row family), mirrored into gateway views for reads, and
  fanned to subscribers alongside cells (`FanoutBody.relations`).
- **The applier runs at the committing scope.** On accept, the scope
  derives relation deltas from the transcript: `projectionWrites`
  (contents add/remove), moves (contents of the source and destination
  parents), and session-scope transitions (presence). Local deltas apply
  in the SAME transaction as the commit; deltas whose owner object is
  anchored elsewhere are delivered to the owning scope via the durable
  outbox (`POST /net/relate`, idempotent by `(from_scope, seq)` — a
  high-water separate from `/net/adopt`'s, because one turn can produce
  both facts at the same `(from_scope, seq)`).
- **Relation delivery applies owner-sequenced.** The owner applies a
  delivered batch as one owner event — its head advances once, with a
  `relate:<from_scope>:<seq>` recovery-tail entry (the adoption
  discipline, CO2.3 rule 2) — and refans the applied deltas to its own
  subscribers at the advanced seq. The advance is load-bearing:
  subscriber gateways gate every `FanoutBody` by per-scope seq (CO2.5),
  so a refan at an unadvanced head would silently no-op. An all-no-op
  batch (idempotent re-adds, removes of absent rows) advances nothing
  and refans nothing; the sender high-water still moves.
- **Planning never promotes a relation projection into an authority-cell
  dependency.** In particular, recorded session movement emits one
  `sessionScopeTransition`; it does not read or write the compatibility
  `session_subscribers`/`subscribers` properties while constructing the
  transcript. Materializers derive those mirrors from the accepted relation
  fact. A direct local move may update them eagerly because no sequenced
  transcript will be applied afterward. Likewise, a recorded
  `observe_to_space` names the owner space but does not read its subscriber
  mirrors; owner-side fanout computes the audience from `session_presence`.
  Direct cross-host observation retains the eager audience override path.
  A roster-backed move with `look_deferred: true` applies the pending transition
  to its transient top-level roster and omits redundant `here` hydration; the
  client then performs the declared authoritative refresh. It does not derive
  presence from physical `contents` or dereference disconnected actor clusters.
  Runtime metadata gates that request this projection resolve verbs through the
  same parent-first, then feature-chain order as executable dispatch.
- **Anonymous identity claims preserve CO2.5 across the public retry boundary.**
  A high-entropy timestamped claim bearer routes retries to one gateway and
  deterministically fixes the guest actor, session, and mint timestamp. The
  resulting scope submit therefore retains one idempotency key even when both
  internal reply attempts time out. Invalid, future, or expired claims are
  refused; a claim is never recycled into a fresh identity. Before walking the
  reusable pool, the claim-routed gateway checks every claim-derived session id
  in its durable view and replays an already-live one. Thus an earlier occupied
  seat becoming free cannot make one retry acquire a second pooled identity.
  Because a session bearer must be locally authenticatable, a failed
  post-accept closure fill installs the exact accepted session value as a
  durable derived echo stamped at the returned authority head. The transcript
  remains the only write path; unrelated touched cells stay repair-on-read.
  Elastic guest sessions additionally carry an `ephemeralActor` lifecycle
  marker. When the last live session is gone, the actor-cluster alarm reaper
  advances one owner head, moves that actor's authoritative live cell to
  `$nowhere`, and removes both presence and physical-contents rows at the room
  owner through the durable relation outbox. Explicit close preserves the
  marker and prior room until this reap; a concurrent live session suppresses
  retirement. Seed-pool actors carry no marker and remain reusable in place.
- **Acceptance is not revoked by a failed relation expedite.** The committing
  scope durably enqueues each foreign relation fact in the same transaction as
  its accepted reply. The gateway normally delivers presence relations to the
  room owner synchronously as a freshness fence. If that post-accept delivery
  fails, the response remains accepted, carries
  `relation_expedite_degraded: true`, and emits a named metric; the durable
  outbox converges the owner asynchronously. A dependent roster read may be
  briefly stale in this degraded case, but the caller is never told that its
  already-durable write failed.
- **Relation-owner topology is gateway knowledge** (the
  `rider_destinations` rule): the gateway classifies the transcript's
  relation-owner objects (move endpoints, create locations, contents
  containers, transition rooms) and ships a `relate_destinations` submit
  sibling; the sequencer partitions deltas through it and never learns
  anchor topology itself.
- `contents(parent) = { object | live:location:<object> == parent }`
  (CA4) remains the definitional truth; relation rows are its
  materialization, rebuildable by scanning live cells at the owner (the
  repair path, bounded by scope size — CO11.1). A multi-scope rebuild
  drops candidates whose owner is anchored elsewhere: those rows belong
  at the owning scope, and a local copy would be the CO9 dual write.
- **The gateway mirror** is fed by `FanoutBody.relations` (a commit's
  local deltas, or a `/net/relate` refan) under the same per-scope seq
  high-water that gates cells, plus one coherence companion: a closure
  that advances the high-water carries the scope's relation rows,
  upserted in the same transaction. That is the FULL closure
  (`keys: ["*"]` — the repair/reseed state transfer) and, since the
  ready-to-scale Phase 4, the TARGETED cold-open closure
  (`objects: [...], relations: true` — the named objects' class+anchor
  chains, their actors' session cells, and the roster; the client
  cold-open's cost tracks the session's need, never the scope's size).
  Required because a pull supersedes earlier fanout rows by seq —
  without the rows riding the closure, a pull would silently starve the
  mirror of everything those deliveries carried; a targeted pull's
  un-copied cells are ABSENT at the receiver, and absent is never stale
  (pull-on-miss and read-version checks own them). Upsert-only: a row
  deleted at the authority while the gateway was unsubscribed lingers
  until a later remove delta heals it; a fresh shard's mirror is exact.
  `GET /net/relation?relation=&owner=` is the client-read primitive for
  who/contents.
- **Fanout audiences** are computed from the `session_presence` relation
  (owner = the space, members = live sessions) — CO2.7's
  "O(distinct occupant shards)" gets its production definition here.
  Implemented (Phase 4 item 3) at the RECEIVING gateway: scope-level
  fanout stays per-subscriber (rows go to subscribed shards), and each
  shard narrows the audience itself — an applied `FanoutBody`'s
  `observations` are pushed to the WebSocket(s) of every session whose
  presence row's owner anchors to the fanout's scope, read from that
  shard's own mirror (sessions on other shards are those shards'
  concern). `FanoutBody.turn_id` (the committed turn's idempotency key)
  rides commit-announcing fanout so the shard that submitted the turn
  skips the SUBMITTING session's sockets — that session already received
  the observations on its turn reply (CO14 `/net-api` bullet below).

## CO14. Session authority and authentication

- **A session is a cell** (`session:<id>`, value = the bridge's
  `SerializedSession` row — one shape from seed to mint to fold),
  authoritative at the ACTOR's cluster scope. Minting/refresh/expiry are
  ordinary commits there — one write path (`mintSessionSubmit` builds
  the commit; the gateway's `/net/session-open` submits it directly —
  a mint is a substrate commit with no verb to execute — and installs
  the accepted cell in its view). Session cells are a **net-only
  transcript-cell kind**: the v2 recorder never emits them; the bridge
  (`src/net/transcript.ts`) widens the vocabulary, and only the mint and
  the plan-time fold produce them.
- **The gateway authenticates; scopes authorize.** CO4 step 1
  (`authorize`, `authorizeSessionSubmit`) validates every session the
  submit answers for — each session-kind read plus the transcript's
  `session` field — with the named verdicts `expired` / `missing` /
  `actor_mismatch` / `session_unattested` / `session_required` carried
  in the `unauthorized` reject detail. Three validation sources, in
  order: a transcript that WRITES the session cell (mint/refresh/
  transition) validates the **written value** (demanding pre-existence
  would forbid minting); a transcript explicitly stamped `sessionClose`
  instead proves the currently live, actor-bound **owned** session and
  validates that the replacement is a bounded-expiry, null-scope close
  row (the replacement may already be expired after cross-DO latency);
  an ordinary **owned** session validates from the scope's
  own authoritative cell; a **foreign** session composes the CO2.3
  machinery — session cells are just cells: the submit must carry the
  session read plus an owner attestation, and an attested version equal
  to the read's version proves the read VALUE by content address, which
  authorize then validates semantically. An attested-but-different
  version is NOT an auth verdict: step 7 rejects it retryably
  (`read_version_mismatch`) so a stale view repairs instead of
  terminal-failing. Ownership witness: the scope holds the cell AND it
  is not CA3 rider residue. Sessions absent entirely → allowed only for
  direct-route turns (lane/tooling submits); a sequenced turn must name
  a session, and the Phase-4 client surface requires sessions on all
  client-originated turns (next bullet). Credential authentication
  against identity cells in the catalog scope closure (CO15) is the
  Phase-4 transport in front of `/net/session-open` — implemented as
  `/net-api` (below).
- **The `/net-api` client surface (implemented — Phase 4 item 2).** The
  worker entry routes `/net-api/*` to ONE stable GATEWAY_NET shard
  (`net-api`): a session cell installs into the MINTING gateway's
  derived view and `/net-api/turn` validates the session from that same
  view, so mint and turn must land on the same DO; hash-sharding by
  session id waits on a session→cluster pull-on-miss story (session ids
  carry no lineage). No internal signing rides this path — the gateway
  authenticates the client credential itself: `authorization: Bearer
  apikey:<id>:<secret>` (or `x-woo-api-key`) verified against the
  catalog identity cell `property_cell:$system:api_keys` (pull-on-miss
  from the catalog scope), with core's exact salt/hash scheme
  reimplemented in `src/worker/net/client-auth.ts` (never an engine
  import); refusals are named 401 `E_NOSESSION` verdicts.
  **Rate limits (wire.md's inbound rule, applied per authenticated
  actor):** every `/net-api` operation — REST request or WS turn frame —
  draws from one token bucket of 50 ops/s sustained, burst 100; the
  amplifier routes (`POST /net-api/session`, `POST /net-api/ws-ticket` —
  durable-commit and ticket minters) draw from a tighter 5/s bucket.
  Excess refuses with the named `E_RATE` (HTTP 429; on a WS turn frame,
  a `turn_result` with status 429 so the client's in-flight turn settles
  instead of stranding). Buckets are per-gateway-isolate memory
  (bounded, idle-evicted); eviction degrades to permitting one fresh
  burst, never to blocking a legitimate client.
  - `POST /net-api/session {ttl_ms?}` derives the actor's cluster from
    view lineage (CO15; convention pull `cluster:<actor>` on miss) and
    mints through `/net/session-open`'s machinery.
  - `POST /net-api/turn {target, verb, args?, session, idempotency_key?}`
    REQUIRES a session (`session_required` without one) and validates
    the named session cell — presence, expiry, and actor binding to the
    AUTHENTICATED apikey actor — before planning; the turn then runs
    route:`sequenced` so the committing scope's authorize revalidates
    end-to-end (the gateway authenticates; scopes authorize).
  - **planningScope from the session cell:** the anchor object is the
    session's `activeScope` when set, else the actor's live location
    from the view, else the actor itself; the anchor classifies through
    view lineage (CO15 walk; convention pull `room:<anchor>` on miss),
    falling back to the actor's cluster when it cannot classify.
  - Accepted turn replies carry the planned transcript's `result`,
    `error`, and `observations` (the gateway holds the planned
    transcript; `error` matters because an errored verb still commits
    its complete transcript — without the field an accepted no-op is
    indistinguishable from success). A replay detected by post-state
    digest mismatch omits them and marks `replayed: true` (a fresh
    accept always digest-matches its plan).
  - `GET /net-api/relation` / `GET /net-api/cell` are the authenticated
    client reads over the CO13 roster mirror and the view cell probe.
  - **`GET /net-api/ws` (implemented — Phase 4 item 3; ticket auth per
    pre-deploy fix B3)** upgrades to a WebSocket. The upgrade
    authenticates by a SHORT-LIVED SINGLE-USE TICKET, never the apikey:
    `POST /net-api/ws-ticket {session}` (authenticated over HTTP like
    every other route) mints an opaque ~60s ticket bound to
    (session, actor), and `GET /net-api/ws?ticket=` consumes it
    (read-then-delete; a reused or expired ticket refuses 401) then
    validates the bound session exactly like `/net-api/turn` — the
    WebSocket API cannot set request headers, and the permanent
    credential must never ride a URL (history/logs/traces). The
    accepted socket is tagged with the session id via the DO hibernation
    API — the runtime socket set IS the registry (per-shard, in-memory/
    hibernation only; no new durable copy — CO5 stands at five; a
    dropped socket loses liveness only, the session cell persists and a
    reconnect re-tags). Frames (JSON; `id` echoed): `{type:"turn",
    target, verb, args?, idempotency_key?}` runs the `/net-api/turn`
    path on the SOCKET's own session and replies `{type:"turn_result",
    id, status, ...}`; `{type:"ping"}` → `{type:"pong"}`; anything else
    → a named `{type:"error"}` frame, never a close.
  - **Observation delivery (Phase 4 item 3):** the submitting session
    receives its turn's observations ON THE TURN REPLY only (previous
    bullet; the WS `turn_result` frame carries them). Peers receive them
    via fanout: the gateway routes an applied fanout's observations to
    the sockets of sessions PRESENT in the fanout's scope per its CO13
    mirror, as `{type:"observations", scope, seq, observations}` frames.
    Echo dedupe is `FanoutBody.turn_id` matched against a bounded
    in-memory LRU of recently client-submitted turn ids (recorded before
    the submit leaves, so the fanout can never race past it); losing an
    entry (hibernation, cap) degrades to one duplicate frame for the
    submitter, never a missed frame for a peer. Delivery is
    AT-MOST-ONCE and never durable: the per-scope seq gate drops
    redeliveries, dead sockets are skipped, and missed-observation
    catch-up is deliberately NOT promised in Phase 4.
- **Every planned submit carries its session read** (folded in by
  `plan.ts` when the engine transcript lacks it — the engine cannot
  record session-kind cells), versioned through the plan snapshot, so
  freshness is pinned by CO4 step 7 like any read.
- **Session-scope transitions are session-cell writes**, folded in at
  plan time from the engine's recorded transition (value = the prior
  row merged with `activeScope = transition.to`, written by the actor's
  own frame, BEFORE scope selection so the write participates in
  write-set routing); presence (CO13) derives from the committed cell's
  turn. There is no separate presence write path.
- **Session cells classify by the transcript's calling actor** (route
  selection, rider directions, attestation, targeted refresh): session
  ids carry no lineage, the only session cells a transcript carries are
  the calling session's, and a session's authority is its actor's
  cluster — the same rule `partitionCells` applies to seed rows.
- **Engine hydration caveat (stated):** the engine hydrates a session
  row whose `activeScope` is null (or names an unknown object) to the
  actor's current location (`hydrateSession`), so a freshly minted
  session "occupies" wherever its actor stands, and a transition is only
  recorded when the turn moves the session to a DIFFERENT scope. Net
  inherits this through the bridge; the lane's session turn therefore
  enters a room the actor does not already occupy.

## CO15. Topology, partitioning, and catalog install

- **Anchor derivation is a pure function of lineage cells.**
  `scopeOf(object)` walks `lineage.anchor` to its root: actor root →
  `cluster:<actor>`; space root → `room:<space>`; anchorless → the
  catalog scope. Gateways build their classifier from view lineage —
  never from request-supplied topology (lane fixtures excepted).
- **The catalog scope** owns the shared substrate: `$system`, `$root`,
  class lineage, verb bytecode, identity maps. Its closure is
  read-mostly, KV-seeded to every gateway at install, and universally
  receiver-known in transfers (class chains never reship — the CO7
  `assumes_known` mechanism's production population). Class definitions in
  that closure (lineage, property definitions/defaults, and verb bytecode)
  change only through the install pipeline: a sequenced catalog commit plus a
  `catalog_epoch` bump, which every consumer heals from via `E_STALE_EPOCH`
  reseed (the aged-world lane, CO12.6, is the proof). This narrowly identified
  immutability is the sole basis for amortizing catalog attestations under
  CO2.3; no scope-head cache policy applies to mutable catalog, room, or
  cluster cells. An ordinary turn that records a write to an installed
  catalog class definition MUST refuse with `E_CATALOG_MUTATION` before scope
  selection is pinned or a submit is issued. Runtime authoring of non-catalog,
  user-owned objects remains a normal sequenced turn.
- **The install pipeline** partitions a bootstrap/exported world by the
  anchor walk (`partitionCells`): catalog cells → catalog scope; rooms +
  room-anchored → room scopes; actors + carried → cluster scopes.
  Deployment = per-partition seed + KV seed writes. The Phase-5
  fresh-install path (identity import included) is this same pipeline.

## CO16. Scheduled-turn execution

- The scope remains the durable home and the waker (CO2.8); **a
  registered planner gateway executes**. `/net/subscribe` carries a
  role (`fanout` | `planner`; fanout is the default, and fanout/refan
  delivery targets fanout-role subscribers only — one destination may
  hold both roles). At alarm time the scope moves due turns
  **atomically** from the scheduled row family to durable outbox rows
  (`POST /net/plan-scheduled {scheduled_turn, scope, catalog_epoch}`)
  in one transaction: each turn exists in exactly one family at any
  instant — never lost, never duplicated. One firing moves a **bounded
  batch** (in firing order) and re-arms immediately while more turns are
  due, so a due burst can never balloon a single alarm transaction; with
  no planner registered, due turns stay parked and the alarm re-arms
  only for future turns (overdue rows cannot spin it). Outbox drains are
  likewise bounded per pass — per due destination, a lane **prefix** in
  (scope, seq) order — so a stuck destination's backlog neither taxes
  later requests O(backlog) nor starves other destinations' lanes; the
  retry alarm arms at the earliest lane HEAD's due-time. Rows address ONE planner,
  chosen deterministically (the lexicographically first planner-role
  subscriber, so re-fires address the same reply cache); failover is
  the outbox lane's ordinary retry/backoff/abandon policy (abandonment
  is the named divergence) — multi-planner election is deliberately out
  of scope.
- **The planner runs the normal turn machinery** (the `/net/turn`
  repair loop, selection pinning, attestation, install-on-accept) with
  idempotency key `sched:<id>:<at_logical_time>` — at-least-once
  delivery + the committing scope's reply cache = fired exactly once. A
  200 reply (an accepted OR terminal-rejected TurnResult) deletes the
  sender's outbox row: a terminal verdict will not change on
  redelivery. A cold planner view **pulls on miss** before planning —
  the sending scope, the catalog closure, and the call actor's cluster
  (the CO15 conventions), each only when the gateway holds no
  high-water for it; anything further rides the standard
  E_MISSING_STATE recovery.
- **Scheduled turns are session-less**: `ScheduledTurn.call` carries
  actor/target/verb/args and no session, so per CO14's sessions-absent
  rule they run as actor-authority DIRECT-route turns. This is the
  documented posture until VTN18.2's engine-side scheduling lands an
  authority field.
- With no registered planner, due turns stay parked with a named metric
  (`net_scope_scheduled_turn_fired`; the non-destructive peek is the
  specified no-planner state). A later planner subscription arms an
  immediate wake, so parked overdue turns dispatch without waiting for
  an unrelated alarm. Dispatches emit
  `net_scope_scheduled_turn_dispatched`.
- Engine-side `schedules`/`cancellations` transcript fields (VTN18.2)
  remain deferred until the DSL exposes scheduling; `/net/schedule` is
  the substrate surface until then.
