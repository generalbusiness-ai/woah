import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";

// Tier-3 LambdaCore-faithful programmer commands:
//   $programmer:@verb / @args / @rmverb / @rename / @list / @chmod / @chown
// Each is a near line-for-line port of LambdaCore #217 (or #6 for @rename,
// #218 for @chown) with surface gates routing through the standard
// $programmer membership check (or wizard for @chown). Where a branch
// of the LambdaCore verb is genuinely deferred (e.g. property rename,
// object @chmod, object @chown), the woo verb returns a clear pointer
// rather than half-implementing.

function findTextObservation(observations: any[], target: string): string | undefined {
  for (const obs of observations) {
    if (obs?.type !== "text") continue;
    if (obs?.target !== target) continue;
    if (typeof obs?.text === "string") return obs.text;
  }
  return undefined;
}

function findAllTextObservations(observations: any[], target: string): string[] {
  return observations
    .filter((o) => o?.type === "text" && o?.target === target && typeof o?.text === "string")
    .map((o) => o.text);
}

async function createTestObject(world: ReturnType<typeof createWorld>, name: string): Promise<string> {
  const created = await world.directCall(
    `create-${name}`,
    "$wiz",
    "$wiz",
    "create_command",
    [`$thing named ${name}`]
  );
  if (created.op !== "result") throw new Error("create failed");
  return (created.result as { id: string }).id;
}

describe("$programmer:@verb (LambdaCore #217 port)", () => {
  it("creates a verb with default args fallback", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "v1");
    const result = await world.directCall(
      "verb-add",
      "$wiz",
      "$wiz",
      "verb_command",
      [`#${id}:greet`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/^Verb added \(slot \d+\)\.$/);
    // Verb appears on the object.
    const verbs = world.ownVerbNames(id);
    expect(verbs).toContain("greet");
  });

  it("captures aliases from a comma-separated name list", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "v2");
    const result = await world.directCall(
      "verb-aliases",
      "$wiz",
      "$wiz",
      "verb_command",
      [`#${id}:greet,salute,wave`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const info = world.verbInfoForActor("$wiz", id, "greet");
    expect(info.aliases).toEqual(["salute", "wave"]);
  });

  it("uses rxd perms for {this,none,this} (LambdaCore L34-38)", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "v3");
    await world.directCall(
      "verb-tnt",
      "$wiz",
      "$wiz",
      "verb_command",
      [`#${id}:doit this none this`]
    );
    // woo's normalizeVerbPerms strips `d` into the direct_callable flag,
    // so the stored perms string is "rx" with direct_callable=true.
    // LambdaCore would show "rxd"; the divergence is substrate-level.
    const info = world.verbInfoForActor("$wiz", id, "doit");
    expect(info.perms).toBe("rx");
    expect(info.direct_callable).toBe(true);
  });

  it("uses rd perms for non-{this,none,this} argspecs", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "v4");
    await world.directCall(
      "verb-rd",
      "$wiz",
      "$wiz",
      "verb_command",
      [`#${id}:burn any with any`]
    );
    const info = world.verbInfoForActor("$wiz", id, "burn");
    expect(info.perms).toBe("r");
    expect(info.direct_callable).toBe(true);
  });

  it("rejects a non-programmer guest (surface gate)", async () => {
    const world = createWorld();
    const guest = world.auth("guest:verb-deny");
    const denied = await world.directCall(
      "verb-deny",
      guest.actor,
      "$programmer",
      "verb_command",
      ["$thing:foo"]
    );
    expect(denied.op).toBe("error");
    if (denied.op !== "error") return;
    expect(denied.error.code).toBe("E_PERM");
  });

  it("rejects an unknown preposition with the parse_argspec wording", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "v5");
    const result = await world.directCall(
      "verb-bad-prep",
      "$wiz",
      "$wiz",
      "verb_command",
      [`#${id}:foo this notaprep this`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/"notaprep" is not a valid preposition/);
  });
});

describe("$programmer:@args (LambdaCore #217 port)", () => {
  it("changes the command argspec on an existing verb", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "av1");
    await world.directCall("verb-add", "$wiz", "$wiz", "verb_command", [`#${id}:greet`]);
    const result = await world.directCall(
      "args-change",
      "$wiz",
      "$wiz",
      "args_command",
      [`#${id}:greet this with any`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe("Verb arguments changed.");
    const info = world.verbInfoForActor("$wiz", id, "greet") as any;
    expect(info.arg_spec.command).toEqual({ dobj: "this", prep: "with", iobj: "any" });
  });

  it("displays the current argspec when no spec is given", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "av2");
    await world.directCall("verb-add", "$wiz", "$wiz", "verb_command", [`#${id}:show this with any`]);
    const result = await world.directCall(
      "args-show",
      "$wiz",
      "$wiz",
      "args_command",
      [`#${id}:show`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/^show\s+this\s+with\s+any$/);
  });

  it("notifies E_VERBNF on a verb that doesn't exist", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "av3");
    const result = await world.directCall(
      "args-no-verb",
      "$wiz",
      "$wiz",
      "args_command",
      [`#${id}:nope this none this`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/does not have a verb with that name/);
  });
});

