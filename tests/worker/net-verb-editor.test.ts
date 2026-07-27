// The verb editor over Net (fake-DO lane).
//
// The editor's whole reason to be a $space with a world-held buffer is that the
// buffer survives you walking away (notes/2026-07-24-mcp-agent-legibility.md
// §7.4.1: "editor state in the connection dies; editor state in the world
// survives"). That claim had never been exercised anywhere but in-memory — no
// Net or worker test touched `edit_verb` — and over Net it was broken three
// times over:
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
//  3. `pause`/`save`/`abort` move the actor OUT of the editor, so the turn
//     commits in `room:the_verb_editor` while both reading and writing the
//     actor-cluster-owned session cell (the plan-time transition fold). The
//     mint-write branch of `authorizeSessionSubmit` validated the written
//     value but never recorded the committing room's session_presence
//     checkpoint as proof of the folded READ, so CO4 step 7 refused the
//     commit `rider_unattested` and the actor could never leave. Fixed by
//     composing the CO14 room-checkpoint proof with the write.
//  4. Once (3) let a save COMMIT, the commit was silently non-durable:
//     `programmerInstallVerb` (the editor-only install path) mutated the
//     planning world through `addVerb` without recording the authored verb
//     read/write the way the `*ForActor` builtins do, so the accepted
//     transcript carried NO verb cell and nothing rode to the target's
//     anchor scope — save reported ok while the live verb kept its old
//     body. Fixed by recording the page read and write there; the invoke
//     assertion below (the edited verb actually returns the new value) is
//     the regression net.
//
// All four failures were invisible to the in-memory tests, which is why this
// runs the whole loop through the authoritative Net turn path.
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
  it("runs the full edit loop, and gates physical movement on the primary session", async () => {
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
    /** Open an MCP session for the shared prog-key actor. Sessions are
     * primary by earliest start (primarySessionForActor), so the FIRST
     * session opened here owns the physical body. */
    const openSession = async (): Promise<string> => {
      const init = await mcp({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: {} }, { "mcp-token": "apikey:prog-key:prog-secret" });
      expect(init.status, JSON.stringify(init.body)).toBe(200);
      const sid = init.headers.get("mcp-session-id") as string;
      await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid });
      await settleAll();
      return sid;
    };
    const session = await openSession();

    /** One authoritative turn, settled. Returns the verb's structured result. */
    const callVerbAs = async (sid: string, object: string, verb: string, args: unknown[]) => {
      const r = await mcp({
        jsonrpc: "2.0", id: nextId++, method: "tools/call",
        params: { name: "woo_call", arguments: { object, verb, args } }
      }, { "mcp-session-id": sid });
      await settleAll();
      return r.body as Record<string, any>;
    };
    const callVerb = (object: string, verb: string, args: unknown[]) => callVerbAs(session, object, verb, args);
    const ok = (r: Record<string, any>, label: string) => {
      expect(r?.result?.isError, `${label}: ${JSON.stringify(r).slice(0, 500)}`).not.toBe(true);
      return r?.result?.structuredContent?.result ?? {};
    };
    const activeScopeOf = async (sid: string): Promise<string | null> => {
      const r = await mcp({
        jsonrpc: "2.0", id: nextId++, method: "tools/call",
        params: { name: "woo_list_reachable_tools", arguments: { scope: "active" } }
      }, { "mcp-session-id": sid });
      const payload = (r.body as any)?.result?.structuredContent?.result ?? {};
      return payload.activeScope ?? payload.active_scope ?? null;
    };
    const activeScope = () => activeScopeOf(session);
    const toolNamesOf = async (sid: string): Promise<string[]> => {
      const listed = await mcp({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }, { "mcp-session-id": sid });
      const names: string[] = [];
      let page: any = listed.body;
      for (;;) {
        names.push(...(page?.result?.tools ?? []).map((t: any) => t.name));
        const cursor = page?.result?.nextCursor;
        if (!cursor) break;
        page = (await mcp({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: { cursor } }, { "mcp-session-id": sid })).body;
      }
      return names;
    };
    const toolNames = () => toolNamesOf(session);
    /** The actor's PHYSICAL location, read authoritatively via eval at the
     * actor's own cluster — distinct from any session's active scope. */
    const physicalLocation = async (sid: string): Promise<string | null> => {
      const r = ok(await callVerbAs(sid, agent, "eval", ["return location(actor);", { mode: "stmts" }]), "eval location(actor)");
      return (r.value as string | null) ?? null;
    };

    // --- setup: an object the agent owns, carrying a verb worth editing ---
    const widget = ok(await callVerb(agent, "create", ["$thing", { name: "EditTarget", location: agent }]), "create").id as string;
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
    expect(await physicalLocation(session), "the primary session's body did not enter the editor").toBe(EDITOR);
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
    // Unrelated turns in between, then read it back: the buffer belongs to the
    // editor object, so it outlives the turn that wrote it.
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

    // --- 4. pause: leave the editor, buffer survives ------------------------
    // Defect 3: this commit used to be refused `rider_unattested`. The turn
    // commits in the editor's room scope while transitioning the session OUT,
    // and the room's session_presence checkpoint is the CO14 proof of the
    // folded session read.
    const paused = ok(await callVerb(EDITOR, "pause", []), "pause");
    expect(paused.paused).toBe(true);
    expect(paused.exited_to, "pause must return the actor to the previous room").toBe(homeRoom);
    expect(await activeScope(), "session scope did not follow the actor back out").toBe(homeRoom);
    expect(await physicalLocation(session), "the body did not leave the editor on pause").toBe(homeRoom);
    // Outside the editor its verbs are no longer reachable tools.
    const outside = await toolNames();
    for (const verb of ["view", "replace", "save", "pause", "abort"]) {
      expect(outside, `editor verb ${verb} still a tool after pause`).not.toContain(`${EDITOR}__${verb}`);
    }
    // A rejected or paused leave must not have written anything through.
    expect(ok(await callVerb(agent, "list_verb", [widget, "hi", {}]), "live verb after pause").source)
      .toContain("return 42");

    // --- 5. resume after pause keeps the paused buffer ----------------------
    const reentered = ok(await callVerb(agent, "edit_verb", [widget, "hi", {}]), "edit_verb (after pause)");
    expect(reentered.resumed, "re-entering after pause must resume, not restart").toBe(true);
    expect(await activeScope()).toBe(EDITOR);
    expect(ok(await callVerb(EDITOR, "view", [{}]), "view after pause+resume").buffer).toContain("return 99");

    // --- 6. save: write through and leave -----------------------------------
    const saved = ok(await callVerb(EDITOR, "save", []), "save");
    expect(saved.ok, `save did not install: ${JSON.stringify(saved).slice(0, 300)}`).toBe(true);
    expect(saved.exited_to, "save must return the actor to the previous room").toBe(homeRoom);
    expect(await activeScope(), "session scope did not leave on save").toBe(homeRoom);
    expect(await physicalLocation(session), "the body did not leave the editor on save").toBe(homeRoom);
    // The edited verb actually RUNS with the new behavior (via the eval
    // surface; authored bytecode verbs are intentionally not tool_exposed).
    // Dispatch pulls the target's verb page on miss, which also makes the
    // just-saved v2 visible to the metadata read that follows.
    const invoked = ok(await callVerb(agent, "eval", ["let o = contents(actor)[1]; return o:hi();", { mode: "stmts" }]), "invoke edited verb");
    expect(invoked.value, "the edited verb did not return the new value").toBe(99);
    const installed = ok(await callVerb(agent, "list_verb", [widget, "hi", {}]), "list_verb after save");
    expect(installed.source, "save did not write the edit through").toContain("return 99");

    // --- 7. a SECONDARY session must not drag the shared body along ---------
    // Session primacy is earliest-start, so this later session is secondary.
    // Entering the editor from it moves ITS scope and presence only; the
    // physical body stays where the primary session put it (moveto.md M2.1
    // step 7 — the same gate ordinary actor movement applies).
    const second = await openSession();
    expect(second).not.toBe(session);
    expect(await activeScopeOf(second), "the secondary session should start where the actor is").toBe(homeRoom);
    const enteredSecond = ok(await callVerbAs(second, agent, "edit_verb", [widget, "hi", {}]), "edit_verb (secondary)");
    expect(enteredSecond.editor).toBe(EDITOR);
    expect(await activeScopeOf(second), "the secondary session's scope must enter the editor").toBe(EDITOR);
    expect(await activeScopeOf(session), "the primary session's scope must not move").toBe(homeRoom);
    expect(await physicalLocation(session), "a secondary session physically moved the actor").toBe(homeRoom);
    // Editor tools are reachable only in the session that entered.
    expect(await toolNamesOf(second), "editor tools missing for the secondary session").toContain(`${EDITOR}__view`);
    expect(await toolNamesOf(session), "editor tools leaked into the primary session").not.toContain(`${EDITOR}__view`);
    // Leaving from the secondary session commits (the CO14 checkpoint proof
    // covers its session too) and still does not move the body.
    const pausedSecond = ok(await callVerbAs(second, EDITOR, "pause", []), "pause (secondary)");
    expect(pausedSecond.paused).toBe(true);
    expect(await activeScopeOf(second), "the secondary session's scope must leave the editor").toBe(homeRoom);
    expect(await physicalLocation(session), "a secondary session's pause physically moved the actor").toBe(homeRoom);

    await settleAll();
    for (const st of states) st.close();
  });
});
