// NetGatewayDO taxonomy-driven repair loop (Plan 002 Phase 3 step 3;
// coherence.md CO6/CO10). Fake-DO lane: real per-instance SQLite, real
// planning (bootstrap world + authored verb), real internal-auth'd RPC
// between the gateway and scope DOs.
//
// Covered: a stale gateway view converges via the targeted
// read_version_mismatch refresh (attempts >= 2, trace explains the
// rounds); a recovery whose closure fetch keeps failing (WOO_NET_FAULTS)
// exhausts the attempt ceiling and surfaces E_BUDGET with the full
// attempt trace in the /net/turn error reply.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import {
  MAX_TURN_ATTEMPTS,
  NetGatewayDO,
  type NetGatewayDurableState,
  type NetGatewayEnv
} from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized, type ShadowTurnCall } from "../../src/net/bridge";
import type { AttemptTraceEntry } from "../../src/net/errors";
import { applyTranscript } from "../../src/net/transcript";
import { ScopeSequencer, type CommitReply, type CommitSubmit, type ScopeHead } from "../../src/net/scope";

const SECRET = "net-repair-test-secret";
const EPOCH = "cat-net-repair-1";
const SCOPE = "repair_room";

/** Fake DO state + the alarm slice the net DOs need. `settle` awaits the
 * deferred tasks WorkerdHost hands to waitUntil (outbox drains — the
 * rider-adoption tests need adoption to have landed before asserting). */
