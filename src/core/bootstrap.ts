import { setPropBytecode, setValueBytecode } from "./fixtures";
import { installLocalCatalogs } from "./local-catalogs";
import type { ObjectRepository, SerializedObject, SerializedWorld, WorldRepository } from "./repository";
import { hashSource } from "./source-hash";
import type { ObjRef, TinyBytecode, WooValue } from "./types";
import { normalizeVerbPerms } from "./verb-perms";
import { WooWorld } from "./world";

type BootstrapOptions = {
  catalogs?: readonly string[] | false;
};

export function createWorld(options: { repository?: WorldRepository & Partial<ObjectRepository>; catalogs?: readonly string[] | false } = {}): WooWorld {
  const world = new WooWorld(options.repository);
  const stored = options.repository?.load();
  if (stored) {
    world.importWorld(stored);
    world.withPersistencePaused(() => bootstrap(world, { catalogs: options.catalogs }));
    world.persist();
  } else {
    world.withPersistencePaused(() => bootstrap(world, { catalogs: options.catalogs }));
    world.persist();
  }
  world.enableIncrementalPersistence();
  return world;
}

export function createWorldFromSerialized(
  serialized: SerializedWorld,
  options: { repository?: WorldRepository & Partial<ObjectRepository>; persist?: boolean } = {}
): WooWorld {
  const world = new WooWorld(options.repository);
  world.importWorld(serialized);
  if (options.persist !== false) world.persist();
  world.enableIncrementalPersistence();
  return world;
}

export function scopeSerializedWorldToHost(serialized: SerializedWorld, host: ObjRef): SerializedWorld {
  const world = new WooWorld();
  world.importWorld(serialized);
  return world.exportHostScopedWorld(host);
}

export function nonEmptyHostScopedWorld(serialized: SerializedWorld, host: ObjRef): SerializedWorld | null {
  const scoped = scopeSerializedWorldToHost(serialized, host);
  return scoped.objects.length > 0 ? scoped : null;
}

export function mergeHostScopedSeed(stored: SerializedWorld, seed: SerializedWorld): SerializedWorld {
  const merged = cloneSerializedWorld(stored);
  const objects = new Map(merged.objects.map((obj) => [obj.id, obj]));
  const seedIds = new Set(seed.objects.map((obj) => obj.id));

  for (const seedObj of seed.objects) {
    const current = objects.get(seedObj.id);
    if (!current) {
      const next = cloneSerializedObject(seedObj);
      merged.objects.push(next);
      objects.set(next.id, next);
      continue;
    }
    mergeSeedObject(current, seedObj);
  }

  reconcileSeedContainment(objects, seedIds);
  merged.objectCounter = Math.max(merged.objectCounter ?? 1, seed.objectCounter ?? 1);
  merged.parkedTaskCounter = Math.max(merged.parkedTaskCounter ?? 1, seed.parkedTaskCounter ?? 1);
  merged.sessionCounter = Math.max(merged.sessionCounter ?? 1, seed.sessionCounter ?? 1);
  for (const [space, entries] of seed.logs) {
    if (!merged.logs.some(([existing]) => existing === space)) merged.logs.push([space, cloneSerialized(entries)]);
  }
  for (const snapshot of seed.snapshots) {
    if (!merged.snapshots.some((existing) => existing.space_id === snapshot.space_id && existing.seq === snapshot.seq)) {
      merged.snapshots.push(cloneSerialized(snapshot));
    }
  }
  for (const task of seed.parkedTasks) {
    if (!merged.parkedTasks.some((existing) => existing.id === task.id)) merged.parkedTasks.push(cloneSerialized(task));
  }
  return merged;
}

export function bootstrap(world: WooWorld, options: BootstrapOptions = {}): WooWorld {
  seedUniversal(world);
  if (options.catalogs !== false) installLocalCatalogs(world, options.catalogs);
  seedGuests(world);
  world.rebuildGuestPool();
  return world;
}

const DYNAMIC_HOST_SEED_PROPERTIES = new Set([
  "next_seq",
  "subscribers",
  "operators",
  "last_snapshot_seq",
  "presence_in",
  "session_id",
  "focus_list",
  "bootstrap_token_used",
  "wizard_actions",
  "applied_migrations",
  "catalog_migration_records",
  "installed_catalogs"
]);

