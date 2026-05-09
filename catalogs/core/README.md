---
name: core
version: 0.1.0
spec_version: v1
license: MIT
description: LambdaCore-shaped utility packages — $command_utils today, $string_utils / $object_utils / $list_utils as needed.
keywords:
  - core
  - utils
  - lambdacore
  - convention
---

# core

A small bucket of LambdaCore-shaped utility singletons that catalog
code can call instead of inlining the same notify-and-bail branches.

Rationale and scope discipline live in [DESIGN.md](DESIGN.md).

The naming and shape deliberately mirror LambdaCore: `$command_utils`
is the same handle and the same verbs as #219 in a live LambdaMOO. A
verb that's been ported to woo carries an explicit comment for any
divergence from the LambdaCore source.

## Classes

### `$utils`

Marker base class. Mirrors LambdaCore's `Generic Utilities Package`
(#288). Carries only the optional `help_msg` property and exists so
helper singletons share an obvious common parent.

### `$command_utils`

Mirrors LambdaCore `$command_utils` (#219). Helpers that command
verbs use after the parser hands them a resolved direct/indirect
object.

| Verb | LambdaCore line | Status |
|---|---|---|
| `:object_match_failed(match_result, string)` | `#219:object_match_failed` | **Implemented.** Notifies the actor on `$nothing` / `$failed_match` / `$ambiguous_match`; returns `true` iff the match was bad. |
| `:player_match_failed`, `:player_match_result` | #219:player_match_* | Deferred — woo has no `$player_db` analogue yet. |
| `:do_huh(verb, args)` | #219:do_huh | Already covered by `$match:plan_command`'s huh chain (`my_huh` → `here_huh` → `last_huh`). Adding the verb is a no-op rewrap. |
| `:read([prompt])`, `:read_lines`, `:yes_or_no` | #219:read* | Deferred — woo's input model differs from MOO's blocking `read()`. |
| `:running_out_of_time`, `:suspend_if_needed`, `:kill_if_laggy`, `:task_info` | #219 task helpers | Deferred — woo's task budget surface lands separately. |
| `:dump_lines(seq)` | #219:dump_lines | Trivial wrapper over `tell` / `tell_lines`; defer until needed. |
| `:explain_syntax(here, verb, args)` | #219:explain_syntax | Defer; programmer surface, not command surface. |
| `:validate_feature` | #219:validate_feature | Defer; feature attachment policy is woo-specific. |

When a catalog reaches for one of the deferred verbs, port it next.
The lookup table above is the contract; the body comment in each verb
is where the divergence justification lives.

## Adding to a verb

```woo
verb :recycle_command(dobjstr) rxd {
  let dobj = $match:match_object(dobjstr);
  if ($command_utils:object_match_failed(dobj, dobjstr)) {
    return null;
  }
  // dobj is a real object from here on.
  ...
}
```

`$command_utils` is the class itself, called directly the same way
chat-catalog code calls `$match:match_object(…)`. There's no separate
singleton instance — the class is its own singleton, mirroring the
LambdaCore convention where #219 *is* `$command_utils`.
