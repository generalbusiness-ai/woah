// The /net-api/mcp response envelope (mcp.md §M1.2), fake-DO lane.
//
// THE DEFECT. Tool-level results on this endpoint were proper JSON-RPC, but
// transport- and auth-level refusals were not: they left through the
// gateway's generic client renderer as
//
//   HTTP 401 {"error":{"code":"E_NOSESSION","message":"apikey not found or
//             revoked","detail":{"reason":"unknown_or_revoked"}}}
//
// which is not a JSON-RPC message at all. A JSON-RPC request must be answered
// with a JSON-RPC response, and a client that validates the body against the
// MCP message schema gets a schema-validation failure instead of the woo
// diagnosis. See net-mcp-stdio-refusal.test.ts for what that cost an agent.
//
// Every assertion here is on the wire shape a client actually reads: the
// JSON-RPC envelope, the preserved HTTP status, and the woo code in
// `error.data`. The status half is load-bearing in its own right — Streamable
// HTTP permits an error body on a non-2xx response, and both the Origin
// contract (§M7.1) and the rate defence (H4) are written in terms of statuses.
import { describe, expect, it } from "vitest";
import { createWorld } from "../../src/core/bootstrap";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { closeQuiescent, quiescentNetState as netState, settleAll as settleHosts, type QuiescentHost } from "./quiescent-do";

const SECRET = "net-mcp-envelope-secret";

type Rpc = { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown };

/** The reply a JSON-RPC client is entitled to, unpacked for assertions. */
type Envelope = {
  status: number;
  headers: Headers;
  body: Record<string, any> | null;
};

/**
 * Assert one refusal is a well-formed JSON-RPC error with the woo code
 * preserved and the HTTP status untouched.
 *
 * `id` is `undefined` when the refusal could not know one (pre-parse, GET,
 * DELETE, notification): the member must then be ABSENT, not `null` — the
 * official MCP SDK's error-response schema declares `id` optional over
 * `string | number` and rejects `null` with a ~3 kB union report, which is
 * precisely the noise this envelope exists to eliminate.
 */
function expectJsonRpcRefusal(
  envelope: Envelope,
  expected: { status: number; wooCode: string; id?: number | string; message?: string | RegExp }
): void {
  const seen = JSON.stringify(envelope.body);
  expect(envelope.status, seen).toBe(expected.status);
  expect(envelope.body?.jsonrpc, seen).toBe("2.0");
  if (expected.id === undefined) expect(envelope.body, seen).not.toHaveProperty("id");
  else expect(envelope.body?.id, seen).toBe(expected.id);
  // -32000 is JSON-RPC's implementation-defined server-error slot; the woo
  // vocabulary lives in `error.data.code` where it stays machine-readable.
  expect(envelope.body?.error?.code, seen).toBe(-32000);
  expect(typeof envelope.body?.error?.message, seen).toBe("string");
  expect(envelope.body?.error?.data?.code, seen).toBe(expected.wooCode);
  expect(envelope.body?.error?.data?.http_status, seen).toBe(expected.status);
  if (expected.message instanceof RegExp) expect(envelope.body?.error?.message).toMatch(expected.message);
  else if (expected.message) expect(envelope.body?.error?.message).toBe(expected.message);
  // The message is what a client shows a human. JSON-RPC asks for one concise
  // sentence, and the pre-fix bridge behaviour proved the failure mode of a
  // long one.
  expect(String(envelope.body?.error?.message).length, seen).toBeLessThan(400);
}

