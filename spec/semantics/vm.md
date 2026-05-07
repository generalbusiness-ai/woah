---
date: 2026-04-30
status: implemented
---

# Bytecode and VM

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

Covers the VM's data structures (frames, tasks, bytecode), the full opcode table with stack effects and yield semantics, tick and memory metering, and the per-host scheduler. Task lifecycle (suspend, fork, read) is in [tasks.md §16](tasks.md).

---

## 8. Bytecode and VM

### 8.1 Activation frame

```ts
type Frame = {
  pc: number;                  // program counter into bytecode
  bytecode: Bytecode;          // interned by (definer, verb_name, version)
  locals: Value[];             // by index
  stack: Value[];              // operand stack
  this_: ObjRef;
  player: ObjRef;
  caller: ObjRef;
  progr: ObjRef;               // permissions principal (verb owner at compile time)
  verb_name: string;
  definer: ObjRef;             // object the verb was defined on
  handlers: Handler[];         // try/except handler stack
};

type Task = {
  id: string;                  // uuid
  frames: Frame[];             // bottom = entry, top = current
  ticks_remaining: number;
  memory_used: number;
  state: 'running' | 'suspended' | 'awaiting_read' | 'done';
  resume_at?: number;          // ms timestamp, when state='suspended'
  awaiting?: AwaitingInfo;
  origin: ObjRef;              // host where task was created (for return routing)
  actor: ObjRef;               // sticky; the principal that initiated this task
};
```

### 8.1.1 Task globals visible in verb bodies

Verb-body source code reads these as bare names (the compiler resolves them to opcodes that pull from the active frame or task). Implementations must expose exactly this set:

| Name | Source | Sticky? | Meaning |
|---|---|---|---|
| `this` | current frame | no | The target object the verb is executing on. Changes on `CALL_VERB` to a different object. |
| `player` | task-level | **yes** | The connected actor whose session originated the task. Does not change across `CALL_VERB`, even into a wizard verb. Mirrors MOO's `set_task_perms` discipline. |
| `actor` | task-level | **yes** | The principal that initiated this task. For sequenced calls, equals `message.actor`. For direct calls, equals the bearer's session actor. Sticky across `CALL_VERB`. May differ from `player` when an agent acts on behalf of a user. |
| `caller` | current frame | no | The previous frame's `this`. `#-1` (no caller) on the entry frame. |
| `progr` | current frame | no | The verb's owner at compile time — the *code authority*, not the calling principal. Used for permission checks. Wizard-flagged verbs run with elevated `progr` regardless of caller. |
| `verb` | current frame | no | The name (string) the verb was invoked under. May differ from `definer`'s canonical verb name when invoked via an alias. |
| `definer` | current frame | no | The object on which this verb was defined (the ancestor where lookup matched). `pass()` resolves the next verb up from `definer`, not `this`. |
| `args` | current frame | no | The argument list passed to the verb. |

