// @vitest-environment jsdom
// jsdom is needed because the imported catalog UI modules define
// HTMLElement-extending custom-element classes alongside their observation
// reducers. The reducers themselves are DOM-free.
import { describe, expect, it } from "vitest";

import chatManifest from "../catalogs/chat/manifest.json";
import dubspaceManifest from "../catalogs/dubspace/manifest.json";
import * as dubspaceUiModule from "../catalogs/dubspace/ui/dubspace-workspace";
import { registerWooObservationHandlers as registerDubspaceObservationHandlers } from "../catalogs/dubspace/ui/dubspace-workspace";
import { registerWooObservationHandlers as registerOutlinerObservationHandlers } from "../catalogs/outliner/ui/outliner-tree";
import { registerWooObservationHandlers as registerPinboardObservationHandlers } from "../catalogs/pinboard/ui/pinboard-board";
import {
  CatalogUiRegistry,
  clearDisplayTextCaches,
  CoalescedRefreshController,
  CoalescedViewHydrator,
  createWooClientFramework as createBareWooClientFramework,
  displayTextCacheKey,
  ProjectionFieldFiller,
  readDisplayTextCache,
  writeDisplayTextCache
} from "../src/client/framework";

// The framework constructor registers only catalog-agnostic observation
// reducers; pinboard and dubspace ship their own handlers via their UI
// modules. Tests that exercise those reductions opt in with this wrapper
// so each instance gets the bundled-catalog behavior the production client
// installs through CatalogUiRegistry.registerModuleExports.
function createWooClientFramework() {
  const ui = createBareWooClientFramework();
  registerDubspaceObservationHandlers(ui.observations);
  registerOutlinerObservationHandlers(ui.observations);
  registerPinboardObservationHandlers(ui.observations);
  return ui;
}

