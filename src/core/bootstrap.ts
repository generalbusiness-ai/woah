import { compileVerb } from "./authoring";
import { installLocalCatalogs } from "./local-catalogs";
import type { ObjectRepository, SeedWorld, SerializedObject, SerializedWorld, WorldRepository } from "./repository";
import { isSensitiveSerializedPropertyName, redactSensitiveSerializedPropertyValues } from "./sensitive-serialization";
import { hashSource } from "./source-hash";
import type { MetricEvent, ObjRef, PresenceProjectionDef, VerbDef, WooValue } from "./types";
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

const PLAYER_WHO_ALL_SOURCE = `verb :who_all(names) rxd {
  let requested = "";
  if (names != null) { requested = str_trim(to_string(names)); }
  let players = [];
  if (requested == "") {
    players = connected_players();
  } else {
    let raw_tokens = str_split(requested, " ");
    for token in raw_tokens {
      let item = str_trim(token);
      if (item == "") { continue; }
      if (valid(item) && isa(item, $player) && !(item in players)) { players = players + [item]; }
    }
    if (length(players) == 0) {
      this:tell("I don't recognize one of those players.");
      return [];
    }
  }
  if (length(players) > 100) {
    this:tell("You have requested a listing of " + to_string(length(players)) + " players. Please specify fewer players or use a broader user listing.");
    return [];
  }
  let rows = [];
  let roster = [];
  let lines = ["Player                 Conn      Idle   Location"];
  for who in players {
    let meta = session_metadata(who);
    let loc = location(who);
    let loc_name = "Nowhere";
    if (loc != null && valid(loc)) { try { loc_name = loc:title(); } except err { loc_name = loc.name; } }
    let row = {
      player: who,
      name: who.name,
      connected: meta["connected"],
      connected_at: meta["connected_at"],
      connected_seconds: meta["connected_seconds"],
      idle_seconds: meta["idle_seconds"],
      last_login_at: meta["last_login_at"],
      location: loc,
      location_name: loc_name
    };
    rows = rows + [row];
    let presence = "sleeping";
    if (meta["connected"]) {
      presence = "awake";
      if (meta["idle_seconds"] != null && meta["idle_seconds"] >= 60) { presence = "idle"; }
    }
    let roster_row = { id: who, name: who.name, presence: presence };
    if (meta["idle_seconds"] != null) { roster_row["idle_seconds"] = meta["idle_seconds"]; }
    roster = roster + [roster_row];
    let conn = "unknown";
    if (meta["connected"]) { conn = to_string(meta["connected_seconds"]) + "s"; }
    else if (meta["last_login_at"] != null) { conn = to_string(meta["last_login_at"]); }
    let idle = "sleep";
    if (meta["connected"]) {
      idle = "active";
      if (meta["idle_seconds"] != null && meta["idle_seconds"] >= 60) { idle = to_string(meta["idle_seconds"]) + "s"; }
    }
    lines = lines + [who.name + " " + conn + " " + idle + " " + loc_name];
  }
  this:tell_lines(lines);
  observe({ type: "who", source: this, actor: actor, to: actor, room: location(this), roster: roster, text: str_join(lines, "\\n"), ts: now() });
  return rows;
}`;

const PLAYER_EXAMINE_DETAILED_SOURCE = `verb :examine_detailed(name) rxd {
  let q = "";
  if (name != null) { q = str_trim(to_string(name)); }
  if (q == "") {
    this:tell("Usage: @examine <object>");
    return null;
  }
  let here = location(this);
  let target = $match:match_object(q, here);
  if (target == $ambiguous_match) {
    this:tell("I don't know which " + q + " you mean.");
    return null;
  }
  if (target == $failed_match) {
    this:tell("I don't see " + q + " here.");
    return null;
  }
  let summary = null;
  if (is_remote_object(target)) { summary = remote_describe(target); }
  let obj_name = target.name;
  let owner = target.owner;
  let aliases = [];
  let description = "(No description set.)";
  let obvious = [];
  let remote = false;
  if (typeof(summary) == "map") {
    remote = true;
    if (has(summary, "name") && summary["name"]) { obj_name = summary["name"]; }
    if (has(summary, "owner")) { owner = summary["owner"]; }
    if (has(summary, "aliases") && typeof(summary["aliases"]) == "list") { aliases = summary["aliases"]; }
    if (has(summary, "description") && summary["description"]) { description = summary["description"]; }
    if (has(summary, "obvious_verbs") && typeof(summary["obvious_verbs"]) == "list") { obvious = summary["obvious_verbs"]; }
    let rewritten = [];
    for line in obvious {
      let idx = str_index(line, obj_name);
      if (idx > 0) { line = str_slice(line, 1, idx - 1) + q + str_slice(line, idx + length(obj_name)); }
      rewritten = rewritten + [line];
    }
    obvious = rewritten;
  } else {
    try { aliases = target.aliases; } except err { aliases = []; }
    try { if (target.description) { description = target.description; } } except err { description = "(No description set.)"; }
    let specs = obvious_verbs(target);
    let dull = [$root, $room, $player, $prog, $builder];
    for spec in specs {
      if (spec["definer"] in dull) { continue; }
      let command = spec["command"];
      let dobj = "any";
      let prep = "any";
      let iobj = "any";
      if (typeof(command) == "map") {
        if (has(command, "dobj") && typeof(command["dobj"]) == "string") { dobj = command["dobj"]; }
        if (has(command, "prep")) {
          if (typeof(command["prep"]) == "string") { prep = command["prep"]; }
          else if (typeof(command["prep"]) == "list" && length(command["prep"]) > 0) { prep = command["prep"][1]; }
        }
        if (has(command, "iobj") && typeof(command["iobj"]) == "string") { iobj = command["iobj"]; }
      }
      if (prep == "none" && iobj == "this") { continue; }
      let names = [];
      if (!str_starts(spec["name"], "@")) { names = names + [spec["name"]]; }
      for alias in spec["aliases"] { if (!str_starts(alias, "@")) { names = names + [alias]; } }
      if (length(names) == 0) { continue; }
      let syntax = str_join(names, "/");
      if (dobj != "none") { if (dobj == "this") { syntax = syntax + " " + q; } else { syntax = syntax + " <anything>"; } }
      if (prep != "none") {
        if (prep == "any") { syntax = syntax + " <anything>"; } else { syntax = syntax + " " + prep; }
        if (iobj != "none") { if (iobj == "this") { syntax = syntax + " " + q; } else { syntax = syntax + " <anything>"; } }
      }
      obvious = obvious + ["  " + syntax];
    }
  }
  let contents_rows = [];
  for item in visible_contents(target) {
    let item_name = item.name;
    contents_rows = contents_rows + [{ id: item, name: item_name }];
  }
  let target_id = target;
  if (!str_starts(target_id, "$")) { target_id = "#" + target_id; }
  let owner_id = owner;
  if (owner_id != null && !str_starts(owner_id, "$")) { owner_id = "#" + owner_id; }
  let owner_name = "a recycled player";
  if (owner != null && valid(owner)) { owner_name = owner.name; }
  let lines = [];
  if (owner != null) { lines = lines + [obj_name + " (" + target_id + ") is owned by " + owner_name + " (" + owner_id + ")."]; }
  else { lines = lines + [obj_name + " (" + target_id + ") is on a remote host."]; }
  let alias_text = "none";
  if (length(aliases) > 0) { alias_text = str_join(aliases, ", "); }
  lines = lines + ["Aliases: " + alias_text + ".", description];
  if (length(contents_rows) > 0) {
    lines = lines + ["Contents:"];
    for item_row in contents_rows {
      let item_id = item_row["id"];
      if (!str_starts(item_id, "$")) { item_id = "#" + item_id; }
      lines = lines + ["  " + item_row["name"] + " (" + item_id + ")"];
    }
  }
  if (length(obvious) > 0) {
    lines = lines + ["Obvious verbs:"];
    for line in obvious { lines = lines + [line]; }
  }
  this:tell_lines(lines);
  let result = { target: target, owner: owner, aliases: aliases, description: description, contents: contents_rows, obvious_verbs: obvious, text: str_join(lines, "\\n") };
  if (remote) { result["remote"] = true; }
  return result;
}`;

