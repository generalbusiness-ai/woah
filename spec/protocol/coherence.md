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
   **Ordering reads follow the same rule.** An owner-computed ordering read
   (`ordered_children` / `ordered_neighbors`) records
   `{container, parent, scope, version}` in the transcript's `orderingReads`,
   where `container` distinguishes contextual roots, and `scope` is the owning
   authority the answer was fetched from. `parent: null` therefore names the
   roots of exactly `(scope, container)`, never a process-global null root. The
   committing scope re-derives versions for entries it owns; a FOREIGN
   entry validates against `orderings: [{container, parent, version}]` carried in the
   same owner attestation (the `/net/attest` reply reports current ordering
   versions alongside cell versions). A foreign ordering read with no
   attestation rejects `rider_unattested`; a version mismatch rejects
   `read_version_mismatch` with scoped/container-qualified
   `ordering_conflicts`, and the gateway re-fetches those exact answers and
   re-plans. Reinstalling the same stable authority version twice and still
   recording a mismatch is `E_NONCONVERGENT_READ`, not budget exhaustion.
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

Commits outrank delivery on the authority's thread: a drain invocation that
finds a `/submit` executing on the same scope MUST yield between route
passes (never mid-transaction) and resume via the retry alarm once the
commit has replied. Fanout is latency-tolerant by contract — at-least-once,
alarm-resumed — while submit latency is the user-visible hot-room tail (the
2026-07-20 bake measured sustained drain occupancy as multi-second p99
stall episodes). A yielded drain MUST NOT re-arm a due-now alarm while the
submit remains in flight; the last completing submit arms one continuation,
preventing an alarm/yield/re-arm busy loop. Yielding defers rows, never drops
them.

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
5. VM/catalog/verb hashes accepted for the scope epoch; an ordinary write to
   an epoch-immutable installed definition is refused independently by the
   catalog authority.
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
| `E_NONCONVERGENT_READ` | a recorded read cannot converge: the gateway refreshed a mismatched cell (or re-installed an ordering answer) to a STABLE authority version and re-planned, yet the re-plan re-recorded a version that still mismatches that same authority version — a planner/catalog-verb bug, not contention (contention moves the authority version each round and never trips this) | terminal and NAMED; surfaces the offending cell/ordering with the attempt trace instead of grinding to `E_BUDGET` |
| `E_INVARG` | a malformed internal request field (wrong type or shape) | terminal for this request; refused with the offending field named — never silently coerced into a different-but-valid request |
| `E_SCOPE_RETIRED` | a submit, adopt, seed, or head read targets a scope past its retirement head (CO17) — its anchor root was recycled and the scope's storage reclaimed | terminal; a session repins to a live scope; an outbox sender treats it as terminal-acknowledge (advances high-water, installs nothing); a gateway seed path refuses to re-seed the tombstoned name at the same epoch |

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
a success. A present seed `relations` field is the complete initial relation
family (including an explicit empty array); omission by a legacy seed request
preserves existing same-epoch relation rows. This generalizes the E1 discipline
that landed for v2
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
- **Installation derives initial contents before partitioning.** The installer
  computes `object_live.location` memberships from the complete world image,
  then partitions each row by the location OWNER's scope and seeds cells plus
  relations atomically. Per-scope reconstruction is insufficient: a
  self-hosted space owns its live cell while its containing room owns the
  membership row (for example, the pinboard's row belongs to the Deck).
  Same-epoch pre-traffic reseed replaces the complete seeded relation family.
  For namespaces created before this rule, the signed add-only
  `repair-relations` operator operation advances the owner head only when a row
  is missing and refans that delta; replay is an idempotent no-op.
- **Persisted bootstrap definitions upgrade as ordered catalog events.** A
  runtime deployment does not rewrite definition pages already installed in an
  active world. The signed `repair-definitions` operator operation therefore
  accepts replacement of existing `verb_bytecode` cells, installation or
  replacement of property-definition `property_cell`s, and removal of either
  definition kind on installed `$` objects at catalog authority. It advances
  the catalog head once, durably appends the tail event, and refans replacements
  plus removed cell keys under the same high-water. An unchanged replay is a
  no-op. A later full catalog pull also removes local verb/property definition
  pages on `$` catalog objects that are absent from the authoritative closure,
  covering gateways that were offline for the fanout. Definition-shaped cells
  authored at runtime on ordinary objects, as well as ordinary instance
  property cells, are outside the catalog image and remain untouched.
  The operator script requires an explicit `$object:verb` or
  `prop:$object:name` allow-list, obtains replacements from the fresh local
  install plan, and permits drops only when a bundled migration declares the
  corresponding `drop_verb` or `drop_property` and the current bundle no longer
  defines that page; arbitrary definitions and deletion of current definitions
  are not operator inputs.
  A safety-critical identity admission path MAY invoke that same signed,
  ordered operation internally before allocating a credential, but only for
  an exact bundled page whose existing native handler and owner are already
  recognized. It MUST reread and verify the authoritative replacement before
  admission, coalesce concurrent repairs, back off after failure, and fail
  closed for missing or unrecognized pages. This is not a general client-
  controlled catalog-repair surface.
- **The applier runs at the committing scope.** On accept, the scope
  derives relation deltas from the transcript: `projectionWrites`
  (contents add/remove), moves (contents of the source and destination
  parents), ordered-edge writes/moves (`ordered_edge` rows at the current
  container), and session-scope transitions (presence). The ordered-edge row
  is required when an item's immutable anchor differs from its current
  container: the authored edge cell remains truth at the anchor, while the
  container owner gets a complete bounded ordering without global enumeration.
  Each scope maintains these rows in a write-time-sorted
  `(container, parent)` index, so projection and neighbour reads remain bounded
  by that parent's width rather than scanning the scope's relation family.
  Local deltas apply
  in the SAME transaction as the commit; deltas whose owner object is
  anchored elsewhere are delivered to the owning scope via the durable
  outbox (`POST /net/relate`, idempotent by `(from_scope, seq)` — a
  high-water separate from `/net/adopt`'s, because one turn can produce
  both facts at the same `(from_scope, seq)`). Presence and ordered-edge
  foreign batches also take the synchronous accepted-reply freshness fence;
  the durable row remains the retry path and receiver idempotency dedupes them.
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
  Every pooled claim first acquires an exclusive session at the actor's cluster
  and only then runs the install-declared reset contract, so a reused seat is
  normalized before its bearer is exposed and cannot race another claimant.
  Consequently Net has no detached-session guest purge: expiry is owner-alarm
  driven, elastic actors retire automatically, and pooled actors reset under
  the exclusive claim. Importing the classic host's socket-attachment cutoff
  would create a second session-liveness authority and is non-conforming.
- **Acceptance is not revoked by a failed relation expedite.** The committing
  scope durably enqueues each foreign relation fact in the same transaction as
  its accepted reply. The gateway normally delivers presence and ordered-edge
  relations to the owner synchronously as a freshness fence. If that
  post-accept delivery fails, the response remains accepted, carries
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
  Presence and ordered-edge rows have the same cross-scope shape: their
  defining session/edge cells remain at another immutable anchor, so they
  re-derive through the committing authority's single transcript-applier path
  and `/net/relate`, not from an incomplete local scan at the relation owner.
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
- **Every gateway that warms the catalog subscribes to catalog fanout.**
  Catalog is the bounded shared-substrate exception to targeted cold-open:
  after registering, the gateway pulls one full catalog closure. The order is
  deliberate. An aged gateway can already hold a catalog high-water and a
  stale definition page from before it subscribed; a roster-only closure must
  not advance that high-water while retaining the stale page. The
  subscribe-then-full-pull catch-up also closes the race with a definition
  repair committed immediately before registration. Later catalog changes
  ride ordinary fanout.
- **Fanout audiences** are computed from the `session_presence` relation
  (owner = the space, members = live sessions) — CO2.7's
  "O(distinct occupant shards)" gets its production definition here.
  Implemented (Phase 4 item 3) at the RECEIVING gateway: scope-level
  fanout stays per-subscriber (rows go to subscribed shards), and each
  shard narrows the audience itself — an applied `FanoutBody`'s
  `observations` are pushed to the WebSocket(s) of every session whose
  presence row's owner anchors to the fanout's scope, read from that
  shard's own mirror (sessions on other shards are those shards'
  concern). Commit-announcing fanout carries two deliberately separate
  correlation values: trusted-internal `submitter_turn_id` (the committed
  idempotency key), used only by the receiving gateway to skip the submitting
  session, and public `echo_id`, a domain-separated SHA-256 digest of that key.
  The raw replay credential must never appear on a client-visible frame.

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
  worker entry routes `/net-api/*` across a bounded configured set of
  GATEWAY_NET shards. A session id carries its minting shard hint, so its
  cell installs into the minting gateway's derived view and later turns,
  reads, metrics, tickets, and WebSocket upgrades return to that same DO.
  No internal signing rides this path — the gateway
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
    end-to-end (the gateway authenticates; scopes authorize). `target`
    is a concrete runtime object id, not a catalog-manifest reference:
    installed-alias forms such as `tasks:the_taskboard` have already
    resolved to their concrete seed id before runtime. A concrete object
    id cannot contain `:` because net cell keys reserve that delimiter.
    The gateway refuses a colon-bearing target as HTTP 400 `E_INVARG`
    after session validation but before target-scope planning, pull, or
    repair. A syntactically valid id that is not present remains a
    distributed lookup/authority result; the gateway must not replace
    that path with global enumeration.
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
    client reads over the CO13 roster mirror and the view cell probe. Session
    ids are bearer credentials: relation reads expose only actor-level
    presence, session cells are owner-only, and any property whose inherited
    definition declares a `presenceProjection` with
    `{kind:"presence", key:"session"}` is not client-readable regardless of
    the catalog-defined property name.
  - `POST /net-api/browser-metrics {session, metrics}` accepts at most 50
    bounded `browser_activity` diagnostics per batch after validating the
    session/actor binding. Payload actor fields are ignored; the authenticated
    actor is written to Analytics Engine. This keeps net clients off the v2
    `/api/browser-metrics` namespace and does not mutate world state.
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
    mirror, as `{type:"observations", scope, seq, echo_id?, observations}`
    frames. The gateway never copies the internal submitter id onto this
    frame. Server-side echo dedupe matches `submitter_turn_id` against a
    bounded in-memory LRU of recently client-submitted turn ids (recorded
    before the submit leaves, so the usual fanout cannot race past it). If
    hibernation or the cap loses that entry, the client computes the same
    one-way `echo_id` before submit and uses the frame's digest to buffer an
    echo that arrives before `turn_result`, prefers
    the full reply on settlement, and drops later echoes; a replay with no
    observations may consume the buffered visible copy. A later rejected reply
    does not invalidate an already committed buffered fanout from another
    scope; the client releases that authoritative frame. Closing or replacing a
    socket MUST also release every in-flight WS waiter to the same-key REST
    fallback rather than withholding buffered observations indefinitely. A
    bounded turn-result timer MUST do the same for a silent half-open socket
    that emits no close/error callback. Thus
    For WebSocket clients, LRU loss costs one redundant wire frame, not a
    duplicate user-visible observation, while the bounded client echo window
    retains the digest. MCP wait queues have no client echo carrier, so each
    session keeps an independent bounded set of its own submitted echo digests;
    a fanout delayed beyond both bounded windows may appear once redundantly.
    Delivery is never durable: the per-scope seq gate drops
    redeliveries, dead sockets are skipped, and missed-observation
    catch-up is deliberately NOT promised in Phase 4.
  - **Installed catalog read:** authenticated clients may read the bounded
    `$catalog_registry.installed_catalogs` value through `GET /net-api/catalogs`.
    The response exposes ledger records only, not the property cell definition
    or authority stamp. Net shells use this live version evidence to choose a
    catalog's declared read surface; they must not infer installed versions
    from their bundled manifests.
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
  cluster cells. Eligibility is explicit on the definition object's own
  `object_lineage` row (`epoch_immutable_definition: true`), minted from the
  installed catalog graph; it is never inferred from children loaded into a
  sparse turn view. An absent marker fails safe to live owner attestation.
  The marker controls certificate eligibility, not write permission. An
  ordinary turn that records a lifecycle, property, or verb write owned by the
  catalog scope MUST refuse
  with `E_CATALOG_MUTATION` before scope selection is pinned or a submit is
  issued. Mutable catalog data is still read through live owner attestation;
  its mutation uses dedicated authority/operator paths rather than ordinary
  turns. The committing scope MUST independently reject a catalog-bound rider
  before accepting `/submit`, so no poisoned foreign residue can commit or fan
  out. The catalog authority applies the same terminal `catalog_mutation`
  refusal to direct `/submit` and CA3 `/adopt`: a definition-cell rider is
  acknowledged as a terminal
  refusal, advances the sender high-water, and installs no cell, so a stale or
  faulty gateway can neither violate the certificate premise nor poison an
  outbox with futile retries. Runtime authoring of non-catalog, user-owned
  objects remains a normal sequenced turn.
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

