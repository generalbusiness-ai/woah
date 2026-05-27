import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { installLocalCatalogs } from "../src/core/local-catalogs";

function setupWorld() {
  const world = createWorld({ catalogs: false });
  installLocalCatalogs(world, ["chat", "note", "demoworld", "outliner"]);
  return world;
}

type CallResult =
  | { op: "result"; result: unknown; observations: Array<Record<string, unknown>> }
  | { op: "error"; error: { code: string; message?: string; value?: unknown } };

async function call(
  world: ReturnType<typeof createWorld>,
  actor: string,
  target: string,
  verb: string,
  args: unknown[],
  reqId = `${verb}-${Math.random().toString(36).slice(2, 7)}`
): Promise<CallResult> {
  return (await world.directCall(reqId, actor, target, verb, args as never[])) as CallResult;
}

async function expectResult(p: Promise<CallResult>): Promise<{ result: unknown; observations: Array<Record<string, unknown>> }> {
  const r = await p;
  if (r.op !== "result") {
    throw new Error(`expected result, got error ${(r as any).error?.code}: ${(r as any).error?.message}`);
  }
  return { result: r.result, observations: r.observations };
}

async function addItem(
  world: ReturnType<typeof createWorld>,
  actor: string,
  text: string,
  parentId: unknown = null,
  index: unknown = null
): Promise<string> {
  const r = await expectResult(call(world, actor, "the_outline", "add_item", [text, parentId, index]));
  return r.result as string;
}

function position(world: ReturnType<typeof createWorld>, item: string): number {
  return world.propOrNull(item, "position") as number;
}

function parentOf(world: ReturnType<typeof createWorld>, item: string): string | null {
  return world.propOrNull(item, "parent") as string | null;
}

describe("outliner catalog: seed + basic shape", () => {
  it("seeds the_outline as an $outliner instance in the Living Room", () => {
    const world = setupWorld();
    expect(world.objects.has("the_outline")).toBe(true);
    expect(world.isDescendantOf("the_outline", "$outliner")).toBe(true);
    // Catalog install resolves the demoworld:the_chatroom alias to the local id.
    expect(world.propOrNull("the_outline", "mount_room")).toBe("the_chatroom");
    expect(world.object("the_outline").location).toBe("the_chatroom");
  });

  it("attaches $transparent to expose embedded chat verbs", () => {
    const world = setupWorld();
    const features = world.propOrNull("the_outline", "features");
    expect(Array.isArray(features) && (features as string[]).includes("$transparent")).toBe(true);
  });

  it("$outline_item.portable is false by inheritance default override", () => {
    const world = setupWorld();
    // Default-property reads on a class with default `false` and no instance.
    expect(world.getProp("$outline_item", "portable")).toBe(false);
  });
});

describe("outliner catalog: add / list / focus", () => {
  it("add_item places top-level items in 1..N sequence", async () => {
    const world = setupWorld();
    const session = world.auth("guest:adder");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "first");
    const b = await addItem(world, session.actor, "second");
    const c = await addItem(world, session.actor, "third");
    expect(parentOf(world, a)).toBe(null);
    expect(parentOf(world, b)).toBe(null);
    expect(parentOf(world, c)).toBe(null);
    expect([position(world, a), position(world, b), position(world, c)]).toEqual([1, 2, 3]);
  });

  it("list_items returns a depth-first joined view with derived indexes", async () => {
    const world = setupWorld();
    const session = world.auth("guest:reader");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const root1 = await addItem(world, session.actor, "groceries");
    const child1 = await addItem(world, session.actor, "milk", root1);
    const child2 = await addItem(world, session.actor, "bread", root1);
    const root2 = await addItem(world, session.actor, "errands");

    const r = await expectResult(call(world, session.actor, "the_outline", "list_items", []));
    const items = r.result as Array<{ id: string; parent_id: string | null; index: number; text: string; has_children: boolean }>;
    expect(items.map((it) => it.id)).toEqual([root1, child1, child2, root2]);
    expect(items.map((it) => [it.parent_id, it.index])).toEqual([
      [null, 0],
      [root1, 0],
      [root1, 1],
      [null, 1]
    ]);
    expect(items[0].has_children).toBe(true);
    expect(items[3].has_children).toBe(false);
  });

  it("chat add command creates an item under the actor's current focus", async () => {
    const world = setupWorld();
    const session = world.auth("guest:focuser");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const groceries = await addItem(world, session.actor, "groceries");
    await expectResult(call(world, session.actor, "the_outline", "focus_on", [groceries]));
    const fresh = await expectResult(call(world, session.actor, "the_outline", "add", ["milk"]));
    const child = fresh.result as string;
    expect(parentOf(world, child)).toBe(groceries);
  });

  it("rejects empty add_item text", async () => {
    const world = setupWorld();
    const session = world.auth("guest:emptier");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const r = await call(world, session.actor, "the_outline", "add_item", [""]);
    expect(r.op).toBe("error");
    if (r.op === "error") expect(r.error.code).toBe("E_INVARG");
  });
});

