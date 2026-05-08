import "./styles.css";
import chatManifest from "../../catalogs/chat/manifest.json";
import dubspaceManifest from "../../catalogs/dubspace/manifest.json";
import pinboardManifest from "../../catalogs/pinboard/manifest.json";
import tasksManifest from "../../catalogs/tasks/manifest.json";
import weatherManifest from "../../catalogs/weather/manifest.json";
import * as chatUiModule from "../../catalogs/chat/ui/chat-space";
import * as dubspaceUiModule from "../../catalogs/dubspace/ui/dubspace-workspace";
import * as pinboardUiModule from "../../catalogs/pinboard/ui/pinboard-board";
import * as tasksUiModule from "../../catalogs/tasks/ui/kanban-board";
import * as weatherUiModule from "../../catalogs/weather/ui/weather-badge";
import { appliedFrameErrorObservations, chatErrorText } from "./chat-errors";
import { createWooClientFramework, escapeHtml, liveProjectionKey, ProjectionFieldFiller, type CatalogUiPackage, type ProjectionCallOptions, type ProjectionPatch, type WooContext, type WooElement } from "./framework";
import { advanceProjectionCursor, idsFromRefsOrSummaries, presentActorsFromObservation, scopedHerePresentActors, scopedModelWithMoveResult, type ScopedProjectionStateModel } from "./scoped-projection";
import type { ChatLine, ChatSpaceData, ChatTitleBadge, SpaceChatPanelData } from "../../catalogs/chat/ui/chat-space";
import type { DubspaceData } from "../../catalogs/dubspace/ui/dubspace-workspace";
import type { PinboardData } from "../../catalogs/pinboard/ui/pinboard-board";

type AuthStatus = "checking" | "anonymous" | "authenticated";
type AuthMethod = "guest" | "apikey";

type AppState = {
  socket?: WebSocket;
  actor?: string;
  session?: string;
  authStatus: AuthStatus;
  loginError?: string;
  loginPending?: boolean;
  tab: "chat" | "dubspace" | "pinboard" | "tasks" | "ide";
  world?: any;
  scopedProjection?: ScopedProjectionStateModel;
  scopedObjectSummaries: Record<string, any>;
  routedSubjects: Partial<Record<"dubspace" | "pinboard" | "tasks", string>>;
  audioOn: boolean;
  clockOffset: number;
  cueSlots: Record<string, boolean>;
  cuePlaying: Record<string, boolean>;
  cueControls: Record<string, any>;
  chatFeed: ChatLine[];
  chatPresent: string[];
  chatDraft: string;
  spaceChatDrafts: Record<string, string>;
  spaceChatHeights: Record<string, number>;
  observations: any[];
  observationsCollapsed: boolean;
  selectedObject: string;
  scopedProjectionSmoke?: { me?: any; catalogs?: any; error?: string };
  pinboardNewText: string;
  pinboardNewColor: string;
  pinboardView: PinboardView;
  pinboardViewports: Record<string, PinboardViewportPresence>;
  compileResult?: any;
};

type ChatRoomPin = {
  room: string;
  expiresAt: number;
};

type RouteLocation = {
  objectId: string;
  view?: string;
};

function bundledSeedRef(manifest: any, classRef: string): string {
  return String(manifest?.seed_hooks?.find((hook: any) => hook?.kind === "create_instance" && hook?.class === classRef)?.as ?? "");
}

function bundledSeedRefs(manifest: any, classRef: string): string[] {
  return (manifest?.seed_hooks ?? [])
    .filter((hook: any) => hook?.kind === "create_instance" && hook?.class === classRef && typeof hook.as === "string")
    .map((hook: any) => String(hook.as));
}

type RenderFocusSnapshot = {
  tab: AppState["tab"];
  selector: string;
  value: string;
  selectionStart?: number;
  selectionEnd?: number;
};

type PinNoteBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type PinNoteAnimation = {
  id: string;
  from: PinNoteBox;
};

type PinboardView = {
  x: number;
  y: number;
  scale: number;
};

type PinboardViewportPresence = PinNoteBox & {
  actor: string;
  scale: number;
  at: number;
};

type PinboardMapModel = {
  minX: number;
  minY: number;
  spanX: number;
  spanY: number;
};

type PinboardRenderModel = {
  board: any;
  notes: any[];
  present: string[];
  palette: string[];
  viewport: { w?: unknown; h?: unknown };
};

const state: AppState = {
  tab: "chat",
  authStatus: "checking",
  scopedObjectSummaries: {},
  routedSubjects: {},
  audioOn: false,
  clockOffset: 0,
  cueSlots: {},
  cuePlaying: {},
  cueControls: {},
  chatFeed: [],
  chatPresent: [],
  chatDraft: "",
  spaceChatDrafts: {},
  spaceChatHeights: {},
  observations: [],
  observationsCollapsed: true,
  selectedObject: "",
  pinboardNewText: "",
  pinboardNewColor: "",
  pinboardView: { x: 0, y: 0, scale: 1 },
  pinboardViewports: {}
};

let audio: DubAudio | undefined;
const ui = createWooClientFramework();
let chatRoomPin: ChatRoomPin | null = null;
const bundledToolSeeds = {
  dubspace: bundledSeedRef(dubspaceManifest, "$dubspace"),
  pinboard: bundledSeedRef(pinboardManifest, "$pinboard"),
  tasks: bundledSeedRef(tasksManifest, "$task_registry")
} as const;
const bundledCatalogManifests: Record<string, any> = {
  dubspace: dubspaceManifest,
  pinboard: pinboardManifest,
  tasks: tasksManifest
};
const sessionKey = "woo.session";
const usernameKey = "woo.username";
const authMethodKey = "woo.authMethod";
const chatHistoryKey = "woo.chat.history";
const pinboardNewColorKey = "woo.pinboard.newColor";
const legacyPinboardChatHeightKey = "woo.pinboard.chatHeight";
const spaceChatHeightsKey = "woo.spaceChat.heights";
const scopedProjectionSmokeEnabled = new URLSearchParams(location.search).has("scopedProjectionSmoke");
let scopedProjectionEnabled = (() => {
  const params = new URLSearchParams(location.search);
  if (params.get("api") === "state" || params.has("legacyState")) return false;
  return true;
})();
const chatHistoryLimit = 80;
const drumVoices = [
  { id: "kick", label: "Kick" },
  { id: "snare", label: "Snare" },
  { id: "hat", label: "Hat" },
  { id: "tone", label: "Tone" }
] as const;
const PITCH_ROOT_FREQ = 110;
const PITCH_ROOT_MIDI = 45;
const PITCH_MIN_SEMITONE = -12;
const PITCH_MAX_SEMITONE = 36;
const LOOP_DEFAULT_SEMITONES = [0, 5, 10, 15];
const TONE_TRACK_SEMITONES = [19, 22, 24, 27];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const directThrottle = new Map<string, number>();
const pendingDirect = new Map<string, (result: any) => void>();
const pendingFrameErrors = new Map<string, (error: any) => void>();
const pendingCommands = new Map<string, { space: string; text: string }>();
let pinboardNotesRefreshPending = false;
const pendingOverlaySnapshots = new Map<string, Promise<void>>();
let scopedProjectionLocalRevision = 0;
const reconnectBaseDelayMs = 500;
const reconnectMaxDelayMs = 5000;
const heartbeatIntervalMs = 25_000;
const observationDisplayLimit = 20;
const PINBOARD_MIN_ZOOM = 0.35;
const PINBOARD_MAX_ZOOM = 2.75;
const PINBOARD_ZOOM_STEP = 1.2;
const PINBOARD_GRID_SIZE = 24;
const PINBOARD_VIEW_ANIMATION_MS = 480;
const PINBOARD_VIEWPORT_MIN_MS = 110;
const PINBOARD_MAP_DEFAULT_ASPECT = 0.42;
const SPACE_CHAT_DEFAULT_HEIGHT = 280;
const SPACE_CHAT_MIN_HEIGHT = 220;
const SPACE_CHAT_MAX_VIEWPORT_RATIO = 0.45;
const TAB_FROM_VIEW: Record<string, AppState["tab"]> = {
  chat: "chat",
  dubspace: "dubspace",
  pinboard: "pinboard",
  tasks: "tasks",
  kanban: "tasks",
  ide: "ide",
  editor: "ide"
};
let reconnectDelayMs = reconnectBaseDelayMs;
let reconnectTimer: number | undefined;
let heartbeatTimer: number | undefined;
let lastPongAt = 0;
let pinboardViewportTimer: number | undefined;
let pinboardViewAnimationTimer: number | undefined;
let lastPinboardViewportPublishAt = 0;
let lastPinboardViewportSent: PinNoteBox & { scale: number } | undefined;
const pinNoteClientZ = new Map<string, number>();
const PINBOARD_OPTIMISTIC_TTL_MS = 5_000;
let pinboardTextHydrationRequestedBoard = "";
let pinboardTextHydrationRequestedSignature = "";
let pinboardTextHydrationRequested = false;
let catalogUiEtag = "";
let catalogUiCache: any;
const installedCatalogUiAliases = new Set<string>();
let chatHistory = loadChatHistory();
let chatHistoryCursor = chatHistory.length;
let chatHistoryDraft = "";
let startupRoute: RouteLocation | null = parseLocationRoute(location.pathname, location.search);
let routeInitialized = false;
state.spaceChatHeights = loadSpaceChatHeights();

installBundledCatalogUi();
state.authStatus = readStorage(sessionKey) ? "authenticated" : "anonymous";
if (state.authStatus === "authenticated") connect();
else render();
window.setInterval(pruneLiveControls, 700);
window.addEventListener("resize", () => {
  normalizeSpaceChatHeights();
  schedulePinboardViewportPublish();
  window.requestAnimationFrame(updatePinboardMapViewports);
});
window.addEventListener("popstate", () => {
  void applyLocationRoute("replace");
});

function connect() {
  if (state.authStatus !== "authenticated") return;
  if (state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;
  socket.addEventListener("open", () => {
    reconnectDelayMs = reconnectBaseDelayMs;
    lastPongAt = Date.now();
    const token = authToken();
    if (!token) {
      socket.close();
      return;
    }
    const cursor = scopedProjectionEnabled ? state.scopedProjection?.cursor : undefined;
    sendSocket(socket, cursor ? { op: "auth", token, cursor } : { op: "auth", token });
    startHeartbeat(socket);
  });
  socket.addEventListener("message", async (event) => {
    const frame = JSON.parse(event.data);
    if (frame.op === "pong") {
      lastPongAt = Date.now();
      if (typeof frame.server_time === "number") state.clockOffset = frame.server_time - Date.now();
      return;
    }
    if (frame.op === "session") {
      state.actor = frame.actor;
      state.session = frame.session;
      storeSession(frame.session);
      projectionFiller.reset();
      render();
      try {
        await refresh();
      } catch {
        render();
      }
      requestReplay(socket);
      if (!scopedProjectionEnabled && shouldAutoEnterDefaultChatRoom()) ensureSpacePresence(chatRoom(), () => render(), () => render());
    }
    if (frame.op === "applied") {
      ui.ingestAppliedFrame(frame);
      applyScopedMoveResult(frame.result);
      const observations = frame.observations ?? [];
      const frameErrors = appliedFrameErrorObservations({ observations });
      receiveAppliedFrameErrors(frame, observations);
      // Sequenced verb raises arrive as `$error` observations inside applied
      // frames, so keep the pending handler until those observations route.
      if (typeof frame.id === "string") {
        const commandContext = pendingCommands.get(frame.id);
        if (frameErrors.length > 0) ui.failOptimisticCall(frame.id);
        else {
          ui.completeOptimisticCall(frame.id);
          if (commandContext) renderChatCommandResult(chatCommandUiActionFromMessage(frame.message), frame.result, commandContext.text);
        }
        pendingCommands.delete(frame.id);
        pendingFrameErrors.delete(frame.id);
      }
      const pinboardAnimations = capturePinboardAnimations(observations);
      const needsPinboardNotesRefresh = observations.some((observation: any) => isPinboardObservation(observation) && pinboardObservationNeedsNotesRefresh(String(observation?.type ?? "")));
      if (needsPinboardNotesRefresh) pinboardNotesRefreshPending = false;
      if (!scopedProjectionEnabled) {
        // Legacy /api/state mode still folds confirmed placement observations
        // into its pinboard note array. Scoped mode gets the same fields
        // through the framework reducer above.
        for (const observation of observations) {
          const type = String(observation?.type ?? "");
          if (type === "pin_moved" || type === "pin_resized" || type === "note_moved" || type === "note_resized") {
            const pinId = String(observation?.pin ?? observation?.id ?? "");
            if (pinId) applyPinboardPlacementObservation(observation);
          }
        }
      }
      forgetLiveControls(observations);
      if (observations.some((observation: any) => isDubspaceStateObservation(observation))) syncDubspaceProjectionEffects();
      for (const observation of observations) if (isChatObservation(observation)) receiveChatEvent(observation, false);
      state.observations.unshift({ seq: frame.seq, space: frame.space, observations, message: frame.message });
      trimObservations();
      rememberSeq(frame.space, frame.seq);
      scheduleLegacyStateRefresh();
      render();
      if (needsPinboardNotesRefresh) refreshPinboardNotes();
      animatePinboardNotes(pinboardAnimations);
    }
    if (frame.op === "event") {
      ui.ingestLiveObservation(frame.observation);
      receiveLiveEvent(frame.observation);
    }
    if (frame.op === "result") {
      const handler = pendingDirect.get(frame.id);
      if (typeof frame.id === "string") pendingFrameErrors.delete(frame.id);
      for (const observation of frame.observations ?? []) {
        ui.ingestLiveObservation(observation);
        receiveLiveEvent(observation);
      }
      applyScopedMoveResult(frame.result);
      if (typeof frame.id === "string") ui.completeOptimisticCall(frame.id);
      if (handler) {
        pendingDirect.delete(frame.id);
        if (typeof frame.id === "string") pendingCommands.delete(frame.id);
        handler(frame.result);
      } else if (typeof frame.id === "string") {
        const commandContext = pendingCommands.get(frame.id);
        if (commandContext) {
          pendingCommands.delete(frame.id);
          renderChatCommandResult(chatCommandUiActionFromPlan(frame.command), frame.result, commandContext.text);
        }
      }
    }
    if (frame.op === "task") {
      state.observations.unshift({ task: frame.task, space: frame.space, observations: frame.observations });
      trimObservations();
      scheduleLegacyStateRefresh();
      render();
    }
    if (frame.op === "replay") {
      for (const entry of frame.entries ?? []) {
        if (scopedProjectionEnabled && Array.isArray(entry?.observations)) {
          ui.ingestAppliedFrame({ op: "applied", seq: entry.seq, space: frame.space, observations: entry.observations });
          for (const observation of entry.observations) if (isChatObservation(observation)) receiveChatEvent(observation, false);
        }
        state.observations.unshift({ seq: entry.seq, space: frame.space, replay: true, message: entry.message, error: entry.error ?? null });
        rememberSeq(frame.space, entry.seq);
      }
      trimObservations();
      scheduleLegacyStateRefresh();
      render();
    }
    if (frame.op === "error") {
      const errorHandler = typeof frame.id === "string" ? pendingFrameErrors.get(frame.id) : undefined;
      if (typeof frame.id === "string") {
        ui.failOptimisticCall(frame.id);
        pendingDirect.delete(frame.id);
        pendingCommands.delete(frame.id);
        pendingFrameErrors.delete(frame.id);
      }
      if (frame.error?.code === "E_NOSESSION") {
        clearSession();
        if (socket.readyState === WebSocket.OPEN) socket.close();
        if (readAuthMethod() === "guest") {
          void loginAsGuest({ silent: true });
        } else {
          state.actor = undefined;
          state.session = undefined;
          state.authStatus = "anonymous";
          render();
        }
        return;
      }
      state.observations.unshift({ error: frame.error });
      trimObservations();
      if (errorHandler) errorHandler(frame.error);
      else render();
    }
  });
  socket.addEventListener("close", () => {
    if (state.socket !== socket) return;
    stopHeartbeat();
    pendingDirect.clear();
    pendingCommands.clear();
    pendingFrameErrors.clear();
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    if (state.socket === socket && socket.readyState !== WebSocket.CLOSED) socket.close();
  });
}

function sendSocket(socket: WebSocket, frame: Record<string, unknown>) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

function sendFrame(frame: Record<string, unknown>) {
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    scheduleReconnect();
    return false;
  }
  return sendSocket(socket, frame);
}

function scheduleReconnect() {
  if (state.authStatus !== "authenticated") return;
  if (reconnectTimer !== undefined) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, reconnectMaxDelayMs);
}

function startHeartbeat(socket: WebSocket) {
  stopHeartbeat();
  heartbeatTimer = window.setInterval(() => {
    if (state.socket !== socket) {
      stopHeartbeat();
      return;
    }
    if (Date.now() - lastPongAt > heartbeatIntervalMs * 3) {
      socket.close();
      return;
    }
    if (!sendSocket(socket, { op: "ping" })) {
      stopHeartbeat();
      scheduleReconnect();
    }
  }, heartbeatIntervalMs);
}

function stopHeartbeat() {
  if (heartbeatTimer === undefined) return;
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

function authToken(): string | null {
  const session = readStorage(sessionKey);
  return session ? `session:${session}` : null;
}

function storeSession(session: string | undefined) {
  if (session) writeStorage(sessionKey, session);
}

function clearSession() {
  try {
    sessionStorage.removeItem(sessionKey);
    localStorage.removeItem(sessionKey);
  } catch {
    // Ignore storage failures; the next boot falls back to the login screen.
  }
}

function readAuthMethod(): AuthMethod | null {
  const value = readStorage(authMethodKey);
  return value === "guest" || value === "apikey" ? value : null;
}

function storeAuthMethod(method: AuthMethod) {
  writeStorage(authMethodKey, method);
}

function clearAuthMethod() {
  try {
    localStorage.removeItem(authMethodKey);
  } catch {
    // Ignore.
  }
}

function readUsername(): string {
  return readStorage(usernameKey) ?? "";
}

function storeUsername(username: string) {
  writeStorage(usernameKey, username);
}

async function postAuth(token: string): Promise<{ session: string; actor: string } | { error: string }> {
  let response: Response;
  try {
    response = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token })
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "network error" };
  }
  let body: any;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = body?.error?.message ?? `HTTP ${response.status}`;
    return { error: String(message) };
  }
  if (typeof body?.session !== "string" || typeof body?.actor !== "string") {
    return { error: "malformed auth response" };
  }
  return { session: body.session, actor: body.actor };
}

async function loginAsGuest(options: { silent?: boolean } = {}) {
  if (state.loginPending) return;
  state.loginPending = true;
  if (!options.silent) {
    state.loginError = undefined;
    render();
  }
  const result = await postAuth("guest:local");
  state.loginPending = false;
  if ("error" in result) {
    state.loginError = `Could not start guest session: ${result.error}`;
    state.authStatus = "anonymous";
    render();
    return;
  }
  storeSession(result.session);
  storeAuthMethod("guest");
  state.actor = result.actor;
  state.session = result.session;
  state.authStatus = "authenticated";
  state.loginError = undefined;
  render();
  connect();
}

async function loginWithApiKey(username: string, secret: string) {
  if (state.loginPending) return;
  if (!username || !secret) {
    state.loginError = "Username and password are required.";
    render();
    return;
  }
  state.loginPending = true;
  state.loginError = undefined;
  render();
  const result = await postAuth(`apikey:${username}:${secret}`);
  state.loginPending = false;
  if ("error" in result) {
    state.loginError = `Sign-in failed: ${result.error}`;
    render();
    return;
  }
  storeSession(result.session);
  storeAuthMethod("apikey");
  storeUsername(username);
  state.actor = result.actor;
  state.session = result.session;
  state.authStatus = "authenticated";
  render();
  connect();
}

async function logout() {
  const sessionId = state.session;
  state.socket?.close();
  state.socket = undefined;
  if (sessionId) {
    try {
      await fetch("/api/session", { method: "DELETE", headers: { authorization: `Session ${sessionId}` } });
    } catch {
      // best-effort; the local session is already cleared
    }
  }
  // Drop everything account-scoped (chat history, replay cursors, pinboard
  // prefs, etc.) so the next login starts clean. Keep `woo.username` so the
  // form pre-fills.
  clearAccountScopedStorage();
  // Reload to drop module-level state (framework caches, pending maps, audio,
  // chatHistory) without needing to enumerate every field.
  location.reload();
}

function clearAccountScopedStorage() {
  try {
    const keep = new Set([usernameKey]);
    const drop: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("woo.") && !keep.has(key)) drop.push(key);
    }
    for (const key of drop) localStorage.removeItem(key);
  } catch {
    // Storage unavailable — nothing to clear.
  }
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }
}

function requestReplay(socket: WebSocket) {
  if (scopedProjectionEnabled) {
    const cursorSpaces = state.scopedProjection?.cursor?.spaces ?? {};
    for (const [space, cursor] of Object.entries(cursorSpaces)) {
      const from = Number(cursor?.next_seq ?? 0);
      if (from > 0) sendSocket(socket, { op: "replay", id: crypto.randomUUID(), space, from, limit: 100 });
    }
    return;
  }
  for (const space of Object.keys(state.world?.spaces ?? {})) {
    const from = Number(readStorage(`woo.lastSeq.${space}`) ?? "0") + 1;
    if (from > 1) sendSocket(socket, { op: "replay", id: crypto.randomUUID(), space, from, limit: 100 });
  }
}

function rememberSeq(space: string, seq: number) {
  if (scopedProjectionEnabled && state.scopedProjection) {
    state.scopedProjection = {
      ...state.scopedProjection,
      cursor: advanceProjectionCursor(state.scopedProjection.cursor, space, seq)
    };
  }
  const key = `woo.lastSeq.${space}`;
  const current = Number(readStorage(key) ?? "0");
  if (seq > current) writeStorage(key, String(seq));
}

function readStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Local storage is an optimization for reconnect continuity.
  }
}

function parseLocationRoute(pathname: string, search: string): RouteLocation | null {
  if (!pathname.startsWith("/objects/")) return null;
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "objects") return null;
  const rawObject = parts[1] ?? "";
  if (!rawObject) return null;
  try {
    const objectId = decodeURIComponent(rawObject);
    const searchParams = new URLSearchParams(search);
    const view = searchParams.get("view") ?? undefined;
    return { objectId: String(objectId), view: view && view.trim() ? view.trim() : undefined };
  } catch {
    return null;
  }
}

function tabFromViewHint(view?: string): AppState["tab"] | undefined {
  if (!view) return undefined;
  return TAB_FROM_VIEW[view.trim().toLowerCase()];
}

function objectIdForTab(tab: AppState["tab"]): string {
  if (tab === "chat") return activeChatRoom();
  if (tab === "dubspace") return dubspaceSpace();
  if (tab === "pinboard") return pinboardSpace();
  if (tab === "tasks") return tasksSpace();
  if (tab === "ide") return state.selectedObject || defaultSelectedObject();
  return "";
}

function canonicalRouteForCurrentState(tab: AppState["tab"] = state.tab): RouteLocation | null {
  const objectId = objectIdForTab(tab);
  if (!objectId) return null;
  return { objectId };
}

function canonicalRoutePath(route: RouteLocation): string {
  // Keep canonical-readable corenames (e.g. `$wiz`) in the URL for readability.
  // For non-corenames, keep percent-encoding behavior for path safety.
  const objectPathPart = /^\$[A-Za-z0-9_]+$/.test(route.objectId)
    ? route.objectId
    : encodeURIComponent(route.objectId);

  // Canonical routing prefers inferred tabs from object identity over the
  // transient `view=` hint in the URL.
  return `/objects/${objectPathPart}`;
}

function syncUrlFromCurrentState(mode: "replace" | "push" = "replace") {
  const route = canonicalRouteForCurrentState();
  if (!route) return;
  const next = canonicalRoutePath(route);
  const current = `${location.pathname}${location.search}`;
  if (current === next) {
    if (mode === "replace") {
      history.replaceState({}, "", current);
    }
    return;
  }
  if (mode === "replace") history.replaceState({}, "", next);
  else history.pushState({}, "", next);
}

function routeForObjectId(objectId: string, summary?: any): AppState["tab"] {
  if (scopedProjectionEnabled) {
    if (objectId === activeChatRoom()) return "chat";
    if (objectId === dubspaceSpace()) return "dubspace";
    if (objectId === pinboardSpace()) return "pinboard";
    if (objectId === tasksSpace()) return "tasks";
    const summaryTab = tabForScopedSummary(objectId, summary ?? scopedObjectSummary(objectId));
    if (summaryTab) return summaryTab;
    return "ide";
  }
  if (objectId === activeChatRoom()) return "chat";
  if (objectId === dubspaceSpace()) return "dubspace";
  if (objectId === pinboardSpace()) return "pinboard";
  if (objectId === tasksSpace()) return "tasks";
  if (state.world?.objects?.[objectId]) return "ide";
  return "chat";
}

