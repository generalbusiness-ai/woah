import { describe, expect, it } from "vitest";
import { installVerb, installVerbAs } from "../src/core/authoring";
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

// Structure mutations emit acts, and acts require the sequenced route on the
// outliner's own log (the production path post-net-cutover). These verbs go
// through world.call with the actor's session; everything else stays direct.
const SEQUENCED_VERBS = new Set(["add_item", "move_item", "reorder_item", "hide", "remove_item", "eject_item", "undo", "add", "hide_command", "recycle"]);

async function sequencedCall(
  world: ReturnType<typeof createWorld>,
  actor: string,
  space: string,
  target: string,
  verb: string,
  args: unknown[],
  reqId = `${verb}-${Math.random().toString(36).slice(2, 7)}`
): Promise<CallResult> {
  let sessionId: string | null = null;
  for (const [id, s] of world.sessions) if (s.actor === actor) { sessionId = id; break; }
  if (!sessionId) throw new Error(`no session for ${actor}`);
  const f = await world.call(reqId, sessionId, space, { actor, target, verb, args: args as never[] });
  if (f.op !== "applied") return f as unknown as CallResult;
  const obs = ((f as { observations?: Array<Record<string, unknown>> }).observations ?? []);
  const err = obs.find((o) => o && (o as { type?: unknown }).type === "$error");
  if (err) return { op: "error", error: err as unknown as { code: string; message?: string; value?: unknown } };
  return { op: "result", result: (f as { result: unknown }).result, observations: obs };
}

