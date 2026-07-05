# Simplest Deployable System — Stage 2: Essence vs Accident in the v2 Turn Network

Date: 2026-07-04. Series: see `2026-07-04-simplest-system-00-method.md`.
Evidence pass over `spec/protocol/v2-turn-network.md` (VTN),
`spec/protocol/cell-authority.md` (CA), `spec/protocol/host-seeds.md`, and the
implementation.

> **Corrigendum (rev 2, post-adversarial-review):** (a) the projection-cache
> spec *does* exist — at `spec/semantics/projection-cache.md`, not under
> `spec/protocol/`; its PC1 tool-surface projection is a real materialization
> the plan must carry. (b) The essence list below is missing one item:
> **durable continuations** — parked SUSPEND/FORK tasks and scheduled-turn
> alarms anchored at the scope sequencer (VTN `:2677-2838`) are substrate
> semantics any replacement must implement (the current worker never finished
> the alarms: `persistent-object-do.ts:22`). (c) §2.6's "prod carries
> demo-grade state" is wrong for identity: accounts/apikeys/plug credentials
> live in world state under `$system` (`world.ts:2515-2605`) and require an
> explicit carry-over at cutover. All three are fixed in the final plan.

## 2.1 The essence: one invariant plus six derived guarantees (~one page)

Any replacement must preserve exactly this list — nothing else in the 24k-LOC
layer is semantics:

1. **The Coherence Invariant (CI)** (`v2-turn-network.md:68-84`, VTN0): for
   every durable cell there is exactly one authority (the committing
   commit-scope head). Every other materialization is a derived projection —
   content-addressed, carrying explicit `source` provenance, a pure
   read-through at a known `source_head` — and is **never** used as a
   write-authority source. The spec attributes *every* recurring v2 defect to
   a CI violation. Machine-checkable (`:99-103`).
2. **Turn atomicity** (`:53-56`): the turn, not the object, is the atomic
   unit. A state miss is a pre-execution failure — abort, acquire, retry the
   whole turn; never half-local/half-remote.
3. **Per-scope serialization, scope chosen by write-set** (VTN8, `:577-579`,
   `:761`). The *concept* is essential; the fixed-assignment realization is
   the acknowledged "partial realization" special case (`:86-97`).
4. **Read-version validation** (`:668`; scope-epoch `ValidationRule`, not a
   caller hint, `:698-702`) — the concurrency-correctness core.
5. **Idempotent replies + redelivery no-ops** (reply/seen tables; fanout
   no-op by scope head).
6. **Materialization-miss ≠ semantic absence** (VTN10.1, `:1186-1224`): under
   sparse execution, a miss MUST become `missing_state` + repair, never
   `E_OBJNF`. (The rule whose violation was the dangling-ref storm.)
7. **Crash-safe at-least-once ordered fanout** — the guarantee, not the
   SQL-queue mechanism.

Plus the movement model, already ratified: **CA3/CA4 location-as-truth,
contents-as-projection** (single authoritative movement write is
`live:location:<object>` at the moved object's home; room `contents` is a
per-member reverse-index projection, excluded from commit validation).

Also essential and worth carrying forward as a *schema*: the
**EffectTranscript** (`:453-480`) and the VTN8 validation order (`:660-673`).
Note the corrected understanding: "validate by re-execution" does **not**
re-run verb bytecode — the scope re-applies the transcript's recorded writes
to a clone of validated pre-state and checks `post_state_hash`. Steps 1-9 are
pre-state-only. The genuinely re-executing *intent* path is legacy/browser
edge and already fenced off for movement (`:811-818`).

## 2.2 The accident, class A: Cloudflare-constraint band-aids

These exist because DO eviction/cold-start/RPC-size were retrofitted rather
than designed for. A fresh design treats them as first-class inputs; most of
the *mechanisms* collapse, though the physics stays:

