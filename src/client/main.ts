import "./styles.css";

type AppState = {
  socket?: WebSocket;
  actor?: string;
  session?: string;
  tab: "chat" | "dubspace" | "pinboard" | "taskspace" | "ide";
  world?: any;
  audioOn: boolean;
  clockOffset: number;
  liveControls: Record<string, { value: any; actor: string; at: number }>;
  cueSlots: Record<string, boolean>;
  cuePlaying: Record<string, boolean>;
  cueControls: Record<string, any>;
  chatFeed: ChatLine[];
  chatPresent: string[];
  chatDraft: string;
  observations: any[];
  observationsCollapsed: boolean;
  selectedObject: string;
  selectedTask?: string;
  taskExpanded: Record<string, boolean>;
  taskStatusFilter: Record<string, boolean>;
  pinboardView: PinboardView;
  pinboardViewports: Record<string, PinboardViewportPresence>;
  compileResult?: any;
};

type ChatLine = {
  kind: "text" | "said" | "said_to" | "said_as" | "emoted" | "posed" | "quoted" | "self_pointed" | "told" | "entered" | "left" | "looked" | "who" | "blocked_exit" | "taken" | "dropped" | "huh" | "dubspace_activity" | "dubspace_entered" | "dubspace_left" | "pinboard_activity" | "pinboard_entered" | "pinboard_left" | "system" | "error";
  actor?: string;
  from?: string;
  to?: string;
  style?: string;
  reason?: string;
  text?: string;
  ts?: number;
};

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

const state: AppState = {
  tab: "chat",
  audioOn: false,
  clockOffset: 0,
  liveControls: {},
  cueSlots: {},
  cuePlaying: {},
  cueControls: {},
  chatFeed: [],
  chatPresent: [],
  chatDraft: "",
  observations: [],
  observationsCollapsed: true,
  selectedObject: "",
  taskExpanded: {},
  taskStatusFilter: { open: true, claimed: true, in_progress: true, blocked: true, done: false },
  pinboardView: { x: 0, y: 0, scale: 1 },
  pinboardViewports: {}
};

let audio: DubAudio | undefined;
const sessionKey = "woo.session";
const chatHistoryKey = "woo.chat.history";
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
const taskStatuses = ["open", "claimed", "in_progress", "blocked", "done"] as const;
const directThrottle = new Map<string, number>();
const pendingDirect = new Map<string, (result: any) => void>();
const pendingFrameErrors = new Map<string, (error: any) => void>();
let pinboardNotesRefreshPending = false;
const pendingTaskSelections = new Set<string>();
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
let reconnectDelayMs = reconnectBaseDelayMs;
let reconnectTimer: number | undefined;
let heartbeatTimer: number | undefined;
let lastPongAt = 0;
let pinboardViewportTimer: number | undefined;
let pinboardViewAnimationTimer: number | undefined;
let lastPinboardViewportPublishAt = 0;
let lastPinboardViewportSent: PinNoteBox & { scale: number } | undefined;
const pinNoteClientZ = new Map<string, number>();
let chatHistory = loadChatHistory();
let chatHistoryCursor = chatHistory.length;
let chatHistoryDraft = "";

connect();
window.setInterval(pruneLiveControls, 700);
window.addEventListener("resize", () => {
  schedulePinboardViewportPublish();
  window.requestAnimationFrame(updatePinboardMapViewports);
});

