# Builtins and errors

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**. Profile: **v1-core**.

Sketch of the v1 builtin function set (registered with stable indices for the `BUILTIN` opcode) and the canonical error catalogue.

---

## 19. Builtins (sketch — not exhaustive)

Builtins are functions, not verbs. They are registered with stable indices for the `BUILTIN` opcode. The list will grow; v1 minimum:

### 19.1 Core

`tostr(v)`, `toint(v)`, `tofloat(v)`, `toobj(v)`, `typeof(v)`, `length(v)`,  
`is_a(obj, parent_obj)`, `parents(obj)`, `children(obj)`,  
`now()` → ms epoch, `ftime()` → high-res wall time,  
`raise(err)`, `random(n)`.

### 19.2 String

`str_slice(s, from, to?)` / `strsub(s, from, to)`, `str_index(s, sub)` / `index(s, sub)`, `rindex`, `match(s, pattern)`, `pcre`,  
`str_lower(s)` / `tolower`, `toupper`, `str_trim(s)` / `trim`, `str_starts(s, prefix)`, `str_char(codepoint)`, `split(s, sep)`, `str_join(list, sep)` / `join(list, sep)`,
`encode_json(v)`, `decode_json(s)`.

`str_join(list, sep)` joins the list with a string separator. String elements
are used directly; non-string elements are converted with the runtime's ordinary
JSON-style value rendering. Callers that need a particular presentation should
convert values explicitly before joining.

### 19.3 List / map

`listappend`, `listinsert`, `listdelete`, `setadd`, `setremove`,  
`mapkeys`, `mapvalues`, `mapdelete`, `mapmerge`.

### 19.4 Object

`create(parent, owner_or_options?)`, `recycle(obj)`, `chparent(obj, new_parent)`,
`has_flag(obj, name)`,
`compile_verb(obj, name, source, options)`,
`set_verb_code(obj, descriptor, source, expected_version, options)`,
`set_verb_info(obj, descriptor, expected_version, info)`, `verb_info`, `verb_args`,
`define_property(obj, name, default, perms, expected_version, type_hint)`,  
`set_property_info(obj, name, expected_version, info)`,  
`delete_property(obj, name, expected_version)`, `property_info`, `properties(obj)`, `verbs(obj)`,  
`move(obj, new_location)`.

`collect_prop(list<obj>, name)` performs an order-preserving batch of readable
property lookups and returns the resulting list of property values in input
order. It costs `5 + length(list)` ticks: the ordinary `BUILTIN` dispatch cost
plus one additional tick per input object. It is the safe parallel-read primitive
for common presentation code such as `str_join(collect_prop(players, "name"),
", ")`: reads may run concurrently across hosts in direct calls, but the builtin
cannot mutate state, dispatch arbitrary verbs, or emit observations. Inside a
sequenced VM frame, implementations must avoid parallel cross-host fanout
because the sequencer already holds a queue slot; the reference implementation
falls back to serial reads. If any read fails, the builtin raises that error.

