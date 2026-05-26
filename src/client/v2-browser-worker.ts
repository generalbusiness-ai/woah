import { decodeEnvelope, encodeEnvelope, type ShadowEnvelope } from "../core/shadow-envelope";
import type { EffectTranscript } from "../core/effect-transcript";
import type { ParkedTaskRecord, SerializedObject, SerializedSession, SerializedWorld, SpaceSnapshotRecord } from "../core/repository";
import type { ShadowStatePage } from "../core/shadow-state-pages";
import type { ShadowCommitAccepted, ShadowScopeHead } from "../core/shadow-commit-scope";
import { applyShadowScopeProjectionPatch, shadowScopeProjectionFromSerialized, shadowStateTransferCacheDigest, type ShadowExecutableStateTransferRequest, type ShadowLiveEvent, type ShadowTurnIntentRequest } from "../core/shadow-browser-node";
import type { ShadowTurnExecReply, ShadowTurnExecRequest } from "../core/shadow-turn-exec";
import type { ObjRef, SpaceLogEntry, WooValue } from "../core/types";
import type { CheckpointTailOpenTransfer, ProjectionWrite, ToolSurfaceProjectionRow } from "../core/projection-delta";
import { isShadowScopeHead } from "../core/shadow-scope-head";
import { v2BrowserCacheMutationsForEnvelope, type V2BrowserCacheMutation } from "./v2-browser-cache";
import type { V2ExecutionAdRecord } from "./v2-browser-delegation";
import { selectV2DelegatedExecutor, selectV2DelegatedScopeExecutor } from "./v2-browser-delegation";
import type { V2BrowserExecutionCheckpoint, V2ExecutableTransferRecord } from "./v2-browser-execution-cache";
import { createV2BrowserExecutionCheckpoint, createV2BrowserExecutionNodeFromTransfers } from "./v2-browser-execution-cache";
import { v2ServerAssistedIntentPolicy } from "./v2-browser-intent-policy";
import { shouldInvalidateTentativeTurnForCommitReason } from "./v2-browser-optimistic-lifecycle";
import {
  selectV2PendingTentativeTurns,
  v2BrowserTentativeTurnRecord,
  V2_BROWSER_TENTATIVE_JOURNAL_LIMIT,
  v2TentativeJournalHasCapacity,
  v2TentativeTranscriptChain,
  v2TentativeTurnForInvalidation,
  v2TentativeTurnMatches,
  type V2BrowserTentativeTurnRecord
} from "./v2-browser-journal";
import { planV2BrowserLocalTurn, type V2BrowserLocalTurnResult } from "./v2-browser-local-turn";
import { v2AppliedFrameMessageFromFrame, v2ProjectionMessageFromRow, v2TurnResultMessageFromReply } from "./v2-browser-messages";
import { v2BrowserWebSocketUrl } from "./v2-browser-url";

type V2WorkerCommand =
  | { kind: "connect"; token: string; node?: string; scope?: string; actor?: string; session?: string }
  | { kind: "disconnect" }
  | { kind: "send"; envelope: ShadowEnvelope }
  | { kind: "call"; id: string; route: "direct" | "sequenced"; scope: string; target: string; verb: string; args?: unknown[]; persistence?: "durable" | "live" }
  | { kind: "get_projection"; scope?: string }
  | { kind: "cache_status" };

type PendingEnvelope = {
  id: string;
  encoded: string;
  created_at: number;
  auth_token?: string;
  from?: string;
};

type TranscriptTailRow = {
  hash: string;
  scope: string;
  seq: number;
  accepted_seq?: number;
  transcript: EffectTranscript;
  received_at: number;
};

type V2CacheStatus = {
  connected: boolean;
  pending: number;
  projections: number;
  projection_rows: number;
  applied_frames: number;
  transcript_tail: number;
  object_pages: number;
  state_pages: number;
  execution_transfers: number;
  execution_ads: number;
  execution_checkpoints: number;
  tentative_turns: number;
  executable_scopes: string[];
  local_execution_ready?: boolean;
  last_hello?: unknown;
  catchup_required?: boolean;
};

type BrowserActivityMetric = {
  kind: "browser_activity";
  source: "v2_browser_worker";
  phase: string;
  ms: number;
  status: "ok" | "error";
  scope?: string;
  node?: string;
  actor?: string;
  route?: string;
  method?: string;
  path?: string;
  what?: string;
  reason?: string;
  count?: number;
  bytes?: number;
  records?: number;
  transfer_mode?: string;
  executable_transfer_cache?: "hit" | "miss";
  error?: string;
  error_detail?: string;
};

const DB_NAME = "woo-v2-browser";
const DB_VERSION = 8;
const META_STORE = "meta";
const PENDING_STORE = "pending";
const PROJECTION_STORE = "projections";
const PROJECTION_ROW_STORE = "projection_rows";
const APPLIED_STORE = "applied_frames";
const TRANSCRIPT_STORE = "transcript_tail";
const OBJECT_PAGE_STORE = "object_pages";
const STATE_PAGE_STORE = "state_pages";
const EXECUTION_TRANSFER_STORE = "execution_transfers";
const EXECUTION_AD_STORE = "execution_ads";
const TENTATIVE_TURN_STORE = "tentative_turns";
const EXECUTION_CHECKPOINT_STORE = "execution_checkpoints";
const V2_BROWSER_COMMITTED_TRANSCRIPT_CHECKPOINT_INTERVAL = 8;

let dbPromise: Promise<IDBDatabase> | null = null;
let socket: WebSocket | null = null;
let current: { token: string; node: string; scope: string; actor?: string; session?: string } | null = null;
let reconnectTimer: number | undefined;
let connecting = false;
let connectPromise: Promise<void> | null = null;
let connectReady: { sawDisplayState: boolean; sawExecutableState: boolean; sawAd: boolean; settle: (reason?: string) => void; timer: number } | null = null;
let connectGeneration = 0;
let reconnectDelayMs = 500;
const maxReconnectDelayMs = 10_000;
let commandQueue: Promise<void> = Promise.resolve();
let inboundFrameQueue: Promise<void> = Promise.resolve();
const pendingStateTransfers = new Map<string, { resolve: () => void; reject: (err: Error) => void; timer: number }>();
const postedAppliedFrameKeys = new Set<string>();

type V2WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<V2WorkerCommand>) => void): void;
  setTimeout(handler: () => void, timeout?: number): number;
  clearTimeout(id: number): void;
};

const workerScope = self as unknown as V2WorkerScope;

function metricNow(): number {
  return globalThis.performance?.now ? globalThis.performance.now() : Date.now();
}

function metricElapsed(startedAt: number): number {
  return Math.max(0, Math.round((metricNow() - startedAt) * 1000) / 1000);
}

function postBrowserActivity(input: Omit<BrowserActivityMetric, "kind" | "source" | "scope" | "node" | "actor"> & {
  scope?: string;
  node?: string;
  actor?: string;
}): void {
  const metric: BrowserActivityMetric = {
    kind: "browser_activity",
    source: "v2_browser_worker",
    scope: input.scope ?? current?.scope,
    node: input.node ?? current?.node,
    actor: input.actor ?? current?.actor,
    ...input
  };
  postMessage({ kind: "browser_metric", metric });
}

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

workerScope.addEventListener("message", (event: MessageEvent<V2WorkerCommand>) => {
  // Connect and call messages can arrive back-to-back during route changes.
  // Serialize command handling so a turn intent cannot run before the
  // preceding connect has installed the current actor/session authority.
  commandQueue = commandQueue
    .then(() => handleCommand(event.data))
    .catch((err: unknown) => {
      postMessage({ kind: "error", error: errorMessage(err) });
    });
});

async function handleCommand(command: V2WorkerCommand): Promise<void> {
  const startedAt = metricNow();
  let failed: unknown;
  try {
    switch (command.kind) {
      case "connect":
        await connectTo({
          token: command.token,
          node: command.node ?? await browserNodeId(),
          scope: command.scope ?? "",
          actor: command.actor,
          session: command.session
        });
        break;
      case "disconnect":
        clearReconnect();
        socket?.close();
        socket = null;
        connecting = false;
        current = null;
        rejectPendingStateTransfers(new Error("v2 browser disconnected"));
        await putMeta("connected", false);
        postStatus();
        break;
      case "send": {
        const encoded = encodeEnvelope(command.envelope);
        await putPending({
          id: command.envelope.id,
          encoded,
          created_at: Date.now(),
          auth_token: command.envelope.auth.mode === "session" ? command.envelope.auth.token : undefined,
          from: command.envelope.from
        });
        sendEncoded(encoded);
        postStatus();
        break;
      }
      case "call":
        await sendTurnIntent(command);
        break;
      case "get_projection":
        await postCachedProjection(command.scope ?? current?.scope ?? "");
        break;
      case "cache_status":
        postStatus();
        break;
    }
  } catch (err) {
    failed = err;
    throw err;
  } finally {
    postBrowserActivity({
      phase: "command",
      path: command.kind,
      ms: metricElapsed(startedAt),
      status: failed ? "error" : "ok",
      ...(failed ? { error: "E_BROWSER_WORKER_COMMAND", error_detail: errorMessage(failed) } : {})
    });
  }
}

async function connectTo(next: { token: string; node: string; scope: string; actor?: string; session?: string }): Promise<void> {
  const changed = current !== null
    && (current.token !== next.token || current.node !== next.node || current.scope !== next.scope || current.actor !== next.actor || current.session !== next.session);
  current = next;
  await postCachedProjection(current.scope);
  if (changed) {
    // A new scope needs a new WebSocket open so the relay can send a fresh
    // TransportHello and projection/catch-up transfer for that scope. Clear
    // socket first so the old connection's close/error handlers are ignored.
    clearReconnect();
    const previous = socket;
    socket = null;
    connecting = false;
    connectReady?.settle("superseded");
    postedAppliedFrameKeys.clear();
    previous?.close(1000, "v2 browser scope changed");
    await putMeta("connected", false);
  }
  // Starting a scope open must not block the worker command queue. A tab click
  // can supersede the initial chatroom open; if this command awaited the stale
  // open, the first tool action would sit behind irrelevant display/executable
  // transfers. Calls below await `connect()` for their own scope before
  // planning, preserving the first-turn executable/ad barrier where it matters.
  void connect();
}

