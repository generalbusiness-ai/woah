// The verb editor over Net (fake-DO lane).
//
// The editor's whole reason to be a $space with a world-held buffer is that the
// buffer survives you walking away (notes/2026-07-24-mcp-agent-legibility.md
// §7.4.1: "editor state in the connection dies; editor state in the world
// survives"). That claim had never been exercised anywhere but in-memory — no
// Net or worker test touched `edit_verb` — and over Net it was broken twice:
//
//  1. `the_verb_editor` is a seed instance in its OWN scope, which an ordinary
//     turn never warms. It was simply absent from the turn's world, so
//     `isa(editor, $space)` answered false and edit_verb raised E_TYPE. Fixed
//     by declaring `{ref: ...}` authority prefetch on the verb.
//  2. For a space-like destination `updatePresence` sets the session's
//     activeScope as a side effect, so `moveEditorActor` saw from === to and
//     recorded no `session_scope` event. Over Net only that event becomes the
//     committed session-cell write the MCP active scope is read from, so the
//     actor entered the editor while its session still pointed at the old room
//     and every editor verb answered "tool is not available in this session
//     context". Fixed by capturing the prior scope before the presence update.
//
// Both failures were invisible to the in-memory tests, which is why this runs
// the whole loop through the authoritative Net turn path.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { createWorld } from "../../src/core/bootstrap";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-verb-editor-secret";
const EDITOR = "the_verb_editor";

function netState(name: string) {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const state: NetScopeDurableState & NetGatewayDurableState = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => { deferred.push(promise); },
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: () => {},
      deleteAlarm: () => {}
    }
  };
  return {
    state,
    settle: async () => { while (deferred.length > 0) await deferred.shift(); },
    close: () => fake.close()
  };
}

type Rpc = { jsonrpc: "2.0"; id?: number; method: string; params?: unknown };

