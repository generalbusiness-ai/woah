import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { CommitScopeDO } from "../../src/worker/commit-scope-do";
import { DirectoryDO } from "../../src/worker/directory-do";
import { PersistentObjectDO, type Env } from "../../src/worker/persistent-object-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { mergeShadowStatePagesIntoSerialized, shadowObjectLineagePage, shadowObjectLivePage } from "../../src/core/shadow-state-pages";
import type { SerializedObject, SerializedWorld } from "../../src/core/repository";
import type { ObjRef } from "../../src/core/types";
import { FakeDurableObjectNamespace, FakeDurableObjectState } from "./fake-do";

vi.setConfig({ testTimeout: 45_000 });

const PROD_CATALOGS = "chat,demoworld,dubspace,help,note,pinboard,prog,tasks,blocks-demo";
const PROD_SHARDS = 32;
const DIRECTORY_PRESENCE_WINDOW_MS = 5 * 60_000;
const WARM_TURN_FORBIDDEN_AUTHORITY_RECONSTRUCTION_REASONS = new Set(["warm_turn_refresh", "missing_state_repair"]);
const WARM_TURN_MAX_COMMIT_SCOPE_ENVELOPE_RPC_MS = 300;
const WARM_TURN_MAX_MCP_FANOUT_SHARDS = 1;
const WARM_TURN_MAX_MCP_SCOPED_SHARDS = 1;
const WARM_TURN_MAX_MCP_AFFECTED_SCOPES = 3;

// ── C2 gate budgets ────────────────────────────────────────────────────────
// ENFORCED (fails the build if violated on current main with the slim warm
// envelope flag that is already deployed):
//
// Warm same-scope envelope authority bytes must be 0 when WOO_V2_SLIM_WARM_ENVELOPE=1.
// The slim path strips the ~3 MB authority slice from ordinary warm envelopes
// (planned-transcript/cross-scope commits are excluded by slimMcpEnvelopeBody).
// We measure authority_bytes via v2_envelope_bytes (WOO_V2_ENVELOPE_BYTE_BREAKDOWN=1)
// rather than the HTTP request_bytes header (which is always 0 in the fake lane).
// The 64 KB ceiling is defined for the cf-dev and deployed lanes where the full
// request body is measured via content-length; in the fake lane we assert authority==0.
// PLAN: notes/…-plan.md §C2.
const C2_ENFORCED_WARM_SAME_SCOPE_ENVELOPE_BYTES = 64 * 1024; // 64 KB — authority_bytes must be 0

// TRACKED — not enforced yet; each tag names the plan item that flips it.
// The current measured values are printed alongside the threshold so the
// gate both documents the debt and records what "today" looks like. When a
// tracked item lands and the invariant holds, replace the TRACKED check with
// an ENFORCED one and remove the tag.

// Cross-scope envelope bytes must be < 256 KB now that B-i (read-closure
// envelopes for planned-transcript commits) is implemented and gated by
// WOO_V2_READ_CLOSURE_ENVELOPE=1. ENFORCED (was TRACKED → B-i).
const C2_TRACKED_CROSS_SCOPE_ENVELOPE_BYTES = 256 * 1024; // 256 KB — ENFORCED (B-i landed)

// dangling_parent_ref must be 0 in movement-only turns (ENFORCED). Movement
// turns (enter/leave/traverse) never involve $portable objects, so any dangling
// ref in this test indicates a regression. The A2 plan item (lineage-closed row
// installation for $portable take/carry) is separately tracked via the C3
// carry-across-rooms scenario step. This constant is the zero-target for the
// movement-only ENFORCED check.
const C2_TRACKED_DANGLING_PARENT_REF_TARGET = 0; // ENFORCED zero for movement-only turns

// Per-turn cross-host RPC count should be ≤ 3 on warm turns once D2
// (directory/tool-surface consolidation) ships. Today the b7-tail run shows
// ~8 RPCs per turn (directory lookups + enumerate-tools + envelope + fanout).
// TRACKED → D2.
const C2_TRACKED_WARM_TURN_MAX_CROSS_HOST_RPCS = 3; // TRACKED → D2

// Sessions-for-scopes result should be ≤ live actors + 1 once A1 (session
// lifecycle as first-class state) ships. Today closed pooled-guest sessions
// linger in the Directory and inflate the count. TRACKED → A1.
const C2_TRACKED_MAX_SESSIONS_FOR_SCOPES_MARGIN = 1; // ≤ actors + this margin, TRACKED → A1

type WarmTurnExpectation = {
  target: string;
  verb: string;
  expectedCount?: number;
  maxAuthorityCalls?: number;
  maxCommitScopeEnvelopeRpcMs?: number;
};

