import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installVerb } from "../src/core/authoring";
import { createWorld, createWorldFromSerialized, mergeHostScopedSeed, nonEmptyHostScopedWorld } from "../src/core/bootstrap";
import { installCatalogManifest, updateCatalogManifest, type CatalogManifest as RuntimeCatalogManifest } from "../src/core/catalog-installer";
import { bundledCatalogAliases, installLocalCatalogs, localCatalogStatuses, runHostScopedDataMigrations, runHostScopedLocalCatalogLifecycle } from "../src/core/local-catalogs";
import type { VerbDef, WooValue } from "../src/core/types";

type CatalogManifest = {
  name: string;
  version: string;
  spec_version: string;
  license: string;
  depends?: string[];
  classes?: { local_name: string; parent: string; verbs?: { name: string; source: string }[] }[];
  features?: { local_name: string; parent: string; verbs?: { name: string; source: string }[] }[];
  schemas?: { on: string; type: string; shape: Record<string, unknown> }[];
  seed_hooks?: Record<string, unknown>[];
};

const root = new URL("../catalogs", import.meta.url).pathname;

function readManifest(name: string): CatalogManifest {
  return JSON.parse(readFileSync(join(root, name, "manifest.json"), "utf8")) as CatalogManifest;
}

function readFrontmatter(name: string): Record<string, string> {
  const readme = readFileSync(join(root, name, "README.md"), "utf8");
  const match = /^---\n([\s\S]*?)\n---/.exec(readme);
  expect(match, `${name} README should have frontmatter`).not.toBeNull();
  const entries = (match?.[1] ?? "")
    .split("\n")
    .filter((line) => line.includes(":"))
    .map((line) => {
      const index = line.indexOf(":");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    });
  return Object.fromEntries(entries);
}

function worldVerb(world: ReturnType<typeof createWorld>, object: string, name: string) {
  const verb = world.ownVerbExact(object, name);
  expect(verb, `${object}:${name} should exist`).toBeDefined();
  return verb!;
}

function installHelpDependency(world: ReturnType<typeof createWorld>) {
  installCatalogManifest(world, readManifest("help") as unknown as RuntimeCatalogManifest, {
    tap: "@local",
    alias: "help"
  });
}