/**
 * Opens the v2 transport for `current`.
 *
 * The returned promise resolves when the relay has delivered the display
 * catch-up, executable seed, and execution ad for this scope, or when the
 * socket errors/closes before that point. Once a socket has already reached
 * that local-execution boundary, later callers return immediately.
 */
async function connect(): Promise<void> {
  const connectStartedAt = metricNow();
  const target = current;
  if (!target) return;
  if (socket?.readyState === WebSocket.OPEN) return connectPromise ?? undefined;
  if (connecting) return connectPromise ?? undefined;
  connecting = true;
  const generation = ++connectGeneration;
  clearReconnect();
  let resolveReady: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  connectPromise = promise;
  const cacheStartedAt = metricNow();
  const cachedHead = target.scope ? await getMeta<unknown>(`head:${target.scope}`) : undefined;
  const executableSeedDigest = target.scope ? await cachedOpenExecutableSeedDigest(target.node, target.scope) : undefined;
  postBrowserActivity({
    phase: "connect_cache_probe",
    path: "connect",
    scope: target.scope,
    node: target.node,
    actor: target.actor,
    ms: metricElapsed(cacheStartedAt),
    status: "ok",
    count: executableSeedDigest ? 1 : 0,
    reason: executableSeedDigest ? "open_seed_digest" : "no_open_seed_digest"
  });
  if (generation !== connectGeneration || current !== target) {
    if (connectPromise === promise) connectPromise = null;
    resolveReady();
    return promise;
  }
  // Row count is only a local hint that a cached head has corresponding
  // projection material. The relay still validates last_known_head and can
  // ignore it, so a stale IndexedDB meta row cannot authorize catch-up.
  const hasProjectionRows = target.scope ? await projectionRowCountForScope(target.scope) > 0 : false;
  const lastKnownHead: ShadowScopeHead | undefined = isShadowScopeHead(cachedHead) && hasProjectionRows ? cachedHead : undefined;
  const wsCreateStartedAt = metricNow();
  const ws = new WebSocket(v2BrowserWebSocketUrl({
    location,
    token: target.token,
    node: target.node,
    scope: target.scope,
    last_known_head: lastKnownHead,
    executable_seed_digest: executableSeedDigest
  }), "woo-v2.turn-network.json");
  postBrowserActivity({
    phase: "websocket_create",
    path: "connect",
    scope: target.scope,
    node: target.node,
    actor: target.actor,
    ms: metricElapsed(wsCreateStartedAt),
    status: "ok",
    count: lastKnownHead ? 1 : 0,
    executable_transfer_cache: executableSeedDigest ? "hit" : "miss"
  });
  socket = ws;
  {
    // WebSocket open is not enough: the relay sends TransportHello before
    // openShadowBrowserScope subscribes this node. Resolve connect only after
    // display catch-up, executable seed state, and the scope execution ad have
    // all been installed, so the first durable turn can plan locally and repair
    // exact atoms instead of falling back to server-assisted intent planning.
    const settle = (reason = "ready") => {
      const ready = connectReady;
      if (ready?.settle === settle) {
        workerScope.clearTimeout(ready.timer);
        connectReady = null;
      }
      if (connectPromise === promise) connectPromise = null;
      postBrowserActivity({
        phase: "connect_ready_wait",
        path: "connect",
        scope: target.scope,
        node: target.node,
        actor: target.actor,
        ms: metricElapsed(connectStartedAt),
        status: reason === "ready" || reason === "superseded" ? "ok" : "error",
        reason,
        count: (ready?.sawDisplayState ? 1 : 0) + (ready?.sawExecutableState ? 1 : 0) + (ready?.sawAd ? 1 : 0)
      });
      resolveReady();
    };
    connectReady = {
      sawDisplayState: false,
      sawExecutableState: false,
      sawAd: false,
      settle,
      timer: workerScope.setTimeout(() => settle("timeout"), 5000)
    };
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      connecting = false;
      reconnectDelayMs = 500;
      void putMeta("connected", true);
      postBrowserActivity({
        phase: "websocket_open",
        path: "connect",
        scope: target.scope,
        node: target.node,
        actor: target.actor,
        ms: metricElapsed(connectStartedAt),
        status: "ok"
      });
      postStatus();
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (typeof event.data !== "string") return;
      const encoded = event.data;
      inboundFrameQueue = inboundFrameQueue
        .then(async () => {
          if (socket !== ws) return;
          await receiveFrame(encoded);
        })
        .catch((err: unknown) => {
          postMessage({ kind: "error", error: errorMessage(err) });
        });
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      connecting = false;
      rejectPendingStateTransfers(new Error("v2 browser socket closed"));
      void putMeta("connected", false);
      postStatus();
      scheduleReconnect();
      postBrowserActivity({
        phase: "websocket_close",
        path: "connect",
        scope: target.scope,
        node: target.node,
        actor: target.actor,
        ms: metricElapsed(connectStartedAt),
        status: "error",
        reason: "close"
      });
      settle("close");
    });
    ws.addEventListener("error", () => {
      if (socket !== ws) return;
      connecting = false;
      rejectPendingStateTransfers(new Error("v2 browser socket error"));
      void putMeta("connected", false);
      postStatus();
      postBrowserActivity({
        phase: "websocket_error",
        path: "connect",
        scope: target.scope,
        node: target.node,
        actor: target.actor,
        ms: metricElapsed(connectStartedAt),
        status: "error",
        reason: "error"
      });
      settle("error");
    });
  }
  return promise;
}

async function receiveFrame(encoded: string): Promise<void> {
  const frameStartedAt = metricNow();
  const frameBytes = jsonBytes(encoded);
  let envelopeType = "decode_pending";
  let mutationCount = 0;
  let failed: unknown;
  // Every frame is decoded through the transport-neutral codec before cache
  // mutation so the browser worker rejects the same malformed envelopes as the
  // relay and in-process tests.
  try {
    const decodeStartedAt = metricNow();
    const envelope = decodeEnvelope(encoded);
    envelopeType = envelope.type;
    postBrowserActivity({
      phase: "frame_decode",
      path: envelopeType,
      ms: metricElapsed(decodeStartedAt),
      status: "ok",
      bytes: frameBytes
    });
    let installedExecutableState = false;
    const receivedStateTransfer = envelope.type === "woo.state.transfer.shadow.v1";
    const receivedCheckpointTail = envelope.type === "woo.open.checkpoint_tail.v1";
    const receivedCompleteCheckpointTail = receivedCheckpointTail && checkpointTailOpenTransferIsComplete(envelope.body);
    const receivedExecutableStateTransfer = receivedStateTransfer && isExecutableStateTransfer(envelope.body);
    const receivedExecutionAd = envelope.type === "woo.exec_capability_ad.shadow.v1";
    const mutations = v2BrowserCacheMutationsForEnvelope(envelope);
    mutationCount = mutations.length;
    for (const mutation of mutations) {
      const applied = await applyCacheMutation(mutation);
      if (mutation.kind === "projection") postProjection(mutation.scope, mutation.head, mutation.projection);
      if (applied?.kind === "projection") postProjection(applied.scope, applied.head, applied.projection);
      if (applied?.kind === "applied_frame") postAppliedFrame(applied.frame, applied.transcript);
      if (mutation.kind === "object_page" || mutation.kind === "state_page" || mutation.kind === "state_pages") installedExecutableState = true;
    }
    if (envelope.type === "woo.turn.exec.reply.shadow.v1") {
      const reply = envelope.body as ShadowTurnExecReply;
      if (!(reply.ok === false && reply.reason === "missing_state")) await reconcileTentativeTurnReply(reply, envelope.reply_to);
      const message = v2TurnResultMessageFromReply(reply, envelope.reply_to);
      if (message) postMessage(message);
    }
    if (envelope.type === "woo.transport.error.v1" && envelope.reply_to) {
      await invalidateTentativeTurn(envelope.reply_to, "transport_error");
    }
    if (envelope.type === "woo.live.event.shadow.v1") {
      postMessage({ kind: "live_event", event: envelope.body as ShadowLiveEvent });
    }
    if (envelope.type === "woo.state.transfer.shadow.v1" && envelope.reply_to) {
      resolvePendingStateTransfer(envelope.reply_to);
    }
    if (installedExecutableState || receivedStateTransfer || receivedCompleteCheckpointTail) await replayPending();
    markConnectReady(
      receivedStateTransfer || receivedCompleteCheckpointTail,
      receivedExecutableStateTransfer || receivedCompleteCheckpointTail,
      receivedExecutionAd || receivedCompleteCheckpointTail,
      envelope.type === "woo.transport.error.v1"
    );
    postMessage({ kind: "frame", envelope });
    postStatus();
  } catch (err) {
    failed = err;
    throw err;
  } finally {
    postBrowserActivity({
      phase: "frame_process",
      path: envelopeType,
      ms: metricElapsed(frameStartedAt),
      status: failed ? "error" : "ok",
      count: mutationCount,
      bytes: frameBytes,
      ...(failed ? { error: "E_BROWSER_FRAME", error_detail: errorMessage(failed) } : {})
    });
  }
}

