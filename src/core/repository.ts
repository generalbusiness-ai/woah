import type { AuthorityPageRef, ShadowStatePage } from "./shadow-state-pages";
import type { ErrorValue, Message, ObjRef, Observation, PropertyDef, SpaceLogEntry, VerbDef, WooObject, WooValue } from "./types";

export type SerializedObject = {
  id: ObjRef;
  name: string;
  parent: ObjRef | null;
  owner: ObjRef;
  location: ObjRef | null;
  anchor: ObjRef | null;
  flags: WooObject["flags"];
  created: number;
  modified: number;
  propertyDefs: PropertyDef[];
  properties: [string, WooValue][];
  propertyVersions: [string, number][];
  verbs: VerbDef[];
  children: ObjRef[];
  contents: ObjRef[];
  eventSchemas: [string, Record<string, WooValue>][];
};

export type SerializedSession = {
  id: string;
  actor: ObjRef;
  started: number;
  expiresAt?: number;
  lastDetachAt?: number | null;
  tokenClass?: "guest" | "bearer" | "apikey";
  activeScope?: ObjRef | null;
  /** Legacy serialized field accepted while older snapshots exist. */
  currentLocation?: ObjRef | null;
  /** The apikey record id this session was minted from, when tokenClass is
   * "apikey". Persisted so revokeApiKey can close routed and post-restart
   * session copies; omitting it would leave session:<id> usable until
   * normal expiry after a restart or on a host that received the session
   * via ensureSessionForActor. */
  apikeyId?: string;
};

export type SerializedAuthorityObjectSlice = {
  kind: "woo.authority_slice.shadow.v1";
  sessions: SerializedSession[];
  objects: SerializedObject[];
};

export type SerializedAuthorityCellSlice = {
  kind: "woo.authority_slice.cells.shadow.v1";
  sessions: SerializedSession[];
  // A3: authority cell pages carry MANDATORY provenance. `AuthorityPageRef`
  // requires `source`, so the type system refuses any builder that would emit
  // a page without declaring whether it is the owner's authoritative row or a
  // cache/projection/fallback/gossip derivation.
  page_refs: AuthorityPageRef[];
  inline_pages: ShadowStatePage[];
  counters: Pick<SerializedWorld, "objectCounter" | "parkedTaskCounter" | "sessionCounter">;
  tombstones: ObjRef[];
  source_object_count: number;
};

export type SerializedAuthoritySlice = SerializedAuthorityObjectSlice | SerializedAuthorityCellSlice;

export type SpaceSnapshotRecord = {
  space_id: ObjRef;
  seq: number;
  ts: number;
  state: WooValue;
  hash: string;
};

export type ParkedTaskRecord = {
  id: string;
  parked_on: ObjRef;
  state: "suspended" | "awaiting_read";
  resume_at: number | null;
  awaiting_player: ObjRef | null;
  correlation_id: string | null;
  serialized: WooValue;
  created: number;
  origin: ObjRef;
};

export type SerializedWorld = {
  version: 1;
  objectCounter: number;
  /** Legacy v0.5 field; load paths accept it while older JSON/SQLite dumps exist. */
  taskCounter?: number;
  parkedTaskCounter: number;
  sessionCounter: number;
  objects: SerializedObject[];
  sessions: SerializedSession[];
  logs: [ObjRef, SpaceLogEntry[]][];
  snapshots: SpaceSnapshotRecord[];
  parkedTasks: ParkedTaskRecord[];
  /** Tombstoned ULIDs (recycled). Per spec/semantics/recycle.md §RC3.9 and
   * spec/reference/persistence.md §14.2.1. Optional in legacy dumps; absent
   * means "no recycles recorded yet for this world". */
  tombstones?: ObjRef[];
};

/** Host-scoped seed delivered to a satellite for cold-load or refresh.
 * Per spec/protocol/host-seeds.md §HS1: a SerializedWorld slice plus the
 * authoritative host for every subject in the slice. The merge dispatches
 * receiver-vs-foreign-hosted by reading objectHosts; it is the only routing
 * input the merge needs, so it MUST be populated from the gateway's batched
 * directory view at export time, never by per-id RPC at merge time. */
