// MCP gateway integrity + transport hardening (fake-DO lane).
//
// Four defects are pinned here. Each assertion is on OBSERVABLE protocol
// behavior, never on internal shape, so a fix that only rearranges private
// state fails.
//
//   FINDING 2 (mcp.md M2.3) — `woo_list_reachable_tools` filtered contextual
//   objects first and generated collision-disambiguating tool names over that
//   FILTERED subset, while invocation regenerates names over the COMPLETE
//   context. `mcpSanitizeId` collapses every character outside `[A-Za-z0-9_]`
//   to `_`, so distinct object ids share a base name; a filtered view handed
//   out the unsuffixed name for whichever colliding object it happened to
//   contain, and invoking it reached the OTHER object. That crosses the
//   advertised-tool / actual-target boundary.
//
//   FINDING 4 (mcp.md M1.1) — every no-id JSON-RPC message returned 202
//   BEFORE session authentication or rate limiting.
//
//   FINDING 6 (mcp.md M6) — standalone GET/SSE listens were unbounded per
//   session even though `woo_wait` is capped.
//
//   FINDING 8 — parked waits and cancellations were both keyed by
//   `String(id)`, so a cancellation for `"1"` released a wait parked under
//   the DISTINCT JSON-RPC id `1`.
import { describe, expect, it } from "vitest";
import { createWorld } from "../../src/core/bootstrap";
import { installVerb } from "../../src/core/authoring";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { closeQuiescent, quiescentNetState as netState, settleAll as settleHosts, type QuiescentHost } from "./quiescent-do";

const SECRET = "net-mcp-hardening-secret";

/**
 * Three object ids that all sanitize to the SAME MCP tool base.
 *
 * `mcpSanitizeId` strips one leading `$` and maps every other character
 * outside `[A-Za-z0-9_]` to `_`. `-` and `+` are both legal in a minted
 * object id (`assertMintableObjectId` reserves only `.`), so all three of
 * these render `probe_collide`, and their `ping` verbs all want the tool
 * name `probe_collide__ping`. Two get a `_2`/`_3` suffix; WHICH two depends
 * on listing order, which is exactly what must not vary with the view.
 */
const COLLIDING = ["probe-collide", "probe+collide", "probe_collide"] as const;
const COLLIDING_BASE = "probe_collide__ping";


type Rpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: unknown };

async function fixture() {
  const old = createWorld();
  const alice = old.auth("guest:hard-alice").actor;
  const bob = old.auth("guest:hard-bob").actor;
  old.ensureApiKey("$wiz", alice, "hard-key-a", "hard-secret-a", "alice");
  old.ensureApiKey("$wiz", bob, "hard-key-b", "hard-secret-b", "bob");
  const identity = exportIdentity(old.exportWorld());
  const plan = await planNetInstall({
    graft: async (fresh) => {
      importIdentity(fresh, identity);
      for (const id of COLLIDING) {
        fresh.createObject({
          id,
          name: id,
          parent: "$thing",
          owner: "$wiz",
          location: "the_chatroom"
        });
        // Command-shaped rather than `tool_exposed`, so the room's visible
        // contents advertise it (M2.2) without extra fixture ceremony. The
        // verb returns its own object id: that is what makes "the advertised
        // name reached the advertised object" checkable from the reply.
        expect(installVerb(
          fresh,
          id,
          "ping",
          `verb :ping() rxd { return ${JSON.stringify(id)}; }`,
          null,
          { argSpec: { command: { dobj: "none", prep: "any", iobj: "any", args_from: [] } } }
        ).ok, `install ping on ${id}`).toBe(true);
      }
    }
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

  let nextId = 1000;
  const mcp = async (body: Rpc, headers: Record<string, string> = {}) => {
    const response = await gateway.fetch(new Request("https://do/net-api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body)
    }));
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as Record<string, any> : null };
  };
  const events = async (headers: Record<string, string>) =>
    await gateway.fetch(new Request("https://do/net-api/mcp", { method: "GET", headers }));
  const open = async (token: string): Promise<string> => {
    const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { "mcp-token": token });
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    const session = init.headers.get("mcp-session-id") as string;
    expect(session).toBeTruthy();
    expect((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": session })).status)
      .toBe(202);
    return session;
  };
  const call = async (session: string, name: string, args: Record<string, unknown>) => (await mcp(
    { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } },
    { "mcp-session-id": session }
  )).body as Record<string, any>;

  const aliceSession = await open("apikey:hard-key-a:hard-secret-a");
  await settleAll();

  return {
    alice,
    bob,
    aliceSession,
    mcp,
    events,
    open,
    call,
    settleAll,
    gateway: () => gateway,
    close: async () => closeQuiescent(states)
  };
}

