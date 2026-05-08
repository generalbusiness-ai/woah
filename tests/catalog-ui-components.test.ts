// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import chatManifest from "../catalogs/chat/manifest.json";
import dubspaceManifest from "../catalogs/dubspace/manifest.json";
import pinboardManifest from "../catalogs/pinboard/manifest.json";
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
  // The tasks catalog ships no UI in v1 (no `ui` block in manifest, no ui/ dir);
  // see spec/discovery/catalogs.md §CT12. A future kanban or registry view would
  // be authored here.
  it("declares and resolves first-party tool frames", () => {
    const registry = new CatalogUiRegistry();
    expect(registry.installCatalogUi({ alias: "chat", catalog: "chat", objects: { "$space": "$space", "$chatroom": "$chatroom" }, ui: (chatManifest as any).ui })).toEqual([]);
    expect(registry.installCatalogUi({ alias: "dubspace", catalog: "dubspace", objects: { "$dubspace": "$dubspace" }, ui: (dubspaceManifest as any).ui })).toEqual([]);
    expect(registry.installCatalogUi({ alias: "pinboard", catalog: "pinboard", objects: { "$pinboard": "$pinboard" }, ui: (pinboardManifest as any).ui })).toEqual([]);
    expect(registry.installCatalogUi({ alias: "weather", catalog: "weather", objects: { "$weather_block": "$weather_block" }, ui: (weatherManifest as any).ui })).toEqual([]);

    expect(registry.resolveFrame("the_dubspace", undefined, (_subject, classRef) => classRef === "$dubspace" ? 1 : false)?.frame.id).toBe("dubspace.workspace");
    expect(registry.resolveFrame("the_pinboard", undefined, (_subject, classRef) => classRef === "$pinboard" ? 1 : false)?.frame.id).toBe("pinboard.board");
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