function pinRoutedSubject(tab: AppState["tab"], subject: string) {
  if (!scopedProjectionEnabled || !subject) return;
  if (tab === "dubspace" || tab === "pinboard" || tab === "tasks") {
    state.routedSubjects = { ...state.routedSubjects, [tab]: subject };
  }
}

function routeSubjectForTab(tab: AppState["tab"], routedObject: string, _summary: any): string {
  if (!scopedProjectionEnabled) return "";
  if (tab === "dubspace" || tab === "pinboard" || tab === "tasks") return routedObject;
  return "";
}

async function applyLocationRoute(mode: "replace" | "push", route: RouteLocation | null = parseLocationRoute(location.pathname, location.search)) {
  if (!route || !route.objectId) {
    syncUrlFromCurrentState(mode);
    return;
  }
  const ensureTabPresence = (tab: AppState["tab"]) => {
    if (tab === "dubspace") enterDubspace();
    if (tab === "pinboard") enterPinboard();
  };
  const viewTab = tabFromViewHint(route.view);
  if (viewTab) {
    const summary = scopedProjectionEnabled ? await fetchScopedObjectSummary(route.objectId).catch(() => undefined) : undefined;
    if (viewTab === "ide" && (scopedProjectionEnabled || state.world?.objects?.[route.objectId])) setSelectedObject(route.objectId, { apply: false });
    pinRoutedSubject(viewTab, routeSubjectForTab(viewTab, route.objectId, summary));
    setTab(viewTab, { mode, leaveCurrent: true }, () => {
      ensureTabPresence(viewTab);
    });
    return;
  }

  const summary = scopedProjectionEnabled ? await fetchScopedObjectSummary(route.objectId).catch(() => undefined) : undefined;
  const inferredTab = routeForObjectId(route.objectId, summary);
  if (inferredTab === "ide" && (scopedProjectionEnabled || state.world?.objects?.[route.objectId])) {
    setSelectedObject(route.objectId, { apply: false });
    setTab(inferredTab, { mode, leaveCurrent: true }, () => {
      ensureTabPresence(inferredTab);
    });
    return;
  }
  pinRoutedSubject(inferredTab, routeSubjectForTab(inferredTab, route.objectId, summary));
  setTab(inferredTab, { mode, leaveCurrent: true }, () => {
    ensureTabPresence(inferredTab);
  });
}

function setTab(tab: AppState["tab"], options: { mode?: "replace" | "push"; leaveCurrent?: boolean } = {}, done?: () => void) {
  const mode = options.mode ?? "push";
  const leaveCurrent = options.leaveCurrent ?? true;
  const current = state.tab;
  const finalize = () => {
    if (state.tab !== tab) state.tab = tab;
    syncUrlFromCurrentState(mode);
    if (typeof done === "function") done();
    render();
    if (scopedProjectionEnabled && tab !== "chat" && tab !== "ide") {
      void ensureScopedOverlayForTab(tab).then(() => {
        if (state.tab === tab) render();
      }).catch((err) => {
        console.error("overlay snapshot failed", err);
      });
    }
  };
  if (current === tab) {
    syncUrlFromCurrentState(mode);
    if (typeof done === "function") done();
    render();
    return;
  }
  if (!leaveCurrent) {
    finalize();
    return;
  }
  if (current === "dubspace" && tab !== "dubspace") {
    leaveDubspace(finalize);
    return;
  }
  if (current === "pinboard" && tab !== "pinboard") {
    leavePinboard(finalize);
    return;
  }
  finalize();
}

function setSelectedObject(id: string, options: { apply?: boolean } = {}) {
  state.selectedObject = id;
  if (scopedProjectionEnabled && id) {
    void fetchScopedObjectSummary(id).then(() => {
      if (state.tab === "ide" && state.selectedObject === id) render();
    }).catch((err) => {
      state.scopedObjectSummaries = { ...state.scopedObjectSummaries, [id]: { id, error: err instanceof Error ? err.message : String(err) } };
      if (state.tab === "ide" && state.selectedObject === id) render();
    });
  }
  if (options.apply !== false) {
    syncUrlFromCurrentState("replace");
    render();
  }
}

let lastObservedChatRoom = "";
const chatSeparatorMinIntervalMs = 2_000;
const lastChatSeparatorAtBySource = new Map<string, number>();

async function refresh() {
  if (scopedProjectionEnabled) {
    await refreshScopedProjection();
    return;
  }
  refreshDebounceTimer = null;
  refreshDebouncePending = false;
  const response = await fetch("/api/state", { headers: authHeaders() });
  if (!response.ok) return;
  const previousChatRoom = lastObservedChatRoom;
  state.world = adaptWorld(await response.json());
  ui.ingestWorld(state.world);
  const currentChatRoom = chatRoom();
  if (previousChatRoom && previousChatRoom !== currentChatRoom) {
    // Mark the bottom of the room the actor just left, so when they return
    // the room's prior chat (including their `> enter tub` input echo) is
    // visually behind a "you were away" boundary.
    pushChatSeparator(previousChatRoom, false);
  }
  lastObservedChatRoom = currentChatRoom;
  if (!state.selectedObject || !state.world.objects?.[state.selectedObject]) state.selectedObject = defaultSelectedObject();
  state.clockOffset = Number(state.world.server_time ?? Date.now()) - Date.now();
  state.chatPresent = Array.isArray(state.world?.chat?.present) ? state.world.chat.present : state.chatPresent;
  if (scopedProjectionSmokeEnabled) await refreshScopedProjectionSmoke();
  if (!routeInitialized) {
    routeInitialized = true;
    if (startupRoute) {
      void applyLocationRoute("replace", startupRoute);
      startupRoute = null;
    } else {
      syncUrlFromCurrentState("replace");
    }
  } else {
    syncUrlFromCurrentState("replace");
  }
  audio?.sync(effectiveDubspace(), state.clockOffset);
  hydratePinboardNotesTextIfNeeded(pinboardModel());
  render();
}

async function refreshScopedProjectionSmoke() {
  try {
    const [meResponse, catalogsResponse] = await Promise.all([
      fetch("/api/me", { headers: authHeaders() }),
      fetch("/api/catalogs/ui", { headers: authHeaders() })
    ]);
    if (!meResponse.ok) throw new Error(`/api/me ${meResponse.status}`);
    if (!catalogsResponse.ok) throw new Error(`/api/catalogs/ui ${catalogsResponse.status}`);
    state.scopedProjectionSmoke = {
      me: await meResponse.json(),
      catalogs: await catalogsResponse.json()
    };
  } catch (err) {
    state.scopedProjectionSmoke = { error: err instanceof Error ? err.message : String(err) };
  }
}

async function refreshScopedProjection() {
  refreshDebounceTimer = null;
  refreshDebouncePending = false;
  const startedRevision = scopedProjectionLocalRevision;
  try {
    const [meResponse, catalogs] = await Promise.all([
      fetch("/api/me", { headers: authHeaders() }),
      fetchCatalogUiIndex()
    ]);
    if (!meResponse.ok) throw new Error(`/api/me ${meResponse.status}`);
    const me = await meResponse.json();
    if (scopedProjectionLocalRevision !== startedRevision) {
      state.scopedProjection = {
        ...(state.scopedProjection ?? { inventory: [], overlays: {} }),
        catalogs,
        overlaySnapshots: state.scopedProjection?.overlaySnapshots ?? {}
      };
      return;
    }
    await applyScopedProjectionSnapshot(me, catalogs);
    state.scopedProjectionSmoke = scopedProjectionSmokeEnabled ? { me, catalogs } : state.scopedProjectionSmoke;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.scopedProjection = {
      ...(state.scopedProjection ?? { inventory: [], overlays: {} }),
      error: message,
      inventory: state.scopedProjection?.inventory ?? [],
      overlays: state.scopedProjection?.overlays ?? {},
      overlaySnapshots: state.scopedProjection?.overlaySnapshots ?? {}
    };
    if (scopedProjectionSmokeEnabled) state.scopedProjectionSmoke = { error: message };
  }
  render();
}

async function fetchCatalogUiIndex() {
  const headers = catalogUiEtag ? authHeaders({ "if-none-match": catalogUiEtag }) : authHeaders();
  const response = await fetch("/api/catalogs/ui", { headers });
  if (response.status === 304 && catalogUiCache) return catalogUiCache;
  if (!response.ok) throw new Error(`/api/catalogs/ui ${response.status}`);
  const body = await response.json();
  const nextEtag = response.headers.get("etag") ?? "";
  catalogUiCache = body;
  // Catalog UI modules/custom elements are loaded once per page lifetime in
  // this migration slice. A changed ETag is observed here, but hot-swapping UI
  // code safely waits for the installed-catalog loader work.
  catalogUiEtag = nextEtag;
  installCatalogUiIndex(body);
  return body;
}

function installCatalogUiIndex(index: any) {
  for (const pkg of Array.isArray(index?.catalogs) ? index.catalogs : []) {
    if (!pkg?.ui || typeof pkg.alias !== "string" || typeof pkg.catalog !== "string") continue;
    if (installedCatalogUiAliases.has(pkg.alias)) continue;
    const diagnostics = ui.catalogUi.installCatalogUi(pkg as CatalogUiPackage);
    if (diagnostics.length > 0) console.warn(`catalog UI diagnostics for ${pkg.alias}: ${diagnostics.join("; ")}`);
    else installedCatalogUiAliases.add(pkg.alias);
  }
}

async function ensureScopedOverlayForTab(tab: AppState["tab"], options: { force?: boolean } = {}): Promise<void> {
  if (!scopedProjectionEnabled) return;
  const subject = overlaySubjectForTab(tab);
  if (!subject) return;
  const key = `${tab}:${subject}`;
  if (!options.force && state.scopedProjection?.overlaySnapshots?.[key]) return;
  const pending = pendingOverlaySnapshots.get(key);
  if (pending && !options.force) return await pending;
  const request = (async () => {
    const response = await fetch(`/api/objects/${encodeURIComponent(subject)}/ui-snapshot?surface=${encodeURIComponent(tab)}`, { headers: authHeaders() });
    if (!response.ok) throw new Error(`/api/objects/${subject}/ui-snapshot ${response.status}`);
    applyScopedOverlaySnapshot(key, await response.json());
  })();
  pendingOverlaySnapshots.set(key, request);
  try {
    await request;
  } finally {
    if (pendingOverlaySnapshots.get(key) === request) pendingOverlaySnapshots.delete(key);
  }
}

function overlaySubjectForTab(tab: AppState["tab"]): string {
  if (tab === "dubspace") return dubspaceSpace();
  if (tab === "pinboard") return pinboardSpace();
  return "";
}

function scopedToolSubject(surface: "dubspace" | "pinboard" | "tasks"): string {
  if (!scopedProjectionEnabled) return "";
  const className = surface === "dubspace" ? "$dubspace" : surface === "pinboard" ? "$pinboard" : "$task_registry";
  const overlays = state.scopedProjection?.overlays ?? {};
  for (const handle of Object.values(overlays)) {
    const subject = typeof (handle as any)?.subject === "string" ? (handle as any).subject : "";
    const handleSurface = typeof (handle as any)?.surface === "string" ? (handle as any).surface : "";
    if (subject && handleSurface === surface) return subject;
  }
  const current = state.scopedProjection?.session?.current_location;
  if (typeof current === "string" && isCatalogObjectSummary(ui.observe(current), surface, className)) return current;
  for (const item of arrayOfObjects(state.scopedProjection?.here?.contents)) {
    if (isCatalogObjectSummary(item, surface, className)) return String(item.id ?? "");
  }
  return "";
}

