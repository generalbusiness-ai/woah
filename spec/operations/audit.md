---
date: 2026-07-16
status: partial — AU2 (context threading), AU3 (attribution pipeline + principal envelope) implemented on the net stack; AU1/AU4–AU10 (records, delivery, query) draft
---

# The audit trail — unified audit and observability (AU1–AU10)

> Part of the [woo specification](../../SPEC.md). Layer: **operations**.
>
> One correlation fabric, two consumers. **Operational telemetry**
> (traces/metrics/logs, [observability.md](observability.md)) answers "is
> the platform healthy, why was this slow" — sampled, lossy, short
> retention. **The audit trail** answers the customer's business
> question — *who did what, when* — lossless, durable, attributable,
> tamper-evident, per-customer routed. This document specifies the shared
> correlation model (OTel-semantics), the principal envelope that threads
> the customer identity through hops that don't know about each other,
> the audit record, and the delivery pipeline. It generalizes
> [observability.md §O5](observability.md#o5-audit-log) (the wizard audit
> channel becomes one partition of this trail) and supersedes nothing
> else; O2's per-call trace becomes the span tree of AU2.

## AU1. One source of truth, two producers

The governing rule is CO9 applied to audit: **an audit record is a
derived projection of an authoritative event, never an independently
written account of it.** There are exactly two authoritative producers:

1. **Scopes**, for everything that committed. The effect transcript of
   an accepted turn already carries actor, verb, target, write set,
   observations, `(scope, seq)`, and the hash-chained head. The scope
   mints the audit record **in the same transaction as the commit** —
   the record cannot disagree with the turn, and a turn cannot commit
   without its record.
2. **Gateways**, for everything that was *attempted but never
   committed*: authentication failures, session refusals
   (`E_NOSESSION`), rate refusals (`E_RATE`), terminal turn rejections.
   "Who *tried* to do what" is audit-relevant and only the
   authenticating edge sees it. These records carry a `credentialed` or
   `anonymous` principal (AU3.2) — full attribution is unknowable
   before successful authentication, and the spec does not pretend
   otherwise.