function mergeSeedObject(current: SerializedObject, seed: SerializedObject): void {
  current.name = seed.name;
  current.parent = seed.parent;
  current.owner = seed.owner;
  if (!current.location) current.location = seed.location;
  current.anchor = seed.anchor;
  current.flags = cloneSerialized(seed.flags);
  current.modified = Math.max(current.modified ?? 0, seed.modified ?? 0);
  current.propertyDefs = cloneSerialized(seed.propertyDefs);
  current.verbs = cloneSerialized(seed.verbs);
  current.eventSchemas = cloneSerialized(seed.eventSchemas);
  current.children = mergeUnique(current.children, seed.children);

  const properties = new Map(current.properties);
  const versions = new Map(current.propertyVersions);
  const seedVersions = new Map(seed.propertyVersions);
  for (const [name, value] of seed.properties) {
    if (name === "features" && properties.has(name) && Array.isArray(properties.get(name)) && Array.isArray(value)) {
      properties.set(name, mergeUnique(properties.get(name) as string[], value.map(String)));
      continue;
    }
    if (name === "features_version" && properties.has(name)) {
      const currentVersion = Number(properties.get(name) ?? 0);
      const seedVersion = Number(value ?? 0);
      properties.set(name, Math.max(Number.isFinite(currentVersion) ? currentVersion : 0, Number.isFinite(seedVersion) ? seedVersion : 0));
      continue;
    }
    if (DYNAMIC_HOST_SEED_PROPERTIES.has(name) && properties.has(name)) continue;
    if (properties.has(name) && Number(versions.get(name) ?? 0) >= Number(seedVersions.get(name) ?? 0)) continue;
    properties.set(name, cloneSerialized(value));
  }
  for (const [name, version] of seed.propertyVersions) {
    if (DYNAMIC_HOST_SEED_PROPERTIES.has(name) && versions.has(name)) continue;
    if (!versions.has(name) || version > Number(versions.get(name) ?? 0)) versions.set(name, version);
  }
  current.properties = Array.from(properties.entries());
  current.propertyVersions = Array.from(versions.entries());
}

function reconcileSeedContainment(objects: Map<ObjRef, SerializedObject>, seedIds: Set<ObjRef>): void {
  for (const container of objects.values()) {
    container.contents = container.contents.filter((id) => !seedIds.has(id) || objects.get(id)?.location === container.id);
  }
  for (const obj of objects.values()) {
    if (!seedIds.has(obj.id) || !obj.location) continue;
    const container = objects.get(obj.location);
    if (container && !container.contents.includes(obj.id)) container.contents.push(obj.id);
  }

  for (const parent of objects.values()) {
    parent.children = parent.children.filter((id) => !seedIds.has(id) || objects.get(id)?.parent === parent.id);
  }
  for (const obj of objects.values()) {
    if (!seedIds.has(obj.id) || !obj.parent) continue;
    const parent = objects.get(obj.parent);
    if (parent && !parent.children.includes(obj.id)) parent.children.push(obj.id);
  }
}

function mergeUnique<T>(left: readonly T[], right: readonly T[]): T[] {
  return Array.from(new Set([...left, ...right]));
}

function cloneSerializedWorld(value: SerializedWorld): SerializedWorld {
  return cloneSerialized(value);
}

function cloneSerializedObject(value: SerializedObject): SerializedObject {
  return cloneSerialized(value);
}