describe("outliner catalog: move / reorder / hide", () => {
  it("move_item across parents updates both sibling numberings", async () => {
    const world = setupWorld();
    const session = world.auth("guest:mover");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const parentA = await addItem(world, session.actor, "A");
    const parentB = await addItem(world, session.actor, "B");
    const x = await addItem(world, session.actor, "x", parentA);
    const y = await addItem(world, session.actor, "y", parentA);
    const z = await addItem(world, session.actor, "z", parentA);

    // Move y under parentB at index 0
    await expectResult(call(world, session.actor, "the_outline", "move_item", [y, parentB, 0]));
    expect(parentOf(world, y)).toBe(parentB);
    expect(position(world, y)).toBe(1);
    // Remaining under parentA: x, z renumbered 1, 2
    expect(position(world, x)).toBe(1);
    expect(position(world, z)).toBe(2);
  });

  it("move_item rejects cycles (item under its descendant)", async () => {
    const world = setupWorld();
    const session = world.auth("guest:cycler");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const grand = await addItem(world, session.actor, "grand");
    const child = await addItem(world, session.actor, "child", grand);
    const r = await call(world, session.actor, "the_outline", "move_item", [grand, child, 0]);
    expect(r.op).toBe("error");
    if (r.op === "error") expect(r.error.code).toBe("E_CYCLE");
  });

  it("move_item rejects out-of-range index", async () => {
    const world = setupWorld();
    const session = world.auth("guest:bound");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "a");
    const r = await call(world, session.actor, "the_outline", "move_item", [a, null, 99]);
    expect(r.op).toBe("error");
    if (r.op === "error") expect(r.error.code).toBe("E_INDEX");
  });

  it("reorder_item emits outline_item_reordered (distinct from moved)", async () => {
    const world = setupWorld();
    const session = world.auth("guest:reorder");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "a");
    const b = await addItem(world, session.actor, "b");
    const c = await addItem(world, session.actor, "c");
    const r = await expectResult(call(world, session.actor, "the_outline", "reorder_item", [c, 0]));
    const reordered = r.observations.find((o) => o.type === "outline_item_reordered");
    expect(reordered).toBeTruthy();
    expect(position(world, c)).toBe(1);
    expect(position(world, a)).toBe(2);
    expect(position(world, b)).toBe(3);
  });

  it("hide toggles the flag, idempotent, emits outline_item_hidden", async () => {
    const world = setupWorld();
    const session = world.auth("guest:hider");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "secret");
    const r = await expectResult(call(world, session.actor, "the_outline", "hide", [a, true]));
    expect(world.propOrNull(a, "hidden")).toBe(true);
    expect(r.observations.some((o) => o.type === "outline_item_hidden" && o.hidden === true)).toBe(true);
    await expectResult(call(world, session.actor, "the_outline", "hide", [a, false]));
    expect(world.propOrNull(a, "hidden")).toBe(false);
  });
});

