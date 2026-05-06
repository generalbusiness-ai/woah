import { compileVerb } from "./authoring";
import { fixtureByName } from "./fixtures";
import { hashSource } from "./source-hash";
import { wooError, type ErrorValue, type ObjRef, type TinyBytecode, type VerbDef, type WooValue } from "./types";
import { normalizeVerbPerms } from "./verb-perms";
import type { WooWorld } from "./world";

export type CatalogManifest = {
  name: string;
  version: string;
  spec_version: string;
  description?: string;
  license?: string;
  depends?: string[];
  classes?: CatalogObjectDef[];
  features?: CatalogObjectDef[];
  schemas?: CatalogSchemaDef[];
  seed_hooks?: CatalogSeedHook[];
};

type CatalogObjectDef = {
  local_name: string;
  parent: string;
  description?: string;
  properties?: CatalogPropertyDef[];
  verbs?: CatalogVerbDef[];
  /** Names of properties that the class's `:set_property[ies]` verb (or
   * other catalog-level write verbs) should permit the *owner* of an
   * instance to write. Used by the $block tiered-write design: owner
   * sets config knobs (e.g. weather block's `place`), the catalog's
   * verb body consults this list to gate the write. The substrate just
   * persists the list as a wizard-owned, public-read property on the
   * class object so the woocode can read it via `this.writable_owner`. */
  writable_owner?: string[];
  /** Names of properties that the class's write verbs should permit
   * "self" — i.e. the class's actor instance authenticated as itself —
   * to write. The plug authenticates as the block actor and writes
   * `current` / `forecast` / etc. via apikey. The catalog verb body
   * checks `caller == this` against this list. */
  writable_self?: string[];
};

type CatalogPropertyDef = {
  name: string;
  type?: string;
  default?: WooValue;
  perms?: string;
};

type CatalogVerbDef = {
  name: string;
  aliases?: string[];
  perms?: string;
  arg_spec?: Record<string, WooValue>;
  source: string;
  direct_callable?: boolean;
  skip_presence_check?: boolean;
  tool_exposed?: boolean;
  implementation?: { kind: "native"; handler: string } | { kind: "fixture"; name: keyof typeof fixtureByName };
};

type CatalogSchemaDef = {
  on: string;
  type: string;
  shape: Record<string, WooValue>;
};

type CatalogSeedHook =
  | {
      kind: "create_instance";
      class: string;
      as: string;
      name?: string;
      description?: string;
      anchor?: string;
      location?: string;
      properties?: Record<string, WooValue>;
    }
  | {
      kind: "attach_feature";
      consumer: string;
      feature: string;
    }
  | {
      kind: "set_property";
      object: string;
      property: string;
      value: WooValue;
      mode?: "set" | "set_if_missing" | "append_unique";
    }
  | {
      kind: "change_parent";
      object: string;
      parent: string;
    };

export type CatalogMigrationStep =
  | { kind: "rename_property"; class: string; from: string; to: string }
  | { kind: "drop_property"; class: string; name: string }
  | { kind: "add_property"; class: string; name: string; default?: WooValue; type?: string; perms?: string }
  | { kind: "rename_verb"; class: string; from: string; to: string }
  | { kind: "drop_verb"; class: string; verb: string }
  | { kind: "change_parent"; class: string; parent: string }
  | { kind: "rename_class"; from: string; to: string }
  | { kind: "transform_property"; class: string; name: string; transform: string }
  | { kind: "custom"; verb: string };

export type CatalogMigrationManifest = {
  from_version: string;
  to_version: string;
  spec_version: string;
  steps: CatalogMigrationStep[];
};

export type CatalogMigrationState = {
  status: "completed" | "failed" | "not_required";
  from_version: string;
  to_version: string;
  completed_steps: string[];
  failed_step?: string;
  error?: ErrorValue;
  updated_at: number;
};

export type InstalledCatalogRecord = {
  tap: string;
  catalog: string;
  alias: string;
  version: string;
  installed_at: number;
  updated_at?: number;
  owner: ObjRef;
  objects: Record<string, ObjRef>;
  seeds: Record<string, ObjRef>;
  provenance: Record<string, WooValue>;
  migration_state?: CatalogMigrationState;
};

export type CatalogStatusIssue = {
  severity: "info" | "warning" | "error";
  kind: string;
  message: string;
  object?: ObjRef;
  verb?: string;
  property?: string;
  expected?: WooValue;
  actual?: WooValue;
};

export type CatalogManifestStatus = {
  tap: string;
  catalog: string;
  alias: string;
  installed: boolean;
  manifest_version: string;
  installed_version: string | null;
  version_match: boolean;
  needs_repair: boolean;
  issues: CatalogStatusIssue[];
};

const DYNAMIC_SEED_PROPERTIES = new Set([
  "next_seq",
  "subscribers",
  "operators",
  "last_snapshot_seq"
]);

export type InstallCatalogOptions = {
  actor?: ObjRef;
  tap?: string;
  alias?: string;
  provenance?: Record<string, WooValue>;
  allowImplementationHints?: boolean;
  adoptExisting?: boolean;
};

export type RepairCatalogOptions = {
  actor?: ObjRef;
  allowImplementationHints?: boolean;
  reconcileSeedHooks?: boolean;
  // Host-scoped repair uses this for partial world slices: repair classes and
  // existing seeds, but do not create missing instances on the wrong host.
  skipMissingSeedHooks?: boolean;
  rehomeNowhereSeedObjects?: boolean;
  reconcileClassVerbs?: boolean;
};

export type CatalogSchemaPlanScope = "gateway" | "host";

export type CatalogSchemaPlanOptions = RepairCatalogOptions & {
  scope?: CatalogSchemaPlanScope;
  host?: string;
};

export type CatalogSchemaPlanStep =
  | { id: string; kind: "ensure_object"; object: ObjRef; def: CatalogObjectDef }
  | { id: string; kind: "ensure_property_def"; object: ObjRef; property: CatalogPropertyDef }
  | { id: string; kind: "ensure_verb"; object: ObjRef; verb: CatalogVerbDef }
  | { id: string; kind: "drop_stale_verbs"; object: ObjRef; keep: string[] }
  | { id: string; kind: "ensure_event_schema"; object: ObjRef; schema: CatalogSchemaDef }
  | { id: string; kind: "ensure_seed_object"; object: ObjRef; hook: Extract<CatalogSeedHook, { kind: "create_instance" }> }
  | { id: string; kind: "reconcile_seed_object"; object: ObjRef; hook: Extract<CatalogSeedHook, { kind: "create_instance" }> }
  | { id: string; kind: "seed_property_defaults"; object: ObjRef; hook: Extract<CatalogSeedHook, { kind: "create_instance" }> }
  | { id: string; kind: "change_parent"; object: ObjRef; hook: Extract<CatalogSeedHook, { kind: "change_parent" }> }
  | { id: string; kind: "set_property"; object: ObjRef; hook: Extract<CatalogSeedHook, { kind: "set_property" }> }
  | { id: string; kind: "attach_feature"; consumer: ObjRef; feature: ObjRef; hook: Extract<CatalogSeedHook, { kind: "attach_feature" }> }
  | { id: string; kind: "sync_exit_aliases"; object: ObjRef };

export type CatalogSchemaPlan = {
  id: string;
  catalog: string;
  version: string;
  manifest_hash: string;
  scope: CatalogSchemaPlanScope;
  host: string;
  options: {
    allow_implementation_hints: boolean;
    reconcile_seed_hooks: boolean;
    skip_missing_seed_hooks: boolean;
    rehome_nowhere_seed_objects: boolean;
    reconcile_class_verbs: boolean;
  };
  steps: CatalogSchemaPlanStep[];
};

export type CatalogSchemaPlanStepResult = {
  id: string;
  kind: CatalogSchemaPlanStep["kind"];
  target: string;
  status: "applied" | "skipped" | "failed";
  error?: ErrorValue;
};

export type CatalogSchemaPlanApplyResult = {
  status: "completed" | "failed";
  plan_id: string;
  catalog: string;
  version: string;
  manifest_hash: string;
  scope: CatalogSchemaPlanScope;
  host: string;
  started_at: number;
  completed_at: number;
  steps: CatalogSchemaPlanStepResult[];
  issues: CatalogStatusIssue[];
  error?: ErrorValue;
};

export type UpdateCatalogOptions = InstallCatalogOptions & {
  acceptMajor?: boolean;
  migration?: CatalogMigrationManifest | null;
};

