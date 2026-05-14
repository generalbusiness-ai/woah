import { cloneValue, wooError, type ErrorValue, type Message, type ObjRef, type Observation, type PropertyDef, type Session, type SpaceLogEntry, type VerbDef, type WooObject, type WooValue } from "./types";

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

type PendingSpaceLogEntry = Omit<SpaceLogEntry, "applied_ok"> & { applied_ok: boolean | null };

type Tombstone = { id: ObjRef; recycled_at: number; reason: string | null };

/** Public-facing record shape for tombstones, mirrored to the Directory at
 * host teardown (spec/semantics/recycle.md §RC11). */
export type TombstoneRecord = { id: ObjRef; recycled_at: number; reason: string | null };

type InMemoryObjectRepositoryState = {
  objects: Map<ObjRef, SerializedObject>;
  sessions: Map<string, SerializedSession>;
  logs: Map<ObjRef, PendingSpaceLogEntry[]>;
  snapshots: SpaceSnapshotRecord[];
  tasks: Map<string, ParkedTaskRecord>;
  tombstones: Map<ObjRef, Tombstone>;
  counters: Map<string, number>;
  meta: Map<string, string>;
};

export class InMemoryObjectRepository implements ObjectRepository, WorldRepository {
  private objects = new Map<ObjRef, SerializedObject>();
  private sessions = new Map<string, SerializedSession>();
  private logs = new Map<ObjRef, PendingSpaceLogEntry[]>();
  private snapshots: SpaceSnapshotRecord[] = [];
  private tasks = new Map<string, ParkedTaskRecord>();
  private tombstones = new Map<ObjRef, Tombstone>();
  private counters = new Map<string, number>();
  private meta = new Map<string, string>();
  private transactionDepth = 0;

  load(): SerializedWorld | null {
    if (this.objects.size === 0) return null;
    return {
      version: 1,
      objectCounter: Number(this.meta.get("objectCounter") ?? this.meta.get("taskCounter") ?? 1),
      parkedTaskCounter: Number(this.meta.get("parkedTaskCounter") ?? 1),
      sessionCounter: Number(this.meta.get("sessionCounter") ?? 1),
      objects: Array.from(this.objects.values()).map(cloneSerializedObject),
      sessions: Array.from(this.sessions.values()).map((session) => cloneRepoValue(session)),
      logs: Array.from(this.logs.entries()).map(([space, entries]) => [space, entries.map(finalizeLogEntry)]),
      snapshots: this.snapshots.map((snapshot) => cloneRepoValue(snapshot)),
      parkedTasks: Array.from(this.tasks.values()).map((task) => cloneRepoValue(task)),
      tombstones: Array.from(this.tombstones.keys()).sort()
    };
  }

  save(world: SerializedWorld): void {
    this.transaction(() => {
      this.objects.clear();
      this.sessions.clear();
      this.logs.clear();
      this.snapshots = [];
      this.tasks.clear();
      this.tombstones.clear();
      this.counters.clear();
      this.meta.clear();
      this.meta.set("version", String(world.version));
      this.meta.set("objectCounter", String(world.objectCounter));
      this.meta.set("parkedTaskCounter", String(world.parkedTaskCounter));
      this.meta.set("sessionCounter", String(world.sessionCounter));
      for (const obj of world.objects) this.objects.set(obj.id, cloneSerializedObject(obj));
      for (const session of world.sessions) this.sessions.set(session.id, cloneRepoValue(session));
      for (const [space, entries] of world.logs) {
        this.logs.set(space, entries.map((entry) => ({ ...cloneRepoValue(entry), observations: entry.observations ?? [], applied_ok: entry.applied_ok })));
      }
      this.snapshots = world.snapshots.map((snapshot) => cloneRepoValue(snapshot));
      for (const task of world.parkedTasks) this.tasks.set(task.id, cloneRepoValue(task));
      const now = Date.now();
      for (const id of world.tombstones ?? []) {
        if (!this.tombstones.has(id)) this.tombstones.set(id, { id, recycled_at: now, reason: null });
      }
    });
  }

