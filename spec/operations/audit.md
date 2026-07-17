---
date: 2026-07-16
status: draft
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
   authenticating edge sees it.

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

- The gateway starts a trace per client turn — or **adopts an inbound
  `traceparent`** from the `/net-api` REST/WS/MCP surface. Adoption is
  the business-end join: a customer whose agent framework already emits
  OTel can follow one trace from their own system, through woo's
  gateway, scope commit, and fanout, into their audit export.
- Spans are emitted at the seams that already exist: one span per
  `Host.rpc` call ([transport.md §TR1](../protocol/transport.md) — the
  single choke point makes this a one-place instrumentation), the
  gateway's turn phases (today's `turn_phase_timing` phase map), the
  scope's validate/commit, and the VM run.
- **Async causality uses links, not parenthood.** Outbox deliveries,
  adoption riders, alarm-driven retries, and scheduled turns each start
  a new trace **linked** to the originating turn's span context, which
  is carried in the durable row (outbox row, scheduled row). A
  fanout-storm never produces an unbounded parent trace.
- The trace context rides the turn envelope and is recorded in the
  committed transcript, so every audit record carries the `trace_id`
  that joins it to the operational trace — and to the customer's own
  systems when the traceparent was adopted.

## AU3. The principal envelope

Objects and scopes that touch a turn have no access to each other and no
knowledge of accounts. The customer identity therefore travels *with the
turn*, stamped once at the trust boundary:

```ts
interface Principal {
  customer: str;        // owning ACCOUNT id of the acting actor (auth.md A2)
  team?: str;           // owning team at event time (identity/teams.md), if any
  actor: ObjRef;        // the acting actor
  session?: str;        // session id (absent on direct-route/tooling turns)
  credential?: str;     // credential id used to authenticate (apikey id, bearer sub)
  on_behalf_of?: str;   // delegation: the customer a service credential acts for
}
```

- **Stamped by the gateway at authentication**, never accepted from
  client input: the gateway resolves credential → actor (CO14) → owning
  account (`$account` binding, an identity cell in the catalog-scope
  closure — epoch-stamped, cacheable, no global lookup).
- **Validated at commit**: the scope's authorize step (CO4) checks
  `principal.actor` equals the transcript's actor; a mismatch is the
  existing `actor_mismatch` verdict. The scope does not re-resolve the
  account — the gateway is the authenticating edge; the scope records
  what the edge attested, and the credential id makes the attestation
  auditable itself.
- **Carried through every indirection**: adoption riders carry the
  originating turn's principal; scheduled rows capture the principal at
  schedule time (CO16's session-less turns thereby stay attributable);
  the wizard/operator surface stamps an operator principal. `team` is
  captured at event time — audit records are immutable, so later team
  membership changes do not rewrite history; team-scoped queries group
  by the stamped value plus query-time membership as the consumer
  chooses.

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
  delegated service credentials: both parties' trails carry it).
- **Resource-owner record, when different**: a committed turn whose
  scope anchor belongs to a different customer (actor from customer A
  acting in customer B's room) additionally routes a copy to the
  anchor-owning customer. Both have a legitimate "my business" claim:
  A's trail answers "what did my people do", B's answers "what happened
  in my space". The resource-owner copy carries the same record —
  attribution is dual, content is identical.
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
   are exact, not approximate.
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
