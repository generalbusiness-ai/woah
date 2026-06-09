import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { CommitScopeDO } from "../../src/worker/commit-scope-do";
import { DirectoryDO } from "../../src/worker/directory-do";
import { MCP_GATEWAY_ACTOR_SUPPORT_ROOTS, PersistentObjectDO, type Env } from "../../src/worker/persistent-object-do";
import { createWorld } from "../../src/core/bootstrap";
import type { ObjRef } from "../../src/core/types";
import { FakeDurableObjectNamespace, FakeDurableObjectState } from "./fake-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

// Derive the universal actor/thing lineage the gateway-shard support set MUST
// carry, the same way production does: the parent-closure of
// MCP_GATEWAY_ACTOR_SUPPORT_ROOTS over the bootstrap seed (no catalogs). Derived,
// not hardcoded, so the guard tracks the seed lineage if it changes.
function seedDerivedUniversalLineage(): Set<ObjRef> {
  const snapshot = createWorld({ catalogs: false }).exportWorld();
  const byId = new Map(snapshot.objects.map((obj) => [obj.id, obj] as const));
  const ids = new Set<ObjRef>();
  const subtree = [...MCP_GATEWAY_ACTOR_SUPPORT_ROOTS];
  while (subtree.length > 0) {
    const id = subtree.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const child of byId.get(id)?.children ?? []) subtree.push(child);
  }
  for (const root of MCP_GATEWAY_ACTOR_SUPPORT_ROOTS) {
    let current: ObjRef | null = byId.get(root)?.parent ?? null;
    while (current && !ids.has(current)) {
      ids.add(current);
      current = byId.get(current)?.parent ?? null;
    }
  }
  return ids;
}

vi.setConfig({ testTimeout: 60_000 });

const SHARDS = 4;
const RPC_TIMEOUT_MS = 8_000;
const STEP_TIMEOUT_MS = 15_000;
const DRAIN_TOTAL_BUDGET_MS = 1500;
const DRAIN_POLL_MS = 250;
const DIRECTORY_PRESENCE_WINDOW_MS = 5 * 60_000;
const DETERMINISTIC_PREFETCH_TURNS = new Set([
  "the_chatroom:southeast",
  "the_deck:south",
  "the_deck:west",
  "the_garden:south",
  "the_outline:leave",
  "the_pinboard:leave"
]);

class FakeKVNamespace {
  readonly values = new Map<string, string>();

  async get(key: string, _type?: "text"): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

class WaitUntilDurableObjectState extends FakeDurableObjectState {
  readonly waitUntilPromises: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.waitUntilPromises.push(Promise.resolve(promise));
  }

  async drainWaitUntil(): Promise<void> {
    await Promise.all(this.waitUntilPromises.splice(0));
  }
}

type CfSmokeHarness = {
  env: Env;
  shards: number;
  request(path: string, init: RequestInit): Promise<Response>;
  drainWaitUntil(): Promise<void>;
  setDirectoryLastSeenAt(sessionIds: readonly string[], lastSeenAt: number): void;
  directoryRequests(path?: string): Array<{ path: string; body: Record<string, unknown> | null }>;
  clearDirectoryRequests(): void;
  close(): void;
};

// Optional prod-shape knobs. Defaults stay small and fast for the normal
// cf-local smoke; focused tests opt into the deployed shard/session pressure.
type CfSmokeHarnessOptions = {
  shards?: number;
  directorySessionsForScopesDelayMs?: number;
  mcpCommitFanoutDelayMs?: number;
  hostReadTimeoutMs?: number;
};

