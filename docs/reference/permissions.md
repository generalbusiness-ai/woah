# Permissions

Port separates **substrate-level** permission flags (the `r/w/c` bits
on properties, the `r/x/d` bits on verbs, owner, wizard) from
**catalog-level** policy (who can write *this particular* note's
text, when does a `$block` accept config changes, etc.).

The substrate stays small. Everything fine-grained lives in woocode
and follows the conventions standardized by the **`perm`** catalog.

## Substrate flags

**Property perms:** `r` readable, `w` writable, `c` change-perms.
Default for owner is `rwc`; default for everyone else is `r` if the
property's perms include `r`. The owner of a property's *definition*
controls these.

**Verb perms:** `r` readable source, `x` executable, `d` (debug —
detailed introspection). Default for owner is `rxd`; non-owners
need explicit `r` to read source, `x` to execute. A verb without
`x` can only be called by the owner or a wizard.

**Object owner:** the actor with administrative authority over an
object. Owner can mutate verbs and properties without further checks.

**Wizard flag:** an actor with this flag bypasses ownership checks
across the world (subject to hard floors — see
[../wizard/recycle.md](../wizard/recycle.md)). Wizardry is the
substrate's bypass.

**Programmer flag:** an actor with this flag can author code on
objects they own (or that allow it). Programmer is *not* a bypass —
ownership and class membership still gate. See
[../designing/builder-and-programmer.md](../designing/builder-and-programmer.md)
for the full story.

## The `$perm` catalog

Foundational singleton helpers ported directly from LambdaCore's
`$perm_utils`. The class is its own singleton (`the_perm`), called
the same way `$match` is.

| Verb | Returns | Purpose |
|---|---|---|
| `:controls(who, what)` | `bool` | True if `who` is wizard or `who == what.owner`. The universal floor. |
| `:requires_perm(who, what, message?)` | `true` or raises `E_PERM` | Convenience wrapper — call to gate a verb body. |

Use it from a verb body:

```
"the_perm":requires_perm(actor, this, "cannot edit this note");
this.text = next_text;
```

Catalogs call this anywhere they want LambdaCore-shaped owner gating.

## The `is_*_by` convention

Catalog classes that have mutable state expose three overrideable
verbs:

| Verb | Purpose |
|---|---|
| `:is_readable_by(who)` | Gate for read-shaped verbs. |
| `:is_writable_by(who)` | Gate for write-shaped verbs. |
| `:is_executable_by(who)` | Gate for verbs that execute on someone else's behalf. |

The default for each delegates to `"the_perm":controls(who, this)`.
`is_readable_by` defaults to `true` unless restricted.

Subclasses override for richer policy:

- `$note:is_writable_by` adds a `writers` list — anyone in the list
  can write the note's text, even if they're not the owner.
- `$block:is_writable_by_property(who, name)` consults
  `writable_owner` and `writable_self` lists, plus the
  actor-as-self case for plug-bound apikey sessions.
- A custom class can override either to express any policy you can
  encode in woocode.

This is the LambdaMOO pattern: the substrate stays general, the
class decides policy. Every verb that needs to gate writes calls
`this:is_writable_by(actor)` rather than checking `actor == this.owner`
inline. That way, override-with-richer-policy is a one-method
change.

## When to use which mechanism

- **Substrate `r/w/c` perms** — the stable contract for what's
  readable / writable from outside woocode (REST property reads,
  describe permissions). Use these for "is this property visible
  at all?"
- **`$perm:controls`** — the LambdaCore-shaped "is this caller in
  charge of this object?" check. Use it inside verbs as the default
  authorization predicate.
- **`is_*_by` overrides** — class-level policy. Use these when a
  class wants its own rules (writer lists, role-gated edits, plug-only
  channels).

The substrate doesn't enforce the `is_*_by` convention; it's a
discipline. Catalog code that *doesn't* call its own gates can
still mutate. The convention works because catalog authors agree to
follow it; the spec doesn't have to police it.

## Authority gates summary

For a non-wizard, non-owner actor calling a verb:

1. **Substrate execute check** — does the verb have `x` perm? If
   not, `E_PERM`.
2. **Verb body checks** — does the verb call `:is_writable_by` or
   `:requires_perm` and pass? If not, the verb raises something.
3. **Substrate property write** (if the verb writes) — does the
   actor have `w` on the property? If not, `E_PERM`.

A wizard bypasses (1) and (3). The verb body's own checks (2) still
run; a verb that explicitly checks `actor != $wizard` will reject
even a wizard, but that's an unusual deliberate pattern.

## Where to read more

- [`../../catalogs/perm/`](../../catalogs/perm/) — the perm catalog
  source.
- [`../../catalogs/perm/DESIGN.md`](../../catalogs/perm/DESIGN.md) —
  rationale and LambdaCore alignment.
- [`../../spec/semantics/permissions.md`](../../spec/semantics/permissions.md)
  — substrate-level perms (§11), wizard, trust, quotas.
- [../designing/builder-and-programmer.md](../designing/builder-and-programmer.md)
  — how the programmer/wizard flags affect the authoring surface.