export type SeedWorld = SerializedWorld & {
  objectHosts: Record<ObjRef, ObjRef>;
};

export interface WorldRepository {
  load(): SerializedWorld | null;
  save(world: SerializedWorld): void;
  saveSpaceSnapshot?(snapshot: SpaceSnapshotRecord): void;
  latestSpaceSnapshot?(space: ObjRef): SpaceSnapshotRecord | null;
}

// ---------------------------------------------------------------------------
// ObjectRepository: per-object persistence interface.
//
// Per spec/reference/cloudflare.md §R3. The runtime accesses storage exclusively
// through this interface; backends (in-memory, local SQLite, Cloudflare DO
// SQLite) implement it. This is the contract the world-decomposition refactor
// should converge on.
//
// Each implementation is scoped to a "host" — one DO in CF, one process in
// local dev. The host owns the rows for one or more objects (an anchor cluster
// or a single autonomous object). All operations target this host's hosted
// set; cross-host operations go through the RPC surface (cloudflare.md §R5),
// not through this interface.
//
// Repository methods are synchronous because the target storage primitives are
// synchronous (local SQLite and CF Durable Object SQLite). The runtime above
// this interface is async; it awaits cross-host work before entering a storage
// transaction, then commits the final local state/log outcome synchronously.
// ---------------------------------------------------------------------------

/** A single property's persisted form (split out of SerializedObject for per-property ops). */
export type SerializedProperty = {
  name: string;
  /** Definition (slot introduction). Null when the property is only valued, not defined here. */
  def: PropertyDef | null;
  /** Value stored on this object (overrides ancestor default). Undefined when unset. */
  value: WooValue | undefined;
  /** Per-property version counter for optimistic concurrency on definition edits. */
  version: number;
};

/** A single verb's persisted form (split out for per-verb ops). */
export type SerializedVerb = VerbDef;

/** A read of one slice of a $sequenced_log. */
export type LogReadResult = {
  messages: SpaceLogEntry[];
  next_seq: number;
  has_more: boolean;
};

/** A read of one parked task record (alias retained for clarity at call sites). */
export type SerializedTask = ParkedTaskRecord;

export interface ObjectRepository {
  // ----- Transactions / unit of work -----

  /**
   * Execute `fn` inside an atomic write boundary. All mutations made via
   * `save*`/`delete*`/`add*`/`remove*`/`recordLogOutcome` calls inside `fn` commit
   * together or roll back together if `fn` throws.
   *
   * Used for the final durable commit of a sequenced call, plus bootstrap,
   * migrations, and repository-local maintenance. The async behavior body runs
   * before this boundary; if it succeeds or produces a sequenced behavior
   * failure, the resulting state and log outcome are committed together here.
   * The CF backend uses `state.storage.transactionSync`; the in-memory backend
   * snapshot-and-restores; the local SQLite backend uses BEGIN/COMMIT/ROLLBACK.
   *
   * Implementations may flatten nested `transaction` calls. Rollback scopes
   * inside a transaction use `savepoint` below.
   */
  transaction<T>(fn: () => T): T;

  /**
   * Execute `fn` inside a rollback scope nested within the current transaction.
   * If `fn` throws, mutations made inside the savepoint are rolled back, then
   * the error is rethrown and the outer transaction remains usable.
   *
   * Runtime `$space:call` cannot run async cross-host behavior inside a sync
   * storage transaction, so it uses an in-memory behavior savepoint and commits
   * after the awaited body completes. Repository savepoints remain for purely
   * storage-local maintenance code, conformance tests, and future migrations.
   *
   * The CF backend relies on nested `state.storage.transactionSync` savepoint
   * behavior; local SQLite uses `SAVEPOINT` / `ROLLBACK TO`; in-memory backends
   * snapshot and restore at this boundary.
   */
  savepoint<T>(fn: () => T): T;

  // ----- Object identity & metadata -----