export function catalogManifestStatus(world: WooWorld, manifest: CatalogManifest, options: InstallCatalogOptions = {}): CatalogManifestStatus {
  const tap = options.tap ?? "@local";
  const alias = options.alias ?? manifest.name;
  const allowImplementationHints = options.allowImplementationHints ?? tap === "@local";
  const records = installedCatalogs(world);
  const record = records.find((item) => item.alias === alias || (item.tap === tap && item.catalog === manifest.name)) ?? null;
  const issues: CatalogStatusIssue[] = [];
  if (!record) {
    issues.push({
      severity: "warning",
      kind: "not_installed",
      message: `catalog is not installed: ${tap}:${manifest.name} as ${alias}`
    });
  } else if (record.version !== manifest.version) {
    issues.push({
      severity: "warning",
      kind: "version_mismatch",
      message: `installed version ${record.version} differs from manifest version ${manifest.version}`,
      expected: manifest.version,
      actual: record.version
    });
  }

  const owner = record?.owner ?? options.actor ?? "$wiz";
  const localObjects = new Map<string, ObjRef>();
  const localSeeds = new Map<string, ObjRef>();
  const objectDefs = [...(manifest.classes ?? []), ...(manifest.features ?? [])];
  for (const def of objectDefs) localObjects.set(def.local_name, def.local_name);
  for (const hook of manifest.seed_hooks ?? []) {
    if (hook.kind === "create_instance") localSeeds.set(hook.as, hook.as);
  }

  for (const def of objectDefs) {
    if (!world.objects.has(def.local_name)) {
      issues.push({
        severity: "error",
        kind: "missing_object",
        object: def.local_name,
        message: `catalog object is missing: ${def.local_name}`
      });
      continue;
    }
    try {
      const expectedParent = resolveObjectRef(world, def.parent, localObjects, localSeeds, records);
      const actualParent = world.object(def.local_name).parent;
      if (actualParent !== expectedParent) {
        issues.push({
          severity: "warning",
          kind: "parent_drift",
          object: def.local_name,
          message: `${def.local_name} parent differs from manifest`,
          expected: expectedParent,
          actual: actualParent
        });
      }
    } catch (err) {
      issues.push(catalogStatusErrorIssue("unresolved_parent", def.local_name, err));
    }

    for (const property of def.properties ?? []) {
      const actual = world.object(def.local_name).propertyDefs.get(property.name);
      if (!actual) {
        issues.push({
          severity: "warning",
          kind: "missing_property",
          object: def.local_name,
          property: property.name,
          message: `${def.local_name}.${property.name} property definition is missing`
        });
        continue;
      }
      const expectedDefault = property.default ?? null;
      if (
        actual.perms !== (property.perms ?? "rw") ||
        actual.typeHint !== (property.type ?? null) ||
        stableStringify(actual.defaultValue) !== stableStringify(expectedDefault)
      ) {
        issues.push({
          severity: "warning",
          kind: "property_drift",
          object: def.local_name,
          property: property.name,
        message: `${def.local_name}.${property.name} property definition differs from manifest`,
          expected: { perms: property.perms ?? "rw", type_hint: property.type ?? null, default: expectedDefault } as WooValue,
          actual: { perms: actual.perms, type_hint: actual.typeHint ?? null, default: actual.defaultValue } as WooValue
        });
      }
    }

    for (const verb of def.verbs ?? []) {
      const actual = world.ownVerbExact(def.local_name, verb.name);
      if (!actual) {
        issues.push({
          severity: "warning",
          kind: "missing_verb",
          object: def.local_name,
          verb: verb.name,
          message: `${def.local_name}:${verb.name} verb is missing`
        });
        continue;
      }
      try {
        const expected = compileCatalogVerbDef(def.local_name, verb, owner, actual.version, allowImplementationHints);
        const drift = catalogVerbDrift(actual, expected);
        if (drift.length > 0) {
          issues.push({
            severity: "warning",
            kind: "verb_drift",
            object: def.local_name,
            verb: verb.name,
            message: `${def.local_name}:${verb.name} differs from manifest (${drift.join(", ")})`,
            expected: catalogVerbSummary(expected),
            actual: catalogVerbSummary(actual)
          });
        }
      } catch (err) {
        issues.push(catalogStatusErrorIssue("verb_compile_error", def.local_name, err, verb.name));
      }
    }
  }

  for (const hook of manifest.seed_hooks ?? []) {
    if (hook.kind === "create_instance") {
      if (!world.objects.has(hook.as)) {
        issues.push({
          severity: "warning",
          kind: "missing_seed",
          object: hook.as,
          message: `catalog seed object is missing: ${hook.as}`
        });
        continue;
      }
      try {
        const expectedParent = resolveObjectRef(world, hook.class, localObjects, localSeeds, records);
        const actualParent = world.object(hook.as).parent;
        if (actualParent !== expectedParent) {
          issues.push({
            severity: "warning",
            kind: "seed_parent_drift",
            object: hook.as,
            message: `${hook.as} parent differs from seed hook`,
            expected: expectedParent,
            actual: actualParent
          });
        }
      } catch (err) {
        issues.push(catalogStatusErrorIssue("unresolved_seed_parent", hook.as, err));
      }
      continue;
    }
    if (hook.kind === "attach_feature") {
      const consumer = resolveMaybeObjectRef(world, hook.consumer, localObjects, localSeeds, records);
      const feature = resolveMaybeObjectRef(world, hook.feature, localObjects, localSeeds, records);
      if (consumer && feature && !featureListValue(world.propOrNull(consumer, "features")).includes(feature)) {
        issues.push({
          severity: "warning",
          kind: "feature_drift",
          object: consumer,
          message: `${consumer} is missing feature ${feature}`,
          expected: feature
        });
      }
      continue;
    }
    if (hook.kind === "set_property") {
      const object = resolveMaybeObjectRef(world, hook.object, localObjects, localSeeds, records);
      if (object) {
        const actual = world.propOrNull(object, hook.property);
        const expected = resolveCatalogValue(world, hook.value, localObjects, localSeeds, records);
        if (!seedPropertySatisfied(actual, expected, hook.mode ?? "set")) {
          issues.push({
            severity: "warning",
            kind: "seed_property_drift",
            object,
            property: hook.property,
            message: `${object}.${hook.property} differs from seed hook`,
            expected,
            actual
          });
        }
      }
      continue;
    }
    const object = resolveMaybeObjectRef(world, hook.object, localObjects, localSeeds, records);
    const parent = resolveMaybeObjectRef(world, hook.parent, localObjects, localSeeds, records);
    if (object && parent && world.object(object).parent !== parent) {
      issues.push({
        severity: "warning",
        kind: "seed_parent_drift",
        object,
        message: `${object} parent differs from seed hook`,
        expected: parent,
        actual: world.object(object).parent
      });
    }
  }

  return {
    tap,
    catalog: manifest.name,
    alias,
    installed: record !== null,
    manifest_version: manifest.version,
    installed_version: record?.version ?? null,
    version_match: record?.version === manifest.version,
    needs_repair: issues.some((issue) => issue.kind !== "not_installed"),
    issues
  };
}

export function installCatalogManifest(world: WooWorld, manifest: CatalogManifest, options: InstallCatalogOptions = {}): InstalledCatalogRecord {
  const actor = options.actor ?? "$wiz";
  const tap = options.tap ?? "@local";
  const alias = options.alias ?? manifest.name;
  const allowImplementationHints = options.allowImplementationHints ?? tap === "@local";
  const provenance = options.provenance ?? {
    tap,
    catalog: manifest.name,
    alias,
    ref_requested: tap === "@local" ? "@local" : "unversioned",
    ref_resolved_sha: "unversioned"
  };
  const existing = installedCatalogs(world);
  assertCatalogInstallNameAvailable(world, manifest, tap, alias, provenance, existing, options.adoptExisting === true);
  assertDependenciesInstalled(manifest, existing);

  const localObjects = new Map<string, ObjRef>();
  const localSeeds = new Map<string, ObjRef>();
  const objectDefs = [...(manifest.classes ?? []), ...(manifest.features ?? [])];
  for (const def of objectDefs) localObjects.set(def.local_name, def.local_name);
  const manifestDefs = new Map<string, CatalogObjectDef>(objectDefs.map((def) => [def.local_name, def]));
  for (const def of objectDefs) validateWritabilityTiers(def, world, manifestDefs);

  for (const def of objectDefs) {
    const id = def.local_name;
    const parent = resolveObjectRef(world, def.parent, localObjects, localSeeds, existing);
    world.createObject({ id, name: id, parent, owner: actor });
    setDescriptionIfEmpty(world, id, catalogDescription(def.description, id, manifest.name));
    for (const property of def.properties ?? []) installProperty(world, id, property, actor);
    persistWritabilityTiers(world, id, def, actor);
    for (const verb of def.verbs ?? []) installVerbDef(world, id, verb, actor, allowImplementationHints, false);
  }

  for (const schema of manifest.schemas ?? []) {
    const on = resolveObjectRef(world, schema.on, localObjects, localSeeds, existing);
    world.defineEventSchema(on, schema.type, schema.shape);
  }

  for (const hook of manifest.seed_hooks ?? []) {
    if (hook.kind === "create_instance") {
      const id = hook.as;
      const parent = resolveObjectRef(world, hook.class, localObjects, localSeeds, existing);
      const anchor = hook.anchor ? resolveObjectRef(world, hook.anchor, localObjects, localSeeds, existing) : null;
      const location = hook.location ? resolveObjectRef(world, hook.location, localObjects, localSeeds, existing) : null;
      world.createObject({ id, name: hook.name ?? id, parent, owner: actor, anchor, location });
      localSeeds.set(hook.as, id);
      setDescriptionIfEmpty(world, id, catalogDescription(hook.description, hook.name ?? id, manifest.name));
      setNameIfMissing(world, id, hook.name ?? id);
      for (const [name, value] of Object.entries(hook.properties ?? {})) setPropIfMissing(world, id, name, resolveCatalogValue(world, value, localObjects, localSeeds, existing));
      continue;
    }
    if (hook.kind === "change_parent") {
      const object = resolveObjectRef(world, hook.object, localObjects, localSeeds, existing);
      const parent = resolveObjectRef(world, hook.parent, localObjects, localSeeds, existing);
      world.chparentAuthoredObject(actor, object, parent);
      continue;
    }
    if (hook.kind === "set_property") {
      applySeedProperty(world, hook, localObjects, localSeeds, existing);
      continue;
    }
    const consumer = resolveObjectRef(world, hook.consumer, localObjects, localSeeds, existing);
    const feature = resolveObjectRef(world, hook.feature, localObjects, localSeeds, existing);
    attachFeature(world, consumer, feature);
  }
  populateSeedExitAliasMaps(world, manifest, localSeeds);

  const record: InstalledCatalogRecord = {
    tap,
    catalog: manifest.name,
    alias,
    version: manifest.version,
    installed_at: Date.now(),
    owner: actor,
    objects: Object.fromEntries(localObjects),
    seeds: Object.fromEntries(localSeeds),
    provenance
  };
  recordCatalogInstall(world, record);
  return record;
}