function cloneSerialized<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function seedUniversal(world: WooWorld): void {
  world.createObject({ id: "$system", name: "$system", parent: null, owner: "$wiz", flags: { wizard: true } });
  world.createObject({ id: "$root", name: "$root", parent: "$system", owner: "$wiz" });
  world.createObject({ id: "$actor", name: "$actor", parent: "$root", owner: "$wiz" });
  world.createObject({ id: "$player", name: "$player", parent: "$actor", owner: "$wiz" });
  world.createObject({ id: "$wiz", name: "$wiz", parent: "$player", owner: "$wiz", flags: { wizard: true, programmer: true } });
  world.createObject({ id: "$guest", name: "$guest", parent: "$player", owner: "$wiz" });
  world.createObject({ id: "$sequenced_log", name: "$sequenced_log", parent: "$root", owner: "$wiz" });
  world.createObject({ id: "$space", name: "$space", parent: "$sequenced_log", owner: "$wiz" });
  world.createObject({ id: "$thing", name: "$thing", parent: "$root", owner: "$wiz" });
  world.object("$thing").flags.fertile = true;
  world.createObject({ id: "$catalog", name: "$catalog", parent: "$thing", owner: "$wiz" });
  world.createObject({ id: "$catalog_registry", name: "$catalog_registry", parent: "$space", owner: "$wiz" });
  world.createObject({ id: "$nowhere", name: "$nowhere", parent: "$thing", owner: "$wiz" });
  reparentSeed(world, "$space", "$sequenced_log");

  for (const id of ["$root", "$actor", "$player", "$sequenced_log", "$space", "$thing", "$catalog", "$catalog_registry"]) {
    define(world, id, "name", "", "str", "r");
    define(world, id, "description", "", "str", "r");
    define(world, id, "aliases", [], "list<str>", "r");
  }
  define(world, "$root", "host_placement", null, "str|null");
  describeSeed(world, "$system", "Bootstrap object and world registry root. It has no parent, owns the reserved #0 identity, carries wizard authority, and is where corenames and world-level metadata are anchored.");
  describeSeed(world, "$root", "Universal base class for ordinary persistent objects. It defines common descriptive slots and inherited utility verbs, so most object parent chains terminate here before reaching $system.");
  describeSeed(world, "$actor", "Base class for principals that can originate messages. Actors participate in spaces through presence, appear as message.actor, and are the objects whose authority user-facing calls represent.");
  describeSeed(world, "$player", "Session-capable actor class for humans, agents, or tools connected over the wire. A player composes actor identity with session bookkeeping and live connection state.");
  describeSeed(world, "$wiz", "Seed administrator player. It carries wizard and programmer flags so the initial world can bootstrap, inspect, and repair code, schema, and seeded objects.");
  describeSeed(world, "$guest", "Reusable temporary player class. Guest instances bind to short-lived sessions, reset through on_disfunc when the session is reaped, and then return to the free guest pool.");
  describeSeed(world, "$sequenced_log", "Append-only sequenced log base class. It owns the conceptual sequence allocation and replay surface inherited by coordination spaces and catalog registries.");
  describeSeed(world, "$space", "Coordination base class. A space owns a local message sequence, accepts calls, applies them one at a time, stores replayable history, and pushes observations to present subscribers.");
  describeSeed(world, "$thing", "Simple non-actor base class for persistent objects that primarily hold state. Use it when an object should be addressable and programmable but should not itself originate calls.");
  describeSeed(world, "$catalog", "Base class for installed catalog records. Catalog instances record provenance, version, alias, created class objects, and seeded instances for introspection and uninstall planning.");
  describeSeed(world, "$catalog_registry", "Sequenced registry space for catalog operations. It records which catalogs are installed, their aliases and provenance, and the object refs each catalog introduced.");
  describeSeed(world, "$nowhere", "Universal default-home location for disconnected guests, recycled objects, and any object whose home cannot otherwise be resolved. Owned by the wizard for reset operations.");
  seedProp(world, "$system", "wizard_actions", []);
  seedProp(world, "$system", "bootstrap_token_used", false);
  seedProp(world, "$system", "applied_migrations", []);
  seedProp(world, "$system", "catalog_migration_records", []);
  define(world, "$system", "help_dbs", [], "list<obj>", "r");
  define(world, "$root", "help", null, "obj|list<obj>|null", "r");
  define(world, "$actor", "presence_in", [], "list<obj>", "r");
  define(world, "$actor", "features", [], "list<obj>", "r");
  define(world, "$actor", "features_version", 0, "int", "r");
  define(world, "$actor", "focus_list", [], "list<obj>", "r");
  define(world, "$player", "session_id", null, "str|null", "r");
  define(world, "$player", "home", "$nowhere", "obj|null");
  removeSeedProperty(world, "$player", "attached_sockets");
  define(world, "$space", "next_seq", 1, "int", "r");
  define(world, "$space", "subscribers", [], "list<obj>", "r");
  define(world, "$space", "last_snapshot_seq", 0, "int", "r");
  define(world, "$space", "features", [], "list<obj>", "r");
  define(world, "$space", "features_version", 0, "int", "r");
  define(world, "$space", "auto_presence", false, "bool", "r");
  define(world, "$catalog", "catalog_name", "", "str");
  define(world, "$catalog", "alias", "", "str");
  define(world, "$catalog", "version", "", "str");
  define(world, "$catalog", "tap", "", "str");
  define(world, "$catalog", "objects", {}, "map");
  define(world, "$catalog", "seeds", {}, "map");
  define(world, "$catalog", "provenance", {}, "map");
  seedProp(world, "$catalog_registry", "next_seq", 1);
  seedProp(world, "$catalog_registry", "subscribers", []);
  seedProp(world, "$catalog_registry", "last_snapshot_seq", 0);
  seedProp(world, "$catalog_registry", "features", []);
  seedProp(world, "$catalog_registry", "features_version", 0);
  seedProp(world, "$catalog_registry", "installed_catalogs", []);

  bytecode(world, "$root", "set_value", setValueBytecode, "verb :set_value(value) r { ... }", { perms: "r" });
  bytecode(world, "$root", "set_prop", setPropBytecode, "verb :set_prop(name, value) r { ... }", { perms: "r" });
  native(world, "$root", "describe", "describe", "verb :describe() rxd { ... }", { directCallable: true });
  native(world, "$root", "title", "default_title", "verb :title() rxd { return this.name; }", { directCallable: true });
  native(world, "$root", "look_self", "default_look_self", "verb :look_self() rxd { return { title: this:title(), description: this.description }; }", { directCallable: true });
  native(world, "$player", "on_disfunc", "player_on_disfunc", "verb :on_disfunc() r { ... }", { perms: "r" });
  native(world, "$player", "moveto", "player_moveto", "verb :moveto(target) r { ... }", { perms: "r" });
  native(world, "$player", "tell", "player_tell", "verb :tell(text) rxd { ... }", { directCallable: true });
  native(world, "$player", "tell_lines", "player_tell_lines", "verb :tell_lines(lines) rxd { ... }", { directCallable: true });
  native(world, "$player", "help", "player_help", "verb :help(topic?) rxd { return null; /* native: see player_help */ }", { directCallable: true, skipPresenceCheck: true, toolExposed: true, aliases: ["?", "info", "information", "@help"], argSpec: { args: ["topic?"] } });
  native(world, "$guest", "on_disfunc", "guest_on_disfunc", "verb :on_disfunc() r { ... }", { perms: "r" });
  native(world, "$system", "return_guest", "return_guest", "verb :return_guest(guest) r { ... }", { perms: "r" });
  native(world, "$system", "set_object_flags", "set_object_flags", "verb :set_object_flags(target, flags) rxd { /* native: wizard-only flag mutation. flags is a map; allowed keys: wizard, programmer, fertile, recyclable. Returns the resulting flags. Required for the auth.md A11 \"mint a backup wizard\" flow. */ }", { directCallable: true, perms: "rxd", argSpec: { args: ["target", "flags"] } });
  native(world, "$thing", "can_be_attached_by", "feature_can_be_attached_by", "verb :can_be_attached_by(actor) rxd { ... }", { directCallable: true });
  native(world, "$thing", "moveto", "thing_moveto", "verb :moveto(target) rxd { return moveto(this, target); }");
  native(world, "$thing", "look", "thing_look", "verb :look() rxd { let r = this:look_self(); observe({ type: \"looked\", actor: actor, to: actor, room: this, text: r.description, look: r, ts: now() }); return r; }", { directCallable: true, aliases: ["l@ook", "ex@amine"] });
  for (const obj of ["$actor", "$space"]) {
    native(world, obj, "add_feature", "add_feature", "verb :add_feature(f) rx { ... }");
    native(world, obj, "remove_feature", "remove_feature", "verb :remove_feature(f) rx { ... }");
    native(world, obj, "has_feature", "has_feature", "verb :has_feature(f) rxd { ... }", { directCallable: true });
  }
  native(world, "$actor", "wait", "actor_wait", "verb :wait(timeout_ms, limit) rxd { ... }", {
    directCallable: true, toolExposed: true,
    argSpec: { args: ["timeout_ms?", "limit?"], types: { timeout_ms: "int", limit: "int" } }
  });
  native(world, "$actor", "focus", "actor_focus", "verb :focus(target) rxd { ... }", {
    directCallable: true, toolExposed: true,
    argSpec: { args: ["target"], types: { target: "obj" } }
  });
  native(world, "$actor", "unfocus", "actor_unfocus", "verb :unfocus(target) rxd { ... }", {
    directCallable: true, toolExposed: true,
    argSpec: { args: ["target"], types: { target: "obj" } }
  });
  native(world, "$actor", "focus_list", "actor_focus_list", "verb :focus_list() rxd { ... }", {
    directCallable: true, toolExposed: true,
    argSpec: { args: [] }
  });
  native(world, "$space", "replay", "replay", "verb :replay(from_seq, limit) rxd { ... }", { directCallable: true });
  native(world, "$catalog_registry", "install", "catalog_registry_install", "verb :install(manifest, frontmatter, alias, provenance) rx { ... }");
  native(world, "$catalog_registry", "update", "catalog_registry_update", "verb :update(manifest, frontmatter, alias, provenance, options, migration) rx { ... }");
  native(world, "$catalog_registry", "list", "catalog_registry_list", "verb :list() rxd { ... }", { directCallable: true });
  native(world, "$catalog_registry", "migration_state", "catalog_registry_migration_state", "verb :migration_state(alias) rxd { ... }", { directCallable: true });
}

