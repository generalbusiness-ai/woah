# Eval — `;` and `;;`

`$programmer:eval(source, opts?)` is woah's analogue of LambdaCore's
`eval`. It compiles a piece of woocode through the same DSL pipeline
as `install_verb`, then runs the bytecode under the invoking
actor's `progr`. The verb is `tool_exposed`, so MCP-attached
programmer agents see it. Humans reach the same surface through
chat aliases.

This is the most powerful tool in the catalog. It's also the largest
authority surface — eval runs with the calling actor's authority,
not the catalog installer's.

## Calling shapes

**MCP / direct call:**

```
woo_call("$me", "eval", ["#the_chatroom:say(\"hi\")", {}])
woo_call("$me", "eval", ["create($thing, {name: \"a thing\"})", {mode: "expr"}])
```

**Chat alias for expression mode (`;`):**

```
;#the_chatroom:say("hi")
```

The chat planner intercepts a leading `;` (alone, not followed by
`;`), wraps the rest as `eval(<text>, {mode: "expr"})`, and
dispatches to the speaker's eval verb.

**Chat alias for statement mode (`;;`):**

```
;;let n = 0; for x in [1,2,3] { n = n + x; } observe({type: "say", text: "sum=" + tostr(n)});
```

A leading `;;` runs the body verbatim as a verb body, equivalent to
`eval(<text>, {mode: "stmts"})`.

## Naming objects: `#id` and `$name`

This is the first thing that trips people (and agents) up. **A bare word in
eval source is never an object.** Bare names resolve only to locals, verb
arguments, and frame globals (`this`, `actor`, `caller`, `progr`). An object is
written as a literal:

| Form | Meaning | Example |
|---|---|---|
| `#<id>` | objref literal — an object addressed by its id | `;#obj_human_2_1:ping()` |
| `$<name>` | corename literal — resolved through `$system` | `;$wiz.name` |

`create(...)` hands back a **bare** id (`obj_human_2_1`). Typing that straight
back into eval fails:

```
;obj_human_2_1:ping()
compile error: E_COMPILE unknown identifier: obj_human_2_1
  (obj_human_2_1 is an object; address it with the objref literal —
   did you mean #obj_human_2_1?)
```

Add the `#` and it works. The literal ends at the first character that is not
a letter, digit, `_` or `-`, so `.` and `:` after it behave normally:
`#the_mug.description` reads a property, `#the_mug:read()` calls a verb.

## Modes

| Mode | What gets compiled |
|---|---|
| `"expr"` (default) | `return <source>;` — single expression. The result is the eval's return value. |
| `"stmts"` | `<source>` verbatim — a sequence of statements. The eval's return value is whatever the body returns explicitly, or `null`. |

Pick `expr` for one-liners (the chat `;` alias is `expr` mode).
Pick `stmts` for anything multi-statement, with explicit `let`
locals or control flow.

## Options

| Option | Effect |
|---|---|
| `mode` | `"expr"` or `"stmts"`. Default `"expr"`. |
| `dry_run: true` | Compile and return diagnostics without running. Useful for "would this even parse?" |

## Authority

The same hard gate as the rest of the programmer surface:

- Wizard, **OR**
- A `$programmer` descendant **AND** the `programmer` flag set.

Without these, the eval verb returns `E_PERM`. There is no
reduced-authority eval (LambdaCore's `$no_one`) — that's a separate
safety story and isn't shipped yet.

## How errors and rollbacks work

**Compile errors** return `{ok: false, diagnostics: [...]}`. No body
runs; nothing changes.

**Runtime errors** thrown by the body propagate up to the outer
direct-call transaction. The transaction **rolls back property
writes and placement changes**. The chat layer then
renders the error frame.

This rollback is deliberate. Without it, a chat-fired
`;;create($thing, {}); 1/0;` would leave a half-built object in the
world. Returning `{ok: false}` instead of throwing would have
committed the create. So eval throws on runtime error and the
transaction discipline cleans up.

The trade-off: eval doesn't return a structured diagnostic envelope
on runtime failure. You see a plain error in chat. If you want
structured failure handling, wrap your dangerous statements in a
verb on an object and let that verb decide what to do.

## Use cases

**Quick property read:**

```
;#the_lamp.color
```

(One-line read; `expr` mode returns the value.)

**Quick verb call:**

```
;#the_lamp:turn_on()
```

**Bulk operation:**

```
;;for child in children($lamp) {
  observe({type: "say", text: tostr(child) + " " + child.name});
}
```

**Diagnostic without committing:**

```
woo_call("$me", "eval", ["create($thing, {name: \"test\"})", {dry_run: true}])
```

Returns the would-have-been diagnostic without creating anything.

## Why eval matters for agents

For an MCP agent on the programmer surface, `eval` collapses the
common multi-call pattern into one tool call. Instead of:

```
woo_call("the_lamp", "turn_on", [])
woo_call("the_lamp", "set_color", ["blue"])
```

…you can:

```
woo_call("$me", "eval", ["#the_lamp:turn_on(); #the_lamp:set_color(\"blue\")", {mode: "stmts"}])
```

Each `woo_call` round-trip costs an MCP turn; one `eval` doesn't.
For exploratory work and chained operations, eval is the cheap path.

For *production* agent behavior (predictable, retryable, observable
operations), prefer named tool calls. Eval is debugging and
exploration; it's not a stable API.

## What you can do in an eval body

Everything the DSL supports — see
[`../../spec/semantics/language.md`](../../spec/semantics/language.md).
Notable for eval:

- `actor`, `caller`, `progr`, `this` — bound as expected. `this` in
  an eval body is the actor (the eval verb's target).
- Built-in operations like `create`, `recycle`, `moveto`, `isa`,
  `verbs(obj)`, `verb_info`, `verb_code`, `properties`,
  `property_info` are reachable.
- Property reads/writes, verb calls, observations, errors — all
  ordinary woocode.

The compiler is the same one used for `install_verb`, so syntax that
won't compile as a verb body won't compile in eval either. Use
`opts.dry_run: true` to check before running.

## Editor-style hot reloading

Combined with `install_verb`, eval is the fast feedback loop:

```
;;let r = $programmer:install_verb(#the_lamp, "turn_on", "verb :turn_on() rxd { this.lit = true; observe({type: \"say\", text: \"clicked.\"}); }", {dry_run: true});
observe({type: "say", text: "diagnostics: " + tostr(r["diagnostics"])});
```

Drop the `dry_run` to commit. This is roughly the LambdaCore loop
(`@verb`, `@program`, immediately `@list` to inspect) collapsed
into one-liners.
