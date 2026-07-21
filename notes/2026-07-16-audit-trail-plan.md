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

## Review fixes (2026-07-17, second review round)

Five findings, all confirmed real, all fixed with tests:

1. **Lifecycle coverage (P1)**: derivation moved to `src/core/attribution.ts`
   (core owns the identity lifecycle; net re-exports). Writers now cover
   the whole lifecycle: `bindHumanToAccount` (signup AND guest→account
   promotion rebind), `provisionActorInternal` (humans + agents), the
   identity import, the guest mint, and a whole-world
   `materializeCustomerAttributions` pass in `planNetInstall` (preseeded
   pool guests, catalog-seeded actors). This surfaced a real gap the
   original rules missed: acting APPLIANCES (the_weather/the_horoscope)
   → new AU3.1 rule 5, a generalized one-hop owner walk ordered after
   the guest rule. Stock-world install now reports zero unattributed.
2. **Forgeability (P1)**: `customer_of` is a reserved property —
   `assertOrdinaryPropertyName` refuses setProp/defineProperty/verb
   writes with E_PERM; the privileged shape-validated
   `world.setCustomerOf` is the only writer. AttributionSource exposes
   semantic predicates (isAgent/isGuest) so core/attribution.ts holds no
   class names (layering guard).
3. **Principal strictness (P2)**: normalizePrincipal enforces per-variant
   field rules (credentialed requires credential; anonymous may claim
   nothing); the sequencer rejects non-authenticated principals on
   commits (`not_authenticated`) and refuses an edge-claimed customer
   when it owns the actor but holds no cell (`customer_unverifiable`).
4. **Seed epoch binding (P2)**: /net/seed refuses an attribution stamped
   at a different epoch (E_EPOCH_MISMATCH, M9 posture).
5. **Traceparent suffix (P2)**: future-version parse requires a `-`
   delimiter at char 55; glued suffixes mint instead of adopt.

Validation: all touched suites green solo; `npm test` full-gate runs
during this round showed 1-5 UNSTABLE timeout failures from cross-
session machine contention (load avg 4-10, failing set differed every
run, every member passed solo including 142/142 at load 10). First
quiet-machine run of the day was 987/987. smoke:net-dev 25/25 with the
installer now sending real attribution stamps. Re-run `npm test` on a
quiet machine before merge.

## Phase 2/3 status (2026-07-17 late, same worktree)

IMPLEMENTED and green (npm test 1026/1026 across 93 files — clean run;
test:worker 488/488; smoke:net-dev 25/25 with NET_AUDIT_SHARDS=1 live
on real workerd):

- src/net/audit.ts: AuditRecord + minting (acting/dual/adoption/
  gateway-edge) + FNV shard routing + wire guard (15 tests).
- Scope commits mint records INSIDE the mutation transaction and
  enqueue on the new durable /audit outbox lane; drains independent of
  fanout (fault-proven). Adoption wire now carries principal/trace/
  cause (Phase 1 put them on the row; the dispatch dropped them) and
  the owner mints the resource-owner-only record.
- NetAuditDO (cf-do-0005, AUDIT_NET in all five wrangler configs):
  idempotent append on (partition, idempotency), filter-columned
  records, hash-chained immutable segments sealed at
  NET_AUDIT_SEGMENT_ROWS, bounded query, /net/audit-verify chain walk.
  Segments live in shard SQLite; R2 offload is the deployed-profile
  follow-up (AU6.3 note).
- Gateway edge records (durable lane, drain-on-defer+next-request;
  liveness caveat documented) with the specific verdict as outcome;
  /net-api/audit with IDENTITY-level partition isolation (caller's
  customer_of; operator may name any partition).
- AU10 gates in curated npm test: completeness+dual (net-audit e2e),
  idempotency (replay + redelivery), verification (seal+verify+query),
  isolation (two-customer client-api test), loss posture (fault test).

Deliberate limits, named:
- NET_AUDIT_SHARDS unset in production wrangler.toml — enabling the
  lane in prod is an owner decision (bindings + migration are deployed
  either way; cf-do-0005 must ride the next deploy).
- Gateway edge lane has no alarm: a quiet gateway holds tail rows until
  its next request.
- AU10.3 (trace join gate) lands with Phase 4 span emission; segment
  retention/expiry (AU9) and push export (AU7) not started.

## Phase 4 status (2026-07-20)

IMPLEMENTED (npm test 1032/1032 across 94 files; worker 489/489;
smoke:net-dev 25/25):

- src/net/spans.ts: OTel span shape (hex ids, links), deterministic
  sampling (adopted contexts follow the caller's W3C sampled flag;
  minted contexts gated 1-in-N by NET_SPAN_SAMPLE, hashed by trace id
  so gateway and scope agree), turn span tree from the structure
  report's measured buckets, OTLP/HTTP JSON payload builder.
