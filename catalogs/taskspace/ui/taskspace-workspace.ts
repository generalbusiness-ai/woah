import {
  escapeHtml,
  type ObservationRegistry,
  type WooComponentRegistry,
  type WooContext
} from "../../../src/client/framework";

export type TaskspaceTask = {
  id: string;
  name?: string;
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
      <button class="pill status-filter ${statusClass(status)} ${active ? "active" : ""}" data-task-status="${escapeHtml(status)}" aria-pressed="${active}">
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
          <button class="task-toggle" data-toggle-task="${escapeHtml(id)}" aria-label="Toggle ${escapeHtml(String(task.name ?? id))}" ${subtasks.length === 0 ? "disabled" : ""}>${subtasks.length === 0 ? "" : expanded ? "-" : "+"}</button>
          <button class="task-select" data-select-task="${escapeHtml(id)}">
            <span class="task-title">${escapeHtml(String(task.name ?? id))}</span>
            <span class="task-meta">
              <span class="pill ${statusClass(String(props.status ?? ""))}">${escapeHtml(statusLabel(String(props.status ?? "")))}</span>
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
          <h2>${escapeHtml(String(task.name ?? task.id ?? ""))}</h2>
          <p>${escapeHtml(String(props.text ?? "No description."))}</p>
        </div>
        <span class="pill ${statusClass(String(props.status ?? ""))}">${escapeHtml(statusLabel(String(props.status ?? "")))}</span>
      </div>
      <div class="task-facts">
        <div class="card card--tight"><strong>ID</strong><span>${escapeHtml(task.id)}</span></div>
        <div class="card card--tight"><strong>Assignee</strong><span>${escapeHtml(String(props.assignee ? this.actorLabel(String(props.assignee)) : "none"))}</span></div>
        <div class="card card--tight"><strong>Requirements</strong><span>${reqStats.checked}/${reqStats.total}</span></div>
        <div class="card card--tight"><strong>Subtasks</strong><span>${subtasks.length}</span></div>
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
        <span>${escapeHtml(String(task.name ?? id))}</span>
        <span class="pill ${statusClass(String(props.status ?? ""))}">${escapeHtml(statusLabel(String(props.status ?? "")))}</span>
      </button>
    `;
  }

  private renderTaskMessage(item: any): string {
    const actor = typeof item?.actor === "string" ? this.actorLabel(item.actor) : "unknown";
    const ts = typeof item?.ts === "number" ? new Date(item.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    return `
      <div class="card card--raised card--tight activity-item">
        <div><strong>${escapeHtml(actor)}</strong><span>${escapeHtml(ts)}</span></div>
        <p>${escapeHtml(String(item?.body ?? ""))}</p>
      </div>
    `;
  }

  private bind(): void {
    this.querySelectorAll<HTMLButtonElement>("[data-task-status]").forEach((button) => button.addEventListener("click", () => this.dispatch("status-filter", { status: button.dataset.taskStatus ?? "" })));
    this.querySelector<HTMLButtonElement>("[data-create-task]")?.addEventListener("click", () => {
      this.dispatch("create", {
        name: this.querySelector<HTMLInputElement>("[data-new-title]")?.value ?? "",
        text: this.querySelector<HTMLInputElement>("[data-new-description]")?.value ?? ""
      });
    });
    this.querySelectorAll<HTMLButtonElement>("[data-toggle-task]").forEach((button) => button.addEventListener("click", () => this.dispatch("toggle", { id: button.dataset.toggleTask ?? "" })));
    this.querySelectorAll<HTMLButtonElement>("[data-select-task]").forEach((button) => button.addEventListener("click", () => this.dispatch("select", { id: button.dataset.selectTask ?? "" })));
    this.querySelectorAll<HTMLButtonElement>("[data-task-action]").forEach((button) => button.addEventListener("click", () => this.dispatch("task-action", { action: button.dataset.taskAction ?? "" })));
    this.querySelector<HTMLButtonElement>("[data-add-subtask]")?.addEventListener("click", () => this.dispatch("add-subtask", {
      name: this.querySelector<HTMLInputElement>("[data-subtask-title]")?.value ?? "",
      text: this.querySelector<HTMLInputElement>("[data-subtask-description]")?.value ?? ""
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
  switch (status) {
    case "claimed":
    case "in_progress": return "pill--info";
    case "blocked": return "pill--warning";
    case "done": return "pill--success";
    case "open": return "pill--strong";
    default: return "";
  }
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
  return `<div class="card card--raised card--tight artifact-item"><span>${escapeHtml(kind)}</span>${body}</div>`;
}

export function registerWooComponents(registry: WooComponentRegistry): void {
  registry.defineTag("woo-taskspace-workspace", WooTaskspaceWorkspaceElement);
}

export function registerWooObservationHandlers(registry: ObservationRegistry): void {
  registry.observation({
    types: ["task_created"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      const task = String(obs.task ?? "");
      if (!task) return;
      const parent = typeof obs.parent === "string" ? obs.parent : null;
      const space = String(obs.space ?? envelope.delivered.space ?? "");
      // The taskspace verb emits `name` (the v0.2 $note identity slot).
      // Tolerate the legacy `title` shape from older world frames during
      // gap recovery so a mid-upgrade replay still projects cleanly.
      const name = typeof obs.name === "string" ? obs.name : typeof obs.title === "string" ? obs.title : undefined;
      draft.patchObject(task, { name });
      const text = typeof obs.text === "string" ? obs.text : undefined;
      draft.patchObjectProps(task, {
        name,
        text,
        parent_task: parent,
        status: "open",
        space: space || undefined
      });
      draft.patchCatalogState(task, "taskspace_task", {
        name,
        text,
        parent_task: parent,
        status: "open",
        space: space || undefined
      });
      if (space) draft.patchCatalogState(space, "taskspace_tree", { [task]: parent });
    }
  });
  registry.observation({
    types: ["subtask_added", "task_moved"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      const task = String(obs.child ?? obs.task ?? "");
      if (!task) return;
      const parent = typeof obs.parent === "string"
        ? obs.parent
        : typeof obs.to_parent === "string"
          ? obs.to_parent
          : null;
      const index = Number(obs.index);
      const space = String(obs.space ?? envelope.delivered.space ?? "");
      draft.patchObjectProps(task, { parent_task: parent });
      draft.patchCatalogState(task, "taskspace_task", { parent_task: parent });
      if (space) {
        draft.patchCatalogState(space, "taskspace_tree", {
          [task]: parent,
          [`index:${task}`]: Number.isFinite(index) ? index : undefined
        });
      }
    }
  });
  registry.observation({
    types: ["task_claimed", "task_released", "status_changed"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      const task = String(obs.task ?? "");
      if (!task) return;
      const props: Record<string, unknown> = {};
      if (obs.type === "task_claimed") {
        props.assignee = obs.actor;
        props.status = "claimed";
      } else if (obs.type === "task_released") {
        props.assignee = null;
        props.status = "open";
      } else {
        props.status = obs.to;
      }
      draft.patchObjectProps(task, props);
      draft.patchCatalogState(task, "taskspace_task", props);
    }
  });
  registry.observation({
    types: ["requirement_added", "requirement_checked", "message_added", "artifact_attached"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      const task = String(obs.task ?? "");
      if (!task) return;
      if (obs.type === "requirement_added") {
        const index = Number(obs.index);
        if (Number.isFinite(index)) {
          draft.patchCatalogState(task, "taskspace_task", { [`requirement:${index}`]: { text: obs.text, checked: false } });
        }
      } else if (obs.type === "requirement_checked") {
        const index = Number(obs.index);
        if (Number.isFinite(index)) {
          draft.patchCatalogState(task, "taskspace_task", { [`requirement_checked:${index}`]: obs.checked === true });
        }
      } else if (obs.type === "message_added") {
        const ts = Number(obs.ts);
        const key = Number.isFinite(ts) ? `message:${ts}` : `message:${envelope.delivered.seq ?? envelope.delivered.receivedAt}`;
        draft.patchCatalogState(task, "taskspace_task", { [key]: { actor: obs.actor, body: obs.body, ts: Number.isFinite(ts) ? ts : undefined } });
      } else {
        const ref = obs.ref;
        const addedAt = ref && typeof ref === "object" && !Array.isArray(ref) ? Number((ref as any).added_at) : NaN;
        const key = Number.isFinite(addedAt) ? `artifact:${addedAt}` : `artifact:${envelope.delivered.seq ?? envelope.delivered.receivedAt}`;
        draft.patchCatalogState(task, "taskspace_task", { [key]: ref });
      }
    }
  });
  // The board overlay on a task mirrors text/writers for fast component access;
  // the underlying obj.props patch happens in the framework's generic handler
  // so non-board surfaces also see the update.
  registry.observation({
    types: ["note_edited"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const note = String(envelope.observation.note ?? envelope.observation.id ?? "");
      if (note) draft.patchCatalogState(note, "taskspace_task", { text: envelope.observation.text });
    }
  });
  registry.observation({
    types: ["note_writers_changed"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const note = String(envelope.observation.note ?? envelope.observation.id ?? "");
      if (!note) return;
      const writers = Array.isArray(envelope.observation.writers)
        ? envelope.observation.writers.filter((item) => typeof item === "string")
        : [];
      draft.patchCatalogState(note, "taskspace_task", { writers });
    }
  });
}
