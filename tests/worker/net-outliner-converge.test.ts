// Outliner `add` over the net path must CONVERGE (commit within the
// attempt budget) rather than grind a read_version_mismatch repair loop to
// E_BUDGET. The loop's root: a contents/sibling scan reads a sibling item's
// non-default parent/position, which the sparse per-attempt slice omits, so
// the VM reads the class default and the read version stamps "absent" —
// permanently mismatching the authority's explicit cell. The fix keeps the
// gateway's per-turn repairs STICKY across re-plans (PlanTurnInput.seedObjects).
// These tests drive real outliner adds through the in-process fake-DO net
// harness and assert bounded convergence (not merely under-budget).
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { planNetInstall } from "../../src/net/install";
import { cellsFromSerialized } from "../../src/net/bridge";
import { partitionCells } from "../../src/net/topology";
import type { AttemptTraceEntry } from "../../src/net/errors";
import type { CommitReply } from "../../src/net/scope";
import type { WooWorld } from "../../src/core/world";

const SECRET = "net-outliner-converge-secret";

function netState(name: string): NetScopeDurableState & NetGatewayDurableState {
  const fake = new FakeDurableObjectState(name);
  return {
    id: fake.id,
    waitUntil: (_promise: Promise<unknown>) => {},
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: (_at: number) => {},
      deleteAlarm: () => {}
    }
  };
}

type Fetchable = { fetch(request: Request): Promise<Response> | Response };

async function call<T>(target: Fetchable, env: { WOO_INTERNAL_SECRET?: string }, route: string, body?: unknown): Promise<T> {
  const url = `https://do/net${route}`;
  const request = body === undefined
    ? new Request(url)
    : new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const signed = await signInternalRequest(env, request);
  const response = await target.fetch(signed);
  const decoded = (await response.json()) as T;
  if (!response.ok) throw new Error(`call ${route} failed: ${JSON.stringify(decoded)}`);
  return decoded;
}

type TurnBody = {
  reply: CommitReply;
  attempt: number;
  trace: AttemptTraceEntry[];
  envelopeBytes?: number;
  result?: unknown;
};

// The warm-envelope ceiling the planner enforces (plan.ts
// WARM_ENVELOPE_BYTE_LIMIT). Mirrored here for the scale gate's assertion.
const WARM_ENVELOPE_BYTE_LIMIT = 64 * 1024;

/** A fully bundled net world with an actor placed in the outliner. */
async function outlinerWorld(): Promise<{ world: WooWorld; theOutline: string; session: { id: string; actor: string }; actor: string; epoch: string }> {
  const plan = await planNetInstall();
  const world = plan.world;
  const outline = world.exportWorld().objects.find((o) => o.parent === "$outliner");
  if (!outline) throw new Error("no $outliner instance seeded");
  const theOutline = outline.id;
  const session = world.auth("guest:outliner-repro");
  const actor = session.actor;
  const placed = await world.directCall("place", actor, actor, "moveto", [theOutline], { sessionId: session.id });
  expect(placed.op).toBe("result");
  return { world, theOutline, session, actor, epoch: plan.epoch };
}

/** Partition the (possibly mutated) world, seed one scope DO per partition,
 * and stand up a gateway. `pull` selects which scopes warm the gateway view
 * — omit `room:<outline>` to leave the gateway COLD for the outline + its
 * items (forcing an authority refresh on the add). */
/** Intercept a scope DO fetch from the gateway. Return a Response to
 * override, or null to delegate to the real DO. Used to stub a
 * pathological authority for the non-convergence detector tests. */
type Intercept = (scope: string, path: string, request: Request, real: () => Promise<Response>) => Promise<Response | null>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

async function mountNet(
  world: WooWorld,
  epoch: string,
  opts: { pull?: (scope: string) => boolean; intercept?: Intercept } = {}
): Promise<{ gateway: NetGatewayDO; gatewayEnv: NetGatewayEnv }> {
  const partitions = partitionCells(cellsFromSerialized(world.exportWorld()));
  const scopeDOs = new Map<string, NetScopeDO>();
  const scopeEnv: NetScopeEnv = {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: (destination) => {
      const scope = destination.startsWith("scope:") ? destination.slice("scope:".length) : null;
      const instance = scope !== null ? scopeDOs.get(scope) : undefined;
      if (!instance) throw new Error(`unexpected scope-side destination ${destination}`);
      return instance;
    }
  };
  for (const [scope, cells] of partitions) {
    const instance = new NetScopeDO(netState(`scope-${scope}`), scopeEnv);
    await call(instance, scopeEnv, "/seed", { scope, catalog_epoch: epoch, cells });
    scopeDOs.set(scope, instance);
  }
  const gatewayEnv: NetGatewayEnv = {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: (destination) => {
      const scope = destination.startsWith("scope:") ? destination.slice("scope:".length) : null;
      const instance = scope !== null ? scopeDOs.get(scope) : undefined;
      if (!instance) throw new Error(`unexpected destination ${destination}`);
      if (!opts.intercept || scope === null) return instance;
      const intercept = opts.intercept;
      return {
        fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          const override = await intercept(scope, path, request, () => Promise.resolve(instance.fetch(request)));
          return override ?? instance.fetch(request);
        }
      };
    }
  };
  const gateway = new NetGatewayDO(netState("gateway-outliner"), gatewayEnv);
  for (const scope of partitions.keys()) {
    if (opts.pull && !opts.pull(scope)) continue;
    await call(gateway, gatewayEnv, "/pull", { scope, destination: `scope:${scope}` });
  }
  return { gateway, gatewayEnv };
}

