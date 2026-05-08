# Catalog-authored local-boot migrations

Closing audit items **#5** (`src/core/local-catalogs.ts` carries TS-side
catalog repair) and **#10** (no catalog-authored local-boot migration runtime).
Both leaks dissolve together: today's TS migration runners exist *because*
catalogs cannot author their own.

## Where the leak lives now

`src/core/local-catalogs.ts` is 1232 lines. About 70 of those lines are the
runtime (lifecycle dispatch, dependency adoption, manifest fingerprinting,
ledger I/O). The rest is **17 hand-written `runFooMigration` functions**, each
gated on a string id like `2026-04-30-chat-cockatoo` and recorded in
`$system.applied_migrations`. They mutate world state directly via the TS
substrate API (`world.setProp`, `world.addVerb`, `world.installVerb`,
`world.moveObjectChecked`, `runLocalCatalogSchemaPlan`, etc.).

The pattern is consistent enough that the migrations look almost data-driven
already:

```ts
function runPinboardV02RepairMigration(world: WooWorld, names: readonly string[]): void {
  if (!names.includes("pinboard")) return;
  if (!localCatalogInstalled(world, "pinboard")) return;
  if (migrationApplied(world, "2026-05-02-pinboard-v02-repair")) return;
  if (!world.objects.has("$note")) return;
  // ... condition check ...
  if (needsRepair) {
    runLocalCatalogSchemaPlan(world, "pinboard", manifest, "gateway", "world", {
      allowImplementationHints: true,
      reconcileSeedHooks: true,
      reconcileClassVerbs: true
    });
  }
  markMigrationApplied(world, "2026-05-02-pinboard-v02-repair");
}
```

What's *actually* catalog-specific in that function: the catalog name, the id,
the dependency check (`$note` must exist), the postcondition (a few verb
sources contain certain substrings), and the plan options. Everything else is
boilerplate the runtime should provide.

The existing infrastructure already covers most of what's needed:

