# Creating objects

Spawning a new object, picking a parent, naming it, and giving it
initial properties. The builder surface (`$builder`) is how you do
this from inside a running world.

For the larger picture (builder vs programmer roles, authority
checks), see [builder-and-programmer.md](builder-and-programmer.md).

## Three ways to drive the builder surface

| Surface | Example |
|---|---|
| **MCP tools** on `$me` (when your actor inherits from `$builder`) | `woo_call("$me", "create", ["$thing", {name: "blue lamp"}])` |
| **Chat `@`-commands** | `@create $thing named blue lamp,lamp` |
| **Eval `;;`** | `;;create($thing, {name: "blue lamp"})` |

All three end up at the same builder builtin. Pick whichever is most
convenient for the moment.

## Creating an object

```
woo_call("$me", "create", ["<parent>", opts?])
```

Creates a new object whose **parent** is the given class. The new
object is **owned by the invoking actor** — there's deliberately no
`owner` option in the builder surface. Creating on behalf of another
actor is a wizard/admin operation, not ordinary delegated building.

`opts` is a map:

| Option | Effect |
|---|---|
| `name` | Human-readable label. Used in matching and listings. |
| `description` | What `look at` shows. Cosmetic. |
| `aliases` | Alternative names the parser will match (list of strings). |
| `location` | Where to place the new object. Defaults to your inventory. |
| `fertile` | If `true`, others can derive children from it. Defaults to `false`. |

The chat equivalent:

```
@create $thing named blue lamp,lamp
```

`@create` parses the `parent`, the `named` keyword, and a
comma-separated `name,alias…` list. The new object lands in your
inventory by default (consistent with LambdaCore).

## Picking a parent

The parent decides what verbs and properties your new object
inherits. Common starting points (assuming the chat catalog is
installed):

| Parent | Use for |
|---|---|
| `$thing` | Generic object. Default for most new things. |
| `$portable` | Carryable items. Adds the take/drop hooks. |
| `$furniture` | Fixed-in-place items. Adds anchored placement. |
| `$note` | Markdown-text payload object. |
| `$chatroom` | A new room. Composes in `$conversational`. |
| `$exit` | An exit between rooms. |

For application-level classes, pick the closest match in the
relevant catalog (a task: `$task`, a pin: `$pin`, a control: a
`$dubspace` control class).

The **fertile** flag on the parent governs who can create from it.
Most catalog public classes are `fertile`. If `create` rejects with
`E_PERM` on a non-fertile class, that's why — only the parent's
owner (or a wizard) can derive.

## Reparenting: `chparent`

```
woo_call("$me", "chparent", ["<obj>", "<new-parent>", opts?])
```

Reparents an object. Subject to:

- The new parent must be reachable.
- You must own the object (or be wizard).
- The new parent must be fertile, or you must own it.
- The change must not create a cycle.
- All affected objects must share a host (no cross-host writes).
- **Actor objects can only be reparented under actor-derived
  parents.** Moving an actor out of the actor hierarchy is
  wizard/admin repair, not delegated building.

`opts.dry_run: true` returns the safety check result without
mutating — LambdaCore's `@check-chparent` shape.

Reparenting is rare. If you find yourself reparenting often, consider
whether the design wants a feature instead — `$conversational`
attached to `$chatroom` is the canonical "compose behavior without
inheriting" example.

## Setting properties

```
woo_call("$me", "set_property", ["<obj>", "name", "blue lamp"])
woo_call("$me", "set_property", ["<obj>", "aliases", ["lamp", "blue"]])
woo_call("$me", "set_property", ["<obj>", "color", "blue"])
```

Builder's `set_property` writes ordinary data values. The runtime
resolves which property *definition* to use (walks the parent
chain), then writes the value on the target object.

You don't "create" a property by writing it — the property must
already be defined on an ancestor. To **define** a brand-new
property (one that doesn't exist on any ancestor), use the
programmer surface: `$programmer:set_property_info` or the
`@property` chat command. See
[programming-verbs.md](programming-verbs.md).

The chat equivalent is `@set`:

```
@set the_lamp.color to blue
```

`@set` will *not* auto-create properties. If `color` doesn't exist
on the lamp's parent chain, `@set` errors and points you at
`@property`.

Types worth knowing about:

- Scalar: `int`, `float`, `string`, `bool`, `null`.
- `obj` — an object reference.
- `list`, `map` — woo's containers.
- `error` — error values are first-class (`E_PERM`, `E_INVARG`, etc.).

The complete value contract is in
[`../../spec/semantics/values.md`](../../spec/semantics/values.md).

## Moving the new object

`create` can take a `location` argument and place the object there.
If you didn't, place it after the fact.

For a normal in-world move (the receiver-driven move chain that lets
the destination accept/refuse and run hooks):

```
woo_call("<obj>", "moveto", ["<target>"])
```

For an authoring move (low-level, bypasses hooks):

```
;<obj>.location = <target>;
```

Use `:moveto` for "an actor picks up the lamp" semantics — the
target's `:acceptable` runs, the source's `:exitfunc` runs, and the
destination's `:enterfunc` runs. Reserve direct property writes for
authoring setup where the hook chain isn't appropriate.

## Inspecting what you've made

```
woo_call("$me", "inspect", ["<obj>"])
```

Builder's `inspect` returns a structure/data view: parent, children,
contents, location, flags, properties (no source). Equivalent chat
commands: `@parents`, `@kids`, `@contents`, `@props`.

For a source-aware view (verbs and their bodies, when readable),
you need the programmer surface — `$programmer:inspect` overrides
this with source output.

## Searching across the world

```
woo_call("$me", "search", [<query>, opts?])
```

Builder's `search` is bounded grep across object names and property
channels — no source. Useful for finding "every object with a name
containing 'lamp'" or "every object with a property `color = "blue"`."

Programmer's `search` (same name, overridden) extends to readable
verb source.

## Naming and aliases

`name` is the primary label. The chat catalog's parser uses both
`name` and `aliases` to match free-text references in commands.
Conventions:

- **`name`** — short, distinctive. "blue lamp" not "the blue lamp on
  the desk". Title case is fine.
- **`aliases`** — alternatives the parser should match. Lowercase,
  short. Don't repeat the name; the parser already has it.
- **`description`** — what `look at` shows. A sentence or two. Not
  the body of the object — that's `text` for note-like objects.

Two objects in the same room with the same name causes the parser to
ask for disambiguation, which is annoying. Pick distinctive names.

## Tearing things down

```
woo_call("$me", "recycle", ["<obj>", opts?])
```

Builder's `recycle` is the wizard-or-owner safe path. `opts.dry_run:
true` reports the impact without mutating. For forced recycle (with
contents, with children, terminating live actor sessions), see
[../wizard/recycle.md](../wizard/recycle.md) and
`$programmer:force_recycle`.

The chat command:

```
@recycle the_old_lamp
```

## What's missing

The minimal-IDE spec
([`../../spec/authoring/minimal-ide.md`](../../spec/authoring/minimal-ide.md))
describes a richer authoring surface — fork/suspend, replay
debugging, time-travel inspection. Today's builder/programmer
verbs are the working subset. Expect this section to grow.