  transaction<T>(fn: () => T): T {
    // Nested transaction() calls intentionally flatten. Use savepoint() when
    // the inner scope needs rollback isolation without aborting the outer unit.
    if (this.transactionDepth > 0) return fn();
    const before = this.snapshotState();
    this.transactionDepth = 1;
    try {
      const result = fn();
      this.assertNoPendingLogOutcomes();
      return result;
    } catch (err) {
      this.restoreState(before);
      throw err;
    } finally {
      this.transactionDepth = 0;
    }
  }

  savepoint<T>(fn: () => T): T {
    const before = this.snapshotState();
    try {
      return fn();
    } catch (err) {
      this.restoreState(before);
      throw err;
    }
  }

  loadObject(id: ObjRef): SerializedObject | null {
    const obj = this.objects.get(id);
    return obj ? cloneSerializedObject(obj) : null;
  }

  saveObject(obj: SerializedObject): void {
    this.objects.set(obj.id, cloneSerializedObject(obj));
  }

  deleteObject(id: ObjRef): void {
    this.objects.delete(id);
  }

  listHostedObjects(): ObjRef[] {
    return Array.from(this.objects.keys()).sort();
  }

  loadProperty(id: ObjRef, name: string): SerializedProperty | null {
    const obj = this.objects.get(id);
    if (!obj) return null;
    const def = obj.propertyDefs.find((item) => item.name === name) ?? null;
    const valueEntry = obj.properties.find(([propName]) => propName === name);
    const versionEntry = obj.propertyVersions.find(([propName]) => propName === name);
    if (!def && valueEntry === undefined && versionEntry === undefined) return null;
    return {
      name,
      def: def ? { ...def, defaultValue: cloneRepoValue(def.defaultValue) } : null,
      value: valueEntry ? cloneRepoValue(valueEntry[1]) : undefined,
      version: versionEntry?.[1] ?? def?.version ?? 0
    };
  }

  saveProperty(id: ObjRef, prop: SerializedProperty): void {
    const obj = this.requireObject(id);
    obj.propertyDefs = obj.propertyDefs.filter((item) => item.name !== prop.name);
    if (prop.def) obj.propertyDefs.push({ ...prop.def, defaultValue: cloneRepoValue(prop.def.defaultValue) });
    obj.properties = obj.properties.filter(([name]) => name !== prop.name);
    if (prop.value !== undefined) obj.properties.push([prop.name, cloneRepoValue(prop.value)]);
    obj.propertyVersions = obj.propertyVersions.filter(([name]) => name !== prop.name);
    obj.propertyVersions.push([prop.name, prop.version]);
  }

  deleteProperty(id: ObjRef, name: string): void {
    const obj = this.requireObject(id);
    obj.propertyDefs = obj.propertyDefs.filter((item) => item.name !== name);
    obj.properties = obj.properties.filter(([propName]) => propName !== name);
    obj.propertyVersions = obj.propertyVersions.filter(([propName]) => propName !== name);
  }

  listPropertyNames(id: ObjRef): string[] {
    const obj = this.requireObject(id);
    return Array.from(new Set([...obj.propertyDefs.map((def) => def.name), ...obj.properties.map(([name]) => name)])).sort();
  }

  loadVerb(id: ObjRef, name: string): SerializedVerb | null {
    return cloneMaybe(this.objects.get(id)?.verbs.find((verb) => verb.name === name) ?? null);
  }

  saveVerb(id: ObjRef, verb: SerializedVerb): void {
    const obj = this.requireObject(id);
    const index = typeof verb.slot === "number" ? verb.slot - 1 : obj.verbs.findIndex((item) => item.name === verb.name);
    const next = cloneRepoValue(verb as unknown as WooValue) as unknown as SerializedVerb;
    if (index >= 0 && index < obj.verbs.length) obj.verbs[index] = next;
    else obj.verbs.push(next);
    obj.verbs = obj.verbs.map((item, slot) => ({ ...item, slot: slot + 1 }) as SerializedVerb);
  }

  deleteVerb(id: ObjRef, name: string): void {
    const obj = this.requireObject(id);
    obj.verbs = obj.verbs.filter((verb) => verb.name !== name);
  }

  listVerbNames(id: ObjRef): string[] {
    return this.requireObject(id)
      .verbs.map((verb) => verb.name)
  }

