// Cross-host capsule eval — the piece the single-host eval could not cover.
// Full prod catalog set (demoworld rooms, blocks-demo) self-hosts objects on
// their own PersistentObjectDOs, so a real turn touching them does
// /__internal/authority-slice cross-host RPCs. The open question: does the
// execution capsule's narrow per-call authority slice carry enough state for a
// verb that touches a self-hosted object (e.g. entering a routed room), or does
// it E_SNAPSHOT_REQUIRED / under-seed?
//
// Discipline: the capsule-OFF baseline MUST succeed cross-host first. If it does
// not, the harness topology is wrong and the capsule-ON numbers mean nothing.
//
// Wiring combines two existing patterns: multi-host WOO + HOST_SEED_KV +
// waitUntil draining (cf-repository createHostSeedKvHarness) and a real
// COMMIT_SCOPE namespace (v2-cost-budget). Timings are Node, not the CF isolate.
import { describe, expect, it, vi } from "vitest";
import { CommitScopeDO } from "../../src/worker/commit-scope-do";
import { DirectoryDO } from "../../src/worker/directory-do";
import { PersistentObjectDO, type Env } from "../../src/worker/persistent-object-do";
import { FakeDurableObjectNamespace, FakeDurableObjectState } from "./fake-do";

vi.setConfig({ testTimeout: 240_000 });

const FULL_CATALOGS = "chat,demoworld,note,blocks-demo";

class FakeKVNamespace {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.values.set(key, value); }
}

class WaitUntilState extends FakeDurableObjectState {
  readonly waitUntilPromises: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>): void { this.waitUntilPromises.push(Promise.resolve(promise)); }
  async drainWaitUntil(): Promise<void> { await Promise.all(this.waitUntilPromises.splice(0)); }
}