function seedGuests(world: WooWorld): void {
  for (let i = 1; i <= 8; i++) {
    const id = `guest_${i}`;
    const displayName = `Guest ${i}`;
    world.createObject({ id, name: displayName, parent: "$guest", owner: "$wiz", location: "$nowhere" });
    reparentSeed(world, id, "$guest");
    describeSeed(world, id, `Pre-seeded guest player ${i}. It can be bound to a temporary session, gains presence in demo spaces on auth, and gives local users or agents a stable actor for first-light testing.`);
    // Mirror WooObject.name into the `name` property too, so cross-host
    // display-name lookups (which read the property) get "Guest 1" instead
    // of the default empty string. Catalog seed_hooks already do this via
    // setNameIfMissing; bootstrap had to do it explicitly.
    world.setProp(id, "name", displayName);
    seedProp(world, id, "presence_in", []);
    seedProp(world, id, "session_id", null);
    seedProp(world, id, "home", "$nowhere");
    removeSeedProperty(world, id, "attached_sockets");
  }
  // Backfill: any dynamic guest_<N> minted by an older allocateGuest didn't
  // set the `name` property, so cross-host display falls back to the id.
  // Mirror the WooObject.name field into the property unconditionally.
  for (const id of Array.from(world.objects.keys())) {
    const match = /^guest_(\d+)$/.exec(id);
    if (!match) continue;
    if (match[1].length > 0 && Number(match[1]) <= 8) continue;
    const obj = world.object(id);
    const fieldName = obj.name;
    const propValue = world.propOrNull(id, "name");
    const target = fieldName && fieldName !== id ? fieldName : `Guest ${match[1]}`;
    if (propValue !== target) world.setProp(id, "name", target);
    if (!fieldName || fieldName === id) obj.name = target;
  }
}

