import { BUNDLED_CATALOGS } from "../generated/bundled-catalogs";
import {
  applyCatalogSchemaPlan,
  catalogManifestStatus,
  installCatalogManifest,
  planCatalogSchemaMigration,
  updateCatalogManifest,
  verifyCatalogSchemaPlan,
  type CatalogManifest,
  type CatalogManifestStatus,
  type CatalogMigrationManifest,
  type CatalogSchemaPlanApplyResult,
  type CatalogSchemaPlanScope
} from "./catalog-installer";
import { valuesEqual, type ObjRef, type WooValue } from "./types";
import type { WooWorld } from "./world";

export type LocalCatalogName = string;
export type LocalCatalogStatus = CatalogManifestStatus & {
  local: true;
  migrations: Array<{ id: string; applied: boolean }>;
  pending_migrations: string[];
};

const LOCAL_CATALOGS = new Map(BUNDLED_CATALOGS.map((entry) => [entry.manifest.name, entry.manifest] as const));
const LOCAL_CATALOG_MIGRATIONS = new Map(BUNDLED_CATALOGS.map((entry) => [entry.manifest.name, entry.migrations] as const));
const LOCAL_CATALOG_SOURCE_MIGRATION = "2026-04-30-source-catalog-verbs";
const LOCAL_CATALOG_PLACEMENT_MIGRATION = "2026-04-30-catalog-placement-metadata";
const LOCAL_CATALOG_CHAT_COCKATOO_MIGRATION = "2026-04-30-chat-cockatoo";
const LOCAL_CATALOG_CHAT_LOOK_CONTENTS_MIGRATION = "2026-04-30-chat-look-contents";
const LOCAL_CATALOG_CHAT_COMMAND_PARSER_MIGRATION = "2026-04-30-chat-command-parser";
const LOCAL_CATALOG_DUBSPACE_CONTROL_GUARDS_MIGRATION = "2026-04-30-dubspace-control-guards";
const LOCAL_CATALOG_DUBSPACE_MOUNTED_CONTROLS_MIGRATION = "2026-05-01-dubspace-mounted-controls";
const LOCAL_CATALOG_ROOM_LOOK_SELF_MIGRATION = "2026-04-30-room-look-self";
const LOCAL_CATALOG_CHAT_THREE_ROOM_MIGRATION = "2026-05-01-chat-three-room-demo";
const LOCAL_CATALOG_CHAT_OBSERVATION_OUTPUT_MIGRATION = "2026-05-01-chat-observation-output";
const LOCAL_CATALOG_CHAT_ROOM_CONTENTS_REPAIR_MIGRATION = "2026-05-01-chat-room-contents-repair";
const LOCAL_CATALOG_AGENT_TOOL_EXPOSURE_REPAIR_MIGRATION = "2026-05-01-agent-tool-exposure-repair";
const LOCAL_CATALOG_CHAT_NAVIGATION_TOOL_EXPOSURE_MIGRATION = "2026-05-01-chat-navigation-tool-exposure";
const LOCAL_CATALOG_COCKATOO_TOOL_EXPOSURE_MIGRATION = "2026-05-01-cockatoo-tool-exposure";
const LOCAL_CATALOG_CHAT_NOWHERE_PORTABLES_REPAIR_MIGRATION = "2026-05-01-chat-nowhere-portables-repair";
const LOCAL_CATALOG_PINBOARD_LOOK_OBSERVATION_MIGRATION = "2026-05-01-pinboard-look-observation";
const LOCAL_CATALOG_PINBOARD_ACTIVITY_TEXT_MIGRATION = "2026-05-01-pinboard-activity-text";
const LOCAL_CATALOG_PINBOARD_VIEWPORT_PRESENCE_MIGRATION = "2026-05-01-pinboard-viewport-presence";
const LOCAL_CATALOG_PINBOARD_FREE_COORDS_MIGRATION = "2026-05-01-pinboard-free-coordinates";
const LOCAL_CATALOG_DUBSPACE_SOURCE_PRESENCE_MIGRATION = "2026-05-01-dubspace-source-presence";
const LOCAL_CATALOG_PINBOARD_SOURCE_PRESENCE_MIGRATION = "2026-05-01-pinboard-source-presence";
const LOCAL_CATALOG_PINBOARD_PINS_MODEL_MIGRATION = "2026-05-02-pinboard-pins-model";
const LOCAL_CATALOG_PINBOARD_NOTES_TO_PINS_MIGRATION = "2026-05-02-pinboard-notes-to-pins";
const LOCAL_CATALOG_PINBOARD_V02_REPAIR_MIGRATION = "2026-05-02-pinboard-v02-repair";
const LOCAL_CATALOG_PINBOARD_V02_DATA_REPAIR_MIGRATION = "2026-05-02-pinboard-v02-data-repair";
const LOCAL_CATALOG_CHAT_SOURCE_MOVEMENT_MIGRATION = "2026-05-01-chat-source-movement";
const LOCAL_CATALOG_CHAT_ROOM_EXIT_MODEL_MIGRATION = "2026-05-02-chat-room-exit-model";
const LOCAL_CATALOG_CHAT_EXIT_PRIVILEGE_REPAIR_MIGRATION = "2026-05-02-chat-exit-privilege-repair";
const LOCAL_CATALOG_CHAT_EXIT_ALIAS_REPAIR_MIGRATION = "2026-05-02-chat-exit-alias-repair";
const LOCAL_CATALOG_CHAT_STALE_CLASS_VERBS_REPAIR_MIGRATION = "2026-05-02-chat-stale-class-verbs-repair";
const LOCAL_CATALOG_CHAT_LOOK_SKIP_PRESENCE_MIGRATION = "2026-05-02-chat-look-skip-presence";
const LOCAL_CATALOG_CHAT_COMMAND_PLAN_SOURCE_REPAIR_MIGRATION = "2026-05-03-chat-command-plan-source-repair";
const LOCAL_CATALOG_CHAT_COMMAND_PLAN_SKIP_PRESENCE_MIGRATION = "2026-05-13-chat-command-plan-skip-presence";
const LOCAL_CATALOG_CHAT_ACTOR_HUH_SOURCE_REPAIR_MIGRATION = "2026-05-06-chat-actor-huh-source-repair";
const LOCAL_CATALOG_CHAT_LOOK_AT_COMMAND_REPAIR_MIGRATION = "2026-05-06-chat-look-at-command-repair";
const LOCAL_CATALOG_CHAT_LOOK_AT_TRY_MIGRATION = "2026-05-03-chat-look-at-collect-prop-try";
const LOCAL_CATALOG_PROG_EDITOR_ROOM_MIGRATION = "2026-05-02-prog-editor-room";
const LOCAL_CATALOG_PROG_EDITOR_NOWHERE_MIGRATION = "2026-05-02-prog-editor-nowhere";
const LOCAL_CATALOG_DEMO_SPACES_NO_AUTO_PRESENCE_MIGRATION = "2026-05-04-demo-spaces-no-auto-presence";
const LOCAL_CATALOG_DROP_SESSION_ID_PROPERTY_MIGRATION = "2026-05-04-drop-session-id-property";
const LOCAL_CATALOG_CHAT_TRANSPARENT_FEATURE_MIGRATION = "2026-05-04-chat-transparent-feature";
const LOCAL_CATALOG_DROP_PRESENCE_IN_PROPERTY_MIGRATION = "2026-05-04-drop-presence-in-property";
const LOCAL_CATALOG_CHAT_ROOM_EXITS_RESTORE_MIGRATION = "2026-05-04-chat-room-exits-restore";
const LOCAL_CATALOG_CHAT_ROOM_LEAVE_FILTER_MIGRATION = "2026-05-04-chat-room-leave-filter";
const LOCAL_CATALOG_NOTE_TEXT_STRING_SHAPE_MIGRATION = "2026-05-06-note-text-string-shape";
const LOCAL_CATALOG_NOTE_STALE_CLASS_VERBS_MIGRATION = "2026-05-06-note-stale-class-verbs";
const LOCAL_CATALOG_PINBOARD_STALE_CLASS_VERBS_MIGRATION = "2026-05-06-pinboard-stale-class-verbs";
const LOCAL_CATALOG_DISPENSER_STALE_CLASS_VERBS_MIGRATION = "2026-05-06-dispenser-stale-class-verbs";
const LOCAL_CATALOG_TASKS_TRANSPARENT_FEATURE_MIGRATION = "2026-05-08-tasks-transparent-feature";
// Re-reconcile note + dispenser class verbs after May-8 manifest changes that
// the May-6 stale-class-verbs migrations missed: $note:read got an arg_spec
// .command pattern (so `read <noun>` parses), and $dispensed_note gained a
// :moveto override that disperses the note when dropped into a $space.
const LOCAL_CATALOG_NOTE_READ_COMMAND_REPAIR_MIGRATION = "2026-05-09-note-read-command-repair";
const LOCAL_CATALOG_DISPENSED_NOTE_MOVETO_REPAIR_MIGRATION = "2026-05-09-dispensed-note-moveto-repair";
// LambdaCore inheritance: $wiz isa $programmer isa $builder isa $player. woo
// bootstrap creates $wiz with parent $player because $builder/$programmer
// live in the prog catalog. Once prog is installed, this migration anchors
// $wiz onto $programmer so command-shaped builder/programmer verbs
// (e.g. $builder:@recycle) resolve via normal parent-chain verb lookup.
const LOCAL_CATALOG_WIZ_PROGRAMMER_PARENT_MIGRATION = "2026-05-09-wiz-programmer-parent";
// $task_registry now tracks every minted $task in `_tracked_tasks` so
// `:listing` can find them after they've been claimed (and moved out of
// `contents(this)`). Existing registries have tasks in contents but an
// empty _tracked_tasks; backfill from contents — claimed tasks won't be
// recoverable via this path, but on a freshly-deployed worktree all
// existing tasks live at their registry.
const LOCAL_CATALOG_TASKS_TRACKED_BACKFILL_MIGRATION = "2026-05-09-tasks-tracked-backfill";
// $task_registry was originally rooted on $space; reparent onto $room so
// registries inherit the chat catalog's exits/match_exit/out/go machinery
// and a host catalog can wire a return exit (e.g. demoworld's `out` from
// the_taskboard back to the deck) without duplicating verbs. The schema
// sync's ensure_object step normally reparents on next install, but
// recording an explicit migration keeps the change auditable and runs
// before the sync-driven path.
const LOCAL_CATALOG_TASK_REGISTRY_ROOM_PARENT_MIGRATION = "2026-05-09-task-registry-room-parent";
// The v0.3 `taskspace` catalog was superseded by `tasks` (different
// classes, different seed name `the_taskboard`). Worlds installed before
// the rename still carry `the_taskspace`, its `$task` contents, the
// `$taskspace` class object, and a `@local:taskspace` registry record —
// none of which are produced or maintained by any current bundled
// catalog. The migration drops them unceremoniously: contents are
// recycled bottom-up so they don't leak into `$nowhere`, then the seed
// instance and class are recycled, then the registry record is stripped.
// Idempotent — gates on local presence at each step.
const LOCAL_CATALOG_TASKSPACE_DROP_MIGRATION = "2026-05-10-taskspace-drop";
const LOCAL_CATALOG_DUBSPACE_V2_CONTROL_PRESENCE_MIGRATION = "2026-05-13-dubspace-v2-control-presence";
const LOCAL_CATALOG_DUBSPACE_V2_CONTROL_AUTHORITY_MIGRATION = "2026-05-13-dubspace-v2-control-authority";
const LOCAL_CATALOG_CHAT_V2_COMMAND_PERSISTENCE_MIGRATION = "2026-05-13-chat-v2-command-persistence";
const LOCAL_CATALOG_CHAT_ROOM_ROSTER_MIGRATION = "2026-05-14-chat-room-roster";
const LOCAL_CATALOG_PINBOARD_ROOM_ROSTER_MIGRATION = "2026-05-14-pinboard-room-roster";
const LOCAL_CATALOG_DUBSPACE_ROOM_ROSTER_MIGRATION = "2026-05-14-dubspace-room-roster";
const LOCAL_CATALOG_REST_LIVE_PERSISTENCE_METADATA_MIGRATION = "2026-05-15-rest-live-persistence-metadata";
const LOCAL_CATALOG_ROSTER_PRESENTATION_RECONCILE_MIGRATION = "2026-05-15-roster-presentation-reconcile";
// Repair pass: deployed satellites recorded
// LOCAL_CATALOG_CHAT_V2_COMMAND_PERSISTENCE_MIGRATION as applied while the
// reconciler was still emitting the pre-rename `commit_policy` field, so the
// stored arg_spec.command map for $chatroom direction verbs ended up missing
// the `persistence: "durable"` hint the v2 plan reads. The browser then
// defaults the move to `live`, the commit never fires, and the H1 stays put.
// A new migration id forces one more reconcile against the current manifest.
const LOCAL_CATALOG_CHAT_V2_COMMAND_PERSISTENCE_RECONCILE_MIGRATION = "2026-05-14-chat-v2-command-persistence-reconcile";
const CATALOG_MIGRATION_RECORD_LIMIT = 200;

