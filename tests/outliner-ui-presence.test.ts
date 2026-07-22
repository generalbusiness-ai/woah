// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WooOutlinerTreeElement,
  registerWooObservationHandlers,
  registerWooViews,
  type OutlinerData
} from "../catalogs/outliner/ui/outliner-tree";
import outlinerManifest from "../catalogs/outliner/manifest.json";
import { createWooClientFramework, type WooClientFramework, type WooContext } from "../src/client/framework";

// jsdom render tests for the presence aside introduced by outliner-presence.
// These pin (a) the .outliner-presence aside exists inside .outliner-layout,
// (b) actors come through as <button> entries inside .presence-list, and
// (c) the empty roster falls back to the same "No one is here." placeholder
// shape as chat-presence / tasks-presence.

let viewFramework: WooClientFramework;
let deliveredSeq = 1;

function deliver(...observations: Record<string, unknown>[]): void {
  viewFramework.ingestAppliedFrame({ seq: deliveredSeq++, space: "the_outline", observations });
}

function ctx(names: Record<string, string> = {}, options: { refs?: string[]; projections?: Record<string, any>; directCall?: WooContext["directCall"] } = {}): WooContext {
  const context: WooContext = {
    actor: "guest_1",
    frame: { id: "frame", subject: "the_outline", get: () => undefined, set: () => true },
    neighborhood: { subject: "the_outline", refs: options.refs ?? [], related: {}, has: () => true },
    observe: (ref) => options.projections?.[ref] ?? ({ id: ref, name: names[ref] ?? ref, props: {}, catalogState: {} }),
    directCall: async (target, verb, args, callOptions) => {
      const result = await (options.directCall ?? (async () => undefined))(target, verb, args, callOptions);
      // Most historical fixtures return the old tree_view array directly.
      // Keep their row data focused while exercising the real tree_view parser.
      return verb === "tree_view" && Array.isArray(result)
        ? { items: result, structure_at_seq: 0 }
        : result;
    },
    send: async () => undefined,
    call: async () => undefined,
    view: (request) => viewFramework.view(context.actor, context, request),
    emit: () => true
  };
  return context;
}

