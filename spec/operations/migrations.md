---
date: 2026-04-30
status: partial
---

# Migrations

> Part of the [woo specification](../../SPEC.md). Layer: **operations**.

How woo handles transitions when the world has changed: bytecode version upgrades, schema changes (property defs evolving, types changing), and data migrations (existing object state needs rewriting under new conventions).

These are the natural sequel to [worktrees.md](worktrees.md): a developer in a worktree authors the change; a migration is what happens at promote-time when the change touches existing state.

---

## M1. The migration problem

Three flavors of "the world has changed":

1. **Bytecode upgrades.** A verb's source and bytecode are replaced. New calls run new bytecode. In-flight cross-host calls may carry old bytecode versions.
2. **Schema changes.** A property definition's type, default, perms, or shape changed. Existing values may not fit the new contract.
3. **Data migrations.** Existing values are still valid under the schema but represent old conventions that need rewriting (e.g., a string field becomes a structured map, capitalization rules change, an enum's values are renamed).

Each has its own answer.

---

## M2. Bytecode upgrades

Already specced normatively in [hosts.md §3.4 invariant 4](../protocol/hosts.md#34-host-rpc-invariants) and [failures.md §F8](../semantics/failures.md#f8-versioning-failures): every serialized task carries the `(definer, verb, version)` triple of its running bytecode. On resume, version mismatch raises `E_VERSION` and aborts the task.

Policy: **a task always runs the version it started under**. New calls into the same verb use the current version.

For a task suspended for hours with old bytecode: it resumes against old bytecode, completes, and *new* calls into the same verb use new bytecode. This is correct semantics — a task is a deterministic execution of a specific bytecode version, not a forward-only concept.

**Cleanup.** Very-old bytecode versions accumulate in the verb-cache and ancestor-cache stores. The platform may purge versions older than N months (operator policy; default 12 months). Nothing holds a durable reference to a bytecode version across time: a pending scheduled turn names a verb and arguments, and resolves them against current code when it fires ([coherence.md §CO16.8](../protocol/coherence.md#co168-lifecycle)). A migration that renames or removes a verb some chain re-arms therefore breaks that chain loudly at its next fire, and must re-arm it — the same obligation any migration carries for the state it rewrites.

---

## M3. Schema changes

Property definitions have version counters (per [persistence.md §14.1](../reference/persistence.md#141-per-object-schema)). Changing a `property_def` falls into two camps:

**Compatible changes.** No migration needed. Existing values stay valid:
- Default value changes (existing values are unaffected; new values use the new default).
- Perms tightening on `r` (readers see `E_PERM` rather than the value; the value persists).
- Type hint widening (`int` → `int | float`).
- Adding `c` perm (delegation enabled).

**Incompatible changes.** Require a migration plan:
- Type narrowing (`any` → `str`).
- Renaming the property.
- Deletion (removing the def entirely).
- Splitting one property into two with structurally different shapes.
- Changing the canonical encoding for an existing value type (rare).

Incompatible changes are authored as a worktree patch series (see [worktrees.md §W3](worktrees.md#w3-patches)) that includes both the schema change *and* the data migration. Promoting the worktree applies them in order.

---

## M4. Data migrations

A data migration walks affected objects and applies a transformation. The pattern:

```
migrate_property(class, name, transform_verb, batch_size?)
```

- `class`: the parent class whose descendants are migrated. Walks `children(class)` recursively.
- `name`: the property to transform.
- `transform_verb`: a verb on `class` (or any ancestor) taking the old value and returning the new value.
- `batch_size`: optional; processes objects in batches of this size, forking a continuation for the next batch. Default 100.

```
verb $task:migrate_to_v2(old_value) {
  // example: promote a string body to {body, format}
  return { body: old_value, format: "plain" };
}

migrate_property($task, "description", "migrate_to_v2");
```

Use cases:
- "Capitalize all room names."
- "Convert `description: str` to `description: {body, format}`."
- "Add a default `discoverability: 'public'` to every player created before today."
- "Rename `assignee` to `performer` (paired with a `define_property`/`delete_property` patch)."

A data migration is itself a worktree patch series:
- One `define_property` patch (if adding a slot).
- One `migrate_property` operation (the bulk transform).
- One `delete_property` patch (if removing the old slot).
- Possibly one `set_verb_code` patch (if new code expects the new shape).

Promoting the worktree applies all of these to live in order.

---

## M5. Long-running migrations

A migration over 10K objects can't complete in one verb's tick budget. The migration verb forks per-batch:

```
verb $migration:run() {
  let batch = this:next_batch();
  for obj in batch {
    if (!this:is_migrated(obj)) {
      this:transform(obj);
    }
  }
  if (this:has_more()) {
    schedule(this, "run", [], 60_000);
  } else {
    emit(this, { type: "migration_complete", source: this });
  }
}
```

The migration is a chain of scheduled turns that processes one batch each, with per-turn tick budgets. At the 60-second lead time ([scheduling.md §SC3](../semantics/scheduling.md#sc3-time)) a long migration is measured in batches-per-hour, so size the batch accordingly. Failure mid-batch leaves a partial migration; the next run resumes from the last-processed seq. Arm it as an `always` entry — a migration must not stall because nobody is watching the scope — which means the driver is wizard-owned.

**Idempotency requirement.** Migrations must be idempotent. The transform verb checks whether each object has already been migrated (e.g., by reading a marker property or checking the value's shape) before transforming. This makes:
- Crash recovery safe (resume from any point).
- Manual re-runs safe (operator can run again without double-applying).
- Worktree rebases safe (the transform's expected behavior matches across runs).

**Live state during migration.** Migrations run concurrently with live calls. A call that arrives mid-migration sees either the old or new value. New code that lands as part of a migration-bearing worktree must accept both shapes — see §M5.1 for the normative rule.

`pause_space(space, reason)` and `resume_space(space)` are first-class wizard verbs for operational maintenance. A paused space rejects all calls with `E_PAUSED` until resumed; the runtime continues to accept the wizard verbs that re-enable it. Used when dual-shape compatibility (§M5.1) is impossible.

---

## M5.1 Code/migration compatibility window (normative)

When a worktree pairs schema/data migration patches with code patches, the runtime enforces a **compatibility window**:

**Default rule: dual-shape tolerance.** New code (verbs landed via the same worktree promote as a `migrate_property` patch) must accept *both old and new property shapes* until the migration's `migration_complete` observation lands. This is the developer's responsibility; the runtime does not auto-generate the dual-shape branches, but the worktree promote *gates code patches on a marker*.

Each verb whose source is patched in a worktree that also includes a migration declares one of:

- `migration_safe: <migration_id>` — the verb accepts both old and new shapes for the named migration. Promote allows the patch.
- `migration_pause: <migration_id>` — the verb requires the migration to complete before it sees calls; the worktree must include `pause_space` patches alongside it.
- (default, neither) — the worktree promote refuses, with a structured error pointing the developer at the missing annotation.

**Pause-during-migration alternative.** When dual-shape support is impossible (the new code's logic genuinely cannot read the old shape), the worktree includes a `pause_space(space, "migrating <id>")` patch that lands *before* the code patches, and a `resume_space(space)` patch that lands after the migration completes. The space rejects calls during the window.

**Migration completion gate.** Code patches in a worktree paired with a `migrate_property` are not applied to live until the migration emits `migration_complete`. The worktree records the patches as pending; on completion, applies them in the order recorded.

```
worktree patches (in order):
  1. define_property $task description  (compatible add)
  2. migrate_property $task description (long-running; idempotent)
     ... migration runs in background ...
  3. set_verb_code $task:render        (waits for migration_complete)
  4. delete_property $task description  (waits for migration_complete; only if old slot is being removed)
```

For pause-mode worktrees, step 0 is `pause_space($task.space)`, and the final step is `resume_space($task.space)`.

This is what makes a migration that touches both code and data safe to ship through a worktree promote without bricking the live world: either the new code is dual-shape (and migration runs in background while live keeps serving), or the space is paused (and live calls reject cleanly until the migration completes).

---

## M6. World-level spec versioning

A world records which spec version it implements. Stored on `$system` as a property `$system.spec_version`.

On runtime boot:
- If `$system.spec_version == runtime_version`: normal operation.
- If `$system.spec_version` is older: runtime applies known migrations from its catalog in order.
- If `$system.spec_version` is newer: runtime refuses to boot with `E_SCHEMA_NEWER`.

The catalog of known migrations lives in the deployment alongside the runtime code. Each catalog entry has:

```ts
{
  from_version: str,
  to_version: str,
  apply: () => Promise<void>,    // idempotent migration step
  description: str,
  irreversible?: bool             // if true, post-apply downgrade is impossible
}
```

Catalog entries chain: `1.0 → 1.1 → 1.2 → 1.3`. A world at 1.0 booted against runtime 1.3 applies three migrations in order. Each is idempotent so a partially-applied chain can resume.

Wizards may inspect catalog state and force re-runs:

```
wiz:list_migrations() -> [{from, to, applied, applied_at}]
wiz:run_migration(from, to)        // wizard-only; idempotent
```

---

## M7. Migration rollback

Forward-only is the default. To revert a schema or data migration, the operator authors a *new* migration that performs the inverse transform.

For migrations marked `irreversible` (e.g., a one-way data destruction), the spec records that downgrade is not possible without restoring from backup. Operators see a warning before promoting an irreversible migration through a worktree.

Reversible migrations (the common case) record their inverse alongside the forward transform; the runtime can apply the inverse if a wizard requests downgrade. This is rare in practice — usually wizards prefer to keep moving forward and fix issues with another forward migration.

---

## M8. Migration as a worktree

Putting it together: the canonical flow for a non-trivial change is:

1. Developer creates a worktree against the affected scope.
2. Authors:
   - Schema patches (`define_property`, `delete_property`, `set_property_info`).
   - Migration step (a `transform` verb on the affected class).
   - `migrate_property` patch invoking the transform.
   - Code patches (`set_verb_code` for verbs that expect the new shape).
3. Tests in the sandbox: the sandbox's snapshot is migrated as part of patch application; calls exercise both pre-migration and post-migration paths.
4. Promotes:
   - Schema patches apply atomically.
   - Migration starts (live; runs in background batches).
   - Code patches apply atomically.
5. Operator monitors the migration via `migration_progress(space)` until complete.

For very large worlds, the migration may take hours or days. The worktree promote returns once the patches *queue* (schema and code patches done; migration scheduled); the developer monitors progress separately. New code is in effect immediately; existing state migrates progressively.

---

## M9. What's deferred

- **Cross-world migrations.** Federation v1 may need migration coordination between peer worlds; out of v1 scope.
- **Live-traffic-aware throttling.** Migrations currently run on a fixed batch cadence; smarter throttling that backs off under load is a v2 polish.
- **Migration dry-run.** Apply a migration to a snapshot and report what would change without committing. The worktree+sandbox model already covers this for code/schema changes, but a dedicated `dry_run_migration` operation that surfaces a structured diff is missing.
- **Schema enforcement at the runtime level.** Currently schemas are advisory ([events.md §13](../semantics/events.md#13-schemas)); strict typing would change the migration contract. Out of v1.
- **Auto-generated migrations.** Inferring the right migration from a schema diff is hard and error-prone; the spec keeps migrations as explicit author intent.
