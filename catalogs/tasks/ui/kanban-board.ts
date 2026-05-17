import {
  escapeHtml,
  preserveAmbientCompanionPanel,
  renderAmbientCompanionShell,
  restoreAmbientCompanionPanel,
  type ObservationRegistry,
  type WooComponentRegistry,
  type WooContext
} from "../../../src/client/framework";
import tasksManifest from "../manifest.json";

export type KanbanActionArg = {
  name: string;
  type: string;
  required?: boolean;
};

export type KanbanAction = {
  verb: string;
  label: string;
  args: KanbanActionArg[];
};

export type KanbanTask = {
  id: string;
  name: string;
  kind: string;
  labels: string[];
  location: string;
  cursorRole: string | null;
  cursorKey: string | null;
  cursorCriterion: string | null;
  waitForCount: number;
  terminal: boolean;
  complete: boolean;
  linkCount: number;
  ageMs: number;
  lastChange: number;
  actions: KanbanAction[];
};

export type TaskDetailObligation = {
  key: string;
  met: boolean;
  role: string | null;
  criterion: string | null;
  evidence?: unknown;
};

export type TaskDetailLogEntry = {
  ts: number | null;
  actor: string | null;
  outcome: string;
  obligationKey?: string | null;
  evidence?: unknown;
  why?: string | null;
};

export type TaskDetailLink = {
  to: string | null;
  role: string | null;
};

export type TaskDetail = {
  id: string;
  name: string;
  text: string;
  kind: string;
  labels: string[];
  obligations: TaskDetailObligation[];
  log: TaskDetailLogEntry[];
  waitFor: Array<Record<string, unknown>>;
  links: TaskDetailLink[];
  terminal: boolean;
  complete: boolean;
  cursorKey: string | null;
  location: string | null;
};

export type RegistryRole = {
  name: string;
  description: string;
  owners: string[];
};

export type RegistryObligation = {
  key: string;
  role: string;
  criterion: string;
};

export type KanbanData = {
  registryId: string;
  registryName: string;
  actor: string | null;
  actorNames: Record<string, string>;
  tasks: KanbanTask[];
  policies: string[];
  isOwner: boolean;
  roles: RegistryRole[];
  obligations: RegistryObligation[];
  policiesMap: Record<string, string[]>;
};

type StateColumnId = "ready" | "waiting" | "in_flight" | "done" | "dropped";
type CreateDraft = { kind: string; name: string; text: string; labels: string };
type AdminPanelMode = "edit" | "new";
type AdminDrafts = {
  role: { name: string; description: string; owners: string };
  obligation: { key: string; role: string; criterion: string };
  policy: { kind: string; keys: string[] };
};
type AdminSection = keyof AdminDrafts;
type AdminStatus = { state: "idle" | "pending" | "success" | "error"; message: string };
type AdminEditing = { section: AdminSection; key: string | null; mode: AdminPanelMode };

export type GroupBy = "state" | "role" | "holder" | "kind";

// User-facing button labels for each task action verb. The catalog's
// :available_actions returns its own `label`, but those words are
// ambiguous in everyday English: "pass" reads as either "approve" or
// "skip", "yield"/"spawn" suggests biology more than work-tracking. The
// override below is purely UI shorthand. Verbs not in this map fall
// back to action.label verbatim.
const ACTION_LABEL: Record<string, string> = {
  claim: "Claim",
  pass: "Mark step done",
  reject: "Reopen previous step",
  wait: "Mark blocked",
  yield: "Add related task",
  handoff: "Hand off",
  release: "Put back on board",
  drop_terminal: "Cancel task"
};

// Verb help text — the OUTCOME a click produces — is the single source of
// truth in the catalog manifest's verb-source doc-comments. The MCP host
// reads the same comments via `extractFirstParagraph`, so MCP clients see
// the same text the UI puts in tooltips. Built once at module load.
const VERB_DOC_BY_NAME: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const cls of (tasksManifest as { classes?: Array<{ verbs?: Array<{ name?: string; source?: string }> }> }).classes ?? []) {
    for (const verb of cls.verbs ?? []) {
      if (typeof verb.name !== "string" || typeof verb.source !== "string") continue;
      const doc = extractVerbDoc(verb.source);
      if (doc) out[verb.name] = doc;
    }
  }
  return out;
})();

// Mirrors src/mcp/host.ts:extractFirstParagraph — keep the two in sync so
// the UI tooltip and the MCP description always match. First /* ... */
// block (paragraph), else first // line, else empty.
function extractVerbDoc(source: string): string {
  const block = /\/\*([\s\S]*?)\*\//.exec(source);
  if (block) {
    const text = block[1].split(/\n\s*\n/)[0].replace(/^\s*\*?\s?/gm, "").replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  const line = /^\s*\/\/\s?(.*)$/m.exec(source);
  if (line) return line[1].trim();
  return "";
}

function actionPresentation(verb: string, fallbackLabel: string): { label: string; help: string } {
  return {
    label: ACTION_LABEL[verb] ?? fallbackLabel,
    help: VERB_DOC_BY_NAME[verb] ?? ""
  };
}

// Internal column ids stay (`waiting`, `in_flight`) — the labels are
// re-shaped for clarity. "Blocked" matches the "Mark blocked" action;
// "Active" reads more directly than aviation-flavoured "In flight".
const STATE_COLUMN_LABELS: Record<StateColumnId, string> = {
  ready: "Ready",
  waiting: "Blocked",
  in_flight: "Active",
  done: "Done",
  dropped: "Canceled"
};

const STATE_COLUMN_ORDER: StateColumnId[] = ["ready", "waiting", "in_flight", "done", "dropped"];
const DEFAULT_VISIBLE_STATE_COLUMNS: StateColumnId[] = ["ready", "waiting", "in_flight"];

const GROUP_BY_LABELS: Record<GroupBy, string> = {
  state: "State",
  role: "Role",
  // Internal type stays "holder"; the label drops the passive noun. "Person"
  // reads as a neutral category in the group-by dropdown without implying
  // who-did-what-to-whom.
  holder: "Person",
  // Internal field stays `kind` (catalog property name), but in the UI a
  // task's "kind" is just the name of the workflow it follows — calling
  // it "Kind" elsewhere and "Workflow" in the admin was the same concept
  // wearing two hats. Standardise on "Workflow" everywhere user-facing.
  kind: "Workflow"
};

const GROUP_BY_ORDER: GroupBy[] = ["state", "role", "holder", "kind"];

function isGroupBy(value: string | null): value is GroupBy {
  return value === "state" || value === "role" || value === "holder" || value === "kind";
}

function stateColumnFor(task: KanbanTask, registryId: string): StateColumnId {
  if (task.complete) return "done";
  if (task.terminal) return "dropped";
  if (task.location !== registryId) return "in_flight";
  if (task.waitForCount > 0) return "waiting";
  return "ready";
}

function statusCounts(tasks: KanbanTask[], registryId: string): Record<StateColumnId, number> {
  const counts: Record<StateColumnId, number> = {
    ready: 0,
    waiting: 0,
    in_flight: 0,
    done: 0,
    dropped: 0
  };
  for (const task of tasks) {
    const state = stateColumnFor(task, registryId);
    counts[state] += 1;
  }
  return counts;
}

function isStateColumnId(value: string): value is StateColumnId {
  return value === "ready" || value === "waiting" || value === "in_flight" || value === "done" || value === "dropped";
}

type Column = { id: string; label: string };

function computeGrouping(
  groupBy: GroupBy,
  tasks: KanbanTask[],
  registryId: string,
  actorNames: Record<string, string>
): { columns: Column[]; bucketFor: (task: KanbanTask) => string } {
  if (groupBy === "state") {
    return {
      columns: STATE_COLUMN_ORDER.map((id) => ({ id, label: STATE_COLUMN_LABELS[id] })),
      bucketFor: (task) => stateColumnFor(task, registryId)
    };
  }
  if (groupBy === "role") {
    const seen = new Set<string>();
    for (const t of tasks) seen.add(t.cursorRole ?? "");
    const ids = Array.from(seen).sort((a, b) => {
      if (a === b) return 0;
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b);
    });
    return {
      columns: ids.map((id) => ({ id, label: id || "no cursor" })),
      bucketFor: (task) => task.cursorRole ?? ""
    };
  }
  if (groupBy === "holder") {
    const seen = new Set<string>();
    for (const t of tasks) {
      seen.add(t.location && t.location !== registryId ? t.location : "");
    }
    const ids = Array.from(seen).sort((a, b) => {
      if (a === b) return 0;
      if (a === "") return -1; // "in registry" first
      if (b === "") return 1;
      return a.localeCompare(b);
    });
    return {
      columns: ids.map((id) => ({ id, label: id ? actorNames[id] ?? id : "in registry" })),
      bucketFor: (task) => (task.location && task.location !== registryId ? task.location : "")
    };
  }
  // kind
  const seen = new Set<string>();
  for (const t of tasks) seen.add(t.kind ?? "");
  const ids = Array.from(seen).sort((a, b) => {
    if (a === b) return 0;
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });
  return {
    columns: ids.map((id) => ({ id, label: id || "(no kind)" })),
    bucketFor: (task) => task.kind ?? ""
  };
}

function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function actorDisplay(ref: string, names: Record<string, string>): string {
  return names[ref] ?? ref;
}

function cssEscape(value: string): string {
  // Conservative escape sufficient for our identifiers (verb / arg names);
  // jsdom doesn't ship CSS.escape so we hand-roll.
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
  }
  return String(err);
}

function coerceArg(raw: string, type: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return type === "str" ? "" : null;
  if (type === "str") return raw;
  if (type === "int") {
    const n = Number(trimmed);
    return Number.isFinite(n) ? Math.trunc(n) : trimmed;
  }
  if (type === "float" || type === "number") {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : trimmed;
  }
  if (type === "bool") {
    if (/^(true|yes|1)$/i.test(trimmed)) return true;
    if (/^(false|no|0)$/i.test(trimmed)) return false;
    return trimmed;
  }
  if (type === "obj") return trimmed;
  if (type === "list" || type === "map" || type === "any") {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return raw;
}

function readListingRow(row: unknown): KanbanTask | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = typeof r.task === "string" ? r.task : "";
  if (!id) return null;
  const cursor = r.cursor_role && typeof r.cursor_role === "object" ? r.cursor_role as Record<string, unknown> : null;
  const cursorRole = cursor && typeof cursor.role === "string"
    ? cursor.role
    : typeof r.cursor_role === "string" ? r.cursor_role : null;
  const cursorKey = cursor && typeof cursor.key === "string" ? cursor.key : null;
  const cursorCriterion = cursor && typeof cursor.criterion === "string" ? cursor.criterion : null;
  const labels = Array.isArray(r.labels) ? r.labels.filter((l): l is string => typeof l === "string") : [];
  return {
    id,
    name: typeof r.name === "string" ? r.name : id,
    kind: typeof r.kind === "string" ? r.kind : "",
    labels,
    location: typeof r.location === "string" ? r.location : "",
    cursorRole,
    cursorKey,
    cursorCriterion,
    waitForCount: typeof r.wait_for_count === "number" ? r.wait_for_count : 0,
    terminal: r.terminal === true,
    complete: r.complete === true,
    linkCount: typeof r.link_count === "number" ? r.link_count : 0,
    ageMs: typeof r.age_ms === "number" ? r.age_ms : 0,
    lastChange: typeof r.last_change === "number" ? r.last_change : 0,
    actions: []
  };
}

