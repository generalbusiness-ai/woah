// NetGatewayDO KV seeds — CO5 copy #3, CO7 "cold path is the normal
// path" (Plan 002 Phase 3 step 3). Fake-DO lane with a Map-backed KV.
//
// Covered: a pull with no seed goes live and writes the seed back
// (deferred); a second gateway's pull is served from KV after the head
// check passes (no /net/closure to the scope); a stale seed (scope moved
// on) is detected by the head check, the pull falls back live, and the
// seed is overwritten at the new head.
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import {
  NetGatewayDO,
  type NetGatewayDurableState,
  type NetGatewayEnv,
  type NetSeedKV
} from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { applyTranscript } from "../../src/net/transcript";
import { ScopeSequencer, type CommitReply, type CommitSubmit, type ScopeHead } from "../../src/net/scope";

const SECRET = "net-kv-test-secret";
const EPOCH = "cat-net-kv-1";
const SCOPE = "kv_room";

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
      setAlarm: (_at: number) => {},
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

type Fetchable = { fetch(request: Request): Promise<Response> | Response };

async function call<T>(target: Fetchable, env: { WOO_INTERNAL_SECRET?: string }, route: string, body?: unknown): Promise<T> {
  const url = `https://do/net${route}`;
  const request =
    body === undefined
      ? new Request(url)
      : new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const signed = await signInternalRequest(env, request);
  const response = await target.fetch(signed);
  const decoded = (await response.json()) as T & { error?: unknown };
  if (!response.ok) throw new Error(`call ${route} failed: ${JSON.stringify(decoded)}`);
  return decoded;
}

/** Map-backed KV satisfying the structural NetSeedKV slice. */
function fakeKV(): NetSeedKV & { store: Map<string, string>; puts: number } {
  const store = new Map<string, string>();
  return {
    store,
    puts: 0,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      this.puts += 1;
      store.set(key, value);
    }
  };
}

const WRITER = { progr: "#actor", thisObj: "#thing", verb: "set_label", definer: "$thing", caller: "#actor", callerPerms: "#actor" };

function seedCells() {
  return [
    { kind: "object_lineage" as const, object: "#thing", value: { parent: null, owner: "#actor", name: "thing", anchor: null, flags: {} } },
    { kind: "object_lineage" as const, object: "#actor", value: { parent: null, owner: "#actor", name: "actor", anchor: null, flags: {} } },
    { kind: "property_cell" as const, object: "#thing", name: "label", value: { value: "old" } }
  ];
}

/** A direct scope mutation (hand-built transcript) to advance the head
 * behind the seed's back. */
async function advanceScope(scopeDO: Fetchable, env: NetScopeEnv): Promise<void> {
  const head = (await call<{ head: ScopeHead }>(scopeDO, env, "/head")).head;
  const transcript = {
    kind: "woo.effect_transcript.shadow.v1",
    route: "direct",
    scope: SCOPE,
    seq: head.seq + 1,
    call: { actor: "#actor", target: "#thing", verb: "set_label", args: [], body: undefined },
    reads: [],
    writes: [{ cell: { kind: "prop", object: "#thing", name: "label" }, value: "new", op: "set", writer: WRITER }],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: "net-kv-t1"
  };
  const twin = new ScopeSequencer(SCOPE, EPOCH);
  twin.seed(seedCells());
  const derived = applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH });
  const submit: CommitSubmit = {
    kind: "woo.net.commit_submit.v1",
    scope: SCOPE,
    base: head,
    idempotency_key: "kv-advance-1",
    transcript: transcript as never,
    post_state_version: derived.postStateVersion,
    stamp: { scope_head: "x", catalog_epoch: EPOCH }
  };
  const reply = await call<CommitReply>(scopeDO, env, "/submit", submit);
  expect(reply.status).toBe("accepted");
}

/** Wrap the scope stub counting /net/closure hits — the assertion that a
 * KV-served pull never touched the live closure path. */
