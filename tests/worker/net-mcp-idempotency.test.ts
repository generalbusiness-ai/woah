// MCP mutation retry safety (CO2.5 / mcp.md §M4.2), fake-DO lane.
//
// The defect this pins: the MCP tool-call path minted a fresh idempotency
// key per HTTP request, so a mutation whose response was lost executed AGAIN
// on the client's retry. Every assertion below is on WORLD STATE (a counter
// the verb increments), not on reply shape alone — a fix that deduplicates
// the reply while letting the effect happen twice must fail here.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { createWorld } from "../../src/core/bootstrap";
import { installVerb } from "../../src/core/authoring";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-mcp-idempotency-secret";

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

/**
 * A one-actor world whose `the_mug` carries a counter verb.
 *
 * `bump` is an ordinary bytecode verb with no command metadata, so it routes
 * `sequenced` (the fail-safe default) and its write set makes it MUTATING —
 * exactly the shape the operation id exists to protect. `hits` is the world
 * state every assertion reads back.
 */
async function fixture() {
  const old = createWorld();
  const alice = old.auth("guest:idem-alice").actor;
  const bob = old.auth("guest:idem-bob").actor;
  old.ensureApiKey("$wiz", alice, "idem-key-a", "idem-secret-a", "alice");
  old.ensureApiKey("$wiz", bob, "idem-key-b", "idem-secret-b", "bob");
  const identity = exportIdentity(old.exportWorld());
  const plan = await planNetInstall({
    graft: async (fresh) => {
      importIdentity(fresh, identity);
      fresh.setProp("the_mug", "hits", 0);
      expect(installVerb(
        fresh,
        "the_mug",
        "bump",
        "verb :bump() rxd { this.hits = this.hits + 1; return this.hits; }",
        null
      ).ok).toBe(true);
      // Emits, then throws. The transcript still COMMITS (a refused verb
      // consumed its seq), so the emitted line is real and the submitter's
      // only copy of it is the turn reply — woo_wait suppresses its own echo.
      expect(installVerb(
        fresh,
        "the_mug",
        "complain",
        "verb :complain() rxd { this.hits = this.hits + 1;"
        + " observe({ type: \"complained\", text: \"before the fall\", source: this });"
        + " raise({ code: \"E_PERM\", message: \"refused on purpose\" }); }",
        null
      ).ok).toBe(true);
      expect(installVerb(
        fresh,
        "the_mug",
        "hits_now",
        "verb :hits_now() rxd { return this.hits; }",
        null
      ).ok).toBe(true);
    }
  });

  const states: Array<ReturnType<typeof netState>> = [];
  const scopeDOs = new Map<string, NetScopeDO>();
  /** Per-scope DO state, so a test can reach the authority's own SQL (the
   * recorded-reply table) instead of only its wire surface. */
  const scopeStates = new Map<string, ReturnType<typeof netState>>();
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

  let nextId = 100;
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
  /** One tools/call. `meta` rides `params._meta` (the protocol carrier). */
  const call = async (
    session: string,
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>
  ) => (await mcp(
    { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } },
    { "mcp-session-id": session }
  )).body as Record<string, any>;

  const aliceSession = await open("apikey:idem-key-a:idem-secret-a");
  const bobSession = await open("apikey:idem-key-b:idem-secret-b");
  await settleAll();

  /** The counter, read back through the real turn path. */
  const hits = async (session = aliceSession): Promise<number> => {
    const read = await call(session, "woo_call", { object: "the_mug", verb: "hits_now", args: [] });
    expect(read.result?.isError, JSON.stringify(read).slice(0, 400)).not.toBe(true);
    return read.result?.structuredContent?.result as number;
  };
  /** Drain a session's queue and return every observation seen. */
  const drain = async (session: string): Promise<Record<string, any>[]> => {
    const seen: Record<string, any>[] = [];
    for (;;) {
      const waited = await call(session, "woo_wait", { timeout_ms: 0, limit: 100 });
      const batch = waited.result?.structuredContent?.result?.observations ?? [];
      if (batch.length === 0) return seen;
      seen.push(...batch);
    }
  };
  const say = async (session: string, text: string, operationId?: string) =>
    await call(session, "woo_call", {
      object: "the_chatroom",
      verb: "say",
      args: [text],
      ...(operationId ? { operation_id: operationId } : {})
    });

  const complain = async (session: string, operationId?: string) =>
    await call(session, "woo_call", {
      object: "the_mug",
      verb: "complain",
      args: [],
      ...(operationId ? { operation_id: operationId } : {})
    });

  const bump = async (session: string, operationId?: string, viaMeta = false) =>
    viaMeta
      ? await call(session, "woo_call", { object: "the_mug", verb: "bump", args: [] }, { "woo.net/operation_id": operationId })
      : await call(session, "woo_call", {
          object: "the_mug",
          verb: "bump",
          args: [],
          ...(operationId ? { operation_id: operationId } : {})
        });

  return {
    alice, bob, aliceSession, bobSession, gateway: () => gateway, gatewayState, gatewayEnv, scopeStates,
    /** Evict a scope DO: a fresh instance over the SAME durable state, so it
     * rehydrates its reply cache from SQL instead of keeping the live map.
     * `resolve` reads the map at call time, so the swap is enough. */
    reviveScope: (scope: string) => {
      const st = scopeStates.get(scope);
      if (!st) throw new Error(`no state for scope ${scope}`);
      scopeDOs.set(scope, new NetScopeDO(st.state, scopeEnv));
    },
    mcp, call, hits, bump, say, complain, drain, settleAll,
    close: () => { for (const st of states) st.close(); }
  };
}