function applyScopedOverlaySnapshot(key: string, snapshot: any) {
  if (!scopedProjectionEnabled || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return;
  if (!state.scopedProjection) state.scopedProjection = { inventory: [], overlays: {} };
  const overlaySnapshots = { ...(state.scopedProjection.overlaySnapshots ?? {}), [key]: snapshot };
  const subject = typeof snapshot.subject === "string" ? snapshot.subject : "";
  const surface = typeof snapshot.surface === "string" ? snapshot.surface : "default";
  const overlays = subject
    ? { ...(state.scopedProjection.overlays ?? {}), [key]: { subject, surface, restore: true } }
    : state.scopedProjection.overlays ?? {};
  state.scopedProjection = { ...state.scopedProjection, overlays, overlaySnapshots };
  const objects = overlaySnapshotProjectionObjects(snapshot);
  ui.ingestSnapshot(`overlay:${key}`, objects);
  if (snapshot.cursor?.spaces) {
    for (const [space, record] of Object.entries(snapshot.cursor.spaces)) {
      const nextSeq = Number((record as any)?.next_seq);
      if (Number.isFinite(nextSeq)) state.scopedProjection.cursor = advanceProjectionCursor(state.scopedProjection.cursor, space, nextSeq - 1);
    }
  }
  applyScopedProjectionModel();
  if (surface === "pinboard") {
    hydratePinboardNotesTextIfNeeded(pinboardModel());
  }
}

async function applyScopedProjectionSnapshot(me: any, catalogs: any) {
  const previousChatRoom = lastObservedChatRoom;
  const inventory = Array.isArray(me?.inventory) ? me.inventory : [];
  const overlays = me?.overlays && typeof me.overlays === "object" && !Array.isArray(me.overlays) ? me.overlays : {};
  const overlaySnapshots = state.scopedProjection?.overlaySnapshots ?? {};
  state.actor = typeof me?.session?.actor === "string" ? me.session.actor : state.actor;
  state.scopedProjection = {
    me,
    catalogs,
    cursor: me?.cursor,
    self: me?.self,
    session: me?.session,
    here: me?.here ?? null,
    inventory,
    overlays,
    overlaySnapshots
  };
  ingestScopedSnapshots(me);
  const currentChatRoom = chatRoom();
  if (previousChatRoom && previousChatRoom !== currentChatRoom) pushChatSeparator(previousChatRoom, false);
  lastObservedChatRoom = currentChatRoom;
  state.clockOffset = Number(me?.server_time ?? Date.now()) - Date.now();
  state.chatPresent = scopedHerePresentActors(me?.here);
  if (!state.selectedObject) state.selectedObject = defaultSelectedObject();
  if (!routeInitialized) {
    routeInitialized = true;
    if (startupRoute) {
      await applyLocationRoute("replace", startupRoute);
      startupRoute = null;
    } else {
      syncUrlFromCurrentState("replace");
    }
  } else {
    syncUrlFromCurrentState("replace");
  }
}

function ingestScopedSnapshots(me: any) {
  const self = me?.self ? [me.self] : [];
  const inventory = Array.isArray(me?.inventory) ? me.inventory : [];
  ui.ingestSnapshot("me", [...self, ...inventory]);
  ui.ingestSnapshot("here", roomSnapshotObjects(me?.here));
  for (const [name, handle] of Object.entries(me?.overlays ?? {})) {
    const subject = typeof (handle as any)?.subject === "string" ? (handle as any).subject : "";
    if (subject) ui.ingestSnapshot(`overlay:${name}:${subject}`, [{ id: subject }]);
  }
}

function scopedObjectSummary(id: string | undefined): any | undefined {
  if (!id) return undefined;
  const fetched = state.scopedObjectSummaries[id];
  if (fetched) return fetched;
  const projected = ui.observe(id);
  return isCompleteScopedSummary(projected) ? projected : undefined;
}

async function fetchScopedObjectSummary(id: string): Promise<any | undefined> {
  if (!scopedProjectionEnabled || !id) return undefined;
  const cached = state.scopedObjectSummaries[id] ?? (isCompleteScopedSummary(ui.observe(id)) ? ui.observe(id) : undefined);
  if (cached) return cached;
  const response = await fetch(`/api/objects/${encodeURIComponent(id)}/summary`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`/api/objects/${id}/summary ${response.status}`);
  const summary = await response.json();
  state.scopedObjectSummaries = { ...state.scopedObjectSummaries, [id]: summary };
  ui.ingestSnapshot(`summary:${id}`, [summary]);
  return summary;
}

function isCompleteScopedSummary(summary: any): boolean {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
  if (typeof summary.parent === "string") return true;
  if (Array.isArray(summary.ancestors) && summary.ancestors.length > 0) return true;
  if (summary.props && typeof summary.props === "object" && !Array.isArray(summary.props) && Object.keys(summary.props).length > 0) return true;
  return typeof summary.name === "string" && summary.name !== String(summary.id ?? "");
}

// Direct fetch path that ignores fetchScopedObjectSummary's "good enough for
// navigation" cache shortcut: thin room-contents summaries carry parent and
// ancestors, satisfying that shortcut, but still lack the props a title-badge
// component needs. Field-level fills must hit the network.
async function fetchObjectSummaryForFill(subject: string): Promise<void> {
  const response = await fetch(`/api/objects/${encodeURIComponent(subject)}/summary`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`/api/objects/${subject}/summary ${response.status}`);
  const summary = await response.json();
  state.scopedObjectSummaries = { ...state.scopedObjectSummaries, [subject]: summary };
  ui.ingestSnapshot(`summary:${subject}`, [summary]);
}

let projectionFillRenderQueued = false;
const projectionFiller = new ProjectionFieldFiller(
  (subject) => ui.observe(subject),
  fetchObjectSummaryForFill,
  () => {
    if (projectionFillRenderQueued) return;
    projectionFillRenderQueued = true;
    queueMicrotask(() => {
      projectionFillRenderQueued = false;
      render();
    });
  }
);

function ensureProjectionFields(subject: string, fields: readonly string[]): void {
  if (!scopedProjectionEnabled) return;
  projectionFiller.ensure(subject, fields);
}

function tabForScopedSummary(id: string, summary: any): AppState["tab"] | undefined {
  if (!summary) return undefined;
  if (id === activeChatRoom() || isRoomSummary(summary)) return "chat";
  if (isCatalogObjectSummary(summary, "dubspace", "$dubspace")) return "dubspace";
  if (isCatalogObjectSummary(summary, "pinboard", "$pinboard")) return "pinboard";
  if (isCatalogObjectSummary(summary, "tasks", "$task_registry")) return "tasks";
  return undefined;
}

function isRoomSummary(summary: any): boolean {
  const chatroom = activeCatalogClass("chat", "$chatroom") ?? "$chatroom";
  const ancestors = Array.isArray(summary?.ancestors) ? summary.ancestors.map(String) : [];
  return summary?.parent === chatroom || ancestors.includes(chatroom) || summary?.parent === "$room" || ancestors.includes("$room");
}

function roomSnapshotObjects(here: any): any[] {
  if (!here || typeof here !== "object") return [];
  return [
    roomSnapshotAsObjectSummary(here),
    ...arrayOfObjects(here.present_actors),
    ...arrayOfObjects(here.contents),
    ...arrayOfObjects(here.exits)
  ];
}

function arrayOfObjects(value: any): any[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
}

function scopedSummaryForObject(id: string, fallbackName?: string, location?: string): any {
  const projected = ui.observe(id);
  if (projected) {
    return {
      id,
      name: projected.name ?? fallbackName ?? id,
      owner: projected.owner,
      parent: projected.parent,
      ancestors: Array.isArray(projected.ancestors) ? projected.ancestors : [],
      features: Array.isArray(projected.features) ? projected.features : [],
      aliases: Array.isArray(projected.aliases) ? projected.aliases : [],
      location: location ?? projected.location,
      props: { ...(projected.props ?? {}) },
      catalogState: { ...(projected.catalogState ?? {}) }
    };
  }
  return {
    id,
    name: fallbackName ?? id,
    location,
    props: {},
    catalogState: {}
  };
}

function upsertSummaryById(list: any[], summary: any): any[] {
  const id = String(summary?.id ?? "");
  if (!id) return list;
  const next = list.filter((item) => String(item?.id ?? "") !== id);
  next.push(summary);
  return next;
}

function removeSummaryById(list: any[], id: string): any[] {
  return list.filter((item) => String(item?.id ?? "") !== id);
}

function roomSnapshotAsObjectSummary(here: any): any {
  return {
    id: String(here.id ?? ""),
    name: typeof here.name === "string" ? here.name : String(here.id ?? ""),
    parent: here.parent,
    ancestors: Array.isArray(here.ancestors) ? here.ancestors : [],
    features: Array.isArray(here.features) ? here.features : [],
    description: typeof here.description === "string" ? here.description : null,
    contents: [
      ...idsFromRefsOrSummaries(Array.isArray(here.contents) ? here.contents : []),
      ...idsFromRefsOrSummaries(Array.isArray(here.present_actors) ? here.present_actors : [])
    ],
    props: {
      ...(here.props && typeof here.props === "object" && !Array.isArray(here.props) ? here.props : {}),
      description: typeof here.description === "string" ? here.description : undefined,
      subscribers: scopedHerePresentActors(here)
    }
  };
}

function overlaySnapshotObjects(snapshot: any): any[] {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
  return [
    // Room snapshots intentionally carry thin contents; overlay objects carry
    // the full subject neighborhood. Put thin records first so full overlay
    // summaries win when the projection ingests duplicate ids.
    ...roomSnapshotObjects(snapshot.room),
    ...arrayOfObjects(snapshot.objects)
  ];
}

function overlaySnapshotProjectionObjects(snapshot: any): any[] {
  const objects = overlaySnapshotObjects(snapshot);
  if (snapshot?.surface !== "pinboard") return objects;
  const subject = typeof snapshot?.subject === "string" ? snapshot.subject : "";
  const board = objects.find((item) => String(item?.id ?? "") === subject);
  const layout = pinboardLayoutFromBoard(board);
  if (!subject || Object.keys(layout).length === 0) return objects;
  return objects.map((item) => {
    const id = String(item?.id ?? "");
    if (!id || !isPinboardNoteSummary(item, subject, layout)) return item;
    return {
      ...item,
      catalogState: {
        ...(item.catalogState ?? {}),
        pinboard_note: {
          ...(item.catalogState?.pinboard_note ?? {}),
          ...pinboardNoteStateFromSummary(item, layout[id])
        }
      }
    };
  });
}

// Legacy `/api/state` refresh used only when the page is explicitly booted in
// state-projection mode. Scoped mode applies frame observations locally and
// hydrates through `/api/me` or overlay snapshots.
const REFRESH_DEBOUNCE_MS = 750;
let refreshDebounceTimer: number | null = null;
let refreshDebouncePending = false;
function scheduleLegacyStateRefresh() {
  if (scopedProjectionEnabled) return;
  if (refreshDebounceTimer != null) return;
  refreshDebouncePending = true;
  refreshDebounceTimer = window.setTimeout(() => {
    refreshDebounceTimer = null;
    if (!refreshDebouncePending) return;
    void refresh();
  }, REFRESH_DEBOUNCE_MS);
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return state.session ? { ...extra, authorization: `Session ${state.session}` } : extra;
}

function adaptWorld(raw: any) {
  const world = raw && typeof raw === "object" ? { ...raw } : {};
  world.objects = raw?.objects ?? {};
  world.catalogs = raw?.catalogs ?? { installed: [] };
  world.dubspaceMeta = buildDubspaceMeta(world);
  world.dubspace = projectDubspace(world, world.dubspaceMeta);
  world.pinboardMeta = buildPinboardMeta(world);
  world.pinboard = projectPinboard(world, world.pinboardMeta);
  world.chatMeta = buildChatMeta(world);
  world.chat = projectChat(world, world.chatMeta);
  return world;
}

function installedCatalog(world: any, name: string): any | undefined {
  const installed = Array.isArray(world?.catalogs?.installed) ? world.catalogs.installed : [];
  const record = installed.find((item: any) => item?.alias === name || item?.catalog === name);
  return record ?? (world?.scoped ? bundledCatalogRecord(name) : undefined);
}

function activeInstalledCatalog(name: string): any | undefined {
  if (!scopedProjectionEnabled) return installedCatalog(state.world, name);
  const installed = Array.isArray(state.scopedProjection?.catalogs?.catalogs)
    ? state.scopedProjection.catalogs.catalogs
    : Array.isArray(catalogUiCache?.catalogs)
      ? catalogUiCache.catalogs
      : [];
  return installed.find((item: any) => item?.alias === name || item?.catalog === name) ?? bundledCatalogRecord(name);
}

function activeCatalogClass(catalogName: string, localName: string): string | undefined {
  return catalogClass(activeInstalledCatalog(catalogName), localName);
}

function bundledCatalogRecord(name: string): any | undefined {
  const manifest = bundledCatalogManifests[name];
  if (!manifest) return undefined;
  const definitions = [
    ...(Array.isArray(manifest.classes) ? manifest.classes : []),
    ...(Array.isArray(manifest.features) ? manifest.features : [])
  ];
  return {
    alias: name,
    catalog: name,
    version: manifest.version,
    objects: Object.fromEntries(definitions
      .map((item: any): [string, string] => [String(item.local_name ?? ""), String(item.local_name ?? "")])
      .filter((entry: [string, string]) => Boolean(entry[0]))),
    seeds: Object.fromEntries((manifest.seed_hooks ?? [])
      .filter((hook: any) => hook?.kind === "create_instance" && typeof hook.as === "string")
      .map((hook: any) => [String(hook.as), String(hook.as)]))
  };
}

function installedCatalogSeed(world: any, catalogName: string, fallback: string): string | undefined {
  const catalog = installedCatalog(world, catalogName);
  if (!catalog) return undefined;
  const seeds = catalog?.seeds && typeof catalog.seeds === "object" && !Array.isArray(catalog.seeds) ? catalog.seeds : {};
  const values = Object.values(seeds).filter((item): item is string => typeof item === "string");
  // Transitional scoped renderer fallback: bundled demo catalogs have one
  // canonical tool seed each. Real multi-instance selection belongs in frame
  // resolution/route state, not this compatibility metadata path.
  return values.find((id) => id === fallback) ?? values[0] ?? (fallback || undefined);
}

function activeInstalledCatalogSeed(catalogName: string, fallback: string): string {
  const catalog = activeInstalledCatalog(catalogName);
  if (!catalog) return fallback || "";
  const seeds = catalog?.seeds && typeof catalog.seeds === "object" && !Array.isArray(catalog.seeds) ? catalog.seeds : {};
  const values = Object.values(seeds).filter((item): item is string => typeof item === "string");
  return values.find((id) => id === fallback) ?? values[0] ?? (fallback || "");
}

function catalogClass(catalog: any, localName: string): string | undefined {
  const value = catalog?.objects?.[localName];
  return typeof value === "string" ? value : undefined;
}

function objectsByParent(world: any, parent: string | undefined, anchor?: string | null): string[] {
  if (!parent) return [];
  return Object.entries(world.objects ?? {})
    .filter(([, obj]: [string, any]) => obj?.parent === parent && (anchor === undefined || obj?.anchor === anchor || obj?.location === anchor))
    .map(([id]) => id)
    .sort((a, b) => objectName(world, a).localeCompare(objectName(world, b)) || a.localeCompare(b));
}

function firstObjectByParent(world: any, parent: string | undefined): string | undefined {
  return objectsByParent(world, parent)[0];
}

function objectView(world: any, id: string | undefined) {
  if (!id) return null;
  const obj = world.objects?.[id];
  if (!obj) return null;
  return { id, name: obj.name ?? id, owner: obj.owner, parent: obj.parent, location: obj.location, props: obj.props ?? {} };
}

function projectedObjectView(id: string | undefined) {
  if (!id) return null;
  const projected = ui.observe(id);
  if (projected) {
    return {
      id,
      name: projected.name ?? id,
      owner: projected.owner,
      parent: projected.parent,
      location: projected.location,
      props: { ...(projected.props ?? {}) }
    };
  }
  if (scopedProjectionEnabled) return null;
  const fallback = state.world?.dubspace?.[id] ?? objectView(state.world, id);
  if (!fallback) return null;
  return {
    id,
    name: fallback.name ?? id,
    owner: fallback.owner,
    parent: fallback.parent,
    location: fallback.location,
    props: { ...(fallback.props ?? {}) }
  };
}

function objectName(world: any, id: string) {
  if (scopedProjectionEnabled) return String(projectedObjectView(id)?.name ?? id);
  return String(world.objects?.[id]?.name ?? id);
}

function buildDubspaceMeta(world: any) {
  const catalog = installedCatalog(world, "dubspace");
  const space = firstObjectByParent(world, catalogClass(catalog, "$dubspace")) ?? installedCatalogSeed(world, "dubspace", bundledToolSeeds.dubspace);
  const byClass = (localName: string) => {
    const ids = objectsByParent(world, catalogClass(catalog, localName), space);
    return ids.length > 0 ? ids : bundledSeedRefs(dubspaceManifest, localName);
  };
  return {
    space,
    slots: byClass("$loop_slot"),
    channel: byClass("$channel")[0],
    filter: byClass("$filter")[0],
    delay: byClass("$delay")[0],
    drum: byClass("$drum_loop")[0],
    scene: byClass("$scene")[0]
  };
}

function projectDubspace(world: any, meta: any) {
  const ids = dubspaceObjectIds(meta);
  return Object.fromEntries(ids.map((id: string) => [id, objectView(world, id)]).filter(([, view]) => view));
}

function dubspaceObjectIds(meta: any): string[] {
  return [meta?.space, ...(Array.isArray(meta?.slots) ? meta.slots : []), meta?.channel, meta?.filter, meta?.delay, meta?.drum, meta?.scene]
    .filter((id): id is string => typeof id === "string" && Boolean(id));
}

function projectedDubspace(meta: any = dubspaceMeta()) {
  return Object.fromEntries(dubspaceObjectIds(meta).map((id: string) => [id, projectedObjectView(id)]).filter(([, view]) => view));
}

function dubspaceMeta(): any {
  if (!scopedProjectionEnabled) return state.world?.dubspaceMeta ?? {};
  const space = dubspaceSpace();
  const objects = overlaySnapshotObjects(dubspaceOverlaySnapshot());
  const byClass = (localName: string) => {
    const ids = objects
      .filter((item) => isCatalogObjectSummary(item, "dubspace", localName) && (localName === "$dubspace" || item?.location === space))
      .map((item) => String(item.id ?? ""))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    const unique = [...new Set(ids)];
    return unique.length > 0 ? unique : bundledSeedRefs(dubspaceManifest, localName);
  };
  return {
    space: byClass("$dubspace")[0] ?? space,
    slots: byClass("$loop_slot"),
    channel: byClass("$channel")[0],
    filter: byClass("$filter")[0],
    delay: byClass("$delay")[0],
    drum: byClass("$drum_loop")[0],
    scene: byClass("$scene")[0]
  };
}

function dubspaceOverlaySnapshot(): any {
  const space = dubspaceSpace();
  if (!space) return undefined;
  return state.scopedProjection?.overlaySnapshots?.[`dubspace:${space}`];
}

function isCatalogObjectSummary(item: any, catalogName: string, localName: string): boolean {
  const classRef = activeCatalogClass(catalogName, localName) ?? localName;
  const ancestors = Array.isArray(item?.ancestors) ? item.ancestors.map(String) : [];
  return item?.parent === classRef || item?.parent === localName || ancestors.includes(classRef) || ancestors.includes(localName);
}

function buildPinboardMeta(world: any) {
  const catalog = installedCatalog(world, "pinboard");
  return {
    board: firstObjectByParent(world, catalogClass(catalog, "$pinboard")) ?? installedCatalogSeed(world, "pinboard", bundledToolSeeds.pinboard)
  };
}

function projectPinboard(world: any, meta: any) {
  const board = objectView(world, meta.board);
  const props = board?.props ?? {};
  const legacyNotes = Array.isArray(props.notes) && props.notes.length > 0 ? props.notes : undefined;
  const notes = legacyNotes ?? pinboardNotesFromContents(world, meta.board, props.layout);
  const palette = Array.isArray(props.palette) ? props.palette.map(String) : ["yellow", "blue", "green", "pink", "white"];
  state.pinboardNewColor = normalizePinboardStickyColor(state.pinboardNewColor, palette);
  return {
    board,
    notes: normalizePinboardNotes(notes, state.world?.pinboard?.notes),
    present: Array.isArray(props.subscribers) ? props.subscribers.map(String) : [],
    palette,
    viewport: props.viewport && typeof props.viewport === "object" && !Array.isArray(props.viewport) ? props.viewport : { w: 960, h: 560 }
  };
}

function pinboardModel(): PinboardRenderModel | undefined {
  if (!scopedProjectionEnabled) return state.world?.pinboard;
  const boardId = pinboardSpace();
  if (!boardId) return undefined;
  const projected = ui.observe(boardId);
  const board = {
    id: boardId,
    name: projected?.name ?? boardId,
    owner: projected?.owner,
    parent: projected?.parent,
    location: projected?.location,
    props: { ...(projected?.props ?? {}) },
    catalogState: { ...(projected?.catalogState ?? {}) }
  };
  const props = board.props ?? {};
  const palette = pinboardPalette(props.palette);
  state.pinboardNewColor = normalizePinboardStickyColor(state.pinboardNewColor, palette);
  const layout = pinboardLayoutFromBoard(board);
  const removed = pinboardLayoutTombstones(board);
  const noteIds = pinboardProjectedNoteIds(boardId, layout, [], removed);
  return {
    board,
    notes: normalizePinboardNotes(noteIds.map((id) => pinboardProjectedNote(id, layout[id])).filter(Boolean)),
    present: scopedPinboardPresentActors(boardId, props),
    palette,
    viewport: props.viewport && typeof props.viewport === "object" && !Array.isArray(props.viewport) ? props.viewport : { w: 960, h: 560 }
  };
}

function scopedPinboardPresentActors(boardId: string, props: Record<string, unknown>): string[] {
  const present = new Set(Array.isArray(props.subscribers) ? props.subscribers.map(String) : []);
  const presence = ui.observe(boardId)?.catalogState.pinboard_presence;
  if (presence && typeof presence === "object" && !Array.isArray(presence)) {
    for (const [actor, value] of Object.entries(presence)) {
      if (value === false) present.delete(actor);
      else if (value === true) present.add(actor);
    }
  }
  if (present.size > 0) return [...present];
  const room = pinboardOverlaySnapshot()?.room;
  const fromRoom = idsFromRefsOrSummaries(Array.isArray(room?.present_actors) ? room.present_actors : []);
  if (fromRoom.length > 0) return fromRoom;
  // Last-resort local fallback: before the first overlay/presence frame lands,
  // show the user in their own active pinboard rather than an empty presence
  // map. This is not an authoritative subscriber list.
  return state.actor && state.scopedProjection?.session?.current_location === boardId ? [state.actor] : [];
}

function pinboardLayoutFromBoard(board: any): Record<string, any> {
  const layout = board?.props?.layout;
  const base = layout && typeof layout === "object" && !Array.isArray(layout) ? layout : {};
  const overlay = board?.catalogState?.pinboard_layout;
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return base;
  const merged: Record<string, any> = { ...base };
  for (const [id, value] of Object.entries(overlay)) {
    if (value === null) delete merged[id];
    else if (value && typeof value === "object" && !Array.isArray(value)) merged[id] = { ...(merged[id] ?? {}), ...value };
  }
  return merged;
}

function pinboardLayoutTombstones(board: any): Set<string> {
  const overlay = board?.catalogState?.pinboard_layout;
  const removed = new Set<string>();
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return removed;
  for (const [id, value] of Object.entries(overlay)) {
    if (value === null) removed.add(id);
  }
  return removed;
}

function pinboardProjectedNoteIds(boardId: string, layout: Record<string, any>, legacyNotes: any[] = [], removed = new Set<string>()): string[] {
  const ids = new Set<string>();
  for (const id of Object.keys(layout)) {
    if (!removed.has(id)) ids.add(id);
  }
  for (const note of Array.isArray(legacyNotes) ? legacyNotes : []) {
    const id = String(note?.id ?? "");
    if (id && !removed.has(id)) ids.add(id);
  }
  const snapshot = pinboardOverlaySnapshot();
  for (const item of overlaySnapshotObjects(snapshot)) {
    const id = String(item?.id ?? "");
    if (id && !removed.has(id) && isPinboardNoteSummary(item, boardId, layout)) ids.add(id);
  }
  return [...ids];
}

function pinboardProjectedNote(id: string, layoutEntry: any, legacyNotes: any[] = []): any | undefined {
  const projected = ui.observe(id);
  const previous = Array.isArray(legacyNotes) ? legacyNotes.find((note) => String(note?.id ?? "") === id) : undefined;
  const noteState = projected?.catalogState.pinboard_note ?? {};
  const entry = layoutEntry && typeof layoutEntry === "object" && !Array.isArray(layoutEntry) ? layoutEntry : {};
  if (!projected && !previous && Object.keys(entry).length === 0) return undefined;
  // Priority is deliberate: observation-reduced catalogState is the current
  // UI model; projection props carry static readable note fields; the optional
  // legacy cache is used only by `/api/state` mode; board layout fills
  // placement defaults.
  return {
    id,
    name: projected?.name ?? previous?.name ?? id,
    owner: projected?.owner ?? previous?.owner ?? previous?.author,
    author: noteState.author ?? projected?.owner ?? previous?.author ?? previous?.owner,
    writers: noteState.writers ?? projected?.props?.writers ?? previous?.writers,
    text: noteState.text ?? projected?.props?.text ?? previous?.text,
    color: noteState.color ?? projected?.props?.color ?? previous?.color,
    x: noteState.x ?? entry.x ?? previous?.x,
    y: noteState.y ?? entry.y ?? previous?.y,
    w: noteState.w ?? entry.w ?? previous?.w,
    h: noteState.h ?? entry.h ?? previous?.h,
    z: noteState.z ?? entry.z ?? previous?.z,
    created_at: noteState.created_at ?? previous?.created_at,
    updated_at: noteState.updated_at ?? previous?.updated_at,
    updated_by: noteState.updated_by ?? previous?.updated_by
  };
}

function pinboardOverlaySnapshot(): any {
  const board = pinboardSpace();
  if (!board) return undefined;
  return state.scopedProjection?.overlaySnapshots?.[`pinboard:${board}`];
}

function isPinboardNoteSummary(item: any, boardId: string, layout: Record<string, any>): boolean {
  const id = String(item?.id ?? "");
  if (!id) return false;
  // Overlay snapshots do not yet carry catalog-specific `kind: "pin"`
  // metadata, so the bridge recognizes pins by layout membership first, then
  // by location plus class summary. Replace this with catalog-provided
  // snapshot transforms when UCM component loading owns pinboard rendering.
  if (Object.prototype.hasOwnProperty.call(layout, id)) return true;
  if (item?.location === boardId && (item?.parent === "$pin" || item?.parent === "$note")) return true;
  const ancestors = Array.isArray(item?.ancestors) ? item.ancestors.map(String) : [];
  return item?.location === boardId && (ancestors.includes("$pin") || ancestors.includes("$note"));
}

function pinboardNoteStateFromSummary(item: any, layoutEntry: any): Record<string, unknown> {
  const entry = layoutEntry && typeof layoutEntry === "object" && !Array.isArray(layoutEntry) ? layoutEntry : {};
  const props = item?.props && typeof item.props === "object" && !Array.isArray(item.props) ? item.props : {};
  const out: Record<string, unknown> = {};
  for (const key of ["x", "y", "z", "w", "h"]) if (entry[key] !== undefined) out[key] = entry[key];
  for (const key of ["text", "color", "writers"]) if (props[key] !== undefined && props[key] !== null) out[key] = props[key];
  if (typeof item?.owner === "string") {
    out.owner = item.owner;
    out.author = item.owner;
  }
  return out;
}

function pinboardNotesFromContents(world: any, boardId: string | undefined, layoutValue: any) {
  const contents = Array.isArray(world.objects?.[boardId ?? ""]?.contents) ? world.objects[boardId ?? ""].contents : [];
  const layout = layoutValue && typeof layoutValue === "object" && !Array.isArray(layoutValue) ? layoutValue : {};
  // pinboard:enter moves the active session to the board, so contents includes guests as
  // well as pins. Server-side `:list_notes` filters by `isa(pin, $note)`;
  // we approximate that here with a parent check on the bundled $pin class.
  return contents.filter((id: string) => world.objects?.[id]?.parent === "$pin").map((id: string) => {
    const obj = world.objects?.[id] ?? {};
    const props = obj.props ?? {};
    const entry = layout[id] && typeof layout[id] === "object" && !Array.isArray(layout[id]) ? layout[id] : {};
    return {
      id,
      name: obj.name ?? id,
      text: props.text,
      color: props.color,
      writers: props.writers,
      owner: obj.owner,
      author: obj.owner,
      x: entry.x,
      y: entry.y,
      w: entry.w,
      h: entry.h,
      z: entry.z
    };
  });
}

function pinboardNotesHaveMissingText(notes: any[]) {
  return (Array.isArray(notes) ? notes : []).some((note) => {
    const text = note?.text;
    if (text === undefined || text === null) return true;
    return false;
  });
}

function pinboardNotesSignature(notes: any[]) {
  return (Array.isArray(notes) ? notes : []).map((note) => String(note?.id ?? "")).filter(Boolean).sort().join("|");
}

function hydratePinboardNotesTextIfNeeded(pinboard: any) {
  const board = pinboard?.board;
  const boardId = typeof board?.id === "string" ? board.id : "";
  const notes = Array.isArray(pinboard?.notes) ? pinboard.notes : [];
  if (!canSendDirect()) return;
  if (!pinboardActorPresent()) return;
  if (!pinboardNotesHaveMissingText(notes)) return;
  if (!boardId) return;
  const signature = pinboardNotesSignature(notes);
  const boardChanged = pinboardTextHydrationRequestedBoard !== boardId || pinboardTextHydrationRequestedSignature !== signature;
  if (boardChanged) {
    pinboardTextHydrationRequested = false;
    pinboardTextHydrationRequestedBoard = boardId;
    pinboardTextHydrationRequestedSignature = signature;
  }
  if (pinboardNotesRefreshPending || pinboardTextHydrationRequested) return;
  pinboardTextHydrationRequested = true;
  refreshPinboardNotes();
}

function normalizePinboardNotes(notes: any[], previousNotes: any[] = []) {
  const previousById = new Map((Array.isArray(previousNotes) ? previousNotes : []).map((note) => [String(note?.id ?? ""), note]));
  return (Array.isArray(notes) ? notes : []).map((note) => ({
    ...note,
    id: String(note?.id ?? "")
  })).filter((note) => note.id).map((note) => {
    const previous = previousById.get(note.id);
    const hasText = note?.text !== undefined && note?.text !== null;
    const hasPreviousText = previous?.text !== undefined && previous?.text !== null;
    return {
      ...note,
      text: hasText ? pinNoteText(note?.text) : hasPreviousText ? pinNoteText(previous?.text) : undefined,
      author: note?.author ?? note?.owner ?? previous?.author,
      owner: note?.owner ?? note?.author ?? previous?.owner,
      color: typeof note?.color === "string" ? note.color : typeof previous?.color === "string" ? previous.color : null
    };
  });
}

function buildChatMeta(world: any) {
  const chat = installedCatalog(world, "chat");
  const demo = installedCatalog(world, "demoworld");
  const rooms = objectsByParent(world, catalogClass(chat, "$chatroom"));
  const pinned = chatRoomPin && chatRoomPin.expiresAt > Date.now() && rooms.includes(chatRoomPin.room) ? chatRoomPin.room : undefined;
  if (chatRoomPin && !pinned) chatRoomPin = null;
  const currentLocation = typeof world?.session?.current_location === "string" && rooms.includes(world.session.current_location) ? world.session.current_location : undefined;
  const occupied = rooms.find((id) => Array.isArray(world.objects?.[id]?.props?.subscribers) && world.objects[id].props.subscribers.includes(state.actor));
  const seededEntry = Object.values(demo?.seeds ?? {}).find((id) => typeof id === "string" && rooms.includes(id));
  const defaultRoom = seededEntry ?? rooms[0];
  const current = pinned ?? currentLocation ?? occupied ?? seededEntry ?? rooms[0];
  return { room: current, rooms, defaultRoom };
}

function projectChat(world: any, meta: any) {
  const room = objectView(world, meta.room);
  const rooms = Array.isArray(meta.rooms) ? meta.rooms.map((id: string) => objectView(world, id)).filter(Boolean) : [];
  return {
    room: room ? { id: room.id, name: room.name, description: room.props.description ?? "" } : null,
    rooms,
    present: Array.isArray(room?.props?.subscribers) ? room.props.subscribers : []
  };
}

function defaultSelectedObject() {
  if (scopedProjectionEnabled) return dubspaceMeta().delay ?? state.scopedProjection?.here?.id ?? state.actor ?? "";
  return dubspaceMeta().delay ?? Object.keys(state.world?.objects ?? {}).sort()[0] ?? "";
}

function dubspaceSpace() {
  if (scopedProjectionEnabled) {
    const route = startupRoute ?? parseLocationRoute(location.pathname, location.search);
    if (route?.view === "dubspace" && route.objectId) return route.objectId;
    if (state.routedSubjects.dubspace) return state.routedSubjects.dubspace;
    const scoped = scopedToolSubject("dubspace");
    return scoped || activeInstalledCatalogSeed("dubspace", bundledToolSeeds.dubspace);
  }
  return String(state.world?.dubspaceMeta?.space ?? "");
}

function pinboardSpace() {
  if (scopedProjectionEnabled) {
    const route = startupRoute ?? parseLocationRoute(location.pathname, location.search);
    if (route?.view === "pinboard" && route.objectId) return route.objectId;
    if (state.routedSubjects.pinboard) return state.routedSubjects.pinboard;
    const scoped = scopedToolSubject("pinboard");
    return scoped || activeInstalledCatalogSeed("pinboard", bundledToolSeeds.pinboard);
  }
  return String(state.world?.pinboardMeta?.board ?? "");
}

function tasksSpace() {
  if (scopedProjectionEnabled) {
    const route = startupRoute ?? parseLocationRoute(location.pathname, location.search);
    if ((route?.view === "tasks" || route?.view === "kanban") && route.objectId) return route.objectId;
    if (state.routedSubjects.tasks) return state.routedSubjects.tasks;
    const scoped = scopedToolSubject("tasks");
    return scoped || activeInstalledCatalogSeed("tasks", bundledToolSeeds.tasks);
  }
  return activeInstalledCatalogSeed("tasks", bundledToolSeeds.tasks);
}

function chatRoom() {
  // Migration note: new selectors should make the scoped branch primary.
  // The `state.world` branch is the temporary `/api/state` compatibility tail.
  if (scopedProjectionEnabled) return String(state.scopedProjection?.here?.id ?? "");
  return String(state.world?.chatMeta?.room ?? "");
}

function defaultChatRoom() {
  if (scopedProjectionEnabled) return String(state.scopedProjection?.here?.id ?? "");
  return String(state.world?.chatMeta?.defaultRoom ?? "");
}

function activeChatRoom() {
  const room = chatRoom();
  if (room) return room;
  return state.tab === "chat" ? defaultChatRoom() : "";
}

function call(space: string, target: string, verb: string, args: unknown[] = [], options?: ProjectionCallOptions) {
  const id = crypto.randomUUID();
  ui.applyOptimisticCall(id, options);
  if (!sendFrame({ op: "call", id, space, message: { target, verb, args } })) ui.failOptimisticCall(id);
  return id;
}

function callWithError(space: string, target: string, verb: string, args: unknown[] = [], onError?: (error: any) => void, options?: ProjectionCallOptions) {
  const id = crypto.randomUUID();
  ui.applyOptimisticCall(id, options);
  if (onError) pendingFrameErrors.set(id, onError);
  if (!sendFrame({ op: "call", id, space, message: { target, verb, args } })) {
    ui.failOptimisticCall(id);
    pendingFrameErrors.delete(id);
  }
  return id;
}

function actorPresenceList(actor: string): string[] {
  if (scopedProjectionEnabled && actor === state.actor) {
    const locations = state.scopedProjection?.session?.all_locations;
    return Array.isArray(locations) ? locations.filter((id): id is string => typeof id === "string") : [];
  }
  if (actor === state.actor) {
    const locations = state.world?.session?.all_locations;
    if (Array.isArray(locations)) return locations.filter((id): id is string => typeof id === "string");
  }
  return [];
}

function actorPresentInSpace(space: string) {
  const actor = state.actor;
  if (!actor) return false;
  if (scopedProjectionEnabled) {
    if (state.scopedProjection?.session?.current_location === space) return true;
    if (state.scopedProjection?.here?.id === space && state.chatPresent.includes(actor)) return true;
    return actorPresenceList(actor).includes(space);
  }
  if (state.world?.session?.current_location === space) return true;
  return actorPresenceList(actor).includes(space);
}

function shouldAutoEnterDefaultChatRoom() {
  if (scopedProjectionEnabled) return false;
  const location = state.world?.session?.current_location;
  if (typeof location === "string" && location && location !== "$nowhere") {
    const room = chatRoom();
    const subscribers = state.world?.objects?.[room]?.props?.subscribers;
    return Boolean(room && location === room && state.actor && Array.isArray(subscribers) && !subscribers.includes(state.actor));
  }
  return actorPresenceList(state.actor ?? "").length === 0;
}

function ensureSpacePresence(space: string, onReady: () => void, onError?: (error: any) => void) {
  if (!space || !canSendDirect()) {
    onReady();
    return;
  }
  if (actorPresentInSpace(space)) {
    onReady();
    return;
  }
  direct(space, "enter", [], onReady, onError);
}

function direct(target: string, verb: string, args: unknown[] = [], onResult?: (result: any) => void, onError?: (error: any) => void, options?: ProjectionCallOptions) {
  const id = crypto.randomUUID();
  ui.applyOptimisticCall(id, options);
  if (onResult) pendingDirect.set(id, onResult);
  if (onError) pendingFrameErrors.set(id, onError);
  if (!sendFrame({ op: "direct", id, target, verb, args })) {
    ui.failOptimisticCall(id);
    pendingDirect.delete(id);
    pendingFrameErrors.delete(id);
  }
  return id;
}

function command(space: string, text: string, onResult?: (result: any) => void, onError?: (error: any) => void, options?: ProjectionCallOptions) {
  const id = crypto.randomUUID();
  ui.applyOptimisticCall(id, options);
  pendingCommands.set(id, { space, text });
  if (onResult) pendingDirect.set(id, onResult);
  if (onError) pendingFrameErrors.set(id, onError);
  if (!sendFrame({ op: "command", id, space, text })) {
    ui.failOptimisticCall(id);
    pendingCommands.delete(id);
    pendingDirect.delete(id);
    pendingFrameErrors.delete(id);
  }
  return id;
}

function canSendDirect() {
  return Boolean(state.actor && state.session && state.socket?.readyState === WebSocket.OPEN);
}

function liveKey(target: string, name: string) {
  return `${target}:${name}`;
}

function effectiveDubspace() {
  ui.prune();
  const base = projectedDubspace();
  const copy: Record<string, any> = Object.fromEntries(
    Object.entries(base).map(([id, obj]: [string, any]) => [
      id,
      {
        ...obj,
        props: { ...(obj?.props ?? {}) }
      }
    ])
  );
  for (const [slot, cue] of Object.entries(state.cueSlots)) {
    if (cue && copy[slot]) copy[slot].props.playing = state.cuePlaying[slot] === true;
  }
  for (const [key, value] of Object.entries(state.cueControls)) {
    const [target, name] = key.split(":");
    if (state.cueSlots[target] && copy[target]) copy[target].props[name] = value;
  }
  return copy;
}

function sendPreviewControl(target: string, name: string, value: any) {
  const key = liveKey(target, name);
  ui.projection.applyLive(liveProjectionKey("gesture_progress", target, `prop.${name}`), [{ subject: target, props: { [name]: value } }]);
  audio?.sync(effectiveDubspace(), state.clockOffset);
  const last = directThrottle.get(key) ?? 0;
  if (Date.now() - last < 35) return;
  directThrottle.set(key, Date.now());
  const space = dubspaceSpace();
  if (space) direct(space, "preview_control", [target, name, value]);
}

function dubspaceOptimisticProps(target: string, props: Record<string, unknown>, id = `${target}:${Object.keys(props).sort().join(",")}`): ProjectionCallOptions | undefined {
  if (!target || Object.keys(props).length === 0) return undefined;
  return {
    optimistic: {
      id: `dubspace:${id}`,
      patches: [{ subject: target, props }],
      reconcile: "drop_on_applied"
    }
  };
}

function patchDubspaceProjectionProps(target: string, props: Record<string, unknown>) {
  if (!target || Object.keys(props).length === 0) return;
  ui.applyCanonical([{ subject: target, props }]);
  if (!scopedProjectionEnabled) {
    if (state.world?.objects?.[target]?.props) Object.assign(state.world.objects[target].props, props);
    if (state.world?.dubspace?.[target]?.props) Object.assign(state.world.dubspace[target].props, props);
  }
}

function callDubspaceMutation(verb: string, args: unknown[], options?: ProjectionCallOptions) {
  const space = dubspaceSpace();
  if (!space) return "";
  const id = call(space, space, verb, args, options);
  audio?.sync(effectiveDubspace(), state.clockOffset);
  if (state.tab === "dubspace") render();
  return id;
}

function patternWithStep(rawPattern: any, voice: string, step: number, enabled: boolean) {
  // Used for local optimistic drum-button patches. Since dubspace 0.2.4,
  // server `drum_step_changed` observations carry the full pattern snapshot.
  const pattern = normalizePattern(rawPattern);
  if (!pattern[voice] || step < 0 || step >= pattern[voice].length) return pattern;
  pattern[voice] = pattern[voice].map((value, index) => index === step ? enabled : value);
  return pattern;
}

function setCueControl(target: string, name: string, value: any) {
  state.cueControls[liveKey(target, name)] = value;
  audio?.sync(effectiveDubspace(), state.clockOffset);
}

function clearCueControls(target: string) {
  for (const key of Object.keys(state.cueControls)) {
    if (key.startsWith(`${target}:`)) delete state.cueControls[key];
  }
}

function clearCueState(target: string) {
  clearCueControls(target);
  delete state.cuePlaying[target];
}

function commitCueControls(target: string) {
  const values = new Map<string, number>();
  document.querySelectorAll<HTMLInputElement>("[data-control]").forEach((input) => {
    const { target: obj, name } = controlBinding(input);
    if (obj !== target) return;
    const value = controlInputValue(input);
    if (Number.isFinite(value)) values.set(name, value);
  });
  for (const [key, value] of Object.entries(state.cueControls)) {
    const [obj, name] = key.split(":");
    if (obj !== target || values.has(name)) continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) values.set(name, numeric);
  }
  const space = dubspaceSpace();
  for (const [name, value] of values) if (space) call(space, space, "set_control", [target, name, value]);
}