export const DEFAULT_LOCAL_CATALOGS = bundledCatalogAliases();

const LOCAL_CATALOG_MIGRATION_INDEX: Array<{ id: string; only?: string }> = [
  { id: LOCAL_CATALOG_SOURCE_MIGRATION },
  { id: LOCAL_CATALOG_PLACEMENT_MIGRATION },
  { id: LOCAL_CATALOG_CHAT_COCKATOO_MIGRATION },
  { id: LOCAL_CATALOG_CHAT_LOOK_CONTENTS_MIGRATION },
  { id: LOCAL_CATALOG_CHAT_COMMAND_PARSER_MIGRATION },
  { id: LOCAL_CATALOG_DUBSPACE_CONTROL_GUARDS_MIGRATION },
  { id: LOCAL_CATALOG_DUBSPACE_MOUNTED_CONTROLS_MIGRATION, only: "dubspace" },
  { id: LOCAL_CATALOG_ROOM_LOOK_SELF_MIGRATION },
  { id: LOCAL_CATALOG_CHAT_THREE_ROOM_MIGRATION },
  { id: LOCAL_CATALOG_CHAT_OBSERVATION_OUTPUT_MIGRATION },
  { id: LOCAL_CATALOG_CHAT_ROOM_CONTENTS_REPAIR_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_AGENT_TOOL_EXPOSURE_REPAIR_MIGRATION },
  { id: LOCAL_CATALOG_CHAT_NAVIGATION_TOOL_EXPOSURE_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_COCKATOO_TOOL_EXPOSURE_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_CHAT_NOWHERE_PORTABLES_REPAIR_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_PINBOARD_LOOK_OBSERVATION_MIGRATION, only: "pinboard" },
  { id: LOCAL_CATALOG_PINBOARD_ACTIVITY_TEXT_MIGRATION, only: "pinboard" },
  { id: LOCAL_CATALOG_PINBOARD_VIEWPORT_PRESENCE_MIGRATION, only: "pinboard" },
  { id: LOCAL_CATALOG_PINBOARD_FREE_COORDS_MIGRATION, only: "pinboard" },
  { id: LOCAL_CATALOG_DUBSPACE_SOURCE_PRESENCE_MIGRATION, only: "dubspace" },
  { id: LOCAL_CATALOG_PINBOARD_SOURCE_PRESENCE_MIGRATION, only: "pinboard" },
  { id: LOCAL_CATALOG_PINBOARD_PINS_MODEL_MIGRATION, only: "pinboard" },
  { id: LOCAL_CATALOG_PINBOARD_NOTES_TO_PINS_MIGRATION, only: "pinboard" },
  { id: LOCAL_CATALOG_PINBOARD_V02_REPAIR_MIGRATION, only: "pinboard" },
  { id: LOCAL_CATALOG_PINBOARD_V02_DATA_REPAIR_MIGRATION, only: "pinboard" },
  { id: LOCAL_CATALOG_CHAT_SOURCE_MOVEMENT_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_CHAT_ROOM_EXIT_MODEL_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_CHAT_EXIT_PRIVILEGE_REPAIR_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_CHAT_EXIT_ALIAS_REPAIR_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_CHAT_STALE_CLASS_VERBS_REPAIR_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_CHAT_LOOK_SKIP_PRESENCE_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_CHAT_COMMAND_PLAN_SOURCE_REPAIR_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_CHAT_COMMAND_PLAN_SKIP_PRESENCE_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_CHAT_ACTOR_HUH_SOURCE_REPAIR_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_CHAT_LOOK_AT_COMMAND_REPAIR_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_CHAT_LOOK_AT_TRY_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_PROG_EDITOR_ROOM_MIGRATION, only: "prog" },
  { id: LOCAL_CATALOG_PROG_EDITOR_NOWHERE_MIGRATION, only: "prog" },
  { id: LOCAL_CATALOG_DEMO_SPACES_NO_AUTO_PRESENCE_MIGRATION },
  { id: LOCAL_CATALOG_DROP_SESSION_ID_PROPERTY_MIGRATION },
  { id: LOCAL_CATALOG_CHAT_TRANSPARENT_FEATURE_MIGRATION },
  { id: LOCAL_CATALOG_DROP_PRESENCE_IN_PROPERTY_MIGRATION },
  { id: LOCAL_CATALOG_CHAT_ROOM_EXITS_RESTORE_MIGRATION },
  { id: LOCAL_CATALOG_CHAT_ROOM_LEAVE_FILTER_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_TASKS_TRANSPARENT_FEATURE_MIGRATION, only: "tasks" },
  { id: LOCAL_CATALOG_NOTE_TEXT_STRING_SHAPE_MIGRATION, only: "note" },
  { id: LOCAL_CATALOG_NOTE_STALE_CLASS_VERBS_MIGRATION, only: "note" },
  { id: LOCAL_CATALOG_PINBOARD_STALE_CLASS_VERBS_MIGRATION, only: "pinboard" },
  { id: LOCAL_CATALOG_DISPENSER_STALE_CLASS_VERBS_MIGRATION, only: "dispenser" },
  { id: LOCAL_CATALOG_NOTE_READ_COMMAND_REPAIR_MIGRATION, only: "note" },
  { id: LOCAL_CATALOG_DISPENSED_NOTE_MOVETO_REPAIR_MIGRATION, only: "dispenser" },
  { id: LOCAL_CATALOG_WIZ_PROGRAMMER_PARENT_MIGRATION, only: "prog" },
  { id: LOCAL_CATALOG_TASKS_TRACKED_BACKFILL_MIGRATION, only: "tasks" },
  { id: LOCAL_CATALOG_TASK_REGISTRY_ROOM_PARENT_MIGRATION, only: "tasks" },
  { id: LOCAL_CATALOG_DUBSPACE_V2_CONTROL_PRESENCE_MIGRATION, only: "dubspace" },
  { id: LOCAL_CATALOG_DUBSPACE_V2_CONTROL_AUTHORITY_MIGRATION, only: "dubspace" },
  { id: LOCAL_CATALOG_CHAT_V2_COMMAND_PERSISTENCE_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_CHAT_ROOM_ROSTER_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_PINBOARD_ROOM_ROSTER_MIGRATION, only: "pinboard" },
  { id: LOCAL_CATALOG_DUBSPACE_ROOM_ROSTER_MIGRATION, only: "dubspace" },
  { id: LOCAL_CATALOG_REST_LIVE_PERSISTENCE_METADATA_MIGRATION },
  { id: LOCAL_CATALOG_ROSTER_PRESENTATION_RECONCILE_MIGRATION },
  { id: LOCAL_CATALOG_CHAT_V2_COMMAND_PERSISTENCE_RECONCILE_MIGRATION, only: "chat" }
];

export function bundledCatalogAliases(): string[] {
  return sortCatalogNames(Array.from(LOCAL_CATALOGS.keys()));
}

export function parseAutoInstallCatalogs(value: string | undefined): string[] {
  if (value === undefined) return bundledCatalogAliases();
  if (value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function installLocalCatalogs(world: WooWorld, names: readonly string[] = DEFAULT_LOCAL_CATALOGS): void {
  const requested = sortCatalogNames(names);
  const cleanInstalled = new Set<string>();
  for (const name of requested) {
    if (installLocalCatalog(world, name)) cleanInstalled.add(name);
  }

  // Existing worlds still need repair even when WOO_AUTO_INSTALL_CATALOGS is
  // intentionally empty. Missing dependencies of already-installed local
  // catalogs are compatibility repair, not fresh auto-install policy.
  const repairNames = localMigrationCatalogNames(world, requested);
  installMissingLocalCatalogDependencies(world, repairNames);
  // Apply bundled catalog-version migrations BEFORE the schema sync.
  // The schema sync only reconciles forward (ensure_object / ensure_property_def
  // / ensure_verb) — it doesn't drop stale verbs or properties from a
  // previous major. Without this step, an existing world keeps the old
  // surface (e.g. v0 forecast_hours) but flips its registry to the new
  // version, which is the worst of both worlds.
  runLocalCatalogVersionMigrations(world, repairNames);
  const covered = runLocalCatalogMigrations(world, repairNames, cleanInstalled);
  runAutoDetectedLocalCatalogSchemaSync(world, repairNames, covered);
}

export function installLocalCatalog(world: WooWorld, name: string, options: { adoptExisting?: boolean } = {}): boolean {
  if (!isLocalCatalogName(name)) throw new Error(`unknown local catalog: ${name}`);
  // Boot auto-install is part of deterministic world construction, not a user
  // catalog operation. Runtime installs still go through $catalog_registry.
  if (localCatalogInstalled(world, name)) return false;
  const manifest = LOCAL_CATALOGS.get(name)!;
  const provenance: Record<string, WooValue> = {
    tap: "@local",
    catalog: name,
    alias: name,
    ref_requested: "@local",
    ref_resolved_sha: "unversioned"
  };
  // Auto-adopt: if any of this catalog's declared classes/features/seeds
  // already exist in the world (typical when a previously-installed catalog
  // has been split — e.g. chat → chat + demoworld — and the new catalog now
  // claims objects that the old one originally seeded), install in adoption
  // mode rather than failing E_NAME_COLLISION. Idempotent on fresh worlds
  // because no targets exist yet. After a successful adoption, the adopted
  // ids are pruned from other catalogs' registry records so each object has
  // exactly one owner. (Migration-declarative drop_seed/drop_class step
  // kinds are deferred — see LATER.md.)
  const adoptExisting = options.adoptExisting === true || hasPreexistingManifestObjects(world, manifest);
  installCatalogManifest(world, manifest, { tap: "@local", alias: name, actor: "$wiz", provenance, adoptExisting });
  if (adoptExisting) pruneAdoptedIdsFromOtherRecords(world, name, manifest);
  return !adoptExisting;
}

function hasPreexistingManifestObjects(world: WooWorld, manifest: CatalogManifest): boolean {
  for (const def of [...(manifest.classes ?? []), ...(manifest.features ?? [])]) {
    if (world.objects.has(def.local_name)) return true;
  }
  for (const hook of manifest.seed_hooks ?? []) {
    if (hook.kind === "create_instance" && world.objects.has(hook.as)) return true;
  }
  return false;
}

function pruneAdoptedIdsFromOtherRecords(world: WooWorld, currentName: string, manifest: CatalogManifest): void {
  if (!world.objects.has("$catalog_registry")) return;
  const raw = world.propOrNull("$catalog_registry", "installed_catalogs");
  if (!Array.isArray(raw)) return;
  const adoptedIds = new Set<string>();
  for (const def of [...(manifest.classes ?? []), ...(manifest.features ?? [])]) {
    adoptedIds.add(def.local_name);
  }
  for (const hook of manifest.seed_hooks ?? []) {
    if (hook.kind === "create_instance") adoptedIds.add(hook.as);
  }
  if (adoptedIds.size === 0) return;
  let mutated = false;
  const next = raw.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return record;
    const item = record as Record<string, WooValue>;
    if (item.alias === currentName) return record;
    const objects = mapValue(item.objects);
    const seeds = mapValue(item.seeds);
    let changed = false;
    const nextObjects: Record<string, WooValue> = {};
    for (const [name, id] of Object.entries(objects)) {
      if (typeof id === "string" && adoptedIds.has(id)) { changed = true; continue; }
      nextObjects[name] = id;
    }
    const nextSeeds: Record<string, WooValue> = {};
    for (const [name, id] of Object.entries(seeds)) {
      if (typeof id === "string" && adoptedIds.has(id)) { changed = true; continue; }
      nextSeeds[name] = id;
    }
    if (!changed) return record;
    mutated = true;
    return { ...item, objects: nextObjects as WooValue, seeds: nextSeeds as WooValue } as WooValue;
  });
  if (mutated) world.setProp("$catalog_registry", "installed_catalogs", next as WooValue);
}

