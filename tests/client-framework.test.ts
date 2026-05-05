import { describe, expect, it } from "vitest";

import chatManifest from "../catalogs/chat/manifest.json";
import { CatalogUiRegistry, createWooClientFramework } from "../src/client/framework";

describe("client UI framework projection", () => {
  it("keeps optimistic pinboard placement across stale world refreshes until applied confirmation", () => {
    const ui = createWooClientFramework();
    ui.ingestWorld({
      objects: {
        note_1: { id: "note_1", name: "note", parent: "$pin", props: {} }
      },
      pinboard: {
        notes: [{ id: "note_1", x: 40, y: 50, w: 180, h: 110 }]
      }
    });

    ui.projection.applyOptimistic("drag:note_1", [
      { subject: "note_1", catalogState: { pinboard_note: { x: 160, y: 170 } } }
    ]);
    ui.ingestWorld({
      objects: {
        note_1: { id: "note_1", name: "note", parent: "$pin", props: {} }
      },
      pinboard: {
        notes: [{ id: "note_1", x: 40, y: 50, w: 180, h: 110 }]
      }
    });

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ x: 160, y: 170, w: 180, h: 110 });

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 9,
      space: "the_pinboard",
      observations: [{ type: "pin_moved", pin: "note_1", x: 162, y: 171, z: 7 }]
    });

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ x: 162, y: 171, z: 7 });
  });

  it("applies live dubspace gesture previews without mutating canonical props", () => {
    const ui = createWooClientFramework();
    ui.ingestWorld({
      objects: {
        delay_1: { id: "delay_1", name: "delay", props: { feedback: 0.25 } }
      },
      dubspace: {
        delay_1: { id: "delay_1", name: "delay", props: { feedback: 0.25 } }
      }
    });

    ui.ingestLiveObservation({ type: "gesture_progress", target: "delay_1", name: "feedback", value: 0.75 });
    expect(ui.observe("delay_1")?.props.feedback).toBe(0.75);

    ui.ingestWorld({
      objects: {
        delay_1: { id: "delay_1", name: "delay", props: { feedback: 0.25 } }
      },
      dubspace: {
        delay_1: { id: "delay_1", name: "delay", props: { feedback: 0.25 } }
      }
    });
    expect(ui.observe("delay_1")?.props.feedback).toBe(0.75);

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 10,
      space: "the_dubspace",
      observations: [{ type: "control_changed", target: "delay_1", name: "feedback", value: 0.5 }]
    });
    expect(ui.observe("delay_1")?.props.feedback).toBe(0.5);
  });

  it("coalesces repeated live observations for the same subject field", () => {
    const ui = createWooClientFramework();
    ui.ingestWorld({
      objects: {
        delay_1: { id: "delay_1", name: "delay", props: { feedback: 0.25 } }
      }
    });

    for (let value = 0; value < 20; value += 1) {
      ui.ingestLiveObservation({ type: "gesture_progress", target: "delay_1", name: "feedback", value });
    }

    expect(ui.observe("delay_1")?.props.feedback).toBe(19);
    ui.prune(Date.now() + 2_000);
    expect(ui.observe("delay_1")?.props.feedback).toBe(0.25);
  });

  it("keeps independent live fields on separate coalesced layers", () => {
    const ui = createWooClientFramework();
    ui.ingestWorld({
      objects: {
        delay_1: { id: "delay_1", name: "delay", props: { feedback: 0.25, wet: 0.1 } }
      }
    });

    ui.ingestLiveObservation({ type: "gesture_progress", target: "delay_1", name: "feedback", value: 0.8 });
    ui.ingestLiveObservation({ type: "gesture_progress", target: "delay_1", name: "wet", value: 0.6 });

    expect(ui.observe("delay_1")?.props).toMatchObject({ feedback: 0.8, wet: 0.6 });
  });

  it("supports frame state and overlay actions as framework-owned UI state", () => {
    const ui = createWooClientFramework();
    ui.frames.ensureFrame("pinboard:main", "the_pinboard", "board");

    expect(ui.frames.emit({ type: "set_frame_state", frame: "pinboard:main", key: "selected", value: "note_1" })).toBe(true);
    expect(ui.frames.frame("pinboard:main")?.values.selected).toBe("note_1");

    expect(ui.frames.emit({ type: "open_overlay", frame: "note-editor", subject: "note_1", view: "editor" })).toBe(true);
    expect(ui.frames.overlayStack()).toEqual([{ id: "note-editor", subject: "note_1", view: "editor", state: {} }]);
    expect(ui.frames.emit({ type: "close_overlay", frame: "note-editor" })).toBe(true);
    expect(ui.frames.overlayStack()).toEqual([]);
  });
});

