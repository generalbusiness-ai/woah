import { compileVerb } from "./authoring";
import { setPropBytecode, setValueBytecode } from "./fixtures";
import { installLocalCatalogs } from "./local-catalogs";
import type { ObjectRepository, SerializedObject, SerializedWorld, WorldRepository } from "./repository";
import { hashSource } from "./source-hash";
import type { MetricEvent, ObjRef, TinyBytecode, WooValue } from "./types";
import { valuesEqual } from "./types";
import { normalizeVerbPerms } from "./verb-perms";
import { WooWorld } from "./world";

type BootstrapOptions = {
  catalogs?: readonly string[] | false;
};

const bootSnapshotCache = new Map<string, SerializedWorld>();

const ACTOR_LOOK_SELF_SOURCE = `verb :look_self() rxd {
  let title = this:title();
  let description = this.description;
  if (description == null) { description = ""; }
  let carried = [];
  let names = [];
  for item in contents(this) {
    let item_title = null;
    try { item_title = item:title(); } except err { item_title = item.name; }
    if (!item_title) { item_title = to_string(item); }
    carried = carried + [{ id: item, title: item_title, description: item.description }];
    names = names + [item_title];
  }
  if (length(names) > 0) {
    let prefix = title + " is";
    if (this == actor) { prefix = "You are"; }
    let joined = "";
    let i = 1;
    for name in names {
      if (i == 1) { joined = name; }
      else if (i == length(names)) { joined = joined + ", and " + name; }
      else { joined = joined + ", " + name; }
      i = i + 1;
    }
    let inventory = prefix + " carrying " + joined + ".";
    if (description) { description = description + " " + inventory; }
    else { description = inventory; }
  }
  return { id: this, title: title, description: description, carrying: carried };
}`;

const ACTOR_HUH_SOURCE = `verb :huh(text, reason, source) rxd {
  if (!reason) { reason = "I don't understand that."; }
  if (source == null) { source = location(this); }
  observe({ type: "huh", source: source, actor: this, text: text, reason: reason, ts: now(), _audience_override: [this] });
  return false;
}`;

const PLAYER_INVENTORY_SOURCE = `verb :inventory() rxd {
  let items = [];
  let names = [];
  for item in contents(this) {
    let item_title = "";
    try { item_title = dispatch(item, "title", [], null, 1024); } except err { item_title = ""; }
    if (!item_title) { item_title = to_string(item); }
    items = items + [{ id: item, title: item_title }];
    names = names + [item_title];
  }
  let text = "";
  if (length(names) == 0) { text = "You are empty-handed."; }
  else if (length(names) == 1) { text = "You are carrying " + names[1] + "."; }
  else {
    let joined = "";
    let i = 1;
    for n in names {
      if (i == 1) { joined = n; }
      else if (i == length(names)) { joined = joined + ", and " + n; }
      else { joined = joined + ", " + n; }
      i = i + 1;
    }
    text = "You are carrying " + joined + ".";
  }
  tell(this, text);
  return { items: items, text: text };
}`;

const PLAYER_LOOK_SELF_SOURCE = `verb :look_self() rxd {
  let base = pass();
  let line = "";
  if (!is_connected(this)) {
    line = this.name + " is sleeping.";
  } else {
    let idle = idle_seconds(this);
    if (idle == null || idle < 60) {
      line = this.name + " is awake and looks alert.";
    } else {
      let mins = floor(idle / 60);
      let unit = " minute";
      if (mins != 1) { unit = " minutes"; }
      line = this.name + " is awake, but has been staring off into space for " + to_string(mins) + unit + ".";
    }
  }
  let description = "";
  if (typeof(base) == "map" && has(base, "description")) {
    if (typeof(base["description"]) == "string") { description = base["description"]; }
  }
  if (description) { description = description + " " + line; }
  else { description = line; }
  base["description"] = description;
  return base;
}`;

