# Warm Turn Bounded Commit Work Items

Date: 2026-06-09
Branch: `warm-turn-bounded-commit`

## Goal

Make a normal warm movement/tool turn execute with:

- no authority repair;
- no warm-turn authority-slice reconstruction;
- no `SerializedWorld` materialization for turn planning;
- one bounded commit path;
- bounded fanout/apply using accepted frames and projection rows.

The immediate production symptom is deployed smoke timeout saturation. The
structural issue is visible in CF-local metrics but not enforced by the current
CF-local pass/fail gate.

## Evidence

Reference measurements:

- `notes/2026-06-08-cf-local-smoke-metrics.md`
- `notes/2026-06-08-cf-local-authority-fast.md`
- `notes/2026-06-08-deployed-smoke-metrics.md`

Latest deployed run after sparse self-host route repair:

- Worker `POST /mcp`: p95 17,834 ms, max 20,002 ms.
- PersistentObjectDO `POST /mcp`: p95 18,044 ms, max 20,389 ms.
- Turn wall share: submit 46%, ensure 31%, authority 23%.
- `worker.commit_scope_envelope_rpc`: 127,984 ms summed, p95 7,459 ms.
- `planning.seed_authority`: 40,823 ms summed, p95 2,942 ms.
- `/__internal/authority-slice -> world`: 52 calls, 70,149 ms summed.
- Cross-host round trips: 222.

CF-local already exposed the same shape at smaller wall times:

- warm `POST /mcp`: p95 1,559 ms, max 2,402 ms;
- movement/tool turns had sparse repair rounds before the authority-fast branch;
- authority-slice fetches and `commit_scope_envelope_rpc` dominated local
  warm-turn cost.

The `cf-local-authority-fast` work proved CF-local can detect structural wins:
`turn_repair_attempt` 14 -> 0, max attempts 3 -> 1, authority calls 46 -> 32,
and authority-slice RPCs 58 -> 38. This work should promote those structural
signals into gates rather than relying on local elapsed time.

## Target Invariants

For deterministic warm movement/tool turns such as `the_chatroom:southeast`,
`the_deck:west`, and mounted tool leave/return:

- `turn_phase_timing.attempts == 1`
- `turn_phase_timing.authority_calls <= 1`
- `turn_repair_attempt == 0`
- `shadow_commit_rejected == 0`
- no `direct_call` error followed by repair
- no `authority_slice_reconstructed` with reason `warm_turn_refresh`
- no `authority_slice_reconstructed` with reason `missing_state_repair`
- no `serialized_world_materialized` with reason `mcp_turn_plan`
- no hot-path `/__internal/authority-slice` RPC in the measured warm phase
- exactly one bounded `/v2/envelope` commit path per accepted turn
- fanout/apply carries accepted frame plus touched projection rows, not
  receiver rediscovery

The warm phase must be demarcated in the harness. Cold opens, initial seed
fills, and dynamic/unknown movement can legitimately use slower paths outside
this gate.

## Work Items

### 1. Promote CF-local Metrics to Structural Gates

Add a CF-local metric gate that runs after a deliberate warm-up phase and fails
on warm deterministic turns that violate the target invariants.

Required changes:

- Add stable phase/run labels to the CF-local walkthrough so metrics can be
  separated into setup, warm-up, and measured warm-turn sections.
- Add a summary script or test helper that consumes `woo.metric` output and
  asserts the target invariants per verb.
- Start with movement/tool-leave turns already covered by
  `cf-local-authority-fast`: `the_chatroom:southeast`, `the_deck:west`,
  mounted tool leave/return, and the task-board path once its deterministic
  closure is explicit.
- Keep cold take/drop and dynamic movement outside the zero-repair gate until
  their authority contracts are specified.

Acceptance:

- `npm run smoke:cf-local` or a closely scoped companion lane fails when a
  deterministic warm movement/tool turn repairs.
- The gate reports the offending metric kind, target verb, attempt count, and
  repair reason.

### 2. Define the Warm Turn State Contract

Write down the exact local state needed for a warm sparse gateway to plan and
execute a deterministic movement/tool turn without repair.

The contract must cover:

- actor/session identity, location, and active scope;
- current scope and destination scope lifecycle/lineage;
- current and destination contents/projection rows needed by movement;
- inherited verb descriptors, definer rows, and class lineage for selected
  tools;
- exit/mount metadata used to compute deterministic destination roots;
- read-version inputs needed by commit validation;
- subscriber/session rows needed for fanout routing.

Acceptance:

- The contract is catalog-agnostic in substrate code.
- Catalog-specific movement/tool rules live in catalog metadata such as
  `arg_spec.authority.prefetch`, not hardcoded gateway branches.
- Dynamic movement remains protected by the VM movement-boundary check and can
  still repair.

### 3. Replace Warm Authority-Slice Reconstruction

Remove `warm_turn_refresh` authority-slice reconstruction from normal warm
turn planning.

Required direction:

- Use checkpoint/tail and projection-row caches for catch-up.
- Treat content-addressed cached pages as cache fills, not per-turn authority
  reconstruction.
- Make the gateway decide from local row completeness whether the warm contract
  is satisfied.
- If the warm contract is incomplete, emit a precise metric and use a bounded
  cold/repair path outside the warm gate.

Acceptance:

- Measured warm turns have zero `authority_slice_reconstructed` rows with
  reason `warm_turn_refresh`.
