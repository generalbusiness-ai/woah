---
date: 2026-05-09
status: draft
---

# Host seeds and seed merge

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**.

In a multi-host deployment, satellite-side drift from gateway state is
reconciled through a **host seed** the gateway exports for each
satellite. Single-process mode (in-memory or local SQLite) does not use
host seeds.

Reference-layer transport (RPC routes, signing) is in
[../reference/cloudflare.md §R9](../reference/cloudflare.md#r9-bootstrap-on-cloudflare).

---

## HS1. Inputs and seed shape

The merge is a pure function `(stored, seed, receiverHost) → (stored', changed)`.

A **seed** is a `SerializedWorld` slice plus:

- `objectHosts: Record<ObjRef, HostKey>` — the authoritative host for
  every subject in the seed, sourced from the gateway's directory in a
  single batched view at export time (not by per-id RPC). The merge
  reads this to dispatch HS2.1 vs HS2.2; it is the only routing input
  the merge needs.
- `tombstones: Set<ObjRef>` — gateway-side recycles, scoped to
  foreign-hosted ids reachable from the seed's subjects (the only
  tombstones the receiver may need to act on). Receiver-hosted
  recycles do not appear; the gateway's full global tombstone history
  does not appear.

The seed MUST NOT carry sessions, logs, snapshots, parked tasks, or
gateway-global allocation counters. Each is per-host or per-host-spaces
state for which the gateway is not authoritative on the receiver, so
they have no place in the merge channel. Counters in the seed must be
neutral defaults derived from the slice; a counter bump elsewhere in
the cluster MUST NOT force a satellite snapshot.

---

## HS2. Per-subject merge

For each subject `S` in `seed.objects`, dispatch on `seed.objectHosts[S]`:

### HS2.1 `S` is receiver-hosted

Skip the subject entirely. Receiver's stored copy is authoritative;
nothing in the seed about `S` can supersede the receiver's local
writes.

### HS2.2 `S` is foreign-hosted

Merge declarative state from seed into stored:

| Field | Rule |
|---|---|
| `name`, `parent`, `owner`, `anchor`, `location`, `flags`, `propertyDefs`, `verbs`, `eventSchemas` | Take seed if not deeply equal to stored. |
| `properties[name]`, `propertyVersions[name]` | For each `name` in the seed: if `name` is **dynamic** (HS3) AND stored already has the property/version, skip — receiver is authoritative for this divergence. Otherwise (including the dynamic-but-stored-has-no-entry case, which is fresh-host initialization), gate on version: skip when `stored.propertyVersions[name] ≥ seed.propertyVersions[name]`; else take seed value and version. |

Never participate in merge, on any subject:

- `children`, `contents` — derived from each child's `parent` and each
  content's `location` pointer. The receiver MAY rebuild local indexes
  from those pointers, but that is not part of the merge and not a
  `changed` signal.
- `modified` — local clock, not authoritative state. PropertyVersions
  provide actual ordering for property updates.
- `created` — set once at create; immutable.
- `id` — the subject key.

**Deletions.** The seed's per-object property loop only adds and
updates. To propagate gateway-side deletes/renames, after applying the
table above, for each foreign-hosted `S`:

- For each `name` in `stored.properties[S]` not present in
  `seed.properties[S]`: delete from stored unless `name` is dynamic
  (dynamic names are receiver-authoritative). Counts as changed.
- Same rule for `stored.propertyVersions[S]` and `stored.propertyDefs[S]`.

`verbs` and `eventSchemas` are deletion-safe through the deep-equal
rule above (a removed entry breaks equality).

---

## HS3. Dynamic property names

Names where the receiver maintains its own authoritative value on its
local copy of a foreign-hosted object. The carve-out in HS2.2 is
asymmetric: when stored has its own entry the seed's value is ignored;
when stored has no entry the seed initializes it. This is how a fresh
receiver acquires its initial migration ledger and `installed_catalogs`
without subsequent merges stomping receiver-side ledger writes.

| Name | Carrier | Pattern |
|---|---|---|
| `next_seq`, `subscribers`, `operators`, `focus_list`, `last_snapshot_seq` | `$space` instances / actors | per-host live state |
| `bootstrap_token_used`, `wizard_actions`, `applied_migrations`, `catalog_migration_records`, `installed_catalogs` | `$system` | per-host ledger |

Adding to this set is a behavior change: it stops the gateway from
correcting receiver drift on that name. The bar is "the receiver's
local value is intentionally divergent and authoritative."

---

## HS4. Tombstones

By the HS1 seed contract, every id in `seed.tombstones` is
foreign-hosted. For each `T`:

- If `T ∈ stored.tombstones`: no change.
- Else: add `T` to `stored.tombstones`; if `stored.objects[T]` exists
  (the receiver had a stub), remove it. Counts as changed.

The receiver's own tombstones are NEVER removed by the merge.

---

## HS5. Persistence, idempotency, lifecycle

`changed` is true iff HS2.2, HS2.2 deletions, or HS4 took a value that
differed from stored. The receiver MUST persist when `changed`; MUST
NOT persist otherwise.

**Idempotency.** Two consecutive cold-loads of a quiescent cluster MUST
produce zero satellite-side repository writes after the first.
Implementations MUST cover this with a regression test: it is the one
observable proof that the spec's invariant survived implementation.

Cold-load runs the merge, then `runHostScopedLocalCatalogLifecycle`
(which may further mutate receiver-hosted instance data), then
re-merges with the same seed. HS2.1's skip preserves the lifecycle's
receiver-hosted writes; HS2.2 keeps gateway-authoritative state
current.

Live refresh (wizard-triggered, see
[../reference/cloudflare.md §R9.1](../reference/cloudflare.md#r91-first-request-path))
runs the merge without lifecycle.

Implementations SHOULD log, when `changed` is true, the first ~12
`(subject, field)` pairs that drove the result. The current impl emits
`woo.host_seed_merge_diff`.
