import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { CommitScopeDO } from "../../src/worker/commit-scope-do";
import { DirectoryDO } from "../../src/worker/directory-do";
import { PersistentObjectDO, mcpGatewayBundledScopeTopologyObjects, mcpGatewayScopeTopologySeed, type Env } from "../../src/worker/persistent-object-do";
import type { ObjRef } from "../../src/core/types";
import { FakeDurableObjectNamespace, FakeDurableObjectState } from "./fake-do";

// CA11.2 conformance harness (spec/protocol/cell-authority.md §CA11.2).
//
// These tests build a cold MCP gateway shard world for a `the_chatroom`
// session set and drive `the_chatroom:enter`, observing which object ids are
// partitioned to a cross-host `/__internal/authority-slice` RPC. The harness
// captures every authority-slice request body (its `objects` array) at the
// Worker DO boundary, the same way the production gateway forwards the RPC, so
// the test can assert ZERO cross-host fetch for the one-hop neighbor room
// `the_deck` after the topology pre-seed lands.
//
// STEP 0 of the implementation plan: this file FIRST confirmed the actual cold
// fetch mechanism before any code changed. See the describe block notes.

vi.setConfig({ testTimeout: 180_000 });

const SHARDS = 4;
const RPC_TIMEOUT_MS = 20_000;
const PROBE_ALL_RPC = process.env.PROBE_ALL_RPC === "1";

class FakeKVNamespace {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
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

// One captured cross-host authority-slice RPC: the host it was sent to and the
// object ids the gateway asked that host to reconstruct.
type AuthoritySliceCall = { host: string; objects: ObjRef[] };

type Harness = {
  env: Env;
  shards: number;
  request(path: string, init: RequestInit): Promise<Response>;
  drainWaitUntil(): Promise<void>;
  authoritySliceCalls(): AuthoritySliceCall[];
  clearAuthoritySliceCalls(): void;
  close(): void;
};

function createHarness(shards = SHARDS): Harness {
  const directoryState = new FakeDurableObjectState("directory");
  const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "topology-seed-secret" });
  const wooStates = new Map<string, WaitUntilDurableObjectState>();
  const wooObjects = new Map<string, PersistentObjectDO>();
  const commitStates = new Map<string, FakeDurableObjectState>();
  const commitObjects = new Map<string, CommitScopeDO>();
  const authoritySliceCalls: AuthoritySliceCall[] = [];
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
        // Capture cross-host authority-slice RPCs exactly at the DO boundary
        // the gateway forwards them to. `name` is the destination host key
        // (e.g. "world" for the room owner); the body's `objects` array is the
        // set the gateway could not resolve locally and partitioned to remote
        // fetch (persistent-object-do.ts byHost set).
        const path = new URL(request.url).pathname;
        if (path === "/__internal/authority-slice") {
          try {
            const parsed = await request.clone().json();
            const objects = Array.isArray((parsed as { objects?: unknown }).objects)
              ? ((parsed as { objects: unknown[] }).objects).filter((id): id is ObjRef => typeof id === "string" && id.length > 0)
              : [];
            authoritySliceCalls.push({ host: name, objects });
          } catch {
            authoritySliceCalls.push({ host: name, objects: [] });
          }
        }
        if (PROBE_ALL_RPC && (path.startsWith("/__internal/") || path.startsWith("/v2/"))) {
          let summary = "";
          try {
            const parsed = await request.clone().json();
            const obj = isRecord(parsed) ? parsed : {};
            const objects = Array.isArray((obj as { objects?: unknown }).objects) ? (obj as { objects: unknown[] }).objects : undefined;
            summary = objects ? `objects=${JSON.stringify(objects)}` : `scope=${String((obj as { scope?: unknown }).scope ?? "")}`;
          } catch { summary = ""; }
          // eslint-disable-next-line no-console
          console.error(`RPC -> host=${name} ${path} ${summary}`);
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
      object = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "topology-seed-secret" });
      commitObjects.set(name, object);
    }
    return object;
  });

  env = {
    WOO_INITIAL_WIZARD_TOKEN: "topology-seed-token",
    WOO_INTERNAL_SECRET: "topology-seed-secret",
    WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,note,blocks-demo",
    WOO_MCP_GATEWAY_SHARDS: String(shards),
    DIRECTORY: new FakeDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
      return { fetch: async (request: Request): Promise<Response> => await directory.fetch(request) };
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
    authoritySliceCalls: () => authoritySliceCalls.map((call) => ({ host: call.host, objects: [...call.objects] })),
    clearAuthoritySliceCalls: () => { authoritySliceCalls.length = 0; },
    close: () => {
      directoryState.close();
      for (const state of wooStates.values()) state.close();
      for (const state of commitStates.values()) state.close();
    }
  };
}