  loadChildren(id: ObjRef): ObjRef[] {
    return [...this.requireObject(id).children].sort();
  }

  addChild(id: ObjRef, child: ObjRef): void {
    const obj = this.requireObject(id);
    if (!obj.children.includes(child)) obj.children.push(child);
  }

  removeChild(id: ObjRef, child: ObjRef): void {
    const obj = this.requireObject(id);
    obj.children = obj.children.filter((item) => item !== child);
  }

  loadContents(id: ObjRef): ObjRef[] {
    return [...this.requireObject(id).contents].sort();
  }

  addContent(id: ObjRef, child: ObjRef): void {
    const obj = this.requireObject(id);
    if (!obj.contents.includes(child)) obj.contents.push(child);
  }

  removeContent(id: ObjRef, child: ObjRef): void {
    const obj = this.requireObject(id);
    obj.contents = obj.contents.filter((item) => item !== child);
  }

  loadEventSchemas(id: ObjRef): [string, Record<string, WooValue>][] {
    return this.requireObject(id).eventSchemas.map(([type, schema]) => [type, cloneRepoValue(schema as WooValue) as Record<string, WooValue>]);
  }

  saveEventSchema(id: ObjRef, type: string, schema: Record<string, WooValue>): void {
    const obj = this.requireObject(id);
    obj.eventSchemas = obj.eventSchemas.filter(([name]) => name !== type);
    obj.eventSchemas.push([type, cloneRepoValue(schema as WooValue) as Record<string, WooValue>]);
  }

  deleteEventSchema(id: ObjRef, type: string): void {
    const obj = this.requireObject(id);
    obj.eventSchemas = obj.eventSchemas.filter(([name]) => name !== type);
  }

  appendLog(space: ObjRef, actor: ObjRef, message: Message): { seq: number; ts: number } {
    this.requireObject(space);
    const seq = this.currentSeq(space);
    const nextSeq = this.loadProperty(space, "next_seq");
    this.saveProperty(space, { name: "next_seq", def: nextSeq?.def ?? null, value: seq + 1, version: (nextSeq?.version ?? 0) + 1 });
    const ts = Date.now();
    const entries = this.logs.get(space) ?? [];
    entries.push({ space, seq, ts, actor, message: cloneRepoValue(message as unknown as WooValue) as unknown as Message, observations: [], applied_ok: null });
    this.logs.set(space, entries);
    return { seq, ts };
  }

  recordLogOutcome(space: ObjRef, seq: number, applied_ok: boolean, observations: Observation[] = [], error?: ErrorValue): void {
    const entry = (this.logs.get(space) ?? []).find((item) => item.seq === seq);
    if (!entry) throw wooError("E_STORAGE", `log entry not found: ${space}:${seq}`);
    if (entry.applied_ok !== null) {
      if (entry.applied_ok === applied_ok && valuesEqualOrUndefined(entry.error, error) && JSON.stringify(entry.observations ?? []) === JSON.stringify(observations)) return;
      throw wooError("E_STORAGE", `log outcome already recorded: ${space}:${seq}`);
    }
    entry.applied_ok = applied_ok;
    entry.observations = cloneRepoValue(observations as unknown as WooValue) as unknown as Observation[];
    if (error) entry.error = cloneRepoValue(error as unknown as WooValue) as unknown as ErrorValue;
  }

  readLog(space: ObjRef, from: number, limit: number): LogReadResult {
    const all = (this.logs.get(space) ?? []).filter((entry) => entry.seq >= from).sort((left, right) => left.seq - right.seq);
    const page = all.slice(0, limit);
    return {
      messages: page.map(finalizeLogEntry),
      next_seq: this.currentSeq(space),
      has_more: all.length > limit
    };
  }

  currentSeq(space: ObjRef): number {
    const prop = this.loadProperty(space, "next_seq");
    if (typeof prop?.value === "number") return prop.value;
    return Math.max(0, ...(this.logs.get(space) ?? []).map((entry) => entry.seq)) + 1;
  }

