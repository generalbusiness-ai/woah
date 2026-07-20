---
date: 2026-05-02
status: partial
---

# Persistence and caching

> Part of the [woo specification](../../SPEC.md). Layer: **reference**. CF-specific schema and cache implementation.

Covers per-DO SQLite schema, the cross-host bytecode/property cache, and invalidation. Task serialization details are in [../semantics/tasks.md §16](../semantics/tasks.md).

---

## 14. Persistence

Each Durable Object owns a SQLite database with the schema below. A DO holds the state of one or more woo objects: a single autonomous object (the default), or an entire anchor cluster (a root anchor object plus its anchored descendants — see [../semantics/objects.md §4.1](../semantics/objects.md#41-anchor-and-atomicity-scope)).

Per-object tables (`property_def`, `property_value`, `verb`, `child`, `content`, `event_schema`, `ancestor_chain`) carry an `object_id` column scoping each row to one of the hosted objects. Per-host caches (`ancestor_verb_cache`, `ancestor_prop_cache`) are keyed by the *defining* object — multiple hosted objects sharing the same ancestor share one cache entry. Per-host coordination tables (sessions, sockets) are not scoped to a hosted object.

> **This schema is the CF backend's storage encoding**, not a contract on runtime types. The runtime works with the TS types in [`src/core/types.ts`](../../src/core/types.ts) and accesses storage through the [`ObjectRepository`](../../src/core/repository.ts) interface ([cloudflare.md §R3](cloudflare.md#r3-per-object-repository-interface)). Other backends (in-memory, local SQLite, JSON-folder) are free to encode differently as long as they satisfy the interface. Where this schema's encoding differs from the runtime types, the encoding is "how the CF SQLite stores it"; the runtime never sees the raw SQL shape.

Local development SQLite (`LocalSQLiteRepository`) stamps databases with
`PRAGMA user_version = 1`. Version `0` predates local SQLite schema versioning,
so a non-empty local SQLite file at version `0` is treated as too old and is
recreated from the current schema on startup. Future `user_version` bumps must
choose explicitly between a real local migration and another reset.

### 14.1 Per-`MooObject` schema

```sql
-- Identity & metadata. One row per object hosted on this DO.
-- (Multiple rows when this DO hosts an anchor cluster.)
CREATE TABLE object (
  id          TEXT PRIMARY KEY,    -- ULID
  name        TEXT NOT NULL,
  parent      TEXT,                -- ULID or NULL for root
  owner       TEXT NOT NULL,
  location    TEXT,                -- ULID or NULL
  anchor      TEXT,                -- ULID of anchor; NULL = no anchor cluster. Atomicity scope, not host placement (objects.md §4.1, §4.2). Immutable.
  flags       TEXT NOT NULL,       -- JSON {wizard?, programmer?, fertile?}
  created     INTEGER NOT NULL,
  modified    INTEGER NOT NULL
);

-- Properties defined on a hosted object (introduce a slot).
CREATE TABLE property_def (
  object_id   TEXT NOT NULL,       -- the hosted object this row belongs to
  name        TEXT NOT NULL,
  default_val TEXT NOT NULL,       -- JSON-encoded woo Value
  type_hint   TEXT,                -- nullable; for tooling
  owner       TEXT NOT NULL,
  perms       TEXT NOT NULL,       -- string flags, e.g. "rw", "rwc"
  version     INTEGER NOT NULL DEFAULT 1,
  metadata    TEXT NOT NULL DEFAULT '{}', -- JSON property metadata
  PRIMARY KEY (object_id, name)
);

-- Property values stored on a hosted object (overrides the default).
CREATE TABLE property_value (
  object_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  value       TEXT NOT NULL,       -- JSON-encoded woo Value
  owner       TEXT,                -- override; NULL = inherit defining-prop's owner
  perms       TEXT,                -- override; NULL = inherit
  PRIMARY KEY (object_id, name)
);

-- Verbs defined on a hosted object. Bytecode + literals + locals + stack travel
-- together as the JSON-encoded TinyBytecode shape (src/core/types.ts:62);
-- splitting them across columns saves nothing and complicates round-tripping.
CREATE TABLE verb (
  object_id    TEXT NOT NULL,
  slot         INTEGER NOT NULL,   -- 1-based local verb position
  name         TEXT NOT NULL,
  aliases      TEXT NOT NULL,      -- JSON list
  owner        TEXT NOT NULL,
  perms        TEXT NOT NULL,      -- normalized string flags, e.g. "rx"; direct-callable lives in flags
  arg_spec     TEXT NOT NULL,      -- JSON map of named args (per arg_spec convention)
  source       TEXT NOT NULL,      -- raw DSL source
  source_hash  TEXT NOT NULL,
  kind         TEXT NOT NULL,      -- "bytecode" | "native"
  bytecode     TEXT,               -- JSON TinyBytecode; NULL when kind="native"
  native       TEXT,               -- handler key for native verbs; NULL otherwise
  line_map     TEXT NOT NULL,      -- JSON
  flags        TEXT NOT NULL,      -- JSON {direct_callable?, skip_presence_check?, tool_exposed?, reads_room_presence?}
  version      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (object_id, slot)
);

CREATE INDEX verb_object_name ON verb(object_id, name);

-- Inheritance children: objects whose parent is one of the hosted objects.
CREATE TABLE child (
  object_id   TEXT NOT NULL,       -- the hosted parent object
  child_ref   TEXT NOT NULL,       -- objref of child (may be on this DO or remote)
  PRIMARY KEY (object_id, child_ref)
);

-- Containment contents: objects whose location is one of the hosted objects.
CREATE TABLE content (
  object_id   TEXT NOT NULL,       -- the hosted container object
  content_ref TEXT NOT NULL,       -- objref of contained object
  PRIMARY KEY (object_id, content_ref)
);

-- Event schemas declared on a hosted object.
CREATE TABLE event_schema (
  object_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  schema      TEXT NOT NULL,       -- JSON-Schema-ish
  PRIMARY KEY (object_id, type)
);

-- Cache: verb bytecode fetched from ancestors.
CREATE TABLE ancestor_verb_cache (
  ancestor    TEXT NOT NULL,
  verb_name   TEXT NOT NULL,
  version     INTEGER NOT NULL,
  bytecode    TEXT NOT NULL,       -- JSON TinyBytecode
  owner       TEXT NOT NULL,       -- verb's progr at compile
  perms       TEXT NOT NULL,       -- string flags
  PRIMARY KEY (ancestor, verb_name)
);

-- Cache: property defaults from ancestors.
CREATE TABLE ancestor_prop_cache (
  ancestor    TEXT NOT NULL,
  prop_name   TEXT NOT NULL,
  version     INTEGER NOT NULL,
  default_val TEXT NOT NULL,
  owner       TEXT NOT NULL,
  perms       TEXT NOT NULL,       -- string flags
  PRIMARY KEY (ancestor, prop_name)
);

-- Cache: parent chain per hosted object (for lookup acceleration).
-- Each hosted object has its own chain; rows ordered by `position` per `object_id`.
CREATE TABLE ancestor_chain (
  object_id   TEXT NOT NULL,
  position    INTEGER NOT NULL,    -- 0 = self, 1 = parent, 2 = grandparent, ...
  ancestor    TEXT NOT NULL,
  PRIMARY KEY (object_id, position)
);

-- In-flight VM tasks (activation stacks) parked on this DO.
-- A task is "parked on" a specific hosted object for quota accounting.
CREATE TABLE task (
  id              TEXT PRIMARY KEY,
  parked_on       TEXT NOT NULL,           -- the hosted object the task counts against
  state           TEXT NOT NULL,           -- 'suspended' | 'awaiting_read'
  resume_at       INTEGER,                 -- ms timestamp
  awaiting_player TEXT,                    -- objref
  correlation_id  TEXT,                    -- reserved for future durable RPC parking
  serialized      BLOB NOT NULL,           -- whole Task object, JSON-encoded for now
  created         INTEGER NOT NULL,
  origin          TEXT NOT NULL            -- objref where task started (may differ from parked_on)
);

CREATE INDEX task_parked_on ON task(parked_on);

CREATE INDEX task_resume_at ON task(resume_at) WHERE state = 'suspended';

-- Sequenced messages accepted by a hosted $space.
-- A DO may host more than one $space (anchored cluster); rows are scoped per space.
-- Two-step write per cloudflare.md §R3.2: appendLog inserts with applied_ok=NULL;
-- recordLogOutcome updates applied_ok and error after the behavior savepoint.
-- Both happen in one outer transaction, so committed rows should never retain
-- applied_ok=NULL; a null committed row is storage corruption or migration debt.
-- v2 write-through may also call saveCommittedLogEntry for an already accepted
-- transcript; that path upserts the final row by (space_id, seq) and does not
-- allocate a new seq or mutate next_seq.
-- See semantics/space.md.
CREATE TABLE space_message (
  space_id    TEXT NOT NULL,
  seq         INTEGER NOT NULL,            -- assigned by $space:call
  ts          INTEGER NOT NULL,            -- ms epoch when sequenced
  actor       TEXT NOT NULL,               -- objref
  message     TEXT NOT NULL,               -- canonical V2-encoded message map
  observations TEXT NOT NULL DEFAULT '[]', -- canonical V2-encoded applied observations
  applied_ok  INTEGER,                     -- 1 = success; 0 = rolled back; NULL = in-flight
  error       TEXT,                        -- canonical V2-encoded err if applied_ok = 0
  PRIMARY KEY (space_id, seq)
);

CREATE INDEX space_message_ts ON space_message(space_id, ts);

-- Optional: snapshots of materialized $space state. Snapshot policy is
-- application-level; the table just holds the records.
CREATE TABLE space_snapshot (
  space_id    TEXT NOT NULL,
  seq         INTEGER NOT NULL,            -- the seq this snapshot represents
  ts          INTEGER NOT NULL,
  state       TEXT NOT NULL,               -- canonical V2-encoded materialized state
  hash        TEXT NOT NULL,               -- sha256 of replay-canonical bytes
  PRIMARY KEY (space_id, seq)
);

-- Session state for reconnect credentials (player objects only).
-- Credential metadata only — connection state is in-memory, not persisted, per
-- semantics/identity.md §I2.
CREATE TABLE session (
  id             TEXT PRIMARY KEY,         -- session_id (unguessable random, at least 128 bits)
  actor          TEXT NOT NULL,            -- objref of bound actor
    started        INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    last_detach_at INTEGER,                  -- null while attached
    token_class    TEXT NOT NULL,            -- "guest" | "bearer" | "apikey"
    current_location TEXT                    -- legacy column storing session active_scope
  );

-- Live websocket ids are not persisted. The in-memory connection registry is
-- rebuilt from current connections; persisting socket ids creates orphaned
-- attachments after restart.
```

### 14.2 Singleton DOs and Directory schema

| DO | Purpose |
|---|---|
| `Directory` | Holds the corename map and world metadata. Read-mostly, off the hot path. Does **not** mint IDs (see [../semantics/objects.md §5.5](../semantics/objects.md#55-id-allocation)). |
| `$system` (`#0`) | Bootstrap object. Holds corename properties. |

Directory's SQLite schema:

```sql
-- Corename map: $foo → ULID. Recycle removes the row.
CREATE TABLE corename (
  name   TEXT PRIMARY KEY,            -- e.g. "$wiz"
  target TEXT NOT NULL                -- ULID
);

-- ID → host route. Written once at object creation; never updated, never
-- deleted. Recycle does NOT remove the row: stale refs continue to route
-- to the host that holds the (now-tombstoned) object, so the host can
-- distinguish 'recycled' from 'never existed' for is_recycled() and for
-- authoring-tool diagnostics. See §14.2.1.
CREATE TABLE id_route (
  id   TEXT PRIMARY KEY,              -- ULID
  host TEXT NOT NULL                  -- DO name / host id (§R1.1)
);

-- World metadata.
CREATE TABLE world_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### 14.2.1 Tombstones

ULID liveness is tracked **per anchor cluster**, not in the central Directory.
Each cluster's host owns a `tombstone` table:

```sql
-- Recycled ULIDs. Survive backup/restore.
CREATE TABLE tombstone (
  id          TEXT PRIMARY KEY,    -- the recycled ULID
  recycled_at INTEGER NOT NULL,    -- ms since epoch
  reason      TEXT                 -- 'recycle' | 'force_recycle'; nullable for legacy entries
);
```

Lookup contract (the full path for a stale ULID dereference):

1. The caller resolves the ULID via Directory's `id_route` table. The route row
   is **immutable** — recycle does not remove it — so the route still resolves,
   pointing at the tombstone host.
2. The host receives the dispatch / property request and consults its own
   `tombstone` table. A hit returns "tombstoned"; the host responds with
   `E_OBJNF` per
   [../semantics/failures.md §F7](../semantics/failures.md#f7-lifecycle-failures).
3. A miss falls through to the ordinary `objects` table lookup.

Two storage invariants make this work:

- **Route immutability.** The `id_route` row is written once at object creation
  and never updated or deleted. Recycle leaves it in place. This guarantees
  that stale refs reach the tombstone host instead of failing with a
  routing-layer not-found.
- **Tombstone immutability.** A `tombstone` row is immutable once written.
  Tombstones are never deleted in normal operation; an offline tool may sweep
  entries past a configurable retention horizon, but doing so risks ULID
  collision on backup/restore and is therefore disabled by default.

The Directory does **not** mirror tombstones for live hosts: routing only
cares which host owns the ULID, and that host is the only authority on
liveness while it is alive. One bounded exception applies once the host
has been torn down — see §14.2.2.

The recycle transaction inserts the tombstone row in the same SQLite
transaction that deletes the object's storage rows
([../semantics/recycle.md §RC3](../semantics/recycle.md#rc3-bookkeeping) step 9).
Either both happen or neither does.

### 14.2.2 Inherited tombstones (after host teardown)

When a recycle leaves a DO with no live hosted **payload** objects
(host-scoped support copies excluded — see [../semantics/recycle.md §RC11.1](../semantics/recycle.md#rc111-trigger)),
the DO migrates its tombstone roster to the Directory in one or more
batched requests and then calls `state.storage.deleteAll()`, which
deallocates its stored data. The DO id remains reachable; reactivations
hit the §RC11.6 cold-load guard. See
[../semantics/recycle.md §RC11](../semantics/recycle.md#rc11-host-teardown-after-recycle)
for the full sequence. After the handoff completes, the Directory holds
the tombstone authority for those ULIDs:

```sql
-- Tombstones inherited from torn-down hosts. Append-only.
CREATE TABLE inherited_tombstone (
  id          TEXT PRIMARY KEY,    -- the recycled ULID
  former_host TEXT NOT NULL,       -- ULID of the self-hosted root whose DO is gone
  recycled_at INTEGER NOT NULL,    -- ms since epoch (preserved from the host's tombstone row)
  reason      TEXT                 -- 'recycle' | 'force_recycle'; preserved from host's tombstone
);
```

The host populates this table by POSTing to the Directory's
`/__internal/inherit-tombstones` endpoint (recycle.md §RC11.3 step 2), in
the same teardown sequence that ends with `state.storage.deleteAll()`.

Lookup contract — extended for inherited tombstones. The §14.2.1 path
gains a Directory-local branch when the route is gone:

1. Caller resolves the ULID via Directory's `id_route` table.
2. **(new)** If no `id_route` row exists, the Directory checks
   `inherited_tombstone`:
    - Hit → respond `E_OBJNF` ([../semantics/failures.md §F7](../semantics/failures.md#f7-lifecycle-failures))
      with `is_recycled() = true`. No DO is woken.
    - Miss → respond "never existed" with `is_recycled() = false`.
3. Otherwise dispatch to the host (the §14.2.1 path).

This is the *only* path that removes a row from `id_route`, and it does so
only for ULIDs whose tombstone has been promoted to the Directory in the
same operation. Route immutability (§14.2.1) is preserved for live hosts.

The Directory does not vacuum `inherited_tombstone` in normal operation;
the table grows monotonically. An offline tool may sweep entries past a
configurable horizon with the same backup/restore caveat as §14.2.1.

### 14.3 Atomicity

All writes within a single opcode are atomic (CF DOs give us SQLite transactions). A verb body is *not* atomic across yield points; cross-DO ops give other tasks a chance to interleave on each DO. Authors who need atomicity across multiple ops use `with_lock(obj) { ... }` (deferred to phase 2; simply documented for v1).

### 14.4 Scope-authority commit schema

> **Owner class (2026-07 net-only cutover).** This commit-authority schema is
> owned by `NetScopeDO` in the deployed Net stack; the historical
> `CommitScopeDO` class it was written for was removed with the classic/v2
> stack. The row shapes are unchanged — the Net commit path reuses the same
> effect-transcript / authority-slice / projection-delta machinery — so the
> schema below is current; only the owning DO class was renamed/retired.

The scope-authority DO owns v2 commit authority state, not ordinary hosted object
storage, so it does not implement the `ObjectRepository` interface. Its
Cloudflare encoding still follows the same row-shaped rule: state that grows
with world size is split into rows, and accepted commits rewrite only rows
touched by the transcript.

```sql
CREATE TABLE v2_commit_scope_meta (
  id                     TEXT PRIMARY KEY, -- always 'current'
  scope                  TEXT NOT NULL,
  relay_node             TEXT NOT NULL,
  serialized             TEXT,             -- legacy single-blob migration source only
  head                   TEXT NOT NULL,    -- JSON ShadowScopeHead
  idempotency_window_ms  INTEGER NOT NULL,
  version                INTEGER NOT NULL DEFAULT 1,
  object_counter         INTEGER NOT NULL DEFAULT 1,
  parked_task_counter    INTEGER NOT NULL DEFAULT 1,
  session_counter        INTEGER NOT NULL DEFAULT 1,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE v2_commit_scope_object (
  id          TEXT PRIMARY KEY,
  body        TEXT NOT NULL, -- JSON SerializedObject
  updated_at  INTEGER NOT NULL
);

CREATE TABLE v2_commit_scope_session (
  id          TEXT PRIMARY KEY,
  body        TEXT NOT NULL, -- JSON SerializedSession
  updated_at  INTEGER NOT NULL
);

CREATE TABLE v2_commit_scope_log (
  space       TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  body        TEXT NOT NULL, -- JSON SpaceLogEntry
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (space, seq)
);

CREATE TABLE v2_commit_scope_snapshot (
  space       TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  body        TEXT NOT NULL, -- JSON SpaceSnapshotRecord
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (space, seq)
);

CREATE TABLE v2_commit_scope_task (
  id          TEXT PRIMARY KEY,
  body        TEXT NOT NULL, -- JSON ParkedTaskRecord
  updated_at  INTEGER NOT NULL
);

CREATE TABLE v2_commit_scope_tombstone (
  id          TEXT PRIMARY KEY,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE v2_commit_scope_accepted_frame (
  scope         TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  id            TEXT NOT NULL,
  position_hash TEXT NOT NULL,
  body          TEXT NOT NULL, -- JSON ShadowCommitAccepted, including projection_writes when available
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY(scope, seq)
);

CREATE TABLE v2_commit_scope_transcript_tail (
  scope      TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  hash       TEXT NOT NULL PRIMARY KEY,
  body       TEXT NOT NULL, -- JSON EffectTranscript
  updated_at INTEGER NOT NULL
);

CREATE TABLE v2_commit_scope_seen (
  idempotency_key TEXT PRIMARY KEY,
  seen_at         INTEGER NOT NULL
);

CREATE TABLE v2_commit_scope_reply (
  idempotency_key TEXT PRIMARY KEY,
  body            TEXT NOT NULL, -- JSON reply envelope
  updated_at      INTEGER NOT NULL
);

CREATE TABLE v2_commit_scope_checkpoint (
  scope           TEXT PRIMARY KEY,
  head_seq        INTEGER NOT NULL,
  head_hash       TEXT NOT NULL,
  head            TEXT NOT NULL, -- JSON ShadowScopeHead
  checkpoint_hash TEXT NOT NULL,
  body            TEXT NOT NULL, -- JSON ScopeCheckpointManifest
  updated_at      INTEGER NOT NULL
);

CREATE TABLE v2_commit_scope_checkpoint_page (
  scope           TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  page_index      INTEGER NOT NULL,
  table_name      TEXT NOT NULL,
  page            TEXT NOT NULL,
  page_hash       TEXT NOT NULL,
  body            TEXT NOT NULL, -- JSON ProjectionPage
  bytes           INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY(scope, checkpoint_hash, page_index)
);

CREATE TABLE v2_commit_scope_checkpoint_frame (
  scope           TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  position_hash   TEXT NOT NULL,
  body            TEXT NOT NULL, -- JSON ShadowCommitAccepted without projection_writes
  bytes           INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY(scope, checkpoint_hash, seq)
);
```

The `serialized` column remains nullable/empty so old scopes whose current row
contains a gzip or raw JSON world can be loaded once. New cold opens SHOULD
materialize row state from `woo.authority_slice.cells.shadow.v1` page values
rather than from a whole-world request snapshot. After the first successful
legacy open, implementations SHOULD rewrite the scope into the row tables and
clear `serialized`; new commits MUST NOT store the full world in that column.

Accepted-frame and transcript tails are append/prune surfaces. `saveFull` or
checkpoint construction MUST NOT rewrite retained tail rows. A new accepted
frame is inserted by `(scope, seq)` and a transcript-tail row is inserted by
transcript hash; pruning deletes only rows outside the configured retention
horizon after a complete checkpoint covers the prefix being pruned. The complete
checkpoint head is the hard correctness floor: rows newer than that head MUST
remain even when row-count, byte, or age budgets are exceeded. Rows at or below
that floor MAY be pruned by deployment-specific row-count, byte, and age
budgets. The Cloudflare reference exposes the per-table byte budget as
`WOO_V2_TAIL_RETENTION_BYTES`; this bounds replay history carried in hot
CommitScopeDO envelopes without changing commit validation.

Checkpoint rows are maintained outside `/v2/open` packaging. If no complete
manifest for the current head exists, checkpoint/tail open schedules
maintenance and returns `E_CHECKPOINT_PENDING`; it does not scan the
object/session/log tables to build a checkpoint inside the open request. The
persisted manifest is small and contains page/frame references only; each
`ProjectionPage` and retained frame tail entry is stored in its own row keyed by
`(scope, checkpoint_hash, page_index)` or `(scope, checkpoint_hash, seq)`.
`/v2/open` packages byte-bounded page chunks from those retained rows and
returns an `OpenContinuation` pinned to the checkpoint hash/head/export id until
all pages have been sent. A single projection row larger than the page target is
emitted as its own page; rows approaching the SQL value limit are
non-conforming and must be split before storage.

`ShadowCommitAccepted.body` SHOULD include `projection_delta` and
row-body-complete `projection_writes` for every touched projection upsert or
delete. A retained frame without row bodies may remain for legacy compatibility,
but checkpoint/tail open MUST NOT use it as a normal tail catch-up frame. Frame
transfers carry those row bodies in `AcceptedFrameTransfer.projection_writes`;
the nested accepted frame SHOULD omit the duplicate `projection_writes` field so
the transfer does not pay for the same rows twice.
`projection_delta.tool_surface_sources` is not a persisted row body surface: it
contains `bytes: 0` invalidation markers for source rows that can stale cached
tool surfaces, and those markers need not appear in `projection_writes`.

### 14.5 Gateway projection cache schema

Gateway shards use their DO SQLite database as a durable projection cache
(the `NetGatewayDO` database in the deployed Net stack; historically the MCP
gateway shard's `PersistentObjectDO` database before the net-only cutover).
These rows are cache state, not execution authority. They survive hibernation
so descriptor reads and accepted fanout do not require rebuilding an executable
`WooWorld` mirror before serving a session.

```sql
CREATE TABLE gateway_projection_scope (
  scope          TEXT PRIMARY KEY,
  head_seq       INTEGER NOT NULL,
  head_hash      TEXT NOT NULL,
  updated_at_ms  INTEGER NOT NULL,
  stale          INTEGER NOT NULL DEFAULT 0,
  stale_reason   TEXT
);

CREATE TABLE gateway_projection_object (
  id              TEXT NOT NULL,
  authority_scope TEXT NOT NULL,
  body            TEXT NOT NULL, -- JSON SerializedObject
  last_apply_seq  INTEGER NOT NULL,
  last_apply_hash TEXT NOT NULL,
  updated_at_ms   INTEGER NOT NULL,
  stale           INTEGER NOT NULL DEFAULT 0,
  stale_reason    TEXT,
  PRIMARY KEY(authority_scope, id)
);

CREATE TABLE gateway_scope_member (
  scope          TEXT NOT NULL,
  id             TEXT NOT NULL,
  authority_scope TEXT NOT NULL,
  role           TEXT NOT NULL,
  last_apply_seq INTEGER NOT NULL,
  updated_at_ms  INTEGER NOT NULL,
  PRIMARY KEY(scope, id, role)
);

CREATE TABLE gateway_projection_session (
  session_id      TEXT PRIMARY KEY,
  scope           TEXT,
  actor           TEXT NOT NULL,
  body            TEXT NOT NULL, -- JSON SerializedSession
  last_apply_seq  INTEGER NOT NULL,
  last_apply_hash TEXT NOT NULL,
  updated_at_ms   INTEGER NOT NULL,
  stale           INTEGER NOT NULL DEFAULT 0,
  stale_reason    TEXT
);

CREATE TABLE gateway_tool_surface (
  scope                  TEXT NOT NULL,
  object                 TEXT NOT NULL,
  object_authority_scope TEXT NOT NULL,
  body                   TEXT NOT NULL, -- JSON ToolSurfaceProjectionRow
  last_apply_seq         INTEGER NOT NULL,
  last_apply_hash        TEXT NOT NULL,
  updated_at_ms          INTEGER NOT NULL,
  stale                  INTEGER NOT NULL DEFAULT 0,
  stale_reason           TEXT,
  PRIMARY KEY(scope, object)
);

CREATE TABLE gateway_session_tool_manifest (
  session_id      TEXT PRIMARY KEY,
  actor           TEXT NOT NULL,
  active_scope    TEXT NOT NULL,
  body            TEXT NOT NULL, -- JSON SessionToolManifest
  last_apply_seq  INTEGER NOT NULL,
  last_apply_hash TEXT NOT NULL,
  updated_at_ms   INTEGER NOT NULL,
  expires_at_ms   INTEGER NOT NULL,
  stale           INTEGER NOT NULL DEFAULT 0,
  stale_reason    TEXT
);

CREATE TABLE gateway_tool_surface_source (
  scope                  TEXT NOT NULL,
  source_table           TEXT NOT NULL,
  source_authority_scope TEXT NOT NULL,
  source_key             TEXT NOT NULL,
  object                 TEXT NOT NULL,
  PRIMARY KEY(scope, source_table, source_authority_scope, source_key, object)
);

CREATE INDEX gateway_tool_surface_source_lookup
  ON gateway_tool_surface_source(source_table, source_authority_scope, source_key);

CREATE TABLE gateway_tool_surface_scope (
  scope            TEXT PRIMARY KEY,
  saturated        INTEGER NOT NULL DEFAULT 0,
  saturated_reason TEXT,
  updated_at_ms    INTEGER NOT NULL
);
```

When an accepted fanout carries projection writes or
`projection_delta.tool_surface_sources`, a gateway shard upserts or deletes the
named cache rows, updates `gateway_projection_scope`, and invalidates any
tool-surface rows whose source index names a changed object row. The shard also
uses the accepted transcript's moves and creates to repair `contents` on cached
container rows that did not receive a full object-row write; this is a cache
repair only, never authority minting, and it invalidates that container's cached
tool-surface coverage so the next descriptor read can refresh from the owner.
Session close/expiry removes the local session cache row and, for sessionless
guest-pool actors, prunes that actor from the cached active scope's contents.
Descriptor reads may use bounded-stale projection rows or a session's last
manifest, but auth, permissions, and VM execution reads must continue to use
authoritative paths.

The tool-surface source index is capped per gateway scope and per gateway shard.
If persisting a surface's source rows would exceed either configured cap, the
gateway stores that `gateway_tool_surface` row with `stale=1` and
`stale_reason='disabled'`, marks the scope saturated in
`gateway_tool_surface_scope`, and does not add `gateway_tool_surface_source`
entries for it. Descriptor reads ignore saturated scopes and use the session
manifest or owner refresh path instead. The scope can leave saturation only
after disabled surfaces have been replaced or deleted and its persisted source
rows fit under both caps.

---

## 15. Caching and invalidation

### 15.1 What's cached on a host

For each persistent obj this host knows about:
- Parent chain (`ancestor_chain` table)
- Verb bytecode by ancestor (`ancestor_verb_cache`)
- Property defaults by ancestor (`ancestor_prop_cache`)

Transient objects don't participate in caching (they're already local to their host).

### 15.2 Population

On first need (cache miss):
- For verbs: RPC to defining ancestor → store bytecode + version locally.
- For prop defaults: RPC to defining ancestor → store default + version.
- For chain: RPC to parent → recursively assemble, cache result.

The RPC is from the looking-up host to the *defining ancestor's host* (which holds the canonical bytecode), not to every host on the chain. We "skip" hosts in the middle by following the parent pointer to the next host with the verb defined.

### 15.3 Lazy version check

Cache freshness is checked on use, not pushed. Every cross-host RPC for verb call or property read carries `expected_version` for any cached artifact the caller is relying on:

- The receiver compares against its current version (`verb.version` or `property_def.version`).
- Match: normal reply.
- Mismatch: receiver returns the updated artifact (bytecode, default value) plus the new version in the same reply. Caller updates its cache.

Cost: a few bytes per RPC carrying the expected version. Benefit: no subscriber-list machinery, no fanout on edits, no eventual-consistency window beyond one RPC round trip. Edits become atomic operations on the defining object alone — they bump a version counter; descendants discover the change on next use.

When a chain changes (`chparent`), the reparented object bumps an internal chain version. Descendants are not notified eagerly; their next lookup carries the stale chain version, the receiver returns the new chain along with the artifacts, and the caller updates. Hosts may cache the chain with a short TTL (default 60s) for paths where the version-check round trip isn't worth the bytes.

### 15.4 Bounded cache size

A host caches at most N entries per category (configurable, default 4096). LRU eviction. With lazy version check there is no subscription state to clean up on eviction; an evicted entry's version is simply forgotten and refetched on next use.
