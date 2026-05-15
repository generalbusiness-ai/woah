---
date: 2026-05-02
status: draft
---

# Minimal IDE

> Part of the Woo authoring specification. Working draft.

The minimal IDE is a Web UI for developing woocode against live Woo objects. It
is not a full builder, package manager, or collaborative editor. Its purpose is
to force the smallest credible authoring loop into the spec.

The loop:

1. Inspect an object.
2. Edit one verb.
3. Compile it.
4. Install it atomically.
5. Call it.
6. See observations, errors, and state changes.

If this loop works, Woo is no longer only a runtime for seeded behavior.

---

## A1. Goal

The minimal IDE should prove that a person or agent can safely develop live
object behavior from the browser.

It should expose object structure and behavior directly:

- object identity, parent, owner, flags, location, anchor
- properties and property definitions
- local and inherited verbs
- event/observation schemas
- source, bytecode version, perms, and owner for readable verbs
- recent calls and observations for the selected space/object

The IDE is allowed to be plain. It must be precise.

---

## A2. First Authoring Loop

v1 authoring requires only one actor with programmer authority and one
editable object.

Minimal interaction:

1. Connect as an actor.
2. Select an object from known roots, children, contents, or the actor's created
   list.
3. Open a readable verb.
4. Edit the source.
5. Compile without installing.
6. Install with `expected_version`.
7. Make a structured test call.
8. Observe the `applied` frame, emitted observations, and final object state.

The same loop should work for a human in the Web UI and for an agent using the
same underlying operations.

---

## A3. UI Surface

The first IDE has five panes:

- **Object browser**: roots, children, contents, created objects.
- **Object inspector**: metadata, properties, verbs, schemas.
- **Verb editor**: source text, diagnostics, perms, owner, version.
- **Call console**: structured direct call or `$space:call`.
- **Observation panel**: applied frames, emitted observations, runtime errors.

No visual programming, package view, debugger UI, or multi-file project model is
required for the first version.

---

## A4. Direct Authoring, Sequenced Behavior

Authoring mutations are direct object operations, not `$space` messages.

Reason: editing a verb is an administrative change to an object definition. The
object host already serializes its own mutations, and `expected_version` handles
conflicts. Routing every edit through an application `$space` would confuse
object definition changes with domain behavior.

Behavior authored in the IDE may still be tested through `$space:call`. That is
the main integration path:

```js
{
  route: "sequenced",
  id: "test-1",
  scope: "$mix",
  actor: "$me",
  target: "#delay",
  verb: "set_feedback",
  args: [0.72]
}
```

---

## A5. Introspection Primitives

The IDE relies on the `:describe()` convention in
[../semantics/introspection.md](../semantics/introspection.md). It also needs a
richer read shape for verbs, properties, and schemas. These may be builtins,
system verbs, or host RPCs; the semantic contract is the important part.

```ts
obj:describe() -> ObjectDescription
verbs(obj, opts?) -> VerbSummary[]
verb_info(obj, name, opts?) -> VerbInfo
properties(obj, opts?) -> PropertySummary[]
property_info(obj, name, opts?) -> PropertyInfo
declared_schemas(obj, opts?) -> EventSchemaSummary[]
```

`opts.inherited` includes inherited entries and reports their `definer`.
`opts.local_only` reports only entries stored on the object itself.

`ObjectDescription`:

```ts
{
  id: ObjRef,
  name: str,
  parent: ObjRef | null,
  owner: ObjRef,
  location: ObjRef | null,
  anchor: ObjRef | null,
  flags: Map,
  modified: int,
  children_count?: int,
  contents_count?: int
}
```

