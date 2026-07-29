// MCP argument validation (mcp.md §M4.3), fake-DO lane.
//
// The defect this pins: woo advertised an `inputSchema` for every tool and
// checked NOTHING against it before dispatch. A missing property silently
// became `null` and a wrong-typed one reached the VM unchanged, so the schema
// a model reads was decorative.
//
// Every refusal assertion below is on WORLD STATE as well as reply shape: the
// scope DOs' cell table and transcript log are snapshotted around the refused
// call and must be byte-identical, and the session's observation queue must
// stay empty. A "fix" that lets the turn run and then reports an error must
// fail here.
import { describe, expect, it } from "vitest";
import { netState, closeNetStates, type NetFakeDoState } from "./net-do-state";
import { createWorld } from "../../src/core/bootstrap";
import { installVerb } from "../../src/core/authoring";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-mcp-argval-secret";

/** The fixture object carrying the validated verbs, and its dynamic tool. */
const WIDGET = "the_widget";
const BUMP_TOOL = "the_widget__note_bump";

type Rpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: unknown };

/**
 * A one-actor world whose `the_widget` sits in the chatroom and carries the
 * verbs under test.
 *
 * `note_bump` is the DYNAMIC tool. It is command-shaped (so the room's
 * visible contents advertise it without extra ceremony), declares one
 * required and one optional parameter, and carries explicit `arg_spec.types`
 * — the extension `mcpInputSchema` turns into real JSON-Schema `type`
 * assertions. It BOTH writes a cell and emits an observation, so a refusal
 * that leaked into dispatch is visible two ways.
 *
 * `poke` uses the `(dobj, prep, iobj)` command-header form, whose `arg_spec`
 * carries no declaration list at all. It exists to pin the documented
 * RESIDUAL: woo_call cannot check arity for such a page.
 */