function markConnectReady(receivedDisplayState: boolean, receivedExecutableState: boolean, receivedExecutionAd: boolean, receivedTransportError: boolean): void {
  const ready = connectReady;
  if (!ready) return;
  if (receivedTransportError) {
    ready.settle("transport_error");
    return;
  }
  if (receivedDisplayState) ready.sawDisplayState = true;
  if (receivedExecutableState) ready.sawExecutableState = true;
  if (receivedExecutionAd) ready.sawAd = true;
  if (ready.sawDisplayState && ready.sawExecutableState && ready.sawAd) ready.settle("ready");
}

function isExecutableStateTransfer(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const mode = (body as { mode?: unknown }).mode;
  return mode === "closure" || mode === "object_records" || mode === "cell_pages";
}

function checkpointTailOpenTransferIsComplete(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const transfer = (body as { transfer?: unknown }).transfer;
  if (!transfer || typeof transfer !== "object" || Array.isArray(transfer)) return false;
  return !("continuation" in transfer);
}

async function replayPending(): Promise<void> {
  // Pending turn envelopes are already idempotency-keyed by (from, id), so
  // reconnect replay is a transport retry rather than a second durable action.
  // Entries from an older login are left in the cache for debugging but are not
  // sent with the new bearer token's socket.
  for (const pending of await allPending()) {
    if (!current || !pendingMatchesCurrentSession(pending)) continue;
    sendEncoded(pending.encoded);
  }
}

function pendingMatchesCurrentSession(pending: PendingEnvelope): boolean {
  if (!current) return false;
  if (pending.auth_token) return pending.auth_token === current.token;
  try {
    const envelope = decodeEnvelope(pending.encoded);
    if (envelope.auth.mode === "session") return envelope.auth.token === current.token;
    return envelope.from === current.node;
  } catch {
    return false;
  }
}

async function sendTurnIntent(command: Extract<V2WorkerCommand, { kind: "call" }>): Promise<void> {
  const startedAt = metricNow();
  let failed: unknown;
  let plannedLocally = false;
  if (!current || !current.actor) {
    postMessage({ kind: "error", error: "v2 browser call requires an authenticated actor" });
    return;
  }
  try {
    const commandScope = command.scope || current.scope;
    if (commandScope && current.scope !== commandScope) {
      await connectTo({ ...current, scope: commandScope });
    }
    const connectWaitStartedAt = metricNow();
    await connect();
    postBrowserActivity({
      phase: "turn_connect_wait",
      path: command.verb,
      route: command.route,
      scope: command.scope || current?.scope,
      ms: metricElapsed(connectWaitStartedAt),
      status: "ok"
    });
    if (!current || !current.actor) {
      postMessage({ kind: "error", error: "v2 browser call lost authenticated actor while connecting" });
      return;
    }
    if (await sendLocalTurnExec(command)) {
      plannedLocally = true;
      postStatus();
      return;
    }
    const body: ShadowTurnIntentRequest = {
      kind: "woo.turn.intent.request.shadow.v1",
      id: command.id,
      route: command.route,
      scope: command.scope || current.scope,
      target: command.target,
      verb: command.verb,
      args: Array.isArray(command.args) ? command.args as WooValue[] : [],
      persistence: command.persistence ?? (command.route === "direct" ? "live" : "durable")
    };
    const delegationStartedAt = metricNow();
    const scopeDelegation = selectV2DelegatedScopeExecutor({
      records: await allExecutionAds(),
      scope: body.scope
    });
    postBrowserActivity({
      phase: "scope_delegation_select",
      path: command.verb,
      route: command.route,
      scope: body.scope,
      ms: metricElapsed(delegationStartedAt),
      status: "ok",
      count: scopeDelegation.ok ? 1 : 0
    });
    // Bare durable intent is not a browser fallback. When local execution cannot
    // build a turn, the only durable escape hatch is a scope executor selected
    // from the execution-ad cache; that keeps the edge on explicit delegation
    // instead of drifting back to opaque server-side planning.
    const fallbackPolicy = v2ServerAssistedIntentPolicy({
      route: command.route,
      persistence: body.persistence,
      selectedScopeAd: scopeDelegation.ok ? scopeDelegation.ad.node : null
    });
    if (!fallbackPolicy.ok) {
      postTurnUnavailable(command, fallbackPolicy.reason);
      postStatus();
      return;
    }
    if (fallbackPolicy.selected_ad) {
      body.selected_ad = fallbackPolicy.selected_ad;
      postMessage({ kind: "local_turn_delegated", ...turnDiagnostic(command, body.persistence), node: fallbackPolicy.selected_ad, reason: "scope_ad" });
    }
    const envelope: ShadowEnvelope<ShadowTurnIntentRequest> = {
      v: 2,
      type: body.kind,
      id: command.id,
      from: current.node,
      actor: current.actor,
      ...(current.session ? { session: current.session } : {}),
      auth: { mode: "session", token: current.token },
      body
    };
    const encoded = encodeEnvelope(envelope);
    await putPending({
      id: envelope.id,
      encoded,
      created_at: Date.now(),
      auth_token: current.token,
      from: current.node
    });
    sendEncoded(encoded);
    postStatus();
  } catch (err) {
    failed = err;
    throw err;
  } finally {
    postBrowserActivity({
      phase: "turn_intent",
      path: command.verb,
      route: command.route,
      scope: command.scope || current?.scope,
      ms: metricElapsed(startedAt),
      status: failed ? "error" : "ok",
      reason: plannedLocally ? "local_exec" : "delegated_or_server_intent",
      ...(failed ? { error: "E_BROWSER_TURN_INTENT", error_detail: errorMessage(failed) } : {})
    });
  }
}

function postTurnUnavailable(command: Extract<V2WorkerCommand, { kind: "call" }>, reason: string): void {
  postMessage({ kind: "local_turn_fallback", ...turnDiagnostic(command), reason });
  postMessage({
    kind: "turn_result",
    frame: {
      op: "error",
      id: command.id,
      error: {
        code: "E_V2_LOCAL_EXECUTION_UNAVAILABLE",
        message: reason
      }
    }
  });
}

function turnDiagnostic(command: Extract<V2WorkerCommand, { kind: "call" }>, persistence?: "durable" | "live"): {
  id: string;
  scope: string;
  target: string;
  verb: string;
  route: "direct" | "sequenced";
  persistence: "durable" | "live";
} {
  return {
    id: command.id,
    scope: command.scope || current?.scope || "",
    target: command.target,
    verb: command.verb,
    route: command.route,
    persistence: persistence ?? command.persistence ?? (command.route === "direct" ? "live" : "durable")
  };
}

// Cold partial pages can reveal dependencies in layers: verb lookup, inherited
// properties, structural cells, then write cells. Keep the cap finite, but high
// enough that a normal first tool click does not fall back after one repair.
const maxLocalRepairAttempts = 8;

async function sendLocalTurnExec(command: Extract<V2WorkerCommand, { kind: "call" }>, repairAttempts = 0): Promise<boolean> {
  if (!current || !current.actor) return false;
  const scope = command.scope || current.scope;
  const persistence = command.persistence ?? (command.route === "direct" ? "live" : "durable");
  const cachedHead = scope ? await getMeta<unknown>(`head:${scope}`) : undefined;
  if (!isShadowScopeHead(cachedHead)) {
    postMessage({ kind: "local_turn_fallback", ...turnDiagnostic(command, persistence), reason: "no_head" });
    return false;
  }
  const selector = { scope, actor: current.actor, session: current.session ?? null };
  const tentativeRecords = selectV2PendingTentativeTurns(await allTentativeTurns(), selector);
  if (persistence === "durable" && !v2TentativeJournalHasCapacity(tentativeRecords, selector, V2_BROWSER_TENTATIVE_JOURNAL_LIMIT)) {
    postTurnUnavailable(command, "tentative_journal_full");
    postMessage({ kind: "local_turn_journal_full", ...turnDiagnostic(command, persistence), limit: V2_BROWSER_TENTATIVE_JOURNAL_LIMIT });
    return true;
  }
  let local: V2BrowserLocalTurnResult;
  let activePhase = "local_turn_execution_cache";
  let activeStartedAt = metricNow();
  try {
    const cacheStartedAt = activeStartedAt;
    const executionCache = await executionCacheForScope(scope);
    postBrowserActivity({
      phase: "local_turn_execution_cache",
      path: command.verb,
      route: command.route,
      scope,
      ms: metricElapsed(cacheStartedAt),
      status: "ok",
      records: executionCache.records.length,
      count: executionCache.cached_objects.length + executionCache.cached_pages.length + executionCache.committed_transcripts.length
    });
    activePhase = "local_turn_plan";
    activeStartedAt = metricNow();
    const planStartedAt = metricNow();
    local = await planV2BrowserLocalTurn({
      node: current.node,
      actor: current.actor,
      session: current.session ?? null,
      head: cachedHead,
      id: command.id,
      route: command.route,
      scope,
      target: command.target,
      verb: command.verb,
      args: Array.isArray(command.args) ? command.args as WooValue[] : [],
      persistence,
      transfers: executionCache.records,
      cached_objects: executionCache.cached_objects,
      cached_pages: executionCache.cached_pages,
      execution_checkpoint: executionCache.checkpoint,
      committed_transcripts: executionCache.committed_transcripts,
      tentative_transcripts: v2TentativeTranscriptChain(tentativeRecords, selector),
      onCompose: (stats) => postMessage({
        kind: "shadow_browser_compose_view",
        ...turnDiagnostic(command, persistence),
        ...stats
      })
    });
    postBrowserActivity({
      phase: "local_turn_plan",
      path: command.verb,
      route: command.route,
      scope,
      ms: metricElapsed(planStartedAt),
      status: "ok",
      reason: local.ok ? "ok" : local.reason,
      count: local.ok ? local.observation_count : (local.missing_atoms?.length ?? 0)
    });
  } catch (err) {
    // Local planning genuinely throws (e.g. a pre-recording substrate check
    // such as presence/permission fires against a stale local serialized) on
    // the cold path between scope-open and the actor's enter commit. That's a
    // safe-fallback case, not a transport fault: the verb's authoritative
    // outcome is decided server-side anyway. Don't surface the raw throw to
    // the page console — callers that grep for verb-thrown text mistake it
    // for a real transport error. The reason code is enough for diagnostics.
    postMessage({ kind: "local_turn_fallback", ...turnDiagnostic(command, persistence), reason: "local_planning_error" });
    postBrowserActivity({
      phase: activePhase,
      path: command.verb,
      route: command.route,
      scope,
      ms: metricElapsed(activeStartedAt),
      status: "error",
      reason: "local_planning_error",
      error: "E_BROWSER_LOCAL_PLAN",
      error_detail: errorMessage(err)
    });
    return false;
  }
  if (!local.ok) {
    if (local.reason === "missing_state" && local.request && local.key) {
      if (repairAttempts < maxLocalRepairAttempts && await repairLocalExecutableState(local, command)) {
        return await sendLocalTurnExec(command, repairAttempts + 1);
      }
      const delegation = selectV2DelegatedExecutor({
        records: await allExecutionAds(),
        key: local.key
      });
      if (delegation.ok) {
        const request: ShadowTurnExecRequest = {
          ...local.request,
          selected_ad: delegation.ad.node
        };
        await sendTurnExecEnvelope(command.id, request);
        postMessage({
          kind: "local_turn_delegated",
          ...turnDiagnostic(command, persistence),
          node: delegation.ad.node,
          missing_atoms: local.missing_atoms?.map((atom) => atom.hash) ?? []
        });
        return true;
      }
    }
    postMessage({
      kind: "local_turn_fallback",
      ...turnDiagnostic(command, persistence),
      reason: local.reason,
      missing_atoms: local.missing_atoms?.map((atom) => atom.hash) ?? []
    });
    return false;
  }
  if (persistence === "durable") {
    await putTentativeTurn(v2BrowserTentativeTurnRecord({
      id: command.id,
      scope,
      actor: current.actor,
      session: current.session ?? null,
      base_head: cachedHead,
      transcript: local.transcript
    }));
  }
  if (local.result_known) {
    postMessage({ kind: "turn_result", frame: local.optimistic_frame, optimistic: true });
  }
  await sendTurnExecEnvelope(command.id, local.request);
  postMessage({
    kind: "local_turn_planned",
    ...turnDiagnostic(command, persistence),
    transcript_hash: local.transcript_hash,
    observation_count: local.observation_count,
    result_known: local.result_known
  });
  return true;
}

