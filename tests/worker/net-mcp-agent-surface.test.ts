// MCP agent-surface legibility (fake-DO lane, installed world).
//
// Two findings from notes/2026-07-24-mcp-agent-legibility.md are pinned here
// so they cannot regress silently:
//
//   L1.2 (§3.7) The session actor's own tools — its "suit" — must appear on
//   the FIRST tools/list page whatever its id is. The old plain-localeCompare
//   ordering stranded any actor sorting past the 128-tool page cap behind the
//   room's own objects, and a client that does not page never saw them.
//
//   L1.3 (§3.6) The seeded $help topics must not name tools that are absent
//   from the live MCP surface. Asserted against the actual tools/list names
//   rather than a hardcoded list, so the test cannot rot the way the topics
//   themselves did.
//
// The actor id `zz_stranded_agent` is deliberate: it sorts after every seeded
// demo object (`the_outline`, `the_dubspace`, `the_chatroom`, ...), which is
// exactly the case the old ordering lost.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { createWorld } from "../../src/core/bootstrap";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-mcp-agent-surface-secret";
const STRANDED_ACTOR = "zz_stranded_agent";
// Mirrors MCP_STANDARD_TOOL_PAGE and MCP_TOOL_DEFS.length in gateway-do.ts.
const MCP_PAGE = 128;
const MCP_STATIC_TOOLS = 3;

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