function addTurn(
  gateway: NetGatewayDO,
  gatewayEnv: NetGatewayEnv,
  ctx: { theOutline: string; roomScope: string; epoch: string; session: { id: string }; actor: string },
  key: string,
  text: string
): Promise<TurnBody> {
  return call<TurnBody>(gateway, gatewayEnv, "/turn", {
    call: {
      kind: "woo.turn_call.shadow.v1",
      id: key,
      route: "direct",
      scope: ctx.roomScope,
      session: ctx.session.id,
      actor: ctx.actor,
      target: ctx.theOutline,
      verb: "add",
      args: [text]
    },
    planningScope: ctx.roomScope,
    catalog_epoch: ctx.epoch,
    idempotency_key: key
  });
}

describe("outliner add over the net path converges", () => {
  it("commits sequential adds without a read_version_mismatch repair loop", async () => {
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const { gateway, gatewayEnv } = await mountNet(world, epoch);
    const ctx = { theOutline, roomScope, epoch, session, actor };

    // Each add rewrites per-actor maps and (from the 2nd on) scans an
    // existing sibling's parent/position. Before the fix the 2nd add loops
    // to E_BUDGET; every add must now converge.
    for (let i = 1; i <= 4; i += 1) {
      const turn = await addTurn(gateway, gatewayEnv, ctx, `outliner-add-${i}`, `item ${i}`);
      expect(turn.reply.status, `add #${i}: attempts=${turn.attempt} trace=${JSON.stringify(turn.trace)}`).toBe("accepted");
      // Converge CLEANLY (not merely under the 6-attempt budget): one
      // sibling-property repair round is expected once siblings exist.
      expect(turn.attempt, `add #${i} took ${turn.attempt} attempts`).toBeLessThanOrEqual(3);
    }
  });

  it("converges in ONE repair round against a many-sibling outline", async () => {
    // At-scale regression guard: the scope rejects a read_version_mismatch
    // naming the FULL mismatched set, so the gateway refreshes+sticks every
    // sibling cell in ONE round. This must hold no matter how many siblings
    // the add's contents scan reads — a regression that stuck one object per
    // round would need ~SIBLINGS rounds and blow the attempt budget.
    //
    // SIBLINGS is capped well under the point where the add's O(siblings)
    // read closure would trip the 64 KiB warm-envelope ceiling (~17 top-
    // level siblings on the bundled outliner — a SEPARATE catalog-scaling
    // limit, not this convergence fix; see the converge notes). The count
    // here is far above 1, so the one-round property is what is under test,
    // not the envelope. The gateway view is warm so the ONLY repair round is
    // the sibling-property mismatch — isolating the property; the sequential
    // test above already exercises the cold-view authority-refresh path.
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };

    const SIBLINGS = 12;
    for (let i = 0; i < SIBLINGS; i += 1) {
      const r = await world.directCall(`seed-${i}`, actor, theOutline, "add", [`seed ${i}`], { sessionId: session.id });
      expect(r.op, `seed add ${i}: ${JSON.stringify(r)}`).toBe("result");
    }

    const { gateway, gatewayEnv } = await mountNet(world, epoch);
    const turn = await addTurn(gateway, gatewayEnv, ctx, "outliner-add-large", "one more");
    expect(turn.reply.status, `attempts=${turn.attempt} trace=${JSON.stringify(turn.trace)}`).toBe("accepted");
    // Warm view + all siblings repaired in one round → attempt 2. Bound at 3
    // for a single round of slack; a per-object-per-round regression fails.
    expect(turn.attempt, `many-sibling add took ${turn.attempt} attempts`).toBeLessThanOrEqual(3);
  });

  // SCALE GATE — the v2 edge-index acceptance test. With the ordered-edge
  // index (catalogs/outliner v2.0.0), an `add` into a large outline reads the
  // parent's ordering as ONE owner-computed projection and writes exactly ONE
  // edge cell — O(1) in sibling count, no renumber. So the add commits with a
  // bounded read/write closure well under the 64 KiB warm-envelope ceiling
  // even at 120 children (above prod's the_outline). A regression to an
  // O(siblings) read/write closure fails this by tripping the ceiling.
  it("SCALE: a 120-child-outline add stays under the warm-envelope ceiling with O(1) edge writes", async () => {
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };

    // 120 top-level siblings — at/above prod scale. The pre-v2 add tripped
    // E_INTERNAL (oversized warm envelope) past ~17 items; the edge index must
    // now commit an add here with a bounded closure.
    const SIBLINGS = 120;
    for (let i = 0; i < SIBLINGS; i += 1) {
      const r = await world.directCall(`seed-${i}`, actor, theOutline, "add", [`seed ${i}`], { sessionId: session.id });
      expect(r.op, `seed add ${i}: ${JSON.stringify(r)}`).toBe("result");
    }

    const { gateway, gatewayEnv } = await mountNet(world, epoch);
    const turn = await addTurn(gateway, gatewayEnv, ctx, "outliner-add-scale", "one more");
    // Acceptance: the add commits with a bounded read/write closure.
    expect(turn.reply.status, `attempts=${turn.attempt} trace=${JSON.stringify(turn.trace)}`).toBe("accepted");
    expect(turn.envelopeBytes ?? 0).toBeLessThanOrEqual(WARM_ENVELOPE_BYTE_LIMIT);
    expect(turn.envelopeBytes ?? 0).toBeGreaterThan(0);
    // Bounded repair: seed the target ordering (1 fetch) then commit — a
    // per-sibling regression would need ~SIBLINGS rounds.
    expect(turn.attempt, `scale add took ${turn.attempt} attempts`).toBeLessThanOrEqual(3);
  });

  it("fails FAST and NAMED (E_NONCONVERGENT_READ, not E_BUDGET) when a read cannot converge", async () => {
    // A pathological authority that rejects the SAME read at the SAME stable
    // version every round models a planner/catalog bug the repair loop can
    // never satisfy. The detector must surface it named — with the offending
    // cell — instead of grinding six rounds to an opaque E_BUDGET.
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };
    const stuckCell = { kind: "prop", object: theOutline, name: "focus_by_actor" };
    const focusKey = `property_cell:${theOutline}:focus_by_actor`;

    const { gateway, gatewayEnv } = await mountNet(world, epoch, {
      intercept: async (scope, path) => {
        // Real /closure keeps returning focus_by_actor at its unchanging
        // version (nothing ever commits); only /submit is forced to reject,
        // so the gateway refreshes to the SAME version twice → detector.
        if (scope === roomScope && path === "/net/submit") {
          return jsonResponse({ status: "rejected", reason: "read_version_mismatch", retryable: true, mismatched_reads: [stuckCell] });
        }
        return null;
      }
    });

    const err = await addTurn(gateway, gatewayEnv, ctx, "nonconvergent", "x").then(
      (ok) => { throw new Error(`expected rejection, got ${JSON.stringify(ok.reply)}`); },
      (e: unknown) => String(e)
    );
    expect(err).toContain("E_NONCONVERGENT_READ");
    expect(err, "must name the offending cell").toContain(focusKey);
    expect(err, "must NOT be the opaque budget error").not.toContain("E_BUDGET");
  });

  it("does NOT trip the detector under genuine contention (authority version moves each round)", async () => {
    // Same forced rejection, but now the authority version MOVES every round
    // (a real concurrent writer). map.get(key) !== the new version each time,
    // so the detector never fires; unresolved contention correctly exhausts
    // to E_BUDGET — never a false E_NONCONVERGENT_READ.
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };
    const stuckCell = { kind: "prop", object: theOutline, name: "focus_by_actor" };
    const focusKey = `property_cell:${theOutline}:focus_by_actor`;
    let round = 0;

    const { gateway, gatewayEnv } = await mountNet(world, epoch, {
      intercept: async (scope, path, _request, real) => {
        if (scope !== roomScope) return null;
        if (path === "/net/submit") {
          round += 1;
          return jsonResponse({ status: "rejected", reason: "read_version_mismatch", retryable: true, mismatched_reads: [stuckCell] });
        }
        if (path === "/net/closure") {
          // Move focus_by_actor's version each round: contention, not a stuck plan.
          const res = await real();
          const body = (await res.json()) as { cells?: Array<{ key: string; version: string }> };
          for (const cell of body.cells ?? []) {
            if (cell.key === focusKey) cell.version = `contention-${round}`;
          }
          return jsonResponse(body);
        }
        return null;
      }
    });

    const err = await addTurn(gateway, gatewayEnv, ctx, "contention", "x").then(
      (ok) => { throw new Error(`expected rejection, got ${JSON.stringify(ok.reply)}`); },
      (e: unknown) => String(e)
    );
    expect(err, "moving version must NOT be misread as non-convergence").not.toContain("E_NONCONVERGENT_READ");
    expect(err, "unresolved contention exhausts to the budget").toContain("E_BUDGET");
  });
});
