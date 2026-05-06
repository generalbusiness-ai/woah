---
name: perm
version: 0.1.0
spec_version: v1
license: MIT
description: LambdaMOO-shaped permission utilities. Provides $perm:controls and the :is_writable_by / :is_readable_by / :is_executable_by convention.
keywords:
  - perm
  - core
  - convention
---

# perm

Foundational catalog with permission helpers. The substrate already
gives `r/w/c` property flags + owner, `r/x/d` verb flags + owner, and
wizard bypass; everything fine-grained lives in woocode and follows the
convention this catalog standardizes.

## $perm

Singleton helper instance (`the_perm`). Verbs:

| Verb | Returns | Notes |
|---|---|---|
| `:controls(who, what)` | bool | True if `who` is wizard or `who == what.owner`. The universal floor — equivalent to LambdaCore's `$perm_utils:controls`. |
| `:requires_perm(who, what, message?)` | true / raises | Convenience: raises `E_PERM` with `message` if `:controls` is false. |

Use it from a verb body:

```woo
"the_perm":requires_perm(actor, this, "cannot edit this note");
this.text = next_text;
```

## The is_*_by convention

Catalog classes that have mutable state expose three overrideable verbs:

| Verb | Purpose |
|---|---|
| `:is_readable_by(who)` | gate for read verbs |
| `:is_writable_by(who)` | gate for write verbs |
| `:is_executable_by(who)` | gate for verbs that execute on behalf of someone |

The default for each: delegate to `"the_perm":controls(who, this)` (with
`:is_readable_by` defaulting to true unless restricted). Subclasses
override for richer policy — e.g. `$note:is_writable_by` adds a
`writers` list; `$block:is_writable_by_property(who, name)` consults
`writable_owner` / `writable_self` lists and the actor-as-self case
for plug-bound apikey sessions.

This is the LambdaMOO pattern: substrate stays small, policy lives in
woocode, every class can override its own gates.

See [DESIGN.md](DESIGN.md) for the rationale and the relationship to
LambdaCore's `$perm_utils`.
