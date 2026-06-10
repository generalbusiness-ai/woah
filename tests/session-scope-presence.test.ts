import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { executeInProcessV2DurableTurn, materializeDevV2CommitLocally } from "../src/server/dev-v2-helpers";
import { createShadowBrowserRelayShim, shadowBrowserSessionBearer } from "../src/core/shadow-browser-node";
import { applyPresenceProjectionRowDelta, sessionScopePresenceDeltas, effectTranscriptFromRecordedTurn } from "../src/core/effect-transcript";
import { InMemoryTurnRecorder } from "../src/core/turn-recorder";
import type { ShadowRelayCache } from "../src/core/shadow-relay-cache";
import type { ObjRef, WooValue } from "../src/core/types";

// CA8 presence: a session active-scope transition (not a physical move) drives
// presence projections, and live-delivery audience reads the session/audience
// table (activeScope). Regression for the peer-departure fanout gap.
describe("session-scope presence (CA8)", () => {
  function resolvers(world: ReturnType<typeof createWorld>, tag: string) {
    const gateways = new Map<ObjRef, ShadowRelayCache>();
    const commits = new Map<ObjRef, ShadowRelayCache>();
    const sparse = createWorld({ catalogs: false }).exportWorld();
    return {
      gatewayRelayForScope: (s: ObjRef) => gateways.get(s) ?? (gateways.set(s, createShadowBrowserRelayShim({ node: `gw-${tag}-${s}`, scope: s, serialized: sparse, deployment: "local-dev" })), gateways.get(s)!),
      commitRelayForScope: (s: ObjRef) => commits.get(s) ?? (commits.set(s, createShadowBrowserRelayShim({ node: `c-${tag}-${s}`, scope: s, serialized: world.exportWorld(), deployment: "local-dev" })), commits.get(s)!)
    };
  }
  async function durable(world: ReturnType<typeof createWorld>, r: ReturnType<typeof resolvers>, c: { id: string; scope: ObjRef; session: string; actor: ObjRef; target: ObjRef; verb: string; args: WooValue[] }) {
    const s = await executeInProcessV2DurableTurn({ world, gatewayRelayForScope: r.gatewayRelayForScope, commitRelayForScope: r.commitRelayForScope, node: `gw-${c.id}`,
      call: { ...c, route: "sequenced", persistence: "durable", token: shadowBrowserSessionBearer({ id: c.session, actor: c.actor }) } });
    if (s.kind !== "submitted" || !s.reply?.ok) throw new Error(`turn ${c.id} failed`);
    if (s.reply.commit && s.reply.transcript) await materializeDevV2CommitLocally(world, s.reply.commit.position.scope, s.reply.transcript);
    return s.reply;
  }

  it("applyPresenceProjectionRowDelta is idempotent and keyed by member", () => {
    const sessionDef = { kind: "presence" as const, key: "session" as const, sessionField: "session", actorField: "actor" };
    let v = applyPresenceProjectionRowDelta(null, { room: "r", property: "session_subscribers", def: sessionDef, op: "add", actor: "a1", session: "s1" });
    v = applyPresenceProjectionRowDelta(v, { room: "r", property: "session_subscribers", def: sessionDef, op: "add", actor: "a1", session: "s1" }); // duplicate
    expect(v).toEqual([{ session: "s1", actor: "a1" }]);
    v = applyPresenceProjectionRowDelta(v, { room: "r", property: "session_subscribers", def: sessionDef, op: "remove", actor: "a1", session: "s1" });
    expect(v).toEqual([]);
  });

  it("a transition (not a move) yields presence add/remove deltas; a move without a transition yields none", () => {
    const recorder = new InMemoryTurnRecorder();
    const active = recorder.startTurn({ route: "sequenced", scope: "the_chatroom", seq: 0, session: "s1", actor: "guest_1", target: "the_chatroom", verb: "southeast", args: [] });
    active.event({ kind: "session_scope", session: "s1", actor: "guest_1", from: "the_chatroom", to: "the_deck" });
    active.event({ kind: "turn_finish", ok: true });
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript.sessionScopeTransition).toEqual({ session: "s1", actor: "guest_1", from: "the_chatroom", to: "the_deck" });
    const props = (room: ObjRef) => room === "the_chatroom" || room === "the_deck" ? [{ name: "session_subscribers", def: { kind: "presence" as const, key: "session" as const, sessionField: "session", actorField: "actor" } }] : [];
    const deltas = sessionScopePresenceDeltas(props, transcript);
    expect(deltas).toEqual([
      { room: "the_chatroom", property: "session_subscribers", def: expect.anything(), op: "remove", actor: "guest_1", session: "s1" },
      { room: "the_deck", property: "session_subscribers", def: expect.anything(), op: "add", actor: "guest_1", session: "s1" }
    ]);
  });

  it("live-delivery audience includes a co-present peer through the session/audience table after another actor moves out", async () => {
    const world = createWorld();
    const first = world.auth("guest:ssp-first");
    const second = world.auth("guest:ssp-second");
    const r = resolvers(world, "depart");
    await durable(world, r, { id: "f-enter", scope: "the_chatroom", session: first.id, actor: first.actor, target: "the_chatroom", verb: "enter", args: [] });
    await durable(world, r, { id: "s-enter", scope: "the_chatroom", session: second.id, actor: second.actor, target: "the_chatroom", verb: "enter", args: [] });
    const se = await durable(world, r, { id: "s-se", scope: "the_chatroom", session: second.id, actor: second.actor, target: "the_chatroom", verb: "southeast", args: [] });

    // The `left` observation the exit emits, sourced at the old room.
    const left = (se.transcript?.observations ?? []).find((o: any) => o.type === "left");
    if (!left) throw new Error("expected a `left` observation");
    const audiences = await world.computeDirectLiveAudiences(se.commit!.position.scope, [left]);
    // first (still in the_chatroom) is in the audience; second (the mover) is excluded.
    expect(audiences.observationAudiences?.[0]).toContain(first.actor);
    expect(audiences.observationAudiences?.[0]).not.toContain(second.actor);
  });

  it("a session born in a room (activeScope set, no enter turn) is still in the live audience", async () => {
    const world = createWorld();
    const watcher = world.auth("guest:ssp-watch");
    // Simulate session-creation placement: activeScope set without any turn.
    const sess = world.sessions.get(watcher.id)!;
    sess.activeScope = "the_chatroom";
    const audiences = await world.computeDirectLiveAudiences("the_chatroom", [
      { type: "said", source: "the_chatroom", actor: "guest_other", text: "hi" } as any
    ]);
    expect(audiences.observationAudiences?.[0]).toContain(watcher.actor);
    expect(audiences.audienceSessions).toContain(watcher.id);
  });

  it("present_actors reads the session table when the presence projection is absent", async () => {
    const world = createWorld();
    const watcher = world.auth("guest:ssp-roster");
    const sess = world.sessions.get(watcher.id)!;
    sess.activeScope = "the_chatroom";
    world.setProp("the_chatroom", "session_subscribers", []);
    world.setProp("the_chatroom", "subscribers", []);

    await expect(world.presentActorsIn({} as any, "the_chatroom")).resolves.toContain(watcher.actor);
  });
});