async function fixture() {
  const old = createWorld();
  const alice = old.auth("guest:argval-alice").actor;
  old.ensureApiKey("$wiz", alice, "argval-key-a", "argval-secret-a", "alice");
  const identity = exportIdentity(old.exportWorld());
  const plan = await planNetInstall({
    graft: async (fresh) => {
      importIdentity(fresh, identity);
      fresh.createObject({
        id: WIDGET,
        name: "widget",
        parent: "$thing",
        owner: "$wiz",
        location: "the_chatroom"
      });
      fresh.setProp(WIDGET, "hits", 0);
      expect(installVerb(
        fresh,
        WIDGET,
        "note_bump",
        "verb :note_bump(text, amount) rxd {"
        + " let step = 1;"
        + " if (typeof(amount) == \"number\") { step = amount; }"
        + " this.hits = this.hits + step;"
        + " observe({ type: \"bumped\", text: text, source: this });"
        + " return this.hits; }",
        null,
        {
          argSpec: {
            args: ["text", "amount?"],
            types: { text: "str", amount: "int" },
            // Non-empty command metadata is what makes a verb on the room's
            // visible contents advertised (M2.2). `args_from: []` leaves the
            // schema types to the explicit hints above.
            command: { dobj: "none", prep: "any", iobj: "any", args_from: [] }
          }
        }
      ).ok, "install note_bump").toBe(true);
      // No declaration list. The three-token COMMAND HEADER form — three
      // bare specifiers, no commas — compiles to `{dobj, prep, iobj}` and
      // therefore carries neither `args` nor `params`. (The comma form
      // `(a, b, c)` is an ordinary parameter list and IS checked; that
      // distinction is exactly what the residual turns on.)
      expect(installVerb(
        fresh,
        WIDGET,
        "poke",
        "verb :poke(any any any) rxd { return \"poked\"; }",
        null
      ).ok, "install poke").toBe(true);
      expect(installVerb(
        fresh,
        WIDGET,
        "hits_now",
        "verb :hits_now() rxd { return this.hits; }",
        null
      ).ok, "install hits_now").toBe(true);
    }
  });

  const states: NetFakeDoState[] = [];
  const scopeDOs = new Map<string, NetScopeDO>();
  const scopeStates = new Map<string, NetFakeDoState>();
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
    scopeStates.set(scope, st);
  }
  const gatewayState = netState("gateway-net-api");
  states.push(gatewayState);
  gateway = new NetGatewayDO(gatewayState.state, {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: resolve,
    NET_GATEWAY_SELF: "gateway:net-api"
  } as NetGatewayEnv);

  const settleAll = async () => {
    for (const st of states) await st.settle();
    for (const scope of scopeDOs.values()) await scope.alarm();
    for (const st of states) await st.settle();
  };

  let nextId = 2000;
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
    const session = init.headers.get("mcp-session-id") as string;
    expect(session).toBeTruthy();
    await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": session });
    return session;
  };
  const call = async (
    session: string,
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>
  ) => (await mcp(
    { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } },
    { "mcp-session-id": session }
  )).body as Record<string, any>;

  const aliceSession = await open("apikey:argval-key-a:argval-secret-a");
  await settleAll();

  /**
   * Every authoritative cell and transcript row across every scope.
   *
   * This is the "no world effect" instrument. `net_scope_cell` is the
   * authoritative object state and `net_scope_log` is the sequenced
   * transcript, so a turn that reached dispatch — even one that then failed —
   * moves at least one of them. Reply-shape assertions alone cannot tell a
   * pre-dispatch refusal from a post-dispatch failure; this can.
   */
  const worldSnapshot = () => {
    const out: Record<string, unknown> = {};
    for (const [scope, st] of scopeStates) {
      out[`${scope}:cell`] = (st.state.storage.sql.exec(
        "SELECT key, body FROM net_scope_cell ORDER BY key"
      ) as unknown as { toArray(): unknown[] }).toArray();
      out[`${scope}:log`] = (st.state.storage.sql.exec(
        "SELECT space, seq, body FROM net_scope_log ORDER BY space, seq"
      ) as unknown as { toArray(): unknown[] }).toArray();
    }
    return JSON.stringify(out);
  };

  /** Drain the session queue and return every observation seen. */
  const drain = async (session = aliceSession): Promise<Record<string, any>[]> => {
    const seen: Record<string, any>[] = [];
    for (;;) {
      const waited = await call(session, "woo_wait", { timeout_ms: 0, limit: 100 });
      const batch = waited.result?.structuredContent?.result?.observations ?? [];
      if (batch.length === 0) return seen;
      seen.push(...batch);
    }
  };

  /** The counter, read back through the real turn path. */
  const hits = async (): Promise<number> => {
    const read = await call(aliceSession, "woo_call", { object: WIDGET, verb: "hits_now", args: [] });
    expect(read.result?.isError, JSON.stringify(read).slice(0, 400)).not.toBe(true);
    return read.result?.structuredContent?.result as number;
  };

  return {
    alice, aliceSession, mcp, call, drain, hits, settleAll, worldSnapshot,
    close: async () => await closeNetStates(states)
  };
}

/** The `{code, message, detail}` a refused tool call carries. */
function refusalOf(reply: Record<string, any>): Record<string, any> {
  expect(reply.result?.isError, `expected a refusal, got ${JSON.stringify(reply).slice(0, 400)}`).toBe(true);
  return reply.result?.structuredContent?.error as Record<string, any>;
}