class McpSession {
  private nextId = 2;
  currentRoom: string | null = null;
  private constructor(
    private readonly harness: Harness,
    readonly sessionId: string,
    readonly actor: string
  ) {}

  static async open(harness: Harness, token: string, label: string): Promise<McpSession> {
    const response = await mcpFetch(harness, {
      method: "POST",
      headers: { "mcp-token": token },
      body: rpc(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: `topology-seed/${label}`, version: "0.0.0" }
      })
    });
    expect(response.ok, await response.clone().text()).toBe(true);
    const sessionId = response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await parseMcp(response);
    const probing = new McpSession(harness, sessionId!, "");
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
      (tool.verb === "focus_list" || tool.verb === "focus" || tool.verb === "wait"));
    if (!selfTool || typeof selfTool.object !== "string") {
      throw new Error(`could not resolve actor for ${label} (saw ${list.length} tools)`);
    }
    return new McpSession(harness, sessionId!, selfTool.object);
  }

  async call(object: string, verb: string, args: unknown[]): Promise<unknown> {
    const result = unwrap(await this.callTool("woo_call", { object, verb, args }));
    if (isRecord(result) && typeof result.room === "string") this.currentRoom = result.room;
    return result;
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<any> {
    const response = await mcpFetch(this.harness, {
      method: "POST",
      headers: { "mcp-session-id": this.sessionId },
      body: rpc(this.nextId++, "tools/call", { name, arguments: params })
    });
    expect(response.ok, await response.clone().text()).toBe(true);
    const body = await parseMcp(response);
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
  harness: Harness,
  input: { method: string; headers?: Record<string, string>; body?: unknown }
): Promise<Response> {
  const headers = new Headers({ accept: "application/json, text/event-stream", ...input.headers });
  let body: BodyInit | undefined;
  if (input.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(input.body);
  }
  return await raceWithTimeout(
    harness.request("/mcp", { method: input.method, headers, body }),
    RPC_TIMEOUT_MS,
    `MCP ${input.method} /mcp timed out after ${RPC_TIMEOUT_MS}ms`
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

async function parseMcp(response: Response): Promise<any> {
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

function rpc(id: number, method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function notification(method: string): Record<string, unknown> {
  return { jsonrpc: "2.0", method };
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Returns every authority-slice RPC whose requested-id set named `id`.
function callsRequesting(calls: AuthoritySliceCall[], id: ObjRef): AuthoritySliceCall[] {
  return calls.filter((call) => call.objects.includes(id));
}

type Metric = Record<string, unknown>;
type ConsoleCall = unknown[];

function consoleSpyCalls(spy: ReturnType<typeof vi.spyOn>): ConsoleCall[] {
  return spy.mock.calls as ConsoleCall[];
}

function metricsFromLogSpy(logSpy: ReturnType<typeof vi.spyOn>): Metric[] {
  return consoleSpyCalls(logSpy)
    .filter((c) => c[0] === "woo.metric" && typeof c[1] === "string")
    .map((c) => { try { return JSON.parse(c[1] as string) as Metric; } catch { return null; } })
    .filter((m): m is Metric => m !== null);
}

// Every object id the gateway partitioned to a remote owner host during the
// captured window. CA11.2 conformance #1: a served scope's one-hop neighbor
// (the_deck) must NEVER appear here on a cold turn — its lineage is resolved
// from the pre-seeded topology closure, not a cross-host fetch. This counts
// both real /__internal/authority-slice RPCs and commit-scope snapshot
// fallbacks (the cf-local in-process harness masks the wire RPC behind the
// fallback; the partition decision is the harness-independent signal).
function partitionedRemoteIds(metrics: Metric[], reasonFilter?: (reason: string) => boolean): Map<string, Set<string>> {
  const byHost = new Map<string, Set<string>>();
  for (const m of metrics) {
    if (m.kind !== "authority_slice_partition") continue;
    if (reasonFilter && !reasonFilter(String(m.reason ?? ""))) continue;
    const host = String(m.host ?? "");
    const set = byHost.get(host) ?? new Set<string>();
    for (const id of Array.isArray(m.objects) ? m.objects : []) {
      if (typeof id === "string") set.add(id);
    }
    byHost.set(host, set);
  }
  return byHost;
}

// Did any authority_slice_partition for `id` carry the given reason? CA11.2
// occupancy transition: a move INTO a pre-seeded neighbor repairs the destination
// to owner authority with reason `missing_state_repair`. That partition is the
// occupancy fetch the spec now permits (zero-fetch holds for cold READS, not the
// moment of occupancy).
function partitionedWithReason(metrics: Metric[], id: string, reason: string): boolean {
  for (const m of metrics) {
    if (m.kind !== "authority_slice_partition") continue;
    if (String(m.reason ?? "") !== reason) continue;
    if ((Array.isArray(m.objects) ? m.objects : []).includes(id)) return true;
  }
  return false;
}

describe("CA11.2 quasi-static topology pre-seeding", () => {
  // STEP 0 + conformance #1 (read path) + the occupancy transition.
  //
  // A move across an exit has TWO phases for the destination the_deck:
  //   (a) deterministic prefetch — the gateway can read the source room's
  //       declarative `exits[verb].dest` before the VM runs and fetch that
  //       destination from its owner as part of planning authority.
  //   (b) repair fallback — if a destination cannot be proven before the VM
  //       resolves it, the movement-boundary guard (CA11.2) raises
  //       E_NEED_STATE and the retry repairs the destination to owner authority.
  //
  // So: the move succeeds against owner authority for the entered scope. On MCP's
  // optimized path this should be a bounded owner-prefetch, not a sparse-planning
  // missing_state repair round.
  it("cold move across the_chatroom's exit prefetches deterministic destination owner authority", async () => {
    const harness = createHarness();
    let logSpy: ReturnType<typeof vi.spyOn> | null = null;
    let alice: McpSession | null = null;
    try {
      alice = await McpSession.open(harness, `guest:topology-seed-${randomUUID().slice(0, 8)}`, "alice");
      await alice.call("the_chatroom", "enter", []);
      await harness.drainWaitUntil();
      // Capture only the move turn's authority partitions.
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await alice.call("the_chatroom", "southeast", []);
      await harness.drainWaitUntil();
      const metrics = metricsFromLogSpy(logSpy);
      logSpy.mockRestore();
      logSpy = null;

      // The move must actually enter the_deck.
      expect(alice.currentRoom, "southeast from the_chatroom should arrive in the_deck").toBe("the_deck");

      const phaseTiming = metrics.find((m) =>
        m.kind === "turn_phase_timing" &&
        m.target === "the_chatroom" &&
        m.verb === "southeast"
      );
      const ownerPrefetchMs = typeof (phaseTiming?.ensure_detail_ms as Record<string, unknown> | undefined)?.["planning.owner_prefetch_authority"] === "number"
        ? (phaseTiming!.ensure_detail_ms as Record<string, number>)["planning.owner_prefetch_authority"]
        : null;
      const repairAttempts = metrics.filter((m) => m.kind === "turn_repair_attempt");

      // A generic cold READ refresh should not be the mechanism. If the_deck is
      // partitioned before commit, it must be the explicit deterministic
      // owner-prefetch path, and the turn must still converge in one attempt.
      const readPartitioned = partitionedRemoteIds(metrics, (reason) => reason !== "missing_state_repair");
      const readPartitionedIds = new Set<string>();
      for (const set of readPartitioned.values()) for (const id of set) readPartitionedIds.add(id);
      // `southeast` is inherited from $room. A sparse MCP relay must fetch that
      // definer from its real owner, not rely on a possibly stale/bytecode-free
      // support row cached on the gateway or carried as non-owner room support.
      const roomDefinerCalls = callsRequesting(harness.authoritySliceCalls(), "$room" as ObjRef);
      expect(roomDefinerCalls.some((call) => call.host === "world"), `inherited room command must owner-prefetch $room. Calls: ${
        JSON.stringify(roomDefinerCalls)
      }`).toBe(true);
      if (readPartitionedIds.has("the_deck")) {
        expect(ownerPrefetchMs, `the_deck was fetched before commit, so the turn must record bounded deterministic owner prefetch. ` +
          `Read-path partitioned ids: ${JSON.stringify(Array.from(readPartitioned, ([h, s]) => [h, Array.from(s)]))}`).not.toBeNull();
      }
      expect(phaseTiming, "the southeast move must emit turn_phase_timing").toMatchObject({
        attempts: 1,
        outcome: "submitted"
      });
      expect(repairAttempts, "deterministic southeast movement should not need sparse-planning repair").toEqual([]);
      expect(
        partitionedWithReason(metrics, "the_deck", "missing_state_repair"),
        "deterministic owner prefetch should make the old occupancy repair unnecessary"
      ).toBe(false);
    } finally {
      logSpy?.mockRestore();
      await alice?.close();
      harness.close();
    }
  });

  // CA11.2 occupancy-transition regression (conformance #4, behavioral form of
  // the B-shaped open-seed assertion). This is the failure the first naive
  // implementation hit: a seeded lineage-only the_deck (no `exits`) is correct
  // as a NEIGHBOR, but once the actor OCCUPIES the_deck it becomes a served
  // scope and a move OUT of it reads `the_deck.exits`. If the seeded row poisoned
  // the_deck's commit-scope open snapshot, the move west ("can't go that way")
  // would fail. The served-scope rule (the_deck excluded from local export + its
  // owner row force-fetched) means the occupant always sees the owner's full,
  // exits-bearing the_deck. So: enter the_chatroom -> move southeast INTO the_deck
  // -> move west BACK must all succeed.
  it("an actor that occupies a pre-seeded neighbor can move back out (owner row, not the lineage-only seed)", async () => {
    const harness = createHarness();
    let alice: McpSession | null = null;
    try {
      alice = await McpSession.open(harness, `guest:topology-seed-${randomUUID().slice(0, 8)}`, "alice");
      await alice.call("the_chatroom", "enter", []);
      await harness.drainWaitUntil();
      // Move INTO the seeded neighbor. the_deck is now the served/commit scope.
      await alice.call("the_chatroom", "southeast", []);
      await harness.drainWaitUntil();
      expect(alice.currentRoom, "southeast from the_chatroom should arrive in the_deck").toBe("the_deck");
      // Move OUT. This reads the_deck.exits — present only if the_deck resolved
      // to its owner's full row, NOT the exits-less lineage-only pre-seed.
      await alice.call("the_deck", "west", []);
      await harness.drainWaitUntil();
      expect(
        alice.currentRoom,
        "west from the_deck must succeed using the_deck's real exits (owner row), not a poisoned lineage-only seed"
      ).toBe("the_chatroom");
    } finally {
      await alice?.close();
      harness.close();
    }
  });
});

describe("CA11.2 topology closure shape (unit)", () => {
  it("computes a lineage-only one-hop closure with real owner hosts, generically and never global", () => {
    const closure = mcpGatewayBundledScopeTopologyObjects();
    // Served-scope candidates are discovered generically (any non-`$` instance
    // with a non-empty exits map), not from a hardcoded list, and the bundled
    // demoworld rooms are present.
    expect(closure.byScope.has("the_chatroom" as ObjRef)).toBe(true);
    for (const scope of closure.byScope.keys()) {
      expect(scope.startsWith("$"), `served-scope candidate ${scope} must be an instance, not a class`).toBe(false);
    }

    const chatroomClosure = closure.byScope.get("the_chatroom" as ObjRef) ?? [];
    const deck = chatroomClosure.find((row) => row.id === "the_deck");
    expect(deck, "the_chatroom's one-hop closure must include its exit destination the_deck").toBeTruthy();
    // Destination rooms are LINEAGE-ONLY: no exits/contents/verbs/property cells.
    // (Seeding the_deck.exits would make it a second-hop topology pull and would
    // also be the poison that breaks a move out of an occupied the_deck.)
    expect((deck!.properties ?? []).some(([k]) => k === "exits"), "the_deck must be seeded lineage-only (no exits cell)").toBe(false);
    expect(deck!.verbs.length, "the_deck must be seeded lineage-only (no verb bytecode)").toBe(0);
    expect(deck!.contents.length, "the_deck must be seeded lineage-only (no contents)").toBe(0);
    expect(deck!.parent, "the_deck lineage must keep its parent for the local parent-walk").toBeTruthy();
    // The real owner host is recorded for owner-deferring provenance source_host.
    expect(closure.ownerHostById.has("the_deck" as ObjRef), "the_deck's real owner host must be recorded").toBe(true);

    // The shared catalog-class chain reaches the lineage top so
    // localObjectLineageIsComplete(the_deck) resolves with no gap.
    const classIds = new Set(closure.classChain.map((row) => row.id));
    for (const cls of ["$chatroom", "$room", "$space"]) {
      expect(classIds.has(cls as ObjRef), `shared class chain must include ${cls}`).toBe(true);
    }
  });

  it("selects only the served scopes' closure, bounded — and emits the class chain only when a topology scope is served", () => {
    const served = mcpGatewayScopeTopologySeed(["the_chatroom" as ObjRef]);
    expect(served.seededIds.has("the_deck" as ObjRef), "serving the_chatroom seeds its neighbor the_deck").toBe(true);
    expect(served.seededIds.has("$chatroom" as ObjRef), "serving a topology scope seeds the shared class chain").toBe(true);
    // A non-topology scope seeds nothing (no global enumeration).
    const none = mcpGatewayScopeTopologySeed(["$nowhere" as ObjRef]);
    expect(none.objects.length, "a non-topology served scope must seed no rows").toBe(0);
  });
});
