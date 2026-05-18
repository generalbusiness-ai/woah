import { decodeEnvelope, encodeEnvelope, type ShadowEnvelope } from "../core/shadow-envelope";
import type { EffectTranscript } from "../core/effect-transcript";
import type { ShadowCommitAccepted, ShadowScopeHead } from "../core/shadow-commit-scope";
import { applyShadowScopeProjectionPatch, type ShadowLiveEvent, type ShadowTurnIntentRequest } from "../core/shadow-browser-node";
import type { ShadowTurnExecReply, ShadowTurnExecRequest } from "../core/shadow-turn-exec";
import type { WooValue } from "../core/types";
import { isShadowScopeHead } from "../core/shadow-scope-head";
import { v2BrowserCacheMutationsForEnvelope, type V2BrowserCacheMutation } from "./v2-browser-cache";
import type { V2ExecutableTransferRecord } from "./v2-browser-execution-cache";
import { createV2BrowserExecutionNodeFromTransfers } from "./v2-browser-execution-cache";
import { planV2BrowserLocalTurn } from "./v2-browser-local-turn";
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

type V2CacheStatus = {
  connected: boolean;
  pending: number;
  projections: number;
  applied_frames: number;
  transcript_tail: number;
  object_pages: number;
  state_pages: number;
  execution_transfers: number;
  executable_scopes: string[];
  local_execution_ready?: boolean;
  last_hello?: unknown;
  catchup_required?: boolean;
};

const DB_NAME = "woo-v2-browser";
const DB_VERSION = 4;
const META_STORE = "meta";
const PENDING_STORE = "pending";
const PROJECTION_STORE = "projections";
const APPLIED_STORE = "applied_frames";
const TRANSCRIPT_STORE = "transcript_tail";
const OBJECT_PAGE_STORE = "object_pages";
const STATE_PAGE_STORE = "state_pages";
const EXECUTION_TRANSFER_STORE = "execution_transfers";

let dbPromise: Promise<IDBDatabase> | null = null;
let socket: WebSocket | null = null;
let current: { token: string; node: string; scope: string; actor?: string; session?: string } | null = null;
let reconnectTimer: number | undefined;
let connecting = false;
let connectPromise: Promise<void> | null = null;
let connectReadyResolve: (() => void) | null = null;
let reconnectDelayMs = 500;
const maxReconnectDelayMs = 10_000;
let commandQueue: Promise<void> = Promise.resolve();

type V2WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<V2WorkerCommand>) => void): void;
  setTimeout(handler: () => void, timeout?: number): number;
  clearTimeout(id: number): void;
};

const workerScope = self as unknown as V2WorkerScope;

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
    previous?.close(1000, "v2 browser scope changed");
    await putMeta("connected", false);
  }
  await connect();
}

/**
 * Opens the v2 transport for `current`.
 *
 * The returned promise resolves when the relay has delivered the initial state
 * transfer for this scope, or when the socket errors/closes before that point.
 * Once a socket has already reached that state-transfer boundary, later callers
 * return immediately.
 */
async function connect(): Promise<void> {
  if (!current) return;
  if (socket?.readyState === WebSocket.OPEN) return;
  if (connecting) return connectPromise ?? undefined;
  connecting = true;
  clearReconnect();
  const cachedHead = current.scope ? await getMeta<unknown>(`head:${current.scope}`) : undefined;
  const lastKnownHead: ShadowScopeHead | undefined = isShadowScopeHead(cachedHead) ? cachedHead : undefined;
  const ws = new WebSocket(v2BrowserWebSocketUrl({
    location,
    token: current.token,
    node: current.node,
    scope: current.scope,
    last_known_head: lastKnownHead
  }), "woo-v2.turn-network.json");
  socket = ws;
  connectPromise = new Promise<void>((resolve) => {
    // WebSocket open is not enough: the dev relay sends TransportHello before
    // openShadowBrowserScope subscribes this node. Resolve connect only after
    // the state transfer, so immediate turn intents cannot miss accepted-frame
    // fan-out for their new scope.
    const settle = () => {
      if (connectPromise) connectPromise = null;
      if (connectReadyResolve === settle) connectReadyResolve = null;
      resolve();
    };
    connectReadyResolve = settle;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      connecting = false;
      reconnectDelayMs = 500;
      void putMeta("connected", true);
      postStatus();
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (typeof event.data !== "string") return;
      void receiveFrame(event.data).catch((err: unknown) => {
        postMessage({ kind: "error", error: errorMessage(err) });
      });
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      connecting = false;
      void putMeta("connected", false);
      postStatus();
      scheduleReconnect();
      settle();
    });
    ws.addEventListener("error", () => {
      if (socket !== ws) return;
      connecting = false;
      void putMeta("connected", false);
      postStatus();
      settle();
    });
  });
  return connectPromise;
}