async function fixture() {
  const old = createWorld();
  const alice = old.auth("guest:env-alice").actor;
  const bob = old.auth("guest:env-bob").actor;
  old.ensureApiKey("$wiz", alice, "env-key-a", "env-secret-a", "alice");
  old.ensureApiKey("$wiz", bob, "env-key-b", "env-secret-b", "bob");
  const identity = exportIdentity(old.exportWorld());
  const plan = await planNetInstall({
    graft: async (fresh) => { importIdentity(fresh, identity); }
  });

  const states: QuiescentHost[] = [];
  const scopeDOs = new Map<string, NetScopeDO>();
  let gateway: NetGatewayDO;
  const resolve = (destination: string) => {
    if (destination === "gateway:net-api") return gateway;
    if (destination.startsWith("scope:")) {
      const instance = scopeDOs.get(destination.slice("scope:".length));
      if (instance) return instance;
    }
    throw new Error(`unresolvable destination ${destination}`);
  };
  const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
  for (const [scope, cells] of plan.partitions) {
    const st = netState(`scope-${scope}`);
    const instance = new NetScopeDO(st.state, scopeEnv);
    const seeded = await instance.fetch(await signInternalRequest(scopeEnv, new Request("https://do/net/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, catalog_epoch: plan.epoch, cells, relations: plan.relations.get(scope) ?? [] })
    })));
    expect(seeded.ok, `seed ${scope}`).toBe(true);
    states.push(st);
    scopeDOs.set(scope, instance);
  }
  const gatewayState = netState("gateway-net-api");
  states.push(gatewayState);
  gateway = new NetGatewayDO(gatewayState.state, {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: resolve,
    NET_GATEWAY_SELF: "gateway:net-api"
  } as NetGatewayEnv);

  const settleAll = async () => {
    await settleHosts(states);
    for (const scope of scopeDOs.values()) await scope.alarm();
    await settleHosts(states);
  };

  const read = async (response: Response): Promise<Envelope> => {
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) as Record<string, any> : null
    };
  };
  const post = async (body: Rpc | string, headers: Record<string, string> = {}): Promise<Envelope> => await read(
    await gateway.fetch(new Request("https://do/net-api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }))
  );
  const request = async (method: string, headers: Record<string, string> = {}): Promise<Envelope> => await read(
    await gateway.fetch(new Request("https://do/net-api/mcp", { method, headers }))
  );
  const open = async (token: string): Promise<string> => {
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { "mcp-token": token });
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    const session = init.headers.get("mcp-session-id") as string;
    expect(session).toBeTruthy();
    return session;
  };

  const aliceSession = await open("apikey:env-key-a:env-secret-a");
  await settleAll();

  return {
    alice,
    bob,
    aliceSession,
    post,
    request,
    open,
    settleAll,
    close: async () => closeQuiescent(states)
  };
}

