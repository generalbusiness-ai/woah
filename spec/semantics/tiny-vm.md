---
date: 2026-04-30
status: implemented
---

# Tiny VM

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

The tiny demo should run real Woo behavior in a VM. It should not wait for the
entire future VM: host RPC, suspension, browser-host execution, exception
machinery, and full source-language compilation are not required for the tiny
runtime subset.

This document defines the first VM subset: **T0**.

## T0 Goal

T0 proves that Woo objects can carry behavior as bytecode and that `$space`
can apply sequenced calls/messages by invoking that behavior.

T0 is domain-neutral. It must support seeded verbs whose behavior can:

- read message arguments
- read and write local object properties
- emit observations
- return values
- fail cleanly

That is enough for Dubspace controls and for a minimal later chat-space verb
such as `room:say`. Loops, playback, scenes, and audio are library/application
behavior, not VM concepts.

## T0 Non-Goals

- No user-authored source language.
- No full DSL parser.
- No cross-host RPC.
- No deferred execution (`schedule` / `fork`).
- No browser-hosted transient VM.
- No exception handlers.
- No general-purpose standard library.

Seeded verbs may be written as bytecode JSON, a tiny AST that lowers to
bytecode, or a small internal builder API. The VM is the important part; the
authoring surface can come later.

## T0 Execution Model

A T0 VM invocation uses the same async runtime path as the full VM, but the T0
opcode set itself does not initiate cross-host RPC or durable parking.

1. `$space:call(message)` validates the incoming message.
2. `$space` assigns `seq`.
3. The runtime resolves `message.target` and `message.verb`.
4. The target verb's bytecode runs to completion inside the behavior savepoint.
5. If it succeeds, mutations commit and observations are delivered.
6. If it fails, mutations roll back, the sequenced message remains accepted,
   and an error observation is delivered.

`$space` sequencing and transaction control are runtime responsibilities. The
target object's behavior is VM bytecode.

## T0 Frame

```ts
type TinyFrame = {
  pc: number;
  bytecode: TinyBytecode;
  locals: Value[];
  stack: Value[];
  this_: ObjRef;
  actor: ObjRef;
  space: ObjRef;
  seq: number;
  message: Map;
};
```

T0 has one frame at a time. There is no call stack in this subset.

## T0 Bytecode

```ts
type TinyBytecode = {
  ops: TinyOp[];
  literals: Value[];
  num_locals: number;
  max_stack: number;
  version: number;
};
```

The physical encoding can be compact later. For T0, a structured JSON
opcode representation is acceptable.

## T0 Opcodes

### Stack and Context

| Op | Stack effect | Meaning |
|---|---|---|
| `PUSH_LIT i` | `-> value` | Push literal `i`. |
| `PUSH_LOCAL i` | `-> value` | Push local `i`. |
| `POP_LOCAL i` | `value ->` | Store local `i`. |
| `PUSH_THIS` | `-> obj` | Push target object. |
| `PUSH_ACTOR` | `-> obj` | Push calling actor. |
| `PUSH_SPACE` | `-> obj` | Push current space. |
| `PUSH_SEQ` | `-> int` | Push assigned sequence number. |
| `PUSH_MESSAGE` | `-> map` | Push current message. |
| `PUSH_ARG i` | `-> value` | Push message argument `i`. `i` is zero-based in bytecode. |
| `POP` | `value ->` | Discard. |
| `DUP` | `value -> value value` | Duplicate. |

### Values

| Op | Stack effect | Meaning |
|---|---|---|
| `MAP_GET` | `map key -> value` | Read string key. Missing key raises `E_PROPNF`. |
| `MAKE_MAP n` | `k1 v1 ... kn vn -> map` | Build string-keyed map. |
| `MAKE_LIST n` | `v1 ... vn -> list` | Build list. |
| `EQ` | `a b -> bool` | Value equality. |

### Object State

| Op | Stack effect | Meaning |
|---|---|---|
| `GET_PROP` | `obj name -> value` | Read local persistent property. |
| `SET_PROP` | `obj name value ->` | Write local persistent property. |

In T0, `GET_PROP` and `SET_PROP` are local to the current behavior savepoint.
Cross-host property access is outside the tiny subset.

### Observations

| Op | Stack effect | Meaning |
|---|---|---|
| `OBSERVE` | `event ->` | Emit an observation associated with current `space` and `seq`. |

`OBSERVE` does not sequence a new message. It reports the consequence of the
message currently being applied.

### Control

| Op | Stack effect | Meaning |
|---|---|---|
| `JUMP offset` | `->` | Relative jump. |
| `JUMP_IF_FALSE offset` | `value ->` | Jump if falsy. |
| `RETURN` | `value ->` | Finish successfully. |
| `FAIL` | `err ->` | Abort this invocation with an error. |

