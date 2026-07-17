# Audit trail / unified observability — design rationale + implementation plan

Spec: `spec/operations/audit.md` (AU1–AU10, draft, written 2026-07-16).
Companion reworks from the same day's DO best-practices review:
`notes/2026-07-16-do-lifecycle-and-transport-plan.md` (the transport
seam and outbox machinery this pipeline reuses).

## The three decisions and why

**1. Audit = projection of committed transcripts, not a logging path.**
The requirement is "combine traces from objects that don't know about
each other" — but objects never needed to know about each other for
this, because every effect already flows through exactly one place: the
scope's committed transcript (actor, verb, target, write set,
observations, seq, hash-chained head). CO9's one-write-path rule applied
to audit: mint the record in the same transaction as the commit and it
can never disagree with what happened, survive a crash without the
event, or record an event that didn't commit. The only authoritative
events *outside* transcripts are un-committed attempts (auth/session/
rate refusals) — the gateway is authoritative for those and is the
second (and last) producer.

**2. Customer id is threaded data, not a lookup.** "Ultimate owner of
the actor" = the account (auth.md A2: account owns actors; credential →
actor binding is what the gateway already authenticates per CO14). The
`Principal` envelope {customer, team?, actor, session, credential,
on_behalf_of?} is stamped once at the gateway trust boundary, validated
at commit (actor-match), and carried through riders, outbox rows, and
scheduled rows. No component ever resolves an account downstream —
Big-World: no global lookups on the delivery path, routing key travels
with the record.

**3. OTel literally on the wire, not literally in-process.** Adopt the
OTel data model + W3C traceparent + OTLP export verbatim — the win is
at the *customer's* end: their agent frameworks already speak OTel, so
adopting inbound traceparent at `/net-api`/MCP means one trace joins
their systems to our audit citations. Reject the OTel SDK inside DOs
(isolate lifecycle, bundle budget, and its exporters are best-effort —
disqualifying for audit). Emission is thin: spans piggyback the
existing metric-sink seams; audit rides the outbox. AE keeps its job
(cheap sampled aggregates); it is never the audit substrate (sampled =
disqualified).

## Cloudflare binding sketch (kept out of the spec deliberately)

- Audit shard = DO (`AUDIT_NET` namespace or a role of the existing
  net topology), `audit:<hash(customer) % N>` via TR2. Buffers to R2:
  `audit/<customer>/<yyyy-mm-dd>/<segment-ulid>.jsonl.gz` + a SQLite
  index in the shard for the hot window; older queries scan R2 by
  prefix. Hash chain in segment headers.
- Customer OTLP/webhook push: shard `defer()`s exports; Logpush stays
  operator-side.
- Ops OTLP: tail-worker or queue consumer reading the span stream from
  the metric sink; operator picks the backend (Grafana/Honeycomb/etc).
- New DO class ⇒ `npm run cf:migrations` tag + `new_sqlite_classes`;
  shard count fixed-and-bounded like gateway shards.

## Phases

**Phase 1 — thread the ids (no pipeline yet, immediate ops win).**
- `Principal` type in `src/net/identity.ts`; gateway stamps it at
  `/net-api` auth (credential → actor → account via catalog identity
  cells; add the account-binding cell if `$account`→actors isn't in the
  catalog closure yet — check first).
- Trace context: mint/adopt traceparent at the gateway; carry
  `{trace_id, span_id}` + principal in the turn envelope, transcript,
  outbox rows, adoption riders, scheduled rows. Commit-side actor-match
  validation in `authorize`.
- Immediately stamp `woo.customer` + `trace_id` onto existing AE
  metrics (`net_turn_structure`, `turn_phase_timing`, `net_rpc`) — ops
  correlation before any new storage exists.
- Tests: envelope round-trip; scheduled-turn attribution; rider
  principal survival; actor-mismatch reject.

**Phase 2 — the audit lane and shards.**
- Scope: mint `AuditRecord` rows in the commit transaction; new outbox
  lane `/audit` (lane independence per CO2.7 — a dead audit sink never
  blocks fanout). Gateway: durable edge-event lane for refusals.
- Audit shard DO: idempotent append, segment build + hash chain, R2
  flush, per-customer index. Dual attribution (resource-owner copy)
  decided by comparing principal.customer to the scope anchor's owning
  account — the anchor owner is resolvable at *mint* time in the scope
  (it owns the anchor cells), so this too is threading, not lookup.
- Retirement interplay: a retiring scope (CO17) drains its audit lane
  in step 2 like every lane; audit segments OUTLIVE the scope — they're
  the durable memory of it.
- Tests: AU10 gates 1, 2, 6 on the fake lane; then workerd.

**Phase 3 — query + export + policy.**
- `/net-api/audit` query surface (time/actor/target/verb/outcome/
  trace_id); partition isolation gate (AU10.5).
- Redaction-at-mint per O8 flags; retention config + segment expiry as
  audited admin action; per-customer push export.
- Fold O5 wizard audit into the operator partition (admin-kind records
  from the existing wizard-audit call sites).

**Phase 4 — spans out.**
- Span emission at `Host.rpc`, gateway phases, scope commit, VM run;
  sampled per O2; OTLP exporter (queue/tail); traceparent adoption on
  MCP surface (M-spec touch); AU10.3 join gate; dashboards.

Ordering: Phase 1 is prerequisite to everything and is worth shipping
alone. Phase 2 before 3/4. Phase 4 can proceed in parallel with 3.

## Open decisions (flagged, with defaults chosen in the spec)

- **Dual attribution (AU5)**: spec'd ON (resource-owner gets a copy).
  If cross-customer rooms should be single-attributed for v1, delete
  the copy path — nothing else depends on it.
- **Routing key = account, team as attribute**: teams change
  membership; records are immutable. Team-level views group at query
  time. Revisit only if a hard team-tenancy model lands in teams.md.
- **Guest actors**: guests have no account. Default: partition
  `guest:<world>` owned by the operator — a guest's trail is the
  operator's business until the actor binds to an account (A-spec
  upgrade path re-homes *future* records only; history doesn't move).
- **Retention default**: 400 days audit / 7 days traces, per-customer
  override. Pick real numbers when pricing is modeled.
