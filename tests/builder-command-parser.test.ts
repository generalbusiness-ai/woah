import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";

// Parser-path coverage for the LambdaCore-shaped chat verbs added in
// the recycle-command-verb branch. The unit tests in
// recycle-command.test.ts / inspection-commands.test.ts /
// builder-authoring.test.ts exercise verb bodies via directCall; these
// tests run the real command planner end-to-end (literal `@create …`,
// `@set …`, etc.) so the alias grammar (`@par*ents`, `@set*prop`, …)
// and command-pattern arg shapes are pinned too.

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

async function runCommand(
  world: ReturnType<typeof createWorld>,
  sessionId: string,
  command: string,
  requestId: string
) {
  return world.command(requestId, sessionId, "the_chatroom", command);
}

describe("Tier-1/2 chat-parser dispatch (end-to-end)", () => {
  it("dispatches `@contents` with a target argument", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    const result = await runCommand(world, sessionId, "@contents $thing", "cmd-contents-thing");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const lines = (result.observations as any[])
      .filter((o) => o.type === "text" && o.target === "$wiz")
      .map((o) => o.text);
    expect(lines[0]).toMatch(/^\$thing\(\$thing\) contains/);
  });

  it("dispatches `@par` (alias-grammar prefix) to @parents", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    const result = await runCommand(world, sessionId, "@par $thing", "cmd-par");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/\$thing\(\$thing\)/);
    expect(text).toMatch(/\$root\(\$root\)/);
  });

  it("dispatches `@kids` to the kids verb", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    const result = await runCommand(world, sessionId, "@kids $thing", "cmd-kids");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const lines = (result.observations as any[])
      .filter((o) => o.type === "text" && o.target === "$wiz")
      .map((o) => o.text);
    // $thing has many seed children — first line is the count.
    expect(lines[0]).toMatch(/\$thing\(\$thing\) has \d+ kid/);
  });

  it("dispatches `@verbs` to the programmer verbs verb", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    const result = await runCommand(world, sessionId, "@verbs $thing", "cmd-verbs");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/^;verbs\(\$thing\) => /);
  });

  it("dispatches `@props` (the @prop*erties alias) to the properties verb", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    const result = await runCommand(world, sessionId, "@props $root", "cmd-props");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/^;properties\(\$root\) => /);
  });

  it("dispatches `@create` with the named keyword", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    const result = await runCommand(
      world,
      sessionId,
      "@create $thing named widget,gizmo",
      "cmd-create"
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/You now have widget \(aka gizmo\) with object number /);
    expect(text).toMatch(/parent \$thing \(\$thing\)\.$/);
  });

  it("dispatches `@set` with the to preposition", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    // First create a property to set.
    const created = await runCommand(world, sessionId, "@create $thing named gauge", "cmd-set-create");
    expect(created.op).toBe("result");
    if (created.op !== "result") return;
    const newId = (created.result as { id: string }).id;
    await world.directCall(
      "addprop",
      "$wiz",
      "$wiz",
      "property_command",
      [`#${newId}.level 0`]
    );
    const result = await runCommand(
      world,
      sessionId,
      `@set #${newId}.level to 42`,
      "cmd-set"
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe(`Property #${newId}.level set to 42.`);
    expect(world.getProp(newId, "level")).toBe(42);
  });

  it("dispatches `@property` to the programmer property verb", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    const created = await runCommand(world, sessionId, "@create $thing named gizmo2", "cmd-prop-create");
    expect(created.op).toBe("result");
    if (created.op !== "result") return;
    const newId = (created.result as { id: string }).id;
    const result = await runCommand(
      world,
      sessionId,
      `@property #${newId}.flowers iris`,
      "cmd-prop"
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/Property added with value /);
    expect(world.getProp(newId, "flowers")).toBe("iris");
  });

  it("dispatches `@rmprop` (alias-grammar prefix) to the rmproperty verb", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    const created = await runCommand(world, sessionId, "@create $thing named gizmo3", "cmd-rm-create");
    expect(created.op).toBe("result");
    if (created.op !== "result") return;
    const newId = (created.result as { id: string }).id;
    await runCommand(world, sessionId, `@property #${newId}.disposable 1`, "cmd-rm-add");
    const result = await runCommand(
      world,
      sessionId,
      `@rmprop #${newId}.disposable`,
      "cmd-rm"
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/Property removed/);
  });

  it("dispatches `@verb` to the programmer verb-creation verb", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    const created = await runCommand(world, sessionId, "@create $thing named pverbtarget", "cmd-pv-create");
    expect(created.op).toBe("result");
    if (created.op !== "result") return;
    const newId = (created.result as { id: string }).id;
    const result = await runCommand(world, sessionId, `@verb #${newId}:greet`, "cmd-pv");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/^Verb added \(slot \d+\)\.$/);
  });

  it("dispatches `@args` to the programmer args verb", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    const created = await runCommand(world, sessionId, "@create $thing named pargstarget", "cmd-pa-create");
    expect(created.op).toBe("result");
    if (created.op !== "result") return;
    const newId = (created.result as { id: string }).id;
    await runCommand(world, sessionId, `@verb #${newId}:greet`, "cmd-pa-add");
    const result = await runCommand(world, sessionId, `@args #${newId}:greet this with any`, "cmd-pa");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe("Verb arguments changed.");
  });

  it("dispatches `@rmverb` to the programmer rmverb verb", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    const created = await runCommand(world, sessionId, "@create $thing named prmtarget", "cmd-prm-create");
    expect(created.op).toBe("result");
    if (created.op !== "result") return;
    const newId = (created.result as { id: string }).id;
    await runCommand(world, sessionId, `@verb #${newId}:gone`, "cmd-prm-add");
    const result = await runCommand(world, sessionId, `@rmverb #${newId}:gone`, "cmd-prm");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toMatch(/:gone removed\.$/);
  });

  it("dispatches `@rename` (verb branch) with the to preposition", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    const created = await runCommand(world, sessionId, "@create $thing named prntarget", "cmd-prn-create");
    expect(created.op).toBe("result");
    if (created.op !== "result") return;
    const newId = (created.result as { id: string }).id;
    await runCommand(world, sessionId, `@verb #${newId}:before`, "cmd-prn-add");
    const result = await runCommand(world, sessionId, `@rename #${newId}:before to after`, "cmd-prn");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe("Verb name changed.");
  });

  it("dispatches `@list` to the programmer list-verb stub", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    const created = await runCommand(world, sessionId, "@create $thing named plisttarget", "cmd-pls-create");
    expect(created.op).toBe("result");
    if (created.op !== "result") return;
    const newId = (created.result as { id: string }).id;
    await runCommand(world, sessionId, `@verb #${newId}:show`, "cmd-pls-add");
    const result = await runCommand(world, sessionId, `@list #${newId}:show`, "cmd-pls");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const lines = (result.observations as any[])
      .filter((o) => o.type === "text" && o.target === "$wiz")
      .map((o) => o.text);
    expect(lines[0]).toMatch(/:show/);
    expect(lines[1]).toMatch(/^ 1:  /);
  });

  it("dispatches `@chmod` (verb branch) with absolute perms", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    const created = await runCommand(world, sessionId, "@create $thing named pcmodtarget", "cmd-pc-create");
    expect(created.op).toBe("result");
    if (created.op !== "result") return;
    const newId = (created.result as { id: string }).id;
    await runCommand(world, sessionId, `@verb #${newId}:foo`, "cmd-pc-add");
    const result = await runCommand(world, sessionId, `@chmod #${newId}:foo rxd`, "cmd-pc");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe('Verb permissions set to "rxd".');
  });

  it("dispatches `@chown` (verb branch) with the to preposition", async () => {
    const world = createWorld();
    const sessionId = await mintWizSession(world);
    await world.directCall("enter", "$wiz", "the_chatroom", "enter", []);
    const created = await runCommand(world, sessionId, "@create $thing named pcotarget", "cmd-pco-create");
    expect(created.op).toBe("result");
    if (created.op !== "result") return;
    const newId = (created.result as { id: string }).id;
    await runCommand(world, sessionId, `@verb #${newId}:foo`, "cmd-pco-add");
    const newPlayer = await runCommand(world, sessionId, "@create $player named alice", "cmd-pco-player");
    expect(newPlayer.op).toBe("result");
    if (newPlayer.op !== "result") return;
    const aliceId = (newPlayer.result as { id: string }).id;
    const result = await runCommand(world, sessionId, `@chown #${newId}:foo #${aliceId}`, "cmd-pco");
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = findTextObservation(result.observations, "$wiz");
    expect(text).toBe("Verb owner set.");
  });
});

