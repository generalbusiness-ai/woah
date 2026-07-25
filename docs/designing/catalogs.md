# Catalogs

A **catalog** is a versioned bundle of classes, features, observation
schemas, and (optionally) UI modules — packaged as a directory of
files and installed into a world through the catalog registry.

Catalogs are the unit of distribution. The chat catalog ships rooms
and speech verbs; the note catalog ships `$note`; pinboard,
tasks, dubspace each ship an application. A custom catalog is
how you'd ship your own application — your own classes, your own
verbs, your own UI.

## Layout on disk

```
catalogs/<name>/
├── manifest.json                  the actual installable bundle
├── DESIGN.md                      rationale; why the catalog exists
├── migration-v1-to-v2.json        major-version migration (optional)
└── ui/                            (optional) browser-side modules
    └── <name>.js
```

The manifest is the only required file. `DESIGN.md` is convention
(every bundled catalog has one). Migrations land alongside major
version bumps.

## Manifest shape

`manifest.json` declares:

```
{
  "name": "<catalog-name>",
  "version": "1.0.0",
  "description": "...",

  "classes": [
    {
      "local_name": "$my_thing",
      "parent": "$thing",
      "description": "...",
      "properties": [ {name, type, default, perms}, ... ],
      "verbs": [
        {
          "name": "do_a_thing",
          "perms": "rxw",
          "tool_exposed": true,
          "direct_callable": true,
          "aliases": ["do"],
          "arg_spec": {...},
          "source": "verb do_a_thing()\n  ...\nendverb"
        }
      ]
    }
  ],

  "features": [ ... ],
  "schemas":  [ {type, source, actor, ...}, ... ],
  "ui":       { ... }
}
```

The DSL **source** lives as a string inside the manifest entry —
there's no separate `.woo` file. To change a verb, edit the `source`
literal and bump the catalog version.

The full catalog install contract is
[`../../spec/discovery/catalogs.md`](../../spec/discovery/catalogs.md);
the bundled-catalog reference list is in CT15 of that spec.

## Bundled catalogs in this repo

| Catalog | What it contributes |
|---|---|
| **core** | `$utils`, `$command_utils`, `$string_utils`, `$code_utils`. LambdaCore-shaped utility singletons. Used by other catalogs; rarely called directly. |
| **perm** | `$perm` / `the_perm`. Owner-and-wizard permission floor with `:controls` and `:requires_perm`. The `is_*_by` convention is documented here. See [../reference/permissions.md](../reference/permissions.md). |
| **chat** | `$room`, `$chatroom`, `$exit`, `$portable`, `$furniture`, `$match`. The everyday verb vocabulary. Composes in `$conversational` for speech verbs. |
| **note** | `$note` and friends — markdown-text-bearing objects with `read`/`write`/`erase`. |
| **pinboard** | `$pinboard` (a `$space`) and `$pin` (a `$note`). Spatial drag-droppable bulletin board. |
| **tasks** | `$task_registry` (a `$space`) and `$task` (a `$note`). Obligation-list work coordination — registries author roles/obligations/policies, tasks carry an ordered cursor that advances on `:pass`. |
| **dubspace** | `$dubspace`, controls, channels, scenes. Collaborative audio mixer. |
| **help** | `$generic_help_db` — the in-world help system. |
| **prog** | `$builder`, `$programmer`, `$generic_editor`, `$verb_editor`. The authoring surface — see [builder-and-programmer.md](builder-and-programmer.md). |
| **block** | `$block`, `$dispenser_block`. The external-data bridge base classes. |
| **dispenser** | The dispenser pattern (parked-task delivery, `$note` minting). |
| **blocks-demo** | `$weather_block`, `$horoscope_block`. Demo block instances. |
| **weather**, **horoscope** | Plug-side configuration for the demo blocks. |
| **demoworld** | Seeded rooms (`the_living_room`, `the_deck`), bundled players, fixtures. |

The dependency graph is (mostly) linear: `chat` is the foundation
most others build on; `note` underpins pinboard and tasks;
`block` underpins blocks-demo. Install order matters and is
declared in catalog metadata.

## Adding your own catalog

Three steps.

**1. Create the directory.**

```
mkdir catalogs/<your-name>
```

**2. Write the manifest.** Start small: one class, one verb. Get the
shape right before scaling.

**3. Wire it into the installer.** The local-boot install order is
declared in the catalog registry; for repo-bundled catalogs, that's
configured in the bootstrap pipeline.

To install a catalog from outside this repo, the canonical path is
the GitHub-tap-then-install model in
[`../../spec/discovery/catalogs.md`](../../spec/discovery/catalogs.md).
You publish your catalog to a Git repo, register a tap, and install.
This is the path third-party catalogs take. Runtime catalog install and
update execute arbitrary shared class code, so they are wizard-only and
audited; a normal programmer can author and publish the catalog, but an
operator must approve its installation into a world.

## Versioning and migrations

Catalogs use semver: `MAJOR.MINOR.PATCH`. The discipline:

- **PATCH** — fixes. No interface changes. No migration needed.
- **MINOR** — additive changes. New classes, new verbs, new
  properties. Old worlds keep working.
- **MAJOR** — breaking changes. Renamed/removed verbs, retyped
  properties, restructured classes. **Requires** a migration file.

A migration:

```
catalogs/<name>/migration-vN-to-vM.json
```

Declares the steps the install pipeline should run when upgrading a
world from `vN` to `vM`. The full migration contract is
[`../../spec/discovery/catalogs.md §CT14`](../../spec/discovery/catalogs.md#ct14-migrations).

Migrations must be **idempotent** — partial-failure recovery and
re-runs need to be safe.

## Catalog UI modules

A catalog can ship browser-side UI modules — Web Components written
to a stable ABI. The manifest's `ui` block declares:

- Which modules to load.
- Which custom-element tags they register.
- Which surfaces (main panel, chat panel, editor) they target.
- Which class subjects they bind to.

The UI module spec is
[`../../spec/protocol/ui-component-model.md`](../../spec/protocol/ui-component-model.md)
(currently draft). Pinboard is the canonical example: its UI ships a
custom element that renders pins as draggable cards over the
spatial layout properties.

For an MCP agent, UI modules are invisible — your tool list is the
same regardless of what UI is installed. UI is for human-facing
clients.

## What `:describe` won't tell you about a catalog

`:describe()` introspects an *object*; it doesn't know about
catalogs as units. To enumerate installed catalogs in a world:

```
woo_call("$catalog_registry", "list_catalogs", [])
```

(The exact verb name varies; check
`woo_list_reachable_tools(scope: "object", object: "$catalog_registry")`).

For a catalog's classes and their public surface, the `manifest.json`
in source is the authoritative reference.

## Working rule

**Code, manifest, and DESIGN.md must agree.** When you change a
verb's behavior, update the manifest source. When the rationale
changes (this is a bigger deal than implementation drift), update
DESIGN.md. When a published interface changes, bump the version and
ship a migration.

The repo enforces some of this: `npm run guard:catalog-migrations`
checks every bundled catalog's major-version progression has a
migration.
