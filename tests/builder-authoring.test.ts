import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";

// Tier-2 LambdaCore-faithful builder/programmer authoring commands:
//   $builder:@create / @set
//   $programmer:@property (alias @prop) / @rmproperty (alias @rmprop)
// Each is a near line-for-line port of LambdaCore #630/#217 with surface
// gates and routing through $command_utils:object_match_failed and
// $code_utils:parse_propref.

function findTextObservation(observations: any[], target: string): string | undefined {
  for (const obs of observations) {
    if (obs?.type !== "text") continue;
    if (obs?.target !== target) continue;
    if (typeof obs?.text === "string") return obs.text;
  }
  return undefined;
}

describe("$builder:@create (LambdaCore #630 port)", () => {
  it("creates a child of $thing with a single name", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "create-book",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named book"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const map = result.result as { ok: boolean; id: string; parent: string };
    expect(map.ok).toBe(true);
    expect(map.parent).toBe("$thing");
    expect(world.getProp(map.id, "name")).toBe("book");
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/You now have book with object number /);
    expect(text).toMatch(/parent \$thing \(\$thing\)\.$/);
  });

  it("treats `called` as a synonym for `named`", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "create-called",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing called widget"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const map = result.result as { id: string };
    expect(world.getProp(map.id, "name")).toBe("widget");
  });

  it("captures aliases from the comma-separated name list", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "create-with-aliases",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named map,chart,plan"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const map = result.result as { id: string };
    expect(world.getProp(map.id, "name")).toBe("map");
    expect(world.getProp(map.id, "aliases")).toEqual(["chart", "plan"]);
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/\(aka chart, plan\)/);
  });

  it("prints usage when the `named` keyword is missing", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "create-usage",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/Usage: @create <parent-class> named <name>/);
  });

  it("rejects a non-builder via direct call (surface gate)", async () => {
    const world = createWorld();
    const guest = world.auth("guest:create-deny");
    const denied = await world.directCall(
      "create-deny",
      guest.actor,
      "$builder",
      "create_command",
      ["$thing named whatever"]
    );
    expect(denied.op).toBe("error");
    if (denied.op !== "error") return;
    expect(denied.error.code).toBe("E_PERM");
  });
});