describe("$builder:@set rejects creating new properties", () => {
  it("returns 'does not define that property' instead of silently adding", async () => {
    const world = createWorld();
    const created = await world.directCall(
      "create-no-prop",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named noprop"]
    );
    if (created.op !== "result") throw new Error("create failed");
    const id = (created.result as { id: string }).id;
    expect(() => world.getProp(id, "neverdefined")).toThrow();
    const result = await world.directCall(
      "set-undefined-prop",
      "$wiz",
      "$wiz",
      "set_command",
      [`#${id}.neverdefined`, "x"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = (result.observations as any[]).find(
      (o: any) => o.type === "text" && o.target === "$wiz"
    )?.text;
    expect(text).toMatch(/does not define that property/);
    // Property was NOT created.
    expect(() => world.getProp(id, "neverdefined")).toThrow();
  });
});

describe("$builder:set_property MCP tool also rejects new properties", () => {
  it("raises E_PROPNF rather than auto-creating", async () => {
    const world = createWorld();
    const created = await world.directCall(
      "create-mcp-no-prop",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named mcpnoprop"]
    );
    if (created.op !== "result") throw new Error("create failed");
    const id = (created.result as { id: string }).id;
    const result = await world.directCall(
      "set-prop-mcp",
      "$wiz",
      "$builder",
      "set_property",
      [id, "newprop", "x"]
    );
    expect(result.op).toBe("error");
    if (result.op !== "error") return;
    expect(result.error.code).toBe("E_PROPNF");
  });
});

describe("$programmer:@property rejects unsupported syntax", () => {
  it("returns a clear message when perms or owner tail is supplied", async () => {
    const world = createWorld();
    const created = await world.directCall(
      "create-extra",
      "$wiz",
      "$wiz",
      "create_command",
      ["$thing named extras"]
    );
    if (created.op !== "result") throw new Error("create failed");
    const id = (created.result as { id: string }).id;
    const result = await world.directCall(
      "addprop-extras",
      "$wiz",
      "$wiz",
      "property_command",
      [`#${id}.foo 0 r`]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    const text = (result.observations as any[]).find(
      (o: any) => o.type === "text" && o.target === "$wiz"
    )?.text;
    expect(text).toMatch(/perms.*owner.*ported/i);
    // No property was created.
    expect(() => world.getProp(id, "foo")).toThrow();
  });
});

describe("$string_utils:to_value handles objref literals", () => {
  it("strips the # from #xxx as a paste-back objref", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "tov-hash",
      "$wiz",
      "$string_utils",
      "to_value",
      ["#obj_xxx"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual([true, "obj_xxx"]);
  });

  it("returns $xxx corename verbatim", async () => {
    const world = createWorld();
    const result = await world.directCall(
      "tov-corename",
      "$wiz",
      "$string_utils",
      "to_value",
      ["$wiz"]
    );
    expect(result.op).toBe("result");
    if (result.op !== "result") return;
    expect(result.result).toEqual([true, "$wiz"]);
  });
});
