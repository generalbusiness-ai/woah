import "./styles.css";
import chatManifest from "../../catalogs/chat/manifest.json";
import demoworldManifest from "../../catalogs/demoworld/manifest.json";
import dispenserManifest from "../../catalogs/dispenser/manifest.json";
import dubspaceManifest from "../../catalogs/dubspace/manifest.json";
import noteManifest from "../../catalogs/note/manifest.json";
import outlinerManifest from "../../catalogs/outliner/manifest.json";
import pinboardManifest from "../../catalogs/pinboard/manifest.json";
import tasksManifest from "../../catalogs/tasks/manifest.json";
import weatherManifest from "../../catalogs/weather/manifest.json";
import * as chatUiModule from "../../catalogs/chat/ui/chat-space";
import * as demoworldUiModule from "../../catalogs/demoworld/ui/demoworld-chat";
import * as dispenserUiModule from "../../catalogs/dispenser/ui/dispenser-chat";
import * as dubspaceUiModule from "../../catalogs/dubspace/ui/dubspace-workspace";
import * as noteUiModule from "../../catalogs/note/ui/note-chat";
import * as outlinerUiModule from "../../catalogs/outliner/ui/outliner-tree";
import * as pinboardUiModule from "../../catalogs/pinboard/ui/pinboard-board";
import * as tasksUiModule from "../../catalogs/tasks/ui/kanban-board";
import * as weatherUiModule from "../../catalogs/weather/ui/weather-badge";
import { appliedFrameErrorObservations, chatErrorText } from "./chat-errors";
import { chatObservationSpace, updateEnteredLeftChatPresence } from "./chat-state";
import { CoalescedViewHydrator, createWooClientFramework, escapeHtml, liveProjectionKey, ProjectionFieldFiller, type CatalogUiPackage, type ProjectionCallOptions, type ProjectionPatch, type WooContext, type WooElement } from "./framework";
import { isPinboardObservation } from "./pinboard-observation";
import { clearProvisionalChatLines, provisionalChatErrorLine, upsertProvisionalChatLine } from "./provisional-chat";
import { advanceProjectionCursor, idsFromRefsOrSummaries, presentActorsFromObservation, scopedHerePresentActors, scopedModelWithMoveResult, type ScopedProjectionStateModel } from "./scoped-projection";
import { settleInvalidatedOptimisticTurns, type V2LocalTurnInvalidatedMessage } from "./v2-browser-optimistic-lifecycle";
import { v2ProjectionSnapshotFromMessage, v2TurnResultRoute, type V2AppliedFrameMessage, type V2ProjectionMessage, type V2TurnResultMessage } from "./v2-browser-messages";
import { sessionActiveScopeFromRecord } from "../core/types";
import type { ChatLine, ChatSpaceData, ChatTitleBadge, SpaceChatPanelData } from "../../catalogs/chat/ui/chat-space";
import type { DubspaceData } from "../../catalogs/dubspace/ui/dubspace-workspace";
import type { PinboardData } from "../../catalogs/pinboard/ui/pinboard-board";

type AuthStatus = "checking" | "anonymous" | "authenticated";
type AuthMethod = "guest" | "apikey";
type ToolTab = "dubspace" | "pinboard" | "tasks" | "outliner";
type AppTab = "chat" | ToolTab | "tool" | "ide";

type BrowserActivityMetricPayload = {
  kind: "browser_activity";
  source: "v2_browser_worker" | "main";
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
  pending?: number;
  bytes?: number;
  records?: number;
  transfer_mode?: string;
  executable_transfer_cache?: "hit" | "miss";
  error?: string;
  error_detail?: string;
};

class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

type AppState = {
  actor?: string;
  session?: string;
  authStatus: AuthStatus;
  loginError?: string;
  loginPending?: boolean;
  tab: AppTab;
  scopedProjection?: ScopedProjectionStateModel;
  v2Projection?: V2ProjectionMessage;
  scopedObjectSummaries: Record<string, any>;
  routedSubjects: Partial<Record<ToolTab, string>>;
  genericToolSubject: string;
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
  spaceChatCollapsed: boolean;
  observations: any[];
  observationsCollapsed: boolean;
  selectedObject: string;
  scopedProjectionSmoke?: { me?: any; catalogs?: any; error?: string };
  pinboardNewText: string;
  pinboardNewColor: string;
  pinboardView: PinboardView;
  pinboardViewports: Record<string, PinboardViewportPresence>;
};

type ChatRoomPin = {
  room: string;
  expiresAt: number;
};

type RouteLocation = {
  objectId: string;
  view?: string;
};

type ToolTabDefinition = {
  tab: ToolTab;
  label: string;
  viewAliases: string[];
  catalogAlias: string;
  frameComponent: string;
  seedCatalogAlias: string;
  classRef: string;
  emptyTitle: string;
  emptyMessage: string;
  elementSelector: string;
  elementTagAttrs: (subject: string) => string;
  mount: () => void;
  enter?: () => void;
  leave?: (done?: () => void) => void;
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
  tab: AppTab;
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
  genericToolSubject: "",
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
  spaceChatCollapsed: false,
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
// Demo tool seeds live in demoworld's manifest now (the
// demoworld-dependency-inversion). Read from demoworld so the SPA can route
// to them on first load. Tasks still self-seeds its board with no location
// coupling, so it reads from its own manifest.
const bundledToolSeeds = {
  dubspace: bundledSeedRef(demoworldManifest, "$dubspace"),
  pinboard: bundledSeedRef(demoworldManifest, "$pinboard"),
  outliner: bundledSeedRef(demoworldManifest, "$outliner"),
  tasks: bundledSeedRef(tasksManifest, "$task_registry")
} as const;
const TOOL_TAB_DEFINITIONS: ToolTabDefinition[] = [
  {
    tab: "dubspace",
    label: "Dubspace",
    viewAliases: ["dubspace"],
    catalogAlias: "dubspace",
    frameComponent: "dubspace.workspace",
    seedCatalogAlias: "dubspace",
    classRef: "$dubspace",
    emptyTitle: "Dubspace",
    emptyMessage: "No dubspace UI is registered for this space.",
    elementSelector: "[data-dubspace-workspace]",
    elementTagAttrs: (subject) => `data-dubspace-workspace data-dubspace-space="${escapeHtml(subject)}"`,
    mount: () => bindDubspace(),
    enter: () => enterDubspace(),
    leave: (done) => leaveDubspace(done)
  },
  {
    tab: "pinboard",
    label: "Pinboard",
    viewAliases: ["pinboard"],
    catalogAlias: "pinboard",
    frameComponent: "pinboard.board",
    seedCatalogAlias: "pinboard",
    classRef: "$pinboard",
    emptyTitle: "Pinboard",
    emptyMessage: "No pinboard UI is registered for this board.",
    elementSelector: "[data-pinboard-board]",
    elementTagAttrs: (subject) => `data-pinboard-board data-pinboard-space="${escapeHtml(subject)}"`,
    mount: () => bindPinboard(),
    enter: () => enterPinboard(),
    leave: (done) => leavePinboard(done)
  },
  {
    tab: "tasks",
    label: "Tasks",
    viewAliases: ["tasks", "kanban"],
    catalogAlias: "tasks",
    frameComponent: "tasks.kanban",
    seedCatalogAlias: "tasks",
    classRef: "$task_registry",
    emptyTitle: "Tasks",
    emptyMessage: "No tasks UI is registered for this registry.",
    elementSelector: "[data-tasks-board]",
    elementTagAttrs: (subject) => `data-tasks-board data-tasks-registry="${escapeHtml(subject)}"`,
    mount: () => bindTasks(),
    enter: () => enterTasks(),
    leave: (done) => leaveTasks(done)
  },
  {
    tab: "outliner",
    label: "Outliner",
    viewAliases: ["outliner", "outline"],
    catalogAlias: "outliner",
    frameComponent: "outliner.tree",
    seedCatalogAlias: "demoworld",
    classRef: "$outliner",
    emptyTitle: "Outliner",
    emptyMessage: "No outliner UI is registered.",
    elementSelector: "[data-outliner-tree]",
    elementTagAttrs: (subject) => `data-outliner-tree data-outliner-subject="${escapeHtml(subject)}"`,
    mount: () => bindOutliner(),
    enter: () => enterOutliner(),
    leave: (done) => leaveOutliner(done)
  }
];
const TOOL_TABS = TOOL_TAB_DEFINITIONS.map((definition) => definition.tab);
const bundledCatalogManifests: Record<string, any> = {
  dubspace: dubspaceManifest,
  pinboard: pinboardManifest,
  outliner: outlinerManifest,
  tasks: tasksManifest,
  demoworld: demoworldManifest
};
const sessionKey = "woo.session";
const usernameKey = "woo.username";
const authMethodKey = "woo.authMethod";
const chatHistoryKey = "woo.chat.history";
const pinboardNewColorKey = "woo.pinboard.newColor";
const legacyPinboardChatHeightKey = "woo.pinboard.chatHeight";
const spaceChatHeightsKey = "woo.spaceChat.heights";
const spaceChatCollapsedKey = "woo.spaceChat.collapsed";
const scopedProjectionSmokeEnabled = new URLSearchParams(location.search).has("scopedProjectionSmoke");
const v2TestHooksEnabled = new URLSearchParams(location.search).has("v2TestHooks");
const chatHistoryLimit = 80;
const chatFeedLimit = 160;
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
const pendingFrameErrors = new Map<string, (error: unknown) => void>();
const pendingCommands = new Map<string, { space: string; text: string; action?: ChatCommandUiAction }>();
const pendingNetworkTurns = new Set<string>();
const pendingToolEnters = new Set<string>();
const pendingToolEnterTimers = new Map<string, number>();
const pendingOverlaySnapshots = new Map<string, Promise<void>>();
let scopedProjectionLocalRevision = 0;
let connectInFlight: Promise<void> | null = null;
const reconnectBaseDelayMs = 500;
const reconnectMaxDelayMs = 5000;
const observationDisplayLimit = 20;
const PINBOARD_MIN_ZOOM = 0.35;
const PINBOARD_MAX_ZOOM = 2.75;
const PINBOARD_ZOOM_STEP = 1.2;
const PINBOARD_GRID_SIZE = 24;
const PINBOARD_VIEW_ANIMATION_MS = 480;
const PINBOARD_VIEWPORT_MIN_MS = 110;
const PINBOARD_MAP_DEFAULT_ASPECT = 0.42;
const SPACE_CHAT_DEFAULT_HEIGHT = 280;
// Keep the expanded mini-chat tall enough for a visible transcript; collapse
// has its own compact CSS state.
const SPACE_CHAT_MIN_HEIGHT = 176;
const SPACE_CHAT_MAX_VIEWPORT_RATIO = 0.45;
const TAB_FROM_VIEW: Record<string, AppTab> = {
  chat: "chat",
  tool: "tool",
  ide: "ide",
  editor: "ide",
  ...Object.fromEntries(TOOL_TAB_DEFINITIONS.flatMap((definition) => definition.viewAliases.map((view) => [view, definition.tab])))
};

function toolDefinition(tab: AppTab): ToolTabDefinition | undefined {
  return TOOL_TAB_DEFINITIONS.find((definition) => definition.tab === tab);
}

function isToolTab(tab: AppTab): tab is ToolTab {
  return (TOOL_TABS as AppTab[]).includes(tab);
}
let reconnectDelayMs = reconnectBaseDelayMs;
let reconnectTimer: number | undefined;
let pinboardViewportTimer: number | undefined;
let pinboardViewAnimationTimer: number | undefined;
let lastPinboardViewportPublishAt = 0;
let lastPinboardViewportSent: PinNoteBox & { scale: number } | undefined;
const pinNoteClientZ = new Map<string, number>();
const PINBOARD_OPTIMISTIC_TTL_MS = 5_000;
const TOOL_ENTER_PENDING_TIMEOUT_MS = 8_000;
let focusTasksChatOnEntry = false;
let catalogUiEtag = "";
let catalogUiCache: any;
const installedCatalogUiAliases = new Set<string>();
let chatHistory = loadChatHistory();
let chatHistoryCursor = chatHistory.length;
let chatHistoryDraft = "";
let startupRoute: RouteLocation | null = parseLocationRoute(location.pathname, location.search);
let routeInitialized = false;
let v2BrowserWorker: Worker | undefined;
let v2BrowserWorkerScope = "";
const browserMetricQueue: BrowserActivityMetricPayload[] = [];
const browserMetricBatchLimit = 50;
const browserMetricQueueLimit = browserMetricBatchLimit * 4;
const browserMetricFlushDelayMs = 1000;
const browserMetricMinFlushIntervalMs = 1000;
let browserMetricFlushTimer: number | undefined;
let browserMetricFlushInFlight = false;
let browserMetricLastFlushAt = 0;
let pendingNetworkRequests = 0;
let networkWaitTimer: number | undefined;
state.spaceChatHeights = loadSpaceChatHeights();
const persistedSpaceChatCollapsed = readStorage(spaceChatCollapsedKey);
state.spaceChatCollapsed = persistedSpaceChatCollapsed === "1" || persistedSpaceChatCollapsed === "true";

installBundledCatalogUi();
window.setInterval(pruneLiveControls, 700);
window.addEventListener("resize", () => {
  normalizeSpaceChatHeights();
  schedulePinboardViewportPublish();
  window.requestAnimationFrame(updatePinboardMapViewports);
});
window.addEventListener("popstate", () => {
  void applyLocationRoute("replace");
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushBrowserMetrics({ keepalive: true });
});

function beginNetworkWait() {
  pendingNetworkRequests += 1;
  if (pendingNetworkRequests !== 1) return;
  // Delay the cursor so fast local requests don't flash the whole document.
  networkWaitTimer = window.setTimeout(() => {
    if (pendingNetworkRequests > 0) document.documentElement.classList.add("woo-network-waiting");
  }, 120);
}

function endNetworkWait() {
  pendingNetworkRequests = Math.max(0, pendingNetworkRequests - 1);
  if (pendingNetworkRequests > 0) return;
  if (networkWaitTimer !== undefined) {
    window.clearTimeout(networkWaitTimer);
    networkWaitTimer = undefined;
  }
  document.documentElement.classList.remove("woo-network-waiting");
}

async function trackedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  beginNetworkWait();
  try {
    return await fetch(input, init);
  } finally {
    endNetworkWait();
  }
}