async function repairLocalExecutableState(
  local: V2BrowserLocalTurnResult,
  command: Extract<V2WorkerCommand, { kind: "call" }>
): Promise<boolean> {
  const startedAt = metricNow();
  const id = command.id;
  if (local.ok || local.reason !== "missing_state" || !current || !current.actor || !local.key) return false;
  const key = local.key;
  const missingAtoms = local.missing_atoms ?? [];
  // Each repair round uncovers a different atom layer (verb lookup, prop reads,
  // structural writes). The relay caches state-transfer replies by envelope id
  // for idempotency, so reusing `${id}:state-repair` across rounds replays the
  // first round's transfer and the new atoms are never granted. Mint a fresh
  // envelope id per attempt so each round gets its own cell-page closure.
  const requestId = `${id}:state-repair:${crypto.randomUUID()}`;
  // Missing atoms reported via `E_NEED_STATE` carry their preimage; the planned
  // key does NOT (the recorder threw before recording the access). When we
  // have those preimages, ask only for that missing closure. Otherwise fall
  // back to the planned key's hash set, which the relay can resolve through
  // key.preimages.
  const missingAtomsWithPreimage = missingAtoms.filter(
    (atom): atom is { hash: string; preimage: string } => typeof atom.preimage === "string"
  );
  const body: ShadowExecutableStateTransferRequest = {
    kind: "woo.state.transfer.request.shadow.v1",
    id: requestId,
    scope: key.scope,
    key,
    ...(missingAtomsWithPreimage.length > 0 ? {} : { atom_hashes: key.atom_hashes }),
    ...(missingAtomsWithPreimage.length > 0 ? { missing_atoms: missingAtomsWithPreimage } : {}),
    known_page_hashes: await cachedStatePageHashes(),
    mode: "cell_pages"
  };
  const envelope: ShadowEnvelope<ShadowExecutableStateTransferRequest> = {
    v: 2,
    type: body.kind,
    id: requestId,
    from: current.node,
    actor: current.actor,
    ...(current.session ? { session: current.session } : {}),
    auth: { mode: "session", token: current.token },
    body
  };
  postMessage({
    kind: "local_turn_repairing",
    ...turnDiagnostic(command),
    missing_atoms: missingAtoms.map((atom) => atom.hash)
  });
  try {
    await requestStateTransfer(envelope);
    postBrowserActivity({
      phase: "local_turn_repair",
      path: command.verb,
      route: command.route,
      scope: key.scope,
      ms: metricElapsed(startedAt),
      status: "ok",
      count: missingAtoms.length
    });
    return true;
  } catch (err) {
    postMessage({ kind: "local_turn_repair_failed", ...turnDiagnostic(command), error: errorMessage(err) });
    postBrowserActivity({
      phase: "local_turn_repair",
      path: command.verb,
      route: command.route,
      scope: key.scope,
      ms: metricElapsed(startedAt),
      status: "error",
      count: missingAtoms.length,
      error: "E_BROWSER_LOCAL_REPAIR",
      error_detail: errorMessage(err)
    });
    return false;
  }
}

async function requestStateTransfer(envelope: ShadowEnvelope<ShadowExecutableStateTransferRequest>): Promise<void> {
  const startedAt = metricNow();
  const encoded = encodeEnvelope(envelope);
  const id = envelope.id;
  const pending = new Promise<void>((resolve, reject) => {
    const timer = workerScope.setTimeout(() => {
      pendingStateTransfers.delete(id);
      reject(new Error("state transfer request timed out"));
    }, 5000);
    pendingStateTransfers.set(id, { resolve, reject, timer });
  });
  sendEncoded(encoded);
  try {
    await pending;
    postBrowserActivity({
      phase: "state_transfer_request",
      path: envelope.body.mode,
      scope: envelope.body.scope,
      ms: metricElapsed(startedAt),
      status: "ok",
      bytes: jsonBytes(encoded),
      count: envelope.body.atom_hashes?.length ?? envelope.body.missing_atoms?.length ?? 0
    });
  } catch (err) {
    postBrowserActivity({
      phase: "state_transfer_request",
      path: envelope.body.mode,
      scope: envelope.body.scope,
      ms: metricElapsed(startedAt),
      status: "error",
      bytes: jsonBytes(encoded),
      error: "E_BROWSER_STATE_TRANSFER",
      error_detail: errorMessage(err)
    });
    throw err;
  }
}

function resolvePendingStateTransfer(id: string): void {
  const pending = pendingStateTransfers.get(id);
  if (!pending) return;
  pendingStateTransfers.delete(id);
  workerScope.clearTimeout(pending.timer);
  pending.resolve();
}

async function reconcileTentativeTurnReply(reply: ShadowTurnExecReply, replyTo?: string): Promise<void> {
  const ids = [reply.id, replyTo].filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return;
  if (reply.ok === true) {
    const deleted = await deleteMatchingTentativeTurns(ids, reply.transcript?.hash);
    if (deleted.length > 0) postMessage({ kind: "local_turn_committed", ids: deleted.map((record) => record.id) });
    return;
  }
  if (reply.reason === "commit_rejected") {
    const reason = reply.commit?.reason ?? "commit_rejected";
    if (!shouldInvalidateTentativeTurnForCommitReason(reason)) return;
    await invalidateTentativeTurn(ids[0], reason, ids, reply.transcript?.hash);
  }
}

async function deleteMatchingTentativeTurns(ids: readonly string[], transcriptHash?: string): Promise<V2BrowserTentativeTurnRecord[]> {
  const records = await allTentativeTurns();
  const matched = records.filter((record) => v2TentativeTurnMatches(record, ids, transcriptHash));
  for (const record of matched) await deleteTentativeTurn(record.id);
  return matched;
}

async function invalidateTentativeTurn(id: string, reason: string, ids: readonly string[] = [id], transcriptHash?: string): Promise<void> {
  const records = await allTentativeTurns();
  const anchor = v2TentativeTurnForInvalidation(records, ids, transcriptHash);
  if (!anchor) return;
  await deleteTentativeTurn(anchor.id);
  postMessage({
    kind: "local_turn_invalidated",
    id,
    reason,
    invalidated_ids: [anchor.id]
  });
}

function rejectPendingStateTransfers(err: Error): void {
  for (const [id, pending] of pendingStateTransfers) {
    pendingStateTransfers.delete(id);
    workerScope.clearTimeout(pending.timer);
    pending.reject(err);
  }
}

async function sendTurnExecEnvelope(id: string, request: ShadowTurnExecRequest): Promise<void> {
  if (!current || !current.actor) return;
  const envelope: ShadowEnvelope<ShadowTurnExecRequest> = {
    v: 2,
    type: request.kind,
    id,
    from: current.node,
    actor: current.actor,
    ...(current.session ? { session: current.session } : {}),
    auth: { mode: "session", token: current.token },
    body: request
  };
  const encoded = encodeEnvelope(envelope);
  await putPending({
    id: envelope.id,
    encoded,
    created_at: Date.now(),
    auth_token: current.token,
    from: current.node
  });
  sendEncoded(encoded);
}

