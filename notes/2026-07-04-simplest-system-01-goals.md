# Simplest Deployable System — Stage 1: The Goals, as Stated

Date: 2026-07-04. Series: see `2026-07-04-simplest-system-00-method.md`.
Evidence pass: every explicitly stated scalability/performance target, cited.
Key meta-finding first, then the numbers.

## 1.1 Meta-finding: the goals are mostly not in the spec

Almost every *latency and scale* number lives in planning notes as a deploy
gate; the spec proper carries only byte ceilings, asymptotic bounds, and VM
safety caps. There is **no ratified spec-level performance SLO** and **no
numeric scale target** beyond the qualitative "millions of nodes"
(`AGENTS.md:47-50`). The final plan must therefore *ratify* a goal set as its
first act — otherwise "meets the goals" is unfalsifiable.

## 1.2 Latency targets (plan-normative unless noted)

- **Turn p50 < 2 s, p95 < 4 s deployed** — the functional/usable milestone
  (`notes/2026-06-09-cf-cross-scope-architecture-plan.md:99,325-326`).
- Aspirational floors: same-scope < 500 ms, cross-scope < 1 s (`:327`).
- **Peer-visible fanout < 1 s** (`:234,:331`; d1-tail-delivery note:71).
- **Spec-normative MUST (no number):** actor reply time and peer latency
  independent of audience size (`spec/protocol/v2-turn-network.md:1018`).
- Browser: room/tab switch < 1 s perceived; cold app open < 3 s (plan gate
  only, `cf-cross-scope-plan:300`).
- Repair budget 12,000 ms (`spec/protocol/cell-authority.md:1027`).
- VM wall caps (safety, not perf): 10 s foreground / 60 s forked
  (`spec/semantics/vm.md:266-269`).

## 1.3 Scale targets

- **"Millions of nodes … global enumeration must be avoided"** — qualitative,
  the only top-level scale claim (`AGENTS.md:47-50`).
- One CommitScopeDO serializes a room: "fine for tens of concurrent users per
  room" (characterization of the ceiling, not a commitment).
- Per-DO ~1k req/s soft cap (`spec/reference/cloudflare.md:1217`).
- **Spec-normative asymptotic bounds (CA13):** movement/fanout/read must be
  O(churn), O(distinct occupant shards), O(result_size) — never O(world),
  O(objects_in_scope), O(occupants²), O(active_sessions)
  (`spec/protocol/cell-authority.md:998-1003,820-869`).
- Caps: contents repair expansion 128 objects; focus 32 entries; sessions per
  scope ≤ live actors + 1 (gate).

## 1.4 Byte and cost budgets

- **Spec-normative:** cross-scope envelope < 256 KB
  (`cell-authority.md:1011`, `v2-turn-network.md:826,878`).
- Plan gates: warm same-scope envelope < 64 KB; state-transfer budget 512 KiB
  default / 1 MiB max; tail retention 8 MB/table, ≤1000 entries.
- Per-turn CommitScopeDO writes ≤ 8 rows (only in
  `tests/worker/v2-cost-budget.test.ts`); cross-host RPC ≤ 3/turn warm (only
  in notes; production-tracked only as a 2× regression floor).
- Rate limits: 50 ops/s sustained, burst 100 per WS (`spec/protocol/wire.md:180`).
- Remote-op tick weights: remote GET_PROP 100, remote CALL_VERB 500.

## 1.5 The existing "usable" acceptance criteria (structural gates)

From `cf-cross-scope-architecture-plan.md:84-99` — "gates, not aspirations":
smoke 10/10; warm turn = 1 attempt, ≤1 authority call, exactly 1 envelope,
zero authority reconstructions; envelope byte ceilings; `dangling_parent_ref
== 0`; no synchronous cross-DO RPC with unbounded timeout inside a turn;
sessions per scope ≤ live actors + 1. Postflight = walkthrough + tail-metric
thresholds (thresholds never enumerated — a gap).

## 1.6 Where goals are absent (the plan must set or explicitly decline these)

- No numeric node/object/player/scope scale SLO.
- No p99 target anywhere.
- No concurrent-players-per-world or per-room commitment.
- No cold-start latency target in spec (only measurements: ~5 s live RPC
  penalty vs ~10-50 ms KV checkpoint).
- No default quota values (`spec/reference/quotas.md` is mechanism only).
- No normative per-turn CPU-ms budget.
- No fanout latency bound in spec (only the independence MUST).
- RPC/row-write budgets live in tests/notes, not spec.

## 1.7 Proposed ratified goal set (input to the plan)

To be adopted (or amended) by the final plan as the **system SLO**, promoted
into `spec/` so the spec is the source of truth for its own success criteria:

| Goal | Value | Source status |
|---|---|---|
| Warm same-scope turn | p50 < 500 ms, p95 < 2 s | promote aspirational floor |
| Cross-scope (movement) turn | p50 < 1 s, p95 < 4 s | promote |
| Peer-visible delivery | < 1 s, independent of audience size | promote + keep MUST |
| Cold session open (deployed) | < 3 s | new (currently browser-lane only) |
| Envelope ceilings | warm < 64 KB, cross-scope < 256 KB | already spec/gate |
| Warm turn structure | 1 attempt, 1 envelope, ≤3 cross-host RPC, ≤8 scope-row writes, 0 reconstructions | promote from tests/notes |
| Asymptotic bounds | CA13 as written | already spec |
| Room concurrency | explicitly commit to "tens per room" per sequencer; CA13 sharding is the growth path | make the ceiling a stated decision |
| Convergence | zero unnamed divergence: every divergence event carries an E2 taxonomy code; dangling_parent_ref == 0 | promote |

These are deliberately the *existing* consensus numbers — the plan should not
invent harder targets; it should make the implicit ones falsifiable.