describe("CF-local smoke walkthrough", () => {
  it("covers cross-shard MCP movement and tool-space fanout through Worker Durable Object shape", async () => {
    const harness = createCfSmokeHarness();
    const runId = `cf-local-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let logSpy: ReturnType<typeof vi.spyOn> | null = null;
    let warnSpy: ReturnType<typeof vi.spyOn> | null = null;
    let alice: LocalMcpSession | null = null;
    let bob: LocalMcpSession | null = null;
    try {
      await seedClosedChatroomOccupant(harness, runId);
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      alice = await LocalMcpSession.open(harness, `guest:cf-local-alice-${runId}`, "alice", runId);
      bob = await openOnDifferentShard(harness, alice, runId);
      await runWalkthrough(alice, bob);
      // Regression guard for the gateway-shard lineage gap (perf-plan steps
      // 1-2): MCP planning must never run against a sparse relay snapshot that
      // dangles either universal actor support ($system/$guest/...) or
      // scope/catalog classes ($chatroom/$note/...). Those rows must be present
      // before local VM planning, or the turn fails locally before authority
      // repair can act.
      const danglingParentRefs = logSpy.mock.calls
        .map((args) => args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))
        .filter((line) => line.includes("dangling_parent_ref"))
        .map((line) => ({
          start: /"start":"([^"]+)"/.exec(line)?.[1] ?? null,
          missing: /"missing":"([^"]+)"/.exec(line)?.[1] ?? null
        }));
      expect(
        danglingParentRefs.length,
        `gateway-shard planning emitted dangling_parent_ref after pre-plan authority repair: ${JSON.stringify(danglingParentRefs.slice(0, 5))}`
      ).toBe(0);

      // A1 — coherence-invariant (CI) gate for the mobile-heap target.
      // VTN0.Conformance: every node's derived view of a touched cell must equal
      // the committed authority at the same head; no two copies of a cell may be
      // mutated by independent write paths. A CI violation surfaces as a commit
      // rejection logged by CommitScopeDO ("woo.commit_rejected.errors", each
      // error naming the diverged `<object>.<cell>`). The step-level walkthrough
      // MASKS these: the turn retries and eventually succeeds, so the step passes
      // while a derived view silently disagreed with authority. This assertion is
      // the structural teeth VTN0 promises — it fails on "two copies disagreed"
      // by signature, even when retry papers over the symptom.
      //
      // ZERO-TOLERANCE as of A4. The presence/containment PROJECTION cells
      // (`subscribers`, `session_subscribers`, `contents`) used to sit on the
      // commit-validation path, so a cross-room turn could plan them stale and get
      // rejected (e.g. `the_outline:leave` rejecting on `the_chatroom.subscribers`).
      // A4 (cell-authority CA2/CA4) took them OFF the validation path: a read of a
      // projection cell is no longer a consistency dependency, because its truth is
      // each member's own `live:location` authoritative cell. The allow-list is now
      // EMPTY — the gate fails on ANY commit-rejection error of any kind. The
      // allow-list MUST only ever shrink (it is now at its floor); re-adding an
      // entry is re-introducing multiplication and is forbidden.
      const KNOWN_CI_DEBT_CELLS = new Set<string>([]);
      // VTN0 conformance: parse the STRUCTURED commit-rejection log rather than
      // string-scanning the joined diagnostics. CommitScopeDO logs every
      // rejection as `console.log("woo.commit_rejected.errors", JSON)` whose
      // `errors` array carries one string per diverged cell (effect-transcript /
      // shadow-commit-scope `cellLabel`: `<object>.<cell>` for property/location/
      // contents/lifecycle, `<object>:<verb>` for verb cells). The gate fails on
      // EVERY error except a read/write-version mismatch on an allow-listed
      // projection cell — so write-prior mismatches, verb-cell divergence,
      // post_state_mismatch, incomplete_transcript, and any unrecognized error
      // string can no longer slip through a dot-form regex.
      const isAllowlistedProjectionMismatch = (error: string): boolean => {
        // Only read/write version/value mismatches name a cell as
        // `<object>.<cell>` with a dot. post_state_mismatch, incomplete_transcript,
        // and verb-cell (`<object>:<verb>`) errors never match this shape and so
        // are never excused. The object id carries no dot or colon, so the first
        // dot delimits the cell name.
        const m = /^(?:read (?:version|value) mismatch|write prior mismatch) [^\s:]+\.([A-Za-z0-9_]+)(?::|$)/.exec(error);
        return m !== null && KNOWN_CI_DEBT_CELLS.has(m[1]);
      };
      const ciOffenders: string[] = [];
      for (const call of logSpy.mock.calls) {
        if (call[0] !== "woo.commit_rejected.errors" || typeof call[1] !== "string") continue;
        let parsed: { errors?: unknown; scope?: unknown; verb?: unknown; target?: unknown; actor?: unknown };
        try {
          parsed = JSON.parse(call[1]) as typeof parsed;
        } catch {
          // A rejection line the gate cannot read is itself a failure: never let
          // an unparseable commit_rejected entry pass silently.
          ciOffenders.push(`unparseable woo.commit_rejected.errors: ${call[1].slice(0, 240)}`);
          continue;
        }
        const errors = Array.isArray(parsed.errors)
          ? parsed.errors.filter((entry): entry is string => typeof entry === "string")
          : [];
        const context = `${String(parsed.verb ?? "?")} ${String(parsed.target ?? "?")} @ ${String(parsed.scope ?? "?")}`;
        for (const error of errors) {
          if (!isAllowlistedProjectionMismatch(error)) ciOffenders.push(`${error} :: ${context}`);
        }
      }
      expect(
        ciOffenders.length,
        `coherence-invariant violation during cross-shard walkthrough (VTN0): a commit rejection reported an error that is NOT an allow-listed A4 projection-cell mismatch. ` +
        `This is new multiplication / a masked rejection and must be fixed, not allow-listed. First offenders:\n${ciOffenders.slice(0, 3).join("\n")}`
      ).toBe(0);

      // Slice 1 instrumentation guard: the phase-attribution metrics must
      // actually fire on the real worker DO /mcp path, or a deploy ships blind
      // instruments. Parse the structured woo.metric log lines the DO emits.
      const parsedMetrics = logSpy.mock.calls
        .filter((c) => c[0] === "woo.metric" && typeof c[1] === "string")
        .map((c) => { try { return JSON.parse(c[1] as string) as Record<string, unknown>; } catch { return null; } })
        .filter((m): m is Record<string, unknown> => m !== null);
      if (process.env.WOO_CF_LOCAL_METRICS_OUT) {
        writeFileSync(process.env.WOO_CF_LOCAL_METRICS_OUT, `${JSON.stringify(parsedMetrics, null, 2)}\n`);
      }

      // turn_phase_timing — emitted by submitTurnIntent for every POST turn.
      const phaseTimings = parsedMetrics.filter((m) => m.kind === "turn_phase_timing");
      expect(phaseTimings.length, "submitTurnIntent must emit turn_phase_timing on the DO turn path").toBeGreaterThan(0);
      expect(phaseTimings.some((m) => m.outcome === "submitted"), "at least one turn should commit").toBe(true);
      const deterministicRepairAttempts = parsedMetrics
        .filter((m) => m.kind === "turn_repair_attempt")
        // This gate covers the deterministic movement/tool-leave turns in this
        // walkthrough. Other verbs, such as cold take/drop, may still repair
        // correctly until their authority closures are made sparse-plan complete.
        .filter((m) => DETERMINISTIC_PREFETCH_TURNS.has(`${String(m.target)}:${String(m.verb)}`))
        .map((m) => `${String(m.target)}:${String(m.verb)} source=${String(m.source)} reason=${String(m.reason)} objects=${JSON.stringify(m.objects ?? [])} atoms=${JSON.stringify(m.atoms ?? [])}`);
      expect(
        deterministicRepairAttempts,
        "prod-shaped local smoke should not need sparse-planning repair for deterministic movement/tool-leave turns; prefetch declarative destinations instead"
      ).toEqual([]);
      const initialChatroomEnters = phaseTimings
        .filter((m) => m.target === "the_chatroom" && m.verb === "enter" && m.route === "direct")
        .slice(0, 2);
      expect(initialChatroomEnters.length, "both initial chatroom enters must emit phase timing").toBe(2);
      const contentExpansions = parsedMetrics
        .filter((m) => m.kind === "authority_slice_content_expansion")
        .filter((m) => Number(m.objects) > 0);
      expect(
        contentExpansions,
        "stale guest room contents must not trigger pre-plan contents authority expansion; active guests arrive through Directory/session projection"
      ).toEqual([]);
      const admissionViolations = warnSpy.mock.calls
        .filter((call) => call[0] === "woo.planning_world_inadmissible")
        .map((call) => JSON.stringify(call[1] ?? {}));
      expect(
        admissionViolations,
        "stale room guest contents must not enter MCP planning as presentation stubs; active peer actors arrive through Directory/session projection"
      ).toEqual([]);
      const repairedInitialEnters = initialChatroomEnters
        .filter((m) => Number(m.attempts) !== 1)
        .map((m) => `${String(m.target)}:${String(m.verb)} attempts=${String(m.attempts)} auth_calls=${String(m.authority_calls)} total=${String(m.total_ms)}ms`);
      expect(
        repairedInitialEnters,
        `initial cross-shard chatroom enters must converge on the first attempt; repair rounds reproduce the prod 20s timeout wall. Admission violations: ${admissionViolations.slice(0, 6).join(" | ")}`
      ).toEqual([]);
      const prePlanRefreshInitialEnters = initialChatroomEnters
        .filter((m) => Number(m.authority_calls) !== 1)
        .map((m) => `${String(m.target)}:${String(m.verb)} attempts=${String(m.attempts)} auth_calls=${String(m.authority_calls)} total=${String(m.total_ms)}ms`);
      expect(
        prePlanRefreshInitialEnters,
        "B7 warm-cache-first MCP turns must not pay both pre-plan and commit authority refresh; a one-attempt enter should need exactly the commit refresh"
      ).toEqual([]);
      // Every phase field must be a finite number so the analyzer never charges NaN.
      for (const field of ["total_ms", "ensure_client_ms", "authority_ms", "serialize_ms", "plan_build_ms", "vm_ms", "submit_ms", "authority_calls", "attempts"]) {
        expect(typeof phaseTimings[0]![field], `turn_phase_timing.${field} must be numeric`).toBe("number");
      }

      // mcp_dispatch_timing (POST) — the /mcp dispatch wrapper outside the turn.
      const postDispatch = parsedMetrics.filter((m) => m.kind === "mcp_dispatch_timing" && m.method === "POST");
      expect(postDispatch.length, "the /mcp dispatch wrapper must emit mcp_dispatch_timing for POST").toBeGreaterThan(0);

      // DELETE teardown is the worst smoke endpoint; prove its dispatch metric
      // fires too. Close alice here (and null it so finally won't double-close).
      const closedAliceSessionId = alice!.sessionId;
      await alice!.close();
      const staleAfterClose = await mcpFetch(harness, {
        method: "POST",
        headers: { "mcp-session-id": closedAliceSessionId },
        body: rpc(999, "tools/list", {})
      });
      expect(
        staleAfterClose.ok,
        "DELETE /mcp must end the Woo session and unregister Directory so a stale MCP session id cannot be resumed"
      ).toBe(false);
      alice = null;
      const deleteDispatch = logSpy.mock.calls
        .filter((c) => c[0] === "woo.metric" && typeof c[1] === "string")
        .map((c) => { try { return JSON.parse(c[1] as string) as Record<string, unknown>; } catch { return null; } })
        .filter((m): m is Record<string, unknown> => m !== null)
        .filter((m) => m.kind === "mcp_dispatch_timing" && m.method === "DELETE");
      expect(deleteDispatch.length, "the /mcp dispatch wrapper must emit mcp_dispatch_timing for DELETE teardown").toBeGreaterThan(0);
    } finally {
      await Promise.allSettled([alice?.close(), bob?.close()]);
      warnSpy?.mockRestore();
      logSpy?.mockRestore();
      harness.close();
    }
  });

  it("gateway-shard support roots carry actor/thing lineage but never scope/catalog classes", () => {
    // The universal support set exists for actor/thing lineage only. Scope/room
    // class lineage ($space and catalog scope classes like $chatroom) stays owner
    // authority and must arrive via the room's authority slice (perf-plan step 2).
    // This guards against "fixing" a scope-lineage dangle by broadening the
    // universal support roots — which would re-import the sparse-stub-overwrites-
    // real-scope hazard the support set deliberately avoids.
    const lineage = seedDerivedUniversalLineage();
    // Positive: the actor/thing chain to the top is fully covered.
    for (const id of ["$system", "$root", "$actor", "$player", "$guest", "$human", "$agent", "$thing"]) {
      expect(lineage.has(id as ObjRef), `universal lineage must include ${id}`).toBe(true);
    }
    // Negative: roots and derived closure exclude scope/catalog lineage.
    for (const id of ["$space", "$chatroom", "$sequenced_log"]) {
      expect(MCP_GATEWAY_ACTOR_SUPPORT_ROOTS, `roots must not include scope class ${id}`).not.toContain(id);
      expect(lineage.has(id as ObjRef), `universal lineage must not include scope class ${id}`).toBe(false);
    }
  });

  it("bounds prod-shaped stale MCP Directory audience pressure locally", async () => {
    const harness = createCfSmokeHarness({ shards: 32 });
    const runId = `cf-local-prod-shape-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let logSpy: ReturnType<typeof vi.spyOn> | null = null;
    let alice: LocalMcpSession | null = null;
    try {
      const staleSessionIds = await seedDirectoryMcpAudience(harness, runId, {
        scope: "the_chatroom",
        sessions: 29,
        uniqueShards: 17
      });
      // The presence fix treats register-session itself as liveness, so stale
      // rows must become stale by lease age, not by old started/expires_at
      // fields. Keep real timers in this walkthrough file and directly age only
      // the seeded Directory leases; this is the local equivalent of "registered
      // live in prod, then no client ingress for > W".
      harness.setDirectoryLastSeenAt(staleSessionIds, Date.now() - DIRECTORY_PRESENCE_WINDOW_MS - 60_000);
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      alice = await LocalMcpSession.open(harness, `guest:cf-local-prod-shape-alice-${runId}`, "alice", runId);

      await alice.call("the_chatroom", "enter", []);
      await harness.drainWaitUntil();

      const parsedMetrics = metricsFromLogSpy(logSpy);
      const directoryLookups = parsedMetrics
        .filter((m) => m.kind === "directory_sessions_for_scopes" && m.status === "ok")
        .filter((m) => Number(m.scopes) === 1);
      const directoryPressure = directoryLookups.find((m) => Number(m.sessions) >= 29);
      expect(
        directoryPressure,
        `presence lease must filter the 29 stale Directory rows; saw ${JSON.stringify(directoryLookups)}`
      ).toBeUndefined();
      const maxDirectorySessions = Math.max(0, ...directoryLookups.map((m) => Number(m.sessions) || 0));
      expect(
        maxDirectorySessions,
        "stale Directory pressure should collapse to the live room set, not the whole unexpired auth set"
      ).toBeLessThanOrEqual(2);

      const fanoutMetrics = parsedMetrics.filter((m) => m.kind === "mcp_fanout");
      // Enter commits at the actor scope, but room/presence fanout is still
      // visible through affected_scopes plus the selected MCP audience shards.
      const fanoutPressure = fanoutMetrics
        .find((m) => Number(m.audience_session_shards) >= 16 && Number(m.affected_scopes) > 0);
      expect(
        fanoutPressure,
        `presence lease must prevent stale Directory rows from selecting prod-scale MCP fanout; saw ${JSON.stringify(fanoutMetrics)}`
      ).toBeUndefined();
      const maxAudienceSessionShards = Math.max(0, ...fanoutMetrics.map((m) => Number(m.audience_session_shards) || 0));
      expect(
        maxAudienceSessionShards,
        "stale Directory pressure should not select one gateway shard per old session"
      ).toBeLessThanOrEqual(2);
    } finally {
      await Promise.allSettled([alice?.close(), harness.drainWaitUntil()]);
      logSpy?.mockRestore();
      harness.close();
    }
  });

  it("throttles established MCP ingress presence touches before dispatch", async () => {
    const harness = createCfSmokeHarness();
    const runId = `cf-local-ingress-throttle-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let session: LocalMcpSession | null = null;
    try {
      session = await LocalMcpSession.open(harness, `guest:cf-local-ingress-throttle-${runId}`, "alice", runId);

      harness.clearDirectoryRequests();
      await session.callTool("woo_wait", { timeout_ms: 1, limit: 1 });
      await harness.drainWaitUntil();
      const firstRegistrations = harness.directoryRequests("/register-session");
      expect(
        firstRegistrations.map((r) => String(r.body?.session_id ?? "")),
        "a fresh established MCP request should use only the existing post-response route registration; an extra pre-dispatch ingress touch adds a Directory round-trip to the hot path"
      ).toEqual([session.sessionId]);

      harness.clearDirectoryRequests();
      await session.callTool("woo_wait", { timeout_ms: 1, limit: 1 });
      await harness.drainWaitUntil();
      const secondRegistrations = harness.directoryRequests("/register-session");
      expect(
        secondRegistrations.map((r) => String(r.body?.session_id ?? "")),
        "the gateway-local W/2 throttle should keep skipping the pre-dispatch Directory touch while the session lease is locally fresh"
      ).toEqual([session.sessionId]);
    } finally {
      await Promise.allSettled([session?.close(), harness.drainWaitUntil()]);
      harness.close();
    }
  });
});

function createCfSmokeHarness(options: CfSmokeHarnessOptions = {}): CfSmokeHarness {
  const shards = options.shards ?? SHARDS;
  const directoryState = new FakeDurableObjectState("directory");
  const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-local-smoke-secret" });
  const wooStates = new Map<string, WaitUntilDurableObjectState>();
  const wooObjects = new Map<string, PersistentObjectDO>();
  const commitStates = new Map<string, FakeDurableObjectState>();
  const commitObjects = new Map<string, CommitScopeDO>();
  const directoryRequests: Array<{ path: string; body: Record<string, unknown> | null }> = [];
  let env: Env;

  const wooNamespace = new FakeDurableObjectNamespace((name) => {
    let object = wooObjects.get(name);
    if (!object) {
      let state = wooStates.get(name);
      if (!state) {
        state = new WaitUntilDurableObjectState(name);
        wooStates.set(name, state);
      }
      object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
      wooObjects.set(name, object);
    }
    return {
      fetch: async (request: Request): Promise<Response> => {
        if (new URL(request.url).pathname === "/__internal/mcp-commit-fanout") {
          await delayFor(options.mcpCommitFanoutDelayMs, request.signal);
        }
        return await object.fetch(request);
      }
    };
  });

  const commitNamespace = new FakeDurableObjectNamespace((name) => {
    let object = commitObjects.get(name);
    if (!object) {
      let state = commitStates.get(name);
      if (!state) {
        state = new FakeDurableObjectState(name);
        commitStates.set(name, state);
      }
      object = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-local-smoke-secret" });
      commitObjects.set(name, object);
    }
    return object;
  });

  env = {
    WOO_INITIAL_WIZARD_TOKEN: "cf-local-smoke-token",
    WOO_INTERNAL_SECRET: "cf-local-smoke-secret",
    WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,note,blocks-demo",
    WOO_MCP_GATEWAY_SHARDS: String(shards),
    WOO_V2_SLIM_WARM_ENVELOPE: "1",
    ...(options.hostReadTimeoutMs !== undefined ? { WOO_HOST_READ_TIMEOUT_MS: String(options.hostReadTimeoutMs) } : {}),
    DIRECTORY: new FakeDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
      return {
        fetch: async (request: Request): Promise<Response> => {
          const pathname = new URL(request.url).pathname;
          if (pathname === "/register-session") {
            let body: Record<string, unknown> | null = null;
            try {
              const parsed = await request.clone().json();
              body = isRecord(parsed) ? parsed : null;
            } catch {
              body = null;
            }
            directoryRequests.push({ path: pathname, body });
          }
          if (pathname === "/sessions-for-scopes") {
            await delayFor(options.directorySessionsForScopesDelayMs, request.signal);
          }
          return await directory.fetch(request);
        }
      };
    }),
    WOO: wooNamespace,
    COMMIT_SCOPE: commitNamespace,
    HOST_SEED_KV: new FakeKVNamespace() as unknown as KVNamespace
  } as unknown as Env;

  return {
    env,
    shards,
    request: async (path, init) => await worker.fetch(new Request(`https://woo.test${path}`, init), env, {}),
    drainWaitUntil: async () => {
      for (const state of wooStates.values()) await state.drainWaitUntil();
    },
    setDirectoryLastSeenAt: (sessionIds, lastSeenAt) => {
      for (const sessionId of sessionIds) {
        directoryState.storage.sql.exec("UPDATE session_route SET last_seen_at = ? WHERE session_id = ?", lastSeenAt, sessionId);
      }
    },
    directoryRequests: (path) => path ? directoryRequests.filter((entry) => entry.path === path) : [...directoryRequests],
    clearDirectoryRequests: () => { directoryRequests.length = 0; },
    close: () => {
      directoryState.close();
      for (const state of wooStates.values()) state.close();
      for (const state of commitStates.values()) state.close();
    }
  };
}

async function seedClosedChatroomOccupant(harness: CfSmokeHarness, runId: string): Promise<void> {
  const session = await LocalMcpSession.open(harness, `guest:cf-local-stale-${runId}`, "stale", runId);
  try {
    await session.call("the_chatroom", "enter", []);
  } finally {
    await session.close();
  }
}

async function seedDirectoryMcpAudience(
  harness: CfSmokeHarness,
  runId: string,
  options: { scope: ObjRef; sessions: number; uniqueShards: number }
): Promise<string[]> {
  // Seed Directory directly through the signed internal API so the harness can
  // model prod stale MCP rows without manufacturing full live Woo sessions.
  const shardCount = Math.min(options.uniqueShards, harness.shards);
  const safeRunId = runId.replace(/[^A-Za-z0-9_]/g, "_");
  const sessionIds: string[] = [];
  for (let i = 0; i < options.sessions; i += 1) {
    const shardIndex = i % shardCount;
    const sessionId = sessionIdForShard(`stale-prod-${runId}-${i}`, shardIndex, harness.shards);
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
      mcp_shard: mcpShardHost(sessionId, harness.shards),
      focus_list: [options.scope]
    });
  }
  return sessionIds;
}

