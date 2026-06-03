import { describe, expect, it } from "vitest";
import { fanOutHostWrites } from "../src/core/object-host-write-through";
import { createWorld } from "../src/core/bootstrap";
import { executeInProcessV2DurableTurn, materializeDevV2CommitLocally } from "../src/server/dev-v2-helpers";
import { createShadowBrowserRelayShim, shadowBrowserSessionBearer } from "../src/core/shadow-browser-node";
import type { ShadowRelayCache } from "../src/core/shadow-relay-cache";
import type { MetricEvent, ObjRef, WooValue } from "../src/core/types";

// The shared object-host write-through fan-out — the seam CF and localdev now
// both run, so localdev exercises the same local-apply + remote-forward + E_RETRY
// failure modes (timeout/partial fanout) that previously only existed on CF.
describe("object-host write-through fan-out", () => {
  it("applies the local slice and forwards the rest; reports the local materialization", async () => {
    const log: string[] = [];
    const metrics: MetricEvent[] = [];
    const result = await fanOutHostWrites<string>({
      localHostKey: "world",
      isGatewayHost: (h) => h === "world",
      slicesByHost: new Map([["world", "W"], ["host_a", "A"], ["host_b", "B"]]),
      scope: "the_chatroom",
      touched: 3,
      retryMessage: "rt",
      onMetric: (e) => metrics.push(e),
      applyLocal: (s) => { log.push(`local:${s}`); },
      forwardRemote: (h, s) => { log.push(`fwd:${h}:${s}`); return Promise.resolve(); }
    });
    expect(result).toEqual({ hostKey: "world", gatewayHost: true });
    expect(log[0]).toBe("local:W"); // local applies first
    expect(log.slice(1).sort()).toEqual(["fwd:host_a:A", "fwd:host_b:B"]);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ kind: "v2_host_apply_fanout", status: "ok", hosts: 3, scope: "the_chatroom" });
  });

  it("returns null when this node owns no touched cell (forward-only)", async () => {
    const result = await fanOutHostWrites<string>({
      localHostKey: "world",
      isGatewayHost: (h) => h === "world",
      slicesByHost: new Map([["host_a", "A"]]),
      scope: "s", touched: 1, retryMessage: "rt",
      applyLocal: () => { throw new Error("should not apply locally"); },
      forwardRemote: () => Promise.resolve()
    });
    expect(result).toBeNull();
  });

  it("a forward failure raises E_RETRY and records an error metric (no silent partial accept)", async () => {
    const metrics: MetricEvent[] = [];
    await expect(fanOutHostWrites<string>({
      localHostKey: "world",
      isGatewayHost: (h) => h === "world",
      slicesByHost: new Map([["world", "W"], ["host_a", "A"]]),
      scope: "s", touched: 2, retryMessage: "object-host write-through failed",
      onMetric: (e) => metrics.push(e),
      applyLocal: () => undefined,
      forwardRemote: () => Promise.reject(new Error("rpc timeout"))
    })).rejects.toMatchObject({ code: "E_RETRY" });
    expect(metrics.at(-1)).toMatchObject({ kind: "v2_host_apply_fanout", status: "error" });
  });
});

// Localdev now drives the same fan-out, so an injected forward failure produces
// the CF E_RETRY contract (with the local host already materialized — the exact
// "commit accepted but write-through partially failed, retry" shape).
describe("localdev object-host write-through fault injection", () => {
  function resolvers(world: ReturnType<typeof createWorld>, tag: string) {
    const gateways = new Map<ObjRef, ShadowRelayCache>();
    const commits = new Map<ObjRef, ShadowRelayCache>();
    const sparse = createWorld({ catalogs: false }).exportWorld();
    return {
      gatewayRelayForScope: (s: ObjRef) => gateways.get(s) ?? (gateways.set(s, createShadowBrowserRelayShim({ node: `gw-${tag}-${s}`, scope: s, serialized: sparse, deployment: "local-dev" })), gateways.get(s)!),
      commitRelayForScope: (s: ObjRef) => commits.get(s) ?? (commits.set(s, createShadowBrowserRelayShim({ node: `c-${tag}-${s}`, scope: s, serialized: world.exportWorld(), deployment: "local-dev" })), commits.get(s)!)
    };
  }
  async function move(world: ReturnType<typeof createWorld>, r: ReturnType<typeof resolvers>, id: string, session: string, actor: ObjRef, verb: string, args: WooValue[]) {
    const s = await executeInProcessV2DurableTurn({ world, gatewayRelayForScope: r.gatewayRelayForScope, commitRelayForScope: r.commitRelayForScope, node: `gw-${id}`,
      call: { id, route: "sequenced", scope: "the_chatroom", session, actor, target: "the_chatroom", verb, args, persistence: "durable", token: shadowBrowserSessionBearer({ id: session, actor }) } });
    if (s.kind !== "submitted" || !s.reply?.ok) throw new Error(`turn ${id} failed`);
    return s.reply;
  }

  it("a forward failure during a multi-host move materialize raises E_RETRY", async () => {
    const world = createWorld();
    const g = world.auth("guest:ohwt");
    const r = resolvers(world, "ohwt");
    const enter = await move(world, r, "enter", g.id, g.actor, "enter", []);
    await materializeDevV2CommitLocally(world, enter.commit!.position.scope, enter.transcript!);

    const se = await move(world, r, "se", g.id, g.actor, "southeast", []);
    const hosts: string[] = [];
    await expect(materializeDevV2CommitLocally(world, se.commit!.position.scope, se.transcript!, {
      onRemoteForward: (host) => { hosts.push(host); throw new Error(`object-host RPC timeout for ${host}`); }
    })).rejects.toMatchObject({ code: "E_RETRY" });
    // At least one remote host forward was attempted (the partition fanned out).
    expect(hosts.length).toBeGreaterThan(0);
  });

  it("without injected faults the same move materializes cleanly through the fan-out", async () => {
    const world = createWorld();
    const g = world.auth("guest:ohwt-ok");
    const r = resolvers(world, "ohwt-ok");
    const enter = await move(world, r, "enter", g.id, g.actor, "enter", []);
    await materializeDevV2CommitLocally(world, enter.commit!.position.scope, enter.transcript!);
    const se = await move(world, r, "se", g.id, g.actor, "southeast", []);
    await expect(materializeDevV2CommitLocally(world, se.commit!.position.scope, se.transcript!)).resolves.toBeUndefined();
    // The move materialized: the actor is present in the destination room.
    expect(Array.from(world.presenceActorsIn("the_deck") ?? [])).toContain(g.actor);
  });
});