- Read-closure + 256 KB ceiling + CA12.2 line_map stripping (line_map ≈ 59%
  of slice bytes) — DO RPC body size + cold-open read timeouts.
- `E_SNAPSHOT_REQUIRED` + capsule head-staleness recovery — DOs evicted and
  rebuilt under a new epoch mid-flight.
- KV seed authority (~10-50 ms vs ~5 s cold owner RPC).
- CA11.2 quasi-static topology pre-seeding (~2.8 s per cold neighbor RPC).
- Checkpoint pages + accepted-frame tail replay ("this DO reconstructs on
  essentially every turn in production").
- `v2_fanout_pending` + `waitUntil` drain + 1 s fanout RPC timeout.

## 2.3 The accident, class B: self-inflicted-history band-aids

These defend against the codebase's own past and vanish in a design that
enforces the CI by construction:

- **Presentation-stub refusal + `missing_provenance` enforcement** (CA11) —
  guards against worlds seeded *without* per-cell provenance. Record
  provenance at every seed by construction → this scaffolding is unnecessary.
- **Dual authority-slice shapes** (legacy object-rows ↔ cell-slices) + the
  `SerializedWorld` compatibility view **still called on hot paths**
  (`gateway.ts:1690`, `commit-scope-do.ts:703`) — an incomplete CA12
  migration. The largest CA-design-vs-implementation gap.
- **`WOO_V2_SLIM_WARM_ENVELOPE`** — band-aid over authority having been
  double-carried (capsule copy since removed as dead weight).
- **`MCP_GATEWAY_ACTOR_SUPPORT_ROOTS`** — replaced a hand-maintained id list
  that "was wrong twice."
- **`commit_scope_multi` metric-only deferral** — multi-scope commits
  unenforced because CA10 route-homes were never built, not because CF
  prevents it.
- The 12 `WOO_V2_*` flags holding two designs in superposition.

## 2.4 Copies-per-turn (the divergence surface)

~8 distinct materializations of a cell exist: scope rows, checkpoint pages,
accepted-frame/tail, gateway in-memory relay cache, gateway durable
projection cache, Directory route rows, browser projection, KV seed. A warm
same-scope turn touches ~6; a cross-scope movement turn touches **~9-10
across ≥4 DOs** plus the multi-MB slice on the wire (= the measured 66% of
turn wall). The lineage-less fanout defect is precisely a transfer whose body
carries a projection row without its `object_lineage` page — a violation the
transfer *type* could have made unrepresentable.

## 2.5 Size verdict

V2 path ≈ **23-24k LOC** (gateway 2218, commit-scope-do 2836, directory-do
955, authority-slice 940, shadow-* 9261, effect-transcript 867, executor
~1500 v2-share, ~4000 v2-share of persistent-object-do, misc ~800). The
VM+world semantic core it serves ≈ 17.5k. **The transport/convergence layer
is as large as the language+world it transports** — accident dominance (C2)
confirmed. Essence ≈ one page of invariants + two schemas (EffectTranscript,
validation order) + the CA3/CA4 movement model.

## 2.6 Conclusion feeding the plan

- C1 (invariant clarity): **met** — §2.1 is the complete contract.
- C2 (accident dominance): **met** — §2.2/2.3/2.5.
- C3 (blast containment): **met** — seams exist above (transport shells) and
  below (world engine; `shadow-turn-call` already accepts only a
  `PlanningWorld`); catalogs/conformance untouched (stage 4).
- C4 (migration vs build): the world is installable from catalogs; ~~prod
  carries demo-grade state~~ **[SUPERSEDED by plan rev 2 — false: identity
  state (accounts/apikeys/plug credentials + their actor objects) lives
  under `$system` and the object graph and requires the Phase-5 identity
  export/import; see the corrigendum at the top of this note.]**
  **New-build the distribution layer; keep the
  physics mechanisms (KV seed, durable outbox, head-freshness retry) as
  *designed* components rather than retrofitted flags.**
