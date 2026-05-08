import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installVerb } from "../src/core/authoring";
import { createWorld, createWorldFromSerialized, mergeHostScopedSeed, nonEmptyHostScopedWorld } from "../src/core/bootstrap";
import { applyCatalogSchemaPlan, installCatalogManifest, planCatalogSchemaMigration, updateCatalogManifest, type CatalogManifest as RuntimeCatalogManifest } from "../src/core/catalog-installer";
import { bundledCatalogAliases, installLocalCatalogs, localCatalogStatuses, runHostScopedDataMigrations, runHostScopedLocalCatalogLifecycle } from "../src/core/local-catalogs";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, Message, VerbDef, WooValue } from "../src/core/types";

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

async function callInDubspace(
  world: ReturnType<typeof createWorld>,
  sessionId: string,
  requestId: string,
  request: Message
): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
  const sessionActor = world.sessions.get(sessionId)?.actor;
  if (sessionActor !== request.actor) {
    return world.call(requestId, sessionId, "the_dubspace", request);
  }
  if (!world.hasPresence(sessionActor, "the_dubspace")) {
    const entered = await world.directCall(`enter-${requestId}`, sessionActor, "the_dubspace", "enter", []);
    if (entered.op === "error") return entered;
  }

  let verb;
  try {
    ({ verb } = world.resolveVerb(request.target, request.verb));
  } catch {
    return world.call(requestId, sessionId, "the_dubspace", request);
  }
  if (request.target === "the_dubspace" && verb.direct_callable === true && typeof verb.perms === "string" && verb.perms.includes("x")) {
    return world.directCall(requestId, request.actor, request.target, request.verb, request.args);
  }

  return world.call(requestId, sessionId, "the_dubspace", request);
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
    const dubspace = readManifest("dubspace");
    const pinboard = readManifest("pinboard");
    const tasks = readManifest("tasks");
    expect(chat.depends).toEqual(["@local:help"]);
    expect(dubspace.depends).toEqual(["@local:chat", "@local:demoworld"]);
    expect(dubspace.seed_hooks).toContainEqual({ kind: "attach_feature", consumer: "the_dubspace", feature: "chat:$transparent" });
    expect(pinboard.depends).toEqual(["@local:chat", "@local:note", "@local:demoworld"]);
    expect(pinboard.seed_hooks).toContainEqual({ kind: "attach_feature", consumer: "the_pinboard", feature: "chat:$transparent" });
    expect(tasks.depends).toEqual(["@local:chat", "@local:note"]);
    expect(tasks.seed_hooks).toContainEqual({ kind: "attach_feature", consumer: "the_taskboard", feature: "chat:$transparent" });
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

  it("refreshes verb arg_spec and aliases on existing verbs without source repair", async () => {
    const world = createWorld({ catalogs: false });
    const source = "verb :poke() rxd {\n  return \"pong\";\n}";
    world.createObject({ id: "$metadata_probe", name: "$metadata_probe", parent: "$thing", owner: "$wiz" });
    expect(installVerb(world, "$metadata_probe", "poke", source, null).ok).toBe(true);
    const before = worldVerb(world, "$metadata_probe", "poke");
    expect(before.aliases).toEqual([]);
    expect(before.arg_spec.command).toBeUndefined();

    const manifest: RuntimeCatalogManifest = {
      name: "metadata-demo",
      version: "1.0.0",
      spec_version: "v1",
      classes: [
        {
          local_name: "$metadata_probe",
          parent: "$thing",
          verbs: [
            {
              name: "poke",
              aliases: ["p*oke", "jab"],
              source,
              arg_spec: {
                command: {
                  dobj: "none",
                  args_from: ["argstr"]
                }
              }
            }
          ]
        }
      ]
    };

    installCatalogManifest(world, manifest, { tap: "@local", alias: "metadata-demo", adoptExisting: true });

    const after = worldVerb(world, "$metadata_probe", "poke");
    expect(after.source).toBe(source);
    expect(after.version).toBe(before.version);
    expect(after.aliases).toEqual(["p*oke", "jab"]);
    expect(after.arg_spec).toEqual({
      command: {
        dobj: "none",
        args_from: ["argstr"]
      }
    });
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

  it("$note migration v1.0.0 → v2.0.0 drops :title and :delete from the installed class", async () => {
    const world = createWorld({ catalogs: false });

    // Synthetic v1.0.0 $note carrying the v1 verbs that v2 dropped. We only
    // assert that the migration removes :title and :delete; class shape and
    // dependency wiring are not under test here.
    const v1: RuntimeCatalogManifest = {
      name: "note",
      version: "1.0.0",
      spec_version: "v1",
      classes: [
        {
          local_name: "$note",
          parent: "$thing",
          properties: [{ name: "text", type: "str", default: "" }],
          verbs: [
            {
              name: "title",
              perms: "rxd",
              direct_callable: true,
              skip_presence_check: true,
              arg_spec: { args: [] },
              source: "verb :title() rxd { return this.name; }"
            },
            {
              name: "delete",
              perms: "rx",
              arg_spec: { args: ["line"] },
              source: "verb :delete(line) rx { return true; }"
            }
          ]
        }
      ]
    };
    installCatalogManifest(world, v1, { tap: "@local", alias: "note" });
    expect(world.ownVerbExact("$note", "title")).toBeDefined();
    expect(world.ownVerbExact("$note", "delete")).toBeDefined();

    // Apply the on-disk migration manifest as the catalog updates to v2.
    // The v2 manifest passed here is a minimal shell — the assertion is on
    // the migration's drop_verb steps, not on full v2 catalog reinstall.
    const migration = JSON.parse(
      readFileSync(join(root, "note", "migration-v1-to-v2.json"), "utf8")
    ) as { from_version: string; to_version: string; spec_version: string; steps: unknown[] };

    const v2: RuntimeCatalogManifest = {
      name: "note",
      version: "2.0.0",
      spec_version: "v1",
      classes: [
        {
          local_name: "$note",
          parent: "$thing",
          properties: [{ name: "text", type: "str", default: "" }]
        }
      ]
    };
    updateCatalogManifest(world, v2, {
      tap: "@local",
      alias: "note",
      acceptMajor: true,
      migration: migration as NonNullable<Parameters<typeof updateCatalogManifest>[2]>["migration"]
    });

    expect(world.ownVerbExact("$note", "title")).toBeNull();
    expect(world.ownVerbExact("$note", "delete")).toBeNull();
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
    expect(world.ownVerb("$dubspace", "out")?.kind).toBe("bytecode");
    expect(world.verbInfo("the_dubspace", "say").definer).toBe("$transparent");

    const session = world.auth("guest:catalog-dubspace");
    const actor = session.actor;
    const actorName = String(world.getProp(actor, "name"));
    const entered = await world.directCall("dubspace-enter", actor, "the_dubspace", "enter", []);
    expect(entered.op).toBe("result");
    if (entered.op === "result") {
      expect(entered.result).toMatchObject({ room: "the_dubspace", operators: [actor], look_deferred: true });
      expect(entered.observations.map((obs) => obs.type)).toEqual(["dubspace_entered", "dubspace_activity"]);
      expect(entered.observations[0]).toMatchObject({ text: `${actorName} steps up to Dubspace.` });
      expect(entered.observations[1]).toMatchObject({ source: "the_chatroom", space: "the_dubspace", actor });
    }
    expect(world.getProp("the_dubspace", "operators")).toEqual([actor]);

    const applied = await callInDubspace(world, session.id, "set-control", {
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

    // In source-only mode native implementation hints are deliberately not
    // trusted, so the shared native command planner is not available here.
    // Direct woocode behavior still needs to work.
    const directedFiltered = await world.directCall("dubspace-directed-filter", actor, "filter_1", "on_say_to", ["650"]);
    expect(directedFiltered.op).toBe("result");
    if (directedFiltered.op === "result") {
      expect(directedFiltered.observations).toContainEqual(expect.objectContaining({ type: "control_changed", target: "filter_1", name: "cutoff", value: 650 }));
    }
    expect(world.getProp("filter_1", "cutoff")).toBe(650);

    const filtered = await world.directCall("dubspace-filter", actor, "filter_1", "on_say_to", ["500"]);
    expect(filtered.op).toBe("result");
    if (filtered.op === "result") {
      expect(filtered.observations).toContainEqual(expect.objectContaining({ type: "control_changed", target: "filter_1", name: "cutoff", value: 500 }));
    }
    expect(world.getProp("filter_1", "cutoff")).toBe(500);

    const bpmChanged = await callInDubspace(world, session.id, "bpm", { actor, target: "the_dubspace", verb: "set_tempo", args: [142] });
    expect(bpmChanged.op).toBe("applied");
    if (bpmChanged.op === "applied") {
      expect(bpmChanged.observations[0]).toMatchObject({ type: "tempo_changed", target: "drum_1", bpm: 142 });
    }
    expect(world.getProp("drum_1", "bpm")).toBe(142);

    const drumChanged = await callInDubspace(world, session.id, "drum", { actor, target: "the_dubspace", verb: "set_drum_step", args: ["tone", 3, true] });
    expect(drumChanged.op).toBe("applied");
    if (drumChanged.op === "applied") {
      expect(drumChanged.observations[0]).toMatchObject({ type: "drum_step_changed", target: "drum_1", voice: "tone", step: 3, enabled: true });
      expect((drumChanged.observations[0] as any).pattern.tone[3]).toBe(true);
    }
    await callInDubspace(world, session.id, "tempo", { actor, target: "the_dubspace", verb: "set_tempo", args: [250] });
    const pattern = world.getProp("drum_1", "pattern") as Record<string, boolean[]>;
    expect(pattern.tone[3]).toBe(true);
    expect(world.getProp("drum_1", "bpm")).toBe(200);

    await callInDubspace(world, session.id, "save", { actor, target: "the_dubspace", verb: "save_scene", args: ["Source Scene"] });
    await callInDubspace(world, session.id, "mutate", { actor, target: "the_dubspace", verb: "set_control", args: ["delay_1", "feedback", 0.11] });
    expect(world.getProp("delay_1", "feedback")).toBe(0.11);
    const recalled = await callInDubspace(world, session.id, "recall", { actor, target: "the_dubspace", verb: "recall_scene", args: ["default_scene"] });
    expect(recalled.op).toBe("applied");
    if (recalled.op === "applied") expect(recalled.observations[0]).toMatchObject({ type: "scene_recalled", scene: "default_scene", controls: { delay_1: { feedback: 0.44 } } });
    expect(world.getProp("delay_1", "feedback")).toBe(0.44);

    const left = await world.directCall("dubspace-out", actor, "the_dubspace", "out", []);
    expect(left.op).toBe("result");
    if (left.op === "result") {
      expect(left.result).toMatchObject({ room: "the_chatroom", operators: [], here_request: true, here: { id: "the_chatroom" } });
      expect(left.observations[0]).toMatchObject({ text: `${actorName} steps away from Dubspace.` });
    }
    expect(world.getProp("the_dubspace", "operators")).toEqual([]);
  });

  it("installs tasks from source without trusted implementation hints and walks the obligation cursor", async () => {
    const world = createWorld({ catalogs: false });
    installHelpDependency(world);
    installCatalogManifest(world, readManifest("chat") as unknown as RuntimeCatalogManifest, {
      tap: "github:example/woo-test",
      alias: "chat",
      allowImplementationHints: false
    });
    installCatalogManifest(world, readManifest("note") as unknown as RuntimeCatalogManifest, {
      tap: "github:example/woo-test",
      alias: "note",
      allowImplementationHints: false
    });
    installCatalogManifest(world, readManifest("tasks") as unknown as RuntimeCatalogManifest, {
      tap: "github:example/woo-test",
      alias: "tasks",
      allowImplementationHints: false
    });

    expect(world.ownVerb("$task_registry", "create_task")?.kind).toBe("bytecode");
    expect(world.ownVerb("$task_registry", "seed_minimal_policy")?.kind).toBe("bytecode");
    expect(world.ownVerb("$task", "claim")?.kind).toBe("bytecode");
    expect(world.ownVerb("$task", "pass")?.kind).toBe("bytecode");
    expect(world.ownVerb("$task", "release")?.kind).toBe("bytecode");
    expect(world.isDescendantOf("the_taskboard", "$task_registry")).toBe(true);

    const session = world.auth("guest:catalog-tasks");
    const seeded = await world.directCall("seed", "$wiz", "the_taskboard", "seed_minimal_policy", [session.actor], { forceDirect: true, forceReason: "test" });
    expect(seeded.op).toBe("result");

    const created = await world.directCall("create", session.actor, "the_taskboard", "create_task", ["task", "Source-only smoke", "first body", [], null], { forceDirect: true, forceReason: "test" });
    expect(created.op).toBe("result");
    const taskRef = created.op === "result" ? String(created.result) : "";
    expect(world.isDescendantOf(taskRef, "$note")).toBe(true);
    expect(world.getProp(taskRef, "registry")).toBe("the_taskboard");

    const claimed = await world.directCall("claim", session.actor, taskRef, "claim", [], { forceDirect: true, forceReason: "test" });
    expect(claimed.op).toBe("result");
    if (claimed.op === "result") {
      expect(claimed.observations.some((obs) => obs.type === "task_claimed")).toBe(true);
    }
    expect(world.object(taskRef).location).toBe(session.actor);

    const passed = await world.directCall("pass", session.actor, taskRef, "pass", [{ note: "done" }], { forceDirect: true, forceReason: "test" });
    expect(passed.op).toBe("result");
    if (passed.op === "result") {
      const types = passed.observations.map((obs) => obs.type);
      expect(types).toContain("task_passed");
      // Single-obligation policy completes on first pass; release fires automatically.
      expect(types).toContain("task_released");
    }
    expect(world.object(taskRef).location).toBe("the_taskboard");
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
    expect(world.object(session.actor).location).toBe("the_pinboard");
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
    expect(world.getProp(pin, "text")).toBe("Bring the towel to the hot tub");
    expect(world.getProp(pin, "color")).toBe("blue");
    expect(world.propOrNull("the_pinboard", "notes")).toBeNull();
    expect(world.getProp("the_pinboard", "layout")).toMatchObject({ [pin]: { x: 12, y: 24, w: 160, h: 88 } });

    const listed = await world.directCall("pinboard-list", session.actor, "the_pinboard", "list_notes", []);
    expect(listed.op).toBe("result");
    if (listed.op === "result") {
      expect(listed.result).toEqual([expect.objectContaining({ id: pin, text: "Bring the towel to the hot tub", color: "blue", owner: session.actor })]);
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
    await world.call("pinboard-edit", session.id, "the_pinboard", { actor: session.actor, target: pin, verb: "set_text", args: ["Towel is ready"] });
    await world.call("pinboard-color", session.id, "the_pinboard", { actor: session.actor, target: pin, verb: "set_color", args: ["green"] });
    expect(world.getProp(pin, "text")).toBe("Towel is ready");
    expect(world.getProp(pin, "color")).toBe("green");
    const clearedColor = await world.call("pinboard-color-white", session.id, "the_pinboard", { actor: session.actor, target: pin, verb: "set_color", args: ["white"] });
    expect(clearedColor.op).toBe("applied");
    if (clearedColor.op === "applied") expect(clearedColor.observations.find((obs) => obs.type === "pin_recolored")?.color).toBeNull();
    expect(world.getProp(pin, "color")).toBeNull();
    expect(world.getProp("the_pinboard", "layout")).toMatchObject({ [pin]: { x: 80, y: 96 } });
  });

  it("plans pinboard chat commands against the current board space", async () => {
    const world = createWorld({ catalogs: false });
    installLocalCatalogs(world, ["pinboard"]);

    const session = world.auth("guest:catalog-pinboard-chat");
    const entered = await world.directCall("pinboard-chat-enter", session.actor, "the_pinboard", "enter", []);
    expect(entered.op).toBe("result");
    expect(world.object(session.actor).location).toBe("the_pinboard");

    const added = await world.call("pinboard-chat-add", session.id, "the_pinboard", {
      actor: session.actor,
      target: "the_pinboard",
      verb: "add_note",
      args: ["Bring the towel to the hot tub", "gray", 12, 24, 160, 88]
    });
    expect(added.op).toBe("applied");
    if (added.op !== "applied") return;
    const note = added.observations.find((obs) => obs.type === "note_added")?.note as Record<string, unknown>;
    const pin = String(note.id);

    expect(world.verbInfo("the_pinboard", "say").definer).toBe("$transparent");
    const sayPlan = await world.directCall("pinboard-say-plan", session.actor, "the_pinboard", "command_plan", ["say hello board"]);
    expect(sayPlan.op).toBe("result");
    if (sayPlan.op === "result") {
      expect(sayPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_pinboard", verb: "say", args: ["hello board"] });
    }

    const lookPlan = await world.directCall("pinboard-look-plan", session.actor, "the_pinboard", "command_plan", ["look"]);
    expect(lookPlan.op).toBe("result");
    if (lookPlan.op === "result") {
      expect(lookPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_pinboard", verb: "look", args: [] });
    }
    const looked = await world.directCall("pinboard-look", session.actor, "the_pinboard", "look", []);
    expect(looked.op).toBe("result");
    if (looked.op === "result") {
      expect(looked.result).toMatchObject({ note_count: 1, summary: "Pinboard has 1 note on it." });
      expect(looked.observations).toContainEqual(expect.objectContaining({ type: "looked", room: "the_pinboard", text: "Pinboard has 1 note on it." }));
    }

    const outPlan = await world.directCall("pinboard-out-plan", session.actor, "the_pinboard", "command_plan", ["out"]);
    expect(outPlan.op).toBe("result");
    if (outPlan.op === "result") {
      expect(outPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_pinboard", verb: "out", args: [] });
    }

    const bareEnterPlan = await world.directCall("pinboard-bare-enter-plan", session.actor, "the_pinboard", "command_plan", ["enter"]);
    expect(bareEnterPlan.op).toBe("result");
    if (bareEnterPlan.op === "result") {
      expect(bareEnterPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_pinboard", verb: "enter", args: [] });
    }

    const takePlan = await world.directCall("pinboard-take-plan", session.actor, "the_pinboard", "command_plan", ["take towel"]);
    expect(takePlan.op).toBe("result");
    if (takePlan.op === "result") {
      expect(takePlan.result).toMatchObject({ ok: true, route: "sequenced", space: "the_pinboard", target: "the_pinboard", verb: "take", args: [pin] });
    }
    const typedTake = await world.command("pinboard-chat-take", session.id, "the_pinboard", "take towel");
    expect(typedTake.op).toBe("applied");
    expect(world.object(pin).location).toBe(session.actor);

    const dropPlan = await world.directCall("pinboard-drop-plan", session.actor, "the_pinboard", "command_plan", ["drop towel"]);
    expect(dropPlan.op).toBe("result");
    if (dropPlan.op === "result") {
      expect(dropPlan.result).toMatchObject({ ok: true, route: "sequenced", space: "the_pinboard", target: "the_pinboard", verb: "drop", args: [pin] });
    }
    const typedDrop = await world.command("pinboard-drop-command", session.id, "the_pinboard", "drop towel");
    expect(typedDrop.op).toBe("applied");
    expect(world.object(pin).location).toBe("the_pinboard");
    expect(world.getProp("the_pinboard", "layout")).toHaveProperty(pin);

    const rejectedDrop = await world.call("pinboard-drop-not-carried", session.id, "the_pinboard", { actor: session.actor, target: "the_pinboard", verb: "drop", args: [pin] });
    expect(rejectedDrop.op).toBe("applied");
    if (rejectedDrop.op === "applied") expect(rejectedDrop.observations.find((obs) => obs.type === "$error")?.code).toBe("E_INVARG");

    const deckTowel = "pinboard_deck_towel";
    world.createObject({ id: deckTowel, parent: "$thing", name: "towel", owner: session.actor, location: "the_deck" });
    const rejectedDeckDrop = await world.call("pinboard-drop-deck-towel", session.id, "the_pinboard", { actor: session.actor, target: "the_pinboard", verb: "drop", args: [deckTowel] });
    expect(rejectedDeckDrop.op).toBe("applied");
    if (rejectedDeckDrop.op === "applied") {
      expect(rejectedDeckDrop.observations.find((obs) => obs.type === "$error")).toMatchObject({
        code: "E_INVARG",
        message: `You are not carrying ${deckTowel}.`
      });
    }

    const left = await world.directCall("pinboard-out", session.actor, "the_pinboard", "out", []);
    expect(left.op).toBe("result");
    expect(world.object(session.actor).location).toBe("the_deck");
    expect(world.hasPresence(session.actor, "the_pinboard")).toBe(false);
    expect(world.hasPresence(session.actor, "the_deck")).toBe(true);

    const stranded = world.auth("guest:pinboard-nowhere-fallback");
    await world.directCall("pinboard-enter-stranded", stranded.actor, "the_pinboard", "enter", []);
    world.setProp(stranded.actor, "home", null);
    world.setProp("the_pinboard", "mount_room", null);
    const fallbackLeave = await world.directCall("pinboard-leave-stranded", stranded.actor, "the_pinboard", "leave", []);
    expect(fallbackLeave.op).toBe("result");
    expect(world.object(stranded.actor).location).toBe("$nowhere");
    expect(world.hasPresence(stranded.actor, "the_pinboard")).toBe(false);
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
    expect(world.getProp(pins[0], "text")).toBe("Alpha\nBeta");
    expect(world.getProp(pins[1], "text")).toBe("Missing author");
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

  it("lets room commands distinguish and inspect notes by body content, color, and name", async () => {
    const world = createWorld();
    const session = world.auth("guest:sticky-room-notes");
    await world.directCall("enter-hot-tub-sticky", session.actor, "the_hot_tub", "enter", []);

    world.createObject({ id: "sticky_alpha", name: "sticky note", parent: "$pin", owner: session.actor, location: "the_hot_tub", anchor: "the_pinboard" });
    world.createObject({ id: "sticky_beta", name: "sticky note", parent: "$pin", owner: session.actor, location: "the_hot_tub", anchor: "the_pinboard" });
    world.createObject({ id: "sticky_blue", name: "sticky note", parent: "$pin", owner: session.actor, location: "the_hot_tub", anchor: "the_pinboard" });
    world.createObject({ id: "sticky_secret", name: "private note", parent: "$pin", owner: session.actor, location: "the_hot_tub", anchor: "the_pinboard" });
    world.setProp("sticky_alpha", "text", "another one");
    world.setProp("sticky_beta", "text", "this is it");
    world.setProp("sticky_blue", "text", "hello");
    world.setProp("sticky_blue", "color", "blue");
    world.setProp("sticky_secret", "text", "nuclear codes");
    expect(installVerb(world, "sticky_secret", "is_readable_by", `verb :is_readable_by(actor_obj) rxd {
  return actor_obj == this.owner;
}`, null).ok).toBe(true);

    // Three pins share the name "sticky note", so a bare name lookup is ambiguous.
    const ambiguous = await world.directCall("take-sticky-ambiguous", session.actor, "the_hot_tub", "take", ["note"]);
    expect(ambiguous.op).toBe("error");
    if (ambiguous.op === "error") expect(ambiguous.error.code).toBe("E_AMBIGUOUS");

    // The matcher reads each readable note's body line-by-line as match candidates,
    // so a noun phrase from the body still resolves uniquely.
    const takeByContainedBody = await world.directCall("take-sticky-alpha", session.actor, "the_hot_tub", "take", ["another"]);
    expect(takeByContainedBody.op).toBe("result");
    expect(world.object("sticky_alpha").location).toBe(session.actor);
    await world.directCall("drop-sticky-alpha", session.actor, "the_hot_tub", "drop", ["another"]);
    expect(world.object("sticky_alpha").location).toBe("the_hot_tub");

    const takeByBody = await world.directCall("take-sticky-blue-text", session.actor, "the_hot_tub", "take", ["hello"]);
    expect(takeByBody.op).toBe("result");
    expect(world.object("sticky_blue").location).toBe(session.actor);
    await world.directCall("drop-sticky-blue", session.actor, "the_hot_tub", "drop", ["the blue note"]);
    expect(world.object("sticky_blue").location).toBe("the_hot_tub");

    const takeByColor = await world.directCall("take-sticky-blue-color", session.actor, "the_hot_tub", "take", ["the blue note"]);
    expect(takeByColor.op).toBe("result");
    expect(world.object("sticky_blue").location).toBe(session.actor);
    await world.directCall("drop-sticky-blue-again", session.actor, "the_hot_tub", "drop", ["blue note"]);
    expect(world.object("sticky_blue").location).toBe("the_hot_tub");

    const outsider = world.auth("guest:sticky-room-note-outsider");
    await world.directCall("enter-hot-tub-sticky-outsider", outsider.actor, "the_hot_tub", "enter", []);
    // Outsider can't read the note's text, so the chat planner routes the
    // take to the room and `room_take`'s own contents-only match throws
    // `I don't see "nuclear codes" here.`
    const privateTextMatch = await world.directCall("take-private-note-text", outsider.actor, "the_hot_tub", "command_plan", ["take nuclear codes"]);
    expect(privateTextMatch.op).toBe("result");
    if (privateTextMatch.op === "result") {
      expect(privateTextMatch.result).toMatchObject({ ok: true, route: "direct", target: "the_hot_tub", verb: "take", args: ["nuclear codes"] });
    }
    const privateTextTake = await world.call("take-private-note-text-call", outsider.id, "the_hot_tub", { actor: outsider.actor, target: "the_hot_tub", verb: "take", args: ["nuclear codes"] });
    expect(privateTextTake.op).toBe("applied");
    if (privateTextTake.op === "applied") {
      const err = privateTextTake.observations.find((obs) => obs.type === "$error");
      expect(err?.code).toBe("E_INVARG");
    }
  });

  it("$note exposes LambdaMOO write/erase facades, an add_writer/rm_writer pair, and bounds text at 262144 chars", async () => {
    const world = createWorld();
    const owner = world.auth("guest:note-write-owner");
    const collaborator = world.auth("guest:note-write-collab");
    const stranger = world.auth("guest:note-write-stranger");
    const noteId = "obj_test_note_write";
    world.createObject({ id: noteId, parent: "$note", owner: owner.actor, location: "the_deck" });
    await world.directCall("note-write-enter-owner", owner.actor, "the_deck", "enter", []);
    await world.directCall("note-write-enter-collab", collaborator.actor, "the_deck", "enter", []);
    await world.directCall("note-write-enter-stranger", stranger.actor, "the_deck", "enter", []);
    const call = (id: string, sess: { id: string }, actor: string, verb: string, args: WooValue[]) =>
      world.call(id, sess.id, "the_deck", { actor, target: noteId, verb, args });
    const observationsError = (frame: { op: "applied"; observations: { type?: string; code?: string }[] } | unknown): string | null => {
      if (typeof frame !== "object" || frame === null) return null;
      const f = frame as { op?: string; observations?: { type?: string; code?: string }[] };
      if (f.op !== "applied") return null;
      return f.observations?.find((obs) => obs?.type === "$error")?.code ?? null;
    };

    // :write appends a line; :erase clears; :set_text replaces.
    const written = await call("note-write-1", owner, owner.actor, "write", ["alpha"]);
    expect(written.op).toBe("applied");
    expect(observationsError(written)).toBeNull();
    expect(world.getProp(noteId, "text")).toBe("alpha");
    await call("note-write-2", owner, owner.actor, "write", ["beta"]);
    expect(world.getProp(noteId, "text")).toBe("alpha\nbeta");
    await call("note-erase", owner, owner.actor, "erase", []);
    expect(world.getProp(noteId, "text")).toBe("");
    await call("note-set", owner, owner.actor, "set_text", ["just-one-line"]);
    expect(world.getProp(noteId, "text")).toBe("just-one-line");

    // The 262144-char cap rejects oversize text on both :set_text and :write.
    const huge = "x".repeat(270_000);
    const oversize = await call("note-set-huge", owner, owner.actor, "set_text", [huge]);
    expect(observationsError(oversize)).toBe("E_INVARG");
    expect(world.getProp(noteId, "text")).toBe("just-one-line");
    await call("note-fill", owner, owner.actor, "set_text", ["x".repeat(260_000)]);
    const overflowAppend = await call("note-write-overflow", owner, owner.actor, "write", ["y".repeat(5_000)]);
    expect(observationsError(overflowAppend)).toBe("E_INVARG");
    expect(world.getProp(noteId, "text")).toBe("x".repeat(260_000));

    // Writers list management is owner-or-wizard gated.
    expect(world.getProp(noteId, "writers")).toEqual([]);
    const denied = await call("note-add-writer-denied", stranger, stranger.actor, "add_writer", [collaborator.actor]);
    expect(observationsError(denied)).toBe("E_PERM");
    const added = await call("note-add-writer", owner, owner.actor, "add_writer", [collaborator.actor]);
    expect(observationsError(added)).toBeNull();
    expect(added.op === "applied" ? added.observations : []).toContainEqual(expect.objectContaining({
      type: "note_writers_changed",
      note: noteId,
      writers: [collaborator.actor],
      added: collaborator.actor,
      removed: null
    }));
    expect(world.getProp(noteId, "writers")).toEqual([collaborator.actor]);
    // Idempotent: re-adding is a no-op (and still returns the writers list).
    const added2 = await call("note-add-writer-2", owner, owner.actor, "add_writer", [collaborator.actor]);
    expect(observationsError(added2)).toBeNull();
    expect(world.getProp(noteId, "writers")).toEqual([collaborator.actor]);
    // The collaborator can now write through :is_writable_by.
    await call("note-collab-write", collaborator, collaborator.actor, "write", ["from-collab"]);
    expect(world.getProp(noteId, "text")).toBe("x".repeat(260_000) + "\nfrom-collab");
    // Strangers still cannot.
    const strangerWrite = await call("note-stranger-write", stranger, stranger.actor, "write", ["nope"]);
    expect(observationsError(strangerWrite)).toBe("E_PERM");
    // rm_writer removes the writer; the collaborator can no longer write.
    const removed = await call("note-rm-writer", owner, owner.actor, "rm_writer", [collaborator.actor]);
    expect(removed.op === "applied" ? removed.observations : []).toContainEqual(expect.objectContaining({
      type: "note_writers_changed",
      note: noteId,
      writers: [],
      added: null,
      removed: collaborator.actor
    }));
    expect(world.getProp(noteId, "writers")).toEqual([]);
    const collabBlocked = await call("note-collab-blocked", collaborator, collaborator.actor, "write", ["x"]);
    expect(observationsError(collabBlocked)).toBe("E_PERM");
  });

  it("$note v0.2 boot migration converts list<str> text values to a joined string", () => {
    const world = createWorld();
    // Pretend an upgraded world with a $note-descended pin carrying v0.1 shape
    // text and the new migration tag missing.
    const migrations = (world.getProp("$system", "applied_migrations") as string[]).filter(
      (id) => id !== "2026-05-06-note-text-string-shape"
    );
    world.setProp("$system", "applied_migrations", migrations);
    const noteId = "obj_test_v01_note";
    world.createObject({ id: noteId, parent: "$pin", owner: "$wiz", location: "the_pinboard" });
    world.setProp(noteId, "text", ["line one", "line two", "line three"] as unknown as WooValue);

    installLocalCatalogs(world, ["pinboard"]);

    expect(world.getProp(noteId, "text")).toBe("line one\nline two\nline three");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-06-note-text-string-shape");
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
    expect(world.getProp(pins[0], "text")).toBe("hello");
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
    expect(world.getProp(pins[0], "text")).toBe("real legacy");
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

  it("preserves live runtime properties across host-scoped schema plans", { timeout: 30000 }, () => {
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

  it("records clean host schema plans without applying seed repairs", { timeout: 15000 }, () => {
    const gateway = createWorld();
    const scoped = nonEmptyHostScopedWorld(gateway.exportWorld(), "the_hot_tub");
    expect(scoped).not.toBeNull();
    const host = createWorldFromSerialized(scoped!, { persist: false });
    const writes: string[] = [];
    const setProp = host.setProp.bind(host);
    host.setProp = ((objRef, name, value) => {
      writes.push(`${objRef}.${name}`);
      return setProp(objRef, name, value);
    }) as typeof host.setProp;
    const metrics: any[] = [];
    host.setMetricsHook((event) => metrics.push(event));

    runHostScopedLocalCatalogLifecycle(host, "the_hot_tub");

    expect(writes.filter((target) => target !== "$system.catalog_migration_records")).toEqual([]);
    expect(metrics).toContainEqual(expect.objectContaining({ kind: "host_schema_sync", host: "the_hot_tub", planned: 0 }));
    const records = (host.getProp("$system", "catalog_migration_records") as Array<Record<string, WooValue>>)
      .filter((record) => record.scope === "host" && record.host === "the_hot_tub");
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => Array.isArray(record.steps) && record.steps.every((step: any) => step.status === "skipped"))).toBe(true);
  });

  it("runHostScopedLocalCatalogLifecycle applies an explicit host schema plan and records it", { timeout: 15000 }, () => {
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

    const repaired = installVerb(host, "$pinboard", "list_notes", `verb :list_notes() rxd {
  return this.notes;
}`, worldVerb(host, "$pinboard", "list_notes").version);
    expect(repaired.ok).toBe(true);
    expect(worldVerb(host, "$pinboard", "list_notes").source).toContain("return this.notes");

    runHostScopedLocalCatalogLifecycle(host, "the_pinboard");

    expect(worldVerb(host, "$pinboard", "list_notes").source).toContain("contents(this)");
  });

  it("runHostScopedLocalCatalogLifecycle verifies completed schema plans before trusting host metadata", { timeout: 30000 }, () => {
    const host = createWorld();
    runHostScopedLocalCatalogLifecycle(host, "the_chatroom");
    const commandPlanRecords = host.getProp("$system", "catalog_migration_records") as Array<Record<string, WooValue>>;
    expect(commandPlanRecords).toContainEqual(expect.objectContaining({
      plan_id: expect.stringMatching(/^local-catalog-schema:chat:/),
      scope: "host",
      host: "the_chatroom",
      status: "completed"
    }));

    const lookAt = host.ownVerbExact("$conversational", "look_at")!;
    host.addVerb("$conversational", { ...lookAt, arg_spec: { args: ["target"] }, version: lookAt.version + 1 });
    expect(host.ownVerbExact("$conversational", "look_at")?.arg_spec.command).toBeUndefined();

    runHostScopedLocalCatalogLifecycle(host, "the_chatroom");

    expect(host.ownVerbExact("$conversational", "look_at")?.arg_spec.command).toMatchObject({ dobj: "object", args_from: ["dobj_prefix"] });
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
    expect(world.ownVerb("$actor", "huh")?.kind).toBe("bytecode");
    expect(world.ownVerb("$match", "parse_command")?.kind).toBe("native");
    await world.directCall("enter-first", first.actor, "the_chatroom", "enter", []);
    await world.directCall("enter-second", second.actor, "the_chatroom", "enter", []);

    const chatBareEnterPlan = await world.directCall("plan-chat-bare-enter", first.actor, "the_chatroom", "command_plan", ["enter"]);
    expect(chatBareEnterPlan.op).toBe("result");
    if (chatBareEnterPlan.op === "result") {
      expect(chatBareEnterPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "enter", args: [] });
    }

    await world.directCall("enter-dubspace-for-chat-plan", first.actor, "the_dubspace", "enter", []);

    const dubspaceChatPlan = await world.directCall("plan-dubspace-chat", first.actor, "the_dubspace", "command_plan", ["say hello dubspace"]);
    expect(dubspaceChatPlan.op).toBe("result");
    if (dubspaceChatPlan.op === "result") {
      expect(dubspaceChatPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_dubspace", verb: "say", args: ["hello dubspace"] });
    }

    const dubspaceBareMiss = await world.directCall("plan-dubspace-bare-miss", first.actor, "the_dubspace", "command_plan", ["hello dubspace"]);
    expect(dubspaceBareMiss.op).toBe("result");
    if (dubspaceBareMiss.op === "result") {
      expect(dubspaceBareMiss.result).toMatchObject({ ok: false, route: "huh", space: "the_dubspace", target: first.actor, verb: "huh", text: "hello dubspace", error: "I don't understand that." });
      expect(dubspaceBareMiss.observations).toContainEqual(expect.objectContaining({
        type: "huh",
        source: "the_dubspace",
        actor: first.actor,
        text: "hello dubspace",
        reason: "I don't understand that."
      }));
      expect(dubspaceBareMiss.observations).not.toContainEqual(expect.objectContaining({ type: "said", text: "hello dubspace" }));
    }

    const dubspaceBareEnterPlan = await world.directCall("plan-dubspace-bare-enter", first.actor, "the_dubspace", "command_plan", ["enter"]);
    expect(dubspaceBareEnterPlan.op).toBe("result");
    if (dubspaceBareEnterPlan.op === "result") {
      expect(dubspaceBareEnterPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_dubspace", verb: "enter", args: [] });
    }

    const dubspaceBpmPlan = await world.directCall("plan-dubspace-bpm-direct", first.actor, "$match", "plan_command", ["bpm 142", "the_dubspace"]);
    expect(dubspaceBpmPlan.op).toBe("result");
    if (dubspaceBpmPlan.op === "result") {
      expect(dubspaceBpmPlan.result).toMatchObject({
        ok: true,
        route: "sequenced",
        space: "the_dubspace",
        target: "the_dubspace",
        verb: "set_tempo",
        args: ["142"]
      });
    }

    const dubspaceCommandSay = await world.command("command-dubspace-say", first.id, "the_dubspace", "say hello from command op");
    expect(dubspaceCommandSay.op).toBe("result");
    if (dubspaceCommandSay.op === "result") {
      expect(dubspaceCommandSay.result).toBe(true);
      expect(dubspaceCommandSay.observations).toContainEqual(expect.objectContaining({ type: "said", actor: first.actor, text: "hello from command op" }));
      expect((dubspaceCommandSay as any).command).toMatchObject({ route: "direct", target: "the_dubspace", verb: "say", args: ["hello from command op"] });
    }

    const dubspaceCommandBpm = await world.command("command-dubspace-bpm", first.id, "the_dubspace", "bpm 144");
    expect(dubspaceCommandBpm.op).toBe("applied");
    if (dubspaceCommandBpm.op === "applied") {
      expect(dubspaceCommandBpm.message).toMatchObject({ target: "the_dubspace", verb: "set_tempo", args: ["144"] });
      expect(dubspaceCommandBpm.observations).toContainEqual(expect.objectContaining({ type: "tempo_changed", target: "drum_1", bpm: 144 }));
    }
    expect(world.getProp("drum_1", "bpm")).toBe(144);

    const dubspaceCommandVerbSay = await world.directCall("command-verb-dubspace-say", first.actor, "the_dubspace", "command", ["say hello from command verb"]);
    expect(dubspaceCommandVerbSay.op).toBe("result");
    if (dubspaceCommandVerbSay.op === "result") {
      expect(dubspaceCommandVerbSay.result).toBe(true);
      expect(dubspaceCommandVerbSay.observations).toContainEqual(expect.objectContaining({ type: "said", actor: first.actor, text: "hello from command verb" }));
    }

    const dubspaceCommandVerbBpm = await world.directCall("command-verb-dubspace-bpm", first.actor, "the_dubspace", "command", ["bpm 146"]);
    expect(dubspaceCommandVerbBpm.op).toBe("result");
    if (dubspaceCommandVerbBpm.op === "result") {
      expect(dubspaceCommandVerbBpm.result).toMatchObject({
        op: "applied",
        message: { target: "the_dubspace", verb: "set_tempo", args: ["146"] },
        observations: [expect.objectContaining({ type: "tempo_changed", target: "drum_1", bpm: 146 })]
      });
    }
    expect(world.getProp("drum_1", "bpm")).toBe(146);

    expect(installVerb(world, "$chatroom", "tag", `verb :tag(text) rx {
    observe({ type: "tagged", source: this, actor: actor, text: text });
    return text;
  }`, null, { argSpec: { command: { dobj: "string", prep: "any", iobj: "any", args_from: ["argstr"] } } }).ok).toBe(true);
    await world.directCall("return-chat-for-string-plan", first.actor, "the_chatroom", "enter", []);
    const stringArgPlan = await world.directCall("plan-string-room-verb", first.actor, "the_chatroom", "command_plan", ["tag lamp"]);
    expect(stringArgPlan.op).toBe("result");
    if (stringArgPlan.op === "result") {
      expect(stringArgPlan.result).toMatchObject({ ok: true, route: "sequenced", target: "the_chatroom", verb: "tag", args: ["lamp"] });
    }

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

    const lookMugPlan = await world.directCall("plan-look-mug", first.actor, "the_chatroom", "command_plan", ["look mug"]);
    expect(lookMugPlan.op).toBe("result");
    if (lookMugPlan.op === "result") {
      expect(lookMugPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "look_at", args: ["the_mug"] });
    }

    world.createObject({ id: "custom_look_probe", name: "custom look probe", parent: "$thing", owner: "$wiz", location: "the_chatroom" });
    const customLook = installVerb(world, "custom_look_probe", "look", `verb :look() rxd {
  return { id: this, custom: true };
}`, null, { argSpec: { command: { dobj: "this", prep: "any", iobj: "any", args_from: [] } } });
    expect(customLook.ok).toBe(true);
    const customLookPlan = await world.directCall("plan-custom-look-probe", first.actor, "the_chatroom", "command_plan", ["look custom look probe"]);
    expect(customLookPlan.op).toBe("result");
    if (customLookPlan.op === "result") {
      expect(customLookPlan.result).toMatchObject({ ok: true, target: "custom_look_probe", verb: "look", args: [] });
    }

    const lookAtMugPlan = await world.directCall("plan-look-at-mug", first.actor, "the_chatroom", "command_plan", ["look at mug"]);
    expect(lookAtMugPlan.op).toBe("result");
    if (lookAtMugPlan.op === "result") {
      expect(lookAtMugPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "look_at", args: ["the_mug"] });
      expect((lookAtMugPlan.result as Record<string, any>).cmd).toMatchObject({ prep: "at", iobj: "the_mug" });
    }

    const lookMePlan = await world.directCall("plan-look-me", first.actor, "the_chatroom", "command_plan", ["look me"]);
    expect(lookMePlan.op).toBe("result");
    if (lookMePlan.op === "result") {
      expect(lookMePlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "look_at", args: [first.actor] });
      const takeLamp = await world.directCall("take-lamp-before-look-me", first.actor, "the_chatroom", "take", ["lamp"]);
      expect(takeLamp.op).toBe("result");
      const lookedMe = await world.directCall("look-me-command", first.actor, "the_chatroom", "look_at", [first.actor]);
      expect(lookedMe.op).toBe("result");
      if (lookedMe.op === "result") {
        expect(lookedMe.observations.find((obs) => obs.type === "looked")?.text).toContain("You are carrying Brass Lamp.");
        expect(lookedMe.result).toMatchObject({ carrying: [expect.objectContaining({ id: "the_lamp", title: "Brass Lamp" })] });
      }
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
      arg_spec: {
        command: { dobj: "this", prep: "any", iobj: "any", args_from: [] }
      },
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

    world.defineProperty(first.actor, { name: "huh_order", typeHint: "list<str>", defaultValue: [], owner: "$wiz", perms: "rw" });
    const myHuh = installVerb(world, first.actor, "my_huh", `verb :my_huh(cmd) rxd {
  this.huh_order = this.huh_order + ["my_huh"];
  return null;
}`, null);
    expect(myHuh.ok).toBe(true);
    const hereHuh = installVerb(world, "the_chatroom", "here_huh", `verb :here_huh(cmd) rxd {
  actor.huh_order = actor.huh_order + ["here_huh"];
  if (cmd["text"] == "/sparkle") {
    return { ok: true, route: "direct", space: null, target: this, verb: "say", args: ["The room sparkles."], cmd: cmd };
  }
  return null;
}`, null);
    expect(hereHuh.ok).toBe(true);
    const lastHuh = installVerb(world, first.actor, "last_huh", `verb :last_huh(cmd) rxd {
  this.huh_order = this.huh_order + ["last_huh"];
  if (cmd["text"] == "/last") {
    return { ok: true, route: "direct", space: null, target: "the_chatroom", verb: "say", args: ["Last hook wins."], cmd: cmd };
  }
  return null;
}`, null);
    expect(lastHuh.ok).toBe(true);
    const hereHuhPlan = await world.directCall("plan-here-huh-hook", first.actor, "the_chatroom", "command_plan", ["/sparkle"]);
    expect(hereHuhPlan.op).toBe("result");
    if (hereHuhPlan.op === "result") {
      expect(hereHuhPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "say", args: ["The room sparkles."] });
    }
    expect(world.getProp(first.actor, "huh_order")).toEqual(["my_huh", "here_huh"]);
    world.setProp(first.actor, "huh_order", []);

    const lastHuhPlan = await world.directCall("plan-last-huh-hook", first.actor, "the_chatroom", "command_plan", ["/last"]);
    expect(lastHuhPlan.op).toBe("result");
    if (lastHuhPlan.op === "result") {
      expect(lastHuhPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "say", args: ["Last hook wins."] });
    }
    expect(world.getProp(first.actor, "huh_order")).toEqual(["my_huh", "here_huh", "last_huh"]);
    world.setProp(first.actor, "huh_order", []);

    const override = installVerb(world, "$guest", "huh", `verb :huh(text, reason, source) rxd {
  observe({ type: "custom_huh", source: source, actor: this, text: text, reason: reason, ts: now(), _audience_override: [this] });
  return false;
}`, null);
    expect(override.ok).toBe(true);
    const huh = await world.directCall("plan-huh-override", first.actor, "the_chatroom", "command_plan", ["/doesnotexist"]);
    expect(huh.op).toBe("result");
    if (huh.op === "result") {
      expect(huh.result).toMatchObject({ ok: false, route: "huh", space: "the_chatroom", target: first.actor, verb: "huh" });
      expect(huh.observations).toMatchObject([{ type: "custom_huh", source: "the_chatroom", actor: first.actor, text: "/doesnotexist" }]);
    }
    expect(world.getProp(first.actor, "huh_order")).toEqual(["my_huh", "here_huh", "last_huh"]);
  });

  it("supports a small multi-room chat world with stable carryable placement", async () => {
    const world = createWorld();
    // The "outsider" branch below tests $match permission gating for an actor
    // who is not in the_chatroom. Demoworld would otherwise auto-place every
    // fresh guest there.
    world.setProp("$system", "guest_initial_room", null);
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

    // "get mug" — the dobj resolves to the_mug (visible in the room) but the
    // mug doesn't define a `get` verb. The planner must NOT huh; instead it
    // should fall through to the room's `take` verb (resolved via the alias
    // "get" on the $conversational feature attached to the room). Regression
    // test for the case where the room-verb branch's `isa(this, definer)`
    // gate excluded feature-attached verbs.
    const getMugPlan = await world.directCall("plan-get-mug", session.actor, "the_chatroom", "command_plan", ["get mug"]);
    expect(getMugPlan.op).toBe("result");
    if (getMugPlan.op === "result") {
      expect(getMugPlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "take", args: ["mug"] });
    }

    // "get whatever" should route to the room's take verb so room_take owns
    // the missing-match error (it knows the room's contents better than the
    // chat planner's broader visibility set).
    const missingTakePlan = await world.directCall("plan-take-missing", session.actor, "the_chatroom", "command_plan", ["get whatever"]);
    expect(missingTakePlan.op).toBe("result");
    if (missingTakePlan.op === "result") {
      expect(missingTakePlan.result).toMatchObject({ ok: true, route: "direct", target: "the_chatroom", verb: "take", args: ["whatever"] });
    }

    const bareDropPlan = await world.directCall("plan-drop-bare", session.actor, "the_chatroom", "command_plan", ["drop"]);
    expect(bareDropPlan.op).toBe("result");
    if (bareDropPlan.op === "result") {
      expect(bareDropPlan.result).toMatchObject({ ok: false, route: "huh", space: "the_chatroom", target: session.actor, verb: "huh", text: "drop" });
      expect(bareDropPlan.observations).toContainEqual(expect.objectContaining({ type: "huh", source: "the_chatroom", actor: session.actor, text: "drop", reason: "Drop what?" }));
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

  it("dispatches give, inventory, and home through LambdaMOO-shaped seed verbs", async () => {
    const world = createWorld();
    const giver = world.auth("guest:give-giver");
    const receiver = world.auth("guest:give-receiver");

    await world.directCall("giver-enter", giver.actor, "the_chatroom", "enter", []);
    await world.directCall("receiver-enter", receiver.actor, "the_chatroom", "enter", []);

    // Empty inventory.
    const empty = await world.directCall("inv-empty", giver.actor, giver.actor, "inventory", []);
    expect(empty.op).toBe("result");
    if (empty.op === "result") {
      expect(empty.result).toMatchObject({ items: [], text: "You are empty-handed." });
    }

    // Pick up the lamp, then verify inventory reports it.
    const take = await world.directCall("take-lamp-give", giver.actor, "the_chatroom", "take", ["lamp"]);
    expect(take.op).toBe("result");
    expect(world.object("the_lamp").location).toBe(giver.actor);

    const carrying = await world.directCall("inv-one", giver.actor, giver.actor, "inventory", []);
    expect(carrying.op).toBe("result");
    if (carrying.op === "result") {
      expect(carrying.result).toMatchObject({ items: [{ id: "the_lamp", title: "Brass Lamp" }], text: "You are carrying Brass Lamp." });
    }

    // Plan and execute "give lamp to <receiver>". The planner dispatches on
    // the matched dobj (the_lamp) — LambdaMOO-style — and routes to its :give.
    const recvName = world.object(receiver.actor).name; // "Guest N"
    const givePlan = await world.directCall("plan-give", giver.actor, "the_chatroom", "command_plan", [`give lamp to ${recvName}`]);
    expect(givePlan.op).toBe("result");
    if (givePlan.op === "result") {
      expect(givePlan.result).toMatchObject({ ok: true, route: "direct", target: "the_lamp", verb: "give", args: [recvName] });
    }

    const give = await world.directCall("give-lamp", giver.actor, "the_lamp", "give", [recvName]);
    expect(give.op).toBe("result");
    if (give.op === "result") {
      expect(give.result).toMatchObject({ item: "the_lamp", recipient: receiver.actor });
      // Private tells go to giver and recipient; no public room observation.
      expect(give.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", target: giver.actor, text: expect.stringContaining("You hand Brass Lamp to") }),
        expect.objectContaining({ type: "text", target: receiver.actor, text: expect.stringContaining("hands you Brass Lamp") })
      ]));
      expect(give.observations.find((obs) => obs.type === "given")).toBeUndefined();
    }
    expect(world.object("the_lamp").location).toBe(receiver.actor);

    // Giving to yourself.
    const giverName = world.object(giver.actor).name;
    const takeBack = await world.directCall("take-back", receiver.actor, "the_chatroom", "take", ["lamp"]);
    expect(takeBack.op).toBe("error"); // can't take from another actor
    // Recipient hands it back so the giver has it again for the self-give test.
    const handBack = await world.directCall("hand-back", receiver.actor, "the_lamp", "give", [giverName]);
    expect(handBack.op).toBe("result");
    expect(world.object("the_lamp").location).toBe(giver.actor);

    const selfGive = await world.directCall("self-give", giver.actor, "the_lamp", "give", [giverName]);
    expect(selfGive.op).toBe("error");
    if (selfGive.op === "error") {
      expect(selfGive.error.code).toBe("E_INVARG");
      expect(selfGive.error.message).toMatch(/yourself/i);
    }

    // Default home: a fresh guest's `home` is `$nowhere`. `:home` must not
    // E_VERBNF on a missing $nowhere:enter — it should land on the friendly
    // "no home set" tell and leave the actor where they are.
    expect(world.getProp(giver.actor, "home")).toBe("$nowhere");
    const noHome = await world.directCall("default-home", giver.actor, giver.actor, "home", []);
    expect(noHome.op).toBe("result");
    if (noHome.op === "result") {
      expect(noHome.result).toBeNull();
      expect(noHome.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", target: giver.actor, text: expect.stringContaining("don't have a home") })
      ]));
    }
    expect(world.object(giver.actor).location).toBe("the_chatroom");
    expect(world.hasPresence(giver.actor, "the_chatroom")).toBe(true);

    // Set home to a real room, walk to a different room, then `home` should
    // teleport the actor home with the right presence/announce reconciliation.
    world.setProp(giver.actor, "home", "the_chatroom");
    const goDeck = await world.directCall("go-deck", giver.actor, "the_chatroom", "southeast", []);
    expect(goDeck.op).toBe("result");
    expect(world.object(giver.actor).location).toBe("the_deck");

    const homePlan = await world.directCall("plan-home", giver.actor, "the_deck", "command_plan", ["home"]);
    expect(homePlan.op).toBe("result");
    if (homePlan.op === "result") {
      expect(homePlan.result).toMatchObject({ ok: true, route: "direct", target: giver.actor, verb: "home", args: [] });
    }
    const home = await world.directCall("go-home", giver.actor, giver.actor, "home", []);
    expect(home.op).toBe("result");
    expect(world.hasPresence(giver.actor, "the_chatroom")).toBe(true);
    expect(world.hasPresence(giver.actor, "the_deck")).toBe(false);
  });

  it("renders directed public speech in woocode with recipient-specific text", async () => {
    const world = createWorld();
    const speaker = world.auth("guest:directed-speaker");
    const recipient = world.auth("guest:directed-recipient");
    const bystander = world.auth("guest:directed-bystander");

    await world.directCall("directed-speaker-enter", speaker.actor, "the_chatroom", "enter", []);
    await world.directCall("directed-recipient-enter", recipient.actor, "the_chatroom", "enter", []);
    await world.directCall("directed-bystander-enter", bystander.actor, "the_chatroom", "enter", []);

    const said = await world.directCall("directed-say-to", speaker.actor, "the_chatroom", "say_to", [recipient.actor, "hi!"]);
    expect(said.op).toBe("result");
    if (said.op === "result") {
      const publicIndex = said.observations.findIndex((obs) => obs.type === "said_to");
      const recipientIndex = said.observations.findIndex((obs) => obs.type === "text" && obs.target === recipient.actor);
      expect(said.observations[publicIndex]).toMatchObject({ type: "said_to", actor: speaker.actor, to: recipient.actor, text: "hi!" });
      expect(said.observations[recipientIndex]).toMatchObject({
        type: "text",
        target: recipient.actor,
        text: `${world.object(speaker.actor).name} [to you] hi!`
      });
      expect(said.observationAudiences?.[publicIndex]).toEqual(expect.arrayContaining([speaker.actor, bystander.actor]));
      expect(said.observationAudiences?.[publicIndex]).not.toContain(recipient.actor);
      expect(said.observationAudiences?.[recipientIndex]).toEqual([recipient.actor]);
    }

    const selfSaid = await world.directCall("directed-say-self", speaker.actor, "the_chatroom", "say_to", [speaker.actor, "self-check"]);
    expect(selfSaid.op).toBe("result");
    if (selfSaid.op === "result") {
      const publicIndex = selfSaid.observations.findIndex((obs) => obs.type === "said_to");
      const targetedText = selfSaid.observations.find((obs) => obs.type === "text" && obs.target === speaker.actor);
      expect(selfSaid.observations[publicIndex]).toMatchObject({
        type: "said_to",
        actor: speaker.actor,
        to: speaker.actor,
        text: "self-check"
      });
      expect(targetedText).toBeUndefined();
      expect(selfSaid.observationAudiences?.[publicIndex]).toContain(speaker.actor);
    }
  });

  it("dispatches @describe through $root:set_description with self/owner/wizard perms", async () => {
    const world = createWorld();
    const guest = world.auth("guest:describe-self");
    await world.directCall("describe-enter", guest.actor, "the_chatroom", "enter", []);

    // Self-describe via the planner — non-wizard, non-owner of self's def, but
    // the self-describe carve-out should let it through.
    const plan = await world.directCall("plan-describe-me", guest.actor, "the_chatroom", "command_plan", ["@describe me as A poised observer."]);
    expect(plan.op).toBe("result");
    if (plan.op === "result") {
      expect(plan.result).toMatchObject({ ok: true, route: "direct", target: guest.actor, verb: "set_description", args: ["A poised observer."] });
    }
    const desc = await world.directCall("set-self-desc", guest.actor, guest.actor, "set_description", ["A poised observer."]);
    expect(desc.op).toBe("result");
    if (desc.op === "result") {
      expect(desc.result).toBe(true);
      expect(desc.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", target: guest.actor, text: "Description set." })
      ]));
    }
    expect(world.getProp(guest.actor, "description")).toBe("A poised observer.");

    // Foreign describe: another guest can't describe me.
    const stranger = world.auth("guest:describe-stranger");
    const denied = await world.directCall("foreign-desc", stranger.actor, guest.actor, "set_description", ["mine now"]);
    expect(denied.op).toBe("error");
    if (denied.op === "error") expect(denied.error.code).toBe("E_PERM");
    expect(world.getProp(guest.actor, "description")).toBe("A poised observer.");

    // Owner branch: an object owned by the guest is describable by the guest
    // even though they neither are the object nor a wizard. LambdaCore's
    // `controls(caller_perms(), this)` clause.
    world.createObject({ id: "describe_owned_curio", name: "guest curio", parent: "$thing", owner: guest.actor, location: "the_chatroom" });
    const ownerDesc = await world.directCall("owner-desc", guest.actor, "describe_owned_curio", "set_description", ["A sleek brass curio."]);
    expect(ownerDesc.op).toBe("result");
    if (ownerDesc.op === "result") expect(ownerDesc.result).toBe(true);
    expect(world.getProp("describe_owned_curio", "description")).toBe("A sleek brass curio.");

    // Owner can't describe an object they don't own (just to keep the
    // controls clause honest — the curio is theirs but the stranger's
    // description is not).
    const ownerOverreach = await world.directCall("owner-overreach", guest.actor, stranger.actor, "set_description", ["meddling"]);
    expect(ownerOverreach.op).toBe("error");
    if (ownerOverreach.op === "error") expect(ownerOverreach.error.code).toBe("E_PERM");

    // Wizard branch: $wiz can describe arbitrary objects regardless of
    // ownership or self-equality.
    const wizDesc = await world.directCall("wiz-desc", "$wiz", stranger.actor, "set_description", ["Touched by a wizard."]);
    expect(wizDesc.op).toBe("result");
    if (wizDesc.op === "result") expect(wizDesc.result).toBe(true);
    expect(world.getProp(stranger.actor, "description")).toBe("Touched by a wizard.");

    // Disconnect-reset: reaping the guest's session resets description to "".
    world.attachSocket(guest.id, "ws-describe-test");
    world.detachSocket(guest.id, "ws-describe-test");
    const detachedAt = world.sessions.get(guest.id)?.lastDetachAt ?? Date.now();
    expect(world.reapExpiredSessions(detachedAt + 60_001)).toEqual([guest.id]);
    expect(world.getProp(guest.actor, "description")).toBe("");
  });

  it("dispatches LambdaCore-shaped @who, @join, @ways, and @examine commands", async () => {
    const world = createWorld();
    const first = world.auth("guest:lambdacore-commands-first");
    const second = world.auth("guest:lambdacore-commands-second");
    await world.directCall("lambda-enter-first", first.actor, "the_chatroom", "enter", []);
    await world.directCall("lambda-enter-second", second.actor, "the_deck", "enter", []);

    const whoPlan = await world.directCall("lambda-plan-who", first.actor, "the_chatroom", "command_plan", ["@who"]);
    expect(whoPlan.op).toBe("result");
    if (whoPlan.op === "result") {
      expect(whoPlan.result).toMatchObject({ ok: true, route: "direct", target: first.actor, verb: "who_all", args: [""] });
    }
    const who = await world.command("lambda-who", first.id, "the_chatroom", "@who");
    expect(who.op).toBe("result");
    if (who.op === "result") {
      expect(who.result).toEqual(expect.arrayContaining([
        expect.objectContaining({ player: first.actor, location: "the_chatroom", connected_seconds: expect.any(Number), last_login_at: expect.any(Number) }),
        expect.objectContaining({ player: second.actor, location: "the_deck", connected_seconds: expect.any(Number), last_login_at: expect.any(Number) })
      ]));
      expect(who.observations).toContainEqual(expect.objectContaining({ type: "who", actor: first.actor, present_actors: expect.arrayContaining([first.actor, second.actor]) }));
    }
    const directWhoNoArgs = await world.directCall("lambda-who-no-args", first.actor, first.actor, "who_all", []);
    expect(directWhoNoArgs.op).toBe("result");
    if (directWhoNoArgs.op === "result") {
      expect(directWhoNoArgs.result).toEqual(expect.arrayContaining([
        expect.objectContaining({ player: first.actor }),
        expect.objectContaining({ player: second.actor })
      ]));
    }

    const secondSession = world.sessions.get(second.id);
    if (secondSession) secondSession.lastInputAt = Date.now() - 1_000_000;
    const namedSleeping = await world.command("lambda-who-sleeping", first.id, "the_chatroom", `@who ${second.actor}`);
    expect(namedSleeping.op).toBe("result");
    if (namedSleeping.op === "result") {
      expect(namedSleeping.result).toEqual([
        expect.objectContaining({ player: second.actor, connected: false, connected_seconds: null, last_login_at: expect.any(Number) })
      ]);
    }

    const ways = await world.command("lambda-ways", first.id, "the_chatroom", "@ways");
    expect(ways.op).toBe("result");
    if (ways.op === "result") {
      expect(ways.result).toMatchObject({ room: "the_chatroom", exits: expect.arrayContaining(["exit_living_room_southeast", "exit_living_room_south"]) });
      expect(ways.observations).toContainEqual(expect.objectContaining({ type: "text", target: first.actor, text: expect.stringContaining("Obvious exits:") }));
    }

    const examine = await world.command("lambda-examine", first.id, "the_chatroom", "@examine lamp");
    expect(examine.op).toBe("result");
    if (examine.op === "result") {
      expect(examine.result).toMatchObject({ target: "the_lamp", owner: "$wiz", obvious_verbs: expect.arrayContaining([expect.stringContaining("give")]) });
      expect(examine.observations).toContainEqual(expect.objectContaining({ type: "text", target: first.actor, text: expect.stringContaining("Brass Lamp") }));
    }

    const join = await world.command("lambda-join", first.id, "the_chatroom", `@join ${second.actor}`);
    expect(join.op).toBe("result");
    if (join.op === "result") {
      expect(join.result).toMatchObject({ room: "the_deck", from: "the_chatroom", target: second.actor, look_deferred: true });
      expect(world.object(first.actor).location).toBe("the_deck");
      expect(join.observations).toContainEqual(expect.objectContaining({ type: "text", target: first.actor, text: expect.stringContaining("You visit") }));
    }
  });

  it("surfaces idle/connected presence via $player:look_self and the substrate readers", async () => {
    const world = createWorld();
    const guest = world.auth("guest:idle-a");
    const actor = guest.actor;

    // Fresh auth counts the session-create as input on the live window —
    // even before any WS is attached, the actor is "connected" because they
    // just authed. This matches REST/MCP-only flows that never attach a WS.
    expect(world.actorIsConnected(actor)).toBe(true);
    expect(world.actorLastInputAt(actor)).not.toBeNull();

    // Attach a socket — adds the WS-attached signal but doesn't change the
    // is-connected outcome (already true via the live window).
    world.attachSocket(guest.id, "ws-idle-a");
    expect(world.actorIsConnected(actor)).toBe(true);
    expect(world.actorLastInputAt(actor)).not.toBeNull();

    // :look on a fresh session — connected, idle ~0s → "awake and looks alert."
    const alert = await world.directCall("idle-look-fresh", actor, actor, "look_self", []);
    expect(alert.op).toBe("result");
    if (alert.op === "result") {
      expect((alert.result as Record<string, unknown>).description).toMatch(/is awake and looks alert/);
    }

    // Push lastInputAt back 65s and look again — should report "staring off."
    const session = world.sessions.get(guest.id)!;
    session.lastInputAt = Date.now() - 65_000;
    const staring = await world.directCall("idle-look-staring", actor, actor, "look_self", []);
    expect(staring.op).toBe("result");
    if (staring.op === "result") {
      expect((staring.result as Record<string, unknown>).description).toMatch(/staring off into space for 1 minute/);
    }

    // /api/state-equivalent reads MUST NOT reset idle. Simulating the projection:
    void world.state(actor);
    expect(world.actorLastInputAt(actor)).toBe(session.lastInputAt);

    // A real call/direct frame DOES touch — exercise via a chat say.
    await world.directCall("idle-bump-via-direct", actor, actor, "look_self", []);
    // Direct call through the WS protocol layer would call touchSessionInput;
    // simulate that ingress here so the in-memory state matches the wire.
    world.touchSessionInput(guest.id);
    expect(Date.now() - world.actorLastInputAt(actor)!).toBeLessThan(1_000);

    // Multi-session for one actor: detached + active. Idle reflects the active.
    const secondSession = world.createSessionForActor(actor, "guest");
    world.attachSocket(secondSession.id, "ws-idle-a-2");
    secondSession.lastInputAt = Date.now() - 5_000; // active session is 5s idle
    session.lastInputAt = Date.now() - 600_000; // first session is 10min stale
    world.detachSocket(session.id, "ws-idle-a"); // first session has no live socket
    expect(world.actorIsConnected(actor)).toBe(true); // second session is still attached
    const idleAcrossSessions = (Date.now() - world.actorLastInputAt(actor)!) / 1_000;
    expect(idleAcrossSessions).toBeLessThan(60); // takes the most-recent input

    // Detach all sockets — but the second session just had recent input, so the
    // dual-signal predicate keeps the actor "connected" until the live window
    // closes. This is the path REST/MCP-only callers ride, and a freshly-
    // detached WS user gets the same brief grace.
    world.detachSocket(secondSession.id, "ws-idle-a-2");
    expect(world.actorIsConnected(actor)).toBe(true);

    // Push every session's lastInputAt past the 5-minute live window — now
    // there's no socket and no recent input on any transport, so the actor
    // reads as sleeping.
    for (const s of world.sessions.values()) {
      if (s.actor === actor) s.lastInputAt = Date.now() - 6 * 60_000;
    }
    expect(world.actorIsConnected(actor)).toBe(false);
    const sleeping = await world.directCall("idle-look-sleeping", actor, actor, "look_self", []);
    expect(sleeping.op).toBe("result");
    if (sleeping.op === "result") {
      expect((sleeping.result as Record<string, unknown>).description).toMatch(/is sleeping/);
    }

    // REST/MCP-only path: a session that never attaches a WS, but has a fresh
    // touch from non-WS ingress, must still read as connected and alert.
    const restGuest = world.auth("guest:idle-rest");
    expect(restGuest.attachedSockets.size).toBe(0);
    world.touchSessionInput(restGuest.id);
    expect(world.actorIsConnected(restGuest.actor)).toBe(true);
    const restAlert = await world.directCall("idle-rest-alert", restGuest.actor, restGuest.actor, "look_self", []);
    expect(restAlert.op).toBe("result");
    if (restAlert.op === "result") {
      expect((restAlert.result as Record<string, unknown>).description).toMatch(/is awake and looks alert/);
    }
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

  it("clears auto_presence on demo spaces and removes obsolete actor presence_in state", () => {
    const world = createWorld();
    expect(world.getProp("the_dubspace", "auto_presence")).toBe(false);
    expect(world.getProp("the_pinboard", "auto_presence")).toBe(false);

    // Simulate a deployed world: actors auto-present in demo spaces, spaces
    // listing those actors as subscribers, and the migration ledgers missing
    // the cleanup entries.
    const session = world.auth("guest:auto-presence-cleanup");
    world.defineProperty("$actor", { name: "presence_in", defaultValue: [], owner: "$wiz", perms: "r", typeHint: "list<obj>" });
    world.setProp(session.actor, "presence_in", ["the_dubspace", "the_pinboard"]);
    world.setProp("the_dubspace", "auto_presence", true);
    world.setProp("the_pinboard", "auto_presence", true);
    world.setProp("the_dubspace", "subscribers", [session.actor]);
    world.setProp("the_pinboard", "subscribers", [session.actor]);
    const ledger = (world.getProp("$system", "applied_migrations") as string[]).filter(
      (id) => id !== "2026-05-04-demo-spaces-no-auto-presence" && id !== "2026-05-04-drop-presence-in-property"
    );
    world.setProp("$system", "applied_migrations", ledger);

    installLocalCatalogs(world);

    expect(world.getProp("the_dubspace", "auto_presence")).toBe(false);
    expect(world.getProp("the_pinboard", "auto_presence")).toBe(false);
    expect(world.getProp("the_dubspace", "subscribers")).toEqual([]);
    expect(world.getProp("the_pinboard", "subscribers")).toEqual([]);
    expect(world.propOrNull(session.actor, "presence_in")).toBeNull();
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-04-demo-spaces-no-auto-presence");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-04-drop-presence-in-property");

    // Fresh auths after the migration must not pick up auto-presence either —
    // demo spaces have no business pre-subscribing arriving agents.
    const fresh = world.auth("guest:auto-presence-fresh");
    expect(world.propOrNull(fresh.actor, "presence_in")).toBeNull();
  });

  it("migrates the cockatoo into worlds installed before it landed", { timeout: 30000 }, async () => {
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

  it("migrates stale local catalog native verbs to current catalog implementations", { timeout: 30000 }, async () => {
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


    installLocalCatalogs(world, ["chat"]);

    const migratedEnter = world.ownVerb("$conversational", "enter");
    expect(migratedEnter?.kind).toBe("bytecode");
      expect(migratedEnter?.source).toContain("moveto(actor, this)");
      expect(migratedEnter?.source).not.toContain("set_presence");
    const migratedLook = world.ownVerb("$conversational", "look");
    expect(migratedLook?.kind).toBe("bytecode");
    expect(migratedLook?.source).toContain("look_at");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-04-30-source-catalog-verbs");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-04-30-catalog-placement-metadata");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-04-30-room-look-self");
  });

  it("repairs stale native chat command planning on existing installs", async () => {
    const world = createWorld();
    const migrations = (world.getProp("$system", "applied_migrations") as string[])
      .filter((id) => ![
        "2026-05-03-chat-command-plan-source-repair",
        "2026-05-06-chat-actor-huh-source-repair",
        "2026-05-06-chat-look-at-command-repair"
      ].includes(id));
    world.setProp("$system", "applied_migrations", migrations);

    const commandPlan = world.ownVerbExact("$conversational", "command_plan")!;
    const huh = world.ownVerbExact("$conversational", "huh")!;
    const huhPlan = world.ownVerbExact("$conversational", "huh_plan")!;
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
    world.addVerb("$conversational", { ...huh, source: "verb :huh(text, reason) rxd { observe({ type: \"huh\", actor: actor, text: text, reason: reason, ts: now() }); return false; }", version: huh.version + 1 });
    world.addVerb("$conversational", { ...huhPlan, source: "verb :huh_plan(text, reason) rxd { this:huh(text, reason); return { ok: false, route: \"huh\", target: this, verb: \"huh\", args: [text, reason], error: reason, text: text }; }", version: huhPlan.version + 1 });
    const lookAt = world.ownVerbExact("$conversational", "look_at")!;
    world.addVerb("$conversational", { ...lookAt, arg_spec: { args: ["target"] }, version: lookAt.version + 1 });

    installLocalCatalogs(world, ["chat"]);

    const repaired = world.ownVerbExact("$conversational", "command_plan");
    expect(repaired?.kind).toBe("bytecode");
    expect(repaired?.source).toContain("plan_command");
    expect(world.ownVerbExact("$conversational", "huh")?.source).toContain("actor:huh");
    expect(world.ownVerbExact("$conversational", "huh_plan")?.source).toContain("target: actor");
    expect(world.ownVerbExact("$conversational", "look_at")?.arg_spec.command).toMatchObject({ dobj: "object", args_from: ["dobj_prefix"] });
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-03-chat-command-plan-source-repair");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-06-chat-actor-huh-source-repair");
    expect(world.getProp("$system", "applied_migrations")).toContain("2026-05-06-chat-look-at-command-repair");

    const session = world.auth("guest:command-plan-repair");
    await world.directCall("enter-command-plan-repair", session.actor, "the_chatroom", "enter", []);
    const plan = await world.directCall("repaired-plan", session.actor, "the_chatroom", "command_plan", ["say hello after repair"]);
    expect(plan.op).toBe("result");
    if (plan.op === "result") expect(plan.result).toMatchObject({ route: "direct", target: "the_chatroom", verb: "say", args: ["hello after repair"] });
    const lookPlan = await world.directCall("repaired-look-plan", session.actor, "the_chatroom", "command_plan", ["look mug"]);
    expect(lookPlan.op).toBe("result");
    if (lookPlan.op === "result") expect(lookPlan.result).toMatchObject({ route: "direct", target: "the_chatroom", verb: "look_at", args: ["the_mug"] });
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
    expect(state.catalogs.installed.map((record: any) => record.catalog)).toEqual(expect.arrayContaining(["chat", "dubspace", "pinboard"]));
    expect(state.spaces).toHaveProperty("the_dubspace");
    expect(state.spaces).toHaveProperty("the_pinboard");
    expect(state.spaces).toHaveProperty("the_chatroom");
    expect((state.objects.the_dubspace as any).props.auto_presence).toBe(false);
    expect((state.objects.the_dubspace as any).location).toBe("the_chatroom");
    expect((state.objects.the_dubspace as any).props.operators).toEqual([]);
    expect((state.objects.slot_1 as any).props.gain).toBe(0.75);
    expect(state.object_routes).toEqual(expect.arrayContaining([
      { id: "the_dubspace", host: "the_dubspace", anchor: null },
      { id: "slot_1", host: "the_dubspace", anchor: "the_dubspace" },
      { id: "the_pinboard", host: "the_pinboard", anchor: null }
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

  describe("writability tiers", () => {
    // Tier lists are ordinary class properties: the substrate has no
    // special knowledge of them. The catalog convention is that
    // `writable_owner` and `writable_self` are list<str> property defaults
    // that the per-class :is_writable_by_property(who, name) verb consults.
    // Subclasses extend the lists by redeclaring the property with a
    // wider default; the substrate's normal property-def chain handles
    // inheritance.
    function tiersClass(propertyOverrides: Array<{ name: string; default?: unknown; type?: string }> = []): RuntimeCatalogManifest {
      const baseProps = [
        { name: "place", type: "str", default: "", perms: "r" },
        { name: "units", type: "str", default: "metric", perms: "r" },
        { name: "current", type: "map", default: {}, perms: "r" },
        { name: "history", type: "list", default: [], perms: "r" },
        { name: "writable_owner", type: "list<str>", default: ["place", "units"], perms: "r" },
        { name: "writable_self", type: "list<str>", default: ["current", "history"], perms: "r" }
      ];
      const merged = baseProps.map((p) => propertyOverrides.find((o) => o.name === p.name) ?? p);
      for (const o of propertyOverrides) {
        if (!baseProps.some((p) => p.name === o.name)) merged.push(o);
      }
      return {
        name: "tiers-demo",
        version: "0.1.0",
        spec_version: "v1",
        license: "MIT",
        classes: [
          {
            local_name: "$tiers_block",
            parent: "$root",
            description: "Test class — tier lists declared as ordinary class properties.",
            properties: merged
          }
        ]
      } as unknown as RuntimeCatalogManifest;
    }

    it("declares writable_owner / writable_self as ordinary class properties", () => {
      const world = createWorld({ catalogs: false });
      installCatalogManifest(world, tiersClass(), { tap: "@local", alias: "tiers-demo" });
      expect(world.getProp("$tiers_block", "writable_owner")).toEqual(["place", "units"]);
      expect(world.getProp("$tiers_block", "writable_self")).toEqual(["current", "history"]);
      const ownerDef = world.object("$tiers_block").propertyDefs.get("writable_owner");
      expect(ownerDef?.perms).toBe("r");
    });

    it("propagates the tier lists to instances (and subclasses) via property def inheritance", () => {
      const world = createWorld({ catalogs: false });
      installCatalogManifest(world, tiersClass(), { tap: "@local", alias: "tiers-demo" });
      world.createObject({ id: "inst_tier_block_1", name: "inst_tier_block_1", parent: "$tiers_block", owner: "$wiz", location: null });
      expect(world.getProp("inst_tier_block_1", "writable_owner")).toEqual(["place", "units"]);
      expect(world.getProp("inst_tier_block_1", "writable_self")).toEqual(["current", "history"]);
      world.createObject({ id: "$tiers_subblock", name: "$tiers_subblock", parent: "$tiers_block", owner: "$wiz", location: null });
      world.createObject({ id: "inst_tier_subblock_1", name: "inst_tier_subblock_1", parent: "$tiers_subblock", owner: "$wiz", location: null });
      expect(world.getProp("inst_tier_subblock_1", "writable_owner")).toEqual(["place", "units"]);
      expect(world.getProp("inst_tier_subblock_1", "writable_self")).toEqual(["current", "history"]);
    });

    // Lint helper: catalog authors should keep tier defaults well-formed.
    // Surfaces issues without requiring install (works on raw manifest data).
    function lintTiers(
      classDef: { local_name: string; parent?: string; properties?: { name: string; default?: unknown }[] },
      ancestorPropNames: Set<string> = new Set()
    ): string[] {
      const issues: string[] = [];
      const props = classDef.properties ?? [];
      const declared = new Set([...props.map((p) => p.name), ...ancestorPropNames]);
      const tierFor = (name: "writable_owner" | "writable_self"): string[] | null => {
        const def = props.find((p) => p.name === name);
        if (!def) return null;
        const value = def.default;
        if (!Array.isArray(value)) {
          issues.push(`${classDef.local_name}.${name}: default must be a list<str>`);
          return null;
        }
        if (!value.every((v) => typeof v === "string" && v.length > 0)) {
          issues.push(`${classDef.local_name}.${name}: every entry must be a non-empty string`);
          return null;
        }
        const seen = new Set<string>();
        for (const item of value as string[]) {
          if (seen.has(item)) issues.push(`${classDef.local_name}.${name}: duplicate "${item}"`);
          seen.add(item);
        }
        return value as string[];
      };
      const reserved = new Set(["owner", "name", "description", "aliases", "flags", "parent", "location", "anchor", "home", "writable_owner", "writable_self"]);
      const ownerList = tierFor("writable_owner");
      const selfList = tierFor("writable_self");
      for (const list of [ownerList, selfList]) {
        if (!list) continue;
        for (const name of list) {
          if (reserved.has(name)) issues.push(`${classDef.local_name}: tier may not include reserved property "${name}"`);
          if (!declared.has(name)) issues.push(`${classDef.local_name}: tier references undeclared property "${name}"`);
        }
      }
      if (ownerList && selfList) {
        const overlap = ownerList.filter((n) => selfList.includes(n));
        for (const n of overlap) issues.push(`${classDef.local_name}: property "${n}" appears in both writable_owner and writable_self`);
      }
      return issues;
    }

    it("lint catches reserved-name / duplicate / overlap / undeclared / non-list tier defaults", () => {
      const baseProps = [{ name: "foo" }, { name: "bar" }];
      expect(lintTiers({ local_name: "$x", properties: [...baseProps, { name: "writable_owner", default: ["foo", "missing"] }] }))
        .toEqual(expect.arrayContaining([expect.stringMatching(/undeclared property "missing"/)]));
      expect(lintTiers({ local_name: "$x", properties: [...baseProps, { name: "writable_owner", default: ["foo", "name"] }] }))
        .toEqual(expect.arrayContaining([expect.stringMatching(/reserved property "name"/)]));
      expect(lintTiers({ local_name: "$x", properties: [...baseProps, { name: "writable_owner", default: ["foo", "foo"] }] }))
        .toEqual(expect.arrayContaining([expect.stringMatching(/duplicate "foo"/)]));
      expect(lintTiers({ local_name: "$x", properties: [...baseProps, { name: "writable_owner", default: ["foo"] }, { name: "writable_self", default: ["foo"] }] }))
        .toEqual(expect.arrayContaining([expect.stringMatching(/both writable_owner and writable_self/)]));
      expect(lintTiers({ local_name: "$x", properties: [...baseProps, { name: "writable_owner", default: "not a list" }] }))
        .toEqual(expect.arrayContaining([expect.stringMatching(/must be a list<str>/)]));
      // Same-manifest parent property satisfies the declared check.
      expect(lintTiers(
        { local_name: "$sub", properties: [{ name: "bar" }, { name: "writable_owner", default: ["foo", "bar"] }] },
        new Set(["foo"])
      )).toEqual([]);
      // Well-formed.
      expect(lintTiers({ local_name: "$ok", properties: [...baseProps, { name: "writable_owner", default: ["foo"] }, { name: "writable_self", default: ["bar"] }] }))
        .toEqual([]);
    });

    it("guards every bundled catalog: tier defaults are well-formed", () => {
      // Catalog-wide guard. Each class with a writable_owner / writable_self
      // property must have a well-formed default. Inherited names from
      // same-catalog parents satisfy the "declared" check; cross-catalog
      // parents (e.g. $weather_block extends $block) lint without the
      // undeclared check since the parent isn't in the same manifest.
      for (const catalogName of readdirSync(root).filter((entry) => existsSync(join(root, entry, "manifest.json")))) {
        const manifest = readManifest(catalogName);
        const classes = [...(manifest.classes ?? []), ...(manifest.features ?? [])] as Array<{ local_name: string; parent?: string; properties?: { name: string; default?: unknown }[] }>;
        const declaredByName = new Map<string, Set<string>>();
        for (const cls of classes) declaredByName.set(cls.local_name, new Set((cls.properties ?? []).map((p) => p.name)));
        for (const cls of classes) {
          const ancestorProps = new Set<string>();
          let parent: string | undefined = cls.parent;
          while (parent && declaredByName.has(parent)) {
            for (const p of declaredByName.get(parent)!) ancestorProps.add(p);
            parent = classes.find((c) => c.local_name === parent)?.parent;
          }
          const issues = lintTiers(cls, ancestorProps);
          // Skip "undeclared" complaints when the parent chain leaves this
          // catalog — the lint can't see across manifests.
          const fullyLocal = !cls.parent || declaredByName.has(cls.parent);
          const filtered = fullyLocal ? issues : issues.filter((m) => !/undeclared property/.test(m));
          expect(filtered, `${catalogName}/${cls.local_name}`).toEqual([]);
        }
      }
    });

    it("$block base catalog enforces tier-gated set_property", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["block"]);
      // Test subclass: place is owner-tier, current is self-tier (the
      // writable_self list extends the base $block list per authoring
      // convention — declared as ordinary property defaults).
      installCatalogManifest(world, {
        name: "test-block-sub",
        version: "0.1.0",
        spec_version: "v1",
        license: "MIT",
        classes: [{
          local_name: "$test_block",
          parent: "$block",
          properties: [
            { name: "place", type: "str", default: "" },
            { name: "current", type: "map", default: {} },
            { name: "writable_owner", type: "list<str>", default: ["place"] },
            { name: "writable_self", type: "list<str>", default: ["last_pushed_at", "last_error", "current"] }
          ]
        }]
      } as unknown as RuntimeCatalogManifest, { tap: "@local", alias: "test-block-sub" });

      // Place the block in a real $space so observe_to_space has a routable
      // audience for block_data observations.
      const roomId = "obj_test_block_room";
      world.createObject({ id: roomId, name: roomId, parent: "$space", owner: "$wiz", location: null });
      const ownerSess = world.auth("guest:block-owner");
      const owner = ownerSess.actor;
      const strangerSess = world.auth("guest:block-stranger");
      const stranger = strangerSess.actor;
      const blockId = "obj_test_block_alpha";
      world.createObject({ id: blockId, name: blockId, parent: "$test_block", owner, location: roomId });

      // Block actor needs an apikey-bound session of its own to act as itself.
      const key = world.createApiKey("$wiz", blockId, "test-self");
      const blockSess = world.auth(`apikey:${key.id}:${key.secret}`);
      expect(blockSess.actor).toBe(blockId);

      // 1. Owner writes writable_owner prop: succeeds.
      const ownerWrite = await world.directCall("set-place", owner, blockId, "set_property", ["place", "Mountain View, CA"]);
      if (ownerWrite.op === "error") throw new Error(`owner-writable-write failed: ${ownerWrite.error.code} ${ownerWrite.error.message}`);
      expect(ownerWrite.op).toBe("result");
      expect(world.getProp(blockId, "place")).toBe("Mountain View, CA");

      // 2. Owner attempts writable_self prop: E_PERM.
      const ownerOnSelf = await world.directCall("owner-on-self", owner, blockId, "set_property", ["current", { temp: 60 }]);
      expect(ownerOnSelf.op).toBe("error");
      if (ownerOnSelf.op === "error") expect(ownerOnSelf.error.code).toBe("E_PERM");

      // 3. Block actor (plug) writes writable_self prop: succeeds.
      const plugWrite = await world.directCall("plug-write", blockId, blockId, "set_property", ["current", { temp: 72, unit: "F" }]);
      expect(plugWrite.op).toBe("result");
      expect(world.getProp(blockId, "current")).toEqual({ temp: 72, unit: "F" });

      // 4. Block actor attempts writable_owner prop: E_PERM.
      const plugOnOwner = await world.directCall("plug-on-owner", blockId, blockId, "set_property", ["place", "elsewhere"]);
      expect(plugOnOwner.op).toBe("error");
      if (plugOnOwner.op === "error") expect(plugOnOwner.error.code).toBe("E_PERM");

      // 5. Stranger fails on both tiers.
      const strangerOwner = await world.directCall("stranger-owner", stranger, blockId, "set_property", ["place", "nope"]);
      expect(strangerOwner.op).toBe("error");
      if (strangerOwner.op === "error") expect(strangerOwner.error.code).toBe("E_PERM");
      const strangerSelf = await world.directCall("stranger-self", stranger, blockId, "set_property", ["current", {}]);
      expect(strangerSelf.op).toBe("error");
      if (strangerSelf.op === "error") expect(strangerSelf.error.code).toBe("E_PERM");

      // 6. Wizard bypasses both.
      const wizOwner = await world.directCall("wiz-owner", "$wiz", blockId, "set_property", ["place", "Wizardville"]);
      expect(wizOwner.op).toBe("result");
      const wizSelf = await world.directCall("wiz-self", "$wiz", blockId, "set_property", ["current", { temp: 100 }]);
      expect(wizSelf.op).toBe("result");

      // 7. block_data observation routes to location(this).
      expect(world.object(blockId).location).toBe(roomId);
      const obsCheck = await world.directCall("plug-write-obs", blockId, blockId, "set_property", ["current", { temp: 73 }]);
      expect(obsCheck.op).toBe("result");
      if (obsCheck.op === "result") {
        const blockObs = obsCheck.observations.find((o) => o.type === "block_data");
        expect(blockObs).toMatchObject({ type: "block_data", block: blockId, name: "current" });
      }
    });

    it("$block:get_data returns the live property value", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["block"]);
      const blockId = "obj_test_block_get";
      world.createObject({ id: blockId, name: blockId, parent: "$block", owner: "$wiz", location: "$nowhere" });
      world.setProp(blockId, "last_pushed_at", 12345);
      const result = await world.directCall("get-data", "$wiz", blockId, "get_data", ["last_pushed_at"]);
      expect(result.op).toBe("result");
      if (result.op === "result") expect(result.result).toBe(12345);
    });

    it("$block:moveto raises E_PERM for non-wizards and :acceptable returns false", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["block"]);
      const ownerSess = world.auth("guest:block-anchor-owner");
      const owner = ownerSess.actor;
      const blockId = "obj_test_block_anchor";
      world.createObject({ id: blockId, name: blockId, parent: "$block", owner, location: "$nowhere" });
      const blocked = await world.directCall("anchor-move", owner, blockId, "moveto", ["$nowhere"]);
      expect(blocked.op).toBe("error");
      if (blocked.op === "error") expect(blocked.error.code).toBe("E_PERM");
      const accept = await world.directCall("anchor-accept", owner, blockId, "acceptable", ["some_thing"]);
      expect(accept.op).toBe("result");
      if (accept.op === "result") expect(accept.result).toBe(false);
    });

    it("$block:mint_apikey lets the owner mint, and the resulting key authenticates as the block", () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["block"]);
      const ownerSess = world.auth("guest:block-mint-owner");
      const owner = ownerSess.actor;
      const blockId = "obj_test_block_mint";
      world.createObject({ id: blockId, name: blockId, parent: "$block", owner, location: "$nowhere" });
      // Owner mints.
      const minted = world.directCall("mint-key", owner, blockId, "mint_apikey", ["primary"]);
      // Note: directCall returns synchronously here because mint_apikey is a verb that calls a substrate native.
      // The result shape mirrors $system:create_api_key_for_owner.
      return minted.then((res) => {
        expect(res.op).toBe("result");
        if (res.op !== "result") return;
        const key = res.result as { id: string; secret: string; actor: string };
        expect(key.actor).toBe(blockId);
        const sess = world.auth(`apikey:${key.id}:${key.secret}`);
        expect(sess.actor).toBe(blockId);
      });
    });

    it("$dispenser_block: order → next_pending → deliver flows end-to-end", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["dispenser"]);
      const roomId = "obj_test_disp_room";
      world.createObject({ id: roomId, name: roomId, parent: "$space", owner: "$wiz", location: null });
      const ownerSess = world.auth("guest:disp-owner");
      const owner = ownerSess.actor;
      const blockId = "obj_test_disp_block";
      world.createObject({ id: blockId, name: blockId, parent: "$dispenser_block", owner, location: roomId });
      world.setProp(blockId, "rate_limit_seconds", 0);
      world.setProp(blockId, "block_cooldown_seconds", 0);

      const requesterSess = world.auth("guest:disp-requester");
      const requester = requesterSess.actor;

      // 1. Public :order returns a ticket synchronously, queues the entry,
      //    and emits an order_placed observation.
      const ordered = await world.directCall("disp-order", requester, blockId, "order", ["scorpio"]);
      expect(ordered.op).toBe("result");
      if (ordered.op !== "result") return;
      const orderResult = ordered.result as { order_id: string; queued: boolean; text: string };
      expect(orderResult.queued).toBe(true);
      expect(orderResult.order_id).toMatch(/^ord_\d+$/);
      expect(orderResult.text).toContain("accepts your order");
      const orderPlaced = ordered.observations.find((o) => o.type === "order_placed");
      expect(orderPlaced).toMatchObject({ type: "order_placed", block: blockId, requester, request: "scorpio", text: expect.stringContaining("accepts your order") });
      expect(ordered.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", target: requester, text: expect.stringContaining("accepts your order") })
      ]));
      expect((world.getProp(blockId, "pending_orders") as unknown[]).length).toBe(1);

      // 2. Plug authenticates as the block actor and reads next_pending.
      const key = world.createApiKey("$wiz", blockId, "test-plug");
      const plugSess = world.auth(`apikey:${key.id}:${key.secret}`);
      expect(plugSess.actor).toBe(blockId);
      const next = await world.directCall("disp-next", blockId, blockId, "next_pending", []);
      expect(next.op).toBe("result");
      if (next.op !== "result") return;
      expect(next.result).toMatchObject({ order_id: orderResult.order_id, requester, request: "scorpio" });

      // 3. Plug delivers — note lands in requester's inventory with name +
      //    description (cosmetic look-at flavour) + body. Per LambdaCore
      //    $note, .description is what `look` shows; .text is what `read`
      //    returns.
      const delivered = await world.directCall("disp-deliver", blockId, blockId, "deliver", [
        orderResult.order_id,
        "Horoscope: Scorpio",
        "Today's horoscope: avoid llamas.",
        "A horoscope reading for scorpio."
      ]);
      expect(delivered.op).toBe("result");
      if (delivered.op !== "result") return;
      const dRes = delivered.result as { delivered: boolean; note: string; text: string };
      expect(dRes.delivered).toBe(true);
      expect(dRes.text).toContain("delivers a note to your inventory");
      expect(world.object(dRes.note).location).toBe(requester);
      expect(world.object(dRes.note).name).toBe("Horoscope: Scorpio");
      expect(world.getProp(dRes.note, "description")).toBe("A horoscope reading for scorpio.");
      expect(world.getProp(dRes.note, "text")).toBe("Today's horoscope: avoid llamas.");
      expect(world.getProp(dRes.note, "produced_by")).toBe(blockId);
      expect(delivered.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", target: requester, text: expect.stringContaining("delivers a note to your inventory") }),
        expect.objectContaining({ type: "delivered", block: blockId, requester, note: dRes.note, text: expect.stringContaining("delivers a note to your inventory") })
      ]));
      expect((world.getProp(blockId, "pending_orders") as unknown[]).length).toBe(0);

      // 4. Idempotent re-deliver returns delivered:false.
      const redeliver = await world.directCall("disp-redeliver", blockId, blockId, "deliver", [orderResult.order_id, "Horoscope: Scorpio", "again"]);
      expect(redeliver.op).toBe("result");
      if (redeliver.op === "result") {
        const r = redeliver.result as { delivered: boolean; reason: string };
        expect(r.delivered).toBe(false);
        expect(r.reason).toBe("unknown_or_already_delivered");
      }

      // 5. Stranger cannot deliver someone else's order.
      const strangerSess = world.auth("guest:disp-stranger");
      const order2 = await world.directCall("disp-order-2", requester, blockId, "order", ["leo"]);
      expect(order2.op).toBe("result");
      if (order2.op !== "result") return;
      const strangerOrderId = (order2.result as { order_id: string }).order_id;
      const strangerDeliver = await world.directCall("stranger-deliver", strangerSess.actor, blockId, "deliver", [strangerOrderId, "Sneak", "haha"]);
      expect(strangerDeliver.op).toBe("error");
      if (strangerDeliver.op === "error") expect(strangerDeliver.error.code).toBe("E_PERM");

      // 6. The block actor (i.e. the plug authenticated via apikey) can
      //    cancel a pending order off the queue head. Without this, a
      //    poisoned order — e.g. one whose deliver verb keeps raising —
      //    would block every following order forever, since :next_pending
      //    only peeks.
      const plugCancel = await world.directCall("plug-cancel", blockId, blockId, "cancel", [strangerOrderId]);
      expect(plugCancel.op).toBe("result");
      if (plugCancel.op === "result") {
        expect(plugCancel.result).toMatchObject({ order_id: strangerOrderId, canceled: true });
      }
      expect((world.getProp(blockId, "pending_orders") as unknown[]).length).toBe(0);
    });

    it("$dispenser_block keeps queue internals out of public get_data", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["dispenser"]);
      const owner = world.auth("guest:disp-private-owner").actor;
      const requester = world.auth("guest:disp-private-requester").actor;
      const stranger = world.auth("guest:disp-private-stranger").actor;
      const blockId = "obj_test_disp_private";
      world.createObject({ id: blockId, name: blockId, parent: "$dispenser_block", owner, location: "$nowhere" });
      world.setProp(blockId, "rate_limit_seconds", 0);
      world.setProp(blockId, "block_cooldown_seconds", 0);

      const ordered = await world.directCall("private-order", requester, blockId, "order", ["private prompt"]);
      expect(ordered.op).toBe("result");

      const leaked = await world.directCall("private-leak", stranger, blockId, "get_data", ["pending_orders"]);
      expect(leaked.op).toBe("error");
      if (leaked.op === "error") expect(leaked.error.code).toBe("E_PERM");

      const ownerRead = await world.directCall("private-owner-read", owner, blockId, "get_data", ["pending_orders"]);
      expect(ownerRead.op).toBe("result");
      if (ownerRead.op === "result") expect(ownerRead.result).toMatchObject([{ request: "private prompt", requester }]);
    });

    it("$dispenser_block:order rate-limits per requester", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["dispenser"]);
      const roomId = "obj_test_disp_rate_room";
      world.createObject({ id: roomId, name: roomId, parent: "$space", owner: "$wiz", location: null });
      const ownerSess = world.auth("guest:disp-rate-owner");
      const owner = ownerSess.actor;
      const blockId = "obj_test_disp_rate_block";
      world.createObject({ id: blockId, name: blockId, parent: "$dispenser_block", owner, location: roomId });
      // Default 60s per-requester limit. Disable the block-wide cooldown so
      // we observe the per-actor branch in isolation.
      world.setProp(blockId, "block_cooldown_seconds", 0);
      const requesterSess = world.auth("guest:disp-rate-requester");
      const requester = requesterSess.actor;
      const first = await world.directCall("rate-1", requester, blockId, "order", ["aries"]);
      expect(first.op).toBe("result");
      const second = await world.directCall("rate-2", requester, blockId, "order", ["taurus"]);
      expect(second.op).toBe("error");
      if (second.op === "error") {
        expect(second.error.code).toBe("E_RATE_LIMIT");
        expect((second.error.value as { scope?: string; rate_limit_seconds?: number })?.scope).toBe("requester");
        expect((second.error.value as { scope?: string; rate_limit_seconds?: number })?.rate_limit_seconds).toBe(60);
      }
    });

    it("$dispenser_block:order enforces block-wide cooldown across distinct actors (defends against guest minting)", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["dispenser"]);
      const roomId = "obj_test_disp_block_cooldown_room";
      world.createObject({ id: roomId, name: roomId, parent: "$space", owner: "$wiz", location: null });
      const ownerSess = world.auth("guest:disp-cool-owner");
      const blockId = "obj_test_disp_block_cooldown";
      world.createObject({ id: blockId, name: blockId, parent: "$dispenser_block", owner: ownerSess.actor, location: roomId });
      world.setProp(blockId, "rate_limit_seconds", 0);
      // Default block_cooldown_seconds=5; first order primes last_order_at.
      const a = world.auth("guest:cool-a").actor;
      const b = world.auth("guest:cool-b").actor;
      const first = await world.directCall("cool-1", a, blockId, "order", ["one"]);
      expect(first.op).toBe("result");
      // Different actor inside the cooldown window must be rejected.
      const second = await world.directCall("cool-2", b, blockId, "order", ["two"]);
      expect(second.op).toBe("error");
      if (second.op === "error") {
        expect(second.error.code).toBe("E_RATE_LIMIT");
        expect((second.error.value as { scope?: string })?.scope).toBe("block");
      }
    });

    it("$dispenser_block:order rejects oversized requests and full queues", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["dispenser"]);
      const roomId = "obj_test_disp_caps_room";
      world.createObject({ id: roomId, name: roomId, parent: "$space", owner: "$wiz", location: null });
      const ownerSess = world.auth("guest:disp-caps-owner");
      const blockId = "obj_test_disp_caps";
      world.createObject({ id: blockId, name: blockId, parent: "$dispenser_block", owner: ownerSess.actor, location: roomId });
      world.setProp(blockId, "rate_limit_seconds", 0);
      world.setProp(blockId, "block_cooldown_seconds", 0);
      world.setProp(blockId, "max_request_chars", 16);
      world.setProp(blockId, "max_pending_orders", 2);

      const requester = world.auth("guest:caps-req").actor;
      const oversized = await world.directCall("caps-too-big", requester, blockId, "order", ["x".repeat(17)]);
      expect(oversized.op).toBe("error");
      if (oversized.op === "error") expect(oversized.error.code).toBe("E_INVARG");
      // Queue cap.
      for (let i = 0; i < 2; i++) {
        const r = await world.directCall(`caps-${i}`, requester, blockId, "order", [`o${i}`]);
        expect(r.op).toBe("result");
      }
      const overflow = await world.directCall("caps-overflow", requester, blockId, "order", ["nope"]);
      expect(overflow.op).toBe("error");
      if (overflow.op === "error") expect(overflow.error.code).toBe("E_QUEUE_FULL");
    });

    it("$dispenser_block keeps mutating queue helpers off the direct-call surface", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["dispenser"]);
      const owner = world.auth("guest:disp-helper-owner").actor;
      const requester = world.auth("guest:disp-helper-requester").actor;
      const blockId = "obj_test_disp_helpers";
      world.createObject({ id: blockId, name: blockId, parent: "$dispenser_block", owner, location: null });

      expect(world.verbInfo("$dispenser_block", "check_order_limits").direct_callable).toBe(false);
      expect(world.verbInfo("$dispenser_block", "enqueue_order").direct_callable).toBe(false);

      const direct = await world.directCall("helper-direct-denied", requester, blockId, "enqueue_order", ["bypass"]);
      expect(direct.op).toBe("error");
      if (direct.op === "error") expect(direct.error.code).toBe("E_DIRECT_DENIED");
      expect(world.getProp(blockId, "pending_orders")).toEqual([]);
    });

    it("$dispensed_note disperses in a puff of smoke when dropped into a $space via chat:drop", async () => {
      const world = createWorld();
      const roomId = "the_hot_tub";
      const ownerSess = world.auth("guest:puff-owner");
      const blockId = "obj_test_disp_puff_block";
      world.createObject({ id: blockId, name: "Vending Machine", parent: "$dispenser_block", owner: ownerSess.actor, location: roomId });
      world.setProp(blockId, "rate_limit_seconds", 0);
      world.setProp(blockId, "block_cooldown_seconds", 0);

      const requesterSess = world.auth("guest:puff-requester");
      const requester = requesterSess.actor;
      // Place the requester in the room so chat:drop can match the note in
      // their inventory. enter() is the standard entry point.
      const entered = await world.directCall("puff-enter", requester, roomId, "enter", []);
      expect(entered.op).toBe("result");

      const ordered = await world.directCall("puff-order", requester, blockId, "order", ["scorpio"]);
      expect(ordered.op).toBe("result");
      if (ordered.op !== "result") return;
      const orderId = (ordered.result as { order_id: string }).order_id;
      const key = world.createApiKey("$wiz", blockId, "test-puff-plug");
      world.auth(`apikey:${key.id}:${key.secret}`);
      const delivered = await world.directCall("puff-deliver", blockId, blockId, "deliver", [
        orderId,
        "Horoscope: Scorpio",
        "Avoid llamas today.",
        "A small folded slip."
      ]);
      expect(delivered.op).toBe("result");
      if (delivered.op !== "result") return;
      const noteId = (delivered.result as { note: string }).note;
      expect(world.object(noteId).location).toBe(requester);

      // The real `drop` path: chat:drop is the user-facing verb on $room.
      const dropped = await world.directCall("puff-drop", requester, roomId, "drop", ["Horoscope: Scorpio"]);
      expect(dropped.op).toBe("result");
      if (dropped.op !== "result") return;
      expect((dropped.result as { recycled?: boolean }).recycled).toBe(true);

      // The note is gone (recycled), a `note_dispersed` observation describes
      // the puff to the room, and chat:drop suppressed its `dropped`
      // observation and "You drop X." tell so the room sees one chat line,
      // not two.
      expect(world.objects.has(noteId)).toBe(false);
      const dispersed = dropped.observations.find((o) => o.type === "note_dispersed");
      expect(dispersed).toMatchObject({ type: "note_dispersed", note: noteId, room: roomId, actor: requester });
      expect(String((dispersed as { text?: string }).text ?? "")).toContain("puff of smoke");
      expect(String((dispersed as { text?: string }).text ?? "")).toContain("Horoscope: Scorpio");
      expect(dropped.observations.some((o) => o.type === "dropped")).toBe(false);
      expect(dropped.observations.some((o) => o.type === "text" && (o as { target?: string }).target === requester && String((o as { text?: string }).text ?? "").startsWith("You drop"))).toBe(false);
    });

    it("$dispensed_note moves normally between non-space targets (e.g. handed to another actor)", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["dispenser"]);
      const roomId = "obj_test_disp_handoff_room";
      world.createObject({ id: roomId, name: "Lobby", parent: "$space", owner: "$wiz", location: null });
      const ownerSess = world.auth("guest:handoff-owner");
      const blockId = "obj_test_disp_handoff_block";
      world.createObject({ id: blockId, name: "Vending", parent: "$dispenser_block", owner: ownerSess.actor, location: roomId });
      world.setProp(blockId, "rate_limit_seconds", 0);
      world.setProp(blockId, "block_cooldown_seconds", 0);

      const aliceSess = world.auth("guest:handoff-alice");
      const bobSess = world.auth("guest:handoff-bob");
      const ordered = await world.directCall("handoff-order", aliceSess.actor, blockId, "order", ["leo"]);
      expect(ordered.op).toBe("result");
      if (ordered.op !== "result") return;
      const orderId = (ordered.result as { order_id: string }).order_id;
      const key = world.createApiKey("$wiz", blockId, "test-handoff-plug");
      world.auth(`apikey:${key.id}:${key.secret}`);
      const delivered = await world.directCall("handoff-deliver", blockId, blockId, "deliver", [orderId, "Horoscope: Leo", "Roar.", null]);
      expect(delivered.op).toBe("result");
      if (delivered.op !== "result") return;
      const noteId = (delivered.result as { note: string }).note;
      expect(world.object(noteId).location).toBe(aliceSess.actor);

      // Wizard helper to drive the moveto chain across the actor->actor
      // hand-off (no chat verb covers this case yet).
      installVerb(world, "$wiz", "give_for_test", `verb :give_for_test(item, recipient) rxd { return moveto(item, recipient); }`, null);
      const handed = await world.directCall("handoff-give", aliceSess.actor, "$wiz", "give_for_test", [noteId, bobSess.actor]);
      expect(handed.op).toBe("result");
      // Note still exists, just changed location.
      expect(world.objects.has(noteId)).toBe(true);
      expect(world.object(noteId).location).toBe(bobSess.actor);
      expect(handed.op === "result" && handed.observations.some((o) => o.type === "note_dispersed")).toBe(false);
    });

    it("$dispensed_note:moveto is not a public direct-callable surface", async () => {
      // Lockdown: a REST/MCP caller who knows a dispensed-note id must not be
      // able to recycle or move it by calling :moveto directly. The verb is
      // dispatched only from the substrate's moveto chain (drop/give).
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["dispenser"]);
      const roomId = "obj_test_disp_lockdown_room";
      world.createObject({ id: roomId, name: "Vault", parent: "$space", owner: "$wiz", location: null });
      const ownerSess = world.auth("guest:lock-owner");
      const blockId = "obj_test_disp_lockdown_block";
      world.createObject({ id: blockId, name: "Vending", parent: "$dispenser_block", owner: ownerSess.actor, location: roomId });
      world.setProp(blockId, "rate_limit_seconds", 0);
      world.setProp(blockId, "block_cooldown_seconds", 0);

      const aliceSess = world.auth("guest:lock-alice");
      const ordered = await world.directCall("lock-order", aliceSess.actor, blockId, "order", ["aries"]);
      expect(ordered.op).toBe("result");
      if (ordered.op !== "result") return;
      const orderId = (ordered.result as { order_id: string }).order_id;
      const key = world.createApiKey("$wiz", blockId, "test-lock-plug");
      world.auth(`apikey:${key.id}:${key.secret}`);
      const delivered = await world.directCall("lock-deliver", blockId, blockId, "deliver", [orderId, "Horoscope: Aries", "Charge ahead.", null]);
      expect(delivered.op).toBe("result");
      if (delivered.op !== "result") return;
      const noteId = (delivered.result as { note: string }).note;

      const stranger = world.auth("guest:lock-stranger");
      const attack = await world.directCall("lock-attack", stranger.actor, noteId, "moveto", [roomId]);
      expect(attack.op).toBe("error");
      if (attack.op === "error") expect(attack.error.code).toBe("E_DIRECT_DENIED");
      expect(world.objects.has(noteId)).toBe(true);
    });

    it("blocks-demo seeds visible weather and horoscope blocks with useful look output", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["blocks-demo"]);
      // Weather panel: anchored in the chatroom, default config matches manifest seed.
      expect(world.objects.has("the_weather")).toBe(true);
      expect(world.object("the_weather").parent).toBe("$weather_block");
      expect(world.object("the_weather").location).toBe("the_chatroom");
      expect(world.object("the_weather").anchor).toBe("the_chatroom");
      expect(world.getProp("the_weather", "place")).toBe("Mountain View CA");
      expect(world.getProp("the_weather", "timezone")).toBe("America/Los_Angeles");
      expect(world.getProp("the_weather", "units")).toBe("imperial");
      expect(world.getProp("the_weather", "forecast_hours")).toBe(12);
      world.setProp("the_weather", "current", { kind: "scalar", value: 72, unit: "°F", label: "current_temperature", observed_at: "2026-05-06T16:01:00Z", observed_at_text: "May 6, 2026, 9:01 AM PDT", observed_timezone: "America/Los_Angeles" });
      world.setProp("the_weather", "last_pushed_at", 1778073000000);
      const weatherLook = await world.directCall("blocks-weather-look", "$wiz", "the_weather", "look_self", []);
      expect(weatherLook.op).toBe("result");
      if (weatherLook.op === "result") {
        expect(weatherLook.result).toMatchObject({
          title: "Temperature in Mountain View CA: 72°F",
          last_updated: "May 6, 2026, 9:01 AM PDT",
          last_updated_text: "May 6, 2026, 9:01 AM PDT",
          description: "The weather panel shows that the temperature in Mountain View CA was 72°F at May 6, 2026, 9:01 AM PDT."
        });
      }
      const roomLook = await world.directCall("blocks-room-look", "$wiz", "the_chatroom", "look", []);
      expect(roomLook.op).toBe("result");
      if (roomLook.op === "result") {
        expect(roomLook.result).toMatchObject({
          contents: expect.arrayContaining([
            expect.objectContaining({ id: "the_weather", title: "Temperature in Mountain View CA: 72°F" })
          ])
        });
      }
      const lookWeatherCommand = await world.directCall("blocks-look-weather-command", "$wiz", "the_chatroom", "command", ["look weather"]);
      expect(lookWeatherCommand.op).toBe("result");
      if (lookWeatherCommand.op === "result") {
        expect(lookWeatherCommand.result).toMatchObject({ id: "the_weather" });
        expect(lookWeatherCommand.observations.find((obs) => obs.type === "looked")).toMatchObject({
          room: "the_chatroom",
          target: "the_weather",
          text: "The weather panel shows that the temperature in Mountain View CA was 72°F at May 6, 2026, 9:01 AM PDT."
        });
      }
      // Horoscope machine: anchored on the deck, default rate limit + persona.
      expect(world.objects.has("the_horoscope")).toBe(true);
      expect(world.object("$horoscope_block").flags.fertile).toBe(true);
      expect(world.object("the_horoscope").parent).toBe("$horoscope_block");
      expect(world.object("the_horoscope").location).toBe("the_deck");
      expect(world.object("the_horoscope").anchor).toBe("the_deck");
      expect(world.getProp("the_horoscope", "rate_limit_seconds")).toBe(60);
      expect(world.getProp("the_horoscope", "system_prompt")).toMatch(/fortune-teller/i);
      const horoscopeLook = await world.directCall("blocks-horoscope-look", "$wiz", "the_horoscope", "look_self", []);
      expect(horoscopeLook.op).toBe("result");
      if (horoscopeLook.op === "result") {
        expect(horoscopeLook.result).toMatchObject({
          status: "disconnected",
          connected: false,
          usage: expect.stringContaining("order Horoscope machine <sign or topic>")
        });
      }
      const orderPlan = await world.directCall("blocks-horoscope-order-plan", "$wiz", "the_deck", "command_plan", ["order horoscope scorpio"]);
      expect(orderPlan.op).toBe("result");
      if (orderPlan.op === "result") {
        expect(orderPlan.result).toMatchObject({ ok: true, target: "the_horoscope", verb: "order", args: ["scorpio"] });
      }
    });

    it("$horoscope_block inherits the dispenser surface end-to-end", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["horoscope"]);
      const roomId = "obj_test_horo_room";
      world.createObject({ id: roomId, name: roomId, parent: "$space", owner: "$wiz", location: null });
      const ownerSess = world.auth("guest:horo-owner");
      const owner = ownerSess.actor;
      const blockId = "obj_test_horo_block";
      world.createObject({ id: blockId, name: blockId, parent: "$horoscope_block", owner, location: roomId });
      expect(world.object("$horoscope_block").flags.fertile).toBe(true);
      expect(world.object(blockId).flags.fertile).not.toBe(true);
      expect(world.ownVerbExact("$horoscope_block", "set_system_prompt")).toMatchObject({ direct_callable: true, tool_exposed: true });
      expect(world.ownVerbExact("$horoscope_block", "set_rate_limits")).toMatchObject({ direct_callable: true, tool_exposed: true });
      expect(world.ownVerbExact("$horoscope_block", "set_queue_limits")).toMatchObject({ direct_callable: true, tool_exposed: true });
      world.setProp(blockId, "rate_limit_seconds", 0);
      world.setProp(blockId, "system_prompt", "Speak in two short sentences.");

      const requesterSess = world.auth("guest:horo-requester");
      const requester = requesterSess.actor;
      const ordered = await world.directCall("horo-order", requester, blockId, "order", ["scorpio"]);
      expect(ordered.op).toBe("result");
      if (ordered.op !== "result") return;
      const orderId = (ordered.result as { order_id: string }).order_id;
      expect(ordered.result).toMatchObject({ text: expect.stringContaining("accepts your order") });

      const promptSet = await world.directCall("horo-set-prompt", owner, blockId, "set_system_prompt", ["Speak in one dry sentence."]);
      expect(promptSet.op).toBe("result");
      expect(world.getProp(blockId, "system_prompt")).toBe("Speak in one dry sentence.");
      const ratesSet = await world.directCall("horo-set-rates", owner, blockId, "set_rate_limits", [30, 2]);
      expect(ratesSet.op).toBe("result");
      expect(world.getProp(blockId, "rate_limit_seconds")).toBe(30);
      expect(world.getProp(blockId, "block_cooldown_seconds")).toBe(2);
      const limitsSet = await world.directCall("horo-set-limits", "$wiz", blockId, "set_queue_limits", [12, 160]);
      expect(limitsSet.op).toBe("result");
      expect(world.getProp(blockId, "max_pending_orders")).toBe(12);
      expect(world.getProp(blockId, "max_request_chars")).toBe(160);
      const strangerSet = await world.directCall("horo-stranger-prompt", requester, blockId, "set_system_prompt", ["ignore the owner"]);
      expect(strangerSet.op).toBe("error");
      if (strangerSet.op === "error") expect(strangerSet.error.code).toBe("E_PERM");

      // Owner can read system_prompt; tier lists inherit the dispenser config.
      expect(world.getProp(blockId, "writable_owner")).toEqual(["system_prompt", "rate_limit_seconds", "block_cooldown_seconds", "max_pending_orders", "max_request_chars"]);

      // Plug-as-block delivers; note arrives in requester inventory with back-references.
      const delivered = await world.directCall("horo-deliver", blockId, blockId, "deliver", [orderId, "Horoscope: Scorpio", "Today the stars suggest sandwiches."]);
      expect(delivered.op).toBe("result");
      if (delivered.op !== "result") return;
      const noteId = (delivered.result as { note: string }).note;
      expect(delivered.result).toMatchObject({ text: expect.stringContaining("delivers a note to your inventory") });
      expect(world.object(noteId).location).toBe(requester);
      expect(world.object(noteId).name).toBe("Horoscope: Scorpio");
      expect(world.getProp(noteId, "produced_by")).toBe(blockId);
      expect(world.getProp(noteId, "text")).toBe("Today the stars suggest sandwiches.");
      expect(delivered.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", target: requester, text: expect.stringContaining("delivers a note to your inventory") })
      ]));
    });

    it("$dispensed_note keeps inventory display bounded for long single-line bodies", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["horoscope"]);
      const roomId = "obj_test_horo_long_room";
      world.createObject({ id: roomId, name: roomId, parent: "$space", owner: "$wiz", location: null });
      const requester = world.auth("guest:horo-long-requester").actor;
      const blockId = "obj_test_horo_long_block";
      world.createObject({ id: blockId, name: blockId, parent: "$horoscope_block", owner: "$wiz", location: roomId });
      world.setProp(blockId, "rate_limit_seconds", 0);
      world.setProp(blockId, "block_cooldown_seconds", 0);

      const ordered = await world.directCall("horo-long-order", requester, blockId, "order", ["gemini"]);
      expect(ordered.op).toBe("result");
      if (ordered.op !== "result") return;
      const orderId = (ordered.result as { order_id: string }).order_id;
      // v2 caps $note.text at 262144 chars in :set_text. The dispenser
      // routes text through that verb, so an oversize body fails at the
      // producer instead of leaking into the requester's inventory.
      const huge = "Gemini ".repeat(180_000);
      const delivered = await world.directCall("horo-long-deliver", blockId, blockId, "deliver", [orderId, "Horoscope: Gemini", huge]);
      expect(delivered.op).toBe("error");
      if (delivered.op === "error") expect(delivered.error.code).toBe("E_INVARG");
      // No note minted; inventory stays clean.
      const inventory = await world.directCall("horo-long-inventory", requester, requester, "inventory", []);
      expect(inventory.op).toBe("result");
      if (inventory.op !== "result") return;
      const result = inventory.result as { items: Array<{ id: string; title: string }>; text: string };
      expect(result.items).toEqual([]);
    });

    it("$note text_summary is overridable, and look_self honours the override", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["note"]);
      const requester = world.auth("guest:redacted-note-reader").actor;
      const noteClass = "obj_test_redacted_note_class";
      world.createObject({ id: noteClass, name: "$redacted_note", parent: "$note", owner: "$wiz", location: null });
      expect(installVerb(world, noteClass, "text_summary", `verb :text_summary(limit) rxd {
        return { lines: 7, length: 0, preview: "REDACTED", truncated: true };
      }`, null).ok).toBe(true);

      const noteId = "obj_test_redacted_note";
      world.createObject({ id: noteId, name: "Private note", parent: noteClass, owner: "$wiz", location: requester });
      world.setProp(noteId, "text", "secret ".repeat(20_000));

      // The override wins for any direct caller of :text_summary.
      const summary = await world.directCall("redacted-note-summary", requester, noteId, "text_summary", [96]);
      expect(summary.op).toBe("result");
      if (summary.op === "result") {
        expect(summary.result).toMatchObject({ lines: 7, preview: "REDACTED", truncated: true });
      }

      // look_self routes through :text_summary, so a redacted override
      // surfaces 0 instead of the raw secret length.
      const looked = await world.directCall("redacted-note-look", requester, noteId, "look_self", []);
      expect(looked.op).toBe("result");
      if (looked.op === "result") {
        expect(looked.result).toMatchObject({ id: noteId, text_length: 0 });
      }
    });

    it("dispatch with max_chars raises E_TOOBIG on oversize string returns and passes through within bound", async () => {
      const world = createWorld({ catalogs: false });
      const actor = world.auth("guest:bounded-dispatch").actor;
      const target = "obj_test_bounded_dispatch_target";
      world.createObject({ id: target, name: "target", parent: "$thing", owner: "$wiz", location: actor });
      expect(installVerb(world, target, "long_string", `verb :long_string() rxd {
        let s = "";
        let i = 0;
        while (i < 200) { s = s + "abcdefghij"; i = i + 1; }
        return s;
      }`, null).ok).toBe(true);
      expect(installVerb(world, target, "short_string", `verb :short_string() rxd { return "ok"; }`, null).ok).toBe(true);
      expect(installVerb(world, target, "structured", `verb :structured() rxd { return { kind: "map", n: 1 }; }`, null).ok).toBe(true);

      expect(installVerb(world, actor, "probe_oversize", `verb :probe_oversize() rxd {
        return dispatch(this:get_target(), "long_string", [], null, 96);
      }`, null).ok).toBe(true);
      expect(installVerb(world, actor, "probe_within", `verb :probe_within() rxd {
        return dispatch(this:get_target(), "short_string", [], null, 96);
      }`, null).ok).toBe(true);
      expect(installVerb(world, actor, "probe_nonstring", `verb :probe_nonstring() rxd {
        return dispatch(this:get_target(), "structured", [], null, 8);
      }`, null).ok).toBe(true);
      expect(installVerb(world, actor, "get_target", `verb :get_target() rxd { return "${target}"; }`, null).ok).toBe(true);

      const oversize = await world.directCall("bounded-dispatch-oversize", actor, actor, "probe_oversize", []);
      expect(oversize.op).toBe("error");
      if (oversize.op === "error") expect(oversize.error.code).toBe("E_TOOBIG");

      const within = await world.directCall("bounded-dispatch-within", actor, actor, "probe_within", []);
      expect(within.op).toBe("result");
      if (within.op === "result") expect(within.result).toBe("ok");

      const nonstring = await world.directCall("bounded-dispatch-nonstring", actor, actor, "probe_nonstring", []);
      expect(nonstring.op).toBe("result");
      if (nonstring.op === "result") expect(nonstring.result).toEqual({ kind: "map", n: 1 });
    });

    it("dispatch max_chars edge cases: zero, negative, and target-in-error", async () => {
      const world = createWorld({ catalogs: false });
      const actor = world.auth("guest:bounded-dispatch-edges").actor;
      const target = "obj_test_bounded_dispatch_edges_target";
      world.createObject({ id: target, name: "target", parent: "$thing", owner: "$wiz", location: actor });
      expect(installVerb(world, target, "empty", `verb :empty() rxd { return ""; }`, null).ok).toBe(true);
      expect(installVerb(world, target, "one", `verb :one() rxd { return "x"; }`, null).ok).toBe(true);
      expect(installVerb(world, actor, "get_target", `verb :get_target() rxd { return "${target}"; }`, null).ok).toBe(true);
      expect(installVerb(world, actor, "probe_zero_empty", `verb :probe_zero_empty() rxd {
        return dispatch(this:get_target(), "empty", [], null, 0);
      }`, null).ok).toBe(true);
      expect(installVerb(world, actor, "probe_zero_nonempty", `verb :probe_zero_nonempty() rxd {
        return dispatch(this:get_target(), "one", [], null, 0);
      }`, null).ok).toBe(true);
      expect(installVerb(world, actor, "probe_negative", `verb :probe_negative() rxd {
        return dispatch(this:get_target(), "empty", [], null, -1);
      }`, null).ok).toBe(true);

      const zeroEmpty = await world.directCall("bounded-edge-zero-empty", actor, actor, "probe_zero_empty", []);
      expect(zeroEmpty.op).toBe("result");
      if (zeroEmpty.op === "result") expect(zeroEmpty.result).toBe("");

      const zeroNonempty = await world.directCall("bounded-edge-zero-nonempty", actor, actor, "probe_zero_nonempty", []);
      expect(zeroNonempty.op).toBe("error");
      if (zeroNonempty.op === "error") {
        expect(zeroNonempty.error.code).toBe("E_TOOBIG");
        expect(zeroNonempty.error.value).toMatchObject({ target, verb: "one", size: 1, max: 0 });
      }

      const negative = await world.directCall("bounded-edge-negative", actor, actor, "probe_negative", []);
      expect(negative.op).toBe("error");
      if (negative.op === "error") expect(negative.error.code).toBe("E_INVARG");
    });


    it("dispatch max_chars caps list-of-strings by total character footprint", async () => {
      const world = createWorld({ catalogs: false });
      const actor = world.auth("guest:bounded-list").actor;
      const target = "obj_test_bounded_list_target";
      world.createObject({ id: target, name: "target", parent: "$thing", owner: "$wiz", location: actor });
      expect(installVerb(world, target, "tiny_list", `verb :tiny_list() rxd { return ["a", "b", "c"]; }`, null).ok).toBe(true);
      // 100 strings of 32 chars = 3200 chars — exceeds a 1024 cap.
      expect(installVerb(world, target, "fat_list", `verb :fat_list() rxd {
        let out = [];
        let i = 0;
        while (i < 100) { out = out + ["abcdefghijabcdefghijabcdefghij12"]; i = i + 1; }
        return out;
      }`, null).ok).toBe(true);
      // List with non-string elements — those don't count toward the bound.
      expect(installVerb(world, target, "mixed_list", `verb :mixed_list() rxd { return [1, 2, "ok", null]; }`, null).ok).toBe(true);
      expect(installVerb(world, actor, "get_target", `verb :get_target() rxd { return "${target}"; }`, null).ok).toBe(true);
      expect(installVerb(world, actor, "probe_tiny", `verb :probe_tiny() rxd { return dispatch(this:get_target(), "tiny_list", [], null, 1024); }`, null).ok).toBe(true);
      expect(installVerb(world, actor, "probe_fat", `verb :probe_fat() rxd { return dispatch(this:get_target(), "fat_list", [], null, 1024); }`, null).ok).toBe(true);
      expect(installVerb(world, actor, "probe_mixed", `verb :probe_mixed() rxd { return dispatch(this:get_target(), "mixed_list", [], null, 8); }`, null).ok).toBe(true);

      const tiny = await world.directCall("list-bound-tiny", actor, actor, "probe_tiny", []);
      expect(tiny.op).toBe("result");
      if (tiny.op === "result") expect(tiny.result).toEqual(["a", "b", "c"]);

      const fat = await world.directCall("list-bound-fat", actor, actor, "probe_fat", []);
      expect(fat.op).toBe("error");
      if (fat.op === "error") {
        expect(fat.error.code).toBe("E_TOOBIG");
        expect(fat.error.value).toMatchObject({ target, verb: "fat_list", max: 1024 });
      }

      const mixed = await world.directCall("list-bound-mixed", actor, actor, "probe_mixed", []);
      expect(mixed.op).toBe("result");
      if (mixed.op === "result") expect(mixed.result).toEqual([1, 2, "ok", null]);
    });

    it("$actor descendants that aren't $player render as room contents, not as present actors", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["chat"]);
      const roomId = "obj_test_actor_display_room";
      world.createObject({ id: roomId, name: "Demo Room", parent: "$room", owner: "$wiz" });
      const presentPlayer = world.auth("guest:actor-display-test").actor;
      world.setProp(presentPlayer, "location", roomId);
      world.setProp(roomId, "subscribers", [presentPlayer]);
      // An $actor that is not a $player — apikey-bound principal that should
      // render as a thing in the room, not as a person standing in it.
      const objectActor = "obj_test_actor_not_player";
      world.createObject({ id: objectActor, name: "Helpdesk Bot", parent: "$actor", owner: "$wiz", location: roomId });

      const looked = await world.directCall("actor-display-look", presentPlayer, roomId, "look_self", []);
      expect(looked.op).toBe("result");
      if (looked.op !== "result") return;
      const view = looked.result as { contents: Array<{ id: string }>; present_actors?: string[] };
      expect(view.contents.map((c) => c.id)).toContain(objectActor);
      if (Array.isArray(view.present_actors)) {
        expect(view.present_actors).not.toContain(objectActor);
      }
    });

    it("$room:look_at omits the looking actor from the Present: text", async () => {
      const world = createWorld();
      const looker = world.auth("guest:look-at-present-self").actor;
      const witness = world.auth("guest:look-at-present-other").actor;
      world.setProp(looker, "name", "Looker McLook");
      world.setProp(witness, "name", "Witness McSee");
      const enterLooker = await world.directCall("enter-looker", looker, "the_chatroom", "enter", []);
      const enterWitness = await world.directCall("enter-witness", witness, "the_chatroom", "enter", []);
      expect(enterLooker.op).toBe("result");
      expect(enterWitness.op).toBe("result");

      const looked = await world.directCall("look-at-room-from-looker", looker, "the_chatroom", "look_at", ["the_chatroom"]);
      expect(looked.op).toBe("result");
      if (looked.op !== "result") return;
      const obs = looked.observations.find((o) => o.type === "looked");
      expect(obs).toBeDefined();
      const text = String(obs?.text ?? "");
      const presentMatch = text.match(/Present: ([^.]*)\./);
      expect(presentMatch).not.toBeNull();
      const presentNames = (presentMatch?.[1] ?? "").split(",").map((s) => s.trim());
      expect(presentNames).toContain("Witness McSee");
      expect(presentNames).not.toContain("Looker McLook");
    });

    it(":match_names() is zero-arg and uses the verb-frame `actor` global, contributing actor-sensitive keywords", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["chat"]);
      const roomId = "obj_test_match_extension_room";
      world.createObject({ id: roomId, name: "Match Room", parent: "$room", owner: "$wiz" });
      const insider = world.auth("guest:match-insider").actor;
      const outsider = world.auth("guest:match-outsider").actor;
      world.setProp(insider, "location", roomId);
      world.setProp(outsider, "location", roomId);
      world.setProp(roomId, "subscribers", [insider, outsider]);
      const itemId = "obj_test_match_extension_item";
      world.createObject({ id: itemId, name: "stone", parent: "$thing", owner: "$wiz", location: roomId });
      // Zero-arg verb that branches on the verb-frame `actor` global. Only
      // the insider gets the secret keyword in their match pool.
      expect(installVerb(world, itemId, "match_names", `verb :match_names() rxd {
        if (actor == "${insider}") { return ["pebble", "secret-stone"]; }
        return ["pebble"];
      }`, null).ok).toBe(true);

      const insiderMatch = await world.directCall("match-insider-secret", insider, "$match", "match_object", ["secret-stone", roomId]);
      expect(insiderMatch.op).toBe("result");
      if (insiderMatch.op === "result") expect(insiderMatch.result).toBe(itemId);

      const outsiderMatch = await world.directCall("match-outsider-secret", outsider, "$match", "match_object", ["secret-stone", roomId]);
      expect(outsiderMatch.op).toBe("result");
      if (outsiderMatch.op === "result") expect(outsiderMatch.result).toBe("$failed_match");

      // The shared keyword resolves for both actors.
      const insiderShared = await world.directCall("match-insider-shared", insider, "$match", "match_object", ["pebble", roomId]);
      expect(insiderShared.op).toBe("result");
      if (insiderShared.op === "result") expect(insiderShared.result).toBe(itemId);
      const outsiderShared = await world.directCall("match-outsider-shared", outsider, "$match", "match_object", ["pebble", roomId]);
      expect(outsiderShared.op).toBe("result");
      if (outsiderShared.op === "result") expect(outsiderShared.result).toBe(itemId);

      // The base name still resolves regardless.
      const fallback = await world.directCall("match-extension-resolve-name", insider, "$match", "match_object", ["stone", roomId]);
      expect(fallback.op).toBe("result");
      if (fallback.op === "result") expect(fallback.result).toBe(itemId);
    });

    it("inventory bounds :title() returns and falls back when the verb exceeds max_chars", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["chat"]);
      const actor = world.auth("guest:title-overflow").actor;
      const itemId = "obj_test_title_overflow_item";
      world.createObject({ id: itemId, name: "thing-with-name", parent: "$thing", owner: "$wiz", location: actor });
      // A :title() verb that returns ~2KB — beyond the 1024-char titleForLook cap.
      expect(installVerb(world, itemId, "title", `verb :title() rxd {
        let s = "";
        let i = 0;
        while (i < 200) { s = s + "abcdefghij"; i = i + 1; }
        return s;
      }`, null).ok).toBe(true);

      const inv = await world.directCall("title-overflow-inventory", actor, actor, "inventory", []);
      expect(inv.op).toBe("result");
      if (inv.op !== "result") return;
      const result = inv.result as { items: Array<{ id: string; title: string }> };
      const entry = result.items.find((c) => c.id === itemId);
      expect(entry).toBeDefined();
      // The 2KB :title() return must not flow into composition. The inventory
      // verb's fallback for an erroring :title() is `to_string(item)`, the id.
      expect(entry?.title.length).toBeLessThan(200);
      expect(entry?.title).not.toContain("abcdefghij");
    });

    it("$weather_block installs cleanly and ships the configured tier lists", async () => {
      const world = createWorld({ catalogs: false });
      installLocalCatalogs(world, ["weather"]);
      expect(world.object("$weather_block").flags.fertile).toBe(true);
      expect(world.getProp("$weather_block", "writable_owner")).toEqual(["place", "timezone", "units", "forecast_hours"]);
      expect(world.getProp("$weather_block", "writable_self")).toEqual(["last_pushed_at", "last_error", "current", "forecast", "history", "config_state"]);
      expect(world.ownVerbExact("$weather_block", "set_location")).toMatchObject({ direct_callable: true, tool_exposed: true });
      expect(world.ownVerbExact("$weather_block", "set_units")).toMatchObject({ direct_callable: true, tool_exposed: true });
      expect(world.ownVerbExact("$weather_block", "set_forecast_hours")).toMatchObject({ direct_callable: true, tool_exposed: true });
      // An instance inherits the tier lists.
      const blockId = "obj_test_weather_block";
      const roomId = "obj_test_weather_room";
      const ownerSess = world.auth("guest:weather-owner");
      const owner = ownerSess.actor;
      const stranger = world.auth("guest:weather-stranger").actor;
      world.createObject({ id: roomId, name: roomId, parent: "$space", owner: "$wiz" });
      world.createObject({ id: blockId, name: blockId, parent: "$weather_block", owner, location: roomId });
      expect(world.object(blockId).flags.fertile).not.toBe(true);
      expect(world.getProp(blockId, "writable_owner")).toEqual(["place", "timezone", "units", "forecast_hours"]);
      expect(world.getProp(blockId, "writable_self")).toEqual(["last_pushed_at", "last_error", "current", "forecast", "history", "config_state"]);
      // Default config matches the manifest.
      expect(world.getProp(blockId, "place")).toBe("");
      expect(world.getProp(blockId, "timezone")).toBe("");
      expect(world.getProp(blockId, "units")).toBe("metric");
      expect(world.getProp(blockId, "forecast_hours")).toBe(12);
      expect(world.getProp(blockId, "config_state")).toMatchObject({ status: "unconfigured" });
      // summary_props defaults to ["current"] via the seed_hook on the class.
      expect(world.getProp("$weather_block", "summary_props")).toEqual(["current"]);

      world.setProp(blockId, "last_error", "old weather error");
      const locationSet = await world.directCall("weather-owner-set-location", owner, blockId, "set_location", ["Mountain View CA", "Pacific"]);
      expect(locationSet.op).toBe("result");
      if (locationSet.op === "result") {
        expect(locationSet.result).toMatchObject({
          place: "Mountain View CA",
          timezone: "Pacific",
          config_state: { status: "pending", place: "Mountain View CA", timezone: "Pacific", requested_by: owner }
        });
        expect(locationSet.observations).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "block_data", block: blockId, name: "place", value: "Mountain View CA" }),
          expect.objectContaining({ type: "block_data", block: blockId, name: "timezone", value: "Pacific" }),
          expect.objectContaining({ type: "block_data", block: blockId, name: "config_state", value: expect.objectContaining({ status: "pending" }) }),
          expect.objectContaining({ type: "block_data", block: blockId, name: "last_error", value: null })
        ]));
      }
      expect(world.getProp(blockId, "place")).toBe("Mountain View CA");
      expect(world.getProp(blockId, "timezone")).toBe("Pacific");
      expect(world.getProp(blockId, "last_error")).toBeNull();
      expect(world.getProp(blockId, "config_state")).toMatchObject({ status: "pending", place: "Mountain View CA", timezone: "Pacific" });

      const unitsDenied = await world.directCall("weather-stranger-set-units", stranger, blockId, "set_units", ["imperial"]);
      expect(unitsDenied.op).toBe("error");
      if (unitsDenied.op === "error") expect(unitsDenied.error.code).toBe("E_PERM");
      expect(world.getProp(blockId, "units")).toBe("metric");

      const hoursSet = await world.directCall("weather-wiz-set-hours", "$wiz", blockId, "set_forecast_hours", [24]);
      expect(hoursSet.op).toBe("result");
      expect(world.getProp(blockId, "forecast_hours")).toBe(24);

      world.setProp(blockId, "current", { kind: "scalar", value: 58.62, unit: "°F", label: "current_temperature", observed_at: "2026-05-06T16:01:00Z", observed_at_text: "May 6, 2026, 9:01 AM PDT" });
      world.setProp(blockId, "place", "Mountain View, CA");
      world.setProp(blockId, "config_state", { status: "confirmed", place: "Mountain View, CA", timezone: "America/Los_Angeles" });
      const townLook = await world.directCall("weather-town-state-look", "$wiz", blockId, "look_self", []);
      expect(townLook.op).toBe("result");
      if (townLook.op === "result") {
        const description = String((townLook.result as Record<string, unknown>).description);
        expect(description).toBe("The weather panel shows that the temperature in Mountain View, CA was 58.62°F at May 6, 2026, 9:01 AM PDT.");
      }

      world.setProp(blockId, "place", "94043");
      const zipLook = await world.directCall("weather-zip-look", "$wiz", blockId, "look_self", []);
      expect(zipLook.op).toBe("result");
      if (zipLook.op === "result") {
        const description = String((zipLook.result as Record<string, unknown>).description);
        expect(description).toBe("The weather panel shows that the temperature in 94043 was 58.62°F at May 6, 2026, 9:01 AM PDT.");
      }

      world.setProp(blockId, "config_state", {
        status: "error",
        code: "E_BAD_PLACE",
        message: "tomorrow.io could not fetch weather for \"94043\" - set place to a town name or zip code it recognizes",
        place: "94043",
        timezone: "America/Los_Angeles"
      });
      world.setProp(blockId, "last_error", "tomorrow.io could not fetch weather for \"94043\" - set place to a town name or zip code it recognizes");
      const errorLook = await world.directCall("weather-error-look", "$wiz", blockId, "look_self", []);
      expect(errorLook.op).toBe("result");
      if (errorLook.op === "result") {
        const result = errorLook.result as Record<string, unknown>;
        expect(result.title).toBe("Weather for 94043: error");
        expect(String(result.description)).toBe("Weather status: error for 94043. tomorrow.io could not fetch weather for \"94043\" - set place to a town name or zip code it recognizes. Last successful reading: 58.62°F at May 6, 2026, 9:01 AM PDT.");
      }
    });

  });
});
