import { describe, expect, it } from "vitest";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import { executeInProcessV2DurableTurn } from "../src/server/dev-v2-helpers";
import { createShadowBrowserRelayShim, shadowBrowserSessionBearer } from "../src/core/shadow-browser-node";
import type { ShadowRelayCache } from "../src/core/shadow-relay-cache";
import type { ObjRef, WooValue } from "../src/core/types";

// Regression: applyProjectionWrites -> mergeScopedProjectionObject must include a
// member CREATED directly in a container in that container's contents
// projection. A create is neither a `contents` write nor a `move`, so the merge
// previously dropped it — on a host materializing via projection rows (CF
// projection-mode) a note minted into a room/board was missing from the room's
// contents, so look/contents()/roster there never saw it.
describe("projection-mode create contents", () => {
  function resolvers(world: ReturnType<typeof createWorld>, tag: string) {
    const g = new Map<ObjRef, ShadowRelayCache>(), c = new Map<ObjRef, ShadowRelayCache>();
    const sparse = createWorld({ catalogs: false }).exportWorld();
    return {
      gatewayRelayForScope: (s: ObjRef) => g.get(s) ?? (g.set(s, createShadowBrowserRelayShim({ node: `gw-${tag}-${s}`, scope: s, serialized: sparse, deployment: "local-dev" })), g.get(s)!),
      commitRelayForScope: (s: ObjRef) => c.get(s) ?? (c.set(s, createShadowBrowserRelayShim({ node: `c-${tag}-${s}`, scope: s, serialized: world.exportWorld(), deployment: "local-dev" })), c.get(s)!)
    };
  }

  it("a member created-with-location appears in the container's contents after projection-write apply", async () => {
    // The outliner's add_item does `create($outline_item, { location: this })` —
    // a create WITH location and NO moveto. That is the case the contents merge
    // missed (a move would otherwise cover it, as add_note's create+moveto does).
    const world = createWorld();
    const g = world.auth("guest:proj-create");
    const r = resolvers(world, "proj-create");
    const token = shadowBrowserSessionBearer({ id: g.id, actor: g.actor });
    await world.directCall("setup-enter", g.actor, "the_outline", "enter", [], { sessionId: g.id });

    // A receiver host that has the_outline but NOT the new item yet — the shape a
    // satellite object-host is in when it receives the commit's projection rows.
    const receiver = createWorldFromSerialized(world.exportWorld(), { persist: false });

    const add = await executeInProcessV2DurableTurn({
      world, gatewayRelayForScope: r.gatewayRelayForScope, commitRelayForScope: r.commitRelayForScope, node: "gw-add",
      call: { id: "add", route: "sequenced", scope: "the_outline", session: g.id, actor: g.actor, target: "the_outline", verb: "add", args: ["projection item"] as WooValue[], persistence: "durable", token }
    });
    if (add.kind !== "submitted" || !add.reply?.ok || !add.reply.commit || !add.reply.transcript) throw new Error("add failed");
    const itemId = add.reply.transcript.creates[0]?.object;
    expect(typeof itemId).toBe("string");
    // The created item carries a location but no move — the exact shape that was dropped.
    expect(add.reply.transcript.creates[0]?.location).toBe("the_outline");
    expect(add.reply.transcript.moves.some((m) => m.object === itemId)).toBe(false);
    const writes = add.reply.commit.projection_writes ?? [];

    // Apply the accepted commit's projection rows to the receiver, exactly as a
    // satellite object-host does (with the transcript so the merge sees the create).
    receiver.applyProjectionWrites(writes, { transcript: add.reply.transcript });

    expect(Array.from(receiver.object("the_outline").contents)).toContain(itemId);
  });
});
