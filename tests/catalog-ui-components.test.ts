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
    directCall: async () => undefined,
    send: async () => undefined,
    call: async () => undefined,
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
    expect(registry.resolveFrame("the_taskboard", undefined, (_subject, classRef) => classRef === "$task_registry" ? 1 : false)?.frame.id).toBe("tasks.kanban");
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
        location: "the_taskboard",
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
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_taskboard" ? "Taskboard" : ref === "guest_1" ? "Guest 1" : ref, props: {}, catalogState: {} }),
      directCall: async (target, verb, args = []) => {
        calls.push({ target, verb, args });
        if (verb === "listing") return listing;
        if (verb === "available_actions") return [{ verb: "claim", label: "Claim", args: [] }];
        if (verb === "claim") return null;
        return undefined;
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; refresh?: () => Promise<void> };
    element.woo = woo;
    element.subject = "the_taskboard";
    document.body.appendChild(element);
    await element.refresh!();

    expect(element.querySelector<HTMLElement>("[data-tasks-card]")?.dataset.tasksCard).toBe("obj_t_ready");
    expect(element.querySelector("h2")?.textContent).toBe("Taskboard");
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
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_taskboard" ? "Taskboard" : ref, props: {}, catalogState: {} }),
      directCall: async (target, verb, args = []) => {
        calls.push({ target, verb, args });
        if (verb === "listing") return [];
        return null;
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    element.woo = woo;
    element.subject = "the_taskboard";
    element.setAttribute("refresh-interval-ms", "0");
    document.body.appendChild(element);
    element.data = {
      registryId: "the_taskboard",
      registryName: "Taskboard",
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

  it("admin overlay sets a role / obligation / policy and fires the verbs in order, plus remove buttons", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const calls: { target: string; verb: string; args: unknown[] }[] = [];
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    const registryProps: Record<string, unknown> = {
      roles: { doer: { description: "Does", owners: ["$wiz"] } },
      obligations: { "do:it": { role: "doer", criterion: "Done." } },
      policies: { task: ["do:it"] }
    };
    const woo: WooContext = {
      actor: "$wiz",
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_taskboard" ? "Taskboard" : ref, owner: "$wiz", props: ref === "the_taskboard" ? registryProps : {}, catalogState: {} }),
      directCall: async (target, verb, args = []) => {
        calls.push({ target, verb, args });
        if (verb === "listing") return [];
        return null;
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    element.woo = woo;
    element.subject = "the_taskboard";
    element.setAttribute("refresh-interval-ms", "0");
    document.body.appendChild(element);
    element.data = {
      registryId: "the_taskboard",
      registryName: "Taskboard",
      actor: "$wiz",
      actorNames: {},
      tasks: [],
      policies: ["task"],
      isOwner: true,
      roles: [{ name: "doer", description: "Does", owners: ["$wiz"] }],
      obligations: [{ key: "do:it", role: "doer", criterion: "Done." }],
      policiesMap: { task: ["do:it"] }
    };

    // Toggle open the admin panel.
    element.querySelector<HTMLButtonElement>("[data-tasks-admin-toggle]")!.click();
    const panel = element.querySelector("[data-tasks-admin-form='role']") as HTMLFormElement | null;
    expect(panel).not.toBeNull();

    // Add a role.
    const roleForm = element.querySelector("[data-tasks-admin-form='role']") as HTMLFormElement;
    roleForm.querySelector<HTMLInputElement>('input[name="name"]')!.value = "reviewer";
    roleForm.querySelector<HTMLInputElement>('input[name="description"]')!.value = "Reviews work";
    roleForm.querySelector<HTMLInputElement>('input[name="owners"]')!.value = "guest_a, guest_b";
    roleForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const setRole = calls.find((c) => c.verb === "set_role");
    expect(setRole?.args).toEqual(["reviewer", { description: "Reviews work", owners: ["guest_a", "guest_b"] }]);

    // Add an obligation.
    const obForm = element.querySelector("[data-tasks-admin-form='obligation']") as HTMLFormElement;
    obForm.querySelector<HTMLInputElement>('input[name="key"]')!.value = "review:approve";
    obForm.querySelector<HTMLSelectElement>('select[name="role"]')!.value = "doer";
    obForm.querySelector<HTMLInputElement>('input[name="criterion"]')!.value = "Reviewer approves.";
    obForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const setOb = calls.find((c) => c.verb === "set_obligation");
    expect(setOb?.args).toEqual(["review:approve", { role: "doer", criterion: "Reviewer approves." }]);

    // Add a policy.
    const polForm = element.querySelector("[data-tasks-admin-form='policy']") as HTMLFormElement;
    polForm.querySelector<HTMLInputElement>('input[name="kind"]')!.value = "review";
    polForm.querySelector<HTMLInputElement>('input[name="keys"]')!.value = "do:it, review:approve";
    polForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const setPol = calls.find((c) => c.verb === "set_policy");
    expect(setPol?.args).toEqual(["review", ["do:it", "review:approve"]]);

    // Remove buttons fire the matching remove_* verbs with the targeted key.
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-remove="role"][data-key="doer"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-remove="obligation"][data-key="do:it"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-remove="policy"][data-key="task"]')!.click();
    await flush();
    expect(calls.find((c) => c.verb === "remove_role")?.args).toEqual(["doer"]);
    expect(calls.find((c) => c.verb === "remove_obligation")?.args).toEqual(["do:it"]);
    expect(calls.find((c) => c.verb === "remove_policy")?.args).toEqual(["task"]);
  });

  it("inline-edits name, body, and labels in the detail panel", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const calls: { target: string; verb: string; args: unknown[] }[] = [];
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    const detail = {
      id: "obj_t_edit",
      name: "Old name",
      text: "old body",
      kind: "task",
      labels: ["alpha"],
      obligations: [],
      log: [],
      wait_for: [],
      links: [],
      terminal: false,
      complete: false,
      cursor: null,
      location: "the_taskboard"
    };
    const woo: WooContext = {
      actor: "$wiz",
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_taskboard" ? "Taskboard" : ref, props: {}, catalogState: {} }),
      directCall: async (target, verb, args = []) => {
        calls.push({ target, verb, args });
        if (verb === "listing") return [];
        if (verb === "detail") return detail;
        return null;
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    element.woo = woo;
    element.subject = "the_taskboard";
    element.setAttribute("refresh-interval-ms", "0");
    document.body.appendChild(element);
    element.data = {
      registryId: "the_taskboard",
      registryName: "Taskboard",
      actor: "$wiz",
      actorNames: {},
      tasks: [{
        id: "obj_t_edit", name: "Old name", kind: "task", labels: ["alpha"],
        location: "the_taskboard", cursorRole: null, cursorKey: null, cursorCriterion: null,
        waitForCount: 0, terminal: false, complete: false, linkCount: 0,
        ageMs: 1000, lastChange: 0, actions: []
      }],
      policies: ["task"],
      isOwner: true
    };
    element.querySelector<HTMLElement>('[data-tasks-card="obj_t_edit"]')!.click();
    await flush();

    // Rename
    element.querySelector<HTMLButtonElement>('[data-tasks-detail-edit-open="name"]')!.click();
    const nameForm = element.querySelector<HTMLFormElement>('[data-tasks-detail-edit="name"]')!;
    nameForm.querySelector<HTMLInputElement>('input[name="name"]')!.value = "Renamed";
    nameForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(calls.find((c) => c.verb === "set_name")?.args).toEqual(["Renamed"]);

    // Edit body
    element.querySelector<HTMLButtonElement>('[data-tasks-detail-edit-open="text"]')!.click();
    const textForm = element.querySelector<HTMLFormElement>('[data-tasks-detail-edit="text"]')!;
    textForm.querySelector<HTMLTextAreaElement>('textarea[name="text"]')!.value = "new body content";
    textForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(calls.find((c) => c.verb === "set_text")?.args).toEqual(["new body content"]);

    // Edit labels
    element.querySelector<HTMLButtonElement>('[data-tasks-detail-edit-open="labels"]')!.click();
    const labForm = element.querySelector<HTMLFormElement>('[data-tasks-detail-edit="labels"]')!;
    labForm.querySelector<HTMLInputElement>('input[name="labels"]')!.value = "beta, gamma";
    labForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(calls.find((c) => c.verb === "set_labels")?.args).toEqual([["beta", "gamma"]]);
  });

  it("opens a detail panel on card click, fetching :detail and rendering obligations + log", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const calls: { target: string; verb: string; args: unknown[] }[] = [];
    const detail = {
      id: "obj_t_view",
      name: "Refactor verb dispatch",
      text: "details about it\nmulti-line",
      kind: "task",
      labels: ["frontend"],
      obligations: [
        { key: "design", met: true, role: "designer", criterion: "Sketch.", evidence: { commit: "abc" } },
        { key: "do:it", met: false, role: "doer", criterion: "Done." }
      ],
      log: [
        { ts: 1_700_000_000_000, actor: "guest_1", outcome: "created" },
        { ts: 1_700_000_300_000, actor: "guest_1", outcome: "passed", obligation_key: "design", evidence: { commit: "abc" } }
      ],
      wait_for: [],
      links: [{ to: "obj_t_other", role: "parent" }],
      terminal: false,
      complete: false,
      cursor: { key: "do:it", role: "doer", criterion: "Done." },
      location: "the_taskboard"
    };
    const woo: WooContext = {
      actor: "guest_1",
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_taskboard" ? "Taskboard" : ref === "guest_1" ? "Guest 1" : ref, props: {}, catalogState: {} }),
      directCall: async (target, verb, args = []) => {
        calls.push({ target, verb, args });
        if (verb === "listing") return [];
        if (verb === "detail") return detail;
        return undefined;
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    element.woo = woo;
    element.subject = "the_taskboard";
    element.setAttribute("refresh-interval-ms", "0");
    document.body.appendChild(element);
    element.data = {
      registryId: "the_taskboard",
      registryName: "Taskboard",
      actor: "guest_1",
      actorNames: { guest_1: "Guest 1" },
      tasks: [{
        id: "obj_t_view",
        name: "Refactor verb dispatch",
        kind: "task",
        labels: ["frontend"],
        location: "the_taskboard",
        cursorRole: "doer",
        cursorKey: "do:it",
        cursorCriterion: "Done.",
        waitForCount: 0,
        terminal: false,
        complete: false,
        linkCount: 1,
        ageMs: 1000,
        lastChange: 0,
        actions: []
      }],
      policies: ["task"],
      isOwner: false
    };
    const card = element.querySelector<HTMLElement>('[data-tasks-card="obj_t_view"]')!;
    card.click();
    await Promise.resolve();
    await Promise.resolve();
    const panel = element.querySelector<HTMLElement>('[data-tasks-detail]');
    expect(panel).not.toBeNull();
    expect(panel!.querySelector(".woo-tasks-detail-name")?.textContent).toBe("Refactor verb dispatch");
    expect(panel!.querySelector(".woo-tasks-detail-text")?.textContent).toContain("multi-line");
    const obligations = Array.from(panel!.querySelectorAll(".woo-tasks-detail-obligation"));
    expect(obligations).toHaveLength(2);
    expect(obligations[0].classList.contains("met")).toBe(true);
    expect(obligations[1].classList.contains("current")).toBe(true);
    expect(panel!.querySelectorAll(".woo-tasks-detail-log-entry")).toHaveLength(2);
    expect(calls.find((c) => c.target === "obj_t_view" && c.verb === "detail")).toBeDefined();
    panel!.querySelector<HTMLButtonElement>("[data-tasks-detail-close]")!.click();
    expect(element.querySelector('[data-tasks-detail]')).toBeNull();
  });

  it("opens the create-task form, submits with collected fields, and refreshes", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const calls: { target: string; verb: string; args: unknown[] }[] = [];
    const woo: WooContext = {
      actor: "guest_1",
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_taskboard" ? "Taskboard" : ref, props: {}, catalogState: {} }),
      directCall: async (target, verb, args = []) => {
        calls.push({ target, verb, args });
        if (verb === "listing") return [];
        if (verb === "create_task") return "obj_t_new";
        return undefined;
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    element.woo = woo;
    element.subject = "the_taskboard";
    element.setAttribute("refresh-interval-ms", "0");
    document.body.appendChild(element);
    element.data = {
      registryId: "the_taskboard",
      registryName: "Taskboard",
      actor: "guest_1",
      actorNames: { guest_1: "Guest 1" },
      tasks: [],
      policies: ["task", "bug"],
      isOwner: true
    };

    const openBtn = element.querySelector<HTMLButtonElement>("[data-tasks-create-open]");
    expect(openBtn).not.toBeNull();
    openBtn!.click();
    const form = element.querySelector<HTMLFormElement>("[data-tasks-create]");
    expect(form).not.toBeNull();
    const kindSelect = form!.querySelector<HTMLSelectElement>('select[name="kind"]')!;
    expect(Array.from(kindSelect.options).map((opt) => opt.value)).toEqual(["task", "bug"]);
    kindSelect.value = "bug";
    form!.querySelector<HTMLInputElement>('input[name="name"]')!.value = "Refactor verb dispatch";
    form!.querySelector<HTMLTextAreaElement>('textarea[name="text"]')!.value = "details";
    form!.querySelector<HTMLInputElement>('input[name="labels"]')!.value = "frontend, urgent";
    form!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    const create = calls.find((c) => c.verb === "create_task");
    expect(create?.args).toEqual(["bug", "Refactor verb dispatch", "details", ["frontend", "urgent"], null]);
  });

  it("offers seed_minimal_policy when no policies and the actor is owner", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const calls: { target: string; verb: string; args: unknown[] }[] = [];
    const woo: WooContext = {
      actor: "$wiz",
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_taskboard" ? "Taskboard" : ref, props: {}, catalogState: {} }),
      directCall: async (target, verb, args = []) => {
        calls.push({ target, verb, args });
        if (verb === "listing") return [];
        if (verb === "seed_minimal_policy") return true;
        return undefined;
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    element.woo = woo;
    element.subject = "the_taskboard";
    element.setAttribute("refresh-interval-ms", "0");
    document.body.appendChild(element);
    element.data = {
      registryId: "the_taskboard",
      registryName: "Taskboard",
      actor: "$wiz",
      actorNames: {},
      tasks: [],
      policies: [],
      isOwner: true
    };

    expect(element.querySelector("[data-tasks-create-open]")).toBeNull();
    const seedBtn = element.querySelector<HTMLButtonElement>("[data-tasks-seed-policy]");
    expect(seedBtn).not.toBeNull();
    seedBtn!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.find((c) => c.verb === "seed_minimal_policy")?.args).toEqual(["$wiz"]);
  });

  it("drags a Ready card into In flight to dispatch claim", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const calls: { target: string; verb: string; args: unknown[] }[] = [];
    const woo: WooContext = {
      actor: "guest_1",
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_taskboard" ? "Taskboard" : ref, props: {}, catalogState: {} }),
      directCall: async (target, verb, args = []) => {
        calls.push({ target, verb, args });
        if (verb === "listing") return [];
        return null;
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    element.woo = woo;
    element.subject = "the_taskboard";
    element.setAttribute("refresh-interval-ms", "0");
    document.body.appendChild(element);
    element.data = {
      registryId: "the_taskboard",
      registryName: "Taskboard",
      actor: "guest_1",
      actorNames: { guest_1: "Guest 1" },
      tasks: [{
        id: "obj_t_drag",
        name: "Drag-claim me",
        kind: "bug",
        labels: [],
        location: "the_taskboard",
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
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_taskboard" ? "Taskboard" : ref, props: {}, catalogState: {} }),
      directCall: async (_target, verb) => {
        if (verb === "listing") {
          listingCalls += 1;
          return [];
        }
        return [];
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    };
    vi.useFakeTimers();
    try {
      const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string };
      element.woo = woo;
      element.subject = "the_taskboard";
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
      registryId: "the_taskboard",
      registryName: "Taskboard",
      actor: "guest_1",
      actorNames: { guest_1: "Guest 1", guest_2: "Guest 2" },
      tasks: [
        {
          id: "obj_t_ready",
          name: "Triage cockatoo bug",
          kind: "bug",
          labels: ["urgent", "frontend"],
          location: "the_taskboard",
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
          location: "the_taskboard",
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
          location: "the_taskboard",
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
          location: "the_taskboard",
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

    expect(element.querySelector("h2")?.textContent).toBe("Taskboard");
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

  it("regroups columns by role / holder / kind when the group-by selector changes", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; data?: any };
    element.woo = testWooContext({ guest_1: "Guest 1", guest_2: "Guest 2" });
    document.body.appendChild(element);

    element.data = {
      registryId: "the_taskboard",
      registryName: "Taskboard",
      actor: "guest_1",
      actorNames: { guest_1: "Guest 1", guest_2: "Guest 2" },
      tasks: [
        { id: "obj_t_a", name: "A", kind: "bug",  labels: [], location: "the_taskboard", cursorRole: "doer",     cursorKey: "k", cursorCriterion: "c", waitForCount: 0, terminal: false, complete: false, linkCount: 0, ageMs: 0, lastChange: 0, actions: [] },
        { id: "obj_t_b", name: "B", kind: "bug",  labels: [], location: "guest_2",       cursorRole: "doer",     cursorKey: "k", cursorCriterion: "c", waitForCount: 0, terminal: false, complete: false, linkCount: 0, ageMs: 0, lastChange: 0, actions: [] },
        { id: "obj_t_c", name: "C", kind: "task", labels: [], location: "the_taskboard", cursorRole: "reviewer", cursorKey: "k", cursorCriterion: "c", waitForCount: 0, terminal: false, complete: false, linkCount: 0, ageMs: 0, lastChange: 0, actions: [] }
      ]
    };

    const setGroup = (value: string) => {
      const sel = element.querySelector<HTMLSelectElement>("[data-tasks-group-by]")!;
      sel.value = value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    };

    // default: state grouping; 5 columns
    let cols = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col]")).map((c) => c.dataset.tasksCol);
    expect(cols).toEqual(["ready", "waiting", "in_flight", "done", "dropped"]);

    expect(element.querySelector<HTMLSelectElement>("[data-tasks-group-by]")?.value).toBe("state");

    // group by role: distinct cursor roles
    setGroup("role");
    cols = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col]")).map((c) => c.dataset.tasksCol);
    expect(cols).toEqual(["doer", "reviewer"]);
    const doerCol = element.querySelector<HTMLElement>("[data-tasks-col=\"doer\"]")!;
    expect(doerCol.querySelectorAll("[data-tasks-card]").length).toBe(2);

    // group by holder: registry first, then guest_2
    setGroup("holder");
    cols = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col]")).map((c) => c.dataset.tasksCol);
    expect(cols).toEqual(["", "guest_2"]);
    const inRegCol = element.querySelector<HTMLElement>("[data-tasks-col=\"\"]")!;
    expect(inRegCol.querySelector(".woo-tasks-kanban-col-name")?.textContent).toBe("in registry");
    const guest2Col = element.querySelector<HTMLElement>("[data-tasks-col=\"guest_2\"]")!;
    expect(guest2Col.querySelector(".woo-tasks-kanban-col-name")?.textContent).toBe("Guest 2");

    // group by kind
    setGroup("kind");
    cols = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col]")).map((c) => c.dataset.tasksCol);
    expect(cols).toEqual(["bug", "task"]);

    // when not in state mode, cards lose the draggable attribute even if their actions include claim
    element.data = {
      registryId: "the_taskboard",
      registryName: "Taskboard",
      actor: "guest_1",
      actorNames: { guest_1: "Guest 1" },
      tasks: [
        { id: "obj_t_d", name: "D", kind: "bug", labels: [], location: "the_taskboard", cursorRole: "doer", cursorKey: "k", cursorCriterion: "c", waitForCount: 0, terminal: false, complete: false, linkCount: 0, ageMs: 0, lastChange: 0, actions: [{ verb: "claim", label: "Claim", args: [] }] }
      ]
    };
    // group-by survives data updates because it is local UI state
    expect(element.querySelector<HTMLSelectElement>("[data-tasks-group-by]")?.value).toBe("kind");
    const card = element.querySelector<HTMLElement>("[data-tasks-card]")!;
    expect(card.getAttribute("draggable")).toBe(null);

    // back to state restores draggability
    setGroup("state");
    const draggableCard = element.querySelector<HTMLElement>("[data-tasks-card]")!;
    expect(draggableCard.getAttribute("draggable")).toBe("true");
  });

  it("filters by free-text search and label chips", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; data?: any };
    element.woo = testWooContext({ guest_1: "Guest 1" });
    document.body.appendChild(element);

    element.data = {
      registryId: "the_taskboard",
      registryName: "Taskboard",
      actor: "guest_1",
      actorNames: { guest_1: "Guest 1" },
      tasks: [
        { id: "obj_t_a", name: "Triage cockatoo bug",     kind: "bug",  labels: ["urgent", "frontend"], location: "the_taskboard", cursorRole: "doer", cursorKey: "k", cursorCriterion: "c", waitForCount: 0, terminal: false, complete: false, linkCount: 0, ageMs: 0, lastChange: 0, actions: [] },
        { id: "obj_t_b", name: "Update copy on landing",  kind: "task", labels: ["frontend"],           location: "the_taskboard", cursorRole: "doer", cursorKey: "k", cursorCriterion: "c", waitForCount: 0, terminal: false, complete: false, linkCount: 0, ageMs: 0, lastChange: 0, actions: [] },
        { id: "obj_t_c", name: "Backend cron lag",        kind: "bug",  labels: ["backend", "urgent"],  location: "the_taskboard", cursorRole: "doer", cursorKey: "k", cursorCriterion: "c", waitForCount: 0, terminal: false, complete: false, linkCount: 0, ageMs: 0, lastChange: 0, actions: [] }
      ]
    };

    const cardIds = () => Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-card]")).map((c) => c.dataset.tasksCard);
    expect(cardIds().sort()).toEqual(["obj_t_a", "obj_t_b", "obj_t_c"]);

    // free-text search on name
    const search = element.querySelector<HTMLInputElement>("[data-tasks-filter-text]")!;
    search.value = "cockatoo";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(cardIds()).toEqual(["obj_t_a"]);

    // search also matches kind / labels
    const search2 = element.querySelector<HTMLInputElement>("[data-tasks-filter-text]")!;
    search2.value = "backend";
    search2.dispatchEvent(new Event("input", { bubbles: true }));
    expect(cardIds()).toEqual(["obj_t_c"]);

    // clear search; click a label chip on a card
    const search3 = element.querySelector<HTMLInputElement>("[data-tasks-filter-text]")!;
    search3.value = "";
    search3.dispatchEvent(new Event("input", { bubbles: true }));
    expect(cardIds().sort()).toEqual(["obj_t_a", "obj_t_b", "obj_t_c"]);

    const urgentLabel = element.querySelector<HTMLButtonElement>('[data-tasks-filter-add-label="urgent"]');
    expect(urgentLabel).toBeTruthy();
    urgentLabel!.click();
    expect(cardIds().sort()).toEqual(["obj_t_a", "obj_t_c"]);

    // active chip is rendered with × button
    const chip = element.querySelector<HTMLElement>('[data-tasks-filter-remove-label="urgent"]');
    expect(chip).toBeTruthy();

    // adding a second label narrows further (AND semantics)
    const frontendLabel = element.querySelector<HTMLButtonElement>('[data-tasks-card="obj_t_a"] [data-tasks-filter-add-label="frontend"]');
    expect(frontendLabel).toBeTruthy();
    frontendLabel!.click();
    expect(cardIds()).toEqual(["obj_t_a"]);

    // remove a chip
    element.querySelector<HTMLButtonElement>('[data-tasks-filter-remove-label="frontend"]')!.click();
    expect(cardIds().sort()).toEqual(["obj_t_a", "obj_t_c"]);

    // the active label on the visible card is disabled (already in filter)
    const stillActive = element.querySelector<HTMLButtonElement>('[data-tasks-card="obj_t_a"] [data-tasks-filter-add-label="urgent"]');
    expect(stillActive?.disabled).toBe(true);

    // clear all filters
    element.querySelector<HTMLButtonElement>("[data-tasks-filter-clear]")!.click();
    expect(cardIds().sort()).toEqual(["obj_t_a", "obj_t_b", "obj_t_c"]);
    expect(element.querySelector<HTMLButtonElement>("[data-tasks-filter-clear]")).toBe(null);
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