describe("local catalogs", () => {
  it("discovers bundled catalogs from manifest locations", async () => {
    const catalogDirs = readdirSync(root).filter((name) => existsSync(join(root, name, "manifest.json"))).sort();
    const manifestNames = catalogDirs.map((name) => readManifest(name).name).sort();
    expect([...bundledCatalogAliases()].sort()).toEqual(manifestNames);
  });

  it("keeps README frontmatter aligned with manifests", async () => {
    for (const name of readdirSync(root).filter((entry) => existsSync(join(root, entry, "manifest.json")))) {
      const manifest = readManifest(name);
      const frontmatter = readFrontmatter(name);
      expect(manifest.name).toBe(name);
      expect(frontmatter.name).toBe(manifest.name);
      expect(frontmatter.version).toBe(manifest.version);
      expect(frontmatter.spec_version).toBe(manifest.spec_version);
      expect(frontmatter.license).toBe(manifest.license);
    }
  });

  it("keeps each catalog's app design with the catalog", async () => {
    for (const name of readdirSync(root).filter((entry) => existsSync(join(root, entry, "manifest.json")))) {
      const design = readFileSync(join(root, name, "DESIGN.md"), "utf8");
      expect(design).toMatch(/^# \S/m);
      expect(readFileSync(join(root, name, "README.md"), "utf8")).toContain("[DESIGN.md](DESIGN.md)");
    }
  });

  it("uses explicit dependency order for embedded chat", async () => {
    const chat = readManifest("chat");
    const taskspace = readManifest("taskspace");
    expect(chat.depends).toEqual(["@local:help"]);
    expect(taskspace.depends).toEqual(["@local:chat"]);
    expect(taskspace.seed_hooks).toContainEqual({ kind: "attach_feature", consumer: "the_taskspace", feature: "chat:$conversational" });
  });

  it("keeps mounted demo-space enter and leave verbs portable", async () => {
    const world = createWorld({ catalogs: false });
    installLocalCatalogs(world, ["chat", "demoworld", "dubspace", "pinboard"]);

    expect(world.ownVerb("$dubspace", "enter")?.kind).toBe("bytecode");
    expect(world.ownVerb("$dubspace", "leave")?.kind).toBe("bytecode");
    expect(world.ownVerb("$pinboard", "enter")?.kind).toBe("bytecode");
    expect(world.ownVerb("$pinboard", "leave")?.kind).toBe("bytecode");
  });

  it("installs the help database and routes player help through it", async () => {
    const world = createWorld();

    expect(world.object("$generic_help_db").parent).toBe("$thing");
    expect(world.object("$help").parent).toBe("$generic_help_db");
    expect(world.getProp("$system", "help_dbs")).toContain("$help");

    const help = await world.directCall("help-commands", "$wiz", "$wiz", "help", ["commands"]);
    expect(help.op).toBe("result");
    if (help.op === "result") {
      expect(help.result).toMatchObject({ ok: true, topic: "commands", db: "$help" });
      expect(help.observations).toContainEqual(expect.objectContaining({ type: "text", target: "$wiz", text: expect.stringContaining("Common commands") }));
    }

    const index = await world.directCall("help-index", "$wiz", "$wiz", "help", []);
    expect(index.op).toBe("result");
    if (index.op === "result") expect(index.result).toMatchObject({ ok: true, topic: "index", title: "Woo Help" });

    const plan = await world.directCall("help-plan", "$wiz", "the_chatroom", "command_plan", ["help movement"], { forceDirect: true });
    expect(plan.op).toBe("result");
    if (plan.op === "result") {
      expect(plan.result).toMatchObject({ route: "direct", target: "$wiz", verb: "help", args: ["movement"] });
    }

    const miss = await world.directCall("help-miss", "$wiz", "$wiz", "help", ["definitely-missing"]);
    expect(miss.op).toBe("result");
    expect(world.getProp("$help", "missed_topics")).toContainEqual(expect.objectContaining({ topic: "definitely-missing", actor: "$wiz" }));
  });

  it("does not leak unreadable verb source through verbdoc help topics", async () => {
    const world = createWorld();
    const session = world.auth("guest:help-reader");
    const actor = session.actor;
    const secretSource = "verb :sealed() x {\n  return \"SECRET HELP SOURCE\";\n}";

    world.createObject({ id: "secret_help_object", name: "Secret Help Object", parent: "$thing", owner: "$wiz" });
    expect(installVerb(world, "secret_help_object", "sealed", secretSource, null).ok).toBe(true);
    const topics = world.getProp("$help", "topics") as Record<string, WooValue>;
    world.setProp("$help", "topics", { ...topics, "sealed-topic": ["*verbdoc*", "secret_help_object", "sealed"] });

    const guestHelp = await world.directCall("help-verbdoc-guest", actor, actor, "help", ["sealed-topic"]);
    expect(JSON.stringify(guestHelp)).not.toContain("SECRET HELP SOURCE");
    expect(JSON.stringify(guestHelp)).toContain("Verb source is not readable");

    const wizardHelp = await world.directCall("help-verbdoc-wiz", "$wiz", "$wiz", "help", ["sealed-topic"]);
    expect(JSON.stringify(wizardHelp)).toContain("SECRET HELP SOURCE");
  });

  it("rejects missing catalog dependencies with the installed set in the error", async () => {
    const world = createWorld({ catalogs: false });
    const manifest: RuntimeCatalogManifest = {
      name: "needs-chat",
      version: "1.0.0",
      spec_version: "v1",
      depends: ["@local:chat"],
      classes: []
    };
    expect(() => installCatalogManifest(world, manifest, { tap: "@local", alias: "needs-chat" })).toThrow(/@local:chat.*\(none\)/);
  });

  it("rejects duplicate catalog aliases and duplicate source identities", async () => {
    const world = createWorld({ catalogs: false });
    const first: RuntimeCatalogManifest = {
      name: "collision-one",
      version: "1.0.0",
      spec_version: "v1",
      classes: [{ local_name: "$collision_one", parent: "$thing" }]
    };
    const second: RuntimeCatalogManifest = {
      name: "collision-two",
      version: "1.0.0",
      spec_version: "v1",
      classes: [{ local_name: "$collision_two", parent: "$thing" }]
    };
    installCatalogManifest(world, first, { tap: "owner/repo", alias: "collision" });

    expect(() => installCatalogManifest(world, second, { tap: "owner/other", alias: "collision" })).toThrow(/catalog alias is already installed/);

    const sourceWorld = createWorld({ catalogs: false });
    const source: RuntimeCatalogManifest = { name: "same-source", version: "1.0.0", spec_version: "v1", classes: [] };
    installCatalogManifest(sourceWorld, source, { tap: "owner/repo", alias: "source-a" });
    expect(() => installCatalogManifest(sourceWorld, source, { tap: "owner/repo", alias: "source-b" })).toThrow(/catalog source is already installed/);
  });

  it("updates installed catalogs without recreating their registry object", async () => {
    const world = createWorld({ catalogs: false });
    const v1: RuntimeCatalogManifest = {
      name: "update-demo",
      version: "1.0.0",
      spec_version: "v1",
      classes: [
        {
          local_name: "$update_probe",
          parent: "$thing",
          verbs: [{ name: "ping", source: "verb :ping() rxd {\n  return \"one\";\n}" }]
        }
      ]
    };
    const v1_1: RuntimeCatalogManifest = {
      ...v1,
      version: "1.1.0",
      classes: [
        {
          local_name: "$update_probe",
          parent: "$thing",
          properties: [{ name: "mode", type: "str", default: "minor" }],
          verbs: [{ name: "ping", source: "verb :ping() rxd {\n  return \"two\";\n}" }]
        }
      ]
    };

    installCatalogManifest(world, v1, { tap: "@local", alias: "update-demo" });
    const catalogRecordCreated = world.object("catalog_update_demo").created;
    updateCatalogManifest(world, v1_1, { tap: "@local", alias: "update-demo" });

    expect(world.object("catalog_update_demo").created).toBe(catalogRecordCreated);
    expect(world.getProp("$update_probe", "mode")).toBe("minor");
    const result = await world.directCall("catalog-update-ping", "$wiz", "$update_probe", "ping", []);
    expect(result.op).toBe("result");
    if (result.op === "result") expect(result.result).toBe("two");
    expect(world.getProp("$catalog_registry", "installed_catalogs")).toMatchObject([
      { alias: "update-demo", version: "1.1.0", migration_state: { status: "not_required" } }
    ]);
  });

  it("gates major catalog updates behind explicit migration input", async () => {
    const world = createWorld({ catalogs: false });
    const v1: RuntimeCatalogManifest = {
      name: "major-demo",
      version: "1.0.0",
      spec_version: "v1",
      classes: [{ local_name: "$major_probe", parent: "$thing" }]
    };
    const v2: RuntimeCatalogManifest = {
      ...v1,
      version: "2.0.0",
      classes: [{ local_name: "$major_probe", parent: "$thing", properties: [{ name: "new_field", type: "str", default: "new" }] }]
    };

    installCatalogManifest(world, v1, { tap: "@local", alias: "major-demo" });

    expect(() => updateCatalogManifest(world, v2, { tap: "@local", alias: "major-demo" })).toThrow(/accept_major/);
    expect(() => updateCatalogManifest(world, v2, { tap: "@local", alias: "major-demo", acceptMajor: true })).toThrow(/migration manifest/);
    expect(() => updateCatalogManifest(world, v2, {
      tap: "@local",
      alias: "major-demo",
      acceptMajor: true,
      migration: { from_version: "1.0", to_version: "2.0.0", spec_version: "v1", steps: [] }
    })).toThrow(/migration version range/);
    expect(world.propOrNull("$major_probe", "new_field")).toBeNull();
  });

  it("runs structural property migrations across catalog instances", async () => {
    const world = createWorld({ catalogs: false });
    const v1: RuntimeCatalogManifest = {
      name: "migration-demo",
      version: "1.0.0",
      spec_version: "v1",
      classes: [
        {
          local_name: "$migrating",
          parent: "$thing",
          properties: [{ name: "old_name", type: "str", default: "old" }]
        }
      ],
      seed_hooks: [
        {
          kind: "create_instance",
          class: "$migrating",
          as: "migrated_1",
          properties: { old_name: "live value" }
        }
      ]
    };
    const v2: RuntimeCatalogManifest = {
      ...v1,
      version: "2.0.0",
      classes: [
        {
          local_name: "$migrating",
          parent: "$thing",
          properties: [{ name: "new_name", type: "str", default: "new" }]
        }
      ]
    };

    installCatalogManifest(world, v1, { tap: "@local", alias: "migration-demo" });
    const record = updateCatalogManifest(world, v2, {
      tap: "@local",
      alias: "migration-demo",
      acceptMajor: true,
      migration: {
        from_version: "1.x.x",
        to_version: "2.0.0",
        spec_version: "v1",
        steps: [{ kind: "rename_property", class: "$migrating", from: "old_name", to: "new_name" }]
      }
    });

    expect(record.migration_state).toMatchObject({ status: "completed", completed_steps: ["1:rename_property:$migrating.old_name->new_name"] });
    expect(world.getProp("migrated_1", "new_name")).toBe("live value");
    expect(world.propOrNull("migrated_1", "old_name")).toBeNull();
    const state = await world.directCall("catalog-migration-state", "$wiz", "$catalog_registry", "migration_state", ["migration-demo"]);
    expect(state.op).toBe("result");
    if (state.op === "result") expect(state.result).toMatchObject({ status: "completed", to_version: "2.0.0" });
  });

  it("installs chat from source without trusted implementation hints", async () => {
    const world = createWorld({ catalogs: false });
    installHelpDependency(world);
    const manifest = readManifest("chat") as unknown as RuntimeCatalogManifest;
    installCatalogManifest(world, manifest, {
      tap: "github:example/woo-test",
      alias: "chat",
      allowImplementationHints: false
    });
    installCatalogManifest(world, readManifest("demoworld") as unknown as RuntimeCatalogManifest, {
      tap: "github:example/woo-test",
      alias: "demoworld",
      allowImplementationHints: false
    });

    expect(world.ownVerb("$conversational", "say")?.kind).toBe("bytecode");
    expect(world.ownVerb("$conversational", "enter")?.kind).toBe("bytecode");
    expect(world.ownVerb("$conversational", "leave")?.kind).toBe("bytecode");
    expect(world.ownVerb("$conversational", "command_plan")?.kind).toBe("bytecode");
    expect(world.ownVerb("$match", "parse_command")?.kind).toBe("bytecode");

    const first = world.auth("guest:catalog-chat-1");
    const second = world.auth("guest:catalog-chat-2");
    const enterFirst = await world.directCall("enter-first", first.actor, "the_chatroom", "enter", []);
    const enterSecond = await world.directCall("enter-second", second.actor, "the_chatroom", "enter", []);
    expect(enterFirst.op).toBe("result");
    expect(enterSecond.op).toBe("result");
    expect(world.hasPresence(first.actor, "the_chatroom")).toBe(true);
    expect(world.hasPresence(second.actor, "the_chatroom")).toBe(true);

    const say = await world.directCall("say", first.actor, "the_chatroom", "say", ["hello from source"]);
    expect(say.op).toBe("result");
    if (say.op === "result") {
      expect(say.observations).toMatchObject([{ type: "said", source: "the_chatroom", actor: first.actor, text: "hello from source" }]);
      expect(typeof say.observations[0].ts).toBe("number");
    }

    const leave = await world.directCall("leave", second.actor, "the_chatroom", "leave", []);
    expect(leave.op).toBe("result");
    expect(world.hasPresence(second.actor, "the_chatroom")).toBe(false);
  });

  it("treats rxd catalog source perms as direct-callable shorthand", async () => {
    const world = createWorld({ catalogs: false });
    const manifest: RuntimeCatalogManifest = {
      name: "shorthand",
      version: "1.0.0",
      spec_version: "v1",
      classes: [
        {
          local_name: "$shorthand_probe",
          parent: "$thing",
          verbs: [
            {
              name: "ping",
              source: "verb :ping() rxd { return \"pong\"; }"
            }
          ]
        }
      ]
    };

    installCatalogManifest(world, manifest, {
      tap: "github:example/woo-test",
      alias: "shorthand",
      allowImplementationHints: false
    });

    const verb = world.ownVerb("$shorthand_probe", "ping");
    expect(verb?.perms).toBe("rx");
    expect(verb?.direct_callable).toBe(true);
    expect((await world.directCall("catalog-shorthand-ping", "$wiz", "$shorthand_probe", "ping", [])).op).toBe("result");
  });

  it("installs taskspace from source without trusted implementation hints", async () => {
    const world = createWorld({ catalogs: false });
    installHelpDependency(world);
    installCatalogManifest(world, readManifest("chat") as unknown as RuntimeCatalogManifest, {
      tap: "@local",
      alias: "chat",
      allowImplementationHints: false
    });
    installCatalogManifest(world, readManifest("taskspace") as unknown as RuntimeCatalogManifest, {
      tap: "github:example/woo-test",
      alias: "taskspace",
      allowImplementationHints: false
    });

    expect(world.ownVerb("$taskspace", "create_task")?.kind).toBe("bytecode");
    expect(world.ownVerb("$task", "set_status")?.kind).toBe("bytecode");

    const session = world.auth("guest:catalog-taskspace");
    const created = await world.call("create-task", session.id, "the_taskspace", {
      actor: session.actor,
      target: "the_taskspace",
      verb: "create_task",
      args: ["Source task", ""]
    });
    expect(created.op).toBe("applied");
    const task = created.op === "applied" ? String(created.observations[0].task) : "";
    expect(world.getProp(task, "title")).toBe("Source task");

    await world.call("requirement", session.id, "the_taskspace", { actor: session.actor, target: task, verb: "add_requirement", args: ["has source verbs"] });
    const done = await world.call("done", session.id, "the_taskspace", { actor: session.actor, target: task, verb: "set_status", args: ["done"] });
    expect(world.getProp(task, "status")).toBe("done");
    if (done.op === "applied") expect(done.observations.map((obs) => obs.type)).toContain("done_premature");
  });

  it("installs dubspace from source without trusted implementation hints", async () => {
    const world = createWorld({ catalogs: false });
    installHelpDependency(world);
    installCatalogManifest(world, readManifest("chat") as unknown as RuntimeCatalogManifest, {
      tap: "github:example/woo-test",
      alias: "chat",
      allowImplementationHints: false
    });
    installCatalogManifest(world, readManifest("demoworld") as unknown as RuntimeCatalogManifest, {
      tap: "github:example/woo-test",
      alias: "demoworld",
      allowImplementationHints: false
    });
    installCatalogManifest(world, readManifest("dubspace") as unknown as RuntimeCatalogManifest, {
      tap: "github:example/woo-test",
      alias: "dubspace",
      allowImplementationHints: false
    });

    expect(world.object("the_dubspace").location).toBe("the_chatroom");
    expect(world.object("the_chatroom").contents.has("the_dubspace")).toBe(true);
    expect(world.ownVerb("$dubspace", "set_control")?.kind).toBe("bytecode");
    expect(world.ownVerb("$dubspace", "set_drum_step")?.kind).toBe("bytecode");
    expect(world.ownVerb("$dubspace", "save_scene")?.kind).toBe("bytecode");
    expect(world.ownVerb("$dubspace", "enter")?.kind).toBe("bytecode");

    const session = world.auth("guest:catalog-dubspace");
    const actor = session.actor;
    const actorName = String(world.getProp(actor, "name"));
    const entered = await world.directCall("dubspace-enter", actor, "the_dubspace", "enter", []);
    expect(entered.op).toBe("result");
    if (entered.op === "result") {
      expect(entered.result).toEqual([actor]);
      expect(entered.observations.map((obs) => obs.type)).toEqual(["dubspace_entered", "dubspace_activity"]);
      expect(entered.observations[0]).toMatchObject({ text: `${actorName} steps up to Dubspace.` });
      expect(entered.observations[1]).toMatchObject({ source: "the_chatroom", space: "the_dubspace", actor });
    }
    expect(world.getProp("the_dubspace", "operators")).toEqual([actor]);

    const applied = await world.call("set-control", session.id, "the_dubspace", {
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "feedback", 0.44]
    });
    expect(applied.op).toBe("applied");
    expect(world.getProp("delay_1", "feedback")).toBe(0.44);

    const preview = await world.directCall("preview", actor, "the_dubspace", "preview_control", ["delay_1", "feedback", 0.5]);
    expect(preview.op).toBe("result");
    if (preview.op === "result") {
      expect(preview.observations[0]).toMatchObject({ type: "gesture_progress", source: "the_dubspace", actor, target: "delay_1", name: "feedback", value: 0.5 });
    }
    expect(world.getProp("delay_1", "feedback")).toBe(0.44);

    await world.call("drum", session.id, "the_dubspace", { actor, target: "the_dubspace", verb: "set_drum_step", args: ["tone", 3, true] });
    await world.call("tempo", session.id, "the_dubspace", { actor, target: "the_dubspace", verb: "set_tempo", args: [250] });
    const pattern = world.getProp("drum_1", "pattern") as Record<string, boolean[]>;
    expect(pattern.tone[3]).toBe(true);
    expect(world.getProp("drum_1", "bpm")).toBe(200);

    await world.call("save", session.id, "the_dubspace", { actor, target: "the_dubspace", verb: "save_scene", args: ["Source Scene"] });
    await world.call("mutate", session.id, "the_dubspace", { actor, target: "the_dubspace", verb: "set_control", args: ["delay_1", "feedback", 0.11] });
    expect(world.getProp("delay_1", "feedback")).toBe(0.11);
    await world.call("recall", session.id, "the_dubspace", { actor, target: "the_dubspace", verb: "recall_scene", args: ["default_scene"] });
    expect(world.getProp("delay_1", "feedback")).toBe(0.44);

    const left = await world.directCall("dubspace-leave", actor, "the_dubspace", "leave", []);
    expect(left.op).toBe("result");
    if (left.op === "result") {
      expect(left.result).toEqual([]);
      expect(left.observations[0]).toMatchObject({ text: `${actorName} steps away from Dubspace.` });
    }
    expect(world.getProp("the_dubspace", "operators")).toEqual([]);
  });

  it("installs pinboard from source and keeps notes as board-contained pin objects", async () => {
    const world = createWorld({ catalogs: false });
    installHelpDependency(world);
    installCatalogManifest(world, readManifest("chat") as unknown as RuntimeCatalogManifest, {
      tap: "github:example/woo-test",
      alias: "chat",
      allowImplementationHints: false
    });
    installCatalogManifest(world, readManifest("demoworld") as unknown as RuntimeCatalogManifest, {
      tap: "github:example/woo-test",
      alias: "demoworld",
      allowImplementationHints: false
    });
    installCatalogManifest(world, readManifest("note") as unknown as RuntimeCatalogManifest, {
      tap: "github:example/woo-test",
      alias: "note",
      allowImplementationHints: false
    });
    installCatalogManifest(world, readManifest("pinboard") as unknown as RuntimeCatalogManifest, {
      tap: "github:example/woo-test",
      alias: "pinboard",
      allowImplementationHints: false
    });

    expect(world.object("$pin").parent).toBe("$note");
    expect(world.propOrNull("$pinboard", "notes")).toBeNull();
    expect(world.propOrNull("$pinboard", "layout")).toEqual({});
    expect(world.ownVerb("$pinboard", "add_note")?.kind).toBe("bytecode");
    expect(world.ownVerb("$pinboard", "enter")?.kind).toBe("bytecode");
    expect(world.object("the_pinboard").location).toBe("the_deck");
    expect(world.object("the_deck").contents.has("the_pinboard")).toBe(true);

    const session = world.auth("guest:catalog-pinboard");
    const other = world.auth("guest:catalog-pinboard-other");
    const entered = await world.directCall("pinboard-enter", session.actor, "the_pinboard", "enter", []);
    expect(entered.op).toBe("result");
    expect(world.hasPresence(session.actor, "the_pinboard")).toBe(true);
    await world.directCall("pinboard-enter-other", other.actor, "the_pinboard", "enter", []);

    const added = await world.call("pinboard-add", session.id, "the_pinboard", {
      actor: session.actor,
      target: "the_pinboard",
      verb: "add_note",
      args: ["Bring the towel to the hot tub", "blue", 12, 24, 160, 88]
    });
    expect(added.op).toBe("applied");
    if (added.op !== "applied") return;
    expect(added.observations.map((obs) => obs.type)).toEqual(["pin_added", "pinboard_activity", "note_edited", "pin_recolored", "note_added"]);
    const note = added.observations.find((obs) => obs.type === "note_added")?.note as Record<string, unknown>;
    expect(note).toMatchObject({ text: "Bring the towel to the hot tub", color: "blue", x: 12, y: 24, w: 160, h: 88 });
    const pin = String(note.id);
    expect(pin).toMatch(/^obj_/);
    expect(world.object(pin).parent).toBe("$pin");
    expect(world.object(pin).owner).toBe(session.actor);
    expect(world.object(pin).location).toBe("the_pinboard");
    expect(world.object("the_pinboard").contents.has(pin)).toBe(true);
    expect(world.getProp(pin, "text")).toEqual(["Bring the towel to the hot tub"]);
    expect(world.getProp(pin, "color")).toBe("blue");
    expect(world.propOrNull("the_pinboard", "notes")).toBeNull();
    expect(world.getProp("the_pinboard", "layout")).toMatchObject({ [pin]: { x: 12, y: 24, w: 160, h: 88 } });

    const listed = await world.directCall("pinboard-list", session.actor, "the_pinboard", "list_notes", []);
    expect(listed.op).toBe("result");
    if (listed.op === "result") {
      expect(listed.result).toEqual([expect.objectContaining({ id: pin, text: ["Bring the towel to the hot tub"], color: "blue", owner: session.actor })]);
    }

    await world.call("pinboard-take", session.id, "the_pinboard", { actor: session.actor, target: "the_pinboard", verb: "take", args: [pin] });
    expect(world.object(pin).location).toBe(session.actor);
    expect(world.object("the_pinboard").contents.has(pin)).toBe(false);
    expect(world.getProp("the_pinboard", "layout")).not.toHaveProperty(pin);

    await world.call("pinboard-post", session.id, "the_pinboard", { actor: session.actor, target: "the_pinboard", verb: "post", args: [pin] });
    expect(world.object(pin).location).toBe("the_pinboard");
    expect(world.getProp("the_pinboard", "layout")).toHaveProperty(pin);

    const deniedTake = await world.call("pinboard-take-denied", other.id, "the_pinboard", { actor: other.actor, target: "the_pinboard", verb: "take", args: [pin] });
    expect(deniedTake.op).toBe("applied");
    if (deniedTake.op === "applied") expect(deniedTake.observations.find((obs) => obs.type === "$error")?.code).toBe("E_PERM");

    const deniedEject = await world.call("pinboard-eject-denied", other.id, "the_pinboard", { actor: other.actor, target: "the_pinboard", verb: "eject", args: [pin] });
    expect(deniedEject.op).toBe("applied");
    if (deniedEject.op === "applied") expect(deniedEject.observations.find((obs) => obs.type === "$error")?.code).toBe("E_PERM");

    await world.call("pinboard-move", session.id, "the_pinboard", { actor: session.actor, target: "the_pinboard", verb: "move_pin", args: [pin, 80, 96] });
    await world.call("pinboard-edit", session.id, "the_pinboard", { actor: session.actor, target: pin, verb: "set_text", args: [["Towel is ready"]] });
    await world.call("pinboard-color", session.id, "the_pinboard", { actor: session.actor, target: pin, verb: "set_color", args: ["green"] });
    expect(world.getProp(pin, "text")).toEqual(["Towel is ready"]);
    expect(world.getProp(pin, "color")).toBe("green");
    const clearedColor = await world.call("pinboard-color-white", session.id, "the_pinboard", { actor: session.actor, target: pin, verb: "set_color", args: ["white"] });
    expect(clearedColor.op).toBe("applied");
    if (clearedColor.op === "applied") expect(clearedColor.observations.find((obs) => obs.type === "pin_recolored")?.color).toBeNull();
    expect(world.getProp(pin, "color")).toBeNull();
    expect(world.getProp("the_pinboard", "layout")).toMatchObject({ [pin]: { x: 80, y: 96 } });
  });

  it("migrates v0.1 pinboard note records into pin objects", () => {
    const world = createWorld();
    const session = world.auth("guest:pinboard-migration");
    const migrations = (world.getProp("$system", "applied_migrations") as string[]).filter((id) => id !== "2026-05-02-pinboard-notes-to-pins");
    world.setProp("$system", "applied_migrations", migrations);
    world.setProp("the_pinboard", "layout", {});
    world.setProp("the_pinboard", "notes", [
      { id: "n1", text: "Alpha\nBeta", color: "pink", x: -20, y: 30, w: 220, h: 120, z: 4, author: session.actor },
      { id: "n2", text: "Missing author", color: null, x: 60, y: 80, w: 180, h: 110, z: 5, author: "recycled_guest" }
    ]);
    world.setProp("the_pinboard", "next_note_id", 3);

    installLocalCatalogs(world, ["pinboard"]);

    const pins = Array.from(world.object("the_pinboard").contents).filter((id) => world.isDescendantOf(id, "$pin")).sort();
    expect(pins).toHaveLength(2);
    expect(world.object(pins[0]).owner).toBe(session.actor);
    expect(world.object(pins[1]).owner).toBe(world.object("the_pinboard").owner);
    expect(world.getProp(pins[0], "text")).toEqual(["Alpha", "Beta"]);
    expect(world.getProp(pins[1], "text")).toEqual(["Missing author"]);
    expect(world.getProp(pins[0], "color")).toBe("pink");
    expect(world.getProp(pins[1], "color")).toBeNull();
    expect(world.getProp("the_pinboard", "layout")).toMatchObject({
      [pins[0]]: { x: -20, y: 30, w: 220, h: 120, z: 4 },
      [pins[1]]: { x: 60, y: 80, w: 180, h: 110, z: 5 }
    });
    expect(world.propOrNull("the_pinboard", "notes")).toBeNull();
    expect(world.propOrNull("the_pinboard", "next_note_id")).toBeNull();
    expect(world.getProp("the_pinboard", "next_z")).toBeGreaterThanOrEqual(6);
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-02-pinboard-notes-to-pins");
  });

  it("repairs stale pinboard v0.1 source and leftover note records", () => {
    const world = createWorld();
    const session = world.auth("guest:pinboard-v02-repair");
    const listNotes = world.ownVerbExact("$pinboard", "list_notes")!;
    const installed = installVerb(world, "$pinboard", "list_notes", `verb :list_notes() rxd {
  return this.notes;
}`, listNotes.version);
    expect(installed.ok).toBe(true);
    const migrations = (world.getProp("$system", "applied_migrations") as string[])
      .filter((id) => id !== "2026-05-02-pinboard-v02-repair" && id !== "2026-05-02-pinboard-v02-data-repair");
    world.setProp("$system", "applied_migrations", migrations);
    world.setProp("the_pinboard", "layout", {});
    world.setProp("the_pinboard", "notes", [
      { id: "n11", text: "hello", color: "yellow", x: 4, y: 8, w: 160, h: 90, z: 7, author: session.actor, updated_by: session.actor, created_at: 1, updated_at: 2 }
    ]);

    installLocalCatalogs(world, ["pinboard"]);

    expect(world.ownVerbExact("$pinboard", "list_notes")?.source).toContain("contents(this)");
    const pins = Array.from(world.object("the_pinboard").contents).filter((id) => world.isDescendantOf(id, "$pin"));
    expect(pins).toHaveLength(1);
    expect(world.getProp(pins[0], "text")).toEqual(["hello"]);
    expect(world.propOrNull("the_pinboard", "notes")).toBeNull();
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-02-pinboard-v02-repair");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-02-pinboard-v02-data-repair");
  });

  it("reports local catalog drift and pending boot migrations without mutating", () => {
    const world = createWorld();
    const listNotes = world.ownVerbExact("$pinboard", "list_notes")!;
    const installed = installVerb(world, "$pinboard", "list_notes", `verb :list_notes() rxd {
  return this.notes;
}`, listNotes.version);
    expect(installed.ok).toBe(true);
    const migrations = (world.getProp("$system", "applied_migrations") as string[])
      .filter((id) => id !== "2026-05-02-pinboard-v02-repair" && id !== "2026-05-02-pinboard-v02-data-repair");
    world.setProp("$system", "applied_migrations", migrations);

    const status = localCatalogStatuses(world, ["pinboard"]).find((item) => item.catalog === "pinboard")!;

    expect(status.installed).toBe(true);
    expect(status.needs_repair).toBe(true);
    expect(status.pending_migrations).toEqual(expect.arrayContaining(["2026-05-02-pinboard-v02-repair", "2026-05-02-pinboard-v02-data-repair"]));
    expect(status.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "verb_drift", object: "$pinboard", verb: "list_notes" })
    ]));
    expect(world.ownVerbExact("$pinboard", "list_notes")?.source).toContain("return this.notes");
    expect(world.getProp("$system", "applied_migrations")).not.toContain("2026-05-02-pinboard-v02-repair");
  });

  it("runs local repairs for installed catalogs even when auto-install is empty", () => {
    const world = createWorld();
    const migrations = (world.getProp("$system", "applied_migrations") as string[])
      .filter((id) => ![
        "2026-05-02-pinboard-v02-repair",
        "2026-05-02-pinboard-v02-data-repair",
        "2026-05-02-chat-look-skip-presence"
      ].includes(id));
    world.setProp("$system", "applied_migrations", migrations);

    const chatLook = world.ownVerbExact("$conversational", "look")!;
    world.addVerb("$conversational", { ...chatLook, skip_presence_check: false, version: chatLook.version + 1 });
    const listNotes = world.ownVerbExact("$pinboard", "list_notes")!;
    const installed = installVerb(world, "$pinboard", "list_notes", `verb :list_notes() rxd {
  return this.notes;
}`, listNotes.version);
    expect(installed.ok).toBe(true);
    world.setProp("the_pinboard", "notes", [
      { id: "n11", text: "hello", color: "yellow", x: 4, y: 8, w: 160, h: 90, z: 7, author: "$wiz", updated_by: "$wiz" }
    ]);

    installLocalCatalogs(world, []);

    expect(world.ownVerbExact("$conversational", "look")?.skip_presence_check).toBe(true);
    expect(world.ownVerbExact("$pinboard", "list_notes")?.source).toContain("contents(this)");
    expect(world.propOrNull("the_pinboard", "notes")).toBeNull();
    expect(Array.from(world.object("the_pinboard").contents).some((id) => world.isDescendantOf(id, "$pin"))).toBe(true);
  });

  it("installs missing dependency catalogs of an already-installed catalog before repair", () => {
    const world = createWorld({ catalogs: ["chat", "demoworld", "pinboard"] });
    expect(world.objects.has("$pinboard")).toBe(true);
    // Simulate a world that long ago auto-installed catalogs before new
    // dependency edges existed.
    const registry = world.getProp("$catalog_registry", "installed_catalogs") as Array<Record<string, unknown>>;
    const trimmed = registry.filter((record) => record.alias !== "note" && record.catalog !== "note" && record.alias !== "help" && record.catalog !== "help");
    world.setProp("$catalog_registry", "installed_catalogs", trimmed as unknown as Parameters<typeof world.setProp>[2]);
    world.setProp("$system", "help_dbs", []);
    // Tear $note out of the world the way an old-deploy world that never had
    // it would look. We can't recycle: $pin descends from $note, so removing
    // by parent is unsafe. Instead, simulate the prior state by walking the
    // map directly — the test exercises the install/migrate path that should
    // restore $note as $pin's ancestor.
    const noteObj = world.objects.get("$note");
    if (noteObj) {
      const noteParent = noteObj.parent ? world.objects.get(noteObj.parent) : null;
      if (noteParent) noteParent.children.delete("$note");
      world.objects.delete("$note");
    }
    expect(world.objects.has("$note")).toBe(false);
    const migrations = (world.getProp("$system", "applied_migrations") as string[])
      .filter((id) => id !== "2026-05-02-pinboard-v02-repair");
    world.setProp("$system", "applied_migrations", migrations);

    installLocalCatalogs(world, []);

    expect(world.getProp("$system", "help_dbs")).toContain("$help");
    expect(world.getProp("$help", "topics")).toHaveProperty("commands");
    expect(world.objects.has("$note")).toBe(true);
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-02-pinboard-v02-repair");
  });

  it("runHostScopedDataMigrations migrates legacy notes that the gateway-only framework can't reach", () => {
    // The_pinboard is host_placement:"self", so its actual notes prop lives
    // on its own DO. The gateway's local copy has the post-install default
    // ([] notes), so the gateway-side data migration found nothing to do and
    // marked itself applied. This simulates the owning DO's cold init: the
    // data migration must run again locally there.
    const world = createWorld();
    expect(world.objects.has("$pin")).toBe(true);
    // Mark every gateway-side data migration applied — those represent the
    // gateway run that already finished without touching real data.
    const dataMigrationIds = ["2026-05-02-pinboard-notes-to-pins", "2026-05-02-pinboard-v02-data-repair"];
    const migrations = world.getProp("$system", "applied_migrations") as string[];
    for (const id of dataMigrationIds) if (!migrations.includes(id)) migrations.push(id);
    world.setProp("$system", "applied_migrations", migrations);
    // Plant the legacy data on the_pinboard the way the owning DO sees it.
    world.setProp("the_pinboard", "notes", [
      { id: "n1", text: "real legacy", color: "blue", x: 10, y: 20, w: 180, h: 110, z: 4, author: "$wiz", updated_by: "$wiz" }
    ]);

    runHostScopedDataMigrations(world, "the_pinboard");

    expect(world.propOrNull("the_pinboard", "notes")).toBeNull();
    const pins = Array.from(world.object("the_pinboard").contents).filter((id) => world.isDescendantOf(id, "$pin"));
    expect(pins).toHaveLength(1);
    expect(world.getProp(pins[0], "text")).toEqual(["real legacy"]);
    expect(world.getProp(pins[0], "color")).toBe("blue");
    const records = world.getProp("$system", "catalog_migration_records") as Array<Record<string, WooValue>>;
    expect(records).toContainEqual(expect.objectContaining({
      plan_id: "local-catalog-data:pinboard:2026-05-02-pinboard-notes-to-pins",
      scope: "host",
      host: "the_pinboard",
      status: "completed",
      pre_legacy_records: 1,
      post_legacy_records: 0
    }));
  });

  it("preserves live runtime properties across host-scoped schema plans", { timeout: 15000 }, () => {
    // Host schema plans reconcile class/seed metadata but seed-hook properties
    // remain initial values. They must not overwrite live state such as
    // pinboard layout entries, room exits maps, dubspace tempo/transport, etc.
    const world = createWorld();
    world.setProp("the_pinboard", "layout", { obj_pin_a: { x: 100, y: 200, w: 180, h: 110, z: 5 } });
    world.setProp("the_pinboard", "next_z", 42);
    world.setProp("the_dubspace", "tempo", 105);
    world.setProp("the_dubspace", "transport", "playing");
    const beforeExits = world.getProp("the_chatroom", "exits");

    runHostScopedLocalCatalogLifecycle(world);

    expect(world.getProp("the_pinboard", "layout")).toEqual({ obj_pin_a: { x: 100, y: 200, w: 180, h: 110, z: 5 } });
    expect(world.getProp("the_pinboard", "next_z")).toBe(42);
    expect(world.getProp("the_dubspace", "tempo")).toBe(105);
    expect(world.getProp("the_dubspace", "transport")).toBe("playing");
    expect(world.getProp("the_chatroom", "exits")).toEqual(beforeExits);
  });

  it("runHostScopedLocalCatalogLifecycle no-ops on a core-only world slice", () => {
    const world = createWorld({ catalogs: false });
    const before = world.exportWorld();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      runHostScopedLocalCatalogLifecycle(world);
      expect(world.exportWorld()).toEqual(before);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("runHostScopedLocalCatalogLifecycle applies an explicit host schema plan and records it", () => {
    const gateway = createWorld();
    const listNotes = worldVerb(gateway, "$pinboard", "list_notes");
    const installed = installVerb(gateway, "$pinboard", "list_notes", `verb :list_notes() rxd {
  return this.notes;
}`, listNotes.version);
    expect(installed.ok).toBe(true);

    const scoped = nonEmptyHostScopedWorld(gateway.exportWorld(), "the_pinboard");
    expect(scoped).not.toBeNull();
    const host = createWorldFromSerialized(scoped!, { persist: false });
    expect(worldVerb(host, "$pinboard", "list_notes").source).toContain("return this.notes");

    runHostScopedLocalCatalogLifecycle(host, "the_pinboard");

    expect(worldVerb(host, "$pinboard", "list_notes").source).toContain("contents(this)");
    const records = host.getProp("$system", "catalog_migration_records") as Array<Record<string, WooValue>>;
    expect(records).toContainEqual(expect.objectContaining({
      plan_id: expect.stringMatching(/^local-catalog-schema:pinboard:/),
      scope: "host",
      host: "the_pinboard",
      status: "completed"
    }));
  });

  it("auto-syncs local catalog schema drift without a hand-authored boot migration", () => {
    const world = createWorld();
    const listNotes = worldVerb(world, "$pinboard", "list_notes");
    const installed = installVerb(world, "$pinboard", "list_notes", `verb :list_notes() rxd {
  return this.notes;
}`, listNotes.version);
    expect(installed.ok).toBe(true);
    const layoutDef = world.object("$pinboard").propertyDefs.get("layout");
    expect(layoutDef).toBeDefined();
    world.object("$pinboard").propertyDefs.set("layout", { ...layoutDef!, perms: "rw" });
    const before = world.getProp("$system", "applied_migrations") as string[];
    expect(before.some((id) => id.startsWith("local-catalog-schema:pinboard:"))).toBe(true);

    installLocalCatalogs(world, []);

    expect(worldVerb(world, "$pinboard", "list_notes").source).toContain("contents(this)");
    expect(world.object("$pinboard").propertyDefs.get("layout")?.perms).toBe("r");
    const after = world.getProp("$system", "applied_migrations") as string[];
    expect(after.filter((id) => id.startsWith("local-catalog-schema:pinboard:"))).toHaveLength(1);
    const records = world.getProp("$system", "catalog_migration_records") as Array<Record<string, WooValue>>;
    expect(records).toContainEqual(expect.objectContaining({
      plan_id: expect.stringMatching(/^local-catalog-schema:pinboard:/),
      scope: "gateway",
      host: "world",
      status: "completed",
      steps: expect.arrayContaining([expect.objectContaining({ id: expect.stringContaining("ensure_property_def:$pinboard.layout") })])
    }));
    const registry = world.getProp("$catalog_registry", "installed_catalogs") as Array<Record<string, WooValue>>;
    const pinboard = registry.find((record) => record.alias === "pinboard");
    expect(pinboard?.provenance).toMatchObject({
      local_schema_sync: expect.stringMatching(/^local-catalog-schema:pinboard:/),
      local_manifest_hash: expect.stringMatching(/^sha256:/)
    });
  });

  it("propagates gateway auto-synced schema to an existing host slice through seed merge", () => {
    const staleGateway = createWorld();
    const listNotes = worldVerb(staleGateway, "$pinboard", "list_notes");
    const installed = installVerb(staleGateway, "$pinboard", "list_notes", `verb :list_notes() rxd {
  return this.notes;
}`, listNotes.version);
    expect(installed.ok).toBe(true);
    const staleScoped = nonEmptyHostScopedWorld(staleGateway.exportWorld(), "the_pinboard");
    expect(staleScoped).not.toBeNull();

    installLocalCatalogs(staleGateway, []);
    const repairedScoped = nonEmptyHostScopedWorld(staleGateway.exportWorld(), "the_pinboard");
    expect(repairedScoped).not.toBeNull();

    const host = createWorldFromSerialized(mergeHostScopedSeed(staleScoped!, repairedScoped!), { persist: false });
    expect(worldVerb(host, "$pinboard", "list_notes").source).toContain("contents(this)");
  });

  it("seeds the_cockatoo in the chatroom with random-pick squawk", async () => {
    const world = createWorld();
    expect(world.objects.has("$cockatoo")).toBe(true);
    expect(world.objects.has("the_cockatoo")).toBe(true);
    expect(world.object("the_cockatoo").parent).toBe("$cockatoo");
    expect(world.object("the_cockatoo").anchor).toBe("the_chatroom");
    expect(world.object("the_cockatoo").location).toBe("the_chatroom");

    const session = world.auth("guest:cockatoo");
    const phrases = world.getProp("the_cockatoo", "phrases") as string[];
    expect(phrases.length).toBeGreaterThan(0);

    // Cockatoo lives in the_chatroom; presence required to poke it
    await world.directCall("enter", session.actor, "the_chatroom", "enter", []);

    const squawk = await world.directCall("squawk", session.actor, "the_cockatoo", "squawk", []);
    expect(squawk.op).toBe("result");
    if (squawk.op === "result") {
      expect(phrases).toContain(String(squawk.result));
      expect(squawk.observations[0]).toMatchObject({ type: "cockatoo_squawk", source: "the_cockatoo", actor: session.actor });
    }

    // Persistent mutations (teach/gag/ungag) are sequenced through the chatroom
    // so they appear in the room's log and replicate as sequenced state.
    const taught = await world.call("teach", session.id, "the_chatroom", { actor: session.actor, target: "the_cockatoo", verb: "teach", args: ["world of objects"] });
    expect(taught.op).toBe("applied");
    expect((world.getProp("the_cockatoo", "phrases") as string[]).at(-1)).toBe("world of objects");

    // Non-string phrases must be rejected at the verb boundary (would otherwise
    // violate the cockatoo_squawk schema, which declares text: str).
    const badTeach = await world.call("teach-bad", session.id, "the_chatroom", { actor: session.actor, target: "the_cockatoo", verb: "teach", args: [{ not: "a string" } as unknown as string] });
    expect(badTeach.op).toBe("applied");
    if (badTeach.op === "applied") {
      const errObs = badTeach.observations.find((obs) => obs.type === "$error");
      expect(errObs?.code).toBe("E_TYPE");
    }

    await world.call("gag", session.id, "the_chatroom", { actor: session.actor, target: "the_cockatoo", verb: "gag", args: [] });
    const muffled = await world.directCall("squawk-gagged", session.actor, "the_cockatoo", "squawk", []);
    if (muffled.op === "result") {
      expect(muffled.result).toBe("*muffled noises*");
      expect(muffled.observations[0]).toMatchObject({ type: "cockatoo_muffled" });
    }

    // :look() composes room contents via :title() — the cockatoo is in
    // the_chatroom, so a looker sees it without subscribing or knowing the
    // objref ahead of time. The cockatoo overrides $root:title for flair.
    const look = await world.directCall("look", session.actor, "the_chatroom", "look", []);
    expect(look.op).toBe("result");
    if (look.op === "result") {
      const room = look.result as { contents: Array<{ id: string; title: string; description: string }> };
      expect(Array.isArray(room.contents)).toBe(true);
      const cockatooEntry = room.contents.find((item) => item.id === "the_cockatoo");
      expect(cockatooEntry).toBeDefined();
      expect(cockatooEntry?.title).toMatch(/sulphur-crested cockatoo perched on the mantelpiece, gagged/);
      expect(cockatooEntry?.description).toMatch(/sulphur-crested cockatoo/);
    }

    // $root:title default is the object's name; verify directly on a fresh
    // object so the override-vs-default distinction is pinned.
    const wizTitle = await world.directCall("wiz-title", session.actor, "$wiz", "title", []);
    expect(wizTitle.op).toBe("result");
    if (wizTitle.op === "result") expect(wizTitle.result).toBe(world.object("$wiz").name);
  });

  it("plans chat speech and object commands through the room parser", async () => {
    const world = createWorld();
    const first = world.auth("guest:chat-command-first");
    const second = world.auth("guest:chat-command-second");
    expect(world.ownVerb("$conversational", "command_plan")?.kind).toBe("bytecode");
    expect(world.ownVerb("$conversational", "command")?.kind).toBe("bytecode");
    expect(world.ownVerb("$match", "parse_command")?.kind).toBe("native");
    await world.directCall("enter-first", first.actor, "the_chatroom", "enter", []);
    await world.directCall("enter-second", second.actor, "the_chatroom", "enter", []);

    const emotePlan = await world.directCall("plan-emote", first.actor, "the_chatroom", "command_plan", [":waves"]);
    expect(emotePlan.op).toBe("result");
    if (emotePlan.op === "result") {
      expect(emotePlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "emote", args: ["waves"] });
    }

    const tellPlan = await world.directCall("plan-tell", first.actor, "the_chatroom", "command_plan", [`tell ${second.actor} psst`]);
    expect(tellPlan.op).toBe("result");
    if (tellPlan.op === "result") {
      expect(tellPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "tell", args: [second.actor, "psst"] });
    }

    const lookPlan = await world.directCall("plan-look-cockatoo", first.actor, "the_chatroom", "command_plan", ["l cock"]);
    expect(lookPlan.op).toBe("result");
    if (lookPlan.op === "result") {
      expect(lookPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "look_at", args: ["the_cockatoo"] });
      const looked = await world.directCall("look-cockatoo-command", first.actor, String((lookPlan.result as Record<string, any>).target), String((lookPlan.result as Record<string, any>).verb), (lookPlan.result as Record<string, any>).args);
      expect(looked.op).toBe("result");
      if (looked.op === "result") {
        expect(looked.observations.find((obs) => obs.type === "looked")).toMatchObject({ room: "the_chatroom", target: "the_cockatoo" });
      }
    }

    const lookMePlan = await world.directCall("plan-look-me", first.actor, "the_chatroom", "command_plan", ["look me"]);
    expect(lookMePlan.op).toBe("result");
    if (lookMePlan.op === "result") {
      expect(lookMePlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "look_at", args: [first.actor] });
    }

    const prepPlan = await world.directCall("plan-long-prep", first.actor, "the_chatroom", "command_plan", ["look cock in front of me"]);
    expect(prepPlan.op).toBe("result");
    if (prepPlan.op === "result") {
      const cmd = (prepPlan.result as Record<string, any>).cmd as Record<string, any>;
      expect(cmd).toMatchObject({ dobj: "the_cockatoo", dobjstr: "cock", prep: "in front of", iobj: first.actor, iobjstr: "me" });
    }

    const squawkPlan = await world.directCall("plan-squawk-cockatoo", first.actor, "the_chatroom", "command_plan", ["sq bird"]);
    expect(squawkPlan.op).toBe("result");
    if (squawkPlan.op === "result") {
      expect(squawkPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_cockatoo", verb: "squawk", args: [] });
    }

    const teachPlan = await world.directCall("plan-teach-cockatoo", first.actor, "the_chatroom", "command_plan", ["teach duck \"object worlds\""]);
    expect(teachPlan.op).toBe("result");
    if (teachPlan.op === "result") {
      const plan = teachPlan.result as Record<string, any>;
      expect(plan).toMatchObject({ ok: true, route: "sequenced", space: "the_chatroom", target: "the_cockatoo", verb: "teach", args: ["object worlds"] });
      const applied = await world.call("teach-cockatoo-command", first.id, String(plan.space), {
        actor: first.actor,
        target: String(plan.target),
        verb: String(plan.verb),
        args: plan.args
      });
      expect(applied.op).toBe("applied");
      expect((world.getProp("the_cockatoo", "phrases") as string[]).at(-1)).toBe("object worlds");
    }

    world.addVerb("the_cockatoo", {
      kind: "native",
      name: "preen",
      aliases: ["p*reen"],
      owner: "$wiz",
      perms: "rxd",
      arg_spec: {},
      source: "verb :preen() rxd { ... }",
      source_hash: "test-preen",
      version: 1,
      line_map: {},
      native: "describe",
      direct_callable: true
    } satisfies VerbDef);
    const middleStarPlan = await world.directCall("plan-middle-star-alias", first.actor, "the_chatroom", "command_plan", ["p bird"]);
    expect(middleStarPlan.op).toBe("result");
    if (middleStarPlan.op === "result") {
      expect(middleStarPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_cockatoo", verb: "preen", args: [] });
    }

    const override = installVerb(world, "the_chatroom", "huh", `verb :huh(text, reason) rxd {
  observe({ type: "custom_huh", source: this, actor: actor, text: text, reason: reason, ts: now() });
  return false;
}`, null);
    expect(override.ok).toBe(true);
    const huh = await world.directCall("plan-huh-override", first.actor, "the_chatroom", "command_plan", ["/doesnotexist"]);
    expect(huh.op).toBe("result");
    if (huh.op === "result") {
      expect(huh.result).toMatchObject({ ok: false, route: "huh", target: "the_chatroom", verb: "huh" });
      expect(huh.observations).toMatchObject([{ type: "custom_huh", source: "the_chatroom", actor: first.actor, text: "/doesnotexist" }]);
    }
  });

  it("supports a small multi-room chat world with stable carryable placement", async () => {
    const world = createWorld();
    const session = world.auth("guest:room-walk");
    const watcher = world.auth("guest:room-walk-watcher");

    expect(world.objects.has("the_deck")).toBe(true);
    expect(world.objects.has("the_hot_tub")).toBe(true);
    expect(world.object("$chatroom").parent).toBe("$room");
    expect(world.object("exit_living_room_southeast").parent).toBe("$exit");
    expect(world.getProp("the_chatroom", "exits")).toMatchObject({
      southeast: "exit_living_room_southeast",
      se: "exit_living_room_southeast",
      door: "exit_living_room_southeast",
      south: "exit_living_room_south",
      s: "exit_living_room_south"
    });
    expect(world.getProp("the_chatroom", "host_placement")).toBe("self");
    expect(world.getProp("the_deck", "host_placement")).toBe("self");
    expect(world.getProp("the_hot_tub", "host_placement")).toBe("self");
    expect(world.objectRoutes()).toEqual(expect.arrayContaining([
      { id: "the_chatroom", host: "the_chatroom", anchor: null },
      { id: "the_deck", host: "the_deck", anchor: null },
      { id: "the_hot_tub", host: "the_hot_tub", anchor: null }
    ]));
    expect(world.objectRoutes().find((route) => route.id === "the_lamp")).toEqual({ id: "the_lamp", host: "world", anchor: null });

    const enterRoom = await world.directCall("enter-lr", session.actor, "the_chatroom", "enter", []);
    expect(enterRoom.op).toBe("result");
    if (enterRoom.op === "result") {
      expect(enterRoom.result).toMatchObject({ room: "the_chatroom", look_deferred: true });
      expect(enterRoom.observations.map((obs) => obs.type)).toEqual(["entered"]);
      expect(enterRoom.observationAudiences?.[0]).not.toContain(session.actor);
    }
    await world.directCall("enter-lr-watcher", watcher.actor, "the_chatroom", "enter", []);
    expect(world.hasPresence(session.actor, "the_chatroom")).toBe(true);
    expect(world.object(session.actor).location).toBe("the_chatroom");

    const outsider = world.auth("guest:match-outsider");
    const leakedMatch = await world.directCall("match-outside-room", outsider.actor, "$match", "match_object", ["lamp", "the_chatroom"]);
    expect(leakedMatch.op).toBe("error");
    if (leakedMatch.op === "error") expect(leakedMatch.error.code).toBe("E_PERM");
    const leakedParse = await world.directCall("parse-outside-room", outsider.actor, "$match", "parse_command", ["look lamp", outsider.actor, "the_chatroom"]);
    expect(leakedParse.op).toBe("error");
    if (leakedParse.op === "error") expect(leakedParse.error.code).toBe("E_PERM");
    const leakedVerb = await world.directCall("match-verb-outside-room", outsider.actor, "$match", "match_verb", ["look", "the_lamp"]);
    expect(leakedVerb.op).toBe("error");
    if (leakedVerb.op === "error") expect(leakedVerb.error.code).toBe("E_PERM");

    const look = await world.directCall("look-lr", session.actor, "the_chatroom", "look", []);
    expect(look.op).toBe("result");
    if (look.op === "result") {
      const room = look.result as { contents: Array<{ id: string; title: string }> };
      expect(room.contents.map((item) => item.id)).toEqual(expect.arrayContaining(["the_couch", "the_lamp", "the_mug", "the_cockatoo"]));
      expect(room.contents.map((item) => item.id)).not.toContain(session.actor);
    }

    const takePlan = await world.directCall("plan-take-lamp", session.actor, "the_chatroom", "command_plan", ["take lamp"]);
    expect(takePlan.op).toBe("result");
    if (takePlan.op === "result") {
      expect(takePlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "take", args: ["lamp"] });
    }

    const takeLamp = await world.directCall("take-lamp", session.actor, "the_chatroom", "take", ["lamp"]);
    expect(takeLamp.op).toBe("result");
    expect(world.object("the_lamp").location).toBe(session.actor);
    expect(world.objectRoutes().find((route) => route.id === "the_lamp")).toEqual({ id: "the_lamp", host: "world", anchor: null });

    const takeCouch = await world.directCall("take-couch", session.actor, "the_chatroom", "take", ["couch"]);
    expect(takeCouch.op).toBe("error");
    if (takeCouch.op === "error") expect(takeCouch.error.code).toBe("E_PERM");
    expect(world.object("the_couch").location).toBe("the_chatroom");

    const moveCouchThroughExit = await world.directCall("exit-move-couch", session.actor, "exit_living_room_southeast", "move", ["the_couch"]);
    expect(moveCouchThroughExit.op).toBe("error");
    if (moveCouchThroughExit.op === "error") expect(moveCouchThroughExit.error.code).toBe("E_PERM");
    expect(world.object("the_couch").location).toBe("the_chatroom");

    const blockedSouth = await world.directCall("south-window", session.actor, "the_chatroom", "south", []);
    expect(blockedSouth.op).toBe("result");
    if (blockedSouth.op === "result") expect(String(blockedSouth.result)).toMatch(/plate-glass/);
    expect(world.object(session.actor).location).toBe("the_chatroom");

    const goPlan = await world.directCall("plan-se-deck", session.actor, "the_chatroom", "command_plan", ["se"]);
    expect(goPlan.op).toBe("result");
    if (goPlan.op === "result") {
      expect(goPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "southeast", args: [] });
    }

    const goDeck = await world.directCall("se-deck", session.actor, "the_chatroom", "southeast", []);
    expect(goDeck.op).toBe("result");
    if (goDeck.op === "result") {
      expect(goDeck.result).toMatchObject({ room: "the_deck", from: "the_chatroom", look_deferred: true });
      expect(goDeck.observations).toMatchObject([
        { type: "left", source: "the_chatroom", actor: session.actor, destination: "the_deck", text: `${world.object(session.actor).name} goes southeast.` },
        { type: "entered", source: "the_deck", actor: session.actor, origin: "the_chatroom", text: `${world.object(session.actor).name} has arrived.` }
      ]);
      expect(goDeck.observationAudiences?.[0]).toContain(watcher.actor);
      expect(goDeck.observationAudiences?.[0]).not.toContain(session.actor);
    }
    expect(world.hasPresence(session.actor, "the_chatroom")).toBe(false);
    expect(world.hasPresence(session.actor, "the_deck")).toBe(true);
    expect(world.object(session.actor).location).toBe("the_deck");

    const enterTubPlan = await world.directCall("plan-enter-tub", session.actor, "the_deck", "command_plan", ["enter tub"]);
    expect(enterTubPlan.op).toBe("result");
    if (enterTubPlan.op === "result") {
      expect(enterTubPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_hot_tub", verb: "enter", args: [] });
    }

    const takeTowel = await world.directCall("take-towel", session.actor, "the_deck", "take", ["towel"]);
    expect(takeTowel.op).toBe("result");
    expect(world.object("the_towel").location).toBe(session.actor);
    expect(world.objectRoutes().find((route) => route.id === "the_towel")).toEqual({ id: "the_towel", host: "world", anchor: null });

    const goTub = await world.directCall("enter-hot-tub", session.actor, "the_hot_tub", "enter", []);
    expect(goTub.op).toBe("result");
    expect(world.hasPresence(session.actor, "the_hot_tub")).toBe(true);
    expect(world.hasPresence(session.actor, "the_deck")).toBe(false);
    expect(world.object(session.actor).location).toBe("the_hot_tub");

    const dropTowel = await world.directCall("drop-towel", session.actor, "the_hot_tub", "drop", ["towel"]);
    expect(dropTowel.op).toBe("result");
    expect(world.object("the_towel").location).toBe("the_hot_tub");
    expect(world.objectRoutes().find((route) => route.id === "the_towel")).toEqual({ id: "the_towel", host: "world", anchor: null });
  });

  it("repairs stale chat room seed metadata and missing room contents", () => {
    const world = createWorld();
    world.setProp("$system", "applied_migrations", [
      "2026-04-30-source-catalog-verbs",
      "2026-04-30-catalog-placement-metadata",
      "2026-04-30-chat-cockatoo",
      "2026-04-30-chat-look-contents",
      "2026-04-30-chat-command-parser",
      "2026-04-30-dubspace-control-guards",
      "2026-04-30-room-look-self",
      "2026-05-01-chat-three-room-demo",
      "2026-05-01-chat-observation-output"
    ]);
    world.object("the_chatroom").name = "Lobby";
    world.setProp("the_chatroom", "name", "Lobby");
    world.setProp("the_chatroom", "description", "The first runnable chat room.");
    world.setProp("the_chatroom", "next_seq", 37);
    world.setProp("the_chatroom", "subscribers", ["guest_1"]);
    expect(installVerb(world, "$chatroom", "southeast", `verb :southeast() rxd {
      return this.subscribers;
    }`, null).ok).toBe(true);
    expect(installVerb(world, "$chatroom", "go", `verb :go(exit) rxd {
      return this.subscribers;
    }`, null).ok).toBe(true);
    expect(world.ownVerb("$chatroom", "southeast")).not.toBeNull();
    expect(world.ownVerb("$chatroom", "go")).not.toBeNull();
    for (const id of ["the_lamp", "the_towel", "the_mug"]) {
      const obj = world.objects.get(id);
      if (obj?.location && world.objects.has(obj.location)) world.object(obj.location).contents.delete(id);
      world.objects.delete(id);
    }

    installLocalCatalogs(world, ["chat", "demoworld"]);

    expect(world.object("the_chatroom").name).toBe("Living Room");
    expect(world.getProp("the_chatroom", "description")).toContain("bright, open living room");
    expect(world.objects.has("the_lamp")).toBe(true);
    expect(world.objects.has("the_towel")).toBe(true);
    expect(world.objects.has("the_mug")).toBe(true);
    expect(world.object("the_lamp").location).toBe("the_chatroom");
    expect(world.object("the_towel").location).toBe("the_deck");
    expect(world.object("the_mug").location).toBe("the_chatroom");
    expect(world.object("the_chatroom").contents.has("the_lamp")).toBe(true);
    expect(world.object("the_chatroom").contents.has("the_mug")).toBe(true);
    expect(world.object("the_deck").contents.has("the_towel")).toBe(true);
    expect(world.object("$chatroom").parent).toBe("$room");
    expect(world.ownVerb("$chatroom", "southeast")).toBeNull();
    expect(world.ownVerb("$chatroom", "go")).toBeNull();
    expect(world.resolveVerb("the_chatroom", "southeast").definer).toBe("$room");
    expect(world.resolveVerb("the_chatroom", "go").definer).toBe("$room");
    expect(world.object("exit_living_room_southeast").parent).toBe("$exit");
    expect(world.getProp("the_chatroom", "exits")).toMatchObject({
      southeast: "exit_living_room_southeast",
      se: "exit_living_room_southeast",
      door: "exit_living_room_southeast",
      south: "exit_living_room_south",
      s: "exit_living_room_south"
    });
    expect(world.getProp("the_chatroom", "next_seq")).toBe(37);
    expect(world.getProp("the_chatroom", "subscribers")).toEqual(["guest_1"]);
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-01-chat-room-contents-repair");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-02-chat-room-exit-model");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-02-chat-exit-privilege-repair");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-02-chat-exit-alias-repair");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-02-chat-stale-class-verbs-repair");
  });

  it("rehomes chat seed portables stranded in $nowhere", () => {
    const world = createWorld();
    world.setProp("$system", "applied_migrations", [
      "2026-04-30-source-catalog-verbs",
      "2026-04-30-catalog-placement-metadata",
      "2026-04-30-chat-cockatoo",
      "2026-04-30-chat-look-contents",
      "2026-04-30-chat-command-parser",
      "2026-04-30-dubspace-control-guards",
      "2026-04-30-room-look-self",
      "2026-05-01-chat-three-room-demo",
      "2026-05-01-chat-observation-output",
      "2026-05-01-chat-room-contents-repair",
      "2026-05-01-agent-tool-exposure-repair",
      "2026-05-01-chat-navigation-tool-exposure"
    ]);
    world.object("the_deck").contents.delete("the_towel");
    world.object("the_towel").location = "$nowhere";
    world.object("the_towel").properties.delete("home");
    world.object("$nowhere").contents.add("the_towel");

    installLocalCatalogs(world, ["chat", "demoworld"]);

    expect(world.object("the_towel").location).toBe("the_deck");
    expect(world.object("the_deck").contents.has("the_towel")).toBe(true);
    expect(world.object("$nowhere").contents.has("the_towel")).toBe(false);
    expect(world.getProp("the_towel", "home")).toBe("the_deck");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-01-chat-nowhere-portables-repair");
  });

  it("repairs stale catalog tool exposure for agent-visible taskspace and dubspace verbs", () => {
    const world = createWorld();
    world.setProp("$system", "applied_migrations", [
      "2026-04-30-source-catalog-verbs",
      "2026-04-30-catalog-placement-metadata",
      "2026-04-30-chat-cockatoo",
      "2026-04-30-chat-look-contents",
      "2026-04-30-chat-command-parser",
      "2026-04-30-dubspace-control-guards",
      "2026-04-30-room-look-self",
      "2026-05-01-chat-three-room-demo",
      "2026-05-01-chat-observation-output",
      "2026-05-01-chat-room-contents-repair"
    ]);
    const createTask = world.ownVerb("$taskspace", "create_task");
    const setControl = world.ownVerb("$dubspace", "set_control");
    expect(createTask).toBeDefined();
    expect(setControl).toBeDefined();
    if (!createTask || !setControl) return;
    world.addVerb("$taskspace", { ...createTask, tool_exposed: false, version: createTask.version + 1 });
    world.addVerb("$dubspace", { ...setControl, tool_exposed: false, version: setControl.version + 1 });

    installLocalCatalogs(world, ["chat", "taskspace", "dubspace"]);

    expect(world.ownVerb("$taskspace", "create_task")?.tool_exposed).toBe(true);
    expect(world.ownVerb("$dubspace", "set_control")?.tool_exposed).toBe(true);
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-01-agent-tool-exposure-repair");
  });

  it("migrates the cockatoo into worlds installed before it landed", { timeout: 15000 }, async () => {
    const world = createWorld();
    // Reset to before the cockatoo migration ran
    world.setProp("$system", "applied_migrations", ["2026-04-30-source-catalog-verbs", "2026-04-30-catalog-placement-metadata"]);
    // Pretend the cockatoo never existed in this world
    world.objects.delete("the_cockatoo");
    world.objects.delete("$cockatoo");
    expect(world.objects.has("$cockatoo")).toBe(false);
    expect(world.objects.has("the_cockatoo")).toBe(false);

    installLocalCatalogs(world, ["chat", "demoworld"]);

    expect(world.objects.has("$cockatoo")).toBe(true);
    expect(world.objects.has("the_cockatoo")).toBe(true);
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-04-30-chat-cockatoo");

    const session = world.auth("guest:migrated-cockatoo");
    await world.directCall("enter", session.actor, "the_chatroom", "enter", []);
    const squawk = await world.directCall("squawk", session.actor, "the_cockatoo", "squawk", []);
    expect(squawk.op).toBe("result");
  });

  it("migrates stale local catalog native verbs to current catalog implementations", async () => {
    const world = createWorld();
    world.setProp("$system", "applied_migrations", []);
    const look = world.ownVerb("$conversational", "look")!;
    world.addVerb("$conversational", {
      kind: "native",
      name: look.name,
      aliases: look.aliases,
      owner: look.owner,
      perms: look.perms,
      arg_spec: look.arg_spec,
      source: look.source,
      source_hash: look.source_hash,
      version: look.version + 1,
      line_map: look.line_map,
      native: "chat_look",
      direct_callable: look.direct_callable,
      skip_presence_check: look.skip_presence_check
    });
    const enter = world.ownVerb("$conversational", "enter")!;
    world.addVerb("$conversational", {
      kind: "native",
      name: enter.name,
      aliases: enter.aliases,
      owner: enter.owner,
      perms: enter.perms,
      arg_spec: enter.arg_spec,
      source: enter.source,
      source_hash: enter.source_hash,
      version: enter.version + 1,
      line_map: enter.line_map,
      native: "chat_enter",
      direct_callable: enter.direct_callable,
      skip_presence_check: enter.skip_presence_check
    });
    const addSubtask = world.ownVerb("$task", "add_subtask")!;
    world.addVerb("$task", {
      kind: "native",
      name: addSubtask.name,
      aliases: addSubtask.aliases,
      owner: addSubtask.owner,
      perms: addSubtask.perms,
      arg_spec: addSubtask.arg_spec,
      source: addSubtask.source,
      source_hash: addSubtask.source_hash,
      version: addSubtask.version + 1,
      line_map: addSubtask.line_map,
      native: "add_subtask",
      direct_callable: addSubtask.direct_callable,
      skip_presence_check: addSubtask.skip_presence_check
    });

    installLocalCatalogs(world, ["chat", "taskspace"]);

    const migratedEnter = world.ownVerb("$conversational", "enter");
    expect(migratedEnter?.kind).toBe("bytecode");
    expect(migratedEnter?.source).toContain("set_presence");
    const migratedLook = world.ownVerb("$conversational", "look");
    expect(migratedLook?.kind).toBe("bytecode");
    expect(migratedLook?.source).toContain("look_at");
    expect(world.ownVerb("$task", "add_subtask")?.kind).toBe("bytecode");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-04-30-source-catalog-verbs");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-04-30-catalog-placement-metadata");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-04-30-room-look-self");
    expect(world.getProp("the_taskspace", "auto_presence")).toBe(true);
    expect(world.getProp("the_taskspace", "host_placement")).toBe("self");

    const session = world.auth("guest:migrated-catalog");
    expect((await world.directCall("enter", session.actor, "the_chatroom", "enter", [])).op).toBe("result");
    const created = await world.call("create-task", session.id, "the_taskspace", {
      actor: session.actor,
      target: "the_taskspace",
      verb: "create_task",
      args: ["Migrated task", ""]
    });
    const task = created.op === "applied" ? String(created.observations[0].task) : "";
    const subtask = await world.call("add-subtask", session.id, "the_taskspace", {
      actor: session.actor,
      target: task,
      verb: "add_subtask",
      args: ["Migrated subtask", ""]
    });
    expect(subtask.op).toBe("applied");
  });

  it("repairs chat room look presence and taskspace list guards on existing installs", async () => {
    const world = createWorld();
    const migrations = (world.getProp("$system", "applied_migrations") as string[])
      .filter((id) => id !== "2026-05-02-chat-look-skip-presence" && id !== "2026-05-02-taskspace-list-tasks-guard");
    world.setProp("$system", "applied_migrations", migrations);

    const chatLook = world.ownVerbExact("$conversational", "look")!;
    world.addVerb("$conversational", { ...chatLook, skip_presence_check: false, version: chatLook.version + 1 });
    const listTasks = world.ownVerbExact("$taskspace", "list_tasks")!;
    const installed = installVerb(world, "$taskspace", "list_tasks", `verb :list_tasks() rxd {
  let out = [];
  for t in contents(this) {
    if (t.space == this) {
      out = out + [{ id: t, title: t.title, status: t.status, assignee: t.assignee, parent_task: t.parent_task }];
    }
  }
  return out;
}`, listTasks.version);
    expect(installed.ok).toBe(true);
    world.createObject({ id: "taskspace_fixture", parent: "$thing", owner: "$wiz", location: "the_taskspace" });

    installLocalCatalogs(world, ["chat", "taskspace"]);

    expect(world.ownVerbExact("$conversational", "look")?.skip_presence_check).toBe(true);
    expect(world.ownVerbExact("$taskspace", "list_tasks")?.source).toContain("isa(t, $task)");
    const session = world.auth("guest:catalog-repair-look");
    const deckLook = await world.directCall("deck-look-without-presence", session.actor, "the_deck", "look", []);
    expect(deckLook.op).toBe("result");
    const list = await world.directCall("taskspace-list-guarded", session.actor, "the_taskspace", "list_tasks", []);
    expect(list.op).toBe("result");
  });

  it("repairs stale native chat command planning on existing installs", async () => {
    const world = createWorld();
    const migrations = (world.getProp("$system", "applied_migrations") as string[])
      .filter((id) => id !== "2026-05-03-chat-command-plan-source-repair");
    world.setProp("$system", "applied_migrations", migrations);

    const commandPlan = world.ownVerbExact("$conversational", "command_plan")!;
    world.addVerb("$conversational", {
      kind: "native",
      name: commandPlan.name,
      aliases: commandPlan.aliases,
      owner: commandPlan.owner,
      perms: commandPlan.perms,
      arg_spec: commandPlan.arg_spec,
      source: commandPlan.source,
      source_hash: commandPlan.source_hash,
      version: commandPlan.version + 1,
      line_map: commandPlan.line_map,
      native: "chat_command_plan",
      direct_callable: commandPlan.direct_callable,
      skip_presence_check: commandPlan.skip_presence_check
    });

    installLocalCatalogs(world, ["chat"]);

    const repaired = world.ownVerbExact("$conversational", "command_plan");
    expect(repaired?.kind).toBe("bytecode");
    expect(repaired?.source).toContain("parse_command");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-03-chat-command-plan-source-repair");

    const session = world.auth("guest:command-plan-repair");
    await world.directCall("enter-command-plan-repair", session.actor, "the_chatroom", "enter", []);
    const plan = await world.directCall("repaired-plan", session.actor, "the_chatroom", "command_plan", ["hello after repair"]);
    expect(plan.op).toBe("result");
    if (plan.op === "result") expect(plan.result).toMatchObject({ route: "direct", target: "the_chatroom", verb: "say", args: ["hello after repair"] });
  });

  it("surfaces :title failures during room look composition", async () => {
    const world = createWorld();
    const session = world.auth("guest:title-failure");
    await world.directCall("enter", session.actor, "the_chatroom", "enter", []);
    world.createObject({ id: "bad_title_item", name: "Bad Title", parent: "$thing", owner: "$wiz", location: "the_chatroom" });
    expect(installVerb(world, "bad_title_item", "title", `verb :title() rxd {
  raise { code: "E_PERM", message: "title denied" };
}`, null).ok).toBe(true);

    const look = await world.directCall("look-title-failure", session.actor, "the_chatroom", "look", []);
    expect(look.op).toBe("error");
    if (look.op === "error") expect(look.error.code).toBe("E_PERM");
  });

  it("exposes generic catalog-derived state and object routes", async () => {
    const world = createWorld();
    const session = world.auth("guest:catalog-state");
    const state = world.state(session.actor);
    expect(state.catalogs.installed.map((record: any) => record.catalog)).toEqual(expect.arrayContaining(["chat", "dubspace", "taskspace"]));
    expect(state.spaces).toHaveProperty("the_dubspace");
    expect(state.spaces).toHaveProperty("the_taskspace");
    expect(state.spaces).toHaveProperty("the_chatroom");
    expect((state.objects.the_dubspace as any).props.auto_presence).toBe(true);
    expect((state.objects.the_dubspace as any).location).toBe("the_chatroom");
    expect((state.objects.the_dubspace as any).props.operators).toEqual([]);
    expect((state.objects.slot_1 as any).props.gain).toBe(0.75);
    expect(state.object_routes).toEqual(expect.arrayContaining([
      { id: "the_dubspace", host: "the_dubspace", anchor: null },
      { id: "slot_1", host: "the_dubspace", anchor: "the_dubspace" },
      { id: "the_taskspace", host: "the_taskspace", anchor: null }
    ]));
  });

  it("declares source for every catalog verb", async () => {
    for (const name of readdirSync(root).filter((entry) => existsSync(join(root, entry, "manifest.json")))) {
      const manifest = readManifest(name);
      const defs = [...(manifest.classes ?? []), ...(manifest.features ?? [])];
      for (const def of defs) {
        expect(def.local_name.startsWith("$")).toBe(true);
        expect(def.parent).toBeTruthy();
        for (const verb of def.verbs ?? []) {
          expect(verb.name).toBeTruthy();
          expect(verb.source).toContain("verb");
        }
      }
    }
  });
});