async function registerDirectorySession(harness: CfSmokeHarness, payload: Record<string, unknown>): Promise<void> {
  const request = await signInternalRequest(harness.env, new Request("https://woo.internal/register-session", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  }));
  const response = await harness.env.DIRECTORY.get(harness.env.DIRECTORY.idFromName("directory")).fetch(request);
  expect(response.ok, await response.clone().text()).toBe(true);
}

async function openOnDifferentShard(harness: CfSmokeHarness, alice: LocalMcpSession, runId: string): Promise<LocalMcpSession> {
  const aliceShard = mcpShardHost(alice.sessionId, harness.shards);
  for (let i = 0; i < 16; i += 1) {
    const candidate = await LocalMcpSession.open(harness, `guest:cf-local-bob-${runId}-${i}`, "bob", runId);
    if (mcpShardHost(candidate.sessionId, harness.shards) !== aliceShard) return candidate;
    await candidate.close();
  }
  throw new Error(`could not find bob session on a different MCP shard than ${aliceShard}`);
}

async function runWalkthrough(alice: LocalMcpSession, bob: LocalMcpSession): Promise<void> {
  await step("enter:chatroom (alice)", async () => {
    await alice.call("the_chatroom", "enter", []);
  });
  await step("enter:chatroom (bob)", async () => {
    await bob.call("the_chatroom", "enter", []);
  });
  await drain(alice);
  await drain(bob);

  await step("chat:say reaches peer", async () => {
    const text = `walkthrough-say-${alice.runId}`;
    await alice.call("the_chatroom", "say", [text]);
    await waitFor(bob, (obs) => obs.type === "said" && typeof obs.text === "string" && obs.text.includes(text));
  });

  // B6 / CA14.3: two actors moving through the same destination concurrently
  // must both commit independently (each at its own actor-location authority,
  // off the room sequencer) and both retain membership — no lost destination
  // membership, no read_version_mismatch. The CI ratchet in this file already
  // fails on any read_version_mismatch; this step additionally proves both
  // memberships survive a concurrent enter by requiring bidirectional delivery.
  await step("B6: concurrent move through shared destination keeps both memberships", async () => {
    // Both start co-located in the_chatroom (prior steps). Move both out to the
    // shared the_deck concurrently, then back into the_chatroom concurrently.
    await Promise.all([
      alice.call("the_chatroom", "southeast", []),
      bob.call("the_chatroom", "southeast", [])
    ]);
    await drain(alice);
    await drain(bob);
    // Read into fresh locals so each assertion sees the full room-name union
    // (the getter would otherwise stay flow-narrowed across the awaits below).
    const aliceAfterOut: string | null = alice.currentRoom;
    const bobAfterOut: string | null = bob.currentRoom;
    if (aliceAfterOut !== "the_deck" || bobAfterOut !== "the_deck") {
      throw new Error(`expected both on the_deck after concurrent move; alice=${aliceAfterOut} bob=${bobAfterOut}`);
    }
    await Promise.all([
      alice.call("the_deck", "west", []),
      bob.call("the_deck", "west", [])
    ]);
    await drain(alice);
    await drain(bob);
    const aliceBack: string | null = alice.currentRoom;
    const bobBack: string | null = bob.currentRoom;
    if (aliceBack !== "the_chatroom" || bobBack !== "the_chatroom") {
      throw new Error(`expected both back in the_chatroom; alice=${aliceBack} bob=${bobBack}`);
    }
    // Membership is intact iff each actor's utterance reaches the other.
    const aliceText = `b6-concurrent-alice-${alice.runId}`;
    await alice.call("the_chatroom", "say", [aliceText]);
    await waitFor(bob, (obs) => obs.type === "said" && typeof obs.text === "string" && obs.text.includes(aliceText), 10_000);
    const bobText = `b6-concurrent-bob-${bob.runId}`;
    await bob.call("the_chatroom", "say", [bobText]);
    await waitFor(alice, (obs) => obs.type === "said" && typeof obs.text === "string" && obs.text.includes(bobText), 10_000);
  });

  await step("move:southeast emits `left` to bob (origin room)", async () => {
    await alice.call("the_chatroom", "southeast", []);
    await waitFor(bob, (obs) =>
      obs.type === "left" &&
      obs.actor === alice.actor &&
      obs.source === "the_chatroom" &&
      obs.destination === "the_deck" &&
      obs.exit === "southeast",
    10_000);
  });

  await step("move:west emits `entered` to bob (destination room)", async () => {
    await alice.call("the_deck", "west", []);
    await waitFor(bob, (obs) =>
      obs.type === "entered" &&
      obs.actor === alice.actor &&
      obs.source === "the_chatroom" &&
      obs.origin === "the_deck" &&
      obs.exit === "west",
    10_000);
  });

  // NOTE — take/drop is NOT yet exercised in this gated walkthrough, by design.
  // The prod MCP smoke (scripts/smoke-walkthrough.ts) carries a same-room take/drop
  // step (alice takes then drops the mug; bob sees `taken`/`dropped`). It is held
  // out HERE because this gate also asserts `dangling_parent_ref == 0`, and a
  // take/drop turn exposes a real gap in that family: the gateway-shard authority
  // slice ships actor/thing support lineage but NOT the `$portable` catalog-class
  // lineage of the item being acted on, so planning a `take` on a $portable object
  // emits dangling_parent_ref (the turn still completes via authority repair and the
  // cross-actor fanout is correct — only the zero-dangling guard fires). Add the
  // step here once $portable (and the other contents-object catalog classes) reach
  // the gateway-shard slice. Carrying an item ACROSS a room boundary is a further
  // step still: the carried object's cell authority is not migrated with the actor,
  // so the destination shard reports "not carrying" — the mobile-object-heap /
  // cross-scope contents-migration target.

  await step("pinboard:add_note reaches peer", async () => {
    await alice.call("the_chatroom", "southeast", []);
    await bob.call("the_chatroom", "southeast", []);
    await drain(alice);
    await drain(bob);
    try {
      await alice.call("the_deck", "enter", ["the_pinboard"]);
    } catch {
      // The canonical entry below is the real assertion; the deck command is
      // retained as an opportunistic route/manifest warm-up because prod smoke
      // has failed here when the deck scope held stale executable state.
    }
    await alice.call("the_pinboard", "enter", []);
    await bob.call("the_pinboard", "enter", []);
    await drain(alice);
    await drain(bob);
    const text = `pinboard-${alice.runId}`;
    await alice.call("the_pinboard", "add_note", [text, "yellow", 32, 32, 200, 120]);
    await waitFor(bob, (obs) =>
      obs.type === "note_added" &&
      isRecord(obs.note) &&
      typeof obs.note.text === "string" &&
      obs.note.text.includes(text),
    10_000);
  });

  await step("outliner:enter result includes a roster row for alice", async () => {
    await alice.leaveIfIn("the_pinboard");
    await bob.leaveIfIn("the_pinboard");
    if (alice.currentRoom === "the_deck") await alice.call("the_deck", "west", []);
    if (bob.currentRoom === "the_deck") await bob.call("the_deck", "west", []);
    await drain(alice);
    await drain(bob);
    const aliceEnter = await alice.call("the_outline", "enter", []);
    if (!isRecord(aliceEnter) || !Array.isArray(aliceEnter.roster)) {
      throw new Error(`expected roster array on the_outline:enter result; got ${JSON.stringify(aliceEnter).slice(0, 200)}`);
    }
    const ids = new Set(aliceEnter.roster.filter(isRecord).map((row) => String(row.id ?? "")));
    if (!ids.has(alice.actor)) {
      throw new Error(`alice not in her own enter roster; ids=${[...ids].join(",")} expected alice=${alice.actor}`);
    }
  });

  await step("outliner:add_item reaches peer", async () => {
    await bob.call("the_outline", "enter", []);
    await drain(alice);
    await drain(bob);
    const text = `outline-${alice.runId}`;
    await alice.call("the_outline", "add_item", [text]);
    await waitFor(bob, (obs) => obs.type === "outline_item_added" && obs.text === text, 10_000);
  });

  await step("tasks: cross-room `entered` reaches peer", async () => {
    await alice.leaveIfIn("the_outline");
    await bob.leaveIfIn("the_outline");
    if (alice.currentRoom === "the_chatroom") await alice.call("the_chatroom", "southeast", []);
    if (bob.currentRoom === "the_chatroom") await bob.call("the_chatroom", "southeast", []);
    await walkSouthToTaskboard(alice);
    await drain(alice);
    await drain(bob);
    await walkSouthToTaskboard(bob);
    await waitFor(alice, (obs) =>
      obs.type === "entered" &&
      obs.actor === bob.actor &&
      obs.source === "the_taskboard",
    10_000);
  });
}

