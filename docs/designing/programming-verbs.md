# Programming verbs

A verb is the unit of behavior in woo. Writing one means: writing
woocode source, compiling it (validation + bytecode), and installing
it on the target object. The programmer surface (`$programmer`) is
how you do all three from inside a running world.

This page covers the in-world authoring path. For one-shot
experiments without persisting a verb, see [eval.md](eval.md). For
buffer-style editing of an existing verb, see
[verb-editor.md](verb-editor.md).

## The DSL: woocode

woocode is a small expression language. The full language spec is
[`../../spec/semantics/language.md`](../../spec/semantics/language.md);
the **T0 subset** that today's compiler accepts is in
[`../../spec/semantics/tiny-vm.md`](../../spec/semantics/tiny-vm.md).

A minimal verb:

```
verb look_self()
  observe({type: "looked", source: this, text: this.description})
  return this.description
endverb
```

Pieces:

- `verb <name>(args)` opens. `endverb` closes.
- `args` is a positional list of names, optionally with type hints.
- `this` is the object the verb is dispatched on.
- `caller` is the verb that called this one (or `null` for an
  outermost call).
- `actor` is the actor whose authority drove the call.
- `progr` is the verb's "programmer" — the verb owner at compile
  time. This is what authority the verb runs under, regardless of
  who calls it. Programmer authority is dangerous because installed
  verbs *capture* `progr`.

## What T0 supports today

- Verb headers, positional args, literal values (scalar, list, map).
- Local variables (`let`); property get/set on `this` and on objects
  local to the call.
- `if` / `else`; equality.
- `for x in <list>` loops.
- `try` / `except`.
- `observe(event)` — emit an observation. Compiles to the dedicated
  `OBSERVE` opcode.
- `emit(event)` — same, with a slightly different audience model.
- `return <expr>`.
- `raise <error-symbol>` (or `raise(<error>, <message>)`).
- A growing set of builtins: `recycle`, `moveto`, `create`, `isa`,
  property/verb introspection (`verbs`, `verb_info`, `verb_code`,
  `properties`, `property_info`), and many others.
- Arbitrary user-verb calls (`obj:verb(args)`).

## The install flow

Two ways in:

1. **`$programmer:install_verb`** — direct from MCP / chat eval.
   Source-as-a-string, structured result.
2. **`@verb` + `@program`** — LambdaCore-shape chat commands. Add a
   stub, then install the body. Less convenient than `install_verb`
   but matches established workflow.

Both route through the same underlying builtin.

### `install_verb`

```
woo_call("$me", "install_verb", [<obj-id>, <descriptor>, <source>, opts?])
```

`<descriptor>` identifies which verb slot to install into:

- A **bare verb name** (`"look_self"`) — install into the first
  matching slot, or create a new one if none exists.
- An **integer slot** (`3`) — install into a specific 1-based slot.
  Useful when a verb has multiple ordered slots with the same name.

`opts`:

| Option | Effect |
|---|---|
| `dry_run: true` | Compile and validate without mutation. Returns diagnostics. |
| `mode: "define"` | Refuse if the verb already exists. |
| `mode: "set_code"` | Refuse if the verb doesn't exist. |
| `mode: "upsert"` (default) | Create or replace. |
| `expected_version: <n>` | Optimistic concurrency. Refuses with `E_VERSION` if the verb's version has moved. |

`opts.perms` is **rejected**. The source header is canonical for
permission bits; metadata-only edits go through `set_verb_info`.

The result shape:

```
{
  ok: true | false,
  dry_run: <bool>,
  slot: <1-based int>,
  version: <int>,
  metadata: { name, perms, arg_spec, ... },   // parsed from source header
  diagnostics: [{ severity, code, message, ... }, ...]
}
```

On `ok: false`, **nothing changed** — the install path runs the same
checks for `dry_run: true` and a real install, returning the same
diagnostic shape. Failed real installs roll back any partial state.

A successful install emits a `programmer_installed` observation;
a failed validation emits `programmer_check_failed`.

### `set_verb_info` — metadata-only edits

```
woo_call("$me", "set_verb_info", [<obj-id>, <descriptor>, opts])
```

Where `opts` contains any of:

- `aliases` — list of strings.
- `perms` — `r/x/d` permission string.
- `direct_callable` — bool.
- `tool_exposed` — bool.
- `arg_spec` — argument names + type hints.
- `owner` — wizard-only.
- `dry_run: true` / `expected_version: <n>` as above.

Use this for `@args`-style and `@chmod`-style operations: changing
how a verb is invoked or who can execute it, without rewriting the
body. Metadata edits don't change `progr` (it's captured at install,
not at metadata change).

### `set_property_info` — property metadata

```
woo_call("$me", "set_property_info", [<obj-id>, <name>, opts])
```

For defining new properties on an object, or adjusting an existing
property's perms/defaults/type hint. Builder's `set_property` only
sets a *value*; this is the metadata twin.

## Chat commands

The LambdaCore-shape chat surface, ported line-for-line:

| Command | Does what |
|---|---|
| `@verbs obj` | List own verb names on `obj`. |
| `@verb obj:name[,alias…] [dobj [prep [iobj]]]` | Add a stub verb. |
| `@list obj:verb` | Dump the verb source with line numbers. |
| `@args obj:verb [dobj prep iobj]` | Set or show the dobj/prep/iobj specifier. |
| `@chmod target perms` | Change verb (or property) perms. Accepts `rxd` or `+r-x`. |
| `@chown target owner` | Wizard-only owner change. |
| `@rmverb obj:verb` | Delete a verb defined on `obj`. |
| `@rename obj[:verb] to newname` | Rename a verb (object branch deferred). |
| `@properties obj` (alias `@props`) | List own property names on `obj`. |
| `@property obj.name [value]` | Add a new property with optional initial value. |
| `@rmproperty obj.name` (alias `@rmprop`) | Remove a property defined on `obj`. |