function makeCrossHostHarness(capsule: boolean) {
  const kv = new FakeKVNamespace();
  const directoryState = new WaitUntilState("directory");
  const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
  const wooStates = new Map<string, WaitUntilState>();
  const wooObjects = new Map<string, PersistentObjectDO>();
  const commitStates = new Map<string, WaitUntilState>();
  const wooPaths: Record<string, number> = {};
  const commitPaths: Record<string, number> = {};
  let snapshotRequired = 0;
  let env: Env;

  const wooNamespace = new FakeDurableObjectNamespace((name) => {
    let object = wooObjects.get(name);
    if (!object) {
      const state = new WaitUntilState(name);
      wooStates.set(name, state);
      object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
      wooObjects.set(name, object);
    }
    return {
      fetch: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname;
        // count only cross-host internal calls (the gateway's own /mcp is direct, not via namespace)
        if (path.startsWith("/__internal/")) wooPaths[`${name}:${path}`] = (wooPaths[`${name}:${path}`] ?? 0) + 1;
        return await object!.fetch(request);
      }
    };
  });

  const commitScopeNamespace = new FakeDurableObjectNamespace((name) => {
    let state = commitStates.get(name);
    if (!state) { state = new WaitUntilState(name); commitStates.set(name, state); }
    const real = new CommitScopeDO(state as unknown as ConstructorParameters<typeof CommitScopeDO>[0], { WOO_INTERNAL_SECRET: "cf-test-secret" });
    return {
      fetch: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname;
        commitPaths[`${name}:${path}`] = (commitPaths[`${name}:${path}`] ?? 0) + 1;
        const resp = await real.fetch(request);
        const text = await resp.clone().text();
        if (text.includes("E_SNAPSHOT_REQUIRED")) snapshotRequired += 1;
        return new Response(text, { status: resp.status, headers: resp.headers });
      }
    };
  });

  env = {
    WOO_INITIAL_WIZARD_TOKEN: "cf-xhost-token",
    WOO_INTERNAL_SECRET: "cf-test-secret",
    WOO_AUTO_INSTALL_CATALOGS: FULL_CATALOGS,
    ...(capsule ? { WOO_V2_EXECUTION_CAPSULE: "1" } : {}),
    DIRECTORY: new FakeDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected DirectoryDO ${name}`);
      return directory;
    }),
    WOO: wooNamespace,
    COMMIT_SCOPE: commitScopeNamespace,
    HOST_SEED_KV: kv as unknown as KVNamespace
  } as unknown as Env;

  // The gateway IS the "world" host PersistentObjectDO.
  const gateway = () => {
    wooNamespace.get({ name: "world" });
    return wooObjects.get("world")!;
  };

  // Drain every host's waitUntil queue repeatedly until quiescent (cross-host
  // seeding/routing schedules async follow-up work).
  const drainAll = async (): Promise<void> => {
    for (let round = 0; round < 6; round++) {
      const states = [directoryState, ...wooStates.values(), ...commitStates.values()];
      const pending = states.filter((s) => s.waitUntilPromises.length > 0);
      if (pending.length === 0) break;
      for (const s of pending) await s.drainWaitUntil();
    }
  };

  return {
    gateway, drainAll,
    wooPaths, commitPaths,
    get snapshotRequired() { return snapshotRequired; },
    countOpens() { return Object.entries(commitPaths).filter(([k]) => k.endsWith(":/v2/open")).reduce((n, [, v]) => n + v, 0); },
    countAuthoritySlices() { return Object.entries(wooPaths).filter(([k]) => k.includes("/__internal/authority-slice")).reduce((n, [, v]) => n + v, 0); },
    resetCounts() { for (const k of Object.keys(commitPaths)) delete commitPaths[k]; for (const k of Object.keys(wooPaths)) delete wooPaths[k]; snapshotRequired = 0; },
    cleanup() { directoryState.close(); for (const s of wooStates.values()) s.close(); for (const s of commitStates.values()) s.close(); }
  };
}

function jsonRpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://woo.test/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function initMcp(gw: PersistentObjectDO, token: string, id: number, drain: () => Promise<void>): Promise<string> {
  const init = await gw.fetch(jsonRpc({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "xhost-eval", version: "0" } } }, { "mcp-token": token }));
  await drain();
  expect(init.ok).toBe(true);
  const sid = init.headers.get("mcp-session-id"); expect(sid).toBeTruthy();
  const n = await gw.fetch(jsonRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid! }));
  await drain();
  expect(n.status).toBe(202);
  return sid!;
}

async function callVerb(gw: PersistentObjectDO, sid: string, id: number, object: string, verb: string, args: unknown[], drain: () => Promise<void>): Promise<any> {
  const r = await gw.fetch(jsonRpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "woo_call", arguments: { object, verb, args } } }, { "mcp-session-id": sid }));
  await drain();
  expect(r.ok).toBe(true);
  return await r.json();
}

// Probe what a session can actually reach, so the eval targets a real cross-host verb.
async function listTools(gw: PersistentObjectDO, sid: string, id: number, drain: () => Promise<void>): Promise<string[]> {
  const r = await gw.fetch(jsonRpc({ jsonrpc: "2.0", id, method: "tools/list" }, { "mcp-session-id": sid }));
  await drain();
  const j = await r.json();
  return (j.result?.tools ?? []).map((t: any) => t.name);
}

describe("WOO_V2_EXECUTION_CAPSULE cross-host eval", () => {
  it("OFF baseline: a cross-host verb succeeds and exercises authority-slice RPCs", async () => {
    const h = makeCrossHostHarness(false);
    try {
      const gw = h.gateway();
      const sid = await initMcp(gw, "guest:xhost-off", 1, h.drainAll);
      const tools = await listTools(gw, sid, 2, h.drainAll);
      console.log("[OFF] reachable tools sample:", tools.slice(0, 25).join(", "));
      // enter the routed/self-hosted chatroom — the smoke's first cross-scope step
      const entered = await callVerb(gw, sid, 3, "the_chatroom", "enter", [], h.drainAll);
      console.log(`[OFF] enter the_chatroom isError=${entered.result?.isError} opens=${h.countOpens()} authoritySlices=${h.countAuthoritySlices()} snapshot_required=${h.snapshotRequired}`);
      console.log("[OFF] commitPaths:", JSON.stringify(h.commitPaths));
      console.log("[OFF] wooPaths:", JSON.stringify(h.wooPaths));
      // The gating assertion: baseline must actually work cross-host.
      expect(entered.result?.isError).toBe(false);
    } finally { h.cleanup(); }
  });

  it("ON: cross-host verb sweep succeeds via capsule on a warm scope; record opens + fallback rate", async () => {
    const h = makeCrossHostHarness(true);
    try {
      const gw = h.gateway();
      // warm the chatroom scope once with a first actor (builds a durable snapshot there)
      const warm = await initMcp(gw, "guest:xhost-warm", 1, h.drainAll);
      const w = await callVerb(gw, warm, 2, "the_chatroom", "enter", [], h.drainAll);
      console.log(`[ON] warming enter isError=${w.result?.isError} opens=${h.countOpens()} snapshot_required=${h.snapshotRequired}`);

      // A second actor in the now-warm room runs a sweep of cross-host verbs.
      // For each: assert success, and record whether the capsule had to fall
      // back through /v2/open (opens>0) or under-seeded (E_SNAPSHOT_REQUIRED).
      const sid = await initMcp(gw, "guest:xhost-on", 3, h.drainAll);
      await callVerb(gw, sid, 4, "the_chatroom", "enter", [], h.drainAll); // join the room first

      const sweep: Array<{ object: string; verb: string; args: unknown[] }> = [
        { object: "the_chatroom", verb: "say", args: ["hello from the capsule"] },
        { object: "guest_2", verb: "set_description", args: ["a capsule-seeded guest"] },
        { object: "guest_2", verb: "examine_detailed", args: ["the_chatroom"] },
        { object: "the_chatroom", verb: "southeast", args: [] }
      ];
      let id = 5;
      for (const step of sweep) {
        h.resetCounts();
        const r = await callVerb(gw, sid, id++, step.object, step.verb, step.args, h.drainAll);
        const isError = r.result?.isError;
        console.log(`[ON] ${step.object}:${step.verb} isError=${isError} opens=${h.countOpens()} authoritySlices=${h.countAuthoritySlices()} snapshot_required=${h.snapshotRequired} commitPaths=${JSON.stringify(h.commitPaths)}`);
        // Capsule must not under-seed a reachable cross-host verb.
        expect(isError, `${step.object}:${step.verb} should succeed via capsule`).toBe(false);
        // And it must not fall back to a full open on an already-warm scope.
        expect(h.snapshotRequired, `${step.object}:${step.verb} should not E_SNAPSHOT_REQUIRED on a warm scope`).toBe(0);
      }
    } finally { h.cleanup(); }
  });
});