export function localCatalogStatuses(world: WooWorld, names: readonly string[] = DEFAULT_LOCAL_CATALOGS): LocalCatalogStatus[] {
  return sortCatalogNames(names).map((name) => {
    if (!isLocalCatalogName(name)) throw new Error(`unknown local catalog: ${name}`);
    const manifest = LOCAL_CATALOGS.get(name)!;
    const base = catalogManifestStatus(world, manifest, {
      tap: "@local",
      alias: name,
      actor: "$wiz",
      allowImplementationHints: true
    });
    const migrations = LOCAL_CATALOG_MIGRATION_INDEX
      .filter((migration) => !migration.only || migration.only === name)
      .map((migration) => ({ id: migration.id, applied: migrationApplied(world, migration.id) }));
    const plan = planCatalogSchemaMigration(world, manifest, {
      actor: "$wiz",
      allowImplementationHints: true,
      reconcileSeedHooks: true,
      scope: "gateway",
      host: "world"
    });
    migrations.push({
      id: plan.id,
      applied: catalogMigrationRecordCompleted(world, plan.id, "gateway", "world") && !catalogSchemaStatusNeedsSync(base)
    });
    return {
      ...base,
      local: true,
      migrations,
      pending_migrations: migrations.filter((migration) => !migration.applied).map((migration) => migration.id)
    };
  });
}

export function localCatalogUiIndex(world: WooWorld): { catalogs: WooValue[] } {
  if (!world.objects.has("$catalog_registry")) return { catalogs: [] };
  const raw = world.propOrNull("$catalog_registry", "installed_catalogs");
  if (!Array.isArray(raw)) return { catalogs: [] };
  const catalogs: WooValue[] = [];
  for (const record of raw) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const item = record as Record<string, WooValue>;
    // Phase 1 exposes only bundled/local UI manifests. Remote taps need a
    // signed module URL and integrity policy before they can appear here.
    if (item.tap !== "@local" || typeof item.catalog !== "string") continue;
    const manifest = LOCAL_CATALOGS.get(item.catalog);
    const ui = (manifest as (CatalogManifest & { ui?: WooValue }) | undefined)?.ui;
    if (!manifest || !ui) continue;
    catalogs.push({
      alias: typeof item.alias === "string" ? item.alias : item.catalog,
      catalog: item.catalog,
      version: typeof item.version === "string" ? item.version : manifest.version,
      objects: item.objects && typeof item.objects === "object" && !Array.isArray(item.objects) ? item.objects : {},
      seeds: item.seeds && typeof item.seeds === "object" && !Array.isArray(item.seeds) ? item.seeds : {},
      ui
    });
  }
  return { catalogs };
}

export function runHostScopedLocalCatalogLifecycle(world: WooWorld, host = "host", options: { freshSeed?: boolean } = {}): void {
  runHostScopedSchemaPlans(world, host, options.freshSeed === true);
  runHostScopedDataMigrations(world, host);
}

function runLocalCatalogMigrations(world: WooWorld, names: readonly string[], cleanInstalled: ReadonlySet<string>): Set<string> {
  const covered = new Set<string>();
  const run = (id: string, options: { allowImplementationHints?: boolean; reconcileSeedHooks?: boolean; rehomeNowhereSeedObjects?: boolean; reconcileClassVerbs?: boolean; only?: string } = {}) => {
    for (const name of runLocalCatalogMigration(world, names, cleanInstalled, id, options)) covered.add(name);
  };

  run(LOCAL_CATALOG_SOURCE_MIGRATION);
  run(LOCAL_CATALOG_PLACEMENT_MIGRATION);
  run(LOCAL_CATALOG_CHAT_COCKATOO_MIGRATION);
  run(LOCAL_CATALOG_CHAT_LOOK_CONTENTS_MIGRATION);
  run(LOCAL_CATALOG_CHAT_COMMAND_PARSER_MIGRATION, { allowImplementationHints: true });
  run(LOCAL_CATALOG_DUBSPACE_CONTROL_GUARDS_MIGRATION, { allowImplementationHints: true });
  run(LOCAL_CATALOG_DUBSPACE_MOUNTED_CONTROLS_MIGRATION, { allowImplementationHints: true, reconcileSeedHooks: true, only: "dubspace" });
  run(LOCAL_CATALOG_ROOM_LOOK_SELF_MIGRATION, { allowImplementationHints: true });
  run(LOCAL_CATALOG_CHAT_THREE_ROOM_MIGRATION, { allowImplementationHints: true });
  run(LOCAL_CATALOG_CHAT_OBSERVATION_OUTPUT_MIGRATION, { allowImplementationHints: true });
  run(LOCAL_CATALOG_CHAT_ROOM_CONTENTS_REPAIR_MIGRATION, { allowImplementationHints: true, reconcileSeedHooks: true, only: "demoworld" });
  run(LOCAL_CATALOG_AGENT_TOOL_EXPOSURE_REPAIR_MIGRATION, { allowImplementationHints: true });
  run(LOCAL_CATALOG_CHAT_NAVIGATION_TOOL_EXPOSURE_MIGRATION, { allowImplementationHints: true, only: "chat" });
  run(LOCAL_CATALOG_COCKATOO_TOOL_EXPOSURE_MIGRATION, { allowImplementationHints: true, only: "demoworld" });
  run(LOCAL_CATALOG_CHAT_NOWHERE_PORTABLES_REPAIR_MIGRATION, { allowImplementationHints: true, reconcileSeedHooks: true, rehomeNowhereSeedObjects: true, only: "demoworld" });
  run(LOCAL_CATALOG_PINBOARD_LOOK_OBSERVATION_MIGRATION, { allowImplementationHints: true, only: "pinboard" });
  run(LOCAL_CATALOG_PINBOARD_ACTIVITY_TEXT_MIGRATION, { allowImplementationHints: true, only: "pinboard" });
  run(LOCAL_CATALOG_PINBOARD_VIEWPORT_PRESENCE_MIGRATION, { allowImplementationHints: true, only: "pinboard" });
  run(LOCAL_CATALOG_PINBOARD_FREE_COORDS_MIGRATION, { allowImplementationHints: true, only: "pinboard" });
  run(LOCAL_CATALOG_DUBSPACE_SOURCE_PRESENCE_MIGRATION, { allowImplementationHints: true, only: "dubspace" });
  run(LOCAL_CATALOG_PINBOARD_SOURCE_PRESENCE_MIGRATION, { allowImplementationHints: true, only: "pinboard" });
  run(LOCAL_CATALOG_PINBOARD_PINS_MODEL_MIGRATION, { allowImplementationHints: true, reconcileSeedHooks: true, only: "pinboard" });
  runPinboardNotesToPinsMigration(world, names, LOCAL_CATALOG_PINBOARD_NOTES_TO_PINS_MIGRATION);
  runPinboardV02RepairMigration(world, names);
  runPinboardNotesToPinsMigration(world, names, LOCAL_CATALOG_PINBOARD_V02_DATA_REPAIR_MIGRATION);
  run(LOCAL_CATALOG_CHAT_SOURCE_MOVEMENT_MIGRATION, { allowImplementationHints: true, only: "chat" });
  run(LOCAL_CATALOG_CHAT_ROOM_EXIT_MODEL_MIGRATION, { allowImplementationHints: true, reconcileSeedHooks: true, only: "demoworld" });
  run(LOCAL_CATALOG_CHAT_EXIT_PRIVILEGE_REPAIR_MIGRATION, { allowImplementationHints: true, only: "demoworld" });
  run(LOCAL_CATALOG_CHAT_EXIT_ALIAS_REPAIR_MIGRATION, { allowImplementationHints: true, reconcileSeedHooks: true, only: "demoworld" });
  run(LOCAL_CATALOG_CHAT_STALE_CLASS_VERBS_REPAIR_MIGRATION, { allowImplementationHints: true, reconcileClassVerbs: true, only: "chat" });
  runChatLookSkipPresenceMigration(world, names);
  run(LOCAL_CATALOG_CHAT_COMMAND_PLAN_SOURCE_REPAIR_MIGRATION, { allowImplementationHints: true, only: "chat" });
  runChatCommandPlanSkipPresenceMigration(world, names);
  run(LOCAL_CATALOG_CHAT_ACTOR_HUH_SOURCE_REPAIR_MIGRATION, { allowImplementationHints: true, only: "chat" });
  run(LOCAL_CATALOG_CHAT_LOOK_AT_COMMAND_REPAIR_MIGRATION, { allowImplementationHints: true, only: "chat" });
  run(LOCAL_CATALOG_CHAT_LOOK_AT_TRY_MIGRATION, { allowImplementationHints: true, only: "chat" });
  run(LOCAL_CATALOG_PROG_EDITOR_ROOM_MIGRATION, { reconcileSeedHooks: true, only: "prog" });
  run(LOCAL_CATALOG_PROG_EDITOR_NOWHERE_MIGRATION, { reconcileSeedHooks: true, only: "prog" });
  runDemoSpacesNoAutoPresenceMigration(world);
  runDropSessionIdPropertyMigration(world);
  runChatTransparentFeatureMigration(world, names);
  runDropPresenceInPropertyMigration(world);
  runChatRoomExitsRestoreMigration(world);
  runChatRoomLeaveFilterMigration(world, names);
  runNoteTextStringShapeMigration(world, names);
  run(LOCAL_CATALOG_NOTE_STALE_CLASS_VERBS_MIGRATION, { allowImplementationHints: true, reconcileClassVerbs: true, only: "note" });
  run(LOCAL_CATALOG_PINBOARD_STALE_CLASS_VERBS_MIGRATION, { allowImplementationHints: true, reconcileClassVerbs: true, only: "pinboard" });
  run(LOCAL_CATALOG_DISPENSER_STALE_CLASS_VERBS_MIGRATION, { allowImplementationHints: true, reconcileClassVerbs: true, only: "dispenser" });
  runTasksTransparentFeatureMigration(world, names);
  run(LOCAL_CATALOG_NOTE_READ_COMMAND_REPAIR_MIGRATION, { allowImplementationHints: true, reconcileClassVerbs: true, only: "note" });
  run(LOCAL_CATALOG_DISPENSED_NOTE_MOVETO_REPAIR_MIGRATION, { allowImplementationHints: true, reconcileClassVerbs: true, only: "dispenser" });
  runWizProgrammerParentMigration(world, names);
  runTasksTrackedBackfillMigration(world, names);
  runTaskRegistryRoomParentMigration(world, names);
  runTaskspaceCatalogDropMigration(world);
  runDubspaceV2ControlPresenceMigration(world, names);
  run(LOCAL_CATALOG_DUBSPACE_V2_CONTROL_AUTHORITY_MIGRATION, { allowImplementationHints: true, reconcileClassVerbs: true, only: "dubspace" });
  run(LOCAL_CATALOG_CHAT_V2_COMMAND_PERSISTENCE_MIGRATION, { allowImplementationHints: true, reconcileClassVerbs: true, only: "chat" });
  run(LOCAL_CATALOG_CHAT_ROOM_ROSTER_MIGRATION, { allowImplementationHints: true, reconcileClassVerbs: true, only: "chat" });
  run(LOCAL_CATALOG_PINBOARD_ROOM_ROSTER_MIGRATION, { allowImplementationHints: true, reconcileClassVerbs: true, only: "pinboard" });
  run(LOCAL_CATALOG_DUBSPACE_ROOM_ROSTER_MIGRATION, { allowImplementationHints: true, reconcileClassVerbs: true, only: "dubspace" });
  run(LOCAL_CATALOG_REST_LIVE_PERSISTENCE_METADATA_MIGRATION, { allowImplementationHints: true, reconcileClassVerbs: true });
  run(LOCAL_CATALOG_ROSTER_PRESENTATION_RECONCILE_MIGRATION, { allowImplementationHints: true, reconcileClassVerbs: true });
  run(LOCAL_CATALOG_CHAT_V2_COMMAND_PERSISTENCE_RECONCILE_MIGRATION, { allowImplementationHints: true, reconcileClassVerbs: true, only: "chat" });
  return covered;
}

function localMigrationCatalogNames(world: WooWorld, requested: readonly string[]): string[] {
  // sortCatalogNames walks `depends` transitively and includes every dep in
  // the result, even deps that weren't in the input — so the returned list is
  // always topologically complete relative to the bundled manifest.
  const selected = new Set(requested);
  for (const name of installedLocalCatalogNames(world)) selected.add(name);
  return sortCatalogNames(Array.from(selected));
}