function receiveLiveEvent(observation: any) {
  if (isPinboardViewportObservation(observation)) {
    receivePinboardViewport(observation);
    return;
  }
  // Pinboard side effects (window auto-open/close, plus legacy refresh) must fire
  // before the chat-observation branch, because pinboard_* types appear in
  // both observation lists and the chat branch returns early. The board is a
  // focus surface, not a place you travel to (catalogs/pinboard/DESIGN.md);
  // opening/closing the tab is the chat-side analogue of mounting the board.
  if (isPinboardObservation(observation)) {
    const pinboardAnimations = capturePinboardAnimations([observation]);
    const pinboardType = String(observation?.type ?? "");
    const needsNoteRefresh = pinboardObservationNeedsNotesRefresh(pinboardType);
    if (needsNoteRefresh) pinboardNotesRefreshPending = false;
    const placementChanged = applyPinboardPlacementObservation(observation);
    if (observation?.type === "pinboard_left") removePinboardViewport(String(observation?.actor ?? ""));
    if (String(observation?.actor ?? "") === state.actor) {
      if (observation?.type === "pinboard_entered") {
        markNestedSpaceDeparture(pinboardSpace());
        if (state.tab !== "pinboard") setTab("pinboard", { mode: "push", leaveCurrent: false });
        requestSpaceChatFocus(pinboardSpace());
      } else if (observation?.type === "pinboard_left" && state.tab === "pinboard") {
        clearPinboardViewports();
        setTab("chat", { mode: "push", leaveCurrent: false });
      }
    }
    scheduleLegacyStateRefresh();
    if (placementChanged) render();
    if (needsNoteRefresh) refreshPinboardNotes();
    animatePinboardNotes(pinboardAnimations);
  }
  if (isDubspaceObservation(observation)) {
    if (String(observation?.actor ?? "") === state.actor) {
      if (observation?.type === "dubspace_entered") {
        addDubspaceOperator(state.actor);
        markNestedSpaceDeparture(dubspaceSpace());
        if (state.tab !== "dubspace") setTab("dubspace", { mode: "push", leaveCurrent: false });
        requestSpaceChatFocus(dubspaceSpace());
      } else if (observation?.type === "dubspace_left") {
        removeDubspaceOperator(state.actor);
        if (state.tab === "dubspace") {
          setTab("chat", { mode: "push", leaveCurrent: false });
        }
      }
    }
    scheduleLegacyStateRefresh();
  }
  if (isChatObservation(observation)) {
    receiveChatEvent(observation);
    return;
  }
  if (isDubspaceStateObservation(observation)) {
    syncDubspaceProjectionEffects(observation);
    if (!scopedProjectionEnabled && String(observation?.type ?? "") === "control_changed") scheduleLegacyStateRefresh();
    return;
  }
  if (observation?.type === "gesture_progress") {
    receiveLiveControl(observation);
    return;
  }
  state.observations.unshift({ live: true, observation });
  trimObservations();
  render();
}

function trimObservations() {
  state.observations = state.observations.slice(0, observationDisplayLimit);
}

function receiveLiveControl(observation: any) {
  const input = findControlInput(String(observation.target), String(observation.name));
  if (input && document.activeElement !== input) setControlInputValue(input, observation.value);
  audio?.sync(effectiveDubspace(), state.clockOffset);
}

function isDubspaceStateObservation(observation: any) {
  return [
    "control_changed",
    "loop_started",
    "loop_stopped",
    "tempo_changed",
    "transport_started",
    "transport_stopped",
    "drum_step_changed",
    "scene_recalled"
  ].includes(String(observation?.type ?? ""));
}

function syncDubspaceProjectionEffects(observation?: any) {
  if (String(observation?.type ?? "") === "control_changed") {
    const target = String(observation.target ?? "");
    const name = String(observation.name ?? "");
    const input = findControlInput(target, name);
    const projected = target && name ? projectedObjectView(target)?.props?.[name] : undefined;
    if (input && document.activeElement !== input) setControlInputValue(input, projected ?? observation.value);
  }
  audio?.sync(effectiveDubspace(), state.clockOffset);
}

function findControlInput(target: string, name: string): HTMLInputElement | null {
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-control]")) {
    const binding = controlBinding(input);
    if (binding.target === target && binding.name === name) return input;
  }
  return null;
}

function controlBinding(input: HTMLInputElement): { target: string; name: string } {
  const target = input.dataset.target ?? "";
  const name = input.dataset.name ?? "";
  if (target && name) return { target, name };
  const [legacyTarget = "", legacyName = ""] = (input.dataset.control ?? "").split(":");
  return { target: legacyTarget, name: legacyName };
}

function isPitchInput(input: HTMLInputElement) {
  return input.dataset.pitchInput !== undefined;
}

function controlInputValue(input: HTMLInputElement) {
  if (isPitchInput(input)) return frequencyForSemitone(Number(input.value));
  return Number(input.value);
}

function setControlInputValue(input: HTMLInputElement, value: any) {
  if (isPitchInput(input)) {
    input.value = String(semitoneForFrequency(Number(value)));
    syncPitchInput(input);
    return;
  }
  input.value = String(value);
  syncControlInputReadout(input, value);
}

function syncPitchInput(input: HTMLInputElement) {
  if (!isPitchInput(input)) return;
  const pitch = pitchForSemitone(Number(input.value));
  const switchEl = input.closest<HTMLElement>(".pitch-switch");
  switchEl?.style.setProperty("--pitch-angle", `${pitch.angle}deg`);
  const note = switchEl?.querySelector<HTMLElement>("[data-pitch-note]");
  const hz = switchEl?.querySelector<HTMLElement>("[data-pitch-hz]");
  if (note) note.textContent = pitch.note;
  if (hz) hz.textContent = `${Math.round(pitch.freq)} Hz`;
}

function syncControlInputReadout(input: HTMLInputElement, value: any = input.value) {
  if (input.dataset.name !== "cutoff") return;
  const readout = input.closest<HTMLElement>(".filter-strip")?.querySelector<HTMLElement>("[data-control-readout]");
  const numeric = Number(value);
  if (readout && Number.isFinite(numeric)) readout.textContent = `${Math.round(numeric)} Hz`;
}

function forgetLiveControls(observations: any[]) {
  for (const obs of observations) {
    if (obs.type === "control_changed" && obs.target && obs.name) ui.projection.clearLive(liveProjectionKey("gesture_progress", String(obs.target), `prop.${String(obs.name)}`));
  }
}

function pruneLiveControls() {
  if (!ui.prune()) return;
  audio?.sync(effectiveDubspace(), state.clockOffset);
  if (state.tab === "dubspace") render();
}

function render() {
  if (state.authStatus !== "authenticated") {
    renderLogin();
    return;
  }
  const focus = captureRenderFocus();
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.innerHTML = `
    <div class="shell ${state.observationsCollapsed ? "observations-collapsed" : ""}">
      <aside class="nav">
        <div class="brand">Woo</div>
        <div class="actor">${escapeHtml(state.actor ?? "connecting...")}</div>
        ${navButton("chat", "Chat")}
        ${navButton("dubspace", "Dubspace")}
        ${navButton("pinboard", "Pinboard")}
        ${navButton("tasks", "Tasks")}
        ${navButton("ide", "IDE")}
        <a class="github-link" href="https://github.com/hughpyle/woo" target="_blank" rel="noopener noreferrer" aria-label="woo on GitHub" title="woo on GitHub">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
        </a>
      </aside>
      <main class="main">
        ${state.tab === "dubspace" ? renderDubspace() : ""}
        ${state.tab === "pinboard" ? renderPinboard() : ""}
        ${state.tab === "tasks" ? renderTasks() : ""}
        ${state.tab === "chat" ? renderChat() : ""}
        ${state.tab === "ide" ? renderIde() : ""}
      </main>
      ${renderObservationsPanel()}
    </div>
  `;

  bindCommon();
  if (state.tab === "chat") mountChatComponent();
  if (state.tab === "dubspace") bindDubspace();
  if (state.tab === "pinboard") bindPinboard();
  if (state.tab === "tasks") bindTasks();
  if (state.tab === "ide") bindIde();
  if (!restoreRenderFocus(focus) && state.tab === "chat") focusChatInput();
}

function renderLogin() {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  const username = readUsername();
  const pending = state.loginPending === true;
  const error = state.loginError ?? "";
  app.innerHTML = `
    <div class="login-shell">
      <form class="login-card" data-login-form autocomplete="on">
        <h1 class="login-brand">world of objects</h1>
        <button type="button" class="login-guest" data-login-guest ${pending ? "disabled" : ""}>
          ${pending ? "Connecting..." : "Continue as guest"}
        </button>
        <div class="login-divider"><span>or sign in</span></div>
        <label class="login-field">
          <span>Username</span>
          <input type="text" name="username" autocomplete="username" required value="${escapeHtml(username)}" ${pending ? "disabled" : ""} />
        </label>
        <label class="login-field">
          <span>Password</span>
          <input type="password" name="password" autocomplete="current-password" required ${pending ? "disabled" : ""} />
        </label>
        <button type="submit" class="login-submit" ${pending ? "disabled" : ""}>
          ${pending ? "Signing in..." : "Sign in"}
        </button>
        ${error ? `<p class="login-error" role="alert">${escapeHtml(error)}</p>` : ""}
      </form>
    </div>
  `;
  bindLogin();
}

function bindLogin() {
  document.querySelector<HTMLButtonElement>("[data-login-guest]")?.addEventListener("click", () => {
    void loginAsGuest();
  });
  const form = document.querySelector<HTMLFormElement>("[data-login-form]");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.loginPending) return;
    const data = new FormData(form);
    const usernameValue = String(data.get("username") ?? "").trim();
    const passwordValue = String(data.get("password") ?? "");
    void loginWithApiKey(usernameValue, passwordValue);
  });
  const usernameInput = document.querySelector<HTMLInputElement>("[data-login-form] input[name=\"username\"]");
  if (usernameInput && !usernameInput.value) usernameInput.focus();
  else document.querySelector<HTMLInputElement>("[data-login-form] input[name=\"password\"]")?.focus();
}

function captureRenderFocus(): RenderFocusSnapshot | null {
  const element = document.activeElement;
  if (!isRestorableInput(element)) return null;
  const selector = renderFocusSelector(element);
  if (!selector) return null;
  return {
    tab: state.tab,
    selector,
    value: element.value,
    selectionStart: inputSelectionStart(element),
    selectionEnd: inputSelectionEnd(element)
  };
}

function restoreRenderFocus(snapshot: RenderFocusSnapshot | null): boolean {
  if (!snapshot || snapshot.tab !== state.tab) return false;
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(snapshot.selector);
  if (!isRestorableInput(element)) return false;
  if (element.value !== snapshot.value) {
    element.value = snapshot.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
  window.requestAnimationFrame(() => {
    element.focus();
    if (!(element instanceof HTMLSelectElement) && snapshot.selectionStart !== undefined && snapshot.selectionEnd !== undefined) {
      try { element.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd); } catch { /* non-text input */ }
    }
  });
  return true;
}

function isRestorableInput(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return false;
  if (element instanceof HTMLInputElement && ["button", "checkbox", "file", "radio", "reset", "submit"].includes(element.type)) return false;
  return true;
}

function renderFocusSelector(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string | null {
  const attrs = Array.from(element.attributes)
    .filter((attr) => attr.name.startsWith("data-"))
    .map((attr) => attr.value === "" ? `[${attr.name}]` : `[${attr.name}="${cssAttrValue(attr.value)}"]`);
  if (attrs.length > 0) return `${element.tagName.toLowerCase()}${attrs.join("")}`;
  if (element.id) return `#${cssAttrValue(element.id)}`;
  return null;
}

function inputSelectionStart(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): number | undefined {
  if (element instanceof HTMLSelectElement) return undefined;
  try { return element.selectionStart ?? undefined; } catch { return undefined; }
}

function inputSelectionEnd(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): number | undefined {
  if (element instanceof HTMLSelectElement) return undefined;
  try { return element.selectionEnd ?? undefined; } catch { return undefined; }
}

function cssAttrValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\a ");
}

function navButton(tab: AppState["tab"], label: string) {
  return `<button class="nav-button ${state.tab === tab ? "active" : ""}" data-tab="${tab}">${label}</button>`;
}

function renderObservationsPanel() {
  const collapsed = state.observationsCollapsed;
  return `
    <aside class="events ${collapsed ? "collapsed" : ""}">
      <div class="events-header">
        <h2>${collapsed ? "Obs" : "Observations"}</h2>
        <button class="events-toggle" data-observations-toggle aria-expanded="${collapsed ? "false" : "true"}" aria-label="${collapsed ? "Show observations" : "Hide observations"}" title="${collapsed ? "Show observations" : "Hide observations"}">${collapsed ? ">" : "<"}</button>
      </div>
      ${collapsed ? "" : `
        <div class="event-list">
          ${state.observations.map((item) => `<pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre>`).join("") || "<p>No observations yet.</p>"}
        </div>
      `}
      <button class="events-logout" data-logout aria-label="Log out${state.actor ? ` ${state.actor}` : ""}" title="Log out${state.actor ? ` ${state.actor}` : ""}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      </button>
    </aside>
  `;
}

function bindCommon() {
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      const next = button.dataset.tab as AppState["tab"];
      if (next !== "ide") {
        scopedProjectionEnabled = true;
        await ensureScopedProjectionReady();
        await ensureScopedOverlayForTab(next);
      }
      const wasDifferent = state.tab !== next;
      setTab(next, { mode: "push" }, () => {
        if (!wasDifferent) return;
        if (next === "dubspace") enterDubspace();
        if (next === "pinboard") enterPinboard();
      });
    });
  });
  document.querySelector<HTMLButtonElement>("[data-observations-toggle]")?.addEventListener("click", () => {
    state.observationsCollapsed = !state.observationsCollapsed;
    render();
  });
  document.querySelector<HTMLButtonElement>("[data-logout]")?.addEventListener("click", () => {
    void logout();
  });
}

async function ensureScopedProjectionReady() {
  if (state.scopedProjection?.session && state.scopedProjection?.catalogs) return;
  await refreshScopedProjection();
}

function installBundledCatalogUi() {
  const bundled = [
    { alias: "chat", manifest: chatManifest, objects: { "$space": "$space", "$chatroom": "$chatroom" }, modules: { "chat-ui": chatUiModule } },
    { alias: "dubspace", manifest: dubspaceManifest, objects: { "$dubspace": "$dubspace" }, modules: { "dubspace-ui": dubspaceUiModule } },
    { alias: "pinboard", manifest: pinboardManifest, objects: { "$pinboard": "$pinboard" }, modules: { "pinboard-ui": pinboardUiModule } },
    { alias: "tasks", manifest: tasksManifest, objects: { "$task_registry": "$task_registry" }, modules: { "tasks-ui": tasksUiModule } },
    { alias: "weather", manifest: weatherManifest, objects: { "$weather_block": "$weather_block" }, modules: { "weather-ui": weatherUiModule } }
  ] as const;
  for (const item of bundled) {
    const uiManifest = (item.manifest as any).ui;
    if (!uiManifest) continue;
    // Bundled-catalog mode registers statically imported source. Installed remote
    // catalogs should go through CatalogUiRegistry.loadModule() with the resolved
    // artifact URL from the manifest entry.
    const diagnostics = ui.catalogUi.installCatalogUi({
      alias: item.alias,
      catalog: item.alias,
      objects: item.objects,
      ui: uiManifest
    } satisfies CatalogUiPackage);
    if (diagnostics.length > 0) throw new Error(`bundled ${item.alias} UI manifest is invalid: ${diagnostics.join("; ")}`);
    installedCatalogUiAliases.add(item.alias);
    for (const [moduleId, mod] of Object.entries(item.modules)) {
      ui.catalogUi.registerModuleExports(item.alias, moduleId, mod, ui.observations);
    }
  }
}

function renderDubspace() {
  const tag = toolFrameComponentTag(dubspaceSpace(), "dubspace.workspace", "dubspace");
  if (!tag) {
    return `
      <section class="toolbar"><h1>Dubspace</h1></section>
      <section class="panel"><p class="empty-state">No dubspace UI is registered for this space.</p></section>
    `;
  }
  const spaceId = dubspaceSpace();
  return `<${tag} data-dubspace-workspace data-dubspace-space="${escapeHtml(spaceId)}"></${tag}>`;
}

function dubspaceOperators(): string[] {
  const space = dubspaceSpace();
  const raw = space ? projectedObjectView(space)?.props?.operators : [];
  return Array.isArray(raw) ? raw.map(String) : [];
}

function mountToolSpaceChat(element: HTMLElement, space: string) {
  const slot = element.querySelector<HTMLElement>("[data-tool-space-chat]");
  if (!slot || !space) return;
  slot.innerHTML = renderSpaceChatPanel(space);
  bindSpaceChatPanels();
}

function mountDubspaceComponent() {
  const element = document.querySelector<WooElement & { data?: DubspaceData }>("[data-dubspace-workspace]");
  if (!element) return;
  const dub = effectiveDubspace();
  const meta = dubspaceMeta();
  const spaceId = typeof meta.space === "string" ? meta.space : "";
  const space = spaceId ? projectedObjectView(spaceId) ?? dub[spaceId] : null;
  const operators = dubspaceOperators();
  const lines = chatLinesForSpace(spaceId);
  element.subject = spaceId;
  element.woo = createChatWooContext(spaceId, [...chatLineActorRefs(lines), ...operators]);
  setCustomElementData(element, {
    spaceId,
    spaceName: String(space?.name ?? "Dubspace"),
    spaceDescription: String(space?.props?.description ?? space?.description ?? ""),
    controls: dub,
    slots: Array.isArray(meta.slots) ? meta.slots : [],
    filter: meta.filter ?? "",
    delay: meta.delay ?? "",
    drum: meta.drum ?? "",
    operators,
    actor: state.actor ?? null,
    inSpace: Boolean(state.actor && operators.includes(state.actor)),
    canSend: canSendDirect(),
    audioOn: state.audioOn,
    cueSlots: state.cueSlots,
    cuePlaying: state.cuePlaying
  }, () => {
    if (spaceId && operators.includes(state.actor ?? "")) mountToolSpaceChat(element, spaceId);
  });
  bindDubspaceComponentEvents(element);
}

