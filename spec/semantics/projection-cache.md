---
date: 2026-05-25
status: draft
---

# Projection cache

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

Projection cache rows are derived state used by holders that do not need to
execute the VM. They make accepted-frame catch-up, descriptor reads, and MCP
session continuity cheap without creating a second authority model.

## PC1. Authority

The accepted frame log remains the ordered authority. Projection rows are
materialized cache rows at a scope head:

- `SerializedObject`
- `SerializedSession`
- `SpaceLogEntry`
- `SpaceSnapshotRecord`
- `ParkedTaskRecord`
- counters
- tombstones
- `ToolSurfaceProjectionRow`

A projection row is fresh only relative to its `ProjectionFreshness`:

```ts
type ProjectionFreshness = {
  scope: ObjRef;
  last_apply_seq: number;
  last_apply_hash: string;
  updated_at_ms: number;
  stale: boolean;
  stale_reason?: "owner_timeout" | "retention_gap" | "cache_miss" | "disabled";
};
```

Projection rows may answer descriptor, routing-hint, and UI/cache reads within
their freshness budget. They must not authorize credentials, permissions, or VM
execution.

## PC2. Row-Body-Complete Updates

An accepted frame may carry `projection_delta` and `projection_writes`.
`projection_delta` names touched rows and byte counts; `projection_writes`
carries the row body for every upsert and an explicit op for every delete.
Receivers that understand the fields apply them directly. Receivers that do not
see row bodies may use legacy transcript apply or checkpoint repair.
`projection_delta.tool_surface_sources` is the exception to row-body
completeness: it carries invalidation markers, not materialized rows. Its ops
have `bytes: 0` and do not require matching `projection_writes` entries.

Normal fanout must not replace row-body-complete updates with unbounded
fetch-by-key. If the row bodies cannot fit the transfer budget, the receiver
uses checkpoint/tail repair.

## PC3. Tool Surfaces

`ToolSurfaceProjectionRow` is keyed by `{scope, object}` and contains the
resolved tool descriptors for that object plus `source_rows`, the projection
rows that contributed to method resolution. A cache invalidates a tool surface
when an accepted projection update changes any source row named by the reverse
index.

Remote tool descriptor refreshes MAY carry descriptor-level `source_rows`.
When present, the gateway must persist the union of those rows on the
`ToolSurfaceProjectionRow`; when absent, it may fall back to the target object
row as a conservative source. The source set is part of behavior, not a debug
hint: inherited verb edits must invalidate surfaces whose descriptors used that
inherited row, while overridden parent verbs should not invalidate a descendant
surface unless another visible descriptor still depends on the parent row.

The initial rollout gates tool-surface persistence separately from the broader
gateway projection cache. If the tool-surface flag is disabled, accepted
object/session projection rows may still be cached, but descriptor rows are not
persisted or served from `gateway_tool_surface`.

The authority scope does not know which gateway shards have cached which tool
surfaces. Tool-surface invalidation is therefore receiver-side: each gateway
expands changed source rows against its local reverse index and evicts only
locally cached surfaces. Authorities SHOULD derive
`projection_delta.tool_surface_sources` from accepted object projection row ops
so a changed ancestor, feature, or class row invalidates descendant tool
surfaces without emitting per-descendant `tool_surfaces` writes.

The reverse index is capped per gateway scope and per gateway shard. The
initial caps are 10,000 source rows per active scope and 40,000 source rows per
gateway shard. When adding a tool surface would exceed either cap, the gateway
stores that surface as stale, marks the scope saturated, and does not add
`gateway_tool_surface_source` rows for it. A saturated scope is not used for
descriptor reads; the read path falls back to a session manifest when the
same-host stale-fallback flag allows it, or refreshes from the owner. The scope
may resume serving cached tool surfaces only after disabled surfaces have been
replaced or deleted and the source-index row counts fit under both caps. This
keeps ancestor or feature-heavy catalogs from turning one active room or shard
into an unbounded invalidation index.

## PC4. Session Manifests

`SessionToolManifest` is the session-visible descriptor boundary for MCP.
After a descriptor has been returned to a session, same-host cache misses and
owner refresh timeouts may make it stale but not absent. Removal requires an
authoritative projection update, active-scope change, or manifest expiry.

Serving a manifest because owner refresh failed is controlled by the same-host
stale-fallback rollout flag. With that flag disabled, a saved manifest may be
recorded for later rollout, but it is not used to answer a failed descriptor
refresh.

This monotonicity applies only to descriptor availability. A later call still
executes through the ordinary authority path and may fail permission or stale
descriptor validation.