function queueBrowserMetric(metric: unknown): void {
  if (!isBrowserActivityMetricPayload(metric)) return;
  browserMetricQueue.push(metric);
  if (browserMetricQueue.length > browserMetricQueueLimit) {
    browserMetricQueue.splice(0, browserMetricQueue.length - browserMetricQueueLimit);
  }
  if (!state.session) return;
  if (browserMetricQueue.length >= browserMetricBatchLimit) {
    scheduleBrowserMetricFlush(0);
    return;
  }
  scheduleBrowserMetricFlush(browserMetricFlushDelayMs);
}

function scheduleBrowserMetricFlush(delayMs: number): void {
  if (browserMetricFlushTimer !== undefined) return;
  const sinceLastFlush = browserMetricLastFlushAt === 0 ? Number.POSITIVE_INFINITY : performance.now() - browserMetricLastFlushAt;
  const waitMs = Math.max(0, delayMs, browserMetricMinFlushIntervalMs - sinceLastFlush);
  browserMetricFlushTimer = window.setTimeout(() => {
    browserMetricFlushTimer = undefined;
    flushBrowserMetrics();
  }, waitMs);
}

function flushBrowserMetrics(options: { keepalive?: boolean } = {}): void {
  if (browserMetricFlushTimer !== undefined) {
    window.clearTimeout(browserMetricFlushTimer);
    browserMetricFlushTimer = undefined;
  }
  if (browserMetricFlushInFlight || browserMetricQueue.length === 0 || !state.session) return;
  const metrics = browserMetricQueue.splice(0, browserMetricBatchLimit);
  browserMetricFlushInFlight = true;
  browserMetricLastFlushAt = performance.now();
  void fetch("/api/browser-metrics", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ metrics }),
    keepalive: options.keepalive === true
  }).catch(() => {
    // Metrics are diagnostic only. Dropping a failed batch avoids creating
    // back-pressure on the UI when the network is already unhealthy.
  }).finally(() => {
    browserMetricFlushInFlight = false;
    if (browserMetricQueue.length > 0 && state.session) scheduleBrowserMetricFlush(0);
  });
}

function isBrowserActivityMetricPayload(value: unknown): value is BrowserActivityMetricPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metric = value as Partial<BrowserActivityMetricPayload>;
  return metric.kind === "browser_activity"
    && (metric.source === "v2_browser_worker" || metric.source === "main")
    && typeof metric.phase === "string"
    && typeof metric.ms === "number"
    && Number.isFinite(metric.ms)
    && (metric.status === "ok" || metric.status === "error");
}

function trackV2TurnNetworkWait(id: string) {
  if (pendingNetworkTurns.has(id)) return;
  pendingNetworkTurns.add(id);
  beginNetworkWait();
}

function completeV2TurnNetworkWait(id: unknown) {
  if (typeof id !== "string" || !pendingNetworkTurns.delete(id)) return;
  endNetworkWait();
}

function beginPendingToolEnter(space: string) {
  if (!space) return;
  pendingToolEnters.add(space);
  const existing = pendingToolEnterTimers.get(space);
  if (existing !== undefined) window.clearTimeout(existing);
  // Enter acknowledgements can be lost during a worker reconnect or session
  // change. Bound the gate so tool mutation controls cannot stay disabled.
  pendingToolEnterTimers.set(space, window.setTimeout(() => {
    clearPendingToolEnter(space);
    if (isToolTab(state.tab)) render();
  }, TOOL_ENTER_PENDING_TIMEOUT_MS));
}

function clearPendingToolEnter(space: string) {
  pendingToolEnters.delete(space);
  const timer = pendingToolEnterTimers.get(space);
  if (timer !== undefined) window.clearTimeout(timer);
  pendingToolEnterTimers.delete(space);
}

function clearPendingToolEnters(options: { render?: boolean } = {}) {
  if (pendingToolEnters.size === 0 && pendingToolEnterTimers.size === 0) return;
  for (const timer of pendingToolEnterTimers.values()) window.clearTimeout(timer);
  pendingToolEnters.clear();
  pendingToolEnterTimers.clear();
  if (options.render) render();
}

function connect() {
  if (state.authStatus !== "authenticated") return;
  if (connectInFlight) return;
  connectInFlight = (async () => {
    const session = readStorage(sessionKey);
    if (!session) {
      clearSession();
      state.authStatus = "anonymous";
      render();
      return;
    }
    state.session = session;
    projectionFiller.reset();
    resetPinboardNotesHydration();
    render();
    try {
      await refresh();
      ensureV2BrowserWorker();
      syncV2BrowserWorkerScope();
      reconnectDelayMs = reconnectBaseDelayMs;
    } catch (err) {
      console.warn("initial v2 projection failed", err);
      scheduleReconnect();
    }
  })().finally(() => {
    connectInFlight = null;
  });
}

function ensureV2BrowserWorker() {
  if (v2BrowserWorker) {
    syncV2BrowserWorkerScope();
    return;
  }
  if (!state.session || !state.actor) return;
  if (!("Worker" in window) || !("indexedDB" in window)) return;
  const token = authToken();
  if (!token) return;
  // The v2 worker owns the durable browser-side cache and reconnect loop.
  v2BrowserWorker = new Worker(new URL("./v2-browser-worker.ts", import.meta.url), { type: "module" });
  if (v2TestHooksEnabled) (window as unknown as { __wooV2BrowserWorker?: Worker }).__wooV2BrowserWorker = v2BrowserWorker;
  v2BrowserWorker.addEventListener("message", (event) => {
    if (event.data?.kind === "browser_metric") queueBrowserMetric(event.data.metric);
    if (event.data?.kind === "status") {
      console.debug("woo.v2", event.data.status);
      if (event.data.status?.connected === false) clearPendingToolEnters({ render: state.tab === "pinboard" || state.tab === "outliner" });
    }
    if (event.data?.kind === "projection") {
      const startedAt = performance.now();
      let failed: unknown;
      state.v2Projection = event.data as V2ProjectionMessage;
      try {
        applyV2ProjectionMessage(state.v2Projection);
        window.dispatchEvent(new CustomEvent("woo.v2.projection", { detail: state.v2Projection }));
        console.debug("woo.v2.projection", state.v2Projection);
      } catch (err) {
        failed = err;
        throw err;
      } finally {
        queueBrowserMetric({
          kind: "browser_activity",
          source: "main",
          phase: "projection_apply",
          path: state.v2Projection.cached ? "cached" : "live",
          scope: state.v2Projection.scope,
          actor: state.actor,
          ms: Math.max(0, performance.now() - startedAt),
          status: failed ? "error" : "ok",
          ...(failed ? { error: "E_BROWSER_PROJECTION_APPLY", error_detail: failed instanceof Error ? failed.message : String(failed) } : {})
        });
      }
    }
    if (event.data?.kind === "applied_frame") {
      const message = event.data as V2AppliedFrameMessage;
      window.dispatchEvent(new CustomEvent("woo.v2.applied_frame", { detail: message }));
      if (message.applied) receiveAppliedFrame(message.applied);
      console.debug("woo.v2.applied_frame", event.data);
    }
    if (event.data?.kind === "turn_result") {
      const message = event.data as V2TurnResultMessage;
      window.dispatchEvent(new CustomEvent("woo.v2.turn_result", { detail: message }));
      if (v2TestHooksEnabled) console.debug("woo.v2.turn_result", message);
      switch (v2TurnResultRoute(message)) {
        case "optimistic_result":
          receiveOptimisticResultFrame(message.frame);
          break;
        case "optimistic_error":
          receiveOptimisticErrorFrame(message.frame);
          break;
        case "final_result":
          receiveDirectResultFrame(message.frame);
          break;
        case "final_error":
          receiveErrorFrame(message.frame);
          break;
      }
    }
    if (event.data?.kind === "local_turn_invalidated") {
      window.dispatchEvent(new CustomEvent("woo.v2.local_turn_invalidated", { detail: event.data }));
      const error = settleInvalidatedOptimisticTurns(event.data as V2LocalTurnInvalidatedMessage, {
        failOptimisticCall: (id) => ui.failOptimisticCall(id),
        pendingDirect,
        pendingFrameErrors,
        pendingCommands,
        completeNetworkWait: completeV2TurnNetworkWait
      });
      if (error) {
        state.observations.unshift({ error });
        trimObservations();
        render();
      }
      console.debug("woo.v2.local_turn_invalidated", event.data);
    }
    if (event.data?.kind === "local_turn_planned" || event.data?.kind === "local_turn_fallback" || event.data?.kind === "local_turn_delegated" || event.data?.kind === "local_turn_repairing" || event.data?.kind === "local_turn_repair_failed" || event.data?.kind === "shadow_browser_compose_view") {
      window.dispatchEvent(new CustomEvent(`woo.v2.${event.data.kind}`, { detail: event.data }));
      console.debug(`woo.v2.${event.data.kind}`, event.data);
    }
    if (event.data?.kind === "live_event") {
      const observation = event.data.event?.observation;
      if (observation) {
        ui.ingestLiveObservation(observation);
        receiveLiveEvent(observation);
      }
    }
    // Frame/error messages are exposed so the worker-cache wire path can be
    // inspected without depending on transport-specific browser code.
    if (event.data?.kind === "frame") {
      window.dispatchEvent(new CustomEvent("woo.v2.frame", { detail: event.data.envelope }));
      console.debug("woo.v2.frame", event.data.envelope);
      if (event.data.envelope?.type === "woo.transport.error.v1") console.warn("woo.v2.transport.error", event.data.envelope.body);
    }
    if (event.data?.kind === "error") console.warn("woo.v2.error", event.data.error);
  });
  syncV2BrowserWorkerScope();
}

function syncV2BrowserWorkerScope(scopeOverride?: string) {
  if (!v2BrowserWorker || !state.session || !state.actor) return;
  const token = authToken();
  if (!token) return;
  const scope = scopeOverride || desiredV2BrowserScope();
  const connectionKey = `${token}\u0000${state.actor}\u0000${state.session}\u0000${scope}`;
  if (!scope || v2BrowserWorkerScope === connectionKey) return;
  v2BrowserWorkerScope = connectionKey;
  v2BrowserWorker.postMessage({
    kind: "connect",
    token,
    scope,
    actor: state.actor,
    session: state.session
  });
}

function receiveDirectResultFrame(frame: any) {
  completeV2TurnNetworkWait(frame.id);
  const clearedProvisional = typeof frame.id === "string" ? clearProvisionalChatForTurn(frame.id, false) : false;
  const handler = pendingDirect.get(frame.id);
  if (typeof frame.id === "string") pendingFrameErrors.delete(frame.id);
  const observations = frame.observations ?? [];
  for (const observation of observations) {
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
      renderChatCommandResult(commandContext.action ?? chatCommandUiActionFromPlan(frame.command), frame.result, commandContext.text);
    }
  }
  if (clearedProvisional && currentTabHasChatPanel()) render();
}

function receiveOptimisticResultFrame(frame: any) {
  // Optimistic frames are display-only previews of the verb's intended effects
  // — the worker emits them right after local planning, before the relay has
  // confirmed the commit. They surface observations and projection-shaped move
  // results so controls can advance against the local tentative journal, but
  // they MUST NOT fire the pendingDirect/onResult handler: those callbacks gate
  // committed side effects such as refreshes and external hydration.
  const observations = frame.observations ?? [];
  if (typeof frame.id === "string") ui.applyOptimisticFrame(frame.id, frame);
  // Tag chat lines pushed from optimistic observations with the turn id so
  // the authoritative reply (receiveAppliedFrame for durable verbs,
  // receiveDirectResultFrame for live verbs) can clear them before pushing
  // its own copy. Without this, every durable command shows two chat lines:
  // one from the local preview and one from the committed transcript.
  const provisionalTurnId = typeof frame.id === "string" ? frame.id : undefined;
  for (const observation of observations) {
    ui.ingestLiveObservation(observation);
    receiveLiveEvent(observation, { provisionalTurnId });
  }
  applyScopedMoveResult(frame.result);
  resolveOptimisticCommandPlan(frame);
  render();
}