const ROOT_SET_DESCRIPTION_SOURCE = `verb :set_description(desc) rxd {
  if (typeof(desc) != "string") {
    raise { code: "E_TYPE", message: "set_description requires a string", value: desc };
  }
  let cp = caller_perms();
  let allowed = false;
  if (cp == this) { allowed = true; }
  else if (cp == this.owner) { allowed = true; }
  else if (has_flag(cp, "wizard")) { allowed = true; }
  if (!allowed) {
    raise { code: "E_PERM", message: "you can't describe that", value: this };
  }
  this.description = desc;
  tell(actor, "Description set.");
  return true;
}`;

const PLAYER_HOME_SOURCE = `verb :home() rxd {
  let dest = this.home;
  if (dest == null || dest == $nowhere) { tell(this, "You don't have a home set."); return null; }
  let here = location(this);
  if (dest == here) { tell(this, "You are already home."); return dest; }
  // LambdaCore $player:home calls this:moveto(this.home) so the destination's
  // :acceptable / enterfunc gates the move. We do the same — and then reconcile
  // presence and observations on the source/destination spaces afterwards, so
  // that a refused move (location unchanged) leaves no spurious announce.
  moveto(this, dest);
  let landed = location(this);
  if (landed != dest) {
    tell(this, "Either home doesn't want you, or you don't really want to go.");
    return null;
  }
  if (here != null && here != dest && here != $nowhere) {
    try {
      observe_to_space(here, { type: "left", actor: this, room: here, destination: dest, text: this.name + " goes home.", ts: now() });
    } except err {
    }
  }
  try {
    observe_to_space(dest, { type: "entered", actor: this, room: dest, origin: here, text: this.name + " arrives home.", ts: now() });
  } except err {
    // Destination isn't a space — moveto landed us in a non-room container.
    // No presence to set, no audience to announce to.
  }
  tell(this, "You go home.");
  return dest;
}`;

const PLAYER_WAYS_SOURCE = `verb :ways(room_name) rxd {
  let room = location(actor);
  let requested = str_trim(room_name);
  if (requested) {
    let matched = $match:match_object(requested, room);
    if (matched == $ambiguous_match) {
      tell(actor, "I don't know which " + str_char(34) + requested + str_char(34) + " you mean.");
      return null;
    }
    if (matched == $failed_match) {
      tell(actor, "I don't see " + str_char(34) + requested + str_char(34) + " here.");
      return null;
    }
    room = matched;
  }
  if (room == null || !isa(room, $room)) {
    tell(actor, "You can only pry into the exits of a room.");
    return null;
  }
  let exits = [];
  let exit_map = room.exits;
  for key in keys(exit_map) {
    let exit = exit_map[key];
    if (!(exit in exits)) {
      let obvious = false;
      try { obvious = exit.obvious; } except err { obvious = false; }
      if (obvious) { exits = exits + [exit]; }
    }
  }
  let labels = [];
  for exit in exits {
    let label = exit.name;
    let aliases = [];
    try { aliases = exit.aliases; } except err { aliases = []; }
    if (length(aliases) > 0) { label = label + " (" + str_join(aliases, ", ") + ")"; }
    labels = labels + [label];
  }
  let text = "";
  if (length(labels) == 0) { text = "No obvious exits."; }
  else { text = "Obvious exits: " + str_join(labels, ", ") + "."; }
  tell(actor, text);
  return { room: room, exits: exits, text: text };
}`;