const PLAYER_TELL_SOURCE = `verb :tell() rxd {
  let out = "";
  for part in args { out = out + to_string(part); }
  tell(this, out);
  return true;
}`;

const PLAYER_TELL_LINES_SOURCE = `verb :tell_lines(lines) rxd {
  let out = lines;
  if (typeof(out) != "list") { out = args; }
  for line in out { tell(this, line); }
  return true;
}`;

const PLAYER_HELP_SOURCE = `verb :help(topic) rxd {
  let t = "index";
  if (topic != null && str_trim(to_string(topic)) != "") { t = str_lower(str_trim(to_string(topic))); }
  let dbs = [];
  let actor_chain = [this] + parents(this);
  for obj in actor_chain {
    try {
      let h = obj.help;
      if (typeof(h) == "list") { for db in h { if (db != null && !(db in dbs)) { dbs = dbs + [db]; } } }
      else if (h != null && !(h in dbs)) { dbs = dbs + [h]; }
    } except err { }
  }
  let here = location(this);
  if (here != null && valid(here)) {
    let here_chain = [here] + parents(here);
    for obj2 in here_chain {
      try {
        let hh = obj2.help;
        if (typeof(hh) == "list") { for db2 in hh { if (db2 != null && !(db2 in dbs)) { dbs = dbs + [db2]; } } }
        else if (hh != null && !(hh in dbs)) { dbs = dbs + [hh]; }
      } except err2 { }
    }
  }
  try {
    for db3 in "$system".help_dbs { if (db3 != null && !(db3 in dbs)) { dbs = dbs + [db3]; } }
  } except err3 { }
  let result = null;
  let found = false;
  let n = length(dbs);
  for i in [1..n] {
    let db4 = dbs[i];
    let remaining = [];
    if (i < n) { for j in [(i + 1)..n] { remaining = remaining + [dbs[j]]; } }
    try {
      result = dispatch(db4, "get_topic", [t, remaining]);
      found = true;
      break;
    } except err4 {
      if (err4["code"] != "E_HELPNF") { raise err4; }
    }
  }
  if (!found) {
    if (length(dbs) > 0) { try { dispatch(dbs[1], "record_miss", [t]); } except err5 { } }
    result = { ok: false, status: "not_found", topic: t, lines: ["No help available for " + str_char(34) + t + str_char(34) + "."] };
  }
  if (typeof(result) == "map" && has(result, "lines")) { this:tell_lines(result["lines"]); }
  else { this:tell(to_string(result)); }
  return result;
}`;

const ROOT_DESCRIBE_SOURCE = `verb :describe() rxd {
  return describe_object(this);
}`;

const ROOT_SET_VALUE_SOURCE = `verb :set_value(value) r {
  this.value = value;
  observe({ type: "value_changed", source: this, value: value });
  return value;
}`;

const ROOT_SET_PROP_SOURCE = `verb :set_prop(name, value) r {
  this.(name) = value;
  observe({ type: "property_changed", source: this, name: name, value: value });
  return value;
}`;

const ROOT_TITLE_SOURCE = `verb :title() rxd {
  return this.name;
}`;

