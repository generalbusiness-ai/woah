import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { installLocalCatalogs } from "../src/core/local-catalogs";

// Pins the resolution tiers in spec/semantics/match.md §MA2:
//   Tier A: actor.contents — exact (name OR alias)
//   Tier B: location.contents — exact
//   Tier C: actor.contents — prefix
//   Tier D: location.contents — prefix
//   Tier E: actor.contents — body (substring — woo extension)
//   Tier F: location.contents — body
// Aliases fold into every tier (no separate alias tier). Tiers A–D mirror
// LambdaCore $string_utils:match_object so destructive verbs like @recycle
// prefer the thing in the actor's hand over a same-named thing in the room.
// Tiers E–F are a woo extension for content-driven matching (e.g. `read
// objects` matching a $note titled "Horoscope: World Of Objects").

async function callMatch(world: ReturnType<typeof createWorld>, actor: string, name: string, location: string) {
  const result = await world.directCall(`match-${name}-${location}`, actor, "$match", "match_object", [name, location]);
  if (result.op === "error") throw new Error(`match_object errored: ${result.error.code} ${result.error.message}`);
  if (result.op === "result") return result.result as string;
  throw new Error(`match_object returned an unexpected frame`);
}

function setupRoomWithActor(label: string) {
  const world = createWorld({ catalogs: false });
  installLocalCatalogs(world, ["chat"]);
  const roomId = `obj_test_${label}_room`;
  world.createObject({ id: roomId, name: "Match Room", parent: "$room", owner: "$wiz" });
  const actor = world.auth(`guest:${label}`).actor;
  world.setProp(actor, "location", roomId);
  world.setProp(roomId, "subscribers", [actor]);
  return { world, roomId, actor };
}