describe("$programmer:@rmverb (LambdaCore #217 port)", () => {
  it("removes a verb defined on the object", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "rm1");
    await world.directCall("verb-add", "$wiz", "$wiz", "verb_command", [`#${id}:gone`]);
    expect(world.ownVerbNames(id)).toContain("gone");
    const result = await world.directCall(
      "rmverb-call",
      "$wiz",
      "$wiz",
      "rmverb_command",
      [`#${id}:gone`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(world.ownVerbNames(id)).not.toContain("gone");
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/:gone removed\.$/);
  });

  it("returns a clear message when the verb does not exist", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "rm2");
    const result = await world.directCall(
      "rmverb-missing",
      "$wiz",
      "$wiz",
      "rmverb_command",
      [`#${id}:nope`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe("That object does not define that verb.");
  });
});

describe("$programmer:@rename (LambdaCore $root #6 port)", () => {
  it("renames a verb in place", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "rn1");
    await world.directCall("verb-add", "$wiz", "$wiz", "verb_command", [`#${id}:old`]);
    const result = await world.directCall(
      "rename-verb",
      "$wiz",
      "$wiz",
      "rename_command",
      [`#${id}:old`, "new"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(world.ownVerbNames(id)).toContain("new");
    expect(world.ownVerbNames(id)).not.toContain("old");
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe("Verb name changed.");
  });

  it("renames an object via set_object_name (keeps property and attribute in sync)", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "rn2");
    const result = await world.directCall(
      "rename-obj",
      "$wiz",
      "$wiz",
      "rename_command",
      [`#${id}`, "renamed_thing"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(world.getProp(id, "name")).toBe("renamed_thing");
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/Name of #/);
    expect(text).toMatch(/changed to "renamed_thing"/);
  });

  it("emits a clear pointer for the property branch (deferred)", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "rn3");
    await world.directCall(
      "addprop",
      "$wiz",
      "$wiz",
      "property_command",
      [`#${id}.flag 0`]
    );
    const result = await world.directCall(
      "rename-prop",
      "$wiz",
      "$wiz",
      "rename_command",
      [`#${id}.flag`, "newflag"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/property rename isn't ported yet/);
  });
});

describe("$programmer:@list stub (LambdaCore #217)", () => {
  it("prints a header line and numbered source lines", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "lst1");
    await world.directCall("verb-add", "$wiz", "$wiz", "verb_command", [`#${id}:greet`]);
    const result = await world.directCall(
      "list-verb",
      "$wiz",
      "$wiz",
      "list_command",
      [`#${id}:greet`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const lines = findAllTextObservations(result.observations, "$wiz");
    // First line is the header, subsequent lines are numbered source.
    expect(lines[0]).toMatch(/^#.*:greet/);
    // The stub source from add_verb is `verb :greet() rd { return null; }`
    // (no \n), so we get exactly one numbered line.
    expect(lines[1]).toMatch(/^ 1:  verb :greet/);
  });

  it("notifies on a verb that doesn't exist", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "lst2");
    const result = await world.directCall(
      "list-missing",
      "$wiz",
      "$wiz",
      "list_command",
      [`#${id}:nope`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe("That object does not define that verb.");
  });
});

describe("$programmer:@chmod (LambdaCore #217 port)", () => {
  it("changes verb perms with an absolute string", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "cm1");
    await world.directCall("verb-add", "$wiz", "$wiz", "verb_command", [`#${id}:foo`]);
    const result = await world.directCall(
      "chmod-abs",
      "$wiz",
      "$wiz",
      "chmod_command",
      [`#${id}:foo rxd`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    // Stored: substrate strips `d` → perms="rx" + direct_callable=true.
    const info = world.verbInfoForActor("$wiz", id, "foo");
    expect(info.perms).toBe("rx");
    expect(info.direct_callable).toBe(true);
    // The echoed message reflects the user-typed string verbatim
    // (LambdaCore behavior; the woo divergence on `d`-as-flag is
    // substrate-level, not surfaced by @chmod's wording).
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe('Verb permissions set to "rxd".');
  });

  it("changes verb perms with a relative +/- string (uses $perm:apply)", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "cm2");
    // Create with default perms for `any with any` (non-tnt) → "rd"
    // before normalization; stored as "r" + direct_callable=true.
    await world.directCall("verb-add", "$wiz", "$wiz", "verb_command", [`#${id}:foo any with any`]);
    expect(world.verbInfoForActor("$wiz", id, "foo").perms).toBe("r");
    const result = await world.directCall(
      "chmod-rel",
      "$wiz",
      "$wiz",
      "chmod_command",
      [`#${id}:foo +x`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    // apply("r", "+x") → "rx"; stored as "rx".
    const info = world.verbInfoForActor("$wiz", id, "foo");
    expect(info.perms).toBe("rx");
  });

  it("changes property perms", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "cm3");
    await world.directCall(
      "addprop",
      "$wiz",
      "$wiz",
      "property_command",
      [`#${id}.flag 0`]
    );
    const result = await world.directCall(
      "chmod-prop",
      "$wiz",
      "$wiz",
      "chmod_command",
      [`#${id}.flag r`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe('Property permissions set to "r".');
    const info = world.propertyInfo(id, "flag") as any;
    expect(info.perms).toBe("r");
  });

  it("emits a clear pointer for the object branch (deferred)", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "cm4");
    const result = await world.directCall(
      "chmod-obj",
      "$wiz",
      "$wiz",
      "chmod_command",
      [`#${id} rwf`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/object-level @chmod/);
  });
});