function sendEncoded(encoded: string): void {
  const startedAt = metricNow();
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(encoded);
    postBrowserActivity({
      phase: "websocket_send",
      path: "frame",
      ms: metricElapsed(startedAt),
      status: "ok",
      bytes: jsonBytes(encoded),
      count: 1
    });
    return;
  }
  postBrowserActivity({
    phase: "websocket_send",
    path: "frame",
    ms: metricElapsed(startedAt),
    status: "error",
    bytes: jsonBytes(encoded),
    reason: "socket_not_open"
  });
}

function scheduleReconnect(): void {
  if (!current || reconnectTimer !== undefined) return;
  reconnectTimer = workerScope.setTimeout(() => {
    reconnectTimer = undefined;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, maxReconnectDelayMs);
    void connect();
  }, reconnectDelayMs);
}

function clearReconnect(): void {
  if (reconnectTimer === undefined) return;
  workerScope.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
}

async function browserNodeId(): Promise<string> {
  const key = "woo.v2.node";
  const existing = await getMeta<string>(key);
  if (existing) return existing;
  const generated = `browser:${crypto.randomUUID()}`;
  await putMeta(key, generated);
  return generated;
}

async function db(): Promise<IDBDatabase> {
  // The cache schema is intentionally small: metadata for hello/reset state,
  // pending outbound envelopes for replay, and dedicated state-plane stores for
  // projection/catch-up hydration. Raw frame history is deliberately omitted so
  // long-lived browser sessions do not accumulate an unbounded debug log.
  dbPromise ??= new Promise((resolve, reject) => {
    const startedAt = metricNow();
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE);
      if (!database.objectStoreNames.contains(PENDING_STORE)) database.createObjectStore(PENDING_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(PROJECTION_STORE)) database.createObjectStore(PROJECTION_STORE, { keyPath: "scope" });
      if (!database.objectStoreNames.contains(PROJECTION_ROW_STORE)) database.createObjectStore(PROJECTION_ROW_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(APPLIED_STORE)) database.createObjectStore(APPLIED_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(TRANSCRIPT_STORE)) database.createObjectStore(TRANSCRIPT_STORE, { keyPath: "hash" });
      if (!database.objectStoreNames.contains(OBJECT_PAGE_STORE)) database.createObjectStore(OBJECT_PAGE_STORE, { keyPath: "hash" });
      if (!database.objectStoreNames.contains(STATE_PAGE_STORE)) database.createObjectStore(STATE_PAGE_STORE, { keyPath: "hash" });
      if (!database.objectStoreNames.contains(EXECUTION_TRANSFER_STORE)) database.createObjectStore(EXECUTION_TRANSFER_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(EXECUTION_AD_STORE)) database.createObjectStore(EXECUTION_AD_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(TENTATIVE_TURN_STORE)) database.createObjectStore(TENTATIVE_TURN_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(EXECUTION_CHECKPOINT_STORE)) database.createObjectStore(EXECUTION_CHECKPOINT_STORE, { keyPath: "scope" });
    };
    request.onsuccess = () => {
      postBrowserActivity({ phase: "idb_open", path: "indexeddb", method: "open", ms: metricElapsed(startedAt), status: "ok", count: 1 });
      resolve(request.result);
    };
    request.onerror = () => {
      const err = request.error ?? new Error("failed to open v2 browser cache");
      postBrowserActivity({ phase: "idb_open", path: "indexeddb", method: "open", ms: metricElapsed(startedAt), status: "error", error: "E_BROWSER_IDB_OPEN", error_detail: errorMessage(err) });
      reject(err);
    };
  });
  return dbPromise;
}

async function putMeta(key: string, value: unknown): Promise<void> {
  await tx(META_STORE, "readwrite", (store) => store.put(value, key));
}

async function getMeta<T>(key: string): Promise<T | undefined> {
  return await tx<T | undefined>(META_STORE, "readonly", (store) => store.get(key));
}

async function putPending(value: PendingEnvelope): Promise<void> {
  await tx(PENDING_STORE, "readwrite", (store) => store.put(value));
}

async function deletePending(id: string): Promise<void> {
  await tx(PENDING_STORE, "readwrite", (store) => store.delete(id));
}

async function allPending(): Promise<PendingEnvelope[]> {
  const pending = await tx<PendingEnvelope[]>(PENDING_STORE, "readonly", (store) => store.getAll());
  return pending.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

async function applyCacheMutation(mutation: V2BrowserCacheMutation): Promise<
  | { kind: "projection"; scope: string; head: ShadowScopeHead; projection: unknown }
  | { kind: "applied_frame"; frame: ShadowCommitAccepted; transcript?: EffectTranscript }
  | void
> {
  const startedAt = metricNow();
  let failed: unknown;
  try {
    switch (mutation.kind) {
      case "meta":
        await putMeta(mutation.key, mutation.value);
        return;
      case "pending_delete":
        await deletePending(mutation.id);
        return;
      case "projection":
        await putProjection(mutation.scope, mutation.head, mutation.projection);
        if (mutation.reset_execution_overlay) await resetCommittedExecutionOverlay(mutation.scope);
        return;
      case "projection_patch": {
        const row = await getProjection(mutation.scope);
        const baseHead = isProjectionRow(row) && isShadowScopeHead(row.head) ? row.head : undefined;
        const projection = applyShadowScopeProjectionPatch(isProjectionRow(row) ? row.projection : undefined, mutation.patch, baseHead);
        await putProjection(mutation.scope, mutation.head, projection);
        return { kind: "projection", scope: mutation.scope, head: mutation.head, projection };
      }
      case "applied_frame": {
        await putAppliedFrame(mutation.frame);
        if (mutation.transcript) {
          await putTranscript(mutation.transcript, mutation.frame.position.seq);
          await maybeCheckpointCommittedTranscripts(mutation.transcript.scope);
        }
        if (rememberAppliedFramePost(mutation.frame)) return { kind: "applied_frame", frame: mutation.frame, transcript: mutation.transcript };
        return;
      }
      case "transcript":
        if (await transcriptCoveredByCheckpoint(mutation.transcript)) return;
        await putTranscript(mutation.transcript);
        return;
      case "object_page":
        await putObjectPage(mutation.hash, mutation.object);
        return;
      case "state_page":
        await putStatePage(mutation.hash, mutation.ref, mutation.page);
        return;
      case "state_pages":
        await putStatePages(mutation.pages);
        return;
      case "checkpoint_tail": {
        const installed = await installCheckpointTailProjection(mutation.transfer);
        if (!installed) return;
        await putProjection(installed.scope, installed.head, installed.projection);
        return { kind: "projection", scope: installed.scope, head: installed.head, projection: installed.projection };
      }
      case "execution_ad":
        await putExecutionAd(mutation.record);
        return;
      case "execution_transfer":
        await putExecutionTransfer(mutation.record);
        return;
    }
  } catch (err) {
    failed = err;
    throw err;
  } finally {
    postBrowserActivity({
      phase: "cache_mutation",
      path: mutation.kind,
      what: mutation.kind,
      scope: mutationScope(mutation),
      ms: metricElapsed(startedAt),
      status: failed ? "error" : "ok",
      count: mutationCount(mutation),
      bytes: mutationApproxBytes(mutation),
      ...(failed ? { error: "E_BROWSER_CACHE_MUTATION", error_detail: errorMessage(failed) } : {})
    });
  }
}

function mutationScope(mutation: V2BrowserCacheMutation): string | undefined {
  if ("scope" in mutation && typeof mutation.scope === "string") return mutation.scope;
  if (mutation.kind === "applied_frame") return mutation.frame.position.scope;
  if (mutation.kind === "transcript") return mutation.transcript.scope;
  if (mutation.kind === "checkpoint_tail") return mutation.transfer.scope;
  if (mutation.kind === "execution_transfer") return mutation.record.scope;
  if (mutation.kind === "execution_ad") return mutation.record.scope;
  return current?.scope;
}

function mutationApproxBytes(mutation: V2BrowserCacheMutation): number | undefined {
  if (mutation.kind === "object_page") return jsonBytes(mutation.object);
  if (mutation.kind === "state_page") return jsonBytes(mutation.page);
  if (mutation.kind === "state_pages") return mutation.pages.reduce((total, page) => total + jsonBytes(page.page), 0);
  if (mutation.kind === "projection") return jsonBytes(mutation.projection);
  if (mutation.kind === "projection_patch") return jsonBytes(mutation.patch);
  if (mutation.kind === "checkpoint_tail") return jsonBytes(mutation.transfer.transfer);
  if (mutation.kind === "execution_transfer") return jsonBytes(mutation.record.transfer);
  return undefined;
}

function mutationCount(mutation: V2BrowserCacheMutation): number {
  if (mutation.kind === "state_pages") return mutation.pages.length;
  if (mutation.kind === "checkpoint_tail") {
    return mutation.transfer.transfer.kind === "frames" ? mutation.transfer.transfer.frames.length : mutation.transfer.transfer.checkpoint.pages.length;
  }
  return 1;
}

async function putProjection(scope: string, head: unknown, projection: unknown): Promise<void> {
  await tx(PROJECTION_STORE, "readwrite", (store) => store.put({ scope, head, projection, updated_at: Date.now() }));
}

async function getProjection(scope: string): Promise<unknown | undefined> {
  if (!scope) return undefined;
  return await tx<unknown | undefined>(PROJECTION_STORE, "readonly", (store) => store.get(scope));
}

function isProjectionRow(value: unknown): value is { scope: string; head: unknown; projection: unknown } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as { scope?: unknown }).scope === "string" && "projection" in value);
}