const ROOT_LOOK_SELF_SOURCE = `verb :look_self() rxd {
  set_task_perms(actor);
  let description = null;
  try { description = this.description; } except err { description = null; }
  return { id: this, title: this:title(), description: description };
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

const THING_LOOK_SOURCE = `verb :look() rxd {
  let view = this:look_self();
  let text = "";
  if (typeof(view) == "map" && has(view, "description") && view["description"]) {
    text = to_string(view["description"]);
  } else {
    text = to_string(view);
  }
  observe({ type: "looked", actor: actor, to: actor, room: location(this), target: this, text: text, look: view, ts: now() });
  return view;
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
    world.importWorld(cachedBootSnapshot(options.catalogs));
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
    // Fresh repository-backed worlds should start from the same deterministic
    // boot snapshot as in-memory worlds. Reusing the cached snapshot avoids
    // recompiling/reinstalling bundled catalogs for every empty test or cold
    // repository while preserving the persisted first-save shape.
    world.importWorld(cachedBootSnapshot(options.catalogs));
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

export function scopeSerializedWorldToHost(serialized: SerializedWorld, host: ObjRef): SeedWorld {
  const world = new WooWorld();
  world.importWorld(serialized);
  return world.exportHostScopedWorld(host);
}

export function nonEmptyHostScopedWorld(serialized: SerializedWorld, host: ObjRef): SeedWorld | null {
  const scoped = scopeSerializedWorldToHost(serialized, host);
  return scoped.objects.length > 0 ? scoped : null;
}

export type HostScopedSeedMergeResult = {
  world: SerializedWorld;
  changed: boolean;
  /** Per-object reasons captured during merge — empty when changed=false.
   * Each entry names the object id and up to ~8 specific field paths
   * (e.g. `verbs[name.calls (deep)]`, `propertyDefs.foo(replace)`,
   * `properties.bar(delete)`) that drove the change. Surfaced via the
   * `host_seed_merge_diff` diagnostic so cold-load write churn is
   * traceable to the exact field instead of a generic field-name pointer. */
  reasons?: Array<{ id: ObjRef; reasons: string[] }>;
};

export function mergeHostScopedSeed(stored: SerializedWorld, seed: SeedWorld, receiverHost: ObjRef): SerializedWorld {
  return mergeHostScopedSeedWithStatus(stored, seed, receiverHost).world;
}

/**
 * Per spec/protocol/host-seeds.md §HS2–HS4: pure function from
 * (stored, seed, receiverHost) to a merged slice plus a `changed`
 * flag. Receiver-hosted subjects are skipped if already in stored
 * (HS2.1); foreign-hosted subjects merge declarative state only
 * (HS2.2). Children, contents, and modified are skipped on every
 * subject. Tombstones for foreign-hosted ids union into stored (HS4).
 */
export function mergeHostScopedSeedWithStatus(stored: SerializedWorld, seed: SeedWorld, receiverHost: ObjRef): HostScopedSeedMergeResult {
  // Two-pass lazy-clone strategy. A clean wake (changed=false) is the
  // common case, and the original implementation deep-cloned the entire
  // stored slice up front — wasted work the moment we need to throw the
  // clone away. Instead we run a probe pass that mutates per-object
  // clones (cheap), records each one that produced a change, and only
  // assembles the final SerializedWorld if anything changed.
  const storedById = new Map<ObjRef, SerializedObject>(stored.objects.map((obj) => [obj.id, obj]));
  const storedTombstones = new Set(stored.tombstones ?? []);
  const replacements = new Map<ObjRef, SerializedObject>(); // id → mutated clone
  const additions: SerializedObject[] = []; // never-seen-before subjects
  const newTombstones: ObjRef[] = []; // ids to add to stored.tombstones
  const removeIds = new Set<ObjRef>(); // ids whose stub HS4 retires
  const reasonLog: Array<{ id: ObjRef; reasons: string[] }> = [];
  let changed = false;

  for (const seedObj of seed.objects) {
    if (storedTombstones.has(seedObj.id)) continue;
    const redactedSeedObj = redactSensitiveSerializedPropertyValues(seedObj);
    const current = storedById.get(seedObj.id);
    if (!current) {
      additions.push(cloneSerializedObject(redactedSeedObj));
      changed = true;
      reasonLog.push({ id: redactedSeedObj.id, reasons: ["<add>"] });
      continue;
    }
    if (seed.objectHosts[seedObj.id] === receiverHost) continue;
    const probe = cloneSerializedObject(current);
    const objReasons: string[] = [];
    if (mergeSeedObject(probe, redactedSeedObj, objReasons)) {
      replacements.set(redactedSeedObj.id, probe);
      changed = true;
      if (objReasons.length > 0) reasonLog.push({ id: redactedSeedObj.id, reasons: objReasons });
    }
  }

  // HS4: foreign-hosted tombstones, scoped to ids the receiver has stubs
  // for (cost rule). gateway.tombstones is gateway-hosted-by-construction
  // (recycleChecked's E_CROSS_HOST_WRITE guards make all gateway-side
  // recycles host-local), so every entry is foreign-hosted from any
  // satellite's view.
  if (seed.tombstones && seed.tombstones.length > 0) {
    for (const id of seed.tombstones) {
      if (storedTombstones.has(id)) continue;
      if (seed.objectHosts[id] === receiverHost) continue; // forward-compat guard
      if (!storedById.has(id)) continue; // HS4 cost rule: skip if no stub
      newTombstones.push(id);
      removeIds.add(id);
      changed = true;
      reasonLog.push({ id, reasons: ["<tombstone>"] });
    }
  }

  if (!changed) return { world: stored, changed: false, reasons: [] };

  // Materialize the merged slice. One pass over stored.objects, swapping
  // in replacements / dropping removeIds, then append additions.
  const mergedObjects: SerializedObject[] = [];
  for (const obj of stored.objects) {
    if (removeIds.has(obj.id)) continue;
    const replacement = replacements.get(obj.id);
    mergedObjects.push(replacement ?? obj);
  }
  for (const add of additions) mergedObjects.push(add);

  const mergedTombstones = newTombstones.length > 0
    ? [...(stored.tombstones ?? []), ...newTombstones].sort()
    : stored.tombstones;

  return {
    world: { ...stored, objects: mergedObjects, tombstones: mergedTombstones },
    changed: true,
    reasons: reasonLog
  };
}

export function bootstrap(world: WooWorld, options: BootstrapOptions = {}): WooWorld {
  seedUniversal(world);
  world.gcPendingCredentials();
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
  "installed_catalogs",
  // Per-host one-shot scrub marker (set by scrubStaleSubscribersOnce on
  // the receiver's local copy of $space-descendants); the gateway never
  // sees it, so the merge must not propagate-delete it from stored.
  "_subscribers_scrubbed_v1"
]);

