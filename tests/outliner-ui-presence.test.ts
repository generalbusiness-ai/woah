// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  WooOutlinerTreeElement,
  type OutlinerData
} from "../catalogs/outliner/ui/outliner-tree";
import type { WooContext } from "../src/client/framework";

// jsdom render tests for the presence aside introduced by outliner-presence.
// These pin (a) the .outliner-presence aside exists inside .outliner-layout,
// (b) actors come through as <button> entries inside .presence-list, and
// (c) the empty roster falls back to the same "No one is in this outline"
// placeholder shape as chat-presence / dubspace-presence.

function ctx(names: Record<string, string> = {}): WooContext {
  return {
    actor: "guest_1",
    frame: { id: "frame", subject: "the_outline", get: () => undefined, set: () => true },
    neighborhood: { subject: "the_outline", refs: [], related: {}, has: () => true },
    observe: (ref) => ({ id: ref, name: names[ref] ?? ref, props: {}, catalogState: {} }),
    directCall: async () => undefined,
    send: async () => undefined,
    call: async () => undefined,
    emit: () => true
  };
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
    expect(aside?.querySelector("h2")?.textContent).toBe("Present");

    const buttons = aside?.querySelectorAll(".presence-list button") ?? [];
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toContain("Guest One");
    expect(buttons[0].textContent).toContain("guest_1");
    expect(buttons[1].textContent).toContain("Guest Two");
  });

  // Empty roster fallback — the placeholder text mirrors chat-space's
  // "No actors present." phrasing so the empty state reads the same shape
  // across tools.
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
    expect(aside?.querySelector(".presence-list")?.textContent).toContain("No one is in this outline");
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
  it("renders the header outside the ambient-companion-shell so the mini-chat anchors to the viewport bottom", () => {
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

    const header = element.querySelector(".outliner-header");
    const shell = element.querySelector(".ambient-companion-shell");
    expect(header, "header is rendered").not.toBeNull();
    expect(shell, "ambient-companion-shell is rendered when companion visible").not.toBeNull();
    expect(shell?.contains(header), "header must NOT be a descendant of the shell — keep it as a sibling so the shell's calc(100dvh - 5.25rem) lines up").toBe(false);
  });
});