export function createWorld(options: { repository?: WorldRepository & Partial<ObjectRepository>; catalogs?: readonly string[] | false; metricsHook?: (event: MetricEvent) => void } = {}): WooWorld {
  if (!options.repository) {
    const world = new WooWorld();
    if (options.metricsHook) world.setMetricsHook(options.metricsHook);
    world.importWorld(cloneSerializedWorld(cachedBootSnapshot(options.catalogs)));
    world.enableIncrementalPersistence();
    return world;
  }

  const world = new WooWorld(options.repository);
  if (options.metricsHook) world.setMetricsHook(options.metricsHook);
  const stored = options.repository?.load();
  if (stored) {
    world.importWorld(stored);
    world.withPersistencePaused(() => bootstrap(world, { catalogs: options.catalogs }));
    if (world.hasPendingPersistence()) {
      world.persist();
    } else {
      world.discardPendingPersistence();
    }
  } else {
    world.withPersistencePaused(() => bootstrap(world, { catalogs: options.catalogs }));
    world.persist();
  }
  world.enableIncrementalPersistence();
  return world;
}

function cachedBootSnapshot(catalogs: readonly string[] | false | undefined): SerializedWorld {
  const key = bootSnapshotKey(catalogs);
  const existing = bootSnapshotCache.get(key);
  if (existing) return existing;
  const world = new WooWorld();
  world.withPersistencePaused(() => bootstrap(world, { catalogs }));
  const snapshot = world.exportWorld();
  bootSnapshotCache.set(key, snapshot);
  return snapshot;
}

function bootSnapshotKey(catalogs: readonly string[] | false | undefined): string {
  if (catalogs === undefined) return "default";
  if (catalogs === false) return "false";
  return JSON.stringify([...catalogs]);
}

export function createWorldFromSerialized(
  serialized: SerializedWorld,
  options: { repository?: WorldRepository & Partial<ObjectRepository>; persist?: boolean; metricsHook?: (event: MetricEvent) => void } = {}
): WooWorld {
  const world = new WooWorld(options.repository);
  if (options.metricsHook) world.setMetricsHook(options.metricsHook);
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

export type HostScopedSeedMergeResult = {
  world: SerializedWorld;
  changed: boolean;
};

export function mergeHostScopedSeed(stored: SerializedWorld, seed: SerializedWorld): SerializedWorld {
  return mergeHostScopedSeedWithStatus(stored, seed).world;
}

export function mergeHostScopedSeedWithStatus(stored: SerializedWorld, seed: SerializedWorld): HostScopedSeedMergeResult {
  const merged = cloneSerializedWorld(stored);
  const objects = new Map(merged.objects.map((obj) => [obj.id, obj]));
  const seedIds = new Set(seed.objects.map((obj) => obj.id));
  let changed = false;

  for (const seedObj of seed.objects) {
    const current = objects.get(seedObj.id);
    if (!current) {
      const next = cloneSerializedObject(seedObj);
      merged.objects.push(next);
      objects.set(next.id, next);
      changed = true;
      continue;
    }
    changed = mergeSeedObject(current, seedObj) || changed;
  }

  changed = reconcileSeedContainment(objects, seedIds) || changed;
  const objectCounter = Math.max(merged.objectCounter ?? 1, seed.objectCounter ?? 1);
  if (merged.objectCounter !== objectCounter) {
    merged.objectCounter = objectCounter;
    changed = true;
  }
  const parkedTaskCounter = Math.max(merged.parkedTaskCounter ?? 1, seed.parkedTaskCounter ?? 1);
  if (merged.parkedTaskCounter !== parkedTaskCounter) {
    merged.parkedTaskCounter = parkedTaskCounter;
    changed = true;
  }
  const sessionCounter = Math.max(merged.sessionCounter ?? 1, seed.sessionCounter ?? 1);
  if (merged.sessionCounter !== sessionCounter) {
    merged.sessionCounter = sessionCounter;
    changed = true;
  }
  for (const [space, entries] of seed.logs) {
    if (!merged.logs.some(([existing]) => existing === space)) {
      merged.logs.push([space, cloneSerialized(entries)]);
      changed = true;
    }
  }
  for (const snapshot of seed.snapshots) {
    if (!merged.snapshots.some((existing) => existing.space_id === snapshot.space_id && existing.seq === snapshot.seq)) {
      merged.snapshots.push(cloneSerialized(snapshot));
      changed = true;
    }
  }
  for (const task of seed.parkedTasks) {
    if (!merged.parkedTasks.some((existing) => existing.id === task.id)) {
      merged.parkedTasks.push(cloneSerialized(task));
      changed = true;
    }
  }
  return { world: merged, changed };
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
  "focus_list",
  "bootstrap_token_used",
  "wizard_actions",
  "applied_migrations",
  "catalog_migration_records",
  "installed_catalogs"
]);