describe("$builder:@set (LambdaCore #630 port)", () => {
  it("sets a string property to the trimmed bare value", async () => {
    const world = createWorld();
    const created = await world.directCall(
      "create-thing-for-set",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named widget"]
    );
    if (created.op !== "result") throw new Error("create failed");
    const id = (created.result as { id: string }).id;
    // Pre-create the property; @set updates an existing prop.
    await world.directCall(
      "preprop",
      "$wiz",
      "$wiz",
      "property_command",
      [`#${id}.color blue`]
    );
    const result = await world.directCall(
      "set-color",
      "$wiz",
      "$wiz",
      "set_command",
      [`#${id}.color`, "red"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(world.getProp(id, "color")).toBe("red");
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/Property #obj_.* set to red\./);
  });

  it("strips matching double quotes from quoted string values", async () => {
    const world = createWorld();
    const created = await world.directCall(
      "create-quoted",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named slot"]
    );
    if (created.op !== "result") throw new Error("create failed");
    const id = (created.result as { id: string }).id;
    await world.directCall(
      "preprop2",
      "$wiz",
      "$wiz",
      "property_command",
      [`#${id}.label x`]
    );
    const result = await world.directCall(
      "set-label",
      "$wiz",
      "$wiz",
      "set_command",
      [`#${id}.label`, '"Crazy Caboola"']
    );
    expect(result.op).toBe("result");
    expect(world.getProp(id, "label")).toBe("Crazy Caboola");
  });

  it("parses an integer-shaped value as a number", async () => {
    const world = createWorld();
    const created = await world.directCall(
      "create-int",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named counter"]
    );
    if (created.op !== "result") throw new Error("create failed");
    const id = (created.result as { id: string }).id;
    await world.directCall(
      "preprop3",
      "$wiz",
      "$wiz",
      "property_command",
      [`#${id}.score 0`]
    );
    const result = await world.directCall(
      "set-score",
      "$wiz",
      "$wiz",
      "set_command",
      [`#${id}.score`, "42"]
    );
    expect(result.op).toBe("result");
    expect(world.getProp(id, "score")).toBe(42);
  });

  it("returns a parse-failure message on a malformed propref", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "set-malformed",
      "$wiz",
      "$wiz",
      "set_command",
      ["nodot", "x"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/Property nodot not found/);
  });
});

describe("$programmer:@property (LambdaCore #217 port)", () => {
  it("adds a property with a parsed initial value", async () => {
    const world = createWorld();
    const created = await world.directCall(
      "create-for-prop",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named gizmo"]
    );
    if (created.op !== "result") throw new Error("create failed");
    const id = (created.result as { id: string }).id;
    const result = await world.directCall(
      "addprop",
      "$wiz",
      "$wiz",
      "property_command",
      [`#${id}.flowers iris`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(world.getProp(id, "flowers")).toBe("iris");
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/Property added with value /);
  });

  it("defaults an absent value to 0 (LambdaCore L21-22)", async () => {
    const world = createWorld();
    const created = await world.directCall(
      "create-default",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named blanky"]
    );
    if (created.op !== "result") throw new Error("create failed");
    const id = (created.result as { id: string }).id;
    const result = await world.directCall(
      "addprop-default",
      "$wiz",
      "$wiz",
      "property_command",
      [`#${id}.uninitialized`]
    );
    expect(result.op).toBe("result");
    expect(world.getProp(id, "uninitialized")).toBe(0);
  });

  it("rejects re-defining an existing property", async () => {
    const world = createWorld();
    const created = await world.directCall(
      "create-twice",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named twice"]
    );
    if (created.op !== "result") throw new Error("create failed");
    const id = (created.result as { id: string }).id;
    await world.directCall("addprop-once", "$wiz", "$wiz", "property_command", [`#${id}.tag a`]);
    const second = await world.directCall(
      "addprop-twice",
      "$wiz",
      "$wiz",
      "property_command",
      [`#${id}.tag b`]
    );
    expect(second.op).toBe("result");
    if (second.op !== "result") return;
    const text = findTextObservation(second.observations, "$wiz");
    expect(text).toMatch(/already exists/);
    // Original value preserved.
    expect(world.getProp(id, "tag")).toBe("a");
  });

  it("rejects a non-programmer guest", async () => {
    const world = createWorld();
    const guest = world.auth("guest:property-deny");
    const denied = await world.directCall(
      "property-deny",
      guest.actor,
      "$programmer",
      "property_command",
      ["$thing.whatever"]
    );
    expect(denied.op).toBe("error");
    if (denied.op !== "error") return;
    expect(denied.error.code).toBe("E_PERM");
  });
});

describe("$programmer:@rmproperty (LambdaCore #217 port)", () => {
  it("removes an existing property", async () => {
    const world = createWorld();
    const created = await world.directCall(
      "create-for-rm",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named removable"]
    );
    if (created.op !== "result") throw new Error("create failed");
    const id = (created.result as { id: string }).id;
    await world.directCall("rm-add", "$wiz", "$wiz", "property_command", [`#${id}.disposable 1`]);
    expect(world.getProp(id, "disposable")).toBe(1);

    const result = await world.directCall(
      "rm-do",
      "$wiz",
      "$wiz",
      "rmproperty_command",
      [`#${id}.disposable`]
    );
    expect(result.op).toBe("result");
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/Property removed/);
    // Reading the property after removal raises E_PROPNF (no def, no
    // property-attribute fallback for arbitrary names).
    expect(() => world.getProp(id, "disposable")).toThrow();
  });

  it("notifies on a property that doesn't exist", async () => {
    const world = createWorld();
    const created = await world.directCall(
      "create-for-noprop",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named empty"]
    );
    if (created.op !== "result") throw new Error("create failed");
    const id = (created.result as { id: string }).id;
    const result = await world.directCall(
      "rm-noprop",
      "$wiz",
      "$wiz",
      "rmproperty_command",
      [`#${id}.never_existed`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/does not define that property/);
  });
});

describe("$code_utils:parse_propref", () => {
  it("splits obj.prop into [obj, prop]", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "parse-propref",
      "$wiz",
      "$code_utils",
      "parse_propref",
      ["#obj_xxx.color"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual(["#obj_xxx", "color"]);
  });

  it("treats bare $foo as $system.foo", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "parse-bare-corename",
      "$wiz",
      "$code_utils",
      "parse_propref",
      ["$foo"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual(["$system", "foo"]);
  });

  it("returns false on a parse failure", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "parse-fail",
      "$wiz",
      "$code_utils",
      "parse_propref",
      ["just_a_word"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe(false);
  });
});

describe("$string_utils:to_value", () => {
  it("strips matching double quotes for a quoted string", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "tov-quoted",
      "$wiz",
      "$string_utils",
      "to_value",
      ['"hello"']
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual([true, "hello"]);
  });

  it("parses an integer-shaped string as a number", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "tov-int",
      "$wiz",
      "$string_utils",
      "to_value",
      ["42"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual([true, 42]);
  });

  it("falls back to bare string for unparseable input", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "tov-bare",
      "$wiz",
      "$string_utils",
      "to_value",
      ["hello world"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual([true, "hello world"]);
  });
});
