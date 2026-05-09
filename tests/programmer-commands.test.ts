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

describe("review-cycle conformance fixes", () => {
  it("@list works on verbs with only positional args (no command shape)", async () => {
    // $programmer:inspect is a typical direct-callable MCP-tool verb:
    // arg_spec.args=["id","opts?"], no arg_spec.command. Pre-fix this
    // E_KEYNF'd on info["arg_spec"]["command"]; the renderer now falls
    // back to "(arg1, arg2)" for direct-callable verbs.
    const world = createWorld();
    const result = await world.directCall(
      "list-noncmd",
      "$wiz",
      "$wiz",
      "list_command",
      ["$programmer:inspect"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const lines = findAllTextObservations(result.observations, "$wiz");
    expect(lines[0]).toMatch(/\$programmer:inspect/);
    // Header has parenthesized args list, not "this  none  this".
    expect(lines[0]).toMatch(/\(id, opts\?\)/);
  });

  it("@args display works on verbs with only positional args (no command shape)", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "args-noncmd",
      "$wiz",
      "$wiz",
      "args_command",
      ["$programmer:inspect"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/^inspect\s+\(id, opts\?\)$/);
  });

  it("@args mutation refuses non-command verbs with a clear pointer", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "args-mutate-noncmd",
      "$wiz",
      "$wiz",
      "args_command",
      ["$programmer:inspect this with any"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/direct-callable only/);
  });

  it("@verb pads partial argspecs to length 3 with `none` (LambdaCore L32)", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "padspec");
    // Single token: only dobj given; LambdaCore pads prep/iobj to "none".
    const result = await world.directCall(
      "verb-pad-1",
      "$wiz",
      "$wiz",
      "verb_command",
      [`#${id}:foo this`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const info = world.verbInfoForActor("$wiz", id, "foo") as any;
    expect(info.arg_spec.command).toEqual({ dobj: "this", prep: "none", iobj: "none" });
  });

  it("@verb pads two-token argspecs to length 3 with `none`", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "padspec2");
    // Two tokens (LambdaCore allows `<dobj> <prep>` form, padding iobj).
    const result = await world.directCall(
      "verb-pad-2",
      "$wiz",
      "$wiz",
      "verb_command",
      [`#${id}:foo this none`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const info = world.verbInfoForActor("$wiz", id, "foo") as any;
    expect(info.arg_spec.command).toEqual({ dobj: "this", prep: "none", iobj: "none" });
  });

  it("@property accepts a quoted multiword value", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "qval");
    const result = await world.directCall(
      "prop-quoted",
      "$wiz",
      "$wiz",
      "property_command",
      [`#${id}.title "hello world"`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(world.getProp(id, "title")).toBe("hello world");
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/^Property added with value /);
  });

  it("@property accepts a single-word quoted value (round-trips through $string_utils:to_value)", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "qval2");
    const result = await world.directCall(
      "prop-quoted2",
      "$wiz",
      "$wiz",
      "property_command",
      [`#${id}.tag "alpha"`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(world.getProp(id, "tag")).toBe("alpha");
  });

  it("@property rejects an unterminated quoted value", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "qval3");
    const result = await world.directCall(
      "prop-bad-quote",
      "$wiz",
      "$wiz",
      "property_command",
      [`#${id}.broken "open and never close`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/Unterminated quoted value/);
  });

  it("@rename rejects a name with whitespace", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "renameval");
    const result = await world.directCall(
      "rename-bad",
      "$wiz",
      "$wiz",
      "rename_command",
      [`#${id}`, "two words"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/cannot contain whitespace/);
    // Old name preserved.
    expect(world.getProp(id, "name")).toBe("renameval");
  });

  it("@rename rejects an over-long name", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "renamelong");
    const long = "x".repeat(65);
    const result = await world.directCall(
      "rename-long",
      "$wiz",
      "$wiz",
      "rename_command",
      [`#${id}`, long]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/Name too long/);
  });

  it("@chown rejects a non-player owner", async () => {
    const world = createWorld();
    const id = await createTestObject(world, "chowntarget");
    await world.directCall("verb-add", "$wiz", "$wiz", "verb_command", [`#${id}:foo`]);
    // Try to chown to $thing — not a player.
    const result = await world.directCall(
      "chown-nonplayer",
      "$wiz",
      "$wiz",
      "chown_command",
      [`#${id}:foo $thing`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe("Owner must be a player object.");
    // Owner unchanged.
    const info = world.verbInfoForActor("$wiz", id, "foo");
    expect(info.owner).toBe("$wiz");
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

describe("review-cycle 2 conformance fixes", () => {
  it("parse_propref returns false for an unknown $xxx corename", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "ppref-bogus",
      "$wiz",
      "$code_utils",
      "parse_propref",
      ["$bogus.foo"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe(false);
  });

  it("parse_verbref returns false for an unknown $xxx corename", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "pvref-bogus",
      "$wiz",
      "$code_utils",
      "parse_verbref",
      ["$bogus:verb"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe(false);
  });

  it("parse_propref still resolves a valid $xxx corename", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "ppref-ok",
      "$wiz",
      "$code_utils",
      "parse_propref",
      ["$thing.name"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual(["$thing", "name"]);
  });

  it("to_value rejects an empty string with [false, 'empty value']", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "tov-empty",
      "$wiz",
      "$string_utils",
      "to_value",
      [""]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual([false, "empty value"]);
  });

  it("to_value still accepts bare unquoted text as a string (Woo extension)", async () => {
    // Bare text is a documented Woo extension over LambdaCore — the
    // chat-driven authoring flow lets `@property obj.tag hello` store
    // "hello" rather than erroring. The divergence is captured in the
    // verb's source comment.
    const world = createWorld();
    const result = await world.directCall(
      "tov-bare",
      "$wiz",
      "$string_utils",
      "to_value",
      ["hello"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual([true, "hello"]);
  });

  it("toint accepts a leading + sign", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "toint-plus",
      "$wiz",
      "$code_utils",
      "toint",
      ["+5"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe(5);
  });

  it("$string_utils:names_of is no longer direct-callable", async () => {
    // Removing direct_callable narrows the surface: the verb is
    // reachable through ordinary verb dispatch (caller_perms applies
    // when reading `item.name`), but a direct MCP/REST call now fails.
    const world = createWorld();
    const result = await world.directCall(
      "names-direct",
      "$wiz",
      "$string_utils",
      "names_of",
      [["$thing"]]
    );
    expect(result.op).toBe("error");
    if (result.op !== "error") return;
    // Substrate raises E_DIRECT_DENIED when a non-direct-callable verb
    // is reached via directCall — even for wizards. The verb is still
    // reachable through verb dispatch from another verb.
    expect(result.error.code).toBe("E_DIRECT_DENIED");
  });

  it("object_match_failed says '<id> does not exist' for a #-prefixed failed match", async () => {
    // LambdaCore L4-5: a `#`-prefixed input that doesn't resolve gets
    // a more specific error than the generic "I see no … here." line.
    const world = createWorld();
    const result = await world.directCall(
      "omf-hash",
      "$wiz",
      "$command_utils",
      "object_match_failed",
      ["$failed_match", "#obj_missing"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe(true);
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe("#obj_missing does not exist.");
  });

  it("object_match_failed still uses the standard wording for a non-# failed match", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "omf-name",
      "$wiz",
      "$command_utils",
      "object_match_failed",
      ["$failed_match", "ghost"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe('I see no "ghost" here.');
  });
});

describe("P1-move review fixes (expected_version + cross-host)", () => {
  it("$builder:set_property honors opts.expected_version against the value version", async () => {
    const world = createWorld();
    const created = await world.directCall(
      "p1ev-create",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named ev_target"]
    );
    if (created.op !== "result") throw new Error("create failed");
    const id = (created.result as { id: string }).id;
    await world.directCall("p1ev-addprop", "$wiz", "$wiz", "property_command", [`#${id}.counter 0`]);
    // First write succeeds with expected_version=1 (substrate inits
    // value version to 1 on define).
    const ok = await world.directCall(
      "p1ev-set-ok",
      "$wiz",
      "$builder",
      "set_property",
      [id, "counter", 5, { expected_version: 1 }]
    );
    expect(ok.op).toBe("result");
    if (ok.op !== "result") return;
    expect(ok.result).toMatchObject({ ok: true, name: "counter" });
    // Second write expecting the now-stale version=1 must reject.
    const stale = await world.directCall(
      "p1ev-set-stale",
      "$wiz",
      "$builder",
      "set_property",
      [id, "counter", 99, { expected_version: 1 }]
    );
    expect(stale.op).toBe("error");
    if (stale.op !== "error") return;
    expect(stale.error.code).toBe("E_VERSION");
    const info = world.propertyInfo(id, "counter") as any;
    expect(info.value_version).toBeGreaterThanOrEqual(2);
    // Counter remained at 5.
    expect(world.getProp(id, "counter")).toBe(5);
  });

  it("$builder:set_property returns the value version (not the def version)", async () => {
    const world = createWorld();
    const created = await world.directCall(
      "p1vv-create",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named vv_target"]
    );
    if (created.op !== "result") throw new Error("create failed");
    const id = (created.result as { id: string }).id;
    await world.directCall("p1vv-addprop", "$wiz", "$wiz", "property_command", [`#${id}.counter 0`]);
    const r = await world.directCall(
      "p1vv-set",
      "$wiz",
      "$builder",
      "set_property",
      [id, "counter", 7, {}]
    );
    expect(r.op).toBe("result");
    if (r.op !== "result") return;
    const result = r.result as any;
    // After one write: value version is 2 (init=1, bump on SET_PROP).
    // Def version stays at 1 — the catalog returns the value version
    // because that's the key callers use for optimistic concurrency.
    expect(result.version).toBe(2);
    expect(result.info.value_version).toBe(2);
    expect(result.info.version).toBe(1);
  });

  it("property_info returns value_version alongside the def version", async () => {
    const world = createWorld();
    const created = await world.directCall(
      "p1pi-create",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named pi_target"]
    );
    if (created.op !== "result") throw new Error("create failed");
    const id = (created.result as { id: string }).id;
    await world.directCall("p1pi-addprop", "$wiz", "$wiz", "property_command", [`#${id}.counter 0`]);
    const info = world.propertyInfo(id, "counter") as any;
    expect(info.version).toBe(1);
    expect(info.value_version).toBe(1);
  });
});

describe("review-cycle 3 conformance fixes", () => {
  it("to_value rejects an unterminated quoted string", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "tov-unterm",
      "$wiz",
      "$string_utils",
      "to_value",
      ['"open and never close']
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual([false, "unterminated string literal"]);
  });

  it("to_value rejects a list-literal start", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "tov-list",
      "$wiz",
      "$string_utils",
      "to_value",
      ["{1, 2"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual([false, "list literals not yet supported in to_value"]);
  });

  it("to_value rejects a map-literal start", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "tov-map",
      "$wiz",
      "$string_utils",
      "to_value",
      ["[a: 1"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect((result.result as [boolean, string])[0]).toBe(false);
  });

  it("to_value rejects a malformed objref literal (`#` alone)", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "tov-bad-hash",
      "$wiz",
      "$string_utils",
      "to_value",
      ["#"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect((result.result as [boolean, string])[0]).toBe(false);
  });

  it("to_value rejects a malformed corename literal (embedded space)", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "tov-bad-corename",
      "$wiz",
      "$string_utils",
      "to_value",
      ["$wiz oops"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect((result.result as [boolean, string])[0]).toBe(false);
  });

  it("toint accepts leading-zero forms LambdaCore accepts (01, 000)", async () => {
    const world = createWorld();
    for (const [input, want] of [["01", 1], ["000", 0], ["007", 7]] as const) {
      const result = await world.directCall(
        `toint-zero-${input}`,
        "$wiz",
        "$code_utils",
        "toint",
        [input]
      );
      expect(result.op).toBe("result");
      if (result.op !== "result") return;
      expect(result.result).toBe(want);
    }
  });

  it("toint accepts -0 (LambdaCore parses it as 0)", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "toint-neg-zero",
      "$wiz",
      "$code_utils",
      "toint",
      ["-0"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe(0);
  });

  it("toint still rejects non-integer text", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "toint-bad",
      "$wiz",
      "$code_utils",
      "toint",
      ["12abc"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe(false);
  });

  it("parse_argspec returns a partial 1-element spec when only the dobj is given", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "pa-partial-1",
      "$wiz",
      "$code_utils",
      "parse_argspec",
      [["this"]]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual([["this"], []]);
  });

  it("parse_argspec returns a partial 2-element spec when only dobj+prep are given", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "pa-partial-2",
      "$wiz",
      "$code_utils",
      "parse_argspec",
      [["this", "with"]]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual([["this", "with"], []]);
  });

  it("object_match_failed prints `<id> does not exist` for an invalid # objref (not just $failed_match)", async () => {
    // The !valid(match_result) branch — direct utility callers can
    // pass a tombstoned/non-existent ObjRef along with the original
    // #-prefixed string. Pre-fix, the wording dropped the # because
    // to_string(ObjRef) returns the bare id; now the input string is
    // consulted first.
    const world = createWorld();
    const result = await world.directCall(
      "omf-invalid-hash",
      "$wiz",
      "$command_utils",
      "object_match_failed",
      ["obj_doesnt_exist", "#obj_doesnt_exist"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toBe(true);
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe("#obj_doesnt_exist does not exist.");
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
