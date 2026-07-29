// Phase C of the programmer-environment remediation plan: prove the
// feature-composed programmer surface over the real Net MCP resolver
// (fake-DO lane). A provisioned $agent that carries $programmer as a feature
// must (1) keep its $agent kind, (2) have its authoring verbs advertised as
// dynamic Net tools, (3) create/install/invoke through the authoritative turn
// path, and (4) leave no authoring tools exposed on a non-programmer agent —
// the surface, not the flag, gates the tool set. The resolver walks the
// object's feature chain (gateway-do.ts mcpObjectToolDrafts), so this exercises
// the same reachability decision production uses.
//
// Steps (5)-(11) close create -> install -> INVOKE: the agent writes a verb on
// an object it just made and then calls it as an ordinary MCP tool. Two
// independent gates stand between "the verb is in the database" and "an agent
// can call it", and the test asserts both:
//   PLACEMENT  — the object must be in structural context. `create` defaults
//                its location to the author's inventory (§6.4).
//   EXPOSURE   — self and inventory advertise only tool_exposed verbs, so the
//                author must opt in through `set_verb_info`.
// Between them the session receives a real tools/list_changed on its SSE
// stream, so the agent learns about its own new tool without polling.
import { describe, expect, it } from "vitest";
import { createWorld } from "../../src/core/bootstrap";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { closeQuiescent, quiescentNetState as netState, settleAll as settleHosts, type QuiescentHost } from "./quiescent-do";

const SECRET = "net-mcp-programmer-secret";


type Rpc = { jsonrpc: "2.0"; id?: number; method: string; params?: unknown };

/** Read one JSON-RPC message off an open MCP SSE stream, or null on timeout.
 * Mirrors tests/worker/net-demote-lifecycle.test.ts — the only way to prove a
 * real `notifications/tools/list_changed` was pushed rather than inferred from
 * a later poll. */
async function nextSseMessage(response: Response, timeoutMs = 1_000): Promise<Record<string, unknown> | null> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response has no body");
  const decoder = new TextDecoder();
  let buffered = "";
  const timeout = Symbol("timeout");
  try {
    for (;;) {
      const result = await Promise.race([
        reader.read(),
        new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), timeoutMs))
      ]);
      if (result === timeout) { await reader.cancel(); return null; }
      if (result.done) return null;
      buffered += decoder.decode(result.value, { stream: true });
      const events = buffered.split(/\r?\n\r?\n/);
      buffered = events.pop() ?? "";
      for (const event of events) {
        const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice("data:".length).trimStart()).join("\n");
        if (data) return JSON.parse(data) as Record<string, unknown>;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

