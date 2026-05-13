import { decodeEnvelope, encodeEnvelope, type ShadowEnvelope } from "../core/shadow-envelope";

type V2WorkerCommand =
  | { kind: "connect"; token: string; node?: string; scope?: string }
  | { kind: "disconnect" }
  | { kind: "send"; envelope: ShadowEnvelope }
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
  last_hello?: unknown;
  catchup_required?: boolean;
};

const DB_NAME = "woo-v2-browser";
const DB_VERSION = 1;
const META_STORE = "meta";
const PENDING_STORE = "pending";
const FRAME_STORE = "frames";

let dbPromise: Promise<IDBDatabase> | null = null;
let socket: WebSocket | null = null;
let current: { token: string; node: string; scope: string } | null = null;
let reconnectTimer: number | undefined;
let connecting = false;
let reconnectDelayMs = 500;
const maxReconnectDelayMs = 10_000;

type V2WorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<V2WorkerCommand>) => void): void;
  setTimeout(handler: () => void, timeout?: number): number;
  clearTimeout(id: number): void;
};

const workerScope = self as unknown as V2WorkerScope;

workerScope.addEventListener("message", (event: MessageEvent<V2WorkerCommand>) => {
  void handleCommand(event.data);
});

async function handleCommand(command: V2WorkerCommand): Promise<void> {
  switch (command.kind) {
    case "connect":
      current = {
        token: command.token,
        node: command.node ?? await browserNodeId(),
        scope: command.scope ?? ""
      };
      await connect();
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
    case "cache_status":
      postStatus();
      break;
  }
}

async function connect(): Promise<void> {
  if (!current) return;
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  if (connecting) return;
  connecting = true;
  clearReconnect();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ token: current.token, node: current.node });
  if (current.scope) params.set("scope", current.scope);
  const ws = new WebSocket(`${protocol}//${location.host}/v2/turn-network/ws?${params}`, "woo-v2.turn-network.json");
  socket = ws;
  ws.addEventListener("open", () => {
    connecting = false;
    reconnectDelayMs = 500;
    void putMeta("connected", true);
    void replayPending();
    postStatus();
  });
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    void receiveFrame(event.data).catch((err: unknown) => {
      postMessage({ kind: "error", error: errorMessage(err) });
    });
  });
  ws.addEventListener("close", () => {
    connecting = false;
    void putMeta("connected", false);
    postStatus();
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    connecting = false;
    void putMeta("connected", false);
    postStatus();
  });
}

async function receiveFrame(encoded: string): Promise<void> {
  // Every frame is decoded through the transport-neutral codec before cache
  // mutation so the browser worker rejects the same malformed envelopes as the
  // relay and in-process tests.
  const envelope = decodeEnvelope(encoded);
  await putFrame(envelope);
  if (envelope.type === "woo.transport.hello.v1") {
    await putMeta("hello", envelope.body);
    await putMeta("catchup_required", false);
  } else if (envelope.type === "woo.transport.error.v1") {
    const body = envelope.body as { code?: unknown };
    if (body.code === "E_RESET") await putMeta("catchup_required", true);
  } else if (envelope.reply_to) {
    await deletePending(envelope.reply_to);
  }
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
  // pending outbound envelopes for replay, and received frames for debugging
  // and future projection hydration.
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE);
      if (!database.objectStoreNames.contains(PENDING_STORE)) database.createObjectStore(PENDING_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(FRAME_STORE)) database.createObjectStore(FRAME_STORE, { keyPath: "id" });
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
  return await tx<PendingEnvelope[]>(PENDING_STORE, "readonly", (store) => store.getAll());
}

async function putFrame(envelope: ShadowEnvelope): Promise<void> {
  await tx(FRAME_STORE, "readwrite", (store) => store.put({ id: envelope.id, envelope, received_at: Date.now() }));
}

async function status(): Promise<V2CacheStatus> {
  return {
    connected: socket?.readyState === WebSocket.OPEN,
    pending: (await allPending()).length,
    last_hello: await getMeta("hello"),
    catchup_required: await getMeta("catchup_required")
  };
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
