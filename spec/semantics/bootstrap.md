---
date: 2026-05-03
status: implemented
---

# Bootstrap

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**. Sections §B3, §B4, §B6 (and parts of §B5) document **bundled local catalogs**; their roles — foundational utilities, demo seed (`demoworld`), and demo applications — are in [catalogs.md §CT15](../discovery/catalogs.md#ct15-bundled-catalogs-in-this-repo).

The seed object graph a world boots from. Lists every object that must exist before the first call lands: universal classes (anything that has objects needs them), catalog registry scaffolding for catalog-capable worlds, and the local-catalog objects used by the bundled demos.

This is the contract the implementation must produce on first start; without it, an implementer would invent structure.

---

## B1. Boot order

1. **Directory** is created first. Holds corename → ULID map and world metadata. Empty at boot until populated.
2. **`$system` (`#0`)** is created with the reserved ULID `00000000000000000000000000`. `parent = null`.
3. **Remaining universal seed objects** are created in dependency order: `$root` → `$actor` → `$player` → `$wiz` / `$guest`, `$sequenced_log` → `$space`, `$thing` → `$catalog`, plus `$catalog_registry` and `$nowhere`. Corenames registered in Directory.
4. **Configured local catalogs** are installed in dependency order. The bundled set is split between foundational class libraries (`@local:help`, `@local:chat`, `@local:note`, `@local:prog`), the demo seed catalog (`@local:demoworld`), and demo applications (`@local:dubspace`, `@local:pinboard`, `@local:taskspace`); see [catalogs.md §CT15](../discovery/catalogs.md#ct15-bundled-catalogs-in-this-repo) for roles. The normative source is the catalog manifests; bootstrap no longer hard-seeds demo classes and instances directly.
5. **Catalog scaffold and demo instances** are created by the configured local catalogs. The Living Room / Deck / Hot Tub set, `the_cockatoo`, exits, and props come from `@local:demoworld`. `the_dubspace` is seeded by `@local:dubspace` mounted in `demoworld:the_chatroom`; `the_pinboard` by `@local:pinboard` in `demoworld:the_deck`; `the_taskspace` by `@local:taskspace`. `:add_feature` calls attach `$conversational` to ordinary rooms and `$transparent` (from `chat`) to embedded demo spaces, running as wizard at boot and satisfying both attach-policy gates.
6. **Guest player pool** is pre-seeded so first connections don't need to mint identities.

Boot is idempotent: running it twice should be a no-op (each seed is created only if its corename isn't already mapped). This makes test setup and dev-restart trivial.

Every object created by bootstrap has a non-empty `description` value. The description is not marketing copy; it is operational context for readers, agents, and IDEs: what the object is for, what it composes, and how it fits into the seed graph. `$system` has its own local `description` because it is outside the `$root` inheritance chain; all ordinary seed objects inherit the slot from `$root` and override the value.

---

## B2. Universal seed inventory

Universal seed objects are present in every world before any catalog is
installed. They are not demo objects. `$nowhere` is included here because guest
reset and object recycling need a stable default location even in a world with no
local demo catalogs installed.

The current implementation uses the stable corenames below as object IDs and
preserves existing IDs on reboot. Seeded deterministic ULID allocation remains
the target for runtime-created objects, but it is not active in v1.

| Corename | Kind | Parent | Owner | Flags | Own state / definitions | Own verbs | Purpose |
|---|---|---|---|---|---|---|---|
| `$system` | singleton | none | `$wiz` | wizard | `description`; `wizard_actions=[]`; `bootstrap_token_used=false`; `applied_migrations=[]` | `:return_guest(guest)` | Bootstrap object and world registry root. It owns the reserved `#0` identity, carries wizard authority, and anchors world-level metadata. |
| `$root` | class | `$system` | `$wiz` | — | Defines `name`, `description`, `aliases`, `host_placement`, `help` | `:set_value(value)`, `:set_prop(name,value)`, `:describe()`, `:title()`, `:look_self()` | Universal base class for ordinary persistent objects. Most object parent chains terminate here before reaching `$system`. |
| `$actor` | class | `$root` | `$wiz` | — | Defines `features`, `features_version`, `focus_list` | `:add_feature(f)`, `:remove_feature(f)`, `:has_feature(f)`, `:huh(text,reason?,source?)`, `:wait(timeout_ms?,limit?)`, `:focus(target)`, `:unfocus(target)`, `:focus_list()` | Base class for principals that originate messages and carry actor-scoped features and MCP focus state. |
| `$player` | class | `$actor` | `$wiz` | — | Defines `home` | `:on_disfunc()`, `:moveto(target)`, `:tell(text)`, `:tell_lines(lines)`, `:help(topic?)`, `:who_all(names?)`, `:join_player(name)`, `:ways(room?)`, `:examine_detailed(name)` | Session-capable actor class for humans, agents, and tools connected over the wire. |
| `$wiz` | instance/class | `$player` | `$wiz` | wizard, programmer | Inherits player state; owns the seed graph | Inherits player/actor/root verbs | Seed administrator player used to bootstrap, inspect, and repair code, schema, and seeded objects. |
| `$guest` | class | `$player` | `$wiz` | — | Inherits player state | Overrides `:on_disfunc()` | Reusable temporary player class. Guest instances bind to short-lived sessions and return to the free pool on reap. |
| `$sequenced_log` | class | `$root` | `$wiz` | — | Inherits descriptive slots | Host operations `append(message)`, `read(from,limit)` | Append-only sequenced log base class. `$space` and registry-like coordination objects inherit its sequence/replay shape. |
| `$space` | class | `$sequenced_log` | `$wiz` | — | Defines `next_seq`, `session_subscribers`, `subscribers`, `last_snapshot_seq`, `features`, `features_version`, `auto_presence` | `:replay(from_seq,limit)`, `:add_feature(f)`, `:remove_feature(f)`, `:has_feature(f)` | Coordination base class: one local sequence, applied-frame history, present sessions/subscribers, and feature-extended direct verbs. Room composition is catalog-level behavior, not part of `$space`. |
| `$thing` | class | `$root` | `$wiz` | fertile | Inherits descriptive slots | `:can_be_attached_by(actor)`, `:moveto(target)` | Simple non-actor base for addressable stateful objects. Fertile so programmer actors can create ordinary owned objects. |
| `$catalog` | class | `$thing` | `$wiz` | — | Defines `catalog_name`, `alias`, `version`, `tap`, `objects`, `seeds`, `provenance` | Inherits root/thing verbs | Base class for installed catalog records. Instances record provenance and created refs for introspection and uninstall planning. |
| `$catalog_registry` | singleton space | `$space` | `$wiz` | — | Own values for `$space` state plus `installed_catalogs=[]` | `:install(manifest,frontmatter,alias,provenance)`, `:list()` | Sequenced registry space for catalog install/update/uninstall operations. See [catalogs.md §CT5](../discovery/catalogs.md#ct5-install). |
| `$nowhere` | singleton location | `$thing` | `$wiz` | — | Own `description`; inherits descriptive slots | Inherits root/thing verbs | Universal default-home location for disconnected guests, recycled objects, and objects whose home cannot otherwise be resolved. |

### B2.1 Common descriptive property definitions

The `name`, `description`, and `aliases` property definitions are installed on
`$root`, `$actor`, `$player`, `$sequenced_log`, `$space`, `$thing`, `$catalog`,
and `$catalog_registry` so these core classes each carry their own descriptive
slot definitions. `host_placement` is defined on `$root` and inherited by
ordinary descendants. `$system` has its own local `description` value because it
has no ordinary parent chain; `$nowhere` inherits descriptive slots from
`$thing`.

| Property | Type | Default | Notes |
|---|---|---|---|
| `name` | str | `""` | Human-readable. Not unique. |
| `description` | str | `""` | Long-form description. Surfaced by `:look`-like verbs. |
| `aliases` | list<str> | `[]` | Alternate names for command/match. |
| `host_placement` | str \| null | null | Defined on `$root`. Optional host-placement hint. `self` means this object owns its own host; anchored objects route to their anchor's host. Runtime semantics do not depend on this hint in single-host deployments. |
| `help` | obj \| list<obj> \| null | null | Defined on `$root`. Optional contextual help database or databases. `$player:help` includes this value from the actor and current-space ancestry when building its search path. |

### B2.2 `$system` own properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `description` | str | non-empty seed text | Local property value on `$system`, since `$system` has no `$root` parent to inherit a `description` slot from. |
| `wizard_actions` | list<map> | `[]` | Audit trail for privileged bootstrap and operational actions. |
| `bootstrap_token_used` | bool | false | Records consumption of the initial wizard bootstrap token. Lifecycle and rotation: [auth.md §A11](../identity/auth.md#a11-initial-wizard-bootstrap). |
| `applied_migrations` | list<str> | `[]` | Idempotency ledger for deployment-local boot migrations, including local catalog repair migrations. See [catalogs.md §CT5.4.1](../discovery/catalogs.md#ct541-local-boot-migrations). |
| `catalog_migration_records` | list<map> | `[]` | Trace ledger for content-addressed catalog schema/data plans. Records plan id, catalog, manifest hash, scope, host, steps, status, and postcondition issues. |
| `help_dbs` | list<obj> | `[]` | Global in-world help database list. The bundled help catalog appends `$help` here with a generic `set_property` catalog hook; future catalogs can append additional DBs without runtime object-name knowledge. |

### B2.3 `$root` verbs

| Verb | Returns | Purpose |
|---|---|---|
| `:describe()` rxd | map | Introspection (see [introspection.md](introspection.md)). |
| `:title()` rxd | str | Short identifying phrase for `:look`-style composition; default returns `this.name`. Subclasses override to add flair (e.g. `$cockatoo:title()` decorates with *"a sulphur-crested cockatoo perched on the mantelpiece"*). MOO/LambdaCore convention. |
| `:look_self()` rxd | map | Generic object view. Default returns the object's `:title()` and actor-readable `description`. MOO/LambdaCore convention adapted to structured return values. Actor and catalog classes may override for richer presentation. |
| `:set_description(desc)` rxd | bool | LambdaCore-shaped self-describe. Returns `true` on success. Allowed when `actor == this` (self-describe), `actor` owns `this`, or `actor` is a wizard. The verb is owned by `$wiz` so its `this.description = desc` write naturally bypasses the property's `r` perms; the explicit perm gate in the body keeps non-wizard callers from describing arbitrary objects. Tells the actor "Description set." on success. |
| `:set_value(value)` | any | T0 fixture-style helper for simple property update verbs. |
| `:set_prop(name, value)` | str, any | T0 fixture-style helper for simple named property update verbs. |

### B2.4 `$actor` additional properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `features` | list<obj> | `[]` | Feature objects contributing verbs to this actor. See [features.md](features.md). |
| `features_version` | int | 0 | Monotonic counter incremented on feature-list changes; used for verb-lookup cache invalidation. |
| `focus_list` | list<obj> | `[]` | Actor-scoped list of focused objects/spaces for MCP tool discovery and agent attention. |

### B2.5 `$actor` verbs

| Verb | Args | Purpose |
|---|---|---|
| `:add_feature(f)` | obj | Append to `features`; idempotent. See [features.md §FT5](features.md#ft5-adding-and-removing-features). |
| `:remove_feature(f)` | obj | Remove from `features`. |
| `:has_feature(f)` rxd | obj | Predicate. |
| `:look_self()` rxd | — | Actor-authored view. Returns the generic title/description plus `carrying`, and appends the current inventory sentence to `description`. This is woocode seeded on `$actor`, not a substrate special case. |
| `:huh(text, reason?, source?)` rxd | str, str?, obj? | Actor-owned parse-miss output. Emits a private `huh` observation to `this` with `source` naming the command surface when available. Default reason is `I don't understand that.` |
| `:wait(timeout_ms?, limit?)` rxd | int?, int? | MCP observation drain for the actor's session queue. Tool-exposed. |
| `:focus(target)` rxd | obj | Add an object/space to `focus_list`. Tool-exposed. |
| `:unfocus(target)` rxd | obj | Remove an object/space from `focus_list`. Tool-exposed. |
| `:focus_list()` rxd | — | Return the current focus list. Tool-exposed. |

### B2.6 `$player` additional properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `home` | obj \| null | `$nowhere` | Where this player returns on `:on_disfunc`. Defaults to `$nowhere` for universal players and guests. |

Session lifecycle is **not** carried on the player. Live session data lives only in `world.sessions` (see identity.md §I2); there is no `session_id` mirror property, and `attached_sockets` is similarly in-memory rather than persisted, so a host restart never resurrects stale attachments.

### B2.7 `$player` verbs

| Verb | Args | Purpose |
|---|---|---|
| `:look_self()` rxd | — | Player view. Calls `pass()` to inherit `$actor:look_self`'s carrying-aware shape, then appends one of three idle-status sentences modeled on LambdaCore: `<name> is sleeping.` when `is_connected(this)` is false; `<name> is awake and looks alert.` when connected and `idle_seconds(this) < 60`; otherwise `<name> is awake, but has been staring off into space for N minutes.` Connection and idle state come from `is_connected` / `idle_seconds` substrate builtins (see [builtins.md §19.7](builtins.md#197-sessions)). |
| `:on_disfunc()` | — | Disfunc hook called at session reap. Default body is a no-op; `$guest` overrides. See [identity.md §I6.4](identity.md#i64-guest-reset-the-on_disfunc-convention). |
| `:moveto(target)` | obj | Move this player to `target.contents`. Used by disfunc bodies. |
| `:tell(text...)` rxd | any... | Deliver text output directly to this player. This is the LambdaCore `notify`/`:tell` output path adapted to observations. |
| `:tell_lines(lines)` rxd | list | Deliver a sequence of text lines to this player. |
| `:help(topic?)` rxd | str? | Search contextual help DBs and global `$system.help_dbs`, then deliver rendered help lines to the player. Aliases: `?`, `info`, `information`, `@help`. |
| `:inventory()` rxd | — | Tell the player a one-line summary of `contents(this)` (LambdaMOO's "You are empty-handed." / "You are carrying X, Y, and Z.") and return `{items, text}`. Woocode seeded on `$player`. Aliases: `i`, `inv`, `inventory`. Tool-exposed. |
| `:home()` rxd | — | Send the player to `this.home` via `home:enter(this)`, so the destination's `enterfunc` and presence handling fire. No-ops with a tell when home is unset or already current. Woocode seeded on `$player`. Alias: `@home`. Tool-exposed. |
| `:who_all(names?)` rxd | str? | LambdaCore-shaped `@who`. With no args, lists connected players from live sessions; with args, resolves player names and reports those players, including sleeping players with best-available last-login time. Emits private text lines and a `who` observation, and returns structured rows with player, `connected`, `connected_at`, `connected_seconds`, `idle_seconds`, `last_login_at`, and location fields. Native until connected-player enumeration is DSL-exposed. Alias: `@who`. Tool-exposed. |
| `:join_player(name)` rxd | str | LambdaCore-shaped `@join <player>`. Resolves a player name globally, tells the caller a join message, moves the caller to that player's current location through `moveto`, emits leave/enter observations, and returns a move result with `look_deferred`. Native until global player matching is DSL-exposed. Alias: `@join`. Tool-exposed. |
| `:ways(room?)` rxd | str? | LambdaCore-shaped `@ways`. Lists obvious exits from the current room, or from a visible room named by the argument. Reads the room's `exits` map, filters unique exits whose `obvious` property is truthy, tells the caller a formatted "Obvious exits" line, and returns `{room, exits, text}`. Woocode seeded on `$player`. Alias: `@ways`. Tool-exposed. |
| `:examine_detailed(name)` rxd | str | LambdaCore-shaped `@examine <object>`. Resolves a visible object from the caller's command scope, tells name/owner/aliases/description/contents plus obvious command verbs, and returns the same data in structured form. Obvious verbs are readable verbs with command metadata, skipping dull base classes, matching the LambdaCore model of command-shaped affordances rather than a dump of all callable verbs. MCP uses the same obvious-verb projection for visible room contents. For visible remote objects, returns the host-summary subset available across the host bridge (`owner=null`, no obvious verbs) instead of failing local lookup. Native until verb-slot introspection and global formatting helpers are DSL-exposed. Alias: `@exam*ine`. Tool-exposed. |

### B2.8 `$guest` verbs

`$guest:on_disfunc()` overrides the default to reset state per [identity.md §I6.4](identity.md#i64-guest-reset-the-on_disfunc-convention): eject inventory to each item's `home` (or the disconnect room, then the guest home), move the guest to `home` (or `$nowhere`), clear `description`/`aliases`/`features`, and return to the free pool via `$system:return_guest(this)`.

### B2.9 `$sequenced_log` host operations

These are the native log operations that back `$sequenced_log` descendants.
They are host/repository primitives in the current implementation, not ordinary
bootstrapped object verbs. A fuller core may expose them as object-visible
wrappers later, but the v0 seed graph does not install `:append` or `:read`
directly on `$sequenced_log`.

| Operation | Args | Purpose |
|---|---|---|
| `append(message)` | any | Native; atomically allocates a seq and persists `(seq, message)`. See [sequenced-log.md §SL2](sequenced-log.md#sl2-the-native-host-operations). |
| `read(from, limit)` | int, int | Native; paged history read. |

### B2.10 `$space` additional properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `next_seq` | int | 1 | The next seq to assign. Reserved; written only by the host append primitive. |
| `session_subscribers` | list<map> | `[]` | Authoritative session presence entries, each `{session, actor}`. Maintained by session movement and `set_presence`. |
| `subscribers` | list<obj> | `[]` | Compatibility actor set derived from `session_subscribers`; used by older catalog/UI code while session-scoped routing is adopted. |
| `last_snapshot_seq` | int | 0 | Highest seq covered by a snapshot. Used for snapshot triggering and log truncation. |
| `features` | list<obj> | `[]` | Feature objects contributing verbs to this space. See [features.md](features.md). |
| `features_version` | int | 0 | Monotonic counter; verb-lookup cache invalidation. |
| `auto_presence` | bool | false | Legacy catalog flag retained for older installed worlds. New session placement is explicit: clients/catalog verbs call `:enter`/`moveto`, which updates the session current location and `session_subscribers`. New code should not rely on automatic runtime entry from this property. |

### B2.11 `$space` verbs

| Verb | Args | Purpose |
|---|---|---|
| `:replay(from_seq, limit)` rxd | int, int | Public wrapper over the host log read operation. |
| `:add_feature(f)` | obj | Append to `features`; idempotent. |
| `:remove_feature(f)` | obj | Remove from `features`. |
| `:has_feature(f)` rxd | obj | Predicate. |

The sequenced call lifecycle described as `$space:call` in the semantics docs is
the protocol/host entrypoint, not a bootstrapped object-visible verb in v0.
Likewise `snapshot`, explicit `subscribe`/`unsubscribe`, and `on_applied` remain
reserved conventions until the full core grows object-level wrappers for them.
Current movement/catalog verbs update `session_subscribers`; the runtime keeps
`subscribers` as a compatibility projection.

### B2.12 `$thing` verbs

| Verb | Args | Purpose |
|---|---|---|
| `:can_be_attached_by(actor)` rxd | obj | Feature-attachment policy hook. Default allows the feature object's owner; feature objects override when they need wider or stricter policy. |
| `:moveto(target)` | obj | Default LambdaCore-style moveto wrapper: delegates to the core `moveto(this, target)` pipeline, whose re-entry guard then runs `:acceptable`, `:exitfunc`, relocation, and `:enterfunc`. |

### B2.13 `$catalog` additional properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `catalog_name` | str | `""` | Manifest catalog name. |
| `alias` | str | `""` | Local install alias. |
| `version` | str | `""` | Installed catalog version. |
| `updated_at` | num | absent | Last successful runtime update timestamp. |
| `tap` | str | `""` | Tap or source identifier. |
| `objects` | map | `{}` | Created class/object refs keyed by manifest-local name. |
| `seeds` | map | `{}` | Created seed instance refs keyed by manifest-local name. |
| `provenance` | map | `{}` | Source metadata used for audit and update decisions. |
| `migration_state` | map | absent | Last update migration state, if any. |

### B2.14 Catalog registry

Catalog-capable worlds seed `$catalog` and `$catalog_registry` in addition to
the universal classes. `$catalog_registry` has the normal `$space`
properties plus registry state:

| Property | Type | Default | Notes |
|---|---|---|---|
| `installed_catalogs` | list<map> | `[]` | Installed catalogs with alias, version, provenance, owner, and created-object refs. |

Its current v1 seed verbs are
`:install(manifest, frontmatter, alias, provenance)`,
`:update(manifest, frontmatter, alias, provenance, options, migration?)`,
`:list()` (`rxd`), and `:migration_state(alias)` (`rxd`).
`:uninstall(tap, catalog)` is reserved for the fuller operations surface, but
is not boot-installed yet. All mutating verbs are wizard-only and are called
through `$catalog_registry:call(...)`; direct calls are denied except `:list()`
and `:migration_state()`.

### B2.15 `$nowhere`

`$nowhere` is a universal `$thing` singleton, not a demo instance. It has no
special flags and no own verbs beyond inherited `$root`/`$thing` behavior. It is
the default `home` for seeded players and guests, and the fallback destination
for disconnect cleanup and recycle-like flows when no more specific home is
available.

**Sink semantics.** `$nowhere.contents` is **not maintained**. `$nowhere` is
the documented exception to the bidirectional containment invariant in
[objects.md §4.3](objects.md#43-containment-and-cross-host-invariants): when an
object's `location` is set to `$nowhere`, only the object's own `location`
field is written; no RPC is sent to update `$nowhere.contents`. Reads of
`$nowhere.contents` return an empty list. This avoids a global write hotspot
(every disconnect, recycle-fallback, and reset would otherwise contend on
`$nowhere.contents`) and removes a cross-cluster write from the recycle apply
phase ([recycle.md §RC3](recycle.md#rc3-bookkeeping)). Code that needs to
enumerate "where did everyone go" must query each candidate's `location`
directly rather than relying on `$nowhere.contents`.

---

## B3. Local catalog: Dubspace classes

> **Non-normative.** The `dubspace` catalog is a **demo application**, not a foundational catalog (see [catalogs.md §CT15](../discovery/catalogs.md#ct15-bundled-catalogs-in-this-repo)). Its classes are documented here for reader convenience only; the canonical source is `catalogs/dubspace/manifest.json` and [`catalogs/dubspace/DESIGN.md`](../../catalogs/dubspace/DESIGN.md). A world without the demo will not have these classes.

| Corename | Parent | Anchor | Description |
|---|---|---|---|
| `$dubspace` | `$space` | n/a (own host) | Base class for shared dub-mix spaces. It composes `$space` sequencing with sound-control verbs for loop slots, mixer channels, filters, delay, and scene recall. |
| `$control` | `$root` | n/a | Base class for addressable controls in a sound surface. Controls are anchored into a containing space so sequenced messages can mutate the whole control cluster atomically. |
| `$loop_slot` | `$control` | n/a | Control class for a loaded loop slot. A loop slot stores the selected loop id, whether it is playing, and gain, and is driven by start/stop and control-change messages. |
| `$channel` | `$control` | n/a | Control class for mixer-channel state. The first demo keeps this intentionally small, with gain as the primary channel property. |
| `$filter` | `$control` | n/a | Control class for filter state. It currently models cutoff as a shared sequenced parameter in the dubspace control cluster. |
| `$delay` | `$control` | n/a | Control class for delay-effect state. It groups send, time, feedback, and wet mix so actors can shape echo gestures through ordinary sequenced messages. |
| `$drum_loop` | `$control` | n/a | Control class for a small step-sequenced percussion loop. It stores transport state, tempo, and an eight-step pattern for simple shared rhythmic play. |
| `$scene` | `$root` | n/a | Class for saved control snapshots. A scene records a named map of control object refs to property values so a dubspace can restore a known mix state. |

### B3.1 `$control` properties

| Property | Type | Default | Notes |
|---|---|---|---|
| `value` | float \| map | 0.0 or `{}` | Current control state. Type per subclass. |

### B3.2 `$loop_slot` properties

| Property | Type | Default |
|---|---|---|
| `loop_id` | str \| null | null |
| `playing` | bool | false |
| `gain` | float | 1.0 |

### B3.3 `$channel` / `$filter` / `$delay` properties

`$channel`: `gain` (float, 1.0).
`$filter`: `cutoff` (float, 1000.0).
`$delay`: `send` (float, 0.0), `time` (float, 0.25), `feedback` (float, 0.3), `wet` (float, 0.5).

### B3.4 `$drum_loop` properties

| Property | Type | Default |
|---|---|---|
| `bpm` | int | 118 |
| `playing` | bool | false |
| `started_at` | int | 0 |
| `step_count` | int | 8 |
| `pattern` | map<str, list<bool>> | `{kick, snare, hat, tone}` rows, each 8 booleans |

### B3.5 `$scene` properties

| Property | Type | Default |
|---|---|---|
| `name` | str | `""` |
| `controls` | map | `{}` |  Snapshot of all control values, keyed by control objref string. |

### B3.6 `$dubspace` verbs

| Verb | Args | Purpose |
|---|---|---|
| `:set_control(target, name, value)` | obj, str, any | Sequenced; sets `target.<name> = value`, emits `control_changed`. |
| `:save_scene(name)` | str | Captures current controls into a `$scene`. Emits `scene_saved`. |
| `:recall_scene(scene)` | obj | Applies a scene's controls. Emits `scene_recalled`. |
| `:start_loop(slot)` | obj | Sets `slot.playing = true`. Emits `loop_started`. |
| `:stop_loop(slot)` | obj | Sets `slot.playing = false`. Emits `loop_stopped`. |
| `:set_drum_step(voice, step, enabled)` | str, int, bool | Updates one row/step in the shared percussion pattern. Emits `drum_step_changed`. |
| `:set_tempo(bpm)` | int | Sets the shared percussion tempo. Emits `tempo_changed`. |
| `:start_transport()` | — | Starts the shared percussion transport by storing a space-owned `started_at` timestamp. Emits `transport_started`. |
| `:stop_transport()` | — | Stops the shared percussion transport. Emits `transport_stopped`. |

All these behaviors are reached through `$space:call`. In v0.5 the dubspace
catalog installs simple property-update behaviors as authored bytecode or
fixtures, and list/timer-heavy behaviors via trusted local `implementation`
hints until the VM can express them directly.

---

## B4. Local catalog: Taskspace classes

> **Non-normative.** The `taskspace` catalog is a **demo application** (see [catalogs.md §CT15](../discovery/catalogs.md#ct15-bundled-catalogs-in-this-repo)). Documented here for reader convenience; canonical source is `catalogs/taskspace/manifest.json` and [`catalogs/taskspace/DESIGN.md`](../../catalogs/taskspace/DESIGN.md). A world without the demo will not have `$taskspace` or `$task`.

| Corename | Parent | Anchor | Description |
|---|---|---|---|
| `$taskspace` | `$space` | n/a (own host) | Base class for spaces that coordinate hierarchical work. It extends `$space` with root task ordering and task-creation behavior for asynchronous human and agent collaboration. |
| `$task` | `$note` | n/a | Base class for taskspace work items. A task is also a note/card artifact, and stores title, description, status, assignee, requirements, artifacts, messages, parent linkage, and ordered subtasks. |

### B4.1 `$taskspace` additional properties

| Property | Type | Default |
|---|---|---|
| `root_tasks` | list<obj> | `[]` | Top-level tasks ordered. |

### B4.2 `$task` properties

| Property | Type | Default |
|---|---|---|
| `title` | str | `""` |
| `description` | str | `""` |
| `parent_task` | obj \| null | null | null = directly under taskspace root |
| `subtasks` | list<obj> | `[]` | Ordered. |
| `status` | str | `"open"` | One of: `open`, `claimed`, `in_progress`, `blocked`, `done`. |
| `assignee` | obj \| null | null | The claimer. |
| `requirements` | list<map> | `[]` | `[{text: str, checked: bool}, ...]`. |
| `artifacts` | list<map> | `[]` | `[{kind: str, ref: str, label?: str}, ...]`. |
| `messages` | list<map> | `[]` | `[{actor: obj, ts: int, body: str}, ...]`. |
| `space` | obj | (set at create) | The taskspace this task belongs to (for emit routing). |

### B4.3 `$taskspace` verbs

`:create_task(name, text)` returning the new task ref. Body is ordinary
catalog source: `create($task, actor)`, set task properties, append to
`root_tasks`, and emit `task_created` with `name` and `text`. Taskspace uses
the generic `create` builtin; no task-specific native runtime handler is
required.

### B4.4 `$task` verbs

| Verb | Args | Purpose |
|---|---|---|
| `:add_subtask(name, text)` | str, str | Creates a child task. Emits `task_created` and `subtask_added`. |
| `:move(parent, index)` | obj \| null, int | Re-parent or reorder; emits `task_moved`. |
| `:claim()` | — | Sets `assignee = actor`, status `claimed`. Emits `task_claimed`. |
| `:release()` | — | Clears assignee, status `open` unless already `done`. Emits `task_released`. |
| `:set_status(status)` | str | Sets status; non-`done` changes on claimed tasks require assignee or wizard. On `done` with unchecked requirements, also emits `done_premature`. Emits `status_changed`. |
| `:add_requirement(text)` | str | Appends to requirements. Emits `requirement_added`. |
| `:check_requirement(index, checked)` | int, bool | Updates checked. Emits `requirement_checked`. |
| `:add_message(body)` | str | Appends to messages. Emits `message_added`. |
| `:add_artifact(ref)` | map | Appends to artifacts. Emits `artifact_attached`. |

---

## B5. Local catalog: Chat classes and scaffolding

> The `chat` catalog is a **foundational utility** ([catalogs.md §CT15](../discovery/catalogs.md#ct15-bundled-catalogs-in-this-repo)): `$conversational`, `$transparent`, and `$semitransparent` (feature objects), `$match` (text-to-action scaffold), `$room`/`$exit` (room geography), `$chatroom` (template), and `$portable`/`$furniture` (base classes). It seeds **no instances** — the bundled Living Room demo lives in the separate `demoworld` catalog. Canonical source: `catalogs/chat/manifest.json` and [`catalogs/chat/DESIGN.md`](../../catalogs/chat/DESIGN.md). The classes below are documented for convenience; behavior is whatever the manifest installs.

| Corename | Parent | Anchor | Description |
|---|---|---|---|
| `$match` | `$thing` | n/a | Chat-shaped text-to-action scaffold. It tokenizes input, resolves visible objects, resolves verbs using runtime lookup, and returns structured command maps. Ordinary worlds can omit it if they do not expose text-command surfaces. |
| `$failed_match` | `$thing` | n/a | Stable sentinel returned by `$match:match_object` when no visible object matches. It is a value object, not an exception. |
| `$ambiguous_match` | `$thing` | n/a | Stable sentinel returned by `$match:match_object` when multiple visible objects match at the same priority tier. It lets callers ask users to disambiguate without exceptions. |
| `$conversational` | `$thing` | n/a | Feature object carrying chat verbs. Attached to `$actor`- or `$space`-descended consumers via `:add_feature($conversational)` per [features.md](features.md). Its verbs run with `this` = the consumer; observation routing uses the consumer space's session audience. |
| `$transparent` | `$conversational` | n/a | Feature object for acoustically transparent embedded spaces. It inherits chat verbs, forwards public local speech to `location(this)`, and receives parent room announcements through `:hear_parent_announce`. |
| `$semitransparent` | `$conversational` | n/a | Feature object for cone-of-silence embedded spaces. It inherits chat verbs and receives parent room announcements, but local public speech stays local. |
| `$room` | `$space` | n/a | LambdaCore-shaped room base. Owns room look composition, `exits`, direction verbs, announce helpers, and carry/drop verbs. |
| `$exit` | `$thing` | source room | First-class exit object with `source`, `dest`, and movement message properties. Direction verbs call room `:match_exit`, then invoke the matched exit. |
| `$chatroom` | `$room` | own host | Standalone room class. Chat behavior comes from `$conversational`; room geography and contents behavior come from `$room`. |
| `$portable` | `$thing` | n/a | Carryable object class used by the tiny room demo. |
| `$furniture` | `$thing` | n/a | Fixed room furnishing class used by the tiny room demo. |

### B5.1 `$match` verbs

All direct-callable (rxd). See [match.md](match.md) for exact matching rules.

| Verb | Args | Purpose |
|---|---|---|
| `:match_object(name, location?)` | str, obj? | Resolve visible objects; returns obj, `$failed_match`, or `$ambiguous_match`. |
| `:match_verb(name, target)` | str, obj | Resolve a verb using the same lookup rule as runtime dispatch. |
| `:parse_command(text, actor)` | str, obj | Parse free text into a structured command map for chat-shaped surfaces. |
| `:match_command_verb(cmd, target)` | map, obj | Resolve a command-pattern verb using `arg_spec.command`; returns a plan fragment or `$failed_match`. |
| `:plan_command(text, space)` | str, obj | Shared native-backed planner used by `$conversational:command_plan`. |

### B5.2 `$conversational` verbs

All direct-callable (rxd). Observations are live-only by route per [chat DESIGN.md](../../catalogs/chat/DESIGN.md).

| Verb | Args | Purpose |
|---|---|---|
| `:say(text)` | str | Emits `said`. |
| `:say_to(recipient, text)` | obj, str | Backtick-form directed public utterance (`` `recipient text ``). For player recipients, emits `said_to` (in-room directed speech). For non-player recipients defining `:on_say_to(text)`, dispatches there so the object can interpret the utterance as a command (e.g. `` `filter 500 `` calls `filter_1:on_say_to("500")`). The hook is named distinctly from `$player:tell` (B5.1) so the LambdaMOO output contract is not overloaded. |
| `:emote(text)` | str | Emits `emoted`. |
| `:tell(recipient, text)` | obj, str | Emits `told` to `recipient`. |
| `:look()` | — | Thin chat command wrapper over `this:look_at(this)`. |
| `:look_at(target)` | obj | Dispatches `target:look_self()`, emits private `looked` to the caller, and returns the structured view. `look <target>` routes here even when the target has no `:look` wrapper. |
| `:who()` | — | Returns the present-actor list. |
| `:enter(actor?)` | obj? | Adds presence; emits `entered`. |
| `:leave(actor?)` | obj? | Removes presence; emits `left`. |
| `:huh(text, reason?)` | str, str? | Compatibility wrapper. Delegates to `actor:huh(text, reason, this)` so parse-miss output remains actor-owned while old space-level callers continue to work. |
| `:command_plan(text)` | str | Compatibility wrapper around `$match:plan_command(text, this)`, returning a concrete direct/sequenced/huh route. |
| `:command(text)` | str | Compatibility command surface. It executes direct plans inline and sequenced plans through the resolved command space, returning the applied/error frame. Browser clients use wire `op:"command"` for the same server-side direct/sequenced execution path. |
| `:can_be_attached_by(actor)` | obj | Attachment policy. Bundled `$conversational` allows attachment by default; stricter feature objects override. |

### B5.3 `$room` / `$exit` verbs

`$room` follows the LambdaCore split: room verbs tell room occupants, and
`$player:tell` is the output path for individual players.

| Verb | Args | Purpose |
|---|---|---|
| `:look_self()` | — | Compose room title, description, present actors, and visible contents. Present actors are excluded from the contents list; `$block` descendants are the explicit exception because they are actor-backed appliances and should remain visible in-room. Pure view producer; the chat dispatcher emits private `looked`. |
| `:announce(text)` | str | Tell everyone in the room except `actor`. |
| `:announce_all(text)` | str | Tell every subscribed actor in the room. |
| `:announce_all_but(ignore, text, origin?)` | list, str, obj? | Tell every subscribed actor except those listed. `origin` is used by transparent nested spaces so parent announcement fan-out does not loop back into the originating child. |
| `:match_exit(name)` | str | Resolve a name through `this.exits`, returning an `$exit` or `$failed_match`. |
| direction verbs / `:go(exit)` | str | Find an exit object and call `exit:invoke()`. |
| `:acceptable(obj)` / `:enterfunc(obj)` / `:exitfunc(obj)` | obj | Default moveto hooks. |
| `:take(name)` / `:drop(name)` | str | Catalog woocode. Match visible/carryable objects and move them between room contents and actor inventory with `moveto`; emits `taken` / `dropped`. The substrate supplies matching and movement primitives, not the English or room command policy. |

`$exit:invoke()` calls `$exit:move(actor)`. `$exit:move(who)` sends private
leave/arrival text to `who`, calls `moveto(who, dest)`, and emits `left` /
`entered` observations to the source and destination rooms. The core `moveto`
path updates the calling session's current location and session presence.
It returns `{room: dest, from: source, exit, here_request: true,
look_deferred: true}`. Unlike LambdaCore's `$room:enterfunc`, legacy clients
that do not consume `here` must follow movement with `dest:look()`.

For v1, `this.exits` is still a map for fast lookup, but exit aliases are
declared on the `$exit` object. Local seed/repair expands the room map from
each exit's `.name` and `.aliases`; catalog authors should not duplicate alias
keys in both places. A future closer LambdaMOO model may replace the map with a
list of exits plus alias-scan and `$ambiguous_match` handling.

### B5.4 `$conversational` schemas

Declared at boot:

```woo
declare_event $conversational "said"    { source: obj, actor: obj, text: str };
declare_event $conversational "emoted"  { source: obj, actor: obj, text: str };
declare_event $conversational "told"    { source: obj, from:  obj, to:   obj, text: str };
declare_event $conversational "entered" { source: obj, actor: obj, room: obj, origin?: obj, exit?: str, text: str };
declare_event $conversational "left"    { source: obj, actor: obj, room: obj, destination?: obj, exit?: str, text: str };
declare_event $conversational "looked"  { source: obj, actor: obj, to: obj, room: obj, target?: obj, text: str, look: map };
declare_event $conversational "who"     { source: obj, actor: obj, to: obj, room: obj, present_actors: list<obj>, text: str };
declare_event $conversational "huh"     { source: obj, actor: obj, text: str, reason?: str };
```

Schemas describe shape only ([events.md §13](events.md#13-schemas)); durability is set by the route of the verb that emits each observation.

### B5.5 Feature attachment at boot

The bootstrap step that creates demo chat surfaces ends with:

```woo
the_chatroom:add_feature($conversational);    // running as wizard at boot
the_dubspace:add_feature($transparent);
the_pinboard:add_feature($transparent);
the_taskspace:add_feature($transparent);
```

---

## B6. Demo instances

> **Non-normative.** Listed here are seed instances created by the bundled **demoworld** seed catalog and the **demo application** catalogs (`dubspace`, `pinboard`, `taskspace`); see [catalogs.md §CT15](../discovery/catalogs.md#ct15-bundled-catalogs-in-this-repo) for roles. A world that installs only the foundational catalogs (`chat`, `help`, `note`, `prog`) will not have any of these instances. `$nowhere` is the exception — it is a universal seed object covered in §B2.15 and re-listed here only for the demo-comparison context.

| Corename | Class | Anchor | Description |
|---|---|---|---|
| `$nowhere` | `$thing` | n/a | Seed default-home for players whose `home` is null. Holds disconnected guests after `:on_disfunc` and any object reparented to `null` location during recycle. Wizard-owned, no contents-emitted observations. |
| `the_dubspace` | `$dubspace` | n/a (own host root) | The first runnable sound-space instance. It owns the sequenced coordination surface for four loop slots, one channel, one filter, one delay, and one default scene. |
| `the_taskspace` | `$taskspace` | n/a (own host root) | The first runnable task coordination space. It owns the sequenced timeline and anchored task tree used by people or agents to create, claim, discuss, and complete work. Boots with `features: [$transparent]` so `:say`/`:emote`/`:enter`/`:leave` are available alongside task verbs and public speech reaches the containing audience when mounted. |
| `the_chatroom` | `$chatroom` | n/a (own host root) | The first runnable chat room. Standalone surface for testing the chat client and `$match` parser; carries `features: [$conversational]` set at boot. |

For the dubspace, the demo creates the four loop slots, one channel, one filter, one delay, one percussion loop, and one scene as anchored children:

```
the_dubspace                          (own host; root of anchor cluster)
├── slot_1, slot_2, slot_3, slot_4    (anchor = the_dubspace)
├── channel_1                         (anchor = the_dubspace)
├── filter_1                          (anchor = the_dubspace)
├── delay_1                           (anchor = the_dubspace)
├── drum_1                            (anchor = the_dubspace)
└── default_scene                     (anchor = the_dubspace)
```

All control objects share `the_dubspace`'s host, so a `set_control` or sequencer call mutating any of them runs in one transaction.

The anchored dubspace objects also carry descriptions:

| Object | Class | Description |
|---|---|---|
| `slot_1`..`slot_4` | `$loop_slot` | A loop slot in the demo dubspace. It is anchored to `the_dubspace` and stores its loop id, playing state, and gain as part of the shared sequenced mix. |
| `channel_1` | `$channel` | Mixer channel for the demo dubspace. It is anchored to `the_dubspace` and contributes shared gain state to the current mix. |
| `filter_1` | `$filter` | Shared filter control for the demo dubspace. It is anchored to `the_dubspace` and exposes cutoff as a sequenced parameter. |
| `delay_1` | `$delay` | Shared delay control for the demo dubspace. It is anchored to `the_dubspace` and stores send, time, feedback, and wet mix values for collaborative echo gestures. |
| `drum_1` | `$drum_loop` | Eight-step percussion loop for the demo dubspace. It is anchored to `the_dubspace` and stores tempo, transport state, and a shared kick/snare/hat/tone pattern. |
| `default_scene` | `$scene` | Initial saved scene for the demo dubspace. It records a named control snapshot and gives scene recall a concrete object to read and rewrite. |

For the taskspace, no instances exist at boot — tasks are created at runtime by actor calls. All tasks anchor on `the_taskspace`, so the entire project lives on one host.

---

## B7. Guest player pool

A pre-seeded pool of `$guest` objects, e.g. `guest_1`..`guest_8`, exists at boot. Guest pool objects are operational seed instances, not universal classes. Each has `parent = $guest`, `owner = $wiz`, `location = $nowhere`, no special flags, a display `name` mirrored into the `name` property, a non-empty `description`, and `home = $nowhere`. When a client presents `auth { token: "guest:<random>" }`, `allocateGuest` assigns one of the unbound guest objects to the new session. The pool refills as sessions are reaped: `$guest:on_disfunc` resets the guest's state and returns it to the free pool via `$system:return_guest(this)` (identity.md §I6.4).

For the demo, 8 guests is enough for a small cohort. Real worlds would mint guests on demand or scale the pool to expected concurrent traffic. Each guest's description states that it is a pre-seeded temporary player and exists to give local users or agents a stable guest actor.

Allocation uses an explicit free pool, **not** "any guest with no live session" — the latter is what the v0.5 impl does and what causes pool exhaustion across restarts (every guest looks bound because its session record persisted past the dead connection). The free pool is in-memory and rebuilt at boot from "guests with no session in the session table."

---

## B8. Verb bodies

Universal bootstrap verbs are native or T0 bytecode where they are runtime primitives (`:describe`, guest reset, feature management, `:replay`). Demo verbs are installed from local catalog manifests. Where the current DSL can express the behavior, the installer compiles source to bytecode; where it cannot yet, trusted local manifests may carry an `implementation` hint pointing at a native handler or named fixture.

---

## B9. Idempotent rebooting

Every step of the boot sequence checks the Directory's corename map first; if the corename already maps to a ULID, the seed is skipped. This means:

- A fresh world creates everything.
- A restarted world finds everything already present and changes nothing.
- A partial-boot failure (server crashed mid-seed) recovers by re-running boot — only the missing seeds are created.

Wizards can run boot manually via a `wiz:rebuild_seeds()` verb; this fills any missing corenames without disturbing existing objects.
