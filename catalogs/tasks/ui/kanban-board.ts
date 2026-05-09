import { escapeHtml, type WooComponentRegistry, type WooContext } from "../../../src/client/framework";

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
type AdminPanelMode = "view" | "edit" | "new";
type AdminDrafts = {
  role: { name: string; description: string; owners: string };
  obligation: { key: string; role: string; criterion: string };
  policy: { kind: string; keys: string };
};
type AdminSection = keyof AdminDrafts;
type AdminStatus = { state: "idle" | "pending" | "success" | "error"; message: string };
type AdminEditing = { section: AdminSection; key: string | null; mode: AdminPanelMode };

export type GroupBy = "state" | "role" | "holder" | "kind";

const DRAG_VERB_BY_TRANSITION: Partial<Record<`${StateColumnId}->${StateColumnId}`, string>> = {
  "ready->in_flight": "claim",
  "in_flight->ready": "release",
  "in_flight->dropped": "drop_terminal"
};

const STATE_COLUMN_LABELS: Record<StateColumnId, string> = {
  ready: "Ready",
  waiting: "Waiting",
  in_flight: "In flight",
  done: "Done",
  dropped: "Dropped"
};

const STATE_COLUMN_ORDER: StateColumnId[] = ["ready", "waiting", "in_flight", "done", "dropped"];
const DEFAULT_VISIBLE_STATE_COLUMNS: StateColumnId[] = ["ready", "waiting", "in_flight"];