export function repairCatalogManifest(world: WooWorld, manifest: CatalogManifest, options: RepairCatalogOptions = {}): void {
  const plan = planCatalogSchemaMigration(world, manifest, { ...options, scope: "gateway", host: "world" });
  const result = applyCatalogSchemaPlan(world, manifest, plan, options);
  if (result.status === "failed") throw wooError(result.error?.code ?? "E_CATALOG", result.error?.message ?? `catalog schema plan failed: ${plan.id}`, result.error?.value);
}

export function planCatalogSchemaMigration(world: WooWorld, manifest: CatalogManifest, options: CatalogSchemaPlanOptions = {}): CatalogSchemaPlan {
  const scope = options.scope ?? "gateway";
  const host = options.host ?? (scope === "gateway" ? "world" : "host");
  const allowImplementationHints = options.allowImplementationHints ?? false;
  const reconcileSeedHooks = options.reconcileSeedHooks ?? false;
  const skipMissingSeedHooks = options.skipMissingSeedHooks ?? scope === "host";
  const rehomeNowhereSeedObjects = options.rehomeNowhereSeedObjects ?? false;
  const reconcileClassVerbs = options.reconcileClassVerbs ?? false;
  const manifestHash = catalogManifestHash(manifest);
  const existing = installedCatalogs(world);
  const localObjects = new Map<string, ObjRef>();
  const localSeeds = new Map<string, ObjRef>();
  const objectDefs = [...(manifest.classes ?? []), ...(manifest.features ?? [])];
  for (const def of objectDefs) localObjects.set(def.local_name, def.local_name);
  const planManifestDefs = new Map<string, CatalogObjectDef>(objectDefs.map((def) => [def.local_name, def]));
  for (const def of objectDefs) validateWritabilityTiers(def, world, planManifestDefs);
  const steps: CatalogSchemaPlanStep[] = [];

  for (const def of objectDefs) {
    if (scope === "host" && !world.objects.has(def.local_name)) continue;
    steps.push({ id: `${steps.length + 1}:ensure_object:${def.local_name}`, kind: "ensure_object", object: def.local_name, def });
    for (const property of def.properties ?? []) {
      steps.push({ id: `${steps.length + 1}:ensure_property_def:${def.local_name}.${property.name}`, kind: "ensure_property_def", object: def.local_name, property });
    }
    for (const verb of def.verbs ?? []) {
      steps.push({ id: `${steps.length + 1}:ensure_verb:${def.local_name}:${verb.name}`, kind: "ensure_verb", object: def.local_name, verb });
    }
    if (reconcileClassVerbs) {
      steps.push({ id: `${steps.length + 1}:drop_stale_verbs:${def.local_name}`, kind: "drop_stale_verbs", object: def.local_name, keep: (def.verbs ?? []).map((verb) => verb.name) });
    }
  }
  for (const schema of manifest.schemas ?? []) {
    const object = resolveMaybeObjectRef(world, schema.on, localObjects, localSeeds, existing);
    if (object) steps.push({ id: `${steps.length + 1}:ensure_event_schema:${object}:${schema.type}`, kind: "ensure_event_schema", object, schema });
  }
  for (const hook of manifest.seed_hooks ?? []) {
    if (hook.kind === "create_instance") {
      const id = hook.as;
      if (world.objects.has(id)) {
        if (reconcileSeedHooks) steps.push({ id: `${steps.length + 1}:reconcile_seed_object:${id}`, kind: "reconcile_seed_object", object: id, hook });
        steps.push({ id: `${steps.length + 1}:seed_property_defaults:${id}`, kind: "seed_property_defaults", object: id, hook });
        steps.push({ id: `${steps.length + 1}:sync_exit_aliases:${id}`, kind: "sync_exit_aliases", object: id });
      } else if (!skipMissingSeedHooks && scope === "gateway") {
        steps.push({ id: `${steps.length + 1}:ensure_seed_object:${id}`, kind: "ensure_seed_object", object: id, hook });
        steps.push({ id: `${steps.length + 1}:seed_property_defaults:${id}`, kind: "seed_property_defaults", object: id, hook });
        steps.push({ id: `${steps.length + 1}:sync_exit_aliases:${id}`, kind: "sync_exit_aliases", object: id });
      }
      localSeeds.set(hook.as, id);
      continue;
    }
    if (hook.kind === "change_parent") {
      const object = resolveMaybeObjectRef(world, hook.object, localObjects, localSeeds, existing);
      const parent = resolveMaybeObjectRef(world, hook.parent, localObjects, localSeeds, existing);
      if (object && parent) steps.push({ id: `${steps.length + 1}:change_parent:${object}->${parent}`, kind: "change_parent", object, hook });
      continue;
    }
    if (hook.kind === "set_property") {
      const object = resolveMaybeObjectRef(world, hook.object, localObjects, localSeeds, existing);
      if (object) steps.push({ id: `${steps.length + 1}:set_property:${object}.${hook.property}`, kind: "set_property", object, hook });
      continue;
    }
    const consumer = resolveMaybeObjectRef(world, hook.consumer, localObjects, localSeeds, existing);
    const feature = resolveMaybeObjectRef(world, hook.feature, localObjects, localSeeds, existing);
    if (consumer && feature) steps.push({ id: `${steps.length + 1}:attach_feature:${consumer}+${feature}`, kind: "attach_feature", consumer, feature, hook });
  }
  return {
    id: `local-catalog-schema:${manifest.name}:${manifestHash.slice(0, 16)}`,
    catalog: manifest.name,
    version: manifest.version,
    manifest_hash: `sha256:${manifestHash}`,
    scope,
    host,
    options: {
      allow_implementation_hints: allowImplementationHints,
      reconcile_seed_hooks: reconcileSeedHooks,
      skip_missing_seed_hooks: skipMissingSeedHooks,
      rehome_nowhere_seed_objects: rehomeNowhereSeedObjects,
      reconcile_class_verbs: reconcileClassVerbs
    },
    steps
  };
}

export function applyCatalogSchemaPlan(world: WooWorld, manifest: CatalogManifest, plan: CatalogSchemaPlan, options: CatalogSchemaPlanOptions = {}): CatalogSchemaPlanApplyResult {
  const actor = options.actor ?? "$wiz";
  const allowImplementationHints = options.allowImplementationHints ?? plan.options.allow_implementation_hints;
  const rehomeNowhereSeedObjects = options.rehomeNowhereSeedObjects ?? plan.options.rehome_nowhere_seed_objects;
  const existing = installedCatalogs(world);
  const localObjects = new Map<string, ObjRef>();
  const localSeeds = new Map<string, ObjRef>();
  const objectDefs = [...(manifest.classes ?? []), ...(manifest.features ?? [])];
  for (const def of objectDefs) localObjects.set(def.local_name, def.local_name);
  for (const hook of manifest.seed_hooks ?? []) {
    if (hook.kind === "create_instance") localSeeds.set(hook.as, hook.as);
  }
  const startedAt = Date.now();
  const stepResults: CatalogSchemaPlanStepResult[] = [];
  let failed: ErrorValue | undefined;

  for (const step of plan.steps) {
    try {
      world.withMutationSavepoint(() => {
        applyCatalogSchemaPlanStep(world, manifest, step, {
          actor,
          allowImplementationHints,
          rehomeNowhereSeedObjects,
          localObjects,
          localSeeds,
          existing
        });
      });
      stepResults.push({ id: step.id, kind: step.kind, target: catalogSchemaStepTarget(step), status: "applied" });
    } catch (err) {
      failed = errorValue(err);
      stepResults.push({ id: step.id, kind: step.kind, target: catalogSchemaStepTarget(step), status: "failed", error: failed });
      break;
    }
  }

  const issues = failed ? [] : verifyCatalogSchemaPlan(world, manifest, plan);
  const completedAt = Date.now();
  return {
    status: failed || issues.length > 0 ? "failed" : "completed",
    plan_id: plan.id,
    catalog: plan.catalog,
    version: plan.version,
    manifest_hash: plan.manifest_hash,
    scope: plan.scope,
    host: plan.host,
    started_at: startedAt,
    completed_at: completedAt,
    steps: stepResults,
    issues,
    error: failed ?? (issues.length > 0 ? { code: "E_CATALOG", message: `catalog schema plan postcondition failed: ${plan.id}`, value: issues as unknown as WooValue } : undefined)
  };
}