function bindDubspaceComponentEvents(element: WooElement) {
  if (element.dataset.dubspaceEventsBound === "true") return;
  element.dataset.dubspaceEventsBound = "true";
  element.addEventListener("woo-dubspace-enter", enterDubspace);
  element.addEventListener("woo-dubspace-leave", () => leaveDubspace());
  element.addEventListener("woo-dubspace-audio", async () => {
    audio ??= new DubAudio();
    if (state.audioOn) {
      await audio.stop();
      state.audioOn = false;
      render();
      return;
    }
    await audio.start();
    state.audioOn = true;
    audio.sync(effectiveDubspace(), state.clockOffset);
    render();
  });
  element.addEventListener("woo-dubspace-loop", (event) => {
    const detail = (event as CustomEvent<{ slot?: unknown; playing?: unknown }>).detail ?? {};
    const slot = String(detail.slot ?? "");
    const playing = detail.playing === true;
    if (!slot) return;
    if (state.cueSlots[slot]) {
      state.cuePlaying[slot] = !playing;
      audio?.sync(effectiveDubspace(), state.clockOffset);
      render();
      return;
    }
    callDubspaceMutation(playing ? "stop_loop" : "start_loop", [slot], dubspaceOptimisticProps(slot, { playing: !playing }, `${slot}:playing`));
  });
  element.addEventListener("woo-dubspace-cue", (event) => {
    const slot = String((event as CustomEvent<{ slot?: unknown }>).detail?.slot ?? "");
    if (!slot) return;
    const wasCue = state.cueSlots[slot] === true;
    if (wasCue) {
      commitCueControls(slot);
      state.cueSlots[slot] = false;
      clearCueState(slot);
    } else {
      state.cueSlots[slot] = true;
      state.cuePlaying[slot] = true;
    }
    audio?.sync(effectiveDubspace(), state.clockOffset);
    render();
  });
  element.addEventListener("woo-dubspace-control-preview", (event) => {
    const detail = (event as CustomEvent<{ target?: unknown; name?: unknown; value?: unknown }>).detail ?? {};
    const target = String(detail.target ?? "");
    const name = String(detail.name ?? "");
    const value = Number(detail.value);
    if (!target || !name || !Number.isFinite(value)) return;
    if (state.cueSlots[target]) {
      setCueControl(target, name, value);
      return;
    }
    sendPreviewControl(target, name, value);
  });
  element.addEventListener("woo-dubspace-control-commit", (event) => {
    const detail = (event as CustomEvent<{ target?: unknown; name?: unknown; value?: unknown }>).detail ?? {};
    const target = String(detail.target ?? "");
    const name = String(detail.name ?? "");
    const value = Number(detail.value);
    if (!target || !name || !Number.isFinite(value)) return;
    if (state.cueSlots[target]) {
      setCueControl(target, name, value);
      return;
    }
    const space = dubspaceSpace();
    if (space) call(space, space, "set_control", [target, name, value], dubspaceOptimisticProps(target, { [name]: value }, `${target}:${name}`));
  });
  element.addEventListener("woo-dubspace-transport", (event) => {
    const mode = String((event as CustomEvent<{ mode?: unknown }>).detail?.mode ?? "");
    const drum = dubspaceMeta().drum ?? "";
    const props = mode === "stop"
      ? { playing: false }
      : { playing: true, started_at: Date.now() + state.clockOffset };
    callDubspaceMutation(mode === "stop" ? "stop_transport" : "start_transport", [], dubspaceOptimisticProps(drum, props, `${drum}:transport`));
  });
  element.addEventListener("woo-dubspace-tempo", (event) => {
    const bpm = Number((event as CustomEvent<{ bpm?: unknown }>).detail?.bpm);
    const drum = dubspaceMeta().drum ?? "";
    if (Number.isFinite(bpm)) callDubspaceMutation("set_tempo", [bpm], dubspaceOptimisticProps(drum, { bpm }, `${drum}:bpm`));
  });
  element.addEventListener("woo-dubspace-step", (event) => {
    const detail = (event as CustomEvent<{ voice?: unknown; step?: unknown; enabled?: unknown }>).detail ?? {};
    const voice = String(detail.voice ?? "");
    const step = Number(detail.step);
    const enabled = detail.enabled === true;
    const drum = dubspaceMeta().drum ?? "";
    const pattern = patternWithStep(projectedObjectView(drum)?.props?.pattern, voice, step, enabled);
    callDubspaceMutation("set_drum_step", [voice, step, enabled], dubspaceOptimisticProps(drum, { pattern }, `${drum}:pattern`));
  });
  element.addEventListener("woo-dubspace-save-scene", () => {
    const space = dubspaceSpace();
    if (space) call(space, space, "save_scene", [`Scene ${new Date().toLocaleTimeString()}`]);
  });
  element.addEventListener("woo-dubspace-recall-scene", () => {
    const space = dubspaceSpace();
    const scene = dubspaceMeta().scene;
    if (space && scene) call(space, space, "recall_scene", [scene]);
  });
}

function bindDubspace() {
  mountDubspaceComponent();
  bindSpaceChatPanels();
  document.querySelectorAll<HTMLElement>("[data-pitch-dial]").forEach((dial) => bindPitchDial(dial));
}

function enterDubspace() {
  const space = dubspaceSpace();
  if (!space || !canSendDirect()) return;
  direct(space, "enter", [], (result) => {
    applyScopedMoveResult(result);
    setDubspaceOperators(result);
    void ensureScopedOverlayForTab("dubspace").then(() => {
      if (state.tab === "dubspace") render();
    });
    requestSpaceChatFocus(space);
  });
}

function leaveDubspace(done?: () => void) {
  const space = dubspaceSpace();
  if (!space || !canSendDirect()) {
    done?.();
    return;
  }
  if (!dubspaceOperators().includes(state.actor ?? "")) {
    done?.();
    return;
  }
  direct(space, "leave", [], (result) => {
    applyScopedMoveResult(result);
    setDubspaceOperators(result);
    done?.();
    void ensureScopedOverlayForTab("dubspace");
    if (state.tab === "dubspace") render();
  });
}

function setDubspaceOperators(result: any) {
  const space = dubspaceSpace();
  const operators = Array.isArray(result)
    ? result
    : Array.isArray(result?.operators)
      ? result.operators
      : [];
  if (!space) return;
  patchDubspaceProjectionProps(space, { operators: operators.map(String) });
}

function addDubspaceOperator(actor: string | undefined) {
  const space = dubspaceSpace();
  if (!actor || !space) return;
  const operators = dubspaceOperators();
  if (operators.includes(actor)) return;
  patchDubspaceProjectionProps(space, { operators: [...operators, actor] });
}

function removeDubspaceOperator(actor: string | undefined) {
  const space = dubspaceSpace();
  if (!actor || !space) return;
  patchDubspaceProjectionProps(space, { operators: dubspaceOperators().filter((item) => item !== actor) });
}

function bindPitchDial(dial: HTMLElement) {
  const input = dial.parentElement?.querySelector<HTMLInputElement>("[data-pitch-input]");
  if (!input) return;
  const update = (event: PointerEvent, commit = false) => {
    const rect = dial.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = event.clientX - cx;
    const dy = event.clientY - cy;
    const angle = clamp(Math.atan2(dx, -dy) * 180 / Math.PI, -135, 135);
    const normalized = (angle + 135) / 270;
    const semitone = Math.round(PITCH_MIN_SEMITONE + normalized * (PITCH_MAX_SEMITONE - PITCH_MIN_SEMITONE));
    input.value = String(clamp(semitone, PITCH_MIN_SEMITONE, PITCH_MAX_SEMITONE));
    syncPitchInput(input);
    input.dispatchEvent(new Event(commit ? "change" : "input", { bubbles: true }));
  };
  let active = false;
  dial.addEventListener("pointerdown", (event) => {
    active = true;
    dial.setPointerCapture(event.pointerId);
    update(event);
  });
  dial.addEventListener("pointermove", (event) => {
    if (active) update(event);
  });
  dial.addEventListener("pointerup", (event) => {
    if (!active) return;
    active = false;
    update(event, true);
  });
  dial.addEventListener("pointercancel", () => {
    active = false;
  });
  dial.addEventListener("wheel", (event) => {
    event.preventDefault();
    const direction = event.deltaY > 0 ? -1 : 1;
    input.value = String(clamp(Number(input.value) + direction, PITCH_MIN_SEMITONE, PITCH_MAX_SEMITONE));
    syncPitchInput(input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { passive: false });
}

function normalizePattern(raw: any): Record<string, boolean[]> {
  const out: Record<string, boolean[]> = {};
  for (const voice of drumVoices) {
    const row = Array.isArray(raw?.[voice.id]) ? raw[voice.id] : [];
    out[voice.id] = Array.from({ length: 8 }, (_, index) => Boolean(row[index]));
  }
  return out;
}

function renderStepRow(voice: string, label: string, row: boolean[]) {
  return `
    <div class="step-row">
      <span>${escapeHtml(label)}</span>
      ${row
        .map(
          (enabled, index) =>
            `<button class="step ${enabled ? "active" : ""}" data-step="${escapeHtml(`${voice}:${index}`)}" data-enabled="${enabled ? "true" : "false"}">${index + 1}</button>`
        )
        .join("")}
    </div>
  `;
}

function enterChat() {
  const room = activeChatRoom();
  if (!room || !canSendDirect()) return;
  direct(room, "enter", [], (result) => {
    applyScopedMoveResult(result);
    setCurrentChatRoom(room);
    setChatPresent(result);
    if (!scopedProjectionEnabled && result?.look_deferred === true) direct(room, "look", [], applyLookResult, receiveChatError);
    if (state.tab === "chat") render();
  }, receiveChatError);
}

function isChatObservation(observation: any) {
  return [
    "said",
    "text",
    "said_to",
    "said_as",
    "emoted",
    "posed",
    "quoted",
    "self_pointed",
    "told",
    "entered",
    "left",
    "looked",
    "who",
    "blocked_exit",
    "taken",
    "dropped",
    "note_read",
    "note_dispersed",
    "huh",
    "dubspace_activity",
    "dubspace_entered",
    "dubspace_left",
    "pinboard_activity",
    "pinboard_entered",
    "pinboard_left",
    "cockatoo_squawk",
    "cockatoo_muffled",
    "cockatoo_taught",
    "cockatoo_gagged",
    "cockatoo_ungagged",
    "cockatoo_fed",
    "cockatoo_pluck",
    "cockatoo_shake",
    "cockatoo_seen"
  ].includes(String(observation?.type ?? ""));
}

function isDubspaceObservation(observation: any) {
  return [
    "dubspace_entered",
    "dubspace_left",
    "dubspace_activity"
  ].includes(String(observation?.type ?? ""));
}

function isPinboardObservation(observation: any) {
  return [
    "pinboard_entered",
    "pinboard_left",
    "pinboard_activity",
    "pin_added",
    "pin_removed",
    "pin_moved",
    "pin_resized",
    "pin_recolored",
    "note_added",
    "note_moved",
    "note_resized",
    "note_edited",
    "note_color_changed",
    "note_deleted",
    "notes_cleared"
  ].includes(String(observation?.type ?? ""));
}

function isPinboardViewportObservation(observation: any) {
  return String(observation?.type ?? "") === "pinboard_viewport";
}

function pinboardObservationNeedsNotesRefresh(type: string) {
  return [
    "pin_added",
    "pin_removed",
    "pin_recolored",
    "note_added",
    "note_edited",
    "note_color_changed",
    "note_deleted",
    "notes_cleared"
  ].includes(type);
}

function applyPinboardPlacementObservation(observation: any): boolean {
  const type = String(observation?.type ?? "");
  if (type !== "pin_moved" && type !== "pin_resized" && type !== "note_moved" && type !== "note_resized") return false;
  if (scopedProjectionEnabled) return false;
  const id = String(observation?.pin ?? observation?.id ?? "");
  const notes = state.world?.pinboard?.notes;
  if (!id || !Array.isArray(notes)) return false;
  const note = notes.find((item: any) => String(item?.id ?? "") === id);
  if (!note) return false;
  let changed = false;
  const assignNumber = (field: "x" | "y" | "w" | "h" | "z") => {
    const value = Number(observation?.[field]);
    if (!Number.isFinite(value)) return;
    if (note[field] === value) return;
    note[field] = value;
    changed = true;
  };
  if (type === "pin_moved" || type === "note_moved") {
    assignNumber("x");
    assignNumber("y");
    assignNumber("z");
  }
  if (type === "pin_resized" || type === "note_resized") {
    assignNumber("w");
    assignNumber("h");
  }
  return changed;
}

function receivePinboardViewport(observation: any) {
  const actor = String(observation?.actor ?? "");
  if (!actor || actor === state.actor) return;
  const board = pinboardSpace();
  const source = String(observation?.board ?? observation?.source ?? "");
  if (board && source && source !== board) return;
  const next = pinboardViewportFromObservation(actor, observation);
  if (!next) return;
  state.pinboardViewports[actor] = next;
  upsertPinboardViewportElement(next);
}

function pinboardViewportFromObservation(actor: string, observation: any): PinboardViewportPresence | undefined {
  const x = Number(observation?.x);
  const y = Number(observation?.y);
  const w = Number(observation?.w);
  const h = Number(observation?.h);
  const scale = Number(observation?.scale);
  if (![x, y, w, h, scale].every(Number.isFinite)) return undefined;
  if (w <= 0 || h <= 0 || scale <= 0) return undefined;
  return {
    actor,
    x,
    y,
    w: clamp(w, 24, 10000),
    h: clamp(h, 24, 10000),
    scale: clamp(scale, PINBOARD_MIN_ZOOM, PINBOARD_MAX_ZOOM),
    at: Date.now()
  };
}

function capturePinboardAnimations(observations: any[]): PinNoteAnimation[] {
  if (state.tab !== "pinboard") return [];
  const animations = new Map<string, PinNoteAnimation>();
  for (const observation of observations) {
    const type = String(observation?.type ?? "");
    if (type !== "note_moved" && type !== "note_resized" && type !== "pin_moved" && type !== "pin_resized") continue;
    if (String(observation?.actor ?? "") === state.actor) continue;
    const id = String(observation?.pin ?? observation?.id ?? "");
    if (!id || animations.has(id)) continue;
    const from = pinNoteBox(id);
    if (from) animations.set(id, { id, from });
  }
  return Array.from(animations.values());
}

function animatePinboardNotes(animations: PinNoteAnimation[]) {
  if (state.tab !== "pinboard" || animations.length === 0) return;
  for (const animation of animations) animatePinboardNote(animation);
}

function animatePinboardNote(animation: PinNoteAnimation) {
  const note = pinNoteElement(animation.id);
  if (!note) return;
  const to = pinNoteBox(animation.id);
  if (!to) return;
  const dx = animation.from.x - to.x;
  const dy = animation.from.y - to.y;
  const sx = to.w > 0 ? animation.from.w / to.w : 1;
  const sy = to.h > 0 ? animation.from.h / to.h : 1;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;

  note.classList.remove("pin-note-animating");
  note.style.transition = "none";
  note.style.transformOrigin = "0 0";
  note.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
  note.getBoundingClientRect();
  window.requestAnimationFrame(() => {
    note.classList.add("pin-note-animating");
    note.style.transition = "";
    note.style.transform = "translate(0, 0) scale(1, 1)";
    const cleanup = () => {
      note.classList.remove("pin-note-animating");
      note.style.transform = "";
      note.style.transformOrigin = "";
    };
    note.addEventListener("transitionend", cleanup, { once: true });
    window.setTimeout(cleanup, 520);
  });
}

function pinNoteElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-pin-note="${cssAttrValue(id)}"]`);
}

function pinNoteBox(id: string): PinNoteBox | null {
  const note = pinNoteElement(id);
  const stage = note?.closest<HTMLElement>(".pinboard-stage");
  if (!note || !stage) return null;
  const noteRect = note.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  return {
    x: noteRect.left - stageRect.left,
    y: noteRect.top - stageRect.top,
    w: noteRect.width,
    h: noteRect.height
  };
}

function pinboardViewportElement(actor: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-pinboard-viewport="${cssAttrValue(actor)}"]`);
}

function upsertPinboardViewportElement(viewport: PinboardViewportPresence) {
  void viewport;
  updatePinboardMapViewports();
}

function removePinboardViewport(actor: string) {
  if (!actor) return;
  delete state.pinboardViewports[actor];
  pinboardViewportElement(actor)?.remove();
  updatePinboardMapViewports();
}

function clearPinboardViewports() {
  state.pinboardViewports = {};
  if (pinboardViewportTimer !== undefined) {
    window.clearTimeout(pinboardViewportTimer);
    pinboardViewportTimer = undefined;
  }
  lastPinboardViewportSent = undefined;
  document.querySelectorAll("[data-pinboard-viewport]").forEach((element) => element.remove());
  refreshPinboardMap();
}

function receiveChatEvent(observation: any, shouldRender = true) {
  // `text` is a directed observation (spec/semantics/events.md §12.7.1) — it
  // belongs in its target's feed only. We still see other actors' lines in
  // our own DirectResultFrame.observations envelope (the originator gets the
  // full room fan-out by design), so filter here before they reach the chat
  // pane. Without this, a verb like `:move`'s `:announce_all_but` echoes
  // every recipient's line back to the caller.
  if (
    String(observation?.type ?? "") === "text"
    && typeof observation?.target === "string"
    && state.actor
    && observation.target !== state.actor
  ) return;
  applyScopedChatObservation(observation);
  const kind = chatLineKind(observation);
  const presentActors = presentActorsFromObservation(observation);
  // Only adopt present_actors as the chat sidebar list when the observation
  // came from the actor's current chat room; a `look at pinboard` from the
  // deck would otherwise overwrite the deck's presence list with the
  // pinboard's subscribers.
  const observationRoom = typeof observation.room === "string" ? observation.room : "";
  const fromCurrentRoom = !observationRoom || observationRoom === chatRoom();
  if ((kind === "looked" || kind === "who") && presentActors.length > 0 && fromCurrentRoom) state.chatPresent = presentActors;
  if (kind === "entered" && typeof observation.actor === "string" && !state.chatPresent.includes(observation.actor)) {
    state.chatPresent = [...state.chatPresent, observation.actor];
  }
  if (kind === "left" && typeof observation.actor === "string") {
    state.chatPresent = state.chatPresent.filter((id) => id !== observation.actor);
  }
  // `taken` / `dropped` (and `entered` / `left`) are room-broadcasts that the
  // server's audience computation excludes the doer from (world.ts'
  // observationAudienceActors). The originator still receives them in their
  // DirectResultFrame.observations envelope by design, so the doer-exclusion
  // has to be applied here before the chat line is pushed; the verb's own
  // tell(actor, …) line ("You drop X.") already covers the doer's view.
  if (
    (kind === "taken" || kind === "dropped" || kind === "entered" || kind === "left")
    && typeof observation.actor === "string"
    && state.actor
    && observation.actor === state.actor
  ) return;
  // `note_read` carries the full note body in `observation.text` (per the
  // $note schema). The reader wants to see the body inline in chat;
  // bystanders should get a brief "X reads Y." line instead of the entire
  // body dumped into their feed.
  let lineText = typeof observation.text === "string" ? observation.text : chatSystemText(observation);
  if (
    kind === "note_read"
    && typeof observation.actor === "string"
    && (!state.actor || observation.actor !== state.actor)
  ) {
    lineText = chatSystemText(observation);
  }
  pushChatLine({
    kind,
    actor: typeof observation.actor === "string" ? observation.actor : undefined,
    from: typeof observation.from === "string" ? observation.from : undefined,
    to: typeof observation.to === "string" ? observation.to : undefined,
    style: typeof observation.style === "string" ? observation.style : undefined,
    reason: typeof observation.reason === "string" ? observation.reason : undefined,
    source: chatObservationSource(observation),
    text: lineText,
    ts: typeof observation.ts === "number" ? observation.ts : undefined
  }, shouldRender);
}

function applyScopedMoveResult(result: any) {
  if (!scopedProjectionEnabled || !result || typeof result !== "object" || Array.isArray(result)) return;
  if (!state.scopedProjection) state.scopedProjection = { inventory: [], overlays: {} };
  state.scopedProjection = scopedModelWithMoveResult(state.scopedProjection, result);
  if (typeof result.room === "string" || (result.here && typeof result.here === "object" && !Array.isArray(result.here))) {
    scopedProjectionLocalRevision += 1;
  }
  applyScopedProjectionModel();
}

function applyScopedProjectionModel() {
  if (!state.scopedProjection) return;
  const here = state.scopedProjection.here;
  ui.ingestSnapshot("here", roomSnapshotObjects(here));
  state.chatPresent = scopedHerePresentActors(here);
  lastObservedChatRoom = typeof here?.id === "string" ? here.id : "";
}

function applyScopedChatObservation(observation: any) {
  if (!scopedProjectionEnabled || !state.scopedProjection?.here || !observation || typeof observation !== "object" || Array.isArray(observation)) return;
  const room = typeof observation.room === "string" ? observation.room : typeof observation.source === "string" ? observation.source : "";
  if (room && room !== state.scopedProjection.here.id) return;
  const actor = typeof observation.actor === "string" ? observation.actor : "";
  if (!actor) return;
  const type = String(observation.type ?? "");
  if (type === "taken" || type === "dropped") {
    const item = typeof observation.item === "string" ? observation.item : "";
    if (!item) return;
    const title = typeof observation.title === "string" ? observation.title : item;
    const hereId = String(state.scopedProjection.here.id ?? "");
    let contents = arrayOfObjects(state.scopedProjection.here.contents);
    let inventory = arrayOfObjects(state.scopedProjection.inventory);
    if (type === "taken") {
      contents = removeSummaryById(contents, item);
      if (actor === state.actor) inventory = upsertSummaryById(inventory, scopedSummaryForObject(item, title, actor));
    } else {
      contents = upsertSummaryById(contents, scopedSummaryForObject(item, title, hereId));
      if (actor === state.actor) inventory = removeSummaryById(inventory, item);
    }
    const here = { ...state.scopedProjection.here, contents };
    state.scopedProjection = {
      ...state.scopedProjection,
      here,
      inventory,
      me: state.scopedProjection.me ? { ...state.scopedProjection.me, here, inventory } : state.scopedProjection.me
    };
    ui.ingestSnapshot("here", roomSnapshotObjects(here));
    ui.ingestSnapshot("me", [...(state.scopedProjection.self ? [state.scopedProjection.self] : []), ...inventory]);
    return;
  }
  const present = new Set(scopedHerePresentActors(state.scopedProjection.here));
  if (type === "entered") present.add(actor);
  if (type === "left") present.delete(actor);
  if (type !== "entered" && type !== "left") return;
  const summaries = new Map(arrayOfObjects(state.scopedProjection.here.present_actors).map((item) => [String(item.id ?? ""), item]));
  if (type === "entered" && !summaries.has(actor)) summaries.set(actor, ui.observe(actor) ?? { id: actor, name: actor, props: {}, catalogState: {} });
  state.scopedProjection.here = {
    ...state.scopedProjection.here,
    present_actors: [...present].map((id) => summaries.get(id) ?? { id, name: id })
  };
  state.chatPresent = [...present];
  ui.ingestSnapshot("here", roomSnapshotObjects(state.scopedProjection.here));
}

function receiveChatError(error: any) {
  pushChatLine({
    kind: "error",
    text: chatErrorText(error),
    ts: Date.now()
  });
}

function receiveAppliedFrameErrors(frame: any, observations: any[]) {
  const errors = appliedFrameErrorObservations({ observations });
  if (errors.length === 0) return;
  const errorHandler = typeof frame.id === "string" ? pendingFrameErrors.get(frame.id) : undefined;
  for (const error of errors) (errorHandler ?? receiveChatError)(error);
}

function chatLineKind(observation: any): ChatLine["kind"] {
  const type = String(observation?.type ?? "");
  if (type === "cockatoo_squawk" || type === "cockatoo_muffled" || type === "cockatoo_taught" || type === "cockatoo_gagged" || type === "cockatoo_ungagged" || type === "cockatoo_fed" || type === "cockatoo_pluck" || type === "cockatoo_shake" || type === "cockatoo_seen") return "system";
  if (type === "dubspace_activity" || type === "dubspace_entered" || type === "dubspace_left") return "system";
  if (type === "pinboard_activity" || type === "pinboard_entered" || type === "pinboard_left") return "system";
  return type as ChatLine["kind"];
}

function chatSystemText(observation: any): string | undefined {
  const type = String(observation?.type ?? "");
  if (type === "cockatoo_seen") return `The cockatoo seems ${String(observation.mood ?? "alert")}.`;
  if (type === "cockatoo_taught") return `The cockatoo learned "${String(observation.phrase ?? "")}".`;
  if (type === "cockatoo_gagged") return "The cockatoo is gagged.";
  if (type === "cockatoo_ungagged") return "The cockatoo is ungagged.";
  if (type === "cockatoo_fed") return `The cockatoo eats ${String(observation.food ?? "something")}.`;
  if (type === "cockatoo_pluck") return "*EEEEEEK!*";
  if (type === "cockatoo_shake") return `The cockatoo ${String(observation.reaction ?? "reacts")}.`;
  if (type === "dubspace_activity" || type === "dubspace_entered" || type === "dubspace_left") return String(observation.text ?? "The dubspace changes.");
  if (type === "pinboard_activity" || type === "pinboard_entered" || type === "pinboard_left") return String(observation.text ?? "The pinboard changes.");
  if (type === "blocked_exit") return String(observation.text ?? "You can't go that way.");
  if (type === "taken") return String(observation.text ?? `${actorLabel(String(observation.actor ?? ""))} takes something.`);
  if (type === "dropped") return String(observation.text ?? `${actorLabel(String(observation.actor ?? ""))} drops something.`);
  if (type === "note_read") return `${actorLabel(String(observation.actor ?? ""))} reads ${actorLabel(String(observation.note ?? ""))}.`;
  if (type === "note_dispersed") return String(observation.text ?? `${actorLabel(String(observation.note ?? ""))} disperses in a puff of smoke.`);
  return undefined;
}