function installMissingLocalCatalogDependencies(world: WooWorld, names: readonly string[]): void {
  for (const name of names) {
    // Compatibility repair for worlds that already contain a bundled catalog's
    // objects but lost or predate its registry record. Runtime/user installs
    // still reject object collisions; only local boot dependency repair adopts.
    if (!localCatalogInstalled(world, name)) installLocalCatalog(world, name, { adoptExisting: true });
  }
}

function hostScopedLocalCatalogNames(world: WooWorld): string[] {
  const selected = new Set<string>();
  const hostedDataIds = new Set(
    world.objectRoutes()
      .filter((route) => route.host === route.id || (route.anchor !== null && route.host === route.anchor))
      .map((route) => route.id)
  );
  for (const name of LOCAL_CATALOGS.keys()) {
    if (localCatalogPresentInWorldSlice(world, name, hostedDataIds)) selected.add(name);
  }
  return sortCatalogNames(Array.from(selected));
}

function localCatalogPresentInWorldSlice(world: WooWorld, name: string, hostedDataIds: Set<ObjRef>): boolean {
  const manifest = LOCAL_CATALOGS.get(name);
  if (!manifest) return false;
  for (const hook of manifest.seed_hooks ?? []) {
    if (hook.kind === "create_instance" && hostedDataIds.has(hook.as)) return true;
  }
  for (const id of hostedDataIds) {
    if (!world.objects.has(id)) continue;
    for (const def of [...(manifest.classes ?? []), ...(manifest.features ?? [])]) {
      try {
        if (world.isDescendantOf(id, def.local_name)) return true;
      } catch {
        // Support ancestors can be temporarily absent in an old host slice.
      }
    }
  }
  return false;
}

function runHostScopedSchemaPlans(world: WooWorld, host: string, freshSeed: boolean): void {
  const startedAt = Date.now();
  let planned = 0;
  let skipped = 0;
  for (const name of hostScopedLocalCatalogNames(world)) {
    const manifest = LOCAL_CATALOGS.get(name);
    if (!manifest) continue;
    if (freshSeed) {
      recordCoveredHostCatalogSchemaPlan(world, host, manifest);
      continue;
    }
    // Verify even when this manifest's previous plan completed. A host slice
    // can retain stale catalog metadata after a gateway repair, and the plan
    // id alone cannot prove the local slice is still in sync.
    //
    // reconcileClassVerbs walks every class verb on this slice against the
    // bundled manifest's arg_spec / source / aliases / flags and writes only
    // when storage drifts. Without it, a verb metadata change that landed on
    // the gateway after this satellite's last bootstrap-style migration ID
    // (e.g. an arg_spec.command.persistence hint added by a chat-v2 manifest
    // bump) was unreachable: the satellite's own bootstrap migration list
    // does not run on cold-load (only the gateway runs that), and the
    // host-seed merge alone could miss it when the gateway's seed cache had
    // been built before the gateway's reconcile (addVerb does not bump
    // mutationCounter, so the hostSeedCache stayed valid). Reconciling on
    // every cold-load is idempotent — empty diff means no writes — and is
    // the substrate's self-heal for stale satellite verb shapes.
    const result = runLocalCatalogSchemaPlan(world, name, manifest, "host", host, {
      allowImplementationHints: true,
      reconcileSeedHooks: true,
      reconcileClassVerbs: true,
      skipMissingSeedHooks: true
    });
    if (result.status === "failed") {
      console.warn("woo.local_catalog_host_schema_plan_failed", { catalog: name, host, plan_id: result.plan_id, error: result.error ?? null, issues: result.issues });
    } else if (result.steps.every((step) => step.status === "skipped")) {
      skipped += 1;
    } else {
      planned += 1;
    }
  }
  if (planned > 0 || skipped > 0) {
    world.recordMetric({ kind: "host_schema_sync", host, planned, skipped, ms: Date.now() - startedAt });
  }
}

function recordCoveredHostCatalogSchemaPlan(world: WooWorld, host: string, manifest: CatalogManifest): void {
  const plan = planCatalogSchemaMigration(world, manifest, {
    actor: "$wiz",
    allowImplementationHints: true,
    reconcileSeedHooks: true,
    skipMissingSeedHooks: true,
    scope: "host",
    host
  });
  if (catalogMigrationRecordCompleted(world, plan.id, "host", host)) return;
  const now = Date.now();
  recordCatalogMigrationResult(world, {
    status: "completed",
    plan_id: plan.id,
    catalog: plan.catalog,
    version: plan.version,
    manifest_hash: plan.manifest_hash,
    scope: "host",
    host,
    started_at: now,
    completed_at: now,
    steps: plan.steps.map((step) => ({ id: step.id, kind: step.kind, target: stepTarget(step), status: "skipped" })),
    issues: []
  }, []);
}

function runLocalCatalogMigration(
  world: WooWorld,
  names: readonly string[],
  cleanInstalled: ReadonlySet<string>,
  id: string,
  options: { allowImplementationHints?: boolean; reconcileSeedHooks?: boolean; rehomeNowhereSeedObjects?: boolean; reconcileClassVerbs?: boolean; only?: string } = {}
): Set<string> {
  const covered = new Set<string>();
  if (migrationApplied(world, id)) return covered;
  let repaired = false;
  for (const name of names) {
    if (options.only && name !== options.only) continue;
    if (!localCatalogInstalled(world, name)) continue;
    if (cleanInstalled.has(name)) {
      repaired = true;
      covered.add(name);
      continue;
    }
    const result = runLocalCatalogSchemaPlan(world, name, LOCAL_CATALOGS.get(name)!, "gateway", "world", {
      allowImplementationHints: options.allowImplementationHints,
      reconcileSeedHooks: options.reconcileSeedHooks,
      rehomeNowhereSeedObjects: options.rehomeNowhereSeedObjects,
      reconcileClassVerbs: options.reconcileClassVerbs
    });
    if (result.status === "failed") throw new Error(`local catalog schema plan failed: ${result.plan_id}`);
    repaired = true;
    covered.add(name);
  }
  if (repaired || !options.only) markMigrationApplied(world, id);
  return covered;
}

function runPinboardV02RepairMigration(world: WooWorld, names: readonly string[]): void {
  if (!names.includes("pinboard")) return;
  if (!localCatalogInstalled(world, "pinboard")) return;
  if (migrationApplied(world, LOCAL_CATALOG_PINBOARD_V02_REPAIR_MIGRATION)) return;
  // The plan references $note as $pin's parent. Without that ancestor in
  // place, planning cannot prove the postcondition — defer until a later boot
  // installs note.
  if (!world.objects.has("$note")) return;
  const listNotes = world.objects.has("$pinboard") ? world.ownVerbExact("$pinboard", "list_notes") : null;
  const needsRepair =
    !world.objects.has("$pin") ||
    !listNotes ||
    !listNotes.source.includes("contents(this)") ||
    !world.ownVerbExact("$pinboard", "add_note")?.source.includes("create($pin");

  if (needsRepair) {
    const result = runLocalCatalogSchemaPlan(world, "pinboard", LOCAL_CATALOGS.get("pinboard")!, "gateway", "world", {
      allowImplementationHints: true,
      reconcileSeedHooks: true,
      reconcileClassVerbs: true
    });
    if (result.status === "failed") throw new Error(`local catalog schema plan failed: ${result.plan_id}`);
  }
  markMigrationApplied(world, LOCAL_CATALOG_PINBOARD_V02_REPAIR_MIGRATION);
}

function runDropSessionIdPropertyMigration(world: WooWorld): void {
  if (migrationApplied(world, LOCAL_CATALOG_DROP_SESSION_ID_PROPERTY_MIGRATION)) return;
  // session_id was a $player property used as a write-only mirror of the
  // session table. Removed from the seed; this clears the def from $player
  // and any own values left on descendants in upgraded worlds. deleteProp
  // tracks the deletion through the persistence layer so storage rows go
  // too — not just the in-memory copy.
  for (const id of Array.from(world.objects.keys())) {
    const obj = world.object(id);
    if (obj.propertyDefs.has("session_id") || obj.properties.has("session_id") || obj.propertyVersions.has("session_id")) {
      world.deleteProp(id, "session_id");
    }
  }
  markMigrationApplied(world, LOCAL_CATALOG_DROP_SESSION_ID_PROPERTY_MIGRATION);
}

function runWizProgrammerParentMigration(world: WooWorld, names: readonly string[]): void {
  if (migrationApplied(world, LOCAL_CATALOG_WIZ_PROGRAMMER_PARENT_MIGRATION)) return;
  // Only act when prog is in the migration scope (avoids reaching into $wiz's
  // ancestry on hosts that haven't taken the prog catalog yet).
  if (!names.includes("prog")) return;
  if (!world.objects.has("$wiz") || !world.objects.has("$programmer")) {
    markMigrationApplied(world, LOCAL_CATALOG_WIZ_PROGRAMMER_PARENT_MIGRATION);
    return;
  }
  if (world.isDescendantOf("$wiz", "$programmer")) {
    markMigrationApplied(world, LOCAL_CATALOG_WIZ_PROGRAMMER_PARENT_MIGRATION);
    return;
  }
  // chparentAuthoredObject runs the same gates as a wizard would: $wiz owns
  // $wiz, $wiz can author its own parent change, and the cycle check confirms
  // $programmer doesn't already inherit from $wiz. The reparent is the whole
  // migration — descendants of $wiz pick up $programmer's verbs through the
  // ordinary inheritance chain.
  world.chparentAuthoredObject("$wiz", "$wiz", "$programmer");
  markMigrationApplied(world, LOCAL_CATALOG_WIZ_PROGRAMMER_PARENT_MIGRATION);
}

// Reparent the $task_registry CLASS from $space onto $room so registries
// pick up the chat catalog's exits map, :match_exit, :go, :out, and the
// directional verbs through normal inheritance. Existing instances
// (e.g. the_taskboard) follow because they delegate to the class.
// Idempotent: noops when the chain already reaches $room, when the
// expected ancestors are missing, or when the tasks catalog isn't in
// scope.
function runTaskRegistryRoomParentMigration(world: WooWorld, names: readonly string[]): void {
  if (migrationApplied(world, LOCAL_CATALOG_TASK_REGISTRY_ROOM_PARENT_MIGRATION)) return;
  if (!names.includes("tasks") || !localCatalogInstalled(world, "tasks")) {
    markMigrationApplied(world, LOCAL_CATALOG_TASK_REGISTRY_ROOM_PARENT_MIGRATION);
    return;
  }
  if (!world.objects.has("$task_registry") || !world.objects.has("$room")) {
    markMigrationApplied(world, LOCAL_CATALOG_TASK_REGISTRY_ROOM_PARENT_MIGRATION);
    return;
  }
  if (world.object("$task_registry").parent === "$room") {
    markMigrationApplied(world, LOCAL_CATALOG_TASK_REGISTRY_ROOM_PARENT_MIGRATION);
    return;
  }
  // Cycle-guard: $room must not already inherit from $task_registry. The
  // bundled hierarchy makes this impossible, but the check matches the
  // ensure_object reparent path's defensive contract.
  if (world.isDescendantOf("$room", "$task_registry")) {
    markMigrationApplied(world, LOCAL_CATALOG_TASK_REGISTRY_ROOM_PARENT_MIGRATION);
    return;
  }
  // chparentAuthoredObject runs the same gates as a wizard would: $wiz
  // owns $task_registry (the catalog installer authors classes as $wiz),
  // so $wiz can author the parent change.
  world.chparentAuthoredObject("$wiz", "$task_registry", "$room");
  markMigrationApplied(world, LOCAL_CATALOG_TASK_REGISTRY_ROOM_PARENT_MIGRATION);
}