describe("Verb editor over Net (fake-DO lane)", () => {
  it("enters, edits a world-held buffer, and pins the leave-the-editor gap", async () => {
    const agent = "prog_agent";
    const old = createWorld();
    old.createObject({ id: agent, parent: "$agent", owner: "$wiz", name: "ProgBot" });
    old.ensureApiKey("$wiz", agent, "prog-key", "prog-secret", "prog");
    old.setObjectFlags("$wiz", agent, { programmer: true });
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
      WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve, NET_GATEWAY_SELF: "gateway:net-api"
    } as NetGatewayEnv);

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
    const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { "mcp-token": "apikey:prog-key:prog-secret" });
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    const session = init.headers.get("mcp-session-id") as string;
    await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": session });
    await settleAll();

    /** One authoritative turn, settled. Returns the verb's structured result. */
    const callVerb = async (object: string, verb: string, args: unknown[]) => {
      const r = await mcp({
        jsonrpc: "2.0", id: nextId++, method: "tools/call",
        params: { name: "woo_call", arguments: { object, verb, args } }
      }, { "mcp-session-id": session });
      await settleAll();
      return r.body as Record<string, any>;
    };
    const ok = (r: Record<string, any>, label: string) => {
      expect(r?.result?.isError, `${label}: ${JSON.stringify(r).slice(0, 500)}`).not.toBe(true);
      return r?.result?.structuredContent?.result ?? {};
    };
    const activeScope = async (): Promise<string | null> => {
      const r = await mcp({
        jsonrpc: "2.0", id: nextId++, method: "tools/call",
        params: { name: "woo_list_reachable_tools", arguments: { scope: "active" } }
      }, { "mcp-session-id": session });
      const payload = (r.body as any)?.result?.structuredContent?.result ?? {};
      return payload.activeScope ?? payload.active_scope ?? null;
    };
    const toolNames = async (): Promise<string[]> => {
      const listed = await mcp({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }, { "mcp-session-id": session });
      const names: string[] = [];
      let page: any = listed.body;
      for (;;) {
        names.push(...(page?.result?.tools ?? []).map((t: any) => t.name));
        const cursor = page?.result?.nextCursor;
        if (!cursor) break;
        page = (await mcp({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: { cursor } }, { "mcp-session-id": session })).body;
      }
      return names;
    };

    // --- setup: an object the agent owns, carrying a verb worth editing ---
    const widget = ok(await callVerb(agent, "create", ["$thing", { name: "EditTarget" }]), "create").id as string;
    expect(widget).toBeTruthy();
    ok(await callVerb(agent, "install_verb", [widget, "hi", "verb :hi() rxd { return 42; }", {}]), "install_verb");
    const homeRoom = await activeScope();
    expect(homeRoom, "the agent should start in a room, not nowhere").toBeTruthy();
    expect(homeRoom).not.toBe(EDITOR);

    // --- 1. entering the editor moves the session, not just the body ---------
    const entered = ok(await callVerb(agent, "edit_verb", [widget, "hi", {}]), "edit_verb");
    expect(entered.resumed).toBe(false);
    expect(entered.editor).toBe(EDITOR);
    expect(entered.previous_location).toBe(homeRoom);
    // Defect 2: the body used to move while the session stayed behind. Both the
    // physical move and the session scope must land, or the editor's own verbs
    // never become reachable.
    expect(await activeScope(), "session scope did not follow the actor into the editor").toBe(EDITOR);
    const inEditor = await toolNames();
    for (const verb of ["view", "replace", "save", "pause", "abort"]) {
      expect(inEditor, `editor verb ${verb} is not a tool inside the editor`).toContain(`${EDITOR}__${verb}`);
    }

    // --- 2. edit the buffer -------------------------------------------------
    const replaced = ok(await callVerb(EDITOR, "replace", ["verb :hi() rxd { return 99; }"]), "replace");
    expect(replaced.dirty, "an edited buffer must be dirty").toBe(true);
    const viewed = ok(await callVerb(EDITOR, "view", [{}]), "view");
    expect(viewed.buffer).toContain("return 99");
    // The live verb is untouched until save (§7.4.3: compile is non-destructive).
    const stillOld = ok(await callVerb(agent, "list_verb", [widget, "hi", {}]), "list_verb mid-edit");
    expect(stillOld.source, "editing the buffer must not touch the live verb").toContain("return 42");

    // --- 3. the buffer is world-held, not call-held -------------------------
    // Unrelated turns in between, then read it back. This is the weaker half of
    // the §7.4.1 claim that survives today: the buffer belongs to the editor
    // object, so it outlives the turn that wrote it. (The stronger half —
    // surviving LEAVING — is blocked below.)
    ok(await callVerb(agent, "list_verb", [widget, "hi", {}]), "unrelated turn 1");
    ok(await callVerb(agent, "inspect", [widget, {}]), "unrelated turn 2");
    const later = ok(await callVerb(EDITOR, "view", [{}]), "view after unrelated turns");
    expect(later.buffer, "the buffer did not survive intervening turns").toContain("return 99");
    expect(later.dirty).toBe(true);

    // Re-entering the same target resumes rather than restarting, and does not
    // lose the edit.
    const resumed = ok(await callVerb(agent, "edit_verb", [widget, "hi", {}]), "edit_verb (resume)");
    expect(resumed.resumed, "re-entering must resume the existing session").toBe(true);
    expect(ok(await callVerb(EDITOR, "view", [{}]), "view after resume").buffer).toContain("return 99");

    // --- 4. DEFECT 3: leaving the editor cannot commit ----------------------
    // `pause` (like `save` and `abort`) moves the actor out of the editor. The
    // turn commits in `room:the_verb_editor` because that is the call target's
    // scope, and moving writes the session cell — which is owned by the actor's
    // cluster (CO14: session ids carry no lineage; their authority is the
    // actor's cluster). The room can normally prove a foreign session READ from
    // its own session_presence checkpoint, but authorizeSessionSubmit takes the
    // mint-write branch first and `continue`s, so the proof is never recorded
    // for a turn that both reads AND writes the cell. Result: terminal
    // `rider_unattested`.
    //
    // Ordinary room movement never hits this (verified: zero occurrences across
    // the movement tests), so this is specific to a room verb that moves the
    // actor OUT of the room whose scope it commits in. Fixing it is a design
    // call about where such turns commit, or about composing the proof with the
    // write — not a local patch, so it is pinned here rather than papered over.
    //
    // WHEN THAT LANDS: delete this block and restore the full loop — pause
    // returns to `homeRoom`, editor tools disappear, `edit_verb` resumes with
    // the buffer intact, `save` writes through to the live verb, and the edited
    // verb returns 99. This assertion FAILS once the defect is fixed, which is
    // the intended prompt to finish the job.
    const pauseAttempt = await callVerb(EDITOR, "pause", []);
    const pauseText = JSON.stringify(pauseAttempt);
    expect(pauseAttempt?.result?.isError, `pause unexpectedly succeeded — defect 3 is fixed, restore the full loop: ${pauseText.slice(0, 300)}`).toBe(true);
    expect(pauseText).toContain("rider_unattested");
    expect(pauseText).toContain(`room:${EDITOR}`);

    // The live verb is STILL untouched: a rejected leave must not have written
    // anything through.
    expect(ok(await callVerb(agent, "list_verb", [widget, "hi", {}]), "live verb after rejected pause").source)
      .toContain("return 42");

    await settleAll();
    for (const st of states) st.close();
  });
});
