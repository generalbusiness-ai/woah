// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import chatManifest from "../catalogs/chat/manifest.json";
import dubspaceManifest from "../catalogs/dubspace/manifest.json";
import pinboardManifest from "../catalogs/pinboard/manifest.json";
import taskspaceManifest from "../catalogs/taskspace/manifest.json";
import weatherManifest from "../catalogs/weather/manifest.json";
import { CatalogUiRegistry, type WooContext } from "../src/client/framework";

function defineOnce(tag: string, ctor: CustomElementConstructor): void {
  if (!customElements.get(tag)) customElements.define(tag, ctor);
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
    expect(registry.installCatalogUi({ alias: "taskspace", catalog: "taskspace", objects: { "$taskspace": "$taskspace" }, ui: (taskspaceManifest as any).ui })).toEqual([]);
    expect(registry.installCatalogUi({ alias: "weather", catalog: "weather", objects: { "$weather_block": "$weather_block" }, ui: (weatherManifest as any).ui })).toEqual([]);

    expect(registry.resolveFrame("the_dubspace", undefined, (_subject, classRef) => classRef === "$dubspace" ? 1 : false)?.frame.id).toBe("dubspace.workspace");
    expect(registry.resolveFrame("the_pinboard", undefined, (_subject, classRef) => classRef === "$pinboard" ? 1 : false)?.frame.id).toBe("pinboard.board");
    expect(registry.resolveFrame("the_taskspace", undefined, (_subject, classRef) => classRef === "$taskspace" ? 1 : false)?.frame.id).toBe("taskspace.workspace");
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

  it("renders taskspace tasks and emits create events", async () => {
    const { WooTaskspaceWorkspaceElement } = await import("../catalogs/taskspace/ui/taskspace-workspace");
    defineOnce("woo-taskspace-workspace", WooTaskspaceWorkspaceElement);
    const element = document.createElement("woo-taskspace-workspace") as HTMLElement & { woo?: WooContext; data?: any };
    element.woo = testWooContext({ guest_1: "Guest 1" });
    document.body.appendChild(element);

    element.data = {
      space: "the_taskspace",
      tasks: {
        task_1: { id: "task_1", name: "Plan", props: { status: "open", assignee: "guest_1", requirements: [] } }
      },
      rootTasks: ["task_1"],
      selectedTask: "task_1",
      expanded: {},
      statusFilter: { open: true, claimed: true, in_progress: true, blocked: true, done: false }
    };

    expect(element.textContent).toContain("Plan");
    let detail: any;
    element.addEventListener("woo-taskspace-create", (event: Event) => { detail = (event as CustomEvent).detail; });
    element.querySelector<HTMLInputElement>("[data-new-title]")!.value = "New root";
    element.querySelector<HTMLButtonElement>("[data-create-task]")!.click();
    expect(detail).toMatchObject({ name: "New root" });
  });
});
