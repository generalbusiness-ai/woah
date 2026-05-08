---
date: 2026-05-01
status: implemented
---

# Type system and DSL

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

Covers the runtime type system and the surface syntax of the verb language. The bytecode it lowers to is in [vm.md §8](vm.md).

---

## 6. Type system

Values are tagged. The runtime knows the following types:

| Type | Tag | Notes |
|---|---|---|
| `int` | `i` | 53-bit safe signed integer (v1; `bigint` later if needed). |
| `float` | `f` | IEEE 754 double. |
| `str` | `s` | UTF-8. |
| `obj` | `o` | Persistent objref. |
| `tref` | `t` | Transient objref. |
| `list` | `l` | Heterogeneous, 1-indexed (MOO convention). |
| `map` | `m` | String-keyed. JSON-shaped. |
| `err` | `e` | Tagged error value (see [builtins §20](builtins.md#20-errors)). |

Coercions are explicit (`tostr`, `toint`, `tofloat`, `toobj`). The arithmetic and comparison operators are type-polymorphic at runtime; mismatches raise `E_TYPE`.

`map` keys are strings only in v1. (MOO had no map; people abused alists. We do this right.)

Object refs compare by identity (`==` does pointer equality on the id). Lists and maps compare structurally.

---

## 7. DSL syntax

MOO-flavored, with curly braces and modern niceties. Async is implicit; there is no `await` keyword. Every `.` and `:` is a potential yield point — the compiler emits opcodes that the VM yields on if the target is remote.

### 7.1 Verb declaration

```
verb #room:look (this none none) rxd {
  player:tell(this.description);
  for thing in this.contents {
    if (thing != player && thing.visible) {
      player:tell("  " + thing.name);
    }
  }
}
```

The header is `verb` `<obj>` `:` `<name>` `(` `<arg-spec>` `)` `<perms>` `{` ... `}`.

- `<arg-spec>` is the MOO `(dobj prep iobj)` triple for command-line dispatch. Use `(this none none)` for verbs called only by program.
- `<perms>` is a subset of `r` (readable source), `w` (writable by non-owner), `x` (executable as a command), `d` (direct-callable shorthand). `d` is accepted only in source/catalog authoring syntax; installed verb metadata stores `direct_callable: true` separately and strips `d` from persisted `perms`.

### 7.2 Statements

```
let x = 5;
const name = "alice";
x = x + 1;
this.foo = bar;

if (cond) { ... } else if (cond2) { ... } else { ... }

for x in list { ... }
for k, v in map { ... }
for i in [1..10] { ... }     // inclusive int range
while (cond) { ... }
break; continue;

return value;

try { ... } except err in (E_PERM, E_PROPNF) { ... } finally { ... }

fork(60) { player:tell("a minute later"); }
suspend(seconds);
let input = read(player);

observe(event);
emit(target, event);
observe_to_space(space, event);
location(obj);
```

`observe(event)` records an observation on the current invocation route. Inside a
sequenced call it lands in the applied frame; inside a direct call it is live
only. `emit(target, event)` records the same event with an explicit delivery
target. `observe_to_space(space, event)` is the same observation operation with
delivery audience taken from `space`; catalog objects use it for room-visible
activity when the emitting object is a mounted space on another host.
`location(obj)` returns the object's current container without treating
`location` as a user-defined property. When `obj` is the calling actor and
the call has a live session, it returns that session's `current_location`;
otherwise it returns the stored object location mirror.

### 7.3 Expressions

```
this.location.name           // chained property access; each `.` may yield
target.(name)                // dynamic property access; name expression yields str
this:verb(arg1, arg2)        // verb call; may yield for host RPC
$wiz:announce("hello")       // corename; resolves through $system
pass(arg1, arg2)             // call this verb's parent-chain version
[1, 2, 3]                    // list literal
{ "type": "say", "body": s } // map literal
@args                        // splat (in call args or list construction)
"hello, ${name}"             // string interpolation
typeof(x), tostr(x), toint(x)
```

Operators (precedence high to low):
```
.  :  [ ]   (member, verb, index)
- !          (unary)
* / %
+ -
< <= > >= == != in
&&
||
=            (assignment, only at statement level)
```

`.` and `:` are syntactically distinct: `.` is property access (data), `:` is verb call (dispatch). Both may yield.

`obj.(expr)` is dynamic property access. `expr` must evaluate to a string. It
uses the same `GET_PROP` / `SET_PROP` semantics as `obj.name`, but the property
name is supplied at runtime.

`a[i]` indexes lists (1-based) and maps (by key). It is sugar for `index(a, i)`.

### 7.4 Comments

```
// line comment
/* block comment */
```

### 7.5 What is *not* here

- No `class` / `extends` (objects exist at runtime, no class system).
- No `function` declarations (the unit is a verb).
- No `async`/`await` (everything is implicitly suspendable).
- No `import` (verbs cannot pull in other modules in v1).
- No prototype manipulation.
- No DSL-level `eval(string)` builtin. Programmer authoring includes a
  `$programmer:eval(source, opts?)` verb (catalog `prog`, with chat aliases
  `;expr` and `;;stmts`) that compiles and runs source through the same path
  as `setVerb`-style installs, but the wrapped verb runs as the invoking
  programmer's `progr` and is never persisted. The DSL itself stays free of
  string-to-bytecode primitives.
