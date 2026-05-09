// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  it("keeps the chat-shell-enabled layouts vertically consistent across tools", () => {
    const css = readFileSync(resolve(process.cwd(), "src/client/styles.css"), "utf8");
    const pinboardMatch = css.match(/\.pinboard-layout\.has-space-chat\s*\{([\s\S]*?)\}/);
    const dubspaceMatch = css.match(/\.dubspace-layout\.has-space-chat\s*\{([\s\S]*?)\}/);
    const tasksMatch = css.match(/\.woo-tasks-workspace\.has-space-chat\s*\{([\s\S]*?)\}/);

    expect(pinboardMatch, "pinboard has-space-chat rule present").not.toBeNull();
    expect(dubspaceMatch, "dubspace has-space-chat rule present").not.toBeNull();
    expect(tasksMatch, "tasks has-space-chat rule present").not.toBeNull();

    const pinboardBlock = pinboardMatch?.[1] ?? "";
    const dubspaceBlock = dubspaceMatch?.[1] ?? "";
    const tasksBlock = tasksMatch?.[1] ?? "";

    expect(pinboardBlock).toMatch(/height:\s*100%/);
    expect(dubspaceBlock).toMatch(/height:\s*100%/);
    expect(tasksBlock).toMatch(/height:\s*100%/);

    const pinboardPanelMatch = pinboardBlock.match(/height:\s*([^;]+);/);
    const dubspacePanelMatch = dubspaceBlock.match(/height:\s*([^;]+);/);
    const tasksPanelMatch = tasksBlock.match(/height:\s*([^;]+);/);
    expect(pinboardPanelMatch?.[1]).toBe("100%");
    expect(dubspacePanelMatch?.[1]).toBe("100%");
    expect(tasksPanelMatch?.[1]).toBe("100%");
  });

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
    // The badge launches the chart overlay, so its required projection
    // fields must include everything the chart consumes — otherwise the
    // chart opens with stale/empty data on a normal room load.
    expect(weatherBadge?.declaration.requires).toEqual(expect.arrayContaining([
      "current", "daily", "timeseries", "config_state", "place", "timezone", "last_error"
    ]));
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
        // v0.2 current shape: flat scalars, no `kind` envelope.
        current: { temperature: 72.4, temperature_unit: "°F", humidity: 60, weather_code: 1000 }
      }
    };

    expect(element.querySelector(".weather-badge-temp")?.textContent).toBe("72°F");
    expect(element.querySelector(".weather-badge-condition")?.textContent).toBe("sunny");
    // The badge is keyboard-activatable so the chart isn't gated on a mouse.
    expect(element.querySelector(".weather-badge")?.getAttribute("role")).toBe("button");
    expect(element.querySelector(".weather-badge")?.getAttribute("tabindex")).toBe("0");
  });

  it("opens the chart dialog on badge click and closes on backdrop click", async () => {
    const { WooWeatherBadgeElement } = await import("../catalogs/weather/ui/weather-badge");
    const { WooWeatherChartElement } = await import("../catalogs/weather/ui/weather-chart");
    defineOnce("woo-weather-badge", WooWeatherBadgeElement);
    defineOnce("woo-weather-chart", WooWeatherChartElement);
    const badge = document.createElement("woo-weather-badge") as HTMLElement & { data?: any };
    document.body.appendChild(badge);
    badge.data = {
      id: "the_weather",
      name: "Weather panel",
      props: {
        place: "Brooklyn, NY",
        timezone: "America/New_York",
        config_state: { status: "confirmed" },
        current: { temperature: 64, temperature_unit: "°F", weather_code: 1000, observed_at_text: "May 9, 2026, 11:00 AM EDT" },
        daily: [
          { date: "2026-05-09", temperature: { min: 55, max: 71, mean: 64, unit: "°F" }, humidity: { mean: 70 }, precip_total: 0, precip_unit: "in", weather_code: 1000 },
          { date: "2026-05-10", temperature: { min: 56, max: 72, mean: 65, unit: "°F" }, humidity: { mean: 68 }, precip_total: 0.05, precip_unit: "in", weather_code: 1100 }
        ],
        timeseries: {
          anchor: Date.parse("2026-05-09T16:00:00Z"),
          t0: Date.parse("2026-05-09T16:00:00Z") - 168 * 3_600_000,
          step: 3_600_000,
          units: "imperial",
          fields: {
            temperature:          { unit: "°F", agg: "mean", values: Array.from({ length: 336 }, (_, i) => (i >= 100 && i < 200) ? 60 + Math.sin(i / 6) * 10 : null) },
            temperature_apparent: { unit: "°F", agg: "mean", values: Array.from({ length: 336 }, (_, i) => (i >= 100 && i < 200) ? 58 + Math.sin(i / 6) * 10 : null) },
            dew_point:            { unit: "°F", agg: "mean", values: Array.from({ length: 336 }, (_, i) => (i >= 100 && i < 200) ? 50 : null) },
            humidity:             { unit: "%",  agg: "mean", values: Array.from({ length: 336 }, (_, i) => (i >= 100 && i < 200) ? 70 : null) },
            cloud_cover:          { unit: "%",  agg: "mean", values: Array.from({ length: 336 }, (_, i) => (i >= 100 && i < 200) ? 40 : null) },
            precip_prob:          { unit: "%",  agg: "max",  values: Array.from({ length: 336 }, (_, i) => (i >= 100 && i < 200) ? 10 : null) },
            precip_intensity:     { unit: "in/hr", agg: "max", values: Array.from({ length: 336 }, (_, i) => (i >= 100 && i < 200) ? 0.01 : null) },
            wind_speed:           { unit: "mph", agg: "max", values: Array.from({ length: 336 }, (_, i) => (i >= 100 && i < 200) ? 5 : null) },
            weather_code:         { unit: "",   agg: "mode", values: Array.from({ length: 336 }, (_, i) => (i >= 100 && i < 200) ? 1000 : null) }
          }
        }
      }
    };

    badge.querySelector<HTMLElement>(".weather-badge")?.click();
    const dialog = document.querySelector<HTMLDialogElement>(".weather-chart-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog!.open).toBe(true);
    // Three panels rendered.
    expect(dialog!.querySelector(".weather-chart-daily-strip")).not.toBeNull();
    expect(dialog!.querySelectorAll(".weather-chart-panel").length).toBeGreaterThanOrEqual(2);
    // Symmetric daily slice (max half-width): anchor=2026-05-09, daily
    // has [2026-05-09, 2026-05-10] → past=0, fwd=1, n=1 → 3 cards
    // (placeholder/today/tomorrow).
    expect(dialog!.querySelectorAll(".weather-chart-day").length).toBe(3);
    expect(dialog!.querySelectorAll(".weather-chart-day.is-empty").length).toBe(1);
    expect(dialog!.querySelector(".weather-chart-day.is-today")).not.toBeNull();
    // Headline shows place and current.
    expect(dialog!.querySelector(".weather-chart-headline-place")?.textContent).toBe("Brooklyn, NY");
    expect(dialog!.querySelector(".weather-chart-headline-temp")?.textContent).toContain("°F");
    // Now-line and at least one temperature path are present.
    expect(dialog!.querySelector(".weather-chart-now")).not.toBeNull();
    expect(dialog!.querySelector(".weather-line-temp")).not.toBeNull();
    expect(dialog!.querySelector(".weather-area-precip")).not.toBeNull();
    // The day-boundary gridlines must be visibly distinct from the now-line.
    const dayGrids = dialog!.querySelectorAll(".weather-chart-day-grid");
    expect(dayGrids.length).toBeGreaterThan(0);

    // Close button closes.
    dialog!.querySelector<HTMLButtonElement>("[data-weather-close]")?.click();
    expect(dialog!.open).toBe(false);
  });

  it("badge activates the chart on Enter and Space (not just click)", async () => {
    const { WooWeatherBadgeElement } = await import("../catalogs/weather/ui/weather-badge");
    const { WooWeatherChartElement } = await import("../catalogs/weather/ui/weather-chart");
    defineOnce("woo-weather-badge", WooWeatherBadgeElement);
    defineOnce("woo-weather-chart", WooWeatherChartElement);
    const badge = document.createElement("woo-weather-badge") as HTMLElement & { data?: any; chart?: HTMLElement };
    document.body.appendChild(badge);
    badge.data = {
      id: "the_weather",
      props: {
        place: "X",
        config_state: { status: "confirmed" },
        current: { temperature: 60, temperature_unit: "°F", weather_code: 1000 },
        timeseries: { anchor: Date.parse("2026-05-09T12:00:00Z"), t0: Date.parse("2026-05-09T12:00:00Z") - 168 * 3_600_000, step: 3_600_000, units: "imperial", fields: {} },
        daily: []
      }
    };
    // Earlier tests in this file leave their dialog elements in the
    // shared jsdom document; scope this assertion to the chart created
    // by THIS badge so we don't read stale state.
    const ownDialog = () => (badge as any).chart?.querySelector(".weather-chart-dialog") as HTMLDialogElement | null;

    // Enter on the focused badge opens the chart.
    badge.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(ownDialog()?.open).toBe(true);
    ownDialog()!.removeAttribute("open");

    // Space also activates.
    badge.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(ownDialog()?.open).toBe(true);
    ownDialog()!.removeAttribute("open");

    // Other keys do nothing.
    badge.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    expect(ownDialog()?.open).toBe(false);
  });

  it("symmetric daily slice yields today ± max(past, fwd) with placeholders for missing dates", async () => {
    const { symmetricDailySlice } = await import("../catalogs/weather/ui/weather-chart");
    const e = (date: string): any => ({ date, temperature: { unit: "°F" }, humidity: {}, precip_total: 0, precip_unit: "in", weather_code: 1000 });
    // 1 day back, 5 days forward (cold-start case): n = max(1, 5) = 5,
    // window today ± 5 = 11 cards. The 4 missing past dates are placeholders.
    const slice = symmetricDailySlice([e("2026-05-08"), e("2026-05-09"), e("2026-05-10"), e("2026-05-11"), e("2026-05-12"), e("2026-05-13"), e("2026-05-14")], "2026-05-09");
    expect(slice.map((x: any) => x.date)).toEqual([
      "2026-05-04","2026-05-05","2026-05-06","2026-05-07","2026-05-08",
      "2026-05-09","2026-05-10","2026-05-11","2026-05-12","2026-05-13","2026-05-14"
    ]);
    expect(slice.slice(0, 4).every((x: any) => x.placeholder === true)).toBe(true);
    expect(slice.slice(4).every((x: any) => x.placeholder === undefined)).toBe(true);
    // After a week of plug ticks: 7 back, 5 forward → max=7, window today ± 7 = 15 cards.
    const wide = ["2026-05-02","2026-05-03","2026-05-04","2026-05-05","2026-05-06","2026-05-07","2026-05-08","2026-05-09","2026-05-10","2026-05-11","2026-05-12","2026-05-13","2026-05-14"].map(e);
    const wideSlice = symmetricDailySlice(wide, "2026-05-09");
    expect(wideSlice.length).toBe(15);
    expect(wideSlice[0].date).toBe("2026-05-02");
    expect(wideSlice[wideSlice.length - 1].date).toBe("2026-05-16");
    // 2 trailing placeholders for dates beyond the daily array's end.
    expect(wideSlice.filter((x: any) => x.placeholder).map((x: any) => x.date)).toEqual(["2026-05-15", "2026-05-16"]);
    // Today not in the daily array → return the array unchanged.
    expect(symmetricDailySlice(wide, "1999-01-01")).toEqual(wide);
  });

  it("symmetric timeseries domain extends to max(past, forward) populated half-width", async () => {
    const { symmetricTimeseriesDomain } = await import("../catalogs/weather/ui/weather-chart");
    const HOUR = 3_600_000;
    const anchor = 1000 * HOUR;
    const t0 = anchor - 168 * HOUR;
    const fields = {
      temperature: {
        unit: "°F",
        agg: "mean",
        // Populated slots: anchorIdx=168. Fill 144..184 (24h back, 16h fwd).
        // Past=24, fwd=16 → max=24 (the wider side wins).
        values: Array.from({ length: 336 }, (_, i) => (i >= 144 && i <= 184) ? 70 : null)
      }
    };
    const ts = { anchor, t0, step: HOUR, units: "imperial", fields } as any;
    const [d0, d1] = symmetricTimeseriesDomain(ts);
    expect(d0).toBe(anchor - 24 * HOUR);
    expect(d1).toBe(anchor + 24 * HOUR);
  });

  it("opens via the weather_open observation routed by the catalog UI module", async () => {
    const { WooWeatherBadgeElement, registerWooObservationHandlers } = await import("../catalogs/weather/ui/weather-badge");
    const { WooWeatherChartElement } = await import("../catalogs/weather/ui/weather-chart");
    const { ObservationRegistry, ClientProjection } = await import("../src/client/framework");
    defineOnce("woo-weather-badge", WooWeatherBadgeElement);
    defineOnce("woo-weather-chart", WooWeatherChartElement);

    const badge = document.createElement("woo-weather-badge") as HTMLElement & { data?: any };
    document.body.appendChild(badge);
    badge.data = {
      id: "the_weather",
      props: {
        place: "Mountain View CA",
        config_state: { status: "confirmed" },
        current: { temperature: 72, temperature_unit: "°F", weather_code: 1000 },
        timeseries: { anchor: 1715260800000, t0: 1714656000000, step: 3_600_000, units: "imperial", fields: {} },
        daily: []
      }
    };

    // Wire up the registry exactly like the framework does at module load.
    const projection = new ClientProjection();
    const registry = new ObservationRegistry(projection);
    registerWooObservationHandlers(registry);

    // Deliver a weather_open observation. The handler should dispatch
    // a window event; the badge owns this block id and opens its chart.
    registry.deliver(
      { type: "weather_open", to: "guest_1", block: "the_weather" },
      { route: "live", actor: "guest_1" } as any
    );

    const dialog = document.querySelector<HTMLDialogElement>(".weather-chart-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog!.open).toBe(true);
    // jsdom's HTMLDialogElement lacks .close(); the chart's own close()
    // path falls back to removing the `open` attr, which the badge could
    // also drive externally — for the test we don't actually need to
    // close, just verify the open dispatch reached the badge.
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
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    // Toggle open the admin panel.
    element.querySelector<HTMLButtonElement>("[data-tasks-admin-toggle]")!.click();
    const panel = element.querySelector(".woo-tasks-admin-main");
    expect(panel).not.toBeNull();
    expect(element.querySelector<HTMLButtonElement>("[data-tasks-create-open]")).toBeNull();
    expect(element.querySelector<HTMLButtonElement>(".woo-tasks-admin-head [data-tasks-admin-toggle]")).not.toBeNull();
    expect(element.querySelector("[data-tasks-filter-text]")).toBeNull();
    expect(element.querySelector("[data-tasks-col]")).toBeNull();
    expect(element.querySelector(".woo-tasks-admin-table")).not.toBeNull();
    expect(element.querySelector("[data-tasks-admin-form='role']")).toBeNull();

    // Add a role.
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-new="role"]')!.click();
    const roleForm = element.querySelector("[data-tasks-admin-form='role']") as HTMLFormElement;
    roleForm.querySelector<HTMLInputElement>('input[name="name"]')!.value = "reviewer";
    roleForm.querySelector<HTMLInputElement>('input[name="description"]')!.value = "Reviews work";
    roleForm.querySelector<HTMLInputElement>('input[name="owners"]')!.value = "guest_a, guest_b";
    roleForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const setRole = calls.find((c) => c.verb === "set_role");
    expect(setRole?.args).toEqual(["reviewer", { description: "Reviews work", owners: ["guest_a", "guest_b"] }]);
    expect(element.textContent).toContain('Saved role "reviewer".');

    // Add an obligation.
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-tab="obligation"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-new="obligation"]')!.click();
    const obForm = element.querySelector("[data-tasks-admin-form='obligation']") as HTMLFormElement;
    obForm.querySelector<HTMLInputElement>('input[name="key"]')!.value = "review:approve";
    obForm.querySelector<HTMLSelectElement>('select[name="role"]')!.value = "doer";
    obForm.querySelector<HTMLInputElement>('input[name="criterion"]')!.value = "Reviewer approves.";
    obForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const setOb = calls.find((c) => c.verb === "set_obligation");
    expect(setOb?.args).toEqual(["review:approve", { role: "doer", criterion: "Reviewer approves." }]);
    expect(element.textContent).toContain('Saved obligation "review:approve".');

    // Add a policy.
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-tab="policy"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-new="policy"]')!.click();
    const polForm = element.querySelector("[data-tasks-admin-form='policy']") as HTMLFormElement;
    polForm.querySelector<HTMLInputElement>('input[name="kind"]')!.value = "review";
    polForm.querySelector<HTMLInputElement>('input[name="keys"]')!.value = "do:it, review:approve";
    polForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const setPol = calls.find((c) => c.verb === "set_policy");
    expect(setPol?.args).toEqual(["review", ["do:it", "review:approve"]]);
    expect(element.textContent).toContain('Saved policy "review".');

    // Remove buttons confirm first, then fire the matching remove_* verbs with the targeted key.
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-tab="role"]')!.click();
    element.querySelector<HTMLElement>('tr[data-tasks-admin-section="role"][data-key="doer"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-edit="role"][data-key="doer"]')!.click();
    expect(element.querySelector<HTMLButtonElement>('[data-tasks-admin-remove="role"][data-key="doer"]')).not.toBeNull();
    confirmSpy.mockReturnValueOnce(false);
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-remove="role"][data-key="doer"]')!.click();
    expect(confirmSpy).toHaveBeenCalledWith('Remove role "doer"?');
    expect(calls.find((c) => c.verb === "remove_role")).toBeUndefined();

    confirmSpy.mockReturnValue(true);
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-remove="role"][data-key="doer"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-tab="obligation"]')!.click();
    element.querySelector<HTMLElement>('tr[data-tasks-admin-section="obligation"][data-key="do:it"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-edit="obligation"][data-key="do:it"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-remove="obligation"][data-key="do:it"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-tab="policy"]')!.click();
    element.querySelector<HTMLElement>('tr[data-tasks-admin-section="policy"][data-key="task"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-edit="policy"][data-key="task"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-remove="policy"][data-key="task"]')!.click();
    await flush();
    expect(calls.find((c) => c.verb === "remove_role")?.args).toEqual(["doer"]);
    expect(calls.find((c) => c.verb === "remove_obligation")?.args).toEqual(["do:it"]);
    expect(calls.find((c) => c.verb === "remove_policy")?.args).toEqual(["task"]);
    expect(element.textContent).toContain('Removed policy "task".');
    expect(confirmSpy).toHaveBeenCalledWith('Remove obligation "do:it"?');
    expect(confirmSpy).toHaveBeenCalledWith('Remove policy "task"?');
    confirmSpy.mockRestore();
  });

  it("admin overlay reports failed add/update calls", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    const woo: WooContext = {
      actor: "$wiz",
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: "Taskboard", owner: "$wiz", props: {}, catalogState: {} }),
      directCall: async (_target, verb) => {
        if (verb === "set_role") throw new Error("not allowed");
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
      roles: [],
      obligations: [],
      policiesMap: {}
    };

    element.querySelector<HTMLButtonElement>("[data-tasks-admin-toggle]")!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-new="role"]')!.click();
    const roleForm = element.querySelector("[data-tasks-admin-form='role']") as HTMLFormElement;
    roleForm.querySelector<HTMLInputElement>('input[name="name"]')!.value = "reviewer";
    roleForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    const status = element.querySelector(".woo-tasks-admin-status.error");
    expect(status?.textContent).toContain('Could not save role "reviewer": not allowed');
  });

  it("preserves create and admin drafts across task refresh renders", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    element.woo = testWooContext({ guest_1: "Guest 1" });
    element.subject = "the_taskboard";
    element.setAttribute("refresh-interval-ms", "0");
    document.body.appendChild(element);
    const data = {
      registryId: "the_taskboard",
      registryName: "Taskboard",
      actor: "guest_1",
      actorNames: { guest_1: "Guest 1" },
      tasks: [],
      policies: ["task", "bug"],
      isOwner: true,
      roles: [{ name: "doer", description: "Does", owners: ["guest_1"] }],
      obligations: [{ key: "do:it", role: "doer", criterion: "Done." }],
      policiesMap: { task: ["do:it"] }
    };
    element.data = data;

    element.querySelector<HTMLButtonElement>("[data-tasks-create-open]")!.click();
    const create = element.querySelector<HTMLFormElement>("[data-tasks-detail-form]")!;
    create.querySelector<HTMLSelectElement>('select[name="kind"]')!.value = "bug";
    create.querySelector<HTMLSelectElement>('select[name="kind"]')!.dispatchEvent(new Event("change", { bubbles: true }));
    create.querySelector<HTMLInputElement>('input[name="name"]')!.value = "Half typed task";
    create.querySelector<HTMLInputElement>('input[name="name"]')!.dispatchEvent(new Event("input", { bubbles: true }));
    create.querySelector<HTMLTextAreaElement>('textarea[name="text"]')!.value = "draft body";
    create.querySelector<HTMLTextAreaElement>('textarea[name="text"]')!.dispatchEvent(new Event("input", { bubbles: true }));
    create.querySelector<HTMLInputElement>('input[name="labels"]')!.value = "frontend, urgent";
    create.querySelector<HTMLInputElement>('input[name="labels"]')!.dispatchEvent(new Event("input", { bubbles: true }));

    // Polling refresh shouldn't blow away the half-typed new-task draft.
    element.data = data;

    const survivor = element.querySelector<HTMLFormElement>("[data-tasks-detail-form]")!;
    expect(survivor.querySelector<HTMLSelectElement>('select[name="kind"]')!.value).toBe("bug");
    expect(survivor.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe("Half typed task");
    expect(survivor.querySelector<HTMLTextAreaElement>('textarea[name="text"]')!.value).toBe("draft body");
    expect(survivor.querySelector<HTMLInputElement>('input[name="labels"]')!.value).toBe("frontend, urgent");

    // Admin draft survives the same way.
    element.querySelector<HTMLButtonElement>("[data-tasks-admin-toggle]")!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-new="role"]')!.click();
    const roleForm = element.querySelector<HTMLFormElement>("[data-tasks-admin-form='role']")!;
    roleForm.querySelector<HTMLInputElement>('input[name="name"]')!.value = "reviewer";
    roleForm.querySelector<HTMLInputElement>('input[name="name"]')!.dispatchEvent(new Event("input", { bubbles: true }));
    element.data = data;
    expect(element.querySelector<HTMLInputElement>("[data-tasks-admin-form='role'] input[name='name']")!.value).toBe("reviewer");
  });

  it("defers refresh repaint while a tasks input is focused", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; refresh?: () => Promise<void>; data?: any };
    const baseData = {
      registryId: "the_taskboard",
      registryName: "Taskboard",
      actor: "guest_1",
      actorNames: { guest_1: "Guest 1" },
      tasks: [],
      policies: ["task", "bug"],
      isOwner: true,
      roles: [],
      obligations: [],
      policiesMap: {}
    };
    const listing = [
      { task: "obj_t_new", name: "Server side update", kind: "task", labels: [], location: "the_taskboard", cursor_role: null, wait_for_count: 0, terminal: false, complete: false, link_count: 0, age_ms: 0, last_change: 0 }
    ];
    const woo: WooContext = {
      actor: "guest_1",
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_taskboard" ? "Taskboard refreshed" : ref, props: { policies: { task: [] } }, catalogState: {} }),
      directCall: async (_target, verb) => {
        if (verb === "listing") return listing;
        if (verb === "available_actions") return [];
        return undefined;
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    };
    element.woo = woo;
    element.subject = "the_taskboard";
    element.setAttribute("refresh-interval-ms", "0");
    document.body.appendChild(element);
    element.data = baseData;

    element.querySelector<HTMLButtonElement>("[data-tasks-create-open]")!.click();
    const nameInput = element.querySelector<HTMLInputElement>("[data-tasks-detail-form] input[name='name']")!;
    nameInput.focus();
    nameInput.value = "typing is still here";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    await element.refresh!();

    expect(document.activeElement).toBe(nameInput);
    expect(element.querySelector<HTMLInputElement>("[data-tasks-detail-form] input[name='name']")).toBe(nameInput);
    expect(nameInput.value).toBe("typing is still here");
    expect(element.querySelector("h2")?.textContent).toBe("Taskboard");

    nameInput.blur();
    await Promise.resolve();
    expect(element.querySelector("h2")?.textContent).toBe("Taskboard refreshed");
    expect(element.querySelector<HTMLInputElement>("[data-tasks-detail-form] input[name='name']")?.value).toBe("typing is still here");
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

    // Single Edit toggle puts the whole detail panel into edit mode; one Save
    // dispatches all changed fields at once.
    element.querySelector<HTMLButtonElement>("[data-tasks-detail-edit-toggle]")!.click();
    const form = element.querySelector<HTMLFormElement>("[data-tasks-detail-form]")!;
    form.querySelector<HTMLInputElement>('input[name="name"]')!.value = "Renamed";
    form.querySelector<HTMLTextAreaElement>('textarea[name="text"]')!.value = "new body content";
    form.querySelector<HTMLInputElement>('input[name="labels"]')!.value = "beta, gamma";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    expect(calls.find((c) => c.verb === "set_name")?.args).toEqual(["Renamed"]);
    expect(calls.find((c) => c.verb === "set_text")?.args).toEqual(["new body content"]);
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
    const form = element.querySelector<HTMLFormElement>("[data-tasks-detail-form]");
    expect(form).not.toBeNull();
    // Unified panel: filter bar and kanban columns stay visible alongside.
    const detail = element.querySelector<HTMLElement>("[data-tasks-detail]");
    expect(detail?.dataset.taskMode).toBe("new");
    // Obligations / log are hidden for the not-yet-minted draft.
    expect(form!.querySelector(".woo-tasks-detail-obligations")).toBeNull();
    expect(form!.querySelector(".woo-tasks-detail-log")).toBeNull();
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

  it("offers no in-UI bootstrap when no policies — wizards run :seed_minimal_policy from chat", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    element.woo = testWooContext({});
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

    // No policies -> no "+ New task" entry-point and no in-UI seed button.
    // The wizard reaches :seed_minimal_policy through chat (e.g. via
    // `;the_taskboard:seed_minimal_policy($wiz)`) instead.
    expect(element.querySelector("[data-tasks-create-open]")).toBeNull();
    expect(element.querySelector("[data-tasks-seed-policy]")).toBeNull();
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
    expect(element.querySelector('[data-space-chat-shell="the_taskboard"]')).not.toBeNull();
    expect(element.querySelector("[data-tool-space-chat]")).not.toBeNull();
    const colCounts = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col]")).map((col) => ({
      id: col.dataset.tasksCol,
      count: col.querySelector<HTMLElement>("[data-tasks-col-count]")?.textContent
    }));
    expect(colCounts).toEqual([
      { id: "ready", count: "1" },
      { id: "waiting", count: "1" },
      { id: "in_flight", count: "1" }
    ]);
    expect(element.querySelector('[data-tasks-col="done"]')).toBeNull();
    expect(element.querySelector('[data-tasks-col="dropped"]')).toBeNull();

    element.querySelector<HTMLButtonElement>('[data-tasks-status-filter="done"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-status-filter="dropped"]')!.click();
    const allColCounts = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col]")).map((col) => ({
      id: col.dataset.tasksCol,
      count: col.querySelector<HTMLElement>("[data-tasks-col-count]")?.textContent
    }));
    expect(allColCounts).toEqual([
      { id: "ready", count: "1" },
      { id: "waiting", count: "1" },
      { id: "in_flight", count: "1" },
      { id: "done", count: "1" },
      { id: "dropped", count: "1" }
    ]);

    element.querySelector<HTMLButtonElement>('[data-tasks-status-filter="ready"]')!.click();
    const toggledCols = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col]")).map((c) => c.dataset.tasksCol);
    expect(toggledCols).toEqual(["waiting", "in_flight", "done", "dropped"]);

    element.querySelector<HTMLButtonElement>('[data-tasks-status-filter="ready"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-status-filter="done"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-status-filter="dropped"]')!.click();

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

    // default: state grouping; active columns only
    let cols = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col]")).map((c) => c.dataset.tasksCol);
    expect(cols).toEqual(["ready", "waiting", "in_flight"]);

    expect(element.querySelector<HTMLSelectElement>("[data-tasks-group-by]")?.value).toBe("state");

    // status controls toggle visible state columns in state grouping
    element.querySelector<HTMLButtonElement>('[data-tasks-status-filter="ready"]')!.click();
    cols = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col]")).map((c) => c.dataset.tasksCol);
    expect(cols).toEqual(["waiting", "in_flight"]);

    // group by role: filtered to the selected states (waiting + in-flight)
    setGroup("role");
    cols = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col]")).map((c) => c.dataset.tasksCol);
    expect(cols).toEqual(["doer"]);
    const doerCol = element.querySelector<HTMLElement>("[data-tasks-col=\"doer\"]")!;
    expect(doerCol.querySelectorAll("[data-tasks-card]").length).toBe(1);

    // group by holder: state toggle remains a task filter
    setGroup("holder");
    cols = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col]")).map((c) => c.dataset.tasksCol);
    expect(cols).toEqual(["guest_2"]);
    const guest2Col = element.querySelector<HTMLElement>("[data-tasks-col=\"guest_2\"]")!;
    expect(guest2Col.querySelector(".woo-tasks-kanban-col-name")?.textContent).toBe("Guest 2");

    // group by kind
    setGroup("kind");
    cols = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col]")).map((c) => c.dataset.tasksCol);
    expect(cols).toEqual(["bug"]);

    element.querySelector<HTMLButtonElement>('[data-tasks-status-filter="ready"]')!.click();
    expect(element.querySelector<HTMLSelectElement>("[data-tasks-group-by]")?.value).toBe("kind");
    cols = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col]")).map((c) => c.dataset.tasksCol);
    expect(cols).toEqual(["bug", "task"]);

    // when not in state mode, cards lose the draggable attribute even if their actions include claim
    setGroup("kind");
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

  it("preserves an existing task-space chat panel across rerenders", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    if (!customElements.get("woo-space-chat-panel")) {
      customElements.define("woo-space-chat-panel", class extends HTMLElement {});
    }
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; data?: any };
    document.body.appendChild(element);

    element.data = {
      registryId: "the_taskboard",
      registryName: "Taskboard",
      actor: "guest_1",
      actorNames: { guest_1: "Guest 1" },
      tasks: [],
      policies: [],
      isOwner: false,
      roles: [],
      obligations: [],
      policiesMap: {}
    };

    const slot = element.querySelector<HTMLElement>("[data-tool-space-chat]");
    const existingPanel = document.createElement("woo-space-chat-panel");
    existingPanel.setAttribute("data-space-chat-panel", "true");
    existingPanel.setAttribute("data-space-chat-space", "the_taskboard");
    slot?.append(existingPanel);
    expect(element.querySelector<HTMLElement>("[data-space-chat-panel]")).toBe(existingPanel);

    element.data = {
      registryId: "the_taskboard",
      registryName: "Taskboard",
      actor: "guest_1",
      actorNames: { guest_1: "Guest 1" },
      tasks: [{
        id: "obj_t_1",
        name: "Next",
        kind: "bug",
        labels: [],
        location: "the_taskboard",
        cursorRole: null,
        cursorKey: null,
        cursorCriterion: null,
        waitForCount: 0,
        terminal: false,
        complete: false,
        linkCount: 0,
        ageMs: 0,
        lastChange: 0,
        actions: []
      }],
      policies: [],
      isOwner: false,
      roles: [],
      obligations: [],
      policiesMap: {}
    };
    const rerenderedPanel = element.querySelector<HTMLElement>("[data-space-chat-panel]");
    expect(rerenderedPanel).toBe(existingPanel);
    expect(element.querySelector<HTMLElement>("[data-space-chat-panel]")).toBe(existingPanel);
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