type ProjectionRowRecord =
  | { id: string; scope: string; table: "objects"; key: ObjRef; row: SerializedObject }
  | { id: string; scope: string; table: "sessions"; key: string; row: SerializedSession }
  | { id: string; scope: string; table: "logs"; key: string; space: ObjRef; row: SpaceLogEntry }
  | { id: string; scope: string; table: "snapshots"; key: string; space: ObjRef; row: SpaceSnapshotRecord }
  | { id: string; scope: string; table: "parked_tasks"; key: string; row: ParkedTaskRecord }
  | { id: string; scope: string; table: "tombstones"; key: ObjRef; row: { id: ObjRef } }
  | { id: string; scope: string; table: "tool_surfaces"; key: string; row: ToolSurfaceProjectionRow };

type ProjectionRowRecordInput =
  | { scope: string; table: "objects"; key: ObjRef; row: SerializedObject }
  | { scope: string; table: "sessions"; key: string; row: SerializedSession }
  | { scope: string; table: "logs"; key: string; space: ObjRef; row: SpaceLogEntry }
  | { scope: string; table: "snapshots"; key: string; space: ObjRef; row: SpaceSnapshotRecord }
  | { scope: string; table: "parked_tasks"; key: string; row: ParkedTaskRecord }
  | { scope: string; table: "tombstones"; key: ObjRef; row: { id: ObjRef } }
  | { scope: string; table: "tool_surfaces"; key: string; row: ToolSurfaceProjectionRow };

function projectionRowId(scope: string, table: ProjectionRowRecord["table"], key: string): string {
  return `${scope}\u0000${table}\u0000${key}`;
}

async function projectionRowsForScope(scope: string): Promise<ProjectionRowRecord[]> {
  const rows = await tx<ProjectionRowRecord[]>(PROJECTION_ROW_STORE, "readonly", (store) => store.getAll());
  return rows.filter((row) => row.scope === scope);
}

async function projectionRowCountForScope(scope: string): Promise<number> {
  return (await projectionRowsForScope(scope)).length;
}

async function putProjectionRow(row: ProjectionRowRecordInput): Promise<void> {
  await tx(PROJECTION_ROW_STORE, "readwrite", (store) => store.put({ ...row, id: projectionRowId(row.scope, row.table, row.key) }));
}

async function deleteProjectionRow(scope: string, table: ProjectionRowRecord["table"], key: string): Promise<void> {
  await tx(PROJECTION_ROW_STORE, "readwrite", (store) => store.delete(projectionRowId(scope, table, key)));
}

async function clearProjectionRows(scope: string): Promise<void> {
  for (const row of await projectionRowsForScope(scope)) {
    await tx(PROJECTION_ROW_STORE, "readwrite", (store) => store.delete(row.id));
  }
}

async function installCheckpointTailProjection(
  transfer: CheckpointTailOpenTransfer
): Promise<{ scope: string; head: ShadowScopeHead; projection: unknown } | null> {
  const viewer = (transfer as { viewer?: CheckpointTailOpenTransfer["viewer"] }).viewer;
  if (!viewer?.actor) throw new Error("checkpoint/tail transfer missing viewer");
  if (transfer.transfer.kind === "checkpoint") {
    const checkpoint = transfer.transfer.checkpoint;
    const exportKey = `checkpoint_export:${checkpoint.scope}`;
    const exportState = {
      checkpoint_hash: checkpoint.checkpoint_hash,
      head: checkpoint.head
    };
    const prior = await getMeta<typeof exportState>(exportKey);
    const beginsExport = checkpoint.pages.some((page) => page.page === "000001");
    if (beginsExport || !prior || prior.checkpoint_hash !== checkpoint.checkpoint_hash) {
      await clearProjectionRows(checkpoint.scope);
    }
    for (const page of checkpoint.pages) {
      switch (page.table) {
        case "objects":
          for (const row of page.rows) await putProjectionRow({ scope: checkpoint.scope, table: "objects", key: row.id, row });
          break;
        case "sessions":
          for (const row of page.rows) await putProjectionRow({ scope: checkpoint.scope, table: "sessions", key: row.id, row });
          break;
        case "logs":
          for (const item of page.rows) {
            await putProjectionRow({ scope: checkpoint.scope, table: "logs", key: `${item.space}:${item.entry.seq}`, space: item.space, row: item.entry });
          }
          break;
        case "snapshots":
          for (const row of page.rows) await putProjectionRow({ scope: checkpoint.scope, table: "snapshots", key: `${row.space_id}:${row.seq}`, space: row.space_id, row });
          break;
        case "parked_tasks":
          for (const row of page.rows) await putProjectionRow({ scope: checkpoint.scope, table: "parked_tasks", key: row.id, row });
          break;
        case "tombstones":
          for (const row of page.rows) await putProjectionRow({ scope: checkpoint.scope, table: "tombstones", key: row.id, row });
          break;
        case "tool_surfaces":
          for (const row of page.rows) await putProjectionRow({ scope: checkpoint.scope, table: "tool_surfaces", key: `${row.scope}:${row.object}`, row });
          break;
        default:
          break;
      }
    }
    // checkpoint_export is a tiny continuation validator, not a freshness
    // lease. It is overwritten by the next export for this scope; the server
    // pins continuation freshness by export id/head/hash and rejects stale
    // continuation tokens.
    await putMeta(exportKey, exportState);
    if (transfer.transfer.continuation) {
      await putMeta("catchup_required", true);
      return null;
    }
    await putMeta(`head:${checkpoint.scope}`, checkpoint.head);
    await putMeta("catchup_required", false);
    return {
      scope: checkpoint.scope,
      head: checkpoint.head,
      projection: await projectionFromStoredRows(checkpoint.scope, checkpoint.head, viewer)
    };
  }

  for (const frame of transfer.transfer.frames) {
    for (const write of frame.projection_writes) await applyProjectionWriteToBrowserRows(transfer.scope, write);
  }
  await putMeta(`head:${transfer.scope}`, transfer.transfer.to);
  await putMeta("catchup_required", false);
  return {
    scope: transfer.scope,
    head: transfer.transfer.to,
    projection: await projectionFromStoredRows(transfer.scope, transfer.transfer.to, viewer)
  };
}

async function applyProjectionWriteToBrowserRows(scope: string, write: ProjectionWrite): Promise<void> {
  switch (write.table) {
    case "objects":
      if (write.op === "delete") await deleteProjectionRow(scope, "objects", write.key);
      else await putProjectionRow({ scope, table: "objects", key: write.key, row: write.row });
      return;
    case "sessions":
      if (write.op === "delete") await deleteProjectionRow(scope, "sessions", write.key);
      else await putProjectionRow({ scope, table: "sessions", key: write.key, row: write.row });
      return;
    case "logs": {
      const key = `${write.key.space}:${write.key.seq}`;
      if (write.op === "delete") await deleteProjectionRow(scope, "logs", key);
      else await putProjectionRow({ scope, table: "logs", key, space: write.key.space, row: write.row });
      return;
    }
    case "snapshots": {
      const key = `${write.key.space}:${write.key.seq}`;
      if (write.op === "delete") await deleteProjectionRow(scope, "snapshots", key);
      else await putProjectionRow({ scope, table: "snapshots", key, space: write.key.space, row: write.row });
      return;
    }
    case "parked_tasks":
      if (write.op === "delete") await deleteProjectionRow(scope, "parked_tasks", write.key);
      else await putProjectionRow({ scope, table: "parked_tasks", key: write.key, row: write.row });
      return;
    case "tombstones":
      if (write.op === "delete") await deleteProjectionRow(scope, "tombstones", write.key);
      else await putProjectionRow({ scope, table: "tombstones", key: write.key, row: write.row });
      return;
    case "tool_surfaces": {
      const key = `${write.key.scope}:${write.key.object}`;
      if (write.op === "delete") await deleteProjectionRow(scope, "tool_surfaces", key);
      else await putProjectionRow({ scope, table: "tool_surfaces", key, row: write.row });
      return;
    }
    default:
      return;
  }
}

async function projectionFromStoredRows(
  scope: string,
  head: ShadowScopeHead,
  viewer: CheckpointTailOpenTransfer["viewer"]
): Promise<unknown> {
  const rows = await projectionRowsForScope(scope);
  const logsBySpace = new Map<ObjRef, SpaceLogEntry[]>();
  for (const row of rows) {
    if (row.table !== "logs") continue;
    const entries = logsBySpace.get(row.space) ?? [];
    entries.push(row.row);
    logsBySpace.set(row.space, entries);
  }
  const serialized: SerializedWorld = {
    version: 1,
    objectCounter: 0,
    parkedTaskCounter: 0,
    sessionCounter: 0,
    objects: rows.filter((row): row is Extract<ProjectionRowRecord, { table: "objects" }> => row.table === "objects").map((row) => row.row),
    sessions: rows.filter((row): row is Extract<ProjectionRowRecord, { table: "sessions" }> => row.table === "sessions").map((row) => row.row),
    logs: Array.from(logsBySpace, ([space, entries]) => [space, entries.sort((a, b) => a.seq - b.seq)] as [ObjRef, SpaceLogEntry[]]),
    snapshots: rows.filter((row): row is Extract<ProjectionRowRecord, { table: "snapshots" }> => row.table === "snapshots").map((row) => row.row),
    parkedTasks: rows.filter((row): row is Extract<ProjectionRowRecord, { table: "parked_tasks" }> => row.table === "parked_tasks").map((row) => row.row),
    tombstones: rows.filter((row): row is Extract<ProjectionRowRecord, { table: "tombstones" }> => row.table === "tombstones").map((row) => row.row.id)
  };
  return shadowScopeProjectionFromSerialized(serialized, scope as ObjRef, head, transferViewer(viewer));
}

function transferViewer(viewer: CheckpointTailOpenTransfer["viewer"]): { actor: ObjRef; session?: string | null } {
  return viewer;
}

async function postCachedProjection(scope: string): Promise<void> {
  const message = v2ProjectionMessageFromRow(await getProjection(scope), { cached: true });
  if (message) postMessage(message);
}

