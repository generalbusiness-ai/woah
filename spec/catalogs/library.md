---
date: 2026-07-19
status: draft
---

# Library — in-world sharing of buildable classes

> Part of the [woo specification](../../SPEC.md). Layer: **catalogs**
> (class-level design for a bundled catalog; the install contract lives in
> [discovery/catalogs.md](../discovery/catalogs.md)).

Within one world, sharing functionality needs no artifacts, no catalogs, and
no publication machinery: the substrate already has everything except
*discoverability*. A class with `fertile: true` may be subclassed and
instantiated by actors who don't own it; feature attachment is gated by the
feature's own `:can_be_attached_by` policy ([features.md §FT5](../semantics/features.md)).
What's missing is the place where a builder says "I made this, use it" and
another actor finds it. That place is the library.

This is the LambdaMOO sharing model (generics in a public room), done as a
pure-woocode bundled catalog — **zero core changes**, no new builtins, no
new substrate metadata. The design must also survive success: a library with
thousands of entries must not rewrite one growing cell per registration or
fan out cross-scope reads per listing.

## LB1. Classes

`$library < $room`, plus `$library_entry < $thing`. A library is a space
whose registry is its collection of **entry objects**; a world may have one
library or many (per-team, per-topic) — nothing is a singleton.

## LB2. Entries are objects, not rows in one cell

Each registration mints one library-owned `$library_entry` anchored to the
library. The entry holds:

- `ref` — the shared class/feature object (a pointer, never a copy);
- `registered_by`, `registered_at`, `blurb`;
- a **registration-time snapshot** for browse: the referenced object's name,
  parent chain to a recognizable ancestor, verb names with per-verb source
  hashes, and the owner at registration.

One object per registration means adding an entry writes new cells instead
of rewriting a monolithic registry property, and recycling an entry removes
exactly one object. Ordering/membership rides the library's ordered
membership relation (the same generic relation machinery the contents
projection uses — an adapter over authoritative facts, not an
independently-written list property).

## LB3. Registration

`$library:register(obj, blurb, opts)` — direct-callable. Preconditions,
refused with the specific error:

- caller owns `obj` (`E_PERM`);
- for a **class**: `obj` is `fertile: true` (`E_INVARG` — the flag is data
  and checked directly; registering an unsubclassable class is refused, not
  warned);
- for a **feature**: the registrant supplies a declared shareability datum
  in `opts` (e.g. `attachable_by: "anyone" | "policy"`) recorded on the
  entry. The library does **not** attempt to prove anything about the
  feature's `:can_be_attached_by` verb — that is arbitrary code and cannot
  be classified statically. The policy verb is simply *evaluated*, as
  `can_be_attached_by(actor)`, at examine/attach time (§LB5);
- not already registered here (`E_INVARG`).

Registration emits `library_registered` (schema declared in the manifest) to
the library space. `unregister(entry)` is registrant-or-wizard and recycles
the entry object.

## LB4. Browsing is paginated and snapshot-backed

- `$library:catalog(cursor, limit)` — pages over the membership relation in
  registration order, rendering **from entry snapshots only**: no
  cross-scope reads, no unbounded result. Returns `{entries, next_cursor}`.
- `$library:examine(entry)` — live introspection of **one** referenced
  object (the [introspection.md](../semantics/introspection.md) `:describe()`
  surface): current verbs and doc-strings, property definitions, current
  owner — plus the trust comparison of §LB5.

Both are direct-callable and tool-exposed so MCP agents can browse. Ordinary
`look` in the library room renders the first `catalog` page.

## LB5. Trust: entries are live mutable code

A library entry is **not** a pinned artifact. The builder retains ownership
and can change any inherited verb *after* consumers subclass; every
subclass's behavior changes with it. This is the substrate's normal
authority model (shared verbs run with the builder's `progr` — the same
analysis as [catalogs.md §CT13.2–13.3](../discovery/catalogs.md#ct132-progr-for-imported-verbs)),
but the library must make it visible rather than let a listing imply
catalog-like stability. `examine` therefore exposes:

- the referenced object's **current owner** and each verb's owner;
- current per-verb source hashes **diffed against the registration
  snapshot** — "changed since registration" is a first-class display, not
  something the reader infers;
- an explicit **live mutable dependency** marker in both `catalog` and
  `examine` output;
- for features, the evaluated `can_be_attached_by(current_actor)` result
  ("you could attach this now"), alongside the registrant's declared
  shareability;
- the documented escape hatch for consumers who want stability: subclass
  and override locally, or take a pinned snapshot via
  [discovery/export.md](../discovery/export.md) and reinstall as a real
  catalog. The library links to both paths rather than pretending immunity.

Consumption itself is the substrate's normal path — subclass via
`$builder:create(entry.ref, …)`, attach per FT5 policy. The library grants
no authority and performs no creation.

## LB6. Dangling entries

A recycled class leaves a dangling `ref` per
[recycle.md §RC5](../semantics/recycle.md). Browse verbs must distinguish
"threw" from "returned false" when probing a ref (the `contents()`-drift
lesson generalizes) and render dangling entries as tombstones — the
snapshot still displays, marked dead. Any wizard or the registrant may sweep
tombstones; registration does not encumber the builder's right to recycle.

## LB7. Relation to export

Library entries are the natural **export roots**
([discovery/export.md](../discovery/export.md)): "publish beyond this
world" is an export whose set starts from `entry.ref`, and the entry
snapshot's source hashes give the consumer a way to check *what* they
exported against what they examined. The library itself is world-local and
is never exported.

## LB8. Deferred

- Ratings/endorsements, usage counts (needs a projection story; keep out of
  v1 rather than hand-maintaining counters).
- Cross-library search / a world-global index (Big-World discipline: no
  global enumeration; a directory-of-libraries entry pattern instead).
- Automatic registration prompts from the `prog` surface.
- Notifying consumers on "changed since registration" transitions.