describe("MCP agent surface: actor tool ordering and help-topic accuracy", () => {
  it("puts the session actor's own tools on page 1 and serves help topics that name only live tools", async () => {
    // Mint an actor whose id sorts after every demo object, carried through
    // the install so it is born present in the chatroom alongside the_outline.
    const old = createWorld();
    old.createObject({
      id: STRANDED_ACTOR,
      name: "ZZ Stranded Agent",
      parent: "$player",
      owner: "$wiz",
      location: "$nowhere"
    });
    old.ensureApiKey("$wiz", STRANDED_ACTOR, "zz-key", "zz-secret", "zz");
    const identity = exportIdentity(old.exportWorld());
    const plan = await planNetInstall({
      graft: async (fresh) => {
        importIdentity(fresh, identity);
      }
    });

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
      const seeded = await instance.fetch(await signInternalRequest(scopeEnv, request));
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
      for (const st of states) await st.settle();
      for (const scope of scopeDOs.values()) await scope.alarm();
      for (const st of states) await st.settle();
    };

    let nextId = 10;
    const mcp = async (body: Rpc, headers: Record<string, string> = {}) => {
      const response = await gateway.fetch(
        new Request("https://do/net-api/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body)
        })
      );
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null as any };
    };

    const init = await mcp(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { "mcp-token": "apikey:zz-key:zz-secret" }
    );
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    const session = init.headers.get("mcp-session-id") as string;
    expect(session).toBeTruthy();
    expect((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": session })).status)
      .toBe(202);
    await settleAll();

    // --- L1.2: the suit is on page 1 -------------------------------------
    const firstPage = await mcp(
      { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} },
      { "mcp-session-id": session }
    );
    expect(firstPage.status, JSON.stringify(firstPage.body)).toBe(200);
    const firstPageNames: string[] = firstPage.body?.result?.tools?.map((tool: { name: string }) => tool.name) ?? [];
    const ownTools = firstPageNames.filter((name) => name.startsWith(`${STRANDED_ACTOR}__`));
    expect(ownTools.length, `page 1 held no ${STRANDED_ACTOR}__* tools: ${firstPageNames.join(", ")}`)
      .toBeGreaterThan(0);

    // Page through the rest so the ordering claim can be checked against the
    // complete listing.
    const allNames: string[] = [...firstPageNames];
    let cursor: string | undefined = firstPage.body?.result?.nextCursor;
    // The premise of the whole assertion: this world really does page. If the
    // demo world ever shrinks below the page cap the ordering check would pass
    // trivially, so fail loudly instead of quietly proving nothing.
    expect(cursor, "installed world no longer exceeds one tools/list page").toBeTruthy();
    while (cursor) {
      const page = await mcp(
        { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: { cursor } },
        { "mcp-session-id": session }
      );
      expect(page.status).toBe(200);
      allNames.push(...(page.body?.result?.tools?.map((tool: { name: string }) => tool.name) ?? []));
      cursor = page.body?.result?.nextCursor;
    }
    // Guard the premise: an object sorting BEFORE the actor is present, so the
    // test would actually have failed under plain alphabetical ordering.
    expect(allNames.some((name) => name.startsWith("the_"))).toBe(true);

    // The walkthrough's "128 vs 142" count mismatch, stated as an invariant.
    // tools/list pages at MCP_PAGE INCLUDING the woo_* controls;
    // woo_list_reachable_tools `total` counts dynamic descriptors with no cap.
    // Nothing is filtered differently — a reader comparing page 1 against the
    // pager total is comparing a page to a total.
    expect(firstPageNames.length, "the first page is no longer capped").toBe(MCP_PAGE);
    const pager = await mcp(
      { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: "woo_list_reachable_tools", arguments: { scope: "active", limit: 1 } } },
      { "mcp-session-id": session }
    );
    const pagerTotal = pager.body?.result?.structuredContent?.result?.total as number;
    expect(allNames.length - MCP_STATIC_TOOLS, `pager total ${pagerTotal} does not reconcile with the full listing`)
      .toBe(pagerTotal);
    expect(pagerTotal, "the fixture no longer reproduces the page-vs-total gap").toBeGreaterThan(MCP_PAGE - MCP_STATIC_TOOLS);

    // PRECEDENCE is the actual guarantee (spec M2.2): the actor's tools are a
    // contiguous block at the head of the dynamic listing, directly after the
    // stable woo_* controls. Completeness on page 1 is a *consequence* that
    // holds only while the suit fits — nothing bounds how many verbs a class
    // chain plus features can contribute, so asserting "page 1 always holds the
    // whole suit" would be asserting something the design cannot deliver.
    const isOwn = (name: string) => name.startsWith(`${STRANDED_ACTOR}__`);
    const dynamic = allNames.filter((name) => !name.startsWith("woo_"));
    const allOwnTools = dynamic.filter(isOwn);
    expect(allOwnTools.length).toBeGreaterThan(0);
    expect(
      dynamic.slice(0, allOwnTools.length),
      "the actor's tools are not the contiguous head of the dynamic listing"
    ).toEqual(allOwnTools);

    // ...and in this world the suit does fit, so page 1 carries all of it. If a
    // future demo actor outgrows one page this assertion is the one to relax —
    // the precedence check above is the contract.
    expect(allOwnTools.length).toBeLessThan(MCP_PAGE - MCP_STATIC_TOOLS);
    expect(new Set(ownTools)).toEqual(new Set(allOwnTools));

    // --- L1.3: help topics name only tools that exist --------------------
    const liveToolNames = new Set(allNames);
    const helpTopic = async (topic: string): Promise<string> => {
      const result = await mcp(
        {
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: { name: "woo_call", arguments: { object: STRANDED_ACTOR, verb: "help", args: [topic] } }
        },
        { "mcp-session-id": session }
      );
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      return JSON.stringify(result.body);
    };

    // No topic may name a tool that is not on the live surface. Two kinds of
    // claim, and BOTH must be checked — an earlier version of this test scanned
    // only the woo_* kind and therefore shipped four false <you>__* claims:
    //
    //   woo_*        the static protocol controls;
    //   <you>__verb  a verb tool on the session actor. Note that being a verb
    //                on the actor is NOT enough to be a tool: only bytecode
    //                pages are advertised, so every native verb (focus,
    //                unfocus, focus_list, wait) has no tool at all.
    //
    // `<object>__<verb>` is naming guidance rather than a claim — its verb half
    // is a placeholder, so the pattern below does not match it. A topic is
    // allowed to name an absent tool only to deny it exists, so sentences
    // containing "There is no" are dropped before scanning.
    const scanned = ["focus", "wait", "tools", "self", "suit", "me", "building", "index", "commands"];
    for (const topic of scanned) {
      const rendered = await helpTopic(topic);
      const claims = rendered
        .split(/(?<=\.)\s+|\\n/)
        .filter((sentence) => !sentence.includes("There is no"))
        .join(" ");
      for (const name of claims.match(/\bwoo_[a-z_]+/g) ?? []) {
        expect(liveToolNames.has(name), `help "${topic}" names absent tool ${name}`).toBe(true);
      }
      for (const match of claims.matchAll(/<(?:you|object)>__([a-z][a-z0-9_]*)/g)) {
        const claimed = `${STRANDED_ACTOR}__${match[1]}`;
        expect(
          liveToolNames.has(claimed),
          `help "${topic}" claims a verb tool <you>__${match[1]} that the surface does not publish`
        ).toBe(true);
      }
    }

    // Same rule for the scope vocabulary the `tools` topic teaches. The `all`
    // scope was retired (Big-World forbids global enumeration) while this topic
    // still named it — a nonexistent-capability claim of exactly the kind the
    // woo_* check above catches, but one that check cannot see. Every scope the
    // topic names must actually be accepted.
    const toolsTopic = await helpTopic("tools");
    const scopeSentence = /scope is one of ([^.]+)\./.exec(toolsTopic);
    expect(scopeSentence, "the tools topic no longer lists scopes in the expected form").toBeTruthy();
    const namedScopes = (scopeSentence as RegExpExecArray)[1]
      .split(/,|\bor\b/)
      .map((word) => word.trim())
      .filter(Boolean);
    expect(namedScopes.length).toBeGreaterThan(0);
    for (const scope of namedScopes) {
      const probe = await mcp(
        {
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: { name: "woo_list_reachable_tools", arguments: { scope } }
        },
        { "mcp-session-id": session }
      );
      expect(probe.status).toBe(200);
      expect(probe.body?.result?.isError, `help "tools" names rejected scope "${scope}"`).not.toBe(true);
    }

    // The specific v0.1.1 defects, stated positively.
    const focus = await helpTopic("focus");
    expect(focus).toContain("no woo_focus");
    expect(focus).not.toContain("Use woo_focus(");
    const wait = await helpTopic("wait");
    expect(wait).toContain("woo_wait(timeout_ms, limit)");
    // The new orientation topics resolve, including the aliases.
    for (const topic of ["self", "suit", "me", "tools"]) {
      expect(await helpTopic(topic)).toContain("<object>__<verb>");
    }

    // Drain deferred work before closing the fake storage. Without this the
    // test still passes, but queued fanout/outbox tasks resume against closed
    // databases — logging "database is not open" and net_deferred_task_error,
    // and leaking async work into whatever runs next in this worker.
    await settleAll();
    for (const st of states) st.close();
  });
});