export function verifyCatalogSchemaPlan(world: WooWorld, manifest: CatalogManifest, plan: CatalogSchemaPlan): CatalogStatusIssue[] {
  const status = catalogManifestStatus(world, manifest, {
    tap: "@local",
    alias: manifest.name,
    actor: "$wiz",
    allowImplementationHints: plan.options.allow_implementation_hints
  });
  const plannedObjects = new Set<ObjRef>();
  const plannedVerbs = new Set<string>();
  const plannedProperties = new Set<string>();
  const plannedSchemas = new Set<string>();
  const planSpecificIssues: CatalogStatusIssue[] = [];
  const existing = installedCatalogs(world);
  const localObjects = new Map<string, ObjRef>();
  const localSeeds = new Map<string, ObjRef>();
  for (const def of [...(manifest.classes ?? []), ...(manifest.features ?? [])]) localObjects.set(def.local_name, def.local_name);
  for (const hook of manifest.seed_hooks ?? []) {
    if (hook.kind === "create_instance") localSeeds.set(hook.as, hook.as);
  }
  for (const step of plan.steps) {
    if ("object" in step) plannedObjects.add(step.object);
    if (step.kind === "ensure_verb") plannedVerbs.add(`${step.object}:${step.verb.name}`);
    if (step.kind === "ensure_property_def") plannedProperties.add(`${step.object}.${step.property.name}`);
    if (step.kind === "ensure_event_schema") plannedSchemas.add(`${step.object}:${step.schema.type}`);
    if (step.kind === "attach_feature") plannedObjects.add(step.consumer);
    if (step.kind === "drop_stale_verbs" && world.objects.has(step.object)) {
      const keep = new Set(step.keep);
      for (const verb of world.object(step.object).verbs) {
        if (!keep.has(verb.name)) {
          planSpecificIssues.push({
            severity: "warning",
            kind: "stale_verb",
            object: step.object,
            verb: verb.name,
            message: `${step.object}:${verb.name} is not declared by catalog ${manifest.name}`
          });
        }
      }
    }
    if ((step.kind === "ensure_seed_object" || step.kind === "reconcile_seed_object") && plan.options.rehome_nowhere_seed_objects && world.objects.has(step.object) && step.hook.location) {
      const expectedLocation = resolveMaybeObjectRef(world, step.hook.location, localObjects, localSeeds, existing);
      const actualLocation = world.object(step.object).location;
      if (expectedLocation && actualLocation === "$nowhere" && expectedLocation !== "$nowhere") {
        planSpecificIssues.push({
          severity: "warning",
          kind: "seed_location_drift",
          object: step.object,
          message: `${step.object} is stranded in $nowhere instead of ${expectedLocation}`,
          expected: expectedLocation,
          actual: actualLocation
        });
      }
    }
  }
  if (plan.scope === "gateway") {
    return [
      ...status.issues.filter((issue) => issue.kind !== "version_mismatch" && issue.kind !== "not_installed"),
      ...planSpecificIssues
    ];
  }
  const filtered = status.issues.filter((issue) => {
    if (issue.kind === "version_mismatch" || issue.kind === "not_installed") return false;
    if (issue.verb && issue.object) return plannedVerbs.has(`${issue.object}:${issue.verb}`);
    if (issue.property && issue.object) return plannedProperties.has(`${issue.object}.${issue.property}`);
    if (issue.kind === "missing_object" || issue.kind === "parent_drift") return issue.object ? plannedObjects.has(issue.object) : false;
    if (issue.kind === "missing_seed" || issue.kind === "seed_parent_drift" || issue.kind === "seed_property_drift") return issue.object ? plannedObjects.has(issue.object) : false;
    if (issue.kind === "feature_drift") return issue.object ? plannedObjects.has(issue.object) : false;
    if (issue.kind === "missing_schema" && issue.object && typeof issue.expected === "string") return plannedSchemas.has(`${issue.object}:${issue.expected}`);
    return issue.object ? plannedObjects.has(issue.object) : false;
  });
  return [...filtered, ...planSpecificIssues];
}

export function updateCatalogManifest(world: WooWorld, manifest: CatalogManifest, options: UpdateCatalogOptions = {}): InstalledCatalogRecord {
  const actor = options.actor ?? "$wiz";
  const tap = options.tap ?? "@local";
  const alias = options.alias ?? manifest.name;
  const allowImplementationHints = options.allowImplementationHints ?? tap === "@local";
  const records = installedCatalogs(world);
  const current = records.find((record) => record.alias === alias || (record.tap === tap && record.catalog === manifest.name));
  if (!current) throw wooError("E_CATALOG", `catalog is not installed: ${tap}:${manifest.name} as ${alias}`, { tap, catalog: manifest.name, alias });
  assertDependenciesInstalled(manifest, records);

  const version = compareCatalogVersions(current.version, manifest.version);
  if (version.order < 0) throw wooError("E_CATALOG", `catalog downgrades are not supported: ${current.version} -> ${manifest.version}`, { from: current.version, to: manifest.version });
  if (version.majorChanged && options.acceptMajor !== true) {
    throw wooError("E_CATALOG", `catalog major update requires accept_major: true: ${current.version} -> ${manifest.version}`, { from: current.version, to: manifest.version });
  }
  if (version.majorChanged && !options.migration) {
    throw wooError("E_CATALOG", `catalog major update requires a migration manifest: ${current.version} -> ${manifest.version}`, { from: current.version, to: manifest.version });
  }
  if (options.migration) validateCatalogMigration(current, manifest, options.migration);

  repairCatalogManifest(world, manifest, {
    actor,
    allowImplementationHints,
    reconcileSeedHooks: true
  });

  const migrationState = options.migration
    ? runCatalogMigration(world, current, manifest, options.migration, records)
    : {
        status: "not_required" as const,
        from_version: current.version,
        to_version: manifest.version,
        completed_steps: [],
        updated_at: Date.now()
      };

  const provenance = options.provenance ?? {
    tap,
    catalog: manifest.name,
    alias,
    ref_requested: tap === "@local" ? "@local" : "unversioned",
    ref_resolved_sha: "unversioned"
  };
  const record: InstalledCatalogRecord = {
    ...current,
    tap,
    catalog: manifest.name,
    alias,
    version: manifest.version,
    updated_at: Date.now(),
    owner: actor,
    objects: { ...current.objects, ...manifestObjectRefs(manifest) },
    seeds: { ...current.seeds, ...manifestSeedRefs(manifest) },
    provenance,
    migration_state: migrationState
  };
  recordCatalogInstall(world, record);
  return record;
}

function catalogManifestHash(manifest: CatalogManifest): string {
  return hashSource(stableStringify(manifest));
}

// Plan id and manifest hash derivation are a function only of (manifest name,
// manifest content) so callers can ask whether a plan id has already been
// recorded without paying the cost of building the full plan.steps list.
export function catalogSchemaPlanIdentity(manifest: CatalogManifest): { id: string; manifest_hash: string } {
  const hash = catalogManifestHash(manifest);
  return {
    id: `local-catalog-schema:${manifest.name}:${hash.slice(0, 16)}`,
    manifest_hash: `sha256:${hash}`
  };
}

function applyCatalogSchemaPlanStep(
  world: WooWorld,
  manifest: CatalogManifest,
  step: CatalogSchemaPlanStep,
  context: {
    actor: ObjRef;
    allowImplementationHints: boolean;
    rehomeNowhereSeedObjects: boolean;
    localObjects: Map<string, ObjRef>;
    localSeeds: Map<string, ObjRef>;
    existing: InstalledCatalogRecord[];
  }
): void {
  switch (step.kind) {
    case "ensure_object": {
      const parent = resolveObjectRef(world, step.def.parent, context.localObjects, context.localSeeds, context.existing);
      if (!world.objects.has(step.object)) world.createObject({ id: step.object, name: step.object, parent, owner: context.actor });
      else if (world.object(step.object).parent !== parent && !world.isDescendantOf(parent, step.object)) {
        world.chparentAuthoredObject(context.actor, step.object, parent);
      }
      setDescriptionIfEmpty(world, step.object, catalogDescription(step.def.description, step.object, manifest.name));
      persistWritabilityTiers(world, step.object, step.def, context.actor);
      return;
    }
    case "ensure_property_def":
      upsertPropertyDef(world, step.object, step.property, context.actor);
      return;
    case "ensure_verb":
      installVerbDef(world, step.object, step.verb, context.actor, context.allowImplementationHints, true);
      return;
    case "drop_stale_verbs":
      dropStaleOwnVerbs(world, step.object, new Set(step.keep));
      return;
    case "ensure_event_schema": {
      const on = resolveObjectRef(world, step.schema.on, context.localObjects, context.localSeeds, context.existing);
      if (world.objects.has(on)) world.defineEventSchema(on, step.schema.type, step.schema.shape);
      return;
    }
    case "ensure_seed_object": {
      if (!world.objects.has(step.object)) {
        const parent = resolveObjectRef(world, step.hook.class, context.localObjects, context.localSeeds, context.existing);
        const anchor = step.hook.anchor ? resolveObjectRef(world, step.hook.anchor, context.localObjects, context.localSeeds, context.existing) : null;
        const location = step.hook.location ? resolveObjectRef(world, step.hook.location, context.localObjects, context.localSeeds, context.existing) : null;
        world.createObject({ id: step.object, name: step.hook.name ?? step.object, parent, owner: context.actor, anchor, location });
      }
      reconcileSeedObject(world, step.object, step.hook, manifest, context.actor, context.localObjects, context.localSeeds, context.existing, context.rehomeNowhereSeedObjects);
      return;
    }
    case "reconcile_seed_object":
      reconcileSeedObject(world, step.object, step.hook, manifest, context.actor, context.localObjects, context.localSeeds, context.existing, context.rehomeNowhereSeedObjects);
      return;
    case "seed_property_defaults":
      setDescriptionIfEmpty(world, step.object, catalogDescription(step.hook.description, step.hook.name ?? step.object, manifest.name));
      setNameIfMissing(world, step.object, step.hook.name ?? step.object);
      for (const [name, value] of Object.entries(step.hook.properties ?? {})) {
        setPropIfMissing(world, step.object, name, resolveCatalogValue(world, value, context.localObjects, context.localSeeds, context.existing));
      }
      return;
    case "change_parent": {
      const object = resolveObjectRef(world, step.hook.object, context.localObjects, context.localSeeds, context.existing);
      const parent = resolveObjectRef(world, step.hook.parent, context.localObjects, context.localSeeds, context.existing);
      if (world.objects.has(object) && world.objects.has(parent) && world.object(object).parent !== parent && !world.isDescendantOf(parent, object)) {
        world.chparentAuthoredObject(context.actor, object, parent);
      }
      return;
    }
    case "set_property":
      applySeedProperty(world, step.hook, context.localObjects, context.localSeeds, context.existing);
      return;
    case "attach_feature":
      attachFeature(world, step.consumer, step.feature);
      return;
    case "sync_exit_aliases":
      populateExitAliasMap(world, step.object);
      return;
  }
}

function upsertPropertyDef(world: WooWorld, obj: ObjRef, property: CatalogPropertyDef, owner: ObjRef): void {
  const target = world.object(obj);
  const expectedDefault = property.default ?? null;
  const existing = target.propertyDefs.get(property.name);
  if (
    existing &&
    existing.owner === owner &&
    existing.perms === (property.perms ?? "rw") &&
    (existing.typeHint ?? null) === (property.type ?? null) &&
    stableStringify(existing.defaultValue) === stableStringify(expectedDefault)
  ) return;
  world.defineProperty(obj, {
    name: property.name,
    defaultValue: expectedDefault,
    typeHint: property.type,
    owner,
    perms: property.perms ?? "rw",
    version: existing ? existing.version + 1 : 1
  });
}

