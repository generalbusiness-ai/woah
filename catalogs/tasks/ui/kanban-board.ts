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
};

type ColumnId = "ready" | "waiting" | "in_flight" | "done" | "dropped";

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
    tasks: []
  };
  private boundClick = false;
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  set data(value: KanbanData) {
    this.model = value;
    this.render();
  }

  connectedCallback(): void {
    this.render();
    if (!this.boundClick) {
      this.addEventListener("click", this.handleClick);
      this.boundClick = true;
    }
    if (this.woo) void this.refresh();
    this.startPolling();
  }

  disconnectedCallback(): void {
    if (this.boundClick) {
      this.removeEventListener("click", this.handleClick);
      this.boundClick = false;
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
      listing = await woo.call(subject, "listing", []);
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
          const result = await woo.call(subject, "available_actions", [task.id, actor]);
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
    this.data = {
      registryId: subject,
      registryName,
      actor: actor ?? null,
      actorNames,
      tasks
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
    void this.invokeAction(taskId, action);
  };

  private async invokeAction(taskId: string, action: KanbanAction): Promise<void> {
    const woo = this.woo;
    if (!woo) return;
    const required = action.args.filter((arg) => arg.required);
    if (required.length > 0) {
      // Required-args prompts land in phase c.4. Skip dispatch for now;
      // the woo-tasks-action event still fires so a host can intervene.
      return;
    }
    try {
      await woo.call(taskId, action.verb, []);
    } catch {
      // Errors surface as observations; phase c.2 wires live reconciliation.
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
        <header class="woo-tasks-kanban-header"><h2>${escapeHtml(registryName || "Tasks")}</h2></header>
        <div class="woo-tasks-kanban-columns">${columnsHtml}</div>
      </section>
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
          task.actions.map((action) => `
            <button type="button" data-tasks-action="${escapeHtml(action.verb)}" data-task-id="${escapeHtml(task.id)}">${escapeHtml(action.label)}</button>
          `).join("")
        }</div>`;
    return `
      <article class="woo-tasks-card" data-tasks-card="${escapeHtml(task.id)}">
        <header class="woo-tasks-card-header">
          <h3 class="woo-tasks-card-name">${escapeHtml(task.name || task.id)}</h3>
        </header>
        <div class="woo-tasks-card-meta">${meta}</div>
        ${labels ? `<div class="woo-tasks-card-labels">${labels}</div>` : ""}
        ${actions}
      </article>
    `;
  }
}

export function registerWooComponents(registry: WooComponentRegistry): void {
  registry.defineTag("woo-tasks-kanban", WooTasksKanbanElement);
}