/** Drop "phantom" boolean fields whose persistent encoding represents
 * `false` as absence. Without this, a round-trip through the CF
 * repository produces flags like `{wizard:false, programmer:false,
 * fertile:false}` (`flagsFromSqlInt` always returns explicit booleans)
 * while a freshly-bootstrapped gateway has plain `{}` — and
 * `valuesEqual` reports them as different, making the seed merge
 * non-idempotent. */
function normalizeFlagsForCompare(flags: Record<string, unknown> | undefined): Record<string, true> {
  if (!flags) return {};
  const out: Record<string, true> = {};
  for (const [k, v] of Object.entries(flags)) if (v === true) out[k] = true;
  return out;
}

/** Drop verb fields whose persistent encoding represents `false` as
 * absence (`verbFlagsJson` + `verbFromSqlRow` only round-trip the boolean
 * verb flags when `=== true`). Drop `slot` because it's a per-host index
 * assigned by `importWorld`, not authoritative across hosts. Drop
 * `version` because catalog repair / addVerb bump it locally on every
 * idempotent reinstall and the counter accumulates independently across
 * hosts (same trap as PropertyDef.version). Drop `bytecode` and
 * `line_map` because both are derived from `source` — `source_hash`
 * already covers source identity, and `bytecode.version` carries the
 * same drifting counter as the verb-level `version`. The merge covers
 * authoritative divergence via source_hash and the remaining metadata
 * (aliases, arg_spec, kind/native, calls, perms, owner, flags). */
function normalizeVerbForCompare(verb: VerbDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(verb as Record<string, unknown>)) {
    if (k === "direct_callable" || k === "skip_presence_check" || k === "tool_exposed" || k === "reads_room_presence" || k === "pure" || k === "pure_declared") {
      if (v === true) out[k] = true;
      continue;
    }
    if (k === "slot" || k === "version" || k === "bytecode" || k === "line_map") continue;
    out[k] = v;
  }
  return out;
}

/** Returns null when the two verb lists are merge-equivalent, otherwise a
 * short string describing the first concrete divergence. `mergeSeedObject`
 * surfaces this in `host_seed_merge_diff` so we can see which field drove a
 * seed-verb update instead of guessing post-hoc. */
function verbsDiff(left: VerbDef[], right: VerbDef[]): string | null {
  if (left.length !== right.length) {
    return `length stored=${left.length} seed=${right.length}`;
  }
  const leftByName = new Map(left.map((v) => [v.name, v]));
  const rightByName = new Map(right.map((v) => [v.name, v]));
  if (leftByName.size !== rightByName.size) {
    return `unique-name count stored=${leftByName.size} seed=${rightByName.size}`;
  }
  for (const [name, lv] of leftByName) {
    const rv = rightByName.get(name);
    if (!rv) return `${name} missing in seed`;
    if (lv.source_hash && rv.source_hash && lv.source_hash === rv.source_hash) {
      const meta = verbMetadataDiff(lv, rv);
      if (meta === null) continue;
      return `${name}.${meta}`;
    }
    const ln = normalizeVerbForCompare(lv);
    const rn = normalizeVerbForCompare(rv);
    if (!valuesEqual(ln as WooValue, rn as WooValue)) {
      const lk = Object.keys(ln);
      const rk = Object.keys(rn);
      const allKeys = new Set([...lk, ...rk]);
      for (const k of allKeys) {
        if (JSON.stringify(ln[k]) !== JSON.stringify(rn[k])) return `${name}.${k} (deep)`;
      }
      return `${name} (deep, key unknown)`;
    }
  }
  return null;
}

/** Returns null when authoritative verb metadata matches, otherwise a
 * short field-name string identifying the first divergence. Drops `version`
 * (per-host bump counter; see `normalizeVerbForCompare`); covers
 * aliases, arg_spec, kind/native, calls, perms, owner, and the boolean
 * flags. */
function verbMetadataDiff(a: VerbDef, b: VerbDef): string | null {
  if (a.perms !== b.perms) return "perms";
  if (a.owner !== b.owner) return "owner";
  if ((a.direct_callable === true) !== (b.direct_callable === true)) return "direct_callable";
  if ((a.skip_presence_check === true) !== (b.skip_presence_check === true)) return "skip_presence_check";
  if ((a.tool_exposed === true) !== (b.tool_exposed === true)) return "tool_exposed";
  if ((a.reads_room_presence === true) !== (b.reads_room_presence === true)) return "reads_room_presence";
  if ((a.pure === true) !== (b.pure === true)) return "pure";
  if ((a.pure_declared === true) !== (b.pure_declared === true)) return "pure_declared";
  if (a.kind !== b.kind) return "kind";
  if (a.kind === "native" && b.kind === "native" && a.native !== b.native) return "native";
  if (!arraysShallowEqualStrings(a.aliases ?? [], b.aliases ?? [])) return "aliases";
  if (!valuesEqual((a.arg_spec ?? {}) as WooValue, (b.arg_spec ?? {}) as WooValue)) return "arg_spec";
  const aCalls = Array.isArray(a.calls) ? a.calls : null;
  const bCalls = Array.isArray(b.calls) ? b.calls : null;
  if ((aCalls === null) !== (bCalls === null)) return "calls (one missing)";
  if (aCalls && bCalls && !valuesEqual(aCalls as unknown as WooValue, bCalls as unknown as WooValue)) return "calls";
  return null;
}

function arraysShallowEqualStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function eventSchemasEqualIgnoringOrder(
  a: readonly [string, Record<string, WooValue>][],
  b: readonly [string, Record<string, WooValue>][]
): boolean {
  if (a.length !== b.length) return false;
  const byName = new Map(a);
  if (byName.size !== a.length) return false;
  for (const [name, schema] of b) {
    const current = byName.get(name);
    if (!current || !valuesEqual(current as unknown as WooValue, schema as unknown as WooValue)) return false;
  }
  return true;
}