function catalogSchemaStepTarget(step: CatalogSchemaPlanStep): string {
  switch (step.kind) {
    case "ensure_object":
    case "drop_stale_verbs":
    case "ensure_seed_object":
    case "reconcile_seed_object":
    case "seed_property_defaults":
    case "sync_exit_aliases":
      return step.object;
    case "ensure_property_def":
      return `${step.object}.${step.property.name}`;
    case "ensure_verb":
      return `${step.object}:${step.verb.name}`;
    case "ensure_event_schema":
      return `${step.object}:${step.schema.type}`;
    case "change_parent":
      return `${step.object}->${step.hook.parent}`;
    case "set_property":
      return `${step.object}.${step.hook.property}`;
    case "attach_feature":
      return `${step.consumer}+${step.feature}`;
  }
}

function reconcileSeedObject(
  world: WooWorld,
  id: ObjRef,
  hook: Extract<CatalogSeedHook, { kind: "create_instance" }>,
  manifest: CatalogManifest,
  actor: ObjRef,
  localObjects: Map<string, ObjRef>,
  localSeeds: Map<string, ObjRef>,
  existing: InstalledCatalogRecord[],
  rehomeNowhereSeedObjects: boolean
): void {
  const obj = world.object(id);
  const parent = resolveObjectRef(world, hook.class, localObjects, localSeeds, existing);
  const anchor = hook.anchor ? resolveObjectRef(world, hook.anchor, localObjects, localSeeds, existing) : null;
  const location = hook.location ? resolveObjectRef(world, hook.location, localObjects, localSeeds, existing) : null;
  if (obj.parent !== parent) {
    if (obj.parent && world.objects.has(obj.parent)) world.object(obj.parent).children.delete(id);
    obj.parent = parent;
    world.object(parent).children.add(id);
  }
  if (obj.owner !== actor) obj.owner = actor;
  obj.anchor = anchor;
  if (hook.name) {
    obj.name = hook.name;
    world.setProp(id, "name", hook.name);
  }
  if (hook.description) world.setProp(id, "description", catalogDescription(hook.description, hook.name ?? id, manifest.name));
  // Seed-hook properties are *initial* values — they bootstrap a fresh seed.
  // The unconditional set_if_missing path at the repair call site (line 510)
  // already handles "manifest added a new property; existing seed lacks it".
  // Anything beyond that, including the DYNAMIC_SEED_PROPERTIES list, would
  // overwrite live runtime state (next_z, layout, tempo, transport, exits...)
  // on every host's cold init, which silently wipes user data.
  for (const [name, value] of Object.entries(hook.properties ?? {})) {
    if (obj.properties.has(name)) continue;
    world.setProp(id, name, resolveCatalogValue(world, value, localObjects, localSeeds, existing));
  }
  const strandedInNowhere = rehomeNowhereSeedObjects && obj.location === "$nowhere" && location !== null && location !== "$nowhere";
  if (obj.location !== location && (!obj.location || !world.objects.has(obj.location) || strandedInNowhere)) {
    if (obj.location && world.objects.has(obj.location)) world.object(obj.location).contents.delete(id);
    obj.location = location;
    if (location && world.objects.has(location)) world.object(location).contents.add(id);
  } else if (obj.location && world.objects.has(obj.location)) {
    world.object(obj.location).contents.add(id);
  }
  obj.modified = Date.now();
  world.persist();
}

function populateSeedExitAliasMaps(world: WooWorld, manifest: CatalogManifest, localSeeds: Map<string, ObjRef>): void {
  for (const hook of manifest.seed_hooks ?? []) {
    if (hook.kind !== "create_instance") continue;
    const id = localSeeds.get(hook.as) ?? hook.as;
    if (world.objects.has(id)) populateExitAliasMap(world, id);
  }
}

function populateExitAliasMap(world: WooWorld, exitRef: ObjRef): void {
  const source = world.propOrNull(exitRef, "source");
  const exits = typeof source === "string" && world.objects.has(source) ? world.propOrNull(source, "exits") : null;
  const aliases = world.propOrNull(exitRef, "aliases");
  if (typeof source !== "string" || !isStringMap(exits)) return;

  const keys = new Set<string>();
  addAliasKey(keys, world.object(exitRef).name);
  addAliasKey(keys, world.propOrNull(exitRef, "name"));
  if (Array.isArray(aliases)) {
    for (const alias of aliases) addAliasKey(keys, alias);
  }
  if (keys.size === 0) return;

  const next: Record<string, WooValue> = { ...exits };
  let changed = false;
  for (const key of keys) {
    const existing = next[key];
    if (existing === undefined) {
      next[key] = exitRef;
      changed = true;
    } else if (existing !== exitRef) {
      // Stale or duplicate exits map can have an alias pointing at a
      // different exit object than the manifest says. Throwing aborts the
      // entire catalog repair and crashes cold init. The manifest is the
      // authoritative source for catalog seeds, so overwrite the stale entry
      // and warn — gives the world a path back to a consistent state without
      // bricking healthz on every request.
      console.warn("woo.exit_alias_overwrite", {
        source,
        alias: key,
        existing,
        exit: exitRef
      });
      next[key] = exitRef;
      changed = true;
      continue;
    }
  }
  if (changed) world.setProp(source, "exits", next);
}

function addAliasKey(keys: Set<string>, value: WooValue): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed) keys.add(trimmed);
}

function isStringMap(value: WooValue): value is Record<string, WooValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function installProperty(world: WooWorld, obj: ObjRef, property: CatalogPropertyDef, owner: ObjRef): void {
  const target = world.object(obj);
  if (target.propertyDefs.has(property.name)) return;
  world.defineProperty(obj, {
    name: property.name,
    defaultValue: property.default ?? null,
    typeHint: property.type,
    owner,
    perms: property.perms ?? "rw"
  });
}

function installVerbDef(world: WooWorld, obj: ObjRef, def: CatalogVerbDef, owner: ObjRef, allowImplementationHints: boolean, repairExisting: boolean): void {
  world.object(obj);
  const existing = world.ownVerbExact(obj, def.name);
  if (existing) {
    if (!repairExisting) {
      const parsedPerms = normalizeVerbPerms(def.perms ?? existing.perms, existing.direct_callable || def.direct_callable === true);
      const next = {
        ...existing,
        perms: parsedPerms.perms,
        direct_callable: parsedPerms.directCallable,
        skip_presence_check: existing.skip_presence_check || def.skip_presence_check === true,
        tool_exposed: existing.tool_exposed || def.tool_exposed === true
      };
      if (
        next.perms !== existing.perms ||
        next.direct_callable !== existing.direct_callable ||
        next.skip_presence_check !== existing.skip_presence_check ||
        next.tool_exposed !== existing.tool_exposed
      ) world.addVerb(obj, next);
      return;
    }
    const repaired = compileCatalogVerbDef(obj, def, owner, existing.version + 1, allowImplementationHints);
    const changed =
      existing.kind !== repaired.kind ||
      (existing.kind === "native" && repaired.kind === "native" && existing.native !== repaired.native) ||
      existing.source !== repaired.source ||
      existing.source_hash !== repaired.source_hash ||
      JSON.stringify(existing.aliases ?? []) !== JSON.stringify(repaired.aliases ?? []) ||
      existing.perms !== repaired.perms ||
      JSON.stringify(existing.arg_spec ?? {}) !== JSON.stringify(repaired.arg_spec ?? {}) ||
      existing.direct_callable !== repaired.direct_callable ||
      existing.skip_presence_check !== repaired.skip_presence_check ||
      existing.tool_exposed !== repaired.tool_exposed ||
      (repaired.kind !== "native" && Object.keys(existing.line_map ?? {}).length === 0);
    if (changed) world.addVerb(obj, repaired);
    return;
  }

  world.addVerb(obj, compileCatalogVerbDef(obj, def, owner, 1, allowImplementationHints));
}

function dropStaleOwnVerbs(world: WooWorld, objRef: ObjRef, manifestVerbNames: Set<string>): void {
  const obj = world.object(objRef);
  const next = obj.verbs.filter((verb) => manifestVerbNames.has(verb.name)).map((verb, index) => ({ ...verb, slot: index + 1 }));
  if (next.length === obj.verbs.length) return;
  obj.verbs = next;
  touchObject(world, objRef);
}

function compileCatalogVerbDef(obj: ObjRef, def: CatalogVerbDef, owner: ObjRef, version: number, allowImplementationHints: boolean): VerbDef {
  const parsedPerms = normalizeVerbPerms(def.perms ?? "rx", def.direct_callable === true);
  const argSpec = catalogVerbArgSpec(def);
  const base = {
    name: def.name,
    aliases: def.aliases ?? [],
    owner,
    perms: parsedPerms.perms,
    arg_spec: argSpec,
    source: def.source,
    source_hash: hashSource(def.source),
    version,
    line_map: {},
    direct_callable: parsedPerms.directCallable,
    skip_presence_check: def.skip_presence_check === true,
    tool_exposed: def.tool_exposed === true
  };

  if (allowImplementationHints && def.implementation?.kind === "native") {
    return { ...base, kind: "native", native: def.implementation.handler };
  }

  if (allowImplementationHints && def.implementation?.kind === "fixture") {
    const bytecode = fixtureByName[def.implementation.name] as TinyBytecode | undefined;
    if (!bytecode) throw wooError("E_CATALOG", `unknown fixture implementation: ${def.implementation.name}`);
    return { ...base, kind: "bytecode", bytecode: { ...bytecode, version } };
  }

  return compileCatalogVerb(obj, def, owner, version);
}

