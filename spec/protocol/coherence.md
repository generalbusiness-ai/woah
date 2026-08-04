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
   │ envelope = transcript + attestations + routing metadata (the only shape; CO7)
   ▼
SCOPE    — the authority: one sequencer per commit scope; validates,
           commits, owns the cells anchored to it; durable outbox;
           scheduled-turn alarms and durable continuations (CO2.8)
   │ routing hints + leased presence projection
DIRECTORY — routing hints + leased session/presence projection (never authority)
KV        — epoch-stamped cold-start seeds (read-only fallback)
```

**The gateway is inside the deployment trust boundary.** It plans every
turn and authors every transcript, so the frame provenance a transcript
carries (`TranscriptWrite.writer`, and the `armed_by` of CO16.2) is
recorded by the planner, not attested by the VM that ran. A scope
validates provenance for *consistency* — the naming, the authority flags
it reads from its own cells — but a planner that fabricated provenance
could name any frame. Nothing in this layer detects that; see CO11 item 6.
Transport authentication (protocol/hosts.md §3.3) is what keeps a
non-gateway from submitting at all.

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

Planning projections are installed or repaired only between whole-turn
attempts. During an attempt they are immutable inputs. Attempt-local derived
state and behavior-domain recorder effects follow the same savepoint stack as
the state they describe: an inner success merges provisionally into its parent,
and an aborted inner or outer scope cannot influence later reads or contribute
a domain effect to the submitted transcript.

Proof retention after abort is **execution-ordered and dependency-closed**. A
read, dispatch proof, or state probe may remain only when every cell and
resolution namespace it depended on still describes the restored durable
pre-scope state. The recorder walks the aborted trace in execution order:
proofs observed before a rolled-back mutation remain, while later proofs whose
dependency closure intersects that mutation are discarded. For an inherited
property read, the closure includes the receiver cell plus every lineage edge
followed and same-named property-definition namespace consulted. For dispatch,
it includes every lineage edge followed and each visited object's complete verb
vocabulary — canonical names, aliases, and slot precedence are one namespace —
including feature-vector/property resolution and visited feature chains.
Therefore a rolled-back `chparent` invalidates later descendant reads and
dispatches that traversed the changed edge, and a rolled-back definition edit
invalidates later inherited/aliased resolution even when the transcript proof
is stored under a different receiver or invocation name. This is bounded by the
already-materialized resolution path; it never enumerates all descendants.

Semantic dependency derivation is recorder-only work. Outside an active turn
recorder, ordinary property and verb resolution MUST return the same value,
definer, and verb without a second proof-only lineage walk or a clone of an
unused dependency path. With a recorder active, the complete path above remains
mandatory; this optimization cannot weaken or approximate recorded proofs.

Deterministic logical inputs and incompleteness/untracked-effect evidence may
remain independently because they are not claims about restored cell values.
In particular, pruning a transient untracked-native dispatch proof MUST retain
proof-free incompleteness evidence; rollback cannot turn an incomplete attempt
into a complete transcript.

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

**Sequenced-log ownership.** A Net-planned sequenced transcript preserves
the semantic sequencing space separately from the selected authority
address. Its reserved `next_seq` allocation is an ordinary versioned
read/write pair only when the selected commit scope owns that space; the
authority appends the final log row in the same transaction. If write-set
routing selects another scope (the pure-movement case), the planner strips
the allocation and the turn consumes no room seq and appends no room log
row. This is the necessary consequence of off-room CA3 atomicity: the system
does not pretend an asynchronous second commit is one atomic `$space:call`.
Acts avoid the exception because their projection fold is a room-owned write
and therefore selects the room authority.

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
   **`owns` MUST exclude rider residue.** A ride-along leaves the committing
   scope holding a COPY of cells anchored elsewhere — including the lifecycle
   and lineage cells of an object CREATED here but anchored to another scope
   (the shared/planning scope serializes the mint; the object's own cells ride
   to its anchor). Reading such a copy as ownership makes the scope claim an
   object it does not sequence: a later turn committing here that reads any
   cell of that object which lives only at the anchor takes the local branch,
   finds it absent, and rejects `read_version_mismatch` with no possible
   repair — no refresh can move a foreign cell into this store — so the
   gateway's loop escalates to terminal `E_NONCONVERGENT_READ`. The residue
   ledger recorded at ride-along time is therefore authoritative for the
   ownership question as well as for transfer provenance: a cell this scope
   holds AND has shipped as a rider is foreign, and its reads take the
   attestation path above.
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
   their current scope name is `catalog`. After fetching the round's owner
   attestations, the gateway MAY compare their cell versions with the
   transcript before submit. A disagreement is already the exact
   `read_version_mismatch` the scope would return, so the gateway may skip that
   provably doomed submit, refresh the named cells, and re-plan. Because no
   submit occurred, that immediate re-plan MAY reuse an owner attestation from
   the preflight round only when the entry exactly covers every cell, ordering,
   and replay version the new transcript requires from that owner. A changed or
   newly required version MUST fetch a live owner attestation. Scope-returned
   conflicts do not use this reuse path, and only the scope may accept; this
   optimization removes rejected/redundant RPCs but creates no acceptance path.
   Cross-invocation promises MUST NOT
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
   re-plans. For a receipt-eligible read, reinstalling the exact same
   owner-attested scope head and content version twice and still recording a
   mismatch is `E_NONCONVERGENT_READ`, not budget exhaustion. Eligibility is
   conservative: `head.seq` MUST be greater than zero (same-epoch seed may
   rewrite arbitrary cells and relations at head zero), and the dedicated
   `$system.net_active_epoch` cell is NEVER eligible because `/net/activate`
   intentionally writes it without advancing the head. Ineligible repeats
   stay on the bounded `E_BUDGET` path. For the remaining cells and ordering
   reads, every authoritative mutation advances the sequenced head, so content
   repetition at a later head remains contention rather than non-convergence.
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

Sequenced-log replay is another projection read, but not an unvalidated one.
The sparse planner acquires the exact `(semantic space, from, limit)` page
from its owner and records its content version in `transcript.replayReads`.
The committing scope re-derives local pages and checks foreign pages against
the owner's `/net/attest` response. A changed page rejects
`read_version_mismatch` with `replay_conflicts`; an unattested foreign page
rejects terminal `rider_unattested`. The gateway drops and refetches only the
named page before replanning.

### CO2.5 Idempotency

A replayed idempotency key returns the recorded reply. A redelivered fanout
frame is a no-op by scope head. Accepted frames carry the authority's
acceptance timestamp so retried deliveries never mint fresh wall-clock
values.

"Returns the recorded reply" means that every retained recorded-outcome field
has the same immutable decoded value, not that the fresh and replay envelopes
are identical. A replay adds `replayed`/`replay_outcome` metadata and may
explicitly report omitted output under CO9. Neither envelope exposes writable
host-language identity into the cached outcome. Everyday wire encoding need
not use replay-canonical key order or number formatting (values.md §V8), and
mutating one delivered representation cannot alter the authority's cache or a
later delivery.

The recorded reply also carries the OUTCOME of the execution that committed
under that key — the verb's return value, its transcript error, and its
observations — so a client whose response was lost learns what happened
instead of only that something did. The retry's own re-planned transcript is
never presented as that outcome: it describes an execution that committed
nothing, which for a turn consuming `now()` or `random()` would be a
plausible wrong answer. A commit reply therefore distinguishes a fresh accept
(the caller already holds its planned transcript) from a replay (the caller
holds nothing, and receives the recorded output).

A recorded reply answers exactly ONE request. It carries a canonical
fingerprint over `{actor, target, verb, verb_definer?, verb_slot?, args, route}` — sorted keys, the
resolved call, excluding session and planning anchor — and a submit reusing
the key for a different request is refused terminally
(`idempotency_conflict`). Returning the first request's reply to a second
request would be a confidently wrong answer, which is worse than the double
execution the key prevents. The refusal never overwrites the recorded reply:
the original caller's receipt outlives another client's collision.

This holds for EVERY terminal recorded outcome. A terminal rejection is
recorded under the key exactly like an accept, so the comparison MUST precede
the return of a recorded rejection, and rejections MUST persist the fingerprint
they answered. A recorded outcome from before the field existed skips the check
rather than guessing agreement.

The retained outcome is additionally bound to the actor that committed it.
Idempotency keys are client-chosen on `/net-api/turn`, on the WebSocket turn
frame, and — via the operation id — on MCP, so two clients may name the same
key. A submit from a different actor still learns that it committed nothing;
it never receives the first actor's return value or directed lines.

A validated turn with no authority effect is not cached, which is what keeps
concurrent view refreshes from becoming writes on an unchanged scope. When
the client explicitly names a stable key, the scope records a **receipt** for
such a turn anyway — the reply alone, with no head advance, no sequence
number, and no ordering — so an externally visible but effect-free act
(speech) is not re-emitted by a retry. Without the opt-in the write-free path
is unchanged.

Retention is bounded and therefore so is the guarantee, under two quotas that
reflect what limits each class of row. Replies for turns that COMMITTED are
never pruned inside the scope's recovery-tail window and hold a bounded total
beyond it; that carve-out is safe only because a commit consumes a sequence
number, so the window can hold at most `tail_limit` of them. Outcomes that
advance nothing — receipts and terminal rejections — are recorded at whatever
head is current and are therefore permanently inside that window, so they MUST
be bounded separately, by a flat insertion-ordered quota. Without it, an
authenticated actor grows authority storage without limit out of repeated
effect-free acts, and the quota MUST be enforced at insertion, memory and
durable rows in one step.

A recorded outcome MUST also expire on a wall-clock LEASE, independently of
those quotas, and that expiry MUST be enforced when the outcome is LOOKED UP.
Enforcing it only in a retention sweep is insufficient: a sweep runs when other
work arrives, so a quiet scope never runs one and an outcome long past its lease
still answers a retry.

Routing state a gateway keeps to send a retry back to the scope that recorded
its outcome — a selection pin — MUST outlive that lease; if it lapses first, a
retry re-plans and may commit at a second scope, which is the double execution
this section exists to prevent. The routing lease MUST exceed the outcome lease
by enough to absorb clock skew between the two hosts.

Row counts MUST NOT be used to establish that ordering, and MUST NOT be able to
retract a guarantee already issued. The two stores prune on unrelated triggers,
so a bound on rows in one implies nothing about age in the other. An
implementation MUST NOT evict an unexpired retry guarantee for any reason,
including quota pressure. At capacity it MUST refuse a NEW retry-safe admission,
before planning or submitting anything, and report that refusal. Deciding it
only after planning leaves a saturated host payable through its whole planning
path on every attempt, which is the load the refusal exists to shed. A refusal
issued for capacity MUST NOT itself be recorded under the key, or it consumes
the room it is refusing for and answers the client's later legitimate retry with
a stale verdict.

The retry class of an idempotency key MUST be immutable. A key admitted WITHOUT
a retry guarantee MUST NOT later acquire one: the routing record for such a key
is deliberately weaker — sooner-expiring and freely evictable — and a guaranteed
outcome recorded behind it is unprotected in exactly the way this section
forbids. Such a reuse MUST be refused before planning. Upgrading the class in
place would require an atomic rewrite spanning both stores, which no boundary
provides, and a half-applied upgrade is indistinguishable from the state being
forbidden.

An implementation MAY shed the informational payload of a recorded outcome —
return value, error, observations — under pressure while retaining the verdict
that makes a retry safe. The two have very different costs, and shedding is what
makes a full-lease guarantee affordable at all. The client contract already
names the degraded state, so it MUST be reported rather than presented as an
absent outcome.

Timestamps recorded for the lease MUST be durable. Re-deriving an undated row's
age at each hydration renews it indefinitely, so the outcome and the routing
record age in opposite directions — precisely the ordering the lease exists to
establish.

A replay arriving after its outcome expired re-enters validation as a new turn.
Per-surface client contract, including the exact leases, the guarantee's stated
exclusions, the retained byte ceiling and what a client is promised on retry:
[mcp.md §M4.2](mcp.md#m42-retry-safety-the-operation-id).

Fanout carries two distinct monotonic positions. The authority `seq` gates
derived state application and may skip at one subscriber when an authority
event produces no row for that destination. A per-subscriber `delivery_seq`
gates delivery continuity and advances once for each row enqueued to that
destination. Receivers MUST diagnose a jump in `delivery_seq` as a named
fanout gap; they MUST NOT infer delivery loss from a jump in authority `seq`.
Rows without `delivery_seq` remain valid during rolling upgrades but provide
no delivery-gap evidence.

An idempotent fanout re-subscription returns the lane's safely acknowledged
prefix. The scope computes that resume watermark as the current subscriber
counter when no row is pending, or one less than the oldest pending stamped
row. The gateway durably advances only its `delivery_seq` high-water to that
prefix before pulling the current state backfill; it does not advance the
authority `seq` high-water. Consequently acknowledged history before the
subscription boundary cannot appear as a new gap after gateway cache loss,
while every pending row remains the next contiguous delivery. An unstamped
pending rolling-upgrade row forces the resume prefix to zero. If a pending
row arrives while the gateway is awaiting the subscription response, the
gateway defers gap classification for that scope and compares the first
interleaved lane position with the returned prefix; state application and
durable delivery high-water advancement still happen immediately.

### CO2.6 Materialization miss is not semantic absence

Under sparse execution, a lookup miss for an unmaterialized id MUST surface
as `E_MISSING_STATE` (acquire closure, retry — CO6), never as `E_OBJNF`.
Only a full-closure executor may report semantic absence directly.

The translation is derived from the engine error's VALUE, so that value is a
protocol contract, not a diagnostic convenience. An `E_VERBNF` for a
name-descriptor miss MUST carry `{ obj, name }`: the planner names
`verb_bytecode:<obj>:<name>` as the missing key and grows the turn's slice (or
pulls from the authority) from exactly that. A raiser that spells the verb name
under some other key makes the miss underivable, and it degrades to semantic
absence — a verb read on an object the turn did not target then fails
terminally with the page sitting resident in the gateway view. The affected
reads are the ones a slice never covers by construction: the seed holds the
actor's and target's class chains, so any verb-metadata read on an ARGUMENT
object (`verb_info`, `set_verb_info`, `list_verb` against a passed id) depends
on this repair. An implementation SHOULD additionally accept the historical
`descriptor`/`verb` spellings so a future divergence degrades to a repairable
miss rather than a terminal error. A numeric slot descriptor names no page and
is deliberately not resolvable this way.

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
A lane MAY deliver its due prefix as one batched request (the receiver
applies rows serially in array order — a single request is a single event,
so the ordering guarantee only strengthens); the batch outcome is
prefix-atomic, and the receiver's per-scope seq gate makes any redelivered
row a no-op, so retrying a failed batch whole is safe. A sender MUST fall
back to bare-row delivery when the batch envelope is refused: platform
code updates route new callers to old receivers for seconds-to-minutes,
which overlaps the abandonment budget — batch adoption may never turn a
previously deliverable row into an abandoned one.

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

Validated direct observations obey the same event break even though their
delivery is live-only. A scope MUST NOT call a subscriber gateway from the
`/submit` request lineage: suppressing only the origin gateway is insufficient
when another subscriber is concurrently submitting to that scope. The scope
queues live deliveries in bounded volatile memory and arms an immediate alarm;
the fresh alarm event sends one bounded batch, grouped into at most one RPC per
destination gateway. The receiver filters and emits every live message
independently; batching creates neither ordering nor durability. Eviction,
queue-cap overflow, and delivery failure may lose these observations—as their
live contract permits—but cap drops and delivery failures MUST be named in
telemetry. Live delivery never creates an authority sequence or durable outbox
row.

### CO2.8 Durable continuations

Deferred work is **scope state**, never host state. There are no parked VM
stacks: a turn runs to completion or fails, and work that must happen later
is a pending *scheduled turn* (CO16). The scope sequencer stores the
pending queue durably, sets its alarm to the earliest `at_logical_time`,
wakes itself, and validates a fired turn exactly as a live-submitted one
(`ScheduledTurnRequest` per CO16.2: `schedules` / `cancellations` are typed
transcript arrays with their own validation path, never fabricated
`TranscriptWrite` ops, and — unlike writes — **not** in the
`post_state_hash` preimage; CO16.2 says why). A pending entry survives DO eviction and
fires via the scope alarm; this is a conformance gate (CO12), not an
aspiration — the v2 worker never implemented it, so this layer carries the
obligation explicitly.

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
  schedules?: ScheduledTurnRequest[];      // CO16.2
  cancellations?: ScheduleCancellation[];  // CO16.2; carries frame provenance
  observations: WooObservation[];
  result?: WooValue;
  error?: WooError;
  failureEffectsGeneration?: 1;
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

**Lifecycle-cell vocabulary.** An existing object's `lifecycle` cell is its
complete semantic `object_lineage` value:
`{parent, owner, name, anchor, flags}`. A lifecycle read validates that value
and its content-derived version, never a presence sentinel. A runtime
`chparent`, rename, flag change, or catalog lineage update records one
`op:"set"` replacement of that complete value. Applying the replacement
updates those five fields, preserves authority metadata not named by the
semantic value (event schemas and epoch-immutable-definition markers in the
Net representation), and re-derives the old/new parent's child projections.
Object creation remains a `TranscriptCreate` plus its `op:"create"` lifecycle
echo; recycle remains a typed `TranscriptRecycle`. An authority MUST NOT
interpret an existing-object `op:"set"` as permission to create the object, nor
accept another lifecycle op as an implicit lineage mutation.

A lifecycle mutation of an object created earlier in the same turn does not
emit a lifecycle read: that intermediate value is derived from the turn's own
create, not a proof about durable pre-state. The ordered create and lifecycle
writes are sufficient for sequential authority and cycle validation, including
multiple replacements of the fresh object. `created` and `present` are never
lifecycle read values or validation sentinels.

Lifecycle replacement authority is checked against the recorded VM frame.
Wizard-owned frames may replace any semantic lineage field. A non-wizard frame
may rename only an object it owns; it may also change that object's parent only
while preserving owner, anchor, and flags, being permitted to create an object
it owns beneath the proposed fertile or owned parent, and either holding
programmer authority or using the generic builder-surface primitive.
Builder-surface creates and parent changes carry a `builder_surface` producer
marker, but the marker is not authority: the commit scope independently binds
it to a valid recorded frame whose effective principal is the authenticated
actor (a wizard-owned wrapper must be lowered exactly to that actor), and
proves from authority state that the actor carries that frame's definer through
ancestry or an attached feature. Generic creates without that combined proof
retain the programmer requirement. Recursive parentage is rejected.
For an existing object, these checks are in addition to the exact pre-state
lifecycle read and deterministic post-state re-derivation; the transcript is
not a capability to synthesize a lineage state that the executed primitive
could not have produced. A created object's final lifecycle is the last
same-turn replacement, while the authority's create-collision check proves the
object was absent before apply.

An inherited property read after a lifecycle replacement is validated against
the lineage topology produced by that same turn, because its value may not
exist through the authoritative pre-state parent chain. The commit scope may
use this derived view only after every recorded mutation frame has
independently passed authority validation, and the view may apply only
existing-object lifecycle `op:"set"` topology—not creates, ordinary property,
placement, or other effects. The lifecycle write's `prior` still validates
against authoritative pre-state. This is not a general rule that a write may
justify its own read-back.

`ScheduledTurnRequest` is **not** carried from VTN7 unchanged: its shape,
validation, and authority rules are [CO16.2](#co162-schedules-are-transcript-effects)'s,
which drop VTN18.2's stored `caller_perms` and add mandatory `armed_by`
frame provenance. `cancellations` is likewise a typed array, not the bare
string list VTN18.2 proposed — a cancellation is an authority-bearing
effect and needs the same provenance a schedule does.

Like `creates` and `recycles`, both are named typed arrays with their own
validation path, never `TranscriptWrite` entries under a fabricated `op`.
Unlike writes, they are **not** in the `post_state_hash` preimage: the
digest covers touched authority cells, and the pending queue is a separate
row family the planner does not hold. See CO16.2.

`failureEffectsGeneration` is an optional producer capability and part of
the canonically hashed transcript body. Generation 1 promises that a failed
direct transcript carries no effects, and that a failed sequenced transcript
carries only its sequencing-space owner's exact `next_seq` allocation
read/write pair plus the canonical `$error` observation. Reads, state probes,
logical inputs, and dispatch proofs may remain only under CO2.2's
execution-ordered dependency-closure rule: non-mutating proof material is not
admissible when it describes state seen only after a rolled-back
lineage/definition/value mutation. Proof-free incompleteness evidence also
remains and keeps the transcript incomplete. Every create, behavior write,
move, recycle, session transition, projection write, schedule, cancellation,
domain observation, result, or untracked effect violates that promise. A
sequencing allocation at any non-owner violates it as well.

Authorities classify every failed transcript into fixed-vocabulary effect
counts and reasons without recording world values or observation/error
payloads. During rolling deployment, an absent or unknown generation is
observe-only. A complete generation-1 violation rejects terminally as
`invalid_error_effects`; it is neither retried nor applied. Producers MUST NOT
stamp generation 1 until their failed-turn recorder rollback satisfies this
grammar. The reference fresh-execution and deterministic-replay producers have
that rollback and stamp generation 1. The generic `RecordedTurn` converter does
not stamp: imported and legacy recordings remain observe-only unless their
actual producer establishes the capability.

The field grammar is mechanically exhaustive at every authority boundary.
Core assigns every core transcript field a semantic class, and the Net bridge
does the same for every field it intersects onto that transcript. Executable
effect and outcome inspectors are derived from the core classification, so
classifying a new core effect without implementing its admission rule is a
compile error. At runtime, a failed transcript field absent from the
authority's classification, or an effect/outcome field with no executable
inspector, contributes the bounded, payload-free `unclassified_fields` reason.
A complete generation-1 transcript with that reason is terminally invalid.
Field names and values MUST NOT enter the diagnostic report.

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
7. Cell, ordering, and replay-page read versions match current authority
   state (CO2.4).
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
  transcript's creates/writes/moves/recycles and sequenced-log outcome. A
  lifecycle `op:"set"` deterministically replaces the existing object's
  semantic lineage fields and re-derives parent-child projections as specified
  in CO3. A
  recycle replaces every authority cell owned by the object with one
  `object_tombstone` cell in the same commit, grafts its lineage children to
  its former parent, displaces its contained live objects to `$nowhere`, and
  retracts the corresponding contents/ordering relations. The tombstone is
  the durable distinction between "recycled" and "never existed"; retaining
  an `object_lineage`, `object_live`, property, or verb cell beside it is an
  invalid authority image. The submit carries no executor post-state.
- **Doomed-round short-circuit** is permitted exactly as VTN8 bounds it:
  steps 1–9 are pre-state-only; a rejection they determine
  (`stale_head`, `scope_mismatch`, `incomplete_transcript`,
  `permission_denied`, and
  convergence-safe `read_version_mismatch`) may skip the apply.
  `nondeterministic` is never short-circuited. Completeness is the step-4
  envelope gate and outranks generation-specific failed-effect admission, so
  both authorities report `incomplete_transcript` when both defects are
  present.
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
- **Complete-head compaction is an exact-generation CAS, never a rebase.** A
  gateway that holds the complete owner closure at the submit base may omit
  ordinary same-owner reads. Installing that closure is replacement, not
  upsert: in the same durable transaction, the gateway removes every locally
  held cell classified to that scope but absent from the unfiltered transfer,
  replaces the scope-owned relation family, and only then advances the fanout
  high-water. The complete-head certificate is installed only after that
  transaction succeeds. `known` can relieve foreign lineage closure but does
  not filter the full request's scope-owned keys, so the receiver still
  replaces the scope image; conservatively, only a full pull with no receiver
  assumptions mints the certificate. Keyed and targeted closures are not
  exact cell-membership images and never replace or certify unrequested
  cells. Gateways materialize each installed cell's authority scope and index
  exact replacement by that field, so repairing one scope never enumerates the
  shard's other cached scopes. A transferred derived rider whose ownership
  cannot be proven from closed lineage is discarded as a repairable cache
  miss, never guessed into the responding scope. The gateway cache's v1→v2
  migration clears derived cells, relation mirrors, and their high-waters
  together before rebuilding them with materialized ownership; preserving a
  high-water across that reset could suppress its repairing fanout. The scope
  accepts a compact proof only when `(seq, hash, generation)` still equals
  current authority. `generation`
  advances on every authoritative mutation, including seed and activation
  writes that deliberately leave `(seq, hash)` unchanged. Session reads and
  sequenced `next_seq` allocation reads remain explicit. A stale-head refusal
  invalidates the compact proof: the gateway MUST pull the new complete
  generation and replan, never attach the old computed transcript to a newer
  base.
- **A pure direct read validates but does not commit.** After steps 1–10, a
  complete direct transcript with no authority writes, projection writes,
  session transition, or untracked effects returns accepted at the current
  head without advancing it or recording an idempotency reply. Repeating such
  a request safely re-reads current authority; concurrent view readers do not
  manufacture contending scope commits. If that validated transcript emitted
  live observations, the scope may relay them best-effort to its bounded
  fanout-role gateway registry, but MUST NOT create a sequence, reply-cache
  entry, outbox row, authority cell, relation row, or gateway high-water.

If validation fails, no write from the transcript commits; the gateway
repairs its planning state (per the reply's taxonomy code) and retries the
whole turn within `repair_budget_ms` (CO10).

### CO4.7 Verb-slot allocation

A verb's slot is a durable per-object ordinal and the dispatcher's tie-breaker
([../semantics/objects.md §9.1](../semantics/objects.md#91-lookup)). Only the
object's authority holds the whole verb-page set, and NO cell's absence means
"this object has other verbs" — a name-descriptor miss names one page (CO2.6), a
numeric one names none — so a sparse planner cannot derive the allocation floor
from a miss and can only propose. This is the same position the object-id
allocator is in, and it is resolved the same way: propose from a hint, and let
the owner refuse a proposal its own state contradicts.

For every verb cell write, the owning scope validates against its pre-state:

1. A write to a page the scope already holds MUST carry that page's stored
   slot. Nothing may move a verb.
2. A write that introduces a NEW page MUST carry exactly the allocation floor —
   `max(slot over the object's verb cells) + 1`.
3. Exception to (2): a RENAME is a removal plus a write under the new name in
   one transcript, and MAY take an ordinal that same transcript vacates. It is
   the same verb.

A page carrying no slot is aged data; it raises the floor but is not enforced
against, so an unrepaired world keeps committing.

Both refusals are retryable `read_version_mismatch` naming the object's verb
cells, so one repair round installs the set the planner needed and the re-plan
converges. Rule 2 is also what SERIALIZES concurrent appends: two turns planned
against one pre-state necessarily propose the same ordinal, so the second is
refused and replans one higher. Without it both would commit and the object
would hold two verbs claiming one slot — with no defined order between them.

**Aged worlds.** Worlds authored before this rule contain objects whose pages do
share an ordinal, and their true insertion order is UNRECOVERABLE: verb pages
carry no timestamp (the bridge zeroes `created`/`modified` — they would churn
content addresses) and `version` counts edits to one verb rather than global
writes. The signed operator repair `repair:net-verb-slots` therefore does not
attempt to recover it. It renumbers such an object into the `(slot, name)` order
every node already resolves in, which changes no dispatch — see
[../discovery/catalogs.md §CT14.7](../discovery/catalogs.md#ct147-reaching-a-deployed-net-world).
Until it runs, a transport resolving from those pages MUST refuse an ambiguous
match rather than guess ([mcp.md §M2.1](mcp.md#m21-woo_call)).

## CO5. The named-copy registry

**This table is exhaustive and normative.** Any durable materialization of
world state outside these five copies is a bug by definition; a conformance
gate (CO12) enforces it. Every copy is epoch-stamped (CO8).

| # | Copy | Provenance | Freshness bound | Reseed path |
|---|---|---|---|---|
| 1 | Scope authority (ScopeDO SQLite; includes the committed sequenced log, the pending scheduled-turn queue, and a bounded recovery tail *that only the scope itself reads*) | `authoritative` | is the truth | — |
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
| `E_MISSING_STATE` | materialization miss under sparse execution (CO2.6), including an owner-computed ordering or committed replay page | acquire the named cells/projection/page from its authority, retry |
| `E_READ_VERSION` | read set conflicts with current authority | re-plan against refreshed cells |
| `E_SCOPE_SPLIT` | write set spans two distinct shared scopes (CO2.3) | terminal; named limitation until CA10 |
| `E_CATALOG_MUTATION` | ordinary turn attempted to mutate an installed catalog class definition without advancing the epoch | terminal; publish through the catalog install pipeline |
| `E_LINEAGE` | transfer lacking lineage closure | cannot occur by construction (CO7); assert/alarm |
| `E_BUDGET` | repair budget exhausted | terminal; reply carries the attempt trace (each attempt's taxonomy code) |
| `E_RPC_TIMEOUT` | a cross-authority RPC exceeded its deadline | terminal for this request; retry with the same idempotency key; an ambiguous submit is first disambiguated by one same-key replay |
| `E_SEED_LAG` | KV seed behind scope head | informational; consumer proceeds via head-check |
| `E_EPOCH_MISMATCH` | durable catalog epochs genuinely disagree: a seed against a scope seeded at another epoch, or a turn whose stamp still differs from the scope's durable epoch AFTER the CO8 reseed | terminal; catalog install/migration reconciles (operator concern), never a retry treadmill |
| `E_SEED_COMMITTED` | a seed targets a scope that has already committed turns | terminal; recover into a fresh namespace rather than resetting authority under an unchanged head |
| `E_NONCONVERGENT_READ` | an eligible read or sparse-planning miss cannot converge: after resolving the owner, the gateway refreshed a cell (or re-installed an ordering/replay answer) to an authority receipt `(scope, seq, hash, generation, content-version)` and re-planned, yet the re-plan requested or mismatched the exact same receipt. This is a planner/catalog bug, not contention. Every authoritative mutation—including seed and activation—advances `generation`, so legitimate A → B → A cycles produce distinct receipts even when `(seq, hash, content-version)` returns to its prior values. Failed and owner-unresolved refreshes produce no receipt and cannot trigger this code. | terminal and NAMED; surfaces the offending cell/query, authority receipt, and attempt trace instead of grinding to `E_BUDGET` |
| `E_INVARG` | a malformed internal request field (wrong type or shape) | terminal for this request; refused with the offending field named — never silently coerced into a different-but-valid request |
| `E_SCOPE_RETIRED` | a submit, adopt, seed, or head read targets a scope past its retirement head (CO17) — its anchor root was recycled and the scope's storage reclaimed | terminal; a session repins to a live scope; an outbox sender treats it as terminal-acknowledge (advances high-water, installs nothing); a gateway seed path refuses to re-seed the tombstoned name at the same epoch |

Retryable codes are turn mechanics and never user-visible as failures;
terminal codes surface to the caller with structured detail and an attempt
trace where repair rounds occurred.

## CO7. Envelope and transfer discipline

- **One envelope shape.** A commit submission is the transcript plus the
  owner **attestations** for its foreign-anchored reads (CO2.3) and the
  post-commit routing metadata the scope shell forwards (rider `/adopt`
  and relation-owner `/relate` destinations, CA3/CO13). No read state
  ships: the committing scope validates locally-owned read versions
  against its own authority cells and foreign reads against their
  owners' attestations, then re-derives post-state by applying the
  recorded writes — it never re-executes bytecode, so a shipped read
  closure would buy nothing. Successful results and planner-only state probes
  remain gateway-local. Byte-identical reads are one authority proof on the
  wire regardless of how many times bytecode consulted the cell; differing
  value/version proofs remain distinct. A complete-head submit may additionally
  compact same-owner reads under CO4's exact-generation rule. Nothing
  scope-wide, no authority slices,
  no execution capsule, no alternate warm/slim modes. Byte ceilings are
  enforced on the **actual serialized submit body**, measured at the
  gateway immediately before the submit RPC (never on a modeled shape):
  **< 64 KB** warm same-scope, **< 256 KB** cross-scope; a breach is a
  misplan bug surfaced as a plain error, not a repairable divergence.
  `line_map`/debug info never ships in an envelope or transfer; it is
  fetched on demand.
- **Lineage closure is part of the transfer type.** A page transfer that
  does not close over `object_lineage` does not serialize (`E_LINEAGE` is
  an assertion, not an operational error). Dangling parent references are
  therefore unrepresentable, not merely gated to zero. An
  `object_tombstone` is the terminal replacement for an object page, not a
  live page, and therefore requires no lineage closure. A keyed request for
  an absent object's lineage returns its tombstone when one exists, so a stale
  gateway repairs to terminal `E_OBJNF` rather than retrying an unresolvable
  missing lineage.
- **Ordered fanout carries deletion as data.** For every touched authority
  key absent from the accepted post-state, the same `FanoutBody` that carries
  replacement cells carries the key in `removed_cells`. The receiver applies
  installs and removals under one per-scope high-water transaction. Rider
  adoption preserves the same distinction: owner scopes CAS and fan out both
  replacement cells and removed keys. Dropping absent touched keys from
  fanout is forbidden because it can certify a stale derived page at a newer
  head.
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
a success before committed traffic and advances the authority `generation`;
activation writes also advance `generation`. These head-stable operator paths
are therefore visible to complete-head receipts and non-convergence detection
even though their sequenced `(seq, hash)` is stable. A present seed `relations`
field is the complete initial relation
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
6. **No frame attestation.** Per-frame provenance on writes and on
   schedule effects (CO16.2) is *recorded by the planner*, so the commit
   scope can check it for consistency but cannot prove the named frame
   ran. A faulty or compromised gateway could therefore fabricate a
   `writer` or an `armed_by` — including one naming a wizard, which would
   let it arm an `always` schedule. This is bounded today by CO1's trust
   boundary and transport authentication, not by the commit layer. Closing
   it needs the executing VM to attest frames, which would change the
   transcript contract for every mutation, not only for schedules.

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
   structure (1 attempt, ≤ 3 sync RPCs — an optional `/head`, `/submit`,
   and the post-accept `installTouched` `/closure` — and 0
   reconstructions),
   cross-checked against a per-destination RPC log.

   A gateway MAY retain the exact planning-scope `/head` reply, including
   its object-allocation counter, and plan a later turn optimistically
   against that same base. This is a bounded derived cache, never an
   authority certificate: `/submit` still applies CO4's bounded
   retained-head proof and validates every read and the re-derived
   post-state against current authority. Compacted owner reads continue to
   require an exact current base. A create reads the allocation cell, so a
   stale counter conflicts like any other stale read; a base outside the
   retained tail rejects `stale_head`. A fanout that advances the cached
   scope invalidates the entry. An accepted turn retains the entry only
   when its returned head exactly equals the cached base (the cell-touchless
   direct case); a head-changing commit invalidates it. Thus stale cache
   state can cost one repair but cannot bless a stale read, allocate from a
   stale counter, or commit an invalid post-state.

   The substrate session mint/close path MAY advance the same cached cluster
   base to the exact head returned by its accepted submit. That transcript
   cannot create objects, so the cached allocation counter is unchanged.
   A concurrent cluster write is still proved by CO4's bounded retained-head
   rebase or rejects the optimistic base `stale_head`; on rejection the path
   fetches and epoch-checks `/head` before retry.
   This removes a routine close-time RPC without weakening the authority
   proof.
4. **Differential gate** (build-time, Plan 002 Phase 2): v2 and `src/net/`
   produce equal committed state and observation streams on the shared
   smoke scenario; divergence is a stop.
5. **Fault lane**: injected RPC latency (100 ms / 1 s), DO eviction between
   turns, cold-owner timeout, fanout redelivery — scenario stays green;
   a pending scheduled turn survives eviction and fires via the scope alarm.
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
- **Aged runtime memberships repair per scope, from that scope's own cells.**
  A namespace that ran before the create-derived rule (above) holds objects
  whose `object_live.location` is correct while their membership row was never
  derived at all; replaying the rule cannot reach them, and the fixture-scoped
  `repair-relations` operation deliberately refuses ids it cannot find in a
  bundled image. The signed `repair-contents` operator operation closes this:
  each scope derives candidate rows from its OWN `object_live` cells — the same
  O(scope size) walk this section already sanctions for the bounded rebuild and
  for hydration, so no scope enumerates another and no operator enumerates
  objects. It MUST be **add-only**: a row the scope owns whose member is
  anchored elsewhere arrived by `/net/relate` and is invisible to a local cell
  scan, so a full rebuild would delete it. Add-only also makes the operation
  idempotent — an identical row reports no change, so a second run advances no
  head and refans nothing. Rows whose owner this scope does not sequence (the
  same ownership predicate read validation uses, which excludes rider residue)
  ride the ordinary `/net/relate` lane to the owning scope; because anchor
  topology is caller knowledge, an owner the caller has not mapped MUST be
  reported rather than guessed. Repair deliveries MUST carry their own
  `(from_scope, seq)` lane, never the scope's commit seq stream: the receiver
  gate is `seq <= last`, so borrowing a commit seq is either suppressed at head
  0 or consumes a seq the commit stream has not reached, which would make the
  receiver drop the real delta that later lands on it.
- **Persisted bootstrap definitions upgrade as ordered catalog events.** A
  runtime deployment does not rewrite definition pages already installed in an
  active world. The signed `repair-definitions` operator operation therefore
  accepts replacement of existing `verb_bytecode` cells, installation or
  replacement of property-definition `property_cell`s, and removal of either
  definition kind on installed `$` objects at catalog authority. It advances
  the catalog head once, durably appends the tail event, and refans replacements
  plus removed cell keys under the same high-water. An unchanged replay is a
  no-op. A later full catalog pull performs the general exact-scope
  replacement: every locally held catalog-owned cell absent from the
  authoritative closure is removed, covering gateways that were offline for
  any cell-removal fanout. Cells classified to another scope or
  transferred as unclassifiable derived rider residue remain outside that
  catalog image; the former stay untouched, and the latter are discarded as a
  repairable cache miss.
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
- **Seeded property values upgrade the same way.** The signed
  `repair-seed-properties` operator operation is the data twin of the
  definition repair: it delivers a bundled catalog's corrected seeded map
  values (declared as `merge_map` set_property hooks with `supersedes`
  fingerprints, [catalogs.md §CT5.4](../discovery/catalogs.md#ct54-local-catalogs-and-auto-install))
  to an active world's durable `property_cell`s. The addressed scope MUST be
  authoritative for the target object's lineage, and the merge is computed
  server-side against the stored value — added keys, fingerprint-gated
  replacements, everything else preserved — so an operator-edited entry never
  changes and a malformed stored value is skipped, not clobbered. Changed
  cells commit as one ordered operator event (advanced head, tail entry,
  refan); an unchanged replay is `empty`. The operator script mines its
  entries from the bundled manifests only; arbitrary objects, properties, and
  values are not operator inputs.
- **The applier runs at the committing scope.** On accept, the scope
  derives relation deltas from the transcript: `projectionWrites`
  (contents add/remove), moves (contents of the source and destination
  parents), **creates carrying a location** (a contents add at that
  container), ordered-edge writes/moves (`ordered_edge` rows at the current
  container), and session-scope transitions (presence). The create source is
  not redundant with the other two: `object_create` records placement inline,
  so an object minted directly INTO a container produces neither a move nor a
  contents projection write, and without this rule its membership row would
  never exist — leaving the object absent from every contents-derived surface
  (structural tool context, room presentation, roster hydration) while its
  `object_live.location` is perfectly correct. Deltas carry set semantics per
  `(op, row)`, so a create-then-move within one turn collapses to a single
  destination row rather than a contradictory pair. The ordered-edge row
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
- **Recorded observations follow their semantic owner even when the commit
  does not.** A sequenced call can write only cells anchored away from its
  call space — notably an aged catalog page that predates a room-owned Act
  projection. The gateway therefore includes transcript observation indexes
  in the existing `relate_destinations` direction for each foreign semantic
  audience. The committing scope persists one combined `/net/relate` row per
  affected owner in the same transaction as acceptance, merging any
  relation-owner observations so a receiver high-water cannot suppress half
  the event. An observations-only delivery advances the semantic owner's head
  once with an `observe:<from_scope>:<seq>` recovery-tail entry and refans the
  observations under that owner seq. Redelivery is still idempotent by
  `(from_scope, seq)`. This owner event is a distribution record, not a second
  domain commit or a replay-log append.
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
  Session close is likewise idempotent at the public retry boundary even
  though success invalidates its own bearer: after authority accepts the close,
  the session-routed gateway retains a bounded durable receipt and answers a
  repeated `DELETE /net-api/session` before ordinary live-bearer validation.
  The receipt is retry evidence only, never session authority; unknown session
  ids still fail authentication, and pruning restores that normal refusal.
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
- **Affected-owner topology is gateway knowledge** (the
  `rider_destinations` rule): the gateway classifies the transcript's
  relation-owner objects (move endpoints, create locations, contents
  containers, transition rooms) plus foreign semantic observation audiences
  and ships a `relate_destinations` submit sibling; the sequencer partitions
  deltas and the shell selects observations through it, while neither learns
  anchor topology itself. The sibling `relation_member_scopes` independently
  maps affected contents members to immutable authorities. This is required
  for a same-turn create: its relation owner may be local while the new member's
  cells ride to its declared anchor, and the object is not yet classifiable from
  the gateway's pre-turn lineage.
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
  that advances the high-water carries the scope's **complete** relation
  family. The gateway transactionally removes that scope's old rows, installs
  the returned rows, and only then advances the high-water. That is the FULL
  closure (`keys: ["*"]` — the repair/reseed state transfer) and, since the
  ready-to-scale Phase 4, the TARGETED cold-open closure
  (`objects: [...], relations: true` — the named objects' class+anchor
  chains, their actors' session cells, and the roster; the client
  cold-open's cost tracks the session's need, never the scope's size).
  Required because a pull supersedes earlier fanout rows by seq —
  without the rows riding the closure, a pull would silently starve the
  mirror of everything those deliveries carried. A targeted pull does not
  certify or replace unrequested cells; pull-on-miss and read-version checks
  own their freshness. Relation replacement is nevertheless required because
  that targeted pull advances the same high-water: a row absent from its
  complete relation family is deleted before a delayed removal at or below
  that head can be suppressed.
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
  Presence membership selects the *candidate* carriers; the receiving shard
  then applies the observation-intrinsic audience rules of
  [events.md §12.7.1](../semantics/events.md#1271-directed-observation-types-v1)
  to each candidate — a directed `told`/`text` reaches only its named
  recipient, a self-addressed `looked`/`who` only its `to`. A committed frame
  carries no audience vector to lean on, so this filter is not optional: it is
  the only thing keeping a `tell()` emitted inside a sequenced verb off every
  bystander's carrier, and no client-side filtering may be assumed (an MCP
  wait queue delivers raw observations to an agent).

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
  terminal-failing.

  A room authority has one equivalent local proof: its owner-sequenced
  `session_presence` checkpoint. The row is projected only from the
  actor-cluster session transition, carries the exact session value, and
  mint/move/close freshness-fence its add/remove at the room before
  returning. When (and only when) that row is owned by the committing
  room, names the submitted session, and its value says
  `activeScope == room`, the scope MAY validate the session read against
  the row's content version instead of demanding a live actor-cluster
  attestation. It still validates actor binding and expiry locally. A
  different projected version is the same retryable
  `read_version_mismatch`; an absent row or a commit anywhere other than
  that active room uses the ordinary CO2.3 owner attestation. Thus close
  completion removes the proof before returning, and an overdue relation
  cannot extend a session because expiry is checked from its value.
  The proof applies equally when the same turn also WRITES the session
  cell — the plan-time transition fold of a room verb that moves the
  actor out of the committing room (an editor's pause/save/abort). The
  written replacement validates under the mint/refresh rule as usual;
  the checkpoint proves only the folded read of the prior row, whose
  liveness and actor binding are still validated before the proof is
  recorded. Without this composition such a turn would terminally reject
  `rider_unattested`, making any room that moves its occupants out on
  its own verbs (editor rooms) unable to release them.

  Ownership witness: the scope holds the cell AND it is not CA3 rider
  residue. Sessions absent entirely → allowed only for
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
  apikey:<id>:<secret>` (or `x-woo-api-key`). For an `n1_` id, the public
  routing hint names the actor's immutable anchor scope and actor. The gateway
  asks that authority for exactly one row in its authority-private verifier
  index and the current mutation-complete head. The index is derived from the
  actor-owned `api_keys` cell, rebuildable from it, and never appears in CO13
  relations, closure transfer, fanout, gateway mirrors, or public relation
  reads. The gateway may cache an authority receipt for
  `NET_CREDENTIAL_TTL_MS` (default 1000ms, hard maximum 30s; zero means exact per request);
  therefore revocation fences future API-key and bearer-session use within
  that explicit bound. The cache is fixed-size and includes negative results.
  Authority unavailability is retryable 503 `E_RPC_TIMEOUT`, including the
  MCP GET carrier; it must not collapse to 401 unknown/revoked or 404 missing
  session. Historical ids fall back to the carried, read-only catalog identity
  cell `property_cell:$system:api_keys`. Both paths use core's exact salt/hash
  scheme reimplemented in `src/worker/net/client-auth.ts` (never an engine
  import). A session minted from an API key stores only that public id and
  rechecks it on bearer-only requests without persisting the secret.
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
  - `POST /net-api/session {ttl_ms?, roster_visible?}` derives the actor's
    cluster from view lineage (CO15; convention pull `cluster:<actor>` on
    miss) and mints through `/net/session-open`'s machinery.
    `roster_visible:false` is accepted only when the request authenticated
    with an API key; otherwise it refuses HTTP 403 `E_PERM` with
    `detail.reason:"roster_visibility_requires_apikey"`. It does **not**
    suppress substrate session presence: the session still has `activeScope`,
    produces the owner-sequenced `session_presence` row, remains eligible for
    live observation fanout, and satisfies presence-scoped authorization.
    Catalog delivery code MUST likewise use presence-mode delivery or
    `live_audience`, never derive its transport audience from the social
    roster. A planner's `active_actors` result is a useful local view, not a
    complete distributed delivery membership proof.
    The flag suppresses the actor from every actor/session-level social
    projection: the compact `room_roster` consumed by `who` and presence UI,
    and catalog properties declared with `presence_projection`. The choice is
    stored in the session authority cell and carried by each accepted
    `sessionScopeTransition`, so every materializer derives the same public
    state. An actor with multiple sessions remains in `room_roster` when any
    live session is roster-visible. Omission defaults to `true`; a non-boolean
    value refuses HTTP 400 `E_INVARG`. A successful mint reply includes the
    resolved `roster_visible` boolean for both API-key and human doors.
  - `DELETE /net-api/session` is semantically idempotent although its success
    invalidates its own bearer. The session-routed gateway retains a bounded
    accepted-close receipt and checks it before live-bearer authentication.
    If both bounded internal submit replies were lost after authority
    accepted, that receipt may be absent; the gateway MAY then use its exact
    derived session value solely to bind the opaque bearer to the actor and
    reach the same close postcondition. An expired value grants no other
    operation. Unknown session ids still fail ordinary authentication.
    Scheduled/disconnected plugs SHOULD request `roster_visible:false` and
    close the session in a `finally` path. Hidden-roster mode is not session
    garbage collection: failure to close still leaves authority state,
    subscriptions, and expiry work behind.
  - `POST /net-api/turn {target, verb, verb_definer?, verb_slot?, args?, route?, session, idempotency_key?}`
    REQUIRES a session (`session_required` without one) and validates
    the named session cell — presence, expiry, and actor binding to the
    AUTHENTICATED apikey actor — before planning. Omitted `route` defaults to
    `sequenced`. **The planning scope then tightens the requested route:** a
    `cluster:*` (private authority) scope is forced to `direct` — the committing
    Scope head sequences it, since a cluster root is an actor, not a `$space`
    replay log with `next_seq`/subscribers/presence. A `room:*` (shared) scope
    keeps the requested route: sequenced by default via the in-world
    `$space:call`, but an explicit `direct` request is honored. A scope that
    classifies to neither (e.g. `catalog`) is not client-plannable and is
    refused. Either way a requested/forced `direct` route is allowed only when
    the resolved verb declares `direct_callable:true`; unresolved metadata fails
    closed with `E_DIRECT_DENIED`, and `world.directCall` re-enforces it, so a
    non-direct-callable verb in a cluster still returns `E_DIRECT_DENIED` — a
    cluster is not a substitute sequencing space. Either route carries the
    session read so the committing scope's authorize revalidates end-to-end (the
    gateway authenticates; scopes authorize). `target`
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
    A resolved direct verb may instead declare
    `arg_spec.authority.authoring_target:{arg:N}`. After validating that
    argument as a concrete object id, the gateway warms its bounded authority
    closure and replaces the default with the target's immutable authority
    scope. The hashed transcript carries
    `{authoring:{target,operation}}`; the committing scope verifies it owns the
    target. This override changes ordering only: it grants no capability and
    the verb body plus substrate still perform every permission/version check.
    It also binds no-write failures and retry receipts to the edited target,
    rather than the actor's unrelated current room.
  - A route:`sequenced` Net turn consumes a semantic-space log seq only when
    CO2.3 selects that space's authority. Pure movement remains off the room
    sequencer and is not represented as a room-log entry; any turn emitting
    a room-owned act necessarily rides at the room and logs atomically.
  - Accepted turn replies carry the planned transcript's `result`,
    `error`, and `observations` (the gateway holds the planned
    transcript; `error` matters because an errored verb still commits its
    failure envelope and canonical `$error` outcome — without the field an
    accepted no-op is indistinguishable from success). Aborted behavior-domain
    effects are absent. A scope-confirmed replay of a durable
    commit marks `replayed:true` and returns the RECORDED outcome of the
    execution that committed rather than the replay's own re-plan, with
    `replay_outcome` (`full`/`partial`/`none`) and `replay_omitted` naming
    anything the authority did not retain (CO2.5, mcp.md §M4.2); a pure
    direct read is not cached and safely returns a newly validated result at
    the unchanged head.
  - `GET /net-api/relation` / `GET /net-api/cell` are the authenticated
    client reads over the CO13 roster mirror and the view cell probe. `POST
    /net-api/cells {session, keys}` is the bounded authoritative counterpart:
    it accepts at most 32 exact keys, groups them by the owning scope already
    established by the caller's presence-scoped view, fetches those keys from
    each authority, and returns them in request order. It never enumerates an
    object's properties or a scope's cells. The gateway authorizes every key
    both before the fetch and after installing the authority's lineage/live
    support cells, so movement cannot turn an allowed stale-view read into a
    disclosure from a room the caller has left. Requested absence is an exact
    answer from the established owner, not a cache miss. A client projection
    wider than 32 keys issues successive bounded batches and reconstructs the
    caller's original order; it does not turn the server's authority-work cap
    into an all-or-nothing component failure.

    An authoritative exact read records a durable per-key authority floor,
    carrying the key's current owner scope and that scope's returned head.
    Sequence numbers are comparable only within one scope: when a key moves,
    recording the new owner replaces the old sequence instead of maximizing
    across scopes. Repeat hydration at an unchanged or older same-scope head
    is a zero-row SQL no-op. Fanout at or below the current-scope floor still
    advances delivery continuity, applies unrelated cells and relation deltas,
    and delivers observations, but cannot overwrite that key (including an
    authority-confirmed absence). The first later fanout for the key above the
    floor applies normally and retires the floor. This is deliberately not a
    scope high-water advance: using the scope high-water for a sparse read
    would suppress unrelated observations and relation changes between the
    gateway's prior view and the authority head. The floor table is derived
    gateway cache state and reconstructs naturally through a later exact read.
    Every 256 changed floor rows, a sweep retains the highest-rowid 4096 rows
    per gateway shard (so at most 4351 exist between sweeps); evicting an older
    floor safely restores the former stale-tolerant mirror semantics for only
    that key.

    Session ids are bearer credentials: relation reads expose only actor-level
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
    target, verb, verb_definer?, verb_slot?, args?, idempotency_key?}` runs the `/net-api/turn`
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
    catch-up is deliberately NOT promised in Phase 4. A gateway shard with
    neither hibernating sockets nor live MCP session state has no peer-delivery
    carrier and MUST skip the presence-mirror audience scan; HTTP-only callers
    already receive their own observations on the turn reply. Otherwise the
    gateway MUST intersect the scope mirror with its bounded local carrier
    sessions through the `(relation, owner_scope, member)` index. Fanout work
    therefore scales with local viewers, not every actor present in the room.
  - **Direct live observation delivery:** an accepted effect-free direct turn
    uses the same CO13 presence mirror but a separate unsequenced carrier.
    The validating scope sends `{type:"live_observations", scope, echo_id?,
    observations}` best-effort to the bounded fanout-role gateway shard
    registry; the origin gateway delivers its own slice only after the scope
    replies, avoiding a gateway→scope→origin RPC cycle. The carrier has no
    `seq`, never enters the durable outbox, never advances a gateway
    high-water, and a disconnected recipient loses it. Presence-derived
    audience enumerations are not completeness proofs: every destination
    shard resolves `presence` mode against its own scope-indexed relation
    slice. The Net carrier MUST NOT copy the planner's session-audience lists:
    session ids are bearer credentials and routing them once per observation
    makes envelope size depend on stale derived session history. It carries the
    parallel audience-mode vector plus non-secret actor refs for
    `explicit`/private observations; each destination gateway maps those actors
    to its own indexed, in-scope carrier sessions. The submitting client gets
    the full observation on `turn_result`; the shared echo digest suppresses a
    redundant live frame during rolling failure.
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

## CO16. Scheduled turns

> Status: **implemented** — CO16.1–CO16.7 and the failure record of
> CO16.8/CO16.9, end to end from the `schedule` builtins through the
> transcript to delivery, plus recycle cancellation and the CO16.9 live
> introspection read. **Not yet implemented:** cancellation on scope
> retirement (CO17 is itself draft). Design rationale in
> `notes/2026-07-24-scheduled-events-design.md`. This section supersedes
> [v2-turn-network.md §VTN18](v2-turn-network.md#vtn18-scheduled-turns-draftproposed);
> where the two differ, this governs.

### CO16.1 The primitive

The substrate offers exactly one deferred-execution primitive:

> Fire verb `V` on object `O` with args `A`, **once**, at wall-clock time
> `T`, as a committed turn in **this** scope, on behalf of actor `X`.

Not recurrence, not cron expressions, not calendars or timezones. A
periodic behavior is a verb that re-schedules itself; a calendar rule is
woocode that computes the next `T`. The substrate has no business knowing
about weekdays, and a scope that owns its own queue needs no global
scheduler — which is what keeps this compatible with a world of millions
of scopes.

**Time is UTC epoch milliseconds.** `ScheduledTurn.at_logical_time` is the
scope clock denominated in epoch ms, compared against the host clock. The
field name is historical; it is not a turn counter. Ordering of committed
turns is the sequenced log's `seq` — that is what "logical time" was
reaching for, and the log already provides it.

Delivery is at a wall-clock instant; **ordering among turns that fire
together** is `(at_logical_time ASC, id ASC)`, and each fired turn takes
its own `seq` in the normal way.

### CO16.2 Schedules are transcript effects

`schedules` and `cancellations` are named, typed arrays on the
`EffectTranscript` (CO3), parallel to `creates` and `recycles`. They MUST
NOT be represented as `TranscriptWrite` entries with a fabricated `op`.

The commit scope applies them **atomically with the turn's writes**. A
timer armed by a turn that was then rejected does not exist; a turn
replayed arms the same timer. This is CO9 — one write path per fact — and
it makes the ordinary acceptance receipt the answer to "did my timer get
set?".

```ts
type ScheduledTurnRequest = {
  id:              string;      // namespaced `<object>:<key>`; see CO16.3
  at:              number;      // UTC epoch ms; >= arming clock + lead time
  idlePolicy:      "while_active" | "always";   // CO16.6
  call: {
    actor:  ActorRef;           // MUST equal the arming turn's actor
    target: ObjRef;             // MUST be held by the committing scope
    verb:   string;
    args:   WooValue[];
  };
  armed_by:        RecordedWriteAuthority;      // frame provenance; see below
};

type ScheduleCancellation = {
  id:              string;
  armed_by:        RecordedWriteAuthority;
};
```

**Frame provenance is mandatory.** `armed_by` is the same
`RecordedWriteAuthority` an ordinary `TranscriptWrite` carries, naming the
VM frame that performed the effect. Without it the scope has nothing to
check its own rules against at all: which object's namespace an id belongs
to, and whether the arming frame held wizard authority, would both be
unanswerable. Schedule effects are validated per-frame exactly like
writes — **never** against the union of frames in the transcript.

**What that does and does not prove.** The scope validates provenance for
*consistency*: the namespace matches `armed_by.this_obj`, the scheduled
actor matches the turn's actor, and the wizard flag is read from the
scope's own authority cells rather than asserted by the submitter. It does
**not** prove that the named frame really ran — a planner that fabricated
`armed_by` naming an existing wizard could arm an `always` entry.

That is the same trust posture every `TranscriptWrite` already has: a
planner that fabricates provenance can fabricate a write's `writer` too,
and CO1 places the gateway inside the deployment trust boundary. Schedule
effects are therefore no weaker than writes — but they are not stronger,
and this section should not be read as promising a proof the layer cannot
give. Closing it needs frame attestation for writes generally, which is
out of scope here (CO11).

`armed_by` is **validated and discarded**. It does not enter the pending
entry and does not ride into the fired turn; CO16.4's rule that no
programmer authority is stored survives intact. Provenance answers "was
this effect legitimate when it was recorded?", not "what may the fired
turn do?".

There is no `scope` field: the entry belongs to the scope the transcript
is submitted to, and a field naming it would be a claim to check rather
than a fact. Same-scope membership is established from the target instead
(below). There is no `kind` field either — these are transcript members,
not standalone envelopes.

Validation at commit:

- The target MUST be **held by this scope**: it has a lineage cell here,
  or this same turn creates it *and that create lands here*. Created cells
  route by the create's anchor, so an object anchored under something in
  another scope belongs to that scope; accepting any created id would arm
  foreign targets.

  This MUST be decided from authoritative local evidence — a lineage cell
  the scope holds, or an anchor chain within the same transcript that
  terminates in one (or in an unanchored, therefore self-hosted, create).
  A routing classifier cannot answer it: a Scope DO reports "this scope"
  for every object it holds no hint for, and routing hints never carry
  schedule targets or create anchors, so asking one whether a foreign
  anchor is foreign returns "no". An anchor with no local evidence fails
  closed. Cross-scope scheduling is not
  a primitive (CO16.4); waking another scope is an ordinary committed turn
  submitted by the fired verb.
- `at_logical_time` MUST be at least the minimum lead time (CO16.6) beyond
  the committing turn's recorded wall-clock input, and within the horizon
  of CO16.7.
- `armed_by.this_obj` MUST be the object whose namespace `id` names
  (CO16.3). This is the whole enforcement of the namespace rule.
- `id` is an **upsert key**: an existing pending entry with the same id is
  replaced atomically. This is what makes a self-re-arming chain
  idempotent. Because the namespace is proved, an upsert can only ever
  replace an entry the same object armed.
- `idle_policy: "always"` requires `armed_by.progr` to hold wizard
  authority (CO16.6).
- An `id` appearing in both `schedules` and `cancellations` in one
  transcript is rejected. Otherwise the two arrays apply atomically.
- Over any quota in CO16.7 → `E_QUOTA`, rejecting the turn whole. A
  partially-applied schedule set is exactly the split state CO2.2 forbids.

Cancelling an id that does not exist is a no-op — cancellation is
idempotent and reports nothing back (CO16.3).

**The queue is not in `post_state_hash`.** The digest is derived from
touched authority *cells* (CO4 step 10), and the pending queue is a
separate durable row family, deliberately un-hydrated at the gateway
(CO16.5). Putting it in the preimage would require every planner to hold
the queue in order to predict the digest, which is exactly the coupling
the row family exists to avoid. Nothing is lost: queue effects are not
predictions the planner makes and the scope confirms — they are
*instructions* the scope validates independently, against provenance,
namespace, authority, and quota, all of which it can check from the
transcript alone. Divergence in the sense `post_state_hash` detects is not
possible for a value the planner never computes.

`POST /net/schedule` remains as a substrate/operator surface for seeding,
repair, and tests. It bypasses provenance validation and is therefore an
internal-authority route, not a path catalog code takes; a world in steady
state does not use it.

### CO16.3 Identity is namespaced to the scheduling object

The stored id is `<scheduling object ref>:<key>`, constructed by the
engine, never supplied whole by the author. Two forms:

- **Stable key** — `key` as given by the caller. Upserts. This is the form
  a periodic chain uses to re-arm without accumulating duplicates.
- **Turn-unique** — `key = hash(turn_id, per_turn_counter)`. Distinct per
  call within a turn, stable across replay. The form for one-shots.

`cancel_schedule` may name only ids in the calling object's namespace,
proved by `armed_by.this_obj` (CO16.2). Without this rule any verb in a
scope could cancel or silently overwrite any other object's timer — a
same-scope denial of service with no audit signal. A wizard may cancel any
id in the scope through an explicit privileged path, which is auditable.

**Cancellation reports nothing.** `cancel_schedule` yields no value: not
whether an entry existed, not whether one was removed. It cannot, honestly.
The queue is scope-owned state that the planner does not hold, and any
answer computed at plan time can be falsified before commit by a
concurrent fire, upsert, or cancellation of the same id — with nothing to
invalidate the turn, because the turn read no cell. An idempotent
instruction with no return value has no such window. Callers that need to
know whether a deadline was met arrange it in their own state, which is
ordinary cell data under the ordinary read-version rules.

The same reasoning removes queue *reads* from the turn path entirely:
there is no builtin that returns pending entries. Introspection is a live
read (CO16.9), outside commit semantics, where staleness is expected and
harmless.

### CO16.4 Authority

- **Session-less.** `ScheduledTurn.call` carries actor/target/verb/args
  and no session, so per CO14's sessions-absent rule the fired turn runs
  on actor authority via the DIRECT route. Note that `direct` here is a
  *session* posture, not a log posture: the `sequenced` route requires a
  session, and a scheduled turn has none by construction — its actor may
  not even be connected. An earlier draft of this section called for
  dispatching scheduled turns as `sequenced`; that is not expressible,
  and the implementation fails in planning if it is attempted.

  **Authorization is the ordinary permission kernel against the recorded
  actor, at fire time.** Resolve the verb by normal lookup; check `x` /
  verb-owner / wizard against the actor per
  [permissions.md §11.4](../semantics/permissions.md#114-effective-permission);
  run the frame with `progr` set to the resolved verb's owner. Presence
  checks do not apply — there is no session and no connection to be
  present on.

  The dispatch carries an internal `scheduled` marker — set only on the
  scheduler's own path, never reachable from a request body — which is what
  relaxes the ingress check and presents `caller = $system`. Without it the
  scheduler could fire only verbs a browser could also call directly, which
  excludes exactly the internal verbs a scheduled chain is made of; and a
  fired verb would see `caller = #-1` and be unable to tell it was woken.

  **`direct_callable` is not consulted, and that is a real difference from
  the client surface.** The flag is an *ingress* gate: the gateway's
  client path refuses an externally-requested `direct` route to a verb
  that does not declare it, and the internal planner path does not apply
  that check. So a scheduled turn can invoke a verb an outside client
  could not invoke directly. The bound is that it runs as the recorded
  actor under the ordinary kernel, so it confers no authority that actor
  lacks — but arming a schedule is a way to reach verbs the external
  direct surface declines, and a catalog that relies on `direct_callable`
  as a security boundary rather than an ingress convention would be
  mistaken to do so.
  Arming a schedule therefore confers exactly the authority the actor
  already had to make the same call through the sequenced path, which is
  the only comparison that makes sense for a turn that *is* sequenced.
- **No stored programmer authority.** The pending entry does NOT capture
  the arming frame's `progr`. When the turn fires the verb dispatches
  normally and takes programmer authority from **its own owner**, exactly
  as on a live call. Capturing `progr` (as VTN18.2 proposed) would be a
  capability with unbounded lifetime, and it buys nothing.
- **Permission is checked at delivery**, against live world state, not at
  arming time. An actor who has been demoted, recycled, or moved out of
  scope produces an error frame and the entry is dropped. Scheduling
  therefore grants nothing the actor could not do at the moment of firing,
  and holds nothing they have since lost.
- **Attribution is captured at arming** (AU3.2): the `Principal` and the
  arming turn's trace context ride the durable row so the eventual turn is
  attributable and joins the originating trace. Attribution never widens
  authority.
- `target` may be any object in the scope, not only `this`. The fire-time
  check is the ordinary one, so this grants nothing a live call would not.

### CO16.5 Delivery — implemented

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
- With no registered planner, due turns stay parked with a named metric
  (`net_scope_scheduled_turn_fired`; the non-destructive peek is the
  specified no-planner state). A later planner subscription arms an
  immediate wake, so parked overdue turns dispatch without waiting for
  an unrelated alarm. Dispatches emit
  `net_scope_scheduled_turn_dispatched`.

### CO16.6 Delivery envelope

**Minimum lead time: 60 seconds.** `at_logical_time` MUST be at least 60
seconds beyond the arming turn's recorded clock input. A request for less
is **clamped** to the floor, not rejected. A world MAY raise the floor
through `$server_options`; lowering it is a substrate change, not a
configuration knob.

This is a *lead time on arming*, not a rate limit between deliveries. The
distinction matters and the earlier draft of this section had it both ways:

- A lead time is checkable from the transcript alone, by both the arming
  VM and the validating scope, against a value the turn already records.
  It needs no durable last-delivery index, and therefore no bounded
  cleanup for one, and no answer to what happens when the index is cold.
- A pairwise `(target, verb)` rate limit would need all of that, and would
  still not bound the thing worth bounding: a chain's own frequency.

A chain re-arms only after it fires, so a lead time bounds a chain to one
turn per minute — which is the whole cost argument. Independent entries
can still come due together; that burst is bounded by the per-scope cap
and the bounded-batch alarm (CO16.5), which is where burst belongs.

The rate follows from what a delivery *is*: a full committed turn — a
sequencer transaction, a fanout pass, an audit record, a projection fold —
against an envelope of p95 ≤ 750ms for submits (CO10). **The committed
plane is not for animation.** A minute is the finest grain at which
durable, ordered, audited, replayable execution is offered; anything
faster belongs on the live plane or in the browser. VTN18.10's
live-vs-committed table is the guidance.

**Idle policy.** Each entry declares one, explicitly — it is a parameter of
the arming call (`scheduling.md §SC2`), never inferred. A stable key does
not imply a repeating chain: a cancellable deadline uses one too.

- **`while_active`** — the scope does not fire it while it has no live
  session subscribers. The entry stays parked; the next accepted turn in
  the scope re-arms it. Correct for anything whose only purpose is to be
  observed. The default for repeating chains, and available to ordinary
  catalog code.

  "Live subscriber" means an entry in the scope's `session_subscribers` —
  the delivery audience — and nothing else. Fanout- and planner-role
  `/net/subscribe` registrations are infrastructure and MUST NOT count:
  a scope always has a planner registered when scheduling works at all,
  so counting one would make `while_active` a synonym for `always`.

  Hidden-roster service sessions (`roster_visible:false`) **do** count.
  They are absent from the social projection but present for delivery, and
  this test is a delivery question: something is attached and will receive
  the observation. A weather plug holding a hidden session keeps its
  scope's `while_active` chains running, which is the intended behaviour —
  it is a real observer, just not a person in the room.
- **`always`** — fires with nobody watching. Required for deadlines,
  expiries, and pushes. **Arming one directly requires wizard authority**:
  a periodic `always` chain is the one shape here that bills a world
  forever in a scope no one will visit again.

  The wizard rule attaches to arming, not to the shapes built on it.
  Ordinary user-facing one-shots — "remind me in ten minutes", "close this
  after 24h" — reach `always` through wizard-owned catalog verbs that arm
  on the caller's behalf under their own owner's authority, the same
  pattern any privileged builtin is wrapped in. The effect of the rule is
  *no unattended timer without going through code a wizard wrote*, not
  *no reminders*.

**No catch-up.** An overdue entry fires **once**, at its first opportunity.
Periodic chains skip missed intervals rather than replaying them: a chain
re-arms only after it fires, so this follows from the upsert semantics. A
scope evicted for a month must not wake and execute a month of ticks. The
fired verb receives both the intended and the actual time (CO16.8) and may
decide for itself what the gap means.

### CO16.7 Quotas

| Bound | Default | Enforced |
|---|---|---|
| Pending entries per scope | 1000 | commit validation |
| Pending entries per object | 32 | commit validation |
| Serialized bytes per entry | 8 KiB | VM and commit validation |
| Serialized bytes per scope queue | 2 MiB | commit validation |
| `schedule` calls per turn | 16 | VM |
| Minimum lead time | 60s (CO16.6) | VM (clamp) and commit validation |
| Maximum horizon | 365 days | VM and commit validation |

**Counts alone do not bound storage.** `id` keys, verb names, and `args`
are author-supplied and otherwise limited only by the submit envelope, so
1000 entries × many scheduling objects accumulates megabytes of durable
scope state that no cell-storage accounting sees. The byte caps are the
actual bound; the count caps bound the alarm's work per firing. Both are
needed. Serialized size is measured over the durable row as stored —
`id`, `call`, `at_logical_time`, `idle_policy`, and captured attribution —
so the number an author can reason about is the one the scope enforces.

Over-cap raises `E_QUOTA` with the pre-action semantics of
[failures.md](../semantics/failures.md) — which quota, current vs limit,
no partial state. These are scope-local caps on a scope-local row family,
distinct from the per-owner storage accounting of
[quotas.md](../reference/quotas.md).

The 365-day horizon rests on an untested property: that host alarms set
across multi-day boundaries fire reliably and that hibernated state is
fully reconstructible from durable storage alone. See
[tasks.md §16.2](../semantics/tasks.md#162-deferred-execution).

### CO16.8 Lifecycle

- **Target recycled** → the scope cancels its pending entries in the same
  transaction as the recycle, in **both directions**: entries that would
  fire *at* the object, and entries the object *armed* on something else.
  Leaving either behind means a timer that wakes a tombstone, or one that
  outlives the only thing that could have cancelled it. The scope does
  this rather than the recycling verb because only the scope holds the
  queue — woocode cannot enumerate pending entries and so cannot cancel
  what it cannot see. Bounded by the per-scope cap, so a scan, not an
  index.
- **Target moved out of scope** → the entry fires, the turn cannot resolve
  the target, the failure is recorded per the rule below, entry dropped.
  Silently following an object across scopes would be the cross-scope
  primitive CO16.1 declines to build.
- **Actor recycled or demoted** → fire-time check fails, failure recorded,
  entry dropped (CO16.4).
- **Verb removed or renamed under a catalog upgrade** → the turn fails at
  fire time, the failure is recorded, and the entry is dropped. One
  recorded failure per broken timer.
- **Epoch fence** → **entries survive.** They carry the epoch they were
  armed under for attribution, but the fired turn is planned against the
  *current* epoch. Cancelling every pending entry on a fence (as VTN18.6
  proposed) would stop every timer in a world on the routine operation of
  upgrading a catalog, silently. A catalog migration that renames a ticking
  verb must re-arm — the same obligation any migration carries.
- **Scope retirement (CO17)** → the retiring scope cancels its pending
  queue and clears its alarm before teardown.
- **Failure does not retry.** A scheduled turn that errors is not
  re-delivered; a chain that wants retry re-schedules explicitly. A broken
  chain therefore stops on its own, which is the desired failure mode.

**A failed scheduled turn MUST leave a durable record.** This does not
happen by itself, and the delivery path as built actively defeats it: the
planner returns a terminal-rejected `TurnResult`, the sending scope sees
HTTP 200, deletes the outbox row, and drops the verdict on the floor
(CO16.5's exactly-once rule is about not re-firing, and says nothing about
where the verdict goes). Nobody is waiting on the reply — the actor has no
session and by construction may not even exist — so unless the scope
writes it down, a broken deadline fails in perfect silence, which is the
one outcome a deadline must never have.

The rule: on a terminal rejection **or an accepted turn whose verb threw**,
the scope records a `scheduled_turn_failed` entry — `{id, at, fired_at,
target, verb, actor, outcome, detail}` — in the same transaction that
deletes the outbox row, and emits it to the scope as an observation.

Both shapes matter and they look nothing alike. A rejected commit carries
its verdict nested inside the planner's `TurnResult.reply`; an accepted
commit whose verb raised carries a top-level `error` and a `status` of
accepted, because a verb that throws still commits its sequence, failed log
outcome, and canonical `$error`, while its behavior-domain effects are rolled
back. Reading
only one of them — or reading a top-level `status` that the real reply
never has — records nothing for the case most likely to happen in
practice. Recording is what makes the "one
recorded failure per broken timer" claim above true rather than
aspirational. It is bounded by the same caps as the queue and ages out on
the ordinary schedule.

Abandonment of a `/plan-scheduled` outbox lane (planner persistently
unreachable) records the same way. From the world's point of view "the
planner never ran it" and "the planner ran it and it failed" are the same
event: the timer did not do its job.

**Fire-time context.** The fired turn presents `caller = $system` and a
`scheduled: {id, at, fired_at}` block, so a verb can tell it was woken
rather than called, and how late it is.

**`tell` is not durable.** A scheduled verb that reports only through
`tell(actor, ...)` produces nothing at all when the actor is disconnected,
and the substrate does not detect or warn about this. Scheduled work whose
output matters MUST land it durably — an act on the log, a note, a message
object — and may `tell` in addition. Catalog surfaces are responsible for
making the durable path the default one.

### CO16.9 Observability

- `net_scope_scheduled_turn_fired` — due entry moved to the outbox, or
  parked with no planner registered.
- `net_scope_scheduled_turn_dispatched` — planner dispatch.
- A per-world count of live `always` entries. This is the recurring-cost
  number; it is the reason CO16.6 gates them.
- `net_scope_scheduled_turn_failed` — a recorded terminal failure or
  abandonment, per CO16.8. A world with a rising count here has timers
  that are not doing their job, and it is the alert that matters most.
- Pending entries are introspectable through a **live** read: the scope
  answers `GET /net/schedules` with its pending rows *and its recent
  failure records*, and the gateway exposes it as
  `GET /net-api/schedules?scope=` under the same co-presence rule the
  other client reads use — you can see what a room has armed if you are in
  it. Failures ride along because "what is armed" and "what did not fire"
  are one operational question, and a failed timer is absent from the
  pending list precisely because it is gone.

  It is a **live** read — a non-committed query answered by the scope,
  outside turn semantics.
  Invisible timers are unmaintainable for authors and worse for operators,
  but introspection deliberately does not enter the commit path: a queue
  read inside a turn would need a versioned read proof to be honest, and
  the queue is not a cell (CO16.2). A live answer may be stale the instant
  it is returned, which for "what does this room have armed?" is fine and
  for a committed decision would not be.

Outbox **abandonment** of a `/plan-scheduled` row is the named divergence
(CO16.5), and for scheduled turns it means *a deadline silently never
fired*. It warrants an alert, not only a metric, before a world depends on
`always` entries.

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

   The **pending schedule queue** (CO16) is cancelled in this step, not
   drained: entries not yet due are discarded, and any already moved to a
   `/plan-scheduled` outbox row drains with the rest. A retiring scope
   arms no further alarms for scheduled work. Nothing survives to fire
   into a reclaimed scope.
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