- `$system.applied_migrations` — idempotency ledger ([bootstrap.ts:541](../src/core/bootstrap.ts#L541)).
- `$system.catalog_migration_records` — per-host audit log.
- Host-scoped lifecycle ([CT5.4.1](../spec/discovery/catalogs.md#ct541-local-boot-migrations)).
- `runLocalCatalogSchemaPlan` — the manifest-driven repair primitive most of
  the migrations call into.

What's missing is the **authoring shape**: a way for `catalogs/<name>/` to
ship its own migration files, with the runtime in `local-catalogs.ts` doing
nothing more than discover, gate, dispatch, record.

## Existing precedents in the codebase

- **Catalog version migrations** ([CT14](../spec/discovery/catalogs.md#ct14-migrations)):
  `catalogs/<name>/migration-vN-to-v(N+1).json` for major-version bumps. JSON
  shape covers rename/retype/restructure of class properties.
- **Cloudflare DO migrations**: `cf-do-NNNN` tags appended via `npm run cf:migrations`.
- **Bootstrap local-boot**: the current TS-authored thing this document is
  about closing.

The CT14 catalog version migration format is the natural starting shape. It is
already a JSON migration descriptor next to a manifest; we want roughly the
same convention for boot-time repair, with semantics suitable for the kinds of
operations these 17 runners actually perform.

## Catalog-by-catalog inventory

A first read of the runners groups the work into a few archetypes. The
runtime needs to support each, either declaratively or via a woocode escape
hatch:

| Archetype | Examples | What it needs |
|---|---|---|
| Source-or-schema reconcile | `2026-04-30-source-catalog-verbs`, `2026-05-02-pinboard-v02-repair`, `2026-05-02-chat-room-exit-model` | Run `runLocalCatalogSchemaPlan` with named option flags. Already mostly declarative. |
| Drop a deprecated property | `2026-05-04-drop-session-id-property`, `2026-05-04-drop-presence-in-property` | Iterate `children($class)`, remove property. Pure substrate. |
| Move objects between containers | `2026-05-01-chat-nowhere-portables-repair`, `2026-05-04-chat-room-exits-restore`, `2026-05-02-prog-editor-nowhere` | `moveObjectChecked` with predicates. |
| Repair a specific verb's source | `2026-05-03-chat-command-plan-source-repair`, `2026-05-06-chat-actor-huh-source-repair`, `2026-05-06-chat-look-at-command-repair` | Compile-and-install a known-good source string against a class verb. |
| Reparent / chparent class graph | `2026-05-03-taskspace-task-note-parent`, `2026-05-02-pinboard-pins-model`, `2026-05-02-pinboard-notes-to-pins` | `chparent` over class instances; sometimes followed by data conversion. |
| Add or expose tool metadata | `2026-05-01-agent-tool-exposure-repair`, `2026-05-01-chat-navigation-tool-exposure`, `2026-05-01-cockatoo-tool-exposure` | `setVerbInfo` setting `tool_exposed: true` on named verbs. |
| Per-data conversion | `2026-05-01-pinboard-free-coordinates`, `2026-05-02-pinboard-v02-data-repair` | Walk instances, transform property values. Most likely to need woocode. |

Two of these archetypes (per-data conversion, complex move-with-predicates)
are hard to express in pure JSON. The other five could plausibly be JSON
migration descriptors.

## Open design questions

These are the questions a spec patch needs to answer before any code lands:

1. **Authoring shape.** Hybrid: declarative JSON for the common archetypes
   (schema reconcile, property drop, verb-source replace, tool-exposure flag)
   plus a woocode escape hatch verb for the rare data-conversion case? Or
   uniform — every migration is woocode, runtime just provides the gating?
2. **Discovery.** Where do migration files live? `catalogs/<name>/migrations/
   *.json` directory beside `manifest.json`? Listed explicitly in the
   manifest, or scanned implicitly?
3. **Migration id convention.** Currently `2026-MM-DD-<topic>`. Keep date-as-
   prefix (so directory listing is chronological), or move to monotonic
   integers (`m0001`)? Date-prefixed is human-readable but encodes
   non-essential information.
4. **Ordering.** When catalog A's migration depends on catalog B being
   installed (e.g., pinboard waits on `$note`), today the runner does an
   in-band guard. Stay with the "skip and retry next boot" pattern, or add
   explicit `depends_on` declarations and a topological sort?
5. **Trigger.** Currently runs at cold boot of a host. Should it also run on
   catalog install/update? Schema fingerprinting already covers manifest
   drift for live worlds; boot migrations are for the legacy-data-conversion
   case.
6. **Authority.** Migrations run as `$wiz` today. Should catalog-authored
   migrations run as the catalog's owner? As wizard? With reduced authority
   (no cross-catalog writes)? Strictest: a migration on catalog A cannot
   mutate objects belonging to catalog B.
7. **Failure recovery.** Today a thrown error bubbles out and the boot
   probably crashes. Should the runtime mark a migration `failed` in the
   ledger and skip it on retry, or always retry from scratch?
8. **Pre/postconditions.** The existing runners often guard on a postcondition
   ("verb source contains `contents(this)`") before deciding to run. Make
   this a declared field, or leave it as imperative woocode?
9. **Removal policy.** Once every world a deployment has shipped to has
   applied a given migration, the migration code is dead weight. Currently
   we keep all 17 forever. Define a "minimum supported world version"
   policy so old migrations can be deleted?
10. **Cross-host scope.** §CT5.4.1 distinguishes gateway-scoped from
    host-scoped lifecycle. The new authoring shape needs an explicit field
    declaring which scope a migration runs in.

## Phasing

Not one PR. Roughly:

1. **Spec draft** — extend `spec/discovery/catalogs.md` (or new
   `spec/discovery/catalog-local-boot-migrations.md`) with the authoring
   shape and the answers to the questions above. Decide JSON-vs-woocode-vs-
   hybrid up front; everything else falls out.
2. **Runtime extraction** — pull the 70-line lifecycle/ledger/dispatch core
   out of `local-catalogs.ts` into a clearer module with stable seams for
   "discover migrations for catalog C" and "execute migration M against
   world W as principal P". Don't change the migration list.
3. **Port one migration** as proof — pick the smallest declarative case
   (e.g., `2026-05-04-drop-session-id-property`) and replace its TS runner
   with a JSON descriptor. Verify the test suite still covers it.
4. **Port the rest** — work through the inventory above. Each port is its
   own small PR with a vitest case proving the migration is equivalent.
5. **Delete `local-catalogs.ts` migration code** — once every TS runner is
   ported, what remains in the file is the runtime invocation. Move it to
   its final home (probably `src/core/catalog-migrations.ts` or similar)
   and let `local-catalogs.ts` become a thin compatibility shim — or delete
   it entirely.

Estimated total scope: 17 migrations × small-PR each, plus the spec draft and
runtime work. Not large per step; the value compounds because every future
catalog change drops into the established pattern instead of getting a new
TS function.

## Out of scope here

- **Catalog version migrations (CT14).** Those are public, semver-bound,
  apply to update-time only. This work is about boot-time repair for already-
  deployed worlds. The two systems may share authoring shape, but they have
  different triggers and different audiences.
- **Spec-version migrations (M6).** Different ledger (`$system.spec_version`),
  different cadence (runtime semantics changes, not catalog data). Solving #5/
  #10 does not unblock M6.
- **Removing existing migration ids from worlds that have already applied
  them.** The ledger keeps the audit trail; old ids stay in the ledger
  forever even after the corresponding TS runner is deleted.

## Cross-references

- Audit findings ledger: `notes/` (see prior layering checklist replies in
  recent session memory) — items #5 and #10.
- [`spec/discovery/catalogs.md` §CT5.4.1](../spec/discovery/catalogs.md#ct541-local-boot-migrations) — what's specified today.
- [`src/core/local-catalogs.ts`](../src/core/local-catalogs.ts) — what to
  dissolve.
- [`src/core/bootstrap.ts:541`](../src/core/bootstrap.ts) — `$system.applied_migrations` seed.
- [`tests/catalogs.test.ts`](../tests/catalogs.test.ts) — covers migrations
  today; will cover ports during phase 4.