function define(world: WooWorld, obj: ObjRef, name: string, defaultValue: WooValue, typeHint: string, perms = "rw"): void {
  const existing = world.object(obj).propertyDefs.get(name);
  if (existing) {
    if (existing.typeHint !== typeHint || existing.perms !== perms) {
      world.defineProperty(obj, { ...existing, typeHint, perms, version: existing.version + 1 });
    }
    return;
  }
  world.defineProperty(obj, {
    name,
    defaultValue,
    typeHint,
    owner: "$wiz",
    perms
  });
}

function describeSeed(world: WooWorld, obj: ObjRef, description: string): void {
  const existing = world.object(obj).properties.get("description");
  if (typeof existing === "string" && existing.length > 0) return;
  world.setProp(obj, "description", description);
}

function seedProp(world: WooWorld, obj: ObjRef, name: string, value: WooValue): void {
  if (world.object(obj).properties.has(name)) return;
  world.setProp(obj, name, value);
}

function removeSeedProperty(world: WooWorld, obj: ObjRef, name: string): void {
  const target = world.object(obj);
  target.propertyDefs.delete(name);
  target.properties.delete(name);
  target.propertyVersions.delete(name);
}

function reparentSeed(world: WooWorld, obj: ObjRef, parent: ObjRef): void {
  const target = world.object(obj);
  if (target.parent === parent) return;
  if (target.parent && world.objects.has(target.parent)) world.object(target.parent).children.delete(obj);
  target.parent = parent;
  world.object(parent).children.add(obj);
}

