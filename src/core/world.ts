import {
  assertMap,
  assertObj,
  assertString,
  cloneValue,
  directedRecipients,
  isErrorValue,
  valuesEqual,
  type AppliedFrame,
  type DirectResultFrame,
  type ErrorFrame,
  type ErrorValue,
  type Message,
  type MetricEvent,
  type Observation,
  type ObjRef,
  type PropertyDef,
  type RemoteToolDescriptor,
  type Session,
  type SpaceLogEntry,
  type VerbDef,
  type WooObject,
  type WooValue,
  wooError
} from "./types";
import type { ObjectRepository, ParkedTaskRecord, SerializedObject, SerializedProperty, SerializedSession, SerializedWorld, SpaceSnapshotRecord, WorldRepository } from "./repository";
import { isVmReadSignal, isVmSuspendSignal, runSerializedTinyVmTask, runSerializedTinyVmTaskWithInput, runTinyVm, type SerializedVmTask } from "./tiny-vm";
import { installCatalogManifest, updateCatalogManifest, type CatalogManifest, type CatalogMigrationManifest } from "./catalog-installer";
import { normalizeVerbPerms } from "./verb-perms";
import { analyzeBytecodePurity, combineVerbPurity, compileVerb, propagateVerbPurity } from "./authoring";
import { hashSource, randomHex, constantTimeEqual } from "./source-hash";

export type NativeHandler = (ctx: CallContext, args: WooValue[]) => WooValue | Promise<WooValue>;
const GUEST_SESSION_GRACE_MS = 60_000;
const GUEST_SESSION_TTL_MS = 5 * 60_000;
const CREDENTIAL_SESSION_GRACE_MS = 5 * 60_000;
const CREDENTIAL_SESSION_TTL_MS = 24 * 60 * 60_000;
const SUBSCRIBER_SCRUB_FLOOR_MS = 5_000;
// "Connected" for non-WebSocket sessions (REST, MCP) means "received input
// within this window". Past it, a stateless caller without a live socket
// reads as "sleeping" — same as a WS user whose connection has dropped.
const IDLE_PRESENCE_LIVE_WINDOW_MS = 5 * 60_000;

type ResolvedVerb = {
  definer: ObjRef;
  verb: VerbDef;
};

type ParsedToken = {
  value: string;
  start: number;
  end: number;
};

type ObjectMatch = {
  value: ObjRef;
  status: "ok" | "failed" | "ambiguous";
};

type CommandMap = {
  verb: string;
  dobj: ObjRef | null;
  dobjstr: string;
  dobj_prefix: ObjRef | null;
  dobj_prefix_str: string;
  dobj_prefix_rest: string;
  prep: string | null;
  iobj: ObjRef | null;
  iobjstr: string;
  args: string[];
  argstr: string;
  text: string;
};

type CommandVerbSummary = {
  name: string;
  definer?: ObjRef | null;
  direct_callable: boolean;
  arg_spec?: Record<string, WooValue>;
};

type CommandPattern = {
  dobj?: WooValue;
  prep?: WooValue;
  iobj?: WooValue;
  args_from?: WooValue;
};

type CommandPlan = {
  ok: true;
  route: "direct" | "sequenced";
  space: ObjRef | null;
  target: ObjRef;
  verb: string;
  args: WooValue[];
  cmd: CommandMap;
};

type CommandOptions = {
  deferHostEffect?: (effect: DeferredHostEffect) => void;
};

export type CallContext = {
  world: WooWorld;
  space: ObjRef;
  seq: number;
  session: string | null;
  actor: ObjRef;
  player: ObjRef;
  caller: ObjRef;
  callerPerms: ObjRef;
  progr: ObjRef;
  thisObj: ObjRef;
  verbName: string;
  definer: ObjRef;
  message: Message;
  observations: Observation[];
  observe(event: Observation): void;
  deferHostEffect?(effect: DeferredHostEffect): void;
  onSessionsEnded?(sessions: Session[]): void | Promise<void>;
  hostMemo?: HostOperationMemo;
  /** Per-call set of `${obj}->${target}` markers used by movetoChecked to
   * prevent infinite recursion when an `obj:moveto` verb calls back into
   * `moveto(this, target)` to delegate the actual move to the core. */
  movetoStack?: Set<string>;
};

export type DeferredHostEffect =
  | { kind: "actor_presence"; actor: ObjRef; space: ObjRef; present: boolean; session?: string }
  | { kind: "space_subscriber"; space: ObjRef; actor: ObjRef; present: boolean; session?: string }
  | { kind: "move_object"; obj: ObjRef; target: ObjRef; suppress_mirror_host?: string | null };

export type HostBridge = {
  localHost: string;
  hostForObject(id: ObjRef, memo?: HostOperationMemo): string | null | Promise<string | null>;
  getPropChecked(progr: ObjRef, objRef: ObjRef, name: string, memo?: HostOperationMemo): Promise<WooValue>;
  setPropChecked(progr: ObjRef, objRef: ObjRef, name: string, value: WooValue, memo?: HostOperationMemo): Promise<void>;
  objectSummary(readActor: ObjRef, objRef: ObjRef, memo?: HostOperationMemo): Promise<ScopedObjectSummary>;
  objectSummaries(readActor: ObjRef, objRefs: ObjRef[], memo?: HostOperationMemo): Promise<Record<ObjRef, ScopedObjectSummary>>;
  roomSnapshot(readActor: ObjRef, room: ObjRef, sessionId?: string | null, memo?: HostOperationMemo): Promise<RoomSnapshot>;
  overlaySnapshot?(readActor: ObjRef, subject: ObjRef, surface: string, sessionId?: string | null, memo?: HostOperationMemo): Promise<OverlaySnapshot>;
  describeObject?(nameActor: ObjRef, readActor: ObjRef, objRef: ObjRef, memo?: HostOperationMemo): Promise<HostObjectSummary>;
  describeObjects?(nameActor: ObjRef, readActor: ObjRef, objRefs: ObjRef[], memo?: HostOperationMemo): Promise<Record<ObjRef, HostObjectSummary>>;
  resolveVerb?(target: ObjRef, verbName: string, memo?: HostOperationMemo): Promise<CommandVerbSummary | null>;
  commandVerbCandidates?(target: ObjRef, verbName: string, memo?: HostOperationMemo): Promise<CommandVerbSummary[]>;
  isDescendantOf(objRef: ObjRef, ancestorRef: ObjRef, memo?: HostOperationMemo): Promise<boolean>;
  /** Probe the owning host's tombstone table. Optional — hosts that don't
   * yet expose a tombstone probe return false (matching the previous
   * local-only behavior). Per spec/semantics/recycle.md §RC5 and
   * spec/reference/persistence.md §14.2.1: each tombstone lives on the
   * owning host, so cross-host stale-ref answers must come from there. */
  isRecycled?(objRef: ObjRef, memo?: HostOperationMemo): Promise<boolean>;
  location(objRef: ObjRef, memo?: HostOperationMemo): Promise<ObjRef | null>;
  dispatch(ctx: CallContext, target: ObjRef, verbName: string, args: WooValue[], startAt?: ObjRef | null): Promise<WooValue>;
  moveObject(objRef: ObjRef, targetRef: ObjRef, options?: { suppressMirrorHost?: string | null }): Promise<MoveObjectResult>;
  mirrorContents(containerRef: ObjRef, objRef: ObjRef, present: boolean): Promise<void>;
  setActorPresence(actor: ObjRef, space: ObjRef, present: boolean, sessionId?: string): Promise<void>;
  setSpaceSubscriber(space: ObjRef, actor: ObjRef, present: boolean, sessionId?: string): Promise<void>;
  spaceAudienceSessions?(space: ObjRef, actors?: ObjRef[], memo?: HostOperationMemo): Promise<string[]>;
  actorSessionLocations?(actor: ObjRef, memo?: HostOperationMemo): Promise<ObjRef[]>;
  // Batched form of actorSessionLocations: one RPC per host instead of one
  // per actor. Used by `scrubStaleSubscribersForSpace`, which on a busy room
  // would otherwise issue N parallel calls (a chat room with 11 subscribers
  // wedged the worker's subrequest budget in production). Hosts that don't
  // implement this fall back to the single-actor path.
  actorSessionLocationsBatch?(actors: ObjRef[], memo?: HostOperationMemo): Promise<Map<ObjRef, ObjRef[]>>;
  contents(objRef: ObjRef, memo?: HostOperationMemo): Promise<ObjRef[]>;
  // Cross-host MCP reachability (spec/protocol/mcp.md §M3). Asks the host
  // owning each id for tool descriptors covering that id's tool-exposed verbs
  // plus the verbs of its current contents (when id is a $space). Optional —
  // hosts that don't run an MCP gateway can omit it.
  enumerateRemoteTools?(actor: ObjRef, ids: ObjRef[]): Promise<RemoteToolDescriptor[]>;
};

export type HostObjectSummary = {
  name: WooValue | null;
  description: WooValue | null;
  aliases: WooValue | null;
  owner?: WooValue | null;
  obvious_verbs?: WooValue | null;
};

export type HostOperationMemo = {
  routes: Map<ObjRef, Promise<string | null>>;
  // Read promises are scoped to one execution frame. Remote write bridges must
  // invalidate the matching key so read-after-write observes the new value.
  reads: Map<string, Promise<unknown>>;
};

export function createHostOperationMemo(): HostOperationMemo {
  return { routes: new Map(), reads: new Map() };
}

export type MoveObjectResult = {
  oldLocation: ObjRef | null;
  location: ObjRef;
};

export type WorldSnapshot = {
  server_time: number;
  actorCount: number;
  spaces: Record<string, { next_seq: number; log_count: number }>;
  catalogs: { installed: WooValue[] };
  object_routes: Array<{ id: ObjRef; host: string; anchor: ObjRef | null }>;
  objects: Record<string, unknown>;
};

export type ScopedObjectSummary = {
  id: ObjRef;
  name: string;
  parent?: ObjRef | null;
  ancestors: ObjRef[];
  features?: ObjRef[];
  owner?: ObjRef;
  location?: ObjRef | null;
  aliases?: string[];
  description?: WooValue | null;
  props?: Record<string, WooValue>;
  catalogState?: Record<string, Record<string, WooValue>>;
};

export type RoomSnapshot = {
  id: ObjRef;
  name: string;
  parent?: ObjRef | null;
  features?: ObjRef[];
  description?: WooValue | null;
  exits: Array<{
    id: ObjRef;
    name: string;
    aliases?: string[];
    direction?: string;
    dest?: ObjRef | null;
  }>;
  present_actors: ScopedObjectSummary[];
  contents: ScopedObjectSummary[];
  props?: Record<string, WooValue>;
};

export type OverlaySnapshot = {
  surface: string;
  subject: ObjRef;
  cursor: MeSnapshot["cursor"];
  room: RoomSnapshot | null;
  objects: ScopedObjectSummary[];
};

export type MeSnapshot = {
  server_time: number;
  cursor: {
    spaces: Record<ObjRef, { next_seq: number }>;
    live: { resumable: false };
  };
  self: ScopedObjectSummary;
  session: {
    id: string;
    actor: ObjRef;
    current_location: ObjRef | null;
    all_locations: ObjRef[];
  };
  here: RoomSnapshot | null;
  inventory: ScopedObjectSummary[];
  overlays?: Record<string, { subject: ObjRef; surface: string; restore?: boolean }>;
};

const DEFAULT_OBJECT_HOST = "world";

export type ParkedTaskRun = {
  task: ParkedTaskRecord;
  frame?: AppliedFrame | ErrorFrame;
  observations: Observation[];
  error?: ErrorValue;
};

export type DirectCallOptions = {
  forceDirect?: boolean;
  forceReason?: string;
  sessionId?: string | null;
  deferHostEffect?: (effect: DeferredHostEffect) => void;
  onSessionsEnded?: (sessions: Session[]) => void | Promise<void>;
};

type WooRepository = WorldRepository & Partial<ObjectRepository>;

type BehaviorSavepoint = {
  objects: Map<ObjRef, WooObject>;
  sessions: Map<string, Session>;
  snapshots: SpaceSnapshotRecord[];
  parkedTasks: Map<string, ParkedTaskRecord>;
  tombstones: Set<ObjRef>;
  objectCounter: number;
  parkedTaskCounter: number;
  sessionCounter: number;
  guestFreePool: Set<ObjRef>;
  persistence: PersistenceDirtyState;
};

type VerbEditorSession = {
  actor: ObjRef;
  target: ObjRef;
  kind: "verb";
  descriptor: WooValue;
  slot: number | null;
  expected_version: number | null;
  buffer: string;
  dirty: boolean;
  diagnostics: WooValue[];
  started_at: number;
  updated_at: number;
  previous_location: ObjRef | null;
  surface_class: ObjRef;
};

type PersistenceDirtyState = {
  dirtyObjects: Set<ObjRef>;
  deletedObjects: Set<ObjRef>;
  dirtyProperties: Map<ObjRef, Set<string>>;
  dirtySessions: Set<string>;
  deletedSessions: Set<string>;
  dirtyTasks: Set<string>;
  deletedTasks: Set<string>;
  dirtyTombstones: Set<ObjRef>;
  dirtyCounters: boolean;
  dirty: boolean;
};

const MAX_CALL_DEPTH = 128;

// WooWorld still carries both persistence shapes during the v0.5 transition:
// exportWorld/importWorld support bootstrap migration and JSON-folder dumps,
// while ObjectRepository is the runtime hot path after bootstrap.
function isObjectRepository(repository: WooRepository | undefined): repository is WooRepository & ObjectRepository {
  return (
    repository !== undefined &&
    typeof repository.saveObject === "function" &&
    typeof repository.appendLog === "function" &&
    typeof repository.transaction === "function" &&
    typeof repository.savepoint === "function"
  );
}

export class WooWorld {
  objects = new Map<ObjRef, WooObject>();
  sessions = new Map<string, Session>();
  logs = new Map<ObjRef, SpaceLogEntry[]>();
  snapshots: SpaceSnapshotRecord[] = [];
  parkedTasks = new Map<string, ParkedTaskRecord>();
  private nativeHandlers = new Map<string, NativeHandler>();
  private idempotency = new Map<string, { at: number; frame: AppliedFrame | ErrorFrame }>();
  private objectCounter = 1;
  private parkedTaskCounter = 1;
  private sessionCounter = 1;
  private persistencePaused = 0;
  // Defers whole-world fallback saves while grouped in-memory mutations settle.
  // ObjectRepository-backed worlds persist each touched slice directly.
  private persistenceDeferred = 0;
  private persistenceDirty = false;
  private dirtyObjects = new Set<ObjRef>();
  private deletedObjects = new Set<ObjRef>();
  private dirtyProperties = new Map<ObjRef, Set<string>>();
  private dirtySessions = new Set<string>();
  private deletedSessions = new Set<string>();
  private dirtyTasks = new Set<string>();
  private deletedTasks = new Set<string>();
  private dirtyTombstones = new Set<ObjRef>();
  private dirtyCounters = false;
  // Tombstoned ULIDs from `recycle()`. Distinct from `objects` having no row,
  // which can also mean "never existed". Per spec/semantics/recycle.md §RC3.9.
  tombstones = new Set<ObjRef>();
  // Invalidation token for externally visible state. It is bumped on every
  // path that could change `state(actor)` (object/property/session/task/counter
  // writes, deletes, accepted log rows). It may over-invalidate after rollback;
  // callers only depend on equality meaning "safe cache hit."
  private mutationCounter = 0;
  private callDepth = 0;
  private guestFreePool = new Set<ObjRef>();
  private objectRepository: ObjectRepository | null;
  private incrementalPersistenceEnabled = false;
  private hostBridge: HostBridge | null;
  // One host runs one behavior at a time. Awaited cross-host RPC must not let a
  // second local behavior mutate the same in-memory state mid-savepoint.
  private hostQueue: Promise<unknown> = Promise.resolve();
  // Diagnostic instrumentation for the host-task queue. `currentHostTask`
  // tracks the task that's actively executing (between start and done) so a
  // newly-enqueued task can log who it's blocked behind. `hostTaskQueueDepth`
  // is the count of tasks waiting for the current to settle.
  private hostTaskCounter = 0;
  private currentHostTask: { id: number; label: string; startedAt: number } | null = null;
  private hostTaskQueueDepth = 0;
  private metricsHook: ((event: MetricEvent) => void) | null = null;
  // O(1) presence lookup. `session_subscribers` is authoritative for live
  // sessions; `subscribers` remains a compatibility actor projection for
  // catalog state and older worlds. Built lazily; kept in sync from
  // setPropLocal so writes through the verb path stay coherent.
  private subscribersIndex = new Map<ObjRef, Set<ObjRef>>();
  private actorPresenceIndex = new Map<ObjRef, Set<ObjRef>>();
  private sessionSubscribersIndex = new Map<ObjRef, Map<string, ObjRef>>();
  private sessionSpacesIndex = new Map<string, Set<ObjRef>>();
  private presenceIndexBuilt = false;
  private lastSubscriberScrubAt = new Map<ObjRef, number>();

  constructor(private repository?: WooRepository, options: { hostBridge?: HostBridge | null } = {}) {
    this.objectRepository = isObjectRepository(repository) ? repository : null;
    this.hostBridge = options.hostBridge ?? null;
    this.registerNativeHandlers();
  }

  enableIncrementalPersistence(): void {
    if (!this.objectRepository) return;
    this.incrementalPersistenceEnabled = true;
    // Rehydrate tombstones from the persistence layer so dangling-ref
    // checks survive process restart. Per spec/reference/persistence.md
    // §14.2.1.
    for (const id of this.objectRepository.loadTombstones()) {
      this.tombstones.add(id);
    }
  }

  discardPendingPersistence(): void {
    this.dirtyObjects.clear();
    this.deletedObjects.clear();
    this.dirtyProperties.clear();
    this.dirtySessions.clear();
    this.deletedSessions.clear();
    this.dirtyTasks.clear();
    this.deletedTasks.clear();
    this.dirtyTombstones.clear();
    this.dirtyCounters = false;
    this.persistenceDirty = false;
  }

  hasPendingPersistence(): boolean {
    return this.persistenceDirty || this.hasDirtyPersistence();
  }

  markObjectChanged(objRef: ObjRef): void {
    const obj = this.object(objRef);
    obj.modified = Date.now();
    this.persistObject(objRef);
    this.persist();
  }

  setHostBridge(bridge: HostBridge | null): void {
    this.hostBridge = bridge;
  }

  // Install a metrics sink. Hosts pipe MetricEvent records to a structured log
  // (worker: `console.log("woo.metric", JSON.stringify(...))`) so tailing the
  // host gives ground-truth audience size, RPC cost, and broadcast fanout
  // without re-running the verb. Called by core at known hot points. No-op
  // when no hook is set.
  setMetricsHook(hook: ((event: MetricEvent) => void) | null): void {
    this.metricsHook = hook;
  }

  recordMetric(event: MetricEvent): void {
    const hook = this.metricsHook;
    if (!hook) return;
    try { hook(event); } catch { /* metrics must never throw */ }
  }

  /** Monotonically increasing state-cache invalidation token. Reset implicitly
   * on world recreation; not persisted. */
  mutationVersion(): number {
    return this.mutationCounter;
  }

  private bumpMutationVersion(): void {
    this.mutationCounter += 1;
  }

  // Read access for the MCP host (cross-host tool enumeration). Other callers
  // should use the typed APIs that wrap the bridge.
  getHostBridge(): HostBridge | null {
    return this.hostBridge;
  }

  // Register or replace a native verb handler. Used by the MCP host to wire
  // host-primitive verbs (`actor_wait`, `actor_focus`, etc.) to closures that
  // own their per-actor queue / focus-list state. The verbs themselves are
  // seeded by bootstrap with these handler names; this method just plugs in
  // the implementation.
  registerNativeHandler(name: string, handler: NativeHandler): void {
    this.nativeHandlers.set(name, handler);
  }

  async isRemoteObject(objRef: ObjRef, memo?: HostOperationMemo): Promise<boolean> {
    return (await this.remoteHostForObject(objRef, memo)) !== null;
  }

  private async remoteHostForObject(objRef: ObjRef, memo?: HostOperationMemo): Promise<string | null> {
    const host = await (this.hostBridge?.hostForObject(objRef, memo) ?? null);
    if (!host || host === this.hostBridge?.localHost) return null;
    return host;
  }

  createObject(input: {
    id: ObjRef;
    name?: string;
    parent: ObjRef | null;
    owner?: ObjRef;
    location?: ObjRef | null;
    anchor?: ObjRef | null;
    flags?: WooObject["flags"];
  }): WooObject {
    const existing = this.objects.get(input.id);
    if (existing) return existing;
    const now = Date.now();
    const obj: WooObject = {
      id: input.id,
      name: input.name ?? input.id,
      parent: input.parent,
      owner: input.owner ?? "$wiz",
      location: input.location ?? null,
      anchor: input.anchor ?? null,
      flags: input.flags ?? {},
      created: now,
      modified: now,
      propertyDefs: new Map(),
      properties: new Map(),
      propertyVersions: new Map(),
      verbs: [],
      children: new Set(),
      contents: new Set(),
      eventSchemas: new Map()
    };
    this.objects.set(obj.id, obj);
    if (obj.parent) this.objects.get(obj.parent)?.children.add(obj.id);
    if (obj.location) this.objects.get(obj.location)?.contents.add(obj.id);
    this.persistObject(obj.id);
    if (obj.parent) this.persistObject(obj.parent);
    if (obj.location) this.persistObject(obj.location);
    this.persist();
    return obj;
  }

  canAuthorObject(actor: ObjRef, objRef: ObjRef): boolean {
    const actorObj = this.object(actor);
    const target = this.object(objRef);
    return actorObj.flags.wizard === true || (actorObj.flags.programmer === true && target.owner === actor);
  }

  assertCanAuthorObject(actor: ObjRef, objRef: ObjRef): void {
    if (this.canAuthorObject(actor, objRef)) return;
    throw wooError("E_PERM", `${actor} cannot author ${objRef}`, { actor, obj: objRef });
  }

  object(id: ObjRef): WooObject {
    const obj = this.objects.get(id);
    if (!obj) throw wooError("E_OBJNF", `object not found: ${id}`, id);
    return obj;
  }

  /**
   * Synchronous local tombstone lookup. Use isRecycledChecked for the
   * host-transparent version. Returns true for ULIDs tombstoned on this
   * host; for ULIDs owned by a remote host, this returns the local view
   * only (which may be false even if the remote has tombstoned the id).
   */
  isRecycled(id: ObjRef): boolean {
    return this.tombstones.has(id);
  }

  /**
   * Host-transparent tombstone probe. Per spec/semantics/recycle.md §RC5
   * and spec/reference/persistence.md §14.2.1, tombstones live on the
   * owning host. For an id owned by another host, ask the bridge; for a
   * local id, consult the local set.
   *
   * Returns false (rather than raising) for a never-existed id: the
   * is_recycled() builtin distinguishes "recycled" from "never existed",
   * so callers expect false in the never-existed case.
   */
  async isRecycledChecked(id: ObjRef, memo?: HostOperationMemo): Promise<boolean> {
    if (this.tombstones.has(id)) return true;
    const remoteHost = await this.remoteHostForObject(id, memo);
    if (remoteHost && this.hostBridge?.isRecycled) {
      try {
        return await this.hostBridge.isRecycled(id, memo);
      } catch {
        // Best-effort: if the remote host is unreachable, fall back to
        // the local answer (false). The caller can re-probe.
        return false;
      }
    }
    return false;
  }

  /**
   * Sweep $system's own properties for any value pointing at a tombstoned
   * ULID, and clear it (set to null). Returns the list of property names
   * whose value was cleared.
   *
   * Per spec/semantics/recycle.md §RC3 step 10 ("forget the corename
   * binding") and §RC5 (dangling-ref janitor). In the single-host backend,
   * a "corename" is just an ordinary property on $system whose value is
   * an ULID (e.g., `$system.help_dbs` holding `[$help_db_main]`). When
   * the CF backend lands its separate Directory DO, this reconciliation
   * runs against the Directory's `corename` table per
   * spec/reference/persistence.md §14.2.
   *
   * Walks scalar, list, and map values: a scalar tombstoned ref becomes
   * null; list elements that point at tombstones are removed; map entries
   * whose value is tombstoned are removed (keys are not interpreted as
   * ULIDs). Names of properties whose value structure changed are
   * returned, sorted.
   *
   * Idempotent: safe to call multiple times; never-tombstoned and missing
   * values are no-ops.
   */
  reconcileTombstoneRefsInSystem(): string[] {
    const cleared = new Set<string>();
    const sys = this.objects.get("$system");
    if (!sys) return [];
    for (const [name, value] of sys.properties) {
      const next = this.scrubTombstoneRefs(value);
      if (!valuesEqual(value, next)) {
        cleared.add(name);
        this.setProp("$system", name, next);
      }
    }
    return Array.from(cleared).sort();
  }

  /**
   * Recursively rewrite a value, replacing scalar tombstoned ULID
   * references with null and pruning them from list/map containers.
   * Returns the value unchanged if no rewrite was needed.
   */
  private scrubTombstoneRefs(value: WooValue): WooValue {
    if (typeof value === "string") {
      return this.tombstones.has(value) ? null : value;
    }
    if (Array.isArray(value)) {
      const out: WooValue[] = [];
      let changed = false;
      for (const entry of value) {
        if (typeof entry === "string" && this.tombstones.has(entry)) {
          changed = true;
          continue;
        }
        const next = this.scrubTombstoneRefs(entry);
        if (!valuesEqual(entry, next)) changed = true;
        out.push(next);
      }
      return changed ? out as WooValue : value;
    }
    if (value && typeof value === "object") {
      const src = value as Record<string, WooValue>;
      const out: Record<string, WooValue> = {};
      let changed = false;
      for (const [key, entry] of Object.entries(src)) {
        if (typeof entry === "string" && this.tombstones.has(entry)) {
          changed = true;
          continue;
        }
        const next = this.scrubTombstoneRefs(entry);
        if (!valuesEqual(entry, next)) changed = true;
        out[key] = next;
      }
      return changed ? out as WooValue : value;
    }
    return value;
  }

  defineProperty(obj: ObjRef, def: Omit<PropertyDef, "version"> & { version?: number }): PropertyDef {
    this.assertOrdinaryPropertyName(def.name);
    const target = this.object(obj);
    const property: PropertyDef = { ...def, version: def.version ?? 1 };
    target.propertyDefs.set(property.name, property);
    if (!target.properties.has(property.name)) {
      target.properties.set(property.name, cloneValue(property.defaultValue));
      target.propertyVersions.set(property.name, 1);
      // Catalog migrations that add presence properties with a
      // non-empty default would otherwise bypass setPropLocal. Invalidate
      // rather than incrementally updating.
      if (property.name === "subscribers" || property.name === "session_subscribers") {
        this.invalidatePresenceIndex();
      }
    }
    this.persistObject(obj);
    this.persist();
    return property;
  }

  setProp(objRef: ObjRef, name: string, value: WooValue): void {
    this.setPropLocal(objRef, name, value);
    this.persistProperty(objRef, name);
    this.persist();
  }

  private setPropLocal(objRef: ObjRef, name: string, value: WooValue): void {
    this.assertOrdinaryPropertyName(name);
    const obj = this.object(objRef);
    obj.properties.set(name, cloneValue(value));
    obj.propertyVersions.set(name, (obj.propertyVersions.get(name) ?? 0) + 1);
    obj.modified = Date.now();
    if (name === "subscribers" || name === "session_subscribers") {
      this.invalidatePresenceIndex();
    }
  }

  // Drop the in-memory presence index. The next read rebuilds it. Call
  // sites that mutate presence-related properties use this to avoid drift.
  // This intentionally invalidates instead of incrementally editing one
  // relation: live presence comes from `session_subscribers`, while
  // compatibility reads still consult `subscribers`.
  invalidatePresenceIndex(): void {
    this.presenceIndexBuilt = false;
    this.subscribersIndex.clear();
    this.actorPresenceIndex.clear();
    this.sessionSubscribersIndex.clear();
    this.sessionSpacesIndex.clear();
  }

  private ensurePresenceIndex(): void {
    if (this.presenceIndexBuilt) return;
    this.subscribersIndex.clear();
    this.actorPresenceIndex.clear();
    this.sessionSubscribersIndex.clear();
    this.sessionSpacesIndex.clear();
    for (const obj of this.objects.values()) {
      const sessionSubs = obj.properties.get("session_subscribers");
      if (Array.isArray(sessionSubs)) {
        for (const entry of sessionSubs) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
          const map = entry as Record<string, WooValue>;
          if (typeof map.session !== "string" || typeof map.actor !== "string") continue;
          this.indexSessionSubscriber(obj.id, map.session, map.actor);
        }
      }
      const subs = obj.properties.get("subscribers");
      if (Array.isArray(subs)) {
        const ids = subs.filter((item): item is ObjRef => typeof item === "string");
        if (ids.length > 0) {
          this.subscribersIndex.set(obj.id, new Set(ids));
          for (const actor of ids) {
            let spaces = this.actorPresenceIndex.get(actor);
            if (!spaces) { spaces = new Set(); this.actorPresenceIndex.set(actor, spaces); }
            spaces.add(obj.id);
          }
        }
      }
    }
    this.presenceIndexBuilt = true;
  }

  private indexSessionSubscriber(space: ObjRef, sessionId: string, actor: ObjRef): void {
    let sessions = this.sessionSubscribersIndex.get(space);
    if (!sessions) { sessions = new Map(); this.sessionSubscribersIndex.set(space, sessions); }
    sessions.set(sessionId, actor);
    let spaces = this.sessionSpacesIndex.get(sessionId);
    if (!spaces) { spaces = new Set(); this.sessionSpacesIndex.set(sessionId, spaces); }
    spaces.add(space);
  }

  deleteProp(objRef: ObjRef, name: string): boolean {
    this.assertOrdinaryPropertyName(name);
    const obj = this.object(objRef);
    const hadDef = obj.propertyDefs.delete(name);
    const hadValue = obj.properties.delete(name);
    const hadVersion = obj.propertyVersions.delete(name);
    const hadProperty = hadDef || hadValue || hadVersion;
    if (!hadProperty) return false;
    obj.modified = Date.now();
    this.deletePersistedProperty(objRef, name);
    if (name === "subscribers" || name === "session_subscribers") {
      this.invalidatePresenceIndex();
    }
    this.persist();
    return true;
  }

  private assertOrdinaryPropertyName(name: string): void {
    if (name === "owner") {
      throw wooError("E_PERM", "owner is a read-only core field", { property: name });
    }
  }

  getProp(objRef: ObjRef, name: string): WooValue {
    const obj = this.object(objRef);
    if (name === "owner") return obj.owner;
    if (obj.properties.has(name)) return cloneValue(obj.properties.get(name)!);
    let parent = obj.parent;
    while (parent) {
      const ancestor = this.object(parent);
      const def = ancestor.propertyDefs.get(name);
      if (def) return cloneValue(def.defaultValue);
      parent = ancestor.parent;
    }
    throw wooError("E_PROPNF", `property not found: ${name}`, name);
  }

  addVerb(objRef: ObjRef, verb: VerbDef, options: { append?: boolean; slot?: number } = {}): VerbDef {
    const obj = this.object(objRef);
    const parsedPerms = normalizeVerbPerms(verb.perms, verb.direct_callable === true);
    const index =
      options.slot !== undefined
        ? options.slot - 1
        : options.append === true
          ? -1
          : this.findOwnVerbIndex(obj, verb.name);
    const normalized = { ...verb, perms: parsedPerms.perms, direct_callable: parsedPerms.directCallable };
    const writtenIndex = index >= 0 && index < obj.verbs.length ? index : obj.verbs.length;
    if (index >= 0 && index < obj.verbs.length) {
      obj.verbs[index] = this.withVerbSlot(normalized, index);
    } else {
      obj.verbs.push(this.withVerbSlot(normalized, obj.verbs.length));
    }
    this.reindexVerbs(obj);
    this.persistObject(objRef);
    this.persist();
    return obj.verbs[writtenIndex];
  }

  removeVerb(objRef: ObjRef, name: string): boolean {
    const obj = this.object(objRef);
    const before = obj.verbs.length;
    obj.verbs = obj.verbs.filter((verb) => verb.name !== name);
    if (obj.verbs.length === before) return false;
    this.reindexVerbs(obj);
    this.persistObject(objRef);
    this.persist();
    return true;
  }

  setObjectName(objRef: ObjRef, name: string): void {
    // Keep both name surfaces in sync: WooObject.name (SerializedObject /
    // ScopedObjectSummary) and the inherited "name" property (woocode
    // `this.name`). Different consumers read different surfaces.
    const obj = this.object(objRef);
    obj.name = name;
    obj.modified = Date.now();
    this.persistObject(objRef);
    this.setProp(objRef, "name", name);
  }

  ownVerb(objRef: ObjRef, name: string): VerbDef | null {
    return this.ownVerbNamed(objRef, name);
  }

  ownVerbExact(objRef: ObjRef, name: string): VerbDef | null {
    return this.object(objRef).verbs.find((verb) => verb.name === name) ?? null;
  }

  private findOwnVerbIndex(obj: WooObject, name: string): number {
    return obj.verbs.findIndex((verb) => verb.name === name);
  }

  private withVerbSlot(verb: VerbDef, index: number): VerbDef {
    return { ...verb, slot: index + 1 } as VerbDef;
  }

  private reindexVerbs(obj: WooObject): void {
    obj.verbs = obj.verbs.map((verb, index) => this.withVerbSlot(verb, index));
    obj.modified = Date.now();
  }

  defineEventSchema(objRef: ObjRef, type: string, shape: Record<string, WooValue>): void {
    const obj = this.object(objRef);
    obj.eventSchemas.set(type, cloneValue(shape as WooValue) as Record<string, WooValue>);
    obj.modified = Date.now();
    this.persistObject(objRef);
    this.persist();
  }

  resolveVerb(objRef: ObjRef, name: string): ResolvedVerb {
    const parentMatch = this.resolveVerbFrom(objRef, name, false);
    if (parentMatch) return parentMatch;
    if (this.canCarryFeatures(objRef)) {
      const features = this.featureList(objRef);
      for (const feature of features) {
        const featureMatch = this.resolveVerbFrom(feature, name, false);
        if (featureMatch) return featureMatch;
      }
    }
    throw wooError("E_VERBNF", `verb not found: ${objRef}:${name}`, { obj: objRef, name });
  }

  resolveVerbFrom(startRef: ObjRef | null, name: string): ResolvedVerb;
  resolveVerbFrom(startRef: ObjRef | null, name: string, required: false): ResolvedVerb | null;
  resolveVerbFrom(startRef: ObjRef | null, name: string, required = true): ResolvedVerb | null {
    let current: ObjRef | null = startRef;
    while (current) {
      const obj = this.object(current);
      const verb = this.ownVerbNamed(current, name);
      if (verb) return { definer: current, verb };
      current = obj.parent;
    }
    if (!required) return null;
    throw wooError("E_VERBNF", `verb not found: ${startRef ?? "#-1"}:${name}`, { obj: startRef ?? "#-1", name });
  }

  describe(objRef: ObjRef): Record<string, WooValue> {
    const obj = this.object(objRef);
    return {
      id: obj.id,
      name: obj.name,
      description: this.propOrNull(objRef, "description"),
      parent: obj.parent,
      owner: obj.owner,
      location: obj.location,
      anchor: obj.anchor,
      flags: {
        wizard: Boolean(obj.flags.wizard),
        programmer: Boolean(obj.flags.programmer),
        fertile: Boolean(obj.flags.fertile)
      },
      modified: obj.modified,
      children_count: obj.children.size,
      contents_count: obj.contents.size,
      properties: this.properties(objRef),
      verbs: this.verbs(objRef),
      schemas: this.schemas(objRef),
      children: Array.from(obj.children),
      contents: Array.from(obj.contents)
    };
  }

  describeForActor(objRef: ObjRef, actor: ObjRef): Record<string, WooValue> {
    const description = this.propOrNullForActor(actor, objRef, "description");
    return {
      ...this.describe(objRef),
      description
    };
  }

  properties(objRef: ObjRef): WooValue[] {
    const names = new Set<string>();
    let current: ObjRef | null = objRef;
    while (current) {
      const obj = this.object(current);
      for (const name of obj.propertyDefs.keys()) names.add(name);
      for (const name of obj.properties.keys()) names.add(name);
      current = obj.parent;
    }
    return Array.from(names).sort();
  }

  getPropForActor(actor: ObjRef, objRef: ObjRef, name: string): WooValue {
    if (!this.canReadProperty(actor, objRef, name)) throw wooError("E_PERM", `${actor} cannot read ${objRef}.${name}`, { actor, obj: objRef, property: name });
    return this.getProp(objRef, name);
  }

  canReadProperty(actor: ObjRef, objRef: ObjRef, name: string): boolean {
    const info = this.propertyInfo(objRef, name);
    return this.canBypassPerms(actor) || info.owner === actor || String(info.perms).includes("r");
  }

  canWriteProperty(progr: ObjRef, objRef: ObjRef, name: string): boolean {
    const info = this.propertyInfo(objRef, name);
    return this.canBypassPerms(progr) || info.owner === progr || String(info.perms).includes("w");
  }

  async getPropChecked(progr: ObjRef, objRef: ObjRef, name: string, memo?: HostOperationMemo): Promise<WooValue> {
    if (await this.remoteHostForObject(objRef, memo)) {
      if (!this.hostBridge) throw wooError("E_INTERNAL", "remote host bridge unavailable");
      return await this.hostBridge.getPropChecked(progr, objRef, name, memo);
    }
    if (!this.canReadProperty(progr, objRef, name)) {
      throw wooError("E_PERM", `${progr} cannot read ${objRef}.${name}`, { progr, obj: objRef, property: name });
    }
    return this.getProp(objRef, name);
  }

  async collectPropChecked(progr: ObjRef, objRefs: ObjRef[], name: string, memo?: HostOperationMemo, options: { parallel?: boolean } = {}): Promise<WooValue[]> {
    if (options.parallel === false) {
      const values: WooValue[] = [];
      for (const objRef of objRefs) values.push(await this.getPropChecked(progr, objRef, name, memo));
      return values;
    }
    return await Promise.all(objRefs.map((objRef) => this.getPropChecked(progr, objRef, name, memo)));
  }

  async setPropChecked(progr: ObjRef, objRef: ObjRef, name: string, value: WooValue, memo?: HostOperationMemo): Promise<void> {
    if (await this.remoteHostForObject(objRef, memo)) {
      if (!this.hostBridge) throw wooError("E_INTERNAL", "remote host bridge unavailable");
      await this.hostBridge.setPropChecked(progr, objRef, name, value, memo);
      return;
    }
    try {
      if (!this.canWriteProperty(progr, objRef, name)) {
        throw wooError("E_PERM", `${progr} cannot write ${objRef}.${name}`, { progr, obj: objRef, property: name });
      }
    } catch (err) {
      if (!isErrorValue(err) || err.code !== "E_PROPNF") throw err;
      const obj = this.object(objRef);
      if (!this.canBypassPerms(progr) && obj.owner !== progr) {
        throw wooError("E_PERM", `${progr} cannot create ${objRef}.${name}`, { progr, obj: objRef, property: name });
      }
    }
    this.setProp(objRef, name, value);
  }

  async definePropertyChecked(progr: ObjRef, objRef: ObjRef, def: Omit<PropertyDef, "version"> & { version?: number }): Promise<PropertyDef> {
    this.assertOrdinaryPropertyName(def.name);
    if (await this.remoteHostForObject(objRef)) {
      throw wooError("E_CROSS_HOST_WRITE", `cross-host property definitions are not atomic: ${objRef}.${def.name}`, { progr, obj: objRef, property: def.name });
    }
    const obj = this.object(objRef);
    const wizard = this.canBypassPerms(progr);
    if (!wizard && obj.owner !== progr) {
      throw wooError("E_PERM", `${progr} cannot define properties on ${objRef}`, { progr, obj: objRef, property: def.name });
    }
    if (!wizard && def.owner !== progr) {
      throw wooError("E_PERM", `${progr} cannot create property ${objRef}.${def.name} owned by ${def.owner}`, { progr, obj: objRef, property: def.name, owner: def.owner });
    }
    try {
      this.propertyInfo(objRef, def.name);
      throw wooError("E_INVARG", `property already exists: ${objRef}.${def.name}`, { obj: objRef, property: def.name });
    } catch (err) {
      if (!isErrorValue(err) || err.code !== "E_PROPNF") throw err;
    }
    return this.defineProperty(objRef, def);
  }

  async undefinePropertyChecked(progr: ObjRef, objRef: ObjRef, name: string): Promise<void> {
    if (await this.remoteHostForObject(objRef)) {
      throw wooError("E_CROSS_HOST_WRITE", `cross-host property definitions are not atomic: ${objRef}.${name}`, { progr, obj: objRef, property: name });
    }
    const obj = this.object(objRef);
    const def = obj.propertyDefs.get(name);
    if (!def) throw wooError("E_PROPNF", `property not defined on ${objRef}: ${name}`, { obj: objRef, property: name });
    if (!this.canBypassPerms(progr) && obj.owner !== progr && def.owner !== progr) {
      throw wooError("E_PERM", `${progr} cannot undefine ${objRef}.${name}`, { progr, obj: objRef, property: name });
    }
    obj.propertyDefs.delete(name);
    obj.properties.delete(name);
    obj.propertyVersions.delete(name);
    obj.modified = Date.now();
    this.persistObject(objRef);
    this.persist();
  }

  async setPropertyInfoChecked(progr: ObjRef, objRef: ObjRef, name: string, info: Record<string, WooValue>): Promise<void> {
    this.assertOrdinaryPropertyName(name);
    if (await this.remoteHostForObject(objRef)) {
      throw wooError("E_CROSS_HOST_WRITE", `cross-host property metadata writes are not atomic: ${objRef}.${name}`, { progr, obj: objRef, property: name });
    }
    const currentInfo = this.propertyInfo(objRef, name);
    const definedOn = assertObj(currentInfo.defined_on);
    const obj = this.object(definedOn);
    const def = obj.propertyDefs.get(name);
    if (!def) throw wooError("E_PROPNF", `property not found: ${name}`, name);

    const wizard = this.canBypassPerms(progr);
    const owner = def.owner === progr;
    const wantsOwner = typeof info.owner === "string" && info.owner !== def.owner;
    const wantsPerms = typeof info.perms === "string" && info.perms !== def.perms;
    const wantsType = typeof info.type_hint === "string" && info.type_hint !== (def.typeHint ?? null);
    if ((wantsPerms || wantsType) && !wizard && !owner) {
      throw wooError("E_PERM", `${progr} cannot change metadata for ${definedOn}.${name}`, { progr, obj: definedOn, property: name });
    }
    if (wantsOwner && !wizard && !owner && !def.perms.includes("c")) {
      throw wooError("E_PERM", `${progr} cannot change owner for ${definedOn}.${name}`, { progr, obj: definedOn, property: name });
    }
    if (typeof info.owner === "string") {
      this.object(info.owner);
      def.owner = info.owner;
    }
    if (typeof info.perms === "string") def.perms = info.perms;
    if (typeof info.type_hint === "string") def.typeHint = info.type_hint;
    def.version += 1;
    obj.modified = Date.now();
    this.persistObject(definedOn);
    this.persist();
  }

  propOrNullForActor(actor: ObjRef, objRef: ObjRef, name: string): WooValue {
    try {
      return this.getPropForActor(actor, objRef, name);
    } catch {
      return null;
    }
  }

  propOrNull(objRef: ObjRef, name: string): WooValue {
    try {
      return this.getProp(objRef, name);
    } catch {
      return null;
    }
  }

  verbs(objRef: ObjRef): WooValue[] {
    const names = new Set<string>();
    this.collectVerbNames(objRef, names);
    if (this.canCarryFeatures(objRef)) {
      for (const feature of this.featureList(objRef)) this.collectVerbNames(feature, names);
    }
    return Array.from(names).sort();
  }

  schemas(objRef: ObjRef): WooValue[] {
    const names = new Set<string>();
    this.collectSchemaNames(objRef, names);
    if (this.canCarryFeatures(objRef)) {
      for (const feature of this.featureList(objRef)) this.collectSchemaNames(feature, names);
    }
    return Array.from(names).sort();
  }

  verbInfo(objRef: ObjRef, name: string): Record<string, WooValue> {
    const { definer, verb } = this.resolveVerb(objRef, name);
    const base: Record<string, WooValue> = {
      name: verb.name,
      slot: verb.slot ?? 0,
      aliases: verb.aliases,
      definer,
      owner: verb.owner,
      perms: verb.perms,
      arg_spec: verb.arg_spec,
      version: verb.version,
      direct_callable: verb.direct_callable === true,
      tool_exposed: verb.tool_exposed === true,
      readable: verb.perms.includes("r")
    };
    if (verb.perms.includes("r")) {
      base.source = verb.source;
      base.source_hash = verb.source_hash;
      base.line_map = verb.line_map;
      if (verb.kind === "bytecode") base.bytecode_version = verb.bytecode.version;
    }
    return base;
  }

  propertyInfo(objRef: ObjRef, name: string): Record<string, WooValue> {
    if (name === "owner") {
      const obj = this.object(objRef);
      return {
        name,
        owner: obj.owner,
        perms: "r",
        defined_on: objRef,
        type_hint: "obj",
        version: 1,
        has_value: true
      };
    }
    let current: ObjRef | null = objRef;
    while (current) {
      const obj = this.object(current);
      const def = obj.propertyDefs.get(name);
      if (def) {
        return {
          name,
          owner: def.owner,
          perms: def.perms,
          defined_on: current,
          type_hint: def.typeHint ?? null,
          version: def.version,
          has_value: this.object(objRef).properties.has(name)
        };
      }
      current = obj.parent;
    }
    const target = this.object(objRef);
    if (target.properties.has(name)) {
      return {
        name,
        owner: target.owner,
        perms: "r",
        defined_on: objRef,
        type_hint: null,
        version: target.propertyVersions.get(name) ?? 1,
        has_value: true
      };
    }
    throw wooError("E_PROPNF", `property not found: ${name}`, name);
  }

  canExecuteVerb(progr: ObjRef, verb: VerbDef): boolean {
    return verb.perms.includes("x") || verb.owner === progr || this.canBypassPerms(progr);
  }

  assertCanExecuteVerb(progr: ObjRef, target: ObjRef, name: string, verb: VerbDef): void {
    if (this.canExecuteVerb(progr, verb)) return;
    throw wooError("E_PERM", `${progr} cannot execute ${target}:${name}`, { progr, target, verb: name, owner: verb.owner, perms: verb.perms });
  }

  auth(token: string): Session {
    this.reapExpiredSessions();
    if (token.startsWith("session:")) {
      const session = this.sessions.get(token.slice("session:".length));
      if (!session) throw wooError("E_NOSESSION", "session token is expired or unknown");
      if (this.sessionExpired(session, Date.now())) {
        this.reapSession(session.id);
        this.persist(true);
        throw wooError("E_NOSESSION", "session token is expired or unknown");
      }
      return session;
    }
    if (token.startsWith("apikey:")) {
      return this.authApiKey(token.slice("apikey:".length));
    }
    const tokenClass = this.tokenClassFor(token);
    const actor = this.allocateGuest();
    this.placeAllocatedGuest(actor);
    return this.createSessionForActor(actor, tokenClass);
  }

  // Move a freshly-allocated guest into the room named by `$system.guest_initial_room`,
  // if one is configured and the guest is currently sitting at $nowhere. The
  // property is catalog-set; core stays catalog-agnostic and falls through
  // silently when it is unset.
  private placeAllocatedGuest(actor: ObjRef): void {
    const obj = this.objects.get(actor);
    if (!obj) return;
    if (obj.location && obj.location !== "$nowhere") return;
    const configured = this.propOrNull("$system", "guest_initial_room");
    if (typeof configured !== "string" || !configured) return;
    if (configured === actor) return;
    if (!this.objects.has(configured)) return;
    this.moveObject(actor, configured);
  }

  private authApiKey(payload: string): Session {
    const colon = payload.indexOf(":");
    if (colon < 0) throw wooError("E_NOSESSION", "apikey token must be apikey:<id>:<secret>");
    const id = payload.slice(0, colon);
    const secret = payload.slice(colon + 1);
    if (!id || !secret) throw wooError("E_NOSESSION", "apikey token must be apikey:<id>:<secret>");
    const keys = this.propOrNull("$system", "api_keys");
    const record = keys && typeof keys === "object" && !Array.isArray(keys)
      ? (keys as Record<string, WooValue>)[id]
      : null;
    if (!record || typeof record !== "object" || Array.isArray(record)) throw wooError("E_NOSESSION", "apikey not found or revoked");
    const r = record as Record<string, WooValue>;
    const salt = String(r.salt ?? "");
    const expected = String(r.hash ?? "");
    const actor = String(r.actor ?? "");
    if (!salt || !expected || !actor) throw wooError("E_NOSESSION", "apikey record is malformed");
    // Soft-deleted records remain in the map (for audit + observability) but
    // reject all further authentications.
    if (r.revoked_at != null) throw wooError("E_NOSESSION", "apikey not found or revoked");
    if (!this.objects.has(actor)) throw wooError("E_NOSESSION", "apikey target actor no longer exists");
    const presented = hashSource(`${salt}:${secret}`);
    if (!constantTimeEqual(presented, expected)) throw wooError("E_NOSESSION", "apikey secret rejected");
    // Record liveness so :look on a block can render "plug last seen Ns ago"
    // without needing extra state. last_seen_at is per-key, not per-session;
    // a key with N concurrent sessions still gets one timestamp.
    this.touchApiKeyLastSeen(id);
    return this.createSessionForActor(actor, "apikey", id);
  }

  /** Wizard-only: mint an apikey bound to any $actor descendant. */
  createApiKey(actor: ObjRef, target: ObjRef, label: string | null): { id: string; secret: string; actor: ObjRef; label: string | null; created_at: number } {
    if (!this.canBypassPerms(actor)) throw wooError("E_PERM", "wizard authority required to create api keys", { actor });
    if (!this.objects.has(target)) throw wooError("E_OBJNF", `target actor not found: ${target}`, target);
    if (!this.inheritsFrom(target, "$actor")) throw wooError("E_TYPE", `target must be an $actor descendant: ${target}`, target);
    return this.createApiKeyRecord(actor, target, label, "create_api_key");
  }

  /** Owner-mint: the owner of `target` may mint an apikey bound to `target`.
   * This is the path catalog code (e.g. `$block:mint_apikey`) uses so blocks
   * can be configured by their creator without wizard escalation. */
  createApiKeyForOwner(actor: ObjRef, target: ObjRef, label: string | null): { id: string; secret: string; actor: ObjRef; label: string | null; created_at: number } {
    if (!this.objects.has(target)) throw wooError("E_OBJNF", `target actor not found: ${target}`, target);
    if (!this.inheritsFrom(target, "$actor")) throw wooError("E_TYPE", `target must be an $actor descendant: ${target}`, target);
    if (!this.canBypassPerms(actor) && this.object(target).owner !== actor) {
      throw wooError("E_PERM", "owner-mint requires the calling actor to own the target", { actor, target });
    }
    return this.createApiKeyRecord(actor, target, label, "create_api_key_for_owner");
  }

  private createApiKeyRecord(actor: ObjRef, target: ObjRef, label: string | null, auditAction: string): { id: string; secret: string; actor: ObjRef; label: string | null; created_at: number } {
    const id = randomHex(16);
    const secret = randomHex(32);
    const salt = randomHex(16);
    const hash = hashSource(`${salt}:${secret}`);
    const created_at = Date.now();
    const raw = this.propOrNull("$system", "api_keys");
    const map = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, WooValue>) } : {};
    map[id] = { hash, salt, actor: target, label: label ?? null, created_at } as WooValue;
    this.setProp("$system", "api_keys", map as WooValue);
    this.recordWizardAction(actor, auditAction, { actor: target, key_id: id, label: label ?? null });
    return { id, secret, actor: target, label, created_at };
  }

  private touchApiKeyLastSeen(id: string): void {
    const raw = this.propOrNull("$system", "api_keys");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const map = raw as Record<string, WooValue>;
    const rec = map[id];
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return;
    const updated = { ...(rec as Record<string, WooValue>), last_seen_at: Date.now() };
    this.setProp("$system", "api_keys", { ...map, [id]: updated as WooValue });
  }

  /** Mark an apikey revoked and tear down any sessions minted from it.
   * Keeps the record (with revoked_at) for audit. Authorized for wizards
   * unconditionally and for the owner of the bound actor (so the same actor
   * who could mint can also revoke). */
  revokeApiKey(actor: ObjRef, id: string): boolean {
    return this.revokeApiKeyWithClosedSessions(actor, id).revoked;
  }

  private revokeApiKeyWithClosedSessions(actor: ObjRef, id: string): { revoked: boolean; closedSessions: Session[] } {
    const raw = this.propOrNull("$system", "api_keys");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { revoked: false, closedSessions: [] };
    const map = raw as Record<string, WooValue>;
    const rec = map[id];
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { revoked: false, closedSessions: [] };
    const r = rec as Record<string, WooValue>;
    const targetActor = String(r.actor ?? "");
    const isWizard = this.canBypassPerms(actor);
    const isOwner = targetActor && this.objects.has(targetActor) && this.object(targetActor).owner === actor;
    if (!isWizard && !isOwner) {
      throw wooError("E_PERM", "revoke requires wizard authority or ownership of the bound actor", { actor, key_id: id });
    }
    return this.revokeApiKeyRecord(actor, id, map, r, targetActor);
  }

  private revokeApiKeyRecord(actor: ObjRef, id: string, map: Record<string, WooValue>, record: Record<string, WooValue>, targetActor: ObjRef): { revoked: boolean; closedSessions: Session[] } {
    if (record.revoked_at != null) return { revoked: false, closedSessions: [] }; // already revoked — caller can disambiguate via listApiKeys
    const updated = { ...record, revoked_at: Date.now() };
    this.setProp("$system", "api_keys", { ...map, [id]: updated as WooValue });
    const closedSessions = this.closeSessionsForApiKey(id);
    this.recordWizardAction(actor, "revoke_api_key", { key_id: id, actor: targetActor });
    return { revoked: true, closedSessions };
  }

  /** Walk the in-memory session table and reap any whose apikeyId matches.
   * Returns the sessions closed. Live transports (WS, MCP) discover
   * via their session-resume path that the session no longer exists and
   * disconnect on the next op. */
  private closeSessionsForApiKey(id: string): Session[] {
    const matches: Session[] = [];
    for (const session of this.sessions.values()) {
      if (session.apikeyId === id) matches.push({ ...session, attachedSockets: new Set(session.attachedSockets) });
    }
    for (const session of matches) this.reapSession(session.id);
    if (matches.length > 0) this.persist(true);
    return matches;
  }

  /** Wizard-only: list every apikey record's metadata. */
  listApiKeys(actor: ObjRef): Array<{ id: string; actor: ObjRef; label: string | null; created_at: number; last_seen_at: number | null; revoked_at: number | null }> {
    if (!this.canBypassPerms(actor)) throw wooError("E_PERM", "wizard authority required to list api keys", { actor });
    return this.collectApiKeyMetadata();
  }

  /** Owner-scoped: list apikeys for actors the caller owns. Useful for
   * `$block:list_apikeys` so a block's owner can audit "is my plug
   * connected and which key did it use?" without wizard authority. */
  listApiKeysForOwner(actor: ObjRef): Array<{ id: string; actor: ObjRef; label: string | null; created_at: number; last_seen_at: number | null; revoked_at: number | null }> {
    if (this.canBypassPerms(actor)) return this.collectApiKeyMetadata();
    return this.collectApiKeyMetadata().filter((entry) => {
      if (!entry.actor || !this.objects.has(entry.actor)) return false;
      return this.object(entry.actor).owner === actor;
    });
  }

  private collectApiKeyMetadata(): Array<{ id: string; actor: ObjRef; label: string | null; created_at: number; last_seen_at: number | null; revoked_at: number | null }> {
    const raw = this.propOrNull("$system", "api_keys");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const out: Array<{ id: string; actor: ObjRef; label: string | null; created_at: number; last_seen_at: number | null; revoked_at: number | null }> = [];
    for (const [id, rec] of Object.entries(raw as Record<string, WooValue>)) {
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
      const r = rec as Record<string, WooValue>;
      out.push({
        id,
        actor: String(r.actor ?? ""),
        label: typeof r.label === "string" ? r.label : null,
        created_at: Number(r.created_at ?? 0),
        last_seen_at: r.last_seen_at == null ? null : Number(r.last_seen_at),
        revoked_at: r.revoked_at == null ? null : Number(r.revoked_at)
      });
    }
    return out;
  }

  createSessionForActor(actor: ObjRef, tokenClass: Session["tokenClass"] = "bearer", apikeyId?: string): Session {
    this.reapExpiredSessions();
    this.object(actor);
    const id = this.generateSessionId();
    const now = Date.now();
    const session: Session = {
      id,
      actor,
      started: now,
      expiresAt: now + this.sessionTtl(tokenClass),
      lastDetachAt: null,
      tokenClass,
      currentLocation: this.initialSessionLocation(actor),
      attachedSockets: new Set(),
      lastInputAt: now,
      ...(apikeyId !== undefined ? { apikeyId } : {})
    };
    this.withPersistenceDeferred(() => {
      this.sessions.set(id, session);
      this.persistSession(session);
      // No reader (substrate or catalog) consults `actor.session_id` —
      // `world.sessions` is the source of truth for session lifecycle. The
      // formerly-written mirror property fired on every (actor × host)
      // first-touch and was a top-3 ambient writer.
    });
    return session;
  }

  private generateSessionId(): string {
    for (let attempts = 0; attempts < 8; attempts += 1) {
      const id = `session-${randomHex(16)}`;
      if (!this.sessions.has(id)) return id;
    }
    throw wooError("E_INTERNAL", "could not mint a unique session id");
  }

  ensureSessionForActor(
    id: string,
    actor: ObjRef,
    tokenClass: Session["tokenClass"] = "bearer",
    expiresAt?: number,
    currentLocation?: ObjRef | null,
    apikeyId?: string
  ): Session {
    const existing = this.sessions.get(id);
    if (existing) {
      let changed = false;
      if (Number.isFinite(expiresAt) && expiresAt !== undefined && expiresAt > existing.expiresAt) {
        existing.expiresAt = expiresAt;
        changed = true;
      }
      if (currentLocation && existing.currentLocation !== currentLocation) {
        existing.currentLocation = currentLocation;
        changed = true;
      }
      // If the originating host knows the apikey id but the routed copy
      // doesn't yet, learn it so future revokes can tear the session down
      // here too.
      if (apikeyId !== undefined && existing.apikeyId !== apikeyId) {
        existing.apikeyId = apikeyId;
        changed = true;
      }
      if (changed) this.persistSession(existing);
      return existing;
    }
    this.object(actor);
    const now = Date.now();
    const session: Session = {
      id,
      actor,
      started: now,
      expiresAt: expiresAt ?? now + this.sessionTtl(tokenClass),
      lastDetachAt: null,
      tokenClass,
      currentLocation: currentLocation ?? this.initialSessionLocation(actor),
      attachedSockets: new Set(),
      lastInputAt: now,
      ...(apikeyId !== undefined ? { apikeyId } : {})
    };
    this.withPersistenceDeferred(() => {
      this.sessions.set(id, session);
      this.persistSession(session);
      // No reader (substrate or catalog) consults `actor.session_id` —
      // `world.sessions` is the source of truth for session lifecycle. The
      // formerly-written mirror property fired on every (actor × host)
      // first-touch and was a top-3 ambient writer.
    });
    return session;
  }

  private initialSessionLocation(actor: ObjRef): ObjRef {
    const obj = this.object(actor);
    const home = this.propOrNull(actor, "home");
    if (obj.location && this.objects.has(obj.location)) return obj.location;
    return typeof home === "string" && this.objects.has(home) ? home : "$nowhere";
  }

  claimWizardBootstrapSession(presentedToken: string, expectedToken: string | undefined): Session {
    if (!expectedToken) throw wooError("E_BOOTSTRAP_TOKEN_MISSING", "WOO_INITIAL_WIZARD_TOKEN is not set");
    const claim = () => {
      if (this.propOrNull("$system", "bootstrap_token_used") === true) throw wooError("E_TOKEN_CONSUMED", "wizard bootstrap token has already been consumed");
      if (presentedToken !== expectedToken) throw wooError("E_NOSESSION", "invalid wizard bootstrap token");
      this.setProp("$system", "bootstrap_token_used", true);
      return this.createSessionForActor("$wiz", "bearer");
    };
    const repo = this.activeObjectRepository();
    return repo ? repo.transaction(claim) : claim();
  }

  attachSocket(sessionId: string, socketId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.withPersistenceDeferred(() => {
      session.attachedSockets.add(socketId);
      session.lastDetachAt = null;
      const now = Date.now();
      session.expiresAt = Math.max(session.expiresAt, now + this.sessionTtl(session.tokenClass));
      session.lastInputAt = now;
      this.persistSession(session);
      this.persist();
    });
  }

  /** Mark a session as having received meaningful user input. Updates the
   * in-memory `lastInputAt` only — does not persist. Called from authenticated
   * WS / REST ingress for `op: call | direct | input` (and on socket attach,
   * inline above). NOT called from `world.directCall` or `world.call`,
   * because many of those callers are internal/test/system paths without a
   * real user behind them; the gating happens at the protocol edge instead. */
  touchSessionInput(sessionId: string, now: number = Date.now()): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastInputAt = now;
  }

  /** Most recent input timestamp across any of `actor`'s sessions, regardless
   * of whether a WebSocket is currently attached. Returns null only when
   * `actor` has no session at all. The socket-attached gate that used to
   * live here erased non-WS transports — REST and MCP ingress is real input
   * and the idle reading should reflect it. */
  actorLastInputAt(actor: ObjRef): number | null {
    let latest: number | null = null;
    for (const session of this.sessions.values()) {
      if (session.actor !== actor) continue;
      if (latest === null || session.lastInputAt > latest) latest = session.lastInputAt;
    }
    return latest;
  }

  /** True iff `actor` has any session that is currently driving the world.
   * "Currently driving" means either a WebSocket socket is attached, or the
   * session received non-WS input within the live window. The window lets
   * stateless transports (REST, MCP) register as connected while they are
   * actively making calls without keeping a socket open; once input stops,
   * they fall through to "sleeping" the same way a closed WS does. */
  actorIsConnected(actor: ObjRef): boolean {
    const liveCutoff = Date.now() - IDLE_PRESENCE_LIVE_WINDOW_MS;
    for (const session of this.sessions.values()) {
      if (session.actor !== actor) continue;
      if (session.attachedSockets.size > 0) return true;
      if (session.lastInputAt >= liveCutoff) return true;
    }
    return false;
  }

  detachSocket(sessionId: string, socketId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.withPersistenceDeferred(() => {
      session.attachedSockets.delete(socketId);
      if (session.attachedSockets.size === 0) {
        const now = Date.now();
        session.lastDetachAt = now;
        session.expiresAt = Math.max(session.expiresAt, now + this.sessionGrace(session.tokenClass));
      }
      this.persistSession(session);
      this.persist();
    });
  }

  sessionAlive(sessionId: string, now = Date.now()): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (!this.sessionExpired(session, now)) return true;
    this.reapSession(sessionId);
    this.persist(true);
    return false;
  }

  endSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.reapSession(sessionId);
    this.persist(true);
    return true;
  }

  /**
   * Returns true iff `actor` has at least one live session. Used by recycle
   * pre-flight (§RC6) to decide whether an actor is currently bound and
   * therefore unrecyclable through ordinary tools.
   */
  hasLiveSessions(actor: ObjRef): boolean {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.actor === actor && !this.sessionExpired(session, now)) return true;
    }
    return false;
  }

  /** Returns the live sessions bound to `actor` (sorted by id for stability). */
  liveSessionsForActor(actor: ObjRef): Session[] {
    const now = Date.now();
    const out: Session[] = [];
    for (const session of this.sessions.values()) {
      if (session.actor === actor && !this.sessionExpired(session, now)) out.push(session);
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  primarySessionForActor(actor: ObjRef): Session | null {
    let best: Session | null = null;
    for (const session of this.sessions.values()) {
      if (session.actor !== actor) continue;
      if (this.sessionExpired(session, Date.now())) continue;
      if (best === null || session.started < best.started || (session.started === best.started && session.id < best.id)) {
        best = session;
      }
    }
    return best;
  }

  private primarySessionForActorIncludingExpired(actor: ObjRef): Session | null {
    let best: Session | null = null;
    for (const session of this.sessions.values()) {
      if (session.actor !== actor) continue;
      if (best === null || session.started < best.started || (session.started === best.started && session.id < best.id)) {
        best = session;
      }
    }
    return best;
  }

  currentLocationForSession(sessionId: string | null | undefined): ObjRef | null {
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session || !this.sessionAlive(sessionId)) return null;
    return session.currentLocation;
  }

  allLocationsForActor(actor: ObjRef): ObjRef[] {
    const out: ObjRef[] = [];
    for (const session of this.sessions.values()) {
      if (session.actor !== actor) continue;
      if (!out.includes(session.currentLocation)) out.push(session.currentLocation);
    }
    if (out.length === 0) {
      const loc = this.objects.get(actor)?.location ?? null;
      if (loc) out.push(loc);
    }
    return out;
  }

  hasPresence(actor: ObjRef, space: ObjRef): boolean {
    this.ensurePresenceIndex();
    const subs = this.subscribersIndex.get(space);
    if (subs && subs.has(actor)) return true;
    const spaces = this.actorPresenceIndex.get(actor);
    return spaces ? spaces.has(space) : false;
  }

  // Read-only audience view for a $space. Returns the in-memory set the
  // index already maintains, so callers iterating the audience get the
  // same actor list `hasPresence` consults — without an O(N) array copy.
  // Returns `null` when no actor is recorded as present.
  presenceActorsIn(space: ObjRef): ReadonlySet<ObjRef> | null {
    this.ensurePresenceIndex();
    return this.subscribersIndex.get(space) ?? null;
  }

  presenceSessionsIn(space: ObjRef): ReadonlyMap<string, ObjRef> | null {
    this.ensurePresenceIndex();
    return this.sessionSubscribersIndex.get(space) ?? null;
  }

  presenceSessionIdsIn(space: ObjRef, actors?: Iterable<ObjRef>): string[] {
    const sessions = this.presenceSessionsIn(space);
    if (!sessions) return [];
    const actorSet = actors ? new Set(actors) : null;
    const out: string[] = [];
    for (const [sessionId, actor] of sessions) {
      if (!actorSet || actorSet.has(actor)) out.push(sessionId);
    }
    return out.sort();
  }

  hasSessionPresence(sessionId: string, space: ObjRef): boolean {
    this.ensurePresenceIndex();
    return this.sessionSpacesIndex.get(sessionId)?.has(space) === true;
  }

  async call(frameId: string | undefined, sessionId: string, space: ObjRef, message: Message): Promise<AppliedFrame | ErrorFrame> {
    return await this.enqueueHostTask(() => this.callNow(frameId, sessionId, space, message), `call:${message.target}:${message.verb}`);
  }

  private async callNow(frameId: string | undefined, sessionId: string, space: ObjRef, message: Message): Promise<AppliedFrame | ErrorFrame> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.sessionAlive(sessionId)) {
      return { op: "error", id: frameId, error: wooError("E_NOSESSION", "session token is expired or unknown") };
    }
    if (message.actor !== session.actor) {
      return { op: "error", id: frameId, error: wooError("E_PERM", "message actor does not match session actor", { actor: message.actor, session_actor: session.actor }) };
    }
    this.sweepIdempotency();
    if (frameId) {
      const cached = this.idempotency.get(`${sessionId}:${frameId}`);
      if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.frame;
    }
    let frame: AppliedFrame | ErrorFrame;
    try {
        frame = await this.applyCall(frameId, space, message, sessionId);
    } catch (err) {
      const error = normalizeError(err);
      frame = { op: "error", id: frameId, error };
    }
    if (frameId) this.idempotency.set(`${sessionId}:${frameId}`, { at: Date.now(), frame });
    return frame;
  }

  private async enqueueHostTask<T>(fn: () => Promise<T>, label: string = "task"): Promise<T> {
    const id = ++this.hostTaskCounter;
    this.hostTaskQueueDepth += 1;
    const queueDepth = this.hostTaskQueueDepth;
    this.recordMetric({ kind: "host_task_enqueue", id, label, queue_depth: queueDepth });
    // If a task is currently in flight when we enqueue, surface who we're
    // queued behind and how long they've already been running. This is the
    // primary fingerprint of a wedge: when an MCP call hangs forever, the
    // tail will show its host_task_blocked event pointing at the in-flight
    // task that never settles.
    if (this.currentHostTask) {
      this.recordMetric({
        kind: "host_task_blocked",
        new_id: id,
        new_label: label,
        current_id: this.currentHostTask.id,
        current_label: this.currentHostTask.label,
        current_elapsed_ms: Date.now() - this.currentHostTask.startedAt,
        queue_depth: queueDepth
      });
    }
    const enqueuedAt = Date.now();
    const run = this.hostQueue.then(async () => {
      const startedAt = Date.now();
      this.currentHostTask = { id, label, startedAt };
      this.hostTaskQueueDepth -= 1;
      this.recordMetric({ kind: "host_task_start", id, label, queued_ms: startedAt - enqueuedAt });
      // 3-second watchdog. Wedged tasks stay in this loop indefinitely until
      // the task settles, surfacing a steady drumbeat in the tail. Cleared
      // in the finally below so a settled task emits no further long-running
      // events.
      const watchdogTimers: ReturnType<typeof setTimeout>[] = [];
      const armWatchdog = (afterMs: number): void => {
        const timer = setTimeout(() => {
          if (this.currentHostTask?.id === id) {
            this.recordMetric({ kind: "host_task_long_running", id, label, elapsed_ms: Date.now() - startedAt });
            armWatchdog(3000);
          }
        }, afterMs);
        watchdogTimers.push(timer);
      };
      armWatchdog(3000);
      try {
        const result = await fn();
        this.recordMetric({ kind: "host_task_done", id, label, ms: Date.now() - startedAt, status: "ok" });
        return result;
      } catch (err) {
        const error = normalizeError(err);
        this.recordMetric({ kind: "host_task_done", id, label, ms: Date.now() - startedAt, status: "error", error: error.code });
        throw err;
      } finally {
        for (const timer of watchdogTimers) clearTimeout(timer);
        if (this.currentHostTask?.id === id) this.currentHostTask = null;
      }
    }, async () => {
      // Previous link rejected. We don't propagate that rejection to this
      // task — preserve the original semantics where errors from one task
      // don't poison subsequent tasks. The old code had the same shape via
      // `then(fn, fn)`; this just keeps the diagnostic wrapping consistent.
      const startedAt = Date.now();
      this.currentHostTask = { id, label, startedAt };
      this.hostTaskQueueDepth -= 1;
      this.recordMetric({ kind: "host_task_start", id, label, queued_ms: startedAt - enqueuedAt });
      try {
        const result = await fn();
        this.recordMetric({ kind: "host_task_done", id, label, ms: Date.now() - startedAt, status: "ok" });
        return result;
      } catch (err) {
        const error = normalizeError(err);
        this.recordMetric({ kind: "host_task_done", id, label, ms: Date.now() - startedAt, status: "error", error: error.code });
        throw err;
      } finally {
        if (this.currentHostTask?.id === id) this.currentHostTask = null;
      }
    });
    this.hostQueue = run.then(
      () => undefined,
      () => undefined
    );
    return await run;
  }

  async directCall(frameId: string | undefined, actor: ObjRef, target: ObjRef, verbName: string, args: WooValue[], options: DirectCallOptions = {}): Promise<DirectResultFrame | ErrorFrame> {
    return await this.enqueueHostTask(() => this.directCallNow(frameId, actor, target, verbName, args, options), `directCall:${target}:${verbName}`);
  }

  async planCommand(frameId: string | undefined, sessionId: string, space: ObjRef, text: string): Promise<DirectResultFrame | ErrorFrame> {
    return await this.enqueueHostTask(() => this.planCommandNow(frameId, sessionId, space, text), `planCommand:${space}`);
  }

  async command(frameId: string | undefined, sessionId: string, space: ObjRef, text: string, options: CommandOptions = {}): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
    return await this.enqueueHostTask(() => this.commandNow(frameId, sessionId, space, text, options), `command:${space}`);
  }

  private async commandNow(frameId: string | undefined, sessionId: string, space: ObjRef, text: string, options: CommandOptions = {}): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
    const planned = await this.planCommandNow(frameId, sessionId, space, text);
    if (planned.op === "error") return planned;
    const plan = commandPlanFromValue(planned.result);
    if (!plan) return planned;
    if (plan.route === "direct") {
      const frame = await this.directCallNow(frameId, this.sessionActor(sessionId), plan.target, plan.verb, plan.args, { sessionId, deferHostEffect: options.deferHostEffect });
      return frame.op === "result" ? { ...frame, command: plan } as DirectResultFrame : frame;
    }
    const commandSpace = plan.space ?? space;
    return await this.callNow(frameId, sessionId, commandSpace, { actor: this.sessionActor(sessionId), target: plan.target, verb: plan.verb, args: plan.args });
  }

  async executeCommandPlan(ctx: CallContext, planValue: Record<string, WooValue>): Promise<WooValue> {
    const plan = commandPlanFromValue(planValue as unknown as WooValue);
    if (!plan) return planValue as unknown as WooValue;
    if (plan.route === "direct") {
      return await this.dispatch({ ...ctx, caller: ctx.thisObj, callerPerms: ctx.progr }, plan.target, plan.verb, plan.args);
    }
    if (!ctx.session) throw wooError("E_NOSESSION", "sequenced command requires a live session");
    const commandSpace = plan.space ?? ctx.space;
    return await this.callNow(undefined, ctx.session, commandSpace, { actor: ctx.actor, target: plan.target, verb: plan.verb, args: plan.args });
  }

  private async planCommandNow(frameId: string | undefined, sessionId: string, space: ObjRef, text: string): Promise<DirectResultFrame | ErrorFrame> {
    const startedAt = Date.now();
    try {
      assertObj(space);
      assertString(text);
      const actor = this.sessionActor(sessionId);
      const hostMemo = createHostOperationMemo();
      if (!await this.isDescendantOfChecked(space, "$space", hostMemo)) throw wooError("E_TYPE", `${space} is not a space`, space);
      await this.chatPresentAsync(space, actor);
      this.authorizePresence(actor, space, sessionId);
      const observations: Observation[] = [];
      const ctx: CallContext = {
        world: this,
        space,
        seq: -1,
        session: sessionId,
        actor,
        player: actor,
        caller: "#-1",
        callerPerms: actor,
        progr: actor,
        thisObj: space,
        verbName: "command",
        definer: space,
        message: { actor, target: space, verb: "command", args: [text] },
        observations,
        hostMemo,
        observe: (event) => {
          observations.push({ ...event, source: event.source ?? space });
        }
      };
      const result = await this.planCommandForSpace(ctx, text, space) as WooValue;
      const liveAudiences = await this.directLiveAudiences(space, observations);
      this.recordMetric({ kind: "direct_call", target: space, verb: "command", audience: space, observations: observations.length, ms: Date.now() - startedAt, status: "ok" });
      return {
        op: "result",
        id: frameId,
        result,
        observations,
        audience: space,
        audienceActors: liveAudiences.audienceActors,
        observationAudiences: liveAudiences.observationAudiences,
        audienceSessions: liveAudiences.audienceSessions,
        observationSessionAudiences: liveAudiences.observationSessionAudiences
      };
    } catch (err) {
      const error = normalizeError(err);
      this.recordMetric({ kind: "direct_call", target: space, verb: "command", audience: space, observations: 0, ms: Date.now() - startedAt, status: "error" });
      return { op: "error", id: frameId, error };
    }
  }

  private sessionActor(sessionId: string): ObjRef {
    const session = this.sessions.get(sessionId);
    if (!session || !this.sessionAlive(sessionId)) throw wooError("E_NOSESSION", "session token is expired or unknown");
    return session.actor;
  }

  private async directCallNow(frameId: string | undefined, actor: ObjRef, target: ObjRef, verbName: string, args: WooValue[], options: DirectCallOptions = {}): Promise<DirectResultFrame | ErrorFrame> {
    const startedAt = Date.now();
    try {
      assertObj(actor);
      assertObj(target);
      assertString(verbName);
      if (!Array.isArray(args)) throw wooError("E_INVARG", "args must be a list");
      const { verb } = this.resolveVerb(target, verbName);
      const forceDirect = options.forceDirect === true && verb.direct_callable !== true;
      const wizard = this.isWizard(actor);
      if (verb.direct_callable !== true && !forceDirect) {
        throw wooError("E_DIRECT_DENIED", `direct call denied for ${target}:${verbName}`, { target, verb: verbName });
      }
      if (forceDirect && !wizard) throw wooError("E_PERM", "only wizards may force direct calls", { actor, target, verb: verbName });
      if (forceDirect) this.recordWizardAction(actor, "force_direct", { target, verb: verbName, reason: options.forceReason ?? null });
      const hostMemo = createHostOperationMemo();
      const audience = await this.directAudience(target, hostMemo);
      const sessionId = options.sessionId === undefined ? this.primarySessionForActor(actor)?.id ?? null : options.sessionId;
      if (audience) await this.chatPresentAsync(audience, actor);
      if (audience && verb.skip_presence_check !== true && !forceDirect) this.authorizePresence(actor, audience, sessionId);
      const observations: Observation[] = [];
      if (forceDirect) observations.push({ type: "wizard_action", action: "force_direct", actor, target, verb: verbName, source: target });
      const message: Message = { actor, target, verb: verbName, args };
      const deferredHostEffects: DeferredHostEffect[] = [];
      let result: WooValue = null;
      let mutated = false;
      const dispatchCtx: CallContext = {
        world: this,
        space: audience ?? "#-1",
        seq: -1,
        session: sessionId,
        actor,
        player: actor,
        caller: "#-1",
        callerPerms: actor,
        progr: actor,
        thisObj: target,
        verbName,
        definer: target,
        message,
        observations,
        hostMemo,
        onSessionsEnded: options.onSessionsEnded,
        observe: (event) => {
          observations.push({ ...event, source: event.source ?? target });
        },
        deferHostEffect: options.deferHostEffect ? (effect) => deferredHostEffects.push(effect) : undefined
      };
      await this.withPersistencePaused(async () => {
        const before = this.snapshotProps();
        const beforePlacement = this.snapshotPlacement();
        const beforeParkedTasks = new Map(this.parkedTasks);
        const beforeParkedTaskCounter = this.parkedTaskCounter;
        const beforeObjectCount = this.objects.size;
        try {
          result = await this.dispatch(dispatchCtx, target, verbName, args);
          mutated =
            beforeObjectCount !== this.objects.size ||
            this.propsChanged(before) ||
            this.placementChanged(beforePlacement) ||
            beforeParkedTasks.size !== this.parkedTasks.size ||
            beforeParkedTaskCounter !== this.parkedTaskCounter;
        } catch (err) {
          this.restoreProps(before);
          this.restorePlacement(beforePlacement);
          this.parkedTasks = new Map(beforeParkedTasks);
          this.parkedTaskCounter = beforeParkedTaskCounter;
          throw err;
        }
      });
      if (mutated || this.persistenceDirty) this.persist(true);
      if (options.deferHostEffect) {
        for (const effect of deferredHostEffects) options.deferHostEffect(effect);
      }
      result = await this.enrichScopedMoveResult(dispatchCtx, result);
      // Cross-host bridge stashes authoritative audience info on ctx; prefer
      // it over recomputing locally where the local subscriber/presence view
      // for self-hosted spaces is stale.
        const crossHostAudience = (dispatchCtx as { crossHostAudience?: { audienceActors?: ObjRef[]; observationAudiences?: ObjRef[][]; audienceSessions?: string[]; observationSessionAudiences?: string[][] } }).crossHostAudience;
      const liveAudiences = crossHostAudience ?? await this.directLiveAudiences(audience, observations);
      this.recordMetric({ kind: "direct_call", target, verb: verbName, audience, observations: observations.length, ms: Date.now() - startedAt, status: "ok" });
      return {
        op: "result",
        id: frameId,
        result,
        observations,
          audience,
          audienceActors: liveAudiences.audienceActors,
          observationAudiences: liveAudiences.observationAudiences,
          audienceSessions: liveAudiences.audienceSessions,
          observationSessionAudiences: liveAudiences.observationSessionAudiences
        };
    } catch (err) {
      const error = normalizeError(err);
      this.recordMetric({ kind: "direct_call", target, verb: verbName, audience: null, observations: 0, ms: Date.now() - startedAt, status: "error", error: error.code });
      return { op: "error", id: frameId, error };
    }
  }

  private async enrichScopedMoveResult(ctx: CallContext, result: WooValue): Promise<WooValue> {
    if (!result || typeof result !== "object" || Array.isArray(result)) return result;
    const map = result as Record<string, WooValue>;
    if (map.here !== undefined || map.here_request !== true || typeof map.room !== "string") return result;
    const memo = ctx.hostMemo ?? createHostOperationMemo();
    const hereLocation = await this.primaryRoomForLocation(map.room, memo);
    if (!hereLocation) return result;
    const here = await this.roomSnapshotForActor(ctx.actor, hereLocation, ctx.session, memo);
    return {
      ...map,
      here: await this.includeMovingActorInHere(ctx, here, memo)
    };
  }

  private async includeMovingActorInHere(ctx: CallContext, here: RoomSnapshot, memo: HostOperationMemo): Promise<RoomSnapshot> {
    if (!ctx.session || here.present_actors.some((actor) => actor.id === ctx.actor)) return here;
    const currentLocation = this.currentLocationForSession(ctx.session);
    if (!currentLocation) return here;
    const currentHere = await this.primaryRoomForLocation(currentLocation, memo);
    if (currentHere !== here.id) return here;
    return {
      ...here,
      present_actors: [...here.present_actors, this.thinScopedObjectSummary(await this.scopedObjectSummary(ctx.actor, ctx.actor, memo))]
    };
  }

  replay(space: ObjRef, from: number, limit: number): SpaceLogEntry[] {
    return (this.logs.get(space) ?? []).filter((entry) => entry.seq >= from).slice(0, limit);
  }

    async applyCall(id: string | undefined, spaceRef: ObjRef, message: Message, sessionId: string | null = null): Promise<AppliedFrame> {
      const repo = this.activeObjectRepository();
      if (repo) return await this.applyCallRepository(repo, id, spaceRef, message, sessionId);
    const startedAt = Date.now();
    const frame = await this.withPersistencePaused(async () => {
      this.validateMessage(message);
      const space = this.object(spaceRef);
      await this.scrubStaleSubscribersForSpace(spaceRef, message.actor, this.chatPresent(spaceRef));
        this.authorizePresence(message.actor, spaceRef, sessionId);
      const nextSeq = Number(this.getProp(spaceRef, "next_seq"));
      const seq = nextSeq;
      this.setProp(spaceRef, "next_seq", nextSeq + 1);

      const logEntry: SpaceLogEntry = {
        space: spaceRef,
        seq,
        ts: Date.now(),
        actor: message.actor,
        message: cloneValue(message) as Message,
        observations: [],
        applied_ok: true
      };
      const log = this.logs.get(spaceRef) ?? [];
      log.push(logEntry);
      this.logs.set(spaceRef, log);

      const observations: Observation[] = [];
      let result: WooValue | undefined;
      const ctx: CallContext = {
        world: this,
        space: spaceRef,
        seq,
        session: sessionId,
        actor: message.actor,
        player: message.actor,
        caller: "#-1",
        callerPerms: message.actor,
        progr: message.actor,
        thisObj: message.target,
        verbName: message.verb,
        definer: message.target,
        message,
        observations,
        hostMemo: createHostOperationMemo(),
        observe: (event) => {
          observations.push({ ...event, source: event.source ?? space.id });
        }
      };

      try {
        await this.withBehaviorSavepoint(async () => {
          result = await this.dispatch(ctx, message.target, message.verb, message.args);
          result = await this.enrichScopedMoveResult(ctx, result);
        });
        logEntry.applied_ok = true;
      } catch (err) {
        if (isVmSuspendSignal(err)) {
          const task = this.parkVmContinuation(ctx, err.seconds, err.task);
          logEntry.applied_ok = true;
          observations.push({ type: "task_suspended", source: spaceRef, task, resume_at: this.parkedTasks.get(task)?.resume_at ?? null });
        } else if (isVmReadSignal(err)) {
          const task = this.parkReadContinuation(ctx, err.player, err.task);
          logEntry.applied_ok = true;
          observations.push({ type: "task_awaiting_read", source: spaceRef, task, player: err.player });
        } else {
          const error = normalizeError(err);
          logEntry.applied_ok = false;
          logEntry.error = error;
          observations.length = 0;
          observations.push({ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] });
        }
      }

      logEntry.observations = cloneValue(observations as unknown as WooValue) as unknown as Observation[];
      const frame = { op: "applied" as const, id, space: spaceRef, seq, ts: logEntry.ts, message, observations, result };
      this.persist(true);
      return frame;
    });
    this.recordMetric({ kind: "applied", space: spaceRef, seq: frame.seq, verb: message.verb, ms: Date.now() - startedAt });
    return frame;
  }

  private async applyCallRepository(repo: ObjectRepository, id: string | undefined, spaceRef: ObjRef, message: Message, sessionId: string | null = null): Promise<AppliedFrame> {
    const before = this.snapshotBehaviorState();
    const beforeLogs = this.snapshotLogs();
    const startedAt = Date.now();
    try {
      const frame = await this.withPersistencePaused(async () => {
        this.validateMessage(message);
        const space = this.object(spaceRef);
        await this.scrubStaleSubscribersForSpace(spaceRef, message.actor, this.chatPresent(spaceRef));
        this.authorizePresence(message.actor, spaceRef, sessionId);
        const seq = Number(this.getProp(spaceRef, "next_seq"));
        const ts = Date.now();
        this.setPropLocal(spaceRef, "next_seq", seq + 1);

        const logEntry: SpaceLogEntry = {
          space: spaceRef,
          seq,
          ts,
          actor: message.actor,
          message: cloneValue(message) as Message,
          observations: [],
          applied_ok: true
        };
        const log = this.logs.get(spaceRef) ?? [];
        log.push(logEntry);
        this.logs.set(spaceRef, log);
        // `state(actor).spaces` exposes next_seq/log_count. In repository
        // mode, appendLog persists next_seq directly, bypassing persistProperty.
        this.bumpMutationVersion();

        const observations: Observation[] = [];
        let result: WooValue | undefined;
        const ctx: CallContext = {
          world: this,
          space: spaceRef,
          seq,
          session: sessionId,
          actor: message.actor,
          player: message.actor,
          caller: "#-1",
          callerPerms: message.actor,
          progr: message.actor,
          thisObj: message.target,
          verbName: message.verb,
          definer: message.target,
          message,
          observations,
          hostMemo: createHostOperationMemo(),
          observe: (event) => {
            observations.push({ ...event, source: event.source ?? space.id });
          }
        };

        try {
          await this.withBehaviorSavepoint(async () => {
            result = await this.dispatch(ctx, message.target, message.verb, message.args);
            result = await this.enrichScopedMoveResult(ctx, result);
          });
          logEntry.applied_ok = true;
        } catch (err) {
          if (isVmSuspendSignal(err)) {
            const task = this.parkVmContinuation(ctx, err.seconds, err.task);
            logEntry.applied_ok = true;
            observations.push({ type: "task_suspended", source: spaceRef, task, resume_at: this.parkedTasks.get(task)?.resume_at ?? null });
          } else if (isVmReadSignal(err)) {
            const task = this.parkReadContinuation(ctx, err.player, err.task);
            logEntry.applied_ok = true;
            observations.push({ type: "task_awaiting_read", source: spaceRef, task, player: err.player });
          } else {
            const error = normalizeError(err);
            logEntry.applied_ok = false;
            logEntry.error = error;
            observations.length = 0;
            observations.push({ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] });
          }
        }

        logEntry.observations = cloneValue(observations as unknown as WooValue) as unknown as Observation[];
        repo.transaction(() => {
          const appended = repo.appendLog(spaceRef, message.actor, message);
          if (appended.seq !== seq) throw wooError("E_STORAGE", `sequenced log drift for ${spaceRef}: expected ${seq}, got ${appended.seq}`);
          logEntry.ts = appended.ts;
          repo.recordLogOutcome(spaceRef, seq, logEntry.applied_ok === true, observations, logEntry.error);
          this.flushIncrementalState();
        });
        const audience = this.appliedFrameAudience(spaceRef, observations);
        return { op: "applied" as const, id, space: spaceRef, seq, ts: logEntry.ts, message, observations, result, ...audience };
      });
      this.recordMetric({ kind: "applied", space: spaceRef, seq: frame.seq, verb: message.verb, ms: Date.now() - startedAt });
      return frame;
    } catch (err) {
      this.restoreBehaviorState(before);
      this.logs = beforeLogs;
      throw err;
    }
  }

  async hostDispatch(ctx: CallContext, target: ObjRef, verbName: string, args: WooValue[], startAt?: ObjRef | null): Promise<WooValue> {
    return await this.enqueueHostTask(() => this.dispatch(ctx, target, verbName, args, startAt), `dispatch:${target}:${verbName}`);
  }

  async dispatch(ctx: CallContext, target: ObjRef, verbName: string, args: WooValue[], startAt?: ObjRef | null, maxChars?: number | null): Promise<WooValue> {
    let result: WooValue;
    if (await this.remoteHostForObject(target, ctx.hostMemo) || (startAt ? await this.remoteHostForObject(startAt, ctx.hostMemo) : false)) {
      if (!this.hostBridge) throw wooError("E_INTERNAL", "remote host bridge unavailable");
      result = await this.hostBridge.dispatch(ctx, target, verbName, args, startAt);
    } else {
      if (this.callDepth >= MAX_CALL_DEPTH) throw wooError("E_CALL_DEPTH", "maximum verb call depth exceeded");
      this.callDepth += 1;
      try {
        // startAt is `undefined` for an ordinary call and a definer ref for `pass()`.
        // Cross-host dispatch serializes `undefined` as JSON `null`, so treat both
        // as "no parent override" and fall back to the standard resolveVerb walk.
        const { definer, verb } = startAt == null ? this.resolveVerb(target, verbName) : this.resolveVerbFrom(startAt, verbName);
        this.assertCanExecuteVerb(ctx.progr, target, verbName, verb);
        const runCtx: CallContext = {
          ...ctx,
          thisObj: target,
          verbName,
          definer,
          callerPerms: ctx.progr,
          progr: verb.owner,
          player: ctx.player ?? ctx.actor,
          caller: ctx.caller ?? "#-1"
        };
        if (verb.kind === "native") {
          // Native handlers are an implementation detail behind ordinary verb
          // dispatch. The dispatch path above has already enforced verb execute
          // permissions and set progr/definer/caller frame fields.
          const handler = this.nativeHandlers.get(verb.native);
          if (!handler) throw wooError("E_VERBNF", `native handler not found: ${verb.native}`);
          result = await handler(runCtx, args);
        } else {
          result = await runTinyVm(runCtx, verb.bytecode, args);
        }
      } finally {
        this.callDepth -= 1;
      }
    }
    if (typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars >= 0) {
      if (typeof result === "string" && result.length > maxChars) {
        throw wooError("E_TOOBIG", `dispatch result exceeded ${maxChars}-character bound`, { target, verb: verbName, size: result.length, max: maxChars });
      }
      if (Array.isArray(result)) {
        let total = 0;
        for (const entry of result) {
          if (typeof entry === "string") total += entry.length;
          if (total > maxChars) {
            throw wooError("E_TOOBIG", `dispatch list result exceeded ${maxChars}-character bound`, { target, verb: verbName, size: total, max: maxChars });
          }
        }
      }
    }
    return result;
  }

  state(actor?: ObjRef): WorldSnapshot {
    const spaces: WorldSnapshot["spaces"] = {};
    for (const id of Array.from(this.objects.keys()).sort()) {
      if (!this.inheritsFrom(id, "$space")) continue;
      const nextSeq = Number(this.propOrNull(id, "next_seq"));
      if (!Number.isFinite(nextSeq)) continue;
      spaces[id] = { next_seq: nextSeq, log_count: this.logs.get(id)?.length ?? 0 };
    }
    return {
      server_time: Date.now(),
      actorCount: Array.from(this.objects.values()).filter((obj) => this.inheritsFrom(obj.id, "$player")).length,
      spaces,
      catalogs: this.catalogState(),
      object_routes: this.objectRoutes(),
      objects: Object.fromEntries(Array.from(this.objects.keys()).sort().map((id) => [id, this.stateObject(id, actor)]))
    };
  }

  async meSnapshot(session: Session): Promise<MeSnapshot> {
    const memo = createHostOperationMemo();
    const currentLocation = this.currentLocationForSession(session.id);
    const hereLocation = currentLocation
      ? await this.primaryRoomForLocation(currentLocation, memo).catch((err) => {
        if (isReadAvailabilityError(err)) return null;
        throw err;
      })
      : null;
    const inventoryRefs = await this.objectContents(session.actor, memo);
    const inventory = await this.scopedObjectSummaries(session.actor, inventoryRefs, memo);
    const overlays = currentLocation && hereLocation && currentLocation !== hereLocation
      ? { current_location: { subject: currentLocation, surface: "default", restore: true } }
      : undefined;
    const cursorSpaces = [
      currentLocation,
      hereLocation,
      ...Object.values(overlays ?? {}).map((overlay) => overlay.subject)
    ].filter((item): item is ObjRef => typeof item === "string");
    const here = hereLocation
      ? await this.roomSnapshotForActor(session.actor, hereLocation, session.id, memo).catch((err) => {
        if (isReadAvailabilityError(err)) return null;
        throw err;
      })
      : null;
    return {
      server_time: Date.now(),
      cursor: await this.projectionCursor(cursorSpaces, memo),
      self: await this.scopedObjectSummary(session.actor, session.actor, memo),
      session: {
        id: session.id,
        actor: session.actor,
        current_location: currentLocation,
        all_locations: this.allLocationsForActor(session.actor)
      },
      here,
      inventory: inventoryRefs.map((id) => inventory[id]).filter((item): item is ScopedObjectSummary => item !== undefined),
      overlays
    };
  }

  async roomSnapshotForActor(actor: ObjRef, room: ObjRef, sessionId: string | null = null, memo: HostOperationMemo = createHostOperationMemo()): Promise<RoomSnapshot> {
    if (await this.remoteHostForObject(room, memo)) {
      if (!this.hostBridge?.roomSnapshot) throw wooError("E_INTERNAL", "remote host bridge room snapshots unavailable");
      return await this.hostBridge.roomSnapshot(actor, room, sessionId, memo);
    }

    const roomSummary = await this.scopedObjectSummary(actor, room, memo);
    const presentRefs = await this.chatPresentAsync(room, actor);
    const contentRefs = (await this.objectContents(room, memo)).filter((item) => !this.isActorForLook(item, presentRefs));
    const exits = await this.exitSummariesForRoom(actor, room, memo);
    const present = await this.scopedObjectSummaries(actor, presentRefs, memo);
    const contents = await this.scopedObjectSummaries(actor, contentRefs, memo);
    return {
      id: room,
      name: roomSummary.name,
      parent: roomSummary.parent,
      features: roomSummary.features,
      description: roomSummary.description,
      exits,
      present_actors: presentRefs.map((id) => present[id]).filter((item): item is ScopedObjectSummary => item !== undefined).map((item) => this.thinScopedObjectSummary(item)),
      contents: contentRefs.map((id) => contents[id]).filter((item): item is ScopedObjectSummary => item !== undefined).map((item) => this.thinScopedObjectSummary(item)),
      props: roomSummary.props
    };
  }

  async overlaySnapshotForActor(actor: ObjRef, subject: ObjRef, surface = "default", sessionId: string | null = null, memo: HostOperationMemo = createHostOperationMemo()): Promise<OverlaySnapshot> {
    if (await this.remoteHostForObject(subject, memo)) {
      if (!this.hostBridge?.overlaySnapshot) throw wooError("E_INTERNAL", "remote host bridge overlay snapshots unavailable");
      return await this.hostBridge.overlaySnapshot(actor, subject, surface, sessionId, memo);
    }

    const room = await this.spaceLikeOrRemote(subject, memo)
      ? await this.roomSnapshotForActor(actor, subject, sessionId, memo)
      : null;
    const refs = new Set<ObjRef>([subject]);
    for (const id of await this.objectContents(subject, memo)) refs.add(id);
    if (room) {
      for (const item of room.present_actors) refs.add(item.id);
      for (const item of room.contents) refs.add(item.id);
      for (const item of room.exits) refs.add(item.id);
    }
    const summaries = await this.scopedObjectSummaries(actor, Array.from(refs), memo);
    return {
      surface,
      subject,
      cursor: await this.projectionCursor([subject], memo),
      room,
      objects: Array.from(refs).map((id) => summaries[id]).filter((item): item is ScopedObjectSummary => item !== undefined)
    };
  }

  async scopedObjectSummaries(actor: ObjRef, objRefs: ObjRef[], memo: HostOperationMemo = createHostOperationMemo()): Promise<Record<ObjRef, ScopedObjectSummary>> {
    const out: Record<ObjRef, ScopedObjectSummary> = {};
    const remoteByHost = new Map<string, ObjRef[]>();
    for (const objRef of objRefs) {
      const host = await this.remoteHostForObject(objRef, memo);
      if (!host) {
        if (!this.objects.has(objRef)) continue;
        out[objRef] = this.localScopedObjectSummary(actor, objRef);
        continue;
      }
      const list = remoteByHost.get(host) ?? [];
      list.push(objRef);
      remoteByHost.set(host, list);
    }
    if (remoteByHost.size === 0) return out;
    if (!this.hostBridge) throw wooError("E_INTERNAL", "remote host bridge object summaries unavailable");
    await Promise.all(Array.from(remoteByHost.values()).map(async (ids) => {
      try {
        Object.assign(out, await this.hostBridge!.objectSummaries(actor, ids, memo));
      } catch (err) {
        if (!isReadAvailabilityError(err)) throw err;
      }
    }));
    return out;
  }

  async scopedObjectSummary(actor: ObjRef, objRef: ObjRef, memo: HostOperationMemo = createHostOperationMemo()): Promise<ScopedObjectSummary> {
    if (await this.remoteHostForObject(objRef, memo)) {
      if (!this.hostBridge) throw wooError("E_INTERNAL", "remote host bridge object summaries unavailable");
      return await this.hostBridge.objectSummary(actor, objRef, memo);
    }
    return this.localScopedObjectSummary(actor, objRef);
  }

  private async projectionCursor(spaces: ObjRef[], memo: HostOperationMemo): Promise<MeSnapshot["cursor"]> {
    const cursor: MeSnapshot["cursor"] = { spaces: {}, live: { resumable: false } };
    for (const space of Array.from(new Set(spaces))) {
      const nextSeq = await this.cursorNextSeq(space, memo);
      if (typeof nextSeq === "number" && Number.isFinite(nextSeq)) cursor.spaces[space] = { next_seq: nextSeq };
    }
    return cursor;
  }

  private async cursorNextSeq(space: ObjRef, memo: HostOperationMemo): Promise<WooValue | null> {
    try {
      if (await this.remoteHostForObject(space, memo)) {
        if (!this.hostBridge) throw wooError("E_INTERNAL", "remote host bridge unavailable");
        return await this.hostBridge.getPropChecked("$wiz", space, "next_seq", memo);
      }
      return this.getProp(space, "next_seq");
    } catch (err) {
      if (!isOptionalProjectionReadError(err)) throw err;
      return null;
    }
  }

  private async primaryRoomForLocation(location: ObjRef, memo: HostOperationMemo): Promise<ObjRef | null> {
    let current: ObjRef | null = location;
    let fallbackSpace: ObjRef | null = null;
    const seen = new Set<ObjRef>();
    while (current && !seen.has(current)) {
      seen.add(current);
      if (fallbackSpace === null && await this.spaceLikeOrRemote(current, memo)) fallbackSpace = current;
      if (await this.isDescendantOfChecked(current, "$room", memo)) return current;
      const parentLocation = await this.objectLocationChecked(current, memo);
      if (!parentLocation || parentLocation === current) break;
      current = parentLocation;
    }
    return fallbackSpace;
  }

  objectRoutes(): Array<{ id: ObjRef; host: string; anchor: ObjRef | null }> {
    const selfHosted = new Set<ObjRef>();
    for (const id of this.objects.keys()) {
      if (this.propOrNull(id, "host_placement") === "self") selfHosted.add(id);
    }
    const hostFor = (id: ObjRef): string => {
      if (selfHosted.has(id)) return id;
      const obj = this.object(id);
      let cursor: ObjRef | null = obj.anchor;
      const seen = new Set<ObjRef>();
      while (cursor && !seen.has(cursor)) {
        if (selfHosted.has(cursor)) return cursor;
        seen.add(cursor);
        cursor = this.objects.has(cursor) ? this.object(cursor).anchor : null;
      }
      return DEFAULT_OBJECT_HOST;
    };
    return Array.from(this.objects.values())
      .map((obj) => ({ id: obj.id, host: hostFor(obj.id), anchor: obj.anchor }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private catalogState(): { installed: WooValue[] } {
    const installed = this.objects.has("$catalog_registry") ? this.propOrNull("$catalog_registry", "installed_catalogs") : [];
    return { installed: Array.isArray(installed) ? installed : [] };
  }

  private stateObject(id: ObjRef, actor?: ObjRef): Record<string, WooValue> {
    const described = actor ? this.describeForActor(id, actor) : this.describe(id);
    const props: Record<string, WooValue> = {};
    for (const name of this.properties(id)) {
      props[String(name)] = actor ? this.propOrNullForActor(actor, id, String(name)) : this.propOrNull(id, String(name));
    }
    return { ...described, props };
  }

  private localScopedObjectSummary(actor: ObjRef, objRef: ObjRef): ScopedObjectSummary {
    const obj = this.object(objRef);
    const props: Record<string, WooValue> = {};
    for (const name of this.properties(objRef)) {
      if (String(name) === "session_subscribers") continue;
      props[String(name)] = this.propOrNullForActor(actor, objRef, String(name));
    }
    const aliases = props.aliases;
    return {
      id: obj.id,
      name: obj.name,
      parent: obj.parent,
      ancestors: this.ancestorsOf(objRef),
      features: this.safeFeatureList(objRef),
      owner: obj.owner,
      location: obj.location,
      aliases: Array.isArray(aliases) ? aliases.filter((item): item is string => typeof item === "string") : undefined,
      description: props.description ?? null,
      props
    };
  }

  private thinScopedObjectSummary(summary: ScopedObjectSummary): ScopedObjectSummary {
    const { props: _props, catalogState: _catalogState, ...thin } = summary;
    return thin;
  }

  private safeFeatureList(objRef: ObjRef): ObjRef[] {
    try {
      if (!this.canCarryFeatures(objRef)) return [];
      return this.featureList(objRef);
    } catch {
      return [];
    }
  }

  private ancestorsOf(objRef: ObjRef): ObjRef[] {
    const ancestors: ObjRef[] = [];
    let current = this.object(objRef).parent;
    const seen = new Set<ObjRef>();
    while (current && !seen.has(current)) {
      ancestors.push(current);
      seen.add(current);
      current = this.object(current).parent;
    }
    return ancestors.reverse();
  }

  private async exitSummariesForRoom(actor: ObjRef, room: ObjRef, memo: HostOperationMemo): Promise<RoomSnapshot["exits"]> {
    const raw = await this.propOrNullForActorAsync(actor, room, "exits", memo);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const byExit = new Map<ObjRef, string>();
    for (const [direction, exit] of Object.entries(raw as Record<string, WooValue>)) {
      if (typeof exit !== "string") continue;
      const existing = byExit.get(exit);
      if (!existing || this.preferExitDirection(direction, existing)) byExit.set(exit, direction);
    }
    const entries = Array.from(byExit.entries())
      .map(([exit, direction]): [string, ObjRef] => [direction, exit])
      .sort(([a], [b]) => a.localeCompare(b));
    const exits = await Promise.all(entries.map(async ([direction, exit]) => {
      let summary: ScopedObjectSummary;
      try {
        summary = await this.scopedObjectSummary(actor, exit, memo);
      } catch (err) {
        if (isReadAvailabilityError(err)) return null;
        throw err;
      }
      const dest = await this.propOrNullForActorAsync(actor, exit, "dest", memo);
      return {
        id: exit,
        name: summary.name,
        aliases: summary.aliases,
        direction,
        dest: typeof dest === "string" ? dest : null
      };
    }));
    return exits.filter((item): item is NonNullable<typeof item> => item !== null);
  }

  private preferExitDirection(candidate: string, current: string): boolean {
    const canonical = new Set(["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest", "out"]);
    const candidateCanonical = canonical.has(candidate);
    const currentCanonical = canonical.has(current);
    if (candidateCanonical !== currentCanonical) return candidateCanonical;
    if (candidate.length !== current.length) return candidate.length > current.length;
    return candidate.localeCompare(current) < 0;
  }

  async builderCreateObject(actor: ObjRef, parentRef: ObjRef, opts: WooValue, surfaceClass: ObjRef): Promise<WooValue> {
    this.assertBuilderActor(actor, surfaceClass);
    if (await this.remoteHostForObject(parentRef)) {
      throw wooError("E_CROSS_HOST_WRITE", `cross-host object creation is not atomic under ${parentRef}`, { actor, parent: parentRef });
    }
    const options = progOptions(opts);
    const location = optionObjOrNull(options, "location", null);
    if (location && await this.remoteHostForObject(location)) {
      throw wooError("E_CROSS_HOST_WRITE", `cross-host object placement is not atomic in ${location}`, { actor, parent: parentRef, location });
    }
    this.assertCanBuildChild(actor, parentRef, actor);
    if (location) {
      this.object(location);
      if (this.isSpaceLike(location) && !this.hasPresence(actor, location) && !this.isWizard(actor)) {
        throw wooError("E_PERM", `${actor} is not present in ${location}`, { actor, location });
      }
    }
    const displayName = optionMaybeString(options, "name") ?? null;
    const description = optionMaybeString(options, "description") ?? null;
    const aliases = optionStringList(options, "aliases", []);
    const anchor = location && this.isSpaceLike(location) ? location : null;
    const id = this.createBuilderObject(parentRef, actor, anchor, {
      location,
      name: displayName ?? undefined,
      fertile: optionBool(options, "fertile", false)
    });
    if (displayName !== null) this.setProp(id, "name", displayName);
    if (description !== null) this.setProp(id, "description", description);
    if (aliases.length > 0) this.setProp(id, "aliases", aliases);
    return { ok: true, id, parent: parentRef, owner: actor, location, dry_run: false };
  }

  async builderChparent(actor: ObjRef, objRef: ObjRef, parentRef: ObjRef, opts: WooValue, surfaceClass: ObjRef): Promise<WooValue> {
    this.assertBuilderActor(actor, surfaceClass);
    const options = progOptions(opts);
    const dryRun = optionBool(options, "dry_run", false);
    if (await this.remoteHostForObject(objRef) || await this.remoteHostForObject(parentRef)) {
      throw wooError("E_CROSS_HOST_WRITE", `cross-host chparent is not atomic: ${objRef} -> ${parentRef}`, { actor, obj: objRef, parent: parentRef });
    }
    this.assertCanBuildOwnedObject(actor, objRef);
    this.assertCanBuildChild(actor, parentRef, actor);
    if (objRef === parentRef || this.inheritsFrom(parentRef, objRef)) throw wooError("E_RECMOVE", "recursive parent change", { obj: objRef, parent: parentRef });
    if (this.inheritsFrom(objRef, "$actor") && !this.inheritsFrom(parentRef, "$actor")) {
      throw wooError("E_PERM", "actors can only be reparented under actor classes", { actor, obj: objRef, parent: parentRef });
    }
    const previousParent = this.object(objRef).parent;
    const result = { ok: true, dry_run: dryRun, id: objRef, parent: parentRef, previous_parent: previousParent };
    if (dryRun) return result;
    this.chparentLocal(objRef, parentRef);
    return result;
  }

  /**
   * The single `recycle(obj, opts?)` builtin — replaces the former
   * builder_recycle / wiz_force_recycle pair. Per spec/semantics/recycle.md
   * §RC1–RC6.
   *
   * Authority (RC2): the calling `progr` must be a wizard or `obj.owner` —
   * equivalent to LambdaMOO's `controls(progr, oid)`. The substrate gates on
   * `progr` (the verb's effective principal), not `actor` (the original
   * caller), so a verb running with elevated authority can recycle objects it
   * owns even when the actor that triggered the verb cannot. The `actor` is
   * preserved separately for audit and observation traceability.
   *
   * opts:
   *   - dry_run:        bool — preview the impact, no mutation.
   *   - force:          bool — bypass §RC3a empty-children safety check.
   *                     Available to anyone with §RC2 authority. The substrate
   *                     always grafts/displaces; the check exists as a
   *                     guard against fat-finger destruction of populated
   *                     classes/containers.
   *   - force_reserved: bool — wizard-only (checked against `actor`, not
   *                     `progr`). Bypasses §RC6 reserved-list (universal
   *                     classes other than hard floor) and terminates live
   *                     actor sessions before apply. Hard floor ($system,
   *                     $root, $nowhere) and pre-flights A3/A4 still apply.
   *                     Records a wiz_force_recycle wizard_action audit and
   *                     emits a wiz_force_recycle observation. Gating on
   *                     actor (not progr) prevents privilege escalation
   *                     through catalog-owned wrappers: a non-wizard caller
   *                     cannot smuggle force_reserved into a wizard-owned
   *                     wrapper that forwards opts unchanged.
   *   - reason:         str — audit text (used when force_reserved is true).
   */
  async recycleChecked(progr: ObjRef, actor: ObjRef, objRef: ObjRef, opts: WooValue, ctx?: CallContext): Promise<WooValue> {
    const options = progOptions(opts);
    const dryRun = optionBool(options, "dry_run", false);
    const force = optionBool(options, "force", false);
    const forceReserved = optionBool(options, "force_reserved", false);
    const reason = optionMaybeString(options, "reason") ?? null;

    // force_reserved gates on actor, not progr. The opt expresses end-user
    // intent to invoke RC6.1 sweeping authority (terminate sessions, bypass
    // reserved-list); a wizard-owned wrapper forwarding opts must not
    // launder that intent on behalf of a non-wizard caller.
    if (forceReserved && !this.isWizard(actor)) {
      throw wooError("E_PERM", "wizard authority required for force_reserved", { progr, actor, obj: objRef });
    }

    const obj = this.object(objRef);
    this.assertCanBuildOwnedObject(progr, objRef);

    const hardFloor = new Set(["$system", "$root", "$nowhere"]);
    if (hardFloor.has(objRef)) {
      throw wooError("E_INVARG", `${objRef} cannot be recycled from inside the running world`, objRef);
    }

    if (!forceReserved) {
      this.assertNotReservedForRecycle(objRef);
      if (this.inheritsFrom(objRef, "$actor") && this.hasLiveSessions(objRef)) {
        throw wooError("E_PERM", "actor has live sessions; cannot be recycled (wizard may pass force_reserved: true to terminate sessions)", { progr, actor, obj: objRef });
      }
    }

    const anchored = this.findAnchoredDescendants(objRef);
    if (anchored.length > 0) throw wooError("E_NACC", `${objRef} has anchored descendants`, { obj: objRef, descendants: anchored as WooValue });

    if (await this.remoteHostForObject(objRef)) {
      throw wooError("E_CROSS_HOST_WRITE", `cross-host recycle is not atomic: ${objRef}`, { progr, actor, obj: objRef });
    }
    if (obj.parent && obj.parent !== "$nowhere" && await this.remoteHostForObject(obj.parent)) {
      throw wooError("E_CROSS_HOST_WRITE", `recycle would cross clusters via parent: ${objRef} -> ${obj.parent}`, { progr, actor, obj: objRef, parent: obj.parent });
    }
    if (obj.location && obj.location !== "$nowhere" && await this.remoteHostForObject(obj.location)) {
      throw wooError("E_CROSS_HOST_WRITE", `recycle would cross clusters via location: ${objRef} -> ${obj.location}`, { progr, actor, obj: objRef, location: obj.location });
    }
    for (const child of obj.children) {
      if (child !== "$nowhere" && await this.remoteHostForObject(child)) {
        throw wooError("E_CROSS_HOST_WRITE", `recycle would cross clusters via child: ${objRef} -> ${child}`, { progr, actor, obj: objRef, child });
      }
    }
    for (const content of obj.contents) {
      if (content !== "$nowhere" && await this.remoteHostForObject(content)) {
        throw wooError("E_CROSS_HOST_WRITE", `recycle would cross clusters via content: ${objRef} -> ${content}`, { progr, actor, obj: objRef, content });
      }
    }

    const sessionsToKill = forceReserved && this.inheritsFrom(objRef, "$actor") ? this.liveSessionsForActor(objRef) : [];
    const impact: Record<string, WooValue> = {
      id: objRef,
      parent: obj.parent,
      location: obj.location,
      child_count: obj.children.size,
      children: Array.from(obj.children).sort(),
      contents_count: obj.contents.size,
      contents: Array.from(obj.contents).sort(),
      own_verbs: obj.verbs.length,
      own_properties: obj.propertyDefs.size
    };
    if (forceReserved) impact.sessions_to_kill = sessionsToKill.map((s) => s.id) as WooValue;

    // RC3a: empty-children safety check.
    if (!force && (obj.children.size > 0 || obj.contents.size > 0)) {
      throw wooError("E_RECMOVE", `${objRef} still has children or contents (pass force: true to recycle anyway)`, impact as WooValue);
    }

    if (dryRun) {
      const result: Record<string, WooValue> = { ok: true, dry_run: true, id: objRef, impact: impact as WooValue };
      if (forceReserved) result.sessions_killed = 0;
      return result;
    }

    for (const session of sessionsToKill) {
      this.endSession(session.id);
    }
    const sessions_killed = sessionsToKill.length;

    await this.invokeRecycleHandler(objRef, ctx);
    await this.assertPostHandlerCollocation(progr, objRef);
    this.recycleObjectLocal(objRef);
    try {
      this.reconcileTombstoneRefsInSystem();
    } catch {
      // Best-effort post-commit corename sweep; see RC3 step 10.
    }

    if (forceReserved) {
      this.recordWizardAction(actor, "force_recycle", { obj: objRef, reason: reason as WooValue, sessions_killed });
      if (ctx) {
        const event: Observation = {
          type: "wiz_force_recycle",
          actor,
          obj: objRef,
          reason: reason as WooValue,
          sessions_killed,
          ts: Date.now(),
          source: objRef
        };
        if (ctx.observe) ctx.observe(event);
        else ctx.observations.push(event);
      }
    }

    const result: Record<string, WooValue> = { ok: true, dry_run: false, id: objRef, impact: impact as WooValue };
    if (forceReserved) result.sessions_killed = sessions_killed;
    return result;
  }

  /**
   * Apply step 1: dispatch :recycle on `obj` if defined. Resolves via
   * inherited verb-lookup so a handler on any ancestor fires.
   *
   * Errors are caught:
   *   - E_VERBNF: silent (no handler is fine; this is the spec default).
   *   - other errors: surfaced as a $recycle_handler_error observation on
   *     the outer frame (or logged if no ctx is available).
   *
   * Per spec/semantics/recycle.md §RC4, the handler runs with progr equal
   * to the resolved verb's owner (standard programmer discipline), this =
   * obj, caller = obj. Recycle proceeds regardless of handler outcome.
   */
  /**
   * Apply step 1a: re-verify A4 cluster collocation after the :recycle
   * handler has run. The handler may have moved obj into another cluster,
   * reparented it, relocated it, or introduced cross-cluster
   * children/contents — pre-flight only checked the world as it was
   * before the handler. If the recheck fails, abort: the handler's
   * intra-cluster mutations roll back with the host transaction;
   * cross-cluster mutations are explicitly out of scope (§RC3.1).
   *
   * Used by `recycleChecked` (force or non-force path) so all flavors
   * enforce the same atomicity invariant.
   */
  private async assertPostHandlerCollocation(actor: ObjRef, objRef: ObjRef): Promise<void> {
    if (await this.remoteHostForObject(objRef)) {
      throw wooError("E_CROSS_HOST_WRITE", `recycle: handler moved obj across clusters: ${objRef}`, { actor, obj: objRef });
    }
    const objAfter = this.object(objRef);
    if (objAfter.parent && objAfter.parent !== "$nowhere" && await this.remoteHostForObject(objAfter.parent)) {
      throw wooError("E_CROSS_HOST_WRITE", `recycle: handler reparented across clusters: ${objRef} -> ${objAfter.parent}`, { actor, obj: objRef, parent: objAfter.parent });
    }
    if (objAfter.location && objAfter.location !== "$nowhere" && await this.remoteHostForObject(objAfter.location)) {
      throw wooError("E_CROSS_HOST_WRITE", `recycle: handler relocated across clusters: ${objRef} -> ${objAfter.location}`, { actor, obj: objRef, location: objAfter.location });
    }
    for (const child of objAfter.children) {
      if (child !== "$nowhere" && await this.remoteHostForObject(child)) {
        throw wooError("E_CROSS_HOST_WRITE", `recycle: handler introduced cross-cluster child: ${objRef} -> ${child}`, { actor, obj: objRef, child });
      }
    }
    for (const content of objAfter.contents) {
      if (content !== "$nowhere" && await this.remoteHostForObject(content)) {
        throw wooError("E_CROSS_HOST_WRITE", `recycle: handler introduced cross-cluster content: ${objRef} -> ${content}`, { actor, obj: objRef, content });
      }
    }
  }

  private async invokeRecycleHandler(objRef: ObjRef, ctx?: CallContext): Promise<void> {
    let verbExists = false;
    try {
      this.resolveVerb(objRef, "recycle");
      verbExists = true;
    } catch (err) {
      if (isErrorValue(err) && err.code === "E_VERBNF") return;
      throw err;
    }
    if (!verbExists) return;

    const handlerCtx: CallContext = ctx
      ? { ...ctx, caller: objRef, callerPerms: ctx.progr }
      : {
          world: this,
          space: this.object(objRef).anchor ?? "#-1",
          seq: -1,
          session: null,
          actor: objRef,
          player: objRef,
          caller: objRef,
          callerPerms: this.object(objRef).owner,
          progr: this.object(objRef).owner,
          thisObj: objRef,
          verbName: "recycle",
          definer: objRef,
          message: { actor: objRef, target: objRef, verb: "recycle", args: [] },
          observations: [],
          hostMemo: createHostOperationMemo(),
          observe: () => {}
        };

    try {
      await this.dispatch(handlerCtx, objRef, "recycle", []);
    } catch (err) {
      if (isErrorValue(err) && err.code === "E_VERBNF") return;
      const code = isErrorValue(err) ? err.code : "E_INTERNAL";
      const message = isErrorValue(err) ? err.message ?? "" : err instanceof Error ? err.message : String(err);
      const event: Observation = {
        type: "$recycle_handler_error",
        obj: objRef,
        code,
        message,
        source: objRef
      };
      if (ctx) {
        if (ctx.observe) ctx.observe(event);
        else ctx.observations.push(event);
      }
      // Recycle proceeds either way.
    }
  }

  /**
   * Reserved-object guard for recycle (§RC6 forbidden list, except live
   * actors which are handled separately at the wrapper). Raises E_INVARG
   * if the target is on the list.
   */
  private assertNotReservedForRecycle(objRef: ObjRef): void {
    const reserved = new Set([
      "$system",
      "$nowhere",
      "$root",
      "$actor",
      "$player",
      "$wiz",
      "$sequenced_log",
      "$space",
      "$thing"
    ]);
    if (reserved.has(objRef)) {
      throw wooError("E_INVARG", `cannot recycle reserved object: ${objRef}`, objRef);
    }
  }

  /**
   * Pre-flight A3: find any local objects whose `anchor` chain transitively
   * resolves to `obj`. Per spec/semantics/recycle.md §RC3 pre-flight A3,
   * the check is bounded to obj's own host because anchor co-residency
   * (objects.md §4.1) places transitively-anchored objects on the anchor
   * root's host.
   */
  private findAnchoredDescendants(obj: ObjRef): ObjRef[] {
    const out: ObjRef[] = [];
    for (const [id, candidate] of this.objects) {
      if (id === obj) continue;
      let cursor: ObjRef | null = candidate.anchor;
      const seen = new Set<ObjRef>();
      while (cursor && !seen.has(cursor)) {
        if (cursor === obj) {
          out.push(id);
          break;
        }
        seen.add(cursor);
        cursor = this.objects.has(cursor) ? this.object(cursor).anchor : null;
      }
    }
    return out.sort();
  }

  async builderSetProperty(actor: ObjRef, objRef: ObjRef, name: string, value: WooValue, opts: WooValue, surfaceClass: ObjRef): Promise<WooValue> {
    this.assertBuilderActor(actor, surfaceClass);
    const options = progOptions(opts);
    if (await this.remoteHostForObject(objRef)) {
      throw wooError("E_CROSS_HOST_WRITE", `cross-host property writes are not atomic: ${objRef}.${name}`, { actor, obj: objRef, property: name });
    }
    const target = this.object(objRef);
    const expectedVersion = optionNullableInt(options, "expected_version");
    const currentVersion = target.propertyVersions.get(name) ?? null;
    let exists = true;
    try {
      this.propertyInfo(objRef, name);
    } catch (err) {
      if (!isErrorValue(err) || err.code !== "E_PROPNF") throw err;
      exists = false;
    }
    if (expectedVersion !== null && currentVersion !== expectedVersion) {
      throw wooError("E_VERSION", "property value version conflict", { expected: expectedVersion, actual: currentVersion });
    }
    if (!exists) {
      this.assertCanBuildOwnedObject(actor, objRef);
      this.defineProperty(objRef, { name, defaultValue: null, owner: actor, perms: "rw", typeHint: typeHintForValue(value) });
    } else if (!this.canWriteProperty(actor, objRef, name)) {
      throw wooError("E_PERM", `${actor} cannot write ${objRef}.${name}`, { actor, obj: objRef, property: name });
    }
    this.setProp(objRef, name, value);
    return {
      ok: true,
      id: objRef,
      name,
      version: target.propertyVersions.get(name) ?? 0,
      info: this.propertyInfo(objRef, name) as WooValue
    };
  }

  builderInspect(actor: ObjRef, objRef: ObjRef, opts: WooValue, surfaceClass: ObjRef): WooValue {
    this.assertBuilderActor(actor, surfaceClass);
    return this.authoringInspect(actor, objRef, opts, { includeSourceAllowed: false, requireProgrammer: false });
  }

  builderSearch(actor: ObjRef, query: string, opts: WooValue, surfaceClass: ObjRef): WooValue {
    this.assertBuilderActor(actor, surfaceClass);
    return this.authoringSearch(actor, query, opts, { includeSourceAllowed: false });
  }

  programmerResolveVerb(actor: ObjRef, objRef: ObjRef, descriptor: WooValue, surfaceClass: ObjRef): WooValue {
    this.assertProgrammerActor(actor, surfaceClass);
    const walk: Record<string, WooValue>[] = [];
    const resolved =
      typeof descriptor === "number"
        ? this.resolveVerbSlotWithWalk(actor, objRef, descriptor, walk)
        : this.resolveVerbWithWalk(actor, objRef, assertVerbNameDescriptor(descriptor), walk);
    return {
      ...this.verbSummaryForActor(actor, resolved.definer, resolved.verb, { includeSource: true }),
      walk: walk as unknown as WooValue
    };
  }

  programmerListVerb(actor: ObjRef, objRef: ObjRef, descriptor: WooValue, opts: WooValue, surfaceClass: ObjRef): WooValue {
    this.assertProgrammerActor(actor, surfaceClass);
    const options = progOptions(opts);
    const includeSource = optionBool(options, "include_source", true);
    const walk: Record<string, WooValue>[] = [];
    const resolved =
      typeof descriptor === "number"
        ? this.resolveVerbSlotWithWalk(actor, objRef, descriptor, walk)
        : this.resolveVerbWithWalk(actor, objRef, assertVerbNameDescriptor(descriptor), walk);
    return {
      ...this.verbSummaryForActor(actor, resolved.definer, resolved.verb, { includeSource }),
      walk: walk as unknown as WooValue
    };
  }

  programmerInspect(actor: ObjRef, objRef: ObjRef, opts: WooValue, surfaceClass: ObjRef): WooValue {
    return this.authoringInspect(actor, objRef, opts, { includeSourceAllowed: true, requireProgrammer: true, programmerSurface: surfaceClass });
  }

  programmerSearch(actor: ObjRef, query: string, opts: WooValue, surfaceClass: ObjRef): WooValue {
    this.assertProgrammerActor(actor, surfaceClass);
    return this.authoringSearch(actor, query, opts, { includeSourceAllowed: true });
  }

  async programmerInstallVerb(actor: ObjRef, objRef: ObjRef, descriptor: WooValue, source: string, opts: WooValue, surfaceClass: ObjRef): Promise<WooValue> {
    this.assertProgrammerActor(actor, surfaceClass);
    if (await this.remoteHostForObject(objRef)) {
      throw wooError("E_CROSS_HOST_WRITE", `cross-host verb installs are not atomic: ${objRef}`, { actor, obj: objRef });
    }
    this.assertCanAuthorObject(actor, objRef);
    const options = progOptions(opts);
    const dryRun = optionBool(options, "dry_run", false);
    if (Object.prototype.hasOwnProperty.call(options, "perms")) {
      return sourceInstallFailure(dryRun, "E_INVARG", "opts.perms is not accepted; verb source header is canonical");
    }
    const mode = optionString(options, "mode", "upsert");
    if (!["upsert", "define", "set_code"].includes(mode)) throw wooError("E_INVARG", `unknown install mode: ${mode}`, mode);
    const append = optionBool(options, "append", false);
    const expectedVersion = optionNullableInt(options, "expected_version");
    const compiled = compileVerb(source);
    const selected = this.selectOwnVerbForInstall(objRef, descriptor, { mode, append });
    if ((selected.current?.version ?? null) !== expectedVersion && expectedVersion !== null) {
      throw wooError("E_VERSION", "verb version conflict", { expected: expectedVersion, actual: selected.current?.version ?? null });
    }
    if (!compiled.ok || !compiled.bytecode) {
      return sourceInstallSummary({
        ok: false,
        dryRun,
        current: selected.current,
        diagnostics: compiled.diagnostics as unknown as WooValue,
        metadata: compiled.metadata as WooValue | undefined,
        slot: selected.slot
      });
    }
    if (compiled.metadata?.name && compiled.metadata.name !== selected.name) {
      return sourceInstallFailure(dryRun, "E_COMPILE", `verb header names :${compiled.metadata.name}, but install target is :${selected.name}`, selected.current, selected.slot, compiled.metadata as WooValue);
    }
    const version = (selected.current?.version ?? 0) + 1;
    const parsedPerms = normalizeVerbPerms(
      compiled.metadata?.perms ?? selected.current?.perms ?? "rx",
      compiled.metadata?.perms ? false : selected.current?.direct_callable === true
    );
    const summary = sourceInstallSummary({
      ok: true,
      dryRun,
      current: selected.current,
      diagnostics: [],
      metadata: compiled.metadata as WooValue | undefined,
      slot: selected.slot,
      version
    });
    if (dryRun) return summary;
    const finalBytecode = { ...compiled.bytecode, version };
    // Re-classify on every install — analyzer drives purity, manifest-style
    // claims aren't available on this surface, and a `pure` flag set by an
    // earlier install must NOT carry over silently when the source changes.
    const pure = combineVerbPurity(analyzeBytecodePurity(finalBytecode), undefined, `${objRef}:${selected.name}`);
    this.addVerb(objRef, {
      kind: "bytecode",
      name: selected.name,
      aliases: selected.current?.aliases ?? [],
      owner: actor,
      perms: parsedPerms.perms,
      arg_spec: compiled.metadata?.arg_spec ?? selected.current?.arg_spec ?? {},
      direct_callable: parsedPerms.directCallable,
      skip_presence_check: selected.current?.skip_presence_check,
      tool_exposed: selected.current?.tool_exposed,
      pure: pure || undefined,
      calls: compiled.metadata?.calls,
      source,
      source_hash: compiled.source_hash ?? hashSource(source),
      bytecode: finalBytecode,
      version,
      line_map: compiled.line_map ?? {}
    }, { append: selected.append, slot: selected.current ? selected.slot : undefined });
    // Run propagation so a transitively-pure new verb (and any callers that
    // depend on it) get their flag updated to match the call graph.
    propagateVerbPurity(this);
    return summary;
  }

  async programmerSetVerbInfo(actor: ObjRef, objRef: ObjRef, descriptor: WooValue, opts: WooValue, surfaceClass: ObjRef): Promise<WooValue> {
    this.assertProgrammerActor(actor, surfaceClass);
    if (await this.remoteHostForObject(objRef)) {
      throw wooError("E_CROSS_HOST_WRITE", `cross-host verb metadata writes are not atomic: ${objRef}`, { actor, obj: objRef });
    }
    this.assertCanAuthorObject(actor, objRef);
    const options = progOptions(opts);
    const dryRun = optionBool(options, "dry_run", false);
    const expectedVersion = optionNullableInt(options, "expected_version");
    const selected = this.selectOwnVerbSlot(objRef, descriptor);
    const current = selected.verb;
    if (expectedVersion !== null && current.version !== expectedVersion) {
      throw wooError("E_VERSION", "verb version conflict", { expected: expectedVersion, actual: current.version });
    }
    // Permission bits are metadata edits, deliberately separate from source install.
    const directCallable = optionMaybeBool(options, "direct_callable") ?? current.direct_callable === true;
    const perms = optionMaybeString(options, "perms") ?? current.perms;
    const parsedPerms = normalizeVerbPerms(perms, directCallable);
    const next: VerbDef = {
      ...current,
      aliases: hasOption(options, "aliases") ? optionStringList(options, "aliases", []) : current.aliases,
      arg_spec: hasOption(options, "arg_spec") ? assertMap(options.arg_spec) : current.arg_spec,
      perms: parsedPerms.perms,
      direct_callable: parsedPerms.directCallable,
      skip_presence_check: optionMaybeBool(options, "skip_presence_check") ?? current.skip_presence_check,
      tool_exposed: optionMaybeBool(options, "tool_exposed") ?? current.tool_exposed,
      version: current.version + 1
    } as VerbDef;
    const result = {
      ok: true,
      dry_run: dryRun,
      id: objRef,
      slot: selected.slot,
      version: next.version,
      before: this.verbSummaryForActor(actor, objRef, current, { includeSource: false }) as WooValue,
      after: this.verbSummaryForActor(actor, objRef, next, { includeSource: false }) as WooValue
    };
    if (dryRun) return result;
    this.addVerb(objRef, next, { slot: selected.slot });
    return result;
  }

  async programmerSetPropertyInfo(actor: ObjRef, objRef: ObjRef, name: string, opts: WooValue, surfaceClass: ObjRef): Promise<WooValue> {
    this.assertProgrammerActor(actor, surfaceClass);
    this.assertOrdinaryPropertyName(name);
    if (await this.remoteHostForObject(objRef)) {
      throw wooError("E_CROSS_HOST_WRITE", `cross-host property metadata writes are not atomic: ${objRef}.${name}`, { actor, obj: objRef, property: name });
    }
    this.assertCanAuthorObject(actor, objRef);
    const options = progOptions(opts);
    const dryRun = optionBool(options, "dry_run", false);
    const mode = optionString(options, "mode", "upsert");
    if (!["upsert", "define", "update", "delete"].includes(mode)) throw wooError("E_INVARG", `unknown property-info mode: ${mode}`, mode);
    const expectedVersion = optionNullableInt(options, "expected_version");
    const obj = this.object(objRef);
    const current = obj.propertyDefs.get(name) ?? null;
    if (mode === "define" && current) throw wooError("E_INVARG", `property already exists: ${objRef}.${name}`, { obj: objRef, property: name });
    if ((mode === "update" || mode === "delete") && !current) throw wooError("E_PROPNF", `property not defined on ${objRef}: ${name}`, { obj: objRef, property: name });
    if (expectedVersion !== null && (current?.version ?? null) !== expectedVersion) {
      throw wooError("E_VERSION", "property definition version conflict", { expected: expectedVersion, actual: current?.version ?? null });
    }
    const before = current ? propertyDefSummary(current, objRef) : null;
    if (mode === "delete") {
      const result = { ok: true, dry_run: dryRun, id: objRef, name, deleted: true, before: before as WooValue };
      if (dryRun) return result;
      obj.propertyDefs.delete(name);
      obj.properties.delete(name);
      obj.propertyVersions.delete(name);
      obj.modified = Date.now();
      this.persistObject(objRef);
      this.persist();
      return result;
    }
    const owner = optionMaybeString(options, "owner") ?? current?.owner ?? actor;
    if (owner !== actor && !this.isWizard(actor)) throw wooError("E_PERM", `${actor} cannot create property ${objRef}.${name} owned by ${owner}`, { actor, obj: objRef, property: name, owner });
    const next: PropertyDef = {
      name,
      owner,
      perms: optionMaybeString(options, "perms") ?? current?.perms ?? "rw",
      typeHint: optionMaybeString(options, "type_hint") ?? current?.typeHint,
      defaultValue: hasOption(options, "default") ? cloneValue(options.default) : cloneValue(current?.defaultValue ?? null),
      version: (current?.version ?? 0) + 1
    };
    const result = {
      ok: true,
      dry_run: dryRun,
      id: objRef,
      name,
      version: next.version,
      before: before as WooValue,
      after: propertyDefSummary(next, objRef) as WooValue
    };
    if (dryRun) return result;
    obj.propertyDefs.set(name, next);
    if (!obj.properties.has(name)) {
      obj.properties.set(name, cloneValue(next.defaultValue));
      obj.propertyVersions.set(name, 1);
    }
    obj.modified = Date.now();
    this.persistObject(objRef);
    this.persist();
    return result;
  }

  programmerTrace(actor: ObjRef, _objRef: ObjRef, _descriptor: WooValue, _opts: WooValue, surfaceClass: ObjRef): WooValue {
    this.assertProgrammerActor(actor, surfaceClass);
    throw wooError("E_NOT_IMPLEMENTED", "programmer trace is deferred to v1.1");
  }

  async editorInvoke(ctx: CallContext, editorRef: ObjRef, targetRef: ObjRef, descriptor: WooValue, opts: WooValue, surfaceClass: ObjRef): Promise<WooValue> {
    this.assertProgrammerActor(ctx.actor, surfaceClass);
    if (await this.remoteHostForObject(editorRef) || await this.remoteHostForObject(targetRef)) {
      throw wooError("E_CROSS_HOST_WRITE", `editor sessions and target installs must share a host: ${editorRef} -> ${targetRef}`, { editor: editorRef, target: targetRef });
    }
    this.assertEditorObject(editorRef);
    const options = progOptions(opts);
    const existing = this.editorSessionOrNull(editorRef, ctx.actor);
    let replacedPrevious: Record<string, WooValue> | null = null;
    if (existing) {
      if (existing.dirty && (existing.target !== targetRef || !valuesEqual(existing.descriptor, descriptor))) {
        throw wooError("E_INVARG", "dirty editor session already active; save, pause, or abort it first", this.editorSessionSummary(existing) as WooValue);
      }
      if (existing.target === targetRef && valuesEqual(existing.descriptor, descriptor)) {
        const now = Date.now();
        await this.moveEditorActor(ctx, editorRef, existing.previous_location);
        await this.observeToSpace(ctx, editorRef, { type: "editor_entered", actor: ctx.actor, editor: editorRef, target: targetRef, slot: existing.slot, ts: now });
        return { ...this.editorSessionSummary(existing), resumed: true, editor: editorRef };
      }
      replacedPrevious = this.editorSessionSummary(existing);
    }

    const listed = assertMap(this.programmerListVerb(ctx.actor, targetRef, descriptor, { include_source: true }, surfaceClass));
    const source = listed.source;
    if (typeof source !== "string") throw wooError("E_PERM", `${ctx.actor} cannot read source for ${targetRef}:${String(descriptor)}`, { actor: ctx.actor, target: targetRef, descriptor });
    const now = Date.now();
    const previousLocation = replacedPrevious && typeof replacedPrevious.previous_location === "string"
      ? replacedPrevious.previous_location
      : await this.objectLocationChecked(ctx.actor, ctx.hostMemo);
    const session: VerbEditorSession = {
      actor: ctx.actor,
      target: targetRef,
      kind: "verb",
      descriptor: cloneValue(descriptor),
      slot: typeof listed.slot === "number" ? listed.slot : null,
      expected_version: optionNullableInt(options, "expected_version") ?? (typeof listed.version === "number" ? listed.version : null),
      buffer: source,
      dirty: false,
      diagnostics: [],
      started_at: now,
      updated_at: now,
      previous_location: previousLocation,
      surface_class: surfaceClass
    };
    this.setEditorSession(editorRef, ctx.actor, session);
    await this.moveEditorActor(ctx, editorRef, previousLocation);
    await this.observeToSpace(ctx, editorRef, { type: "editor_entered", actor: ctx.actor, editor: editorRef, target: targetRef, slot: session.slot, ts: now });
    const response: Record<string, WooValue> = { ...this.editorSessionSummary(session), resumed: false, editor: editorRef };
    if (replacedPrevious) response.replaced_previous = replacedPrevious as WooValue;
    return response;
  }

  editorWhat(ctx: CallContext, editorRef: ObjRef): WooValue {
    return this.editorSessionSummary(this.requireEditorSession(editorRef, ctx.actor)) as WooValue;
  }

  editorView(ctx: CallContext, editorRef: ObjRef, opts: WooValue): WooValue {
    const session = this.requireEditorSession(editorRef, ctx.actor);
    const options = progOptions(opts);
    const numbered = optionBool(options, "line_numbers", false);
    const lines = splitEditorLines(session.buffer);
    return {
      ...this.editorSessionSummary(session),
      buffer: session.buffer,
      lines: numbered ? lines.map((text, index) => ({ line: index + 1, text })) : lines
    } as WooValue;
  }

  editorReplace(ctx: CallContext, editorRef: ObjRef, text: string): WooValue {
    const session = this.requireEditorSession(editorRef, ctx.actor);
    session.buffer = text;
    session.dirty = true;
    session.updated_at = Date.now();
    session.diagnostics = [];
    this.setEditorSession(editorRef, ctx.actor, session);
    return this.editorSessionSummary(session) as WooValue;
  }

  editorInsert(ctx: CallContext, editorRef: ObjRef, line: number, text: string): WooValue {
    const session = this.requireEditorSession(editorRef, ctx.actor);
    const lines = splitEditorLines(session.buffer);
    const index = Math.floor(line) - 1;
    if (index < 0 || index > lines.length) throw wooError("E_RANGE", `insert line out of range: ${line}`, { line, max: lines.length + 1 });
    lines.splice(index, 0, text);
    session.buffer = lines.join("\n");
    session.dirty = true;
    session.updated_at = Date.now();
    session.diagnostics = [];
    this.setEditorSession(editorRef, ctx.actor, session);
    return this.editorSessionSummary(session) as WooValue;
  }

  editorDelete(ctx: CallContext, editorRef: ObjRef, start: number, end: number | null): WooValue {
    const session = this.requireEditorSession(editorRef, ctx.actor);
    const lines = splitEditorLines(session.buffer);
    const first = Math.floor(start);
    const last = end === null ? first : Math.floor(end);
    if (first < 1 || last < first || last > lines.length) throw wooError("E_RANGE", "delete line range out of range", { start, end: end ?? start, max: lines.length });
    lines.splice(first - 1, last - first + 1);
    session.buffer = lines.join("\n");
    session.dirty = true;
    session.updated_at = Date.now();
    session.diagnostics = [];
    this.setEditorSession(editorRef, ctx.actor, session);
    return this.editorSessionSummary(session) as WooValue;
  }

  async editorDryRun(ctx: CallContext, editorRef: ObjRef): Promise<WooValue> {
    const session = this.requireEditorSession(editorRef, ctx.actor);
    const result = assertMap(await this.programmerInstallVerb(ctx.actor, session.target, session.descriptor, session.buffer, {
      dry_run: true,
      expected_version: session.expected_version
    }, session.surface_class));
    session.diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
    session.updated_at = Date.now();
    this.setEditorSession(editorRef, ctx.actor, session);
    return result as WooValue;
  }

  async editorSave(ctx: CallContext, editorRef: ObjRef): Promise<WooValue> {
    const session = this.requireEditorSession(editorRef, ctx.actor);
    const result = assertMap(await this.programmerInstallVerb(ctx.actor, session.target, session.descriptor, session.buffer, {
      expected_version: session.expected_version
    }, session.surface_class));
    session.diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
    session.updated_at = Date.now();
    if (result.ok !== true) {
      this.setEditorSession(editorRef, ctx.actor, session);
      return result as WooValue;
    }
    this.deleteEditorSession(editorRef, ctx.actor);
    const destination = this.editorReturnLocation(session);
    await this.moveEditorActor(ctx, destination, null);
    await this.observeToSpace(ctx, editorRef, { type: "editor_saved", actor: ctx.actor, editor: editorRef, target: session.target, slot: session.slot, version: typeof result.version === "number" ? result.version : null, ts: Date.now() });
    return { ...result, exited_to: destination } as WooValue;
  }

  async editorPause(ctx: CallContext, editorRef: ObjRef): Promise<WooValue> {
    const session = this.requireEditorSession(editorRef, ctx.actor);
    const destination = this.editorReturnLocation(session);
    await this.moveEditorActor(ctx, destination, null);
    session.updated_at = Date.now();
    this.setEditorSession(editorRef, ctx.actor, session);
    return { ...this.editorSessionSummary(session), paused: true, exited_to: destination } as WooValue;
  }

  async editorAbort(ctx: CallContext, editorRef: ObjRef): Promise<WooValue> {
    const session = this.requireEditorSession(editorRef, ctx.actor);
    this.deleteEditorSession(editorRef, ctx.actor);
    const destination = this.editorReturnLocation(session);
    await this.moveEditorActor(ctx, destination, null);
    return { ...this.editorSessionSummary(session), aborted: true, exited_to: destination } as WooValue;
  }

  private authoringInspect(actor: ObjRef, objRef: ObjRef, opts: WooValue, policy: { includeSourceAllowed: boolean; requireProgrammer: boolean; programmerSurface?: ObjRef }): WooValue {
    if (policy.requireProgrammer) this.assertProgrammerActor(actor, policy.programmerSurface ?? actor);
    const options = progOptions(opts);
    const includeSource = policy.includeSourceAllowed && optionBool(options, "include_source", false);
    const maxChildren = optionInt(options, "max_children", 50, 0, 500);
    const maxInstances = optionInt(options, "max_instances", 50, 0, 500);
    const maxValueBytes = optionInt(options, "max_value_bytes", 512, 0, 16_384);
    const obj = this.object(objRef);
    const children = Array.from(obj.children).sort();
    const fertileChildren = children.filter((child) => this.object(child).flags.fertile === true);
    const instances = children.filter((child) => this.object(child).flags.fertile !== true);
    const parentChain: Record<string, WooValue>[] = [];
    let current: ObjRef | null = objRef;
    while (current) {
      const item = this.object(current);
      parentChain.push({
        id: current,
        name: item.name,
        owner: item.owner,
        own_verbs: item.verbs.length,
        own_properties: item.propertyDefs.size
      });
      current = item.parent;
    }

    const features = this.canCarryFeatures(objRef)
      ? this.featureList(objRef).map((feature) => {
          const featureObj = this.object(feature);
          return {
            id: feature,
            name: featureObj.name,
            verbs_contributed: uniqueVerbNames(featureObj.verbs).sort()
          };
        })
      : [];
    const attachedTo = this.attachedConsumersOf(objRef).slice(0, maxInstances);
    const ownProperties = this.ownPropertySummaries(actor, objRef, maxValueBytes);
    const inheritedProperties = this.inheritedPropertySummaries(actor, objRef, maxValueBytes);
    const ownVerbs = obj.verbs
      .map((verb) => this.verbSummaryForActor(actor, objRef, verb, { includeSource }));
    const inheritedVerbs = this.inheritedVerbSummaries(actor, objRef, includeSource);

    return {
      id: obj.id,
      owner: obj.owner,
      flags: {
        wizard: obj.flags.wizard === true,
        programmer: obj.flags.programmer === true,
        fertile: obj.flags.fertile === true
      },
      name: obj.name,
      description: this.propOrNullForActor(actor, objRef, "description"),
      parent: obj.parent,
      parent_chain: parentChain as unknown as WooValue,
      features: features as unknown as WooValue,
      children: children.slice(0, maxChildren),
      fertile_children: fertileChildren.slice(0, maxChildren),
      instances: instances.slice(0, maxInstances),
      attached_to: attachedTo,
      impact: {
        child_count: children.length,
        instance_count: instances.length,
        attached_to_count: this.attachedConsumersOf(objRef).length
      },
      location: obj.location,
      contents: Array.from(obj.contents).sort(),
      own_verbs: ownVerbs as unknown as WooValue,
      inherited_verbs: inheritedVerbs as unknown as WooValue,
      own_properties: ownProperties as unknown as WooValue,
      inherited_properties: inheritedProperties as unknown as WooValue
    };
  }

  private authoringSearch(actor: ObjRef, query: string, opts: WooValue, policy: { includeSourceAllowed: boolean }): WooValue {
    const options = progOptions(opts);
    const normalized = query.trim().toLowerCase();
    const scope = optionString(options, "scope", "actor_context");
    const limit = optionInt(options, "limit", 50, 1, 500);
    const defaultChannels = policy.includeSourceAllowed
      ? ["object_name", "verb_name", "verb_source", "property_name", "property_value"]
      : ["object_name", "property_name", "property_value"];
    const channels = new Set(optionStringList(options, "channels", defaultChannels));
    if (!policy.includeSourceAllowed) channels.delete("verb_source");
    const results: Record<string, WooValue>[] = [];
    let total = 0;
    const addResult = (result: Record<string, WooValue>): void => {
      total += 1;
      if (results.length < limit) results.push(result);
    };

    for (const id of this.progScopeObjectIds(actor, scope)) {
      const obj = this.object(id);
      if (channels.has("object_name") && textMatches(normalized, obj.id, obj.name, this.propOrNullForActor(actor, id, "description"))) {
        addResult({ kind: "object", channel: "object_name", id, name: obj.name });
      }
      if (channels.has("verb_name") || channels.has("verb_source")) {
        for (const verb of obj.verbs) {
          if (channels.has("verb_name") && textMatches(normalized, verb.name, ...verb.aliases)) {
            addResult({ kind: "verb", channel: "verb_name", id, verb: verb.name, definer: id, owner: verb.owner });
          }
          if (channels.has("verb_source") && this.canReadVerb(actor, verb) && textMatches(normalized, verb.source)) {
            addResult({ kind: "verb", channel: "verb_source", id, verb: verb.name, definer: id, owner: verb.owner });
          }
        }
      }
      if (channels.has("property_name") || channels.has("property_value")) {
        const propNames = new Set<string>([...obj.propertyDefs.keys(), ...obj.properties.keys()]);
        for (const prop of Array.from(propNames).sort()) {
          if (channels.has("property_name") && textMatches(normalized, prop)) {
            addResult({ kind: "property", channel: "property_name", id, property: prop });
          }
          if (channels.has("property_value") && this.canReadProperty(actor, id, prop)) {
            const value = this.propOrNullForActor(actor, id, prop);
            if (textMatches(normalized, valueSummary(value, 512))) {
              addResult({ kind: "property", channel: "property_value", id, property: prop });
            }
          }
        }
      }
    }

    return { query, scope, total, limit, results: results as unknown as WooValue };
  }

  canReadVerb(actor: ObjRef, verb: VerbDef): boolean {
    return this.canBypassPerms(actor) || verb.owner === actor || verb.perms.includes("r");
  }

  private assertProgrammerActor(actor: ObjRef, surfaceClass: ObjRef): void {
    const obj = this.object(actor);
    if (obj.flags.wizard === true) return;
    if (actor === surfaceClass) throw wooError("E_PERM", "programmer class surface required", { actor, surface: surfaceClass });
    if (!this.inheritsFrom(actor, surfaceClass)) throw wooError("E_PERM", "programmer class surface required", { actor, surface: surfaceClass });
    if (obj.flags.programmer === true) return;
    throw wooError("E_PERM", "programmer flag required", actor);
  }

  private assertBuilderActor(actor: ObjRef, surfaceClass: ObjRef): void {
    if (this.isWizard(actor)) return;
    if (actor === surfaceClass) throw wooError("E_PERM", "builder class surface required", { actor, surface: surfaceClass });
    if (this.inheritsFrom(actor, surfaceClass)) return;
    throw wooError("E_PERM", "builder class surface required", { actor, surface: surfaceClass });
  }

  private assertEditorObject(editorRef: ObjRef): void {
    if (!this.isEditorObject(editorRef)) throw wooError("E_TYPE", "editor must be space-like and define a private sessions property", { editor: editorRef });
  }

  private isEditorObject(editorRef: ObjRef): boolean {
    return this.inheritsFrom(editorRef, "$space") && this.editorSessionPropertyInfo(editorRef) !== null;
  }

  private editorSessionPropertyInfo(editorRef: ObjRef): PropertyDef | null {
    let current: ObjRef | null = editorRef;
    while (current) {
      const obj = this.object(current);
      const def = obj.propertyDefs.get("sessions");
      if (def) return def.perms === "" ? def : null;
      current = obj.parent;
    }
    return null;
  }

  private editorSessionMap(editorRef: ObjRef): Record<string, WooValue> {
    this.assertEditorObject(editorRef);
    const raw = this.propOrNull(editorRef, "sessions");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Record<string, WooValue>;
  }

  private editorSessionOrNull(editorRef: ObjRef, actor: ObjRef): VerbEditorSession | null {
    const raw = this.editorSessionMap(editorRef)[actor];
    if (raw === undefined) return null;
    // Lazy dangling-ref filter. Per spec/semantics/recycle.md §RC5
    // ("defer the check"): if the session's actor or target was recycled
    // since the session was stored, treat the session as gone. We do not
    // mutate storage here — that would be rolled back if the surrounding
    // call errors. Persisted cleanup is the wizard janitor's job
    // (directory_reconcile_corenames covers $system; editor cleanup is
    // catalog-side).
    if (this.tombstones.has(actor)) return null;
    let session: VerbEditorSession;
    try {
      session = parseVerbEditorSession(raw);
    } catch {
      return null;
    }
    if (this.tombstones.has(session.target)) return null;
    return session;
  }

  private requireEditorSession(editorRef: ObjRef, actor: ObjRef): VerbEditorSession {
    const session = this.editorSessionOrNull(editorRef, actor);
    if (!session) throw wooError("E_INVARG", `${actor} has no active editor session in ${editorRef}`, { actor, editor: editorRef });
    return session;
  }

  private setEditorSession(editorRef: ObjRef, actor: ObjRef, session: VerbEditorSession): void {
    const sessions = this.editorSessionMap(editorRef);
    sessions[actor] = serializeVerbEditorSession(session) as WooValue;
    this.setProp(editorRef, "sessions", sessions as WooValue);
  }

  private deleteEditorSession(editorRef: ObjRef, actor: ObjRef): void {
    const sessions = this.editorSessionMap(editorRef);
    delete sessions[actor];
    this.setProp(editorRef, "sessions", sessions as WooValue);
  }

  private editorSessionSummary(session: VerbEditorSession): Record<string, WooValue> {
    return {
      actor: session.actor,
      target: session.target,
      kind: session.kind,
      descriptor: cloneValue(session.descriptor),
      slot: session.slot,
      expected_version: session.expected_version,
      dirty: session.dirty,
      diagnostics: cloneValue(session.diagnostics as WooValue) as WooValue[],
      started_at: session.started_at,
      updated_at: session.updated_at,
      previous_location: session.previous_location,
      surface_class: session.surface_class
    };
  }

  private editorReturnLocation(session: VerbEditorSession): ObjRef {
    if (session.previous_location && this.objects.has(session.previous_location)) return session.previous_location;
    const home = this.objects.has(session.actor) ? this.propOrNull(session.actor, "home") : null;
    return typeof home === "string" && this.objects.has(home) ? home : "$nowhere";
  }

  private async moveEditorActor(ctx: CallContext, destination: ObjRef, previousLocation: ObjRef | null): Promise<void> {
    this.object(destination);
    const actor = ctx.actor;
    const current = await this.objectLocationChecked(actor, ctx.hostMemo);
    if (current && current !== destination && this.objects.has(current) && this.isSpaceLike(current)) {
      await this.updatePresenceChecked(actor, current, false, ctx);
    }
    if (this.isSpaceLike(destination)) {
      await this.updatePresenceChecked(actor, destination, true, ctx);
    } else if (ctx.session) {
      const session = this.sessions.get(ctx.session);
      if (session && session.actor === actor) {
        session.currentLocation = destination;
        this.persistSession(session);
      }
    }
    await this.moveObjectChecked(actor, destination);
    if (previousLocation && previousLocation !== destination && this.objects.has(actor) && this.objects.has(previousLocation) && this.isSpaceLike(previousLocation)) {
      await this.updatePresenceChecked(actor, previousLocation, false, ctx);
    }
  }

  private resolveVerbWithWalk(actor: ObjRef, objRef: ObjRef, name: string, walk: Record<string, WooValue>[]): ResolvedVerb {
    let current: ObjRef | null = objRef;
    while (current) {
      const match = this.ownVerbNamed(current, name);
      walk.push({ id: current, kind: "parent", matched: match !== null });
      if (match) return { definer: current, verb: match };
      current = this.object(current).parent;
    }
    if (this.canCarryFeatures(objRef)) {
      for (const feature of this.featureList(objRef)) {
        let featureCurrent: ObjRef | null = feature;
        while (featureCurrent) {
          const match = this.ownVerbNamed(featureCurrent, name);
          walk.push({ id: featureCurrent, kind: "feature", feature, matched: match !== null });
          if (match) return { definer: featureCurrent, verb: match };
          featureCurrent = this.object(featureCurrent).parent;
        }
      }
    }
    throw wooError("E_VERBNF", `verb not found: ${objRef}:${name}`, { obj: objRef, name, actor });
  }

  private resolveVerbSlotWithWalk(actor: ObjRef, objRef: ObjRef, slot: number, walk: Record<string, WooValue>[]): ResolvedVerb {
    if (!Number.isInteger(slot) || slot < 1) throw wooError("E_INVARG", "verb slot must be a positive integer", slot);
    const obj = this.object(objRef);
    const verb = obj.verbs[slot - 1];
    walk.push({ id: objRef, kind: "slot", slot, matched: verb !== undefined });
    if (!verb) throw wooError("E_VERBNF", `verb slot not found: ${objRef}:${slot}`, { obj: objRef, slot, actor });
    return { definer: objRef, verb };
  }

  private selectOwnVerbSlot(objRef: ObjRef, descriptor: WooValue): { slot: number; verb: VerbDef } {
    const obj = this.object(objRef);
    if (typeof descriptor === "number") {
      if (!Number.isInteger(descriptor) || descriptor < 1) throw wooError("E_INVARG", "verb slot must be a positive integer", descriptor);
      const verb = obj.verbs[descriptor - 1];
      if (!verb) throw wooError("E_VERBNF", `verb slot not found: ${objRef}:${descriptor}`, { obj: objRef, slot: descriptor });
      return { slot: descriptor, verb };
    }
    const name = assertVerbNameDescriptor(descriptor);
    const index = obj.verbs.findIndex((verb) => verb.name === name || verb.aliases.some((alias) => verbAliasMatches(alias, name)));
    if (index < 0) throw wooError("E_VERBNF", `own verb not found: ${objRef}:${name}`, { obj: objRef, name });
    return { slot: index + 1, verb: obj.verbs[index] };
  }

  private selectOwnVerbForInstall(
    objRef: ObjRef,
    descriptor: WooValue,
    options: { mode: string; append: boolean }
  ): { current: VerbDef | null; slot: number; name: string; append: boolean } {
    const obj = this.object(objRef);
    if (typeof descriptor === "number") {
      if (!Number.isInteger(descriptor) || descriptor < 1) throw wooError("E_INVARG", "verb slot must be a positive integer", descriptor);
      const current = obj.verbs[descriptor - 1] ?? null;
      if (!current) throw wooError("E_VERBNF", `verb slot not found: ${objRef}:${descriptor}`, { obj: objRef, slot: descriptor });
      if (options.mode === "define") throw wooError("E_INVARG", "define mode requires a name descriptor, not an existing slot", descriptor);
      return { current, slot: descriptor, name: current.name, append: false };
    }
    const descriptorName = assertVerbNameDescriptor(descriptor);
    // Installing source by name must bind the named slot, not any earlier
    // abbreviation alias. Otherwise a verb like `exitfunc` can be mistaken for
    // a `look` alias such as `ex*` and silently overwrite the wrong slot.
    const existingIndex = obj.verbs.findIndex((verb) => verb.name === descriptorName);
    const current = options.append ? null : existingIndex >= 0 ? obj.verbs[existingIndex] : null;
    const name = current?.name ?? descriptorName;
    if (options.mode === "define" && current) throw wooError("E_INVARG", `verb already exists: ${objRef}:${descriptorName}`, { obj: objRef, name: descriptorName });
    if (options.mode === "set_code" && !current) throw wooError("E_VERBNF", `verb not found for set_code: ${objRef}:${descriptorName}`, { obj: objRef, name: descriptorName });
    return {
      current,
      slot: current ? (current.slot ?? existingIndex + 1) : obj.verbs.length + 1,
      name,
      append: options.append || !current
    };
  }

  private ownVerbNamed(objRef: ObjRef, name: string): VerbDef | null {
    const obj = this.object(objRef);
    for (const verb of obj.verbs) {
      if (verb.name === name) return verb;
    }
    for (const verb of obj.verbs) {
      if (verb.aliases.some((alias) => verbAliasMatches(alias, name))) return verb;
    }
    return null;
  }

  private verbSummaryForActor(actor: ObjRef, definer: ObjRef, verb: VerbDef, options: { includeSource: boolean }): Record<string, WooValue> {
    const readable = this.canReadVerb(actor, verb);
    const summary: Record<string, WooValue> = {
      name: verb.name,
      slot: verb.slot ?? 0,
      aliases: verb.aliases,
      definer,
      owner: verb.owner,
      perms: verb.perms,
      arg_spec: verb.arg_spec as WooValue,
      version: verb.version,
      direct_callable: verb.direct_callable === true,
      tool_exposed: verb.tool_exposed === true,
      readable
    };
    if (readable && options.includeSource) {
      summary.source = verb.source;
      summary.line_map = verb.line_map as WooValue;
    }
    return summary;
  }

  private inheritedVerbSummaries(actor: ObjRef, objRef: ObjRef, includeSource: boolean): Record<string, WooValue>[] {
    const shadowed = new Set<string>(this.object(objRef).verbs.map((verb) => verb.name));
    const summaries: Record<string, WooValue>[] = [];
    let current = this.object(objRef).parent;
    while (current) {
      const obj = this.object(current);
      for (const verb of obj.verbs) {
        if (shadowed.has(verb.name)) continue;
        summaries.push(this.verbSummaryForActor(actor, current, verb, { includeSource }));
      }
      for (const verb of obj.verbs) shadowed.add(verb.name);
      current = obj.parent;
    }
    if (this.canCarryFeatures(objRef)) {
      for (const feature of this.featureList(objRef)) {
        let featureCurrent: ObjRef | null = feature;
        while (featureCurrent) {
          const obj = this.object(featureCurrent);
          for (const verb of obj.verbs) {
            if (shadowed.has(verb.name)) continue;
            summaries.push({ ...this.verbSummaryForActor(actor, featureCurrent, verb, { includeSource }), feature });
          }
          for (const verb of obj.verbs) shadowed.add(verb.name);
          featureCurrent = obj.parent;
        }
      }
    }
    return summaries.sort((left, right) => String(left.name).localeCompare(String(right.name)));
  }

  private ownPropertySummaries(actor: ObjRef, objRef: ObjRef, maxValueBytes: number): Record<string, WooValue>[] {
    const obj = this.object(objRef);
    const names = new Set<string>([...obj.propertyDefs.keys(), ...obj.properties.keys()]);
    return Array.from(names).sort().map((name) => this.propertySummaryForActor(actor, objRef, name, maxValueBytes, objRef));
  }

  private inheritedPropertySummaries(actor: ObjRef, objRef: ObjRef, maxValueBytes: number): Record<string, WooValue>[] {
    const seen = new Set<string>(this.object(objRef).propertyDefs.keys());
    const summaries: Record<string, WooValue>[] = [];
    let current = this.object(objRef).parent;
    while (current) {
      const obj = this.object(current);
      for (const name of obj.propertyDefs.keys()) {
        if (seen.has(name)) continue;
        seen.add(name);
        summaries.push(this.propertySummaryForActor(actor, objRef, name, maxValueBytes, current));
      }
      current = obj.parent;
    }
    return summaries;
  }

  private propertySummaryForActor(actor: ObjRef, objRef: ObjRef, name: string, maxValueBytes: number, fallbackDefiner: ObjRef): Record<string, WooValue> {
    const info = this.propertyInfo(objRef, name);
    const readable = this.canReadProperty(actor, objRef, name);
    const summary: Record<string, WooValue> = {
      name,
      owner: info.owner,
      perms: info.perms,
      defined_on: info.defined_on ?? fallbackDefiner,
      type_hint: info.type_hint ?? null,
      version: info.version,
      has_value: info.has_value === true,
      readable
    };
    if (readable) summary.value_summary = valueSummary(this.propOrNullForActor(actor, objRef, name), maxValueBytes);
    return summary;
  }

  private attachedConsumersOf(feature: ObjRef): ObjRef[] {
    const attached: ObjRef[] = [];
    for (const obj of this.objects.values()) {
      if (!this.canCarryFeatures(obj.id)) continue;
      if (this.featureList(obj.id).includes(feature)) attached.push(obj.id);
    }
    return attached.sort();
  }

  private progScopeObjectIds(actor: ObjRef, scope: string): ObjRef[] {
    const ids = new Set<ObjRef>();
    const add = (id: ObjRef | null | undefined): void => {
      if (id && this.objects.has(id)) ids.add(id);
    };
    const actorObj = this.object(actor);
    if (scope === "all") {
      for (const id of this.objects.keys()) add(id);
    } else if (scope === "owned") {
      for (const obj of this.objects.values()) if (obj.owner === actor) add(obj.id);
    } else {
      add(actor);
      add(actorObj.location);
      for (const item of actorObj.contents) add(item);
      if (actorObj.location && this.objects.has(actorObj.location)) {
        for (const item of this.object(actorObj.location).contents) add(item);
      }
      if (this.canCarryFeatures(actor)) {
        for (const feature of this.featureList(actor)) add(feature);
      }
      if (scope !== "actor_context" && scope !== "here") throw wooError("E_INVARG", `unknown prog search scope: ${scope}`, scope);
    }
    return Array.from(ids).sort();
  }

  createRuntimeObject(parent: ObjRef, owner: ObjRef, anchor: ObjRef | null = null, options: {
    progr?: ObjRef;
    location?: ObjRef | null;
    name?: string;
    description?: string;
    aliases?: string[];
    fertile?: boolean;
  } = {}): ObjRef {
    return this.withPersistenceDeferred(() => {
      this.object(parent);
      this.object(owner);
      if (anchor) this.object(anchor);
      const progr = options.progr ?? owner;
      this.assertCanCreateObject(progr, parent, owner);
      // Self-hosted instances cannot be anchored. Per
      // spec/semantics/objects.md §4.1, combining `instances_self_host = true`
      // with a non-null anchor would route the instance to its own DO (rule 1)
      // while declaring it a member of another cluster, breaking
      // co-residency. The recycle anchored-descendants check (recycle.md
      // §RC3 pre-flight A3) relies on this.
      if (anchor !== null && this.propOrNull(parent, "instances_self_host") === true) {
        throw wooError("E_INVARG", `cannot anchor a self-hosted instance`, { parent, anchor });
      }
      const location = options.location ?? null;
      if (location) this.object(location);
      const scope = runtimeObjectScope(anchor ?? parent);
      let id: ObjRef;
      do {
        id = `obj_${scope}_${this.objectCounter++}`;
      } while (this.objects.has(id));
      const flags: WooObject["flags"] = {};
      if (typeof options.fertile === "boolean") flags.fertile = options.fertile;
      this.createObject({
        id,
        parent,
        owner,
        anchor,
        location,
        name: options.name,
        flags
      });
      // WooObject.name is the display/core metadata; the inherited `name`
      // property is the source-level slot read by woocode (`this.name`).
      // Keep them mirrored while coalescing the object/property writes.
      if (typeof options.name === "string") this.setProp(id, "name", options.name);
      if (typeof options.description === "string") this.setProp(id, "description", options.description);
      if (Array.isArray(options.aliases) && options.aliases.length > 0) this.setProp(id, "aliases", options.aliases);
      this.persistCounters();
      return id;
    });
  }

  createAuthoredObject(actor: ObjRef, input: { parent: ObjRef; name?: string; description?: string; aliases?: WooValue[]; location?: ObjRef | null }): ObjRef {
    const parent = assertObj(input.parent);
    const location = input.location ?? null;
    if (location) {
      this.object(location);
      if (this.isSpaceLike(location) && !this.hasPresence(actor, location) && !this.isWizard(actor)) {
        throw wooError("E_PERM", `${actor} is not present in ${location}`);
      }
    }
    const anchor = location && this.isSpaceLike(location) ? location : null;
    const id = this.createRuntimeObject(parent, actor, anchor, { progr: actor, location, name: input.name ?? undefined });
    this.defineProperty(id, { name: "description", defaultValue: "", owner: actor, perms: "r", typeHint: "str" });
    this.defineProperty(id, { name: "aliases", defaultValue: [], owner: actor, perms: "r", typeHint: "list<str>" });
    if (typeof input.description === "string") this.setProp(id, "description", input.description);
    if (Array.isArray(input.aliases)) this.setProp(id, "aliases", input.aliases);
    return id;
  }

  moveAuthoredObject(actor: ObjRef, objRef: ObjRef, targetRef: ObjRef): void {
    this.assertCanAuthorObject(actor, objRef);
    this.object(targetRef);
    this.moveObject(objRef, targetRef);
  }

  /** Receiver-driven move: the `obj:moveto` / `target:acceptable` /
   * `:exitfunc` / `:enterfunc` chain from `spec/semantics/moveto.md`.
   * Distinct from `moveAuthoredObjectChecked`, which is the trusted-
   * authoring forced move. `movetoChecked` is the user-level path:
   *
   *  - authority: caller (`ctx.progr`) must control `obj` (owner or wizard);
   *  - cross-host writes route through the host bridge or deferred host
   *    effects, rather than mutating another host's local object cache;
   *  - `obj:moveto(target)` is dispatched once per (obj, target) pair via
   *    a per-call marker set so that a verb that delegates with
   *    `moveto(this, target)` falls through to the core path instead of
   *    looping;
   *  - `target:acceptable(obj)` gates the move; falsy returns raise E_PERM,
   *    errors propagate;
   *  - `:exitfunc` / `:enterfunc` errors are swallowed (post-move hooks
   *    must not fail the move per the LambdaMOO contract).
   */
    async movetoChecked(ctx: CallContext, objRef: ObjRef, targetRef: ObjRef): Promise<WooValue> {
      this.assertCanMoveto(ctx, objRef);
      if (this.objects.has(objRef) && this.inheritsFrom(objRef, "$actor")) {
        return await this.movetoActorChecked(ctx, objRef, targetRef);
      }
      const objRemote = await this.remoteHostForObject(objRef, ctx.hostMemo);
    const targetRemote = await this.remoteHostForObject(targetRef, ctx.hostMemo);
    if (!objRemote) this.object(objRef);
    if (!targetRemote) this.object(targetRef);

    if (objRemote && ctx.deferHostEffect) {
      await this.invokeAcceptableHook(ctx, targetRef, objRef);
      const oldLocation = await this.objectLocationChecked(objRef, ctx.hostMemo);
      if (oldLocation && (this.objects.has(oldLocation) || await this.remoteHostForObject(oldLocation, ctx.hostMemo))) {
        await this.invokeContainerHookSwallow(ctx, oldLocation, "exitfunc", [objRef]);
      }
      this.mirrorRemoteMoveLocally(objRef, targetRef);
      ctx.deferHostEffect({ kind: "move_object", obj: objRef, target: targetRef, suppress_mirror_host: this.hostBridge?.localHost ?? null });
      if (this.objects.has(targetRef) || await this.remoteHostForObject(targetRef, ctx.hostMemo)) {
        await this.invokeContainerHookSwallow(ctx, targetRef, "enterfunc", [objRef]);
      }
      return targetRef;
    }

      if (!ctx.movetoStack) ctx.movetoStack = new Set<string>();
    const marker = `${objRef}->${targetRef}`;
    const fresh = !ctx.movetoStack.has(marker);
    ctx.movetoStack.add(marker);

    if (fresh) {
      try {
        return await this.dispatch({ ...ctx, caller: ctx.thisObj, callerPerms: ctx.progr }, objRef, "moveto", [targetRef]);
      } catch (err) {
        if (!isErrorValue(err) || err.code !== "E_VERBNF") throw err;
        // No `:moveto` verb on `obj` or its ancestors — fall through to the
        // direct chain. The marker is intentionally retained: a future
        // recursive moveto in the same call frame will skip the verb path.
      }
    }

    await this.invokeAcceptableHook(ctx, targetRef, objRef);

    const oldLocation = await this.objectLocationChecked(objRef, ctx.hostMemo);
    if (oldLocation && this.objects.has(oldLocation)) {
      await this.invokeContainerHookSwallow(ctx, oldLocation, "exitfunc", [objRef]);
    } else if (oldLocation && await this.remoteHostForObject(oldLocation, ctx.hostMemo)) {
      await this.invokeContainerHookSwallow(ctx, oldLocation, "exitfunc", [objRef]);
    }

    await this.moveObjectChecked(objRef, targetRef);

    if (this.objects.has(targetRef) || await this.remoteHostForObject(targetRef, ctx.hostMemo)) {
      await this.invokeContainerHookSwallow(ctx, targetRef, "enterfunc", [objRef]);
    }

      return targetRef;
    }

    private async movetoActorChecked(ctx: CallContext, actor: ObjRef, targetRef: ObjRef): Promise<WooValue> {
      if (!ctx.session) {
        await this.moveObjectChecked(actor, targetRef);
        return targetRef;
      }
      const session = this.sessions.get(ctx.session);
      if (!session || session.actor !== actor) throw wooError("E_NOSESSION", "actor moveto requires the calling actor's live session", { actor, session: ctx.session });
      if (!await this.remoteHostForObject(targetRef, ctx.hostMemo)) this.object(targetRef);
      await this.invokeAcceptableHook(ctx, targetRef, actor);
      const oldLocation = session.currentLocation;
      if (oldLocation && (this.objects.has(oldLocation) || await this.remoteHostForObject(oldLocation, ctx.hostMemo))) {
        await this.invokeContainerHookSwallow(ctx, oldLocation, "exitfunc", [actor]);
      }
      if (oldLocation && await this.spaceLikeOrRemote(oldLocation, ctx.hostMemo)) {
        await this.updatePresenceChecked(actor, oldLocation, false, ctx);
      }
      session.currentLocation = targetRef;
      this.persistSession(session);
      if (this.primarySessionForActor(actor)?.id === session.id) {
        if (ctx.deferHostEffect && await this.remoteHostForObject(actor, ctx.hostMemo)) {
          this.mirrorRemoteMoveLocally(actor, targetRef);
          ctx.deferHostEffect({ kind: "move_object", obj: actor, target: targetRef, suppress_mirror_host: this.hostBridge?.localHost ?? null });
        } else {
          await this.moveObjectChecked(actor, targetRef);
        }
      }
      if (await this.spaceLikeOrRemote(targetRef, ctx.hostMemo)) {
        await this.updatePresenceChecked(actor, targetRef, true, ctx);
      }
      if (this.objects.has(targetRef) || await this.remoteHostForObject(targetRef, ctx.hostMemo)) {
        await this.invokeContainerHookSwallow(ctx, targetRef, "enterfunc", [actor]);
      }
      return targetRef;
    }

    private assertCanMoveto(ctx: CallContext, objRef: ObjRef): void {
    if (objRef === ctx.actor) return;
    if (this.isWizard(ctx.progr)) return;
    const obj = this.objects.get(objRef);
    if (obj && obj.owner === ctx.progr) return;
    throw wooError("E_PERM", `${ctx.progr} cannot moveto ${objRef}`, { progr: ctx.progr, obj: objRef });
  }

  private async invokeAcceptableHook(ctx: CallContext, targetRef: ObjRef, objRef: ObjRef): Promise<void> {
    let result: WooValue;
    try {
      result = await this.dispatch({ ...ctx, caller: ctx.thisObj, callerPerms: ctx.progr }, targetRef, "acceptable", [objRef]);
    } catch (err) {
      if (isErrorValue(err) && err.code === "E_VERBNF") return; // no acceptable → permitted
      throw err;
    }
    if (!result) {
      throw wooError("E_PERM", "rejected by :acceptable", { obj: objRef, target: targetRef });
    }
  }

  private async invokeContainerHookSwallow(ctx: CallContext, target: ObjRef, name: "enterfunc" | "exitfunc", args: WooValue[]): Promise<void> {
    try {
      await this.dispatch({ ...ctx, caller: ctx.thisObj, callerPerms: ctx.progr }, target, name, args);
    } catch (err) {
      if (isErrorValue(err) && err.code === "E_VERBNF") return; // hook absent
      // Per the spec, post-move hooks must not fail the move. Swallow
      // and continue. Wizards reading transcripts will still see the
      // error trace from the failed sub-call.
    }
  }

  async moveAuthoredObjectChecked(actor: ObjRef, objRef: ObjRef, targetRef: ObjRef, ctx?: CallContext): Promise<void> {
    this.assertCanAuthorObject(actor, objRef);
    const objRemote = await this.remoteHostForObject(objRef, ctx?.hostMemo);
    if (ctx?.deferHostEffect && objRemote) {
      if (!await this.remoteHostForObject(targetRef, ctx.hostMemo)) this.object(targetRef);
      this.mirrorRemoteMoveLocally(objRef, targetRef);
      ctx.deferHostEffect({ kind: "move_object", obj: objRef, target: targetRef, suppress_mirror_host: this.hostBridge?.localHost ?? null });
      return;
    }
    if (!await this.remoteHostForObject(targetRef, ctx?.hostMemo)) this.object(targetRef);
    await this.moveObjectChecked(objRef, targetRef);
  }

  async moveObjectChecked(objRef: ObjRef, targetRef: ObjRef, options: { suppressMirrorHost?: string | null } = {}): Promise<MoveObjectResult> {
    if (await this.remoteHostForObject(objRef)) {
      if (!this.hostBridge) throw wooError("E_INTERNAL", "remote host bridge unavailable");
      return await this.hostBridge.moveObject(objRef, targetRef, options);
    }
    return await this.moveObjectOwned(objRef, targetRef, options);
  }

  contentsOf(objRef: ObjRef): ObjRef[] {
    return Array.from(this.object(objRef).contents);
  }

  /**
   * Update a container's contents mirror only.
   *
   * This is not the source-of-truth move operation: the moved object's owning
   * host must update `obj.location` through moveObjectOwned/moveObjectChecked.
   * Remote hosts call this to keep room/player contents caches coherent after
   * the owner-location write has already happened elsewhere.
   */
  mirrorContents(containerRef: ObjRef, objRef: ObjRef, present: boolean): void {
    const container = this.object(containerRef);
    if (present) container.contents.add(objRef);
    else container.contents.delete(objRef);
    container.modified = Date.now();
    this.persistObject(containerRef);
    this.persist();
  }

  private mirrorRemoteMoveLocally(objRef: ObjRef, targetRef: ObjRef): void {
    let changed = false;
    // Deliberate O(object count) cache cleanup. This only runs on the deferred
    // cross-host move path while object counts are small; if movement becomes
    // hot, maintain a local contents reverse index instead.
    for (const obj of this.objects.values()) {
      if (!obj.contents.delete(objRef)) continue;
      obj.modified = Date.now();
      this.persistObject(obj.id);
      changed = true;
    }
    if (this.objects.has(targetRef)) {
      const target = this.object(targetRef);
      if (!target.contents.has(objRef)) {
        target.contents.add(objRef);
        target.modified = Date.now();
        this.persistObject(targetRef);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

    setActorPresence(actor: ObjRef, space: ObjRef, present: boolean, sessionId: string = this.presenceSessionId(actor)): boolean {
      if (present) {
        const session = this.sessions.get(sessionId);
        if (session && session.actor === actor) {
          session.currentLocation = space;
          this.persistSession(session);
        }
      }
      return this.updateActorPresenceLocal(actor, space, present, sessionId);
    }

    setSpaceSubscriber(space: ObjRef, actor: ObjRef, present: boolean, sessionId: string = this.presenceSessionId(actor)): boolean {
      return this.updateSpaceSubscriberLocal(space, actor, present, sessionId);
    }

  async setPresenceForActor(actor: ObjRef, space: ObjRef, present: boolean, ctx?: CallContext): Promise<boolean> {
    return await this.updatePresenceChecked(actor, space, present, ctx);
  }

  async applyDeferredHostEffects(effects: DeferredHostEffect[]): Promise<void> {
    for (const effect of effects) {
        if (effect.kind === "actor_presence") {
          await this.setActorPresenceChecked(effect.actor, effect.space, effect.present, effect.session);
        } else if (effect.kind === "space_subscriber") {
          await this.setSpaceSubscriberChecked(effect.space, effect.actor, effect.present, effect.session);
      } else if (effect.kind === "move_object") {
        await this.moveObjectChecked(effect.obj, effect.target, { suppressMirrorHost: effect.suppress_mirror_host ?? null });
      }
    }
  }

  async objectLocationChecked(objRef: ObjRef, memo?: HostOperationMemo): Promise<ObjRef | null> {
    const remote = await this.remoteHostForObject(objRef, memo);
    if (!remote) return this.object(objRef).location;
    if (!this.hostBridge) throw wooError("E_INTERNAL", "remote host bridge unavailable");
    return await this.hostBridge.location(objRef, memo);
  }

  async observeToSpace(ctx: CallContext, space: ObjRef, event: Observation): Promise<void> {
    const type = assertString(event.type);
    const observation: Observation = { ...event, type, source: event.source ?? space };
    const remote = await this.remoteHostForObject(space, ctx.hostMemo);
    if (!remote) {
      if (!this.inheritsFrom(space, "$space")) throw wooError("E_TYPE", `${space} is not a space`, space);
    } else {
      try {
        const subscribers = await this.getPropChecked(ctx.progr, space, "subscribers", ctx.hostMemo);
        if (Array.isArray(subscribers)) {
          (observation as Record<string, WooValue>)._audience_override = subscribers.filter((item): item is ObjRef => typeof item === "string");
        }
      } catch {
        (observation as Record<string, WooValue>)._audience_override = [];
      }
    }
    ctx.observe(observation);
  }

  tellPlayer(ctx: CallContext, target: ObjRef, values: WooValue[]): void {
    const text = values.map((value) => valueToText(value)).join("");
    ctx.observe({
      type: "text",
      target,
      actor: ctx.actor,
      text,
      body: text,
      ts: Date.now()
    });
  }

  private async playerHelp(ctx: CallContext, args: WooValue[]): Promise<WooValue> {
    const topic = helpTopic(args[0]) || "index";
    const dbs = await this.helpSearchPath(ctx);
    const result = await this.resolveHelpTopic(ctx, topic, dbs);
    const lines = result && typeof result === "object" && !Array.isArray(result) && Array.isArray(result.lines)
      ? result.lines.map((line) => valueToText(line))
      : [valueToText(result)];
    for (const line of lines) this.tellPlayer(ctx, ctx.actor, [line]);
    return result;
  }

  private async helpSearchPath(ctx: CallContext): Promise<ObjRef[]> {
    const dbs: ObjRef[] = [];
    const pushHelpValue = (value: WooValue): void => this.appendHelpDbs(dbs, value);

    for (const id of this.localAncestry(ctx.actor)) pushHelpValue(this.propOrNullForActor(ctx.actor, id, "help"));

    const location = await this.objectLocationChecked(ctx.actor, ctx.hostMemo).catch(() => null);
    if (typeof location === "string") {
      if (this.objects.has(location)) {
        for (const id of this.localAncestry(location)) pushHelpValue(this.propOrNullForActor(ctx.actor, id, "help"));
      } else {
        pushHelpValue(await this.propOrNullForActorAsync(ctx.actor, location, "help", ctx.hostMemo).catch(() => null));
      }
    }

    pushHelpValue(this.propOrNullForActor(ctx.actor, "$system", "help_dbs"));
    return dbs;
  }

  private localAncestry(objRef: ObjRef): ObjRef[] {
    const ids: ObjRef[] = [];
    let current: ObjRef | null = objRef;
    while (current && this.objects.has(current)) {
      ids.push(current);
      current = this.object(current).parent;
    }
    return ids;
  }

  private appendHelpDbs(dbs: ObjRef[], value: WooValue): void {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item === "string" && item.length > 0 && !dbs.includes(item)) dbs.push(item);
    }
  }

  private async resolveHelpTopic(ctx: CallContext, topic: string, dbs: ObjRef[]): Promise<WooValue> {
    for (let i = 0; i < dbs.length; i += 1) {
      const db = dbs[i];
      try {
        const result = await this.dispatch({ ...ctx, caller: ctx.thisObj }, db, "get_topic", [topic, dbs.slice(i + 1)]);
        if (result && typeof result === "object" && !Array.isArray(result)) return result;
      } catch (err) {
        const error = normalizeError(err);
        if (error.code !== "E_HELPNF") throw err;
      }
    }
    if (dbs.length > 0) {
      await this.dispatch({ ...ctx, caller: ctx.thisObj }, dbs[0], "record_miss", [topic]).catch(() => null);
    }
    return {
      ok: false,
      status: "not_found",
      topic,
      lines: [`No help available for "${topic || "index"}".`]
    };
  }

  private helpDbTopics(ctx: CallContext): Record<string, WooValue> {
    const topics = this.propOrNullForActor(ctx.actor, ctx.thisObj, "topics");
    return topics && typeof topics === "object" && !Array.isArray(topics) ? topics as Record<string, WooValue> : {};
  }

  private helpDbFindTopics(ctx: CallContext, args: WooValue[]): WooValue[] {
    const topics = this.helpDbTopics(ctx);
    const names = Object.keys(topics);
    const query = normalizeHelpTopic(helpTopic(args[0]));
    if (!query) return names;
    const exact = names.filter((name) => normalizeHelpTopic(name) === query);
    if (exact.length > 0) return exact;
    return names.filter((name) => normalizeHelpTopic(name).startsWith(query));
  }

  private helpDbDumpTopic(ctx: CallContext, args: WooValue[]): WooValue {
    const topics = this.helpDbTopics(ctx);
    const matches = this.helpDbFindTopics(ctx, args).filter((item): item is string => typeof item === "string");
    if (matches.length === 0) throw wooError("E_HELPNF", `help topic not found: ${helpTopic(args[0])}`, helpTopic(args[0]));
    if (matches.length > 1) throw wooError("E_AMBIGUOUS", `ambiguous help topic: ${helpTopic(args[0])}`, matches);
    return cloneValue(topics[matches[0]]);
  }

  private async helpDbGetTopic(ctx: CallContext, args: WooValue[]): Promise<WooValue> {
    const topic = helpTopic(args[0]) || "index";
    const remaining = Array.isArray(args[1]) ? args[1].filter((item): item is ObjRef => typeof item === "string") : [];
    const topics = this.helpDbTopics(ctx);
    const matches = this.helpDbFindTopics(ctx, [topic]).filter((item): item is string => typeof item === "string");
    if (matches.length === 0) throw wooError("E_HELPNF", `help topic not found: ${topic}`, topic);
    if (matches.length > 1) {
      return {
        ok: false,
        status: "ambiguous",
        topic,
        db: ctx.thisObj,
        matches,
        lines: [`Ambiguous help topic "${topic}": ${matches.join(", ")}`]
      };
    }
    const matched = matches[0];
    return await this.renderHelpTopic(ctx, ctx.thisObj, matched, topics[matched], remaining);
  }

  private async renderHelpTopic(ctx: CallContext, db: ObjRef, topic: string, raw: WooValue, remaining: ObjRef[]): Promise<WooValue> {
    if (Array.isArray(raw) && typeof raw[0] === "string" && raw[0].startsWith("*")) {
      const directive = raw[0];
      if (directive === "*index*") {
        const title = typeof raw[1] === "string" && raw[1] ? raw[1] : "Help";
        const topics = Object.keys(this.helpDbTopics({ ...ctx, thisObj: db }));
        return { ok: true, status: "found", topic, db, title, lines: [title, "", `Topics: ${topics.join(", ")}`] };
      }
      if (directive === "*pass*") {
        const nextTopic = typeof raw[1] === "string" && raw[1] ? raw[1] : topic;
        return await this.resolveHelpTopic(ctx, nextTopic, remaining);
      }
      if (directive === "*forward*") {
        const nextTopic = typeof raw[1] === "string" && raw[1] ? raw[1] : topic;
        return await this.helpDbGetTopic({ ...ctx, thisObj: db }, [nextTopic, remaining]);
      }
      if (directive === "*objectdoc*") {
        const obj = assertObj(raw[1]);
        const view = await this.dispatch({ ...ctx, caller: db }, obj, "look_self", []);
        const title = view && typeof view === "object" && !Array.isArray(view) && typeof view.title === "string" ? view.title : await this.objectDisplayNameAsync(ctx.progr, obj, ctx.hostMemo);
        const description = view && typeof view === "object" && !Array.isArray(view) && typeof view.description === "string" ? view.description : "";
        return { ok: true, status: "found", topic, db, title, lines: [title, description].filter((line) => line.length > 0), object: obj, look: view as WooValue };
      }
      if (directive === "*verbdoc*") {
        const obj = assertObj(raw[1]);
        const name = assertString(raw[2] ?? "");
        const { definer, verb } = this.resolveVerb(obj, name);
        const readable = this.canReadVerb(ctx.actor, verb);
        const source = readable ? verb.source || "No source available." : "Verb source is not readable.";
        const lines = [`${obj}:${verb.name} (${verb.perms})`, source];
        return {
          ok: true,
          status: "found",
          topic,
          db,
          title: `${obj}:${verb.name}`,
          lines,
          object: obj,
          verb: verb.name,
          definer,
          version: verb.version,
          readable
        };
      }
    }
    const lines = Array.isArray(raw) ? raw.map((line) => valueToText(line)) : [valueToText(raw)];
    return { ok: true, status: "found", topic, db, title: topic, lines };
  }

  private helpDbRecordMiss(ctx: CallContext, args: WooValue[]): WooValue {
    const topic = helpTopic(args[0]);
    if (!topic) return false;
    const existing = this.propOrNull(ctx.thisObj, "missed_topics");
    const misses = Array.isArray(existing) ? existing : [];
    const entry: WooValue = { topic, actor: ctx.actor, ts: Date.now() };
    this.setProp(ctx.thisObj, "missed_topics", [...misses.slice(-99), entry]);
    return true;
  }

  chparentAuthoredObject(actor: ObjRef, objRef: ObjRef, parentRef: ObjRef): void {
    this.assertCanAuthorObject(actor, objRef);
    this.assertCanCreateObject(actor, parentRef, actor);
    if (objRef === parentRef || this.inheritsFrom(parentRef, objRef)) throw wooError("E_RECMOVE", "recursive parent change", { obj: objRef, parent: parentRef });
    this.chparentLocal(objRef, parentRef);
  }

  private chparentLocal(objRef: ObjRef, parentRef: ObjRef): void {
    const obj = this.object(objRef);
    if (obj.parent && this.objects.has(obj.parent)) this.object(obj.parent).children.delete(objRef);
    obj.parent = parentRef;
    this.object(parentRef).children.add(objRef);
    obj.modified = Date.now();
    this.persistObject(objRef);
    this.persistObject(parentRef);
    this.persist();
  }

  private createBuilderObject(parent: ObjRef, owner: ObjRef, anchor: ObjRef | null, options: { location: ObjRef | null; name?: string; fertile: boolean }): ObjRef {
    this.object(parent);
    this.object(owner);
    if (anchor) this.object(anchor);
    // Mirror the createRuntimeObject self-host/anchor rejection. See
    // spec/semantics/objects.md §4.1.
    if (anchor !== null && this.propOrNull(parent, "instances_self_host") === true) {
      throw wooError("E_INVARG", `cannot anchor a self-hosted instance`, { parent, anchor });
    }
    const scope = runtimeObjectScope(anchor ?? parent);
    let id: ObjRef;
    do {
      id = `obj_${scope}_${this.objectCounter++}`;
    } while (this.objects.has(id));
    this.createObject({
      id,
      parent,
      owner,
      anchor,
      location: options.location,
      name: options.name,
      flags: { fertile: options.fertile }
    });
    this.persistCounters();
    return id;
  }

  private assertCanBuildOwnedObject(actor: ObjRef, objRef: ObjRef): void {
    const obj = this.object(objRef);
    if (this.isWizard(actor) || obj.owner === actor) return;
    throw wooError("E_PERM", `${actor} cannot build on ${objRef}`, { actor, obj: objRef });
  }

  private assertCanBuildChild(actor: ObjRef, parent: ObjRef, owner: ObjRef): void {
    const parentObj = this.object(parent);
    if (this.isWizard(actor)) return;
    if (owner !== actor) throw wooError("E_PERM", `${actor} cannot create objects owned by ${owner}`, { actor, owner });
    if (parentObj.owner !== actor && parentObj.flags.fertile !== true) {
      throw wooError("E_PERM", `${actor} cannot create children of ${parent}`, { actor, parent });
    }
  }

  private recycleObjectLocal(objRef: ObjRef): void {
    const obj = this.object(objRef);
    // Editor sessions referencing this ULID are cleaned lazily on next
    // access via editorSessionOrNull — the eager scrub that lived here
    // moved to a §RC5-style lazy check.

    // Step 2: kill parked tasks anchored to obj. Any task whose parked_on,
    // awaiting_player, or origin is obj is removed. Per
    // spec/semantics/recycle.md §RC3 step 2 and failures.md §F7. Awaiting
    // consumers see E_INTRPT when they next look up the task; the parked-task
    // table is the single source of truth, so deleting the row is enough.
    const killedTasks: string[] = [];
    for (const [id, task] of this.parkedTasks) {
      if (task.parked_on === objRef || task.awaiting_player === objRef || task.origin === objRef) {
        killedTasks.push(id);
      }
    }
    for (const id of killedTasks) {
      this.parkedTasks.delete(id);
      this.deletePersistedTask(id);
    }

    const parent = obj.parent;
    const location = obj.location;

    // Step 3: graft children up. Each child's parent becomes obj.parent, so
    // the inheritance chain stays connected. Snapshot the set first because
    // chparentLocal mutates obj.children. obj.parent is non-null here
    // because $system is forbidden by §RC6.
    const childrenSnapshot = Array.from(obj.children);
    if (parent) {
      for (const child of childrenSnapshot) {
        if (!this.objects.has(child)) continue;
        this.chparentLocal(child, parent);
      }
    }

    // Step 4: displace contents to $nowhere. Per spec/semantics/recycle.md
    // §RC3 step 4: "for each contained `c` whose `location == obj`". The
    // location field is the source of truth; obj.contents is a cache that
    // may drift (objects.md §4.3). A stale cache entry whose actual
    // location is somewhere else must NOT be re-located by recycle —
    // verify before mutating. $nowhere.contents is not maintained (sink
    // semantics, bootstrap.md §B2.15), so we set only the local
    // `c.location` and skip the back-reference write.
    const contentsSnapshot = Array.from(obj.contents);
    for (const content of contentsSnapshot) {
      if (!this.objects.has(content)) continue;
      const contentObj = this.object(content);
      if (contentObj.location !== objRef) {
        // Stale cache entry — drop it from obj.contents but leave the
        // referenced object's location alone.
        continue;
      }
      contentObj.location = "$nowhere";
      contentObj.modified = Date.now();
      this.persistObject(content);
    }
    obj.contents.clear();

    // Step 5/6: parent-side and container-side bookkeeping.
    if (parent && this.objects.has(parent)) {
      this.object(parent).children.delete(objRef);
      this.persistObject(parent);
    }
    if (location && this.objects.has(location)) {
      this.object(location).contents.delete(objRef);
      this.persistObject(location);
    }
    // Steps 8/9: storage delete and tombstone insert.
    this.objects.delete(objRef);
    this.tombstones.add(objRef);
    this.deletePersistedObject(objRef);
    this.persistTombstone(objRef);
    if (this.presenceIndexBuilt) this.invalidatePresenceIndex();
    this.persist();
  }

  private assertCanCreateObject(progr: ObjRef, parent: ObjRef, owner: ObjRef): void {
    const progrObj = this.object(progr);
    const parentObj = this.object(parent);
    if (progrObj.flags.wizard === true) return;
    if (owner !== progr) throw wooError("E_PERM", `${progr} cannot create objects owned by ${owner}`, { progr, owner });
    if (progrObj.flags.programmer !== true) throw wooError("E_PERM", `${progr} does not have programmer authority`, progr);
    if (parentObj.owner !== progr && parentObj.flags.fertile !== true) {
      throw wooError("E_PERM", `${progr} cannot create children of ${parent}`, { progr, parent });
    }
  }

  scheduleFork(ctx: CallContext, seconds: number, target: ObjRef, verbName: string, args: WooValue[]): string {
    if (!Number.isFinite(seconds)) throw wooError("E_TYPE", "fork delay must be numeric", seconds);
    const id = `ptask_${this.parkedTaskCounter++}`;
    this.persistCounters();
    const now = Date.now();
    const task: ParkedTaskRecord = {
      id,
      parked_on: target,
      state: "suspended",
      resume_at: now + Math.max(0, seconds) * 1000,
      awaiting_player: null,
      correlation_id: null,
      created: now,
      origin: ctx.thisObj,
      serialized: {
        kind: "fork",
        space: ctx.space,
        actor: ctx.actor,
        player: ctx.player,
        progr: ctx.progr,
        target,
        verb: verbName,
        args: cloneValue(args as WooValue) as WooValue,
        message: cloneValue(ctx.message as unknown as WooValue)
      }
    };
    this.parkedTasks.set(id, task);
    this.persistTask(task);
    this.persist();
    return id;
  }

  parkVmContinuation(ctx: CallContext, seconds: number, task: SerializedVmTask): string {
    if (!Number.isFinite(seconds)) throw wooError("E_TYPE", "suspend delay must be numeric", seconds);
    const id = `ptask_${this.parkedTaskCounter++}`;
    this.persistCounters();
    const now = Date.now();
    const parked: ParkedTaskRecord = {
      id,
      parked_on: ctx.thisObj,
      state: "suspended",
      resume_at: now + Math.max(0, seconds) * 1000,
      awaiting_player: null,
      correlation_id: null,
      created: now,
      origin: ctx.thisObj,
      serialized: {
        kind: "vm_continuation",
        space: ctx.space,
        actor: ctx.actor,
        player: ctx.player,
        progr: ctx.progr,
        target: ctx.thisObj,
        verb: ctx.verbName,
        task: cloneValue(task as unknown as WooValue)
      }
    };
    this.parkedTasks.set(id, parked);
    this.persistTask(parked);
    this.persist();
    return id;
  }

  parkReadContinuation(ctx: CallContext, player: ObjRef, task: SerializedVmTask): string {
    const id = `ptask_${this.parkedTaskCounter++}`;
    this.persistCounters();
    const now = Date.now();
    const parked: ParkedTaskRecord = {
      id,
      parked_on: ctx.thisObj,
      state: "awaiting_read",
      resume_at: null,
      awaiting_player: player,
      correlation_id: null,
      created: now,
      origin: ctx.thisObj,
      serialized: {
        kind: "vm_continuation",
        space: ctx.space,
        actor: ctx.actor,
        player: ctx.player,
        progr: ctx.progr,
        target: ctx.thisObj,
        verb: ctx.verbName,
        task: cloneValue(task as unknown as WooValue)
      }
    };
    this.parkedTasks.set(id, parked);
    this.persistTask(parked);
    this.persist();
    return id;
  }

  async deliverInput(player: ObjRef, input: WooValue): Promise<ParkedTaskRun | null> {
    return await this.enqueueHostTask(() => this.deliverInputNow(player, input), `deliverInput:${player}`);
  }

  private async deliverInputNow(player: ObjRef, input: WooValue): Promise<ParkedTaskRun | null> {
    const task = Array.from(this.parkedTasks.values())
      .filter((item) => item.state === "awaiting_read" && item.awaiting_player === player)
      .sort((left, right) => left.created - right.created || left.id.localeCompare(right.id))[0];
    if (!task) return null;
    this.parkedTasks.delete(task.id);
    this.deletePersistedTask(task.id);
    const result = await this.runParkedTask(task, input);
    this.persist(true);
    return result;
  }

  async runDueTasks(now = Date.now()): Promise<ParkedTaskRun[]> {
    // Pre-check before enqueueing so an idle dev poll (every 250ms) doesn't
    // flood structured-log tails with no-op host_task_* metrics. A concurrent
    // task insert between this check and the next tick is fine: the next
    // poll re-checks.
    if (!this.hasDueParkedTask(now)) return [];
    return await this.enqueueHostTask(() => this.runDueTasksNow(now), "runDueTasks");
  }

  private hasDueParkedTask(now: number): boolean {
    for (const task of this.parkedTasks.values()) {
      if (task.state === "suspended" && task.resume_at !== null && task.resume_at <= now) return true;
    }
    return false;
  }

  private async runDueTasksNow(now = Date.now()): Promise<ParkedTaskRun[]> {
    const due = Array.from(this.parkedTasks.values())
      .filter((task) => task.state === "suspended" && task.resume_at !== null && task.resume_at <= now)
      .sort((left, right) => (left.resume_at ?? 0) - (right.resume_at ?? 0) || left.created - right.created || left.id.localeCompare(right.id));
    const results: ParkedTaskRun[] = [];
    for (const task of due) {
      this.parkedTasks.delete(task.id);
      this.deletePersistedTask(task.id);
      results.push(await this.runParkedTask(task));
    }
    if (due.length > 0) this.persist(true);
    return results;
  }

  exportWorld(): SerializedWorld {
    return {
      version: 1,
      objectCounter: this.objectCounter,
      parkedTaskCounter: this.parkedTaskCounter,
      sessionCounter: this.sessionCounter,
      objects: Array.from(this.objects.values()).map((obj) => this.serializeObject(obj)),
      sessions: Array.from(this.sessions.values()).map((session) => this.serializeSession(session)),
      logs: Array.from(this.logs.entries()).map(([space, entries]) => [space, cloneValue(entries as unknown as WooValue) as unknown as SpaceLogEntry[]]),
      snapshots: cloneValue(this.snapshots as unknown as WooValue) as unknown as SpaceSnapshotRecord[],
      parkedTasks: Array.from(this.parkedTasks.values()).map((task) => cloneValue(task as unknown as WooValue) as unknown as ParkedTaskRecord),
      tombstones: Array.from(this.tombstones).sort()
    };
  }

  exportHostScopedWorld(host: ObjRef): SerializedWorld {
    const scope = this.hostScope(host);
    const parkedTasks = Array.from(this.parkedTasks.values())
      .filter((task) => this.taskBelongsToHostScope(task, scope.hostedSpaces, scope.objects))
      .map((task) => cloneValue(task as unknown as WooValue) as unknown as ParkedTaskRecord);
    return {
      version: 1,
      objectCounter: nextScopedObjectCounter(scope.objects),
      parkedTaskCounter: nextScopedParkedTaskCounter(parkedTasks),
      // Sessions are not exported, so this seed contributes nothing about session allocation.
      sessionCounter: 1,
      objects: Array.from(scope.objects)
        .sort()
        .map((id) => this.serializeScopedObject(this.object(id), scope.objects, scope.hostedObjects)),
      sessions: [],
      logs: Array.from(this.logs.entries())
        .filter(([space]) => scope.hostedSpaces.has(space))
        .map(([space, entries]) => [space, cloneValue(entries as unknown as WooValue) as unknown as SpaceLogEntry[]]),
      snapshots: (this.snapshots ?? [])
        .filter((snapshot) => scope.hostedSpaces.has(snapshot.space_id))
        .map((snapshot) => cloneValue(snapshot as unknown as WooValue) as unknown as SpaceSnapshotRecord),
      parkedTasks,
      tombstones: Array.from(this.tombstones).sort()
    };
  }

  importWorld(serialized: SerializedWorld): void {
    this.withPersistencePaused(() => {
      this.objects.clear();
      this.sessions.clear();
      this.logs.clear();
      this.snapshots = [];
      this.parkedTasks.clear();
      this.tombstones = new Set(serialized.tombstones ?? []);
      this.presenceIndexBuilt = false;
      this.subscribersIndex.clear();
      this.actorPresenceIndex.clear();
      for (const item of serialized.objects) {
        this.objects.set(item.id, {
          id: item.id,
          name: item.name,
          parent: item.parent,
          owner: item.owner,
          location: item.location,
          anchor: item.anchor,
          flags: item.flags ?? {},
          created: item.created,
          modified: item.modified,
          propertyDefs: new Map(item.propertyDefs.map((def) => [def.name, { ...def, defaultValue: cloneValue(def.defaultValue) }])),
          properties: new Map(item.properties.map(([name, value]) => [name, cloneValue(value)])),
          propertyVersions: new Map(item.propertyVersions),
          verbs: item.verbs.map((verb, index) => {
            const parsedPerms = normalizeVerbPerms(verb.perms, verb.direct_callable === true);
            return { ...verb, perms: parsedPerms.perms, direct_callable: parsedPerms.directCallable, slot: index + 1 } as VerbDef;
          }),
          children: new Set(item.children),
          contents: new Set(item.contents),
          eventSchemas: new Map(item.eventSchemas)
        });
      }
      for (const session of serialized.sessions) {
        this.sessions.set(session.id, this.hydrateSession(session, Date.now()));
      }
      for (const [space, entries] of serialized.logs) {
        const hydrated = cloneValue(entries as unknown as WooValue) as unknown as SpaceLogEntry[];
        this.logs.set(space, hydrated.map((entry) => ({ ...entry, observations: entry.observations ?? [] })));
      }
      this.snapshots = serialized.snapshots ?? [];
      for (const task of serialized.parkedTasks ?? []) {
        this.parkedTasks.set(task.id, cloneValue(task as unknown as WooValue) as unknown as ParkedTaskRecord);
      }
      this.objectCounter = serialized.objectCounter ?? serialized.taskCounter ?? 1;
      this.parkedTaskCounter = serialized.parkedTaskCounter ?? 1;
      this.sessionCounter = serialized.sessionCounter;
      this.rebuildGuestPool();
    });
  }

  private serializeObject(obj: WooObject): SerializedObject {
    return {
      id: obj.id,
      name: obj.name,
      parent: obj.parent,
      owner: obj.owner,
      location: obj.location,
      anchor: obj.anchor,
      flags: obj.flags,
      created: obj.created,
      modified: obj.modified,
      propertyDefs: Array.from(obj.propertyDefs.values()).map((def) => ({ ...def, defaultValue: cloneValue(def.defaultValue) })),
      properties: Array.from(obj.properties.entries()).map(([name, value]) => [name, cloneValue(value)]),
      propertyVersions: Array.from(obj.propertyVersions.entries()),
      verbs: obj.verbs.map((verb) => cloneValue(verb as unknown as WooValue) as unknown as VerbDef),
      children: Array.from(obj.children),
      contents: Array.from(obj.contents),
      eventSchemas: Array.from(obj.eventSchemas.entries()).map(([type, schema]) => [type, cloneValue(schema as WooValue) as Record<string, WooValue>])
    };
  }

  private serializeScopedObject(obj: WooObject, scope: Set<ObjRef>, hostedObjects: Set<ObjRef>): SerializedObject {
    const serialized = this.serializeObject(obj);
    serialized.children = serialized.children.filter((id) => scope.has(id));
    if (!hostedObjects.has(obj.id)) serialized.contents = serialized.contents.filter((id) => scope.has(id));
    return serialized;
  }

  private hostScope(host: ObjRef): { objects: Set<ObjRef>; hostedObjects: Set<ObjRef>; hostedSpaces: Set<ObjRef> } {
    const allRoutes = this.objectRoutes();
    const routeByObject = new Map(allRoutes.map((route) => [route.id, route] as const));
    const routes = allRoutes.filter((route) => route.host === host);
    const hosted = new Set(routes.map((route) => route.id));
    const hostedSpaces = new Set<ObjRef>();
    const objects = new Set<ObjRef>();
    const queue: Array<{ id: ObjRef; scanRefs: boolean; includeLineage: boolean }> = [];

    const add = (id: ObjRef | null | undefined, scanRefs = true, includeLineage = true): void => {
      if (!id || !this.objects.has(id) || objects.has(id)) return;
      objects.add(id);
      queue.push({ id, scanRefs, includeLineage });
    };

    const addCatalogSupportFor = (ids: Set<ObjRef>): void => {
      for (const record of this.installedCatalogRecords()) {
        const objectsMap = isPlainValueMap(record.objects) ? record.objects : {};
        const seedsMap = isPlainValueMap(record.seeds) ? record.seeds : {};
        const objectRefs = Object.values(objectsMap).filter((id): id is ObjRef => typeof id === "string");
        const seedRefs = Object.values(seedsMap).filter((id): id is ObjRef => typeof id === "string");
        if (![...objectRefs, ...seedRefs].some((id) => ids.has(id))) continue;
        for (const id of objectRefs) add(id);
      }
    };

    for (const id of hosted) {
      add(id);
      if (this.objects.has(id) && this.inheritsFrom(id, "$space")) hostedSpaces.add(id);
    }
    addCatalogSupportFor(hosted);

    for (let i = 0; i < queue.length; i++) {
      const { id, scanRefs, includeLineage } = queue[i];
      const obj = this.object(id);
      if (includeLineage) {
        add(obj.parent, scanRefs);
        add(obj.owner, false);
      }
      if (hosted.has(id)) {
        add(obj.anchor);
        add(obj.location);
        for (const item of obj.contents) {
          const route = routeByObject.get(item);
          if (route && route.host !== host) add(item, false);
        }
      }
      if (this.canCarryFeaturesIfKnown(id)) {
        const rawFeatures = obj.properties.get("features");
        if (Array.isArray(rawFeatures)) {
          for (const feature of rawFeatures) if (typeof feature === "string") add(feature);
        }
      }
      if (hostedSpaces.has(id)) {
        const rawSubscribers = obj.properties.get("subscribers");
        if (Array.isArray(rawSubscribers)) {
          for (const actor of rawSubscribers) if (typeof actor === "string") add(actor, false);
        }
      }
      if (scanRefs) this.scanObjectRefs(obj, add);
    }

    return { objects, hostedObjects: hosted, hostedSpaces };
  }

  private canCarryFeaturesIfKnown(objRef: ObjRef): boolean {
    try {
      return this.canCarryFeatures(objRef);
    } catch {
      return false;
    }
  }

  private scanObjectRefs(obj: WooObject, add: (id: ObjRef | null | undefined, scanRefs?: boolean) => void): void {
    for (const [name, value] of obj.properties) {
      if (obj.id === "$system" && name === "catalog_migration_records") continue;
      // `guest_initial_room` is deployment-wide config: its value is a target
      // room, not a structural reference. Pulling it into every host slice
      // (because `$system` is in every lineage) would leak the room into hosts
      // that have no other reason to know about it.
      if (obj.id === "$system" && name === "guest_initial_room") continue;
      this.scanValueRefs(value, add);
    }
    for (const def of obj.propertyDefs.values()) this.scanValueRefs(def.defaultValue, add);
    for (const [, schema] of obj.eventSchemas) this.scanValueRefs(schema as WooValue, add);
    for (const verb of obj.verbs) {
      this.scanValueRefs(verb.arg_spec as WooValue, add);
      if (verb.kind === "bytecode") this.scanValueRefs(verb.bytecode.literals as WooValue, add);
    }
  }

  private scanValueRefs(value: WooValue, add: (id: ObjRef | null | undefined, scanRefs?: boolean) => void): void {
    if (typeof value === "string") {
      if (this.objects.has(value)) add(value);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) this.scanValueRefs(item, add);
      return;
    }
    for (const item of Object.values(value)) this.scanValueRefs(item, add);
  }

  private installedCatalogRecords(): Array<Record<string, WooValue>> {
    if (!this.objects.has("$catalog_registry")) return [];
    const raw = this.propOrNull("$catalog_registry", "installed_catalogs");
    if (!Array.isArray(raw)) return [];
    return raw.filter(isPlainValueMap);
  }

  private taskBelongsToHostScope(task: ParkedTaskRecord, hostedSpaces: Set<ObjRef>, objects: Set<ObjRef>): boolean {
    if (objects.has(task.parked_on)) return true;
    const serialized = task.serialized;
    if (serialized && typeof serialized === "object" && !Array.isArray(serialized)) {
      const raw = serialized as Record<string, WooValue>;
      if (typeof raw.space === "string" && hostedSpaces.has(raw.space)) return true;
      if (typeof raw.target === "string" && objects.has(raw.target)) return true;
      if (typeof raw.origin === "string" && objects.has(raw.origin)) return true;
    }
    return false;
  }

  private serializeSession(session: Session): SerializedSession {
    return {
      id: session.id,
      actor: session.actor,
        started: session.started,
        expiresAt: session.expiresAt,
        lastDetachAt: session.lastDetachAt,
        tokenClass: session.tokenClass,
        currentLocation: session.currentLocation,
        ...(session.apikeyId !== undefined ? { apikeyId: session.apikeyId } : {})
      };
    }

  saveSnapshot(space: ObjRef): SpaceSnapshotRecord {
    const seq = Number(this.getProp(space, "next_seq")) - 1;
    const state = this.materializedSpaceState(space);
    const snapshot: SpaceSnapshotRecord = {
      space_id: space,
      seq,
      ts: Date.now(),
      state,
      hash: hashCanonical(state)
    };
    this.snapshots = this.snapshots.filter((item) => !(item.space_id === space && item.seq === seq));
    this.snapshots.push(snapshot);
    this.setProp(space, "last_snapshot_seq", seq);
    this.repository?.saveSpaceSnapshot?.(snapshot);
    this.persist();
    return snapshot;
  }

  latestSnapshot(space: ObjRef): SpaceSnapshotRecord | null {
    return this.repository?.latestSpaceSnapshot?.(space) ?? this.snapshots.filter((snapshot) => snapshot.space_id === space).sort((a, b) => b.seq - a.seq)[0] ?? null;
  }

  withPersistencePaused<T>(fn: () => Promise<T>): Promise<T>;
  withPersistencePaused<T>(fn: () => T): T;
  withPersistencePaused<T>(fn: () => T | Promise<T>): T | Promise<T> {
    this.persistencePaused += 1;
    const release = (): void => {
      this.persistencePaused -= 1;
    };
    try {
      const result = fn();
      if (isPromiseLike(result)) {
        return result.finally(release);
      }
      release();
      return result;
    } catch (err) {
      release();
      throw err;
    }
  }

  withPersistenceDeferred<T>(fn: () => T): T {
    this.persistenceDeferred += 1;
    try {
      return fn();
    } finally {
      this.persistenceDeferred -= 1;
      if (this.persistenceDeferred === 0 && this.persistencePaused === 0 && this.persistenceDirty) this.persist(true);
    }
  }

  withMutationSavepoint<T>(fn: () => T): T {
    const run = (): T => this.withBehaviorSavepoint(fn);
    const repo = this.activeObjectRepository();
    if (repo && this.persistencePaused === 0) return repo.savepoint(run);
    return run();
  }

  persist(force = false): void {
    if (!this.repository) return;
    if (this.activeObjectRepository()) {
      if (!force && (this.persistencePaused > 0 || this.persistenceDeferred > 0)) {
        this.persistenceDirty = true;
        return;
      }
      if (force || this.persistenceDirty) this.flushIncrementalState();
      this.persistenceDirty = this.hasDirtyPersistence();
      return;
    }
    if (!force && (this.persistencePaused > 0 || this.persistenceDeferred > 0)) {
      this.persistenceDirty = true;
      return;
    }
    this.runFullSave("world_persist");
    this.persistenceDirty = false;
  }

  persistFullSnapshot(trigger: "persist_full_snapshot" | "host_seed_apply" = "persist_full_snapshot"): void {
    if (!this.repository) return;
    // Use sparingly for whole-world replacement paths such as importing a
    // repaired host seed; incremental persistence has no dirty-row record for
    // objects replaced through importWorld(). Callers that drive a known
    // trigger (e.g. host-seed apply) pass it through so the metric stream
    // names the call site without having to walk the stack.
    this.runFullSave(trigger);
    this.discardPendingPersistence();
  }

  /** Drive `repository.save()` with metric instrumentation. The MetricEvent
   * row count is derived from the same SerializedWorld passed to save() so the
   * metric matches the actual write set across every backend. The CF backend's
   * own `cf_repository_save` startup metric still fires (it covers ms +
   * status), but `storage_full_save` is the runtime-level signal; one grep
   * surfaces every full-world rewrite without joining startup vs steady-state
   * channels. */
  private runFullSave(trigger: "world_persist" | "persist_full_snapshot" | "host_seed_apply"): void {
    const repo = this.repository;
    if (!repo) return;
    const serialized = this.exportWorld();
    const startedAt = Date.now();
    repo.save(serialized);
    const stats = serializedWorldRowStats(serialized);
    this.recordMetric({
      kind: "storage_full_save",
      trigger,
      rows: stats.rows,
      objects: stats.objects,
      properties: stats.properties,
      verbs: stats.verbs,
      logs: stats.logs,
      snapshots: stats.snapshots,
      sessions: stats.sessions,
      tasks: stats.tasks,
      tombstones: stats.tombstones,
      ms: Date.now() - startedAt
    });
  }

  private activeObjectRepository(): ObjectRepository | null {
    return this.incrementalPersistenceEnabled ? this.objectRepository : null;
  }

  private markObjectDirty(objRef: ObjRef): void {
    if (this.deletedObjects.has(objRef)) return;
    this.dirtyObjects.add(objRef);
    this.dirtyProperties.delete(objRef);
    this.persistenceDirty = true;
  }

  private markObjectDeleted(objRef: ObjRef): void {
    this.dirtyObjects.delete(objRef);
    this.dirtyProperties.delete(objRef);
    this.deletedObjects.add(objRef);
    this.persistenceDirty = true;
  }

  private markPropertyDirty(objRef: ObjRef, name: string): void {
    if (this.deletedObjects.has(objRef)) return;
    if (this.dirtyObjects.has(objRef)) {
      this.persistenceDirty = true;
      return;
    }
    let properties = this.dirtyProperties.get(objRef);
    if (!properties) {
      properties = new Set<string>();
      this.dirtyProperties.set(objRef, properties);
    }
    properties.add(name);
    this.persistenceDirty = true;
  }

  private markSessionDirty(sessionId: string): void {
    this.deletedSessions.delete(sessionId);
    this.dirtySessions.add(sessionId);
    this.persistenceDirty = true;
  }

  private markSessionDeleted(sessionId: string): void {
    this.dirtySessions.delete(sessionId);
    this.deletedSessions.add(sessionId);
    this.persistenceDirty = true;
  }

  private markTaskDirty(taskId: string): void {
    this.deletedTasks.delete(taskId);
    this.dirtyTasks.add(taskId);
    this.persistenceDirty = true;
  }

  private markTaskDeleted(taskId: string): void {
    this.dirtyTasks.delete(taskId);
    this.deletedTasks.add(taskId);
    this.persistenceDirty = true;
  }

  private markCountersDirty(): void {
    this.dirtyCounters = true;
    this.persistenceDirty = true;
  }

  private snapshotPersistenceDirtyState(): PersistenceDirtyState {
    return {
      dirtyObjects: new Set(this.dirtyObjects),
      deletedObjects: new Set(this.deletedObjects),
      dirtyProperties: new Map(Array.from(this.dirtyProperties.entries()).map(([objRef, properties]) => [objRef, new Set(properties)])),
      dirtySessions: new Set(this.dirtySessions),
      deletedSessions: new Set(this.deletedSessions),
      dirtyTasks: new Set(this.dirtyTasks),
      deletedTasks: new Set(this.deletedTasks),
      dirtyTombstones: new Set(this.dirtyTombstones),
      dirtyCounters: this.dirtyCounters,
      dirty: this.persistenceDirty
    };
  }

  private restorePersistenceDirtyState(state: PersistenceDirtyState): void {
    this.dirtyObjects = new Set(state.dirtyObjects);
    this.deletedObjects = new Set(state.deletedObjects);
    this.dirtyProperties = new Map(Array.from(state.dirtyProperties.entries()).map(([objRef, properties]) => [objRef, new Set(properties)]));
    this.dirtySessions = new Set(state.dirtySessions);
    this.deletedSessions = new Set(state.deletedSessions);
    this.dirtyTasks = new Set(state.dirtyTasks);
    this.deletedTasks = new Set(state.deletedTasks);
    this.dirtyTombstones = new Set(state.dirtyTombstones);
    this.dirtyCounters = state.dirtyCounters;
    this.persistenceDirty = state.dirty;
  }

  private hasDirtyPersistence(): boolean {
    return (
      this.dirtyObjects.size > 0 ||
      this.deletedObjects.size > 0 ||
      this.dirtyProperties.size > 0 ||
      this.dirtySessions.size > 0 ||
      this.deletedSessions.size > 0 ||
      this.dirtyTasks.size > 0 ||
      this.deletedTasks.size > 0 ||
      this.dirtyTombstones.size > 0 ||
      this.dirtyCounters
    );
  }

  private persistObject(objRef: ObjRef): void {
    this.bumpMutationVersion();
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0 || this.persistenceDeferred > 0) {
      this.markObjectDirty(objRef);
      return;
    }
    const obj = this.objects.get(objRef);
    if (!obj) return;
    const startedAt = Date.now();
    const serialized = this.serializeObject(obj);
    repo.saveObject(serialized);
    this.recordMetric({ kind: "storage_direct_write", what: "object", ms: Date.now() - startedAt, rows: serializedObjectRowCount(serialized) });
  }

  private deletePersistedObject(objRef: ObjRef): void {
    this.bumpMutationVersion();
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0 || this.persistenceDeferred > 0) {
      this.markObjectDeleted(objRef);
      return;
    }
    const startedAt = Date.now();
    repo.deleteObject(objRef);
    this.recordMetric({ kind: "storage_direct_write", what: "object_delete", ms: Date.now() - startedAt, rows: 1 });
  }

  /**
   * Persist a tombstone for `id` to the active repository. Per
   * spec/reference/persistence.md §14.2.1: write-once, idempotent on
   * repeat. Best-effort with deferred-persistence: tombstones flushed at
   * the next persist tick when persistencePaused/persistenceDeferred is
   * non-zero, just like dirty objects.
   */
  private persistTombstone(objRef: ObjRef): void {
    this.bumpMutationVersion();
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0 || this.persistenceDeferred > 0) {
      this.dirtyTombstones.add(objRef);
      return;
    }
    repo.saveTombstone(objRef, Date.now(), null);
  }

  private persistProperty(objRef: ObjRef, name: string): void {
    this.bumpMutationVersion();
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0 || this.persistenceDeferred > 0) {
      this.markPropertyDirty(objRef, name);
      return;
    }
    const startedAt = Date.now();
    repo.saveProperty(objRef, this.serializeProperty(objRef, name));
    this.recordMetric({ kind: "storage_direct_write", what: "property", ms: Date.now() - startedAt, rows: 3 });
  }

  private deletePersistedProperty(objRef: ObjRef, name: string): void {
    this.bumpMutationVersion();
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0 || this.persistenceDeferred > 0) {
      // A deferred full-object save is the simplest correct representation of
      // a property deletion because it rewrites the object's scoped rows.
      this.markObjectDirty(objRef);
      return;
    }
    const startedAt = Date.now();
    repo.deleteProperty(objRef, name);
    this.recordMetric({ kind: "storage_direct_write", what: "property_delete", ms: Date.now() - startedAt, rows: 3 });
  }

  private serializeProperty(objRef: ObjRef, name: string): SerializedProperty {
    const obj = this.object(objRef);
    const def = obj.propertyDefs.get(name);
    const hasValue = obj.properties.has(name);
    const hasVersion = obj.propertyVersions.has(name);
    if (!def && !hasValue && !hasVersion) throw wooError("E_PROPNF", `property not found: ${objRef}.${name}`, { obj: objRef, property: name });
    return {
      name,
      def: def ? { ...def, defaultValue: cloneValue(def.defaultValue) } : null,
      value: hasValue ? cloneValue(obj.properties.get(name)!) : undefined,
      version: obj.propertyVersions.get(name) ?? def?.version ?? 0
    };
  }

  private persistSession(session: Session): void {
    this.bumpMutationVersion();
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0 || this.persistenceDeferred > 0) {
      this.markSessionDirty(session.id);
      return;
    }
    const startedAt = Date.now();
    repo.saveSession(this.serializeSession(session));
    this.recordMetric({ kind: "storage_direct_write", what: "session", ms: Date.now() - startedAt, rows: 1 });
  }

  private deletePersistedSession(sessionId: string): void {
    this.bumpMutationVersion();
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0 || this.persistenceDeferred > 0) {
      this.markSessionDeleted(sessionId);
      return;
    }
    const startedAt = Date.now();
    repo.deleteSession(sessionId);
    this.recordMetric({ kind: "storage_direct_write", what: "session_delete", ms: Date.now() - startedAt, rows: 1 });
  }

  private persistTask(task: ParkedTaskRecord): void {
    this.bumpMutationVersion();
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0 || this.persistenceDeferred > 0) {
      this.markTaskDirty(task.id);
      return;
    }
    const startedAt = Date.now();
    repo.saveTask(task);
    this.recordMetric({ kind: "storage_direct_write", what: "task", ms: Date.now() - startedAt, rows: 1 });
  }

  private persistCounters(): void {
    this.bumpMutationVersion();
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0 || this.persistenceDeferred > 0) {
      this.markCountersDirty();
      return;
    }
    const startedAt = Date.now();
    repo.saveMeta("objectCounter", String(this.objectCounter));
    repo.saveMeta("parkedTaskCounter", String(this.parkedTaskCounter));
    repo.saveMeta("sessionCounter", String(this.sessionCounter));
    this.recordMetric({ kind: "storage_direct_write", what: "counters", ms: Date.now() - startedAt, rows: 3 });
  }

  private deletePersistedTask(taskId: string): void {
    this.bumpMutationVersion();
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0 || this.persistenceDeferred > 0) {
      this.markTaskDeleted(taskId);
      return;
    }
    const startedAt = Date.now();
    repo.deleteTask(taskId);
    this.recordMetric({ kind: "storage_direct_write", what: "task_delete", ms: Date.now() - startedAt, rows: 1 });
  }

  private flushIncrementalState(): void {
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (!this.persistenceDirty) return;
    if (!this.hasDirtyPersistence()) {
      this.persistenceDirty = false;
      return;
    }
    const dirtyObjects = Array.from(this.dirtyObjects);
    const dirtyObjectSet = new Set(dirtyObjects);
    const deletedObjects = Array.from(this.deletedObjects);
    const deletedObjectSet = new Set(deletedObjects);
    const dirtyProperties = Array.from(this.dirtyProperties.entries()).flatMap(([objRef, properties]) =>
      Array.from(properties).map((name) => ({ objRef, name }))
    );
    const dirtySessions = Array.from(this.dirtySessions);
    const deletedSessions = Array.from(this.deletedSessions);
    const dirtyTasks = Array.from(this.dirtyTasks);
    const deletedTasks = Array.from(this.deletedTasks);
    const dirtyTombstones = Array.from(this.dirtyTombstones);
    const dirtyCounters = this.dirtyCounters;
    const startedAt = Date.now();
    let rows = 0;
    repo.transaction(() => {
      for (const objRef of deletedObjects) {
        repo.deleteObject(objRef);
        rows += 1; // single object row delete; the cascade rows were already committed in earlier flushes
      }
      for (const sessionId of deletedSessions) {
        repo.deleteSession(sessionId);
        rows += 1;
      }
      for (const sessionId of dirtySessions) {
        if (this.deletedSessions.has(sessionId)) continue;
        const session = this.sessions.get(sessionId);
        if (session) {
          repo.saveSession(this.serializeSession(session));
          rows += 1;
        }
      }
      for (const taskId of deletedTasks) {
        repo.deleteTask(taskId);
        rows += 1;
      }
      for (const taskId of dirtyTasks) {
        if (this.deletedTasks.has(taskId)) continue;
        const task = this.parkedTasks.get(taskId);
        if (task) {
          repo.saveTask(task);
          rows += 1;
        }
      }
      for (const objRef of dirtyObjects) {
        if (deletedObjectSet.has(objRef)) continue;
        const obj = this.objects.get(objRef);
        if (obj) {
          const serialized = this.serializeObject(obj);
          repo.saveObject(serialized);
          rows += serializedObjectRowCount(serialized);
        }
      }
      for (const { objRef, name } of dirtyProperties) {
        if (deletedObjectSet.has(objRef) || dirtyObjectSet.has(objRef) || !this.objects.has(objRef)) continue;
        repo.saveProperty(objRef, this.serializeProperty(objRef, name));
        rows += 3; // property_def or DELETE + property_value or DELETE + property_version
      }
      if (dirtyCounters) {
        repo.saveMeta("version", "1");
        repo.saveMeta("objectCounter", String(this.objectCounter));
        repo.saveMeta("parkedTaskCounter", String(this.parkedTaskCounter));
        repo.saveMeta("sessionCounter", String(this.sessionCounter));
        rows += 4;
      }
      const now = Date.now();
      for (const id of dirtyTombstones) {
        repo.saveTombstone(id, now, null);
        rows += 1;
      }
    });
    for (const objRef of dirtyObjects) this.dirtyObjects.delete(objRef);
    for (const objRef of deletedObjects) this.deletedObjects.delete(objRef);
    for (const { objRef, name } of dirtyProperties) {
      const properties = this.dirtyProperties.get(objRef);
      properties?.delete(name);
      if (properties?.size === 0) this.dirtyProperties.delete(objRef);
    }
    for (const sessionId of dirtySessions) this.dirtySessions.delete(sessionId);
    for (const sessionId of deletedSessions) this.deletedSessions.delete(sessionId);
    for (const taskId of dirtyTasks) this.dirtyTasks.delete(taskId);
    for (const taskId of deletedTasks) this.deletedTasks.delete(taskId);
    for (const id of dirtyTombstones) this.dirtyTombstones.delete(id);
    if (dirtyCounters) this.dirtyCounters = false;
    this.persistenceDirty = this.hasDirtyPersistence();
    const persistedProps = dirtyProperties.filter(({ objRef }) => !deletedObjectSet.has(objRef) && !dirtyObjectSet.has(objRef));
    // top_properties answers "what kinds of writes were these"; top_objects
    // answers "where did this flush spend its writes" — both ranked by
    // per-property write count so they're directly comparable. dirtyObjects
    // (the row-level writes for object metadata) and the delete sets are
    // excluded from these breakdowns: they're flat, single-row events that
    // would just produce ties of 1. They're still represented in `objects`.
    this.recordMetric({
      kind: "storage_flush",
      objects: dirtyObjects.length + deletedObjects.length,
      properties: persistedProps.length,
      sessions: dirtySessions.length,
      deleted_sessions: deletedSessions.length,
      tasks: dirtyTasks.length,
      deleted_tasks: deletedTasks.length,
      counters: dirtyCounters,
      ms: Date.now() - startedAt,
      rows,
      top_properties: topByName(persistedProps.map(({ name }) => name), STORAGE_FLUSH_TOP_N),
      top_objects: topByName(persistedProps.map(({ objRef }) => objRef), STORAGE_FLUSH_TOP_N)
    });
  }

  rebuildGuestPool(): void {
    this.guestFreePool.clear();
    const sessions = Array.from(this.sessions.values());
    for (const obj of this.objects.values()) {
      if (obj.id.startsWith("guest_") && obj.parent === "$player" && this.objects.has("$guest")) {
        this.object("$player").children.delete(obj.id);
        obj.parent = "$guest";
        this.object("$guest").children.add(obj.id);
        if (!obj.properties.has("home") && this.objects.has("$nowhere")) {
          obj.properties.set("home", "$nowhere");
          obj.propertyVersions.set("home", (obj.propertyVersions.get("home") ?? 0) + 1);
        }
      }
      if (!obj.id.startsWith("guest_")) continue;
      if (!this.inheritsFrom(obj.id, "$guest")) continue;
      const bound = sessions.some((session) => session.actor === obj.id);
      if (!bound) this.guestFreePool.add(obj.id);
    }
  }

  reapExpiredSessions(now = Date.now()): string[] {
    const reaped: string[] = [];
    if (this.activeObjectRepository()) {
      for (const session of Array.from(this.sessions.values())) {
        if (!this.sessionExpired(session, now)) continue;
        this.reapSession(session.id);
        reaped.push(session.id);
      }
      return reaped;
    }
    this.withPersistencePaused(() => {
      for (const session of Array.from(this.sessions.values())) {
        if (!this.sessionExpired(session, now)) continue;
        this.reapSession(session.id);
        reaped.push(session.id);
      }
    });
    if (reaped.length > 0) this.persist(true);
    return reaped;
  }

  private validateMessage(message: Message): void {
    if (!message || typeof message !== "object") throw wooError("E_INVARG", "message must be a map");
    assertObj(message.actor);
    assertObj(message.target);
    assertString(message.verb);
    if (!Array.isArray(message.args)) throw wooError("E_INVARG", "message.args must be a list");
  }

    private hydrateSession(
      session: { id: string; actor: ObjRef; started: number; expiresAt?: number; lastDetachAt?: number | null; tokenClass?: Session["tokenClass"]; currentLocation?: ObjRef | null; apikeyId?: string },
      now: number
    ): Session {
    const tokenClass = session.tokenClass ?? (this.inheritsFrom(session.actor, "$guest") ? "guest" : "bearer");
    const lastDetachAt = session.lastDetachAt ?? now;
    const expiresAt = Math.max(
      session.expiresAt ?? session.started + this.sessionTtl(tokenClass),
      lastDetachAt + this.sessionGrace(tokenClass)
    );
    return {
      id: session.id,
      actor: session.actor,
      started: session.started,
      expiresAt,
        lastDetachAt,
        tokenClass,
        currentLocation: session.currentLocation && this.objects.has(session.currentLocation) ? session.currentLocation : this.initialSessionLocation(session.actor),
        attachedSockets: new Set(),
      // lastInputAt isn't persisted; on cold rehydrate, treat as just-active
      // rather than restoring some old timestamp from `started`. Otherwise
      // every freshly-rehydrated DO would show huge idle for everyone.
      lastInputAt: now,
      ...(session.apikeyId !== undefined ? { apikeyId: session.apikeyId } : {})
    };
  }

  private tokenClassFor(token: string): Session["tokenClass"] {
    if (token.startsWith("bearer:")) return "bearer";
    if (token.startsWith("apikey:")) return "apikey";
    return "guest";
  }

  private sessionTtl(tokenClass: Session["tokenClass"]): number {
    return tokenClass === "guest" ? GUEST_SESSION_TTL_MS : CREDENTIAL_SESSION_TTL_MS;
  }

  private sessionGrace(tokenClass: Session["tokenClass"]): number {
    return tokenClass === "guest" ? GUEST_SESSION_GRACE_MS : CREDENTIAL_SESSION_GRACE_MS;
  }

  private sessionExpired(session: Session, now: number): boolean {
    if (session.attachedSockets.size > 0) return false;
    if (now >= session.expiresAt) return true;
    if (session.lastDetachAt === null) return false;
    return now >= session.lastDetachAt + this.sessionGrace(session.tokenClass);
  }

    private reapSession(sessionId: string): void {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      const isGuest = this.inheritsFrom(session.actor, "$guest");
      const wasPrimary = this.primarySessionForActorIncludingExpired(session.actor)?.id === sessionId;
      session.attachedSockets.clear();
      this.killReadTasksFor(session.actor);
      this.removeSessionPresence(sessionId, session.actor);
    // session_id mirror is no longer written (see createSessionForActor /
    // ensureSessionForActor); the matching reset on reap would just rewrite
    // the inherited default.
      this.sessions.delete(sessionId);
      this.deletePersistedSession(sessionId);
      if (wasPrimary && !isGuest) this.promoteActorPrimaryLocation(session.actor);
      if (isGuest) this.resetGuestOnDisconnect(session.actor);
    }

    private promoteActorPrimaryLocation(actor: ObjRef): void {
      const primary = this.primarySessionForActor(actor);
      if (!primary) return;
      if (this.objects.has(actor) && this.objects.get(actor)!.location !== primary.currentLocation) {
        this.moveObject(actor, primary.currentLocation);
      }
    }

  private resetGuestOnDisconnect(actor: ObjRef): void {
    const homeValue = this.propOrNull(actor, "home");
    const home = typeof homeValue === "string" && this.objects.has(homeValue) ? homeValue : "$nowhere";
    const fallback = this.guestInventoryFallback(actor, home);
    const contents = this.object(actor).contents;
    for (const item of Array.from(contents)) {
      if (!this.objects.has(item)) {
        contents.delete(item);
        continue;
      }
      this.moveObject(item, this.inventoryEjectTarget(item, fallback));
    }
    this.moveObject(actor, home);
    this.setProp(actor, "description", "");
    this.setProp(actor, "aliases", []);
    this.setProp(actor, "features", []);
    this.setProp(actor, "features_version", Number(this.propOrNull(actor, "features_version") ?? 0) + 1);
    this.returnGuest(actor);
  }

  private guestInventoryFallback(actor: ObjRef, home: ObjRef): ObjRef {
    const location = this.objects.get(actor)?.location;
    return location && location !== "$nowhere" && this.objects.has(location) ? location : home;
  }

  private inventoryEjectTarget(item: ObjRef, fallback: ObjRef): ObjRef {
    const homeValue = this.propOrNull(item, "home");
    return typeof homeValue === "string" && this.objects.has(homeValue) ? homeValue : fallback;
  }

  private killReadTasksFor(actor: ObjRef): void {
    for (const [id, task] of Array.from(this.parkedTasks.entries())) {
      if (task.state === "awaiting_read" && task.awaiting_player === actor) {
        this.parkedTasks.delete(id);
        this.deletePersistedTask(id);
      }
    }
  }

    private removeSessionPresence(sessionId: string, actor: ObjRef): void {
      for (const obj of this.objects.values()) {
        const raw = obj.properties.get("session_subscribers");
        if (!Array.isArray(raw)) continue;
        if (!raw.some((item) => !!item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, WooValue>).session === sessionId)) continue;
        this.updateSpaceSubscriberLocal(obj.id, actor, false, sessionId);
      }
      this.removeActorActiveLists(actor);
    }

  private removeActorActiveLists(actor: ObjRef): void {
    for (const obj of this.objects.values()) {
      const raw = obj.properties.get("operators");
      if (!Array.isArray(raw) || !raw.includes(actor)) continue;
      this.setProp(obj.id, "operators", raw.filter((item) => item !== actor) as WooValue[]);
    }
    if (!this.objects.has(actor)) return;
    const focusList = this.propOrNull(actor, "focus_list");
    if (Array.isArray(focusList) && focusList.length > 0) this.setProp(actor, "focus_list", []);
  }

  private moveObject(objRef: ObjRef, targetRef: ObjRef): void {
    const obj = this.object(objRef);
    this.object(targetRef);
    const oldLocation = obj.location;
    if (oldLocation && this.objects.has(oldLocation)) this.object(oldLocation).contents.delete(objRef);
    obj.location = targetRef;
    this.object(targetRef).contents.add(objRef);
    obj.modified = Date.now();
    this.persistObject(objRef);
    if (oldLocation) this.persistObject(oldLocation);
    this.persistObject(targetRef);
  }

  private async moveObjectOwned(objRef: ObjRef, targetRef: ObjRef, options: { suppressMirrorHost?: string | null } = {}): Promise<MoveObjectResult> {
    const obj = this.object(objRef);
    const targetRemote = await this.remoteHostForObject(targetRef);
    if (!targetRemote) this.object(targetRef);
    const oldLocation = obj.location;
    obj.location = targetRef;
    obj.modified = Date.now();
    this.persistObject(objRef);
    if (oldLocation && oldLocation !== targetRef) await this.mirrorContainerContents(oldLocation, objRef, false, options);
    await this.mirrorContainerContents(targetRef, objRef, true, options);
    return { oldLocation, location: targetRef };
  }

  private async mirrorContainerContents(
    containerRef: ObjRef,
    objRef: ObjRef,
    present: boolean,
    options: { suppressMirrorHost?: string | null } = {}
  ): Promise<void> {
    const remote = await this.remoteHostForObject(containerRef);
    if (remote) {
      if (options.suppressMirrorHost && remote === options.suppressMirrorHost) return;
      if (!this.hostBridge) throw wooError("E_INTERNAL", "remote host bridge unavailable");
      await this.hostBridge.mirrorContents(containerRef, objRef, present);
      return;
    }
    if (this.objects.has(containerRef)) this.mirrorContents(containerRef, objRef, present);
  }

  private returnGuest(actor: ObjRef): void {
    if (!this.inheritsFrom(actor, "$guest")) return;
    if (Array.from(this.sessions.values()).some((session) => session.actor === actor)) return;
    this.guestFreePool.add(actor);
  }

  private collectVerbNames(startRef: ObjRef | null, names: Set<string>): void {
    let current: ObjRef | null = startRef;
    while (current) {
      const obj = this.object(current);
      for (const verb of obj.verbs) names.add(verb.name);
      current = obj.parent;
    }
  }

  private collectSchemaNames(startRef: ObjRef | null, names: Set<string>): void {
    let current: ObjRef | null = startRef;
    while (current) {
      const obj = this.object(current);
      for (const name of obj.eventSchemas.keys()) names.add(name);
      current = obj.parent;
    }
  }

    private authorizePresence(actor: ObjRef, space: ObjRef, sessionId: string | null = null): void {
      if (this.isWizard(actor)) return;
      if (sessionId && (this.hasSessionPresence(sessionId, space) || this.currentLocationForSession(sessionId) === space)) return;
      if (!this.hasPresence(actor, space)) {
        throw wooError("E_PERM", `${actor} is not present in ${space}`);
      }
  }

  private featureList(objRef: ObjRef): ObjRef[] {
    const value = this.getProp(objRef, "features");
    if (!Array.isArray(value)) throw wooError("E_TYPE", "features must be a list", value);
    return value.map((item) => assertObj(item));
  }

  private canCarryFeatures(objRef: ObjRef): boolean {
    return this.inheritsFrom(objRef, "$actor") || this.inheritsFrom(objRef, "$space");
  }

  private assertFeatureConsumer(objRef: ObjRef): void {
    if (!this.canCarryFeatures(objRef)) throw wooError("E_NOTAPPLICABLE", `${objRef} cannot carry features`, objRef);
  }

  isWizard(actor: ObjRef): boolean {
    return this.canBypassPerms(actor);
  }

  private canBypassPerms(actor: ObjRef): boolean {
    return this.objects.get(actor)?.flags.wizard === true;
  }

  recordWizardAction(actor: ObjRef, action: string, details: Record<string, WooValue>): void {
    const raw = this.propOrNull("$system", "wizard_actions");
    const actions = Array.isArray(raw) ? raw : [];
    this.setProp("$system", "wizard_actions", [...actions, { ts: Date.now(), actor, action, ...details }]);
  }

  /**
   * Wizard-only flag mutation. Updates the target's authority/lifecycle bits
   * in place and records a wizard_action audit entry per changed flag.
   *
   * Allowed flags: wizard, programmer, fertile. Unknown keys are ignored.
   * Boolean coerced; non-bool values raise E_TYPE. The target must exist;
   * passing $system or $wiz revokes nothing the substrate would not already
   * protect, but we still audit.
   *
   * Required for the auth.md §A11 "mint a backup wizard" flow — the only
   * in-world surface that can grant wizard authority to a non-substrate
   * object after boot.
   */
  setObjectFlags(actor: ObjRef, target: ObjRef, flags: Record<string, unknown>): WooObject["flags"] {
    if (!this.canBypassPerms(actor)) throw wooError("E_PERM", "wizard authority required to set object flags", { actor, target });
    if (!this.objects.has(target)) throw wooError("E_OBJNF", `target object not found: ${target}`, target);
    const allowed = new Set(["wizard", "programmer", "fertile"]);
    const obj = this.object(target);
    const before: Record<string, boolean> = { ...obj.flags };
    const changes: Record<string, { from: boolean; to: boolean }> = {};
    for (const [key, raw] of Object.entries(flags)) {
      if (!allowed.has(key)) continue;
      if (typeof raw !== "boolean") throw wooError("E_TYPE", `flag ${key} must be boolean`, { key, value: raw as WooValue });
      const prev = Boolean(before[key]);
      if (prev === raw) continue;
      (obj.flags as Record<string, boolean>)[key] = raw;
      changes[key] = { from: prev, to: raw };
    }
    if (Object.keys(changes).length === 0) return { ...obj.flags };
    this.recordWizardAction(actor, "set_object_flags", { target, changes: changes as unknown as WooValue });
    this.markObjectDirty(target);
    return { ...obj.flags };
  }

  private bumpFeaturesVersion(objRef: ObjRef): void {
    const current = Number(this.getProp(objRef, "features_version") ?? 0);
    this.setProp(objRef, "features_version", Number.isFinite(current) ? current + 1 : 1);
  }

  private async canFeatureBeAttachedBy(feature: ObjRef, actor: ObjRef): Promise<boolean> {
    const message: Message = { actor, target: feature, verb: "can_be_attached_by", args: [actor] };
    const observations: Observation[] = [];
    const ctx: CallContext = {
        world: this,
        space: "#-1",
        seq: -1,
        session: null,
      actor,
      player: actor,
      caller: "#-1",
      callerPerms: actor,
      progr: actor,
      thisObj: feature,
      verbName: "can_be_attached_by",
      definer: feature,
      message,
      observations,
      hostMemo: createHostOperationMemo(),
      observe: () => {
        // Attachment-policy checks are predicates; observations are ignored.
      }
    };
    try {
      return Boolean(await this.dispatch(ctx, feature, "can_be_attached_by", [actor]));
    } catch (err) {
      const error = normalizeError(err);
      if (error.code === "E_VERBNF") return actor === this.object(feature).owner;
      throw err;
    }
  }

  private async addFeature(consumer: ObjRef, feature: ObjRef, actor: ObjRef, observations?: Observation[]): Promise<boolean> {
    this.assertFeatureConsumer(consumer);
    if (feature.startsWith("~")) throw wooError("E_INVARG", "transient objects cannot be features", feature);
    this.object(feature);
    if (consumer === feature) throw wooError("E_RECMOVE", "object cannot add itself as a feature", feature);
    const consumerOwner = this.object(consumer).owner;
    const wizard = this.isWizard(actor);
    if (!wizard && consumerOwner !== actor) throw wooError("E_PERM", `${actor} cannot add features to ${consumer}`);
    if (!wizard && !(await this.canFeatureBeAttachedBy(feature, actor))) throw wooError("E_PERM", `${feature} cannot be attached by ${actor}`);
    const features = this.featureList(consumer);
    if (features.includes(feature)) {
      observations?.push({ type: "feature_already_added", source: consumer, feature });
      return false;
    }
    this.setProp(consumer, "features", [...features, feature]);
    this.bumpFeaturesVersion(consumer);
    observations?.push({ type: "feature_added", source: consumer, feature });
    return true;
  }

  private removeFeature(consumer: ObjRef, feature: ObjRef, actor: ObjRef, observations?: Observation[]): boolean {
    this.assertFeatureConsumer(consumer);
    this.object(feature);
    const consumerOwner = this.object(consumer).owner;
    if (!this.isWizard(actor) && consumerOwner !== actor) throw wooError("E_PERM", `${actor} cannot remove features from ${consumer}`);
    const features = this.featureList(consumer);
    if (!features.includes(feature)) return false;
    this.setProp(consumer, "features", features.filter((item) => item !== feature));
    this.bumpFeaturesVersion(consumer);
    observations?.push({ type: "feature_removed", source: consumer, feature });
    return true;
  }

  private async directAudience(target: ObjRef, memo?: HostOperationMemo): Promise<ObjRef | null> {
    const obj = this.object(target);
    if (await this.isDescendantOfCheckedOrFalse(target, "$space", memo)) return target;
    if (obj.anchor && await this.isDescendantOfCheckedOrFalse(obj.anchor, "$space", memo)) return obj.anchor;
    if (obj.location && await this.isDescendantOfCheckedOrFalse(obj.location, "$space", memo)) return obj.location;
    return null;
  }

  private async isDescendantOfCheckedOrFalse(objRef: ObjRef, ancestorRef: ObjRef, memo?: HostOperationMemo): Promise<boolean> {
    try {
      return await this.isDescendantOfChecked(objRef, ancestorRef, memo);
    } catch (err) {
      if (!isReadAvailabilityError(err)) throw err;
      // Audience discovery is intentionally tolerant: a stale anchor, stale
      // location mirror, or unreachable remote host means "no audience here",
      // not "fail the direct call before the verb can run".
      return false;
    }
  }

  private liveAudienceActors(space: ObjRef): ObjRef[] | undefined {
    // Existence check is via the property: an absent `subscribers` list is
    // not the same as an empty subscriber list (the former returns
    // undefined; broadcast then falls back). The index can't distinguish.
    const raw = this.propOrNull(space, "subscribers");
    if (!Array.isArray(raw)) return undefined;
    this.ensurePresenceIndex();
    const subs = this.subscribersIndex.get(space);
    return subs ? Array.from(subs) : [];
  }

  // Compute the per-observation audience for a direct call from this host's
  // authoritative subscribers/presence view. Public so cross-host RPC handlers
  // can compute audience at the source DO before forwarding to broadcast.
  async computeDirectLiveAudiences(audience: ObjRef | null, observations: Observation[]): Promise<{ audienceActors?: ObjRef[]; observationAudiences?: ObjRef[][]; audienceSessions?: string[]; observationSessionAudiences?: string[][] }> {
    return await this.directLiveAudiences(audience, observations);
  }

  private async directLiveAudiences(audience: ObjRef | null, observations: Observation[]): Promise<{ audienceActors?: ObjRef[]; observationAudiences?: ObjRef[][]; audienceSessions?: string[]; observationSessionAudiences?: string[][] }> {
    const actors = new Set<ObjRef>();
    const sessions = new Set<string>();
    const observationAudiences: ObjRef[][] = [];
    const observationSessionAudiences: string[][] = [];
    for (const observation of observations) {
      const present = this.observationAudienceActors(audience, observation) ?? [];
      const presentSessions = await this.observationAudienceSessions(audience, observation) ?? [];
      observationAudiences.push(present);
      observationSessionAudiences.push(presentSessions);
      for (const actor of present) actors.add(actor);
      for (const session of presentSessions) sessions.add(session);
      delete (observation as Record<string, unknown>)._audience_override;
    }
    return {
      audienceActors: actors.size > 0 ? Array.from(actors) : undefined,
      observationAudiences: observations.length > 0 ? observationAudiences : undefined,
      audienceSessions: sessions.size > 0 ? Array.from(sessions) : undefined,
      observationSessionAudiences: observations.length > 0 ? observationSessionAudiences : undefined
    };
  }

  private appliedFrameAudience(space: ObjRef, observations: Observation[]): { audienceSessions?: string[]; observationSessionAudiences?: string[][] } {
    const sessionMap = this.presenceSessionsIn(space);
    const sessions = sessionMap ? Array.from(sessionMap.keys()) : [];
    return {
      audienceSessions: sessions.length > 0 ? sessions : undefined,
      observationSessionAudiences: observations.length > 0 ? observations.map(() => sessions) : undefined
    };
  }

  private observationAudienceActors(fallbackAudience: ObjRef | null, observation: Observation): ObjRef[] | undefined {
    // Per-observation audience override. Used when the source is a remote
    // $space whose subscriber list this host can't read locally — the caller
    // pre-fetches subscribers cross-host and stamps them here. The field is
    // stripped from the observation by directLiveAudiences before broadcast.
    const override = (observation as Record<string, unknown>)._audience_override;
    if (Array.isArray(override)) {
      return override.filter((item): item is ObjRef => typeof item === "string");
    }
    if ((observation.type === "looked" || observation.type === "who") && typeof observation.to === "string") {
      return [observation.to];
    }
    if (typeof observation.target === "string") {
      if (this.objects.has(observation.target) && this.inheritsFrom(observation.target, "$actor")) return [observation.target];
      if (!this.objects.has(observation.target)) return [observation.target];
    }
    const directed = directedRecipients(observation);
    if (directed.to) {
      const actors = [directed.to];
      if (directed.from) actors.push(directed.from);
      return actors;
    }
    const source = typeof observation.source === "string" && this.objects.has(observation.source) && this.inheritsFrom(observation.source, "$space")
      ? observation.source
      : null;
    const audience = source ?? fallbackAudience;
    if (!audience) return undefined;
    const present = this.liveAudienceActors(audience);
    if (!present) return undefined;
    if ((observation.type === "entered" || observation.type === "left" || observation.type === "taken" || observation.type === "dropped") && typeof observation.actor === "string") {
      return present.filter((actor) => actor !== observation.actor);
    }
    return present;
  }

  private async observationAudienceSessions(fallbackAudience: ObjRef | null, observation: Observation): Promise<string[] | undefined> {
    const actors = this.observationAudienceActors(fallbackAudience, observation);
    if (!actors) return undefined;
    const actorSet = new Set(actors);
    const source = typeof observation.source === "string" && this.objects.has(observation.source) && this.inheritsFrom(observation.source, "$space")
      ? observation.source
      : null;
    const audience = source ?? fallbackAudience;
    const sessionMap = audience ? this.presenceSessionsIn(audience) : null;
    if (sessionMap) {
      const sessions: string[] = [];
      for (const [sessionId, actor] of sessionMap) {
        if (actorSet.has(actor)) sessions.push(sessionId);
      }
      return sessions;
    }
    if (audience && this.hostBridge && await this.remoteHostForObject(audience)) {
      try {
        return await this.hostBridge.spaceAudienceSessions?.(audience, actors) ?? [];
      } catch {
        // Remote audience lookup is best-effort; over-broadcasting to every
        // session for these actors would violate session-location isolation.
        return [];
      }
    }
    const sessions: string[] = [];
    for (const session of this.sessions.values()) {
      if (actorSet.has(session.actor)) sessions.push(session.id);
    }
    return sessions;
  }

    private isSpaceLike(objRef: ObjRef): boolean {
      try {
        if (this.inheritsFrom(objRef, "$space")) return true;
        this.getProp(objRef, "next_seq");
        return true;
      } catch {
        return false;
      }
    }

    private async spaceLikeOrRemote(objRef: ObjRef, memo?: HostOperationMemo): Promise<boolean> {
      if (this.objects.has(objRef)) return this.isSpaceLike(objRef);
      return Boolean(await this.remoteHostForObject(objRef, memo));
    }

    private inheritsFrom(objRef: ObjRef, ancestorRef: ObjRef): boolean {
    let current: ObjRef | null = objRef;
    while (current) {
      if (current === ancestorRef) return true;
      current = this.object(current).parent;
    }
    return false;
  }

  isDescendantOf(objRef: ObjRef, ancestorRef: ObjRef): boolean {
    return this.inheritsFrom(objRef, ancestorRef);
  }

  isDescendantOfChecked(objRef: ObjRef, ancestorRef: ObjRef, memo?: HostOperationMemo): boolean | Promise<boolean> {
    if (objRef === ancestorRef) return true;
    if (this.objects.has(objRef)) return this.inheritsFrom(objRef, ancestorRef);
    return this.remoteIsDescendantOfChecked(objRef, ancestorRef, memo);
  }

  private async remoteIsDescendantOfChecked(objRef: ObjRef, ancestorRef: ObjRef, memo?: HostOperationMemo): Promise<boolean> {
    if (await this.remoteHostForObject(objRef, memo)) {
      if (!this.hostBridge) throw wooError("E_INTERNAL", "remote host bridge unavailable");
      return await this.hostBridge.isDescendantOf(objRef, ancestorRef, memo);
    }
    this.object(objRef);
    return false;
  }

  private async updatePresenceChecked(actor: ObjRef, space: ObjRef, present: boolean, ctx?: CallContext): Promise<boolean> {
    const actorRemote = await this.remoteHostForObject(actor);
    const spaceRemote = await this.remoteHostForObject(space);
    const sessionId = this.presenceSessionId(actor, ctx);
    if (!actorRemote && !spaceRemote) return this.updatePresence(actor, space, present, sessionId);
    if (!this.hostBridge && (actorRemote || spaceRemote)) throw wooError("E_INTERNAL", "remote host bridge unavailable");
    if (ctx?.deferHostEffect) {
      let changed = false;
      if (actorRemote) {
        ctx.deferHostEffect({ kind: "actor_presence", actor, space, present, session: sessionId });
        changed = true;
      } else {
        changed = this.updateActorPresenceLocal(actor, space, present, sessionId) || changed;
      }
      if (spaceRemote) {
        ctx.deferHostEffect({ kind: "space_subscriber", space, actor, present, session: sessionId });
        changed = true;
      } else {
        changed = this.updateSpaceSubscriberLocal(space, actor, present, sessionId) || changed;
      }
      return changed;
    }
    let changed = false;
    if (actorRemote) changed = (await this.setActorPresenceChecked(actor, space, present, sessionId)) || changed;
    else changed = this.updateActorPresenceLocal(actor, space, present, sessionId) || changed;
    if (spaceRemote) changed = (await this.setSpaceSubscriberChecked(space, actor, present, sessionId)) || changed;
    else changed = this.updateSpaceSubscriberLocal(space, actor, present, sessionId) || changed;
    return changed;
  }

  private async setActorPresenceChecked(actor: ObjRef, space: ObjRef, present: boolean, sessionId: string = this.presenceSessionId(actor)): Promise<boolean> {
    const actorRemote = await this.remoteHostForObject(actor);
    if (!actorRemote) {
      if (present) {
        const session = this.sessions.get(sessionId);
        if (session && session.actor === actor) {
          session.currentLocation = space;
          this.persistSession(session);
        }
      }
      return this.updateActorPresenceLocal(actor, space, present, sessionId);
    }
    if (!this.hostBridge) throw wooError("E_INTERNAL", "remote host bridge unavailable");
    await this.hostBridge.setActorPresence(actor, space, present, sessionId);
    return true;
  }

  private async setSpaceSubscriberChecked(space: ObjRef, actor: ObjRef, present: boolean, sessionId: string = this.presenceSessionId(actor)): Promise<boolean> {
    const spaceRemote = await this.remoteHostForObject(space);
    if (!spaceRemote) return this.updateSpaceSubscriberLocal(space, actor, present, sessionId);
    if (!this.hostBridge) throw wooError("E_INTERNAL", "remote host bridge unavailable");
    await this.hostBridge.setSpaceSubscriber(space, actor, present, sessionId);
    return true;
  }

  private updatePresence(actor: ObjRef, space: ObjRef, present: boolean, sessionId: string = this.presenceSessionId(actor)): boolean {
    if (present) {
      const session = this.sessions.get(sessionId);
      if (session && session.actor === actor) {
        session.currentLocation = space;
        this.persistSession(session);
      }
    }
    const actorChanged = this.updateActorPresenceLocal(actor, space, present, sessionId);
    const spaceChanged = this.updateSpaceSubscriberLocal(space, actor, present, sessionId);
    return actorChanged || spaceChanged;
  }

  private updateActorPresenceLocal(actor: ObjRef, space: ObjRef, present: boolean, sessionId: string = this.presenceSessionId(actor)): boolean {
    void space;
    void present;
    void sessionId;
    this.object(actor);
    return false;
  }

  private updateSpaceSubscriberLocal(space: ObjRef, actor: ObjRef, present: boolean, sessionId: string = this.presenceSessionId(actor)): boolean {
    this.object(space);
    const rawSubscribers = this.getProp(space, "subscribers");
    if (!Array.isArray(rawSubscribers)) throw wooError("E_TYPE", `${space}.subscribers must be a list`, rawSubscribers);
    const rawSessionSubscribers = this.propOrNull(space, "session_subscribers");
    const parsedSessionSubscribers = Array.isArray(rawSessionSubscribers)
      ? rawSessionSubscribers
        .filter((item): item is Record<string, WooValue> => !!item && typeof item === "object" && !Array.isArray(item))
        .map((item) => ({ session: String(item.session ?? ""), actor: String(item.actor ?? "") as ObjRef }))
        .filter((item) => item.session && item.actor)
      : [];
    const sessionSubscribers = parsedSessionSubscribers.length > 0
      ? parsedSessionSubscribers
      : rawSubscribers
        .filter((item): item is ObjRef => typeof item === "string")
        .map((item) => ({ session: `legacy:${item}`, actor: item }));
    const without = sessionSubscribers.filter((item) => item.session !== sessionId);
    const nextSessionSubscribers = present ? [...without, { session: sessionId, actor }] : without;
    const nextSubscribers = Array.from(new Set(nextSessionSubscribers.map((item) => item.actor))).sort();

    const changed = !valuesEqual(nextSubscribers, rawSubscribers) || !valuesEqual(nextSessionSubscribers, sessionSubscribers);
    if (!changed) return false;

    this.withPersistenceDeferred(() => {
      this.setProp(space, "session_subscribers", nextSessionSubscribers as unknown as WooValue);
      this.setProp(space, "subscribers", nextSubscribers);
    });
    this.recordMetric({ kind: "subscribers_write", space, size: nextSubscribers.length, delta: present ? 1 : -1 });
    return true;
  }

  private presenceSessionId(actor: ObjRef, ctx?: CallContext): string {
    // No-session callers still need a stable row key for bridge-era
    // subscribers. These legacy rows are bounded to internal/replay paths and
    // are superseded by real session rows whenever a live actor enters.
    return ctx?.session ?? this.primarySessionForActor(actor)?.id ?? `legacy:${actor}`;
  }

  private async runParkedTask(task: ParkedTaskRecord, input?: WooValue): Promise<ParkedTaskRun> {
    try {
      const serialized = assertMap(task.serialized);
      if (serialized.kind === "vm_continuation") return await this.runParkedVmContinuation(task, serialized, input);
      if (serialized.kind !== "fork") throw wooError("E_INVARG", "unsupported parked task kind", serialized.kind);
      const actor = assertObj(serialized.actor);
      const player = assertObj(serialized.player);
      const progr = assertObj(serialized.progr);
      const target = assertObj(serialized.target);
      const verbName = assertString(serialized.verb);
      const args = Array.isArray(serialized.args) ? (cloneValue(serialized.args) as WooValue[]) : [];
      const rawSpace = serialized.space;
      if (typeof rawSpace === "string" && rawSpace !== "#-1") {
        const message: Message = { actor, target, verb: verbName, args };
        const frame = await this.applyCall(undefined, rawSpace, message);
        return { task, frame, observations: frame.observations };
      }
      const message =
        serialized.message && typeof serialized.message === "object" && !Array.isArray(serialized.message)
          ? (cloneValue(serialized.message as WooValue) as unknown as Message)
          : { actor, target, verb: verbName, args };
      const observations: Observation[] = [];
      const hostSpace = "#-1";
      const ctx: CallContext = {
          world: this,
          space: hostSpace,
          seq: -1,
          session: null,
        actor,
        player,
        caller: "#-1",
        callerPerms: progr,
        progr,
        thisObj: target,
        verbName,
        definer: target,
        message,
        observations,
        hostMemo: createHostOperationMemo(),
        observe: (event) => {
          observations.push({ ...event, source: event.source ?? hostSpace });
        }
      };

      let error: ErrorValue | undefined;
      await this.withPersistencePaused(async () => {
        const before = this.snapshotProps();
        const beforeParkedTasks = new Map(this.parkedTasks);
        const beforeParkedTaskCounter = this.parkedTaskCounter;
        try {
          await this.dispatch(ctx, target, verbName, args);
        } catch (err) {
          if (isVmSuspendSignal(err)) {
            const resumedTask = this.parkVmContinuation(ctx, err.seconds, err.task);
            observations.push({ type: "task_suspended", source: hostSpace, task: resumedTask, resume_at: this.parkedTasks.get(resumedTask)?.resume_at ?? null });
            return;
          }
          if (isVmReadSignal(err)) {
            const resumedTask = this.parkReadContinuation(ctx, err.player, err.task);
            observations.push({ type: "task_awaiting_read", source: hostSpace, task: resumedTask, player: err.player });
            return;
          }
          this.restoreProps(before);
          this.parkedTasks = new Map(beforeParkedTasks);
          this.parkedTaskCounter = beforeParkedTaskCounter;
          error = normalizeError(err);
          observations.length = 0;
          observations.push({ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] });
        }
      });
      return { task, observations, error };
    } catch (err) {
      const error = normalizeError(err);
      return { task, observations: [{ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] }], error };
    }
  }

  private async runParkedVmContinuation(task: ParkedTaskRecord, serialized: Record<string, WooValue>, input?: WooValue): Promise<ParkedTaskRun> {
    const rawSpace = serialized.space;
    if (typeof rawSpace === "string" && rawSpace !== "#-1") {
      const frame = await this.applyResumeFrame(task, serialized, rawSpace, input);
      return { task, frame, observations: frame.observations };
    }

    const observations: Observation[] = [];
    let error: ErrorValue | undefined;
    await this.withPersistencePaused(async () => {
      const before = this.snapshotProps();
      const beforeParkedTasks = new Map(this.parkedTasks);
      const beforeParkedTaskCounter = this.parkedTaskCounter;
      try {
        if (input === undefined) await runSerializedTinyVmTask(this, serialized.task as unknown as SerializedVmTask, observations);
        else await runSerializedTinyVmTaskWithInput(this, serialized.task as unknown as SerializedVmTask, input, observations);
      } catch (err) {
        if (isVmSuspendSignal(err)) {
          const resumedTask = this.parkVmContinuation(this.hostContinuationContext(serialized, observations), err.seconds, err.task);
          observations.push({ type: "task_suspended", source: "#-1", task: resumedTask, resume_at: this.parkedTasks.get(resumedTask)?.resume_at ?? null });
          return;
        }
        if (isVmReadSignal(err)) {
          const resumedTask = this.parkReadContinuation(this.hostContinuationContext(serialized, observations), err.player, err.task);
          observations.push({ type: "task_awaiting_read", source: "#-1", task: resumedTask, player: err.player });
          return;
        }
        this.restoreProps(before);
        this.parkedTasks = new Map(beforeParkedTasks);
        this.parkedTaskCounter = beforeParkedTaskCounter;
        error = normalizeError(err);
        observations.length = 0;
        observations.push({ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] });
      }
    });
    return { task, observations, error };
  }

  private async applyResumeFrame(task: ParkedTaskRecord, serialized: Record<string, WooValue>, spaceRef: ObjRef, input?: WooValue): Promise<AppliedFrame> {
    const repo = this.activeObjectRepository();
    if (repo) return await this.applyResumeFrameRepository(repo, task, serialized, spaceRef, input);
    return await this.withPersistencePaused(async () => {
      const actor = assertObj(serialized.actor);
      this.authorizePresence(actor, spaceRef);
      const space = this.object(spaceRef);
      const nextSeq = Number(this.getProp(spaceRef, "next_seq"));
      const seq = nextSeq;
      this.setProp(spaceRef, "next_seq", nextSeq + 1);

      const body: Record<string, WooValue> = {
        kind: input === undefined ? "vm_resume" : "vm_read",
        task: task.id,
        continuation: cloneValue(serialized.task as WooValue)
      };
      if (input !== undefined) body.input = cloneValue(input);
      const message: Message = {
        actor,
        target: spaceRef,
        verb: "$resume",
        args: [task.id],
        body
      };
      const logEntry: SpaceLogEntry = {
        space: spaceRef,
        seq,
        ts: Date.now(),
        actor,
        message: cloneValue(message) as Message,
        observations: [],
        applied_ok: true
      };
      const log = this.logs.get(spaceRef) ?? [];
      log.push(logEntry);
      this.logs.set(spaceRef, log);

      const observations: Observation[] = [{ type: "task_resumed", source: spaceRef, task: task.id }];
      try {
        await this.withBehaviorSavepoint(async () => {
          if (input === undefined) await runSerializedTinyVmTask(this, serialized.task as unknown as SerializedVmTask, observations);
          else await runSerializedTinyVmTaskWithInput(this, serialized.task as unknown as SerializedVmTask, input, observations);
        });
      } catch (err) {
        if (isVmSuspendSignal(err)) {
          const resumedTask = this.parkVmContinuation(this.resumeContext(serialized, message, observations, spaceRef, seq), err.seconds, err.task);
          observations.push({ type: "task_suspended", source: spaceRef, task: resumedTask, resume_at: this.parkedTasks.get(resumedTask)?.resume_at ?? null });
        } else if (isVmReadSignal(err)) {
          const resumedTask = this.parkReadContinuation(this.resumeContext(serialized, message, observations, spaceRef, seq), err.player, err.task);
          observations.push({ type: "task_awaiting_read", source: spaceRef, task: resumedTask, player: err.player });
        } else {
          const error = normalizeError(err);
          logEntry.applied_ok = false;
          logEntry.error = error;
          observations.length = 0;
          observations.push({ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] });
        }
      }

      logEntry.observations = cloneValue(observations as unknown as WooValue) as unknown as Observation[];
      const frame = { op: "applied" as const, space: space.id, seq, ts: logEntry.ts, message, observations };
      this.persist(true);
      return frame;
    });
  }

  private async applyResumeFrameRepository(repo: ObjectRepository, task: ParkedTaskRecord, serialized: Record<string, WooValue>, spaceRef: ObjRef, input?: WooValue): Promise<AppliedFrame> {
    const before = this.snapshotBehaviorState();
    const beforeLogs = this.snapshotLogs();
    try {
      const frame = await this.withPersistencePaused(async () => {
        const actor = assertObj(serialized.actor);
        this.authorizePresence(actor, spaceRef);
        const space = this.object(spaceRef);
        const body: Record<string, WooValue> = {
          kind: input === undefined ? "vm_resume" : "vm_read",
          task: task.id,
          continuation: cloneValue(serialized.task as WooValue)
        };
        if (input !== undefined) body.input = cloneValue(input);
        const message: Message = {
          actor,
          target: spaceRef,
          verb: "$resume",
          args: [task.id],
          body
        };
        const seq = Number(this.getProp(spaceRef, "next_seq"));
        const ts = Date.now();
        this.setPropLocal(spaceRef, "next_seq", seq + 1);
        const logEntry: SpaceLogEntry = {
          space: spaceRef,
          seq,
          ts,
          actor,
          message: cloneValue(message) as Message,
          observations: [],
          applied_ok: true
        };
        const log = this.logs.get(spaceRef) ?? [];
        log.push(logEntry);
        this.logs.set(spaceRef, log);
        // `state(actor).spaces` exposes next_seq/log_count. In repository
        // mode, appendLog persists next_seq directly, bypassing persistProperty.
        this.bumpMutationVersion();

        const observations: Observation[] = [{ type: "task_resumed", source: spaceRef, task: task.id }];
        try {
          await this.withBehaviorSavepoint(async () => {
            if (input === undefined) await runSerializedTinyVmTask(this, serialized.task as unknown as SerializedVmTask, observations);
            else await runSerializedTinyVmTaskWithInput(this, serialized.task as unknown as SerializedVmTask, input, observations);
          });
          logEntry.applied_ok = true;
        } catch (err) {
          if (isVmSuspendSignal(err)) {
            const resumedTask = this.parkVmContinuation(this.resumeContext(serialized, message, observations, spaceRef, seq), err.seconds, err.task);
            logEntry.applied_ok = true;
            observations.push({ type: "task_suspended", source: spaceRef, task: resumedTask, resume_at: this.parkedTasks.get(resumedTask)?.resume_at ?? null });
          } else if (isVmReadSignal(err)) {
            const resumedTask = this.parkReadContinuation(this.resumeContext(serialized, message, observations, spaceRef, seq), err.player, err.task);
            logEntry.applied_ok = true;
            observations.push({ type: "task_awaiting_read", source: spaceRef, task: resumedTask, player: err.player });
          } else {
            const error = normalizeError(err);
            logEntry.applied_ok = false;
            logEntry.error = error;
            observations.length = 0;
            observations.push({ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] });
          }
        }

        logEntry.observations = cloneValue(observations as unknown as WooValue) as unknown as Observation[];
        repo.transaction(() => {
          const appended = repo.appendLog(spaceRef, actor, message);
          if (appended.seq !== seq) throw wooError("E_STORAGE", `sequenced log drift for ${spaceRef}: expected ${seq}, got ${appended.seq}`);
          logEntry.ts = appended.ts;
          repo.recordLogOutcome(spaceRef, seq, logEntry.applied_ok === true, observations, logEntry.error);
          this.flushIncrementalState();
        });
        return { op: "applied" as const, space: space.id, seq, ts: logEntry.ts, message, observations };
      });
      return frame;
    } catch (err) {
      this.restoreBehaviorState(before);
      this.logs = beforeLogs;
      throw err;
    }
  }

  private resumeContext(serialized: Record<string, WooValue>, message: Message, observations: Observation[], space: ObjRef, seq: number): CallContext {
    return {
        world: this,
        space,
        seq,
        session: typeof serialized.session === "string" ? serialized.session : null,
      actor: assertObj(serialized.actor),
      player: assertObj(serialized.player),
      caller: "#-1",
      callerPerms: typeof serialized.callerPerms === "string" ? serialized.callerPerms : assertObj(serialized.progr),
      progr: assertObj(serialized.progr),
      thisObj: typeof serialized.target === "string" ? serialized.target : space,
      verbName: typeof serialized.verb === "string" ? serialized.verb : "$resume",
      definer: typeof serialized.target === "string" ? serialized.target : space,
      message,
      observations,
      observe: (event) => {
        observations.push({ ...event, source: event.source ?? space });
      }
    };
  }

  private hostContinuationContext(serialized: Record<string, WooValue>, observations: Observation[]): CallContext {
    const target = typeof serialized.target === "string" ? serialized.target : "#-1";
    const message: Message = { actor: assertObj(serialized.actor), target, verb: typeof serialized.verb === "string" ? serialized.verb : "$resume", args: [] };
    return this.resumeContext(serialized, message, observations, "#-1", -1);
  }

  private allocateGuest(): ObjRef {
    if (this.guestFreePool.size === 0) this.rebuildGuestPool();
    const pooled = Array.from(this.guestFreePool).sort()[0];
    if (pooled) {
      this.guestFreePool.delete(pooled);
      return pooled;
    }
    const counter = this.objects.size;
    const id = `guest_${counter}`;
    const displayName = `Guest ${counter}`;
    this.createObject({ id, name: displayName, parent: this.objects.has("$guest") ? "$guest" : "$player", owner: "$wiz", location: this.objects.has("$nowhere") ? "$nowhere" : null });
    this.setProp(id, "name", displayName);
    this.setProp(id, "description", "Dynamically allocated guest player. It can be bound to a temporary session and gives a local user or agent a stable actor for first-light testing.");
    // Home defaults already come from the parent chain. Session identity lives
    // in `world.sessions`, so there is no actor-side session_id mirror to seed.
    return id;
  }

  private materializedSpaceState(space: ObjRef): WooValue {
    const ids = Array.from(this.objects.values())
      .filter((obj) => obj.id === space || obj.anchor === space || obj.location === space)
      .map((obj) => obj.id)
      .sort();
    return {
      space,
      seq: Number(this.getProp(space, "next_seq")) - 1,
      objects: Object.fromEntries(ids.map((id) => [id, Object.fromEntries(this.object(id).properties)]))
    };
  }

  private snapshotProps(): Map<ObjRef, Map<string, WooValue>> {
    return new Map(Array.from(this.objects.entries()).map(([id, obj]) => [id, new Map(Array.from(obj.properties.entries()).map(([k, v]) => [k, cloneValue(v)]))]));
  }

  private restoreProps(snapshot: Map<ObjRef, Map<string, WooValue>>): void {
    for (const [id, props] of snapshot) {
      const obj = this.objects.get(id);
      if (obj) obj.properties = new Map(Array.from(props.entries()).map(([k, v]) => [k, cloneValue(v)]));
    }
  }

  private propsChanged(snapshot: Map<ObjRef, Map<string, WooValue>>): boolean {
    for (const [id, props] of snapshot) {
      const obj = this.objects.get(id);
      if (!obj || obj.properties.size !== props.size) return true;
      for (const [name, value] of props) {
        if (!obj.properties.has(name) || !valuesEqual(obj.properties.get(name)!, value)) return true;
      }
    }
    return false;
  }

  private snapshotPlacement(): Map<ObjRef, { location: ObjRef | null; contents: ObjRef[] }> {
    return new Map(Array.from(this.objects.entries()).map(([id, obj]) => [id, { location: obj.location, contents: Array.from(obj.contents).sort() }]));
  }

  private restorePlacement(snapshot: Map<ObjRef, { location: ObjRef | null; contents: ObjRef[] }>): void {
    for (const [id, placement] of snapshot) {
      const obj = this.objects.get(id);
      if (!obj) continue;
      obj.location = placement.location;
      obj.contents = new Set(placement.contents);
    }
  }

  private placementChanged(snapshot: Map<ObjRef, { location: ObjRef | null; contents: ObjRef[] }>): boolean {
    for (const [id, placement] of snapshot) {
      const obj = this.objects.get(id);
      if (!obj || obj.location !== placement.location) return true;
      const contents = Array.from(obj.contents).sort();
      if (contents.length !== placement.contents.length) return true;
      for (let i = 0; i < contents.length; i++) if (contents[i] !== placement.contents[i]) return true;
    }
    return false;
  }

  private withBehaviorSavepoint<T>(fn: () => Promise<T>): Promise<T>;
  private withBehaviorSavepoint<T>(fn: () => T): T;
  private withBehaviorSavepoint<T>(fn: () => T | Promise<T>): T | Promise<T> {
    const savepoint = this.snapshotBehaviorState();
    try {
      const result = fn();
      if (isPromiseLike(result)) {
        return result.catch((err) => {
          if (!isVmSuspendSignal(err) && !isVmReadSignal(err)) this.restoreBehaviorState(savepoint);
          throw err;
        });
      }
      return result;
    } catch (err) {
      if (!isVmSuspendSignal(err) && !isVmReadSignal(err)) this.restoreBehaviorState(savepoint);
      throw err;
    }
  }

  private snapshotBehaviorState(): BehaviorSavepoint {
    return {
      objects: new Map(Array.from(this.objects.entries()).map(([id, obj]) => [id, this.cloneObject(obj)])),
      sessions: new Map(Array.from(this.sessions.entries()).map(([id, session]) => [id, this.cloneSession(session)])),
      snapshots: cloneValue(this.snapshots as unknown as WooValue) as unknown as SpaceSnapshotRecord[],
      parkedTasks: new Map(Array.from(this.parkedTasks.entries()).map(([id, task]) => [id, cloneValue(task as unknown as WooValue) as unknown as ParkedTaskRecord])),
      tombstones: new Set(this.tombstones),
      objectCounter: this.objectCounter,
      parkedTaskCounter: this.parkedTaskCounter,
      sessionCounter: this.sessionCounter,
      guestFreePool: new Set(this.guestFreePool),
      persistence: this.snapshotPersistenceDirtyState()
    };
  }

  private restoreBehaviorState(savepoint: BehaviorSavepoint): void {
    this.objects = new Map(Array.from(savepoint.objects.entries()).map(([id, obj]) => [id, this.cloneObject(obj)]));
    this.sessions = new Map(Array.from(savepoint.sessions.entries()).map(([id, session]) => [id, this.cloneSession(session)]));
    this.snapshots = cloneValue(savepoint.snapshots as unknown as WooValue) as unknown as SpaceSnapshotRecord[];
    this.parkedTasks = new Map(Array.from(savepoint.parkedTasks.entries()).map(([id, task]) => [id, cloneValue(task as unknown as WooValue) as unknown as ParkedTaskRecord]));
    this.tombstones = new Set(savepoint.tombstones);
    this.objectCounter = savepoint.objectCounter;
    this.parkedTaskCounter = savepoint.parkedTaskCounter;
    this.sessionCounter = savepoint.sessionCounter;
    this.guestFreePool = new Set(savepoint.guestFreePool);
    this.restorePersistenceDirtyState(savepoint.persistence);
    // The index mirrors session_subscribers plus compatibility presence
    // properties on objects we just rolled back. Drop it so the next read
    // rebuilds from the restored property values.
    this.invalidatePresenceIndex();
  }

  private cloneObject(obj: WooObject): WooObject {
    return {
      ...obj,
      flags: { ...obj.flags },
      propertyDefs: new Map(Array.from(obj.propertyDefs.entries()).map(([name, def]) => [name, { ...def, defaultValue: cloneValue(def.defaultValue) }])),
      properties: new Map(Array.from(obj.properties.entries()).map(([name, value]) => [name, cloneValue(value)])),
      propertyVersions: new Map(obj.propertyVersions),
      verbs: obj.verbs.map((verb) => cloneValue(verb as unknown as WooValue) as unknown as VerbDef),
      children: new Set(obj.children),
      contents: new Set(obj.contents),
      eventSchemas: new Map(Array.from(obj.eventSchemas.entries()).map(([type, schema]) => [type, cloneValue(schema as unknown as WooValue) as Record<string, WooValue>]))
    };
  }

  private snapshotLogs(): Map<ObjRef, SpaceLogEntry[]> {
    return new Map(Array.from(this.logs.entries()).map(([space, entries]) => [space, cloneValue(entries as unknown as WooValue) as unknown as SpaceLogEntry[]]));
  }

  private cloneSession(session: Session): Session {
    return {
      ...session,
      attachedSockets: new Set(session.attachedSockets)
    };
  }

  private async publicCommandActor(ctx: CallContext, value: WooValue | undefined): Promise<ObjRef> {
    const actor = typeof value === "string" ? value as ObjRef : ctx.actor;
    if (actor !== ctx.actor && !this.isWizard(ctx.actor)) {
      throw wooError("E_PERM", `${ctx.actor} cannot parse commands as ${actor}`, { actor: ctx.actor, requested_actor: actor });
    }
    if (this.objects.has(actor) || await this.remoteHostForObject(actor, ctx.hostMemo)) return actor;
    this.object(actor);
    return actor;
  }

  private async publicCommandLocation(ctx: CallContext, actor: ObjRef, value: WooValue | undefined): Promise<ObjRef | null> {
      const location = typeof value === "string"
        ? value as ObjRef
        : actor === ctx.actor && ctx.session
          ? this.currentLocationForSession(ctx.session)
          : await this.objectLocationChecked(actor, ctx.hostMemo).catch((err) => {
            if (isOptionalProjectionReadError(err)) return null;
            throw err;
          });
    await this.assertPublicCommandLocation(ctx, actor, location);
    return location;
  }

  private async assertPublicCommandLocation(ctx: CallContext, actor: ObjRef, location: ObjRef | null): Promise<void> {
    if (!location || this.isWizard(ctx.actor)) return;
    if (actor !== ctx.actor) {
      throw wooError("E_PERM", `${ctx.actor} cannot parse commands for ${actor}`, { actor: ctx.actor, requested_actor: actor });
    }
    if (location === actor) return;

      const actorLocation = actor === ctx.actor && ctx.session
        ? this.currentLocationForSession(ctx.session)
        : await this.objectLocationChecked(actor, ctx.hostMemo).catch((err) => {
          if (isOptionalProjectionReadError(err)) return null;
          throw err;
        });
    if (actorLocation === location) return;
    try {
      if (this.hasPresence(actor, location)) return;
    } catch {
      // Remote or partial host state falls through to the contents check.
    }
    try {
      if ((await this.objectContents(location, ctx.hostMemo)).includes(actor)) return;
    } catch {
      // Missing or unreadable command locations are rejected below.
    }
    throw wooError("E_PERM", `${actor} is not present in ${location}`, { actor, location });
  }

  private async commandVisibleCandidates(ctx: CallContext, actor: ObjRef, location: ObjRef | null): Promise<ObjRef[]> {
    const candidates: ObjRef[] = [];
    const add = (id: unknown): void => {
      if (typeof id === "string" && !candidates.includes(id)) candidates.push(id);
    };
    add(actor);
    if (location) {
      add(location);
      for (const id of await this.objectContents(location, ctx.hostMemo).catch((err) => {
        if (isReadAvailabilityError(err)) return [];
        throw err;
      })) add(id);
      const present = await this.propOrNullForActorAsync(actor, location, "subscribers", ctx.hostMemo);
      if (Array.isArray(present)) for (const id of present) add(id);
    }
    for (const id of await this.objectContents(actor, ctx.hostMemo).catch((err) => {
      if (isReadAvailabilityError(err)) return [];
      throw err;
    })) add(id);
    return candidates;
  }

  private async canSeeCommandObject(ctx: CallContext, target: ObjRef): Promise<boolean> {
    if (this.isWizard(ctx.actor)) return true;
    const location = await this.publicCommandLocation(ctx, ctx.actor, undefined);
    if ((await this.commandVisibleCandidates(ctx, ctx.actor, location)).includes(target)) return true;
    const caller = ctx.caller;
    if (typeof caller === "string" && caller.length > 0 && this.objects.has(caller) && this.inheritsFrom(caller, "$space")) {
      const callerContents = await this.objectContents(caller, ctx.hostMemo).catch((err): ObjRef[] => {
        if (isReadAvailabilityError(err)) return [];
        throw err;
      });
      if (callerContents.includes(target)) return true;
      const targetLocation = await this.propOrNullForActorAsync(ctx.actor, target, "location", ctx.hostMemo);
      if (targetLocation === caller) return true;
    }
    return false;
  }

  private registerNativeHandlers(): void {
    this.nativeHandlers.set("describe", (ctx) => this.describeForActor(ctx.thisObj, ctx.actor));
    this.nativeHandlers.set("default_title", (ctx) => {
      const title = this.propOrNull(ctx.thisObj, "name");
      return typeof title === "string" && title.length > 0 ? title : this.object(ctx.thisObj).name;
    });
    this.nativeHandlers.set("default_look_self", (ctx) => this.defaultLookSelf(ctx));
    this.nativeHandlers.set("player_on_disfunc", () => true);
    this.nativeHandlers.set("player_moveto", async (ctx, args) => {
      if (ctx.thisObj !== ctx.actor && !this.isWizard(ctx.actor)) throw wooError("E_PERM", "players may only move themselves", { actor: ctx.actor, target: ctx.thisObj });
      const target = assertObj(args[0] ?? "$nowhere");
      return await this.movetoChecked(ctx, ctx.thisObj, target);
    });
    this.nativeHandlers.set("player_tell", (ctx, args) => {
      this.tellPlayer(ctx, ctx.thisObj, args);
      return true;
    });
    this.nativeHandlers.set("player_tell_lines", (ctx, args) => {
      const lines = Array.isArray(args[0]) ? args[0] : args;
      for (const line of lines) this.tellPlayer(ctx, ctx.thisObj, [line]);
      return true;
    });
    this.nativeHandlers.set("player_help", (ctx, args) => this.playerHelp(ctx, args));
    this.nativeHandlers.set("player_who", (ctx, args) => this.playerWho(ctx, args));
    this.nativeHandlers.set("player_join", (ctx, args) => this.playerJoin(ctx, args));
    this.nativeHandlers.set("player_examine", (ctx, args) => this.playerExamine(ctx, args));
    this.nativeHandlers.set("guest_on_disfunc", async (ctx) => {
      const homeValue = this.propOrNull(ctx.thisObj, "home");
      const home = typeof homeValue === "string" && this.objects.has(homeValue) ? homeValue : "$nowhere";
      const fallback = this.guestInventoryFallback(ctx.thisObj, home);
      const carried = await this.objectContents(ctx.thisObj, ctx.hostMemo);
      for (const item of carried) {
        if (!this.objects.has(item) && !await this.remoteHostForObject(item, ctx.hostMemo)) {
          this.object(ctx.thisObj).contents.delete(item);
          continue;
        }
        await this.moveObjectChecked(item, this.inventoryEjectTarget(item, fallback));
      }
      await this.moveObjectChecked(ctx.thisObj, home);
      this.setProp(ctx.thisObj, "description", "");
      this.setProp(ctx.thisObj, "aliases", []);
      this.setProp(ctx.thisObj, "features", []);
      this.setProp(ctx.thisObj, "features_version", Number(this.propOrNull(ctx.thisObj, "features_version") ?? 0) + 1);
      this.returnGuest(ctx.thisObj);
      return true;
    });
    this.nativeHandlers.set("return_guest", (ctx, args) => {
      if (!this.isWizard(ctx.actor)) throw wooError("E_PERM", "only wizards may return guests", ctx.actor);
      this.returnGuest(assertObj(args[0]));
      return true;
    });
    this.nativeHandlers.set("set_object_flags", (ctx, args) => {
      const target = assertObj(args[0]);
      const flags = args[1];
      if (!flags || typeof flags !== "object" || Array.isArray(flags)) throw wooError("E_TYPE", "set_object_flags requires a flags map", { value: flags as WooValue });
      return this.setObjectFlags(ctx.actor, target, flags as Record<string, unknown>) as unknown as WooValue;
    });
    this.nativeHandlers.set("mint_session_for", (ctx, args) => {
      if (!this.isWizard(ctx.actor)) throw wooError("E_PERM", "wizard authority required to mint sessions", ctx.actor);
      const target = assertObj(args[0]);
      this.object(target);
      if (!this.inheritsFrom(target, "$actor")) throw wooError("E_TYPE", `target must be an $actor descendant: ${target}`, target);
      const session = this.createSessionForActor(target, "bearer");
      this.recordWizardAction(ctx.actor, "mint_session_for", { actor: target, session: session.id });
      return { id: session.id, actor: session.actor, expires_at: session.expiresAt, token_class: session.tokenClass } as unknown as WooValue;
    });
    this.nativeHandlers.set("create_api_key", (ctx, args) => {
      const target = assertObj(args[0]);
      const label = typeof args[1] === "string" ? args[1] : null;
      const result = this.createApiKey(ctx.actor, target, label);
      return result as unknown as WooValue;
    });
    this.nativeHandlers.set("create_api_key_for_owner", (ctx, args) => {
      const target = assertObj(args[0]);
      const label = typeof args[1] === "string" ? args[1] : null;
      const result = this.createApiKeyForOwner(ctx.actor, target, label);
      return result as unknown as WooValue;
    });
    this.nativeHandlers.set("revoke_api_key", (ctx, args) => {
      const id = String(args[0] ?? "");
      if (!id) throw wooError("E_INVARG", "revoke_api_key requires an id");
      const result = this.revokeApiKeyWithClosedSessions(ctx.actor, id);
      if (result.closedSessions.length > 0) return Promise.resolve(ctx.onSessionsEnded?.(result.closedSessions)).then(() => result.revoked);
      return result.revoked;
    });
    this.nativeHandlers.set("list_api_keys", (ctx) => {
      return this.listApiKeys(ctx.actor) as unknown as WooValue;
    });
    this.nativeHandlers.set("list_api_keys_for_owner", (ctx) => {
      return this.listApiKeysForOwner(ctx.actor) as unknown as WooValue;
    });
    this.nativeHandlers.set("feature_can_be_attached_by", (ctx, args) => {
      const actor = assertObj(args[0] ?? ctx.actor);
      return actor === this.object(ctx.thisObj).owner;
    });
    this.nativeHandlers.set("thing_moveto", async (ctx, args) => {
      const target = assertObj(args[0] ?? "$nowhere");
      return await this.movetoChecked(ctx, ctx.thisObj, target);
    });
    this.nativeHandlers.set("thing_look", async (ctx) => {
      return await this.dispatch({ ...ctx, caller: ctx.thisObj }, ctx.thisObj, "look_self", []);
    });
    this.nativeHandlers.set("add_feature", (ctx, args) => this.addFeature(ctx.thisObj, assertObj(args[0]), ctx.actor, ctx.observations));
    this.nativeHandlers.set("remove_feature", (ctx, args) => this.removeFeature(ctx.thisObj, assertObj(args[0]), ctx.actor, ctx.observations));
    this.nativeHandlers.set("has_feature", (ctx, args) => this.featureList(ctx.thisObj).includes(assertObj(args[0])));
    this.nativeHandlers.set("replay", (ctx, args) => {
      const from = Number(args[0] ?? 1);
      const limit = Number(args[1] ?? 100);
      return this.replay(ctx.thisObj, from, limit).map((entry) => ({
        seq: entry.seq,
        message: entry.message as unknown as WooValue,
        observations: entry.observations as unknown as WooValue,
        applied_ok: entry.applied_ok,
        error: entry.error as unknown as WooValue
      }));
    });
    this.nativeHandlers.set("catalog_registry_install", (ctx, args) => {
      if (!this.object(ctx.actor).flags.wizard) throw wooError("E_PERM", "only wizards may install catalogs", ctx.actor);
      const manifest = assertMap(args[0]) as unknown as CatalogManifest;
      const alias = typeof args[2] === "string" ? args[2] : manifest.name;
      const provenance = args[3] && typeof args[3] === "object" && !Array.isArray(args[3]) ? (args[3] as Record<string, WooValue>) : {};
      return installCatalogManifest(this, manifest, {
        actor: ctx.actor,
        tap: typeof provenance.tap === "string" ? provenance.tap : "@local",
        alias,
        provenance
      }) as unknown as WooValue;
    });
    this.nativeHandlers.set("catalog_registry_update", (ctx, args) => {
      if (!this.object(ctx.actor).flags.wizard) throw wooError("E_PERM", "only wizards may update catalogs", ctx.actor);
      const manifest = assertMap(args[0]) as unknown as CatalogManifest;
      const alias = typeof args[2] === "string" ? args[2] : manifest.name;
      const provenance = args[3] && typeof args[3] === "object" && !Array.isArray(args[3]) ? (args[3] as Record<string, WooValue>) : {};
      const options = args[4] && typeof args[4] === "object" && !Array.isArray(args[4]) ? (args[4] as Record<string, WooValue>) : {};
      const migration = args[5] && typeof args[5] === "object" && !Array.isArray(args[5]) ? (args[5] as unknown as CatalogMigrationManifest) : null;
      return updateCatalogManifest(this, manifest, {
        actor: ctx.actor,
        tap: typeof provenance.tap === "string" ? provenance.tap : "@local",
        alias,
        provenance,
        acceptMajor: options.accept_major === true,
        migration
      }) as unknown as WooValue;
    });
    this.nativeHandlers.set("catalog_registry_list", () => this.propOrNull("$catalog_registry", "installed_catalogs"));
    this.nativeHandlers.set("catalog_registry_migration_state", (_ctx, args) => {
      const alias = assertString(args[0] ?? "");
      const records = this.propOrNull("$catalog_registry", "installed_catalogs");
      if (!Array.isArray(records)) return null;
      const record = records.find((item) => item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, WooValue>).alias === alias);
      return record && typeof record === "object" && !Array.isArray(record) ? ((record as Record<string, WooValue>).migration_state ?? null) : null;
    });
    this.nativeHandlers.set("match_object", async (ctx, args) => {
      const actor = await this.publicCommandActor(ctx, undefined);
      const location = await this.publicCommandLocation(ctx, actor, args[1]);
      const match = await this.matchObjectForActorAsync(assertString(args[0] ?? ""), ctx, location, actor);
      return match.value;
    });
    this.nativeHandlers.set("match_verb", async (ctx, args) => {
      const name = assertString(args[0] ?? "");
      const target = assertObj(args[1]);
      if (!await this.canSeeCommandObject(ctx, target)) throw wooError("E_PERM", `${ctx.actor} cannot match verbs on ${target}`, { actor: ctx.actor, target });
      try {
        if (await this.remoteHostForObject(target, ctx.hostMemo)) {
          const resolved = await this.tryResolveVerbForCommand(ctx, target, name);
          return resolved ? { name: resolved.name, definer: null, direct_callable: resolved.direct_callable, arg_spec: resolved.arg_spec ?? {} } : (this.objects.has("$failed_match") ? "$failed_match" : null);
        }
        const { definer, verb } = this.resolveVerb(target, name);
        return { name: verb.name, definer, direct_callable: verb.direct_callable === true, arg_spec: verb.arg_spec ?? {} };
      } catch (err) {
        const error = normalizeError(err);
        if (error.code !== "E_VERBNF" && !isReadAvailabilityError(error)) throw err;
        return this.objects.has("$failed_match") ? "$failed_match" : null;
      }
    });
    this.nativeHandlers.set("match_command_verb", async (ctx, args) => {
      const cmd = commandMapFromValue(args[0]);
      const target = assertObj(args[1]);
      if (!await this.canSeeCommandObject(ctx, target)) throw wooError("E_PERM", `${ctx.actor} cannot match command verbs on ${target}`, { actor: ctx.actor, target });
      const matched = await this.matchCommandVerbOnTarget(ctx, cmd, target);
      return matched ? matched as unknown as WooValue : (this.objects.has("$failed_match") ? "$failed_match" : null);
    });
    this.nativeHandlers.set("plan_command", async (ctx, args) => {
      const space = assertObj(args[1] ?? ctx.caller);
      return await this.planCommandForSpace(ctx, assertString(args[0] ?? ""), space) as unknown as WooValue;
    });
    this.nativeHandlers.set("parse_command", async (ctx, args) => {
      const actor = await this.publicCommandActor(ctx, args[1]);
      const location = await this.publicCommandLocation(ctx, actor, args[2]);
      return await this.parseCommandMap(assertString(args[0] ?? ""), ctx, location, actor) as unknown as WooValue;
    });
    this.nativeHandlers.set("room_look_self", (ctx) => this.spaceLookSelf(ctx));
    this.nativeHandlers.set("space_look_self", (ctx) => this.spaceLookSelf(ctx));
    this.nativeHandlers.set("room_who", (ctx) => this.roomWho(ctx));
    this.nativeHandlers.set("help_db_find_topics", (ctx, args) => this.helpDbFindTopics(ctx, args));
    this.nativeHandlers.set("help_db_get_topic", (ctx, args) => this.helpDbGetTopic(ctx, args));
    this.nativeHandlers.set("help_db_dump_topic", (ctx, args) => this.helpDbDumpTopic(ctx, args));
    this.nativeHandlers.set("help_db_record_miss", (ctx, args) => this.helpDbRecordMiss(ctx, args));
  }

  private chatPresent(room: ObjRef): ObjRef[] {
    const present = this.getProp(room, "subscribers");
    return Array.isArray(present) ? present.filter((item): item is ObjRef => typeof item === "string") : [];
  }

  private async chatPresentAsync(room: ObjRef, progr: ObjRef): Promise<ObjRef[]> {
    const present = await this.propOrNullForActorAsync(progr, room, "subscribers");
    const subscribers = Array.isArray(present) ? present.filter((item): item is ObjRef => typeof item === "string") : [];
    return await this.scrubStaleSubscribersForSpace(room, progr, subscribers);
  }

  private async scrubStaleSubscribersForSpace(space: ObjRef, progr: ObjRef, subscribers: ObjRef[], memo?: HostOperationMemo): Promise<ObjRef[]> {
    void progr;
    if (!this.objects.has(space)) return subscribers;
    const now = Date.now();
    const last = this.lastSubscriberScrubAt.get(space) ?? 0;
    if (now - last < SUBSCRIBER_SCRUB_FLOOR_MS) return subscribers;
    this.lastSubscriberScrubAt.set(space, now);
    let survivingActors = subscribers;
    if (subscribers.length > 0) {
      const remoteActorsSet = new Set<ObjRef>();
      for (const actor of subscribers) {
        if (await this.remoteHostForObject(actor, memo)) remoteActorsSet.add(actor);
      }
      const remoteLocationsByActor = await this.fetchRemoteSessionLocations(
        Array.from(remoteActorsSet),
        memo
      );
      const kept: ObjRef[] = [];
      const stale: ObjRef[] = [];
      for (const actor of subscribers) {
        // A remote actor whose home host failed to answer (read-availability
        // error) is left in `subscribers` and excluded from this read's
        // survivingActors view, mirroring the per-actor path's behavior
        // under the same error class. Without this guard a transient remote
        // blip would mark the actor stale and persist a subscriber-row drop.
        if (remoteActorsSet.has(actor) && !remoteLocationsByActor.has(actor)) continue;
        const localLocations = this.allLocationsForActor(actor);
        const remoteLocations = remoteLocationsByActor.get(actor) ?? [];
        const locations = remoteActorsSet.has(actor)
          ? Array.from(new Set([...localLocations, ...remoteLocations]))
          : localLocations;
        if (locations.includes(space)) kept.push(actor);
        else stale.push(actor);
      }
      for (const actor of stale) this.updateSpaceSubscriberLocal(space, actor, false);
      const keptSet = new Set(kept);
      survivingActors = subscribers.filter((actor) => keptSet.has(actor));
    }
    // Sibling scrub: drop session_subscribers rows whose session has been
    // reaped on this DO but whose row was never cleaned up because
    // `removeSessionPresence` walks only the local object map and has no
    // way to learn that a different DO recently expired a session it shares.
    // Runs even for empty `subscribers` because session_subscribers can
    // accumulate independently and an emptied room is exactly when stale
    // session rows pile up. The returned `survivingActors` reflects the
    // actor scrub only; the persisted `subscribers` property may be
    // further trimmed by the session pass — by design, the two views
    // converge under the property-change hook in setPropLocal which
    // reinvalidates the presence index.
    this.scrubExpiredSessionSubscribersForSpace(space);
    return survivingActors;
  }

  /**
   * Resolve `currentLocation` for each actor whose home host is not this DO,
   * preferring a batched cross-host call so a room with N remote subscribers
   * costs one RPC per host instead of N. Falls back to per-actor lookup for
   * bridges that don't implement the batch method (older deployments and
   * in-memory test bridges). Read-availability errors are swallowed so a
   * cold or slow remote host doesn't hold the local single-threaded queue —
   * actors whose locations are unknown stay in `subscribers` until the next
   * scrub window. */
  private async fetchRemoteSessionLocations(
    remoteActors: ObjRef[],
    memo?: HostOperationMemo
  ): Promise<Map<ObjRef, ObjRef[]>> {
    const out = new Map<ObjRef, ObjRef[]>();
    if (remoteActors.length === 0 || !this.hostBridge) return out;
    if (this.hostBridge.actorSessionLocationsBatch) {
      try {
        return await this.hostBridge.actorSessionLocationsBatch(remoteActors, memo);
      } catch (err) {
        if (!isReadAvailabilityError(err)) throw err;
        return out;
      }
    }
    await Promise.all(remoteActors.map(async (actor) => {
      try {
        const locations = await this.hostBridge?.actorSessionLocations?.(actor, memo) ?? [];
        out.set(actor, locations);
      } catch (err) {
        if (!isReadAvailabilityError(err)) throw err;
      }
    }));
    return out;
  }

  /**
   * Drop entries in `<space>.session_subscribers` whose session is present
   * in this DO's session table AND already expired. Recomputes the
   * actor-level `subscribers` mirror from the surviving rows so both views
   * stay consistent.
   *
   * Intentionally narrow: rows whose session is missing from `this.sessions`
   * may legitimately belong to a different DO that hasn't synced the session
   * here yet, so dropping them would race cross-host setup. The actor-level
   * scrub already handles dropping subscribers whose remote-host
   * actorSessionLocations no longer reports this space; the broadcast layer
   * (broadcastLiveEvent) handles the data-pollution case where rows remain
   * but don't resolve to live sockets. TODO(cross-host-session-gc): have the
   * gateway's session-end signal propagate to peer DOs (or have the
   * Directory participate) so cross-host pollution can be cleaned at source
   * instead of bandaged at broadcast time.
   *
   * `legacy:<actor>` placeholder entries are kept regardless: they are
   * synthesized by `updateSpaceSubscriberLocal` for bridge-era hosts that
   * have no per-session attribution.
   *
   * Throttling is the wrapper's job (`scrubStaleSubscribersForSpace` gates
   * both passes under a single per-space window). This helper is unguarded
   * by design — keep it that way and add a guard here if a second caller
   * appears.
   */
  private scrubExpiredSessionSubscribersForSpace(space: ObjRef): void {
    if (!this.objects.has(space)) return;
    const raw = this.propOrNull(space, "session_subscribers");
    if (!Array.isArray(raw) || raw.length === 0) return;
    const now = Date.now();
    let changed = false;
    const out: WooValue[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        changed = true;
        continue;
      }
      const map = entry as Record<string, WooValue>;
      const sessionId = typeof map.session === "string" ? map.session : "";
      const actor: ObjRef | "" = typeof map.actor === "string" ? map.actor : "";
      if (!sessionId || !actor) {
        changed = true;
        continue;
      }
      if (sessionId.startsWith("legacy:")) {
        out.push(entry);
        continue;
      }
      const session = this.sessions.get(sessionId);
      if (session && this.sessionExpired(session, now)) {
        changed = true;
        continue;
      }
      out.push(entry);
    }
    if (!changed) return;
    const nextActors = Array.from(new Set(out
      .map((entry) => (entry as Record<string, WooValue>).actor)
      .filter((actor): actor is ObjRef => typeof actor === "string")
    )).sort();
    // setProp invalidates the presence index via setPropLocal's
    // subscribers/session_subscribers hook; no explicit invalidation needed.
    this.withPersistenceDeferred(() => {
      this.setProp(space, "session_subscribers", out as unknown as WooValue);
      this.setProp(space, "subscribers", nextActors as unknown as WooValue);
    });
  }

  private async defaultLookSelf(ctx: CallContext): Promise<WooValue> {
    const title = await this.titleForLook(ctx, ctx.caller, ctx.thisObj);
    const description = this.propOrNullForActor(ctx.actor, ctx.thisObj, "description");
    return {
      id: ctx.thisObj,
      title,
      description
    } as unknown as WooValue;
  }

  private async spaceLookSelf(ctx: CallContext): Promise<WooValue> {
    const room = ctx.thisObj;
    const look = await this.composeRoomLook(ctx, room);
    return look as unknown as WooValue;
  }

  private async composeRoomLook(ctx: CallContext, room: ObjRef): Promise<Record<string, WooValue>> {
    const startedAt = Date.now();
    const present = await this.chatPresentAsync(room, ctx.progr);
    const items = (await this.objectContents(room, ctx.hostMemo)).filter((item) => !this.isActorForLook(item, present));
    const remoteSummaries = await this.objectSummariesForLook(ctx, items);
    const contents = await Promise.all(items.map(async (item) => {
      return await this.lookEntryFor(ctx, room, item, remoteSummaries.summaries.get(item) ?? null);
    }));
    const look = {
      id: room,
      title: await this.titleForLook(ctx, ctx.caller, room),
      description: this.propOrNullForActor(ctx.actor, room, "description"),
      present_actors: present,
      contents
    } as unknown as Record<string, WooValue>;
    this.recordMetric({
      kind: "compose_look",
      room,
      present_count: present.length,
      contents_count: items.length,
      remote_titles: remoteSummaries.remoteCount,
      remote_describe_batches: remoteSummaries.batchCount,
      ms: Date.now() - startedAt
    });
    return look;
  }

  private async objectContents(objRef: ObjRef, memo?: HostOperationMemo): Promise<ObjRef[]> {
    if (await this.remoteHostForObject(objRef, memo)) {
      if (!this.hostBridge) throw wooError("E_INTERNAL", "remote host bridge unavailable");
      return await this.hostBridge.contents(objRef, memo);
    }
    return Array.from(this.object(objRef).contents);
  }

  private isActorForLook(item: ObjRef, present: ObjRef[]): boolean {
    if (present.includes(item)) return true;
    return this.objects.has(item) && this.inheritsFrom(item, "$player");
  }

  private async propOrNullForActorAsync(actor: ObjRef, objRef: ObjRef, name: string, memo?: HostOperationMemo): Promise<WooValue> {
    try {
      return await this.getPropChecked(actor, objRef, name, memo);
    } catch (err) {
      if (!isOptionalProjectionReadError(err)) throw err;
      return null;
    }
  }

  private async lookEntryFor(ctx: CallContext, room: ObjRef, item: ObjRef, prefetchedSummary: HostObjectSummary | null = null): Promise<Record<string, WooValue>> {
    const summary = prefetchedSummary ?? await this.objectSummaryForLook(ctx, item);
    if (summary) {
      return {
        id: item,
        title: titleFromSummary(item, summary),
        description: summary.description
      };
    }
    return {
      id: item,
      title: await this.titleForLook(ctx, room, item),
      description: await this.propOrNullForActorAsync(ctx.actor, item, "description", ctx.hostMemo)
    };
  }

  private async objectSummaryForLook(ctx: CallContext, item: ObjRef): Promise<HostObjectSummary | null> {
    if (!await this.remoteHostForObject(item, ctx.hostMemo)) return null;
    if (!this.hostBridge?.describeObject) return null;
    try {
      return await this.hostBridge.describeObject(ctx.progr, ctx.actor, item, ctx.hostMemo);
    } catch (err) {
      if (!isReadAvailabilityError(err)) throw err;
      return null;
    }
  }

  private async objectSummariesForLook(ctx: CallContext, items: ObjRef[]): Promise<{ summaries: Map<ObjRef, HostObjectSummary>; remoteCount: number; batchCount: number }> {
    const summaries = new Map<ObjRef, HostObjectSummary>();
    const remoteIds: ObjRef[] = [];
    const remoteHosts = new Set<string>();
    for (const item of items) {
      const host = await this.remoteHostForObject(item, ctx.hostMemo);
      if (!host) continue;
      remoteIds.push(item);
      remoteHosts.add(host);
    }
    if (remoteIds.length === 0 || !this.hostBridge) return { summaries, remoteCount: 0, batchCount: 0 };
    if (this.hostBridge.describeObjects) {
      try {
        const batch = await this.hostBridge.describeObjects(ctx.progr, ctx.actor, remoteIds, ctx.hostMemo);
        for (const id of remoteIds) {
          const summary = batch[id];
          if (summary) summaries.set(id, summary);
        }
        return { summaries, remoteCount: remoteIds.length, batchCount: remoteHosts.size };
      } catch (err) {
        if (!isReadAvailabilityError(err)) throw err;
        summaries.clear();
      }
    }
    await Promise.all(remoteIds.map(async (id) => {
      const summary = await this.objectSummaryForLook(ctx, id);
      if (summary) summaries.set(id, summary);
    }));
    return { summaries, remoteCount: remoteIds.length, batchCount: remoteIds.length };
  }

  private async roomWho(ctx: CallContext): Promise<WooValue> {
    const present = this.chatPresent(ctx.thisObj);
    const presentNames = (await this.collectPropChecked(ctx.progr, present, "name", ctx.hostMemo)).map((name) => valueToText(name));
    ctx.observe({
      type: "who",
      source: ctx.thisObj,
      actor: ctx.actor,
      to: ctx.actor,
      room: ctx.thisObj,
      present_actors: present,
      text: `Present: ${presentNames.join(", ") || "nobody"}.`,
      ts: Date.now()
    });
    return present;
  }

  private async playerWho(ctx: CallContext, args: WooValue[]): Promise<WooValue> {
    const requested = valueToText(args[0] ?? null).trim();
    const players = requested
      ? this.playerNameTokens(requested).map((name) => this.matchPlayerForCommand(name))
      : this.connectedPlayers();
    const missing = requested ? players.find((item) => !item) : null;
    if (missing === null && requested) {
      this.tellPlayer(ctx, ctx.actor, ["I don't recognize one of those players."]);
      return [] as unknown as WooValue;
    }
    const unique = Array.from(new Set(players.filter((item): item is ObjRef => typeof item === "string")));
    if (unique.length === 0) return [] as unknown as WooValue;
    if (unique.length > 100) {
      this.tellPlayer(ctx, ctx.actor, [
        "You have requested a listing of ",
        unique.length,
        " players. Please specify fewer players or use a broader user listing."
      ]);
      return [] as unknown as WooValue;
    }

    const rows = await Promise.all(unique.map(async (player) => {
      const location = this.objects.has(player) ? this.object(player).location : null;
      const locationName = location && this.objects.has(location) ? await this.objectDisplayNameAsync(ctx.progr, location, ctx.hostMemo) : "Nowhere";
      const stats = this.playerSessionStats(player);
      return {
        player,
        name: await this.objectDisplayNameAsync(ctx.progr, player, ctx.hostMemo),
        connected: stats.connected,
        connected_at: stats.connectedAt,
        connected_seconds: stats.connectedSeconds,
        idle_seconds: stats.idleSeconds,
        last_login_at: stats.lastLoginAt,
        location,
        location_name: locationName
      };
    }));

    const lines = ["Player                 Conn      Idle   Location"];
    for (const row of rows) {
      const idle = row.connected
        ? row.idle_seconds === null || row.idle_seconds < 60
          ? "active"
          : this.formatWhoDuration(row.idle_seconds)
        : "sleep";
      const connection = row.connected
        ? this.formatWhoDuration(row.connected_seconds)
        : this.formatWhoLastLogin(row.last_login_at);
      lines.push(`${row.name.padEnd(22).slice(0, 22)} ${connection.padEnd(9).slice(0, 9)} ${idle.padEnd(6).slice(0, 6)} ${row.location_name}`);
    }
    for (const line of lines) this.tellPlayer(ctx, ctx.actor, [line]);
    ctx.observe({
      type: "who",
      source: ctx.thisObj,
      actor: ctx.actor,
      to: ctx.actor,
      room: this.objects.get(ctx.actor)?.location ?? null,
      present_actors: unique,
      text: lines.join("\n"),
      ts: Date.now()
    });
    return rows as unknown as WooValue;
  }

  private async playerJoin(ctx: CallContext, args: WooValue[]): Promise<WooValue> {
    if (ctx.thisObj !== ctx.actor && !this.isWizard(ctx.actor)) throw wooError("E_PERM", "players may only @join themselves", { actor: ctx.actor, target: ctx.thisObj });
    const name = valueToText(args[0]).trim();
    if (!name) {
      this.tellPlayer(ctx, ctx.actor, ["Usage: @join <player>."]);
      return null;
    }
    const target = this.matchPlayerForCommand(name);
    if (!target) {
      this.tellPlayer(ctx, ctx.actor, ["I don't recognize that player."]);
      return null;
    }
    if (target === ctx.actor) {
      this.tellPlayer(ctx, ctx.actor, ["There is little need to join yourself, unless you are split up."]);
      return null;
    }
    const dest = this.objects.get(target)?.location ?? null;
    if (!dest || dest === "$nowhere" || !this.objects.has(dest)) {
      this.tellPlayer(ctx, ctx.actor, [await this.objectDisplayNameAsync(ctx.progr, target, ctx.hostMemo), " is nowhere."]);
      return null;
    }
    const old = this.objects.get(ctx.actor)?.location ?? null;
    if (old === dest) {
      this.tellPlayer(ctx, ctx.actor, ["OK, you're there. You didn't need to actually move, though."]);
      return { room: dest, from: old, here_request: true, look_deferred: true } as unknown as WooValue;
    }
    this.tellPlayer(ctx, ctx.actor, ["You visit ", await this.objectDisplayNameAsync(ctx.progr, target, ctx.hostMemo), "."]);
    await this.movetoChecked(ctx, ctx.actor, dest);
    const landed = this.objects.get(ctx.actor)?.location ?? null;
    if (landed !== dest) {
      this.tellPlayer(ctx, ctx.actor, ["Either that place doesn't want you, or you don't really want to go."]);
      return null;
    }
    if (old && old !== dest && old !== "$nowhere") {
      ctx.observe({ type: "left", source: old, actor: ctx.actor, room: old, destination: dest, text: `${this.object(ctx.actor).name} leaves.`, ts: Date.now() });
    }
    ctx.observe({ type: "entered", source: dest, actor: ctx.actor, room: dest, origin: old, text: `${this.object(ctx.actor).name} arrives.`, ts: Date.now() });
    return { room: dest, from: old, target, here_request: true, look_deferred: true } as unknown as WooValue;
  }

  private async playerExamine(ctx: CallContext, args: WooValue[]): Promise<WooValue> {
    const name = valueToText(args[0]).trim();
    if (!name) {
      this.tellPlayer(ctx, ctx.actor, ["Usage: @examine <object>"]);
      return null;
    }
    const location = this.objects.get(ctx.actor)?.location ?? null;
    const match = await this.matchObjectForActorAsync(name, ctx, location, ctx.actor);
    if (match.status === "ambiguous") {
      this.tellPlayer(ctx, ctx.actor, ["I don't know which ", name, " you mean."]);
      return null;
    }
    if (match.status !== "ok") {
      this.tellPlayer(ctx, ctx.actor, ["I don't see ", name, " here."]);
      return null;
    }
    const target = match.value;
    if (await this.remoteHostForObject(target, ctx.hostMemo)) return await this.playerExamineRemote(ctx, target, name);
    const obj = this.object(target);
    const owner = obj.owner;
    const aliasesValue = this.propOrNullForActor(ctx.actor, target, "aliases");
    const aliases = Array.isArray(aliasesValue) ? aliasesValue.filter((item): item is string => typeof item === "string") : [];
    const descriptionValue = this.propOrNullForActor(ctx.actor, target, "description");
    const description = typeof descriptionValue === "string" && descriptionValue.length > 0 ? descriptionValue : "(No description set.)";
    const contents = await this.objectContents(target, ctx.hostMemo).catch(() => [] as ObjRef[]);
    const contentRows = await Promise.all(contents.map(async (item) => ({
      id: item,
      name: await this.objectDisplayNameAsync(ctx.progr, item, ctx.hostMemo)
    })));
    const obviousVerbs = this.obviousCommandSyntaxes(target, name);
    const ownerName = this.objects.has(owner) ? await this.objectDisplayNameAsync(ctx.progr, owner, ctx.hostMemo) : "a recycled player";
    const lines = [
      `${obj.name} (${target}) is owned by ${ownerName} (${owner}).`,
      `Aliases: ${aliases.length > 0 ? aliases.join(", ") : "none"}.`,
      description
    ];
    if (contentRows.length > 0) {
      lines.push("Contents:");
      for (const item of contentRows) lines.push(`  ${item.name} (${item.id})`);
    }
    if (obviousVerbs.length > 0) {
      lines.push("Obvious verbs:");
      lines.push(...obviousVerbs);
    }
    for (const line of lines) this.tellPlayer(ctx, ctx.actor, [line]);
    return {
      target,
      owner,
      aliases,
      description,
      contents: contentRows,
      obvious_verbs: obviousVerbs,
      text: lines.join("\n")
    } as unknown as WooValue;
  }

  private connectedPlayers(): ObjRef[] {
    const seen = new Set<ObjRef>();
    for (const session of this.sessions.values()) {
      if (!this.actorIsConnected(session.actor)) continue;
      if (!this.objects.has(session.actor) || !this.inheritsFrom(session.actor, "$player")) continue;
      seen.add(session.actor);
    }
    return Array.from(seen).sort((left, right) => {
      const leftName = this.object(left).name || left;
      const rightName = this.object(right).name || right;
      return leftName.localeCompare(rightName) || left.localeCompare(right);
    });
  }

  private playerSessionStats(actor: ObjRef): { connected: boolean; connectedAt: number | null; connectedSeconds: number | null; idleSeconds: number | null; lastLoginAt: number | null } {
    const now = Date.now();
    const liveCutoff = now - IDLE_PRESENCE_LIVE_WINDOW_MS;
    let connectedAt: number | null = null;
    let lastInputAt: number | null = null;
    let lastLoginAt: number | null = null;
    for (const session of this.sessions.values()) {
      if (session.actor !== actor) continue;
      if (lastLoginAt === null || session.started > lastLoginAt) lastLoginAt = session.started;
      if (lastInputAt === null || session.lastInputAt > lastInputAt) lastInputAt = session.lastInputAt;
      const live = session.attachedSockets.size > 0 || session.lastInputAt >= liveCutoff;
      if (live && (connectedAt === null || session.started < connectedAt)) connectedAt = session.started;
    }
    return {
      connected: connectedAt !== null,
      connectedAt,
      connectedSeconds: connectedAt === null ? null : Math.max(0, Math.floor((now - connectedAt) / 1000)),
      idleSeconds: connectedAt === null || lastInputAt === null ? null : Math.max(0, Math.floor((now - lastInputAt) / 1000)),
      lastLoginAt
    };
  }

  private formatWhoDuration(seconds: number | null): string {
    if (seconds === null) return "-";
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }

  private formatWhoLastLogin(at: number | null): string {
    if (at === null) return "unknown";
    return new Date(at).toISOString().slice(0, 10);
  }

  private async playerExamineRemote(ctx: CallContext, target: ObjRef, matchedName: string): Promise<WooValue> {
    const summary = await this.hostBridge?.describeObject?.(ctx.progr, ctx.actor, target, ctx.hostMemo).catch((err) => {
      if (isReadAvailabilityError(err)) return null;
      throw err;
    }) ?? null;
    const name = typeof summary?.name === "string" && summary.name.length > 0 ? summary.name : target;
    const owner = typeof summary?.owner === "string" ? summary.owner : null;
    const aliases = Array.isArray(summary?.aliases) ? summary.aliases.filter((item): item is string => typeof item === "string") : [];
    const description = typeof summary?.description === "string" && summary.description.length > 0 ? summary.description : "(No description set.)";
    const obviousVerbs = Array.isArray(summary?.obvious_verbs)
      ? summary.obvious_verbs.filter((item): item is string => typeof item === "string")
      : [];
    const contents = await this.objectContents(target, ctx.hostMemo).catch((err) => {
      if (isReadAvailabilityError(err)) return [] as ObjRef[];
      throw err;
    });
    const contentRows = await Promise.all(contents.map(async (item) => ({
      id: item,
      name: await this.objectDisplayNameAsync(ctx.progr, item, ctx.hostMemo)
    })));
    const ownerName = owner && this.objects.has(owner) ? await this.objectDisplayNameAsync(ctx.progr, owner, ctx.hostMemo) : null;
    const lines = [
      owner ? `${name} (${target}) is owned by ${ownerName ?? owner} (${owner}).` : `${name} (${target}) is on a remote host.`,
      `Aliases: ${aliases.length > 0 ? aliases.join(", ") : "none"}.`,
      description
    ];
    if (contentRows.length > 0) {
      lines.push("Contents:");
      for (const item of contentRows) lines.push(`  ${item.name} (${item.id})`);
    }
    const rewrittenObviousVerbs = obviousVerbs.map((syntax) => this.rewriteObviousSyntaxObjectName(syntax, name, matchedName));
    if (rewrittenObviousVerbs.length > 0) {
      lines.push("Obvious verbs:");
      lines.push(...rewrittenObviousVerbs);
    }
    for (const line of lines) this.tellPlayer(ctx, ctx.actor, [line]);
    return {
      target,
      owner,
      aliases,
      description,
      contents: contentRows,
      obvious_verbs: rewrittenObviousVerbs,
      remote: true,
      text: lines.join("\n")
    } as unknown as WooValue;
  }

  private rewriteObviousSyntaxObjectName(syntax: string, remoteName: string, matchedName: string): string {
    const replacement = matchedName.trim();
    if (!replacement || replacement === remoteName) return syntax;
    return syntax.replace(new RegExp(`\\b${escapeRegExp(remoteName)}\\b`, "g"), replacement);
  }

  private playerNameTokens(input: string): string[] {
    return input.split(/\s+/).map((token) => token.trim()).filter(Boolean);
  }

  private matchPlayerForCommand(input: string): ObjRef | null {
    const wanted = input.trim().toLowerCase();
    if (!wanted) return null;
    const exact: ObjRef[] = [];
    const prefix: ObjRef[] = [];
    for (const [id, obj] of this.objects.entries()) {
      if (!this.inheritsFrom(id, "$player")) continue;
      const aliasesValue = this.propOrNull(id, "aliases");
      const names = [id, obj.name, this.propOrNull(id, "name"), ...(Array.isArray(aliasesValue) ? aliasesValue : [])]
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .map((item) => item.toLowerCase());
      if (names.includes(wanted)) exact.push(id);
      else if (names.some((name) => name.startsWith(wanted))) prefix.push(id);
    }
    const matches = exact.length > 0 ? Array.from(new Set(exact)) : Array.from(new Set(prefix));
    return matches.length === 1 ? matches[0] : null;
  }

  obviousCommandVerbs(target: ObjRef, options: { actor?: ObjRef; executableOnly?: boolean } = {}): VerbDef[] {
    const dullClasses = new Set<ObjRef>(["$root", "$room", "$player", "$prog", "$builder"]);
    const out: VerbDef[] = [];
    const seen = new Set<string>();
    for (const definer of this.localAncestry(target)) {
      if (dullClasses.has(definer)) continue;
      for (const verb of this.object(definer).verbs) {
        if (!verb.perms.includes("r")) continue;
        if (options.executableOnly && options.actor && !this.canExecuteVerb(options.actor, verb)) continue;
        const syntax = this.formatCommandSyntax(verb, target);
        if (!syntax) continue;
        const key = `${verb.name}:${syntax}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(verb);
      }
    }
    return out;
  }

  obviousCommandSyntaxes(target: ObjRef, objectName: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const verb of this.obviousCommandVerbs(target)) {
      const syntax = this.formatCommandSyntax(verb, objectName);
      if (!syntax || seen.has(syntax)) continue;
      seen.add(syntax);
      out.push(`  ${syntax}`);
    }
    return out;
  }

  private formatCommandSyntax(verb: VerbDef, objectName: string): string | null {
    const command = verb.arg_spec && typeof verb.arg_spec === "object" && !Array.isArray(verb.arg_spec)
      ? (verb.arg_spec.command as WooValue | undefined)
      : undefined;
    if (!command || typeof command !== "object" || Array.isArray(command)) return null;
    const map = command as Record<string, WooValue>;
    const dobj = typeof map.dobj === "string" ? map.dobj : "any";
    const prep = typeof map.prep === "string" ? map.prep : Array.isArray(map.prep) ? String(map.prep[0] ?? "any") : "any";
    const iobj = typeof map.iobj === "string" ? map.iobj : "any";
    if (prep === "none" && iobj === "this") return null;
    const names = [verb.name, ...(verb.aliases ?? [])]
      .filter((name) => !name.startsWith("@"))
      .map((name) => this.formatVerbNameForExamine(name));
    if (names.length === 0) return null;
    let rest = "";
    if (dobj !== "none") rest += ` ${dobj === "this" ? objectName : "<anything>"}`;
    if (prep !== "none") {
      rest += ` ${prep === "any" ? "<anything>" : prep}`;
      if (iobj !== "none") rest += ` ${iobj === "this" ? objectName : "<anything>"}`;
    }
    return `${names.join("/")}${rest}`;
  }

  private formatVerbNameForExamine(name: string): string {
    return name
      .replace(/\* /g, "<anything> ")
      .replace(/\*$/g, "<anything>");
  }

  private async titleForLook(ctx: CallContext, room: ObjRef, item: ObjRef): Promise<string> {
    // Cross-host dispatch from inside a held host-queue slot deadlocks: a
    // composeRoomLook on the chatroom DO would dispatch `:title()` on every
    // gateway-hosted item, and the gateway's queue is busy waiting on the
    // very call that is now trying to call back. Until host-queue re-entrancy
    // (or durable awaiting_call parking) lands, fall back to a property read
    // of `name` (cross-host but queue-free) instead of the recursive dispatch.
    if (await this.remoteHostForObject(item, ctx.hostMemo)) {
      try {
        const name = await this.getPropChecked(ctx.progr, item, "name", ctx.hostMemo);
        if (typeof name === "string" && name.length > 0) return name;
      } catch (err) {
        if (!isOptionalProjectionReadError(err)) throw err;
        // E_PROPNF / E_PERM — fall through to id.
      }
      return item;
    }
    if (!this.objects.has(item)) return item;
    try {
      // 1024 chars is a generous upper bound for inventory/look titles
      // (typical `name + ": " + 96-char preview` runs under 200) while still
      // preventing a misbehaving or hostile :title() verb from materializing
      // megabytes of text into room/inventory composition. On overflow,
      // fall back to the bare object name like a missing :title() does.
      const value = await this.dispatch({ ...ctx, caller: room, progr: ctx.actor }, item, "title", [], undefined, 1024);
      if (typeof value !== "string") throw wooError("E_TYPE", `${item}:title() must return a string`, value);
      return value;
    } catch (err) {
      const error = normalizeError(err);
      if (error.code !== "E_VERBNF" && error.code !== "E_TOOBIG") throw err;
      return this.objects.has(item) ? this.object(item).name : item;
    }
  }

  // Cross-host-aware display name. The local stub of a remote object
  // (created by ensureInternalActor on cross-host /__internal/remote-dispatch)
  // carries `name = id` rather than the authoritative display name, so we
  // always RPC to the owning host when the object is remote — even when a
  // stub happens to be present locally.
  private async objectDisplayNameAsync(progr: ObjRef, objRef: ObjRef, memo?: HostOperationMemo): Promise<string> {
    if (await this.remoteHostForObject(objRef, memo)) {
      try {
        const name = await this.getPropChecked(progr, objRef, "name", memo);
        if (typeof name === "string" && name.length > 0) return name;
      } catch (err) {
        if (!isOptionalProjectionReadError(err)) throw err;
        // E_PROPNF / E_PERM — fall through to id.
      }
      return objRef;
    }
    if (this.objects.has(objRef)) return this.object(objRef).name || objRef;
    return objRef;
  }

  private tryResolveVerb(target: ObjRef, verb: string): ResolvedVerb | null {
    try {
      return this.resolveVerb(target, verb);
    } catch {
      return null;
    }
  }

  private async tryResolveVerbForCommand(ctx: CallContext, target: ObjRef, verb: string): Promise<CommandVerbSummary | null> {
    if (await this.remoteHostForObject(target, ctx.hostMemo)) {
      if (!this.hostBridge?.resolveVerb) return null;
      try {
        return await this.hostBridge.resolveVerb(target, verb, ctx.hostMemo);
      } catch (err) {
        const error = normalizeError(err);
        if (error.code !== "E_VERBNF" && !isReadAvailabilityError(error)) throw err;
        return null;
      }
    }
    const resolved = this.tryResolveVerb(target, verb);
    return resolved ? { name: resolved.verb.name, definer: resolved.definer, direct_callable: resolved.verb.direct_callable === true, arg_spec: resolved.verb.arg_spec ?? {} } : null;
  }

  private async planCommandForSpace(ctx: CallContext, input: string, space: ObjRef): Promise<WooValue> {
    const text = input.trim();
    if (!text) return await this.commandHuhPlan(ctx, space, input, "empty command");
    const actor = await this.publicCommandActor(ctx, undefined);
    const location = await this.publicCommandLocation(ctx, actor, space);

    const lowered = await this.lowerSpeechPrefixPlan(ctx, text, space, actor, location);
    if (lowered) return lowered as unknown as WooValue;

    const cmd = await this.parseCommandMap(text, ctx, location, actor);
    if (cmd.verb === "drop" && !cmd.argstr) return await this.commandHuhPlan(ctx, space, text, "Drop what?");
    const metadataPlan = await this.resolveCommandPlan(ctx, cmd, space, actor);
    if (metadataPlan) return metadataPlan as unknown as WooValue;

    const hookPlan = text.startsWith("/") ? await this.commandHuhHookPlan(ctx, space, actor, cmd) : null;
    if (hookPlan) return hookPlan;
    return await this.commandHuhPlan(ctx, space, text, "I don't understand that.");
  }

  private async lowerSpeechPrefixPlan(ctx: CallContext, text: string, space: ObjRef, actor: ObjRef, location: ObjRef | null): Promise<CommandPlan | WooValue | null> {
    const lower = text.toLowerCase();
    const parsed = new Map<string, Promise<CommandMap>>();
    const parse = async (normalized: string) => {
      const existing = parsed.get(normalized);
      if (existing) return await existing;
      const next = this.parseCommandMap(normalized, ctx, location, actor);
      parsed.set(normalized, next);
      return await next;
    };
    if (lower.startsWith("/me ")) {
      const body = text.slice(4).trim();
      return await this.directCommandPlan(ctx, space, "emote", [body], await parse(`emote ${body}`));
    }
    if (text.startsWith(":") && text.length > 1) {
      const body = text.slice(1).trim();
      return await this.directCommandPlan(ctx, space, "emote", [body], await parse(`emote ${body}`));
    }
    if (text.startsWith("]") && text.length > 1) {
      const body = text.slice(1).trim();
      return await this.directCommandPlan(ctx, space, "pose", [body], await parse(`pose ${body}`));
    }
    if (text.startsWith("|") && text.length > 1) {
      const body = text.slice(1).trim();
      return await this.directCommandPlan(ctx, space, "quote", [body], await parse(`quote ${body}`));
    }
    if (text.startsWith("<") && text.length > 1) {
      const body = text.slice(1).trim();
      return await this.directCommandPlan(ctx, space, "self", [body], await parse(`self ${body}`));
    }
    if (text.startsWith("\"") && text.length > 1) {
      const body = text.slice(1).trim();
      return await this.directCommandPlan(ctx, space, "say", [body], await parse(`say ${body}`));
    }
    if (text.startsWith("`") && text.length > 1) {
      return await this.directedSpeechPlan(ctx, space, "say_to", text.slice(1), text, actor, location);
    }
    if (lower.startsWith("/tell ")) {
      return await this.directedSpeechPlan(ctx, space, "tell", text.slice(6), text, actor, location);
    }
    if (text.startsWith("[")) {
      const close = text.indexOf("]");
      if (close > 1) {
        const style = text.slice(1, close).trim();
        let body = text.slice(close + 1).trim();
        if (body.startsWith(":")) body = body.slice(1).trim();
        if (!style || !body) return await this.commandHuhPlan(ctx, space, text, "Styled speech needs a style and text.");
        return await this.directCommandPlan(ctx, space, "say_as", [style, body], await parse(`say_as ${body}`));
      }
    }
    return null;
  }

  private async directedSpeechPlan(ctx: CallContext, space: ObjRef, verbName: string, rest: string, original: string, actor: ObjRef, location: ObjRef | null): Promise<CommandPlan | WooValue> {
    const normalized = `${verbName} ${rest.trim()}`;
    const cmd = await this.parseCommandMap(normalized, ctx, location, actor);
    const target = cmd.dobj_prefix;
    const body = cmd.dobj_prefix_rest.trim();
    if (!target || !body) return await this.commandHuhPlan(ctx, space, original, "Directed speech needs a recipient and text.");
    return await this.directCommandPlan(ctx, space, verbName, [target, body], cmd);
  }

  private async resolveCommandPlan(ctx: CallContext, cmd: CommandMap, space: ObjRef, actor: ObjRef): Promise<CommandPlan | null> {
    // parseCommandMap only returns object refs visible from the command scope.
    // The public match_command_verb native still enforces command-object
    // visibility because callers may pass arbitrary targets.
    const targets = this.commandTargetOrder(cmd, space, actor);
    for (const target of targets) {
      const matched = await this.matchCommandVerbOnTarget(ctx, cmd, target);
      if (matched) return await this.commandPlanForResolved(ctx, space, matched.target, matched.verb, matched.args, cmd);
    }
    return null;
  }

  private commandTargetOrder(cmd: CommandMap, space: ObjRef, actor: ObjRef): ObjRef[] {
    const out: ObjRef[] = [];
    const add = (id: ObjRef | null | undefined) => {
      if (id && !out.includes(id)) out.push(id);
    };
    add(cmd.dobj_prefix);
    add(cmd.dobj);
    add(cmd.iobj);
    add(space);
    add(actor);
    return out;
  }

  private async matchCommandVerbOnTarget(ctx: CallContext, cmd: CommandMap, target: ObjRef): Promise<{ target: ObjRef; verb: string; args: WooValue[]; direct_callable: boolean; arg_spec: Record<string, WooValue> } | null> {
    const candidates = await this.commandVerbCandidates(ctx, target, cmd.verb);
    for (const candidate of candidates) {
      const pattern = commandPattern(candidate.arg_spec);
      if (!pattern) continue;
      if (!await this.commandPatternMatches(ctx, pattern, cmd, target)) continue;
      return {
        target,
        verb: candidate.name,
        args: this.commandArgsFrom(pattern, cmd),
        direct_callable: candidate.direct_callable,
        arg_spec: candidate.arg_spec ?? {}
      };
    }
    return null;
  }

  private async commandVerbCandidates(ctx: CallContext, target: ObjRef, name: string): Promise<CommandVerbSummary[]> {
    if (await this.remoteHostForObject(target, ctx.hostMemo)) {
      if (this.hostBridge?.commandVerbCandidates) {
        try {
          return await this.hostBridge.commandVerbCandidates(target, name, ctx.hostMemo);
        } catch (err) {
          if (!isReadAvailabilityError(err)) throw err;
          return [];
        }
      }
      const resolved = await this.tryResolveVerbForCommand(ctx, target, name);
      return resolved ? [resolved] : [];
    }
    return this.commandVerbCandidateSummaries(target, name);
  }

  commandVerbCandidateSummaries(target: ObjRef, name: string): CommandVerbSummary[] {
    if (!this.objects.has(target)) return [];
    const out: CommandVerbSummary[] = [];
    const seen = new Set<string>();
    const collectFrom = (start: ObjRef | null) => {
      let current = start;
      while (current) {
        const obj = this.object(current);
        for (const verb of obj.verbs) {
          if (!verbNameMatches(verb, name)) continue;
          const key = `${current}:${verb.slot ?? verb.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ name: verb.name, definer: current, direct_callable: verb.direct_callable === true, arg_spec: verb.arg_spec ?? {} });
        }
        current = obj.parent;
      }
    };
    collectFrom(target);
    if (this.canCarryFeatures(target)) {
      for (const feature of this.featureList(target)) collectFrom(feature);
    }
    return out;
  }

  private async commandPatternMatches(ctx: CallContext, pattern: CommandPattern, cmd: CommandMap, target: ObjRef): Promise<boolean> {
    if (!this.commandPrepMatches(pattern.prep, cmd.prep)) return false;
    if (!await this.commandSlotMatches(ctx, pattern.dobj ?? "any", "dobj", cmd, target)) return false;
    if (!await this.commandSlotMatches(ctx, pattern.iobj ?? "any", "iobj", cmd, target)) return false;
    return true;
  }

  private commandPrepMatches(pattern: WooValue | undefined, prep: string | null): boolean {
    const value = pattern ?? "any";
    if (value === "any") return true;
    if (value === "none") return prep == null || prep === "";
    if (typeof value === "string") return (prep ?? "") === value;
    if (Array.isArray(value)) return value.some((item) => typeof item === "string" && item === (prep ?? ""));
    return false;
  }

  private async commandSlotMatches(ctx: CallContext, pattern: WooValue, slot: "dobj" | "iobj", cmd: CommandMap, target: ObjRef): Promise<boolean> {
    if (Array.isArray(pattern)) {
      for (const item of pattern) {
        if (await this.commandSlotMatches(ctx, item, slot, cmd, target)) return true;
      }
      return false;
    }
    const text = slot === "dobj" ? cmd.dobjstr : cmd.iobjstr;
    const obj = slot === "dobj" ? (cmd.dobj ?? cmd.dobj_prefix) : cmd.iobj;
    if (pattern === "any") return true;
    if (pattern === "none") return !text && !obj;
    if (pattern === "string") return text.trim().length > 0;
    if (pattern === "object") return Boolean(obj);
    if (pattern === "player") return Boolean(obj && await this.isDescendantOfChecked(obj, "$player", ctx.hostMemo));
    if (pattern === "this") return obj === target;
    return false;
  }

  private commandArgsFrom(pattern: CommandPattern, cmd: CommandMap): WooValue[] {
    const tokens = Array.isArray(pattern.args_from) ? pattern.args_from : [];
    if (tokens.length === 0) return [];
    return tokens.map((token) => this.commandArgFrom(String(token), cmd));
  }

  private commandArgFrom(token: string, cmd: CommandMap): WooValue {
    if (token === "text") return cmd.text;
    if (token === "verb") return cmd.verb;
    if (token === "argstr") return cmd.argstr;
    if (token === "prep") return cmd.prep ?? "";
    if (token === "dobj") return cmd.dobj ?? "$failed_match";
    if (token === "dobjstr") return cmd.dobjstr;
    if (token === "dobj_prefix") return cmd.dobj_prefix ?? "$failed_match";
    if (token === "dobj_prefix_rest") return cmd.dobj_prefix_rest;
    if (token === "iobj") return cmd.iobj ?? "$failed_match";
    if (token === "iobjstr") return cmd.iobjstr;
    if (token === "cmd") return cmd as unknown as WooValue;
    throw wooError("E_INVARG", `unsupported command args_from token: ${token}`, token);
  }

  private async directCommandPlan(ctx: CallContext, space: ObjRef, verb: string, args: WooValue[], cmd: CommandMap): Promise<CommandPlan> {
    return await this.commandPlanForResolved(ctx, space, space, verb, args, cmd);
  }

  private async commandPlanForResolved(ctx: CallContext, commandSpace: ObjRef, target: ObjRef, verbName: string, args: WooValue[], cmd: CommandMap): Promise<CommandPlan> {
    const resolved = await this.tryResolveVerbForCommand(ctx, target, verbName);
    const directCallable = resolved?.direct_callable === true;
    let route: "direct" | "sequenced" = directCallable ? "direct" : "sequenced";
    let space: ObjRef | null = null;
    if (route === "sequenced") {
      space = await this.isDescendantOfChecked(target, "$space", ctx.hostMemo) ? target : commandSpace;
      if (!space) throw wooError("E_NOLOCATION", "sequenced command has no command space", { target, verb: verbName });
    }
    return { ok: true, route, space, target, verb: resolved?.name ?? verbName, args, cmd };
  }

  private async commandHuhPlan(ctx: CallContext, space: ObjRef, text: string, reason: string): Promise<WooValue> {
    try {
      await this.dispatch(ctx, ctx.actor, "huh", [text, reason, space]);
    } catch {
      ctx.observe({ type: "huh", source: space, actor: ctx.actor, text, reason, ts: Date.now(), _audience_override: [ctx.actor] });
    }
    return { ok: false, route: "huh", space, target: ctx.actor, verb: "huh", args: [text, reason, space], error: reason, text } as unknown as WooValue;
  }

  private async commandHuhHookPlan(ctx: CallContext, space: ObjRef, actor: ObjRef, cmd: CommandMap): Promise<WooValue | null> {
    for (const [target, verb] of [[actor, "my_huh"], [space, "here_huh"], [actor, "last_huh"]] as Array<[ObjRef, string]>) {
      let result: WooValue;
      try {
        // Huh hooks are part of command planning, so the planning task remains
        // the caller; hooks that want delegated authority should dispatch
        // explicitly just like ordinary woocode.
        result = await this.dispatch(ctx, target, verb, [cmd as unknown as WooValue]);
      } catch (err) {
        // Only absence is ignored. A present hook that raises is a real planner
        // failure so catalog bugs surface instead of silently degrading to huh.
        if (normalizeError(err).code === "E_VERBNF") continue;
        throw err;
      }
      if (result && typeof result === "object" && !Array.isArray(result) && "ok" in result) return result;
      if (result === true) return { ok: false, route: "handled", target, verb, args: [cmd as unknown as WooValue], text: cmd.text } as unknown as WooValue;
    }
    return null;
  }

  private async parseCommandMap(text: string, ctx: CallContext, location: ObjRef | null, actor: ObjRef = ctx.actor): Promise<CommandMap> {
    const trimmed = text.trim();
    if (!trimmed) throw wooError("E_INVARG", "empty command");
    const tokens = tokenizeCommand(trimmed);
    const verbToken = tokens[0];
    if (!verbToken) throw wooError("E_INVARG", "empty command");
    const argstr = trimmed.slice(verbToken.end).trim();
    const restTokens = tokens.slice(1);
    const prepMatch = findPreposition(restTokens);
    const dobjTokens = prepMatch ? restTokens.slice(0, prepMatch.index) : restTokens;
    const iobjTokens = prepMatch ? restTokens.slice(prepMatch.index + prepMatch.length) : [];
    const dobjstr = tokenPhrase(dobjTokens);
    const iobjstr = tokenPhrase(iobjTokens);
    const dobjMatch = dobjstr ? await this.matchObjectForActorAsync(dobjstr, ctx, location, actor) : null;
    const iobjMatch = iobjstr ? await this.matchObjectForActorAsync(iobjstr, ctx, location, actor) : null;
    const prefix = await this.longestObjectPrefix(restTokens, ctx, location, actor);
    const prefixTokens = prefix ? restTokens.slice(0, prefix.length) : [];
    const prefixRestTokens = prefix ? restTokens.slice(prefix.length) : [];
    const verb = verbToken.value.toLowerCase();
    let dobj = dobjMatch?.status === "ok" ? dobjMatch.value : null;
    let dobjText = dobjstr;
    let dobjPrefix = prefix?.object ?? null;
    let dobjPrefixText = tokenPhrase(prefixTokens);
    let dobjPrefixRest = tokenPhrase(prefixRestTokens);
    const prep = prepMatch?.prep ?? null;
    const iobj = iobjMatch?.status === "ok" ? iobjMatch.value : null;
    // Treat "look at <object>" as the same object command shape as
    // "look <object>" while preserving the parsed preposition for diagnostics.
    if ((verb === "look" || verb === "l" || verb === "examine" || verb === "ex") && prep === "at" && !dobj && !dobjPrefix && iobj) {
      dobj = iobj;
      dobjText = iobjstr;
      dobjPrefix = iobj;
      dobjPrefixText = iobjstr;
      dobjPrefixRest = "";
    }
    return {
      verb,
      dobj,
      dobjstr: dobjText,
      dobj_prefix: dobjPrefix,
      dobj_prefix_str: dobjPrefixText,
      dobj_prefix_rest: dobjPrefixRest,
      prep,
      iobj,
      iobjstr,
      args: restTokens.map((token) => token.value),
      argstr,
      text: trimmed
    };
  }

  private async longestObjectPrefix(tokens: ParsedToken[], ctx: CallContext, location: ObjRef | null, actor: ObjRef = ctx.actor): Promise<{ object: ObjRef; end: number; length: number } | null> {
    for (let length = tokens.length; length >= 1; length--) {
      const phrase = tokenPhrase(tokens.slice(0, length));
      const match = await this.matchObjectForActorAsync(phrase, ctx, location, actor);
      if (match.status === "ok") return { object: match.value, end: tokens[length - 1].end, length };
    }
    return null;
  }

  private async matchObjectForActorAsync(name: string, ctx: CallContext, location: ObjRef | null, actor: ObjRef = ctx.actor): Promise<ObjectMatch> {
    const wanted = name.trim();
    if (!wanted) return this.matchSentinel("failed");
    const lower = wanted.toLowerCase();
    if (lower === "me") return { status: "ok", value: actor };
    if (lower === "here" && location) return { status: "ok", value: location };

    const candidates: ObjRef[] = [];
    const add = (id: unknown): void => {
      if (typeof id === "string" && !candidates.includes(id)) candidates.push(id);
    };
    add(actor);
    if (location) {
      add(location);
      for (const id of await this.objectContents(location, ctx.hostMemo)) add(id);
      const present = await this.propOrNullForActorAsync(ctx.progr, location, "subscribers", ctx.hostMemo);
      if (Array.isArray(present)) for (const id of present) add(id);
    }
    try {
      for (const id of await this.objectContents(actor, ctx.hostMemo)) add(id);
    } catch {
      // Actor inventory is part of local matching, but a missing/stale actor stub
      // should not make room command parsing fail.
    }
    return await this.matchObjectInCandidatesAsync(ctx, wanted, candidates);
  }

  private async matchObjectInCandidatesAsync(ctx: CallContext, name: string, candidates: ObjRef[]): Promise<ObjectMatch> {
    const wanted = name.trim();
    if (!wanted) return this.matchSentinel("failed");
    const lower = wanted.toLowerCase();
    const exact: ObjRef[] = [];
    const alias: ObjRef[] = [];
    const prefix: ObjRef[] = [];
    const contains: ObjRef[] = [];
    const remoteSummaries = await this.objectSummariesForLook(ctx, candidates);
    // Per-candidate name/alias enrichment is independent — fan it out in
    // parallel. With ~10 candidates and per-candidate verb dispatches
    // (titleForLook, $note text), the serial form was the dominant cost of
    // an unhandled chat utterance like "well this is fun".
    const enriched = await Promise.all(candidates.map((id) => this.enrichMatchCandidate(ctx, id, remoteSummaries.summaries.get(id) ?? null)));
    for (const { id, names, aliases } of enriched) {
      const nameValues = names.filter(Boolean).map((item) => String(item).toLowerCase());
      const aliasValues = aliases.map((item) => item.toLowerCase());
      if (nameValues.includes(lower)) exact.push(id);
      else if (aliasValues.includes(lower)) alias.push(id);
      else if (wanted.length >= 2 && [...nameValues, ...aliasValues].some((item) => item.startsWith(lower))) prefix.push(id);
      else if (wanted.length >= 2 && [...nameValues, ...aliasValues].some((item) => item.includes(lower))) contains.push(id);
    }
    return this.resolveObjectMatch(exact.length > 0 ? exact : alias.length > 0 ? alias : prefix.length > 0 ? prefix : contains);
  }

  private async enrichMatchCandidate(ctx: CallContext, id: ObjRef, summary: HostObjectSummary | null): Promise<{ id: ObjRef; names: string[]; aliases: string[] }> {
    const names: string[] = [id];
    const aliases: string[] = [];
    if (await this.remoteHostForObject(id, ctx.hostMemo)) {
      const resolved = summary ?? await this.objectSummaryForLook(ctx, id);
      if (resolved) {
        names.push(titleFromSummary(id, resolved));
        if (Array.isArray(resolved.aliases)) aliases.push(...resolved.aliases.map((item) => String(item)));
      } else {
        try {
          const remoteName = await this.getPropChecked(ctx.progr, id, "name", ctx.hostMemo);
          if (typeof remoteName === "string") names.push(remoteName);
        } catch (err) {
          if (!isOptionalProjectionReadError(err)) throw err;
          // Remote object id remains matchable even when display metadata is absent.
        }
        try {
          const remoteAliases = await this.getPropChecked(ctx.progr, id, "aliases", ctx.hostMemo);
          if (Array.isArray(remoteAliases)) aliases.push(...remoteAliases.map((item) => String(item)));
        } catch (err) {
          if (!isOptionalProjectionReadError(err)) throw err;
          // Aliases are optional for matching.
        }
      }
      return { id, names, aliases };
    }
    if (!this.objects.has(id)) return { id, names, aliases };
    const obj = this.object(id);
    names.push(obj.name);
    const [title] = await Promise.all([
      this.titleForLook(ctx, ctx.thisObj, id).catch(() => null),
      this.addCatalogMatchNames(ctx, id, names)
    ]);
    if (typeof title === "string") names.push(title);
    const localAliases = this.propOrNull(id, "aliases");
    if (Array.isArray(localAliases)) aliases.push(...localAliases.map((item) => String(item)));
    return { id, names, aliases };
  }

  private async addCatalogMatchNames(ctx: CallContext, id: ObjRef, names: string[]): Promise<void> {
    // Hard-cap the result so a hostile or accidentally-huge :match_names()
    // can't blow up the matcher. Skip the dispatch entirely when the verb
    // isn't defined; matching runs on every unhandled chat utterance, so
    // avoiding a throw-on-miss for the common no-:match_names case matters.
    if (!this.resolveVerbFrom(id, "match_names", false)) return;
    const result = await this.dispatch(
      { ...ctx, caller: ctx.thisObj, progr: ctx.actor },
      id,
      "match_names",
      [],
      undefined,
      4096
    ).catch(() => null);
    if (!Array.isArray(result)) return;
    for (const entry of result) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.trim();
      if (trimmed) names.push(trimmed);
    }
  }

  private resolveObjectMatch(matches: ObjRef[]): ObjectMatch {
    const unique = Array.from(new Set(matches));
    if (unique.length === 1) return { status: "ok", value: unique[0] };
    if (unique.length > 1) return this.matchSentinel("ambiguous");
    return this.matchSentinel("failed");
  }

  private matchSentinel(kind: "failed" | "ambiguous"): ObjectMatch {
    const value = kind === "failed"
      ? (this.objects.has("$failed_match") ? "$failed_match" : "#-1")
      : (this.objects.has("$ambiguous_match") ? "$ambiguous_match" : "#-1");
    return { status: kind, value };
  }

  private sweepIdempotency(): void {
    const now = Date.now();
    for (const [key, entry] of this.idempotency) {
      if (now - entry.at >= 5 * 60 * 1000) this.idempotency.delete(key);
    }
    if (this.idempotency.size <= 1000) return;
    const oldest = Array.from(this.idempotency.entries()).sort((a, b) => a[1].at - b[1].at);
    for (const [key] of oldest.slice(0, this.idempotency.size - 1000)) this.idempotency.delete(key);
  }
}

function sourceInstallSummary(input: { ok: boolean; dryRun: boolean; current?: VerbDef | null; diagnostics: WooValue; metadata?: WooValue; slot: number; version?: number }): Record<string, WooValue> {
  const version = input.version ?? (input.current?.version ?? 0);
  const summary: Record<string, WooValue> = {
    ok: input.ok,
    dry_run: input.dryRun,
    slot: input.slot,
    version,
    diagnostics: input.diagnostics
  };
  if (input.metadata !== undefined) summary.metadata = input.metadata;
  return summary;
}

function sourceInstallFailure(dryRun: boolean, code: string, message: string, current: VerbDef | null = null, slot = 0, metadata?: WooValue): Record<string, WooValue> {
  return sourceInstallSummary({
    ok: false,
    dryRun,
    current,
    slot,
    metadata,
    diagnostics: [{ severity: "error", code, message }] as unknown as WooValue
  });
}

function progOptions(value: WooValue): Record<string, WooValue> {
  if (value === null || value === undefined) return {};
  return assertMap(value);
}

function optionBool(options: Record<string, WooValue>, name: string, fallback: boolean): boolean {
  const value = options[name];
  return typeof value === "boolean" ? value : fallback;
}

function optionString(options: Record<string, WooValue>, name: string, fallback: string): string {
  const value = options[name];
  return typeof value === "string" ? value : fallback;
}

function optionMaybeString(options: Record<string, WooValue>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function optionMaybeBool(options: Record<string, WooValue>, name: string): boolean | undefined {
  const value = options[name];
  return typeof value === "boolean" ? value : undefined;
}

function optionObjOrNull(options: Record<string, WooValue>, name: string, fallback: ObjRef | null): ObjRef | null {
  if (!hasOption(options, name)) return fallback;
  const value = options[name];
  if (value === null) return null;
  return assertObj(value);
}

function optionNullableInt(options: Record<string, WooValue>, name: string): number | null {
  if (!hasOption(options, name) || options[name] === null) return null;
  const value = options[name];
  if (typeof value !== "number" || !Number.isInteger(value)) throw wooError("E_TYPE", `${name} must be an integer`, value);
  return value;
}

function hasOption(options: Record<string, WooValue>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(options, name);
}

function optionStringList(options: Record<string, WooValue>, name: string, fallback: string[]): string[] {
  const value = options[name];
  if (!Array.isArray(value)) return fallback;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : fallback;
}

function optionInt(options: Record<string, WooValue>, name: string, fallback: number, min: number, max: number): number {
  const value = options[name];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function textMatches(query: string, ...values: WooValue[]): boolean {
  if (!query) return true;
  return values.some((value) => {
    if (value === null || value === undefined) return false;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.toLowerCase().includes(query);
  });
}

function valueSummary(value: WooValue, maxBytes: number): string {
  let summary: string;
  if (value === null) summary = "null";
  else if (typeof value === "string") summary = `string(${value.length} chars): ${value}`;
  else if (typeof value === "number") summary = Number.isInteger(value) ? `int(${value})` : `num(${value})`;
  else if (typeof value === "boolean") summary = `bool(${value})`;
  else if (Array.isArray(value)) summary = `list(${value.length}) ${JSON.stringify(value)}`;
  else summary = `map(${Object.keys(value).length}) ${JSON.stringify(value)}`;
  if (summary.length <= maxBytes) return summary;
  return `${summary.slice(0, Math.max(0, maxBytes - 3))}...`;
}

function propertyDefSummary(def: PropertyDef, definedOn: ObjRef): Record<string, WooValue> {
  return {
    name: def.name,
    owner: def.owner,
    perms: def.perms,
    defined_on: definedOn,
    type_hint: def.typeHint ?? null,
    default_summary: valueSummary(def.defaultValue, 512),
    version: def.version
  };
}

function typeHintForValue(value: WooValue): string {
  if (value === null) return "any";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "num";
  if (Array.isArray(value)) return "list";
  return "map";
}

function parseVerbEditorSession(value: WooValue): VerbEditorSession {
  const raw = assertMap(value);
  const diagnostics = Array.isArray(raw.diagnostics) ? raw.diagnostics : [];
  if (raw.kind !== "verb") throw wooError("E_TYPE", "unsupported editor session kind", raw.kind);
  return {
    actor: assertObj(raw.actor),
    target: assertObj(raw.target),
    kind: "verb",
    descriptor: cloneValue(raw.descriptor),
    slot: typeof raw.slot === "number" && Number.isInteger(raw.slot) ? raw.slot : null,
    expected_version: typeof raw.expected_version === "number" && Number.isInteger(raw.expected_version) ? raw.expected_version : null,
    buffer: assertString(raw.buffer),
    dirty: raw.dirty === true,
    diagnostics: cloneValue(diagnostics as WooValue) as WooValue[],
    started_at: typeof raw.started_at === "number" ? raw.started_at : 0,
    updated_at: typeof raw.updated_at === "number" ? raw.updated_at : 0,
    previous_location: typeof raw.previous_location === "string" ? raw.previous_location : null,
    surface_class: assertObj(raw.surface_class)
  };
}

function serializeVerbEditorSession(session: VerbEditorSession): Record<string, WooValue> {
  return {
    actor: session.actor,
    target: session.target,
    kind: session.kind,
    descriptor: cloneValue(session.descriptor),
    slot: session.slot,
    expected_version: session.expected_version,
    buffer: session.buffer,
    dirty: session.dirty,
    diagnostics: cloneValue(session.diagnostics as WooValue) as WooValue[],
    started_at: session.started_at,
    updated_at: session.updated_at,
    previous_location: session.previous_location,
    surface_class: session.surface_class
  };
}

function splitEditorLines(buffer: string): string[] {
  return buffer.length === 0 ? [] : buffer.split(/\r?\n/);
}

export function normalizeError(err: unknown): ErrorValue {
  if (isErrorValue(err)) return err;
  if (err instanceof SyntaxError) return wooError("E_INVARG", err.message);
  if (err instanceof Error) return wooError("E_INTERNAL", err.message);
  return wooError("E_INTERNAL", "unknown error", String(err));
}

function isReadAvailabilityError(err: unknown): boolean {
  const error = normalizeError(err);
  return error.code === "E_TIMEOUT" || error.code === "E_OBJNF";
}

function isOptionalProjectionReadError(err: unknown): boolean {
  const error = normalizeError(err);
  return error.code === "E_PROPNF" || error.code === "E_PERM" || isReadAvailabilityError(error);
}

function tokenizeCommand(text: string): ParsedToken[] {
  const tokens: ParsedToken[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) break;
    const start = i;
    if (text[i] === "\"") {
      i += 1;
      let value = "";
      while (i < text.length) {
        const ch = text[i];
        if (ch === "\\" && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
          continue;
        }
        if (ch === "\"") {
          i += 1;
          break;
        }
        value += ch;
        i += 1;
      }
      tokens.push({ value, start, end: i });
      continue;
    }
    while (i < text.length && !/\s/.test(text[i])) i += 1;
    tokens.push({ value: text.slice(start, i), start, end: i });
  }
  return tokens;
}

function tokenPhrase(tokens: ParsedToken[]): string {
  return tokens.map((token) => token.value).join(" ").trim();
}

const PREPOSITIONS = [
  ["in", "front", "of"],
  ["on", "top", "of"],
  ["out", "of"],
  ["off", "of"],
  ["with"],
  ["using"],
  ["at"],
  ["to"],
  ["in"],
  ["inside"],
  ["into"],
  ["on"],
  ["upon"],
  ["as"],
  ["from"],
  ["over"],
  ["through"],
  ["under"],
  ["underneath"],
  ["behind"],
  ["beside"],
  ["for"],
  ["about"],
  ["is"],
  ["as"],
  ["off"]
].sort((a, b) => b.length - a.length);

function findPreposition(tokens: ParsedToken[]): { index: number; length: number; prep: string } | null {
  for (let i = 0; i < tokens.length; i++) {
    for (const prep of PREPOSITIONS) {
      if (i + prep.length > tokens.length) continue;
      const matches = prep.every((part, offset) => tokens[i + offset].value.toLowerCase() === part);
      if (matches) return { index: i, length: prep.length, prep: prep.join(" ") === "into" ? "in" : prep.join(" ") };
    }
  }
  return null;
}

function verbAliasMatches(pattern: string, name: string): boolean {
  for (const segment of pattern.split("|")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    if (trimmed === name) return true;
    const star = trimmed.indexOf("*");
    if (star === trimmed.length - 1) {
      const literal = trimmed.slice(0, -1);
      if (literal && name.startsWith(literal)) return true;
      continue;
    }
    const abbreviation = star >= 0 ? star : trimmed.indexOf("@");
    if (abbreviation >= 0) {
      const literal = trimmed.slice(0, abbreviation) + trimmed.slice(abbreviation + 1);
      if (literal && literal.startsWith(name) && name.length >= Math.max(1, abbreviation)) return true;
      continue;
    }
  }
  return false;
}

function verbNameMatches(verb: VerbDef, name: string): boolean {
  return verb.name === name || verb.aliases.some((alias) => verbAliasMatches(alias, name));
}

function commandPattern(argSpec: Record<string, WooValue> | undefined): CommandPattern | null {
  const raw = argSpec?.command;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as CommandPattern;
}

function commandMapFromValue(value: WooValue | undefined): CommandMap {
  const map = assertMap(value ?? {});
  return {
    verb: assertString(map.verb ?? ""),
    dobj: typeof map.dobj === "string" ? map.dobj : null,
    dobjstr: typeof map.dobjstr === "string" ? map.dobjstr : "",
    dobj_prefix: typeof map.dobj_prefix === "string" ? map.dobj_prefix : null,
    dobj_prefix_str: typeof map.dobj_prefix_str === "string" ? map.dobj_prefix_str : "",
    dobj_prefix_rest: typeof map.dobj_prefix_rest === "string" ? map.dobj_prefix_rest : "",
    prep: typeof map.prep === "string" ? map.prep : null,
    iobj: typeof map.iobj === "string" ? map.iobj : null,
    iobjstr: typeof map.iobjstr === "string" ? map.iobjstr : "",
    args: Array.isArray(map.args) ? map.args.filter((item): item is string => typeof item === "string") : [],
    argstr: typeof map.argstr === "string" ? map.argstr : "",
    text: typeof map.text === "string" ? map.text : ""
  };
}

function commandPlanFromValue(value: WooValue): CommandPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const map = value as Record<string, WooValue>;
  if (map.ok !== true) return null;
  const route = map.route === "direct" || map.route === "sequenced" ? map.route : null;
  if (!route || typeof map.target !== "string" || typeof map.verb !== "string") return null;
  return {
    ok: true,
    route,
    space: typeof map.space === "string" ? map.space : null,
    target: map.target,
    verb: map.verb,
    args: Array.isArray(map.args) ? map.args : [],
    cmd: commandMapFromValue(map.cmd)
  };
}

function addUnique<T>(items: T[], item: T): T[] {
  return items.includes(item) ? items : [...items, item];
}

function uniqueVerbNames(verbs: VerbDef[]): string[] {
  return Array.from(new Set(verbs.map((verb) => verb.name)));
}

function assertVerbNameDescriptor(value: WooValue): string {
  if (typeof value !== "string") throw wooError("E_TYPE", "verb descriptor must be a string name or integer slot", value);
  return value;
}

function titleFromSummary(fallback: ObjRef, summary: HostObjectSummary): string {
  return typeof summary.name === "string" && summary.name.length > 0 ? summary.name : fallback;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function valueToText(value: WooValue): string {
  if (value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function helpTopic(value: WooValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeHelpTopic(value: string): string {
  let topic = value.trim().toLowerCase();
  if (topic.startsWith("@")) topic = topic.slice(1);
  return topic.replace(/[-_]+/g, "-");
}

function runtimeObjectScope(value: ObjRef): string {
  const cleaned = value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "world";
}

function nextScopedObjectCounter(ids: Iterable<ObjRef>): number {
  // Mirrors the createRuntimeObject/createBuilderObject allocator format: obj_<scope>_<counter>.
  let next = 1;
  for (const id of ids) {
    const match = /^obj_.+_(\d+)$/.exec(id);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value >= next) next = value + 1;
  }
  return next;
}

type SerializedWorldRowStats = {
  rows: number;
  objects: number;
  properties: number;
  verbs: number;
  logs: number;
  snapshots: number;
  sessions: number;
  tasks: number;
  tombstones: number;
};

// Count the SQL rows a backend will write for `repository.saveObject(obj)`.
// One `object` row plus property_def + property_value + property_version +
// verb + child + content + event_schema rows. Mirrors the row layout in
// src/core/sql-shape.ts so the metric stream matches what hits disk without
// peeking at per-backend schemas.
function serializedObjectRowCount(obj: SerializedObject): number {
  return (
    1 +
    obj.propertyDefs.length +
    obj.properties.length +
    obj.propertyVersions.length +
    obj.verbs.length +
    obj.children.length +
    obj.contents.length +
    obj.eventSchemas.length
  );
}

// Count the SQL rows a backend will write for `repository.save(world)`.
// Per-object rows via serializedObjectRowCount, plus session / space_message /
// space_snapshot / task / tombstone rows, plus four `world_meta` rows
// (version + three counters). Used to make `storage_full_save` row counts
// comparable across backends.
function serializedWorldRowStats(world: SerializedWorld): SerializedWorldRowStats {
  let properties = 0;
  let verbs = 0;
  let perObjectRows = 0;
  for (const obj of world.objects) {
    properties += obj.properties.length;
    verbs += obj.verbs.length;
    perObjectRows += serializedObjectRowCount(obj);
  }
  const logs = world.logs.reduce((sum, [, entries]) => sum + entries.length, 0);
  const snapshots = world.snapshots.length;
  const sessions = world.sessions.length;
  const tasks = world.parkedTasks.length;
  const tombstones = (world.tombstones ?? []).length;
  const META_ROWS = 4; // version + objectCounter + parkedTaskCounter + sessionCounter
  return {
    rows: perObjectRows + logs + snapshots + sessions + tasks + tombstones + META_ROWS,
    objects: world.objects.length,
    properties,
    verbs,
    logs,
    snapshots,
    sessions,
    tasks,
    tombstones
  };
}

function nextScopedParkedTaskCounter(tasks: readonly ParkedTaskRecord[]): number {
  // Mirrors the scheduleFork/park*Continuation allocator format: ptask_<counter>.
  let next = 1;
  for (const task of tasks) {
    const match = /^ptask_(\d+)$/.exec(task.id);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value >= next) next = value + 1;
  }
  return next;
}

function isPlainValueMap(value: WooValue | undefined): value is Record<string, WooValue> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return value !== null && typeof value === "object" && typeof (value as Promise<T>).then === "function";
}

const STORAGE_FLUSH_TOP_N = 5;

// Group identical strings, return the K most-frequent as [name, count] pairs.
// Used by storage_flush to surface which property names / object IDs dominate
// a flush. Returns undefined for empty input so the metric stays compact.
function topByName<T extends string>(items: T[], k: number): Array<[T, number]> | undefined {
  if (items.length === 0) return undefined;
  const counts = new Map<T, number>();
  for (const name of items) counts.set(name, (counts.get(name) ?? 0) + 1);
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, k);
}

function hashCanonical(value: WooValue): string {
  const text = canonicalJson(value);
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return `h${Math.abs(hash).toString(16)}`;
}

function canonicalJson(value: WooValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}
