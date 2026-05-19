// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  WooOutlinerTreeElement,
  type OutlinerData
} from "../catalogs/outliner/ui/outliner-tree";
import type { WooContext } from "../src/client/framework";

// jsdom tests for the "create in place" interaction:
//   - top "add item…" form is only shown when focus is null/root
//   - the focus row carries a + button that opens an inline new-child editor
//   - clicking an unfocused row calls focus_on; clicking the focused row
//     enters edit mode (the explicit ⊙ focus button is gone)
//   - submitting the inline new-child editor calls add(text) (which the
//     server defaults to the actor's current focus as parent)

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

describe("outliner-tree create-in-place", () => {
  beforeAll(() => {
    if (!customElements.get("woo-outliner-tree")) {
      customElements.define("woo-outliner-tree", WooOutlinerTreeElement);
    }
  });

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the top add form when focus is null/root", () => {
    const el = mount(SAMPLE, []);
    expect(el.querySelector("[data-outliner-add]"), "top add form is present at root").not.toBeNull();
    // No add-child button at root — only the focus row carries one.
    expect(el.querySelector("[data-outliner-action='add-child']")).toBeNull();
  });

  it("hides the top add form when a row is focused, and shows a + on the focused row", () => {
    const el = mount({ ...SAMPLE, focus: "item_a" }, []);
    expect(el.querySelector("[data-outliner-add]"), "top add form is hidden when focused").toBeNull();
    const plus = el.querySelector<HTMLElement>("[data-outliner-action='add-child']");
    expect(plus, "focus row carries a + button").not.toBeNull();
    expect(plus?.dataset.id).toBe("item_a");
    // Exactly one + button, only on the focus row.
    const allPlus = el.querySelectorAll("[data-outliner-action='add-child']");
    expect(allPlus.length).toBe(1);
  });

  it("clicking + opens an inline new-child editor directly below the focus row", () => {
    const el = mount({ ...SAMPLE, focus: "item_a" }, []);
    const plus = el.querySelector<HTMLElement>("[data-outliner-action='add-child']")!;
    plus.click();

    const placeholder = el.querySelector<HTMLElement>("[data-outliner-add-child-row]");
    expect(placeholder, "inline placeholder row appears after click").not.toBeNull();
    // It sits as the immediate next sibling of the focus row in the DOM.
    const focusRow = el.querySelector<HTMLElement>(`[data-outliner-row][data-id='item_a']`)!;
    expect(focusRow.nextElementSibling).toBe(placeholder);

    const form = placeholder!.querySelector<HTMLFormElement>("[data-outliner-add-child]");
    expect(form, "placeholder hosts the add-child form").not.toBeNull();
    expect(form!.querySelector("input[name='text']")).not.toBeNull();
  });

  it("submitting the inline editor calls add(text) — server defaults parent to the actor's focus", async () => {
    const calls: Calls = [];
    const el = mount({ ...SAMPLE, focus: "item_a" }, calls);
    el.querySelector<HTMLElement>("[data-outliner-action='add-child']")!.click();
    const input = el.querySelector<HTMLInputElement>("[data-outliner-add-child] input[name='text']")!;
    input.value = "first child";
    el.querySelector<HTMLFormElement>("[data-outliner-add-child]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    // The submit handler is async; let microtasks settle so the queued
    // callVerb has actually appended to `calls`.
    await Promise.resolve();
    await Promise.resolve();

    const addCall = calls.find((c) => c.verb === "add");
    expect(addCall, "add(text) was issued").not.toBeUndefined();
    expect(addCall!.args).toEqual(["first child"]);
    expect(addCall!.subject).toBe("the_outline");
  });

  it("clicking an unfocused row calls focus_on(id)", async () => {
    const calls: Calls = [];
    const el = mount(SAMPLE, calls);
    const row = el.querySelector<HTMLElement>("[data-outliner-row][data-id='item_a']")!;
    // Click on the text span — the row-click handler matches `[data-outliner-row]`.
    row.querySelector<HTMLElement>(".outliner-text")!.click();
    await Promise.resolve();
    await Promise.resolve();

    const focusCall = calls.find((c) => c.verb === "focus_on");
    expect(focusCall, "focus_on issued").not.toBeUndefined();
    expect(focusCall!.args).toEqual(["item_a"]);
  });

  it("clicking the already-focused row enters edit mode (no focus_on, no add-child)", async () => {
    const calls: Calls = [];
    const el = mount({ ...SAMPLE, focus: "item_a" }, calls);
    // Reset calls collected by the auto-hydrate that fires on connect.
    calls.length = 0;
    const row = el.querySelector<HTMLElement>("[data-outliner-row][data-id='item_a']")!;
    row.querySelector<HTMLElement>(".outliner-text")!.click();
    await Promise.resolve();

    // No focus_on was issued — we were already focused on this row.
    expect(calls.find((c) => c.verb === "focus_on")).toBeUndefined();
    // The edit form replaced the text span.
    expect(el.querySelector<HTMLElement>(`[data-outliner-edit][data-id='item_a']`)).not.toBeNull();
  });

  it("focus changing from underneath closes a pending add-child surface", () => {
    const el = mount({ ...SAMPLE, focus: "item_a" }, []);
    el.querySelector<HTMLElement>("[data-outliner-action='add-child']")!.click();
    expect(el.querySelector("[data-outliner-add-child-row]")).not.toBeNull();
    // Simulate a remote focus shift — e.g. another tab issuing a chat
    // `focus` command. The component should drop the placeholder rather
    // than dangle it under a stale row.
    (el as WooOutlinerTreeElement & { data: OutlinerData }).data = { ...SAMPLE, focus: "item_b" };
    expect(el.querySelector("[data-outliner-add-child-row]"), "placeholder closed on focus change").toBeNull();
  });

  it("clear-focus button on the toolbar calls focus_on(null)", async () => {
    const calls: Calls = [];
    const el = mount({ ...SAMPLE, focus: "item_a" }, calls);
    calls.length = 0;
    const chip = el.querySelector<HTMLElement>(".outliner-focus[data-outliner-action='clear-focus']");
    expect(chip, "focus chip is a button when something is focused").not.toBeNull();
    chip!.click();
    await Promise.resolve();
    await Promise.resolve();
    const call = calls.find((c) => c.verb === "focus_on");
    expect(call?.args).toEqual([null]);
  });

  it("does not start editing when the click lands on the hide checkbox", async () => {
    const calls: Calls = [];
    const el = mount({ ...SAMPLE, focus: "item_a" }, calls);
    calls.length = 0;
    const checkbox = el.querySelector<HTMLInputElement>("[data-outliner-hide][data-id='item_a']")!;
    checkbox.click();
    await Promise.resolve();
    // No edit form, and no spurious focus_on either.
    expect(el.querySelector(`[data-outliner-edit][data-id='item_a']`)).toBeNull();
    expect(calls.find((c) => c.verb === "focus_on")).toBeUndefined();
  });
});