function bytecode(world: WooWorld, obj: ObjRef, name: string, bytecodeValue: TinyBytecode, source: string, options: { directCallable?: boolean; skipPresenceCheck?: boolean; perms?: string } = {}): void {
  const existing = world.ownVerbExact(obj, name);
  if (existing) {
    const parsedPerms = normalizeVerbPerms(options.perms ?? existing.perms, existing.direct_callable || options.directCallable === true);
    const next = {
      ...existing,
      perms: parsedPerms.perms,
      direct_callable: parsedPerms.directCallable,
      skip_presence_check: existing.skip_presence_check || options.skipPresenceCheck === true
    };
    if (next.perms !== existing.perms || next.direct_callable !== existing.direct_callable || next.skip_presence_check !== existing.skip_presence_check) world.addVerb(obj, next);
    return;
  }
  const parsedPerms = normalizeVerbPerms(options.perms ?? "rx", options.directCallable === true);
  world.addVerb(obj, {
    kind: "bytecode",
    name,
    aliases: [],
    owner: "$wiz",
    perms: parsedPerms.perms,
    arg_spec: {},
    source,
    source_hash: hashSource(source),
    bytecode: bytecodeValue,
    version: bytecodeValue.version,
    line_map: {},
    direct_callable: parsedPerms.directCallable,
    skip_presence_check: options.skipPresenceCheck === true
  });
}

function native(world: WooWorld, obj: ObjRef, name: string, handler: string, source: string, options: { directCallable?: boolean; skipPresenceCheck?: boolean; toolExposed?: boolean; perms?: string; argSpec?: Record<string, WooValue>; aliases?: string[] } = {}): void {
  const existing = world.ownVerbExact(obj, name);
  if (existing) {
    const parsedPerms = normalizeVerbPerms(options.perms ?? existing.perms, existing.direct_callable || options.directCallable === true);
    const aliases = options.aliases ?? existing.aliases;
    const next = {
      ...existing,
      perms: parsedPerms.perms,
      direct_callable: parsedPerms.directCallable,
      skip_presence_check: existing.skip_presence_check || options.skipPresenceCheck === true,
      tool_exposed: existing.tool_exposed || options.toolExposed === true,
      aliases
    };
    if (
      next.perms !== existing.perms ||
      next.direct_callable !== existing.direct_callable ||
      next.skip_presence_check !== existing.skip_presence_check ||
      next.tool_exposed !== existing.tool_exposed ||
      JSON.stringify(next.aliases ?? []) !== JSON.stringify(existing.aliases ?? [])
    ) world.addVerb(obj, next);
    return;
  }
  const parsedPerms = normalizeVerbPerms(options.perms ?? "rx", options.directCallable === true);
  world.addVerb(obj, {
    kind: "native",
    name,
    aliases: options.aliases ?? [],
    owner: "$wiz",
    perms: parsedPerms.perms,
    arg_spec: options.argSpec ?? {},
    source,
    source_hash: hashSource(source),
    version: 1,
    line_map: {},
    native: handler,
    direct_callable: parsedPerms.directCallable,
    skip_presence_check: options.skipPresenceCheck === true,
    tool_exposed: options.toolExposed === true
  });
}


export { hashSource };