async function walkSouthToTaskboard(session: LocalMcpSession): Promise<void> {
  if (session.currentRoom !== "the_deck") {
    throw new Error(`${session.label} expected on the_deck before south; at=${session.currentRoom}`);
  }
  await session.call("the_deck", "south", []);
  const afterFirstMove = session.currentRoom as string | null;
  if (afterFirstMove === "the_garden") await session.call("the_garden", "south", []);
  const afterSouthPath = session.currentRoom as string | null;
  if (afterSouthPath !== "the_taskboard") {
    throw new Error(`${session.label} expected on the_taskboard after south path; at=${session.currentRoom}`);
  }
}

async function step(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await raceWithTimeout(body(), STEP_TIMEOUT_MS, `step "${name}" exceeded ${STEP_TIMEOUT_MS}ms watchdog`);
  } catch (err) {
    throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function drain(session: LocalMcpSession): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < DRAIN_TOTAL_BUDGET_MS) {
    try {
      const result = await session.callTool("woo_wait", { timeout_ms: DRAIN_POLL_MS, limit: 100 });
      if (waitObservationsOf(result).length === 0) return;
    } catch {
      return;
    }
  }
}

async function waitFor(
  session: LocalMcpSession,
  match: (obs: Record<string, any>) => boolean,
  totalTimeoutMs = 5000
): Promise<Record<string, any>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < totalTimeoutMs) {
    const remaining = totalTimeoutMs - (Date.now() - startedAt);
    const result = await session.callTool("woo_wait", { timeout_ms: Math.min(remaining, 1000), limit: 100 });
    for (const obs of waitObservationsOf(result)) {
      if (isRecord(obs) && match(obs)) return obs;
    }
  }
  throw new Error(`timeout after ${totalTimeoutMs}ms waiting for matching observation`);
}