function compileCatalogVerb(obj: ObjRef, def: CatalogVerbDef, owner: ObjRef, version: number): VerbDef {
  const compiled = compileVerb(def.source);
  if (!compiled.ok || !compiled.bytecode) {
    throw wooError("E_CATALOG", `catalog verb failed to compile: ${obj}:${def.name}`, {
      diagnostics: compiled.diagnostics as unknown as WooValue
    });
  }
  const parsedPerms = normalizeVerbPerms(def.perms ?? compiled.metadata?.perms ?? "rx", def.direct_callable === true);
  return {
    kind: "bytecode",
    name: def.name,
    aliases: def.aliases ?? [],
    owner,
    perms: parsedPerms.perms,
    arg_spec: catalogVerbArgSpec(def, compiled.metadata?.arg_spec),
    source: def.source,
    source_hash: compiled.source_hash ?? hashSource(def.source),
    version,
    bytecode: { ...compiled.bytecode, version },
    line_map: compiled.line_map ?? {},
    direct_callable: parsedPerms.directCallable,
    skip_presence_check: def.skip_presence_check === true,
    tool_exposed: def.tool_exposed === true
  };
}

function catalogVerbArgSpec(def: CatalogVerbDef, compiledArgSpec: Record<string, WooValue> = {}): Record<string, WooValue> {
  return { ...(def.arg_spec ?? compiledArgSpec) };
}

function resolveObjectRef(
  world: WooWorld,
  ref: string,
  localObjects: Map<string, ObjRef>,
  localSeeds: Map<string, ObjRef>,
  installed: InstalledCatalogRecord[]
): ObjRef {
  if (localObjects.has(ref)) return localObjects.get(ref)!;
  if (localSeeds.has(ref)) return localSeeds.get(ref)!;
  if (world.objects.has(ref)) return ref;
  const split = ref.indexOf(":");
  if (split > 0) {
    const alias = ref.slice(0, split);
    const name = ref.slice(split + 1);
    const record = installed.find((item) => item.alias === alias || item.catalog === alias);
    const resolved = name.startsWith("$") ? record?.objects?.[name] : record?.seeds?.[name];
    if (resolved) return resolved;
    if (world.objects.has(name)) return name;
  }
  throw wooError("E_UNRESOLVED_REFERENCE", `catalog reference could not be resolved: ${ref}`, ref);
}

function resolveCatalogValue(
  world: WooWorld,
  value: WooValue,
  localObjects: Map<string, ObjRef>,
  localSeeds: Map<string, ObjRef>,
  installed: InstalledCatalogRecord[]
): WooValue {
  if (typeof value === "string") {
    try {
      return resolveObjectRef(world, value, localObjects, localSeeds, installed);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((item) => resolveCatalogValue(world, item, localObjects, localSeeds, installed));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveCatalogValue(world, item, localObjects, localSeeds, installed)]));
  }
  return value;
}

function manifestObjectRefs(manifest: CatalogManifest): Record<string, ObjRef> {
  const refs: Record<string, ObjRef> = {};
  for (const def of [...(manifest.classes ?? []), ...(manifest.features ?? [])]) refs[def.local_name] = def.local_name;
  return refs;
}

function manifestSeedRefs(manifest: CatalogManifest): Record<string, ObjRef> {
  const refs: Record<string, ObjRef> = {};
  for (const hook of manifest.seed_hooks ?? []) {
    if (hook.kind === "create_instance") refs[hook.as] = hook.as;
  }
  return refs;
}

function runCatalogMigration(
  world: WooWorld,
  current: InstalledCatalogRecord,
  manifest: CatalogManifest,
  migration: CatalogMigrationManifest,
  installed: InstalledCatalogRecord[]
): CatalogMigrationState {
  validateCatalogMigration(current, manifest, migration);

  const completed_steps: string[] = [];
  const localObjects = new Map(Object.entries({ ...current.objects, ...manifestObjectRefs(manifest) }));
  const localSeeds = new Map(Object.entries({ ...current.seeds, ...manifestSeedRefs(manifest) }));
  for (const [index, step] of migration.steps.entries()) {
    const id = migrationStepId(step, index);
    try {
      world.withMutationSavepoint(() => {
        applyMigrationStep(world, step, localObjects, localSeeds, installed);
      });
      completed_steps.push(id);
    } catch (err) {
      return {
        status: "failed",
        from_version: current.version,
        to_version: manifest.version,
        completed_steps,
        failed_step: id,
        error: errorValue(err),
        updated_at: Date.now()
      };
    }
  }
  return {
    status: "completed",
    from_version: current.version,
    to_version: manifest.version,
    completed_steps,
    updated_at: Date.now()
  };
}

function validateCatalogMigration(current: InstalledCatalogRecord, manifest: CatalogManifest, migration: CatalogMigrationManifest): void {
  if (migration.spec_version !== manifest.spec_version) {
    throw wooError("E_CATALOG", `migration spec_version ${migration.spec_version} does not match manifest ${manifest.spec_version}`);
  }
  if (!versionPatternMatches(migration.from_version, current.version) || !versionPatternMatches(migration.to_version, manifest.version)) {
    throw wooError("E_CATALOG", `migration version range does not match ${current.version} -> ${manifest.version}`, {
      from_version: migration.from_version,
      to_version: migration.to_version
    });
  }
}

function applyMigrationStep(
  world: WooWorld,
  step: CatalogMigrationStep,
  localObjects: Map<string, ObjRef>,
  localSeeds: Map<string, ObjRef>,
  installed: InstalledCatalogRecord[]
): void {
  switch (step.kind) {
    case "rename_property": {
      const classRef = resolveObjectRef(world, step.class, localObjects, localSeeds, installed);
      for (const objRef of classAndDescendants(world, classRef)) renamePropertyLocal(world, objRef, step.from, step.to);
      return;
    }
    case "drop_property": {
      const classRef = resolveObjectRef(world, step.class, localObjects, localSeeds, installed);
      for (const objRef of classAndDescendants(world, classRef)) dropPropertyLocal(world, objRef, step.name);
      return;
    }
    case "add_property": {
      const classRef = resolveObjectRef(world, step.class, localObjects, localSeeds, installed);
      installProperty(world, classRef, { name: step.name, default: step.default ?? null, type: step.type, perms: step.perms }, world.object(classRef).owner);
      return;
    }
    case "rename_verb": {
      const classRef = resolveObjectRef(world, step.class, localObjects, localSeeds, installed);
      renameVerbLocal(world, classRef, step.from, step.to);
      return;
    }
    case "drop_verb": {
      const classRef = resolveObjectRef(world, step.class, localObjects, localSeeds, installed);
      const obj = world.object(classRef);
      obj.verbs = obj.verbs.filter((verb) => verb.name !== step.verb).map((verb, index) => ({ ...verb, slot: index + 1 }));
      touchObject(world, classRef);
      return;
    }
    case "change_parent": {
      const classRef = resolveObjectRef(world, step.class, localObjects, localSeeds, installed);
      const parent = resolveObjectRef(world, step.parent, localObjects, localSeeds, installed);
      world.chparentAuthoredObject(world.object(classRef).owner, classRef, parent);
      return;
    }
    case "rename_class":
      throw wooError("E_NOT_IMPLEMENTED", "catalog rename_class migrations are deferred", step as unknown as WooValue);
    case "transform_property":
      throw wooError("E_NOT_IMPLEMENTED", "catalog transform_property migrations are deferred", step as unknown as WooValue);
    case "custom":
      throw wooError("E_NOT_IMPLEMENTED", "catalog custom migrations are deferred", step as unknown as WooValue);
  }
}

function classAndDescendants(world: WooWorld, classRef: ObjRef): ObjRef[] {
  const refs: ObjRef[] = [];
  const visit = (id: ObjRef): void => {
    refs.push(id);
    for (const child of world.object(id).children) visit(child);
  };
  visit(classRef);
  return refs;
}

function renamePropertyLocal(world: WooWorld, objRef: ObjRef, from: string, to: string): void {
  const obj = world.object(objRef);
  const def = obj.propertyDefs.get(from);
  if (def) {
    if (!obj.propertyDefs.has(to)) obj.propertyDefs.set(to, { ...def, name: to, version: def.version + 1 });
    obj.propertyDefs.delete(from);
  }
  if (obj.properties.has(from)) {
    if (!obj.properties.has(to)) obj.properties.set(to, obj.properties.get(from)!);
    obj.properties.delete(from);
  }
  if (obj.propertyVersions.has(from)) {
    if (!obj.propertyVersions.has(to)) obj.propertyVersions.set(to, obj.propertyVersions.get(from)! + 1);
    obj.propertyVersions.delete(from);
  }
  if (from === "subscribers" || from === "session_subscribers" || to === "subscribers" || to === "session_subscribers") {
    world.invalidatePresenceIndex();
  }
  touchObject(world, objRef);
}

function dropPropertyLocal(world: WooWorld, objRef: ObjRef, name: string): void {
  const obj = world.object(objRef);
  obj.propertyDefs.delete(name);
  obj.properties.delete(name);
  obj.propertyVersions.delete(name);
  if (name === "subscribers" || name === "session_subscribers") {
    world.invalidatePresenceIndex();
  }
  touchObject(world, objRef);
}

function renameVerbLocal(world: WooWorld, objRef: ObjRef, from: string, to: string): void {
  const obj = world.object(objRef);
  const index = obj.verbs.findIndex((verb) => verb.name === from);
  const verb = index >= 0 ? obj.verbs[index] : null;
  if (!verb) return;
  if (!obj.verbs.some((item) => item.name === to)) {
    obj.verbs[index] = { ...verb, name: to, version: verb.version + 1 };
  } else {
    obj.verbs.splice(index, 1);
  }
  obj.verbs = obj.verbs.map((item, slotIndex) => ({ ...item, slot: slotIndex + 1 }));
  touchObject(world, objRef);
}