function currentChatOutputSpace(): string {
  if (state.tab === "dubspace") return dubspaceSpace();
  if (state.tab === "pinboard") return pinboardSpace();
  return chatRoom();
}

function chatObservationSource(observation: any): string | undefined {
  if (String(observation?.type ?? "") === "text" && typeof observation?.target === "string") {
    if (!state.actor || observation.target === state.actor) return currentChatOutputSpace();
  }
  // Prefer fields that name the room/space the observation belongs in (for the
  // chat panel filter). `source` is the emitter (e.g. the cockatoo), which
  // isn't always a $space — falling back to it would filter out cockatoo_* and
  // similar object-emitted observations from the chat feed.
  for (const key of ["room", "space", "board", "source"]) {
    const value = observation?.[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function pushChatLine(line: ChatLine, shouldRender = true) {
  state.chatFeed = [...state.chatFeed, line].slice(-160);
  if (shouldRender && currentTabHasChatPanel()) render();
}

function pushChatSeparator(source: string, shouldRender = true) {
  if (!source) return;
  const now = Date.now();
  const recent = lastChatSeparatorAtBySource.get(source) ?? 0;
  if (now - recent < chatSeparatorMinIntervalMs) return;
  lastChatSeparatorAtBySource.set(source, now);
  pushChatLine({ kind: "separator", source, ts: now }, shouldRender);
}

function nestedSpaceParentRoom(space: string): string {
  const obj = projectedObjectView(space);
  const mountRoom = obj?.props?.mount_room;
  if (typeof mountRoom === "string" && mountRoom) return mountRoom;
  const location = obj?.location;
  return typeof location === "string" ? location : "";
}

function markNestedSpaceDeparture(space: string) {
  const parentRoom = nestedSpaceParentRoom(space);
  // Moving into a nested feature-space mounted under the default room leaves
  // chatMeta.room unchanged, so refresh() cannot infer the away boundary.
  if (parentRoom && parentRoom === chatRoom() && parentRoom === defaultChatRoom()) pushChatSeparator(parentRoom, false);
}

function currentTabHasChatPanel(): boolean {
  return ["chat", "dubspace", "pinboard"].includes(state.tab);
}

function loadChatHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(chatHistoryKey) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(-chatHistoryLimit)
      : [];
  } catch {
    return [];
  }
}

function saveChatHistory() {
  try {
    localStorage.setItem(chatHistoryKey, JSON.stringify(chatHistory.slice(-chatHistoryLimit)));
  } catch {
    // Local history is a convenience only; private-mode storage failures should
    // not affect chat input.
  }
}

function loadSpaceChatHeights(): Record<string, number> {
  const heights: Record<string, number> = {};
  try {
    const parsed = JSON.parse(readStorage(spaceChatHeightsKey) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [space, value] of Object.entries(parsed)) heights[space] = normalizeSpaceChatHeight(Number(value));
    }
  } catch {
    // Per-space chat sizing is a UI preference only.
  }
  const legacyPinboardHeight = Number(readStorage(legacyPinboardChatHeightKey));
  if (Number.isFinite(legacyPinboardHeight) && heights.the_pinboard === undefined) {
    heights.the_pinboard = normalizeSpaceChatHeight(legacyPinboardHeight);
  }
  return heights;
}

function saveSpaceChatHeight(space: string, value: number) {
  if (!space) return;
  state.spaceChatHeights = { ...state.spaceChatHeights, [space]: normalizeSpaceChatHeight(value) };
  writeStorage(spaceChatHeightsKey, JSON.stringify(state.spaceChatHeights));
}

function spaceChatHeight(space: string): number {
  return normalizeSpaceChatHeight(state.spaceChatHeights[space] ?? SPACE_CHAT_DEFAULT_HEIGHT);
}

function normalizeSpaceChatHeights() {
  state.spaceChatHeights = Object.fromEntries(
    Object.entries(state.spaceChatHeights).map(([space, height]) => [space, normalizeSpaceChatHeight(height)])
  );
}

function normalizeSpaceChatHeight(value: number): number {
  const max = Math.max(SPACE_CHAT_MIN_HEIGHT, Math.round(window.innerHeight * SPACE_CHAT_MAX_VIEWPORT_RATIO));
  return clamp(Number.isFinite(value) ? value : SPACE_CHAT_DEFAULT_HEIGHT, SPACE_CHAT_MIN_HEIGHT, max);
}

function spaceChatDraft(space: string): string {
  return state.spaceChatDrafts[space] ?? "";
}

function setSpaceChatDraft(space: string, value: string) {
  if (!space) return;
  state.spaceChatDrafts = { ...state.spaceChatDrafts, [space]: value };
}

function rememberChatInput(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (chatHistory.at(-1) !== trimmed) chatHistory = [...chatHistory, trimmed].slice(-chatHistoryLimit);
  chatHistoryCursor = chatHistory.length;
  chatHistoryDraft = "";
  saveChatHistory();
}

function setChatInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  if (input.dataset.spaceChatInput !== undefined) setSpaceChatDraft(input.dataset.spaceChatSpace ?? "", value);
  else state.chatDraft = value;
  input.setSelectionRange(value.length, value.length);
}

function navigateChatHistory(event: KeyboardEvent, input: HTMLInputElement) {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  if (chatHistory.length === 0) return;
  event.preventDefault();
  if (event.key === "ArrowUp") {
    if (chatHistoryCursor === chatHistory.length) chatHistoryDraft = input.value;
    chatHistoryCursor = Math.max(0, chatHistoryCursor - 1);
    setChatInputValue(input, chatHistory[chatHistoryCursor] ?? "");
    return;
  }
  if (chatHistoryCursor >= chatHistory.length) return;
  chatHistoryCursor += 1;
  setChatInputValue(input, chatHistoryCursor >= chatHistory.length ? chatHistoryDraft : chatHistory[chatHistoryCursor] ?? "");
}

function setChatPresent(result: any) {
  if (Array.isArray(result)) state.chatPresent = result.map(String);
  if (Array.isArray(result?.present_actors)) state.chatPresent = idsFromRefsOrSummaries(result.present_actors);
}

function setCurrentChatRoom(room: string) {
  if (room) chatRoomPin = { room, expiresAt: Date.now() + 2_500 };
  if (!scopedProjectionEnabled && state.world?.chatMeta) {
    state.world.chatMeta.room = room;
    state.world.chat = projectChat(state.world, state.world.chatMeta);
  }
  if (state.actor && !state.chatPresent.includes(state.actor)) state.chatPresent = [...state.chatPresent, state.actor];
  syncUrlFromCurrentState("replace");
}

function applyChatLeaveResult(leftRoom: string, result: any) {
  applyScopedMoveResult(result);
  const nextRoom = typeof result?.room === "string" ? result.room : "";
  if (leftRoom && nextRoom && leftRoom !== nextRoom) pushChatSeparator(leftRoom, false);
  if (nextRoom) setCurrentChatRoom(nextRoom);
  setChatPresent(result);
}

function renderChat() {
  const tag = chatFrameComponentTag();
  if (!tag) return `<section class="panel"><p class="empty-state">No chat UI is registered for this room.</p></section>`;
  return `<${tag} data-chat-space-host></${tag}>`;
}

function mountChatComponent() {
  const element = document.querySelector<WooElement & { data?: ChatSpaceData }>("[data-chat-space-host]");
  if (!element) return;
  bindChatComponentEvents(element);
  const present = state.chatPresent;
  const subject = activeChatRoom();
  const room = projectedObjectView(subject);
  const inRoom = Boolean(state.actor && subject && (actorPresentInSpace(subject) || present.includes(state.actor)));
  const lines = chatLinesForSpace(subject);
  element.subject = subject;
  element.woo = createChatWooContext(subject, chatLineActorRefs(lines));
  setCustomElementData(element, {
    roomName: String(room?.name ?? "Room"),
    roomDescription: String(room?.props?.description ?? ""),
    titleBadges: roomTitleBadges(subject),
    lines,
    present,
    draft: state.chatDraft,
    inRoom,
    canSend: canSendDirect()
  }, () => scrollChatFeedToEnd(element.querySelector<HTMLElement>(".chat-feed") ?? ".chat-feed"));
}

function roomTitleBadges(room: string): ChatTitleBadge[] {
  const badges: ChatTitleBadge[] = [];
  const components = ui.catalogUi.componentsForSurface("title-badge");
  if (!room || components.length === 0) return badges;
  for (const item of currentRoomContents(room)) {
    const subject = String(item?.id ?? "");
    if (!subject) continue;
    const component = components.find((candidate) => {
      const constraint = candidate.declaration.subject;
      return typeof constraint === "string" && clientClassDistance(subject, constraint) !== false;
    });
    if (!component) continue;
    ensureProjectionFields(subject, component.declaration.requires ?? []);
    const projected = ui.observe(subject) ?? item;
    badges.push({
      id: `${component.qualifiedId}:${subject}`,
      tag: component.declaration.tag,
      subject,
      data: projected
    });
  }
  return badges;
}

function currentRoomContents(room: string): any[] {
  if (!room) return [];
  if (scopedProjectionEnabled && String(state.scopedProjection?.here?.id ?? "") === room) {
    return arrayOfObjects(state.scopedProjection?.here?.contents)
      .map((item) => {
        const id = String(item?.id ?? "");
        return id ? ui.observe(id) ?? item : null;
      })
      .filter((item): item is any => Boolean(item));
  }
  const contentIds = Array.isArray(state.world?.objects?.[room]?.contents) ? state.world.objects[room].contents : [];
  return contentIds
    .map((id: unknown) => projectedObjectView(String(id)))
    .filter((item: any): item is any => Boolean(item));
}

function chatFrameComponentTag(): string | null {
  const subject = activeChatRoom();
  const resolved = subject ? ui.catalogUi.resolveFrame(subject, undefined, clientClassDistance) : undefined;
  const firstMainNode = resolved?.frame.regions.main?.[0];
  const component = firstMainNode ? ui.catalogUi.component(firstMainNode.component, resolved?.catalog.alias) : undefined;
  return (component ?? ui.catalogUi.component("chat.space", "chat"))?.declaration.tag ?? null;
}

function toolFrameComponentTag(subject: string, fallbackComponent: string, declaringAlias: string): string | null {
  const resolved = subject ? ui.catalogUi.resolveFrame(subject, undefined, clientClassDistance) : undefined;
  const firstMainNode = resolved?.frame.regions.main?.[0];
  const component = firstMainNode ? ui.catalogUi.component(firstMainNode.component, resolved?.catalog.alias) : undefined;
  return (component ?? ui.catalogUi.component(fallbackComponent, declaringAlias))?.declaration.tag ?? null;
}

function setCustomElementData<T>(element: HTMLElement & { data?: T }, data: T, afterRender?: () => void) {
  const assign = () => {
    element.data = data;
    afterRender?.();
  };
  if (customElements.get(element.localName)) {
    assign();
    return;
  }
  void customElements.whenDefined(element.localName).then(assign);
}

function clientClassDistance(subject: string, classRef: string): number | false {
  if (scopedProjectionEnabled) {
    const object = ui.observe(subject);
    if (subject === classRef || object?.parent === classRef) return subject === classRef ? 0 : 1;
    const ancestors = Array.isArray(object?.ancestors) ? object.ancestors.map(String) : [];
    const index = ancestors.indexOf(classRef);
    return index >= 0 ? Math.max(1, ancestors.length - index) : false;
  }
  let current: string | undefined = subject;
  for (let distance = 0; current; distance += 1) {
    if (current === classRef) return distance;
    const parent: unknown = state.world?.objects?.[current]?.parent;
    current = typeof parent === "string" && parent !== current ? parent : undefined;
  }
  return false;
}

function bindChatComponentEvents(element: WooElement & { data?: ChatSpaceData }) {
  if (element.dataset.chatEventsBound === "true") return;
  element.dataset.chatEventsBound = "true";
  element.addEventListener("woo-chat-enter", enterChat);
  element.addEventListener("woo-chat-leave", () => {
    const room = chatRoom();
    if (!room) return;
    direct(room, "leave", [], (result) => {
      applyChatLeaveResult(room, result);
      if (state.tab === "chat") render();
    }, receiveChatError);
  });
  element.addEventListener("woo-chat-look", refreshChatLook);
  element.addEventListener("woo-chat-draft", (event) => {
    const value = String((event as CustomEvent<{ value?: unknown }>).detail?.value ?? "");
    state.chatDraft = value;
    chatHistoryCursor = chatHistory.length;
    chatHistoryDraft = state.chatDraft;
  });
  element.addEventListener("woo-chat-history", (event) => {
    const detail = (event as CustomEvent<{ event?: KeyboardEvent; input?: HTMLInputElement }>).detail ?? {};
    if (detail.event && detail.input) navigateChatHistory(detail.event, detail.input);
  });
  element.addEventListener("woo-chat-submit", (event) => {
    const detail = (event as CustomEvent<{ text?: unknown; input?: HTMLInputElement }>).detail ?? {};
    const text = String(detail.text ?? "").trim();
    if (!text) return;
    rememberChatInput(text);
    state.chatDraft = "";
    if (detail.input) detail.input.value = "";
    void (element.woo?.send(text, activeChatRoom()) ?? Promise.resolve(sendChatInput(activeChatRoom(), text)));
    focusChatInput();
  });
  element.addEventListener("woo-chat-recipient", (event) => {
    const actor = String((event as CustomEvent<{ actor?: unknown }>).detail?.actor ?? "");
    if (!actor) return;
    state.chatDraft = `/tell ${actor} `;
    render();
    focusChatInput();
  });
}

function createChatWooContext(subject: string, extraRefs: string[] = []): WooContext {
  const frameId = `chat:${subject || "room"}`;
  ui.frames.ensureFrame(frameId, subject, "default");
  const neighborhoodRefs = new Set([subject, ...(state.chatPresent ?? []), ...extraRefs, ...(state.actor ? [state.actor] : [])].filter(Boolean));
  return {
    actor: state.actor ?? null,
    frame: {
      id: frameId,
      subject,
      view: "default",
      get: (key) => ui.frames.frame(frameId)?.values[key],
      set: (key, value) => ui.frames.emit({ type: "set_frame_state", frame: frameId, key, value })
    },
    neighborhood: {
      subject,
      refs: [...neighborhoodRefs],
      related: {},
      has: (ref) => neighborhoodRefs.has(ref)
    },
    observe: (ref) => neighborhoodRefs.has(ref) ? ui.observe(ref) ?? null : null,
    call: async (target, verb, args = [], options) => callWithError(subject, target, verb, args, undefined, options),
    send: async (command, space = subject) => {
      sendChatInput(space, command);
      return null;
    },
    directCall: (target, verb, args = [], options) => new Promise((resolve, reject) => {
      direct(target, verb, args, resolve, reject, options);
    }),
    emit: (action) => ui.frames.emit(action)
  };
}

function chatLinesForSpace(space: string): ChatLine[] {
  if (!space) return [];
  return state.chatFeed.filter((line) => !line.source || line.source === space);
}

function chatLineActorRefs(lines: ChatLine[]): string[] {
  const refs = new Set<string>();
  for (const line of lines) {
    for (const value of [line.actor, line.from, line.to]) if (typeof value === "string" && value) refs.add(value);
  }
  return [...refs];
}

function scrollChatFeedToEnd(target: string | HTMLElement = ".chat-feed") {
  const feed = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  if (!feed) return;
  feed.scrollTop = feed.scrollHeight;
}

function focusChatInput() {
  window.requestAnimationFrame(() => {
    const component = document.querySelector<WooElement & { focusComposer?: () => void }>("[data-chat-space-host]");
    if (component?.focusComposer) {
      component.focusComposer();
      return;
    }
    const input = document.querySelector<HTMLInputElement>("[data-chat-input]");
    input?.focus();
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  });
}

function focusSpaceChatInput(space: string) {
  window.requestAnimationFrame(() => {
    const component = document.querySelector<WooElement & { focusComposer?: () => void }>(`[data-space-chat-panel][data-space-chat-space="${cssAttrValue(space)}"]`);
    if (component?.focusComposer) {
      component.focusComposer();
      return;
    }
    const input = document.querySelector<HTMLInputElement>(`[data-space-chat-input][data-space-chat-space="${cssAttrValue(space)}"]`);
    input?.focus();
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  });
}

function requestSpaceChatFocus(space: string) {
  if (!space) return;
  for (const delay of [0, 50, 150, 400, 900]) window.setTimeout(() => focusSpaceChatInput(space), delay);
}

function sendChatInput(space: string, text: string) {
  if (!space) return;
  // Local-only echo so the feed reads as a transcript; never emitted server-side.
  pushChatLine({ kind: "input", source: space, text, ts: Date.now() });
  ensureSpacePresence(space, () => {
    command(space, text, undefined, receiveChatError);
  }, receiveChatError);
}

type ChatCommandUiAction = { verb: string; target: string };

function chatCommandUiActionFromMessage(message: any): ChatCommandUiAction {
  return {
    verb: String(message?.verb ?? ""),
    target: String(message?.target ?? "")
  };
}

function chatCommandUiActionFromPlan(plan: any): ChatCommandUiAction {
  return {
    verb: String(plan?.verb ?? ""),
    target: String(plan?.target ?? "")
  };
}

function renderChatCommandResult(action: ChatCommandUiAction, result: any, originalText: string) {
  applyScopedMoveResult(result);
  const { verb, target } = action;
  if (verb === "enter" && target === dubspaceSpace()) {
    setDubspaceOperators(result);
    setTab("dubspace", { mode: "push", leaveCurrent: false });
    void ensureScopedOverlayForTab("dubspace");
    if (!scopedProjectionEnabled) void refresh().then(() => requestSpaceChatFocus(target));
    requestSpaceChatFocus(target);
    return;
  }
  if ((verb === "leave" || verb === "out") && target === dubspaceSpace()) {
    setDubspaceOperators(result);
    setTab("chat", { mode: "push", leaveCurrent: false });
    if (!scopedProjectionEnabled) void refresh();
    focusChatInput();
    return;
  }
  if ((verb === "leave" || verb === "out") && target === pinboardSpace()) {
    setPinboardPresent(result);
    clearPinboardViewports();
    setTab("chat", { mode: "push", leaveCurrent: false });
    if (!scopedProjectionEnabled) void refresh();
    focusChatInput();
    return;
  }
  if (verb === "enter" && target === pinboardSpace()) {
    setPinboardPresent(result);
    setTab("pinboard", { mode: "push", leaveCurrent: false });
    void ensureScopedOverlayForTab("pinboard", { force: true });
    refreshPinboardNotes({ force: true });
    if (!scopedProjectionEnabled) void refresh().then(() => requestSpaceChatFocus(target));
    requestSpaceChatFocus(target);
    return;
  }
  if (verb === "who") {
    setChatPresent(result);
    return;
  }
  if (verb === "look") {
    applyLookResult(result);
    return;
  }
  if (verb === "on_say_to" && target) {
    const cutoff = Number(result);
    if (Number.isFinite(cutoff)) {
      patchDubspaceProjectionProps(target, { cutoff });
      syncDubspaceProjectionEffects({ type: "control_changed", target, name: "cutoff", value: cutoff });
    }
    return;
  }
  if (result && typeof result === "object" && typeof result.room === "string") {
    const room = result.room;
    setCurrentChatRoom(room);
    setChatPresent(result);
    if (!scopedProjectionEnabled && result.look_deferred === true) direct(room, "look", [], applyLookResult, receiveChatError);
    if (!scopedProjectionEnabled) void refresh();
    else render();
    return;
  }
  if (verb === "enter") {
    if (target) setCurrentChatRoom(target);
    setChatPresent(result);
    if (!scopedProjectionEnabled && result?.look_deferred === true && target) direct(target, "look", [], applyLookResult, receiveChatError);
    if (!scopedProjectionEnabled) void refresh();
    else render();
    return;
  }
  if (verb === "take" || verb === "drop") {
    if (!scopedProjectionEnabled) void refresh();
    else render();
    return;
  }
  void originalText;
  void result;
}

function refreshChatLook() {
  const room = activeChatRoom();
  if (!room) return;
  direct(room, "look", [], applyLookResult, receiveChatError);
}

function applyLookResult(result: any) {
  const present = Array.isArray(result?.present_actors) ? result.present_actors.map(String) : [];
  if (present.length === 0) return;
  // `look pinboard` returns the board's own subscribers; clobbering chatPresent
  // with them hides the chat UI for anyone not also inside the board, since
  // renderChat treats !present.includes(state.actor) as "you must enter".
  const lookedId = typeof result?.id === "string" ? result.id : "";
  if (lookedId && lookedId !== activeChatRoom()) return;
  state.chatPresent = present;
}

function actorLabel(id: string | undefined) {
  if (!id) return "unknown";
  if (scopedProjectionEnabled) return String(projectedObjectView(id)?.name ?? id);
  return String(state.world?.objects?.[id]?.name ?? id);
}

function renderPinboard() {
  const tag = toolFrameComponentTag(pinboardSpace(), "pinboard.board", "pinboard");
  if (!tag) {
    return `
      <section class="toolbar"><h1>Pinboard</h1></section>
      <section class="panel"><p class="empty-state">No pinboard UI is registered for this board.</p></section>
    `;
  }
  const boardId = pinboardSpace();
  return `<${tag} data-pinboard-board data-pinboard-space="${escapeHtml(boardId)}"></${tag}>`;
}

function renderTasks() {
  const tag = toolFrameComponentTag(tasksSpace(), "tasks.kanban", "tasks");
  if (!tag) {
    return `
      <section class="toolbar"><h1>Tasks</h1></section>
      <section class="panel"><p class="empty-state">No tasks UI is registered for this registry.</p></section>
    `;
  }
  const boardId = tasksSpace();
  return `<${tag} data-tasks-board data-tasks-registry="${escapeHtml(boardId)}"></${tag}>`;
}

function renderSpaceChatPanel(space: string) {
  const height = Math.round(spaceChatHeight(space));
  const component = ui.catalogUi.component("chat.space-mini", "chat");
  const tag = component?.declaration.tag;
  if (!tag) {
    return `
      <section class="panel space-chat-panel" data-space-chat-missing="${escapeHtml(space)}" style="height:${height}px">
        <p class="chat-empty">No chat UI is registered for this space.</p>
      </section>
    `;
  }
  return `<${tag} class="panel space-chat-panel" data-space-chat-panel data-space-chat-space="${escapeHtml(space)}" style="height:${height}px"></${tag}>`;
}

function renderPinboardMap(notes: any[], present: string[], width: number, height: number, palette: string[] = pinboardModel()?.palette ?? []) {
  const model = pinboardMapModel(notes, present, width, height);
  return `
    <div class="pinboard-map" data-pinboard-map data-min-x="${roundCss(model.minX)}" data-min-y="${roundCss(model.minY)}" data-span-x="${roundCss(model.spanX)}" data-span-y="${roundCss(model.spanY)}" aria-label="Pinboard overview">
      ${renderPinboardMapNotes(notes, model, palette)}
      ${renderPinboardMapViewports(present, model, width, height)}
      ${present.length === 0 ? `<p class="pinboard-map-empty">No one is here.</p>` : ""}
    </div>
  `;
}

function renderPinboardMapNotes(notes: any[], model: PinboardMapModel, palette: string[]) {
  return notes.map((note: any) => {
    const id = String(note?.id ?? "");
    const color = pinNoteColor(note, palette);
    return `<div class="pinboard-map-note pin-note-${escapeHtml(color)}" data-pinboard-map-note="${escapeHtml(id)}" style="${pinboardMapBoxStyle(pinNoteRecordBox(note), model)}"></div>`;
  }).join("");
}

function renderPinboardMapViewports(present: string[], model: PinboardMapModel, width: number, height: number) {
  return pinboardMapViewports(present, width, height).map((viewport) => `
    <button class="pinboard-map-viewport ${viewport.actor === state.actor ? "self" : ""}" data-pinboard-viewport="${escapeHtml(viewport.actor)}" title="${escapeHtml(actorLabel(viewport.actor))}" aria-label="${escapeHtml(actorLabel(viewport.actor))}" style="${pinboardMapBoxStyle(viewport, model)}"></button>
  `).join("");
}

function pinboardMapBoxStyle(box: PinNoteBox, model: PinboardMapModel) {
  const { left, top, width, height } = pinboardMapBoxPercent(box, model);
  return `left:${roundCss(left)}%; top:${roundCss(top)}%; width:${roundCss(width)}%; height:${roundCss(height)}%;`;
}