class LocalMcpSession {
  private nextId = 2;
  currentRoom: string | null = null;

  private constructor(
    private readonly harness: CfSmokeHarness,
    readonly sessionId: string,
    readonly actor: string,
    readonly label: string,
    readonly runId: string
  ) {}

  static async open(harness: CfSmokeHarness, token: string, label: string, runId: string): Promise<LocalMcpSession> {
    const response = await mcpFetch(harness, {
      method: "POST",
      headers: { "mcp-token": token },
      body: rpc(1, "initialize", initializeParams(`cf-local-smoke/${runId}/${label}`))
    });
    expect(response.ok, await response.clone().text()).toBe(true);
    const sessionId = response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await parseMcpResponse(response);

    const probing = new LocalMcpSession(harness, sessionId!, "", label, runId);
    const notified = await mcpFetch(harness, {
      method: "POST",
      headers: { "mcp-session-id": sessionId! },
      body: notification("notifications/initialized")
    });
    expect(notified.status).toBe(202);
    const tools = await probing.callTool("woo_list_reachable_tools", { scope: "all", limit: 200 });
    const list = tools?.result?.structuredContent?.result?.tools ?? [];
    const selfTool = list.find((tool: any) =>
      typeof tool?.object === "string" &&
      /^guest_/.test(tool.object) &&
      (tool.verb === "focus_list" || tool.verb === "focus" || tool.verb === "wait")
    );
    if (!selfTool || typeof selfTool.object !== "string") {
      throw new Error(`could not resolve actor for ${label} from tool list (saw ${list.length} tools)`);
    }
    return new LocalMcpSession(harness, sessionId!, selfTool.object, label, runId);
  }