- Measured warm turns have zero `/__internal/authority-slice` RPCs.
- Missing warm contract fields are reported as specific atoms/rows, not opaque
  `E_NEED_STATE` loops.

### 4. Eliminate Planning-Time SerializedWorld Materialization

The sparse planner should not build a compatibility `SerializedWorld` for a
normal warm movement/tool turn.

Required direction:

- Identify remaining `serialized_world_materialized` reason `mcp_turn_plan`
  call sites.
- Replace planning reads with row/page accessors that operate on the warm
  contract.
- Keep materialization only for explicit legacy/export/checkpoint boundaries.

Acceptance:

- Measured warm turns produce no `serialized_world_materialized` metric with
  reason `mcp_turn_plan`.
- Targeted tests cover inherited movement/tool verbs without materialization.

### 5. Bound the Commit Path

A successful warm turn should submit one accepted frame through one bounded
commit path.

Required direction:

- Reduce `commit.initializer_wait` and repeated open/seed work for commit
  scopes that are already warm.
- Ensure commit-scope open/session state is reused across the measured warm
  phase.
- Make commit validation read the expected small read/write set rather than
  broad authority state.
- Convert avoidable `read_version_mismatch` retries into deterministic local
  cache updates before submission, or into explicit stale-cache invalidation
  outside the warm gate.

Acceptance:

- Measured warm turns submit once.
- `shadow_commit_rejected` is zero for deterministic movement/tool turns.
- `worker.commit_scope_envelope_rpc` is bounded by a documented local budget.
- The gate reports commit-envelope count and wall time per measured turn.

### 6. Bound Fanout and Apply

Fanout should send accepted frame data and projection deltas, not force receivers
to rediscover broad state.

Required direction:

- Use `ProjectionDeltaSummary` plus touched projection rows for receiver apply.
- Avoid reconstructing authority slices or materializing receiver worlds during
  gateway fanout.
- Ensure observation routing uses bounded session/projection indexes.

Acceptance:

- Receiver apply metrics show touched rows, not broad object scans.
- No gateway projection compatibility apply is used for normal accepted fanout.
- Fanout RPC count is bounded by affected shards, not by global enumeration.

### 7. Keep Layering Clean

This work crosses catalog metadata, MCP gateway planning, commit scopes, and
Worker persistence. The substrate must remain catalog-agnostic.

Rules:

- No room names, object ids, class names, or command words hardcoded in
  `src/core`, `src/mcp`, or `src/worker` hot paths.
- Catalog-specific movement/tool authority hints belong in catalog manifests
  and specs.
- Gateway code may interpret generic roots, paths, and fallback lists only.
- Add or extend guards when a layering failure is found.

Acceptance:

- Existing layering guards pass.
- New metadata is documented where catalog authors will find it.

### 8. Validation Sequence

Use increasing blast-radius gates:

1. Unit tests for row completeness and warm contract evaluation.
2. Targeted MCP/gateway tests for inherited movement and mounted tool returns.
3. CF-local structural metric gate with warm measured turns.
4. `npm test`.
5. `npm run test:worker`.
6. Deployed smoke with tail capture after the structural gates are green.

The deployed smoke remains mandatory for Cloudflare wall-clock behavior. CF-local
is the primary development environment for proving shape, not the final latency
oracle.

## Open Questions

- Which exact metric output should become the stable contract for CI:
  existing `WOO_CF_LOCAL_METRICS_OUT`, the smoke tail analyzer, or a new focused
  structural summary?
- Should the warm measured phase reuse the existing smoke walkthrough or become
  a smaller deterministic lane that runs before the full smoke?
- What is the first acceptable local wall budget for the bounded commit path?
  The structural gate matters more than the initial number, but CI needs a
  threshold that is not flaky.
- Which dynamic movement cases must remain outside the zero-repair invariant?

## Progress

2026-06-09:

- Added a CF-local structural probe with explicit setup, warm-up, and measured
  warm phases. The measured phase gates deterministic movement/tool turns on
  one attempt, no repair attempts, no shadow commit rejection, no
  `warm_turn_refresh` or `missing_state_repair` authority-slice reconstruction,
  and exactly one accepted `/v2/envelope` per measured turn.
- Added a synthetic violation fixture so the gate reports the offending metric
  kind, target verb, attempt count, repair reason, reconstruction reason, and
  envelope count.
- Enabled `WOO_V2_SLIM_WARM_ENVELOPE` in the CF-local structural and smoke
  harnesses so local validation matches the deployed slim warm-envelope shape.
- Avoided measured warm `warm_turn_refresh` reconstruction on slim MCP commit
  submits by reusing already-admitted relay rows for local executor commit
  authority payloads. Planned-transcript commits use the planning relay rows
  after the selected commit scope session is open, which preserves the read
  support used by planning without rebuilding owner authority.

Remaining plan items still need separate work: the explicit warm state contract,
removal of planning-time `SerializedWorld` materialization, tighter bounded
commit budgets, and bounded receiver fanout/apply.

## First Milestone

Create the CF-local structural gate before changing the runtime. A good first
commit should:

- add warm-phase metric labels;
- assert `turn_repair_attempt == 0` and `attempts == 1` for deterministic warm
  movement/tool turns;
- assert no `warm_turn_refresh` or `missing_state_repair` authority-slice
  reconstruction in the measured warm phase;
- fail against a synthetic or fixture metric set that violates those rules.

That gives this branch a reliable local red/green loop for the later runtime
changes.