async function receiveFrame(encoded: string): Promise<void> {
  // Every frame is decoded through the transport-neutral codec before cache
  // mutation so the browser worker rejects the same malformed envelopes as the
  // relay and in-process tests.
  const envelope = decodeEnvelope(encoded);
  let installedExecutableState = false;
  const receivedStateTransfer = envelope.type === "woo.state.transfer.shadow.v1";
  for (const mutation of v2BrowserCacheMutationsForEnvelope(envelope)) {
    const applied = await applyCacheMutation(mutation);
    if (mutation.kind === "projection") postProjection(mutation.scope, mutation.head, mutation.projection);
    if (applied?.kind === "projection") postProjection(applied.scope, applied.head, applied.projection);
    if (mutation.kind === "applied_frame") postAppliedFrame(mutation.frame, mutation.transcript);
    if (mutation.kind === "object_page" || mutation.kind === "state_page") installedExecutableState = true;
  }
  if (envelope.type === "woo.turn.exec.reply.shadow.v1") {
    const message = v2TurnResultMessageFromReply(envelope.body as ShadowTurnExecReply, envelope.reply_to);
    if (message) postMessage(message);
  }
  if (envelope.type === "woo.live.event.shadow.v1") {
    postMessage({ kind: "live_event", event: envelope.body as ShadowLiveEvent });
  }
  if (installedExecutableState || receivedStateTransfer) await replayPending();
  if (receivedStateTransfer || envelope.type === "woo.transport.error.v1") connectReadyResolve?.();
  postMessage({ kind: "frame", envelope });
  postStatus();
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
  if (!current || !current.actor) {
    postMessage({ kind: "error", error: "v2 browser call requires an authenticated actor" });
    return;
  }
  if (await sendLocalTurnExec(command)) {
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
}

async function sendLocalTurnExec(command: Extract<V2WorkerCommand, { kind: "call" }>): Promise<boolean> {
  if (!current || !current.actor) return false;
  const scope = command.scope || current.scope;
  const cachedHead = scope ? await getMeta<unknown>(`head:${scope}`) : undefined;
  if (!isShadowScopeHead(cachedHead)) {
    postMessage({ kind: "local_turn_fallback", id: command.id, reason: "no_head" });
    return false;
  }
  const local = await planV2BrowserLocalTurn({
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
    persistence: command.persistence ?? (command.route === "direct" ? "live" : "durable"),
    transfers: await allExecutionTransfers()
  });
  if (!local.ok) {
    postMessage({
      kind: "local_turn_fallback",
      id: command.id,
      reason: local.reason,
      missing_atoms: local.missing_atoms?.map((atom) => atom.hash) ?? []
    });
    return false;
  }
  const envelope: ShadowEnvelope<ShadowTurnExecRequest> = {
    v: 2,
    type: local.request.kind,
    id: command.id,
    from: current.node,
    actor: current.actor,
    ...(current.session ? { session: current.session } : {}),
    auth: { mode: "session", token: current.token },
    body: local.request
  };
  const encoded = encodeEnvelope(envelope);
  await putPending({
    id: envelope.id,
    encoded,
    created_at: Date.now(),
    auth_token: current.token,
    from: current.node
  });
  postMessage({
    kind: "local_turn_planned",
    id: command.id,
    transcript_hash: local.transcript_hash,
    observation_count: local.observation_count,
    result_known: local.result_known
  });
  sendEncoded(encoded);
  return true;
}

function sendEncoded(encoded: string): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(encoded);
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
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE);
      if (!database.objectStoreNames.contains(PENDING_STORE)) database.createObjectStore(PENDING_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(PROJECTION_STORE)) database.createObjectStore(PROJECTION_STORE, { keyPath: "scope" });
      if (!database.objectStoreNames.contains(APPLIED_STORE)) database.createObjectStore(APPLIED_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(TRANSCRIPT_STORE)) database.createObjectStore(TRANSCRIPT_STORE, { keyPath: "hash" });
      if (!database.objectStoreNames.contains(OBJECT_PAGE_STORE)) database.createObjectStore(OBJECT_PAGE_STORE, { keyPath: "hash" });
      if (!database.objectStoreNames.contains(STATE_PAGE_STORE)) database.createObjectStore(STATE_PAGE_STORE, { keyPath: "hash" });
      if (!database.objectStoreNames.contains(EXECUTION_TRANSFER_STORE)) database.createObjectStore(EXECUTION_TRANSFER_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("failed to open v2 browser cache"));
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