function mergeSeedObject(current: SerializedObject, seed: SerializedObject): boolean {
  let changed = false;
  if (current.name !== seed.name) {
    current.name = seed.name;
    changed = true;
  }
  if (current.parent !== seed.parent) {
    current.parent = seed.parent;
    changed = true;
  }
  if (current.owner !== seed.owner) {
    current.owner = seed.owner;
    changed = true;
  }
  if (!current.location && current.location !== seed.location) {
    current.location = seed.location;
    changed = true;
  }
  if (current.anchor !== seed.anchor) {
    current.anchor = seed.anchor;
    changed = true;
  }
  if (!valuesEqual(current.flags as WooValue, seed.flags as WooValue)) {
    current.flags = cloneSerialized(seed.flags);
    changed = true;
  }
  const modified = Math.max(current.modified ?? 0, seed.modified ?? 0);
  if (current.modified !== modified) {
    current.modified = modified;
    changed = true;
  }
  if (!valuesEqual(current.propertyDefs as unknown as WooValue, seed.propertyDefs as unknown as WooValue)) {
    current.propertyDefs = cloneSerialized(seed.propertyDefs);
    changed = true;
  }
  if (!valuesEqual(current.verbs as unknown as WooValue, seed.verbs as unknown as WooValue)) {
    current.verbs = cloneSerialized(seed.verbs);
    changed = true;
  }
  if (!valuesEqual(current.eventSchemas as unknown as WooValue, seed.eventSchemas as unknown as WooValue)) {
    current.eventSchemas = cloneSerialized(seed.eventSchemas);
    changed = true;
  }
  const children = mergeUnique(current.children, seed.children);
  if (!arraysEqual(current.children, children)) {
    current.children = children;
    changed = true;
  }

  const properties = new Map(current.properties);
  const versions = new Map(current.propertyVersions);
  const seedVersions = new Map(seed.propertyVersions);
  for (const [name, value] of seed.properties) {
    if (name === "features" && properties.has(name) && Array.isArray(properties.get(name)) && Array.isArray(value)) {
      const merged = mergeUnique(properties.get(name) as string[], value.map(String));
      if (!valuesEqual(properties.get(name) as WooValue, merged as WooValue)) {
        properties.set(name, merged);
        changed = true;
      }
      continue;
    }
    if (name === "features_version" && properties.has(name)) {
      const currentVersion = Number(properties.get(name) ?? 0);
      const seedVersion = Number(value ?? 0);
      const nextVersion = Math.max(Number.isFinite(currentVersion) ? currentVersion : 0, Number.isFinite(seedVersion) ? seedVersion : 0);
      if (properties.get(name) !== nextVersion) {
        properties.set(name, nextVersion);
        changed = true;
      }
      continue;
    }
    if (DYNAMIC_HOST_SEED_PROPERTIES.has(name) && properties.has(name)) continue;
    if (properties.has(name) && Number(versions.get(name) ?? 0) >= Number(seedVersions.get(name) ?? 0)) continue;
    if (!valuesEqual(properties.get(name) as WooValue, value as WooValue)) {
      properties.set(name, cloneSerialized(value));
      changed = true;
    }
  }
  for (const [name, version] of seed.propertyVersions) {
    if (DYNAMIC_HOST_SEED_PROPERTIES.has(name) && versions.has(name)) continue;
    if (!versions.has(name) || version > Number(versions.get(name) ?? 0)) {
      versions.set(name, version);
      changed = true;
    }
  }
  if (changed) {
    current.properties = Array.from(properties.entries());
    current.propertyVersions = Array.from(versions.entries());
  }
  return changed;
}