## CO17. Scope retirement

> Status: **draft**. Adopted invariants above are unchanged by this
> section; nothing here is implemented yet. Binding mechanics live in
> [reference/cloudflare.md §R1.9](../reference/cloudflare.md#r19-net-scope-teardown).

Scopes have an end of life. Without one, every room and every actor
cluster that ever existed retains durable storage forever — a direct
violation of the Big-World posture (CO11.4) with a monotonically growing
cost curve. Idle **eviction** is not retirement: an evicted scope keeps
its storage and rehydrates on demand; retirement **reclaims** it.

**Triggers.** A `room:<space>` scope retires when its anchor space is
recycled; a `cluster:<actor>` scope retires when its actor account is
deleted ([identity/provisioning.md](../identity/provisioning.md)). Both
arrive as ordinary committed lifecycle writes in the scope itself. The
catalog scope and gateway shards never retire.

**The retirement sequence** (normative order; each step idempotent and
re-derivable from durable state on re-activation, per the CO2.8 alarm
discipline):

1. **Final turn.** The sequenced turn that recycles the anchor root is
   the scope's last accepted turn; its head is the **retirement head**.
   From that commit on, `/submit`, `/adopt`, `/relate`, and `/seed`
   answer `E_SCOPE_RETIRED` (CO6). The retirement mark is a durable meta
   row written in the same transaction as the final commit.
2. **Drain.** All outbox lanes drain to empty under the normal
   alarm-driven retry discipline — the final turn's fanout (the recycle
   observation subscribers use to unpin) included. Undeliverable rows
   age out by the existing dead-subscriber pruning; drain completion is
   "no undelivered rows", not "every peer acknowledged".