describe("outliner catalog: not portable / defensive recycle", () => {
  it("$outline_item:moveto rejects non-outliner targets with E_NOT_PORTABLE", async () => {
    const world = setupWorld();
    const session = world.auth("guest:portless");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "stay");
    const r = await call(world, session.actor, a, "moveto", [session.actor]);
    expect(r.op).toBe("error");
    if (r.op === "error") expect(r.error.code).toBe("E_NOT_PORTABLE");
  });

  it("remove_item reparents direct children to the removed item's parent", async () => {
    const world = setupWorld();
    const session = world.auth("guest:remover");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const grand = await addItem(world, session.actor, "grand");
    const middle = await addItem(world, session.actor, "middle", grand);
    const leaf = await addItem(world, session.actor, "leaf", middle);

    await expectResult(call(world, session.actor, "the_outline", "remove_item", [middle]));

    expect(world.objects.has(middle)).toBe(false);
    expect(parentOf(world, leaf)).toBe(grand);
    expect(position(world, leaf)).toBe(1);
  });

  it("direct recycle(item) still reparents via :recycle defensive handler", async () => {
    const world = setupWorld();
    const session = world.auth("guest:reaper");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const grand = await addItem(world, session.actor, "grand");
    const middle = await addItem(world, session.actor, "middle", grand);
    const leaf = await addItem(world, session.actor, "leaf", middle);

    // Force a substrate-level recycle — bypasses remove_item entirely. The
    // class-level :recycle handler should still detach the item from the
    // outliner and reparent its children to its former parent.
    await (world as any).recycleChecked("$wiz", "$wiz", middle, { force: true, reason: "test" });
    expect(world.objects.has(middle)).toBe(false);
    expect(parentOf(world, leaf)).toBe(grand);
  });

  it("eject_item rejects non-owner non-wizard", async () => {
    const world = setupWorld();
    const owner = world.auth("guest:owner-eject");
    await expectResult(call(world, owner.actor, "the_outline", "enter", []));
    const a = await addItem(world, owner.actor, "mine");
    const stranger = world.auth("guest:stranger-eject");
    await expectResult(call(world, stranger.actor, "the_outline", "enter", []));
    const r = await call(world, stranger.actor, "the_outline", "eject_item", [a]);
    expect(r.op).toBe("error");
    if (r.op === "error") expect(r.error.code).toBe("E_PERM");
  });

  it("remove_item rejects non-author non-wizard", async () => {
    const world = setupWorld();
    const author = world.auth("guest:author");
    await expectResult(call(world, author.actor, "the_outline", "enter", []));
    const a = await addItem(world, author.actor, "mine");
    const stranger = world.auth("guest:stranger-remove");
    await expectResult(call(world, stranger.actor, "the_outline", "enter", []));
    const r = await call(world, stranger.actor, "the_outline", "remove_item", [a]);
    expect(r.op).toBe("error");
    if (r.op === "error") expect(r.error.code).toBe("E_PERM");
  });

  it("tolerates stale refs in contents(this) (add_item / list_items keep working)", async () => {
    // Production observation: the dev server had `obj_the_outline_1` in
    // the_outline.contents but the object itself no longer existed in the
    // world. `_siblings_ordered` then called `isa(stale_ref, $outline_item)`
    // which threw E_OBJNF, killing `add_item` and `list_items`. The verbs
    // now defensively wrap the `isa` call and skip unresolvable refs.
    //
    // Simulating the bad state by injecting a string id into the contents
    // Set; the substrate's contentsOf returns Array.from(obj.contents) so
    // the DSL `contents(this)` will surface the stale ref to woocode.
    const world = setupWorld();
    const session = world.auth("guest:stale");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    // Inject a non-existent ref into contents. This is exactly the shape
    // the user observed in their persistent-store db.
    world.object("the_outline").contents.add("obj_the_outline_stale");

    // `add` must still succeed and `list_items` must still enumerate cleanly.
    const a = await addItem(world, session.actor, "after-stale");
    expect(parentOf(world, a)).toBe(null);
    expect(position(world, a)).toBe(1);
    const list = await expectResult(call(world, session.actor, "the_outline", "list_items", []));
    expect(Array.isArray(list.result)).toBe(true);
    const rows = list.result as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([a]);
  });
});