function touchObject(world: WooWorld, objRef: ObjRef): void {
  world.object(objRef).modified = Date.now();
  world.persist();
}

function migrationStepId(step: CatalogMigrationStep, index: number): string {
  switch (step.kind) {
    case "rename_property":
      return `${index + 1}:rename_property:${step.class}.${step.from}->${step.to}`;
    case "drop_property":
      return `${index + 1}:drop_property:${step.class}.${step.name}`;
    case "add_property":
      return `${index + 1}:add_property:${step.class}.${step.name}`;
    case "rename_verb":
      return `${index + 1}:rename_verb:${step.class}:${step.from}->${step.to}`;
    case "drop_verb":
      return `${index + 1}:drop_verb:${step.class}:${step.verb}`;
    case "change_parent":
      return `${index + 1}:change_parent:${step.class}->${step.parent}`;
    case "rename_class":
      return `${index + 1}:rename_class:${step.from}->${step.to}`;
    case "transform_property":
      return `${index + 1}:transform_property:${step.class}.${step.name}`;
    case "custom":
      return `${index + 1}:custom`;
  }
}

function compareCatalogVersions(from: string, to: string): { order: number; majorChanged: boolean } {
  const left = parseCatalogVersion(from);
  const right = parseCatalogVersion(to);
  for (let i = 0; i < 3; i++) {
    if (right[i] !== left[i]) return { order: right[i] - left[i], majorChanged: right[0] !== left[0] };
  }
  return { order: 0, majorChanged: false };
}

function parseCatalogVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw wooError("E_CATALOG", `catalog version must be semver major.minor.patch: ${version}`, version);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionPatternMatches(pattern: string, version: string): boolean {
  const patternParts = pattern.split(".");
  const versionParts = version.split(/[+-]/)[0].split(".");
  if (patternParts.length !== 3 || versionParts.length !== 3) return pattern === version;
  return patternParts.every((part, index) => part === "x" || part === versionParts[index]);
}

function errorValue(err: unknown): ErrorValue {
  if (err && typeof err === "object" && "code" in err) {
    const error = err as ErrorValue;
    return { code: String(error.code), message: typeof error.message === "string" ? error.message : String(error.code), value: error.value };
  }
  return { code: "E_INTERNAL", message: err instanceof Error ? err.message : String(err) };
}

function attachFeature(world: WooWorld, consumer: ObjRef, feature: ObjRef): void {
  const raw = world.getProp(consumer, "features");
  const features = Array.isArray(raw) ? raw.map((item) => String(item)) : [];
  if (features.includes(feature)) return;
  world.setProp(consumer, "features", [...features, feature]);
  const current = Number(world.getProp(consumer, "features_version") ?? 0);
  world.setProp(consumer, "features_version", Number.isFinite(current) ? current + 1 : 1);
}

function applySeedProperty(
  world: WooWorld,
  hook: Extract<CatalogSeedHook, { kind: "set_property" }>,
  localObjects: Map<string, ObjRef>,
  localSeeds: Map<string, ObjRef>,
  installed: InstalledCatalogRecord[]
): void {
  const object = resolveObjectRef(world, hook.object, localObjects, localSeeds, installed);
  const value = resolveCatalogValue(world, hook.value, localObjects, localSeeds, installed);
  const mode = hook.mode ?? "set";
  if (mode === "set_if_missing") {
    if (world.object(object).properties.has(hook.property)) return;
    world.setProp(object, hook.property, value);
    return;
  }
  if (mode === "append_unique") {
    const existing = world.propOrNull(object, hook.property);
    const current = Array.isArray(existing) ? existing : [];
    const values = Array.isArray(value) ? value : [value];
    const next = [...current];
    for (const item of values) {
      if (!next.some((existingItem) => stableStringify(existingItem) === stableStringify(item))) next.push(item);
    }
    if (stableStringify(next) !== stableStringify(current)) world.setProp(object, hook.property, next);
    return;
  }
  world.setProp(object, hook.property, value);
}

function seedPropertySatisfied(actual: WooValue, expected: WooValue, mode: "set" | "set_if_missing" | "append_unique"): boolean {
  if (mode === "append_unique") {
    if (!Array.isArray(actual)) return false;
    const expectedItems = Array.isArray(expected) ? expected : [expected];
    return expectedItems.every((item) => actual.some((actualItem) => stableStringify(actualItem) === stableStringify(item)));
  }
  if (mode === "set_if_missing" && actual !== null) return true;
  return stableStringify(actual) === stableStringify(expected);
}

function setDescriptionIfEmpty(world: WooWorld, obj: ObjRef, description: string): void {
  const existing = world.propOrNull(obj, "description");
  if (typeof existing === "string" && existing.length > 0) return;
  world.setProp(obj, "description", description);
}

// Property names that must not appear in writable_owner / writable_self.
// `owner` is intrinsically read-only at the substrate layer; the rest are
// either intrinsic fields (`name`, `description`, `aliases`, `flags`,
// `parent`, `location`, `anchor`, `home`) routed through dedicated verbs,
// or the tier-list properties themselves (preventing self-reference). The
// list is closed; extending it requires an updated $block design note.
const RESERVED_TIER_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  "owner",
  "name",
  "description",
  "aliases",
  "flags",
  "parent",
  "location",
  "anchor",
  "home",
  "writable_owner",
  "writable_self"
]);

// Validates the writable_owner / writable_self lists declared on a class
// def. Throws E_CATALOG with a precise message on the first violation so
// authoring tools can fix the manifest before install. Both lists must be
// arrays of strings, disjoint from each other, drawn from the class's own
// `properties` declaration OR an ancestor's property def (whether that
// ancestor lives in the same manifest or already in the world), and free
// of reserved names.
function validateWritabilityTiers(
  def: CatalogObjectDef,
  world: WooWorld | undefined,
  manifestDefs: Map<string, CatalogObjectDef>
): void {
  const owner = def.writable_owner;
  const self = def.writable_self;
  if (owner === undefined && self === undefined) return;
  const declared = new Set((def.properties ?? []).map((property) => property.name));
  const ownerSet = assertTierList(owner, "writable_owner", def.local_name);
  const selfSet = assertTierList(self, "writable_self", def.local_name);
  for (const name of [...ownerSet, ...selfSet]) {
    if (RESERVED_TIER_PROPERTY_NAMES.has(name)) {
      throw wooError(
        "E_CATALOG",
        `${def.local_name}: writability tier may not include reserved property "${name}"`,
        { class: def.local_name, property: name }
      );
    }
    if (!declared.has(name) && !ancestorPropertyExists(world, manifestDefs, def.parent, name)) {
      throw wooError(
        "E_CATALOG",
        `${def.local_name}: writability tier references undeclared property "${name}"`,
        { class: def.local_name, property: name }
      );
    }
  }
  for (const name of ownerSet) {
    if (selfSet.has(name)) {
      throw wooError(
        "E_CATALOG",
        `${def.local_name}: property "${name}" appears in both writable_owner and writable_self`,
        { class: def.local_name, property: name }
      );
    }
  }
}

// Walks the parent chain checking whether `name` is defined as a property
// on any ancestor — either a class already installed in the world, or one
// declared earlier in the same manifest (which has not been created yet
// when validation runs). Returns false when the parent chain dead-ends in
// neither place; that surfaces as the "undeclared property" error from
// the caller. The same name appearing on the in-world ancestor and on
// a same-manifest sibling is fine — both cases satisfy the predicate.
function ancestorPropertyExists(
  world: WooWorld | undefined,
  manifestDefs: Map<string, CatalogObjectDef> | undefined,
  parent: string,
  name: string
): boolean {
  let current: string | null = parent;
  // Defend against malformed manifests with a parent cycle by capping the
  // walk at a generous depth.
  for (let depth = 0; depth < 256 && current; depth += 1) {
    const manifestDef: CatalogObjectDef | undefined = manifestDefs ? manifestDefs.get(current) : undefined;
    if (manifestDef) {
      if ((manifestDef.properties ?? []).some((property: CatalogPropertyDef) => property.name === name)) return true;
      current = manifestDef.parent;
      continue;
    }
    if (world && world.objects.has(current)) {
      const obj = world.object(current);
      if (obj.propertyDefs.has(name)) return true;
      current = obj.parent;
      continue;
    }
    return false;
  }
  return false;
}

function assertTierList(list: string[] | undefined, field: string, klass: string): Set<string> {
  if (list === undefined) return new Set();
  if (!Array.isArray(list)) {
    throw wooError("E_CATALOG", `${klass}: ${field} must be an array of property names`, { class: klass, field });
  }
  const seen = new Set<string>();
  for (const name of list) {
    if (typeof name !== "string" || name.length === 0) {
      throw wooError("E_CATALOG", `${klass}: ${field} entries must be non-empty strings`, { class: klass, field, value: name as WooValue });
    }
    if (seen.has(name)) {
      throw wooError("E_CATALOG", `${klass}: ${field} contains duplicate "${name}"`, { class: klass, field, property: name });
    }
    seen.add(name);
  }
  return seen;
}

