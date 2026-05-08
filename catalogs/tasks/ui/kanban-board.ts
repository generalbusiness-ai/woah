import { escapeHtml, type WooComponentRegistry, type WooContext } from "../../../src/client/framework";

export type KanbanData = {
  registryId: string;
  registryName: string;
  actor: string | null;
};

export class WooTasksKanbanElement extends HTMLElement {
  woo?: WooContext;
  subject?: string;
  private model: KanbanData = {
    registryId: "",
    registryName: "Tasks",
    actor: null
  };

  set data(value: KanbanData) {
    this.model = value;
    this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  private render(): void {
    const name = this.model.registryName || "Tasks";
    this.innerHTML = `
      <section class="woo-tasks-kanban">
        <header class="woo-tasks-kanban-header"><h2>${escapeHtml(name)}</h2></header>
        <div class="woo-tasks-kanban-empty">Kanban view — not yet implemented.</div>
      </section>
    `;
  }
}

export function registerWooComponents(registry: WooComponentRegistry): void {
  registry.defineTag("woo-tasks-kanban", WooTasksKanbanElement);
}