function reconcileSeedContainment(objects: Map<ObjRef, SerializedObject>, seedIds: Set<ObjRef>): boolean {
  let changed = false;
  for (const container of objects.values()) {
    const contents = container.contents.filter((id) => !seedIds.has(id) || objects.get(id)?.location === container.id);
    if (!arraysEqual(container.contents, contents)) {
      container.contents = contents;
      changed = true;
    }
  }
  for (const obj of objects.values()) {
    if (!seedIds.has(obj.id) || !obj.location) continue;
    const container = objects.get(obj.location);
    if (container && !container.contents.includes(obj.id)) {
      container.contents.push(obj.id);
      changed = true;
    }
  }

  for (const parent of objects.values()) {
    const children = parent.children.filter((id) => !seedIds.has(id) || objects.get(id)?.parent === parent.id);
    if (!arraysEqual(parent.children, children)) {
      parent.children = children;
      changed = true;
    }
  }
  for (const obj of objects.values()) {
    if (!seedIds.has(obj.id) || !obj.parent) continue;
    const parent = objects.get(obj.parent);
    if (parent && !parent.children.includes(obj.id)) {
      parent.children.push(obj.id);
      changed = true;
    }
  }
  return changed;
}

function mergeUnique<T>(left: readonly T[], right: readonly T[]): T[] {
  return Array.from(new Set([...left, ...right]));
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
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
  if (world.object("$thing").flags.fertile !== true) {
    world.object("$thing").flags.fertile = true;
    world.markObjectChanged("$thing");
  }
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
  define(world, "$actor", "features", [], "list<obj>", "r");
  define(world, "$actor", "features_version", 0, "int", "r");
  define(world, "$actor", "focus_list", [], "list<obj>", "r");
  define(world, "$player", "home", "$nowhere", "obj|null");
  removeSeedProperty(world, "$player", "attached_sockets");
  // Legacy: $player.session_id was a write-only mirror of the session table
  // that no reader ever consulted. Retired now that session lifecycle lives
  // exclusively in `world.sessions`. The def is no longer (re)defined here;
  // a one-shot migration drops any own def/values on $player and its
  // descendants for upgraded worlds.
  define(world, "$space", "next_seq", 1, "int", "r");
  define(world, "$space", "session_subscribers", [], "list<map>", "r");
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
  sourceVerb(world, "$root", "set_description", ROOT_SET_DESCRIPTION_SOURCE, {
    directCallable: true,
    toolExposed: true,
    aliases: ["describe", "@describe", "@desc"],
    argSpec: { args: ["desc"], command: { dobj: "object", prep: "as", iobj: "string", args_from: ["iobjstr"] } }
  });
  sourceVerb(world, "$actor", "look_self", ACTOR_LOOK_SELF_SOURCE, { directCallable: true });
  sourceVerb(world, "$actor", "huh", ACTOR_HUH_SOURCE, { directCallable: true });
  sourceVerb(world, "$player", "look_self", PLAYER_LOOK_SELF_SOURCE, { directCallable: true });
  sourceVerb(world, "$player", "inventory", PLAYER_INVENTORY_SOURCE, {
    directCallable: true,
    toolExposed: true,
    aliases: ["i@nventory", "inv"],
    argSpec: { args: [], command: { dobj: "none", prep: "none", iobj: "none", args_from: [] } }
  });
  sourceVerb(world, "$player", "home", PLAYER_HOME_SOURCE, {
    directCallable: true,
    toolExposed: true,
    aliases: ["@home"],
    argSpec: { args: [], command: { dobj: "none", prep: "none", iobj: "none", args_from: [] } }
  });
  native(world, "$player", "who_all", "player_who", "verb :who_all(names?) rxd { /* native: LambdaCore-style @who over connected players. */ }", {
    directCallable: true,
    toolExposed: true,
    aliases: ["@who"],
    argSpec: { args: ["names?"], command: { dobj: "any", prep: "any", iobj: "any", args_from: ["argstr"] } }
  });
  native(world, "$player", "join_player", "player_join", "verb :join_player(name) rxd { /* native: LambdaCore-style @join <player>. */ }", {
    directCallable: true,
    toolExposed: true,
    aliases: ["@join"],
    argSpec: { args: ["name"], command: { dobj: "any", prep: "any", iobj: "any", args_from: ["argstr"] } }
  });
  sourceVerb(world, "$player", "ways", PLAYER_WAYS_SOURCE, {
    directCallable: true,
    toolExposed: true,
    aliases: ["@ways"],
    argSpec: { args: ["room?"], command: { dobj: "any", prep: "any", iobj: "any", args_from: ["argstr"] } }
  });
  native(world, "$player", "examine_detailed", "player_examine", "verb :examine_detailed(name) rxd { /* native: LambdaCore-style @examine with names, owner, description, contents, and obvious command verbs. */ }", {
    directCallable: true,
    toolExposed: true,
    aliases: ["@exam*ine"],
    argSpec: { args: ["name"], command: { dobj: "any", prep: "any", iobj: "any", args_from: ["argstr"] } }
  });
  native(world, "$player", "on_disfunc", "player_on_disfunc", "verb :on_disfunc() r { ... }", { perms: "r" });
  native(world, "$player", "moveto", "player_moveto", "verb :moveto(target) r { ... }", { perms: "r" });
  native(world, "$player", "tell", "player_tell", "verb :tell(text) rxd { ... }", { directCallable: true });
  native(world, "$player", "tell_lines", "player_tell_lines", "verb :tell_lines(lines) rxd { ... }", { directCallable: true });
  native(world, "$player", "help", "player_help", "verb :help(topic?) rxd { return null; /* native: see player_help */ }", {
    directCallable: true,
    skipPresenceCheck: true,
    toolExposed: true,
    aliases: ["?", "info", "information", "@help"],
    argSpec: { args: ["topic?"], command: { dobj: "any", prep: "any", iobj: "any", args_from: ["argstr"] } }
  });
  native(world, "$guest", "on_disfunc", "guest_on_disfunc", "verb :on_disfunc() r { ... }", { perms: "r" });
  native(world, "$system", "return_guest", "return_guest", "verb :return_guest(guest) r { ... }", { perms: "r" });
  native(world, "$system", "set_object_flags", "set_object_flags", "verb :set_object_flags(target, flags) rxd { /* native: wizard-only flag mutation. flags is a map; allowed keys: wizard, programmer, fertile. Returns the resulting flags. Required for the auth.md A11 \"mint a backup wizard\" flow. */ }", { directCallable: true, perms: "rxd", argSpec: { args: ["target", "flags"] } });
  native(world, "$system", "mint_session_for", "mint_session_for", "verb :mint_session_for(actor) rxd { /* native: wizard-only. Creates a fresh bearer session bound to the named actor and returns {id, actor, expires_at, token_class}. Use the returned session id with `Authorization: Session <id>` to act as that actor. Audited as a wizard_action. */ }", { directCallable: true, perms: "rxd", argSpec: { args: ["actor"] } });
  native(world, "$system", "create_api_key", "create_api_key", "verb :create_api_key(actor, label?) rxd { /* native: wizard-only. Mint a long-lived apikey credential bound to the given actor (per auth.md A8). Returns {id, secret, actor, label, created_at}; the secret is shown ONCE — store it. Auth via POST /api/auth with token \"apikey:<id>:<secret>\" returns a fresh bearer session bound to the actor. Whoever holds the apikey gains that actor's authority. Audited. */ }", { directCallable: true, perms: "rxd", argSpec: { args: ["actor", "label?"] } });
  native(world, "$system", "create_api_key_for_owner", "create_api_key_for_owner", "verb :create_api_key_for_owner(actor, label?) rxd { /* native: callable by the owner of `actor` (wizard always allowed). Same return shape as :create_api_key but does not require wizard authority — it's the path catalog code (e.g. $block:mint_apikey) uses so a block's creator can mint a plug credential for their block without escalation. Audited. */ }", { directCallable: true, perms: "rxd", argSpec: { args: ["actor", "label?"] } });
  native(world, "$system", "revoke_api_key", "revoke_api_key", "verb :revoke_api_key(id) rxd { /* native: callable by wizard or by the owner of the apikey's bound actor. Marks api_keys[id].revoked_at so future authentications fail; in-memory sessions minted from this key are also closed. The record is kept (with revoked_at populated) for audit. Returns true on first revoke, false if already revoked or id unknown. Audited. */ }", { directCallable: true, perms: "rxd", argSpec: { args: ["id"] } });
  native(world, "$system", "list_api_keys", "list_api_keys", "verb :list_api_keys() rxd { /* native: wizard-only. Returns [{id, actor, label, created_at, last_seen_at, revoked_at}] for inspection — secrets are NEVER readable post-mint. */ }", { directCallable: true, perms: "rxd", argSpec: { args: [] } });
  native(world, "$system", "list_api_keys_for_owner", "list_api_keys_for_owner", "verb :list_api_keys_for_owner() rxd { /* native: returns api-key metadata for actors the caller owns. Wizard sees everything. Same shape as :list_api_keys. Useful so a block's owner can audit \"is my plug connected and which key is it using?\" without wizard authority. */ }", { directCallable: true, perms: "rxd", argSpec: { args: [] } });
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
    if (world.propOrNull(id, "name") !== displayName) world.setProp(id, "name", displayName);
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
    if (!fieldName || fieldName === id) {
      obj.name = target;
      world.markObjectChanged(id);
    }
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
  const removedDef = target.propertyDefs.delete(name);
  const removedValue = target.properties.delete(name);
  const removedVersion = target.propertyVersions.delete(name);
  const changed = removedDef || removedValue || removedVersion;
  if (changed) world.markObjectChanged(obj);
}