describe("MCP endpoint response envelope (M1.2)", () => {
  it("answers a bad apikey on initialize with a correlated JSON-RPC error and keeps the 401", async () => {
    const f = await fixture();
    try {
      // THE reproduced defect. The id is known here — initialize is a parsed
      // request — so the refusal correlates, and the woo message survives.
      const refused = await f.post(
        { jsonrpc: "2.0", id: 42, method: "initialize", params: {} },
        { "mcp-token": "apikey:env-key-a:wrong-secret" }
      );
      expectJsonRpcRefusal(refused, { status: 401, wooCode: "E_NOSESSION", id: 42 });
      expect(refused.body?.error?.message).toBe("apikey secret rejected");
      expect(refused.headers.get("mcp-session-id")).toBeNull();

      // An unknown key id — the exact refusal the deployed reproduction hit.
      const unknown = await f.post(
        { jsonrpc: "2.0", id: "init-2", method: "initialize", params: {} },
        { "mcp-token": "apikey:no-such-key:whatever" }
      );
      expectJsonRpcRefusal(unknown, { status: 401, wooCode: "E_NOSESSION", id: "init-2" });
      expect(unknown.body?.error?.message).toBe("apikey not found or revoked");
      expect(unknown.body?.error?.data?.detail?.reason).toBe("unknown_or_revoked");

      // A credential that is not an apikey at all.
      const wrongClass = await f.post(
        { jsonrpc: "2.0", id: 43, method: "initialize", params: {} },
        { "mcp-token": "" }
      );
      expectJsonRpcRefusal(wrongClass, { status: 401, wooCode: "E_NOSESSION", id: 43 });
    } finally {
      await f.close();
    }
  });

  it("answers a rejected session on tools/list and tools/call with the id and a 401", async () => {
    const f = await fixture();
    try {
      // No session header at all.
      const listed = await f.post({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
      expectJsonRpcRefusal(listed, { status: 401, wooCode: "E_NOSESSION", id: 7 });

      // A fabricated bearer.
      const forged = await f.post(
        { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "woo_wait", arguments: {} } },
        { "mcp-session-id": "s_not-a-real-session" }
      );
      expectJsonRpcRefusal(forged, { status: 401, wooCode: "E_NOSESSION", id: 8 });

      // A genuinely EXPIRED session cell, reached through a real lifecycle
      // rather than a hand-written cell: a close rewrites the session's expiry
      // to a short grace (the 250ms immediate-expiry rewrite the identity door
      // relies on), so waiting the grace out leaves `validateSessionCell`
      // returning "expired" on a bearer that authenticated a moment earlier.
      const doomed = await f.open("apikey:env-key-b:env-secret-b");
      await f.settleAll();
      expect((await f.request("DELETE", { "mcp-session-id": doomed })).status).toBe(204);
      await f.settleAll();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const afterExpiry = await f.post(
        { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} },
        { "mcp-session-id": doomed }
      );
      expectJsonRpcRefusal(afterExpiry, { status: 401, wooCode: "E_NOSESSION", id: 9 });
      expect(String(afterExpiry.body?.error?.message)).toMatch(/session expired/);
    } finally {
      await f.close();
    }
  });

  it("answers an exhausted rate bucket with a JSON-RPC error and keeps the 429", async () => {
    const f = await fixture();
    try {
      // A separate actor, so the bucket this drains is nobody else's.
      const session = await f.open("apikey:env-key-b:env-secret-b");
      await f.settleAll();
      let refusal: Envelope | null = null;
      for (let i = 0; i < 400 && !refusal; i += 1) {
        const response = await f.post(
          { jsonrpc: "2.0", id: 100 + i, method: "tools/list", params: {} },
          { "mcp-session-id": session }
        );
        if (response.status === 429) refusal = response;
      }
      expect(refusal, "the rate bucket never refused in 400 calls").not.toBeNull();
      expectJsonRpcRefusal(refusal as Envelope, {
        status: 429,
        wooCode: "E_RATE",
        id: (refusal as Envelope).body?.id
      });
      expect((refusal as Envelope).body?.error?.data?.detail?.reason).toBe("rate_limited");
    } finally {
      await f.close();
    }
  });

  it("answers a refused notification with an id-less JSON-RPC error, never 202", async () => {
    const f = await fixture();
    try {
      // A notification genuinely has no reply slot, so the error carries no
      // id — Streamable HTTP's stated shape for input the server cannot
      // accept. It must still NAME the refusal: a bare status left the stdio
      // bridge with nothing to report but a number.
      const refused = await f.post({ jsonrpc: "2.0", method: "notifications/initialized" });
      expectJsonRpcRefusal(refused, { status: 401, wooCode: "E_NOSESSION" });

      // An accepted notification is still 202 with an empty body.
      const accepted = await f.post(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { "mcp-session-id": f.aliceSession }
      );
      expect(accepted.status).toBe(202);
      expect(accepted.body).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("answers GET and DELETE refusals as JSON-RPC with their own statuses", async () => {
    const f = await fixture();
    try {
      // The notification carrier's wrong-Accept refusal.
      const wrongAccept = await f.request("GET", { "mcp-session-id": f.aliceSession, accept: "application/json" });
      expectJsonRpcRefusal(wrongAccept, { status: 406, wooCode: "E_INVARG" });

      // An unusable session on the carrier stays 404 — that is what tells a
      // client to establish a NEW session rather than retry this one.
      const deadCarrier = await f.request("GET", { accept: "text/event-stream", "mcp-session-id": "s_nope" });
      expectJsonRpcRefusal(deadCarrier, { status: 404, wooCode: "E_NOSESSION" });

      // DELETE of an unknown/missing session is idempotent success, not a
      // refusal — unchanged by this work.
      expect((await f.request("DELETE", { "mcp-session-id": "s_nope" })).status).toBe(204);
      expect((await f.request("DELETE")).status).toBe(204);
    } finally {
      await f.close();
    }
  });

  it("answers an unparseable body and an unknown method as JSON-RPC", async () => {
    const f = await fixture();
    try {
      // No id can be recovered from a body that is not a request, so the
      // member is absent and JSON-RPC's own parse-error code applies.
      const garbage = await f.post("this is not json");
      expect(garbage.status).toBe(400);
      expect(garbage.body?.jsonrpc).toBe("2.0");
      expect(garbage.body).not.toHaveProperty("id");
      expect(garbage.body?.error?.code).toBe(-32700);

      const notARequest = await f.post({ hello: "world" } as Rpc);
      expect(notARequest.status).toBe(400);
      expect(notARequest.body?.error?.code).toBe(-32700);

      // A known-shape request naming an unknown method keeps its id.
      const unknownMethod = await f.post(
        { jsonrpc: "2.0", id: 11, method: "resources/list", params: {} },
        { "mcp-session-id": f.aliceSession }
      );
      expect(unknownMethod.status).toBe(200);
      expect(unknownMethod.body?.id).toBe(11);
      expect(unknownMethod.body?.error?.code).toBe(-32601);
    } finally {
      await f.close();
    }
  });
});
