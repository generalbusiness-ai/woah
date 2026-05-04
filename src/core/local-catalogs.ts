import { BUNDLED_CATALOGS } from "../generated/bundled-catalogs";
import {
  applyCatalogSchemaPlan,
  catalogManifestStatus,
  catalogSchemaPlanIdentity,
  installCatalogManifest,
  planCatalogSchemaMigration,
  verifyCatalogSchemaPlan,
  type CatalogManifest,
  type CatalogManifestStatus,
  type CatalogSchemaPlanApplyResult,
  type CatalogSchemaPlanScope
} from "./catalog-installer";
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
const LOCAL_CATALOG_CHAT_COMMAND_PLAN_SOURCE_REPAIR_MIGRATION = "2026-05-03-chat-command-plan-source-repair";
const LOCAL_CATALOG_CHAT_LOOK_AT_TRY_MIGRATION = "2026-05-03-chat-look-at-collect-prop-try";
const LOCAL_CATALOG_TASKSPACE_LIST_TASKS_GUARD_MIGRATION = "2026-05-02-taskspace-list-tasks-guard";
const LOCAL_CATALOG_TASKSPACE_TASK_NOTE_PARENT_MIGRATION = "2026-05-03-taskspace-task-note-parent";
const LOCAL_CATALOG_PROG_EDITOR_ROOM_MIGRATION = "2026-05-02-prog-editor-room";
const LOCAL_CATALOG_PROG_EDITOR_NOWHERE_MIGRATION = "2026-05-02-prog-editor-nowhere";
const LOCAL_CATALOG_DEMO_SPACES_NO_AUTO_PRESENCE_MIGRATION = "2026-05-04-demo-spaces-no-auto-presence";
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
  { id: LOCAL_CATALOG_CHAT_COMMAND_PLAN_SOURCE_REPAIR_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_CHAT_LOOK_AT_TRY_MIGRATION, only: "chat" },
  { id: LOCAL_CATALOG_TASKSPACE_LIST_TASKS_GUARD_MIGRATION, only: "taskspace" },
  { id: LOCAL_CATALOG_TASKSPACE_TASK_NOTE_PARENT_MIGRATION, only: "taskspace" },
  { id: LOCAL_CATALOG_PROG_EDITOR_ROOM_MIGRATION, only: "prog" },
  { id: LOCAL_CATALOG_PROG_EDITOR_NOWHERE_MIGRATION, only: "prog" },
  { id: LOCAL_CATALOG_DEMO_SPACES_NO_AUTO_PRESENCE_MIGRATION }
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
  const covered = runLocalCatalogMigrations(world, repairNames, cleanInstalled);
  runAutoDetectedLocalCatalogSchemaSync(world, repairNames, covered, requested.length === 0);
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
  run(LOCAL_CATALOG_TASKSPACE_VERBS_REPAIR_MIGRATION, { allowImplementationHints: true, only: "taskspace" });
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
  run(LOCAL_CATALOG_CHAT_LOOK_AT_TRY_MIGRATION, { allowImplementationHints: true, only: "chat" });
  runTaskspaceListTasksGuardMigration(world, names);
  runTaskspaceTaskNoteParentMigration(world, names);
  run(LOCAL_CATALOG_PROG_EDITOR_ROOM_MIGRATION, { reconcileSeedHooks: true, only: "prog" });
  run(LOCAL_CATALOG_PROG_EDITOR_NOWHERE_MIGRATION, { reconcileSeedHooks: true, only: "prog" });
  runDemoSpacesNoAutoPresenceMigration(world);
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
    // Cold-host wake re-runs schema sync against every installed catalog. The
    // plan id is a function of manifest content only, so when a previous host
    // boot already recorded a completed plan for this exact manifest we can
    // skip both planCatalogSchemaMigration (walks every class/verb/seed_hook)
    // and verifyCatalogSchemaPlan (walks the world for status). Drift gets
    // repaired by the gateway sync; the host trusts the previous record.
    const planId = catalogSchemaPlanIdentity(manifest).id;
    if (catalogMigrationRecordCompleted(world, planId, "host", host)) {
      skipped += 1;
      continue;
    }
    planned += 1;
    const result = runLocalCatalogSchemaPlan(world, name, manifest, "host", host, {
      allowImplementationHints: true,
      reconcileSeedHooks: true,
      skipMissingSeedHooks: true
    });
    if (result.status === "failed") {
      console.warn("woo.local_catalog_host_schema_plan_failed", { catalog: name, host, plan_id: result.plan_id, error: result.error ?? null, issues: result.issues });
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

function runDemoSpacesNoAutoPresenceMigration(world: WooWorld): void {
  if (migrationApplied(world, LOCAL_CATALOG_DEMO_SPACES_NO_AUTO_PRESENCE_MIGRATION)) return;
  const drop = new Set<ObjRef>();
  for (const id of Array.from(world.objects.keys())) {
    if (!world.isDescendantOf(id, "$space")) continue;
    if (world.propOrNull(id, "auto_presence") !== true) continue;
    drop.add(id);
    world.setProp(id, "auto_presence", false);
    const subscribers = world.propOrNull(id, "subscribers");
    if (Array.isArray(subscribers) && subscribers.length > 0) world.setProp(id, "subscribers", []);
  }
  if (drop.size > 0) {
    for (const id of Array.from(world.objects.keys())) {
      if (!world.isDescendantOf(id, "$actor")) continue;
      const presence = world.propOrNull(id, "presence_in");
      if (!Array.isArray(presence) || presence.length === 0) continue;
      const next = presence.filter((entry) => typeof entry !== "string" || !drop.has(entry));
      if (next.length !== presence.length) world.setProp(id, "presence_in", next);
    }
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

function runTaskspaceListTasksGuardMigration(world: WooWorld, names: readonly string[]): void {
  if (!names.includes("taskspace")) return;
  if (!localCatalogInstalled(world, "taskspace")) return;
  if (migrationApplied(world, LOCAL_CATALOG_TASKSPACE_LIST_TASKS_GUARD_MIGRATION)) return;
  const listTasks = world.objects.has("$taskspace") ? world.ownVerbExact("$taskspace", "list_tasks") : null;
  if (!listTasks || !listTasks.source.includes("isa(t, $task)")) {
    const result = runLocalCatalogSchemaPlan(world, "taskspace", LOCAL_CATALOGS.get("taskspace")!, "gateway", "world", {
      allowImplementationHints: true
    });
    if (result.status === "failed") throw new Error(`local catalog schema plan failed: ${result.plan_id}`);
  }
  markMigrationApplied(world, LOCAL_CATALOG_TASKSPACE_LIST_TASKS_GUARD_MIGRATION);
}

function runTaskspaceTaskNoteParentMigration(world: WooWorld, names: readonly string[]): void {
  if (!names.includes("taskspace")) return;
  if (!localCatalogInstalled(world, "taskspace")) return;
  if (migrationApplied(world, LOCAL_CATALOG_TASKSPACE_TASK_NOTE_PARENT_MIGRATION)) return;
  // The taskspace manifest now declares `$task < note:$note`. Dependency repair
  // installs `note` first for old worlds; if a partial boot has not reached that
  // point yet, defer until a later boot can prove the parent postcondition.
  if (!world.objects.has("$note")) return;
  if (!world.objects.has("$task") || world.object("$task").parent !== "$note") {
    const result = runLocalCatalogSchemaPlan(world, "taskspace", LOCAL_CATALOGS.get("taskspace")!, "gateway", "world", {
      allowImplementationHints: true
    });
    if (result.status === "failed") throw new Error(`local catalog schema plan failed: ${result.plan_id}`);
  }
  markMigrationApplied(world, LOCAL_CATALOG_TASKSPACE_TASK_NOTE_PARENT_MIGRATION);
}

function runAutoDetectedLocalCatalogSchemaSync(world: WooWorld, names: readonly string[], covered: ReadonlySet<string>, forceVerify: boolean): void {
  for (const name of names) {
    if (!localCatalogInstalled(world, name)) continue;
    const manifest = LOCAL_CATALOGS.get(name)!;
    if (covered.has(name)) {
      recordCoveredLocalCatalogSchemaPlan(world, name, manifest);
      continue;
    }
    // Fast-path: when not forcing verify, derive the plan id directly from the
    // manifest (cheap) and skip both planCatalogSchemaMigration and
    // verifyCatalogSchemaPlan if the migration record already covers it. The
    // recorded manifest_hash on $catalog_registry must match too — that is the
    // signal the manifest is byte-identical to the one that ran last time.
    if (!forceVerify) {
      const identity = catalogSchemaPlanIdentity(manifest);
      if (
        catalogMigrationRecordCompleted(world, identity.id, "gateway", "world") &&
        localCatalogInstalledManifestHash(world, name) === identity.manifest_hash
      ) {
        markMigrationApplied(world, identity.id);
        continue;
      }
    }
    const plan = planCatalogSchemaMigration(world, manifest, {
      actor: "$wiz",
      allowImplementationHints: true,
      reconcileSeedHooks: true,
      scope: "gateway",
      host: "world"
    });
    if (
      !forceVerify &&
      catalogMigrationRecordCompleted(world, plan.id, "gateway", "world") &&
      localCatalogInstalledManifestHash(world, name) === plan.manifest_hash
    ) {
      markMigrationApplied(world, plan.id);
      continue;
    }
    const result = runLocalCatalogSchemaPlan(world, name, manifest, "gateway", "world", {
      allowImplementationHints: true,
      reconcileSeedHooks: true
    });
    if (result.status === "completed") markMigrationApplied(world, result.plan_id);
    else console.warn("woo.local_catalog_schema_plan_failed", { catalog: name, plan_id: result.plan_id, error: result.error ?? null, issues: result.issues });
  }
}

function localCatalogInstalledManifestHash(world: WooWorld, name: string): string | null {
  if (!world.objects.has("$catalog_registry")) return null;
  const raw = world.propOrNull("$catalog_registry", "installed_catalogs");
  if (!Array.isArray(raw)) return null;
  for (const record of raw) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const item = record as Record<string, WooValue>;
    if (item.tap !== "@local") continue;
    if (item.alias !== name && item.catalog !== name) continue;
    const provenance = item.provenance;
    if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return null;
    const hash = (provenance as Record<string, WooValue>).local_manifest_hash;
    return typeof hash === "string" ? hash : null;
  }
  return null;
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
  if (catalogMigrationRecordCompleted(world, plan.id, scope, host) && preIssues.length === 0) {
    return {
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
  const next = raw.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return record;
    const item = record as Record<string, WooValue>;
    if (item.tap !== "@local") return record;
    if (item.alias !== name && item.catalog !== name) return record;
    const provenance = item.provenance && typeof item.provenance === "object" && !Array.isArray(item.provenance)
      ? { ...(item.provenance as Record<string, WooValue>) }
      : {};
    return {
      ...item,
      version: manifest.version,
      updated_at: Date.now(),
      objects: { ...mapValue(item.objects), ...manifestObjectRefs(manifest) },
      seeds: { ...mapValue(item.seeds), ...manifestSeedRefs(manifest) },
      provenance: {
        ...provenance,
        local_schema_sync: id,
        local_manifest_hash: manifestHash
      }
    } as WooValue;
  });
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