describe("CF-local prod-shape structural probes", () => {
  it("rejects partial state-page materialization before it becomes a deployed-only lineage failure", () => {
    const deck = serializedObject("the_deck", "The Deck", "$space");

    expect(() =>
      mergeShadowStatePagesIntoSerialized(
        undefined,
        [shadowObjectLivePage(deck)],
        emptySerializedWorld
      )
    ).toThrow(/state page set missing lineage page for the_deck/);

    const merged = mergeShadowStatePagesIntoSerialized(
      undefined,
      [shadowObjectLineagePage(deck), shadowObjectLivePage(deck)],
      emptySerializedWorld
    );
    expect(merged.objects.map((obj) => obj.id)).toEqual(["the_deck"]);
  });

  it("keeps a one-turn prod-shaped MCP enter within structural budgets", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const harness = createStructuralHarness();
    const runId = `cf-local-structural-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let sessionId: string | null = null;
    try {
      const staleSessionIds = await seedDirectoryMcpAudience(harness, runId, {
        scope: "the_chatroom",
        sessions: 29,
        uniqueShards: 17
      });
      harness.setDirectoryLastSeenAt(staleSessionIds, Date.now() - DIRECTORY_PRESENCE_WINDOW_MS - 60_000);
      logSpy.mockClear();

      sessionId = await openMcpSession(harness, `guest:cf-local-structural-${runId}`, runId);
      await callTool(harness, sessionId, 3, "woo_call", { object: "the_chatroom", verb: "enter", args: [] });

      const metrics = metricsFromLogSpy(logSpy);
      const maxDirectorySessions = maxMetric(metrics, "directory_sessions_for_scopes", "sessions");
      const maxAudienceSessionShards = maxMetric(metrics, "mcp_fanout", "audience_session_shards");
      const maxFanoutShards = maxMetric(metrics, "mcp_fanout", "shards");
      const mcpGatewayConstructors = metrics
        .filter((m) => m.kind === "do_constructor" && m.class === "PersistentObjectDO")
        .filter((m) => String(m.host_key ?? "").startsWith("mcp-gateway-"))
        .length;
      const commitFanoutGatewayTargets = new Set(metrics
        .filter((m) => m.kind === "cross_host_rpc" && m.route === "/__internal/mcp-commit-fanout")
        .map((m) => String(m.host ?? "")))
        .size;
      const hostSeedDoFetches = metrics
        .filter((m) => m.kind === "startup_storage" && m.phase === "host_seed_fetch" && m.source === "do")
        .length;
      const authorityReconstructions = metrics
        .filter((m) => m.kind === "authority_slice_reconstructed")
        .length;
      const enterTurns = metrics
        .filter((m) => m.kind === "turn_phase_timing" && m.target === "the_chatroom" && m.verb === "enter");
      writeLabeledMetricsIfRequested(runId, {
        one_turn_enter: metrics
      });

      expect(enterTurns.length, "the structural probe must exercise the real MCP turn path").toBeGreaterThan(0);
      expect(
        enterTurns.map((m) => ({ attempts: Number(m.attempts), authority_calls: Number(m.authority_calls) })),
        "one-turn smoke should converge without repair-round multiplication"
      ).toEqual([{ attempts: 1, authority_calls: 1 }]);
      expect(
        enterTurns.some((m) => m.ensure_detail_ms && typeof m.ensure_detail_ms === "object"),
        "enter turn should expose ensure subphase detail for prod smoke triage"
      ).toBe(true);
      expect(
        enterTurns.some((m) => m.submit_detail_ms && typeof m.submit_detail_ms === "object" && "worker.commit_scope_envelope_rpc" in m.submit_detail_ms),
        "enter turn should split submit into commit-scope RPC and post-accept delivery"
      ).toBe(true);
      expect(maxDirectorySessions, "stale Directory rows must not enter the presence authority payload").toBeLessThanOrEqual(2);
      expect(maxAudienceSessionShards, "stale sessions must not choose one MCP gateway shard each").toBeLessThanOrEqual(2);
      expect(maxFanoutShards, "commit fanout must stay proportional to live audience shards").toBeLessThanOrEqual(2);
      expect(mcpGatewayConstructors, "one live actor plus stale rows must not cold-start prod-scale gateway shards").toBeLessThanOrEqual(3);
      expect(commitFanoutGatewayTargets, "one enter must not fan out to many stale MCP gateway shards").toBeLessThanOrEqual(2);
      expect(hostSeedDoFetches, "one enter should not scatter host-seed cold loads").toBeLessThanOrEqual(3);
      expect(authorityReconstructions, "B7 warm-fill regressions show up as authority reconstruction fan-in").toBeLessThanOrEqual(5);
    } finally {
      if (sessionId) await mcpFetch(harness, { method: "DELETE", headers: { "mcp-session-id": sessionId } }).catch(() => undefined);
      logSpy.mockRestore();
      harness.close();
    }
  });

  it("gates measured warm deterministic movement and mounted-tool turns", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const harness = createStructuralHarness();
    const runId = `cf-local-warm-turn-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let sessionId: string | null = null;
    try {
      sessionId = await openMcpSession(harness, `guest:cf-local-warm-turn-${runId}`, runId);

      await callTool(harness, sessionId, 3, "woo_call", { object: "the_chatroom", verb: "enter", args: [] });
      const setupMetrics = metricsFromLogSpy(logSpy);
      logSpy.mockClear();

      // Deliberate warm-up: exercise the same deterministic routes once before
      // measuring so cold opens, catalog install, and first seed fills remain
      // outside the zero-repair warm-turn gate.
      await callTool(harness, sessionId, 4, "woo_call", { object: "the_chatroom", verb: "southeast", args: [] });
      await callTool(harness, sessionId, 5, "woo_call", { object: "the_deck", verb: "go", args: ["pinboard"] });
      await callTool(harness, sessionId, 6, "woo_call", { object: "the_pinboard", verb: "go", args: ["out"] });
      await callTool(harness, sessionId, 7, "woo_call", { object: "the_deck", verb: "west", args: [] });
      const warmupMetrics = metricsFromLogSpy(logSpy);
      logSpy.mockClear();

      await callTool(harness, sessionId, 8, "woo_call", { object: "the_chatroom", verb: "southeast", args: [] });
      await callTool(harness, sessionId, 9, "woo_call", { object: "the_deck", verb: "go", args: ["pinboard"] });
      await callTool(harness, sessionId, 10, "woo_call", { object: "the_pinboard", verb: "go", args: ["out"] });
      await callTool(harness, sessionId, 11, "woo_call", { object: "the_deck", verb: "west", args: [] });
      const measuredMetrics = metricsFromLogSpy(logSpy);

      writeLabeledMetricsIfRequested(runId, {
        setup: setupMetrics,
        warmup: warmupMetrics,
        measured_warm: measuredMetrics
      });
      assertWarmTurnStructuralGate(measuredMetrics, [
        { target: "the_chatroom", verb: "southeast" },
        { target: "the_deck", verb: "go" },
        { target: "the_pinboard", verb: "go" },
        { target: "the_deck", verb: "west" }
      ]);
    } finally {
      if (sessionId) await mcpFetch(harness, { method: "DELETE", headers: { "mcp-session-id": sessionId } }).catch(() => undefined);
      logSpy.mockRestore();
      harness.close();
    }
  });

  it("reports warm-turn structural gate violations with actionable metric context", () => {
    const violations = warmTurnStructuralViolations([
      {
        kind: "turn_phase_timing",
        target: "the_chatroom",
        verb: "southeast",
        route: "direct",
        attempts: 2,
        authority_calls: 2,
        outcome: "submitted",
        submit_detail_ms: {
          "worker.commit_scope_envelope_rpc": 999
        }
      },
      {
        kind: "serialized_world_materialized",
        scope: "the_chatroom",
        seq: 3,
        reason: "mcp_turn_plan",
        ms: 1,
        objects: 99,
        sessions: 1,
        logs: 0
      },
      {
        kind: "turn_repair_attempt",
        target: "the_chatroom",
        verb: "southeast",
        source: "planning_throw",
        reason: "missing_state",
        attempt: 1,
        objects: ["the_deck"],
        atoms: ["read:cell:contents:the_deck"]
      },
      {
        kind: "authority_slice_reconstructed",
        reason: "warm_turn_refresh",
        scope: "the_chatroom",
        object_count: 12,
        page_count: 34,
        source_host: "the_deck"
      },
      {
        kind: "shadow_commit_rejected",
        scope: "the_chatroom",
        reason: "read_version_mismatch"
      },
      {
        kind: "mcp_fanout",
        scope: "the_chatroom",
        shards: 4,
        observations: 1,
        affected_scopes: 8,
        scoped_shards: 5,
        audience_session_shards: 4
      },
      {
        kind: "shadow_gateway_apply_step",
        scope: "the_chatroom",
        phase: "total",
        route: "fanout",
        ms: 2,
        objects: 80,
        creates: 0,
        writes: 2
      },
      {
        kind: "v2_envelope",
        status: "ok",
        scope: "the_chatroom"
      },
      {
        kind: "v2_envelope",
        status: "ok",
        scope: "the_chatroom"
      }
    ], [{ target: "the_chatroom", verb: "southeast" }]);

    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining("turn_phase_timing the_chatroom:southeast attempts=2 authority_calls=2"),
      expect.stringContaining("commit_scope_envelope_rpc the_chatroom:southeast ms=999 max=300"),
      expect.stringContaining("serialized_world_materialized scope=the_chatroom reason=mcp_turn_plan"),
      expect.stringContaining("turn_repair_attempt the_chatroom:southeast source=planning_throw reason=missing_state attempt=1"),
      expect.stringContaining("authority_slice_reconstructed scope=the_chatroom reason=warm_turn_refresh"),
      expect.stringContaining("shadow_commit_rejected scope=the_chatroom reason=read_version_mismatch"),
      expect.stringContaining("mcp_fanout scope=the_chatroom shards=4 max_shards=1"),
      expect.stringContaining("shadow_gateway_apply_step scope=the_chatroom phase=total"),
      expect.stringContaining("v2_envelope accepted_count=2 expected_turns=1")
    ]));
  });

  // ── C2: cross-scope structural gates ──────────────────────────────────────
  // Measures envelope bytes, dangling refs, cross-host RPC counts, and
  // sessions-for-scopes across a cross-scope movement sequence. Enforced gates
  // fail the build; tracked gates print current measured values and flip to
  // enforced once the named plan item lands.
  //
  // Scenario: single active session (alice) does chatroom → deck → pinboard →
  // deck → chatroom. Bob's session is open but idle so sessions-for-scopes can
  // be bounded (alice turns fanout to bob's shard). The warm-turn structural gate
  // (attempts, auth calls, repair, fanout counts) is run on alice's single-session
  // turns; cross-scope envelope bytes and RPC counts are measured for both
  // same-scope and cross-scope turns.
  //
  // NOTE: the `say` verb in the presence of two sessions produces scoped_shards=2
  // (one shard per live session) which is CORRECT — so the two-actor scenario must
  // use a relaxed maxScoped budget for say turns. We separate the enforced gate on
  // movement turns (single-session fanout) from the same-scope say turn.
  it("C2: measures cross-scope envelope bytes, dangling refs, RPC counts, and sessions (enforced + tracked gates)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const harness = createStructuralHarness();
    const runId = `cf-local-c2-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let sessionA: string | null = null;
    let sessionB: string | null = null;
    try {
      // Open two sessions: alice is active, bob is idle in the same chatroom so
      // sessions-for-scopes reflects a realistic 2-actor scenario.
      sessionA = await openMcpSession(harness, `guest:c2-alice-${runId}`, runId);
      sessionB = await openMcpSession(harness, `guest:c2-bob-${runId}`, runId);
      await callTool(harness, sessionA, 3, "woo_call", { object: "the_chatroom", verb: "enter", args: [] });
      await callTool(harness, sessionB, 4, "woo_call", { object: "the_chatroom", verb: "enter", args: [] });
      const setupMetrics = metricsFromLogSpy(logSpy);
      logSpy.mockClear();

      // Warm-up: exercise same-scope and cross-scope paths once before the
      // measured phase so cold-opens and catalog install stay outside the gate.
      await callTool(harness, sessionA, 5, "woo_call", { object: "the_chatroom", verb: "southeast", args: [] });
      await callTool(harness, sessionA, 6, "woo_call", { object: "the_deck", verb: "go", args: ["pinboard"] });
      await callTool(harness, sessionA, 7, "woo_call", { object: "the_pinboard", verb: "go", args: ["out"] });
      await callTool(harness, sessionA, 8, "woo_call", { object: "the_deck", verb: "west", args: [] });
      logSpy.mockClear();

      // Measured phase: cross-scope movement turns only. The same-scope say turn
      // is intentionally excluded here because with two sessions it produces
      // scoped_shards=2 which the single-session fanout gate would flag.
      // The say turn's envelope bytes are measured separately below without the
      // structural fanout check.
      await callTool(harness, sessionA, 9,  "woo_call", { object: "the_chatroom", verb: "southeast", args: [] });
      await callTool(harness, sessionA, 10, "woo_call", { object: "the_deck", verb: "go", args: ["pinboard"] });
      await callTool(harness, sessionA, 11, "woo_call", { object: "the_pinboard", verb: "go", args: ["out"] });
      await callTool(harness, sessionA, 12, "woo_call", { object: "the_deck", verb: "west", args: [] });
      const measuredMovementMetrics = metricsFromLogSpy(logSpy);
      logSpy.mockClear();

      // Measure the same-scope say turn separately.
      await callTool(harness, sessionA, 13, "woo_call", { object: "the_chatroom", verb: "say", args: [`measured-say-${runId}`] });
      const measuredSayMetrics = metricsFromLogSpy(logSpy);

      writeLabeledMetricsIfRequested(runId, {
        setup: setupMetrics,
        measured_movement: measuredMovementMetrics,
        measured_say: measuredSayMetrics
      });

      // ── ENFORCED gates (must pass on current main with slim warm envelope) ──

      // Warm same-scope turns (the `say` turn): the authority slice must be zero.
      // The say turn commits in the_chatroom; it is NOT a planned-transcript
      // commit (no cross-scope move), so slimMcpEnvelopeBody applies and the
      // authority slice is stripped. WOO_V2_SLIM_WARM_ENVELOPE=1 is set in the
      // harness (see createStructuralHarness).
      //
      // NOTE: v2_envelope.request_bytes is always 0 in the fake lane because the
      // gateway constructs envelope requests via new Request(url, {body: JSON…})
      // without a content-length header; CommitScopeDO reads the header and gets 0.
      // We use v2_envelope_bytes.authority_bytes (from WOO_V2_ENVELOPE_BYTE_BREAKDOWN=1)
      // instead — this measures the actual serialized authority object in the request
      // body, not the HTTP header. On the slim warm path authority_bytes == 0 because
      // the slice is stripped by slimMcpEnvelopeBody. On cross-scope / cold paths
      // it is large (~1.7 MB). The 64 KB ceiling in C2_ENFORCED_WARM_SAME_SCOPE_ENVELOPE_BYTES
      // maps to "authority must be absent (0)"; we assert zero for a tight gate.
      const sameScopeEnvelopeBreakdowns = measuredSayMetrics.filter((m) => m.kind === "v2_envelope_bytes");
      for (const envelope of sameScopeEnvelopeBreakdowns) {
        const authorityBytes = Number(envelope.authority_bytes) || 0;
        expect(
          authorityBytes,
          `C2 ENFORCED: warm same-scope (the_chatroom) envelope must carry zero authority bytes ` +
          `(WOO_V2_SLIM_WARM_ENVELOPE=1). Got authority_bytes=${authorityBytes}. ` +
          `If this fails: the slim warm-envelope path has regressed. Ref PLAN: §C2 / §B-i.`
        ).toBe(0);
      }

      // Movement turns: attempts==1, authority_calls<=1, no repair, exactly one
      // envelope per accepted turn, no warm_turn_refresh/missing_state_repair.
      assertWarmTurnStructuralGate(measuredMovementMetrics, [
        { target: "the_chatroom", verb: "southeast" },
        { target: "the_deck", verb: "go" },
        { target: "the_pinboard", verb: "go" },
        { target: "the_deck", verb: "west" }
      ]);

      // ── TRACKED gates (measured and printed; not build-failing) ──────────
      // Each gate prints its current value so postflight comparisons have a
      // baseline. When a tracked gate starts passing, it should be promoted to
      // ENFORCED: remove its TRACKED tag and add a hard assertion.

      // Cross-scope envelope bytes: B-i (read-closure envelopes) is now active
      // (WOO_V2_READ_CLOSURE_ENVELOPE=1 in createStructuralHarness). Planned-transcript
      // (movement) commits carry only the read closure: actor + session + transcript-
      // touched cells + lineage ancestors (without verb_bytecode for lineage-only objects).
      // This reduces the cross-scope authority from ~1.7 MB to < 256 KB.
      //
      // We use v2_envelope_bytes.authority_bytes (WOO_V2_ENVELOPE_BYTE_BREAKDOWN=1)
      // rather than v2_envelope.request_bytes, because request_bytes is derived from
      // the HTTP content-length header which the fake lane never sets (always 0).
      // authority_bytes is computed via jsonByteLength(input.authority) directly on
      // the parsed object, so it is accurate in both fake and real lanes.
      const crossScopeEnvelopeBreakdowns = measuredMovementMetrics
        .filter((m) => m.kind === "v2_envelope_bytes")
        .filter((m) => m.scope !== "the_chatroom");
      const maxCrossScopeBytes = Math.max(0, ...crossScopeEnvelopeBreakdowns.map((m) => Number(m.authority_bytes) || 0));
      console.log(`c2.cross_scope_envelope_bytes max=${maxCrossScopeBytes} target=${C2_TRACKED_CROSS_SCOPE_ENVELOPE_BYTES} status=ENFORCED plan=B-i`);
      expect(
        maxCrossScopeBytes,
        `C2 ENFORCED (B-i): cross-scope (planned-transcript) envelope authority bytes must be < ${C2_TRACKED_CROSS_SCOPE_ENVELOPE_BYTES} (256 KB). ` +
        `Got max=${maxCrossScopeBytes}. WOO_V2_READ_CLOSURE_ENVELOPE=1 is set in createStructuralHarness. ` +
        `If this fails: the read-closure filter (filterAuthorityToReadClosure in authority-slice.ts) has regressed. ` +
        `Ref PLAN: §C2 / §B-i.`
      ).toBeLessThan(C2_TRACKED_CROSS_SCOPE_ENVELOPE_BYTES);

      // dangling_parent_ref count: ENFORCED to be 0 for movement-only turns.
      // Movement turns (enter/leave/southeast/west) do not involve $portable
      // objects and must never emit dangling_parent_ref. The A2 debt (lineage-
      // closed row installation for $portable objects) manifests only when a
      // `take` or `drop` is performed on a $portable; that is tracked via the
      // carry-across-rooms scenario in scripts/smoke/scenario.ts (C3, TRACKED A2).
      // Count over the full run (setup + measured).
      const allMetrics = [...setupMetrics, ...measuredMovementMetrics, ...measuredSayMetrics];
      const danglingRefs = allMetrics.filter((m) => m.kind === "dangling_parent_ref");
      console.log(`c2.dangling_parent_ref count=${danglingRefs.length} target=${C2_TRACKED_DANGLING_PARENT_REF_TARGET} status=ENFORCED plan=A2-movement-only`);
      expect(
        danglingRefs.length,
        `C2 ENFORCED: movement-only turns must not emit dangling_parent_ref. Got ${danglingRefs.length}. ` +
        `Dangling refs in movement turns indicate a regression in the class-lineage relay cache. ` +
        `Note: dangling_parent_ref for $portable objects (take/drop) is separately tracked in ` +
        `carry-across-rooms scenario. Ref PLAN: §C2 / §A2.`
      ).toBe(0);

      // Per-turn cross-host RPC count on warm turns. In the fake lane all DOs are
      // in-process, so cross_host_rpc is emitted but represents local function calls
      // rather than real cross-colo network RPCs. The fake lane reading (~2-3/turn)
      // does NOT reflect production load (~8+/turn in deployed smoke before D2).
      // This gate is purely structural: it gives a count baseline and detects
      // regressions that ADD new RPCs (the count going UP is bad; going down is fine).
      // The D2 bound of ≤ 3 RPCs/turn is a deploy-lane target; here we record the
      // current value and log it for baseline tracking. See smoke-cf-dev.ts for the
      // corresponding TRACKED gate in the higher-fidelity workerd lane.
      const phaseTimings = measuredMovementMetrics.filter((m) => m.kind === "turn_phase_timing");
      const crossHostRpcs = measuredMovementMetrics.filter((m) => m.kind === "cross_host_rpc");
      const rpcsPerTurn = phaseTimings.length > 0 ? crossHostRpcs.length / phaseTimings.length : 0;
      console.log(`c2.cross_host_rpc_per_turn avg=${rpcsPerTurn.toFixed(1)} target_note=D2_deploy_lane plan=D2`);
      // No TRACKED/PROMOTE check here: the fake-lane RPC count is not comparable
      // to the production RPC count D2 tracks. Track this in cf-dev instead.
      expect(
        rpcsPerTurn,
        `C2 baseline: warm movement turns emitted more cross_host_rpc than expected in fake lane. ` +
        `avg=${rpcsPerTurn.toFixed(1)} ceiling=${C2_TRACKED_WARM_TURN_MAX_CROSS_HOST_RPCS * 2} ` +
        `(fake-lane budget = 2× the D2 deploy target, only catches gross regressions). ` +
        `Real D2 tracking is in smoke-cf-dev.ts.`
      ).toBeLessThan(C2_TRACKED_WARM_TURN_MAX_CROSS_HOST_RPCS * 2);

      // Sessions-for-scopes: ENFORCED ≤ actors + margin in the fake lane.
      // The fake Directory is clean — sessions that are opened are tracked accurately
      // and there is no stale-session accumulation (the A1 production problem). So
      // the fake lane should always show ≤ actors + 1 rows. If this fails, a
      // new code path is creating extra Directory sessions for the same scope.
      //
      // The A1 production problem (stale sessions from closed pooled-guest clients
      // lingering in Directory) is NOT visible in the fake lane. It is tracked in
      // smoke-cf-dev.ts at a higher fidelity lane. This gate only catches regressions
      // that add sessions beyond the live actor count.
      const ACTOR_COUNT = 2;
      const sessionsForScopes = allMetrics.filter((m) => m.kind === "directory_sessions_for_scopes" && m.status === "ok");
      const maxSessionsFound = Math.max(0, ...sessionsForScopes.map((m) => Number(m.sessions) || 0));
      const sessionsBudget = ACTOR_COUNT + C2_TRACKED_MAX_SESSIONS_FOR_SCOPES_MARGIN;
      console.log(`c2.sessions_for_scopes max=${maxSessionsFound} budget=${sessionsBudget} actors=${ACTOR_COUNT} margin=${C2_TRACKED_MAX_SESSIONS_FOR_SCOPES_MARGIN} status=ENFORCED plan=A1-fake-lane`);
      expect(
        maxSessionsFound,
        `C2 ENFORCED: sessions_for_scopes must be ≤ actors + margin in fake lane. ` +
        `Got ${maxSessionsFound}, budget=${sessionsBudget} (${ACTOR_COUNT} actors + ${C2_TRACKED_MAX_SESSIONS_FOR_SCOPES_MARGIN} margin). ` +
        `If this fails: a new code path is registering extra sessions for the same scope. ` +
        `A1 production stale-session accumulation is tracked in smoke-cf-dev.ts. ` +
        `Ref PLAN: §C2 / §A1.`
      ).toBeLessThanOrEqual(sessionsBudget);
    } finally {
      if (sessionA) await mcpFetch(harness, { method: "DELETE", headers: { "mcp-session-id": sessionA } }).catch(() => undefined);
      if (sessionB) await mcpFetch(harness, { method: "DELETE", headers: { "mcp-session-id": sessionB } }).catch(() => undefined);
      logSpy.mockRestore();
      harness.close();
    }
  // C2 uses two sessions (alice + bob) on separate gateway shards; each needs a
  // warm cold-open (~17 s catalog install) plus measured warmup + measured phases.
  // Budget 120 s to avoid flapping on the global 45 s per-test timeout.
  }, 120_000);
});

type StructuralHarness = {
  env: Env;
  request(path: string, init: RequestInit): Promise<Response>;
  setDirectoryLastSeenAt(sessionIds: readonly string[], lastSeenAt: number): void;
  close(): void;
};

class FakeKVNamespace {
  readonly values = new Map<string, string>();

  async get(key: string, _type?: "text"): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

function createStructuralHarness(): StructuralHarness {
  const directoryState = new FakeDurableObjectState("directory");
  const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-local-structural-secret" });
  const wooStates = new Map<string, FakeDurableObjectState>();
  const wooObjects = new Map<string, PersistentObjectDO>();
  const commitStates = new Map<string, FakeDurableObjectState>();
  const commitObjects = new Map<string, CommitScopeDO>();
  let env: Env;

  const wooNamespace = new FakeDurableObjectNamespace((name) => {
    let object = wooObjects.get(name);
    if (!object) {
      const state = wooStates.get(name) ?? new FakeDurableObjectState(name);
      wooStates.set(name, state);
      object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
      wooObjects.set(name, object);
    }
    return object;
  });

  const commitNamespace = new FakeDurableObjectNamespace((name) => {
    let object = commitObjects.get(name);
    if (!object) {
      const state = commitStates.get(name) ?? new FakeDurableObjectState(name);
      commitStates.set(name, state);
      object = new CommitScopeDO(state as unknown as DurableObjectState, {
        WOO_INTERNAL_SECRET: "cf-local-structural-secret",
        // Enable per-envelope byte breakdown so C2 byte gates can use
        // v2_envelope_bytes.authority_bytes rather than the HTTP content-length
        // header (which is always 0 in the fake lane since the gateway constructs
        // requests with new Request(url, {body}) without setting content-length).
        WOO_V2_ENVELOPE_BYTE_BREAKDOWN: "1"
      });
      commitObjects.set(name, object);
    }
    return object;
  });

  env = {
    WOO_INITIAL_WIZARD_TOKEN: "cf-local-structural-token",
    WOO_INTERNAL_SECRET: "cf-local-structural-secret",
    WOO_AUTO_INSTALL_CATALOGS: PROD_CATALOGS,
    WOO_MCP_GATEWAY_SHARDS: String(PROD_SHARDS),
    WOO_V2_SLIM_WARM_ENVELOPE: "1",
    // B-i: enable read-closure envelopes for planned-transcript (cross-scope)
    // commits. This flag changes the C2 cross-scope envelope bytes gate from
    // TRACKED to ENFORCED (< 256 KB ceiling now holds).
    WOO_V2_READ_CLOSURE_ENVELOPE: "1",
    // Enable per-envelope byte breakdown in the gateway env as well.  The flag
    // is read by CommitScopeDO (whose env is set separately above), but we also
    // set it here for consistency and to allow gateway-side code to key on it.
    WOO_V2_ENVELOPE_BYTE_BREAKDOWN: "1",
    DIRECTORY: new FakeDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
      return directory;
    }),
    WOO: wooNamespace,
    COMMIT_SCOPE: commitNamespace,
    HOST_SEED_KV: new FakeKVNamespace() as unknown as KVNamespace
  } as unknown as Env;

  return {
    env,
    request: async (path, init) => await worker.fetch(new Request(`https://woo.test${path}`, init), env, {}),
    setDirectoryLastSeenAt: (sessionIds, lastSeenAt) => {
      for (const sessionId of sessionIds) {
        directoryState.storage.sql.exec("UPDATE session_route SET last_seen_at = ? WHERE session_id = ?", lastSeenAt, sessionId);
      }
    },
    close: () => {
      directoryState.close();
      for (const state of wooStates.values()) state.close();
      for (const state of commitStates.values()) state.close();
    }
  };
}