function readDetail(row: unknown): TaskDetail | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "";
  if (!id) return null;
  const obs = Array.isArray(r.obligations)
    ? r.obligations.flatMap((entry): TaskDetailObligation[] => {
        if (!entry || typeof entry !== "object") return [];
        const e = entry as Record<string, unknown>;
        const key = typeof e.key === "string" ? e.key : "";
        if (!key) return [];
        return [{
          key,
          met: e.met === true,
          role: typeof e.role === "string" ? e.role : null,
          criterion: typeof e.criterion === "string" ? e.criterion : null,
          evidence: "evidence" in e ? e.evidence : undefined
        }];
      })
    : [];
  const log = Array.isArray(r.log)
    ? r.log.flatMap((entry): TaskDetailLogEntry[] => {
        if (!entry || typeof entry !== "object") return [];
        const e = entry as Record<string, unknown>;
        const outcome = typeof e.outcome === "string" ? e.outcome : "";
        if (!outcome) return [];
        return [{
          ts: typeof e.ts === "number" ? e.ts : null,
          actor: typeof e.actor === "string" ? e.actor : null,
          outcome,
          obligationKey: typeof e.obligation_key === "string" ? e.obligation_key : null,
          evidence: "evidence" in e ? e.evidence : undefined,
          why: typeof e.why === "string" ? e.why : null
        }];
      })
    : [];
  const waitFor = Array.isArray(r.wait_for)
    ? r.wait_for.flatMap((entry) => entry && typeof entry === "object" && !Array.isArray(entry) ? [entry as Record<string, unknown>] : [])
    : [];
  const links = Array.isArray(r.links)
    ? r.links.flatMap((entry): TaskDetailLink[] => {
        if (!entry || typeof entry !== "object") return [];
        const e = entry as Record<string, unknown>;
        return [{
          to: typeof e.to === "string" ? e.to : null,
          role: typeof e.role === "string" ? e.role : null
        }];
      })
    : [];
  const cursor = r.cursor && typeof r.cursor === "object" ? r.cursor as Record<string, unknown> : null;
  const cursorKey = cursor && typeof cursor.key === "string" ? cursor.key : null;
  return {
    id,
    name: typeof r.name === "string" ? r.name : id,
    text: typeof r.text === "string" ? r.text : "",
    kind: typeof r.kind === "string" ? r.kind : "",
    labels: Array.isArray(r.labels) ? r.labels.filter((l): l is string => typeof l === "string") : [],
    obligations: obs,
    log,
    waitFor,
    links,
    terminal: r.terminal === true,
    complete: r.complete === true,
    cursorKey,
    location: typeof r.location === "string" ? r.location : null
  };
}

function formatLogOutcome(outcome: string): string {
  if (outcome === "passed") return "completed step";
  if (outcome === "dropped") return "canceled task";
  if (outcome === "waited") return "marked blocked";
  return outcome.replaceAll("_", " ");
}

function readActionRow(row: unknown): KanbanAction | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const verb = typeof r.verb === "string" ? r.verb : "";
  if (!verb) return null;
  const args: KanbanActionArg[] = Array.isArray(r.args)
    ? r.args.flatMap((spec) => {
        if (!spec || typeof spec !== "object") return [];
        const s = spec as Record<string, unknown>;
        const name = typeof s.name === "string" ? s.name : "";
        if (!name) return [];
        return [{
          name,
          type: typeof s.type === "string" ? s.type : "any",
          required: s.required === true
        }];
      })
    : [];
  return {
    verb,
    label: typeof r.label === "string" ? r.label : verb,
    args
  };
}

// Window-level fan-out: registerWooObservationHandlers below dispatches this
// event whenever any task-mutation observation lands; mounted kanbans listen
// and refresh. Cheaper than wiring per-element subscriptions through the
// framework's projection layer when the kanban already has its own
// directCall-driven refresh.
const TASKS_REFRESH_EVENT = "woo-tasks-refresh";

const TASK_OBSERVATION_TYPES = [
  "task_created",
  "task_claimed",
  "task_released",
  "task_moved",
  "task_passed",
  "task_rejected",
  "task_waited",
  "task_yielded",
  "task_dropped",
  "task_returned_home",
  "task_renamed",
  "task_relabeled",
  "obligation_orphaned",
  "registry_role_changed",
  "registry_obligation_changed",
  "registry_policy_changed"
];

export class WooTasksKanbanElement extends HTMLElement {
  // `woo` and `subject` are accessor pairs: main.ts wires the element by
  // setting both after innerHTML inserts it (so connectedCallback has
  // already fired). Without these triggers the kanban would render its
  // empty `model` placeholder on first paint and only recover when an
  // observation arrived. With them, the late assignment kicks the same
  // refresh path the polling timer used to drive every 3s.
  private _woo?: WooContext;
  private _subject?: string;
  get woo(): WooContext | undefined { return this._woo; }
  set woo(value: WooContext | undefined) {
    this._woo = value;
    if (this.isConnected && value) this.scheduleRefresh();
  }
  get subject(): string | undefined { return this._subject; }
  set subject(value: string | undefined) {
    this._subject = value;
    if (this.isConnected && this._woo && value) this.scheduleRefresh();
  }
  private model: KanbanData = {
    registryId: "",
    registryName: "Tasks",
    actor: null,
    actorNames: {},
    tasks: [],
    policies: [],
    isOwner: false,
    roles: [],
    obligations: [],
    policiesMap: {}
  };
  private boundClick = false;
  private boundSubmit = false;
  private refreshing = false;
  private refreshQueued = false;
  private openPrompt: { taskId: string; verb: string } | null = null;
  private adminOpen = false;
  private adminSection: AdminSection = "role";
  private adminEditing: AdminEditing | null = null;
  private adminDrafts: AdminDrafts = {
    role: { name: "", description: "", owners: "" },
    obligation: { key: "", role: "", criterion: "" },
    policy: { kind: "", keys: [] }
  };
  private policyDragIndex: number | null = null;
  private adminStatus: Record<AdminSection, AdminStatus> = {
    role: { state: "idle", message: "" },
    obligation: { state: "idle", message: "" },
    policy: { state: "idle", message: "" }
  };
  private openDetail: { taskId: string; detail: TaskDetail | null; loading: boolean; error?: string; isNew?: boolean } | null = null;
  private detailDraft: CreateDraft | null = null;
  private groupBy: GroupBy = "state";
  private boundChange = false;
  private boundInput = false;
  private boundFocus = false;
  private renderDeferredForFocus = false;
  private refreshRetryTimer: number | null = null;
  private filterText = "";
  private filterLabels = new Set<string>();
  private visibleStateColumns = new Set<StateColumnId>(DEFAULT_VISIBLE_STATE_COLUMNS);

  set data(value: Partial<KanbanData> & Pick<KanbanData, "registryId" | "registryName" | "actor" | "actorNames" | "tasks">) {
    this.model = {
      policies: [],
      isOwner: false,
      roles: [],
      obligations: [],
      policiesMap: {},
      ...value
    };
    if (this.shouldDeferRenderForFocus()) {
      this.renderDeferredForFocus = true;
      return;
    }
    this.render();
  }

  connectedCallback(): void {
    this.render();
    if (!this.boundClick) {
      this.addEventListener("click", this.handleClick);
      this.boundClick = true;
    }
    if (!this.boundSubmit) {
      this.addEventListener("submit", this.handleSubmit);
      this.boundSubmit = true;
    }
    if (!this.boundChange) {
      this.addEventListener("change", this.handleChange);
      this.boundChange = true;
    }
    if (!this.boundInput) {
      this.addEventListener("input", this.handleInput);
      this.boundInput = true;
    }
    if (!this.boundFocus) {
      this.addEventListener("focusout", this.handleFocusOut);
      this.boundFocus = true;
    }
    this.addEventListener("dragstart", this.handleDragStart);
    this.addEventListener("dragover", this.handleDragOver);
    this.addEventListener("drop", this.handleDrop);
    if (this.woo) this.scheduleRefresh();
    if (typeof window !== "undefined") {
      window.addEventListener(TASKS_REFRESH_EVENT, this.handleTasksRefresh);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("keydown", this.handleKeydown);
    }
  }

  disconnectedCallback(): void {
    if (this.boundClick) {
      this.removeEventListener("click", this.handleClick);
      this.boundClick = false;
    }
    if (this.boundSubmit) {
      this.removeEventListener("submit", this.handleSubmit);
      this.boundSubmit = false;
    }
    if (this.boundChange) {
      this.removeEventListener("change", this.handleChange);
      this.boundChange = false;
    }
    if (this.boundInput) {
      this.removeEventListener("input", this.handleInput);
      this.boundInput = false;
    }
    if (this.boundFocus) {
      this.removeEventListener("focusout", this.handleFocusOut);
      this.boundFocus = false;
    }
    this.removeEventListener("dragstart", this.handleDragStart);
    this.removeEventListener("dragover", this.handleDragOver);
    this.removeEventListener("drop", this.handleDrop);
    if (typeof window !== "undefined") {
      window.removeEventListener(TASKS_REFRESH_EVENT, this.handleTasksRefresh);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("keydown", this.handleKeydown);
    }
    if (this.refreshRetryTimer !== null && typeof window !== "undefined") {
      window.clearTimeout(this.refreshRetryTimer);
      this.refreshRetryTimer = null;
    }
  }

