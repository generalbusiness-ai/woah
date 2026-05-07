import { describe, expect, it } from "vitest";
import { installVerbAs } from "../src/core/authoring";
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
    world.chparentAuthoredObject("$wiz", actor, "$wiz");
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

  it(":recycle handler fires when defined; emits an observation as a side effect", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    const klass = world.createAuthoredObject(wiz, { parent: "$thing", name: "Recyclable Class" });
    world.object(klass).flags.fertile = true;
    const installed = installVerbAs(world, wiz, klass, "recycle",
      `verb :recycle() rx {\n  observe({ "type": "recycled", "obj": this });\n  return 0;\n}`,
      null
    );
    expect(installed.ok).toBe(true);

    const inst = world.createAuthoredObject(wiz, { parent: klass, name: "Instance A" });
    // Sanity: the handler resolves through inheritance.
    const resolved = world.resolveVerb(inst, "recycle");
    expect(resolved.verb.name).toBe("recycle");
    expect(resolved.definer).toBe(klass);

    // Drive recycle through a verb dispatch so observations are visible on
    // the outer call's frame.
    const result = await world.directCall(`recycle-handler-${Date.now()}`, wiz, wiz, "recycle", [inst, {}]);
    expect(result.op).toBe("result");
    expect(world.objects.has(inst)).toBe(false);
    expect(world.tombstones.has(inst)).toBe(true);
    if (result.op === "result") {
      const recycled = result.observations.filter((o) => o.type === "recycled");
      expect(recycled).toHaveLength(1);
      expect(recycled[0]).toMatchObject({ obj: inst });
    }
  });

  it("inherited :recycle handler fires for descendants (LambdaCore pattern)", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    const klass = world.createAuthoredObject(wiz, { parent: "$thing", name: "Base Class" });
    world.object(klass).flags.fertile = true;
    const sub = world.createAuthoredObject(wiz, { parent: klass, name: "Sub Class" });
    world.object(sub).flags.fertile = true;
    installVerbAs(world, wiz, klass, "recycle",
      `verb :recycle() rx {\n  observe({ "type": "recycled", "obj": this });\n  return 0;\n}`,
      null
    );

    const inst = world.createAuthoredObject(wiz, { parent: sub, name: "Sub Instance" });
    const result = await world.directCall(`recycle-inherit-${Date.now()}`, wiz, wiz, "recycle", [inst, {}]);
    expect(result.op).toBe("result");
    expect(world.objects.has(inst)).toBe(false);
    if (result.op === "result") {
      const recycled = result.observations.filter((o) => o.type === "recycled");
      expect(recycled).toHaveLength(1);
      expect(recycled[0]).toMatchObject({ obj: inst });
    }
  });

  it("clears stale $system property bindings after recycle (step 10 sweep)", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    const target = world.createAuthoredObject(wiz, { parent: "$thing", name: "Target" });
    // Stamp a corename-shaped binding on $system.
    world.defineProperty("$system", { name: "my_special_obj", defaultValue: null, owner: "$wiz", perms: "rw", typeHint: "obj" });
    world.setProp("$system", "my_special_obj", target);
    expect(world.getProp("$system", "my_special_obj")).toBe(target);

    await recycleVia(world, wiz, target);

    // After recycle, the binding should be cleared so $system.my_special_obj
    // no longer points at a tombstoned ULID.
    expect(world.getProp("$system", "my_special_obj")).toBeNull();
    expect(world.tombstones.has(target)).toBe(true);
  });

  it("directory_reconcile_corenames is idempotent and reports cleared bindings", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    const a = world.createAuthoredObject(wiz, { parent: "$thing", name: "A" });
    const b = world.createAuthoredObject(wiz, { parent: "$thing", name: "B" });
    world.defineProperty("$system", { name: "link_a", defaultValue: null, owner: "$wiz", perms: "rw", typeHint: "obj" });
    world.defineProperty("$system", { name: "link_b", defaultValue: null, owner: "$wiz", perms: "rw", typeHint: "obj" });
    world.setProp("$system", "link_a", a);
    world.setProp("$system", "link_b", b);

    // Recycle clears link_a as part of step 10.
    await recycleVia(world, wiz, a);
    expect(world.getProp("$system", "link_a")).toBeNull();
    expect(world.getProp("$system", "link_b")).toBe(b);

    // Tombstone b directly to simulate a missed step-10 sweep, then run
    // the wizard janitor.
    world.tombstones.add(b);
    const cleared = world.reconcileTombstoneRefsInSystem();
    expect(cleared).toContain("link_b");
    expect(world.getProp("$system", "link_b")).toBeNull();

    // Idempotent: running again with no tombstoned bindings returns [].
    expect(world.reconcileTombstoneRefsInSystem()).toEqual([]);
  });

  it("editor sessions referencing a recycled target are cleaned lazily on next access", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    // Build a target verb to edit, open an editor session, then recycle
    // the target. The editor's stored session is stale until the actor
    // next opens or accesses it.
    const target = world.createAuthoredObject(wiz, { parent: "$thing", name: "Edit Target" });
    installVerbAs(world, wiz, target, "noop", "verb :noop() rx { return 0; }", null);
    const opened = await world.directCall(`open-${Date.now()}`, wiz, wiz, "edit_verb", [target, "noop", {}]);
    expect(opened.op).toBe("result");

    // Sanity: the session is stored on the editor.
    const sessions = world.getProp("the_verb_editor", "sessions") as Record<string, unknown>;
    expect(sessions[wiz]).toBeDefined();

    // Recycle the target. The session is now stale.
    await recycleVia(world, wiz, target, { force: true });
    expect(world.tombstones.has(target)).toBe(true);

    // Next access (e.g., view) on the editor instance raises a
    // no-active-session error because the lazy filter drops the stale
    // session — even though the disk entry still exists. (Persisted
    // cleanup is a wizard-janitor concern; the engine just makes stale
    // sessions unreachable on read.)
    const viewed = await world.directCall(`view-${Date.now()}`, wiz, "the_verb_editor", "view", [{}]);
    expect(viewed.op).toBe("error");
    if (viewed.op === "error") expect(viewed.error.code).toBe("E_INVARG");
  });

  it("kills parked tasks anchored to the recycled object", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    const target = world.createAuthoredObject(wiz, { parent: "$thing", name: "Target Space" });

    // Inject a parked task referencing the target. The internal parked-task
    // counter is private but `world.parkedTasks` is the source of truth.
    const taskId = "ptask_test_kill";
    world.parkedTasks.set(taskId, {
      id: taskId,
      parked_on: target,
      state: "suspended",
      resume_at: Date.now() + 60_000,
      awaiting_player: null,
      correlation_id: null,
      serialized: { kind: "test" } as never,
      created: Date.now(),
      origin: target
    });
    expect(world.parkedTasks.has(taskId)).toBe(true);

    await recycleVia(world, wiz, target, { force: true });
    expect(world.parkedTasks.has(taskId)).toBe(false);
    expect(world.objects.has(target)).toBe(false);
  });

  it(":recycle handler raise is caught; recycle proceeds and $recycle_handler_error is observed", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    const klass = world.createAuthoredObject(wiz, { parent: "$thing", name: "Raising Class" });
    world.object(klass).flags.fertile = true;
    const installed = installVerbAs(world, wiz, klass, "recycle",
      `verb :recycle() rx { raise { code: "E_INVARG", message: "handler said no", value: this }; }`,
      null
    );
    expect(installed.ok).toBe(true);
    const inst = world.createAuthoredObject(wiz, { parent: klass, name: "Bad Citizen" });

    // Drive recycle through the verb path so observations land on the
    // dispatch frame.
    const result = await world.directCall(`recycle-raise-${Date.now()}`, wiz, wiz, "recycle", [inst, {}]);
    expect(result.op).toBe("result");
    expect(world.objects.has(inst)).toBe(false);
    expect(world.tombstones.has(inst)).toBe(true);

    // The handler raise was caught and surfaced as a $recycle_handler_error
    // observation on the outer call's observation list.
    if (result.op === "result") {
      const errObs = result.observations.filter((o) => o.type === "$recycle_handler_error");
      expect(errObs).toHaveLength(1);
      expect(errObs[0]).toMatchObject({ obj: inst, code: "E_INVARG" });
    }
  });
});
