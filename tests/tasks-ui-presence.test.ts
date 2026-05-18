// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  WooTasksKanbanElement,
  type KanbanData
} from "../catalogs/tasks/ui/kanban-board";
import type { WooContext } from "../src/client/framework";

// jsdom render tests for the kanban presence aside. Mirrors
// outliner-ui-presence.test.ts. Pins (a) the .woo-tasks-presence aside exists
// inside .woo-tasks-layout, (b) actors render as .presence-list buttons,
// (c) empty roster falls back to a clear placeholder.

function ctx(names: Record<string, string> = {}): WooContext {
  return {
    actor: "guest_1",
    frame: { id: "frame", subject: "the_taskboard", get: () => undefined, set: () => true },
    neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
    observe: (ref) => ({ id: ref, name: names[ref] ?? ref, props: {}, catalogState: {} }),
    directCall: async () => undefined,
    send: async () => undefined,
    call: async () => undefined,
    emit: () => true
  };
}

function baseData(roster: KanbanData["roster"]): KanbanData {
  return {
    registryId: "the_taskboard",
    registryName: "Tasks",
    actor: "guest_1",
    actorNames: {},
    tasks: [],
    policies: [],
    isOwner: false,
    roles: [],
    obligations: [],
    policiesMap: {},
    roster
  };
}

describe("tasks-kanban presence aside", () => {
  beforeAll(() => {
    if (!customElements.get("woo-tasks-kanban")) {
      customElements.define("woo-tasks-kanban", WooTasksKanbanElement);
    }
  });

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders one .presence-list button per roster row", () => {
    const element = document.createElement("woo-tasks-kanban") as WooTasksKanbanElement & { data: KanbanData };
    element.woo = ctx();
    document.body.append(element);
    element.data = baseData([
      { id: "guest_1", name: "Alice", presence: "online" },
      { id: "guest_2", name: "Bob", presence: "online" }
    ]);

    const aside = element.querySelector(".woo-tasks-presence");
    expect(aside, "tasks-presence aside present").not.toBeNull();
    expect(aside?.querySelector("h2")?.textContent).toBe("Present");

    const buttons = aside?.querySelectorAll(".presence-list button") ?? [];
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toContain("Alice");
    expect(buttons[1].textContent).toContain("Bob");
  });

  it("falls back to a placeholder when the roster is empty", () => {
    const element = document.createElement("woo-tasks-kanban") as WooTasksKanbanElement & { data: KanbanData };
    element.woo = ctx();
    document.body.append(element);
    element.data = baseData([]);

    const aside = element.querySelector(".woo-tasks-presence");
    expect(aside, "presence aside still renders").not.toBeNull();
    expect(aside?.querySelector(".presence-list")?.textContent).toContain("No one is in this registry");
  });

  it("wraps the workarea + aside in .split.split--side-fixed.woo-tasks-layout", () => {
    const element = document.createElement("woo-tasks-kanban") as WooTasksKanbanElement & { data: KanbanData };
    element.woo = ctx();
    document.body.append(element);
    element.data = baseData([]);

    const split = element.querySelector(".split.split--side-fixed.woo-tasks-layout");
    expect(split, "tasks uses the shared side-fixed split layout").not.toBeNull();
    expect(split?.querySelector(".woo-tasks-workarea"), "main column is the workarea").not.toBeNull();
    expect(split?.querySelector(".woo-tasks-presence"), "side column is the presence aside").not.toBeNull();
  });
});