async function flushPromises(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe("outliner-tree presence aside", () => {
  beforeAll(() => {
    if (!customElements.get("woo-outliner-tree")) {
      customElements.define("woo-outliner-tree", WooOutlinerTreeElement);
    }
  });

  beforeEach(() => {
    document.body.innerHTML = "";
    viewFramework = createWooClientFramework();
    deliveredSeq = 1;
    viewFramework.catalogUi.installCatalogUi({ alias: "outliner", catalog: "outliner", ui: (outlinerManifest as any).ui });
    registerWooViews({ view: (definition) => viewFramework.catalogUi.defineView("outliner", definition) });
    registerWooObservationHandlers(viewFramework.observations);
    // The outliner persists known item text to localStorage (display accelerator
    // for cold reloads); clear it so cached text from one case can't leak into
    // another's projection-fill.
    globalThis.localStorage?.clear();
  });

  // Two-actor roster — names come from the row, not the projection, so the
  // button label is what the server-side room_roster reported.
  it("renders one .presence-list button per roster row", () => {
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { data: OutlinerData };
    element.woo = ctx();
    document.body.append(element);
    element.data = {
      outlinerId: "the_outline",
      outlinerName: "Outline",
      items: [],
      focus: null,
      actor: "guest_1",
      roster: [
        { id: "guest_1", name: "Guest One", presence: "online" },
        { id: "guest_2", name: "Guest Two", presence: "online" }
      ]
    };

    const aside = element.querySelector(".outliner-presence");
    expect(aside, "outliner-presence aside present").not.toBeNull();
    expect(aside?.querySelector("h2")?.textContent).toBe("Presence");

    const buttons = aside?.querySelectorAll(".presence-list button") ?? [];
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toContain("Guest One");
    expect(buttons[0].textContent).toContain("guest_1");
    expect(buttons[1].textContent).toContain("Guest Two");
  });

  // Empty roster fallback — the placeholder text is the same "No one is
  // here." shape as chat-presence and tasks-presence.
  it("falls back to a placeholder when the roster is empty", () => {
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { data: OutlinerData };
    element.woo = ctx();
    document.body.append(element);
    element.data = {
      outlinerId: "the_outline",
      outlinerName: "Outline",
      items: [],
      focus: null,
      actor: "guest_1",
      roster: []
    };

    const aside = element.querySelector(".outliner-presence");
    expect(aside, "presence aside still renders with empty roster").not.toBeNull();
    expect(aside?.querySelector(".presence-list")?.textContent).toContain("No one is here");
  });

  it("hydrates the authoritative roster when the companion opens after entry", async () => {
    const directCall = vi.fn(async (_subject: string, verb: string) => {
      if (verb === "room_roster") {
        return [{ id: "guest_1", name: "Guest One", presence: "online" }];
      }
      return [];
    });
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & {
      entering: boolean;
      showCompanion: boolean;
      subject: string;
    };
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: ["the_outline"],
      projections: {
        the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} }
      },
      directCall
    });
    document.body.append(element);

    element.entering = true;
    element.showCompanion = true;
    await flushPromises();
    expect(directCall.mock.calls.filter((call) => call[1] === "room_roster")).toHaveLength(0);

    element.entering = false;
    await flushPromises();

    expect(directCall).toHaveBeenCalledWith("the_outline", "room_roster", [], { serverRead: true });
    expect(element.querySelector(".presence-list")?.textContent).toContain("Guest One");
  });

  it("shows the present actor and retries when the first roster read fails", async () => {
    const directCall = vi.fn(async (_subject: string, verb: string) => {
      if (verb === "room_roster") throw new Error("owner projection not ready");
      return [];
    });
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & {
      showCompanion: boolean;
      subject: string;
    };
    element.subject = "the_outline";
    element.woo = ctx({ guest_1: "Guest One" }, {
      refs: ["the_outline"],
      projections: {
        the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} },
        guest_1: { id: "guest_1", name: "Guest One", props: {}, catalogState: {} }
      },
      directCall
    });
    document.body.append(element);

    element.showCompanion = true;
    await flushPromises();

    expect(element.querySelector(".presence-list")?.textContent).toContain("Guest One");
    expect(element.querySelector(".presence-list")?.textContent).not.toContain("No one is here");
    // Cancel the bounded retry timer so this test cannot leak work into the
    // following jsdom case.
    element.showCompanion = false;
  });

  // The presence aside sits as the right column inside .split.split--side-fixed
  // .outliner-layout — same shape chat-layout / dubspace-layout use. The
  // split primitive is what gives the aside its fixed 240px width.
  it("wraps the tree + aside in .split.split--side-fixed.outliner-layout", () => {
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { data: OutlinerData };
    element.woo = ctx();
    document.body.append(element);
    element.data = {
      outlinerId: "the_outline",
      outlinerName: "Outline",
      items: [],
      focus: null,
      actor: "guest_1",
      roster: []
    };

    const split = element.querySelector(".split.split--side-fixed.outliner-layout");
    expect(split, "outliner uses the shared side-fixed split layout").not.toBeNull();
    expect(split?.querySelector(".outliner"), "main column is the outline tree").not.toBeNull();
    expect(split?.querySelector(".outliner-presence"), "side column is the presence aside").not.toBeNull();
  });

  // Regression: the mini-chat panel must anchor to the viewport bottom the
  // same way it does in pinboard / dubspace / tasks. Those tools render their
  // toolbar OUTSIDE the .ambient-companion-shell so the shell's
  // `height: calc(100dvh - 5.25rem)` budget aligns with the chrome above it.
  // If the outliner header slips back inside the shell, the chat panel ends
  // up floating ~3rem above the viewport bottom. Pin that structurally:
  // .outliner-header must be a sibling of .ambient-companion-shell, not a
  // descendant.
  it("renders the toolbar outside the ambient-companion-shell so the mini-chat anchors to the viewport bottom", () => {
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { data: OutlinerData; showCompanion: boolean };
    element.woo = ctx();
    element.showCompanion = true;
    document.body.append(element);
    element.data = {
      outlinerId: "the_outline",
      outlinerName: "Outline",
      items: [],
      focus: null,
      actor: "guest_1",
      roster: []
    };

    // Outliner uses the shared .toolbar/h1 envelope just like
    // pinboard / dubspace / tasks — that's what makes the chat panel
    // anchor identically across tools. See renderToolFrame in
    // src/client/framework.ts.
    const toolbar = element.querySelector(".toolbar.outliner-toolbar");
    const shell = element.querySelector(".ambient-companion-shell");
    expect(toolbar, "toolbar is rendered with the shared .toolbar class").not.toBeNull();
    expect(toolbar?.querySelector("h1"), "title uses h1 (matches other tools)").not.toBeNull();
    expect(shell, "ambient-companion-shell is rendered when companion visible").not.toBeNull();
    expect(shell?.contains(toolbar), "toolbar must NOT be a descendant of the shell — keep it as a sibling so the shell's calc(100dvh - 5.25rem) lines up").toBe(false);
  });

  it("renders projection refs immediately and verifies the complete tree with tree_view", async () => {
    const directCall = vi.fn(async () => [{
      id: "item_1",
      name: "item_1",
      text: "projection row",
      parent_id: null,
      index: 0,
      hidden: false,
      owner: "guest_1",
      writers: [],
      has_children: false
    }]);
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { hydrate: () => Promise<void>; subject: string };
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: ["the_outline", "item_1", "guest_1"],
      directCall,
      projections: {
        the_outline: { id: "the_outline", name: "Outline", props: { session_subscribers: [{ actor: "guest_1" }] }, catalogState: {} },
        item_1: {
          id: "item_1",
          name: "item_1",
          parent: "$outline_item",
          ancestors: ["$note", "$outline_item"],
          owner: "guest_1",
          location: "the_outline",
          props: { text: "projection row", parent: null, position: 1, hidden: false },
          catalogState: {}
        },
        guest_1: { id: "guest_1", name: "Guest One", props: {}, catalogState: {} }
      }
    });
    document.body.append(element);

    await element.hydrate();
    await flushPromises();

    expect(directCall).toHaveBeenCalledTimes(1);
    expect(directCall).toHaveBeenCalledWith("the_outline", "tree_view", [], { serverRead: true });
    expect(element.querySelector("[data-outliner-row]")?.textContent).toContain("projection row");
    expect(element.querySelector(".presence-list")?.textContent).toContain("Guest One");
  });

  it("hydrates item text from tree_view when projection refs carry default-empty note text", async () => {
    const directCall = vi.fn(async (subject: string, verb: string) => {
      expect(subject).toBe("the_outline");
      expect(verb).toBe("tree_view");
      return [
        {
          id: "item_1",
          name: "item_1",
          text: "server joined text",
          parent_id: null,
          index: 0,
          hidden: false,
          owner: "guest_1",
          writers: [],
          has_children: false
        }
      ];
    });
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { hydrate: () => Promise<void>; subject: string };
    document.body.append(element);
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: ["the_outline", "item_1"],
      directCall,
      projections: {
        the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} },
        item_1: {
          id: "item_1",
          name: "item_1",
          parent: "$outline_item",
          ancestors: ["$note", "$outline_item"],
          owner: "guest_1",
          location: "the_outline",
          props: { text: "", parent: null, position: 1, hidden: false },
          catalogState: {}
        }
      }
    });

    await element.hydrate();
    await flushPromises();

    expect(directCall).toHaveBeenCalledTimes(1);
    expect(element.querySelector("[data-outliner-row]")?.textContent).toContain("server joined text");
    expect(element.querySelector("[data-outliner-row]")?.textContent).not.toContain("(empty)");
  });

  it("paints cached item text immediately on a cold load while the tree_view read is still in flight", async () => {
    // Simulate a prior session (same actor guest_1) having stashed the readable
    // text. The cache key is namespaced by the viewing actor — a different
    // principal must not read it.
    globalThis.localStorage.setItem(
      "woo.outliner.text.guest_1.the_outline",
      JSON.stringify({ item_1: "cached readable text" })
    );
    // Hold the hydration read open so we observe the pre-hydration paint.
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const directCall = vi.fn(async (_subject: string, verb: string) => {
      if (verb === "tree_view") await readGate;
      return [
        { id: "item_1", name: "item_1", text: "authoritative text", parent_id: null, index: 0, hidden: false, owner: "guest_1", writers: [], has_children: false }
      ];
    });
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { hydrate: () => Promise<void>; subject: string };
    document.body.append(element);
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: ["the_outline", "item_1"],
      directCall,
      projections: {
        the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} },
        item_1: {
          id: "item_1",
          name: "item_1",
          parent: "$outline_item",
          ancestors: ["$note", "$outline_item"],
          owner: "guest_1",
          location: "the_outline",
          props: { text: "", parent: null, position: 1, hidden: false },
          catalogState: {}
        }
      }
    });

    await element.hydrate();
    await flushPromises();

    // Before the read resolves, the row already shows the cached text, not "(empty)".
    expect(directCall).toHaveBeenCalledTimes(1);
    expect(element.querySelector("[data-outliner-row]")?.textContent).toContain("cached readable text");
    expect(element.querySelector("[data-outliner-row]")?.textContent).not.toContain("(empty)");

    // The authoritative read still runs and overwrites the cached value.
    releaseRead();
    await flushPromises();
    expect(element.querySelector("[data-outliner-row]")?.textContent).toContain("authoritative text");
  });

  it("does not delete the display cache when a sync runs before the projection has loaded any items", async () => {
    // Regression: on a cold reload the first sync runs before the item projection
    // arrives, so the model is momentarily empty. Writing an empty map then would
    // delete this actor's cache (empty map == clear), wiping the text we want to
    // paint. The empty-model guard must leave the cache intact.
    const key = "woo.outliner.text.guest_1.the_outline";
    globalThis.localStorage.setItem(key, JSON.stringify({ item_1: "cached readable text" }));
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { hydrate: () => Promise<void>; subject: string };
    document.body.append(element);
    element.subject = "the_outline";
    // No item refs in the neighborhood yet — the model stays empty this sync.
    element.woo = ctx({}, {
      refs: ["the_outline"],
      directCall: vi.fn(async () => []),
      projections: { the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} } }
    });
    await element.hydrate();
    await flushPromises();
    const stored = globalThis.localStorage.getItem(key);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored ?? "{}")).toEqual({ item_1: "cached readable text" });
  });

  it("does not replace observation-sourced item text with a projection row that omits text", () => {
    const directCall = vi.fn(async () => []);
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { data: OutlinerData; syncFromProjection: () => void; subject: string };
    document.body.append(element);
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: ["the_outline", "item_1"],
      directCall,
      projections: {
        the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} },
        item_1: {
          id: "item_1",
          name: "item_1",
          parent: "$outline_item",
          ancestors: ["$note", "$outline_item"],
          owner: "guest_1",
          location: "the_outline",
          props: { parent: null, position: 1, hidden: false },
          catalogState: {}
        }
      }
    });
    element.data = {
      outlinerId: "the_outline",
      outlinerName: "Outline",
      items: [
        { id: "item_1", name: "item_1", text: "observation text", parent_id: null, index: 0, hidden: false, owner: "guest_1", writers: [], has_children: false }
      ],
      focus: null,
      actor: "guest_1",
      roster: []
    };

    element.syncFromProjection();

    expect(directCall).toHaveBeenCalledTimes(1);
    expect(element.querySelector("[data-outliner-row]")?.textContent).toContain("observation text");
    expect(element.querySelector("[data-outliner-row]")?.textContent).not.toContain("(empty)");
  });

  it("hydrates authoritative rows when the initial projection is empty", async () => {
    const directCall = vi.fn(async () => [
      {
        id: "item_1",
        name: "item_1",
        text: "late projection text",
        parent_id: null,
        index: 0,
        hidden: false,
        owner: "guest_1",
        writers: [],
        has_children: false
      }
    ]);
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { hydrate: () => Promise<void>; syncFromProjection: () => void; subject: string };
    document.body.append(element);
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: ["the_outline"],
      projections: {
        the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} }
      },
      directCall
    });

    await element.hydrate();
    await flushPromises();

    expect(directCall).toHaveBeenCalledTimes(1);
    expect(element.querySelector("[data-outliner-row]")?.textContent).toContain("late projection text");
    expect(element.querySelector("[data-outliner-row]")?.textContent).not.toContain("(empty)");
  });

  it("replaces a partial projection with the complete authoritative tree", async () => {
    const authoritative = [
      { id: "root_1", name: "root_1", text: "root one", parent_id: null, index: 0, hidden: false, owner: "guest_1", writers: [], has_children: true },
      { id: "child_1", name: "child_1", text: "child one", parent_id: "root_1", index: 0, hidden: false, owner: "guest_1", writers: [], has_children: false },
      { id: "root_2", name: "root_2", text: "root two", parent_id: null, index: 1, hidden: false, owner: "guest_1", writers: [], has_children: false },
      { id: "root_3", name: "root_3", text: "root three", parent_id: null, index: 2, hidden: false, owner: "guest_1", writers: [], has_children: false },
      { id: "root_4", name: "root_4", text: "root four", parent_id: null, index: 3, hidden: false, owner: "guest_1", writers: [], has_children: false }
    ];
    const projections: Record<string, any> = {
      the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} }
    };
    for (const row of authoritative.slice(0, 3)) {
      projections[row.id] = {
        id: row.id,
        name: row.name,
        parent: "$outline_item",
        ancestors: ["$note", "$outline_item"],
        owner: row.owner,
        location: "the_outline",
        props: { text: row.text, hidden: false },
        catalogState: {}
      };
    }
    const directCall = vi.fn(async () => authoritative);
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { hydrate: () => Promise<void>; subject: string };
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: ["the_outline", "root_1", "child_1", "root_2"],
      projections,
      directCall
    });
    document.body.append(element);

    await element.hydrate();
    await flushPromises();

    const rows = element.querySelectorAll<HTMLElement>("[data-outliner-row]");
    expect(rows).toHaveLength(5);
    expect(element.querySelector<HTMLElement>('[data-id="child_1"]')?.style.getPropertyValue("--indent")).toBe("20px");
  });

  it("does not let an old structural projection overwrite an authoritative list", async () => {
    const authoritative = [
      { id: "item_2", name: "item_2", text: "second moved first", parent_id: null, index: 0, hidden: false, owner: "guest_1", writers: [], has_children: false },
      { id: "item_1", name: "item_1", text: "first moved second", parent_id: null, index: 1, hidden: false, owner: "guest_1", writers: [], has_children: false }
    ];
    const projection = (id: string, index: number) => ({
      id,
      name: id,
      parent: "$outline_item",
      ancestors: ["$note", "$outline_item"],
      owner: "guest_1",
      location: "the_outline",
      props: { text: id, hidden: false },
      // This stamp represents the observation-time ordering before a peer
      // reorder. It remains in generic projection after tree_view returns.
      catalogState: { outliner_tree: { parent_id: null, index } }
    });
    const directCall = vi.fn(async () => authoritative);
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & {
      hydrate: () => Promise<void>;
      syncFromProjection: () => void;
      subject: string;
    };
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: ["item_1", "item_2"],
      directCall,
      projections: {
        the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} },
        item_1: projection("item_1", 0),
        item_2: projection("item_2", 1)
      }
    });
    document.body.append(element);

    await element.hydrate();
    await flushPromises();
    expect([...element.querySelectorAll<HTMLElement>("[data-outliner-row]")].map((row) => row.dataset.id)).toEqual(["item_2", "item_1"]);

    // main.ts invokes this again on every SPA render. The unversioned old
    // catalogState must not reassert its pre-reorder indexes.
    element.syncFromProjection();
    expect([...element.querySelectorAll<HTMLElement>("[data-outliner-row]")].map((row) => row.dataset.id)).toEqual(["item_2", "item_1"]);
    expect(directCall).toHaveBeenCalledTimes(1);
  });

  it("renders an observed child from catalog projection state before authoritative hydration completes", async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const directCall = vi.fn(async () => {
      await readGate;
      return [
        { id: "root_1", name: "root_1", text: "root", parent_id: null, index: 0, hidden: false, owner: "guest_1", writers: [], has_children: true },
        { id: "child_1", name: "child_1", text: "child", parent_id: "root_1", index: 0, hidden: false, owner: "guest_1", writers: [], has_children: false }
      ];
    });
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { hydrate: () => Promise<void>; subject: string };
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: ["root_1", "child_1"],
      directCall,
      projections: {
        the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} },
        root_1: {
          id: "root_1",
          name: "root_1",
          parent: "$outline_item",
          ancestors: ["$note", "$outline_item"],
          owner: "guest_1",
          location: "the_outline",
          props: { text: "root", hidden: false },
          catalogState: { outliner_tree: { parent_id: null, index: 0 } }
        },
        child_1: {
          id: "child_1",
          name: "child_1",
          parent: "$outline_item",
          ancestors: ["$note", "$outline_item"],
          owner: "guest_1",
          location: "the_outline",
          props: { text: "child", hidden: false },
          catalogState: { outliner_tree: { parent_id: "root_1", index: 0 } }
        }
      }
    });
    document.body.append(element);

    await element.hydrate();
    await flushPromises();

    expect(element.querySelector<HTMLElement>('[data-id="child_1"]')?.style.getPropertyValue("--indent")).toBe("20px");
    releaseRead();
    await flushPromises();
  });

  it("ignores an older hydration read after a structural observation advances the tree", async () => {
    let releaseInitial!: () => void;
    const initialGate = new Promise<void>((resolve) => { releaseInitial = resolve; });
    let calls = 0;
    const directCall = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        await initialGate;
        return [];
      }
      return [
        { id: "root_1", name: "root_1", text: "root", parent_id: null, index: 0, hidden: false, owner: "guest_1", writers: [], has_children: true },
        { id: "child_1", name: "child_1", text: "child", parent_id: "root_1", index: 0, hidden: false, owner: "guest_1", writers: [], has_children: false }
      ];
    });
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & {
      applyObservation: (observation: Record<string, unknown>) => void;
      hydrate: () => Promise<void>;
      subject: string;
    };
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: [],
      directCall,
      projections: {
        the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} }
      }
    });
    document.body.append(element);
    await element.hydrate();
    await flushPromises();

    deliver({
      type: "outline_item_added",
      outliner: "the_outline",
      item: "child_1",
      parent_id: "root_1",
      index: 0,
      text: "child",
      actor: "guest_1"
    });
    await flushPromises();
    expect(directCall).toHaveBeenCalledTimes(1);

    releaseInitial();
    await flushPromises();
    expect(directCall).toHaveBeenCalledTimes(2);

    expect(element.querySelectorAll("[data-outliner-row]")).toHaveLength(2);
    expect(element.querySelector<HTMLElement>('[data-id="child_1"]')?.style.getPropertyValue("--indent")).toBe("20px");
  });

  it("does not classify unrelated projected objects as outline rows by props alone", async () => {
    const directCall = vi.fn(async () => []);
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { hydrate: () => Promise<void>; subject: string };
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: ["not_an_outline_item"],
      directCall,
      projections: {
        not_an_outline_item: {
          id: "not_an_outline_item",
          name: "positioned thing",
          parent: "$thing",
          ancestors: ["$thing"],
          location: "the_outline",
          props: { position: 1, hidden: false, text: "not a row" },
          catalogState: {}
        }
      }
    });
    document.body.append(element);

    await element.hydrate();

    expect(directCall).toHaveBeenCalledTimes(1);
    expect(element.querySelector("[data-outliner-row]")).toBeNull();
  });

  it("applies outline_item_added immediately and refreshes authoritative structure", async () => {
    const directCall = vi.fn(async () => []);
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { data: OutlinerData; subject: string; applyObservation: (observation: Record<string, unknown>) => void };
    element.subject = "the_outline";
    element.woo = ctx({}, { directCall });
    document.body.append(element);
    element.data = { outlinerId: "the_outline", outlinerName: "Outline", items: [], focus: null, actor: "guest_1", roster: [] };

    deliver({ type: "outline_item_added", outliner: "the_outline", item: "item_2", parent_id: null, index: 0, text: "applied row", actor: "guest_1" });

    expect(element.querySelector("[data-outliner-row]")?.textContent).toContain("applied row");
    await flushPromises();
    expect(directCall).toHaveBeenCalledTimes(2);
    // The fixture's authoritative response is empty, so it supersedes the
    // optimistic observation once the coalesced refresh lands.
    expect(element.querySelector("[data-outliner-row]")).toBeNull();
  });

  it("hydrates readable item text from tree_view when generic projection omits it", async () => {
    const directCall = vi.fn(async () => [
      {
        id: "item_1",
        name: "item_1",
        text: "authoritative row",
        parent_id: null,
        index: 0,
        hidden: false,
        owner: "guest_1",
        writers: [],
        has_children: false
      }
    ]);
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { hydrate: () => Promise<void>; subject: string };
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: ["item_1"],
      directCall,
      projections: {
        the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} },
        item_1: {
          id: "item_1",
          name: "item_1",
          parent: "$outline_item",
          ancestors: ["$note", "$outline_item"],
          owner: "guest_1",
          location: "the_outline",
          props: { parent: null, position: 0, hidden: false },
          catalogState: {}
        }
      }
    });
    document.body.append(element);

    await element.hydrate();
    await flushPromises();

    expect(directCall).toHaveBeenCalledTimes(1);
    // Read-only display hydration: routed as an authoritative server read.
    expect(directCall).toHaveBeenCalledWith("the_outline", "tree_view", [], { serverRead: true });
    const text = element.querySelector(".outliner-rows")?.textContent ?? "";
    expect(text).toContain("authoritative row");
    expect(text).not.toContain("(empty)");
  });

  it("refreshes content and writers independently of the structural watermark", async () => {
    let reads = 0;
    const directCall = vi.fn(async () => {
      reads += 1;
      return [{
        id: "item_1",
        name: "item_1",
        text: reads === 1 ? "before" : "after",
        parent_id: null,
        index: 0,
        hidden: false,
        owner: "guest_1",
        writers: reads === 1 ? [] : ["guest_2"],
        has_children: false
      }];
    });
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { subject: string };
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: ["item_1"],
      directCall,
      projections: {
        item_1: { id: "item_1", parent: "$outline_item", location: "the_outline", props: {}, catalogState: {} }
      }
    });
    document.body.append(element);
    await flushPromises();
    expect(element.querySelector("[data-outliner-row]")?.textContent).toContain("before");

    // The fixture's structure_at_seq remains 0. Content/writer invalidation
    // uses the facade's own generation and coalesces the accepted frame to one
    // authoritative replacement read.
    deliver(
      { type: "note_edited", note: "item_1", text: "after" },
      { type: "note_writers_changed", note: "item_1", writers: ["guest_2"] }
    );
    await flushPromises();
    expect(directCall).toHaveBeenCalledTimes(2);
    expect(element.querySelector("[data-outliner-row]")?.textContent).toContain("after");
  });

  it("coalesces tree_view while the host rebinds and reconnects the same outliner", async () => {
    let releaseListItems!: () => void;
    const listItems = new Promise<void>((resolve) => { releaseListItems = resolve; });
    let calls = 0;
    const refs = ["item_1"];
    const projections = {
      the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} },
      item_1: {
        id: "item_1",
        name: "item_1",
        parent: "$outline_item",
        ancestors: ["$note", "$outline_item"],
        owner: "guest_1",
        location: "the_outline",
        props: { parent: null, position: 0, hidden: false },
        catalogState: {}
      }
    };
    const makeWoo = (): WooContext => ctx({}, {
      refs,
      projections,
      directCall: async (_subject, verb) => {
        if (verb === "tree_view") {
          calls += 1;
          if (calls === 1) await listItems;
        }
        return [
          {
            id: "item_1",
            name: "item_1",
            text: "joined row",
            parent_id: null,
            index: 0,
            hidden: false,
            owner: "guest_1",
            writers: [],
            has_children: false
          }
        ];
      }
    });
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & {
      subject: string;
      syncFromProjection: () => void;
    };
    element.subject = "the_outline";
    element.woo = makeWoo();
    document.body.append(element);
    await flushPromises();
    expect(calls).toBe(1);

    // main.ts reassigns a fresh WooContext and calls syncFromProjection on each
    // render. The outliner should keep the same in-flight tree_view fill.
    element.woo = makeWoo();
    element.syncFromProjection();
    await flushPromises();
    expect(calls).toBe(1);

    // The app shell also removes and reattaches the preserved tool element.
    // Reconnect must not schedule a duplicate tree_view fill for the same
    // subject/signature while the first read is still in flight.
    element.remove();
    document.body.append(element);
    element.syncFromProjection();
    await flushPromises();
    expect(calls).toBe(1);

    releaseListItems();
    await flushPromises();
    expect(calls).toBe(1);
    expect(element.querySelector("[data-outliner-row]")?.textContent).toContain("joined row");

    element.syncFromProjection();
    await flushPromises();
    expect(calls).toBe(1);
  });

  it("preserves observation text when a later generic projection lacks text", () => {
    const directCall = vi.fn(async () => []);
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & {
      applyObservation: (observation: Record<string, unknown>) => void;
      subject: string;
      syncFromProjection: () => void;
    };
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: ["item_1"],
      directCall,
      projections: {
        the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} },
        item_1: {
          id: "item_1",
          name: "item_1",
          parent: "$outline_item",
          ancestors: ["$note", "$outline_item"],
          owner: "guest_1",
          location: "the_outline",
          props: { parent: null, position: 0, hidden: false },
          catalogState: {}
        }
      }
    });

    document.body.append(element);
    deliver({ type: "outline_item_added", outliner: "the_outline", item: "item_1", parent_id: null, index: 0, text: "observed row", actor: "guest_1" });
    element.syncFromProjection();

    // The projection sync joins the mutation-triggered refresh instead of
    // issuing a second whole-tree read for the same structural revision.
    expect(directCall).toHaveBeenCalledTimes(1);
    const text = element.querySelector(".outliner-rows")?.textContent ?? "";
    expect(text).toContain("observed row");
    expect(text).not.toContain("(empty)");
  });

  it("shows the root add form only after outliner presence is ready", () => {
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { data: OutlinerData; entering: boolean; showCompanion: boolean };
    element.woo = ctx();
    document.body.append(element);
    element.data = { outlinerId: "the_outline", outlinerName: "Outline", items: [], focus: null, actor: "guest_1", roster: [] };

    expect(element.querySelector("[data-outliner-add]"), "not present before enter").toBeNull();

    element.entering = true;
    expect(element.querySelector("[data-outliner-add]"), "not present while enter is pending").toBeNull();
    expect(element.querySelector("[data-outliner-presence]"), "no manual presence control").toBeNull();

    element.entering = false;
    element.showCompanion = true;
    expect(element.querySelector("[data-outliner-add]"), "present after enter completes").not.toBeNull();
  });

  it("ignores unrelated host data assignments without replacing the outliner model", () => {
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { data: OutlinerData };
    element.woo = ctx();
    document.body.append(element);
    element.data = {
      outlinerId: "the_outline",
      outlinerName: "Outline",
      items: [
        { id: "item_1", name: "item_1", text: "kept row", parent_id: null, index: 0, hidden: false, owner: "guest_1", writers: [], has_children: false }
      ],
      focus: null,
      actor: "guest_1",
      roster: []
    };

    expect(() => {
      (element as unknown as { data: unknown }).data = { space: "the_chatroom", lines: [], present: [] };
    }).not.toThrow();

    expect(element.querySelector(".outliner-text")?.textContent).toBe("kept row");
  });

  it("keeps an applied row visible when the next projection snapshot is stale", async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let reads = 0;
    const directCall = vi.fn(async () => {
      reads += 1;
      if (reads > 1) await refreshGate;
      return [{ id: "item_1", name: "item_1", text: "projection row", parent_id: null, index: 0, hidden: false, owner: "guest_1", writers: [], has_children: false }];
    });
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & {
      applyObservation: (observation: Record<string, unknown>) => void;
      subject: string;
      syncFromProjection: () => void;
    };
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: ["item_1"],
      directCall,
      projections: {
        the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} },
        item_1: {
          id: "item_1",
          name: "item_1",
          parent: "$outline_item",
          ancestors: ["$note", "$outline_item"],
          owner: "guest_1",
          location: "the_outline",
          props: { text: "projection row", parent: null, position: 0, hidden: false },
          catalogState: {}
        }
      }
    });
    document.body.append(element);

    element.syncFromProjection();
    await flushPromises();
    deliver({ type: "outline_item_added", outliner: "the_outline", item: "item_2", parent_id: null, index: 1, text: "applied row", actor: "guest_1" });
    element.syncFromProjection();

    expect(directCall).toHaveBeenCalledTimes(2);
    const text = element.querySelector(".outliner-rows")?.textContent ?? "";
    expect(text).toContain("projection row");
    expect(text).toContain("applied row");
    releaseRefresh();
    await flushPromises();
  });

  it("coalesces a burst of structural observations into one tree verification read", async () => {
    const directCall = vi.fn(async () => []);
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & {
      applyObservation: (observation: Record<string, unknown>) => void;
      subject: string;
    };
    element.subject = "the_outline";
    element.woo = ctx({}, {
      refs: [],
      directCall,
      projections: { the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} } }
    });
    document.body.append(element);
    await flushPromises();
    expect(directCall).toHaveBeenCalledTimes(1);

    deliver(
      { type: "outline_item_added", outliner: "the_outline", item: "item_1", parent_id: null, index: 0, text: "one" },
      { type: "outline_item_moved", outliner: "the_outline", item: "item_1", to_parent: null, to_index: 0 },
      { type: "outline_item_hidden", outliner: "the_outline", item: "item_1", hidden: true }
    );
    await flushPromises();

    expect(directCall).toHaveBeenCalledTimes(2);
  });

  // Dual-shape tolerance: v3 emits the five structural events as acts
  // ({type, version, payload: {...domain fields...}}) while pre-v3 deployed
  // definitions and the movement-hook echo paths still emit flat fields on the
  // observation itself. The same event sequence in either shape must reduce to
  // the identical tree model (catalogs/outliner/migration-v2-to-v3.json).
  it("reduces act-enveloped structural events identically to flat ones", () => {
    type ObservingElement = WooOutlinerTreeElement & {
      applyObservation: (observation: Record<string, unknown>) => void;
      subject: string;
    };
    // The reduced tree model is private; the test reads it through a cast so it
    // can compare the two reducers' results field-for-field.
    const modelOf = (element: WooOutlinerTreeElement): OutlinerData => (element as unknown as { model: OutlinerData }).model;
    const mount = (): ObservingElement => {
      const element = document.createElement("woo-outliner-tree") as ObservingElement;
      element.subject = "the_outline";
      element.woo = ctx({}, {
        refs: [],
        directCall: async () => [],
        projections: { the_outline: { id: "the_outline", name: "Outline", props: {}, catalogState: {} } }
      });
      document.body.append(element);
      return element;
    };
    // One sequence exercising all five types and every field the reducer
    // reads. The final added event is an UNDO RESTORE: server-side,
    // _restore_item re-emits outline_item_added for the re-created row (a new
    // objref, item_4) after the remove — the client must hydrate it exactly
    // like any other added act.
    const events: Record<string, unknown>[] = [
      { type: "outline_item_added", outliner: "the_outline", item: "item_1", parent_id: null, index: 0, text: "first", actor: "guest_1" },
      { type: "outline_item_added", outliner: "the_outline", item: "item_2", parent_id: "item_1", index: 0, text: "child", actor: "guest_2" },
      { type: "outline_item_added", outliner: "the_outline", item: "item_3", parent_id: null, index: 1, text: "third", actor: "guest_1" },
      { type: "outline_item_moved", outliner: "the_outline", item: "item_2", to_parent: null, to_index: 0 },
      { type: "outline_item_reordered", outliner: "the_outline", item: "item_3", parent_id: null, to_index: 0 },
      { type: "outline_item_hidden", outliner: "the_outline", item: "item_2", hidden: true },
      { type: "outline_item_removed", outliner: "the_outline", item: "item_1", reparented_to: null },
      { type: "outline_item_added", outliner: "the_outline", item: "item_4", parent_id: null, index: 2, text: "first", actor: "guest_1" }
    ];
    const envelop = ({ type, ...fields }: Record<string, unknown>): Record<string, unknown> => ({ type, version: 1, payload: fields });

    const flat = mount();
    const acts = mount();
    for (const event of events) {
      flat.applyObservation(event);
      acts.applyObservation(envelop(event));
    }

    // The flat sequence lands the expected structure (proving each event took
    // effect, including the restored row), and the enveloped sequence lands
    // the exact same model.
    expect(modelOf(flat).items).toMatchObject([
      { id: "item_3", text: "third", parent_id: null, index: 0, hidden: false, owner: "guest_1" },
      { id: "item_2", text: "child", parent_id: null, index: 1, hidden: true, owner: "guest_2" },
      { id: "item_4", text: "first", parent_id: null, index: 2, hidden: false, owner: "guest_1" }
    ]);
    expect(modelOf(acts).items).toEqual(modelOf(flat).items);
  });
});