async function call(
  world: ReturnType<typeof createWorld>,
  actor: string,
  target: string,
  verb: string,
  args: unknown[],
  reqId = `${verb}-${Math.random().toString(36).slice(2, 7)}`
): Promise<CallResult> {
  if (SEQUENCED_VERBS.has(verb)) {
    return sequencedCall(world, actor, target, target, verb, args, reqId);
  }
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

/** The item's `{ parent, rank }` edge (the sole structural authority). */
function edgeOf(world: ReturnType<typeof createWorld>, item: string): { parent: string | null; rank: string } | null {
  const e = world.propOrNull(item, "__ordered_edge") as { parent?: unknown; rank?: unknown } | null;
  if (!e || typeof e !== "object") return null;
  return { parent: (typeof e.parent === "string" ? e.parent : null), rank: typeof e.rank === "string" ? e.rank : "" };
}

function parentOf(world: ReturnType<typeof createWorld>, item: string): string | null {
  return edgeOf(world, item)?.parent ?? null;
}

/** Derived 1-based position among the item's siblings, computed from the
 * edge ranks (fractional-rank order) — the replacement for the removed dense
 * `.position` prop, so ordering assertions still read [1, 2, 3, …]. */
function position(world: ReturnType<typeof createWorld>, item: string): number {
  const self = edgeOf(world, item);
  if (!self || self.rank === "") return 0;
  const parent = self.parent;
  const container = world.object(item).location; // siblings share the same outliner
  const siblings: Array<{ id: string; rank: string }> = [];
  for (const obj of world.exportWorld().objects) {
    if (obj.parent !== "$outline_item") continue; // direct $outline_item instances
    if (obj.location !== container) continue; // scope roots to one outliner
    const raw = new Map(obj.properties).get("__ordered_edge") as { parent?: unknown; rank?: unknown } | undefined;
    if (!raw || typeof raw !== "object") continue;
    const rank = typeof raw.rank === "string" ? raw.rank : "";
    const p = typeof raw.parent === "string" ? raw.parent : null;
    if (rank === "" || p !== parent) continue;
    siblings.push({ id: obj.id, rank });
  }
  siblings.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const idx = siblings.findIndex((s) => s.id === item);
  return idx < 0 ? 0 : idx + 1;
}

/** Seed an item directly with an edge whose rank sorts by `position`
 * (zero-padded so plain string compare matches numeric order). */
function seedOutlineItem(world: ReturnType<typeof createWorld>, text: string, position: number, parent: string | null = null): string {
  const item = world.createRuntimeObject("$outline_item", "$wiz", "the_outline", {
    progr: "$wiz",
    location: "the_outline",
    name: ""
  });
  // Zero-padded position keeps string-compare == numeric order; the trailing
  // "1" keeps every seeded rank a VALID fractional-rank key (no trailing zero,
  // so rank_between can append after the last seeded item).
  world.setProp(item, "__ordered_edge", { parent, rank: `${String(position).padStart(6, "0")}1` });
  world.setProp(item, "text", text);
  return item;
}

/** Attach a same-anchor projection whose fold always refuses. The real
 * $outline_meta remains first, so these tests prove the savepoint rolls back a
 * fold that already advanced before a later projection fails. */
function attachRefusingProjection(world: ReturnType<typeof createWorld>, code: string): string {
  const projection = world.createRuntimeObject("$outline_meta", "$wiz", "the_outline", {
    progr: "$wiz",
    location: "the_outline",
    name: "refusing projection"
  });
  world.setProp(projection, "source_space", "the_outline");
  world.setProp(projection, "log_space", "the_outline");
  const installed = installVerb(
    world,
    projection,
    "fold",
    `verb :fold(act) rx { raise { code: "${code}", message: "adversarial fold refusal" }; }`,
    null
  );
  expect(installed.ok).toBe(true);
  const current = world.getProp("the_outline", "projections") as string[];
  world.setProp("the_outline", "projections", [...current, projection]);
  return projection;
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

describe("outliner catalog: internal authority surface", () => {
  async function sharedItem(label: string) {
    const world = setupWorld();
    const author = world.auth(`guest:${label}-author`);
    const participant = world.auth(`guest:${label}-participant`);
    await expectResult(call(world, author.actor, "the_outline", "enter", []));
    await expectResult(call(world, participant.actor, "the_outline", "enter", []));
    const item = await addItem(world, author.actor, `${label} private text`);
    const projection = (world.getProp("the_outline", "projections") as string[])[0];
    return { world, author, participant, item, projection };
  }

  it("refuses sequenced capture of another author's private undo state", async () => {
    const { world, participant, item } = await sharedItem("capture");

    const denied = await sequencedCall(world, participant.actor, "the_outline", "the_outline", "_capture_item", [item]);

    expect(denied.op).toBe("error");
    if (denied.op === "error") expect(denied.error.code).toBe("E_PERM");
  });

  it("refuses emit:false detach and preserves structure and watermark", async () => {
    const { world, participant, item, projection } = await sharedItem("detach");
    const edgeBefore = edgeOf(world, item);
    const atSeqBefore = world.getProp(projection, "at_seq");

    const denied = await sequencedCall(
      world,
      participant.actor,
      "the_outline",
      "the_outline",
      "_detach_item",
      [item, { emit: false, clear_item: true }]
    );

    expect(denied.op).toBe("error");
    if (denied.op === "error") expect(denied.error.code).toBe("E_PERM");
    expect(edgeOf(world, item)).toEqual(edgeBefore);
    expect(world.getProp(projection, "at_seq")).toBe(atSeqBefore);
  });

  it("refuses public projection folds and preserves at_seq", async () => {
    const { world, participant, item, projection } = await sharedItem("fold");
    const atSeqBefore = world.getProp(projection, "at_seq");

    const denied = await sequencedCall(
      world,
      participant.actor,
      "the_outline",
      projection,
      "fold",
      [{ type: "outline_item_hidden", version: 1, payload: { item, hidden: true }, seq: 999_999 }]
    );

    expect(denied.op).toBe("error");
    if (denied.op === "error") expect(denied.error.code).toBe("E_PERM");
    expect(world.getProp(projection, "at_seq")).toBe(atSeqBefore);
  });

  it("does not grant projections a self-fold capability for rebuild", async () => {
    const { world, participant, item } = await sharedItem("self-fold");
    const projection = "participant_projection";
    world.createObject({
      id: projection,
      name: "participant projection",
      parent: "$outline_meta",
      owner: participant.actor,
      location: "the_outline"
    });
    world.setProp(projection, "source_space", "the_outline");
    // Install the wrapper as a wizard so the nested call bypasses `fold`'s
    // missing x bit. The refusal must come from caller != source_space, not
    // ordinary verb permissions.
    expect(installVerbAs(
      world,
      "$wiz",
      projection,
      "forge_fold",
      `verb :forge_fold(item) rxd {
        return this:fold({
          "type": "outline_item_hidden",
          "version": 1,
          "payload": { "item": item, "hidden": true },
          "seq": 999999
        });
      }`,
      null
    ).ok).toBe(true);

    const denied = await world.directCall(
      "self-fold-forge",
      "$wiz",
      projection,
      "forge_fold",
      [item]
    );

    expect(denied.op).toBe("error");
    if (denied.op === "error") expect(denied.error.code).toBe("E_PERM");
    expect(world.getProp(projection, "at_seq")).toBe(0);
  });

  it("refuses item-level hidden writes outside the Act-producing domain verb", async () => {
    const { world, participant, item, projection } = await sharedItem("hidden");
    const atSeqBefore = world.getProp(projection, "at_seq");

    const denied = await sequencedCall(world, participant.actor, "the_outline", item, "set_hidden", [true]);

    expect(denied.op).toBe("error");
    if (denied.op === "error") expect(denied.error.code).toBe("E_PERM");
    expect(world.getProp(item, "hidden")).toBe(false);
    expect(world.getProp(projection, "at_seq")).toBe(atSeqBefore);
  });

  it("refuses moveto($nowhere) outside remove/eject and preserves the tree", async () => {
    const { world, participant, item, projection } = await sharedItem("nowhere");
    const edgeBefore = edgeOf(world, item);
    const atSeqBefore = world.getProp(projection, "at_seq");

    const denied = await sequencedCall(world, participant.actor, "the_outline", item, "moveto", ["$nowhere"]);

    expect(denied.op).toBe("error");
    if (denied.op === "error") expect(denied.error.code).toBe("E_PERM");
    expect(world.object(item).location).toBe("the_outline");
    expect(edgeOf(world, item)).toEqual(edgeBefore);
    expect(world.getProp(projection, "at_seq")).toBe(atSeqBefore);
  });

  it("caller guards refuse privileged ingress that bypasses execute permissions", async () => {
    const world = setupWorld();
    const wizard = world.createSessionForActor("$wiz", "bearer");
    await expectResult(call(world, "$wiz", "the_outline", "enter", []));
    const item = await addItem(world, "$wiz", "guarded");
    const projection = (world.getProp("the_outline", "projections") as string[])[0];

    // A wizard progr bypasses the `x` permission check, so these refusals
    // exercise each verb's caller/authority guard itself. External ingress
    // starts with caller == #-1; only a containing composer may proceed.
    const attempts: Array<[string, string, unknown[]]> = [
      ["the_outline", "_capture_item", [item]],
      ["the_outline", "_detach_item", [item, { emit: false, clear_item: true }]],
      ["the_outline", "_set_undo", ["$wiz", null]],
      ["the_outline", "_restore_item", [{ text: "forged" }, false]],
      ["the_outline", "_acts_meta", []],
      ["the_outline", "_ensure_acts", []],
      ["the_outline", "enterfunc", [item]],
      ["the_outline", "exitfunc", [item]],
      [item, "set_hidden", [true]],
      [item, "moveto", ["$nowhere"]],
      [item, "recycle", []],
      [projection, "fold", [{ type: "outline_item_hidden", version: 1, payload: { item, hidden: true }, seq: 999_999 }]]
    ];
    for (const [target, verb, args] of attempts) {
      const denied = await sequencedCall(world, "$wiz", "the_outline", target, verb, args, `guard-${verb}`);
      expect(denied.op, verb).toBe("error");
      if (denied.op === "error") expect(denied.error.code, verb).toBe("E_PERM");
    }
    expect(world.object(item).location).toBe("the_outline");
    expect(world.getProp(item, "hidden")).toBe(false);
  });

  it("internal mutators have no public execute or direct capability", () => {
    const world = setupWorld();
    const internal: Array<[string, string]> = [
      ["$outline_item", "moveto"],
      ["$outline_item", "set_hidden"],
      ["$outliner", "_detach_item"],
      ["$outliner", "_set_undo"],
      ["$outliner", "_restore_item"],
      ["$outliner", "_capture_item"],
      ["$outliner", "_acts_meta"],
      ["$outliner", "_ensure_acts"],
      ["$outline_meta", "fold"],
      ["$projection", "fold"],
      ["$projection", "view_row"],
      ["$acts", "act"],
      ["$acts", "_validate_payload"],
      ["$acts", "_rebuild_projection"]
    ];
    for (const [target, verb] of internal) {
      const info = world.verbInfo(target, verb);
      expect(info.perms, `${target}:${verb}`).not.toContain("x");
      expect(info.direct_callable, `${target}:${verb}`).toBe(false);
    }
    // The substrate lifecycle callback is the deliberate exception: it must
    // be dispatchable by recycleChecked, and its caller == this guard is
    // exercised above.
    const lifecycle: Array<[string, string]> = [
      ["$outline_item", "recycle"],
      ["$outliner", "enterfunc"],
      ["$outliner", "exitfunc"]
    ];
    for (const [target, verb] of lifecycle) {
      expect(world.verbInfo(target, verb)).toMatchObject({ perms: "rx", direct_callable: false });
    }
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

  it("list_items handles the documented 2000-item baseline without exhausting VM memory", async () => {
    const world = setupWorld();
    const session = world.auth("guest:large-reader");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const first = seedOutlineItem(world, "root 1", 1);
    for (let i = 2; i <= 2000; i++) seedOutlineItem(world, `root ${i}`, i);

    const r = await expectResult(call(world, session.actor, "the_outline", "list_items", []));
    const items = r.result as Array<{ id: string; parent_id: string | null; index: number; text: string; has_children: boolean }>;
    expect(items).toHaveLength(2000);
    expect(items[0]).toMatchObject({ id: first, parent_id: null, index: 0, text: "root 1", has_children: false });
    expect(items[1999]).toMatchObject({ parent_id: null, index: 1999, text: "root 2000" });
  });

  it("add_item appends after a large existing root sibling set", async () => {
    const world = setupWorld();
    const session = world.auth("guest:large-adder");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    for (let i = 1; i <= 2000; i++) seedOutlineItem(world, `old ${i}`, i);

    const added = await addItem(world, session.actor, "new tail");
    expect(position(world, added)).toBe(2001);
    const r = await expectResult(call(world, session.actor, "the_outline", "list_items", []));
    const items = r.result as Array<{ id: string; index: number; text: string }>;
    expect(items).toHaveLength(2001);
    expect(items[2000]).toMatchObject({ id: added, index: 2000, text: "new tail" });
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
    // Acts envelope the domain fields under payload (kernel S2.1) — the
    // observation wire shape changed with the acts migration; client
    // reducers migrate in the adoption chunk.
    expect(r.observations.some((o) => o.type === "outline_item_hidden" && (o.payload as Record<string, unknown> | undefined)?.hidden === true)).toBe(true);
    await expectResult(call(world, session.actor, "the_outline", "hide", [a, false]));
    expect(world.propOrNull(a, "hidden")).toBe(false);
  });
});

describe("outliner catalog: not portable / defensive recycle", () => {
  it("$outline_item:moveto is not an externally callable structural path", async () => {
    const world = setupWorld();
    const session = world.auth("guest:portless");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "stay");
    const r = await call(world, session.actor, a, "moveto", [session.actor]);
    expect(r.op).toBe("error");
    if (r.op === "error") expect(r.error.code).toBe("E_DIRECT_DENIED");
    const sequenced = await sequencedCall(world, session.actor, "the_outline", a, "moveto", [session.actor]);
    expect(sequenced.op).toBe("error");
    if (sequenced.op === "error") expect(sequenced.error.code).toBe("E_PERM");
  });

  it("refuses cross-outliner movement at the execute boundary", async () => {
    const world = setupWorld();
    const session = world.auth("guest:xoutline");
    const actor = session.actor;
    // A second outliner in the same room.
    world.createObject({ id: "the_outline_2", name: "Outline 2", parent: "$outliner", owner: actor, location: "the_chatroom" });
    await expectResult(call(world, actor, "the_outline", "enter", []));
    const a = await addItem(world, actor, "a");
    const b = await addItem(world, actor, "b", a); // b is a child of a
    const c = await addItem(world, actor, "c", b); // c is a child of b
    const before = edgeOf(world, b);
    const r = await sequencedCall(world, actor, "the_outline", b, "moveto", ["the_outline_2"]);
    expect(r.op).toBe("error");
    if (r.op === "error") expect(r.error.code).toBe("E_PERM");
    // No lifecycle hook rewrites either tree behind its room's Act log.
    expect(world.object(b).location).toBe("the_outline");
    expect(edgeOf(world, b)).toEqual(before);
    expect(world.object(c).location).toBe("the_outline");
    expect(parentOf(world, c)).toBe(b);
    expect(world.contentsOf("the_outline_2")).not.toContain(b);
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

  it("refuses ordinary dispatch to the internal recycle lifecycle callback", async () => {
    const world = setupWorld();
    const session = world.auth("guest:recycle-hook-bypass");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const parent = await addItem(world, session.actor, "parent");
    const item = await addItem(world, session.actor, "item", parent);
    const before = edgeOf(world, item);
    const watermarkBefore = (await expectResult(call(world, session.actor, "the_outline", "tree_view", []))).result as { structure_at_seq: number };

    const refused = await call(world, session.actor, item, "recycle", []);
    expect(refused.op).toBe("error");
    if (refused.op === "error") expect(refused.error.code).toBe("E_PERM");
    expect(world.objects.has(item)).toBe(true);
    expect(edgeOf(world, item)).toEqual(before);
    const watermarkAfter = (await expectResult(call(world, session.actor, "the_outline", "tree_view", []))).result as { structure_at_seq: number };
    expect(watermarkAfter.structure_at_seq).toBe(watermarkBefore.structure_at_seq);
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
    world.mirrorContents("the_outline", "obj_the_outline_stale", true);

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
  it("does not expose private undo capture as a direct callable helper", async () => {
    const world = setupWorld();
    const owner = world.auth("guest:capture-owner");
    const outsider = world.auth("guest:capture-outsider");
    await expectResult(call(world, owner.actor, "the_outline", "enter", []));
    const secret = await addItem(world, owner.actor, "private capture text");

    const denied = await call(world, outsider.actor, "the_outline", "_capture_item", [secret]);

    expect(denied.op).toBe("error");
    if (denied.op === "error") expect(denied.error.code).toBe("E_DIRECT_DENIED");
  });

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
    // Leave without undoing; entry cleanup, not exit, defines fresh-visit state.
    await expectResult(call(world, session.actor, "the_outline", "leave", []));
    // Re-enter — slot wiped on enter.
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const r = await expectResult(call(world, session.actor, "the_outline", "undo", []));
    expect(r.result).toBe(false);
    expect(world.objects.has(a)).toBe(true);
  });
});

describe("outliner catalog: focus", () => {
  it("initial enter leaves root focus implicit", async () => {
    const world = setupWorld();
    const session = world.auth("guest:implicit-root-focus");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const fmap = world.propOrNull("the_outline", "focus_by_actor") as Record<string, string | null>;
    expect(Object.prototype.hasOwnProperty.call(fmap, session.actor)).toBe(false);
  });

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

  it("ignores stale compatibility presence refs instead of failing the roster", async () => {
    const world = setupWorld();
    const session = world.auth("guest:roster-stale");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    world.setProp("the_outline", "session_subscribers", [
      { session: session.id, actor: session.actor },
      { session: "missing-session", actor: "guest_roster_stale_actor" }
    ]);

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

describe("outliner acts: watermark projection + tree_view", () => {
  it("tree_view stays byte-for-byte equal to list_items through every structural verb", async () => {
    const world = setupWorld();
    const session = world.auth("guest:wm-parity");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    let watermark = 0;
    const parity = async (advances: boolean) => {
      const view = (await expectResult(call(world, session.actor, "the_outline", "tree_view", []))).result as { items: unknown[]; structure_at_seq: number };
      const rows = (await expectResult(call(world, session.actor, "the_outline", "list_items", []))).result;
      expect(view.items).toEqual(rows);
      if (advances) expect(view.structure_at_seq).toBeGreaterThan(watermark);
      else expect(view.structure_at_seq).toBe(watermark);
      watermark = view.structure_at_seq;
    };

    // Empty/new is the same genesis as an upgraded outline with no v3 acts.
    await parity(false);
    const a = await addItem(world, session.actor, "a");
    await parity(true);
    const b = await addItem(world, session.actor, "b");
    await parity(true);
    const child = await addItem(world, session.actor, "child", a);
    await parity(true);
    await expectResult(call(world, session.actor, "the_outline", "move_item", [child, b, 0]));
    await parity(true);
    await expectResult(call(world, session.actor, "the_outline", "reorder_item", [b, 0]));
    await parity(true);
    await expectResult(call(world, session.actor, "the_outline", "hide", [child, true]));
    await parity(true);
    await expectResult(call(world, session.actor, "the_outline", "set_item_text", [child, "child edited"]));
    await parity(false);
    await expectResult(call(world, session.actor, "the_outline", "remove_item", [a]));
    await parity(true);
  });

  it("structure_at_seq tracks acted structural changes, rebuilds, and gates tree_view", async () => {
    const world = setupWorld();
    const session = world.auth("guest:wm");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "first");
    await addItem(world, session.actor, "second");
    await expectResult(call(world, session.actor, "the_outline", "hide", [a, true]));

    // tree_view: substrate-authoritative items + the STRUCTURAL act
    // watermark. The key is structure_at_seq, not at_seq: the returned value
    // covers only the five acted structural domain operations, never content
    // edits or raw administrative recycle (the $outline_meta property keeps
    // the kernel-generic at_seq name).
    const tv = await expectResult(call(world, session.actor, "the_outline", "tree_view", []));
    const view = tv.result as { items: unknown[]; structure_at_seq: number };
    const flat = await expectResult(call(world, session.actor, "the_outline", "list_items", []));
    expect(view.items).toEqual(flat.result);
    expect(view.structure_at_seq).toBeGreaterThan(0);

    // The watermark equals the last acted structural entry's seq, and the
    // meta projection holds NO tree rows (no-mirror rule).
    const meta = (world.getProp("the_outline", "projections") as string[])[0];
    expect(world.getProp(meta, "at_seq")).toBe(view.structure_at_seq);
    expect(world.getProp(meta, "rows")).toEqual({});

    // Rebuild reproduces the watermark from recorded acts alone.
    world.createObject({ id: "wm2", name: "wm2", parent: "$outline_meta", owner: session.actor, location: "the_outline" });
    world.setProp("wm2", "source_space", "the_outline");
    world.setProp("wm2", "log_space", "the_outline");
    for (let i = 0; i < 20; i++) {
      const r = (await world.directCall(`wm-rb-${i}`, session.actor, "wm2", "rebuild_from", ["the_outline", 100])) as unknown as { op: string; result?: { done: boolean } };
      if (r.op !== "result" || !r.result) throw new Error("rebuild failed");
      if (r.result.done) break;
    }
    expect(world.getProp("wm2", "at_seq")).toBe(view.structure_at_seq);
  });

  it("structure_at_seq does NOT advance for content edits (structural watermark only)", async () => {
    const world = setupWorld();
    const session = world.auth("guest:wm-content");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "body v1");
    const before = (await expectResult(call(world, session.actor, "the_outline", "tree_view", []))).result as { structure_at_seq: number };

    // A content edit changes what tree_view RETURNS but is not a structural
    // act — the watermark must hold still. Facades cache-bust content via
    // their own read-generation, not this value.
    await expectResult(call(world, session.actor, "the_outline", "set_item_text", [a, "body v2"]));
    const after = (await expectResult(call(world, session.actor, "the_outline", "tree_view", []))).result as { items: unknown[]; structure_at_seq: number };
    expect(after.structure_at_seq).toBe(before.structure_at_seq);
    expect(JSON.stringify(after.items)).toContain("body v2");
  });

  it("preserves and repairs an Acts 0.1 watermark projection with no log binding", async () => {
    const world = setupWorld();
    const session = world.auth("guest:wm-log-upgrade");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    await addItem(world, session.actor, "before upgrade");
    const meta = (world.getProp("the_outline", "projections") as string[])[0]!;
    const before = world.getProp(meta, "at_seq") as number;

    // Catalog patch 0.2 adds log_space. Existing projection instances see
    // its inherited null default until the next composer mutation.
    world.setProp(meta, "log_space", null);
    const read = (await expectResult(call(
      world,
      session.actor,
      "the_outline",
      "tree_view",
      []
    ))).result as { structure_at_seq: number };
    expect(read.structure_at_seq).toBe(before);

    await addItem(world, session.actor, "after upgrade");
    expect(world.getProp("the_outline", "projections")).toContain(meta);
    expect(world.getProp(meta, "log_space")).toBe("the_outline");
    expect(world.getProp(meta, "at_seq")).toBeGreaterThan(before);
  });

  it("_ensure_acts / tree_view reject a foreign projections entry and mint the real $outline_meta", async () => {
    const world = setupWorld();
    const session = world.auth("guest:wm-robust");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    // Poison the slot: a nonempty projections list whose entry is NOT a live
    // co-located $outline_meta. Positional trust (projections[1]) would
    // accept it and never mint the real projection.
    world.createObject({ id: "fake_meta", name: "fake", parent: "$thing", owner: "$wiz" });
    world.setProp("the_outline", "projections", ["fake_meta"]);

    const a = await addItem(world, session.actor, "row");
    await expectResult(call(world, session.actor, "the_outline", "hide", [a, true]));

    // The validated lookup refused the foreign entry, _ensure_acts PRUNED it
    // (the kernel's fold loop reads .consumes on every entry — a foreign ref
    // left in place would refuse every later act), and a real live meta was
    // minted; tree_view reads that one.
    const projections = world.getProp("the_outline", "projections") as string[];
    expect(projections).not.toContain("fake_meta");
    const minted = projections.find((ref) => world.objects.has(ref) && world.object(ref).parent === "$outline_meta");
    expect(minted).toBeTruthy();
    const view = (await expectResult(call(world, session.actor, "the_outline", "tree_view", []))).result as { structure_at_seq: number };
    expect(view.structure_at_seq).toBeGreaterThan(0);
    expect(world.getProp(minted!, "at_seq")).toBe(view.structure_at_seq);
  });
});

describe("outliner acts: adversarial fold rollback", () => {
  it("failed remove preserves the item, child edge, projections, and successful Act log", async () => {
    const world = setupWorld();
    const session = world.auth("guest:remove-fold-refusal");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const parent = await addItem(world, session.actor, "parent");
    const child = await addItem(world, session.actor, "child", parent);
    const meta = (world.getProp("the_outline", "projections") as string[])[0];
    const refusing = attachRefusingProjection(world, "E_TEST_REMOVE_FOLD");
    const parentEdge = edgeOf(world, parent);
    const childEdge = edgeOf(world, child);
    const watermark = world.getProp(meta, "at_seq");
    const successfulActs = world.replay("the_outline", 1, 100)
      .filter((entry) => entry.applied_ok)
      .flatMap((entry) => entry.observations)
      .filter((observation) => observation.type.startsWith("outline_item_"));
    const entriesBefore = world.replay("the_outline", 1, 100).length;

    const failed = await call(world, session.actor, "the_outline", "remove_item", [parent]);
    expect(failed.op).toBe("error");
    if (failed.op === "error") expect(failed.error.code).toBe("E_TEST_REMOVE_FOLD");

    expect(world.objects.has(parent)).toBe(true);
    expect(edgeOf(world, parent)).toEqual(parentEdge);
    expect(edgeOf(world, child)).toEqual(childEdge);
    expect(world.getProp(meta, "at_seq")).toBe(watermark);
    expect(world.getProp(refusing, "at_seq")).toBe(0);
    const entries = world.replay("the_outline", 1, 100);
    expect(entries).toHaveLength(entriesBefore + 1);
    expect(entries.at(-1)).toMatchObject({ applied_ok: false });
    expect(entries.at(-1)?.observations).toEqual([
      expect.objectContaining({ type: "$error", code: "E_TEST_REMOVE_FOLD" })
    ]);
    expect(entries.filter((entry) => entry.applied_ok).flatMap((entry) => entry.observations)
      .filter((observation) => observation.type.startsWith("outline_item_"))).toEqual(successfulActs);
  });

  it("failed undo preserves hidden state, undo slot, projections, and successful Act log", async () => {
    const world = setupWorld();
    const session = world.auth("guest:undo-fold-refusal");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const item = await addItem(world, session.actor, "item");
    await expectResult(call(world, session.actor, "the_outline", "hide", [item, true]));
    const meta = (world.getProp("the_outline", "projections") as string[])[0];
    const refusing = attachRefusingProjection(world, "E_TEST_UNDO_FOLD");
    const undoBefore = world.getProp("the_outline", "last_undo");
    const watermark = world.getProp(meta, "at_seq");
    const entriesBefore = world.replay("the_outline", 1, 100).length;

    const failed = await call(world, session.actor, "the_outline", "undo", []);
    expect(failed.op).toBe("error");
    if (failed.op === "error") expect(failed.error.code).toBe("E_TEST_UNDO_FOLD");

    expect(world.getProp(item, "hidden")).toBe(true);
    expect(world.getProp("the_outline", "last_undo")).toEqual(undoBefore);
    expect(world.getProp(meta, "at_seq")).toBe(watermark);
    expect(world.getProp(refusing, "at_seq")).toBe(0);
    const entries = world.replay("the_outline", 1, 100);
    expect(entries).toHaveLength(entriesBefore + 1);
    expect(entries.at(-1)?.observations).toEqual([
      expect.objectContaining({ type: "$error", code: "E_TEST_UNDO_FOLD" })
    ]);
    expect(entries.at(-1)).toMatchObject({ applied_ok: false });
  });
});

describe("outliner acts: undo emits structural acts (P1-2)", () => {
  it("leaf remove→undo emits exactly one added act for the restored row and advances the watermark", async () => {
    const world = setupWorld();
    const session = world.auth("guest:undo-act-leaf");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const a = await addItem(world, session.actor, "keep");
    await addItem(world, session.actor, "doomed");
    // Focus assertions on the LAST undo slot: remove "doomed".
    const doomed = (await expectResult(call(world, session.actor, "the_outline", "list_items", []))).result as Array<{ id: string; text: string }>;
    const target = doomed.find((row) => row.text === "doomed")!.id;
    await expectResult(call(world, session.actor, "the_outline", "remove_item", [target]));
    const removedView = (await expectResult(call(world, session.actor, "the_outline", "tree_view", []))).result as { structure_at_seq: number };

    const undoR = await expectResult(call(world, session.actor, "the_outline", "undo", []));
    const restored = undoR.result as string;

    // Exactly one enveloped outline_item_added act, for the restored row, at
    // its ACTUAL restored slot (index 1: after "keep").
    const added = undoR.observations.filter((o) => o.type === "outline_item_added");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      version: 1,
      payload: { item: restored, parent_id: null, index: 1 }
    });
    expect(added[0].payload).not.toHaveProperty("text");
    expect(added[0].payload).not.toHaveProperty("actor");
    expect(added[0].payload).not.toHaveProperty("outliner");
    expect(parentOf(world, restored)).toBeNull();
    expect(position(world, a)).toBe(1);
    expect(position(world, restored)).toBe(2);

    // The watermark moved past the remove-time value: undo is a structural
    // change like any other (this was the stale-watermark repro).
    const restoredView = (await expectResult(call(world, session.actor, "the_outline", "tree_view", []))).result as { structure_at_seq: number };
    expect(restoredView.structure_at_seq).toBeGreaterThan(removedView.structure_at_seq);
  });

  it("subtree remove→undo emits added for the parent and moved acts for each restored child", async () => {
    const world = setupWorld();
    const session = world.auth("guest:undo-act-subtree");
    await expectResult(call(world, session.actor, "the_outline", "enter", []));
    const groceries = await addItem(world, session.actor, "groceries");
    const milk = await addItem(world, session.actor, "milk", groceries);
    const bread = await addItem(world, session.actor, "bread", groceries);
    await expectResult(call(world, session.actor, "the_outline", "remove_item", [groceries]));

    const undoR = await expectResult(call(world, session.actor, "the_outline", "undo", []));
    const restored = undoR.result as string;

    const added = undoR.observations.filter((o) => o.type === "outline_item_added");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ version: 1, payload: { item: restored } });
    const moved = undoR.observations.filter((o) => o.type === "outline_item_moved");
    const movedItems = moved.map((o) => (o.payload as { item: string }).item).sort();
    expect(movedItems).toEqual([bread, milk].sort());
    for (const o of moved) expect(o).toMatchObject({ version: 1, payload: { to_parent: restored } });
    // The added act precedes the child moves in the recorded order.
    const types = undoR.observations.map((o) => o.type);
    expect(types.indexOf("outline_item_added")).toBeLessThan(types.indexOf("outline_item_moved"));
  });
});