function v2SnapshotKey(scope: string, headSeq: number): string {
  return `v2:${scope}:${headSeq}`;
}

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
      { id: "note_1", name: "Note", catalogState: { pinboard_note: { text: "old", color: "yellow", x: 10, y: 20 } } }
    ]);

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 14,
      space: "the_pinboard",
      observations: [
        { type: "note_edited", note: "note_1", text: "new\ntext" },
        { type: "pin_recolored", pin: "note_1", color: "pink" }
      ]
    });

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({
      text: "new\ntext",
      color: "pink",
      x: 10,
      y: 20
    });
  });

  it("reduces note writer-list observations into note projections", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "note_1", name: "Note", catalogState: { pinboard_note: { text: "old", writers: [] } } }
    ]);

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 15,
      space: "the_pinboard",
      observations: [
        { type: "note_writers_changed", note: "note_1", writers: ["guest_2"], added: "guest_2", removed: null }
      ]
    });

    expect(ui.observe("note_1")?.props.writers).toEqual(["guest_2"]);
    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ writers: ["guest_2"] });
  });

  it("keeps optimistic pinboard text edits across stale overlay snapshots until applied confirmation", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "note_1", name: "Note", catalogState: { pinboard_note: { text: "old", color: "yellow" } } }
    ]);

    ui.applyOptimisticCall("call-1", {
      optimistic: {
        id: "pinboard:note_1:note",
        patches: [{ subject: "note_1", catalogState: { pinboard_note: { text: "draft" } } }]
      }
    });
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "note_1", name: "Note", catalogState: { pinboard_note: { text: "old", color: "yellow" } } }
    ]);

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ text: "draft", color: "yellow" });

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 15,
      space: "the_pinboard",
      observations: [{ type: "note_edited", note: "note_1", text: "draft" }]
    });
    ui.completeOptimisticCall("call-1");

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ text: "draft", color: "yellow" });
  });

  it("clears pinboard catalog state when a pin leaves the board", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "the_pinboard", name: "Board", props: { layout: { note_1: { x: 10, y: 20 } } } },
      { id: "note_1", name: "Note", catalogState: { pinboard_note: { text: "old", x: 10, y: 20 } } }
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
        note: { id: "note_1", name: "Note", text: "hello", x: 12, y: 24, w: 180, h: 110, z: 3 }
      }]
    });

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ text: "hello", x: 12, y: 24 });
    expect(ui.observe("the_pinboard")?.catalogState.pinboard_layout).toMatchObject({ note_1: { x: 12, y: 24, w: 180, h: 110, z: 3 } });
  });

  it("folds committed pinboard live fanout into canonical catalog state", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "the_pinboard", name: "Board", props: { layout: {} } }
    ]);

    // Co-present peers receive another user's committed board mutation as a live
    // event, not an applied frame. The pinboard reducer declares
    // liveProjection:"canonical", so this must survive live-layer pruning.
    ui.ingestLiveObservation({
      type: "note_added",
      board: "the_pinboard",
      pin: "note_live",
      note: { id: "note_live", name: "Live Note", text: "peer note", color: "pink", x: 18, y: 26, w: 160, h: 96, z: 5 }
    });

    expect(ui.observe("note_live")?.catalogState.pinboard_note).toMatchObject({ text: "peer note", color: "pink", x: 18, y: 26 });
    expect(ui.observe("the_pinboard")?.catalogState.pinboard_layout).toMatchObject({ note_live: { x: 18, y: 26, w: 160, h: 96, z: 5 } });

    ui.prune(Date.now() + 2_000);
    expect(ui.observe("note_live")?.catalogState.pinboard_note).toMatchObject({ text: "peer note", color: "pink", x: 18, y: 26 });
  });

  it("previews added pinboard notes from optimistic frames and rolls back on error", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "the_pinboard", name: "Board", props: { layout: {} } }
    ]);
    const frame = {
      id: "call-add-note",
      op: "result",
      space: "the_pinboard",
      observations: [{
        type: "note_added",
        board: "the_pinboard",
        pin: "note_optimistic",
        note: { id: "note_optimistic", name: "Note", text: "fast note", x: 12, y: 24, w: 180, h: 110, z: 3 }
      }]
    };

    ui.applyOptimisticFrame("call-add-note", frame);

    expect(ui.observe("note_optimistic")?.catalogState.pinboard_note).toMatchObject({ text: "fast note", x: 12, y: 24 });
    expect(ui.observe("the_pinboard")?.catalogState.pinboard_layout).toMatchObject({ note_optimistic: { x: 12, y: 24, w: 180, h: 110, z: 3 } });

    ui.failOptimisticCall("call-add-note");

    expect(ui.observe("note_optimistic")).toBeUndefined();
    expect(ui.observe("the_pinboard")?.catalogState.pinboard_layout).toBeUndefined();
  });

  it("keeps added pinboard notes after accepted frame clears the optimistic layer", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "the_pinboard", name: "Board", props: { layout: {} } }
    ]);
    const frame = {
      id: "call-add-note",
      op: "applied",
      seq: 21,
      space: "the_pinboard",
      observations: [{
        type: "note_added",
        board: "the_pinboard",
        pin: "note_accepted",
        note: { id: "note_accepted", name: "Note", text: "accepted note", x: 12, y: 24, w: 180, h: 110, z: 3 }
      }]
    };

    ui.applyOptimisticFrame("call-add-note", frame);
    ui.ingestAppliedFrame(frame);
    ui.completeOptimisticCall("call-add-note");

    expect(ui.observe("note_accepted")?.catalogState.pinboard_note).toMatchObject({ text: "accepted note", x: 12, y: 24 });
    expect(ui.observe("the_pinboard")?.catalogState.pinboard_layout).toMatchObject({ note_accepted: { x: 12, y: 24, w: 180, h: 110, z: 3 } });
  });

  it("previews added outliner rows from optimistic frames and rolls back on error", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot(v2SnapshotKey("the_outline", 0), [
      { id: "the_outline", name: "Outline", props: {} }
    ]);

    ui.applyOptimisticFrame("call-add-outline", {
      id: "call-add-outline",
      op: "result",
      space: "the_outline",
      observations: [{
        type: "outline_item_added",
        outliner: "the_outline",
        item: "outline_item_optimistic",
        parent_id: "outline_parent",
        index: 0,
        text: "fast row",
        actor: "guest_1"
      }]
    });

    expect(ui.refs()).toContain("outline_item_optimistic");
    expect(ui.observe("outline_item_optimistic")).toMatchObject({
      parent: "$outline_item",
      location: "the_outline",
      props: { text: "fast row", hidden: false },
      catalogState: { outliner_tree: { parent_id: "outline_parent", index: 0 } }
    });

    ui.failOptimisticCall("call-add-outline");

    expect(ui.observe("outline_item_optimistic")).toBeUndefined();
  });

  it("folds committed outliner live fanout into canonical projection", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot(v2SnapshotKey("the_outline", 0), [
      { id: "the_outline", name: "Outline", props: {} }
    ]);

    // Co-present peers receive committed structural mutations as live events.
    // The outliner reducer must apply them as canonical state rather than as an
    // expiring preview.
    ui.ingestLiveObservation({
      type: "outline_item_added",
      outliner: "the_outline",
      item: "outline_item_live",
      parent_id: null,
      index: 0,
      text: "peer row",
      actor: "guest_2"
    });

    expect(ui.observe("outline_item_live")).toMatchObject({
      parent: "$outline_item",
      location: "the_outline",
      props: { text: "peer row", hidden: false },
      catalogState: { outliner_tree: { parent_id: null, index: 0 } }
    });

    ui.prune(Date.now() + 2_000);
    expect(ui.observe("outline_item_live")).toMatchObject({
      parent: "$outline_item",
      location: "the_outline",
      props: { text: "peer row", hidden: false },
      catalogState: { outliner_tree: { parent_id: null, index: 0 } }
    });
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

  it("reduces generic property change observations into object props", () => {
    const ui = createWooClientFramework();
    ui.ingestWorld({
      objects: {
        the_chatroom: { id: "the_chatroom", name: "Living Room", props: { mood: "quiet", value: "old" } }
      }
    });

    ui.ingestAppliedFrame({
      op: "applied",
      seq: 22,
      space: "the_chatroom",
      observations: [
        { type: "property_changed", source: "the_chatroom", name: "mood", value: "busy" },
        { type: "value_changed", source: "the_chatroom", value: "new" }
      ]
    });

    expect(ui.observe("the_chatroom")?.props).toMatchObject({ mood: "busy", value: "new" });
  });

  it("keeps live generic property change observations after live-layer pruning", () => {
    const ui = createWooClientFramework();
    ui.ingestWorld({
      objects: {
        the_chatroom: { id: "the_chatroom", name: "Living Room", props: { mood: "quiet", value: "old" } }
      }
    });

    ui.ingestLiveObservation({ type: "property_changed", source: "the_chatroom", name: "mood", value: "busy" });
    ui.ingestLiveObservation({ type: "value_changed", source: "the_chatroom", value: "new" });
    ui.prune(Date.now() + 2_000);

    expect(ui.observe("the_chatroom")?.props).toMatchObject({ mood: "busy", value: "new" });
  });

  it("keeps live block_data observations after live-layer pruning", () => {
    const ui = createWooClientFramework();
    ui.ingestWorld({
      objects: {
        the_weather: { id: "the_weather", name: "Weather", props: { current: null } }
      }
    });

    ui.ingestLiveObservation({ type: "block_data", block: "the_weather", name: "current", value: { temp: 73, unit: "F" } });
    ui.prune(Date.now() + 2_000);

    expect(ui.observe("the_weather")?.props.current).toEqual({ temp: 73, unit: "F" });
  });

  it("ProjectionFieldFiller fetches when required props are missing even though the thin summary carries parent/ancestors", async () => {
    const ui = createWooClientFramework();
    // Mirrors the wire shape /api/me ships: parent/ancestors/aliases/description
    // but no props. fetchScopedObjectSummary's isCompleteScopedSummary shortcut
    // would treat this as "complete" — ProjectionFieldFiller must not.
    ui.ingestSnapshot("here", [
      { id: "the_chatroom", name: "Living Room", parent: "$chatroom", contents: ["the_weather"] },
      { id: "the_weather", name: "Weather panel", parent: "$weather_block", ancestors: ["$weather_block", "$block"], description: "A panel" }
    ]);

    let fetchCalls = 0;
    let resolves = 0;
    let requestedFields: readonly string[] = [];
    let pending: ((value: void) => void) | null = null;
    const filler = new ProjectionFieldFiller(
      (subject) => ui.observe(subject),
      (subject, fields) => {
        fetchCalls += 1;
        requestedFields = fields;
        return new Promise<void>((resolve) => {
          pending = () => {
            ui.ingestSnapshot(`summary:${subject}`, [
              {
                id: subject,
                name: "Weather panel",
                parent: "$weather_block",
                props: { current: { value: 72 }, config_state: { status: "confirmed" }, place: "Mountain View CA", last_error: null }
              }
            ]);
            resolve();
          };
        });
      },
      () => { resolves += 1; }
    );

    filler.ensure("the_weather", ["current", "config_state"]);
    expect(fetchCalls).toBe(1);
    expect(requestedFields).toEqual(["current", "config_state"]);
    // Concurrent re-bind while in flight: must dedupe to a single fetch.
    filler.ensure("the_weather", ["current", "config_state"]);
    expect(fetchCalls).toBe(1);

    pending!();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolves).toBe(1);
    expect(ui.observe("the_weather")?.props.current).toMatchObject({ value: 72 });

    // After completion, ensure is a no-op even if a (non-required) reset occurs.
    filler.ensure("the_weather", ["current", "config_state"]);
    expect(fetchCalls).toBe(1);
  });

  it("ProjectionFieldFiller skips the fetch when required props are already projected", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("here", [
      { id: "the_weather", name: "Weather panel", parent: "$weather_block", props: { current: { value: 65 }, config_state: { status: "confirmed" } } }
    ]);

    let fetchCalls = 0;
    const filler = new ProjectionFieldFiller(
      (subject) => ui.observe(subject),
      () => { fetchCalls += 1; return Promise.resolve(); }
    );

    filler.ensure("the_weather", ["current", "config_state"]);
    expect(fetchCalls).toBe(0);
  });

  it("ProjectionFieldFiller.reset() lets the next ensure refetch and discards pending stale fills", async () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("here", [
      { id: "the_weather", name: "Weather panel", parent: "$weather_block" }
    ]);

    let fetchCalls = 0;
    let resolves = 0;
    const pendings: Array<() => void> = [];
    const filler = new ProjectionFieldFiller(
      (subject) => ui.observe(subject),
      () => {
        fetchCalls += 1;
        return new Promise<void>((resolve) => { pendings.push(resolve); });
      },
      () => { resolves += 1; }
    );

    // Session A: fire a fill. It is in flight and uncompleted.
    filler.ensure("the_weather", ["current"]);
    expect(fetchCalls).toBe(1);

    // Session change. Pending fill from session A must not poison the new
    // session by marking the subject completed.
    filler.reset();
    pendings[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolves).toBe(0); // stale fill suppressed

    // Session B: ensure must re-fetch since the previous completion was
    // discarded by the reset.
    filler.ensure("the_weather", ["current"]);
    expect(fetchCalls).toBe(2);
    pendings[1]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolves).toBe(1);
  });

  it("ProjectionFieldFiller does not retry after a failed fetch in the same session", async () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("here", [
      { id: "the_weather", name: "Weather panel", parent: "$weather_block" }
    ]);

    let fetchCalls = 0;
    const filler = new ProjectionFieldFiller(
      (subject) => ui.observe(subject),
      () => { fetchCalls += 1; return Promise.reject(new Error("offline")); }
    );

    filler.ensure("the_weather", ["current"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchCalls).toBe(1);

    filler.ensure("the_weather", ["current"]);
    expect(fetchCalls).toBe(1);
  });

  it("CoalescedViewHydrator coalesces matching subject/signature reads and memoizes success", async () => {
    let reads = 0;
    const applied: string[] = [];
    let pending: ((value: string) => void) | null = null;
    const hydrator = new CoalescedViewHydrator<string>({
      read: (subject, signature) => {
        reads += 1;
        return new Promise((resolve) => {
          pending = () => resolve(`${subject}:${signature}`);
        });
      },
      apply: (value) => {
        applied.push(value);
      }
    });

    hydrator.ensure("the_outline", "item_1");
    hydrator.ensure("the_outline", "item_1");
    expect(reads).toBe(1);
    pending!("view");
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual(["the_outline:item_1"]);

    hydrator.ensure("the_outline", "item_1");
    expect(reads).toBe(1);
    hydrator.ensure("the_outline", "item_1|item_2");
    expect(reads).toBe(2);
  });

  it("CoalescedViewHydrator reset drops stale in-flight view results", async () => {
    let reads = 0;
    const applied: string[] = [];
    const pendings: Array<(value: string) => void> = [];
    const hydrator = new CoalescedViewHydrator<string>({
      read: (subject, signature) => {
        reads += 1;
        return new Promise((resolve) => {
          pendings.push(() => resolve(`${subject}:${signature}`));
        });
      },
      apply: (value) => {
        applied.push(value);
      }
    });

    hydrator.ensure("the_outline", "item_1");
    hydrator.reset();
    pendings[0]!("stale");
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([]);

    hydrator.ensure("the_outline", "item_1");
    expect(reads).toBe(2);
    pendings[1]!("fresh");
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual(["the_outline:item_1"]);
  });

  it("CoalescedViewHydrator backs off failed reads before retrying", async () => {
    let reads = 0;
    let now = 1_000;
    const errors: string[] = [];
    const applied: string[] = [];
    const hydrator = new CoalescedViewHydrator<string>({
      read: async (subject, signature) => {
        reads += 1;
        if (reads === 1) throw new Error("temporary view read failure");
        return `${subject}:${signature}`;
      },
      apply: (value) => {
        applied.push(value);
      },
      onError: (error) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
      now: () => now
    });

    hydrator.ensure("the_outline", "item_1");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    hydrator.ensure("the_outline", "item_1");
    expect(reads).toBe(1);
    now += 249;
    hydrator.ensure("the_outline", "item_1");
    expect(reads).toBe(1);
    now += 1;
    hydrator.ensure("the_outline", "item_1");
    await Promise.resolve();
    await Promise.resolve();

    expect(reads).toBe(2);
    expect(errors).toEqual(["temporary view read failure"]);
    expect(applied).toEqual(["the_outline:item_1"]);
  });

  it("CoalescedViewHydrator retries when applying a malformed result throws", async () => {
    let now = 1_000;
    let reads = 0;
    let applies = 0;
    const hydrator = new CoalescedViewHydrator<string>({
      read: async () => {
        reads += 1;
        return reads === 1 ? "malformed" : "valid";
      },
      apply: (value) => {
        applies += 1;
        if (value === "malformed") throw new Error("malformed catalog view");
      },
      now: () => now
    });

    hydrator.ensure("tool", "view");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    now += 250;
    hydrator.ensure("tool", "view");
    await Promise.resolve();
    await Promise.resolve();

    expect(reads).toBe(2);
    expect(applies).toBe(2);
  });

  it("CoalescedRefreshController collapses bursts to one queued follow-up", async () => {
    const runs: string[] = [];
    const releases: Array<() => void> = [];
    const controller = new CoalescedRefreshController({
      run: () => new Promise<void>((resolve) => {
        runs.push(`run-${runs.length + 1}`);
        releases.push(resolve);
      })
    });

    controller.request();
    controller.request();
    controller.request();
    expect(runs).toEqual(["run-1"]);

    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toEqual(["run-1", "run-2"]);

    releases.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toEqual(["run-1", "run-2"]);
  });

  it("CoalescedRefreshController recovers when run() throws synchronously", async () => {
    let runs = 0;
    let nextThrows = true;
    const controller = new CoalescedRefreshController({
      run: () => {
        runs += 1;
        if (nextThrows) { nextThrows = false; throw new Error("sync boom"); }
      }
    });

    // A synchronous throw must not escape request() nor wedge running=true.
    expect(() => controller.request()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(1);

    // Controller is still usable for the next request.
    controller.request();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(2);
  });

  it("CoalescedRefreshController gates lifecycle refreshes by key", async () => {
    let runs = 0;
    let runnable = true;
    const controller = new CoalescedRefreshController({
      canRun: () => runnable,
      run: async () => { runs += 1; }
    });

    controller.requestOnce("the_taskboard\0guest_1\0the_taskboard");
    await Promise.resolve();
    controller.requestOnce("the_taskboard\0guest_1\0the_taskboard");
    await Promise.resolve();
    expect(runs).toBe(1);

    controller.requestOnce("the_taskboard\0guest_2\0the_taskboard");
    await Promise.resolve();
    expect(runs).toBe(2);

    controller.resetOnceKey();
    controller.requestOnce("the_taskboard\0guest_2\0the_taskboard");
    await Promise.resolve();
    expect(runs).toBe(3);

    runnable = false;
    controller.request();
    await Promise.resolve();
    expect(runs).toBe(3);

    controller.requestOnce("the_taskboard\0guest_3\0the_taskboard");
    await Promise.resolve();
    expect(runs).toBe(3);
    runnable = true;
    controller.requestOnce("the_taskboard\0guest_3\0the_taskboard");
    await Promise.resolve();
    expect(runs).toBe(4);
  });

  it("fills missing component-required props when a per-subject summary lands after a thin room snapshot", () => {
    const ui = createWooClientFramework();
    // Fresh viewer: room snapshot ships thin contents (no props) — mirrors
    // what /api/me's here.contents carries.
    ui.ingestSnapshot("here", [
      { id: "the_chatroom", name: "Living Room", parent: "$chatroom", contents: ["the_weather"] },
      { id: "the_weather", name: "Weather panel", parent: "$weather_block", location: "the_chatroom" }
    ]);

    expect(ui.observe("the_weather")?.props).toEqual({});

    // ensureProjectionFields' on-bind fill folds a full /api/objects/<id>/summary
    // into a per-subject snapshot scope. Same path used by navigation summaries.
    ui.ingestSnapshot("summary:the_weather", [
      {
        id: "the_weather",
        name: "Weather panel",
        parent: "$weather_block",
        location: "the_chatroom",
        props: {
          place: "Mountain View CA",
          current: { kind: "scalar", value: 72.4, unit: "°F", weather_code: 1000 },
          config_state: { status: "confirmed", message: "weather plug confirmed location and timezone" }
        }
      }
    ]);

    const projected = ui.observe("the_weather");
    expect(projected?.props.current).toMatchObject({ value: 72.4, unit: "°F" });
    expect(projected?.props.config_state).toMatchObject({ status: "confirmed" });
    // Live block_data observations from then on top up the same projection.
    ui.ingestLiveObservation({ type: "block_data", block: "the_weather", name: "current", value: { kind: "scalar", value: 65, unit: "°F" } });
    expect(ui.observe("the_weather")?.props.current).toMatchObject({ value: 65 });
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

    ui.applyCanonical([{ subject: "note_1", catalogState: { pinboard_note: { text: "hydrated", color: "green" } } }]);
    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ text: "hydrated", color: "green" });

    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "note_1", name: "Note", parent: "$pin", catalogState: { pinboard_note: { color: "green" } } }
    ]);

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ text: "hydrated", color: "green" });
  });

  it("clears authoritative patches so removed scoped objects do not ghost", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "the_pinboard", name: "Board", props: { layout: { note_1: { x: 10, y: 20 } } } },
      { id: "note_1", name: "Note", parent: "$pin", catalogState: { pinboard_note: { color: "green" } } }
    ]);
    ui.applyCanonical([{ subject: "note_1", catalogState: { pinboard_note: { text: "hydrated", color: "green" } } }]);

    ui.ingestSnapshot("overlay:pinboard:the_pinboard", [
      { id: "the_pinboard", name: "Board", props: { layout: {} } }
    ]);
    expect(ui.observe("note_1")?.catalogState.pinboard_note).toMatchObject({ text: "hydrated", color: "green" });

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

    ui.applyCanonical([{ subject: "note_1", catalogState: { pinboard_note: { text: "old", color: "yellow" } } }], { mode: "replace" });
    ui.applyCanonical([{ subject: "note_1", catalogState: { pinboard_note: { text: "new" } } }], { mode: "replace" });

    expect(ui.observe("note_1")?.catalogState.pinboard_note).toEqual({ text: "new" });
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

  it("reduces take and drop observations into object location fields", () => {
    const ui = createWooClientFramework();
    ui.ingestSnapshot("here", [
      { id: "the_chatroom", name: "Living Room" },
      { id: "the_towel", name: "towel", location: "the_chatroom" }
    ]);

    ui.ingestLiveObservation({ type: "taken", actor: "guest_1", item: "the_towel", title: "towel" });
    expect(ui.observe("the_towel")?.location).toBe("guest_1");

    ui.ingestLiveObservation({ type: "dropped", actor: "guest_1", item: "the_towel", title: "towel", room: "the_chatroom" });
    expect(ui.observe("the_towel")?.location).toBe("the_chatroom");
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

  it("resolves a frame-declared catalog view hydration from its module", () => {
    const ui = createBareWooClientFramework();
    expect(ui.catalogUi.installCatalogUi({
      alias: "dubspace",
      catalog: "dubspace",
      objects: { "$dubspace": "$dubspace" },
      ui: (dubspaceManifest as any).ui
    })).toEqual([]);
    ui.catalogUi.registerModuleExports("dubspace", "dubspace-ui", dubspaceUiModule, ui.observations, ui.chatFormatters);

    const frame = ui.catalogUi.resolveFrame("$dubspace", undefined, () => false);
    expect(frame?.frame.hydration).toEqual({ module: "dubspace-ui", id: "controls" });
    expect(ui.catalogUi.viewHydration(frame)?.id).toBe("dubspace:dubspace-ui:controls");
  });
});

