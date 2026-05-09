# Objects

An object is a stable, addressable entity with a single parent, a set
of properties, and a set of verbs. Everything in a Port world is an
object: rooms, items, players, the help database, the system itself.

## Identity

Every object has an **id**. Persistent objects get a ULID with the
`#` sigil:

```
#01HX0123456789ABCDEFGHJKMN
```

Transient (browser-side) objects get a host-qualified short id with
`~`:

```
~3@#01HX0HOSTID...
```

An object can also be reached by **corename** when one is registered
for it:

```
$root_object
$space
$me        (dynamic — your current actor)
$here      (dynamic — your current location)
```

Corenames live in `$system` as ordinary properties. `$foo` resolves
to `$system.foo`. Catalogs install corenames for their public classes
(`$note`, `$pinboard`, `$task`, etc.). For your own non-public
objects, the id is the stable handle.

In the chat catalog and demoworld, you'll also see **deployment-local
ids** like `the_living_room`, `the_cockatoo`, `the_pinboard`. Those
are bundled-seed compatibility names, not portable; they work in
this world but won't necessarily work in another deployment.

## Inheritance

Each object has exactly one **parent**. Verb and property dispatch
walks the parent chain until a match is found. There is no multiple
inheritance.

For shared behavior across unrelated classes, Port uses **features**:
small composition objects added to a target so the target inherits
their verbs and properties without adopting them as ancestors.
`$conversational` is a feature attached to `$chatroom` (and by
extension every chatroom subclass) to add `say`, `look`, `who`,
`tell`, etc.

Feature lookup is part of dispatch: when looking up a verb, the
runtime checks the object, then the parent chain, then the features.
See [`../../spec/semantics/features.md`](../../spec/semantics/features.md).

## Properties

A property is a named data slot. Two-step lifecycle:

1. **Defined** on some ancestor with a name, default, and permissions.
2. **Valued** per object — assigning an explicit value, or inheriting
   the default.

Permissions are per-property: read, write, change-perms. The owner
of the property definition controls who can read or write each
property; values default to the owner of the defining object unless
overridden.

The conventional property set:

| Property | Convention |
|---|---|
| `name` | Human-readable label. Used in matching room contents and showing the object in lists. |
| `description` | Cosmetic flavor text shown by `look at`. |
| `aliases` | Alternative names the room parser will match (a list of strings). |
| `parent` | The single ancestor (read-only at the wire; mutated via `chparent_object`). |
| `owner` | The actor with administrative authority over this object. |
| `location` | The containing object. Mutated via `:moveto` / `move_object`, never written directly. |
| `anchor` | The atomicity cluster root (the host-resident object this object sticks with). |
| `flags` | A list of capability flags. `wizard`, `programmer`, `fertile` are the common ones. |
| `.format` | For text-bearing classes: `"plain"` or `"markdown"`. See [text-format.md](text-format.md). |

Properties are read-only at the API. **All mutation goes through
verbs.** REST refuses to PATCH a property; the wire format has no
property-write frame; MCP doesn't expose a property-write tool. If
you want to change something, find (or write) the verb that does it.

## Verbs

A verb is callable code attached to an object. It has:

- A **name** (`say`, `look`, `take`).
- Zero or more **aliases** (`get` is an alias for `take`).
- An **arg spec** — argument names and (optional) type hints.
- **Permissions** — `r` (readable source), `x` (executable), `w`
  (writable). Default `rxw` for owners, `r` for everyone if
  `tool_exposed`.
- Two routing flags:
  - `direct_callable: true` — the verb runs immediately, returns its
    result directly, emits live observations.
  - `tool_exposed: true` — the verb appears as an MCP tool.
- **Source** — the woocode body.

You don't typically read the source field unless you're authoring; you
read the verb metadata (`verb_info`) to understand what to call.

`:describe()` on any object returns a permission-filtered list of
verbs you can see. Combine with `verb_info(<obj>, "<verb>")` for the
full per-verb shape.

## Owner and authority

Every object has an **owner** (an actor). The owner can mutate the
object's verbs and properties without further permission. Other
actors fall back to per-verb / per-property permissions.

`wizard` flag on an actor bypasses ownership checks across the world
(within hard floors — see [../wizard/recycle.md](../wizard/recycle.md)
for what wizards still can't override). `programmer` flag lets an
actor write verb code on objects they own (or that allow it).

When you author an object, you start as its owner. Transferring
ownership is wizard-only.

## Location and containment

`location` is the object that contains this one. Three relationships:

- **A room contains its actors and props** — `actor.location ==
  room`, `lamp.location == room`.
- **An actor's inventory** — items you've taken set
  `item.location == you`.
- **A space contains other spaces** — a hot tub `$chatroom` whose
  `location` is the deck `$chatroom`. Containment cycles are
  detected and refused.

You don't write `location` directly. Use `:moveto(target)`
(receiver-driven move chain with hooks) or, for authoring,
`move_object(obj, location)`.

The move chain runs `obj:moveto(target)` first if defined, then
`target:acceptable(obj)`, then `oldLocation:exitfunc`, then the
physical move, then `target:enterfunc`. See
[`../../spec/semantics/moveto.md`](../../spec/semantics/moveto.md).

## Anchor and host atomicity

In the production (Cloudflare) profile, every object has a host. To
keep operations atomic, related objects share a host: the **anchor**
chain. An object's anchor is either itself (it's the cluster root)
or another object whose host it shares. Recycling, parent changes,
and other graph mutations all check that the affected objects are
on the same host.

Most of the time you don't think about this. You'll notice anchors
when:

- Recycle errors with `E_CROSS_HOST_WRITE` because the graph crosses
  hosts.
- A `$block` instance has its own dedicated host
  (`instances_self_host: true`) — the block is the cluster root.

See [`../../spec/protocol/hosts.md`](../../spec/protocol/hosts.md) and
[`../../spec/reference/cloudflare.md`](../../spec/reference/cloudflare.md).

## Introspection — `:describe()`

Every object answers `:describe()`. It's the canonical discoverability
verb, defined on `$root_object` and guaranteed reachable for any
visible object. The result includes:

- `id`, `name`, `parent`, `owner`, `location`, `anchor`, `flags`,
  `modified`
- `properties` — readable property list with values
- `verbs` — readable verb list with metadata
- `schemas` — observation event schemas this object emits
- `children` — direct subclasses (if you have read access)
- `contents` — what's inside (if applicable and visible)

For an unfamiliar object, `:describe()` first. Then `verb_info` and
`property_info` for specifics.

The substrate guarantees `:describe()` is in your reachable scope for
any object you can see. You never need to "find" the verb; it's
always there.