function resolveOptimisticCommandPlan(frame: any) {
  const id = typeof frame.id === "string" ? frame.id : "";
  const command = frame.command;
  if (!id || !command || command.verb !== "command_plan") return;
  const handler = pendingDirect.get(id);
  if (!handler) return;
  // Planning is read-only. Use the browser-local planner result to launch the
  // selected verb immediately; the server's later live-plan echo still clears
  // the provisional planner UI, but must not execute the command a second time.
  pendingDirect.delete(id);
  pendingFrameErrors.delete(id);
  handler(frame.result);
}

function receiveOptimisticErrorFrame(frame: any) {
  // Optimistic errors are provisional local-cache previews. A missing object can
  // be repaired by a state fetch or delegated execution, so show the local
  // answer as retractable chat output without settling command handlers.
  window.dispatchEvent(new CustomEvent("woo.v2.optimistic_error", { detail: frame }));
  if (v2TestHooksEnabled) console.debug("woo.v2.optimistic_error", frame);
  const id = typeof frame.id === "string" ? frame.id : "";
  const commandContext = id ? pendingCommands.get(id) : undefined;
  if (!id || !commandContext) return;
  state.chatFeed = upsertProvisionalChatLine(
    state.chatFeed,
    provisionalChatErrorLine({ turnId: id, source: commandContext.space, error: frame.error }),
    chatFeedLimit
  );
  if (currentTabHasChatPanel()) render();
}