describe("MCP mutation retry safety (CO2.5 / M4.2)", () => {
  it("a retry under the same operation_id commits ONCE and learns the outcome", async () => {
    const f = await fixture();
    try {
      expect(await f.hits()).toBe(0);

      // The commit that succeeds.
      const first = await f.bump(f.aliceSession, "order-1");
      expect(first.result?.isError, JSON.stringify(first).slice(0, 400)).not.toBe(true);
      expect(first.result?.structuredContent?.result).toBe(1);
      expect(first.result?.structuredContent?.replayed).toBeUndefined();
      await f.settleAll();
      expect(await f.hits()).toBe(1);

      // FAULT INJECTION: the response above is now treated as lost — the
      // client never saw it and cannot know whether the mutation landed. Its
      // only safe move is to retry the identical call under the identical
      // operation id. (What this lane models is the client's view: commit
      // durable at the authority, outcome unknown to the caller. It does not
      // model a mid-flight DO eviction; the cold-gateway case is the next
      // test, which retries through a second gateway instance.)
      const retry = await f.bump(f.aliceSession, "order-1");
      await f.settleAll();

      // 1. The effect happened exactly once.
      expect(await f.hits()).toBe(1);
      // 2. The retry LEARNS the outcome — the recorded return value of the
      //    execution that committed, not a re-planned guess and not null.
      expect(retry.result?.isError, JSON.stringify(retry).slice(0, 400)).not.toBe(true);
      expect(retry.result?.structuredContent?.result).toBe(1);
      expect(retry.result?.structuredContent?.replayed).toBe(true);
      expect(retry.result?.structuredContent?.replay_outcome).toBe("full");
      // 3. And it is told, in prose an agent will read, not to retry again
      //    under a new id.
      const notice = (retry.result?.content ?? []).map((block: any) => block.text).join(" ");
      expect(notice).toContain("ran exactly once");
      expect(notice).toContain("Do not retry it under a new operation_id");
    } finally {
      f.close();
    }
  });

  it("replays through a COLD gateway instance: the guarantee is the authority's, not one shard's memory", async () => {
    const f = await fixture();
    try {
      expect((await f.bump(f.aliceSession, "cold-1")).result?.structuredContent?.result).toBe(1);
      await f.settleAll();
      expect(await f.hits()).toBe(1);

      // A gateway DO eviction is exactly the failure that loses a response.
      // A fresh instance over the SAME durable state must still replay,
      // because the recorded reply lives at the committing scope.
      const revived = new NetGatewayDO(f.gatewayState.state, f.gatewayEnv);
      const response = await revived.fetch(new Request("https://do/net-api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-session-id": f.aliceSession },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9001,
          method: "tools/call",
          params: {
            name: "woo_call",
            arguments: { object: "the_mug", verb: "bump", args: [], operation_id: "cold-1" }
          }
        })
      }));
      const body = await response.json() as Record<string, any>;
      await f.settleAll();
      expect(body.result?.isError, JSON.stringify(body).slice(0, 500)).not.toBe(true);
      expect(body.result?.structuredContent?.replayed).toBe(true);
      expect(body.result?.structuredContent?.result).toBe(1);
      expect(await f.hits()).toBe(1);
    } finally {
      f.close();
    }
  });

  it("the KEY is what dedupes: different operation ids execute twice", async () => {
    const f = await fixture();
    try {
      expect((await f.bump(f.aliceSession, "op-a")).result?.structuredContent?.result).toBe(1);
      await f.settleAll();
      const second = await f.bump(f.aliceSession, "op-b");
      await f.settleAll();
      expect(second.result?.structuredContent?.result).toBe(2);
      expect(second.result?.structuredContent?.replayed).toBeUndefined();
      expect(await f.hits()).toBe(2);
    } finally {
      f.close();
    }
  });

  it("no operation id: unchanged behaviour — every call is a new turn", async () => {
    const f = await fixture();
    try {
      expect((await f.bump(f.aliceSession)).result?.structuredContent?.result).toBe(1);
      await f.settleAll();
      expect((await f.bump(f.aliceSession)).result?.structuredContent?.result).toBe(2);
      await f.settleAll();
      expect(await f.hits()).toBe(2);
    } finally {
      f.close();
    }
  });

  it("the `_meta` carrier works, and outranks the argument form", async () => {
    const f = await fixture();
    try {
      expect((await f.bump(f.aliceSession, "meta-1", true)).result?.structuredContent?.result).toBe(1);
      await f.settleAll();
      const retry = await f.bump(f.aliceSession, "meta-1", true);
      await f.settleAll();
      expect(retry.result?.structuredContent?.replayed).toBe(true);
      expect(await f.hits()).toBe(1);

      // Precedence: `_meta` is the protocol-level carrier and wins, so this
      // call replays "meta-1" and the argument's "meta-other" is ignored.
      const mixed = await f.call(
        f.aliceSession,
        "woo_call",
        { object: "the_mug", verb: "bump", args: [], operation_id: "meta-other" },
        { "woo.net/operation_id": "meta-1" }
      );
      await f.settleAll();
      expect(mixed.result?.structuredContent?.replayed).toBe(true);
      expect(await f.hits()).toBe(1);
    } finally {
      f.close();
    }
  });

  it("operation ids are namespaced per actor: two agents choosing the same string do not collide", async () => {
    const f = await fixture();
    try {
      expect((await f.bump(f.aliceSession, "shared")).result?.structuredContent?.result).toBe(1);
      await f.settleAll();
      // Bob picks the same obvious string. His call is a DIFFERENT operation
      // and must run; he must also never receive Alice's recorded outcome.
      const bobs = await f.bump(f.bobSession, "shared");
      await f.settleAll();
      expect(bobs.result?.isError, JSON.stringify(bobs).slice(0, 400)).not.toBe(true);
      expect(bobs.result?.structuredContent?.replayed).toBeUndefined();
      expect(bobs.result?.structuredContent?.result).toBe(2);
      expect(await f.hits()).toBe(2);
    } finally {
      f.close();
    }
  });

  // FINDING 1. `say` is `persistence:"live"` — a DIRECT turn that writes no
  // authority cell. The scope classifies that as a pure read and does not
  // cache it, so before the receipt a retry re-emitted the line to every
  // peer. The advertised schema promises deduplication for anything that
  // changes the world, and speech changes what peers perceive.
  it("an observation-only act is deduplicated: the PEER hears it exactly once", async () => {
    const f = await fixture();
    try {
      await f.drain(f.bobSession); // presence noise from session mint
      const text = "retry-safety-line";
      const first = await f.say(f.aliceSession, text, "speak-1");
      expect(first.result?.isError, JSON.stringify(first).slice(0, 400)).not.toBe(true);
      expect(first.result?.structuredContent?.replayed).toBeUndefined();
      await f.settleAll();

      // Response lost; the client retries the identical call.
      const retry = await f.say(f.aliceSession, text, "speak-1");
      await f.settleAll();

      // The assertion that matters, and deliberately FIRST so it is the one
      // that fires when the receipt regresses: BOB, the peer, heard the line
      // exactly once.
      const heard = await f.drain(f.bobSession);
      const lines = heard.filter((obs) => obs?.type === "said" && String(obs.text ?? "").includes(text));
      expect(lines.length, `peer heard ${lines.length} copies: ${JSON.stringify(heard).slice(0, 500)}`).toBe(1);
      expect(retry.result?.structuredContent?.replayed).toBe(true);
      expect(retry.result?.structuredContent?.replay_outcome).toBe("full");
    } finally {
      f.close();
    }
  });

  it("an unkeyed observation-only act still re-emits: the receipt is the client's opt-in", async () => {
    const f = await fixture();
    try {
      await f.drain(f.bobSession);
      const text = "unkeyed-line";
      // No operation id. This is the pre-existing, write-free path that the
      // browser's per-turn minted keys depend on — the scope records nothing
      // and the second call is genuinely a second act, not a lost retry.
      await f.say(f.aliceSession, text);
      await f.settleAll();
      await f.say(f.aliceSession, text);
      await f.settleAll();
      const heard = await f.drain(f.bobSession);
      const lines = heard.filter((obs) => obs?.type === "said" && String(obs.text ?? "").includes(text));
      expect(lines.length).toBe(2);
    } finally {
      f.close();
    }
  });

  // FINDING 2. A key answers ONE request. Reusing it for a different call
  // used to return the first call's reply as though it were this call's —
  // a confidently wrong answer, worse than the double execution keys prevent.
  it("refuses key reuse for a DIFFERENT call, with its own conflict code", async () => {
    const f = await fixture();
    try {
      expect((await f.bump(f.aliceSession, "reuse-1")).result?.structuredContent?.result).toBe(1);
      await f.settleAll();

      const conflict = async (args: Record<string, unknown>) => {
        const response = await f.call(f.aliceSession, "woo_call", { ...args, operation_id: "reuse-1" });
        await f.settleAll();
        return response;
      };
      // Changed ARGUMENTS.
      const changedArgs = await conflict({ object: "the_mug", verb: "bump", args: ["extra"] });
      expect(changedArgs.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "E_IDEMPOTENCY_CONFLICT", detail: { reason: "operation_id_reused" } } }
      });
      // The refusal must not leak the original call it collided with.
      expect(JSON.stringify(changedArgs.result)).not.toContain("hits");
      // Changed VERB.
      expect((await conflict({ object: "the_mug", verb: "hits_now", args: [] })).result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "E_IDEMPOTENCY_CONFLICT" } }
      });
      // Changed TARGET.
      expect((await conflict({ object: "the_chatroom", verb: "look", args: [] })).result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "E_IDEMPOTENCY_CONFLICT" } }
      });

      // The conflicts changed nothing, and — critically — did not clobber
      // the receipt: the ORIGINAL call still replays its recorded outcome.
      expect(await f.hits()).toBe(1);
      const original = await f.bump(f.aliceSession, "reuse-1");
      expect(original.result?.structuredContent?.replayed).toBe(true);
      expect(original.result?.structuredContent?.result).toBe(1);
      expect(await f.hits()).toBe(1);
    } finally {
      f.close();
    }
  });

  it("an ALIAS of the same verb is the same request, not a conflict", async () => {
    const f = await fixture();
    try {
      // `go` carries movement aliases; the MCP resolver maps an alias to the
      // canonical verb before the turn is built, so both spellings must
      // fingerprint identically. A conflict here would break every client
      // that retried using a different spelling than its first attempt.
      const listed = await f.mcp(
        { jsonrpc: "2.0", id: 4242, method: "tools/list", params: {} },
        { "mcp-session-id": f.aliceSession }
      );
      const aliased = (listed.body?.result?.tools ?? []).length > 0;
      expect(aliased).toBe(true);
      // `look` on the chatroom is reachable by its canonical name and by the
      // alias the catalog declares for it (`l`), if present.
      const canonical = await f.call(f.aliceSession, "woo_call", {
        object: "the_chatroom", verb: "look", args: [], operation_id: "alias-1"
      });
      expect(canonical.result?.isError, JSON.stringify(canonical).slice(0, 300)).not.toBe(true);
      await f.settleAll();
      const viaAlias = await f.call(f.aliceSession, "woo_call", {
        object: "the_chatroom", verb: "l", args: [], operation_id: "alias-1"
      });
      await f.settleAll();
      // Either the alias resolves (then it replays cleanly) or the world has
      // no such alias (then it is a plain verb miss) — but it must NEVER be
      // an idempotency conflict, which would mean the fingerprint keyed on
      // the client's spelling instead of the resolved call.
      const error = viaAlias.result?.structuredContent?.error;
      expect(error?.code).not.toBe("E_IDEMPOTENCY_CONFLICT");
      if (!viaAlias.result?.isError) {
        expect(viaAlias.result?.structuredContent?.replayed).toBe(true);
      }
    } finally {
      f.close();
    }
  });

  it("the fingerprint is durable: a COLD gateway still detects key reuse", async () => {
    const f = await fixture();
    try {
      expect((await f.bump(f.aliceSession, "cold-conflict")).result?.structuredContent?.result).toBe(1);
      await f.settleAll();
      // The conflict check lives at the authority and rides the stored reply
      // row, so a gateway that lost every byte of in-isolate memory still
      // refuses. An in-memory check would pass this call straight through.
      const revived = new NetGatewayDO(f.gatewayState.state, f.gatewayEnv);
      const response = await revived.fetch(new Request("https://do/net-api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "mcp-session-id": f.aliceSession },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9100,
          method: "tools/call",
          params: {
            name: "woo_call",
            arguments: { object: "the_mug", verb: "bump", args: ["different"], operation_id: "cold-conflict" }
          }
        })
      }));
      const body = await response.json() as Record<string, any>;
      await f.settleAll();
      expect(body.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "E_IDEMPOTENCY_CONFLICT" } }
      });
      expect(await f.hits()).toBe(1);
    } finally {
      f.close();
    }
  });

  // Failed behavior is atomic: its domain observation and write are rolled
  // back, while the canonical error outcome still occupies the one committed
  // turn. Exact retries replay that outcome without executing the verb again.
  it("a failed turn rolls back domain effects and replays one canonical error", async () => {
    const f = await fixture();
    try {
      const failed = await f.complain(f.aliceSession, "fail-1");
      await f.settleAll();
      expect(failed.result?.isError).toBe(true);
      expect(failed.result?.structuredContent?.error).toMatchObject({ code: "E_PERM" });
      const lines = (failed.result?.structuredContent?.observations ?? []) as Record<string, any>[];
      expect(lines.some((obs) => obs?.type === "complained")).toBe(false);
      expect(lines.filter((obs) => obs?.type === "$error")).toHaveLength(1);
      // The rolled-back domain line is not waiting in the queue either.
      const queued = await f.drain(f.aliceSession);
      expect(queued.some((obs) => obs?.type === "complained")).toBe(false);

      // A replay returns the same canonical failure and says it is a replay —
      // otherwise a client seeing an error cannot tell whether its retry ran
      // again.
      const replayed = await f.complain(f.aliceSession, "fail-1");
      await f.settleAll();
      expect(replayed.result?.isError).toBe(true);
      expect(replayed.result?.structuredContent?.replayed).toBe(true);
      expect(replayed.result?.structuredContent?.error).toMatchObject({ code: "E_PERM" });
      const replayedLines = (replayed.result?.structuredContent?.observations ?? []) as Record<string, any>[];
      expect(replayedLines.some((obs) => obs?.type === "complained")).toBe(false);
      expect(replayedLines.filter((obs) => obs?.type === "$error")).toHaveLength(1);
      expect(await f.hits()).toBe(0);
    } finally {
      f.close();
    }
  });

  it("a malformed operation id is refused, never silently downgraded to a fresh key", async () => {
    const f = await fixture();
    try {
      const bad = await f.call(f.aliceSession, "woo_call", {
        object: "the_mug",
        verb: "bump",
        args: [],
        operation_id: "has spaces and 🙂"
      });
      expect(bad.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "E_INVARG", detail: { reason: "invalid_operation_id" } } }
      });
      // Refused BEFORE the turn: nothing committed.
      await f.settleAll();
      expect(await f.hits()).toBe(0);
    } finally {
      f.close();
    }
  });

  // FINDING 5. Every woo_wait parked a closure and a live timer in an
  // unbounded per-session set, and notifications/cancelled was swallowed by
  // the blanket 202 — a resource-exhaustion vector on a public surface with
  // no way for a client to reclaim its own slots.
  it("bounds parked woo_wait calls per session and names the refusal", async () => {
    const f = await fixture();
    try {
      await f.drain(f.aliceSession);
      // Park the cap. Each stays parked because the queue is empty.
      const parked = [1, 2, 3, 4].map((n) =>
        f.mcp(
          { jsonrpc: "2.0", id: 700 + n, method: "tools/call", params: { name: "woo_wait", arguments: { timeout_ms: 20_000 } } },
          { "mcp-session-id": f.aliceSession }
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const over = await f.call(f.aliceSession, "woo_wait", { timeout_ms: 20_000 });
      expect(over.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "E_WAIT_LIMIT", detail: { reason: "wait_concurrency", limit: 4 } } }
      });

      // Cancellation releases exactly the request it names, and resolves it
      // WITHOUT draining — a client that walked away must not consume rows
      // into a reply nobody reads, nor advance the M5.1 drain watermark.
      //
      // The assertion is on ELAPSED TIME, deliberately. An ignored
      // cancellation also resolves with no observations — by timing out 20s
      // later — so a shape-only assertion would pass against a server that
      // dropped the notification entirely. Prompt resolution is the only
      // thing that distinguishes the two.
      const startedAt = Date.now();
      await f.mcp(
        { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 701 } },
        { "mcp-session-id": f.aliceSession }
      );
      const cancelled = await parked[0];
      const elapsed = Date.now() - startedAt;
      expect(elapsed, `cancellation took ${elapsed}ms — the park was not released`).toBeLessThan(5_000);
      expect(cancelled.body?.result?.structuredContent?.result?.observations).toEqual([]);

      // The slot is free again: a call that was refused a moment ago is
      // accepted now. (timeout_ms 0 returns immediately, so it parks nothing.)
      const reclaimed = await f.call(f.aliceSession, "woo_wait", { timeout_ms: 0 });
      expect(reclaimed.result?.isError).not.toBe(true);

      // The other three are still parked and still functional: a delivery
      // wakes them and exactly one carries the row, with nothing lost to the
      // cancellation.
      (f.gateway() as any).mcpEnqueue(f.aliceSession, [{ type: "kept" }]);
      const settled = await Promise.all(parked.slice(1));
      const delivered = settled.flatMap(
        (response) => response.body?.result?.structuredContent?.result?.observations ?? []
      );
      expect(delivered).toEqual([{ type: "kept" }]);
    } finally {
      f.close();
    }
  });

  it("a timed-out woo_wait releases its slot", async () => {
    const f = await fixture();
    try {
      await f.drain(f.aliceSession);
      // Four short parks that all expire; if the timeout path leaked its
      // waiter, the fifth call would be refused.
      await Promise.all([1, 2, 3, 4].map(() => f.call(f.aliceSession, "woo_wait", { timeout_ms: 5 })));
      const after = await f.call(f.aliceSession, "woo_wait", { timeout_ms: 5 });
      expect(after.result?.isError).not.toBe(true);
      expect(after.result?.structuredContent?.result?.observations).toEqual([]);
    } finally {
      f.close();
    }
  });

  it("advertises operation_id on woo_call and on dynamic tools", async () => {
    const f = await fixture();
    try {
      const listed = await f.mcp(
        { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} },
        { "mcp-session-id": f.aliceSession }
      );
      const tools = listed.body?.result?.tools ?? [];
      const wooCall = tools.find((tool: any) => tool.name === "woo_call");
      expect(wooCall?.inputSchema?.properties?.operation_id?.type).toBe("string");
      // Dynamic tools carry it too — an agent that only ever sees dynamic
      // names must still be able to retry safely.
      const dynamic = tools.find((tool: any) => tool.name?.includes("__") && tool.inputSchema?.properties);
      expect(dynamic?.inputSchema?.properties?.operation_id?.type).toBe("string");
      // It is never `required`: an existing client that has never heard of
      // it keeps working exactly as before.
      expect(wooCall?.inputSchema?.required ?? []).not.toContain("operation_id");

      // The discovery control advertises the SAME call surface — an agent
      // that finds tools this way must not be shown a schema that hides
      // retry safety.
      const page = await f.call(f.aliceSession, "woo_list_reachable_tools", { limit: 5, include_schema: true });
      const listed2 = page.result?.structuredContent?.result?.tools ?? [];
      expect(listed2.length).toBeGreaterThan(0);
      expect(listed2[0]?.input_schema?.properties?.operation_id?.type).toBe("string");
    } finally {
      f.close();
    }
  });
});

