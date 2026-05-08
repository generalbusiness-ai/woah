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

export type KanbanData = {
  registryId: string;
  registryName: string;
  actor: string | null;
  actorNames: Record<string, string>;
  tasks: KanbanTask[];
  policies: string[];
  isOwner: boolean;
};

type ColumnId = "ready" | "waiting" | "in_flight" | "done" | "dropped";

const DRAG_VERB_BY_TRANSITION: Partial<Record<`${ColumnId}->${ColumnId}`, string>> = {
  "ready->in_flight": "claim",
  "in_flight->ready": "release",
  "in_flight->dropped": "drop_terminal"
};

const COLUMN_LABELS: Record<ColumnId, string> = {
  ready: "Ready",
  waiting: "Waiting",
  in_flight: "In flight",
  done: "Done",
  dropped: "Dropped"
};

const COLUMN_ORDER: ColumnId[] = ["ready", "waiting", "in_flight", "done", "dropped"];

function columnFor(task: KanbanTask, registryId: string): ColumnId {
  if (task.complete) return "done";
  if (task.terminal) return "dropped";
  if (task.location !== registryId) return "in_flight";
  if (task.waitForCount > 0) return "waiting";
  return "ready";
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
    isOwner: false
  };
  private boundClick = false;
  private boundDrag = false;
  private boundSubmit = false;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private openPrompt: { taskId: string; verb: string } | null = null;
  private createOpen = false;

  set data(value: KanbanData) {
    this.model = {
      policies: [],
      isOwner: false,
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
    const policies = rawPolicies && typeof rawPolicies === "object" && !Array.isArray(rawPolicies)
      ? Object.keys(rawPolicies)
      : [];
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
      isOwner
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
    const cancel = target.closest<HTMLButtonElement>("[data-tasks-prompt-cancel]");
    if (cancel) {
      event.preventDefault();
      this.closePrompt();
      return;
    }
    const button = target.closest<HTMLButtonElement>("[data-tasks-action]");
    if (!button) return;
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

  private handleSubmit = (event: Event): void => {
    const target = event.target as HTMLElement | null;
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
    const col = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-tasks-col]");
    if (!col || !event.dataTransfer) return;
    const sourceCol = event.dataTransfer.getData("application/x-woo-task-source-col") as ColumnId | "";
    const targetCol = (col.dataset.tasksCol ?? "") as ColumnId | "";
    if (!sourceCol || !targetCol || sourceCol === targetCol) return;
    if (!DRAG_VERB_BY_TRANSITION[`${sourceCol}->${targetCol}`]) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    col.dataset.tasksDropTarget = "true";
  };

  private handleDrop = (event: DragEvent): void => {
    const col = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-tasks-col]");
    if (!col || !event.dataTransfer) return;
    const taskId = event.dataTransfer.getData("application/x-woo-task");
    const sourceCol = event.dataTransfer.getData("application/x-woo-task-source-col") as ColumnId | "";
    const targetCol = (col.dataset.tasksCol ?? "") as ColumnId | "";
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

  private render(): void {
    const { registryId, registryName, tasks, actorNames } = this.model;
    const buckets: Record<ColumnId, KanbanTask[]> = {
      ready: [],
      waiting: [],
      in_flight: [],
      done: [],
      dropped: []
    };
    for (const task of tasks) buckets[columnFor(task, registryId)].push(task);

    const columnsHtml = COLUMN_ORDER.map((col) => {
      const items = buckets[col];
      const cards = items.length === 0
        ? `<div class="woo-tasks-kanban-empty-col" data-tasks-empty="${col}">No tasks.</div>`
        : items.map((task) => this.renderCard(task, actorNames)).join("");
      return `
        <section class="woo-tasks-kanban-col" data-tasks-col="${col}">
          <header class="woo-tasks-kanban-col-header">
            <span class="woo-tasks-kanban-col-name">${escapeHtml(COLUMN_LABELS[col])}</span>
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
      </section>
    `;
  }

  private renderHeader(registryName: string): string {
    const { policies, isOwner } = this.model;
    const havePolicies = policies.length > 0;
    let toolbar = "";
    if (havePolicies) {
      toolbar = this.createOpen
        ? this.renderCreateForm()
        : `<button type="button" data-tasks-create-open>+ New task</button>`;
    } else if (isOwner) {
      toolbar = `<button type="button" data-tasks-seed-policy title="Install a doer/do:it/task fixture so create_task has a kind to bind to">Seed minimal policy</button>`;
    } else {
      toolbar = `<span class="woo-tasks-kanban-empty-toolbar">No policies configured. Ask the registry owner to seed one.</span>`;
    }
    return `
      <header class="woo-tasks-kanban-header">
        <h2>${escapeHtml(registryName)}</h2>
        <div class="woo-tasks-kanban-toolbar">${toolbar}</div>
      </header>
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
      .map((label) => `<span class="woo-tasks-card-label">${escapeHtml(label)}</span>`)
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
    const draggable = dragVerbs.includes("claim") || dragVerbs.includes("release") || dragVerbs.includes("drop_terminal");
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
