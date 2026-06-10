// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import chatManifest from "../catalogs/chat/manifest.json";
import dubspaceManifest from "../catalogs/dubspace/manifest.json";
import outlinerManifest from "../catalogs/outliner/manifest.json";
import pinboardManifest from "../catalogs/pinboard/manifest.json";
import tasksManifest from "../catalogs/tasks/manifest.json";
import weatherManifest from "../catalogs/weather/manifest.json";
import {
  CatalogUiRegistry,
  preserveAmbientCompanionPanel,
  renderAmbientCompanionShell,
  restoreAmbientCompanionPanel,
  type WooContext
} from "../src/client/framework";

function defineOnce(tag: string, ctor: CustomElementConstructor): void {
  if (!customElements.get(tag)) customElements.define(tag, ctor);
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

function appendAmbientCompanionPanel(root: ParentNode, space: string): HTMLElement {
  const slot = root.querySelector<HTMLElement>("[data-ambient-companion]");
  expect(slot, "ambient companion slot").not.toBeNull();
  const panel = document.createElement("aside");
  panel.dataset.spaceChatPanel = "";
  panel.dataset.spaceChatSpace = space;
  slot!.append(panel);
  return panel;
}

describe("bundled catalog UI components", () => {
  it("renders and preserves the shared ambient companion shell", () => {
    const host = document.createElement("section");
    host.innerHTML = renderAmbientCompanionShell(
      "the_tool",
      '<section class="tool-workspace has-ambient-companion" data-space-chat-layout="the_tool"></section>'
    );
    const slot = host.querySelector("[data-ambient-companion]");
    const panel = document.createElement("aside");
    panel.dataset.spaceChatPanel = "";
    panel.dataset.spaceChatSpace = "the_tool";
    slot?.append(panel);

    const preserved = preserveAmbientCompanionPanel(host, "the_tool");
    host.innerHTML = renderAmbientCompanionShell(
      "the_tool",
      '<section class="tool-workspace has-ambient-companion" data-space-chat-layout="the_tool"></section>'
    );

    expect(preserved).toBe(panel);
    expect(restoreAmbientCompanionPanel(host, preserved)).toBe(true);
    expect(host.querySelector("[data-ambient-companion]")?.firstElementChild).toBe(panel);
    expect(host.querySelector('[data-ambient-companion-shell="the_tool"]')).not.toBeNull();
  });

  it("keeps the ambient-companion-shell-enabled layouts vertically consistent across tools", () => {
    // Every tool routes its workspace through renderToolFrame (see
    // src/client/framework.ts), which puts `has-ambient-companion` on the
    // `.split.split--side-fixed` element. The shared
    // `.split.has-ambient-companion` rule (height: 100%; min-height: 0;
    // overflow: hidden) supplies the envelope for pinboard / dubspace /
    // tasks / outliner alike — the previous per-tool wrappers
    // (.woo-tasks-workspace, .outliner-workspace) were deleted on
    // 2026-05-18 when this rule became canonical.
    const css = readFileSync(resolve(process.cwd(), "src/client/styles.css"), "utf8");
    const splitMatch = css.match(/\.split\.has-ambient-companion\s*\{([\s\S]*?)\}/);
    expect(splitMatch, "split has-ambient-companion primitive present").not.toBeNull();

    const splitBlock = splitMatch?.[1] ?? "";
    expect(splitBlock).toMatch(/height:\s*100%/);
    expect(splitBlock).toMatch(/min-height:\s*0/);
    expect(splitBlock).toMatch(/overflow:\s*hidden/);

    // No tool may resurrect its own ambient-companion wrapper. If a future
    // tool needs a different envelope, change `.split.has-ambient-companion`
    // (or document the divergence in tool-ui.md) — don't re-introduce
    // per-tool drift.
    expect(css).not.toMatch(/\.woo-tasks-workspace\.has-ambient-companion/);
    expect(css).not.toMatch(/\.outliner-workspace\b/);
  });

  it("keeps first-party tool workspace frames on the shared minichat path", () => {
    const manifests = [dubspaceManifest, outlinerManifest, pinboardManifest, tasksManifest] as const;
    for (const manifest of manifests) {
      const frames = ((manifest as any).ui?.frames ?? []).filter((frame: any) => frame.layout === "space-workspace");
      expect(frames.length, `${(manifest as any).name} declares a space-workspace frame`).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame.regions?.main?.length, `${(manifest as any).name} ${frame.id} has main region`).toBeGreaterThan(0);
        expect(frame.regions?.chat, `${(manifest as any).name} ${frame.id} has chat region`).toEqual([
          { component: "chat:chat.space-mini", subject: "this" }
        ]);
      }
    }
  });

  it("does not run direct-call refreshes from dubspace or pinboard host rebinding", async () => {
    const { WooDubspaceWorkspaceElement } = await import("../catalogs/dubspace/ui/dubspace-workspace");
    const { WooPinboardBoardElement } = await import("../catalogs/pinboard/ui/pinboard-board");
    defineOnce("woo-dubspace-workspace", WooDubspaceWorkspaceElement);
    defineOnce("woo-pinboard-board", WooPinboardBoardElement);
    let directCalls = 0;
    const makeWoo = (subject: string): WooContext => ({
      actor: "guest_1",
      frame: { id: "test", subject, get: () => undefined, set: () => true },
      neighborhood: { subject, refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref, props: {}, catalogState: {} }),
      directCall: async () => {
        directCalls += 1;
        return [];
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    });

    const dubspace = document.createElement("woo-dubspace-workspace") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    dubspace.subject = "the_dubspace";
    dubspace.woo = makeWoo("the_dubspace");
    document.body.appendChild(dubspace);
    dubspace.data = {
      spaceId: "the_dubspace",
      spaceName: "Dubspace",
      spaceDescription: "",
      controls: {},
      slots: [],
      filter: "",
      delay: "",
      drum: "",
      present: [],
      actor: "guest_1",
      inSpace: false,
      canSend: true,
      audioOn: false,
      cueSlots: {},
      cuePlaying: {}
    };
    dubspace.subject = "the_dubspace";
    dubspace.woo = makeWoo("the_dubspace");
    dubspace.remove();
    document.body.appendChild(dubspace);

    const pinboard = document.createElement("woo-pinboard-board") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    pinboard.subject = "the_pinboard";
    pinboard.woo = makeWoo("the_pinboard");
    document.body.appendChild(pinboard);
    pinboard.data = {
      boardId: "the_pinboard",
      boardName: "Pinboard",
      notes: [],
      present: [],
      palette: ["yellow", "blue", "green", "pink", "white"],
      viewport: { w: 960, h: 560 },
      view: { x: 0, y: 0, scale: 1 },
      actor: "guest_1",
      inBoard: false,
      canSend: true,
      newText: "",
      newColor: "yellow",
      viewports: {}
    };
    pinboard.subject = "the_pinboard";
    pinboard.woo = makeWoo("the_pinboard");
    pinboard.remove();
    document.body.appendChild(pinboard);

    expect(directCalls).toBe(0);
  });

  it("declares and resolves first-party tool frames", () => {
    const registry = new CatalogUiRegistry();
    expect(registry.installCatalogUi({ alias: "chat", catalog: "chat", objects: { "$space": "$space", "$chatroom": "$chatroom" }, ui: (chatManifest as any).ui })).toEqual([]);
    expect(registry.installCatalogUi({ alias: "dubspace", catalog: "dubspace", objects: { "$dubspace": "$dubspace" }, ui: (dubspaceManifest as any).ui })).toEqual([]);
    expect(registry.installCatalogUi({ alias: "outliner", catalog: "outliner", objects: { "$outliner": "$outliner" }, ui: (outlinerManifest as any).ui })).toEqual([]);
    expect(registry.installCatalogUi({ alias: "pinboard", catalog: "pinboard", objects: { "$pinboard": "$pinboard" }, ui: (pinboardManifest as any).ui })).toEqual([]);
    expect(registry.installCatalogUi({ alias: "tasks", catalog: "tasks", objects: { "$task_registry": "$task_registry" }, ui: (tasksManifest as any).ui })).toEqual([]);
    expect(registry.installCatalogUi({ alias: "weather", catalog: "weather", objects: { "$weather_block": "$weather_block" }, ui: (weatherManifest as any).ui })).toEqual([]);

    expect(registry.resolveFrame("the_dubspace", undefined, (_subject, classRef) => classRef === "$dubspace" ? 1 : false)?.frame.id).toBe("dubspace.workspace");
    expect(registry.resolveFrame("the_outline", undefined, (_subject, classRef) => classRef === "$outliner" ? 1 : false)?.frame.id).toBe("outliner.tree");
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
        if (verb === "detail") return { id: target, name: "Triage cockatoo bug", text: "", kind: "bug", labels: ["urgent"], obligations: [], log: [], wait_for: [], links: [], location: "the_taskboard", complete: false, terminal: false, cursor: { key: "do:it" } };
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
    expect(element.querySelector("h1")?.textContent).toBe("Taskboard");
    // Cards no longer carry inline action buttons — clicking a card opens
    // the detail dialog where the actions live.
    expect(element.querySelector("[data-tasks-card] [data-tasks-action]")).toBeNull();
    element.querySelector<HTMLElement>("[data-tasks-card]")!.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const claimBtn = element.querySelector<HTMLButtonElement>("[data-tasks-detail-task-actions] [data-tasks-action=\"claim\"]");
    expect(claimBtn?.textContent).toBe("Claim");

    let detail: any;
    element.addEventListener("woo-tasks-action", (event: Event) => { detail = (event as CustomEvent).detail; });
    claimBtn!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(detail).toMatchObject({ taskId: "obj_t_ready", verb: "claim" });
    expect(calls.some((c) => c.target === "obj_t_ready" && c.verb === "claim")).toBe(true);
  });

  it("does not crash when host data is projection-shaped before tasks refresh", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { data?: any };
    document.body.appendChild(element);

    expect(() => {
      element.data = {
        id: "the_taskboard",
        name: "Taskboard",
        props: {
          policies: { task: ["do:it"] },
          roles: { doer: { description: "Does the work", owners: ["guest_1"] } },
          obligations: { "do:it": { role: "doer", criterion: "Done." } }
        },
        catalogState: {}
      };
    }).not.toThrow();

    expect(element.querySelector("h1")?.textContent).toBe("Taskboard");
    expect(element.querySelector("[data-tasks-card]")).toBeNull();
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
        if (verb === "listing") return [{ task: "obj_t_drop", name: "Drop me", kind: "bug", labels: [], location: "guest_1", cursor_role: { key: "do:it", role: "doer", criterion: "Done." }, wait_for_count: 0, terminal: false, complete: false, link_count: 0, age_ms: 1000, last_change: 0 }];
        if (verb === "available_actions") return [{ verb: "drop_terminal", label: "Drop", args: [{ name: "why", type: "str", required: true }] }];
        if (verb === "detail") return { id: target, name: "Drop me", text: "", kind: "bug", labels: [], obligations: [], log: [], wait_for: [], links: [], location: "guest_1", complete: false, terminal: false, cursor: { key: "do:it" } };
        return null;
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    element.woo = woo;
    element.subject = "the_taskboard";
    document.body.appendChild(element);

    // Wait for the initial observation-driven refresh to settle so the
    // model reflects the listing + available_actions mocks, then open
    // the dialog.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    element.querySelector<HTMLElement>("[data-tasks-card]")!.click();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const button = element.querySelector<HTMLButtonElement>("[data-tasks-detail-task-actions] [data-tasks-action=\"drop_terminal\"]")!;
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

  it("sources action tooltip help text from the catalog manifest, not duplicated in the UI", async () => {
    // Single source of truth: each user-facing action's outcome description
    // lives as a doc-comment in the catalog's verb source (so MCP picks it
    // up via extractFirstParagraph too), and the kanban dialog reads from
    // that same text. This guards against the UI drifting from MCP.
    const tasksManifest = (await import("../catalogs/tasks/manifest.json")).default as { classes?: Array<{ local_name?: string; verbs?: Array<{ name?: string; source?: string }> }> };
    const taskClass = tasksManifest.classes?.find((c) => c.local_name === "$task");
    expect(taskClass, "expected $task class in tasks manifest").toBeDefined();
    const expectedDoc = (verb: string) => {
      const v = taskClass!.verbs!.find((entry) => entry.name === verb)!;
      const block = /\/\*([\s\S]*?)\*\//.exec(v.source ?? "");
      expect(block, `verb :${verb} should have a /* */ doc-comment`).not.toBeNull();
      return block![1].split(/\n\s*\n/)[0].replace(/^\s*\*?\s?/gm, "").replace(/\s+/g, " ").trim();
    };

    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    const heldActions = [
      { verb: "pass", label: "Pass", args: [] },
      { verb: "yield", label: "Spawn related", args: [{ name: "spec", type: "map", required: true }] },
      { verb: "drop_terminal", label: "Drop", args: [{ name: "why", type: "str", required: true }] }
    ];
    const detail = {
      id: "obj_t_doc",
      name: "Doc task",
      text: "",
      kind: "task",
      labels: [],
      obligations: [{ key: "do:it", role: "doer", criterion: "Done.", met: false }],
      log: [],
      wait_for: [],
      links: [],
      terminal: false,
      complete: false,
      cursor: { key: "do:it", role: "doer", criterion: "Done." },
      location: "guest_1"
    };
    const woo: WooContext = {
      actor: "guest_1",
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_taskboard" ? "Taskboard" : ref, props: {}, catalogState: {} }),
      directCall: async (_target, verb) => {
        if (verb === "detail") return detail;
        if (verb === "listing") return [{ task: "obj_t_doc", name: "Doc task", kind: "task", labels: [], location: "guest_1", cursor_role: { key: "do:it", role: "doer", criterion: "Done." }, wait_for_count: 0, terminal: false, complete: false, link_count: 0, age_ms: 0, last_change: 0 }];
        if (verb === "available_actions") return heldActions;
        return null;
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string };
    element.woo = woo;
    element.subject = "the_taskboard";
    document.body.appendChild(element);
    await flush();
    element.querySelector<HTMLElement>("[data-tasks-card]")!.click();
    await flush();
    const titleByVerb = (verb: string) =>
      element.querySelector<HTMLButtonElement>(`[data-tasks-detail-task-actions] [data-tasks-action="${verb}"]`)?.title ?? "";
    expect(titleByVerb("pass")).toBe(expectedDoc("pass"));
    expect(titleByVerb("yield")).toBe(expectedDoc("yield"));
    expect(titleByVerb("drop_terminal")).toBe(expectedDoc("drop_terminal"));
  });

  it("renames ambiguous action verbs and exposes outcome tooltips on each button", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    // Held by guest_1, so available_actions returns the holder-side verbs:
    // pass / reject / wait / yield / handoff / release / drop_terminal.
    const heldActions = [
      { verb: "pass", label: "Pass", args: [] },
      { verb: "reject", label: "Reject", args: [{ name: "i", type: "int", required: true }, { name: "why", type: "str", required: true }] },
      { verb: "wait", label: "Wait", args: [{ name: "cond", type: "map", required: true }] },
      { verb: "yield", label: "Spawn related", args: [{ name: "spec", type: "map", required: true }] },
      { verb: "handoff", label: "Hand off", args: [{ name: "target", type: "obj", required: true }] },
      { verb: "release", label: "Release", args: [] },
      { verb: "drop_terminal", label: "Drop", args: [{ name: "why", type: "str", required: true }] }
    ];
    const detail = {
      id: "obj_t_held",
      name: "Held task",
      text: "",
      kind: "task",
      labels: [],
      obligations: [{ key: "do:it", role: "doer", criterion: "Done.", met: false }],
      log: [],
      wait_for: [],
      links: [],
      terminal: false,
      complete: false,
      cursor: { key: "do:it", role: "doer", criterion: "Done." },
      location: "guest_1"
    };
    const woo: WooContext = {
      actor: "guest_1",
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_taskboard" ? "Taskboard" : ref, props: {}, catalogState: {} }),
      directCall: async (_target, verb) => {
        if (verb === "detail") return detail;
        if (verb === "listing") return [{ task: "obj_t_held", name: "Held task", kind: "task", labels: [], location: "guest_1", cursor_role: { key: "do:it", role: "doer", criterion: "Done." }, wait_for_count: 0, terminal: false, complete: false, link_count: 0, age_ms: 0, last_change: 0 }];
        if (verb === "available_actions") return heldActions;
        return null;
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string };
    element.woo = woo;
    element.subject = "the_taskboard";
    document.body.appendChild(element);
    await flush();
    element.querySelector<HTMLElement>("[data-tasks-card]")!.click();
    await flush();

    // The "pass" button is renamed to "Mark step done" so it can't be
    // misread as "skip / decline". "Spawn related" becomes the friendlier
    // "Add related task". Both carry an outcome description as a title.
    const buttonByVerb = (verb: string) =>
      element.querySelector<HTMLButtonElement>(`[data-tasks-detail-task-actions] [data-tasks-action="${verb}"]`);

    const pass = buttonByVerb("pass")!;
    expect(pass.textContent?.trim()).toBe("Mark step done");
    expect(pass.title).toMatch(/advances to the next step/i);
    expect(pass.getAttribute("aria-label")).toMatch(/Mark step done/);
    expect(pass.getAttribute("aria-label")).toMatch(/advances to the next step/i);

    const yieldBtn = buttonByVerb("yield")!;
    expect(yieldBtn.textContent?.trim()).toBe("Add related task…"); // … because yield needs args
    expect(yieldBtn.title).toMatch(/Add a new task linked/i);

    expect(buttonByVerb("reject")!.textContent?.trim()).toBe("Reopen previous step…");
    expect(buttonByVerb("reject")!.title).toMatch(/marked done/i);
    expect(buttonByVerb("reject")!.title).toMatch(/back to it/i);
    expect(buttonByVerb("wait")!.textContent?.trim()).toBe("Mark blocked…");
    expect(buttonByVerb("handoff")!.textContent?.trim()).toBe("Hand off…");
    expect(buttonByVerb("handoff")!.title).toMatch(/another person in the same role/i);
    expect(buttonByVerb("release")!.textContent?.trim()).toBe("Put back on board");
    expect(buttonByVerb("release")!.title).toMatch(/can take it next/i);
    expect(buttonByVerb("drop_terminal")!.textContent?.trim()).toBe("Cancel task…");
    expect(buttonByVerb("drop_terminal")!.title).toMatch(/final/i);
    expect(buttonByVerb("drop_terminal")!.title).not.toMatch(/terminal-dropped/i);

    // Active-voice rewrite: claim describes what the user does, not what
    // they passively become.
    expect(buttonByVerb("pass")!.title).toMatch(/done/i);
    expect(buttonByVerb("pass")!.title).not.toMatch(/passed back to unmet/i);

    // No user-facing passive language: "held by", "role-holder", or the
    // airport-y "terminal" should not appear anywhere in the action copy.
    const allActionTitles = Array.from(element.querySelectorAll<HTMLButtonElement>("[data-tasks-detail-task-actions] [data-tasks-action]")).map((b) => b.title).join(" ");
    expect(allActionTitles).not.toMatch(/role-holder/i);
    expect(allActionTitles).not.toMatch(/held by/i);
    expect(allActionTitles).not.toMatch(/terminal/i);
    // Card and detail status use the active "with X" form, not "held by".
    const cardHolder = element.querySelector(".woo-tasks-card-holder")?.textContent ?? "";
    expect(cardHolder).toMatch(/with /i);
    expect(cardHolder).not.toMatch(/held by/i);
    const status = element.querySelector(".woo-tasks-detail-status")?.textContent ?? "";
    expect(status).toMatch(/^with /i);

    // Clicking an action that needs args opens the prompt; the prompt
    // header carries the same friendly label and a help line.
    yieldBtn.click();
    await flush();
    const promptHeader = element.querySelector(".woo-tasks-prompt-header")?.textContent;
    expect(promptHeader).toBe("Add related task");
    expect(element.querySelector(".woo-tasks-prompt-help")?.textContent).toMatch(/Add a new task linked/i);
  });

  it("uses Steps / Workflows labels and shows on-page explanatory copy in admin and task screens", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    const detail = {
      id: "obj_t_view",
      name: "Demo task",
      text: "",
      kind: "task",
      labels: [],
      obligations: [
        { key: "do:it", role: "doer", criterion: "Done.", met: false }
      ],
      log: [],
      wait_for: [],
      links: [],
      terminal: false,
      complete: false,
      cursor: { key: "do:it", role: "doer", criterion: "Done." },
      location: "the_taskboard"
    };
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
      directCall: async (_target, verb) => {
        if (verb === "detail") return detail;
        if (verb === "listing") return [{ task: "obj_t_view", name: "Demo task", kind: "task", labels: [], location: "the_taskboard", cursor_role: { key: "do:it", role: "doer", criterion: "Done." }, wait_for_count: 0, terminal: false, complete: false, link_count: 0, age_ms: 0, last_change: 0 }];
        if (verb === "available_actions") return [];
        return null;
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string };
    element.woo = woo;
    element.subject = "the_taskboard";
    document.body.appendChild(element);
    await flush();

    // Admin: tab labels are user-facing nouns, not internal jargon.
    element.querySelector<HTMLButtonElement>("[data-tasks-admin-toggle]")!.click();
    await flush();
    const tabLabels = Array.from(element.querySelectorAll<HTMLElement>('[role="tab"] span')).map((el) => el.textContent?.trim() ?? "");
    expect(tabLabels).toEqual(["Roles", "Steps", "Workflows"]);

    // The single per-section help block leads with the active section
    // and frames how it relates to the other two — no separate overview.
    expect(element.querySelector(".woo-tasks-admin-overview")).toBeNull();
    const roleHelp = element.querySelector(".woo-tasks-admin-section-help")?.textContent ?? "";
    expect(roleHelp).toMatch(/role/i);
    expect(roleHelp).toMatch(/step/i);
    expect(roleHelp).toMatch(/workflow/i);
    // Role table renames "Owners" → "Members".
    const roleHeaders = Array.from(element.querySelectorAll<HTMLElement>(".woo-tasks-admin-table th")).map((h) => h.textContent);
    expect(roleHeaders).toEqual(["Name", "Description", "Members"]);
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-tab="obligation"]')!.click();
    await flush();
    expect(element.querySelector(".woo-tasks-admin-section-help")?.textContent).toMatch(/step/i);
    expect(element.querySelector<HTMLElement>(".woo-tasks-admin-table th")?.textContent).toBe("Name");
    // Step table renames "Criterion" → "Conditions of satisfaction".
    const stepHeaders = Array.from(element.querySelectorAll<HTMLElement>(".woo-tasks-admin-table th")).map((h) => h.textContent);
    expect(stepHeaders).toEqual(["Name", "Role", "Conditions of satisfaction"]);
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-tab="policy"]')!.click();
    await flush();
    expect(element.querySelector(".woo-tasks-admin-section-help")?.textContent).toMatch(/workflow/i);
    expect(Array.from(element.querySelectorAll<HTMLElement>(".woo-tasks-admin-table th")).map((h) => h.textContent)).toEqual(["Workflow", "Steps (in order)"]);

    // Workflow editor surfaces a help block + per-field hints.
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-new="policy"]')!.click();
    await flush();
    const editorHelp = element.querySelector(".woo-tasks-admin-form-help")?.textContent ?? "";
    expect(editorHelp).toMatch(/workflow/i);
    expect(editorHelp).toMatch(/checklist/i);
    const hints = Array.from(element.querySelectorAll<HTMLElement>(".woo-tasks-form-hint")).map((h) => h.textContent ?? "");
    // At least one hint explains the per-step selection / ordering model of the
    // workflow editor — the picker uses buttons + a draggable ordered list, so
    // "order" appears in the hint of the selected-steps reorder list.
    expect(hints.some((h) => /order/i.test(h))).toBe(true);
    element.querySelector<HTMLButtonElement>("[data-tasks-admin-edit-cancel]")!.click();
    await flush();
    element.querySelector<HTMLButtonElement>("[data-tasks-admin-toggle]")!.click();
    await flush();

    // Task detail dialog: section is "Steps", with a summary line that
    // exposes which step is current and who owns it.
    element.querySelector<HTMLElement>("[data-tasks-card]")!.click();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const stepHeadings = Array.from(element.querySelectorAll<HTMLElement>(".woo-tasks-detail-section h4")).map((h) => h.textContent?.trim());
    expect(stepHeadings).toContain("Steps");
    expect(stepHeadings).not.toContain("Obligations");
    expect(element.querySelector(".woo-tasks-detail-section-help")?.textContent).toMatch(/step 1 of 1/i);
    expect(element.querySelector(".woo-tasks-detail-obligation-role")?.textContent).toBe("doer");
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
    roleForm.querySelector<HTMLTextAreaElement>('textarea[name="description"]')!.value = "Reviews work";
    roleForm.querySelector<HTMLInputElement>('input[name="owners"]')!.value = "guest_a, guest_b";
    roleForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const setRole = calls.find((c) => c.verb === "set_role");
    expect(setRole?.args).toEqual(["reviewer", { description: "Reviews work", owners: ["guest_a", "guest_b"] }]);
    expect(element.textContent).toContain('Added role "reviewer".');

    // Add an obligation.
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-tab="obligation"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-new="obligation"]')!.click();
    const obForm = element.querySelector("[data-tasks-admin-form='obligation']") as HTMLFormElement;
    obForm.querySelector<HTMLInputElement>('input[name="key"]')!.value = "review:approve";
    obForm.querySelector<HTMLSelectElement>('select[name="role"]')!.value = "doer";
    obForm.querySelector<HTMLTextAreaElement>('textarea[name="criterion"]')!.value = "Reviewer approves.";
    obForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const setOb = calls.find((c) => c.verb === "set_obligation");
    expect(setOb?.args).toEqual(["review:approve", { role: "doer", criterion: "Reviewer approves." }]);
    expect(element.textContent).toContain('Added step "review:approve".');

    // Add a policy. The workflow editor uses a button picker for available
    // steps; click the step we want to include, then submit. The click
    // triggers a re-render, so re-query the form before reading the kind
    // input and dispatching submit.
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-tab="policy"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-new="policy"]')!.click();
    await flush();
    element.querySelector<HTMLButtonElement>('[data-tasks-policy-add-step="do:it"]')!.click();
    await flush();
    const polForm = element.querySelector("[data-tasks-admin-form='policy']") as HTMLFormElement;
    polForm.querySelector<HTMLInputElement>('input[name="kind"]')!.value = "review";
    polForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const setPol = calls.find((c) => c.verb === "set_policy");
    expect(setPol?.args).toEqual(["review", ["do:it"]]);
    expect(element.textContent).toContain('Saved policy "review".');

    // Remove buttons confirm first, then fire the matching remove_* verbs
    // with the targeted key. Clicking a table row opens the edit editor,
    // which exposes the Remove button for that entry.
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-tab="role"]')!.click();
    await flush();
    element.querySelector<HTMLElement>('tr[data-tasks-admin-section="role"][data-key="doer"]')!.click();
    await flush();
    expect(element.querySelector<HTMLButtonElement>('[data-tasks-admin-remove="role"][data-key="doer"]')).not.toBeNull();
    confirmSpy.mockReturnValueOnce(false);
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-remove="role"][data-key="doer"]')!.click();
    expect(confirmSpy).toHaveBeenCalledWith('Remove role "doer"?');
    expect(calls.find((c) => c.verb === "remove_role")).toBeUndefined();

    confirmSpy.mockReturnValue(true);
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-remove="role"][data-key="doer"]')!.click();
    await flush();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-tab="obligation"]')!.click();
    await flush();
    element.querySelector<HTMLElement>('tr[data-tasks-admin-section="obligation"][data-key="do:it"]')!.click();
    await flush();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-remove="obligation"][data-key="do:it"]')!.click();
    await flush();
    element.querySelector<HTMLButtonElement>('[data-tasks-admin-tab="policy"]')!.click();
    await flush();
    element.querySelector<HTMLElement>('tr[data-tasks-admin-section="policy"][data-key="task"]')!.click();
    await flush();
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
    expect(status?.textContent).toContain('Could not add role "reviewer": not allowed');
  });

  it("preserves create and admin drafts across task refresh renders", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    element.woo = testWooContext({ guest_1: "Guest 1" });
    element.subject = "the_taskboard";
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
    expect(element.querySelector("h1")?.textContent).toBe("Taskboard");

    nameInput.blur();
    await Promise.resolve();
    expect(element.querySelector("h1")?.textContent).toBe("Taskboard refreshed");
    expect(element.querySelector<HTMLInputElement>("[data-tasks-detail-form] input[name='name']")?.value).toBe("typing is still here");
  });

  it("does not defer refresh when focus is on a non-task input (embedded chat composer)", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; refresh?: () => Promise<void> };
    const listing = [
      { task: "obj_t_late", name: "Late lander", kind: "task", labels: [], location: "the_taskboard", cursor_role: null, wait_for_count: 0, terminal: false, complete: false, link_count: 0, age_ms: 0, last_change: 0 }
    ];
    const woo: WooContext = {
      actor: "guest_1",
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_taskboard" ? "Taskboard" : ref, props: {}, catalogState: {} }),
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
    document.body.appendChild(element);

    // Simulate the chat panel mounted inside the kanban — its composer is
    // a plain <input> with no `data-tasks-*` ancestor. Focus before refresh.
    const chatComposer = document.createElement("input");
    chatComposer.setAttribute("data-space-chat-input", "true");
    element.appendChild(chatComposer);
    chatComposer.focus();
    expect(document.activeElement).toBe(chatComposer);

    await element.refresh!();
    // Refresh must produce the rendered card even though a non-task input
    // had focus — only tasks-owned form fields should defer the render.
    expect(element.querySelector<HTMLElement>("[data-tasks-card='obj_t_late']")).not.toBeNull();
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
    // No "×" close button in new mode — Cancel handles it from form actions.
    expect(form!.querySelector("[data-tasks-detail-close]")).toBeNull();
    // The instructions field has exactly one label (rename from "Body" →
    // "Task instructions"), not duplicated by an outer section heading.
    const fieldLabels = Array.from(form!.querySelectorAll<HTMLElement>(".woo-tasks-detail-field-label")).map((el) => (el.firstChild?.textContent ?? "").trim());
    expect(fieldLabels.filter((t) => /^Task instructions$/.test(t))).toHaveLength(1);
    expect(fieldLabels.filter((t) => /^Body$/i.test(t))).toHaveLength(0);
    expect(form!.querySelector(".woo-tasks-detail-section h4")).toBeNull();
    // Obligations / log are hidden for the not-yet-minted draft.
    expect(form!.querySelector(".woo-tasks-detail-obligations")).toBeNull();
    expect(form!.querySelector(".woo-tasks-detail-log")).toBeNull();
    const kindSelect = form!.querySelector<HTMLSelectElement>('select[name="kind"]')!;
    expect(Array.from(kindSelect.options).map((opt) => opt.value)).toEqual(["task", "bug"]);
    // Create starts disabled (empty name); typing a name enables it.
    const submit = form!.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(true);
    const nameInput = form!.querySelector<HTMLInputElement>('input[name="name"]')!;
    nameInput.value = "  ";
    nameInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(submit.disabled).toBe(true);
    nameInput.value = "Refactor verb dispatch";
    nameInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(submit.disabled).toBe(false);
    kindSelect.value = "bug";
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

  it("refreshes on woo-tasks-refresh window events and stops on disconnect", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
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
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string };
    element.woo = woo;
    element.subject = "the_taskboard";
    document.body.appendChild(element);
    // Initial mount triggers one refresh.
    await flush();
    const initialCalls = listingCalls;
    expect(initialCalls).toBeGreaterThanOrEqual(1);

    // A burst of observation events while a refresh is in flight should
    // coalesce into exactly one follow-up refresh, not one per event.
    window.dispatchEvent(new CustomEvent("woo-tasks-refresh"));
    window.dispatchEvent(new CustomEvent("woo-tasks-refresh"));
    window.dispatchEvent(new CustomEvent("woo-tasks-refresh"));
    await flush();
    expect(listingCalls - initialCalls).toBeLessThanOrEqual(2);
    expect(listingCalls).toBeGreaterThan(initialCalls);

    // After disconnect, further events must not trigger a refresh.
    const beforeDisconnect = listingCalls;
    element.remove();
    window.dispatchEvent(new CustomEvent("woo-tasks-refresh"));
    await flush();
    expect(listingCalls).toBe(beforeDisconnect);
  });

  it("does not refresh-loop when the host rebinds the same tasks subject", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    let listingCalls = 0;
    let releaseInitialListing!: () => void;
    const initialListing = new Promise<void>((resolve) => { releaseInitialListing = resolve; });
    const makeWoo = (): WooContext => ({
      actor: "guest_1",
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_taskboard" ? "Taskboard" : ref, props: {}, catalogState: {} }),
      directCall: async (_target, verb) => {
        if (verb === "listing") {
          listingCalls += 1;
          if (listingCalls === 1) await initialListing;
        }
        return [];
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    });
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string };
    element.woo = makeWoo();
    element.subject = "the_taskboard";
    document.body.appendChild(element);
    await flush();
    expect(listingCalls).toBe(1);

    // main.ts preserves the custom element across app renders but reassigns the
    // same subject and a fresh WooContext. That must update the component's
    // context without scheduling another directCall refresh.
    element.subject = "the_taskboard";
    element.woo = makeWoo();
    await flush();
    expect(listingCalls).toBe(1);

    // The app shell preserves active tool elements by removing and reattaching
    // them during render. Reconnect must not behave like a fresh taskboard entry.
    element.remove();
    document.body.appendChild(element);
    await flush();
    expect(listingCalls).toBe(1);

    releaseInitialListing();
    await flush();
    expect(listingCalls).toBe(1);

    element.remove();
  });

  it("kicks an initial refresh when woo is wired up after the element connects", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    let listingCalls = 0;
    const woo: WooContext = {
      actor: null,
      frame: { id: "test", subject: "the_taskboard", get: () => undefined, set: () => true },
      neighborhood: { subject: "the_taskboard", refs: [], related: {}, has: () => true },
      observe: (ref) => ({ id: ref, name: ref === "the_taskboard" ? "Taskboard" : ref, props: {}, catalogState: {} }),
      directCall: async (_target, verb) => {
        if (verb === "listing") listingCalls += 1;
        return [];
      },
      send: async () => undefined,
      call: async () => undefined,
      emit: () => true
    };
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string };
    // Mount the element bare — no woo, no subject — to mirror the production
    // sequence where main.ts calls innerHTML first and then mountTasksKanban
    // wires woo + subject afterwards.
    document.body.appendChild(element);
    await flush();
    expect(listingCalls).toBe(0);

    element.subject = "the_taskboard";
    await flush();
    expect(listingCalls).toBe(0);

    element.woo = woo;
    await flush();
    expect(listingCalls).toBeGreaterThanOrEqual(1);
  });

  it("closes the task dialog on backdrop click and Escape", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; subject?: string; data?: any };
    element.woo = testWooContext({ guest_1: "Guest 1" });
    document.body.appendChild(element);
    element.data = {
      registryId: "the_taskboard",
      registryName: "Taskboard",
      actor: "guest_1",
      actorNames: { guest_1: "Guest 1" },
      tasks: [{ id: "obj_t_x", name: "X", kind: "bug", labels: [], location: "the_taskboard", cursorRole: null, cursorKey: null, cursorCriterion: null, waitForCount: 0, terminal: false, complete: false, linkCount: 0, ageMs: 0, lastChange: 0, actions: [] }]
    };

    // Backdrop click closes.
    element.querySelector<HTMLElement>("[data-tasks-card]")!.click();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(element.querySelector("[data-tasks-modal-backdrop]")).not.toBeNull();
    element.querySelector<HTMLElement>("[data-tasks-modal-backdrop]")!.click();
    expect(element.querySelector("[data-tasks-modal-backdrop]")).toBeNull();

    // Reopen, then Escape closes.
    element.querySelector<HTMLElement>("[data-tasks-card]")!.click();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(element.querySelector("[data-tasks-modal-backdrop]")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(element.querySelector("[data-tasks-modal-backdrop]")).toBeNull();
  });

  it("registerWooObservationHandlers fans task observations out as window events", async () => {
    const mod = await import("../catalogs/tasks/ui/kanban-board");
    const handlers: Array<{ types: string[]; reduce: (...args: unknown[]) => void }> = [];
    const fakeRegistry = {
      observation: (handler: { types: string[]; reduce: (...args: unknown[]) => void }) => {
        handlers.push(handler);
      }
    };
    mod.registerWooObservationHandlers(fakeRegistry as unknown as Parameters<typeof mod.registerWooObservationHandlers>[0]);
    expect(handlers).toHaveLength(1);
    const reduce = handlers[0].reduce;
    expect(handlers[0].types).toContain("task_passed");
    expect(handlers[0].types).toContain("registry_role_changed");
    let fired = 0;
    const listener = () => { fired += 1; };
    window.addEventListener("woo-tasks-refresh", listener);
    try {
      reduce({} as never, { observation: { type: "task_passed", task: "obj_t_1" }, delivered: { route: "sequenced" } } as never);
    } finally {
      window.removeEventListener("woo-tasks-refresh", listener);
    }
    expect(fired).toBe(1);
  });

  it("renders the tasks kanban with state columns, cursor badges, and actions", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; data?: any; showCompanion?: boolean };
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

    expect(element.querySelector("h1")?.textContent).toBe("Taskboard");
    expect(element.querySelector('[data-ambient-companion-shell="the_taskboard"]')).toBeNull();
    element.showCompanion = true;
    expect(element.querySelector('[data-ambient-companion-shell="the_taskboard"]')).not.toBeNull();
    expect(element.querySelector("[data-ambient-companion]")).not.toBeNull();
    // The status-filter lozenges live in the kanban-scoped filter bar, not
    // in the registry header — they apply only to the kanban view.
    expect(element.querySelector(".woo-tasks-kanban-header .woo-tasks-status-nav")).toBeNull();
    expect(element.querySelector(".woo-tasks-kanban-filterbar .woo-tasks-status-nav")).not.toBeNull();
    const colCounts = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col]")).map((col) => ({
      id: col.dataset.tasksCol,
      count: col.querySelector<HTMLElement>("[data-tasks-col-count]")?.textContent
    }));
    expect(colCounts).toEqual([
      { id: "ready", count: "1" },
      { id: "waiting", count: "1" },
      { id: "in_flight", count: "1" }
    ]);
    // User-facing column labels: "Active" (not "In flight"), "Blocked"
    // (consistent with the "Mark blocked" action — not "Waiting").
    const colLabels = Array.from(element.querySelectorAll<HTMLElement>("[data-tasks-col] .woo-tasks-kanban-col-name")).map((el) => el.textContent);
    expect(colLabels).toEqual(["Ready", "Blocked", "Active"]);
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

    // Action buttons (claim, etc.) live in the detail dialog, not on the
    // card itself. The "self-fetches listing + available_actions" test
    // covers click-card → click-action → dispatch.
    expect(element.querySelector("[data-tasks-card] [data-tasks-action]")).toBeNull();
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

    // group-by selection persists across data updates
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
    expect(element.querySelector<HTMLSelectElement>("[data-tasks-group-by]")?.value).toBe("kind");
    // Drag-drop is disabled — cards never carry draggable attributes.
    const card = element.querySelector<HTMLElement>("[data-tasks-card]")!;
    expect(card.getAttribute("draggable")).toBeNull();
  });

  it("preserves an existing task-space chat panel across rerenders", async () => {
    const { WooTasksKanbanElement } = await import("../catalogs/tasks/ui/kanban-board");
    defineOnce("woo-tasks-kanban", WooTasksKanbanElement);
    if (!customElements.get("woo-space-chat-panel")) {
      customElements.define("woo-space-chat-panel", class extends HTMLElement {});
    }
    const element = document.createElement("woo-tasks-kanban") as HTMLElement & { woo?: WooContext; data?: any; showCompanion?: boolean };
    document.body.appendChild(element);
    element.showCompanion = true;

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

    const slot = element.querySelector<HTMLElement>("[data-ambient-companion]");
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

    const data = {
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
    element.data = data;

    expect(element.querySelector<HTMLTextAreaElement>("[data-pin-note-text]")?.value).toBe("hello");
    let detail: any;
    element.addEventListener("woo-pinboard-create", (event: Event) => { detail = (event as CustomEvent).detail; });
    element.querySelector<HTMLFormElement>("[data-pinboard-create]")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    expect(detail).toMatchObject({ text: "draft", color: "pink" });

    const panel = appendAmbientCompanionPanel(element, "the_pinboard");
    element.data = { ...data, newText: "next draft" };
    expect(element.querySelector("[data-space-chat-panel]")).toBe(panel);
    expect(element.querySelector("[data-ambient-companion]")?.firstElementChild).toBe(panel);
  });

  it("renders dubspace controls and emits control commits", async () => {
    const { WooDubspaceWorkspaceElement } = await import("../catalogs/dubspace/ui/dubspace-workspace");
    defineOnce("woo-dubspace-workspace", WooDubspaceWorkspaceElement);
    const element = document.createElement("woo-dubspace-workspace") as HTMLElement & { woo?: WooContext; data?: any };
    element.woo = testWooContext({ guest_1: "Guest 1" });
    document.body.appendChild(element);

    const data = {
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
      present: ["guest_1"],
      actor: "guest_1",
      inSpace: true,
      canSend: true,
      audioOn: false,
      cueSlots: {},
      cuePlaying: {}
    };
    element.data = data;

    let detail: any;
    element.addEventListener("woo-dubspace-control-commit", (event: Event) => { detail = (event as CustomEvent).detail; });
    const cutoff = element.querySelector<HTMLInputElement>('[data-target="filter_1"][data-name="cutoff"]')!;
    cutoff.value = "750";
    cutoff.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(detail).toMatchObject({ target: "filter_1", name: "cutoff", value: 750 });

    const panel = appendAmbientCompanionPanel(element, "the_dubspace");
    element.data = { ...data, audioOn: true };
    expect(element.querySelector("[data-space-chat-panel]")).toBe(panel);
    expect(element.querySelector("[data-ambient-companion]")?.firstElementChild).toBe(panel);
  });

});