  // Close whichever modal is open: task detail dialog, or admin
  // role/obligation/policy editor. Used by Escape, backdrop click, and the ×
  // button. The detail panel and admin editor are mutually exclusive.
  private closeModal(): void {
    if (this.openDetail) {
      this.openDetail = null;
      this.detailDraft = null;
      this.render();
      return;
    }
    if (this.adminEditing) {
      this.adminEditing = null;
      this.render();
    }
  }

  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (!this.isConnected) return;
    if (!this.openDetail && !this.adminEditing) return;
    event.preventDefault();
    this.closeModal();
  };

  private handleTasksRefresh = (): void => {
    if (!this.isConnected || !this.woo) return;
    this.scheduleRefresh();
  };

  // Coalesce bursts of observations: at most one refresh in flight at a time;
  // if more arrive while one is running, do exactly one more pass after it
  // settles. A burst of N task_passed/task_claimed observations from a single
  // applied frame produces 2 directCall sweeps total, not N.
  private scheduleRefresh(): void {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    void this.refresh().finally(() => {
      this.refreshing = false;
      if (this.refreshQueued && this.isConnected && this.woo) {
        this.refreshQueued = false;
        this.scheduleRefresh();
      } else {
        this.refreshQueued = false;
      }
    });
  }

  async refresh(): Promise<void> {
    const woo = this.woo;
    const subject = this.subject ?? this.model.registryId;
    if (!woo || !subject) {
      this.scheduleRefreshRetry(400);
      return;
    }
    const projected = woo.observe(subject);
    const registryName = projected?.name ?? this.model.registryName ?? subject;
    const actor = woo.actor ?? this.model.actor;
    const actorNames = this.collectActorNames(woo, projected);
    let listing: unknown;
    try {
      listing = await woo.directCall(subject, "listing", []);
    } catch {
      this.scheduleRefreshRetry(700);
      return;
    }
    if (!Array.isArray(listing)) {
      this.scheduleRefreshRetry(700);
      return;
    }
    const tasks = listing.flatMap((row) => {
      const parsed = readListingRow(row);
      return parsed ? [parsed] : [];
    });
    if (actor) {
      await Promise.all(tasks.map(async (task) => {
        try {
          const result = await woo.directCall(subject, "available_actions", [task.id, actor]);
          if (Array.isArray(result)) {
            task.actions = result.flatMap((row) => {
              const parsed = readActionRow(row);
              return parsed ? [parsed] : [];
            });
          }
        } catch {
          task.actions = [];
        }
      }));
    }
    const props = (projected?.props ?? {}) as Record<string, unknown>;
    // Preserve the last known-good policy/role/step metadata when projection
    // props are transiently missing. Dropping to empty made Admin/New buttons
    // flicker "randomly" between refreshes.
    const policiesMap: Record<string, string[]> = { ...this.model.policiesMap };
    const rawPolicies = props.policies;
    if (rawPolicies && typeof rawPolicies === "object" && !Array.isArray(rawPolicies)) {
      const next: Record<string, string[]> = {};
      for (const [kind, keys] of Object.entries(rawPolicies as Record<string, unknown>)) {
        if (Array.isArray(keys)) next[kind] = keys.filter((k): k is string => typeof k === "string");
      }
      for (const key of Object.keys(policiesMap)) delete policiesMap[key];
      Object.assign(policiesMap, next);
    }
    const roles: RegistryRole[] = [...this.model.roles];
    const rawRoles = props.roles;
    if (rawRoles && typeof rawRoles === "object" && !Array.isArray(rawRoles)) {
      roles.length = 0;
      for (const [name, info] of Object.entries(rawRoles as Record<string, unknown>)) {
        const i = info && typeof info === "object" && !Array.isArray(info) ? info as Record<string, unknown> : {};
        roles.push({
          name,
          description: typeof i.description === "string" ? i.description : "",
          owners: Array.isArray(i.owners) ? i.owners.filter((o): o is string => typeof o === "string") : []
        });
      }
    }
    const obligations: RegistryObligation[] = [...this.model.obligations];
    const rawObs = props.obligations;
    if (rawObs && typeof rawObs === "object" && !Array.isArray(rawObs)) {
      obligations.length = 0;
      for (const [key, info] of Object.entries(rawObs as Record<string, unknown>)) {
        const i = info && typeof info === "object" && !Array.isArray(info) ? info as Record<string, unknown> : {};
        obligations.push({
          key,
          role: typeof i.role === "string" ? i.role : "",
          criterion: typeof i.criterion === "string" ? i.criterion : ""
        });
      }
    }
    const policies = Object.keys(policiesMap);
    const ownerRef = typeof projected?.owner === "string" ? projected.owner : null;
    // Heuristic gate: show admin CTAs to the registry owner or $wiz. The
    // verb's own permission check is the truth — this just hides the button
    // when we already know it would E_PERM.
    const isOwner = !!actor && (ownerRef === null || actor === ownerRef || actor === "$wiz");
    this.data = {
      registryId: subject,
      registryName,
      actor: actor ?? null,
      actorNames,
      tasks,
      policies,
      isOwner,
      roles,
      obligations,
      policiesMap
    };
    if (this.refreshRetryTimer !== null && typeof window !== "undefined") {
      window.clearTimeout(this.refreshRetryTimer);
      this.refreshRetryTimer = null;
    }
  }

  private scheduleRefreshRetry(delayMs: number): void {
    if (typeof window === "undefined") return;
    if (this.refreshRetryTimer !== null) return;
    this.refreshRetryTimer = window.setTimeout(() => {
      this.refreshRetryTimer = null;
      if (!this.isConnected || !this.woo) return;
      this.scheduleRefresh();
    }, delayMs);
  }

  private collectActorNames(woo: WooContext, projected: ReturnType<WooContext["observe"]>): Record<string, string> {
    const names: Record<string, string> = { ...this.model.actorNames };
    if (projected?.name && (this.subject || this.model.registryId)) {
      names[this.subject ?? this.model.registryId] = projected.name;
    }
    if (woo.actor) {
      const actorProj = woo.observe(woo.actor);
      if (actorProj?.name) names[woo.actor] = actorProj.name;
    }
    return names;
  }

  private handleClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest<HTMLButtonElement>("[data-tasks-create-open]")) {
      event.preventDefault();
      this.adminOpen = false;
      this.openDetail = { taskId: "", detail: null, loading: false, isNew: true };
      this.detailDraft = { kind: this.model.policies[0] ?? "", name: "", text: "", labels: "" };
      this.render();
      this.querySelector<HTMLInputElement>("[data-tasks-detail-form] input[name=\"name\"]")?.focus();
      return;
    }
    if (target.closest<HTMLButtonElement>("[data-tasks-detail-close]")) {
      event.preventDefault();
      this.closeModal();
      return;
    }
    if (target.closest<HTMLButtonElement>("[data-tasks-detail-edit-toggle]")) {
      event.preventDefault();
      const detail = this.openDetail?.detail;
      if (detail) {
        this.detailDraft = {
          kind: detail.kind ?? "",
          name: detail.name ?? "",
          text: detail.text ?? "",
          labels: detail.labels.join(", ")
        };
        this.render();
        this.querySelector<HTMLInputElement>("[data-tasks-detail-form] input[name=\"name\"]")?.focus();
      }
      return;
    }
    if (target.closest<HTMLButtonElement>("[data-tasks-detail-cancel]")) {
      event.preventDefault();
      if (this.openDetail?.isNew) {
        // Cancelling a new-task draft closes the panel entirely.
        this.openDetail = null;
      }
      this.detailDraft = null;
      this.render();
      return;
    }
    if (target.closest<HTMLButtonElement>("[data-tasks-admin-toggle]")) {
      event.preventDefault();
      this.adminOpen = !this.adminOpen;
      if (this.adminOpen) {
        this.openDetail = null;
        this.detailDraft = null;
      }
      this.render();
      return;
    }
    const adminTab = target.closest<HTMLButtonElement>("[data-tasks-admin-tab]");
    if (adminTab) {
      event.preventDefault();
      const section = adminTab.dataset.tasksAdminTab;
      if ((section === "obligation" || section === "policy") && this.model.roles.length === 0) return;
      if (section === "role" || section === "obligation" || section === "policy") {
        this.adminSection = section;
        this.adminEditing = null;
        this.render();
      }
      return;
    }
    const adminNew = target.closest<HTMLButtonElement>("[data-tasks-admin-new]");
    if (adminNew) {
      event.preventDefault();
      const section = adminNew.dataset.tasksAdminNew;
      if ((section === "obligation" || section === "policy") && this.model.roles.length === 0) return;
      if (section === "role" || section === "obligation" || section === "policy") {
        this.adminSection = section;
        this.prepareAdminEditor(section, null, "new");
      }
      return;
    }
    const policyAdd = target.closest<HTMLButtonElement>("[data-tasks-policy-add-step]");
    if (policyAdd) {
      event.preventDefault();
      const key = policyAdd.dataset.tasksPolicyAddStep ?? "";
      if (key && !this.adminDrafts.policy.keys.includes(key)) {
        this.adminDrafts.policy.keys = [...this.adminDrafts.policy.keys, key];
        this.render();
      }
      return;
    }
    const policyRemove = target.closest<HTMLButtonElement>("[data-tasks-policy-remove-step]");
    if (policyRemove) {
      event.preventDefault();
      const index = Number(policyRemove.dataset.tasksPolicyRemoveStep ?? "-1");
      if (Number.isInteger(index) && index >= 0 && index < this.adminDrafts.policy.keys.length) {
        this.adminDrafts.policy.keys = this.adminDrafts.policy.keys.filter((_, i) => i !== index);
        this.render();
      }
      return;
    }
    const adminRow = target.closest<HTMLTableRowElement>("[data-tasks-admin-row]");
    if (adminRow) {
      event.preventDefault();
      const section = adminRow.dataset.tasksAdminSection as AdminSection | "";
      const key = adminRow.dataset.key ?? "";
      if (section === "role" || section === "obligation" || section === "policy") {
        this.adminSection = section;
        this.prepareAdminEditor(section, key || null, "edit");
      }
      return;
    }
    const adminEdit = target.closest<HTMLButtonElement>("[data-tasks-admin-edit]");
    if (adminEdit) {
      event.preventDefault();
      const section = adminEdit.dataset.tasksAdminEdit;
      const key = adminEdit.dataset.key ?? "";
      if ((section === "role" || section === "obligation" || section === "policy") && key) {
        this.adminSection = section;
        this.prepareAdminEditor(section, key, "edit");
      }
      return;
    }
    if (target.closest<HTMLButtonElement>("[data-tasks-admin-edit-cancel]")) {
      event.preventDefault();
      this.adminEditing = null;
      this.render();
      return;
    }
    const statusFilter = target.closest<HTMLButtonElement>("[data-tasks-status-filter]");
    if (statusFilter) {
      event.preventDefault();
      const value = statusFilter.dataset.tasksStatusFilter ?? "";
      if (isStateColumnId(value)) {
        if (this.visibleStateColumns.has(value)) this.visibleStateColumns.delete(value);
        else this.visibleStateColumns.add(value);
        this.render();
      }
      return;
    }
    const removeBtn = target.closest<HTMLButtonElement>("[data-tasks-admin-remove]");
    if (removeBtn) {
      event.preventDefault();
      const kind = removeBtn.dataset.tasksAdminRemove ?? "";
      const key = removeBtn.dataset.key ?? "";
      if (kind && key && this.confirmAdminRemove(kind, key)) void this.removeAdminEntry(kind, key);
      return;
    }
    const cancel = target.closest<HTMLButtonElement>("[data-tasks-prompt-cancel]");
    if (cancel) {
      event.preventDefault();
      this.closePrompt();
      return;
    }
    const filterAdd = target.closest<HTMLElement>("[data-tasks-filter-add-label]");
    if (filterAdd) {
      event.preventDefault();
      const label = filterAdd.dataset.tasksFilterAddLabel ?? "";
      if (label && !this.filterLabels.has(label)) {
        this.filterLabels.add(label);
        this.render();
      }
      return;
    }
    const filterRemove = target.closest<HTMLButtonElement>("[data-tasks-filter-remove-label]");
    if (filterRemove) {
      event.preventDefault();
      const label = filterRemove.dataset.tasksFilterRemoveLabel ?? "";
      if (label && this.filterLabels.has(label)) {
        this.filterLabels.delete(label);
        this.render();
      }
      return;
    }
    if (target.closest<HTMLButtonElement>("[data-tasks-filter-clear]")) {
      event.preventDefault();
      this.filterLabels.clear();
      this.filterText = "";
      this.render();
      return;
    }
    if (target.closest("[data-tasks-modal-backdrop]") && !target.closest(".woo-tasks-modal")) {
      // Backdrop click outside the modal closes it.
      event.preventDefault();
      this.closeModal();
      return;
    }
    const button = target.closest<HTMLButtonElement>("[data-tasks-action]");
    if (!button) {
      const card = target.closest<HTMLElement>("[data-tasks-card]");
      if (card && !target.closest("[data-tasks-prompt]")) {
        const taskId = card.dataset.tasksCard ?? "";
        if (taskId) {
          event.preventDefault();
          void this.openTaskDetail(taskId);
          return;
        }
      }
      return;
    }
    const taskId = button.dataset.taskId ?? "";
    const verb = button.dataset.tasksAction ?? "";
    if (!taskId || !verb) return;
    const action = this.findAction(taskId, verb);
    if (!action) return;
    event.preventDefault();
    this.dispatchEvent(new CustomEvent("woo-tasks-action", {
      bubbles: true,
      detail: { taskId, verb: action.verb, label: action.label, args: action.args }
    }));
    if (action.args.some((arg) => arg.required) || action.verb === "write") {
      this.openPromptFor(taskId, action.verb);
      return;
    }
    void this.invokeAction(taskId, action, []);
  };

  private handleChange = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    this.captureDraftInput(target);
    const select = target?.closest<HTMLSelectElement>("[data-tasks-group-by]");
    if (!select) return;
    if (isGroupBy(select.value) && select.value !== this.groupBy) {
      this.groupBy = select.value;
      this.render();
    }
  };

  private handleInput = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    this.captureDraftInput(target);
    const search = target?.closest<HTMLInputElement>("[data-tasks-filter-text]");
    if (!search) return;
    this.filterText = search.value;
    const start = search.selectionStart;
    const end = search.selectionEnd;
    this.render();
    const refocus = this.querySelector<HTMLInputElement>("[data-tasks-filter-text]");
    if (refocus) {
      refocus.focus();
      try {
        if (start !== null && end !== null) refocus.setSelectionRange(start, end);
      } catch {
        // Some inputs throw on setSelectionRange (e.g. type=email); ignore.
      }
    }
  };

  private handleFocusOut = (): void => {
    if (!this.renderDeferredForFocus) return;
    queueMicrotask(() => {
      if (!this.isConnected || this.shouldDeferRenderForFocus()) return;
      this.renderDeferredForFocus = false;
      this.render();
    });
  };

  private shouldDeferRenderForFocus(): boolean {
    // Render-defer only kicks in for tasks-owned form fields where stomping
    // mid-keystroke would lose draft state (admin form, detail form, prompt
    // form, filter input). Earlier this had a broad fall-through for ANY
    // input/textarea/select inside the kanban — but the embedded chat
    // panel renders its composer input INSIDE this element, so the chat
    // input's auto-focus on tab entry left the post-mount refresh
    // permanently deferred until the user clicked elsewhere. Tasks looked
    // empty until the first stray click.
    const active = this.ownerDocument.activeElement;
    if (!(active instanceof HTMLElement) || !this.contains(active)) return false;
    if (active.closest("[data-tasks-prompt]")) return true;
    if (active.closest("[data-tasks-detail-form]")) return true;
    if (active.closest("[data-tasks-admin-form]")) return true;
    if (active.matches("[data-tasks-filter-text]")) return true;
    return false;
  }

  private captureDraftInput(target: HTMLElement | null): void {
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    const detailForm = target.closest<HTMLFormElement>("[data-tasks-detail-form]");
    if (detailForm && this.detailDraft) {
      const name = target.name as keyof CreateDraft;
      if (name === "kind" || name === "name" || name === "text" || name === "labels") this.detailDraft[name] = target.value;
      // Toggle the Create button live as the name field is edited. We can't
      // re-render — that would steal focus mid-keystroke — so we mutate the
      // submit button's disabled state in place. Only matters for new tasks.
      if (name === "name" && this.openDetail?.isNew) {
        const submit = detailForm.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (submit) submit.disabled = this.detailDraft.name.trim().length === 0;
      }
      return;
    }
    const adminForm = target.closest<HTMLFormElement>("[data-tasks-admin-form]");
    const formKind = adminForm?.dataset.tasksAdminForm;
    if (formKind === "role") {
      const name = target.name as keyof AdminDrafts["role"];
      if (name === "name" || name === "description" || name === "owners") this.adminDrafts.role[name] = target.value;
      return;
    }
    if (formKind === "obligation") {
      const name = target.name as keyof AdminDrafts["obligation"];
      if (name === "key" || name === "role" || name === "criterion") this.adminDrafts.obligation[name] = target.value;
      return;
    }
    if (formKind === "policy") {
      const name = target.name as keyof AdminDrafts["policy"];
      if (name === "kind") this.adminDrafts.policy.kind = target.value;
    }
  }

  private prepareAdminEditor(section: AdminSection, key: string | null, mode: AdminPanelMode): void {
    if (section === "role") {
      const role = key ? this.model.roles.find((entry) => entry.name === key) : null;
      this.adminDrafts.role = role
        ? { name: role.name, description: role.description, owners: role.owners.join(", ") }
        : { name: "", description: "", owners: "" };
    } else if (section === "obligation") {
      const obligation = key ? this.model.obligations.find((entry) => entry.key === key) : null;
      this.adminDrafts.obligation = obligation
        ? { key: obligation.key, role: obligation.role, criterion: obligation.criterion }
        : { key: "", role: this.model.roles[0]?.name ?? "", criterion: "" };
    } else {
      const keys = key ? this.model.policiesMap[key] ?? [] : [];
      this.adminDrafts.policy = key
        ? { kind: key, keys: [...keys] }
        : { kind: "", keys: [] };
    }
    this.adminEditing = { section, key, mode };
    this.render();
    const first = this.querySelector<HTMLInputElement | HTMLSelectElement>("[data-tasks-admin-form] input, [data-tasks-admin-form] select");
    first?.focus();
  }

  private handleSubmit = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    // The user just submitted — they're between operations, not typing. Blur
    // whatever is focused (typically the submit button) so the upcoming
    // refresh()'s data setter doesn't see focus-still-in-the-form and defer
    // the render. Without this, createOpen=false / new role / etc. take
    // effect in state but the stale form stays on screen until something
    // else moves focus, producing the "needs two clicks, nothing happens"
    // symptom.
    const active = this.ownerDocument.activeElement;
    if (active instanceof HTMLElement && this.contains(active)) active.blur();
    const detailForm = target?.closest<HTMLFormElement>("[data-tasks-detail-form]");
    if (detailForm) {
      event.preventDefault();
      void this.submitDetailForm(detailForm);
      return;
    }
    const adminForm = target?.closest<HTMLFormElement>("[data-tasks-admin-form]");
    if (adminForm) {
      event.preventDefault();
      void this.submitAdminForm(adminForm);
      return;
    }
    const form = target?.closest<HTMLFormElement>("[data-tasks-prompt]");
    if (!form) return;
    const taskId = form.dataset.taskId ?? "";
    const verb = form.dataset.verb ?? "";
    if (!taskId || !verb) return;
    event.preventDefault();
    const action = this.findAction(taskId, verb);
    if (!action) return;
    let args: unknown[] = [];
    if (action.verb === "reject") {
      const indexRaw = form.querySelector<HTMLSelectElement>('select[name="reject_index"]')?.value ?? "";
      const why = (form.querySelector<HTMLTextAreaElement>('textarea[name="why"]')?.value ?? "").trim();
      args = [Number(indexRaw), why];
    } else if (action.verb === "wait") {
      const kind = (form.querySelector<HTMLSelectElement>('select[name="wait_kind"]')?.value ?? "").trim();
      const note = (form.querySelector<HTMLTextAreaElement>('textarea[name="wait_note"]')?.value ?? "").trim();
      const waitTask = (form.querySelector<HTMLInputElement>('input[name="wait_task"]')?.value ?? "").trim();
      const cond: Record<string, unknown> = { kind };
      if (note) cond.note = note;
      if (waitTask) cond.task = waitTask;
      args = [cond];
    } else if (action.verb === "write") {
      const text = (form.querySelector<HTMLTextAreaElement>('textarea[name="line"]')?.value ?? "").trim();
      args = [text];
    } else {
      args = action.args.map((arg) => {
        const input = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${cssEscape(arg.name)}"]`);
        const raw = input?.value ?? "";
        return coerceArg(raw, arg.type);
      });
    }
    this.closePrompt();
    void this.invokeAction(taskId, action, args);
  };

  private findAction(taskId: string, verb: string): KanbanAction | null {
    const action = this.model.tasks
      .find((task) => task.id === taskId)?.actions
      .find((entry) => entry.verb === verb);
    if (action) return action;
    if (verb === "write") {
      return {
        verb: "write",
        label: "Add comment",
        args: [{ name: "line", type: "str", required: true }]
      };
    }
    return null;
  }

  private async createTask(kind: string, name: string, text: string, labels: string[]): Promise<void> {
    const woo = this.woo;
    const subject = this.subject ?? this.model.registryId;
    if (!woo || !subject) return;
    // Optimistic close: drop the panel right away so the user gets immediate
    // feedback. The new task will materialize once the server confirms via
    // task_created (eagerly nudged by the background refresh below).
    this.openDetail = null;
    this.detailDraft = null;
    this.render();
    try {
      await woo.directCall(subject, "create_task", [kind, name, text, labels, null]);
    } catch {
      // Errors land as observations; refresh will repaint either way.
    }
    void this.refresh();
  }

  private async submitAdminForm(form: HTMLFormElement): Promise<void> {
    const woo = this.woo;
    const subject = this.subject ?? this.model.registryId;
    if (!woo || !subject) return;
    const kind = form.dataset.tasksAdminForm ?? "";
    if (kind === "role") {
      const name = (form.querySelector<HTMLInputElement>('input[name="name"]')?.value ?? "").trim();
      const description = (form.querySelector<HTMLTextAreaElement>('textarea[name="description"]')?.value ?? "").trim();
      const ownersRaw = (form.querySelector<HTMLInputElement>('input[name="owners"]')?.value ?? "").trim();
      this.adminDrafts.role = { name, description, owners: ownersRaw };
      const owners = ownersRaw.split(",").map((s) => s.trim()).filter(Boolean);
      if (!name) return;
      const mode = this.adminEditing?.section === "role" ? this.adminEditing.mode : "new";
      const action = mode === "new" ? "add" : "update";
      try {
        await woo.directCall(subject, "set_role", [name, { description, owners }]);
        this.adminEditing = null;
        this.adminDrafts.role = { name: "", description: "", owners: "" };
        this.setAdminStatus("role", "success", `${action === "add" ? "Added" : "Updated"} role "${name}".`);
        this.render();
      } catch (err) {
        this.setAdminStatus("role", "error", `Could not ${action} role "${name}": ${errorMessage(err)}`);
      }
      void this.refresh();
      return;
    }
    if (kind === "obligation") {
      const editor = this.adminEditing?.section === "obligation" ? this.adminEditing : null;
      const keyInput = (form.querySelector<HTMLInputElement>('input[name="key"]')?.value ?? "").trim();
      const key = editor?.mode === "edit" && editor.key ? editor.key : keyInput;
      const role = (form.querySelector<HTMLSelectElement>('select[name="role"]')?.value ?? "").trim();
      const criterion = (form.querySelector<HTMLTextAreaElement>('textarea[name="criterion"]')?.value ?? "").trim();
      this.adminDrafts.obligation = { key, role, criterion };
      if (!key || !role || !criterion) return;
      const mode = this.adminEditing?.section === "obligation" ? this.adminEditing.mode : "new";
      const action = mode === "new" ? "add" : "update";
      try {
        await woo.directCall(subject, "set_obligation", [key, { role, criterion }]);
        this.adminEditing = null;
        this.adminDrafts.obligation = { key: "", role: this.model.roles[0]?.name ?? "", criterion: "" };
        this.setAdminStatus("obligation", "success", `${action === "add" ? "Added" : "Updated"} step "${key}".`);
        this.render();
      } catch (err) {
        this.setAdminStatus("obligation", "error", `Could not ${action} step "${key}": ${errorMessage(err)}`);
      }
      void this.refresh();
      return;
    }
    if (kind === "policy") {
      const policyKind = (form.querySelector<HTMLInputElement>('input[name="kind"]')?.value ?? "").trim();
      const keys = [...this.adminDrafts.policy.keys];
      this.adminDrafts.policy = { kind: policyKind, keys };
      if (!policyKind || keys.length === 0) return;
      const wasNew = this.adminEditing?.section === "policy" && this.adminEditing.mode === "new";
      this.model.policiesMap[policyKind] = keys;
      if (!this.model.policies.includes(policyKind)) this.model.policies = [...this.model.policies, policyKind];
      if (wasNew) this.adminDrafts.policy = { kind: "", keys: [] };
      else this.adminDrafts.policy = { kind: policyKind, keys };
      if (this.adminEditing?.section === "policy") this.adminEditing = { section: "policy", key: policyKind, mode: "edit" };
      this.setAdminStatus("policy", "success", `Saved policy "${policyKind}".`);
      try {
        await woo.directCall(subject, "set_policy", [policyKind, keys]);
      } catch (err) {
        this.setAdminStatus("policy", "error", `Could not save policy "${policyKind}": ${errorMessage(err)}`);
      }
      void this.refresh();
      return;
    }
  }

  private handleDragStart = (event: DragEvent): void => {
    const target = event.target as HTMLElement | null;
    const item = target?.closest<HTMLElement>("[data-tasks-policy-order-item]");
    if (!item) return;
    const index = Number(item.dataset.tasksPolicyOrderItem ?? "-1");
    if (!Number.isInteger(index) || index < 0) return;
    this.policyDragIndex = index;
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  };

  private handleDragOver = (event: DragEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest("[data-tasks-policy-order-item]")) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  };

  private handleDrop = (event: DragEvent): void => {
    const target = event.target as HTMLElement | null;
    const item = target?.closest<HTMLElement>("[data-tasks-policy-order-item]");
    if (!item) return;
    event.preventDefault();
    const from = this.policyDragIndex;
    this.policyDragIndex = null;
    const to = Number(item.dataset.tasksPolicyOrderItem ?? "-1");
    if (from === null || !Number.isInteger(to) || from < 0 || to < 0 || from === to) return;
    const keys = [...this.adminDrafts.policy.keys];
    const [moved] = keys.splice(from, 1);
    if (!moved) return;
    keys.splice(to, 0, moved);
    this.adminDrafts.policy.keys = keys;
    this.render();
  };

  private confirmAdminRemove(kind: string, key: string): boolean {
    const label = kind === "role" ? "role" : kind === "obligation" ? "obligation" : kind === "policy" ? "policy" : "entry";
    return window.confirm(`Remove ${label} "${key}"?`);
  }

  private setAdminStatus(section: AdminSection, state: AdminStatus["state"], message: string): void {
    this.adminStatus[section] = { state, message };
    this.render();
  }

  private async removeAdminEntry(kind: string, key: string): Promise<void> {
    const woo = this.woo;
    const subject = this.subject ?? this.model.registryId;
    if (!woo || !subject) return;
    const verb = kind === "role" ? "remove_role" : kind === "obligation" ? "remove_obligation" : kind === "policy" ? "remove_policy" : "";
    if (!verb) return;
    const section = kind as AdminSection;
    // Optimistic local removal — drop it from the table immediately so the
    // user sees the change without waiting for the server roundtrip.
    if (kind === "role") this.model.roles = this.model.roles.filter((r) => r.name !== key);
    else if (kind === "obligation") this.model.obligations = this.model.obligations.filter((o) => o.key !== key);
    else if (kind === "policy") {
      const next: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(this.model.policiesMap)) if (k !== key) next[k] = v;
      this.model.policiesMap = next;
      this.model.policies = this.model.policies.filter((k) => k !== key);
    }
    if (this.adminEditing?.section === section && this.adminEditing.key === key) this.adminEditing = null;
    this.setAdminStatus(section, "success", `Removed ${kind} "${key}".`);
    try {
      await woo.directCall(subject, verb, [key]);
    } catch (err) {
      this.setAdminStatus(section, "error", `Could not remove ${kind} "${key}": ${errorMessage(err)}`);
    }
    void this.refresh();
  }

  private async submitDetailForm(form: HTMLFormElement): Promise<void> {
    const woo = this.woo;
    if (!woo || !this.openDetail || !this.detailDraft) return;
    const open = this.openDetail;
    const draft = this.detailDraft;
    const name = (form.querySelector<HTMLInputElement>('input[name="name"]')?.value ?? "").trim();
    const text = form.querySelector<HTMLTextAreaElement>('textarea[name="text"]')?.value ?? "";
    const labelsRaw = form.querySelector<HTMLInputElement>('input[name="labels"]')?.value ?? "";
    const labels = labelsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (open.isNew) {
      const kind = (form.querySelector<HTMLSelectElement>('select[name="kind"]')?.value ?? draft.kind ?? "").trim();
      if (!kind || !name) return;
      void this.createTask(kind, name, text, labels);
      return;
    }
    // Existing task: dispatch only the fields that actually changed, optimistically.
    const detail = open.detail;
    if (!detail) return;
    const taskId = open.taskId;
    const taskRow = this.model.tasks.find((t) => t.id === taskId);
    const calls: Array<Promise<unknown>> = [];
    if (name && name !== detail.name) {
      detail.name = name;
      if (taskRow) taskRow.name = name;
      calls.push(woo.directCall(taskId, "set_name", [name]).catch(() => undefined));
    }
    if (text !== detail.text) {
      detail.text = text;
      calls.push(woo.directCall(taskId, "set_text", [text]).catch(() => undefined));
    }
    const labelsChanged = labels.length !== detail.labels.length || labels.some((l, i) => l !== detail.labels[i]);
    if (labelsChanged) {
      detail.labels = labels;
      if (taskRow) taskRow.labels = labels;
      calls.push(woo.directCall(taskId, "set_labels", [labels]).catch(() => undefined));
    }
    this.detailDraft = null;
    this.render();
    await Promise.all(calls);
    void this.refresh();
  }

  private async openTaskDetail(taskId: string): Promise<void> {
    const woo = this.woo;
    if (!woo) return;
    this.openDetail = { taskId, detail: null, loading: true, isNew: false };
    this.detailDraft = null;
    this.render();
    try {
      const result = await woo.directCall(taskId, "detail", []);
      const detail = readDetail(result);
      this.openDetail = detail
        ? { taskId, detail, loading: false, isNew: false }
        : { taskId, detail: null, loading: false, error: "no detail returned", isNew: false };
    } catch (err) {
      this.openDetail = { taskId, detail: null, loading: false, error: err instanceof Error ? err.message : String(err), isNew: false };
    }
    this.render();
  }

  private openPromptFor(taskId: string, verb: string): void {
    this.openPrompt = { taskId, verb };
    this.render();
    const form = this.querySelector<HTMLFormElement>(`[data-tasks-prompt][data-task-id="${cssEscape(taskId)}"][data-verb="${cssEscape(verb)}"]`);
    form?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")?.focus();
  }

  private closePrompt(): void {
    if (!this.openPrompt) return;
    this.openPrompt = null;
    this.render();
  }


  private async invokeAction(taskId: string, action: KanbanAction, args: unknown[]): Promise<void> {
    const woo = this.woo;
    if (!woo) return;
    // Optimistic transition: snap the card into its expected next column for
    // the verbs we know how to model locally. Server confirms via observation
    // and the background refresh re-anchors if anything drifts.
    const task = this.model.tasks.find((t) => t.id === taskId);
    if (task && woo.actor) {
      if (action.verb === "claim") task.location = woo.actor;
      else if (action.verb === "release") task.location = this.model.registryId;
      else if (action.verb === "drop_terminal") task.terminal = true;
      else if (action.verb === "pass") task.location = this.model.registryId;
      else if (action.verb === "handoff" && typeof args[0] === "string") task.location = args[0];
      this.render();
    }
    try {
      await woo.directCall(taskId, action.verb, args);
    } catch {
      // Errors surface as observations; live reconciliation tightens this later.
    }
    void this.refresh();
  }

  private filteredTasks(): KanbanTask[] {
    const tasks = this.model.tasks;
    const q = this.filterText.trim().toLowerCase();
    const labels = this.filterLabels;
    const filterBySelectedStates = this.groupBy !== "state";
    if (!q && labels.size === 0 && !filterBySelectedStates) return tasks;
    return tasks.filter((task) => {
      if (filterBySelectedStates && !this.visibleStateColumns.has(stateColumnFor(task, this.model.registryId))) return false;
      if (labels.size > 0) {
        const have = new Set(task.labels);
        for (const l of labels) if (!have.has(l)) return false;
      }
      if (q) {
        const hay = [task.name, task.kind, task.id, ...task.labels].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  private render(): void {
    const { registryId, registryName, actorNames } = this.model;
    const tasks = this.filteredTasks();
    const grouping = computeGrouping(this.groupBy, tasks, registryId, actorNames);
    const visibleIds = this.groupBy === "state" ? this.visibleStateColumns : null;
    const columns = visibleIds ? grouping.columns.filter((col) => visibleIds.has(col.id as StateColumnId)) : grouping.columns;
    const bucketFor = grouping.bucketFor;
    const buckets = new Map<string, KanbanTask[]>();
    for (const col of columns) buckets.set(col.id, []);
    for (const task of tasks) {
      const bucket = bucketFor(task);
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket)!.push(task);
    }
    const renderableColumns = columns.length > 0
      ? columns
      : [{ id: "_empty", label: "No tasks" }];

    const columnsHtml = renderableColumns.map((col) => {
      const items = buckets.get(col.id) ?? [];
      const cards = items.length === 0
        ? `<div class="woo-tasks-kanban-empty-col" data-tasks-empty="${escapeHtml(col.id)}">No tasks.</div>`
        : items.map((task) => this.renderCard(task, actorNames)).join("");
      return `
        <section class="woo-tasks-kanban-col" data-tasks-col="${escapeHtml(col.id)}">
          <header class="woo-tasks-kanban-col-header">
            <span class="woo-tasks-kanban-col-name">${escapeHtml(col.label)}</span>
            <span class="woo-tasks-kanban-col-count" data-tasks-col-count>${items.length}</span>
          </header>
          <div class="woo-tasks-kanban-col-body">${cards}</div>
        </section>
      `;
    }).join("");

    const boardContent = this.adminOpen
      ? this.renderAdminPanel()
      : `${this.renderFilterBar()}
          <section class="woo-tasks-kanban" aria-label="Task board">
            <div class="woo-tasks-kanban-columns">${columnsHtml}</div>
          </section>`;
    const workspace = `
      <section class="woo-tasks-workspace has-ambient-companion" data-space-chat-layout="${escapeHtml(registryId)}">
        <div class="woo-tasks-workarea">
          <div class="woo-tasks-board${this.adminOpen ? " has-admin" : ""}">
            ${boardContent}
          </div>
          ${!this.adminOpen && this.openDetail ? this.renderDetailPanel(actorNames) : ""}
        </div>
      </section>
    `;
    const preservedPanel = preserveAmbientCompanionPanel(this, registryId);
    // Toolbar lives at the top of the custom element, outside the ambient-companion
    // shell — same structure as pinboard (`<section class="toolbar pinboard-toolbar">`
    // before `<section class="ambient-companion-shell">`). Putting it inside the
    // shell would push the toolbar inside the companion-grid and shift y-position
    // versus other tools.
    this.innerHTML = `
      ${this.renderHeader(registryName || "Tasks")}
      ${renderAmbientCompanionShell(registryId, workspace)}
    `;
    restoreAmbientCompanionPanel(this, preservedPanel);
    this.dispatchEvent(new CustomEvent("woo-tasks-rendered", { bubbles: true }));
  }

  private renderDetailPanel(actorNames: Record<string, string>): string {
    const open = this.openDetail;
    if (!open) return "";
    const isNew = !!open.isNew;
    if (!isNew && open.loading) {
      return `
        <div class="woo-tasks-modal-backdrop" data-tasks-modal-backdrop>
          <aside class="woo-tasks-detail woo-tasks-modal" data-tasks-detail data-task-id="${escapeHtml(open.taskId)}" role="dialog" aria-modal="true">
            <header class="woo-tasks-detail-header">
              <h3>${escapeHtml(open.taskId)}</h3>
              <button type="button" data-tasks-detail-close aria-label="Close">×</button>
            </header>
            <div class="woo-tasks-detail-body"><p>Loading…</p></div>
          </aside>
        </div>
      `;
    }
    if (!isNew && !open.detail) {
      const message = open.error ? `Failed to load task: ${open.error}` : "No detail returned.";
      return `
        <div class="woo-tasks-modal-backdrop" data-tasks-modal-backdrop>
          <aside class="woo-tasks-detail woo-tasks-modal" data-tasks-detail data-task-id="${escapeHtml(open.taskId)}" role="dialog" aria-modal="true">
            <header class="woo-tasks-detail-header">
              <h3>${escapeHtml(open.taskId)}</h3>
              <button type="button" data-tasks-detail-close aria-label="Close">×</button>
            </header>
            <div class="woo-tasks-detail-body"><p>${escapeHtml(message)}</p></div>
          </aside>
        </div>
      `;
    }
    const editing = this.detailDraft !== null;
    const draft = this.detailDraft;
    const detail = open.detail;
    const detailId = detail?.id ?? "";
    const detailName = detail?.name ?? "";
    const detailKind = detail?.kind ?? "";
    const detailText = detail?.text ?? "";
    const detailLabels = detail?.labels ?? [];
    const detailObligations = detail?.obligations ?? [];
    const detailLog = detail?.log ?? [];
    const detailWaitFor = detail?.waitFor ?? [];
    const detailLinks = detail?.links ?? [];
    const detailLocation = detail?.location ?? null;
    const detailComplete = detail?.complete ?? false;
    const detailTerminal = detail?.terminal ?? false;
    const detailCursorKey = detail?.cursorKey ?? null;
    const dataTaskId = isNew ? "new" : detailId;
    const mode = isNew ? "new" : editing ? "edit" : "view";
    const status = isNew
      ? "draft"
      : detailComplete
        ? "complete"
        : detailTerminal
          ? "canceled"
          : detailLocation && detailLocation !== this.model.registryId
            ? `with ${actorDisplay(detailLocation, actorNames)}`
            : "ready";

    const headerTitle = (isNew || editing)
      ? `<input class="woo-tasks-detail-name-input" type="text" name="name" value="${escapeHtml(draft?.name ?? detailName)}" placeholder="Task name" required autocomplete="off">`
      : `<span class="woo-tasks-detail-name">${escapeHtml(detailName || detailId)}</span>`;
    const editToggle = (!isNew && !editing)
      ? `<button type="button" data-tasks-detail-edit-toggle class="woo-tasks-detail-edit-toggle woo-tasks-action">Edit</button>`
      : "";

    const policyOptions = this.model.policies
      .map((kind) => `<option value="${escapeHtml(kind)}"${kind === (draft?.kind ?? detailKind) ? " selected" : ""}>${escapeHtml(kind)}</option>`)
      .join("");
    const kindBlock = isNew
      ? `<label class="woo-tasks-detail-field">
          <span class="woo-tasks-detail-field-label">Workflow <span class="woo-tasks-detail-field-hint">(the ordered steps this task will walk)</span></span>
          <select name="kind" required>${policyOptions}</select>
        </label>`
      : `<span class="woo-tasks-detail-kind" title="Workflow — the ordered steps this task walks">${escapeHtml(detailKind || "task")}</span>`;

    const labelsValue = draft?.labels ?? detailLabels.join(", ");
    const labelsBlock = (isNew || editing)
      ? `<label class="woo-tasks-detail-field">
          <span class="woo-tasks-detail-field-label">Labels <span class="woo-tasks-detail-field-hint">(comma-separated)</span></span>
          <input type="text" name="labels" value="${escapeHtml(labelsValue)}" autocomplete="off">
        </label>`
      : `<div class="woo-tasks-detail-labels" data-tasks-detail-field="labels">
          ${detailLabels.length === 0
            ? `<span class="woo-tasks-detail-empty-inline">no labels</span>`
            : detailLabels.map((l) => `<span class="woo-tasks-card-label">${escapeHtml(l)}</span>`).join("")}
        </div>`;

    const textValue = draft?.text ?? detailText;
    const bodyBlock = (isNew || editing)
      ? `<label class="woo-tasks-detail-field">
          <span class="woo-tasks-detail-field-label">Task instructions <span class="woo-tasks-detail-field-hint">(markdown — what needs doing, optional)</span></span>
          <textarea name="text" rows="${isNew ? 12 : 8}" placeholder="What needs doing? (markdown supported, optional)">${escapeHtml(textValue)}</textarea>
        </label>`
      : detailText
        ? `<pre class="woo-tasks-detail-text">${escapeHtml(detailText)}</pre>`
        : `<p class="woo-tasks-detail-empty">No instructions.</p>`;

    // Disable Create until a non-empty name is typed. Save (edit mode) is
    // enabled by default — the user is editing an existing task that already
    // has a name; if they delete the name the `required` attr blocks submit.
    const trimmedDraftName = (draft?.name ?? "").trim();
    const submitDisabled = isNew && trimmedDraftName.length === 0;
    const formActions = (isNew || editing)
      ? `<div class="woo-tasks-detail-actions">
          <button type="button" data-tasks-detail-cancel class="woo-tasks-action">Cancel</button>
          <button type="submit" class="woo-tasks-primary-action"${submitDisabled ? " disabled" : ""}>${isNew ? "Create" : "Save"}</button>
        </div>`
      : "";

    // Per-step status: ✓ done, ▶ current (claimable by the step's role),
    // blank for upcoming. Role badge sits next to the name so the gating
    // is visible without hovering.
    const stepCount = detailObligations.length;
    const metCount = detailObligations.filter((o) => o.met).length;
    const stepsSummary = stepCount === 0
      ? ""
      : `<p class="woo-tasks-detail-section-help">Step ${Math.min(metCount + 1, stepCount)} of ${stepCount}. ${metCount === stepCount ? "All steps done." : "▶ marks the current step. Only people in that role can claim it and mark it done."}</p>`;
    const obligationsHtml = detailObligations.length === 0
      ? `<p class="woo-tasks-detail-empty">No steps configured for this task kind.</p>`
      : `${stepsSummary}<ol class="woo-tasks-detail-obligations">${detailObligations.map((o) => {
          const here = o.key === detailCursorKey;
          const flag = o.met ? "✓" : here ? "▶" : " ";
          const role = o.role ? `<span class="woo-tasks-detail-obligation-role" title="Role that owns this step">${escapeHtml(o.role)}</span>` : "";
          const criterion = o.criterion ? `<span class="woo-tasks-detail-obligation-criterion">${escapeHtml(o.criterion)}</span>` : "";
          return `<li class="woo-tasks-detail-obligation${o.met ? " met" : ""}${here ? " current" : ""}">
            <span class="woo-tasks-detail-obligation-flag" aria-hidden="true">${escapeHtml(flag)}</span>
            <span class="woo-tasks-detail-obligation-key">${escapeHtml(o.key)}</span>
            ${role}${criterion}
          </li>`;
        }).join("")}</ol>`;
    const logHtml = detailLog.length === 0
      ? `<p class="woo-tasks-detail-empty">No log entries.</p>`
      : `<ul class="woo-tasks-detail-log">${[...detailLog].reverse().map((entry) => {
          const ts = entry.ts ? new Date(entry.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
          const actorLabel = entry.actor ? actorDisplay(entry.actor, actorNames) : "—";
          const detailParts = [
            entry.obligationKey ? `<span class="woo-tasks-detail-log-key">${escapeHtml(entry.obligationKey)}</span>` : "",
            entry.why ? `<span class="woo-tasks-detail-log-why">${escapeHtml(entry.why)}</span>` : ""
          ].filter(Boolean).join(" ");
          return `<li class="woo-tasks-detail-log-entry">
            <span class="woo-tasks-detail-log-ts">${escapeHtml(ts)}</span>
            <span class="woo-tasks-detail-log-actor">${escapeHtml(actorLabel)}</span>
            <span class="woo-tasks-detail-log-outcome">${escapeHtml(formatLogOutcome(entry.outcome))}</span>
            ${detailParts}
          </li>`;
        }).join("")}</ul>`;
    const waitHtml = detailWaitFor.length === 0
      ? ""
      : `<section class="woo-tasks-detail-waitfor">
          <h4>Waiting on</h4>
          <ul>${detailWaitFor.map((w) => `<li>${escapeHtml(JSON.stringify(w))}</li>`).join("")}</ul>
        </section>`;
    const linksHtml = detailLinks.length === 0
      ? ""
      : `<section class="woo-tasks-detail-links">
          <h4>Links</h4>
          <ul>${detailLinks.map((l) => `<li>${escapeHtml(l.role ?? "link")} → ${escapeHtml(l.to ?? "—")}</li>`).join("")}</ul>
        </section>`;

    // Sections that only make sense for an existing, persisted task. New
    // tasks haven't been minted yet, so steps / log / waitFor / links
    // would be empty and confusing.
    const persistentSections = isNew ? "" : `
      <section class="woo-tasks-detail-section">
        <h4>Steps</h4>
        ${obligationsHtml}
      </section>
      ${waitHtml}
      ${linksHtml}
      <section class="woo-tasks-detail-section">
        <h4>Log</h4>
        ${logHtml}
      </section>
    `;

    // The × close button is redundant in new/edit mode (Cancel handles it
    // and is right next to Submit in form actions). In view mode there is
    // no Cancel button, so the × stays as the only way to dismiss.
    const closeButton = (isNew || editing)
      ? ""
      : `<button type="button" data-tasks-detail-close aria-label="Close">×</button>`;
    // In edit/new mode the field already has its own `<label>Task
    // instructions<textarea/></label>`, so wrapping it in another section
    // with `<h4>Task instructions</h4>` would be a duplicate. View mode
    // uses a `<pre>` or empty placeholder instead, so the section heading
    // is the only label there.
    const bodySection = (isNew || editing)
      ? bodyBlock
      : `<section class="woo-tasks-detail-section">
          <h4>Task instructions</h4>
          ${bodyBlock}
        </section>`;

    // Per-task actions (claim, release, pass, drop_terminal, ...) live on
    // the kanban listing's task.actions. They show in the dialog when
    // viewing an existing task — never on the cards themselves, never in
    // edit/new mode (where the form actions own the dialog footer).
    const viewingTask = (!isNew && !editing && detail)
      ? this.model.tasks.find((t) => t.id === detail.id)
      : undefined;
    const taskActions = viewingTask && viewingTask.actions.length > 0
      ? `<div class="woo-tasks-detail-task-actions" data-tasks-detail-task-actions>${
          viewingTask.actions.map((action) => {
            const needsArgs = action.args.some((arg) => arg.required);
            const flag = needsArgs ? ' data-tasks-action-needs-args="true"' : "";
            const { label, help } = actionPresentation(action.verb, action.label);
            const helpAttr = help ? ` title="${escapeHtml(help)}" aria-label="${escapeHtml(label)} — ${escapeHtml(help)}"` : "";
            return `<button type="button" class="woo-tasks-action" data-tasks-action="${escapeHtml(action.verb)}" data-task-id="${escapeHtml(viewingTask.id)}"${flag}${helpAttr}>${escapeHtml(label)}${needsArgs ? "…" : ""}</button>`;
          }).join("")
        }<button type="button" class="woo-tasks-action" data-tasks-action="write" data-task-id="${escapeHtml(viewingTask.id)}">Add comment…</button></div>`
      : "";
    const prompt = (viewingTask && this.openPrompt && this.openPrompt.taskId === viewingTask.id)
      ? this.renderPrompt(viewingTask, this.openPrompt.verb)
      : "";

    return `
      <div class="woo-tasks-modal-backdrop" data-tasks-modal-backdrop>
        <aside class="woo-tasks-detail woo-tasks-modal" data-tasks-detail data-task-id="${escapeHtml(dataTaskId)}" data-task-mode="${escapeHtml(mode)}" role="dialog" aria-modal="true">
          <form data-tasks-detail-form class="woo-tasks-detail-form">
            <header class="woo-tasks-detail-header">
              ${headerTitle}
              ${editToggle}
              ${closeButton}
            </header>
            <div class="woo-tasks-detail-meta">
              ${kindBlock}
              <span class="woo-tasks-detail-status">${escapeHtml(status)}</span>
            </div>
            ${labelsBlock}
            ${bodySection}
            ${formActions}
            ${taskActions}
            ${persistentSections}
          </form>
          ${prompt}
        </aside>
      </div>
    `;
  }

  private renderHeader(registryName: string): string {
    const { isOwner } = this.model;
    const adminBtn = (isOwner && !this.adminOpen)
      ? `<button type="button" data-tasks-admin-toggle aria-expanded="false">⚙ Admin</button>`
      : "";
    return `
      <section class="toolbar woo-tasks-toolbar">
        <h1>${escapeHtml(registryName)}</h1>
        ${adminBtn}
      </section>
    `;
  }

  private renderFilterBar(): string {
    const labels = Array.from(this.filterLabels);
    const canCreate = this.model.policies.length > 0 && !this.openDetail?.isNew;
    const groupOptions = GROUP_BY_ORDER.map((key) => {
      const selected = this.groupBy === key ? " selected" : "";
      return `<option value="${escapeHtml(key)}"${selected}>${escapeHtml(GROUP_BY_LABELS[key])}</option>`;
    }).join("");
    const chips = labels.map((label) => `
      <span class="woo-tasks-filter-chip" data-tasks-filter-chip>
        <span class="woo-tasks-filter-chip-label">${escapeHtml(label)}</span>
        <button type="button" data-tasks-filter-remove-label="${escapeHtml(label)}" aria-label="Remove ${escapeHtml(label)} filter">×</button>
      </span>
    `).join("");
    const hasFilter = this.filterText.length > 0 || labels.length > 0;
    const clear = hasFilter
      ? `<button type="button" data-tasks-filter-clear class="woo-tasks-filter-clear">Clear</button>`
      : "";
    const counts = statusCounts(this.model.tasks, this.model.registryId);
    const statusNav = `
      <div class="woo-tasks-status-nav" aria-label="Task status filters">
        ${STATE_COLUMN_ORDER.map((key) => `
          <button type="button" data-tasks-status-filter="${escapeHtml(key)}" class="${this.visibleStateColumns.has(key) ? "active" : ""}" aria-pressed="${this.visibleStateColumns.has(key) ? "true" : "false"}">
            <span>${escapeHtml(STATE_COLUMN_LABELS[key])}</span>
            <strong>${counts[key]}</strong>
          </button>
        `).join("")}
      </div>
    `;
    return `
      <div class="woo-tasks-kanban-filterbar">
        ${statusNav}
        <input type="search" data-tasks-filter-text placeholder="Search tasks…" value="${escapeHtml(this.filterText)}" autocomplete="off">
        <label class="woo-tasks-kanban-groupby">
          Organize cards by
          <select data-tasks-group-by aria-label="Organize cards by">${groupOptions}</select>
        </label>
        <div class="woo-tasks-filter-chips" data-tasks-filter-chips>${chips}</div>
        ${clear}
        ${canCreate ? `<button type="button" data-tasks-create-open class="woo-tasks-primary-action">+ New task</button>` : ""}
      </div>
    `;
  }

  private renderAdminPanel(): string {
    const { roles, obligations, policiesMap } = this.model;
    const roleNames = roles.map((r) => r.name);
    const obligationKeys = obligations.map((o) => o.key);
    const section = this.adminSection;
    // User-facing labels for each admin section. The internal model still
    // uses obligation/policy (catalog verb names, observation types) — the
    // rename is UI-only. "Step" makes the sequential, role-gated nature
    // legible; "Workflow" frames a policy as the recipe a task kind follows.
    const tabs: Array<{ key: AdminSection; label: string; count: number }> = [
      { key: "role", label: "Roles", count: roles.length },
      { key: "obligation", label: "Steps", count: obligations.length },
      { key: "policy", label: "Workflows", count: Object.keys(policiesMap).length }
    ];
    const rolesReady = roleNames.length > 0;
    // Each section's help leads with what *this* section is for, then
    // briefly frames how it fits with the other two — so the user gets
    // the full mental model from any tab without a separate overview block.
    const sectionHelp = section === "role"
      ? "A role groups people who do work. Members of a role can claim and finish the steps that role owns. (Steps belong to roles; workflows order steps.)"
      : section === "obligation"
        ? "A step is a named gate a task moves through. Each step belongs to a role; only members of that role can claim it and mark it done. (Workflows order steps; roles supply the people.)"
        : "A workflow is the ordered list of steps a task moves through. When you create a task, you pick a workflow; the task walks its steps in order. (Each step is owned by a role; only members of that role can claim and finish it.)";
    const table = section === "role"
      ? roles.length === 0
        ? `<p class="woo-tasks-admin-empty">No roles yet. Add one to start.</p>`
        : `<table class="woo-tasks-admin-table">
            <thead><tr><th>Name</th><th>Description</th><th>Members</th></tr></thead>
            <tbody>${roles.map((r) => `
              <tr tabindex="0" role="button" aria-label="Open role ${escapeHtml(r.name)}" data-tasks-admin-row data-tasks-admin-section="role" data-key="${escapeHtml(r.name)}">
                <td>${escapeHtml(r.name)}</td>
                <td>${escapeHtml(r.description || "—")}</td>
                <td>${escapeHtml(r.owners.join(", ") || "(no members)")}</td>
              </tr>`).join("")}</tbody>
          </table>`
      : section === "obligation"
        ? obligations.length === 0
          ? `<p class="woo-tasks-admin-empty">No steps yet. Add one to define what a task must do.</p>`
          : `<table class="woo-tasks-admin-table">
              <thead><tr><th>Name</th><th>Role</th><th>Conditions of satisfaction</th></tr></thead>
              <tbody>${obligations.map((o) => `
                <tr tabindex="0" role="button" aria-label="Open step ${escapeHtml(o.key)}" data-tasks-admin-row data-tasks-admin-section="obligation" data-key="${escapeHtml(o.key)}">
                  <td>${escapeHtml(o.key)}</td>
                  <td>${escapeHtml(o.role || "—")}</td>
                  <td>${escapeHtml(o.criterion || "—")}</td>
                </tr>`).join("")}</tbody>
            </table>`
        : Object.keys(policiesMap).length === 0
          ? `<p class="woo-tasks-admin-empty">No workflows yet. Add one to start minting tasks.</p>`
          : `<table class="woo-tasks-admin-table">
              <thead><tr><th>Workflow</th><th>Steps (in order)</th></tr></thead>
              <tbody>${Object.entries(policiesMap).map(([kind, keys]) => `
                <tr tabindex="0" role="button" aria-label="Open workflow ${escapeHtml(kind)}" data-tasks-admin-row data-tasks-admin-section="policy" data-key="${escapeHtml(kind)}">
                  <td>${escapeHtml(kind)}</td>
                  <td>${escapeHtml(keys.join(" → ") || "(empty)")}</td>
                </tr>`).join("")}</tbody>
            </table>`;
    return `
      <section class="woo-tasks-admin${this.adminEditing?.section === section ? " has-editor" : ""}">
        <div class="woo-tasks-admin-main">
          <div class="woo-tasks-admin-head">
            <div class="woo-tasks-admin-tabs" role="tablist" aria-label="Admin sections">
              ${tabs.map((tab) => `
                <button type="button" role="tab" data-tasks-admin-tab="${escapeHtml(tab.key)}" class="${tab.key === section ? "active" : ""}" aria-selected="${tab.key === section ? "true" : "false"}" title="${escapeHtml(tab.label)}"${!rolesReady && tab.key !== "role" ? " disabled" : ""}>
                  <span>${escapeHtml(tab.label)}</span>
                  <strong>${tab.count}</strong>
                </button>
              `).join("")}
            </div>
            <button type="button" data-tasks-admin-toggle aria-label="Close admin">×</button>
          </div>
          <div class="woo-tasks-admin-listhead">
            <h3>${escapeHtml(tabs.find((tab) => tab.key === section)?.label ?? "Admin")}</h3>
            <button type="button" class="woo-tasks-action" data-tasks-admin-new="${escapeHtml(section)}"${!rolesReady && section !== "role" ? " disabled" : ""}>New</button>
          </div>
          <p class="woo-tasks-admin-section-help">${escapeHtml(sectionHelp)}</p>
          ${this.renderAdminStatus(section)}
          <div class="woo-tasks-admin-tablewrap">${table}</div>
        </div>
        ${this.adminEditing?.section === section ? this.renderAdminEditor(roleNames, obligationKeys) : ""}
      </section>
    `;
  }

  private renderAdminEditor(roleNames: string[], obligationKeys: string[]): string {
    const editing = this.adminEditing;
    if (!editing) return "";
    // Map internal section name → user-facing singular noun. Keep this in
    // sync with the tab labels in renderAdminPanel.
    const sectionNoun: Record<AdminSection, string> = {
      role: "role",
      obligation: "step",
      policy: "workflow"
    };
    const noun = sectionNoun[editing.section];
    const title = editing.key ? `Edit ${noun}` : `New ${noun}`;
    const remove = editing.key
      ? `<button type="button" class="woo-tasks-danger-action" data-tasks-admin-remove="${escapeHtml(editing.section)}" data-key="${escapeHtml(editing.key)}">Remove</button>`
      : "";
    const body = editing.section === "role"
        ? `<form class="woo-tasks-admin-form" data-tasks-admin-form="role">
          <p class="woo-tasks-admin-form-help">A role groups people who can claim and finish the steps it owns. Add owner ids (people, wizards, or teams) below.</p>
          <label>Name<input type="text" name="name" value="${escapeHtml(this.adminDrafts.role.name)}" required autocomplete="off" placeholder="e.g. doer"${editing.mode === "edit" ? " readonly" : ""}></label>
          <label>Description <span class="woo-tasks-form-hint">(optional, shown in lists)</span><textarea name="description" rows="4" autocomplete="off">${escapeHtml(this.adminDrafts.role.description)}</textarea></label>
          <label>Members <span class="woo-tasks-form-hint">(comma-separated ids of actors who have this role, e.g. <code>$wiz, guest_1</code>)</span><input type="text" name="owners" value="${escapeHtml(this.adminDrafts.role.owners)}" autocomplete="off"></label>
          <div class="woo-tasks-admin-form-actions">
            ${remove}
            <button type="button" data-tasks-admin-edit-cancel class="woo-tasks-action">Cancel</button>
            <button type="submit" class="woo-tasks-action">${editing.mode === "new" ? "Add role" : "Update role"}</button>
          </div>
        </form>`
        : editing.section === "obligation"
          ? `<form class="woo-tasks-admin-form" data-tasks-admin-form="obligation">
            <p class="woo-tasks-admin-form-help">A step is a named gate. Tasks move through it in workflow order; only people in the listed role can claim it and mark it done.</p>
            <label>Name <span class="woo-tasks-form-hint">(short id, e.g. <code>do:it</code> or <code>review</code>)</span><input type="text" name="key" value="${escapeHtml(this.adminDrafts.obligation.key)}" required autocomplete="off"${editing.mode === "edit" ? " readonly" : ""}></label>
            <label>Role <span class="woo-tasks-form-hint">(who can claim and finish this step — must already exist)</span><select name="role" required>${roleNames.length === 0 ? `<option value="" disabled selected>no roles yet</option>` : roleNames.map((n) => `<option value="${escapeHtml(n)}"${n === (this.adminDrafts.obligation.role || roleNames[0] || "") ? " selected" : ""}>${escapeHtml(n)}</option>`).join("")}</select></label>
            <label>Conditions of satisfaction <span class="woo-tasks-form-hint">(what 'done' looks like — shown to whoever takes the step)</span><textarea name="criterion" rows="4" required autocomplete="off" placeholder="e.g. Code reviewed and merged">${escapeHtml(this.adminDrafts.obligation.criterion)}</textarea></label>
            <div class="woo-tasks-admin-form-actions">
              ${remove}
              <button type="button" data-tasks-admin-edit-cancel class="woo-tasks-action">Cancel</button>
              <button type="submit" class="woo-tasks-action"${roleNames.length === 0 ? " disabled" : ""}>${editing.mode === "new" ? "Add step" : "Update step"}</button>
            </div>
          </form>`
          : `<form class="woo-tasks-admin-form" data-tasks-admin-form="policy">
            <p class="woo-tasks-admin-form-help">A workflow is the ordered checklist of steps a task moves through. Tasks pick a workflow by name when they're created.</p>
            <label>Workflow name <span class="woo-tasks-form-hint">(short name tasks use to pick this workflow, e.g. <code>bug</code> or <code>feature</code>)</span><input type="text" name="kind" value="${escapeHtml(this.adminDrafts.policy.kind)}" required autocomplete="off"></label>
            <label>Available steps <span class="woo-tasks-form-hint">(pick one or more)</span>
              <div class="woo-tasks-policy-picker">
                ${obligationKeys.length === 0
                  ? `<p class="woo-tasks-admin-empty">No steps available.</p>`
                  : obligationKeys.map((k) => `<button type="button" class="woo-tasks-action"${this.adminDrafts.policy.keys.includes(k) ? " disabled" : ""} data-tasks-policy-add-step="${escapeHtml(k)}">${escapeHtml(k)}</button>`).join("")}
              </div>
            </label>
            <label>Selected steps (drag to reorder) <span class="woo-tasks-form-hint">(this order defines the workflow)</span>
              <ol class="woo-tasks-policy-order">
                ${this.adminDrafts.policy.keys.length === 0
                  ? `<li class="woo-tasks-admin-empty">No steps selected.</li>`
                  : this.adminDrafts.policy.keys.map((k, i) => `<li draggable="true" data-tasks-policy-order-item="${i}"><span>${escapeHtml(k)}</span><button type="button" class="woo-tasks-danger-action" data-tasks-policy-remove-step="${i}">Remove</button></li>`).join("")}
              </ol>
            </label>
            <div class="woo-tasks-admin-form-actions">
              ${remove}
            <button type="button" data-tasks-admin-edit-cancel class="woo-tasks-action">Cancel</button>
            <button type="submit" class="woo-tasks-action"${this.adminDrafts.policy.keys.length === 0 ? " disabled" : ""}>${editing.mode === "new" ? "Add workflow" : "Update workflow"}</button>
            </div>
            </form>`;
    return `
      <div class="woo-tasks-modal-backdrop" data-tasks-modal-backdrop>
        <aside class="woo-tasks-admin-editor woo-tasks-modal" role="dialog" aria-modal="true">
          <div class="woo-tasks-admin-editor-head">
            <h3>${escapeHtml(title)}</h3>
            <button type="button" data-tasks-admin-edit-cancel aria-label="Close">×</button>
          </div>
          ${body}
        </aside>
      </div>
    `;
  }

  private renderAdminStatus(section: AdminSection): string {
    const status = this.adminStatus[section];
    if (status.state === "idle" || !status.message) return "";
    return `<p class="woo-tasks-admin-status ${escapeHtml(status.state)}" role="status">${escapeHtml(status.message)}</p>`;
  }

  private renderCard(task: KanbanTask, actorNames: Record<string, string>): string {
    const cursorBadge = task.cursorRole
      ? `<span class="woo-tasks-card-cursor" data-tasks-card-cursor="${escapeHtml(task.cursorRole)}">${escapeHtml(task.cursorRole)}</span>`
      : "";
    const labels = task.labels
      .filter((label) => typeof label === "string" && label.length > 0)
      .slice(0, 3)
      .map((label) => {
        const active = this.filterLabels.has(label);
        return `<button type="button" class="woo-tasks-card-label${active ? " active" : ""}" data-tasks-filter-add-label="${escapeHtml(label)}"${active ? " disabled" : ""}>${escapeHtml(label)}</button>`;
      })
      .join("");
    const holder = task.location && task.location !== this.model.registryId
      ? `<span class="woo-tasks-card-holder">with ${escapeHtml(actorDisplay(task.location, actorNames))}</span>`
      : "";
    const meta = [
      task.kind ? `<span class="woo-tasks-card-kind">${escapeHtml(task.kind)}</span>` : "",
      cursorBadge,
      holder,
      `<span class="woo-tasks-card-age">${escapeHtml(formatAge(task.ageMs))}</span>`
    ].filter(Boolean).join("");
    return `
      <article class="woo-tasks-card${this.openDetail?.taskId === task.id ? " selected" : ""}" data-tasks-card="${escapeHtml(task.id)}" tabindex="0" role="button" aria-label="Open task ${escapeHtml(task.name || task.id)}">
        <header class="woo-tasks-card-header">
          <h3 class="woo-tasks-card-name">${escapeHtml(task.name || task.id)}</h3>
        </header>
        <div class="woo-tasks-card-meta">${meta}</div>
        ${labels ? `<div class="woo-tasks-card-labels">${labels}</div>` : ""}
      </article>
    `;
  }

  private renderPrompt(task: KanbanTask, verb: string): string {
    const action = this.findAction(task.id, verb);
    if (!action) return "";
    const detail = this.openDetail?.taskId === task.id ? this.openDetail.detail : null;
    const completedSteps = detail?.obligations
      .map((o, index) => ({ o, index: index + 1 }))
      .filter((entry) => entry.o.met) ?? [];
    const fields = action.verb === "reject"
      ? `
        <label class="woo-tasks-prompt-field">
          <span class="woo-tasks-prompt-label">Step to reopen</span>
          <select name="reject_index" required>
            ${completedSteps.length === 0
              ? `<option value="" disabled selected>No completed steps yet</option>`
              : completedSteps.map((entry) => `<option value="${entry.index}">${escapeHtml(entry.o.key)}</option>`).join("")}
          </select>
        </label>
        <label class="woo-tasks-prompt-field">
          <span class="woo-tasks-prompt-label">Why</span>
          <textarea name="why" required></textarea>
        </label>
      `
      : action.verb === "wait"
        ? `
          <label class="woo-tasks-prompt-field">
            <span class="woo-tasks-prompt-label">Blocked by</span>
            <select name="wait_kind" required>
              <option value="dependency">Dependency</option>
              <option value="review">Review/approval</option>
              <option value="external">External blocker</option>
              <option value="information">Missing information</option>
            </select>
          </label>
          <label class="woo-tasks-prompt-field">
            <span class="woo-tasks-prompt-label">Details</span>
            <textarea name="wait_note" placeholder="What needs to happen before this can continue?"></textarea>
          </label>
          <label class="woo-tasks-prompt-field">
            <span class="woo-tasks-prompt-label">Blocking task id (optional)</span>
            <input type="text" name="wait_task" placeholder="task id">
          </label>
        `
        : action.args.map((arg) => {
      const required = arg.required ? " required" : "";
      const placeholder = arg.type === "map" || arg.type === "list" ? "JSON literal" : arg.type;
      return `
        <label class="woo-tasks-prompt-field">
          <span class="woo-tasks-prompt-label">${escapeHtml(arg.name)}<span class="woo-tasks-prompt-type"> (${escapeHtml(arg.type)})</span></span>
          ${arg.type === "str" || arg.type === "map" || arg.type === "list" || arg.type === "any"
            ? `<textarea name="${escapeHtml(arg.name)}" placeholder="${escapeHtml(placeholder)}"${required}></textarea>`
            : `<input type="text" name="${escapeHtml(arg.name)}" placeholder="${escapeHtml(placeholder)}"${required}>`}
        </label>
      `;
    }).join("");
    const { label: promptLabel, help: promptHelp } = actionPresentation(action.verb, action.label);
    const disabled = action.verb === "reject" && completedSteps.length === 0 ? " disabled" : "";
    return `
      <form class="woo-tasks-prompt" data-tasks-prompt data-task-id="${escapeHtml(task.id)}" data-verb="${escapeHtml(action.verb)}">
        <div class="woo-tasks-prompt-header">${escapeHtml(promptLabel)}</div>
        ${promptHelp ? `<p class="woo-tasks-prompt-help">${escapeHtml(promptHelp)}</p>` : ""}
        ${fields}
        <div class="woo-tasks-prompt-actions">
          <button type="submit" data-tasks-prompt-submit class="woo-tasks-action"${disabled}>Submit</button>
          <button type="button" data-tasks-prompt-cancel class="woo-tasks-action">Cancel</button>
        </div>
      </form>
    `;
  }
}

export function registerWooComponents(registry: WooComponentRegistry): void {
  registry.defineTag("woo-tasks-kanban", WooTasksKanbanElement);
}

// Observation-driven refresh. A task mutation (claim, pass, drop, ...) or a
// registry-policy edit lands as an observation; we fan it out as a window
// event and any mounted woo-tasks-kanban refreshes its directCall-derived
// view. Replaces the 3s setInterval poll. Reduce is a no-op against the
// projection — refreshes go through directCall, not projection state — but
// the registry still routes the observation here because we declared the
// types.
export function registerWooObservationHandlers(registry: ObservationRegistry): void {
  registry.observation({
    types: TASK_OBSERVATION_TYPES,
    route: "both",
    reduce: () => {
      if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
      window.dispatchEvent(new CustomEvent(TASKS_REFRESH_EVENT));
    }
  });
}
