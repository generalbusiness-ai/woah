# perm — design notes

## Why this exists

woo's substrate already implements LambdaMOO's core permission model:

- Each property has `r/w/c` flags + `owner`.
- Each verb has `r/x/d` flags + `owner`.
- `canBypassPerms(who)` is the wizard check (substrate `has_flag` `wizard`).
- `getPropChecked` / `setPropChecked` enforce per-property `r` / `w`
  flags, with owner and wizard bypass — the LambdaMOO contract verbatim.

What it doesn't ship is the *helper convention* every LambdaCore catalog
relies on: a small `$perm_utils:controls(who, what)` plus the
per-class `:is_*_by(who)` overrides. This catalog supplies that.

## Relationship to LambdaCore

LambdaCore's `$perm_utils` exposes:

- `controls(who, what)` — wizard, owner, or owner's wizard
- `set_perms(what, value)` — perm-checked perm change
- `apply_to_descendants(who, what, verb)` — wizard helper

The first one is what every class needs; the others are wizard-only
maintenance helpers we don't ship yet (no urgency).

LambdaCore convention: every "thing" class with mutable state exposes
`:is_readable_by(who)` / `:is_writable_by(who)` / `:is_executable_by(who)`.
A verb that mutates state begins with one of:

```moo
if (!this:is_writable_by(player)) raise(E_PERM);
```

or

```moo
if (!$perm_utils:controls(caller_perms(), this)) raise(E_PERM);
```

`$mail_recipient`, `$root_class`, and many others use this
exact shape. This catalog formalizes the same convention for woo.

## Why a singleton instance (`the_perm`)

Verbs in woo dispatch on the calling-syntax target. Calling `$perm:foo`
on the *class object* works but feels awkward — the class is the
interface; instances are the addressable object. A singleton instance
matches LambdaMOO's idiom where `$perm_utils` is a corified object you
address by name.

The singleton is created via the standard `create_instance` seed hook
during catalog install; no special bootstrap.

## Helper layering

```
verb body
  → "the_perm":controls(actor, this)      ← shared baseline
  → this:is_writable_by(actor)            ← per-class override
  → this:is_writable_by_property(actor, name) ← per-property (optional)
```

A class that wants ordinary owner+wizard policy implements
`:is_writable_by(who) { return "the_perm":controls(who, this); }`. A
class with richer policy (`$note` adds `writers`; `$block` adds
plug-as-self plus tier lists) overrides to encode that policy.

## What this catalog does NOT include

- `set_perms` / wizard-only metadata helpers — defer until a use case lands.
- `apply_to_descendants` — defer.
- A "role" abstraction — defer; the convention's `:is_*_by` hooks already
  let any class implement role-style checks in woocode without a generic
  framework.

The deliberately small surface keeps this catalog's invariants stable;
later additions can extend without breaking existing callers.