function postProjection(scope: string, head: ShadowScopeHead, projection: unknown): void {
  const message = v2ProjectionMessageFromRow({ scope, head, projection });
  if (message) postMessage(message);
}

function postAppliedFrame(frame: ShadowCommitAccepted, transcript?: EffectTranscript): void {
  // Raw envelopes remain available as diagnostics, but committed frames are a
  // first-class worker message so the UI can later reduce v2 commits without
  // inspecting transport envelopes.
  const message = v2AppliedFrameMessageFromFrame(frame, transcript);
  if (message) postMessage(message);
}

function appliedFrameKey(frame: ShadowCommitAccepted): string {
  return `${frame.position.scope}:${frame.position.seq}`;
}

function rememberAppliedFramePost(frame: ShadowCommitAccepted): boolean {
  const key = appliedFrameKey(frame);
  if (postedAppliedFrameKeys.has(key)) return false;
  postedAppliedFrameKeys.add(key);
  return true;
}

async function putAppliedFrame(frame: ShadowCommitAccepted): Promise<void> {
  const key = appliedFrameKey(frame);
  // The same accepted frame can arrive in the direct reply and in one or more
  // catch-up transfers. Persist it once; delivery coalescing is session-local.
  const existing = await tx<{ id?: string } | undefined>(APPLIED_STORE, "readonly", (store) => store.get(key));
  if (existing) return;
  await tx(APPLIED_STORE, "readwrite", (store) => store.put({ id: key, scope: frame.position.scope, seq: frame.position.seq, frame, received_at: Date.now() }));
}

async function putTranscript(transcript: EffectTranscript, acceptedSeq?: number): Promise<void> {
  const existing = await tx<TranscriptTailRow | undefined>(TRANSCRIPT_STORE, "readonly", (store) => store.get(transcript.hash));
  const authoritativeSeq = typeof acceptedSeq === "number"
    ? acceptedSeq
    : typeof existing?.accepted_seq === "number"
      ? existing.accepted_seq
      : undefined;
  const row: TranscriptTailRow = {
    hash: transcript.hash,
    scope: transcript.scope,
    seq: authoritativeSeq ?? transcript.seq,
    ...(authoritativeSeq !== undefined ? { accepted_seq: authoritativeSeq } : {}),
    transcript,
    received_at: existing?.received_at ?? Date.now()
  };
  await tx(TRANSCRIPT_STORE, "readwrite", (store) => store.put(row));
}

async function transcriptCoveredByCheckpoint(transcript: EffectTranscript): Promise<boolean> {
  const checkpoint = await getExecutionCheckpoint(transcript.scope);
  return Boolean(checkpoint && transcript.seq <= checkpoint.through_seq);
}

async function putObjectPage(hash: string, object: unknown): Promise<void> {
  await tx(OBJECT_PAGE_STORE, "readwrite", (store) => store.put({ hash, object: (object as { id?: unknown }).id, record: object, received_at: Date.now() }));
}

async function putStatePage(hash: string, ref: string, page: unknown): Promise<void> {
  await tx(STATE_PAGE_STORE, "readwrite", (store) => store.put({ hash, ref, page, received_at: Date.now() }));
}

async function putStatePages(pages: readonly { hash: string; ref: string; page: unknown }[]): Promise<void> {
  if (pages.length === 0) return;
  const receivedAt = Date.now();
  await tx<IDBValidKey>(STATE_PAGE_STORE, "readwrite", (store) => {
    let request: IDBRequest<IDBValidKey> | null = null;
    for (const { hash, ref, page } of pages) request = store.put({ hash, ref, page, received_at: receivedAt });
    return request!;
  }, { count: pages.length });
}

async function putExecutionTransfer(record: V2ExecutableTransferRecord): Promise<void> {
  await tx(EXECUTION_TRANSFER_STORE, "readwrite", (store) => store.put(record));
}

async function putExecutionAd(record: V2ExecutionAdRecord): Promise<void> {
  await tx(EXECUTION_AD_STORE, "readwrite", (store) => store.put(record));
}

async function putExecutionCheckpoint(record: V2BrowserExecutionCheckpoint): Promise<void> {
  await tx(EXECUTION_CHECKPOINT_STORE, "readwrite", (store) => store.put(record));
}

async function getExecutionCheckpoint(scope: string): Promise<V2BrowserExecutionCheckpoint | undefined> {
  if (!scope) return undefined;
  return await tx<V2BrowserExecutionCheckpoint | undefined>(EXECUTION_CHECKPOINT_STORE, "readonly", (store) => store.get(scope));
}

async function deleteExecutionCheckpoint(scope: string): Promise<void> {
  await tx(EXECUTION_CHECKPOINT_STORE, "readwrite", (store) => store.delete(scope));
}

async function putTentativeTurn(record: V2BrowserTentativeTurnRecord): Promise<void> {
  await tx(TENTATIVE_TURN_STORE, "readwrite", (store) => store.put(record));
}

async function deleteTentativeTurn(id: string): Promise<void> {
  await tx(TENTATIVE_TURN_STORE, "readwrite", (store) => store.delete(id));
}

async function allExecutionTransfers(): Promise<V2ExecutableTransferRecord[]> {
  return await tx<V2ExecutableTransferRecord[]>(EXECUTION_TRANSFER_STORE, "readonly", (store) => store.getAll());
}

async function transcriptRowsForScope(scope: string): Promise<TranscriptTailRow[]> {
  const rows = await tx<TranscriptTailRow[]>(TRANSCRIPT_STORE, "readonly", (store) => store.getAll());
  return rows
    .filter((row) => row.scope === scope)
    .slice()
    .sort((a, b) => (a.accepted_seq ?? a.seq) - (b.accepted_seq ?? b.seq) || a.received_at - b.received_at || a.hash.localeCompare(b.hash));
}

async function committedTranscriptRowsForScope(scope: string, afterSeq = -1): Promise<TranscriptTailRow[]> {
  return (await transcriptRowsForScope(scope))
    .filter((row) => typeof row.accepted_seq === "number" && (row.accepted_seq ?? row.seq) > afterSeq);
}

async function committedTranscriptsForScope(scope: string, afterSeq = -1): Promise<EffectTranscript[]> {
  return (await committedTranscriptRowsForScope(scope, afterSeq))
    .map((row) => structuredClone(row.transcript) as EffectTranscript);
}

async function deleteCommittedTranscriptsThrough(scope: string, throughSeq: number): Promise<number> {
  const rows = await committedTranscriptRowsForScope(scope);
  const doomed = rows.filter((row) => (row.accepted_seq ?? row.seq) <= throughSeq);
  if (doomed.length === 0) return 0;
  await deleteStoreKeys(TRANSCRIPT_STORE, doomed.map((row) => row.hash));
  return doomed.length;
}

async function resetCommittedExecutionOverlay(scope: string): Promise<void> {
  // A full projection/open seed is an authoritative snapshot boundary. The
  // committed transcript tail and checkpoint describe how to advance an older
  // executable seed; keeping them would replay already-included commits over
  // the new seed on the next local plan. Verified executable transfers remain
  // usable until the replacement executable seed arrives.
  const rows = await transcriptRowsForScope(scope);
  await deleteStoreKeys(TRANSCRIPT_STORE, rows.map((row) => row.hash));
  await deleteExecutionCheckpoint(scope);
}

async function maybeCheckpointCommittedTranscripts(scope: string): Promise<void> {
  const checkpoint = await getExecutionCheckpoint(scope);
  const rows = await committedTranscriptRowsForScope(scope, checkpoint?.through_seq ?? -1);
  if (rows.length < V2_BROWSER_COMMITTED_TRANSCRIPT_CHECKPOINT_INTERVAL) return;
  const cache = await executionCacheForScope(scope, undefined, { skip_checkpoint_build: true });
  const throughSeq = rows[rows.length - 1]!.accepted_seq ?? rows[rows.length - 1]!.seq;
  const next = createV2BrowserExecutionCheckpoint({
    node: current?.node ?? "browser:checkpoint",
    scope,
    records: cache.records,
    cached_objects: cache.cached_objects,
    cached_pages: cache.cached_pages,
    checkpoint,
    committed_transcripts: rows.map((row) => structuredClone(row.transcript) as EffectTranscript),
    through_seq: throughSeq
  });
  if (!next) return;
  await putExecutionCheckpoint(next);
  const pruned = await deleteCommittedTranscriptsThrough(scope, throughSeq);
  postMessage({
    kind: "shadow_browser_execution_checkpoint",
    scope,
    through_seq: throughSeq,
    transcript_count: rows.length,
    pruned
  });
}

