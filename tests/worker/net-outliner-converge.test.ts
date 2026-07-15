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
import { installVerb } from "../../src/core/authoring";
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
  observations?: Array<Record<string, unknown>>;
};

/** Drive any verb over the gateway (eject/undo/list_items etc.). */
function verbTurn(
  gateway: NetGatewayDO,
  gatewayEnv: NetGatewayEnv,
  ctx: { theOutline: string; roomScope: string; epoch: string; session: { id: string }; actor: string },
  key: string,
  verb: string,
  args: unknown[]
): Promise<TurnBody> {
  return call<TurnBody>(gateway, gatewayEnv, "/turn", {
    call: {
      kind: "woo.turn_call.shadow.v1", id: key, route: "direct", scope: ctx.roomScope,
      session: ctx.session.id, actor: ctx.actor, target: ctx.theOutline, verb, args
    },
    planningScope: ctx.roomScope, catalog_epoch: ctx.epoch, idempotency_key: key
  });
}

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
): Promise<{ gateway: NetGatewayDO; gatewayEnv: NetGatewayEnv; scopeDOs: Map<string, NetScopeDO> }> {
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
  return { gateway, gatewayEnv, scopeDOs };
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

  // P2.4 — the bounded-read acceptance tests. A MUTATION picks its insertion
  // slot from the O(1) /net/ordered-neighbors reply (two ranks + count),
  // never the O(width) full sibling list: at 120 siblings the full list is
  // ~6 KB per fetch and grows with the outline, while the neighbour reply is
  // constant-size. The intercept records every ordering fetch the GATEWAY
  // makes during the turn, so a regression back to a full-list read (either
  // the reads_ordered_children pre-seed or an ordered_children repair fetch)
  // fails loudly with the offending payload sizes.
  const NEIGHBOR_REPLY_BYTE_CEILING = 512;

  async function recordOrderingFetches(): Promise<{
    fetches: Array<{ path: string; bytes: number }>;
    intercept: Intercept;
  }> {
    const fetches: Array<{ path: string; bytes: number }> = [];
    const intercept: Intercept = async (_scope, path, _request, real) => {
      if (path !== "/net/ordered-children" && path !== "/net/ordered-neighbors") return null;
      const res = await real();
      const text = await res.text();
      fetches.push({ path, bytes: text.length });
      return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
    };
    return { fetches, intercept };
  }

  it("P2.4: a wide-parent add reads O(1) ordering neighbours, never the full sibling list", async () => {
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };

    const SIBLINGS = 120;
    for (let i = 0; i < SIBLINGS; i += 1) {
      const r = await world.directCall(`w-seed-${i}`, actor, theOutline, "add", [`seed ${i}`], { sessionId: session.id });
      expect(r.op, `seed add ${i}: ${JSON.stringify(r)}`).toBe("result");
    }

    const { fetches, intercept } = await recordOrderingFetches();
    const { gateway, gatewayEnv } = await mountNet(world, epoch, { intercept });
    const turn = await addTurn(gateway, gatewayEnv, ctx, "wide-add", "one more");
    expect(turn.reply.status, `attempts=${turn.attempt} trace=${JSON.stringify(turn.trace)}`).toBe("accepted");

    // The mutation must never fetch a full sibling list — neither as the
    // verb-flag pre-seed nor as an ordered-children repair round.
    const fullList = fetches.filter((f) => f.path === "/net/ordered-children");
    expect(fullList, `full-list ordering fetches: ${JSON.stringify(fetches)}`).toEqual([]);
    // The slot is picked from bounded neighbour replies: present, and each
    // constant-size (two ranks + count — never O(width)).
    const neighbours = fetches.filter((f) => f.path === "/net/ordered-neighbors");
    expect(neighbours.length, `ordering fetches: ${JSON.stringify(fetches)}`).toBeGreaterThan(0);
    for (const f of neighbours) expect(f.bytes, `neighbour reply too large: ${JSON.stringify(fetches)}`).toBeLessThan(NEIGHBOR_REPLY_BYTE_CEILING);
  });

  it("P2.4: a wide-parent reorder converges on bounded neighbour reads (index + exclusion, no full list)", async () => {
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };

    // Seed with add_item to capture item ids; reorder needs a target row.
    const SIBLINGS = 120;
    const ids: string[] = [];
    for (let i = 0; i < SIBLINGS; i += 1) {
      const r = await world.directCall(`r-seed-${i}`, actor, theOutline, "add_item", [`seed ${i}`, null, null], { sessionId: session.id });
      expect(r.op, `seed add_item ${i}: ${JSON.stringify(r)}`).toBe("result");
      ids.push((r as { result: string }).result);
    }

    const { fetches, intercept } = await recordOrderingFetches();
    const { gateway, gatewayEnv, scopeDOs } = await mountNet(world, epoch, { intercept });
    // Move the LAST item to slot 3 — exercises the child-index lookup (the
    // old position for undo/no-op) and the exclude-self neighbour read.
    const moved = ids[ids.length - 1];
    const turn = await verbTurn(gateway, gatewayEnv, ctx, "wide-reorder", "reorder_item", [moved, 3]);
    expect(turn.reply.status, `attempts=${turn.attempt} trace=${JSON.stringify(turn.trace)}`).toBe("accepted");

    const fullList = fetches.filter((f) => f.path === "/net/ordered-children");
    expect(fullList, `full-list ordering fetches: ${JSON.stringify(fetches)}`).toEqual([]);
    const neighbours = fetches.filter((f) => f.path === "/net/ordered-neighbors");
    expect(neighbours.length, `ordering fetches: ${JSON.stringify(fetches)}`).toBeGreaterThan(0);
    for (const f of neighbours) expect(f.bytes, `neighbour reply too large: ${JSON.stringify(fetches)}`).toBeLessThan(NEIGHBOR_REPLY_BYTE_CEILING);

    // Authority proof: the item actually landed at slot 3 (0-based) of the
    // root ordering — the bounded read produced a CORRECT rank, not just a
    // cheap one.
    const roomDO = scopeDOs.get(roomScope)!;
    const roots = await call<{ rows: Array<{ child: string; rank: string }> }>(
      roomDO, { WOO_INTERNAL_SECRET: SECRET }, "/ordered-children", { parent: null }
    );
    expect(roots.rows[3]?.child, `root order: ${JSON.stringify(roots.rows.slice(0, 6))}`).toBe(moved);
  });

  // R2 — a FAILED ordering fetch is transient, not non-convergence. Only
  // "every named query already resident yet the re-plan still missed" is the
  // terminal planner-bug shape; a transport failure must stay on the bounded
  // attempt loop (retry next round; E_BUDGET with recovery_error trace if the
  // outage persists) — never an instant E_NONCONVERGENT_READ.
  it("R2: a ONE-SHOT ordered-neighbours fetch failure retries and commits", async () => {
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };
    let failures = 0;
    const { gateway, gatewayEnv } = await mountNet(world, epoch, {
      intercept: async (_scope, path) => {
        if (path === "/net/ordered-neighbors" && failures === 0) {
          failures += 1;
          return new Response("injected outage", { status: 500 });
        }
        return null;
      }
    });
    const turn = await addTurn(gateway, gatewayEnv, ctx, "r2-oneshot-nb", "survives one outage");
    expect(failures, "the fault actually fired").toBe(1);
    expect(turn.reply.status, `attempts=${turn.attempt} trace=${JSON.stringify(turn.trace)}`).toBe("accepted");
  });

  it("R2: a PERSISTENT ordered-neighbours outage exhausts to E_BUDGET, not E_NONCONVERGENT_READ", async () => {
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };
    const { gateway, gatewayEnv } = await mountNet(world, epoch, {
      intercept: async (_scope, path) =>
        path === "/net/ordered-neighbors" ? new Response("injected outage", { status: 500 }) : null
    });
    const err = await addTurn(gateway, gatewayEnv, ctx, "r2-persist-nb", "x").then(
      (ok) => { throw new Error(`expected rejection, got ${JSON.stringify(ok.reply)}`); },
      (e: unknown) => String(e)
    );
    expect(err, "an outage is not a planner bug").not.toContain("E_NONCONVERGENT_READ");
    expect(err, "persistent outage exhausts the budget with the trace explaining it").toContain("E_BUDGET");
  });

  it("R2: a ONE-SHOT ordered-children fetch failure retries and commits", async () => {
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };
    // eject_item drives _detach_item, whose kids read uses the FULL
    // ordered_children projection — the children repair branch.
    const p = ((await world.directCall("r2-seed-p", actor, theOutline, "add_item", ["parent", null, null], { sessionId: session.id })) as { result: string }).result;
    world.object(actor).flags.wizard = true;
    let failures = 0;
    const { gateway, gatewayEnv } = await mountNet(world, epoch, {
      intercept: async (_scope, path) => {
        if (path === "/net/ordered-children" && failures === 0) {
          failures += 1;
          return new Response("injected outage", { status: 500 });
        }
        return null;
      }
    });
    const turn = await verbTurn(gateway, gatewayEnv, ctx, "r2-oneshot-oc", "eject_item", [p]);
    expect(failures, "the fault actually fired").toBe(1);
    expect(turn.reply.status, `attempts=${turn.attempt} trace=${JSON.stringify(turn.trace)}`).toBe("accepted");
  });

  it("R2: a PERSISTENT ordered-children outage exhausts to E_BUDGET, not E_NONCONVERGENT_READ", async () => {
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };
    const p = ((await world.directCall("r2p-seed-p", actor, theOutline, "add_item", ["parent", null, null], { sessionId: session.id })) as { result: string }).result;
    world.object(actor).flags.wizard = true;
    const { gateway, gatewayEnv } = await mountNet(world, epoch, {
      intercept: async (_scope, path) =>
        path === "/net/ordered-children" ? new Response("injected outage", { status: 500 }) : null
    });
    const err = await verbTurn(gateway, gatewayEnv, ctx, "r2-persist-oc", "eject_item", [p]).then(
      (ok) => { throw new Error(`expected rejection, got ${JSON.stringify(ok.reply)}`); },
      (e: unknown) => String(e)
    );
    expect(err, "an outage is not a planner bug").not.toContain("E_NONCONVERGENT_READ");
    expect(err, "persistent outage exhausts the budget with the trace explaining it").toContain("E_BUDGET");
  });

  it("P1.1: two concurrent same-slot inserts commit DISTINCT ranks (the ordering read is attested)", async () => {
    // Both turns plan against the SAME empty root (a barrier holds both submits
    // until both have planned), so each computes the first rank ("V"). Without
    // attesting the ordering projection, the second rebases behind the first's
    // committed head and commits the SAME rank -> two children at "V". The
    // ordering read must be authority-versioned so the second is rejected,
    // re-plans against the now-nonempty ordering, and gets a DISTINCT rank.
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };
    let pending = 0;
    let release: () => void = () => {};
    const bothPlanned = new Promise<void>((r) => { release = r; });
    const { gateway, gatewayEnv, scopeDOs } = await mountNet(world, epoch, {
      intercept: async (scope, path) => {
        // Delay (never override) the first submit of each turn until BOTH have
        // planned — forcing the second to have planned a stale ordering.
        if (scope === roomScope && path === "/net/submit") {
          pending += 1;
          if (pending >= 2) release();
          await bothPlanned;
        }
        return null;
      }
    });
    const [ra, rb] = await Promise.all([
      addTurn(gateway, gatewayEnv, ctx, "concurrent-a", "alpha"),
      addTurn(gateway, gatewayEnv, ctx, "concurrent-b", "beta")
    ]);
    expect(ra.reply.status, `A trace=${JSON.stringify(ra.trace)}`).toBe("accepted");
    expect(rb.reply.status, `B trace=${JSON.stringify(rb.trace)}`).toBe("accepted");
    // Authority proof: the root's children carry DISTINCT ranks (no collision).
    const roomDO = scopeDOs.get(roomScope)!;
    const roots = await call<{ rows: Array<{ child: string; rank: string }> }>(
      roomDO, { WOO_INTERNAL_SECRET: SECRET }, "/ordered-children", { parent: null }
    );
    const ranks = roots.rows.map((r) => r.rank);
    expect(roots.rows.length, "both inserts committed").toBeGreaterThanOrEqual(2);
    expect(new Set(ranks).size, `duplicate ranks: ${JSON.stringify(roots.rows)}`).toBe(ranks.length);
  });

  it("P1.2: net eject_item detaches + re-homes children after projection repair (miss not swallowed)", async () => {
    // eject_item(p) -> recycle(p) -> $outline_item:recycle
    //   `try { here:_detach_item(this,...) } except err {}`, and the substrate's
    // invokeRecycleHandler ALSO catches handler errors. _detach reads
    // ordered_children(p) + ordered_children(former_parent) — ABSENT in the
    // sparse gateway plan. If the miss were catchable, both catches would
    // swallow it, _detach would abort, and p's children would keep edges to the
    // recycled p (orphaned / vanished from list_items). The uncatchable miss
    // must instead escape to the gateway repair so the detach actually runs.
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };
    // Build p at root with two children, in-memory via the real verbs.
    const p = ((await world.directCall("seed-p", actor, theOutline, "add_item", ["parent", null, null], { sessionId: session.id })) as { result: string }).result;
    const c1 = ((await world.directCall("seed-c1", actor, theOutline, "add_item", ["child one", p, null], { sessionId: session.id })) as { result: string }).result;
    const c2 = ((await world.directCall("seed-c2", actor, theOutline, "add_item", ["child two", p, null], { sessionId: session.id })) as { result: string }).result;

    // eject_item is outliner-owner-or-wizard; grant the actor wizard so the
    // turn is permitted and exercises the pure recycle->_detach projection path
    // (unlike remove_item, eject does NOT pre-capture the projections).
    world.object(actor).flags.wizard = true;
    const { gateway, gatewayEnv, scopeDOs } = await mountNet(world, epoch);
    const eject = await verbTurn(gateway, gatewayEnv, ctx, "eject-p", "eject_item", [p]);
    expect(eject.reply.status, `attempts=${eject.attempt} trace=${JSON.stringify(eject.trace)}`).toBe("accepted");
    // The miss ESCAPED (not swallowed) → the gateway ran a repair round: > 1
    // attempt. A swallowed miss commits trivially at attempt 1 with no detach.
    expect(eject.attempt, `attempts=${eject.attempt}`).toBeGreaterThan(1);
    // _detach ran to completion (after repair) — it re-homes children THEN
    // emits outline_item_removed, all in one committed transcript. A swallowed
    // miss aborts _detach before both.
    const removed = (eject.observations ?? []).find((o) => o.type === "outline_item_removed" && o.item === p);
    expect(removed, "eject must emit outline_item_removed (detach ran, not swallowed)").toBeTruthy();
    expect(removed?.reparented_to ?? null).toBeNull(); // p was at root

    // Concrete proof from the AUTHORITY: the room scope's ordered-children of
    // root now includes c1/c2 (re-homed), each with a valid rank — NOT orphaned
    // to the recycled p.
    const roomDO = scopeDOs.get(`room:${theOutline}`)!;
    const roots = await call<{ rows: Array<{ child: string; rank: string }> }>(
      roomDO, { WOO_INTERNAL_SECRET: SECRET }, "/ordered-children", { parent: null }
    );
    const rootChildren = new Map(roots.rows.map((r) => [r.child, r.rank]));
    expect(rootChildren.has(c1), "c1 re-homed to root in the authority").toBe(true);
    expect(rootChildren.has(c2), "c2 re-homed to root in the authority").toBe(true);
    expect((rootChildren.get(c1) ?? "").length).toBeGreaterThan(0);
    // And they are no longer edged to the recycled parent p.
    const underP = await call<{ rows: Array<{ child: string }> }>(
      roomDO, { WOO_INTERNAL_SECRET: SECRET }, "/ordered-children", { parent: p }
    );
    expect(underP.rows.map((r) => r.child), "no orphaned edge to the recycled parent").not.toContain(c1);
  });

  it("P1.2: net undo of remove_item re-homes captured children under the restored node (miss not swallowed)", async () => {
    // undo -> _restore_item, whose child restore is
    //   `try { this:move_item(kid, item, kid_idx, true) } except err {}`.
    // move_item reads ordered_children(kid's parent) + ordered_children(new
    // item) — ABSENT in the sparse gateway plan. A catchable miss would be
    // swallowed by the `except`, leaving the captured children at root instead
    // of back under the restored node. The uncatchable miss must escape to the
    // gateway repair so move_item actually runs.
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };
    const p = ((await world.directCall("u-seed-p", actor, theOutline, "add_item", ["parent", null, null], { sessionId: session.id })) as { result: string }).result;
    const c1 = ((await world.directCall("u-seed-c1", actor, theOutline, "add_item", ["child one", p, null], { sessionId: session.id })) as { result: string }).result;
    // remove_item captures p + its direct children and re-homes them to root,
    // and records the _restore_item inverse in the actor's undo slot (in-memory).
    const rem = await world.directCall("u-remove", actor, theOutline, "remove_item", [p], { sessionId: session.id });
    expect((rem as { op: string }).op).toBe("result");

    const { gateway, gatewayEnv, scopeDOs } = await mountNet(world, epoch);
    const undo = await verbTurn(gateway, gatewayEnv, ctx, "undo-restore", "undo", []);
    expect(undo.reply.status, `attempts=${undo.attempt} trace=${JSON.stringify(undo.trace)}`).toBe("accepted");
    expect(undo.attempt, `attempts=${undo.attempt}`).toBeGreaterThan(1); // repair happened
    // _restore_item returns the restored node's (new) id via the undo result.
    const restored = undo.result as string;
    expect(typeof restored).toBe("string");

    // Authority proof: the restored node's ordered children now include c1/c2 —
    // move_item ran after repair (not swallowed, which would strand them at root).
    const roomDO = scopeDOs.get(`room:${theOutline}`)!;
    const kids = await call<{ rows: Array<{ child: string }> }>(
      roomDO, { WOO_INTERNAL_SECRET: SECRET }, "/ordered-children", { parent: restored }
    );
    const kidIds = kids.rows.map((r) => r.child);
    expect(kidIds, "captured child re-homed under the restored node").toContain(c1);
  });

  // R1 — same-turn mutations must see each other's ordering effects. The
  // planning world's ordering answers are fetched from the PRE-TURN
  // authority; without overlaying this turn's own __ordered_edge writes,
  // a second same-parent mutation in one turn reads a stale count/rank
  // (losing restored children to a spurious E_INDEX, or committing
  // duplicate ranks from one cached append answer).
  it("R1: net undo of a TWO-child remove re-homes BOTH children under the restored node", async () => {
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };
    const p = ((await world.directCall("r1u-seed-p", actor, theOutline, "add_item", ["parent", null, null], { sessionId: session.id })) as { result: string }).result;
    const c1 = ((await world.directCall("r1u-seed-c1", actor, theOutline, "add_item", ["child one", p, null], { sessionId: session.id })) as { result: string }).result;
    const c2 = ((await world.directCall("r1u-seed-c2", actor, theOutline, "add_item", ["child two", p, null], { sessionId: session.id })) as { result: string }).result;
    const rem = await world.directCall("r1u-remove", actor, theOutline, "remove_item", [p], { sessionId: session.id });
    expect((rem as { op: string }).op).toBe("result");

    const { gateway, gatewayEnv, scopeDOs } = await mountNet(world, epoch);
    const undo = await verbTurn(gateway, gatewayEnv, ctx, "r1u-undo", "undo", []);
    expect(undo.reply.status, `attempts=${undo.attempt} trace=${JSON.stringify(undo.trace)}`).toBe("accepted");
    const restored = undo.result as string;
    expect(typeof restored).toBe("string");

    // Authority proof: BOTH captured children re-homed under the restored
    // node, in captured order, with DISTINCT ranks. Before the overlay the
    // second move_item read the restored node's PRE-TURN (empty) ordering,
    // raised E_INDEX at index 1, was swallowed, and stranded c2 at root.
    const roomDO = scopeDOs.get(roomScope)!;
    const kids = await call<{ rows: Array<{ child: string; rank: string }> }>(
      roomDO, { WOO_INTERNAL_SECRET: SECRET }, "/ordered-children", { parent: restored }
    );
    const kidIds = kids.rows.map((r) => r.child);
    expect(kidIds, `restored children: ${JSON.stringify(kids.rows)}`).toEqual([c1, c2]);
    const kidRanks = kids.rows.map((r) => r.rank);
    expect(new Set(kidRanks).size, `duplicate ranks: ${JSON.stringify(kids.rows)}`).toBe(kidRanks.length);
  });

  it("R1: two adds in ONE turn commit DISTINCT ranks in call order (no cached-answer reuse)", async () => {
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };
    // A composite verb performing two same-parent appends in one turn. Both
    // reads hit the same append query; without the same-turn overlay the
    // second reuses the first's cached answer and computes the SAME rank.
    const installed = installVerb(
      world,
      theOutline,
      "add_twice",
      // _no_store: skip the per-actor undo bookkeeping — its room_roster
      // read needs the reads_room_presence pre-seed that this ad-hoc test
      // verb does not declare, and undo is not what this test is about.
      `verb :add_twice(a, b) rxd {\n  let i1 = this:add_item(a, null, null, true);\n  let i2 = this:add_item(b, null, null, true);\n  return [i1, i2];\n}`,
      null
    );
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    // One pre-existing sibling so the appends land after a real rank.
    const first = ((await world.directCall("r1d-seed", actor, theOutline, "add_item", ["first", null, null], { sessionId: session.id })) as { result: string }).result;

    const { gateway, gatewayEnv, scopeDOs } = await mountNet(world, epoch);
    const turn = await verbTurn(gateway, gatewayEnv, ctx, "r1d-twice", "add_twice", ["alpha", "beta"]);
    expect(turn.reply.status, `attempts=${turn.attempt} trace=${JSON.stringify(turn.trace)}`).toBe("accepted");
    expect((turn as Record<string, unknown>).error, `turn error: ${JSON.stringify((turn as Record<string, unknown>).error)}`).toBeUndefined();
    const [ia, ib] = turn.result as [string, string];

    const roomDO = scopeDOs.get(roomScope)!;
    const roots = await call<{ rows: Array<{ child: string; rank: string }> }>(
      roomDO, { WOO_INTERNAL_SECRET: SECRET }, "/ordered-children", { parent: null }
    );
    const ranks = roots.rows.map((r) => r.rank);
    expect(new Set(ranks).size, `duplicate ranks: ${JSON.stringify(roots.rows)}`).toBe(ranks.length);
    // Call order preserved: first, then alpha, then beta.
    expect(roots.rows.map((r) => r.child), `root order: ${JSON.stringify(roots.rows)}`).toEqual([first, ia, ib]);
  });

  // Adv-a — the ordering endpoints must REFUSE malformed queries with a
  // structured E_INVARG (never silently coerce a bad field into a
  // different-but-valid query), and the gateway must refuse a malformed
  // authority reply (wrong scope echo) as a failed fetch.
  it("Adv-a: /net/ordered-neighbors refuses malformed query fields with structured E_INVARG", async () => {
    const { world, theOutline, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const { scopeDOs } = await mountNet(world, epoch);
    const roomDO = scopeDOs.get(roomScope)!;
    const env = { WOO_INTERNAL_SECRET: SECRET };
    // A stringly index must not silently become "append".
    await expect(call(roomDO, env, "/ordered-neighbors", { parent: null, index: "0" }))
      .rejects.toThrow(/E_INVARG/);
    // A non-string exclude must not silently become "no exclusion".
    await expect(call(roomDO, env, "/ordered-neighbors", { parent: null, exclude: 42 }))
      .rejects.toThrow(/E_INVARG/);
    // A malformed parent is a structured E_INVARG, not a plain 500.
    await expect(call(roomDO, env, "/ordered-neighbors", { parent: 7 }))
      .rejects.toThrow(/E_INVARG/);
    await expect(call(roomDO, env, "/ordered-children", { parent: 7 }))
      .rejects.toThrow(/E_INVARG/);
  });

  it("Adv-a: the gateway refuses an ordering reply whose scope echo disagrees (failed fetch, not a commit)", async () => {
    const { world, theOutline, session, actor, epoch } = await outlinerWorld();
    const roomScope = `room:${theOutline}`;
    const ctx = { theOutline, roomScope, epoch, session, actor };
    const { gateway, gatewayEnv } = await mountNet(world, epoch, {
      intercept: async (_scope, path, _request, real) => {
        if (path !== "/net/ordered-neighbors") return null;
        const res = await real();
        const body = (await res.json()) as Record<string, unknown>;
        body.scope = "scope-imposter"; // a reply from the wrong authority
        return jsonResponse(body);
      }
    });
    const err = await addTurn(gateway, gatewayEnv, ctx, "adva-scope-echo", "x").then(
      (ok) => { throw new Error(`expected rejection, got ${JSON.stringify(ok.reply)}`); },
      (e: unknown) => String(e)
    );
    // Persistently-wrong replies exhaust the bounded loop as failed fetches.
    expect(err).toContain("E_BUDGET");
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