describe("MCP argument validation (mcp.md §M4.3)", () => {
  /**
   * The shared "refused before dispatch" harness: snapshot the world, make
   * the call, assert it was refused, assert nothing moved.
   */
  async function refusedWithoutEffect(
    f: Awaited<ReturnType<typeof fixture>>,
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, any>> {
    // A clean queue first, so "no observation" cannot be satisfied by an
    // earlier drain having already emptied a queue that then refilled.
    await f.settleAll();
    await f.drain();
    const before = f.worldSnapshot();
    const reply = await f.call(f.aliceSession, name, args);
    const refusal = refusalOf(reply);
    await f.settleAll();
    expect(f.worldSnapshot(), `${name} changed authoritative state before refusing`).toBe(before);
    expect(await f.drain(), `${name} emitted an observation before refusing`).toEqual([]);
    return refusal;
  }

  it("advertises the schema the validator enforces", async () => {
    const f = await fixture();
    try {
      // The premise for everything below: the tool really is advertised, and
      // the advertisement really does declare `text` required and typed. A
      // validator checked against a schema nobody publishes proves nothing.
      let schema: Record<string, any> | undefined;
      let cursor: string | undefined;
      do {
        const page = await f.mcp(
          { jsonrpc: "2.0", id: 5, method: "tools/list", params: cursor ? { cursor } : {} },
          { "mcp-session-id": f.aliceSession }
        );
        for (const tool of page.body?.result?.tools ?? []) {
          if (tool.name === BUMP_TOOL) schema = tool.inputSchema;
        }
        cursor = page.body?.result?.nextCursor;
      } while (cursor && !schema);
      expect(schema, `${BUMP_TOOL} was not advertised`).toBeTruthy();
      expect(schema!.required).toEqual(["text"]);
      // Required parameter: the plain declared type.
      expect(schema!.properties.text).toMatchObject({ type: "string" });
      // OPTIONAL parameter: advertised NULLABLE, because it really does
      // accept null (mcp.md §M4.3). Before this the accepted set was wider
      // than the advertised one — drift with the sign flipped.
      expect(schema!.properties.amount.type).toEqual(["integer", "null"]);
      // The reserved retry-safety property rides the protocol view, and the
      // validator sees the same object — so sending it is never "unknown".
      expect(schema!.properties.operation_id).toBeTruthy();
    } finally {
      await f.close();
    }
  });

  // ---- dynamic <object>__<verb> tool ------------------------------------

  it("refuses a missing required argument on a dynamic tool, before dispatch", async () => {
    const f = await fixture();
    try {
      expect(await f.hits()).toBe(0);
      const refusal = await refusedWithoutEffect(f, BUMP_TOOL, { amount: 3 });
      expect(refusal.code).toBe("E_INVARG");
      expect(refusal.detail.reason).toBe("missing_required_argument");
      expect(refusal.detail.field).toBe("text");
      expect(refusal.detail.expected).toBe("string");
      // Legible: names the parameter, its type, and what to do.
      expect(refusal.message).toContain("text");
      expect(refusal.message).toContain("string");
      expect(String(refusal.detail.remediation)).toContain("text");
      // And the counter never moved — the pre-fix behaviour passed `null`
      // through to the verb, which happily bumped it.
      expect(await f.hits()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("names the misspelling when a required argument is missing and extras were sent", async () => {
    const f = await fixture();
    try {
      const refusal = await refusedWithoutEffect(f, BUMP_TOOL, { txet: "typo" });
      expect(refusal.detail.reason).toBe("missing_required_argument");
      expect(refusal.detail.unknown_properties).toEqual(["txet"]);
      expect(String(refusal.detail.remediation)).toContain("misspelling");
    } finally {
      await f.close();
    }
  });

  it("refuses a wrong-typed argument on a dynamic tool, before dispatch", async () => {
    const f = await fixture();
    try {
      expect(await f.hits()).toBe(0);
      // `amount` is declared `int`; 2.5 is a number but not an integer.
      const refusal = await refusedWithoutEffect(f, BUMP_TOOL, { text: "hi", amount: 2.5 });
      expect(refusal.code).toBe("E_INVARG");
      expect(refusal.detail.reason).toBe("argument_type_mismatch");
      expect(refusal.detail.field).toBe("amount");
      expect(refusal.detail.expected).toBe("integer or null");
      expect(refusal.detail.received).toBe("number");
      expect(refusal.message).toContain("amount");
      expect(await f.hits()).toBe(0);

      // And the plainer case: a string where a string is not declared.
      const wrongText = await refusedWithoutEffect(f, BUMP_TOOL, { text: 42 });
      expect(wrongText.detail.field).toBe("text");
      expect(wrongText.detail.expected).toBe("string");
      expect(wrongText.detail.received).toBe("integer");
      expect(await f.hits()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("accepts a valid dynamic call, including one carrying unknown extra properties", async () => {
    const f = await fixture();
    try {
      expect(await f.hits()).toBe(0);
      const plain = await f.call(f.aliceSession, BUMP_TOOL, { text: "one" });
      expect(plain.result?.isError, JSON.stringify(plain).slice(0, 400)).not.toBe(true);
      await f.settleAll();
      expect(await f.hits()).toBe(1);

      // STRICTNESS DECISION: unknown properties are IGNORED, not rejected.
      // Our advertised schemas do not set `additionalProperties: false`, and
      // real MCP clients decorate `arguments`. Over-strictness here breaks
      // working clients for no correctness gain.
      const decorated = await f.call(f.aliceSession, BUMP_TOOL, {
        text: "two",
        amount: 4,
        // Not parameters of this verb: a client-side annotation, and MCP's
        // own progress-token convention leaking into `arguments`.
        client_note: "from a real client",
        progressToken: 17
      });
      expect(decorated.result?.isError, JSON.stringify(decorated).slice(0, 400)).not.toBe(true);
      await f.settleAll();
      expect(await f.hits()).toBe(5);

      // An OPTIONAL parameter explicitly set to null means "not supplied" —
      // it is what the transport itself substitutes for an absent property,
      // so refusing it would refuse our own encoding of absence.
      const explicitNull = await f.call(f.aliceSession, BUMP_TOOL, { text: "three", amount: null });
      expect(explicitNull.result?.isError, JSON.stringify(explicitNull).slice(0, 400)).not.toBe(true);
      await f.settleAll();
      expect(await f.hits()).toBe(6);
    } finally {
      await f.close();
    }
  });

  // ---- woo_call ----------------------------------------------------------

  it("refuses woo_call with too few positional arguments, before dispatch", async () => {
    const f = await fixture();
    try {
      expect(await f.hits()).toBe(0);
      const refusal = await refusedWithoutEffect(f, "woo_call", { object: WIDGET, verb: "note_bump", args: [] });
      expect(refusal.code).toBe("E_INVARG");
      expect(refusal.detail.reason).toBe("missing_required_argument");
      expect(refusal.detail.obj).toBe(WIDGET);
      expect(refusal.detail.name).toBe("note_bump");
      expect(refusal.detail.field).toBe("text");
      expect(refusal.detail.minimum_arity).toBe(1);
      expect(refusal.detail.received_arity).toBe(0);
      expect(refusal.detail.declared).toEqual(["text", "amount"]);
      expect(await f.hits()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("refuses woo_call with a wrong-typed positional argument, before dispatch", async () => {
    const f = await fixture();
    try {
      expect(await f.hits()).toBe(0);
      const refusal = await refusedWithoutEffect(f, "woo_call", {
        object: WIDGET,
        verb: "note_bump",
        args: ["hi", "seven"]
      });
      expect(refusal.detail.reason).toBe("argument_type_mismatch");
      expect(refusal.detail.field).toBe("amount");
      expect(refusal.detail.position).toBe(1);
      expect(refusal.detail.expected).toBe("integer or null");
      expect(refusal.detail.received).toBe("string");
      expect(String(refusal.detail.remediation)).toContain("args[1]");
      expect(await f.hits()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("refuses woo_call with more arguments than the verb declares", async () => {
    const f = await fixture();
    try {
      const refusal = await refusedWithoutEffect(f, "woo_call", {
        object: WIDGET,
        verb: "note_bump",
        args: ["hi", 1, "surplus"]
      });
      expect(refusal.detail.reason).toBe("too_many_arguments");
      expect(refusal.detail.maximum_arity).toBe(2);
      expect(refusal.detail.received_arity).toBe(3);
      expect(await f.hits()).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("refuses a malformed woo_call payload against woo_call's OWN schema", async () => {
    const f = await fixture();
    try {
      // `args` declared `array`. Pre-fix this became `[]` silently and the
      // verb ran with no arguments at all.
      const wrongArgs = await refusedWithoutEffect(f, "woo_call", {
        object: WIDGET,
        verb: "note_bump",
        args: "hi"
      });
      expect(wrongArgs.detail.reason).toBe("argument_type_mismatch");
      expect(wrongArgs.detail.field).toBe("args");
      // `args` is optional, so its advertised type is the nullable union.
      expect(wrongArgs.detail.expected).toBe("array or null");

      // `object` declared `string`. Pre-fix a non-string was coerced to ""
      // and reported as though it had been omitted.
      const wrongObject = await refusedWithoutEffect(f, "woo_call", { object: 7, verb: "note_bump" });
      expect(wrongObject.detail.reason).toBe("argument_type_mismatch");
      expect(wrongObject.detail.field).toBe("object");

      const missingVerb = await refusedWithoutEffect(f, "woo_call", { object: WIDGET });
      expect(missingVerb.detail.reason).toBe("missing_required_argument");
      expect(missingVerb.detail.field).toBe("verb");
    } finally {
      await f.close();
    }
  });

  it("accepts a valid woo_call, and one carrying unknown extra properties", async () => {
    const f = await fixture();
    try {
      const ok = await f.call(f.aliceSession, "woo_call", { object: WIDGET, verb: "note_bump", args: ["hi", 2] });
      expect(ok.result?.isError, JSON.stringify(ok).slice(0, 400)).not.toBe(true);
      await f.settleAll();
      expect(await f.hits()).toBe(2);

      const decorated = await f.call(f.aliceSession, "woo_call", {
        object: WIDGET,
        verb: "note_bump",
        args: ["hi"],
        _clientHint: { retries: 0 }
      });
      expect(decorated.result?.isError, JSON.stringify(decorated).slice(0, 400)).not.toBe(true);
      await f.settleAll();
      expect(await f.hits()).toBe(3);

      // A trailing optional may be omitted OR passed as null.
      const nulled = await f.call(f.aliceSession, "woo_call", { object: WIDGET, verb: "note_bump", args: ["hi", null] });
      expect(nulled.result?.isError, JSON.stringify(nulled).slice(0, 400)).not.toBe(true);
      await f.settleAll();
      expect(await f.hits()).toBe(4);
    } finally {
      await f.close();
    }
  });

  it("RESIDUAL: a verb whose arg_spec declares no parameter list is not arity-checked", async () => {
    const f = await fixture();
    try {
      // `poke` uses the `(dobj, prep, iobj)` command-header form, so its
      // `arg_spec` carries neither `args` nor `params`. The gateway has no
      // declared arity to check against and MUST NOT invent one — assuming
      // "zero parameters" would refuse every legitimate command-shaped call.
      // This is the honest residual stated in mcp.md §M4.3.
      const surplus = await f.call(f.aliceSession, "woo_call", {
        object: WIDGET,
        verb: "poke",
        args: ["a", "b", "c", "d", "e"]
      });
      expect(surplus.result?.isError, JSON.stringify(surplus).slice(0, 400)).not.toBe(true);
      expect(surplus.result?.structuredContent?.result).toBe("poked");
    } finally {
      await f.close();
    }
  });

  // ---- stable controls ---------------------------------------------------

  it("refuses a wrong-typed woo_wait argument instead of silently defaulting it", async () => {
    const f = await fixture();
    try {
      const reply = await f.call(f.aliceSession, "woo_wait", { timeout_ms: "5000" });
      const refusal = refusalOf(reply);
      expect(refusal.code).toBe("E_INVARG");
      expect(refusal.detail.reason).toBe("argument_type_mismatch");
      expect(refusal.detail.field).toBe("timeout_ms");
      expect(refusal.detail.expected).toBe("number or null");
      expect(refusal.detail.received).toBe("string");
      // Pre-fix this parked for the 1000ms default and told the client
      // nothing — a client that asked for five seconds got one.
      const ok = await f.call(f.aliceSession, "woo_wait", { timeout_ms: 0, limit: 1 });
      expect(ok.result?.isError).not.toBe(true);
    } finally {
      await f.close();
    }
  });

  it("refuses an out-of-enum woo_list_reachable_tools scope, naming the allowed set", async () => {
    const f = await fixture();
    try {
      const reply = await f.call(f.aliceSession, "woo_list_reachable_tools", { scope: "all" });
      const refusal = refusalOf(reply);
      expect(refusal.code).toBe("E_INVARG");
      expect(refusal.detail.reason).toBe("argument_type_mismatch");
      expect(refusal.detail.field).toBe("scope");
      expect(String(refusal.detail.expected)).toContain("\"active\"");
      expect(String(refusal.detail.expected)).toContain("\"space\"");

      const ok = await f.call(f.aliceSession, "woo_list_reachable_tools", { scope: "active", limit: 5 });
      expect(ok.result?.isError, JSON.stringify(ok).slice(0, 400)).not.toBe(true);
    } finally {
      await f.close();
    }
  });

  // ---- the `arguments` envelope itself (R7 P2) ---------------------------

  it("refuses a non-object `arguments` envelope on a control with NO required properties", async () => {
    const f = await fixture();
    try {
      // This is where the hole was. `woo_list_reachable_tools` requires
      // nothing, so property-level validation had nothing to say, and
      // `(params.arguments ?? {})` cast each of these straight through as an
      // empty object — the call then "succeeded" on its defaults. A client
      // sending a malformed payload was told it had worked.
      for (const payload of [null, [], "text", 42, true] as unknown[]) {
        const reply = await f.mcp(
          {
            jsonrpc: "2.0",
            id: 9300,
            method: "tools/call",
            params: { name: "woo_list_reachable_tools", arguments: payload }
          },
          { "mcp-session-id": f.aliceSession }
        );
        const refusal = refusalOf(reply.body as Record<string, any>);
        expect(refusal.code, `payload ${JSON.stringify(payload)}`).toBe("E_INVARG");
        expect(refusal.detail.reason, `payload ${JSON.stringify(payload)}`).toBe("invalid_arguments_object");
        expect(refusal.detail.field).toBe("arguments");
        expect(refusal.detail.expected).toBe("object");
        expect(String(refusal.detail.remediation)).toContain("JSON object");
      }
      // Explicitly ABSENT stays legal — MCP declares `arguments` optional,
      // and that is how "this tool takes none" is spelled.
      const omitted = await f.mcp(
        { jsonrpc: "2.0", id: 9301, method: "tools/call", params: { name: "woo_list_reachable_tools" } },
        { "mcp-session-id": f.aliceSession }
      );
      expect((omitted.body as any)?.result?.isError).not.toBe(true);
    } finally {
      await f.close();
    }
  });

  it("refuses a non-object `arguments` envelope on woo_call and on a dynamic tool too", async () => {
    const f = await fixture();
    try {
      for (const name of ["woo_call", BUMP_TOOL]) {
        for (const payload of [null, [], "text", 42] as unknown[]) {
          const reply = await f.mcp(
            { jsonrpc: "2.0", id: 9310, method: "tools/call", params: { name, arguments: payload } },
            { "mcp-session-id": f.aliceSession }
          );
          const refusal = refusalOf(reply.body as Record<string, any>);
          expect(refusal.detail.reason, `${name} / ${JSON.stringify(payload)}`).toBe("invalid_arguments_object");
        }
      }
      // The envelope check runs before dispatch, like every other refusal.
      expect(await f.hits()).toBe(0);
    } finally {
      await f.close();
    }
  });

  // ---- advertised == enforced, per constraint (R7 P2) --------------------

  /** The published schema of a stable control, read from tools/list. */
  async function controlSchema(
    f: Awaited<ReturnType<typeof fixture>>,
    name: string
  ): Promise<Record<string, any>> {
    const page = await f.mcp(
      { jsonrpc: "2.0", id: 9320, method: "tools/list", params: {} },
      { "mcp-session-id": f.aliceSession }
    );
    const tool = (page.body?.result?.tools ?? []).find((entry: any) => entry.name === name);
    expect(tool, `${name} not advertised`).toBeTruthy();
    return tool.inputSchema as Record<string, any>;
  }

  it("advertises minLength on woo_call's object/verb, and enforces exactly that", async () => {
    const f = await fixture();
    try {
      // ADVERTISED. The non-empty rule used to be a hand-rolled branch that
      // no schema mentioned, so a client satisfying the printed schema could
      // still be refused.
      const schema = await controlSchema(f, "woo_call");
      expect(schema.properties.object.minLength).toBe(1);
      expect(schema.properties.verb.minLength).toBe(1);

      // ENFORCED, and reported as the constraint it is.
      const emptyObject = await refusedWithoutEffect(f, "woo_call", { object: "", verb: "note_bump" });
      expect(emptyObject.detail.reason).toBe("argument_too_short");
      expect(emptyObject.detail.field).toBe("object");
      expect(emptyObject.detail.min_length).toBe(1);
      expect(emptyObject.detail.expected).toBe("a non-empty string");

      const emptyVerb = await refusedWithoutEffect(f, "woo_call", { object: WIDGET, verb: "" });
      expect(emptyVerb.detail.reason).toBe("argument_too_short");
      expect(emptyVerb.detail.field).toBe("verb");
    } finally {
      await f.close();
    }
  });

  it("advertises the operation_id pattern, and it is the regex actually enforced", async () => {
    const f = await fixture();
    try {
      const schema = await controlSchema(f, "woo_call");
      const published = schema.properties.operation_id.pattern as string;
      expect(published).toBe("^[A-Za-z0-9._:-]{1,128}$");
      expect(schema.properties.operation_id.type).toEqual(["string", "null"]);

      // The published pattern must be the DECIDER, not a paraphrase: every
      // value it accepts is accepted, and every value it rejects is refused.
      // An approximation would advertise a key shape the turn layer cannot
      // honour (the key must stay injective in actor × operation id).
      const compiled = new RegExp(published);
      expect(compiled.test("run-1:step-2")).toBe(true);
      expect(compiled.test("has spaces")).toBe(false);
      expect(compiled.test("x".repeat(129))).toBe(false);

      const refusal = await refusedWithoutEffect(f, "woo_call", {
        object: WIDGET, verb: "note_bump", args: ["hi"], operation_id: "has spaces and \u{1F642}"
      });
      // Reported by the operation-id door, which adjudicates BOTH carriers
      // (`_meta` and `arguments`) — so the same broken value cannot come
      // back under two different reasons depending on how it was sent.
      expect(refusal.detail.reason).toBe("invalid_operation_id");

      // A value the published pattern accepts really is accepted.
      const ok = await f.call(f.aliceSession, "woo_call", {
        object: WIDGET, verb: "note_bump", args: ["hi"], operation_id: "run-1:step-2"
      });
      expect(ok.result?.isError, JSON.stringify(ok).slice(0, 300)).not.toBe(true);
      await f.settleAll();
      expect(await f.hits()).toBe(1);
    } finally {
      await f.close();
    }
  });

  it("advertises optional properties as nullable, and accepts the null it advertises", async () => {
    const f = await fixture();
    try {
      // Every optional property of every control is published nullable —
      // the widening is applied by one helper, so none can be missed.
      for (const name of ["woo_call", "woo_wait", "woo_list_reachable_tools"]) {
        const schema = await controlSchema(f, name);
        const required = new Set<string>(schema.required ?? []);
        for (const [property, declared] of Object.entries<any>(schema.properties)) {
          if (required.has(property)) continue;
          const type = declared.type;
          expect(
            Array.isArray(type) ? type.includes("null") : type === undefined,
            `${name}.${property} is optional but not advertised nullable (type=${JSON.stringify(type)})`
          ).toBe(true);
          if (Array.isArray(declared.enum)) {
            expect(declared.enum, `${name}.${property} enum omits null`).toContain(null);
          }
        }
      }
      // And the advertised null is genuinely accepted, on every control.
      const waited = await f.call(f.aliceSession, "woo_wait", { timeout_ms: null, limit: null });
      expect(waited.result?.isError, JSON.stringify(waited).slice(0, 300)).not.toBe(true);
      const listed = await f.call(f.aliceSession, "woo_list_reachable_tools", {
        scope: null, object: null, query: null, limit: null, cursor: null, include_schema: null
      });
      expect(listed.result?.isError, JSON.stringify(listed).slice(0, 300)).not.toBe(true);
      const called = await f.call(f.aliceSession, "woo_call", {
        object: WIDGET, verb: "note_bump", args: ["hi"], operation_id: null
      });
      expect(called.result?.isError, JSON.stringify(called).slice(0, 300)).not.toBe(true);
      await f.settleAll();
      expect(await f.hits()).toBe(1);
    } finally {
      await f.close();
    }
  });
});