function netState(name: string): {
  state: NetScopeDurableState & NetGatewayDurableState;
  settle: () => Promise<void>;
  close: () => void;
} {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const state = {
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

/** Signed call returning status + body (repair tests must see 400s). */
async function callRaw<T>(
  target: Fetchable,
  env: { WOO_INTERNAL_SECRET?: string },
  route: string,
  body?: unknown
): Promise<{ status: number; body: T }> {
  const url = `https://do/net${route}`;
  const request =
    body === undefined
      ? new Request(url)
      : new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const signed = await signInternalRequest(env, request);
  const response = await target.fetch(signed);
  return { status: response.status, body: (await response.json()) as T };
}

async function call<T>(target: Fetchable, env: { WOO_INTERNAL_SECRET?: string }, route: string, body?: unknown): Promise<T> {
  const { status, body: decoded } = await callRaw<T>(target, env, route, body);
  if (status !== 200) throw new Error(`call ${route} failed: ${status} ${JSON.stringify(decoded)}`);
  return decoded;
}

/** Bootstrap world + a read-modify-write verb (the plan.test.ts harness
 * shape) whose exported cells seed a NetScopeDO. The `bump` verb READS
 * this.counter, so a gateway whose view is stale plans against the old
 * value and the scope rejects read_version_mismatch — the repair input. */
async function seededScope() {
  const world = createWorld();
  const session = world.auth("guest:net-repair");
  const actor = session.actor;
  world.createObject({ id: "repair_box", name: "Repair Box", parent: "$thing", owner: actor });
  world.defineProperty("repair_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  const installed = installVerb(
    world,
    "repair_box",
    "bump",
    `verb :bump() rxd {
      let before = this.counter;
      this.counter = before + 1;
      return this.counter;
    }`,
    null
  );
  expect(installed.ok).toBe(true);

  const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET };
  const scope = netState(`scope-${SCOPE}`);
  const scopeDO = new NetScopeDO(scope.state, scopeEnv);
  await call(scopeDO, scopeEnv, "/seed", {
    scope: SCOPE,
    catalog_epoch: EPOCH,
    cells: cellsFromSerialized(world.exportWorld())
  });

  const bumpCall = (id: string): ShadowTurnCall => ({
    kind: "woo.turn_call.shadow.v1",
    id,
    route: "direct",
    scope: SCOPE,
    session: session.id,
    actor,
    target: "repair_box",
    verb: "bump",
    args: []
  });
  return { scopeDO, scopeEnv, bumpCall, close: scope.close };
}

function gatewayEnvFor(scopeDO: Fetchable, faults?: Record<string, unknown>): NetGatewayEnv {
  return {
    WOO_INTERNAL_SECRET: SECRET,
    ...(faults !== undefined ? { WOO_NET_FAULTS: JSON.stringify(faults) } : {}),
    NET_RESOLVE: (destination) => {
      if (destination === `scope:${SCOPE}`) return scopeDO;
      throw new Error(`unexpected destination ${destination}`);
    }
  };
}

function turnRequest(bump: ShadowTurnCall, idempotencyKey: string) {
  return {
    call: bump,
    planningScope: SCOPE,
    catalog_epoch: EPOCH,
    idempotency_key: idempotencyKey,
    scopes: { [SCOPE]: `scope:${SCOPE}` }
  };
}

type TurnBody = {
  reply: CommitReply;
  attempt: number;
  trace: AttemptTraceEntry[];
  install_degraded?: boolean;
};

describe("NetGatewayDO repair loop (CO6/CO10)", () => {
  it("converges a stale view via the targeted read_version_mismatch refresh (attempts >= 2)", async () => {
    const { scopeDO, scopeEnv, bumpCall, close } = await seededScope();

    // Gateway 1 pulls a fresh view of the scope...
    const g1State = netState("gateway-repair-1");
    const g1Env = gatewayEnvFor(scopeDO);
    const gateway1 = new NetGatewayDO(g1State.state, g1Env);
    await call(gateway1, g1Env, "/pull", { scope: SCOPE, destination: `scope:${SCOPE}` });

    // ...then a second gateway advances the scope behind gateway 1's back
    // (counter 0 → 1), leaving gateway 1's view stale.
    const g2State = netState("gateway-repair-2");
    const g2Env = gatewayEnvFor(scopeDO);
    const gateway2 = new NetGatewayDO(g2State.state, g2Env);
    await call(gateway2, g2Env, "/pull", { scope: SCOPE, destination: `scope:${SCOPE}` });
    const first = await call<TurnBody>(gateway2, g2Env, "/turn", turnRequest(bumpCall("turn-g2-1"), "g2-t1"));
    expect(first.reply.status).toBe("accepted");
    expect(first.attempt).toBe(1);
    expect(first.trace).toEqual([]);

    // Gateway 1's turn plans against the stale counter, gets rejected
    // read_version_mismatch, refreshes exactly the mismatched cell, and
    // converges on the second round (counter 1 → 2, not 0 → 1).
    const second = await call<TurnBody>(gateway1, g1Env, "/turn", turnRequest(bumpCall("turn-g1-1"), "g1-t1"));
    expect(second.reply.status).toBe("accepted");
    expect(second.attempt).toBeGreaterThanOrEqual(2);
    expect(second.trace.length).toBeGreaterThanOrEqual(1);
    expect(second.trace[0].code).toBe("E_READ_VERSION");
    expect(second.trace[0].missing).toContain("property_cell:repair_box:counter");

    // The scope's authority saw both bumps: counter is 2.
    const closure = await call<{ cells: Array<{ key: string; value: unknown }> }>(scopeDO, scopeEnv, "/closure", {
      keys: ["property_cell:repair_box:counter"],
      known: ["object_lineage:repair_box"]
    });
    expect(closure.cells[0]?.value).toMatchObject({ value: 2 });

    close();
    g1State.close();
    g2State.close();
  });

  it("exhausts the budget when recovery keeps failing and surfaces E_BUDGET with the trace", async () => {
    const { scopeDO, bumpCall, close } = await seededScope();

    // Warm a view on clean storage first (faults would break the pull)...
    const gState = netState("gateway-repair-3");
    const cleanEnv = gatewayEnvFor(scopeDO);
    const warm = new NetGatewayDO(gState.state, cleanEnv);
    await call(warm, cleanEnv, "/pull", { scope: SCOPE, destination: `scope:${SCOPE}` });

    // ...advance the scope so the view is stale (another gateway commits)...
    const g2State = netState("gateway-repair-4");
    const gateway2 = new NetGatewayDO(g2State.state, cleanEnv);
    await call(gateway2, cleanEnv, "/pull", { scope: SCOPE, destination: `scope:${SCOPE}` });
    const bump = await call<TurnBody>(gateway2, cleanEnv, "/turn", turnRequest(bumpCall("turn-adv-1"), "adv-t1"));
    expect(bump.reply.status).toBe("accepted");

    // ...then reopen the SAME storage with /closure faulted: every
    // read_version_mismatch recovery dies, so the loop can never
    // converge and must exhaust its attempt ceiling.
    const faultEnv = gatewayEnvFor(scopeDO, { "/closure": { error: "closure lane down" } });
    const faulted = new NetGatewayDO(gState.state, faultEnv);
    const { status, body } = await callRaw<{
      error: { code: string; attempts?: Array<AttemptTraceEntry & { recovery_error?: string }> };
    }>(faulted, faultEnv, "/turn", turnRequest(bumpCall("turn-fault-1"), "fault-t1"));

    expect(status).toBe(400);
    expect(body.error.code).toBe("E_BUDGET");
    // The trace explains every round: the taxonomy code that triggered
    // it and the recovery failure that kept it from converging.
    expect(body.error.attempts).toHaveLength(MAX_TURN_ATTEMPTS);
    for (const entry of body.error.attempts ?? []) {
      expect(entry.code).toBe("E_READ_VERSION");
      expect(entry.recovery_error).toContain("closure lane down");
    }

    close();
    gState.close();
    g2State.close();
  });
});

// ---- Gateway turn edges (Phase-3 hardening fix 5) --------------------------
describe("gateway turn edges (fix 5)", () => {
  it("an accepted commit whose warm cache-fill fails returns 200 with install_degraded, never a 500 (fix 5a)", async () => {
    const { scopeDO, bumpCall, close } = await seededScope();

    // Warm the view on clean env (a fault would break the pull)...
    const gState = netState("gateway-fix5a");
    const cleanEnv = gatewayEnvFor(scopeDO);
    const warm = new NetGatewayDO(gState.state, cleanEnv);
    await call(warm, cleanEnv, "/pull", { scope: SCOPE, destination: `scope:${SCOPE}` });

    // ...then reopen the SAME storage with /closure faulted: the turn
    // plans on the fresh view and commits on attempt 1, but the
    // post-accept installTouched dies. The commit is durable at the
    // scope — the reply must be the ACCEPTED TurnResult, degraded.
    const faultEnv = gatewayEnvFor(scopeDO, { "/closure": { error: "closure lane down" } });
    const faulted = new NetGatewayDO(gState.state, faultEnv);
    const result = await call<TurnBody>(faulted, faultEnv, "/turn", turnRequest(bumpCall("turn-5a-1"), "fix5a-t1"));
    expect(result.reply.status).toBe("accepted");
    expect(result.attempt).toBe(1);
    expect(result.install_degraded).toBe(true);

    close();
    gState.close();
  });

  it("a transport death in the submit reply window recovers via ONE same-key resubmit (fix 5b, CO2.5)", async () => {
    const { scopeDO, scopeEnv, bumpCall, close } = await seededScope();

    // Kill-after-commit at the stub seam: the FIRST /net/submit forwards
    // to the scope (which commits durably) and then throws before the
    // reply reaches the gateway. Later calls pass through.
    let killArmed = true;
    const killingStub = {
      fetch: async (request: Request) => {
        const response = await scopeDO.fetch(request);
        if (killArmed && new URL(request.url).pathname === "/net/submit") {
          killArmed = false;
          throw new Error("transport died after commit");
        }
        return response;
      }
    };
    const gState = netState("gateway-fix5b");
    const gEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === `scope:${SCOPE}`) return killingStub;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const gateway = new NetGatewayDO(gState.state, gEnv);
    await call(gateway, gEnv, "/pull", { scope: SCOPE, destination: `scope:${SCOPE}` });

    // The turn survives: the resubmit returns the RECORDED reply.
    const result = await call<TurnBody>(gateway, gEnv, "/turn", turnRequest(bumpCall("turn-5b-1"), "fix5b-t1"));
    expect(result.reply.status).toBe("accepted");
    expect(result.attempt).toBe(1);

    // Exactly one commit at the scope (the resubmit replayed, it did not
    // double-commit): head advanced once.
    const head = await call<{ head: { seq: number } }>(scopeDO, scopeEnv, "/head");
    expect(head.head.seq).toBe(1);

    close();
    gState.close();
  });

  it("pins the first submit's scope per idempotency key; a changed re-plan selection is overridden and surfaced, never committed elsewhere (fix 5c)", async () => {
    const { scopeDO, scopeEnv, bumpCall, close } = await seededScope();

    // A second, unrelated scope DO — the stale pin target.
    const otherState = netState("scope-pin-other");
    const otherEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET };
    const otherDO = new NetScopeDO(otherState.state, otherEnv);
    await call(otherDO, otherEnv, "/seed", { scope: "pin_other", catalog_epoch: EPOCH, cells: [] });

    const gState = netState("gateway-fix5c");
    const gEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === `scope:${SCOPE}`) return scopeDO;
        if (destination === "scope:pin_other") return otherDO;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const gateway = new NetGatewayDO(gState.state, gEnv);
    await call(gateway, gEnv, "/pull", { scope: SCOPE, destination: `scope:${SCOPE}` });

    // Happy path: a normal turn persists its (key → scope) pin.
    const first = await call<TurnBody>(gateway, gEnv, "/turn", {
      ...turnRequest(bumpCall("turn-5c-1"), "fix5c-t1"),
      scopes: { [SCOPE]: `scope:${SCOPE}`, pin_other: "scope:pin_other" }
    });
    expect(first.reply.status).toBe("accepted");
    const pinned = (
      gState.state.storage.sql.exec("SELECT scope FROM net_gateway_pin WHERE idempotency_key = 'fix5c-t1'") as {
        toArray(): Array<{ scope: string }>;
      }
    ).toArray();
    expect(pinned).toEqual([{ scope: SCOPE }]);

    // Divergent re-plan: simulate a key whose FIRST submit targeted
    // pin_other (pre-persisted pin) while the current plan selects
    // repair_room. The override routes to the pinned scope, whose shell
    // refuses the wrong-scope submit (one DO = one scope — upstream of
    // the sequencer's scope_mismatch verdict, same terminal CO6
    // posture): the failure SURFACES and repair_room must not commit.
    gState.state.storage.sql.exec(
      "INSERT INTO net_gateway_pin (idempotency_key, scope) VALUES ('fix5c-t2', 'pin_other')"
    );
    const headBefore = (await call<{ head: { seq: number } }>(scopeDO, scopeEnv, "/head")).head.seq;
    const { status, body } = await callRaw<{ error: unknown }>(gateway, gEnv, "/turn", {
      ...turnRequest(bumpCall("turn-5c-2"), "fix5c-t2"),
      scopes: { [SCOPE]: `scope:${SCOPE}`, pin_other: "scope:pin_other" }
    });
    expect(status).toBe(500);
    expect(JSON.stringify(body)).toContain("pin_other");
    // Never double-commit elsewhere: the freshly-selected scope did NOT
    // receive the turn.
    const headAfter = (await call<{ head: { seq: number } }>(scopeDO, scopeEnv, "/head")).head.seq;
    expect(headAfter).toBe(headBefore);

    close();
    otherState.close();
    gState.close();
  });
});
