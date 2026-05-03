# DSL Compiler M1

> **Status: M1 landed** (commit `82e2e0c`). Implementation in
> `src/core/dsl-compiler.ts` (~1200 lines) is the canonical source compiler;
> the regex-shaped T0 compiler is fully replaced. Acceptance tests below were
> all met as of the landing commit (see `tests/core.test.ts` set_feedback,
> index_and_interp, explode, sum_to, verb-calls + pass + try/except, bad source,
> and JSON-fallback cases). M1.1 pressure-ring items remain forward-looking.

## Purpose

The v0.5 VM can run useful object programs, but the authoring path still depends
on a regex-shaped source compiler and JSON bytecode fallback. M1 makes Woo
source the normal path for authored behavior while preserving JSON bytecode as a
debugging and bootstrap escape hatch.

## Scope

Compiler M1 is intentionally smaller than the full language spec.

Required:

- Lexer with source spans for structured diagnostics.
- Parser for one verb declaration per source string.
- Local bindings from verb parameters, `let`, and `const`.
- Statements:
  - block, expression statement, local declaration, assignment
  - `if` / `else`
  - `while`
  - `for x in list`, `for k, v in map`, and `for i in [lo..hi]`
  - `break`, `continue`
  - `return`
  - `observe(event)`, `emit(target, event)`
  - `raise value`
  - `try { ... } except err in (...) { ... }`
- Expressions:
  - null, booleans, numbers, strings, object/corename literals
  - local names and VM frame globals (`this`, `actor`, `player`, `caller`,
    `progr`, `space`, `seq`, `message`, `args`, `verb`)
  - list and map literals
  - property reads (`obj.name`)
  - list indexing (`list[i]`)
  - string-key map indexing (`map["key"]`)
  - verb calls (`obj:verb(args)`) and `pass(args)`
  - builtin calls backed by the current VM builtin set
  - unary, arithmetic, comparison, `in`, `&&`, and `||`

Deferred:

- Full command-dispatch argument grammar.
- String interpolation syntax beyond the VM's bytecode opcode.
- Destructuring, typed signatures, and typed diagnostics.
- `fork { ... }` block syntax.
- Static stack-depth verification beyond the existing runtime checks.
- Cross-host yield and migration semantics.

## Acceptance Tests

M1 is done when source programs can be compiled, installed, and run through the
existing world:

- The old dubspace-shaped `set_feedback` source still compiles and runs.
- A source verb with locals, arithmetic, conditionals, and loops mutates state.
- A source verb can call another verb and use `pass`.
- A source verb can raise and catch an error with `try` / `except`.
- Bad syntax returns structured diagnostics with spans.
- JSON bytecode fallback remains available.

## Non-Goals

This milestone is not the full IDE, not the conformance harness, and not a new
runtime. It is the first real compiler over the runtime that already exists.

## M1.1 Pressure Ring

After M1, expand only where real authored objects immediately press:

- Preserve parsed header metadata on install:
  - source verb name
  - perms
  - programmatic params or MOO-style `{dobj, prep, iobj}` arg spec
- Emit `line_map` entries keyed by bytecode pc so runtime traces can point back
  to source spans.
- Attach compact trace frames to uncaught VM errors.
- Add dynamic index opcodes for list/map get and set so source can write
  `controls[name] = value`.
- Add basic string interpolation lowering to `STR_INTERP`.
- Move one small seeded demo behavior from native code to authored source.

Still deferred:

- Full source maps with expression-level columns for every intermediate value.
- Static stack-depth verification.
- `finally`.
- Block-form `fork`.
- Typed signatures and command grammar.
- Broad native-to-source conversion.
