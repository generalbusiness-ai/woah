// MCP surface legibility (fake-DO lane, installed world).
//
// Pins the defects found by the 2026-07-27 deployed walkthrough
// (notes/2026-07-27-mcp-surface-walkthrough.md) so they cannot regress:
//
//   woo_call contract (spec M2.1) — `tool_exposed` is a LISTING flag and must
//   not gate woo_call. What gates woo_call is reachability (M3) and verb
//   existence; every authority check still runs inside the authoritative turn.
//
//   Refusal vocabulary — one string ("tool is not available in this session
//   context") covered unreachable / undefined / unexposed / native, which are
//   four different remediations. Each refusal must now name its own condition.
//
//   Observation gap marker (spec M5.1) — woo_wait's queue is in-memory and
//   at-most-once, so a DO restart silently swallowed everything queued. A
//   polling agent now learns that continuity could not be proven.
//
//   Tool descriptions — the doc-comment extractor took the first LINE, which
//   cut wrapped `//` doc-comments mid-sentence.
//
//   initialize instructions — an agent's entire onboarding; it never mentioned
//   `help`.
//
//   Count reconciliation — tools/list pages at 128 INCLUDING the woo_*
//   controls; woo_list_reachable_tools `total` counts dynamic descriptors with
//   no cap. The two numbers are not comparable, and the pager now says so.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { createWorld } from "../../src/core/bootstrap";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import {
  NetGatewayDO,
  mcpFirstParagraph,
  type NetGatewayDurableState,
  type NetGatewayEnv
} from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-mcp-legibility-secret";

function netState(name: string) {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const state: NetScopeDurableState & NetGatewayDurableState = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => {
      deferred.push(promise);
    },
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: () => {},
      deleteAlarm: () => {}
    }
  };
  return {
    state,
    settle: async () => {
      while (deferred.length > 0) await deferred.shift();
    },
    close: () => fake.close()
  };
}

type Rpc = { jsonrpc: "2.0"; id?: number; method: string; params?: unknown };

const sanitize = (id: string) => id.replace(/^\$/, "").replace(/[^a-zA-Z0-9_]/g, "_");

describe("mcpFirstParagraph", () => {
  // The exact live-surface truncations from the walkthrough (§e).
  it("takes the whole wrapped `//` paragraph, not the first physical line", () => {
    const source = [
      'verb :create(parent, opts) rxd {',
      '  set_task_perms(actor);',
      '  // Creates an object owned by the invoking actor. There is intentionally no',
      '  // owner option on the builder surface; creating for another actor is wizard',
      '  // administration, not delegated building.',
      '  //',
      '  // Placement default: a new object with no explicit location lands in the',
      "  // AUTHOR'S INVENTORY.",
      '  return 1;',
      '}'
    ].join("\n");
    const paragraph = mcpFirstParagraph(source);
    expect(paragraph).toBe(
      "Creates an object owned by the invoking actor. There is intentionally no owner option on the builder"
      + " surface; creating for another actor is wizard administration, not delegated building."
    );
    // A bare `//` ends the paragraph: the second thought is not dragged in.
    expect(paragraph).not.toContain("Placement default");
  });

  it("stops at the end of the contiguous comment run", () => {
    const source = "verb :x() rxd {\n  // one\n  // two\n  return 1; // trailing\n}";
    expect(mcpFirstParagraph(source)).toBe("one two");
  });

  it("keeps the first paragraph of a block comment", () => {
    const source = "verb :x() rxd {\n  /* first\n   * paragraph\n   *\n   * second */\n  return 1;\n}";
    expect(mcpFirstParagraph(source)).toBe("first paragraph");
  });

  it("returns an empty description when there is no doc comment", () => {
    expect(mcpFirstParagraph("verb :x() rxd { return 1; }")).toBe("");
  });

  it("clamps a long paragraph on a word boundary with an ellipsis", () => {
    const word = "alpha ";
    const source = `verb :x() rxd {\n  // ${word.repeat(200)}\n}`;
    const clamped = mcpFirstParagraph(source);
    expect(clamped.length).toBeLessThanOrEqual(501); // 500 + the ellipsis
    expect(clamped.endsWith("…")).toBe(true);
    // Cut on whitespace, so the last kept token is a whole word.
    expect(clamped.slice(0, -1).endsWith("alpha")).toBe(true);
  });
});

