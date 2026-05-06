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

  it("reduces pinboard note edits and recolors into catalog state", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "note_1", name: "Note", catalogState: { pinboard_note: { text: ["old"], color: "yellow", x: 10, y: 20 } } }
    ]);

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 14,
      space: "the_pinboard",
      observations: [
        { type: "note_edited", note: "note_1", text: ["new", "text"] },
        { type: "pin_recolored", pin: "note_1", color: "pink" }
      ]
    });

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({
      text: ["new", "text"],
      color: "pink",
      x: 10,
      y: 20
    });
  });

  it("keeps optimistic pinboard text edits across stale overlay snapshots until applied confirmation", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "note_1", name: "Note", catalogState: { pinboard_note: { text: ["old"], color: "yellow" } } }
    ]);

    ui.applyOptimisticCall("call-1", {
      optimistic: {
        id: "pinboard:note_1:note",
        patches: [{ subject: "note_1", catalogState: { pinboard_note: { text: ["draft"] } } }]
      }
    });
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "note_1", name: "Note", catalogState: { pinboard_note: { text: ["old"], color: "yellow" } } }
    ]);

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ text: ["draft"], color: "yellow" });

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 15,
      space: "the_pinboard",
      observations: [{ type: "note_edited", note: "note_1", text: ["draft"] }]
    });
    ui.completeOptimisticCall("call-1");

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ text: ["draft"], color: "yellow" });
  });

  it("clears pinboard catalog state when a pin leaves the board", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "the_pinboard", name: "Board", props: { layout: { note_1: { x: 10, y: 20 } } } },
      { id: "note_1", name: "Note", catalogState: { pinboard_note: { text: ["old"], x: 10, y: 20 } } }
    ]);

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 16,
      space: "the_pinboard",
      observations: [{ type: "pin_removed", board: "the_pinboard", pin: "note_1" }]
    });

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toBeUndefined();
    expect(ui.observe("the_pinboard")?.catalogState.pinboard_layout).toMatchObject({ note_1: null });
  });

  it("tracks added pinboard notes through board layout catalog state", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "the_pinboard", name: "Board", props: { layout: {} } }
    ]);

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 17,
      space: "the_pinboard",
      observations: [{
        type: "note_added",
        board: "the_pinboard",
        pin: "note_1",
        note: { id: "note_1", name: "Note", text: ["hello"], x: 12, y: 24, w: 180, h: 110, z: 3 }
      }]
    });

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ text: ["hello"], x: 12, y: 24 });
    expect(ui.observe("the_pinboard")?.catalogState.pinboard_layout).toMatchObject({ note_1: { x: 12, y: 24, w: 180, h: 110, z: 3 } });
  });

  it("keeps pinboard layout overlays sparse across sequential partial updates", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "the_pinboard", name: "Board", props: { layout: { note_1: { x: 10, y: 20, w: 180, h: 110, z: 1 } } } },
      { id: "note_1", name: "Note", catalogState: { pinboard_note: { x: 10, y: 20, w: 180, h: 110 } } }
    ]);

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 18,
      space: "the_pinboard",
      observations: [{ type: "pin_moved", board: "the_pinboard", pin: "note_1", x: 12, y: 24, z: 2 }]
    });
    ui.ingestAppliedFrame({
      op: "applied",
      seq: 19,
      space: "the_pinboard",
      observations: [{ type: "pin_resized", board: "the_pinboard", pin: "note_1", w: 200, h: 120 }]
    });

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ x: 12, y: 24, w: 200, h: 120, z: 2 });
    expect(ui.observe("the_pinboard")?.catalogState.pinboard_layout).toMatchObject({ note_1: { w: 200, h: 120 } });
  });

  it("tracks pinboard presence as a catalog-state overlay", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "the_pinboard", name: "Board", props: { subscribers: ["guest_1"] } }
    ]);

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 20,
      space: "the_pinboard",
      observations: [
        { type: "pinboard_entered", board: "the_pinboard", actor: "guest_2" },
        { type: "pinboard_left", board: "the_pinboard", actor: "guest_1" }
      ]
    });

    expect(ui.observe("the_pinboard")?.catalogState.pinboard_presence).toEqual({ guest_2: true, guest_1: false });
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

  it("applies direct control_changed observations as live projection until refresh", () => {
    const ui = createWooClientFramework();
    ui.ingestWorld({
      objects: {
        filter_1: { id: "filter_1", name: "filter", props: { cutoff: 1000 } }
      }
    });

    ui.ingestLiveObservation({ type: "control_changed", target: "filter_1", name: "cutoff", value: 500 });
    expect(ui.observe("filter_1")?.props.cutoff).toBe(500);

    ui.ingestWorld({
      objects: {
        filter_1: { id: "filter_1", name: "filter", props: { cutoff: 500 } }
      }
    });
    ui.prune(Date.now() + 2_000);
    expect(ui.observe("filter_1")?.props.cutoff).toBe(500);
  });

  it("can fold direct authoritative patches into canonical projection", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:dubspace:the_dubspace", [
      { id: "filter_1", name: "filter", props: { cutoff: 1000 } }
    ]);

    ui.ingestLiveObservation({ type: "gesture_progress", target: "filter_1", name: "cutoff", value: 750 });
    expect(ui.observe("filter_1")?.props.cutoff).toBe(750);

    ui.applyCanonical([{ subject: "filter_1", props: { cutoff: 500 } }]);
    ui.prune(Date.now() + 2_000);
    expect(ui.observe("filter_1")?.props.cutoff).toBe(500);
  });

  it("keeps direct authoritative patches across later scoped snapshots", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "note_1", name: "Note", parent: "$pin", catalogState: { pinboard_note: { color: "green" } } }
    ]);

    ui.applyCanonical([{ subject: "note_1", catalogState: { pinboard_note: { text: ["hydrated"], color: "green" } } }]);
    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ text: ["hydrated"], color: "green" });

    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "note_1", name: "Note", parent: "$pin", catalogState: { pinboard_note: { color: "green" } } }
    ]);

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ text: ["hydrated"], color: "green" });
  });

  it("clears authoritative patches so removed scoped objects do not ghost", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "the_pinboard", name: "Board", props: { layout: { note_1: { x: 10, y: 20 } } } },
      { id: "note_1", name: "Note", parent: "$pin", catalogState: { pinboard_note: { color: "green" } } }
    ]);
    ui.applyCanonical([{ subject: "note_1", catalogState: { pinboard_note: { text: ["hydrated"], color: "green" } } }]);

    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "the_pinboard", name: "Board", props: { layout: {} } }
    ]);
    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ text: ["hydrated"], color: "green" });

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 21,
      space: "the_pinboard",
      observations: [{ type: "pin_removed", board: "the_pinboard", pin: "note_1" }]
    });

    expect(ui.observe("note_1")).toBeUndefined();
  });

  it("can replace authoritative patches for full canonical refreshes", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "note_1", name: "Note", parent: "$pin" }
    ]);

    ui.applyCanonical([{ subject: "note_1", catalogState: { pinboard_note: { text: ["old"], color: "yellow" } } }], { mode: "replace" });
    ui.applyCanonical([{ subject: "note_1", catalogState: { pinboard_note: { text: ["new"] } } }], { mode: "replace" });

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toEqual({ text: ["new"] });
  });

  it("clears authoritative patches on full world refresh", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:dubspace:the_dubspace", [
      { id: "filter_1", name: "filter", props: { cutoff: 1000 } }
    ]);
    ui.applyCanonical([{ subject: "filter_1", props: { cutoff: 500 } }]);
    expect(ui.observe("filter_1")?.props.cutoff).toBe(500);

    ui.ingestWorld({
      objects: {
        filter_1: { id: "filter_1", name: "filter", props: { cutoff: 1000 } }
      }
    });

    expect(ui.observe("filter_1")?.props.cutoff).toBe(1000);
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

  it("clears only the sequenced field from live projection layers", () => {
    const ui = createWooClientFramework();
    ui.ingestWorld({
      objects: {
        delay_1: { id: "delay_1", name: "delay", props: { feedback: 0.25, wet: 0.1 } }
      }
    });

    ui.ingestLiveObservation({ type: "gesture_progress", target: "delay_1", name: "feedback", value: 0.8 });
    ui.ingestLiveObservation({ type: "gesture_progress", target: "delay_1", name: "wet", value: 0.6 });
    ui.ingestAppliedFrame({
      op: "applied",
      seq: 11,
      space: "the_dubspace",
      observations: [{ type: "control_changed", target: "delay_1", name: "feedback", value: 0.4 }]
    });

    expect(ui.observe("delay_1")?.props).toMatchObject({ feedback: 0.4, wet: 0.6 });
  });

  it("reduces dubspace control observations into object props", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:dubspace:the_dubspace", [
      { id: "slot_1", name: "Slot 1", props: { playing: false } },
      { id: "drum_1", name: "Drum", props: { playing: false, bpm: 118, pattern: { tone: [false, false, false, false, false, false, false, false] } } },
      { id: "delay_1", name: "Delay", props: { feedback: 0.2 } }
    ]);

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 12,
      space: "the_dubspace",
      observations: [
        { type: "loop_started", slot: "slot_1", loop_id: "slot_1" },
        { type: "tempo_changed", target: "drum_1", bpm: 140 },
        { type: "drum_step_changed", target: "drum_1", voice: "tone", step: 3, enabled: true, pattern: { tone: [false, false, false, true, false, false, false, false] } },
        { type: "transport_started", target: "drum_1", started_at: 1234, bpm: 140 }
      ]
    });

    expect(ui.observe("slot_1")?.props.playing).toBe(true);
    expect(ui.observe("drum_1")?.props).toMatchObject({ playing: true, bpm: 140, started_at: 1234 });
    expect((ui.observe("drum_1")?.props.pattern as any).tone[3]).toBe(true);

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 13,
      space: "the_dubspace",
      observations: [{ type: "scene_recalled", scene: "default_scene", controls: { delay_1: { feedback: 0.7 }, slot_1: { playing: false } } }]
    });

    expect(ui.observe("delay_1")?.props.feedback).toBe(0.7);
    expect(ui.observe("slot_1")?.props.playing).toBe(false);
  });

  it("reduces taskspace observations into task props and sparse tree/detail overlays", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:taskspace:the_taskspace", [
      { id: "the_taskspace", name: "Tasks", parent: "$taskspace", props: { root_tasks: [] } }
    ]);

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 21,
      space: "the_taskspace",
      observations: [
        { type: "task_created", task: "task_1", parent: null, title: "Ship scoped tasks" },
        { type: "task_claimed", task: "task_1", actor: "guest_1" },
        { type: "status_changed", task: "task_1", from: "claimed", to: "in_progress" },
        { type: "requirement_added", task: "task_1", index: 0, text: "renders without /api/state" },
        { type: "requirement_checked", task: "task_1", index: 0, checked: true },
        { type: "message_added", task: "task_1", actor: "guest_1", body: "wired", ts: 1234 }
      ]
    });

    expect(ui.observe("task_1")?.props).toMatchObject({
      title: "Ship scoped tasks",
      parent_task: null,
      assignee: "guest_1",
      status: "in_progress"
    });
    expect(ui.observe("the_taskspace")?.catalogState.taskspace_tree).toMatchObject({ task_1: null });
    expect(ui.observe("task_1")?.catalogState.taskspace_task).toMatchObject({
      "requirement:0": { text: "renders without /api/state", checked: false },
      "requirement_checked:0": true,
      "message:1234": { actor: "guest_1", body: "wired", ts: 1234 }
    });
  });

  it("ingests scoped snapshots without clearing unrelated scopes", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("here", [
      { id: "room_1", name: "Room", parent: "$room", ancestors: ["$thing", "$space", "$room"], props: { topic: "old" } },
      { id: "actor_1", name: "Guest 1", parent: "$guest", ancestors: ["$thing", "$actor", "$player", "$guest"] }
    ]);
    ui.ingestSnapshot("overlay:pinboard:board_1", [
      { id: "note_1", name: "Note", parent: "$note", ancestors: ["$thing", "$note"], catalogState: { pinboard_note: { x: 10, y: 20 } } }
    ]);

    ui.ingestSnapshot("here", [
      { id: "room_1", name: "Room", parent: "$room", ancestors: ["$thing", "$space", "$room"], props: { topic: "new" } }
    ]);

    expect(ui.observe("actor_1")).toBeUndefined();
    expect(ui.observe("room_1")?.props.topic).toBe("new");
    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ x: 10, y: 20 });
  });

  it("lets later full overlay summaries win over earlier thin duplicates", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "note_1", name: "Note", parent: "$pin", ancestors: ["$thing", "$note", "$pin"] },
      { id: "note_1", name: "Note", parent: "$pin", ancestors: ["$thing", "$note", "$pin"], props: { color: "green" }, catalogState: { pinboard_note: { color: "green" } } }
    ]);

    expect(ui.observe("note_1")?.props.color).toBe("green");
    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ color: "green" });
  });

  it("notifies projection subscribers for snapshot, optimistic, and prune changes", () => {
    const ui = createWooClientFramework();
    const values: Array<unknown> = [];
    ui.subscribe("note_1", (value) => values.push(value?.catalogState.pinboard_note ?? null));

    ui.ingestSnapshot("overlay:pinboard:board_1", [
      { id: "note_1", name: "Note", catalogState: { pinboard_note: { x: 10 } } }
    ]);
    ui.projection.applyOptimistic("drag:note_1", [
      { subject: "note_1", catalogState: { pinboard_note: { x: 30 } } }
    ], 1);
    ui.prune(Date.now() + 10);

    expect(values).toEqual([{ x: 10 }, { x: 30 }, { x: 10 }]);
  });

  it("reconciles optimistic patches by call id and explicit optimistic id", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:board_1", [
      { id: "note_1", name: "Note", catalogState: { pinboard_note: { x: 10, y: 10 } } }
    ]);

    ui.applyOptimisticCall("call-1", {
      optimistic: {
        id: "pinboard:note_1:placement",
        patches: [{ subject: "note_1", catalogState: { pinboard_note: { x: 40 } } }]
      }
    });
    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ x: 40, y: 10 });

    ui.completeOptimisticCall("call-1");
    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ x: 10, y: 10 });

    ui.applyOptimisticCall("call-2", {
      optimistic: {
        id: "pinboard:note_1:placement",
        patches: [{ subject: "note_1", catalogState: { pinboard_note: { y: 90 } } }],
        reconcile: "keep_until_changed"
      }
    });
    ui.completeOptimisticCall("call-2");
    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ x: 10, y: 90 });

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 12,
      space: "the_pinboard",
      observations: [{ type: "pin_moved", pin: "note_1", x: 12, y: 12 }]
    });
    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ x: 12, y: 12 });
  });

  it("does not let an older call clear a newer explicit optimistic layer", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:board_1", [
      { id: "note_1", name: "Note", catalogState: { pinboard_note: { x: 10 } } }
    ]);

    ui.applyOptimisticCall("call-1", {
      optimistic: {
        id: "pinboard:note_1:placement",
        patches: [{ subject: "note_1", catalogState: { pinboard_note: { x: 20 } } }]
      }
    });
    ui.applyOptimisticCall("call-2", {
      optimistic: {
        id: "pinboard:note_1:placement",
        patches: [{ subject: "note_1", catalogState: { pinboard_note: { x: 30 } } }]
      }
    });

    ui.completeOptimisticCall("call-1");
    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ x: 30 });

    ui.completeOptimisticCall("call-2");
    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ x: 10 });
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
