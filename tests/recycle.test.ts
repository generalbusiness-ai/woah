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
    // Direct substrate test path: actor IS the progr (the test simulates a
    // verb whose effective principal is the actor, which is how
    // builder/wizard-tooling tests have always used this helper).
    return world.recycleChecked(actor, actor, target, opts as any);
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

  it("recycled ULIDs round-trip through SQLite (incremental persistence)", async () => {
    const { LocalSQLiteRepository } = await import("../src/server/sqlite-repository");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "recycle-tombstone-"));
    const dbPath = join(dir, "world.db");
    try {
      // First boot: recycle a leaf, persist tombstone via incremental save.
      const repo = new LocalSQLiteRepository(dbPath);
      const world = createWorld({ repository: repo });
      const { actor } = builderActor(world);
      const leaf = world.createAuthoredObject(actor, { parent: "$thing", name: "Leaf" });
      await recycleVia(world, actor, leaf);
      world.persist(true);
      expect(repo.loadTombstones()).toContain(leaf);
      repo.close();

      // Second boot: tombstone is rehydrated from SQLite.
      const repo2 = new LocalSQLiteRepository(dbPath);
      const world2 = createWorld({ repository: repo2 });
      expect(world2.isRecycled(leaf)).toBe(true);
      expect(world2.tombstones.has(leaf)).toBe(true);
      repo2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("does not displace contents whose actual location has drifted away from obj (cache-stale safety)", async () => {
    const world = createWorld();
    const { actor } = builderActor(world);
    const container = world.createAuthoredObject(actor, { parent: "$thing", name: "Container" });
    const item = world.createAuthoredObject(actor, { parent: "$thing", name: "Item" });
    const elsewhere = world.createAuthoredObject(actor, { parent: "$thing", name: "Elsewhere" });

    // Put item in container, then drift the cache: item's real location
    // moves but container.contents still mentions it. Per objects.md §4.3,
    // location is the source of truth; contents is a cache that may drift.
    world.moveAuthoredObject(actor, item, container);
    expect(world.object(container).contents.has(item)).toBe(true);
    world.object(item).location = elsewhere;

    await recycleVia(world, actor, container, { force: true });
    expect(world.objects.has(container)).toBe(false);
    // The item's location was NOT obj at recycle time, so it must NOT be
    // moved to $nowhere by recycle's contents-displacement step.
    expect(world.object(item).location).toBe(elsewhere);
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

  it("rejects recycle of an actor with at least one live session (E_PERM)", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);
    // The wizActor itself has a live session (from world.auth). It also
    // descends from $actor by definition.
    expect(world.hasLiveSessions(wiz)).toBe(true);

    await expect(recycleVia(world, wiz, wiz)).rejects.toMatchObject({ code: "E_PERM" });
    expect(world.objects.has(wiz)).toBe(true);
  });

  it("permits recycle of an actor whose sessions have all expired", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    // Spawn a second actor and let its session lapse, simulating an
    // unbound actor object. expireAllSessions is not exposed, so we
    // delete the session entry directly to model the same condition.
    const secondary = world.auth("guest:soon-stale");
    const secondaryActor = secondary.actor;
    world.sessions.delete(secondary.id);
    expect(world.hasLiveSessions(secondaryActor)).toBe(false);

    // Wizard (or owner) recycles the unbound actor without force; engine
    // grafts it under $actor's parent ($root) and tombstones it.
    await recycleVia(world, wiz, secondaryActor);
    expect(world.objects.has(secondaryActor)).toBe(false);
    expect(world.tombstones.has(secondaryActor)).toBe(true);
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

  it("wiz:force_recycle accepts a universal class that ordinary recycle refuses", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    // Create an isolated descendant of $sequenced_log so the universal
    // class itself has no children that block recycle. We then build a
    // sibling class to force_recycle.
    const klass = world.createAuthoredObject(wiz, { parent: "$sequenced_log", name: "Targetable Log" });
    expect(world.objects.has(klass)).toBe(true);

    // Ordinary recycle works on klass (it's not in the reserved list).
    // To exercise force_recycle's bypass, we recycle $sequenced_log itself
    // — which the reserved list normally refuses, but force_recycle
    // permits provided no descendants remain.
    await recycleVia(world, wiz, klass);

    const result = await world.directCall(`force-${Date.now()}`, wiz, wiz, "force_recycle", ["$sequenced_log", { reason: "test teardown" }]);
    expect(result.op).toBe("result");
    expect(world.objects.has("$sequenced_log")).toBe(false);
    expect(world.tombstones.has("$sequenced_log")).toBe(true);

    // Audit recorded.
    const actions = world.getProp("$system", "wizard_actions") as Array<Record<string, unknown>>;
    const force = actions.find((a) => a.action === "force_recycle");
    expect(force).toBeDefined();
    expect(force!.obj).toBe("$sequenced_log");
    expect(force!.reason).toBe("test teardown");
  });

  it("wiz:force_recycle refuses the hard floor ($system, $root, $nowhere) with E_INVARG", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    for (const reserved of ["$system", "$root", "$nowhere"]) {
      const result = await world.directCall(`force-floor-${reserved}`, wiz, wiz, "force_recycle", [reserved, {}]);
      expect(result.op).toBe("error");
      if (result.op === "error") expect(result.error.code).toBe("E_INVARG");
      expect(world.objects.has(reserved)).toBe(true);
    }
  });

  it("wiz:force_recycle terminates live sessions on actor target", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    // Spawn a guest with a live session.
    const guest = world.auth("guest:force-recycle-target");
    const guestActor = guest.actor;
    expect(world.hasLiveSessions(guestActor)).toBe(true);
    expect(world.sessions.has(guest.id)).toBe(true);

    const result = await world.directCall(`force-actor-${Date.now()}`, wiz, wiz, "force_recycle", [guestActor, {}]);
    expect(result.op).toBe("result");
    if (result.op === "result") {
      const r = result.result as Record<string, unknown>;
      expect(r.sessions_killed).toBe(1);
    }
    // Actor gone, session reaped.
    expect(world.objects.has(guestActor)).toBe(false);
    expect(world.tombstones.has(guestActor)).toBe(true);
    expect(world.sessions.has(guest.id)).toBe(false);

    // Observation emitted on the outer call.
    if (result.op === "result") {
      const obs = result.observations.filter((o) => o.type === "wiz_force_recycle");
      expect(obs).toHaveLength(1);
      expect(obs[0]).toMatchObject({ obj: guestActor, sessions_killed: 1 });
    }
  });

  it("wiz:force_recycle requires wizard authority (E_PERM for non-wizards)", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);
    const programmer = world.auth("guest:programmer");
    world.object(programmer.actor).owner = programmer.actor;
    world.object(programmer.actor).flags.programmer = true;
    world.chparentAuthoredObject("$wiz", programmer.actor, "$programmer");

    const klass = world.createAuthoredObject(wiz, { parent: "$thing", name: "Class" });

    const result = await world.directCall(`force-perm-${Date.now()}`, programmer.actor, programmer.actor, "force_recycle", [klass, {}]);
    expect(result.op).toBe("error");
    if (result.op === "error") expect(result.error.code).toBe("E_PERM");
    expect(world.objects.has(klass)).toBe(true);
  });

  it("$builder:recycle gates on actor authority — a guest promoted to $builder cannot recycle a $wiz-owned object", async () => {
    const world = createWorld();
    // Guest promoted to $builder (programmer + reparented). The catalog
    // gives them access to $builder:recycle as an inherited verb.
    const guest = world.auth("guest:builder-attacker").actor;
    const obj = world.object(guest);
    obj.owner = guest;
    obj.flags.programmer = true;
    world.chparentAuthoredObject("$wiz", guest, "$builder");

    // A $wiz-owned target the guest has no claim on.
    const target = world.createAuthoredObject("$wiz", { parent: "$thing", name: "Wizard target" });
    expect(world.object(target).owner).toBe("$wiz");

    // The substrate `recycle()` builtin gates on the verb's progr (the
    // catalog wizard). Without an actor-side check in the wrapper, the
    // guest could recycle anything by reaching the wrapper. The wrapper
    // must enforce: actor is wizard OR owner of id.
    const result = await world.directCall(`builder-attacker-${Date.now()}`, guest, guest, "recycle", [target, {}]);
    expect(result.op).toBe("error");
    if (result.op === "error") expect(result.error.code).toBe("E_PERM");
    expect(world.objects.has(target)).toBe(true);
  });

  it("$builder:recycle does not let a non-wizard owner smuggle force_reserved through opts", async () => {
    const world = createWorld();
    // Guest promoted to $builder; owns themselves; has a live session
    // (from world.auth). The smuggle scenario: actor IS the target IS the
    // owner, so the wrapper's requires_perm(actor, id) passes trivially.
    // Without the defense, opts.force_reserved propagates to the substrate,
    // which gates force_reserved on the verb's progr (catalog wizard, true)
    // and runs §RC6.1's session-kill + wiz_force_recycle audit for a
    // non-wizard caller.
    const session = world.auth("guest:builder-smuggle");
    const builder = session.actor;
    const obj = world.object(builder);
    obj.owner = builder;
    obj.flags.programmer = true;
    world.chparentAuthoredObject("$wiz", builder, "$builder");
    expect(world.hasLiveSessions(builder)).toBe(true);

    const result = await world.directCall(
      `smuggle-${Date.now()}`,
      builder, builder, "recycle",
      [builder, { force_reserved: true, force: true }]
    );
    expect(result.op).toBe("error");
    if (result.op === "error") {
      expect(["E_PERM", "E_INVARG"]).toContain(result.error.code);
    }
    // Target alive, session intact, no audit, no observation.
    expect(world.objects.has(builder)).toBe(true);
    expect(world.hasLiveSessions(builder)).toBe(true);
    if (result.op === "result") {
      expect(result.observations.filter((o) => o.type === "wiz_force_recycle")).toHaveLength(0);
    }
  });

  it("directory_reconcile_corenames recursively scrubs lists and maps", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    const a = world.createAuthoredObject(wiz, { parent: "$thing", name: "A" });
    const b = world.createAuthoredObject(wiz, { parent: "$thing", name: "B" });
    const c = world.createAuthoredObject(wiz, { parent: "$thing", name: "C" });
    world.defineProperty("$system", { name: "ref_list", defaultValue: [], owner: "$wiz", perms: "rw", typeHint: "list<obj>" });
    world.defineProperty("$system", { name: "ref_map", defaultValue: {}, owner: "$wiz", perms: "rw", typeHint: "map<str,obj>" });
    world.setProp("$system", "ref_list", [a, b, c]);
    world.setProp("$system", "ref_map", { primary: a, fallback: b });

    // Tombstone a directly (without going through recycle, so the
    // post-commit sweep doesn't fire) and then run the janitor.
    world.tombstones.add(a);
    const cleared = world.reconcileTombstoneRefsInSystem();
    expect(cleared).toContain("ref_list");
    expect(cleared).toContain("ref_map");
    expect(world.getProp("$system", "ref_list")).toEqual([b, c]);
    expect(world.getProp("$system", "ref_map")).toEqual({ fallback: b });
  });

  it("wiz:force_recycle re-checks A4 after the handler runs (host-only impl is satisfied)", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    const klass = world.createAuthoredObject(wiz, { parent: "$thing", name: "Class with handler" });
    world.object(klass).flags.fertile = true;
    installVerbAs(world, wiz, klass, "recycle",
      `verb :recycle() rx { observe({ "type": "force_recycle_handler", "obj": this }); return 0; }`,
      null
    );
    const inst = world.createAuthoredObject(wiz, { parent: klass, name: "Instance" });

    const result = await world.directCall(`force-handler-${Date.now()}`, wiz, wiz, "force_recycle", [inst, {}]);
    expect(result.op).toBe("result");
    if (result.op === "result") {
      // The handler observation came through, demonstrating that the
      // handler ran. The post-handler A4 recheck then ran (single-host
      // worlds have no remote refs, so the recheck is a no-op pass) and
      // the apply phase committed.
      const obs = result.observations.filter((o) => o.type === "force_recycle_handler");
      expect(obs).toHaveLength(1);
    }
    expect(world.objects.has(inst)).toBe(false);
    expect(world.tombstones.has(inst)).toBe(true);
  });

  it("verb dispatch falls back to inherited verb after the defining ancestor is recycled (RC3.7)", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    const grand = world.createAuthoredObject(wiz, { parent: "$thing", name: "Grand" });
    world.object(grand).flags.fertile = true;
    installVerbAs(world, wiz, grand, "label", "verb :label() rx { return \"grand\"; }", null);

    const middle = world.createAuthoredObject(wiz, { parent: grand, name: "Middle" });
    world.object(middle).flags.fertile = true;
    installVerbAs(world, wiz, middle, "label", "verb :label() rx { return \"middle\"; }", null);

    const inst = world.createAuthoredObject(wiz, { parent: middle, name: "Instance" });
    expect(world.resolveVerb(inst, "label").definer).toBe(middle);

    // Recycle middle. The :label verb that lived on middle is gone with
    // the storage delete; child grafts up to grand. The next resolve from
    // inst now finds grand's :label, with no stale-cache window.
    await recycleVia(world, wiz, middle, { force: true });
    expect(world.objects.has(middle)).toBe(false);
    expect(world.tombstones.has(middle)).toBe(true);
    expect(world.object(inst).parent).toBe(grand);

    const resolved = world.resolveVerb(inst, "label");
    expect(resolved.definer).toBe(grand);
  });

  it("dispatching to a tombstoned definer surfaces E_OBJNF (no stale-dispatch window)", async () => {
    const world = createWorld();
    const { actor: wiz } = wizActor(world);

    const target = world.createAuthoredObject(wiz, { parent: "$thing", name: "Target" });
    installVerbAs(world, wiz, target, "ping", "verb :ping() rx { return \"pong\"; }", null);
    expect(world.resolveVerb(target, "ping").definer).toBe(target);

    await recycleVia(world, wiz, target);

    // Cached or stale callers that still hold the target ULID and try to
    // dispatch fail at frame setup with E_OBJNF — the lookup path raises
    // before any user code can run on a dead reference.
    const result = await world.directCall(`stale-${Date.now()}`, wiz, target, "ping", []);
    expect(result.op).toBe("error");
    if (result.op === "error") expect(result.error.code).toBe("E_OBJNF");
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
