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
the actor" = the account (auth.md A2), but auth resolves credential →
**actor only** (`client-auth.ts` returns `{actor}`), and the ownership
graph ($human.account, $agent.owner→$human|$wiz, $account.actors) is
world objects spread across scopes — unwalkable at runtime. So AU3.1
materializes attribution at **binding time**: a `customer_of:<actor>`
cell authoritative at the actor's cluster scope (same home and same
gateway pull machinery as session cells), written only by the identity
pipeline (signup, agent provisioning, cutover identity import — which
already carries the whole account graph, `src/net/identity.ts` — and
audited transfers). The `Principal` envelope (now discriminated:
`authenticated | credentialed | anonymous`; customer/actor mandatory
only when authenticated) is stamped at the gateway, validated at
commit (actor-match; customer re-check when the committing scope owns
the cell), and carried through riders, outbox rows, and scheduled rows
(additive field on `ScheduledTurn` — attribution only, CO16's deferred
authority field untouched). Recognized-but-rejected credentials
attribute via the retained (even revoked) `api_keys` record; unknown
credentials are `anonymous` → operator partition.

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

**Phase 0 — the attribution pipeline (prerequisite; AU3.1/AU3.3).**
- `customer_of:<actor>` cell kind + derivation function (the closed
  AU3.1 rules) in `src/net/`; seeding from the identity import
  (`src/net/identity.ts` walk already has account→actors in hand);
  write hooks in the provisioning flows (signup/actor-bind, agent
  provision with owner capture, guest→account upgrade) and an audited
  transfer path.
- `scope_attribution` meta stamped at scope seed/install
  (`partitionCells` knows the anchor; derive its owner's `customer_of`
  during install, when the whole graph is present); cluster scopes
  attribute as their actor.
- Backfill for the live world: one idempotent maintenance pass over
  known accounts (bounded by the account set, not an object scan).
- Tests: derivation rules table-driven; import seeds cells; unstamped
  scope → `operator` + flag.

**Phase 1 — thread the ids (immediate ops win).**
- `Principal` (AU3.2 discriminated shape) + `TraceContext`
  (`{traceparent, tracestate?, origin}` — W3C strings verbatim, AU2) in
  `src/net/`; gateway stamps both at `/net-api` auth; `customer_of`
  pull-on-miss + session-cached.
- Carriers per AU2's closed list: REST/MCP `traceparent` header, WS
  turn-frame `trace` field, turn envelope, transcript, outbox rows (all
  lanes), rider envelopes, `ScheduledTurn` additive fields. Invalid
  header → mint, never reject. Commit-side actor-match (+ owned-cell
  customer re-check) in `authorize`.
- Stamp onto existing **net** AE metrics — `net_turn_structure`,
  `net_scope_submit`, `net_rpc` (NOT `turn_phase_timing`; that is
  v2-only and retires with NC9). AE schema: `BLOB_SLOTS` is 18 of an
  AE max of 20 — additive `blob19 = woo.customer`,
  `blob20 = trace_id` per the R10.1 new-axes-get-new-slots rule. That
  spends the last two blob slots deliberately; the `/admin/stats`
  query layer gains the two columns in the same change. AE stays
  sampled — these stamps are ops correlation, not the trail.
- Tests: envelope round-trip; scheduled-turn attribution; rider
  principal survival; actor-mismatch reject; traceparent adopt/mint
  matrix (valid/invalid/absent).

**Phase 2 — the audit lane and shards.**
- Scope: mint `AuditRecord` rows in the commit transaction; new outbox
  lane `/audit` (lane independence per CO2.7 — a dead audit sink never
  blocks fanout). Gateway: durable edge-event lane for refusals.
- Audit shard DO: idempotent append, segment build + hash chain, R2
  flush, per-customer index. Dual attribution (resource-owner copy)
  decided by comparing principal.customer to the scope's **stamped
  `scope_attribution`** (Phase 0 — anchor lineage carries an owner
  objref, not an account, so this must be pre-stamped, not derived).
  Foreign-owner effects: the owner's adoption commit mints the
  resource-owner-only record with `cause: {scope, seq}` (AU1) — and
  never an acting record (single-count gate, AU10.1).
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

Ordering: Phase 0 → 1 strictly (stamping needs the cells to exist);
Phases 0+1 together are worth shipping alone. Phase 2 before 3/4.
Phase 4 can proceed in parallel with 3.

## Open decisions (flagged, with defaults chosen in the spec)

- **Dual attribution (AU5)**: spec'd ON (resource-owner gets a copy).
  If cross-customer rooms should be single-attributed for v1, delete
  the copy path — nothing else depends on it.
- **Routing key = account, team as attribute**: teams change
  membership; records are immutable. Team-level views group at query
  time. Revisit only if a hard team-tenancy model lands in teams.md.
- **Guest actors**: resolved in AU3.1 rule 4 — distinguished `guest`
  attribution routed to the operator partition; account binding
  re-writes the `customer_of` cell and re-homes *future* records only.
- **Retention default**: 400 days audit / 7 days traces, per-customer
  override. Pick real numbers when pricing is modeled.

## Status (2026-07-17, worktree audit-attribution)

Phases 0 and 1 are IMPLEMENTED and green (curated `npm test` 987 tests,
`test:worker` 483, `smoke:cf-dev` 13/13, `smoke:net-dev` 25/25 —
including the real-alarm scheduled-turn step that exercises the
principal/trace carry).

Landed: src/net/attribution.ts (derivation + Principal + scope
attribution + guards), src/net/trace.ts (W3C context), import/guest/
install seeding, ScopeMeta.attribution with centralized metaRow(),
transcript principal/trace folded in the hashed body by the planner,
gateway stamping (REST/MCP header + WS frame trace carriers,
net_turn_unattributed on a missing cell), sequencer step-1b principal
validation (malformed_principal / actor_mismatch / customer_mismatch as
CO14 unauthorized verdicts), ScheduledTurn + /adopt-row carriers with
`cause`, AE blob19/blob20 + /admin/stats columns.

Deviations from the plan as written:
- `net_rpc` AE stamping deferred to Phase 4: the transport seam stays
  principal-agnostic (TR1), and trace propagation on internal RPC
  belongs with span emission, not before it.
- `/net/schedule` CALLERS do not yet capture principal/trace at
  schedule time — the row type and the dispatch-side carry are in
  place; capture lands with the first real scheduling surface (today's
  callers are lanes/tooling).
- Guest-pool claim actors (pre-seeded pool, as opposed to elastic
  mints) get customer_of from the INSTALL derivation, not a mint-time
  write — covered, but by a different writer than elastic guests.

Next: Phase 2 (audit lane + shard + records) per the phase list above.