3. **Tombstone.** The scope's copy-#3 seed record (`net:seed:<scope>`)
   is replaced with a tombstone `{retired: true, head, catalog_epoch}`.
   The tombstone is the *only* durable trace of the scope after step 4,
   so it is written before storage is released, never after.
4. **Reclaim.** The binding releases all durable storage for the scope
   (§R1.9: `deleteAlarm()` then `deleteAll()`).

**The cold-activation rule.** After step 4 the scope's name remains
reachable (a stale gateway or peer can still address it). A scope that is
empty at activation answers `E_STALE_HEAD` exactly like a never-seeded
scope — the scope itself cannot and need not distinguish the two. The
authority for the difference is the tombstone: the gateway cold path
(CO7's `E_STALE_HEAD` → seed-and-retry) MUST consult copy #3 before
seeding and, on a tombstone, surface terminal `E_SCOPE_RETIRED` instead
of re-seeding. A crash between steps 3 and 4 therefore converges (empty
or partial storage + tombstone ⇒ retired); a crash before step 3 leaves
the scope durably intact and retirement resumes from the meta row.

**Peers and sessions.** An outbox delivering to a retired scope receives
`E_SCOPE_RETIRED` as a terminal-acknowledge — the sender advances its
high-water and installs nothing (the same posture CO15 specifies for the
catalog-mutation refusal, and for the same reason: no futile retry
loops). Sessions still pinned to the scope get the terminal code on
their next turn and repin via the normal join path. Derived relations in
*other* scopes that referenced the recycled anchor are the recycle
semantics' concern ([semantics/recycle.md](../semantics/recycle.md)),
not retirement's.

**Name reuse.** A retired scope name is reusable only through the
install pipeline at a **new** `catalog_epoch` (the explicit operator
path — the same recovery posture as `E_SEED_COMMITTED`: fresh authority
is never minted under an unchanged identity by a runtime request).

**Conformance** (extends CO12): a retirement lane — retire a scope
mid-outbox-backlog, kill between each pair of steps (TR8 faults), then
verify a stale gateway's submit gets `E_SCOPE_RETIRED`, a peer outbox
terminal-acknowledges, the tombstone blocks re-seeding, and storage for
the scope is empty.
