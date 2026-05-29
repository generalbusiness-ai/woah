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
- `tombstones: Set<ObjRef>` — the gateway's tombstone set, delivered
  as-is. The gateway's tombstone set contains only ids it
  authoritatively recycled. Recycle is host-local (an attempt to
  recycle a remote-hosted object raises `E_CROSS_HOST_WRITE`), so
  `gateway.tombstones` is gateway-hosted-by-construction — foreign to
  every satellite receiver. The receiver does not require per-id host
  metadata to act on these.

The seed MUST NOT carry sessions, logs, snapshots, parked tasks, or
gateway-global allocation counters. Each is per-host or per-host-spaces
state for which the gateway is not authoritative on the receiver, so
they have no place in the merge channel. Counters in the seed must be
neutral defaults derived from the slice; a counter bump elsewhere in
the cluster MUST NOT force a satellite snapshot.

### HS1.1 Verb authoring metadata

Verbs in the delivered seed have `line_map` stripped to the empty
object `{}`. `line_map` is consumed only by stack-trace formatting in
the runtime and is large enough to dominate the seed payload on
worlds with many compiled verbs (~half of the default-world seed JSON
on local sizing). The per-verb merge comparison (`normalizeVerbForCompare`)
already ignores `line_map`, so the stripped delivery is merge-equivalent
to a populated one. Receivers may recompile `line_map` locally — the
bundled-catalog repair path inside `runHostScopedLocalCatalogLifecycle`
does this for catalog-shipped verbs after the merge — or accept the
soft degradation (stack traces from non-bundled-source verbs lose
line/column info on the satellite, but the receiver can still ask the
gateway for full source via authoring endpoints).

`verb.source` is preserved in the delivered seed.

### HS1.2 Seed digest

`/__internal/host-seed` includes an `x-woo-seed-digest` response header:
a stable SHA-256 over a canonical form of the seed body (per-object
arrays sorted by key, JSON object keys sorted). The wire body is left
in its existing insertion-order layout — the digest's canonical form
is computed separately to stay stable across the gateway's own
hibernation/reload, where re-hydration produces alphabetical SQL
ORDER BY layouts rather than runtime insertion order.

Receivers MAY persist the digest after a successful merge and use it
as a "stored slice is consistent with gateway-at-digest-D" assertion
for future probes. The merge protocol itself does not depend on the
digest; it is metadata for cold-load wire-savings strategies layered
on top.

### HS1.3 KV accelerator encoding

The authoritative `/__internal/host-seed` response carries executable
`verb.bytecode`. Reference-layer KV accelerators MAY store a
bytecode-free encoding of the same seed to reduce serialization and KV
storage cost, but such an encoding is only a cache representation, not
a new seed contract.

A bytecode-free cache entry MUST carry a digest for the full
authoritative seed and per-verb bytecode hashes. A receiver may use the
entry only after restoring every missing bytecode body from a trusted
local reservoir (for example its stored SQL slice or the bundled
catalogs compiled by the same runtime) and verifying the restored
bytecode hash. If any bytecode body is missing or mismatched, the cache
entry is a miss and the receiver MUST fetch the authoritative seed.
Receivers MUST NOT recompile arbitrary seed source synchronously on the
cold-load path as the fallback for a missing bytecode body.

Cache keys MUST be scoped by the bundled-catalog fingerprint and by any
runtime-declared catalog repair epoch that changes how existing bundled
catalog rows are repaired without changing the catalog sources
themselves. Otherwise a newly repaired runtime can cold-load a stale
bytecode-free seed built before the repair and then treat it as
authoritative.

---

## HS2. Per-subject merge

If `S ∈ stored.tombstones`, the merge skips `S` entirely (it has been
authoritatively retired locally; resurrecting it from the seed would
break HS4 idempotency).

Otherwise, for each subject `S` in `seed.objects`, dispatch on
`seed.objectHosts[S]`:

### HS2.1 `S` is receiver-hosted

If `stored.objects[S]` exists: skip — receiver's local writes are
authoritative for every field. Nothing in the seed about `S` may
supersede them.

If `stored.objects[S]` does not exist: take the seed entry as-is
(initialization). Counts as changed. This admits "satellite lost a
hosted object and gateway still has the stub" recoveries; once any
local stored copy exists, subsequent merges leave it alone.

### HS2.2 `S` is foreign-hosted

Merge declarative state from seed into stored:

| Field | Rule |
|---|---|
| `name`, `parent`, `owner`, `anchor`, `location`, `flags`, `propertyDefs`, `verbs`, `eventSchemas` | Take seed if not deeply equal to stored. |
| `properties[name]`, `propertyVersions[name]` | For each `name` in the seed: if `name` is **dynamic** (HS3) AND stored already has the property/version, skip — receiver is authoritative for this divergence. Otherwise (including the dynamic-but-stored-has-no-entry case, which is fresh-host initialization), gate on version: skip when `stored.propertyVersions[name] ≥ seed.propertyVersions[name]`; else, if values differ (or stored has no entry), take seed value and version together. Version travels with value: if `stored < seed` but the values are already equal, do not bump version alone. `setProp` bumps `propertyVersions[name]` on every call regardless of value identity, so a gateway-side rewrite of the same value would otherwise force every satellite to persist a full snapshot every cold-load even though nothing observable had changed. |

Never participate in merge, on any subject:

- `children`, `contents` — derived from each child's `parent` and each
  content's `location` pointer. The receiver MAY rebuild local indexes
  from those pointers, but that is not part of the merge and not a
  `changed` signal.
- `modified` — local clock, not authoritative state. PropertyVersions
  provide actual ordering for property updates.
- `created` — set once at create; immutable.
- `id` — the subject key.

Credential-bearing `$account` objects are additionally redacted before
delivery to satellite hosts: `password_hash`, `password_salt`, and
`oauth_identities` are omitted from the delivered object's `properties`
and `propertyVersions`. Credential verification is gateway-local; a
satellite may need account identity/quota metadata for object graph
consistency, but it must not receive reusable password or OAuth
material through host-seed propagation.

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
| `api_keys` | `$system` | gateway-only auth state. Read by `authApiKey` / `createApiKeyRecord` / `revokeApiKey`, all of which run on the gateway; satellites never authenticate independently. `touchApiKeyLastSeen` rewrites the map on every API-key auth, so propagating it would make every poller's auth call burn a satellite snapshot. First cold-load takes the gateway's view, subsequent cold-loads skip. |
| `_subscribers_scrubbed_v1` | `$space` descendants the receiver hosts a local copy of | per-host one-shot scrub marker (host-side scrub of stale subscribers, gated to fire once per object) |

Adding to this set is a behavior change: it stops the gateway from
correcting receiver drift on that name. The bar is "the receiver's
local value is intentionally divergent and authoritative."

---

## HS4. Tombstones

By the HS1 seed contract, every id in `seed.tombstones` is
foreign-hosted. For each `T`:

- If `T ∈ stored.tombstones`: no change.
- If `stored.objects[T]` does not exist (the receiver never imported a
  stub for `T`): no change. The directory's `inherited_tombstone`
  catalog is the cross-host authority for liveness; the satellite does
  not need a local record of every gateway-side recycle that doesn't
  affect its slice. Without this scoping, every new gateway-side
  recycle would force a write on every satellite — restoring an
  `O(global tombstones)` per-host wake cost that the rest of the merge
  was designed to avoid.
- Else (receiver has a stub for `T`): add `T` to `stored.tombstones`;
  remove `stored.objects[T]`. Counts as changed.

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
current. When the cold-load did fetch a fresh gateway seed, host-scoped
catalog schema repair MUST treat that seed as the authoritative repair
for foreign-hosted catalog support rows and avoid rewriting those rows
locally. Host-owned data migrations still run. Otherwise a schema
repair can add local-only foreign-row fields that the post-lifecycle
re-merge immediately deletes, forcing a full snapshot on every
quiescent wake.

When the receiver has a trusted host-scoped slice and its persisted
`host_seed_digest` matches the current content-addressed KV pointer for
that host, cold-load MAY skip the seed body fetch and both seed merges.
It MUST still run host-owned data migrations, and MUST treat the digest
hit as a fresh gateway seed for host schema repair so foreign-hosted
support rows are not locally rewritten.

Live refresh (wizard-triggered, see
[../reference/cloudflare.md §R9.1](../reference/cloudflare.md#r91-first-request-path))
runs the merge without lifecycle.

Implementations SHOULD log, when `changed` is true, the first ~12
`(subject, field)` pairs that drove the result. The current impl emits
`woo.host_seed_merge_diff`.

Gateway host-seed caches MUST invalidate every cached host seed when a
shared/default-hosted support row changes. Such rows (for example
catalog classes and features) can be present in many satellite seeds, so
invalidating only the gateway's own `world` seed can strand stale class
verbs in cached per-host deliveries.