/** Compare two propertyDef rows on the authoritative fields only.
 * Excludes `version`, which is a per-host bump counter that accumulates on
 * every defineProperty() call (idempotent or not) and drifts independently
 * across hosts even when the catalog state is identical. Including it made
 * the seed merge non-idempotent on production satellites whose stored defs
 * had bumped past the gateway's authoritative version. */
function propertyDefEqualIgnoringVersion(
  a: { name: string; owner: string; perms: string; typeHint?: string; defaultValue: WooValue; presenceProjection?: PresenceProjectionDef },
  b: { name: string; owner: string; perms: string; typeHint?: string; defaultValue: WooValue; presenceProjection?: PresenceProjectionDef }
): boolean {
  if (a.name !== b.name) return false;
  if (a.owner !== b.owner) return false;
  if (a.perms !== b.perms) return false;
  if ((a.typeHint ?? null) !== (b.typeHint ?? null)) return false;
  if (!valuesEqual(a.defaultValue, b.defaultValue)) return false;
  if (!valuesEqual((a.presenceProjection ?? null) as unknown as WooValue, (b.presenceProjection ?? null) as unknown as WooValue)) return false;
  return true;
}

/**
 * Merge a single foreign-hosted subject's declarative state from seed
 * into stored. Per spec/protocol/host-seeds.md §HS2.2.
 *
 * Skipped on every subject: `children`, `contents`, `modified`,
 * `created`, `id`. Those are derived/clock fields; cross-host views
 * disagree on them by construction.
 *
 * Deletions: properties/propertyVersions/propertyDefs in stored but
 * absent from seed are removed (except dynamic-property names, which
 * the receiver writes locally).
 */
function mergeSeedObject(current: SerializedObject, seed: SerializedObject, reasons?: string[]): boolean {
  let changed = false;
  const note = (r: string): void => { if (reasons && reasons.length < 8) reasons.push(r); };
  if (current.name !== seed.name) {
    current.name = seed.name;
    changed = true;
    note("name");
  }
  if (current.parent !== seed.parent) {
    current.parent = seed.parent;
    changed = true;
    note("parent");
  }
  if (current.owner !== seed.owner) {
    current.owner = seed.owner;
    changed = true;
    note("owner");
  }
  if (current.location !== seed.location) {
    current.location = seed.location;
    changed = true;
    note("location");
  }
  if (current.anchor !== seed.anchor) {
    current.anchor = seed.anchor;
    changed = true;
    note("anchor");
  }
  if (!valuesEqual(normalizeFlagsForCompare(current.flags) as WooValue, normalizeFlagsForCompare(seed.flags) as WooValue)) {
    current.flags = cloneSerialized(seed.flags);
    changed = true;
    note("flags");
  }
  const verbsReason = verbsDiff(current.verbs, seed.verbs);
  if (verbsReason !== null) {
    current.verbs = cloneSerialized(seed.verbs);
    changed = true;
    note(`verbs[${verbsReason}]`);
  }
  // CFObjectRepository reloads event_schema rows ordered by type, while bundled
  // catalog seeds preserve manifest order. The schema set is authoritative, not
  // the row order; comparing arrays positionally caused a full satellite
  // snapshot on every otherwise-clean cold load.
  if (!eventSchemasEqualIgnoringOrder(current.eventSchemas, seed.eventSchemas)) {
    current.eventSchemas = cloneSerialized(seed.eventSchemas);
    changed = true;
    note("eventSchemas");
  }

  // propertyDefs: merge seed entries, then delete stored-only entries.
  // Compare excluding `version` — that field bumps on every defineProperty()
  // call and accumulates locally on satellites (catalog repair, schema
  // sync) without changing what's authoritative (name/owner/perms/typeHint/
  // defaultValue). Including version made the merge non-idempotent: stored
  // versions kept growing past the gateway's, every cold-load triggered a
  // replace, the replace took seed's lower version, and the next satellite
  // write bumped it again. Spec HS2.2 calls for declarative-state merge
  // here, not bookkeeping reconciliation.
  const seedDefs = new Map(seed.propertyDefs.map((def) => [def.name, def]));
  const currentDefs = new Map(current.propertyDefs.map((def) => [def.name, def]));
  let defsChanged = false;
  for (const [name, def] of seedDefs) {
    const cur = currentDefs.get(name);
    if (!cur || !propertyDefEqualIgnoringVersion(cur, def)) {
      currentDefs.set(name, def);
      defsChanged = true;
      note(cur ? `propertyDefs.${name}(replace)` : `propertyDefs.${name}(add)`);
    }
  }
  for (const name of Array.from(currentDefs.keys())) {
    if (!seedDefs.has(name)) {
      currentDefs.delete(name);
      defsChanged = true;
      note(`propertyDefs.${name}(delete)`);
    }
  }
  if (defsChanged) {
    current.propertyDefs = Array.from(currentDefs.values()).map((def) => cloneSerialized(def));
    changed = true;
  }

  const properties = new Map(current.properties);
  const versions = new Map(current.propertyVersions);
  const seedProperties = new Map(seed.properties);
  const seedVersions = new Map(seed.propertyVersions);
  const deletedSensitiveProperties = new Set<string>();

  // HS2.2 take-seed pass. Only the value gate is authoritative; the
  // version is bookkeeping that follows the value. If gateway-side code
  // calls setProp(equal_value), the version bumps locally even though
  // nothing observable changed — so the seed will arrive with a higher
  // version but the same value. Without this guard, every satellite
  // cold-load takes the bumped version and writes a full snapshot, even
  // though the actual property is unchanged. We now take seed's version
  // only when we also take seed's value (or stored has no entry yet),
  // which keeps version monotone with respect to real changes and stops
  // the no-op-write storm.
  for (const [name, value] of seedProperties) {
    if (DYNAMIC_HOST_SEED_PROPERTIES.has(name) && (properties.has(name) || versions.has(name))) continue;
    const storedV = Number(versions.get(name) ?? 0);
    const seedV = Number(seedVersions.get(name) ?? 0);
    if (storedV >= seedV && properties.has(name)) continue;
    if (!valuesEqual(properties.get(name) as WooValue, value as WooValue)) {
      properties.set(name, cloneSerialized(value));
      versions.set(name, seedV);
      changed = true;
      note(`properties.${name}(take)`);
    } else if (!properties.has(name)) {
      properties.set(name, cloneSerialized(value));
      versions.set(name, seedV);
      changed = true;
      note(`properties.${name}(init)`);
    }
  }
  for (const [name, version] of seedVersions) {
    if (DYNAMIC_HOST_SEED_PROPERTIES.has(name) && versions.has(name)) continue;
    if (versions.has(name)) continue;
    if (seedProperties.has(name)) continue;
    versions.set(name, version);
    changed = true;
    note(`propertyVersions.${name}(init)`);
  }

  for (const name of Array.from(properties.keys())) {
    if (DYNAMIC_HOST_SEED_PROPERTIES.has(name)) continue;
    if (seedProperties.has(name)) continue;
    if (isSensitiveSerializedPropertyName(current, name)) {
      const storedValue = properties.get(name);
      if (isEmptySensitiveSerializedPropertyValue(storedValue)) continue;
      deletedSensitiveProperties.add(name);
    }
    properties.delete(name);
    changed = true;
    note(`properties.${name}(delete)`);
  }
  for (const name of Array.from(versions.keys())) {
    if (DYNAMIC_HOST_SEED_PROPERTIES.has(name)) continue;
    if (seedProperties.has(name) || seedVersions.has(name)) continue;
    if (isSensitiveSerializedPropertyName(current, name) && !deletedSensitiveProperties.has(name)) continue;
    versions.delete(name);
    changed = true;
    note(`propertyVersions.${name}(delete)`);
  }

  if (changed) {
    current.properties = Array.from(properties.entries());
    current.propertyVersions = Array.from(versions.entries());
  }

  // Children/contents/modified explicitly NOT merged (HS2.2 skip-list).
  return changed;
}