describe("outliner catalog: single-level undo", () => {
  it("undo of add_item recycles the row", async () => {
    const world = setupWorld();
    const session = world.auth("guest:undo-add");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "ephemera");
    await expectResult(call(world, session.actor, "the_outline", "undo", []));
    expect(world.objects.has(a)).toBe(false);
  });

  it("undo of move_item puts the row back at the old (parent, index)", async () => {
    const world = setupWorld();
    const session = world.auth("guest:undo-move");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "a");
    const b = await addItem(world, session.actor, "b");
    const c = await addItem(world, session.actor, "c");
    // Move c to index 0.
    await expectResult(call(world, session.actor, "the_outline", "move_item", [c, null, 0]));
    expect(position(world, c)).toBe(1);
    expect(position(world, a)).toBe(2);
    expect(position(world, b)).toBe(3);
    // Undo.
    await expectResult(call(world, session.actor, "the_outline", "undo", []));
    expect(position(world, a)).toBe(1);
    expect(position(world, b)).toBe(2);
    expect(position(world, c)).toBe(3);
  });

  it("undo of remove_item restores the row and its direct children", async () => {
    const world = setupWorld();
    const session = world.auth("guest:undo-remove");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const groceries = await addItem(world, session.actor, "groceries");
    const milk = await addItem(world, session.actor, "milk", groceries);
    const bread = await addItem(world, session.actor, "bread", groceries);
    // Remove groceries — milk/bread reparent to root.
    await expectResult(call(world, session.actor, "the_outline", "remove_item", [groceries]));
    expect(parentOf(world, milk)).toBe(null);
    expect(parentOf(world, bread)).toBe(null);

    // Undo — restored row gets a NEW objref, and milk/bread move back under it.
    const undoR = await expectResult(call(world, session.actor, "the_outline", "undo", []));
    const undone = undoR.observations.find((o) => o.type === "outline_undone");
    expect(undone).toBeTruthy();
    // milk/bread should be under SOME new item whose text is "groceries".
    expect(parentOf(world, milk)).not.toBe(null);
    const restoredRef = parentOf(world, milk)!;
    expect(parentOf(world, bread)).toBe(restoredRef);
    expect(world.propOrNull(restoredRef, "text")).toBe("groceries");
    // Children renumbered 1..N under restored.
    expect([position(world, milk), position(world, bread)].sort()).toEqual([1, 2]);
  });

  it("single-level: second undo is a no-op", async () => {
    const world = setupWorld();
    const session = world.auth("guest:single");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "one");
    const b = await addItem(world, session.actor, "two");
    // After two adds, last_undo holds the "remove b" inverse.
    await expectResult(call(world, session.actor, "the_outline", "undo", []));
    expect(world.objects.has(b)).toBe(false);
    expect(world.objects.has(a)).toBe(true);
    // Second undo: slot empty, no-op.
    const r = await expectResult(call(world, session.actor, "the_outline", "undo", []));
    expect(r.result).toBe(false);
    expect(world.objects.has(a)).toBe(true);
  });

  it("entering wipes the undo slot from any prior session", async () => {
    const world = setupWorld();
    const session = world.auth("guest:wiper");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "doomed");
    expect(world.objects.has(a)).toBe(true);
    // Leave without undoing — slot is cleared on leave.
    await expectResult(call(world, session.actor, "the_outline", "leave", []));
    // Re-enter — slot wiped on enter too.
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const r = await expectResult(call(world, session.actor, "the_outline", "undo", []));
    expect(r.result).toBe(false);
    expect(world.objects.has(a)).toBe(true);
  });
});