// Backfill `_tracked_tasks` on every $task_registry instance from the
// tasks currently present in `contents(this)`. Without this, registries
// installed before the property existed would have an empty list, and
// `:listing` (which now iterates _tracked_tasks instead of contents)
// would return nothing — including for tasks still sitting at the
// registry. Idempotent: only writes when the existing list is missing or
// empty.
// Pure walk: for every $task_registry instance, populate `_tracked_tasks`
// by walking the $task instances on this slice whose `registry` ref points
// at it, merged with whatever is already there. A non-empty existing list
// is NOT a fast-path to skip — earlier partial repairs ran a contents-only
// backfill (ready tasks at the registry, but not tasks that were claimed
// and moved onto an actor), so a worktree with a non-empty list might still
// be missing in-flight tasks. The walk is naturally idempotent: once every
// $task with registry == this is in the list, subsequent passes find no
// new refs and short-circuit before writing.
// Self-hosted taskboards (host_placement: "self") need this on the OWNING
// host slice, not the gateway, because the data lives there.
function backfillTaskRegistryTrackedTasks(world: WooWorld): void {
  if (!world.objects.has("$task_registry") || !world.objects.has("$task")) return;
  for (const id of Array.from(world.objects.keys())) {
    if (id === "$task_registry") continue;
    if (!world.isDescendantOf(id, "$task_registry")) continue;
    const existing = world.propOrNull(id, "_tracked_tasks");
    const existingList: ObjRef[] = Array.isArray(existing)
      ? existing.filter((x): x is ObjRef => typeof x === "string")
      : [];
    const merged = new Set<ObjRef>(existingList);
    const before = merged.size;
    for (const child of Array.from(world.objects.keys())) {
      if (!world.isDescendantOf(child, "$task")) continue;
      if (child === "$task") continue;
      const registry = world.propOrNull(child, "registry");
      if (registry !== id) continue;
      merged.add(child as ObjRef);
    }
    if (merged.size === before) continue;
    world.setProp(id, "_tracked_tasks", Array.from(merged) as WooValue);
  }
}

// Gateway-side migration entry. Host-scoped slices call
// backfillTaskRegistryTrackedTasks directly via runHostScopedDataMigrations
// because their data isn't visible from the gateway when the registry is
// host_placement: "self".
function runTasksTrackedBackfillMigration(world: WooWorld, names: readonly string[]): void {
  if (migrationApplied(world, LOCAL_CATALOG_TASKS_TRACKED_BACKFILL_MIGRATION)) return;
  if (!names.includes("tasks") || !localCatalogInstalled(world, "tasks")) {
    markMigrationApplied(world, LOCAL_CATALOG_TASKS_TRACKED_BACKFILL_MIGRATION);
    return;
  }
  backfillTaskRegistryTrackedTasks(world);
  markMigrationApplied(world, LOCAL_CATALOG_TASKS_TRACKED_BACKFILL_MIGRATION);
}

// Properties the v0.3 taskspace catalog defined on its `$task` class
// that the new tasks catalog does NOT redefine. Catalog schema sync
// adopts the existing `$task` class and updates verbs/properties from
// the new manifest, but it does not drop entries the new manifest
// omits — so without explicit cleanup an upgraded world's `$task` ends
// up with a hybrid surface: new fields like `kind`/`obligations` next
// to `parent_task`/`subtasks`/`status` from v0.3.
const LEGACY_TASK_PROPERTY_NAMES: readonly string[] = [
  "parent_task",
  "subtasks",
  "status",
  "assignee",
  "requirements",
  "artifacts",
  "messages",
  "space"
];

// v0.3-only verbs on `$task`. `claim` and `release` exist in both
// versions and are replaced in-place by schema sync (so they stay).
// The new catalog has no `move`, `set_status`, `add_*`, or
// `check_requirement` analog; those are pure carry-over.
const LEGACY_TASK_VERB_NAMES: readonly string[] = [
  "add_subtask",
  "move",
  "set_status",
  "add_requirement",
  "check_requirement",
  "add_message",
  "add_artifact"
];

// Drop the v0.3 `taskspace` superseded catalog wherever it still
// shows up in a deployed world: the `the_taskspace` seed instance and
// its `$task` contents (the old shape; new tasks live at
// `the_taskboard`), the `$taskspace` class object, the
// `@local:taskspace` registry record, and the legacy property defs /
// own values / class verbs that schema sync left on the adopted
// `$task` class. Each step gates on local presence so reruns are
// no-ops; the function runs both gateway-side (where the registry
// record lives and the_taskspace has a stub) and host-scoped (where
// the_taskspace's own DO holds the actual contents) and each host's
// `$system.applied_migrations` ledger tracks the run independently.
function runTaskspaceCatalogDropMigration(world: WooWorld): void {
  if (migrationApplied(world, LOCAL_CATALOG_TASKSPACE_DROP_MIGRATION)) return;

  // Presence check: a world that never installed the v0.3 taskspace
  // catalog has no `the_taskspace`, no `$taskspace` class, no
  // `@local:taskspace` registry record, and no v0.3-shape leftover
  // on `$task`. Skip without touching the ledger so the host-scoped
  // no-op invariant (a core-only slice exports unchanged through
  // runHostScopedLocalCatalogLifecycle) holds.
  const hasInstance = world.objects.has("the_taskspace");
  const hasClass = world.objects.has("$taskspace");
  const registryRaw = world.objects.has("$catalog_registry")
    ? world.propOrNull("$catalog_registry", "installed_catalogs")
    : null;
  const hasRegistryRecord = Array.isArray(registryRaw) && registryRaw.some((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    const item = record as Record<string, WooValue>;
    return item.tap === "@local" && (item.alias === "taskspace" || item.catalog === "taskspace");
  });
  const hasLegacyTaskShape = world.objects.has("$task") && hasAnyLegacyTaskSurface(world);
  if (!hasInstance && !hasClass && !hasRegistryRecord && !hasLegacyTaskShape) return;

  // 1. Recycle `the_taskspace` contents bottom-up so they leave the
  //    world entirely. recycleObjectLocal displaces remaining contents
  //    to $nowhere on each call, so without the bottom-up walk the
  //    inner tasks would be orphaned rather than removed.
  const collectContents = (root: ObjRef, into: Set<ObjRef>): void => {
    for (const id of Array.from(world.objects.keys())) {
      if (id === root || into.has(id)) continue;
      const obj = world.objects.get(id);
      if (!obj || obj.location !== root) continue;
      collectContents(id, into);
      into.add(id);
    }
  };
  if (hasInstance) {
    const inside = new Set<ObjRef>();
    collectContents("the_taskspace", inside);
    for (const id of inside) world.migrationRecycleObject(id);
    world.migrationRecycleObject("the_taskspace");
  }

  // 2. Recycle every remaining `$taskspace` descendant (instances live
  //    at the_taskspace shape; collect by ancestry to catch any extras
  //    a hand-edited world may have created), then the class itself.
  if (hasClass) {
    const instances: ObjRef[] = [];
    for (const id of Array.from(world.objects.keys())) {
      if (id === "$taskspace") continue;
      try {
        if (world.isDescendantOf(id, "$taskspace")) instances.push(id);
      } catch {
        // Tolerate dangling parent refs — a missing rung in the chain
        // means this isn't a $taskspace descendant for our purposes.
      }
    }
    for (const id of instances) world.migrationRecycleObject(id);
    world.migrationRecycleObject("$taskspace");
  }

  // 3. Strip `@local:taskspace` from $catalog_registry.installed_catalogs
  //    so status/UI machinery stops surfacing the dead catalog.
  if (hasRegistryRecord && Array.isArray(registryRaw)) {
    const next = registryRaw.filter((record) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) return true;
      const item = record as Record<string, WooValue>;
      if (item.tap !== "@local") return true;
      return item.alias !== "taskspace" && item.catalog !== "taskspace";
    });
    if (next.length !== registryRaw.length) {
      world.setProp("$catalog_registry", "installed_catalogs", next as WooValue);
    }
  }

  // 4. Drop the v0.3 property defs / own values / class verbs that
  //    schema sync left on the adopted `$task` class. Strictly scoped
  //    to `$task` and its descendants — the legacy names (`status`,
  //    `assignee`, `messages`, `space`, …) are common enough that any
  //    user object outside the `$task` chain may legitimately carry
  //    one, and we mustn't touch unrelated data. The class-level
  //    `propertyDefs` entry lives on `$task` itself; instance own
  //    values live on `$task` descendants; anything else is none of
  //    this migration's business.
  if (world.objects.has("$task")) {
    const taskScope: ObjRef[] = ["$task"];
    for (const id of Array.from(world.objects.keys())) {
      if (id === "$task") continue;
      try {
        if (world.isDescendantOf(id, "$task")) taskScope.push(id);
      } catch {
        // Tolerate dangling parent refs — not a $task descendant.
      }
    }
    for (const id of taskScope) {
      const obj = world.object(id);
      for (const name of LEGACY_TASK_PROPERTY_NAMES) {
        if (obj.propertyDefs.has(name) || obj.properties.has(name) || obj.propertyVersions.has(name)) {
          world.deleteProp(id, name);
        }
      }
      // Instance-level own verbs are vanishingly rare on `$task`, but
      // a wizard could have stamped one. Sweep the same scope so a
      // re-run starting from a hand-edited world ends coherent.
      for (const name of LEGACY_TASK_VERB_NAMES) world.removeVerb(id, name);
    }
  }

  markMigrationApplied(world, LOCAL_CATALOG_TASKSPACE_DROP_MIGRATION);
}

function hasAnyLegacyTaskSurface(world: WooWorld): boolean {
  if (!world.objects.has("$task")) return false;
  const taskClass = world.object("$task");
  for (const name of LEGACY_TASK_PROPERTY_NAMES) {
    if (taskClass.propertyDefs.has(name)) return true;
  }
  for (const verb of taskClass.verbs) {
    if (LEGACY_TASK_VERB_NAMES.includes(verb.name)) return true;
  }
  return false;
}

function runDropPresenceInPropertyMigration(world: WooWorld): void {
  if (migrationApplied(world, LOCAL_CATALOG_DROP_PRESENCE_IN_PROPERTY_MIGRATION)) return;
  for (const id of Array.from(world.objects.keys())) {
    const obj = world.object(id);
    if (obj.propertyDefs.has("presence_in") || obj.properties.has("presence_in") || obj.propertyVersions.has("presence_in")) {
      world.deleteProp(id, "presence_in");
    }
  }
  markMigrationApplied(world, LOCAL_CATALOG_DROP_PRESENCE_IN_PROPERTY_MIGRATION);
}

function runChatRoomExitsRestoreMigration(world: WooWorld): void {
  if (migrationApplied(world, LOCAL_CATALOG_CHAT_ROOM_EXITS_RESTORE_MIGRATION)) return;
  if (!world.objects.has("$exit") || !world.objects.has("$room")) {
    markMigrationApplied(world, LOCAL_CATALOG_CHAT_ROOM_EXITS_RESTORE_MIGRATION);
    return;
  }
  // For each $exit instance, register itself under (source room, name) so we
  // can rebuild source rooms' exits maps from the exits' own metadata.
  const desired = new Map<ObjRef, Map<string, ObjRef>>();
  for (const id of Array.from(world.objects.keys())) {
    if (!world.isDescendantOf(id, "$exit")) continue;
    const source = world.propOrNull(id, "source");
    const name = world.propOrNull(id, "name");
    if (typeof source !== "string" || typeof name !== "string") continue;
    if (!world.objects.has(source as ObjRef)) continue;
    const sourceMap = desired.get(source as ObjRef) ?? new Map<string, ObjRef>();
    sourceMap.set(name, id);
    desired.set(source as ObjRef, sourceMap);
  }
  const isValidExit = (target: unknown): target is ObjRef =>
    typeof target === "string" && world.objects.has(target as ObjRef) && world.isDescendantOf(target as ObjRef, "$exit");
  for (const id of Array.from(world.objects.keys())) {
    if (!world.isDescendantOf(id, "$room")) continue;
    const current = world.propOrNull(id, "exits");
    const start: Record<string, unknown> = current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
    const expected = desired.get(id);
    let changed = false;
    if (expected) {
      for (const [direction, target] of expected.entries()) {
        if (start[direction] !== target) {
          start[direction] = target;
          changed = true;
        }
      }
    }
    for (const direction of Object.keys(start)) {
      if (!isValidExit(start[direction])) {
        delete start[direction];
        changed = true;
      }
    }
    if (changed) world.setProp(id, "exits", start as WooValue);
  }
  markMigrationApplied(world, LOCAL_CATALOG_CHAT_ROOM_EXITS_RESTORE_MIGRATION);
}

function runChatRoomLeaveFilterMigration(world: WooWorld, names: readonly string[]): void {
  if (!names.includes("chat")) return;
  if (!localCatalogInstalled(world, "chat")) return;
  if (migrationApplied(world, LOCAL_CATALOG_CHAT_ROOM_LEAVE_FILTER_MIGRATION)) return;
  const leave = world.objects.has("$room") ? world.ownVerbExact("$room", "leave") : null;
  if (!leave || !leave.source.includes("for s in this.subscribers")) {
    const result = runLocalCatalogSchemaPlan(world, "chat", LOCAL_CATALOGS.get("chat")!, "gateway", "world", {
      allowImplementationHints: true
    });
    if (result.status === "failed") throw new Error(`local catalog schema plan failed: ${result.plan_id}`);
  }
  markMigrationApplied(world, LOCAL_CATALOG_CHAT_ROOM_LEAVE_FILTER_MIGRATION);
}

