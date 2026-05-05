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
  flags       TEXT NOT NULL,       -- JSON {wizard?, programmer?, fertile?, recyclable?}
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
  flags        TEXT NOT NULL,      -- JSON {direct_callable?, skip_presence_check?}
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
  id             TEXT PRIMARY KEY,         -- session_id (random 128-bit)
  actor          TEXT NOT NULL,            -- objref of bound actor
    started        INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    last_detach_at INTEGER,                  -- null while attached
    token_class    TEXT NOT NULL,            -- "guest" | "bearer" | "apikey"
    current_location TEXT                    -- session-scoped current location
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
-- Corename map: $foo → ULID.
CREATE TABLE corename (
  name   TEXT PRIMARY KEY,            -- e.g. "$wiz"
  target TEXT NOT NULL                -- ULID
);

-- World metadata.
CREATE TABLE world_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### 14.3 Atomicity

All writes within a single opcode are atomic (CF DOs give us SQLite transactions). A verb body is *not* atomic across yield points; cross-DO ops give other tasks a chance to interleave on each DO. Authors who need atomicity across multiple ops use `with_lock(obj) { ... }` (deferred to phase 2; simply documented for v1).

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