The authoring-facing contract for compile/install, expected-version conflicts,
and diagnostics is in [../authoring/minimal-ide.md](../authoring/minimal-ide.md).
Verb descriptors follow [objects.md §9.1](objects.md#91-lookup): name-based
descriptors resolve to the first matching local slot, and integer descriptors
name a 1-based local slot directly.

`create(parent, owner_or_options?)` creates a new persistent object with the
supplied parent. If the second argument is an object reference, it is the owner;
if omitted, owner defaults to the current actor. If the second argument is a map,
it may include `{owner, name, description, aliases, location, fertile,
recyclable}`. This mirrors the builder-facing create surface, but still applies
the behavior task's ordinary `create()` authority checks. In a sequenced call,
the new object's anchor is the current space; in a direct/off-space call, the
anchor is null. `location`, when supplied, is initial placement only; user-level
acceptance hooks still belong to `moveto(obj, target)`. It costs 50 ticks per
call (host instantiation is not free).

Creation is permissioned. A wizard may create for any owner. A non-wizard
creator must be a programmer, must create objects owned by itself, and may use a
parent only if that parent is owned by the creator or marked `fertile`.

Full v1 `create()` is subject to a per-task creation budget (default 100 per
verb invocation, raises `E_QUOTA`) and the per-owner storage quotas in
[permissions.md §11.7](permissions.md#117-storage-quotas-and-accounting). The
owner's `created` list (a property convention on `$root_object`) is appended
automatically; ops can iterate it for per-owner inventory. The v0.5
implementation enforces the parent/owner/anchor/tick-cost semantics; quota
accounting and the `created` list are still pending.

`move(obj, new_location)` and `chparent(obj, new_parent)` are ordinary behavior
primitives but use the same authoring authority as direct IDE lifecycle
operations: wizard, or programmer editing an object it owns. `chparent` also
requires that the new parent be owned by the programmer or `fertile`, and rejects
cycles with `E_RECMOVE`.

`location(obj)` returns the object's current container (`obj.location`) or
`null`. It is a behavior-readable core field, not a property lookup.

`dispatch(obj, verb, args?, start_at?)` invokes the normal verb-dispatch path
from source code, using the current task permissions. Catalog code that wants to
route a command as the calling actor should first call
`set_task_perms(caller_perms())`. `dispatch` is a mechanism, not a command
policy: parser conventions such as chat prefixes or room commands live in
catalog source.

`has_flag(obj, name)` returns whether an object metadata flag is true. It is for
ordinary behavior checks such as wizard bypasses; it is not a substitute for the
permission system.

There is intentionally no "list all objects in the world" builtin. Instance enumeration is by class via recursive `children($class)`; per-owner enumeration is by convention (creator maintains a list). Ops-level host enumeration uses the runtime's management plane, not the runtime API.

### 19.5 Task / scheduling

`task_id()`, `task_perms()`, `caller_perms()`, `set_task_perms(actor)`,  
`kill_task(id)`, `tasks(player)`, `set_task_local(key, val)`, `get_task_local(key)`.

`task_perms()` returns the current effective `progr` for permission checks.
`caller_perms()` returns the caller frame's effective principal. A wizard frame
may call `set_task_perms(actor)` to drop authority before executing
caller-controlled work; non-wizard frames cannot use it to escalate.

`tasks(player)` is local to that player's DO. There is no global `queued_tasks()` — by the same principle as object enumeration, tasks aren't enumerable at world scale.

### 19.6 Events / IO

`emit(target, event)`, `observe_to_space(space, event)`, `set_presence(space, present)`,  
`subscribe(self, source, type)`, `unsubscribe`,  
`event_schema(obj, type)`, `declare_event(obj, type, schema)`.

`observe_to_space(space, event)` records `event` on the current invocation route
but routes live delivery to the subscribers of `space`. It is for ordinary
object behavior such as a mounted pinboard or control surface emitting visible
activity to its containing room; it does not make the containing-room relation a
core property.

`set_presence(space, present)` updates the current actor's presence mirror for a
space (`actor.presence_in` and `space.subscribers`) through the host-safe
presence primitive. It cannot set presence for another actor.

### 19.7 Sessions

`connected_players()`, `connection_name(player)`, `boot_player(player)`,  
`notify(player, event)` — equivalent to `emit(player, event)`.

### 19.8 Wizard-only

`shutdown(reason)`, `dump_database()`, `load_database()`,  
`set_verb_perms`, `set_property_perms`,  
`task_stack(task_id)`, `disassemble(obj, verb)`.

---

## 20. Errors

`err` values are atoms:

| Code | Meaning |
|---|---|
| `E_NONE` | No error. |
| `E_TYPE` | Wrong type. |
| `E_DIV` | Division by zero. |
| `E_PERM` | Permission denied. |
| `E_PROPNF` | Property not found. |
| `E_VERBNF` | Verb not found. |
| `E_OBJNF` | Object not found. |
| `E_VARNF` | Variable not found / not bound. |
| `E_INVIND` | Invalid indirection (e.g., `nil:verb()`). |
| `E_RECMOVE` | Recursive move (object would contain itself). |
| `E_MAXREC` | Maximum recursion depth exceeded. |
| `E_RANGE` | Index out of range. |
| `E_ARGS` | Wrong number of arguments. |
| `E_NACC` | Not accepted (e.g., `:accept(what)` returned false). |
| `E_INVARG` | Invalid argument. |
| `E_CONFLICT` | State conflict (e.g., already claimed by another actor). |
| `E_PRECONDITION` | Required condition was not met. |
| `E_QUOTA` | Resource quota exceeded. |
| `E_FLOAT` | Floating-point exception. |
| `E_TICKS` | Tick limit exceeded. |
| `E_MEM` | Memory limit exceeded. |
| `E_INTRPT` | Task killed. |
| `E_GONE` | Transient ref no longer valid (host disconnected). |
| `E_TIMEOUT` | Deadline exceeded (task wall-time budget, cross-host RPC). |
| `E_CROSS_HOST_WRITE` | Behavior attempted a property-definition or property-value write on an object outside the current host's atomic rollback scope. |
| `E_HOST_CYCLE` | Awaited host RPC would re-enter a host already in the current request's wait-for chain. |
| `E_NOSESSION` | Session token is expired or unknown. |
| `E_VERSION` | Bytecode version mismatch (cache stale). |
| `E_FED_DISABLED` | Federation not enabled (v1 single-world). |
| `E_FED_TIMEOUT` | Cross-world RPC timed out. |
| `E_FED_UNREACHABLE` | Peer world unreachable. |
| `E_FED_PROTOCOL` | Cross-world wire protocol mismatch. |
| `E_RATE` | Connection inbound rate limit exceeded. |
| `E_OVERFLOW` | Outbound queue overflow; client must recover by replay. |

An `err` value is a tagged map:

```
{ code: str, message?: str, value?: any }
```

`raise()` accepts either a code string (`raise("E_PERM")`) or a fully-formed err map (`raise({code: "E_PERM", message: "no can do", value: target})`). Handlers receive the full err map. Matching against `try ... except err in (E_PERM, E_PROPNF)` is by `code` only — `message` and `value` don't affect dispatch.

The runtime emits `err` values with `code` populated and a default `message` for the standard codes; `value` is null unless attached by the raiser.
