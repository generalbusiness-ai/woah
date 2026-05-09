import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";

// Pins the LambdaCore-faithful `@recycle` chat verb on $builder. The verb is
// a near-line-for-line port of LambdaCore's $builder:@recycle (#630); see
// catalogs/prog/manifest.json for the source and the three documented
// divergences (matcher route, missing $command_utils, the_perm gate).

function findTextObservation(observations: any[], target: string): string | undefined {
  for (const obs of observations) {
    if (obs?.type !== "text") continue;
    if (obs?.target !== target) continue;
    if (typeof obs?.text === "string") return obs.text;
  }
  return undefined;
}

async function mintWizSession(world: ReturnType<typeof createWorld>) {
  const minted = await world.directCall(
    "mint-wiz-session",
    "$wiz",
    "$system",
    "mint_session_for",
    ["$wiz"]
  );
  if (minted.op !== "result") throw new Error(`mint_session_for failed: ${minted.op}`);
  return (minted.result as { id: string; actor: string }).id;
}

describe("$builder:@recycle (LambdaCore #630 port)", () => {
  it("makes $wiz a $programmer descendant after install", () => {
    const world = createWorld();
    expect(world.isDescendantOf("$wiz", "$programmer")).toBe(true);
    expect(world.isDescendantOf("$wiz", "$builder")).toBe(true);
  });

  it("recycles a wizard-owned object resolved from inventory", async () => {
    const world = createWorld();
    world.createObject({
      id: "obj_recycle_book",
      name: "book",
      parent: "$thing",
      owner: "$wiz",
      location: "$wiz"
    });
    // createObject sets the WooObject.name attribute; woocode reads
    // `dobj.name` through the property layer, so mirror to the property too
    // (matches createAuthoredObject's "keep them mirrored" rule).
    world.setProp("obj_recycle_book", "name", "book");
    const result = await world.directCall(
      "recycle-book",
      "$wiz",
      "$wiz",
      "recycle_command",
      ["book"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(world.objects.has("obj_recycle_book")).toBe(false);
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/book \(#obj_recycle_book\) recycled\./);
  });

  it("prints a usage line when no object is named", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "recycle-usage",
      "$wiz",
      "$wiz",
      "recycle_command",
      [""]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/Usage: @recycle <object>/);
  });

  it("notifies on $failed_match without throwing", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "recycle-ghost",
      "$wiz",
      "$wiz",
      "recycle_command",
      ["ghost"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/I don't see 'ghost' here/);
  });

  it("notifies on $ambiguous_match without recycling either candidate", async () => {
    const world = createWorld();
    world.createObject({ id: "obj_ambig_a", name: "twin", parent: "$thing", owner: "$wiz", location: "$wiz" });
    world.createObject({ id: "obj_ambig_b", name: "twin", parent: "$thing", owner: "$wiz", location: "$wiz" });
    const result = await world.directCall(
      "recycle-twin",
      "$wiz",
      "$wiz",
      "recycle_command",
      ["twin"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/I don't know which 'twin' you mean/);
    expect(world.objects.has("obj_ambig_a")).toBe(true);
    expect(world.objects.has("obj_ambig_b")).toBe(true);
  });

  it("blocks self-recycle (LambdaCore L7-8)", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "recycle-self",
      "$wiz",
      "$wiz",
      "recycle_command",
      ["me"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/You can't recycle yourself/);
    expect(world.objects.has("$wiz")).toBe(true);
  });

  it("dispatches `@recycle <name>` end-to-end through the chat parser", async () => {
    const world = createWorld();
    world.createObject({
      id: "obj_chat_recycle_book",
      name: "book",
      parent: "$thing",
      owner: "$wiz",
      location: "$wiz"
    });
    world.setProp("obj_chat_recycle_book", "name", "book");
    const sessionId = await mintWizSession(world);
    await world.directCall(
      "enter-chatroom",
      "$wiz",
      "the_chatroom",
      "enter",
      []
    );
    const result = await world.command(
      "@recycle-book-chat",
      sessionId,
      "the_chatroom",
      "@recycle book"
    );
    expect(world.objects.has("obj_chat_recycle_book")).toBe(false);
    if (result.op === "result" || result.op === "applied") {
      const text = findTextObservation(result.observations, "$wiz");
      expect(text).toMatch(/book \(#obj_chat_recycle_book\) recycled\./);
    } else {
      throw new Error(`unexpected frame: ${result.op}`);
    }
  });

  it("rejects a non-builder owner via direct call (builder surface gate)", async () => {
    // The verb is direct_callable, so an owner who isn't a $builder
    // descendant could otherwise bypass the documented builder-class
    // surface (catalogs/prog/README.md). The surface gate raises E_PERM
    // before any matcher work happens.
    const world = createWorld();
    const guest = world.auth("guest:non-builder-recycle");
    expect(world.isDescendantOf(guest.actor, "$builder")).toBe(false);
    world.createObject({
      id: "obj_guest_owned",
      name: "trinket",
      parent: "$thing",
      owner: guest.actor,
      location: guest.actor
    });
    world.setProp("obj_guest_owned", "name", "trinket");
    const denied = await world.directCall(
      "recycle-deny-owner",
      guest.actor,
      "$builder",
      "recycle_command",
      ["trinket"]
    );
    expect(denied.op).toBe("error");
    if (denied.op !== "error") return;
    expect(denied.error.code).toBe("E_PERM");
    expect(denied.error.message).toMatch(/builder class surface required/);
    expect(world.objects.has("obj_guest_owned")).toBe(true);
  });

  it("the parser does not surface @recycle to a non-builder", async () => {
    // A guest who isn't a builder shouldn't reach @recycle through
    // command dispatch — the verb only lives on $builder, so a player
    // not in that parent chain gets the standard "I don't understand"
    // huh, never the verb body's surface raise.
    const world = createWorld();
    const guest = world.auth("guest:non-builder-parser");
    expect(world.isDescendantOf(guest.actor, "$builder")).toBe(false);
    world.createObject({
      id: "obj_guest_parser_owned",
      name: "trinket",
      parent: "$thing",
      owner: guest.actor,
      location: guest.actor
    });
    world.setProp("obj_guest_parser_owned", "name", "trinket");
    await world.directCall("guest-enter", guest.actor, "the_chatroom", "enter", []);
    const result = await world.command(
      "@recycle-parser-deny",
      guest.id,
      "the_chatroom",
      "@recycle trinket"
    );
    expect(world.objects.has("obj_guest_parser_owned")).toBe(true);
    // Either a planner huh or an explicit no-route — but never a successful
    // recycle observation. Assert by absence: no "recycled." text to the
    // guest, and no recycle observation in the frame.
    if (result.op === "result" || result.op === "applied") {
      const text = findTextObservation(result.observations, guest.actor) ?? "";
      expect(text).not.toMatch(/recycled\./);
    }
  });
});