function setPinboardMapBoxStyle(element: HTMLElement, box: PinNoteBox, model: PinboardMapModel) {
  const { left, top, width, height } = pinboardMapBoxPercent(box, model);
  element.style.left = `${roundCss(left)}%`;
  element.style.top = `${roundCss(top)}%`;
  element.style.width = `${roundCss(width)}%`;
  element.style.height = `${roundCss(height)}%`;
}

function pinboardMapBoxPercent(box: PinNoteBox, model: PinboardMapModel) {
  return {
    left: ((box.x - model.minX) / model.spanX) * 100,
    top: ((box.y - model.minY) / model.spanY) * 100,
    width: (box.w / model.spanX) * 100,
    height: (box.h / model.spanY) * 100
  };
}

function pinboardMapModel(notes: any[], present: string[], width: number, height: number, renderedAspect = pinboardRenderedMapAspect()): PinboardMapModel {
  const boxes: PinNoteBox[] = notes.map(pinNoteRecordBox);
  boxes.push(...pinboardMapViewports(present, width, height));
  if (boxes.length === 0) boxes.push({ x: 0, y: 0, w: width, h: height });
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.w));
  const maxY = Math.max(...boxes.map((box) => box.y + box.h));
  const padding = Math.max(80, Math.min(240, Math.max(maxX - minX, maxY - minY) * 0.12));
  let spanX = Math.max(1, maxX - minX + padding * 2);
  let spanY = Math.max(1, maxY - minY + padding * 2);
  let paddedMinX = minX - padding;
  let paddedMinY = minY - padding;
  const aspect = Math.max(0.05, pinNoteNumber(renderedAspect, PINBOARD_MAP_DEFAULT_ASPECT));
  const modelAspect = spanX / spanY;
  if (modelAspect < aspect) {
    const nextSpanX = spanY * aspect;
    paddedMinX -= (nextSpanX - spanX) / 2;
    spanX = nextSpanX;
  } else if (modelAspect > aspect) {
    const nextSpanY = spanX / aspect;
    paddedMinY -= (nextSpanY - spanY) / 2;
    spanY = nextSpanY;
  }
  return {
    minX: paddedMinX,
    minY: paddedMinY,
    spanX,
    spanY
  };
}

function pinboardRenderedMapAspect(map: HTMLElement | null = document.querySelector<HTMLElement>("[data-pinboard-map]")) {
  if (!map) return PINBOARD_MAP_DEFAULT_ASPECT;
  const rect = map.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return PINBOARD_MAP_DEFAULT_ASPECT;
  return rect.width / rect.height;
}

function pinboardMapViewports(present: string[], width: number, height: number): PinboardViewportPresence[] {
  const presentActors = new Set(present.map(String));
  const viewports = Object.values(state.pinboardViewports).filter((viewport) => presentActors.has(viewport.actor));
  if (state.actor && presentActors.has(state.actor)) {
    const local = currentPinboardViewport() ?? estimatedPinboardViewport(width, height);
    viewports.push({ actor: state.actor, ...local, at: Date.now() });
  }
  return viewports;
}

function estimatedPinboardViewport(width: number, height: number): PinNoteBox & { scale: number } {
  const view = normalizedPinboardView();
  return {
    x: (0 - view.x) / view.scale,
    y: (0 - view.y) / view.scale,
    w: width / view.scale,
    h: height / view.scale,
    scale: view.scale
  };
}

function pinNoteRecordBox(note: any): PinNoteBox {
  const id = String(note?.id ?? "");
  return applyProjectedPinPatch(id, {
    x: pinNoteNumber(note?.x, 40),
    y: pinNoteNumber(note?.y, 40),
    w: pinNoteNumber(note?.w, 180),
    h: pinNoteNumber(note?.h, 110)
  });
}

function pinboardPlacementOptimistic(id: string, patch: { x?: number; y?: number; w?: number; h?: number }): ProjectionCallOptions | undefined {
  if (!id) return undefined;
  return {
    optimistic: {
      id: `pinboard:${id}:placement`,
      patches: [pinboardPlacementPatch(id, patch)],
      ttlMs: PINBOARD_OPTIMISTIC_TTL_MS,
      reconcile: "drop_on_applied"
    }
  };
}

function pinboardNoteOptimistic(id: string, patch: Record<string, unknown>): ProjectionCallOptions | undefined {
  if (!id || Object.keys(patch).length === 0) return undefined;
  return {
    optimistic: {
      id: `pinboard:${id}:note`,
      patches: [{ subject: id, catalogState: { pinboard_note: patch } }],
      ttlMs: PINBOARD_OPTIMISTIC_TTL_MS,
      reconcile: "drop_on_applied"
    }
  };
}

function applyProjectedPinPatch<T extends { x: number; y: number; w: number; h: number }>(id: string, base: T): T {
  ui.prune();
  const projected = ui.observe(id)?.catalogState.pinboard_note;
  if (!projected) return base;
  return {
    ...base,
    x: pinNoteNumber(projected.x, base.x),
    y: pinNoteNumber(projected.y, base.y),
    w: pinNoteNumber(projected.w, base.w),
    h: pinNoteNumber(projected.h, base.h)
  };
}

function pinboardPlacementPatch(id: string, patch: { x?: number; y?: number; z?: number; w?: number; h?: number }): ProjectionPatch {
  return { subject: id, catalogState: { pinboard_note: patch } };
}

function pinNoteText(value: any): string {
  return typeof value === "string" ? value : "";
}

function pinNoteColor(note: any, palette: any): string {
  const colors = pinboardPalette(palette);
  if (typeof note?.color === "string" && colors.includes(note.color)) return note.color;
  if (note?.color == null) return "white";
  return colors[0] ?? "white";
}

function normalizePinboardStickyColor(value: unknown, palette: any): string {
  const colors = pinboardPalette(palette);
  if (typeof value === "string" && colors.includes(value)) return value;
  const stored = readStorage(pinboardNewColorKey);
  if (stored && colors.includes(stored)) return stored;
  return colors[0] ?? "white";
}

function rememberPinboardNewColor(value: unknown, palette: any = pinboardModel()?.palette) {
  const color = normalizePinboardStickyColor(value, palette);
  state.pinboardNewColor = color;
  writeStorage(pinboardNewColorKey, color);
}

function mountPinboardComponent() {
  const element = document.querySelector<WooElement & { data?: PinboardData }>("[data-pinboard-board]");
  if (!element) return;
  const pinboard = pinboardModel();
  const board = pinboard?.board;
  const boardId = board?.id ? String(board.id) : pinboardSpace();
  const present = Array.isArray(pinboard?.present) ? pinboard.present.map(String) : [];
  const notes = Array.isArray(pinboard?.notes) ? pinboard.notes : [];
  const actorRefs = new Set<string>([...present]);
  for (const note of notes) {
    for (const ref of [note?.author, note?.owner, note?.updated_by]) if (typeof ref === "string") actorRefs.add(ref);
  }
  element.subject = boardId;
  element.woo = createChatWooContext(boardId, [...actorRefs]);
  setCustomElementData(element, {
    boardId,
    boardName: String(board?.name ?? "Pinboard"),
    boardOwner: typeof board?.owner === "string" ? board.owner : undefined,
    notes,
    present,
    palette: pinboard?.palette ?? [],
    viewport: pinboard?.viewport ?? { w: 960, h: 560 },
    view: normalizedPinboardView(),
    actor: state.actor ?? null,
    inBoard: pinboardActorPresent(),
    canSend: canSendDirect(),
    newText: state.pinboardNewText,
    newColor: state.pinboardNewColor,
    viewports: state.pinboardViewports
  }, () => {
    if (boardId && pinboardActorPresent()) mountToolSpaceChat(element, boardId);
  });
  bindPinboardComponentEvents(element);
}

function bindPinboardComponentEvents(element: WooElement) {
  if (element.dataset.pinboardEventsBound === "true") return;
  element.dataset.pinboardEventsBound = "true";
  element.addEventListener("woo-pinboard-enter", enterPinboard);
  element.addEventListener("woo-pinboard-leave", () => {
    leavePinboard(() => {
      setTab("chat", { mode: "push", leaveCurrent: false });
    });
  });
  element.addEventListener("woo-pinboard-create", (event) => {
    const detail = (event as CustomEvent<{ text?: unknown; color?: unknown }>).detail ?? {};
    const text = String(detail.text ?? state.pinboardNewText).trim();
    if (!text) return;
    const placement = newPinNotePlacement();
    const color = normalizePinboardStickyColor(detail.color, pinboardModel()?.palette);
    rememberPinboardNewColor(color);
    pinboardCall("add_note", [text, color, placement.x, placement.y, placement.w, placement.h]);
    state.pinboardNewText = "";
  });
  element.addEventListener("woo-pinboard-draft", (event) => {
    state.pinboardNewText = String((event as CustomEvent<{ value?: unknown }>).detail?.value ?? "");
  });
  element.addEventListener("woo-pinboard-new-color", (event) => {
    rememberPinboardNewColor((event as CustomEvent<{ color?: unknown }>).detail?.color, pinboardModel()?.palette);
  });
  element.addEventListener("woo-pinboard-note-text", (event) => {
    const detail = (event as CustomEvent<{ id?: unknown; text?: unknown; original?: unknown }>).detail ?? {};
    const id = String(detail.id ?? "");
    const text = String(detail.text ?? "");
    if (!id || text === String(detail.original ?? "")) return;
    pinboardTargetCall(id, "set_text", [text], pinboardNoteOptimistic(id, { text }));
  });
  element.addEventListener("woo-pinboard-note-color", (event) => {
    const detail = (event as CustomEvent<{ id?: unknown; color?: unknown }>).detail ?? {};
    const id = String(detail.id ?? "");
    const color = String(detail.color ?? "");
    rememberPinboardNewColor(color);
    if (id) pinboardTargetCall(id, "set_color", [color], pinboardNoteOptimistic(id, { color: color === "white" ? null : color }));
  });
  element.addEventListener("woo-pinboard-note-action", (event) => {
    const detail = (event as CustomEvent<{ id?: unknown; verb?: unknown }>).detail ?? {};
    const id = String(detail.id ?? "");
    const verb = detail.verb === "eject" ? "eject" : "take";
    if (id) pinboardCall(verb, [id]);
  });
}

function bindPinboard() {
  mountPinboardComponent();
  document.querySelectorAll<HTMLButtonElement>("[data-pin-note-drag]").forEach(bindPinNoteDrag);
  document.querySelectorAll<HTMLButtonElement>("[data-pin-note-resize]").forEach(bindPinNoteResize);
  document.querySelectorAll<HTMLElement>("[data-pin-note]").forEach((note) => {
    note.addEventListener("pointerdown", () => bringPinNoteToTop(note.dataset.pinNote ?? ""));
  });
  bindPinboardMap();
  bindPinboardViewport();
  bindSpaceChatPanels();
}

function bindTasks() {
  mountTasksKanbanComponent();
}

function mountTasksKanbanComponent() {
  const element = document.querySelector<WooElement & { subject?: string }>("[data-tasks-board]");
  if (!element) return;
  const boardId = tasksSpace();
  if (!boardId) return;
  element.subject = boardId;
  element.woo = createChatWooContext(boardId);
}

function bindSpaceChatPanels() {
  document.querySelectorAll<HTMLElement & WooElement & { data?: SpaceChatPanelData; scrollFeedToEnd?: () => void }>("[data-space-chat-panel]").forEach(bindSpaceChatPanel);
}

function bindSpaceChatPanel(panel: HTMLElement & WooElement & { data?: SpaceChatPanelData; scrollFeedToEnd?: () => void }) {
  const space = panel.dataset.spaceChatSpace ?? "";
  const lines = chatLinesForSpace(space);
  panel.subject = space;
  panel.woo = createChatWooContext(space, chatLineActorRefs(lines));
  setCustomElementData(panel, {
    space,
    spaceName: projectedObjectView(space)?.name ?? objectName(state.world, space),
    lines,
    draft: spaceChatDraft(space),
    height: Math.round(spaceChatHeight(space))
  }, () => panel.scrollFeedToEnd?.());
  bindSpaceChatComponentEvents(panel);
  bindSpaceChatResize(panel);
}

function bindSpaceChatComponentEvents(panel: HTMLElement & WooElement) {
  if (panel.dataset.spaceChatEventsBound === "true") return;
  panel.dataset.spaceChatEventsBound = "true";
  panel.addEventListener("woo-chat-draft", (event) => {
    const detail = (event as CustomEvent<{ space?: unknown; value?: unknown }>).detail ?? {};
    const space = String(detail.space ?? panel.dataset.spaceChatSpace ?? "");
    setSpaceChatDraft(space, String(detail.value ?? ""));
    chatHistoryCursor = chatHistory.length;
    chatHistoryDraft = spaceChatDraft(space);
  });
  panel.addEventListener("woo-chat-history", (event) => {
    const detail = (event as CustomEvent<{ event?: KeyboardEvent; input?: HTMLInputElement }>).detail ?? {};
    if (detail.event && detail.input) navigateChatHistory(detail.event, detail.input);
  });
  panel.addEventListener("woo-chat-submit", (event) => {
    const detail = (event as CustomEvent<{ space?: unknown; text?: unknown; input?: HTMLInputElement }>).detail ?? {};
    const space = String(detail.space ?? panel.dataset.spaceChatSpace ?? "");
    const text = String(detail.text ?? "").trim();
    if (!space || !text) return;
    rememberChatInput(text);
    setSpaceChatDraft(space, "");
    if (detail.input) detail.input.value = "";
    void (panel.woo?.send(text, space) ?? Promise.resolve(sendChatInput(space, text)));
    focusSpaceChatInput(space);
  });
}

function bindSpaceChatResize(panel: HTMLElement | null) {
  const handle = panel?.querySelector<HTMLElement>("[data-space-chat-resizer]");
  if (!panel || !handle) return;
  const space = panel.dataset.spaceChatSpace ?? "";
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
    panel.classList.add("is-resizing");
    const move = (moveEvent: PointerEvent) => {
      const height = normalizeSpaceChatHeight(startHeight - (moveEvent.clientY - startY));
      applySpaceChatHeight(panel, height);
    };
    const up = (upEvent: PointerEvent) => {
      handle.releasePointerCapture(upEvent.pointerId);
      panel.classList.remove("is-resizing");
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      saveSpaceChatHeight(space, panel.getBoundingClientRect().height);
      schedulePinboardViewportPublish();
      window.requestAnimationFrame(updatePinboardMapViewports);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  });
}

function applySpaceChatHeight(panel: HTMLElement, height: number) {
  const space = panel.dataset.spaceChatSpace ?? "";
  const normalizedHeight = normalizeSpaceChatHeight(height);
  if (space) state.spaceChatHeights = { ...state.spaceChatHeights, [space]: normalizedHeight };
  const rounded = `${Math.round(normalizedHeight)}px`;
  panel.style.height = rounded;
  if (!(panel.parentElement instanceof HTMLElement)) return;
  panel.parentElement.style.setProperty("--space-chat-h", rounded);
  const layout = panel.parentElement.querySelector<HTMLElement>(`[data-space-chat-layout="${cssAttrValue(space)}"]`);
  if (layout) layout.style.setProperty("--space-chat-h", rounded);
}

function bringPinNoteToTop(id: string) {
  if (!id) return;
  const notes = pinboardModel()?.notes ?? [];
  let max = 0;
  for (const n of notes) {
    const z = pinNoteNumber(n?.z, 1);
    if (z > max) max = z;
  }
  for (const z of pinNoteClientZ.values()) if (z > max) max = z;
  const next = max + 1;
  pinNoteClientZ.set(id, next);
  const el = pinNoteElement(id);
  if (el) el.style.zIndex = String(next);
}

function bindPinboardMap() {
  const mapElement = document.querySelector<HTMLElement>("[data-pinboard-map]");
  mapElement?.addEventListener("click", (event) => {
    const map = event.currentTarget as HTMLElement;
    const rect = map.getBoundingClientRect();
    const spanX = pinNoteNumber(map.dataset.spanX, 1);
    const spanY = pinNoteNumber(map.dataset.spanY, 1);
    const minX = pinNoteNumber(map.dataset.minX, 0);
    const minY = pinNoteNumber(map.dataset.minY, 0);
    const x = minX + ((event.clientX - rect.left) / Math.max(1, rect.width)) * spanX;
    const y = minY + ((event.clientY - rect.top) / Math.max(1, rect.height)) * spanY;
    centerPinboardOn(x, y);
  });
  if (mapElement) window.requestAnimationFrame(updatePinboardMapViewports);
}

function newPinNotePlacement(): PinNoteBox {
  const w = 180;
  const h = 110;
  const viewport = currentPinboardViewport();
  if (!viewport) return { x: 48, y: 48, w, h };
  return {
    x: Math.round(viewport.x + viewport.w / 2 - w / 2),
    y: Math.round(viewport.y + viewport.h / 2 - h / 2),
    w,
    h
  };
}

function refreshPinboardMap() {
  if (state.tab !== "pinboard") return;
  const shell = document.querySelector<HTMLElement>("[data-pinboard-map-shell]");
  const data = pinboardMapData();
  if (!shell || !data) return;
  shell.innerHTML = renderPinboardMap(data.notes, data.present, data.width, data.height, data.palette);
  bindPinboardMap();
}

function updatePinboardMapViewports() {
  if (state.tab !== "pinboard") return;
  const map = document.querySelector<HTMLElement>("[data-pinboard-map]");
  const data = pinboardMapData();
  if (!map || !data) return;
  const model = pinboardMapModel(data.notes, data.present, data.width, data.height, pinboardRenderedMapAspect(map));
  setPinboardMapData(map, model);
  document.querySelectorAll<HTMLElement>("[data-pinboard-map-note]").forEach((note) => {
    const id = note.dataset.pinboardMapNote ?? "";
    const record = data.notes.find((item: any) => String(item?.id ?? "") === id);
    if (record) setPinboardMapBoxStyle(note, pinNoteRecordBox(record), model);
  });
  const viewports = pinboardMapViewports(data.present, data.width, data.height);
  const expected = new Set(viewports.map((viewport) => viewport.actor));
  document.querySelectorAll<HTMLElement>("[data-pinboard-viewport]").forEach((element) => {
    const actor = element.dataset.pinboardViewport ?? "";
    if (!expected.has(actor)) element.remove();
  });
  for (const viewport of viewports) {
    let element = pinboardViewportElement(viewport.actor);
    if (!element) {
      element = document.createElement("button");
      element.className = "pinboard-map-viewport";
      element.dataset.pinboardViewport = viewport.actor;
      map.append(element);
    }
    element.classList.toggle("self", viewport.actor === state.actor);
    element.setAttribute("title", actorLabel(viewport.actor));
    element.setAttribute("aria-label", actorLabel(viewport.actor));
    setPinboardMapBoxStyle(element, viewport, model);
  }
}

function pinboardMapData(): { notes: any[]; present: string[]; width: number; height: number; palette: string[] } | undefined {
  const pinboard = pinboardModel();
  if (!pinboard) return undefined;
  const viewport = pinboard?.viewport ?? { w: 960, h: 560 };
  return {
    width: pinNoteNumber(viewport.w, 960),
    height: pinNoteNumber(viewport.h, 560),
    present: Array.isArray(pinboard?.present) ? pinboard.present : [],
    notes: Array.isArray(pinboard?.notes) ? pinboard.notes : [],
    palette: pinboardPalette(pinboard?.palette)
  };
}

function setPinboardMapData(map: HTMLElement, model: PinboardMapModel) {
  map.dataset.minX = roundCss(model.minX);
  map.dataset.minY = roundCss(model.minY);
  map.dataset.spanX = roundCss(model.spanX);
  map.dataset.spanY = roundCss(model.spanY);
}

function bindPinboardViewport() {
  const stage = document.querySelector<HTMLElement>("[data-pinboard-stage]");
  if (!stage) return;
  document.querySelectorAll<HTMLButtonElement>("[data-pinboard-zoom]").forEach((button) => {
    button.addEventListener("click", () => {
      const direction = button.dataset.pinboardZoom === "in" ? 1 : -1;
      zoomPinboardAtStageCenter(direction > 0 ? PINBOARD_ZOOM_STEP : 1 / PINBOARD_ZOOM_STEP, true);
    });
  });
  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      zoomPinboardAtClient(Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
      return;
    }
    panPinboardBy(-event.deltaX, -event.deltaY);
  }, { passive: false });

  let active = false;
  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;
  stage.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest(".pin-note, .pinboard-zoom-controls, textarea, input, select, button")) return;
    if (blurActivePinNoteText()) {
      event.preventDefault();
      return;
    }
    active = true;
    startX = event.clientX;
    startY = event.clientY;
    baseX = state.pinboardView.x;
    baseY = state.pinboardView.y;
    stage.classList.add("panning");
    stage.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  stage.addEventListener("pointermove", (event) => {
    if (!active) return;
    state.pinboardView = {
      ...state.pinboardView,
      x: baseX + event.clientX - startX,
      y: baseY + event.clientY - startY
    };
    applyPinboardView();
  });
  const stop = () => {
    active = false;
    stage.classList.remove("panning");
  };
  stage.addEventListener("pointerup", stop);
  stage.addEventListener("pointercancel", stop);
  schedulePinboardViewportPublish();
}

function blurActivePinNoteText(): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement && active.matches("[data-pin-note-text]")) {
    active.blur();
    return true;
  }
  return false;
}

function normalizedPinboardView(): PinboardView {
  const current = state.pinboardView;
  const scale = clamp(Number(current.scale), PINBOARD_MIN_ZOOM, PINBOARD_MAX_ZOOM);
  const x = Number.isFinite(Number(current.x)) ? Number(current.x) : 0;
  const y = Number.isFinite(Number(current.y)) ? Number(current.y) : 0;
  if (scale !== current.scale || x !== current.x || y !== current.y) state.pinboardView = { x, y, scale };
  return state.pinboardView;
}

function applyPinboardView(options: { animate?: boolean } = {}) {
  const view = normalizedPinboardView();
  const canvas = document.querySelector<HTMLElement>("[data-pinboard-canvas]");
  const stage = document.querySelector<HTMLElement>("[data-pinboard-stage]");
  if (options.animate) beginPinboardViewAnimation(stage, canvas);
  if (canvas) canvas.style.transform = `translate(${roundCss(view.x)}px, ${roundCss(view.y)}px) scale(${roundCss(view.scale)})`;
  if (stage) {
    stage.style.setProperty("--pinboard-grid-size", `${roundCss(PINBOARD_GRID_SIZE * view.scale)}px`);
    stage.style.setProperty("--pinboard-grid-x", `${roundCss(mod(view.x, PINBOARD_GRID_SIZE * view.scale))}px`);
    stage.style.setProperty("--pinboard-grid-y", `${roundCss(mod(view.y, PINBOARD_GRID_SIZE * view.scale))}px`);
  }
  const label = document.querySelector<HTMLElement>("[data-pinboard-zoom-label]");
  if (label) label.textContent = `${Math.round(view.scale * 100)}%`;
  updatePinboardMapViewports();
  schedulePinboardViewportPublish();
}

function beginPinboardViewAnimation(stage: HTMLElement | null, canvas: HTMLElement | null) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!stage || !canvas) return;
  if (pinboardViewAnimationTimer !== undefined) window.clearTimeout(pinboardViewAnimationTimer);
  stage.classList.add("viewport-animating");
  canvas.classList.add("viewport-animating");
  canvas.getBoundingClientRect();
  pinboardViewAnimationTimer = window.setTimeout(() => {
    stage.classList.remove("viewport-animating");
    canvas.classList.remove("viewport-animating");
    pinboardViewAnimationTimer = undefined;
  }, PINBOARD_VIEW_ANIMATION_MS + 80);
}

function schedulePinboardViewportPublish() {
  if (!pinboardActorPresent() || state.tab !== "pinboard" || !canSendDirect()) return;
  if (pinboardViewportTimer !== undefined) return;
  const wait = Math.max(0, PINBOARD_VIEWPORT_MIN_MS - (Date.now() - lastPinboardViewportPublishAt));
  pinboardViewportTimer = window.setTimeout(() => {
    pinboardViewportTimer = undefined;
    publishPinboardViewport();
  }, wait);
}

function publishPinboardViewport() {
  if (!pinboardActorPresent() || state.tab !== "pinboard" || !canSendDirect()) return;
  const viewport = currentPinboardViewport();
  if (!viewport || !pinboardViewportChanged(viewport, lastPinboardViewportSent)) return;
  lastPinboardViewportSent = viewport;
  lastPinboardViewportPublishAt = Date.now();
  const board = pinboardSpace();
  if (board) direct(board, "viewport", [viewport.x, viewport.y, viewport.w, viewport.h, viewport.scale]);
}