describe("$programmer:@chown (LambdaCore $wiz #218 port)", () => {
  it("rejects a non-wizard via direct call", async () => {
    const world = createWorld();
    const guest = world.auth("guest:chown-deny");
    const denied = await world.directCall(
      "chown-deny",
      guest.actor,
      "$programmer",
      "chown_command",
      ["$thing:foo $wiz"]
    );
    expect(denied.op).toBe("error");
    if (denied.op !== "error") return;
    expect(denied.error.code).toBe("E_PERM");
  });

  it("changes verb owner when called by a wizard", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "co1");
    await world.directCall("verb-add", "$wiz", "$wiz", "verb_command", [`#${id}:foo`]);
    // Create another player to own the verb.
    const otherPlayer = await world.directCall(
      "create-other",
      "$wiz",
      "$wiz",
      "create_command",
      ["$player named alice"]
    );
    if (otherPlayer.op !== "result") throw new Error("create-other failed");
    const aliceId = (otherPlayer.result as { id: string }).id;
    const result = await world.directCall(
      "chown-verb",
      "$wiz",
      "$wiz",
      "chown_command",
      [`#${id}:foo #${aliceId}`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const info = world.verbInfoForActor("$wiz", id, "foo");
    expect(info.owner).toBe(aliceId);
  });

  it("emits a clear pointer for the object branch (deferred)", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "co2");
    const result = await world.directCall(
      "chown-obj",
      "$wiz",
      "$wiz",
      "chown_command",
      [`#${id} $wiz`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/object @chown.*isn't ported/);
  });
});

describe("$perm_utils:apply (LambdaCore #42 port)", () => {
  it("returns the absolute mods string verbatim when not prefixed with +/-/!", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "apply-abs",
      "$wiz",
      "the_perm",
      "apply",
      ["rxd", "rw"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe("rw");
  });

  it("adds letters with +", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "apply-add",
      "$wiz",
      "the_perm",
      "apply",
      ["r", "+wx"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe("rwx");
  });

  it("removes letters with - and !", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "apply-remove",
      "$wiz",
      "the_perm",
      "apply",
      ["rxd", "-x!d"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe("r");
  });

  it("composes +/- segments left-to-right", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "apply-compose",
      "$wiz",
      "the_perm",
      "apply",
      ["rxd", "+w-x"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe("rdw");
  });
});

describe("$code_utils helpers (LambdaCore #153)", () => {
  it("parse_verbref splits obj:verb correctly", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "pv1",
      "$wiz",
      "$code_utils",
      "parse_verbref",
      ["$thing:examine"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual(["$thing", "examine"]);
  });

  it("parse_verbref returns false on a colonless string", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "pv2",
      "$wiz",
      "$code_utils",
      "parse_verbref",
      ["$thing"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe(false);
  });

  it("toint round-trips an integer string and returns false for non-integers", async () => {
    const world = createWorld();
    const ok = await world.directCall("ti1", "$wiz", "$code_utils", "toint", ["42"]);
    expect(ok.op).toBe("result");
    if (ok.op !== "result") return;
    expect(ok.result).toBe(42);
    const fail = await world.directCall("ti2", "$wiz", "$code_utils", "toint", ["forty-two"]);
    expect(fail.op).toBe("result");
    if (fail.op !== "result") return;
    expect(fail.result).toBe(false);
  });

  it("nth_verb_name returns the Nth own verb name (1-indexed) or false out of range", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "nv1",
      "$wiz",
      "$code_utils",
      "nth_verb_name",
      ["$thing", 1]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(typeof result.result).toBe("string");
    const oor = await world.directCall(
      "nv2",
      "$wiz",
      "$code_utils",
      "nth_verb_name",
      ["$thing", 9999]
    );
    expect(oor.op).toBe("result");
    if (oor.op !== "result") return;
    expect(oor.result).toBe(false);
  });

  it("parse_argspec accepts a tnt shortcut", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "pa1",
      "$wiz",
      "$code_utils",
      "parse_argspec",
      [["tnt"]]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual([["this", "none", "this"], []]);
  });

  it("parse_argspec returns an error message for a bad direct-object specifier", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "pa2",
      "$wiz",
      "$code_utils",
      "parse_argspec",
      [["banana"]]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(typeof result.result).toBe("string");
    expect(result.result).toMatch(/"banana" is not a valid direct object specifier/);
  });
});