describe("display-text cache (read-gated, principal-namespaced)", () => {
  it("refuses to produce a key without an actor (cache disabled)", () => {
    expect(displayTextCacheKey("outliner", null, "the_outline")).toBe("");
    expect(displayTextCacheKey("outliner", undefined, "the_outline")).toBe("");
    expect(displayTextCacheKey("outliner", "guest_1", "")).toBe("");
    expect(displayTextCacheKey("outliner", "guest_1", "the_outline")).toBe("woo.outliner.text.guest_1.the_outline");
  });

  it("isolates one principal's cached text from another", () => {
    localStorage.clear();
    const a = displayTextCacheKey("outliner", "guest_1", "the_outline");
    const b = displayTextCacheKey("outliner", "guest_2", "the_outline");
    writeDisplayTextCache(a, { item_1: "secret for guest_1" });
    // A different principal reading the same subject sees nothing.
    expect(readDisplayTextCache(b)).toEqual({});
    expect(readDisplayTextCache(a)).toEqual({ item_1: "secret for guest_1" });
  });

  it("purges every display-text cache on session teardown but leaves other keys", () => {
    localStorage.clear();
    writeDisplayTextCache(displayTextCacheKey("outliner", "guest_1", "the_outline"), { i: "x" });
    writeDisplayTextCache(displayTextCacheKey("pinboard", "guest_1", "the_pinboard"), { n: "y" });
    localStorage.setItem("woo.session", "keep-me");
    clearDisplayTextCaches();
    expect(readDisplayTextCache(displayTextCacheKey("outliner", "guest_1", "the_outline"))).toEqual({});
    expect(readDisplayTextCache(displayTextCacheKey("pinboard", "guest_1", "the_pinboard"))).toEqual({});
    expect(localStorage.getItem("woo.session")).toBe("keep-me");
  });
});
