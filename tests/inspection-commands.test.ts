import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";

// Tier-1 chat-shaped inspection verbs: @contents / @parents / @kids on
// $builder, @verbs / @properties on $programmer. Each is a near-line-for-
// line port of its LambdaCore counterpart with documented divergences;
// these tests pin the user-visible output shape.

function findTextObservation(observations: any[], target: string): string | undefined {
  for (const obs of observations) {
    if (obs?.type !== "text") continue;
    if (obs?.target !== target) continue;
    if (typeof obs?.text === "string") return obs.text;
  }
  return undefined;
}

function findAllTextObservations(observations: any[], target: string): string[] {
  const out: string[] = [];
  for (const obs of observations) {
    if (obs?.type !== "text") continue;
    if (obs?.target !== target) continue;
    if (typeof obs?.text === "string") out.push(obs.text);
  }
  return out;
}

describe("$builder:@contents (LambdaCore #630 port)", () => {
  it("lists contents with paste-able ids", async () => {
    const world = createWorld();
    world.createObject({ id: "obj_box", name: "box", parent: "$thing", owner: "$wiz", location: "$wiz" });
    world.setProp("obj_box", "name", "box");
    world.createObject({ id: "obj_rock", name: "rock", parent: "$thing", owner: "$wiz", location: "obj_box" });
    world.setProp("obj_rock", "name", "rock");
    world.createObject({ id: "obj_pebble", name: "pebble", parent: "$thing", owner: "$wiz", location: "obj_box" });
    world.setProp("obj_pebble", "name", "pebble");

    const result = await world.directCall(
      "contents-box",
      "$wiz",
      "$wiz",
      "contents_command",
      ["box"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const lines = findAllTextObservations(result.observations, "$wiz");
    expect(lines[0]).toBe("box(#obj_box) contains:");
    expect(lines[1]).toMatch(/rock\(#obj_rock\)/);
    expect(lines[1]).toMatch(/pebble\(#obj_pebble\)/);
  });

  it("reports an empty container with the no-contents wording", async () => {
    const world = createWorld();
    world.createObject({ id: "obj_empty", name: "empty box", parent: "$thing", owner: "$wiz", location: "$wiz" });
    world.setProp("obj_empty", "name", "empty box");
    const result = await world.directCall(
      "contents-empty",
      "$wiz",
      "$wiz",
      "contents_command",
      ["empty box"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe("empty box(#obj_empty) contains nothing.");
  });

  it("denies a non-builder via direct call (surface gate)", async () => {
    const world = createWorld();
    const guest = world.auth("guest:contents-deny");
    expect(world.isDescendantOf(guest.actor, "$builder")).toBe(false);
    const denied = await world.directCall(
      "contents-deny",
      guest.actor,
      "$builder",
      "contents_command",
      ["here"]
    );
    expect(denied.op).toBe("error");
    if (denied.op !== "error") return;
    expect(denied.error.code).toBe("E_PERM");
    expect(denied.error.message).toMatch(/builder class surface required/);
  });
});

describe("$builder:@parents (LambdaCore #630 port)", () => {
  it("walks the ancestor chain, with the object first", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "parents-thing",
      "$wiz",
      "$wiz",
      "parents_command",
      ["$thing"]
    );
    if (result.op === "error") {
      throw new Error(`parents_command errored: ${result.error.code} ${result.error.message}`);
    }
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    // $thing is rooted at $thing → $root → $system in the bootstrap chain.
    expect(text).toMatch(/\$thing\(\$thing\)/);
    expect(text).toMatch(/\$root\(\$root\)/);
    expect(text).toMatch(/\$system\(\$system\)/);
  });

  it("prints a usage line when no object is named", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "parents-usage",
      "$wiz",
      "$wiz",
      "parents_command",
      [""]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(findTextObservation(result.observations, "$wiz")).toMatch(/Usage: @parents <object>/);
  });
});

describe("$builder:@kids (LambdaCore #630 port)", () => {
  it("lists direct children with the count line", async () => {
    const world = createWorld();
    world.createObject({ id: "obj_parent_class", name: "container", parent: "$thing", owner: "$wiz" });
    world.setProp("obj_parent_class", "name", "container");
    world.createObject({ id: "obj_kid_a", name: "kid a", parent: "obj_parent_class", owner: "$wiz" });
    world.setProp("obj_kid_a", "name", "kid a");
    world.createObject({ id: "obj_kid_b", name: "kid b", parent: "obj_parent_class", owner: "$wiz" });
    world.setProp("obj_kid_b", "name", "kid b");

    const result = await world.directCall(
      "kids-container",
      "$wiz",
      "$wiz",
      "kids_command",
      ["#obj_parent_class"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const lines = findAllTextObservations(result.observations, "$wiz");
    expect(lines[0]).toBe("container(#obj_parent_class) has 2 kids.");
    expect(lines[1]).toMatch(/kid a\(#obj_kid_a\)/);
    expect(lines[1]).toMatch(/kid b\(#obj_kid_b\)/);
  });

  it("uses the singular form for one kid", async () => {
    const world = createWorld();
    world.createObject({ id: "obj_solo_class", name: "solo", parent: "$thing", owner: "$wiz" });
    world.setProp("obj_solo_class", "name", "solo");
    world.createObject({ id: "obj_solo_kid", name: "lonely", parent: "obj_solo_class", owner: "$wiz" });
    world.setProp("obj_solo_kid", "name", "lonely");
    const result = await world.directCall(
      "kids-solo",
      "$wiz",
      "$wiz",
      "kids_command",
      ["#obj_solo_class"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const lines = findAllTextObservations(result.observations, "$wiz");
    expect(lines[0]).toBe("solo(#obj_solo_class) has 1 kid.");
  });

  it("reports a kidless object with the no-kids wording", async () => {
    const world = createWorld();
    world.createObject({ id: "obj_barren", name: "barren", parent: "$thing", owner: "$wiz" });
    world.setProp("obj_barren", "name", "barren");
    const result = await world.directCall(
      "kids-barren",
      "$wiz",
      "$wiz",
      "kids_command",
      ["#obj_barren"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe("barren(#obj_barren) has no kids.");
  });
});

describe("$programmer:@verbs (LambdaCore #217 port)", () => {
  it("emits the eval-shaped paste-back line", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "verbs-thing",
      "$wiz",
      "$wiz",
      "verbs_command",
      ["$thing"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/^;verbs\(\$thing\) => /);
  });

  it("denies a non-programmer guest", async () => {
    const world = createWorld();
    const guest = world.auth("guest:verbs-deny");
    const denied = await world.directCall(
      "verbs-deny",
      guest.actor,
      "$programmer",
      "verbs_command",
      ["$thing"]
    );
    expect(denied.op).toBe("error");
    if (denied.op !== "error") return;
    expect(denied.error.code).toBe("E_PERM");
  });
});

describe("$programmer:@properties (LambdaCore #217 port)", () => {
  it("emits the eval-shaped paste-back line", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "properties-root",
      "$wiz",
      "$wiz",
      "properties_command",
      ["$root"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/^;properties\(\$root\) => /);
    // $root carries name/description/aliases/host_placement at minimum.
    expect(text).toMatch(/name/);
  });
});

describe("$string_utils:names_of", () => {
  it("renders objects as 'name(#id)' triple-spaced", async () => {
    const world = createWorld();
    world.createObject({ id: "obj_alpha", name: "alpha", parent: "$thing", owner: "$wiz" });
    world.setProp("obj_alpha", "name", "alpha");
    world.createObject({ id: "obj_beta", name: "beta", parent: "$thing", owner: "$wiz" });
    world.setProp("obj_beta", "name", "beta");
    const result = await world.directCall(
      "names-of",
      "$wiz",
      "$string_utils",
      "names_of",
      [["obj_alpha", "obj_beta"]]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe("alpha(#obj_alpha)   beta(#obj_beta)");
  });

  it("skips invalid ids and bare strings", async () => {
    const world = createWorld();
    world.createObject({ id: "obj_alpha2", name: "alpha", parent: "$thing", owner: "$wiz" });
    world.setProp("obj_alpha2", "name", "alpha");
    const result = await world.directCall(
      "names-of-invalid",
      "$wiz",
      "$string_utils",
      "names_of",
      [["obj_alpha2", "not_a_real_obj", "$wiz"]]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe("alpha(#obj_alpha2)   $wiz($wiz)");
  });
});
