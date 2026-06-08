// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WooOutlinerTreeElement,
  type OutlinerData
} from "../catalogs/outliner/ui/outliner-tree";
import type { WooContext } from "../src/client/framework";

// jsdom render tests for the presence aside introduced by outliner-presence.
// These pin (a) the .outliner-presence aside exists inside .outliner-layout,
// (b) actors come through as <button> entries inside .presence-list, and
// (c) the empty roster falls back to the same "No one is here." placeholder
// shape as chat-presence / tasks-presence.

function ctx(names: Record<string, string> = {}, options: { refs?: string[]; projections?: Record<string, any>; directCall?: WooContext["directCall"] } = {}): WooContext {
  return {
    actor: "guest_1",
    frame: { id: "frame", subject: "the_outline", get: () => undefined, set: () => true },
    neighborhood: { subject: "the_outline", refs: options.refs ?? [], related: {}, has: () => true },
    observe: (ref) => options.projections?.[ref] ?? ({ id: ref, name: names[ref] ?? ref, props: {}, catalogState: {} }),
    directCall: options.directCall ?? (async () => undefined),
    send: async () => undefined,
    call: async () => undefined,
    emit: () => true
  };
}

async function flushPromises(turns = 4): Promise<void> {
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

  it("hydrates from projection refs without list_items or room_roster calls", async () => {
    const directCall = vi.fn(async () => []);
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

    expect(directCall).not.toHaveBeenCalled();
    expect(element.querySelector("[data-outliner-row]")?.textContent).toContain("projection row");
    expect(element.querySelector(".presence-list")?.textContent).toContain("Guest One");
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

    expect(directCall).not.toHaveBeenCalled();
    expect(element.querySelector("[data-outliner-row]")).toBeNull();
  });

  it("applies outline_item_added without rehydrating", () => {
    const directCall = vi.fn(async () => []);
    const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { data: OutlinerData; subject: string; applyObservation: (observation: Record<string, unknown>) => void };
    element.subject = "the_outline";
    element.woo = ctx({}, { directCall });
    document.body.append(element);
    element.data = { outlinerId: "the_outline", outlinerName: "Outline", items: [], focus: null, actor: "guest_1", roster: [] };

    element.applyObservation({ type: "outline_item_added", outliner: "the_outline", item: "item_2", parent_id: null, index: 0, text: "applied row", actor: "guest_1" });

    expect(directCall).not.toHaveBeenCalled();
    expect(element.querySelector("[data-outliner-row]")?.textContent).toContain("applied row");
  });

  it("hydrates readable item text from list_items when generic projection omits it", async () => {
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
    expect(directCall).toHaveBeenCalledWith("the_outline", "list_items", []);
    const text = element.querySelector(".outliner-rows")?.textContent ?? "";
    expect(text).toContain("authoritative row");
    expect(text).not.toContain("(empty)");
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

    element.applyObservation({ type: "outline_item_added", outliner: "the_outline", item: "item_1", parent_id: null, index: 0, text: "observed row", actor: "guest_1" });
    element.syncFromProjection();

    expect(directCall).not.toHaveBeenCalled();
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
    expect(element.querySelector("[data-outliner-presence='pending']")).not.toBeNull();

    element.entering = false;
    element.showCompanion = true;
    expect(element.querySelector("[data-outliner-add]"), "present after enter completes").not.toBeNull();
  });

  it("keeps an applied row visible when the next projection snapshot is stale", () => {
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
          props: { text: "projection row", parent: null, position: 0, hidden: false },
          catalogState: {}
        }
      }
    });
    document.body.append(element);

    element.syncFromProjection();
    element.applyObservation({ type: "outline_item_added", outliner: "the_outline", item: "item_2", parent_id: null, index: 1, text: "applied row", actor: "guest_1" });
    element.syncFromProjection();

    expect(directCall).not.toHaveBeenCalled();
    const text = element.querySelector(".outliner-rows")?.textContent ?? "";
    expect(text).toContain("projection row");
    expect(text).toContain("applied row");
  });
});
