import { escapeHtml, type WooComponentRegistry, type WooContext } from "../../../src/client/framework";

export type TaskspaceTask = {
  id: string;
  props: Record<string, unknown>;
};

export type TaskspaceData = {
  space: string;
  tasks: Record<string, TaskspaceTask>;
  rootTasks: string[];
  selectedTask?: string;
  expanded: Record<string, boolean>;
  statusFilter: Record<string, boolean>;
};

const TASK_STATUSES = ["open", "claimed", "in_progress", "blocked", "done"] as const;

export class WooTaskspaceWorkspaceElement extends HTMLElement {
  woo?: WooContext;
  subject?: string;
  private model: TaskspaceData = {
    space: "",
    tasks: {},
    rootTasks: [],
    expanded: {},
    statusFilter: { open: true, claimed: true, in_progress: true, blocked: true, done: false }
  };

  set data(value: TaskspaceData) {
    this.model = value;
    this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  private render(): void {
    const tasks = this.model.tasks ?? {};
    const roots = Array.isArray(this.model.rootTasks) ? this.model.rootTasks : [];
    const selected = this.model.selectedTask ? tasks[this.model.selectedTask] : undefined;
    const allTasks = Object.values(tasks);
    const active = activeTaskStatuses(this.model.statusFilter);
    const visibleCount = allTasks.filter((task) => taskMatchesStatus(task, active)).length;
    const statusCounts = countTasksByStatus(allTasks);
    this.innerHTML = `
      <section class="toolbar task-toolbar">
        <h1>Taskspace</h1>
        <div class="task-summary">
          <span>${visibleCount}/${allTasks.length} tasks</span>
          ${TASK_STATUSES.map((status) => this.renderStatusFilter(status, statusCounts[status] ?? 0)).join("")}
        </div>
      </section>
      <section class="space-chat-shell" data-space-chat-shell="${escapeHtml(this.model.space)}">
        <section class="taskspace-layout has-space-chat" data-space-chat-layout="${escapeHtml(this.model.space)}">
          <div class="panel tree">
            <div class="task-create">
              <input data-new-title placeholder="Root task title" />
              <input data-new-description placeholder="Description" />
              <button data-create-task>Create</button>
            </div>
            <div class="task-tree-list">
              ${roots.map((id) => this.renderTaskNode(id, tasks, 0, active)).join("") || `<div class="empty-state">${allTasks.length > 0 ? "No tasks match the selected statuses." : "No tasks yet."}</div>`}
            </div>
          </div>
          <div class="panel inspector">${selected ? this.renderTaskInspector(selected, tasks) : `<div class="empty-state">Select a task.</div>`}</div>
        </section>
        <div data-tool-space-chat></div>
      </section>
    `;
    this.bind();
  }

  private renderStatusFilter(status: string, count: number): string {
    const active = this.model.statusFilter[status] !== false;
    return `
      <button class="status-pill status-filter ${statusClass(status)} ${active ? "active" : ""}" data-task-status="${escapeHtml(status)}" aria-pressed="${active}">
        ${escapeHtml(statusLabel(status))}: ${count}
      </button>
    `;
  }

  private renderTaskNode(id: string, tasks: Record<string, TaskspaceTask>, depth: number, active: Set<string>): string {
    const task = tasks[id];
    if (!task) return "";
    const props = task.props ?? {};
    const subtasks = Array.isArray(props.subtasks) ? props.subtasks.map(String) : [];
    const renderedChildren = subtasks.map((child) => this.renderTaskNode(child, tasks, depth + 1, active)).join("");
    const matches = taskMatchesStatus(task, active);
    if (!matches && !renderedChildren) return "";
    const expanded = this.model.expanded[id] !== false;
    const reqStats = requirementStats(props.requirements);
    const selected = this.model.selectedTask === id;
    return `
      <div class="task-node" style="--depth:${depth}">
        <div class="task-row ${selected ? "selected" : ""} ${matches ? "" : "filtered-context"}">
          <button class="task-toggle" data-toggle-task="${escapeHtml(id)}" aria-label="Toggle ${escapeHtml(String(props.title ?? id))}" ${subtasks.length === 0 ? "disabled" : ""}>${subtasks.length === 0 ? "" : expanded ? "-" : "+"}</button>
          <button class="task-select" data-select-task="${escapeHtml(id)}">
            <span class="task-title">${escapeHtml(String(props.title ?? id))}</span>
            <span class="task-meta">
              <span class="status-pill ${statusClass(String(props.status ?? ""))}">${escapeHtml(statusLabel(String(props.status ?? "")))}</span>
              <span>${escapeHtml(String(props.assignee ? this.actorLabel(String(props.assignee)) : "unassigned"))}</span>
              <span>${reqStats.checked}/${reqStats.total} req</span>
            </span>
          </button>
        </div>
        ${expanded && renderedChildren ? `<div class="children">${renderedChildren}</div>` : ""}
      </div>
    `;
  }

  private renderTaskInspector(task: TaskspaceTask, tasks: Record<string, TaskspaceTask>): string {
    const props = task.props ?? {};
    const requirements = Array.isArray(props.requirements) ? props.requirements : [];
    const messages = Array.isArray(props.messages) ? props.messages : [];
    const artifacts = Array.isArray(props.artifacts) ? props.artifacts : [];
    const subtasks = Array.isArray(props.subtasks) ? props.subtasks.map(String) : [];
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
        <div><strong>Assignee</strong><span>${escapeHtml(String(props.assignee ? this.actorLabel(String(props.assignee)) : "none"))}</span></div>
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
        <div class="related-list">${subtasks.map((id) => this.renderRelatedTask(id, tasks)).join("") || `<div class="empty-state">No subtasks.</div>`}</div>
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
        <div class="activity-list">${messages.map((item) => this.renderTaskMessage(item)).join("") || `<div class="empty-state">No messages.</div>`}</div>
      </section>
      <section class="task-section">
        <h3>Artifacts</h3>
        <div class="inline-form"><input data-artifact placeholder="https://example.com/artifact"><button data-add-artifact>Add</button></div>
        <div class="artifact-list">${artifacts.map(renderArtifact).join("") || `<div class="empty-state">No artifacts.</div>`}</div>
      </section>
    `;
  }

  private renderRelatedTask(id: string, tasks: Record<string, TaskspaceTask>): string {
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

  private renderTaskMessage(item: any): string {
    const actor = typeof item?.actor === "string" ? this.actorLabel(item.actor) : "unknown";
    const ts = typeof item?.ts === "number" ? new Date(item.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    return `
      <div class="activity-item">
        <div><strong>${escapeHtml(actor)}</strong><span>${escapeHtml(ts)}</span></div>
        <p>${escapeHtml(String(item?.body ?? ""))}</p>
      </div>
    `;
  }

  private bind(): void {
    this.querySelectorAll<HTMLButtonElement>("[data-task-status]").forEach((button) => button.addEventListener("click", () => this.dispatch("status-filter", { status: button.dataset.taskStatus ?? "" })));
    this.querySelector<HTMLButtonElement>("[data-create-task]")?.addEventListener("click", () => {
      this.dispatch("create", {
        title: this.querySelector<HTMLInputElement>("[data-new-title]")?.value ?? "",
        description: this.querySelector<HTMLInputElement>("[data-new-description]")?.value ?? ""
      });
    });
    this.querySelectorAll<HTMLButtonElement>("[data-toggle-task]").forEach((button) => button.addEventListener("click", () => this.dispatch("toggle", { id: button.dataset.toggleTask ?? "" })));
    this.querySelectorAll<HTMLButtonElement>("[data-select-task]").forEach((button) => button.addEventListener("click", () => this.dispatch("select", { id: button.dataset.selectTask ?? "" })));
    this.querySelectorAll<HTMLButtonElement>("[data-task-action]").forEach((button) => button.addEventListener("click", () => this.dispatch("task-action", { action: button.dataset.taskAction ?? "" })));
    this.querySelector<HTMLButtonElement>("[data-add-subtask]")?.addEventListener("click", () => this.dispatch("add-subtask", {
      title: this.querySelector<HTMLInputElement>("[data-subtask-title]")?.value ?? "",
      description: this.querySelector<HTMLInputElement>("[data-subtask-description]")?.value ?? ""
    }));
    this.querySelector<HTMLButtonElement>("[data-add-requirement]")?.addEventListener("click", () => this.dispatch("add-requirement", { text: this.querySelector<HTMLInputElement>("[data-requirement]")?.value ?? "" }));
    this.querySelectorAll<HTMLInputElement>("[data-check-req]").forEach((input) => input.addEventListener("change", () => this.dispatch("check-requirement", { index: Number(input.dataset.checkReq), checked: input.checked })));
    this.querySelector<HTMLButtonElement>("[data-add-message]")?.addEventListener("click", () => this.dispatch("add-message", { body: this.querySelector<HTMLInputElement>("[data-message]")?.value ?? "" }));
    this.querySelector<HTMLButtonElement>("[data-add-artifact]")?.addEventListener("click", () => this.dispatch("add-artifact", { ref: this.querySelector<HTMLInputElement>("[data-artifact]")?.value ?? "" }));
  }

  private dispatch(kind: string, detail: Record<string, unknown> = {}): void {
    this.dispatchEvent(new CustomEvent(`woo-taskspace-${kind}`, { bubbles: true, detail }));
  }

  private actorLabel(id: string | undefined): string {
    if (!id) return "unknown";
    return String(this.woo?.observe(id)?.name ?? id);
  }
}

function activeTaskStatuses(filter: Record<string, boolean>): Set<string> {
  return new Set(TASK_STATUSES.filter((status) => filter[status] !== false));
}

function taskStatus(task: TaskspaceTask): string {
  return String(task?.props?.status ?? "open");
}

function taskMatchesStatus(task: TaskspaceTask, active: Set<string>): boolean {
  return active.has(taskStatus(task));
}

function countTasksByStatus(tasks: TaskspaceTask[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    const status = taskStatus(task);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function requirementStats(requirements: unknown): { total: number; checked: number } {
  const items = Array.isArray(requirements) ? requirements : [];
  return {
    total: items.length,
    checked: items.filter((item: any) => item?.checked === true).length
  };
}

function statusClass(status: string): string {
  return `status-${status.replace(/[^a-z0-9_-]/gi, "_") || "unknown"}`;
}

function statusLabel(status: string): string {
  if (status === "in_progress") return "in progress";
  return status || "unknown";
}

function renderArtifact(item: any): string {
  const ref = String(item?.ref ?? "");
  const kind = String(item?.kind ?? "external");
  const label = ref || "artifact";
  const body = ref.startsWith("http")
    ? `<a href="${escapeHtml(ref)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
    : `<span>${escapeHtml(label)}</span>`;
  return `<div class="artifact-item"><span>${escapeHtml(kind)}</span>${body}</div>`;
}

export function registerWooComponents(registry: WooComponentRegistry): void {
  registry.defineTag("woo-taskspace-workspace", WooTaskspaceWorkspaceElement);
}