**Authority and audit.** `progr` is for "is this code allowed to do X" (compile-time authority). `actor` is for "who is calling right now" (runtime principal). Workflow gates ([operations/workflows.md §WF4](../operations/workflows.md#wf4-roles-and-gating)) use `actor`; permission flags on verbs and properties use `progr`. The two answer different questions and must not be conflated. `task_perms()`, `caller_perms()`, and `set_task_perms(actor)` expose the MOO-style authority-drop surface without adding new globals.

**MOO parser globals not present.** LambdaMOO exposed `dobj`, `dobjstr`, `prepstr`, `iobj`, `iobjstr`, `argstr` from its built-in command parser. woo has no built-in text parser — chat-shaped interfaces build their own (see [match.md](match.md)). These names are reserved but unbound in the v1 VM.

### 8.2 Bytecode layout

A compiled verb is:

```ts
type Bytecode = {
  ops: Uint8Array;             // opcode stream
  literals: Value[];           // constant pool
  var_names: string[];         // for debugging / introspection
  num_locals: number;          // pre-allocated local slots
  max_stack: number;           // for static stack-depth check
  line_map: { pc: number; line: number }[];  // for tracebacks
  source_hash: string;         // sha256 of source for cache keying
  version: number;             // monotonic per (definer, name)
};
```

### 8.3 Opcodes

The opcode byte is followed by zero or more immediate operands (varint-encoded). The "Yield" column marks opcodes that may yield the task (cross-host RPC, wait, or scheduler boundary).

#### 8.3.1 Stack and locals

| Op | Operands | Stack effect | Yield | Description |
|---|---|---|---|---|
| `PUSH_LIT` | lit_idx | → val | N | Push literal pool entry. |
| `PUSH_INT` | int (varint) | → int | N | Push small inline integer. |
| `PUSH_LOCAL` | local_idx | → val | N | Push local slot. |
| `POP_LOCAL` | local_idx | val → | N | Pop into local slot. |
| `PUSH_THIS` | — | → obj | N | Push current frame's `this`. |
| `PUSH_PLAYER` | — | → obj | N | Push current frame's `player`. |
| `PUSH_CALLER` | — | → obj | N | Push current frame's `caller`. |
| `PUSH_PROGR` | — | → obj | N | Push current frame's `progr`. |
| `PUSH_VERB` | — | → str | N | Push current verb name. |
| `PUSH_ARGS` | — | → list | N | Push current frame's argument list. |
| `POP` | — | val → | N | Discard top of stack. |
| `DUP` | — | val → val val | N | Duplicate top. |
| `SWAP` | — | a b → b a | N | Swap top two. |

#### 8.3.2 Arithmetic, comparison, logic

| Op | Operands | Stack effect | Yield | Description |
|---|---|---|---|---|
| `ADD` | — | a b → a+b | N | Polymorphic: int+int, float+float, str+str (concat), list+list (concat). |
| `SUB` | — | a b → a-b | N | Numeric. |
| `MUL` | — | a b → a*b | N | Numeric. Also int*str = repeat. |
| `DIV` | — | a b → a/b | N | Integer division for int/int; raises `E_DIV` on zero. |
| `MOD` | — | a b → a%b | N | Numeric. |
| `NEG` | — | a → -a | N | Numeric. |
| `NOT` | — | a → !a | N | Truthy → false / falsy → true. |
| `EQ` | — | a b → bool | N | Identity for objs/trefs; structural for lists/maps; value for primitives. |
| `NEQ` | — | a b → bool | N | Negation of `EQ`. |
| `LT` `LE` `GT` `GE` | — | a b → bool | N | Numeric or string lex. Other types → `E_TYPE`. |
| `IN` | — | needle haystack → bool | N | List membership or map key membership. |

Logical `&&` and `||` are compiled to short-circuit jumps; no dedicated opcode.

#### 8.3.3 Control flow

| Op | Operands | Stack effect | Yield | Description |
|---|---|---|---|---|
| `JUMP` | offset (i16) | — | N | Unconditional. |
| `JUMP_IF_TRUE` | offset | a → | N | Pop and jump if truthy. |
| `JUMP_IF_FALSE` | offset | a → | N | Pop and jump if falsy. |
| `JUMP_IF_TRUE_KEEP` | offset | a → a | N | Conditional jump without consuming. (For `&&`/`||`.) |
| `JUMP_IF_FALSE_KEEP` | offset | a → a | N | As above. |

#### 8.3.4 Loops (open-coded iterators)

| Op | Operands | Stack effect | Yield | Description |
|---|---|---|---|---|
| `FOR_LIST_INIT` | local_idx | list → list 0 | N | Push iterator state; init index local. |
| `FOR_LIST_NEXT` | local_idx, end_offset | list i → list i+1 | N | If past end, jump; else store list[i] in `local_idx`. |
| `FOR_RANGE_INIT` | local_idx | hi lo → hi lo | N | Set local to lo. |
| `FOR_RANGE_NEXT` | local_idx, end_offset | hi lo → hi lo+1 | N | If lo > hi, jump; else store lo in local. |
| `FOR_MAP_INIT` | k_idx, v_idx | map → map 0 | N | Init map iteration. Order = insertion order. |
| `FOR_MAP_NEXT` | k_idx, v_idx, end_offset | map i → map i+1 | N | Bind k and v locals; jump on end. |
| `FOR_END` | — | iter_state → | N | Pop iterator state on normal exit. |

#### 8.3.5 Property access

| Op | Operands | Stack effect | Yield | Description |
|---|---|---|---|---|
| `GET_PROP` | — | obj name → val | **Y** | Walk prop-def chain; read value from owning object's storage. RPC if obj is remote. |
| `SET_PROP` | — | obj name val → | **Y** | Write value on `obj`'s own storage; check perms. RPC if obj is remote. |
| `HAS_PROP` | — | obj name → bool | **Y** | Check if prop exists (defined anywhere in chain). |
| `DEFINE_PROP` | — | obj name default perms → | N | Introduce a new prop slot on `obj`. Visible to descendants. If `obj` is remote, raise `E_CROSS_HOST_WRITE`. |
| `UNDEFINE_PROP` | — | obj name → | N | Remove a prop definition from `obj`. If `obj` is remote, raise `E_CROSS_HOST_WRITE`. |
| `PROP_INFO` | — | obj name → map | **Y** | Returns `{owner, perms, defined_on, type_hint}`. |
| `SET_PROP_INFO` | — | obj name infomap → | N | Set perms/owner. If `obj` is remote, raise `E_CROSS_HOST_WRITE`. |

`GET_PROP` semantics:
1. If `obj` is local to this host, look up the value in this host's persistent storage.
2. If a value is stored, return it.
3. Else walk the parent chain (cached, see [../reference/persistence.md §15](../reference/persistence.md#15-caching-and-invalidation)) for the **default**; return the default.
4. If `obj` is remote, RPC to the owning host with the prop name, which performs steps 1–3 and returns.

#### 8.3.6 Verb dispatch

| Op | Operands | Stack effect | Yield | Description |
|---|---|---|---|---|
| `CALL_VERB` | argc | obj name [args...] → result | **Y** | Resolve verb using standard lookup (parent chain, then features where applicable). Migrate task to obj's host; new frame; on return, value back. |
| `PASS` | argc | [args...] → result | **Y** | Like CALL_VERB but on `this`, starting search at `definer.parent`. |
| `RETURN` | — | val → | N | Pop frame; if last frame, task done; else push val onto caller's stack. |
| `RAISE` | — | err → | N | Raise. Walks handler stack; on no handler and `d` perm, abort task. |
| `BUILTIN` | bi_idx, argc | [args...] → result | **Maybe** | Call builtin function by index. Yield depends on builtin (e.g., `read()` yields). |

`CALL_VERB` algorithm:
1. Pop args, name, obj from stack.
2. If `obj` is remote: serialize current frame state, RPC the call to obj's host, suspend until reply. The remote host runs steps 3–6 and returns.
3. Resolve verb: look up `(obj, name)` in this host's local verb cache. On miss, use the standard lookup rule ([objects.md §9.1](objects.md#91-lookup): parent chain, then features where applicable), fetch bytecode from the defining object/ancestor's host if not local, store in cache.
4. Permission check: caller `progr` must have `x` on the verb (or be the owner, or a wizard).
5. Push new frame: `this=obj`, `caller=current.this_`, `player=current.player` (player is sticky through the chain), `progr=verb.owner`, `verb_name=name`, `definer=ancestor_with_verb`, locals init from args.
6. Resume execution in new frame.

**Sticky `player`:** once a connection's task starts, `player` does not change across verb calls within the same task, even when a wizard verb is invoked. This is MOO's `set_task_perms` discipline; we keep it.

#### 8.3.7 List, map, string (hot path)

| Op | Operands | Stack effect | Yield | Description |
|---|---|---|---|---|
| `MAKE_LIST` | n | a₁..aₙ → list | N | Build list of size n from top of stack. |
| `MAKE_MAP` | n | k₁ v₁..kₙ vₙ → map | N | Build map. |
| `LIST_GET` | — | list i → val | N | 1-indexed. `E_RANGE` if out of bounds. |
| `LIST_SET` | — | list i val → list' | N | Functional set; returns new list. |
| `LIST_APPEND` | — | list val → list' | N | Functional append. |
| `MAP_GET` | — | map key → val | N | `E_PROPNF` if missing. |
| `MAP_SET` | — | map key val → map' | N | Functional. |
| `INDEX_GET` | — | collection key → val | N | Runtime-dispatched list/map index. Lists use 1-indexed numeric keys; maps use string keys. |
| `INDEX_SET` | — | collection key val → collection' | N | Runtime-dispatched functional list/map update. |
| `STR_CONCAT` | n | s₁..sₙ → str | N | Concat n strings. Template strings lower to this. |
| `STR_INTERP` | n | s₁..sₙ → str | N | Join already-stringified interpolation parts. |
| `SPLAT` | — | list → val₁..valₙ | N | Used in `f(@args)` and `[1, 2, @rest]`. |

Cold-path operations (`length`, `slice`, `delete`, `has`, `keys`, type coercions, string interpolation patterns beyond simple concat) are builtins (§19), invoked via `BUILTIN`. Hot-path opcodes are limited to what's worth specializing in the dispatch loop.

#### 8.3.8 Async, scheduling, events

| Op | Operands | Stack effect | Yield | Description |
|---|---|---|---|---|
| `SUSPEND` | — | seconds → | **Y** | Serialize task; schedule resume via the host scheduler. Returns 0 to caller on resume; raises `E_INTRPT` if killed. |
| `READ` | — | player → input | **Y** | Suspend task awaiting input from given player. |
| `FORK` | argc | seconds verb_obj verb_name [args...] → task_id | **Y** | Spawn a new task to call `verb_obj:verb_name(args)` after `seconds` delay. |
| `EMIT` | — | target event → | **Y** | Send event. Target may be obj, list of objs, or `$everyone_in(room)`. RPC to remote targets. |
| `YIELD` | — | — | **Y** | Cooperative scheduler boundary. Inserted at backedges of long loops. |

The forked task starts with a fresh frame for the named verb call. The forking task continues at the next opcode without waiting. Forked task's `progr` = forking verb's `progr`; `player` = forking task's `player` (sticky); `caller` = `#-1`.

#### 8.3.9 Exceptions

| Op | Operands | Stack effect | Yield | Description |
|---|---|---|---|---|
| `TRY_PUSH` | catch_offset, errs_lit_idx | — | N | Install handler for given errs (literal pool list of err codes; empty = catch all). |
| `TRY_POP` | — | — | N | Uninstall topmost handler. |
| `RAISE` | — | err → | N | (Repeated from §8.3.6 for grouping.) |

Handler frames record the operand stack depth at install; on raise, the stack is truncated to that depth and the err value is pushed before jumping to the catch.

### 8.4 Tick metering

Every opcode dispatch decrements `ticks_remaining` by a per-op weight (default 1; some opcodes cost more). When it reaches zero, the task is aborted with `E_TICKS`.

Initial budget: `100_000` ticks for a foreground task, `30_000` for a forked task. Refilled on `SUSPEND`/`READ` resume to avoid death-by-suspension; **not** refilled on `RAISE`/`TRY` — catching `E_TICKS` does not give the task a fresh budget. The very next opcode dispatch re-fires the error.

Op weights (defaults; tunable per-world):

| Op | Weight |
|---|---|
| Most ops | 1 |
| `STR_INTERP`, `MAP_KEYS`, `LIST_SLICE` | 5 |
| `GET_PROP` / `SET_PROP` local | 5 |
| `GET_PROP` remote (RPC) | 100 |
| `SET_PROP` remote (RPC) | 100 |
| `CALL_VERB` local | 10 |
| `CALL_VERB` remote (host RPC) | 500 |
| `EMIT` to local target | 10 per recipient |
| `EMIT` to remote target | 100 per recipient |
| `BUILTIN create()` | 50 |

Remote-op weights are how the tick budget catches RPC-amplification attacks (a verb that fans out 1000 prop reads across remote objects spends 100k ticks on dispatch alone).

### 8.5 Memory metering

Every `MAKE_LIST`, `MAKE_MAP`, `STR_CONCAT`, `LIST_APPEND`, etc. accumulates an estimated size into `memory_used`. Threshold (4 MiB default) raises `E_MEM`.

Like the tick budget, `memory_used` is monotone within a task: catching `E_MEM` does not free already-allocated values. The handler runs only if it can do so without further allocation; otherwise the error re-fires.

### 8.6 Scheduler

Each host has a single-threaded scheduler. At any moment, zero or one task is running on the host. Other tasks queue at the input gate. Cross-host RPC for verb dispatch and prop access are awaited on; the receiving host schedules the callee frame in its own queue and returns result plus observations.

Cooperative `YIELD` opcodes are inserted at compile time at:
- Loop back-edges
- After every Nth straight-line opcode in a basic block (N=64)

This bounds the time any single task can hold the host without releasing the input gate.

### 8.7 Wall-time budget

Tick metering counts opcodes; it does not count time spent waiting on cross-host RPCs, hibernation, or scheduler queueing. A separate **wall-clock budget** caps total time-since-task-start:

| Task class | Default cap | Notes |
|---|---|---|
| Foreground (response to player input) | 10 seconds | The player is waiting. |
| Forked / scheduled | 60 seconds | No human in the loop. |
| `SUSPEND` / `READ` | not counted | The clock pauses while parked. |

When the cap expires, the task is aborted with `E_TIMEOUT`. Like ticks and memory, the budget is monotone — catching it does not reset the clock.

Enforcement: a check on every opcode dispatch (`now() - task.started_at > cap`). One comparison; cheap.