describe("Net MCP programmer surface (fake-DO lane)", () => {
  it("exposes a feature-composed agent's authoring tools over Net MCP and authors through the turn path", async () => {
    // Two $wiz-owned $agents with apikeys, one with the programmer surface
    // composed on. Real $agent auth exercises the owner-chain eligibility check
    // (owner read from object_lineage). The create_agent provisioning path is
    // covered in tests/programmer-surface.test.ts. The identity export now
    // carries the `features` surface, so the agent arrives feature-composed.
    const progAgent = "prog_agent";
    const plainAgent = "plain_agent";
    const old = createWorld();
    old.createObject({ id: progAgent, parent: "$agent", owner: "$wiz", name: "ProgBot" });
    old.createObject({ id: plainAgent, parent: "$agent", owner: "$wiz", name: "PlainBot" });
    old.ensureApiKey("$wiz", progAgent, "prog-key", "prog-secret", "prog");
    old.ensureApiKey("$wiz", plainAgent, "plain-key", "plain-secret", "plain");
    old.setObjectFlags("$wiz", progAgent, { programmer: true }); // flag + surface

    // §8.1: kind stays $agent; the surface is composed as a feature, never by
    // reparenting.
    expect(old.isDescendantOf(progAgent, "$agent")).toBe(true);
    expect(old.isDescendantOf(progAgent, "$programmer")).toBe(false);
    expect(old.actorHasSurface(progAgent, "$programmer")).toBe(true);
    expect(old.actorHasSurface(plainAgent, "$programmer")).toBe(false);

    const identity = exportIdentity(old.exportWorld());
    const plan = await planNetInstall({ graft: async (fresh) => { importIdentity(fresh, identity); } });
    const progToken = "apikey:prog-key:prog-secret";
    const plainToken = "apikey:plain-key:plain-secret";

    // --- wire the Net DOs (fake-DO lane) ---
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
      const request = new Request("https://do/net/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, catalog_epoch: plan.epoch, cells, relations: plan.relations.get(scope) ?? [] })
      });
      const seeded = await instance.fetch(await signInternalRequest(scopeEnv, request));
      expect(seeded.ok, `seed ${scope}`).toBe(true);
      states.push(st);
      scopeDOs.set(scope, instance);
    }
    const gatewayState = netState("gateway-net-api");
    states.push(gatewayState);
    gateway = new NetGatewayDO(gatewayState.state, { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve, NET_GATEWAY_SELF: "gateway:net-api" } as NetGatewayEnv);

    const settleAll = async () => {
      await settleHosts(states);
      for (const scope of scopeDOs.values()) await scope.alarm();
      await settleHosts(states);
    };

    let nextId = 10;
    const mcp = async (body: Rpc, headers: Record<string, string> = {}) => {
      const response = await gateway.fetch(new Request("https://do/net-api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body)
      }));
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as Record<string, any> : null };
    };
    const open = async (token: string): Promise<string> => {
      const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { "mcp-token": token });
      expect(init.status, JSON.stringify(init.body)).toBe(200);
      const session = init.headers.get("mcp-session-id");
      expect(session).toBeTruthy();
      await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": session as string });
      return session as string;
    };
    const call = async (session: string, name: string, args: Record<string, unknown>) =>
      (await mcp({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": session })).body as Record<string, any>;
    const listNames = async (session: string): Promise<string[]> => {
      const listed = await mcp({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }, { "mcp-session-id": session });
      return (listed.body?.result?.tools ?? []).map((t: any) => t.name);
    };
    // Headless SSE open: no Origin, which mcp.md §M7.1 admits. Origin
    // admission is exercised through the real Worker entry in
    // tests/worker/net-mcp-origin.test.ts — a direct DO fetch cannot see it.
    const listen = async (session: string) => gateway.fetch(new Request("https://do/net-api/mcp", {
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-session-id": session }
    }));

    const progSession = await open(progToken);
    const sanitize = (id: string) => id.replace(/^\$/, "").replace(/[^a-zA-Z0-9_]/g, "_");
    const p = sanitize(progAgent);

    // (3) The agent's authoring verbs are advertised as dynamic Net tools —
    // resolved through the feature chain, not ancestry.
    const progNames = await listNames(progSession);
    for (const verb of ["install_verb", "create", "inspect", "eval"]) {
      expect(progNames, `${verb} missing from ${JSON.stringify(progNames.filter((n) => n.startsWith(p)))}`).toContain(`${p}__${verb}`);
    }

    // ...and `trace` is deliberately NOT among them. It is a v1.1 stub whose
    // only behavior is to raise, so listing it would advertise a tool that can
    // never succeed. Assert from the LIVE list, not the manifest flag: this is
    // the project's repeat defect (tool_exposed in a manifest is not evidence
    // of callability, and a flag flip here is silent).
    expect(progNames, "trace is a raise-only stub; it must not be advertised").not.toContain(`${p}__trace`);

    // The removed "all" scope is rejected by the MCP validator, not silently
    // degraded to the local closure (§7 / no global enumeration).
    const scopeAll = await call(progSession, "woo_list_reachable_tools", { scope: "all" });
    expect(scopeAll.result?.isError, JSON.stringify(scopeAll).slice(0, 300)).toBe(true);

    // (4) The non-programmer agent sees NO authoring tools — the surface gates
    // the tool set, not merely the flag.
    const plainSession = await open(plainToken);
    const plainNames = await listNames(plainSession);
    const pl = sanitize(plainAgent);
    for (const verb of ["install_verb", "create", "eval"]) {
      expect(plainNames).not.toContain(`${pl}__${verb}`);
    }

    // (5) Author through the authoritative turn path: the builder create verb,
    // reached via the feature chain, runs over Net and attributes the object to
    // the invoking actor (§8.7).
    const created = await call(progSession, "woo_call", { object: progAgent, verb: "create", args: ["$thing", { name: "NetWidget" }] });
    await settleAll();
    expect(created.result?.isError, JSON.stringify(created).slice(0, 500)).not.toBe(true);
    const createdResult = created.result?.structuredContent?.result ?? {};
    const widget = createdResult.id as string;
    expect(widget, JSON.stringify(created).slice(0, 500)).toBeTruthy();
    expect(createdResult.owner).toBe(progAgent);
    // Placement default (§6.4, LambdaMOO @create): with no explicit location the
    // new object lands in the AUTHOR'S INVENTORY. Placement is the first of the
    // two gates on reachability — an object in no container never enters MCP
    // structural context, so no verb installed on it can ever become a tool.
    expect(createdResult.location, `created object was not placed in the author's inventory: ${JSON.stringify(createdResult)}`).toBe(progAgent);

    // (6) The full authoring loop over Net (plan §7 authoring-workspace boundary):
    // the builder object co-located in the AUTHOR's cluster (not catalog-adjacent),
    // so a source install on it is a local cluster write, not E_CATALOG_MUTATION.
    const installed = await call(progSession, "woo_call", { object: progAgent, verb: "install_verb", args: [widget, "hi", "verb :hi() rxd { return 42; }", {}] });
    await settleAll();
    expect(installed.result?.isError, JSON.stringify(installed).slice(0, 600)).not.toBe(true);
    const installResult = installed.result?.structuredContent?.result ?? {};
    expect(installResult.ok, JSON.stringify(installed).slice(0, 600)).toBe(true);
    // The object co-located in the author's cluster (obj_<authority-root>_*),
    // not a catalog-adjacent scope — that is what made the install a local write.
    expect(widget.startsWith("obj_prog_agent_"), `authored object not in author cluster: ${widget}`).toBe(true);

    // (7) Inspect the freshly installed verb through the agent's own surface —
    // reading the source back proves the verb is durably in the author's cluster.
    const listed = await call(progSession, "woo_call", { object: progAgent, verb: "list_verb", args: [widget, "hi", {}] });
    await settleAll();
    expect(listed.result?.isError, JSON.stringify(listed).slice(0, 600)).not.toBe(true);
    const listedText = JSON.stringify(listed.result?.structuredContent?.result ?? {});
    expect(listedText, listedText.slice(0, 400)).toContain("return 42");

    // (8) `tool_exposed` is a LISTING gate and nothing more (spec M2.1/M2.2).
    // The widget is in structural context (inventory), but inventory objects
    // advertise only EXPLICITLY tool_exposed verbs — mcpActiveCommandContext
    // grants command-shaped affordances to the room and its contents, never to
    // self or inventory. So the freshly installed verb is not yet a tool...
    const w = sanitize(widget);
    const beforeExposure = await listNames(progSession);
    expect(beforeExposure, "an unexposed authored verb must not be advertised").not.toContain(`${w}__hi`);
    // ...and yet `woo_call` reaches it, which is the contract `help tools`
    // states ("calls any verb you may reach"). Gating woo_call on the
    // advertising flag left an author unable to run the verb they had just
    // written on an object in their own hand, with a refusal that named no
    // remediation. woo_call's gates are reachability and existence; every
    // authority check still runs inside the authoritative turn.
    const unexposedCall = await call(progSession, "woo_call", { object: widget, verb: "hi", args: [] });
    await settleAll();
    expect(unexposedCall.result?.isError, JSON.stringify(unexposedCall).slice(0, 400)).not.toBe(true);
    expect(unexposedCall.result?.structuredContent?.result, JSON.stringify(unexposedCall).slice(0, 400)).toBe(42);

    // The last tools/list pinned this session's digest; open the live stream so
    // the exposure change has somewhere to push its notification.
    const progEvents = await listen(progSession);

    // (9) Expose it. `install_verb` deliberately refuses metadata options (the
    // source header is canonical for perms); exposure flags are the
    // `set_verb_info` seat.
    const exposed = await call(progSession, "woo_call", {
      object: progAgent,
      verb: "set_verb_info",
      args: [widget, "hi", { tool_exposed: true }]
    });
    await settleAll();
    expect(exposed.result?.isError, JSON.stringify(exposed).slice(0, 600)).not.toBe(true);
    expect((exposed.result?.structuredContent?.result ?? {}).ok, JSON.stringify(exposed).slice(0, 600)).toBe(true);

    // (10) The session was told, not left to poll: a real tools/list_changed
    // reached the open SSE stream. Read it BEFORE re-listing, which would
    // consume the pending hint.
    expect(await nextSseMessage(progEvents), "no tools/list_changed followed the exposure change").toEqual({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed"
    });

    // (11) create -> install -> INVOKE closes. The verb the agent wrote minutes
    // ago is now an ordinary MCP tool in its own tools/list, and calling it
    // through the authoritative turn path returns the authored value.
    const afterExposure = await listNames(progSession);
    expect(afterExposure, `authored verb missing from tools/list: ${JSON.stringify(afterExposure.filter((n) => n.startsWith(w)))}`).toContain(`${w}__hi`);
    const invoked = await call(progSession, `${w}__hi`, {});
    await settleAll();
    expect(invoked.result?.isError, JSON.stringify(invoked).slice(0, 600)).not.toBe(true);
    expect(invoked.result?.structuredContent?.result, JSON.stringify(invoked).slice(0, 600)).toBe(42);
    // The generic woo_call route reaches the same verb.
    const invokedGeneric = await call(progSession, "woo_call", { object: widget, verb: "hi", args: [] });
    await settleAll();
    expect(invokedGeneric.result?.structuredContent?.result, JSON.stringify(invokedGeneric).slice(0, 600)).toBe(42);

    // (12) Reaching the unadvertised `trace` stub anyway (eval dispatches under
    // the actor's own authority and is not tool-gated) must produce an answer
    // an agent can act on: what it would have done, that it is absent from this
    // world, and what to use instead. The programmer flag is NOT the blocker —
    // this agent holds it — so a "you lack authority" style refusal would send
    // the reader hunting for a permission that would not help.
    const tracedRaw = await call(progSession, "woo_call", {
      object: progAgent,
      verb: "eval",
      args: [`this:trace(#${widget}, "hi")`, {}]
    });
    await settleAll();
    const tracedText = JSON.stringify(tracedRaw);
    expect(tracedRaw.result?.isError, tracedText.slice(0, 400)).toBe(true);
    expect(tracedText).toContain("E_NOT_IMPLEMENTED");
    expect(tracedText).toContain("not implemented in this world");
    expect(tracedText).toContain("list_verb");
    expect(tracedText).not.toContain("E_PERM");

    await closeQuiescent(states);
  });
});