/**
 * Retention alignment between the gateway's selection pin and the authority's
 * recorded reply (H2a/H2c).
 *
 * These two bounds are one mechanism. The pin decides WHERE a retry is sent;
 * the recorded reply decides whether it executes when it gets there. If the
 * pin expires first, a retry re-plans freely and can commit at a SECOND scope
 * — the same double execution the key exists to prevent, reached through the
 * routing door instead of the commit door. So the pin must outlive the reply.
 */
describe("selection pin and recorded reply retain together (H2a/H2c)", () => {
  /** Every pin row the gateway holds, newest last. */
  const pins = (f: { gatewayState: { state: { storage: { sql: any } } } }) =>
    (f.gatewayState.state.storage.sql.exec(
      "SELECT idempotency_key, scope FROM net_gateway_pin ORDER BY rowid"
    ) as { toArray(): Array<{ idempotency_key: string; scope: string }> }).toArray();

  it("a busy NEIGHBOUR scope cannot evict a pin whose reply is still live", async () => {
    const f = await fixture();
    try {
      expect(await f.hits()).toBe(0);
      const first = await f.bump(f.aliceSession, "op-pinned");
      expect(first.result?.isError).not.toBe(true);
      await f.settleAll();
      expect(await f.hits()).toBe(1);

      const mine = pins(f).find((row) => row.idempotency_key.endsWith("op-pinned"));
      expect(mine, "the first submit pinned its scope").toBeTruthy();
      const home = mine!.scope;

      // Pressure from ANOTHER scope. Under the old shard-wide rule this
      // pushed `op-pinned` out of the table while its recorded reply was
      // still live at the scope, and the retry was free to re-plan.
      const sql = f.gatewayState.state.storage.sql;
      for (let i = 0; i < 3000; i += 1) {
        sql.exec(
          "INSERT INTO net_gateway_pin (idempotency_key, scope) VALUES (?, 'a_busy_neighbour') ON CONFLICT DO NOTHING",
          `neighbour-${i}`
        );
      }
      // A fresh turn drives the retention sweep through the real code path.
      expect((await f.bump(f.aliceSession, "op-sweep")).result?.isError).not.toBe(true);
      await f.settleAll();

      const after = pins(f);
      expect(after.find((row) => row.idempotency_key.endsWith("op-pinned"))?.scope).toBe(home);
      // Proof that this is the regression and not a vacuous pass: far more
      // than the old shard-wide limit of 1024 rows are NEWER than the pin, so
      // the previous `ORDER BY rowid DESC LIMIT 1024` sweep would have taken
      // it. Retention is now counted within the scope that owns the reply.
      const index = after.findIndex((row) => row.idempotency_key.endsWith("op-pinned"));
      expect(after.length - index).toBeGreaterThan(1024);

      // And the guarantee the pin exists for still holds end to end.
      const retry = await f.bump(f.aliceSession, "op-pinned");
      expect(retry.result?.structuredContent?.replayed).toBe(true);
      await f.settleAll();
      expect(await f.hits()).toBe(2); // op-pinned once, op-sweep once. Never three.
    } finally {
      f.close();
    }
  });

  it("pin gone, receipt alive: the recorded reply still refuses the second execution", async () => {
    const f = await fixture();
    try {
      expect((await f.bump(f.aliceSession, "op-unpinned")).result?.isError).not.toBe(true);
      await f.settleAll();
      expect(await f.hits()).toBe(1);

      // Force the hazard: drop the pin, keep the reply. Selection re-plans
      // freely — and because it lands on the scope that owns the target, the
      // authority's recorded reply is what stops the re-execution. The pin is
      // a routing guarantee, never the only defence.
      f.gatewayState.state.storage.sql.exec(
        "DELETE FROM net_gateway_pin WHERE idempotency_key LIKE '%op-unpinned'"
      );
      expect(pins(f).find((row) => row.idempotency_key.endsWith("op-unpinned"))).toBeUndefined();

      const retry = await f.bump(f.aliceSession, "op-unpinned");
      expect(retry.result?.structuredContent?.replayed).toBe(true);
      await f.settleAll();
      expect(await f.hits()).toBe(1);
    } finally {
      f.close();
    }
  });

  it("receipt gone, pin alive: the retry is a NEW turn, and it runs at the PINNED scope", async () => {
    const f = await fixture();
    try {
      expect((await f.bump(f.aliceSession, "op-expired")).result?.isError).not.toBe(true);
      await f.settleAll();
      expect(await f.hits()).toBe(1);

      const pinned = pins(f).find((row) => row.idempotency_key.endsWith("op-expired"));
      expect(pinned).toBeTruthy();
      // Expire the authority's reply the way retention would.
      const scopeState = f.scopeStates.get(pinned!.scope);
      expect(scopeState, `scope state for ${pinned!.scope}`).toBeTruthy();
      scopeState!.state.storage.sql.exec("DELETE FROM net_scope_reply WHERE idempotency_key LIKE '%op-expired'");
      // The live sequencer holds the same row in memory; evict the DO so it
      // rehydrates from the durable rows that retention actually prunes.
      f.reviveScope(pinned!.scope);

      // Documented posture (M4.2): past the window a retry validates fresh and
      // IS a new turn. What must not happen is it becoming a new turn at a
      // DIFFERENT scope — the pin is still there and still routes it home.
      const retry = await f.bump(f.aliceSession, "op-expired");
      expect(retry.result?.isError).not.toBe(true);
      expect(retry.result?.structuredContent?.replayed).not.toBe(true);
      await f.settleAll();
      expect(await f.hits()).toBe(2);
      expect(pins(f).find((row) => row.idempotency_key.endsWith("op-expired"))?.scope).toBe(pinned!.scope);
    } finally {
      f.close();
    }
  });

  it("keyed speech records a DURABLE receipt at the authority, in the quota that bounds it", async () => {
    // The transport half of the reviewer's probe: prove that keyed
    // observation-only speech really does land as a row in the authority's
    // reply table (that is what was growing without limit), and that the row
    // is the marked, non-advancing kind the quota governs. The eviction edge
    // itself is driven directly in tests/net/scope.test.ts — replaying it here
    // would cost hundreds of full MCP turns for no extra signal.
    const f = await fixture();
    try {
      const rowsFor = (pattern: string) =>
        [...f.scopeStates.values()].flatMap((st) =>
          (st.state.storage.sql.exec(
            "SELECT idempotency_key, body FROM net_scope_reply WHERE idempotency_key LIKE ?",
            pattern
          ) as { toArray(): Array<{ idempotency_key: string; body: string }> }).toArray()
        );

      for (let i = 0; i < 4; i += 1) {
        const said = await f.say(f.aliceSession, `line ${i}`, `op-say-${i}`);
        expect(said.result?.isError, JSON.stringify(said).slice(0, 300)).not.toBe(true);
        await f.settleAll();
      }

      const rows = rowsFor("%op-say-%");
      expect(rows.length).toBe(4);
      for (const row of rows) {
        const reply = JSON.parse(row.body) as Record<string, unknown>;
        expect(reply.status).toBe("accepted");
        // Marked non-advancing: this is what puts the row under the receipt
        // quota instead of the seq-ordered rule that can never reach it.
        expect(reply.replay_receipt).toBe(true);
      }

      // And the retry still replays rather than re-emitting.
      const again = await f.say(f.aliceSession, "line 0", "op-say-0");
      expect(again.result?.structuredContent?.replayed).toBe(true);
      await f.settleAll();
      expect(rowsFor("%op-say-%").length).toBe(4);
    } finally {
      f.close();
    }
  });
});
