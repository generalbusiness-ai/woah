---
date: 2026-04-30
status: implemented
---

# Sequenced Logs

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

`$sequenced_log` is the smaller primitive that `$space` is built on. It is the *only* part of the coordination story the runtime privileges: an anchored, append-only message log with atomically-allocated sequence numbers. Subscribers, presence, observation routing, and dispatch are user-level concerns layered on top by subclasses.

This split exists for three reasons:

- **Custom sequencers** (event-sourced documents, CRDT-based shared state, replicated logs for v2 federation) become possible without runtime changes.
- **Wire and REST contracts** can speak in terms of "sequenced log read/append," not specifically "space" — any subclass that exposes the primitive participates in REST log paging and SSE streams.
- **For v1, `$space` remains the workhorse subclass.** The split is a layering, not a behavior change. Existing call lifecycle, snapshot, and replay rules carry forward, just attributed to the right layer.

---

## SL1. Contract

A `$sequenced_log` instance has, at minimum:

| Field | Meaning |
|---|---|
| `next_seq` | int property; next seq to assign. Starts at 1. Reserved name; user code must not write it directly. |
| `last_snapshot_seq` | int property; highest seq covered by a snapshot. Defaults 0. Snapshot policy is subclass-defined. |

The log itself is durable storage backed by the host. The runtime exposes it through the host operations in §SL2; user code does not touch the underlying storage.