async function allTentativeTurns(): Promise<V2BrowserTentativeTurnRecord[]> {
  const records = await tx<V2BrowserTentativeTurnRecord[]>(TENTATIVE_TURN_STORE, "readonly", (store) => store.getAll());
  return records.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

async function executionCacheForScope(
  scope: string,
  records?: readonly V2ExecutableTransferRecord[],
  options: { skip_checkpoint_build?: boolean } = {}
): Promise<{
  records: V2ExecutableTransferRecord[];
  cached_objects: SerializedObject[];
  cached_pages: ShadowStatePage[];
  checkpoint?: V2BrowserExecutionCheckpoint;
  committed_transcripts: EffectTranscript[];
}> {
  const startedAt = metricNow();
  let scopedRecordCount = 0;
  let objectHashCount = 0;
  let pageHashCount = 0;
  try {
    const sourceRecords = records ?? await allExecutionTransfers();
    const checkpoint = options.skip_checkpoint_build ? undefined : await getExecutionCheckpoint(scope);
    const scopedRecords = sourceRecords.filter((record) => record.scope === scope);
    scopedRecordCount = scopedRecords.length;
    const recordsToInstall = checkpoint
      ? scopedRecords.filter((record) => record.received_at > checkpoint.transfer_high_watermark)
      : scopedRecords;
    const objectHashes = new Set<string>();
    const pageHashes = new Set<string>();
    for (const record of recordsToInstall) {
      const transfer = record.transfer;
      if (transfer.mode === "object_records") {
        for (const page of transfer.object_pages) objectHashes.add(page.hash);
      } else if (transfer.mode === "cell_pages") {
        for (const page of transfer.page_refs) pageHashes.add(page.hash);
      }
    }
    objectHashCount = objectHashes.size;
    pageHashCount = pageHashes.size;
    const cached_objects = await cachedObjectsByHash(objectHashes);
    const cached_pages = await cachedStatePagesByHash(pageHashes);
    const committed_transcripts = await committedTranscriptsForScope(scope, checkpoint?.through_seq ?? -1);
    postBrowserActivity({
      phase: "execution_cache_build",
      path: options.skip_checkpoint_build ? "skip_checkpoint" : "with_checkpoint",
      scope,
      ms: metricElapsed(startedAt),
      status: "ok",
      records: scopedRecords.length,
      count: cached_objects.length + cached_pages.length + committed_transcripts.length
    });
    return {
      records: scopedRecords,
      cached_objects,
      cached_pages,
      ...(checkpoint ? { checkpoint } : {}),
      committed_transcripts
    };
  } catch (err) {
    postBrowserActivity({
      phase: "execution_cache_build",
      path: options.skip_checkpoint_build ? "skip_checkpoint" : "with_checkpoint",
      scope,
      ms: metricElapsed(startedAt),
      status: "error",
      records: scopedRecordCount,
      count: objectHashCount + pageHashCount,
      error: "E_BROWSER_EXECUTION_CACHE",
      error_detail: errorMessage(err)
    });
    throw err;
  }
}

async function cachedObjectsByHash(hashes: Iterable<string>): Promise<SerializedObject[]> {
  const objects: SerializedObject[] = [];
  for (const hash of hashes) {
    const row = await tx<{ record?: unknown } | undefined>(OBJECT_PAGE_STORE, "readonly", (store) => store.get(hash));
    if (isSerializedObject(row?.record)) objects.push(row.record);
  }
  return objects;
}

async function cachedStatePagesByHash(hashes: Iterable<string>): Promise<ShadowStatePage[]> {
  const wanted = new Set(hashes);
  if (wanted.size === 0) return [];
  // Tool entry normally needs almost every cached state page. One bulk read
  // keeps IndexedDB metrics and main-thread postMessage volume bounded; do not
  // restore per-hash transactions unless sparse cache reads become dominant.
  const rows = await tx<Array<{ hash?: unknown; page?: unknown }>>(STATE_PAGE_STORE, "readonly", (store) => store.getAll(), { count: wanted.size });
  return rows
    .filter((row) => typeof row?.hash === "string" && wanted.has(row.hash) && isShadowStatePage(row.page))
    .map((row) => row.page as ShadowStatePage);
}

async function cachedStatePageHashes(): Promise<string[]> {
  const keys = await tx<IDBValidKey[]>(STATE_PAGE_STORE, "readonly", (store) => store.getAllKeys());
  return keys.filter((key): key is string => typeof key === "string");
}

async function cachedOpenExecutableSeedDigest(node: string, scope: string): Promise<string | undefined> {
  const startedAt = metricNow();
  let candidateCount = 0;
  try {
    const records = await allExecutionTransfers();
    const cache = await executionCacheForScope(scope, records);
    if (!canReconstructExecutionNode(node, scope, cache.records, cache.cached_objects, cache.cached_pages, cache.checkpoint)) {
      postBrowserActivity({
        phase: "open_seed_digest_probe",
        path: "cache",
        scope,
        node,
        ms: metricElapsed(startedAt),
        status: "ok",
        reason: "cannot_reconstruct",
        records: cache.records.length
      });
      return undefined;
    }
    const candidates = cache.records
      .filter((record) => record.scope === scope && record.transfer.mode === "cell_pages" && record.transfer.purpose === "open_executable_seed")
      .slice()
      .sort((a, b) => b.received_at - a.received_at || b.id.localeCompare(a.id));
    candidateCount = candidates.length;
    for (const record of candidates) {
      const digest = shadowStateTransferCacheDigest(record.transfer);
      if (digest) {
        postBrowserActivity({
          phase: "open_seed_digest_probe",
          path: "cache",
          scope,
          node,
          ms: metricElapsed(startedAt),
          status: "ok",
          reason: "hit",
          records: candidateCount,
          executable_transfer_cache: "hit"
        });
        return digest;
      }
    }
    postBrowserActivity({
      phase: "open_seed_digest_probe",
      path: "cache",
      scope,
      node,
      ms: metricElapsed(startedAt),
      status: "ok",
      reason: "miss",
      records: candidateCount,
      executable_transfer_cache: "miss"
    });
    return undefined;
  } catch (err) {
    postBrowserActivity({
      phase: "open_seed_digest_probe",
      path: "cache",
      scope,
      node,
      ms: metricElapsed(startedAt),
      status: "error",
      records: candidateCount,
      error: "E_BROWSER_OPEN_SEED_DIGEST",
      error_detail: errorMessage(err)
    });
    throw err;
  }
}

async function allExecutionAds(): Promise<V2ExecutionAdRecord[]> {
  return await tx<V2ExecutionAdRecord[]>(EXECUTION_AD_STORE, "readonly", (store) => store.getAll());
}

async function status(): Promise<V2CacheStatus> {
  const executionTransfers = await allExecutionTransfers();
  const executionCache = current?.scope ? await executionCacheForScope(current.scope, executionTransfers) : undefined;
  const localExecutionReady = current?.scope
    ? canReconstructExecutionNode(
      current.node,
      current.scope,
      executionCache?.records ?? executionTransfers,
      executionCache?.cached_objects ?? [],
      executionCache?.cached_pages ?? [],
      executionCache?.checkpoint
    )
    : undefined;
  return {
    connected: socket?.readyState === WebSocket.OPEN,
    pending: (await allPending()).length,
    projections: await countStore(PROJECTION_STORE),
    projection_rows: await countStore(PROJECTION_ROW_STORE),
    applied_frames: await countStore(APPLIED_STORE),
    transcript_tail: await countStore(TRANSCRIPT_STORE),
    object_pages: await countStore(OBJECT_PAGE_STORE),
    state_pages: await countStore(STATE_PAGE_STORE),
    execution_transfers: executionTransfers.length,
    execution_ads: await countStore(EXECUTION_AD_STORE),
    execution_checkpoints: await countStore(EXECUTION_CHECKPOINT_STORE),
    tentative_turns: await countStore(TENTATIVE_TURN_STORE),
    executable_scopes: executableScopes(executionTransfers),
    ...(localExecutionReady !== undefined ? { local_execution_ready: localExecutionReady } : {}),
    last_hello: await getMeta("hello"),
    catchup_required: await getMeta("catchup_required")
  };
}

function executableScopes(records: readonly V2ExecutableTransferRecord[]): string[] {
  const scopes = new Set<string>();
  for (const record of records) scopes.add(record.scope);
  return Array.from(scopes).sort();
}

function canReconstructExecutionNode(
  node: string,
  scope: string,
  records: readonly V2ExecutableTransferRecord[],
  cachedObjects: readonly SerializedObject[] = [],
  cachedPages: readonly ShadowStatePage[] = [],
  checkpoint?: V2BrowserExecutionCheckpoint
): boolean {
  if (!checkpoint && !records.some((record) => record.scope === scope)) return false;
  try {
    const executionNode = createV2BrowserExecutionNodeFromTransfers({
      node,
      scope,
      records,
      cached_objects: cachedObjects,
      cached_pages: cachedPages,
      checkpoint
    });
    return executionNode.serialized !== undefined;
  } catch {
    return false;
  }
}

function isSerializedObject(value: unknown): value is SerializedObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as { id?: unknown }).id === "string");
}

function isShadowStatePage(value: unknown): value is ShadowStatePage {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as { kind?: unknown }).kind === "string" && typeof (value as { page?: unknown }).page === "string");
}

async function countStore(storeName: string): Promise<number> {
  return await tx<number>(storeName, "readonly", (store) => store.count());
}

async function deleteStoreKeys(storeName: string, keys: readonly IDBValidKey[]): Promise<void> {
  if (keys.length === 0) return;
  await tx<undefined>(storeName, "readwrite", (store) => {
    let request: IDBRequest<undefined> | null = null;
    for (const key of keys) request = store.delete(key);
    return request ?? store.delete(keys[0]!);
  });
}

function postStatus(): void {
  void status().then((value) => postMessage({ kind: "status", status: value }));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
  options: { count?: number } = {}
): Promise<T> {
  const database = await db();
  const startedAt = metricNow();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (status: "ok" | "error", err?: unknown) => {
      if (settled) return;
      settled = true;
      postBrowserActivity({
        phase: "idb_tx",
        path: "indexeddb",
        method: mode,
        what: storeName,
        ms: metricElapsed(startedAt),
        status,
        count: options.count ?? 1,
        ...(err ? { error: "E_BROWSER_IDB_TX", error_detail: errorMessage(err) } : {})
      });
    };
    const transaction = database.transaction(storeName, mode);
    const request = op(transaction.objectStore(storeName));
    request.onsuccess = () => {
      finish("ok");
      resolve(request.result);
    };
    request.onerror = () => {
      const err = request.error ?? new Error(`IndexedDB ${storeName} request failed`);
      finish("error", err);
      reject(err);
    };
    transaction.onerror = () => {
      const err = transaction.error ?? new Error(`IndexedDB ${storeName} transaction failed`);
      finish("error", err);
      reject(err);
    };
  });
}
