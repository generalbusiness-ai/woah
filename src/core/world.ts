import {
  assertMap,
  assertMintableObjectId,
  assertObj,
  assertString,
  cloneValue,
  dataKeyedMap,
  deepFreezePlainValue,
  freezeTinyBytecode,
  isDeeplyFrozen,
  directedRecipients,
  isErrorValue,
  observationReachesActor,
  valuesEqual,
  type AppliedFrame,
  type CompileDiagnostic,
  type DirectLiveAudience,
  type DirectResultFrame,
  type ErrorFrame,
  type ErrorValue,
  type Message,
  type MetricEvent,
  type Observation,
  type ObjRef,
  type PresenceProjectionDef,
  type PropertyDef,
  type RemoteToolDescriptor,
  type RemoteToolRequest,
  type Session,
  type SpaceLogEntry,
  type TinyBytecode,
  type VerbDef,
  type WooObject,
  type WooValue,
  wooError
} from "./types";
import type { ObjectRepository, SeedWorld, SerializedAuthoritySlice, SerializedObject, SerializedProperty, SerializedSession, SerializedWorld, SpaceSnapshotRecord, WorldRepository } from "./repository";
import { runTinyVm } from "./tiny-vm";
import { commandPlanTransfer, isCommandPlanTransfer, type CommandPlanTransfer } from "./command-plan-transfer";
import { installCatalogManifest, updateCatalogManifest, type CatalogManifest, type CatalogMigrationManifest } from "./catalog-installer";
import {
  deriveCustomerAttribution,
  normalizeCustomerAttribution,
  PROP_CUSTOMER_OF,
  type AttributionSource,
  type CustomerAttribution
} from "./attribution";
import { normalizeVerbPerms } from "./verb-perms";
import { verbAliasMatches, verbPageAnswersTo } from "./verb-name-match";
import { analyzeBytecodePurity, combineVerbPurity, compileVerb, propagateVerbPurity } from "./authoring";
import { hashSource, randomHex, constantTimeEqual } from "./source-hash";
import { SCHEDULE_CLOCK_INPUT, SCHEDULE_MAX_HORIZON_MS, SCHEDULE_MAX_PER_TURN, SCHEDULE_MIN_LEAD_MS } from "./scheduling";
import { parseRoutedApiKeyId, routedApiKeyId } from "./api-key-id";
import {
  ACCOUNT_REPAIR_MEMBER_LIMIT,
  planAccountStateRepair,
  summarizeAccountRepairPatches,
  type AccountRepairMember,
  type AccountRepairPlan,
  type AccountRepairResult
} from "./account-state-repair";
import {
  createV2TurnEffects,
  type TurnEffects,
  type ShadowStructuralCellKind,
  type PlanningWorldProvenance,
  type ActiveTurnRecorder,
  type RecordedCell,
  type RecordedWriteAuthority,
  type TurnRecorder,
  type TurnRecorderEvent,
  type TurnStart,
  type EffectTranscript,
  type TranscriptWrite,
  type TranscriptPropTarget,
  type ProjectionWrite
} from "./turn-effects";
import { readObjectPropertyValue } from "./property-read";
import { redactSensitiveSerializedPropertyValues } from "./sensitive-serialization";
import {
  ORDERED_EDGE_PROP,
  orderedEdgeFromPropertyValue,
  orderedNeighborsFromRows,
  orderedNeighborsQueryKey,
  orderedProjectionKey,
  type OrderedChildRow,
  type OrderedEdgeValue,
  type OrderedNeighborsQuery
} from "./ordered-edge";
import { REPLAY_PAGE_DEFAULT_LIMIT, replayPageQueryKey, validReplayPageBounds } from "./replay-page";

/** What a same-run ordered-edge writer's PRE-WRITE ordering membership was
 * (R1 overlay). `known: false` = the sparse planning world had no local value
 * for the child's edge, so the authority may hold a membership this slice
 * never saw — conservatively treated as affecting every parent's ordering. */
type PriorOrderingMembership =
  | { known: false }
  | { known: true; member: false }
  | { known: true; member: true; parent: string | null };

export type NativeHandler = (ctx: CallContext, args: WooValue[]) => WooValue | Promise<WooValue>;

/**
 * Control signals that must propagate to the gateway repair path and NEVER be
 * swallowed by an ordinary error catch (woocode `except` OR a native
 * handler-invoke try/catch). The VM enforces the same set for `except`; native
 * dispatch sites that catch handler errors (e.g. `invokeRecycleHandler`) must
 * re-throw these first. E_NEED_STATE = missing authority cell; the
 * ordered-children miss = missing owner projection (P1.2).
 */
function isUncatchableControlSignal(err: unknown): boolean {
  const code = isErrorValue(err) ? err.code : undefined;
  // E_NEED_ORDERED_NEIGHBORS is the bounded-slot variant of the
  // ordered-children miss (P2.4) — same repair path, same swallowing hazard.
  return code === "E_NEED_STATE" || code === "E_NEED_ORDERED_CHILDREN" || code === "E_NEED_ORDERED_NEIGHBORS";
}

const GUEST_SESSION_GRACE_MS = 60_000;
const GUEST_SESSION_TTL_MS = 5 * 60_000;
const CREDENTIAL_SESSION_GRACE_MS = 5 * 60_000;
const CREDENTIAL_SESSION_TTL_MS = 24 * 60 * 60_000;
const SUBSCRIBER_SCRUB_FLOOR_MS = 5_000;
// "Connected" for non-WebSocket sessions (REST, MCP) means "received input
// within this window". Past it, a stateless caller without a live socket
// reads as "sleeping" — same as a WS user whose connection has dropped.
const IDLE_PRESENCE_LIVE_WINDOW_MS = 5 * 60_000;
const IDLE_PRESENCE_IDLE_THRESHOLD_SECONDS = 60;

type ShadowGatewayApplyStats = {
  objects: number;
  properties: number;
  sessions: number;
  logs: number;
};

type ShadowGatewayApplyOptions = {
  skipObjectHost?: {
    hostKey: string;
    gatewayHost?: boolean;
  };
};

type ProjectionApplyOptions = {
  persist?: boolean;
  persistCreated?: boolean;
  transcript?: EffectTranscript;
  // When set, the cross-host move contents-projection repair (see
  // applyProjectionWrites) only touches/persists containers this host durably
  // owns (per the object route table). Object-row writes are already
  // host-partitioned by the caller; the transcript's moves are not, so this guard
  // keeps the move-membership repair from persisting a container a non-owner host
  // merely caches (which the durable repository rejects as "not hosted here").
  hostKey?: string;
  gatewayHost?: boolean;
};

export type DerivedContentsRepairResult = {
  inspected_containers: number;
  repaired_containers: ObjRef[];
  members_added: number;
  members_removed: number;
  missing_members_removed: number;
};

export type ShadowHostApplyResult = {
  ok: true;
  host: string;
  objects: number;
  properties: number;
  logs: number;
  sessions: number;
  creates: number;
  writes: number;
};

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
  skip_presence_check?: boolean;
  arg_spec?: Record<string, WooValue>;
};

type CommandPattern = {
  dobj?: WooValue;
  prep?: WooValue;
  iobj?: WooValue;
  args_from?: WooValue;
  parse?: WooValue;
};

type CommandPlan = {
  ok: true;
  route: "direct" | "sequenced";
  space: ObjRef | null;
  target: ObjRef;
  verb: string;
  args: WooValue[];
  cmd: CommandMap;
  persistence?: "durable" | "live";
};

const PASSWORD_PBKDF2_ITERATIONS = 600_000;
const PASSWORD_PBKDF2_KEY_BITS = 256;
const PROVISION_STATE_TTL_MS = 5 * 60_000;
const SIGNUP_INVITE_AUDIT_TTL_MS = 30 * 24 * 60 * 60_000;

export type SignupStartResult = {
  account: ObjRef;
  email: string;
  verification_token: string;
  verification_expires_at: number;
};

export type SignupVerifyResult = {
  account: ObjRef;
  actor: ObjRef;
  bearer: string;
  session: Session;
  promoted_guest: boolean;
};

export type PasswordAuthResult = {
  account: ObjRef;
  actor: ObjRef;
  bearer: string;
  session: Session;
};

export type HermesConnectResult = {
  actor_id: ObjRef;
  api_key: string;
  mcp_url: string;
  redirect_url: string;
  created: boolean;
};

type CommandOptions = {
  deferHostEffect?: (effect: DeferredHostEffect) => unknown;
};

type ObjectMatchOptions = {
  commandSurfaceOnly?: boolean;
};

type PublicCommandLocationOptions = {
  skipPresenceCheck?: boolean;
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
  /** Queue host-only work until the authoritative behavior result is ready.
   * Unlike deferHostEffect, these callbacks are never serialized into a turn
   * transcript: they notify local transports about an already-accepted fact. */
  deferPostAccept?(label: string, effect: () => void | Promise<void>): void;
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

// ExecutorContext: the environment an executor depends on while stepping a
// verb. Per spec/semantics/distribution.md §DT1, the world (executor) needs
// to read and write properties, look up object summaries, dispatch verbs,
// and so on. Some of those operations cross hosts in a distributed
// deployment; this interface is what the executor uses to reach across.
//
// The name was historically `HostBridge`, which read as "the world's bridge
// to the host" — that framing presupposed objects had owning hosts whose
// authority the executor needed to defer to. In the §DT1 model that
// authority belongs to the scope sequencer, not to any host; placement is
// a cache hint. The renamed `ExecutorContext` reflects that: this is the
// executor's view of its environment, not a bridge to anyone's authority.
export type ExecutorContext = {
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
  // owning each requested id for descriptors under the caller-selected
  // projection (`tools` or `obvious`), with optional space-content expansion.
  // Optional — hosts that don't run an MCP gateway can omit it.
  enumerateRemoteTools?(actor: ObjRef, requests: RemoteToolRequest[]): Promise<RemoteToolDescriptor[]>;
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
  // v2 shadow turn recorder. This travels with a call context so future
  // distributed executors can keep recording explicit without relying on global
  // world state.
  turnRecorder?: ActiveTurnRecorder | null;
};

export function createHostOperationMemo(turnRecorder?: ActiveTurnRecorder | null): HostOperationMemo {
  return { routes: new Map(), reads: new Map(), turnRecorder };
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
  roster: ScopedObjectSummary[];
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
    active_scope: ObjRef | null;
    /** Legacy alias for clients that have not migrated to `active_scope`. */
    current_location?: ObjRef | null;
    all_locations: ObjRef[];
  };
  here: RoomSnapshot | null;
  inventory: ScopedObjectSummary[];
  overlays?: Record<string, { subject: ObjRef; surface: string; restore?: boolean }>;
};

const DEFAULT_OBJECT_HOST = "world";

export type DirectCallOptions = {
  /** CO16.4 — present only on the scheduler's own dispatch path. Relaxes the
   * `direct_callable` ingress gate (a scheduled turn is not client ingress)
   * and presents `caller = $system` so a fired verb can tell it was woken. */
  scheduled?: { id: string; at: number; fired_at: number };
  forceDirect?: boolean;
  forceReason?: string;
  sessionId?: string | null;
  deferHostEffect?: (effect: DeferredHostEffect) => unknown;
  onSessionsEnded?: (sessions: Session[]) => void | Promise<void>;
};

type DirectDispatchFrameOptions = {
  /** CO16.4 scheduled dispatch; see DirectCallOptions. */
  scheduled?: { id: string; at: number; fired_at: number };
  startedAt: number;
  sessionId: string | null;
  audience: ObjRef | null;
  hostMemo: HostOperationMemo;
  initialObservations?: Observation[];
  deferHostEffect?: (effect: DeferredHostEffect) => unknown;
  onSessionsEnded?: (sessions: Session[]) => void | Promise<void>;
};

type AppliedCallOptions = {
  /** Proof-only reads/dispatch selected by a terminal direct wrapper. They are
   * injected into the target after its turn_start and before target behavior,
   * so validation sees the decisions which selected this command without a
   * second recorder envelope. */
  transferredProofEvents?: TurnRecorderEvent[];
};

type WooRepository = WorldRepository & Partial<ObjectRepository>;

type BehaviorUndoScope = {
  undos: Array<() => void>;
  /** Non-proof recorder vocabulary observed in this behavior. Kept as a
   * compact classifier rather than cloning every hot-path event. */
  terminalTransferDisallowedKinds: Set<TurnRecorderEvent["kind"]>;
  acceptance: Array<() => void>;
  objects: Set<ObjRef>;
  sessions: Set<string>;
  logs: Set<ObjRef>;
  tombstones: Set<ObjRef>;
  guestFreePool: Set<ObjRef>;
  snapshots: boolean;
  createdThisRun: Set<ObjRef>;
  orderedEdgeWritesThisRun: Set<ObjRef>;
  roomRosterProjections: Map<ObjRef, WooValue[] | undefined>;
  subscriberScrubAt: Map<ObjRef, number | undefined>;
  objectCounter: number;
  sessionCounter: number;
  persistence: PersistenceDirtyState;
};

type ObjectFlagPlan = {
  target: ObjRef;
  changes: Record<string, { from: boolean; to: boolean }>;
  reconcileAuthorSurface: boolean;
};

type PostAcceptEffect = {
  label: string;
  run: () => void | Promise<void>;
};

/**
 * Put a real Proxy in front of Map/Set subclasses. Overriding `.set()` and
 * `.add()` alone is bypassable with `Map.prototype.set.call(collection, ...)`;
 * a Proxy has no Map/Set internal slot, so those prototype calls are rejected.
 * Ordinary method access is rebound to the internal-slot-bearing target.
 */
function protectBehaviorCollection<T extends object>(
  target: T,
  assertMutation: () => void
): T {
  let proxy: T;
  proxy = new Proxy(target, {
    get: (inner, property) => {
      const value = Reflect.get(inner, property, inner);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, inner, args);
        return result === inner ? proxy : result;
      };
    },
    set: (inner, property, value) => {
      assertMutation();
      return Reflect.set(inner, property, value, inner);
    },
    deleteProperty: (inner, property) => {
      assertMutation();
      return Reflect.deleteProperty(inner, property);
    },
    defineProperty: (inner, property, descriptor) => {
      assertMutation();
      return Reflect.defineProperty(inner, property, descriptor);
    },
    setPrototypeOf: (inner, prototype) => {
      assertMutation();
      return Reflect.setPrototypeOf(inner, prototype);
    },
    preventExtensions: () => {
      assertMutation();
      return false;
    }
  });
  return proxy;
}

/**
 * Exact inverse-operation containers. Reads and scans are ordinary operations;
 * each mutation records only its own inverse, so abort restores the same live
 * container identity in reverse order and cost is proportional to writes.
 */
class BehaviorMutationMap<K, V> extends Map<K, V> {
  private readonly nodes = new Map<K, { key: K; prev: K | null; next: K | null }>();
  private head: K | null = null;
  private tail: K | null = null;

  constructor(
    private readonly beforeMutation: (undo: () => void, key?: K) => void,
    private readonly prepare: (value: V) => V = (value) => value,
    entries?: Iterable<readonly [K, V]>,
    private readonly assertMutation: (key?: K) => void = () => undefined
  ) {
    super();
    if (entries) this.initialize(entries);
    return protectBehaviorCollection(this, () => this.assertMutation());
  }

  /**
   * Populate without recording mutations. The behavior-value wrapper uses
   * this after registering an empty destination in its identity cache, so
   * self-referential/shared input graphs cannot recurse before the wrapper is
   * discoverable.
   */
  initialize(entries: Iterable<readonly [K, V]>): void {
    for (const [key, value] of entries) this.rawSet(key, value);
  }

  override get(key: K): V | undefined {
    const value = super.get(key);
    if (value === undefined && !super.has(key)) return undefined;
    const prepared = this.prepare(value as V);
    // Lazy wrapper installation is representation-only: it preserves the
    // logical value and must not enter the behavior undo log.
    if (prepared !== value) super.set(key, prepared);
    return prepared;
  }

  private rawSet(key: K, value: V): void {
    if (super.has(key)) {
      super.set(key, value);
      return;
    }
    super.set(key, value);
    const node = { key, prev: this.tail, next: null as K | null };
    if (this.tail !== null) this.nodes.get(this.tail)!.next = key;
    else this.head = key;
    this.tail = key;
    this.nodes.set(key, node);
  }

  private rawDelete(key: K): boolean {
    const node = this.nodes.get(key);
    if (!node) return false;
    if (node.prev !== null) this.nodes.get(node.prev)!.next = node.next;
    else this.head = node.next;
    if (node.next !== null) this.nodes.get(node.next)!.prev = node.prev;
    else this.tail = node.prev;
    this.nodes.delete(key);
    return super.delete(key);
  }

  private rawRestore(node: { key: K; prev: K | null; next: K | null }, value: V): void {
    if (super.has(node.key)) return;
    super.set(node.key, value);
    this.nodes.set(node.key, node);
    if (node.prev !== null) this.nodes.get(node.prev)!.next = node.key;
    else this.head = node.key;
    if (node.next !== null) this.nodes.get(node.next)!.prev = node.key;
    else this.tail = node.key;
  }

  private rawClear(): void {
    super.clear();
    this.nodes.clear();
    this.head = null;
    this.tail = null;
  }

  override set(key: K, value: V): this {
    this.assertMutation(key);
    // Detach the row shell synchronously. Descendants remain lazy, but a
    // caller retaining `value` can no longer mutate the authoritative row
    // through that alias after this method returns.
    const prepared = this.prepare(value);
    const present = super.has(key);
    const before = super.get(key);
    this.beforeMutation(() => {
      if (present) super.set(key, before as V);
      else this.rawDelete(key);
    }, key);
    // Supported ingress seams isolate caller-owned values before insertion.
    // Keep the stored row raw until first read so loading a large world does
    // not allocate wrappers for rows the turn never touches.
    this.rawSet(key, prepared);
    return this;
  }

  override delete(key: K): boolean {
    this.assertMutation(key);
    const node = this.nodes.get(key);
    if (!node) return false;
    const beforeNode = { ...node };
    const before = super.get(key);
    this.beforeMutation(() => {
      this.rawRestore(beforeNode, before as V);
    }, key);
    return this.rawDelete(key);
  }

  override clear(): void {
    // Refuse an unsupported raw bulk mutation before walking the container.
    // A permitted clear necessarily touches every member and may capture them.
    this.assertMutation();
    if (super.size === 0) return;
    const before = Array.from(this.entries());
    this.beforeMutation(() => {
      this.rawClear();
      for (const [key, value] of before) this.rawSet(key, value);
    });
    this.rawClear();
  }

  override *keys(): MapIterator<K> {
    let cursor = this.head;
    while (cursor !== null) {
      yield cursor;
      cursor = this.nodes.get(cursor)?.next ?? null;
    }
  }

  override *values(): MapIterator<V> {
    for (const key of this.keys()) yield this.get(key) as V;
  }

  override *entries(): MapIterator<[K, V]> {
    for (const key of this.keys()) yield [key, this.get(key) as V];
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  override forEach(
    callbackfn: (value: V, key: K, map: Map<K, V>) => void,
    thisArg?: unknown
  ): void {
    for (const [key, value] of this.entries()) callbackfn.call(thisArg, value, key, this);
  }
}

class BehaviorMutationSet<T> extends Set<T> {
  private readonly nodes = new Map<T, { value: T; prev: T | null; next: T | null }>();
  private head: T | null = null;
  private tail: T | null = null;

  constructor(
    private readonly beforeMutation: (undo: () => void, value?: T) => void,
    values?: Iterable<T>,
    private readonly assertMutation: (value?: T) => void = () => undefined,
    private readonly prepare: (value: T) => T = (value) => value
  ) {
    super();
    if (values) this.initialize(values);
    return protectBehaviorCollection(this, () => this.assertMutation());
  }

  initialize(values: Iterable<T>): void {
    for (const value of values) this.rawAppend(this.prepare(value));
  }

  private rawAppend(value: T): void {
    if (super.has(value)) return;
    super.add(value);
    const node = { value, prev: this.tail, next: null as T | null };
    if (this.tail !== null) this.nodes.get(this.tail)!.next = value;
    else this.head = value;
    this.tail = value;
    this.nodes.set(value, node);
  }

  private rawDelete(value: T): boolean {
    const node = this.nodes.get(value);
    if (!node) return false;
    if (node.prev !== null) this.nodes.get(node.prev)!.next = node.next;
    else this.head = node.next;
    if (node.next !== null) this.nodes.get(node.next)!.prev = node.prev;
    else this.tail = node.prev;
    this.nodes.delete(value);
    return super.delete(value);
  }

  private rawRestore(node: { value: T; prev: T | null; next: T | null }): void {
    if (super.has(node.value)) return;
    super.add(node.value);
    this.nodes.set(node.value, node);
    if (node.prev !== null) this.nodes.get(node.prev)!.next = node.value;
    else this.head = node.value;
    if (node.next !== null) this.nodes.get(node.next)!.prev = node.value;
    else this.tail = node.value;
  }

  override add(value: T): this {
    this.assertMutation(value);
    const prepared = this.prepare(value);
    const present = super.has(prepared);
    if (present) return this;
    this.beforeMutation(() => {
      this.rawDelete(prepared);
    }, prepared);
    this.rawAppend(prepared);
    return this;
  }

  override delete(value: T): boolean {
    this.assertMutation(value);
    const node = this.nodes.get(value);
    if (!node) return false;
    const before = { ...node };
    this.beforeMutation(() => {
      this.rawRestore(before);
    }, value);
    return this.rawDelete(value);
  }

  override clear(): void {
    // Validate before the O(n) preimage. Raw native clear is unsupported and
    // must fail in constant time; a permitted clear touches all n members.
    this.assertMutation();
    if (super.size === 0) return;
    const before = Array.from(this.values());
    this.beforeMutation(() => {
      this.rawClear();
      for (const value of before) this.rawAppend(value);
    });
    this.rawClear();
  }

  private rawClear(): void {
    super.clear();
    this.nodes.clear();
    this.head = null;
    this.tail = null;
  }

  override *values(): SetIterator<T> {
    let cursor = this.head;
    while (cursor !== null) {
      yield cursor;
      cursor = this.nodes.get(cursor)?.next ?? null;
    }
  }

  override keys(): SetIterator<T> {
    return this.values();
  }

  override *entries(): SetIterator<[T, T]> {
    for (const value of this.values()) yield [value, value];
  }

  override [Symbol.iterator](): SetIterator<T> {
    return this.values();
  }

  override forEach(
    callbackfn: (value: T, value2: T, set: Set<T>) => void,
    thisArg?: unknown
  ): void {
    for (const value of this.values()) callbackfn.call(thisArg, value, value, this);
  }
}

function behaviorMutationArray<T>(
  values: readonly T[],
  beforeMutation: (undo: () => void) => void,
  prepare: (value: T) => T = (value) => value,
  assertMutation: () => void = () => undefined,
  register?: (proxy: T[], target: T[]) => void
): T[] {
  const target: T[] = [];
  const truncatedDescriptors = (nextLength: unknown): Array<[string, PropertyDescriptor]> => {
    if (
      typeof nextLength !== "number" ||
      !Number.isInteger(nextLength) ||
      nextLength < 0 ||
      nextLength >= target.length
    ) return [];
    const deleted: Array<[string, PropertyDescriptor]> = [];
    for (const ownKey of Reflect.ownKeys(target)) {
      if (typeof ownKey !== "string") continue;
      const key = ownKey;
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) < nextLength) continue;
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor) deleted.push([key, descriptor]);
    }
    return deleted;
  };
  const restoreTruncated = (
    beforeLength: number,
    deleted: Array<[string, PropertyDescriptor]>
  ): void => {
    Reflect.set(target, "length", beforeLength);
    for (const [key, descriptor] of deleted) Reflect.defineProperty(target, key, descriptor);
  };
  const preparedAt = (property: PropertyKey): T | undefined => {
    if (typeof property !== "string" || !/^(0|[1-9]\d*)$/.test(property)) return undefined;
    const index = Number(property);
    if (!Number.isSafeInteger(index) || index >= target.length) return undefined;
    const value = target[index];
    const prepared = prepare(value);
    if (prepared !== value) target[index] = prepared;
    return prepared;
  };
  const proxy = new Proxy(target, {
    get: (target, property, receiver) => {
      const prepared = preparedAt(property);
      return prepared === undefined
        ? Reflect.get(target, property, receiver)
        : prepared;
    },
    getOwnPropertyDescriptor: (target, property) => {
      preparedAt(property);
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    set: (target, property, value) => {
      assertMutation();
      // Array rows are ownership boundaries too: prepare the inserted shell
      // now, while leaving its descendants lazy.
      const prepared = property === "length" ? value : prepare(value);
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      const beforeLength = target.length;
      const truncated = property === "length" ? truncatedDescriptors(prepared) : [];
      beforeMutation(() => {
        if (descriptor) Reflect.defineProperty(target, property, descriptor);
        else {
          Reflect.deleteProperty(target, property);
          // Defining a new numeric index extends an array before the engine's
          // separate length trap runs. Restore the old length as part of this
          // index inverse or abort leaves a sparse hole (`[null]` on export).
          Reflect.set(target, "length", beforeLength);
        }
        restoreTruncated(beforeLength, truncated);
      });
      return Reflect.set(target, property, prepared);
    },
    deleteProperty: (target, property) => {
      assertMutation();
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      beforeMutation(() => {
        if (descriptor) Reflect.defineProperty(target, property, descriptor);
      });
      return Reflect.deleteProperty(target, property);
    },
    defineProperty: (target, property, descriptor) => {
      assertMutation();
      const before = Reflect.getOwnPropertyDescriptor(target, property);
      const beforeLength = target.length;
      const truncated = property === "length" && "value" in descriptor
        ? truncatedDescriptors(descriptor.value)
        : [];
      beforeMutation(() => {
        if (before) Reflect.defineProperty(target, property, before);
        else Reflect.deleteProperty(target, property);
        restoreTruncated(beforeLength, truncated);
      });
      const prepared = "value" in descriptor && property !== "length"
        ? { ...descriptor, value: prepare(descriptor.value) }
        : descriptor;
      return Reflect.defineProperty(target, property, prepared);
    },
    setPrototypeOf: (target, prototype) => {
      assertMutation();
      const before = Reflect.getPrototypeOf(target);
      beforeMutation(() => {
        Reflect.setPrototypeOf(target, before);
      });
      return Reflect.setPrototypeOf(target, prototype);
    },
    preventExtensions: () => {
      assertMutation();
      return false;
    }
  });
  // Cache the empty wrapper before preparing members. This makes cycles
  // finite and preserves shared identity in the authoritative graph.
  register?.(proxy, target);
  for (const value of values) target.push(value);
  return proxy;
}

function behaviorMutationRecord<T extends object>(
  value: T,
  beforeMutation: (undo: () => void) => void,
  prepare: (value: unknown, property: PropertyKey) => unknown = (item) => item,
  assertMutation: () => void = () => undefined
): T {
  const preparedProperty = (target: T, property: PropertyKey): unknown => {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
    if (!descriptor || !("value" in descriptor)) return Reflect.get(target, property);
    const prepared = prepare(descriptor.value, property);
    if (prepared !== descriptor.value) {
      Reflect.defineProperty(target, property, { ...descriptor, value: prepared });
    }
    return prepared;
  };
  return new Proxy(value, {
    get: (target, property) => preparedProperty(target, property),
    getOwnPropertyDescriptor: (target, property) => {
      preparedProperty(target, property);
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    set: (target, property, next) => {
      assertMutation();
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      beforeMutation(() => {
        if (descriptor) Reflect.defineProperty(target, property, descriptor);
        else Reflect.deleteProperty(target, property);
      });
      return Reflect.set(target, property, prepare(next, property));
    },
    deleteProperty: (target, property) => {
      assertMutation();
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      beforeMutation(() => {
        if (descriptor) Reflect.defineProperty(target, property, descriptor);
      });
      return Reflect.deleteProperty(target, property);
    },
    defineProperty: (target, property, descriptor) => {
      assertMutation();
      const before = Reflect.getOwnPropertyDescriptor(target, property);
      beforeMutation(() => {
        if (before) Reflect.defineProperty(target, property, before);
        else Reflect.deleteProperty(target, property);
      });
      const prepared = "value" in descriptor
        ? { ...descriptor, value: prepare(descriptor.value, property) }
        : descriptor;
      return Reflect.defineProperty(target, property, prepared);
    },
    setPrototypeOf: (target, prototype) => {
      assertMutation();
      const before = Reflect.getPrototypeOf(target);
      beforeMutation(() => {
        Reflect.setPrototypeOf(target, before);
      });
      return Reflect.setPrototypeOf(target, prototype);
    },
    preventExtensions: () => {
      assertMutation();
      // Freezing/sealing is irreversible inside an inverse-operation journal.
      // Refuse before the target becomes non-extensible.
      return false;
    }
  });
}

type BehaviorValueContext = "generic" | "woo_object" | "verb_array" | "verb";

function behaviorMutationValue<T>(
  value: T,
  beforeMutation: (undo: () => void) => void,
  cache: WeakMap<object, unknown>,
  assertMutation: () => void = () => undefined,
  context: BehaviorValueContext = "generic"
): T {
  // Only values frozen through our recursive freezer are safe to share
  // without a mutation proxy. A caller can shallow-freeze a container while
  // leaving mutable children behind, so Object.isFrozen is not sufficient.
  if (value === null || typeof value !== "object" || isDeeplyFrozen(value)) return value;
  if (Object.isFrozen(value)) {
    // A shallow-frozen Woo map cannot be re-pointed at proxies for its mutable
    // children. Detach it from the caller and journal a mutable plain-data
    // clone instead; the original frozen wrapper is no longer authoritative.
    return behaviorMutationValue(
      cloneValue(value as unknown as WooValue) as unknown as T,
      beforeMutation,
      cache,
      assertMutation,
      context
    );
  }
  const cached = cache.get(value);
  if (cached) return cached as T;
  if (value instanceof Map) {
    const wrapped = new BehaviorMutationMap(
      beforeMutation,
      (item) => behaviorMutationValue(item, beforeMutation, cache, assertMutation),
      undefined,
      assertMutation
    );
    // Register before preparing entries: a Map can legally contain itself.
    cache.set(value, wrapped);
    cache.set(wrapped, wrapped);
    wrapped.initialize(value);
    return wrapped as T;
  }
  if (value instanceof Set) {
    const wrapped = new BehaviorMutationSet(
      beforeMutation,
      undefined,
      assertMutation,
      (item) => behaviorMutationValue(item, beforeMutation, cache, assertMutation)
    );
    cache.set(value, wrapped);
    cache.set(wrapped, wrapped);
    wrapped.initialize(value);
    return wrapped as T;
  }
  if (Array.isArray(value)) {
    return behaviorMutationArray(
      value,
      beforeMutation,
      (item) => behaviorMutationValue(
        item,
        beforeMutation,
        cache,
        assertMutation,
        context === "verb_array" ? "verb" : "generic"
      ),
      assertMutation,
      (wrapped, target) => {
        cache.set(value, wrapped);
        cache.set(target, wrapped);
        cache.set(wrapped, wrapped);
      }
    ) as unknown as T;
  }
  // Never rewrite the caller's record in place. Catalog manifests and import
  // payloads are commonly reused to build more than one world; installing
  // proxies into those inputs leaks callbacks from the first world and makes
  // every later world wrap a Proxy-of-Proxy. The eventual symptom is unbounded
  // JSProxy::GetOwnPropertyDescriptor recursion. A detached target also gives
  // us somewhere to register the wrapper before recursive descent.
  const source = value as Record<PropertyKey, unknown>;
  const prototype = Reflect.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("authoritative Woo data cannot contain a non-plain record");
  }
  const target = Object.create(prototype) as Record<PropertyKey, unknown>;
  const wrapped = behaviorMutationRecord(
    target,
    beforeMutation,
    (item, property) => context === "verb" && property === "bytecode"
      ? item
      : behaviorMutationValue(
        item,
        beforeMutation,
        cache,
        assertMutation,
        context === "woo_object" && property === "verbs" ? "verb_array" : "generic"
      ),
    assertMutation
  );
  cache.set(value, wrapped);
  cache.set(target, wrapped);
  cache.set(wrapped, wrapped);
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key === "symbol") {
      throw new TypeError("authoritative Woo data cannot contain symbol keys");
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    if (!("value" in descriptor)) {
      // Do not execute caller-owned accessors while importing authority.
      throw new TypeError("authoritative Woo data cannot contain accessors");
    }
    if (!descriptor.enumerable) {
      throw new TypeError("authoritative Woo data cannot contain non-enumerable fields");
    }
    // Nested containers are wrapped on first read. Ingress seams clone
    // caller-owned values before they reach this row, so retaining the raw
    // child here is safe and removes full-graph work from world construction.
    Reflect.defineProperty(target, key, {
      value: descriptor.value,
      writable: true,
      enumerable: true,
      configurable: true
    });
  }
  return wrapped as T;
}

type VerbEditorSession = {
  actor: ObjRef;
  target: ObjRef;
  kind: "verb";
  descriptor: WooValue;
  slot: number | null;
  /** How save/dry_run install the buffer. "upsert" replaces the OWN slot
   * that existed at open, CAS-guarded by expected_version. "define" is the
   * inherited-override / new-verb shape: no own slot existed at open, so
   * the install must still find it absent — mode "define"'s existence check
   * IS the optimistic guard (expected_version stays null; a version CAS
   * against an absent slot would always conflict, which is exactly the bug
   * that made every inherited-verb save fail E_VERSION). */
  install_mode: "upsert" | "define";
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
  dirtyTombstones: Set<ObjRef>;
  dirtySnapshots: Map<string, SpaceSnapshotRecord>;
  dirtyCounters: boolean;
  dirty: boolean;
};

const MAX_CALL_DEPTH = 128;

// Upper bound on $actor.focus_list — keeps the per-actor working set finite
// when an MCP client repeatedly focuses without unfocusing. Older entries are
// evicted FIFO once this cap is reached.
const ACTOR_FOCUS_LIST_CAP = 32;

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
  // The distribution-layer seam (Plan 002 Phase 1; spec/protocol/coherence.md).
  // All effect recording/versioning/apply operations go through this
  // interface; src/net/ supplies an alternative implementation later.
  private readonly effects: TurnEffects = createV2TurnEffects();
  private behaviorUndoScopes: BehaviorUndoScope[] = [];
  private lastBehaviorUndoStats: {
    objects: number;
    sessions: number;
    tombstones: number;
    guestPool: number;
    snapshots: number;
  } | null = null;
  private behaviorObjectProxies = new WeakMap<object, WooObject>();
  private behaviorSessionProxies = new WeakMap<object, Session>();
  private behaviorLogProxies = new WeakMap<object, SpaceLogEntry[]>();
  private behaviorSnapshotProxies = new WeakMap<object, SpaceSnapshotRecord>();
  private behaviorJournalRestoring = 0;
  private behaviorMutationPermit = 0;
  private behaviorJournalAccepting = 0;
  objects = new BehaviorMutationMap<ObjRef, WooObject>(
    (undo, id) => this.recordBehaviorUndo(undo, "objects", id),
    (object) => this.prepareBehaviorObject(object),
    undefined,
    (id) => this.assertBehaviorMutationPermitted("objects", id)
  );
  sessions = new BehaviorMutationMap<string, Session>(
    (undo, id) => this.recordBehaviorUndo(undo, "sessions", id),
    (session) => this.prepareBehaviorSession(session),
    undefined,
    (id) => this.assertBehaviorMutationPermitted("sessions", id)
  );
  logs = new BehaviorMutationMap<ObjRef, SpaceLogEntry[]>(
    (undo, id) => this.recordBehaviorUndo(undo, "logs", id),
    (entries) => this.prepareBehaviorLog(entries),
    undefined,
    (id) => this.assertBehaviorMutationPermitted("logs", id)
  );
  private snapshotRows: SpaceSnapshotRecord[] = behaviorMutationArray<SpaceSnapshotRecord>(
    [],
    (undo) => this.recordBehaviorUndo(undo, "snapshots"),
    (value) => this.prepareBehaviorSnapshot(value),
    () => this.assertBehaviorMutationPermitted("snapshots")
  );
  get snapshots(): SpaceSnapshotRecord[] {
    return this.snapshotRows;
  }
  set snapshots(rows: SpaceSnapshotRecord[]) {
    this.assertOutsideBehaviorMutation("snapshots replacement");
    const isolated = cloneImportedPlainData(rows);
    this.snapshotRows = behaviorMutationArray(
      isolated,
      (undo) => this.recordBehaviorUndo(undo, "snapshots"),
      (value) => this.prepareBehaviorSnapshot(value),
      () => this.assertBehaviorMutationPermitted("snapshots")
    );
  }
  private nativeHandlers = new Map<string, NativeHandler>();
  private idempotency = new Map<string, { at: number; frame: AppliedFrame | ErrorFrame }>();
  // A terminal direct wrapper disappears when it transfers into a sequenced
  // turn. Keep the accepted top-level outcome at the ingress boundary so an
  // exact retry never re-enters that now-state-dependent wrapper before
  // callNow's target-turn cache can answer. The binding includes the live
  // actor/session/frame tuple, while requestFingerprint prevents an unrelated
  // direct request which reused the frame id from reading this outcome.
  private terminalTransferIdempotency = new Map<string, {
    at: number;
    requestFingerprint: string;
    frame: AppliedFrame | ErrorFrame;
  }>();
  private objectCounter = 1;
  private sessionCounter = 1;
  private persistencePaused = 0;
  // Defers whole-world fallback saves while grouped in-memory mutations settle.
  // ObjectRepository-backed worlds persist each touched slice directly.
  private persistenceDeferred = 0;
  // A behavior savepoint may span awaits, so it cannot hold a synchronous
  // repository transaction open. While its surrounding call has persistence
  // paused, even persist(true) remains deferred until behavior acceptance.
  private behaviorSavepointDepth = 0;
  private persistenceDirty = false;
  private dirtyObjects = new Set<ObjRef>();
  private deletedObjects = new Set<ObjRef>();
  private dirtyProperties = new Map<ObjRef, Set<string>>();
  private dirtySessions = new Set<string>();
  private deletedSessions = new Set<string>();
  private dirtyTombstones = new Set<ObjRef>();
  private dirtySnapshots = new Map<string, SpaceSnapshotRecord>();
  private dirtyCounters = false;
  // Tombstoned ULIDs from `recycle()`. Distinct from `objects` having no row,
  // which can also mean "never existed". Per spec/semantics/recycle.md §RC3.9.
  tombstones = new BehaviorMutationSet<ObjRef>(
    (undo, id) => this.recordBehaviorUndo(undo, "tombstones", id),
    undefined,
    (id) => this.assertBehaviorMutationPermitted("tombstones", id)
  );
  // Invalidation token for externally visible state. It is bumped on every
  // path that could change `state(actor)` (object/property/session/task/counter
  // writes, deletes, accepted log rows). It may over-invalidate after rollback;
  // callers only depend on equality meaning "safe cache hit."
  private mutationCounter = 0;
  /** Per-host cache for buildHostSeedForDelivery. Keyed by host; valid
   * while `version === mutationCounter`. Any mutation invalidates all
   * entries (cheap: just a counter compare on lookup). */
  private hostSeedCache: Map<ObjRef, { version: number; seed: SeedWorld; digest: string }> = new Map();
  private callDepth = 0;
  private guestFreePool = new BehaviorMutationSet<ObjRef>(
    (undo, id) => this.recordBehaviorUndo(undo, "guestFreePool", id),
    undefined,
    (id) => this.assertBehaviorMutationPermitted("guestFreePool", id)
  );
  private objectRepository: ObjectRepository | null;
  private incrementalPersistenceEnabled = false;
  private executorContext: ExecutorContext | null;
  // One host runs one behavior at a time. Awaited cross-host RPC must not let a
  // second local behavior mutate the same in-memory state mid-savepoint.
  private hostQueue: Promise<unknown> = Promise.resolve();
  // Diagnostic instrumentation for the host-task queue. `currentHostTask`
  // tracks the task that's actively executing (between start and done) so a
  // newly-enqueued task can log who it's blocked behind. `hostTaskQueueDepth`
  // is the count of tasks waiting for the current to settle.
  private hostTaskCounter = 0;
  private currentHostTask: { id: number; label: string; startedAt: number; chainId: string } | null = null;
  private hostTaskQueueDepth = 0;
  // Counter feeding chain ids for tasks that originate on this host.
  // Combined with `chainOriginPrefix` to make chain ids globally unique
  // even across processes (so a chain id surfaced in headers is never
  // ambiguous with a same-numbered chain on a different host). Re-entrant
  // dispatch keys off chain id equality (see `hostDispatch`).
  private chainCounter = 0;
  private chainOriginPrefix: string | null = null;
  private metricsHook: ((event: MetricEvent) => void) | null = null;
  // O(1) presence lookup. `session_subscribers` is authoritative for live
  // sessions; `subscribers` remains a compatibility actor projection for
  // older persisted worlds only. Built lazily; kept in sync from setPropLocal
  // so writes through the verb path stay coherent.
  private subscribersIndex = new Map<ObjRef, Set<ObjRef>>();
  private actorPresenceIndex = new Map<ObjRef, Set<ObjRef>>();
  private sessionSubscribersIndex = new Map<ObjRef, Map<string, ObjRef>>();
  private sessionSpacesIndex = new Map<string, Set<ObjRef>>();
  private presenceIndexBuilt = false;
  // Placement index for the authoritative session table. Liveness is still
  // checked at read time; the index only avoids scanning every host session for
  // each room roster.
  private sessionActiveScopeIndex = new Map<ObjRef, Set<string>>();
  private sessionActiveScopeIndexBuilt = false;
  private lastSubscriberScrubAt = new Map<ObjRef, number>();

  private turnRecorder: TurnRecorder | null;
  private activeTurnRecorder: ActiveTurnRecorder | null = null;
  // VTN10.1: true while a sparse, guarded shadow executor is installed.
  // When true, an `object(id)` miss is treated as a *materialization* miss
  // rather than a semantic absence: before throwing E_OBJNF we emit a
  // lifecycle materialization probe for the absent id, which the guard
  // recorder rejects with E_NEED_STATE (the absent object's
  // `cell:lifecycle:<id>` atom is not in the allowed set), driving the
  // missing_state -> cell_pages -> retry repair loop. Authoritative
  // full-slice executors and plain diagnostic recorder runs leave this
  // false; a genuine miss still throws E_OBJNF there.
  // See spec/protocol/v2-turn-network.md §VTN10.1.
  private shadowExecutionGuardActive = false;
  private currentTurnWriter: RecordedWriteAuthority | null = null;
  /** Schedules armed by the turn in progress: the CO16.7 per-turn budget and
   * the derivation of turn-unique schedule ids. */
  private turnScheduleCount = 0;
  /** The turn's ONE scheduling clock reading, recorded under
   * SCHEDULE_CLOCK_INPUT. Every schedule armed by a turn is measured against
   * the same instant, so the committing scope has a single unambiguous value
   * to validate all of them against — with one reading per call the validator
   * could not tell which entry belonged to which reading, and any choice
   * (first/last/max) would misjudge some entry in a multi-schedule turn. */
  private turnScheduleClock: number | null = null;
  /** Unique-per-turn token for implicit schedule keys. Derived from the
   * recorded turn's id, which is unique per call — `seq` is NOT, because a
   * direct route always carries seq -1 and would collide across calls. */
  private turnScheduleToken = "";
  private logicalInputReplay: Map<string, WooValue[]> | null = null;
  // CA11.2 occupancy-transition: per-cell provenance for the ephemeral planning
  // world this WooWorld was built from. Only the sparse gateway planning path
  // supplies it (via setPlanningCellProvenance); authoritative/cold-load worlds
  // leave it null, so the movement-boundary check below is a no-op. It lets the
  // move code recognise a movement DESTINATION whose lineage was served by a
  // non-authoritative (projection/cache/...) topology pre-seed and force an
  // owner-authoritative repair before committing a move INTO it.
  private planningCellProvenance: PlanningWorldProvenance | null = null;
  // CA11.2: the movement-destination owner-repair is OPT-IN. Only a planning
  // path that has a force-owner repair mechanism (the MCP gateway, whose repair
  // pass issues a `missing_state_repair` authority refresh) enables it. Other
  // provenance-carrying paths — the browser holder and REST relay, which plan
  // optimistically against `cache` rows and reconcile by their own protocol —
  // attach provenance for the admission gate but MUST NOT have a move into a
  // derived row turned into a hard E_NEED_STATE they cannot repair. So the check
  // requires this flag in addition to non-authoritative provenance.
  private enforceMovementOwnerRepair = false;
  // Sparse MCP planning also needs an opt-in owner repair for room/container
  // contents used as a visibility or parser-resolution surface. Gateway
  // projection rows are allowed as a read cache, but a non-authoritative
  // `object_live` page must not be the final basis for "object is not here" or
  // for rendering a stale room. The gateway path has the same force-owner repair
  // loop as the movement check; other planning holders leave this off.
  private enforceResolutionOwnerRepair = false;
  /** Compact owner roster values exist only in an ephemeral planning world. */
  private readonly roomRosterProjections = new Map<ObjRef, WooValue[]>();
  // Net planning explicitly enables this invariant. Its materialized world is
  // sparse by construction, so a local fallback would be a plausible-looking
  // partial roster rather than a safe degradation.
  private requireRoomRosterProjection = false;
  /** Owner-computed ordered-children values (one bounded list per container + parent),
   * the ordering analogue of `roomRosterProjections`. Installed only in an
   * ephemeral planning world. Container is essential for ordering roots: two
   * independent roots both have `parent: null`. */
  private readonly orderedChildrenProjections = new Map<string, WooValue[]>();
  /** Owner-answered bounded neighbour queries (P2.4), keyed by the canonical
   * query key. A mutation's slot read resolves here so a wide parent never
   * pulls its full sibling list into planning; installed only in an
   * ephemeral planning world, exactly like the full-ordering projections. */
  private readonly orderedNeighborsProjections = new Map<string, WooValue>();
  /** Same-run ordered-edge mutations (R1): every child whose `__ordered_edge`
   * this execution wrote (or recycled away), with its pre-write membership.
   * The installed ordering projections are PRE-TURN authority snapshots, so a
   * second same-parent mutation in one turn must overlay these writes onto
   * any ordering answer — otherwise it reads a stale count/rank (losing a
   * restored child to a spurious E_INDEX, or reusing one cached append answer
   * for two inserts and committing duplicate ranks). Tracked only when
   * `requireOrderedChildrenProjection` is set (a sparse net planning world),
   * so a long-lived complete runtime — whose ordering reads scan live
   * objects and need no overlay — never accumulates entries. */
  private readonly orderedEdgeWritesThisRun = new Map<ObjRef, PriorOrderingMembership>();
  /** Objects created by THIS execution (same gating as above). A parent
   * created this run has no authority ordering to fetch — its children are
   * exactly this run's own edge writes, synthesized without any RPC. */
  private readonly createdThisRun = new Set<ObjRef>();
  // Net planning enables this so a sparse world FAILS LOUDLY rather than
  // deriving a partial ordering from whichever edge cells happened to
  // materialize (mirror of requireRoomRosterProjection). Guards BOTH
  // ordering reads: the full ordered_children projection and the bounded
  // ordered_neighbors query.
  private requireOrderedChildrenProjection = false;
  /** Owner-served committed replay pages (sequenced-log.md SL2/SL4), keyed
   * by the exact `(space, from, limit)` query — the log-read analogue of
   * the ordering projections above. Entries carry their SEMANTIC space
   * identity and the authority-minted `ts`; installed only in an ephemeral
   * planning world, never persisted or exported. */
  private readonly replayPageProjections = new Map<string, WooValue[]>();
  // Net planning enables this so a sparse world FAILS LOUDLY (repairable
  // E_NEED_REPLAY_PAGE) rather than answering a replay read from its
  // intentionally-absent local log tail — which would silently return []
  // and let a rebuild/journal verb conclude the log is empty.
  private requireReplayPageProjection = false;
  /** Net planning commits recorder cells rather than this ephemeral graph.
   * Keep authoring recording opt-in so the frozen v2 materializer is unchanged. */
  private recordAuthoringCellWrites = false;

  constructor(private repository?: WooRepository, options: { executorContext?: ExecutorContext | null; turnRecorder?: TurnRecorder | null } = {}) {
    this.objectRepository = isObjectRepository(repository) ? repository : null;
    this.executorContext = options.executorContext ?? null;
    this.turnRecorder = options.turnRecorder ?? null;
    this.registerNativeHandlers();
  }

  setTurnRecorder(recorder: TurnRecorder | null): void {
    this.assertOutsideBehaviorMutation("setTurnRecorder");
    this.turnRecorder = recorder;
  }

  installRoomRosterProjection(room: ObjRef, rows: readonly Record<string, unknown>[]): void {
    this.assertOutsideBehaviorMutation("installRoomRosterProjection");
    this.roomRosterProjections.set(room, cloneImportedPlainData(rows) as WooValue[]);
  }

  setRequireRoomRosterProjection(required: boolean): void {
    this.assertOutsideBehaviorMutation("setRequireRoomRosterProjection");
    this.requireRoomRosterProjection = required;
  }

  setRecordAuthoringCellWrites(enabled: boolean): void {
    this.assertOutsideBehaviorMutation("setRecordAuthoringCellWrites");
    this.recordAuthoringCellWrites = enabled;
  }

  roomRosterProjection(room: ObjRef): WooValue[] {
    const projected = this.roomRosterProjections.get(room);
    if (projected !== undefined) return cloneImportedPlainData(projected);

    if (this.requireRoomRosterProjection) {
      throw wooError("E_INTERNAL", `sparse planning room roster projection missing for ${room}`);
    }

    // Non-net runtimes own a complete local session table and do not install
    // transient projections. Preserve their established who semantics while
    // net planning always installs an explicit snapshot (including []).
    const now = this.logicalNow("room_roster.now");
    const roomName = this.objects.get(room)?.name ?? room;
    const roster = this.activeActorRosterStateIn(room, now);
    return roster.actors
      .filter((actor) => roster.visibleActors.has(actor))
      .map((actor) => {
        const stats = this.playerSessionStats(actor, now);
        const presence = stats.connected
          ? stats.idleSeconds !== null && stats.idleSeconds >= 60 ? "idle" : "awake"
          : "sleeping";
        return {
          player: actor,
          name: this.objects.get(actor)?.name ?? actor,
          connected: stats.connected,
          connected_at: stats.connectedAt,
          connected_seconds: stats.connectedSeconds,
          idle_seconds: stats.idleSeconds,
          last_login_at: stats.lastLoginAt,
          location: room,
          location_name: roomName,
          presence
        } as unknown as WooValue;
      });
  }

  /** Compute local active membership and social visibility in the same session
   * pass. Hidden service sessions remain active delivery carriers, while any
   * visible sibling session keeps the actor's deduplicated roster row visible. */
  private activeActorRosterStateIn(space: ObjRef, now: number): { actors: ObjRef[]; visibleActors: Set<ObjRef> } {
    const actors = new Set<ObjRef>();
    const visibleActors = new Set<ObjRef>();
    for (const session of this.sessions.values()) {
      if (session.activeScope !== space || this.sessionExpired(session, now)) continue;
      if (!this.objects.has(session.actor)) continue;
      actors.add(session.actor);
      if (session.rosterVisible !== false) visibleActors.add(session.actor);
    }
    const projected = this.presenceSessionsIn(space);
    if (projected) {
      const room = this.objects.get(space);
      for (const [sessionId, actor] of projected) {
        const session = this.sessions.get(sessionId);
        if (!session || session.actor !== actor || this.sessionExpired(session, now)) continue;
        if (!this.objects.has(actor) || !room?.contents.has(actor)) continue;
        actors.add(actor);
        if (session.rosterVisible !== false) visibleActors.add(actor);
      }
    }
    return { actors: Array.from(actors).sort(), visibleActors };
  }

  /** Apply a planned session transition to the transient owner snapshot so
   * move results describe post-turn presence. This mutates planning-only data;
   * the accepted relation remains the sole durable write path. */
  private applyTransientRoomRosterTransition(session: Session, from: ObjRef | null, to: ObjRef): void {
    // Hidden service sessions never contribute to the social projection. Do
    // not even remove the actor: a separate visible session may be the reason
    // the deduplicated actor row exists.
    if (session.rosterVisible === false) return;
    if (from) {
      const source = this.roomRosterProjections.get(from);
      if (source) {
        this.recordTransientRoomRosterPrior(from);
        this.roomRosterProjections.set(from, source.filter((value) =>
          !(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, WooValue>).player === session.actor)
        ));
      }
    }
    const destination = this.roomRosterProjections.get(to);
    if (destination === undefined) return;
    this.recordTransientRoomRosterPrior(to);
    const withoutActor = destination.filter((value) =>
      !(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, WooValue>).player === session.actor)
    );
    const actorName = this.objects.get(session.actor)?.name ?? session.actor;
    const now = this.logicalNow("room_roster.transition");
    const started = session.started ?? now;
    const roomName = this.objects.get(to)?.name ?? to;
    this.roomRosterProjections.set(to, [...withoutActor, {
      player: session.actor,
      name: actorName,
      connected: true,
      connected_at: started,
      connected_seconds: Math.max(0, Math.floor((now - started) / 1000)),
      idle_seconds: 0,
      last_login_at: started,
      location: to,
      location_name: roomName,
      presence: "awake"
    } as unknown as WooValue]);
  }

  /** Capture the first pre-scope row for a planning-only roster projection.
   * Replacement is O(1): transition code never mutates the old array in place,
   * so the exact prior reference remains a safe inverse until commit/abort. */
  private recordTransientRoomRosterPrior(room: ObjRef): void {
    const scope = this.behaviorUndoScopes.at(-1);
    if (!scope || scope.roomRosterProjections.has(room)) return;
    scope.roomRosterProjections.set(room, this.roomRosterProjections.get(room));
  }

  // ── Owner-computed ordered-children projection ─────────────────────────
  // The ordering analogue of the room roster: net planning fetches the
  // bounded ordered list of a parent's children from the room authority and
  // installs it here, so a verb reads sibling order as ONE value instead of
  // pulling every sibling's edge cell into the turn's read closure. Only the
  // ephemeral planning world holds these; they never persist or export.

  installOrderedChildrenProjection(container: ObjRef, parent: ObjRef | null, rows: readonly Record<string, unknown>[]): void {
    this.assertOutsideBehaviorMutation("installOrderedChildrenProjection");
    this.orderedChildrenProjections.set(
      orderedProjectionKey(container, parent),
      cloneImportedPlainData(rows) as WooValue[]
    );
  }

  setRequireOrderedChildrenProjection(required: boolean): void {
    this.assertOutsideBehaviorMutation("setRequireOrderedChildrenProjection");
    this.requireOrderedChildrenProjection = required;
  }

  /** The ordered `[{child, rank}]` list of `parent`'s direct children. On a
   * sparse net planning world the owner projection MUST have been installed;
   * a MISSING one is a REPAIRABLE miss, not terminal: the gateway does not
   * know ahead of time which parents a data-dependent verb will read (an
   * add_item into a nested parent_arg, a reparent to an arbitrary sub-item),
   * so it seeds only the call target's ordering up front. Reading any other
   * parent throws `E_NEED_ORDERED_CHILDREN` naming that parent; the gateway's
   * repair loop fetches that parent's projection (POST /net/ordered-children)
   * and re-plans, exactly as a missing-cell read triggers a targeted refresh.
   * A genuinely malformed parent argument is caught earlier by the builtin's
   * `assertObj` (terminal E_TYPE/E_INVARG) and never reaches this getter. A
   * complete local runtime (in-memory / SQLite dev) has no require flag and
   * derives the ordering by scanning objects' local edge property — the
   * ordering analogue of `roomRosterProjection`'s local-session fallback. */
  orderedChildrenProjection(parent: ObjRef | null, container: ObjRef | null = null): WooValue[] {
    const projectionKey = container === null ? null : orderedProjectionKey(container, parent);
    const projected = projectionKey === null ? undefined : this.orderedChildrenProjections.get(projectionKey);
    if (projected !== undefined) {
      // R1: the installed rows are a PRE-TURN authority snapshot; overlay
      // this run's own edge writes when any touch this parent's ordering.
      return this.orderingAffectedThisRun(container, parent)
        ? this.overlaySameRunEdges(projected as unknown as readonly Record<string, unknown>[], container, parent)
        : cloneImportedPlainData(projected);
    }

    if (this.requireOrderedChildrenProjection) {
      // A parent created THIS run has no authority ordering to fetch — its
      // children are exactly this run's own edge writes (R1).
      if (parent !== null && this.createdThisRun.has(parent)) {
        return this.overlaySameRunEdges([], container, parent);
      }
      // The parent rides in `value` so the planner/gateway can name exactly
      // which projection to fetch. Distinct code (not E_NEED_STATE) so it
      // routes through the ordered-children repair path, not the cell-pull path.
      throw wooError(
        "E_NEED_ORDERED_CHILDREN",
        `ordered-children projection not resident for ${parent ?? "<root>"}`,
        { container, parent }
      );
    }

    // Local fallback: scan every object's LOCAL edge property. Edges are a
    // per-item local value, so an inherited class default never participates.
    // `container` scopes ordering ROOTS to one room (the net path scope-fetches
    // one room's edges; the whole-world scan must not mix roots across rooms).
    // For a non-null parent the children are inherently in the parent's room,
    // so the container filter is a no-op there.
    const rows: OrderedChildRow[] = [];
    for (const obj of this.objects.values()) {
      const raw = obj.properties.get(ORDERED_EDGE_PROP) as OrderedEdgeValue | undefined;
      if (!raw || typeof raw !== "object") continue;
      const rank = (raw as OrderedEdgeValue).rank;
      const edgeParent = (raw as OrderedEdgeValue).parent ?? null;
      if (typeof rank !== "string" || rank.length === 0) continue;
      if (edgeParent !== parent) continue;
      if (container !== null && obj.location !== container) continue;
      rows.push({ child: obj.id, rank });
    }
    rows.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.child < b.child ? -1 : a.child > b.child ? 1 : 0));
    return rows as unknown as WooValue[];
  }

  installOrderedNeighborsProjection(container: ObjRef, query: OrderedNeighborsQuery, value: Record<string, unknown>): void {
    this.assertOutsideBehaviorMutation("installOrderedNeighborsProjection");
    this.orderedNeighborsProjections.set(
      orderedNeighborsQueryKey(container, query),
      cloneImportedPlainData(value) as WooValue
    );
  }

  /** Install one owner-served committed replay page for the EXACT
   * `(space, from, limit)` query (sequenced-log.md SL4). `space` is the
   * SEMANTIC space id; `entries` are the authority's committed log rows in
   * the native replay shape (`{seq, ts, actor, message, observations,
   * applied_ok, error?}`). Planning-only, like the ordering projections. */
  installReplayPageProjection(space: ObjRef, from: number, limit: number, entries: readonly Record<string, unknown>[]): void {
    this.assertOutsideBehaviorMutation("installReplayPageProjection");
    this.replayPageProjections.set(
      replayPageQueryKey({ space, from, limit }),
      cloneImportedPlainData(entries) as WooValue[]
    );
  }

  setRequireReplayPageProjection(required: boolean): void {
    this.assertOutsideBehaviorMutation("setRequireReplayPageProjection");
    this.requireReplayPageProjection = required;
  }

  /** The committed log page a `replay(from, limit)` read resolves to. On a
   * sparse net planning world the exact owner page MUST have been installed;
   * a missing one is a REPAIRABLE miss (`E_NEED_REPLAY_PAGE` naming the full
   * query), which the gateway answers with one authority fetch
   * (POST /net/replay-page) and a re-plan — exactly the ordered-children
   * repair shape. The code is on the VM's uncatchable list so a woocode
   * `try { space:replay(...) } except` cannot swallow the miss into a
   * silently-empty journal. A complete local runtime answers from its own
   * durable log (`this.replay`), so both lanes return the same shape. */
  private replayPageForVm(space: ObjRef, from: number, limit: number): SpaceLogEntry[] {
    const projected = this.replayPageProjections.get(replayPageQueryKey({ space, from, limit }));
    if (projected !== undefined) return cloneImportedPlainData(projected) as unknown as SpaceLogEntry[];
    if (this.requireReplayPageProjection) {
      throw wooError(
        "E_NEED_REPLAY_PAGE",
        `sparse planning replay page not resident for ${space} from ${from} limit ${limit}`,
        { space, from, limit } as unknown as WooValue
      );
    }
    return this.replay(space, from, limit);
  }

  /** The bounded `{count, index, before, after, child_index}` answer for one
   * mutation slot under `parent` (P2.4 — the O(1) alternative to reading the
   * parent's full ordered children). Resolution order on a sparse net
   * planning world:
   *   1. the exact installed query answer (a prior repair round fetched it);
   *   2. a resident FULL ordering for the parent (free ride — same authority
   *      version, so the attestation is identical);
   *   3. otherwise a repairable `E_NEED_ORDERED_NEIGHBORS` naming the full
   *      query, which the gateway answers with ONE O(1) authority fetch
   *      (POST /net/ordered-neighbors) — never the O(width) list.
   * A complete local runtime computes the answer from its own edge scan via
   * the shared `orderedNeighborsFromRows`, so both paths clamp and exclude
   * identically. */
  orderedNeighborsProjection(
    parent: ObjRef | null,
    query: Pick<OrderedNeighborsQuery, "index" | "exclude" | "child">,
    container: ObjRef | null = null
  ): WooValue {
    // R1: once this run's own edge writes touch the parent's ordering, every
    // pre-turn O(1) answer for it is stale — resolve via the FULL ordering
    // (installed + overlay, created-run synthesis, or the ordered-children
    // escalation miss) so this turn's writes participate in the slot answer.
    if (this.orderingAffectedThisRun(container, parent)) {
      const rows = this.orderedChildrenProjection(parent, container) as unknown as OrderedChildRow[];
      return orderedNeighborsFromRows(rows, query) as unknown as WooValue;
    }

    const full: OrderedNeighborsQuery = { parent, index: query.index, exclude: query.exclude, child: query.child };
    const installed = container === null ? undefined : this.orderedNeighborsProjections.get(orderedNeighborsQueryKey(container, full));
    if (installed !== undefined) return cloneImportedPlainData(installed);

    const residentOrdering = container === null ? undefined : this.orderedChildrenProjections.get(orderedProjectionKey(container, parent));
    if (residentOrdering !== undefined) {
      return orderedNeighborsFromRows(residentOrdering as unknown as OrderedChildRow[], query) as unknown as WooValue;
    }

    if (this.requireOrderedChildrenProjection) {
      // The whole query rides in `value` so the planner/gateway can fetch
      // exactly this answer. Distinct code so it routes through the
      // ordered-neighbours repair path, not the cell-pull path.
      throw wooError(
        "E_NEED_ORDERED_NEIGHBORS",
        `ordered-neighbours answer not resident for ${parent ?? "<root>"}`,
        { container, parent, index: query.index, exclude: query.exclude, child: query.child }
      );
    }

    // Local fallback: the same edge scan the full ordering uses, reduced by
    // the shared helper so local and owner answers agree byte-for-byte.
    const rows = this.orderedChildrenProjection(parent, container) as unknown as OrderedChildRow[];
    return orderedNeighborsFromRows(rows, query) as unknown as WooValue;
  }

  /** The pre-write ordering membership recorded for a same-run edge writer
   * (R1). A child created this run is known-empty; a resident local value
   * decides membership; an absent local value on a sparse world is UNKNOWN
   * (the authority may hold an edge this slice never saw). */
  private priorOrderingMembership(objRef: ObjRef, hadValue: boolean, before: WooValue | undefined): PriorOrderingMembership {
    if (this.createdThisRun.has(objRef)) return { known: true, member: false };
    if (hadValue) {
      const edge = orderedEdgeFromPropertyValue(before);
      return edge ? { known: true, member: true, parent: edge.parent } : { known: true, member: false };
    }
    return { known: false };
  }

  private noteCreatedThisRun(objRef: ObjRef): void {
    if (this.createdThisRun.has(objRef)) return;
    this.createdThisRun.add(objRef);
    this.behaviorUndoScopes.at(-1)?.createdThisRun.add(objRef);
  }

  private noteOrderedEdgeWriteThisRun(objRef: ObjRef, prior: PriorOrderingMembership): void {
    if (this.orderedEdgeWritesThisRun.has(objRef)) return;
    this.orderedEdgeWritesThisRun.set(objRef, prior);
    this.behaviorUndoScopes.at(-1)?.orderedEdgeWritesThisRun.add(objRef);
  }

  /** A same-run edge writer's CURRENT edge, or null when the child is
   * recycled/absent or its edge is cleared/malformed. */
  private currentOrderedEdge(child: ObjRef): OrderedEdgeValue | null {
    if (this.isRecycled(child)) return null;
    const obj = this.objects.get(child);
    if (!obj) return null;
    return orderedEdgeFromPropertyValue(obj.properties.get(ORDERED_EDGE_PROP));
  }

  /** Whether THIS run's edge writes touch `parent`'s ordering (R1): some
   * writer now lives under it, previously lived under it, has an unknown
   * pre-state, or the parent itself was created this run (its authority
   * ordering cannot exist, so only same-run writes can populate it). */
  private orderingAffectedThisRun(container: ObjRef | null, parent: ObjRef | null): boolean {
    if (parent !== null && this.createdThisRun.has(parent)) return true;
    if (this.orderedEdgeWritesThisRun.size === 0) return false;
    for (const [child, prior] of this.orderedEdgeWritesThisRun) {
      const current = this.currentOrderedEdge(child);
      if (current && current.parent === parent && (container === null || this.objects.get(child)?.location === container)) return true;
      if (!prior.known) return true;
      if (prior.known && prior.member && prior.parent === parent) return true;
    }
    return false;
  }

  /** Overlay this run's edge writes onto a pre-turn ordering snapshot (R1):
   * drop every same-run writer from the authority rows, add back those whose
   * CURRENT edge lives under `parent`, and re-sort with the shared
   * (rank, child) comparator so the answer matches what the authority will
   * derive after this turn's transcript applies. */
  private overlaySameRunEdges(rows: readonly Record<string, unknown>[], container: ObjRef | null, parent: ObjRef | null): WooValue[] {
    const out: { child: string; rank: string }[] = [];
    for (const row of rows) {
      const child = (row as { child?: unknown }).child;
      if (typeof child === "string" && this.orderedEdgeWritesThisRun.has(child)) continue;
      out.push({ child: String(child), rank: String((row as { rank?: unknown }).rank ?? "") });
    }
    for (const child of this.orderedEdgeWritesThisRun.keys()) {
      const current = this.currentOrderedEdge(child);
      if (current && current.parent === parent && (container === null || this.objects.get(child)?.location === container)) {
        out.push({ child, rank: current.rank });
      }
    }
    out.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.child < b.child ? -1 : a.child > b.child ? 1 : 0));
    return out as unknown as WooValue[];
  }

  // CA11.2: attach the planning world's per-cell provenance so the
  // movement-boundary check in movetoActorChecked can tell whether a movement
  // destination's lineage was admitted from an owner-authoritative row or from
  // a non-authoritative topology pre-seed (projection/cache/fallback/gossip).
  // Only the sparse gateway planning path supplies this; everything else leaves
  // it null and the destination check is skipped.
  setPlanningCellProvenance(provenance: PlanningWorldProvenance | null): void {
    this.assertOutsideBehaviorMutation("setPlanningCellProvenance");
    this.planningCellProvenance = provenance;
  }

  // CA11.2: enable the opt-in movement-destination owner-repair check (gateway
  // path only — see `enforceMovementOwnerRepair`).
  setEnforceMovementOwnerRepair(enforce: boolean): void {
    this.assertOutsideBehaviorMutation("setEnforceMovementOwnerRepair");
    this.enforceMovementOwnerRepair = enforce;
  }

  // Enable the sparse-gateway contents-read repair check. Kept separate from
  // movement repair because command matching can fail before a move is attempted.
  setEnforceResolutionOwnerRepair(enforce: boolean): void {
    this.assertOutsideBehaviorMutation("setEnforceResolutionOwnerRepair");
    this.enforceResolutionOwnerRepair = enforce;
  }

  private assertResolutionContentsOwnerAuthority(container: ObjRef, surface: "contents" | "match" | "visible_contents"): void {
    if (!this.enforceResolutionOwnerRepair) return;
    const provenance = this.planningCellProvenance;
    if (!provenance || !this.objects.has(container)) return;
    const liveProv = provenance.get(this.effects.planningCellKey(container, "object_live"));
    // Owner slices served over /__internal/authority-slice stamp both
    // source:"authoritative" and source_host. A missing source_host on a sparse
    // MCP planning cell is legacy/local provenance and must not be trusted for
    // room membership decisions.
    if (liveProv?.source === "authoritative" && typeof liveProv.source_host === "string" && liveProv.source_host.length > 0) return;
    const preimage = `read:cell:contents:${container}`;
    throw wooError("E_NEED_STATE", `${surface} needs owner-authoritative contents for ${container}`, {
      missing_atoms: [{ hash: this.effects.shadowAtomHash(preimage), preimage }]
    });
  }

  /**
   * Toggle the sparse-shadow-execution guard (VTN10.1). The
   * shadow-turn-call entry point sets this true only when running with an
   * allowed-atom-hash set (guarded mode), and clears it in a finally so
   * it never leaks into a subsequent authoritative run on the same world.
   * See spec/protocol/v2-turn-network.md §VTN10.1.
   */
  setShadowExecutionGuard(active: boolean): void {
    this.assertOutsideBehaviorMutation("setShadowExecutionGuard");
    this.shadowExecutionGuardActive = active;
  }

  /**
   * VTN10.1: run a sequenced-call PREAMBLE step under the
   * materialization guard. The preamble (space lookup, verb resolution,
   * presence authorization, sequencer read) runs BEFORE `withTurnRecording`
   * opens the recorder, so the `object(id)` probe path cannot fire there —
   * `activeTurnRecorder` is still null. A sparse guarded executor whose slice
   * is missing an object needed in the preamble would therefore throw raw
   * `E_OBJNF` with no transcript and no repair.
   *
   * Rather than open recording around the preamble (which would add the
   * preamble's reads to the committed transcript's read-set and change the
   * normal full-state path), we narrowly translate a preamble `E_OBJNF` into
   * the same `E_NEED_STATE` the in-run probe would have produced: a single
   * missing `lifecycle:<id>` atom for the absent id. The repair loop then
   * pages that object in and re-runs the whole turn. Gated entirely on the
   * guard flag, so the authoritative/normal path is byte-for-byte unchanged.
   * See spec/protocol/v2-turn-network.md §VTN10.1.
   */
  private guardedPreamble<T>(fn: () => T): T {
    if (!this.shadowExecutionGuardActive) return fn();
    try {
      return fn();
    } catch (err) {
      const error = err as { code?: string; value?: unknown };
      if (error?.code === "E_OBJNF" && typeof error.value === "string") {
        const id = error.value;
        const preimage = `read:cell:lifecycle:${id}`;
        throw wooError("E_NEED_STATE", "shadow turn preamble touched unmaterialized object", {
          missing_atoms: [{ hash: this.effects.shadowAtomHash(preimage), preimage }]
        });
      }
      throw err;
    }
  }

  private async withTurnRecording<T>(turn: TurnStart, fn: (active: ActiveTurnRecorder) => Promise<T>): Promise<T> {
    const recorder = this.turnRecorder;
    if (!recorder) {
      // Scheduling identity/budget is turn state even when no diagnostic
      // recorder is installed. Bypassing this reset made ordinary direct calls
      // share one lifetime budget and clock, eventually failing the 33rd
      // scheduled call with E_QUOTA while recorder-enabled Net planning worked.
      const previousScheduleCount = this.turnScheduleCount;
      const previousScheduleClock = this.turnScheduleClock;
      const previousScheduleToken = this.turnScheduleToken;
      this.turnScheduleCount = 0;
      this.turnScheduleClock = null;
      this.turnScheduleToken = turn.id
        ?? hashSource(`${turn.scope}:${turn.seq}:${turn.actor}:${turn.target}:${turn.verb}:${JSON.stringify(turn.args ?? [])}`);
      try {
        return await fn(this.activeTurnRecorder ?? {
          event: () => undefined,
          beginBehaviorScope: () => undefined,
          commitBehaviorScope: () => undefined,
          abortBehaviorScope: () => undefined,
          currentBehaviorEvents: () => [],
          discardTurn: () => undefined
        });
      } finally {
        this.turnScheduleCount = previousScheduleCount;
        this.turnScheduleClock = previousScheduleClock;
        this.turnScheduleToken = previousScheduleToken;
      }
    }
    const previous = this.activeTurnRecorder;
    const previousWriter = this.currentTurnWriter;
    const active = recorder.startTurn(turn);
    const previousScheduleCount = this.turnScheduleCount;
    const previousScheduleClock = this.turnScheduleClock;
    const previousScheduleToken = this.turnScheduleToken;
    this.activeTurnRecorder = active;
    this.currentTurnWriter = null;
    // Per-turn schedule budget, clock, and id token all reset here, so a
    // nested recorded turn cannot inherit any of them (CO16.7).
    this.turnScheduleCount = 0;
    this.turnScheduleClock = null;
    // Turn identity, deterministic across re-plans of the SAME turn (so a
    // retried turn upserts its own entry rather than arming a second one) and
    // distinct between different turns. `seq` alone is not enough: the direct
    // route always carries -1.
    this.turnScheduleToken = turn.id
      ?? hashSource(`${turn.scope}:${turn.seq}:${turn.actor}:${turn.target}:${turn.verb}:${JSON.stringify(turn.args ?? [])}`);
    try {
      const result = await fn(active);
      active.event({ kind: "turn_finish", ok: true, result: result as WooValue });
      return result;
    } catch (err) {
      if (isCommandPlanTransfer(err)) {
        // The outer direct wrapper is provisional. Its behavior scope has
        // already rolled back while unwinding here; remove the recorder shell
        // without manufacturing a failed turn, then let directCallNow install
        // the target as the sole effective turn.
        active.discardTurn();
        throw err;
      }
      const error = normalizeError(err);
      // A sequenced error is an envelope outcome, not a behavior observation.
      // Record it only after the behavior scope has aborted so it survives
      // beside the pre-scope sequence allocation while every pre-error
      // observation is discarded.
      if (turn.route === "sequenced") {
        active.event({
          kind: "observe",
          observation: {
            type: "$error",
            code: error.code,
            message: error.message ?? error.code,
            value: error.value ?? null,
            trace: error.trace ?? []
          }
        });
      }
      active.event({ kind: "turn_finish", ok: false, error });
      throw err;
    } finally {
      this.activeTurnRecorder = previous;
      this.currentTurnWriter = previousWriter;
      this.turnScheduleCount = previousScheduleCount;
      this.turnScheduleClock = previousScheduleClock;
      this.turnScheduleToken = previousScheduleToken;
    }
  }

  /** Record the sequenced-call seq allocation as ordinary transcript
   * read/write events. The preamble reads and increments the space's
   * `next_seq` BEFORE `withTurnRecording` opens the recorder (VTN10.1 —
   * a preamble miss must not fire the in-run lifecycle probe), so without
   * this a net-planned sequenced transcript carried NO trace of the
   * allocation: the authority's `next_seq` cell never advanced and every
   * planned turn re-allocated seq 1, breaking the committed log's seq
   * identity (sequenced-log.md SL1: `append` is the only blessed
   * increment). Recording it as a normal read+write makes the allocation
   * an authority-cell fact — the committing scope validates the read
   * (serializing concurrent allocations exactly like the local lane's
   * atomic append) and applies the write, and the entry's `seq` is then
   * honest on every lane. No-op when no recorder is active (the ordinary
   * local path), so local behavior is unchanged. */
  private recordSequencedAllocation(spaceRef: ObjRef, seq: number, actor: ObjRef): void {
    if (!this.activeTurnRecorder) return;
    const afterVersion = this.propertyVersionForRecording(spaceRef, "next_seq");
    const beforeVersion = typeof afterVersion === "number" ? afterVersion - 1 : afterVersion;
    this.recordTurnEvent({ kind: "prop_read", object: spaceRef, name: "next_seq", value: seq, ...(beforeVersion !== undefined ? { version: beforeVersion } : {}) });
    this.recordTurnEvent({
      kind: "prop_write",
      object: spaceRef,
      name: "next_seq",
      hadValue: true,
      before: seq,
      after: seq + 1,
      changed: true,
      ...(beforeVersion !== undefined ? { beforeVersion } : {}),
      ...(afterVersion !== undefined ? { afterVersion } : {}),
      // The allocation is the sequencer's own act, not any verb frame's:
      // name the space's call machinery as the recording authority (the
      // sessionWriter precedent for engine-folded writes).
      writer: { progr: actor, thisObj: spaceRef, verb: "call", definer: spaceRef, caller: "#-1", callerPerms: actor }
    });
  }

  /**
   * CO16 / scheduling.md — arm a scheduled turn. The whole effect is one
   * recorded transcript entry: nothing is written now, no task is created,
   * and nothing has happened at all until the turn commits.
   *
   * The delivery time is derived from `logicalNow()`, the same recorded and
   * replayed logical input `now()` returns, so the planner and the committing
   * scope compute the same instant and a replay reproduces it.
   */
  recordScheduleRequest(
    ctx: CallContext,
    target: ObjRef,
    verbName: string,
    args: WooValue[],
    when: { delayMs?: number; atMs?: number },
    opts: { key?: string; idlePolicy?: "while_active" | "always" } = {}
  ): string {
    assertObj(target);
    const relative = when.delayMs;
    const absolute = when.atMs;
    if (relative === undefined && absolute === undefined) throw wooError("E_INVARG", "schedule needs a delay or a time");
    if (relative !== undefined && !Number.isFinite(relative)) throw wooError("E_TYPE", "schedule delay must be numeric", relative);
    if (absolute !== undefined && !Number.isFinite(absolute)) throw wooError("E_TYPE", "schedule time must be numeric", absolute);
    const idlePolicy = opts.idlePolicy ?? "while_active";
    if (idlePolicy !== "while_active" && idlePolicy !== "always") {
      throw wooError("E_INVARG", `unknown idle_policy ${String(idlePolicy)}`, idlePolicy);
    }
    // CO16.6: `always` is the shape that runs unattended and bills a world
    // forever. Refused here for a useful author-facing error; the scope
    // re-checks against provenance because it does not trust the planner.
    if (idlePolicy === "always" && !this.isWizard(ctx.progr)) {
      throw wooError("E_PERM", "arming an idle_policy \"always\" schedule requires wizard authority", { progr: ctx.progr });
    }
    if (this.turnScheduleCount >= SCHEDULE_MAX_PER_TURN) {
      throw wooError("E_QUOTA", `a turn may arm at most ${SCHEDULE_MAX_PER_TURN} schedules`, {
        quota: "schedules_per_turn",
        current: this.turnScheduleCount,
        limit: SCHEDULE_MAX_PER_TURN
      });
    }

    // One reading per turn, recorded under the name the scope validates
    // against. Reading per call would put several clock inputs in the
    // transcript with no way to say which schedule each belonged to.
    if (this.turnScheduleClock === null) this.turnScheduleClock = this.logicalNow(SCHEDULE_CLOCK_INPUT);
    const now = this.turnScheduleClock;
    // The floor CLAMPS rather than failing (SC3): a v1 author's `fork(1, ...)`
    // reflex becomes a minute, not an error. The horizon does fail — a time a
    // year out is a mistake, not a rounding.
    const requested = relative !== undefined ? now + relative : (absolute as number);
    const at = Math.max(requested, now + SCHEDULE_MIN_LEAD_MS);
    if (at > now + SCHEDULE_MAX_HORIZON_MS) {
      throw wooError("E_QUOTA", `schedule is beyond the ${SCHEDULE_MAX_HORIZON_MS}ms horizon`, {
        quota: "schedule_horizon",
        current: at - now,
        limit: SCHEDULE_MAX_HORIZON_MS
      });
    }

    // CO16.3: the namespace half is the arming object and is built HERE, never
    // supplied by the author — that is the entire defence against one verb
    // upserting over or cancelling another object's timer.
    // Turn-unique, not seq-unique: a direct route always carries seq -1, so
    // `space:seq:counter` collided across every direct call on a scope.
    const key = opts.key ?? `t${hashSource(`${this.turnScheduleToken}:${this.turnScheduleCount}`).slice(0, 12)}`;
    const id = `${ctx.thisObj}:${key}`;
    this.turnScheduleCount += 1;

    this.recordTurnEvent({
      kind: "schedule",
      request: {
        id,
        at,
        idlePolicy,
        call: {
          actor: ctx.actor,
          target,
          verb: verbName,
          args: cloneValue(args as WooValue) as WooValue[]
        }
      }
    });
    return id;
  }

  /** CO16.3 — record a cancellation. Returns nothing: the pending queue is
   * scope state the planner does not hold, so any "did it exist" answer
   * computed here could be falsified before the turn commits. */
  recordScheduleCancellation(ctx: CallContext, scheduleId: string): null {
    assertString(scheduleId);
    // First colon, matching the authority's split: the namespace is the
    // arming object, and a stable key may itself contain colons.
    const separator = scheduleId.indexOf(":");
    const namespace = separator < 0 ? "" : scheduleId.slice(0, separator);
    // The cross-namespace bypass keys on the ACTOR, not on `progr`.
    //
    // Keying it on progr made every wizard-owned catalog verb a universal
    // canceller: a $wiz-owned verb is exactly how ordinary users reach the
    // scheduler (that is the CO16.6 gate working), so `progr` is a wizard on
    // every such call and the check passed for anyone. One user could cancel
    // another's timer by passing its id. Cancelling someone else's work is a
    // question about the principal, not about whose code is running.
    if (namespace !== ctx.thisObj && !this.isWizard(ctx.actor)) {
      throw wooError("E_PERM", `cannot cancel schedule ${scheduleId} outside ${ctx.thisObj}`, { id: scheduleId, this: ctx.thisObj });
    }
    this.recordTurnEvent({ kind: "cancel_schedule", id: scheduleId });
    return null;
  }

  // Called by the VM whenever execution changes frames. The recorder annotates
  // subsequent mutations with this frame until dispatch/VM unwinds.
  setTurnRecorderFrame(ctx: CallContext): void {
    if (!this.activeTurnRecorder) return;
    this.currentTurnWriter = this.turnWriterFromContext(ctx);
  }

  private async withTurnRecorderFrame<T>(ctx: CallContext, fn: () => Promise<T>): Promise<T> {
    const previous = this.currentTurnWriter;
    this.setTurnRecorderFrame(ctx);
    try {
      return await fn();
    } finally {
      this.currentTurnWriter = previous;
    }
  }

  private turnWriterFromContext(ctx: CallContext): RecordedWriteAuthority {
    return {
      progr: ctx.progr,
      thisObj: ctx.thisObj,
      verb: ctx.verbName,
      definer: ctx.definer,
      caller: ctx.caller,
      callerPerms: ctx.callerPerms
    };
  }

  private recordTurnEvent(event: TurnRecorderEvent): void {
    const recorded = this.recordedEventWithWriter(event);
    // Keep only the negative classifier needed by terminal transfer. When a
    // diagnostic recorder exists it already owns detached proof events; local
    // no-recorder worlds still reject every non-proof vocabulary kind without
    // paying to clone all reads on the ordinary direct-call hot path.
    const behavior = this.behaviorUndoScopes.at(-1);
    if (
      behavior &&
      recorded.kind !== "cell_read" &&
      recorded.kind !== "prop_read" &&
      recorded.kind !== "dispatch" &&
      recorded.kind !== "state_probe"
    ) {
      behavior.terminalTransferDisallowedKinds.add(recorded.kind);
    }
    this.activeTurnRecorder?.event(recorded);
  }

  /** Record one verb page in the same line-map-free shape bridge.ts stores in
   * `verb_bytecode`. Reads provide optimistic conflict detection; writes make
   * the net planner's ephemeral authoring mutation durable. */
  private recordAuthoredVerbRead(objRef: ObjRef, verb: VerbDef): void {
    if (!this.recordAuthoringCellWrites) return;
    const { line_map: _lineMap, ...page } = this.cloneVerbSharingBytecode(verb);
    this.recordTurnEvent({
      kind: "cell_read",
      cell: { kind: "verb", object: objRef, name: verb.name },
      value: page as unknown as WooValue,
      version: String(verb.version)
    });
  }

  private recordAuthoredVerbAbsence(objRef: ObjRef, name: string): void {
    if (!this.recordAuthoringCellWrites) return;
    this.recordTurnEvent({
      kind: "cell_read",
      cell: { kind: "verb", object: objRef, name },
      value: null,
      version: "absent"
    });
  }

  private recordAuthoredVerbWrite(objRef: ObjRef, verb: VerbDef | null, name: string): void {
    if (!this.recordAuthoringCellWrites) return;
    if (verb === null) {
      this.recordTurnEvent({
        kind: "cell_write",
        cell: { kind: "verb", object: objRef, name },
        value: null,
        op: "remove"
      });
      return;
    }
    const { line_map: _lineMap, ...page } = this.cloneVerbSharingBytecode(verb);
    this.recordTurnEvent({
      kind: "cell_write",
      cell: { kind: "verb", object: objRef, name: verb.name },
      value: page as unknown as WooValue,
      op: "set"
    });
  }

  /** Full property-definition cells use `replace`/`delete`, distinct from an
   * ordinary value assignment (`set`) or inherited-value clear (`remove`). */
  private authoredPropertyCellValue(objRef: ObjRef, name: string): WooValue | null {
    const object = this.objectLive(objRef);
    const def = object.propertyDefs.get(name);
    const hasValue = object.properties.has(name);
    if (!def && !hasValue) return null;
    return {
      ...(hasValue ? { value: cloneValue(object.properties.get(name) as WooValue) } : {}),
      ...(def ? { def: cloneValue(def as unknown as WooValue) } : {})
    } as WooValue;
  }

  private recordAuthoredPropertyRead(objRef: ObjRef, name: string, value: WooValue | null): void {
    if (!this.recordAuthoringCellWrites) return;
    this.recordTurnEvent({
      kind: "cell_read",
      cell: { kind: "prop", object: objRef, name },
      value,
      version: value === null ? "absent" : String(this.objectLive(objRef).propertyVersions.get(name) ?? 0)
    });
  }

  private recordAuthoredPropertyWrite(objRef: ObjRef, name: string, value: WooValue | null): void {
    if (!this.recordAuthoringCellWrites) return;
    this.recordTurnEvent({
      kind: "cell_write",
      cell: { kind: "prop", object: objRef, name },
      value,
      op: value === null ? "delete" : "replace"
    });
  }

  // Local bytecode-to-bytecode calls bypass dispatch(), so the VM uses this
  // hook to keep verb metadata reads complete for transcript validation.
  recordTurnDispatch(target: ObjRef, verbName: string, startAt: ObjRef | null | undefined, definer: ObjRef, verb: VerbDef): void {
    this.recordTurnEvent({
      kind: "dispatch",
      target,
      verb: verbName,
      startAt,
      definer,
      implementation: verb.kind,
      owner: verb.owner,
      version: verb.version,
      source_hash: verb.source_hash,
      direct_callable: verb.direct_callable,
      ...(verb.kind === "native" ? { native: verb.native } : {})
    });
  }

  recordTurnStateProbe(cell: RecordedCell): void {
    this.recordTurnEvent({ kind: "state_probe", cell });
  }

  private recordedEventWithWriter(event: TurnRecorderEvent): TurnRecorderEvent {
    if (!this.currentTurnWriter) return event;
    switch (event.kind) {
      case "cell_write":
      case "prop_write":
      case "object_create":
      case "object_move":
      // Schedule effects are stamped exactly like writes (CO16.2): the frame
      // that armed or cancelled is what the scope validates against.
      case "schedule":
      case "cancel_schedule":
        return event.writer ? event : { ...event, writer: this.currentTurnWriter };
      default:
        return event;
    }
  }

  private propertyVersionForRecording(objRef: ObjRef, name: string): number | string | undefined {
    const obj = this.objects.get(objRef);
    if (!obj) return undefined;
    if (name === "owner") return this.effects.shadowOwnerCellVersion(objRef, obj.owner);
    return obj.propertyVersions.get(name) ?? 0;
  }

  private structuralVersionForRecording(kind: ShadowStructuralCellKind, objRef: ObjRef): string | undefined {
    const obj = this.objects.get(objRef);
    return obj ? this.effects.shadowStructuralCellVersion(kind, obj) : undefined;
  }

  /** The semantic state of an object's lineage cell (object_lineage): the
   *  fields a runtime mutation can change. Net-only metadata (event schemas,
   *  epoch_immutable_definition) is carried on the cell but not here — the
   *  commit apply preserves it from the prior cell. Shape mirrors the lineage
   *  payload bridge.cellsFromSerialized emits so post-state parity holds. */
  private lineageSemantic(obj: WooObject): Record<string, WooValue> {
    return {
      parent: obj.parent,
      owner: obj.owner,
      name: obj.name,
      anchor: obj.anchor,
      flags: { ...obj.flags } as unknown as WooValue
    };
  }

  /**
   * The single controlled lineage-mutation seam. `flags`, `parent`, `owner`,
   * `name`, and `anchor` all live in the one object_lineage cell, and — unlike
   * a create — an existing-object change to any of them was NEVER recorded in
   * the net transcript, so Net promote/demote, chparent, and @rename silently
   * dropped their lineage writes. Every RUNTIME lineage mutation on an existing
   * object routes through here:
   *
   *  1. record a READ of the prior object_lineage version — the CAS basis
   *     (scope.ts step 7): a concurrent lineage change bumps the version, so a
   *     stale plan's read mismatches and replans rather than losing the update;
   *  2. run the caller's in-world mutation;
   *  3. record ONE deterministic lineage replacement carrying the resulting
   *     semantic state. The commit apply writes it to the existing
   *     object_lineage cell and preserves untouched net-only metadata (event
   *     schemas, epoch_immutable_definition) from the prior cell.
   *
   * Bootstrap/catalog/migration lineage rewrites do NOT route here — they are
   * pre-net authoritative construction, recorded (if at all) by the install
   * pipeline, not by a runtime turn transcript.
   */
  private mutateLineage(objRef: ObjRef, mutate: () => void): void {
    const obj = this.objectLive(objRef);
    const priorVersion = this.effects.shadowStructuralCellVersion("lifecycle", obj);
    this.recordTurnEvent({
      kind: "cell_read",
      cell: { kind: "lifecycle", object: objRef },
      version: priorVersion,
      value: this.lineageSemantic(obj)
    });
    this.withBehaviorMutationPermit(mutate);
    const nextVersion = this.effects.shadowStructuralCellVersion("lifecycle", obj);
    this.recordTurnEvent({
      kind: "cell_write",
      cell: { kind: "lifecycle", object: objRef },
      value: this.lineageSemantic(obj),
      op: "set",
      prior: priorVersion,
      next: nextVersion
    });
  }

  private recordUntrackedEffect(name: string, detail?: Record<string, WooValue>): void {
    this.recordTurnEvent({
      kind: "untracked_effect",
      name,
      ...(detail ? { detail } : {})
    });
  }

  private recordProjectionWrite(write: Extract<ProjectionWrite, { table: "snapshots" | "tombstones" | "counters" }>): void {
    this.recordTurnEvent({ kind: "projection_write", write });
  }

  private recordSnapshotProjectionUpsert(snapshot: SpaceSnapshotRecord): void {
    this.recordProjectionWrite({
      table: "snapshots",
      key: { space: snapshot.space_id, seq: snapshot.seq },
      op: "upsert",
      row: snapshot,
      bytes: this.effects.projectionRowBytes(snapshot)
    });
  }

  private recordTombstoneProjectionUpsert(id: ObjRef): void {
    this.recordProjectionWrite({ table: "tombstones", key: id, op: "upsert", row: { id }, bytes: this.effects.projectionRowBytes({ id }) });
  }

  setLogicalInputsForReplay(inputs: Array<{ name: string; value: WooValue }>): void {
    this.assertOutsideBehaviorMutation("setLogicalInputsForReplay");
    const queued = new Map<string, WooValue[]>();
    for (const input of inputs) {
      const list = queued.get(input.name) ?? [];
      list.push(cloneValue(input.value));
      queued.set(input.name, list);
    }
    this.logicalInputReplay = queued;
  }

  private takeReplayLogicalInput(name: string): WooValue | undefined {
    const queued = this.logicalInputReplay?.get(name);
    if (!queued || queued.length === 0) return undefined;
    const value = queued.shift();
    if (queued.length === 0) this.logicalInputReplay?.delete(name);
    return value;
  }

  logicalNow(name = "now"): number {
    const replayed = this.takeReplayLogicalInput(name);
    const value = typeof replayed === "number" ? replayed : Date.now();
    this.recordTurnEvent({ kind: "logical_input", name, value });
    return value;
  }

  logicalRandomInt(n: number, name = "random"): number {
    const replayed = this.takeReplayLogicalInput(name);
    const value = typeof replayed === "number" && Number.isInteger(replayed) && replayed >= 0 && replayed < n
      ? replayed
      : Math.floor(Math.random() * n);
    this.recordTurnEvent({ kind: "logical_input", name, value });
    return value;
  }

  enableIncrementalPersistence(): void {
    this.assertOutsideBehaviorMutation("enableIncrementalPersistence");
    if (!this.objectRepository) return;
    this.incrementalPersistenceEnabled = true;
    // Rehydrate tombstones from the persistence layer so dangling-ref
    // checks survive process restart. Per spec/reference/persistence.md
    // §14.2.1.
    this.withBehaviorMutationPermit(() => {
      for (const id of this.objectRepository!.loadTombstones()) this.tombstones.add(id);
    });
  }

  discardPendingPersistence(): void {
    this.assertOutsideBehaviorMutation("discardPendingPersistence");
    this.dirtyObjects.clear();
    this.deletedObjects.clear();
    this.dirtyProperties.clear();
    this.dirtySessions.clear();
    this.deletedSessions.clear();
    this.dirtyTombstones.clear();
    this.dirtySnapshots.clear();
    this.dirtyCounters = false;
    this.persistenceDirty = false;
  }

  hasPendingPersistence(): boolean {
    return this.persistenceDirty || this.hasDirtyPersistence();
  }

  markObjectChanged(objRef: ObjRef): void {
    this.withBehaviorMutationPermit(() => {
      const obj = this.objectLive(objRef);
      obj.modified = Date.now();
      this.persistObject(objRef);
      this.persist();
    });
  }

  setExecutorContext(bridge: ExecutorContext | null): void {
    this.assertOutsideBehaviorMutation("setExecutorContext");
    this.executorContext = bridge;
  }

  /** Identify chain ids originating on this host. The PO DO sets this to
   * the host key during construction; standalone (memory/sqlite) worlds
   * fall back to "host" — those modes never share chains across hosts so
   * collision is impossible there. */
  setChainOriginPrefix(prefix: string): void {
    this.assertOutsideBehaviorMutation("setChainOriginPrefix");
    this.chainOriginPrefix = prefix;
  }

  /** Chain id of the host task currently executing inside the host queue
   * (or null when the queue is idle). Outbound cross-host RPC code reads
   * this to stamp `x-woo-task-chain`; inbound RPC handlers compare it to
   * the incoming chain id to detect re-entrancy (`hostDispatch` runs
   * inline when the chain ids match). */
  currentTaskChainId(): string | null {
    return this.currentHostTask?.chainId ?? null;
  }

  // Install a metrics sink. Hosts pipe MetricEvent records to a structured log
  // (worker: `console.log("woo.metric", JSON.stringify(...))`) so tailing the
  // host gives ground-truth audience size, RPC cost, and broadcast fanout
  // without re-running the verb. Called by core at known hot points. No-op
  // when no hook is set.
  setMetricsHook(hook: ((event: MetricEvent) => void) | null): void {
    this.assertOutsideBehaviorMutation("setMetricsHook");
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

  /** Walk the anchor chain to find which host's slice owns `id`.
   * Mirrors objectRoutes()'s `hostFor` but is O(depth) rather than O(N).
   * Used by the per-host hostSeedCache invalidation paths so a write to
   * one host doesn't invalidate every host's cached seed.
   *
   * IMPORTANT: This must NOT call getProp / propOrNull — those record
   * turn events. The persist sites that invoke this are called during
   * turn execution; recording a phantom prop_read of `host_placement`
   * on every persisted object would pollute the transcript and break
   * write-prior-version semantics. Walk the class chain manually for
   * inherited defaults. */
  private hostKeyForObject(id: ObjRef): string {
    // Read `host_placement` from own property, else walk class chain
    // (parent links) for inherited propertyDef default. No turn-event
    // side effects.
    const rawHostPlacement = (target: ObjRef): unknown => {
      const obj = this.objects.get(target);
      if (!obj) return null;
      if (obj.properties.has("host_placement")) return obj.properties.get("host_placement");
      if (obj.propertyDefs.has("host_placement")) return obj.propertyDefs.get("host_placement")!.defaultValue;
      let cursor: ObjRef | null = obj.parent;
      const seen = new Set<ObjRef>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const ancestor = this.objects.get(cursor);
        if (!ancestor) break;
        if (ancestor.propertyDefs.has("host_placement")) {
          return ancestor.propertyDefs.get("host_placement")!.defaultValue;
        }
        cursor = ancestor.parent;
      }
      return null;
    };
    if (rawHostPlacement(id) === "self") return id;
    const obj = this.objects.get(id);
    if (!obj) return DEFAULT_OBJECT_HOST;
    let cursor: ObjRef | null = obj.anchor;
    const seen = new Set<ObjRef>();
    while (cursor && !seen.has(cursor)) {
      if (rawHostPlacement(cursor) === "self") return cursor;
      seen.add(cursor);
      cursor = this.objects.has(cursor) ? this.objectLive(cursor).anchor : null;
    }
    return DEFAULT_OBJECT_HOST;
  }

  /** O(depth) authority-host classification for transport code that is
   * labeling exported cell pages. This is intentionally read-only and
   * event-free; callers must not use objectRoutes() on hot authority paths just
   * to decide whether an exported page is owner-sourced or a cached fallback. */
  objectHostKey(id: ObjRef): string {
    return this.hostKeyForObject(id);
  }

  /** Drop one host's cached seed without bumping the global cache version.
   * Used by per-object persist paths that know which host's slice changed:
   * the next host-seed request for `host` will rebuild, but other hosts'
   * cached seeds remain valid. */
  private invalidateHostSeed(host: string): void {
    this.hostSeedCache.delete(host as ObjRef);
  }

  private invalidateHostSeedsForObject(id: ObjRef): void {
    const host = this.hostKeyForObject(id);
    if (host === DEFAULT_OBJECT_HOST) {
      // Default-hosted catalog support rows (classes, features, and shared
      // seed metadata) can be included in many satellite host seeds. A write
      // to one of those rows must therefore invalidate every cached per-host
      // seed, not only the gateway's own "world" entry.
      this.hostSeedCache.clear();
      return;
    }
    this.invalidateHostSeed(host);
  }

  // Read access for the MCP host (cross-host tool enumeration). Other callers
  // should use the typed APIs that wrap the bridge.
  getExecutorContext(): ExecutorContext | null {
    return this.executorContext;
  }

  // Register or replace a native verb handler. Used by the MCP host to wire
  // host-primitive verbs (`actor_wait`, `actor_focus`, etc.) to closures that
  // own their per-actor queue / focus-list state. The verbs themselves are
  // seeded by bootstrap with these handler names; this method just plugs in
  // the implementation.
  registerNativeHandler(name: string, handler: NativeHandler): void {
    this.assertOutsideBehaviorMutation("registerNativeHandler");
    this.nativeHandlers.set(name, handler);
  }

  async isRemoteObject(objRef: ObjRef, memo?: HostOperationMemo): Promise<boolean> {
    return (await this.remoteHostForObject(objRef, memo)) !== null;
  }

  private async remoteHostForObject(objRef: ObjRef, memo?: HostOperationMemo): Promise<string | null> {
    const host = await (this.executorContext?.hostForObject(objRef, memo) ?? null);
    if (!host || host === this.executorContext?.localHost) return null;
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
    /** Reconstructing an object that already exists somewhere else (identity
     * import, world adoption) rather than minting a new one. The id was chosen
     * by whatever world produced it — possibly before the reservation below —
     * and refusing it here would strand a restorable world. Ordinary hydration
     * (importWorld, Net cell application) writes `objects` directly and never
     * reaches this method at all. */
    restoring?: boolean;
  }): WooObject {
    const stored = this.withBehaviorMutationPermit(() => this.createObjectPermitted(input));
    return this.cloneObjectView(stored);
  }

  private createObjectPermitted(input: Parameters<WooWorld["createObject"]>[0]): WooObject {
    const existing = this.objects.get(input.id);
    if (existing) return existing;
    // The single mint seam. Every path that introduces a NEW object — the
    // `create` builtin, actor/account provisioning, guest seeding, catalog
    // install (`local_name` / `seed_hooks.as` become ids verbatim, so a
    // third-party manifest is the one genuinely unconstrained source) —
    // funnels through here.
    if (!input.restoring) assertMintableObjectId(input.id);
    const now = Date.now();
    const obj: WooObject = {
      id: input.id,
      name: input.name ?? input.id,
      parent: input.parent,
      owner: input.owner ?? "$wiz",
      location: input.location ?? null,
      anchor: input.anchor ?? null,
      flags: cloneImportedPlainData(input.flags ?? {}),
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
    // R1: a planning world knows its own creates, so an ordering read under a
    // created parent synthesizes from this run's edge writes with no fetch,
    // and a created child's pre-write membership is known-empty.
    if (this.requireOrderedChildrenProjection) this.noteCreatedThisRun(obj.id);
    if (obj.parent) this.objects.get(obj.parent)?.children.add(obj.id);
    if (obj.location) this.objects.get(obj.location)?.contents.add(obj.id);
    this.persistObject(obj.id);
    if (obj.parent) this.persistObject(obj.parent);
    if (obj.location) this.persistObject(obj.location);
    this.persist();
    this.recordTurnEvent(this.effects.objectCreateEvent(obj));
    // `objects.set` detaches and wraps the row so caller-owned construction
    // records never become authoritative by alias. Return that stored row;
    // handing out `obj` here would be a raw, non-journaled mutation bypass.
    return this.objectLive(obj.id);
  }

  canAuthorObject(actor: ObjRef, objRef: ObjRef): boolean {
    const actorObj = this.objectLive(actor);
    const target = this.objectLive(objRef);
    return actorObj.flags.wizard === true || (actorObj.flags.programmer === true && target.owner === actor);
  }

  assertCanAuthorObject(actor: ObjRef, objRef: ObjRef): void {
    if (this.canAuthorObject(actor, objRef)) return;
    throw wooError("E_PERM", `${actor} cannot author ${objRef}`, { actor, obj: objRef });
  }

  /** Caller-facing object reads are detached snapshots. Runtime code uses the
   * private live accessor below so a returned row can never become an
   * unjournaled mutation capability merely because it crossed an API seam. */
  object(id: ObjRef): WooObject {
    return this.cloneObjectView(this.objectLive(id));
  }

  private objectLive(id: ObjRef): WooObject {
    const obj = this.objects.get(id);
    if (!obj) {
      // VTN10.1: under a sparse guarded shadow executor, an absent id is
      // a materialization miss, not a semantic absence. Emit a lifecycle
      // probe for the id first. The guard recorder will reject the probe
      // with E_NEED_STATE (its `cell:lifecycle:<id>` atom is not in the
      // allowed set), so that throw — not the E_OBJNF below — propagates
      // and drives the repair loop. The throw below stays as the
      // fallthrough for the non-guarded case (authoritative/diagnostic),
      // where the probe records harmlessly and E_OBJNF is the truth.
      if (this.shadowExecutionGuardActive && this.activeTurnRecorder) {
        this.recordTurnStateProbe({ kind: "lifecycle", object: id });
      }
      throw wooError("E_OBJNF", `object not found: ${id}`, id);
    }
    return obj;
  }

  /**
   * Parent-chain walk helper: return the WooObject at `current` along a
   * walk that started at `startRef`, or `null` when `current` is missing
   * (recycled, tombstoned, or never present on this host slice). Records
   * a `dangling_parent_ref` metric so the leak is visible.
   *
   * Callers that walk the parent chain (verb resolution, property
   * inheritance, ancestry enumeration, etc.) MUST use this helper rather
   * than `this.objectLive(current)`. A single dangling intermediate ref —
   * e.g. an instance whose ancestor class was recycled out from under it
   * — would otherwise throw E_OBJNF and break unrelated dispatch on any
   * caller that touched the broken instance. Treating dangling
   * intermediates as end-of-chain degrades the failure to E_VERBNF /
   * E_PROPNF / `inheritsFrom == false`, which callers already handle.
   *
   * Repair belongs in a host-scoped data migration; this helper is the
   * runtime safety net.
   */
  private parentWalkLookup(startRef: ObjRef, current: ObjRef): WooObject | null {
    const obj = this.objects.get(current);
    if (obj) return obj;
    this.recordMetric({
      kind: "dangling_parent_ref",
      start: startRef,
      missing: current,
      tombstoned: this.tombstones.has(current)
    });
    return null;
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
    if (remoteHost && this.executorContext?.isRecycled) {
      try {
        return await this.executorContext.isRecycled(id, memo);
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
      // Rebuilds a Woo map from ITS OWN keys, which are arbitrary author data.
      // A plain `{}` target would swallow a `__proto__` entry on the way
      // through, so scrubbing one tombstone out of a map could silently drop
      // an unrelated key (values.md §V6).
      const out: Record<string, WooValue> = dataKeyedMap();
      let changed = false;
      for (const [key, entry] of Object.entries(src)) {
        if (typeof entry === "string" && this.tombstones.has(entry)) {
          changed = true;
          continue;
        }
        const next = this.scrubTombstoneRefs(entry);
        if (!valuesEqual(entry, next)) changed = true;
        // Own-property definition, not [[Set]] (values.md V6): a `__proto__`
        // entry would otherwise vanish from any map that survives a tombstone
        // scrub, turning a GC pass into silent data loss.
        if (key === "__proto__") {
          Object.defineProperty(out, key, { value: next, writable: true, enumerable: true, configurable: true });
        } else {
          out[key] = next;
        }
      }
      return changed ? out as WooValue : value;
    }
    return value;
  }

  defineProperty(obj: ObjRef, def: Omit<PropertyDef, "version"> & { version?: number }): PropertyDef {
    return this.withBehaviorMutationPermit(() => this.definePropertyPermitted(obj, def));
  }

  private definePropertyPermitted(obj: ObjRef, def: Omit<PropertyDef, "version"> & { version?: number }): PropertyDef {
    this.assertOrdinaryPropertyName(def.name);
    const target = this.objectLive(obj);
    const property: PropertyDef = {
      ...def,
      defaultValue: cloneValue(def.defaultValue),
      ...(def.presenceProjection
        ? { presenceProjection: cloneImportedPlainData(def.presenceProjection) }
        : {}),
      version: def.version ?? 1
    };
    target.propertyDefs.set(property.name, property);
    if (!target.properties.has(property.name)) {
      target.properties.set(property.name, cloneValue(property.defaultValue));
      target.propertyVersions.set(property.name, 1);
      // Catalog migrations that add presence properties with a
      // non-empty default would otherwise bypass setPropLocal. Invalidate
      // rather than incrementally updating.
      if (property.presenceProjection) {
        this.invalidatePresenceIndex();
      }
    }
    this.persistObject(obj);
    this.persist();
    return property;
  }

  setProp(objRef: ObjRef, name: string, value: WooValue): void {
    if (this.setPropLocal(objRef, name, value)) {
      this.persistProperty(objRef, name);
      this.persist();
    }
  }

  /** Returns true iff the in-memory state actually changed. setProp now
   * skips both the version bump and the persist when the new value
   * equals the current one — `setProp(equal_value)` is a no-op rather
   * than a counter increment. propertyVersions is read by the host-seed
   * merge to detect cross-host divergence; bumping it on a no-op
   * fanned out to a full satellite snapshot every cold-load whenever
   * gateway-side code idempotently re-set the same value (catalog
   * repair, returnGuest cleanup that re-clears already-empty fields,
   * etc.). The optimistic-version locks for compile-and-install use
   * propertyDefs.version (separate counter), so this change does not
   * affect that contract. */
  private setPropLocal(objRef: ObjRef, name: string, value: WooValue): boolean {
    return this.withBehaviorMutationPermit(() => this.setPropLocalPermitted(objRef, name, value));
  }

  private setPropLocalPermitted(objRef: ObjRef, name: string, value: WooValue): boolean {
    this.assertOrdinaryPropertyName(name);
    const obj = this.objectLive(objRef);
    const before = obj.properties.get(name);
    const hadValue = obj.properties.has(name);
    const beforeVersion = this.propertyVersionForRecording(objRef, name);
    const presenceProjection = this.presenceProjectionForProperty(objRef, name);
    if (obj.properties.has(name) && valuesEqual(before as WooValue, value)) {
      if (!presenceProjection) {
        this.recordTurnEvent({
          kind: "prop_write",
          object: objRef,
          name,
          hadValue,
          before: cloneValue(before as WooValue),
          after: cloneValue(value),
          changed: false,
          beforeVersion,
          afterVersion: beforeVersion
        });
      }
      return false;
    }
    // R1: record a same-run ordered-edge write (with its pre-write
    // membership) so ordering answers overlay it. First write wins — the
    // overlay reads the CURRENT value at answer time, so only the original
    // pre-state matters for relevance. No-op equal writes returned above.
    if (this.requireOrderedChildrenProjection && name === ORDERED_EDGE_PROP && !this.orderedEdgeWritesThisRun.has(objRef)) {
      this.noteOrderedEdgeWriteThisRun(objRef, this.priorOrderingMembership(objRef, hadValue, before));
    }
    obj.properties.set(name, cloneValue(value));
    obj.propertyVersions.set(name, (obj.propertyVersions.get(name) ?? 0) + 1);
    const afterVersion = this.propertyVersionForRecording(objRef, name);
    obj.modified = Date.now();
    if (presenceProjection) {
      this.invalidatePresenceIndex();
    }
    if (!presenceProjection) {
      this.recordTurnEvent({
        kind: "prop_write",
        object: objRef,
        name,
        hadValue,
        ...(hadValue ? { before: cloneValue(before as WooValue) } : {}),
        after: cloneValue(value),
        changed: true,
        beforeVersion,
        afterVersion
      });
    }
    return true;
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

  private presenceProjectionForProperty(objRef: ObjRef, name: string): PresenceProjectionDef | null {
    return this.presenceProjectionForObjectRecord(this.objectLive(objRef), name);
  }

  isPresenceProjectionProperty(objRef: ObjRef, name: string): boolean {
    const obj = this.objects.get(objRef);
    return obj ? this.presenceProjectionForObjectRecord(obj, name) !== null : false;
  }

  private presenceProjectionForObjectRecord(obj: WooObject, name: string): PresenceProjectionDef | null {
    let current: WooObject | null = obj;
    while (current) {
      const def = current.propertyDefs.get(name);
      if (def?.presenceProjection) return def.presenceProjection;
      current = current.parent ? this.objects.get(current.parent) ?? null : null;
    }
    return null;
  }

  // All metadata-declared presence-projection properties of a room, resolved up
  // its inheritance chain (names closer to the object win). Mirrors
  // presenceProjectionPropsFromReader for the in-memory representation so the
  // shared movement-presence reducer can run against the world materializer.
  private presenceProjectionPropsForObject(objRef: ObjRef): Array<{ name: string; def: PresenceProjectionDef }> {
    const out = new Map<string, PresenceProjectionDef>();
    let current: WooObject | null = this.objects.get(objRef) ?? null;
    while (current) {
      for (const [name, def] of current.propertyDefs) {
        if (def.presenceProjection && !out.has(name)) out.set(name, def.presenceProjection);
      }
      current = current.parent ? this.objects.get(current.parent) ?? null : null;
    }
    return Array.from(out, ([name, def]) => ({ name, def }));
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
    let actorSpaces = this.actorPresenceIndex.get(actor);
    if (!actorSpaces) { actorSpaces = new Set(); this.actorPresenceIndex.set(actor, actorSpaces); }
    actorSpaces.add(space);
  }

  private invalidateSessionActiveScopeIndex(): void {
    this.sessionActiveScopeIndexBuilt = false;
    this.sessionActiveScopeIndex.clear();
  }

  private ensureSessionActiveScopeIndex(): void {
    if (this.sessionActiveScopeIndexBuilt) return;
    this.sessionActiveScopeIndex.clear();
    for (const session of this.sessions.values()) this.indexSessionActiveScope(session);
    this.sessionActiveScopeIndexBuilt = true;
  }

  private indexSessionActiveScope(session: Session): void {
    let sessions = this.sessionActiveScopeIndex.get(session.activeScope);
    if (!sessions) {
      sessions = new Set();
      this.sessionActiveScopeIndex.set(session.activeScope, sessions);
    }
    sessions.add(session.id);
  }

  private unindexSessionActiveScope(session: Session): void {
    const sessions = this.sessionActiveScopeIndex.get(session.activeScope);
    if (!sessions) return;
    sessions.delete(session.id);
    if (sessions.size === 0) this.sessionActiveScopeIndex.delete(session.activeScope);
  }

  private noteSessionInserted(session: Session): void {
    if (this.sessionActiveScopeIndexBuilt) this.indexSessionActiveScope(session);
  }

  private noteSessionDeleted(session: Session | undefined): void {
    if (session && this.sessionActiveScopeIndexBuilt) this.unindexSessionActiveScope(session);
  }

  private setSessionActiveScope(session: Session, activeScope: ObjRef): boolean {
    if (session.activeScope === activeScope) return false;
    if (this.sessionActiveScopeIndexBuilt) this.unindexSessionActiveScope(session);
    this.withBehaviorMutationPermit(() => {
      session.activeScope = activeScope;
    });
    if (this.sessionActiveScopeIndexBuilt) this.indexSessionActiveScope(session);
    return true;
  }

  private sessionIdsInActiveScope(space: ObjRef): string[] {
    this.ensureSessionActiveScopeIndex();
    return Array.from(this.sessionActiveScopeIndex.get(space) ?? []);
  }

  deleteProp(objRef: ObjRef, name: string): boolean {
    return this.withBehaviorMutationPermit(() => this.deletePropPermitted(objRef, name));
  }

  /**
   * Rename one locally-defined catalog property while preserving its value
   * and version lineage. Structural catalog migrations run inside the same
   * rollback boundary as behavior, so they must not reach through `object()`
   * and mutate the authoritative Maps directly. Keeping this operation here
   * makes the full rename one journaled unit and keeps incremental persistence
   * aware of both the removed and replacement property rows.
   */
  renameCatalogProperty(objRef: ObjRef, from: string, to: string): boolean {
    this.assertOrdinaryPropertyName(from);
    this.assertOrdinaryPropertyName(to);
    if (from === to) return false;
    const obj = this.objectLive(objRef);
    const def = obj.propertyDefs.get(from);
    const hadValue = obj.properties.has(from);
    const value = obj.properties.get(from);
    const hadVersion = obj.propertyVersions.has(from);
    const version = obj.propertyVersions.get(from);
    if (!def && !hadValue && !hadVersion) return false;
    const wasPresenceProjection =
      this.presenceProjectionForObjectRecord(obj, from) !== null ||
      this.presenceProjectionForObjectRecord(obj, to) !== null;

    this.withBehaviorMutationPermit(() => {
      if (def && !obj.propertyDefs.has(to)) {
        obj.propertyDefs.set(to, { ...def, name: to, version: def.version + 1 });
      }
      if (hadValue && !obj.properties.has(to)) obj.properties.set(to, value as WooValue);
      if (hadVersion && !obj.propertyVersions.has(to)) {
        obj.propertyVersions.set(to, (version as number) + 1);
      }
      obj.propertyDefs.delete(from);
      obj.properties.delete(from);
      obj.propertyVersions.delete(from);
      obj.modified = Date.now();
    });
    this.deletePersistedProperty(objRef, from);
    if (
      obj.propertyDefs.has(to) ||
      obj.properties.has(to) ||
      obj.propertyVersions.has(to)
    ) {
      this.persistProperty(objRef, to);
    }
    this.persistObject(objRef);
    if (wasPresenceProjection) this.invalidatePresenceIndex();
    this.persist();
    return true;
  }

  /** Atomic catalog-migration rename for an own verb slot. */
  renameCatalogVerb(objRef: ObjRef, from: string, to: string): boolean {
    const obj = this.objectLive(objRef);
    const index = obj.verbs.findIndex((verb) => verb.name === from);
    if (index < 0) return false;
    this.withBehaviorMutationPermit(() => {
      const verb = obj.verbs[index]!;
      if (!obj.verbs.some((item) => item.name === to)) {
        obj.verbs[index] = { ...verb, name: to, version: verb.version + 1 };
      } else {
        obj.verbs.splice(index, 1);
      }
      obj.verbs = obj.verbs.map((item, slotIndex) => ({ ...item, slot: slotIndex + 1 }));
      obj.modified = Date.now();
    });
    this.persistObject(objRef);
    this.persist();
    return true;
  }

  private deletePropPermitted(objRef: ObjRef, name: string): boolean {
    this.assertOrdinaryPropertyName(name);
    const obj = this.objectLive(objRef);
    const wasPresenceProjection = this.presenceProjectionForObjectRecord(obj, name) !== null;
    const hadDef = obj.propertyDefs.delete(name);
    const hadValue = obj.properties.delete(name);
    const hadVersion = obj.propertyVersions.delete(name);
    const hadProperty = hadDef || hadValue || hadVersion;
    if (!hadProperty) return false;
    obj.modified = Date.now();
    this.deletePersistedProperty(objRef, name);
    if (wasPresenceProjection) {
      this.invalidatePresenceIndex();
    }
    this.persist();
    return true;
  }

  /** True only inside setCustomerOf: the ONE writer allowed to touch the
   * reserved attribution property (audit.md AU3.1 write contract). */
  private reservedAttributionWrite = false;

  private assertOrdinaryPropertyName(name: string): void {
    if (name === "owner") {
      throw wooError("E_PERM", "owner is a read-only core field", { property: name });
    }
    if (name === PROP_CUSTOMER_OF && !this.reservedAttributionWrite) {
      // AU3.1: attribution is identity-pipeline state. Ordinary authoring
      // (setProp, defineProperty, verb writes — which all funnel here)
      // must not rewrite it; an object's OWNER rewriting an owned agent's
      // customer is exactly the forgery this blocks. The pipeline writes
      // through setCustomerOf below.
      throw wooError("E_PERM", "customer_of is identity-pipeline state (audit.md AU3.1); it cannot be written by ordinary authoring", { property: name });
    }
  }

  /**
   * The identity pipeline's privileged attribution write (AU3.1): shape-
   * validated, and the only path past the reserved-name guard. Callers
   * are the lifecycle sites only — account binding, actor provisioning,
   * the identity import, and audited transfers. Idempotent (setProp
   * no-ops on equal values).
   */
  setCustomerOf(objRef: ObjRef, attribution: CustomerAttribution): void {
    const valid = normalizeCustomerAttribution(attribution);
    if (valid === null) {
      throw wooError("E_INVARG", "malformed customer attribution", { object: objRef });
    }
    this.reservedAttributionWrite = true;
    try {
      this.setProp(objRef, PROP_CUSTOMER_OF, valid as unknown as WooValue);
    } finally {
      this.reservedAttributionWrite = false;
    }
  }

  /** The AU3.1 derivation view over this world (core/attribution.ts). */
  attributionSource(): AttributionSource {
    const chainReaches = (obj: string, ancestor: string): boolean => {
      try {
        return this.inheritsFrom(obj, ancestor);
      } catch {
        return false;
      }
    };
    return {
      isAgent: (obj) => chainReaches(obj, "$agent"),
      isGuest: (obj) => chainReaches(obj, "$guest"),
      prop: (obj, name) => {
        try {
          return this.propOrNullLive(obj, name);
        } catch {
          return null;
        }
      },
      ownerOf: (obj) => this.objects.get(obj)?.owner ?? null,
      isWizard: (obj) => this.objects.get(obj)?.flags.wizard === true
    };
  }

  getProp(objRef: ObjRef, name: string): WooValue {
    return cloneValue(this.getPropLive(objRef, name));
  }

  private getPropLive(objRef: ObjRef, name: string): WooValue {
    const obj = this.objectLive(objRef);
    const value = readObjectPropertyValue({
      object: obj,
      name,
      lookupParent: (parent, start) => this.parentWalkLookup(start, parent),
      propertyNotFound: (missing) => wooError("E_PROPNF", `property not found: ${missing}`, missing)
    });
    this.recordTurnEvent({ kind: "prop_read", object: objRef, name, value, version: this.propertyVersionForRecording(objRef, name) });
    return value;
  }

  /**
   * Write one verb page on `objRef`, choosing its SLOT (spec/semantics/core.md
   * §C7.4). A slot is a durable per-object ordinal, never an array index:
   *
   *  - `options.slot` — bind that exact slot value. Replaces whatever page
   *    currently holds it, or introduces the slot if it is vacant. (Used by
   *    set_verb_info / set_verb_code / install-over-existing, which must
   *    NEVER move a verb.)
   *  - `options.append` — allocate `max(existing slots) + 1`.
   *  - neither — bind the same-named own page's existing slot; append when
   *    there is no such page.
   *
   * Slots are allocated monotonically and are NOT re-densified: removeVerb
   * leaves a gap, and every other page keeps the slot it was given. That is
   * what makes a slot meaningful on a node that holds only part of the
   * object — under Net planning `obj.verbs` is the turn's SLICE, so any rule
   * derived from array position (the pre-2026-07-27 behavior) silently
   * renumbered live verbs down to 1. See notes/2026-07-27-net-verb-slots.md.
   */
  addVerb(objRef: ObjRef, verb: VerbDef, options: { append?: boolean; slot?: number } = {}): VerbDef {
    return this.withBehaviorMutationPermit(() => this.addVerbPermitted(objRef, verb, options));
  }

  private addVerbPermitted(objRef: ObjRef, verb: VerbDef, options: { append?: boolean; slot?: number }): VerbDef {
    const obj = this.objectLive(objRef);
    const parsedPerms = normalizeVerbPerms(verb.perms, verb.direct_callable === true);
    const existingIndex = this.findOwnVerbIndex(obj, verb.name);
    const slot =
      options.slot !== undefined
        ? options.slot
        : options.append === true
          ? this.nextVerbSlot(obj)
          : existingIndex >= 0
            ? obj.verbs[existingIndex].slot ?? this.nextVerbSlot(obj)
            : this.nextVerbSlot(obj);
    const normalized = {
      ...verb,
      aliases: [...verb.aliases],
      arg_spec: cloneImportedPlainData(verb.arg_spec),
      line_map: cloneImportedPlainData(verb.line_map),
      ...(verb.calls ? { calls: cloneImportedPlainData(verb.calls) } : {}),
      perms: parsedPerms.perms,
      direct_callable: parsedPerms.directCallable,
      slot,
      ...(verb.kind === "bytecode" ? { bytecode: importBytecode(verb.bytecode) } : {})
    } as VerbDef;
    // The page being replaced is the one that holds this slot (an explicit
    // slot rebinds that position) or, by default, the same-named own page.
    // `append` never replaces: it is how the substrate installs an additional
    // page, including a second page under a name that already exists (which
    // LambdaMOO permits and `addVerbForActor` separately refuses).
    const targetIndex =
      options.slot !== undefined
        ? obj.verbs.findIndex((entry) => entry.slot === options.slot)
        : options.append === true
          ? -1
          : existingIndex;
    if (targetIndex >= 0) obj.verbs[targetIndex] = normalized;
    else obj.verbs.push(normalized);
    this.orderVerbs(obj);
    // Verb writes are part of the host-seed body delivered to satellites; a
    // verb edit that does not bump mutationCounter would let the gateway's
    // hostSeedCache serve a stale seed to the next satellite that asks for
    // its slice, and the satellite's stored arg_spec would never see the new
    // shape until the cache was independently invalidated. Bump here so the
    // cache key advances every time a verb's authoritative metadata changes.
    this.bumpMutationVersion();
    this.persistObject(objRef);
    this.persist();
    return obj.verbs.find((entry) => entry.slot === slot)!;
  }

  /** Removing a verb LEAVES ITS SLOT VACANT. Renumbering the survivors would
   * change the durable ordinal of pages this write never touched — over Net
   * those pages are not even in the turn's slice, so the renumber could not be
   * committed anyway, and locally it would silently invalidate every slot
   * descriptor an agent already holds. Gaps are the honest primitive; only
   * relative ORDER is load-bearing (spec/semantics/core.md §C7.4). */
  removeVerb(objRef: ObjRef, name: string): boolean {
    return this.withBehaviorMutationPermit(() => this.removeVerbPermitted(objRef, name));
  }

  private removeVerbPermitted(objRef: ObjRef, name: string): boolean {
    const obj = this.objectLive(objRef);
    const before = obj.verbs.length;
    obj.verbs = obj.verbs.filter((verb) => verb.name !== name);
    if (obj.verbs.length === before) return false;
    this.orderVerbs(obj);
    this.bumpMutationVersion();
    this.persistObject(objRef);
    this.persist();
    return true;
  }

  setObjectName(objRef: ObjRef, name: string): void {
    // Keep both name surfaces in sync: WooObject.name (SerializedObject /
    // ScopedObjectSummary) and the inherited "name" property (woocode
    // `this.name`). Different consumers read different surfaces.
    const obj = this.objectLive(objRef);
    // `name` lives in the object_lineage cell (and, separately, the inherited
    // "name" property below). Route the lineage-field change through the seam
    // so a Net @rename records the lineage write, not only the property write —
    // otherwise the two name surfaces diverge over Net.
    this.mutateLineage(objRef, () => {
      obj.name = name;
      obj.modified = Date.now();
    });
    this.persistObject(objRef);
    this.setProp(objRef, "name", name);
  }

  /**
   * Replace the substrate lineage fields used by catalog installation.
   * Catalog records are ordinary objects, and an update can run inside a
   * sequenced behavior turn; routing the replacement through mutateLineage
   * keeps it journaled and emits the single lifecycle-cell replacement that
   * the Net planner needs. This deliberately does not synchronize the
   * inherited `name` property: catalog records historically keep that
   * separately through their seed/property hooks.
   */
  setCatalogObjectLineage(
    objRef: ObjRef,
    fields: { name: string; owner: ObjRef; parent: ObjRef; anchor?: ObjRef | null }
  ): void {
    const obj = this.objectLive(objRef);
    const anchor = fields.anchor === undefined ? obj.anchor : fields.anchor;
    if (obj.name === fields.name && obj.owner === fields.owner && obj.parent === fields.parent && obj.anchor === anchor) return;
    const oldParent = obj.parent;
    this.mutateLineage(objRef, () => {
      if (oldParent !== fields.parent) {
        if (oldParent && this.objects.has(oldParent)) this.objectLive(oldParent).children.delete(objRef);
        if (this.objects.has(fields.parent)) this.objectLive(fields.parent).children.add(objRef);
      }
      obj.name = fields.name;
      obj.owner = fields.owner;
      obj.parent = fields.parent;
      obj.anchor = anchor;
      obj.modified = Date.now();
    });
    if (oldParent && this.objects.has(oldParent)) this.persistObject(oldParent);
    if (this.objects.has(fields.parent)) this.persistObject(fields.parent);
    this.persistObject(objRef);
    this.persist();
  }

  /** Apply manifest-owned boolean flags through the behavior journal. */
  setCatalogObjectFlags(objRef: ObjRef, expectedFlags: Record<string, unknown>): boolean {
    const obj = this.objectLive(objRef);
    let changed = false;
    this.withBehaviorMutationPermit(() => {
      for (const [flag, expected] of Object.entries(expectedFlags)) {
        if (typeof expected !== "boolean") continue;
        const flags = obj.flags as Record<string, boolean | undefined>;
        if ((flags[flag] === true) === expected) continue;
        flags[flag] = expected;
        changed = true;
      }
      if (changed) obj.modified = Date.now();
    });
    if (changed) {
      this.persistObject(objRef);
      this.persist();
    }
    return changed;
  }

  /**
   * Migration/test-fixture seam for ingress metadata stored on an own verb.
   * Runtime authoring uses the permission-checked verb-info operations; cold
   * bootstrap and historical fixtures sometimes need to state the already-
   * authorized row directly, but must not retain a live alias to that row.
   */
  migrationSetVerbExecutionMetadata(
    objRef: ObjRef,
    name: string,
    fields: { directCallable?: boolean; skipPresenceCheck?: boolean }
  ): boolean {
    this.assertOutsideBehaviorMutation("migrationSetVerbExecutionMetadata");
    const obj = this.objectLive(objRef);
    const verb = obj.verbs.find((candidate) => candidate.name === name);
    if (!verb) return false;
    return this.withBehaviorMutationPermit(() => {
      let changed = false;
      if (fields.directCallable !== undefined && fields.directCallable !== (verb.direct_callable === true)) {
        verb.direct_callable = fields.directCallable || undefined;
        changed = true;
      }
      if (fields.skipPresenceCheck !== undefined && fields.skipPresenceCheck !== (verb.skip_presence_check === true)) {
        verb.skip_presence_check = fields.skipPresenceCheck || undefined;
        changed = true;
      }
      if (!changed) return true;
      obj.modified = Date.now();
      this.bumpMutationVersion();
      this.persistObject(objRef);
      this.persist();
      return true;
    });
  }

  /** Remove verbs no longer present in a catalog manifest and compact slots. */
  retainCatalogOwnVerbs(objRef: ObjRef, names: ReadonlySet<string>): boolean {
    const obj = this.objectLive(objRef);
    const next = obj.verbs
      .filter((verb) => names.has(verb.name))
      .map((verb, index) => ({ ...verb, slot: index + 1 }));
    if (next.length === obj.verbs.length) return false;
    this.withBehaviorMutationPermit(() => {
      obj.verbs = next;
      obj.modified = Date.now();
    });
    this.persistObject(objRef);
    this.persist();
    return true;
  }

  /**
   * Catalog-repair placement seam, including the nullable `$nowhere` shape
   * that the ordinary move primitive deliberately does not accept. It also
   * repairs a missing inverse contents edge when the scalar location already
   * matches, without exposing raw authoritative Set mutation to the installer.
   */
  setCatalogObjectLocation(objRef: ObjRef, targetRef: ObjRef | null): void {
    const obj = this.objectLive(objRef);
    const oldLocation = obj.location;
    const missingInverse = targetRef !== null &&
      this.objects.has(targetRef) &&
      !this.objectLive(targetRef).contents.has(objRef);
    if (oldLocation === targetRef && !missingInverse) return;
    const locationPrior = this.structuralVersionForRecording("location", objRef);
    this.withBehaviorMutationPermit(() => {
      if (oldLocation && oldLocation !== targetRef && this.objects.has(oldLocation)) {
        this.objectLive(oldLocation).contents.delete(objRef);
      }
      obj.location = targetRef;
      if (targetRef && this.objects.has(targetRef)) this.objectLive(targetRef).contents.add(objRef);
      obj.modified = Date.now();
    });
    this.persistObject(objRef);
    if (oldLocation && this.objects.has(oldLocation)) this.persistObject(oldLocation);
    if (targetRef && this.objects.has(targetRef)) this.persistObject(targetRef);
    if (oldLocation !== targetRef) {
      if (targetRef) {
        this.recordTurnEvent({ kind: "object_move", object: objRef, from: oldLocation, to: targetRef });
      }
      this.recordTurnEvent({
        kind: "cell_write",
        cell: { kind: "location", object: objRef },
        value: targetRef,
        op: targetRef ? "move" : "delete",
        prior: locationPrior
      });
    }
    this.persist();
  }

  /**
   * Migration-only parent rewrite. Sets `obj.parent = newParent` for an
   * object on this host slice and persists. Updates the children-set
   * cache only on whichever endpoints are local: tolerates a
   * tombstoned/missing old parent and a remote/missing new parent so
   * the call is safe even when neither end of the rewrite has a local
   * stub. Skips permission and cycle checks — caller must ensure those
   * (typically a host-scoped data migration with system authority).
   *
   * Returns true when a rewrite happened, false when `objRef` isn't on
   * this host or already has the requested parent (so reruns are safe).
   *
   * Use cases:
   *   - Repairing dangling parent refs after a class object was
   *     recycled out from under instances on a different host
   *     (e.g. the 2026-05-09 $horoscope_note repair).
   *   - Ditto for any future class-removal that wants to graft live
   *     instances up to a known-good ancestor without requiring
   *     cross-cluster coordination.
   *
   * For ordinary @chparent / catalog-migration `change_parent` use
   * builderChparent or chparentAuthoredObject, which enforce auth and
   * cycle checks and require both endpoints to be locally reachable.
   */
  migrationSetObjectParent(objRef: ObjRef, newParent: ObjRef): boolean {
    return this.withBehaviorMutationPermit(() => {
      const obj = this.objects.get(objRef);
      if (!obj) return false;
      if (obj.parent === newParent) return false;
      if (obj.parent && this.objects.has(obj.parent)) {
        this.objectLive(obj.parent).children.delete(objRef);
        this.persistObject(obj.parent);
      }
      obj.parent = newParent;
      if (this.objects.has(newParent)) {
        this.objectLive(newParent).children.add(objRef);
        this.persistObject(newParent);
      }
      obj.modified = Date.now();
      this.persistObject(objRef);
      this.persist();
      return true;
    });
  }

  /** Migration/install-only anchor rewrite. Runtime authority placement uses
   * creation-time anchors; this seam exists for bounded local repair and
   * test/installation fixtures that deliberately model an older placement. */
  migrationSetObjectAnchor(objRef: ObjRef, anchor: ObjRef | null): boolean {
    return this.withBehaviorMutationPermit(() => {
      const obj = this.objects.get(objRef);
      if (!obj || obj.anchor === anchor) return false;
      obj.anchor = anchor;
      obj.modified = Date.now();
      this.persistObject(objRef);
      this.persist();
      return true;
    });
  }

  /** Migration/test-fixture owner rewrite. Ordinary ownership changes must use
   * the checked authoring path; this reconstructs an explicitly historical
   * lineage row without handing callers the live object as a capability. */
  migrationSetObjectOwner(objRef: ObjRef, owner: ObjRef): boolean {
    this.assertOutsideBehaviorMutation("migrationSetObjectOwner");
    return this.withBehaviorMutationPermit(() => {
      const obj = this.objects.get(objRef);
      if (!obj || obj.owner === owner) return false;
      obj.owner = owner;
      obj.modified = Date.now();
      this.persistObject(objRef);
      this.persist();
      return true;
    });
  }

  /** Migration/test-fixture tombstone seam. Runtime recycling must use the
   * checked recycle path; this only reconstructs a known historical marker. */
  migrationSetTombstone(objRef: ObjRef, present: boolean): void {
    this.assertOutsideBehaviorMutation("migrationSetTombstone");
    this.withBehaviorMutationPermit(() => {
      if (present) this.tombstones.add(objRef);
      else this.tombstones.delete(objRef);
    });
  }

  /**
   * Migration-only object drop. Removes `objRef` from the local slice
   * synchronously, bypassing verb dispatch and the permission/auth and
   * cross-host guards in `recycleChecked`. Children of the recycled
   * object get grafted up to its parent and contents become `$nowhere`
   * (the same bookkeeping the regular recycle pipeline performs in
   * §RC3); a tombstone is recorded so the deletion replicates through
   * the persistence layer. No `:recycle` handler runs.
   *
   * Returns false when the object isn't present locally (so reruns are
   * safe), true when the drop happened.
   *
   * Use only from the local-catalog migration runner when removing seed
   * or class objects from a superseded catalog. Caller is responsible
   * for ordering: recycle contents bottom-up before recycling their
   * containers, otherwise contents land in `$nowhere` instead of being
   * removed.
   */
  migrationRecycleObject(objRef: ObjRef): boolean {
    if (!this.objects.has(objRef)) return false;
    this.recycleObjectLocal(objRef);
    return true;
  }

  // Permission-gated wrapper exposed as the `set_object_name` builtin.
  // Used by catalog verbs (e.g. $root:@rename) that need to mutate an
  // object's display name from woocode without holding wizard authority
  // catalog-side. Mirrors the auth shape used by builderSetProperty.
  setObjectNameForActor(actor: ObjRef, objRef: ObjRef, name: string): void {
    if (typeof name !== "string" || name.length === 0) {
      throw wooError("E_INVARG", "set_object_name requires a non-empty string", name);
    }
    const obj = this.objectLive(objRef);
    if (!this.isWizard(actor) && obj.owner !== actor) {
      throw wooError("E_PERM", `${actor} cannot rename ${objRef}`, { actor, obj: objRef });
    }
    this.setObjectName(objRef, name);
  }

  ownVerb(objRef: ObjRef, name: string): VerbDef | null {
    const found = this.ownVerbNamed(objRef, name);
    return found ? this.cloneVerbSharingBytecode(found) : null;
  }

  ownVerbExact(objRef: ObjRef, name: string): VerbDef | null {
    const found = this.objectLive(objRef).verbs.find((verb) => verb.name === name);
    return found ? this.cloneVerbSharingBytecode(found) : null;
  }

  private findOwnVerbIndex(obj: WooObject, name: string): number {
    return obj.verbs.findIndex((verb) => verb.name === name);
  }

  /** The next free ordinal for an appended verb: one past the highest slot
   * this world holds for the object. On a full world that is exact. Under Net
   * sparse planning it is a HINT computed from the turn's slice — the owning
   * scope re-derives the floor at commit and rejects a page that does not
   * match (spec/protocol/coherence.md §CO4 verb-slot allocation), so an
   * under-estimate becomes a retryable replan, never a silent collision. */
  private nextVerbSlot(obj: WooObject): number {
    let high = 0;
    for (const verb of obj.verbs) high = Math.max(high, verb.slot ?? 0);
    return high + 1;
  }

  /** Keep `obj.verbs` in resolution order: slot ascending, name ascending for
   * pages that (in an unrepaired aged world) still share a slot. This is the
   * SAME total order the net bridge and the shadow page normalizer produce, so
   * every node that holds the same page set resolves the same verb. It does
   * NOT renumber — see removeVerb. */
  private orderVerbs(obj: WooObject): void {
    obj.verbs.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0) || a.name.localeCompare(b.name));
    obj.modified = Date.now();
  }

  defineEventSchema(objRef: ObjRef, type: string, shape: Record<string, WooValue>): void {
    this.withBehaviorMutationPermit(() => this.defineEventSchemaPermitted(objRef, type, shape));
  }

  private defineEventSchemaPermitted(objRef: ObjRef, type: string, shape: Record<string, WooValue>): void {
    const obj = this.objectLive(objRef);
    obj.eventSchemas.set(type, cloneValue(shape as WooValue) as Record<string, WooValue>);
    obj.modified = Date.now();
    this.persistObject(objRef);
    this.persist();
  }

  /** The declared shape for one event type, resolved the way verb dispatch
   * resolves names (spec/semantics/introspection.md `event_schema`): the
   * object's parent chain first, then — for feature carriers — each feature's
   * parent chain in declared order. Returns a defensive copy so callers
   * cannot mutate the installed schema; null when no chain declares the type. */
  eventSchemaFor(objRef: ObjRef, type: string): Record<string, WooValue> | null {
    const fromChain = (startRef: ObjRef): Record<string, WooValue> | null => {
      let current: ObjRef | null = startRef;
      while (current) {
        const obj = this.parentWalkLookup(startRef, current);
        if (!obj) break;
        const shape = obj.eventSchemas.get(type);
        if (shape !== undefined) return cloneValue(shape as WooValue) as Record<string, WooValue>;
        current = obj.parent;
      }
      return null;
    };
    const own = fromChain(objRef);
    if (own !== null) return own;
    if (this.canCarryFeatures(objRef)) {
      for (const feature of this.featureList(objRef)) {
        const fromFeature = fromChain(feature);
        if (fromFeature !== null) return fromFeature;
      }
    }
    return null;
  }

  resolveVerb(objRef: ObjRef, name: string): ResolvedVerb {
    const resolved = this.resolveVerbLive(objRef, name);
    return { definer: resolved.definer, verb: this.cloneVerbSharingBytecode(resolved.verb) };
  }

  private resolveVerbLive(objRef: ObjRef, name: string): ResolvedVerb {
    // Dispatching to a recycled/tombstoned target must raise E_OBJNF, not
    // fall through to E_VERBNF. The parent-chain walk inside
    // resolveVerbFrom tolerates missing *intermediate* ancestors (so
    // dispatch keeps working when one of the target's ancestor classes
    // is gone) — this start-object check preserves the
    // "no stale-dispatch window" guarantee that tests/recycle.test.ts
    // relies on for callers that hold the target ULID after recycle.
    if (!this.objects.has(objRef)) throw wooError("E_OBJNF", `object not found: ${objRef}`, objRef);
    const parentMatch = this.resolveVerbFromLive(objRef, name, false);
    if (parentMatch) return parentMatch;
    if (this.canCarryFeatures(objRef)) {
      const features = this.featureList(objRef);
      for (const feature of features) {
        const featureMatch = this.resolveVerbFromLive(feature, name, false);
        if (featureMatch) return featureMatch;
      }
    }
    throw wooError("E_VERBNF", `verb not found: ${objRef}:${name}`, { obj: objRef, name });
  }

  resolveVerbFrom(startRef: ObjRef | null, name: string): ResolvedVerb;
  resolveVerbFrom(startRef: ObjRef | null, name: string, required: false): ResolvedVerb | null;
  resolveVerbFrom(startRef: ObjRef | null, name: string, required = true): ResolvedVerb | null {
    const resolved = required
      ? this.resolveVerbFromLive(startRef, name)
      : this.resolveVerbFromLive(startRef, name, false);
    return resolved
      ? { definer: resolved.definer, verb: this.cloneVerbSharingBytecode(resolved.verb) }
      : null;
  }

  private resolveVerbFromLive(startRef: ObjRef | null, name: string): ResolvedVerb;
  private resolveVerbFromLive(startRef: ObjRef | null, name: string, required: false): ResolvedVerb | null;
  private resolveVerbFromLive(startRef: ObjRef | null, name: string, required = true): ResolvedVerb | null {
    let current: ObjRef | null = startRef;
    while (current) {
      const obj = startRef !== null ? this.parentWalkLookup(startRef, current) : this.objects.get(current) ?? null;
      if (!obj) break;
      if (current !== startRef) this.recordTurnStateProbe({ kind: "verb", object: current, name });
      const verb = this.ownVerbNamed(current, name);
      if (verb) return { definer: current, verb };
      current = obj.parent;
    }
    if (!required) return null;
    throw wooError("E_VERBNF", `verb not found: ${startRef ?? "#-1"}:${name}`, { obj: startRef ?? "#-1", name });
  }

  describe(objRef: ObjRef): Record<string, WooValue> {
    const obj = this.objectLive(objRef);
    return {
      id: obj.id,
      name: obj.name,
      description: this.propOrNullLive(objRef, "description"),
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
      const obj: WooObject | null = current === objRef ? this.objectLive(current) : this.parentWalkLookup(objRef, current);
      if (!obj) break;
      for (const name of obj.propertyDefs.keys()) names.add(name);
      for (const name of obj.properties.keys()) names.add(name);
      current = obj.parent;
    }
    return Array.from(names).sort();
  }

  getPropForActor(actor: ObjRef, objRef: ObjRef, name: string): WooValue {
    if (!this.canReadProperty(actor, objRef, name)) throw wooError("E_PERM", `${actor} cannot read ${objRef}.${name}`, { actor, obj: objRef, property: name });
    return cloneValue(this.getPropLive(objRef, name));
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
      if (!this.executorContext) throw wooError("E_INTERNAL", "remote host bridge unavailable");
      const effect = this.effects.remoteBridgeUntrackedEffect("get_prop", { progr, object: objRef, property: name });
      this.recordUntrackedEffect(effect.name, effect.detail);
      return await this.executorContext.getPropChecked(progr, objRef, name, memo);
    }
    if (!this.canReadProperty(progr, objRef, name)) {
      throw wooError("E_PERM", `${progr} cannot read ${objRef}.${name}`, { progr, obj: objRef, property: name });
    }
    return this.getPropLive(objRef, name);
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
      if (!this.executorContext) throw wooError("E_INTERNAL", "remote host bridge unavailable");
      const effect = this.effects.remoteBridgeUntrackedEffect("set_prop", { progr, object: objRef, property: name });
      this.recordUntrackedEffect(effect.name, effect.detail);
      await this.executorContext.setPropChecked(progr, objRef, name, value, memo);
      return;
    }
    try {
      if (!this.canWriteProperty(progr, objRef, name)) {
        throw wooError("E_PERM", `${progr} cannot write ${objRef}.${name}`, { progr, obj: objRef, property: name });
      }
    } catch (err) {
      if (!isErrorValue(err) || err.code !== "E_PROPNF") throw err;
      const obj = this.objectLive(objRef);
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
    const obj = this.objectLive(objRef);
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
    const obj = this.objectLive(objRef);
    const def = obj.propertyDefs.get(name);
    if (!def) throw wooError("E_PROPNF", `property not defined on ${objRef}: ${name}`, { obj: objRef, property: name });
    if (!this.canBypassPerms(progr) && obj.owner !== progr && def.owner !== progr) {
      throw wooError("E_PERM", `${progr} cannot undefine ${objRef}.${name}`, { progr, obj: objRef, property: name });
    }
    this.withBehaviorMutationPermit(() => {
      obj.propertyDefs.delete(name);
      obj.properties.delete(name);
      obj.propertyVersions.delete(name);
      obj.modified = Date.now();
    });
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
    const obj = this.objectLive(definedOn);
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
    this.withBehaviorMutationPermit(() => {
      if (typeof info.owner === "string") {
        this.objectLive(info.owner);
        def.owner = info.owner;
      }
      if (typeof info.perms === "string") def.perms = info.perms;
      if (typeof info.type_hint === "string") def.typeHint = info.type_hint;
      def.version += 1;
      obj.modified = Date.now();
    });
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
    return cloneValue(this.propOrNullLive(objRef, name));
  }

  private propOrNullLive(objRef: ObjRef, name: string): WooValue {
    try {
      return this.getPropLive(objRef, name);
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

  // Own-only verb names on this object (no inheritance, no features).
  // Mirrors LambdaMOO's `verbs(obj)` which lists only verbs defined
  // directly on `obj`. Returns slot-order names.
  ownVerbNames(objRef: ObjRef): string[] {
    return this.objectLive(objRef).verbs.map((verb) => verb.name);
  }

  // Ancestor chain starting from the immediate parent up through the root.
  // Excludes `obj` itself. Empty list for objects with no parent ($system).
  parents(objRef: ObjRef): ObjRef[] {
    const out: ObjRef[] = [];
    let current = this.objectLive(objRef).parent;
    while (current) {
      out.push(current);
      const parent = this.objects.get(current)?.parent ?? null;
      current = parent;
    }
    return out;
  }

  childrenOf(objRef: ObjRef): ObjRef[] {
    return Array.from(this.objectLive(objRef).children);
  }

  // True iff `obj` denotes a live, non-recycled object reference.
  valid(objRef: ObjRef): boolean {
    return this.objects.has(objRef);
  }

  // Resolve a verb by name (with optional `*`/`@` aliases) or by SLOT VALUE,
  // restricted to verbs defined directly on `objRef`. Raises E_VERBNF when not
  // found. LambdaMOO `verb_info(obj, desc)`.
  //
  // A numeric descriptor names the slot the object REPORTS (verb_info.slot,
  // list_verb.slot), not a position in the array: slots are monotonic with
  // gaps after removeVerb, so index-addressing would silently answer with a
  // neighbour once anything had been deleted (spec/semantics/core.md §C7.4).
  ownVerbResolve(objRef: ObjRef, descriptor: WooValue): VerbDef {
    const obj = this.objectLive(objRef);
    if (typeof descriptor === "number") {
      if (!Number.isInteger(descriptor) || descriptor < 1) {
        throw wooError("E_VERBNF", `verb slot out of range: ${descriptor}`, descriptor);
      }
      const bySlot = obj.verbs.find((verb) => verb.slot === descriptor);
      if (!bySlot) throw wooError("E_VERBNF", `verb slot out of range: ${descriptor}`, descriptor);
      return bySlot;
    }
    if (typeof descriptor !== "string") {
      throw wooError("E_TYPE", "verb descriptor must be a name string or 1-based slot integer", descriptor);
    }
    const found = this.ownVerbExact(objRef, descriptor);
    // `{ obj, name }` is the engine's one E_VERBNF shape for a name-descriptor
    // miss. It is not cosmetic: the Net sparse planner derives the exact
    // `verb_bytecode:<obj>:<name>` cell to grow the turn's slice from this
    // value (src/net/plan.ts sparseMissingKeys). A divergent key spelling made
    // the miss unrepairable and terminal — see that function's comment.
    if (!found) throw wooError("E_VERBNF", `${objRef} has no verb named ${descriptor}`, { obj: objRef, name: descriptor });
    return found;
  }

  // Read-only verb info for caller-perms `actor`. Mirrors LambdaMOO's
  // `verb_info(obj, desc)` but extends the returned map to include woo
  // verb fields (arg_spec, version, direct_callable, tool_exposed,
  // source_hash, slot). Permission: actor must be able to read the verb
  // (verb owner, "r" perm, or wizard).
  verbInfoForActor(actor: ObjRef, objRef: ObjRef, descriptor: WooValue): Record<string, WooValue> {
    const verb = this.ownVerbResolve(objRef, descriptor);
    if (!this.canReadVerb(actor, verb)) {
      throw wooError("E_PERM", `${actor} cannot read verb ${objRef}:${verb.name}`, { actor, obj: objRef, verb: verb.name });
    }
    return {
      definer: objRef,
      slot: verb.slot ?? 0,
      name: verb.name,
      aliases: verb.aliases,
      owner: verb.owner,
      perms: verb.perms,
      arg_spec: verb.arg_spec as WooValue,
      version: verb.version,
      direct_callable: verb.direct_callable === true,
      tool_exposed: verb.tool_exposed === true,
      reads_room_presence: verb.reads_room_presence === true,
      reads_ordered_children: verb.reads_ordered_children === true,
      source_hash: verb.source_hash ?? ""
    };
  }

  // Verb source for caller-perms `actor`. Returns the source string as
  // stored. Mirrors LambdaMOO's `verb_code(obj, desc)`. Permission: same
  // as verb_info — actor must be able to read the verb.
  verbCodeForActor(actor: ObjRef, objRef: ObjRef, descriptor: WooValue): string {
    const verb = this.ownVerbResolve(objRef, descriptor);
    if (!this.canReadVerb(actor, verb)) {
      throw wooError("E_PERM", `${actor} cannot read verb ${objRef}:${verb.name}`, { actor, obj: objRef, verb: verb.name });
    }
    return typeof verb.source === "string" ? verb.source : "";
  }

  // LambdaMOO `add_verb(obj, info, args)`. Creates a new verb slot on
  // `objRef` with a no-op body. Raises E_INVARG if a verb of the same name
  // already exists on `objRef` (own slot — inherited verbs are fine).
  // Permission: wizard, or `actor` is a programmer who owns `objRef`.
  // `info` is a map: { name, owner?, perms?, aliases?, arg_spec?,
  // direct_callable?, tool_exposed? }. Source begins empty; use
  // set_verb_code to install code.
  addVerbForActor(actor: ObjRef, objRef: ObjRef, info: WooValue): Record<string, WooValue> {
    this.assertCanAuthorObject(actor, objRef);
    const map = info && typeof info === "object" && !Array.isArray(info) ? info as Record<string, WooValue> : null;
    if (!map) throw wooError("E_INVARG", "add_verb expects info map", info);
    const name = typeof map.name === "string" && map.name.length > 0 ? map.name : null;
    if (!name) throw wooError("E_INVARG", "add_verb info.name must be a non-empty string", info);
    if (this.ownVerbExact(objRef, name)) {
      throw wooError("E_INVARG", `verb already exists: ${objRef}:${name}`, { obj: objRef, name });
    }
    this.recordAuthoredVerbAbsence(objRef, name);
    const owner = typeof map.owner === "string" ? map.owner : actor;
    if (!this.objects.has(owner)) throw wooError("E_INVARG", `verb owner does not exist: ${owner}`, owner);
    // Verb owner is the verb's execution authority (`progr`). A non-wizard
    // creator may only own verbs they create; otherwise a programmer who
    // owns an object could install a verb on it owned by `$wiz` and run
    // wizard-progr code via dispatch. Mirrors definePropertyChecked.
    if (owner !== actor && !this.isWizard(actor)) {
      throw wooError("E_PERM", `${actor} cannot create verbs owned by ${owner}`, { actor, owner, obj: objRef, verb: name });
    }
    const aliases = Array.isArray(map.aliases) ? map.aliases.map((a) => String(a)) : [];
    const argSpec = map.arg_spec && typeof map.arg_spec === "object" && !Array.isArray(map.arg_spec)
      ? (map.arg_spec as Record<string, WooValue>) : {};
    const directCallable = map.direct_callable === true;
    const toolExposed = map.tool_exposed === true;
    const permsRaw = typeof map.perms === "string" ? map.perms : "rx";
    const parsedPerms = normalizeVerbPerms(permsRaw, directCallable);
    const stub = "verb :" + name + "() " + parsedPerms.perms + " { return null; }";
    const compiled = compileVerb(stub);
    if (!compiled.ok || !compiled.bytecode) {
      throw wooError("E_INTERNAL", "add_verb stub failed to compile", { obj: objRef, name });
    }
    // Stub verbs start at version 0 so an `add_verb` + `set_verb_code`
    // pair counts as a single install (final version 1) — matching what
    // a single-step install used to record. set_verb_code bumps to
    // `current.version + 1`, so the first real code edit lands at v1.
    const verb: VerbDef = {
      kind: "bytecode",
      name,
      aliases,
      owner,
      perms: parsedPerms.perms,
      arg_spec: argSpec,
      source: stub,
      source_hash: compiled.source_hash ?? hashSource(stub),
      bytecode: { ...compiled.bytecode, version: 0 },
      version: 0,
      line_map: compiled.line_map ?? {},
      direct_callable: parsedPerms.directCallable,
      tool_exposed: toolExposed
    };
    this.addVerb(objRef, verb, { append: true });
    const installed = this.ownVerbExact(objRef, name);
    if (installed) this.recordAuthoredVerbWrite(objRef, installed, name);
    return { slot: installed?.slot ?? 0, version: installed?.version ?? 0 };
  }

  // LambdaMOO `delete_verb(obj, desc)`. Removes a verb slot from
  // `objRef`. Permission: wizard, or `actor` is a programmer who owns
  // `objRef`. Inherited verbs cannot be removed via this surface.
  deleteVerbForActor(actor: ObjRef, objRef: ObjRef, descriptor: WooValue): void {
    this.assertCanAuthorObject(actor, objRef);
    const verb = this.ownVerbResolve(objRef, descriptor);
    this.recordAuthoredVerbRead(objRef, verb);
    if (!this.removeVerb(objRef, verb.name)) {
      // `{ obj, name }`: see ownVerbResolve — the Net planner derives the
      // missing verb cell from this shape.
      throw wooError("E_VERBNF", `verb not found: ${objRef}:${verb.name}`, { obj: objRef, name: verb.name });
    }
    this.recordAuthoredVerbWrite(objRef, null, verb.name);
  }

  // LambdaMOO `set_verb_info(obj, desc, info)`. Updates owner / perms /
  // names / arg_spec / direct_callable / tool_exposed on an existing
  // verb. Source/bytecode are not touched. Permission: wizard, or
  // actor is the verb's owner — verb ownership is the verb's execution
  // authority (`progr`), so editing a verb you don't own would let you
  // run arbitrary code under another principal. Bumps verb version.
  setVerbInfoForActor(actor: ObjRef, objRef: ObjRef, descriptor: WooValue, info: WooValue): Record<string, WooValue> {
    const map = info && typeof info === "object" && !Array.isArray(info) ? info as Record<string, WooValue> : null;
    if (!map) throw wooError("E_INVARG", "set_verb_info expects info map", info);
    const current = this.ownVerbResolve(objRef, descriptor);
    if (current.kind !== "bytecode") throw wooError("E_INVARG", "set_verb_info only updates bytecode verbs", { obj: objRef, verb: current.name });
    if (!this.isWizard(actor) && current.owner !== actor) {
      throw wooError("E_PERM", `${actor} cannot edit verb ${objRef}:${current.name} owned by ${current.owner}`, { actor, obj: objRef, verb: current.name, owner: current.owner });
    }
    this.recordAuthoredVerbRead(objRef, current);
    const aliases = Array.isArray(map.aliases) ? map.aliases.map((a) => String(a)) : current.aliases;
    const argSpec = "arg_spec" in map && map.arg_spec && typeof map.arg_spec === "object" && !Array.isArray(map.arg_spec)
      ? (map.arg_spec as Record<string, WooValue>) : current.arg_spec;
    const directCallable = "direct_callable" in map ? map.direct_callable === true : current.direct_callable === true;
    const toolExposed = "tool_exposed" in map ? map.tool_exposed === true : current.tool_exposed === true;
    const owner = typeof map.owner === "string" ? map.owner : current.owner;
    if (!this.objects.has(owner)) throw wooError("E_INVARG", `verb owner does not exist: ${owner}`, owner);
    // Verb owner is the verb's execution authority. A non-wizard editor
    // may only retain the existing owner or set themselves; otherwise
    // they could escalate by chowning a verb on an object they own to
    // `$wiz`. Mirrors definePropertyChecked / addVerbForActor.
    if (owner !== current.owner && owner !== actor && !this.isWizard(actor)) {
      throw wooError("E_PERM", `${actor} cannot change verb owner to ${owner}`, { actor, owner, obj: objRef, verb: current.name });
    }
    const permsRaw = typeof map.perms === "string" ? map.perms : current.perms;
    const parsedPerms = normalizeVerbPerms(permsRaw, directCallable);
    // Verb rename: `info.name` swaps the slot's primary name. The
    // verb's source body is not touched, but woocode parsers compare
    // header names on next install — that is the catalog's problem,
    // not the substrate's.
    let nextName = current.name;
    if (typeof map.name === "string" && map.name !== current.name) {
      if (map.name.length === 0) throw wooError("E_INVARG", "verb name must be non-empty", map.name);
      const collision = this.ownVerbExact(objRef, map.name);
      if (collision && collision.slot !== current.slot) {
        throw wooError("E_INVARG", `verb already exists: ${objRef}:${map.name}`, { obj: objRef, name: map.name });
      }
      nextName = map.name;
    }
    const next: VerbDef = {
      ...current,
      name: nextName,
      owner,
      aliases,
      arg_spec: argSpec,
      perms: parsedPerms.perms,
      direct_callable: parsedPerms.directCallable,
      tool_exposed: toolExposed,
      version: current.version + 1
    };
    this.addVerb(objRef, next, { slot: current.slot });
    if (next.name !== current.name) this.recordAuthoredVerbWrite(objRef, null, current.name);
    this.recordAuthoredVerbWrite(objRef, next, next.name);
    return { slot: next.slot ?? 0, version: next.version };
  }

  // LambdaMOO `set_verb_code(obj, desc, code)`. Compiles and replaces
  // source on an existing verb. Returns a list of compile error messages
  // (empty = success). Permission: wizard, or actor is the verb's
  // owner — the verb's owner is dispatch's `progr`, so editing a verb
  // you don't own would let you smuggle arbitrary code in under that
  // principal's authority. Bumps verb version on success.
  setVerbCodeForActor(actor: ObjRef, objRef: ObjRef, descriptor: WooValue, source: string): WooValue {
    const current = this.ownVerbResolve(objRef, descriptor);
    if (current.kind !== "bytecode") throw wooError("E_INVARG", "set_verb_code only updates bytecode verbs", { obj: objRef, verb: current.name });
    if (!this.isWizard(actor) && current.owner !== actor) {
      throw wooError("E_PERM", `${actor} cannot edit verb ${objRef}:${current.name} owned by ${current.owner}`, { actor, obj: objRef, verb: current.name, owner: current.owner });
    }
    this.recordAuthoredVerbRead(objRef, current);
    const compiled = compileVerb(source);
    if (!compiled.ok || !compiled.bytecode) {
      return compiled.diagnostics.map((d) => d.message ?? d.code ?? "compile error") as unknown as WooValue;
    }
    if (compiled.metadata?.name && compiled.metadata.name !== current.name) {
      return [`verb header :${compiled.metadata.name} does not match install target :${current.name}`] as unknown as WooValue;
    }
    const version = current.version + 1;
    const finalBytecode = { ...compiled.bytecode, version };
    const parsedPerms = normalizeVerbPerms(
      compiled.metadata?.perms ?? current.perms,
      compiled.metadata?.perms ? false : current.direct_callable === true
    );
    const pure = combineVerbPurity(analyzeBytecodePurity(finalBytecode), undefined, `${objRef}:${current.name}`);
    const next: VerbDef = {
      ...current,
      perms: parsedPerms.perms,
      arg_spec: compiled.metadata?.arg_spec ?? current.arg_spec,
      direct_callable: parsedPerms.directCallable,
      pure: pure || undefined,
      calls: compiled.metadata?.calls,
      source,
      source_hash: compiled.source_hash ?? hashSource(source),
      bytecode: finalBytecode,
      version,
      line_map: compiled.line_map ?? {}
    };
    this.addVerb(objRef, next, { slot: current.slot });
    propagateVerbPurity(this);
    this.recordAuthoredVerbWrite(objRef, next, next.name);
    return [] as unknown as WooValue;
  }

  // Own-only property names defined directly on `objRef` (no inheritance).
  // Mirrors LambdaMOO's `properties(obj)`. Sorted for stability.
  ownPropertyNames(objRef: ObjRef): string[] {
    return Array.from(this.objectLive(objRef).propertyDefs.keys()).sort();
  }

  // LambdaMOO `add_property(obj, name, value, info)`. Defines a new
  // property on `objRef`. info = { owner?, perms?, type_hint? }; owner
  // defaults to `actor`. Permission: wizard, or actor owns the object
  // and is creating a property owned by themselves (matches the
  // existing definePropertyChecked rules).
  async addPropertyForActor(actor: ObjRef, objRef: ObjRef, name: string, value: WooValue, info: WooValue): Promise<void> {
    const map = info && typeof info === "object" && !Array.isArray(info) ? info as Record<string, WooValue> : null;
    const owner = typeof map?.owner === "string" ? map.owner : actor;
    const perms = typeof map?.perms === "string" ? map.perms : "rw";
    const typeHint = typeof map?.type_hint === "string" ? map.type_hint : typeHintForValue(value);
    this.recordAuthoredPropertyRead(objRef, name, this.authoredPropertyCellValue(objRef, name));
    await this.definePropertyChecked(actor, objRef, {
      name,
      defaultValue: value,
      owner,
      perms,
      typeHint
    });
    this.recordAuthoredPropertyWrite(objRef, name, this.authoredPropertyCellValue(objRef, name));
  }

  // LambdaMOO `delete_property(obj, name)`. Removes a property
  // definition from `objRef`. Permission: wizard, owner of the object,
  // or owner of the property.
  async deletePropertyForActor(actor: ObjRef, objRef: ObjRef, name: string): Promise<void> {
    this.recordAuthoredPropertyRead(objRef, name, this.authoredPropertyCellValue(objRef, name));
    await this.undefinePropertyChecked(actor, objRef, name);
    this.recordAuthoredPropertyWrite(objRef, name, this.authoredPropertyCellValue(objRef, name));
  }

  // LambdaMOO `set_property_info(obj, name, info)`. Updates owner /
  // perms / type_hint on a property's definition (the class where it
  // was defined). Permission rules per setPropertyInfoChecked.
  async setPropertyInfoForActor(actor: ObjRef, objRef: ObjRef, name: string, info: WooValue): Promise<void> {
    const map = info && typeof info === "object" && !Array.isArray(info) ? info as Record<string, WooValue> : null;
    if (!map) throw wooError("E_INVARG", "set_property_info expects info map", info);
    this.recordAuthoredPropertyRead(objRef, name, this.authoredPropertyCellValue(objRef, name));
    await this.setPropertyInfoChecked(actor, objRef, name, map);
    this.recordAuthoredPropertyWrite(objRef, name, this.authoredPropertyCellValue(objRef, name));
  }

  // LambdaMOO `is_clear_property(obj, name)`. Returns true iff the
  // property is currently inherited (no local value override) — i.e.,
  // reads on `obj` would resolve to a parent's default value. Raises
  // E_PROPNF if the property is not defined anywhere on the chain.
  isClearProperty(objRef: ObjRef, name: string): boolean {
    this.propertyInfo(objRef, name);
    return !this.objectLive(objRef).properties.has(name);
  }

  // LambdaMOO `clear_property(obj, name)`. Removes the local value
  // override for `name` on `objRef`, so reads revert to the inherited
  // default from the property's definition. Raises E_PROPNF if the
  // property is not defined anywhere on the chain. Already-clear
  // properties succeed as a no-op (idempotent). Permission: wizard,
  // owner of the property, or "w" perm.
  clearPropertyForActor(actor: ObjRef, objRef: ObjRef, name: string): void {
    // propertyInfo raises E_PROPNF if the property isn't defined on the chain.
    this.propertyInfo(objRef, name);
    if (!this.canWriteProperty(actor, objRef, name)) {
      throw wooError("E_PERM", `${actor} cannot clear ${objRef}.${name}`, { actor, obj: objRef, property: name });
    }
    const obj = this.objectLive(objRef);
    if (!obj.properties.has(name)) return;
    const beforeVersion = this.propertyVersionForRecording(objRef, name);
    const presenceProjection = this.presenceProjectionForProperty(objRef, name);
    this.withBehaviorMutationPermit(() => {
      obj.properties.delete(name);
      obj.propertyVersions.set(name, (obj.propertyVersions.get(name) ?? 0) + 1);
      obj.modified = Date.now();
    });
    if (presenceProjection) {
      this.invalidatePresenceIndex();
    } else {
      // Record the local-override removal as a `prop` cell_write with
      // op "remove". This was the missing emitter half of the remove op:
      // the appliers (applyTranscriptPropWrite, the net coherence layer)
      // have always handled op "remove", but no turn path recorded one,
      // so a verb calling clear_property mutated state invisibly to the
      // transcript — an unnamed divergence for every commit/replay
      // consumer. `value` carries the post-remove effective value (the
      // now-inherited default), which is what post-state validation
      // (writeValueMatchesPostState) reads back from the applied world.
      // Clearing a property whose def lives on this object itself leaves
      // no readable value anywhere on the chain (getProp raises E_PROPNF
      // the same way — clear_property is meant for inherited defs, per
      // LambdaMOO); record null for that edge rather than failing the
      // clear. The recorder pipeline attaches the VM frame's write
      // authority (recordedEventWithWriter), same as every cell_write.
      let effective: WooValue = null;
      try {
        effective = readObjectPropertyValue({
          object: obj,
          name,
          lookupParent: (parent, start) => this.parentWalkLookup(start, parent),
          propertyNotFound: () => wooError("E_PROPNF", `property not found: ${name}`, name)
        });
      } catch {
        effective = null;
      }
      this.recordTurnEvent({
        kind: "cell_write",
        cell: { kind: "prop", object: objRef, name },
        value: cloneValue(effective),
        op: "remove",
        prior: beforeVersion === undefined ? undefined : String(beforeVersion),
        next: String(this.propertyVersionForRecording(objRef, name))
      });
    }
    this.persistObject(objRef);
    this.persist();
  }

  // Authoring inspection / search aggregations. Surface-check is done
  // at the catalog layer; these helpers do not enforce builder /
  // programmer authority. `includeSource` gates whether verb source
  // is included in the result.
  authoringInspectFor(actor: ObjRef, objRef: ObjRef, opts: WooValue, includeSource: boolean): WooValue {
    return this.authoringInspect(actor, objRef, opts, { includeSourceAllowed: includeSource, requireProgrammer: false });
  }

  authoringSearchFor(actor: ObjRef, query: string, opts: WooValue, includeSource: boolean): WooValue {
    return this.authoringSearch(actor, query, opts, { includeSourceAllowed: includeSource });
  }

  // Pure compile pass — no permissions, no mutation. Returns the same
  // shape catalog dry-run paths use. Used by editor preview.
  compileVerbForCheck(source: string): Record<string, WooValue> {
    const compiled = compileVerb(source);
    if (!compiled.ok || !compiled.bytecode) {
      return {
        ok: false,
        diagnostics: compiled.diagnostics as unknown as WooValue,
        metadata: (compiled.metadata ?? null) as WooValue
      };
    }
    return {
      ok: true,
      diagnostics: [] as WooValue,
      source_hash: compiled.source_hash ?? hashSource(source),
      line_map: (compiled.line_map ?? {}) as WooValue,
      metadata: (compiled.metadata ?? null) as WooValue
    };
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
    const { definer, verb } = this.resolveVerbLive(objRef, name);
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
      const obj = this.objectLive(objRef);
      return {
        name,
        owner: obj.owner,
        perms: "r",
        defined_on: objRef,
        type_hint: "obj",
        version: 1,
        value_version: 1,
        has_value: true
      };
    }
    // The `name` attribute is the substrate's display label (see getProp's
    // matching fallback). When neither this object nor any ancestor has an
    // explicit `name` property def, synthesize property info backed by
    // the attribute so canReadProperty doesn't reject the lookup.
    // Without this, $system.name (no def in parent chain) raises E_PROPNF
    // through canReadProperty before getProp's attribute fallback runs.
    {
      const obj = this.objectLive(objRef);
      let walker: ObjRef | null = objRef;
      let hasDef = false;
      while (walker) {
        const ancestor: WooObject | null = walker === objRef ? obj : this.parentWalkLookup(objRef, walker);
        if (!ancestor) break;
        if (ancestor.propertyDefs.has(name)) { hasDef = true; break; }
        walker = ancestor.parent;
      }
      if (!hasDef && name === "name") {
        return {
          name,
          owner: obj.owner,
          perms: "r",
          defined_on: objRef,
          type_hint: "str",
          version: 1,
          value_version: 1,
          has_value: true
        };
      }
    }
    let current: ObjRef | null = objRef;
    while (current) {
      const obj: WooObject | null = current === objRef ? this.objectLive(current) : this.parentWalkLookup(objRef, current);
      if (!obj) break;
      const def = obj.propertyDefs.get(name);
      if (def) {
        return {
          name,
          owner: def.owner,
          perms: def.perms,
          defined_on: current,
          type_hint: def.typeHint ?? null,
          version: def.version,
          // value_version bumps on every write (per setPropLocal),
          // independently of the def version. Catalog code uses this
          // field for optimistic-concurrency checks (e.g. @set's
          // opts.expected_version): the def version doesn't change
          // when a value is updated, so it isn't the right key for
          // stale-write rejection.
          value_version: this.objectLive(objRef).propertyVersions.get(name) ?? 0,
          has_value: this.objectLive(objRef).properties.has(name)
        };
      }
      current = obj.parent;
    }
    const target = this.objectLive(objRef);
    if (target.properties.has(name)) {
      const valueVersion = target.propertyVersions.get(name) ?? 1;
      return {
        name,
        owner: target.owner,
        perms: "",
        defined_on: objRef,
        type_hint: null,
        version: valueVersion,
        value_version: valueVersion,
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
    return this.cloneSessionView(this.authLive(token));
  }

  private authLive(token: string): Session {
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
      if (token.startsWith("bearer:")) {
        return this.authBearer(token.slice("bearer:".length));
      }
      const tokenClass = this.tokenClassFor(token);
      const actor = this.allocateGuest();
      this.placeAllocatedGuest(actor);
      return this.createSessionForActorLive(actor, tokenClass);
    }

  // Move a freshly-allocated guest into the room named by `$system.guest_initial_room`,
  // if one is configured and the guest is currently sitting at $nowhere. The
  // property is catalog-set; core stays catalog-agnostic and falls through
  // silently when it is unset.
  private placeAllocatedGuest(actor: ObjRef): void {
    const obj = this.objects.get(actor);
    if (!obj) return;
    if (obj.location && obj.location !== "$nowhere") return;
    const configured = this.propOrNullLive("$system", "guest_initial_room");
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
    const routed = parseRoutedApiKeyId(id);
    if (routed && (!this.objects.has(routed.actor) || this.authorityAnchorRoot(routed.actor) !== routed.authorityRoot)) {
      throw wooError("E_NOSESSION", "apikey not found or revoked");
    }
    const keys = routed
      ? this.apiKeyMap(routed.actor)
      : this.legacyApiKeyMap();
    const record = keys[id];
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
      if (!this.actorCanAuthenticate(actor)) throw wooError("E_NOSESSION", "apikey actor is deactivated");
      const presented = hashSource(`${salt}:${secret}`);
    if (!constantTimeEqual(presented, expected)) throw wooError("E_NOSESSION", "apikey secret rejected");
      // Record liveness so :look on a block can render "plug last seen Ns ago"
      // without needing extra state. last_seen_at is per-key, not per-session;
      // a key with N concurrent sessions still gets one timestamp.
      this.touchApiKeyLastSeen(id, routed?.actor ?? null);
      if (this.isAgentObject(actor)) this.setProp(actor, "last_seen_at", Date.now());
      return this.createSessionForActorLive(actor, "apikey", id);
    }

    private authBearer(token: string): Session {
      if (!token) throw wooError("E_NOSESSION", "bearer token is empty");
    this.gcPendingCredentials();
      const raw = this.propOrNullLive("$system", "bearer_tokens");
      const map = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, WooValue> : {};
      const tokenHash = this.bearerTokenHash(token);
      let record = map[tokenHash];
      let storageKey = tokenHash;
      if (!record && map[token]) {
        record = map[token];
        storageKey = token;
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) throw wooError("E_NOSESSION", "bearer token is expired or unknown");
      const r = record as Record<string, WooValue>;
      const actor = String(r.actor ?? "");
      const expiresAt = Number(r.expires_at ?? 0);
      if (!actor || !this.objects.has(actor) || expiresAt <= Date.now()) {
        this.setProp("$system", "bearer_tokens", Object.fromEntries(Object.entries(map).filter(([key]) => key !== storageKey)) as WooValue);
        throw wooError("E_NOSESSION", "bearer token is expired or unknown");
      }
      if (!this.actorCanAuthenticate(actor)) throw wooError("E_NOSESSION", "bearer actor is deactivated");
      if (storageKey !== tokenHash || r.token_hash !== tokenHash) {
        const migrated = { ...map };
        delete migrated[storageKey];
        migrated[tokenHash] = { ...r, token_hash: tokenHash } as WooValue;
        this.setProp("$system", "bearer_tokens", migrated as WooValue);
      }
      return this.createSessionForActorLive(actor, "bearer");
    }

  /** Wizard-only: mint an apikey bound to any $actor descendant. */
  createApiKey(actor: ObjRef, target: ObjRef, label: string | null): { id: string; secret: string; actor: ObjRef; label: string | null; created_at: number } {
    if (!this.canBypassPerms(actor)) throw wooError("E_PERM", "wizard authority required to create api keys", { actor });
    this.assertApiKeyTarget(target);
    return this.createApiKeyRecord(actor, target, label, "create_api_key");
  }

  /**
   * Compatibility-image constructor for tests and pre-Net donor worlds.
   *
   * This deliberately synthesizes the historical global registry so identity
   * carry and old-key authentication remain testable. It is not a live-world
   * issuance path: catalogs use createApiKey/createApiKeyForOwner, while Net
   * operator bootstrap uses the internal-signed credential ensure route.
   *
   * @deprecated New credentials must use an actor-owned issuance path.
   */
  ensureApiKey(actor: ObjRef, target: ObjRef, id: string, secret: string, label: string | null): { id: string; secret: string; actor: ObjRef; label: string | null; created_at: number; created: boolean } {
    if (!this.canBypassPerms(actor)) throw wooError("E_PERM", "wizard authority required to ensure api keys", { actor });
    if (!this.objects.has(target)) throw wooError("E_OBJNF", `target actor not found: ${target}`, target);
    if (!this.isActorDescendant(target)) throw wooError("E_TYPE", `target must be an $actor descendant: ${target}`, target);
    if (!id || id.includes(":")) throw wooError("E_INVARG", "apikey id must be non-empty and must not contain ':'", { id });
    if (!secret) throw wooError("E_INVARG", "apikey secret must be non-empty");

    const raw = this.propOrNullLive("$system", "api_keys");
    const map = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, WooValue>) } : {};
    const existing = map[id];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      const record = existing as Record<string, WooValue>;
      if (record.actor !== target) throw wooError("E_PERM", "apikey id is already bound to a different actor", { id, actor: record.actor, target });
      if (record.revoked_at != null) throw wooError("E_PERM", "apikey id is revoked and cannot be reused", { id, target });
      const salt = String(record.salt ?? "");
      const expected = String(record.hash ?? "");
      if (!salt || !expected || !constantTimeEqual(hashSource(`${salt}:${secret}`), expected)) {
        throw wooError("E_PERM", "apikey id exists with a different secret", { id, target });
      }
      return {
        id,
        secret,
        actor: target,
        label: typeof record.label === "string" ? record.label : null,
        created_at: Number(record.created_at ?? 0),
        created: false
      };
    }
    if (existing !== undefined) throw wooError("E_TYPE", "apikey record is malformed", { id });

    const salt = randomHex(16);
    const hash = hashSource(`${salt}:${secret}`);
    const created_at = Date.now();
    map[id] = { hash, salt, actor: target, label: label ?? null, created_at } as WooValue;
    this.setProp("$system", "api_keys", map as WooValue);
    this.recordWizardAction(actor, "ensure_api_key", { actor: target, key_id: id, label: label ?? null });
    return { id, secret, actor: target, label, created_at, created: true };
  }

  /** Owner-mint: the owner of `target` may mint an apikey bound to `target`.
   * This is the path catalog code (e.g. `$block:mint_apikey`) uses so blocks
   * can be configured by their creator without wizard escalation. */
  createApiKeyForOwner(actor: ObjRef, target: ObjRef, label: string | null): { id: string; secret: string; actor: ObjRef; label: string | null; created_at: number } {
    this.assertApiKeyTarget(target);
    if (!this.canBypassPerms(actor) && this.objectLive(target).owner !== actor) {
      throw wooError("E_PERM", "owner-mint requires the calling actor to own the target", { actor, target });
    }
    return this.createApiKeyRecord(actor, target, label, "create_api_key_for_owner");
  }

  private createApiKeyRecord(actor: ObjRef, target: ObjRef, label: string | null, auditAction: string): { id: string; secret: string; actor: ObjRef; label: string | null; created_at: number } {
    const authorityRoot = this.assertApiKeyAuthorityRoot(target);
    const id = routedApiKeyId(authorityRoot, target, randomHex(16));
    const secret = randomHex(32);
    const salt = randomHex(16);
    const hash = hashSource(`${salt}:${secret}`);
    const created_at = Date.now();
    const map = { ...this.apiKeyMap(target) };
    map[id] = {
      hash,
      salt,
      actor: target,
      label: label ?? null,
      created_at,
      created_by: actor,
      created_via: auditAction
    } as WooValue;
    // The actor-owned record (including created_at) is the durable issuance
    // audit in every runtime profile; Net additionally retains the accepted
    // transcript. Writing `$system.wizard_actions` here would reintroduce the
    // catalog mutation that Net correctly refuses for ordinary turns.
    this.setProp(target, "api_keys", map as WooValue);
    return { id, secret, actor: target, label, created_at };
  }

  /**
   * Validate every graph invariant that routed-key construction can reject.
   * Rotation calls this before revoking the old credential; issuance repeats
   * it at its public boundary so the invariant has one definition.
   */
  private assertApiKeyIssuable(target: ObjRef): void {
    this.assertApiKeyTarget(target);
    this.assertApiKeyAuthorityRoot(target);
  }

  private assertApiKeyTarget(target: ObjRef): void {
    if (!this.objects.has(target)) throw wooError("E_OBJNF", `target actor not found: ${target}`, target);
    if (!this.isActorDescendant(target)) throw wooError("E_TYPE", `target must be an $actor descendant: ${target}`, target);
  }

  private assertApiKeyAuthorityRoot(target: ObjRef): ObjRef {
    const authorityRoot = this.authorityAnchorRoot(target);
    // n1 ids have one intentionally narrow routing grammar: catalog seed
    // roots route to `catalog`; concrete actor roots route to their cluster.
    // Refuse every other anchor shape instead of reproducing CO15's full
    // class classifier in core. In particular, an actor anchored under a
    // room must not mint an id that falsely names `cluster:<room>`.
    if (!authorityRoot.startsWith("$") && !this.isActorDescendant(authorityRoot)) {
      throw wooError(
        "E_LINEAGE",
        "apikey authority root must be catalog identity or an $actor descendant",
        { actor: target, authority_root: authorityRoot }
      );
    }
    return authorityRoot;
  }

  private touchApiKeyLastSeen(id: string, actor: ObjRef | null): void {
    const map = actor ? this.apiKeyMap(actor) : this.legacyApiKeyMap();
    const rec = map[id];
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return;
    const updated = { ...(rec as Record<string, WooValue>), last_seen_at: Date.now() };
    this.setProp(actor ?? "$system", "api_keys", { ...map, [id]: updated as WooValue });
  }

  /** Mark an apikey revoked and tear down any sessions minted from it.
   * Keeps the record (with revoked_at) for audit. Authorized for wizards
   * unconditionally and for the owner of the bound actor (so the same actor
   * who could mint can also revoke). */
  revokeApiKey(actor: ObjRef, id: string): boolean {
    return this.revokeApiKeyWithClosedSessions(actor, id).revoked;
  }

  private revokeApiKeyWithClosedSessions(actor: ObjRef, id: string): { revoked: boolean; closedSessions: Session[] } {
    const routed = parseRoutedApiKeyId(id);
    if (routed && (!this.objects.has(routed.actor) || this.authorityAnchorRoot(routed.actor) !== routed.authorityRoot)) {
      return { revoked: false, closedSessions: [] };
    }
    const map = routed ? this.apiKeyMap(routed.actor) : this.legacyApiKeyMap();
    const rec = map[id];
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { revoked: false, closedSessions: [] };
    const r = rec as Record<string, WooValue>;
    const targetActor = String(r.actor ?? "");
    const isWizard = this.canBypassPerms(actor);
    const isOwner = targetActor && this.objects.has(targetActor) && this.objectLive(targetActor).owner === actor;
    if (!isWizard && !isOwner) {
      throw wooError("E_PERM", "revoke requires wizard authority or ownership of the bound actor", { actor, key_id: id });
    }
    return this.revokeApiKeyRecord(actor, id, map, r, targetActor, routed?.actor ?? null, true);
  }

  private revokeApiKeyRecord(
    actor: ObjRef,
    id: string,
    map: Record<string, WooValue>,
    record: Record<string, WooValue>,
    targetActor: ObjRef,
    recordOwner: ObjRef | null,
    closeSessions: boolean
  ): { revoked: boolean; closedSessions: Session[] } {
    if (record.revoked_at != null) return { revoked: false, closedSessions: [] }; // already revoked — caller can disambiguate via listApiKeys
    const updated = { ...record, revoked_at: Date.now(), revoked_by: actor };
    this.setProp(recordOwner ?? "$system", "api_keys", { ...map, [id]: updated as WooValue });
    const closedSessions = closeSessions ? this.closeSessionsForApiKey(id) : [];
    if (recordOwner) {
      // The actor-owned write and authenticated transcript are the durable
      // audit record. Do not append `$system.wizard_actions`: that catalog
      // mutation is exactly what the Net-safe path must avoid.
    } else {
      // Compatibility keys remain catalog-owned until rotated. This path is
      // retained for in-memory/SQLite and the signed migration lane; an
      // ordinary Net turn still refuses the catalog write.
      this.recordWizardAction(actor, "revoke_api_key", { key_id: id, actor: targetActor });
    }
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

  private closeSessionsForActor(actor: ObjRef): Session[] {
    const matches = this.liveSessionsForActor(actor).map((session) => ({ ...session, attachedSockets: new Set(session.attachedSockets) }));
    for (const session of matches) this.reapSession(session.id);
    if (matches.length > 0) this.persist(true);
    return matches;
  }

  /** Wizard-only compatibility view of the historical global registry.
   * Actor-owned authorities are deliberately not globally enumerable. */
  listApiKeys(actor: ObjRef): Array<{ id: string; actor: ObjRef; label: string | null; created_at: number; last_seen_at: number | null; revoked_at: number | null }> {
    if (!this.canBypassPerms(actor)) throw wooError("E_PERM", "wizard authority required to list api keys", { actor });
    return this.collectApiKeyMetadata();
  }

  /** Owner-scoped: list apikeys for actors the caller owns. Useful for
   * `$block:list_apikeys` so a block's owner can audit "is my plug
   * connected and which key did it use?" without wizard authority. */
  listApiKeysForOwner(actor: ObjRef, target: ObjRef): Array<{ id: string; actor: ObjRef; label: string | null; created_at: number; last_seen_at: number | null; revoked_at: number | null }> {
    if (!this.objects.has(target)) {
      throw wooError("E_OBJNF", `apikey listing target not found: ${target}`, target);
    }
    if (!this.isActorDescendant(target)) {
      throw wooError("E_TYPE", `apikey listing target must be an $actor descendant: ${target}`, target);
    }
    if (!this.canBypassPerms(actor) && this.objectLive(target).owner !== actor) {
      throw wooError("E_PERM", "apikey listing requires wizard authority or ownership of the bound actor", { actor, target });
    }
    return this.collectApiKeyMetadata(this.apiKeyMap(target));
  }

  private collectApiKeyMetadata(map: Record<string, WooValue> = this.legacyApiKeyMap()): Array<{ id: string; actor: ObjRef; label: string | null; created_at: number; last_seen_at: number | null; revoked_at: number | null }> {
    const out: Array<{ id: string; actor: ObjRef; label: string | null; created_at: number; last_seen_at: number | null; revoked_at: number | null }> = [];
    for (const [id, rec] of Object.entries(map)) {
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

  private legacyApiKeyMap(): Record<string, WooValue> {
    const raw = this.propOrNullLive("$system", "api_keys");
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, WooValue>
      : {};
  }

  private apiKeyMap(actor: ObjRef): Record<string, WooValue> {
    const raw = this.propOrNullLive(actor, "api_keys");
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, WooValue>
      : {};
  }

  /** One semantic predicate for credential APIs; callers should not repeat
   * the seed-class identity that the layering guard deliberately budgets. */
  private isActorDescendant(object: ObjRef): boolean {
    return this.inheritsFrom(object, "$actor");
  }

  /** Immutable anchor root encoded into new public key ids. The same walk
   * defines Net's actor cluster, so a gateway can route before it has any
   * actor cells. */
  /** The terminal of an object's immutable `anchor` chain, or the object
   *  itself when unanchored. This is the object's authority root — the cluster
   *  its cells belong to. Used both to route self-routing api-key ids and to
   *  co-locate a runtime object with its author (createRuntimeObject). */
  private authorityAnchorRoot(actor: ObjRef): ObjRef {
    let root = actor;
    const seen = new Set<ObjRef>();
    while (this.objects.has(root)) {
      if (seen.has(root)) throw wooError("E_LINEAGE", "authority anchor cycles", { actor, root });
      seen.add(root);
      const anchor = this.objectLive(root).anchor;
      if (!anchor) return root;
      root = anchor;
    }
    throw wooError("E_LINEAGE", "authority anchor leaves the object graph", { actor, root });
  }

  async beginSignup(emailInput: string, password: string, options: { inviteCode?: string | null; signupMethod?: string } = {}): Promise<SignupStartResult> {
    this.gcPendingCredentials();
    const email = normalizeEmail(emailInput);
    if (!email) throw wooError("E_INVARG", "signup requires an email address");
    if (password.length < 8) throw wooError("E_INVARG", "password must be at least 8 characters");
    if (this.findAccountByEmail(email)) throw wooError("E_EXISTS", "account already exists for email", email);
    if (this.propOrNullLive("$system", "signup_invite_required") === true) this.consumeSignupInvite(options.inviteCode ?? null);

    const account = this.createProvisionedObjectId("account");
    const now = Date.now();
    const verifier = await hashPassword(password);
    this.createObject({ id: account, name: email, parent: "$account", owner: "$wiz", location: null });
    this.setProp(account, "name", email);
    this.setProp(account, "email", email);
    this.setProp(account, "password_salt", verifier.salt);
    this.setProp(account, "password_hash", verifier.encoded);
    this.setProp(account, "agent_quota", this.systemInt("default_agent_quota", 5));
    this.setProp(account, "programmer_grant_quota", this.systemInt("default_programmer_grant_quota", 0));
    this.setProp(account, "agent_count", 0);
    this.setProp(account, "programmer_agent_count", 0);
    this.setProp(account, "signup_method", options.signupMethod ?? (options.inviteCode ? "invite" : "turnstile_email"));
    this.setProp(account, "created_at", now);

    const token = randomHex(32);
    const expiresAt = now + 24 * 60 * 60_000;
    const pending = this.pendingEmailVerifications()
      .filter((entry) => entry.account_id !== account)
      .concat([{ token_hash: hashSource(token), account_id: account, expires_at: expiresAt }]);
    this.setProp("$system", "pending_email_verifications", pending as unknown as WooValue);
    this.recordWizardAction("$system", "signup_started", { account, email });
    return { account, email, verification_token: token, verification_expires_at: expiresAt };
  }

  verifySignup(token: string, guestSessionId?: string | null): SignupVerifyResult {
    const now = Date.now();
    this.gcPendingCredentials(now);
    const pending = this.pendingEmailVerifications();
    const tokenHash = hashSource(token);
    const index = pending.findIndex((entry) => entry.token_hash === tokenHash);
    if (index < 0) throw wooError("E_NOSESSION", "verification token is unknown");
    const entry = pending[index];
    if (entry.expires_at < now) throw wooError("E_TOKEN_EXPIRED", "verification token has expired");
    const account = entry.account_id;
    this.objectLive(account);
    let actor: ObjRef | null = null;
    let promotedGuest = false;
    if (guestSessionId) {
      const session = this.sessions.get(guestSessionId);
      if (session && this.objects.has(session.actor) && this.inheritsFrom(session.actor, "$guest")) {
        actor = session.actor;
        this.withBehaviorMutationPermit(() => this.guestFreePool.delete(actor!));
        this.chparentLocal(actor, "$human");
        this.withBehaviorMutationPermit(() => {
          this.objectLive(actor!).owner = actor!;
        });
        this.markObjectDirty(actor);
        promotedGuest = true;
      }
    }
    if (!actor) {
      actor = this.provisionActorInternal("$human", "$wiz", { account, name: this.accountDisplayName(account), created_via: "signup" }, "$system").actor;
    }
    this.bindHumanToAccount(actor, account, now);
    this.setProp("$system", "pending_email_verifications", pending.filter((_, i) => i !== index) as unknown as WooValue);
    const bearer = this.issueBearerToken(actor, account);
    const session = this.createSessionForActorLive(actor, "bearer");
    this.recordWizardAction("$system", "signup_verified", { account, actor, promoted_guest: promotedGuest });
    return { account, actor, bearer, session, promoted_guest: promotedGuest };
  }

  async authenticatePassword(emailInput: string, password: string): Promise<PasswordAuthResult> {
    this.gcPendingCredentials();
    const email = normalizeEmail(emailInput);
    const account = this.findAccountByEmail(email);
    if (!account) throw wooError("E_NOSESSION", "invalid email or password");
    if (this.propOrNullLive(account, "deactivated_at") != null) throw wooError("E_NOSESSION", "account is deactivated");
    const expected = String(this.propOrNullLive(account, "password_hash") ?? "");
    if (!await verifyPassword(password, expected)) {
      throw wooError("E_NOSESSION", "invalid email or password");
    }
    const actor = assertObj(this.propOrNullLive(account, "primary_actor"));
    if (!this.actorCanAuthenticate(actor)) throw wooError("E_NOSESSION", "actor is deactivated");
    const bearer = this.issueBearerToken(actor, account);
    const session = this.createSessionForActorLive(actor, "bearer");
    return { account, actor, bearer, session };
  }

  connectHermes(actor: ObjRef, returnUrl: string, state: string, profileId: string, options: { force?: boolean } = {}): HermesConnectResult {
    if (!this.isHumanObject(actor)) throw wooError("E_PERM", "Hermes connect requires a human session", actor);
    if (!returnUrl || !this.allowedProvisionReturn(returnUrl)) throw wooError("E_INVARG", "return URL scheme is not allowed", returnUrl);
    if (!state) throw wooError("E_INVARG", "state nonce is required");
    if (!profileId) throw wooError("E_INVARG", "profile_id is required");
    this.consumeProvisionState(state);
    const account = assertObj(this.propOrNullLive(actor, "account"));
    let agent = this.findHermesAgent(actor, profileId);
    let created = false;
    let apiKeyResult: { id: string; secret: string; actor: ObjRef; label: string | null; created_at: number };
    if (!agent) {
      const result = this.createAgentForHuman(actor, `hermes-${profileId.slice(0, 8)}`, "Hermes profile", false, {
        created_via: "hermes_provision",
        profile_id: profileId
      });
      agent = result.actor_id;
      apiKeyResult = { id: result.api_key_id, secret: result.api_key_secret, actor: agent, label: result.label, created_at: result.created_at };
      created = true;
    } else {
      const rotated = this.rotateAgentKey(actor, agent, options.force === true);
      apiKeyResult = { id: rotated.id, secret: rotated.secret, actor: agent, label: rotated.label, created_at: rotated.created_at };
    }
    const api_key = `apikey:${apiKeyResult.id}:${apiKeyResult.secret}`;
    const mcp_url = String(this.propOrNullLive("$system", "mcp_endpoint_url") ?? "/mcp");
    const redirect_url = appendQuery(returnUrl, { state, actor_id: agent, api_key, mcp_url });
    this.recordWizardAction(actor, created ? "hermes_agent_created" : "hermes_agent_reconnected", { account, actor: agent, profile_id: profileId });
    return { actor_id: agent, api_key, mcp_url, redirect_url, created };
  }

  private issueBearerToken(actor: ObjRef, account: ObjRef): string {
    this.gcPendingCredentials();
    const token = randomHex(32);
    const tokenHash = this.bearerTokenHash(token);
    const expiresAt = Date.now() + 60 * 60_000;
    const raw = this.propOrNullLive("$system", "bearer_tokens");
    const map = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, WooValue>) } : {};
    map[tokenHash] = { token_hash: tokenHash, actor, account, expires_at: expiresAt, created_at: Date.now() } as WooValue;
    this.setProp("$system", "bearer_tokens", map as WooValue);
    return `bearer:${token}`;
  }

  private bearerTokenHash(token: string): string {
    return hashSource(`bearer:${token}`);
  }

  private actorCanAuthenticate(actor: ObjRef): boolean {
    if (!this.objects.has(actor)) return false;
    if (this.propOrNullLive(actor, "deactivated_at") != null) return false;
    if (this.inheritsFrom(actor, "$human")) {
      const account = this.propOrNullLive(actor, "account");
      return typeof account === "string" && this.objects.has(account) && this.propOrNullLive(account, "deactivated_at") == null;
    }
    if (this.inheritsFrom(actor, "$agent")) {
      const owner = this.propOrNullLive(actor, "owner");
      if (owner === "$wiz") return true;
      if (typeof owner !== "string" || !this.objects.has(owner)) return false;
      return this.actorCanAuthenticate(owner);
    }
    return true;
  }

  gcPendingCredentials(now = Date.now()): boolean {
    let changed = false;
    const bearerRaw = this.propOrNullLive("$system", "bearer_tokens");
    if (bearerRaw && typeof bearerRaw === "object" && !Array.isArray(bearerRaw)) {
      const next: Record<string, WooValue> = {};
      for (const [key, record] of Object.entries(bearerRaw as Record<string, WooValue>)) {
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          changed = true;
          continue;
        }
        const r = record as Record<string, WooValue>;
        if (Number(r.expires_at ?? 0) <= now) {
          changed = true;
          continue;
        }
        const tokenHash = typeof r.token_hash === "string" && r.token_hash
          ? r.token_hash
          : this.bearerTokenHash(key);
        if (tokenHash !== key || r.token_hash !== tokenHash) changed = true;
        next[tokenHash] = { ...r, token_hash: tokenHash } as WooValue;
      }
      if (changed || Object.keys(next).length !== Object.keys(bearerRaw as Record<string, WooValue>).length) {
        this.setProp("$system", "bearer_tokens", next as WooValue);
        changed = true;
      }
    }
    const pendingRaw = this.propOrNullLive("$system", "pending_email_verifications");
    if (Array.isArray(pendingRaw)) {
      const next = pendingRaw.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && Number((entry as Record<string, WooValue>).expires_at ?? 0) > now);
      if (next.length !== pendingRaw.length) {
        this.setProp("$system", "pending_email_verifications", next as WooValue);
        changed = true;
      }
    }
    const statesRaw = this.propOrNullLive("$system", "provision_state_nonces");
    if (Array.isArray(statesRaw)) {
      const next = statesRaw.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && Number((entry as Record<string, WooValue>).issued_at ?? 0) + PROVISION_STATE_TTL_MS >= now);
      if (next.length !== statesRaw.length) {
        this.setProp("$system", "provision_state_nonces", next as WooValue);
        changed = true;
      }
    }
    const invitesRaw = this.propOrNullLive("$system", "signup_invites");
    if (Array.isArray(invitesRaw)) {
      const next = invitesRaw.filter((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        const map = entry as Record<string, WooValue>;
        if (map.used_by == null) return Number(map.expires_at ?? 0) >= now;
        return Number(map.used_at ?? map.expires_at ?? 0) + SIGNUP_INVITE_AUDIT_TTL_MS >= now;
      });
      if (next.length !== invitesRaw.length) {
        this.setProp("$system", "signup_invites", next as WooValue);
        changed = true;
      }
    }
    return changed;
  }

  private pendingEmailVerifications(): Array<{ token_hash: string; account_id: ObjRef; expires_at: number }> {
    const raw = this.propOrNullLive("$system", "pending_email_verifications");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const map = entry as Record<string, WooValue>;
      return typeof map.token_hash === "string" && typeof map.account_id === "string"
        ? [{ token_hash: map.token_hash, account_id: map.account_id, expires_at: Number(map.expires_at ?? 0) }]
        : [];
    });
  }

  private consumeSignupInvite(code: string | null): void {
    if (!code) throw wooError("E_PERM", "invite code is required");
    const raw = this.propOrNullLive("$system", "signup_invites");
    const invites = Array.isArray(raw) ? raw : [];
    const now = Date.now();
    this.gcPendingCredentials(now);
    const index = invites.findIndex((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const map = entry as Record<string, WooValue>;
      return map.code === code && map.used_by == null && Number(map.expires_at ?? 0) >= now;
    });
    if (index < 0) throw wooError("E_PERM", "invite code is invalid or expired");
    const next = invites.slice();
    next[index] = { ...(next[index] as Record<string, WooValue>), used_by: "pending", used_at: now } as WooValue;
    this.setProp("$system", "signup_invites", next as WooValue);
  }

    private bindHumanToAccount(actor: ObjRef, account: ObjRef, now: number): void {
      this.setProp(account, "email_verified_at", now);
      this.setProp(account, "primary_actor", actor);
      // Authority root (the single-human supported lifecycle case): the account,
      // its human, and the human's owned agents share ONE authority scope so a
      // promote/demote turn commits atomically without a catalog write. Anchor
      // the account to the primary human; that anchor IS the family's authority
      // root (authorityRootOf derives it — no duplicate authority_root prop).
      // This runs once (first binding wins) while the account is still in-memory
      // and never yet carried/partitioned, so it is a provisioning-time
      // placement, not a scope migration. A multi-human account keeps its
      // original root: the anchor pins it, so later agents of a co-owning human
      // still land in the first human's cluster rather than splitting off.
      if (this.objectLive(account).anchor == null) {
        this.withBehaviorMutationPermit(() => {
          this.objectLive(account).anchor = actor;
          this.markObjectDirty(account);
        });
      }
      const actors = this.accountActors(account);
      if (!actors.includes(actor)) this.setProp(account, "actors", [...actors, actor]);
      this.setProp(actor, "account", account);
      this.setProp(actor, "name", this.accountDisplayName(account));
      // AU3.1 rule 1 at binding time: signup and guest→account promotion
      // rewrite the attribution (a promoted elastic guest must stop
      // attributing to `guest`). History does not move — records already
      // minted keep their stamped value.
      this.setCustomerOf(actor, { customer: account, derived_via: "account", bound_at: now });
    }

    private accountDisplayName(account: ObjRef): string {
      const email = String(this.propOrNullLive(account, "email") ?? account);
      return email.includes("@") ? email.slice(0, email.indexOf("@")) : email;
    }

    private findAccountByEmail(email: string): ObjRef | null {
      for (const obj of this.objects.values()) {
        if (!this.isAccountObject(obj.id)) continue;
        if (String(this.propOrNullLive(obj.id, "email") ?? "").toLowerCase() === email) return obj.id;
      }
      return null;
    }

    private isAccountObject(object: ObjRef): boolean {
      return this.objects.has(object) && this.inheritsFrom(object, "$account");
    }

    private isHumanObject(object: ObjRef): boolean {
      return this.objects.has(object) && this.inheritsFrom(object, "$human");
    }

    private isAgentObject(object: ObjRef): boolean {
      return this.objects.has(object) && this.inheritsFrom(object, "$agent");
    }

    private accountActors(account: ObjRef): ObjRef[] {
      const raw = this.propOrNullLive(account, "actors");
      return Array.isArray(raw) ? raw.filter((item): item is ObjRef => typeof item === "string") : [];
    }

    private systemInt(name: string, fallback: number): number {
      const value = Number(this.propOrNullLive("$system", name));
      return Number.isFinite(value) ? value : fallback;
    }

    private createProvisionedObjectId(prefix: string): ObjRef {
      let id: ObjRef;
      do {
        id = `${prefix}_${this.objectCounter++}`;
      } while (this.objects.has(id));
      this.persistCounters();
      return id;
    }

    /**
     * The authority root an owned actor anchors to: the family's shared root,
     * derived from the account's own anchor (the primary human it was bound to).
     * The anchor is the single source of truth — no duplicate authority_root
     * prop. Falls back to the human when the account is unset or an unmigrated
     * legacy account is still anchorless (so new agents anchor sanely even
     * before the co-location repair migration runs). Keeps every agent of one
     * human in that human's authority cluster.
     */
    private authorityRootOf(human: ObjRef): ObjRef {
      const account = this.propOrNullLive(human, "account");
      if (typeof account !== "string" || !this.objects.has(account)) return human;
      const root = this.authorityAnchorRoot(account);
      // An anchorless legacy account is its own root; fall back to the human.
      return root === account ? human : root;
    }

    /**
     * Local-boot repair: co-locate legacy anchorless authority families into
     * one cluster. A family provisioned before authority-root anchoring landed
     * has an anchorless account (catalog-scoped) and possibly anchorless owned
     * agents (own-cluster), so a promote/demote quota transition spans scopes.
     * This anchors each account to its primary human, then each of that human's
     * owned agents to the family root — the placement new provisioning already
     * gives them.
     *
     * Support boundary: local-boot / single-host only, because it sets the
     * anchor field in place. Net worlds receive correct placement from
     * install/cutover (identity carries `anchor`); re-anchoring already-
     * partitioned Net cells across Durable Objects is a spec-version scope
     * migration (migrations.md M6), out of scope here. Idempotent: every step
     * gates on a null anchor, so re-running repairs nothing. Returns the number
     * of objects re-anchored.
     */
    repairAuthorityFamilyColocation(): number {
      return this.withBehaviorMutationPermit(() => {
        let repaired = 0;
        // Pass 1: anchor each account to its primary human (the family root).
        for (const obj of this.objects.values()) {
          if (obj.anchor != null || !this.inheritsFrom(obj.id, "$account")) continue;
          const primary = this.propOrNullLive(obj.id, "primary_actor");
          if (typeof primary !== "string" || !this.objects.has(primary) || !this.inheritsFrom(primary, "$human")) continue;
          obj.anchor = primary;
          obj.modified = Date.now();
          this.markObjectDirty(obj.id);
          this.persistObject(obj.id);
          repaired += 1;
        }
        // Pass 2: anchor each human-owned agent to the family root. Accounts are
        // anchored now, so authorityRootOf resolves the shared root from them.
        for (const obj of this.objects.values()) {
          if (obj.anchor != null || !this.inheritsFrom(obj.id, "$agent")) continue;
          const owner = obj.owner;
          if (typeof owner !== "string" || !this.objects.has(owner) || !this.inheritsFrom(owner, "$human")) continue;
          const root = this.authorityRootOf(owner);
          if (root === obj.id) continue; // never self-anchor
          obj.anchor = root;
          obj.modified = Date.now();
          this.markObjectDirty(obj.id);
          this.persistObject(obj.id);
          repaired += 1;
        }
        if (repaired > 0) this.persist();
        return repaired;
      });
    }

    private provisionActorInternal(classRef: ObjRef, owner: ObjRef, attrs: Record<string, WooValue>, caller: ObjRef): { actor: ObjRef } {
      if (!this.objects.has(classRef)) throw wooError("E_OBJNF", `class not found: ${classRef}`, classRef);
      if (!this.inheritsFrom(classRef, "$actor")) throw wooError("E_TYPE", `class must descend from $actor: ${classRef}`, classRef);
      if (!this.objects.has(owner)) throw wooError("E_OBJNF", `owner not found: ${owner}`, owner);
      const prefix = classRef === "$human" ? "human" : classRef === "$agent" ? "agent" : "actor";
      const id = this.createProvisionedObjectId(prefix);
      const name = typeof attrs.name === "string" && attrs.name ? attrs.name : id;
      // Anchor an agent to its owning human's authority root so it co-locates
      // with the account + human in one cluster (the supported lifecycle). Set
      // at creation because anchors are never patched. Only when the owner is a
      // real $human root: a $wiz-owned agent has no human authority family, and
      // anchoring to $wiz would classify it to the catalog scope.
      const anchor = classRef === "$agent" && this.inheritsFrom(owner, "$human")
        ? this.authorityRootOf(owner)
        : null;
      this.createObject({ id, name, parent: classRef, owner, location: "$nowhere", anchor });
      this.setProp(id, "name", name);
      if (typeof attrs.description === "string") this.setProp(id, "description", attrs.description);
      if (classRef === "$human" && typeof attrs.account === "string") this.setProp(id, "account", attrs.account);
      if (classRef === "$agent") {
        this.setProp(id, "created_via", typeof attrs.created_via === "string" ? attrs.created_via : "wizard");
        this.setProp(id, "purpose", typeof attrs.purpose === "string" ? attrs.purpose : "");
        this.setProp(id, "scope", typeof attrs.scope === "string" ? attrs.scope : "write");
        if (typeof attrs.profile_id === "string") this.setProp(id, "profile_id", attrs.profile_id);
      }
      // AU3.1 at provisioning time: derive the new actor's attribution
      // while the owner/account binding is in hand (rule 1 for humans
      // with accounts, rule 2 for agents through their owner, rule 3 for
      // wizard-owned). An uncovered actor stays unattributed — a named
      // gap the audit trail surfaces, never a guess.
      const derived = deriveCustomerAttribution(this.attributionSource(), id);
      if (derived !== null) this.setCustomerOf(id, { ...derived, bound_at: Date.now() });
      // Routed through the profile audit adapter (AU1), not recordWizardAction
      // directly: `$system` is catalog-scoped on Net, so appending
      // wizard_actions here would make every provisioning turn an
      // E_CATALOG_MUTATION. Local/SQLite profiles still materialize the entry
      // through the default sink; on Net the accepted transcript is the record.
      this.recordProvisioningAudit(caller, "actor_provisioned", { actor: id, class: classRef, owner });
      return { actor: id };
    }

    private createAgentForHuman(
      human: ObjRef,
      name: string,
      purpose: string,
      programmer: boolean,
      attrs: Record<string, WooValue> = {}
    ): { actor_id: ObjRef; api_key: string; api_key_id: string; api_key_secret: string; label: string | null; created_at: number } {
      this.assertSelfHuman(human, human);
      const account = assertObj(this.propOrNullLive(human, "account"));
      if (this.propOrNullLive(account, "deactivated_at") != null) throw wooError("E_PERM", "account is deactivated", account);
      const quota = Number(this.propOrNullLive(account, "agent_quota") ?? 0);
      const count = Number(this.propOrNullLive(account, "agent_count") ?? 0);
      if (count >= quota) throw wooError("E_QUOTA_EXCEEDED", "agent quota exceeded", { account, quota, count });
      const agentClass: ObjRef = "$agent";
      if (programmer) {
        this.assertProgrammerAgentQuota(account);
        // A fresh agent inherits both its feature-list default and its kind
        // verbs from the agent class. Validate that prospective shape before an
        // object id is allocated: attachProgrammerSurface performs the same
        // checks after creation, but a collision there used to strand an
        // unregistered, credential-less actor.
        const surface = this.programmerSurface();
        if (surface) {
          this.featureList(agentClass);
          this.assertSurfaceComposable(agentClass, surface);
        }
      }
      const { actor } = this.provisionActorInternal(agentClass, human, { ...attrs, name, purpose }, human);
      if (programmer) {
        // Kind stays in ancestry ($agent); the authoring surface is composed on
        // as a feature (plan §4.1). Flag + feature + quota all mutate in this
        // one handler, so the turn transcript commits them atomically. The agent
        // is freshly provisioned in this scope, hence co-resident by
        // construction — no cross-host guard needed on the create path.
        this.withBehaviorMutationPermit(() => {
          this.objectLive(actor).flags.programmer = true;
        });
        this.markObjectDirty(actor);
        this.attachProgrammerSurface(actor);
      }
      const key = this.createApiKeyForOwner(human, actor, name);
      this.setProp(actor, "api_key_id", key.id);
      this.setProp(account, "actors", [...this.accountActors(account), actor]);
      this.setProp(account, "agent_count", count + 1);
      if (programmer) this.setProp(account, "programmer_agent_count", Number(this.propOrNullLive(account, "programmer_agent_count") ?? 0) + 1);
      // Same AU1 seam as provisionActorInternal above: the catalog `$system`
      // write is suppressed on Net and materialized everywhere else.
      this.recordProvisioningAudit(human, "actor_provisioned", { actor, owner: human, account, surface: "create_agent" });
      return { actor_id: actor, api_key: `apikey:${key.id}:${key.secret}`, api_key_id: key.id, api_key_secret: key.secret, label: key.label, created_at: key.created_at };
    }

    /**
     * The account map that makes operator wizard provisioning idempotent:
     * `provision_id` (an opaque operator-chosen token) -> the agent minted for
     * it. Bounded by the account's own agent quota, read from the account the
     * turn already touches, and never enumerated globally.
     */
    private operatorProvisionedAgents(account: ObjRef): Record<string, ObjRef> {
      const raw = this.propOrNullLive(account, "operator_provisioned_agents");
      // NULL-PROTOTYPE on purpose. A provision_id is operator-chosen text, so
      // it can be `constructor`, `toString`, or `__proto__`. On an ordinary
      // object `map[id]` would then resolve an INHERITED member — a lookup for
      // `constructor` returns `function Object()`, which the caller treats as a
      // recorded agent and dereferences. A null prototype has nothing to
      // inherit, so every read is an own-key read and every write (including
      // `__proto__`) defines an own property instead of hitting the accessor.
      const map: Record<string, ObjRef> = Object.create(null) as Record<string, ObjRef>;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
      // Object.entries is own-enumerable-keys only, so the stored cell cannot
      // smuggle inherited members in either.
      for (const [key, value] of Object.entries(raw as Record<string, WooValue>)) {
        if (typeof value === "string" && value) map[key] = value;
      }
      return map;
    }

    /**
     * When was this agent's account quota slot returned, or null if it is still
     * counted against `account.agent_count`?
     *
     * `deactivated_at` cannot answer this. It is an AUTHENTICATION fact — "this
     * identity may not sign in" — and it is REVERSIBLE
     * (`$system:reactivate_actor` clears it). Retirement is a different,
     * PERMANENT fact that happens to also set the auth tombstone. Reading one
     * as the other breaks both directions:
     *
     *  - reading `deactivated_at` as "slot returned" leaks the slot forever
     *    when `$system:deactivate_actor` tombstoned the agent first — that path
     *    never touches the counter, so nothing ever returns it;
     *  - reading it as "slot NOT returned" double-returns on a repeat revoke,
     *    letting the account mint past its quota.
     *
     * `retired_at` is the explicit marker for the permanent fact.
     *
     * The second branch is a BOUNDED inference for pre-marker data only. Worlds
     * revoked before `retired_at` existed carry the old shape — auth tombstone
     * set AND the agent's current key already revoked — which
     * `$system:deactivate_actor` never produces (it tombstones without touching
     * keys). Inferring only from that exact conjunction keeps the unsafe
     * direction (double-return) closed; the residual false positive is an
     * operator who deactivated and hand-revoked the key, which errs toward
     * leaving the slot counted, the safe direction.
     */
    private agentSlotReturnedAt(agent: ObjRef): number | null {
      const retiredAt = this.propOrNullLive(agent, "retired_at");
      if (typeof retiredAt === "number") return retiredAt;
      const deactivatedAt = this.propOrNullLive(agent, "deactivated_at");
      if (typeof deactivatedAt !== "number") return null;
      const keyId = this.propOrNullLive(agent, "api_key_id");
      if (typeof keyId !== "string" || !keyId) return null;
      const keys = this.apiKeyMap(agent);
      const record = Object.hasOwn(keys, keyId) ? keys[keyId] : undefined;
      if (!record || typeof record !== "object" || Array.isArray(record)) return null;
      return (record as Record<string, WooValue>).revoked_at != null ? deactivatedAt : null;
    }

    /**
     * Fail-closed validation for an operator-supplied `api_key_id` pointer.
     *
     * The pointer is what retirement follows: `revoke_agent` revokes
     * `agent.api_key_id` and nothing else. A pointer that names a key which is
     * not this agent's therefore means the agent's REAL credential survives
     * retirement — a retired wizard that still authenticates. Accepting any
     * non-empty string is not good enough, so all four facts are checked:
     *
     *  - the id parses as a routed (self-routing) id at all;
     *  - it is bound to THIS agent;
     *  - its immutable authority root matches the agent's anchor root, which is
     *    what cold-gateway routing resolves the credential through;
     *  - a live verifier record for it exists in the agent's OWN `api_keys`
     *    map — the actor-owned store the signed credential-ensure route writes
     *    (routed ids never live in the legacy catalog `$system.api_keys`).
     *
     * Requiring the record is safe because the operator runbook installs the
     * credential BEFORE the call that records the pointer (AP11.6).
     */
    private assertBindableApiKeyPointer(agent: ObjRef, id: string): void {
      const routed = parseRoutedApiKeyId(id);
      if (!routed) {
        throw wooError("E_INVARG", "api_key_id must be a routed api-key id", { agent, api_key_id: id });
      }
      if (routed.actor !== agent) {
        throw wooError("E_INVARG", "api_key_id is bound to a different actor", { agent, api_key_id: id, bound_to: routed.actor });
      }
      const anchorRoot = this.authorityAnchorRoot(agent);
      if (routed.authorityRoot !== anchorRoot) {
        throw wooError("E_INVARG", "api_key_id authority root does not match the actor's anchor root", {
          agent,
          api_key_id: id,
          authority_root: routed.authorityRoot,
          anchor_root: anchorRoot
        });
      }
      // Own-key read for the same reason as the ledger. The routed-id grammar
      // above already makes an `n1_`-prefixed id structurally incapable of
      // naming an Object.prototype member, so this is belt to that brace — but
      // it means no reader has to reconstruct that argument to trust the line.
      const keys = this.apiKeyMap(agent);
      const record = Object.hasOwn(keys, id) ? keys[id] : undefined;
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw wooError("E_INVARG", "api_key_id has no verifier record on this actor; install the credential first", { agent, api_key_id: id });
      }
      const entry = record as Record<string, WooValue>;
      if (entry.actor !== agent) {
        throw wooError("E_INVARG", "api_key_id verifier record names a different actor", { agent, api_key_id: id, record_actor: entry.actor ?? null });
      }
      if (entry.revoked_at != null) {
        throw wooError("E_INVARG", "api_key_id names a revoked credential", { agent, api_key_id: id });
      }
    }

    /**
     * AP11 — signed-operator provisioning of a wizard-flagged agent anchored
     * under an existing human account.
     *
     * Motivation (auth.md A11 "backup wizard", identity/provisioning.md §AP11):
     * a deployed world whose only wizard is the unplaced catalog seed `$wiz`
     * has no usable wizard on the client/MCP surface, and programmer minting is
     * quota-gated to zero with only a wizard able to raise the quota. A non-`$`
     * actor anchored to a human authority root plans at that cluster even while
     * located nowhere, so it is immediately usable; this primitive mints one.
     *
     * The sequence deliberately mirrors the ordinary in-world flow so every
     * counter and audit record stays consistent with self-service provisioning:
     *
     *   1. grant the account exactly the quota headroom the next two steps
     *      consume (`set_quota` semantics + `account_quota_changed` audit),
     *   2. create the agent (`create_agent` semantics: the agent kind, owned by
     *      the human, anchored at the family root, `agent_count`, `actors`,
     *      `actor_provisioned` audit) — WITHOUT minting a key, because the
     *      operator holds a locally generated verifier that the separate signed
     *      credential-ensure route installs,
     *   3. promote to programmer through the shared transition
     *      (`setProgrammerAgentState`): consumes the grant quota, increments
     *      `programmer_agent_count`, sets the flag, attaches the published
     *      programmer surface. REQUIRED before step 4 — the wizard flag supplies
     *      authority, the surface supplies the tools, and an actor with one and
     *      not the other has half a capability,
     *   4. set `flags.wizard` through the lineage seam so it commits over Net.
     *
     * Idempotent by construction: the account's `operator_provisioned_agents`
     * map short-circuits the mint, quota headroom is only granted when the next
     * step would actually exceed it, `setProgrammerAgentState` moves the flag
     * and counter only on a real transition, and the wizard flag write is
     * skipped when already set. A re-run with the same `provision_id` therefore
     * changes nothing and returns the same agent.
     *
     * Fail-closed: if the recorded map names an object that is not a live
     * live agent owned by this human carrying the same `provision_id`, the call
     * refuses rather than minting a second agent (a stale/unwarmed read must
     * never become a duplicate identity).
     */
    private async provisionOperatorWizardAgent(
      caller: ObjRef,
      human: ObjRef,
      input: { provisionId: string; name: string; purpose: string; apiKeyId: string | null }
    ): Promise<Record<string, WooValue>> {
      if (!this.canBypassPerms(caller)) {
        throw wooError("E_PERM", "wizard authority required to provision an operator wizard agent", { actor: caller });
      }
      // assertSelfHuman is the shared kind check (caller === human holds
      // trivially here; the operator's authority was proved above).
      this.assertSelfHuman(human, human);
      const account = assertObj(this.propOrNullLive(human, "account"));
      if (this.propOrNullLive(account, "deactivated_at") != null) throw wooError("E_PERM", "account is deactivated", account);
      // Shape bound only. The WIRE grammar (leading alphanumeric, a fixed
      // punctuation set) is enforced by the operator route; this primitive is
      // reachable by any wizard, so it guards the durable cell's size and must
      // stay correct for whatever text it is handed — including keys that name
      // Object.prototype members (see operatorProvisionedAgents).
      if (!input.provisionId || input.provisionId.length > 128) {
        throw wooError("E_INVARG", "provision_id must be 1..128 characters", { provision_id: input.provisionId });
      }
      if (!input.name) throw wooError("E_INVARG", "name is required");

      // PRECONDITION, checked before any mutation.
      //
      // AP11's contract is a wizard with authority AND tools (AP11.3: the
      // promote is REQUIRED before the flag — the flag supplies authority, the
      // surface supplies the verbs). The SHARED transition deliberately
      // tolerates a world with no published surface, because flag-only is the
      // correct outcome for a world that never installed an authoring catalog
      // (AP6). For THIS op it is not: it reported `promoted: true` for an actor
      // whose `features` cell was never written — a success message that was
      // not true, and the defect that cost a production round.
      //
      // Position matters. A native that throws PART WAY THROUGH still commits
      // the writes it already made (verified: refusing after the create left
      // `agent_count` incremented), so this cannot sit next to the promote it
      // guards — it has to precede the first write.
      const publishedSurface = this.programmerSurface();
      if (publishedSurface === null) {
        throw wooError(
          "E_MISSING_STATE",
          "no authoring surface is published at $system.programmer_surface, so a provisioned wizard would hold authority with no verbs; install an authoring catalog, or on a world that predates the published reference run the seed-property repair",
          { human, account }
        );
      }

      const provisioned = this.operatorProvisionedAgents(account);
      // Own-key read. `provisioned` has a null prototype so plain indexing is
      // already own-only; hasOwn states the intent so a later refactor to a
      // normal object cannot silently reintroduce the inherited-member read.
      const recorded = Object.hasOwn(provisioned, input.provisionId) ? provisioned[input.provisionId] : null;
      let agent: ObjRef | null = null;
      let created = false;
      if (recorded !== null) {
        // Every branch here is fail-closed: the only accepted outcome is an
        // agent that unambiguously belongs to this provision_id.
        //
        // assertOwnedAgent is the shared kind + ownership check, and it opens
        // with `this.objectLive(recorded)` on purpose: under a sparse guarded plan
        // that emits a materialization probe and drives the repair loop, so an
        // unmaterialized recorded agent converges on retry instead of failing
        // as a semantic absence. The reverse provision_id pointer below is what
        // makes the match unambiguous.
        this.assertOwnedAgent(human, recorded);
        if (this.propOrNullLive(recorded, "provision_id") !== input.provisionId) {
          throw wooError("E_INVARG", "recorded operator-provisioned agent does not match this provision_id", { account, provision_id: input.provisionId, agent: recorded });
        }
        // Neither a retired nor a merely deactivated agent is usable, so both
        // refuse — but they are different facts and the message says which, so
        // an operator knows whether reactivation is even on the table.
        if (this.propOrNullLive(recorded, "retired_at") != null) {
          throw wooError("E_PERM", "recorded operator-provisioned agent was permanently retired; choose a new provision_id", { agent: recorded });
        }
        if (this.propOrNullLive(recorded, "deactivated_at") != null) {
          throw wooError("E_PERM", "recorded operator-provisioned agent is deactivated; reactivate it or choose a new provision_id", { agent: recorded });
        }
        agent = recorded;
      }

      const quotaGrants: Array<Record<string, WooValue>> = [];
      // Step 1 — quota headroom, granted with `set_quota` semantics but only in
      // the amount the following steps consume. `set_quota` itself is a
      // `$system` native whose target is catalog-scoped, so the equivalent
      // effect is applied here against the (cluster-resident) account.
      const grant = (kind: "agent_quota" | "programmer_grant_quota", need: number): void => {
        const old = Number(this.propOrNullLive(account, kind) ?? 0);
        if (old >= need) return;
        this.setProp(account, kind, need);
        this.recordProvisioningAudit(caller, "account_quota_changed", { account, kind, old, new: need });
        quotaGrants.push({ kind, old, new: need });
      };

      if (agent === null) {
        grant("agent_quota", Number(this.propOrNullLive(account, "agent_count") ?? 0) + 1);
        // Step 2 — mint the actor. provisionActorInternal is the shared
        // primitive behind $system:provision_actor and create_agent: it picks
        // the id, anchors an agent to its owner's authority root, stamps
        // customer attribution, and records the actor_provisioned audit.
        const provision = this.provisionActorInternal(
          "$agent",
          human,
          { name: input.name, purpose: input.purpose, created_via: "operator_wizard_provision" },
          caller
        );
        agent = provision.actor;
        this.setProp(agent, "provision_id", input.provisionId);
        this.setProp(account, "actors", [...this.accountActors(account), agent]);
        this.setProp(account, "agent_count", Number(this.propOrNullLive(account, "agent_count") ?? 0) + 1);
        // Object-literal spread + COMPUTED key, never `obj[key] = value`: a
        // computed key defines an own property even for `__proto__`, whereas
        // plain assignment on a normal object would invoke Object.prototype's
        // `__proto__` setter and silently store nothing.
        this.setProp(account, "operator_provisioned_agents", { ...provisioned, [input.provisionId]: agent } as WooValue);
        created = true;
      }

      // The api-key id is a pointer, not a credential: the verifier record
      // (hash+salt) is installed by the signed credential-ensure route from a
      // tuple generated on the operator machine, so no secret ever transits
      // this turn. Kept in sync so rotate/revoke find the current key — which
      // is exactly why it is validated fail-closed rather than stored as given.
      if (input.apiKeyId && this.propOrNullLive(agent, "api_key_id") !== input.apiKeyId) {
        this.assertBindableApiKeyPointer(agent, input.apiKeyId);
        this.setProp(agent, "api_key_id", input.apiKeyId);
      }

      // Step 3 — programmer promotion through the shared transition.
      //
      const alreadyProgrammer = this.objectLive(agent).flags.programmer === true;
      if (!alreadyProgrammer) {
        grant("programmer_grant_quota", Number(this.propOrNullLive(account, "programmer_agent_count") ?? 0) + 1);
      }
      await this.setProgrammerAgentState(caller, agent, account, true, "agent_promoted_to_programmer");
      // Post-condition, not decoration: the surface resolved above, so if it is
      // still not attached something refused it silently and the actor is in the
      // half-state this op exists to avoid.
      if (!this.featureList(agent).includes(publishedSurface)) {
        throw wooError(
          "E_MISSING_STATE",
          "the published authoring surface did not attach to the provisioned wizard",
          { agent, surface: publishedSurface }
        );
      }

      // Step 4 — wizard authority. setObjectFlags is the in-world equivalent
      // but writes $system.wizard_actions unconditionally; the flag write and
      // surface reconciliation are reproduced here through the Net-safe seams.
      const flaggedBefore = this.objectLive(agent).flags.wizard === true;
      if (!flaggedBefore) {
        const target = agent;
        this.mutateLineage(target, () => { this.objectLive(target).flags.wizard = true; });
        this.markObjectDirty(target);
        this.reconcileProgrammerSurface(target, true);
        this.recordProvisioningAudit(caller, "actor_wizard_flag_set", { target, account, transition: true });
      }

      this.recordProvisioningAudit(caller, "operator_wizard_agent_provisioned", {
        target: agent,
        account,
        owner: human,
        provision_id: input.provisionId,
        created,
        promoted: !alreadyProgrammer,
        flagged: !flaggedBefore
      });
      return {
        actor_id: agent,
        account,
        owner: human,
        provision_id: input.provisionId,
        created,
        promoted: !alreadyProgrammer,
        flagged: !flaggedBefore,
        api_key_id: (this.propOrNullLive(agent, "api_key_id") ?? null) as WooValue,
        agent_quota: Number(this.propOrNullLive(account, "agent_quota") ?? 0),
        agent_count: Number(this.propOrNullLive(account, "agent_count") ?? 0),
        programmer_grant_quota: Number(this.propOrNullLive(account, "programmer_grant_quota") ?? 0),
        programmer_agent_count: Number(this.propOrNullLive(account, "programmer_agent_count") ?? 0),
        quota_grants: quotaGrants as unknown as WooValue
      };
    }

    private assertSelfHuman(caller: ObjRef, human: ObjRef): void {
      if (caller !== human) throw wooError("E_PERM", "human provisioning verbs are self-only", { caller, human });
      if (!this.objects.has(human) || !this.inheritsFrom(human, "$human")) throw wooError("E_TYPE", "target must be a $human", human);
    }

    private assertOwnedAgent(human: ObjRef, agent: ObjRef): ObjRef {
      this.objectLive(agent);
      if (!this.inheritsFrom(agent, "$agent")) throw wooError("E_TYPE", "target must be a $agent", agent);
      if (this.propOrNullLive(agent, "owner") !== human) throw wooError("E_PERM", "agent is not owned by this human", { human, agent });
      return assertObj(this.propOrNullLive(human, "account"));
    }

    private assertProgrammerAgentQuota(account: ObjRef): void {
      const count = Number(this.propOrNullLive(account, "programmer_agent_count") ?? 0);
      const quota = Number(this.propOrNullLive(account, "programmer_grant_quota") ?? 0);
      if (count >= quota) throw wooError("E_QUOTA_EXCEEDED", "programmer agent quota exceeded", { account, quota, count });
    }

    /**
     * The authoring surface a catalog has published for programmer
     * provisioning, or null when none is installed. Core reads this purely as
     * data ($system.programmer_surface, published by the prog catalog's
     * seed_hook) — it never names $programmer. When unpublished, provisioning
     * still sets the flag and quota; the actor simply has no authoring surface
     * until a catalog installs one (plan §4.4).
     */
    private programmerSurface(): ObjRef | null {
      const raw = this.propOrNullLive("$system", "programmer_surface");
      return typeof raw === "string" && this.objects.has(raw) ? raw : null;
    }

    /**
     * Attach the published programmer surface to an actor with provisioning
     * authority. This is the canonical attachment path (plan §4.3): it bypasses
     * the participant :can_be_attached_by policy because it runs only inside the
     * authority operation already permitted to set the programmer flag. No-op
     * when no surface is published or it is already attached.
     */
    private attachProgrammerSurface(actor: ObjRef): void {
      const surface = this.programmerSurface();
      if (!surface || !this.canCarryFeatures(actor)) return;
      // Bounded collision check FIRST — before the already-present short-circuit
      // — so a surface a bypass (generic add_feature) attached to a shadowing
      // kind is still caught on the next reconcile, not silently accepted. This
      // choke point covers createAgent, promote, and wizard set_object_flags.
      this.assertSurfaceComposable(actor, surface);
      const features = this.featureList(actor);
      if (features.includes(surface)) return;
      this.setProp(actor, "features", [...features, surface]);
      this.bumpFeaturesVersion(actor);
    }

    /**
     * Remove the published programmer surface from an actor (demotion). No-op
     * when unpublished or not attached. A separately granted builder feature is
     * untouched; only the published programmer surface is removed.
     */
    private removeProgrammerSurface(actor: ObjRef): void {
      const surface = this.programmerSurface();
      if (!surface || !this.canCarryFeatures(actor)) return;
      const features = this.featureList(actor);
      if (!features.includes(surface)) return;
      this.setProp(actor, "features", features.filter((item) => item !== surface));
      this.bumpFeaturesVersion(actor);
    }

    /**
     * Programmer promotion/demotion mutates two objects — the agent (flag +
     * attached surface) and its account ($programmer quota counter). The
     * transition is atomic only when both commit in one authoritative scope
     * (plan §5.1), so we refuse up front rather than half-apply across a host
     * boundary. In-memory and single-host worlds are always co-resident; this
     * guards the Net placement where an agent cluster and its account cluster
     * can differ.
     */
    private async assertProgrammerProvisioningColocated(agent: ObjRef, account: ObjRef): Promise<void> {
      if ((await this.remoteHostForObject(agent)) !== null || (await this.remoteHostForObject(account)) !== null) {
        throw wooError("E_CROSS_HOST_WRITE", "programmer provisioning requires the agent and its account to be co-resident", { agent, account });
      }
    }

    /**
     * Refuse to compose a surface onto an actor whose own kind ancestry defines
     * a verb the surface also defines. Parent-chain lookup wins over features
     * (features.md FT2), so such a name would silently shadow the surface verb
     * and leave a half-working authoring surface. This is the bounded, per-actor
     * analogue of scripts/guard-programmer-surface-collision.ts: the guard
     * covers bundled kinds at build time, this covers any live/custom actor
     * class at attach time — walking only the actor's and the surface's
     * ancestry, never the world. Verbs on the classes the two chains share
     * (e.g. $player, $actor) are inherited by both and never collide.
     */
    private assertSurfaceComposable(actor: ObjRef, surface: ObjRef): void {
      const actorChain = this.localAncestry(actor);
      const actorInChain = new Set(actorChain);
      const surfaceChain = this.localAncestry(surface);
      const ncaIndex = surfaceChain.findIndex((cls) => actorInChain.has(cls));
      const surfaceSpecific = ncaIndex >= 0 ? surfaceChain.slice(0, ncaIndex) : surfaceChain;
      const nca = ncaIndex >= 0 ? surfaceChain[ncaIndex] : null;
      const actorNcaIndex = nca ? actorChain.indexOf(nca) : actorChain.length;
      const actorSpecific = actorChain.slice(0, actorNcaIndex);
      const surfaceNames = new Set<string>();
      for (const cls of surfaceSpecific) for (const verb of this.objectLive(cls).verbs) surfaceNames.add(verb.name);
      const collisions = new Set<string>();
      for (const cls of actorSpecific) for (const verb of this.objectLive(cls).verbs) if (surfaceNames.has(verb.name)) collisions.add(verb.name);
      if (collisions.size > 0) {
        throw wooError("E_INVARG", `cannot compose surface ${surface} onto ${actor}: kind ancestry shadows surface verb(s) ${[...collisions].sort().join(", ")}`, { actor, surface, verbs: [...collisions].sort() });
      }
    }

    /**
     * The single flag/surface/quota transition behind every AP6 path (create,
     * promote, demote, revoke). Idempotent and self-repairing:
     *
     *  - The programmer flag and the account's `programmer_agent_count` counter
     *    move only on an actual state change, so re-promoting an already-flagged
     *    agent does not double-count.
     *  - The authoring surface is reconciled UNCONDITIONALLY. A legacy agent
     *    left flag-true-without-surface (pre-composition provisioning), or an
     *    agent left surface-without-flag by a raw `set_object_flags` clear, heals
     *    on the next promote/demote call rather than silently retaining half a
     *    capability.
     *  - Every real transition records an audit entry, so atomicity spans flag,
     *    surface, quota, AND audit (plan §8.10).
     *
     * Co-residency (plan §5.1) is asserted before the account counter is
     * touched, and quota before a promote transition, so a refusal happens with
     * nothing mutated rather than half-applied across a host boundary.
     */
    private async setProgrammerAgentState(caller: ObjRef, actor: ObjRef, account: ObjRef, programmer: boolean, auditAction: string): Promise<void> {
      const currently = this.objectLive(actor).flags.programmer === true;
      const transition = currently !== programmer;
      const surface = this.programmerSurface();
      // Surface reconciliation reads the existing feature list in both
      // directions. Validate its shape before lineage or quota mutation, then
      // retain the independent collision preflight for promotion. The
      // reconciliation reads it again during apply, but no ordinary validation
      // failure remains reachable after the first write.
      const featuresBefore = surface && this.canCarryFeatures(actor) ? this.featureList(actor) : [];
      if (programmer && surface) this.assertSurfaceComposable(actor, surface);
      if (transition) {
        if (programmer) this.assertProgrammerAgentQuota(account);
        // The transition writes the account counter; refuse across a host
        // boundary before mutating anything.
        await this.assertProgrammerProvisioningColocated(actor, account);
        // Flag write through the lineage seam so it commits over Net.
        this.mutateLineage(actor, () => { this.objectLive(actor).flags.programmer = programmer; });
        this.markObjectDirty(actor);
        const delta = programmer ? 1 : -1;
        const next = Math.max(0, Number(this.propOrNullLive(account, "programmer_agent_count") ?? 0) + delta);
        this.setProp(account, "programmer_agent_count", next);
        // The caller (the human/wizard) is the acting principal; the agent is
        // the subject (§8.10). Routed through the profile audit adapter so the
        // Net transition writes no catalog $system cell (its audit is the
        // commit record); local materializes into wizard_actions.
        this.recordProvisioningAudit(caller, auditAction, { target: actor, account, programmer, transition: true });
      }
      // Surface reconciliation is unconditional so partial legacy state heals.
      // A repair without a flag transition is itself auditable.
      const hadSurface = surface ? featuresBefore.includes(surface) : false;
      this.reconcileProgrammerSurface(actor, programmer);
      const hasSurface = surface ? this.featureList(actor).includes(surface) : false;
      if (!transition && hadSurface !== hasSurface) {
        this.recordProvisioningAudit(caller, "programmer_surface_repaired", { target: actor, attached: hasSurface, transition: false });
      }
    }

    private rotateAgentKey(human: ObjRef, agent: ObjRef, force: boolean): { id: string; secret: string; actor: ObjRef; label: string | null; created_at: number } {
      this.assertOwnedAgent(human, agent);
      // Key construction can reject a corrupt anchor graph. Prove replacement
      // viability before revoking the currently usable credential.
      this.assertApiKeyIssuable(agent);
      const oldKey = this.propOrNullLive(agent, "api_key_id");
      if (typeof oldKey === "string" && oldKey) this.revokeApiKeyRecordById(human, oldKey, force);
      const key = this.createApiKeyForOwner(human, agent, String(this.propOrNullLive(agent, "name") ?? agent));
      this.setProp(agent, "api_key_id", key.id);
      // The old/new actor-owned records are the cross-profile audit. Net's
      // accepted transcript adds caller attribution without a catalog write.
      return key;
    }

    private revokeApiKeyRecordById(actor: ObjRef, id: string, closeSessions: boolean): boolean {
      const routed = parseRoutedApiKeyId(id);
      if (
        routed &&
        (!this.objects.has(routed.actor) || this.authorityAnchorRoot(routed.actor) !== routed.authorityRoot)
      ) return false;
      const recordOwner = routed?.actor ?? null;
      const map = recordOwner ? this.apiKeyMap(recordOwner) : this.legacyApiKeyMap();
      const rec = map[id];
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) return false;
      const r = rec as Record<string, WooValue>;
      if (r.revoked_at != null) return false;
      const targetActor = String(r.actor ?? "");
      return this.revokeApiKeyRecord(
        actor,
        id,
        map,
        r,
        targetActor,
        recordOwner,
        closeSessions
      ).revoked;
    }

    private findHermesAgent(human: ObjRef, profileId: string): ObjRef | null {
      for (const obj of this.objects.values()) {
        if (!this.inheritsFrom(obj.id, "$agent")) continue;
        if (this.propOrNullLive(obj.id, "owner") === human && this.propOrNullLive(obj.id, "created_via") === "hermes_provision" && this.propOrNullLive(obj.id, "profile_id") === profileId) return obj.id;
      }
      return null;
    }

    private listAgentsForHuman(human: ObjRef): Array<Record<string, WooValue>> {
      const out: Array<Record<string, WooValue>> = [];
      for (const obj of this.objects.values()) {
        if (!this.inheritsFrom(obj.id, "$agent")) continue;
        if (this.propOrNullLive(obj.id, "owner") !== human) continue;
        out.push({
          actor_id: obj.id,
          name: String(this.propOrNullLive(obj.id, "name") ?? obj.name),
          purpose: String(this.propOrNullLive(obj.id, "purpose") ?? ""),
          created: obj.created,
          last_seen: this.propOrNullLive(obj.id, "last_seen_at"),
          scope: String(this.propOrNullLive(obj.id, "scope") ?? "write"),
          programmer: obj.flags.programmer === true,
          deactivated_at: this.propOrNullLive(obj.id, "deactivated_at"),
          // Distinct from deactivated_at: reversible auth tombstone vs the
          // permanent retirement that returned the account's quota slot.
          retired_at: this.propOrNullLive(obj.id, "retired_at")
        });
      }
      out.sort((a, b) => String(a.actor_id).localeCompare(String(b.actor_id)));
      return out;
    }

    private allowedProvisionReturn(url: string): boolean {
      const raw = this.propOrNullLive("$system", "allowed_provision_return_schemes");
      const allowed = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : ["hermes://"];
      return allowed.some((prefix) => url.startsWith(prefix));
    }

    private consumeProvisionState(state: string): void {
      const now = Date.now();
    this.gcPendingCredentials(now);
      const raw = this.propOrNullLive("$system", "provision_state_nonces");
      const entries = Array.isArray(raw) ? raw.filter((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        return Number((entry as Record<string, WooValue>).issued_at ?? 0) + PROVISION_STATE_TTL_MS >= now;
      }) : [];
      const hash = hashSource(state);
      if (entries.some((entry) => (entry as Record<string, WooValue>).state_hash === hash)) throw wooError("E_REPLAY", "state nonce has already been consumed");
      this.setProp("$system", "provision_state_nonces", [...entries, { state_hash: hash, issued_at: now }] as unknown as WooValue);
    }

  createSessionForActor(actor: ObjRef, tokenClass: Session["tokenClass"] = "bearer", apikeyId?: string): Session {
    return this.cloneSessionView(this.createSessionForActorLive(actor, tokenClass, apikeyId));
  }

  private createSessionForActorLive(actor: ObjRef, tokenClass: Session["tokenClass"] = "bearer", apikeyId?: string): Session {
    this.reapExpiredSessions();
    this.objectLive(actor);
    const id = this.generateSessionId();
    const now = Date.now();
    const session: Session = {
      id,
      actor,
      started: now,
      expiresAt: now + this.sessionTtl(tokenClass),
      lastDetachAt: null,
      tokenClass,
      activeScope: this.initialSessionLocation(actor),
      attachedSockets: new Set(),
      lastInputAt: now,
      ...(apikeyId !== undefined ? { apikeyId } : {})
    };
    const stored = this.withBehaviorMutationPermit(() => {
      this.sessions.set(id, session);
      const inserted = this.sessions.get(id)!;
      this.noteSessionInserted(inserted);
      this.persistSession(inserted);
      // No reader (substrate or catalog) consults `actor.session_id` —
      // `world.sessions` is the source of truth for session lifecycle. The
      // formerly-written mirror property fired on every (actor × host)
      // first-touch and was a top-3 ambient writer.
      return inserted;
    });
    return stored;
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
    activeScope?: ObjRef | null,
    apikeyId?: string,
    startedAt?: number
  ): Session {
    return this.cloneSessionView(this.ensureSessionForActorLive(
      id,
      actor,
      tokenClass,
      expiresAt,
      activeScope,
      apikeyId,
      startedAt
    ));
  }

  private ensureSessionForActorLive(
    id: string,
    actor: ObjRef,
    tokenClass: Session["tokenClass"] = "bearer",
    expiresAt?: number,
    activeScope?: ObjRef | null,
    apikeyId?: string,
    startedAt?: number
  ): Session {
    const existing = this.sessions.get(id);
    if (existing) {
      return this.withBehaviorMutationPermit(() => {
        let changed = false;
        if (Number.isFinite(startedAt) && startedAt !== undefined && startedAt > 0 && existing.started !== startedAt) {
          existing.started = startedAt;
          changed = true;
        }
        if (Number.isFinite(expiresAt) && expiresAt !== undefined && expiresAt > existing.expiresAt) {
          existing.expiresAt = expiresAt;
          changed = true;
        }
        if (activeScope && this.setSessionActiveScope(existing, activeScope)) changed = true;
        // If the originating host knows the apikey id but the routed copy
        // doesn't yet, learn it so future revokes can tear the session down
        // here too.
        if (apikeyId !== undefined && existing.apikeyId !== apikeyId) {
          existing.apikeyId = apikeyId;
          changed = true;
        }
        if (changed) this.persistSession(existing);
        return existing;
      });
    }
    this.objectLive(actor);
    const now = Date.now();
    const started = Number.isFinite(startedAt) && startedAt !== undefined && startedAt > 0 ? startedAt : now;
    const session: Session = {
      id,
      actor,
      started,
      expiresAt: expiresAt ?? now + this.sessionTtl(tokenClass),
      lastDetachAt: null,
      tokenClass,
      activeScope: activeScope ?? this.initialSessionLocation(actor),
      attachedSockets: new Set(),
      lastInputAt: now,
      ...(apikeyId !== undefined ? { apikeyId } : {})
    };
    return this.withBehaviorMutationPermit(() => {
      this.sessions.set(id, session);
      const inserted = this.sessions.get(id)!;
      this.noteSessionInserted(inserted);
      this.persistSession(inserted);
      // No reader (substrate or catalog) consults `actor.session_id` —
      // `world.sessions` is the source of truth for session lifecycle. The
      // formerly-written mirror property fired on every (actor × host)
      // first-touch and was a top-3 ambient writer.
      return inserted;
    });
  }

  /** Migration/test-fixture seam for historical session clocks and placement.
   * Protocol activity uses attach/touch/detach; this method deliberately does
   * not manufacture socket liveness. */
  migrationSetSessionState(
    sessionId: string,
    fields: Partial<Pick<Session, "started" | "expiresAt" | "lastDetachAt" | "lastInputAt" | "activeScope">> & {
      rosterVisible?: boolean;
    }
  ): boolean {
    this.assertOutsideBehaviorMutation("migrationSetSessionState");
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return this.withBehaviorMutationPermit(() => {
      let changed = false;
      if (fields.activeScope !== undefined && fields.activeScope !== session.activeScope) {
        this.setSessionActiveScope(session, fields.activeScope);
        changed = true;
      }
      for (const key of ["started", "expiresAt", "lastDetachAt", "lastInputAt"] as const) {
        if (fields[key] === undefined || fields[key] === session[key]) continue;
        (session as unknown as Record<string, unknown>)[key] = fields[key];
        changed = true;
      }
      if (fields.rosterVisible !== undefined) {
        const next = fields.rosterVisible === false ? false : undefined;
        if (next !== session.rosterVisible) {
          if (next === false) session.rosterVisible = false;
          else delete session.rosterVisible;
          changed = true;
        }
      }
      if (changed) this.persistSession(session);
      return changed;
    });
  }

  private initialSessionLocation(actor: ObjRef): ObjRef {
    const obj = this.objectLive(actor);
    const home = this.propOrNullLive(actor, "home");
    if (obj.location && this.objects.has(obj.location)) return obj.location;
    return typeof home === "string" && this.objects.has(home) ? home : "$nowhere";
  }

  claimWizardBootstrapSession(presentedToken: string, expectedToken: string | undefined): Session {
    if (!expectedToken) throw wooError("E_BOOTSTRAP_TOKEN_MISSING", "WOO_INITIAL_WIZARD_TOKEN is not set");
    const claim = () => {
      if (this.propOrNullLive("$system", "bootstrap_token_used") === true) throw wooError("E_TOKEN_CONSUMED", "wizard bootstrap token has already been consumed");
      if (presentedToken !== expectedToken) throw wooError("E_NOSESSION", "invalid wizard bootstrap token");
      this.setProp("$system", "bootstrap_token_used", true);
      return this.createSessionForActorLive("$wiz", "bearer");
    };
    const repo = this.activeObjectRepository();
    return repo ? repo.transaction(claim) : claim();
  }

  attachSocket(sessionId: string, socketId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.withBehaviorMutationPermit(() => {
      this.withPersistenceDeferred(() => {
        session.attachedSockets.add(socketId);
        session.lastDetachAt = null;
        const now = Date.now();
        session.expiresAt = Math.max(session.expiresAt, now + this.sessionTtl(session.tokenClass));
        session.lastInputAt = now;
        this.persistSession(session);
        this.persist();
      });
    });
  }

  /** Mark a session as having received meaningful user input. Called from
   * authenticated WS / REST / MCP ingress for `op: call | direct | input` (and
   * on socket attach, inline above). NOT called from `world.directCall` or
   * `world.call`, because many of those callers are internal/test/system paths
   * without a real user behind them; the gating happens at the protocol edge
   * instead. */
  touchSessionInput(sessionId: string, now: number = Date.now()): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.withBehaviorMutationPermit(() => {
      session.lastInputAt = now;
      if (session.closedAt !== undefined || now >= session.expiresAt) return;
      const ttl = this.sessionTtl(session.tokenClass);
      if (session.expiresAt - now > ttl / 2) return;
      // Sliding renewal keeps active stateless transports authenticated without a
      // session-row write on every request. Persist only near the half-life.
      session.expiresAt = now + ttl;
      this.persistSession(session);
    });
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
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.actor !== actor) continue;
      if (this.sessionIsLive(session, now)) return true;
    }
    return false;
  }

  private sessionIsLive(session: Session, now = Date.now()): boolean {
    if (session.closedAt !== undefined) return false;
    if (this.sessionExpired(session, now)) return false;
    if (session.attachedSockets.size > 0) return true;
    return session.lastInputAt >= now - IDLE_PRESENCE_LIVE_WINDOW_MS;
  }

  actorPresenceStatus(actor: ObjRef, now = Date.now()): "awake" | "idle" | "sleeping" {
    if (!this.actorIsConnected(actor)) return "sleeping";
    const lastInputAt = this.actorLastInputAt(actor);
    if (lastInputAt !== null && Math.floor((now - lastInputAt) / 1000) >= IDLE_PRESENCE_IDLE_THRESHOLD_SECONDS) return "idle";
    return "awake";
  }

  detachSocket(sessionId: string, socketId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.withBehaviorMutationPermit(() => {
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

  // Operator cleanup for guests stranded by missed lifecycle cleanup: reap
  // expired sessions first, optionally reap old detached guest sessions even
  // before TTL, then reset only guest instances with no live session. The stale
  // cutoff is intentionally opt-in so normal session liveness keeps its relaxed
  // MCP/REST grace semantics; the operator recovery path needs a stricter
  // definition of "inactive" to clear historical smoke sessions. Room contents
  // are repaired by moving the actor, never by editing a room's contents cache
  // directly.
  purgeInactiveGuests(now = Date.now(), options: { staleGuestSessionMs?: number } = {}): {
    inspected: number;
    reaped_sessions: string[];
    stale_guest_sessions: string[];
    reset_actors: ObjRef[];
  } {
    const reapedSessions = this.reapExpiredSessions(now);
    const staleGuestSessionMs = Number.isFinite(options.staleGuestSessionMs)
      ? Math.max(0, Math.floor(Number(options.staleGuestSessionMs)))
      : null;
    const staleGuestSessions: string[] = [];
    const resetActorSet = new Set<ObjRef>();
    if (staleGuestSessionMs !== null) {
      const staleBefore = now - staleGuestSessionMs;
      for (const session of Array.from(this.sessions.values()).sort((a, b) => a.id.localeCompare(b.id))) {
        if (session.tokenClass !== "guest" || !this.inheritsFrom(session.actor, "$guest")) continue;
        if (session.attachedSockets.size > 0) continue;
        if (session.started > staleBefore) continue;
        staleGuestSessions.push(session.id);
        reapedSessions.push(session.id);
        resetActorSet.add(session.actor);
        this.reapSession(session.id);
      }
    }

    const liveGuestActors = new Set<ObjRef>();
    for (const session of this.sessions.values()) {
      if (!this.inheritsFrom(session.actor, "$guest")) continue;
      if (session.closedAt !== undefined) continue;
      if (!this.sessionExpired(session, now)) liveGuestActors.add(session.actor);
    }

    let inspected = 0;
    const inactiveGuestActors: ObjRef[] = [];
    for (const actor of Array.from(this.objects.keys()).sort() as ObjRef[]) {
      if (!actor.startsWith("guest_") || !this.inheritsFrom(actor, "$guest")) continue;
      inspected += 1;
      if (liveGuestActors.has(actor)) continue;
      inactiveGuestActors.push(actor);
    }

    // Presence cleanup should stay proportional to actual stale presence rows,
    // not guests × objects. The index is rebuilt once, then each inactive guest
    // scrubs only spaces that mention that actor in subscribers/session rows.
    if (inactiveGuestActors.length > 0) this.ensurePresenceIndex();

    for (const actor of inactiveGuestActors) {
      let changed = false;
      for (const space of Array.from(this.actorPresenceIndex.get(actor) ?? []).sort() as ObjRef[]) {
        if (this.dropAllSubscriberRowsForActor(space, actor)) changed = true;
      }
      const guest = this.objectLive(actor);
      const needsReset =
        guest.location !== "$nowhere" ||
        guest.contents.size > 0 ||
        (Array.isArray(this.propOrNullLive(actor, "aliases")) && (this.propOrNullLive(actor, "aliases") as WooValue[]).length > 0) ||
        (Array.isArray(this.propOrNullLive(actor, "features")) && (this.propOrNullLive(actor, "features") as WooValue[]).length > 0);
      if (needsReset) {
        this.resetGuestOnDisconnect(actor);
        changed = true;
      } else {
        this.returnGuest(actor);
      }
      if (changed) resetActorSet.add(actor);
    }
    const resetActors = Array.from(resetActorSet).sort() as ObjRef[];
    if (reapedSessions.length > 0 || resetActors.length > 0) this.persist(true);
    return { inspected, reaped_sessions: reapedSessions, stale_guest_sessions: staleGuestSessions, reset_actors: resetActors };
  }

  /**
   * Returns true iff `actor` has at least one live session. Used by recycle
   * pre-flight (§RC6) to decide whether an actor is currently bound and
   * therefore unrecyclable through ordinary tools.
   */
  hasLiveSessions(actor: ObjRef): boolean {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.actor !== actor) continue;
      if (session.closedAt !== undefined) continue;
      if (!this.sessionExpired(session, now)) return true;
    }
    return false;
  }

  /** Returns the live sessions bound to `actor` (sorted by id for stability). */
  liveSessionsForActor(actor: ObjRef): Session[] {
    const now = Date.now();
    const out: Session[] = [];
    for (const session of this.sessions.values()) {
      if (session.actor !== actor) continue;
      if (session.closedAt !== undefined) continue;
      if (!this.sessionExpired(session, now)) out.push(session);
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  primarySessionForActor(actor: ObjRef): Session | null {
    let best: Session | null = null;
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.actor !== actor) continue;
      // Closed sessions can remain referenced briefly during cleanup. Never let
      // one win primary election and suppress the physical move for a newer live
      // session.
      if (session.closedAt !== undefined) continue;
      if (this.sessionExpired(session, now)) continue;
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
      if (session.closedAt !== undefined) continue;
      if (best === null || session.started < best.started || (session.started === best.started && session.id < best.id)) {
        best = session;
      }
    }
    return best;
  }

  activeScopeForSession(sessionId: string | null | undefined): ObjRef | null {
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session || !this.sessionAlive(sessionId)) return null;
    return session.activeScope;
  }

  /** @deprecated Use activeScopeForSession; current location was legacy focus vocabulary. */
  currentLocationForSession(sessionId: string | null | undefined): ObjRef | null {
    return this.activeScopeForSession(sessionId);
  }

  allLocationsForActor(actor: ObjRef): ObjRef[] {
    const out: ObjRef[] = [];
    for (const session of this.sessions.values()) {
      if (session.actor !== actor) continue;
      if (session.closedAt !== undefined) continue;
      if (!out.includes(session.activeScope)) out.push(session.activeScope);
    }
    if (out.length === 0) {
      const loc = this.objects.get(actor)?.location ?? null;
      if (loc) out.push(loc);
    }
    return out;
  }

  // Strict counterpart of `allLocationsForActor`: only returns locations
  // backed by a live session, with no `.location`-property fallback. Used
  // by the subscriber scrubber so a guest whose session vanished without
  // a clean reap (DO hibernation, MCP gateway in-memory loss) is correctly
  // marked stale — the persistent `.location` lingers on the deck and
  // would otherwise mask the dead session.
  liveSessionLocationsForActor(actor: ObjRef): ObjRef[] {
    const now = Date.now();
    const out: ObjRef[] = [];
    for (const session of this.sessions.values()) {
      if (session.actor !== actor) continue;
      if (session.closedAt !== undefined) continue;
      if (this.sessionExpired(session, now)) continue;
      if (!out.includes(session.activeScope)) out.push(session.activeScope);
    }
    return out;
  }

  hasPresence(actor: ObjRef, space: ObjRef): boolean {
    this.ensurePresenceIndex();
    const spaces = this.actorPresenceIndex.get(actor);
    return spaces ? spaces.has(space) : false;
  }

  // Detached read-only audience view for a $space. Callers cannot poison the
  // derived presence caches by casting away ReadonlySet/ReadonlyMap and
  // mutating the returned collection. Returns `null` when none are present.
  presenceActorsIn(space: ObjRef): ReadonlySet<ObjRef> | null {
    this.ensurePresenceIndex();
    const sessions = this.sessionSubscribersIndex.get(space);
    if (sessions) return new Set(sessions.values());
    const actors = this.subscribersIndex.get(space);
    return actors ? new Set(actors) : null;
  }

  presenceSessionsIn(space: ObjRef): ReadonlyMap<string, ObjRef> | null {
    this.ensurePresenceIndex();
    const sessions = this.sessionSubscribersIndex.get(space);
    return sessions ? new Map(sessions) : null;
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

  sessionCanAccessSpace(actor: ObjRef, space: ObjRef, sessionId: string | null = null): boolean {
    if (this.isWizard(actor)) return true;
    // Durable/log replay can race projection materialization on sparse MCP
    // shards. The session row is the authoritative occupancy hint for the
    // caller, so mirror authorizePresence instead of requiring the room's
    // subscriber projection to have arrived first.
    if (sessionId && (this.hasSessionPresence(sessionId, space) || this.activeScopeForSession(sessionId) === space)) return true;
    return this.hasPresence(actor, space);
  }

  async call(frameId: string | undefined, sessionId: string, space: ObjRef, message: Message): Promise<AppliedFrame | ErrorFrame> {
    return this.cloneFrame(await this.enqueueHostTask(
      () => this.callNow(frameId, sessionId, space, message),
      `call:${message.target}:${message.verb}`
    ));
  }

  private async callNow(
    frameId: string | undefined,
    sessionId: string,
    space: ObjRef,
    message: Message,
    appliedOptions: AppliedCallOptions = {}
  ): Promise<AppliedFrame | ErrorFrame> {
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
      if (cached && Date.now() - cached.at < 5 * 60 * 1000) return this.cloneFrame(cached.frame);
    }
    let frame: AppliedFrame | ErrorFrame;
    try {
        frame = await this.applyCall(frameId, space, message, sessionId, appliedOptions);
    } catch (err) {
      const error = normalizeError(err);
      frame = { op: "error", id: frameId, error };
    }
    if (frameId) {
      const cachedFrame = deepFreezePlainValue(this.cloneFrame(frame));
      this.idempotency.set(`${sessionId}:${frameId}`, { at: Date.now(), frame: cachedFrame });
      return this.cloneFrame(cachedFrame);
    }
    return this.cloneFrame(frame);
  }

  private async enqueueHostTask<T>(fn: () => Promise<T>, label: string = "task", chainId?: string): Promise<T> {
    const id = ++this.hostTaskCounter;
    // Inherit chain id from the inbound RPC when one was provided, else
    // mint a fresh one for this task. Once running, the task's outbound
    // cross-host RPCs propagate this id so callbacks from downstream
    // hosts can be detected and run inline (re-entrant dispatch — see
    // `hostDispatch`).
    const taskChainId = chainId ?? this.mintChainId();
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
      this.currentHostTask = { id, label, startedAt, chainId: taskChainId };
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
      this.currentHostTask = { id, label, startedAt, chainId: taskChainId };
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

  async directCall(frameId: string | undefined, actor: ObjRef, target: ObjRef, verbName: string, args: WooValue[], options: DirectCallOptions = {}): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
    return this.cloneFrame(await this.enqueueHostTask(
      () => this.directCallNow(frameId, actor, target, verbName, args, options),
      `directCall:${target}:${verbName}`
    ));
  }

  async planCommand(frameId: string | undefined, sessionId: string, space: ObjRef, text: string): Promise<DirectResultFrame | ErrorFrame> {
    return this.cloneFrame(await this.enqueueHostTask(
      () => this.planCommandNow(frameId, sessionId, space, text),
      `planCommand:${space}`
    ));
  }

  async command(frameId: string | undefined, sessionId: string, space: ObjRef, text: string, options: CommandOptions = {}): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
    return this.cloneFrame(await this.enqueueHostTask(
      () => this.commandNow(frameId, sessionId, space, text, options),
      `command:${space}`
    ));
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
    if (ctx.seq >= 0) {
      if (commandSpace !== ctx.space) {
        throw wooError("E_SCOPE_SPLIT", "nested sequenced command names an incompatible semantic space", {
          current: ctx.space,
          requested: commandSpace,
          target: plan.target
        });
      }
      // Already inside the compatible authoritative turn: dispatch inline.
      // No second sequence, recorder envelope, or persistence boundary exists.
      return await this.dispatch({ ...ctx, caller: ctx.thisObj, callerPerms: ctx.progr }, plan.target, plan.verb, plan.args);
    }

    const scope = this.behaviorUndoScopes.at(-1);
    if (!scope) {
      throw wooError("E_SCOPE_SPLIT", "terminal command transfer requires an active behavior journal");
    }
    if (
      scope.undos.length > 0 ||
      scope.acceptance.length > 0 ||
      ctx.observations.length > 0 ||
      this.turnScheduleCount > 0 ||
      scope.terminalTransferDisallowedKinds.size > 0
    ) {
      throw wooError("E_SCOPE_SPLIT", "sequenced command wrapper is not proof-only", {
        mutations: scope.undos.length,
        acceptance: scope.acceptance.length,
        observations: ctx.observations.length,
        schedules: this.turnScheduleCount,
        effects: Array.from(scope.terminalTransferDisallowedKinds)
      });
    }
    const proofEvents = this.activeTurnRecorder?.currentBehaviorEvents() ?? [];
    throw commandPlanTransfer(
      { space: commandSpace, target: plan.target, verb: plan.verb, args: plan.args },
      ctx.actor,
      ctx.session,
      [...proofEvents]
    );
  }

  private async planCommandNow(frameId: string | undefined, sessionId: string, space: ObjRef, text: string): Promise<DirectResultFrame | ErrorFrame> {
    try {
      assertObj(space);
      assertString(text);
      const actor = this.sessionActor(sessionId);
      const hostMemo = createHostOperationMemo();
      if (await this.remoteHostForObject(space, hostMemo)) {
        return await this.planRemoteCommandNow(frameId, actor, sessionId, space, text, hostMemo);
      }
      // Text-command planning is ordinary catalog behavior. Keep this server
      // convenience wrapper on the exact same verb-dispatch path as browser,
      // REST, MCP, and in-world `:command` callers so space overrides, feature
      // wrappers, skip-presence metadata, observations, and recorder reads are
      // identical on every transport.
      const planned = await this.directCallNow(frameId, actor, space, "command_plan", [text], { sessionId });
      if (planned.op === "applied") {
        throw wooError("E_INTERNAL", "command_plan transferred instead of returning a plan", {
          space,
          target: planned.message.target,
          verb: planned.message.verb
        });
      }
      return planned;
    } catch (err) {
      const error = normalizeError(err);
      return { op: "error", id: frameId, error };
    }
  }

  private async planRemoteCommandNow(frameId: string | undefined, actor: ObjRef, sessionId: string, space: ObjRef, text: string, hostMemo: HostOperationMemo): Promise<DirectResultFrame> {
    const startedAt = Date.now();
    if (!this.executorContext?.resolveVerb) throw wooError("E_INTERNAL", "remote host bridge verb resolution unavailable");
    const resolved = await this.executorContext.resolveVerb(space, "command_plan", hostMemo);
    if (!resolved) throw wooError("E_VERBNF", `verb not found: ${space}:command_plan`, { obj: space, name: "command_plan" });
    if (resolved.direct_callable !== true) {
      throw wooError("E_DIRECT_DENIED", `direct call denied for ${space}:command_plan`, { target: space, verb: "command_plan" });
    }
    if (resolved.skip_presence_check !== true) this.authorizePresence(actor, space, sessionId);
    const args: WooValue[] = [text];
    return await this.dispatchDirectCallFrame(frameId, actor, space, "command_plan", args, {
      startedAt,
      sessionId,
      audience: space,
      hostMemo
    });
  }

  private sessionActor(sessionId: string): ObjRef {
    const session = this.sessions.get(sessionId);
    if (!session || !this.sessionAlive(sessionId)) throw wooError("E_NOSESSION", "session token is expired or unknown");
    return session.actor;
  }

  private terminalTransferCacheBinding(
    frameId: string | undefined,
    actor: ObjRef,
    options: DirectCallOptions
  ): string | null {
    if (!frameId) return null;
    const sessionId = options.sessionId === undefined
      ? this.primarySessionForActor(actor)?.id ?? null
      : options.sessionId;
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    // Match callNow's ordering: an expired/foreign session never receives a
    // cached result, even when its frame id was valid earlier.
    if (!session || !this.sessionAlive(sessionId) || session.actor !== actor) return null;
    return `${sessionId}:${actor}:${frameId}`;
  }

  private directRequestFingerprint(
    target: ObjRef,
    verb: string,
    args: WooValue[],
    options: DirectCallOptions
  ): string {
    return hashSource(canonicalJson({
      target,
      verb,
      args,
      force_direct: options.forceDirect === true,
      force_reason: options.forceReason ?? null
    }));
  }

  private async directCallNow(frameId: string | undefined, actor: ObjRef, target: ObjRef, verbName: string, args: WooValue[], options: DirectCallOptions = {}): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
    const startedAt = Date.now();
    let transferCacheBinding: string | null = null;
    try {
      assertObj(actor);
      assertObj(target);
      assertString(verbName);
      if (!Array.isArray(args)) throw wooError("E_INVARG", "args must be a list");
      transferCacheBinding = this.terminalTransferCacheBinding(frameId, actor, options);
      if (transferCacheBinding) {
        const cached = this.terminalTransferIdempotency.get(transferCacheBinding);
        if (cached) {
          if (Date.now() - cached.at >= 5 * 60 * 1000) {
            this.terminalTransferIdempotency.delete(transferCacheBinding);
          } else {
            const requestFingerprint = this.directRequestFingerprint(target, verbName, args, options);
            if (cached.requestFingerprint === requestFingerprint) return this.cloneFrame(cached.frame);
            throw wooError(
              "E_INVARG",
              "idempotency key was already used for a different direct request",
              { field: "id", id: frameId ?? null }
            );
          }
        }
      }
      const { verb } = this.resolveVerbLive(target, verbName);
      const forceDirect = options.forceDirect === true && verb.direct_callable !== true;
      const wizard = this.isWizard(actor);
      // CO16.4: a scheduled turn is not client ingress, so the ingress flag
      // does not apply to it. Without this the scheduler could only ever fire
      // verbs a browser could also call directly — which excludes exactly the
      // internal verbs a scheduled chain is made of.
      const scheduled = options.scheduled !== undefined;
      if (verb.direct_callable !== true && !forceDirect && !scheduled) {
        throw wooError("E_DIRECT_DENIED", `direct call denied for ${target}:${verbName}`, { target, verb: verbName });
      }
      if (forceDirect && !wizard) throw wooError("E_PERM", "only wizards may force direct calls", { actor, target, verb: verbName });
      if (forceDirect) this.recordWizardAction(actor, "force_direct", { target, verb: verbName, reason: options.forceReason ?? null });
      const hostMemo = createHostOperationMemo();
      const audience = await this.directAudience(actor, target, verbName, args, hostMemo);
      const sessionId = options.sessionId === undefined ? this.primarySessionForActor(actor)?.id ?? null : options.sessionId;
      if (audience) await this.chatPresentAsync(audience, actor);
      // A scheduled turn has NO session and its actor is very likely gone —
      // that is the ordinary case, not the edge one: a reminder fires because
      // you are not there to remember. Presence is a question about a live
      // connection, so it cannot apply here (scheduling.md SC5). Leaving it in
      // meant every scheduled verb failed with E_PERM the moment its actor
      // left the room, which is precisely when timers matter.
      if (audience && verb.skip_presence_check !== true && !forceDirect && options.scheduled === undefined) {
        this.authorizePresence(actor, audience, sessionId);
      }
      return await this.dispatchDirectCallFrame(frameId, actor, target, verbName, args, {
        startedAt,
        sessionId,
        audience,
        hostMemo,
        ...(options.scheduled ? { scheduled: options.scheduled } : {}),
        initialObservations: forceDirect ? [{ type: "wizard_action", action: "force_direct", actor, target, verb: verbName, source: target }] : undefined,
        deferHostEffect: options.deferHostEffect,
        onSessionsEnded: options.onSessionsEnded
      });
    } catch (err) {
      if (isCommandPlanTransfer(err)) {
        const frame = await this.completeCommandPlanTransfer(frameId, actor, err);
        if (transferCacheBinding) {
          const cachedFrame = deepFreezePlainValue(this.cloneFrame(frame));
          const existing = this.terminalTransferIdempotency.get(transferCacheBinding);
          // Preserve the first request bound to this actor/session/frame, just
          // as callNow preserves the first accepted sequenced outcome.
          if (!existing || Date.now() - existing.at >= 5 * 60 * 1000) {
            this.terminalTransferIdempotency.set(transferCacheBinding, {
              at: Date.now(),
              requestFingerprint: this.directRequestFingerprint(target, verbName, args, options),
              frame: cachedFrame
            });
          }
          this.sweepIdempotency();
          return this.cloneFrame(cachedFrame);
        }
        return frame;
      }
      const error = normalizeError(err);
      this.recordMetric({ kind: "direct_call", target, verb: verbName, audience: null, observations: 0, ms: Date.now() - startedAt, status: "error", error: error.code });
      return { op: "error", id: frameId, error };
    }
  }

  private async completeCommandPlanTransfer(
    frameId: string | undefined,
    actor: ObjRef,
    transfer: CommandPlanTransfer
  ): Promise<AppliedFrame | ErrorFrame> {
    if (transfer.actor !== actor) {
      throw wooError("E_INTERNAL", "terminal command transfer actor changed during wrapper unwind", {
        expected: actor,
        actual: transfer.actor
      });
    }
    return await this.callNow(
      frameId,
      transfer.session,
      transfer.plan.space,
      {
        actor: transfer.actor,
        target: transfer.plan.target,
        verb: transfer.plan.verb,
        args: transfer.plan.args
      },
      { transferredProofEvents: transfer.proofEvents }
    );
  }

  private async dispatchDirectCallFrame(
    frameId: string | undefined,
    actor: ObjRef,
    target: ObjRef,
    verbName: string,
    args: WooValue[],
    options: DirectDispatchFrameOptions
  ): Promise<DirectResultFrame> {
    const observations: Observation[] = [...(options.initialObservations ?? [])];
    const message: Message = {
      actor,
      target,
      verb: verbName,
      args,
      // CO16.8 fire-time context, reachable from woocode as `message`. The
      // verb can tell it was woken rather than called, and how late: `at` and
      // `fired_at` diverge after eviction, after a floor deferral, and after a
      // busy scope defers a due batch. A no-catch-up chain needs to see that
      // gap, and the spec promised it before anything carried it.
      ...(options.scheduled ? { scheduled: options.scheduled } : {})
    };
    const deferredHostEffects: DeferredHostEffect[] = [];
    const postAcceptEffects: PostAcceptEffect[] = [];
    let result: WooValue = null;
    const dispatchCtx: CallContext = {
      world: this,
      space: options.audience ?? "#-1",
      seq: -1,
      session: options.sessionId,
      actor,
      player: actor,
      // A scheduled turn was WOKEN, not called; presenting `$system` is what
      // lets a fired verb tell the difference and refuse ordinary callers.
      caller: options.scheduled ? "$system" : "#-1",
      callerPerms: actor,
      progr: actor,
      thisObj: target,
      verbName,
      definer: target,
      message,
      observations,
      hostMemo: options.hostMemo,
      onSessionsEnded: options.onSessionsEnded,
      deferPostAccept: (label, effect) => postAcceptEffects.push({ label, run: effect }),
      observe: (event) => {
        const observation = { ...event, source: event.source ?? target };
        this.recordTurnEvent({ kind: "observe", observation });
        observations.push(observation);
      },
      deferHostEffect: options.deferHostEffect ? (effect) => deferredHostEffects.push(effect) : undefined
    };
    let liveAudiences: DirectLiveAudience = {};
    await this.withTurnRecording(
      { id: frameId, route: "direct", scope: options.audience ?? "#-1", seq: -1, session: options.sessionId, actor, target, verb: verbName, args },
      async (activeRecorder) => {
        options.hostMemo.turnRecorder = activeRecorder;
        await this.withPersistencePaused(async () => {
          await this.withBehaviorSavepoint(async () => {
            result = await this.dispatch(dispatchCtx, target, verbName, args);
            result = await this.enrichScopedMoveResult(dispatchCtx, result);
            // These reads are part of constructing the success frame, so they
            // belong before acceptance. A remote enrichment/audience failure
            // must abort behavior, not report an error after state persisted.
            // The cross-host bridge may already have supplied authoritative
            // audience data; otherwise resolve it while rollback is possible.
            const crossHostAudience = (dispatchCtx as { crossHostAudience?: DirectLiveAudience }).crossHostAudience;
            liveAudiences = crossHostAudience ?? await this.directLiveAudiences(options.audience, observations);
          });
        });
        return result;
      }
    );
    if (this.persistenceDirty) this.persist(true);
    if (options.deferHostEffect) {
      const recordDeliveryFailure = (effect: DeferredHostEffect, err: unknown): void => {
        this.recordMetric({
          kind: "direct_host_effect_delivery",
          target,
          verb: verbName,
          effect: effect.kind,
          status: "error",
          error: String(err)
        });
      };
      for (const effect of deferredHostEffects) {
        try {
          const delivery = options.deferHostEffect(effect);
          if (isPromiseLike(delivery)) {
            // Post-accept transport must not hold the accepted reply open.
            // Attach a rejection observer, but deliberately do not await it.
            void Promise.resolve(delivery).catch((err) => recordDeliveryFailure(effect, err));
          }
        } catch (err) {
          // Behavior and persistence are already accepted. A host projection
          // sink is post-accept delivery: measure failure for repair/retry,
          // but never rewrite the durable success into an error frame.
          recordDeliveryFailure(effect, err);
        }
      }
    }
    this.runPostAcceptEffects(postAcceptEffects);
    this.recordMetric({ kind: "direct_call", target, verb: verbName, audience: options.audience, observations: observations.length, ms: Date.now() - options.startedAt, status: "ok" });
    return {
      op: "result",
      id: frameId,
      result,
      observations,
      audience: options.audience,
      audienceActors: liveAudiences.audienceActors,
      observationAudiences: liveAudiences.observationAudiences,
      audienceSessions: liveAudiences.audienceSessions,
      observationSessionAudiences: liveAudiences.observationSessionAudiences,
      observationAudienceExclusions: liveAudiences.observationAudienceExclusions,
      observationAudienceModes: liveAudiences.observationAudienceModes
    };
  }

  private async enrichScopedMoveResult(ctx: CallContext, result: WooValue): Promise<WooValue> {
    if (!result || typeof result !== "object" || Array.isArray(result)) return result;
    const map = result as Record<string, WooValue>;
    if (map.here !== undefined || map.here_request !== true || typeof map.room !== "string") return result;
    // Net planning has already consumed the room owner's compact roster, and
    // look_deferred requires the client to refresh the authoritative room view
    // after movement. Building a second `here` snapshot here would walk
    // physical contents (including disconnected reusable player objects) and
    // turn that history into cross-cluster reads on the commit path.
    if (map.look_deferred === true && (this.requireRoomRosterProjection || this.roomRosterProjections.has(map.room))) return result;
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
    if (!ctx.session || here.roster.some((actor) => actor.id === ctx.actor)) return here;
    const activeScope = this.activeScopeForSession(ctx.session);
    if (!activeScope) return here;
    const currentHere = await this.primaryRoomForLocation(activeScope, memo);
    if (currentHere !== here.id) return here;
    return {
      ...here,
      roster: [...here.roster, this.thinScopedObjectSummary(await this.scopedObjectSummary(ctx.actor, ctx.actor, memo))]
    };
  }

  replay(space: ObjRef, from: number, limit: number): SpaceLogEntry[] {
    return cloneValue(
      (this.logs.get(space) ?? [])
        .filter((entry) => entry.seq >= from)
        .slice(0, limit) as unknown as WooValue
    ) as unknown as SpaceLogEntry[];
  }

  async applyCall(
    id: string | undefined,
    spaceRef: ObjRef,
    message: Message,
    sessionId: string | null = null,
    options: AppliedCallOptions = {}
  ): Promise<AppliedFrame> {
    const repo = this.activeObjectRepository();
    if (repo) return await this.applyCallRepository(repo, id, spaceRef, message, sessionId, options);
    const startedAt = Date.now();
    const frame = await this.withBehaviorSavepoint(async () => await this.withPersistencePaused(async () => {
      this.validateMessage(message);
      // VTN10.1: the sequenced-call preamble (space lookup, verb
      // resolution, presence authorization, sequencer read) runs BEFORE
      // `withTurnRecording` opens the recorder, so an `object(id)` miss here
      // cannot fire the in-run lifecycle probe. Run these materialization-
      // sensitive lookups under `guardedPreamble`, which (only when the shadow
      // guard is armed) converts a preamble `E_OBJNF` into the same repairable
      // `E_NEED_STATE` the in-run probe would emit. Off-guard this is a plain
      // passthrough, so the normal path is unchanged.
      const space = this.guardedPreamble(() => this.objectLive(spaceRef));
      // Sequenced calls use the same catalog-level presence override as
      // direct calls. The check runs before the recorder opens, so ignoring
      // skip_presence_check here would make v2 commit-scope turns fail with no
      // transcript instead of producing an authority-verifiable result.
      let skipPresenceCheck = false;
      try {
        skipPresenceCheck = this.resolveVerbLive(message.target, message.verb).verb.skip_presence_check === true;
      } catch {
        // Let unresolved target verbs continue into the sequenced call body,
        // where they become applied $error observations and still consume seq.
      }
      if (!skipPresenceCheck) {
        this.guardedPreamble(() => this.authorizePresence(message.actor, spaceRef, sessionId));
      }
      const nextSeq = Number(this.guardedPreamble(() => this.getPropLive(spaceRef, "next_seq")));
      const seq = nextSeq;
      this.setProp(spaceRef, "next_seq", nextSeq + 1);

      let logEntry: SpaceLogEntry = {
        space: spaceRef,
        seq,
        ts: Date.now(),
        actor: message.actor,
        message: cloneValue(message) as Message,
        observations: [],
        applied_ok: true
      };
      const log = this.logs.get(spaceRef) ?? [];
      this.withBehaviorMutationPermit(() => {
        log.push(logEntry);
        this.logs.set(spaceRef, log);
        // behavior wrappers detach caller-owned records; retain the stored
        // authoritative row for outcome updates below.
        logEntry = log[log.length - 1]!;
      });

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
          const observation = { ...event, source: event.source ?? space.id };
          this.recordTurnEvent({ kind: "observe", observation });
          observations.push(observation);
        }
      };

      try {
        await this.withTurnRecording(
          { id, route: "sequenced", scope: spaceRef, seq, session: sessionId, actor: message.actor, target: message.target, verb: message.verb, args: message.args, body: message.body },
          async (activeRecorder) => {
            if (ctx.hostMemo) ctx.hostMemo.turnRecorder = activeRecorder;
            // The preamble's seq allocation, recorded as ordinary transcript
            // events so a net-planned turn commits the sequencer advance.
            this.recordSequencedAllocation(spaceRef, seq, message.actor);
            for (const proof of options.transferredProofEvents ?? []) this.recordTurnEvent(proof);
            // Live-presence scrub is ordinary gateway maintenance. The helper
            // no-ops under shadow recording so user-turn transcripts do not
            // gain hidden system-authority writes.
            await this.scrubStaleSubscribersForSpace(spaceRef, ctx.hostMemo);
            await this.withBehaviorSavepoint(async () => {
              result = await this.dispatch(ctx, message.target, message.verb, message.args);
              result = await this.enrichScopedMoveResult(ctx, result);
            });
            return result ?? null;
          }
        );
        this.withBehaviorMutationPermit(() => {
          logEntry.applied_ok = true;
        });
      } catch (err) {
        const error = normalizeError(err);
        this.withBehaviorMutationPermit(() => {
          logEntry.applied_ok = false;
          logEntry.error = error;
        });
        observations.length = 0;
        observations.push({ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] });
      }

      this.withBehaviorMutationPermit(() => {
        logEntry.observations = cloneValue(observations as unknown as WooValue) as unknown as Observation[];
      });
      const frame = { op: "applied" as const, id, space: spaceRef, seq, ts: logEntry.ts, message, observations, result };
      this.persist(true);
      return frame;
    }));
    this.recordMetric({ kind: "applied", space: spaceRef, seq: frame.seq, verb: message.verb, ms: Date.now() - startedAt });
    return frame;
  }

  private async applyCallRepository(
    repo: ObjectRepository,
    id: string | undefined,
    spaceRef: ObjRef,
    message: Message,
    sessionId: string | null = null,
    options: AppliedCallOptions = {}
  ): Promise<AppliedFrame> {
    const startedAt = Date.now();
    // The outer journal owns sequencer allocation, provisional log state,
    // response assembly, and repository acceptance as one unit. The nested
    // body journal may abort a throwing verb while the outer scope still
    // commits its canonical applied-error envelope.
    const frame = await this.withBehaviorSavepoint(async () =>
      await this.withPersistencePaused(async () => {
        this.validateMessage(message);
        const space = this.objectLive(spaceRef);
        // Match the in-memory apply path: verb metadata decides whether the
        // pre-recording presence gate applies to sequenced calls.
        let skipPresenceCheck = false;
        try {
          skipPresenceCheck = this.resolveVerbLive(message.target, message.verb).verb.skip_presence_check === true;
        } catch {
          // Keep missing-verb calls on the applied-frame rollback path.
        }
        if (!skipPresenceCheck) {
          this.authorizePresence(message.actor, spaceRef, sessionId);
        }
        const seq = Number(this.getPropLive(spaceRef, "next_seq"));
        const ts = Date.now();
        this.withBehaviorMutationPermit(() => {
          this.setPropLocal(spaceRef, "next_seq", seq + 1);
        });

        let logEntry: SpaceLogEntry = {
          space: spaceRef,
          seq,
          ts,
          actor: message.actor,
          message: cloneValue(message) as Message,
          observations: [],
          applied_ok: true
        };
        const log = this.logs.get(spaceRef) ?? [];
        this.withBehaviorMutationPermit(() => {
          log.push(logEntry);
          this.logs.set(spaceRef, log);
          logEntry = log[log.length - 1]!;
        });
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
            const observation = { ...event, source: event.source ?? space.id };
            this.recordTurnEvent({ kind: "observe", observation });
            observations.push(observation);
          }
        };

        try {
          await this.withTurnRecording(
            { id, route: "sequenced", scope: spaceRef, seq, session: sessionId, actor: message.actor, target: message.target, verb: message.verb, args: message.args, body: message.body },
            async (activeRecorder) => {
              if (ctx.hostMemo) ctx.hostMemo.turnRecorder = activeRecorder;
              // Same recorded seq allocation as the in-memory path.
              this.recordSequencedAllocation(spaceRef, seq, message.actor);
              for (const proof of options.transferredProofEvents ?? []) this.recordTurnEvent(proof);
              // Same maintenance boundary as the in-memory path: repository
              // hosts may clean stale live rows, but recorded shadow turns
              // must not carry those cleanup writes.
              await this.scrubStaleSubscribersForSpace(spaceRef, ctx.hostMemo);
              await this.withBehaviorSavepoint(async () => {
                result = await this.dispatch(ctx, message.target, message.verb, message.args);
                result = await this.enrichScopedMoveResult(ctx, result);
              });
              return result ?? null;
            }
          );
          this.withBehaviorMutationPermit(() => {
            logEntry.applied_ok = true;
          });
        } catch (err) {
          const error = normalizeError(err);
          this.withBehaviorMutationPermit(() => {
            logEntry.applied_ok = false;
            logEntry.error = error;
          });
          observations.length = 0;
          observations.push({ type: "$error", code: error.code, message: error.message ?? error.code, value: error.value ?? null, trace: error.trace ?? [] });
        }

        this.withBehaviorMutationPermit(() => {
          logEntry.observations = cloneValue(observations as unknown as WooValue) as unknown as Observation[];
        });
        // Response assembly is part of acceptance. Resolve every fallible
        // audience read before the durable transaction; otherwise an audience
        // fault after commit would restore only memory and report an error for
        // a log row SQLite had already accepted.
        const audience = this.appliedFrameAudience(spaceRef, observations);
        const frame: AppliedFrame = {
          op: "applied",
          id,
          space: spaceRef,
          seq,
          ts: logEntry.ts,
          message,
          observations,
          result,
          ...audience
        };
        // The returned frame remains live until the outer direct wrapper
        // accepts. Durable acceptance must not close over those mutable arrays
        // or let wrapper code rewrite the log outcome after the inner turn was
        // recorded.
        const durableMessage = cloneValue(message) as Message;
        const durableObservations = cloneValue(
          observations as unknown as WooValue
        ) as unknown as Observation[];
        const durableAppliedOk = logEntry.applied_ok === true;
        const durableError = logEntry.error
          ? cloneValue(logEntry.error as unknown as WooValue) as unknown as ErrorValue
          : undefined;
        this.acceptNowOrWithOuterBehavior(() => {
          const appended = repo.appendLog(spaceRef, durableMessage.actor, durableMessage);
          if (appended.seq !== seq) throw wooError("E_STORAGE", `sequenced log drift for ${spaceRef}: expected ${seq}, got ${appended.seq}`);
          this.withBehaviorMutationPermit(() => {
            logEntry.ts = appended.ts;
            frame.ts = appended.ts;
          });
          repo.recordLogOutcome(spaceRef, seq, durableAppliedOk, durableObservations, durableError);
        });
        return frame;
      })
    );
    this.recordMetric({ kind: "applied", space: spaceRef, seq: frame.seq, verb: message.verb, ms: Date.now() - startedAt });
    return frame;
  }

  async hostDispatch(ctx: CallContext, target: ObjRef, verbName: string, args: WooValue[], startAt?: ObjRef | null, chainId?: string): Promise<WooValue> {
    // Re-entrancy: if the inbound caller is part of the chain we are
    // already running on this host, run inline (bypass the queue).
    // Without this, A → B → A (a verb that dispatches to a remote which
    // calls back to us) would self-deadlock: the callback from B queues
    // behind the original A task, but A is awaiting B's response. This
    // mirrors normal nested verb-dispatch semantics — the callback is
    // logically part of the originating verb, not a new behavior.
    if (chainId && this.currentHostTask?.chainId === chainId) {
      return await this.dispatch(ctx, target, verbName, args, startAt);
    }
    return await this.enqueueHostTask(() => this.dispatch(ctx, target, verbName, args, startAt), `dispatch:${target}:${verbName}`, chainId);
  }

  private mintChainId(): string {
    // Prefix identifies the origin host (useful in tail logs); the
    // random suffix prevents a downstream host from spoofing a chain id
    // it didn't receive. The receiver only runs inline when the
    // incoming chain id matches its own currentHostTask — a guessable
    // counter would be a small but real window for cross-task
    // interleaving, so we use a 64-bit hex random instead.
    this.chainCounter += 1;
    return `${this.chainOriginPrefix ?? "host"}:${this.chainCounter}:${randomHex(8)}`;
  }

  async dispatch(ctx: CallContext, target: ObjRef, verbName: string, args: WooValue[], startAt?: ObjRef | null, maxChars?: number | null): Promise<WooValue> {
    let result: WooValue;
    if (await this.remoteHostForObject(target, ctx.hostMemo) || (startAt ? await this.remoteHostForObject(startAt, ctx.hostMemo) : false)) {
      if (!this.executorContext) throw wooError("E_INTERNAL", "remote host bridge unavailable");
      const effect = this.effects.remoteBridgeUntrackedEffect("dispatch", { target, verb: verbName, start_at: startAt ?? null });
      this.recordUntrackedEffect(effect.name, effect.detail);
      result = await this.executorContext.dispatch(ctx, target, verbName, args, startAt);
    } else {
      if (this.callDepth >= MAX_CALL_DEPTH) throw wooError("E_CALL_DEPTH", "maximum verb call depth exceeded");
      this.callDepth += 1;
      try {
        // startAt is `undefined` for an ordinary call and a definer ref for `pass()`.
        // Cross-host dispatch serializes `undefined` as JSON `null`, so treat both
        // as "no parent override" and fall back to the standard resolveVerb walk.
        const { definer, verb } = startAt == null ? this.resolveVerbLive(target, verbName) : this.resolveVerbFromLive(startAt, verbName);
        this.assertCanExecuteVerb(ctx.progr, target, verbName, verb);
        this.recordTurnDispatch(target, verbName, startAt, definer, verb);
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
          result = await this.withTurnRecorderFrame(runCtx, async () => await handler(runCtx, args));
        } else {
          result = await this.withTurnRecorderFrame(runCtx, async () => await runTinyVm(runCtx, verb.bytecode, args));
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

  /**
   * Start host-only callbacks after behavior persistence and response
   * enrichment have succeeded. They are intentionally not awaited: transport
   * notification latency and failure cannot rewrite an accepted domain result.
   * Both synchronous throws and asynchronous rejections are converted into the
   * same bounded metric, so best-effort does not mean invisible.
   */
  private runPostAcceptEffects(effects: PostAcceptEffect[]): void {
    for (const effect of effects) {
      const startedAt = Date.now();
      try {
        Promise.resolve(effect.run()).then(
          () => this.recordMetric({ kind: "post_accept_effect", effect: effect.label, ms: Date.now() - startedAt, status: "ok" }),
          (err) => this.recordMetric({
            kind: "post_accept_effect",
            effect: effect.label,
            ms: Date.now() - startedAt,
            status: "error",
            error: normalizeError(err).code
          })
        );
      } catch (err) {
        this.recordMetric({
          kind: "post_accept_effect",
          effect: effect.label,
          ms: Date.now() - startedAt,
          status: "error",
          error: normalizeError(err).code
        });
      }
    }
  }

  /**
   * Bounded historical repair for one account authority.
   *
   * The candidate set comes only from the account registry, the AP11
   * provisioning ledger, the primary-actor pointer, and operator-named orphan
   * candidates. A local SQLite world is physically monolithic, but this method
   * deliberately does not scan its object table: doing so would turn a
   * single-account repair into a global operation that Net cannot implement.
   */
  repairAccountState(
    account: ObjRef,
    options: { dryRun?: true; apply?: true; candidateActors?: ObjRef[] }
  ): AccountRepairResult {
    if ((options.dryRun === true) === (options.apply === true)) {
      throw wooError("E_INVARG", "account-state repair requires exactly one of dryRun or apply");
    }
    if ((options.candidateActors?.length ?? 0) > 256) {
      throw wooError("E_INVARG", "account-state repair accepts at most 256 explicit candidates");
    }
    if (!this.isAccountObject(account)) {
      throw wooError("E_TYPE", "account-state repair requires an account instance", account);
    }
    const primary = this.propOrNull(account, "primary_actor");
    const rawActors = this.propOrNull(account, "actors");
    const rawLedger = this.propOrNull(account, "operator_provisioned_agents");
    const actorValues = Array.isArray(rawActors) ? rawActors : [];
    const ledgerValues = rawLedger && typeof rawLedger === "object" && !Array.isArray(rawLedger)
      ? Object.values(rawLedger as Record<string, WooValue>)
      : [];
    // Refuse oversized source containers before building the de-duplicated
    // candidate Set. Otherwise a corrupt local account could make a repair
    // advertised as bounded walk an arbitrarily large payload even though
    // Net rejects the same state.
    if (
      actorValues.length > ACCOUNT_REPAIR_MEMBER_LIMIT ||
      ledgerValues.length > ACCOUNT_REPAIR_MEMBER_LIMIT
    ) {
      throw wooError(
        "E_INVARG",
        `account-state repair authority exceeds ${ACCOUNT_REPAIR_MEMBER_LIMIT} members`
      );
    }
    const ids = new Set<ObjRef>();
    if (typeof primary === "string") ids.add(primary);
    for (const value of actorValues) {
      if (typeof value === "string") ids.add(value);
    }
    for (const value of ledgerValues) {
      if (typeof value === "string") ids.add(value);
    }
    for (const candidate of options.candidateActors ?? []) ids.add(candidate);
    if (ids.size > ACCOUNT_REPAIR_MEMBER_LIMIT) {
      throw wooError(
        "E_INVARG",
        `account-state repair authority exceeds ${ACCOUNT_REPAIR_MEMBER_LIMIT} members`
      );
    }

    const authorityRoot = this.authorityAnchorRoot(account);
    const members: AccountRepairMember[] = [];
    for (const id of ids) {
      const obj = this.objects.get(id);
      if (!obj) continue;
      const kind = this.isHumanObject(id)
        ? "human"
        : this.isAgentObject(id)
          ? "agent"
          : "other";
      let memberAuthorityRoot: string | null = null;
      try {
        memberAuthorityRoot = this.authorityAnchorRoot(id);
      } catch {
        // The planner reports this as an authority mismatch. Preserve the
        // diagnostic boundary instead of turning one corrupt candidate into a
        // thrown operation with no account-level report.
      }
      members.push({
        id,
        kind,
        owner: obj.owner,
        authority_root: memberAuthorityRoot,
        account: kind === "human" && typeof this.propOrNull(id, "account") === "string"
          ? this.propOrNull(id, "account") as string
          : null,
        flags: { ...obj.flags },
        features: this.propOrNull(id, "features"),
        api_key_id: this.propOrNull(id, "api_key_id"),
        api_keys: this.propOrNull(id, "api_keys"),
        deactivated_at: this.propOrNull(id, "deactivated_at"),
        retired_at: this.propOrNull(id, "retired_at"),
        provision_id: this.propOrNull(id, "provision_id")
      });
    }

    const plan = planAccountStateRepair({
      account,
      authority_scope: authorityRoot.startsWith("$") ? "catalog" : `cluster:${authorityRoot}`,
      authority_root: authorityRoot,
      primary_actor: primary,
      actors: rawActors,
      agent_count: this.propOrNull(account, "agent_count"),
      programmer_agent_count: this.propOrNull(account, "programmer_agent_count"),
      operator_provisioned_agents: rawLedger,
      programmer_surface: this.programmerSurface(),
      explicit_candidates: options.candidateActors ?? [],
      members
    });
    const changed = plan.patches.map(accountRepairPatchKey);
    const patches = summarizeAccountRepairPatches(plan.patches);
    if (options.dryRun === true || plan.status !== "would_apply") {
      return {
        ...plan,
        patches,
        dry_run: options.dryRun === true,
        changed
      };
    }

    // Repository.savepoint is the real SQLite rollback boundary; the nested
    // behavior snapshot keeps memory and storage in agreement if any adapter
    // write fails. Property versions advance normally for actual repairs and
    // are never rewritten to disguise a historical failed attempt.
    this.withMutationSavepoint(() => {
      for (const patch of plan.patches) {
        if (patch.kind === "property") {
          this.setProp(patch.object, patch.name, cloneValue(patch.after));
          continue;
        }
        this.mutateLineage(patch.object, () => {
          // Historical repair is an authority mutation, not a public read.
          // Apply to the guarded live row so the journal and persistence
          // layers both observe the lineage patch.
          this.objectLive(patch.object).flags = { ...patch.after };
        });
        this.markObjectDirty(patch.object);
      }
      // A lineage-only plan has no later setProp() to trigger an incremental
      // flush. Persist inside the repository savepoint so returning `applied`
      // always means memory and SQLite agree across restart.
      this.persist(true);
    });
    return {
      ...plan,
      patches,
      status: "applied",
      dry_run: false,
      changed
    };
  }

  state(actor?: ObjRef): WorldSnapshot {
    const spaces: WorldSnapshot["spaces"] = {};
    for (const id of Array.from(this.objects.keys()).sort()) {
      if (!this.inheritsFrom(id, "$space")) continue;
      const nextSeq = Number(this.propOrNullLive(id, "next_seq"));
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
    const activeScope = this.activeScopeForSession(session.id);
    const hereLocation = activeScope
      ? await this.primaryRoomForLocation(activeScope, memo).catch((err) => {
        if (isReadAvailabilityError(err)) return null;
        throw err;
      })
      : null;
    const inventoryRefs = await this.objectContents(session.actor, memo);
    const inventory = await this.scopedObjectSummaries(session.actor, inventoryRefs, memo);
    const overlays = activeScope && hereLocation && activeScope !== hereLocation
      ? { active_scope: { subject: activeScope, surface: "default", restore: true } }
      : undefined;
    const cursorSpaces = [
      activeScope,
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
        active_scope: activeScope,
        current_location: activeScope,
        all_locations: this.allLocationsForActor(session.actor)
      },
      here,
      inventory: inventoryRefs.map((id) => inventory[id]).filter((item): item is ScopedObjectSummary => item !== undefined),
      overlays
    };
  }

  async roomSnapshotForActor(actor: ObjRef, room: ObjRef, sessionId: string | null = null, memo: HostOperationMemo = createHostOperationMemo()): Promise<RoomSnapshot> {
    if (await this.remoteHostForObject(room, memo)) {
      if (!this.executorContext?.roomSnapshot) throw wooError("E_INTERNAL", "remote host bridge room snapshots unavailable");
      return await this.executorContext.roomSnapshot(actor, room, sessionId, memo);
    }

    const roomSummary = await this.scopedObjectSummary(actor, room, memo);
    const presentRefs = await this.chatPresentAsync(room, actor);
    const contentRefs = (await this.objectContents(room, memo)).filter((item) => !this.isActorForLook(item, presentRefs));
    const exits = await this.exitSummariesForRoom(actor, room, memo);
    const present = await this.scopedObjectSummaries(actor, presentRefs, memo);
    const roster = presentRefs.map((id) => present[id]).filter((item): item is ScopedObjectSummary => item !== undefined).map((item) => this.thinScopedObjectSummary(item));
    const contents = await this.scopedObjectSummaries(actor, contentRefs, memo);
    return {
      id: room,
      name: roomSummary.name,
      parent: roomSummary.parent,
      features: roomSummary.features,
      description: roomSummary.description,
      exits,
      roster,
      contents: contentRefs.map((id) => contents[id]).filter((item): item is ScopedObjectSummary => item !== undefined).map((item) => this.thinScopedObjectSummary(item)),
      props: roomSummary.props
    };
  }

  async overlaySnapshotForActor(actor: ObjRef, subject: ObjRef, surface = "default", sessionId: string | null = null, memo: HostOperationMemo = createHostOperationMemo()): Promise<OverlaySnapshot> {
    if (await this.remoteHostForObject(subject, memo)) {
      if (!this.executorContext?.overlaySnapshot) throw wooError("E_INTERNAL", "remote host bridge overlay snapshots unavailable");
      return await this.executorContext.overlaySnapshot(actor, subject, surface, sessionId, memo);
    }

    const room = await this.spaceLikeOrRemote(subject, memo)
      ? await this.roomSnapshotForActor(actor, subject, sessionId, memo)
      : null;
    const refs = new Set<ObjRef>([subject]);
    for (const id of await this.objectContents(subject, memo)) refs.add(id);
    if (room) {
      for (const item of room.roster) refs.add(item.id);
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
    // Keyed by OBJECT ID, which is a data key space, not a safe property
    // namespace: `out["__proto__"] = summary` on a normal object sets the
    // prototype instead of adding an entry, so an object legitimately named
    // `__proto__` reports `hasOwn:false` and vanishes from `Object.keys` —
    // silently missing from every look, roster, and describe that reads this
    // map (values.md §V6).
    const out: Record<ObjRef, ScopedObjectSummary> = dataKeyedMap<ScopedObjectSummary>();
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
    if (!this.executorContext) throw wooError("E_INTERNAL", "remote host bridge object summaries unavailable");
    await Promise.all(Array.from(remoteByHost.values()).map(async (ids) => {
      try {
        Object.assign(out, await this.executorContext!.objectSummaries(actor, ids, memo));
      } catch (err) {
        if (!isReadAvailabilityError(err)) throw err;
      }
    }));
    return out;
  }

  async scopedObjectSummary(actor: ObjRef, objRef: ObjRef, memo: HostOperationMemo = createHostOperationMemo()): Promise<ScopedObjectSummary> {
    if (await this.remoteHostForObject(objRef, memo)) {
      if (!this.executorContext) throw wooError("E_INTERNAL", "remote host bridge object summaries unavailable");
      return await this.executorContext.objectSummary(actor, objRef, memo);
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
        if (!this.executorContext) throw wooError("E_INTERNAL", "remote host bridge unavailable");
        return await this.executorContext.getPropChecked("$wiz", space, "next_seq", memo);
      }
      return this.getPropLive(space, "next_seq");
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
    // Use the same lookup as hostKeyForObject so legacy class-level
    // host_placement defaults, explicit instance properties, and anchored
    // routes classify consistently. New self-hosting classes use a
    // class-level self-placement marker at create time, which stamps host_placement on
    // each instance rather than routing class objects themselves.
    const selfHosted = new Set<ObjRef>();
    for (const id of this.objects.keys()) {
      if (this.hostKeyForObject(id) === id) selfHosted.add(id);
    }
    const hostFor = (id: ObjRef): string => {
      if (selfHosted.has(id)) return id;
      const obj = this.objectLive(id);
      let cursor: ObjRef | null = obj.anchor;
      const seen = new Set<ObjRef>();
      while (cursor && !seen.has(cursor)) {
        if (selfHosted.has(cursor)) return cursor;
        seen.add(cursor);
        cursor = this.objects.has(cursor) ? this.objectLive(cursor).anchor : null;
      }
      return DEFAULT_OBJECT_HOST;
    };
    return Array.from(this.objects.values())
      .map((obj) => ({ id: obj.id, host: hostFor(obj.id), anchor: obj.anchor }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private catalogState(): { installed: WooValue[] } {
    const installed = this.objects.has("$catalog_registry") ? this.propOrNullLive("$catalog_registry", "installed_catalogs") : [];
    return { installed: Array.isArray(installed) ? installed : [] };
  }

  private stateObject(id: ObjRef, actor?: ObjRef): Record<string, WooValue> {
    const described = actor ? this.describeForActor(id, actor) : this.describe(id);
    const props: Record<string, WooValue> = {};
    for (const name of this.properties(id)) {
      props[String(name)] = actor ? this.propOrNullForActor(actor, id, String(name)) : this.propOrNullLive(id, String(name));
    }
    return { ...described, props };
  }

  private localScopedObjectSummary(actor: ObjRef, objRef: ObjRef): ScopedObjectSummary {
    const obj = this.objectLive(objRef);
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
    let current = this.objectLive(objRef).parent;
    const seen = new Set<ObjRef>();
    while (current && !seen.has(current)) {
      ancestors.push(current);
      seen.add(current);
      const obj = this.parentWalkLookup(objRef, current);
      if (!obj) break;
      current = obj.parent;
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
      this.objectLive(location);
      if (this.isSpaceLike(location) && !this.hasPresence(actor, location) && !this.isWizard(actor)) {
        throw wooError("E_PERM", `${actor} is not present in ${location}`, { actor, location });
      }
    }
    const displayName = optionMaybeString(options, "name") ?? null;
    const description = optionMaybeString(options, "description") ?? null;
    const aliases = optionStringList(options, "aliases", []);
    // A builder object placed in a space anchors there; otherwise it co-locates
    // in the AUTHOR's authority cluster (§7 authoring workspace) — see
    // createBuilderObject, which applies the author fallback and reuses the
    // self-host guard. `null` here means "no explicit space anchor".
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
    const previousParent = this.objectLive(objRef).parent;
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

    const obj = this.objectLive(objRef);
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
    const objAfter = this.objectLive(objRef);
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
      this.resolveVerbLive(objRef, "recycle");
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
          space: this.objectLive(objRef).anchor ?? "#-1",
          seq: -1,
          session: null,
          actor: objRef,
          player: objRef,
          caller: objRef,
          callerPerms: this.objectLive(objRef).owner,
          progr: this.objectLive(objRef).owner,
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
      // Control signals (sparse-planning state/projection misses, VM
      // suspend/read) are NOT ordinary handler failures — they must escape to
      // the gateway repair, not be swallowed into a $recycle_handler_error and
      // let recycle proceed. Otherwise a recycle whose :recycle handler re-homes
      // children via ordered_children (e.g. the outliner) would tombstone the
      // node with its children still edged to it. Same discipline as the VM's
      // uncatchable-signal rethrow (P1.2).
      if (isUncatchableControlSignal(err)) throw err;
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
        cursor = this.objects.has(cursor) ? this.objectLive(cursor).anchor : null;
      }
    }
    return out.sort();
  }

  // builderSetProperty / builderInspect / builderSearch /
  // programmerResolveVerb / programmerListVerb / programmerInspect /
  // programmerSearch — removed. The catalog inlines the equivalent
  // logic via authoring_inspect / authoring_search / verb_info /
  // verb_code / property_info + SET_PROP. See the BUILTIN_NAMES
  // tombstone block in tiny-vm.ts for the persisted-bytecode story.

  // programmerSetVerbInfo, programmerSetPropertyInfo, programmerTrace —
  // removed as substrate builtins. The catalog ($programmer:set_verb_info,
  // :set_property_info, :trace) reaches the substrate through verb_info /
  // set_verb_info / set_property_info / add_property / delete_property /
  // property_info builtins, which cover every step those methods did.
  //
  // programmerInstallVerb and programmerListVerb were demoted from
  // catalog-callable builtins (they were never wired through
  // BUILTIN_NAMES anyway — the catalog $programmer:install_verb verb
  // inlines the same pipeline). They survive as substrate-internal
  // helpers because the editor session machinery (editorInvoke /
  // editorDryRun / editorSave) still calls them. The leading
  // assertProgrammerActor stays so a future callsite can't bypass the
  // surface gate.

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
    // Replacing an EXISTING verb requires the verb's execution authority:
    // wizard, or the actor owns the verb — the set_verb_code / set_verb_info
    // rule. Object authorship (checked above) is NOT sufficient: verb owner
    // is dispatch's `progr`, so overwriting a verb you do not own on an
    // object you do would let you replace, and take ownership of, another
    // principal's code (e.g. a $wiz-installed verb on a programmer-owned
    // object). Defining a NEW own verb (current absent) needs only the
    // object authorship already asserted.
    if (selected.current && !this.isWizard(actor) && selected.current.owner !== actor) {
      throw wooError("E_PERM", `${actor} cannot edit verb ${objRef}:${selected.name} owned by ${selected.current.owner}`, {
        actor, obj: objRef, verb: selected.name, owner: selected.current.owner
      });
    }
    // Net planning: pin the page this install is predicated on (the same
    // optimistic-conflict read addVerbForActor/setVerbCode record). Without
    // it the editor-save path produced a transcript with no verb read OR
    // write, so the install silently never left the committing room's turn.
    if (selected.current) this.recordAuthoredVerbRead(objRef, selected.current);
    else this.recordAuthoredVerbAbsence(objRef, selected.name);
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
    const pure = combineVerbPurity(analyzeBytecodePurity(finalBytecode), undefined, `${objRef}:${selected.name}`);
    this.addVerb(objRef, {
      kind: "bytecode",
      name: selected.name,
      aliases: selected.current?.aliases ?? [],
      // An update preserves the verb's owner (set_verb_code semantics —
      // ownership changes go through set_verb_info's explicit rule); only
      // a fresh define binds the installing actor. Non-wizards can only
      // reach an update as the owner, so this matters for wizard edits:
      // fixing someone's verb must not silently chown it to the wizard.
      owner: selected.current?.owner ?? actor,
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
    // Make the install durable over Net: record the written page so the
    // transcript carries a verb cell write that rides to the object's
    // anchor scope (mirrors addVerbForActor / setVerbCode).
    const installed = this.ownVerbExact(objRef, selected.name);
    if (installed) this.recordAuthoredVerbWrite(objRef, installed, selected.name);
    propagateVerbPurity(this);
    return summary;
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

  /** Upgrade the compiler's generic objref hint into a "did you mean" once the
   * world can confirm the symbol really is an object id. The compiler has no
   * world access, so it can only offer the general rule; eval is the surface
   * where an agent types a freshly-created id (`obj_human_2_1:ping()`) and
   * needs to be told the literal form is `#obj_human_2_1`. A sparse view that
   * has not warmed the object simply keeps the generic hint — never a claim
   * that the id does not exist. */
  private sharpenEvalDiagnostics(diagnostics: CompileDiagnostic[]): CompileDiagnostic[] {
    return diagnostics.map((diagnostic) => {
      const symbol = diagnostic.symbol;
      if (!symbol || !this.objects.has(symbol)) return diagnostic;
      return { ...diagnostic, hint: `${symbol} is an object; address it with the objref literal — did you mean #${symbol}?` };
    });
  }

  async programmerEval(ctx: CallContext, source: string, opts: WooValue, surfaceClass: ObjRef): Promise<WooValue> {
    this.assertProgrammerActor(ctx.actor, surfaceClass);
    const options = progOptions(opts);
    const dryRun = optionBool(options, "dry_run", false);
    const mode = optionString(options, "mode", "expr");
    if (!["expr", "stmts"].includes(mode)) throw wooError("E_INVARG", `unknown eval mode: ${mode}`);
    const trimmed = source.trim();
    if (!trimmed) throw wooError("E_INVARG", "empty eval source");
    const body = mode === "expr"
      ? `return ${trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed};`
      : trimmed;
    const wrapped = `verb :_eval() rxd {\n  ${body}\n}`;
    const compiled = compileVerb(wrapped);
    if (!compiled.ok || !compiled.bytecode) {
      return { ok: false, dry_run: dryRun, diagnostics: this.sharpenEvalDiagnostics(compiled.diagnostics) as unknown as WooValue };
    }
    if (dryRun) return { ok: true, dry_run: true, diagnostics: [] };
    // The wrapper verb is not persisted. Run it directly with the actor as
    // progr so authority follows the LambdaCore @eval rule: code runs as the
    // invoking programmer, not as the catalog installer that owns the surface
    // wrapper verb. callerPerms also tracks the actor.
    //
    // Runtime errors are deliberately allowed to propagate. Keep an explicit
    // savepoint around eval because this method is also a public substrate
    // helper and can be invoked outside the normal direct/sequenced frame.
    // During an ordinary call it nests inside the frame savepoint; recorder
    // behavior scopes are deliberately nestable, so an inner success remains
    // provisional until the outer behavior commits.
    const evalCtx: CallContext = {
      ...ctx,
      thisObj: ctx.actor,
      verbName: "_eval",
      definer: ctx.actor,
      caller: ctx.thisObj,
      callerPerms: ctx.actor,
      progr: ctx.actor
    };
    // Narrowing on `compiled.bytecode` doesn't survive the async closure;
    // bind to a local so the savepoint callback sees the non-optional type.
    const bytecode = compiled.bytecode;
    const value = await this.withBehaviorSavepoint(async () => await runTinyVm(evalCtx, bytecode, []));
    return { ok: true, dry_run: false, value: value as WooValue };
  }

  async editorInvoke(ctx: CallContext, editorRef: ObjRef, targetRef: ObjRef, descriptor: WooValue, opts: WooValue, surfaceClass: ObjRef): Promise<WooValue> {
    this.assertProgrammerActor(ctx.actor, surfaceClass);
    if (await this.remoteHostForObject(editorRef) || await this.remoteHostForObject(targetRef)) {
      throw wooError("E_CROSS_HOST_WRITE", `editor sessions and target installs must share a host: ${editorRef} -> ${targetRef}`, { editor: editorRef, target: targetRef });
    }
    this.assertEditorObject(editorRef);
    const options = progOptions(opts);

    // Refuse at the door what save/dry_run will refuse anyway (the
    // verb-owner rule in programmerInstallVerb): opening a buffer the actor
    // can never install is a trap. An INHERITED verb resolves no own slot
    // here — saving it defines a new own override, which the object
    // authorship checked at install time permits. This runs BEFORE the
    // resume path below: authorization is revalidated against the verb's
    // CURRENT owner every entry, so a verb chowned away while the session
    // was paused refuses resume instead of admitting the actor to a buffer
    // whose save can only fail. The paused session (and its buffer) is left
    // untouched by the refusal.
    let ownCurrent: VerbDef | null = null;
    try {
      ownCurrent = this.ownVerbResolve(targetRef, descriptor);
    } catch {
      ownCurrent = null;
    }
    if (ownCurrent && !this.isWizard(ctx.actor) && ownCurrent.owner !== ctx.actor) {
      throw wooError("E_PERM", `${ctx.actor} cannot edit verb ${targetRef}:${ownCurrent.name} owned by ${ownCurrent.owner}`, {
        actor: ctx.actor, obj: targetRef, verb: ownCurrent.name, owner: ownCurrent.owner
      });
    }

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
      // Own slot at open → upsert with a version CAS against THAT slot.
      // No own slot (inherited verb, or a brand-new name) → define: the
      // buffer becomes a new own verb, and mode "define"'s absence check
      // is the optimistic guard. `listed.version` must NOT seed the CAS in
      // that case — it is the INHERITED verb's version, and comparing it
      // against the absent own slot made every override save fail
      // E_VERSION.
      install_mode: ownCurrent ? "upsert" : "define",
      expected_version: ownCurrent
        ? optionNullableInt(options, "expected_version") ?? (typeof listed.version === "number" ? listed.version : null)
        : null,
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
      mode: session.install_mode,
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
      mode: session.install_mode,
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
    const obj = this.objectLive(objRef);
    const children = Array.from(obj.children).sort();
    const fertileChildren = children.filter((child) => this.objectLive(child).flags.fertile === true);
    const instances = children.filter((child) => this.objectLive(child).flags.fertile !== true);
    const parentChain: Record<string, WooValue>[] = [];
    let current: ObjRef | null = objRef;
    while (current) {
      const item: WooObject | null = current === objRef ? this.objectLive(current) : this.parentWalkLookup(objRef, current);
      if (!item) {
        parentChain.push({ id: current, name: "<missing>", missing: true });
        break;
      }
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
          const featureObj = this.objectLive(feature);
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
      const obj = this.objectLive(id);
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

  /**
   * Surface membership: does `actor` carry the authoring surface `surfaceClass`?
   *
   * True when the class is on the actor's own parent chain (legacy $builder /
   * $programmer *descendants*) OR is reachable through one of the actor's
   * attached features (the feature-composed provisioning shape: an $agent that
   * keeps its kind ancestry and gains $programmer as a feature). Feature
   * resolution mirrors the dispatcher's FT2 walk in resolveVerb — each attached
   * feature is considered together with its own parent chain, so attaching
   * $programmer (which inherits $builder) satisfies both the programmer and the
   * builder surface.
   *
   * This is the single predicate behind every surface guard: the DSL
   * has_surface() builtin and the native assert helpers below both route
   * through it, so ancestry and feature composition can never diverge on who
   * may author. It is generic over `surfaceClass`; core names no particular
   * catalog class here.
   */
  actorHasSurface(actor: ObjRef, surfaceClass: ObjRef): boolean {
    if (this.inheritsFrom(actor, surfaceClass)) return true;
    if (this.canCarryFeatures(actor)) {
      for (const feature of this.featureList(actor)) {
        if (this.inheritsFrom(feature, surfaceClass)) return true;
      }
    }
    return false;
  }

  private assertProgrammerActor(actor: ObjRef, surfaceClass: ObjRef): void {
    const obj = this.objectLive(actor);
    if (obj.flags.wizard === true) return;
    // Proxy guard (§8.5): the surface class itself is never a valid actor, even
    // though actorHasSurface would match it reflexively via ancestry.
    if (actor === surfaceClass) throw wooError("E_PERM", "programmer class surface required", { actor, surface: surfaceClass });
    if (!this.actorHasSurface(actor, surfaceClass)) throw wooError("E_PERM", "programmer class surface required", { actor, surface: surfaceClass });
    if (obj.flags.programmer === true) return;
    throw wooError("E_PERM", "programmer flag required", actor);
  }

  private assertBuilderActor(actor: ObjRef, surfaceClass: ObjRef): void {
    if (this.isWizard(actor)) return;
    if (actor === surfaceClass) throw wooError("E_PERM", "builder class surface required", { actor, surface: surfaceClass });
    if (this.actorHasSurface(actor, surfaceClass)) return;
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
      const obj: WooObject | null = current === editorRef ? this.objectLive(current) : this.parentWalkLookup(editorRef, current);
      if (!obj) break;
      const def = obj.propertyDefs.get("sessions");
      if (def) return def.perms === "" ? def : null;
      current = obj.parent;
    }
    return null;
  }

  private editorSessionMap(editorRef: ObjRef): Record<string, WooValue> {
    this.assertEditorObject(editorRef);
    const raw = this.propOrNullLive(editorRef, "sessions");
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
      install_mode: session.install_mode,
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
    const home = this.objects.has(session.actor) ? this.propOrNullLive(session.actor, "home") : null;
    return typeof home === "string" && this.objects.has(home) ? home : "$nowhere";
  }

  private async moveEditorActor(ctx: CallContext, destination: ObjRef, previousLocation: ObjRef | null): Promise<void> {
    this.objectLive(destination);
    const actor = ctx.actor;
    // Capture the session's scope BEFORE any presence update. For a space-like
    // destination `updatePresence` sets `activeScope` as a side effect of
    // joining presence, so reading it afterwards reports the destination and
    // the transition below looks like a no-op. That silent mutation is enough
    // locally, but over Net only a recorded `session_scope` event becomes the
    // committed session-cell write (foldSessionEffects), and the MCP session
    // scope is read from that cell — so without this the actor entered the
    // editor while its session still pointed at the old room.
    const sessionRow = ctx.session ? this.sessions.get(ctx.session) : undefined;
    const editorSession = sessionRow && sessionRow.actor === actor ? sessionRow : null;
    const priorScope = editorSession?.activeScope ?? null;
    const current = await this.objectLocationChecked(actor, ctx.hostMemo);
    // Exit presence is keyed by the moving SESSION's active scope when one
    // exists (moveto.md M2.1 step 4: an actor may hold several sessions, and
    // only presence-at-scope is meaningful for exit routing). The physical
    // location is the fallback for the sessionless object-graph path only —
    // using it for a secondary session would strip the actor's presence from
    // the primary session's room.
    const exitScope = editorSession ? priorScope : current;
    if (exitScope && exitScope !== destination && this.objects.has(exitScope) && this.isSpaceLike(exitScope)) {
      await this.updatePresenceChecked(actor, exitScope, false, ctx);
    }
    if (this.isSpaceLike(destination)) {
      await this.updatePresenceChecked(actor, destination, true, ctx);
    }
    // Independent of space-likeness. This used to be the `else` of the branch
    // above, which left the space-like case recording no scope transition at
    // all: the plain object move below is not the actor-move path that normally
    // records one (see movetoActorChecked). A space-like editor therefore took
    // the actor in physically while its session still pointed at the old room,
    // so the editor's own verbs never entered the session's context. Presence
    // and active scope now move together, as they do for ordinary room
    // movement.
    if (editorSession) {
      // CA8: record the active-scope transition so presence projections +
      // session-row materialization follow editor movement, not just physical
      // room movement (see movetoActorChecked). Compared against the scope
      // captured above, not the live row, for the reason given there.
      if (priorScope !== destination) {
        this.recordTurnEvent({
          kind: "session_scope",
          session: editorSession.id,
          actor,
          from: priorScope,
          to: destination,
          ...(editorSession.rosterVisible === false ? { rosterVisible: false } : {})
        });
      }
      this.setSessionActiveScope(editorSession, destination);
      this.persistSession(editorSession);
    }
    // Primary-session gate (moveto.md M2.1 step 7, same rule as
    // movetoActorChecked): only the actor's primary session performs the
    // physical relocate — a secondary session moves its own scope and
    // presence but must not drag the shared body along. The sessionless
    // object-graph fallback (seed/install movement) still relocates.
    const primary = editorSession ? this.primarySessionForActor(actor) : null;
    if (!editorSession || primary?.id === editorSession.id) {
      await this.moveObjectChecked(actor, destination);
    }
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
      const obj = this.parentWalkLookup(objRef, current);
      if (!obj) break;
      current = obj.parent;
    }
    if (this.canCarryFeatures(objRef)) {
      for (const feature of this.featureList(objRef)) {
        let featureCurrent: ObjRef | null = feature;
        while (featureCurrent) {
          const match = this.ownVerbNamed(featureCurrent, name);
          walk.push({ id: featureCurrent, kind: "feature", feature, matched: match !== null });
          if (match) return { definer: featureCurrent, verb: match };
          const obj = this.parentWalkLookup(feature, featureCurrent);
          if (!obj) break;
          featureCurrent = obj.parent;
        }
      }
    }
    throw wooError("E_VERBNF", `verb not found: ${objRef}:${name}`, { obj: objRef, name, actor });
  }

  private resolveVerbSlotWithWalk(actor: ObjRef, objRef: ObjRef, slot: number, walk: Record<string, WooValue>[]): ResolvedVerb {
    if (!Number.isInteger(slot) || slot < 1) throw wooError("E_INVARG", "verb slot must be a positive integer", slot);
    const obj = this.objectLive(objRef);
    // By slot VALUE, not array index — see ownVerbResolve.
    const verb = obj.verbs.find((entry) => entry.slot === slot);
    walk.push({ id: objRef, kind: "slot", slot, matched: verb !== undefined });
    if (!verb) throw wooError("E_VERBNF", `verb slot not found: ${objRef}:${slot}`, { obj: objRef, slot, actor });
    return { definer: objRef, verb };
  }

  private selectOwnVerbForInstall(
    objRef: ObjRef,
    descriptor: WooValue,
    options: { mode: string; append: boolean }
  ): { current: VerbDef | null; slot: number; name: string; append: boolean } {
    const obj = this.objectLive(objRef);
    if (typeof descriptor === "number") {
      if (!Number.isInteger(descriptor) || descriptor < 1) throw wooError("E_INVARG", "verb slot must be a positive integer", descriptor);
      // By slot VALUE, not array index — see ownVerbResolve.
      const current = obj.verbs.find((verb) => verb.slot === descriptor) ?? null;
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
      // An update keeps the page's own slot; a new verb reports the ordinal the
      // append will allocate. `obj.verbs.length + 1` was the same array-index
      // guess addVerb made, and under Net planning both were 1 for every verb.
      slot: current ? (current.slot ?? this.nextVerbSlot(obj)) : this.nextVerbSlot(obj),
      name,
      append: options.append || !current
    };
  }

  private ownVerbNamed(objRef: ObjRef, name: string): VerbDef | null {
    const obj = this.objectLive(objRef);
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
      reads_room_presence: verb.reads_room_presence === true,
      reads_ordered_children: verb.reads_ordered_children === true,
      readable
    };
    if (readable && options.includeSource) {
      summary.source = verb.source;
      summary.line_map = verb.line_map as WooValue;
    }
    return summary;
  }

  private inheritedVerbSummaries(actor: ObjRef, objRef: ObjRef, includeSource: boolean): Record<string, WooValue>[] {
    const shadowed = new Set<string>(this.objectLive(objRef).verbs.map((verb) => verb.name));
    const summaries: Record<string, WooValue>[] = [];
    let current = this.objectLive(objRef).parent;
    while (current) {
      const obj = this.parentWalkLookup(objRef, current);
      if (!obj) break;
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
          const obj = this.parentWalkLookup(feature, featureCurrent);
          if (!obj) break;
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
    const obj = this.objectLive(objRef);
    const names = new Set<string>([...obj.propertyDefs.keys(), ...obj.properties.keys()]);
    return Array.from(names).sort().map((name) => this.propertySummaryForActor(actor, objRef, name, maxValueBytes, objRef));
  }

  private inheritedPropertySummaries(actor: ObjRef, objRef: ObjRef, maxValueBytes: number): Record<string, WooValue>[] {
    const seen = new Set<string>(this.objectLive(objRef).propertyDefs.keys());
    const summaries: Record<string, WooValue>[] = [];
    let current = this.objectLive(objRef).parent;
    while (current) {
      const obj = this.parentWalkLookup(objRef, current);
      if (!obj) break;
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
    const actorObj = this.objectLive(actor);
    // No "all" scope: a global object enumeration is forbidden on Net
    // (spec/semantics/distribution.md) and on any host it would return only the
    // misleading local closure. "owned" is bounded to the actor's own objects
    // (plan §7). An unrecognized scope (including "all") is rejected below.
    if (scope === "owned") {
      for (const obj of this.objects.values()) if (obj.owner === actor) add(obj.id);
    } else {
      add(actor);
      add(actorObj.location);
      for (const item of actorObj.contents) add(item);
      if (actorObj.location && this.objects.has(actorObj.location)) {
        for (const item of this.objectLive(actorObj.location).contents) add(item);
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
      this.objectLive(parent);
      this.objectLive(owner);
      if (anchor) this.objectLive(anchor);
      const progr = options.progr ?? owner;
      this.assertCanCreateObject(progr, parent, owner);
      // Generic creation follows the executing-host contract (objects.md §4.1):
      // `anchor` defaults to null and stays whatever the caller passed. It is
      // NOT co-located to the author's cluster — that fallback is the builder
      // surface's authoring-workspace behavior alone (createBuilderObject), so an
      // ordinary or wizard-helper create keeps its parent-scoped placement.
      // Self-hosted instances cannot be anchored. Per
      // spec/semantics/objects.md §4.1, combining the self-placement marker
      // with a non-null anchor would route the instance to its own DO (rule 1)
      // while declaring it a member of another cluster, breaking
      // co-residency. The recycle anchored-descendants check (recycle.md
      // §RC3 pre-flight A3) relies on this.
      if (anchor !== null && this.propOrNullLive(parent, "instances_self_host") === true) {
        throw wooError("E_INVARG", `cannot anchor a self-hosted instance`, { parent, anchor });
      }
      const location = options.location ?? null;
      if (location) this.objectLive(location);
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
      // When the resolved class declares self-placement for instances,
      // the routing layer expects the new instance to carry
      // `host_placement: "self"` so its own DO becomes the host root.
      // Without this, the class-level signal is the only marker — and
      // walking class defaults from objectRoutes() would also treat the
      // class itself as self-hosted (which it isn't; classes live on
      // WORLD). Setting host_placement on the instance is the spec's
      // per-instance representation (§4.2 routing precedence: rule 1).
      if (this.propOrNullLive(parent, "instances_self_host") === true) {
        this.setProp(id, "host_placement", "self");
      }
      this.persistCounters();
      return id;
    });
  }

  createAuthoredObject(actor: ObjRef, input: { parent: ObjRef; name?: string; description?: string; aliases?: WooValue[]; location?: ObjRef | null }): ObjRef {
    const parent = assertObj(input.parent);
    const location = input.location ?? null;
    if (location) {
      this.objectLive(location);
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
    this.objectLive(targetRef);
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
    if (!objRemote) this.objectLive(objRef);
    if (!targetRemote) this.objectLive(targetRef);

    if (objRemote && ctx.deferHostEffect) {
      await this.invokeAcceptableHook(ctx, targetRef, objRef);
      const oldLocation = await this.objectLocationChecked(objRef, ctx.hostMemo);
      if (oldLocation && (this.objects.has(oldLocation) || await this.remoteHostForObject(oldLocation, ctx.hostMemo))) {
        await this.invokeContainerHookSwallow(ctx, oldLocation, "exitfunc", [objRef]);
      }
      this.mirrorRemoteMoveLocally(objRef, targetRef);
      ctx.deferHostEffect({ kind: "move_object", obj: objRef, target: targetRef, suppress_mirror_host: this.executorContext?.localHost ?? null });
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
      if (!await this.remoteHostForObject(targetRef, ctx.hostMemo)) this.objectLive(targetRef);
      // CA11.2 occupancy transition. The destination of a move is resolved at the
      // VM (from an exit's `dest`), so it is not in the authority payload's
      // served-scope set — the gateway may have served its lineage as a
      // non-authoritative one-hop topology pre-seed (correct for a NEIGHBOR a turn
      // merely reads, but NOT for a scope the actor now occupies and commits
      // against: that seed carries no `exits`/live cells). If the destination is
      // a LOCAL-resident row whose recorded planning provenance is non-
      // authoritative, force an owner-authoritative repair before commit: raise a
      // repairable E_NEED_STATE naming the destination. The repair pass force-
      // fetches the owner row (reconstructionReason "missing_state_repair"
      // disables topology refresh-suppression), which displaces the seed by CA11
      // precedence, and the executor re-plans against the owner's exits-bearing
      // row. A remote destination has no local seed to displace, and a turn with
      // no attached planning provenance (authoritative/cold-load) skips the check.
      this.assertMovementDestinationOwnerAuthority(targetRef);
      await this.invokeAcceptableHook(ctx, targetRef, actor);
      const oldLocation = session.activeScope;
      if (oldLocation && (this.objects.has(oldLocation) || await this.remoteHostForObject(oldLocation, ctx.hostMemo))) {
        await this.invokeContainerHookSwallow(ctx, oldLocation, "exitfunc", [actor]);
      }
      // A recorded turn derives subscriber mirrors from the accepted session
      // transition. Reading and mutating those mirrors while planning would
      // turn projection rows into authority reads; net authorities correctly
      // serve them as relations, so such reads can never be refreshed as
      // cells and would grind the repair loop to E_BUDGET. Direct/local moves
      // still maintain the mirrors immediately because no later transcript
      // materialization exists on that path.
      const derivesPresenceFromTranscript = this.activeTurnRecorder !== null;
      if (!derivesPresenceFromTranscript && oldLocation && await this.spaceLikeOrRemote(oldLocation, ctx.hostMemo)) {
        await this.updatePresenceChecked(actor, oldLocation, false, ctx);
      }
      // Record the session active-scope transition as a first-class turn effect
      // (CA8). This fires even when the physical move below is a no-op (the actor
      // was already in `targetRef`): presence is keyed by session placement, not
      // physical containment. The accepted transcript carries this so every
      // materializer can repair the live presence projections + session row.
      if (oldLocation !== targetRef) {
        this.recordTurnEvent({
          kind: "session_scope",
          session: session.id,
          actor,
          from: oldLocation ?? null,
          to: targetRef,
          ...(session.rosterVisible === false ? { rosterVisible: false } : {})
        });
      }
      this.setSessionActiveScope(session, targetRef);
      if (derivesPresenceFromTranscript) {
        this.applyTransientRoomRosterTransition(session, oldLocation, targetRef);
      }
      this.persistSession(session);
      const primary = this.primarySessionForActor(actor);
      const isPrimary = primary?.id === session.id;
      const remoteActorHost = await this.remoteHostForObject(actor, ctx.hostMemo);
      // Diagnostic: capture whether the primary-session guard fires the
      // physical-move branch. Bug B (outline:leave server vs client
      // divergence) shows session.activeScope updating but actor.location
      // staying at the_outline — that would happen if isPrimary=false here.
      this.recordMetric({
        kind: "moveto_actor",
        actor,
        session_id: session.id,
        from: oldLocation ?? null,
        to: targetRef,
        is_primary: isPrimary,
        primary_session_id: primary?.id ?? null,
        remote_actor_host: Boolean(remoteActorHost),
        defer_host_effect: Boolean(ctx.deferHostEffect)
      });
      if (isPrimary) {
        if (ctx.deferHostEffect && remoteActorHost) {
          this.mirrorRemoteMoveLocally(actor, targetRef);
          ctx.deferHostEffect({ kind: "move_object", obj: actor, target: targetRef, suppress_mirror_host: this.executorContext?.localHost ?? null });
        } else {
          await this.moveObjectChecked(actor, targetRef);
        }
      }
      if (!derivesPresenceFromTranscript && await this.spaceLikeOrRemote(targetRef, ctx.hostMemo)) {
        await this.updatePresenceChecked(actor, targetRef, true, ctx);
      }
      if (this.objects.has(targetRef) || await this.remoteHostForObject(targetRef, ctx.hostMemo)) {
        await this.invokeContainerHookSwallow(ctx, targetRef, "enterfunc", [actor]);
      }
      return targetRef;
    }

    // CA11.2 occupancy-transition guard. If `targetRef` is the destination of a
    // move whose lineage was admitted into this planning world from a
    // non-authoritative topology pre-seed, throw a repairable E_NEED_STATE so the
    // executor refreshes the owner row before committing the move. No-op unless
    // (a) planning provenance was attached (sparse gateway path only), (b) the
    // target is local-resident (a remote target has no local seed to displace),
    // and (c) the recorded lineage (or live) provenance is present and NOT
    // "authoritative". The missing-atom shape matches planningInadmissibleNeedState
    // so the existing repair loop extracts the target id and re-plans.
    private assertMovementDestinationOwnerAuthority(targetRef: ObjRef): void {
      if (!this.enforceMovementOwnerRepair) return;
      const provenance = this.planningCellProvenance;
      if (!provenance) return;
      if (!this.objects.has(targetRef)) return;
      const lineageProv = provenance.get(this.effects.planningCellKey(targetRef, "object_lineage"));
      const liveProv = provenance.get(this.effects.planningCellKey(targetRef, "object_live"));
      // A recorded non-authoritative provenance on EITHER tracked cell means the
      // destination row standing locally is a derived copy (projection/cache/
      // fallback/gossip), not the owner's authority — it lacks the dynamic
      // `exits`/live state a move OUT of the now-occupied scope will read.
      const isNonAuthoritative = (prov: { source?: string } | undefined): boolean =>
        prov !== undefined && prov.source !== "authoritative";
      if (!isNonAuthoritative(lineageProv) && !isNonAuthoritative(liveProv)) return;
      const preimage = `read:cell:lifecycle:${targetRef}`;
      throw wooError("E_NEED_STATE", "movement destination served from non-authoritative topology pre-seed; repair to owner authority before commit", {
        missing_atoms: [{ hash: this.effects.shadowAtomHash(preimage), preimage }]
      });
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
      // Container hooks are core-dispatched on behalf of the moving object.
      // Give woocode that object as an unforgeable caller identity; inheriting
      // the surrounding verb's receiver made public hook names impossible to
      // guard consistently across room commands, object verbs, and actor moves.
      const movingObject = assertObj(args[0]);
      await this.dispatch({ ...ctx, caller: movingObject, callerPerms: ctx.progr }, target, name, args);
    } catch (err) {
      // Sparse-planning misses are control signals, not hook failures. They
      // must reach the gateway so it can fetch the missing owner projection
      // and replay the WHOLE move; swallowing one would commit relocation
      // while silently skipping the hook's ordered-edge writes/observations.
      if (isUncatchableControlSignal(err)) throw err;
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
      if (!await this.remoteHostForObject(targetRef, ctx.hostMemo)) this.objectLive(targetRef);
      this.mirrorRemoteMoveLocally(objRef, targetRef);
      ctx.deferHostEffect({ kind: "move_object", obj: objRef, target: targetRef, suppress_mirror_host: this.executorContext?.localHost ?? null });
      return;
    }
    if (!await this.remoteHostForObject(targetRef, ctx?.hostMemo)) this.objectLive(targetRef);
    await this.moveObjectChecked(objRef, targetRef);
  }

  async moveObjectChecked(objRef: ObjRef, targetRef: ObjRef, options: { suppressMirrorHost?: string | null } = {}): Promise<MoveObjectResult> {
    if (await this.remoteHostForObject(objRef)) {
      if (!this.executorContext) throw wooError("E_INTERNAL", "remote host bridge unavailable");
      const effect = this.effects.remoteBridgeUntrackedEffect("move", { object: objRef, target: targetRef });
      this.recordUntrackedEffect(effect.name, effect.detail);
      return await this.executorContext.moveObject(objRef, targetRef, options);
    }
    return await this.moveObjectOwned(objRef, targetRef, options);
  }

  contentsOf(objRef: ObjRef): ObjRef[] {
    const obj = this.objectLive(objRef);
    const value = Array.from(obj.contents);
    this.recordTurnEvent({
      kind: "cell_read",
      cell: { kind: "contents", object: objRef },
      version: this.structuralVersionForRecording("contents", objRef),
      value
    });
    return value;
  }

  repairDerivedContentsIndex(options: { persist?: boolean } = {}): DerivedContentsRepairResult {
    this.assertOutsideBehaviorMutation("repairDerivedContentsIndex");
    return this.withBehaviorMutationPermit(() => this.repairDerivedContentsIndexPermitted(options));
  }

  private repairDerivedContentsIndexPermitted(options: { persist?: boolean }): DerivedContentsRepairResult {
    // `location` is the authoritative movement cell. `contents` is a derived
    // compatibility index used by catalogs and cached gateway views, so a full
    // host-local world may safely rebuild it from local object rows. This is
    // intentionally stricter than the sparse SerializedAuthoritySlice repair:
    // sparse slices preserve unknown members because absence can mean "not in
    // the slice"; a loaded host snapshot has no such excuse for a local
    // container row.
    const persist = options.persist !== false;
    const desiredByContainer = new Map<ObjRef, Set<ObjRef>>();
    for (const obj of this.objects.values()) {
      if (!obj.location || obj.location === "$nowhere" || !this.objects.has(obj.location)) continue;
      let members = desiredByContainer.get(obj.location);
      if (!members) {
        members = new Set();
        desiredByContainer.set(obj.location, members);
      }
      members.add(obj.id);
    }

    const repairedContainers: ObjRef[] = [];
    let inspectedContainers = 0;
    let membersAdded = 0;
    let membersRemoved = 0;
    let missingMembersRemoved = 0;

    for (const container of Array.from(this.objects.values()).sort((a, b) => a.id.localeCompare(b.id))) {
      const before = Array.from(container.contents).sort();
      if (before.length === 0 && !desiredByContainer.has(container.id)) continue;
      inspectedContainers += 1;
      const next = new Set<ObjRef>();
      for (const member of before) {
        const memberRow = this.objects.get(member);
        if (!memberRow) {
          membersRemoved += 1;
          missingMembersRemoved += 1;
          continue;
        }
        if (memberRow.location !== container.id) {
          membersRemoved += 1;
          continue;
        }
        // $nowhere is a sink, not a maintained container (§B2.15). Clear stale
        // back-references there rather than reconstructing them.
        if (container.id === "$nowhere") {
          membersRemoved += 1;
          continue;
        }
        next.add(member);
      }
      if (container.id !== "$nowhere") {
        for (const member of desiredByContainer.get(container.id) ?? []) {
          if (!next.has(member)) membersAdded += 1;
          next.add(member);
        }
      }
      const after = Array.from(next).sort();
      if (before.length === after.length && before.every((member, index) => member === after[index])) continue;
      container.contents = new Set(after);
      container.modified = Date.now();
      repairedContainers.push(container.id);
      if (persist) this.persistObject(container.id);
    }
    if (persist && repairedContainers.length > 0) this.persist();
    return {
      inspected_containers: inspectedContainers,
      repaired_containers: repairedContainers,
      members_added: membersAdded,
      members_removed: membersRemoved,
      missing_members_removed: missingMembersRemoved
    };
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
    this.withBehaviorMutationPermit(() => this.mirrorContentsPermitted(containerRef, objRef, present));
  }

  private mirrorContentsPermitted(containerRef: ObjRef, objRef: ObjRef, present: boolean): void {
    const container = this.objectLive(containerRef);
    if (present) container.contents.add(objRef);
    else container.contents.delete(objRef);
    container.modified = Date.now();
    this.persistObject(containerRef);
    this.persist();
  }

  private mirrorRemoteMoveLocally(objRef: ObjRef, targetRef: ObjRef): void {
    this.withBehaviorMutationPermit(() => {
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
        const target = this.objectLive(targetRef);
        if (!target.contents.has(objRef)) {
          target.contents.add(objRef);
          target.modified = Date.now();
          this.persistObject(targetRef);
          changed = true;
        }
      }
      if (changed) this.persist();
    });
  }

    setActorPresence(actor: ObjRef, space: ObjRef, present: boolean, sessionId: string = this.presenceSessionId(actor)): boolean {
      if (present) {
        const session = this.sessions.get(sessionId);
        if (session && session.actor === actor) {
          this.setSessionActiveScope(session, space);
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
    this.assertOutsideBehaviorMutation("applyDeferredHostEffects");
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
    if (!remote) {
      const obj = this.objectLive(objRef);
      this.recordTurnEvent({
        kind: "cell_read",
        cell: { kind: "location", object: objRef },
        version: this.structuralVersionForRecording("location", objRef),
        value: obj.location
      });
      return obj.location;
    }
    if (!this.executorContext) throw wooError("E_INTERNAL", "remote host bridge unavailable");
    const effect = this.effects.remoteBridgeUntrackedEffect("location", { object: objRef });
    this.recordUntrackedEffect(effect.name, effect.detail);
    return await this.executorContext.location(objRef, memo);
  }

  async observeToSpace(ctx: CallContext, space: ObjRef, event: Observation): Promise<void> {
    const type = assertString(event.type);
    const observation: Observation = { ...event, type, source: event.source ?? space };
    const remote = await this.remoteHostForObject(space, ctx.hostMemo);
    if (!remote) {
      if (!this.inheritsFrom(space, "$space")) throw wooError("E_TYPE", `${space} is not a space`, space);
    } else if (this.activeTurnRecorder === null) {
      // Direct cross-host observations need an eager audience because no
      // accepted transcript will later reach the space owner. Recorded turns
      // deliberately omit it: the owner computes delivery from its
      // session_presence relation. Fetching compatibility subscriber mirrors
      // here would promote a derived projection into an authority read and can
      // never converge through cell-closure repair.
      try {
        const sessionSubscribers = await this.getPropChecked(ctx.progr, space, "session_subscribers", ctx.hostMemo);
        if (Array.isArray(sessionSubscribers)) {
          (observation as Record<string, WooValue>)._audience_override = Array.from(new Set(sessionSubscribers
            .filter((item): item is Record<string, WooValue> => !!item && typeof item === "object" && !Array.isArray(item))
            .map((item) => item.actor)
            .filter((item): item is ObjRef => typeof item === "string")));
        } else {
          const subscribers = await this.getPropChecked(ctx.progr, space, "subscribers", ctx.hostMemo);
          if (Array.isArray(subscribers)) {
            (observation as Record<string, WooValue>)._audience_override = subscribers.filter((item): item is ObjRef => typeof item === "string");
          }
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
      ts: this.logicalNow("tell.ts")
    });
  }

  private localAncestry(objRef: ObjRef): ObjRef[] {
    const ids: ObjRef[] = [];
    let current: ObjRef | null = objRef;
    while (current && this.objects.has(current)) {
      ids.push(current);
      current = this.objectLive(current).parent;
    }
    return ids;
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
    // An unknown topic is a reply, not a failure. This used to record the miss
    // on the first db as a `missed_topics` property write; that write is
    // refused on Net worlds (E_CATALOG_MUTATION — ordinary turns cannot mutate
    // installed catalog state), nothing ever read it back, and the refusal is a
    // turn verdict rather than a catchable error, so it failed the whole help
    // call. The reply now carries the valid topic list instead.
    const topics: string[] = [];
    for (const db of dbs) {
      for (const name of Object.keys(this.helpDbTopics({ ...ctx, thisObj: db }))) {
        if (!topics.includes(name)) topics.push(name);
      }
    }
    const lines = [`No help available for "${topic || "index"}".`];
    if (topics.length > 0) lines.push(`Topics: ${topics.join(", ")}`);
    return {
      ok: false,
      status: "not_found",
      topic,
      topics,
      lines
    };
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
        const { definer, verb } = this.resolveVerbLive(obj, name);
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

  chparentAuthoredObject(actor: ObjRef, objRef: ObjRef, parentRef: ObjRef): void {
    this.assertCanAuthorObject(actor, objRef);
    this.assertCanCreateObject(actor, parentRef, actor);
    if (objRef === parentRef || this.inheritsFrom(parentRef, objRef)) throw wooError("E_RECMOVE", "recursive parent change", { obj: objRef, parent: parentRef });
    this.chparentLocal(objRef, parentRef);
  }

  private chparentLocal(objRef: ObjRef, parentRef: ObjRef): void {
    const obj = this.objectLive(objRef);
    this.withBehaviorMutationPermit(() => {
      if (obj.parent && this.objects.has(obj.parent)) this.objectLive(obj.parent).children.delete(objRef);
      // `parent` lives in the object_lineage cell. Route it through the seam so a
      // runtime @chparent records the lineage write over Net. Off-turn callers
      // (bootstrap, host-scoped migrations) no-op the recorder — see mutateLineage.
      this.mutateLineage(objRef, () => { obj.parent = parentRef; });
      this.objectLive(parentRef).children.add(objRef);
      obj.modified = Date.now();
    });
    this.persistObject(objRef);
    this.persistObject(parentRef);
    this.persist();
  }

  private createBuilderObject(parent: ObjRef, owner: ObjRef, anchor: ObjRef | null, options: { location: ObjRef | null; name?: string; fertile: boolean }): ObjRef {
    this.objectLive(parent);
    this.objectLive(owner);
    const selfHosted = this.propOrNullLive(parent, "instances_self_host") === true;
    // A builder object with no explicit space anchor co-locates in its AUTHOR's
    // authority cluster (§7 authoring workspace), not the catalog scope — so a
    // later source install on it is a local cluster write, not E_CATALOG_MUTATION
    // (an anchorless instance classifies catalog-adjacent). A self-hosted parent
    // stays anchorless (it roots its own DO; the rejection below relies on this).
    const effectiveAnchor =
      anchor === null && !selfHosted && this.isActorDescendant(owner)
        ? this.authorityAnchorRoot(owner)
        : anchor;
    if (effectiveAnchor) this.objectLive(effectiveAnchor);
    // Mirror the createRuntimeObject self-host/anchor rejection. See
    // spec/semantics/objects.md §4.1.
    if (effectiveAnchor !== null && selfHosted) {
      throw wooError("E_INVARG", `cannot anchor a self-hosted instance`, { parent, anchor: effectiveAnchor });
    }
    const scope = runtimeObjectScope(effectiveAnchor ?? parent);
    let id: ObjRef;
    do {
      id = `obj_${scope}_${this.objectCounter++}`;
    } while (this.objects.has(id));
    this.createObject({
      id,
      parent,
      owner,
      anchor: effectiveAnchor,
      location: options.location,
      name: options.name,
      flags: { fertile: options.fertile }
    });
    // See createRuntimeObject for rationale.
    if (selfHosted) {
      this.setProp(id, "host_placement", "self");
    }
    this.persistCounters();
    return id;
  }

  private assertCanBuildOwnedObject(actor: ObjRef, objRef: ObjRef): void {
    const obj = this.objectLive(objRef);
    if (this.isWizard(actor) || obj.owner === actor) return;
    throw wooError("E_PERM", `${actor} cannot build on ${objRef}`, { actor, obj: objRef });
  }

  private assertCanBuildChild(actor: ObjRef, parent: ObjRef, owner: ObjRef): void {
    const parentObj = this.objectLive(parent);
    if (this.isWizard(actor)) return;
    if (owner !== actor) throw wooError("E_PERM", `${actor} cannot create objects owned by ${owner}`, { actor, owner });
    if (parentObj.owner !== actor && parentObj.flags.fertile !== true) {
      throw wooError("E_PERM", `${actor} cannot create children of ${parent}`, { actor, parent });
    }
  }

  private recycleObjectLocal(objRef: ObjRef): void {
    this.withBehaviorMutationPermit(() => this.recycleObjectLocalPermitted(objRef));
  }

  private recycleObjectLocalPermitted(objRef: ObjRef): void {
    const obj = this.objectLive(objRef);
    // Editor sessions referencing this ULID are cleaned lazily on next
    // access via editorSessionOrNull — the eager scrub that lived here
    // moved to a §RC5-style lazy check.

    // Step 2: kill parked tasks anchored to obj. Any task whose parked_on,
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
      const contentObj = this.objectLive(content);
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
      this.objectLive(parent).children.delete(objRef);
      this.persistObject(parent);
    }
    if (location && this.objects.has(location)) {
      this.objectLive(location).contents.delete(objRef);
      this.persistObject(location);
    }
    // R1: a recycled object must vanish from same-run ordering answers even
    // when nothing cleared its edge first (the outliner detaches before
    // recycling, but the substrate must not depend on that).
    if (this.requireOrderedChildrenProjection && !this.orderedEdgeWritesThisRun.has(objRef)) {
      const obj2 = this.objects.get(objRef);
      this.noteOrderedEdgeWriteThisRun(
        objRef,
        this.priorOrderingMembership(objRef, obj2?.properties.has(ORDERED_EDGE_PROP) === true, obj2?.properties.get(ORDERED_EDGE_PROP))
      );
    }
    // Steps 8/9: storage delete and tombstone insert.
    this.objects.delete(objRef);
    this.tombstones.add(objRef);
    this.recordTombstoneProjectionUpsert(objRef);
    this.deletePersistedObject(objRef);
    this.persistTombstone(objRef);
    if (this.presenceIndexBuilt) this.invalidatePresenceIndex();
    this.persist();
  }

  private assertCanCreateObject(progr: ObjRef, parent: ObjRef, owner: ObjRef): void {
    const progrObj = this.objectLive(progr);
    const parentObj = this.objectLive(parent);
    if (progrObj.flags.wizard === true) return;
    if (owner !== progr) throw wooError("E_PERM", `${progr} cannot create objects owned by ${owner}`, { progr, owner });
    if (progrObj.flags.programmer !== true) throw wooError("E_PERM", `${progr} does not have programmer authority`, progr);
    if (parentObj.owner !== progr && parentObj.flags.fertile !== true) {
      throw wooError("E_PERM", `${progr} cannot create children of ${parent}`, { progr, parent });
    }
  }

  exportWorld(): SerializedWorld {
    return {
      version: 1,
      objectCounter: this.objectCounter,
      sessionCounter: this.sessionCounter,
      objects: Array.from(this.objects.values())
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((obj) => this.serializeObject(obj)),
      sessions: Array.from(this.sessions.values())
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((session) => this.serializeSession(session)),
      logs: Array.from(this.logs.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([space, entries]) => [space, cloneValue(entries as unknown as WooValue) as unknown as SpaceLogEntry[]]),
      snapshots: cloneValue(this.snapshots as unknown as WooValue) as unknown as SpaceSnapshotRecord[],
      tombstones: Array.from(this.tombstones).sort()
    };
  }

  exportSessions(): SerializedSession[] {
    // Transport relays need fresh session claims for auth/revocation checks, but
    // not a full world snapshot. Keep this narrow so hot-path gateways do not
    // serialize object/log state just to refresh bearer-token authority.
    return Array.from(this.sessions.values())
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((session) => this.serializeSession(session));
  }

  exportObjects(ids: Iterable<ObjRef>): SerializedObject[] {
    // Commit-scope relays sometimes need object authority for session-bound
    // actors minted after the scope snapshot opened. Export the named records
    // only, preserving the no-full-world hot-path discipline.
    const out: SerializedObject[] = [];
    const seen = new Set<ObjRef>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const obj = this.objects.get(id);
      if (obj) out.push(this.serializeObject(obj));
    }
    return out;
  }

  exportAuthoritySlice(sessions: SerializedSession[] = this.exportSessions(), extraObjectIds: Iterable<ObjRef> = []): SerializedAuthoritySlice {
    // V2 commit scopes plan against durable, long-lived snapshots. On every
    // open/envelope the gateway sends the authoritative live cells needed to
    // validate and plan the next turn: session rows, session actor objects,
    // the rooms those sessions currently occupy, each room/object's immediate
    // contents, and each item's class/feature support rows. Refreshing a room
    // without its visible contents creates a half-fresh snapshot: contents()
    // returns a current content id, but dispatch/isa then fails
    // because the object row or its catalog class is absent. Keep the expansion
    // one-hop from explicit/session roots; callers that need deeper state must
    // name the deeper object as an explicit row.
    const ids: ObjRef[] = [];
    const seen = new Set<ObjRef>();
    const contentsExpanded = new Set<ObjRef>();
    // Value-ref tracing surfaces runtime instances named directly or one
    // wrapper level deep inside a property value. Examples that must work:
    //   `exit.dest = "room_ref"`                          (direct string)
    //   `room.exits = { southeast: "exit_ref" }`          (one-level map)
    //   `actor.inventory = ["item_a", "item_b"]`          (one-level array)
    // We deliberately do NOT recurse without limit: deeply nested catalog
    // tables (e.g. `room.scene_history = [{ drum: "$loop_class", ... }]`)
    // would otherwise drag the entire reachable-instance graph into every
    // slice. The wrapper (an array/map directly stored as the property
    // value) is followed; references inside *that* wrapper's string/array/
    // object children are walked once each, but we stop there. Anything
    // deeper must be named explicitly via executor.ts §executorAuthorityObjectIds.
    //
    // When we surface a runtime ref through this walk, we mark its push with
    // `traceValues: true` so the *target* gets one more hop of value-tracing
    // (e.g. `room.exits.southeast = exit_ref` then `exit_ref.dest =
    // room_ref`). The cascade stops at the target's targets — the room's
    // own exits do not pull in their destinations.
    const VALUE_TRACE_MAX_DEPTH = 2;
    const pushValueRefs = (value: WooValue, depth = 0, propagate = true): void => {
      if (typeof value === "string") {
        if (this.objects.has(value as ObjRef)) push(value as ObjRef, propagate ? { traceValues: "leaf" } : {});
        return;
      }
      if (depth >= VALUE_TRACE_MAX_DEPTH) return;
      if (Array.isArray(value)) {
        for (const item of value) pushValueRefs(item, depth + 1, propagate);
        return;
      }
      if (value && typeof value === "object") {
        for (const item of Object.values(value)) pushValueRefs(item, depth + 1, propagate);
      }
    };
    // Per-object trace mode (off=0 < leaf=1 < full=2). Slice expansion must
    // be monotonic: a second push that wants a stronger mode upgrades the
    // mode and re-runs the property-value walk. Without this, root order
    // would change the slice contents — a target reached first as an
    // owner/content dependency could never get its explicit-root property
    // tracing once `seen` had it.
    const TRACE_MODE_RANK: Record<"off" | "leaf" | "full", number> = { off: 0, leaf: 1, full: 2 };
    const objectMode = new Map<ObjRef, "off" | "leaf" | "full">();
    const desiredMode = (id: ObjRef, requested?: "full" | "leaf"): "off" | "leaf" | "full" => {
      if (requested) return requested;
      // $-prefixed catalog/helper classes leaf-trace anywhere we reach them.
      // Catalogs wire themselves together by property ($system.help_dbs →
      // $help) and the connected graph is small, so leaf-tracing is cheap.
      return id.startsWith("$") ? "leaf" : "off";
    };
    const push = (id: ObjRef | null | undefined, options: { includeContents?: boolean; traceValues?: "full" | "leaf" } = {}): void => {
      if (!id) return;
      const obj = this.objects.get(id);
      if (!obj) return;
      const wantedMode = desiredMode(id, options.traceValues);
      const currentMode = objectMode.get(id);
      const isFirstSee = !seen.has(id);
      if (isFirstSee) {
        seen.add(id);
        ids.push(id);
        // Dispatch dependencies for any reachable object: parent class chain,
        // owner, verb/prop definers, feature classes. Verb resolution walks
        // these chains and must find them in the slice.
        if (obj.parent) push(obj.parent);
        push(obj.owner);
        for (const def of obj.propertyDefs.values()) {
          push(def.owner);
          // Inherited reads fall through to `propertyDefs[*].defaultValue`
          // (src/core/property-read.ts) — a class default pointing at an
          // object ref must surface that object in the slice or dispatch
          // raises E_OBJNF when an instance reads the inherited property.
          // Leaf, no-propagation: the ref's row enters the slice but it
          // does not itself trigger another hop of value tracing.
          pushValueRefs(def.defaultValue, 0, false);
        }
        for (const verb of obj.verbs) {
          push(verb.owner);
          // Verb bodies dispatch on shared helper classes named by literal
          // in the bytecode. We surface
          // those refs precisely instead of falling back to a catalog-wide
          // $-prefix sweep: a turn whose bytecode names a helper pulls in
          // that helper; a turn that does not, does not. Native verbs have no
          // bytecode body to scan, so we just take the owner.
          if (verb.kind !== "native") {
            for (const literal of verb.bytecode?.literals ?? []) {
              if (typeof literal === "string" && literal.startsWith("$")) push(literal as ObjRef);
            }
          }
        }
        for (const feature of this.safeFeatureList(id)) push(feature);
      }
      // Apply (or upgrade) the property-value trace. The check is monotonic:
      // if this push wants a higher mode than what's been applied so far,
      // run the corresponding walk. If equal-or-lower, skip — the stronger
      // walk has already covered everything this push would do. Modes:
      //   full: explicit roots and their one-hop targets. Walk property
      //     values one wrapper level into arrays/maps, surfacing refs at
      //     leaf mode so the chain stops one hop later (`room.exits →
      //     exit → the_deck`, not the_deck's exits in turn).
      //   leaf: catalog $-classes and one-hop targets of explicit roots.
      //     Walk property values one wrapper level; surfaced refs land in
      //     the slice at off mode, no further trace.
      //   off: no value tracing. The object's row is in the slice; deeper
      //     dispatch reads the durable cache on the satellite.
      if (TRACE_MODE_RANK[wantedMode] > TRACE_MODE_RANK[currentMode ?? "off"]) {
        objectMode.set(id, wantedMode);
        if (wantedMode !== "off") {
          for (const [, value] of obj.properties) pushValueRefs(value, 0, wantedMode === "full");
        }
      }
      if (!options.includeContents || contentsExpanded.has(id)) return;
      contentsExpanded.add(id);
      for (const item of obj.contents) push(item);
    };
    for (const id of extraObjectIds) push(id, { includeContents: true, traceValues: "full" });
    for (const session of sessions) {
      push(session.actor, { includeContents: true, traceValues: "full" });
      if (session.activeScope) push(session.activeScope, { includeContents: true, traceValues: "full" });
      const actor = this.objects.get(session.actor);
      if (actor?.location) push(actor.location, { includeContents: true, traceValues: "full" });
    }
    // Catalog code (the $-prefixed class graph) is delivered separately. On
    // first open a satellite has no durable snapshot, the open is rejected with
    // E_SNAPSHOT_REQUIRED, and the gateway retries with the full serialized
    // seed attached — see persistent-object-do.ts §v2CommitScopeOpen. After
    // that the satellite holds the catalog durably, so per-envelope authority
    // refreshes need only carry the rooted state that may have changed. The
    // reachability walk above already covers catalog dependencies the turn
    // actually touches: parent classes, owners, feature classes, contents, and
    // refs threaded as explicit roots through executor.ts
    // §executorAuthorityObjectIds. An unconditional `for (id of objects.keys)
    // if (startsWith("$")) push(id)` sweep was removed (2026-05-20): on
    // production it inflated the slice to ~3 MB / 1000 page-refs and pushed
    // cold-open round-trips past the 5s HOST_READ_RPC_TIMEOUT ceiling.
    return this.effects.buildSerializedAuthorityCellSlice({
      sessions,
      objects: this.exportObjects(ids),
      counters: {
        objectCounter: this.objectCounter,
        sessionCounter: this.sessionCounter
      },
      tombstones: Array.from(this.tombstones),
      // A3: a world exporting its own resident rows is the authoritative source
      // for them. (Per-page owner-host stamping is added where the slice is
      // assembled for a specific host; here the role is unambiguous.)
      pageProvenance: () => ({ source: "authoritative" })
    });
  }

  /**
   * Round-trippable host slice. Returns SeedWorld shape (a
   * SerializedWorld slice plus the `objectHosts` routing map required
   * by spec/protocol/host-seeds.md §HS1).
   *
   * This export preserves logs, snapshots, and counters relevant to the
   * slice — it doubles as a satellite's self-slicing primitive, which must
   * round-trip losslessly. To produce a seed for delivery to a foreign host
   * (the HS1 contract: no logs/snapshots/sessions; tombstones scoped to
   * foreign-hosted ids; counters neutralized), call
   * `buildHostSeedForDelivery` instead.
   */
  exportHostScopedWorld(host: ObjRef): SeedWorld {
    const scope = this.hostScope(host);
    // Reuse hostScope's routing map instead of re-walking objectRoutes()
    // — for ~600 objects this saves a full pass + Map allocation per export.
    const objectHosts: Record<ObjRef, ObjRef> = {};
    for (const id of scope.objects) {
      objectHosts[id] = scope.hostByObject.get(id) ?? DEFAULT_OBJECT_HOST;
    }
    return {
      version: 1,
      objectCounter: nextScopedObjectCounter(scope.objects),
      sessionCounter: 1,
      objects: Array.from(scope.objects)
        .sort()
        .map((id) => this.serializeScopedObject(this.objectLive(id), scope.objects, scope.hostedObjects)),
      sessions: [],
      logs: Array.from(this.logs.entries())
        .filter(([space]) => scope.hostedSpaces.has(space))
        .map(([space, entries]) => [space, cloneValue(entries as unknown as WooValue) as unknown as SpaceLogEntry[]]),
      snapshots: (this.snapshots ?? [])
        .filter((snapshot) => scope.hostedSpaces.has(snapshot.space_id))
        .map((snapshot) => cloneValue(snapshot as unknown as WooValue) as unknown as SpaceSnapshotRecord),
      tombstones: Array.from(this.tombstones).sort(),
      objectHosts
    };
  }

  /**
   * Per spec/protocol/host-seeds.md §HS1: build the seed delivered to
   * a satellite. Strips logs/snapshots (gateway is not
   * authoritative for them on the receiver), neutralizes
   * gateway-global counters.
   *
   * Authoring metadata stripping: verbs ship with `line_map` blanked
   * to `{}`. line_map is large (per local measurements it dominates
   * the seed payload — full default-world seed JSON roughly halves
   * with it removed) and is only consulted for stack-trace formatting.
   * The seed-merge comparison ignores `line_map` (see
   * `normalizeVerbForCompare` in bootstrap.ts), so stored slices on
   * satellites keep any populated line_map they already have, and the
   * post-merge `runHostScopedLocalCatalogLifecycle` recompiles
   * bundled-catalog verbs on first arrival to fill it in. Verbs from
   * non-bundled sources end up with `line_map: {}` on satellites —
   * stack traces from those verbs lose line/column info on the
   * satellite, which is acceptable degradation.
   *
   * Cache: when many satellites cold-load in succession the gateway
   * may rebuild the same per-host slice repeatedly. Memoize on
   * (host, mutationVersion); any mutation bumps the version and
   * invalidates all cached seeds. Worst-case: one rebuild per host
   * per mutation, vs. one rebuild per host per cold-load.
   */
  buildHostSeedForDelivery(host: ObjRef): SeedWorld {
    return this.buildHostSeedForDeliveryWithDigest(host).seed;
  }

  /**
   * Returns the same SeedWorld as `buildHostSeedForDelivery` plus a
   * stable SHA-256 digest of its JSON body. The digest powers the
   * cheap "is the satellite's stored slice still current?" probe used
   * by satellite cold-loads to skip a full ~1 MB seed transfer when
   * nothing has changed since they were last awake.
   *
   * Two satellites observing the same digest are guaranteed to be
   * offered byte-identical seed bodies. The reverse is not true — a
   * verb edit that only touches `line_map` would produce a different
   * intermediate world but the SAME digest, because `line_map` is
   * stripped from delivery (see buildHostSeedForDelivery). That's
   * fine: line_map doesn't drive merge changes anyway.
   */
  buildHostSeedForDeliveryWithDigest(host: ObjRef): { seed: SeedWorld; digest: string } {
    const startedAt = Date.now();
    // Cache is invalidated by explicit delete from invalidateHostSeed,
    // not by version comparison. The `version` field is retained for
    // compatibility but no longer gates cache hits — the only way an
    // entry leaves the cache is a delete call from a persist site that
    // affected this host's slice.
    const cached = this.hostSeedCache.get(host);
    if (cached) {
      this.recordMetric({ kind: "host_seed_cache", host, status: "hit", ms: Date.now() - startedAt });
      return { seed: cached.seed, digest: cached.digest };
    }
    const missReason: "version_changed" | "absent" = "absent";
    const slice = this.exportHostScopedWorld(host);
    // The wire body keeps the insertion-order layout that the existing
    // mergeHostScopedSeed contract assumes: per-object arrays (verbs,
    // eventSchemas, properties, propertyDefs, propertyVersions) compare
    // positionally in some merge paths, so reordering them inside the
    // delivered seed would force false-positive merges against any
    // stored slice that was produced through plain serializeObject.
    // We strip line_map only — that drop is safe (the merge's
    // normalizeVerbForCompare already ignores line_map).
    const seed: SeedWorld = {
      ...slice,
      objectCounter: nextScopedObjectCounter(slice.objects.map((obj) => obj.id)),
      sessionCounter: 1,
      logs: [],
      snapshots: [],
      tombstones: slice.tombstones ?? [],
      objects: slice.objects.map(stripAuthoringMetadataFromObject)
    };
    // The digest is computed over a DIFFERENT, canonicalized form (the
    // wire body is left untouched). Canonical form sorts per-object
    // arrays and JSON object keys so the digest is stable across the
    // gateway's own eviction/reload — without it, insertion-order Maps
    // mid-runtime produce different bytes than alphabetical SQL
    // hydration even when no world content changed, and every gateway
    // cold-boot would force every satellite to take the full seed
    // transfer. The canonical form is gateway-internal, never
    // transmitted, so it doesn't perturb merge semantics.
    const digest = hashSource(canonicalJsonStringify(canonicalSeedForDigest(seed)));
    // A cache hit returns the same object for performance. Make that shared
    // identity immutable before publication so a caller cannot poison later
    // satellite cold-loads by retaining and editing the first result.
    deepFreezePlainValue(seed);
    // version is no longer consulted by the cache lookup (kept on the
    // entry shape for backward compatibility — invalidation is purely
    // by explicit delete). Capture the current mutationCounter as a
    // diagnostic stamp.
    this.hostSeedCache.set(host, { version: this.mutationCounter, seed, digest });
    this.recordMetric({ kind: "host_seed_cache", host, status: "miss", reason: missReason, ms: Date.now() - startedAt });
    return { seed, digest };
  }

  importWorld(serialized: SerializedWorld): void {
    this.assertOutsideBehaviorMutation("importWorld");
    // importWorld replaces every cell of the world. Any caller-visible
    // cache derived from prior state must be invalidated, including
    // the host-seed memoization keyed on mutationCounter.
    this.bumpMutationVersion();
    this.hostSeedCache.clear();
    this.withBehaviorMutationPermit(() => this.withPersistencePaused(() => {
      this.objects.clear();
      this.sessions.clear();
      this.logs.clear();
      this.snapshots = [];
      this.tombstones = new BehaviorMutationSet(
        (undo, id) => this.recordBehaviorUndo(undo, "tombstones", id),
        serialized.tombstones ?? [],
        (id) => this.assertBehaviorMutationPermitted("tombstones", id)
      );
      this.presenceIndexBuilt = false;
      this.subscribersIndex.clear();
      this.actorPresenceIndex.clear();
      this.invalidateSessionActiveScopeIndex();
      for (const item of serialized.objects) {
        this.objects.set(item.id, {
          id: item.id,
          name: item.name,
          parent: item.parent,
          owner: item.owner,
          location: item.location,
          anchor: item.anchor,
          flags: cloneImportedPlainData(item.flags ?? {}),
          created: item.created,
          modified: item.modified,
          propertyDefs: new Map(item.propertyDefs.map((def) => [def.name, { ...def, defaultValue: cloneImportedPlainData(def.defaultValue) }])),
          properties: new Map(item.properties.map(([name, value]) => [name, cloneImportedPlainData(value)])),
          propertyVersions: new Map(item.propertyVersions),
          verbs: importedVerbs(item.verbs),
          children: new Set(item.children),
          contents: new Set(item.contents),
          eventSchemas: new Map(item.eventSchemas.map(([type, schema]) => [type, cloneImportedPlainData(schema)]))
        });
      }
      for (const session of serialized.sessions) {
        this.sessions.set(session.id, this.hydrateSession(session, Date.now()));
      }
      for (const [space, entries] of serialized.logs) {
        const hydrated = cloneImportedPlainData(entries);
        this.logs.set(space, hydrated.map((entry) => ({ ...entry, observations: entry.observations ?? [] })));
      }
      this.snapshots = cloneImportedPlainData(serialized.snapshots ?? []);
      this.objectCounter = serialized.objectCounter ?? serialized.taskCounter ?? 1;
      this.sessionCounter = serialized.sessionCounter;
      this.rebuildGuestPoolPermitted();
    }));
  }

  /**
   * CA11.2 topology pre-seed merge. Insert lineage-only neighbor/class rows into
   * the live world ONLY for ids not already resident, returning the ids actually
   * added. This NEVER overwrites an existing row, so a genuinely-resident
   * authoritative row (an actor, a served scope fetched from its owner, a
   * support class) always wins; the seed only fills a gap so a one-hop neighbor
   * room's parent walk resolves locally. The caller stamps the added ids
   * owner-deferring at export (the world treats them as ordinary resident rows
   * for value-trace/parent-walk, which read world.objects only).
   *
   * Pre-seeded rows carry no live/dynamic cells (the caller passes lineage-only
   * SerializedObjects); they are quasi-static topology, validated at the owner on
   * the next move (CA11/CA6). Persistence stays paused: a gateway shard world is
   * not durable, and these rows must never be written back as authority.
   */
  mergeTopologySeedObjects(objects: readonly SerializedObject[]): Set<ObjRef> {
    this.assertOutsideBehaviorMutation("mergeTopologySeedObjects");
    return this.withBehaviorMutationPermit(() => this.mergeTopologySeedObjectsPermitted(objects));
  }

  private mergeTopologySeedObjectsPermitted(objects: readonly SerializedObject[]): Set<ObjRef> {
    const added = new Set<ObjRef>();
    if (objects.length === 0) return added;
    this.withPersistencePaused(() => {
      for (const item of objects) {
        if (this.objects.has(item.id)) continue;
        this.objects.set(item.id, {
          id: item.id,
          name: item.name,
          parent: item.parent,
          owner: item.owner,
          location: item.location,
          anchor: item.anchor,
          flags: cloneImportedPlainData(item.flags ?? {}),
          created: item.created,
          modified: item.modified,
          propertyDefs: new Map(item.propertyDefs.map((def) => [def.name, { ...def, defaultValue: cloneImportedPlainData(def.defaultValue) }])),
          properties: new Map(item.properties.map(([name, value]) => [name, cloneImportedPlainData(value)])),
          propertyVersions: new Map(item.propertyVersions),
          verbs: importedVerbs(item.verbs),
          children: new Set(item.children),
          contents: new Set(item.contents),
          eventSchemas: new Map(item.eventSchemas.map(([type, schema]) => [type, cloneImportedPlainData(schema)]))
        });
        added.add(item.id);
      }
    });
    if (added.size > 0) this.bumpMutationVersion();
    return added;
  }

  applyProjectionWrites(writes: readonly ProjectionWrite[], options: ProjectionApplyOptions = {}): ShadowHostApplyResult {
    this.assertOutsideBehaviorMutation("applyProjectionWrites");
    return this.withBehaviorMutationPermit(() => this.applyProjectionWritesPermitted(writes, options));
  }

  private applyProjectionWritesPermitted(writes: readonly ProjectionWrite[], options: ProjectionApplyOptions): ShadowHostApplyResult {
    const persist = options.persist !== false;
    const result: ShadowHostApplyResult = {
      ok: true,
      host: "projection",
      objects: 0,
      properties: 0,
      logs: 0,
      sessions: 0,
      creates: 0,
      writes: writes.length
    };
    for (const write of writes) {
      switch (write.table) {
        case "objects":
          if (write.op === "delete") {
            this.objects.delete(write.key);
            if (persist) this.deletePersistedObject(write.key);
            else this.invalidateProjectionObjectCache(write.key);
          } else {
            const existing = this.objects.get(write.key);
            const object = this.objectFromSerializedRow(write.row);
            if (existing && options.transcript) this.mergeScopedProjectionObject(object, existing, write.key, options.transcript);
            this.objects.set(write.key, object);
            if (persist || (existing === undefined && options.persistCreated === true)) this.persistProjectionObjectWrite(write.key, options.transcript, existing === undefined);
            else this.invalidateProjectionObjectCache(write.key);
            if (existing === undefined) result.creates += 1;
          }
          result.objects += 1;
          break;
        case "sessions":
          if (write.op === "delete") {
            const existing = this.sessions.get(write.key);
            this.noteSessionDeleted(existing);
            this.sessions.delete(write.key);
            if (persist) this.deletePersistedSession(write.key);
          } else {
            const existing = this.sessions.get(write.key);
            this.noteSessionDeleted(existing);
            const session = this.hydrateSession(write.row, Date.now());
            // Projection/persistence rows carry durable session fields only.
            // Socket attachments are process-local liveness; replacing a live
            // session wholesale would drop the WebSocket and freeze the client.
            if (existing && existing.attachedSockets.size > 0) {
              session.attachedSockets = new Set(existing.attachedSockets);
              session.lastDetachAt = existing.lastDetachAt;
              session.lastInputAt = existing.lastInputAt;
            }
            this.sessions.set(write.key, session);
            this.noteSessionInserted(session);
            if (persist) this.persistSession(session);
          }
          result.sessions += 1;
          break;
        case "logs":
          if (write.op === "delete") {
            const entries = this.logs.get(write.key.space) ?? [];
            this.logs.set(write.key.space, entries.filter((entry) => entry.seq !== write.key.seq));
          } else {
            const entries = this.logs.get(write.key.space) ?? [];
            const row = cloneValue(write.row as unknown as WooValue) as unknown as SpaceLogEntry;
            this.effects.mergeTranscriptLogEntry(entries, row);
            this.logs.set(write.key.space, entries);
            if (persist) this.activeObjectRepository()?.saveCommittedLogEntry(write.key.space, row);
          }
          result.logs += 1;
          break;
        case "snapshots":
          this.snapshots = write.op === "delete"
            ? this.snapshots.filter((row) => row.space_id !== write.key.space || row.seq !== write.key.seq)
            : upsertProjectionRow(this.snapshots, (row) => row.space_id === write.key.space && row.seq === write.key.seq, cloneValue(write.row as unknown as WooValue) as unknown as SpaceSnapshotRecord);
          if (persist && write.op === "upsert") this.activeObjectRepository()?.saveSpaceSnapshot(write.row);
          break;
        case "counters":
          if (write.key === "objectCounter") this.objectCounter = write.value;
          if (write.key === "sessionCounter") this.sessionCounter = write.value;
          if (persist) this.persistCounters();
          break;
        case "tombstones":
          if (write.op === "delete") {
            this.tombstones.delete(write.key);
          } else {
            this.tombstones.add(write.key);
            if (persist) this.persistTombstone(write.key);
          }
          break;
        case "tool_surfaces":
          break;
      }
    }
    // Durable contents projection for a CROSS-HOST move. The committing scope can
    // only mutate (and emit a full-row projection write for) a container it holds
    // locally; when a move's source/destination container is owned by a FOREIGN
    // host, no contents row is emitted, so that owner would otherwise never learn
    // of the incoming/departing member and its `contents` projection drifts
    // (CA3/CA4: location is authoritative, contents is the derived index). Apply
    // the authoritative move additively to any container THIS host owns that did
    // NOT receive a full-row write here — mirroring the transcript-apply path
    // (applyCommittedShadowTranscriptToHost, world.ts movement block). Containers
    // that DID get a full row are already correct (mergeScopedProjectionObject
    // applied the same deltas); the set ops are idempotent so skipping them avoids
    // double-touch. The write-through (writeThroughProjectionWritesToObjectHosts)
    // adds these container owners to the fanout so this runs on the right host.
    if (options.transcript) {
      const writtenObjectKeys = new Set(writes.filter((write) => write.table === "objects").map((write) => write.key));
      // Opt-in: only the durable object-host apply path passes `hostKey`, and the
      // repair only touches containers that host durably OWNS (per the route
      // table). Gateway/cache callers omit `hostKey` so this is a no-op for them —
      // they maintain contents through their own projection-cache path and must not
      // persist a container they merely cache (the repository rejects that as "not
      // hosted here").
      const ownsContainer = options.hostKey
        ? this.transcriptHostPredicates(options.hostKey, options.gatewayHost ?? false).belongsHere
        : (_id: ObjRef | null | undefined) => false;
      const touchedContainers = new Set<ObjRef>();
      for (const move of options.transcript.moves) {
        if (move.from && move.from !== move.to && !writtenObjectKeys.has(move.from) && ownsContainer(move.from)) {
          const from = this.objects.get(move.from);
          if (from && from.contents.delete(move.object)) touchedContainers.add(move.from);
        }
        if (!writtenObjectKeys.has(move.to) && ownsContainer(move.to)) {
          const to = this.objects.get(move.to);
          if (to && !to.contents.has(move.object)) {
            to.contents.add(move.object);
            touchedContainers.add(move.to);
          }
        }
      }
      for (const id of touchedContainers) {
        result.objects += 1;
        // The transcript dirties the moved object's location cell, not the
        // container's `contents` cell. Force a whole-row save for this repaired
        // projection or the owner host would update memory but reload stale.
        if (persist) this.persistProjectionObjectWrite(id, options.transcript, false, true);
        else this.invalidateProjectionObjectCache(id);
      }
    }
    return result;
  }

  private mergeScopedProjectionObject(target: WooObject, existing: WooObject, id: ObjRef, transcript: EffectTranscript): void {
    // Projection rows are complete for the scope that accepted the frame, not
    // necessarily complete for an object host's durable read model. Preserve
    // out-of-scope containment and apply the accepted transcript's exact
    // containment deltas onto the local full row.
    let contents = Array.from(existing.contents);
    let sawContentsWrite = false;
    for (const write of this.effects.finalWritesByCell(transcript)) {
      if (write.cell.kind !== "contents" || write.cell.object !== id) continue;
      sawContentsWrite = true;
      contents = this.effects.applyTranscriptContentsWriteRefs(contents, write, transcript, (event) => this.recordMetric(event));
    }
    if (!sawContentsWrite) {
      for (const move of transcript.moves) {
        if (move.from === id && move.from !== move.to) contents = contents.filter((member) => member !== move.object);
        if (move.to === id && !contents.includes(move.object)) contents = [...contents, move.object].sort();
      }
    }
    // A create located in this container is a containment delta too, but it is
    // neither a `contents` write nor a `move` — so the loops above miss it. Add
    // freshly-created members here, else an object minted directly into this
    // container (e.g. a note created in a room/board) is dropped from the
    // container's contents projection on any host that materializes through
    // projection rows (CF projection-mode), so `look`/`contents()`/roster reads
    // there never see it.
    for (const create of transcript.creates) {
      if (create.location === id && !contents.includes(create.object)) contents = [...contents, create.object].sort();
    }
    target.contents = new Set(contents);

    const children = new Set(existing.children);
    for (const create of transcript.creates) {
      if (create.parent === id) children.add(create.object);
    }
    target.children = children;
  }

  private persistProjectionObjectWrite(id: ObjRef, transcript: EffectTranscript | undefined, created: boolean, forceWholeObjectDirty = false): void {
    if (!transcript) {
      this.persistObject(id);
      return;
    }
    let wholeObjectDirty = created || forceWholeObjectDirty;
    const dirtyProps = new Set<string>();
    for (const create of transcript.creates) {
      if (create.object === id || create.parent === id || create.location === id) wholeObjectDirty = true;
    }
    for (const write of this.effects.finalWritesByCell(transcript)) {
      if (write.cell.object !== id) continue;
      if (write.cell.kind === "prop") {
        if (write.op === "remove") wholeObjectDirty = true;
        else dirtyProps.add(write.cell.name);
      } else {
        wholeObjectDirty = true;
      }
    }
    if (wholeObjectDirty) this.persistObject(id);
    for (const name of dirtyProps) this.persistProperty(id, name);
    if (!wholeObjectDirty && dirtyProps.size === 0) this.invalidateProjectionObjectCache(id);
  }

  private invalidateProjectionObjectCache(id: ObjRef): void {
    this.mutationCounter += 1;
    this.invalidateHostSeedsForObject(id);
  }

  applyCommittedShadowTranscript(transcript: EffectTranscript, options: ShadowGatewayApplyOptions = {}): void {
    this.assertOutsideBehaviorMutation("applyCommittedShadowTranscript");
    // CommitScopeDO is the authority for v2 shadow commits. The gateway keeps
    // this WooWorld as a routing/tool-list cache. Apply the same transcript
    // materialization semantics in-place so hot v2/MCP commits scale with the
    // accepted transcript instead of export/clone/import of the whole world.
    // This intentionally does not persist to the gateway DO.
    const totalStartedAt = Date.now();
    const stats = this.shadowGatewayLiveMetricStats();
    const profile = (phase: (MetricEvent & { kind: "shadow_gateway_apply_step" })["phase"], startedAt: number) => {
      this.recordMetric({
        kind: "shadow_gateway_apply_step",
        phase,
        scope: transcript.scope,
        route: transcript.route,
        ms: Date.now() - startedAt,
        ...stats,
        creates: transcript.creates.length,
        writes: transcript.writes.length
      });
    };
    this.withBehaviorMutationPermit(() => {
      this.applyCommittedShadowTranscriptInPlace(transcript, Date.now(), profile, options);
    });
    profile("total", totalStartedAt);
  }

  applyCommittedShadowTranscriptToHost(hostKey: string, transcript: EffectTranscript, options: { gatewayHost?: boolean } = {}): ShadowHostApplyResult {
    this.assertOutsideBehaviorMutation("applyCommittedShadowTranscriptToHost");
    return this.withBehaviorMutationPermit(() =>
      this.applyCommittedShadowTranscriptToHostPermitted(hostKey, transcript, options)
    );
  }

  private applyCommittedShadowTranscriptToHostPermitted(
    hostKey: string,
    transcript: EffectTranscript,
    options: { gatewayHost?: boolean }
  ): ShadowHostApplyResult {
    // CommitScopeDO accepts against its own authority snapshot; object-host DOs
    // are the durable read authority for public object routes. This materializes
    // only the slice owned by `hostKey`, preserving the accepted transcript
    // semantics while keeping host persistence O(touched rows), not O(world).
    const objectTimestamp = Date.now();
    const gatewayHost = options.gatewayHost === true;
    const { belongsHere, createBelongsHere } = this.transcriptHostPredicates(hostKey, gatewayHost);

    // Per-host invalidation: the apply scopes writes to hostKey via the
    // predicates above. Inner persistObject/persistProperty calls inside
    // the loop will invalidate hostKey's hostSeedCache as needed. Skip
    // the explicit clear-all that was here before — it was the dominant
    // cause of cache misses on WORLD when satellite write-throughs fanned
    // back to WORLD.
    this.mutationCounter += 1;
    this.invalidateHostSeed(hostKey);
    let objects = 0;
    let properties = 0;
    let logs = 0;
    let sessions = 0;
    let creates = 0;
    let writesApplied = 0;
    const dirtyObjects = new Set<ObjRef>();
    const dirtyProps = new Map<ObjRef, Set<string>>();
    const markObject = (id: ObjRef | null | undefined): void => {
      if (!id || !this.objects.has(id)) return;
      dirtyObjects.add(id);
      dirtyProps.delete(id);
    };
    const markProp = (id: ObjRef, name: string): void => {
      if (dirtyObjects.has(id)) return;
      let props = dirtyProps.get(id);
      if (!props) {
        props = new Set();
        dirtyProps.set(id, props);
      }
      props.add(name);
    };

    for (const create of transcript.creates) {
      if (!createBelongsHere(create)) continue;
      if (!this.objects.has(create.object)) {
        const serialized = this.effects.serializedObjectForTranscriptCreate(create, objectTimestamp);
        this.objects.set(create.object, this.objectFromSerializedCreate(serialized));
        if (serialized.parent) addSortedSetValue(this.objects.get(serialized.parent)?.children, serialized.id);
        if (serialized.location) addSortedSetValue(this.objects.get(serialized.location)?.contents, serialized.id);
      }
      markObject(create.object);
      if (belongsHere(create.parent)) markObject(create.parent);
      if (belongsHere(create.location)) markObject(create.location);
      creates += 1;
    }

    for (const write of this.effects.finalWritesByCell(transcript)) {
      if (!belongsHere(write.cell.object)) continue;
      const target = this.objects.get(write.cell.object);
      if (!target) continue;
      this.applyTranscriptWriteInPlace(write, objectTimestamp, transcript);
      writesApplied += 1;
      if (write.cell.kind === "prop") {
        if (write.op === "remove") markObject(write.cell.object);
        else markProp(write.cell.object, write.cell.name);
      } else if (write.cell.kind === "location" || write.cell.kind === "contents") {
        markObject(write.cell.object);
      }
    }

    // Movement writes make `location(object)` authoritative, but visibility
    // and containment checks read the derived `contents(container)` mirror.
    // Host-sliced localdev/Worker write-through must therefore repair any
    // source/dest container this host owns; otherwise a successful move can be
    // followed by stale container membership on the next turn.
    for (const move of transcript.moves) {
      if (move.from && move.from !== move.to && belongsHere(move.from)) {
        const from = this.objects.get(move.from);
        if (from) {
          from.contents.delete(move.object);
          markObject(move.from);
        }
      }
      if (belongsHere(move.to)) {
        const to = this.objects.get(move.to);
        if (to) {
          addSortedSetValue(to.contents, move.object);
          markObject(move.to);
        }
      }
    }
    const sessionTransition = transcript.sessionScopeTransition;
    if (sessionTransition?.to) {
      // Actor movement can record a physical move from a stale cached row
      // (for example `$nowhere -> deck`) while the session transition carries
      // the real room placement (`chatroom -> deck`). Use that CA8 placement to
      // keep room contents mirrors coherent for matching and roster reads.
      if (sessionTransition.from && sessionTransition.from !== sessionTransition.to && belongsHere(sessionTransition.from)) {
        const from = this.objects.get(sessionTransition.from);
        if (from) {
          from.contents.delete(sessionTransition.actor);
          markObject(sessionTransition.from);
        }
      }
      if (belongsHere(sessionTransition.to)) {
        const to = this.objects.get(sessionTransition.to);
        if (to) {
          addSortedSetValue(to.contents, sessionTransition.actor);
          markObject(sessionTransition.to);
        }
      }
    }

    // CA4/CA8 presence projection (per-host slice): an accepted session
    // active-scope transition repairs the source/destination rooms'
    // metadata-declared presence cells on whichever host owns each room, so this
    // host's live-delivery audience (presenceActorsIn) reflects the placement.
    // Location stays the only authoritative write (CA3); these rows are
    // recomputed projections, written via setPropLocal (no turn record;
    // invalidates the presence index).
    const presenceDeltas = this.effects.sessionScopePresenceDeltas(
      (room) => this.presenceProjectionPropsForObject(room),
      transcript
    );
    for (const delta of presenceDeltas) {
      if (!belongsHere(delta.room)) continue;
      if (!this.objects.has(delta.room)) continue;
      const before = this.propOrNullLive(delta.room, delta.property);
      const after = this.effects.applyPresenceProjectionRowDelta(before, delta);
      if (this.setPropLocal(delta.room, delta.property, after)) markObject(delta.room);
    }

    const sessionUpdate = this.effects.transcriptSessionActiveScope(transcript);
    if (gatewayHost && sessionUpdate) {
      const session = this.sessions.get(sessionUpdate.session);
      if (session?.actor === sessionUpdate.actor) {
        this.setSessionActiveScope(session, sessionUpdate.activeScope);
        this.persistSession(session);
        sessions += 1;
      }
    }

    const logEntry = this.effects.transcriptLogEntry(transcript);
    // Store under the entry's SEMANTIC space id (transcriptLogEntry resolves
    // it); host-slice routing still keys on the transcript's commit scope.
    if (logEntry && belongsHere(transcript.scope)) {
      const entries = this.logs.get(logEntry.space) ?? [];
      this.effects.mergeTranscriptLogEntry(entries, logEntry);
      this.logs.set(logEntry.space, entries);
      this.activeObjectRepository()?.saveCommittedLogEntry(logEntry.space, logEntry);
      logs += 1;
    }

    this.objectCounter = this.effects.nextObjectCounterForCreates(this.objectCounter, transcript.creates);
    if (gatewayHost && transcript.creates.length > 0) this.persistCounters();
    for (const id of dirtyObjects) {
      this.persistObject(id);
      objects += 1;
    }
    for (const [id, names] of dirtyProps) {
      for (const name of names) {
        this.persistProperty(id, name);
        properties += 1;
      }
    }

    return { ok: true, host: hostKey, objects, properties, logs, sessions, creates, writes: writesApplied };
  }

  private transcriptHostPredicates(hostKey: string, gatewayHost: boolean): {
    belongsHere: (id: ObjRef | null | undefined) => boolean;
    createBelongsHere: (create: EffectTranscript["creates"][number]) => boolean;
  } {
    // Keep host-slice materialization and gateway-cache skip filtering in
    // lockstep. If local object-host write-through has already applied a
    // transcript slice, the later gateway cache apply must not replay it.
    const routeHost = new Map(this.objectRoutes().map((route) => [route.id, route.host] as const));
    const belongsHere = (id: ObjRef | null | undefined): boolean => {
      if (!id) return false;
      const routed = routeHost.get(id);
      if (routed !== undefined) return routed === hostKey;
      const obj = this.objects.get(id);
      if (!obj) return false;
      if (obj.anchor && routeHost.get(obj.anchor) === hostKey) return true;
      return gatewayHost;
    };
    const createBelongsHere = (create: EffectTranscript["creates"][number]): boolean => {
      if (routeHost.get(create.object) === hostKey) return true;
      if (create.anchor && routeHost.get(create.anchor) === hostKey) return true;
      if (create.location && routeHost.get(create.location) === hostKey) return true;
      return gatewayHost && routeHost.get(create.object) === undefined;
    };
    return { belongsHere, createBelongsHere };
  }

  private shadowGatewayLiveMetricStats(): ShadowGatewayApplyStats {
    let properties = 0;
    for (const object of this.objects.values()) properties += object.properties.size;
    let logs = 0;
    for (const entries of this.logs.values()) logs += entries.length;
    return {
      objects: this.objects.size,
      properties,
      sessions: this.sessions.size,
      logs
    };
  }

  private applyCommittedShadowTranscriptInPlace(
    transcript: EffectTranscript,
    objectTimestamp: number,
    profile?: (phase: (MetricEvent & { kind: "shadow_gateway_apply_step" })["phase"], startedAt: number) => void,
    options: ShadowGatewayApplyOptions = {}
  ): void {
    const skipHost = options.skipObjectHost;
    const skippedHostPredicates = skipHost
      ? this.transcriptHostPredicates(skipHost.hostKey, skipHost.gatewayHost === true)
      : null;
    // Inner persistObject/persistProperty calls inside the apply loop
    // will invalidate the per-host caches as their writes are persisted.
    // The earlier full clear-all here was the cause of the cache-miss
    // problem on WORLD: a satellite's write-through commit fans back to
    // WORLD's acceptV2Commit → applyCommittedShadowTranscriptInPlace →
    // clear() → next satellite's host-seed request rebuilds from scratch.
    this.mutationCounter += 1;
    // Collect every object id touched by this transcript so we can persist
    // the changes at the end. Without this, MCP gateway shards updated
    // session.activeScope and actor.location only in-memory; when the DO
    // hibernated between calls and rehydrated, it loaded the pre-update
    // values from durable storage and the gateway's view diverged from
    // both the WORLD DO (authoritative) and the actor's owning host —
    // producing the "actor at $nowhere / session.activeScope null"
    // mid-test blank that broke cross-actor MCP smoke. See
    // memory/divergent_session_state_race.md.
    const touchedObjects = new Set<ObjRef>();
    let stepStartedAt = Date.now();
    for (const create of transcript.creates) {
      if (skippedHostPredicates?.createBelongsHere(create)) continue;
      const serialized = this.effects.serializedObjectForTranscriptCreate(create, objectTimestamp);
      this.objects.set(create.object, this.objectFromSerializedCreate(serialized));
      if (serialized.parent) addSortedSetValue(this.objects.get(serialized.parent)?.children, serialized.id);
      if (serialized.location) addSortedSetValue(this.objects.get(serialized.location)?.contents, serialized.id);
      touchedObjects.add(create.object);
      if (serialized.parent) touchedObjects.add(serialized.parent);
      if (serialized.location) touchedObjects.add(serialized.location);
    }
    profile?.("apply_creates", stepStartedAt);

    stepStartedAt = Date.now();
    const writes = this.effects.finalWritesByCell(transcript);
    profile?.("collect_writes", stepStartedAt);

    stepStartedAt = Date.now();
    for (const write of writes) {
      if (skippedHostPredicates?.belongsHere(write.cell.object)) continue;
      this.applyTranscriptWriteInPlace(write, objectTimestamp, transcript);
      touchedObjects.add(write.cell.object);
    }
    for (const move of transcript.moves) {
      if (move.from && move.from !== move.to && !skippedHostPredicates?.belongsHere(move.from)) {
        this.objects.get(move.from)?.contents.delete(move.object);
        touchedObjects.add(move.from);
      }
      if (!skippedHostPredicates?.belongsHere(move.to)) {
        this.objects.get(move.to)?.contents.add(move.object);
        touchedObjects.add(move.to);
      }
    }
    const sessionTransition = transcript.sessionScopeTransition;
    if (sessionTransition?.to) {
      // Full/gateway materialization has the same stale-physical-source risk as
      // host-sliced write-through. The session transition is the authoritative
      // placement edge for actors, so use it to remove the actor from the old
      // room even when the physical move effect could only say `$nowhere`.
      if (sessionTransition.from && sessionTransition.from !== sessionTransition.to && !skippedHostPredicates?.belongsHere(sessionTransition.from)) {
        this.objects.get(sessionTransition.from)?.contents.delete(sessionTransition.actor);
        touchedObjects.add(sessionTransition.from);
      }
      if (!skippedHostPredicates?.belongsHere(sessionTransition.to)) {
        this.objects.get(sessionTransition.to)?.contents.add(sessionTransition.actor);
        touchedObjects.add(sessionTransition.to);
      }
    }
    // CA4/CA8 presence projection: a session active-scope transition also
    // repairs the source/destination rooms' metadata-declared presence cells
    // (session_subscribers/subscribers) so this host's live-delivery audience
    // (presenceActorsIn) reflects the placement. Location remains the sole
    // authoritative write (CA3); these rows are local projections recomputed
    // from the accepted transcript, written via setPropLocal (which skips turn
    // recording and invalidates the presence index for presence cells).
    const presenceDeltas = this.effects.sessionScopePresenceDeltas(
      (room) => this.presenceProjectionPropsForObject(room),
      transcript
    );
    for (const delta of presenceDeltas) {
      if (skippedHostPredicates?.belongsHere(delta.room)) continue;
      if (!this.objects.has(delta.room)) continue;
      const before = this.propOrNullLive(delta.room, delta.property);
      const after = this.effects.applyPresenceProjectionRowDelta(before, delta);
      if (this.setPropLocal(delta.room, delta.property, after)) touchedObjects.add(delta.room);
    }
    profile?.("apply_writes", stepStartedAt);

    // Export paths sort object/log rows for deterministic snapshots. Keep the
    // hot gateway cache in mutation order so accepted transcripts stay O(delta).
    stepStartedAt = Date.now();
    profile?.("sort_objects", stepStartedAt);

    stepStartedAt = Date.now();
    const sessionUpdate = this.effects.transcriptSessionActiveScope(transcript);
    let touchedSession: Session | null = null;
    if (sessionUpdate) {
      const session = this.sessions.get(sessionUpdate.session);
      if (session?.actor === sessionUpdate.actor) {
        this.setSessionActiveScope(session, sessionUpdate.activeScope);
        touchedSession = session;
      }
    }
    profile?.("apply_session", stepStartedAt);

    // Persist the in-memory changes through the active repository so the next
    // cold-load (DO hibernate/rehydrate, worker restart) sees the updated
    // session.activeScope and object cells. persistObject/persistSession
    // no-op when there is no repository (in-memory tests) so this stays
    // safe across runtime modes.
    for (const id of touchedObjects) {
      if (this.objects.has(id)) this.persistObject(id);
    }
    if (touchedSession) this.persistSession(touchedSession);

    stepStartedAt = Date.now();
    const logEntry = this.effects.transcriptLogEntry(transcript);
    if (logEntry) {
      // Semantic-space keying (see the host-slice twin above).
      const entries = this.logs.get(logEntry.space) ?? [];
      this.effects.mergeTranscriptLogEntry(entries, logEntry);
      this.logs.set(logEntry.space, entries);
    }
    profile?.("apply_log", stepStartedAt);

    stepStartedAt = Date.now();
    this.objectCounter = this.effects.nextObjectCounterForCreates(this.objectCounter, transcript.creates);
    profile?.("counters", stepStartedAt);
  }

  private objectFromSerializedCreate(item: SerializedObject): WooObject {
    return {
      id: item.id,
      name: item.name,
      parent: item.parent,
      owner: item.owner,
      location: item.location,
      anchor: item.anchor,
      flags: cloneImportedPlainData(item.flags ?? {}),
      created: item.created,
      modified: item.modified,
      propertyDefs: new Map(),
      properties: new Map(),
      propertyVersions: new Map(),
      verbs: [],
      children: new Set(),
      contents: new Set(),
      eventSchemas: new Map()
    };
  }

  private objectFromSerializedRow(item: SerializedObject): WooObject {
    return {
      id: item.id,
      name: item.name,
      parent: item.parent,
      owner: item.owner,
      location: item.location,
      anchor: item.anchor,
      flags: cloneImportedPlainData(item.flags ?? {}),
      created: item.created,
      modified: item.modified,
      propertyDefs: new Map(item.propertyDefs.map((def) => [def.name, { ...def, defaultValue: cloneImportedPlainData(def.defaultValue) }])),
      properties: new Map(item.properties.map(([name, value]) => [name, cloneImportedPlainData(value)])),
      propertyVersions: new Map(item.propertyVersions),
      verbs: importedVerbs(item.verbs),
      children: new Set(item.children),
      contents: new Set(item.contents),
      eventSchemas: new Map(item.eventSchemas.map(([type, schema]) => [type, cloneImportedPlainData(schema)]))
    };
  }

  private applyTranscriptWriteInPlace(write: TranscriptWrite, objectTimestamp: number, transcript: EffectTranscript): void {
    const target = this.objects.get(write.cell.object);
    if (!target) return;
    // A2: the `prop` arm now delegates to the single shared applier
    // (applyTranscriptPropWrite). The remaining `location`/`contents` arms still
    // mirror applyTranscriptWriteToSerializedObject by storage shape; the
    // `contents` arm collapses at A4 (contents leaves the validation/applier path
    // entirely), after which this whole switch and its serialized twin reduce to
    // the shared prop/location core.
    switch (write.cell.kind) {
      case "prop":
        this.applyTranscriptPropWriteInPlace(target, write, objectTimestamp);
        return;
      case "location":
        if (typeof write.value === "string" || write.value === null) {
          target.location = write.value;
          target.modified = objectTimestamp;
        }
        return;
      case "contents":
        if (Array.isArray(write.value)) {
          target.contents = new Set(this.effects.applyTranscriptContentsWriteRefs(
            Array.from(target.contents),
            write,
            transcript,
            (event) => this.recordMetric(event)
          ));
          target.modified = objectTimestamp;
        }
        return;
      case "lifecycle":
      case "verb":
        return;
    }
  }

  private applyTranscriptPropWriteInPlace(target: WooObject, write: TranscriptWrite, objectTimestamp: number): void {
    // A2: delegate the accepted-transcript prop-write semantics to the single
    // shared applier in shadow-commit-scope.ts via a WooObject-shaped target.
    // The live graph keeps two live-only side effects the serialized authority
    // row does not have — the `modified` timestamp and presence-index
    // invalidation — applied here around the shared write.
    if (write.cell.kind !== "prop") return;
    const propName = write.cell.name;
    const presenceProjection = this.presenceProjectionForObjectRecord(target, propName);
    this.effects.applyTranscriptPropWrite(this.wooObjectPropTarget(target), write);
    target.modified = objectTimestamp;
    if (presenceProjection) this.invalidatePresenceIndex();
  }

  // Adapter: the live executable WooObject graph (Map/Set storage). Pairs with
  // serializedObjectPropTarget in shadow-commit-scope.ts so both materializations
  // are the same function of the transcript (VTN0 coherence invariant).
  private wooObjectPropTarget(target: WooObject): TranscriptPropTarget {
    return {
      propertyVersion: (name) => target.propertyVersions.get(name),
      setProperty: (name, value) => {
        target.properties.set(name, cloneValue(value));
        target.properties = sortedMap(target.properties);
      },
      removeProperty: (name) => {
        target.properties.delete(name);
        target.propertyVersions.delete(name);
      },
      setPropertyVersion: (name, version) => {
        target.propertyVersions.set(name, version);
        target.propertyVersions = sortedMap(target.propertyVersions);
      },
      setObjectName: (name) => { target.name = name; }
    };
  }

  // Clone a verb's mutable wrapper fields (aliases, arg_spec, source, line_map,
  // calls, …) while sharing its bytecode by reference. Bytecode is immutable
  // after compilation, so deep-cloning ops+literals on every serialize/snapshot
  // is pure waste — it was the single largest chunk of cold-boot clone cost.
  // freeze-once + share is the dual of importBytecode: export, the boot-snapshot
  // cache, and import all reuse one frozen bytecode object per verb. Native verbs
  // carry no bytecode and clone normally.
  private cloneVerbSharingBytecode(verb: VerbDef): VerbDef {
    if (verb.kind !== "bytecode") return cloneValue(verb as unknown as WooValue) as unknown as VerbDef;
    const { bytecode, ...rest } = verb;
    return {
      ...(cloneValue(rest as unknown as WooValue) as unknown as Record<string, unknown>),
      bytecode: freezeTinyBytecode(bytecode)
    } as unknown as VerbDef;
  }

  private cloneObjectView(obj: WooObject): WooObject {
    return {
      id: obj.id,
      name: obj.name,
      parent: obj.parent,
      owner: obj.owner,
      location: obj.location,
      anchor: obj.anchor,
      flags: { ...obj.flags },
      created: obj.created,
      modified: obj.modified,
      propertyDefs: new Map(Array.from(obj.propertyDefs, ([name, def]) => [
        name,
        cloneValue(def as unknown as WooValue) as unknown as PropertyDef
      ])),
      properties: new Map(Array.from(obj.properties, ([name, value]) => [name, cloneValue(value)])),
      propertyVersions: new Map(obj.propertyVersions),
      verbs: obj.verbs.map((verb) => this.cloneVerbSharingBytecode(verb)),
      children: new Set(obj.children),
      contents: new Set(obj.contents),
      eventSchemas: new Map(Array.from(obj.eventSchemas, ([type, shape]) => [
        type,
        cloneValue(shape as WooValue) as Record<string, WooValue>
      ]))
    };
  }

  private cloneSessionView(session: Session): Session {
    return {
      ...session,
      attachedSockets: new Set(session.attachedSockets)
    };
  }

  /** Frames cross a public boundary and may be retained or replayed. Never
   * expose the cache's immutable value or a behavior-owned result graph:
   * callers receive a fresh plain-data copy on every delivery. */
  private cloneFrame<T extends AppliedFrame | DirectResultFrame | ErrorFrame>(frame: T): T {
    return cloneValue(frame as unknown as WooValue) as unknown as T;
  }

  private serializeObject(obj: WooObject): SerializedObject {
    return {
      id: obj.id,
      name: obj.name,
      parent: obj.parent,
      owner: obj.owner,
      location: obj.location,
      anchor: obj.anchor,
      flags: { ...obj.flags },
      created: obj.created,
      modified: obj.modified,
      propertyDefs: Array.from(obj.propertyDefs.values()).map(
        (def) => cloneValue(def as unknown as WooValue) as unknown as PropertyDef
      ),
      properties: Array.from(obj.properties.entries()).map(([name, value]) => [name, cloneValue(value)]),
      propertyVersions: Array.from(obj.propertyVersions.entries()),
      verbs: obj.verbs.map((verb) => this.cloneVerbSharingBytecode(verb)),
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

  private hostScope(host: ObjRef): { objects: Set<ObjRef>; hostedObjects: Set<ObjRef>; hostedSpaces: Set<ObjRef>; hostByObject: Map<ObjRef, string> } {
    const allRoutes = this.objectRoutes();
    const routeByObject = new Map(allRoutes.map((route) => [route.id, route] as const));
    const hostByObject = new Map<ObjRef, string>(allRoutes.map((route) => [route.id, route.host] as const));
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
      const obj = this.objectLive(id);
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

    return { objects, hostedObjects: hosted, hostedSpaces, hostByObject };
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
    const raw = this.propOrNullLive("$catalog_registry", "installed_catalogs");
    if (!Array.isArray(raw)) return [];
    return raw.filter(isPlainValueMap);
  }

  private serializeSession(session: Session): SerializedSession {
    return {
      id: session.id,
      actor: session.actor,
        started: session.started,
        expiresAt: session.expiresAt,
        lastDetachAt: session.lastDetachAt,
        tokenClass: session.tokenClass,
        activeScope: session.activeScope,
        ...(session.apikeyId !== undefined ? { apikeyId: session.apikeyId } : {}),
        ...(session.rosterVisible === false ? { rosterVisible: false } : {})
      };
    }

  saveSnapshot(space: ObjRef): SpaceSnapshotRecord {
    return this.withBehaviorMutationPermit(() => this.saveSnapshotPermitted(space));
  }

  private saveSnapshotPermitted(space: ObjRef): SpaceSnapshotRecord {
    const seq = Number(this.getPropLive(space, "next_seq")) - 1;
    const state = this.materializedSpaceState(space);
    const snapshot: SpaceSnapshotRecord = {
      space_id: space,
      seq,
      ts: Date.now(),
      state,
      hash: hashCanonical(state)
    };
    const existingIndex = this.snapshots.findIndex((item) => item.space_id === space && item.seq === seq);
    if (existingIndex >= 0) this.snapshots.splice(existingIndex, 1);
    this.snapshots.push(snapshot);
    const stored = this.snapshots[this.snapshots.length - 1]!;
    this.recordSnapshotProjectionUpsert(stored);
    this.setProp(space, "last_snapshot_seq", seq);
    const repo = this.activeObjectRepository();
    if (repo) {
      const durableSnapshot = cloneValue(stored as unknown as WooValue) as unknown as SpaceSnapshotRecord;
      if (this.persistencePaused > 0 || this.persistenceDeferred > 0) {
        this.dirtySnapshots.set(`${stored.space_id}:${stored.seq}`, durableSnapshot);
        this.persistenceDirty = true;
      } else {
        repo.saveSpaceSnapshot(durableSnapshot);
      }
    }
    this.persist();
    return cloneValue(stored as unknown as WooValue) as unknown as SpaceSnapshotRecord;
  }

  latestSnapshot(space: ObjRef): SpaceSnapshotRecord | null {
    const found = this.repository?.latestSpaceSnapshot?.(space) ??
      this.snapshots.filter((snapshot) => snapshot.space_id === space).sort((a, b) => b.seq - a.seq)[0] ??
      null;
    return found
      ? cloneValue(found as unknown as WooValue) as unknown as SpaceSnapshotRecord
      : null;
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
    // Public persistence is never an escape hatch from a live behavior
    // transaction, even with force=true. The outermost behavior acceptance
    // path performs the one transactional flush while rollback is still
    // available.
    if (this.behaviorSavepointDepth > 0 || this.persistencePaused > 0) {
      this.persistenceDirty = true;
      return;
    }
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
    this.assertOutsideBehaviorMutation("persistFullSnapshot");
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
      dirtyTombstones: new Set(this.dirtyTombstones),
      dirtySnapshots: new Map(Array.from(this.dirtySnapshots.entries()).map(([key, snapshot]) => [
        key,
        cloneValue(snapshot as unknown as WooValue) as unknown as SpaceSnapshotRecord
      ])),
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
    this.dirtyTombstones = new Set(state.dirtyTombstones);
    this.dirtySnapshots = new Map(Array.from(state.dirtySnapshots.entries()).map(([key, snapshot]) => [
      key,
      cloneValue(snapshot as unknown as WooValue) as unknown as SpaceSnapshotRecord
    ]));
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
      this.dirtyTombstones.size > 0 ||
      this.dirtySnapshots.size > 0 ||
      this.dirtyCounters
    );
  }

  private persistObject(objRef: ObjRef): void {
    this.mutationCounter += 1;
    // Per-host cache invalidation: only the host whose slice contains
    // objRef needs its cached host-seed dropped unless the object is a
    // shared default-hosted support row. hostKeyForObject walks the anchor
    // chain to find which host owns ordinary instance data; support rows
    // clear the whole host-seed cache via invalidateHostSeedsForObject().
    this.invalidateHostSeedsForObject(objRef);
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
    this.mutationCounter += 1;
    this.invalidateHostSeedsForObject(objRef);
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
    this.mutationCounter += 1;
    // Tombstones are in every host's seed (exportHostScopedWorld returns
    // `tombstones: Array.from(this.tombstones).sort()`), so a tombstone
    // write must invalidate every host's cached seed.
    this.hostSeedCache.clear();
    const repo = this.activeObjectRepository();
    if (!repo) return;
    if (this.persistencePaused > 0 || this.persistenceDeferred > 0) {
      this.dirtyTombstones.add(objRef);
      return;
    }
    repo.saveTombstone(objRef, Date.now(), null);
  }

  private persistProperty(objRef: ObjRef, name: string): void {
    this.mutationCounter += 1;
    // Properties travel with their owning object's slice. Invalidate
    // only that host's cache, except shared support rows that can appear
    // in every host seed.
    this.invalidateHostSeedsForObject(objRef);
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
    this.mutationCounter += 1;
    this.invalidateHostSeedsForObject(objRef);
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
    const obj = this.objectLive(objRef);
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
    // Do NOT bump mutationCounter: sessions are explicitly excluded from
    // host-seed deliveries (exportHostScopedWorld returns `sessions: []`),
    // so persisting a session can never change any host's seed. Bumping
    // here was the dominant cause of the 94% host_seed_cache miss rate
    // measured before this change — every MCP request bumps lastInputAt
    // and persists, invalidating every host's cache.
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
    // Same rationale as persistSession: sessions are not in host seeds.
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
    repo.saveMeta("sessionCounter", String(this.sessionCounter));
    this.recordMetric({ kind: "storage_direct_write", what: "counters", ms: Date.now() - startedAt, rows: 2 });
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
    const dirtyTombstones = Array.from(this.dirtyTombstones);
    const dirtySnapshots = Array.from(this.dirtySnapshots.entries());
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
        repo.saveMeta("sessionCounter", String(this.sessionCounter));
        rows += 3;
      }
      const now = Date.now();
      for (const id of dirtyTombstones) {
        repo.saveTombstone(id, now, null);
        rows += 1;
      }
      for (const [, snapshot] of dirtySnapshots) {
        repo.saveSpaceSnapshot(snapshot);
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
    for (const id of dirtyTombstones) this.dirtyTombstones.delete(id);
    for (const [key] of dirtySnapshots) this.dirtySnapshots.delete(key);
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
      counters: dirtyCounters,
      ms: Date.now() - startedAt,
      rows,
      top_properties: topByName(persistedProps.map(({ name }) => name), STORAGE_FLUSH_TOP_N),
      top_objects: topByName(persistedProps.map(({ objRef }) => objRef), STORAGE_FLUSH_TOP_N)
    });
  }

  rebuildGuestPool(): void {
    this.assertOutsideBehaviorMutation("rebuildGuestPool");
    this.withBehaviorMutationPermit(() => this.rebuildGuestPoolPermitted());
  }

  private rebuildGuestPoolPermitted(): void {
    this.guestFreePool.clear();
    const sessions = Array.from(this.sessions.values());
    for (const obj of this.objects.values()) {
      if (obj.id.startsWith("guest_") && obj.parent === "$player" && this.objects.has("$guest")) {
        this.objectLive("$player").children.delete(obj.id);
        obj.parent = "$guest";
        this.objectLive("$guest").children.add(obj.id);
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
    const startedAt = Date.now();
    const reaped: string[] = [];
    let inspected = 0;
    let guestReaped = 0;
    let credentialReaped = 0;
    const noteReaped = (session: Session): void => {
      inspected += 1;
      if (!this.sessionExpired(session, now)) return;
      if (session.tokenClass === "guest") guestReaped += 1;
      else credentialReaped += 1;
      this.reapSession(session.id);
      reaped.push(session.id);
    };
    if (this.activeObjectRepository()) {
      for (const session of Array.from(this.sessions.values())) {
        noteReaped(session);
      }
      if (reaped.length > 0) this.recordMetric({ kind: "session_reap", inspected, reaped: reaped.length, guest_reaped: guestReaped, credential_reaped: credentialReaped, ms: Date.now() - startedAt });
      return reaped;
    }
    this.withPersistencePaused(() => {
      for (const session of Array.from(this.sessions.values())) {
        noteReaped(session);
      }
    });
    if (reaped.length > 0) this.persist(true);
    if (reaped.length > 0) this.recordMetric({ kind: "session_reap", inspected, reaped: reaped.length, guest_reaped: guestReaped, credential_reaped: credentialReaped, ms: Date.now() - startedAt });
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
    session: { id: string; actor: ObjRef; started: number; expiresAt?: number; lastDetachAt?: number | null; tokenClass?: Session["tokenClass"]; activeScope?: ObjRef | null; active_scope?: ObjRef | null; currentLocation?: ObjRef | null; apikeyId?: string; rosterVisible?: false },
    now: number
  ): Session {
    const tokenClass = session.tokenClass ?? (this.inheritsFrom(session.actor, "$guest") ? "guest" : "bearer");
    const lastDetachAt = session.lastDetachAt === undefined ? now : session.lastDetachAt;
    // `null` is the live-session sentinel. Import/export is used by shadow
    // execution as well as cold persistence; converting null to "now" makes an
    // attached session look detached and lets it expire while the gateway socket
    // is still alive.
    const expiresAt = Math.max(
      session.expiresAt ?? session.started + this.sessionTtl(tokenClass),
      lastDetachAt === null ? 0 : lastDetachAt + this.sessionGrace(tokenClass)
    );
    const activeScope = session.activeScope ?? session.active_scope ?? session.currentLocation ?? null;
    return {
      id: session.id,
      actor: session.actor,
      started: session.started,
      expiresAt,
      lastDetachAt,
      tokenClass,
      activeScope: activeScope && this.objects.has(activeScope) ? activeScope : this.initialSessionLocation(session.actor),
      attachedSockets: new Set(),
      // lastInputAt isn't persisted; on cold rehydrate, treat as just-active
      // rather than restoring some old timestamp from `started`. Otherwise
      // every freshly-rehydrated DO would show huge idle for everyone.
      lastInputAt: now,
      ...(session.apikeyId !== undefined ? { apikeyId: session.apikeyId } : {}),
      ...(session.rosterVisible === false ? { rosterVisible: false } : {})
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
    if (session.closedAt !== undefined) return true;
    if (session.attachedSockets.size > 0) return false;
    if (now >= session.expiresAt) return true;
    if (session.lastDetachAt === null) return false;
    // HTTP/MCP sessions never socket-attach, so `lastDetachAt` is the
    // protocol's idea of "not currently connected" from the moment the DO
    // rehydrates (persistedSessionFromRow stamps lastDetachAt = load time
    // when the persisted value was null). Without a socket-attach signal to
    // keep them alive, the grace clock advances across hibernation cycles
    // and the session can be reaped while the client is still actively
    // making requests — that produces the divergent state hit by
    // cross-actor smoke (memory/divergent_session_state_race.md).
    //
    // Treat `lastInputAt` (bumped by touchSessionInput at the protocol
    // edge) as an equivalent activity signal. `lastInputAt` is in-memory
    // only, so after a DO rehydrate it's 0 and the lastDetachAt clock
    // resumes — but the next request bumps lastInputAt and brings the
    // session firmly back into the alive window for `grace` ms.
    const lastActiveAt = Math.max(session.lastDetachAt, session.lastInputAt ?? 0);
    return now >= lastActiveAt + this.sessionGrace(session.tokenClass);
  }

  private reapSession(sessionId: string): void {
    this.withBehaviorMutationPermit(() => this.reapSessionPermitted(sessionId));
  }

  private reapSessionPermitted(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const isGuest = this.inheritsFrom(session.actor, "$guest");
    const wasPrimary = this.primarySessionForActorIncludingExpired(session.actor)?.id === sessionId;
    // Stamp before cleanup so any caller holding this session object sees it as
    // non-live even before the map deletion and persistence work complete.
    session.closedAt = Date.now();
    session.attachedSockets.clear();
    this.removeSessionPresence(sessionId, session.actor);
    // session_id mirror is no longer written (see createSessionForActor /
    // ensureSessionForActor); the matching reset on reap would just rewrite
    // the inherited default.
    this.noteSessionDeleted(session);
    this.sessions.delete(sessionId);
    this.deletePersistedSession(sessionId);
    if (wasPrimary && !isGuest) this.promoteActorPrimaryLocation(session.actor);
    if (isGuest) this.resetGuestOnDisconnect(session.actor);
  }

  /** Mark a session closed in-place for sparse shards/gateways that learn about
   * the close before the owning world host reaps it durably. This is not a
   * replacement for `endSession`; it makes local liveness and presence queries
   * stop seeing the session immediately. */
  markSessionClosed(sessionId: string): void {
    this.withBehaviorMutationPermit(() => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      this.removeSessionPresence(sessionId, session.actor);
      session.closedAt = Date.now();
      session.attachedSockets.clear();
      this.noteSessionDeleted(session);
      this.sessions.delete(sessionId);
    });
  }

  private promoteActorPrimaryLocation(actor: ObjRef): void {
    const primary = this.primarySessionForActor(actor);
    if (!primary) return;
    if (this.objects.has(actor) && this.objects.get(actor)!.location !== primary.activeScope) {
      this.moveObject(actor, primary.activeScope);
    }
  }

  private resetGuestOnDisconnect(actor: ObjRef): void {
    const homeValue = this.propOrNullLive(actor, "home");
    const home = typeof homeValue === "string" && this.objects.has(homeValue) ? homeValue : "$nowhere";
    const fallback = this.guestInventoryFallback(actor, home);
    const contents = this.objectLive(actor).contents;
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
    this.setProp(actor, "features_version", Number(this.propOrNullLive(actor, "features_version") ?? 0) + 1);
    this.returnGuest(actor);
  }

  private guestInventoryFallback(actor: ObjRef, home: ObjRef): ObjRef {
    const location = this.objects.get(actor)?.location;
    return location && location !== "$nowhere" && this.objects.has(location) ? location : home;
  }

  private focusListOf(actor: ObjRef): ObjRef[] {
    if (!this.objects.has(actor)) return [];
    const raw = this.propOrNullLive(actor, "focus_list");
    return Array.isArray(raw) ? raw.filter((item): item is ObjRef => typeof item === "string") : [];
  }

  private inventoryEjectTarget(item: ObjRef, fallback: ObjRef): ObjRef {
    const homeValue = this.propOrNullLive(item, "home");
    return typeof homeValue === "string" && this.objects.has(homeValue) ? homeValue : fallback;
  }

    // Session-close cleanup may only durably mutate objects whose durable
    // home is THIS host. A multi-host world (CF DO shard, world host) caches
    // rows it does not own — e.g. an MCP gateway shard holds the_pinboard's
    // `session_subscribers` after a tool-scope connect — and a setProp there
    // write-throughs to the repository, which rejects it with E_OBJNF
    // "object not hosted here". An exception on the close path aborts
    // closeMcpWooSession BEFORE the end-session forward and the Directory
    // unregister, which leaves the closed session resumable (the A1
    // DELETE-resume regression, tests/worker/cf-local-walkthrough.test.ts).
    // Skipping cached copies is correct, not just safe: the owning host runs
    // this same cleanup authoritatively in its own reap, dead sessions are
    // filtered from audiences by session liveness regardless of stale cached
    // subscriber rows, and the cached row converges on the owner's next
    // fanout/projection update. Single-host worlds (in-memory, SQLite tests)
    // have no executorContext and own everything. This mirrors the
    // projection-apply `hostKey` guard (see ProjectionApplyOptions.hostKey).
    private sessionCleanupOwned(id: ObjRef): boolean {
      const local = this.executorContext?.localHost;
      if (!local) return true;
      return this.hostKeyForObject(id) === local;
    }

    private removeSessionPresence(sessionId: string, actor: ObjRef): void {
      for (const obj of this.objects.values()) {
        const raw = obj.properties.get("session_subscribers");
        if (!Array.isArray(raw)) continue;
        if (!raw.some((item) => !!item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, WooValue>).session === sessionId)) continue;
        if (!this.sessionCleanupOwned(obj.id)) continue;
        this.updateSpaceSubscriberLocal(obj.id, actor, false, sessionId);
      }
      this.removeActorActiveLists(actor);
    }

  private removeActorActiveLists(actor: ObjRef): void {
    if (!this.objects.has(actor)) return;
    if (!this.sessionCleanupOwned(actor)) return;
    const focusList = this.propOrNullLive(actor, "focus_list");
    if (Array.isArray(focusList) && focusList.length > 0) this.setProp(actor, "focus_list", []);
  }

  /** Raw placement primitive (no hook chain — movetoChecked is the
   * receiver-driven move). Public for exactly one out-of-band consumer:
   * the identity import's §8 rehoming of an ADOPTED stock actor
   * (src/net/identity.ts), which runs on a pre-export in-process world
   * where the catalog hook chain has nothing to veto. In-world movement
   * must keep going through the checked verbs. */
  moveObject(objRef: ObjRef, targetRef: ObjRef): void {
    this.withBehaviorMutationPermit(() => this.moveObjectPermitted(objRef, targetRef));
  }

  private moveObjectPermitted(objRef: ObjRef, targetRef: ObjRef): void {
    const obj = this.objectLive(objRef);
    this.objectLive(targetRef);
    const oldLocation = obj.location;
    const locationPrior = this.structuralVersionForRecording("location", objRef);
    if (oldLocation && this.objects.has(oldLocation)) {
      const oldContainer = this.objectLive(oldLocation);
      oldContainer.contents.delete(objRef);
      oldContainer.modified = Date.now();
    }
    obj.location = targetRef;
    const target = this.objectLive(targetRef);
    target.contents.add(objRef);
    target.modified = Date.now();
    obj.modified = Date.now();
    this.persistObject(objRef);
    if (oldLocation) this.persistObject(oldLocation);
    this.persistObject(targetRef);
    this.recordTurnEvent({ kind: "object_move", object: objRef, from: oldLocation, to: targetRef });
    this.recordTurnEvent({
      kind: "cell_write",
      cell: { kind: "location", object: objRef },
      value: targetRef,
      op: "move",
      prior: locationPrior
    });
  }

  private async moveObjectOwned(objRef: ObjRef, targetRef: ObjRef, options: { suppressMirrorHost?: string | null } = {}): Promise<MoveObjectResult> {
    const obj = this.objectLive(objRef);
    const targetRemote = await this.remoteHostForObject(targetRef);
    if (!targetRemote) this.objectLive(targetRef);
    const oldLocation = obj.location;
    const locationPrior = this.structuralVersionForRecording("location", objRef);
    this.withBehaviorMutationPermit(() => {
      obj.location = targetRef;
      obj.modified = Date.now();
    });
    this.persistObject(objRef);
    if (oldLocation && oldLocation !== targetRef) await this.mirrorContainerContents(oldLocation, objRef, false, options);
    await this.mirrorContainerContents(targetRef, objRef, true, options);
    this.recordTurnEvent({ kind: "object_move", object: objRef, from: oldLocation, to: targetRef });
    this.recordTurnEvent({
      kind: "cell_write",
      cell: { kind: "location", object: objRef },
      value: targetRef,
      op: "move",
      prior: locationPrior
    });
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
      if (!this.executorContext) throw wooError("E_INTERNAL", "remote host bridge unavailable");
      const effect = this.effects.remoteBridgeUntrackedEffect("mirror_contents", { container: containerRef, object: objRef, present });
      this.recordUntrackedEffect(effect.name, effect.detail);
      await this.executorContext.mirrorContents(containerRef, objRef, present);
      return;
    }
    if (this.objects.has(containerRef)) this.mirrorContents(containerRef, objRef, present);
  }

  private returnGuest(actor: ObjRef): void {
    if (!this.inheritsFrom(actor, "$guest")) return;
    if (Array.from(this.sessions.values()).some((session) => session.actor === actor)) return;
    this.withBehaviorMutationPermit(() => this.guestFreePool.add(actor));
  }

  private collectVerbNames(startRef: ObjRef | null, names: Set<string>): void {
    let current: ObjRef | null = startRef;
    while (current) {
      const obj = startRef !== null ? this.parentWalkLookup(startRef, current) : this.objects.get(current) ?? null;
      if (!obj) break;
      for (const verb of obj.verbs) names.add(verb.name);
      current = obj.parent;
    }
  }

  private collectSchemaNames(startRef: ObjRef | null, names: Set<string>): void {
    let current: ObjRef | null = startRef;
    while (current) {
      const obj = startRef !== null ? this.parentWalkLookup(startRef, current) : this.objects.get(current) ?? null;
      if (!obj) break;
      for (const name of obj.eventSchemas.keys()) names.add(name);
      current = obj.parent;
    }
  }

  private authorizePresence(actor: ObjRef, space: ObjRef, sessionId: string | null = null): void {
    if (!this.sessionCanAccessSpace(actor, space, sessionId)) {
      throw wooError("E_PERM", `${actor} is not present in ${space}`);
    }
  }

  private featureList(objRef: ObjRef): ObjRef[] {
    const value = this.getPropLive(objRef, "features");
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

  recordWizardAction(principal: ObjRef, action: string, details: Record<string, WooValue>): void {
    const raw = this.propOrNullLive("$system", "wizard_actions");
    const actions = Array.isArray(raw) ? raw : [];
    // `actor` is the acting principal and `action`/`ts` are structural — a
    // details key must never clobber them. A details.actor (the subject some
    // callers pass) is preserved as `target` instead, matching the audit
    // convention that separates principal (`actor`) from subject (`target`).
    const { actor: subject, ...rest } = details;
    const entry: Record<string, WooValue> = { ...rest, ts: Date.now(), actor: principal, action };
    if (typeof subject === "string" && subject !== principal && entry.target === undefined) {
      entry.target = subject;
    }
    this.setProp("$system", "wizard_actions", [...actions, entry]);
  }

  private provisioningAuditSink: ((principal: ObjRef, action: string, details: Record<string, WooValue>) => void) | null = null;

  /**
   * Profile adapter for provisioning audit events (audit.md AU1). The default
   * (in-memory and local SQLite) materializes into `$system.wizard_actions`.
   * The Net planning profile installs a no-op sink because `$system` is
   * catalog-scoped there — writing it would be a forbidden catalog mutation —
   * and the canonical Net audit is the record minted from the committed
   * transcript (the promote/demote turn's verb + write-set + principal). This
   * is the seam that keeps provisioning logic free of `if (net)` branches.
   */
  setProvisioningAuditSink(sink: ((principal: ObjRef, action: string, details: Record<string, WooValue>) => void) | null): void {
    this.assertOutsideBehaviorMutation("setProvisioningAuditSink");
    this.provisioningAuditSink = sink;
  }

  private recordProvisioningAudit(principal: ObjRef, action: string, details: Record<string, WooValue>): void {
    if (this.provisioningAuditSink) {
      this.provisioningAuditSink(principal, action, details);
      return;
    }
    this.recordWizardAction(principal, action, details);
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
    const plan = this.prepareObjectFlagPlan(target, flags);
    return this.applyObjectFlagPlan(actor, plan);
  }

  /**
   * Validate a lineage/surface flag transition without changing either.
   * Callers that also maintain accounting can finish all of their reads and
   * quota checks before applying this plan, keeping the shared flag path from
   * drifting back into validate-after-write ordering.
   */
  private prepareObjectFlagPlan(target: ObjRef, flags: Record<string, unknown>): ObjectFlagPlan {
    if (!this.objects.has(target)) throw wooError("E_OBJNF", `target object not found: ${target}`, target);
    const allowed = new Set(["wizard", "programmer", "fertile"]);
    const obj = this.objectLive(target);
    const before: Record<string, boolean> = { ...obj.flags };
    // Pass 1 — validate every flag and compute the intended changes WITHOUT
    // mutating, so a later failure (a non-composable surface) cannot leave a
    // partially-applied flag set.
    const changes: Record<string, { from: boolean; to: boolean }> = {};
    for (const [key, raw] of Object.entries(flags)) {
      if (!allowed.has(key)) continue;
      if (typeof raw !== "boolean") throw wooError("E_TYPE", `flag ${key} must be boolean`, { key, value: raw as WooValue });
      const prev = Boolean(before[key]);
      if (prev === raw) continue;
      changes[key] = { from: prev, to: raw };
    }
    const reconcileAuthorSurface = Boolean(changes.programmer || changes.wizard);
    if (reconcileAuthorSurface && this.canCarryFeatures(target)) {
      const surface = this.programmerSurface();
      if (surface) {
        // Both attach and remove consume this list. Shape validation belongs in
        // prepare even when the desired state is false.
        this.featureList(target);
        const willAuthor =
          (changes.programmer?.to ?? (before.programmer === true)) ||
          (changes.wizard?.to ?? (before.wizard === true));
        if (willAuthor && (changes.programmer?.to === true || changes.wizard?.to === true)) {
          this.assertSurfaceComposable(target, surface);
        }
      }
    }
    return { target, changes, reconcileAuthorSurface };
  }

  private applyObjectFlagPlan(actor: ObjRef, plan: ObjectFlagPlan): WooObject["flags"] {
    // This is the apply half of a validated authority mutation. `object()` is
    // deliberately detached at the public boundary; mutate the guarded live
    // row so the journal records and can reverse the lineage change.
    const obj = this.objectLive(plan.target);
    const { target, changes } = plan;
    if (Object.keys(changes).length === 0) return { ...obj.flags };
    // The authoring surface must resolve on any actor that can author — a
    // programmer OR a wizard (a wizard bypasses the surface CHECK but still
    // needs the verbs to RESOLVE on itself). Preflight composability before
    // touching anything if either flag is going true, so a shadowing kind
    // refuses with the flag left false.
    // Pass 2 — apply. The programmer/wizard flags and the authoring surface
    // travel together, so a flag flip reconciles the surface too and this path
    // can never leave an author-capable actor without a resolvable surface, nor
    // a surface stranded on a non-authoring actor. No quota accounting:
    // set_object_flags is the deliberate quota-bypassing wizard primitive.
    // The flag write goes through the lineage seam so it is recorded in the net
    // transcript (flags live in the object_lineage cell).
    this.mutateLineage(target, () => {
      for (const [key, change] of Object.entries(changes)) {
        (obj.flags as Record<string, boolean>)[key] = change.to;
      }
    });
    if (plan.reconcileAuthorSurface) {
      this.reconcileProgrammerSurface(target, obj.flags.programmer === true || obj.flags.wizard === true);
    }
    // Deliberately still recordWizardAction. `$system:set_actor_flag`, the only
    // caller, is an UNTRACKED native and is therefore refused over Net before
    // this line can run (incomplete_transcript) — routing the audit through the
    // AU1 sink would be inert while implying Net support that does not exist.
    // On Net, wizard authority is granted by the AP11 provisioning op
    // (spec/identity/provisioning.md §AP11), which writes the flag through the
    // lineage seam and audits through the sink.
    this.recordWizardAction(actor, "set_object_flags", { target, changes: changes as unknown as WooValue });
    this.markObjectDirty(target);
    return { ...obj.flags };
  }

  /** Attach or remove the published programmer surface to match a flag state.
   *  Both directions are idempotent; used by the wizard flag path and shared
   *  provisioning transition so flag and surface never drift apart. */
  private reconcileProgrammerSurface(actor: ObjRef, programmer: boolean): void {
    if (programmer) this.attachProgrammerSurface(actor);
    else this.removeProgrammerSurface(actor);
  }

  private bumpFeaturesVersion(objRef: ObjRef): void {
    const current = Number(this.getPropLive(objRef, "features_version") ?? 0);
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
      if (error.code === "E_VERBNF") return actor === this.objectLive(feature).owner;
      throw err;
    }
  }

  private async addFeature(consumer: ObjRef, feature: ObjRef, actor: ObjRef, observations?: Observation[]): Promise<boolean> {
    this.assertFeatureConsumer(consumer);
    if (feature.startsWith("~")) throw wooError("E_INVARG", "transient objects cannot be features", feature);
    this.objectLive(feature);
    if (consumer === feature) throw wooError("E_RECMOVE", "object cannot add itself as a feature", feature);
    const consumerOwner = this.objectLive(consumer).owner;
    const wizard = this.isWizard(actor);
    if (!wizard && consumerOwner !== actor) throw wooError("E_PERM", `${actor} cannot add features to ${consumer}`);
    if (!wizard && !(await this.canFeatureBeAttachedBy(feature, actor))) throw wooError("E_PERM", `${feature} cannot be attached by ${actor}`);
    // The programmer surface must not be composed onto a kind that shadows its
    // verbs, even through this generic path — otherwise a wizard could attach it
    // to a colliding kind here and then set the flag, landing a half-working
    // surface that promote would accept.
    const surface = this.programmerSurface();
    if (surface && (feature === surface || this.inheritsFrom(feature, surface))) {
      this.assertSurfaceComposable(consumer, surface);
    }
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
    this.objectLive(feature);
    const consumerOwner = this.objectLive(consumer).owner;
    if (!this.isWizard(actor) && consumerOwner !== actor) throw wooError("E_PERM", `${actor} cannot remove features from ${consumer}`);
    const features = this.featureList(consumer);
    if (!features.includes(feature)) return false;
    this.setProp(consumer, "features", features.filter((item) => item !== feature));
    this.bumpFeaturesVersion(consumer);
    observations?.push({ type: "feature_removed", source: consumer, feature });
    return true;
  }

  private async directAudience(actor: ObjRef, target: ObjRef, verbName: string, args: WooValue[], memo?: HostOperationMemo): Promise<ObjRef | null> {
    // Actor movement is addressed to the player object, but the meaningful
    // turn audience is the destination room. This keeps browser tab switching
    // on the destination scope instead of planning an old-location turn.
    if (target === actor && verbName === "moveto" && typeof args[0] === "string") {
      const destination = args[0] as ObjRef;
      if (await this.isDescendantOfCheckedOrFalse(destination, "$space", memo)) return destination;
    }
    const obj = this.objectLive(target);
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

  // CA8: live routing uses the session/audience table — the authoritative
  // record of which live sessions are placed in a space (session.activeScope),
  // set the moment a session is created in a room and maintained by every
  // accepted session-scope transition. This is reliable even when no turn ever
  // ran (a session born in its home room), which the derived
  // session_subscribers projection cannot guarantee. Returns the live sessions
  // and their actors currently scoped to `space`.
  private sessionTableAudienceIn(space: ObjRef): { sessions: string[]; actors: ObjRef[] } {
    const now = Date.now();
    const sessions: string[] = [];
    const actors = new Set<ObjRef>();
    for (const sessionId of this.sessionIdsInActiveScope(space)) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      if (!this.sessionIsLive(session, now)) continue;
      sessions.push(session.id);
      actors.add(session.actor);
    }
    return { sessions, actors: Array.from(actors) };
  }

  private objectIsLocallyOwned(objRef: ObjRef): boolean {
    const local = this.executorContext?.localHost;
    if (!local) return true;
    return this.hostKeyForObject(objRef) === local;
  }

  private projectedDeliveryAudienceIn(space: ObjRef): { sessions: string[]; actors: ObjRef[] } {
    const sessionMap = this.presenceSessionsIn(space);
    if (!sessionMap) return { sessions: [], actors: [] };
    const now = Date.now();
    const sessions: string[] = [];
    const actors = new Set<ObjRef>();
    for (const [sessionId, actor] of sessionMap) {
      if (sessionId.startsWith("legacy:")) continue;
      const session = this.sessions.get(sessionId);
      if (session) {
        if (session.actor !== actor || session.activeScope !== space || !this.sessionIsLive(session, now)) continue;
        sessions.push(sessionId);
        actors.add(actor);
        continue;
      }
      // A missing row for a locally owned actor is stale. A missing row for a
      // remote actor is still useful on a room/tool host that only materialized
      // the projected presence cell; the owning actor/session host remains the
      // source of truth for delivery.
      if (this.objectIsLocallyOwned(actor)) continue;
      sessions.push(sessionId);
      actors.add(actor);
    }
    return { sessions, actors: Array.from(actors) };
  }

  private liveAudienceActors(space: ObjRef): ObjRef[] | undefined {
    // CA8: prefer the session/audience table (activeScope), unioned with the
    // durable presence projection for remote sessions. Local projection rows are
    // only delivery-eligible when their live session is still active here; stale
    // rows must not route destination-room observations to actors who have
    // already moved back out.
    const tableActors = this.sessionTableAudienceIn(space).actors;
    const rawSessionSubscribers = this.propOrNullLive(space, "session_subscribers");
    if (Array.isArray(rawSessionSubscribers)) {
      return Array.from(new Set([...tableActors, ...this.projectedDeliveryAudienceIn(space).actors]));
    }
    const rawLegacySubscribers = this.propOrNullLive(space, "subscribers");
    if (!Array.isArray(rawLegacySubscribers)) return tableActors.length > 0 ? tableActors : undefined;
    this.ensurePresenceIndex();
    const subs = this.subscribersIndex.get(space);
    return Array.from(new Set([...tableActors, ...(subs ?? [])]));
  }

  // Compute the per-observation audience for a direct call from this host's
  // authoritative subscribers/presence view. Public so cross-host RPC handlers
  // can compute audience at the source DO before forwarding to broadcast.
  async computeDirectLiveAudiences(audience: ObjRef | null, observations: Observation[]): Promise<DirectLiveAudience> {
    return await this.directLiveAudiences(audience, observations);
  }

  private async directLiveAudiences(audience: ObjRef | null, observations: Observation[]): Promise<DirectLiveAudience> {
    const actors = new Set<ObjRef>();
    const sessions = new Set<string>();
    const observationAudiences: ObjRef[][] = [];
    const observationSessionAudiences: string[][] = [];
    const observationAudienceExclusions: ObjRef[][] = [];
    const observationAudienceModes: DirectLiveAudience["observationAudienceModes"] = [];
    for (const observation of observations) {
      observationAudienceModes.push(this.observationHasExplicitAudience(observation) ? "explicit" : "presence");
      observationAudienceExclusions.push(this.observationAudienceExclusions(observation));
      const present = this.observationAudienceActors(audience, observation) ?? [];
      const presentSessions = await this.observationAudienceSessions(audience, observation) ?? [];
      observationAudiences.push(present);
      observationSessionAudiences.push(presentSessions);
      for (const actor of present) actors.add(actor);
      for (const session of presentSessions) sessions.add(session);
      delete (observation as Record<string, unknown>)._audience_override;
      delete (observation as Record<string, unknown>)._audience_exclude;
    }
    return {
      audienceActors: actors.size > 0 ? Array.from(actors) : undefined,
      observationAudiences: observations.length > 0 ? observationAudiences : undefined,
      audienceSessions: sessions.size > 0 ? Array.from(sessions) : undefined,
      observationSessionAudiences: observations.length > 0 ? observationSessionAudiences : undefined,
      observationAudienceExclusions: observations.length > 0 ? observationAudienceExclusions : undefined,
      observationAudienceModes: observations.length > 0 ? observationAudienceModes : undefined
    };
  }

  /** Internal catalog routing hint: retain presence-mode delivery, but omit
   * these actors. Positive presence membership is intentionally resolved at
   * each gateway; a compact negative set remains valid across sparse shards. */
  private observationAudienceExclusions(observation: Observation): ObjRef[] {
    const raw = (observation as Record<string, unknown>)._audience_exclude;
    if (!Array.isArray(raw)) return [];
    return Array.from(new Set(raw.filter((item): item is ObjRef => typeof item === "string")));
  }

  /** Whether an observation names recipients independently of the audience
   * space. Presence-derived enumerations are incomplete on a sharded planner
   * and must be re-resolved locally by each delivery gateway. */
  private observationHasExplicitAudience(observation: Observation): boolean {
    if (Array.isArray((observation as Record<string, unknown>)._audience_override)) return true;
    if ((observation.type === "looked" || observation.type === "who") && typeof observation.to === "string") return true;
    if (directedRecipients(observation).to !== null) return true;
    if (typeof observation.target !== "string") return false;
    return !this.objects.has(observation.target) || this.inheritsFrom(observation.target, "$actor");
  }

  private appliedFrameAudience(space: ObjRef, observations: Observation[]): { audienceSessions?: string[]; observationSessionAudiences?: string[][] } {
    // CA8: union the session/audience table (activeScope) with live remote
    // delivery projections, matching the direct-observation path. Local stale
    // projection rows are excluded so accepted-frame fanout cannot deliver a
    // destination-room event to a session that already moved away.
    const sessionActors = new Map<string, ObjRef | null>();
    const projected = this.presenceSessionsIn(space);
    for (const sessionId of this.sessionTableAudienceIn(space).sessions) {
      sessionActors.set(sessionId, this.sessions.get(sessionId)?.actor ?? null);
    }
    for (const sessionId of this.projectedDeliveryAudienceIn(space).sessions) {
      if (sessionActors.has(sessionId)) continue;
      sessionActors.set(sessionId, this.sessions.get(sessionId)?.actor ?? projected?.get(sessionId) ?? null);
    }
    const sessions = Array.from(sessionActors.keys());
    if (observations.length === 0) {
      return { audienceSessions: sessions.length > 0 ? sessions : undefined };
    }
    // The observation-intrinsic audience rules (directed `told`/`text`,
    // self-addressed `looked`/`who`) apply to committed frames too: a
    // sequenced verb that emits `tell()` must not broadcast the recipient's
    // second-person line to the whole room. Delivery lanes that re-resolve
    // presence themselves apply the same predicate (see gateway-do
    // pushScopedObservations); keeping it here means the frame's own audience
    // hint never contradicts what the transports do.
    const perObservation = observations.map((observation) =>
      sessions.filter((sessionId) => observationReachesActor(observation, sessionActors.get(sessionId) ?? null))
    );
    const union = Array.from(new Set(perObservation.flat()));
    return {
      audienceSessions: union.length > 0 ? union : undefined,
      observationSessionAudiences: perObservation
    };
  }

  private observationAudienceActors(fallbackAudience: ObjRef | null, observation: Observation): ObjRef[] | undefined {
    const exclusions = new Set(this.observationAudienceExclusions(observation));
    const withoutExclusions = (actors: ObjRef[] | undefined): ObjRef[] | undefined =>
      actors?.filter((actor) => !exclusions.has(actor));
    // Per-observation audience override. Used when the source is a remote
    // $space whose subscriber list this host can't read locally — the caller
    // pre-fetches subscribers cross-host and stamps them here. The field is
    // stripped from the observation by directLiveAudiences before broadcast.
    const override = (observation as Record<string, unknown>)._audience_override;
    if (Array.isArray(override)) {
      return withoutExclusions(override.filter((item): item is ObjRef => typeof item === "string"));
    }
    if ((observation.type === "looked" || observation.type === "who") && typeof observation.to === "string") {
      return withoutExclusions([observation.to]);
    }
    if (typeof observation.target === "string") {
      if (this.objects.has(observation.target) && this.inheritsFrom(observation.target, "$actor")) return withoutExclusions([observation.target]);
      if (!this.objects.has(observation.target)) return withoutExclusions([observation.target]);
    }
    const directed = directedRecipients(observation);
    if (directed.to) {
      const actors = [directed.to];
      if (directed.from) actors.push(directed.from);
      return withoutExclusions(actors);
    }
    const source = typeof observation.source === "string" && this.objects.has(observation.source) && this.inheritsFrom(observation.source, "$space")
      ? observation.source
      : null;
    const audience = source ?? fallbackAudience;
    if (!audience) return undefined;
    const present = this.liveAudienceActors(audience);
    if (!present) return undefined;
    if ((observation.type === "entered" || observation.type === "left" || observation.type === "taken" || observation.type === "dropped") && typeof observation.actor === "string") {
      return withoutExclusions(present.filter((actor) => actor !== observation.actor));
    }
    return withoutExclusions(present);
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
    if (sessionMap || (audience && this.objects.has(audience) && this.isSpaceLike(audience))) {
      const sessions = new Set<string>();
      // CA8: the session/audience table (activeScope) is the authoritative live
      // routing source — it includes a session born in this room with no enter
      // turn. Union with delivery-eligible remote projections, but never with
      // stale local projection rows whose session already moved elsewhere.
      if (audience) {
        for (const sessionId of this.sessionTableAudienceIn(audience).sessions) {
          const session = this.sessions.get(sessionId);
          if (session && actorSet.has(session.actor)) sessions.add(sessionId);
        }
      }
      if (audience) for (const sessionId of this.projectedDeliveryAudienceIn(audience).sessions) {
        const actor = sessionMap?.get(sessionId);
        if (actor && actorSet.has(actor)) sessions.add(sessionId);
      }
      return Array.from(sessions);
    }
    if (audience && this.executorContext && await this.remoteHostForObject(audience)) {
      try {
        return await this.executorContext.spaceAudienceSessions?.(audience, actors) ?? [];
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
        this.getPropLive(objRef, "next_seq");
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
      const obj = this.parentWalkLookup(objRef, current);
      if (!obj) return false;
      current = obj.parent;
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
      if (!this.executorContext) throw wooError("E_INTERNAL", "remote host bridge unavailable");
      return await this.executorContext.isDescendantOf(objRef, ancestorRef, memo);
    }
    this.objectLive(objRef);
    return false;
  }

  private async updatePresenceChecked(actor: ObjRef, space: ObjRef, present: boolean, ctx?: CallContext): Promise<boolean> {
    const actorRemote = await this.remoteHostForObject(actor);
    const spaceRemote = await this.remoteHostForObject(space);
    const sessionId = this.presenceSessionId(actor, ctx);
    if (!actorRemote && !spaceRemote) return this.updatePresence(actor, space, present, sessionId);
    if (!this.executorContext && (actorRemote || spaceRemote)) throw wooError("E_INTERNAL", "remote host bridge unavailable");
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
          this.setSessionActiveScope(session, space);
          this.persistSession(session);
        }
      }
      return this.updateActorPresenceLocal(actor, space, present, sessionId);
    }
    if (!this.executorContext) throw wooError("E_INTERNAL", "remote host bridge unavailable");
    await this.executorContext.setActorPresence(actor, space, present, sessionId);
    return true;
  }

  private async setSpaceSubscriberChecked(space: ObjRef, actor: ObjRef, present: boolean, sessionId: string = this.presenceSessionId(actor)): Promise<boolean> {
    const spaceRemote = await this.remoteHostForObject(space);
    if (!spaceRemote) return this.updateSpaceSubscriberLocal(space, actor, present, sessionId);
    if (!this.executorContext) throw wooError("E_INTERNAL", "remote host bridge unavailable");
    await this.executorContext.setSpaceSubscriber(space, actor, present, sessionId);
    return true;
  }

  private updatePresence(actor: ObjRef, space: ObjRef, present: boolean, sessionId: string = this.presenceSessionId(actor)): boolean {
    if (present) {
      const session = this.sessions.get(sessionId);
      if (session && session.actor === actor) {
        this.setSessionActiveScope(session, space);
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
    this.objectLive(actor);
    return false;
  }

  private updateSpaceSubscriberLocal(space: ObjRef, actor: ObjRef, present: boolean, sessionId: string = this.presenceSessionId(actor)): boolean {
    this.objectLive(space);
    const rawSubscribers = this.getPropLive(space, "subscribers");
    if (!Array.isArray(rawSubscribers)) throw wooError("E_TYPE", `${space}.subscribers must be a list`, rawSubscribers);
    const rawSessionSubscribers = this.propOrNullLive(space, "session_subscribers");
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

  // Used by the actor-level subscriber scrub to evict an actor whose
  // session-attribution may not be reachable from this DO any more (for
  // example a session row pointing at an MCP gateway session lost to
  // hibernation). Drops every row whose actor matches and rebuilds
  // `subscribers` from the survivors so the two views stay coherent.
  private dropAllSubscriberRowsForActor(space: ObjRef, actor: ObjRef): boolean {
    if (!this.objects.has(space)) return false;
    const rawSubscribers = this.getPropLive(space, "subscribers");
    if (!Array.isArray(rawSubscribers)) throw wooError("E_TYPE", `${space}.subscribers must be a list`, rawSubscribers);
    const subscribers = rawSubscribers.filter((item): item is ObjRef => typeof item === "string");
    const rawSessionSubscribers = this.propOrNullLive(space, "session_subscribers");
    const parsedRows = Array.isArray(rawSessionSubscribers)
      ? rawSessionSubscribers
        .filter((item): item is Record<string, WooValue> => !!item && typeof item === "object" && !Array.isArray(item))
        .map((item) => ({ session: String(item.session ?? ""), actor: String(item.actor ?? "") as ObjRef }))
        .filter((item) => item.session && item.actor)
      : [];
    // Legacy worlds with no session_subscribers still need cleanup; the
    // existing `updateSpaceSubscriberLocal` path synthesizes `legacy:<actor>`
    // rows and can drop the matching one by sessionId, so defer to it there.
    if (parsedRows.length === 0) return this.updateSpaceSubscriberLocal(space, actor, false);
    const survivingRows = parsedRows.filter((row) => row.actor !== actor);
    const subscribersChanged = subscribers.includes(actor);
    if (survivingRows.length === parsedRows.length && !subscribersChanged) return false;
    const survivingActors = Array.from(new Set(survivingRows.map((row) => row.actor))).sort();
    this.withPersistenceDeferred(() => {
      this.setProp(space, "session_subscribers", survivingRows as unknown as WooValue);
      this.setProp(space, "subscribers", survivingActors as unknown as WooValue);
    });
    if (subscribersChanged) this.recordMetric({ kind: "subscribers_write", space, size: survivingActors.length, delta: -1 });
    return true;
  }

  private allocateGuest(): ObjRef {
    if (this.guestFreePool.size === 0) this.rebuildGuestPool();
    const pooled = Array.from(this.guestFreePool).sort()[0];
    if (pooled) {
      this.withBehaviorMutationPermit(() => this.guestFreePool.delete(pooled));
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
      seq: Number(this.getPropLive(space, "next_seq")) - 1,
      objects: Object.fromEntries(ids.map((id) => [id, Object.fromEntries(this.objectLive(id).properties)]))
    };
  }

  private withBehaviorSavepoint<T>(fn: () => Promise<T>): Promise<T>;
  private withBehaviorSavepoint<T>(fn: () => T): T;
  private withBehaviorSavepoint<T>(fn: () => T | Promise<T>): T | Promise<T> {
    const recorder = this.activeTurnRecorder;
    recorder?.beginBehaviorScope();
    this.behaviorUndoScopes.push({
      undos: [],
      terminalTransferDisallowedKinds: new Set(),
      acceptance: [],
      objects: new Set(),
      sessions: new Set(),
      logs: new Set(),
      tombstones: new Set(),
      guestFreePool: new Set(),
      snapshots: false,
      createdThisRun: new Set(),
      orderedEdgeWritesThisRun: new Set(),
      roomRosterProjections: new Map(),
      subscriberScrubAt: new Map(),
      objectCounter: this.objectCounter,
      sessionCounter: this.sessionCounter,
      persistence: this.snapshotPersistenceDirtyState()
    });
    this.behaviorSavepointDepth += 1;
    this.persistencePaused += 1;
    const commit = (value: T): T => {
      try {
        if (this.behaviorSavepointDepth === 1 && this.persistenceDeferred === 0) {
          // Nested sequenced calls can stage durable log acceptance beneath a
          // direct command-plan turn. Execute those commits only while the
          // outer rollback journal is still live; any repository refusal then
          // aborts both the nested turn and its outer behavior atomically.
          this.runBehaviorAcceptance(this.behaviorUndoScopes.at(-1)?.acceptance ?? []);
        }
        this.commitBehaviorUndoScope();
        recorder?.commitBehaviorScope();
        return value;
      } catch (err) {
        this.abortBehaviorUndoScope();
        recorder?.abortBehaviorScope();
        throw err;
      } finally {
        this.behaviorSavepointDepth -= 1;
        this.persistencePaused -= 1;
      }
    };
    const abort = (err: unknown): never => {
      try {
        this.abortBehaviorUndoScope();
        recorder?.abortBehaviorScope();
      } finally {
        this.behaviorSavepointDepth -= 1;
        this.persistencePaused -= 1;
      }
      throw err;
    };
    let result: T | Promise<T>;
    try {
      result = fn();
    } catch (err) {
      return abort(err);
    }
    // Keep commit outside the fn() catch. A synchronous repository refusal
    // during commit is already rolled back by commit(); catching it here as
    // though fn() had failed would abort the same journal a second time and
    // mask the acceptance error with "undo-scope abort without begin".
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(commit, abort);
    }
    return commit(result);
  }

  private prepareBehaviorObject(object: WooObject): WooObject {
    const existing = this.behaviorObjectProxies.get(object);
    if (existing) return existing;
    // Capture only the primitive owner id. Capturing `object` retains the
    // detached caller graph for as long as the authoritative proxy lives.
    const objectId = object.id;
    const record = (undo: () => void): void => this.recordBehaviorUndo(undo, "objects", objectId);
    const cache = new WeakMap<object, unknown>();
    const proxy = behaviorMutationValue(
      object,
      record,
      cache,
      () => this.assertBehaviorMutationPermitted("objects", objectId),
      "woo_object"
    );
    this.behaviorObjectProxies.set(object, proxy);
    this.behaviorObjectProxies.set(proxy, proxy);
    return proxy;
  }

  private prepareBehaviorSession(session: Session): Session {
    const existing = this.behaviorSessionProxies.get(session);
    if (existing) return existing;
    const sessionId = session.id;
    const record = (undo: () => void): void => this.recordBehaviorUndo(undo, "sessions", sessionId);
    const cache = new WeakMap<object, unknown>();
    const proxy = behaviorMutationValue(
      session,
      record,
      cache,
      () => this.assertBehaviorMutationPermitted("sessions", sessionId)
    );
    this.behaviorSessionProxies.set(session, proxy);
    this.behaviorSessionProxies.set(proxy, proxy);
    return proxy;
  }

  private prepareBehaviorLog(entries: SpaceLogEntry[]): SpaceLogEntry[] {
    const existing = this.behaviorLogProxies.get(entries);
    if (existing) return existing;
    const cache = new WeakMap<object, unknown>();
    const proxy = behaviorMutationValue(
      entries,
      (undo) => this.recordBehaviorUndo(undo, "logs"),
      cache,
      () => this.assertBehaviorMutationPermitted("logs")
    );
    this.behaviorLogProxies.set(entries, proxy);
    this.behaviorLogProxies.set(proxy, proxy);
    return proxy;
  }

  private prepareBehaviorSnapshot(snapshot: SpaceSnapshotRecord): SpaceSnapshotRecord {
    const existing = this.behaviorSnapshotProxies.get(snapshot);
    if (existing) return existing;
    // Snapshot rows are independently owned durable records. Each root keeps
    // its own graph cache, but repeated reads of that root resolve to the same
    // proxy and therefore preserve identity.
    const cache = new WeakMap<object, unknown>();
    const proxy = behaviorMutationValue(
      snapshot,
      (undo) => this.recordBehaviorUndo(undo, "snapshots"),
      cache,
      () => this.assertBehaviorMutationPermitted("snapshots")
    );
    this.behaviorSnapshotProxies.set(snapshot, proxy);
    this.behaviorSnapshotProxies.set(proxy, proxy);
    return proxy;
  }

  private recordBehaviorUndo(
    undo: () => void,
    kind: "objects" | "sessions" | "logs" | "tombstones" | "guestFreePool" | "snapshots",
    id?: string
  ): void {
    if (this.behaviorJournalRestoring > 0) return;
    const scope = this.behaviorUndoScopes.at(-1);
    if (!scope) return;
    if (this.behaviorMutationPermit === 0) {
      throw wooError("E_INTERNAL", "authoritative mutation attempted without a mutation permit", { kind, id: id ?? null });
    }
    scope.undos.push(undo);
    if (kind === "snapshots") scope.snapshots = true;
    else if (id !== undefined) scope[kind].add(id);
  }

  private assertBehaviorMutationPermitted(
    kind: "objects" | "sessions" | "logs" | "tombstones" | "guestFreePool" | "snapshots",
    id?: string
  ): void {
    if (this.behaviorJournalRestoring > 0) return;
    if (this.behaviorMutationPermit === 0) {
      throw wooError("E_INTERNAL", "authoritative mutation attempted without a mutation permit", { kind, id: id ?? null });
    }
  }

  private assertOutsideBehaviorMutation(what: string): void {
    if (this.behaviorSavepointDepth === 0) return;
    throw wooError("E_INTERNAL", `${what} cannot mutate during behavior execution`, { operation: what });
  }

  private withBehaviorMutationPermit<T>(fn: () => T): T {
    this.behaviorMutationPermit += 1;
    try {
      return fn();
    } finally {
      this.behaviorMutationPermit -= 1;
    }
  }

  private commitBehaviorUndoScope(): void {
    const committed = this.behaviorUndoScopes.pop();
    if (!committed) throw new Error("behavior undo-scope commit without begin");
    const parent = this.behaviorUndoScopes.at(-1);
    if (!parent) {
      this.lastBehaviorUndoStats = this.behaviorUndoStats(committed);
      return;
    }
    parent.undos.push(...committed.undos);
    for (const kind of committed.terminalTransferDisallowedKinds) {
      parent.terminalTransferDisallowedKinds.add(kind);
    }
    parent.acceptance.push(...committed.acceptance);
    for (const id of committed.objects) parent.objects.add(id);
    for (const id of committed.sessions) parent.sessions.add(id);
    for (const id of committed.logs) parent.logs.add(id);
    for (const id of committed.tombstones) parent.tombstones.add(id);
    for (const id of committed.guestFreePool) parent.guestFreePool.add(id);
    for (const id of committed.createdThisRun) parent.createdThisRun.add(id);
    for (const id of committed.orderedEdgeWritesThisRun) parent.orderedEdgeWritesThisRun.add(id);
    for (const [room, before] of committed.roomRosterProjections) {
      if (!parent.roomRosterProjections.has(room)) parent.roomRosterProjections.set(room, before);
    }
    for (const [space, before] of committed.subscriberScrubAt) {
      if (!parent.subscriberScrubAt.has(space)) parent.subscriberScrubAt.set(space, before);
    }
    parent.snapshots ||= committed.snapshots;
  }

  private acceptNowOrWithOuterBehavior(accept: () => void): void {
    const scope = this.behaviorUndoScopes.at(-1);
    if (scope) scope.acceptance.push(accept);
    else this.runBehaviorAcceptance([accept]);
  }

  private runBehaviorAcceptance(acceptance: Array<() => void>): void {
    const repo = this.activeObjectRepository();
    if (
      acceptance.length === 0 &&
      !this.persistenceDirty &&
      !this.hasDirtyPersistence()
    ) return;
    const acceptAll = (): void => {
      this.behaviorJournalAccepting += 1;
      try {
        for (const accept of acceptance) accept();
        // Log allocation and every dirty object/property/session row produced
        // by the nested turns share one repository transaction. If the final
        // callback or flush fails, no earlier nested turn survives the outer
        // in-memory rollback.
        if (repo) {
          this.flushIncrementalState();
          this.persistenceDirty = this.hasDirtyPersistence();
        } else if (this.repository && this.persistenceDirty) {
          this.runFullSave("world_persist");
          this.persistenceDirty = false;
        }
      } finally {
        this.behaviorJournalAccepting -= 1;
      }
    };
    if (repo) repo.transaction(acceptAll);
    else acceptAll();
  }

  private abortBehaviorUndoScope(): void {
    const aborted = this.behaviorUndoScopes.pop();
    if (!aborted) throw new Error("behavior undo-scope abort without begin");
    this.behaviorJournalRestoring += 1;
    try {
      for (let index = aborted.undos.length - 1; index >= 0; index -= 1) aborted.undos[index]();
    } finally {
      this.behaviorJournalRestoring -= 1;
    }
    this.objectCounter = aborted.objectCounter;
    this.sessionCounter = aborted.sessionCounter;
    for (const id of aborted.createdThisRun) this.createdThisRun.delete(id);
    for (const id of aborted.orderedEdgeWritesThisRun) this.orderedEdgeWritesThisRun.delete(id);
    for (const [room, before] of aborted.roomRosterProjections) {
      if (before === undefined) this.roomRosterProjections.delete(room);
      else this.roomRosterProjections.set(room, before);
    }
    for (const [space, before] of aborted.subscriberScrubAt) {
      if (before === undefined) this.lastSubscriberScrubAt.delete(space);
      else this.lastSubscriberScrubAt.set(space, before);
    }
    this.restorePersistenceDirtyState(aborted.persistence);
    this.invalidatePresenceIndex();
    this.invalidateSessionActiveScopeIndex();
    if (this.behaviorUndoScopes.length === 0) this.lastBehaviorUndoStats = this.behaviorUndoStats(aborted);
  }

  private behaviorUndoStats(scope: BehaviorUndoScope): NonNullable<WooWorld["lastBehaviorUndoStats"]> {
    return {
      objects: scope.objects.size,
      sessions: scope.sessions.size,
      tombstones: scope.tombstones.size,
      guestPool: scope.guestFreePool.size,
      snapshots: scope.snapshots ? 1 : 0
    };
  }

  /**
   * Test/benchmark diagnostic for the most recently completed outer behavior
   * scope. Counts distinct mutated categories/rows; inverse-operation count is
   * intentionally not exposed as a semantic contract.
   */
  behaviorUndoStatsForTesting(): Readonly<NonNullable<WooWorld["lastBehaviorUndoStats"]>> | null {
    return this.lastBehaviorUndoStats ? { ...this.lastBehaviorUndoStats } : null;
  }

  private async publicCommandActor(ctx: CallContext, value: WooValue | undefined): Promise<ObjRef> {
    const actor = typeof value === "string" ? value as ObjRef : ctx.actor;
    if (actor !== ctx.actor && !this.isWizard(ctx.actor)) {
      throw wooError("E_PERM", `${ctx.actor} cannot parse commands as ${actor}`, { actor: ctx.actor, requested_actor: actor });
    }
    if (this.objects.has(actor) || await this.remoteHostForObject(actor, ctx.hostMemo)) return actor;
    this.objectLive(actor);
    return actor;
  }

  private async publicCommandLocation(ctx: CallContext, actor: ObjRef, value: WooValue | undefined, options: PublicCommandLocationOptions = {}): Promise<ObjRef | null> {
      const location = typeof value === "string"
        ? value as ObjRef
        : actor === ctx.actor && ctx.session
          ? this.activeScopeForSession(ctx.session)
          : await this.objectLocationChecked(actor, ctx.hostMemo).catch((err) => {
            if (isOptionalProjectionReadError(err)) return null;
            throw err;
          });
    await this.assertPublicCommandLocation(ctx, actor, location, options);
    return location;
  }

  private async assertPublicCommandLocation(ctx: CallContext, actor: ObjRef, location: ObjRef | null, options: PublicCommandLocationOptions = {}): Promise<void> {
    if (!location || this.isWizard(ctx.actor)) return;
    if (actor !== ctx.actor) {
      throw wooError("E_PERM", `${ctx.actor} cannot parse commands for ${actor}`, { actor: ctx.actor, requested_actor: actor });
    }
    if (location === actor) return;
    if (options.skipPresenceCheck === true) return;

      const actorLocation = actor === ctx.actor && ctx.session
        ? this.activeScopeForSession(ctx.session)
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
    } catch (err) {
      if (!isReadAvailabilityError(err)) throw err;
      // Missing or unreadable command locations are rejected below.
    }
    throw wooError("E_PERM", `${actor} is not present in ${location}`, { actor, location });
  }

  private currentVerbSkipsPresenceCheck(ctx: CallContext): boolean {
    try {
      if (this.ownVerbExact(ctx.definer, ctx.verbName)?.skip_presence_check === true) return true;
    } catch {
      // Fall through to the original message verb below.
    }
    try {
      return this.resolveVerbLive(ctx.message.target, ctx.message.verb).verb.skip_presence_check === true;
    } catch {
      return false;
    }
  }

  private async commandVisibleCandidates(ctx: CallContext, actor: ObjRef, location: ObjRef | null): Promise<ObjRef[]> {
    const candidates: ObjRef[] = [];
    const add = (id: unknown): void => {
      if (typeof id === "string" && !candidates.includes(id)) candidates.push(id);
    };
    add(actor);
    if (location) {
      add(location);
      for (const id of await this.objectContents(location, ctx.hostMemo, "visible_contents").catch((err) => {
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
      const callerContents = await this.objectContents(caller, ctx.hostMemo, "visible_contents").catch((err): ObjRef[] => {
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
    this.nativeHandlers.set("player_on_disfunc", () => true);
    this.nativeHandlers.set("player_moveto", async (ctx, args) => {
      if (ctx.thisObj !== ctx.actor && !this.isWizard(ctx.actor)) throw wooError("E_PERM", "players may only move themselves", { actor: ctx.actor, target: ctx.thisObj });
      const target = assertObj(args[0] ?? "$nowhere");
      await this.movetoChecked(ctx, ctx.thisObj, target);
      return { room: target, here_request: true, look_deferred: true };
    });
    this.nativeHandlers.set("player_join", (ctx, args) => this.playerJoin(ctx, args));
    this.nativeHandlers.set("guest_on_disfunc", async (ctx, args) => {
      const homeValue = this.propOrNullLive(ctx.thisObj, "home");
      // The optional destination is for trusted session cleanup (the net guest
      // door restores a claimed seat to its catalog-declared initial room).
      // Ordinary disfunc keeps the historical home/$nowhere behavior.
      const requested = args[0];
      const home = typeof requested === "string" && this.objects.has(requested)
        ? requested
        : typeof homeValue === "string" && this.objects.has(homeValue)
          ? homeValue
          : "$nowhere";
      const fallback = this.guestInventoryFallback(ctx.thisObj, home);
      const carried = await this.objectContents(ctx.thisObj, ctx.hostMemo);
      for (const item of carried) {
        if (!this.objects.has(item) && !await this.remoteHostForObject(item, ctx.hostMemo)) {
          this.withBehaviorMutationPermit(() => {
            this.objectLive(ctx.thisObj).contents.delete(item);
          });
          continue;
        }
        await this.moveObjectChecked(item, this.inventoryEjectTarget(item, fallback));
      }
      await this.moveObjectChecked(ctx.thisObj, home);
      this.setProp(ctx.thisObj, "description", "");
      this.setProp(ctx.thisObj, "aliases", []);
      this.setProp(ctx.thisObj, "features", []);
      this.setProp(ctx.thisObj, "features_version", Number(this.propOrNullLive(ctx.thisObj, "features_version") ?? 0) + 1);
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
      this.objectLive(target);
      if (!this.inheritsFrom(target, "$actor")) throw wooError("E_TYPE", `target must be an $actor descendant: ${target}`, target);
      const session = this.createSessionForActorLive(target, "bearer");
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
      if (result.closedSessions.length > 0 && ctx.onSessionsEnded) {
        const notify = ctx.onSessionsEnded;
        ctx.deferPostAccept?.("sessions_ended:revoke_api_key", () => notify(result.closedSessions));
      }
      return result.revoked;
    });
    this.nativeHandlers.set("list_api_keys", (ctx) => {
      return this.listApiKeys(ctx.actor) as unknown as WooValue;
    });
    this.nativeHandlers.set("list_api_keys_for_owner", (ctx, args) => {
      // The bounded authority is an explicit contract argument. Frame
      // topology (`caller`) is not an access-control input.
      const target = assertObj(args[0]);
      return this.listApiKeysForOwner(ctx.actor, target) as unknown as WooValue;
    });
    this.nativeHandlers.set("provision_actor", (ctx, args) => {
      if (!this.canBypassPerms(ctx.actor)) throw wooError("E_PERM", "wizard authority required to provision actors", { actor: ctx.actor });
      const classRef = assertObj(args[0]);
      const owner = assertObj(args[1]);
      const attrs = args[2] && typeof args[2] === "object" && !Array.isArray(args[2]) ? args[2] as Record<string, WooValue> : {};
      return this.provisionActorInternal(classRef, owner, attrs, ctx.actor).actor;
    });
    this.nativeHandlers.set("rotate_api_key", (ctx, args) => {
      if (!this.canBypassPerms(ctx.actor)) throw wooError("E_PERM", "wizard authority required to rotate api keys", { actor: ctx.actor });
      const agent = assertObj(args[0]);
      // createApiKey performs the same check, but it must happen before the old
      // credential is revoked on this prepare-then-apply path.
      this.assertApiKeyIssuable(agent);
      const oldKey = this.propOrNullLive(agent, "api_key_id");
      if (typeof oldKey === "string" && oldKey) this.revokeApiKeyRecordById(ctx.actor, oldKey, args[1] === true);
      const key = this.createApiKey(ctx.actor, agent, String(this.propOrNullLive(agent, "name") ?? agent));
      this.setProp(agent, "api_key_id", key.id);
      return { api_key: `apikey:${key.id}:${key.secret}`, id: key.id, actor: agent, created_at: key.created_at } as unknown as WooValue;
    });
    this.nativeHandlers.set("deactivate_actor", (ctx, args) => {
      if (!this.canBypassPerms(ctx.actor)) throw wooError("E_PERM", "wizard authority required to deactivate actors", { actor: ctx.actor });
      const target = assertObj(args[0]);
      const now = Date.now();
      const closedSessions: Session[] = [];
      if (this.inheritsFrom(target, "$account")) {
        this.setProp(target, "deactivated_at", now);
        for (const actor of this.accountActors(target)) closedSessions.push(...this.closeSessionsForActor(actor));
      } else {
        this.setProp(target, "deactivated_at", now);
        closedSessions.push(...this.closeSessionsForActor(target));
      }
      this.recordWizardAction(ctx.actor, "actor_deactivated", { actor: target, reason: typeof args[1] === "string" ? args[1] : null });
      if (closedSessions.length > 0 && ctx.onSessionsEnded) {
        const notify = ctx.onSessionsEnded;
        ctx.deferPostAccept?.("sessions_ended:deactivate_actor", () => notify(closedSessions));
      }
      return true;
    });
    this.nativeHandlers.set("reactivate_actor", (ctx, args) => {
      if (!this.canBypassPerms(ctx.actor)) throw wooError("E_PERM", "wizard authority required to reactivate actors", { actor: ctx.actor });
      const target = assertObj(args[0]);
      // Symmetry with retirement: reactivating a RETIRED actor would restore a
      // live identity whose quota slot has already been returned, so the
      // account would carry N live agents against a count of N-1 — the same
      // bypass as a double-return, arrived at from the other side. Retirement
      // is permanent by contract; a replacement is a fresh provisioning.
      // Plain deactivation stays fully reversible: it never returned a slot,
      // so there is nothing to restore.
      if (this.propOrNullLive(target, "retired_at") != null) {
        throw wooError("E_PERM", "actor was permanently retired; provision a replacement instead of reactivating", { actor: target });
      }
      this.setProp(target, "deactivated_at", null);
      this.recordWizardAction(ctx.actor, "actor_reactivated", { actor: target });
      return true;
    });
    this.nativeHandlers.set("recycle_actor", async (ctx, args) => {
      if (!this.canBypassPerms(ctx.actor)) throw wooError("E_PERM", "wizard authority required to recycle actors", { actor: ctx.actor });
      const target = assertObj(args[0]);
      await this.recycleChecked(ctx.progr, ctx.actor, target, { force: true, force_reserved: true });
      this.recordWizardAction(ctx.actor, "actor_recycled", { actor: target });
      return true;
    });
    this.nativeHandlers.set("issue_signup_invite", (ctx, args) => {
      if (!this.canBypassPerms(ctx.actor)) throw wooError("E_PERM", "wizard authority required to issue invites", { actor: ctx.actor });
      this.gcPendingCredentials();
      const quantity = Math.max(1, Math.min(100, Math.floor(Number(args[0] ?? 1))));
      const expiresAt = Number(args[1] ?? Date.now() + 7 * 24 * 60 * 60_000);
      const raw = this.propOrNullLive("$system", "signup_invites");
      const invites = Array.isArray(raw) ? raw : [];
      const created = Array.from({ length: quantity }, () => ({ code: randomHex(16), expires_at: expiresAt, used_by: null }));
      this.setProp("$system", "signup_invites", [...invites, ...created] as unknown as WooValue);
      this.recordWizardAction(ctx.actor, "signup_invite_issued", { quantity, expires_at: expiresAt });
      return created as unknown as WooValue;
    });
    this.nativeHandlers.set("gc_pending_credentials", (ctx) => {
      if (!this.canBypassPerms(ctx.actor)) throw wooError("E_PERM", "wizard authority required to gc pending credentials", { actor: ctx.actor });
      const changed = this.gcPendingCredentials();
      this.recordWizardAction(ctx.actor, "gc_pending_credentials", { changed });
      return changed;
    });
    this.nativeHandlers.set("set_actor_flag", (ctx, args) => {
      if (!this.canBypassPerms(ctx.actor)) throw wooError("E_PERM", "wizard authority required to set actor flags", { actor: ctx.actor });
      const target = assertObj(args[0]);
      const flag = String(args[1] ?? "");
      const value = args[2];
      if (typeof value !== "boolean") throw wooError("E_TYPE", "flag value must be boolean", value);
      // Prepare the shared lineage/surface transition before touching the
      // account counter. In particular, malformed feature state must reject
      // here rather than after set_actor_flag has consumed or returned quota.
      const flagPlan = this.prepareObjectFlagPlan(target, { [flag]: value });
      if (flag === "programmer" && value === true && this.inheritsFrom(target, "$agent")) {
        const owner = this.propOrNullLive(target, "owner");
        if (typeof owner === "string" && this.objects.has(owner) && this.inheritsFrom(owner, "$human")) {
          const account = assertObj(this.propOrNullLive(owner, "account"));
          if (!this.objectLive(target).flags.programmer) {
            this.assertProgrammerAgentQuota(account);
            this.setProp(account, "programmer_agent_count", Number(this.propOrNullLive(account, "programmer_agent_count") ?? 0) + 1);
          }
        }
      }
      if (flag === "programmer" && value === false && this.inheritsFrom(target, "$agent") && this.objectLive(target).flags.programmer) {
        const owner = this.propOrNullLive(target, "owner");
        if (typeof owner === "string" && this.objects.has(owner) && this.inheritsFrom(owner, "$human")) {
          const account = assertObj(this.propOrNullLive(owner, "account"));
          this.setProp(account, "programmer_agent_count", Math.max(0, Number(this.propOrNullLive(account, "programmer_agent_count") ?? 0) - 1));
        }
      }
      return this.applyObjectFlagPlan(ctx.actor, flagPlan) as unknown as WooValue;
    });
    this.nativeHandlers.set("set_quota", (ctx, args) => {
      if (!this.canBypassPerms(ctx.actor)) throw wooError("E_PERM", "wizard authority required to set quotas", { actor: ctx.actor });
      const account = assertObj(args[0]);
      const kind = String(args[1] ?? "");
      const value = Math.max(0, Math.floor(Number(args[2] ?? 0)));
      if (kind !== "agent_quota" && kind !== "programmer_grant_quota") throw wooError("E_INVARG", "unknown quota kind", kind);
      const old = Number(this.propOrNullLive(account, kind) ?? 0);
      this.setProp(account, kind, value);
      // AU1 seam, not recordWizardAction: the quota cell is cluster-resident but
      // `$system` is catalog-scoped on Net, so appending wizard_actions here made
      // every set_quota turn fail E_CATALOG_MUTATION — which left a deployed
      // world with no way to grant programmer quota at all, even holding a
      // working wizard. Local profiles still materialize the entry.
      this.recordProvisioningAudit(ctx.actor, "account_quota_changed", { account, kind, old, new: value });
      return true;
    });
    this.nativeHandlers.set("human_create_agent", (ctx, args) => {
        this.assertSelfHuman(ctx.actor, ctx.thisObj);
        const name = assertString(args[0] ?? "");
        const purpose = typeof args[1] === "string" ? args[1] : "";
        const result = this.createAgentForHuman(ctx.thisObj, name, purpose, args[2] === true);
        ctx.observe({ type: "agent_created", source: ctx.thisObj, actor: result.actor_id, name, _audience_override: [ctx.thisObj] });
        return { actor_id: result.actor_id, api_key: result.api_key, mcp_url: this.propOrNullLive("$system", "mcp_endpoint_url") ?? "/mcp" } as unknown as WooValue;
      });
      this.nativeHandlers.set("human_list_agents", (ctx) => {
        this.assertSelfHuman(ctx.actor, ctx.thisObj);
        return this.listAgentsForHuman(ctx.thisObj) as unknown as WooValue;
      });
      this.nativeHandlers.set("human_revoke_agent", async (ctx, args) => {
        this.assertSelfHuman(ctx.actor, ctx.thisObj);
        const agent = assertObj(args[0]);
        const account = this.assertOwnedAgent(ctx.thisObj, agent);
        const reason = typeof args[1] === "string" ? args[1] : null;
        // Has the quota slot already been returned? This is deliberately NOT
        // `deactivated_at` — see agentSlotReturnedAt. Read before any mutation.
        const slotReturnedAt = this.agentSlotReturnedAt(agent);
        // The permanent-retirement WORK runs on every call and each step is
        // individually idempotent, so a repeat call repairs an agent that some
        // other path left half-retired: $system:deactivate_actor tombstones
        // without stripping programmer state or revoking keys.
        await this.setProgrammerAgentState(ctx.actor, agent, account, false, "agent_demoted_from_programmer");
        const key = this.propOrNullLive(agent, "api_key_id");
        const keyNewlyRevoked = typeof key === "string" && key
          ? this.revokeApiKeyRecordById(ctx.actor, key, true)
          : false;
        const now = Date.now();
        if (slotReturnedAt !== null) {
          // Backfill the explicit marker when it was inferred, so the next call
          // needs no inference at all.
          if (this.propOrNullLive(agent, "retired_at") == null) this.setProp(agent, "retired_at", slotReturnedAt);
          // No counter change and no duplicate "this agent retired" record —
          // but a repeat that actually repaired something is still auditable,
          // marked as the repair it is.
          if (keyNewlyRevoked) {
            this.recordProvisioningAudit(ctx.actor, "agent_revoked", { target: agent, reason, repair: true });
          }
          return true;
        }
        // Preserve an earlier deactivation time: when deactivate_actor ran
        // first, THAT is when the identity stopped authenticating. `retired_at`
        // separately records when the slot came back.
        if (this.propOrNullLive(agent, "deactivated_at") == null) this.setProp(agent, "deactivated_at", now);
        this.setProp(agent, "retired_at", now);
        this.setProp(account, "agent_count", Math.max(0, Number(this.propOrNullLive(account, "agent_count") ?? 0) - 1));
        // AU1 seam, not recordWizardAction: every durable effect above is
        // cluster-resident (agent lineage, agent props, account counter, the
        // actor-owned api-key record), but `$system` is catalog-scoped on Net,
        // so appending wizard_actions made the whole revocation fail
        // E_CATALOG_MUTATION — leaving account owners with no way to retire an
        // agent at all. Local profiles still materialize the entry.
        this.recordProvisioningAudit(ctx.actor, "agent_revoked", { target: agent, reason });
        return true;
      });
      this.nativeHandlers.set("human_promote_agent_to_programmer", async (ctx, args) => {
        this.assertSelfHuman(ctx.actor, ctx.thisObj);
        const agent = assertObj(args[0]);
        const account = this.assertOwnedAgent(ctx.thisObj, agent);
        await this.setProgrammerAgentState(ctx.actor, agent, account, true, "agent_promoted_to_programmer");
        return true;
      });
      this.nativeHandlers.set("human_demote_agent_from_programmer", async (ctx, args) => {
        this.assertSelfHuman(ctx.actor, ctx.thisObj);
        const agent = assertObj(args[0]);
        const account = this.assertOwnedAgent(ctx.thisObj, agent);
        await this.setProgrammerAgentState(ctx.actor, agent, account, false, "agent_demoted_from_programmer");
        return true;
      });
      // AP11 operator provisioning. Defined on the human kind — and therefore invoked
      // with the HUMAN as the turn target — so the whole transition commits in
      // the human's authority cluster, where the account, the new agent, and
      // its api-key record all live. A $system-targeted verb would commit at
      // the catalog scope and could not write any of them.
      this.nativeHandlers.set("human_provision_wizard_agent", async (ctx, args) => {
        const options = args[1] && typeof args[1] === "object" && !Array.isArray(args[1])
          ? args[1] as Record<string, WooValue>
          : {};
        return await this.provisionOperatorWizardAgent(ctx.actor, ctx.thisObj, {
          provisionId: assertString(args[0] ?? ""),
          name: typeof options.name === "string" && options.name ? options.name : assertString(args[0] ?? ""),
          purpose: typeof options.purpose === "string" ? options.purpose : "",
          apiKeyId: typeof options.api_key_id === "string" && options.api_key_id ? options.api_key_id : null
        }) as unknown as WooValue;
      });
      this.nativeHandlers.set("human_rotate_agent_key", (ctx, args) => {
        this.assertSelfHuman(ctx.actor, ctx.thisObj);
        const agent = assertObj(args[0]);
        const key = this.rotateAgentKey(ctx.thisObj, agent, args[1] === true);
        return { actor_id: agent, api_key: `apikey:${key.id}:${key.secret}`, mcp_url: this.propOrNullLive("$system", "mcp_endpoint_url") ?? "/mcp" } as unknown as WooValue;
      });
      this.nativeHandlers.set("feature_can_be_attached_by", (ctx, args) => {
      const actor = assertObj(args[0] ?? ctx.actor);
      return actor === this.objectLive(ctx.thisObj).owner;
    });
    this.nativeHandlers.set("thing_moveto", async (ctx, args) => {
      const target = assertObj(args[0] ?? "$nowhere");
      return await this.movetoChecked(ctx, ctx.thisObj, target);
    });
    this.nativeHandlers.set("add_feature", (ctx, args) => this.addFeature(ctx.thisObj, assertObj(args[0]), ctx.actor, ctx.observations));
    this.nativeHandlers.set("remove_feature", (ctx, args) => this.removeFeature(ctx.thisObj, assertObj(args[0]), ctx.actor, ctx.observations));
    this.nativeHandlers.set("has_feature", (ctx, args) => this.featureList(ctx.thisObj).includes(assertObj(args[0])));
    this.nativeHandlers.set("replay", (ctx, args) => {
      const from = Number(args[0] ?? 1);
      const limit = Number(args[1] ?? REPLAY_PAGE_DEFAULT_LIMIT);
      // SL2/SL8: `from < 1` or `limit` outside 1..1000 is E_RANGE. The
      // bounds also normalize the net replay-page query, so the page a
      // sparse plan attests and the page the authority re-derives at
      // commit describe the same exact window.
      if (!validReplayPageBounds(from, limit)) {
        throw wooError("E_RANGE", "replay requires from >= 1 and limit in 1..1000", {
          from: (args[0] ?? null) as WooValue,
          limit: (args[1] ?? null) as WooValue
        } as unknown as WooValue);
      }
      return this.replayPageForVm(ctx.thisObj, from, limit).map((entry) => ({
        seq: entry.seq,
        // The entry's committed wall-clock time was always persisted
        // (SpaceLogEntry.ts) but omitted here; acts-kernel projections
        // resolve row timestamps from it at view time, so expose it.
        ts: entry.ts,
        message: entry.message as unknown as WooValue,
        observations: entry.observations as unknown as WooValue,
        applied_ok: entry.applied_ok,
        error: entry.error as unknown as WooValue
      }));
    });
    // $actor:focus/unfocus/focus_list mutate the actor's focus_list property.
    // These are registered here (not in McpHost) so that they remain available
    // when the actor's home DO wakes from hibernation via /__internal/remote-
    // dispatch — that path does not construct an McpHost, so handlers installed
    // by McpHost's constructor would not be present on the fresh world.
    this.nativeHandlers.set("actor_focus", (ctx, args) => {
      const target = String(args[0] ?? "");
      if (!target) throw wooError("E_INVARG", `focus target not found: ${target}`);
      if (!this.objects.has(target)) throw wooError("E_OBJNF", `focus target not found: ${target}`, target);
      const actor = ctx.thisObj;
      if (target !== actor && this.inheritsFrom(target, "$actor") && !this.inheritsFrom(target, "$block")) {
        throw wooError("E_PERM", `cannot focus another actor: ${target}`);
      }
      if (!this.canReadProperty(actor, target, "name")) {
        throw wooError("E_PERM", `focus target not visible: ${target}`);
      }
      const list = this.focusListOf(actor);
      if (!list.includes(target)) {
        list.push(target);
        while (list.length > ACTOR_FOCUS_LIST_CAP) list.shift();
        this.setProp(actor, "focus_list", list);
      }
      return list as unknown as WooValue;
    });
    this.nativeHandlers.set("actor_unfocus", (ctx, args) => {
      const target = String(args[0] ?? "");
      const actor = ctx.thisObj;
      const list = this.focusListOf(actor).filter((id) => id !== target);
      this.setProp(actor, "focus_list", list);
      return list as unknown as WooValue;
    });
    this.nativeHandlers.set("actor_focus_list", (ctx) => this.focusListOf(ctx.thisObj) as unknown as WooValue);
    // $actor:wait normally short-circuits in McpHost.invokeTool (drainWait) so
    // this native rarely runs. It exists for non-MCP callers (e.g. woocode
    // dispatching $actor:wait directly) — they have no session queue, so the
    // correct behavior is an empty drain rather than a missing-handler error.
    this.nativeHandlers.set("actor_wait", () => ({
      observations: [] as unknown as WooValue,
      more: false,
      queue_depth: 0
    } as unknown as WooValue));
    this.nativeHandlers.set("catalog_registry_install", (ctx, args) => {
      if (!this.objectLive(ctx.actor).flags.wizard) throw wooError("E_PERM", "only wizards may install catalogs", ctx.actor);
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
      if (!this.objectLive(ctx.actor).flags.wizard) throw wooError("E_PERM", "only wizards may update catalogs", ctx.actor);
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
    // catalog_registry_list is now a compiled sourceVerb (bootstrap.ts) —
    // `verb :list() rxd { return this.installed_catalogs; }` — so it carries
    // verb_bytecode and rides the net path; no native handler is needed.
    this.nativeHandlers.set("catalog_registry_migration_state", (_ctx, args) => {
      const alias = assertString(args[0] ?? "");
      const records = this.propOrNullLive("$catalog_registry", "installed_catalogs");
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
          return resolved ? {
            name: resolved.name,
            definer: null,
            direct_callable: resolved.direct_callable,
            skip_presence_check: resolved.skip_presence_check === true,
            arg_spec: resolved.arg_spec ?? {}
          } : this.matchSentinelRef("failed");
        }
        const { definer, verb } = this.resolveVerbLive(target, name);
        return {
          name: verb.name,
          definer,
          direct_callable: verb.direct_callable === true,
          skip_presence_check: verb.skip_presence_check === true,
          arg_spec: verb.arg_spec ?? {}
        };
      } catch (err) {
        const error = normalizeError(err);
        if (error.code !== "E_VERBNF" && !isReadAvailabilityError(error)) throw err;
        return this.matchSentinelRef("failed");
      }
    });
    this.nativeHandlers.set("match_command_verb", async (ctx, args) => {
      const cmd = commandMapFromValue(args[0]);
      const target = assertObj(args[1]);
      if (!await this.canSeeCommandObject(ctx, target)) throw wooError("E_PERM", `${ctx.actor} cannot match command verbs on ${target}`, { actor: ctx.actor, target });
      const matched = await this.matchCommandVerbOnTarget(ctx, cmd, target);
      return matched ? matched as unknown as WooValue : this.matchSentinelRef("failed");
    });
    this.nativeHandlers.set("plan_command", async (ctx, args) => {
      const space = assertObj(args[1] ?? ctx.caller);
      return await this.planCommandForSpace(ctx, assertString(args[0] ?? ""), space, {
        // Catalog command-plan wrappers are read-only planners. When the
        // wrapper explicitly opts out of presence checks, let it plan against
        // the supplied command space without teaching the browser about catalog
        // command aliases.
        skipPresenceCheck: this.currentVerbSkipsPresenceCheck(ctx)
      }) as unknown as WooValue;
    });
    this.nativeHandlers.set("parse_command", async (ctx, args) => {
      const actor = await this.publicCommandActor(ctx, args[1]);
      const location = await this.publicCommandLocation(ctx, actor, args[2]);
      return await this.parseCommandMap(assertString(args[0] ?? ""), ctx, location, actor) as unknown as WooValue;
    });
    this.nativeHandlers.set("space_live_audience", (ctx, args) => this.spaceLiveAudience(ctx, args));
    this.nativeHandlers.set("help_db_find_topics", (ctx, args) => this.helpDbFindTopics(ctx, args));
    this.nativeHandlers.set("help_db_get_topic", (ctx, args) => this.helpDbGetTopic(ctx, args));
    this.nativeHandlers.set("help_db_dump_topic", (ctx, args) => this.helpDbDumpTopic(ctx, args));
  }

  private chatPresent(room: ObjRef): ObjRef[] {
    return this.contentsOf(room).filter((item) => this.objects.has(item) && this.inheritsFrom(item, "$player"));
  }

  private async chatPresentAsync(room: ObjRef, progr: ObjRef, memo?: HostOperationMemo): Promise<ObjRef[]> {
    void progr;
    const contents = await this.objectContents(room, memo);
    const actors: ObjRef[] = [];
    for (const item of contents) {
      try {
        if (await this.isDescendantOfCheckedOrFalse(item, "$player", memo)) actors.push(item);
      } catch {
        // A stale content ref should not break room presentation.
      }
    }
    return actors;
  }

  private async scrubStaleSubscribersForSpace(space: ObjRef, memo?: HostOperationMemo): Promise<ObjRef[]> {
    if (!this.objects.has(space)) return [];
    // Scrub the authoritative live-presence projection, not physical room
    // contents. A disconnected actor can remain in `subscribers` while its
    // reusable player object sits at $nowhere; using chatPresent(space) as the
    // input skipped exactly those stale rows and made the throttle rollback
    // fix appear ineffective on immediate retry.
    const rawSubscribers = this.propOrNullLive(space, "subscribers");
    const subscribers = Array.isArray(rawSubscribers)
      ? rawSubscribers.filter((value): value is ObjRef => typeof value === "string")
      : [];
    // Subscriber rows are live-presence maintenance, not user-turn semantics.
    // Shadow/local execution records only VM-authorized effects; letting a
    // browser-planned turn carry gateway cleanup writes would require granting
    // hidden system authority to an otherwise ordinary verb transcript.
    if (this.turnRecorder || this.activeTurnRecorder) return subscribers;
    const now = Date.now();
    const last = this.lastSubscriberScrubAt.get(space) ?? 0;
    if (now - last < SUBSCRIBER_SCRUB_FLOOR_MS) return subscribers;
    const behavior = this.behaviorUndoScopes.at(-1);
    if (behavior && !behavior.subscriberScrubAt.has(space)) {
      behavior.subscriberScrubAt.set(space, this.lastSubscriberScrubAt.get(space));
    }
    this.lastSubscriberScrubAt.set(space, now);
    let survivingActors = subscribers;
    if (subscribers.length > 0) {
      const rawSessionSubscribers = this.propOrNullLive(space, "session_subscribers");
      const rowsByActor = new Map<ObjRef, Array<{ session: string; actor: ObjRef }>>();
      if (Array.isArray(rawSessionSubscribers)) {
        for (const entry of rawSessionSubscribers) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
          const map = entry as Record<string, WooValue>;
          if (typeof map.session !== "string" || typeof map.actor !== "string") continue;
          const rows = rowsByActor.get(map.actor) ?? [];
          rows.push({ session: map.session, actor: map.actor });
          rowsByActor.set(map.actor, rows);
        }
      }
      const remoteActorsSet = new Set<ObjRef>();
      for (const actor of subscribers) {
        if (rowsByActor.has(actor)) continue;
        if (await this.remoteHostForObject(actor, memo)) remoteActorsSet.add(actor);
      }
      const remoteLocationsByActor = await this.fetchRemoteSessionLocations(
        Array.from(remoteActorsSet),
        memo
      );
      const kept: ObjRef[] = [];
      const stale: ObjRef[] = [];
      for (const actor of subscribers) {
        const rows = rowsByActor.get(actor);
        if (rows && rows.length > 0) {
          let hasKnownLiveSession = false;
          let hasUnknownRemoteSession = false;
          const actorRemote = await this.remoteHostForObject(actor, memo);
          for (const row of rows) {
            if (row.session.startsWith("legacy:")) {
              hasKnownLiveSession = true;
              break;
            }
            const session = this.sessions.get(row.session);
            if (session && !this.sessionExpired(session, now)) {
              hasKnownLiveSession = true;
              break;
            }
            if (!session && actorRemote) hasUnknownRemoteSession = true;
          }
          if (hasKnownLiveSession) kept.push(actor);
          else if (hasUnknownRemoteSession) {
            // A remote actor with only missing session rows is excluded from
            // this read but left persisted. The owning host may still have the
            // session; dropping the row here would race cross-host setup.
          }
          else stale.push(actor);
          continue;
        }
        // A remote actor whose home host failed to answer (read-availability
        // error) is left in `subscribers` and excluded from this read's
        // survivingActors view, mirroring the per-actor path's behavior
        // under the same error class. Without this guard a transient remote
        // blip would mark the actor stale and persist a subscriber-row drop.
        if (remoteActorsSet.has(actor) && !remoteLocationsByActor.has(actor)) continue;
        // Legacy subscriber rows have no session attribution. For those rows
        // only, fall back to active-scope probing so old worlds can still shed
        // dead live-presence mirrors. Session-attributed rows above are a real
        // many-spaces subscription relation and must not be collapsed to the
        // actor's active_scope.
        const localLocations = this.liveSessionLocationsForActor(actor);
        const remoteLocations = remoteLocationsByActor.get(actor) ?? [];
        const locations = remoteActorsSet.has(actor)
          ? Array.from(new Set([...localLocations, ...remoteLocations]))
          : localLocations;
        if (locations.includes(space)) kept.push(actor);
        else stale.push(actor);
      }
      // Drop *all* session_subscribers rows for each stale actor, not just
      // the one matching the actor's current `presenceSessionId`. The orphan
      // case we want to clean up is precisely a row pointing at a session
      // that's gone from this DO's table — `presenceSessionId` then resolves
      // to `legacy:<actor>` and never matches the orphan row, leaving it
      // pinned. Iterate the actor's rows directly so every orphan goes.
      for (const actor of stale) this.dropAllSubscriberRowsForActor(space, actor);
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
   * Resolve `activeScope` for each actor whose home host is not this DO,
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
    if (remoteActors.length === 0 || !this.executorContext) return out;
    if (this.executorContext.actorSessionLocationsBatch) {
      try {
        return await this.executorContext.actorSessionLocationsBatch(remoteActors, memo);
      } catch (err) {
        if (!isReadAvailabilityError(err)) throw err;
        return out;
      }
    }
    await Promise.all(remoteActors.map(async (actor) => {
      try {
        const locations = await this.executorContext?.actorSessionLocations?.(actor, memo) ?? [];
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
    const raw = this.propOrNullLive(space, "session_subscribers");
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

  private async objectContents(objRef: ObjRef, memo?: HostOperationMemo, surface: "contents" | "match" | "visible_contents" = "contents"): Promise<ObjRef[]> {
    this.assertResolutionContentsOwnerAuthority(objRef, surface);
    if (await this.remoteHostForObject(objRef, memo)) {
      if (!this.executorContext) throw wooError("E_INTERNAL", "remote host bridge unavailable");
      const effect = this.effects.remoteBridgeUntrackedEffect("contents", { object: objRef });
      this.recordUntrackedEffect(effect.name, effect.detail);
      return await this.executorContext.contents(objRef, memo);
    }
    return this.contentsOf(objRef);
  }

  async contentsForExecution(ctx: CallContext, objRef: ObjRef): Promise<ObjRef[]> {
    return await this.objectContents(objRef, ctx.hostMemo);
  }

  private async propOrNullForActorAsync(actor: ObjRef, objRef: ObjRef, name: string, memo?: HostOperationMemo): Promise<WooValue> {
    try {
      return await this.getPropChecked(actor, objRef, name, memo);
    } catch (err) {
      if (!isOptionalProjectionReadError(err)) throw err;
      return null;
    }
  }

  private isActorForLook(item: ObjRef, present: ObjRef[]): boolean {
    if (present.includes(item)) return true;
    return this.objects.has(item) && this.inheritsFrom(item, "$player");
  }

  private async objectSummaryForLook(ctx: CallContext, item: ObjRef): Promise<HostObjectSummary | null> {
    if (!await this.remoteHostForObject(item, ctx.hostMemo)) return null;
    if (!this.executorContext?.describeObject) return null;
    try {
      return await this.executorContext.describeObject(ctx.progr, ctx.actor, item, ctx.hostMemo);
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
    if (remoteIds.length === 0 || !this.executorContext) return { summaries, remoteCount: 0, batchCount: 0 };
    if (this.executorContext.describeObjects) {
      try {
        const batch = await this.executorContext.describeObjects(ctx.progr, ctx.actor, remoteIds, ctx.hostMemo);
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

  async presentActorsIn(ctx: CallContext, space: ObjRef): Promise<ObjRef[]> {
    const actors = new Set<ObjRef>();
    const now = Date.now();
    // CA8: the session table is the authoritative live placement source. The
    // session_subscribers property below is a derived projection used for
    // cross-host materialization and back-compat, so catalog roster reads must not
    // disappear when a sparse planning snapshot has the session row but not yet
    // the derived presence cell.
    for (const sessionId of this.sessionIdsInActiveScope(space)) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      if (!this.sessionIsLive(session, now)) continue;
      if (!this.objects.has(session.actor)) continue;
      actors.add(session.actor);
    }
    const sessions = this.presenceSessionsIn(space);
    if (sessions) {
      for (const [sessionId, actor] of sessions) {
        const session = this.sessions.get(sessionId);
        if (session) {
          if (session.actor !== actor || !this.sessionIsLive(session, now)) continue;
        } else if (!sessionId.startsWith("legacy:")) {
          // Missing local session rows are stale for local actors and must not
          // surface a non-live, non-dereferenceable roster entry. A missing row
          // for a remote actor can be legitimate because this room host may only
          // hold the projected presence cell; keep trusting that projection when
          // the actor object is materialized locally as a remote/cache row.
          const actorRemote = await this.remoteHostForObject(actor, ctx.hostMemo).catch((err) => {
            if (!isReadAvailabilityError(err)) throw err;
            return null;
          });
          if (!actorRemote) continue;
        }
        // Remote session rows are intentionally projected into the space owner so
        // catalog code can model presence from the room itself. If this host does
        // not own the session row, trust the projection; stale remote rows are
        // scrubbed by the subscriber scrub paths rather than hidden from every
        // cross-host room read.
        // A projected presence row is only useful when the actor object is in
        // the same planning snapshot. Older CommitScopeDO snapshots can contain
        // dangling session rows; do not surface those refs to catalog code.
        if (!this.objects.has(actor)) continue;
        actors.add(actor);
      }
    }
    return Array.from(actors).sort();
  }

  activeActorsIn(space: ObjRef): ObjRef[] {
    return this.activeActorRosterStateIn(space, Date.now()).actors;
  }

  async visibleContentsForActor(ctx: CallContext, objRef: ObjRef): Promise<ObjRef[]> {
    const items = await this.objectContents(objRef, ctx.hostMemo, "visible_contents");
    const out: ObjRef[] = [];
    for (const item of items) {
      if (await this.remoteHostForObject(item, ctx.hostMemo)) {
        out.push(item);
        continue;
      }
      if (!this.objects.has(item)) continue;
      if (this.canReadProperty(ctx.progr, item, "name") || this.canReadProperty(ctx.progr, item, "description")) out.push(item);
    }
    return out;
  }

  /**
   * Classes whose command verbs are "obvious plumbing" and are hidden from
   * examine/command listings. The substrate base classes ($root, $player) are
   * always dull — they are bootstrap seeds core may name. *Catalog* classes
   * ($room, $builder, ...) contribute themselves through
   * $system.dull_command_definers, so core never branches on a catalog class
   * identity (AGENTS.md layering). Both obvious-verb projections filter through
   * this.
   */
  private dullCommandDefiners(): Set<ObjRef> {
    const dull = new Set<ObjRef>(["$root", "$player"]);
    const raw = this.propOrNullLive("$system", "dull_command_definers");
    if (Array.isArray(raw)) for (const item of raw) if (typeof item === "string") dull.add(item);
    return dull;
  }

  obviousVerbSpecsForActor(actor: ObjRef, target: ObjRef): WooValue[] {
    const out: WooValue[] = [];
    const seen = new Set<string>();
    const dull = this.dullCommandDefiners();
    for (const definer of this.localAncestry(target)) {
      if (dull.has(definer)) continue;
      for (const verb of this.objectLive(definer).verbs) {
        if (!this.canReadVerb(actor, verb)) continue;
        const command = verb.arg_spec && typeof verb.arg_spec === "object" && !Array.isArray(verb.arg_spec)
          ? (verb.arg_spec.command as WooValue | undefined)
          : undefined;
        if (!command || typeof command !== "object" || Array.isArray(command)) continue;
        const key = `${definer}:${verb.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          definer,
          name: verb.name,
          aliases: [...(verb.aliases ?? [])],
          perms: verb.perms,
          command: cloneValue(command)
        } as unknown as WooValue);
      }
    }
    return out;
  }

  async remoteDescribeForActor(ctx: CallContext, target: WooValue): Promise<WooValue> {
    if (Array.isArray(target)) {
      const ids = target.filter((item): item is ObjRef => typeof item === "string");
      const { summaries } = await this.objectSummariesForLook(ctx, ids);
      // Object-id keys again — same rule as scopedObjectSummaries above.
      const out: Record<string, WooValue> = dataKeyedMap();
      for (const [id, summary] of summaries) out[id] = summary as unknown as WooValue;
      return out as unknown as WooValue;
    }
    if (typeof target !== "string") throw wooError("E_TYPE", "remote_describe expects an object or list of objects", target);
    if (!await this.remoteHostForObject(target, ctx.hostMemo)) return null;
    if (!this.executorContext?.describeObject) return null;
    try {
      return await this.executorContext.describeObject(ctx.progr, ctx.actor, target, ctx.hostMemo) as unknown as WooValue;
    } catch (err) {
      if (!isReadAvailabilityError(err)) throw err;
      return null;
    }
  }

  private async spaceLiveAudience(ctx: CallContext, args: WooValue[]): Promise<WooValue> {
    const raw = args[0];
    if (raw === undefined || raw === null) {
      return this.liveSessionIdsIn(ctx.thisObj) as unknown as WooValue;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) throw wooError("E_INVARG", "live_audience observation must be a map", raw);
    const observation = raw as Observation;
    return (await this.observationAudienceSessions(ctx.thisObj, observation) ?? []) as unknown as WooValue;
  }

  private liveSessionIdsIn(space: ObjRef): string[] {
    const sessions = this.presenceSessionsIn(space);
    if (!sessions) return [];
    const out: string[] = [];
    const now = Date.now();
    for (const [sessionId, actor] of sessions) {
      const session = this.sessions.get(sessionId);
      if (!session || session.actor !== actor || !this.sessionIsLive(session, now)) continue;
      out.push(sessionId);
    }
    return out.sort();
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
    const now = this.logicalNow("player_join.now");
    if (old && old !== dest && old !== "$nowhere") {
      ctx.observe({ type: "left", source: old, actor: ctx.actor, room: old, destination: dest, text: `${this.objectLive(ctx.actor).name} leaves.`, ts: now });
    }
    ctx.observe({ type: "entered", source: dest, actor: ctx.actor, room: dest, origin: old, text: `${this.objectLive(ctx.actor).name} arrives.`, ts: now });
    return { room: dest, from: old, target, here_request: true, look_deferred: true } as unknown as WooValue;
  }


  private playerSessionStats(actor: ObjRef, now: number): { connected: boolean; connectedAt: number | null; connectedSeconds: number | null; idleSeconds: number | null; lastLoginAt: number | null; lastSeenAt: number | null } {
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
      lastLoginAt,
      lastSeenAt: lastInputAt
    };
  }

  sessionMetadataForActor(actor: ObjRef, now: number): WooValue {
    const stats = this.playerSessionStats(actor, now);
    return {
      connected: stats.connected,
      connected_at: stats.connectedAt,
      connected_seconds: stats.connectedSeconds,
      idle_seconds: stats.idleSeconds,
      last_login_at: stats.lastLoginAt,
      last_seen_at: stats.lastSeenAt
    } as unknown as WooValue;
  }

  private matchPlayerForCommand(input: string): ObjRef | null {
    const wanted = input.trim();
    if (!wanted) return null;
    // Big-World: no global object enumeration. @join resolves only an
    // explicit, valid $player object reference — a fuzzy name→player lookup
    // would require a global scan of every object (or a cross-shard name
    // directory that does not exist), which returns a per-shard partial view
    // under sharding. Address the player by ref; joining a co-present player
    // by name is redundant (they are already in the room). See
    // spec/operations/net-cutover.md presence semantics.
    if (this.objects.has(wanted) && this.inheritsFrom(wanted, "$player")) return wanted;
    return null;
  }

  obviousCommandVerbs(target: ObjRef, options: { actor?: ObjRef; executableOnly?: boolean } = {}): VerbDef[] {
    const dullClasses = this.dullCommandDefiners();
    const out: VerbDef[] = [];
    const seen = new Set<string>();
    for (const definer of this.localAncestry(target)) {
      if (dullClasses.has(definer)) continue;
      for (const verb of this.objectLive(definer).verbs) {
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
      return this.objects.has(item) ? this.objectLive(item).name : item;
    }
  }

  // Cross-host-aware display name. The local stub of a remote object
  // (created by ensureInternalActor on cross-host /__internal/remote-dispatch)
  // carries `name = id` rather than the authoritative display name, so always
  // RPC to the owning host when the object is remote — even when a stub happens
  // to be present locally.
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
    if (this.objects.has(objRef)) return this.objectLive(objRef).name || objRef;
    return objRef;
  }

  private tryResolveVerb(target: ObjRef, verb: string): ResolvedVerb | null {
    try {
      return this.resolveVerbLive(target, verb);
    } catch {
      return null;
    }
  }

  private async tryResolveVerbForCommand(ctx: CallContext, target: ObjRef, verb: string): Promise<CommandVerbSummary | null> {
    if (await this.remoteHostForObject(target, ctx.hostMemo)) {
      if (!this.executorContext?.resolveVerb) return null;
      try {
        return await this.executorContext.resolveVerb(target, verb, ctx.hostMemo);
      } catch (err) {
        const error = normalizeError(err);
        if (error.code !== "E_VERBNF" && !isReadAvailabilityError(error)) throw err;
        return null;
      }
    }
    const resolved = this.tryResolveVerb(target, verb);
    return resolved ? {
      name: resolved.verb.name,
      definer: resolved.definer,
      direct_callable: resolved.verb.direct_callable === true,
      skip_presence_check: resolved.verb.skip_presence_check === true,
      arg_spec: resolved.verb.arg_spec ?? {}
    } : null;
  }

  /**
   * Transitional implementation of the native plan_command primitive.
   * Command grammar belongs to catalog wrappers; scripts/guard-command-planning
   * enforces that ordinary server/client conveniences dispatch those wrappers
   * and that this helper is called only from nativeHandlers.set("plan_command").
   */
  private async planCommandForSpace(ctx: CallContext, input: string, space: ObjRef, options: PublicCommandLocationOptions = {}): Promise<WooValue> {
    const text = input.trim();
    if (!text) return await this.commandHuhPlan(ctx, space, input, "empty command");
    const actor = await this.publicCommandActor(ctx, undefined);
    const location = await this.publicCommandLocation(ctx, actor, space, options);
    const matchOptions: ObjectMatchOptions = { commandSurfaceOnly: true };

    const lowered = await this.lowerSpeechPrefixPlan(ctx, text, space, actor, location, matchOptions);
    if (lowered) return lowered as unknown as WooValue;

    const cmd = await this.parseCommandMap(text, ctx, location, actor, matchOptions);
    if (cmd.verb === "drop" && !cmd.argstr) return await this.commandHuhPlan(ctx, space, text, "Drop what?");
    const metadataPlan = await this.resolveCommandPlan(ctx, cmd, space, actor);
    if (metadataPlan) return metadataPlan as unknown as WooValue;

    const hookPlan = text.startsWith("/") ? await this.commandHuhHookPlan(ctx, space, actor, cmd) : null;
    if (hookPlan) return hookPlan;
    return await this.commandHuhPlan(ctx, space, text, "I don't understand that.");
  }

  private async lowerSpeechPrefixPlan(ctx: CallContext, text: string, space: ObjRef, actor: ObjRef, location: ObjRef | null, matchOptions: ObjectMatchOptions = {}): Promise<CommandPlan | WooValue | null> {
    const lower = text.toLowerCase();
    const parsed = new Map<string, Promise<CommandMap>>();
    const parse = async (normalized: string) => {
      const existing = parsed.get(normalized);
      if (existing) return await existing;
      const next = this.parseCommandMap(normalized, ctx, location, actor, matchOptions);
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
    if (text.startsWith(";;") && text.length > 2) {
      const body = text.slice(2).trim();
      if (!body) return null;
      const cmd = await parse(`eval ${body}`);
      return await this.commandPlanForResolved(ctx, space, actor, "eval", [body, { mode: "stmts" }], cmd);
    }
    if (text.startsWith(";") && text.length > 1) {
      const body = text.slice(1).trim();
      if (!body) return null;
      const cmd = await parse(`eval ${body}`);
      return await this.commandPlanForResolved(ctx, space, actor, "eval", [body], cmd);
    }
    if (text.startsWith("`") && text.length > 1) {
      return await this.directedSpeechPlan(ctx, space, "say_to", text.slice(1), text, actor, location, matchOptions);
    }
    if (lower.startsWith("/tell ")) {
      return await this.directedSpeechPlan(ctx, space, "tell", text.slice(6), text, actor, location, matchOptions);
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

  private async directedSpeechPlan(ctx: CallContext, space: ObjRef, verbName: string, rest: string, original: string, actor: ObjRef, location: ObjRef | null, matchOptions: ObjectMatchOptions = {}): Promise<CommandPlan | WooValue> {
    const normalized = `${verbName} ${rest.trim()}`;
    const cmd = await this.parseCommandMap(normalized, ctx, location, actor, matchOptions);
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
      if (this.commandPatternTreatsTargetAsArgument(pattern, cmd, target)) continue;
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

  private commandPatternTreatsTargetAsArgument(pattern: CommandPattern, cmd: CommandMap, target: ObjRef): boolean {
    // If the direct object is the target currently being searched, a pattern
    // that passes that same object as an argument would make a containing-space
    // dispatcher look like a target-owned command. For example, a mounted
    // space that carries `$transparent` inherits `$conversational:look_at(obj)`;
    // `look outline` must continue searching so the command room's look_at
    // handles the object. Real target-owned object commands either use
    // `dobj: "this"` or consume another slot, e.g. `@describe me as ...`
    // targets `me` but passes only the iobj text to set_description.
    const directObject = cmd.dobj_prefix ?? cmd.dobj;
    if (!directObject || directObject !== target) return false;
    if (pattern.dobj !== "object") return false;
    const argsFrom = Array.isArray(pattern.args_from) ? pattern.args_from.map((item) => String(item)) : [];
    return argsFrom.includes("dobj") || argsFrom.includes("dobj_prefix");
  }

  private async commandVerbCandidates(ctx: CallContext, target: ObjRef, name: string): Promise<CommandVerbSummary[]> {
    if (await this.remoteHostForObject(target, ctx.hostMemo)) {
      if (this.executorContext?.commandVerbCandidates) {
        try {
          return await this.executorContext.commandVerbCandidates(target, name, ctx.hostMemo);
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
      if (!start) return;
      let current: ObjRef | null = start;
      while (current) {
        const obj: WooObject | null = current === start ? this.objectLive(current) : this.parentWalkLookup(start, current);
        if (!obj) break;
        for (const verb of obj.verbs) {
          if (!verbNameMatches(verb, name)) continue;
          const key = `${current}:${verb.slot ?? verb.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            name: verb.name,
            definer: current,
            direct_callable: verb.direct_callable === true,
            skip_presence_check: verb.skip_presence_check === true,
            arg_spec: verb.arg_spec ?? {}
          });
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
    if (token === "dobj") return cmd.dobj ?? this.matchSentinelRef("failed") ?? "$failed_match";
    if (token === "dobjstr") return cmd.dobjstr;
    if (token === "dobj_prefix") return cmd.dobj_prefix ?? this.matchSentinelRef("failed") ?? "$failed_match";
    if (token === "dobj_prefix_rest") return cmd.dobj_prefix_rest;
    if (token === "iobj") return cmd.iobj ?? this.matchSentinelRef("failed") ?? "$failed_match";
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
    const routeHint = commandRouteHint(resolved?.arg_spec);
    let route: "direct" | "sequenced" = routeHint ?? (directCallable ? "direct" : "sequenced");
    let space: ObjRef | null = null;
    if (route === "sequenced") {
      space = await this.isDescendantOfChecked(target, "$space", ctx.hostMemo) ? target : commandSpace;
      if (!space) throw wooError("E_NOLOCATION", "sequenced command has no command space", { target, verb: verbName });
    }
    const verb = resolved?.name ?? verbName;
    const persistence = commandPersistenceHint(resolved?.arg_spec)
      ?? (route === "direct" && await this.commandPlanRequiresDurablePresence(ctx, target, verb)
        ? "durable" as const
        : undefined);
    return {
      ok: true,
      route,
      space,
      target,
      verb,
      args,
      cmd,
      ...(persistence ? { persistence: persistence } : {})
    };
  }

  private async commandPlanRequiresDurablePresence(ctx: CallContext, target: ObjRef, verbName: string): Promise<boolean> {
    // Substrate fallback for when the matched verb's arg_spec.command has no
    // explicit `persistence` hint. Catalog manifests are the source of truth
    // for per-verb persistence (see spec/semantics/match.md), but a deployed
    // satellite slice can carry stale verb metadata when a manifest bump
    // happens after the satellite's last bootstrap-style migration ID — the
    // class-verb reconcile is now self-healing on cold-load (see
    // local-catalogs.ts) but propagation is bounded by hibernation cadence.
    // This list is the LambdaMOO-canonical movement-and-handling verb set;
    // any command-style direct call to one of these on a $space descendant
    // is treated as durable so the v2 commit fires even when the satellite's
    // arg_spec hint is missing. Catalog code can still override by setting
    // `arg_spec.command.persistence: "live"` explicitly.
    //
    // This fallback is a stale-slice net only: bundled catalogs must NOT rely
    // on it. `scripts/guard-command-planning.mjs` fails the build if any verb
    // named here is defined in the chat manifest without self-declaring
    // `arg_spec.command.persistence`, so the manifest cell — not this list — is
    // the source of truth for freshly-seeded worlds (spec/semantics/match.md
    // §MA7). Reaching this branch for a bundled verb means the guard was
    // bypassed or the deployed slice is behind its manifest.
    if (!COMMAND_PLAN_DEFAULT_DURABLE_VERBS.has(verbName)) return false;
    return await this.isDescendantOfChecked(target, "$space", ctx.hostMemo);
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

  private async parseCommandMap(text: string, ctx: CallContext, location: ObjRef | null, actor: ObjRef = ctx.actor, matchOptions: ObjectMatchOptions = {}): Promise<CommandMap> {
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
    const dobjMatch = dobjstr ? await this.matchObjectForActorAsync(dobjstr, ctx, location, actor, matchOptions) : null;
    const iobjMatch = iobjstr ? await this.matchObjectForActorAsync(iobjstr, ctx, location, actor, matchOptions) : null;
    const prefix = await this.longestObjectPrefix(restTokens, ctx, location, actor, matchOptions);
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

  private async longestObjectPrefix(tokens: ParsedToken[], ctx: CallContext, location: ObjRef | null, actor: ObjRef = ctx.actor, matchOptions: ObjectMatchOptions = {}): Promise<{ object: ObjRef; end: number; length: number } | null> {
    for (let length = tokens.length; length >= 1; length--) {
      const phrase = tokenPhrase(tokens.slice(0, length));
      const match = await this.matchObjectForActorAsync(phrase, ctx, location, actor, matchOptions);
      if (match.status === "ok") return { object: match.value, end: tokens[length - 1].end, length };
    }
    return null;
  }

  private async matchObjectForActorAsync(name: string, ctx: CallContext, location: ObjRef | null, actor: ObjRef = ctx.actor, matchOptions: ObjectMatchOptions = {}): Promise<ObjectMatch> {
    const wanted = name.trim();
    if (!wanted) return this.matchSentinel("failed");
    const lower = wanted.toLowerCase();
    if (lower === "me") return { status: "ok", value: actor };
    if (lower === "here" && location) return { status: "ok", value: location };

    // Per match.md §MA2 steps 1–2: literal id syntax resolves before any
    // candidate walk. `#xxx` is a direct objref (the lexer strips the `#`
    // for DSL literals; surface this for chat input too). `$xxx` is a
    // corename — woo stores corenames as the id itself, so the prefix is
    // the id. Either form resolves to the underlying object iff it's a
    // known id.
    if (wanted.startsWith("#") && wanted.length > 1) {
      const candidate = wanted.slice(1);
      if (this.objects.has(candidate)) return { status: "ok", value: candidate };
    }
    if (wanted.startsWith("$") && this.objects.has(wanted)) {
      return { status: "ok", value: wanted };
    }

    // Per match.md §MA2 the resolver buckets candidates by source so the
    // tiebreaker can prefer carried-by-actor over present-in-location, then
    // exact over prefix. The candidate list is also de-duplicated: if the
    // same id appears in both inventory and location (an unusual but legal
    // state), the carrying source wins.
    const candidates: Array<{ id: ObjRef; carrying: boolean }> = [];
    const seen = new Map<ObjRef, number>();
    const add = (id: unknown, carrying: boolean): void => {
      if (typeof id !== "string") return;
      const idx = seen.get(id);
      if (idx === undefined) {
        seen.set(id, candidates.length);
        candidates.push({ id, carrying });
        return;
      }
      // Promote a duplicate to carrying if a later add discovers the actor
      // is holding it.
      if (carrying && !candidates[idx].carrying) candidates[idx] = { id, carrying: true };
    };
    add(actor, false);
    if (location) {
      add(location, false);
      for (const id of await this.objectContents(location, ctx.hostMemo, "match")) add(id, false);
    }
    try {
      for (const id of await this.objectContents(actor, ctx.hostMemo, "match")) add(id, true);
    } catch (err) {
      if (!isReadAvailabilityError(err)) throw err;
      // Actor inventory is part of local matching, but a missing/stale actor stub
      // should not make room command parsing fail.
    }
    return await this.matchObjectInCandidatesAsync(ctx, wanted, candidates, matchOptions);
  }

  private async matchObjectInCandidatesAsync(
    ctx: CallContext,
    name: string,
    candidates: Array<{ id: ObjRef; carrying: boolean }> | ObjRef[],
    matchOptions: ObjectMatchOptions = {}
  ): Promise<ObjectMatch> {
    const wanted = name.trim();
    if (!wanted) return this.matchSentinel("failed");
    const lower = wanted.toLowerCase();
    // Accept both the source-tagged and the legacy bare-id call shape so
    // direct-call sites that already provide a flat list continue to work;
    // those candidates count as the location tier.
    const tagged: Array<{ id: ObjRef; carrying: boolean }> = candidates.map((c) =>
      typeof c === "string" ? { id: c, carrying: false } : c
    );
    const ids = tagged.map((c) => c.id);
    const tierOf = new Map<ObjRef, boolean>(tagged.map((c) => [c.id, c.carrying]));
    // Per match.md §MA2:
    //   Tier A: carrying & exact   (name OR alias)
    //   Tier B: location & exact
    //   Tier C: carrying & prefix
    //   Tier D: location & prefix
    //   Tier E: carrying & body   (substring — woo extension)
    //   Tier F: location & body
    // Walk in order; first non-empty tier wins (1 → return; >1 → ambiguous).
    const carryingExact: ObjRef[] = [];
    const locationExact: ObjRef[] = [];
    const carryingPrefix: ObjRef[] = [];
    const locationPrefix: ObjRef[] = [];
    const carryingBody: ObjRef[] = [];
    const locationBody: ObjRef[] = [];
    const remoteSummaries = await this.objectSummariesForLook(ctx, ids);
    // Per-candidate name/alias enrichment is independent — fan it out in
    // parallel. With ~10 candidates and per-candidate verb dispatches
    // (titleForLook, $note text), the serial form was the dominant cost of
    // an unhandled chat utterance like "well this is fun".
    const enriched = await Promise.all(ids.map((id) => this.enrichMatchCandidate(ctx, id, remoteSummaries.summaries.get(id) ?? null, matchOptions)));
    for (const { id, names, aliases } of enriched) {
      const carrying = tierOf.get(id) === true;
      const nameValues = names.filter(Boolean).map((item) => String(item).toLowerCase());
      const aliasValues = aliases.map((item) => item.toLowerCase());
      const allValues = [...nameValues, ...aliasValues];
      if (allValues.includes(lower)) {
        (carrying ? carryingExact : locationExact).push(id);
      } else if (wanted.length >= 2 && allValues.some((item) => item.startsWith(lower))) {
        (carrying ? carryingPrefix : locationPrefix).push(id);
      } else if (wanted.length >= 2 && allValues.some((item) => item.includes(lower))) {
        (carrying ? carryingBody : locationBody).push(id);
      }
    }
    if (carryingExact.length > 0) return this.resolveObjectMatch(carryingExact);
    if (locationExact.length > 0) return this.resolveObjectMatch(locationExact);
    if (carryingPrefix.length > 0) return this.resolveObjectMatch(carryingPrefix);
    if (locationPrefix.length > 0) return this.resolveObjectMatch(locationPrefix);
    if (carryingBody.length > 0) return this.resolveObjectMatch(carryingBody);
    return this.resolveObjectMatch(locationBody);
  }

  private async enrichMatchCandidate(ctx: CallContext, id: ObjRef, summary: HostObjectSummary | null, matchOptions: ObjectMatchOptions = {}): Promise<{ id: ObjRef; names: string[]; aliases: string[] }> {
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
    const name = this.getPropLive(id, "name");
    if (typeof name === "string") names.push(name);
    // Command planning has a bounded syntax surface: ids, names, aliases, and
    // catalog-declared :match_names(). Generic $match:match_object retains the
    // richer presentation-title fallback for compatibility, but browser
    // command seeds must not pull arbitrary title/read state into the hot path.
    if (matchOptions.commandSurfaceOnly === true) {
      await this.addCatalogMatchNames(ctx, id, names);
    } else {
      const [title] = await Promise.all([
        this.titleForLook(ctx, ctx.thisObj, id).catch(() => null),
        this.addCatalogMatchNames(ctx, id, names)
      ]);
      if (typeof title === "string") names.push(title);
    }
    const localAliases = this.propOrNullLive(id, "aliases");
    if (Array.isArray(localAliases)) aliases.push(...localAliases.map((item) => String(item)));
    return { id, names, aliases };
  }

  private async addCatalogMatchNames(ctx: CallContext, id: ObjRef, names: string[]): Promise<void> {
    // Hard-cap the result so a hostile or accidentally-huge :match_names()
    // can't blow up the matcher. Skip the dispatch entirely when the verb
    // isn't defined; matching runs on every unhandled chat utterance, so
    // avoiding a throw-on-miss for the common no-:match_names case matters.
    if (!this.resolveVerbFromLive(id, "match_names", false)) return;
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

  // The match sentinels ($failed_match / $ambiguous_match) are catalog
  // objects defined by the chat catalog, not substrate seeds. Core must not
  // hardcode their refs (a layering violation): it consults $system config
  // set at catalog install (chat writes `$system.failed_match_ref` /
  // `ambiguous_match_ref` via set_property seed_hooks). The well-known names
  // remain a single labelled legacy fallback for worlds installed before the
  // config was seeded. See spec/semantics/match.md §MA7.
  private matchSentinelRef(kind: "failed" | "ambiguous"): ObjRef | null {
    const prop = kind === "failed" ? "failed_match_ref" : "ambiguous_match_ref";
    const configured = this.propOrNullLive("$system", prop);
    if (typeof configured === "string" && this.objects.has(configured)) return configured;
    const legacy = kind === "failed" ? "$failed_match" : "$ambiguous_match";
    return this.objects.has(legacy) ? legacy : null;
  }

  private matchSentinel(kind: "failed" | "ambiguous"): ObjectMatch {
    return { status: kind, value: this.matchSentinelRef(kind) ?? "#-1" };
  }

  private sweepIdempotency(): void {
    const now = Date.now();
    for (const [key, entry] of this.idempotency) {
      if (now - entry.at >= 5 * 60 * 1000) this.idempotency.delete(key);
    }
    for (const [key, entry] of this.terminalTransferIdempotency) {
      if (now - entry.at >= 5 * 60 * 1000) this.terminalTransferIdempotency.delete(key);
    }
    if (this.idempotency.size > 1000) {
      const oldest = Array.from(this.idempotency.entries()).sort((a, b) => a[1].at - b[1].at);
      for (const [key] of oldest.slice(0, this.idempotency.size - 1000)) this.idempotency.delete(key);
    }
    if (this.terminalTransferIdempotency.size > 1000) {
      const oldest = Array.from(this.terminalTransferIdempotency.entries()).sort((a, b) => a[1].at - b[1].at);
      for (const [key] of oldest.slice(0, this.terminalTransferIdempotency.size - 1000)) {
        this.terminalTransferIdempotency.delete(key);
      }
    }
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
    // Sessions persisted before install_mode existed could only save an
    // OWN slot successfully (the inherited path always E_VERSIONed), so
    // "upsert" is the faithful default.
    install_mode: raw.install_mode === "define" ? "define" : "upsert",
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
    install_mode: session.install_mode,
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
  // Error values often originate in caller-owned Woo data. Frames and log
  // rows must not retain that alias: a caller mutating `value` after throw
  // would otherwise rewrite both the returned error observation and replay.
  // A native may throw any JavaScript value, including a hostile Proxy. Error
  // normalization is the containment boundary, so inspection/stringification
  // traps must become an ordinary E_INTERNAL frame rather than escaping it.
  try {
    if (isErrorValue(err)) return cloneValue(err as unknown as WooValue) as unknown as ErrorValue;
    if (err instanceof SyntaxError) return wooError("E_INVARG", err.message);
    if (err instanceof Error) return wooError("E_INTERNAL", err.message);
    return wooError("E_INTERNAL", "unknown error", String(err));
  } catch {
    return wooError("E_INTERNAL", "unknown error", "<uninspectable thrown value>");
  }
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

/** The alias-pattern rule now lives in ./verb-name-match so every surface that
 * resolves a verb without going through the dispatcher shares it verbatim. */
function verbNameMatches(verb: VerbDef, name: string): boolean {
  return verbPageAnswersTo(verb.name, verb.aliases, name);
}

function commandPattern(argSpec: Record<string, WooValue> | undefined): CommandPattern | null {
  const raw = argSpec?.command;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const pattern = raw as CommandPattern;
  return pattern.parse === false ? null : pattern;
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
    cmd: commandMapFromValue(map.cmd),
    ...(map.persistence === "durable" || map.persistence === "live" ? { persistence: map.persistence } : {})
  };
}

// Substrate fallback set for `commandPlanRequiresDurablePresence`. The
// canonical movement-and-handling verb names that mutate $space-rooted
// durable cells (actor location, room contents, presence) when they have no
// explicit `arg_spec.command.persistence` hint. Keeping this list in the
// substrate is a deliberate (small) layering compromise: catalog metadata
// remains the source of truth, but a satellite slice carrying stale verb
// shape after a manifest bump still gets the v2 commit fired here. When all
// deployed satellites have reconciled to the current manifest, this list
// becomes a redundant safety net.
const COMMAND_PLAN_DEFAULT_DURABLE_VERBS = new Set<string>([
  "enter", "leave", "out",
  "go",
  "north", "south", "east", "west",
  "northeast", "northwest", "southeast", "southwest",
  "up", "down", "in",
  "take", "drop", "give"
]);

function commandRouteHint(argSpec: Record<string, WooValue> | undefined): "direct" | "sequenced" | null {
  // Catalogs own command routing hints; the client should not learn that a
  // particular bundled surface needs a sequenced plan.
  const command = argSpec?.command;
  if (!command || typeof command !== "object" || Array.isArray(command)) return null;
  const route = (command as Record<string, WooValue>).route;
  return route === "direct" || route === "sequenced" ? route : null;
}

function commandPersistenceHint(argSpec: Record<string, WooValue> | undefined): "durable" | "live" | null {
  const command = argSpec?.command;
  if (!command || typeof command !== "object" || Array.isArray(command)) return null;
  const policy = (command as Record<string, WooValue>).persistence;
  return policy === "durable" || policy === "live" ? policy : null;
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

// Drop authoring metadata from a serialized object before host-seed delivery.
// `line_map` is the dominant verb-payload contributor and is only consumed by
// stack-trace formatting in tiny-vm.ts; the seed-merge comparison ignores it
// (bootstrap.ts:normalizeVerbForCompare). See buildHostSeedForDelivery for the
// full rationale and the degradation contract for non-bundled-catalog verbs.
function stripAuthoringMetadataFromObject(obj: SerializedObject): SerializedObject {
  const stripped = redactSensitiveSerializedPropertyValues({
    ...obj,
    verbs: obj.verbs.map((verb) => ({ ...verb, line_map: {} }))
  });
  return stripped;
}

// Stable JSON serialization for digest computation. Recursively sorts JSON
// object keys but leaves arrays in caller-supplied order — that's a separate
// concern handled by `canonicalSeedForDigest` for the host-seed path, which
// pre-sorts the arrays whose iteration order differs between mid-runtime Map
// insertion order and post-hydration SQL ORDER BY order.
function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJsonStringify).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJsonStringify((value as Record<string, unknown>)[k])).join(",") + "}";
  }
  return "null";
}

// Build a digest-only canonical view of a SeedWorld. The returned value is
// fed straight into canonicalJsonStringify; the original `seed` (the body on
// the wire) is left untouched. Per-object arrays (verbs, propertyDefs,
// properties, propertyVersions, eventSchemas, children, contents) are sorted
// by their natural key so the digest is independent of Map insertion order.
// Without this, a freshly-hydrated gateway (alphabetical SQL ORDER BY) would
// hash differently than the same world mid-runtime (insertion-order Maps),
// and the satellite digest probe would miss on every gateway eviction.
function canonicalSeedForDigest(seed: SeedWorld): unknown {
  return {
    ...seed,
    objects: seed.objects.map((obj) => ({
      ...obj,
      propertyDefs: [...obj.propertyDefs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      properties: [...obj.properties].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      propertyVersions: [...obj.propertyVersions].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      eventSchemas: [...obj.eventSchemas].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
      // Verbs are slot-ordered by both insertion and SQL hydration, but sort
      // defensively by slot in case a caller produced an unsorted list.
      verbs: [...obj.verbs].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0)),
      children: [...obj.children].sort(),
      contents: [...obj.contents].sort()
    }))
  };
}

type SerializedWorldRowStats = {
  rows: number;
  objects: number;
  properties: number;
  verbs: number;
  logs: number;
  snapshots: number;
  sessions: number;
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
  const tombstones = (world.tombstones ?? []).length;
  const META_ROWS = 3; // version + objectCounter + sessionCounter
  return {
    rows: perObjectRows + logs + snapshots + sessions + tombstones + META_ROWS,
    objects: world.objects.length,
    properties,
    verbs,
    logs,
    snapshots,
    sessions,
    tombstones
  };
}

function isPlainValueMap(value: WooValue | undefined): value is Record<string, WooValue> {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return value !== null && typeof value === "object" && typeof (value as Promise<T>).then === "function";
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

async function hashPassword(password: string, salt = randomHex(16)): Promise<{ encoded: string; salt: string }> {
  const digest = await pbkdf2Sha256Hex(password, salt, PASSWORD_PBKDF2_ITERATIONS);
  return {
    encoded: `pbkdf2-sha256:${PASSWORD_PBKDF2_ITERATIONS}:${salt}:${digest}`,
    salt
  };
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  if (!Number.isSafeInteger(iterations) || iterations < PASSWORD_PBKDF2_ITERATIONS || !salt || !expected) return false;
  const actual = await pbkdf2Sha256Hex(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}

async function pbkdf2Sha256Hex(password: string, saltHex: string, iterations: number): Promise<string> {
  const subtle = (globalThis as unknown as { crypto: { subtle: SubtleCrypto } }).crypto.subtle;
  const keyMaterial = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(saltHex).buffer as ArrayBuffer,
      iterations
    },
    keyMaterial,
    PASSWORD_PBKDF2_KEY_BITS
  );
  return bytesToHex(new Uint8Array(bits));
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw wooError("E_INVARG", "hex string must have an even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function appendQuery(base: string, params: Record<string, string>): string {
  const sep = base.includes("?") ? "&" : "?";
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `${base}${sep}${query}`;
}

const STORAGE_FLUSH_TOP_N = 5;

type BytecodeVerbDef = Extract<VerbDef, { kind: "bytecode" }>;

/**
 * Hydrate one object's verb list, PRESERVING each page's stored slot.
 *
 * This used to stamp `index + 1`, which made `slot` a property of the array
 * a node happened to be holding rather than of the verb. Under Net sparse
 * planning the array is the turn's slice, so a verb whose real slot was 3
 * hydrated as slot 1 and — because every authoring write re-serializes the
 * page it touched — that lie was committed back as authority. See
 * notes/2026-07-27-net-verb-slots.md.
 *
 * A page with no stored slot is legacy (pre-slot persistence, or a
 * hand-written fixture); those are numbered by position, which reproduces the
 * old behavior exactly for worlds that never recorded slots. Ties are broken
 * by name, matching the net bridge and the shadow page normalizer, so the
 * hydrated array is already in resolution order.
 */
function importedVerbs(verbs: readonly VerbDef[]): VerbDef[] {
  let fallback = 0;
  for (const verb of verbs) fallback = Math.max(fallback, verb.slot ?? 0);
  return verbs
    .map((verb) => cloneImportedVerb(verb, verb.slot ?? ++fallback))
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0) || a.name.localeCompare(b.name));
}

function cloneImportedVerb(verb: VerbDef, slot: number): VerbDef {
  // importWorld may hydrate directly from cached boot snapshots. Copy every
  // mutable verb cell so callers can freely edit the live world without
  // poisoning the serialized source reused by later cold boots.
  const parsedPerms = normalizeVerbPerms(verb.perms, verb.direct_callable === true);
  const common = {
    aliases: [...verb.aliases],
    arg_spec: cloneImportedRecord(verb.arg_spec),
    line_map: cloneImportedRecord(verb.line_map),
    ...(verb.calls !== undefined ? { calls: verb.calls.map((call) => ({ ...call })) } : {}),
    perms: parsedPerms.perms,
    direct_callable: parsedPerms.directCallable,
    reads_room_presence: verb.reads_room_presence === true ? true : undefined,
    reads_ordered_children: verb.reads_ordered_children === true ? true : undefined,
    slot
  };
  if (verb.kind === "bytecode") {
    return {
      ...verb,
      ...common,
      bytecode: importBytecode(verb.bytecode)
    };
  }
  return {
    ...verb,
    ...common
  };
}

// Bytecode is immutable after compilation, so the live world can share one
// deep-frozen object across imports instead of deep-copying ops+literals every
// time (the cold-load hot path: KV restore hands us deep-frozen reservoir
// bytecode). Share ONLY a value branded by our own deep-freeze (isDeeplyFrozen)
// — never trust a bare Object.isFrozen, which a caller could set by
// shallow-freezing the top while ops/literals stay mutable; sharing that would
// leak mutable state across worlds. Any other input (unfrozen, or merely
// shallow-frozen) came from arbitrary serialized state the caller may still
// hold and mutate, so clone once for isolation and deep-freeze the copy; the
// live world's bytecode is then stable and any later in-place mutation throws
// instead of corrupting a peer world. Mutable VerbDef wrapper fields (aliases,
// arg_spec, line_map, calls) are still cloned by cloneImportedVerb.
function importBytecode(bytecode: BytecodeVerbDef["bytecode"]): BytecodeVerbDef["bytecode"] {
  if (isDeeplyFrozen(bytecode)) return bytecode;
  return freezeTinyBytecode({
    ...bytecode,
    ops: bytecode.ops.map((op) => cloneImportedPlainData(op) as BytecodeVerbDef["bytecode"]["ops"][number]),
    literals: cloneImportedPlainData(bytecode.literals)
  });
}

function cloneImportedRecord(value: Record<string, WooValue>): Record<string, WooValue> {
  return cloneImportedPlainData(value);
}

function cloneImportedPlainData<T>(value: T): T {
  // Serialized worlds are JSON-shaped data. A narrow copier is much cheaper
  // than structuredClone here and still gives importWorld the by-value
  // isolation contract it needs for cached snapshots.
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key === "symbol" || !/^(0|[1-9]\d*)$/.test(key)) {
        throw new TypeError("imported Woo lists cannot contain named or symbol fields");
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        // Caller-owned getters are code, not serialized data. Never execute
        // one while crossing an authority ingress boundary.
        throw new TypeError("imported Woo lists cannot contain accessors");
      }
      if (!descriptor.enumerable) {
        throw new TypeError("imported Woo lists cannot contain non-enumerable entries");
      }
      Reflect.defineProperty(out, key, {
        value: cloneImportedPlainData(descriptor.value),
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
    return out as T;
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("imported Woo maps must have a plain or null prototype");
  }
  // Keys here are object ids, property names, and arbitrary Woo map keys —
  // all data. Copying into a plain `{}` loses a `__proto__` entry (the setter
  // swallows it), so a world could lose data simply by being imported.
  const out: Record<string, unknown> = dataKeyedMap<unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new TypeError("imported Woo maps cannot contain symbol keys");
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("imported Woo maps cannot contain accessors");
    }
    if (!descriptor.enumerable) {
      throw new TypeError("imported Woo maps cannot contain non-enumerable fields");
    }
    Reflect.defineProperty(out, key, {
      value: cloneImportedPlainData(descriptor.value),
      writable: true,
      enumerable: true,
      configurable: true
    });
  }
  return out as T;
}

function upsertProjectionRow<T>(rows: T[], predicate: (row: T) => boolean, value: T): T[] {
  const next = rows.slice();
  const index = next.findIndex(predicate);
  if (index >= 0) next[index] = value;
  else next.push(value);
  return next;
}

function sortedMap<K extends string, V>(map: Map<K, V>): Map<K, V> {
  return new Map(Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b)));
}

function addSortedSetValue(set: Set<ObjRef> | undefined, value: ObjRef): void {
  // Creates per accepted transcript are expected to be small. If this becomes
  // hot for bulk-create transcripts, batch additions by parent/location and
  // sort each affected Set once at the end.
  if (!set || set.has(value)) return;
  set.add(value);
  const sorted = Array.from(set).sort();
  set.clear();
  for (const item of sorted) set.add(item);
}

function accountRepairPatchKey(patch: AccountRepairPlan["patches"][number]): string {
  return patch.kind === "property"
    ? `property_cell:${patch.object}:${patch.name}`
    : `object_lineage:${patch.object}`;
}

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
