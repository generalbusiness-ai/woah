// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  WooOutlinerTreeElement,
  type OutlinerData
} from "../catalogs/outliner/ui/outliner-tree";
import type { WooContext } from "../src/client/framework";

// jsdom tests for the outliner's client-local selection and the
// "create in place" interaction. Selection is a UI-only affordance — no
// server round-trip — so these tests assert what the component does
// locally rather than what verbs it calls. Server-side $outliner.focus
// remains a separate capability for chat/MCP and is intentionally not
// touched by clicking a row in the browser.
//
// Pinned contract:
//   - top "add an item…" form only appears when nothing is selected
//   - the selected row carries a `+` button that opens an inline new-child
//     editor immediately below it
//   - clicking an unselected row selects it locally (no server call)
//   - clicking the already-selected row enters edit mode
//   - submitting the inline new-child editor calls add_item(text, parent_id)
//     with the selected row id as the parent
//   - the "clear selection" toolbar button (and Escape with no editor open)
//     resets the local selection
//   - the hide checkbox keeps its own behavior and does not select/edit

type Calls = Array<{ subject: string; verb: string; args: unknown[] }>;

function ctx(calls: Calls): WooContext {
  return {
    actor: "guest_1",
    frame: { id: "frame", subject: "the_outline", get: () => undefined, set: () => true },
    neighborhood: { subject: "the_outline", refs: [], related: {}, has: () => true },
    observe: (ref) => ({ id: ref, name: ref, props: {}, catalogState: {} }),
    directCall: async (subject, verb, args = []) => {
      calls.push({ subject, verb, args });
      // Suppress the hydrate's list_items / room_roster fetches so they
      // don't show up alongside the verb the test is asserting on.
      if (verb === "list_items") return [];
      if (verb === "room_roster") return [];
      return undefined;
    },
    send: async () => undefined,
    call: async (subject, verb, args = []) => {
      calls.push({ subject, verb, args });
      return "req-id";
    },
    emit: () => true
  };
}

function mount(data: OutlinerData, calls: Calls): WooOutlinerTreeElement {
  const element = document.createElement("woo-outliner-tree") as WooOutlinerTreeElement & { data: OutlinerData };
  element.woo = ctx(calls);
  element.subject = data.outlinerId;
  document.body.append(element);
  element.data = data;
  return element;
}

// Click the text span inside a row to drive the row-click handler.
function clickRow(el: WooOutlinerTreeElement, id: string): void {
  const row = el.querySelector<HTMLElement>(`[data-outliner-row][data-id='${id}']`);
  if (!row) throw new Error(`row ${id} not in DOM`);
  row.querySelector<HTMLElement>(".outliner-text")!.click();
}

const SAMPLE: OutlinerData = {
  outlinerId: "the_outline",
  outlinerName: "Outline",
  items: [
    { id: "item_a", name: "", text: "Alpha", parent_id: null, index: 0, hidden: false, owner: "guest_1", writers: [], has_children: false },
    { id: "item_b", name: "", text: "Beta",  parent_id: null, index: 1, hidden: false, owner: "guest_1", writers: [], has_children: false }
  ],
  focus: null,
  actor: "guest_1",
  roster: []
};