- src/worker/net/span-export.ts: woo.span structured-log channel
  always; OTLP push via Host.defer when WOO_OTLP_ENDPOINT is set.
- Emission: gateway net.turn root + queue/rpc phase children
  (emitTurnStructure site); scope net.commit span (submit site). Both
  parent to the CARRIED context's span id — a flat tree under the
  caller's trace.
- AU10.3 join gate (curated, net-client-api): one adopted traceparent →
  net.turn span, net.commit span, and the audit record share the trace
  id; the gateway root parents under the caller's span.

Deliberate exclusions, named:
- Per-Host.rpc child spans: need per-call context threading through the
  TR1 seam (an ambient field races under NET_TURN_SCOPE_CONCURRENCY=12).
  Design with the TR7.2 native-RPC work, which touches the same seam.
- net_rpc AE trace stamping rides the same future seam change.
- Span timing inside the turn is reconstructed from measured phase
  buckets (queue/rpc laid sequentially inside the wall) — honest about
  totals, approximate about overlap.

## Phase 4 review fixes (2026-07-21)

Six findings, all real, all fixed (npm test 1053/1053 across 96 files —
now INCLUDING net-client-api + span-export in the curated list; worker
496/496; smoke:net-dev 25/25):

1. Root spans now cover queue + wall (the wall clock starts after the
   queue wait); children clamped inside the root; containment asserted
   in unit + join-gate tests.
2. Sampling is decided ONCE at mint and encoded in the W3C flags
   (mintTraceContext(sampled), gateway mintSampleDecision); spanSampled
   is flag-only for every producer, and the scope no longer needs the
   rate env. Minted traces root at the CARRIED span id, and the scope
   span always parents to it — one connected tree for no-header traffic.
3. Only fresh acceptance emits net.commit (with woo.seq); replays emit
   net.scope.submit with woo.replayed and no seq; rejections emit
   net.scope.submit with woo.reason and error status. Tested.
4. Spec AU8 status corrected to PARTIAL with the missing normative
   seams enumerated (plan/repair subspans, VM-run span, per-rpc spans,
   async link emission).
5. The AU10.3 join gate is now actually curated; fixed sleeps replaced
   by a bounded poll (whose warm pulls also kick scope drains); exact
   record assertions (idempotency = scope:seq, principal, verb) and
   exact span topology (both spans under the caller's span; commit
   woo.seq matches the record; containment).
6. OTLP push bounded: 5s abort deadline, 8 in-flight per isolate,
   counted drops beyond (net_span_export_dropped); six direct exporter
   tests (success/failure isolation/timeout/saturation).

## Rebase onto post-NC9 main (2026-07-21)

The branch was rebased onto main AFTER the classic/v2 stack deletion
(NC9 code removal: net-only entry, three v2 DO classes unbound and
reclaimed by main's cf-do-0005 deleted_classes migration). Resolution
decisions, recorded:

- **cf-do tag renumber**: main claimed cf-do-0005 for the deleted_classes
  migration, so NetAuditDO's create migration is **cf-do-0007** (0006 is
  the historical CommitScopeDO create). All four wrangler configs agree;
  cf:migrations:check green. cf-do-0005 was never deployed with the
  NetAuditDO meaning anywhere, so the renumber is safe.
- **Deleted files accepted**: src/worker/index.ts and wrangler.cf-e2e.toml
  are gone with the classic stack; the NetAuditDO export lives in
  net-only-index.ts (the deployed entry).
- **MCP trace carrier re-threaded**: main refactored woo_call into
  mcpInvokeTurn (context-tool gating, no Request in scope); the AU2
  traceparent adoption now threads via mcpTraceOf(request) at the
  mcpToolsCall dispatch sites, sampling decided at mint as before.
- **Docs**: main had landed the ORIGINAL planning drafts of audit.md and
  this note (1ada5f0); our evolved versions supersede them. Main's
  net-cutover.md NC9 (with execution records) supersedes our draft NC9.
- Review nits from the final pass are included (crypto-random sampling
  comment; rate-limit test pins Date.now so bucket exhaustion is exact
  under CPU contention).

Post-integration gates after merging `drain-occupancy` and resolving the
shared outbox path: npm test 688/688 (71 files, includes the audit e2e +
AU10.3 join gates), test:worker 240/240, test:full 1545/1545 (123 files),
smoke:net-dev 25/25, typecheck clean, build:net-only clean, and
cf:migrations:check clean. The merge also pins two final-review failures:
durable audit-adoption row ids survive outbox hydration/write-back, and a
drain that yields for an active submit defers its due-now wake until the
last submit completes (no alarm/yield/re-arm loop).
