# Recycling objects

`recycle()` destroys an object. It is a builtin — call it directly
through `eval`.

## Routine recycle

```
;recycle($the_thing)
```

The substrate gates on RC2 — the caller must be the object's owner or a
wizard. As a wizard, you pass.

## Dry-run first

Always recommended for non-trivial objects:

```
;recycle($the_thing, {dry_run: true})
```

Returns an `impact` map listing children, contents, own verbs, own
properties, and (if `force_reserved` is set) the actor sessions that
would be terminated. Nothing is destroyed.

## Options

All options are passed in the second-arg map. All are optional.

| Option            | Effect                                                                                                                                |
|-------------------|---------------------------------------------------------------------------------------------------------------------------------------|
| `dry_run: true`   | Report `impact` only; do not destroy.                                                                                                 |
| `force: true`     | Recycle anyway when the object still has children or contents (RC3a guard). Without this, those cases throw `E_RECMOVE`.              |
| `force_reserved: true` | Wizard-only. Bypasses the reserved-class list and terminates live actor sessions. The substrate refuses unless `actor` is a wizard. |
| `reason: "..."`   | Audit string carried into the recycle observation.                                                                                    |

## Catalog wrappers

Two woocode wrappers exist on top of the builtin. Prefer them when one
applies — they centralize the permission check and emit audit
observations.

- **`$builder:recycle(id, opts)`** — owner-or-wizard. Strips
  `force_reserved` before forwarding (so a non-wizard can never reach
  RC6.1 authority through this surface). Emits a `builder_recycled`
  observation on success.

- **`$programmer:force_recycle(id, opts)`** — wizard-only (gated on
  `actor`'s wizard flag, not just `progr`). Sets both `force` and
  `force_reserved` in the forwarded options. Use this for irreversible
  teardown of reserved-list classes, anchored objects, or actors with
  live sessions.

## What cannot be recycled

- **Hard floor**: `$system`, `$root`, `$nowhere`. No flag bypasses this.
- **Anchored descendants**: any object with `_anchored: true` somewhere
  in its descendant tree throws `E_NACC`. Resolve by un-anchoring or
  recycling the anchored leaves first.
- **Cross-host**: if the target, its parent, its location, or any child
  or content lives on a remote host, recycle throws
  `E_CROSS_HOST_WRITE`. The operation is not atomic across clusters and
  must be performed on the owning host.

## Errors you will see

| Error                  | Meaning                                                                       |
|------------------------|-------------------------------------------------------------------------------|
| `E_INVARG`             | The hard-floor list, or argument shape (wrong type, wrong arity).             |
| `E_PERM`               | Authority gate failed — most often `force_reserved` requested by non-wizard.  |
| `E_RECMOVE`            | Children or contents present; pass `force: true` to override.                 |
| `E_NACC`               | Anchored descendants block recycle.                                           |
| `E_CROSS_HOST_WRITE`   | Object or its graph crosses a host boundary.                                  |

## Worked examples

Inspect before destroying a populated room:

```
;recycle($old_lobby, {dry_run: true})
```

Recycle a populated container in one step:

```
;recycle($old_lobby, {force: true, reason: "lobby v1 cleanup"})
```

Force-recycle a stuck guest actor (terminates their session):

```
;$programmer:force_recycle($guest_42, {reason: "ghost session"})
```
