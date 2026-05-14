---
date: 2026-05-02
status: implemented
---

# Builtins and errors

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

Sketch of the v1 builtin function set (registered with stable indices for the `BUILTIN` opcode) and the canonical error catalogue.

---

## 19. Builtins (sketch — not exhaustive)

Builtins are functions, not verbs. They are registered with stable indices for the `BUILTIN` opcode. The list will grow; v1 minimum:

### 19.1 Core

`to_string(v)` (alias `tostr`), `to_int(v)` (alias `toint`), `to_float(v)` (alias `tofloat`), `toobj(v)`, `typeof(v)`, `length(v)`,  
`is_a(obj, parent_obj)` (DSL compatibility spelling: `isa`), `parents(obj)`, `children(obj)`,
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
`has_flag(obj, name)`, `parents(obj)`, `children(obj)`, `valid(obj)`,
`compile_verb(source)`,
`add_verb(obj, info)`, `delete_verb(obj, descriptor)`,
`set_verb_code(obj, descriptor, source)`, `set_verb_info(obj, descriptor, info)`,
`verb_info(obj, descriptor)`, `verb_code(obj, descriptor)`, `verbs(obj)`,
`add_property(obj, name, value, info)`, `delete_property(obj, name)`,
`set_property_info(obj, name, info)`, `clear_property(obj, name)`,
`is_clear_property(obj, name)`, `property_info(obj, name)`, `properties(obj)`,
`move(obj, new_location)`.

#### 19.4.1 LambdaMOO alignment of authoring primitives

The verb / property surface follows LambdaMOO shapes where possible, with
deliberate woo extensions. The differences:

- **`parents(obj)`** returns the full ancestor chain as a list (Stunt-style),
  not just the immediate parent. Single inheritance, but the result is always
  list-shaped so callers can walk uniformly.
- **`verb_info(obj, descriptor)`** returns an *extended* map with
  `{definer, slot, name, aliases, owner, perms, arg_spec, version,
  direct_callable, tool_exposed, source_hash}`. LambdaMOO's
  `{owner, perms, names}` is folded in (woo splits `name` + `aliases` rather
  than encoding them as a single space-separated string), and
  woo-specific verb fields (`arg_spec`, `direct_callable`, `tool_exposed`,
  `version`, `source_hash`) appear alongside. There is no separate
  `verb_args` / `verb_meta` primitive — woo combines info+args into one map.
- **`add_verb(obj, info)`** and **`set_verb_info(obj, descriptor, info)`**
  take a single `info` map covering both LambdaMOO's `info` (owner, perms,
  names) and `args` (arg_spec). `name` in info is required for `add_verb`
  and ignored for `set_verb_info` (the descriptor selects the verb).
- **`verb_code(obj, descriptor)`** returns the source as a single string,
  not a list of lines (LambdaMOO returns lines). woo stores source as a
  single string at rest; callers split on `"\n"` if they need lines.
- **`set_verb_code(obj, descriptor, source)`** takes a single source string
  and returns a list of compile-error message strings (empty list on success),
  matching LambdaMOO's contract.
- **`property_info(obj, name)`** returns an *extended* map
  `{name, owner, perms, defined_on, type_hint, version, has_value}`.
  LambdaMOO's `{owner, perms}` is folded in; `defined_on` records which
  class in the chain owns the propertyDef, `type_hint` carries woo's type
  annotation, and `version` is the optimistic-locking counter.
- **`add_property(obj, name, value, info)`** takes `info = {owner?, perms?,
  type_hint?}`. The `type_hint` is woo-specific.
