# Wizard reference

Operations that require wizard authority — that is, your actor has the
wizard flag set. Check with `;has_flag(actor, "wizard")`; if it returns
`false`, none of these will work for you.

This section is for **privileged** operations only. For ordinary
authoring (creating objects, programming verbs, packaging catalogs),
see [`../designing/`](../designing/). For day-to-day usage of a
running world, see [`../using/`](../using/).

## Pages

- **[recycle.md](recycle.md)** — destroying objects (routine and forced).

## General notes

- Wizard authority is gated on `actor`, not just `progr`. Wrappers that
  forward options must be careful not to launder user intent (for
  example, `force_reserved` is gated on `actor` even when called through
  a wizard-owned wrapper).
- Hard floors: `$system`, `$root`, `$nowhere` cannot be recycled or
  reparented from inside a running world. No flag bypasses this.
- Prefer the catalog wrapper on `$builder` or `$programmer` over the
  raw builtin when one exists — wrappers emit audit observations and
  centralize the permission check.