## T0 Failure Rule

Validation before sequencing does not advance `seq`.

Failure after sequencing keeps the accepted message in the sequence, rolls back
state mutations made by the failed VM invocation, and emits an error
observation at that `seq`.

This preserves the order of attempted actions while keeping materialized state
deterministic.

## T0 Fixture Behavior Sketch

These fixtures are useful bytecode smoke tests and narrow demo building blocks.
They are not a recommendation to expose universal public mutators. If installed
on a universal ancestor such as `$root`, generic setters must be non-executable
or otherwise policy-gated; public wizard-owned generic setters are public wizard
capabilities.

Generic `object:set_value(value)`:

1. Read value from argument 0.
2. Set `this.value`.
3. Emit `value_changed`.
4. Return new value.

Generic `object:set_prop(name, value)`:

1. Read property name from argument 0.
2. Read value from argument 1.
3. Set `this[name]`.
4. Emit `property_changed`.
5. Return value.

Generic `object:echo(event)`:

1. Read event map from argument 0.
2. Emit that event.
3. Return true.

Dubspace can seed domain-specific verbs using the same generic VM mechanisms.
Those verbs belong to the demo library, not to the T0 VM subset.

## Upgrade Path

T0 should be a subset of the full VM in [vm.md](vm.md):

- T0 `TinyFrame` fields map onto full `Frame` fields.
- T0 opcodes keep names compatible with full opcodes where possible.
- T0 bytecode versions are explicit so seeded behavior can migrate.
- Full `CALL_VERB`, `SCHEDULE`, exceptions, and cross-host yield can be added
  without changing T0 object data.

## Concrete Fixtures

Canonical T0 bytecode for five fixture verbs. Each is shown as pseudocode (the verb body the implementer would write if T0 had a source language) followed by the JSON bytecode that an implementer can load directly. These are load-bearing VM fixtures; demo catalogs should prefer narrow object-specific verbs.

### Fixture 1: `object:set_value(value)`

The simplest mutator. Sets `this.value` to the first argument and emits a `value_changed` observation.

Pseudocode:
```
this.value = arg[0];
observe({ type: "value_changed", source: this, value: arg[0] });
return arg[0];
```

Bytecode:
```json
{
  "ops": [
    ["PUSH_THIS"],
    ["PUSH_LIT", 0],          // "value"
    ["PUSH_ARG", 0],
    ["SET_PROP"],
    ["PUSH_LIT", 1],          // "type"
    ["PUSH_LIT", 2],          // "value_changed"
    ["PUSH_LIT", 3],          // "source"
    ["PUSH_THIS"],
    ["PUSH_LIT", 0],          // "value"
    ["PUSH_ARG", 0],
    ["MAKE_MAP", 3],
    ["OBSERVE"],
    ["PUSH_ARG", 0],
    ["RETURN"]
  ],
  "literals": ["value", "type", "value_changed", "source"],
  "num_locals": 0,
  "max_stack": 4,
  "version": 1
}
```

### Fixture 2: `object:set_prop(name, value)`

Generic property setter: writes `this[arg[0]] = arg[1]` and emits `property_changed`.

Pseudocode:
```
this[arg[0]] = arg[1];
observe({ type: "property_changed", source: this, name: arg[0], value: arg[1] });
return arg[1];
```

Bytecode:
```json
{
  "ops": [
    ["PUSH_THIS"],
    ["PUSH_ARG", 0],
    ["PUSH_ARG", 1],
    ["SET_PROP"],
    ["PUSH_LIT", 0],          // "type"
    ["PUSH_LIT", 1],          // "property_changed"
    ["PUSH_LIT", 2],          // "source"
    ["PUSH_THIS"],
    ["PUSH_LIT", 3],          // "name"
    ["PUSH_ARG", 0],
    ["PUSH_LIT", 4],          // "value"
    ["PUSH_ARG", 1],
    ["MAKE_MAP", 4],
    ["OBSERVE"],
    ["PUSH_ARG", 1],
    ["RETURN"]
  ],
  "literals": ["type", "property_changed", "source", "name", "value"],
  "num_locals": 0,
  "max_stack": 5,
  "version": 1
}
```

### Fixture 3: `$dubspace:set_control(target, name, value)`

Mutates a control object and emits a `control_changed`. The target is in the dubspace's anchor cluster, so this is a local property write — no cross-host RPC.

Pseudocode:
```
target = arg[0];
name   = arg[1];
value  = arg[2];
target[name] = value;
observe({ type: "control_changed", source: this, target: target, name: name, value: value });
return value;
```