function receiveErrorFrame(frame: any, socket?: WebSocket) {
  completeV2TurnNetworkWait(frame.id);
  const errorHandler = typeof frame.id === "string" ? pendingFrameErrors.get(frame.id) : undefined;
  if (typeof frame.id === "string") clearProvisionalChatForTurn(frame.id, false);
  if (typeof frame.id === "string") {
    ui.failOptimisticCall(frame.id);
    pendingDirect.delete(frame.id);
    pendingCommands.delete(frame.id);
    pendingFrameErrors.delete(frame.id);
  }
  if (frame.error?.code === "E_NOSESSION") {
    clearSession();
    if (socket?.readyState === WebSocket.OPEN) socket.close();
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

function receiveAppliedFrame(frame: any) {
  completeV2TurnNetworkWait(frame.id);
  if (typeof frame.id === "string") clearProvisionalChatForTurn(frame.id, false);
  ui.ingestAppliedFrame(frame);
  applyScopedMoveResult(frame.result);
  const needsScopedDeferredLook = frame.result
    && typeof frame.result === "object"
    && !Array.isArray(frame.result)
    && frame.result.look_deferred === true
    && typeof frame.result.room === "string";
  const observations = frame.observations ?? [];
  const frameErrors = appliedFrameErrorObservations({ observations });
  receiveAppliedFrameErrors(frame, observations);
  // Sequenced verb raises arrive as `$error` observations inside applied
  // frames, so keep the pending handler until those observations route.
  if (typeof frame.id === "string") {
    const commandContext = pendingCommands.get(frame.id);
    const resultHandler = pendingDirect.get(frame.id);
    if (frameErrors.length > 0) ui.failOptimisticCall(frame.id);
    else {
      ui.completeOptimisticCall(frame.id);
      if (resultHandler) resultHandler(frame.result);
      if (commandContext) renderChatCommandResult(chatCommandUiActionFromMessage(frame.message), frame.result, commandContext.text);
    }
    pendingDirect.delete(frame.id);
    pendingCommands.delete(frame.id);
    pendingFrameErrors.delete(frame.id);
  }
  const pinboardAnimations = capturePinboardAnimations(observations);
  forgetLiveControls(observations);
  for (const observation of observations) applyDubspaceObservationSideEffects(observation);
  if (observations.some((observation: any) => isDubspaceStateObservation(observation))) syncDubspaceProjectionEffects();
  for (const observation of observations) if (isChatObservation(observation)) receiveChatEvent(observation, false);
  state.observations.unshift({ seq: frame.seq, space: frame.space, observations, message: frame.message });
  trimObservations();
  rememberSeq(frame.space, frame.seq);
  render();
  if (needsScopedDeferredLook) void refresh().then(() => focusChatInput());
  animatePinboardNotes(pinboardAnimations);
}

function applyDubspaceObservationSideEffects(observation: any) {
  if (!isDubspaceObservation(observation)) return;
  if (String(observation?.actor ?? "") !== state.actor) return;
  if (observation?.type === "dubspace_entered") {
    addDubspaceOperator(state.actor);
    markNestedSpaceDeparture(dubspaceSpace());
    if (state.tab !== "dubspace") setTab("dubspace", { mode: "push", leaveCurrent: false });
    requestSpaceChatFocus(dubspaceSpace());
  } else if (observation?.type === "dubspace_left") {
    removeDubspaceOperator(state.actor);
    if (state.tab === "dubspace") setTab("chat", { mode: "push", leaveCurrent: false });
  }
}

function desiredV2BrowserScope(): string {
  // The browser state plane is display-oriented. Use the routed object as the
  // visible scope instead of branching on catalog-specific surfaces; actor
  // scope is only a bootstrap fallback before any object route is known.
  const route = startupRoute ?? parseLocationRoute(location.pathname, location.search);
  if (route?.objectId) return route.objectId;
  return activeChatRoom() || state.actor || "";
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

function authToken(): string | null {
  const session = readStorage(sessionKey);
  return session ? `session:${session}` : null;
}

function storeSession(session: string | undefined) {
  if (session) writeStorage(sessionKey, session);
}

function clearSession() {
  clearPendingToolEnters();
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

function isSessionExpiredError(err: unknown): err is SessionExpiredError {
  return err instanceof SessionExpiredError;
}

function throwIfAuthExpired(response: Response, label: string) {
  if (response.status === 401 || response.status === 403) {
    throw new SessionExpiredError(`${label} ${response.status}`);
  }
}

function handleExpiredStoredSession(message: string) {
  const method = readAuthMethod();
  clearSession();
  state.actor = undefined;
  state.session = undefined;
  state.scopedProjection = undefined;
  state.v2Projection = undefined;
  v2BrowserWorker?.postMessage({ kind: "disconnect" });
  v2BrowserWorker?.terminate();
  v2BrowserWorker = undefined;
  v2BrowserWorkerScope = "";
  if (method === "guest") {
    state.authStatus = "anonymous";
    render();
    void loginAsGuest({ silent: true });
    return;
  }
  // A stale saved API-key session cannot be refreshed without the password.
  // Drop back to the login form instead of retrying forever as "connecting".
  state.authStatus = "anonymous";
  state.loginError = method === "apikey" ? "Your saved session expired. Please sign in again." : undefined;
  console.warn("stored session expired", message);
  render();
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
    response = await trackedFetch("/api/auth", {
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
  v2BrowserWorker?.postMessage({ kind: "disconnect" });
  v2BrowserWorker?.terminate();
  v2BrowserWorker = undefined;
  v2BrowserWorkerScope = "";
  if (sessionId) {
    try {
      await trackedFetch("/api/session", { method: "DELETE", headers: { authorization: `Session ${sessionId}` } });
    } catch {
      // best-effort; the local session is already cleared
    }
  }
  // Drop everything account-scoped (chat history, replay cursors, pinboard
  // prefs, etc.) so the next login starts clean. Keep `woo.username` so the
  // form pre-fills.
  clearAccountScopedStorage();
  // Reset the URL so the next session doesn't reopen the previous user's
  // object path. Reload to drop module-level state (framework caches, pending
  // maps, audio, chatHistory) without needing to enumerate every field.
  try {
    history.replaceState({}, "", "/");
  } catch {
    // ignore
  }
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

function rememberSeq(space: string, seq: number) {
  if (state.scopedProjection) {
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

function tabFromViewHint(view?: string): AppTab | undefined {
  if (!view) return undefined;
  return TAB_FROM_VIEW[view.trim().toLowerCase()];
}

function objectIdForTab(tab: AppTab): string {
  if (tab === "chat") return activeChatRoom();
  if (isToolTab(tab)) return toolSpace(tab);
  if (tab === "tool") return state.genericToolSubject;
  if (tab === "ide") return state.selectedObject || defaultSelectedObject();
  return "";
}

function canonicalRouteForCurrentState(tab: AppTab = state.tab): RouteLocation | null {
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

function routeForObjectId(objectId: string, summary?: any): AppTab {
  if (objectId === activeChatRoom()) return "chat";
  for (const definition of TOOL_TAB_DEFINITIONS) {
    if (objectId === toolSpace(definition.tab)) return definition.tab;
  }
  if (subjectHasSpaceWorkspaceFrame(objectId, summary)) return "tool";
  const summaryTab = tabForScopedSummary(objectId, summary ?? scopedObjectSummary(objectId));
  if (summaryTab) return summaryTab;
  return "ide";
}

function pinRoutedSubject(tab: AppTab, subject: string) {
  if (!subject) return;
  if (isToolTab(tab)) state.routedSubjects = { ...state.routedSubjects, [tab]: subject };
  if (tab === "tool") state.genericToolSubject = subject;
}

function routeSubjectForTab(tab: AppTab, routedObject: string, _summary: any): string {
  if (isToolTab(tab) || tab === "tool") return routedObject;
  return "";
}

function subjectHasSpaceWorkspaceFrame(subject: string, summary?: any): boolean {
  return toolFrameForSubject(subject, summary)?.frame.layout === "space-workspace";
}

function toolFrameForSubject(subject: string, summary?: any) {
  if (!subject) return undefined;
  return ui.catalogUi.resolveFrame(subject, undefined, (candidate, classRef) => clientClassDistance(candidate, classRef, candidate === subject ? summary : undefined));
}

async function applyLocationRoute(mode: "replace" | "push", route: RouteLocation | null = parseLocationRoute(location.pathname, location.search)) {
  if (!route || !route.objectId) {
    syncUrlFromCurrentState(mode);
    return;
  }
  const ensureTabPresence = (tab: AppTab) => {
    toolDefinition(tab)?.enter?.();
  };
  const viewTab = tabFromViewHint(route.view);
  if (viewTab) {
    const summary = await fetchScopedObjectSummary(route.objectId).catch(() => undefined);
    if (viewTab === "ide") setSelectedObject(route.objectId, { apply: false });
    pinRoutedSubject(viewTab, routeSubjectForTab(viewTab, route.objectId, summary));
    setTab(viewTab, { mode, leaveCurrent: true }, () => {
      ensureTabPresence(viewTab);
    });
    return;
  }

  const summary = await fetchScopedObjectSummary(route.objectId).catch(() => undefined);
  const inferredTab = routeForObjectId(route.objectId, summary);
  if (inferredTab === "ide") {
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

function setTab(tab: AppTab, options: { mode?: "replace" | "push"; leaveCurrent?: boolean } = {}, done?: () => void) {
  const mode = options.mode ?? "push";
  const leaveCurrent = options.leaveCurrent ?? true;
  const current = state.tab;
  if (current === "tasks" && tab !== "tasks") {
    focusTasksChatOnEntry = false;
  } else if (current !== "tasks" && tab === "tasks") {
    focusTasksChatOnEntry = true;
  }
  const finalize = () => {
    if (state.tab !== tab) state.tab = tab;
    syncUrlFromCurrentState(mode);
    if (typeof done === "function") done();
    syncV2BrowserWorkerScope();
    render();
    requestTasksChatFocusIfPending();
    if (isToolTab(tab)) {
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
    syncV2BrowserWorkerScope();
    render();
    return;
  }
  if (!leaveCurrent) {
    finalize();
    return;
  }
  const currentDefinition = toolDefinition(current);
  if (currentDefinition?.leave && current !== tab) {
    currentDefinition.leave(finalize);
    return;
  }
  finalize();
}

function setSelectedObject(id: string, options: { apply?: boolean } = {}) {
  state.selectedObject = id;
  if (id) {
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
  await refreshScopedProjection();
}

async function refreshScopedProjection() {
  const startedRevision = scopedProjectionLocalRevision;
  try {
    const [meResponse, catalogs] = await Promise.all([
      trackedFetch("/api/me", { headers: authHeaders() }),
      fetchCatalogUiIndex()
    ]);
    throwIfAuthExpired(meResponse, "/api/me");
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
    if (isSessionExpiredError(err)) {
      handleExpiredStoredSession(err.message);
      return;
    }
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
  const response = await trackedFetch("/api/catalogs/ui", { headers });
  if (response.status === 304 && catalogUiCache) return catalogUiCache;
  throwIfAuthExpired(response, "/api/catalogs/ui");
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

async function ensureScopedOverlayForTab(tab: AppTab, options: { force?: boolean } = {}): Promise<void> {
  const subject = overlaySubjectForTab(tab);
  if (!subject) return;
  const key = `${tab}:${subject}`;
  const pending = pendingOverlaySnapshots.get(key);
  // `force` means bypass the cached snapshot; it must not start a second REST
  // fetch while an identical overlay request is already in flight.
  if (pending) return await pending;
  if (!options.force && state.scopedProjection?.overlaySnapshots?.[key]) return;
  const request = (async () => {
    const response = await trackedFetch(`/api/objects/${encodeURIComponent(subject)}/ui-snapshot?surface=${encodeURIComponent(tab)}`, { headers: authHeaders() });
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

function overlaySubjectForTab(tab: AppTab): string {
  if (tab === "dubspace") return dubspaceSpace();
  if (tab === "pinboard") return pinboardSpace();
  return "";
}

function scopedToolSubject(surface: ToolTab): string {
  const definition = toolDefinition(surface);
  if (!definition) return "";
  const overlays = state.scopedProjection?.overlays ?? {};
  for (const handle of Object.values(overlays)) {
    const subject = typeof (handle as any)?.subject === "string" ? (handle as any).subject : "";
    const handleSurface = typeof (handle as any)?.surface === "string" ? (handle as any).surface : "";
    if (subject && handleSurface === surface) return subject;
  }
  const current = sessionActiveScope(state.scopedProjection?.session);
  if (typeof current === "string" && isCatalogObjectSummary(ui.observe(current), surface, definition.classRef)) return current;
  for (const item of arrayOfObjects(state.scopedProjection?.here?.contents)) {
    if (isCatalogObjectSummary(item, surface, definition.classRef)) return String(item.id ?? "");
  }
  return "";
}

function sessionActiveScope(session: any): string | undefined {
  return sessionActiveScopeFromRecord(session) ?? undefined;
}

function applyScopedOverlaySnapshot(key: string, snapshot: any) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return;
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

function applyV2ProjectionMessage(message: V2ProjectionMessage) {
  const snapshot = v2ProjectionSnapshotFromMessage(message);
  if (!snapshot) return;
  if (!state.scopedProjection) state.scopedProjection = { inventory: [], overlays: {} };
  if (snapshot.objects.length > 0) {
    // v2 projection objects follow the same catalog-neutral summary contract as
    // `/api/me`. Ingest them into the client projection cache, but keep the
    // scoped model remains the rendering authority until the v2 worker owns
    // turn submission and committed-frame reduction.
    ui.ingestSnapshot(`v2:${snapshot.scope}:${message.head.seq}`, snapshot.objects);
  }
  const projection = message.projection && typeof message.projection === "object" && !Array.isArray(message.projection)
    ? message.projection as any
    : {};
  const self = projection.self && typeof projection.self === "object" && !Array.isArray(projection.self) ? projection.self : state.scopedProjection.self;
  const session = projection.session && typeof projection.session === "object" && !Array.isArray(projection.session) ? projection.session : state.scopedProjection.session;
  const inventory = Array.isArray(projection.inventory) ? projection.inventory : state.scopedProjection.inventory;
  let cursor = state.scopedProjection.cursor;
  for (const [space, record] of Object.entries(snapshot.cursor?.spaces ?? {})) {
    const nextSeq = Number(record?.next_seq);
    if (Number.isFinite(nextSeq)) cursor = advanceProjectionCursor(cursor, space, nextSeq - 1);
  }
  state.scopedProjection = { ...state.scopedProjection, cursor, self, session, inventory };
  render();
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
  await hydrateCurrentLocationSummary(me);
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

async function hydrateCurrentLocationSummary(me: any): Promise<void> {
  const current = typeof me?.session?.current_location === "string" ? me.session.current_location : "";
  if (!current || String(me?.here?.id ?? "") === current) return;
  // Remote room snapshots can degrade to a session-only location; hydrate the
  // room title before the first scoped chat render so H1 never falls back to
  // the generic component default.
  await fetchScopedObjectSummary(current).catch(() => undefined);
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
  if (!id) return undefined;
  const cached = state.scopedObjectSummaries[id] ?? (isCompleteScopedSummary(ui.observe(id)) ? ui.observe(id) : undefined);
  if (cached) return cached;
  const response = await trackedFetch(`/api/objects/${encodeURIComponent(id)}/summary`, { headers: authHeaders() });
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
  const response = await trackedFetch(`/api/objects/${encodeURIComponent(subject)}/summary`, { headers: authHeaders() });
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

const pinboardNotesHydrator = new CoalescedViewHydrator<any[]>({
  read: readPinboardNotesView,
  apply: (result, board) => {
    if (!Array.isArray(result)) return;
    applyPinboardNotesCanonical(board, result);
    if (state.tab === "pinboard") render();
  }
});
let pinboardNotesHydrationBoard = "";

// Initial connect must run AFTER the projection/view hydrators are declared
// above:
// `connect()` → `refreshScopedProjection` → `applyScopedProjectionSnapshot`
// can reach them, and `const` initialization is in temporal dead zone until
// this point. Moving this block earlier reintroduces a hard-to-spot
// ReferenceError under specific stored-session shapes.
state.authStatus = readStorage(sessionKey) ? "authenticated" : "anonymous";
if (state.authStatus === "authenticated") connect();
else render();

function ensureProjectionFields(subject: string, fields: readonly string[]): void {
  projectionFiller.ensure(subject, fields);
}

function tabForScopedSummary(id: string, summary: any): AppTab | undefined {
  if (!summary) return undefined;
  if (id === activeChatRoom() || isRoomSummary(summary)) return "chat";
  for (const definition of TOOL_TAB_DEFINITIONS) {
    if (isCatalogObjectSummary(summary, definition.tab, definition.classRef)) return definition.tab;
  }
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
    ...arrayOfObjects(Array.isArray(here.roster) ? here.roster : here.present_actors),
    ...arrayOfObjects(here.contents),
    ...arrayOfObjects(here.exits)
  ];
}

function arrayOfObjects(value: any): any[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [];
}

function idsFromSessionSubscriberRows(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    .map((item) => item.actor)
    .filter((actor): actor is string => typeof actor === "string")));
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
      ...idsFromRefsOrSummaries(Array.isArray(here.roster) ? here.roster : Array.isArray(here.present_actors) ? here.present_actors : [])
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

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return state.session ? { ...extra, authorization: `Session ${state.session}` } : extra;
}

function activeInstalledCatalog(name: string): any | undefined {
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
  const here = state.scopedProjection?.here;
  if (String(here?.id ?? "") === id) {
    const summary = roomSnapshotAsObjectSummary(here);
    return {
      id,
      name: summary.name ?? id,
      owner: summary.owner,
      parent: summary.parent,
      location: summary.location,
      props: { ...(summary.props ?? {}) }
    };
  }
  const summary = state.scopedObjectSummaries[id];
  if (summary) {
    return {
      id,
      name: summary.name ?? id,
      owner: summary.owner,
      parent: summary.parent,
      location: summary.location,
      props: { ...(summary.props ?? {}) }
    };
  }
  return null;
}

function objectName(id: string) {
  return String(projectedObjectView(id)?.name ?? id);
}

function dubspaceObjectIds(meta: any): string[] {
  return [meta?.space, ...(Array.isArray(meta?.slots) ? meta.slots : []), meta?.channel, meta?.filter, meta?.delay, meta?.drum, meta?.scene]
    .filter((id): id is string => typeof id === "string" && Boolean(id));
}

function projectedDubspace(meta: any = dubspaceMeta()) {
  return Object.fromEntries(dubspaceObjectIds(meta).map((id: string) => [id, projectedObjectView(id)]).filter(([, view]) => view));
}

function dubspaceMeta(): any {
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

function pinboardModel(): PinboardRenderModel | undefined {
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
  const present = new Set(idsFromSessionSubscriberRows(props.session_subscribers));
  const presence = ui.observe(boardId)?.catalogState.pinboard_presence;
  if (presence && typeof presence === "object" && !Array.isArray(presence)) {
    for (const [actor, value] of Object.entries(presence)) {
      if (value === false) present.delete(actor);
      else if (value === true) present.add(actor);
    }
  }
  if (present.size > 0) return [...present];
  const room = pinboardOverlaySnapshot()?.room;
  const fromRoom = idsFromRefsOrSummaries(Array.isArray(room?.roster) ? room.roster : Array.isArray(room?.present_actors) ? room.present_actors : []);
  if (fromRoom.length > 0) return fromRoom;
  // Last-resort local fallback: before the first overlay/presence frame lands,
  // show the user in their own active pinboard rather than an empty presence
  // map. This is not an authoritative subscriber list.
  return state.actor && sessionActiveScope(state.scopedProjection?.session) === boardId ? [state.actor] : [];
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
    // Board layout is placement metadata, not proof that a pin still exists.
    // Older localdev worlds can retain layout keys after the pin object has
    // disappeared; rendering those keys produces blank white phantom notes.
    if (!removed.has(id) && hasProjectedPinboardNote(id, boardId)) ids.add(id);
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

function hasProjectedPinboardNote(id: string, boardId: string): boolean {
  const projected = ui.observe(id);
  if (!projected) return false;
  const noteState = projected.catalogState?.pinboard_note;
  if (noteState && typeof noteState === "object" && !Array.isArray(noteState) && Object.keys(noteState).length > 0) return true;
  return isPinboardNoteSummary(projected, boardId, {});
}

function pinboardProjectedNote(id: string, layoutEntry: any, legacyNotes: any[] = []): any | undefined {
  const projected = ui.observe(id);
  const previous = Array.isArray(legacyNotes) ? legacyNotes.find((note) => String(note?.id ?? "") === id) : undefined;
  const noteState = projected?.catalogState.pinboard_note ?? {};
  const entry = layoutEntry && typeof layoutEntry === "object" && !Array.isArray(layoutEntry) ? layoutEntry : {};
  if (!projected && !previous && Object.keys(entry).length === 0) return undefined;
  // Priority is deliberate: observation-reduced catalogState is the current
  // UI model; projection props carry static readable note fields; the optional
  // non-scoped cache is used only by compatibility mode; board layout fills
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

function pinboardNotesHaveMissingText(notes: any[]) {
  return (Array.isArray(notes) ? notes : []).some((note) => {
    const text = note?.text;
    if (text === undefined || text === null) return true;
    return false;
  });
}

function pinboardMissingTextSignature(notes: any[]) {
  return (Array.isArray(notes) ? notes : [])
    .filter((note) => note?.text === undefined || note?.text === null)
    .map((note) => String(note?.id ?? ""))
    .filter(Boolean)
    .sort()
    .join("|");
}

function hydratePinboardNotesTextIfNeeded(pinboard: any) {
  const board = pinboard?.board;
  const boardId = typeof board?.id === "string" ? board.id : "";
  const notes = Array.isArray(pinboard?.notes) ? pinboard.notes : [];
  if (!boardId) {
    resetPinboardNotesHydration();
    return;
  }
  if (pinboardNotesHydrationBoard !== boardId) {
    // Hydration memoization is per visible board; board/session changes should
    // drop old missing-text signatures instead of accumulating forever.
    pinboardNotesHydrationBoard = boardId;
    pinboardNotesHydrator.reset();
  }
  if (!canSendPinboardV2()) return;
  if (!pinboardActorPresent()) return;
  if (!pinboardNotesHaveMissingText(notes)) return;
  pinboardNotesHydrator.ensure(boardId, pinboardMissingTextSignature(notes));
}

function resetPinboardNotesHydration(): void {
  pinboardNotesHydrationBoard = "";
  pinboardNotesHydrator.reset();
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

function defaultSelectedObject() {
  return dubspaceMeta().delay ?? state.scopedProjection?.here?.id ?? state.actor ?? "";
}

function toolSpace(tab: ToolTab): string {
  const definition = toolDefinition(tab);
  if (!definition) return "";
  const route = startupRoute ?? parseLocationRoute(location.pathname, location.search);
  if (route?.view && definition.viewAliases.includes(route.view) && route.objectId) return route.objectId;
  if (state.routedSubjects[tab]) return state.routedSubjects[tab] ?? "";
  const scoped = scopedToolSubject(tab);
  return scoped || activeInstalledCatalogSeed(definition.seedCatalogAlias, bundledToolSeeds[tab]);
}

function dubspaceSpace() {
  return toolSpace("dubspace");
}

function pinboardSpace() {
  return toolSpace("pinboard");
}

function tasksSpace() {
  return toolSpace("tasks");
}

function outlinerSpace() {
  return toolSpace("outliner");
}

function chatRoom() {
  if (chatRoomPin && chatRoomPin.expiresAt > Date.now()) return chatRoomPin.room;
  chatRoomPin = null;
  const here = String(state.scopedProjection?.here?.id ?? "");
  if (here) return here;
  return sessionActiveScope(state.scopedProjection?.session) ?? "";
}

function defaultChatRoom() {
  return chatRoom();
}

function activeChatRoom() {
  const room = chatRoom();
  if (room) return room;
  return state.tab === "chat" ? defaultChatRoom() : "";
}

type V2TurnInput = {
  id?: string;
  route: "direct" | "sequenced";
  scope: string;
  target: string;
  verb: string;
  args?: unknown[];
  persistence?: "durable" | "live";
  options?: ProjectionCallOptions;
  onResult?: (result: any) => void;
  onError?: (error: any) => void;
};

function sendV2TurnIntent(input: Required<Pick<V2TurnInput, "id" | "route" | "scope" | "target" | "verb">> & Pick<V2TurnInput, "args" | "persistence">): boolean {
  ensureV2BrowserWorker();
  syncV2BrowserWorkerScope(input.scope);
  if (!v2BrowserWorker || !state.actor || !state.session) return false;
  v2BrowserWorker.postMessage({
    kind: "call",
    id: input.id,
    route: input.route,
    scope: input.scope,
    target: input.target,
    verb: input.verb,
    args: input.args ?? [],
    ...(input.persistence ? { persistence: input.persistence } : {})
  });
  trackV2TurnNetworkWait(input.id);
  return true;
}

function v2Turn(input: V2TurnInput): string {
  if (!input.scope) return "";
  const id = input.id ?? crypto.randomUUID();
  ui.applyOptimisticCall(id, input.options);
  if (input.onResult) pendingDirect.set(id, input.onResult);
  if (input.onError) pendingFrameErrors.set(id, input.onError);
  if (!sendV2TurnIntent({
    id,
    route: input.route,
    scope: input.scope,
    target: input.target,
    verb: input.verb,
    args: input.args ?? [],
    persistence: input.persistence
  })) {
    ui.failOptimisticCall(id);
    pendingDirect.delete(id);
    pendingFrameErrors.delete(id);
    return "";
  }
  return id;
}

function v2PlanAndExecuteCommand(space: string, text: string, onError?: (error: any) => void): string {
  const planId = crypto.randomUUID();
  if (onError) pendingFrameErrors.set(planId, onError);
  const handlePlan = (plan: any) => {
    pendingFrameErrors.delete(planId);
    if (!plan || plan.ok !== true) {
      render();
      return;
    }
    const target = String(plan.target ?? space);
    const verb = String(plan.verb ?? "");
    let route: "direct" | "sequenced" = plan.route === "sequenced" ? "sequenced" : "direct";
    if (!verb) {
      render();
      return;
    }
    const id = crypto.randomUUID();
    const args = Array.isArray(plan.args) ? plan.args : [];
    const persistence = plan.persistence === "durable" || plan.persistence === "live"
      ? plan.persistence
      : route === "direct" ? "live" : "durable";
    // Sequenced commands on $space-typed targets (e.g. pinboard:enter when its
    // arg_spec.command.route is "sequenced") plan with `space: target`. Honor
    // the substrate's plan.space; otherwise the executed turn's scope is the
    // caller's chat room, the transcript is recorded there, and the dev WS
    // routing layer submits to the target's relay → `scope_mismatch`.
    const intentScope = typeof plan.space === "string" && plan.space ? plan.space : space;
    ui.applyOptimisticCall(id, undefined);
    pendingCommands.set(id, { space, text, action: { target, verb } });
    if (onError) pendingFrameErrors.set(id, onError);
    if (!sendV2TurnIntent({
      id,
      route,
      scope: intentScope,
      target,
      verb,
      args,
      persistence
    })) {
      ui.failOptimisticCall(id);
      pendingCommands.delete(id);
      pendingFrameErrors.delete(id);
    }
  };
  // Catalog command text is parsed in-world so aliases such as Dubspace's
  // `bpm 146` stay catalog-owned while the browser sends only generic v2 turn
  // intents. The first direct turn plans; the second executes the
  // catalog-selected target/verb through the appropriate v2 plane.
  pendingDirect.set(planId, handlePlan);
  if (!sendV2TurnIntent({
    id: planId,
    route: "direct",
    scope: space,
    target: space,
    verb: "command_plan",
    args: [text],
    persistence: "live"
  })) {
    pendingFrameErrors.delete(planId);
    pendingDirect.delete(planId);
    return "";
  }
  return planId;
}

function callWithError(space: string, target: string, verb: string, args: unknown[] = [], onError?: (error: any) => void, options?: ProjectionCallOptions): Promise<unknown> {
  const id = crypto.randomUUID();
  ui.applyOptimisticCall(id, options);
  return new Promise((resolve, reject) => {
    pendingDirect.set(id, resolve);
    pendingFrameErrors.set(id, (error: any) => {
      pendingDirect.delete(id);
      onError?.(error);
      reject(error);
    });
    if (!sendV2TurnIntent({ id, route: "sequenced", scope: space, target, verb, args, persistence: "durable" })) {
      const error = { code: "E_V2_SEND_FAILED", message: "failed to send v2 turn intent" };
      ui.failOptimisticCall(id);
      pendingDirect.delete(id);
      pendingFrameErrors.delete(id);
      onError?.(error);
      reject(error);
    }
  });
}

function actorPresenceList(actor: string): string[] {
  if (actor === state.actor) {
    const locations = state.scopedProjection?.session?.all_locations;
    return Array.isArray(locations) ? locations.filter((id): id is string => typeof id === "string") : [];
  }
  return [];
}

function actorPresentInSpace(space: string, catalogPresent: readonly string[] = []) {
  const actor = state.actor;
  if (!actor || !space) return false;
  if (catalogPresent.includes(actor)) return true;
  if (sessionActiveScope(state.scopedProjection?.session) === space) return true;
  if (state.scopedProjection?.here?.id === space && state.chatPresent.includes(actor)) return true;
  return actorPresenceList(actor).includes(space);
}

function ensureSpacePresence(space: string, onReady: () => void, onError?: (error: any) => void) {
  if (!space || !canSendV2Browser()) {
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
  const persistence = verb === "enter" || verb === "leave" || verb === "out" ? "durable" : "live";
  const scope = target || activeChatRoom() || desiredV2BrowserScope();
  return v2Turn({ scope, route: "direct", target, verb, args, persistence, onResult, onError, options });
}

function command(space: string, text: string, onResult?: (result: any) => void, onError?: (error: any) => void, options?: ProjectionCallOptions) {
  const id = v2PlanAndExecuteCommand(space, text, onError);
  if (id && onResult) pendingDirect.set(id, onResult);
  void options;
  return id;
}

function canSendChat() {
  return canSendChatV2();
}

function canSendV2Browser() {
  return Boolean(state.actor && state.session && authToken());
}

function canSendChatV2() {
  return canSendV2Browser();
}

function canSendDubspaceV2() {
  return canSendV2Browser();
}

function canSendPinboardV2() {
  return canSendV2Browser();
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
  v2Turn({ scope: space, route: "direct", target: space, verb: "preview_control", args: [target, name, value], persistence: "live" });
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
}

function callDubspaceMutation(verb: string, args: unknown[], options?: ProjectionCallOptions) {
  const space = dubspaceSpace();
  const id = v2Turn({ scope: space, route: "sequenced", target: space, verb, args, options });
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
  for (const [name, value] of values) callDubspaceMutation("set_control", [target, name, value]);
}

function receiveLiveEvent(observation: any, options: { provisionalTurnId?: string } = {}) {
  if (isPinboardViewportObservation(observation)) {
    receivePinboardViewport(observation);
    return;
  }
  // Pinboard side effects (window auto-open and viewport cleanup) must fire
  // before the chat-observation branch, because pinboard_* types appear in
  // both observation lists and the chat branch returns early. The board is a
  // focus surface, not a place you travel to (catalogs/pinboard/DESIGN.md);
  // text-command exits switch back to chat through command side effects, while
  // toolbar Leave stays on the board and exposes the Enter control.
  if (isPinboardObservation(observation)) {
    const pinboardAnimations = capturePinboardAnimations([observation]);
    if (observation?.type === "pinboard_left") removePinboardViewport(String(observation?.actor ?? ""));
    if (String(observation?.actor ?? "") === state.actor) {
      if (observation?.type === "pinboard_entered") {
        markNestedSpaceDeparture(pinboardSpace());
        if (state.tab !== "pinboard") setTab("pinboard", { mode: "push", leaveCurrent: false });
        requestSpaceChatFocus(pinboardSpace());
      } else if (observation?.type === "pinboard_left" && state.tab === "pinboard") {
        // Toolbar Leave means "leave this board presence", not "navigate away";
        // keep the pinboard mounted so the user sees the Enter control.
        clearPinboardViewports();
      }
    }
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
  }
  if (isOutlinerObservation(observation)) {
    if (String(observation?.actor ?? "") === state.actor) {
      if (observation?.type === "outliner_entered") {
        markNestedSpaceDeparture(outlinerSpace());
        if (state.tab !== "outliner") setTab("outliner", { mode: "push", leaveCurrent: false });
        requestSpaceChatFocus(outlinerSpace());
      } else if (observation?.type === "outliner_left" && state.tab === "outliner") {
        setTab("chat", { mode: "push", leaveCurrent: false });
      }
    }
  }
  if (isChatObservation(observation)) {
    receiveChatEvent(observation, true, { provisionalTurnId: options.provisionalTurnId });
    return;
  }
  if (isDubspaceStateObservation(observation)) {
    syncDubspaceProjectionEffects(observation);
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
    // Direct v2 control gestures use live persistence, so the durable projection can
    // legitimately lag the live observation. Applied frames call this without an
    // observation and use the projected value after the commit lands.
    if (input && document.activeElement !== input) setControlInputValue(input, observation ? observation.value : projected);
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
  const startedAt = performance.now();
  const renderPath = state.authStatus === "authenticated" ? state.tab : "login";
  let failed: unknown;
  try {
    if (state.authStatus !== "authenticated") {
      renderLogin();
      return;
    }
    const focus = captureRenderFocus();
    const app = document.querySelector<HTMLDivElement>("#app")!;
    // Tool components may own transient UI state in their custom element
    // instance. Preserve the active frame root generically so a new tool catalog
    // does not need another app-shell branch to keep drafts, panels, or hydrate
    // guards alive across projection rerenders.
    const activeToolSelector = activeToolElementSelector();
    const preservedToolElement = activeToolSelector
      ? app.querySelector<HTMLElement>(activeToolSelector)
      : null;
    if (preservedToolElement) preservedToolElement.remove();
    app.innerHTML = `
      <div class="shell ${state.observationsCollapsed ? "observations-collapsed" : ""}">
        <aside class="nav">
          <div class="brand">${escapeHtml(state.actor ? actorLabel(state.actor) : "connecting...")}</div>
          <div class="actor">${escapeHtml(state.actor ?? "")}</div>
          ${navButton("chat", "Chat")}
          ${TOOL_TAB_DEFINITIONS.map((definition) => navButton(definition.tab, definition.label)).join("")}
          ${state.tab === "tool" ? "<!-- Generic routed tools are URL-addressable for now; keep their nav item transient until tool discovery is designed. -->" : ""}
          ${state.tab === "tool" ? navButton("tool", objectName(state.genericToolSubject) || "Tool") : ""}
          ${navButton("ide", "Inspector")}
          <a class="github-link" href="https://github.com/hughpyle/woo" target="_blank" rel="noopener noreferrer" aria-label="woo on GitHub" title="woo on GitHub">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
          </a>
        </aside>
        <main class="main">
          ${isToolTab(state.tab) ? renderToolWorkspace(state.tab) : ""}
          ${state.tab === "tool" ? renderGenericToolWorkspace(state.genericToolSubject) : ""}
          ${state.tab === "chat" ? renderChat() : ""}
          ${state.tab === "ide" ? renderIde() : ""}
        </main>
        ${renderObservationsPanel()}
      </div>
    `;

    if (preservedToolElement && activeToolSelector) {
      const placeholder = app.querySelector<HTMLElement>(activeToolSelector);
      if (placeholder) placeholder.replaceWith(preservedToolElement);
    }
    bindCommon();
    if (state.tab === "chat") mountChatComponent();
    if (isToolTab(state.tab)) toolDefinition(state.tab)?.mount();
    if (state.tab === "tool") mountGenericToolComponent();
    if (state.tab === "ide") bindIde();
    if (!restoreRenderFocus(focus) && state.tab === "chat") focusChatInput();
  } catch (err) {
    failed = err;
    throw err;
  } finally {
    if (state.session) {
      queueBrowserMetric({
        kind: "browser_activity",
        source: "main",
        phase: "render",
        path: renderPath,
        ms: Math.max(0, performance.now() - startedAt),
        status: failed ? "error" : "ok",
        scope: desiredV2BrowserScope(),
        actor: state.actor,
        count: (state.scopedProjection?.inventory?.length ?? 0) + Object.keys(state.scopedProjection?.overlays ?? {}).length,
        ...(failed ? { error: "E_BROWSER_RENDER", error_detail: failed instanceof Error ? failed.message : String(failed) } : {})
      });
    }
  }
}

function renderLogin() {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  const username = readUsername();
  const pending = state.loginPending === true;
  const error = state.loginError ?? "";
  app.innerHTML = `
    <div class="login-shell">
      <form class="card login-card" data-login-form autocomplete="on">
        <div class="login-brand">
          <h1 class="login-brand-name">woah</h1>
          <p class="login-brand-tagline">World of Agents and Humans</p>
        </div>
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
        ${error ? `<p class="alert alert--danger login-error" role="alert">${escapeHtml(error)}</p>` : ""}
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

function navButton(tab: AppTab, label: string) {
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
          ${state.observations.map((item) => `<pre class="card card--pre">${escapeHtml(JSON.stringify(item, null, 2))}</pre>`).join("") || "<p>No observations yet.</p>"}
        </div>
      `}
      <button class="icon-button events-logout" data-logout aria-label="Log out${state.actor ? ` ${state.actor}` : ""}" title="Log out${state.actor ? ` ${state.actor}` : ""}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      </button>
    </aside>
  `;
}

function bindCommon() {
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      const next = button.dataset.tab as AppTab;
      if (next !== "ide") void ensureScopedProjectionReady();
      setTab(next, { mode: "push" }, () => {
        toolDefinition(next)?.enter?.();
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
    { alias: "note", manifest: noteManifest, objects: {}, modules: { "note-chat": noteUiModule } },
    { alias: "dispenser", manifest: dispenserManifest, objects: {}, modules: { "dispenser-chat": dispenserUiModule } },
    { alias: "demoworld", manifest: demoworldManifest, objects: {}, modules: { "demoworld-chat": demoworldUiModule } },
    { alias: "dubspace", manifest: dubspaceManifest, objects: { "$dubspace": "$dubspace" }, modules: { "dubspace-ui": dubspaceUiModule } },
    { alias: "pinboard", manifest: pinboardManifest, objects: { "$pinboard": "$pinboard" }, modules: { "pinboard-ui": pinboardUiModule } },
    { alias: "outliner", manifest: outlinerManifest, objects: { "$outliner": "$outliner" }, modules: { "outliner-ui": outlinerUiModule } },
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
      ui.catalogUi.registerModuleExports(item.alias, moduleId, mod, ui.observations, ui.chatFormatters);
    }
  }
}

function dubspaceOperators(): string[] {
  const space = dubspaceSpace();
  const raw = space ? projectedObjectView(space)?.props?.operators : [];
  return Array.isArray(raw) ? raw.map(String) : [];
}

function mountAmbientCompanion(element: HTMLElement, space: string) {
  const slot = element.querySelector<HTMLElement>("[data-ambient-companion]")
    ?? element.closest<HTMLElement>("[data-ambient-companion-shell]")?.querySelector<HTMLElement>("[data-ambient-companion]");
  if (!slot || !space) return;
  const existing = slot.querySelector<HTMLElement & WooElement & { data?: SpaceChatPanelData }>(`[data-space-chat-panel]`);
  if (existing && existing.dataset.spaceChatSpace === space) {
    const lines = chatLinesForSpace(space);
    existing.subject = space;
    existing.woo = createChatWooContext(space, chatLineActorRefs(lines));
    setCustomElementData(existing, {
      space,
      spaceName: projectedObjectView(space)?.name ?? objectName(space),
      lines,
      draft: spaceChatDraft(space),
      height: Math.round(spaceChatHeight(space)),
      collapsed: state.spaceChatCollapsed
    });
    // Tasks rerenders keep/move the same chat panel node, so rebind panel
    // hooks here too (resize handle, submit, collapse), matching the
    // pinboard/dubspace binding behavior after updates.
    bindSpaceChatPanels();
    return;
  }
  if (existing) existing.remove();
  slot.innerHTML = renderAmbientCompanion(space);
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
  const inSpace = actorPresentInSpace(spaceId, operators);
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
    inSpace,
    canSend: canSendDubspaceV2(),
    audioOn: state.audioOn,
    cueSlots: state.cueSlots,
    cuePlaying: state.cuePlaying
  }, () => {
    if (spaceId && inSpace) mountAmbientCompanion(element, spaceId);
  });
  bindDubspaceComponentEvents(element);
}

function bindDubspaceComponentEvents(element: WooElement) {
  if (element.dataset.dubspaceEventsBound === "true") return;
  element.dataset.dubspaceEventsBound = "true";
  element.addEventListener("woo-dubspace-enter", enterDubspace);
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
    callDubspaceMutation("set_control", [target, name, value], dubspaceOptimisticProps(target, { [name]: value }, `${target}:${name}`));
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
    callDubspaceMutation("save_scene", [`Scene ${new Date().toLocaleTimeString()}`]);
  });
  element.addEventListener("woo-dubspace-recall-scene", () => {
    const scene = dubspaceMeta().scene;
    if (scene) callDubspaceMutation("recall_scene", [scene]);
  });
}

function bindDubspace() {
  mountDubspaceComponent();
  bindSpaceChatPanels();
  document.querySelectorAll<HTMLElement>("[data-pitch-dial]").forEach((dial) => bindPitchDial(dial));
}

function enterDubspace() {
  const space = dubspaceSpace();
  enterRoomToolSpace({
    tab: "dubspace",
    space,
    canSend: canSendDubspaceV2,
    isPresent: () => actorPresentInSpace(space, dubspaceOperators()),
    onAlreadyPresent: () => {
      void ensureScopedOverlayForTab("dubspace").then(() => {
        if (state.tab === "dubspace") render();
      });
    },
    onResult: (result) => {
      setDubspaceOperators(result);
      void ensureScopedOverlayForTab("dubspace").then(() => {
        if (state.tab === "dubspace") render();
      });
    },
    onError: () => {
      removeDubspaceOperator(state.actor);
    }
  });
}

function leaveDubspace(done?: () => void) {
  const space = dubspaceSpace();
  leaveRoomToolSpace({
    tab: "dubspace",
    space,
    canSend: canSendDubspaceV2,
    isPresent: () => actorPresentInSpace(space, dubspaceOperators()),
    onResult: (result) => {
      setDubspaceOperators(result);
      void ensureScopedOverlayForTab("dubspace");
    }
  }, done);
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

function enterChat() {
  const room = activeChatRoom();
  if (!room || !canSendChat()) return;
  const onError = chatErrorHandler(room);
  const onResult = (result: any) => {
    applyScopedMoveResult(result);
    setCurrentChatRoom(room);
    setChatPresent(result);
    if (state.tab === "chat") render();
  };
  if (canSendChatV2()) {
    v2Turn({ scope: room, route: "direct", target: room, verb: "enter", args: [], persistence: "durable", onResult, onError });
    return;
  }
  direct(room, "enter", [], onResult, onError);
}

function isChatObservation(observation: any) {
  return ui.chatFormatters.isChatType(String(observation?.type ?? ""));
}

function isDubspaceObservation(observation: any) {
  return [
    "dubspace_entered",
    "dubspace_left",
    "dubspace_activity"
  ].includes(String(observation?.type ?? ""));
}

function isOutlinerObservation(observation: any) {
  return [
    "outliner_entered",
    "outliner_left",
    "outliner_activity"
  ].includes(String(observation?.type ?? ""));
}

function isPinboardViewportObservation(observation: any) {
  return String(observation?.type ?? "") === "pinboard_viewport";
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
      note.removeEventListener("transitionend", onTransitionEnd);
      note.classList.remove("pin-note-animating");
      note.style.transform = "";
      note.style.transformOrigin = "";
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      // Child controls inside a note also have transitions; only the note's
      // own transform transition marks the layout animation as complete.
      if (event.target === note && event.propertyName === "transform") cleanup();
    };
    note.addEventListener("transitionend", onTransitionEnd);
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

function receiveChatEvent(observation: any, shouldRender = true, options: { provisionalTurnId?: string } = {}) {
  // `text` is a directed observation (spec/semantics/events.md §12.7.1) — it
  // belongs in its target's feed only. We still see other actors' lines in
  // our own DirectResultFrame.observations envelope (the originator gets the
  // full room fan-out by design), so filter here before they reach the chat
  // pane. Without this, a verb like `:move`'s `:announce_all_but` echoes
  // every recipient's line back to the caller.
  const type = String(observation?.type ?? "");
  if (
    type === "text"
    && typeof observation?.target === "string"
    && state.actor
    && observation.target !== state.actor
  ) return;
  applyScopedChatObservation(observation);
  // Side-effect branches below stay keyed on observation.type, not on the
  // formatter-supplied kind. The formatter's kind is for rendering only.
  const presentActors = presentActorsFromObservation(observation);
  // Only adopt roster as the chat sidebar list when the observation came from
  // the actor's current chat room; a `look at pinboard` from the deck would
  // otherwise overwrite the deck's presence list with the pinboard's roster.
  const observationRoom = chatObservationSpace(observation);
  const fromCurrentRoom = !observationRoom || observationRoom === chatRoom();
  if ((type === "looked" || type === "who") && presentActors.length > 0 && fromCurrentRoom) state.chatPresent = presentActors;
  const presenceUpdate = updateEnteredLeftChatPresence(state.chatPresent, observation, chatRoom());
  if (presenceUpdate.handledPresence) {
    state.chatPresent = presenceUpdate.present;
    if (!presenceUpdate.shouldPushChatLine) return;
  }
  // `taken` / `dropped` (and `entered` / `left`) are room-broadcasts that the
  // server's audience computation excludes the doer from (world.ts'
  // observationAudienceActors). The originator still receives them in their
  // DirectResultFrame.observations envelope by design, so the doer-exclusion
  // has to be applied here before the chat line is pushed; the verb's own
  // tell(actor, …) line ("You drop X.") already covers the doer's view.
  if (
    (type === "taken" || type === "dropped" || type === "entered" || type === "left")
    && typeof observation.actor === "string"
    && state.actor
    && observation.actor === state.actor
  ) return;
  const formatterResult = ui.chatFormatters.format(observation, chatFormatterContext());
  const lineText = formatterResult?.text !== undefined
    ? formatterResult.text
    : (typeof observation.text === "string" ? observation.text : undefined);
  const kind = formatterResult?.kind ?? type;
  // Optimistic-preview chat lines are tagged with the turn id so the authoritative
  // applied/direct frame's `clearProvisionalChatForTurn(frame.id)` removes them
  // before its own observations land; otherwise the same line appears twice
  // (once from the local preview, once from the server reply).
  const provisionalFields = options.provisionalTurnId
    ? { provisional: true as const, turnId: options.provisionalTurnId }
    : {};
  pushChatLine({
    kind,
    actor: typeof (formatterResult?.actor ?? observation.actor) === "string" ? (formatterResult?.actor ?? observation.actor) : undefined,
    from: typeof observation.from === "string" ? observation.from : undefined,
    to: typeof observation.to === "string" ? observation.to : undefined,
    style: typeof (formatterResult?.style ?? observation.style) === "string" ? (formatterResult?.style ?? observation.style) : undefined,
    reason: typeof observation.reason === "string" ? observation.reason : undefined,
    source: chatObservationSource(observation),
    text: lineText,
    ts: typeof observation.ts === "number" ? observation.ts : undefined,
    ...provisionalFields
  }, shouldRender);
}

function applyScopedMoveResult(result: any) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return;
  if (!state.scopedProjection) state.scopedProjection = { inventory: [], overlays: {} };
  const movedRoom = typeof result.room === "string" ? result.room : "";
  state.scopedProjection = scopedModelWithMoveResult(state.scopedProjection, result);
  if (movedRoom || (result.here && typeof result.here === "object" && !Array.isArray(result.here))) {
    scopedProjectionLocalRevision += 1;
    syncV2BrowserWorkerScope(movedRoom || undefined);
  }
  applyScopedProjectionModel();
  if (movedRoom && state.tab === "chat") syncUrlFromCurrentState("replace");
}

function applyScopedProjectionModel() {
  if (!state.scopedProjection) return;
  const here = state.scopedProjection.here;
  ui.ingestSnapshot("here", roomSnapshotObjects(here));
  state.chatPresent = scopedHerePresentActors(here);
  lastObservedChatRoom = typeof here?.id === "string" ? here.id : "";
}

function applyScopedChatObservation(observation: any) {
  if (!state.scopedProjection?.here || !observation || typeof observation !== "object" || Array.isArray(observation)) return;
  const space = chatObservationSpace(observation);
  if (space && space !== state.scopedProjection.here.id) return;
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
  const summaries = new Map(arrayOfObjects(Array.isArray(state.scopedProjection.here.roster) ? state.scopedProjection.here.roster : state.scopedProjection.here.present_actors).map((item) => [String(item.id ?? ""), item]));
  if (type === "entered" && !summaries.has(actor)) summaries.set(actor, ui.observe(actor) ?? { id: actor, name: actor, props: {}, catalogState: {} });
  const roster = [...present].map((id) => summaries.get(id) ?? { id, name: id });
  state.scopedProjection.here = {
    ...state.scopedProjection.here,
    roster
  };
  state.chatPresent = [...present];
  ui.ingestSnapshot("here", roomSnapshotObjects(state.scopedProjection.here));
}

function receiveChatError(error: any, source?: string) {
  pushChatLine({
    kind: "error",
    source,
    text: chatErrorText(error),
    ts: Date.now()
  });
}

// Returns an error handler that tags the resulting chat line with `source`
// so it is filtered to the originating space's feed (chatLinesForSpace).
// Without a source, an error line shows in every space the user visits next.
function chatErrorHandler(source: string): (error: any) => void {
  return (error) => receiveChatError(error, source);
}

function receiveAppliedFrameErrors(frame: any, observations: any[]) {
  const errors = appliedFrameErrorObservations({ observations });
  if (errors.length === 0) return;
  const errorHandler = typeof frame.id === "string" ? pendingFrameErrors.get(frame.id) : undefined;
  for (const error of errors) (errorHandler ?? receiveChatError)(error);
}

function currentChatOutputSpace(): string {
  if (state.tab === "dubspace") return dubspaceSpace();
  if (state.tab === "pinboard") return pinboardSpace();
  return chatRoom();
}

function chatFormatterContext() {
  return {
    label: (id: string | undefined) => actorLabel(id),
    viewer: state.actor || undefined
  };
}

function chatObservationSource(observation: any): string | undefined {
  if (String(observation?.type ?? "") === "text" && typeof observation?.target === "string") {
    if (!state.actor || observation.target === state.actor) return currentChatOutputSpace();
  }
  if (String(observation?.type ?? "") === "looked" && (!state.actor || observation?.to === state.actor)) {
    const outputSpace = currentChatOutputSpace();
    for (const key of ["target", "source", "board", "space", "room"]) {
      if (observation?.[key] === outputSpace) return outputSpace;
    }
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
  state.chatFeed = [...state.chatFeed, line].slice(-chatFeedLimit);
  if (shouldRender && currentTabHasChatPanel()) render();
}

function clearProvisionalChatForTurn(turnId: string, shouldRender = true): boolean {
  const cleared = clearProvisionalChatLines(state.chatFeed, turnId);
  if (!cleared.removed) return false;
  state.chatFeed = cleared.feed;
  if (shouldRender && currentTabHasChatPanel()) render();
  return true;
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
  // Tabs whose layout embeds a `.ambient-companion-shell` and therefore needs
  // a live repaint when chat lines arrive. Tasks renders chat alongside
  // the kanban board via the shared `space-chat-mini` component, same
  // shape as dubspace/pinboard/outliner.
  return ["chat", "dubspace", "pinboard", "tasks", "outliner"].includes(state.tab);
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

function setSpaceChatCollapsed(collapsed: boolean) {
  state.spaceChatCollapsed = collapsed;
  writeStorage(spaceChatCollapsedKey, collapsed ? "1" : "0");
  document.querySelectorAll<HTMLElement & WooElement & { data?: SpaceChatPanelData }>(`[data-space-chat-panel]`).forEach((panel) => {
    const space = panel.dataset.spaceChatSpace ?? "";
    const lines = chatLinesForSpace(space);
    panel.woo = createChatWooContext(space, chatLineActorRefs(lines));
    setCustomElementData(panel, {
      space,
      spaceName: projectedObjectView(space)?.name ?? objectName(space),
      lines,
      draft: spaceChatDraft(space),
      height: Math.round(spaceChatHeight(space)),
      collapsed
    });
  });
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
  else if (Array.isArray(result?.roster)) state.chatPresent = idsFromRefsOrSummaries(result.roster);
  else if (Array.isArray(result?.present_actors)) state.chatPresent = idsFromRefsOrSummaries(result.present_actors);
}

function setCurrentChatRoom(room: string) {
  if (room) chatRoomPin = { room, expiresAt: Date.now() + 10_000 };
  if (state.actor && !state.chatPresent.includes(state.actor)) state.chatPresent = [...state.chatPresent, state.actor];
  syncUrlFromCurrentState("replace");
}

function renderChat() {
  const tag = chatFrameComponentTag();
  if (!tag) return `<section class="card"><p class="empty-state">No chat UI is registered for this room.</p></section>`;
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
    canSend: canSendChat()
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
  if (String(state.scopedProjection?.here?.id ?? "") === room) {
    return arrayOfObjects(state.scopedProjection?.here?.contents)
      .map((item) => {
        const id = String(item?.id ?? "");
        return id ? ui.observe(id) ?? item : null;
      })
      .filter((item): item is any => Boolean(item));
  }
  return [];
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

function clientClassDistance(subject: string, classRef: string, summary?: any): number | false {
  const object = summary && (!summary.id || String(summary.id) === subject) ? summary : ui.observe(subject);
  if (subject === classRef || object?.parent === classRef) return subject === classRef ? 0 : 1;
  const ancestors = Array.isArray(object?.ancestors) ? object.ancestors.map(String) : [];
  const index = ancestors.indexOf(classRef);
  return index >= 0 ? Math.max(1, ancestors.length - index) : false;
}

function bindChatComponentEvents(element: WooElement & { data?: ChatSpaceData }) {
  if (element.dataset.chatEventsBound === "true") return;
  element.dataset.chatEventsBound = "true";
  element.addEventListener("woo-chat-enter", enterChat);
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
  const neighborhoodRefs = new Set([subject, ...(state.chatPresent ?? []), ...extraRefs, ...v2ProjectionObjectRefs(subject), ...uiProjectionObjectRefs(subject), ...(state.actor ? [state.actor] : [])].filter(Boolean));
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

function v2ProjectionObjectRefs(scope: string): string[] {
  if (!scope || state.v2Projection?.scope !== scope) return [];
  const projection = state.v2Projection.projection;
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) return [];
  const objects = Array.isArray((projection as { objects?: unknown }).objects) ? (projection as { objects: unknown[] }).objects : [];
  return objects.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "";
    return typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : "";
  }).filter(Boolean);
}

function uiProjectionObjectRefs(scope: string): string[] {
  if (!scope) return [];
  return ui.refs().filter((ref) => {
    if (!ref || ref === scope) return false;
    return ui.observe(ref)?.location === scope;
  });
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
  const onError = chatErrorHandler(space);
  if (canSendChatV2()) {
    v2PlanAndExecuteCommand(space, text, onError);
    return;
  }
  ensureSpacePresence(space, () => {
    command(space, text, undefined, onError);
  }, onError);
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
    requestSpaceChatFocus(target);
    return;
  }
  if ((verb === "leave" || verb === "out") && target === dubspaceSpace()) {
    setDubspaceOperators(result);
    setTab("chat", { mode: "push", leaveCurrent: false });
    focusChatInput();
    return;
  }
  if ((verb === "leave" || verb === "out") && target === pinboardSpace()) {
    setPinboardPresent(result);
    clearPinboardViewports();
    setTab("chat", { mode: "push", leaveCurrent: false });
    focusChatInput();
    return;
  }
  if (verb === "enter" && target === pinboardSpace()) {
    setPinboardPresent(result);
    setTab("pinboard", { mode: "push", leaveCurrent: false });
    // The v2 projection/accepted frame already carries the board and note
    // projection. Do not queue list_notes or another overlay fetch on entry.
    requestSpaceChatFocus(target);
    return;
  }
  if (verb === "enter" && target === outlinerSpace()) {
    setTab("outliner", { mode: "push", leaveCurrent: false });
    requestSpaceChatFocus(target);
    return;
  }
  if ((verb === "leave" || verb === "out") && target === outlinerSpace()) {
    setTab("chat", { mode: "push", leaveCurrent: false });
    focusChatInput();
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
    if (result.look_deferred === true) void refresh().then(() => focusChatInput());
    else render();
    return;
  }
  if (verb === "enter") {
    if (target) setCurrentChatRoom(target);
    setChatPresent(result);
    if (result?.look_deferred === true) void refresh().then(() => focusChatInput());
    else render();
    return;
  }
  if (verb === "take" || verb === "drop") {
    render();
    return;
  }
  void originalText;
  void result;
}

function applyLookResult(result: any) {
  const present = idsFromRefsOrSummaries(Array.isArray(result?.roster) ? result.roster : Array.isArray(result?.present_actors) ? result.present_actors : []);
  if (present.length === 0) return;
  // `look pinboard` returns the board's own roster; clobbering chatPresent
  // with it hides the chat UI for anyone not also inside the board.
  const lookedId = typeof result?.id === "string" ? result.id : "";
  if (lookedId && lookedId !== activeChatRoom()) return;
  state.chatPresent = present;
}

function actorLabel(id: string | undefined) {
  if (!id) return "unknown";
  return String(projectedObjectView(id)?.name ?? id);
}

function renderToolWorkspace(tab: ToolTab) {
  const definition = toolDefinition(tab);
  if (!definition) return "";
  const subject = toolSpace(tab);
  const tag = toolFrameComponentTag(subject, definition.frameComponent, definition.catalogAlias);
  if (!tag) {
    return `
      <section class="toolbar"><h1>${escapeHtml(definition.emptyTitle)}</h1></section>
      <section class="panel"><p class="empty-state">${escapeHtml(definition.emptyMessage)}</p></section>
    `;
  }
  return `<${tag} data-tool-workspace="${escapeHtml(tab)}" ${definition.elementTagAttrs(subject)}></${tag}>`;
}

function renderGenericToolWorkspace(subject: string) {
  const resolved = toolFrameForSubject(subject);
  const firstMainNode = resolved?.frame.regions.main?.[0];
  const component = firstMainNode ? ui.catalogUi.component(firstMainNode.component, resolved?.catalog.alias) : undefined;
  const tag = component?.declaration.tag;
  const title = objectName(subject) || "Tool";
  if (!tag) {
    return `
      <section class="toolbar"><h1>${escapeHtml(title)}</h1></section>
      <section class="panel"><p class="empty-state">No tool UI is registered for this object.</p></section>
    `;
  }
  return `<${tag} data-tool-workspace="tool" data-generic-tool-workspace data-tool-subject="${escapeHtml(subject)}"></${tag}>`;
}

function activeToolElementSelector(): string {
  const definition = toolDefinition(state.tab);
  if (definition) return definition.elementSelector;
  if (state.tab === "tool") return "[data-generic-tool-workspace]";
  return "";
}

function renderAmbientCompanion(space: string) {
  const height = Math.round(spaceChatHeight(space));
  const component = ui.catalogUi.component("chat.space-mini", "chat");
  const tag = component?.declaration.tag;
  if (!tag) {
    return `
      <section class="card space-chat-panel" data-space-chat-missing="${escapeHtml(space)}" style="height:${height}px">
        <p class="chat-empty">No chat UI is registered for this space.</p>
      </section>
    `;
  }
  return `<${tag} class="card space-chat-panel" data-space-chat-panel data-space-chat-space="${escapeHtml(space)}" style="height:${height}px"></${tag}>`;
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
  const inBoard = actorPresentInSpace(boardId, present);
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
    inBoard,
    canSend: canSendPinboardV2(),
    newText: state.pinboardNewText,
    newColor: state.pinboardNewColor,
    viewports: state.pinboardViewports
  }, () => {
    if (boardId && inBoard) mountAmbientCompanion(element, boardId);
  });
  bindPinboardComponentEvents(element);
}

function bindPinboardComponentEvents(element: WooElement) {
  if (element.dataset.pinboardEventsBound === "true") return;
  element.dataset.pinboardEventsBound = "true";
  element.addEventListener("woo-pinboard-enter", enterPinboard);
  element.addEventListener("woo-pinboard-leave", () => leavePinboard());
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
  requestTasksChatFocusIfPending();
  bindSpaceChatPanels();
}

function bindOutliner() {
  mountOutlinerComponent();
  bindSpaceChatPanels();
}

function mountGenericToolComponent() {
  const element = document.querySelector<WooElement & { hydrate?: () => Promise<void>; showCompanion?: boolean }>("[data-generic-tool-workspace]");
  if (!element) return;
  const subject = state.genericToolSubject || element.dataset.toolSubject || "";
  if (!subject) return;
  const subjectChanged = element.subject !== subject;
  const resolved = toolFrameForSubject(subject);
  const mainNode = resolved?.frame.regions.main?.[0];
  element.subject = subject;
  element.node = mainNode;
  element.woo = createChatWooContext(subject);
  if ("showCompanion" in element) element.showCompanion = actorPresentInSpace(subject);
  // Generic tools are expected to hydrate through WooContext. This keeps the
  // host catalog-agnostic: the component calls or observes its subject instead
  // of receiving a main.ts-shaped data object.
  if (subjectChanged || element.dataset.genericToolHydrated !== "true") {
    element.dataset.genericToolHydrated = "true";
    void element.hydrate?.();
  }
  if (actorPresentInSpace(subject)) mountAmbientCompanion(element, subject);
  bindSpaceChatPanels();
}

function mountOutlinerComponent() {
  const element = document.querySelector<WooElement & { subject?: string; hydrate?: () => Promise<void>; syncFromProjection?: () => void; showCompanion?: boolean; entering?: boolean }>("[data-outliner-tree]");
  if (!element) return;
  const id = outlinerSpace();
  if (!id) return;
  const subjectChanged = element.subject !== id;
  element.subject = id;
  element.woo = createChatWooContext(id);
  element.entering = pendingToolEnters.has(id);
  element.showCompanion = actorPresentInSpace(id);
  element.syncFromProjection?.();
  // The outliner renders cheap structural state from projection on every SPA
  // render. Its one-time hydrate hook may issue list_items when generic note
  // text is read-gated out of the projection; keep that outside the render
  // loop so refreshes do not create repeated read turns.
  if (subjectChanged || element.dataset.outlinerHydrated !== "true") {
    element.dataset.outlinerHydrated = "true";
    void element.hydrate?.();
  }
  if (actorPresentInSpace(id)) mountAmbientCompanion(element, id);
}

function mountTasksKanbanComponent() {
  const element = document.querySelector<WooElement & { subject?: string; showCompanion?: boolean }>("[data-tasks-board]");
  if (!element) return;
  const boardId = tasksSpace();
  if (!boardId) return;
  const inSpace = actorPresentInSpace(boardId);
  element.subject = boardId;
  element.woo = createChatWooContext(boardId);
  if ("showCompanion" in element) element.showCompanion = inSpace;
  if (element.dataset.tasksEventsBound !== "true") {
    element.dataset.tasksEventsBound = "true";
    element.addEventListener("woo-tasks-rendered", () => {
      const nextBoardId = tasksSpace();
      if (nextBoardId && actorPresentInSpace(nextBoardId)) mountAmbientCompanion(element, nextBoardId);
    });
  }
  if (inSpace) mountAmbientCompanion(element, boardId);
  requestTasksChatFocusIfPending();
}

function requestTasksChatFocusIfPending() {
  if (!focusTasksChatOnEntry) return;
  if (state.tab !== "tasks") return;
  const active = document.activeElement;
  const space = tasksSpace();
  if (!space) return;
  if (active instanceof HTMLElement) {
    const inTasksWithoutChat = active.closest("[data-tasks-board]") !== null && active.closest("[data-space-chat-panel]") === null;
    if (inTasksWithoutChat) return;
  }
  requestSpaceChatFocus(space);
  focusTasksChatOnEntry = false;
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
    spaceName: projectedObjectView(space)?.name ?? objectName(space),
    lines,
    draft: spaceChatDraft(space),
    height: Math.round(spaceChatHeight(space)),
    collapsed: state.spaceChatCollapsed
  }, () => panel.scrollFeedToEnd?.());
  bindSpaceChatComponentEvents(panel);
  bindSpaceChatResize(panel);
  // Sync the shell's --space-chat-h on mount so the divider lands at the saved
  // height from the start, not just after the user first drags the resizer.
  applySpaceChatHeight(panel, spaceChatHeight(space));
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
  panel.addEventListener("woo-chat-collapse", (event) => {
    const detail = (event as CustomEvent<{ collapsed?: unknown }>).detail ?? {};
    setSpaceChatCollapsed(Boolean(detail.collapsed));
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
  const isCollapsed = panel.classList.contains("is-collapsed");
  if (isCollapsed) {
    panel.style.removeProperty("height");
    const shell = panel.closest<HTMLElement>("[data-ambient-companion-shell]");
    if (shell) shell.style.removeProperty("--space-chat-h");
    if (panel.parentElement instanceof HTMLElement) {
      panel.parentElement.style.removeProperty("--space-chat-h");
      const layout = panel.parentElement.querySelector<HTMLElement>(`[data-space-chat-layout="${cssAttrValue(space)}"]`);
      if (layout) layout.style.removeProperty("--space-chat-h");
    }
    return;
  }
  const normalizedHeight = normalizeSpaceChatHeight(height);
  if (space) state.spaceChatHeights = { ...state.spaceChatHeights, [space]: normalizedHeight };
  const rounded = `${Math.round(normalizedHeight)}px`;
  panel.style.height = rounded;
  // The grid container (.ambient-companion-shell) is what reads --space-chat-h to size
  // the chat row vs the workarea row. CSS vars only propagate down the tree, so
  // the var must land on the shell itself — not just on a child of it — for the
  // divider to actually move when the user drags the resizer.
  const shell = panel.closest<HTMLElement>("[data-ambient-companion-shell]");
  if (shell) shell.style.setProperty("--space-chat-h", rounded);
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
  if (!pinboardActorPresent() || state.tab !== "pinboard" || !canSendPinboardV2()) return;
  if (pinboardViewportTimer !== undefined) return;
  const wait = Math.max(0, PINBOARD_VIEWPORT_MIN_MS - (Date.now() - lastPinboardViewportPublishAt));
  pinboardViewportTimer = window.setTimeout(() => {
    pinboardViewportTimer = undefined;
    publishPinboardViewport();
  }, wait);
}

function publishPinboardViewport() {
  if (!pinboardActorPresent() || state.tab !== "pinboard" || !canSendPinboardV2()) return;
  const viewport = currentPinboardViewport();
  if (!viewport || !pinboardViewportChanged(viewport, lastPinboardViewportSent)) return;
  lastPinboardViewportSent = viewport;
  lastPinboardViewportPublishAt = Date.now();
  const board = pinboardSpace();
  if (board) {
    v2Turn({
      scope: board,
      route: "direct",
      target: board,
      verb: "viewport",
      args: [viewport.x, viewport.y, viewport.w, viewport.h, viewport.scale],
      persistence: "live"
    });
  }
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
  if (!state.actor || !board) return false;
  // Pinboard is a nested space; direct view fills and commit projections can
  // briefly leave session.activeScope stale while the board presence overlay is
  // already current. Use the same presence model the board renders, including
  // explicit `pinboard_left` false tombstones from the catalog reducer.
  const projected = ui.observe(board);
  const props = projected?.props && typeof projected.props === "object" && !Array.isArray(projected.props)
    ? projected.props
    : {};
  return actorPresentInSpace(board, scopedPinboardPresentActors(board, props));
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

type RoomToolLifecycleOptions = {
  tab: ToolTab;
  space: string;
  canSend: () => boolean;
  route?: "direct" | "sequenced";
  isPresent?: () => boolean;
  waitForLeaveResult?: boolean;
  onAlreadyPresent?: () => void;
  onResult?: (result: any) => void;
  onError?: (error: any) => void;
};

function enterRoomToolSpace(options: RoomToolLifecycleOptions) {
  const { tab, space, canSend, route = "direct" } = options;
  // Room-like tool mutating verbs pass the substrate's presence gate on
  // $space, so the SPA must move the actor into the tool room before it exposes
  // the companion chat and mutation controls. Keep this shared so new tools do
  // not drift into bespoke chat/presence semantics.
  if (!space || !canSend()) return;
  if ((options.isPresent ?? (() => actorPresentInSpace(space)))() || pendingToolEnters.has(space)) {
    options.onAlreadyPresent?.();
    requestSpaceChatFocus(space);
    return;
  }
  beginPendingToolEnter(space);
  if (state.tab === tab) render();
  const turnId = v2Turn({
    scope: space,
    route,
    target: space,
    verb: "enter",
    args: [],
    persistence: "durable",
    onResult: (result) => {
      clearPendingToolEnter(space);
      applyScopedMoveResult(result);
      options.onResult?.(result);
      if (state.tab === tab) render();
      requestSpaceChatFocus(space);
    },
    onError: (error) => {
      clearPendingToolEnter(space);
      options.onError?.(error);
      if (state.tab === tab) render();
    }
  });
  if (!turnId) {
    const error = new Error(`failed to send ${tab} enter`);
    clearPendingToolEnter(space);
    options.onError?.(error);
    if (state.tab === tab) render();
  }
}

function leaveRoomToolSpace(options: RoomToolLifecycleOptions, done?: () => void) {
  const { tab, space, canSend, route = "direct" } = options;
  if (!space || !canSend()) {
    done?.();
    return;
  }
  if (!(options.isPresent ?? (() => actorPresentInSpace(space)))()) {
    done?.();
    return;
  }
  const waitForLeaveResult = options.waitForLeaveResult === true;
  if (!waitForLeaveResult) done?.();
  const turnId = v2Turn({
    scope: space,
    route,
    target: space,
    verb: "leave",
    args: [],
    persistence: "durable",
    onResult: (result) => {
      applyScopedMoveResult(result);
      options.onResult?.(result);
      if (waitForLeaveResult) done?.();
      if (state.tab === tab) render();
    },
    onError: (error) => {
      options.onError?.(error);
      if (waitForLeaveResult) done?.();
      if (state.tab === tab) render();
    }
  });
  if (!turnId) {
    const error = new Error(`failed to send ${tab} leave`);
    options.onError?.(error);
    if (waitForLeaveResult) done?.();
    if (state.tab === tab) render();
  }
}

function enterTasks() {
  enterRoomToolSpace({ tab: "tasks", space: tasksSpace(), canSend: canSendV2Browser });
}

function leaveTasks(done?: () => void) {
  leaveRoomToolSpace({ tab: "tasks", space: tasksSpace(), canSend: canSendV2Browser }, done);
}

function enterOutliner() {
  enterRoomToolSpace({ tab: "outliner", space: outlinerSpace(), canSend: canSendV2Browser });
}

function leaveOutliner(done?: () => void) {
  leaveRoomToolSpace({ tab: "outliner", space: outlinerSpace(), canSend: canSendV2Browser }, done);
}

function enterPinboard() {
  const board = pinboardSpace();
  enterRoomToolSpace({
    tab: "pinboard",
    space: board,
    canSend: canSendPinboardV2,
    route: "sequenced",
    isPresent: pinboardActorPresent,
    onAlreadyPresent: () => {
      void ensureScopedOverlayForTab("pinboard").then(() => {
        if (state.tab === "pinboard") render();
      });
    },
    onResult: (result) => {
      setPinboardPresent(result);
      // The committed frame updates the projection; forcing list_notes here
      // puts the next user turn behind a redundant read storm.
    }
  });
}

function leavePinboard(done?: () => void) {
  const board = pinboardSpace();
  // Release tab navigation immediately like the other room tools. A stalled
  // sequenced leave reply must not trap the user on the Pinboard tab; board
  // presence and viewport cleanup still apply when the result eventually lands.
  leaveRoomToolSpace({
    tab: "pinboard",
    space: board,
    canSend: canSendPinboardV2,
    route: "sequenced",
    isPresent: pinboardActorPresent,
    onResult: (result) => {
      setPinboardPresent(result);
      clearPinboardViewports();
      // Leaving removes this session from the board viewport snapshot; force the
      // overlay refresh so stale self-presence does not linger on the map.
      void ensureScopedOverlayForTab("pinboard", { force: true });
    }
  }, done);
}

function setPinboardPresent(result: any) {
  const present = Array.isArray(result)
    ? result
    : Array.isArray(result?.present)
      ? result.present
      : Array.isArray(result?.roster)
        ? result.roster
        : Array.isArray(result?.present_actors)
          ? result.present_actors
        : [];
  const presentIds = idsFromRefsOrSummaries(present);
  const boardId = pinboardSpace();
  if (boardId) ui.applyCanonical([{
    subject: boardId,
    catalogState: { pinboard_presence: Object.fromEntries(presentIds.map((id) => [id, true])) }
  }]);
  const presentActors = new Set(presentIds);
  for (const actor of Object.keys(state.pinboardViewports)) {
    if (!presentActors.has(actor)) removePinboardViewport(actor);
  }
}

function pinboardCall(verb: string, args: any[] = [], options?: ProjectionCallOptions) {
  const board = pinboardSpace();
  if (board) v2Turn({ scope: board, route: "sequenced", target: board, verb, args, options });
}

function pinboardTargetCall(target: string, verb: string, args: any[] = [], options?: ProjectionCallOptions) {
  const board = pinboardSpace();
  if (board && target) v2Turn({ scope: board, route: "sequenced", target, verb, args, options });
}

function readPinboardNotesView(board: string): Promise<any[]> {
  if (!board || !canSendPinboardV2()) {
    return Promise.reject(new Error("pinboard list_notes is unavailable"));
  }
  return new Promise((resolve, reject) => {
    v2Turn({
      scope: board,
      route: "direct",
      target: board,
      verb: "list_notes",
      args: [],
      persistence: "live",
      onResult: (result) => {
        resolve(Array.isArray(result) ? result : []);
      },
      onError: reject
    });
  });
}

function applyPinboardNotesCanonical(board: string, result: any[]) {
  const previous = pinboardModel()?.notes ?? [];
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
  const object = state.selectedObject || defaultSelectedObject();
  const summary = scopedObjectSummary(object);
  const scopedSmoke = scopedProjectionSmokeEnabled
    ? `<div class="card"><h2>Scoped projection smoke</h2><pre>${escapeHtml(JSON.stringify(state.scopedProjectionSmoke ?? {}, null, 2))}</pre></div>`
    : "";
  return `
    <section class="toolbar">
      <h1>Inspector</h1>
      <input data-scoped-object-ref value="${escapeHtml(object)}" />
      <button data-scoped-object-inspect>Inspect</button>
    </section>
    <section class="split">
      <div class="card"><pre>${escapeHtml(JSON.stringify(summary ?? { id: object, loading: Boolean(object) }, null, 2))}</pre></div>
    </section>
    ${scopedSmoke}
  `;
}

function bindIde() {
  const inspect = () => {
    const input = document.querySelector<HTMLInputElement>("[data-scoped-object-ref]");
    const id = input?.value.trim() ?? "";
    if (id) setSelectedObject(id);
  };
  document.querySelector<HTMLButtonElement>("[data-scoped-object-inspect]")?.addEventListener("click", inspect);
  document.querySelector<HTMLInputElement>("[data-scoped-object-ref]")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") inspect();
  });
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