describe("outliner-tree create-in-place (client-local selection)", () => {
  beforeAll(() => {
    if (!customElements.get("woo-outliner-tree")) {
      customElements.define("woo-outliner-tree", WooOutlinerTreeElement);
    }
  });

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the top add form when nothing is selected, and no per-row + buttons", () => {
    const el = mount(SAMPLE, []);
    expect(el.querySelector("[data-outliner-add]"), "top add form present at root").not.toBeNull();
    expect(el.querySelector("[data-outliner-action='add-child']")).toBeNull();
    // No clear-selection button until something is selected.
    expect(el.querySelector(".outliner-clear-selection")).toBeNull();
  });

  it("server-side focus does not paint a selected row — only a UI click does", () => {
    // Server says focus is item_a (a chat user did `focus alpha`). The
    // browser UI should NOT pick that up as a selection — selection is
    // a separate, UI-only capability.
    const el = mount({ ...SAMPLE, focus: "item_a" }, []);
    expect(el.querySelector(".outliner-row.is-focused"), "no row painted as selected from server focus alone").toBeNull();
    expect(el.querySelector("[data-outliner-action='add-child']"), "no + button from server focus alone").toBeNull();
    expect(el.querySelector("[data-outliner-add]"), "top add form still visible").not.toBeNull();
  });

  it("clicking an unselected row selects it locally — no server call", async () => {
    const calls: Calls = [];
    const el = mount(SAMPLE, calls);
    calls.length = 0;
    clickRow(el, "item_a");
    await Promise.resolve();

    // No server call.
    expect(calls.length, "no verbs called").toBe(0);
    // is-focused class indicates UI selection in CSS.
    const selected = el.querySelector<HTMLElement>(".outliner-row.is-focused");
    expect(selected?.dataset.id).toBe("item_a");
    // The + button appeared on the selected row only.
    const plus = el.querySelectorAll("[data-outliner-action='add-child']");
    expect(plus.length).toBe(1);
    expect((plus[0] as HTMLElement).dataset.id).toBe("item_a");
    // The top add form is hidden.
    expect(el.querySelector("[data-outliner-add]")).toBeNull();
    // Clear-selection button appears.
    expect(el.querySelector(".outliner-clear-selection")).not.toBeNull();
  });

  it("clicking + opens an inline new-child editor directly below the selected row", () => {
    const el = mount(SAMPLE, []);
    clickRow(el, "item_a");
    const plus = el.querySelector<HTMLElement>("[data-outliner-action='add-child']")!;
    plus.click();

    const placeholder = el.querySelector<HTMLElement>("[data-outliner-add-child-row]");
    expect(placeholder, "placeholder row appears").not.toBeNull();
    const selectedRow = el.querySelector<HTMLElement>(`[data-outliner-row][data-id='item_a']`)!;
    expect(selectedRow.nextElementSibling, "placeholder is the next sibling of the selected row").toBe(placeholder);

    const form = placeholder!.querySelector<HTMLFormElement>("[data-outliner-add-child]");
    expect(form).not.toBeNull();
    expect(form!.querySelector("input[name='text']")).not.toBeNull();
  });

  it("submitting the inline editor calls add_item(text, parent_id) with the selected row as parent", async () => {
    const calls: Calls = [];
    const el = mount(SAMPLE, calls);
    clickRow(el, "item_a");
    el.querySelector<HTMLElement>("[data-outliner-action='add-child']")!.click();
    const input = el.querySelector<HTMLInputElement>("[data-outliner-add-child] input[name='text']")!;
    input.value = "first child";
    el.querySelector<HTMLFormElement>("[data-outliner-add-child]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    const addCall = calls.find((c) => c.verb === "add_item");
    expect(addCall, "add_item was issued").not.toBeUndefined();
    // Pass parent explicitly so we don't depend on server-side focus.
    expect(addCall!.args).toEqual(["first child", "item_a"]);
    expect(addCall!.subject).toBe("the_outline");
    // Old "add" verb (which relied on server focus default) should NOT be
    // called from this path.
    expect(calls.find((c) => c.verb === "add")).toBeUndefined();
  });

  it("clicking the already-selected row enters edit mode (no spurious server call)", async () => {
    const calls: Calls = [];
    const el = mount(SAMPLE, calls);
    clickRow(el, "item_a");
    calls.length = 0;
    clickRow(el, "item_a");
    await Promise.resolve();

    // No server call from the second click either — it just enters edit.
    expect(calls.length, "second click made no server call").toBe(0);
    expect(el.querySelector("[data-outliner-edit]"), "edit form is now in the row").not.toBeNull();
  });

  it("clear-selection toolbar button resets the selection — no server call", async () => {
    const calls: Calls = [];
    const el = mount(SAMPLE, calls);
    clickRow(el, "item_a");
    calls.length = 0;
    const clearBtn = el.querySelector<HTMLElement>("[data-outliner-action='clear-selection']");
    expect(clearBtn, "clear-selection button visible while selected").not.toBeNull();
    clearBtn!.click();
    await Promise.resolve();

    expect(calls.length, "clear-selection makes no server call").toBe(0);
    expect(el.querySelector(".outliner-row.is-focused")).toBeNull();
    expect(el.querySelector("[data-outliner-add]"), "top add form returns when selection cleared").not.toBeNull();
  });

  it("if the selected item disappears from the tree, selection clears automatically", () => {
    const el = mount(SAMPLE, []);
    clickRow(el, "item_a");
    expect(el.querySelector(".outliner-row.is-focused")).not.toBeNull();
    // Simulate a hydrate where item_a was removed (e.g. another actor
    // removed it). The selection should fall back to nothing rather than
    // dangle on a missing id.
    const withoutA: OutlinerData = { ...SAMPLE, items: [SAMPLE.items[1]] };
    (el as WooOutlinerTreeElement & { data: OutlinerData }).data = withoutA;
    expect(el.querySelector(".outliner-row.is-focused")).toBeNull();
    expect(el.querySelector("[data-outliner-add-child-row]"), "pending placeholder closed too").toBeNull();
  });

  it("does not start editing when the click lands on the hide checkbox", async () => {
    const calls: Calls = [];
    const el = mount(SAMPLE, calls);
    clickRow(el, "item_a");
    calls.length = 0;
    const checkbox = el.querySelector<HTMLInputElement>("[data-outliner-hide][data-id='item_a']")!;
    checkbox.click();
    await Promise.resolve();

    // The row stays selected, but the click does not enter edit mode.
    expect(el.querySelector("[data-outliner-edit]")).toBeNull();
    // Selection was not disturbed by the hide click.
    expect(el.querySelector<HTMLElement>(".outliner-row.is-focused")?.dataset.id).toBe("item_a");
    // The only verb that may have fired is `hide` (the checkbox's own
    // handler). No focus_on, no add_item, no add, no clear-selection
    // round-trip — those would indicate the row-click handler stole the
    // event from the checkbox.
    const unexpected = calls.filter((c) => c.verb !== "hide" && c.verb !== "list_items" && c.verb !== "room_roster");
    expect(unexpected, "no extra verbs called").toEqual([]);
  });
});