describe("Net MCP surface legibility (fake-DO lane)", () => {
  it("widens woo_call to reachability, names each refusal, marks observation gaps, and reconciles its counts", async () => {
    const progAgent = "prog_agent";
    const plainAgent = "plain_agent";
    const old = createWorld();
    old.createObject({ id: progAgent, parent: "$agent", owner: "$wiz", name: "ProgBot" });
    old.createObject({ id: plainAgent, parent: "$agent", owner: "$wiz", name: "PlainBot" });
    old.ensureApiKey("$wiz", progAgent, "prog-key", "prog-secret", "prog");
    old.ensureApiKey("$wiz", plainAgent, "plain-key", "plain-secret", "plain");
    old.setObjectFlags("$wiz", progAgent, { programmer: true });

    const identity = exportIdentity(old.exportWorld());
    const plan = await planNetInstall({ graft: async (fresh) => { importIdentity(fresh, identity); } });

    const states: Array<ReturnType<typeof netState>> = [];
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
      expect((await instance.fetch(await signInternalRequest(scopeEnv, request))).ok, `seed ${scope}`).toBe(true);
      states.push(st);
      scopeDOs.set(scope, instance);
    }
    const gatewayState = netState("gateway-net-api");
    states.push(gatewayState);
    const gatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: resolve,
      NET_GATEWAY_SELF: "gateway:net-api"
    } as NetGatewayEnv;
    gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);

    const settleAll = async () => {
      for (const st of states) await st.settle();
      for (const scope of scopeDOs.values()) await scope.alarm();
      for (const st of states) await st.settle();
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
    const open = async (token: string) => {
      const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { "mcp-token": token });
      expect(init.status, JSON.stringify(init.body)).toBe(200);
      const session = init.headers.get("mcp-session-id") as string;
      expect(session).toBeTruthy();
      await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": session });
      return { session, instructions: init.body?.result?.instructions as string };
    };
    const call = async (session: string, name: string, args: Record<string, unknown>) =>
      (await mcp({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": session })).body as Record<string, any>;
    const errorOf = (envelope: Record<string, any>) => envelope.result?.structuredContent?.error ?? {};

    const prog = await open("apikey:prog-key:prog-secret");
    const plain = await open("apikey:plain-key:plain-secret");
    const p = sanitize(progAgent);

    // ---- Fix 5: initialize is an agent's whole onboarding -----------------
    expect(prog.instructions, prog.instructions).toContain(`${p}__help`);
    expect(prog.instructions).toContain("woo_wait");
    expect(prog.instructions).toContain("woo_list_reachable_tools");

    // ---- Fix 4: descriptions carry the whole first paragraph -------------
    const listed = await mcp({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }, { "mcp-session-id": prog.session });
    const tools: Array<{ name: string; description: string }> = listed.body?.result?.tools ?? [];
    const createTool = tools.find((tool) => tool.name === `${p}__create`);
    expect(createTool, `no ${p}__create in ${tools.map((t) => t.name).join(",")}`).toBeTruthy();
    // The live truncation the walkthrough saw was exactly this sentence's head.
    expect((createTool as { description: string }).description).toContain("There is intentionally no owner option");
    expect((createTool as { description: string }).description).toContain("not delegated building.");

    // ---- Fix 1(a): a non-tool_exposed verb on a carried object is callable --
    const created = await call(prog.session, "woo_call", { object: progAgent, verb: "create", args: ["$thing", { name: "Probe" }] });
    await settleAll();
    expect(created.result?.isError, JSON.stringify(created).slice(0, 400)).not.toBe(true);
    const widget = (created.result?.structuredContent?.result ?? {}).id as string;
    expect(widget).toBeTruthy();
    const installed = await call(prog.session, "woo_call", {
      object: progAgent,
      verb: "install_verb",
      args: [widget, "ping", 'verb :ping() rxd { return "pong"; }', {}]
    });
    await settleAll();
    expect(installed.result?.isError, JSON.stringify(installed).slice(0, 400)).not.toBe(true);

    // Not advertised (inventory advertises only tool_exposed verbs)...
    const afterInstall = await mcp({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }, { "mcp-session-id": prog.session });
    const afterNames: string[] = (afterInstall.body?.result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(afterNames).not.toContain(`${sanitize(widget)}__ping`);
    // ...and callable anyway. This is the whole point of the widening.
    const pinged = await call(prog.session, "woo_call", { object: widget, verb: "ping", args: [] });
    await settleAll();
    expect(pinged.result?.isError, JSON.stringify(pinged).slice(0, 400)).not.toBe(true);
    expect(pinged.result?.structuredContent?.result).toBe("pong");

    // `$me` resolves to the session actor — the form every user doc uses.
    const viaMe = await call(prog.session, "woo_call", { object: "$me", verb: "list_verb", args: [widget, "ping", {}] });
    await settleAll();
    expect(viaMe.result?.isError, JSON.stringify(viaMe).slice(0, 400)).not.toBe(true);

    // ---- Fix 1(b): an out-of-context target is still refused --------------
    // The widget sits in the PROGRAMMER's inventory, so it is not in the plain
    // agent's structural context (M3): another actor's inventory is not one of
    // the four context sources. Widening woo_call must not have widened this.
    const outOfContext = await call(plain.session, "woo_call", { object: widget, verb: "ping", args: [] });
    expect(outOfContext.result?.isError, JSON.stringify(outOfContext).slice(0, 400)).toBe(true);
    const unreachable = errorOf(outOfContext);
    expect(unreachable.code).toBe("E_PERM");
    expect(unreachable.detail?.reason).toBe("target_not_reachable");
    // Fix 2: the refusal names the remediation, not just the rule.
    expect(String(unreachable.detail?.remediation)).toMatch(/move to|enter|take it/);
    // The retired blanket string must not come back.
    expect(JSON.stringify(outOfContext)).not.toContain("tool is not available in this session context");
    // An id that names nothing is refused the same way, not with an internal error.
    const nowhereObject = await call(plain.session, "woo_call", { object: "no_such_object", verb: "look", args: [] });
    expect(errorOf(nowhereObject).detail?.reason).toBe("target_not_reachable");

    // ---- Fix 1(c): a world authority refusal still fires, verbatim --------
    // `$wiz:eval` IS reachable from this room and IS advertised, and is gated
    // on the programmer surface inside the world. The plain agent must receive
    // the world's own E_PERM with its trace frames — not gateway silence, and
    // not a gateway-invented reason.
    const progbitGated = await call(plain.session, "woo_call", { object: "$wiz", verb: "eval", args: ["1 + 1", {}] });
    await settleAll();
    expect(progbitGated.result?.isError, JSON.stringify(progbitGated).slice(0, 400)).toBe(true);
    const worldRefusal = errorOf(progbitGated);
    expect(worldRefusal.code).toBe("E_PERM");
    expect(String(worldRefusal.message)).toContain("programmer");
    expect(worldRefusal.detail?.reason).toBeUndefined();
    expect(Array.isArray(worldRefusal.trace), JSON.stringify(worldRefusal).slice(0, 300)).toBe(true);

    // ---- Fix 2: absent verb on a REACHABLE target is E_VERBNF -------------
    const missing = await call(prog.session, "woo_call", { object: widget, verb: "no_such_verb", args: [] });
    expect(missing.result?.isError).toBe(true);
    expect(errorOf(missing).code).toBe("E_VERBNF");
    expect(errorOf(missing).detail?.obj).toBe(widget);
    expect(errorOf(missing).detail?.name).toBe("no_such_verb");

    // ---- Fix 2: a native page has no Net body, and says so ----------------
    // `$actor:focus` is a seeded native: reachable, defined, and genuinely
    // uncallable over Net. Under the old string it was indistinguishable from
    // "you are in the wrong room".
    const native = await call(prog.session, "woo_call", { object: progAgent, verb: "focus", args: [progAgent] });
    expect(native.result?.isError).toBe(true);
    expect(errorOf(native).detail?.reason).toBe("native_verb");

    // ---- Fix 1(c): world authority refusals still fire --------------------
    // force_recycle is reachable and advertised for a programmer but is
    // wizard-only in the world. The refusal must come from the turn (E_PERM
    // with the world's own frames), not from a gateway reachability check.
    const wizardOnly = await call(prog.session, "woo_call", { object: progAgent, verb: "force_recycle", args: [widget] });
    await settleAll();
    expect(wizardOnly.result?.isError, JSON.stringify(wizardOnly).slice(0, 400)).toBe(true);
    const refusal = errorOf(wizardOnly);
    expect(JSON.stringify(refusal)).toContain("E_PERM");
    // Not one of the gateway's own pre-turn reasons: the world answered.
    expect(refusal.detail?.reason).not.toBe("target_not_reachable");
    expect(refusal.detail?.reason).not.toBe("verb_not_executable");

    // ---- Fix 6: the two counts reconcile ---------------------------------
    // tools/list pages at 128 INCLUDING the three woo_* controls;
    // woo_list_reachable_tools `total` counts dynamic descriptors only.
    const page = await call(prog.session, "woo_list_reachable_tools", { scope: "active", limit: 1 });
    const pagerTotal = page.result?.structuredContent?.result?.total as number;
    const allNames: string[] = [];
    let cursor: string | undefined;
    do {
      const listing = await mcp(
        { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: cursor ? { cursor } : {} },
        { "mcp-session-id": prog.session }
      );
      allNames.push(...(listing.body?.result?.tools ?? []).map((t: { name: string }) => t.name));
      cursor = listing.body?.result?.nextCursor;
    } while (cursor);
    const controls = allNames.filter((name) => name.startsWith("woo_"));
    expect(controls.sort()).toEqual(["woo_call", "woo_list_reachable_tools", "woo_wait"]);
    expect(allNames.length - controls.length).toBe(pagerTotal);

    // ---- Fix 2: the cross-scope refusal names the space to enter ---------
    // A mounted tool-space is listed as an object in the room but writes at
    // its OWN shared scope, so a turn issued from the room spans two shared
    // scopes and is terminal (CO2.3). The rule stands; the refusal now says
    // what to do about it instead of only naming the invariant. (Read from
    // the FULL listing: the_outline's tools sit past the first page — which is
    // the same fact the count reconciliation above is about.)
    expect(allNames.some((name) => name.startsWith("the_outline__")), "fixture no longer mounts the_outline").toBe(true);
    const split = await call(prog.session, "woo_call", { object: "the_outline", verb: "add_item", args: ["probe", null] });
    await settleAll();
    expect(split.result?.isError, JSON.stringify(split).slice(0, 400)).toBe(true);
    const splitError = errorOf(split);
    expect(JSON.stringify(splitError)).toContain("E_SCOPE_SPLIT");
    expect(String(splitError.detail?.remediation), JSON.stringify(splitError).slice(0, 500)).toContain("the_outline__enter");
    expect(splitError.detail?.target).toBe("the_outline");

    // ---- Fix 3: the observation gap marker -------------------------------
    // A session whose state was installed by `initialize` and never lost has
    // proven continuity: no false gap on the first wait.
    const firstWait = await call(prog.session, "woo_wait", { timeout_ms: 0 });
    expect(firstWait.result?.structuredContent?.result?.gap, JSON.stringify(firstWait)).toBe(false);
    expect(firstWait.result?.structuredContent?.result?.observations).toEqual([]);

    // Restart the gateway over the same durable state. The session cell
    // survives; the in-memory queue does not — exactly the case that used to
    // swallow observations with no signal at all.
    gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    const afterRestart = await call(prog.session, "woo_wait", { timeout_ms: 0 });
    expect(afterRestart.result?.structuredContent?.result?.gap, JSON.stringify(afterRestart)).toBe(true);
    // The marker is one-shot: it describes the discontinuity, not a state.
    const settledWait = await call(prog.session, "woo_wait", { timeout_ms: 0 });
    expect(settledWait.result?.structuredContent?.result?.gap).toBe(false);

    await settleAll();
    for (const st of states) st.close();
  });
});