const GROUP_BY_LABELS: Record<GroupBy, string> = {
  state: "State",
  role: "Role",
  holder: "Holder",
  kind: "Kind"
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

const DEFAULT_REFRESH_INTERVAL_MS = 3000;

export class WooTasksKanbanElement extends HTMLElement {
  woo?: WooContext;
  subject?: string;
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
  private boundDrag = false;
  private boundSubmit = false;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private openPrompt: { taskId: string; verb: string } | null = null;
  private adminOpen = false;
  private adminSection: AdminSection = "role";
  private adminEditing: AdminEditing | null = null;
  private adminDrafts: AdminDrafts = {
    role: { name: "", description: "", owners: "" },
    obligation: { key: "", role: "", criterion: "" },
    policy: { kind: "", keys: "" }
  };
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
    if (!this.boundDrag) {
      this.addEventListener("dragstart", this.handleDragStart);
      this.addEventListener("dragover", this.handleDragOver);
      this.addEventListener("drop", this.handleDrop);
      this.addEventListener("dragend", this.handleDragEnd);
      this.boundDrag = true;
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
    if (this.woo) void this.refresh();
    this.startPolling();
  }

  disconnectedCallback(): void {
    if (this.boundClick) {
      this.removeEventListener("click", this.handleClick);
      this.boundClick = false;
    }
    if (this.boundDrag) {
      this.removeEventListener("dragstart", this.handleDragStart);
      this.removeEventListener("dragover", this.handleDragOver);
      this.removeEventListener("drop", this.handleDrop);
      this.removeEventListener("dragend", this.handleDragEnd);
      this.boundDrag = false;
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
    this.stopPolling();
  }

  private startPolling(): void {
    this.stopPolling();
    const intervalMs = this.pollIntervalMs();
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this.pollHandle = setInterval(() => {
      if (this.isConnected && this.woo) void this.refresh();
    }, intervalMs);
  }

  private stopPolling(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private pollIntervalMs(): number {
    const attr = this.getAttribute("refresh-interval-ms");
    if (attr !== null) {
      const parsed = Number(attr);
      if (Number.isFinite(parsed)) return parsed;
    }
    return DEFAULT_REFRESH_INTERVAL_MS;
  }

  static get observedAttributes(): string[] {
    return ["refresh-interval-ms"];
  }

  attributeChangedCallback(name: string): void {
    if (name === "refresh-interval-ms" && this.isConnected) this.startPolling();
  }

  async refresh(): Promise<void> {
    const woo = this.woo;
    const subject = this.subject ?? this.model.registryId;
    if (!woo || !subject) return;
    const projected = woo.observe(subject);
    const registryName = projected?.name ?? this.model.registryName ?? subject;
    const actor = woo.actor ?? this.model.actor;
    const actorNames = this.collectActorNames(woo, projected);
    let listing: unknown;
    try {
      listing = await woo.directCall(subject, "listing", []);
    } catch {
      return;
    }
    if (!Array.isArray(listing)) return;
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
    const rawPolicies = props.policies;
    const policiesMap: Record<string, string[]> = {};
    if (rawPolicies && typeof rawPolicies === "object" && !Array.isArray(rawPolicies)) {
      for (const [kind, keys] of Object.entries(rawPolicies as Record<string, unknown>)) {
        if (Array.isArray(keys)) policiesMap[kind] = keys.filter((k): k is string => typeof k === "string");
      }
    }
    const policies = Object.keys(policiesMap);
    const rawRoles = props.roles;
    const roles: RegistryRole[] = [];
    if (rawRoles && typeof rawRoles === "object" && !Array.isArray(rawRoles)) {
      for (const [name, info] of Object.entries(rawRoles as Record<string, unknown>)) {
        const i = info && typeof info === "object" && !Array.isArray(info) ? info as Record<string, unknown> : {};
        roles.push({
          name,
          description: typeof i.description === "string" ? i.description : "",
          owners: Array.isArray(i.owners) ? i.owners.filter((o): o is string => typeof o === "string") : []
        });
      }
    }
    const rawObs = props.obligations;
    const obligations: RegistryObligation[] = [];
    if (rawObs && typeof rawObs === "object" && !Array.isArray(rawObs)) {
      for (const [key, info] of Object.entries(rawObs as Record<string, unknown>)) {
        const i = info && typeof info === "object" && !Array.isArray(info) ? info as Record<string, unknown> : {};
        obligations.push({
          key,
          role: typeof i.role === "string" ? i.role : "",
          criterion: typeof i.criterion === "string" ? i.criterion : ""
        });
      }
    }
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
      this.openDetail = null;
      this.detailDraft = null;
      this.render();
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
      if (section === "role" || section === "obligation" || section === "policy") {
        this.adminSection = section;
        this.prepareAdminEditor(section, null, "new");
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
        this.prepareAdminEditor(section, key || null, "view");
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
    const button = target.closest<HTMLButtonElement>("[data-tasks-action]");
    if (!button) {
      const card = target.closest<HTMLElement>("[data-tasks-card]");
      if (card && !target.closest("[data-tasks-card-actions]") && !target.closest("[data-tasks-prompt]")) {
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
    const action = this.model.tasks
      .find((task) => task.id === taskId)?.actions
      .find((entry) => entry.verb === verb);
    if (!action) return;
    event.preventDefault();
    this.dispatchEvent(new CustomEvent("woo-tasks-action", {
      bubbles: true,
      detail: { taskId, verb: action.verb, label: action.label, args: action.args }
    }));
    if (action.args.some((arg) => arg.required)) {
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
    const active = this.ownerDocument.activeElement;
    if (!(active instanceof HTMLElement) || !this.contains(active)) return false;
    if (active.closest("[data-tasks-prompt]")) return true;
    if (active.closest("[data-tasks-detail-form]")) return true;
    if (active.closest("[data-tasks-admin-form]")) return true;
    if (active.matches("[data-tasks-filter-text]")) return true;
    return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
  }

  private captureDraftInput(target: HTMLElement | null): void {
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    const detailForm = target.closest<HTMLFormElement>("[data-tasks-detail-form]");
    if (detailForm && this.detailDraft) {
      const name = target.name as keyof CreateDraft;
      if (name === "kind" || name === "name" || name === "text" || name === "labels") this.detailDraft[name] = target.value;
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
      if (name === "kind" || name === "keys") this.adminDrafts.policy[name] = target.value;
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
        ? { kind: key, keys: keys.join(", ") }
        : { kind: "", keys: "" };
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
    const action = this.model.tasks
      .find((task) => task.id === taskId)?.actions
      .find((entry) => entry.verb === verb);
    if (!action) return;
    const args = action.args.map((arg) => {
      const input = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${cssEscape(arg.name)}"]`);
      const raw = input?.value ?? "";
      return coerceArg(raw, arg.type);
    });
    this.closePrompt();
    void this.invokeAction(taskId, action, args);
  };

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
      const description = (form.querySelector<HTMLInputElement>('input[name="description"]')?.value ?? "").trim();
      const ownersRaw = (form.querySelector<HTMLInputElement>('input[name="owners"]')?.value ?? "").trim();
      this.adminDrafts.role = { name, description, owners: ownersRaw };
      const owners = ownersRaw.split(",").map((s) => s.trim()).filter(Boolean);
      if (!name) return;
      // Optimistic patch + reset draft to "new" mode so the form's ready for
      // the next entry while the server confirms in the background.
      const wasNew = this.adminEditing?.section === "role" && this.adminEditing.mode === "new";
      const existingIdx = this.model.roles.findIndex((r) => r.name === name);
      if (existingIdx >= 0) this.model.roles[existingIdx] = { name, description, owners };
      else this.model.roles.push({ name, description, owners });
      if (wasNew) this.adminDrafts.role = { name: "", description: "", owners: "" };
      else this.adminDrafts.role = { name, description, owners: ownersRaw };
      if (this.adminEditing?.section === "role") this.adminEditing = { section: "role", key: name, mode: "edit" };
      this.setAdminStatus("role", "success", `Saved role "${name}".`);
      try {
        await woo.directCall(subject, "set_role", [name, { description, owners }]);
      } catch (err) {
        this.setAdminStatus("role", "error", `Could not save role "${name}": ${errorMessage(err)}`);
      }
      void this.refresh();
      return;
    }
    if (kind === "obligation") {
      const key = (form.querySelector<HTMLInputElement>('input[name="key"]')?.value ?? "").trim();
      const role = (form.querySelector<HTMLSelectElement>('select[name="role"]')?.value ?? "").trim();
      const criterion = (form.querySelector<HTMLInputElement>('input[name="criterion"]')?.value ?? "").trim();
      this.adminDrafts.obligation = { key, role, criterion };
      if (!key || !role || !criterion) return;
      const wasNew = this.adminEditing?.section === "obligation" && this.adminEditing.mode === "new";
      const existingIdx = this.model.obligations.findIndex((o) => o.key === key);
      if (existingIdx >= 0) this.model.obligations[existingIdx] = { key, role, criterion };
      else this.model.obligations.push({ key, role, criterion });
      if (wasNew) this.adminDrafts.obligation = { key: "", role: this.model.roles[0]?.name ?? "", criterion: "" };
      else this.adminDrafts.obligation = { key, role, criterion };
      if (this.adminEditing?.section === "obligation") this.adminEditing = { section: "obligation", key, mode: "edit" };
      this.setAdminStatus("obligation", "success", `Saved obligation "${key}".`);
      try {
        await woo.directCall(subject, "set_obligation", [key, { role, criterion }]);
      } catch (err) {
        this.setAdminStatus("obligation", "error", `Could not save obligation "${key}": ${errorMessage(err)}`);
      }
      void this.refresh();
      return;
    }
    if (kind === "policy") {
      const policyKind = (form.querySelector<HTMLInputElement>('input[name="kind"]')?.value ?? "").trim();
      const keysRaw = (form.querySelector<HTMLInputElement>('input[name="keys"]')?.value ?? "").trim();
      this.adminDrafts.policy = { kind: policyKind, keys: keysRaw };
      const keys = keysRaw.split(",").map((s) => s.trim()).filter(Boolean);
      if (!policyKind || keys.length === 0) return;
      const wasNew = this.adminEditing?.section === "policy" && this.adminEditing.mode === "new";
      this.model.policiesMap[policyKind] = keys;
      if (!this.model.policies.includes(policyKind)) this.model.policies = [...this.model.policies, policyKind];
      if (wasNew) this.adminDrafts.policy = { kind: "", keys: "" };
      else this.adminDrafts.policy = { kind: policyKind, keys: keysRaw };
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

  private handleDragStart = (event: DragEvent): void => {
    const target = event.target as HTMLElement | null;
    const card = target?.closest<HTMLElement>("[data-tasks-card]");
    if (!card || !event.dataTransfer) return;
    const taskId = card.dataset.tasksCard ?? "";
    const sourceCol = card.closest<HTMLElement>("[data-tasks-col]")?.dataset.tasksCol ?? "";
    if (!taskId || !sourceCol) return;
    event.dataTransfer.setData("application/x-woo-task", taskId);
    event.dataTransfer.setData("application/x-woo-task-source-col", sourceCol);
    event.dataTransfer.effectAllowed = "move";
    card.dataset.tasksDragging = "true";
  };

  private handleDragEnd = (event: DragEvent): void => {
    const card = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-tasks-card]");
    if (card) delete card.dataset.tasksDragging;
    for (const col of Array.from(this.querySelectorAll<HTMLElement>("[data-tasks-col]"))) {
      delete col.dataset.tasksDropTarget;
    }
  };

  private handleDragOver = (event: DragEvent): void => {
    if (this.groupBy !== "state") return;
    const col = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-tasks-col]");
    if (!col || !event.dataTransfer) return;
    const sourceCol = event.dataTransfer.getData("application/x-woo-task-source-col") as StateColumnId | "";
    const targetCol = (col.dataset.tasksCol ?? "") as StateColumnId | "";
    if (!sourceCol || !targetCol || sourceCol === targetCol) return;
    if (!DRAG_VERB_BY_TRANSITION[`${sourceCol}->${targetCol}`]) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    col.dataset.tasksDropTarget = "true";
  };

  private handleDrop = (event: DragEvent): void => {
    if (this.groupBy !== "state") return;
    const col = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-tasks-col]");
    if (!col || !event.dataTransfer) return;
    const taskId = event.dataTransfer.getData("application/x-woo-task");
    const sourceCol = event.dataTransfer.getData("application/x-woo-task-source-col") as StateColumnId | "";
    const targetCol = (col.dataset.tasksCol ?? "") as StateColumnId | "";
    if (!taskId || !sourceCol || !targetCol) return;
    const verb = DRAG_VERB_BY_TRANSITION[`${sourceCol}->${targetCol}`];
    if (!verb) return;
    event.preventDefault();
    delete col.dataset.tasksDropTarget;
    const action = this.model.tasks
      .find((task) => task.id === taskId)?.actions
      .find((entry) => entry.verb === verb);
    if (!action) return;
    this.dispatchEvent(new CustomEvent("woo-tasks-action", {
      bubbles: true,
      detail: { taskId, verb: action.verb, label: action.label, args: action.args, source: "drag" }
    }));
    if (action.args.some((arg) => arg.required)) {
      this.openPromptFor(taskId, action.verb);
      return;
    }
    void this.invokeAction(taskId, action, []);
  };

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
      : `${this.renderFilterBar(tasks.length)}
          <section class="woo-tasks-kanban" aria-label="Task board">
            <div class="woo-tasks-kanban-columns">${columnsHtml}</div>
          </section>`;
    const board = `
      <section class="woo-tasks-workspace has-space-chat" data-space-chat-layout="${escapeHtml(registryId)}">
        ${this.renderHeader(registryName || "Tasks")}
        <div class="woo-tasks-workarea">
          <div class="woo-tasks-board${this.adminOpen ? " has-admin" : ""}">
            ${boardContent}
          </div>
          ${!this.adminOpen && this.openDetail ? this.renderDetailPanel(actorNames) : ""}
        </div>
      </section>
    `;
    this.innerHTML = `
      <section class="space-chat-shell" data-space-chat-shell="${escapeHtml(registryId)}">
        ${board}
        <div data-tool-space-chat></div>
      </section>
    `;
    this.dispatchEvent(new CustomEvent("woo-tasks-rendered", { bubbles: true }));
  }

  private renderDetailPanel(actorNames: Record<string, string>): string {
    const open = this.openDetail;
    if (!open) return "";
    const isNew = !!open.isNew;
    if (!isNew && open.loading) {
      return `
        <aside class="woo-tasks-detail" data-tasks-detail data-task-id="${escapeHtml(open.taskId)}">
          <header class="woo-tasks-detail-header">
            <h3>${escapeHtml(open.taskId)}</h3>
            <button type="button" data-tasks-detail-close aria-label="Close">×</button>
          </header>
          <div class="woo-tasks-detail-body"><p>Loading…</p></div>
        </aside>
      `;
    }
    if (!isNew && !open.detail) {
      const message = open.error ? `Failed to load task: ${open.error}` : "No detail returned.";
      return `
        <aside class="woo-tasks-detail" data-tasks-detail data-task-id="${escapeHtml(open.taskId)}">
          <header class="woo-tasks-detail-header">
            <h3>${escapeHtml(open.taskId)}</h3>
            <button type="button" data-tasks-detail-close aria-label="Close">×</button>
          </header>
          <div class="woo-tasks-detail-body"><p>${escapeHtml(message)}</p></div>
        </aside>
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
          ? "dropped"
          : detailLocation && detailLocation !== this.model.registryId
            ? `held by ${actorDisplay(detailLocation, actorNames)}`
            : "ready";

    const headerTitle = (isNew || editing)
      ? `<input class="woo-tasks-detail-name-input" type="text" name="name" value="${escapeHtml(draft?.name ?? detailName)}" placeholder="Task name" required autocomplete="off">`
      : `<span class="woo-tasks-detail-name">${escapeHtml(detailName || detailId)}</span>`;
    const editToggle = (!isNew && !editing)
      ? `<button type="button" data-tasks-detail-edit-toggle class="woo-tasks-detail-edit-toggle">Edit</button>`
      : "";

    const policyOptions = this.model.policies
      .map((kind) => `<option value="${escapeHtml(kind)}"${kind === (draft?.kind ?? detailKind) ? " selected" : ""}>${escapeHtml(kind)}</option>`)
      .join("");
    const kindBlock = isNew
      ? `<label class="woo-tasks-detail-field">
          <span class="woo-tasks-detail-field-label">Kind</span>
          <select name="kind" required>${policyOptions}</select>
        </label>`
      : `<span class="woo-tasks-detail-kind">${escapeHtml(detailKind || "task")}</span>`;

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
          <span class="woo-tasks-detail-field-label">Body</span>
          <textarea name="text" rows="${isNew ? 12 : 8}" placeholder="markdown body (optional)">${escapeHtml(textValue)}</textarea>
        </label>`
      : detailText
        ? `<pre class="woo-tasks-detail-text">${escapeHtml(detailText)}</pre>`
        : `<p class="woo-tasks-detail-empty">No body.</p>`;

    const formActions = (isNew || editing)
      ? `<div class="woo-tasks-detail-actions">
          <button type="button" data-tasks-detail-cancel>Cancel</button>
          <button type="submit" class="woo-tasks-primary-action">${isNew ? "Create" : "Save"}</button>
        </div>`
      : "";

    const obligationsHtml = detailObligations.length === 0
      ? `<p class="woo-tasks-detail-empty">No obligations.</p>`
      : `<ol class="woo-tasks-detail-obligations">${detailObligations.map((o) => {
          const here = o.key === detailCursorKey;
          const flag = o.met ? "✓" : here ? "▶" : " ";
          const role = o.role ? `<span class="woo-tasks-detail-obligation-role">${escapeHtml(o.role)}</span>` : "";
          const criterion = o.criterion ? `<span class="woo-tasks-detail-obligation-criterion">${escapeHtml(o.criterion)}</span>` : "";
          return `<li class="woo-tasks-detail-obligation${o.met ? " met" : ""}${here ? " current" : ""}">
            <span class="woo-tasks-detail-obligation-flag">${escapeHtml(flag)}</span>
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
            <span class="woo-tasks-detail-log-outcome">${escapeHtml(entry.outcome)}</span>
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
    // tasks haven't been minted yet, so obligations / log / waitFor / links
    // would be empty and confusing.
    const persistentSections = isNew ? "" : `
      <section class="woo-tasks-detail-section">
        <h4>Obligations</h4>
        ${obligationsHtml}
      </section>
      ${waitHtml}
      ${linksHtml}
      <section class="woo-tasks-detail-section">
        <h4>Log</h4>
        ${logHtml}
      </section>
    `;

    return `
      <aside class="woo-tasks-detail" data-tasks-detail data-task-id="${escapeHtml(dataTaskId)}" data-task-mode="${escapeHtml(mode)}">
        <form data-tasks-detail-form class="woo-tasks-detail-form">
          <header class="woo-tasks-detail-header">
            ${headerTitle}
            ${editToggle}
            <button type="button" data-tasks-detail-close aria-label="Close">×</button>
          </header>
          <div class="woo-tasks-detail-meta">
            ${kindBlock}
            <span class="woo-tasks-detail-status">${escapeHtml(status)}</span>
          </div>
          ${labelsBlock}
          <section class="woo-tasks-detail-section">
            <h4>Body</h4>
            ${bodyBlock}
          </section>
          ${formActions}
          ${persistentSections}
        </form>
      </aside>
    `;
  }

  private renderHeader(registryName: string): string {
    const { isOwner } = this.model;
    const buttons: string[] = [];
    if (isOwner && !this.adminOpen) {
      buttons.push(`<button type="button" data-tasks-admin-toggle aria-expanded="false">⚙ Admin</button>`);
    }
    const toolbar = buttons.filter(Boolean).join("");
    const counts = statusCounts(this.model.tasks, this.model.registryId);
    return `
      <header class="woo-tasks-kanban-header">
        <div class="woo-tasks-titleblock">
          <h2>${escapeHtml(registryName)}</h2>
          <div class="woo-tasks-status-nav" aria-label="Task status filters">
            ${STATE_COLUMN_ORDER.map((key) => `
              <button type="button" data-tasks-status-filter="${escapeHtml(key)}" class="${this.visibleStateColumns.has(key) ? "active" : ""}" aria-pressed="${this.visibleStateColumns.has(key) ? "true" : "false"}">
                <span>${escapeHtml(STATE_COLUMN_LABELS[key])}</span>
                <strong>${counts[key]}</strong>
              </button>
            `).join("")}
          </div>
        </div>
        <div class="woo-tasks-kanban-toolbar">${toolbar}</div>
      </header>
    `;
  }

  private renderFilterBar(visibleCount = this.filteredTasks().length): string {
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
    return `
      <div class="woo-tasks-kanban-filterbar">
        <input type="search" data-tasks-filter-text placeholder="Search tasks…" value="${escapeHtml(this.filterText)}" autocomplete="off">
        <label class="woo-tasks-kanban-groupby">
          Group by
          <select data-tasks-group-by aria-label="Group tasks by">${groupOptions}</select>
        </label>
        <div class="woo-tasks-filter-chips" data-tasks-filter-chips>${chips}</div>
        <span class="woo-tasks-filter-count">${visibleCount} / ${this.model.tasks.length}</span>
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
    const tabs: Array<{ key: AdminSection; label: string; count: number }> = [
      { key: "role", label: "Roles", count: roles.length },
      { key: "obligation", label: "Obligations", count: obligations.length },
      { key: "policy", label: "Policies", count: Object.keys(policiesMap).length }
    ];
    const table = section === "role"
      ? roles.length === 0
        ? `<p class="woo-tasks-admin-empty">No roles.</p>`
        : `<table class="woo-tasks-admin-table">
            <thead><tr><th>Name</th><th>Description</th><th>Owners</th></tr></thead>
            <tbody>${roles.map((r) => `
              <tr data-tasks-admin-row data-tasks-admin-section="role" data-key="${escapeHtml(r.name)}">
                <td>${escapeHtml(r.name)}</td>
                <td>${escapeHtml(r.description || "—")}</td>
                <td>${escapeHtml(r.owners.join(", ") || "(no owners)")}</td>
              </tr>`).join("")}</tbody>
          </table>`
      : section === "obligation"
        ? obligations.length === 0
          ? `<p class="woo-tasks-admin-empty">No obligations.</p>`
          : `<table class="woo-tasks-admin-table">
              <thead><tr><th>Key</th><th>Role</th><th>Criterion</th></tr></thead>
              <tbody>${obligations.map((o) => `
                <tr data-tasks-admin-row data-tasks-admin-section="obligation" data-key="${escapeHtml(o.key)}">
                  <td>${escapeHtml(o.key)}</td>
                  <td>${escapeHtml(o.role || "—")}</td>
                  <td>${escapeHtml(o.criterion || "—")}</td>
                </tr>`).join("")}</tbody>
            </table>`
        : Object.keys(policiesMap).length === 0
          ? `<p class="woo-tasks-admin-empty">No policies.</p>`
          : `<table class="woo-tasks-admin-table">
              <thead><tr><th>Task kind</th><th>Obligation order</th></tr></thead>
              <tbody>${Object.entries(policiesMap).map(([kind, keys]) => `
                <tr data-tasks-admin-row data-tasks-admin-section="policy" data-key="${escapeHtml(kind)}">
                  <td>${escapeHtml(kind)}</td>
                  <td>${escapeHtml(keys.join(" → ") || "(empty)")}</td>
                </tr>`).join("")}</tbody>
            </table>`;
    return `
      <section class="woo-tasks-admin">
        <div class="woo-tasks-admin-main">
          <div class="woo-tasks-admin-head">
            <div class="woo-tasks-admin-tabs" role="tablist" aria-label="Admin sections">
              ${tabs.map((tab) => `
                <button type="button" role="tab" data-tasks-admin-tab="${escapeHtml(tab.key)}" class="${tab.key === section ? "active" : ""}" aria-selected="${tab.key === section ? "true" : "false"}">
                  <span>${escapeHtml(tab.label)}</span>
                  <strong>${tab.count}</strong>
                </button>
              `).join("")}
            </div>
            <button type="button" data-tasks-admin-toggle aria-label="Close admin">×</button>
          </div>
          <div class="woo-tasks-admin-listhead">
            <h3>${escapeHtml(tabs.find((tab) => tab.key === section)?.label ?? "Admin")}</h3>
            <button type="button" class="woo-tasks-primary-action" data-tasks-admin-new="${escapeHtml(section)}">New</button>
          </div>
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
    const title = editing.key
      ? editing.mode === "view"
        ? `View ${editing.section}`
        : `Edit ${editing.section}`
      : `New ${editing.section}`;
    const remove = editing.key
      ? `<button type="button" class="woo-tasks-danger-action" data-tasks-admin-remove="${escapeHtml(editing.section)}" data-key="${escapeHtml(editing.key)}">Remove</button>`
      : "";
    const body = editing.mode === "view"
      ? editing.section === "role"
        ? `<section class="woo-tasks-admin-view">
            <label class="woo-tasks-admin-view-field"><span>Name</span><strong>${escapeHtml(this.adminDrafts.role.name || "—")}</strong></label>
            <label class="woo-tasks-admin-view-field"><span>Description</span><p>${escapeHtml(this.adminDrafts.role.description || "—")}</p></label>
            <label class="woo-tasks-admin-view-field"><span>Owners</span><p>${escapeHtml(this.adminDrafts.role.owners || "—")}</p></label>
            <div class="woo-tasks-admin-form-actions">
              <button type="button" data-tasks-admin-edit="${escapeHtml(editing.section)}" data-key="${escapeHtml(editing.key)}">Edit</button>
              ${remove}
            </div>
          </section>`
        : editing.section === "obligation"
          ? `<section class="woo-tasks-admin-view">
              <label class="woo-tasks-admin-view-field"><span>Key</span><strong>${escapeHtml(this.adminDrafts.obligation.key || "—")}</strong></label>
              <label class="woo-tasks-admin-view-field"><span>Role</span><p>${escapeHtml(this.adminDrafts.obligation.role || "—")}</p></label>
              <label class="woo-tasks-admin-view-field"><span>Criterion</span><p>${escapeHtml(this.adminDrafts.obligation.criterion || "—")}</p></label>
              <div class="woo-tasks-admin-form-actions">
                <button type="button" data-tasks-admin-edit="${escapeHtml(editing.section)}" data-key="${escapeHtml(editing.key)}">Edit</button>
                ${remove}
              </div>
            </section>`
          : `<section class="woo-tasks-admin-view">
              <label class="woo-tasks-admin-view-field"><span>Task kind</span><strong>${escapeHtml(this.adminDrafts.policy.kind || "—")}</strong></label>
              <label class="woo-tasks-admin-view-field"><span>Obligation order</span><p>${escapeHtml(this.adminDrafts.policy.keys || "—")}</p></label>
              <div class="woo-tasks-admin-form-actions">
                <button type="button" data-tasks-admin-edit="${escapeHtml(editing.section)}" data-key="${escapeHtml(editing.key)}">Edit</button>
                ${remove}
              </div>
            </section>`
      : editing.section === "role"
        ? `<form class="woo-tasks-admin-form" data-tasks-admin-form="role">
          <label>Name<input type="text" name="name" value="${escapeHtml(this.adminDrafts.role.name)}" required autocomplete="off"></label>
          <label>Description<input type="text" name="description" value="${escapeHtml(this.adminDrafts.role.description)}" autocomplete="off"></label>
          <label>Owners<input type="text" name="owners" value="${escapeHtml(this.adminDrafts.role.owners)}" autocomplete="off"></label>
          <div class="woo-tasks-admin-form-actions">
            ${remove}
            <button type="button" data-tasks-admin-edit-cancel>Cancel</button>
            <button type="submit">Add / update</button>
          </div>
        </form>`
        : editing.section === "obligation"
          ? `<form class="woo-tasks-admin-form" data-tasks-admin-form="obligation">
            <label>Key<input type="text" name="key" value="${escapeHtml(this.adminDrafts.obligation.key)}" required autocomplete="off"></label>
            <label>Role<select name="role" required>${roleNames.length === 0 ? `<option value="" disabled selected>no roles yet</option>` : roleNames.map((n) => `<option value="${escapeHtml(n)}"${n === (this.adminDrafts.obligation.role || roleNames[0] || "") ? " selected" : ""}>${escapeHtml(n)}</option>`).join("")}</select></label>
            <label>Criterion<input type="text" name="criterion" value="${escapeHtml(this.adminDrafts.obligation.criterion)}" required autocomplete="off"></label>
            <div class="woo-tasks-admin-form-actions">
              ${remove}
              <button type="button" data-tasks-admin-edit-cancel>Cancel</button>
              <button type="submit"${roleNames.length === 0 ? " disabled" : ""}>Add / update</button>
            </div>
          </form>`
          : `<form class="woo-tasks-admin-form" data-tasks-admin-form="policy">
            <label>Task kind<input type="text" name="kind" value="${escapeHtml(this.adminDrafts.policy.kind)}" required autocomplete="off"></label>
            <label>Obligation order<input type="text" name="keys" placeholder="${obligationKeys.length ? `e.g. ${escapeHtml(obligationKeys.join(", "))}` : ""}" value="${escapeHtml(this.adminDrafts.policy.keys)}" required autocomplete="off"></label>
            <div class="woo-tasks-admin-form-actions">
              ${remove}
              <button type="button" data-tasks-admin-edit-cancel>Cancel</button>
              <button type="submit"${obligationKeys.length === 0 ? " disabled" : ""}>Add / update</button>
            </div>
            </form>`;
    return `
      <aside class="woo-tasks-admin-editor">
        <div class="woo-tasks-admin-editor-head">
          <h3>${escapeHtml(title)}</h3>
          <button type="button" data-tasks-admin-edit-cancel aria-label="Close">×</button>
        </div>
        ${body}
      </aside>
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
      ? `<span class="woo-tasks-card-holder">held by ${escapeHtml(actorDisplay(task.location, actorNames))}</span>`
      : "";
    const meta = [
      task.kind ? `<span class="woo-tasks-card-kind">${escapeHtml(task.kind)}</span>` : "",
      cursorBadge,
      holder,
      `<span class="woo-tasks-card-age">${escapeHtml(formatAge(task.ageMs))}</span>`
    ].filter(Boolean).join("");
    const actions = task.actions.length === 0
      ? ""
      : `<div class="woo-tasks-card-actions" data-tasks-card-actions>${
          task.actions.map((action) => {
            const needsArgs = action.args.some((arg) => arg.required);
            const flag = needsArgs ? ' data-tasks-action-needs-args="true"' : "";
            return `
              <button type="button" data-tasks-action="${escapeHtml(action.verb)}" data-task-id="${escapeHtml(task.id)}"${flag}>${escapeHtml(action.label)}${needsArgs ? "…" : ""}</button>
            `;
          }).join("")
        }</div>`;
    const dragVerbs = task.actions.map((action) => action.verb);
    const draggable = this.groupBy === "state"
      && (dragVerbs.includes("claim") || dragVerbs.includes("release") || dragVerbs.includes("drop_terminal"));
    const prompt = this.openPrompt && this.openPrompt.taskId === task.id
      ? this.renderPrompt(task, this.openPrompt.verb)
      : "";
    return `
      <article class="woo-tasks-card${this.openDetail?.taskId === task.id ? " selected" : ""}" data-tasks-card="${escapeHtml(task.id)}"${draggable ? ' draggable="true"' : ""}>
        <header class="woo-tasks-card-header">
          <h3 class="woo-tasks-card-name">${escapeHtml(task.name || task.id)}</h3>
        </header>
        <div class="woo-tasks-card-meta">${meta}</div>
        ${labels ? `<div class="woo-tasks-card-labels">${labels}</div>` : ""}
        ${actions}
        ${prompt}
      </article>
    `;
  }

  private renderPrompt(task: KanbanTask, verb: string): string {
    const action = task.actions.find((entry) => entry.verb === verb);
    if (!action) return "";
    const fields = action.args.map((arg) => {
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
    return `
      <form class="woo-tasks-prompt" data-tasks-prompt data-task-id="${escapeHtml(task.id)}" data-verb="${escapeHtml(action.verb)}">
        <div class="woo-tasks-prompt-header">${escapeHtml(action.label)}</div>
        ${fields}
        <div class="woo-tasks-prompt-actions">
          <button type="submit" data-tasks-prompt-submit>Submit</button>
          <button type="button" data-tasks-prompt-cancel>Cancel</button>
        </div>
      </form>
    `;
  }
}

export function registerWooComponents(registry: WooComponentRegistry): void {
  registry.defineTag("woo-tasks-kanban", WooTasksKanbanElement);
}