  /**
   * Load the object metadata + all per-object rows (properties, verbs, children,
   * contents, schemas) for `id`. Returns null if the object is not hosted here.
   *
   * The caller composes this with separately-loaded properties/verbs only if
   * they want a fully-materialized view; the runtime's hot path uses the
   * per-property and per-verb getters below to avoid loading whole objects.
   */
  loadObject(id: ObjRef): SerializedObject | null;

  /** Persist a fully-materialized object. Used during bootstrap and recycle precursors. */
  saveObject(obj: SerializedObject): void;

  /**
   * Delete every row scoped to `id` on this host: property_def, property_value,
   * verb, child, content, event_schema, ancestor_chain, and the object row
   * itself. Per spec/semantics/recycle.md §RC3 step 8. Does NOT cascade across
   * hosts.
   */
  deleteObject(id: ObjRef): void;

  /** Enumerate the object IDs hosted here. Used for bootstrap idempotency checks and `:metrics()` rollups. */
  listHostedObjects(): ObjRef[];

  // ----- Properties (per-name granularity) -----

  loadProperty(id: ObjRef, name: string): SerializedProperty | null;

  /**
   * Persist a property's def and/or value. Implementations should preserve the
   * version field; the runtime supplies the version from its in-memory state.
   */
  saveProperty(id: ObjRef, prop: SerializedProperty): void;

  deleteProperty(id: ObjRef, name: string): void;

  /** List all property names defined or valued on `id` (no values, just names). */
  listPropertyNames(id: ObjRef): string[];

  // ----- Verbs (per-name granularity) -----

  loadVerb(id: ObjRef, name: string): SerializedVerb | null;

  saveVerb(id: ObjRef, verb: SerializedVerb): void;

  deleteVerb(id: ObjRef, name: string): void;

  listVerbNames(id: ObjRef): string[];

  // ----- Inheritance / containment (denormalized per persistence.md §14.1) -----

  /** Children whose parent is `id` (objref of child; may live on a different host). */
  loadChildren(id: ObjRef): ObjRef[];
  addChild(id: ObjRef, child: ObjRef): void;
  removeChild(id: ObjRef, child: ObjRef): void;

  /** Contents whose location is `id`. */
  loadContents(id: ObjRef): ObjRef[];
  addContent(id: ObjRef, child: ObjRef): void;
  removeContent(id: ObjRef, child: ObjRef): void;

  // ----- Event schemas -----

  loadEventSchemas(id: ObjRef): [string, Record<string, WooValue>][];
  saveEventSchema(id: ObjRef, type: string, schema: Record<string, WooValue>): void;
  deleteEventSchema(id: ObjRef, type: string): void;

  // ----- $sequenced_log surface (per spec/semantics/sequenced-log.md) -----
  //
  // Two-step write per spec/reference/cloudflare.md §R3.2:
  //   1. The runtime has already run the async behavior path and knows the seq,
  //      observations, and outcome it intends to commit.
  //   2. `appendLog` inserts the row inside the caller's `transaction()`.
  //   3. `recordLogOutcome` updates that row before the transaction commits.
  //      A committed row always has a final outcome.

  /**
   * Within the caller's transaction: allocate `seq = next_seq`, increment
   * `next_seq`, and insert `(seq, ts, actor, message, applied_ok = NULL)`.
   * Returns the assigned seq + ts. The runtime checks that this seq matches the
   * seq it reserved in memory before behavior execution.
   *
   * Callers must finish the row with `recordLogOutcome` before the outer
   * transaction commits. If the transaction aborts, the seq allocation and
   * pending row abort with it.
   */
  appendLog(space: ObjRef, actor: ObjRef, message: Message): { seq: number; ts: number };

  /**
   * Update the pending log row with the behavior outcome and replayable
   * observations. Called inside the same `transaction()` as `appendLog`, before
   * commit (see §R3.4).
   *
   * Idempotent: calling twice with the same outcome is a no-op; calling with a
   * different outcome raises (an outcome should be immutable once set).
   */
  recordLogOutcome(space: ObjRef, seq: number, applied_ok: boolean, observations?: Observation[], error?: ErrorValue): void;

