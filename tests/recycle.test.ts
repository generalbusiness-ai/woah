import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { isErrorValue } from "../src/core/types";

describe("recycle", () => {
  function builderActor(world: ReturnType<typeof createWorld>) {
    const session = world.auth("guest:builder-recycle");
    const actor = session.actor;
    const obj = world.object(actor);
    obj.owner = actor;
    obj.flags.programmer = true;
    world.chparentAuthoredObject("$wiz", actor, "$builder");
    return { session, actor };
  }

  function wizActor(world: ReturnType<typeof createWorld>) {
    const session = world.auth("guest:wiz-recycle");
    const actor = session.actor;
    const obj = world.object(actor);
    obj.owner = actor;
    obj.flags.wizard = true;
    obj.flags.programmer = true;
    return { session, actor };
  }

  async function recycleVia(
    world: ReturnType<typeof createWorld>,
    actor: string,
    target: string,
    opts: Record<string, unknown> = {}
  ) {
    return world.builderRecycle(actor, target, opts as any, "$builder");
  }

  it("recycles a leaf object: parent.children pruned, ULID tombstoned, is_recycled returns true", async () => {
    const world = createWorld();
    const { actor } = builderActor(world);
    const leaf = world.createAuthoredObject(actor, { parent: "$thing", name: "Leaf" });
    expect(world.objects.has(leaf)).toBe(true);
    expect(world.object("$thing").children.has(leaf)).toBe(true);

    await recycleVia(world, actor, leaf);

    expect(world.objects.has(leaf)).toBe(false);
    expect(world.object("$thing").children.has(leaf)).toBe(false);
    expect(world.tombstones.has(leaf)).toBe(true);
    expect(world.isRecycled(leaf)).toBe(true);
  });

  it("dereferencing a recycled ULID raises E_OBJNF; never-existed returns the same code", async () => {
    const world = createWorld();
    const { actor } = builderActor(world);
    const leaf = world.createAuthoredObject(actor, { parent: "$thing", name: "Leaf" });
    await recycleVia(world, actor, leaf);

    const tryLookup = (id: string) => {
      try {
        world.object(id);
        return null;
      } catch (err) {
        return isErrorValue(err) ? err.code : null;
      }
    };
    expect(tryLookup(leaf)).toBe("E_OBJNF");
    expect(tryLookup("obj_never_existed")).toBe("E_OBJNF");

    // is_recycled() distinguishes them: tombstoned → true; never existed → false.
    expect(world.isRecycled(leaf)).toBe(true);
    expect(world.isRecycled("obj_never_existed")).toBe(false);
  });

  it("recycled ULIDs round-trip through serialize/deserialize", async () => {
    const world = createWorld();
    const { actor } = builderActor(world);
    const leaf = world.createAuthoredObject(actor, { parent: "$thing", name: "Leaf" });
    await recycleVia(world, actor, leaf);

    const serialized = world.exportWorld();
    expect(serialized.tombstones).toContain(leaf);

    const reborn = createWorld();
    reborn.importWorld(serialized);
    expect(reborn.tombstones.has(leaf)).toBe(true);
    expect(reborn.isRecycled(leaf)).toBe(true);
  });

  it("refuses to recycle an object with children unless force: true (E_RECMOVE)", async () => {
    const world = createWorld();
    const { actor } = builderActor(world);
    const parent = world.createAuthoredObject(actor, { parent: "$thing", name: "Parent" });
    world.object(parent).flags.fertile = true;
    const child = world.createAuthoredObject(actor, { parent, name: "Child" });
    expect(world.object(parent).children.has(child)).toBe(true);

    await expect(recycleVia(world, actor, parent)).rejects.toMatchObject({ code: "E_RECMOVE" });
    expect(world.objects.has(parent)).toBe(true);
    expect(world.objects.has(child)).toBe(true);
  });

  it("with force: true, grafts children up to obj.parent (chparent semantics)", async () => {
    const world = createWorld();
    const { actor } = builderActor(world);
    const grand = world.createAuthoredObject(actor, { parent: "$thing", name: "Grand" });
    world.object(grand).flags.fertile = true;
    const middle = world.createAuthoredObject(actor, { parent: grand, name: "Middle" });
    world.object(middle).flags.fertile = true;
    const child = world.createAuthoredObject(actor, { parent: middle, name: "Child" });
    expect(world.object(child).parent).toBe(middle);
    expect(world.object(grand).children.has(middle)).toBe(true);

    await recycleVia(world, actor, middle, { force: true });

    expect(world.objects.has(middle)).toBe(false);
    expect(world.object(child).parent).toBe(grand);
    expect(world.object(grand).children.has(child)).toBe(true);
    expect(world.object(grand).children.has(middle)).toBe(false);
  });

  it("with force: true, displaces contents to $nowhere (sink semantics)", async () => {
    const world = createWorld();
    const { actor } = builderActor(world);
    const container = world.createAuthoredObject(actor, { parent: "$thing", name: "Container" });
    const item = world.createAuthoredObject(actor, { parent: "$thing", name: "Item" });
    world.moveAuthoredObject(actor, item, container);
    expect(world.object(item).location).toBe(container);
    expect(world.object(container).contents.has(item)).toBe(true);

    await recycleVia(world, actor, container, { force: true });

    expect(world.objects.has(container)).toBe(false);
    expect(world.object(item).location).toBe("$nowhere");
    // $nowhere.contents is not maintained (sink semantics): it stays empty
    // even though item points at it.
    expect(world.object("$nowhere").contents.has(item)).toBe(false);
  });

  it("dry_run: true returns impact without mutating state", async () => {
    const world = createWorld();
    const { actor } = builderActor(world);
    const leaf = world.createAuthoredObject(actor, { parent: "$thing", name: "Leaf" });

    const result = await recycleVia(world, actor, leaf, { dry_run: true }) as Record<string, unknown>;
    expect(result.dry_run).toBe(true);
    expect(result.id).toBe(leaf);
    expect(world.objects.has(leaf)).toBe(true);
    expect(world.tombstones.has(leaf)).toBe(false);
  });

  it("rejects recycle of reserved universal classes with E_INVARG", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    for (const reserved of ["$system", "$nowhere", "$root", "$thing", "$actor", "$player", "$wiz", "$space", "$sequenced_log"]) {
      await expect(recycleVia(world, wiz, reserved, { force: true })).rejects.toMatchObject({ code: "E_INVARG" });
    }
  });

  it("rejects recycle of an object with anchored descendants (E_NACC)", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    const anchorRoot = world.createAuthoredObject(wiz, { parent: "$thing", name: "Anchor Root" });
    // Build an anchored descendant via the engine API. The anchor argument
    // pins the new object's atomicity scope to anchorRoot.
    const anchored = world.createRuntimeObject("$thing", wiz, anchorRoot, { name: "Anchored" });
    expect(world.object(anchored).anchor).toBe(anchorRoot);

    await expect(recycleVia(world, wiz, anchorRoot, { force: true })).rejects.toMatchObject({ code: "E_NACC" });
    expect(world.objects.has(anchorRoot)).toBe(true);
    expect(world.objects.has(anchored)).toBe(true);
  });

  it("create() rejects anchor != null when parent class is self-hosted (E_INVARG)", () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);
    void wiz;

    // Stamp instances_self_host on a class. Once class-level self-hosting
    // lands the property will arrive via catalog manifests; the runtime
    // check fires either way.
    world.defineProperty("$thing", { name: "instances_self_host", defaultValue: true, owner: "$wiz", perms: "r", typeHint: "bool" });

    let caught: unknown = null;
    try {
      world.createRuntimeObject("$thing", wiz, "the_chatroom", { name: "Should Fail" });
    } catch (err) {
      caught = err;
    }
    expect(isErrorValue(caught) && caught.code).toBe("E_INVARG");
  });

  it("equality of dangling refs: two refs to the same recycled ULID compare equal", async () => {
    const world = createWorld();
    const { actor } = builderActor(world);
    const leaf = world.createAuthoredObject(actor, { parent: "$thing", name: "Leaf" });
    const aliasA = leaf;
    const aliasB = String(leaf);
    await recycleVia(world, actor, leaf);
    expect(aliasA).toBe(aliasB);
    expect(world.isRecycled(aliasA)).toBe(true);
    expect(world.isRecycled(aliasB)).toBe(true);
  });

  it("non-owner non-wizard cannot recycle (E_PERM)", async () => {
    const world = createWorld();
    const { actor: ownerActor } = builderActor(world);
    const stranger = world.auth("guest:stranger");
    world.object(stranger.actor).owner = stranger.actor;
    world.chparentAuthoredObject("$wiz", stranger.actor, "$builder");

    const leaf = world.createAuthoredObject(ownerActor, { parent: "$thing", name: "Leaf" });
    await expect(recycleVia(world, stranger.actor, leaf)).rejects.toMatchObject({ code: "E_PERM" });
    expect(world.objects.has(leaf)).toBe(true);
  });
});