  async call(object: string, verb: string, args: unknown[]): Promise<unknown> {
    const result = unwrap(await this.callTool("woo_call", { object, verb, args }));
    if (isRecord(result) && typeof result.room === "string") this.currentRoom = result.room;
    return result;
  }

  async leaveIfIn(space: string): Promise<boolean> {
    if (this.currentRoom !== space) return false;
    await this.call(space, "leave", []);
    return true;
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<any> {
    const response = await mcpFetch(this.harness, {
      method: "POST",
      headers: { "mcp-session-id": this.sessionId },
      body: rpc(this.nextId++, "tools/call", { name, arguments: params })
    });
    expect(response.ok, await response.clone().text()).toBe(true);
    const body = await parseMcpResponse(response);
    if (body && typeof body === "object" && "error" in body && body.error) {
      throw new Error(`tools/call ${name} JSON-RPC error: ${JSON.stringify(body.error)}`);
    }
    return body;
  }

  async close(): Promise<void> {
    await mcpFetch(this.harness, {
      method: "DELETE",
      headers: { "mcp-session-id": this.sessionId }
    }).catch(() => undefined);
  }
}

async function mcpFetch(
  harness: CfSmokeHarness,
  input: { method: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number }
): Promise<Response> {
  const headers = new Headers({ accept: "application/json, text/event-stream", ...input.headers });
  let body: BodyInit | undefined;
  if (input.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(input.body);
  }
  const timeoutMs = input.timeoutMs ?? RPC_TIMEOUT_MS;
  return await raceWithAbort(
    (signal) => harness.request("/mcp", { method: input.method, headers, body, signal }),
    timeoutMs,
    `MCP ${input.method} /mcp timed out after ${timeoutMs}ms`
  );
}

function raceWithTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (handle) clearTimeout(handle);
  });
}