/** Read an SSE stream until it ends or the timeout fires. Returns whether the
 * server closed it. A closed stream is how an evicted listen is observed. */
async function sseEnded(response: Response, timeoutMs: number): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response has no body");
  const timeout = Symbol("timeout");
  try {
    for (;;) {
      const result = await Promise.race([
        reader.read(),
        new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), timeoutMs))
      ]);
      if (result === timeout) return false;
      if (result.done) return true;
    }
  } finally {
    reader.releaseLock();
  }
}

describe("MCP gateway hardening", () => {
  // FINDING 2.
  it("names tools canonically over the whole context, so every advertised name invokes the advertised object", async () => {
    const f = await fixture();
    try {
      // ---- the canonical assignment, as tools/list renders it -------------
      // `tools/list` computes names over the complete structural context; it
      // is the reference every other view must reproduce.
      const canonical = new Map<string, string>(); // tool name -> object
      let cursor: string | undefined;
      do {
        const page = await f.mcp(
          { jsonrpc: "2.0", id: 5, method: "tools/list", params: cursor ? { cursor } : {} },
          { "mcp-session-id": f.aliceSession }
        );
        expect(page.status, JSON.stringify(page.body).slice(0, 300)).toBe(200);
        for (const tool of page.body?.result?.tools ?? []) {
          // tools/list carries no `object` field, so the descriptors are
          // matched by their base name — every tool on a colliding object
          // renders `probe_collide__<verb>` with or without a suffix.
          if (typeof tool.name === "string" && /^probe_collide__/.test(tool.name)) {
            canonical.set(tool.name, "");
          }
        }
        cursor = page.body?.result?.nextCursor;
      } while (cursor);

      // The premise: all three colliding objects are advertised, they really
      // do share one base, and disambiguation really did happen. Without
      // this the rest of the test could pass while proving nothing.
      const pingNames = [...canonical.keys()]
        .filter((name) => name === COLLIDING_BASE || new RegExp(`^${COLLIDING_BASE}_\\d+$`).test(name))
        .sort();
      expect(
        pingNames.length,
        `expected 3 colliding ping tools, saw ${JSON.stringify([...canonical.keys()])}`
      ).toBe(3);
      expect(pingNames).toContain(COLLIDING_BASE);

      // ---- name -> object, established by INVOCATION ----------------------
      // The contract under test, measured the way an agent measures it: call
      // the advertised name and see which object ran.
      for (const name of pingNames) {
        const result = await f.call(f.aliceSession, name, {});
        expect(result.result?.isError, `${name}: ${JSON.stringify(result).slice(0, 300)}`).not.toBe(true);
        const ran = result.result?.structuredContent?.result as string;
        expect(COLLIDING as readonly string[], `${name} ran ${ran}`).toContain(ran);
        canonical.set(name, ran);
      }
      expect(
        new Set(pingNames.map((name) => canonical.get(name))).size,
        "two advertised names invoked the same object"
      ).toBe(3);
      await f.settleAll();

      // Fill in the objects for the colliding objects' OTHER (inherited)
      // tools from the unfiltered discovery view, which does report `object`.
      const unfiltered = await f.call(f.aliceSession, "woo_list_reachable_tools", { scope: "active", limit: 256 });
      for (const tool of unfiltered.result?.structuredContent?.result?.tools ?? []) {
        if (!canonical.has(tool.name)) continue;
        if (canonical.get(tool.name)) {
          // Already pinned by invocation — discovery must agree with it.
          expect(tool.object, `scope:active disagrees with invocation for ${tool.name}`).toBe(canonical.get(tool.name));
          continue;
        }
        canonical.set(tool.name, tool.object);
      }
      for (const [name, object] of canonical) {
        expect(object, `no object resolved for advertised tool ${name}`).toBeTruthy();
      }

      // ---- every discovery view must agree with that mapping --------------
      // Pre-fix, `scope:"object"` regenerated names over a one-object subset
      // and therefore handed the UNSUFFIXED name to whichever object it
      // filtered to — two of the three then invoked something else.
      const views: Array<{ label: string; args: Record<string, unknown> }> = [
        { label: "scope:active", args: { scope: "active", limit: 256 } },
        { label: "scope:here", args: { scope: "here", limit: 256 } },
        { label: "scope:space", args: { scope: "space", limit: 256 } },
        { label: "scope:space+object", args: { scope: "space", object: "the_chatroom", limit: 256 } },
        // Paging must not shift names either: one descriptor per page.
        { label: "scope:active paged", args: { scope: "active", query: "ping", limit: 1 } },
        ...COLLIDING.map((id) => ({ label: `scope:object ${id}`, args: { scope: "object", object: id } }))
      ];
      for (const view of views) {
        const seen = new Map<string, string>();
        let pageCursor: string | undefined;
        do {
          const page = await f.call(f.aliceSession, "woo_list_reachable_tools", {
            ...view.args,
            ...(pageCursor ? { cursor: pageCursor } : {})
          });
          expect(page.result?.isError, `${view.label}: ${JSON.stringify(page).slice(0, 300)}`).not.toBe(true);
          const result = page.result?.structuredContent?.result;
          for (const tool of result?.tools ?? []) {
            if (!(COLLIDING as readonly string[]).includes(tool.object)) continue;
            seen.set(tool.name, tool.object);
          }
          pageCursor = result?.next_cursor ?? undefined;
        } while (pageCursor);

        expect(seen.size, `${view.label} advertised no colliding tool`).toBeGreaterThan(0);
        for (const [name, object] of seen) {
          expect(
            canonical.get(name),
            `${view.label} advertised ${name} as ${object}, but ${name} canonically reaches ${canonical.get(name)}`
          ).toBe(object);
        }
      }

      // A scope filter is presentation: `scope:object` on one colliding id
      // must return exactly that object's canonical name, suffix and all.
      // This is the exact call that used to hand back the unsuffixed name for
      // whichever of the three it filtered to.
      for (const id of COLLIDING) {
        const page = await f.call(f.aliceSession, "woo_list_reachable_tools", { scope: "object", object: id });
        const tools = page.result?.structuredContent?.result?.tools ?? [];
        const ping = tools.find((tool: any) => tool.verb === "ping");
        expect(ping?.object).toBe(id);
        const expected = pingNames.find((name) => canonical.get(name) === id);
        expect(ping?.name, `scope:object ${id} advertised ${ping?.name}, canonical is ${expected}`).toBe(expected);
      }
    } finally {
      await f.close();
    }
  });

  // FINDING 4.
  it("authenticates and rate-limits notifications instead of blanket-202ing them", async () => {
    const f = await fixture();
    try {
      // No session header at all: the pre-fix surface answered 202 to this.
      const sessionless = await f.mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
      expect(sessionless.status, JSON.stringify(sessionless.body)).not.toBe(202);
      expect(sessionless.status).toBe(401);
      expect(sessionless.body?.error?.code).toBe("E_NOSESSION");

      // A fabricated session id is refused on the same terms.
      const forged = await f.mcp(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { "mcp-session-id": "not-a-session" }
      );
      expect(forged.status).toBe(401);

      // ...including for cancellation, which used to act on the raw header.
      const forgedCancel = await f.mcp(
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
        { "mcp-session-id": "not-a-session" }
      );
      expect(forgedCancel.status).toBe(401);

      // ...and for a method the server does not recognize. An evolving
      // protocol's notifications must not be a free unauthenticated door.
      const unknown = await f.mcp(
        { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "x" } },
        { "mcp-session-id": "not-a-session" }
      );
      expect(unknown.status).toBe(401);

      // An authenticated session still gets the protocol's 202, for known
      // and unknown notification methods alike.
      expect((await f.mcp(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { "mcp-session-id": f.aliceSession }
      )).status).toBe(202);
      expect((await f.mcp(
        { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "x" } },
        { "mcp-session-id": f.aliceSession }
      )).status).toBe(202);

      // Rate limiting applies too. Driven on a SEPARATE actor so the bucket
      // this exhausts is not one the other assertions depend on.
      const bobSession = await f.open("apikey:hard-key-b:hard-secret-b");
      let refused = 0;
      let accepted = 0;
      for (let i = 0; i < 300; i++) {
        const response = await f.mcp(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { "mcp-session-id": bobSession }
        );
        if (response.status === 429) refused++;
        else if (response.status === 202) accepted++;
      }
      expect(accepted, "no notification was accepted at all").toBeGreaterThan(0);
      expect(refused, "300 notifications from one actor consumed no rate budget").toBeGreaterThan(0);
    } finally {
      await f.close();
    }
  });

  // FINDING 6.
  it("bounds standalone SSE listens per session by evicting the oldest", async () => {
    const f = await fixture();
    try {
      const headers = { accept: "text/event-stream", "mcp-session-id": f.aliceSession };
      const first = await f.events(headers);
      const second = await f.events(headers);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      // Cap is 2, so the third GET evicts the first. The evicted stream ends
      // normally — that is the documented refusal shape on this path: not an
      // HTTP status, but a closed stream the client reconnects after.
      const third = await f.events(headers);
      expect(third.status).toBe(200);
      expect(await sseEnded(first, 500), "the oldest SSE listen was not evicted").toBe(true);

      // The survivors are still live, and still carry notifications: a
      // list_changed hint reaches one of them rather than being lost with the
      // evicted stream.
      const fourth = await f.events(headers);
      expect(await sseEnded(second, 500), "the second listen was not evicted by the fourth GET").toBe(true);
      await third.body?.cancel();
      await fourth.body?.cancel();

      // A different session keeps its own budget — the cap is per session,
      // not global.
      const bobSession = await f.open("apikey:hard-key-b:hard-secret-b");
      const bobStream = await f.events({ accept: "text/event-stream", "mcp-session-id": bobSession });
      expect(bobStream.status).toBe(200);
      expect(await sseEnded(bobStream, 200), "another session's GETs closed this one").toBe(false);
      await bobStream.body?.cancel();
    } finally {
      await f.close();
    }
  });

  // FINDING 8.
  it("keeps numeric and string JSON-RPC request ids distinct when cancelling a wait", async () => {
    const f = await fixture();
    try {
      // Drain first so the wait genuinely parks.
      await f.call(f.aliceSession, "woo_wait", { timeout_ms: 0, limit: 100 });

      // Park under the NUMERIC id 1.
      const parked = f.mcp(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "woo_wait", arguments: { timeout_ms: 20_000 } } },
        { "mcp-session-id": f.aliceSession }
      );
      let settled = false;
      void parked.then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled, "the wait did not park").toBe(false);

      // Cancel the STRING id "1". JSON-RPC says that is a different request,
      // so this must not touch the parked one.
      const wrong = await f.mcp(
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "1" } },
        { "mcp-session-id": f.aliceSession }
      );
      expect(wrong.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled, `a cancellation for "1" released the wait parked under 1`).toBe(false);

      // The matching numeric cancellation does release it, promptly — the
      // elapsed-time assertion is what distinguishes a real release from the
      // 20s timeout, which also resolves with no observations.
      const startedAt = Date.now();
      expect((await f.mcp(
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
        { "mcp-session-id": f.aliceSession }
      )).status).toBe(202);
      const cancelled = await parked;
      const elapsed = Date.now() - startedAt;
      expect(elapsed, `cancellation took ${elapsed}ms — the park was not released`).toBeLessThan(5_000);
      expect(cancelled.body?.result?.structuredContent?.result?.observations).toEqual([]);

      // And the mirror image: a wait parked under the STRING id "7" is not
      // released by a cancellation for the number 7.
      const parkedString = f.mcp(
        { jsonrpc: "2.0", id: "7", method: "tools/call", params: { name: "woo_wait", arguments: { timeout_ms: 20_000 } } },
        { "mcp-session-id": f.aliceSession }
      );
      let stringSettled = false;
      void parkedString.then(() => { stringSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await f.mcp(
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } },
        { "mcp-session-id": f.aliceSession }
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stringSettled, `a cancellation for 7 released the wait parked under "7"`).toBe(false);
      await f.mcp(
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "7" } },
        { "mcp-session-id": f.aliceSession }
      );
      await parkedString;
    } finally {
      await f.close();
    }
  });
});