function isEmptySensitiveSerializedPropertyValue(value: WooValue | undefined): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === "object") return Object.keys(value as Record<string, WooValue>).length === 0;
  return false;
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
  world.createObject({ id: "$account", name: "$account", parent: "$root", owner: "$wiz" });
  world.createObject({ id: "$human", name: "$human", parent: "$player", owner: "$wiz" });
  world.createObject({ id: "$agent", name: "$agent", parent: "$player", owner: "$wiz" });
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

  for (const id of ["$root", "$actor", "$player", "$account", "$human", "$agent", "$sequenced_log", "$space", "$thing", "$catalog", "$catalog_registry"]) {
    // Seed the `name` property with the WooObject.name attribute (rather
    // than ""), so woocode `obj.name` reads the actual seed name on every
    // descendant. createAuthoredObject already follows this mirroring rule
    // ("WooObject.name is the display/core metadata; the inherited `name`
    // property is the source-level slot read by woocode"); without this
    // seed value, $wiz / $thing / $room / … return "" for `obj.name`
    // even though the substrate carries the real name on the attribute.
    // The defaultValue is propagated to descendants via inheritance, so
    // setting it on the ancestors above is enough — we don't need to
    // mirror onto every individual object.
    const seedName = world.object(id).name ?? "";
    define(world, id, "name", seedName, "str", "r");
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
  describeSeed(world, "$account", "Credential-bearing identity record. Accounts are not actors; they bind email/password or OAuth credentials to one primary $human and the $agent actors owned by that human.");
  describeSeed(world, "$human", "Credentialed human actor class. A human has an account backpointer and can provision owned agent actors within account quotas.");
  describeSeed(world, "$agent", "API-key-authenticated actor class. Agents are owned by a human or wizard, carry one active API key, and record their provisioning source for audit and reconnect flows.");
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
  define(world, "$system", "api_keys", {}, "map", "");
  define(world, "$system", "bearer_tokens", {}, "map", "");
  define(world, "$system", "pending_email_verifications", [], "list<map>", "");
  define(world, "$system", "signup_invites", [], "list<map>", "");
  seedProp(world, "$system", "signup_invite_required", false);
  seedProp(world, "$system", "allowed_provision_return_schemes", ["hermes://"]);
  define(world, "$system", "provision_state_nonces", [], "list<map>", "");
  seedProp(world, "$system", "mcp_endpoint_url", "/mcp");
  seedProp(world, "$system", "default_agent_quota", 5);
  seedProp(world, "$system", "default_programmer_grant_quota", 0);
  define(world, "$system", "help_dbs", [], "list<obj>", "r");
  define(world, "$root", "help", null, "obj|list<obj>|null", "r");
  define(world, "$actor", "features", [], "list<obj>", "r");
  define(world, "$actor", "features_version", 0, "int", "r");
  define(world, "$actor", "focus_list", [], "list<obj>", "r");
  define(world, "$player", "home", "$nowhere", "obj|null");
  define(world, "$account", "email", "", "str", "r");
  define(world, "$account", "email_verified_at", null, "int|null", "r");
  define(world, "$account", "password_hash", null, "str|null", "");
  define(world, "$account", "password_salt", null, "str|null", "");
  define(world, "$account", "oauth_identities", [], "list<map>", "");
  define(world, "$account", "actors", [], "list<obj>", "r");
  define(world, "$account", "primary_actor", null, "obj|null", "r");
  define(world, "$account", "agent_quota", 5, "int", "r");
  define(world, "$account", "programmer_grant_quota", 0, "int", "r");
  define(world, "$account", "agent_count", 0, "int", "r");
  define(world, "$account", "programmer_agent_count", 0, "int", "r");
  define(world, "$account", "signup_method", "wizard", "str", "r");
  define(world, "$account", "created_at", 0, "int", "r");
  define(world, "$account", "deactivated_at", null, "int|null", "r");
  define(world, "$account", "recycle_on_delete", false, "bool", "r");
  define(world, "$human", "account", null, "obj|null", "r");
  define(world, "$agent", "api_key_id", null, "str|null", "r");
  define(world, "$agent", "created_via", "wizard", "str", "r");
  define(world, "$agent", "profile_id", null, "str|null", "r");
  define(world, "$agent", "last_seen_at", null, "int|null", "r");
  define(world, "$agent", "purpose", "", "str", "r");
  define(world, "$agent", "scope", "write", "str", "r");
  define(world, "$agent", "deactivated_at", null, "int|null", "r");
  removeSeedProperty(world, "$player", "attached_sockets");
  // Legacy: $player.session_id was a write-only mirror of the session table
  // that no reader ever consulted. Retired now that session lifecycle lives
  // exclusively in `world.sessions`. The def is no longer (re)defined here;
  // a one-shot migration drops any own def/values on $player and its
  // descendants for upgraded worlds.
  define(world, "$space", "next_seq", 1, "int", "r");
  define(world, "$space", "session_subscribers", [], "list<map>", "r", { kind: "presence", key: "session", sessionField: "session", actorField: "actor" });
  define(world, "$space", "subscribers", [], "list<obj>", "r", { kind: "presence", key: "actor" });
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

  sourceVerb(world, "$root", "set_value", ROOT_SET_VALUE_SOURCE, { perms: "r" });
  sourceVerb(world, "$root", "set_prop", ROOT_SET_PROP_SOURCE, { perms: "r" });
  sourceVerb(world, "$root", "describe", ROOT_DESCRIBE_SOURCE, { directCallable: true });
  sourceVerb(world, "$root", "title", ROOT_TITLE_SOURCE, { directCallable: true });
  sourceVerb(world, "$root", "look_self", ROOT_LOOK_SELF_SOURCE, { directCallable: true });
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
  sourceVerb(world, "$player", "who_all", PLAYER_WHO_ALL_SOURCE, {
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
  sourceVerb(world, "$player", "examine_detailed", PLAYER_EXAMINE_DETAILED_SOURCE, {
    directCallable: true,
    toolExposed: true,
    aliases: ["@exam*ine"],
    argSpec: { args: ["name"], command: { dobj: "any", prep: "any", iobj: "any", args_from: ["argstr"] } }
  });
  native(world, "$player", "on_disfunc", "player_on_disfunc", "verb :on_disfunc() r { ... }", { perms: "r" });
  native(world, "$player", "moveto", "player_moveto", "verb :moveto(target) r { ... }", { perms: "r" });
  sourceVerb(world, "$player", "tell", PLAYER_TELL_SOURCE, { directCallable: true });
  sourceVerb(world, "$player", "tell_lines", PLAYER_TELL_LINES_SOURCE, { directCallable: true });
  sourceVerb(world, "$player", "help", PLAYER_HELP_SOURCE, {
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
  native(world, "$system", "provision_actor", "provision_actor", "verb :provision_actor(class, owner, attrs?) rxd { /* native: wizard-only audited actor provisioning primitive. */ }", { directCallable: true, perms: "rxd", argSpec: { args: ["class", "owner", "attrs?"] } });
  native(world, "$system", "rotate_api_key", "rotate_api_key", "verb :rotate_api_key(actor, force?) rxd { /* native: mint a replacement API key for an agent actor. */ }", { directCallable: true, perms: "rxd", argSpec: { args: ["actor", "force?"] } });
  native(world, "$system", "deactivate_actor", "deactivate_actor", "verb :deactivate_actor(actor, reason?) rxd { /* native: deactivate an account-bound actor and reap relevant sessions. */ }", { directCallable: true, perms: "rxd", argSpec: { args: ["actor", "reason?"] } });
  native(world, "$system", "reactivate_actor", "reactivate_actor", "verb :reactivate_actor(actor) rxd { /* native: clear deactivation markers for an actor/account. */ }", { directCallable: true, perms: "rxd", argSpec: { args: ["actor"] } });
  native(world, "$system", "recycle_actor", "recycle_actor", "verb :recycle_actor(actor) rxd { /* native: audited hard-recycle wrapper. */ }", { directCallable: true, perms: "rxd", argSpec: { args: ["actor"] } });
  native(world, "$system", "issue_signup_invite", "issue_signup_invite", "verb :issue_signup_invite(quantity, expires_at) rxd { /* native: wizard-only signup invite minting. */ }", { directCallable: true, perms: "rxd", argSpec: { args: ["quantity", "expires_at"] } });
  native(world, "$system", "gc_pending_credentials", "gc_pending_credentials", "verb :gc_pending_credentials() rxd { /* native: wizard-only sweep for expired bearer tokens, signup verifications, provision states, and stale invite records. */ }", { directCallable: true, perms: "rxd", argSpec: { args: [] } });
  native(world, "$system", "set_actor_flag", "set_actor_flag", "verb :set_actor_flag(actor, flag, value) rxd { /* native: audited flag mutation with agent programmer quota checks. */ }", { directCallable: true, perms: "rxd", argSpec: { args: ["actor", "flag", "value"] } });
  native(world, "$system", "set_quota", "set_quota", "verb :set_quota(account, kind, value) rxd { /* native: audited per-account quota mutation. */ }", { directCallable: true, perms: "rxd", argSpec: { args: ["account", "kind", "value"] } });
  native(world, "$human", "create_agent", "human_create_agent", "verb :create_agent(name, purpose?, programmer?) rxd { /* native: self-service agent provisioning. */ }", { directCallable: true, toolExposed: true, perms: "rxd", argSpec: { args: ["name", "purpose?", "programmer?"] } });
  native(world, "$human", "list_agents", "human_list_agents", "verb :list_agents() rxd { /* native: list agents owned by this human. */ }", { directCallable: true, toolExposed: true, perms: "rxd", argSpec: { args: [] } });
  native(world, "$human", "revoke_agent", "human_revoke_agent", "verb :revoke_agent(actor_id, reason?) rxd { /* native: revoke an owned agent and its current key. */ }", { directCallable: true, toolExposed: true, perms: "rxd", argSpec: { args: ["actor_id", "reason?"] } });
  native(world, "$human", "promote_agent_to_programmer", "human_promote_agent_to_programmer", "verb :promote_agent_to_programmer(actor_id) rxd { /* native: consume programmer-agent quota and set programmer flag. */ }", { directCallable: true, toolExposed: true, perms: "rxd", argSpec: { args: ["actor_id"] } });
  native(world, "$human", "demote_agent_from_programmer", "human_demote_agent_from_programmer", "verb :demote_agent_from_programmer(actor_id) rxd { /* native: clear programmer flag on an owned agent. */ }", { directCallable: true, toolExposed: true, perms: "rxd", argSpec: { args: ["actor_id"] } });
  native(world, "$human", "rotate_agent_key", "human_rotate_agent_key", "verb :rotate_agent_key(actor_id, force?) rxd { /* native: rotate an owned agent key. */ }", { directCallable: true, toolExposed: true, perms: "rxd", argSpec: { args: ["actor_id", "force?"] } });
  native(world, "$thing", "can_be_attached_by", "feature_can_be_attached_by", "verb :can_be_attached_by(actor) rxd { ... }", { directCallable: true });
  native(world, "$thing", "moveto", "thing_moveto", "verb :moveto(target) rxd { return moveto(this, target); }");
  sourceVerb(world, "$thing", "look", THING_LOOK_SOURCE, {
    directCallable: true,
    toolExposed: true,
    aliases: ["l@ook", "ex@amine"],
    argSpec: { args: [], command: { dobj: "this", prep: "none", iobj: "none", args_from: [], parse: false } }
  });
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

function define(
  world: WooWorld,
  obj: ObjRef,
  name: string,
  defaultValue: WooValue,
  typeHint: string,
  perms = "rw",
  presenceProjection?: PresenceProjectionDef
): void {
  const existing = world.object(obj).propertyDefs.get(name);
  if (existing) {
    if (
      existing.typeHint !== typeHint ||
      existing.perms !== perms ||
      !valuesEqual((existing.presenceProjection ?? null) as unknown as WooValue, (presenceProjection ?? null) as unknown as WooValue)
    ) {
      world.defineProperty(obj, {
        ...existing,
        typeHint,
        perms,
        ...(presenceProjection ? { presenceProjection } : { presenceProjection: undefined }),
        version: existing.version + 1
      });
    }
    return;
  }
  world.defineProperty(obj, {
    name,
    defaultValue,
    typeHint,
    owner: "$wiz",
    perms,
    ...(presenceProjection ? { presenceProjection } : {})
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

function sourceVerb(world: WooWorld, obj: ObjRef, name: string, source: string, options: { directCallable?: boolean; skipPresenceCheck?: boolean; toolExposed?: boolean; readsRoomPresence?: boolean; perms?: string; argSpec?: Record<string, WooValue>; aliases?: string[] } = {}): void {
  const compiled = compileVerb(source);
  if (!compiled.ok || !compiled.bytecode) {
    throw new Error(`bootstrap source verb failed to compile: ${obj}:${name}`);
  }
  const existing = world.ownVerbExact(obj, name);
  const existingDirectCallable = existing?.direct_callable === true;
  const existingSkipPresenceCheck = existing?.skip_presence_check === true;
  const existingToolExposed = existing?.tool_exposed === true;
  const existingReadsRoomPresence = existing?.reads_room_presence === true;
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
    tool_exposed: existingToolExposed || options.toolExposed === true,
    reads_room_presence: existingReadsRoomPresence || options.readsRoomPresence === true
  };
  if (
    existing &&
    existing.kind === next.kind &&
    existing.source_hash === next.source_hash &&
    existing.perms === next.perms &&
    existingDirectCallable === next.direct_callable &&
    existingSkipPresenceCheck === next.skip_presence_check &&
    existingToolExposed === next.tool_exposed &&
    existingReadsRoomPresence === next.reads_room_presence &&
    JSON.stringify(existing.aliases ?? []) === JSON.stringify(next.aliases ?? []) &&
    valuesEqual((existing.arg_spec ?? {}) as WooValue, (next.arg_spec ?? {}) as WooValue)
  ) return;
  world.addVerb(obj, next);
}

function native(world: WooWorld, obj: ObjRef, name: string, handler: string, source: string, options: { directCallable?: boolean; skipPresenceCheck?: boolean; toolExposed?: boolean; readsRoomPresence?: boolean; perms?: string; argSpec?: Record<string, WooValue>; aliases?: string[] } = {}): void {
  const existing = world.ownVerbExact(obj, name);
  if (existing) {
    const existingDirectCallable = existing.direct_callable === true;
    const existingSkipPresenceCheck = existing.skip_presence_check === true;
    const existingToolExposed = existing.tool_exposed === true;
    const existingReadsRoomPresence = existing.reads_room_presence === true;
    const parsedPerms = normalizeVerbPerms(options.perms ?? existing.perms, existingDirectCallable || options.directCallable === true);
    const aliases = options.aliases ?? existing.aliases;
    const argSpec = options.argSpec ?? existing.arg_spec;
    const next = {
      ...existing,
      perms: parsedPerms.perms,
      direct_callable: parsedPerms.directCallable,
      skip_presence_check: existingSkipPresenceCheck || options.skipPresenceCheck === true,
      tool_exposed: existingToolExposed || options.toolExposed === true,
      reads_room_presence: existingReadsRoomPresence || options.readsRoomPresence === true,
      aliases,
      arg_spec: argSpec
    };
    if (
      next.perms !== existing.perms ||
      next.direct_callable !== existingDirectCallable ||
      next.skip_presence_check !== existingSkipPresenceCheck ||
      next.tool_exposed !== existingToolExposed ||
      next.reads_room_presence !== existingReadsRoomPresence ||
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
    tool_exposed: options.toolExposed === true,
    reads_room_presence: options.readsRoomPresence === true
  });
}


export { hashSource };
