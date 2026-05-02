import { BUNDLED_CATALOGS } from "../generated/bundled-catalogs";
import { catalogManifestStatus, installCatalogManifest, repairCatalogManifest, type CatalogManifest, type CatalogManifestStatus } from "./catalog-installer";
import type { ObjRef, WooValue } from "./types";
import type { WooWorld } from "./world";

export type LocalCatalogName = string;
export type LocalCatalogStatus = CatalogManifestStatus & {
  local: true;
  migrations: Array<{ id: string; applied: boolean }>;
  pending_migrations: string[];
};

const LOCAL_CATALOGS = new Map(BUNDLED_CATALOGS.map((entry) => [entry.manifest.name, entry.manifest] as const));
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
const LOCAL_CATALOG_TASKSPACE_VERBS_REPAIR_MIGRATION = "2026-05-01-taskspace-verbs-repair";
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
const LOCAL_CATALOG_TASKSPACE_LIST_TASKS_GUARD_MIGRATION = "2026-05-02-taskspace-list-tasks-guard";
const LOCAL_CATALOG_PROG_EDITOR_ROOM_MIGRATION = "2026-05-02-prog-editor-room";
const LOCAL_CATALOG_PROG_EDITOR_NOWHERE_MIGRATION = "2026-05-02-prog-editor-nowhere";

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
  { id: LOCAL_CATALOG_TASKSPACE_VERBS_REPAIR_MIGRATION, only: "taskspace" },
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
  { id: LOCAL_CATALOG_TASKSPACE_LIST_TASKS_GUARD_MIGRATION, only: "taskspace" },
  { id: LOCAL_CATALOG_PROG_EDITOR_ROOM_MIGRATION, only: "prog" },
  { id: LOCAL_CATALOG_PROG_EDITOR_NOWHERE_MIGRATION, only: "prog" }
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
  for (const name of requested) installLocalCatalog(world, name);

  // Existing worlds still need repair even when WOO_AUTO_INSTALL_CATALOGS is
  // intentionally empty. Missing dependencies of already-installed local
  // catalogs are compatibility repair, not fresh auto-install policy.
  const repairNames = localMigrationCatalogNames(world, requested);
  installMissingLocalCatalogDependencies(world, repairNames);
  runLocalCatalogMigrations(world, repairNames);
}

export function installLocalCatalog(world: WooWorld, name: string): void {
  if (!isLocalCatalogName(name)) throw new Error(`unknown local catalog: ${name}`);
  // Boot auto-install is part of deterministic world construction, not a user
  // catalog operation. Runtime installs still go through $catalog_registry.
  if (localCatalogInstalled(world, name)) return;
  const manifest = LOCAL_CATALOGS.get(name)!;
  const provenance: Record<string, WooValue> = {
    tap: "@local",
    catalog: name,
    alias: name,
    ref_requested: "@local",
    ref_resolved_sha: "unversioned"
  };
  installCatalogManifest(world, manifest, { tap: "@local", alias: name, actor: "$wiz", provenance });
}

export function localCatalogStatuses(world: WooWorld, names: readonly string[] = DEFAULT_LOCAL_CATALOGS): LocalCatalogStatus[] {
  return sortCatalogNames(names).map((name) => {
    if (!isLocalCatalogName(name)) throw new Error(`unknown local catalog: ${name}`);
    const migrations = LOCAL_CATALOG_MIGRATION_INDEX
      .filter((migration) => !migration.only || migration.only === name)
      .map((migration) => ({ id: migration.id, applied: migrationApplied(world, migration.id) }));
    const base = catalogManifestStatus(world, LOCAL_CATALOGS.get(name)!, {
      tap: "@local",
      alias: name,
      actor: "$wiz",
      allowImplementationHints: true
    });
    return {
      ...base,
      local: true,
      migrations,
      pending_migrations: migrations.filter((migration) => !migration.applied).map((migration) => migration.id)
    };
  });
}

export function runHostScopedLocalCatalogLifecycle(world: WooWorld): void {
  const names = hostScopedLocalCatalogNames(world);
  for (const name of names) {
    repairHostScopedLocalCatalog(world, name);
  }
  runHostScopedDataMigrations(world);
}

