// Elastic guest creation is an ordinary owner-sequenced commit, not a
// side database write. This lane proves the actor, properties, session,
// placement relations, replay, and collision guard at the pure sequencer.
import { describe, expect, it } from "vitest";
import { provisionGuestSubmit, type GuestTemplate } from "../../src/net/guest";
import { ScopeSequencer } from "../../src/net/scope";

const EPOCH = "cat-guest-provision-1";
const TEMPLATE: GuestTemplate = {
  version: 1,
  parent: "$guest",
  owner: "$wiz",
  description: "Temporary guest identity.",
  home: "$nowhere",
  initial_room: "the_chatroom"
};

describe("elastic guest provisioning", () => {
  it("atomically creates the actor and session at the fresh cluster owner", () => {
    const planned = provisionGuestSubmit({
      actor: "guest_net_abc",
      session: "s_net-api-2_abc",
      ttl_ms: 60_000,
      now: 1_000,
      epoch: EPOCH,
      template: TEMPLATE
    });
    const seq = new ScopeSequencer(planned.clusterScope, EPOCH, {
      authorize: () => {},
      owns: (object) => object === "guest_net_abc"
    });
    const reply = seq.submit(planned.submit);
    expect(reply.status).toBe("accepted");
    expect(seq.store.get("object_lineage:guest_net_abc")?.value).toMatchObject({ parent: "$guest", owner: "$wiz" });
    expect(seq.store.get("object_live:guest_net_abc")?.value).toEqual({ location: "the_chatroom" });
    expect(seq.store.get("property_cell:guest_net_abc:home")?.value).toEqual({ value: "$nowhere" });
    expect(seq.store.get("session:s_net-api-2_abc")?.value).toMatchObject({
      actor: "guest_net_abc",
      activeScope: "the_chatroom",
      ephemeralActor: true,
      expiresAt: 61_000
    });
    const relations = [...seq.relations().values()];
    expect(relations).toContainEqual({ relation: "contents", owner: "the_chatroom", member: "guest_net_abc" });
    expect(relations).toContainEqual({
      relation: "session_presence",
      owner: "the_chatroom",
      member: "s_net-api-2_abc",
      body: {
        actor: "guest_net_abc",
        name: "Guest _net_abc",
        session: {
          activeScope: "the_chatroom",
          actor: "guest_net_abc",
          ephemeralActor: true,
          expiresAt: 61_000,
          id: "s_net-api-2_abc",
          started: 1_000
        }
      }
    });
    expect(seq.submit(planned.submit)).toMatchObject({ status: "accepted", replayed: true });
  });

  it("refuses an actor collision instead of overwriting authority", () => {
    const input = {
      actor: "guest_net_collision",
      session: "s_net-api-2_collision",
      ttl_ms: 60_000,
      now: 1_000,
      epoch: EPOCH,
      template: TEMPLATE
    };
    const first = provisionGuestSubmit(input);
    const seq = new ScopeSequencer(first.clusterScope, EPOCH, { authorize: () => {} });
    expect(seq.submit(first.submit).status).toBe("accepted");
    const second = provisionGuestSubmit({ ...input, session: "s_net-api-2_other", now: 2_000 });
    expect(seq.submit({ ...second.submit, base: seq.head() })).toMatchObject({
      status: "rejected",
      reason: "read_version_mismatch",
      detail: { create_collision: "guest_net_collision" }
    });
  });
});