  saveSpaceSnapshot(snapshot: SpaceSnapshotRecord): void {
    this.snapshots = this.snapshots.filter((item) => !(item.space_id === snapshot.space_id && item.seq === snapshot.seq));
    this.snapshots.push(cloneRepoValue(snapshot as unknown as WooValue) as unknown as SpaceSnapshotRecord);
  }

  loadLatestSnapshot(space: ObjRef): SpaceSnapshotRecord | null {
    return cloneMaybe(this.snapshots.filter((snapshot) => snapshot.space_id === space).sort((left, right) => right.seq - left.seq)[0] ?? null);
  }

  truncateLog(space: ObjRef, covered_seq: number): number {
    const before = this.logs.get(space) ?? [];
    const after = before.filter((entry) => entry.seq > covered_seq);
    this.logs.set(space, after);
    return before.length - after.length;
  }

  loadSession(session_id: string): SerializedSession | null {
    return cloneMaybe(this.sessions.get(session_id) ?? null);
  }

  saveSession(record: SerializedSession): void {
    this.sessions.set(record.id, cloneRepoValue(record as unknown as WooValue) as unknown as SerializedSession);
  }

  deleteSession(session_id: string): void {
    this.sessions.delete(session_id);
  }

  loadExpiredSessions(now: number): SerializedSession[] {
    return Array.from(this.sessions.values())
      .filter((session) => (session.expiresAt !== undefined && session.expiresAt <= now) || (session.lastDetachAt !== undefined && session.lastDetachAt !== null && session.lastDetachAt <= now))
      .map((session) => cloneRepoValue(session as unknown as WooValue) as unknown as SerializedSession);
  }

  saveTask(task: ParkedTaskRecord): void {
    this.tasks.set(task.id, cloneRepoValue(task as unknown as WooValue) as unknown as ParkedTaskRecord);
  }

  deleteTask(id: string): void {
    this.tasks.delete(id);
  }

  loadTask(id: string): ParkedTaskRecord | null {
    return cloneMaybe(this.tasks.get(id) ?? null);
  }

  loadDueTasks(now: number): ParkedTaskRecord[] {
    return Array.from(this.tasks.values())
      .filter((task) => task.state === "suspended" && task.resume_at !== null && task.resume_at <= now)
      .sort((left, right) => (left.resume_at ?? 0) - (right.resume_at ?? 0) || left.created - right.created || left.id.localeCompare(right.id))
      .map((task) => cloneRepoValue(task as unknown as WooValue) as unknown as ParkedTaskRecord);
  }

  loadAwaitingReadTasks(player: ObjRef): ParkedTaskRecord[] {
    return Array.from(this.tasks.values())
      .filter((task) => task.state === "awaiting_read" && task.awaiting_player === player)
      .sort((left, right) => left.created - right.created || left.id.localeCompare(right.id))
      .map((task) => cloneRepoValue(task as unknown as WooValue) as unknown as ParkedTaskRecord);
  }

  earliestResumeAt(): number | null {
    const times = Array.from(this.tasks.values())
      .filter((task) => task.state === "suspended" && task.resume_at !== null)
      .map((task) => task.resume_at as number);
    return times.length === 0 ? null : Math.min(...times);
  }

  saveTombstone(id: ObjRef, recycledAt: number, reason?: string | null): void {
    if (this.tombstones.has(id)) return; // immutable per spec
    this.tombstones.set(id, { id, recycled_at: recycledAt, reason: reason ?? null });
  }

  loadTombstones(): ObjRef[] {
    return Array.from(this.tombstones.keys()).sort();
  }

  loadTombstoneRecords(): TombstoneRecord[] {
    return Array.from(this.tombstones.values()).slice().sort((a, b) => a.id.localeCompare(b.id));
  }

  nextCounter(name: string): number {
    const next = this.counters.get(name) ?? 1;
    this.counters.set(name, next + 1);
    return next;
  }

  loadMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }

  saveMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }

  private requireObject(id: ObjRef): SerializedObject {
    const obj = this.objects.get(id);
    if (!obj) throw wooError("E_OBJNF", `object not hosted here: ${id}`, id);
    return obj;
  }

  private snapshotState(): InMemoryObjectRepositoryState {
    return {
      objects: new Map(Array.from(this.objects.entries()).map(([id, obj]) => [id, cloneSerializedObject(obj)])),
      sessions: new Map(Array.from(this.sessions.entries()).map(([id, session]) => [id, cloneRepoValue(session as unknown as WooValue) as unknown as SerializedSession])),
      logs: new Map(Array.from(this.logs.entries()).map(([space, entries]) => [space, entries.map((entry) => cloneRepoValue(entry as unknown as WooValue) as unknown as PendingSpaceLogEntry)])),
      snapshots: this.snapshots.map((snapshot) => cloneRepoValue(snapshot as unknown as WooValue) as unknown as SpaceSnapshotRecord),
      tasks: new Map(Array.from(this.tasks.entries()).map(([id, task]) => [id, cloneRepoValue(task as unknown as WooValue) as unknown as ParkedTaskRecord])),
      tombstones: new Map(this.tombstones),
      counters: new Map(this.counters),
      meta: new Map(this.meta)
    };
  }

  private restoreState(state: InMemoryObjectRepositoryState): void {
    this.objects = new Map(Array.from(state.objects.entries()).map(([id, obj]) => [id, cloneSerializedObject(obj)]));
    this.sessions = new Map(Array.from(state.sessions.entries()).map(([id, session]) => [id, cloneRepoValue(session as unknown as WooValue) as unknown as SerializedSession]));
    this.logs = new Map(Array.from(state.logs.entries()).map(([space, entries]) => [space, entries.map((entry) => cloneRepoValue(entry as unknown as WooValue) as unknown as PendingSpaceLogEntry)]));
    this.snapshots = state.snapshots.map((snapshot) => cloneRepoValue(snapshot as unknown as WooValue) as unknown as SpaceSnapshotRecord);
    this.tasks = new Map(Array.from(state.tasks.entries()).map(([id, task]) => [id, cloneRepoValue(task as unknown as WooValue) as unknown as ParkedTaskRecord]));
    this.tombstones = new Map(state.tombstones);
    this.counters = new Map(state.counters);
    this.meta = new Map(state.meta);
  }

  private assertNoPendingLogOutcomes(): void {
    for (const [space, entries] of this.logs) {
      const pending = entries.find((entry) => entry.applied_ok === null);
      if (pending) throw wooError("E_STORAGE", `pending log outcome at transaction commit: ${space}:${pending.seq}`);
    }
  }
}

function cloneSerializedObject(obj: SerializedObject): SerializedObject {
  return {
    ...obj,
    flags: { ...obj.flags },
    propertyDefs: obj.propertyDefs.map((def) => ({ ...def, defaultValue: cloneRepoValue(def.defaultValue) })),
    properties: obj.properties.map(([name, value]) => [name, cloneRepoValue(value)]),
    propertyVersions: obj.propertyVersions.map(([name, version]) => [name, version]),
    verbs: obj.verbs.map((verb, index) => ({ ...(cloneRepoValue(verb as unknown as WooValue) as VerbDef), slot: index + 1 })),
    children: [...obj.children],
    contents: [...obj.contents],
    eventSchemas: obj.eventSchemas.map(([type, schema]) => [type, cloneRepoValue(schema as WooValue) as Record<string, WooValue>])
  };
}

function cloneRepoValue<T>(value: T): T {
  return structuredClone(value);
}

function cloneMaybe<T>(value: T | null): T | null {
  return value === null ? null : cloneRepoValue(value);
}

function finalizeLogEntry(entry: PendingSpaceLogEntry): SpaceLogEntry {
  if (entry.applied_ok === null) throw wooError("E_STORAGE", `log entry has no committed outcome: ${entry.space}:${entry.seq}`);
  return {
    space: entry.space,
    seq: entry.seq,
    ts: entry.ts,
    actor: entry.actor,
    message: cloneRepoValue(entry.message as unknown as WooValue) as unknown as Message,
    observations: cloneRepoValue((entry.observations ?? []) as unknown as WooValue) as unknown as Observation[],
    applied_ok: entry.applied_ok,
    error: entry.error ? (cloneRepoValue(entry.error as unknown as WooValue) as unknown as ErrorValue) : undefined
  };
}

function valuesEqualOrUndefined(left: ErrorValue | undefined, right: ErrorValue | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