function raceWithAbort<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, message: string): Promise<T> {
  const controller = new AbortController();
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      const error = new Error(message);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  return Promise.race([work(controller.signal), timeout]).finally(() => {
    if (handle) clearTimeout(handle);
  });
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

function unwrap(body: any): unknown {
  if (body?.result?.isError) {
    throw new Error(`MCP tool error: ${JSON.stringify(body.result.structuredContent ?? body.result, null, 2)}`);
  }
  return body?.result?.structuredContent?.result;
}

function waitObservationsOf(body: any): unknown[] {
  return body?.result?.structuredContent?.result?.observations ?? [];
}

function initializeParams(name: string): Record<string, unknown> {
  return {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name, version: "0.0.0" }
  };
}

function rpc(id: number, method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function notification(method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function metricsFromLogSpy(logSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return logSpy.mock.calls
    .filter((c) => c[0] === "woo.metric" && typeof c[1] === "string")
    .map((c) => { try { return JSON.parse(c[1] as string) as Record<string, unknown>; } catch { return null; } })
    .filter((m): m is Record<string, unknown> => m !== null);
}

async function delayFor(ms: number | undefined, signal?: AbortSignal): Promise<void> {
  if (!ms || ms <= 0) return;
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (handle) clearTimeout(handle);
      reject(abortReason(signal));
    };
    handle = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason instanceof Error ? signal.reason : new Error("aborted");
}

function sessionIdForShard(prefix: string, shardIndex: number, shards: number): string {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const candidate = `${prefix}-${attempt}`;
    if (mcpShardHost(candidate, shards) === `mcp-gateway-${shardIndex}`) return candidate;
  }
  throw new Error(`could not construct session id for mcp-gateway-${shardIndex}`);
}

function mcpShardHost(sessionId: string, shards = SHARDS): string {
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