Bytecode:
```json
{
  "ops": [
    ["PUSH_ARG", 0],
    ["PUSH_ARG", 1],
    ["PUSH_ARG", 2],
    ["SET_PROP"],
    ["PUSH_LIT", 0],          // "type"
    ["PUSH_LIT", 1],          // "control_changed"
    ["PUSH_LIT", 2],          // "source"
    ["PUSH_THIS"],
    ["PUSH_LIT", 3],          // "target"
    ["PUSH_ARG", 0],
    ["PUSH_LIT", 4],          // "name"
    ["PUSH_ARG", 1],
    ["PUSH_LIT", 5],          // "value"
    ["PUSH_ARG", 2],
    ["MAKE_MAP", 5],
    ["OBSERVE"],
    ["PUSH_ARG", 2],
    ["RETURN"]
  ],
  "literals": ["type", "control_changed", "source", "target", "name", "value"],
  "num_locals": 0,
  "max_stack": 6,
  "version": 1
}
```

### Fixture 4: `$task:claim()`

Sets the actor as assignee, transitions status to `claimed`, emits `task_claimed`.

Pseudocode:
```
this.assignee = actor;
this.status   = "claimed";
observe({ type: "task_claimed", source: this, actor: actor });
return null;
```

Bytecode:
```json
{
  "ops": [
    ["PUSH_THIS"],
    ["PUSH_LIT", 0],          // "assignee"
    ["PUSH_ACTOR"],
    ["SET_PROP"],
    ["PUSH_THIS"],
    ["PUSH_LIT", 1],          // "status"
    ["PUSH_LIT", 2],          // "claimed"
    ["SET_PROP"],
    ["PUSH_LIT", 3],          // "type"
    ["PUSH_LIT", 4],          // "task_claimed"
    ["PUSH_LIT", 5],          // "source"
    ["PUSH_THIS"],
    ["PUSH_LIT", 6],          // "actor"
    ["PUSH_ACTOR"],
    ["MAKE_MAP", 3],
    ["OBSERVE"],
    ["PUSH_LIT", 7],          // null
    ["RETURN"]
  ],
  "literals": ["assignee", "status", "claimed", "type", "task_claimed", "source", "actor", null],
  "num_locals": 0,
  "max_stack": 4,
  "version": 1
}
```

### Fixture 5: `$task:set_status(status)` with soft-DoD check

Sets the status. If transitioning to `"done"` while requirements are unchecked, also emits `done_premature` with the unchecked items. The status change itself always applies (soft enforcement, per the tasks catalog design).

This fixture is the most involved because it has a conditional. Pseudocode:

```
status = arg[0];
this.status = status;
observe({ type: "status_changed", source: this, status: status });
if (status == "done") {
  let unchecked = filter_unchecked(this.requirements);
  if (length(unchecked) > 0) {
    observe({ type: "done_premature", source: this, unchecked: unchecked });
  }
}
return status;
```

Bytecode (simplified; assumes a `filter_unchecked` and `length` available via `BUILTIN`, which T0 does not have — for T0, the check is unrolled inline or pre-computed by the caller). For an implementation that does not yet have builtins, the `done_premature` check can be omitted from the bytecode and emitted by a wrapper outside the VM:

```json
{
  "ops": [
    ["PUSH_THIS"],
    ["PUSH_LIT", 0],          // "status"
    ["PUSH_ARG", 0],
    ["SET_PROP"],
    ["PUSH_LIT", 1],          // "type"
    ["PUSH_LIT", 2],          // "status_changed"
    ["PUSH_LIT", 3],          // "source"
    ["PUSH_THIS"],
    ["PUSH_LIT", 0],          // "status"
    ["PUSH_ARG", 0],
    ["MAKE_MAP", 3],
    ["OBSERVE"],
    ["PUSH_ARG", 0],
    ["RETURN"]
  ],
  "literals": ["status", "type", "status_changed", "source"],
  "num_locals": 0,
  "max_stack": 4,
  "version": 1
}
```

The soft-DoD `done_premature` observation is emitted by the host's call-handler wrapper after the verb returns, by inspecting `this.status` and `this.requirements` directly. This keeps T0 free of list-iteration opcodes; full-VM verbs can do the check inline once `BUILTIN length` and a list-filter pattern exist.

### Notes on the fixtures

- All five use only the T0 opcodes defined above. No control flow except `RETURN` and conditional jumps for the wrapper logic.
- `OBSERVE` carries the observation's space and seq via the runtime (per the `OBSERVE` opcode spec); the fixture only constructs the observation map.
- Literals are deduplicated within a verb. Implementations may also intern across verbs.
- Fixtures are version 1; future fixture revisions bump the version field and remain loadable by any T0 implementation that recognizes the version.