function reparentSeed(world: WooWorld, obj: ObjRef, parent: ObjRef): void {
  const target = world.object(obj);
  if (target.parent === parent) return;
  const oldParent = target.parent;
  if (oldParent && world.objects.has(oldParent)) world.object(oldParent).children.delete(obj);
  target.parent = parent;
  world.object(parent).children.add(obj);
  world.markObjectChanged(obj);
  if (oldParent && world.objects.has(oldParent)) world.markObjectChanged(oldParent);
  world.markObjectChanged(parent);
}

function bytecode(world: WooWorld, obj: ObjRef, name: string, bytecodeValue: TinyBytecode, source: string, options: { directCallable?: boolean; skipPresenceCheck?: boolean; perms?: string } = {}): void {
  const existing = world.ownVerbExact(obj, name);
  if (existing) {
    const existingDirectCallable = existing.direct_callable === true;
    const existingSkipPresenceCheck = existing.skip_presence_check === true;
    const parsedPerms = normalizeVerbPerms(options.perms ?? existing.perms, existingDirectCallable || options.directCallable === true);
    const next = {
      ...existing,
      perms: parsedPerms.perms,
      direct_callable: parsedPerms.directCallable,
      skip_presence_check: existingSkipPresenceCheck || options.skipPresenceCheck === true
    };
    if (next.perms !== existing.perms || next.direct_callable !== existingDirectCallable || next.skip_presence_check !== existingSkipPresenceCheck) world.addVerb(obj, next);
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

function sourceVerb(world: WooWorld, obj: ObjRef, name: string, source: string, options: { directCallable?: boolean; skipPresenceCheck?: boolean; toolExposed?: boolean; perms?: string; argSpec?: Record<string, WooValue>; aliases?: string[] } = {}): void {
  const compiled = compileVerb(source);
  if (!compiled.ok || !compiled.bytecode) {
    throw new Error(`bootstrap source verb failed to compile: ${obj}:${name}`);
  }
  const existing = world.ownVerbExact(obj, name);
  const existingDirectCallable = existing?.direct_callable === true;
  const existingSkipPresenceCheck = existing?.skip_presence_check === true;
  const existingToolExposed = existing?.tool_exposed === true;
  const parsedPerms = normalizeVerbPerms(options.perms ?? compiled.metadata?.perms ?? existing?.perms ?? "rx", options.directCallable === true);
  const next = {
    kind: "bytecode" as const,
    name,
    aliases: options.aliases ?? existing?.aliases ?? [],
    owner: "$wiz" as ObjRef,
    perms: parsedPerms.perms,
    arg_spec: options.argSpec ?? compiled.metadata?.arg_spec ?? existing?.arg_spec ?? {},
    source,
    source_hash: compiled.source_hash ?? hashSource(source),
    version: (existing?.version ?? 0) + 1,
    bytecode: { ...compiled.bytecode, version: (existing?.version ?? 0) + 1 },
    line_map: compiled.line_map ?? {},
    direct_callable: parsedPerms.directCallable,
    skip_presence_check: existingSkipPresenceCheck || options.skipPresenceCheck === true,
    tool_exposed: existingToolExposed || options.toolExposed === true
  };
  if (
    existing &&
    existing.kind === next.kind &&
    existing.source_hash === next.source_hash &&
    existing.perms === next.perms &&
    existingDirectCallable === next.direct_callable &&
    existingSkipPresenceCheck === next.skip_presence_check &&
    existingToolExposed === next.tool_exposed &&
    JSON.stringify(existing.aliases ?? []) === JSON.stringify(next.aliases ?? []) &&
    valuesEqual((existing.arg_spec ?? {}) as WooValue, (next.arg_spec ?? {}) as WooValue)
  ) return;
  world.addVerb(obj, next);
}

function native(world: WooWorld, obj: ObjRef, name: string, handler: string, source: string, options: { directCallable?: boolean; skipPresenceCheck?: boolean; toolExposed?: boolean; perms?: string; argSpec?: Record<string, WooValue>; aliases?: string[] } = {}): void {
  const existing = world.ownVerbExact(obj, name);
  if (existing) {
    const existingDirectCallable = existing.direct_callable === true;
    const existingSkipPresenceCheck = existing.skip_presence_check === true;
    const existingToolExposed = existing.tool_exposed === true;
    const parsedPerms = normalizeVerbPerms(options.perms ?? existing.perms, existingDirectCallable || options.directCallable === true);
    const aliases = options.aliases ?? existing.aliases;
    const argSpec = options.argSpec ?? existing.arg_spec;
    const next = {
      ...existing,
      perms: parsedPerms.perms,
      direct_callable: parsedPerms.directCallable,
      skip_presence_check: existingSkipPresenceCheck || options.skipPresenceCheck === true,
      tool_exposed: existingToolExposed || options.toolExposed === true,
      aliases,
      arg_spec: argSpec
    };
    if (
      next.perms !== existing.perms ||
      next.direct_callable !== existingDirectCallable ||
      next.skip_presence_check !== existingSkipPresenceCheck ||
      next.tool_exposed !== existingToolExposed ||
      JSON.stringify(next.aliases ?? []) !== JSON.stringify(existing.aliases ?? []) ||
      !valuesEqual((next.arg_spec ?? {}) as WooValue, (existing.arg_spec ?? {}) as WooValue)
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
