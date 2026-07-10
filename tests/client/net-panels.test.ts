// Phase iii (tool-space panels over net): the CATALOG reducers —
// pinboard, outliner, tasks — fed through wireNetFeed, the exact wiring
// src/client/main.ts connectNetFeed now installs. The adapter's parity
// with the v2 delivered shape is proven in net-feed-adapter.test.ts
// against the CORE handlers; this file proves the three PANEL surfaces:
// a peer's committed mutation arriving as a net fanout frame must
// produce the same projection state (pinboard/outliner) or refresh
// event (tasks) their components render from.
//
// The catalog UI modules define `class ... extends HTMLElement` at
// module scope, so the DOM globals are stubbed BEFORE the dynamic
// import — the reducers themselves are DOM-free (the kanban one guards
// its window dispatch).
import { beforeAll, describe, expect, it } from "vitest";
import { ClientProjection, ObservationRegistry } from "../../src/client/framework";
import { wireNetFeed, type NetFeedSource } from "../../src/client/net-feed-adapter";

type Emit = (event: { observation: Record<string, unknown>; source: "self" | "peer"; scope: string; seq: number | null; turn_id?: string }) => void;

/** A bare feed source (NetFeedSource is structural) + a wired registry. */
function wiredRegistry(register: (registry: ObservationRegistry) => void): { projection: ClientProjection; emit: Emit } {
  const projection = new ClientProjection();
  const registry = new ObservationRegistry(projection);
  register(registry);
  let handler: Parameters<NetFeedSource["onObservation"]>[0] = () => {};
  wireNetFeed({ observations: registry }, {
    onObservation: (fn) => {
      handler = fn;
      return () => {};
    }
  });
  return { projection, emit: (event) => handler(event) };
}

let pinboardHandlers: (registry: ObservationRegistry) => void;
let outlinerHandlers: (registry: ObservationRegistry) => void;
let tasksHandlers: (registry: ObservationRegistry) => void;
let windowStub: EventTarget;

beforeAll(async () => {
  (globalThis as Record<string, unknown>).HTMLElement ??= class {};
  windowStub = new EventTarget();
  (globalThis as Record<string, unknown>).window ??= windowStub;
  // The outliner reducer also fans the observation to MOUNTED tree
  // elements (document.querySelectorAll) — none exist here.
  (globalThis as Record<string, unknown>).document ??= { querySelectorAll: () => [] };
  pinboardHandlers = (await import("../../catalogs/pinboard/ui/pinboard-board")).registerWooObservationHandlers;
  outlinerHandlers = (await import("../../catalogs/outliner/ui/outliner-tree")).registerWooObservationHandlers;
  tasksHandlers = (await import("../../catalogs/tasks/ui/kanban-board")).registerWooObservationHandlers;
});

describe("net feed → catalog panel reducers (phase iii)", () => {
  it("a peer note_added renders into the pinboard projection (note state + board layout overlay)", () => {
    const { projection, emit } = wiredRegistry(pinboardHandlers);
    emit({
      observation: {
        type: "note_added",
        board: "the_pinboard",
        actor: "#bob",
        note: { id: "obj_note_1", name: "note", owner: "#bob", text: "hello from bob", color: "yellow", x: 32, y: 48, w: 200, h: 120 }
      },
      source: "peer",
      scope: "room:the_pinboard",
      seq: 7
    });
    const note = projection.observe("obj_note_1");
    expect(note?.catalogState?.pinboard_note).toMatchObject({ text: "hello from bob", color: "yellow", x: 32, y: 48 });
    const board = projection.observe("the_pinboard");
    expect((board?.catalogState?.pinboard_layout as Record<string, unknown>)?.obj_note_1).toMatchObject({ x: 32, y: 48 });
  });

  it("a peer note_moved and pinboard_entered/left presence reduce for co-present rendering", () => {
    const { projection, emit } = wiredRegistry(pinboardHandlers);
    emit({
      observation: { type: "note_moved", pin: "obj_note_1", board: "the_pinboard", x: 100, y: 200 },
      source: "peer",
      scope: "room:the_pinboard",
      seq: 8
    });
    expect(projection.observe("obj_note_1")?.catalogState?.pinboard_note).toMatchObject({ x: 100, y: 200 });
    emit({
      observation: { type: "pinboard_entered", board: "the_pinboard", actor: "#bob" },
      source: "peer",
      scope: "room:the_pinboard",
      seq: 9
    });
    expect((projection.observe("the_pinboard")?.catalogState?.pinboard_presence as Record<string, unknown>)?.["#bob"]).toBe(true);
    emit({
      observation: { type: "pinboard_left", board: "the_pinboard", actor: "#bob" },
      source: "peer",
      scope: "room:the_pinboard",
      seq: 10
    });
    expect((projection.observe("the_pinboard")?.catalogState?.pinboard_presence as Record<string, unknown>)?.["#bob"]).toBe(false);
  });

  it("a peer outline_item_added renders into the outliner projection (object + text/parent/position props)", () => {
    const { projection, emit } = wiredRegistry(outlinerHandlers);
    emit({
      observation: {
        type: "outline_item_added",
        outliner: "the_outline",
        actor: "#alice",
        item: "obj_item_1",
        text: "first item",
        parent_id: null,
        index: 0
      },
      source: "peer",
      scope: "room:the_outline",
      seq: 3
    });
    const item = projection.observe("obj_item_1");
    expect(item?.location).toBe("the_outline");
    expect(item?.props).toMatchObject({ text: "first item", position: 0, hidden: false });
  });

  it("a peer task_created dispatches the woo-tasks-refresh window event the kanban re-fetches on", async () => {
    const { emit } = wiredRegistry(tasksHandlers);
    const target = (globalThis as { window?: EventTarget }).window ?? windowStub;
    const received = new Promise<{ room?: string }>((resolve) => {
      target.addEventListener("woo-tasks-refresh", ((event: Event) => {
        resolve((event as CustomEvent<{ room?: string }>).detail ?? {});
      }) as EventListener, { once: true });
    });
    emit({
      observation: { type: "task_created", task: "obj_task_1", source: "the_taskboard" },
      source: "peer",
      scope: "room:the_taskboard",
      seq: 4
    });
    expect((await received).room).toBe("the_taskboard");
  });
});