// Persists writable_owner / writable_self as wizard-owned, public-read
// properties on the class object. Catalog verb bodies read these via
// `this.writable_owner` / `this.writable_self` to gate writes by tier.
//
// CRITICAL: instance reads of an inherited property fall through
// `getProp` to the ancestor's *property def's defaultValue* — they do
// NOT read the ancestor's own properties map. So the tier list has to
// live in the def's defaultValue, not just in the class object's own
// value, or `instance.writable_owner` returns []. We set both:
// the def's defaultValue (so descendants inherit) and the class's own
// value (so direct reads on the class itself are also up-to-date).
//
// A tier field is persisted on this class when the manifest declares
// it explicitly, OR when no ancestor has the def yet. A subclass that
// silently omits the field inherits the parent's def (and its
// defaultValue) through the normal property chain — which is what
// catalog authors expect when they want to extend rather than replace.
// To narrow the inherited list, declare the field with the narrower
// set; to drop it entirely, declare `[]`.
//
// Idempotent: re-publish bumps the def version and rewrites the value.
function persistWritabilityTiers(world: WooWorld, obj: ObjRef, def: CatalogObjectDef, owner: ObjRef): void {
  const target = world.object(obj);
  const parent = target.parent;
  for (const field of ["writable_owner", "writable_self"] as const) {
    const declared = def[field] !== undefined;
    if (!declared && ancestorPropertyExists(world, undefined, parent ?? "", field)) continue;
    const value = (def[field] ?? []).slice();
    const existing = target.propertyDefs.get(field);
    world.defineProperty(obj, {
      name: field,
      defaultValue: value,
      typeHint: "list<str>",
      owner,
      perms: "r",
      version: existing ? existing.version + 1 : 1
    });
    world.setProp(obj, field, value);
  }
}

function catalogDescription(description: string | undefined, subject: string, catalog: string): string {
  const text = description?.trim() || `${subject} from the ${catalog} catalog.`;
  if (text.length >= 40) return text;
  return `${text} Installed by the ${catalog} catalog as part of the local demo surface.`;
}

function setPropIfMissing(world: WooWorld, obj: ObjRef, name: string, value: WooValue): void {
  if (world.object(obj).properties.has(name)) return;
  world.setProp(obj, name, value);
}

function setNameIfMissing(world: WooWorld, obj: ObjRef, name: string): void {
  if (!name) return;
  const existing = world.propOrNull(obj, "name");
  if (typeof existing === "string" && existing.length > 0) return;
  world.setProp(obj, "name", name);
}

function assertDependenciesInstalled(manifest: CatalogManifest, installed: InstalledCatalogRecord[]): void {
  for (const dependency of manifest.depends ?? []) {
    const name = dependency.startsWith("@local:") ? dependency.slice("@local:".length) : dependency;
    const ok = installed.some((record) => record.alias === name || record.catalog === name || `${record.tap}:${record.catalog}` === dependency);
    if (!ok) {
      const installedNames = installed.map((record) => record.alias || record.catalog).filter(Boolean);
      throw wooError(
        "E_DEPENDENCY",
        `catalog dependency is not installed: ${dependency}; installed catalogs: ${installedNames.length ? installedNames.join(", ") : "(none)"}`,
        { dependency, installed: installedNames }
      );
    }
  }
}

function assertCatalogInstallNameAvailable(
  world: WooWorld,
  manifest: CatalogManifest,
  tap: string,
  alias: string,
  provenance: Record<string, WooValue>,
  installed: InstalledCatalogRecord[],
  adoptExisting: boolean
): void {
  const aliasMatch = installed.find((record) => record.alias === alias);
  if (aliasMatch) {
    if (sameCatalogInstall(aliasMatch, manifest, tap, alias, provenance)) {
      throw wooError("E_CATALOG_ALREADY_INSTALLED", `catalog is already installed at this version: ${alias}`, {
        alias,
        tap,
        catalog: manifest.name,
        version: manifest.version
      });
    }
    throw wooError("E_NAME_COLLISION", `catalog alias is already installed: ${alias}`, {
      alias,
      installed_catalog: aliasMatch.catalog,
      installed_tap: aliasMatch.tap
    });
  }
  const sourceMatch = installed.find((record) => record.tap === tap && record.catalog === manifest.name);
  if (sourceMatch) {
    if (sameCatalogInstall(sourceMatch, manifest, tap, sourceMatch.alias, provenance)) {
      throw wooError("E_CATALOG_ALREADY_INSTALLED", `catalog is already installed at this version: ${sourceMatch.alias}`, {
        alias: sourceMatch.alias,
        tap,
        catalog: manifest.name,
        version: manifest.version
      });
    }
    throw wooError("E_NAME_COLLISION", `catalog source is already installed as ${sourceMatch.alias}: ${tap}:${manifest.name}`, {
      alias,
      installed_alias: sourceMatch.alias,
      tap,
      catalog: manifest.name
    });
  }
  if (!adoptExisting) {
    for (const def of [...(manifest.classes ?? []), ...(manifest.features ?? [])]) {
      if (world.objects.has(def.local_name)) {
        throw wooError("E_NAME_COLLISION", `catalog object already exists: ${def.local_name}`, {
          catalog: manifest.name,
          alias,
          object: def.local_name
        });
      }
    }
    for (const hook of manifest.seed_hooks ?? []) {
      if (hook.kind === "create_instance" && world.objects.has(hook.as)) {
        throw wooError("E_NAME_COLLISION", `catalog seed object already exists: ${hook.as}`, {
          catalog: manifest.name,
          alias,
          object: hook.as
        });
      }
    }
  }
}

function sameCatalogInstall(record: InstalledCatalogRecord, manifest: CatalogManifest, tap: string, alias: string, provenance: Record<string, WooValue>): boolean {
  return (
    record.tap === tap &&
    record.catalog === manifest.name &&
    record.alias === alias &&
    record.version === manifest.version &&
    stableStringify(comparableProvenance(record.provenance)) === stableStringify(comparableProvenance(provenance))
  );
}

function comparableProvenance(provenance: Record<string, WooValue>): Record<string, WooValue> {
  const { fetched_at: _fetchedAt, ...rest } = provenance;
  return rest;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function catalogVerbDrift(actual: VerbDef, expected: VerbDef): string[] {
  const drift: string[] = [];
  if (actual.kind !== expected.kind) drift.push("kind");
  if (actual.kind === "native" && expected.kind === "native" && actual.native !== expected.native) drift.push("native");
  if (actual.source !== expected.source) drift.push("source");
  if (actual.source_hash !== expected.source_hash) drift.push("source_hash");
  if (stableStringify(actual.aliases ?? []) !== stableStringify(expected.aliases ?? [])) drift.push("aliases");
  if (actual.perms !== expected.perms) drift.push("perms");
  if (stableStringify(actual.arg_spec ?? {}) !== stableStringify(expected.arg_spec ?? {})) drift.push("arg_spec");
  if (actual.direct_callable !== expected.direct_callable) drift.push("direct_callable");
  if (actual.skip_presence_check !== expected.skip_presence_check) drift.push("skip_presence_check");
  if (actual.tool_exposed !== expected.tool_exposed) drift.push("tool_exposed");
  if (expected.kind !== "native" && Object.keys(actual.line_map ?? {}).length === 0) drift.push("line_map");
  return drift;
}

function catalogVerbSummary(verb: VerbDef): Record<string, WooValue> {
  return {
    kind: verb.kind,
    aliases: (verb.aliases ?? []) as unknown as WooValue,
    perms: verb.perms,
    arg_spec: (verb.arg_spec ?? {}) as WooValue,
    direct_callable: verb.direct_callable === true,
    skip_presence_check: verb.skip_presence_check === true,
    tool_exposed: verb.tool_exposed === true,
    source_hash: verb.source_hash,
    native: verb.kind === "native" ? verb.native : null
  };
}

function catalogStatusErrorIssue(kind: string, object: ObjRef, err: unknown, verb?: string): CatalogStatusIssue {
  const error = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : String(err);
  return {
    severity: "error",
    kind,
    object,
    verb,
    message: error
  };
}

function resolveMaybeObjectRef(
  world: WooWorld,
  ref: string,
  localObjects: Map<string, ObjRef>,
  localSeeds: Map<string, ObjRef>,
  installed: InstalledCatalogRecord[]
): ObjRef | null {
  try {
    const resolved = resolveObjectRef(world, ref, localObjects, localSeeds, installed);
    return world.objects.has(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function featureListValue(value: WooValue): ObjRef[] {
  return Array.isArray(value) ? value.filter((item): item is ObjRef => typeof item === "string") : [];
}

function installedCatalogs(world: WooWorld): InstalledCatalogRecord[] {
  if (!world.objects.has("$catalog_registry")) return [];
  const raw = world.propOrNull("$catalog_registry", "installed_catalogs");
  return Array.isArray(raw) ? (raw as unknown as InstalledCatalogRecord[]) : [];
}

function recordCatalogInstall(world: WooWorld, record: InstalledCatalogRecord): void {
  const id = `catalog_${record.alias.replace(/[^A-Za-z0-9_]/g, "_")}`;
  if (world.objects.has("$catalog")) {
    if (!world.objects.has(id)) world.createObject({ id, name: record.alias, parent: "$catalog", owner: record.owner });
    else {
      const obj = world.object(id);
      obj.name = record.alias;
      obj.owner = record.owner;
      if (obj.parent !== "$catalog") {
        if (obj.parent && world.objects.has(obj.parent)) world.object(obj.parent).children.delete(id);
        obj.parent = "$catalog";
        world.object("$catalog").children.add(id);
      }
    }
    setDescriptionIfEmpty(world, id, `Installed catalog record for ${record.alias}. It records provenance, version, created class objects, and seeded instances for local introspection.`);
    world.setProp(id, "catalog_name", record.catalog);
    world.setProp(id, "alias", record.alias);
    world.setProp(id, "version", record.version);
    if (record.updated_at !== undefined) world.setProp(id, "updated_at", record.updated_at);
    world.setProp(id, "tap", record.tap);
    world.setProp(id, "objects", record.objects as unknown as WooValue);
    world.setProp(id, "seeds", record.seeds as unknown as WooValue);
    world.setProp(id, "provenance", record.provenance);
    if (record.migration_state) world.setProp(id, "migration_state", record.migration_state as unknown as WooValue);
  }

  if (!world.objects.has("$catalog_registry")) return;
  const records = installedCatalogs(world);
  const next = [...records.filter((item) => item.alias !== record.alias), record];
  world.setProp("$catalog_registry", "installed_catalogs", next as unknown as WooValue);
}