`flags` is a name-keyed map for IDE convenience, e.g.
`{wizard: false, programmer: true, fertile: false}`. Storage
remains the bitset defined in [objects.md §4](../semantics/objects.md#4-objects).

`VerbSummary`:

```ts
{
  slot: int,
  name: str,
  aliases: str[],
  definer: ObjRef,
  owner: ObjRef,
  perms: str,
  arg_spec: Map,
  version: int,
  readable: bool
}
```

`slot` is the 1-based position of the verb in `definer`'s local ordered verb
list. Names are not unique: multiple slots may share the same `name` and differ
by aliases or `arg_spec`. Name-based authoring updates the first matching slot
unless the caller supplies an explicit slot descriptor.

`VerbInfo` extends `VerbSummary`:

```ts
{
  source?: str,
  source_hash?: str,
  bytecode_version: int,
  line_map?: Map
}
```

If the caller lacks read permission on source, `source` and `line_map` are
omitted but the summary is still returned when the verb itself is discoverable.

There is still no global object enumeration. The browser starts from known
roots (`$system`, `$root_object`, `$room`, `$dubspace`, `$task_registry`), then walks
`children`, `contents`, and owner-maintained `created` lists.

---

## A6. Editing Primitives

The IDE needs compile and install to be separate operations.

```ts
compile_verb(obj, name, source, options?) -> CompileResult
set_verb_code(obj, descriptor, source, expected_version, options?) -> InstallResult
set_verb_info(obj, descriptor, expected_version, info) -> InstallResult
define_property(obj, name, default, perms, expected_version, type_hint?) -> PropertyInfo
set_property_value(obj, name, value, expected_version?) -> PropertyInfo
set_property_info(obj, name, expected_version, info) -> PropertyInfo
delete_property(obj, name, expected_version) -> bool
create_object(parent, name?, description?, aliases?, location?) -> ObjRef
move_object(obj, location) -> bool
chparent_object(obj, new_parent) -> bool
```

`compile_verb` performs no mutation. It returns bytecode metadata and
diagnostics.

`set_verb_code` is atomic:

1. Check authority.
2. Check `expected_version`.
3. Compile source.
4. If compile succeeds, write source, bytecode, metadata, and increment version.
5. If compile fails, write nothing.
6. Invalidate/freshen relevant verb caches by the lazy version-check mechanism.

If `expected_version` does not match, the operation raises `E_VERSION` and does
not compile or install. For a new verb, `expected_version` is `null`.

Changing a verb affects future calls only. Running VM activations keep the
bytecode version they already carry.

Property definition edits follow the same optimistic-concurrency rule. For
`define_property`, `expected_version = null` means "this property definition
must not already exist." For `set_property_info` and `delete_property`,
`expected_version` must match the current property definition version. Property
value writes may also use `expected_version` when the implementation tracks
per-value versions.

Authoring authority is intentionally narrower than runtime dispatch: wizard, or
a programmer editing an object it owns. `create_object` creates an object owned
by the actor; the parent must be owned by the actor or `fertile`. `move_object`
and `chparent_object` require the same object-authoring authority, and
`chparent_object` applies the same parent/fertile rule plus cycle rejection.
Builder-facing chparent also preserves the actor hierarchy: actor/player objects
may only be reparented under actor-derived classes. Wizard/admin repair paths may
still perform deliberate class graph edits.
Wire endpoints for these live under an authoring surface, not under
`/api/objects/:id`, which is reserved for ordinary REST object access. The local
development server currently exposes `/api/compile`, `/api/install`,
`/api/property`, `/api/property/value`, and
`/api/authoring/objects/{create,move,chparent}`. Worker-side authoring endpoints
are intentionally deferred until the deployed IDE surface is enabled.

Authoring input formats:

- `t0-source` is the primary IDE format.
- `t0-json-bytecode` is a raw developer fallback. The input is canonical JSON
  text for a `TinyBytecode` object, validated by the same bytecode verifier
  before install.

The fallback exists so the runtime and seeded fixtures are testable before the
T0 source parser is complete. The normal IDE should not make JSON bytecode the
default authoring experience.

---

## A7. T0 Source Subset

The first IDE should not expose JSON bytecode as the primary authoring format.
It needs a tiny source subset that lowers to T0 bytecode.

T0 source supports:

- verb headers
- positional args
- scalar, list, and map literals
- `this`, `actor`, `space`, `seq`, `message`
- local variables
- property get/set on `this` and anchored local objects
- `if` / `else`
- equality tests
- `observe(event)`
- `return value`
- `raise(err)`

T0 source does not support:

- loops
- `CALL_VERB`
- `suspend`, `fork`, or `read`
- cross-host property access
- exception handlers
- imports or modules
- user-defined functions

T0 source verb bodies cannot call other verbs. Multi-step behaviors compose at
the client layer as multiple `$space:call` messages, or wait for the full VM
with `CALL_VERB`.

Example:

```woo
verb :set_feedback(value) rx {
  this.feedback = value;
  observe({
    "type": "control_changed",
    "target": this,
    "prop": "feedback",
    "value": value,
    "actor": actor,
    "seq": seq
  });
  return value;
}
```

The IDE may accept a short header (`verb :name(...)`) because the selected object
is implicit. Persisted source should canonicalize to the full object-qualified
form once IDs are stable.

---

## A8. Diagnostics and Tracebacks

Compile diagnostics have a stable shape:

```ts
{
  severity: "error" | "warning" | "info",
  code: str,
  message: str,
  span?: {
    line: int,
    column: int,
    end_line?: int,
    end_column?: int
  }
}
```

Span positions are 1-based for `line` / `end_line` and 0-based for `column` /
`end_column`. Columns are Unicode code-point offsets in the NFC-normalized
source text.

Runtime error observations should carry enough trace data for the IDE to jump
back to source:

```ts
{
  type: "$error",
  code: str,
  message: str,
  value?: Value,
  trace?: [
    {
      obj: ObjRef,
      verb: str,
      definer: ObjRef,
      version: int,
      line?: int,
      column?: int
    }
  ]
}
```

Tracebacks are permission-filtered. A caller who cannot read a verb's source may
see object, verb, and error code, but not source lines.

---

## A9. Permissions

The minimal rule:

- Owners and wizards can edit their objects.
- Programmer actors can create/edit verbs and properties on objects they own.
- Source is readable if the verb has `r`, or the caller owns the verb, or the
  caller is a wizard.
- Changing owner, perms, flags, parent, or anchor remains separate from editing
  source.

The IDE should show denied operations as normal errors. It should not invent a
client-side permission model.

---

## A10. Deferred

Not required for the minimal IDE:

- collaborative text editing
- edit history UI and rollback
- package import/export
- graphical object builder
- full debugger
- breakpoint/step execution
- full DSL compiler
- schema enforcement beyond diagnostics
- object migrations
- capability delegation UI

The version sequence is the primitive. Rollback is a UI operation that installs
a prior source/bytecode version (from retained history or backup) with normal
`expected_version` checks; it is not a special runtime mutation.

Collaborative source editing can later be a `$document < $space` app. It should
not be a dependency of the first authoring loop.

---

## A11. Essential Pressure

This spec pulls forward four essentials:

1. Object introspection must be a stable runtime surface.
2. Source text must be first-class on verbs, even while T0 bytecode stays small.
3. Compile/install must be atomic and version-checked.
4. Diagnostics and runtime traces must be structured values, not console text.

The IDE itself is just a Web client. These primitives are part of the
programmable object world.
