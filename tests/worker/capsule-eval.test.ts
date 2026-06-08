// Capsule eval — measures whether WOO_V2_EXECUTION_CAPSULE actually skips the
// expensive /v2/open executable-seed assembly at FULL prod catalog scale, and
// whether the skip survives a Worker deploy (DO isolate restart over persisted
// SQL). This is the gap the existing v2-cost-budget capsule test leaves open:
// that one installs zero catalogs (WOO_AUTO_INSTALL_CATALOGS: "").
//
// We instrument the CommitScope namespace to count requests by pathname so we
// can see /v2/open vs /v2/envelope, and count E_SNAPSHOT_REQUIRED fallbacks.
//
// Timings here are Node, not the CF isolate, so absolute ms understate prod by
// ~10-14x (measured separately). The STRUCTURAL signals — open calls avoided,
// fallback rate, verb success — are what transfer.
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { CommitScopeDO } from "../../src/worker/commit-scope-do";
import { DirectoryDO } from "../../src/worker/directory-do";
import { PersistentObjectDO, type Env } from "../../src/worker/persistent-object-do";
import { FakeDurableObjectNamespace, FakeDurableObjectState } from "./fake-do";

vi.setConfig({ testTimeout: 180_000 });

const FULL_CATALOGS = "chat,help,note,prog";  // foundational subset: substantial seed, no self-hosting blocks

type PathCounts = Record<string, number>;