  /**
   * Idempotently materialize an already-accepted v2 commit log row. Unlike
   * appendLog/recordLogOutcome this does not allocate a sequence number or
   * mutate next_seq; the accepted transcript already carried both.
   */
  saveCommittedLogEntry(space: ObjRef, entry: SpaceLogEntry): void;

  /** Read at most `limit` log entries with `seq >= from`. Caller checks for `has_more`. */
  readLog(space: ObjRef, from: number, limit: number): LogReadResult;

  /** Current next_seq (= 1 + highest assigned). For introspection and tests. */
  currentSeq(space: ObjRef): number;

  // ----- Snapshots -----

  saveSpaceSnapshot(snapshot: SpaceSnapshotRecord): void;
  loadLatestSnapshot(space: ObjRef): SpaceSnapshotRecord | null;
  /**
   * Truncate log entries with `seq <= covered_seq`. Returns the count truncated.
   * Implementations may opt to log-and-noop in v1 (truncation is an optimization,
   * not a correctness requirement; see spec/semantics/space.md §S5).
   */
  truncateLog(space: ObjRef, covered_seq: number): number;

  // ----- Sessions (credential metadata only — see identity.md §I2) -----

  loadSession(session_id: string): SerializedSession | null;
  saveSession(record: SerializedSession): void;
  deleteSession(session_id: string): void;

  /**
   * Sessions on this host that are eligible for reap: `last_detach_at + grace < now`
   * or `now > expires_at`. The runtime's reap loop ignores attached in-memory
   * connections; storage never persists socket ids.
   * Implementations may return all sessions and let the caller filter; or filter
   * at the storage layer for efficiency.
   */
  loadExpiredSessions(now: number): SerializedSession[];

  // ----- Parked tasks (per spec/semantics/tasks.md §16) -----

  saveTask(task: ParkedTaskRecord): void;

  deleteTask(id: string): void;

  loadTask(id: string): ParkedTaskRecord | null;

  /**
   * Tasks with `state == 'suspended' AND resume_at <= now`, ordered by `resume_at`.
   * The runtime's alarm handler (cloudflare.md §R7) loads these on alarm fire.
   */
  loadDueTasks(now: number): ParkedTaskRecord[];

  /**
   * Tasks with `state == 'awaiting_read' AND awaiting_player == player`, in FIFO
   * order. The runtime's input-delivery path loads these on inbound input.
   */
  loadAwaitingReadTasks(player: ObjRef): ParkedTaskRecord[];

  /**
   * Earliest `resume_at` over all suspended tasks on this host, or null if none.
   * Drives `state.storage.setAlarm()` on CF; ignored by the local poller backend.
   */
  earliestResumeAt(): number | null;

  // ----- Tombstones (per spec/reference/persistence.md §14.2.1) -----

  /**
   * Persist a recycled-ULID tombstone. Idempotent: re-saving the same id is
   * a no-op. The row is immutable once written; recycle inserts in the same
   * transaction as deleteObject.
   */
  saveTombstone(id: ObjRef, recycledAt: number, reason?: string | null): void;

  /** Enumerate every tombstone on this host. Used at boot to rebuild the in-memory set. */
  loadTombstones(): ObjRef[];

  /** Enumerate every tombstone on this host with its recycled_at and reason.
   * Used by the host-teardown teardown sequence (per
   * spec/semantics/recycle.md §RC11.3 step 2) to migrate the roster to the
   * Directory's `inherited_tombstone` table. */
  loadTombstoneRecords(): TombstoneRecord[];

  // ----- Host-scoped counters -----

  /**
   * Atomically read-and-increment a named counter. Used for ULID minting suffix,
   * task ids, session ids, etc. Counters persist across host restarts.
   */
  nextCounter(name: string): number;

  // ----- Bootstrap state -----

  /**
   * Read a host-scoped meta value. Used for the `bootstrapped` flag and similar
   * one-time state.
   */
  loadMeta(key: string): string | null;
  saveMeta(key: string, value: string): void;
}

/** Public-facing record shape for tombstones, mirrored to the Directory at
 * host teardown (spec/semantics/recycle.md §RC11). */
export type TombstoneRecord = { id: ObjRef; recycled_at: number; reason: string | null };