One clarification on scope-produced records: an **adoption commit**
(owner-sequenced application of another scope's rider writes, CO2.3)
does not mint a new acting-customer record — the originating turn's
commit already did, and double-counting one action is worse than
useless in an audit trail. The adoption commit mints only the
**resource-owner record** of AU5 (when its `scope_attribution` differs
from the carried principal's customer), citing the originating
`(scope, seq)` and carrying the same trace context, so causality is
retained without duplication.

Nothing else writes audit records. In particular, woocode and catalogs
never write them directly — a catalog action is audited because it
committed, with the verb/target names carried as data (core stays
catalog-agnostic; the trail carries meaning without the substrate
knowing it).

## AU2. Correlation: OTel semantics, W3C propagation

The correlation currency is literal OpenTelemetry *data model*: 128-bit
`trace_id`, 64-bit `span_id`, W3C `traceparent` propagation, span
**links** for asynchronous causality. It is deliberately **not** the
OTel SDK in-process (see AU8).

The durable and wire representation is the W3C header strings
**verbatim** — `{trace_id, span_id}` alone loses flags and vendor
state, so the full context is what travels:

```ts
interface TraceContext {
  traceparent: str;         // W3C: "00-<trace_id>-<span_id>-<flags>"
  tracestate?: str;         // W3C tracestate, carried opaque, never parsed
  origin: "adopted" | "minted";
}
```

- **Carriers (normative, closed list):** the `traceparent` (+
  `tracestate`) HTTP request headers on `/net-api/*` REST and on each
  MCP HTTP request; an optional `trace: {traceparent, tracestate?}`
  field on the WebSocket turn frame; internally, a `trace` field on the
  turn envelope, recorded in the committed transcript, and copied into
  every durable row that continues the work — outbox rows (all lanes),
  adoption rider envelopes, and scheduled-turn rows.
- **Invalid or absent context never rejects a turn**: the gateway mints
  a fresh root (`origin: "minted"`); a syntactically invalid
  `traceparent` is treated as absent. Adoption is the business-end
  join: a customer whose agent framework already emits OTel can follow
  one trace from their own system, through woo's gateway, scope commit,
  and fanout, into their audit export.
- **Sampling**: the W3C sampled flag governs *ops span export only*.
  Audit records are minted regardless of it — the trail is lossless by
  definition (AU6) and merely carries the ids.
- Spans are emitted at the seams that already exist: one span per
  `Host.rpc` call ([transport.md §TR1](../protocol/transport.md) — the
  single choke point makes this a one-place instrumentation), the
  gateway's net turn pipeline (plan/submit/repair attempts), the
  scope's validate/commit, and the VM run.
- **Async causality uses links, not parenthood.** Outbox deliveries,
  adoption commits, alarm-driven retries, and scheduled turns each
  start a **new trace** whose root span carries a span **link** to the
  context stored in the durable row. A fanout-storm never produces an
  unbounded parent trace, and an evicted-and-resumed drain still links
  correctly because the context lives in the row, not in memory.

## AU3. Customer attribution and the principal envelope

### AU3.1 The `customer_of` attribution relation

Authentication resolves a credential to an **actor** only
(`api_keys[*].actor` — `src/worker/net/client-auth.ts`); the identity
graph that connects an actor to its ultimate owner (`$human.account`,
`$agent.owner` → `$human`-or-`$wiz`, `$account.actors` —
[auth.md §A2](../identity/auth.md#a2-account-vs-actor),
[provisioning.md §AP4](../identity/provisioning.md)) is a graph of
world objects spread across scopes. It MUST NOT be walked at runtime.
Instead, attribution is **materialized once, at binding time**, as a
durable per-actor cell:

- **Cell**: `customer_of:<actor>` — authoritative at the actor's own
  cluster scope (the same home as the actor's session cells, CO14, so
  the gateway's existing cluster pull/cache machinery serves it).
  Value: `{customer, team?, derived_via, bound_at}`.
- **Written only by the identity pipeline**, as ordinary commits in the
  actor's cluster scope, at exactly these moments: account signup /
  actor binding (AP flows), agent provisioning (owner captured), the
  cutover identity import (`src/net/identity.ts` carries the full
  account/actor graph — the import derives and seeds these cells), and
  explicit ownership transfer (an audited admin action, AU5).
- **Closed derivation rules** (applied at write time, recorded in
  `derived_via`):
  1. actor bound to an account (`$human`, multi-character players,
     account-bound service actors) → `customer` = that account id;
  2. `$agent` owned by a `$human` → the human's account;
  3. `$agent` owned by `$wiz`, wizard and operator actors →
     `customer` = the distinguished `operator` id;
  4. guest actors → the distinguished `guest` attribution; their
     records route to the operator partition. A guest later binding to
     an account re-writes the cell; **history does not move** — records
     are immutable and stamped at event time;
  5. any remaining actor attributes through its owner, one hop — the
     rule-2 walk generalized past `$agent`. The canonical case is
     catalog-seeded *acting appliances* (actor-classed world furniture
     that is neither agent nor guest): wizard-owned → `operator`; an
     owner bound to an account → that account. Ordered after rule 4 so
     `$wiz`-owned pool guests stay guest-attributed. No class names are
     special-cased — the rule reads only ownership and account binding.
- **The write contract is enforced below ordinary authoring**
  (implemented): `customer_of` is a reserved property name — `setProp`,
  `defineProperty`, and every verb write funnel through the reservation
  and refuse with `E_PERM`, so an object's *owner* cannot rewrite an
  owned actor's attribution. The identity pipeline writes through the
  privileged, shape-validated `world.setCustomerOf`, and the install
  pipeline closes the "every actor" invariant with a whole-world
  materialization pass (`materializeCustomerAttributions`) before
  partitioning — preseeded pools and catalog-seeded actors included.
- Every actor that can act has an attribution cell; a turn whose actor
  has none is an *identity-pipeline bug*, surfaced as a named record in
  the operator partition (`outcome: "unattributed"`) — never a dropped
  record, never a runtime graph walk to repair it.

### AU3.2 The principal envelope

Objects and scopes that touch a turn have no access to each other and no
knowledge of accounts. The customer identity therefore travels *with the
turn*, stamped once at the trust boundary:

```ts
interface Principal {
  attribution: "authenticated" | "credentialed" | "anonymous";
  customer?: str;       // customer_of(actor) — REQUIRED when attribution="authenticated"
  team?: str;           // owning team at event time (identity/teams.md), if any
  actor?: ObjRef;       // the acting actor — REQUIRED when attribution="authenticated"
  session?: str;        // session id (absent on direct-route/tooling turns)
  credential?: str;     // credential id presented (apikey id, bearer sub)
  on_behalf_of?: str;   // delegation: the customer a service credential acts for
}
```

- `authenticated` — a successful auth: `customer` and `actor` are
  mandatory, resolved from the `customer_of` cell (pull-on-miss from
  the actor's cluster, cached with the session).
- `credentialed` — the credential was *recognized but rejected*
  (expired, revoked, actor-mismatch). `credential` is set, `customer`
  is the customer of record for that credential (revoked `api_keys`
  records are retained precisely for this), `actor` may be absent. The
  record routes to that customer *and* the operator.
- `anonymous` — unknown or malformed credential: no `customer`, no
  `actor`; the record routes to the operator partition only. AU1's
  gateway producer emits `credentialed`/`anonymous` principals; a
  committed turn always carries `authenticated`.
- **Stamped by the gateway**, never accepted from client input.
- **Validated at commit** (implemented, `ScopeSequencer.submit` step
  1b): a carried principal is shape-checked (per-variant field rules —
  `credentialed` requires its credential, `anonymous` may claim no
  customer or actor), must be `authenticated` (the edge-record forms
  never commit), is actor-matched against the transcript, and — when
  the committing scope owns the actor — is customer-checked against the
  durable `customer_of` cell, **refusing when the cell is absent**
  rather than trusting the edge's claim. Violations fold into the CO14
  `unauthorized` reject with a named `principal_verdict`:
  `malformed_principal`, `not_authenticated`, `actor_mismatch`,
  `customer_unverifiable`, or `customer_mismatch`. A turn carrying NO
  principal still commits (unattributed is a named gap, not a forgery).
  For scopes that don't own the actor, the scope records the edge's
  attestation; the credential id keeps the attestation itself
  auditable.
- **Carried through every indirection**: adoption riders carry the
  originating turn's principal; scheduled rows capture the principal at
  schedule time — an additive field next to `ScheduledTurn.call`
  (`src/net/scope.ts`). This is *attribution only*: CO16's deferred
  engine-side authority field is a separate, unaffected concern —
  scheduled turns still run as actor-authority direct-route turns, and
  the captured principal never grants or widens authority. The
  wizard/operator surface stamps an operator principal. `team` is
  captured at event time — records are immutable, so later membership
  changes do not rewrite history.

### AU3.3 Scope attribution (for AU5)

Anchor lineage carries an **owner objref**, not an account
(`object_lineage.owner`, `src/net/bridge.ts`), so a scope cannot derive
its owning customer from lineage at mint time. Each scope therefore
holds a durable `scope_attribution` meta value — the customer owning
the scope's anchor — stamped by the install/seed pipeline when the
scope is seeded (derived from the anchor owner's `customer_of` at that
moment) and rewritten only by audited ownership-transfer admin actions.
Cluster scopes' attribution is their actor's `customer_of` by
construction. A scope with no stamped attribution attributes to
`operator` and flags the record (`resource_attribution: "unstamped"`).

## AU4. The audit record

OTel log-record-compatible shape, so ops tooling can ingest it, but its
contract is the audit trail's, not telemetry's:

```ts
interface AuditRecord {
  ts: int;                          // producer clock, ms
  trace_id: str; span_id: str;      // AU2 join keys
  principal: Principal;             // AU3
  producer: { kind: "scope" | "gateway", name: str };
  idempotency: str;                 // scope: "<scope>:<seq>"; gateway: event ulid
  action: {
    verb?: str; target?: ObjRef;    // what was invoked
    kind: "commit" | "auth" | "session" | "refusal" | "admin";
    scope?: str; seq?: int; head?: str;   // committed turns: the provenance triple
  };
  outcome: "ok" | str;              // CO6 code or auth verdict on failure
  subjects: ObjRef[];               // objects touched (write set + moved/created/recycled)
  cause?: { scope: str, seq: int }; // adoption-minted records: the originating commit (AU1)
  detail?: JsonValue;               // redaction-governed summary (AU9), never raw args by default
}
```

The `(scope, seq, head)` triple makes each committed record
independently verifiable against the scope's hash-chained transcript
stream: the trail doesn't merely claim who did what — it cites the
commit.

## AU5. Attribution and routing

- **Acting-customer record, always**: every record routes to
  `principal.customer` (falling back to `on_behalf_of` semantics for
  delegated service credentials: both parties' trails carry it; for
  `credentialed`/`anonymous` gateway records, per AU3.2's routing).
- **Resource-owner record, when different**: a committed turn in a
  scope whose `scope_attribution` (AU3.3) names a different customer
  than the acting principal (actor from customer A acting in customer
  B's room) additionally routes a copy to the anchor-owning customer.
  Both have a legitimate "my business" claim: A's trail answers "what
  did my people do", B's answers "what happened in my space". The copy
  carries the same record — attribution is dual, content identical.
- **Every producer computes with local data only.** The committing
  scope compares the carried principal against its own stamped
  `scope_attribution` (the common ride-along case: the room scope *is*
  the committing scope). Foreign-owner effects get their resource-owner
  record at the owner's adoption commit (AU1), from the owner's own
  `scope_attribution`. No producer resolves another party's account,
  ever.
- The partition key is the **account id**. Routing is pure data
  threading (the principal is in the record) — no enumeration, no
  cross-customer lookup at delivery time (Big-World discipline).
- The operator is a distinguished partition that receives everything;
  O5's wizard-audit events land there as `action.kind: "admin"` records
  with the operator principal.

## AU6. The delivery pipeline

Delivery reuses the machinery this substrate already trusts:

1. **Mint durably with the event.** A scope's audit record is written
   to a durable **audit outbox lane** in the same transaction as the
   commit (the existing outbox family; lanes drain independently, so a
   slow audit sink never blocks fanout — CO2.7 discipline). Gateway
   records go to an equivalent durable gateway lane. An audit record is
   part of the event's durable obligations: it is dropped only by
   explicit retention policy (AU9), never by sampling, backpressure, or
   crash (contrast Analytics Engine, which stays the *sampled* metrics
   substrate — [reference/cloudflare.md §R10](../reference/cloudflare.md#r10-instrumentation)).
2. **Deliver at-least-once** over the transport seam to an audit
   destination — a new TR2 destination kind, `audit:<shard>`, sharded by
   hash of the customer id. Idempotency is the record's `idempotency`
   key; redelivery is a no-op.
3. **Append immutably per customer.** The audit shard batches records
   into immutable, hash-chained segments (each segment carries the
   previous segment's hash and the covering `(scope, head)` set) in
   object storage, partitioned `audit/<customer>/<date>/`, plus a small
   per-customer index (time, actor, target, verb, trace_id). Segments
   are encrypted at rest.
4. **Bounded local state.** The shard's buffer is outbox-disciplined and
   flush-bounded; long-term state lives in object storage, not in the
   shard. Shards follow the standard lifecycle rules (a shard holds no
   authority — it can always be rebuilt from undelivered lanes plus
   segments).

## AU7. Query and export

- **Customer query surface** — "who did what, when": filter by time
  range, actor, target object, verb, outcome, `trace_id`; answered from
  the per-customer index + segments; a customer sees exactly their
  partition. Exposed on the authenticated `/net-api` surface.
- **Customer push export**: per-customer configurable sink (webhook,
  object-storage pull, OTLP logs) fed from the same segments —
  at-least-once with the record idempotency key.
- **Operator/ops export**: spans and sampled telemetry go OTLP to the
  operator's tracing backend (AU8); the operator audit partition is
  queryable like any customer's, plus cross-partition for lawful
  operator purposes under O8's policy controls.
- **Verification**: a customer or auditor can verify a segment chain's
  integrity (hash chain) and spot-check any committed record against
  the cited scope head. Verifiability is the product feature: the trail
  is evidence, not narrative.

## AU8. Posture on "literally OTel"

Adopted literally: the **data model** (trace/span/link ids, semantic
attributes — `woo.customer`, `woo.actor`, `woo.scope`, `woo.seq`,
`woo.verb`), **W3C trace-context propagation** on every external
surface, and **OTLP as the export wire** for ops telemetry and
optionally for customer log export.

Deliberately not adopted: the OTel SDK as an in-process dependency of
DOs. The batching/timer/resource model of the SDK fits long-lived
processes, not workerd isolates with per-request lifetimes and strict
bundle budgets; and the audit trail's delivery guarantees (AU6) are
stronger than any telemetry exporter's. Emission is a thin in-house
layer: span emission piggybacks the existing metric sink at the same
seams, the audit pipeline is the outbox. If the platform's native
observability grows a compliant OTLP trace export, the ops side may
delegate to it; the audit side never does — sampling and best-effort
delivery are disqualifying there by definition.

## AU9. Privacy, integrity, retention

- **Redaction at mint**, per O8 policy: `detail` carries schema-tagged
  and flagged-safe fields only; raw args/values are elided or hashed by
  default. What was *done* is never redacted (verb, target, subjects,
  outcome); what was *said* is redacted by policy. Redaction class is
  recorded on the record so consumers know what was withheld.
- **Immutability**: no update or delete surface exists for records or
  segments; retention expiry deletes whole segments from the tail of
  the chain (the chain head stays verifiable) and is itself an audited
  admin action in the operator partition.
- **Retention** is per-customer policy; default long (audit-grade, e.g.
  400 days), with telemetry retention short (days) — the two consumers'
  policies never share a knob.
- **Access**: partition isolation is absolute at the storage layout
  level (per-customer prefixes, per-customer keys), not filter-level.

## AU10. Conformance

1. **Completeness gate**: in the shared smoke scenario, every committed
   turn yields exactly one acting-customer record (and the
   dual-attribution copy where the fixture crosses customers); a
   refused auth and a rate refusal each yield a gateway record; counts
   are exact, not approximate. Adoption commits yield **zero** acting
   records (single-count gate); an actor missing its `customer_of` cell
   yields the named `unattributed` operator record, not a silent drop.
   Gateway records with `credentialed` and `anonymous` principals each
   appear with exactly the fields AU3.2 mandates.
2. **Idempotency gate**: forced redelivery (TR8 `kill_after_commit` on
   the audit lane) produces no duplicate records in segments.
3. **Join gate**: for a traced turn, the gateway span, scope commit
   span, audit record, and (when adopted) the inbound traceparent all
   carry one `trace_id`.
4. **Verification gate**: segment hash-chain verifies; a committed
   record's `(scope, seq, head)` citation checks out against the
   scope's transcript stream.
5. **Isolation gate**: customer A's query surface cannot return a
   record from customer B's partition, including for turns both
   customers hold copies of.
6. **Loss posture gate**: with the audit sink faulted for the duration
   of a scenario, turns still commit (lane independence) and every
   record delivers after the fault clears.