function countingStub(target: Fetchable): { stub: Fetchable; closures: () => number } {
  let closures = 0;
  return {
    closures: () => closures,
    stub: {
      fetch: (request: Request) => {
        if (new URL(request.url).pathname === "/net/closure") closures += 1;
        return target.fetch(request);
      }
    }
  };
}

describe("NetGatewayDO KV seeds (CO5 copy #3)", () => {
  it("pull-miss goes live and writes the seed; the next gateway pulls from KV; a stale seed falls back and rewrites", async () => {
    const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET };
    const scope = netState(`scope-${SCOPE}`);
    const scopeDO = new NetScopeDO(scope.state, scopeEnv);
    await call(scopeDO, scopeEnv, "/seed", { scope: SCOPE, catalog_epoch: EPOCH, cells: seedCells() });

    const kv = fakeKV();
    const counter = countingStub(scopeDO);
    const gatewayEnv = (): NetGatewayEnv => ({
      WOO_INTERNAL_SECRET: SECRET,
      HOST_SEED_KV: kv,
      NET_RESOLVE: (destination) => {
        if (destination === `scope:${SCOPE}`) return counter.stub;
        throw new Error(`unexpected destination ${destination}`);
      }
    });

    // ---- Pull #1: no seed yet — live closure, then deferred write-back.
    const g1 = netState("gateway-kv-1");
    const gateway1 = new NetGatewayDO(g1.state, gatewayEnv());
    const pull1 = await call<{ installed: number; source: string; head: ScopeHead }>(gateway1, gatewayEnv(), "/pull", {
      scope: SCOPE,
      destination: `scope:${SCOPE}`
    });
    expect(pull1.source).toBe("live");
    await g1.settle(); // flush the deferred kv.put
    expect(kv.store.has(`net:seed:${SCOPE}`)).toBe(true);
    expect(kv.puts).toBe(1);
    const closuresAfterPull1 = counter.closures();
    expect(closuresAfterPull1).toBe(1);

    // ---- Pull #2 (fresh gateway): KV hit; the head check passes and the
    // live closure path is never touched.
    const g2 = netState("gateway-kv-2");
    const gateway2 = new NetGatewayDO(g2.state, gatewayEnv());
    const pull2 = await call<{ installed: number; source: string; head: ScopeHead }>(gateway2, gatewayEnv(), "/pull", {
      scope: SCOPE,
      destination: `scope:${SCOPE}`
    });
    await g2.settle();
    expect(pull2.source).toBe("kv");
    expect(pull2.installed).toBe(pull1.installed);
    expect(counter.closures()).toBe(closuresAfterPull1); // no live fetch
    // The KV-served view is usable state: the label cell landed, marked
    // with copy-#3 provenance in the gateway's persisted view.
    const persisted = (
      g2.state.storage.sql.exec("SELECT body FROM net_gateway_cell WHERE key = 'property_cell:#thing:label'") as {
        toArray(): Array<{ body: string }>;
      }
    ).toArray();
    expect(persisted).toHaveLength(1);
    expect(JSON.parse(persisted[0].body).provenance).toBe("seed");

    // ---- Staleness: the scope moves on; the seed now lags.
    await advanceScope(scopeDO, scopeEnv);

    const g3 = netState("gateway-kv-3");
    const gateway3 = new NetGatewayDO(g3.state, gatewayEnv());
    const pull3 = await call<{ installed: number; source: string; head: ScopeHead }>(gateway3, gatewayEnv(), "/pull", {
      scope: SCOPE,
      destination: `scope:${SCOPE}`
    });
    await g3.settle();
    expect(pull3.source).toBe("live"); // head check failed → fell back
    expect(pull3.head.seq).toBe(1);
    expect(counter.closures()).toBe(closuresAfterPull1 + 1);
    // The seed was overwritten at the new head (self-healing E_SEED_LAG).
    expect(kv.puts).toBe(2);
    const rewritten = JSON.parse(kv.store.get(`net:seed:${SCOPE}`) as string) as { head: ScopeHead };
    expect(rewritten.head).toEqual(pull3.head);

    scope.close();
    g1.close();
    g2.close();
    g3.close();
  });
});