describe("catalog UI registry", () => {
  const pkg = {
    alias: "pinboard",
    catalog: "pinboard",
    objects: { "$pinboard": "$pinboard" },
    ui: {
      abi: "woo-ui/v1",
      modules: [{ id: "pinboard-ui", entry: "ui/pinboard.js" }],
      components: [
        { id: "pinboard.board", module: "pinboard-ui", tag: "woo-pinboard-board", surface: "main", subject: "$pinboard" },
        { id: "pinboard.presence", module: "pinboard-ui", tag: "woo-pinboard-presence", surface: "presence", subject: "$pinboard" }
      ],
      frames: [
        { id: "pinboard.default", subject: "$pinboard", layout: "space-workspace", regions: { main: [{ component: "pinboard.board", subject: "this" }] } },
        { id: "pinboard.map", subject: "$pinboard", view: "map", layout: "tool", regions: { main: [{ component: "pinboard.board", subject: "this" }] } }
      ]
    }
  };

  it("resolves component ids locally and with catalog qualification", () => {
    const registry = new CatalogUiRegistry();
    expect(registry.installCatalogUi(pkg)).toEqual([]);

    expect(registry.resolveComponentId("pinboard.board", "pinboard")).toBe("pinboard:pinboard.board");
    expect(registry.resolveComponentId("pinboard:pinboard.presence")).toBe("pinboard:pinboard.presence");
    expect(registry.component("pinboard.board", "pinboard")?.declaration.tag).toBe("woo-pinboard-board");
  });

  it("resolves exact view frames ahead of default frames", () => {
    const registry = new CatalogUiRegistry();
    registry.installCatalogUi(pkg);

    const defaultFrame = registry.resolveFrame("$pinboard", undefined, () => false);
    const mapFrame = registry.resolveFrame("$pinboard", "map", () => false);

    expect(defaultFrame?.frame.id).toBe("pinboard.default");
    expect(mapFrame?.frame.id).toBe("pinboard.map");
  });

  it("validates module tag registration against manifest declarations", () => {
    const registry = new CatalogUiRegistry();
    registry.installCatalogUi(pkg);
    const defined = new Map<string, CustomElementConstructor>();
    const customElementsLike = {
      define(tag: string, ctor: CustomElementConstructor) {
        defined.set(tag, ctor);
      },
      get(tag: string) {
        return defined.get(tag);
      }
    };
    const ctor = class {} as unknown as CustomElementConstructor;

    registry.defineTag("pinboard", "pinboard-ui", "woo-pinboard-board", ctor, customElementsLike);
    expect(defined.get("woo-pinboard-board")).toBe(ctor);
    expect(() => registry.defineTag("pinboard", "pinboard-ui", "woo-undeclared", ctor, customElementsLike)).toThrow(/not declared/);
  });

  it("registers the bundled chat.space component declaration", () => {
    const registry = new CatalogUiRegistry();
    expect(registry.installCatalogUi({
      alias: "chat",
      catalog: "chat",
      objects: { "$space": "$space", "$chatroom": "$chatroom" },
      ui: (chatManifest as any).ui
    })).toEqual([]);

    expect(registry.resolveComponentId("chat.space", "chat")).toBe("chat:chat.space");
    expect(registry.component("chat.space", "chat")?.declaration).toMatchObject({
      tag: "woo-chat-space",
      module: "chat-ui",
      surface: "chat",
      subject: "$space"
    });
    expect(registry.component("chat.space-mini", "chat")?.declaration).toMatchObject({
      tag: "woo-space-chat-panel",
      module: "chat-ui",
      surface: "space-chat",
      subject: "$space"
    });
    expect(registry.resolveFrame("$chatroom", undefined, () => false)?.frame.id).toBe("chat.room");
  });
});
