import { describe, expect, it } from "vitest";
import { compileVerb, definePropertyVersioned, definePropertyVersionedAs, installVerb, installVerbAs } from "../src/core/authoring";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import { wooError, type TinyBytecode } from "../src/core/types";
import {
  authedWorld,
  callInDubspace,
  message,
  nativeVerb
} from "./core-support";

describe("authoring", () => {
  it("compiles T0 source and installs with expected version", async () => {
    const { world, session, actor } = authedWorld();
    const source = `verb :set_feedback(value) rx {
  this.feedback = value;
  observe({
    "type": "control_changed",
    "target": this,
    "name": "feedback",
    "value": value,
    "actor": actor,
    "seq": seq
  });
  return value;
}`;
    const compiled = compileVerb(source);
    expect(compiled.ok).toBe(true);
    expect(compiled.metadata).toMatchObject({ name: "set_feedback", perms: "rx", arg_spec: { params: ["value"] } });
    expect(Object.keys(compiled.line_map ?? {}).length).toBeGreaterThan(0);
    const installed = installVerb(world, "delay_1", "set_feedback", source, null);
    expect(installed.ok).toBe(true);
    const info = world.verbInfo("delay_1", "set_feedback");
    expect(info.perms).toBe("rx");
    expect(info.arg_spec).toEqual({ params: ["value"] });
    expect(Object.keys(info.line_map as Record<string, unknown>).length).toBeGreaterThan(0);
    const applied = await callInDubspace(world, session.id, "test", message(actor, "delay_1", "set_feedback", [0.62]));
    expect(world.getProp("delay_1", "feedback")).toBe(0.62);
    if (applied.op === "applied") expect(applied.observations[0].type).toBe("control_changed");
    expect(() => installVerb(world, "delay_1", "set_feedback", source, null)).toThrow();
  });

  it("rejects undocumented verb permission letters", async () => {
    const compiled = compileVerb(`verb :bad() rxt {
  return true;
}`);
    expect(compiled.ok).toBe(false);
  });

  it("lets a programmer build an object, install behavior, and keep private state filtered", async () => {
    const world = createWorld();
    const builder = world.auth("guest:builder");
    const other = world.auth("guest:other-builder-test");
    const builderObj = world.object(builder.actor);
    builderObj.owner = builder.actor;
    builderObj.flags.programmer = true;

    expect((await world.directCall("builder-enter", builder.actor, "the_chatroom", "enter", [])).op).toBe("result");
    expect((await world.directCall("other-enter", other.actor, "the_chatroom", "enter", [])).op).toBe("result");

    expect(() => world.createAuthoredObject(other.actor, { parent: "$thing", name: "Should Fail", location: "the_chatroom" })).toThrow();

    const lamp = world.createAuthoredObject(builder.actor, {
      parent: "$thing",
      name: "Lamp",
      description: "A hidden builder lamp.",
      aliases: ["lamp"],
      location: "the_chatroom"
    });
    const subclass = world.createAuthoredObject(builder.actor, { parent: "$thing", name: "Builder Thing" });
    world.moveAuthoredObject(builder.actor, lamp, "$nowhere");
    expect(world.object(lamp).location).toBe("$nowhere");
    world.moveAuthoredObject(builder.actor, lamp, "the_chatroom");
    world.chparentAuthoredObject(builder.actor, lamp, subclass);
    expect(world.object(lamp).parent).toBe(subclass);

    const descDef = world.object(lamp).propertyDefs.get("description");
    expect(descDef).toBeTruthy();
    if (descDef) descDef.perms = "w";
    definePropertyVersionedAs(world, builder.actor, lamp, "rub_count", 0, "r", null, "int");
    expect(() => installVerbAs(world, other.actor, lamp, "steal", `verb :steal() rx { return true; }`, null)).toThrow();
    const installed = installVerbAs(world, builder.actor, lamp, "rub", `verb :rub() rx {
  this.rub_count = this.rub_count + 1;
  observe({ type: "builder_rubbed", target: this, count: this.rub_count, actor: actor });
  return this.rub_count;
}`, null);
    expect(installed.ok).toBe(true);

    const used = await world.call("rub-lamp", other.id, "the_chatroom", message(other.actor, lamp, "rub", []));
    expect(used.op).toBe("applied");
    expect(world.getProp(lamp, "rub_count")).toBe(1);
    if (used.op === "applied") expect(used.observations[0]).toMatchObject({ type: "builder_rubbed", target: lamp, count: 1, actor: other.actor });

    const look = await world.directCall("look-builder-room", other.actor, "the_chatroom", "look", []);
    expect(look.op).toBe("result");
    if (look.op === "result") {
      const room = look.result as { contents: Array<{ id: string; title: string; description: unknown }> };
      expect(room.contents.find((item) => item.id === lamp)).toMatchObject({ id: lamp, title: "Lamp", description: null });
    }

    const reloaded = createWorldFromSerialized(world.exportWorld());
    expect(reloaded.object(lamp).parent).toBe(subclass);
    expect(reloaded.getProp(lamp, "rub_count")).toBe(1);
    expect(reloaded.verbInfo(lamp, "rub").owner).toBe(builder.actor);
    expect(reloaded.propOrNullForActor(other.actor, lamp, "description")).toBe(null);
  });

  it("exposes task permission primitives without allowing non-wizard escalation", async () => {
    const { world, actor } = authedWorld();
    world.createObject({ id: "perm_box", name: "Perm Box", parent: "$thing", owner: "$wiz" });
    world.defineProperty("perm_box", { name: "secret", defaultValue: "sealed", owner: "$wiz", perms: "r", typeHint: "str" });
    expect(installVerb(world, "perm_box", "perms_probe", `verb :perms_probe() rxd {
  let before = task_perms();
  set_task_perms(actor);
  return [before, task_perms(), caller_perms()];
}`, null).ok).toBe(true);
    const probe = await world.directCall("perms-probe", actor, "perm_box", "perms_probe", []);
    expect(probe.op).toBe("result");
    if (probe.op === "result") expect(probe.result).toEqual(["$wiz", actor, actor]);

    expect(installVerb(world, "perm_box", "drop_then_write", `verb :drop_then_write() rxd {
  set_task_perms(actor);
  this.secret = "pwned";
  return true;
}`, null).ok).toBe(true);
    const denied = await world.directCall("drop-write", actor, "perm_box", "drop_then_write", []);
    expect(denied.op).toBe("error");
    if (denied.op === "error") expect(denied.error.code).toBe("E_PERM");
    expect(world.getProp("perm_box", "secret")).toBe("sealed");

    world.object(actor).owner = actor;
    world.object(actor).flags.programmer = true;
    const owned = world.createAuthoredObject(actor, { parent: "$thing", name: "Owned Probe" });
    expect(installVerbAs(world, actor, owned, "try_escalate", `verb :try_escalate() rxd {
  set_task_perms("$wiz");
  return true;
}`, null).ok).toBe(true);
    const escalated = await world.directCall("try-escalate", actor, owned, "try_escalate", []);
    expect(escalated.op).toBe("error");
    if (escalated.op === "error") expect(escalated.error.code).toBe("E_PERM");
  });

  it("exposes builder and programmer tools through player-class inheritance", async () => {
    const world = createWorld();
    const programmer = world.auth("guest:prog-reader");
    const programmerNoBit = world.auth("guest:prog-reader-nobit");
    const other = world.auth("guest:prog-reader-other");
    const actorObj = world.object(programmer.actor);
    actorObj.owner = programmer.actor;
    actorObj.flags.programmer = true;
    world.object(programmerNoBit.actor).owner = programmerNoBit.actor;
    world.object(other.actor).owner = other.actor;
    world.chparentAuthoredObject("$wiz", programmer.actor, "$programmer");
    world.chparentAuthoredObject("$wiz", programmerNoBit.actor, "$programmer");
    world.chparentAuthoredObject("$wiz", other.actor, "$builder");

    expect(world.object("$builder").parent).toBe("$player");
    expect(world.object("$programmer").parent).toBe("$builder");
    expect(world.object("$wiz").parent).toBe("$programmer");
    expect(world.objects.has("the_builder")).toBe(false);
    expect(world.objects.has("the_programmer")).toBe(false);

    const built = await world.directCall("builder-create", other.actor, other.actor, "create", ["$thing", {
      name: "Builder Box",
      description: "A non-programmer owned object.",
      aliases: ["box"]
    }]);
    expect(built.op).toBe("result");
    const otherBox = (built.op === "result" ? (built.result as Record<string, string>).id : "");
    expect(world.object(otherBox)).toMatchObject({ parent: "$thing", owner: other.actor });

    const actorChparentDenied = await world.directCall("builder-chparent-actor-denied", other.actor, other.actor, "chparent", [other.actor, otherBox, { dry_run: true }]);
    expect(actorChparentDenied.op).toBe("error");
    if (actorChparentDenied.op === "error") expect(actorChparentDenied.error.code).toBe("E_PERM");
    expect(world.object(other.actor).parent).toBe("$builder");

    const denied = await world.directCall("prog-denied", programmerNoBit.actor, programmerNoBit.actor, "install_verb", [otherBox, "demo", `verb :demo() rx { return true; }`, { dry_run: true }]);
    expect(denied.op).toBe("error");
    if (denied.op === "error") expect(denied.error.code).toBe("E_PERM");

    const baseCreated = await world.directCall("builder-create-base", programmer.actor, programmer.actor, "create", ["$thing", { name: "Prog Base", fertile: true }]);
    expect(baseCreated.op).toBe("result");
    const base = (baseCreated.op === "result" ? (baseCreated.result as Record<string, string>).id : "");
    const widgetCreated = await world.directCall("builder-create-widget", programmer.actor, programmer.actor, "create", [base, {
      name: "Widget",
      description: "A programmer-owned widget.",
      location: programmer.actor
    }]);
    expect(widgetCreated.op).toBe("result");
    const widget = (widgetCreated.op === "result" ? (widgetCreated.result as Record<string, string>).id : "");

    const propInfo = await world.directCall("programmer-prop-info", programmer.actor, programmer.actor, "set_property_info", [widget, "secret_note", {
      default: "private",
      perms: "w",
      type_hint: "str"
    }]);
    expect(propInfo.op).toBe("result");
    expect(world.propertyInfo(widget, "secret_note")).toMatchObject({ owner: programmer.actor, perms: "w" });

    const dryRun = await world.directCall("programmer-dry-run", programmer.actor, programmer.actor, "install_verb", [base, "title", `verb :title() rx {
  return this.name;
}`, { dry_run: true }]);
    expect(dryRun.op).toBe("result");
    if (dryRun.op === "result") {
      expect(dryRun.result).toMatchObject({ ok: true, dry_run: true, slot: 1, version: 1, metadata: { name: "title", perms: "rx" } });
      expect(dryRun.result as Record<string, unknown>).not.toHaveProperty("bytecode");
      expect(world.ownVerb(base, "title")).toBeNull();
    }

    const installed = await world.directCall("programmer-install", programmer.actor, programmer.actor, "install_verb", [base, "title", `verb :title() rx {
  return this.name;
}`, {}]);
    expect(installed.op).toBe("result");
    expect(world.ownVerb(base, "title")).toBeTruthy();

    const infoChanged = await world.directCall("programmer-verb-info", programmer.actor, programmer.actor, "set_verb_info", [base, "title", {
      aliases: ["headline"],
      tool_exposed: true,
      expected_version: 1
    }]);
    expect(infoChanged.op).toBe("result");
    expect(world.ownVerb(base, "title")).toMatchObject({ aliases: ["headline"], tool_exposed: true, version: 2 });

    const resolved = await world.directCall("prog-resolve", programmer.actor, programmer.actor, "resolve_verb", [widget, "title"]);
    expect(resolved.op).toBe("result");
    if (resolved.op === "result") {
      expect(resolved.result).toMatchObject({ definer: base, name: "title", readable: true });
      expect((resolved.result as Record<string, unknown>).source).toContain("return this.name");
      expect(resolved.result as Record<string, unknown>).not.toHaveProperty("bytecode");
      expect(resolved.result as Record<string, unknown>).not.toHaveProperty("source_hash");
    }

    const listed = await world.directCall("prog-list", programmer.actor, programmer.actor, "list_verb", [base, 1, {}]);
    expect(listed.op).toBe("result");
    if (listed.op === "result") expect(listed.result).toMatchObject({ slot: 1, name: "title", aliases: ["headline"] });

    const inspected = await world.directCall("prog-inspect", programmer.actor, programmer.actor, "inspect", [widget, { include_source: true }]);
    expect(inspected.op).toBe("result");
    if (inspected.op === "result") {
      const result = inspected.result as Record<string, unknown>;
      expect(result).toMatchObject({ id: widget, parent: base, owner: programmer.actor });
      expect(result.inherited_verbs).toEqual(expect.arrayContaining([expect.objectContaining({ name: "title", definer: base })]));
      expect(result.own_properties).toEqual(expect.arrayContaining([expect.objectContaining({ name: "secret_note", readable: true })]));
    }

    const searched = await world.directCall("prog-search", programmer.actor, programmer.actor, "search", ["widget", { scope: "actor_context" }]);
    expect(searched.op).toBe("result");
    if (searched.op === "result") {
      expect(searched.result).toMatchObject({ query: "widget", scope: "actor_context" });
      expect((searched.result as { results: Array<Record<string, unknown>> }).results).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "object", id: widget })]));
    }

    const oldCompat = compileVerb(`verb :old() rx {
  return prog_search("x");
}`);
    expect(oldCompat.ok).toBe(false);

    await expect(world.builderCreateObject(other.actor, "$thing", null, other.actor)).rejects.toMatchObject(wooError("E_PERM", "builder class surface required", {
      actor: other.actor,
      surface: other.actor
    }));
  });

  it("supports verb editor room sessions through the programmer surface", async () => {
    const world = createWorld();
    // The verb editor exit-to-$nowhere assertions below assume the actor had
    // no prior location. Demoworld would otherwise auto-place fresh guests in
    // Living Room.
    world.setProp("$system", "guest_initial_room", null);
    const programmer = world.auth("guest:verb-editor");
    const actorObj = world.object(programmer.actor);
    actorObj.owner = programmer.actor;
    actorObj.flags.programmer = true;
    world.chparentAuthoredObject("$wiz", programmer.actor, "$programmer");
    expect(world.object("the_verb_editor").location).toBe("$nowhere");
    expect(world.isDescendantOf("$nowhere", "$space")).toBe(false);

    const baseCreated = await world.directCall("editor-base", programmer.actor, programmer.actor, "create", ["$thing", { name: "Editor Base" }]);
    expect(baseCreated.op).toBe("result");
    const base = (baseCreated.op === "result" ? (baseCreated.result as Record<string, string>).id : "");
    const installed = await world.directCall("editor-install", programmer.actor, programmer.actor, "install_verb", [base, "title", `verb :title() rx {
  return "old title";
}`, {}]);
    expect(installed.op).toBe("result");
    const sessionWriteDenied = await world.directCall("editor-session-write-denied", programmer.actor, programmer.actor, "set_property", ["the_verb_editor", "sessions", {}, {}]);
    expect(sessionWriteDenied.op).toBe("error");
    if (sessionWriteDenied.op === "error") expect(sessionWriteDenied.error.code).toBe("E_PERM");
    expect(world.object(programmer.actor).location).not.toBe("the_verb_editor");
    const badEditorInstall = installVerbAs(world, "$wiz", "$programmer", "bad_editor_invoke", `verb :bad_editor_invoke(id, descriptor) rxd {
  return editor_invoke("the_chatroom", id, descriptor, {});
}`, null);
    expect(badEditorInstall.ok).toBe(true);
    const badEditor = await world.directCall("editor-bad-target", programmer.actor, programmer.actor, "bad_editor_invoke", [base, "title"]);
    expect(badEditor.op).toBe("error");
    if (badEditor.op === "error") expect(badEditor.error.code).toBe("E_TYPE");
    expect(world.propOrNull("the_chatroom", "sessions")).toBeNull();

    const opened = await world.directCall("editor-open", programmer.actor, programmer.actor, "edit_verb", [base, "title", {}]);
    expect(opened.op).toBe("result");
    if (opened.op === "result") expect(opened.result).toMatchObject({ editor: "the_verb_editor", target: base, slot: 1, expected_version: 1, dirty: false });
    if (opened.op === "result") expect(opened.observations).toEqual(expect.arrayContaining([expect.objectContaining({ type: "editor_entered", actor: programmer.actor, target: base })]));
    expect(world.object(programmer.actor).location).toBe("the_verb_editor");

    const viewed = await world.directCall("editor-view", programmer.actor, "the_verb_editor", "view", [{ line_numbers: true }]);
    expect(viewed.op).toBe("result");
    if (viewed.op === "result") {
      expect((viewed.result as Record<string, string>).buffer).toContain("old title");
      expect((viewed.result as { lines: Array<Record<string, unknown>> }).lines[1]).toMatchObject({ line: 2 });
    }

    const replaced = await world.directCall("editor-replace", programmer.actor, "the_verb_editor", "replace", [`verb :title() rx {
  return "new title";
}`]);
    expect(replaced.op).toBe("result");
    if (replaced.op === "result") expect(replaced.result).toMatchObject({ dirty: true });
    expect(world.ownVerb(base, "title")?.source).toContain("old title");

    const dryRun = await world.directCall("editor-dry-run", programmer.actor, "the_verb_editor", "dry_run", []);
    expect(dryRun.op).toBe("result");
    if (dryRun.op === "result") expect(dryRun.result).toMatchObject({ ok: true, dry_run: true, slot: 1, version: 2 });
    expect(world.ownVerb(base, "title")?.source).toContain("old title");

    const saved = await world.directCall("editor-save", programmer.actor, "the_verb_editor", "save", []);
    expect(saved.op).toBe("result");
    if (saved.op === "result") expect(saved.result).toMatchObject({ ok: true, version: 2, exited_to: "$nowhere" });
    expect(world.object(programmer.actor).location).toBe("$nowhere");
    expect(world.propOrNull("the_verb_editor", "sessions")).toEqual({});
    expect(world.ownVerb(base, "title")?.source).toContain("new title");

    const reopened = await world.directCall("editor-reopen", programmer.actor, programmer.actor, "edit_verb", [base, "title", {}]);
    expect(reopened.op).toBe("result");
    const paused = await world.directCall("editor-pause", programmer.actor, "the_verb_editor", "pause", []);
    expect(paused.op).toBe("result");
    expect(world.object(programmer.actor).location).toBe("$nowhere");
    expect(world.propOrNull("the_verb_editor", "sessions")).toHaveProperty(programmer.actor);
    const resumed = await world.directCall("editor-resume", programmer.actor, programmer.actor, "edit_verb", [base, "title", {}]);
    expect(resumed.op).toBe("result");
    if (resumed.op === "result") expect(resumed.result).toMatchObject({ resumed: true });
    if (resumed.op === "result") expect(resumed.observations).toEqual(expect.arrayContaining([expect.objectContaining({ type: "editor_entered", actor: programmer.actor, target: base })]));
    const aborted = await world.directCall("editor-abort", programmer.actor, "the_verb_editor", "abort", []);
    expect(aborted.op).toBe("result");
    expect(world.propOrNull("the_verb_editor", "sessions")).toEqual({});

    const secondCreated = await world.directCall("editor-second-base", programmer.actor, programmer.actor, "create", ["$thing", { name: "Second Editor Base" }]);
    expect(secondCreated.op).toBe("result");
    const secondBase = (secondCreated.op === "result" ? (secondCreated.result as Record<string, string>).id : "");
    const secondInstall = await world.directCall("editor-second-install", programmer.actor, programmer.actor, "install_verb", [secondBase, "title", `verb :title() rx {
  return "second title";
}`, {}]);
    expect(secondInstall.op).toBe("result");
    const cleanFirst = await world.directCall("editor-clean-first", programmer.actor, programmer.actor, "edit_verb", [base, "title", {}]);
    expect(cleanFirst.op).toBe("result");
    const replacedSession = await world.directCall("editor-clean-replace", programmer.actor, programmer.actor, "edit_verb", [secondBase, "title", {}]);
    expect(replacedSession.op).toBe("result");
    if (replacedSession.op === "result") expect(replacedSession.result).toMatchObject({ target: secondBase, replaced_previous: { target: base, dirty: false } });
    const abortedReplacement = await world.directCall("editor-abort-replacement", programmer.actor, "the_verb_editor", "abort", []);
    expect(abortedReplacement.op).toBe("result");
    if (abortedReplacement.op === "result") expect(abortedReplacement.result).toMatchObject({ exited_to: "$nowhere" });
    expect(world.object(programmer.actor).location).toBe("$nowhere");
  });

  it("compiles string interpolation and dynamic index get/set", async () => {
    const { world, session, actor } = authedWorld();
    const source = `verb :index_and_interp(name, value) rx {
  let controls = { feedback: 1 };
  controls[name] = value;
  this.(name) = value;
  let text = "set \${name}=\${controls[name]}";
  observe({ type: "index_interp", text: text, value: controls[name], prop_value: this.(name) });
  return text;
}`;
    const compiled = compileVerb(source);
    expect(compiled.ok).toBe(true);
    expect(compiled.bytecode?.ops.map(([op]) => op)).toEqual(expect.arrayContaining(["INDEX_SET", "INDEX_GET", "SET_PROP", "GET_PROP", "STR_INTERP"]));
    expect(installVerb(world, "delay_1", "index_and_interp", source, null).ok).toBe(true);

    const applied = await callInDubspace(world, session.id, "index", message(actor, "delay_1", "index_and_interp", ["feedback", 0.7]));
    expect(applied.op).toBe("applied");
    expect(world.getProp("delay_1", "feedback")).toBe(0.7);
    if (applied.op === "applied") {
      expect(applied.observations[0]).toMatchObject({ type: "index_interp", text: "set feedback=0.7", value: 0.7, prop_value: 0.7 });
    }
  });

  it("adds line-mapped runtime traces to VM error observations", async () => {
    const { world, session, actor } = authedWorld();
    const source = `verb :explode() rx {
  let denom = 0;
  return 1 / denom;
}`;
    expect(installVerb(world, "delay_1", "explode", source, null).ok).toBe(true);
    const applied = await callInDubspace(world, session.id, "explode", message(actor, "delay_1", "explode", []));
    expect(applied.op).toBe("applied");
    if (applied.op === "applied") {
      expect(applied.observations[0].type).toBe("$error");
      expect(applied.observations[0].code).toBe("E_DIV");
      const trace = applied.observations[0].trace as Record<string, unknown>[];
      expect(trace[0]).toMatchObject({ obj: "delay_1", verb: "explode", definer: "delay_1", line: 3 });
    }
  });

  it("seeds dubspace loop transport verbs as authored source", async () => {
    const { world, session, actor } = authedWorld();
    const info = world.verbInfo("the_dubspace", "start_loop");
    expect(info.source).toContain("slot.playing = true");
    expect(info.bytecode_version).toBeGreaterThan(0);

    const started = await callInDubspace(world, session.id, "start-loop", message(actor, "the_dubspace", "start_loop", ["slot_1"]));
    expect(world.getProp("slot_1", "playing")).toBe(true);
    if (started.op === "applied") expect(started.observations[0]).toMatchObject({ type: "loop_started", slot: "slot_1", loop_id: "loop-1" });
    const stopped = await callInDubspace(world, session.id, "stop-loop", message(actor, "the_dubspace", "stop_loop", ["slot_1"]));
    expect(world.getProp("slot_1", "playing")).toBe(false);
    if (stopped.op === "applied") expect(stopped.observations[0]).toMatchObject({ type: "loop_stopped", slot: "slot_1" });
  });

  it("compiles M1 source with locals, loops, conditionals, and observations", async () => {
    const { world, session, actor } = authedWorld();
    const source = `verb :sum_to(limit) rx {
  let total = 0;
  for i in [1..limit] {
    total = total + i;
  }
  if (total > 10) {
    this.feedback = total;
  } else {
    this.feedback = 0;
  }
  observe({
    type: "compiled_sum",
    value: total,
    large: total > 10,
    has_feedback: "feedback" in { feedback: true }
  });
  return total;
}`;

    const compiled = compileVerb(source);
    expect(compiled.ok).toBe(true);
    expect(compiled.bytecode?.ops.some(([op]) => op === "FOR_RANGE_NEXT")).toBe(true);
    const installed = installVerb(world, "delay_1", "sum_to", source, null);
    expect(installed.ok).toBe(true);

    const applied = await callInDubspace(world, session.id, "compiled-sum", message(actor, "delay_1", "sum_to", [5]));
    expect(applied.op).toBe("applied");
    expect(world.getProp("delay_1", "feedback")).toBe(15);
    if (applied.op === "applied") {
      expect(applied.observations[0]).toMatchObject({ type: "compiled_sum", value: 15, large: true, has_feedback: true });
    }
  });

  it("compiles source verb calls, pass, and try/except", async () => {
    const { world, actor } = authedWorld();
    world.createObject({ id: "compiler_base", name: "Compiler Base", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "compiler_child", name: "Compiler Child", parent: "compiler_base", owner: "$wiz" });
    expect(installVerb(world, "compiler_base", "value", `verb :value() rx {
  return 10;
}`, null).ok).toBe(true);
    expect(installVerb(world, "compiler_child", "value", `verb :value() rx {
  return pass() + 5;
}`, null).ok).toBe(true);
    expect(installVerb(world, "delay_1", "call_child", `verb :call_child() rx {
  return "compiler_child":value();
}`, null).ok).toBe(true);
    expect(installVerb(world, "delay_1", "catcher", `verb :catcher() rx {
  try {
    raise "E_BOOM";
  } except err in (E_BOOM) {
    return err["code"];
  }
  return "miss";
}`, null).ok).toBe(true);

    const ctx = {
        world,
        space: "the_dubspace",
        seq: 110,
        session: null,
        actor,
      player: actor,
      caller: "#-1",
      callerPerms: actor,
      progr: actor,
      thisObj: "delay_1",
      verbName: "call_child",
      definer: "delay_1",
      message: message(actor, "delay_1", "call_child", []),
      observations: [],
      observe: () => {}
    };
    expect(await world.dispatch(ctx, "delay_1", "call_child", [])).toBe(15);
    expect(await world.dispatch({ ...ctx, verbName: "catcher", message: message(actor, "delay_1", "catcher", []) }, "delay_1", "catcher", [])).toBe("E_BOOM");
  });

  it("returns structured diagnostics for bad source", async () => {
    const result = compileVerb(`verb :bad() rx {
  let x = ;
}`);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ severity: "error", code: "E_COMPILE" });
    expect(result.diagnostics[0].span?.line).toBe(2);
  });

  it("verifies raw JSON bytecode fallback and versions property definitions", async () => {
    const world = createWorld();
    const raw = JSON.stringify({
      ops: [["PUSH_ARG", 0], ["RETURN"]],
      literals: [],
      num_locals: 0,
      max_stack: 1,
      version: 1
    });
    expect(compileVerb(raw, { format: "t0-json-bytecode" }).ok).toBe(true);
    const prop = definePropertyVersioned(world, "delay_1", "note", "", "rw", null, "str");
    expect(prop.version).toBe(1);
    expect(() => definePropertyVersioned(world, "delay_1", "note", "", "rw", null, "str")).toThrow();
    const updated = definePropertyVersioned(world, "delay_1", "note", "x", "rw", 1, "str");
    expect(updated.version).toBe(2);
  });

  it("rejects raw JSON bytecode with excessive resource budgets", async () => {
    const base = {
      ops: [["PUSH_INT", 1], ["RETURN"]],
      literals: [],
      num_locals: 0,
      max_stack: 1,
      version: 1
    };
    expect(compileVerb(JSON.stringify({ ...base, max_ticks: 1_000_001 }), { format: "t0-json-bytecode" })).toMatchObject({ ok: false });
    expect(compileVerb(JSON.stringify({ ...base, num_locals: 1_025 }), { format: "t0-json-bytecode" })).toMatchObject({ ok: false });
    expect(compileVerb(JSON.stringify({ ...base, literals: ["x".repeat(512 * 1024)] }), { format: "t0-json-bytecode" })).toMatchObject({ ok: false });
  });

  it("rejects malformed raw JSON bytecode before install", async () => {
    const compileRaw = (bytecode: Partial<TinyBytecode>) => compileVerb(JSON.stringify({
      literals: [],
      num_locals: 0,
      max_stack: 1,
      version: 1,
      ...bytecode
    }), { format: "t0-json-bytecode" });

    expect(compileRaw({ ops: [] })).toMatchObject({ ok: false });
    expect(compileRaw({ ops: [["RETURN"]] })).toMatchObject({ ok: false });
    expect(compileRaw({ ops: [["PUSH_LIT", 0], ["RETURN"]] })).toMatchObject({ ok: false });
    expect(compileRaw({ ops: [["PUSH_INT", 1, 2], ["RETURN"]] })).toMatchObject({ ok: false });
    expect(compileRaw({ ops: [["JUMP", 10]] })).toMatchObject({ ok: false });
    expect(compileRaw({ ops: [["PUSH_INT", 1], ["JUMP_IF_TRUE_KEEP", 1], ["PUSH_INT", 2], ["RETURN"], ["RETURN"]] })).toMatchObject({ ok: false });
    expect(compileRaw({ literals: [[]], ops: [["PUSH_LIT", 0], ["SPLAT"], ["RETURN"]] })).toMatchObject({ ok: false });
  });

  it("preserves installed verb metadata when replacing source", async () => {
    const world = createWorld();
    world.createObject({ id: "metadata_probe", name: "Metadata Probe", parent: "$thing", owner: "$wiz" });
    world.addVerb("metadata_probe", {
      ...nativeVerb("ping", "describe"),
      aliases: ["p*ing"],
      direct_callable: true,
      skip_presence_check: true,
      tool_exposed: true
    });
    const pingBefore = world.ownVerb("metadata_probe", "ping");
    expect(pingBefore?.aliases).toContain("p*ing");
    expect(pingBefore?.tool_exposed).toBe(true);
    expect(pingBefore?.skip_presence_check).toBe(true);
    expect(pingBefore?.direct_callable).toBe(true);

    const pingInstalled = installVerb(world, "metadata_probe", "ping", `verb :ping() rxd {
  return "ok";
}`, pingBefore?.version ?? null);
    expect(pingInstalled.ok).toBe(true);
    const pingAfter = world.ownVerb("metadata_probe", "ping");
    expect(pingAfter?.aliases).toEqual(pingBefore?.aliases);
    expect(pingAfter?.tool_exposed).toBe(true);
    expect(pingAfter?.skip_presence_check).toBe(true);
    expect(pingAfter?.direct_callable).toBe(true);
  });

  it("lets authoring callers attach command metadata when installing source", () => {
    const { world } = authedWorld();
    world.createObject({ id: "command_metadata_probe", name: "Command Metadata Probe", parent: "$thing", owner: "$wiz" });
    const installed = installVerb(world, "command_metadata_probe", "ping", `verb :ping() rxd {
  return "ok";
}`, null, { argSpec: { command: { dobj: "this", prep: "any", iobj: "any", args_from: [] } } });
    expect(installed.ok).toBe(true);
    expect(world.ownVerbExact("command_metadata_probe", "ping")?.arg_spec).toMatchObject({
      params: [],
      command: { dobj: "this", prep: "any", iobj: "any", args_from: [] }
    });
  });

  it("uses structural map equality in T0 EQ", async () => {
    const { world, session, actor } = authedWorld();
    world.addVerb("delay_1", {
      kind: "bytecode",
      name: "observe_eq",
      aliases: [],
      owner: "$wiz",
      perms: "rxd",
      arg_spec: {},
      source: "test structural equality",
      source_hash: "test",
      version: 1,
      line_map: {},
      bytecode: {
        literals: ["type", "eq_result", "value", { a: 1, b: 2 }, { b: 2, a: 1 }, null],
        ops: [
          ["PUSH_LIT", 0],
          ["PUSH_LIT", 1],
          ["PUSH_LIT", 2],
          ["PUSH_LIT", 3],
          ["PUSH_LIT", 4],
          ["EQ"],
          ["MAKE_MAP", 2],
          ["OBSERVE"],
          ["PUSH_LIT", 5],
          ["RETURN"]
        ],
        num_locals: 0,
        max_stack: 6,
        version: 1
      }
    });
    const applied = await callInDubspace(world, session.id, "eq", message(actor, "delay_1", "observe_eq", []));
    if (applied.op === "applied") expect(applied.observations[0].value).toBe(true);
  });
});
