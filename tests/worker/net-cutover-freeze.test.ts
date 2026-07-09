// Cutover items B (export route) + C (write-freeze) over the whole v2
// worker in the fake-DO lane (notes/2026-07-08-net-cutover-tooling-plan.md).
//
// The §8 sequence this pins: flip WOO_WRITE_FREEZE → mutations and new
// sessions refuse with the named E_MAINTENANCE verdict while GET reads
// keep answering → the signed identity export STILL runs (internal
// traffic is exempt — "final identity-export from FROZEN old prod").
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { DirectoryDO } from "../../src/worker/directory-do";
import { PersistentObjectDO, type Env } from "../../src/worker/persistent-object-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { parseIdentityExport } from "../../src/net/identity";
import { FakeDurableObjectNamespace, FakeDurableObjectState } from "./fake-do";

const SECRET = "net-cutover-freeze-secret";

function buildHarness(vars: Record<string, string> = {}) {
  const states: FakeDurableObjectState[] = [];
  const directoryState = new FakeDurableObjectState("directory");
  states.push(directoryState);
  const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: SECRET });
  const wooObjects = new Map<string, PersistentObjectDO>();
  let env: Env;
  const wooNamespace = new FakeDurableObjectNamespace((name) => {
    let object = wooObjects.get(name);
    if (!object) {
      const state = new FakeDurableObjectState(name);
      states.push(state);
      object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
      wooObjects.set(name, object);
    }
    return object;
  });
  env = {
    WOO_INITIAL_WIZARD_TOKEN: "net-cutover-freeze-token",
    WOO_INTERNAL_SECRET: SECRET,
    ...vars,
    DIRECTORY: new FakeDurableObjectNamespace(() => directory),
    WOO: wooNamespace
  } as unknown as Env;
  return {
    env,
    request: async (path: string, init?: RequestInit) => worker.fetch(new Request(`https://woo.test${path}`, init), env, {} as never),
    signedRequest: async (path: string, init?: RequestInit) =>
      worker.fetch(await signInternalRequest({ WOO_INTERNAL_SECRET: SECRET }, new Request(`https://woo.test${path}`, init)), env, {} as never),
    close: () => states.forEach((state) => state.close())
  };
}

describe("cutover item B: the identity-export doorway", () => {
  it("a signed GET /net-install/identity-export returns the §8 export from the live world; unsigned is refused", async () => {
    const h = buildHarness();
    // A live session so the world has SOME identity-adjacent state.
    const auth = await h.request("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "guest:cutover-export" })
    });
    expect(auth.status, await auth.clone().text()).toBe(200);

    const unsigned = await h.request("/net-install/identity-export");
    expect(unsigned.status).toBe(401);

    const response = await h.signedRequest("/net-install/identity-export");
    expect(response.status, await response.clone().text()).toBe(200);
    const identity = parseIdentityExport(await response.json());
    expect(identity.kind).toBe("woo.identity_export.v1");
    expect(typeof identity.api_keys).toBe("object");
    h.close();
  });
});

describe("cutover item C: the write-freeze", () => {
  it("mutations and new sessions refuse E_MAINTENANCE; reads and the signed export continue", async () => {
    const h = buildHarness({ WOO_WRITE_FREEZE: "1" });

    // Identity ops refuse (a session mint is a write).
    const auth = await h.request("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "guest:cutover-frozen" })
    });
    expect(auth.status).toBe(503);
    expect(((await auth.json()) as { error: { code: string } }).error.code).toBe("E_MAINTENANCE");

    // MCP tool calls refuse (mutation-capable surface).
    const mcp = await h.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    expect(mcp.status).toBe(503);

    // The WS upgrade refuses even as a GET — it opens a mutation channel.
    const ws = await h.request("/v2/turn-network/ws");
    expect(ws.status).toBe(503);

    // GET reads keep answering (healthz is the canary the runbook probes).
    const health = await h.request("/healthz");
    expect(health.status).toBe(200);

    // THE §8 property: the signed export runs against the frozen world.
    const response = await h.signedRequest("/net-install/identity-export");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(parseIdentityExport(await response.json()).kind).toBe("woo.identity_export.v1");

    h.close();
  });

  it("without the flag, the same surfaces answer normally", async () => {
    const h = buildHarness();
    const auth = await h.request("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "guest:cutover-unfrozen" })
    });
    expect(auth.status, await auth.clone().text()).toBe(200);
    h.close();
  });
});