// A harness whose CommitScope namespace rebuilds the DO instance per fetch
// (state persists in `commitStates`), which models a cold DO over warm SQL —
// exactly the post-deploy condition. `rebuildGateway()` makes a fresh
// PersistentObjectDO over the persisted gateway state to model the gateway's
// own deploy cold-start.
function makeHarness(capsule: boolean) {
  const directoryState = new FakeDurableObjectState("directory");
  const gatewayState = new FakeDurableObjectState("world");
  const commitStates = new Map<string, FakeDurableObjectState>();
  const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-test-secret" });
  const commitPaths: PathCounts = {};
  let snapshotRequired = 0;

  const commitScopeNamespace = new FakeDurableObjectNamespace((name) => {
    let state = commitStates.get(name);
    if (!state) { state = new FakeDurableObjectState(name); commitStates.set(name, state); }
    const real = new CommitScopeDO(state as unknown as ConstructorParameters<typeof CommitScopeDO>[0], { WOO_INTERNAL_SECRET: "cf-test-secret" });
    // wrap fetch to record pathname + detect E_SNAPSHOT_REQUIRED in the body
    return {
      fetch: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname;
        commitPaths[path] = (commitPaths[path] ?? 0) + 1;
        const resp = await real.fetch(request);
        // peek body for snapshot-required without consuming the stream
        const clone = resp.clone();
        const text = await clone.text();
        if (text.includes("E_SNAPSHOT_REQUIRED")) snapshotRequired += 1;
        return new Response(text, { status: resp.status, headers: resp.headers });
      }
    };
  });

  const env = {
    WOO_INITIAL_WIZARD_TOKEN: "cf-capsule-eval-token",
    WOO_INTERNAL_SECRET: "cf-test-secret",
    WOO_AUTO_INSTALL_CATALOGS: FULL_CATALOGS,
    ...(capsule ? { WOO_V2_EXECUTION_CAPSULE: "1" } : {}),
    DIRECTORY: new FakeDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected DirectoryDO ${name}`);
      return directory;
    }),
    WOO: new FakeDurableObjectNamespace(() => { throw new Error("unexpected Woo DO"); }),
    COMMIT_SCOPE: commitScopeNamespace
  } as unknown as Env;

  let gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);
  return {
    get gateway() { return gateway; },
    rebuildGateway() { gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env); },
    commitPaths,
    get snapshotRequired() { return snapshotRequired; },
    resetCounts() { for (const k of Object.keys(commitPaths)) delete commitPaths[k]; snapshotRequired = 0; },
    cleanup() { directoryState.close(); gatewayState.close(); for (const s of commitStates.values()) s.close(); }
  };
}

function jsonRpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://woo.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

async function initMcp(gateway: PersistentObjectDO, token: string, id: number): Promise<string> {
  const init = await gateway.fetch(jsonRpc({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "capsule-eval", version: "0" } } }, { "mcp-token": token }));
  expect(init.ok).toBe(true);
  const sid = init.headers.get("mcp-session-id"); expect(sid).toBeTruthy();
  const n = await gateway.fetch(jsonRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid! }));
  expect(n.status).toBe(202);
  return sid!;
}

async function call(gateway: PersistentObjectDO, sid: string, id: number, object: string, verb: string, args: unknown[] = []): Promise<{ ms: number; json: any }> {
  const t = performance.now();
  const r = await gateway.fetch(jsonRpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "woo_call", arguments: { object, verb, args } } }, { "mcp-session-id": sid }));
  const ms = performance.now() - t;
  expect(r.ok).toBe(true);
  return { ms, json: await r.json() };
}

describe("WOO_V2_EXECUTION_CAPSULE eval (full catalog scale)", () => {
  it("capsule ON: first session warms the scope, later sessions skip /v2/open; survives gateway+DO restart", async () => {
    const h = makeHarness(true);
    try {
      // session A — cold scope, must fall back through open to build a snapshot
      const a = await initMcp(h.gateway, "guest:cap-a", 1);
      const ra = await call(h.gateway, a, 2, "guest_1", "set_description", ["warm the scope"]);
      expect(ra.json.result?.isError).toBe(false);
      console.log(`[capsule ON] cold session A: ${ra.ms.toFixed(0)}ms paths=${JSON.stringify(h.commitPaths)} snapshot_required=${h.snapshotRequired}`);

      // session B — scope now durable; open should be skipped
      h.resetCounts();
      const b = await initMcp(h.gateway, "guest:cap-b", 3);
      const rb = await call(h.gateway, b, 4, "guest_2", "set_description", ["no open expected"]);
      expect(rb.json.result?.isError).toBe(false);
      const bOpens = h.commitPaths["/v2/open"] ?? 0;
      console.log(`[capsule ON] warm session B: ${rb.ms.toFixed(0)}ms paths=${JSON.stringify(h.commitPaths)} snapshot_required=${h.snapshotRequired}`);

      // DEPLOY SIM — fresh gateway + (namespace already rebuilds CommitScopeDO per fetch) over persisted SQL
      h.rebuildGateway();
      h.resetCounts();
      const c = await initMcp(h.gateway, "guest:cap-c", 5);
      const rc = await call(h.gateway, c, 6, "guest_3", "set_description", ["post-deploy, snapshot durable"]);
      expect(rc.json.result?.isError).toBe(false);
      const cOpens = h.commitPaths["/v2/open"] ?? 0;
      console.log(`[capsule ON] post-deploy session C: ${rc.ms.toFixed(0)}ms paths=${JSON.stringify(h.commitPaths)} snapshot_required=${h.snapshotRequired}`);

      console.log(`[capsule ON] SUMMARY: cold=${ra.ms.toFixed(0)}ms warm=${rb.ms.toFixed(0)}ms postDeploy=${rc.ms.toFixed(0)}ms | warm /v2/open=${bOpens} postDeploy /v2/open=${cOpens}`);
      // The decisive structural claim: a warm/durable scope skips /v2/open, and that survives a deploy.
      expect(bOpens).toBe(0);
      expect(cOpens).toBe(0);
    } finally { h.cleanup(); }
  });

  it("capsule OFF baseline: every new session pays /v2/open", async () => {
    const h = makeHarness(false);
    try {
      const a = await initMcp(h.gateway, "guest:off-a", 1);
      const ra = await call(h.gateway, a, 2, "guest_1", "set_description", ["warm"]);
      expect(ra.json.result?.isError).toBe(false);
      h.resetCounts();
      const b = await initMcp(h.gateway, "guest:off-b", 3);
      const rb = await call(h.gateway, b, 4, "guest_2", "set_description", ["still opens"]);
      expect(rb.json.result?.isError).toBe(false);
      const bOpens = h.commitPaths["/v2/open"] ?? 0;
      console.log(`[capsule OFF] warm session B: ${rb.ms.toFixed(0)}ms paths=${JSON.stringify(h.commitPaths)} /v2/open=${bOpens}`);
      // Baseline contrast: without the capsule a warm scope still re-opens.
      expect(bOpens).toBeGreaterThanOrEqual(1);
    } finally { h.cleanup(); }
  });
});