describe("match_object §MA2 resolution tiers", () => {
  it("inventory exact wins over location exact (LambdaCore signature)", async () => {
    const { world, roomId, actor } = setupRoomWithActor("inv-exact-over-room-exact");
    world.createObject({ id: "obj_book_inventory", name: "book", parent: "$thing", owner: "$wiz", location: actor });
    world.createObject({ id: "obj_book_room", name: "book", parent: "$thing", owner: "$wiz", location: roomId });
    expect(await callMatch(world, actor, "book", roomId)).toBe("obj_book_inventory");
  });

  it("inventory exact wins over location prefix", async () => {
    const { world, roomId, actor } = setupRoomWithActor("inv-exact-over-room-prefix");
    world.createObject({ id: "obj_lamp_inventory", name: "lamp", parent: "$thing", owner: "$wiz", location: actor });
    world.createObject({ id: "obj_lamprey_room", name: "lamprey", parent: "$thing", owner: "$wiz", location: roomId });
    expect(await callMatch(world, actor, "lamp", roomId)).toBe("obj_lamp_inventory");
  });

  it("location exact wins over inventory prefix", async () => {
    const { world, roomId, actor } = setupRoomWithActor("room-exact-over-inv-prefix");
    world.createObject({ id: "obj_keyring_inventory", name: "keyring", parent: "$thing", owner: "$wiz", location: actor });
    world.createObject({ id: "obj_key_room", name: "key", parent: "$thing", owner: "$wiz", location: roomId });
    expect(await callMatch(world, actor, "key", roomId)).toBe("obj_key_room");
  });

  it("inventory prefix wins over location prefix", async () => {
    const { world, roomId, actor } = setupRoomWithActor("inv-prefix-over-room-prefix");
    world.createObject({ id: "obj_lampshade_inventory", name: "lampshade", parent: "$thing", owner: "$wiz", location: actor });
    world.createObject({ id: "obj_lamprey_room", name: "lamprey", parent: "$thing", owner: "$wiz", location: roomId });
    expect(await callMatch(world, actor, "lamp", roomId)).toBe("obj_lampshade_inventory");
  });

  it("falls through to location prefix when inventory is empty", async () => {
    const { world, roomId, actor } = setupRoomWithActor("location-prefix-fallback");
    world.createObject({ id: "obj_lamprey_room", name: "lamprey", parent: "$thing", owner: "$wiz", location: roomId });
    expect(await callMatch(world, actor, "lamp", roomId)).toBe("obj_lamprey_room");
  });

  it("alias matches count as exact (folded into tier A/B)", async () => {
    const { world, roomId, actor } = setupRoomWithActor("alias-folds-into-exact");
    // Inventory has a prefix-only candidate; room has an alias-exact match.
    // If aliases were a separate tier below "exact", the inventory's prefix
    // tier would erroneously win. Folded into exact, the room's alias match
    // wins.
    world.createObject({ id: "obj_keyring_inventory", name: "keyring", parent: "$thing", owner: "$wiz", location: actor });
    world.createObject({ id: "obj_key_room", name: "skeleton", parent: "$thing", owner: "$wiz", location: roomId });
    world.setProp("obj_key_room", "aliases", ["key"]);
    expect(await callMatch(world, actor, "key", roomId)).toBe("obj_key_room");
  });

  it("inventory alias-exact wins over location name-exact", async () => {
    const { world, roomId, actor } = setupRoomWithActor("inv-alias-over-room-name");
    world.createObject({ id: "obj_brass_inventory", name: "brass key", parent: "$thing", owner: "$wiz", location: actor });
    world.setProp("obj_brass_inventory", "aliases", ["key"]);
    world.createObject({ id: "obj_other_key_room", name: "key", parent: "$thing", owner: "$wiz", location: roomId });
    expect(await callMatch(world, actor, "key", roomId)).toBe("obj_brass_inventory");
  });

  it("returns $ambiguous_match when two inventory candidates exact-match", async () => {
    const { world, roomId, actor } = setupRoomWithActor("inv-ambiguous");
    world.createObject({ id: "obj_book_a", name: "book", parent: "$thing", owner: "$wiz", location: actor });
    world.createObject({ id: "obj_book_b", name: "book", parent: "$thing", owner: "$wiz", location: actor });
    expect(await callMatch(world, actor, "book", roomId)).toBe("$ambiguous_match");
  });

  it("returns $failed_match when nothing matches", async () => {
    const { world, roomId, actor } = setupRoomWithActor("nothing-matches");
    world.createObject({ id: "obj_apple_room", name: "apple", parent: "$thing", owner: "$wiz", location: roomId });
    expect(await callMatch(world, actor, "zebra", roomId)).toBe("$failed_match");
  });

  it("falls through to body (substring) tier as last resort", async () => {
    // "ndle" is a substring of "candle" but not a prefix. With no exact or
    // prefix candidate, the body tier resolves the match.
    const { world, roomId, actor } = setupRoomWithActor("body-fallback");
    world.createObject({ id: "obj_candle_room", name: "candle", parent: "$thing", owner: "$wiz", location: roomId });
    expect(await callMatch(world, actor, "ndle", roomId)).toBe("obj_candle_room");
  });

  it("body tier comes after every prefix tier", async () => {
    // A prefix match in the room must beat a body match in inventory. This
    // pins the "body last" ordering: even an inventory body candidate loses
    // to any location prefix candidate.
    const { world, roomId, actor } = setupRoomWithActor("body-after-prefix");
    // Inventory: "jar" matches "glass" only via a body alias (substring).
    world.createObject({ id: "obj_jar_inv", name: "jar", parent: "$thing", owner: "$wiz", location: actor });
    world.setProp("obj_jar_inv", "aliases", ["a bag of glass marbles"]);
    // Location: "glasses" matches "glass" as a prefix on the name.
    world.createObject({ id: "obj_glasses_room", name: "glasses", parent: "$thing", owner: "$wiz", location: roomId });
    expect(await callMatch(world, actor, "glass", roomId)).toBe("obj_glasses_room");
  });

  it("matches `me` to the actor and `here` to the location", async () => {
    const { world, roomId, actor } = setupRoomWithActor("me-and-here");
    expect(await callMatch(world, actor, "me", roomId)).toBe(actor);
    expect(await callMatch(world, actor, "here", roomId)).toBe(roomId);
  });

  it("requires at least 2 characters for a prefix match", async () => {
    // A 1-character "name" only resolves on exact match, never prefix —
    // otherwise typing "k" would silently match anything starting with k.
    const { world, roomId, actor } = setupRoomWithActor("prefix-min-length");
    world.createObject({ id: "obj_keyring_room", name: "keyring", parent: "$thing", owner: "$wiz", location: roomId });
    expect(await callMatch(world, actor, "k", roomId)).toBe("$failed_match");
  });
});