function currentPinboardViewport(): (PinNoteBox & { scale: number }) | undefined {
  const stage = document.querySelector<HTMLElement>("[data-pinboard-stage]");
  if (!stage) return undefined;
  const rect = stage.getBoundingClientRect();
  const view = normalizedPinboardView();
  if (rect.width <= 0 || rect.height <= 0 || view.scale <= 0) return undefined;
  return {
    x: (0 - view.x) / view.scale,
    y: (0 - view.y) / view.scale,
    w: rect.width / view.scale,
    h: rect.height / view.scale,
    scale: view.scale
  };
}

function pinboardViewportChanged(next: PinNoteBox & { scale: number }, prev: (PinNoteBox & { scale: number }) | undefined) {
  if (!prev) return true;
  return (
    Math.abs(next.x - prev.x) > 0.5 ||
    Math.abs(next.y - prev.y) > 0.5 ||
    Math.abs(next.w - prev.w) > 0.5 ||
    Math.abs(next.h - prev.h) > 0.5 ||
    Math.abs(next.scale - prev.scale) > 0.005
  );
}

function pinboardActorPresent() {
  const board = pinboardSpace();
  const currentLocation = scopedProjectionEnabled ? state.scopedProjection?.session?.current_location : state.world?.session?.current_location;
  return Boolean(state.actor && board && currentLocation === board);
}

function panPinboardBy(dx: number, dy: number) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  state.pinboardView = {
    ...state.pinboardView,
    x: state.pinboardView.x + dx,
    y: state.pinboardView.y + dy
  };
  applyPinboardView();
}

function centerPinboardOn(boardX: number, boardY: number) {
  if (!Number.isFinite(boardX) || !Number.isFinite(boardY)) return;
  const stage = document.querySelector<HTMLElement>("[data-pinboard-stage]");
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  const view = normalizedPinboardView();
  state.pinboardView = {
    ...view,
    x: rect.width / 2 - boardX * view.scale,
    y: rect.height / 2 - boardY * view.scale
  };
  applyPinboardView({ animate: true });
}

function zoomPinboardAtStageCenter(factor: number, animate = false) {
  const stage = document.querySelector<HTMLElement>("[data-pinboard-stage]");
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  zoomPinboardAtClient(factor, rect.left + rect.width / 2, rect.top + rect.height / 2, animate);
}

function zoomPinboardAtClient(factor: number, clientX: number, clientY: number, animate = false) {
  if (!Number.isFinite(factor) || factor <= 0) return;
  const stage = document.querySelector<HTMLElement>("[data-pinboard-stage]");
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  const pointX = clientX - rect.left;
  const pointY = clientY - rect.top;
  const view = normalizedPinboardView();
  const nextScale = clamp(view.scale * factor, PINBOARD_MIN_ZOOM, PINBOARD_MAX_ZOOM);
  if (nextScale === view.scale) return;
  const boardX = (pointX - view.x) / view.scale;
  const boardY = (pointY - view.y) / view.scale;
  state.pinboardView = {
    scale: nextScale,
    x: pointX - boardX * nextScale,
    y: pointY - boardY * nextScale
  };
  applyPinboardView({ animate });
}

function roundCss(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function mod(value: number, divisor: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor === 0) return 0;
  return ((value % divisor) + divisor) % divisor;
}

function bindPinNoteDrag(handle: HTMLButtonElement) {
  const note = handle.closest<HTMLElement>("[data-pin-note]");
  if (!note) return;
  let active = false;
  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;
  handle.addEventListener("pointerdown", (event) => {
    active = true;
    startX = event.clientX;
    startY = event.clientY;
    baseX = pinNoteNumber(note.dataset.x, 0);
    baseY = pinNoteNumber(note.dataset.y, 0);
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (!active) return;
    const scale = normalizedPinboardView().scale;
    const x = Math.round(baseX + (event.clientX - startX) / scale);
    const y = Math.round(baseY + (event.clientY - startY) / scale);
    note.dataset.x = String(x);
    note.dataset.y = String(y);
    note.style.left = `${x}px`;
    note.style.top = `${y}px`;
  });
  handle.addEventListener("pointerup", () => {
    if (!active) return;
    active = false;
    const id = note.dataset.pinNote ?? "";
    const x = pinNoteNumber(note.dataset.x, 0);
    const y = pinNoteNumber(note.dataset.y, 0);
    pinboardCall("move_pin", [id, x, y], pinboardPlacementOptimistic(id, { x, y }));
  });
  handle.addEventListener("pointercancel", () => {
    active = false;
  });
}

function bindPinNoteResize(handle: HTMLButtonElement) {
  const note = handle.closest<HTMLElement>("[data-pin-note]");
  if (!note) return;
  let active = false;
  let startX = 0;
  let startY = 0;
  let baseW = 0;
  let baseH = 0;
  handle.addEventListener("pointerdown", (event) => {
    active = true;
    startX = event.clientX;
    startY = event.clientY;
    baseW = pinNoteNumber(note.dataset.w, 180);
    baseH = pinNoteNumber(note.dataset.h, 110);
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (!active) return;
    const scale = normalizedPinboardView().scale;
    const w = clamp(Math.round(baseW + (event.clientX - startX) / scale), 100, 420);
    const h = clamp(Math.round(baseH + (event.clientY - startY) / scale), 72, 320);
    note.dataset.w = String(w);
    note.dataset.h = String(h);
    note.style.width = `${w}px`;
    note.style.height = `${h}px`;
  });
  handle.addEventListener("pointerup", () => {
    if (!active) return;
    active = false;
    const id = note.dataset.pinNote ?? "";
    const w = pinNoteNumber(note.dataset.w, 180);
    const h = pinNoteNumber(note.dataset.h, 110);
    pinboardCall("resize_pin", [id, w, h], pinboardPlacementOptimistic(id, { w, h }));
  });
  handle.addEventListener("pointercancel", () => {
    active = false;
  });
}

function enterPinboard() {
  const board = pinboardSpace();
  if (!board || !canSendDirect()) return;
  direct(board, "enter", [], (result) => {
    applyScopedMoveResult(result);
    setPinboardPresent(result);
    void ensureScopedOverlayForTab("pinboard", { force: true }).then(() => {
      if (state.tab === "pinboard") render();
    });
    refreshPinboardNotes({ force: true });
    requestSpaceChatFocus(board);
  });
}

function leavePinboard(done?: () => void) {
  const board = pinboardSpace();
  if (!board || !canSendDirect()) {
    done?.();
    return;
  }
  if (!pinboardActorPresent()) {
    done?.();
    return;
  }
  direct(board, "leave", [], (result) => {
    applyScopedMoveResult(result);
    setPinboardPresent(result);
    clearPinboardViewports();
    done?.();
    // Legacy mode still needs a projection refresh after feature-space leave;
    // scoped mode consumes the move-shaped `here` result above.
    if (!scopedProjectionEnabled) void refresh();
    void ensureScopedOverlayForTab("pinboard", { force: true });
    if (state.tab === "pinboard") render();
  });
}

function setPinboardPresent(result: any) {
  const present = Array.isArray(result)
    ? result
    : Array.isArray(result?.present)
      ? result.present
      : Array.isArray(result?.present_actors)
        ? result.present_actors
        : [];
  const presentIds = idsFromRefsOrSummaries(present);
  const boardId = pinboardSpace();
  if (boardId) ui.applyCanonical([{ subject: boardId, props: { subscribers: presentIds } }]);
  const presentActors = new Set(presentIds);
  for (const actor of Object.keys(state.pinboardViewports)) {
    if (!presentActors.has(actor)) removePinboardViewport(actor);
  }
  if (scopedProjectionEnabled) return;
  // Compatibility write for the legacy `/api/state` pinboard branch. The
  // projection write above is the scoped-model update.
  if (!state.world?.pinboard) return;
  state.world.pinboard.present = presentIds;
  const board = state.world.pinboard.board;
  if (board?.props) board.props.subscribers = state.world.pinboard.present;
}

function pinboardCall(verb: string, args: any[] = [], options?: ProjectionCallOptions) {
  const board = pinboardSpace();
  if (board) call(board, board, verb, args, options);
}

function pinboardTargetCall(target: string, verb: string, args: any[] = [], options?: ProjectionCallOptions) {
  const board = pinboardSpace();
  if (board && target) call(board, target, verb, args, options);
}

function refreshPinboardNotes(options: { force?: boolean } = {}) {
  const board = pinboardSpace();
  if (!board || !canSendDirect()) return;
  if (pinboardNotesRefreshPending && options.force !== true) return;
  pinboardNotesRefreshPending = true;
  window.setTimeout(() => {
    pinboardNotesRefreshPending = false;
  }, 2500);
  direct(board, "list_notes", [], (result) => {
    pinboardNotesRefreshPending = false;
    if (!Array.isArray(result)) return;
    applyPinboardNotesCanonical(board, result);
    if (state.tab === "pinboard") render();
  }, () => {
    pinboardNotesRefreshPending = false;
    // Allow the next /api/state arrival to retry hydration if a transient
    // failure (cold remote DO, network blip) ate this list_notes call.
    pinboardTextHydrationRequested = false;
  });
}

function applyPinboardNotesCanonical(board: string, result: any[]) {
  const previous = pinboardModel()?.notes ?? (!scopedProjectionEnabled ? state.world?.pinboard?.notes : []) ?? [];
  const notes = normalizePinboardNotes(result, previous);
  const nextIds = new Set<string>();
  const previousIds = new Set((Array.isArray(previous) ? previous : []).map((note: any) => String(note?.id ?? "")).filter(Boolean));
  const layout: Record<string, any> = {};
  const notePatches: ProjectionPatch[] = [];
  for (const note of notes) {
    const id = String(note?.id ?? "");
    if (!id) continue;
    nextIds.add(id);
    layout[id] = {
      x: pinNoteNumber(note?.x, 48),
      y: pinNoteNumber(note?.y, 48),
      w: pinNoteNumber(note?.w, 180),
      h: pinNoteNumber(note?.h, 110),
      z: pinNoteNumber(note?.z, 1)
    };
    notePatches.push({
      subject: id,
      fields: {
        name: typeof note?.name === "string" ? note.name : undefined,
        owner: typeof note?.owner === "string" ? note.owner : typeof note?.author === "string" ? note.author : undefined
      },
      catalogState: { pinboard_note: pinboardNoteState(note) }
    });
  }
  for (const id of previousIds) {
    if (!nextIds.has(id)) notePatches.push({ subject: id, clearCatalogState: ["pinboard_note"] });
  }
  ui.applyCanonical([{ subject: board, props: { layout } }]);
  ui.applyCanonical(notePatches, { mode: "replace" });
  if (!scopedProjectionEnabled && state.world?.pinboard) state.world.pinboard.notes = notes;
}

function pinboardNoteState(note: any): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of ["x", "y", "z", "w", "h", "text", "color", "author", "owner", "writers", "created_at", "updated_at", "updated_by"]) {
    if (note?.[key] !== undefined) fields[key] = note[key];
  }
  return fields;
}

function pinNoteNumber(value: any, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function pinboardPalette(palette: any): string[] {
  const items = Array.isArray(palette) ? palette.map(String).filter(Boolean) : [];
  return items.length > 0 ? items : ["yellow", "blue", "green", "pink", "white"];
}

function renderIde() {
  if (scopedProjectionEnabled) return renderScopedIde();
  const objects = Object.keys(state.world?.objects ?? {}).sort();
  const installTarget = state.selectedObject || defaultSelectedObject();
  const scopedSmoke = scopedProjectionSmokeEnabled
    ? `<div class="panel"><h2>Scoped projection smoke</h2><pre>${escapeHtml(JSON.stringify(state.scopedProjectionSmoke ?? {}, null, 2))}</pre></div>`
    : "";
  return `
    <section class="toolbar">
      <h1>IDE</h1>
      <select data-object-select>${objects.map((id) => `<option value="${escapeHtml(id)}" ${id === state.selectedObject ? "selected" : ""}>${escapeHtml(id)}</option>`).join("")}</select>
      <button data-refresh-object>Inspect</button>
    </section>
    <section class="split">
      <div class="panel"><pre>${escapeHtml(JSON.stringify(state.world?.objects?.[state.selectedObject] ?? {}, null, 2))}</pre></div>
      <div class="panel editor">
        <input data-verb-name value="set_feedback" />
        <textarea data-source>${escapeHtml(defaultSource())}</textarea>
        <div class="button-row">
          <button data-compile>Compile</button>
          <button data-install>Install on ${escapeHtml(installTarget)}</button>
          <button data-test-verb>Test</button>
        </div>
        <pre>${escapeHtml(JSON.stringify(state.compileResult ?? {}, null, 2))}</pre>
      </div>
    </section>
    ${scopedSmoke}
  `;
}

function renderScopedIde() {
  const object = state.selectedObject || defaultSelectedObject();
  const summary = scopedObjectSummary(object);
  const scopedSmoke = scopedProjectionSmokeEnabled
    ? `<div class="panel"><h2>Scoped projection smoke</h2><pre>${escapeHtml(JSON.stringify(state.scopedProjectionSmoke ?? {}, null, 2))}</pre></div>`
    : "";
  return `
    <section class="toolbar">
      <h1>Inspector</h1>
      <input data-scoped-object-ref value="${escapeHtml(object)}" />
      <button data-scoped-object-inspect>Inspect</button>
    </section>
    <section class="split">
      <div class="panel"><pre>${escapeHtml(JSON.stringify(summary ?? { id: object, loading: Boolean(object) }, null, 2))}</pre></div>
    </section>
    ${scopedSmoke}
  `;
}

function bindIde() {
  if (scopedProjectionEnabled) {
    const inspect = () => {
      const input = document.querySelector<HTMLInputElement>("[data-scoped-object-ref]");
      const id = input?.value.trim() ?? "";
      if (id) setSelectedObject(id);
    };
    document.querySelector<HTMLButtonElement>("[data-scoped-object-inspect]")?.addEventListener("click", inspect);
    document.querySelector<HTMLInputElement>("[data-scoped-object-ref]")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") inspect();
    });
    return;
  }
  document.querySelector<HTMLSelectElement>("[data-object-select]")?.addEventListener("change", (event) => {
    setSelectedObject((event.target as HTMLSelectElement).value);
  });
  document.querySelector<HTMLButtonElement>("[data-compile]")?.addEventListener("click", async () => {
    const source = document.querySelector<HTMLTextAreaElement>("[data-source]")!.value;
    const response = await fetch("/api/compile", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ source }) });
    state.compileResult = await response.json();
    render();
  });
  document.querySelector<HTMLButtonElement>("[data-install]")?.addEventListener("click", async () => {
    const source = document.querySelector<HTMLTextAreaElement>("[data-source]")!.value;
    const name = document.querySelector<HTMLInputElement>("[data-verb-name]")!.value.trim();
    const object = state.selectedObject;
    const info = await fetch(`/api/object?id=${encodeURIComponent(object)}`, { headers: authHeaders() }).then((response) => response.json());
    const current = info.verbs?.find((verb: any) => verb.name === name);
    const response = await fetch("/api/install", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ object, name, source, expected_version: current?.version ?? null })
    });
    state.compileResult = await response.json();
    await refresh();
  });
  document.querySelector<HTMLButtonElement>("[data-test-verb]")?.addEventListener("click", () => {
    const name = document.querySelector<HTMLInputElement>("[data-verb-name]")!.value.trim();
    const space = dubspaceSpace();
    if (space) call(space, state.selectedObject, name, [0.62]);
  });
}

function defaultSource() {
  return `verb :set_feedback(value) rx {
  this.feedback = value;
  observe({
    "type": "control_changed",
    "target": this,
    "name": "feedback",
    "value": value,
    "actor": actor,
    "seq": seq
  });
  return value;
}`;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function defaultLoopFreq(index: number) {
  return frequencyForSemitone(LOOP_DEFAULT_SEMITONES[index - 1] ?? 12);
}

function frequencyForSemitone(rawSemitone: number) {
  const semitone = clamp(Math.round(rawSemitone), PITCH_MIN_SEMITONE, PITCH_MAX_SEMITONE);
  return Number((PITCH_ROOT_FREQ * Math.pow(2, semitone / 12)).toFixed(2));
}

function semitoneForFrequency(rawFreq: number) {
  const minFreq = frequencyForSemitone(PITCH_MIN_SEMITONE);
  const maxFreq = frequencyForSemitone(PITCH_MAX_SEMITONE);
  const freq = clamp(rawFreq, minFreq, maxFreq);
  return clamp(Math.round(12 * Math.log2(freq / PITCH_ROOT_FREQ)), PITCH_MIN_SEMITONE, PITCH_MAX_SEMITONE);
}

function pitchForSemitone(rawSemitone: number) {
  const semitone = clamp(Math.round(rawSemitone), PITCH_MIN_SEMITONE, PITCH_MAX_SEMITONE);
  const freq = frequencyForSemitone(semitone);
  const midi = PITCH_ROOT_MIDI + semitone;
  const note = `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
  const angle = -135 + ((semitone - PITCH_MIN_SEMITONE) / (PITCH_MAX_SEMITONE - PITCH_MIN_SEMITONE)) * 270;
  return { semitone, freq, note, angle: Math.round(angle) };
}

function loopPitch(rawFreq: number) {
  return pitchForSemitone(semitoneForFrequency(rawFreq));
}

function toneTrackFreq(step: number) {
  return frequencyForSemitone(TONE_TRACK_SEMITONES[step % TONE_TRACK_SEMITONES.length] ?? 24);
}

function makeSilentLoopElement(): HTMLAudioElement {
  // 1-sample silent 8 kHz mono 8-bit WAV, looped.
  const samples = 1;
  const buf = new ArrayBuffer(44 + samples);
  const view = new DataView(buf);
  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);    // PCM
  view.setUint16(22, 1, true);    // mono
  view.setUint32(24, 8000, true); // sample rate
  view.setUint32(28, 8000, true); // byte rate (sampleRate * blockAlign)
  view.setUint16(32, 1, true);    // block align
  view.setUint16(34, 8, true);    // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, samples, true);
  view.setUint8(44, 0x80);        // 8-bit unsigned silence center
  const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  const audio = new Audio(url);
  audio.setAttribute("playsinline", "");
  audio.loop = true;
  audio.volume = 0;
  return audio;
}

class DubAudio {
  private context = new AudioContext();
  private gains = new Map<string, GainNode>();
  private oscillators = new Map<string, OscillatorNode>();
  private input = this.context.createGain();
  private filter = this.context.createBiquadFilter();
  private channel = this.context.createGain();
  private dry = this.context.createGain();
  private send = this.context.createGain();
  private delay = this.context.createDelay(1.5);
  private feedback = this.context.createGain();
  private wet = this.context.createGain();
  private dubspace: any;
  private clockOffset = 0;
  private sequencer?: number;
  private lastStep = -1;
  private lastStartedAt = 0;
  private silentLoop?: HTMLAudioElement;

  constructor() {
    this.filter.type = "lowpass";
    this.input.connect(this.filter).connect(this.channel);
    this.channel.connect(this.dry).connect(this.context.destination);
    this.channel.connect(this.send).connect(this.delay);
    this.delay.connect(this.feedback).connect(this.delay);
    this.delay.connect(this.wet).connect(this.context.destination);
    this.dry.gain.value = 1;
    this.send.gain.value = 0.3;
    this.delay.delayTime.value = 0.25;
    this.feedback.gain.value = 0.35;
    this.wet.gain.value = 0.4;
  }

  async start() {
    // iOS routes Web Audio through the ringer channel (silent switch
    // mutes it) until an <audio> element is playing inline. Looping a
    // tiny silent WAV switches Safari to the media channel.
    if (!this.silentLoop) this.silentLoop = makeSilentLoopElement();
    try { await this.silentLoop.play(); } catch { /* gesture missing or blocked; AudioContext.resume below still tries */ }
    await this.context.resume();
    this.ensureSequencer();
  }

  async stop() {
    for (const osc of this.oscillators.values()) osc.stop();
    this.oscillators.clear();
    this.gains.clear();
    this.silentLoop?.pause();
    await this.context.suspend();
  }

  sync(dubspace: any, clockOffset = 0) {
    if (!dubspace) return;
    this.dubspace = dubspace;
    this.clockOffset = clockOffset;
    this.syncEffects(dubspace);
    const slots = Array.isArray(dubspaceMeta().slots) ? dubspaceMeta().slots : [];
    for (const [index, id] of slots.entries()) {
      const props = dubspace[id]?.props ?? {};
      const freq = loopPitch(Number(props.freq ?? defaultLoopFreq(index + 1))).freq;
      if (props.playing && !this.oscillators.has(id)) {
        const osc = this.context.createOscillator();
        const gain = this.context.createGain();
        osc.frequency.value = freq;
        osc.type = "sawtooth";
        gain.gain.value = (props.gain ?? 0.5) * 0.08;
        osc.connect(gain).connect(this.input);
        osc.start();
        this.oscillators.set(id, osc);
        this.gains.set(id, gain);
      }
      if (!props.playing && this.oscillators.has(id)) {
        this.oscillators.get(id)!.stop();
        this.oscillators.delete(id);
        this.gains.delete(id);
      }
      this.oscillators.get(id)?.frequency.setTargetAtTime(freq, this.context.currentTime, 0.02);
      this.gains.get(id)?.gain.setTargetAtTime((props.gain ?? 0.5) * 0.08, this.context.currentTime, 0.02);
    }
    this.ensureSequencer();
  }

  private syncEffects(dubspace: any) {
    const now = this.context.currentTime;
    const meta = dubspaceMeta();
    const delay = dubspace[meta.delay]?.props ?? {};
    const filter = dubspace[meta.filter]?.props ?? {};
    const channel = dubspace[meta.channel]?.props ?? {};
    this.filter.frequency.setTargetAtTime(clamp(Number(filter.cutoff ?? 5000), 80, 5000), now, 0.02);
    this.filter.Q.setTargetAtTime(0.8, now, 0.02);
    this.channel.gain.setTargetAtTime(clamp(Number(channel.gain ?? 0.8), 0, 1.2), now, 0.02);
    this.send.gain.setTargetAtTime(clamp(Number(delay.send ?? 0.3), 0, 1), now, 0.02);
    this.delay.delayTime.setTargetAtTime(clamp(Number(delay.time ?? 0.25), 0.03, 1.2), now, 0.02);
    this.feedback.gain.setTargetAtTime(clamp(Number(delay.feedback ?? 0.35), 0, 0.88), now, 0.02);
    this.wet.gain.setTargetAtTime(clamp(Number(delay.wet ?? 0.4), 0, 0.9), now, 0.02);
  }

  private ensureSequencer() {
    if (this.sequencer) return;
    this.sequencer = window.setInterval(() => this.tickSequencer(), 25);
  }

  private tickSequencer() {
    if (this.context.state !== "running") return;
    const drum = this.dubspace?.[dubspaceMeta().drum]?.props;
    if (!drum?.playing) {
      this.lastStep = -1;
      return;
    }
    const bpm = Number(drum.bpm ?? 118);
    const startedAt = Number(drum.started_at ?? 0);
    if (!startedAt) return;
    if (startedAt !== this.lastStartedAt) {
      this.lastStartedAt = startedAt;
      this.lastStep = -1;
    }
    const stepMs = 30000 / bpm;
    const elapsed = Math.max(0, Date.now() + this.clockOffset - startedAt);
    const step = Math.floor(elapsed / stepMs) % 8;
    if (step === this.lastStep) return;
    this.lastStep = step;
    const pattern = normalizePattern(drum.pattern);
    for (const voice of drumVoices) {
      if (pattern[voice.id][step]) this.triggerVoice(voice.id, step);
    }
  }

  private triggerVoice(voice: string, step: number) {
    if (voice === "kick") this.kick();
    if (voice === "snare") this.noiseHit(0.18, 900, 0.08);
    if (voice === "hat") this.noiseHit(0.05, 7000, 0.22);
    if (voice === "tone") this.tone(toneTrackFreq(step));
  }

  private kick() {
    const t = this.context.currentTime;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(115, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.16);
    gain.gain.setValueAtTime(0.22, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(this.input);
    osc.start(t);
    osc.stop(t + 0.19);
  }

  private noiseHit(duration: number, cutoff: number, level: number) {
    const t = this.context.currentTime;
    const samples = Math.floor(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, samples, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < samples; i++) data[i] = Math.random() * 2 - 1;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    source.buffer = buffer;
    filter.type = "highpass";
    filter.frequency.value = cutoff;
    gain.gain.setValueAtTime(level, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    source.connect(filter).connect(gain).connect(this.input);
    source.start(t);
  }

  private tone(freq: number) {
    const t = this.context.currentTime;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.06, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(gain).connect(this.input);
    osc.start(t);
    osc.stop(t + 0.13);
  }
}