function runLocalCatalogMigrations(world: WooWorld, names: readonly string[]): void {
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_SOURCE_MIGRATION);
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PLACEMENT_MIGRATION);
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_COCKATOO_MIGRATION);
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_LOOK_CONTENTS_MIGRATION);
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_COMMAND_PARSER_MIGRATION, { allowImplementationHints: true });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_DUBSPACE_CONTROL_GUARDS_MIGRATION, { allowImplementationHints: true });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_DUBSPACE_MOUNTED_CONTROLS_MIGRATION, { allowImplementationHints: true, reconcileSeedHooks: true, only: "dubspace" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_ROOM_LOOK_SELF_MIGRATION, { allowImplementationHints: true });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_THREE_ROOM_MIGRATION, { allowImplementationHints: true });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_OBSERVATION_OUTPUT_MIGRATION, { allowImplementationHints: true });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_ROOM_CONTENTS_REPAIR_MIGRATION, { allowImplementationHints: true, reconcileSeedHooks: true, only: "chat" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_AGENT_TOOL_EXPOSURE_REPAIR_MIGRATION, { allowImplementationHints: true });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_NAVIGATION_TOOL_EXPOSURE_MIGRATION, { allowImplementationHints: true, only: "chat" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_COCKATOO_TOOL_EXPOSURE_MIGRATION, { allowImplementationHints: true, only: "chat" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_NOWHERE_PORTABLES_REPAIR_MIGRATION, { allowImplementationHints: true, reconcileSeedHooks: true, rehomeNowhereSeedObjects: true, only: "chat" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_TASKSPACE_VERBS_REPAIR_MIGRATION, { allowImplementationHints: true, only: "taskspace" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PINBOARD_LOOK_OBSERVATION_MIGRATION, { allowImplementationHints: true, only: "pinboard" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PINBOARD_ACTIVITY_TEXT_MIGRATION, { allowImplementationHints: true, only: "pinboard" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PINBOARD_VIEWPORT_PRESENCE_MIGRATION, { allowImplementationHints: true, only: "pinboard" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PINBOARD_FREE_COORDS_MIGRATION, { allowImplementationHints: true, only: "pinboard" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_DUBSPACE_SOURCE_PRESENCE_MIGRATION, { allowImplementationHints: true, only: "dubspace" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PINBOARD_SOURCE_PRESENCE_MIGRATION, { allowImplementationHints: true, only: "pinboard" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PINBOARD_PINS_MODEL_MIGRATION, { allowImplementationHints: true, reconcileSeedHooks: true, only: "pinboard" });
  runPinboardNotesToPinsMigration(world, names, LOCAL_CATALOG_PINBOARD_NOTES_TO_PINS_MIGRATION);
  runPinboardV02RepairMigration(world, names);
  runPinboardNotesToPinsMigration(world, names, LOCAL_CATALOG_PINBOARD_V02_DATA_REPAIR_MIGRATION);
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_SOURCE_MOVEMENT_MIGRATION, { allowImplementationHints: true, only: "chat" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_ROOM_EXIT_MODEL_MIGRATION, { allowImplementationHints: true, reconcileSeedHooks: true, only: "chat" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_EXIT_PRIVILEGE_REPAIR_MIGRATION, { allowImplementationHints: true, only: "chat" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_EXIT_ALIAS_REPAIR_MIGRATION, { allowImplementationHints: true, reconcileSeedHooks: true, only: "chat" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_CHAT_STALE_CLASS_VERBS_REPAIR_MIGRATION, { allowImplementationHints: true, reconcileClassVerbs: true, only: "chat" });
  runChatLookSkipPresenceMigration(world, names);
  runTaskspaceListTasksGuardMigration(world, names);
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PROG_EDITOR_ROOM_MIGRATION, { reconcileSeedHooks: true, only: "prog" });
  runLocalCatalogMigration(world, names, LOCAL_CATALOG_PROG_EDITOR_NOWHERE_MIGRATION, { reconcileSeedHooks: true, only: "prog" });
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
    if (!localCatalogInstalled(world, name)) installLocalCatalog(world, name);
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
  if (localCatalogInstalled(world, name)) return true;
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

function repairHostScopedLocalCatalog(world: WooWorld, name: string): void {
  const manifest = LOCAL_CATALOGS.get(name);
  if (!manifest) return;
  try {
    repairCatalogManifest(world, manifest, {
      actor: "$wiz",
      allowImplementationHints: true,
      reconcileSeedHooks: true,
      skipMissingSeedHooks: true
    });
  } catch (err) {
    // Host-scoped slices may temporarily lack a support object until the
    // gateway's fresh seed can be fetched and merged. Catalog repair is
    // idempotent, so defer rather than bricking unrelated requests on this DO.
    console.warn("woo.local_catalog_host_repair_deferred", { catalog: name, error: repairErrorSummary(err) });
  }
}

function runLocalCatalogMigration(world: WooWorld, names: readonly string[], id: string, options: { allowImplementationHints?: boolean; reconcileSeedHooks?: boolean; rehomeNowhereSeedObjects?: boolean; reconcileClassVerbs?: boolean; only?: string } = {}): void {
  if (migrationApplied(world, id)) return;
  let repaired = false;
  for (const name of names) {
    if (options.only && name !== options.only) continue;
    if (!localCatalogInstalled(world, name)) continue;
    repairCatalogManifest(world, LOCAL_CATALOGS.get(name)!, {
      actor: "$wiz",
      allowImplementationHints: options.allowImplementationHints,
      reconcileSeedHooks: options.reconcileSeedHooks,
      rehomeNowhereSeedObjects: options.rehomeNowhereSeedObjects,
      reconcileClassVerbs: options.reconcileClassVerbs
    });
    repaired = true;
  }
  if (repaired || !options.only) markMigrationApplied(world, id);
}

function runPinboardV02RepairMigration(world: WooWorld, names: readonly string[]): void {
  if (!names.includes("pinboard")) return;
  if (!localCatalogInstalled(world, "pinboard")) return;
  if (migrationApplied(world, LOCAL_CATALOG_PINBOARD_V02_REPAIR_MIGRATION)) return;
  // The repair re-walks the manifest, which references $note as $pin's
  // parent. Without that ancestor in place repairCatalogManifest throws
  // E_UNRESOLVED_REFERENCE — defer until a later boot installs note.
  if (!world.objects.has("$note")) return;
  const listNotes = world.objects.has("$pinboard") ? world.ownVerbExact("$pinboard", "list_notes") : null;
  const needsRepair =
    !world.objects.has("$pin") ||
    !listNotes ||
    !listNotes.source.includes("contents(this)") ||
    !world.ownVerbExact("$pinboard", "add_note")?.source.includes("create($pin");

  if (needsRepair) {
    repairCatalogManifest(world, LOCAL_CATALOGS.get("pinboard")!, {
      actor: "$wiz",
      allowImplementationHints: true,
      reconcileSeedHooks: true,
      reconcileClassVerbs: true
    });
  }
  markMigrationApplied(world, LOCAL_CATALOG_PINBOARD_V02_REPAIR_MIGRATION);
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

function runTaskspaceListTasksGuardMigration(world: WooWorld, names: readonly string[]): void {
  if (!names.includes("taskspace")) return;
  if (!localCatalogInstalled(world, "taskspace")) return;
  if (migrationApplied(world, LOCAL_CATALOG_TASKSPACE_LIST_TASKS_GUARD_MIGRATION)) return;
  const listTasks = world.objects.has("$taskspace") ? world.ownVerbExact("$taskspace", "list_tasks") : null;
  if (!listTasks || !listTasks.source.includes("isa(t, $task)")) {
    repairCatalogManifest(world, LOCAL_CATALOGS.get("taskspace")!, {
      actor: "$wiz",
      allowImplementationHints: true
    });
  }
  markMigrationApplied(world, LOCAL_CATALOG_TASKSPACE_LIST_TASKS_GUARD_MIGRATION);
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
export function runHostScopedDataMigrations(world: WooWorld): void {
  if (world.objects.has("$pin") && world.objects.has("$pinboard")) {
    world.withMutationSavepoint(() => migratePinboardNoteRecords(world));
  }
}

function runPinboardNotesToPinsMigration(world: WooWorld, names: readonly string[], id: string): void {
  if (!names.includes("pinboard")) return;
  if (!localCatalogInstalled(world, "pinboard")) return;
  if (migrationApplied(world, id)) return;
  if (!world.objects.has("$pin") || !world.objects.has("$pinboard")) return;
  world.withMutationSavepoint(() => {
    migratePinboardNoteRecords(world);
    markMigrationApplied(world, id);
  });
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
      const pin = world.createRuntimeObject("$pin", owner, board, {
        progr: "$wiz",
        location: board,
        name: "sticky note",
        description: `A sticky note pinned to ${world.object(board).name}.`
      });
      const lines = noteTextLines(record.text);
      world.setProp(pin, "text", lines);
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

function hasEquivalentMigratedPin(world: WooWorld, board: ObjRef, record: Record<string, WooValue>): boolean {
  const layout = mapValue(world.propOrNull(board, "layout"));
  const expectedText = noteTextLines(record.text);
  const expectedColor = typeof record.color === "string" ? record.color : null;
  for (const id of world.object(board).contents) {
    if (!world.objects.has(id) || !world.isDescendantOf(id, "$pin")) continue;
    const text = world.propOrNull(id, "text");
    if (!Array.isArray(text) || JSON.stringify(text) !== JSON.stringify(expectedText)) continue;
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