async function applyCacheMutation(mutation: V2BrowserCacheMutation): Promise<{ kind: "projection"; scope: string; head: ShadowScopeHead; projection: unknown } | void> {
  switch (mutation.kind) {
    case "meta":
      await putMeta(mutation.key, mutation.value);
      return;
    case "pending_delete":
      await deletePending(mutation.id);
      return;
    case "projection":
      await putProjection(mutation.scope, mutation.head, mutation.projection);
      return;
    case "projection_patch": {
      const row = await getProjection(mutation.scope);
      const baseHead = isProjectionRow(row) && isShadowScopeHead(row.head) ? row.head : undefined;
      const projection = applyShadowScopeProjectionPatch(isProjectionRow(row) ? row.projection : undefined, mutation.patch, baseHead);
      await putProjection(mutation.scope, mutation.head, projection);
      return { kind: "projection", scope: mutation.scope, head: mutation.head, projection };
    }
    case "applied_frame":
      await putAppliedFrame(mutation.frame);
      return;
    case "transcript":
      await putTranscript(mutation.transcript);
      return;
    case "object_page":
      await putObjectPage(mutation.hash, mutation.object);
      return;
    case "state_page":
      await putStatePage(mutation.hash, mutation.ref, mutation.page);
      return;
    case "execution_transfer":
      await putExecutionTransfer(mutation.record);
      return;
  }
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

async function putAppliedFrame(frame: ShadowCommitAccepted): Promise<void> {
  const key = `${frame.position.scope}:${frame.position.seq}`;
  await tx(APPLIED_STORE, "readwrite", (store) => store.put({ id: key, scope: frame.position.scope, seq: frame.position.seq, frame, received_at: Date.now() }));
}

async function putTranscript(transcript: EffectTranscript): Promise<void> {
  await tx(TRANSCRIPT_STORE, "readwrite", (store) => store.put({ hash: transcript.hash, scope: transcript.scope, seq: transcript.seq, transcript, received_at: Date.now() }));
}

async function putObjectPage(hash: string, object: unknown): Promise<void> {
  await tx(OBJECT_PAGE_STORE, "readwrite", (store) => store.put({ hash, object: (object as { id?: unknown }).id, record: object, received_at: Date.now() }));
}

async function putStatePage(hash: string, ref: string, page: unknown): Promise<void> {
  await tx(STATE_PAGE_STORE, "readwrite", (store) => store.put({ hash, ref, page, received_at: Date.now() }));
}

async function putExecutionTransfer(record: V2ExecutableTransferRecord): Promise<void> {
  await tx(EXECUTION_TRANSFER_STORE, "readwrite", (store) => store.put(record));
}

async function allExecutionTransfers(): Promise<V2ExecutableTransferRecord[]> {
  return await tx<V2ExecutableTransferRecord[]>(EXECUTION_TRANSFER_STORE, "readonly", (store) => store.getAll());
}

async function status(): Promise<V2CacheStatus> {
  const executionTransfers = await allExecutionTransfers();
  const localExecutionReady = current?.scope
    ? canReconstructExecutionNode(current.node, current.scope, executionTransfers)
    : undefined;
  return {
    connected: socket?.readyState === WebSocket.OPEN,
    pending: (await allPending()).length,
    projections: await countStore(PROJECTION_STORE),
    applied_frames: await countStore(APPLIED_STORE),
    transcript_tail: await countStore(TRANSCRIPT_STORE),
    object_pages: await countStore(OBJECT_PAGE_STORE),
    state_pages: await countStore(STATE_PAGE_STORE),
    execution_transfers: executionTransfers.length,
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

function canReconstructExecutionNode(node: string, scope: string, records: readonly V2ExecutableTransferRecord[]): boolean {
  if (!records.some((record) => record.scope === scope)) return false;
  try {
    const executionNode = createV2BrowserExecutionNodeFromTransfers({ node, scope, records });
    return executionNode.serialized !== undefined;
  } catch {
    return false;
  }
}

async function countStore(storeName: string): Promise<number> {
  return await tx<number>(storeName, "readonly", (store) => store.count());
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
  op: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const database = await db();
  return await new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = op(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`IndexedDB ${storeName} request failed`));
    transaction.onerror = () => reject(transaction.error ?? new Error(`IndexedDB ${storeName} transaction failed`));
  });
}