async function seedDirectoryMcpAudience(
  harness: StructuralHarness,
  runId: string,
  options: { scope: ObjRef; sessions: number; uniqueShards: number }
): Promise<string[]> {
  const shardCount = Math.min(options.uniqueShards, PROD_SHARDS);
  const safeRunId = runId.replace(/[^A-Za-z0-9_]/g, "_");
  const sessionIds: string[] = [];
  for (let i = 0; i < options.sessions; i += 1) {
    const shardIndex = i % shardCount;
    const sessionId = sessionIdForShard(`stale-prod-${runId}-${i}`, shardIndex, PROD_SHARDS);
    sessionIds.push(sessionId);
    await registerDirectorySession(harness, {
      session_id: sessionId,
      actor: `guest_stale_prod_${safeRunId}_${i}`,
      started: Date.now() - 60_000,
      display_name: `stale-prod-${i}`,
      expires_at: Date.now() + 60 * 60_000,
      token_class: "guest",
      active_scope: options.scope,
      current_location: options.scope,
      mcp_shard: mcpShardHost(sessionId),
      focus_list: [options.scope]
    });
  }
  return sessionIds;
}

async function registerDirectorySession(harness: StructuralHarness, payload: Record<string, unknown>): Promise<void> {
  const request = await signInternalRequest(harness.env, new Request("https://woo.internal/register-session", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  }));
  const response = await harness.env.DIRECTORY.get(harness.env.DIRECTORY.idFromName("directory")).fetch(request);
  expect(response.ok, await response.clone().text()).toBe(true);
}