describe("outliner catalog: focus", () => {
  it("focus resets to null on enter", async () => {
    const world = setupWorld();
    const session = world.auth("guest:reset");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "x");
    await expectResult(call(world, session.actor, "the_outline", "focus_on", [a]));
    let fmap = world.propOrNull("the_outline", "focus_by_actor") as Record<string, string | null>;
    expect(fmap[session.actor]).toBe(a);
    await expectResult(call(world, session.actor, "the_outline", "leave", []));
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    fmap = world.propOrNull("the_outline", "focus_by_actor") as Record<string, string | null>;
    expect(fmap[session.actor] ?? null).toBe(null);
  });

  it("focus_on validates that the item is in this outliner", async () => {
    const world = setupWorld();
    const session = world.auth("guest:strangefocus");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const r = await call(world, session.actor, "the_outline", "focus_on", [session.actor]);
    expect(r.op).toBe("error");
    if (r.op === "error") expect(r.error.code).toBe("E_NO_ITEM");
  });

  it("outline_focus_changed observation is directed to the focusing actor", async () => {
    const world = setupWorld();
    const session = world.auth("guest:directed");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "f");
    const r = await expectResult(call(world, session.actor, "the_outline", "focus_on", [a]));
    const focus = r.observations.find((o) => o.type === "outline_focus_changed");
    expect(focus).toBeTruthy();
    expect((focus as any).to).toBe(session.actor);
  });

  it("two actors keep independent focus state in the same outliner", async () => {
    const world = setupWorld();
    const alice = world.auth("guest:alice-focus");
    const bob = world.auth("guest:bob-focus");
    await expectResult(call(world, alice.actor, "the_outline", "enter", []));
    await expectResult(call(world, bob.actor, "the_outline", "enter", []));
    const x = await addItem(world, alice.actor, "x");
    const y = await addItem(world, alice.actor, "y");
    await expectResult(call(world, alice.actor, "the_outline", "focus_on", [x]));
    await expectResult(call(world, bob.actor, "the_outline", "focus_on", [y]));
    const fmap = world.propOrNull("the_outline", "focus_by_actor") as Record<string, string | null>;
    expect(fmap[alice.actor]).toBe(x);
    expect(fmap[bob.actor]).toBe(y);
    // Bob's focus_on does not perturb Alice's slot.
    await expectResult(call(world, bob.actor, "the_outline", "focus_on", [null]));
    const fmap2 = world.propOrNull("the_outline", "focus_by_actor") as Record<string, string | null>;
    expect(fmap2[alice.actor]).toBe(x);
    expect(fmap2[bob.actor] ?? null).toBe(null);
  });
});

describe("outliner catalog: undo of every mutating composer", () => {
  it("undo of hide flips the flag back", async () => {
    const world = setupWorld();
    const session = world.auth("guest:undo-hide");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "h");
    expect(world.propOrNull(a, "hidden")).toBe(false);
    await expectResult(call(world, session.actor, "the_outline", "hide", [a, true]));
    expect(world.propOrNull(a, "hidden")).toBe(true);
    await expectResult(call(world, session.actor, "the_outline", "undo", []));
    expect(world.propOrNull(a, "hidden")).toBe(false);
  });

  it("undo of reorder_item restores the old index", async () => {
    const world = setupWorld();
    const session = world.auth("guest:undo-reorder");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "a");
    const b = await addItem(world, session.actor, "b");
    const c = await addItem(world, session.actor, "c");
    await expectResult(call(world, session.actor, "the_outline", "reorder_item", [c, 0]));
    expect([position(world, c), position(world, a), position(world, b)]).toEqual([1, 2, 3]);
    await expectResult(call(world, session.actor, "the_outline", "undo", []));
    expect([position(world, a), position(world, b), position(world, c)]).toEqual([1, 2, 3]);
  });

  it("undo of set_item_text restores the prior body", async () => {
    const world = setupWorld();
    const session = world.auth("guest:undo-text");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "first");
    await expectResult(call(world, session.actor, "the_outline", "set_item_text", [a, "second"]));
    expect(world.propOrNull(a, "text")).toBe("second");
    await expectResult(call(world, session.actor, "the_outline", "undo", []));
    expect(world.propOrNull(a, "text")).toBe("first");
  });
});

describe("outliner catalog: observation hygiene", () => {
  it("add_item emits exactly one outline_item_added", async () => {
    const world = setupWorld();
    const session = world.auth("guest:once");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const r = await expectResult(call(world, session.actor, "the_outline", "add_item", ["once"]));
    const added = r.observations.filter((o) => o.type === "outline_item_added");
    expect(added).toHaveLength(1);
  });

  it("hide emits exactly one outline_item_hidden", async () => {
    const world = setupWorld();
    const session = world.auth("guest:hide-once");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "h");
    const r = await expectResult(call(world, session.actor, "the_outline", "hide", [a, true]));
    const hidden = r.observations.filter((o) => o.type === "outline_item_hidden");
    expect(hidden).toHaveLength(1);
  });

  it("move_item emits exactly one outline_item_moved (and no reordered)", async () => {
    const world = setupWorld();
    const session = world.auth("guest:move-once");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const root = await addItem(world, session.actor, "root");
    const a = await addItem(world, session.actor, "a", root);
    const target = await addItem(world, session.actor, "target");
    const r = await expectResult(call(world, session.actor, "the_outline", "move_item", [a, target, 0]));
    expect(r.observations.filter((o) => o.type === "outline_item_moved")).toHaveLength(1);
    expect(r.observations.filter((o) => o.type === "outline_item_reordered")).toHaveLength(0);
  });
});