function runChatTransparentFeatureMigration(world: WooWorld, names: readonly string[]): void {
  if (migrationApplied(world, LOCAL_CATALOG_CHAT_TRANSPARENT_FEATURE_MIGRATION)) return;
  const transparentConsumers = transparentFeatureConsumers();
  if (chatTransparentFeaturePostcondition(world, names, transparentConsumers)) {
    markMigrationApplied(world, LOCAL_CATALOG_CHAT_TRANSPARENT_FEATURE_MIGRATION);
    return;
  }
  if (names.includes("chat") && localCatalogInstalled(world, "chat")) {
    const result = runLocalCatalogSchemaPlan(world, "chat", LOCAL_CATALOGS.get("chat")!, "gateway", "world", {
      allowImplementationHints: true,
      reconcileClassVerbs: true
    });
    if (result.status === "failed") throw new Error(`local catalog schema plan failed: ${result.plan_id}`);
  }
  for (const name of ["dubspace", "pinboard", "tasks"]) {
    if (!names.includes(name) || !localCatalogInstalled(world, name)) continue;
    const result = runLocalCatalogSchemaPlan(world, name, LOCAL_CATALOGS.get(name)!, "gateway", "world", {
      allowImplementationHints: true,
      reconcileSeedHooks: true,
      reconcileClassVerbs: true
    });
    if (result.status === "failed") throw new Error(`local catalog schema plan failed: ${result.plan_id}`);
  }
  for (const consumer of transparentConsumers) {
    if (!world.objects.has(consumer) || !world.objects.has("$transparent")) continue;
    const raw = world.propOrNull(consumer, "features");
    const features = Array.isArray(raw) ? raw.filter((item): item is ObjRef => typeof item === "string") : [];
    const next = ["$transparent", ...features.filter((item) => item !== "$transparent" && item !== "$conversational")];
    if (features.length === next.length && features.every((item, index) => item === next[index])) continue;
    world.setProp(consumer, "features", next);
    world.setProp(consumer, "features_version", Number(world.propOrNull(consumer, "features_version") ?? 0) + 1);
  }
  markMigrationApplied(world, LOCAL_CATALOG_CHAT_TRANSPARENT_FEATURE_MIGRATION);
}

function transparentFeatureConsumers(): ObjRef[] {
  const out: ObjRef[] = [];
  for (const name of ["dubspace", "pinboard", "tasks"]) {
    const manifest = LOCAL_CATALOGS.get(name);
    for (const hook of manifest?.seed_hooks ?? []) {
      if (hook.kind === "attach_feature" && hook.feature === "chat:$transparent" && typeof hook.consumer === "string") {
        out.push(hook.consumer as ObjRef);
      }
    }
  }
  return out;
}

function chatTransparentFeaturePostcondition(world: WooWorld, names: readonly string[], transparentConsumers: readonly ObjRef[]): boolean {
  if (names.includes("chat") && localCatalogInstalled(world, "chat")) {
    if (!world.objects.has("$transparent") || !world.objects.has("$semitransparent")) return false;
    const announce = world.objects.has("$room") ? world.ownVerbExact("$room", "announce_all_but") : null;
    if (!announce?.source.includes("hear_parent_announce")) return false;
  }
  for (const name of ["dubspace", "pinboard", "tasks"]) {
    if (!names.includes(name) || !localCatalogInstalled(world, name)) continue;
    const manifest = LOCAL_CATALOGS.get(name);
    for (const def of manifest?.classes ?? []) {
      if (def.parent === "$space" && world.objects.has(def.local_name) && world.object(def.local_name).parent !== "$space") return false;
    }
  }
  for (const consumer of transparentConsumers) {
    if (!world.objects.has(consumer)) continue;
    const raw = world.propOrNull(consumer, "features");
    const features = Array.isArray(raw) ? raw.filter((item): item is ObjRef => typeof item === "string") : [];
    if (features[0] !== "$transparent" || features.includes("$conversational")) return false;
  }
  return true;
}

// Worlds bootstrapped before the_taskboard had its $transparent attach_feature
// hook will have the older `2026-05-04-chat-transparent-feature` migration
// already marked applied. That migration only considered dubspace and pinboard
// consumers, so `the_taskboard.features` is left empty and the post-merge
// schema-plan reconciler reports feature_drift on every boot. Run a focused
// re-attach for just the tasks consumer; idempotent and safe to re-run.
function runTasksTransparentFeatureMigration(world: WooWorld, names: readonly string[]): void {
  if (migrationApplied(world, LOCAL_CATALOG_TASKS_TRANSPARENT_FEATURE_MIGRATION)) return;
  if (!names.includes("tasks") || !localCatalogInstalled(world, "tasks")) {
    markMigrationApplied(world, LOCAL_CATALOG_TASKS_TRANSPARENT_FEATURE_MIGRATION);
    return;
  }
  if (!world.objects.has("$transparent")) return;
  const manifest = LOCAL_CATALOGS.get("tasks");
  for (const hook of manifest?.seed_hooks ?? []) {
    if (hook.kind !== "attach_feature" || hook.feature !== "chat:$transparent") continue;
    const consumer = typeof hook.consumer === "string" ? (hook.consumer as ObjRef) : null;
    if (!consumer || !world.objects.has(consumer)) continue;
    const raw = world.propOrNull(consumer, "features");
    const features = Array.isArray(raw) ? raw.filter((item): item is ObjRef => typeof item === "string") : [];
    const next = ["$transparent", ...features.filter((item) => item !== "$transparent" && item !== "$conversational")];
    if (features.length === next.length && features.every((item, i) => item === next[i])) continue;
    world.setProp(consumer, "features", next);
    world.setProp(consumer, "features_version", Number(world.propOrNull(consumer, "features_version") ?? 0) + 1);
  }
  markMigrationApplied(world, LOCAL_CATALOG_TASKS_TRANSPARENT_FEATURE_MIGRATION);
}

function runDemoSpacesNoAutoPresenceMigration(world: WooWorld): void {
  if (migrationApplied(world, LOCAL_CATALOG_DEMO_SPACES_NO_AUTO_PRESENCE_MIGRATION)) return;
  for (const id of Array.from(world.objects.keys())) {
    if (!world.isDescendantOf(id, "$space")) continue;
    if (world.propOrNull(id, "auto_presence") !== true) continue;
    world.setProp(id, "auto_presence", false);
    const subscribers = world.propOrNull(id, "subscribers");
    if (Array.isArray(subscribers) && subscribers.length > 0) world.setProp(id, "subscribers", []);
  }
  markMigrationApplied(world, LOCAL_CATALOG_DEMO_SPACES_NO_AUTO_PRESENCE_MIGRATION);
}

function runChatLookSkipPresenceMigration(world: WooWorld, names: readonly string[]): void {
  if (!names.includes("chat")) return;
  if (!localCatalogInstalled(world, "chat")) return;
  if (migrationApplied(world, LOCAL_CATALOG_CHAT_LOOK_SKIP_PRESENCE_MIGRATION)) return;
  const look = world.objects.has("$conversational") ? world.ownVerbExact("$conversational", "look") : null;
  if (look && look.skip_presence_check !== true) {
    world.addVerb("$conversational", { ...look, skip_presence_check: true, version: look.version + 1 });
  }
  markMigrationApplied(world, LOCAL_CATALOG_CHAT_LOOK_SKIP_PRESENCE_MIGRATION);
}

function runChatCommandPlanSkipPresenceMigration(world: WooWorld, names: readonly string[]): void {
  if (!names.includes("chat")) return;
  if (!localCatalogInstalled(world, "chat")) return;
  if (migrationApplied(world, LOCAL_CATALOG_CHAT_COMMAND_PLAN_SKIP_PRESENCE_MIGRATION)) return;
  const commandPlan = world.objects.has("$conversational") ? world.ownVerbExact("$conversational", "command_plan") : null;
  if (commandPlan && commandPlan.skip_presence_check !== true) {
    // Browser v2 can ask a space to parse text before durable/live presence has
    // been reconciled into that scope. Planning is read-only and authority is
    // enforced on the planned target verb, so it should not consume presence.
    world.addVerb("$conversational", { ...commandPlan, skip_presence_check: true, version: commandPlan.version + 1 });
  }
  markMigrationApplied(world, LOCAL_CATALOG_CHAT_COMMAND_PLAN_SKIP_PRESENCE_MIGRATION);
}

function runDubspaceV2ControlPresenceMigration(world: WooWorld, names: readonly string[]): void {
  if (!names.includes("dubspace")) return;
  if (!localCatalogInstalled(world, "dubspace")) return;
  if (migrationApplied(world, LOCAL_CATALOG_DUBSPACE_V2_CONTROL_PRESENCE_MIGRATION)) return;
  // Browser v2 treats Dubspace enter/leave as direct live presence, while
  // committed control writes go through the Dubspace commit scope. Existing
  // worlds therefore need these durable control verbs repaired so the old
  // room-presence gate does not reject commit-scope turns before recording.
  const controls = [
    "set_control",
    "start_loop",
    "stop_loop",
    "set_drum_step",
    "set_tempo",
    "start_transport",
    "stop_transport",
    "save_scene",
    "recall_scene"
  ];
  if (world.objects.has("$dubspace")) {
    for (const name of controls) {
      const verb = world.ownVerbExact("$dubspace", name);
      if (!verb || verb.skip_presence_check === true) continue;
      world.addVerb("$dubspace", { ...verb, skip_presence_check: true, version: verb.version + 1 });
    }
  }
  markMigrationApplied(world, LOCAL_CATALOG_DUBSPACE_V2_CONTROL_PRESENCE_MIGRATION);
}


// v0.1 of $note declared `text: list<str>`. v0.2 retypes the same property
// to `text: str` (markdown). Walk every $note descendant on whichever host
// holds it and join any list value with \n. Idempotent: skip when the value
// is already a string. Safe to call from both gateway and host slices —
// each only sees the objects it owns.
function migrateNoteTextStringShapeData(world: WooWorld): void {
  if (!world.objects.has("$note")) return;
  for (const id of world.objects.keys()) {
    if (!world.isDescendantOf(id, "$note")) continue;
    const own = world.object(id).properties;
    if (!own.has("text")) continue;
    const value = own.get("text");
    if (typeof value === "string") continue;
    if (Array.isArray(value)) {
      const joined = value
        .map((line) => (typeof line === "string" ? line : String(line ?? "")))
        .join("\n");
      world.setProp(id, "text", joined);
      continue;
    }
    if (value === null || value === undefined) {
      world.setProp(id, "text", "");
    }
  }
}

function runNoteTextStringShapeMigration(world: WooWorld, names: readonly string[]): void {
  // Gateway path. Runs the data walk so any $note descendants the gateway
  // owns get converted, then marks the gateway-scope ledger entry. Host
  // slices run their own walk via runHostScopedDataMigrations.
  if (!names.includes("note")) return;
  if (!localCatalogInstalled(world, "note")) return;
  if (migrationApplied(world, LOCAL_CATALOG_NOTE_TEXT_STRING_SHAPE_MIGRATION)) return;
  if (!world.objects.has("$note")) return;
  migrateNoteTextStringShapeData(world);
  markMigrationApplied(world, LOCAL_CATALOG_NOTE_TEXT_STRING_SHAPE_MIGRATION);
}