`$sequenced_log` is **anchored**: a log and its `next_seq` counter live in one anchor cluster (per [objects.md §4.1](objects.md#41-anchor-and-atomicity-scope)). This is what makes seq allocation atomic. Cross-cluster logs would need consensus and are out of scope for v1.

---

## SL2. The native host operations

Two operations are provided by the runtime. Subclasses may expose object-visible wrappers, but the atomicity contract belongs to the host/repository layer. Subclasses **may not** override the atomicity contract — they wrap behavior *around* the native operations, not replace them.

### `append(message) -> seq`

Atomically within the enclosing transaction: allocates `seq = next_seq`, increments `next_seq`, and inserts `(seq, message)` into the log. Returns the assigned seq.

**Atomicity contract.** `$space:call` may reserve a seq in memory before it opens the storage transaction, but that reservation is not visible to replay or subscribers. If the enclosing transaction commits after `append` returns, `(seq, message)` is durably committed and `next_seq` has advanced. If the storage layer fails before commit, the transaction raises `E_STORAGE` and `next_seq` does *not* advance — see [failures.md §F6](failures.md#f6-storage-and-persistence-failures). The runtime never reaches "seq durably advanced but message not in the log."

`append` is the **only** runtime-blessed mechanism for incrementing `next_seq`. User code that writes `next_seq` directly violates the contract; replay will diverge.

`message` is a value (V2-encoded) of any shape. The log does not interpret it. A space subclass passes its standard `{actor, target, verb, args}` shape; an event-sourced document passes operation deltas; a turn log passes move records.

**Outcome is recorded separately.** `append` creates the message row; subclasses that care about success/failure (e.g., `$space`) record the already-computed outcome through a second storage operation in the same commit transaction. See [reference/cloudflare.md §R3.2](../reference/cloudflare.md#r32-sequenced-log-commit). The pending marker exists only inside the open transaction; committed rows always carry a final outcome.

### `read(from, limit) -> {messages, next_seq, has_more}`

Returns up to `limit` messages with `seq >= from`, plus the current `next_seq` and a `has_more` flag. Pure introspection; idempotent; no side effects.

`messages` is `list<{seq: int, message: any}>`.

`from < 1` or `limit > 1000` raises `E_RANGE`. `limit` defaults to 100 if omitted.

---

## SL3. Replay

Replay = re-applying logged messages to materialize state. The mechanism lives **outside** the log itself — a subclass's `:call` (or analog) is what dispatches and applies; the log just records. `$sequenced_log` itself defines no dispatch.

For replay to converge, dispatch must be deterministic given `(message, target_state, anchor_cluster_state)`. See [space.md §S4](space.md#s4-determinism-and-replay) for the standard discipline; subclasses with different dispatch semantics define their own determinism rules.

Snapshots are also outside the log. A subclass may store snapshots in a parallel structure ([persistence.md](../reference/persistence.md) `space_snapshot` table, or a subclass-specific equivalent) and use them to bound replay. The log can be truncated up to `last_snapshot_seq`; truncation is a host-local optimization and does not affect semantics.

---

## SL4. Wire and REST contracts

The REST `/api/objects/{id-or-name}/log` endpoint ([rest.md §R7](../protocol/rest.md#r7-log)) uses the host log read operation for any `$sequenced_log` descendant. A subclass may expose an object-visible read wrapper, but the REST path does not require one and the runtime does not special-case `$space`.

The body-level `space?` field on calls ([rest.md §R6](../protocol/rest.md#r6-verb-calls)) accepts any `$sequenced_log` descendant. The field name remains `space` for v1 wire-format stability; `log` is the more precise name and may be aliased in a later vocabulary revision.

SSE event ids (`<log-id>:<seq>`) likewise reference `$sequenced_log` descendants generally. Single-log resume per [rest.md §R8](../protocol/rest.md#r8-stream-sse) works for any subclass.

---

## SL5. The v1 reference subclass: `$space`

`$space` is the v1 coordination workhorse. It adds:

- `session_subscribers` plus the compatibility `subscribers` actor projection.
- `call(message)` — protocol/host sequenced dispatch: validates, authorizes, appends through the host log primitive, runs the target verb, emits an applied frame to the session audience. See [space.md §S2](space.md#s2-the-call-lifecycle).
- `:replay(from, limit)` — object-visible public wrapper over the host log read operation.
- `:on_applied(_event)` — reserved snapshot-triggering hook ([space.md §S7](space.md#s7-snapshots)); not installed by the v0 seed graph.
- Single-threaded execution discipline ([space.md §S9](space.md#s9-single-threaded-by-construction)) — a subclass discipline, not a `$sequenced_log` rule.

For v1, almost every coordination use case is a `$space`. The split is mostly there so the v1 reference subclass is *the reference subclass*, not the only one.

---

## SL6. Other plausible subclasses

These are not part of v1; they show that the primitive composes:

- **`$event_sourced_document`** — collaborative text doc; messages are operational-transform deltas; replay produces the document state. No subscribers list; the document object's subscribers are managed by a separate presence layer.
- **`$turn_log`** — game session where seq order is turn order. Calls are "submit move"; dispatch validates legality and applies.
- **`$replicable_log`** (v2 federation) — log entries replicate across worlds. Conflict resolution lives in the subclass; the runtime guarantees host append is atomic *within a world* but not across.
- **`$audit_log`** — pure append-only log with no dispatch. Useful for compliance trails. Append is called by other verbs through a subclass wrapper or host operation; read is exposed to auditors through a wrapper or management API.

Each subclass picks its own dispatch semantics, observation policy, and snapshot rules. The runtime guarantee is identical: append is atomic; read paginates.

---

## SL7. What stays runtime, what moves to user code

| Runtime guarantees | User code (subclass) provides |
|---|---|
| Append atomicity (seq + log + counter). | Dispatch (target verb resolution, behavior execution). |
| Read paging. | Subscriber maintenance and audience routing. |
| Anchor-cluster scoping for atomicity. | Snapshot policy (when, what to capture). |
| `next_seq` durability. | Single-threaded execution discipline (subclass enforces). |
| Storage-failure rollback (no half-appended state). | Error observation shape, replay determinism rules. |

The single-threaded execution rule from [space.md §S9](space.md#s9-single-threaded-by-construction) is a `$space` discipline, not a `$sequenced_log` rule. Subclasses with no dispatch (passive append-only logs) need no such rule. Subclasses with dispatch must enforce it themselves.

---

## SL8. Errors

| Code | Meaning |
|---|---|
| `E_STORAGE` | Host append failed at the storage layer; seq did not advance. |
| `E_RANGE` | `:read(from, limit)` got `from < 1` or `limit > 1000`. |

Subclass dispatch errors (`E_VERBNF`, `E_PERM`, `E_INVARG`, `E_TRANSITION`, etc.) are emitted by the subclass during its own dispatch phase, not by `$sequenced_log`.

---

## SL9. Why this primitive, not something smaller

A reasonable alternative is to expose only an `ATOMIC_INCR(prop)` opcode and let user code manage its own log storage. The reason `$sequenced_log` is a primitive instead:

- **Durability + counter must be coordinated.** A user-managed log appended *after* the increment loses messages on storage failure between steps. Bundling them into a single host primitive closes the seam.
- **Read paging is wire-contract.** Standardizing it on a class avoids per-subclass schema divergence in REST and SSE.
- **Storage shape is implementation-private.** Implementations may store the log in a host-specific way (per-DO SQLite table, per-anchor-cluster file, eventually CRDT) without changing semantics. A user-managed log would lock the storage shape into user code.

`ATOMIC_INCR` may still appear as a separate opcode for non-log uses (rate-limit counters, distributed IDs, gensym) but is not how seq allocation works for a log.

---

## SL10. Migration from v1.0 → v1.1

If an implementation was built before this split:

- All existing `$space` instances are valid `$sequenced_log` instances. No data migration needed.
- The `$space:call` step "assign seq and append to log" becomes "call the host append primitive." Behaviorally identical.
- `$space:replay` becomes the object-visible wrapper over the host read primitive.
- Wire and REST formats are unchanged; `space` field accepts any `$sequenced_log` descendant.

Implementations that hard-coded the seq-allocation logic into `$space:call` should refactor it toward the shared `$sequenced_log` host primitive, but the change is a code-organization improvement, not a behavioral one.