async function openMcpSession(harness: StructuralHarness, token: string, runId: string): Promise<string> {
  const response = await mcpFetch(harness, {
    method: "POST",
    headers: { "mcp-token": token },
    body: rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: `cf-local-structural/${runId}`, version: "0.0.0" }
    })
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await parseMcpResponse(response);
  const initialized = await mcpFetch(harness, {
    method: "POST",
    headers: { "mcp-session-id": sessionId! },
    body: notification("notifications/initialized")
  });
  expect(initialized.status).toBe(202);
  return sessionId!;
}

async function callTool(
  harness: StructuralHarness,
  sessionId: string,
  id: number,
  name: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const response = await mcpFetch(harness, {
    method: "POST",
    headers: { "mcp-session-id": sessionId },
    body: rpc(id, "tools/call", { name, arguments: params })
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  const body = await parseMcpResponse(response);
  if (body?.result?.isError) throw new Error(`MCP tool error: ${JSON.stringify(body.result.structuredContent ?? body.result)}`);
  return body?.result?.structuredContent?.result;
}

async function mcpFetch(
  harness: StructuralHarness,
  input: { method: string; headers?: Record<string, string>; body?: unknown }
): Promise<Response> {
  const headers = new Headers({ accept: "application/json, text/event-stream", ...input.headers });
  let body: BodyInit | undefined;
  if (input.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(input.body);
  }
  return await harness.request("/mcp", { method: input.method, headers, body });
}

async function parseMcpResponse(response: Response): Promise<any> {
  if (response.status === 202 || response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const data = text.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice("data:".length).trim();
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(text);
}

function metricsFromLogSpy(logSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return logSpy.mock.calls
    .filter((c) => c[0] === "woo.metric" && typeof c[1] === "string")
    .map((c) => { try { return JSON.parse(c[1] as string) as Record<string, unknown>; } catch { return null; } })
    .filter((m): m is Record<string, unknown> => m !== null);
}

function maxMetric(metrics: Record<string, unknown>[], kind: string, field: string): number {
  return Math.max(0, ...metrics.filter((m) => m.kind === kind).map((m) => Number(m[field]) || 0));
}

function assertWarmTurnStructuralGate(metrics: Record<string, unknown>[], expectedTurns: WarmTurnExpectation[]): void {
  const violations = warmTurnStructuralViolations(metrics, expectedTurns);
  expect(
    violations,
    `measured warm deterministic turns violated structural invariants:\n${violations.join("\n")}`
  ).toEqual([]);
}

function warmTurnStructuralViolations(metrics: Record<string, unknown>[], expectedTurns: WarmTurnExpectation[]): string[] {
  const violations: string[] = [];
  const expected = new Map(expectedTurns.map((turn) => [turnKey(turn), turn]));
  const phaseTimings = metrics.filter((m) => m.kind === "turn_phase_timing" && expected.has(metricTurnKey(m)));
  const phaseTimingsByTurn = groupByTurn(phaseTimings);
  for (const turn of expectedTurns) {
    const key = turnKey(turn);
    const timings = phaseTimingsByTurn.get(key) ?? [];
    const expectedCount = turn.expectedCount ?? 1;
    if (timings.length !== expectedCount) {
      violations.push(`turn_phase_timing ${key} count=${timings.length} expected=${expectedCount}`);
      continue;
    }
    for (const timing of timings) {
      const attempts = Number(timing.attempts);
      const authorityCalls = Number(timing.authority_calls);
      const maxAuthorityCalls = turn.maxAuthorityCalls ?? 1;
      if (attempts !== 1 || authorityCalls > maxAuthorityCalls) {
        violations.push(`turn_phase_timing ${key} attempts=${String(timing.attempts)} authority_calls=${String(timing.authority_calls)} max_authority_calls=${maxAuthorityCalls}`);
      }
      if (timing.outcome !== "submitted") {
        violations.push(`turn_phase_timing ${key} outcome=${String(timing.outcome)}`);
      }
      if (!hasSubmitDetail(timing, "worker.commit_scope_envelope_rpc")) {
        violations.push(`turn_phase_timing ${key} missing_submit_detail=worker.commit_scope_envelope_rpc`);
      } else {
        const commitScopeEnvelopeRpcMs = submitDetailNumber(timing, "worker.commit_scope_envelope_rpc");
        const maxCommitScopeEnvelopeRpcMs = turn.maxCommitScopeEnvelopeRpcMs ?? WARM_TURN_MAX_COMMIT_SCOPE_ENVELOPE_RPC_MS;
        if (commitScopeEnvelopeRpcMs > maxCommitScopeEnvelopeRpcMs) {
          violations.push(`commit_scope_envelope_rpc ${key} ms=${commitScopeEnvelopeRpcMs} max=${maxCommitScopeEnvelopeRpcMs}`);
        }
      }
    }
  }

  for (const metric of metrics) {
    const key = metricTurnKey(metric);
    if (metric.kind === "turn_repair_attempt" && expected.has(key)) {
      violations.push(
        `turn_repair_attempt ${key} source=${String(metric.source)} reason=${String(metric.reason)} attempt=${String(metric.attempt)} objects=${JSON.stringify(metric.objects ?? [])} atoms=${JSON.stringify(metric.atoms ?? [])}`
      );
    }
    if (metric.kind === "direct_call" && expected.has(key) && metric.status === "error") {
      violations.push(`direct_call ${key} status=error error=${String(metric.error ?? "")}`);
    }
  }

  for (const metric of metrics) {
    if (
      metric.kind === "authority_slice_reconstructed" &&
      WARM_TURN_FORBIDDEN_AUTHORITY_RECONSTRUCTION_REASONS.has(String(metric.reason))
    ) {
      violations.push(`authority_slice_reconstructed scope=${String(metric.scope)} reason=${String(metric.reason)} objects=${String(metric.object_count)} pages=${String(metric.page_count)} source_host=${String(metric.source_host ?? "")}`);
    }
    if (metric.kind === "shadow_commit_rejected") {
      violations.push(`shadow_commit_rejected scope=${String(metric.scope)} reason=${String(metric.reason)}`);
    }
    if (metric.kind === "serialized_world_materialized") {
      violations.push(`serialized_world_materialized scope=${String(metric.scope)} reason=${String(metric.reason)} objects=${String(metric.objects)} sessions=${String(metric.sessions)}`);
    }
    if (metric.kind === "shadow_gateway_apply_step") {
      violations.push(`shadow_gateway_apply_step scope=${String(metric.scope)} phase=${String(metric.phase)} objects=${String(metric.objects)} writes=${String(metric.writes)}`);
    }
    if (metric.kind === "mcp_fanout") {
      const shards = Number(metric.shards) || 0;
      const scopedShards = Number(metric.scoped_shards) || 0;
      const affectedScopes = Number(metric.affected_scopes) || 0;
      const audienceSessionShards = Number(metric.audience_session_shards) || 0;
      if (
        shards > WARM_TURN_MAX_MCP_FANOUT_SHARDS ||
        scopedShards > WARM_TURN_MAX_MCP_SCOPED_SHARDS ||
        affectedScopes > WARM_TURN_MAX_MCP_AFFECTED_SCOPES ||
        audienceSessionShards > WARM_TURN_MAX_MCP_FANOUT_SHARDS
      ) {
        violations.push(`mcp_fanout scope=${String(metric.scope)} shards=${shards} max_shards=${WARM_TURN_MAX_MCP_FANOUT_SHARDS} scoped_shards=${scopedShards} max_scoped_shards=${WARM_TURN_MAX_MCP_SCOPED_SHARDS} affected_scopes=${affectedScopes} max_affected_scopes=${WARM_TURN_MAX_MCP_AFFECTED_SCOPES} audience_session_shards=${audienceSessionShards}`);
      }
    }
  }

  const acceptedEnvelopes = metrics.filter((m) => m.kind === "v2_envelope" && m.status === "ok");
  if (acceptedEnvelopes.length !== phaseTimings.length) {
    violations.push(`v2_envelope accepted_count=${acceptedEnvelopes.length} expected_turns=${phaseTimings.length}`);
  }
  const mcpFanouts = metrics.filter((m) => m.kind === "mcp_fanout");
  if (mcpFanouts.length !== phaseTimings.length) {
    violations.push(`mcp_fanout count=${mcpFanouts.length} expected_turns=${phaseTimings.length}`);
  }
  return violations;
}

function groupByTurn(metrics: Record<string, unknown>[]): Map<string, Record<string, unknown>[]> {
  const out = new Map<string, Record<string, unknown>[]>();
  for (const metric of metrics) {
    const key = metricTurnKey(metric);
    const bucket = out.get(key) ?? [];
    bucket.push(metric);
    out.set(key, bucket);
  }
  return out;
}

function turnKey(turn: Pick<WarmTurnExpectation, "target" | "verb">): string {
  return `${turn.target}:${turn.verb}`;
}

function metricTurnKey(metric: Record<string, unknown>): string {
  return `${String(metric.target ?? "")}:${String(metric.verb ?? "")}`;
}

function hasSubmitDetail(metric: Record<string, unknown>, label: string): boolean {
  const detail = metric.submit_detail_ms;
  return typeof detail === "object" && detail !== null && label in detail;
}

function submitDetailNumber(metric: Record<string, unknown>, label: string): number {
  const detail = metric.submit_detail_ms;
  if (typeof detail !== "object" || detail === null) return 0;
  return Number((detail as Record<string, unknown>)[label]) || 0;
}

function writeLabeledMetricsIfRequested(
  runId: string,
  phases: Record<string, Record<string, unknown>[]>
): void {
  if (!process.env.WOO_CF_LOCAL_METRICS_OUT) return;
  const labeled = Object.entries(phases).flatMap(([phase, metrics]) =>
    metrics.map((metric) => ({ ...metric, cf_local_run: runId, cf_local_phase: phase }))
  );
  writeFileSync(process.env.WOO_CF_LOCAL_METRICS_OUT, `${JSON.stringify(labeled, null, 2)}\n`);
}

function rpc(id: number, method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function notification(method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
}

function sessionIdForShard(prefix: string, shardIndex: number, shards: number): string {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const candidate = `${prefix}-${attempt}`;
    if (mcpShardHost(candidate, shards) === `mcp-gateway-${shardIndex}`) return candidate;
  }
  throw new Error(`could not construct session id for mcp-gateway-${shardIndex}`);
}

function mcpShardHost(sessionId: string, shards = PROD_SHARDS): string {
  return `mcp-gateway-${stableHash(sessionId) % shards}`;
}

function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function serializedObject(id: ObjRef, name: string, parent: ObjRef | null): SerializedObject {
  return {
    id,
    name,
    parent,
    owner: "$wiz",
    location: null,
    anchor: id,
    flags: {},
    created: 1,
    modified: 1,
    propertyDefs: [],
    properties: [],
    propertyVersions: [],
    verbs: [],
    children: [],
    contents: [],
    eventSchemas: []
  };
}

function emptySerializedWorld(): SerializedWorld {
  return {
    version: 1,
    objectCounter: 1,
    parkedTaskCounter: 1,
    sessionCounter: 1,
    objects: [],
    sessions: [],
    logs: [],
    snapshots: [],
    parkedTasks: [],
    tombstones: []
  };
}