describe("outliner catalog: $transparent chat verbs route through", () => {
  it("the_outline plans the chat 'add' command into outliner:add", async () => {
    const world = setupWorld();
    const session = world.auth("guest:chat-add");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const plan = await expectResult(call(world, session.actor, "the_outline", "command_plan", ["add walk the dog"]));
    expect(plan.result).toMatchObject({ ok: true, target: "the_outline", verb: "add", args: ["walk the dog"] });
  });

  it("the_outline plans the chat 'focus' command (no arg) into focus_root_command", async () => {
    const world = setupWorld();
    const session = world.auth("guest:chat-focus-root");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const plan = await expectResult(call(world, session.actor, "the_outline", "command_plan", ["focus"]));
    expect(plan.result).toMatchObject({ ok: true, target: "the_outline", verb: "focus_root_command" });
  });

  it("the_outline plans 'hide <item>' into hide_command targeting that item", async () => {
    const world = setupWorld();
    const session = world.auth("guest:chat-hide");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    // Item.name is empty by default and add_item leaves it that way; for the
    // command planner to resolve a chat-side dobj reference, the item needs a
    // matchable label. Set one via the item's :match_names path: $note items
    // inherit a match_names verb that picks up text lines, so the body is the
    // matchable string.
    await addItem(world, session.actor, "specific phrase");
    const plan = await expectResult(call(world, session.actor, "the_outline", "command_plan", ["hide specific phrase"]));
    expect(plan.result).toMatchObject({ ok: true, target: "the_outline", verb: "hide_command" });
  });
});

describe("outliner catalog: room_roster (presence aside)", () => {
  // The right-side presence aside in the outliner UI reads from
  // $outliner:room_roster. These tests pin the verb's directly-callable
  // contract (rxd / skip_presence_check) and the row shape the UI consumes
  // — id and human-readable name. A regression on either would silently
  // empty the aside.
  it("returns an empty list when no actor has entered the outliner", async () => {
    const world = setupWorld();
    const session = world.auth("guest:roster-empty");
    const r = await expectResult(call(world, session.actor, "the_outline", "room_roster", []));
    expect(r.result).toEqual([]);
  });

  it("includes a row with id + name for each present actor", async () => {
    const world = setupWorld();
    const a = world.auth("guest:roster-a");
    const b = world.auth("guest:roster-b");
    await expectResult(call(world, a.actor, "the_outline", "enter", []));
    await expectResult(call(world, b.actor, "the_outline", "enter", []));
    const r = await expectResult(call(world, a.actor, "the_outline", "room_roster", []));
    const rows = r.result as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    const ids = rows.map((row) => row.id).sort();
    expect(ids).toEqual([a.actor, b.actor].sort());
    for (const row of rows) {
      expect(row).toMatchObject({ id: expect.any(String), name: expect.any(String) });
    }
  });

  it("skips stale projected presence refs instead of failing the roster", async () => {
    const world = setupWorld();
    const session = world.auth("guest:roster-stale");
    const originalPresentActorsIn = world.presentActorsIn.bind(world);
    world.presentActorsIn = (async (ctx, space) => {
      if (space !== "the_outline") return await originalPresentActorsIn(ctx, space);
      return [session.actor, "guest_roster_stale_actor"];
    }) as typeof world.presentActorsIn;

    const r = await expectResult(call(world, session.actor, "the_outline", "room_roster", []));

    expect(r.result).toMatchObject([{ id: session.actor, name: expect.any(String) }]);
  });

  it("emits outliner_entered / outliner_left observations the UI uses to trigger re-hydrate", async () => {
    const world = setupWorld();
    const a = world.auth("guest:roster-enter");
    const entered = await expectResult(call(world, a.actor, "the_outline", "enter", []));
    expect(entered.observations.map((o) => o.type)).toContain("outliner_entered");
    const left = await expectResult(call(world, a.actor, "the_outline", "leave", []));
    expect(left.observations.map((o) => o.type)).toContain("outliner_left");
  });
});
