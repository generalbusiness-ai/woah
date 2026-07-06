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

### CO2.4 Read-version validation

A committed turn's reads must match current authority state at validation
time, unless a scope-epoch validation rule (policy, never a caller hint)
explicitly permits a stale projection read. Until such a rule is installed
for a scope epoch, projection reads validate under the same exact-version
rule as semantic reads.

### CO2.5 Idempotency

A replayed idempotency key returns the recorded reply. A redelivered fanout
frame is a no-op by scope head. Accepted frames carry the authority's
acceptance timestamp so retried deliveries never mint fresh wall-clock
values.

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
| `E_STALE_HEAD` | submitted `base` behind scope head (incl. cold/evicted-scope reseed) | refetch head/closure, retry |
| `E_STALE_EPOCH` | consumer copy stamped with an old `(scope_head, catalog_epoch)` | reseed that copy, retry |
| `E_MISSING_STATE` | materialization miss under sparse execution (CO2.6) | acquire read-closure transfer, retry |
| `E_READ_VERSION` | read set conflicts with current authority | re-plan against refreshed cells |
| `E_SCOPE_SPLIT` | write set spans two distinct shared scopes (CO2.3) | terminal; named limitation until CA10 |
| `E_LINEAGE` | transfer lacking lineage closure | cannot occur by construction (CO7); assert/alarm |
| `E_BUDGET` | repair budget exhausted | terminal; reply carries the attempt trace (each attempt's taxonomy code) |
| `E_SEED_LAG` | KV seed behind scope head | informational; consumer proceeds via head-check |

Retryable codes are turn mechanics and never user-visible as failures;
terminal codes surface to the caller with their trace.

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
advances per commit. This generalizes the E1 discipline that landed for v2
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

## CO12. Conformance gates

All gates live in the curated `npm test` list or the smoke lanes (a gate
that only runs under `test:full` does not hold the line):

1. **CI gate**: post-turn, every node's derived view of a touched cell
   equals committed authority at the same head (multi-node topology).
2. **Registry gate**: no durable write lands outside the five CO5 stores.
3. **Budget gates**: envelope bytes, scope-row writes, sync RPC count,
   reconstruction count — asserted per turn in unit lanes.
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
