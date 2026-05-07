---
date: 2026-05-03
status: partial
---

# Catalogs

> Part of the [woo specification](../../SPEC.md). Layer: **discovery**.

The contract for naming, sharing, and installing reusable object sets — the "publish a `$task` library, use it in your world" story. Beyond the wizard-curated `$system` corename map, multi-developer worlds need a way to introduce *named, versioned* sets of base classes and feature objects that other worlds (or the same world's separate clusters) can adopt.

The distribution model is **GitHub-tap-then-install**, modeled on package managers' tap-add/install flow. Catalogs live as directories in public GitHub repositories; an operator installs a named catalog from a tapped repo by ref. No central registry, no signing infrastructure — git carries versioning, attestation (commit signing), forking, and history.

---

## CT1. Beyond corenames

`$system` corenames ([objects.md §5.3](../semantics/objects.md#53-corenames)) are flat, world-scoped, and curated by wizards. They work for the bootstrap graph (`$root`, `$space`, `$player`) but don't scale to:

- A team publishing their `$timer` and `$reminder` classes for other teams to use.
- A community library (`$markdown_renderer`, `$reaction_set`) that hundreds of worlds want.
- Foundational utilities and example applications shipped in this repo (see §CT15) — themselves installable catalogs, on the same path as any third-party catalog.
- Versioned base classes that evolve (`v1`, `v2`).

Catalogs are the answer.

---

## CT2. What is a catalog

A **catalog** is a directory in a public GitHub repository (or in the deployment's bundled `catalogs/` for local catalogs) containing:

- `README.md` with YAML frontmatter (name, version, spec_version, license, description, depends).
- `manifest.json` — the JSON-format export of the catalog's classes, verbs, schemas, features, and seed hooks.
- Optional `agent_manifest.json` — MCP/OpenAPI tool descriptions (see §CT11).
- Optional browser UI modules and declarations in `manifest.json`'s `ui` field, following [protocol/ui-component-model.md](../protocol/ui-component-model.md).

Spec ships **source**, not bytecode. The manifest carries DSL source for every verb; the importing world recompiles in its own spec version. This avoids cross-spec-version bytecode portability problems entirely.

**Local implementation hints.** The manifest format still permits a
non-portable `implementation` field on a verb (`native` handler or named
bytecode fixture) for trusted `@local` bootstrap experiments. First-party demo
catalogs should not rely on it; chat, taskspace, and dubspace install from
source alone. Public v1 catalogs must treat source as normative; implementation
hints are ignored outside trusted local catalogs.

In-world, installed catalogs are objects descended from `$catalog`; the world's `$catalog_registry` lists them. Each installed class records its source catalog so introspection can answer "where did this come from?"

---

## CT3. Naming

Catalogs are referenced by a four-part name: `<owner>/<repo>:<catalog>[@<ref>]`.

- `<owner>/<repo>` — GitHub coordinates of the tapped repo (e.g. `hughpyle/woo-libs`).
- `<catalog>` — the directory name under `catalogs/` in the repo (e.g. `dubspace`).
- `<ref>` — optional git ref: a tag, branch, or commit SHA. **Default**: the highest semver tag matching `<catalog>-v*` (e.g. `dubspace-v1.0.0`); if no such tag exists, `main`. Operators are encouraged to pin explicitly.

Examples:

- `hughpyle/woo-libs:dubspace@dubspace-v1.0.3` — pinned tag.
- `hughpyle/woo-libs:dubspace` — latest semver tag for `dubspace`.
- `hughpyle/woo-libs:dubspace@main` — branch tip; mutable.
- `hughpyle/woo-libs:dubspace@<sha>` — pinned commit.

Within a single world, an installed catalog is referenced by its alias (defaulting to `<catalog>`). Cross-catalog parents in manifests use the full form: `parent: "hughpyle/woo-libs:root-pack:$control"`.

**Local catalogs** use the special prefix `@local`: `@local:dubspace` resolves to `<deployment>/catalogs/dubspace/`. Local catalogs are how the worlds bundle their own first-party content (e.g., the example demos that ship in this repository).

### CT3.1 Reference resolution (precedence)

A catalog object reference inside a manifest (parents, feature ancestors, schemas, and seed hooks) resolves in this fixed order. The runtime stops at the first match:

1. **Catalog-local name** — a `$<name>` with no qualifier resolves to a class declared earlier in *this* manifest's `classes` or `features` list. Within-catalog references are unqualified.
2. **Universal corename** — a `$<name>` that matches a universal object on `$system` (`$root`, `$actor`, `$player`, `$wiz`, `$guest`, `$sequenced_log`, `$space`, `$thing`, `$catalog`, `$catalog_registry`, and bootstrap scaffolding such as `$nowhere`). Resolved via `$system.<name>`.
3. **Installed-alias-qualified name** — `<alias>:$<name>` where `<alias>` is the installed alias of another catalog (default alias = catalog name; overridable on install via `as`). Resolved through `$catalog_registry`.
4. **Full tap-qualified name** — `<owner>/<repo>:<catalog>:$<name>`. Resolved through `$catalog_registry`; refuses if the named catalog is not installed.
5. **Seed-local instance name** — a non-`$` bare name in a seed hook resolves to an instance created earlier by the same manifest's `seed_hooks` list.
6. **Installed seed alias** — `<alias>:<name>` in a seed hook resolves to a registry-tracked seed instance created by another installed catalog.

Unqualified `$<name>` references that match neither the catalog-local set nor a universal corename are an error (`E_UNRESOLVED_REFERENCE`); the manifest must qualify the reference. Bare seed-instance names that match neither an earlier seed hook nor an allowed universal/bootstrap object are also an error. World-local corenames (operator-created at runtime) are *not* in the resolution path — manifests cannot reference arbitrary world-local corenames, only universal objects, their own seeded instances, and other installed catalogs.

This rule keeps manifests deterministic across worlds: the same manifest installed into two different worlds resolves to the same class set, given the same dependency catalogs are installed.

---

## CT4. Distribution

A repository hosting catalogs has the layout:

```
github.com/hughpyle/woo-libs/
├── README.md                    (repo-level overview)
└── catalogs/
    ├── dubspace/
    │   ├── README.md            (catalog-level, frontmatter-headed)
    │   ├── manifest.json
    │   └── agent_manifest.json  (optional)
    ├── taskspace/
    │   ├── README.md
    │   └── manifest.json
    └── chat/
        ├── README.md
        └── manifest.json
```

Catalog `README.md` frontmatter is YAML between `---` markers, then operator-facing documentation:

```yaml
---
name: dubspace
version: 1.0.0
spec_version: v1
license: MIT
description: Sound-mixer building blocks for a shared dub-mix space.
depends:
  - hughpyle/woo-libs:root-pack
---

# Dubspace

A library for live shared dub-mix sound spaces. Provides $loop_slot,
$channel, $filter, $delay, $drum_loop, and $scene classes parented from
$control.

...
```

Required frontmatter fields: `name`, `version`, `spec_version`, `license`. Optional: `description`, `depends`, `homepage`, `keywords`.

**v1 limitations** (intentional):

- **Public repos only.** Private repos, GitHub tokens, etc. are deferred — see §CT10.
- **No caching.** Every install or update fetches fresh from `raw.githubusercontent.com`. Operators control freshness via the `ref` parameter.
- **No automated dependency resolution.** `depends` declares hard prerequisites — install **verifies** each entry is already installed at a compatible version, and refuses with `E_DEPENDENCY` otherwise. The runtime does not fetch or install dependencies on the operator's behalf. The operator installs prerequisites first, in order. Transitive constraint solving is deferred (§CT10).

---

## CT5. Install

The v1 runtime-supported operations are `install`, `list`, `update`, and `migration_state`. Mutating catalog operations are wizard-only and audited. They are themselves sequenced — they have an owning sequencer, namely `$catalog_registry` itself. `uninstall` is part of the catalog contract below, but remains deferred until the runtime can prove the conservative safety checks in §CT9.

### CT5.1 `$catalog_registry` is a `$space`

`$catalog_registry` is a universal singleton (corename `$catalog_registry`) that descends from `$space`. Every install and update is a sequenced call **through `$catalog_registry`** — its log is the catalog-operations history. Replay over the registry log reconstructs the sequence of catalog mutations the world has seen. When uninstall lands, it uses the same sequencing scope.

Because the registry is a `$space` subclass, it inherits the same call lifecycle, replay, and snapshot machinery ([sequenced-log.md §SL2](../semantics/sequenced-log.md#sl2-the-native-host-operations), [space.md §S2](../semantics/space.md#s2-the-call-lifecycle)). The async behavior-savepoint discipline applies: a partial install rolls back inside the behavior savepoint while the registry log row commits with `applied_ok=false`. Crash-safety and audit follow without new mechanisms.

This places catalog ops in a different sequencing scope from `$space:call` traffic in user spaces — installs don't conflict with normal world activity, but they are themselves totally ordered relative to each other and replay-deterministic.

### CT5.2 REST surface

Hybrid execution path: the Worker handles GitHub I/O at the edge; the world handles the actual install as a sequenced call through `$catalog_registry`.

```
POST /api/tap/install
body: { tap, catalog, ref?, as? }
```

Worker resolves `ref` against the GitHub API (HEAD of the named tag/branch, or the supplied SHA), retrieves the **resolved commit SHA**, then fetches `https://raw.githubusercontent.com/<tap>/<sha>/catalogs/<catalog>/manifest.json` and the README. Computes content hashes (SHA-256) of both. Dispatches `$catalog_registry:call({actor, target: "$catalog_registry", verb: "install", args: [manifest, frontmatter, alias, install_provenance]})` where `actor` is the authenticated wizard actor, `alias = body.as ?? catalog`, and `install_provenance` is:

If `ref` is omitted, the first implementation chooses the highest semver tag matching `<catalog>-v*`; if no matching tag exists, it falls back to `main`. Public GitHub taps ignore any non-portable `implementation` hints in the manifest and compile from source. Only `@local` catalogs may use trusted native/fixture hints.

```
{
  tap: "<owner>/<repo>",
  catalog: "<name>",
  alias: "<installed alias>",
  ref_requested: "<as user typed it; may be a tag, branch, or sha>",
  ref_resolved_sha: "<git commit SHA at fetch time>",
  manifest_hash: "sha256:<hex>",
  readme_hash: "sha256:<hex>",
  fetched_at: <ms epoch>
}
```

Returns the applied frame from `$catalog_registry`.

The fetch side enforces bounded inputs before parsing: manifest and migration bodies are capped at 256 KiB, README bodies at 512 KiB, and a single install/update may make at most eight tap fetches. Hosts emit structured diagnostic logs for `tap_fetch`, `tap_migration_fetch`, `tap_install`, and `tap_update`, including the resolved SHA, content hashes, byte counts, and subrequest count. Reissuing an exact same-version install for the same alias/source/provenance refuses with `E_CATALOG_ALREADY_INSTALLED` without appending another registry log row.

```
POST /api/tap/uninstall
body: { tap, catalog }
```

Wizard-only. Sequenced through `$catalog_registry`. Recycle policy for instances of imported classes follows §CT9. **Runtime status:** deferred; hosts should return `E_NOT_IMPLEMENTED` until the §CT9 reachability checks are implemented.

```
POST /api/tap/update
body: { tap, catalog, ref?, as?, accept_major? }
```

Explicit re-install at a new ref. Operator opts in; there is no auto-update. The host resolves the new ref to a commit SHA before dispatching. The runtime compares the manifest's `version` against the recorded version, refuses downgrades, refuses major bumps unless `accept_major: true`, and requires a migration manifest for major-version updates (§CT14). The local Node server and the Cloudflare Worker both implement the public GitHub tap path; private repositories and authenticated GitHub fetches remain deferred (§CT10).

```
GET /api/taps
```

Returns `$catalog_registry` contents: installed catalogs with their `install_provenance`, version, alias, and timestamps. The provenance fields make every install reconstructable.

For `@local:<catalog>` installs, the Worker reads from the deployment's bundled `catalogs/<catalog>/` directory instead of fetching from GitHub. The provenance carries `tap: "@local"`, `ref_requested: "@local"`, `ref_resolved_sha: "<sha of the deployment's git HEAD at install time, or 'unversioned'>"`, `alias`, and content hashes computed locally.

### CT5.3 In-world entry: `$catalog_registry:install`

`$catalog_registry:install(manifest, frontmatter, alias, install_provenance)` is wizard-only. It runs as a sequenced call on the registry, so the install is replay-safe and audit-visible:

1. Validate frontmatter (`name` + `version` + `spec_version` present; spec_version compatible).
2. **Verify** declared dependencies are already installed and version-compatible — refuse with `E_DEPENDENCY` if any are missing or incompatible. v1 does not auto-resolve; the operator installs dependencies first.
3. Recompile every verb in the manifest using the world's current DSL compiler.
4. Create classes, property defs, verbs, event schemas, feature objects in the manifest's declared order. Parents are resolved via the reference grammar (§CT3.1).
5. Run the manifest's `seed_hooks` block — instance creation, feature attachments, and ordinary authored parent changes.
6. Record the install in the registry's local state: `{tap, catalog, alias, version, install_provenance, installed_at, owner: actor_at_install}`.

Steps 3–5 run inside the call's savepoint; any failure rolls them back while the registry log row stays at the assigned seq with `applied_ok=false` and an error observation, per the standard sequenced-call discipline.

### CT5.3.1 In-world entry: `$catalog_registry:update`

`$catalog_registry:update(manifest, frontmatter, alias, provenance, options, migration?)` is wizard-only and sequenced through `$catalog_registry`.

1. Locate the installed catalog by `alias` or by `(tap, catalog)`.
2. Validate dependencies against the currently installed catalog set.
3. Compare semantic versions. Same-version updates are treated as repairs; patch/minor updates are accepted; downgrades are refused; major updates require `options.accept_major == true` and a migration manifest.
4. Recompile and repair the installed catalog objects from the new manifest. Existing seed objects keep live state except where the manifest or migration explicitly changes it.
5. Run migration steps if supplied (§CT14). Step failures are caught and recorded as `migration_state` rather than escaping as behavior failures.
6. Update the registry record in place, preserving `installed_at` and adding `updated_at`, new provenance, version, object/seed refs, and `migration_state`.

The registry exposes `:migration_state(alias)` as a direct read for operator tooling.

### CT5.4 Local catalogs and auto-install

A deployment's bundled `catalogs/` directory ships with the world's source. The local-catalog mechanism reads from this bundle when `tap = @local`.

Boot-time auto-install is controlled by `WOO_AUTO_INSTALL_CATALOGS` (a comma-separated list, see [reference/cloudflare.md §R14](../reference/cloudflare.md#r14-deploying-your-own-world)):

- unset — install every bundled catalog discovered at `<deployment>/catalogs/*/manifest.json`, dependency-sorted using `depends`. A catalog is bundled because it lives in the bundled catalog tap location, not because the runtime recognizes its name, classes, seed objects, UI, or app role.
- `WOO_AUTO_INSTALL_CATALOGS=chat,taskspace,dubspace` — install only the named local catalogs from the same bundled tap location. This is an operator filter over discovered local catalogs, not a hardcoded application list.
- `WOO_AUTO_INSTALL_CATALOGS=` (empty) — clean world; operators install what they want.
- Each entry is a catalog name resolved against `@local:<name>`.

The repository's local Node server intentionally uses the **unset** case for local development: clone, run, and see the bundled demos. The repository's Cloudflare `wrangler.toml` intentionally ships with the **empty** case so fork-and-deploy operators start from a clean core world unless they opt into bundled local catalogs before deploy.

Auto-install is idempotent: if a catalog is already in `$catalog_registry`, the boot-time pass skips it without appending a no-op registry log row. Boot-time local auto-install is part of deterministic world construction, so it installs directly from the bundled manifest and records the catalog in `$catalog_registry` state without routing through `$catalog_registry:call`. Runtime catalog install/update operations are sequenced through `$catalog_registry` and audited. Runtime uninstall uses the same pattern once implemented.

Implementation rule: source code must not contain catalog-specific install policy. Adding, removing, or renaming a bundled catalog is a filesystem/catalog operation: place or remove a manifest directory under `catalogs/`, regenerate the bundled catalog index for non-filesystem deployment targets, and let install ordering follow declared dependencies. Runtime code that branches on demo object names or catalog names is a bug unless it is explicitly part of a temporary demo UI adapter.

### CT5.4.1 Local boot migrations

Local catalog auto-install may also run **deployment-local boot migrations**.
These are not public catalog update migrations (§CT14). They are repair/sync
steps for worlds created by an earlier build of the same deployment, such as
recompiling bundled catalog verbs after a DSL/compiler capability lands.

Boot migrations are idempotent and recorded in `$system.applied_migrations`.
They run after the local catalog install pass, so a fresh world installs the
current manifests first and then records the migration as applied; an existing
world repairs only catalogs already present in `$catalog_registry`. Missing
dependencies of an already-installed bundled catalog may be installed as a
compatibility repair; this is not an auto-install policy for clean worlds.

For ordinary bundled manifest drift, the deployment computes a stable manifest
fingerprint and compares the manifest against stored classes, verbs, property
definitions, schemas, and seed hooks. If drift is detected, the gateway repairs
from the manifest and records `local-catalog-schema:<catalog>:<hash>`. The id is
derived from content, not hand-authored for each source edit; this keeps routine
source/schema sync repeatable and declaration-free. Explicit one-shot boot
migrations remain only for data conversions or compatibility repairs that cannot
be inferred from a manifest diff.

In multi-host deployments, every host that owns catalog data must run its own
host-scoped local lifecycle at cold init. Gateway repair cannot see or safely
convert state stored in self-hosted object DOs, and a copied
`$system.applied_migrations` ledger is not proof that the owning host's data was
already repaired. Object hosts receive repaired class/verb/schema rows by merging
a fresh gateway host seed. A brand-new host DO records the host-scoped
content-addressed schema plan as covered by that seed; a host with stored state
executes scoped plan steps, verifies postconditions, and appends a host-specific
record to `$system.catalog_migration_records`. They do not run opaque manifest
repair over partial slices. Host-local data migrations use the same ledger and
run against state the host actually owns. If a fresh gateway host seed was
available, the host re-applies it after the host-scoped lifecycle so copied
support classes and verbs converge to the gateway's repaired definitions.

Live object hosts can also be refreshed from the gateway's current host seed by
a wizard operation. That path copies gateway support objects into the running
host and persists only if the seed merge changed state. It does not re-run the
host-scoped manifest repair pass, so an operator-applied gateway repair is not
rewritten by the bundled manifest while the host is live.

Dependency repair may encounter a partial earlier bootstrap where catalog
objects already exist but `$catalog_registry` has no matching installed record.
For bundled `@local` dependencies only, the boot lifecycle may adopt those
objects, repair them from the manifest, run seed hooks, and write the missing
registry record. Public runtime installs still reject object-name collisions.

A migration must not special-case a demo application's object names or
semantics. It may operate over the discovered bundled catalog manifests as a
set, because that set is defined by the deployment's catalog tap location.

The first boot migration is `2026-04-30-source-catalog-verbs`: it recompiles
already-installed local catalog verbs from their manifest source and replaces
stale trusted-local native/fixture rows. This repairs worlds that still contain
old `native` handler names after the demo catalogs moved to source-only verbs.

The second is `2026-04-30-catalog-placement-metadata`: it applies seed-hook
properties that older worlds are missing, including generic `auto_presence` and
`host_placement` metadata. These are catalog data values; runtime code must not
branch on the seeded object names that happen to receive them.

### CT5.4.2 Catalog status and drift diagnostics

Catalog status is a **read-only plan**, not a repair. Operator tooling may ask
the runtime to compare the live world against the manifest it would install or
repair from. The result reports:

- installed catalog record, alias, tap, installed version, and manifest version;
- pending local boot migration IDs for bundled `@local` catalogs;
- manifest drift: missing catalog objects, missing properties, verb source or
  metadata drift, parent drift, missing seed objects, and missing feature
  attachments;
- `needs_repair`, a summary boolean derived from the issues list.

`GET /api/catalogs` returns the ordinary installed catalog list plus a `local`
section for bundled catalogs known to the deployment. Remote GitHub tap status
uses the same comparison shape after the host has fetched a candidate manifest.

The diagnostic must not mutate the world and must not require catalog-specific
runtime branches. It is allowed to recompile manifest verb source for comparison,
because compile diagnostics are exactly what update/repair would encounter.
Repair/update remains an explicit sequenced operation through
`$catalog_registry`.

### CT5.5 Manifest shape

```jsonc
{
  "name": "dubspace",
  "version": "1.0.0",
  "spec_version": "v1",
  "depends": ["hughpyle/woo-libs:root-pack"],
  "classes": [
    {
      "local_name": "$loop_slot",
      "parent": "hughpyle/woo-libs:root-pack:$control",
      "flags": {"fertile": true},
      "properties": [{"name": "loop_id", "default": null, "perms": "rw"}, ...],
      "verbs": [{"name": "play", "source": "verb $loop_slot:play() {...}", "perms": "rxd", ...}, ...]
    },
    ...
  ],
  "features": [
    {
      "local_name": "$conversational",
      "parent": "$thing",
      "verbs": [...]
    }
  ],
  "schemas": [
    {"on": "$loop_slot", "type": "loop_started", "shape": {...}}
  ],
  "seed_hooks": [
    {"kind": "create_instance", "class": "$loop_slot", "as": "slot_1", "anchor": "the_dubspace"},
    {"kind": "attach_feature", "consumer": "the_chatroom", "feature": "$conversational"},
    {"kind": "change_parent", "object": "$wiz", "parent": "$programmer"},
    {"kind": "set_property", "object": "$system", "property": "help_dbs", "value": ["$help"], "mode": "append_unique"},
    ...
  ]
}
```

Catalog `perms` use the same authoring shorthand as source: `rxd` means install
with normalized `perms: "rx"` and `direct_callable: true`. Catalogs may also set
`direct_callable` explicitly; the explicit metadata field is the authoritative
stored form after install.

Class and feature objects may declare lifecycle `flags` for ordinary
authoring/template behavior. `fertile: true` means instances may be created
under the catalog class by actors who do not own the class object; deployed
instances created from seed hooks remain ordinary non-fertile objects unless
their own creation path sets flags separately.

Seed hooks are intentionally small. `create_instance` creates a named instance
from a catalog or dependency class, `attach_feature` appends a feature object to
a consumer, `set_property` writes a generic registry/configuration property, and
`change_parent` runs the normal authored `chparent` path for an existing object.
`set_property.mode` is one of `set`, `set_if_missing`, or `append_unique`;
`append_unique` is for registry lists such as `$system.help_dbs`, where catalogs
must add their object without knowing what other catalogs contributed. Catalogs
use `change_parent` only for explicit opt-in surface changes such as making
`$wiz` inherit a newly installed programmer class; it is not a hidden privilege
grant.

`set_property` hooks run with installer authority during install and repair.
Reviewers must treat them as wizard-authored property writes, especially when
`mode: "set"` targets an object that may already carry operator-customized
state. Prefer `set_if_missing` or `append_unique` for registry and extension
points; use `set` only when replacing the current value is the catalog's explicit
contract.

Seed/repair may also derive cache-shaped properties from the manifest's own
object data when the derivation is generic and name-free. The v1 room/exit
case: if a seeded object has a `source` property, that source object has an
`exits` map, and the seeded object has `.name` / `.aliases`, install/repair
adds those names to `source.exits`. This keeps exit aliases single-sourced on
the exit object while preserving the current map lookup. Duplicate alias claims
are refused with `E_CATALOG`.

The DSL source per verb is what enables the recompile-in-importing-world
discipline. Trusted local experiments may additionally include:

```jsonc
"implementation": { "kind": "native", "handler": "temporary_local_handler" }
// or
"implementation": { "kind": "fixture", "name": "temporary_fixture" }
```

Those implementation hints are trusted-local only. They are not part of the
portable public catalog contract. They exist for temporary bootstrap experiments,
not as the normal demo-app path; first-party chat, taskspace, and dubspace verbs
install from source alone.

---

## CT6. Versioning

Semantic versioning communicated via git tags. Tag format is `<catalog>-v<major>.<minor>.<patch>` so a single repository can host multiple catalogs without tag collisions.

- **Patch** — bug fixes; same shape; manifests are upgrade-safe.
- **Minor** — additive (new classes, new verbs); existing instances keep working.
- **Major** — breaking; importing world must explicitly opt in via `update` and may need migrations.

The `update` operation refuses by default if the major-version delta is non-zero; operators pass an explicit `accept_major: true` to proceed and acknowledge migration responsibility.

---

## CT7. Trust

Trust is rooted in **the operator's choice of which repo to install from**. v1 has no signing infrastructure; the operator inspecting the GitHub repo is the trust step.

- Public repos only, by URL.
- Optional commit-signature verification — deferred to v1.1; GitHub's UI shows verified commits today.
- Every runtime install/update is sequenced through `$catalog_registry` (§CT5.1) **and** logged as a wizard action ([cloudflare.md §R10.4](../reference/cloudflare.md#r104-wizard-audit)). Runtime uninstall uses the same rule once implemented. Boot-time local auto-install is direct deterministic bootstrap (§CT5.4). Both records carry the full provenance: tap, catalog, requested ref, **resolved commit SHA**, and SHA-256 hashes of the fetched manifest and README. A later operator can reconstruct exactly what bytes were installed even if the upstream tag has been moved or the branch has advanced.

When the operator says `tap install hughpyle/woo-libs:dubspace`, they are vouching for `hughpyle/woo-libs` as a source. Exactly the same trust model as `cargo install` from a git URL or `homebrew tap`.

---

## CT8. Naming collisions

Two catalogs can both define `$control`. Installing both with no aliases collides; the runtime rejects the second install with `E_NAME_COLLISION`. The fix: install one (or both) with an alias via the `as?` field.

The world's `$catalog_registry` shows installed catalogs and their aliases for introspection. References to a catalog's classes use `<alias>:<class>` (for in-world authoring) or the full form `<owner>/<repo>:<catalog>:<class>` (in manifests).

Runtime status: the first catalog lifecycle implementation rejects duplicate registry aliases, duplicate `(tap, catalog)` source identities, and global object-ref collisions with `E_NAME_COLLISION`. Fully alias-scoped class allocation for two catalogs that both define the same local class name is still pending; until then, aliasing prevents registry/source ambiguity but cannot install two class objects at the same concrete objref.

---

## CT9. Catalog-bound objects vs world-local objects

Imported classes are *templates* — they exist as objects but instances are world-local. A `dub:$delay` is a class; `the_dubspace`'s actual delay is `#delay_42` parented from `dub:$delay`.

Modifications: the importing world *may* override an imported class's verbs and properties (subject to permission), but those overrides are *local*. They do not propagate back to the catalog, and they are lost if the catalog is re-installed (with confirmation prompt to wizard).

The override pattern: `chparent` an instance to a local subclass that wraps the imported class. This is woo's normal mechanism; nothing special for catalogs.

**Uninstall** is intentionally conservative. A live world accumulates state — instances of imported classes may have local property values, references from other objects, log entries, anchored children, role-property assignments, and user-created relationships that the runtime cannot inspect for catalog provenance. Removing classes out from under that state risks orphaning verbs and breaking unrelated calls.

The v1 rule:

1. The operator runs `tap_uninstall { tap, catalog }`.
2. The runtime walks the catalog's classes and feature objects. For each, it checks for **live descendants** (any object whose `parent` is the class) and **live attached consumers** (any `$actor`/`$space` with the feature in its `features` list). If any are found, the call refuses with `E_HAS_DESCENDANTS` listing the offenders. The operator must reparent or detach explicitly first; the runtime offers no automatic reparenting in v1.
3. If there are no live descendants or attached consumers, the runtime removes the class objects, feature objects, and any registry-tracked seed instances *that have not been further referenced by world-local state*. A seed instance with non-catalog references (e.g., the operator wrote a verb that calls `the_dubspace:set_control`, and that verb still exists) likewise refuses.
4. The registry entry is not removed until step 3 succeeds; on refusal, the registry still shows the catalog as installed.

A `force?: true` flag is available wizard-only for cases where the operator accepts torn state — wraps the recycle in a wizard-audit log entry and proceeds. Default behavior is the safe path.

This is deliberately stricter than the previous "remove unless they have non-catalog descendants" rule: live state, references, log entries, and feature attachments all count. The cost is that operators must clean up before uninstalling; the benefit is that uninstall never silently breaks a working world. (Generic uninstall-while-preserving-instances with automatic reparenting is deferred — see §CT10.)

---

## CT10. What's deferred

- **Private repo support.** GitHub auth tokens, fine-grained permissions, deployment-scoped secrets. Public repos only in v1.
- **Local caching of fetched manifests.** Every install/update fetches fresh. Caching adds invalidation complexity for marginal benefit.
- **Transitive dependency resolution.** `depends` declares hard prerequisites, but operators install dependencies explicitly. v2 may add a constraint solver.
- **Cross-spec-version migration tooling.** A catalog published against spec v1.0 may not load cleanly on v1.5 if signatures changed. Today: refuse with `E_SPEC_VERSION_MISMATCH`. Future: a migration manifest.
- **Catalog uninstall while preserving instances.** Tricky — instances of imported classes lose their parent. Operators handle reparenting manually for v1.
- **Commit signature verification.** GitHub already does this server-side; the runtime can optionally check `gpg`-verified commits via the GitHub API. Deferred.
- **Decentralized distribution** (IPFS, peer-to-peer). All taps are HTTPS GitHub URLs in v1.
- **Catalog forking conventions.** Standard GitHub forks work; namespacing fork attribution and version compatibility hasn't been specced.
- **Authoring → publish loop.** A wizard verb that *exports* the world's local objects into a manifest, ready to commit to a repo. Worth building once the install path is solid; not in v1.

---

## CT11. Tool manifests (agent ecosystem)

External agents (Claude via MCP, OpenAI tool-calling, generic OpenAPI clients) discover capabilities via **per-catalog tool manifests**. The runtime does not invent a manifest format; it emits standard MCP tool schemas (or OpenAPI fragments) generated from the catalog's verb signatures.

A catalog may ship `agent_manifest.json` alongside `manifest.json`. Schema (sketch):

```json
{
  "format": "mcp/0.1",
  "tools": [
    {
      "name": "dubspace.set_control",
      "description": "Set a control value on the dubspace.",
      "inputSchema": { "type": "object", "properties": {...}, "required": [...] }
    },
    ...
  ]
}
```

**Tool exposure is explicit, not derived.** `direct_callable: true` means a verb is invokable via the REST `direct` path without sequencing — it does *not* mean the verb is a useful or safe agent tool. Auto-deriving tool exposure from `direct_callable` would expose internal utility verbs (introspection, presence helpers, low-level mutators) to agents indiscriminately.

A verb is exposed as an agent tool only if **either**:

- The catalog's `agent_manifest.json` lists it explicitly with a description and input schema, or
- The verb metadata carries `tool_exposed: true` (a separate flag from `direct_callable`). Catalogs that prefer per-verb annotation over a separate manifest opt in this way; the runtime then auto-generates a tool manifest entry from the verb's `arg_spec` and accompanying doc-comment.

A catalog with neither `agent_manifest.json` nor any `tool_exposed: true` verbs is invisible to agent tool discovery — that's the safe default. Operators who want to expose a catalog's tools but lack publisher cooperation can install a thin local catalog that wraps the upstream's verbs with `tool_exposed: true` annotations.

**World-level discovery** aggregates per tap:

```
GET /.well-known/mcp.json                    → all installed catalogs' tools
GET /.well-known/mcp.json?tap=hughpyle/woo-libs:dubspace  → just that catalog
GET /.well-known/mcp.json?tap=@local         → bundled local catalogs
```

This namespaces external tool discovery cleanly: agents subscribe to versioned, named, operator-vouched tool surfaces, not "every direct-callable verb in the world." The aggregation root is the catalog, not the world.

Strongly typed verb signatures (return types, raised errors, named-arg shapes) would tighten the auto-generated manifests. The minimum bar is `arg_spec` as it stands today; richer signatures land when external integration pressure proves what's needed (see [LATER.md](../../LATER.md)).

---

## CT12. Catalog UI

A catalog may ship **UI components alongside its code** — control surfaces for
its classes, dashboards, frame declarations, custom renderers, and observation
handlers for the observations it emits. The dubspace catalog's mixer panel,
the taskspace catalog's Kanban view, a pinboard catalog's spatial board, and a
chat catalog's transcript renderer are natural extensions of "the things this
catalog provides."

**Status: draft.** The browser client framework is specified in
[protocol/ui-component-model.md](../protocol/ui-component-model.md). It defines
the `manifest.json` `ui` extension, executable ESM UI modules, the Web
Component ABI, declarative frames, item renderers, observation normalization,
projection reducers, and component observation subscriptions.

Catalog UI follows the same catalog lifecycle as code:

- **Directory shape**: UI modules normally live under a catalog-local `ui/`
  directory and are referenced from `manifest.json`.
- **Distribution discipline**: non-local UI modules are pinned by content hash
  at install/update time.
- **Per-catalog mounting**: the browser resolves frames and components through
  the installed catalog registry rather than through hardcoded demo tabs.
- **Versioning + trust**: UI changes ride along with catalog versions and are
  wizard-installed trusted client code.

Authors picking up the repo should expect their first-party UI work (the dubspace mixer, the taskspace board, the chat transcript) to migrate from `src/client/` into their respective catalogs once the framework exists. The current bundled client is a v1 expedient, not an architectural choice.

---

## CT13. Authority and ownership

Catalog installs introduce code into the world. Who owns that code, and whose authority does it run with, are subtle and load-bearing questions.

### CT13.1 Ownership of imported objects

Every class, feature object, and seed instance created by a catalog install is **owned by the actor who issued the install** (typically `$wiz`, since installs are wizard-only by default). The owner field is recorded at install time and persists for the object's lifetime.

This means:

- An imported class is owned by the operator who installed the catalog. Recycling, reparenting, or deleting it follows the standard ownership rules ([permissions.md §11.1](../semantics/permissions.md#111-ownership)).
- A future operator who installs a different catalog does not gain ownership of the first catalog's classes.
- A wizard who installs a catalog "as themselves" rather than `$wiz` is unusual but supported — the resulting classes are owned by that wizard and can be recycled by them without further wizard authority.

**The catalog publisher is *not* a principal in the importing world.** They are a source. Their identity is recorded in `install_provenance` (the GitHub `<owner>/<repo>`) but does not become an actor in the world. Verbs imported from a catalog do not run with the publisher's authority — they run per the standard `progr` rule (§CT13.2).

### CT13.2 `progr` for imported verbs

A verb imported from a catalog runs with `progr = <verb_owner_at_compile>`, exactly as for any other verb ([permissions.md §11.4](../semantics/permissions.md#114-effective-permission)). The verb owner is set at install time to the actor who issued the install. So:

- A catalog installed by `$wiz` produces verbs whose `progr` is `$wiz`. Those verbs run with wizard authority.
- A catalog installed by a non-wizard programmer (if a world's policy permits) produces verbs whose `progr` is that programmer. The verbs run with that programmer's authority — they cannot do anything the installing actor couldn't do directly.

**This is the load-bearing rule.** Catalog publishers cannot smuggle elevated authority into the importing world. The maximum authority a catalog's code achieves is the authority of the actor who installed it.

### CT13.3 Feature attachment under catalogs

Per [features.md §FT3](../semantics/features.md#ft3-frame-state-inside-a-feature-verb), feature verbs run with `progr = feature_verb_owner`. Combined with §CT13.2:

- A catalog's `$conversational` feature, installed by `$wiz`, has `progr = $wiz` for every feature verb. Attaching it to *any* consumer (including non-wizard consumers) causes those verbs to run with wizard authority through the consumer.
- This is *exactly* the FT3 contract — features confer authority. The catalog story doesn't change the rule, just makes it more visible at scale.
- Feature catalogs are **powerful and dangerous**. A wizard installing a feature catalog from an untrusted source effectively grants that source's verb authors wizard-level capability on every consumer.

The mitigations:
- Operators inspect the manifest before install (the GitHub-tap model surfaces this naturally — the source is browsable).
- Catalogs declare their `direct_callable` and `tool_exposed` flags conservatively (§CT11).
- The catalog's `:can_be_attached_by` policy verb (per FT5) gates who can attach the feature; well-behaved feature catalogs ship a non-trivial policy rather than the default owner-only check.

### CT13.4 Ownership transitions

If the installing actor is later recycled (e.g., a guest operator who installed a catalog while logged in as `$wiz`, then disconnected), the imported objects retain their owner reference, which becomes a dangling ref per [recycle.md §RC5](../semantics/recycle.md#rc5-dangling-references). The objects continue to function (`progr` is captured at compile, not resolved at call time), but ownership-gated operations against them will fail until a wizard reassigns ownership via the standard mechanism.

For installs by ephemeral actors (guests, soon-to-expire sessions), operators should reassign ownership to a stable principal (`$wiz` or a dedicated `$catalog_admin`) immediately after install. A `wiz:reassign_catalog_owner(catalog, new_owner)` convenience verb is recommended but not normative.

---

## CT14. Migrations

Persistent worlds mean catalog upgrades affect live state — instances created by `v1.0` may not be valid under `v2.0` if the class shape changed. A serious ecosystem needs migration conventions as mature as database migration tooling.

v1 ships **the contract** plus a first runtime slice. The runtime can already record update provenance, gate major updates, expose `migration_state`, and run the idempotent structural steps listed as implemented below. Rich transforms and custom migration code remain publisher/operator tooling work.

### CT14.1 Migration manifests

A catalog publishing a major-version bump (e.g., `dubspace-v1.x.x` → `dubspace-v2.0.0`) ships a sibling file `migration-v1-to-v2.json` in the same `catalogs/<catalog>/` directory. The Worker fetches this alongside `manifest.json` when an `update` resolves to a major bump. A worked example covering every implemented step kind is checked in at [`spec/discovery/migration-example.json`](migration-example.json) — copy it as a starting point.

```jsonc
{
  "from_version": "1.x.x",
  "to_version": "2.0.0",
  "spec_version": "v1",
  "steps": [
    {
      "kind": "rename_property",
      "class": "$loop_slot",
      "from": "loop_id",
      "to": "loop_ref"
    },
    {
      "kind": "transform_property",
      "class": "$delay",
      "name": "feedback",
      "transform": "verb(old) { return clamp(old, 0.0, 1.0); }"
    },
    {
      "kind": "drop_verb",
      "class": "$loop_slot",
      "verb": "deprecated_play"
    },
    ...
  ]
}
```

### CT14.2 Step kinds (v1)

The v1 migration vocabulary is intentionally minimal. Runtime status is listed per step:

- `rename_property` — implemented; renames a property across a class and its descendants, preserving local instance values.
- `drop_property` — implemented; removes a property definition and local values across a class and its descendants.
- `add_property` — implemented; adds a class property with a default; inherited instances see the default.
- `rename_verb` — implemented for verbs defined directly on the named class.
- `drop_verb` — implemented for verbs defined directly on the named class; callers fail with `E_VERBNF`.
- `change_parent` — implemented through the normal authored `chparent` path.
- `rename_class` — deferred; changing corename/object identity safely requires object-reference migration.
- `transform_property` — deferred; needs typed transform compilation and metering discipline.
- `custom` — deferred; needs a stable migration-verb execution contract.

Anything more complex requires a custom migration verb, declared as `kind: "custom"` with a `verb` body in DSL source. Custom steps run with the install actor's authority, like any other catalog code.

### CT14.3 Execution

A major-version `update` runs migration steps inside `$catalog_registry`'s sequenced call, in declared order. Each step is wrapped in a savepoint. If a step fails, the migration body catches the error, rolls back only the failing step's savepoint, records `migration_state`, emits `migration_failed`, and returns normally. That means the registry call itself commits with `applied_ok=true`; completed earlier steps remain committed and the registry log records exactly where the migration stopped.

This is deliberately **not** the same as an unhandled behavior failure. If the migration body lets the error escape, the standard `$space:call` failure rule applies and the whole behavior savepoint rolls back. Catalog migration code must catch step failures when it wants the partial-progress semantics described here.

Recovery from a failed migration is operator work in v1. The registry exposes `:migration_state(catalog)` returning `{from_version, to_version, completed_steps, failed_step?}` so operators can either complete the migration manually or roll back to a backup.

### CT14.4 Idempotency

Migration steps must be **idempotent** — running them twice is safe. This is the recovery story: if step N fails, the operator fixes the underlying issue (data, code, environment) and reruns the migration; steps 1..N-1 no-op (rename to a target that already has the target name; transform a value already transformed; drop a property already dropped). The runtime does not enforce idempotency; catalog publishers attest to it.

### CT14.5 Operator practice: one catalog per window

Catalog migrations are scoped to the classes, properties, and verbs that catalog defines. They run inside `$catalog_registry`'s sequenced call and do not touch the runtime, the universal seed, or other catalogs' types. There is no technical reason to bundle multiple catalog updates into a single maintenance window, and several reasons not to:

- A failing migration only affects its own catalog's instances; recovery (`migration_state`, manual repair, or rollback to backup) is contained.
- Independent publishers ship at independent cadences; coupling them at the operator layer recreates the dependency the catalog model was designed to avoid.
- The blast radius an operator must reason about during an incident is smaller.

Operators **SHOULD** apply catalog updates one at a time: install/update, verify (`migration_state`, smoke-test the affected verbs), then move on. Multi-catalog windows are an exception that requires explicit justification — typically a coordinated breaking change across two catalogs that share types via `depends`. Cross-catalog migration coordination is otherwise deferred (§CT14.6) and is the operator's manual responsibility today.

This practice composes with the deployment lifecycle: catalog updates are *not* runtime deploys ([deployments.md §DP6](../operations/deployments.md#dp6-rolling-vs-bluegreen)). They run as live-world calls against an unchanged runtime and do not require the rolling/blue-green dance.

### CT14.6 What's deferred

- **Rollback to prior version.** Major downgrades are not in v1. A failed migration can be repaired forward but cannot reliably undo earlier migration steps. Backups are the recovery path; backups, snapshots, and the export tooling are spec'd separately ([backups.md](../operations/backups.md)).
- **Cross-catalog migrations.** A migration that requires another catalog to be at a specific version is hard to express in v1's `depends` model. Defer.
- **Schema-typed property migrations.** Without typed verb signatures (§CT11 closing note), the `transform_property` step takes the old value as untyped data. Typed migrations land when typed signatures do.
- **Rolling migrations on live worlds.** v1 migrations are operator-coordinated and may pause normal traffic while running. Online schema migration is post-v1.
- **Auto-generated migrations from manifest diffs.** Tooling for "compute the migration steps between v1.0 and v2.0 manifests" is useful but secondary; publishers write migrations by hand for now.

The principle: **migrations are the publisher's responsibility, recovery is the operator's, and the runtime provides the sequencing and audit substrate.** This matches the rest of woo's discipline — the runtime guarantees minimal primitives; user/publisher code does the domain-specific work.

---

## CT15. Bundled catalogs in this repo

The catalogs under `catalogs/` ship with this repository for two distinct purposes. None is privileged by the runtime — each installs through the same `@local:<name>` path that any third-party catalog uses — but their roles for an operator are different:

| Catalog | Role | Ship for general deployment? | Notes |
|---|---|---|---|
| `help` | **Foundational utility** | Yes | In-world help-database framework (`$help_db`). Other catalogs append entries; chat depends on it. |
| `chat` | **Foundational utility** | Yes | Provides `$conversational`, `$transparent`, and `$semitransparent` feature objects, `$match` (text-to-action scaffold), `$room`/`$exit` (room geography), `$chatroom` template, and `$portable`/`$furniture` base classes. **Seeds no instances** — install `demoworld` for the bundled Living Room demo. |
| `note` | **Foundational utility** | Optional | Generic portable text-bearing thing. Subclassed by pinboard pins; useful as a standalone primitive. |
| `prog` | **Foundational utility** | Optional | Builder/programmer authority tooling for in-world authoring. Required only for worlds that allow runtime programming. |
| `demoworld` | **Demo seed** | No | The first-light demo's seed catalog: `$cockatoo` class plus the populated Living Room / Deck / Hot Tub set with exits, props, and the cockatoo. Owns the mount-point rooms that `dubspace` and `pinboard` reference. |
| `dubspace` | **Demo application** | No | Shared dub-mix sound space. Seeds `the_dubspace` mounted in `demoworld:the_chatroom` with `chat:$transparent` attached; depends on `chat` + `demoworld`. |
| `taskspace` | **Demo application** | No | Hierarchical task coordination. Seeds `the_taskspace` with `chat:$transparent` attached; depends on `chat` only (does not mount in any demoworld room). |
| `pinboard` | **Demo application** | No | Spatial bulletin board. Seeds `the_pinboard` mounted in `demoworld:the_deck` with `chat:$transparent` attached; depends on `chat` + `note` + `demoworld`. |

**Foundational utilities** are reusable building blocks: a typical operator-deployed world will install some or all four. **Demo applications** are illustrative and runnable but are not part of the core feature set. The **demo seed** catalog (`demoworld`) is a thin wiring layer: it picks the names, locations, exits, and props that make the bundled demo a coherent place. An operator who wants the foundational classes without the bundled demo installs the four foundational catalogs and stops.

The list above is **not exhaustive** of catalogs woo can run. Any GitHub-tap catalog can be installed alongside or instead of the bundled set; the runtime treats them identically. Specs that mention `$dubspace`, `$taskspace`, `$chatroom`, or other bundled-catalog classes by name use them as concrete examples — the contracts they illustrate apply to any catalog of the same shape.

**Class library vs seed catalog distinction.** The split exists for dependency management. A catalog that defines classes (a "class library") should not seed instances unless those instances are tied to the class's identity. A catalog that opinionates a populated world (a "seed catalog") should seed but not define new classes beyond what its seeds need. `chat` is a class library after this refactor; `demoworld` is a seed catalog. `dubspace`, `taskspace`, `pinboard` mix both today because they're small enough that the split would be more friction than value — but the same separation is available to publishers who want it.
