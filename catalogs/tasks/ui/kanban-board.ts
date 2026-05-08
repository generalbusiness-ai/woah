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
  }

  disconnectedCallback(): void {
    if (this.boundClick) {
      this.removeEventListener("click", this.handleClick);
      this.boundClick = false;
    }
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
  };

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