LambdaCore's split between defining metadata (`@verb`) and installing
source (`@program`) is preserved; the substrate builtin has separate
modes (`define`, `set_code`, `upsert`) so a chat user can manipulate
just metadata or just source. The combined `install_verb` surface is
a convenience for the common case.

The full chat-command catalogue and their builder counterparts
(`@create`, `@set`, `@recycle`, `@contents`, `@parents`, `@kids`)
are in [builder-and-programmer.md](builder-and-programmer.md).

### `@list` — reading source

```
@list the_lamp:turn_on
```

Returns the verb's source (subject to `r` perm). The chat output is
line-numbered. The MCP equivalent:

```
woo_call("$me", "list_verb", ["the_lamp", "turn_on", {}])
```

…returns the source as a string in the result.

### `@verb` then `install_verb`, as a single workflow

```
@verb the_lamp:turn_on this is none           # creates a stub
;;"$programmer":install_verb(the_lamp, "turn_on",
   "verb turn_on() this.lit = true; observe({type: \"say\", text: \"click\"}); endverb",
   {})                                          # installs the body
@list the_lamp:turn_on                         # confirms
```

The `;;` line is the [eval](eval.md) chat alias for statement-mode
woocode.

## Editor-room workflow

For larger edits — rewriting a verb body, working with multiple
versions side by side — the verb editor is friendlier than chat.
`woo_call("$me", "edit_verb", [<obj>, <descriptor>])` puts you into
the editor room with a buffer. See
[verb-editor.md](verb-editor.md).

## Permissions to author

To install a verb on an object, you need:

- The `programmer` flag (or be wizard), **and**
- Either: you own the object, **or** the object permits you to write
  verbs on it (rare in practice — usually it's ownership).

To **read** a verb's source: the verb's `r` perm bit must be set, or
you must own the verb, or you must be a wizard. Verbs without `r`
are still callable; you just can't see their source.

The full authority story for the programmer surface is in
[builder-and-programmer.md §Authority](builder-and-programmer.md#authority-gates-summarized).

## Editing in place vs in a catalog

**In-place editing**: you authenticate, call `install_verb` (or use
the editor room or `@program`-style chat) on a live object. Effects
are immediate. Good for experimentation and live operations on a
single world.

**Catalog editing**: you write the verb source as a string in
`catalogs/<name>/manifest.json`, under the appropriate class entry's
`verbs` array:

```
{
  "name": "look_self",
  "perms": "rxd",
  "tool_exposed": true,
  "direct_callable": true,
  "source": "verb look_self()\n  observe({type: \"looked\", source: this, text: this.description})\n  return this.description\nendverb"
}
```

When the catalog installs into a world, the install pipeline does
the same `install_verb` under the hood. Catalog versioning and
migration handle the upgrade story. See [catalogs.md](catalogs.md).

## The verb metadata you author

A verb declaration carries more than source:

| Field | Meaning |
|---|---|
| `name` | The verb name. Must match the source header. |
| `aliases` | Other names the parser will match (lowercase strings). |
| `arg_spec` | Argument names and optional type hints. |
| `perms` | `r` / `x` / `d` permission string. |
| `direct_callable` | If `true`: the verb runs as a direct call. If `false`/unset: sequenced via the enclosing space. |
| `tool_exposed` | If `true`: the verb appears as an MCP tool to actors who can execute it. |

`tool_exposed` is the opt-in that surfaces a verb to LLM agents.
Don't set it by default — only on verbs that make sense as agent
affordances. Implementation-detail verbs and inherited
self-control verbs should stay `tool_exposed: false`.

`direct_callable` is the routing decision. If your verb mutates state
that should be replayable (a task transition, a pin placement),
leave it sequenced. If it's chat-shaped or read-shaped, mark it
direct.

## Observations from a verb

Use `observe` to emit events:

```
observe({type: "took", source: this, actor: caller_actor, target: <item>, text: caller_actor.name + " picks up " + <item>.name + "."})
```

The audience for an `observe` is decided by the runtime's audience
model. For most observations, the audience is `location(this)` (the
room the verb's target is in). You can override with explicit `to:`
or `from:` fields, or with `_audience_override`.

The full audience model is in
[`../../spec/semantics/events.md`](../../spec/semantics/events.md).

## Errors

Raise errors with symbolic codes:

```
if (this.contents != [])
  raise E_RECMOVE
endif
```

The standard error codes (`E_PERM`, `E_INVARG`, `E_OBJNF`, etc.) are
in [`../../spec/semantics/builtins.md`](../../spec/semantics/builtins.md).
Custom codes are allowed; consumers will treat them as opaque
non-zero errors.

## Reading existing verbs

The fastest way to understand what's in a world is to read existing
verbs. Sources are readable when the `r` perm allows:

```
woo_call("$me", "list_verb", ["<obj>", "<verb-name>", {}])
```

…or, for the parent walk that resolves a name:

```
woo_call("$me", "resolve_verb", ["<obj>", "<verb-name>"])
```

Returns the definer object, slot, source (if readable), and the
walk that found it. Combined with `:describe()` (on
`$root_object`), this tells you everything you can know about an
object's surface. For chat, `@list obj:verb` is the equivalent.
