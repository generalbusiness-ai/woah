// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import chatManifest from "../catalogs/chat/manifest.json";
import dubspaceManifest from "../catalogs/dubspace/manifest.json";
import pinboardManifest from "../catalogs/pinboard/manifest.json";
import tasksManifest from "../catalogs/tasks/manifest.json";
import weatherManifest from "../catalogs/weather/manifest.json";
import { CatalogUiRegistry, type WooContext } from "../src/client/framework";

function defineOnce(tag: string, ctor: CustomElementConstructor): void {
  if (!customElements.get(tag)) customElements.define(tag, ctor);
}

function makeDragEvent(type: string, target: HTMLElement, data: Record<string, string>): Event {
  const dataTransfer = {
    effectAllowed: "uninitialized" as string,
    dropEffect: "none" as string,
    getData: (key: string) => data[key] ?? "",
    setData: (key: string, value: string) => { data[key] = value; },
    clearData: (key?: string) => { if (key) delete data[key]; else for (const k of Object.keys(data)) delete data[k]; }
  } as unknown as DataTransfer;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

function testWooContext(names: Record<string, string> = {}): WooContext {
  return {
    actor: "guest_1",
    frame: { id: "test", subject: "subject", get: () => undefined, set: () => true },
    neighborhood: { subject: "subject", refs: [], related: {}, has: () => true },
    observe: (ref) => ({ id: ref, name: names[ref] ?? ref, props: {}, catalogState: {} }),
    call: async () => undefined,
    send: async () => undefined,
    directCall: async () => undefined,
    emit: () => true
  };
}

describe("bundled catalog UI components", () => {
  it("declares and resolves first-party tool frames", () => {
    const registry = new CatalogUiRegistry();
    expect(registry.installCatalogUi({ alias: "chat", catalog: "chat", objects: { "$space": "$space", "$chatroom": "$chatroom" }, ui: (chatManifest as any).ui })).toEqual([]);
    expect(registry.installCatalogUi({ alias: "dubspace", catalog: "dubspace", objects: { "$dubspace": "$dubspace" }, ui: (dubspaceManifest as any).ui })).toEqual([]);
    expect(registry.installCatalogUi({ alias: "pinboard", catalog: "pinboard", objects: { "$pinboard": "$pinboard" }, ui: (pinboardManifest as any).ui })).toEqual([]);
    expect(registry.installCatalogUi({ alias: "tasks", catalog: "tasks", objects: { "$task_registry": "$task_registry" }, ui: (tasksManifest as any).ui })).toEqual([]);
    expect(registry.installCatalogUi({ alias: "weather", catalog: "weather", objects: { "$weather_block": "$weather_block" }, ui: (weatherManifest as any).ui })).toEqual([]);

    expect(registry.resolveFrame("the_dubspace", undefined, (_subject, classRef) => classRef === "$dubspace" ? 1 : false)?.frame.id).toBe("dubspace.workspace");
    expect(registry.resolveFrame("the_pinboard", undefined, (_subject, classRef) => classRef === "$pinboard" ? 1 : false)?.frame.id).toBe("pinboard.board");
    expect(registry.resolveFrame("the_bug_board", undefined, (_subject, classRef) => classRef === "$task_registry" ? 1 : false)?.frame.id).toBe("tasks.kanban");
    expect(registry.componentsForSurface("title-badge").map((component) => component.declaration.tag)).toContain("woo-weather-badge");

    const weatherBadge = registry.componentsForSurface("title-badge").find((component) => component.declaration.tag === "woo-weather-badge");
    expect(weatherBadge?.declaration.requires).toEqual(expect.arrayContaining(["current", "config_state"]));
  });

  it("renders the weather title badge from current block data", async () => {
    const { WooWeatherBadgeElement } = await import("../catalogs/weather/ui/weather-badge");
    defineOnce("woo-weather-badge", WooWeatherBadgeElement);
    const element = document.createElement("woo-weather-badge") as HTMLElement & { data?: any };
    document.body.appendChild(element);

    element.data = {
      id: "the_weather",
      name: "Weather",
      props: {
        place: "Mountain View CA",
        config_state: { status: "confirmed" },
        current: { kind: "scalar", value: 72.4, unit: "°F", weather_code: 1000 }
      }
    };

    expect(element.querySelector(".weather-badge-temp")?.textContent).toBe("72°F");
    expect(element.querySelector(".weather-badge-condition")?.textContent).toBe("sunny");
  });

  it("self-fetches listing + available_actions via WooContext on connect and dispatches verbs on click", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const calls: { target: string; verb: string; args: unknown[] }[] = [];
    const listing = [
      {
        task: "obj_t_ready",
        name: "Triage cockatoo bug",
        kind: "bug",
        labels: ["urgent"],
        location: "the_bug_board",
        cursor_role: { key: "do:it", role: "doer", criterion: "Done." },
        wait_for_count: 0,
        terminal: false,
        complete: false,
        link_count: 0,
        age_ms: 12_000,
        last_change: 0
      }
    ];
    const woo: WooContext = {
      actor: "guest_1",
      frame: { id: "test", subject: "the_bug_board", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_bug_board", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_bug_board" ? "Bug Board" : ref === "guest_1" ? "Guest 1" : ref, props: {}, catalogState: {} }),
      call: async (target, verb, args = []) => {
        calls.push({ target, verb, args });
        if (verb === "listing") return listing;
        if (verb === "available_actions") return [{ verb: "claim", label: "Claim", args: [] }];
        if (verb === "claim") return null;
        return undefined;
      },
      send: async () => undefined,
      directCall: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; refresh?: () => Promise<void> };
    element.woo = woo;
    element.subject = "the_bug_board";
    document.body.appendChild(element);
    await element.refresh!();

    expect(element.querySelector<HTMLElement>("[data-tasks-card]")?.dataset.tasksCard).toBe("obj_t_ready");
    expect(element.querySelector("h2")?.textContent).toBe("Bug Board");
    expect(element.querySelector("[data-tasks-action=\"claim\"]")?.textContent).toBe("Claim");

    let detail: any;
    element.addEventListener("woo-tasks-action", (event: Event) => { detail = (event as CustomEvent).detail; });
    element.querySelector<HTMLButtonElement>("[data-tasks-action=\"claim\"]")?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(detail).toMatchObject({ taskId: "obj_t_ready", verb: "claim" });
    expect(calls.some((c) => c.target === "obj_t_ready" && c.verb === "claim")).toBe(true);
  });

  it("prompts for required args and dispatches with collected values", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const calls: { target: string; verb: string; args: unknown[] }[] = [];
    const woo: WooContext = {
      actor: "guest_1",
      frame: { id: "test", subject: "the_bug_board", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_bug_board", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_bug_board" ? "Bug Board" : ref, props: {}, catalogState: {} }),
      call: async (target, verb, args = []) => {
        calls.push({ target, verb, args });
        if (verb === "listing") return [];
        return null;
      },
      send: async () => undefined,
      directCall: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    element.woo = woo;
    element.subject = "the_bug_board";
    element.setAttribute("refresh-interval-ms", "0");
    document.body.appendChild(element);
    element.data = {
      registryId: "the_bug_board",
      registryName: "Bug Board",
      actor: "guest_1",
      actorNames: { guest_1: "Guest 1" },
      tasks: [{
        id: "obj_t_drop",
        name: "Drop me",
        kind: "bug",
        labels: [],
        location: "guest_1",
        cursorRole: "doer",
        cursorKey: "do:it",
        cursorCriterion: "Done.",
        waitForCount: 0,
        terminal: false,
        complete: false,
        linkCount: 0,
        ageMs: 1000,
        lastChange: 0,
        actions: [{ verb: "drop_terminal", label: "Drop", args: [{ name: "why", type: "str", required: true }] }]
      }]
    };

    const button = element.querySelector<HTMLButtonElement>("[data-tasks-action=\"drop_terminal\"]")!;
    expect(button.dataset.tasksActionNeedsArgs).toBe("true");
    button.click();
    const form = element.querySelector<HTMLFormElement>("form[data-tasks-prompt]")!;
    expect(form.dataset.taskId).toBe("obj_t_drop");
    expect(form.dataset.verb).toBe("drop_terminal");
    const why = form.querySelector<HTMLTextAreaElement>("textarea[name=\"why\"]")!;
    why.value = "duplicate";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.find((c) => c.verb === "drop_terminal")?.args).toEqual(["duplicate"]);
    expect(element.querySelector("form[data-tasks-prompt]")).toBeNull();
  });

  it("drags a Ready card into In flight to dispatch claim", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const calls: { target: string; verb: string; args: unknown[] }[] = [];
    const woo: WooContext = {
      actor: "guest_1",
      frame: { id: "test", subject: "the_bug_board", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_bug_board", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_bug_board" ? "Bug Board" : ref, props: {}, catalogState: {} }),
      call: async (target, verb, args = []) => {
        calls.push({ target, verb, args });
        if (verb === "listing") return [];
        return null;
      },
      send: async () => undefined,
      directCall: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    element.woo = woo;
    element.subject = "the_bug_board";
    element.setAttribute("refresh-interval-ms", "0");
    document.body.appendChild(element);
    element.data = {
      registryId: "the_bug_board",
      registryName: "Bug Board",
      actor: "guest_1",
      actorNames: { guest_1: "Guest 1" },
      tasks: [{
        id: "obj_t_drag",
        name: "Drag-claim me",
        kind: "bug",
        labels: [],
        location: "the_bug_board",
        cursorRole: "doer",
        cursorKey: "do:it",
        cursorCriterion: "Done.",
        waitForCount: 0,
        terminal: false,
        complete: false,
        linkCount: 0,
        ageMs: 1000,
        lastChange: 0,
        actions: [{ verb: "claim", label: "Claim", args: [] }]
      }]
    };
    const card = element.querySelector<HTMLElement>("[data-tasks-card=\"obj_t_drag\"]")!;
    const inFlight = element.querySelector<HTMLElement>("[data-tasks-col=\"in_flight\"]")!;
    expect(card.getAttribute("draggable")).toBe("true");

    const transferData: Record<string, string> = {};
    element.dispatchEvent(makeDragEvent("dragstart", card, transferData));
    expect(transferData["application/x-woo-task"]).toBe("obj_t_drag");
    expect(transferData["application/x-woo-task-source-col"]).toBe("ready");

    const overEvent = makeDragEvent("dragover", inFlight, transferData);
    element.dispatchEvent(overEvent);
    expect(overEvent.defaultPrevented).toBe(true);
    expect(inFlight.dataset.tasksDropTarget).toBe("true");

    let detail: any;
    element.addEventListener("woo-tasks-action", (event: Event) => { detail = (event as CustomEvent).detail; });
    const dropEvent = makeDragEvent("drop", inFlight, transferData);
    element.dispatchEvent(dropEvent);
    expect(detail).toMatchObject({ taskId: "obj_t_drag", verb: "claim", source: "drag" });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.some((c) => c.target === "obj_t_drag" && c.verb === "claim")).toBe(true);
  });

  it("polls listing on the configured interval and stops on disconnect", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    let listingCalls = 0;
    const woo: WooContext = {
      actor: null,
      frame: { id: "test", subject: "the_bug_board", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_bug_board", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_bug_board" ? "Bug Board" : ref, props: {}, catalogState: {} }),
      call: async (_target, verb) => {
        if (verb === "listing") {
          listingCalls += 1;
          return [];
        }
        return [];
      },
      send: async () => undefined,
      directCall: async () => undefined,
      emit: () => true
    };
    vi.useFakeTimers();
    try {
      const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string };
      element.woo = woo;
      element.subject = "the_bug_board";
      element.setAttribute("refresh-interval-ms", "100");
      document.body.appendChild(element);
      await vi.runOnlyPendingTimersAsync();
      const initialCalls = listingCalls;
      expect(initialCalls).toBeGreaterThanOrEqual(1);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      expect(listingCalls).toBeGreaterThan(initialCalls);
      const beforeDisconnect = listingCalls;
      element.remove();
      await vi.advanceTimersByTimeAsync(500);
      expect(listingCalls).toBe(beforeDisconnect);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the tasks kanban with state columns, cursor badges, and actions", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; data?: any };
    element.woo = testWooContext({ guest_1: "Guest 1", guest_2: "Guest 2" });
    document.body.appendChild(element);

    element.data = {
      registryId: "the_bug_board",
      registryName: "Bug Board",
      actor: "guest_1",
      actorNames: { guest_1: "Guest 1", guest_2: "Guest 2" },
      tasks: [
        {
          id: "obj_t_ready",
          name: "Triage cockatoo bug",
          kind: "bug",
          labels: ["urgent", "frontend"],
          location: "the_bug_board",
          cursorRole: "doer",
          cursorKey: "do:it",
          cursorCriterion: "Done.",
          waitForCount: 0,
          terminal: false,
          complete: false,
          linkCount: 0,
          ageMs: 90 * 1000,
          lastChange: 0,
          actions: [{ verb: "claim", label: "Claim", args: [] }]
        },
        {
          id: "obj_t_waiting",
          name: "Wait for review",
          kind: "task",
          labels: [],
          location: "the_bug_board",
          cursorRole: "doer",
          cursorKey: "do:it",
          cursorCriterion: "Done.",
          waitForCount: 1,
          terminal: false,
          complete: false,
          linkCount: 1,
          ageMs: 5 * 60 * 1000,
          lastChange: 0,
          actions: []
        },
        {
          id: "obj_t_inflight",
          name: "Refactor verb dispatch",
          kind: "task",
          labels: [],
          location: "guest_2",
          cursorRole: "doer",
          cursorKey: "do:it",
          cursorCriterion: "Done.",
          waitForCount: 0,
          terminal: false,
          complete: false,
          linkCount: 0,
          ageMs: 2 * 60 * 60 * 1000,
          lastChange: 0,
          actions: []
        },
        {
          id: "obj_t_done",
          name: "Ship v1 catalog",
          kind: "task",
          labels: [],
          location: "the_bug_board",
          cursorRole: null,
          cursorKey: null,
          cursorCriterion: null,
          waitForCount: 0,
          terminal: false,
          complete: true,
          linkCount: 0,
          ageMs: 24 * 60 * 60 * 1000,
          lastChange: 0,
          actions: []
        },
        {
          id: "obj_t_dropped",
          name: "Old plan",
          kind: "task",
          labels: [],
          location: "the_bug_board",
          cursorRole: null,
          cursorKey: null,
          cursorCriterion: null,
          waitForCount: 0,
          terminal: true,
          complete: false,
          linkCount: 0,
          ageMs: 0,
          lastChange: 0,
          actions: []
        }
      ]
    };

    expect(element.querySelector("h2")?.textContent).toBe("Bug Board");
    const colCounts = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col]")).map((col) => ({
      id: col.dataset.tasksCol,
      count: col.querySelector<HTMLElement>("[data-tasks-col-count]")?.textContent
    }));
    expect(colCounts).toEqual([
      { id: "ready", count: "1" },
      { id: "waiting", count: "1" },
      { id: "in_flight", count: "1" },
      { id: "done", count: "1" },
      { id: "dropped", count: "1" }
    ]);

    const readyCard = element.querySelector<HTMLElement>("[data-tasks-col=\"ready\"] [data-tasks-card]");
    expect(readyCard?.dataset.tasksCard).toBe("obj_t_ready");
    expect(readyCard?.querySelector(".woo-tasks-card-name")?.textContent).toBe("Triage cockatoo bug");
    expect(readyCard?.querySelector("[data-tasks-card-cursor]")?.textContent).toBe("doer");

    const inflightCard = element.querySelector<HTMLElement>("[data-tasks-col=\"in_flight\"] [data-tasks-card]");
    expect(inflightCard?.querySelector(".woo-tasks-card-holder")?.textContent).toContain("Guest 2");

    let detail: any;
    element.addEventListener("woo-tasks-action", (event: Event) => { detail = (event as CustomEvent).detail; });
    element.querySelector<HTMLButtonElement>("[data-tasks-action=\"claim\"]")?.click();
    expect(detail).toMatchObject({ taskId: "obj_t_ready", verb: "claim", label: "Claim" });
  });

  it("renders pinboard notes and emits create events", async () => {
    const { WooPinboardBoardElement } = await import("../catalogs/pinboard/ui/pinboard-board");
    defineOnce("woo-pinboard-board", WooPinboardBoardElement);
    const element = document.createElement("woo-pinboard-board") as HTMLElement & { woo?: WooContext; data?: any };
    element.woo = testWooContext({ guest_1: "Guest 1" });
    document.body.appendChild(element);

    element.data = {
      boardId: "the_pinboard",
      boardName: "Pinboard",
      boardOwner: "guest_1",
      notes: [{ id: "note_1", text: "hello", x: 10, y: 20, w: 180, h: 110, author: "guest_1", color: "pink" }],
      present: ["guest_1"],
      palette: ["yellow", "pink", "white"],
      viewport: { w: 960, h: 560 },
      view: { x: 0, y: 0, scale: 1 },
      actor: "guest_1",
      inBoard: true,
      canSend: true,
      newText: "draft",
      newColor: "pink",
      viewports: {}
    };

    expect(element.querySelector<HTMLTextAreaElement>("[data-pin-note-text]")?.value).toBe("hello");
    let detail: any;
    element.addEventListener("woo-pinboard-create", (event: Event) => { detail = (event as CustomEvent).detail; });
    element.querySelector<HTMLFormElement>("[data-pinboard-create]")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(detail).toMatchObject({ text: "draft", color: "pink" });
  });

  it("renders dubspace controls and emits control commits", async () => {
    const { WooDubspaceWorkspaceElement } = await import("../catalogs/dubspace/ui/dubspace-workspace");
    defineOnce("woo-dubspace-workspace", WooDubspaceWorkspaceElement);
    const element = document.createElement("woo-dubspace-workspace") as HTMLElement & { woo?: WooContext; data?: any };
    element.woo = testWooContext({ guest_1: "Guest 1" });
    document.body.appendChild(element);

    element.data = {
      spaceId: "the_dubspace",
      spaceName: "Dubspace",
      spaceDescription: "",
      controls: {
        filter_1: { id: "filter_1", name: "Filter", props: { cutoff: 500 } },
        delay_1: { id: "delay_1", name: "Delay", props: { send: 0.1, time: 0.2, feedback: 0.3, wet: 0.4 } },
        drum_1: { id: "drum_1", name: "Drum", props: { bpm: 120, pattern: { kick: [true, false] } } }
      },
      slots: [],
      filter: "filter_1",
      delay: "delay_1",
      drum: "drum_1",
      operators: ["guest_1"],
      actor: "guest_1",
      inSpace: true,
      canSend: true,
      audioOn: false,
      cueSlots: {},
      cuePlaying: {}
    };

    let detail: any;
    element.addEventListener("woo-dubspace-control-commit", (event: Event) => { detail = (event as CustomEvent).detail; });
    const cutoff = element.querySelector<HTMLInputElement>('[data-target="filter_1"][data-name="cutoff"]')!;
    cutoff.value = "750";
    cutoff.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(detail).toMatchObject({ target: "filter_1", name: "cutoff", value: 750 });
  });

});