// Apply bundled catalog migrations whose version range matches the
// drift between an installed local catalog and its current bundled
// manifest. We hand off to updateCatalogManifest with acceptMajor: true
// so the migration's drop_property / drop_verb / etc. steps run, and
// the catalog registry record is updated to the new version atomically
// with the cleanup. Idempotent: when there's no drift, no migration is
// found, or the matching one was already applied, this is a no-op.
function runLocalCatalogVersionMigrations(world: WooWorld, names: readonly string[]): void {
  for (const name of names) {
    if (!localCatalogInstalled(world, name)) continue;
    const manifest = LOCAL_CATALOGS.get(name);
    const migrations = LOCAL_CATALOG_MIGRATIONS.get(name) ?? [];
    if (!manifest || migrations.length === 0) continue;
    const currentVersion = installedLocalCatalogVersion(world, name);
    if (!currentVersion || currentVersion === manifest.version) continue;
    if (!isVersionLessThan(currentVersion, manifest.version)) continue;
    const migration = pickMatchingMigration(migrations, currentVersion, manifest.version);
    if (!migration) continue;
    try {
      updateCatalogManifest(world, manifest, {
        tap: "@local",
        alias: name,
        actor: "$wiz",
        allowImplementationHints: true,
        acceptMajor: true,
        migration
      });
    } catch (err) {
      console.warn("woo.local_catalog_version_migration_failed", { catalog: name, from: currentVersion, to: manifest.version, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function installedLocalCatalogVersion(world: WooWorld, name: string): string | null {
  if (!world.objects.has("$catalog_registry")) return null;
  const raw = world.propOrNull("$catalog_registry", "installed_catalogs");
  if (!Array.isArray(raw)) return null;
  for (const record of raw) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const item = record as Record<string, WooValue>;
    if (item.tap !== "@local") continue;
    if (item.alias !== name && item.catalog !== name) continue;
    return typeof item.version === "string" ? item.version : null;
  }
  return null;
}

function pickMatchingMigration(
  migrations: readonly CatalogMigrationManifest[],
  fromVersion: string,
  toVersion: string
): CatalogMigrationManifest | null {
  // Pick the migration whose declared range covers (fromVersion ->
  // toVersion). Patterns may use "x" as a wildcard (e.g. "0.x.x"); the
  // catalog-installer's validateCatalogMigration enforces the exact
  // semantics, so we replicate the wildcard match here.
  for (const migration of migrations) {
    if (versionPatternMatches(migration.from_version, fromVersion) && versionPatternMatches(migration.to_version, toVersion)) {
      return migration;
    }
  }
  return null;
}

function versionPatternMatches(pattern: string, version: string): boolean {
  const patternParts = pattern.split(".");
  const versionParts = version.split(/[+-]/)[0].split(".");
  if (patternParts.length !== 3 || versionParts.length !== 3) return pattern === version;
  return patternParts.every((part, index) => part === "x" || part === versionParts[index]);
}

function isVersionLessThan(a: string, b: string): boolean {
  const partsA = a.split(/[+-]/)[0].split(".").map((n) => Number(n) || 0);
  const partsB = b.split(/[+-]/)[0].split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const x = partsA[i] ?? 0;
    const y = partsB[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

function runAutoDetectedLocalCatalogSchemaSync(world: WooWorld, names: readonly string[], covered: ReadonlySet<string>): void {
  for (const name of names) {
    if (!localCatalogInstalled(world, name)) continue;
    const manifest = LOCAL_CATALOGS.get(name)!;
    if (covered.has(name)) {
      const status = catalogManifestStatus(world, manifest, {
        tap: "@local",
        alias: name,
        actor: "$wiz",
        allowImplementationHints: true
      });
      if (!catalogSchemaStatusNeedsSync(status)) {
        recordCoveredLocalCatalogSchemaPlan(world, name, manifest);
        continue;
      }
    }
    const result = runLocalCatalogSchemaPlan(world, name, manifest, "gateway", "world", {
      allowImplementationHints: true,
      reconcileSeedHooks: true
    });
    if (result.status === "completed") markMigrationApplied(world, result.plan_id);
    else console.warn("woo.local_catalog_schema_plan_failed", { catalog: name, plan_id: result.plan_id, error: result.error ?? null, issues: result.issues });
  }
}

function recordCoveredLocalCatalogSchemaPlan(world: WooWorld, name: string, manifest: CatalogManifest): void {
  const plan = planCatalogSchemaMigration(world, manifest, {
    actor: "$wiz",
    allowImplementationHints: true,
    reconcileSeedHooks: true,
    scope: "gateway",
    host: "world"
  });
  if (!catalogMigrationRecordCompleted(world, plan.id, "gateway", "world")) {
    const now = Date.now();
    recordCatalogMigrationResult(world, {
      status: "completed",
      plan_id: plan.id,
      catalog: plan.catalog,
      version: plan.version,
      manifest_hash: plan.manifest_hash,
      scope: "gateway",
      host: "world",
      started_at: now,
      completed_at: now,
      steps: plan.steps.map((step) => ({ id: step.id, kind: step.kind, target: stepTarget(step), status: "skipped" })),
      issues: []
    }, []);
  }
  markMigrationApplied(world, plan.id);
  recordLocalCatalogSchemaSync(world, name, plan.id, plan.manifest_hash, manifest);
}

function catalogSchemaStatusNeedsSync(status: CatalogManifestStatus): boolean {
  return status.issues.some((issue) => issue.kind !== "not_installed" && issue.kind !== "version_mismatch");
}

function runLocalCatalogSchemaPlan(
  world: WooWorld,
  name: string,
  manifest: CatalogManifest,
  scope: CatalogSchemaPlanScope,
  host: string,
  options: {
    allowImplementationHints?: boolean;
    reconcileSeedHooks?: boolean;
    skipMissingSeedHooks?: boolean;
    rehomeNowhereSeedObjects?: boolean;
    reconcileClassVerbs?: boolean;
  } = {}
): CatalogSchemaPlanApplyResult {
  const plan = planCatalogSchemaMigration(world, manifest, {
    actor: "$wiz",
    ...options,
    scope,
    host
  });
  const preIssues = verifyCatalogSchemaPlan(world, manifest, plan);
  if (preIssues.length === 0) {
    const result: CatalogSchemaPlanApplyResult = {
      status: "completed",
      plan_id: plan.id,
      catalog: plan.catalog,
      version: plan.version,
      manifest_hash: plan.manifest_hash,
      scope,
      host,
      started_at: Date.now(),
      completed_at: Date.now(),
      steps: plan.steps.map((step) => ({ id: step.id, kind: step.kind, target: stepTarget(step), status: "skipped" })),
      issues: []
    };
    if (catalogMigrationRecordCompleted(world, plan.id, scope, host)) {
      return result;
    }
    if (scope === "host") {
      recordCatalogMigrationResult(world, result, preIssues);
      return result;
    }
  }
  const result = applyCatalogSchemaPlan(world, manifest, plan, {
    actor: "$wiz",
    ...options,
    scope,
    host
  });
  recordCatalogMigrationResult(world, result, preIssues);
  if (result.status === "completed" && scope === "gateway") recordLocalCatalogSchemaSync(world, name, result.plan_id, result.manifest_hash, manifest);
  return result;
}

function recordLocalCatalogSchemaSync(world: WooWorld, name: string, id: string, manifestHash: string, manifest: CatalogManifest): void {
  if (!world.objects.has("$catalog_registry")) return;
  const raw = world.propOrNull("$catalog_registry", "installed_catalogs");
  if (!Array.isArray(raw)) return;
  let changed = false;
  const next = raw.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return record;
    const item = record as Record<string, WooValue>;
    if (item.tap !== "@local") return record;
    if (item.alias !== name && item.catalog !== name) return record;
    const provenance = item.provenance && typeof item.provenance === "object" && !Array.isArray(item.provenance)
      ? { ...(item.provenance as Record<string, WooValue>) }
      : {};
    const objects = { ...mapValue(item.objects), ...manifestObjectRefs(manifest) };
    const seeds = { ...mapValue(item.seeds), ...manifestSeedRefs(manifest) };
    const nextProvenance = {
      ...provenance,
      local_schema_sync: id,
      local_manifest_hash: manifestHash
    };
    if (
      item.version === manifest.version &&
      valuesEqual((item.objects ?? {}) as WooValue, objects as WooValue) &&
      valuesEqual((item.seeds ?? {}) as WooValue, seeds as WooValue) &&
      valuesEqual((item.provenance ?? {}) as WooValue, nextProvenance as WooValue)
    ) return record;
    changed = true;
    return {
      ...item,
      version: manifest.version,
      updated_at: Date.now(),
      objects,
      seeds,
      provenance: nextProvenance
    } as WooValue;
  });
  if (!changed) return;
  world.setProp("$catalog_registry", "installed_catalogs", next as WooValue);
}

function stepTarget(step: { kind: string } & Record<string, unknown>): string {
  if (typeof step.object === "string") {
    if (step.kind === "ensure_property_def" && step.property && typeof step.property === "object" && "name" in step.property) return `${step.object}.${String(step.property.name)}`;
    if (step.kind === "ensure_verb" && step.verb && typeof step.verb === "object" && "name" in step.verb) return `${step.object}:${String(step.verb.name)}`;
    return step.object;
  }
  if (typeof step.consumer === "string" && typeof step.feature === "string") return `${step.consumer}+${step.feature}`;
  return step.kind;
}

function catalogMigrationRecordCompleted(world: WooWorld, planId: string, scope: CatalogSchemaPlanScope, host: string): boolean {
  return catalogMigrationRecords(world).some((record) =>
    record.plan_id === planId &&
    record.scope === scope &&
    record.host === host &&
    record.status === "completed"
  );
}

function localCatalogManifestHashForRecord(world: WooWorld, name: string, scope: CatalogSchemaPlanScope, host: string): string {
  const manifest = LOCAL_CATALOGS.get(name);
  if (!manifest) return "";
  return planCatalogSchemaMigration(world, manifest, {
    actor: "$wiz",
    allowImplementationHints: true,
    reconcileSeedHooks: true,
    skipMissingSeedHooks: scope === "host",
    scope,
    host
  }).manifest_hash;
}

function recordCatalogMigrationResult(world: WooWorld, result: CatalogSchemaPlanApplyResult, preIssues: CatalogSchemaPlanApplyResult["issues"]): void {
  if (!world.objects.has("$system")) return;
  const record: Record<string, WooValue> = {
    plan_id: result.plan_id,
    catalog: result.catalog,
    version: result.version,
    manifest_hash: result.manifest_hash,
    scope: result.scope,
    host: result.host,
    status: result.status,
    started_at: result.started_at,
    completed_at: result.completed_at,
    steps: result.steps as unknown as WooValue,
    pre_issues: preIssues as unknown as WooValue,
    post_issues: result.issues as unknown as WooValue
  };
  if (result.error) record.error = result.error as unknown as WooValue;
  const records = catalogMigrationRecords(world);
  const next = [
    ...records.filter((item) => !(item.plan_id === result.plan_id && item.scope === result.scope && item.host === result.host && item.status === "completed")),
    record
  ].slice(-CATALOG_MIGRATION_RECORD_LIMIT);
  world.setProp("$system", "catalog_migration_records", next as WooValue);
}

function recordCatalogDataMigrationResult(world: WooWorld, result: Record<string, WooValue>): void {
  if (!world.objects.has("$system")) return;
  const records = catalogMigrationRecords(world);
  const next = [
    ...records.filter((item) => !(item.plan_id === result.plan_id && item.scope === result.scope && item.host === result.host && item.status === "completed")),
    result
  ].slice(-CATALOG_MIGRATION_RECORD_LIMIT);
  world.setProp("$system", "catalog_migration_records", next as WooValue);
}

function catalogMigrationRecords(world: WooWorld): Array<Record<string, WooValue>> {
  if (!world.objects.has("$system")) return [];
  const raw = world.propOrNull("$system", "catalog_migration_records");
  return Array.isArray(raw)
    ? raw.filter((item): item is Record<string, WooValue> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function manifestObjectRefs(manifest: CatalogManifest): Record<string, WooValue> {
  const refs: Record<string, WooValue> = {};
  for (const def of [...(manifest.classes ?? []), ...(manifest.features ?? [])]) refs[def.local_name] = def.local_name;
  return refs;
}

function manifestSeedRefs(manifest: CatalogManifest): Record<string, WooValue> {
  const refs: Record<string, WooValue> = {};
  for (const hook of manifest.seed_hooks ?? []) {
    if (hook.kind === "create_instance") refs[hook.as] = hook.as;
  }
  return refs;
}

function isLocalCatalogName(name: string): name is LocalCatalogName {
  return LOCAL_CATALOGS.has(name);
}

function sortCatalogNames(names: readonly string[]): string[] {
  const selected = new Set(names);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: string[] = [];

  const visit = (name: string) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`local catalog dependency cycle at ${name}`);
    const manifest = LOCAL_CATALOGS.get(name);
    if (!manifest) throw new Error(`unknown local catalog: ${name}`);
    visiting.add(name);
    for (const dependency of manifest.depends ?? []) {
      const dependencyName = localDependencyName(dependency);
      if (LOCAL_CATALOGS.has(dependencyName)) visit(dependencyName);
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(name);
  };

  for (const name of names) visit(name);
  return sorted;
}

function localDependencyName(dependency: string): string {
  return dependency.startsWith("@local:") ? dependency.slice("@local:".length) : dependency;
}

function localCatalogInstalled(world: WooWorld, name: string): boolean {
  if (!world.objects.has("$catalog_registry")) return false;
  const raw = world.propOrNull("$catalog_registry", "installed_catalogs");
  return Array.isArray(raw) && raw.some((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false;
    const item = record as Record<string, WooValue>;
    return item.alias === name || item.catalog === name;
  });
}

function installedLocalCatalogNames(world: WooWorld): string[] {
  if (!world.objects.has("$catalog_registry")) return [];
  const raw = world.propOrNull("$catalog_registry", "installed_catalogs");
  if (!Array.isArray(raw)) return [];
  const names = new Set<string>();
  for (const record of raw) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const item = record as Record<string, WooValue>;
    if (item.tap !== "@local") continue;
    if (typeof item.catalog === "string" && LOCAL_CATALOGS.has(item.catalog)) names.add(item.catalog);
    if (typeof item.alias === "string" && LOCAL_CATALOGS.has(item.alias)) names.add(item.alias);
  }
  return Array.from(names);
}

function migrationApplied(world: WooWorld, id: string): boolean {
  if (!world.objects.has("$system")) return false;
  const raw = world.propOrNull("$system", "applied_migrations");
  return Array.isArray(raw) && raw.includes(id);
}

function markMigrationApplied(world: WooWorld, id: string): void {
  if (!world.objects.has("$system")) return;
  const raw = world.propOrNull("$system", "applied_migrations");
  const migrations = Array.isArray(raw) ? raw.map(String) : [];
  if (!migrations.includes(id)) world.setProp("$system", "applied_migrations", [...migrations, id]);
}

/**
 * Idempotent data-only migrations that must run wherever the relevant
 * instance data lives. Self-hosted seeds (host_placement:"self", e.g.
 * the_pinboard) live in their own DO; the gateway's copy is the post-install
 * stub with empty/default properties. Migrations driven by the gateway-only
 * migration framework therefore see no data to migrate. Each host's cold
 * init must call this so data sitting on the owning host gets converted.
 *
 * Idempotency: each step gates on local class existence and uses
 * hasEquivalentMigratedPin (or equivalent) to avoid duplicate work, so calling
 * on every cold init is safe and cheap when there's nothing to do.
 */
export function runHostScopedDataMigrations(world: WooWorld, host = "host"): void {
  if (world.objects.has("$pin") && world.objects.has("$pinboard")) {
    runPinboardNotesToPinsDataPlan(world, LOCAL_CATALOG_PINBOARD_NOTES_TO_PINS_MIGRATION, "host", host);
  }
  // $note descendants (dispensed notes, pins, tasks) often live on
  // self-hosted slices. Walk text: list<str> → str here so the host's
  // own copies get converted; gateway runs the same walk for objects it
  // owns. Both paths gate on value shape and skip when there's nothing
  // to do.
  migrateNoteTextStringShapeData(world);
  // Repair horoscope-note instances orphaned when $horoscope_note was
  // recycled. Per-host walk; idempotent.
  migrateHoroscopeNoteParentOrphans(world);
  // Backfill `_tracked_tasks` on host-owned $task_registry instances
  // (host_placement: "self"). Without this, $task_registry:listing
  // returns empty on already-deployed self-hosted taskboards because
  // the gateway-only ledgered migration can't see the host's data.
  // backfillTaskRegistryTrackedTasks is naturally idempotent — once the
  // list is populated, subsequent calls skip the registry.
  backfillTaskRegistryTrackedTasks(world);
  // Drop the superseded `taskspace` catalog from any host slice that
  // still owns its objects (the_taskspace is self-hosted, so its
  // contents live on a satellite DO that the gateway-side run cannot
  // reach). The function gates on local presence and on the per-host
  // applied-migrations ledger, so calling it here is safe alongside
  // the gateway-side call in runLocalCatalogMigrations.
  runTaskspaceCatalogDropMigration(world);
}

// Walk every object on this host slice whose parent ref is the literal
// string "$horoscope_note" and rewrite parent to "$dispensed_note". The
// $horoscope_note class object was recycled on 2026-05-09 while still
// having live instance descendants on satellite hosts; each instance
// retained the tombstoned parent ref, which broke verb dispatch through
// the inheritance chain.
//
// Uses migrationSetObjectParent so the rewrite is local and tolerates
// both endpoints being absent: $horoscope_note is tombstoned, and
// $dispensed_note is typically gateway-owned and may not have a stub on
// every satellite. The dispatch-time substrate also tolerates dangling
// parent refs now (see WooWorld.parentWalkLookup) — the migration just
// closes the leak so cleanup metrics stop firing.
function migrateHoroscopeNoteParentOrphans(world: WooWorld): void {
  for (const id of Array.from(world.objects.keys())) {
    const obj = world.objects.get(id);
    if (!obj) continue;
    if (obj.parent !== "$horoscope_note") continue;
    world.migrationSetObjectParent(id, "$dispensed_note");
  }
}

function runPinboardNotesToPinsMigration(world: WooWorld, names: readonly string[], id: string): void {
  if (!names.includes("pinboard")) return;
  if (!localCatalogInstalled(world, "pinboard")) return;
  if (migrationApplied(world, id)) return;
  if (!world.objects.has("$pin") || !world.objects.has("$pinboard")) return;
  const result = runPinboardNotesToPinsDataPlan(world, id, "gateway", "world");
  if (result.status === "completed") {
    markMigrationApplied(world, id);
  }
}

function runPinboardNotesToPinsDataPlan(world: WooWorld, id: string, scope: CatalogSchemaPlanScope, host: string): { status: "completed" | "failed" } {
  const planId = `local-catalog-data:pinboard:${id}`;
  const manifestHash = localCatalogManifestHashForRecord(world, "pinboard", scope, host);
  const preLegacyRecords = countPinboardLegacyNoteRecords(world);
  if (catalogMigrationRecordCompleted(world, planId, scope, host) && preLegacyRecords === 0) return { status: "completed" };
  const startedAt = Date.now();
  try {
    world.withMutationSavepoint(() => migratePinboardNoteRecords(world));
    const postLegacyRecords = countPinboardLegacyNoteRecords(world);
    const status = postLegacyRecords === 0 ? "completed" : "failed";
    recordCatalogDataMigrationResult(world, {
      plan_id: planId,
      catalog: "pinboard",
      version: String(LOCAL_CATALOGS.get("pinboard")?.version ?? ""),
      manifest_hash: manifestHash,
      scope,
      host,
      status,
      started_at: startedAt,
      completed_at: Date.now(),
      pre_legacy_records: preLegacyRecords,
      post_legacy_records: postLegacyRecords,
      steps: [{ id: "1:migrate_pinboard_note_records", kind: "data_migration", target: "pinboard.notes", status: status === "completed" ? "applied" : "failed" }]
    });
    return { status };
  } catch (err) {
    recordCatalogDataMigrationResult(world, {
      plan_id: planId,
      catalog: "pinboard",
      version: String(LOCAL_CATALOGS.get("pinboard")?.version ?? ""),
      manifest_hash: manifestHash,
      scope,
      host,
      status: "failed",
      started_at: startedAt,
      completed_at: Date.now(),
      pre_legacy_records: preLegacyRecords,
      post_legacy_records: countPinboardLegacyNoteRecords(world),
      steps: [{ id: "1:migrate_pinboard_note_records", kind: "data_migration", target: "pinboard.notes", status: "failed", error: repairErrorSummary(err) }],
      error: repairErrorSummary(err)
    });
    return { status: "failed" };
  }
}

function migratePinboardNoteRecords(world: WooWorld): void {
  for (const board of pinboardInstances(world)) {
    const boardObj = world.object(board);
    const hadLegacyNotes = boardObj.properties.has("notes");
    const hadLegacyNextId = boardObj.properties.has("next_note_id");
    const rawNotes = world.propOrNull(board, "notes");
    const staleRecords = Array.isArray(rawNotes) ? rawNotes : [];
    let layout = mapValue(world.propOrNull(board, "layout"));
    let nextZ = numberValue(world.propOrNull(board, "next_z"), 1);
    let index = 0;
    let changed = false;
    for (const raw of staleRecords) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = raw as Record<string, WooValue>;
      if (hasEquivalentMigratedPin(world, board, record)) continue;
      const owner = pinOwner(world, board, record.author);
      const lines = noteTextLines(record.text);
      const text = lines.length > 0 ? lines.join("\n") : "";
      const pin = world.createRuntimeObject("$pin", owner, board, {
        progr: "$wiz",
        location: board,
        name: "sticky note",
        description: text ? `A sticky note. It says: ${text}` : "A sticky note."
      });
      world.setProp(pin, "text", text);
      world.setProp(pin, "color", typeof record.color === "string" ? record.color : null);
      const z = numberValue(record.z, nextZ);
      layout = {
        ...layout,
        [pin]: {
          x: numberValue(record.x, 48 + index * 32),
          y: numberValue(record.y, 48 + index * 26),
          w: numberValue(record.w, 180),
          h: numberValue(record.h, 110),
          z
        }
      };
      nextZ = Math.max(nextZ, z + 1);
      index += 1;
      changed = true;
    }
    if (changed) {
      world.setProp(board, "layout", layout);
      world.setProp(board, "next_z", nextZ);
    }
    if (hadLegacyNotes) world.deleteProp(board, "notes");
    if (hadLegacyNextId) world.deleteProp(board, "next_note_id");
  }
}

function countPinboardLegacyNoteRecords(world: WooWorld): number {
  if (!world.objects.has("$pinboard")) return 0;
  let count = 0;
  for (const board of pinboardInstances(world)) {
    const raw = world.propOrNull(board, "notes");
    if (Array.isArray(raw)) count += raw.filter((item) => item && typeof item === "object" && !Array.isArray(item)).length;
  }
  return count;
}

function hasEquivalentMigratedPin(world: WooWorld, board: ObjRef, record: Record<string, WooValue>): boolean {
  const layout = mapValue(world.propOrNull(board, "layout"));
  const expectedLines = noteTextLines(record.text);
  const expectedText = expectedLines.length > 0 ? expectedLines.join("\n") : "";
  const expectedColor = typeof record.color === "string" ? record.color : null;
  for (const id of world.object(board).contents) {
    if (!world.objects.has(id) || !world.isDescendantOf(id, "$pin")) continue;
    const text = world.propOrNull(id, "text");
    if (typeof text !== "string" || text !== expectedText) continue;
    if (world.propOrNull(id, "color") !== expectedColor) continue;
    const entry = layout[id];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const layoutRecord = entry as Record<string, WooValue>;
    if (
      numberValue(layoutRecord.x, NaN) === numberValue(record.x, NaN) &&
      numberValue(layoutRecord.y, NaN) === numberValue(record.y, NaN) &&
      numberValue(layoutRecord.w, NaN) === numberValue(record.w, NaN) &&
      numberValue(layoutRecord.h, NaN) === numberValue(record.h, NaN)
    ) return true;
  }
  return false;
}

function pinboardInstances(world: WooWorld): ObjRef[] {
  const boards: ObjRef[] = [];
  // The bundled migration is a one-time boot repair; a full scan avoids adding
  // catalog-specific instance indexes to the runtime.
  for (const id of world.objects.keys()) {
    if (id.startsWith("$")) continue;
    if (world.isDescendantOf(id, "$pinboard")) boards.push(id);
  }
  return boards.sort();
}

function pinOwner(world: WooWorld, board: ObjRef, value: WooValue | undefined): ObjRef {
  if (typeof value === "string" && world.objects.has(value)) return value;
  const owner = world.object(board).owner;
  return world.objects.has(owner) ? owner : "$wiz";
}

function noteTextLines(value: WooValue | undefined): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return value.split(/\r?\n/);
  return [];
}

function mapValue(value: WooValue): Record<string, WooValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, WooValue>) } : {};
}

function numberValue(value: WooValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function repairErrorSummary(err: unknown): Record<string, WooValue> {
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    return {
      code: typeof record.code === "string" ? record.code : "E_INTERNAL",
      message: typeof record.message === "string" ? record.message : String(err)
    };
  }
  return { code: "E_INTERNAL", message: String(err) };
}