- **The `d` perms bit** is repurposed in woo from LambdaMOO's "debug" bit
  to a shorthand for `direct_callable: true`. See
  [permissions.md §11.2](permissions.md#112-verb-perms). Passing `"rxd"`
  in `perms` at install time normalizes to `perms: "rx", direct_callable:
  true` in storage.

The following LambdaMOO primitives are intentionally NOT exposed:

- `players()`, `max_object()` — these enable enumeration of the world by
  any caller. World-walks should require wizard authority.
- `verb_args(obj, descriptor)`, `set_verb_args(obj, descriptor, args)` —
  folded into `verb_info` / `set_verb_info`.
- `disassemble(obj, descriptor)` — debug-only; woo's bytecode is not
  human-readable in the same way.

`is_a(obj, parent_obj)` is a host-transparent ancestry predicate for valid
object references. If `obj` is owned by another host, the runtime asks that host
to evaluate the parent chain and returns the same boolean the local predicate
would return. It raises only for invalid object refs or infrastructure failure;
ordinary cross-host placement does not change the result.

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
it may include `{owner, name, description, aliases, location, fertile}`.
This mirrors the builder-facing create surface, but still applies
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
`null`, except when `obj == actor` inside a session-bound task: then it returns
that session's current location. This keeps command parsing and room verbs scoped
to the tab/tool session that issued the call. It is a behavior-readable core
field, not a property lookup.

`current_session()` returns the current session id or `null` for host/bootstrap
tasks. `current_location()` returns the current session's location or `null`.
`session_location(id)` returns that live session's location or `null`.
`primary_session(actor)` returns the actor's primary live session id or `null`.
`all_locations(obj)` returns the deduplicated current locations for all live
sessions of an actor; for non-actors it returns the object's ordinary location
as a singleton list, or `[]` when there is none.

`dispatch(obj, verb, args?, start_at?)` invokes the normal verb-dispatch path
from source code, using the current task permissions. Catalog code that wants to
route a command as the calling actor should first call
`set_task_perms(caller_perms())`. `dispatch` is a mechanism, not a command
policy: parser conventions such as chat prefixes or room commands live in
catalog source.

`execute_command_plan(plan)` consumes a command plan produced by
`$match:plan_command`. Direct plans execute through the normal dispatch path and
return the target verb's result. Sequenced plans require a live session and run
through the resolved command space, returning the applied/error frame. This
builtin is for inherited command-surface verbs such as
`$conversational:command(text)`; browser clients should normally use wire
`op:"command"` instead of calling it indirectly.

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
but routes live delivery to the session audience of `space`. It is for ordinary
object behavior such as a mounted pinboard or control surface emitting visible
activity to its containing room; it does not make the containing-room relation a
core property.

`set_presence(space, present)` updates the current actor/session's presence in a
space through the host-safe presence primitive. The authoritative storage is
`space.session_subscribers`; `space.subscribers` is an actor-level projection
derived from those session rows. New catalog movement code should prefer
`moveto(actor, space)`, which updates the calling session's current location and
presence together. `set_presence` cannot set presence for another actor.

### 19.7 Sessions

`connected_players()`, `connection_name(player)`, `boot_player(player)`,  
`notify(player, event)` — equivalent to `emit(player, event)`.

`is_connected(actor)` returns `true` iff any session for `actor` is currently
driving the world: either it has at least one attached WebSocket socket, or
it received non-WS input within the live window (5 minutes). The dual
signal lets stateless transports (REST, MCP) register as connected while
they make tool calls without keeping a socket open. Past the window, a
session with no attached socket falls through to "sleeping" — same as a
WS user whose connection has dropped.

`idle_seconds(actor)` returns the integer number of whole seconds since the
most recent meaningful input frame from any of `actor`'s sessions, or
`null` if the actor has no session at all. The reading is independent of
socket attachment; a recently-active REST/MCP session reports a real idle
even though no socket is open.

"Meaningful input" is `op: call | direct | input` ingress at the WS, REST,
or MCP boundary, plus session creation and socket attach. Ping, state
projection, replay/catchup, and session resume do not reset idle.
`lastInputAt` is in-memory only and cold-rehydrates as "just active." Both
builtins read across multiple sessions for the same actor (a player on
browser + agent), so `is_connected` is OR over sessions and `idle_seconds`
is the most-recent input across them. The LambdaCore `$player:look_self`
override uses these to surface `is sleeping` / `awake and looks alert` /
`staring off into space for N minutes`.

`presence_status(actor)` returns `"awake"`, `"idle"`, or `"sleeping"` using the
same connection and idle policy as `is_connected` and `idle_seconds`. The idle
threshold is a substrate constant (currently 60 seconds) so catalog roster
implementations do not each choose their own cutoff.

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
| `E_CROSS_HOST_WRITE` | Behavior attempted a property definition, property metadata edit, lifecycle change, or authoring write on an object outside the current host's atomic rollback scope. Ordinary property-value assignment routes to the object's host. |
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