function connect() {
  if (state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;
  socket.addEventListener("open", () => {
    reconnectDelayMs = reconnectBaseDelayMs;
    lastPongAt = Date.now();
    sendSocket(socket, { op: "auth", token: authToken() });
    startHeartbeat(socket);
  });
  socket.addEventListener("message", async (event) => {
    const frame = JSON.parse(event.data);
    if (frame.op === "pong") {
      lastPongAt = Date.now();
      return;
    }
    if (frame.op === "session") {
      state.actor = frame.actor;
      state.session = frame.session;
      storeSession(frame.session);
      await refresh();
      requestReplay(socket);
    }
    if (frame.op === "applied") {
      if (typeof frame.id === "string") pendingFrameErrors.delete(frame.id);
      const observations = frame.observations ?? [];
      const pinboardAnimations = capturePinboardAnimations(observations);
      const needsPinboardNotesRefresh = observations.some((observation: any) => isPinboardObservation(observation) && pinboardObservationNeedsNotesRefresh(String(observation?.type ?? "")));
      if (needsPinboardNotesRefresh) pinboardNotesRefreshPending = false;
      forgetLiveControls(observations);
      rememberTaskObservations(observations, typeof frame.id === "string" ? frame.id : undefined);
      for (const observation of observations) if (isChatObservation(observation)) receiveChatEvent(observation, false);
      state.observations.unshift({ seq: frame.seq, space: frame.space, observations, message: frame.message });
      trimObservations();
      rememberSeq(frame.space, frame.seq);
      await refresh();
      if (needsPinboardNotesRefresh) refreshPinboardNotes();
      animatePinboardNotes(pinboardAnimations);
    }
    if (frame.op === "event") {
      receiveLiveEvent(frame.observation);
    }
    if (frame.op === "result") {
      const handler = pendingDirect.get(frame.id);
      if (typeof frame.id === "string") pendingFrameErrors.delete(frame.id);
      if (handler) {
        pendingDirect.delete(frame.id);
        handler(frame.result);
      }
    }
    if (frame.op === "task") {
      state.observations.unshift({ task: frame.task, space: frame.space, observations: frame.observations });
      trimObservations();
      await refresh();
    }
    if (frame.op === "replay") {
      for (const entry of frame.entries ?? []) {
        state.observations.unshift({ seq: entry.seq, space: frame.space, replay: true, message: entry.message, error: entry.error ?? null });
        rememberSeq(frame.space, entry.seq);
      }
      trimObservations();
      await refresh();
    }
    if (frame.op === "error") {
      const errorHandler = typeof frame.id === "string" ? pendingFrameErrors.get(frame.id) : undefined;
      if (typeof frame.id === "string") {
        pendingDirect.delete(frame.id);
        pendingFrameErrors.delete(frame.id);
        pendingTaskSelections.delete(frame.id);
      }
      if (frame.error?.code === "E_NOSESSION") {
        clearSession();
        if (socket.readyState === WebSocket.OPEN) sendSocket(socket, { op: "auth", token: "guest:local" });
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
    pendingFrameErrors.clear();
    pendingTaskSelections.clear();
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

function authToken() {
  const session = readStorage(sessionKey);
  return session ? `session:${session}` : "guest:local";
}

function storeSession(session: string | undefined) {
  if (session) writeStorage(sessionKey, session);
}

function clearSession() {
  try {
    localStorage.removeItem(sessionKey);
  } catch {
    // Ignore storage failures; auth falls back to a fresh guest.
  }
}

function requestReplay(socket: WebSocket) {
  for (const space of Object.keys(state.world?.spaces ?? {})) {
    const from = Number(readStorage(`woo.lastSeq.${space}`) ?? "0") + 1;
    if (from > 1) sendSocket(socket, { op: "replay", id: crypto.randomUUID(), space, from, limit: 100 });
  }
}

function rememberSeq(space: string, seq: number) {
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

async function refresh() {
  const response = await fetch("/api/state", { headers: authHeaders() });
  if (!response.ok) return;
  state.world = adaptWorld(await response.json());
  if (!state.selectedObject || !state.world.objects?.[state.selectedObject]) state.selectedObject = defaultSelectedObject();
  state.clockOffset = Number(state.world.server_time ?? Date.now()) - Date.now();
  state.chatPresent = Array.isArray(state.world?.chat?.present) ? state.world.chat.present : state.chatPresent;
  syncTaskSelection();
  audio?.sync(effectiveDubspace(), state.clockOffset);
  render();
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
  world.taskspaceMeta = buildTaskspaceMeta(world);
  world.taskspace = projectTaskspace(world, world.taskspaceMeta);
  world.pinboardMeta = buildPinboardMeta(world);
  world.pinboard = projectPinboard(world, world.pinboardMeta);
  world.chatMeta = buildChatMeta(world);
  world.chat = projectChat(world, world.chatMeta);
  return world;
}

function installedCatalog(world: any, name: string): any | undefined {
  const installed = Array.isArray(world?.catalogs?.installed) ? world.catalogs.installed : [];
  return installed.find((record: any) => record?.alias === name || record?.catalog === name);
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

function objectName(world: any, id: string) {
  return String(world.objects?.[id]?.name ?? id);
}

function buildDubspaceMeta(world: any) {
  const catalog = installedCatalog(world, "dubspace");
  const space = firstObjectByParent(world, catalogClass(catalog, "$dubspace"));
  const byClass = (localName: string) => objectsByParent(world, catalogClass(catalog, localName), space);
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
  const ids = [meta.space, ...(meta.slots ?? []), meta.channel, meta.filter, meta.delay, meta.drum, meta.scene].filter(Boolean);
  return Object.fromEntries(ids.map((id: string) => [id, objectView(world, id)]).filter(([, view]) => view));
}

function buildTaskspaceMeta(world: any) {
  const catalog = installedCatalog(world, "taskspace");
  return {
    space: firstObjectByParent(world, catalogClass(catalog, "$taskspace")),
    taskClass: catalogClass(catalog, "$task")
  };
}

function projectTaskspace(world: any, meta: any) {
  const space = objectView(world, meta.space);
  const taskIds = objectsByParent(world, meta.taskClass);
  return {
    root_tasks: Array.isArray(space?.props?.root_tasks) ? space.props.root_tasks : [],
    tasks: Object.fromEntries(taskIds.map((id) => [id, objectView(world, id)]).filter(([, view]) => view))
  };
}

function buildPinboardMeta(world: any) {
  const catalog = installedCatalog(world, "pinboard");
  return {
    board: firstObjectByParent(world, catalogClass(catalog, "$pinboard"))
  };
}

function projectPinboard(world: any, meta: any) {
  const board = objectView(world, meta.board);
  const props = board?.props ?? {};
  const legacyNotes = Array.isArray(props.notes) && props.notes.length > 0 ? props.notes : undefined;
  const notes = legacyNotes ?? pinboardNotesFromContents(world, meta.board, props.layout);
  return {
    board,
    notes: normalizePinboardNotes(notes, state.world?.pinboard?.notes),
    present: Array.isArray(props.subscribers) ? props.subscribers.map(String) : [],
    palette: Array.isArray(props.palette) ? props.palette.map(String) : ["yellow", "blue", "green", "pink", "white"],
    viewport: props.viewport && typeof props.viewport === "object" && !Array.isArray(props.viewport) ? props.viewport : { w: 960, h: 560 }
  };
}

function pinboardNotesFromContents(world: any, boardId: string | undefined, layoutValue: any) {
  const contents = Array.isArray(world.objects?.[boardId ?? ""]?.contents) ? world.objects[boardId ?? ""].contents : [];
  const layout = layoutValue && typeof layoutValue === "object" && !Array.isArray(layoutValue) ? layoutValue : {};
  return contents.map((id: string) => {
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

function normalizePinboardNotes(notes: any[], previousNotes: any[] = []) {
  const previousById = new Map((Array.isArray(previousNotes) ? previousNotes : []).map((note) => [String(note?.id ?? ""), note]));
  return (Array.isArray(notes) ? notes : []).map((note) => ({
    ...note,
    id: String(note?.id ?? "")
  })).filter((note) => note.id).map((note) => {
    const previous = previousById.get(note.id);
    const hasText = note?.text !== undefined && note?.text !== null;
    return {
      ...note,
      text: hasText ? pinNoteText(note?.text) : pinNoteText(previous?.text),
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
  const occupied = rooms.find((id) => Array.isArray(world.objects?.[id]?.props?.subscribers) && world.objects[id].props.subscribers.includes(state.actor));
  const seededEntry = Object.values(demo?.seeds ?? {}).find((id) => typeof id === "string" && rooms.includes(id));
  const current = occupied ?? seededEntry ?? rooms[0];
  return { room: current, rooms };
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
  return state.world?.dubspaceMeta?.delay ?? Object.keys(state.world?.objects ?? {}).sort()[0] ?? "";
}

function dubspaceSpace() {
  return String(state.world?.dubspaceMeta?.space ?? "");
}

function taskspaceSpace() {
  return String(state.world?.taskspaceMeta?.space ?? "");
}

function pinboardSpace() {
  return String(state.world?.pinboardMeta?.board ?? "");
}

function chatRoom() {
  return String(state.world?.chatMeta?.room ?? "");
}

function call(space: string, target: string, verb: string, args: any[] = []) {
  const id = crypto.randomUUID();
  sendFrame({ op: "call", id, space, message: { target, verb, args } });
  return id;
}

function callWithError(space: string, target: string, verb: string, args: any[] = [], onError?: (error: any) => void) {
  const id = crypto.randomUUID();
  if (onError) pendingFrameErrors.set(id, onError);
  if (!sendFrame({ op: "call", id, space, message: { target, verb, args } })) pendingFrameErrors.delete(id);
  return id;
}

function direct(target: string, verb: string, args: any[] = [], onResult?: (result: any) => void, onError?: (error: any) => void) {
  const id = crypto.randomUUID();
  if (onResult) pendingDirect.set(id, onResult);
  if (onError) pendingFrameErrors.set(id, onError);
  if (!sendFrame({ op: "direct", id, target, verb, args })) {
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
  const base = state.world?.dubspace ?? {};
  const copy: Record<string, any> = Object.fromEntries(
    Object.entries(base).map(([id, obj]: [string, any]) => [
      id,
      {
        ...obj,
        props: { ...(obj?.props ?? {}) }
      }
    ])
  );
  const now = Date.now();
  for (const [key, item] of Object.entries(state.liveControls)) {
    if (now - item.at > 1600) {
      delete state.liveControls[key];
      continue;
    }
    const [target, name] = key.split(":");
    if (copy[target]) copy[target].props[name] = item.value;
  }
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
  state.liveControls[key] = { value, actor: state.actor ?? "", at: Date.now() };
  audio?.sync(effectiveDubspace(), state.clockOffset);
  const last = directThrottle.get(key) ?? 0;
  if (Date.now() - last < 35) return;
  directThrottle.set(key, Date.now());
  const space = dubspaceSpace();
  if (space) direct(space, "preview_control", [target, name, value]);
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
  // Pinboard side effects (window auto-open/close + state refresh) must fire
  // before the chat-observation branch, because pinboard_* types appear in
  // both observation lists and the chat branch returns early. The board is a
  // focus surface, not a place you travel to (catalogs/pinboard/DESIGN.md);
  // opening/closing the tab is the chat-side analogue of mounting the board.
  if (isPinboardObservation(observation)) {
    const pinboardAnimations = capturePinboardAnimations([observation]);
    const pinboardType = String(observation?.type ?? "");
    const needsNoteRefresh = pinboardObservationNeedsNotesRefresh(pinboardType);
    if (needsNoteRefresh) pinboardNotesRefreshPending = false;
    if (observation?.type === "pinboard_left") removePinboardViewport(String(observation?.actor ?? ""));
    if (String(observation?.actor ?? "") === state.actor) {
      if (observation?.type === "pinboard_entered" && state.tab !== "pinboard") {
        state.tab = "pinboard";
        render();
      } else if (observation?.type === "pinboard_left" && state.tab === "pinboard") {
        clearPinboardViewports();
        state.tab = "chat";
        render();
      }
    }
    const refreshed = refresh();
    void refreshed.then(() => {
      if (needsNoteRefresh) refreshPinboardNotes();
      animatePinboardNotes(pinboardAnimations);
    });
  }
  if (isDubspaceObservation(observation)) {
    if (String(observation?.actor ?? "") === state.actor) {
      if (observation?.type === "dubspace_entered") {
        addDubspaceOperator(state.actor);
        if (state.tab !== "dubspace") {
          state.tab = "dubspace";
          render();
        }
      } else if (observation?.type === "dubspace_left") {
        removeDubspaceOperator(state.actor);
        if (state.tab === "dubspace") {
          state.tab = "chat";
          render();
        }
      }
    }
    void refresh();
  }
  if (isChatObservation(observation)) {
    receiveChatEvent(observation);
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
  const key = liveKey(observation.target, observation.name);
  state.liveControls[key] = { value: observation.value, actor: observation.actor, at: Date.now() };
  const input = findControlInput(String(observation.target), String(observation.name));
  if (input && document.activeElement !== input) setControlInputValue(input, observation.value);
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

function forgetLiveControls(observations: any[]) {
  for (const obs of observations) {
    if (obs.type === "control_changed" && obs.target && obs.name) delete state.liveControls[liveKey(String(obs.target), String(obs.name))];
  }
}

function rememberTaskObservations(observations: any[], frameId?: string) {
  const shouldSelectCreatedTask = Boolean(frameId && pendingTaskSelections.delete(frameId));
  for (const obs of observations) {
    if (obs?.type === "task_created" && typeof obs.task === "string") {
      if (shouldSelectCreatedTask) state.selectedTask = obs.task;
      state.taskExpanded[obs.task] = true;
      if (typeof obs.parent === "string") state.taskExpanded[obs.parent] = true;
    }
    if (obs?.type === "subtask_added" && typeof obs.parent === "string") state.taskExpanded[obs.parent] = true;
    if (obs?.type === "task_moved" && typeof obs.to_parent === "string") state.taskExpanded[obs.to_parent] = true;
  }
}

function syncTaskSelection() {
  const taskspace = state.world?.taskspace;
  const tasks = taskspace?.tasks ?? {};
  const roots = Array.isArray(taskspace?.root_tasks) ? taskspace.root_tasks : [];
  const active = activeTaskStatuses();
  if (state.selectedTask && tasks[state.selectedTask] && taskMatchesStatus(tasks[state.selectedTask], active)) return;
  state.selectedTask = firstMatchingTask(roots, tasks, active);
}

function pruneLiveControls() {
  const before = Object.keys(state.liveControls).length;
  void effectiveDubspace();
  if (Object.keys(state.liveControls).length === before) return;
  audio?.sync(effectiveDubspace(), state.clockOffset);
  if (state.tab === "dubspace") render();
}

function render() {
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
        ${navButton("taskspace", "Taskspace")}
        ${navButton("ide", "IDE")}
        <a class="github-link" href="https://github.com/hughpyle/woo" target="_blank" rel="noopener noreferrer" aria-label="woo on GitHub" title="woo on GitHub">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
        </a>
      </aside>
      <main class="main">
        ${state.tab === "dubspace" ? renderDubspace() : ""}
        ${state.tab === "pinboard" ? renderPinboard() : ""}
        ${state.tab === "taskspace" ? renderTaskspace() : ""}
        ${state.tab === "chat" ? renderChat() : ""}
        ${state.tab === "ide" ? renderIde() : ""}
      </main>
      ${renderObservationsPanel()}
    </div>
  `;

  bindCommon();
  if (state.tab === "dubspace") bindDubspace();
  if (state.tab === "taskspace") bindTaskspace();
  if (state.tab === "pinboard") bindPinboard();
  if (state.tab === "chat") bindChat();
  if (state.tab === "ide") bindIde();
  if (!restoreRenderFocus(focus) && state.tab === "chat") focusChatInput();
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
    </aside>
  `;
}

function bindCommon() {
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset.tab as AppState["tab"];
      if (state.tab === "dubspace" && next !== "dubspace") leaveDubspace();
      if (state.tab === "pinboard" && next !== "pinboard") leavePinboard();
      state.tab = next;
      render();
      if (next === "dubspace") enterDubspace();
      if (next === "pinboard") enterPinboard();
    });
  });
  document.querySelector<HTMLButtonElement>("[data-observations-toggle]")?.addEventListener("click", () => {
    state.observationsCollapsed = !state.observationsCollapsed;
    render();
  });
}

function renderDubspace() {
  const dub = effectiveDubspace();
  const meta = state.world?.dubspaceMeta ?? {};
  const space = meta.space ? dub[meta.space] : null;
  const operators = dubspaceOperators();
  const inSpace = Boolean(state.actor && operators.includes(state.actor));
  const slots = Array.isArray(meta.slots) ? meta.slots : [];
  const filter = dub[meta.filter]?.props ?? {};
  const delay = dub[meta.delay]?.props ?? {};
  const drum = dub[meta.drum]?.props ?? {};
  const pattern = normalizePattern(drum.pattern);
  if (!space) {
    return `
      <section class="toolbar"><h1>Dubspace</h1></section>
      <section class="panel"><p class="empty-state">No dubspace catalog instance is installed.</p></section>
    `;
  }
  if (!inSpace) {
    return `
      <section class="toolbar">
        <h1>${escapeHtml(space.name ?? "Dubspace")}</h1>
        <button data-dubspace-enter ${canSendDirect() ? "" : "disabled"}>Enter</button>
      </section>
      <section class="dubspace-layout">
        <div class="panel">
          <p>${escapeHtml(String(space.props?.description ?? "Enter the dubspace to work at the controls."))}</p>
        </div>
        ${renderDubspacePresence(operators)}
      </section>
    `;
  }
  return `
    <section class="toolbar dubspace-toolbar">
      <h1>${escapeHtml(space.name ?? "Dubspace")}</h1>
      <button data-dubspace-leave>Leave</button>
      <button class="${state.audioOn ? "active" : ""}" data-audio aria-pressed="${state.audioOn}">Audio ${state.audioOn ? "On" : "Off"}</button>
      <button data-save-scene>Save Scene</button>
      <button data-recall-scene>Recall Scene</button>
    </section>
    <section class="dubspace-layout">
      <div class="dubspace-work">
        <div class="grid">
          <article class="panel loop-console-panel">
            <div class="panel-head"><h2>Loops</h2></div>
            <div class="loop-console">${slots.map((id: string, index: number) => renderLoopStrip(id, index + 1, dub)).join("")}${renderFilterStrip(filter)}</div>
          </article>
          <article class="panel">
            <h2>Delay</h2>
            ${slider(meta.delay, "send", delay.send ?? 0.3)}
            ${slider(meta.delay, "time", delay.time ?? 0.25)}
            ${slider(meta.delay, "feedback", delay.feedback ?? 0.35)}
            ${slider(meta.delay, "wet", delay.wet ?? 0.4)}
          </article>
          <article class="panel sequencer">
            <div class="panel-head">
              <h2>Percussion</h2>
              <button data-transport="${drum.playing ? "stop" : "start"}">${drum.playing ? "Stop" : "Start"}</button>
            </div>
            <label>BPM <input data-tempo type="range" min="60" max="200" step="1" value="${escapeHtml(String(drum.bpm ?? 118))}"><span>${escapeHtml(String(drum.bpm ?? 118))}</span></label>
            <div class="steps">
              ${drumVoices.map((voice) => renderStepRow(voice.id, voice.label, pattern[voice.id])).join("")}
            </div>
          </article>
        </div>
      </div>
      ${renderDubspacePresence(operators)}
    </section>
  `;
}

function renderDubspacePresence(operators: string[]) {
  return `
    <aside class="panel dubspace-presence">
      <h2>At the controls</h2>
      <div class="presence-list">
        ${operators.map((id: string) => `<button disabled>${escapeHtml(actorLabel(id))}<span>${escapeHtml(id)}</span></button>`).join("") || "<p>No one is at the controls.</p>"}
      </div>
    </aside>
  `;
}

function dubspaceOperators(): string[] {
  const space = dubspaceSpace();
  const raw = space ? state.world?.dubspace?.[space]?.props?.operators : [];
  return Array.isArray(raw) ? raw.map(String) : [];
}

function renderFilterStrip(filter: any) {
  const cutoff = filter.cutoff ?? 1000;
  const target = state.world?.dubspaceMeta?.filter ?? "";
  return `
    <div class="filter-strip">
      <div class="loop-strip-head">
        <strong>F</strong>
        <span>Filter</span>
      </div>
      <input class="vertical-fader" aria-label="Filter cutoff" data-control data-target="${escapeHtml(target)}" data-name="cutoff" type="range" min="80" max="5000" step="1" value="${escapeHtml(String(cutoff))}">
      <span class="fader-readout">${escapeHtml(String(Math.round(Number(cutoff))))} Hz</span>
    </div>
  `;
}

function renderLoopStrip(id: string, index: number, dub: any) {
  const slot = dub[id]?.props ?? {};
  const cue = state.cueSlots[id] === true;
  const serverPlaying = state.world?.dubspace?.[id]?.props?.playing === true;
  const buttonPlaying = cue ? state.cuePlaying[id] === true : serverPlaying;
  const freq = slot.freq ?? defaultLoopFreq(index);
  const pitch = loopPitch(freq);
  return `
    <div class="loop-strip ${slot.playing ? "playing" : ""} ${cue ? "cue-active" : ""}">
      <div class="loop-strip-head">
        <strong>${index}</strong>
        <span>${escapeHtml(String(dub[id]?.name ?? id))}</span>
      </div>
      <button data-loop="${escapeHtml(id)}" data-playing="${buttonPlaying ? "true" : "false"}">${buttonPlaying ? "Stop" : "Start"}</button>
      <input class="vertical-fader" aria-label="Loop ${index} gain" data-control data-target="${escapeHtml(id)}" data-name="gain" type="range" min="0" max="1" step="0.01" value="${escapeHtml(String(slot.gain ?? 0.75))}">
      <div class="pitch-switch" style="--pitch-angle: ${pitch.angle}deg">
        <div class="pitch-dial" data-pitch-dial aria-hidden="true"><span class="pitch-pointer"></span></div>
        <input class="pitch-switch-input" aria-label="Loop ${index} pitch" data-control data-pitch-input data-target="${escapeHtml(id)}" data-name="freq" type="range" min="${PITCH_MIN_SEMITONE}" max="${PITCH_MAX_SEMITONE}" step="1" value="${pitch.semitone}">
        <div class="pitch-readout"><strong data-pitch-note>${escapeHtml(pitch.note)}</strong><span data-pitch-hz>${escapeHtml(String(Math.round(pitch.freq)))} Hz</span></div>
      </div>
      <button class="cue-button ${cue ? "active" : ""}" data-cue-slot="${escapeHtml(id)}" aria-pressed="${cue}">CUE</button>
    </div>
  `;
}

function slider(obj: string, prop: string, value: number) {
  return `<label>${escapeHtml(prop)} <input data-control data-target="${escapeHtml(obj)}" data-name="${escapeHtml(prop)}" type="range" min="0" max="1" step="0.01" value="${escapeHtml(String(value))}"></label>`;
}

function bindDubspace() {
  document.querySelector<HTMLButtonElement>("[data-dubspace-enter]")?.addEventListener("click", enterDubspace);
  document.querySelector<HTMLButtonElement>("[data-dubspace-leave]")?.addEventListener("click", () => leaveDubspace());
  document.querySelector<HTMLButtonElement>("[data-audio]")?.addEventListener("click", async () => {
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
  document.querySelectorAll<HTMLButtonElement>("[data-loop]").forEach((button) => {
    button.addEventListener("click", () => {
      const slot = button.dataset.loop!;
      const playing = button.dataset.playing === "true";
      if (state.cueSlots[slot]) {
        state.cuePlaying[slot] = !playing;
        audio?.sync(effectiveDubspace(), state.clockOffset);
        render();
        return;
      }
      const space = dubspaceSpace();
      if (space) call(space, space, playing ? "stop_loop" : "start_loop", [slot]);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-cue-slot]").forEach((button) => {
    button.addEventListener("click", () => {
      const slot = button.dataset.cueSlot!;
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
  });
  document.querySelectorAll<HTMLInputElement>("[data-control]").forEach((input) => {
    input.addEventListener("input", () => {
      const { target, name } = controlBinding(input);
      syncPitchInput(input);
      const value = controlInputValue(input);
      if (state.cueSlots[target]) {
        setCueControl(target, name, value);
        return;
      }
      sendPreviewControl(target, name, value);
    });
    input.addEventListener("change", () => {
      const { target, name } = controlBinding(input);
      syncPitchInput(input);
      const value = controlInputValue(input);
      if (state.cueSlots[target]) {
        setCueControl(target, name, value);
        return;
      }
      const space = dubspaceSpace();
      if (space) call(space, space, "set_control", [target, name, value]);
    });
  });
  document.querySelectorAll<HTMLElement>("[data-pitch-dial]").forEach((dial) => bindPitchDial(dial));
  document.querySelector<HTMLButtonElement>("[data-transport]")?.addEventListener("click", (event) => {
    const mode = (event.currentTarget as HTMLButtonElement).dataset.transport;
    const space = dubspaceSpace();
    if (space) call(space, space, mode === "stop" ? "stop_transport" : "start_transport", []);
  });
  document.querySelector<HTMLInputElement>("[data-tempo]")?.addEventListener("change", (event) => {
    const space = dubspaceSpace();
    if (space) call(space, space, "set_tempo", [Number((event.currentTarget as HTMLInputElement).value)]);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const [voice, step] = button.dataset.step!.split(":");
      const space = dubspaceSpace();
      if (space) call(space, space, "set_drum_step", [voice, Number(step), button.dataset.enabled !== "true"]);
    });
  });
  document.querySelector<HTMLButtonElement>("[data-save-scene]")?.addEventListener("click", () => {
    const space = dubspaceSpace();
    if (space) call(space, space, "save_scene", [`Scene ${new Date().toLocaleTimeString()}`]);
  });
  document.querySelector<HTMLButtonElement>("[data-recall-scene]")?.addEventListener("click", () => {
    const space = dubspaceSpace();
    const scene = state.world?.dubspaceMeta?.scene;
    if (space && scene) call(space, space, "recall_scene", [scene]);
  });
}

function enterDubspace() {
  const space = dubspaceSpace();
  if (!space || !canSendDirect()) return;
  direct(space, "enter", [], (result) => {
    setDubspaceOperators(result);
    if (state.tab === "dubspace") render();
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
    setDubspaceOperators(result);
    done?.();
    if (state.tab === "dubspace") render();
  });
}

function setDubspaceOperators(result: any) {
  const space = dubspaceSpace();
  if (!Array.isArray(result) || !space || !state.world?.dubspace?.[space]) return;
  state.world.dubspace[space].props.operators = result.map(String);
  if (state.world.objects?.[space]?.props) state.world.objects[space].props.operators = state.world.dubspace[space].props.operators;
}

function addDubspaceOperator(actor: string | undefined) {
  const space = dubspaceSpace();
  if (!actor || !space || !state.world?.dubspace?.[space]) return;
  const operators = dubspaceOperators();
  if (operators.includes(actor)) return;
  state.world.dubspace[space].props.operators = [...operators, actor];
  if (state.world.objects?.[space]?.props) state.world.objects[space].props.operators = state.world.dubspace[space].props.operators;
}

function removeDubspaceOperator(actor: string | undefined) {
  const space = dubspaceSpace();
  if (!actor || !space || !state.world?.dubspace?.[space]) return;
  state.world.dubspace[space].props.operators = dubspaceOperators().filter((item) => item !== actor);
  if (state.world.objects?.[space]?.props) state.world.objects[space].props.operators = state.world.dubspace[space].props.operators;
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
  const room = chatRoom();
  if (!room || !canSendDirect()) return;
  direct(room, "enter", [], (result) => {
    setCurrentChatRoom(room);
    setChatPresent(result);
    if (result?.look_deferred === true) direct(room, "look", [], applyLookResult, receiveChatError);
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
  const kind = chatLineKind(observation);
  const presentActors = Array.isArray(observation.present_actors) ? observation.present_actors.map(String) : [];
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
  pushChatLine({
    kind,
    actor: typeof observation.actor === "string" ? observation.actor : undefined,
    from: typeof observation.from === "string" ? observation.from : undefined,
    to: typeof observation.to === "string" ? observation.to : undefined,
    style: typeof observation.style === "string" ? observation.style : undefined,
    reason: typeof observation.reason === "string" ? observation.reason : undefined,
    text: typeof observation.text === "string" ? observation.text : chatSystemText(observation),
    ts: typeof observation.ts === "number" ? observation.ts : undefined
  }, shouldRender);
}

function receiveChatError(error: any) {
  pushChatLine({
    kind: "error",
    text: chatErrorText(error),
    ts: Date.now()
  });
}

function chatErrorText(error: any): string {
  if (typeof error?.message === "string" && error.message.trim()) return error.message;
  if (typeof error?.code === "string" && error.code.trim()) return error.code;
  return "That didn't work.";
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
  return undefined;
}

function pushChatLine(line: ChatLine, shouldRender = true) {
  state.chatFeed = [...state.chatFeed, line].slice(-160);
  if (shouldRender && state.tab === "chat") render();
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
  state.chatDraft = value;
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
  if (Array.isArray(result?.present_actors)) state.chatPresent = result.present_actors.map(String);
}

function setCurrentChatRoom(room: string) {
  if (state.world?.chatMeta) {
    state.world.chatMeta.room = room;
    state.world.chat = projectChat(state.world, state.world.chatMeta);
  }
  if (state.actor && !state.chatPresent.includes(state.actor)) state.chatPresent = [...state.chatPresent, state.actor];
}

function renderChat() {
  const room = state.world?.chat?.room;
  const present = state.chatPresent;
  const inRoom = Boolean(state.actor && present.includes(state.actor));
  if (!inRoom) {
    const canEnter = canSendDirect();
    return `
      <section class="toolbar">
        <h1>${escapeHtml(room?.name ?? "Room")}</h1>
        <button data-chat-enter ${canEnter ? "" : "disabled"}>Enter</button>
      </section>
      <section class="chat-layout solo">
        <div class="panel chat-empty-panel">
          <p>${escapeHtml(canEnter ? room?.description ?? "Enter the room to chat." : "Connecting...")}</p>
        </div>
      </section>
    `;
  }
  return `
    <section class="toolbar">
      <h1>${escapeHtml(room?.name ?? "Room")}</h1>
      <button data-chat-leave>Leave</button>
      <button data-chat-look>Look</button>
    </section>
    <section class="chat-layout">
      <div class="panel chat-panel">
        <div class="chat-feed" aria-live="polite">
          ${state.chatFeed.map(renderChatLine).join("") || `<div class="chat-empty">${escapeHtml(room?.description ?? "No chat events yet.")}</div>`}
        </div>
        <form class="chat-form" data-chat-form>
          <input data-chat-input autocomplete="off" placeholder="say something — or :waves, look cockatoo, tell guest_2 hi" value="${escapeHtml(state.chatDraft)}" />
          <button>Send</button>
        </form>
      </div>
      <aside class="panel chat-presence">
        <h2>Present</h2>
        <div class="presence-list">
          ${present.map((id: string) => `<button data-chat-recipient="${escapeHtml(id)}">${escapeHtml(actorLabel(id))}<span>${escapeHtml(id)}</span></button>`).join("") || "<p>No actors present.</p>"}
        </div>
      </aside>
    </section>
  `;
}

function renderChatLine(line: ChatLine) {
  const time = line.ts ? new Date(line.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  if (line.kind === "said") {
    return `<div class="chat-line said"><span class="chat-time">${escapeHtml(time)}</span><strong>${escapeHtml(actorLabel(line.actor))}</strong><span>${escapeHtml(line.text ?? "")}</span></div>`;
  }
  if (line.kind === "said_to") {
    return `<div class="chat-line said"><span class="chat-time">${escapeHtml(time)}</span><strong>${escapeHtml(actorLabel(line.actor))} [to ${escapeHtml(actorLabel(line.to))}]</strong><span>${escapeHtml(line.text ?? "")}</span></div>`;
  }
  if (line.kind === "said_as") {
    return `<div class="chat-line said"><span class="chat-time">${escapeHtml(time)}</span><strong>${escapeHtml(actorLabel(line.actor))} [${escapeHtml(line.style ?? "says")}]</strong><span>${escapeHtml(line.text ?? "")}</span></div>`;
  }
  if (line.kind === "emoted") {
    return `<div class="chat-line emote"><span class="chat-time">${escapeHtml(time)}</span><span>${escapeHtml(actorLabel(line.actor))} ${escapeHtml(line.text ?? "")}</span></div>`;
  }
  if (line.kind === "posed") {
    return `<div class="chat-line emote"><span class="chat-time">${escapeHtml(time)}</span><span>[${escapeHtml(actorLabel(line.actor))} ${escapeHtml(line.text ?? "")}]</span></div>`;
  }
  if (line.kind === "quoted") {
    return `<div class="chat-line said"><span class="chat-time">${escapeHtml(time)}</span><strong>${escapeHtml(actorLabel(line.actor))} |</strong><span>${escapeHtml(line.text ?? "")}</span></div>`;
  }
  if (line.kind === "self_pointed") {
    return `<div class="chat-line emote"><span class="chat-time">${escapeHtml(time)}</span><span>${escapeHtml(actorLabel(line.actor))} &lt;- ${escapeHtml(line.text ?? "")}</span></div>`;
  }
  if (line.kind === "told") {
    return `<div class="chat-line told"><span class="chat-time">${escapeHtml(time)}</span><strong>${escapeHtml(actorLabel(line.from))} -> ${escapeHtml(actorLabel(line.to))}</strong><span>${escapeHtml(line.text ?? "")}</span></div>`;
  }
  if (line.kind === "huh") {
    return `<div class="chat-line system"><span class="chat-time">${escapeHtml(time)}</span><span>I don't understand "${escapeHtml(line.text ?? "")}".</span></div>`;
  }
  if (line.kind === "error") {
    return `<div class="chat-line error"><span class="chat-time">${escapeHtml(time)}</span><span>${escapeHtml(line.text ?? "That didn't work.")}</span></div>`;
  }
  if (line.kind === "entered" || line.kind === "left") {
    const text = line.text ?? `${actorLabel(line.actor)} ${line.kind === "entered" ? "entered" : "left"}.`;
    return `<div class="chat-line system"><span class="chat-time">${escapeHtml(time)}</span><span>${escapeHtml(text)}</span></div>`;
  }
  return `<div class="chat-line system"><span class="chat-time">${escapeHtml(time)}</span><span>${escapeHtml(line.text ?? "")}</span></div>`;
}

function bindChat() {
  const chatInput = document.querySelector<HTMLInputElement>("[data-chat-input]");
  chatInput?.addEventListener("keydown", (event) => navigateChatHistory(event, chatInput));
  chatInput?.addEventListener("input", (event) => {
    state.chatDraft = (event.currentTarget as HTMLInputElement).value;
    chatHistoryCursor = chatHistory.length;
    chatHistoryDraft = state.chatDraft;
  });
  document.querySelector<HTMLFormElement>("[data-chat-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLInputElement>("[data-chat-input]");
    const text = input?.value.trim() ?? "";
    if (!text) return;
    rememberChatInput(text);
    state.chatDraft = "";
    sendChatInput(text);
    if (input) {
      input.value = "";
      input.focus();
    }
  });
  document.querySelector<HTMLButtonElement>("[data-chat-enter]")?.addEventListener("click", enterChat);
  document.querySelector<HTMLButtonElement>("[data-chat-leave]")?.addEventListener("click", () => {
    const room = chatRoom();
    if (!room) return;
    direct(room, "leave", [], (result) => {
      setChatPresent(result);
      if (state.tab === "chat") render();
    }, receiveChatError);
  });
  document.querySelector<HTMLButtonElement>("[data-chat-look]")?.addEventListener("click", refreshChatLook);
  document.querySelectorAll<HTMLButtonElement>("[data-chat-recipient]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.querySelector<HTMLInputElement>("[data-chat-input]");
      if (!input) return;
      state.chatDraft = `/tell ${button.dataset.chatRecipient} `;
      input.value = state.chatDraft;
      input.focus();
    });
  });
  scrollChatFeedToEnd();
}

function scrollChatFeedToEnd() {
  const feed = document.querySelector<HTMLElement>(".chat-feed");
  if (!feed) return;
  feed.scrollTop = feed.scrollHeight;
}

function focusChatInput() {
  window.requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>("[data-chat-input]");
    input?.focus();
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  });
}

function sendChatInput(text: string) {
  const room = chatRoom();
  if (!room) return;
  direct(room, "command_plan", [text], (plan) => executeChatPlan(plan, text), receiveChatError);
}

function executeChatPlan(plan: any, originalText: string) {
  if (!plan || plan.ok !== true) return;
  const route = String(plan.route ?? "");
  const target = String(plan.target ?? "");
  const verb = String(plan.verb ?? "");
  const args = Array.isArray(plan.args) ? plan.args : [];
  if (!target || !verb) return;
  if (route === "sequenced") {
    const space = String(plan.space ?? chatRoom());
    if (space) callWithError(space, target, verb, args, receiveChatError);
    return;
  }
  if (route === "direct") {
    direct(target, verb, args, (result) => renderChatCommandResult(plan, result, originalText), receiveChatError);
  }
}

function renderChatCommandResult(plan: any, result: any, originalText: string) {
  const verb = String(plan?.verb ?? "");
  const target = String(plan?.target ?? "");
  if (verb === "enter" && target === dubspaceSpace()) {
    setDubspaceOperators(result);
    state.tab = "dubspace";
    void refresh();
    render();
    return;
  }
  if (verb === "enter" && target === pinboardSpace()) {
    setPinboardPresent(result);
    state.tab = "pinboard";
    void refresh();
    render();
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
  if (result && typeof result === "object" && typeof result.room === "string") {
    const room = result.room;
    setCurrentChatRoom(room);
    setChatPresent(result);
    if (result.look_deferred === true) direct(room, "look", [], applyLookResult, receiveChatError);
    void refresh();
    return;
  }
  if (verb === "enter") {
    if (target) setCurrentChatRoom(target);
    setChatPresent(result);
    if (result?.look_deferred === true && target) direct(target, "look", [], applyLookResult, receiveChatError);
    void refresh();
    return;
  }
  if (verb === "take" || verb === "drop") {
    void refresh();
    return;
  }
  void originalText;
  void result;
}

function refreshChatLook() {
  const room = chatRoom();
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
  if (lookedId && lookedId !== chatRoom()) return;
  state.chatPresent = present;
}

function actorLabel(id: string | undefined) {
  if (!id) return "unknown";
  return String(state.world?.objects?.[id]?.name ?? id);
}

function renderPinboard() {
  const pinboard = state.world?.pinboard;
  const board = pinboard?.board;
  const present = Array.isArray(pinboard?.present) ? pinboard.present : [];
  const inBoard = Boolean(state.actor && present.includes(state.actor));
  const viewport = pinboard?.viewport ?? { w: 960, h: 560 };
  const width = pinNoteNumber(viewport.w, 960);
  const height = pinNoteNumber(viewport.h, 560);
  const notes = Array.isArray(pinboard?.notes) ? pinboard.notes : [];
  const view = normalizedPinboardView();
  if (!board) {
    return `
      <section class="toolbar"><h1>Pinboard</h1></section>
      <section class="panel"><p class="empty-state">No pinboard catalog instance is installed.</p></section>
    `;
  }
  return `
    <section class="toolbar pinboard-toolbar">
      <h1>${escapeHtml(board.name ?? "Pinboard")}</h1>
      ${inBoard ? `<button data-pinboard-leave>Leave</button>` : `<button data-pinboard-enter ${canSendDirect() ? "" : "disabled"}>Enter</button>`}
    </section>
    <section class="pinboard-layout">
      <div class="pinboard-work">
        ${inBoard ? renderPinboardCreate(pinboard.palette) : ""}
        <div class="panel pinboard-stage-panel">
          <div class="pinboard-stage" data-pinboard-stage style="${pinboardStageStyle(width, height, view)}">
            <div class="pinboard-zoom-controls" aria-label="Pinboard zoom controls">
              <button data-pinboard-zoom="out" aria-label="Zoom out">-</button>
              <span data-pinboard-zoom-label>${Math.round(view.scale * 100)}%</span>
              <button data-pinboard-zoom="in" aria-label="Zoom in">+</button>
            </div>
            <div class="pinboard-canvas" data-pinboard-canvas style="${pinboardViewStyle(view)}">
              ${notes.map((note: any) => renderPinNote(note, inBoard, pinboard.palette)).join("") || `<div class="pinboard-empty">${escapeHtml(inBoard ? "Add a note to start." : "Enter the pinboard to add or move notes.")}</div>`}
            </div>
          </div>
        </div>
      </div>
      <aside class="panel pinboard-presence">
        <h2>Presence</h2>
        <div data-pinboard-map-shell>${renderPinboardMap(notes, present, width, height)}</div>
      </aside>
    </section>
  `;
}

function renderPinboardMap(notes: any[], present: string[], width: number, height: number) {
  const model = pinboardMapModel(notes, present, width, height);
  return `
    <div class="pinboard-map" data-pinboard-map data-min-x="${roundCss(model.minX)}" data-min-y="${roundCss(model.minY)}" data-span-x="${roundCss(model.spanX)}" data-span-y="${roundCss(model.spanY)}" aria-label="Pinboard overview">
      ${renderPinboardMapNotes(notes, model)}
      ${renderPinboardMapViewports(present, model, width, height)}
      ${present.length === 0 ? `<p class="pinboard-map-empty">No one is here.</p>` : ""}
    </div>
  `;
}

function renderPinboardMapNotes(notes: any[], model: PinboardMapModel) {
  return notes.map((note: any) => {
    const id = String(note?.id ?? "");
    const color = pinNoteColor(note, state.world?.pinboard?.palette);
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
  return {
    x: pinNoteNumber(note?.x, 40),
    y: pinNoteNumber(note?.y, 40),
    w: pinNoteNumber(note?.w, 180),
    h: pinNoteNumber(note?.h, 110)
  };
}

function pinboardStageStyle(width: number, height: number, view = normalizedPinboardView()) {
  return `--pinboard-w:${width}px; --pinboard-h:${height}px; ${pinboardGridStyle(view)}`;
}

function pinboardGridStyle(view = normalizedPinboardView()) {
  const grid = PINBOARD_GRID_SIZE * view.scale;
  return `--pinboard-grid-size:${roundCss(grid)}px; --pinboard-grid-x:${roundCss(mod(view.x, grid))}px; --pinboard-grid-y:${roundCss(mod(view.y, grid))}px;`;
}

function renderPinboardCreate(palette: string[]) {
  return `
    <form class="panel pinboard-create" data-pinboard-create>
      <textarea data-pinboard-new-text placeholder="New note"></textarea>
      <select data-pinboard-new-color>${pinboardPalette(palette).map((color) => `<option value="${escapeHtml(color)}">${escapeHtml(color)}</option>`).join("")}</select>
      <button>Add Note</button>
    </form>
  `;
}

function renderPinNote(note: any, editable: boolean, palette: string[]) {
  const id = String(note?.id ?? "");
  const x = pinNoteNumber(note?.x, 40);
  const y = pinNoteNumber(note?.y, 40);
  const w = pinNoteNumber(note?.w, 180);
  const h = pinNoteNumber(note?.h, 110);
  const serverZ = pinNoteNumber(note?.z, 1);
  const clientZ = pinNoteClientZ.get(id) ?? 0;
  const z = Math.max(serverZ, clientZ);
  const color = pinNoteColor(note, palette);
  const text = pinNoteText(note?.text);
  const meta = pinNoteMeta(note);
  const aria = [text || "Pinboard note", meta.replace(/\n/g, "; ")].filter(Boolean).join("; ");
  const action = pinNoteAction(note, editable);
  const writable = pinNoteWritable(note, editable);
  return `
    <article class="pin-note pin-note-${escapeHtml(color)}" data-pin-note="${escapeHtml(id)}" data-note-meta="${escapeHtml(meta)}" title="${escapeHtml(meta)}" aria-label="${escapeHtml(aria)}" data-x="${x}" data-y="${y}" data-w="${w}" data-h="${h}" style="left:${x}px; top:${y}px; width:${w}px; height:${h}px; z-index:${z}">
      <div class="pin-note-head">
        <button class="pin-note-drag" data-pin-note-drag ${editable ? "" : "disabled"} aria-label="Move note">::</button>
        <select data-pin-note-color="${escapeHtml(id)}" ${writable ? "" : "disabled"}>${pinboardPalette(palette).map((item) => `<option value="${escapeHtml(item)}" ${item === color ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select>
        ${action ? `<button data-pin-note-action="${escapeHtml(action.verb)}" data-pin-note-id="${escapeHtml(id)}" aria-label="${escapeHtml(action.label)}">${escapeHtml(action.text)}</button>` : ""}
      </div>
      <textarea data-pin-note-text="${escapeHtml(id)}" data-original="${escapeHtml(text)}" ${writable ? "" : "readonly"}>${escapeHtml(text)}</textarea>
      <button class="pin-note-resize" data-pin-note-resize ${editable ? "" : "disabled"} aria-label="Resize note"></button>
    </article>
  `;
}

function pinNoteWritable(note: any, editable: boolean): boolean {
  if (!editable || !state.actor) return false;
  const owner = typeof note?.owner === "string" ? note.owner : typeof note?.author === "string" ? note.author : "";
  const writers = Array.isArray(note?.writers) ? note.writers.map(String) : [];
  return owner === state.actor || writers.includes(state.actor);
}

function pinNoteAction(note: any, editable: boolean): { verb: "take" | "eject"; label: string; text: string } | null {
  if (!editable || !state.actor) return null;
  const owner = typeof note?.owner === "string" ? note.owner : typeof note?.author === "string" ? note.author : "";
  const boardOwner = typeof state.world?.pinboard?.board?.owner === "string" ? state.world.pinboard.board.owner : "";
  if (owner === state.actor) return { verb: "take", label: "Take note", text: "x" };
  if (boardOwner === state.actor) return { verb: "eject", label: "Eject note", text: "x" };
  return null;
}

function pinNoteText(value: any): string {
  if (Array.isArray(value)) return value.map((line) => typeof line === "string" ? line : String(line ?? "")).join("\n");
  return typeof value === "string" ? value : "";
}

function pinNoteColor(note: any, palette: any): string {
  const colors = pinboardPalette(palette);
  if (typeof note?.color === "string" && colors.includes(note.color)) return note.color;
  if (note?.color == null) return "white";
  return colors[0] ?? "white";
}

function pinNoteMeta(note: any): string {
  const author = typeof note?.author === "string" ? actorLabel(note.author) : "unknown";
  const created = pinNoteTimestamp(note?.created_at);
  const updatedBy = typeof note?.updated_by === "string" ? actorLabel(note.updated_by) : "";
  const updated = pinNoteTimestamp(note?.updated_at);
  const lines = [`Added by ${author}${created ? ` at ${created}` : ""}`];
  if (updatedBy && (note?.updated_by !== note?.author || note?.updated_at !== note?.created_at)) {
    lines.push(`Last edited by ${updatedBy}${updated ? ` at ${updated}` : ""}`);
  }
  return lines.join("\n");
}

function pinNoteTimestamp(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
}

function bindPinboard() {
  document.querySelector<HTMLButtonElement>("[data-pinboard-enter]")?.addEventListener("click", enterPinboard);
  document.querySelector<HTMLButtonElement>("[data-pinboard-leave]")?.addEventListener("click", () => {
    leavePinboard(() => {
      state.tab = "chat";
      render();
    });
  });
  document.querySelector<HTMLFormElement>("[data-pinboard-create]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const textInput = document.querySelector<HTMLTextAreaElement>("[data-pinboard-new-text]");
    const colorInput = document.querySelector<HTMLSelectElement>("[data-pinboard-new-color]");
    const text = textInput?.value.trim() ?? "";
    if (!text) return;
    const placement = newPinNotePlacement();
    pinboardCall("add_note", [text, colorInput?.value ?? "yellow", placement.x, placement.y, placement.w, placement.h]);
    if (textInput) textInput.value = "";
  });
  document.querySelectorAll<HTMLTextAreaElement>("[data-pin-note-text]").forEach((input) => {
    input.addEventListener("blur", () => {
      const id = input.dataset.pinNoteText ?? "";
      const text = input.value;
      if (!id || text === input.dataset.original) return;
      input.dataset.original = text;
      pinboardTargetCall(id, "set_text", [text.split(/\r?\n/)]);
    });
  });
  document.querySelectorAll<HTMLSelectElement>("[data-pin-note-color]").forEach((select) => {
    select.addEventListener("change", () => {
      const id = select.dataset.pinNoteColor ?? "";
      if (id) pinboardTargetCall(id, "set_color", [select.value]);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-pin-note-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.pinNoteId ?? "";
      const verb = button.dataset.pinNoteAction === "eject" ? "eject" : "take";
      if (id) pinboardCall(verb, [id]);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-pin-note-drag]").forEach(bindPinNoteDrag);
  document.querySelectorAll<HTMLButtonElement>("[data-pin-note-resize]").forEach(bindPinNoteResize);
  document.querySelectorAll<HTMLElement>("[data-pin-note]").forEach((note) => {
    note.addEventListener("pointerdown", () => bringPinNoteToTop(note.dataset.pinNote ?? ""));
  });
  bindPinboardMap();
  bindPinboardViewport();
}

function bringPinNoteToTop(id: string) {
  if (!id) return;
  const notes = Array.isArray(state.world?.pinboard?.notes) ? state.world.pinboard.notes : [];
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
  shell.innerHTML = renderPinboardMap(data.notes, data.present, data.width, data.height);
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

function pinboardMapData(): { notes: any[]; present: string[]; width: number; height: number } | undefined {
  const pinboard = state.world?.pinboard;
  if (!pinboard) return undefined;
  const viewport = pinboard?.viewport ?? { w: 960, h: 560 };
  return {
    width: pinNoteNumber(viewport.w, 960),
    height: pinNoteNumber(viewport.h, 560),
    present: Array.isArray(pinboard?.present) ? pinboard.present : [],
    notes: Array.isArray(pinboard?.notes) ? pinboard.notes : []
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

function pinboardViewStyle(view = normalizedPinboardView()) {
  return `transform: translate(${roundCss(view.x)}px, ${roundCss(view.y)}px) scale(${roundCss(view.scale)});`;
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
  return Boolean(state.actor && Array.isArray(state.world?.pinboard?.present) && state.world.pinboard.present.includes(state.actor));
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
    pinboardCall("move_pin", [note.dataset.pinNote ?? "", pinNoteNumber(note.dataset.x, 0), pinNoteNumber(note.dataset.y, 0)]);
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
    pinboardCall("resize_pin", [note.dataset.pinNote ?? "", pinNoteNumber(note.dataset.w, 180), pinNoteNumber(note.dataset.h, 110)]);
  });
  handle.addEventListener("pointercancel", () => {
    active = false;
  });
}

function enterPinboard() {
  const board = pinboardSpace();
  if (!board || !canSendDirect()) return;
  direct(board, "enter", [], (result) => {
    setPinboardPresent(result);
    refreshPinboardNotes();
    if (state.tab === "pinboard") render();
  });
}

function leavePinboard(done?: () => void) {
  const board = pinboardSpace();
  if (!board || !canSendDirect()) {
    done?.();
    return;
  }
  if (!Array.isArray(state.world?.pinboard?.present) || !state.world.pinboard.present.includes(state.actor)) {
    done?.();
    return;
  }
  direct(board, "leave", [], (result) => {
    setPinboardPresent(result);
    clearPinboardViewports();
    done?.();
    if (state.tab === "pinboard") render();
  });
}

function setPinboardPresent(result: any) {
  if (!Array.isArray(result) || !state.world?.pinboard) return;
  state.world.pinboard.present = result.map(String);
  const board = state.world.pinboard.board;
  if (board?.props) board.props.subscribers = state.world.pinboard.present;
  const present = new Set(state.world.pinboard.present);
  for (const actor of Object.keys(state.pinboardViewports)) {
    if (!present.has(actor)) removePinboardViewport(actor);
  }
}

function pinboardCall(verb: string, args: any[] = []) {
  const board = pinboardSpace();
  if (board) call(board, board, verb, args);
}

function pinboardTargetCall(target: string, verb: string, args: any[] = []) {
  const board = pinboardSpace();
  if (board && target) call(board, target, verb, args);
}

function refreshPinboardNotes() {
  const board = pinboardSpace();
  if (!board || !canSendDirect() || !state.world?.pinboard || pinboardNotesRefreshPending) return;
  pinboardNotesRefreshPending = true;
  window.setTimeout(() => {
    pinboardNotesRefreshPending = false;
  }, 2500);
  direct(board, "list_notes", [], (result) => {
    pinboardNotesRefreshPending = false;
    if (!Array.isArray(result) || !state.world?.pinboard) return;
    state.world.pinboard.notes = normalizePinboardNotes(result);
    if (state.tab === "pinboard") render();
  }, () => {
    pinboardNotesRefreshPending = false;
  });
}

function pinNoteNumber(value: any, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function pinboardPalette(palette: any): string[] {
  const items = Array.isArray(palette) ? palette.map(String).filter(Boolean) : [];
  return items.length > 0 ? items : ["yellow", "blue", "green", "pink", "white"];
}

function renderTaskspace() {
  const taskspace = state.world?.taskspace;
  const tasks = taskspace?.tasks ?? {};
  const roots = Array.isArray(taskspace?.root_tasks) ? taskspace.root_tasks : [];
  const selected = state.selectedTask ? tasks[state.selectedTask] : undefined;
  const allTasks = Object.values(tasks);
  const statusCounts = countTasksByStatus(allTasks);
  const active = activeTaskStatuses();
  const visibleCount = allTasks.filter((task) => taskMatchesStatus(task, active)).length;
  const renderedRoots = roots.map((id: string) => renderTaskNode(id, tasks, 0, active)).join("");
  return `
    <section class="toolbar task-toolbar">
      <h1>Taskspace</h1>
      <div class="task-summary">
        <span>${visibleCount}/${allTasks.length} tasks</span>
        ${taskStatuses.map((status) => renderStatusFilter(status, statusCounts[status] ?? 0)).join("")}
      </div>
    </section>
    <section class="taskspace-layout">
      <div class="panel tree">
        <div class="task-create">
          <input data-new-title placeholder="Root task title" />
          <input data-new-description placeholder="Description" />
          <button data-create-task>Create</button>
        </div>
        <div class="task-tree-list">
          ${renderedRoots || `<div class="empty-state">${allTasks.length > 0 ? "No tasks match the selected statuses." : "No tasks yet."}</div>`}
        </div>
      </div>
      <div class="panel inspector">${selected ? renderTaskInspector(selected, tasks) : `<div class="empty-state">Select a task.</div>`}</div>
    </section>
  `;
}

function renderStatusFilter(status: string, count: number): string {
  const active = state.taskStatusFilter[status] !== false;
  return `
    <button class="status-pill status-filter ${statusClass(status)} ${active ? "active" : ""}" data-task-status="${escapeHtml(status)}" aria-pressed="${active}">
      ${escapeHtml(statusLabel(status))}: ${count}
    </button>
  `;
}

function renderTaskNode(id: string, tasks: any, depth: number, active: Set<string>): string {
  const task = tasks[id];
  if (!task) return "";
  const props = task.props;
  const subtasks = Array.isArray(props.subtasks) ? props.subtasks : [];
  const renderedChildren = subtasks.map((child: string) => renderTaskNode(child, tasks, depth + 1, active)).join("");
  const matches = taskMatchesStatus(task, active);
  if (!matches && !renderedChildren) return "";
  const expanded = state.taskExpanded[id] !== false;
  const reqStats = requirementStats(props.requirements);
  const selected = state.selectedTask === id;
  return `
    <div class="task-node" style="--depth:${depth}">
      <div class="task-row ${selected ? "selected" : ""} ${matches ? "" : "filtered-context"}">
        <button class="task-toggle" data-toggle-task="${escapeHtml(id)}" aria-label="Toggle ${escapeHtml(String(props.title ?? id))}" ${subtasks.length === 0 ? "disabled" : ""}>${subtasks.length === 0 ? "" : expanded ? "-" : "+"}</button>
        <button class="task-select" data-select-task="${escapeHtml(id)}">
          <span class="task-title">${escapeHtml(String(props.title ?? id))}</span>
          <span class="task-meta">
            <span class="status-pill ${statusClass(String(props.status ?? ""))}">${escapeHtml(statusLabel(String(props.status ?? "")))}</span>
            <span>${escapeHtml(String(props.assignee ? actorLabel(String(props.assignee)) : "unassigned"))}</span>
            <span>${reqStats.checked}/${reqStats.total} req</span>
          </span>
        </button>
      </div>
      ${expanded && renderedChildren ? `<div class="children">${renderedChildren}</div>` : ""}
    </div>
  `;
}

function renderTaskInspector(task: any, tasks: any) {
  const props = task.props;
  const requirements = Array.isArray(props.requirements) ? props.requirements : [];
  const messages = Array.isArray(props.messages) ? props.messages : [];
  const artifacts = Array.isArray(props.artifacts) ? props.artifacts : [];
  const subtasks = Array.isArray(props.subtasks) ? props.subtasks : [];
  const reqStats = requirementStats(requirements);
  return `
    <div class="task-inspector-head">
      <div>
        <h2>${escapeHtml(String(props.title ?? task.id ?? ""))}</h2>
        <p>${escapeHtml(String(props.description ?? "No description."))}</p>
      </div>
      <span class="status-pill ${statusClass(String(props.status ?? ""))}">${escapeHtml(statusLabel(String(props.status ?? "")))}</span>
    </div>
    <div class="task-facts">
      <div><strong>ID</strong><span>${escapeHtml(task.id)}</span></div>
      <div><strong>Assignee</strong><span>${escapeHtml(String(props.assignee ? actorLabel(String(props.assignee)) : "none"))}</span></div>
      <div><strong>Requirements</strong><span>${reqStats.checked}/${reqStats.total}</span></div>
      <div><strong>Subtasks</strong><span>${subtasks.length}</span></div>
    </div>
    <div class="button-row task-actions">
      <button data-task-action="claim">Claim</button>
      <button data-task-action="release">Release</button>
      ${["open", "in_progress", "blocked", "done"].map((status) => `<button class="${String(props.status) === status ? "active" : ""}" data-task-action="status:${status}">${escapeHtml(statusLabel(status))}</button>`).join("")}
    </div>
    <section class="task-section">
      <h3>Subtasks</h3>
      <div class="inline-form"><input data-subtask-title placeholder="Subtask title"><input data-subtask-description placeholder="Description"><button data-add-subtask>Add</button></div>
      <div class="related-list">${subtasks.map((id: string) => renderRelatedTask(id, tasks)).join("") || `<div class="empty-state">No subtasks.</div>`}</div>
    </section>
    <section class="task-section">
      <h3>Requirements</h3>
      <div class="inline-form"><input data-requirement placeholder="Requirement"><button data-add-requirement>Add</button></div>
      <ul class="checklist">${requirements
        .map((item: any, index: number) => `<li><label><input data-check-req="${index}" type="checkbox" ${item.checked ? "checked" : ""}> <span>${escapeHtml(String(item.text ?? ""))}</span></label></li>`)
        .join("") || `<li class="empty-state">No requirements.</li>`}</ul>
    </section>
    <section class="task-section">
      <h3>Messages</h3>
      <div class="inline-form"><input data-message placeholder="Message"><button data-add-message>Add</button></div>
      <div class="activity-list">${messages.map(renderTaskMessage).join("") || `<div class="empty-state">No messages.</div>`}</div>
    </section>
    <section class="task-section">
      <h3>Artifacts</h3>
      <div class="inline-form"><input data-artifact placeholder="https://example.com/artifact"><button data-add-artifact>Add</button></div>
      <div class="artifact-list">${artifacts.map(renderArtifact).join("") || `<div class="empty-state">No artifacts.</div>`}</div>
    </section>
  `;
}

function renderRelatedTask(id: string, tasks: any) {
  const task = tasks[id];
  if (!task) return "";
  const props = task.props ?? {};
  return `
    <button class="related-task" data-select-task="${escapeHtml(id)}">
      <span>${escapeHtml(String(props.title ?? id))}</span>
      <span class="status-pill ${statusClass(String(props.status ?? ""))}">${escapeHtml(statusLabel(String(props.status ?? "")))}</span>
    </button>
  `;
}

function renderTaskMessage(item: any) {
  const actor = typeof item?.actor === "string" ? actorLabel(item.actor) : "unknown";
  const ts = typeof item?.ts === "number" ? new Date(item.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  return `
    <div class="activity-item">
      <div><strong>${escapeHtml(actor)}</strong><span>${escapeHtml(ts)}</span></div>
      <p>${escapeHtml(String(item?.body ?? ""))}</p>
    </div>
  `;
}

function renderArtifact(item: any) {
  const ref = String(item?.ref ?? "");
  const kind = String(item?.kind ?? "external");
  const label = ref || "artifact";
  const body = ref.startsWith("http")
    ? `<a href="${escapeHtml(ref)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
    : `<span>${escapeHtml(label)}</span>`;
  return `<div class="artifact-item"><span>${escapeHtml(kind)}</span>${body}</div>`;
}

function requirementStats(requirements: any) {
  const items = Array.isArray(requirements) ? requirements : [];
  return {
    total: items.length,
    checked: items.filter((item) => item?.checked === true).length
  };
}

function countTasksByStatus(tasks: any[]) {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    const status = String((task as any)?.props?.status ?? "open");
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function statusClass(status: string) {
  return `status-${status.replace(/[^a-z0-9_-]/gi, "_") || "unknown"}`;
}

function statusLabel(status: string) {
  if (status === "in_progress") return "in progress";
  return status || "unknown";
}

function activeTaskStatuses() {
  return new Set(taskStatuses.filter((status) => state.taskStatusFilter[status] !== false));
}

function taskStatus(task: any) {
  return String(task?.props?.status ?? "open");
}

function taskMatchesStatus(task: any, active: Set<string>) {
  return active.has(taskStatus(task));
}

function firstMatchingTask(ids: string[], tasks: any, active: Set<string>): string | undefined {
  for (const id of ids) {
    const task = tasks[id];
    if (!task) continue;
    if (taskMatchesStatus(task, active)) return id;
    const subtasks = Array.isArray(task.props?.subtasks) ? task.props.subtasks : [];
    const child = firstMatchingTask(subtasks, tasks, active);
    if (child) return child;
  }
  return undefined;
}

function bindTaskspace() {
  document.querySelectorAll<HTMLButtonElement>("[data-task-status]").forEach((button) => {
    button.addEventListener("click", () => {
      const status = button.dataset.taskStatus!;
      state.taskStatusFilter[status] = state.taskStatusFilter[status] === false;
      syncTaskSelection();
      render();
    });
  });
  document.querySelector<HTMLButtonElement>("[data-create-task]")?.addEventListener("click", () => {
    const titleInput = document.querySelector<HTMLInputElement>("[data-new-title]");
    const descriptionInput = document.querySelector<HTMLInputElement>("[data-new-description]");
    const title = titleInput?.value.trim() || "Untitled";
    const description = descriptionInput?.value.trim() || "";
    const space = taskspaceSpace();
    if (space) pendingTaskSelections.add(call(space, space, "create_task", [title, description]));
    if (titleInput) titleInput.value = "";
    if (descriptionInput) descriptionInput.value = "";
  });
  document.querySelectorAll<HTMLButtonElement>("[data-toggle-task]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.toggleTask!;
      state.taskExpanded[id] = state.taskExpanded[id] === false;
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-select-task]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedTask = button.dataset.selectTask!;
      state.taskExpanded[state.selectedTask] = state.taskExpanded[state.selectedTask] ?? true;
      render();
    });
  });
  const id = state.selectedTask;
  if (!id) return;
  document.querySelectorAll<HTMLButtonElement>("[data-task-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.taskAction!;
      const space = taskspaceSpace();
      if (!space) return;
      if (action === "claim" || action === "release") call(space, id, action, []);
      if (action.startsWith("status:")) call(space, id, "set_status", [action.slice("status:".length)]);
    });
  });
  document.querySelector<HTMLButtonElement>("[data-add-subtask]")?.addEventListener("click", () => {
    const titleInput = document.querySelector<HTMLInputElement>("[data-subtask-title]");
    const descriptionInput = document.querySelector<HTMLInputElement>("[data-subtask-description]");
    const title = titleInput?.value.trim() || "Subtask";
    const description = descriptionInput?.value.trim() || "";
    state.taskExpanded[id] = true;
    const space = taskspaceSpace();
    if (space) pendingTaskSelections.add(call(space, id, "add_subtask", [title, description]));
    if (titleInput) titleInput.value = "";
    if (descriptionInput) descriptionInput.value = "";
  });
  document.querySelector<HTMLButtonElement>("[data-add-requirement]")?.addEventListener("click", () => {
    const input = document.querySelector<HTMLInputElement>("[data-requirement]");
    const text = input?.value.trim() || "Requirement";
    const space = taskspaceSpace();
    if (space) call(space, id, "add_requirement", [text]);
    if (input) input.value = "";
  });
  document.querySelectorAll<HTMLInputElement>("[data-check-req]").forEach((input) => {
    input.addEventListener("change", () => {
      const space = taskspaceSpace();
      if (space) call(space, id, "check_requirement", [Number(input.dataset.checkReq), input.checked]);
    });
  });
  document.querySelector<HTMLButtonElement>("[data-add-message]")?.addEventListener("click", () => {
    const input = document.querySelector<HTMLInputElement>("[data-message]");
    const body = input?.value.trim() || "Update";
    const space = taskspaceSpace();
    if (space) call(space, id, "add_message", [body]);
    if (input) input.value = "";
  });
  document.querySelector<HTMLButtonElement>("[data-add-artifact]")?.addEventListener("click", () => {
    const input = document.querySelector<HTMLInputElement>("[data-artifact]");
    const ref = input?.value.trim() || "https://example.com";
    const space = taskspaceSpace();
    if (space) call(space, id, "add_artifact", [{ kind: ref.startsWith("http") ? "url" : "external", ref }]);
    if (input) input.value = "";
  });
}

function renderIde() {
  const objects = Object.keys(state.world?.objects ?? {}).sort();
  const installTarget = state.selectedObject || defaultSelectedObject();
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
  `;
}

function bindIde() {
  document.querySelector<HTMLSelectElement>("[data-object-select]")?.addEventListener("change", (event) => {
    state.selectedObject = (event.target as HTMLSelectElement).value;
    render();
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
    const slots = Array.isArray(state.world?.dubspaceMeta?.slots) ? state.world.dubspaceMeta.slots : [];
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
    const meta = state.world?.dubspaceMeta ?? {};
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
    const drum = this.dubspace?.[state.world?.dubspaceMeta?.drum]?.props;
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

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]!);
}
