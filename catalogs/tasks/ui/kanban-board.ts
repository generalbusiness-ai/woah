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
  private createOpen = false;
  private adminOpen = false;
  private openDetail: { taskId: string; detail: TaskDetail | null; loading: boolean; error?: string } | null = null;
  private detailEdit: "name" | "text" | "labels" | null = null;
  private groupBy: GroupBy = "state";
  private boundChange = false;
  private boundInput = false;
  private filterText = "";
  private filterLabels = new Set<string>();

  set data(value: Partial<KanbanData> & Pick<KanbanData, "registryId" | "registryName" | "actor" | "actorNames" | "tasks">) {
    this.model = {
      policies: [],
      isOwner: false,
      roles: [],
      obligations: [],
      policiesMap: {},
      ...value
    };
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
      this.createOpen = true;
      this.render();
      this.querySelector<HTMLInputElement>("[data-tasks-create] input[name=\"name\"]")?.focus();
      return;
    }
    if (target.closest<HTMLButtonElement>("[data-tasks-create-cancel]")) {
      event.preventDefault();
      this.createOpen = false;
      this.render();
      return;
    }
    if (target.closest<HTMLButtonElement>("[data-tasks-seed-policy]")) {
      event.preventDefault();
      void this.seedMinimalPolicy();
      return;
    }
    if (target.closest<HTMLButtonElement>("[data-tasks-detail-close]")) {
      event.preventDefault();
      this.openDetail = null;
      this.detailEdit = null;
      this.render();
      return;
    }
    const editOpen = target.closest<HTMLButtonElement>("[data-tasks-detail-edit-open]");
    if (editOpen) {
      event.preventDefault();
      const field = editOpen.dataset.tasksDetailEditOpen;
      if (field === "name" || field === "text" || field === "labels") {
        this.detailEdit = field;
        this.render();
        const focusSel = field === "text"
          ? "[data-tasks-detail-edit] textarea"
          : `[data-tasks-detail-edit] input[name="${field}"]`;
        this.querySelector<HTMLInputElement | HTMLTextAreaElement>(focusSel)?.focus();
      }
      return;
    }
    if (target.closest<HTMLButtonElement>("[data-tasks-detail-edit-cancel]")) {
      event.preventDefault();
      this.detailEdit = null;
      this.render();
      return;
    }
    if (target.closest<HTMLButtonElement>("[data-tasks-admin-toggle]")) {
      event.preventDefault();
      this.adminOpen = !this.adminOpen;
      this.render();
      return;
    }
    const removeBtn = target.closest<HTMLButtonElement>("[data-tasks-admin-remove]");
    if (removeBtn) {
      event.preventDefault();
      const kind = removeBtn.dataset.tasksAdminRemove ?? "";
      const key = removeBtn.dataset.key ?? "";
      if (kind && key) void this.removeAdminEntry(kind, key);
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
    const select = target?.closest<HTMLSelectElement>("[data-tasks-group-by]");
    if (!select) return;
    if (isGroupBy(select.value) && select.value !== this.groupBy) {
      this.groupBy = select.value;
      this.render();
    }
  };

  private handleInput = (event: Event): void => {
    const target = event.target as HTMLElement | null;
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

  private handleSubmit = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const detailEditForm = target?.closest<HTMLFormElement>("[data-tasks-detail-edit]");
    if (detailEditForm) {
      event.preventDefault();
      void this.submitDetailEditForm(detailEditForm);
      return;
    }
    const adminForm = target?.closest<HTMLFormElement>("[data-tasks-admin-form]");
    if (adminForm) {
      event.preventDefault();
      void this.submitAdminForm(adminForm);
      return;
    }
    const createForm = target?.closest<HTMLFormElement>("[data-tasks-create]");
    if (createForm) {
      event.preventDefault();
      const kind = (createForm.querySelector<HTMLSelectElement>('select[name="kind"]')?.value ?? "").trim();
      const name = (createForm.querySelector<HTMLInputElement>('input[name="name"]')?.value ?? "").trim();
      const text = createForm.querySelector<HTMLTextAreaElement>('textarea[name="text"]')?.value ?? "";
      const labelsRaw = createForm.querySelector<HTMLInputElement>('input[name="labels"]')?.value ?? "";
      const labels = labelsRaw.split(",").map((s) => s.trim()).filter(Boolean);
      if (!kind || !name) return;
      void this.createTask(kind, name, text, labels);
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
    try {
      await woo.directCall(subject, "create_task", [kind, name, text, labels, null]);
      this.createOpen = false;
    } catch {
      // Errors land as observations; refresh will repaint either way.
    }
    await this.refresh();
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
      const owners = ownersRaw.split(",").map((s) => s.trim()).filter(Boolean);
      if (!name) return;
      try {
        await woo.directCall(subject, "set_role", [name, { description, owners }]);
      } catch { /* surfaces in next refresh */ }
      await this.refresh();
      return;
    }
    if (kind === "obligation") {
      const key = (form.querySelector<HTMLInputElement>('input[name="key"]')?.value ?? "").trim();
      const role = (form.querySelector<HTMLSelectElement>('select[name="role"]')?.value ?? "").trim();
      const criterion = (form.querySelector<HTMLInputElement>('input[name="criterion"]')?.value ?? "").trim();
      if (!key || !role || !criterion) return;
      try {
        await woo.directCall(subject, "set_obligation", [key, { role, criterion }]);
      } catch { /* surfaces in next refresh */ }
      await this.refresh();
      return;
    }
    if (kind === "policy") {
      const policyKind = (form.querySelector<HTMLInputElement>('input[name="kind"]')?.value ?? "").trim();
      const keysRaw = (form.querySelector<HTMLInputElement>('input[name="keys"]')?.value ?? "").trim();
      const keys = keysRaw.split(",").map((s) => s.trim()).filter(Boolean);
      if (!policyKind || keys.length === 0) return;
      try {
        await woo.directCall(subject, "set_policy", [policyKind, keys]);
      } catch { /* surfaces in next refresh */ }
      await this.refresh();
      return;
    }
  }

  private async removeAdminEntry(kind: string, key: string): Promise<void> {
    const woo = this.woo;
    const subject = this.subject ?? this.model.registryId;
    if (!woo || !subject) return;
    const verb = kind === "role" ? "remove_role" : kind === "obligation" ? "remove_obligation" : kind === "policy" ? "remove_policy" : "";
    if (!verb) return;
    try {
      await woo.directCall(subject, verb, [key]);
    } catch { /* surfaces in next refresh */ }
    await this.refresh();
  }

  private async seedMinimalPolicy(): Promise<void> {
    const woo = this.woo;
    const subject = this.subject ?? this.model.registryId;
    if (!woo || !subject || !woo.actor) return;
    try {
      await woo.directCall(subject, "seed_minimal_policy", [woo.actor]);
    } catch {
      // Non-owner / non-wizard will see E_PERM; surface lands in the next refresh.
    }
    await this.refresh();
  }

  private async submitDetailEditForm(form: HTMLFormElement): Promise<void> {
    const woo = this.woo;
    if (!woo || !this.openDetail || !this.openDetail.detail) return;
    const taskId = this.openDetail.taskId;
    const field = form.dataset.tasksDetailEdit;
    if (field === "name") {
      const value = (form.querySelector<HTMLInputElement>('input[name="name"]')?.value ?? "").trim();
      if (!value) return;
      try { await woo.directCall(taskId, "set_name", [value]); } catch { /* surfaces in refresh */ }
    } else if (field === "text") {
      const value = form.querySelector<HTMLTextAreaElement>('textarea[name="text"]')?.value ?? "";
      try { await woo.directCall(taskId, "set_text", [value]); } catch { /* surfaces in refresh */ }
    } else if (field === "labels") {
      const raw = form.querySelector<HTMLInputElement>('input[name="labels"]')?.value ?? "";
      const labels = raw.split(",").map((s) => s.trim()).filter(Boolean);
      try { await woo.directCall(taskId, "set_labels", [labels]); } catch { /* surfaces in refresh */ }
    } else {
      return;
    }
    this.detailEdit = null;
    await this.openTaskDetail(taskId);
    await this.refresh();
  }

  private async openTaskDetail(taskId: string): Promise<void> {
    const woo = this.woo;
    if (!woo) return;
    this.openDetail = { taskId, detail: null, loading: true };
    this.render();
    try {
      const result = await woo.directCall(taskId, "detail", []);
      const detail = readDetail(result);
      this.openDetail = detail
        ? { taskId, detail, loading: false }
        : { taskId, detail: null, loading: false, error: "no detail returned" };
    } catch (err) {
      this.openDetail = { taskId, detail: null, loading: false, error: err instanceof Error ? err.message : String(err) };
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
    try {
      await woo.directCall(taskId, action.verb, args);
    } catch {
      // Errors surface as observations; live reconciliation tightens this later.
    }
    await this.refresh();
  }

  private filteredTasks(): KanbanTask[] {
    const tasks = this.model.tasks;
    const q = this.filterText.trim().toLowerCase();
    const labels = this.filterLabels;
    if (!q && labels.size === 0) return tasks;
    return tasks.filter((task) => {
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
    const { columns, bucketFor } = computeGrouping(this.groupBy, tasks, registryId, actorNames);
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

    this.innerHTML = `
      <section class="woo-tasks-kanban">
        ${this.renderHeader(registryName || "Tasks")}
        <div class="woo-tasks-kanban-columns">${columnsHtml}</div>
        ${this.openDetail ? this.renderDetailPanel(actorNames) : ""}
      </section>
    `;
  }

  private renderDetailPanel(actorNames: Record<string, string>): string {
    const open = this.openDetail;
    if (!open) return "";
    if (open.loading) {
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
    if (!open.detail) {
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
    const detail = open.detail;
    const editing = this.detailEdit;
    const labelsBody = editing === "labels"
      ? `<form class="woo-tasks-detail-edit" data-tasks-detail-edit="labels">
          <input type="text" name="labels" value="${escapeHtml(detail.labels.join(", "))}" autocomplete="off">
          <button type="submit" data-tasks-detail-edit-submit>Save</button>
          <button type="button" data-tasks-detail-edit-cancel>Cancel</button>
        </form>`
      : `<div class="woo-tasks-detail-labels" data-tasks-detail-field="labels">
          ${detail.labels.length === 0
            ? `<span class="woo-tasks-detail-empty-inline">no labels</span>`
            : detail.labels.map((l) => `<span class="woo-tasks-card-label">${escapeHtml(l)}</span>`).join("")}
          <button type="button" data-tasks-detail-edit-open="labels" class="woo-tasks-detail-edit-icon" aria-label="Edit labels">✎</button>
        </div>`;
    const labels = labelsBody;
    const text = editing === "text"
      ? `<form class="woo-tasks-detail-edit" data-tasks-detail-edit="text">
          <textarea name="text" rows="6" autocomplete="off">${escapeHtml(detail.text)}</textarea>
          <div class="woo-tasks-detail-edit-actions">
            <button type="submit" data-tasks-detail-edit-submit>Save</button>
            <button type="button" data-tasks-detail-edit-cancel>Cancel</button>
          </div>
        </form>`
      : detail.text
        ? `<div class="woo-tasks-detail-text-wrap" data-tasks-detail-field="text">
            <pre class="woo-tasks-detail-text">${escapeHtml(detail.text)}</pre>
            <button type="button" data-tasks-detail-edit-open="text" class="woo-tasks-detail-edit-icon" aria-label="Edit body">✎</button>
          </div>`
        : `<div class="woo-tasks-detail-text-wrap" data-tasks-detail-field="text">
            <p class="woo-tasks-detail-empty">No body.</p>
            <button type="button" data-tasks-detail-edit-open="text" class="woo-tasks-detail-edit-icon" aria-label="Edit body">✎</button>
          </div>`;
    const obligationsHtml = detail.obligations.length === 0
      ? `<p class="woo-tasks-detail-empty">No obligations.</p>`
      : `<ol class="woo-tasks-detail-obligations">${detail.obligations.map((o) => {
          const here = o.key === detail.cursorKey;
          const flag = o.met ? "✓" : here ? "▶" : " ";
          const role = o.role ? `<span class="woo-tasks-detail-obligation-role">${escapeHtml(o.role)}</span>` : "";
          const criterion = o.criterion ? `<span class="woo-tasks-detail-obligation-criterion">${escapeHtml(o.criterion)}</span>` : "";
          return `<li class="woo-tasks-detail-obligation${o.met ? " met" : ""}${here ? " current" : ""}">
            <span class="woo-tasks-detail-obligation-flag">${escapeHtml(flag)}</span>
            <span class="woo-tasks-detail-obligation-key">${escapeHtml(o.key)}</span>
            ${role}${criterion}
          </li>`;
        }).join("")}</ol>`;
    const logHtml = detail.log.length === 0
      ? `<p class="woo-tasks-detail-empty">No log entries.</p>`
      : `<ul class="woo-tasks-detail-log">${[...detail.log].reverse().map((entry) => {
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
    const waitHtml = detail.waitFor.length === 0
      ? ""
      : `<section class="woo-tasks-detail-waitfor">
          <h4>Waiting on</h4>
          <ul>${detail.waitFor.map((w) => `<li>${escapeHtml(JSON.stringify(w))}</li>`).join("")}</ul>
        </section>`;
    const linksHtml = detail.links.length === 0
      ? ""
      : `<section class="woo-tasks-detail-links">
          <h4>Links</h4>
          <ul>${detail.links.map((l) => `<li>${escapeHtml(l.role ?? "link")} → ${escapeHtml(l.to ?? "—")}</li>`).join("")}</ul>
        </section>`;
    const status = detail.complete ? "complete" : detail.terminal ? "dropped" : detail.location && detail.location !== this.model.registryId ? `held by ${actorDisplay(detail.location, actorNames)}` : "ready";
    const nameBody = editing === "name"
      ? `<form class="woo-tasks-detail-edit" data-tasks-detail-edit="name">
          <input type="text" name="name" value="${escapeHtml(detail.name || detail.id)}" required autocomplete="off">
          <button type="submit" data-tasks-detail-edit-submit>Save</button>
          <button type="button" data-tasks-detail-edit-cancel>Cancel</button>
        </form>`
      : `<h3 data-tasks-detail-field="name">
          <span class="woo-tasks-detail-name">${escapeHtml(detail.name || detail.id)}</span>
          <button type="button" data-tasks-detail-edit-open="name" class="woo-tasks-detail-edit-icon" aria-label="Rename task">✎</button>
        </h3>`;
    return `
      <aside class="woo-tasks-detail" data-tasks-detail data-task-id="${escapeHtml(detail.id)}">
        <header class="woo-tasks-detail-header">
          ${nameBody}
          <button type="button" data-tasks-detail-close aria-label="Close">×</button>
        </header>
        <div class="woo-tasks-detail-meta">
          <span class="woo-tasks-detail-kind">${escapeHtml(detail.kind || "task")}</span>
          <span class="woo-tasks-detail-status">${escapeHtml(status)}</span>
        </div>
        ${labels}
        <section class="woo-tasks-detail-section">
          <h4>Body</h4>
          ${text}
        </section>
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
      </aside>
    `;
  }

  private renderHeader(registryName: string): string {
    const { policies, isOwner } = this.model;
    const havePolicies = policies.length > 0;
    const buttons: string[] = [];
    if (havePolicies) {
      buttons.push(this.createOpen
        ? "" // form is rendered below; suppress the open button while editing
        : `<button type="button" data-tasks-create-open>+ New task</button>`);
    } else if (isOwner) {
      buttons.push(`<button type="button" data-tasks-seed-policy title="Install a doer/do:it/task fixture so create_task has a kind to bind to">Seed minimal policy</button>`);
    } else {
      buttons.push(`<span class="woo-tasks-kanban-empty-toolbar">No policies configured. Ask the registry owner to seed one.</span>`);
    }
    const groupOptions = GROUP_BY_ORDER.map((key) => {
      const selected = this.groupBy === key ? " selected" : "";
      return `<option value="${escapeHtml(key)}"${selected}>${escapeHtml(GROUP_BY_LABELS[key])}</option>`;
    }).join("");
    buttons.push(`
      <label class="woo-tasks-kanban-groupby">
        Group by
        <select data-tasks-group-by aria-label="Group tasks by">${groupOptions}</select>
      </label>
    `);
    if (isOwner) {
      buttons.push(`<button type="button" data-tasks-admin-toggle aria-expanded="${this.adminOpen ? "true" : "false"}">${this.adminOpen ? "Close admin" : "⚙ Admin"}</button>`);
    }
    const toolbar = buttons.filter(Boolean).join(" ");
    return `
      <header class="woo-tasks-kanban-header">
        <h2>${escapeHtml(registryName)}</h2>
        <div class="woo-tasks-kanban-toolbar">${toolbar}</div>
      </header>
      ${this.renderFilterBar()}
      ${this.createOpen ? this.renderCreateForm() : ""}
      ${this.adminOpen ? this.renderAdminPanel() : ""}
    `;
  }

  private renderFilterBar(): string {
    const labels = Array.from(this.filterLabels);
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
        <div class="woo-tasks-filter-chips" data-tasks-filter-chips>${chips}</div>
        ${clear}
      </div>
    `;
  }

  private renderAdminPanel(): string {
    const { roles, obligations, policiesMap } = this.model;
    const roleNames = roles.map((r) => r.name);
    const obligationKeys = obligations.map((o) => o.key);
    const rolesList = roles.length === 0
      ? `<p class="woo-tasks-admin-empty">No roles. Add one below.</p>`
      : `<ul class="woo-tasks-admin-list">${roles.map((r) => `
          <li class="woo-tasks-admin-row">
            <span class="woo-tasks-admin-key">${escapeHtml(r.name)}</span>
            <span class="woo-tasks-admin-desc">${escapeHtml(r.description || "—")}</span>
            <span class="woo-tasks-admin-owners">${escapeHtml(r.owners.join(", ") || "(no owners)")}</span>
            <button type="button" data-tasks-admin-remove="role" data-key="${escapeHtml(r.name)}">remove</button>
          </li>`).join("")}</ul>`;
    const obsList = obligations.length === 0
      ? `<p class="woo-tasks-admin-empty">No obligations. Add one below.</p>`
      : `<ul class="woo-tasks-admin-list">${obligations.map((o) => `
          <li class="woo-tasks-admin-row">
            <span class="woo-tasks-admin-key">${escapeHtml(o.key)}</span>
            <span class="woo-tasks-admin-role">${escapeHtml(o.role || "—")}</span>
            <span class="woo-tasks-admin-criterion">${escapeHtml(o.criterion || "—")}</span>
            <button type="button" data-tasks-admin-remove="obligation" data-key="${escapeHtml(o.key)}">remove</button>
          </li>`).join("")}</ul>`;
    const polList = Object.keys(policiesMap).length === 0
      ? `<p class="woo-tasks-admin-empty">No policies. Add one below.</p>`
      : `<ul class="woo-tasks-admin-list">${Object.entries(policiesMap).map(([kind, keys]) => `
          <li class="woo-tasks-admin-row">
            <span class="woo-tasks-admin-key">${escapeHtml(kind)}</span>
            <span class="woo-tasks-admin-keys">${escapeHtml(keys.join(" → ") || "(empty)")}</span>
            <button type="button" data-tasks-admin-remove="policy" data-key="${escapeHtml(kind)}">remove</button>
          </li>`).join("")}</ul>`;
    const roleSelectOptions = roleNames.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
    const policyKeySuggestions = obligationKeys.join(", ");
    return `
      <section class="woo-tasks-admin">
        <div class="woo-tasks-admin-section">
          <h3>Roles</h3>
          ${rolesList}
          <form class="woo-tasks-admin-form" data-tasks-admin-form="role">
            <input type="text" name="name" placeholder="role name" required autocomplete="off">
            <input type="text" name="description" placeholder="description" autocomplete="off">
            <input type="text" name="owners" placeholder="owner refs, comma-separated" autocomplete="off">
            <button type="submit">Add / update</button>
          </form>
        </div>
        <div class="woo-tasks-admin-section">
          <h3>Obligations</h3>
          ${obsList}
          <form class="woo-tasks-admin-form" data-tasks-admin-form="obligation">
            <input type="text" name="key" placeholder="obligation key" required autocomplete="off">
            <select name="role" required>${roleNames.length === 0 ? `<option value="" disabled selected>no roles yet</option>` : roleSelectOptions}</select>
            <input type="text" name="criterion" placeholder="completion criterion" required autocomplete="off">
            <button type="submit"${roleNames.length === 0 ? " disabled" : ""}>Add / update</button>
          </form>
        </div>
        <div class="woo-tasks-admin-section">
          <h3>Policies</h3>
          ${polList}
          <form class="woo-tasks-admin-form" data-tasks-admin-form="policy">
            <input type="text" name="kind" placeholder="task kind" required autocomplete="off">
            <input type="text" name="keys" placeholder="ordered obligation keys, comma-separated${policyKeySuggestions ? ` (e.g. ${policyKeySuggestions})` : ""}" required autocomplete="off">
            <button type="submit"${obligationKeys.length === 0 ? " disabled" : ""}>Add / update</button>
          </form>
        </div>
      </section>
    `;
  }

  private renderCreateForm(): string {
    const { policies } = this.model;
    const options = policies
      .map((kind) => `<option value="${escapeHtml(kind)}">${escapeHtml(kind)}</option>`)
      .join("");
    return `
      <form class="woo-tasks-create" data-tasks-create>
        <label class="woo-tasks-create-field">
          <span class="woo-tasks-create-label">Kind</span>
          <select name="kind" required>${options}</select>
        </label>
        <label class="woo-tasks-create-field">
          <span class="woo-tasks-create-label">Name</span>
          <input type="text" name="name" required maxlength="240" autocomplete="off">
        </label>
        <label class="woo-tasks-create-field">
          <span class="woo-tasks-create-label">Body</span>
          <textarea name="text" rows="3" placeholder="markdown body (optional)"></textarea>
        </label>
        <label class="woo-tasks-create-field">
          <span class="woo-tasks-create-label">Labels <span class="woo-tasks-create-hint">(comma-separated, optional)</span></span>
          <input type="text" name="labels" autocomplete="off">
        </label>
        <div class="woo-tasks-create-actions">
          <button type="submit" data-tasks-create-submit>Create</button>
          <button type="button" data-tasks-create-cancel>Cancel</button>
        </div>
      </form>
    `;
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
      <article class="woo-tasks-card" data-tasks-card="${escapeHtml(task.id)}"${draggable ? ' draggable="true"' : ""}>
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
