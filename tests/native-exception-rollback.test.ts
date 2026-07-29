import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import { installVerb } from "../src/core/authoring";
import { installCatalogManifest, type CatalogManifest } from "../src/core/catalog-installer";
import { effectTranscriptFromRecordedTurn } from "../src/core/effect-transcript";
import { authoritativePlanningWorld } from "../src/core/planning-world";
import { runShadowTurnCallTranscript } from "../src/core/shadow-turn-call";
import {
  createShadowExecutionNode,
  executeShadowTurnCallOrNeedState
} from "../src/core/shadow-turn-exec";
import { InMemoryTurnRecorder } from "../src/core/turn-recorder";
import type { ExecutorContext, NativeHandler, WooWorld } from "../src/core/world";
import type { SerializedWorld, WorldRepository } from "../src/core/repository";
import { deepFreezePlainValue, isDeeplyFrozen, wooError } from "../src/core/types";
import { JsonFolderWorldRepository } from "../src/server/json-folder-repository";
import { LocalSQLiteRepository } from "../src/server/sqlite-repository";
import { message, nativeVerb } from "./core-support";

function addDirectNative(world: WooWorld, target: string, name: string, handler: NativeHandler): void {
  if (!world.objects.has(target)) {
    world.createObject({ id: target, name: target, parent: "$thing", owner: "$wiz" });
  }
  const native = `test_${target}_${name}`;
  world.registerNativeHandler(native, handler);
  world.addVerb(target, {
    ...nativeVerb(name, native),
    perms: "rxd",
    direct_callable: true,
    skip_presence_check: true
  });
}

describe("native exception rollback", () => {
  it.each(["set", "define"] as const)(
    "restores array elements truncated through a permitted length %s",
    async (operation) => {
      const world = createWorld();
      world.createObject({ id: "array_truncate_subject", parent: "$thing", owner: "$wiz" });
      world.defineProperty("array_truncate_subject", {
        name: "items",
        defaultValue: ["a", "b", "c"],
        owner: "$wiz",
        perms: "rw",
        typeHint: "list"
      });
      addDirectNative(world, "array_truncate_controller", "truncate_then_fail", () => {
        const authoritative = world.objects
          .get("array_truncate_subject")!
          .properties.get("items") as unknown as string[];
        (world as unknown as { withBehaviorMutationPermit<T>(fn: () => T): T })
          .withBehaviorMutationPermit(() => {
            if (operation === "set") authoritative.length = 1;
            else Object.defineProperty(authoritative, "length", { value: 1 });
          });
        throw wooError("E_TEST_ARRAY_TRUNCATE", "expected array rollback");
      });

      const frame = await world.directCall(
        `array-truncate-${operation}`,
        "$wiz",
        "array_truncate_controller",
        "truncate_then_fail",
        []
      );

      expect(frame).toMatchObject({ op: "error", error: { code: "E_TEST_ARRAY_TRUNCATE" } });
      expect(world.getProp("array_truncate_subject", "items")).toEqual(["a", "b", "c"]);
    }
  );

  it("brands a deep-frozen value only after successful acyclic freezing", () => {
    const mutable: { nested: { count: number }; extra?: number } = { nested: { count: 1 } };
    const throwing = new Proxy(mutable, {
      preventExtensions: () => {
        throw new Error("freeze refused");
      }
    });

    expect(() => deepFreezePlainValue(throwing)).toThrow("freeze refused");
    expect(isDeeplyFrozen(throwing)).toBe(false);
    mutable.extra = 1;
    expect(mutable.extra).toBe(1);

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => deepFreezePlainValue(cyclic)).toThrow(/cyclic/);
    expect(isDeeplyFrozen(cyclic)).toBe(false);
  });

  it("detaches thrown ErrorValue data from applied frames and replay logs", async () => {
    const world = createWorld();
    const held = { nested: { count: 1 } };
    addDirectNative(world, "error_alias_controller", "fail", () => {
      throw wooError("E_TEST_ERROR_ALIAS", "expected", held);
    });

    const frame = await world.applyCall(
      "error-alias",
      "the_dubspace",
      message("$wiz", "error_alias_controller", "fail", [])
    );
    held.nested.count = 9;

    expect(frame.observations).toContainEqual(expect.objectContaining({
      type: "$error",
      code: "E_TEST_ERROR_ALIAS",
      value: { nested: { count: 1 } }
    }));
    expect(world.replay("the_dubspace", frame.seq, 1)[0]?.observations).toContainEqual(
      expect.objectContaining({
        type: "$error",
        code: "E_TEST_ERROR_ALIAS",
        value: { nested: { count: 1 } }
      })
    );
  });

  it("publishes JSON-folder saves by one atomic generation manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-json-atomic-save-"));
    try {
      const repository = new JsonFolderWorldRepository(dir);
      const world = createWorld();
      const before = world.exportWorld();
      repository.save(before);
      const bad = structuredClone(before);
      bad.objects.push({
        id: "zz_partial_generation",
        name: "Partial generation",
        parent: "$thing",
        owner: "$wiz",
        anchor: null,
        location: null,
        flags: {},
        properties: [["bad", 1n as unknown as never]],
        propertyDefs: [],
        propertyVersions: [],
        verbs: [],
        eventSchemas: [],
        children: [],
        contents: [],
        created: 0,
        modified: 0
      });

      expect(() => repository.save(bad)).toThrow();
      expect(new JsonFolderWorldRepository(dir).load()).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns detached presence collections which cannot poison derived caches", () => {
    const world = createWorld();
    const session = world.auth("guest:presence-egress");
    world.setProp("the_dubspace", "subscribers", [session.actor]);
    world.setProp("the_dubspace", "session_subscribers", [{
      session: session.id,
      actor: session.actor
    }]);

    const actors = world.presenceActorsIn("the_dubspace") as Set<string>;
    const sessions = world.presenceSessionsIn("the_dubspace") as Map<string, string>;
    actors.clear();
    sessions.clear();

    expect(world.presenceActorsIn("the_dubspace")).toEqual(new Set([session.actor]));
    expect(world.presenceSessionsIn("the_dubspace")).toEqual(new Map([[session.id, session.actor]]));
  });

  it("transfers a terminal sequenced command into one top-level authoritative turn", async () => {
    const world = createWorld();
    const session = world.auth("guest:terminal-command-transfer");
    const actor = session.actor;
    expect((await world.directCall(
      "terminal-transfer-enter",
      actor,
      actor,
      "moveto",
      ["the_dubspace"],
      { sessionId: session.id }
    )).op).toBe("result");
    world.createObject({
      id: "terminal_transfer_wrapper",
      name: "Terminal transfer wrapper",
      parent: "$thing",
      owner: actor,
      location: "the_dubspace"
    });
    world.defineProperty("terminal_transfer_wrapper", {
      name: "marker",
      defaultValue: 0,
      owner: actor,
      perms: "rw",
      typeHint: "int"
    });
    expect(installVerb(
      world,
      "terminal_transfer_wrapper",
      "transfer",
      `verb :transfer(plan) rxd {
        try {
          return execute_command_plan(plan);
        } except err {
          return "caught";
        }
      }`,
      null
    ).ok).toBe(true);
    expect(installVerb(
      world,
      "terminal_transfer_wrapper",
      "dirty_transfer",
      `verb :dirty_transfer(plan) rxd {
        this.marker = 1;
        return execute_command_plan(plan);
      }`,
      null
    ).ok).toBe(true);
    expect(installVerb(
      world,
      "terminal_transfer_wrapper",
      "return_plan",
      `verb :return_plan(plan) rxd {
        return plan;
      }`,
      null
    ).ok).toBe(true);
    expect(installVerb(
      world,
      "the_dubspace",
      "terminal_transfer_target",
      `verb :terminal_transfer_target(value) rx {
        return value;
      }`,
      null
    ).ok).toBe(true);

    const plan = {
      ok: true,
      route: "sequenced",
      space: "the_dubspace",
      target: "the_dubspace",
      verb: "terminal_transfer_target",
      args: [42]
    };
    const beforeSeq = Number(world.getProp("the_dubspace", "next_seq"));
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const applied = await world.directCall(
      "terminal-transfer-one-turn",
      actor,
      "terminal_transfer_wrapper",
      "transfer",
      [plan],
      { sessionId: session.id }
    );

    expect(applied).toMatchObject({
      op: "applied",
      id: "terminal-transfer-one-turn",
      space: "the_dubspace",
      seq: beforeSeq,
      message: {
        actor,
        target: "the_dubspace",
        verb: "terminal_transfer_target",
        args: [42]
      },
      result: 42
    });
    expect(world.getProp("the_dubspace", "next_seq")).toBe(beforeSeq + 1);
    expect(recorder.turns).toHaveLength(1);
    expect(recorder.turns[0].start).toMatchObject({
      id: "terminal-transfer-one-turn",
      route: "sequenced",
      scope: "the_dubspace",
      seq: beforeSeq,
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "terminal_transfer_target"
    });
    expect(recorder.turns[0].events.filter((event) => event.kind === "turn_start")).toHaveLength(1);
    expect(recorder.turns[0].events.filter((event) => event.kind === "turn_finish")).toHaveLength(1);
    expect(recorder.turns[0].events).toContainEqual(expect.objectContaining({
      kind: "dispatch",
      target: "terminal_transfer_wrapper",
      verb: "transfer"
    }));

    recorder.turns.length = 0;
    const beforeRefusalSeq = Number(world.getProp("the_dubspace", "next_seq"));
    const refused = await world.directCall(
      "terminal-transfer-dirty-refusal",
      actor,
      "terminal_transfer_wrapper",
      "dirty_transfer",
      [plan],
      { sessionId: session.id }
    );
    expect(refused).toMatchObject({ op: "error", error: { code: "E_SCOPE_SPLIT" } });
    expect(world.getProp("terminal_transfer_wrapper", "marker")).toBe(0);
    expect(world.getProp("the_dubspace", "next_seq")).toBe(beforeRefusalSeq);
    expect(recorder.turns).toHaveLength(1);
    expect(recorder.turns[0].start.route).toBe("direct");

    recorder.turns.length = 0;
    const ordinary = await world.directCall(
      "terminal-transfer-ordinary-map",
      actor,
      "terminal_transfer_wrapper",
      "return_plan",
      [plan],
      { sessionId: session.id }
    );
    expect(ordinary).toMatchObject({ op: "result", result: plan });
    expect(world.getProp("the_dubspace", "next_seq")).toBe(beforeRefusalSeq);
    expect(recorder.turns).toHaveLength(1);
    expect(recorder.turns[0].start.route).toBe("direct");
  });

  it("refuses terminal transfer when a wrapper wrote before nested programmer eval", async () => {
    const world = createWorld();
    const session = world.auth("guest:nested-eval-transfer");
    const actor = session.actor;
    world.migrationSetObjectOwner(actor, actor);
    world.setCatalogObjectFlags(actor, { programmer: true });
    world.chparentAuthoredObject("$wiz", actor, "$programmer");
    world.createObject({
      id: "nested_eval_transfer_wrapper",
      name: "Nested eval transfer wrapper",
      parent: "$thing",
      owner: actor
    });
    world.defineProperty("nested_eval_transfer_wrapper", {
      name: "marker",
      defaultValue: 0,
      owner: actor,
      perms: "rw",
      typeHint: "int"
    });
    expect(installVerb(
      world,
      "the_dubspace",
      "nested_eval_transfer_target",
      `verb :nested_eval_transfer_target() rx { return 42; }`,
      null
    ).ok).toBe(true);
    const plan = {
      ok: true,
      route: "sequenced",
      space: "the_dubspace",
      target: "the_dubspace",
      verb: "nested_eval_transfer_target",
      args: []
    };
    const evalSource = `execute_command_plan(${JSON.stringify(plan)})`;
    addDirectNative(world, "nested_eval_transfer_wrapper", "run", async (ctx) => {
      world.setProp("nested_eval_transfer_wrapper", "marker", 1);
      return await world.dispatch(
        { ...ctx, caller: ctx.thisObj, callerPerms: ctx.progr },
        actor,
        "eval",
        [evalSource, {}]
      );
    });
    const beforeSeq = Number(world.getProp("the_dubspace", "next_seq"));

    const frame = await world.directCall(
      "nested-eval-transfer-refusal",
      actor,
      "nested_eval_transfer_wrapper",
      "run",
      [],
      { sessionId: session.id }
    );

    expect(frame).toMatchObject({
      op: "error",
      error: {
        code: "E_SCOPE_SPLIT"
      }
    });
    if (frame.op === "error") {
      expect(Number((frame.error.value as { mutations?: number } | undefined)?.mutations ?? 0)).toBeGreaterThan(0);
    }
    expect(world.getProp("nested_eval_transfer_wrapper", "marker")).toBe(0);
    expect(world.getProp("the_dubspace", "next_seq")).toBe(beforeSeq);
  });

  it("answers an exact terminal-transfer retry before rerunning its wrapper", async () => {
    const world = createWorld();
    const session = world.auth("guest:terminal-transfer-retry");
    world.createObject({ id: "terminal_retry_subject", parent: "$thing", owner: "$wiz" });
    world.defineProperty("terminal_retry_subject", {
      name: "marker",
      defaultValue: 0,
      owner: "$wiz",
      perms: "rw",
      typeHint: "int"
    });
    let wrapperRuns = 0;
    let targetRuns = 0;
    addDirectNative(world, "terminal_retry_target", "commit", () => {
      targetRuns += 1;
      world.setProp("terminal_retry_subject", "marker", 1);
      return "accepted once";
    });
    addDirectNative(world, "terminal_retry_wrapper", "route", (ctx) => {
      wrapperRuns += 1;
      if (world.getProp("terminal_retry_subject", "marker") === 1) {
        return "divergent direct retry";
      }
      return world.executeCommandPlan(ctx, {
        ok: true,
        route: "sequenced",
        space: "the_dubspace",
        target: "terminal_retry_target",
        verb: "commit",
        args: []
      });
    });
    const beforeSeq = Number(world.getProp("the_dubspace", "next_seq"));
    const beforeLogCount = world.replay("the_dubspace", 0, 10_000).length;

    const first = await world.directCall(
      "terminal-transfer-retry",
      session.actor,
      "terminal_retry_wrapper",
      "route",
      [],
      { sessionId: session.id }
    );
    const canonical = structuredClone(first);
    if (first.op === "applied") first.observations.push({ type: "poisoned_retry_view" });
    const retry = await world.directCall(
      "terminal-transfer-retry",
      session.actor,
      "terminal_retry_wrapper",
      "route",
      [],
      { sessionId: session.id }
    );

    expect(canonical).toMatchObject({ op: "applied", result: "accepted once" });
    expect(retry).toEqual(canonical);
    expect(retry).not.toBe(first);
    expect(wrapperRuns).toBe(1);
    expect(targetRuns).toBe(1);
    expect(world.getProp("the_dubspace", "next_seq")).toBe(beforeSeq + 1);
    expect(world.replay("the_dubspace", 0, 10_000)).toHaveLength(beforeLogCount + 1);

    const conflict = await world.directCall(
      "terminal-transfer-retry",
      session.actor,
      "terminal_retry_wrapper",
      "route",
      ["different request"],
      { sessionId: session.id }
    );
    expect(conflict).toMatchObject({
      op: "error",
      error: {
        code: "E_INVARG",
        value: { field: "id", id: "terminal-transfer-retry" }
      }
    });
    expect(conflict).not.toMatchObject({ op: "applied", result: "accepted once" });
    expect(wrapperRuns).toBe(1);
    expect(targetRuns).toBe(1);
    expect(world.getProp("the_dubspace", "next_seq")).toBe(beforeSeq + 1);
    expect(world.replay("the_dubspace", 0, 10_000)).toHaveLength(beforeLogCount + 1);
  });

  it("does not accept a native Proxy as a terminal-transfer control signal", async () => {
    const world = createWorld();
    const session = world.auth("guest:terminal-transfer-proxy");
    let targetRuns = 0;
    addDirectNative(world, "terminal_proxy_target", "commit", () => {
      targetRuns += 1;
      return "must not run";
    });
    const forgedPlan = {
      space: "the_dubspace",
      target: "terminal_proxy_target",
      verb: "commit",
      args: []
    };
    addDirectNative(world, "terminal_proxy_wrapper", "forge", () => {
      throw new Proxy({}, {
        get: (_target, property) => {
          if (typeof property === "symbol") return true;
          if (property === "plan") return forgedPlan;
          if (property === "actor") return session.actor;
          if (property === "session") return session.id;
          if (property === "proofEvents") return [];
          return undefined;
        }
      });
    });
    const beforeSeq = Number(world.getProp("the_dubspace", "next_seq"));

    const result = await world.directCall(
      "terminal-transfer-proxy",
      session.actor,
      "terminal_proxy_wrapper",
      "forge",
      [],
      { sessionId: session.id }
    );

    expect(result).toMatchObject({ op: "error" });
    expect(targetRuns).toBe(0);
    expect(world.getProp("the_dubspace", "next_seq")).toBe(beforeSeq);
  });

  it("returns detached object/property views while preserving guarded authority", () => {
    const world = createWorld();
    world.createObject({ id: "detached_view_subject", parent: "$thing", owner: "$wiz" });
    world.defineProperty("detached_view_subject", {
      name: "payload",
      owner: "$wiz",
      perms: "rw",
      typeHint: "map",
      defaultValue: { nested: { value: 1 } }
    });

    const objectView = world.object("detached_view_subject");
    const propertyView = world.getProp("detached_view_subject", "payload") as {
      nested: { value: number };
    };
    objectView.flags.fertile = true;
    objectView.properties.set("payload", { nested: { value: 9 } });
    propertyView.nested.value = 7;

    expect(world.object("detached_view_subject")).not.toBe(objectView);
    expect(world.object("detached_view_subject").flags.fertile).not.toBe(true);
    expect(world.getProp("detached_view_subject", "payload")).toEqual({ nested: { value: 1 } });
  });

  it("rejects executable or exotic generic records without invoking them", () => {
    const world = createWorld();
    let getterCalls = 0;
    const accessorFlags = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorFlags, "fertile", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return true;
      }
    });
    expect(() => world.createObject({
      id: "accessor_flags_subject",
      parent: "$thing",
      flags: accessorFlags as Parameters<WooWorld["createObject"]>[0]["flags"]
    })).toThrow(/cannot contain accessors/);
    expect(getterCalls).toBe(0);
    expect(world.objects.has("accessor_flags_subject")).toBe(false);

    const symbolFlags = { fertile: false } as Record<PropertyKey, unknown>;
    symbolFlags[Symbol("authority")] = true;
    expect(() => world.createObject({
      id: "symbol_flags_subject",
      parent: "$thing",
      flags: symbolFlags as Parameters<WooWorld["createObject"]>[0]["flags"]
    })).toThrow(/symbol keys/);

    const exoticFlags = Object.create({ fertile: true }) as Record<string, unknown>;
    expect(() => world.createObject({
      id: "prototype_flags_subject",
      parent: "$thing",
      flags: exoticFlags as Parameters<WooWorld["createObject"]>[0]["flags"]
    })).toThrow(/plain or null prototype/);
  });

  it("keeps authoritative log and snapshot proxy identity stable but detaches snapshot egress", async () => {
    const world = createWorld();
    addDirectNative(world, "stable_row_controller", "ok", () => true);
    await world.applyCall(
      "stable-log-row",
      "the_dubspace",
      message("$wiz", "stable_row_controller", "ok", [])
    );

    const firstLog = world.logs.get("the_dubspace")!;
    const secondLog = world.logs.get("the_dubspace")!;
    expect(secondLog).toBe(firstLog);
    expect(secondLog[0]).toBe(firstLog[0]);

    const returned = world.saveSnapshot("the_dubspace");
    const firstSnapshot = world.snapshots.at(-1)!;
    const secondSnapshot = world.snapshots.at(-1)!;
    expect(secondSnapshot).toBe(firstSnapshot);
    expect(secondSnapshot.state).toBe(firstSnapshot.state);
    expect(returned).not.toBe(firstSnapshot);
    (returned.state as Record<string, unknown>).injected = true;
    expect(world.latestSnapshot("the_dubspace")?.state).not.toHaveProperty("injected");
  });

  it("does not leak mutation wrappers into reusable catalog/import inputs", () => {
    const manifest: CatalogManifest = {
      name: "wrapper-reuse",
      version: "1.0.0",
      spec_version: "v1",
      classes: [{
        local_name: "$wrapper_reuse",
        parent: "$thing",
        properties: [{
          name: "payload",
          type: "map",
          default: { nested: { count: 1 } }
        }]
      }]
    };

    // This is deliberately a bounded repetition of the production pattern:
    // bundled manifest objects live at module scope and are reused across
    // independently-created worlds. The old in-place wrapper installed the
    // prior world's proxies into `manifest`, so each iteration added another
    // Proxy-of-Proxy layer until descriptor lookup recursed indefinitely.
    for (let index = 0; index < 32; index += 1) {
      const world = createWorld({ catalogs: false });
      installCatalogManifest(world, manifest, {
        tap: "@local",
        alias: "wrapper-reuse"
      });
      const imported = createWorldFromSerialized(world.exportWorld(), { persist: false });
      expect(imported.getProp("$wrapper_reuse", "payload")).toEqual({ nested: { count: 1 } });
      expect(structuredClone(manifest)).toEqual(manifest);
    }
  });

  it("keeps reused caller values isolated under their receiving object row", async () => {
    const world = createWorld();
    const sharedFlags = { fertile: false };
    world.createObject({ id: "shared_row_a", parent: "$thing", owner: "$wiz", flags: sharedFlags });
    world.createObject({ id: "shared_row_b", parent: "$thing", owner: "$wiz", flags: sharedFlags });

    expect(world.object("shared_row_a").flags).not.toBe(world.object("shared_row_b").flags);
    addDirectNative(world, "shared_row_controller", "write_b", () => {
      world.setObjectFlags("$wiz", "shared_row_b", { fertile: true });
      return true;
    });

    expect(await world.directCall("shared-row-write", "$wiz", "shared_row_controller", "write_b", []))
      .toMatchObject({ op: "result", result: true });
    expect(world.object("shared_row_a").flags.fertile).not.toBe(true);
    expect(world.object("shared_row_b").flags.fertile).toBe(true);
  });

  it("does not exempt an ordinary Woo map merely because its key is bytecode", async () => {
    const world = createWorld();
    world.createObject({ id: "bytecode_map_subject", parent: "$thing", owner: "$wiz" });
    world.defineProperty("bytecode_map_subject", {
      name: "payload",
      owner: "$wiz",
      perms: "rw",
      typeHint: "map",
      defaultValue: { bytecode: { mutable: 1 } }
    });
    const payload = world.objects.get("bytecode_map_subject")!.properties.get("payload") as {
      bytecode: { mutable: number };
    };
    addDirectNative(world, "bytecode_map_controller", "mutate", () => {
      payload.bytecode.mutable = 2;
      return true;
    });

    expect(await world.directCall("bytecode-map-mutate", "$wiz", "bytecode_map_controller", "mutate", []))
      .toMatchObject({ op: "error", error: { code: "E_INTERNAL" } });
    expect(payload.bytecode.mutable).toBe(1);
  });

  it("freezes authoritative runtime bytecode against cached native mutation", async () => {
    const world = createWorld();
    world.createObject({ id: "frozen_bytecode_subject", parent: "$thing", owner: "$wiz" });
    expect(installVerb(
      world,
      "frozen_bytecode_subject",
      "value",
      "verb :value() rxd { return 1; }",
      null
    ).ok).toBe(true);
    const verb = world.ownVerbExact("frozen_bytecode_subject", "value");
    if (!verb || verb.kind !== "bytecode") throw new Error("expected bytecode verb");
    const cachedBytecode = verb.bytecode;
    addDirectNative(world, "frozen_bytecode_controller", "mutate", () => {
      cachedBytecode.max_ticks = 1;
      return true;
    });

    const result = await world.directCall(
      "raw-bytecode-mutation",
      "$wiz",
      "frozen_bytecode_controller",
      "mutate",
      []
    );

    expect(result.op).toBe("error");
    expect(cachedBytecode.max_ticks).not.toBe(1);
    expect(Object.isFrozen(cachedBytecode)).toBe(true);
    expect(Object.isFrozen(cachedBytecode.ops)).toBe(true);
  });

  it("refuses descriptor and prototype mutation on authoritative records", async () => {
    const world = createWorld();
    world.createObject({ id: "descriptor_subject", parent: "$thing", owner: "$wiz" });
    const flags = world.objects.get("descriptor_subject")!.flags;
    addDirectNative(world, "descriptor_controller", "define", () => {
      Object.defineProperty(flags, "fertile", { value: true, configurable: true });
      return true;
    });
    addDirectNative(world, "descriptor_controller", "prototype", () => {
      Object.setPrototypeOf(flags, { polluted: true });
      return true;
    });
    addDirectNative(world, "descriptor_controller", "freeze", () => {
      Object.freeze(flags);
      return true;
    });

    expect(await world.directCall("descriptor-define", "$wiz", "descriptor_controller", "define", []))
      .toMatchObject({ op: "error", error: { code: "E_INTERNAL" } });
    expect(await world.directCall("descriptor-prototype", "$wiz", "descriptor_controller", "prototype", []))
      .toMatchObject({ op: "error", error: { code: "E_INTERNAL" } });
    expect(await world.directCall("descriptor-freeze", "$wiz", "descriptor_controller", "freeze", []))
      .toMatchObject({ op: "error", error: { code: "E_INTERNAL" } });
    expect(flags.fertile).not.toBe(true);
    expect(Object.getPrototypeOf(flags)).toBeNull();
    expect(Object.isExtensible(flags)).toBe(true);
  });

  it("refuses Map/Set prototype-call and freeze bypasses", async () => {
    const world = createWorld();
    world.createObject({ id: "collection_subject", parent: "$thing", owner: "$wiz" });
    const properties = world.objects.get("collection_subject")!.properties;
    const contents = world.objects.get("collection_subject")!.contents;
    addDirectNative(world, "collection_controller", "map_call", () => {
      Map.prototype.set.call(properties, "bypass", 1);
      return true;
    });
    addDirectNative(world, "collection_controller", "set_call", () => {
      Set.prototype.add.call(contents, "bypass");
      return true;
    });
    addDirectNative(world, "collection_controller", "freeze", () => {
      Object.freeze(properties);
      return true;
    });

    expect((await world.directCall("collection-map-call", "$wiz", "collection_controller", "map_call", [])).op).toBe("error");
    expect((await world.directCall("collection-set-call", "$wiz", "collection_controller", "set_call", [])).op).toBe("error");
    expect((await world.directCall("collection-freeze", "$wiz", "collection_controller", "freeze", [])).op).toBe("error");
    expect(properties.has("bypass")).toBe(false);
    expect(contents.has("bypass")).toBe(false);
    expect(Object.isExtensible(properties)).toBe(true);
  });

  it("refuses raw authoritative mutation even when a native would otherwise succeed", async () => {
    const world = createWorld();
    world.createObject({ id: "raw_subject", name: "Raw subject", parent: "$thing", owner: "$wiz" });
    const cachedFlags = world.objects.get("raw_subject")!.flags;
    addDirectNative(world, "raw_controller", "mutate", () => {
      cachedFlags.fertile = true;
      return true;
    });

    const result = await world.directCall("raw-success", "$wiz", "raw_controller", "mutate", []);

    expect(result).toMatchObject({ op: "error", error: { code: "E_INTERNAL" } });
    expect(world.object("raw_subject").flags.fertile).not.toBe(true);
  });

  it("refuses raw mutation through a cached nested snapshot row", async () => {
    const world = createWorld();
    world.saveSnapshot("the_dubspace");
    const cachedState = world.snapshots[0].state as Record<string, unknown>;
    const before = structuredClone(world.exportWorld().snapshots);
    addDirectNative(world, "snapshot_controller", "mutate", () => {
      cachedState.injected = true;
      return true;
    });

    const result = await world.directCall(
      "raw-snapshot-mutation",
      "$wiz",
      "snapshot_controller",
      "mutate",
      []
    );

    expect(result).toMatchObject({ op: "error", error: { code: "E_INTERNAL" } });
    expect(world.exportWorld().snapshots).toEqual(before);
    expect(cachedState).not.toHaveProperty("injected");
  });

  it("does not trust a shallow-frozen property wrapper with mutable children", async () => {
    const world = createWorld();
    world.createObject({ id: "shallow_subject", name: "Shallow subject", parent: "$thing", owner: "$wiz" });
    world.defineProperty("shallow_subject", {
      name: "payload",
      owner: "$wiz",
      perms: "rwc",
      typeHint: "map",
      defaultValue: null
    });
    const supplied = Object.freeze({ nested: { count: 1 } });
    world.setProp("shallow_subject", "payload", supplied);
    const authoritative = world.objects.get("shallow_subject")!.properties.get("payload") as {
      nested: { count: number };
    };
    expect(authoritative).not.toBe(supplied);
    addDirectNative(world, "shallow_controller", "mutate", () => {
      authoritative.nested.count = 2;
      return true;
    });

    const result = await world.directCall("shallow-success", "$wiz", "shallow_controller", "mutate", []);

    expect(result).toMatchObject({ op: "error", error: { code: "E_INTERNAL" } });
    expect(authoritative.nested.count).toBe(1);
  });

  it("keeps cached row and nested-container identities authoritative across a caught inner abort", async () => {
    const world = createWorld();
    world.createObject({ id: "cached_subject", name: "Cached subject", parent: "$thing", owner: "$wiz" });
    world.defineProperty("cached_subject", {
      name: "payload",
      defaultValue: { nested: { value: 1 } },
      owner: "$wiz",
      perms: "rw",
      typeHint: "map"
    });
    const cachedObject = world.objects.get("cached_subject")!;
    const cachedFlags = cachedObject.flags;
    const cachedProperties = cachedObject.properties;
    const cachedValue = cachedProperties.get("payload");
    addDirectNative(world, "cached_controller", "mutate", () => {
      try {
        world.withMutationSavepoint(() => {
          world.setObjectFlags("$wiz", "cached_subject", { fertile: true });
          world.setProp("cached_subject", "payload", { nested: { value: 2 } });
          throw wooError("E_INNER", "expected inner abort");
        });
      } catch {
        // The outer native verifies and then commits through a supported seam.
      }
      expect(world.objects.get("cached_subject")).toBe(cachedObject);
      expect(cachedObject.flags).toBe(cachedFlags);
      expect(cachedObject.properties).toBe(cachedProperties);
      expect(cachedProperties.get("payload")).toBe(cachedValue);
      world.setProp("cached_subject", "payload", { nested: { value: 3 } });
      return true;
    });

    expect(await world.directCall("cached-inner", "$wiz", "cached_controller", "mutate", []))
      .toMatchObject({ op: "result", result: true });
    expect(world.getProp("cached_subject", "payload")).toEqual({ nested: { value: 3 } });
    expect(world.object("cached_subject").flags.fertile).not.toBe(true);
  });

  it.each(["importWorld", "repairDerivedContentsIndex"] as const)(
    "refuses out-of-band %s inside behavior execution",
    async (operation) => {
      const world = createWorld();
      const exported = world.exportWorld();
      addDirectNative(world, "bulk_controller", "mutate", () => {
        if (operation === "importWorld") world.importWorld(exported);
        else world.repairDerivedContentsIndex();
        return true;
      });

      const result = await world.directCall(`bulk-${operation}`, "$wiz", "bulk_controller", "mutate", []);

      expect(result).toMatchObject({ op: "error", error: { code: "E_INTERNAL" } });
    }
  );

  it("refuses orchestration-hook replacement during behavior and preserves the installed hook", async () => {
    const world = createWorld();
    const seen: string[] = [];
    world.setMetricsHook((event) => seen.push(event.kind));
    addDirectNative(world, "hook_controller", "replace", () => {
      world.setMetricsHook(() => seen.push("replacement"));
      return true;
    });

    const result = await world.directCall("hook-replace", "$wiz", "hook_controller", "replace", []);
    world.recordMetric({ kind: "behavior_hook_probe" } as unknown as Parameters<WooWorld["recordMetric"]>[0]);

    expect(result).toMatchObject({ op: "error", error: { code: "E_INTERNAL" } });
    expect(seen).toContain("behavior_hook_probe");
    expect(seen).not.toContain("replacement");
  });

  it("resets per-turn scheduling state even when no recorder is installed", async () => {
    const world = createWorld();
    addDirectNative(world, "schedule_controller", "schedule_one", (ctx) =>
      ctx.world.recordScheduleRequest(ctx, "schedule_controller", "schedule_one", [], { delayMs: 60_000 })
    );

    for (let i = 0; i < 40; i += 1) {
      expect(await world.directCall(`schedule-without-recorder-${i}`, "$wiz", "schedule_controller", "schedule_one", []))
        .toMatchObject({ op: "result" });
    }
  });

  it("tracks mutated rows rather than unrelated authority size", async () => {
    const measure = async (unrelated: number) => {
      const world = createWorld();
      for (let i = 0; i < unrelated; i += 1) {
        world.createObject({ id: `unrelated_${i}`, name: `Unrelated ${i}`, parent: "$thing", owner: "$wiz" });
      }
      world.createObject({ id: "bounded_subject", name: "Bounded subject", parent: "$thing", owner: "$wiz" });
      world.defineProperty("bounded_subject", { name: "counter", defaultValue: 0, owner: "$wiz", perms: "rw", typeHint: "int" });
      addDirectNative(world, "bounded_controller", "write_one", () => {
        world.setProp("bounded_subject", "counter", 1);
        return true;
      });
      expect((await world.directCall(`bounded-${unrelated}`, "$wiz", "bounded_controller", "write_one", [])).op).toBe("result");
      return world.behaviorUndoStatsForTesting();
    };

    const small = await measure(10);
    const loaded = await measure(2_000);

    expect(small).not.toBeNull();
    expect(loaded).toEqual(small);
    expect(loaded!.objects).toBeLessThan(10);
    expect(loaded!.sessions).toBe(0);
  });

  it("refuses raw clear before capturing a loaded authoritative set", async () => {
    const run = async (size: number) => {
      const world = createWorld();
      for (let i = 0; i < size; i += 1) world.migrationSetTombstone(`loaded_tombstone_${i}`, true);
      addDirectNative(world, "set_controller", "clear", () => {
        world.tombstones.clear();
        return true;
      });

      const result = await world.directCall(`loaded-set-${size}`, "$wiz", "set_controller", "clear", []);

      expect(result).toMatchObject({ op: "error", error: { code: "E_INTERNAL" } });
      expect(world.tombstones.size).toBe(size);
      return world.behaviorUndoStatsForTesting();
    };

    expect(await run(10)).toEqual(await run(20_000));
    expect((await run(1_000))?.tombstones).toBe(0);
  });

  it("retains proofs and logical inputs while discarding aborted domain effects", () => {
    const recorder = new InMemoryTurnRecorder();
    const active = recorder.startTurn({
      route: "direct",
      scope: "#-1",
      seq: -1,
      actor: "$wiz",
      target: "$wiz",
      verb: "test",
      args: []
    });

    active.event({ kind: "logical_input", name: "envelope_before", value: 1 });
    active.beginBehaviorScope();
    active.event({ kind: "logical_input", name: "outer", value: 2 });
    active.event({ kind: "prop_write", object: "$wiz", name: "discarded", hadValue: false, after: 1, changed: true });
    active.beginBehaviorScope();
    active.event({ kind: "logical_input", name: "inner", value: 3 });
    active.event({ kind: "untracked_effect", name: "escaped_inner" });
    active.commitBehaviorScope();
    active.event({ kind: "logical_input", name: "outer_after_inner", value: 4 });
    active.abortBehaviorScope();
    active.event({ kind: "logical_input", name: "envelope_after", value: 5 });

    expect(recorder.turns[0].events).toEqual([
      expect.objectContaining({ kind: "turn_start" }),
      { kind: "logical_input", name: "envelope_before", value: 1 },
      { kind: "logical_input", name: "outer", value: 2 },
      { kind: "logical_input", name: "inner", value: 3 },
      { kind: "untracked_effect", name: "escaped_inner" },
      { kind: "logical_input", name: "outer_after_inner", value: 4 },
      { kind: "logical_input", name: "envelope_after", value: 5 }
    ]);
  });

  it("discards orphan proofs for objects created and rolled back in the same behavior scope", () => {
    const recorder = new InMemoryTurnRecorder();
    const active = recorder.startTurn({
      route: "sequenced",
      scope: "room",
      seq: 7,
      actor: "$wiz",
      target: "controller",
      verb: "test",
      args: []
    });

    active.beginBehaviorScope();
    active.event({ kind: "prop_read", object: "durable", name: "counter", value: 1, version: 2 });
    active.event({
      kind: "object_create",
      object: "transient",
      name: "Transient",
      parent: "$thing",
      owner: "$wiz",
      anchor: "room",
      location: "room",
      flags: {}
    });
    active.event({ kind: "prop_read", object: "transient", name: "owner", value: "$wiz", version: 1 });
    active.event({ kind: "cell_read", cell: { kind: "lifecycle", object: "transient" }, value: "created", version: "1" });
    active.event({ kind: "state_probe", cell: { kind: "prop", object: "transient", name: "text" } });
    active.event({
      kind: "dispatch",
      target: "transient",
      verb: "local",
      definer: "transient",
      implementation: "bytecode",
      owner: "$wiz"
    });
    // An inherited dispatch still proves a durable class verb page even
    // though its receiver disappears.
    active.event({
      kind: "dispatch",
      target: "transient",
      verb: "inherited",
      definer: "$thing",
      implementation: "bytecode",
      owner: "$wiz"
    });
    active.beginBehaviorScope();
    active.event({ kind: "prop_read", object: "transient", name: "text", value: "", version: 1 });
    active.commitBehaviorScope();
    active.event({ kind: "logical_input", name: "now", value: 123 });
    active.abortBehaviorScope();

    expect(recorder.turns[0].events).toEqual([
      expect.objectContaining({ kind: "turn_start" }),
      { kind: "prop_read", object: "durable", name: "counter", value: 1, version: 2 },
      {
        kind: "dispatch",
        target: "transient",
        verb: "inherited",
        definer: "$thing",
        implementation: "bytecode",
        owner: "$wiz"
      },
      { kind: "logical_input", name: "now", value: 123 }
    ]);
  });

  it("keeps the durable property proof but drops read-back of a rolled-back property write", () => {
    const recorder = new InMemoryTurnRecorder();
    const active = recorder.startTurn({
      route: "direct",
      scope: "room",
      seq: 0,
      actor: "$wiz",
      target: "controller",
      verb: "write_then_fail",
      args: []
    });

    active.beginBehaviorScope();
    active.event({ kind: "prop_read", object: "subject", name: "counter", value: 1, version: 4 });
    active.event({
      kind: "prop_write",
      object: "subject",
      name: "counter",
      hadValue: true,
      before: 1,
      after: 2,
      changed: true,
      beforeVersion: 4,
      afterVersion: 5
    });
    active.event({ kind: "prop_read", object: "subject", name: "counter", value: 2, version: 5 });
    active.event({ kind: "state_probe", cell: { kind: "prop", object: "subject", name: "counter" } });
    active.abortBehaviorScope();

    expect(recorder.turns[0].events).toEqual([
      expect.objectContaining({ kind: "turn_start" }),
      { kind: "prop_read", object: "subject", name: "counter", value: 1, version: 4 }
    ]);
  });

  it("drops location and contents proofs observed after a rolled-back move", () => {
    const recorder = new InMemoryTurnRecorder();
    const active = recorder.startTurn({
      route: "direct",
      scope: "room",
      seq: 0,
      actor: "$wiz",
      target: "controller",
      verb: "move_then_fail",
      args: []
    });

    active.beginBehaviorScope();
    active.event({ kind: "cell_read", cell: { kind: "location", object: "subject" }, value: "old_room", version: "v1" });
    active.event({ kind: "object_move", object: "subject", from: "old_room", to: "new_room" });
    active.event({ kind: "cell_read", cell: { kind: "location", object: "subject" }, value: "new_room", version: "v2" });
    active.event({ kind: "state_probe", cell: { kind: "contents", object: "old_room" } });
    active.event({ kind: "state_probe", cell: { kind: "contents", object: "new_room" } });
    active.abortBehaviorScope();

    expect(recorder.turns[0].events).toEqual([
      expect.objectContaining({ kind: "turn_start" }),
      { kind: "cell_read", cell: { kind: "location", object: "subject" }, value: "old_room", version: "v1" }
    ]);
  });

  it("drops lifecycle and dispatch proofs observed after a rolled-back recycle", () => {
    const recorder = new InMemoryTurnRecorder();
    const active = recorder.startTurn({
      route: "direct",
      scope: "room",
      seq: 0,
      actor: "$wiz",
      target: "controller",
      verb: "recycle_then_fail",
      args: []
    });

    active.beginBehaviorScope();
    active.event({ kind: "cell_read", cell: { kind: "lifecycle", object: "subject" }, value: "live", version: "v1" });
    active.event({
      kind: "projection_write",
      write: { table: "tombstones", key: "subject", op: "upsert", row: { id: "subject" }, bytes: 16 }
    });
    active.event({ kind: "state_probe", cell: { kind: "lifecycle", object: "subject" } });
    active.event({
      kind: "dispatch",
      target: "subject",
      verb: "inherited",
      definer: "$thing",
      implementation: "bytecode",
      owner: "$wiz"
    });
    active.abortBehaviorScope();

    expect(recorder.turns[0].events).toEqual([
      expect.objectContaining({ kind: "turn_start" }),
      { kind: "cell_read", cell: { kind: "lifecycle", object: "subject" }, value: "live", version: "v1" }
    ]);
  });

  it("applies proof invalidation across committed nested scopes but not an aborted inner mutation", () => {
    const recorder = new InMemoryTurnRecorder();
    const active = recorder.startTurn({
      route: "direct",
      scope: "room",
      seq: 0,
      actor: "$wiz",
      target: "controller",
      verb: "nested_failure",
      args: []
    });

    active.beginBehaviorScope();
    active.event({
      kind: "cell_write",
      cell: { kind: "verb", object: "controller", name: "changed" },
      value: { implementation: "bytecode" },
      op: "replace"
    });
    active.beginBehaviorScope();
    active.event({
      kind: "dispatch",
      target: "controller",
      verb: "changed",
      definer: "controller",
      implementation: "bytecode",
      owner: "$wiz"
    });
    active.commitBehaviorScope();

    active.beginBehaviorScope();
    active.event({
      kind: "prop_write",
      object: "subject",
      name: "inner_only",
      hadValue: false,
      after: true,
      changed: true
    });
    active.event({ kind: "prop_read", object: "subject", name: "inner_only", value: true, version: 1 });
    active.abortBehaviorScope();
    // The inner mutation was already restored. This proof therefore describes
    // the durable state seen by the outer scope and may survive its abort.
    active.event({ kind: "state_probe", cell: { kind: "prop", object: "subject", name: "inner_only" } });
    active.abortBehaviorScope();

    expect(recorder.turns[0].events).toEqual([
      expect.objectContaining({ kind: "turn_start" }),
      { kind: "state_probe", cell: { kind: "prop", object: "subject", name: "inner_only" } }
    ]);
  });

  it("preserves incompleteness when a transient lineage invalidates an untracked native dispatch proof", () => {
    const recorder = new InMemoryTurnRecorder();
    const active = recorder.startTurn({
      route: "direct",
      scope: "room",
      seq: 0,
      actor: "$wiz",
      target: "controller",
      verb: "untracked_after_chparent",
      args: []
    });

    active.beginBehaviorScope();
    active.event({
      kind: "cell_write",
      cell: { kind: "lifecycle", object: "subject" },
      value: { parent: "transient_parent" },
      op: "set"
    });
    active.event({
      kind: "dispatch",
      target: "subject",
      verb: "untracked",
      definer: "transient_parent",
      implementation: "native",
      native: "unregistered_test_native",
      owner: "$wiz",
      dependencies: [{ kind: "lineage", object: "subject" }]
    });
    active.abortBehaviorScope();
    active.event({
      kind: "turn_finish",
      ok: false,
      error: { code: "E_EXPECTED", message: "expected", value: null, trace: [] }
    });

    expect(recorder.turns[0].events).toContainEqual({
      kind: "incomplete_evidence",
      reason: "native:subject:untracked"
    });
    expect(recorder.turns[0].events).not.toContainEqual(expect.objectContaining({
      kind: "dispatch",
      verb: "untracked"
    }));
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript.reads).toEqual([]);
    expect(transcript.complete).toBe(false);
    expect(transcript.incompleteReasons).toContain("native:subject:untracked");
  });

  it("does not retain a failed create as a same-run ordered parent", async () => {
    const world = createWorld();
    world.setRequireOrderedChildrenProjection(true);
    let failedParent = "";
    addDirectNative(world, "ordered_create_controller", "probe_after_abort", () => {
      try {
        world.withMutationSavepoint(() => {
          failedParent = world.createRuntimeObject(
            "$thing",
            "$wiz",
            null,
            { progr: "$wiz", name: "Failed ordered parent" }
          );
          throw wooError("E_INNER", "abort ordered parent create");
        });
      } catch {
        // The follow-up read distinguishes a real missing authority projection
        // from a stale "created in this execution" exemption.
      }
      return world.orderedChildrenProjection(failedParent, "the_dubspace");
    });

    const result = await world.directCall(
      "ordered-create-cache-rollback",
      "$wiz",
      "ordered_create_controller",
      "probe_after_abort",
      []
    );

    expect(result).toMatchObject({ op: "error", error: { code: "E_NEED_ORDERED_CHILDREN" } });
    expect(world.objects.has(failedParent)).toBe(false);
  });

  it.each(["write", "recycle"] as const)(
    "does not retain a failed ordered-edge %s in follow-up neighbour reads",
    async (operation) => {
      const world = createWorld();
      world.createObject({ id: "ordered_cache_child", parent: "$thing", owner: "$wiz" });
      world.defineProperty("ordered_cache_child", {
        name: "__ordered_edge",
        defaultValue: null,
        owner: "$wiz",
        perms: "rwc",
        typeHint: "map|null"
      });
      const query = { parent: null, index: null, exclude: null, child: null };
      const expected = { count: 0, index: 0, before: null, after: null, child_index: null };
      world.installOrderedNeighborsProjection("the_dubspace", query, expected);
      world.setRequireOrderedChildrenProjection(true);
      addDirectNative(world, "ordered_cache_controller", "probe_after_abort", async (ctx) => {
        try {
          await world.withMutationSavepoint(async () => {
            if (operation === "write") {
              world.setProp("ordered_cache_child", "__ordered_edge", { parent: null, rank: "V" });
            } else {
              await world.recycleChecked("$wiz", "$wiz", "ordered_cache_child", { force: true }, ctx);
            }
            throw wooError("E_INNER", "abort ordered edge mutation");
          });
        } catch {
          // Follow-up answer must use the exact pre-turn neighbour projection.
        }
        return world.orderedNeighborsProjection(null, query, "the_dubspace");
      });

      const result = await world.directCall(
        `ordered-${operation}-cache-rollback`,
        "$wiz",
        "ordered_cache_controller",
        "probe_after_abort",
        []
      );

      expect(result).toMatchObject({ op: "result", result: expected });
      expect(world.objects.has("ordered_cache_child")).toBe(true);
      expect(world.propOrNull("ordered_cache_child", "__ordered_edge")).toBeNull();
    }
  );

  it("retains an aborted schedule clock but discards its effect before an outer schedule", async () => {
    const world = createWorld();
    addDirectNative(world, "nested_schedule_controller", "schedule_after_abort", (ctx) => {
      try {
        world.withMutationSavepoint(() => {
          world.recordScheduleRequest(ctx, "nested_schedule_controller", "schedule_after_abort", [], { delayMs: 60_000 });
          throw wooError("E_INNER", "abort first schedule");
        });
      } catch {
        // The turn continues with the same recorded logical clock.
      }
      return world.recordScheduleRequest(
        ctx,
        "nested_schedule_controller",
        "schedule_after_abort",
        [],
        { delayMs: 120_000 }
      );
    });
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const result = await world.directCall(
      "nested-schedule-clock",
      "$wiz",
      "nested_schedule_controller",
      "schedule_after_abort",
      []
    );

    expect(result).toMatchObject({ op: "result" });
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript.logicalInputs.filter((input) => input.name === "schedule.now")).toHaveLength(1);
    expect(transcript.schedules).toHaveLength(1);
    expect(transcript.schedules?.[0].id).toBe(result.op === "result" ? result.result : null);
  });

  it("rolls back direct property versions, lineage, creation, and recorder effects", async () => {
    const world = createWorld();
    world.createObject({ id: "rollback_subject", name: "Rollback subject", parent: "$thing", owner: "$wiz" });
    world.defineProperty("rollback_subject", { name: "counter", defaultValue: 0, owner: "$wiz", perms: "rw", typeHint: "int" });
    addDirectNative(world, "rollback_controller", "mutate_then_fail", (ctx) => {
      ctx.world.setProp("rollback_subject", "counter", 1);
      ctx.world.setObjectFlags("$wiz", "rollback_subject", { fertile: true });
      ctx.world.createRuntimeObject("$thing", "$wiz", null, { progr: "$wiz", name: "Rollback leak" });
      ctx.observe?.({ type: "should_not_escape", source: "rollback_subject" });
      throw wooError("E_TEST_ROLLBACK", "expected rollback");
    });
    const before = structuredClone(world.exportWorld());
    const beforeVersion = world.object("rollback_subject").propertyVersions.get("counter");
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const result = await world.directCall("direct-rollback", "$wiz", "rollback_controller", "mutate_then_fail", []);

    expect(result).toMatchObject({ op: "error", error: { code: "E_TEST_ROLLBACK" } });
    expect(world.exportWorld()).toEqual(before);
    expect(world.object("rollback_subject").propertyVersions.get("counter")).toBe(beforeVersion);
    expect(Array.from(world.objects.values()).some((object) => object.name === "Rollback leak")).toBe(false);
    expect(world.hasPendingPersistence()).toBe(false);
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript.error?.code).toBe("E_TEST_ROLLBACK");
    expect(transcript.writes).toEqual([]);
    expect(transcript.creates).toEqual([]);
    expect(transcript.observations).toEqual([]);
  });

  it("finishes every inverse, preserves the original error, and poisons a world after restore failure", async () => {
    const world = createWorld();
    world.createObject({ id: "poison_subject", name: "Poison subject", parent: "$thing", owner: "$wiz" });
    world.defineProperty("poison_subject", { name: "first", defaultValue: 0, owner: "$wiz", perms: "rw", typeHint: "int" });
    world.defineProperty("poison_subject", { name: "second", defaultValue: 0, owner: "$wiz", perms: "rw", typeHint: "int" });
    const internals = world as unknown as {
      behaviorUndoScopes: Array<{ undos: Array<() => void> }>;
    };
    addDirectNative(world, "poison_controller", "fail_restore", () => {
      world.setProp("poison_subject", "first", 1);
      // Place a hostile inverse between two real writes. LIFO abort must still
      // restore the later and earlier rows around this failure.
      internals.behaviorUndoScopes.at(-1)?.undos.push(() => {
        throw wooError("E_TEST_UNDO", "injected inverse failure");
      });
      world.setProp("poison_subject", "second", 2);
      throw wooError("E_TEST_ORIGINAL", "preserve this behavior error");
    });
    addDirectNative(world, "poison_controller", "after", () => "must not run");

    const failed = await world.directCall("poison-fail", "$wiz", "poison_controller", "fail_restore", []);

    expect(failed).toMatchObject({ op: "error", error: { code: "E_TEST_ORIGINAL" } });
    expect(world.behaviorRollbackRequiresReload()).toBe(true);
    expect(world.getProp("poison_subject", "first")).toBe(0);
    expect(world.getProp("poison_subject", "second")).toBe(0);
    const refused = await world.directCall("poison-after", "$wiz", "poison_controller", "after", []);
    expect(refused).toMatchObject({
      op: "error",
      error: {
        code: "E_WORLD_POISONED",
        value: { restore_error: "E_TEST_UNDO" }
      }
    });
    expect(() => world.setProp("poison_subject", "first", 3)).toThrow(
      expect.objectContaining({ code: "E_WORLD_POISONED" })
    );
    expect(() => world.persist(true)).toThrow(
      expect.objectContaining({ code: "E_WORLD_POISONED" })
    );
    expect(() => (
      world as unknown as { flushIncrementalState(): void }
    ).flushIncrementalState()).toThrow(
      expect.objectContaining({ code: "E_WORLD_POISONED" })
    );
  });

  it("makes a shadow host discard a poisoned cached world after the original error frame", async () => {
    const world = createWorld();
    world.createObject({ id: "host_poison_subject", parent: "$thing", owner: "$wiz" });
    world.defineProperty("host_poison_subject", {
      name: "value",
      defaultValue: 0,
      owner: "$wiz",
      perms: "rw",
      typeHint: "int"
    });
    const internals = world as unknown as {
      behaviorUndoScopes: Array<{ undos: Array<() => void> }>;
    };
    world.createObject({ id: "host_poison_controller", parent: "$thing", owner: "$wiz" });
    world.addVerb("host_poison_controller", {
      ...nativeVerb("fail_restore", "set_quota"),
      perms: "rxd",
      direct_callable: true,
      skip_presence_check: true
    });
    // Reuse a transcript-tracked built-in slot so the authority accepts the
    // clean failed transcript; otherwise the ordinary incomplete-native
    // rejection would discard the cache independently of the poison signal.
    world.registerNativeHandler("set_quota", () => {
      world.setProp("host_poison_subject", "value", 1);
      internals.behaviorUndoScopes.at(-1)?.undos.push(() => {
        throw wooError("E_TEST_HOST_UNDO", "injected host inverse failure");
      });
      throw wooError("E_TEST_HOST_ORIGINAL", "preserve host behavior error");
    });
    const serialized = world.exportWorld();
    const node = createShadowExecutionNode({
      node: "host-poison-executor",
      scope: "$wiz",
      serialized,
      authoritative_state: true
    });
    // The host cache already contains its warm execution world. The test-only
    // native handler is intentionally not serializable; losing this exact
    // reference is what proves the host performed the discard.
    node.world = world;
    const call = {
      kind: "woo.turn_call.shadow.v1" as const,
      id: "host-poison-call",
      route: "direct" as const,
      scope: "$wiz",
      actor: "$wiz",
      target: "host_poison_controller",
      verb: "fail_restore",
      args: []
    };
    const result = await executeShadowTurnCallOrNeedState(node, {
      kind: "woo.turn.exec.request.shadow.v1",
      id: call.id,
      call,
      key: {
        kind: "woo.turn_key.shadow.v1",
        scope: "$wiz",
        epoch: "shadow",
        actor: "$wiz",
        target: call.target,
        verb: call.verb,
        effects: 0,
        preimages: [],
        atom_hashes: [],
        read_preimages: [],
        read_atom_hashes: [],
        write_preimages: [],
        write_atom_hashes: [],
        accept_preimages: [],
        accept_atom_hashes: []
      }
    });

    expect(result.ok).toBe(true);
    expect(result.frame).toMatchObject({
      op: "error",
      error: { code: "E_TEST_HOST_ORIGINAL" }
    });
    expect(world.behaviorRollbackRequiresReload()).toBe(true);
    expect(node.world).toBeUndefined();
    expect(node.serialized).toEqual(serialized);
  });

  it("refuses to discard staged durable acceptance under persistence deferral", () => {
    const world = createWorld();
    const internals = world as unknown as {
      withBehaviorSavepoint<T>(fn: () => T): T;
      acceptNowOrWithOuterBehavior(accept: () => void): void;
    };
    let accepted = false;

    expect(() => world.withPersistenceDeferred(() =>
      internals.withBehaviorSavepoint(() => {
        internals.acceptNowOrWithOuterBehavior(() => {
          accepted = true;
        });
        return true;
      })
    )).toThrow(expect.objectContaining({
      code: "E_INTERNAL",
      message: "durable behavior acceptance cannot commit inside persistence deferral"
    }));
    expect(accepted).toBe(false);
  });

  it.each(["result enrichment", "live audience resolution"] as const)(
    "keeps %s inside the direct acceptance boundary",
    async (faultAt) => {
      const world = createWorld();
      world.createObject({ id: "acceptance_subject", name: "Acceptance subject", parent: "$thing", owner: "$wiz" });
      world.defineProperty("acceptance_subject", { name: "counter", defaultValue: 0, owner: "$wiz", perms: "rw", typeHint: "int" });
      addDirectNative(world, "acceptance_controller", "write", () => {
        world.setProp("acceptance_subject", "counter", 1);
        return true;
      });
      const fault = async (): Promise<never> => {
        throw wooError("E_TEST_ACCEPTANCE_READ", `fault during ${faultAt}`);
      };
      if (faultAt === "result enrichment") {
        (world as unknown as { enrichScopedMoveResult: typeof fault }).enrichScopedMoveResult = fault;
      } else {
        (world as unknown as { directLiveAudiences: typeof fault }).directLiveAudiences = fault;
      }

      const result = await world.directCall(`acceptance-${faultAt}`, "$wiz", "acceptance_controller", "write", []);

      expect(result).toMatchObject({ op: "error", error: { code: "E_TEST_ACCEPTANCE_READ" } });
      expect(world.getProp("acceptance_subject", "counter")).toBe(0);
      expect(world.hasPendingPersistence()).toBe(false);
    }
  );

  it("keeps an accepted direct result when post-accept host-effect delivery throws", async () => {
    const world = createWorld();
    world.createObject({ id: "delivery_subject", name: "Delivery subject", parent: "$thing", owner: "$wiz" });
    world.defineProperty("delivery_subject", { name: "counter", defaultValue: 0, owner: "$wiz", perms: "rw", typeHint: "int" });
    const metrics: string[] = [];
    world.setMetricsHook((event) => metrics.push(event.kind));
    addDirectNative(world, "delivery_controller", "write", (ctx) => {
      world.setProp("delivery_subject", "counter", 1);
      ctx.deferHostEffect?.({
        kind: "move_object",
        obj: "delivery_subject",
        target: "$nowhere"
      });
      return "accepted";
    });

    const result = await world.directCall(
      "post-accept-delivery",
      "$wiz",
      "delivery_controller",
      "write",
      [],
      { deferHostEffect: () => { throw wooError("E_TEST_DELIVERY", "post-accept sink failed"); } }
    );

    expect(result).toMatchObject({ op: "result", result: "accepted" });
    expect(world.getProp("delivery_subject", "counter")).toBe(1);
    expect(metrics).toContain("direct_host_effect_delivery");
  });

  it("does not hold an accepted result open for a pending post-accept delivery", async () => {
    const world = createWorld();
    addDirectNative(world, "pending_delivery_controller", "deliver", (ctx) => {
      ctx.deferHostEffect?.({
        kind: "space_subscriber",
        space: "the_chatroom",
        actor: "$wiz",
        present: true
      });
      return "accepted";
    });
    const pending = new Promise<void>(() => undefined);

    const result = await Promise.race([
      world.directCall(
        "pending-delivery",
        "$wiz",
        "pending_delivery_controller",
        "deliver",
        [],
        { deferHostEffect: () => pending }
      ),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 250))
    ]);

    expect(result).not.toBe("timed_out");
    expect(result).toMatchObject({ op: "result", result: "accepted" });
  });

  it("assembles a repository sequenced audience before durable acceptance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-audience-acceptance-"));
    const path = join(dir, "world.sqlite");
    try {
      const repository = new LocalSQLiteRepository(path);
      const world = createWorld({ repository });
      world.createObject({ id: "audience_subject", name: "Audience subject", parent: "$thing", owner: "$wiz" });
      world.defineProperty("audience_subject", { name: "counter", defaultValue: 0, owner: "$wiz", perms: "rw", typeHint: "int" });
      addDirectNative(world, "audience_controller", "write", () => {
        world.setProp("audience_subject", "counter", 1);
        return true;
      });
      const before = structuredClone(world.exportWorld());
      (world as unknown as { appliedFrameAudience: () => never }).appliedFrameAudience = () => {
        throw wooError("E_TEST_AUDIENCE_ASSEMBLY", "fault before durable acceptance");
      };

      await expect(world.applyCall(
        "audience-assembly",
        "the_chatroom",
        message("$wiz", "audience_controller", "write", [])
      )).rejects.toMatchObject({ code: "E_TEST_AUDIENCE_ASSEMBLY" });
      expect(world.exportWorld()).toEqual(before);
      repository.close();

      const restartedRepository = new LocalSQLiteRepository(path);
      const restarted = createWorld({ repository: restartedRepository });
      expect(restarted.getProp("audience_subject", "counter")).toBe(0);
      expect(restarted.getProp("the_chatroom", "next_seq")).toBe(
        before.objects.find((object) => object.id === "the_chatroom")?.properties.find(([name]) => name === "next_seq")?.[1]
      );
      restartedRepository.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back a full-save repository refusal and flushes the next accepted turn", async () => {
    let stored: SerializedWorld | null = null;
    let refuseSave = false;
    const repository: WorldRepository = {
      load: () => stored ? structuredClone(stored) : null,
      save: (world) => {
        if (refuseSave) {
          throw wooError("E_TEST_FULL_SAVE", "injected whole-world persistence refusal");
        }
        stored = structuredClone(world);
      }
    };
    const world = createWorld({ repository });
    world.createObject({ id: "full_save_subject", parent: "$thing", owner: "$wiz" });
    world.defineProperty("full_save_subject", {
      name: "counter",
      defaultValue: 0,
      owner: "$wiz",
      perms: "rw",
      typeHint: "int"
    });
    addDirectNative(world, "full_save_controller", "write", () => {
      world.setProp("full_save_subject", "counter", 1);
      return true;
    });
    const before = structuredClone(world.exportWorld());
    const durableBefore = structuredClone(stored);
    refuseSave = true;

    await expect(world.applyCall(
      "full-save-refusal",
      "the_dubspace",
      message("$wiz", "full_save_controller", "write", [])
    )).rejects.toMatchObject({ code: "E_TEST_FULL_SAVE" });
    expect(world.exportWorld()).toEqual(before);
    expect(stored).toEqual(durableBefore);

    refuseSave = false;
    const accepted = await world.applyCall(
      "full-save-accepted",
      "the_dubspace",
      message("$wiz", "full_save_controller", "write", [])
    );
    expect(accepted.op).toBe("applied");
    expect(world.getProp("full_save_subject", "counter")).toBe(1);
    expect(stored).toEqual(world.exportWorld());
  });

  it("rolls back subscriber-scrub throttling so an immediate retry repairs stale rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-subscriber-scrub-rollback-"));
    const path = join(dir, "world.sqlite");
    try {
      const repository = new LocalSQLiteRepository(path);
      const world = createWorld({ repository });
      world.createObject({
        id: "stale_scrub_actor",
        parent: "$player",
        owner: "$wiz",
        location: "$nowhere"
      });
      world.setProp("the_dubspace", "subscribers", ["stale_scrub_actor"]);
      world.setProp("the_dubspace", "session_subscribers", [{
        session: "missing-stale-session",
        actor: "stale_scrub_actor"
      }]);
      addDirectNative(world, "scrub_retry_controller", "ok", () => true);
      const saveProperty = repository.saveProperty.bind(repository);
      let refuse = true;
      repository.saveProperty = ((id, property) => {
        if (refuse) throw wooError("E_TEST_SCRUB_ACCEPTANCE", "reject after scrub");
        saveProperty(id, property);
      }) as typeof repository.saveProperty;

      await expect(world.applyCall(
        "subscriber-scrub-refused",
        "the_dubspace",
        message("$wiz", "scrub_retry_controller", "ok", [])
      )).rejects.toMatchObject({ code: "E_TEST_SCRUB_ACCEPTANCE" });
      expect(world.getProp("the_dubspace", "subscribers")).toEqual(["stale_scrub_actor"]);
      expect(
        (world as unknown as { lastSubscriberScrubAt: Map<string, number> })
          .lastSubscriberScrubAt.has("the_dubspace")
      ).toBe(false);

      refuse = false;
      const accepted = await world.applyCall(
        "subscriber-scrub-retry",
        "the_dubspace",
        message("$wiz", "scrub_retry_controller", "ok", [])
      );
      expect(accepted.op).toBe("applied");
      expect(world.getProp("the_dubspace", "subscribers")).toEqual([]);
      expect(world.getProp("the_dubspace", "session_subscribers")).toEqual([]);
      repository.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores transient room-roster projections after a failed planned move", async () => {
    const world = createWorld();
    const session = world.auth("guest:roster-projection-rollback");
    expect((await world.directCall(
      "roster-projection-enter",
      session.actor,
      session.actor,
      "moveto",
      ["the_chatroom"],
      { sessionId: session.id }
    )).op).toBe("result");
    const sourceRows = [{
      player: session.actor,
      name: world.object(session.actor).name,
      connected: true,
      location: "the_chatroom",
      presence: "awake"
    }];
    const destinationRows = [{
      player: "guest_other",
      name: "Other",
      connected: true,
      location: "the_deck",
      presence: "awake"
    }];
    world.installRoomRosterProjection("the_chatroom", sourceRows);
    world.installRoomRosterProjection("the_deck", destinationRows);
    world.setTurnRecorder(new InMemoryTurnRecorder());
    addDirectNative(world, "roster_projection_controller", "move_then_fail", async (ctx) => {
      await world.movetoChecked(ctx, session.actor, "the_deck");
      throw wooError("E_TEST_ROSTER_PROJECTION", "expected failure after transient roster move");
    });

    const failed = await world.directCall(
      "roster-projection-fail",
      session.actor,
      "roster_projection_controller",
      "move_then_fail",
      [],
      { sessionId: session.id }
    );

    expect(failed).toMatchObject({ op: "error", error: { code: "E_TEST_ROSTER_PROJECTION" } });
    expect(world.roomRosterProjection("the_chatroom")).toEqual(sourceRows);
    expect(world.roomRosterProjection("the_deck")).toEqual(destinationRows);
    expect(world.sessions.get(session.id)?.activeScope).toBe("the_chatroom");
  });

  it("commits an ordinary multi-row direct behavior in one SQLite transaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-direct-atomic-flush-"));
    const path = join(dir, "world.sqlite");
    try {
      const repository = new LocalSQLiteRepository(path);
      const world = createWorld({ repository });
      for (const id of ["atomic_row_a", "atomic_row_b"]) {
        world.createObject({ id, parent: "$thing", owner: "$wiz" });
        world.defineProperty(id, {
          name: "counter",
          defaultValue: 0,
          owner: "$wiz",
          perms: "rw",
          typeHint: "int"
        });
      }
      addDirectNative(world, "atomic_flush_controller", "write_two", () => {
        world.setProp("atomic_row_a", "counter", 1);
        world.setProp("atomic_row_b", "counter", 1);
        return true;
      });
      const before = structuredClone(world.exportWorld());
      const saveProperty = repository.saveProperty.bind(repository);
      let calls = 0;
      repository.saveProperty = ((id, property) => {
        calls += 1;
        if (calls === 2) {
          throw wooError("E_TEST_SECOND_ROW_WRITE", "injected second-row persistence refusal");
        }
        saveProperty(id, property);
      }) as typeof repository.saveProperty;

      const result = await world.directCall(
        "ordinary-direct-two-row",
        "$wiz",
        "atomic_flush_controller",
        "write_two",
        []
      );

      expect(result).toMatchObject({ op: "error", error: { code: "E_TEST_SECOND_ROW_WRITE" } });
      expect(calls).toBe(2);
      expect(world.exportWorld()).toEqual(before);
      expect(world.hasPendingPersistence()).toBe(false);
      repository.saveProperty = saveProperty;
      world.persist(true);
      repository.close();

      const restartedRepository = new LocalSQLiteRepository(path);
      const restarted = createWorld({ repository: restartedRepository });
      expect(restarted.getProp("atomic_row_a", "counter")).toBe(0);
      expect(restarted.getProp("atomic_row_b", "counter")).toBe(0);
      restartedRepository.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("makes a terminal SQLite command the one durable turn and never resumes its wrapper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-nested-sequenced-rollback-"));
    const path = join(dir, "world.sqlite");
    try {
      const repository = new LocalSQLiteRepository(path);
      const world = createWorld({ repository });
      const session = world.auth("guest:nested-sequenced-rollback");
      expect((await world.directCall(
        "nested-sequenced-enter",
        session.actor,
        session.actor,
        "moveto",
        ["the_dubspace"],
        { sessionId: session.id }
      )).op).toBe("result");
      world.createObject({ id: "nested_sequenced_subject", parent: "$thing", owner: "$wiz" });
      world.defineProperty("nested_sequenced_subject", {
        name: "counter",
        defaultValue: 0,
        owner: "$wiz",
        perms: "rw",
        typeHint: "int"
      });
      addDirectNative(world, "nested_sequenced_target", "write", () => {
        world.setProp("nested_sequenced_subject", "counter", 1);
        return "inner accepted";
      });
      addDirectNative(world, "nested_sequenced_outer", "run_then_fail", async (ctx) => {
        const inner = await world.executeCommandPlan(ctx, {
          ok: true,
          route: "sequenced",
          space: "the_dubspace",
          target: "nested_sequenced_target",
          verb: "write",
          args: []
        });
        expect(inner).toMatchObject({ op: "applied" });
        throw wooError("E_TEST_OUTER_ROLLBACK", "outer turn rejects after inner success");
      });
      const beforeSeq = Number(world.getProp("the_dubspace", "next_seq"));
      const beforeLogs = world.replay("the_dubspace", 0, 10_000).length;

      const result = await world.directCall(
        "nested-sequenced-outer",
        session.actor,
        "nested_sequenced_outer",
        "run_then_fail",
        [],
        { sessionId: session.id }
      );

      expect(result).toMatchObject({ op: "applied", result: "inner accepted" });
      expect(world.getProp("nested_sequenced_subject", "counter")).toBe(1);
      world.persist(true);
      repository.close();

      const restartedRepository = new LocalSQLiteRepository(path);
      const restarted = createWorld({ repository: restartedRepository });
      expect(restarted.getProp("nested_sequenced_subject", "counter")).toBe(1);
      expect(restarted.getProp("the_dubspace", "next_seq")).toBe(beforeSeq + 1);
      expect(restarted.replay("the_dubspace", 0, 10_000)).toHaveLength(beforeLogs + 1);
      restartedRepository.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a clean terminal SQLite transfer exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-nested-sequenced-accept-"));
    const path = join(dir, "world.sqlite");
    try {
      const repository = new LocalSQLiteRepository(path);
      const world = createWorld({ repository });
      const session = world.auth("guest:nested-sequenced-accept");
      expect((await world.directCall(
        "nested-accept-enter",
        session.actor,
        session.actor,
        "moveto",
        ["the_dubspace"],
        { sessionId: session.id }
      )).op).toBe("result");
      world.createObject({ id: "nested_accept_subject", parent: "$thing", owner: "$wiz" });
      world.defineProperty("nested_accept_subject", {
        name: "counter",
        defaultValue: 0,
        owner: "$wiz",
        perms: "rw",
        typeHint: "int"
      });
      addDirectNative(world, "nested_accept_target", "write", () => {
        world.setProp("nested_accept_subject", "counter", 1);
        return "inner accepted";
      });
      addDirectNative(world, "nested_accept_outer", "run", (ctx) =>
        world.executeCommandPlan(ctx, {
          ok: true,
          route: "sequenced",
          space: "the_dubspace",
          target: "nested_accept_target",
          verb: "write",
          args: []
        })
      );
      const beforeSeq = Number(world.getProp("the_dubspace", "next_seq"));
      const beforeLogs = world.replay("the_dubspace", 0, 10_000).length;

      const result = await world.directCall(
        "nested-accept",
        session.actor,
        "nested_accept_outer",
        "run",
        [],
        { sessionId: session.id }
      );

      expect(result).toMatchObject({ op: "applied", result: "inner accepted" });
      repository.close();

      const restartedRepository = new LocalSQLiteRepository(path);
      const restarted = createWorld({ repository: restartedRepository });
      expect(restarted.getProp("nested_accept_subject", "counter")).toBe(1);
      expect(restarted.getProp("the_dubspace", "next_seq")).toBe(beforeSeq + 1);
      expect(restarted.replay("the_dubspace", 0, 10_000)).toHaveLength(beforeLogs + 1);
      restartedRepository.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a dirty terminal wrapper before crossing authority", async () => {
    const world = createWorld();
    const session = world.auth("guest:nested-sequenced-split");
    let remoteDispatches = 0;
    world.setExecutorContext({
      localHost: "local-host",
      hostForObject: (id: string) => id === "remote_nested_target" ? "remote-host" : "local-host",
      dispatchHost: async () => {
        remoteDispatches += 1;
        throw new Error("remote dispatch must not run");
      }
    } as unknown as ExecutorContext);
    addDirectNative(world, "nested_split_outer", "run", (ctx) =>
      {
        world.setProp("nested_split_outer", "dirty", 1);
        return world.executeCommandPlan(ctx, {
        ok: true,
        route: "sequenced",
        space: "the_dubspace",
        target: "remote_nested_target",
        verb: "write",
        args: []
        });
      }
    );
    world.defineProperty("nested_split_outer", {
      name: "dirty",
      defaultValue: 0,
      owner: "$wiz",
      perms: "rw",
      typeHint: "int"
    });

    const result = await world.directCall(
      "nested-split",
      session.actor,
      "nested_split_outer",
      "run",
      [],
      { sessionId: session.id }
    );

    expect(result).toMatchObject({ op: "error", error: { code: "E_SCOPE_SPLIT" } });
    expect(remoteDispatches).toBe(0);
    expect(world.getProp("nested_split_outer", "dirty")).toBe(0);
  });

  it("records only the transferred sequenced command turn in shadow execution", async () => {
    const world = createWorld();
    const session = world.auth("guest:shadow-command-transfer");
    expect((await world.directCall(
      "shadow-command-enter",
      session.actor,
      session.actor,
      "moveto",
      ["the_dubspace"],
      { sessionId: session.id }
    )).op).toBe("result");
    const run = await runShadowTurnCallTranscript(
      authoritativePlanningWorld(world.exportWorld()),
      {
        kind: "woo.turn_call.shadow.v1",
        route: "direct",
        scope: "the_dubspace",
        session: session.id,
        actor: session.actor,
        target: "the_dubspace",
        verb: "command",
        args: ["bpm 146"]
      }
    );

    expect(run.frame).toMatchObject({
      op: "applied",
      message: { actor: session.actor, target: "the_dubspace", verb: "set_tempo", args: ["146"] }
    });
    expect(run.recorded.start).toMatchObject({
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor: session.actor,
      target: "the_dubspace",
      verb: "set_tempo"
    });
    expect(run.transcript.error).toBeUndefined();
    expect(run.transcript.writes).toContainEqual(expect.objectContaining({
      cell: { kind: "prop", object: "the_dubspace", name: "next_seq" }
    }));
  });

  it("does not mistake an ordinary direct result map for a sequenced transfer", async () => {
    const world = createWorld();
    world.createObject({ id: "applied_map_probe", parent: "$thing", owner: "$wiz" });
    expect(installVerb(
      world,
      "applied_map_probe",
      "value",
      'verb :value() rxd { return { op: "applied" }; }',
      null
    ).ok).toBe(true);

    const run = await runShadowTurnCallTranscript(
      authoritativePlanningWorld(world.exportWorld()),
      {
        kind: "woo.turn_call.shadow.v1",
        route: "direct",
        scope: "#-1",
        actor: "$wiz",
        target: "applied_map_probe",
        verb: "value",
        args: []
      }
    );

    expect(run.frame).toMatchObject({ op: "result", result: { op: "applied" } });
    expect(run.recorded.start.route).toBe("direct");
  });

  it("rolls back direct recycle, tombstone, and placement state", async () => {
    const world = createWorld();
    world.createObject({ id: "rollback_room", name: "Rollback room", parent: "$thing", owner: "$wiz", location: "$nowhere" });
    world.createObject({ id: "rollback_victim", name: "Rollback victim", parent: "$thing", owner: "$wiz", location: "rollback_room" });
    addDirectNative(world, "recycle_controller", "recycle_then_fail", async (ctx) => {
      await ctx.world.recycleChecked("$wiz", "$wiz", "rollback_victim", { force: true }, ctx);
      throw wooError("E_TEST_RECYCLE_ROLLBACK", "expected recycle rollback");
    });
    const before = structuredClone(world.exportWorld());
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const result = await world.directCall("recycle-rollback", "$wiz", "recycle_controller", "recycle_then_fail", []);

    expect(result).toMatchObject({ op: "error", error: { code: "E_TEST_RECYCLE_ROLLBACK" } });
    expect(world.exportWorld()).toEqual(before);
    expect(world.objects.has("rollback_victim")).toBe(true);
    expect(world.tombstones.has("rollback_victim")).toBe(false);
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript.recycles ?? []).toEqual([]);
    expect(transcript.projectionWrites ?? []).toEqual([]);
    expect(transcript.writes).toEqual([]);
  });

  it("preserves object and session iteration order across aborted deletions", async () => {
    const world = createWorld();
    world.createObject({ id: "order_before", name: "Order before", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "order_victim", name: "Order victim", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "order_after", name: "Order after", parent: "$thing", owner: "$wiz" });
    world.auth("guest:order-before");
    const victimSession = world.auth("guest:order-victim");
    world.auth("guest:order-after");
    addDirectNative(world, "order_controller", "delete_then_fail", async (ctx) => {
      await world.recycleChecked("$wiz", "$wiz", "order_victim", { force: true }, ctx);
      world.endSession(victimSession.id);
      throw wooError("E_TEST_ORDER_ROLLBACK", "expected ordered rollback");
    });
    const objectKeys = Array.from(world.objects.keys());
    const sessionKeys = Array.from(world.sessions.keys());

    const result = await world.directCall("ordered-rollback", "$wiz", "order_controller", "delete_then_fail", []);

    expect(result).toMatchObject({ op: "error", error: { code: "E_TEST_ORDER_ROLLBACK" } });
    expect(Array.from(world.objects.keys())).toEqual(objectKeys);
    expect(Array.from(world.sessions.keys())).toEqual(sessionKeys);
  });

  it("rolls back direct session closure in memory and across a SQLite restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-native-rollback-"));
    const path = join(dir, "world.sqlite");
    try {
      const repository = new LocalSQLiteRepository(path);
      const world = createWorld({ repository });
      const session = world.auth("guest:native-session-rollback");
      addDirectNative(world, "session_controller", "close_then_fail", () => {
        world.saveSnapshot("the_dubspace");
        world.endSession(session.id);
        throw wooError("E_TEST_SESSION_ROLLBACK", "expected session rollback");
      });
      const before = structuredClone(world.exportWorld());

      const result = await world.directCall("session-rollback", "$wiz", "session_controller", "close_then_fail", []);

      expect(result).toMatchObject({ op: "error", error: { code: "E_TEST_SESSION_ROLLBACK" } });
      expect(world.exportWorld()).toEqual(before);
      expect(world.sessions.has(session.id)).toBe(true);
      expect(world.hasPendingPersistence()).toBe(false);
      // A later flush used to materialize dirty rows left by the failed call.
      world.persist(true);
      repository.close();

      const restartedRepository = new LocalSQLiteRepository(path);
      const restarted = createWorld({ repository: restartedRepository });
      expect(restarted.sessions.has(session.id)).toBe(true);
      expect(restarted.object(session.actor).location).toBe(world.object(session.actor).location);
      expect(restarted.exportWorld().snapshots).toEqual(before.snapshots);
      restartedRepository.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("journals session mint success and a later native failure", async () => {
    const world = createWorld();
    const before = world.sessions.size;

    const minted = await world.directCall(
      "mint-session-success",
      "$wiz",
      "$system",
      "mint_session_for",
      ["$wiz"]
    );

    expect(minted).toMatchObject({
      op: "result",
      result: { actor: "$wiz", token_class: "bearer" }
    });
    expect(world.sessions.size).toBe(before + 1);
    let authoritativeMint: ReturnType<WooWorld["createSessionForActor"]> | null = null;
    addDirectNative(world, "mint_identity_controller", "mint", () => {
      authoritativeMint = world.createSessionForActor("$wiz", "bearer");
      return authoritativeMint.id;
    });
    const identityMint = await world.directCall(
      "mint-session-identity",
      "$wiz",
      "mint_identity_controller",
      "mint",
      []
    );
    expect(identityMint).toMatchObject({ op: "result" });
    expect(authoritativeMint).not.toBeNull();
    const storedMint = world.sessions.get(authoritativeMint!.id);
    expect(storedMint).not.toBe(authoritativeMint);
    expect(storedMint).toMatchObject({
      id: authoritativeMint!.id,
      actor: "$wiz",
      tokenClass: "bearer"
    });
    expect(authoritativeMint).toMatchObject({ actor: "$wiz", tokenClass: "bearer" });
    authoritativeMint!.lastInputAt = 1;
    expect(world.sessions.get(authoritativeMint!.id)?.lastInputAt).not.toBe(1);
    const accepted = world.sessions.size;
    let provisionalId = "";
    addDirectNative(world, "mint_rollback_controller", "mint_then_fail", () => {
      provisionalId = world.createSessionForActor("$wiz", "bearer").id;
      throw wooError("E_TEST_MINT_ROLLBACK", "expected failure after mint");
    });

    const failed = await world.directCall(
      "mint-session-rollback",
      "$wiz",
      "mint_rollback_controller",
      "mint_then_fail",
      []
    );

    expect(failed).toMatchObject({ op: "error", error: { code: "E_TEST_MINT_ROLLBACK" } });
    expect(world.sessions.size).toBe(accepted);
    expect(world.sessions.has(provisionalId)).toBe(false);
  });

  it("rolls back ensure-session updates and sparse session closure", async () => {
    const world = createWorld();
    const session = world.auth("guest:session-mutator-rollback");
    const before = structuredClone(world.exportWorld().sessions);
    addDirectNative(world, "session_mutator_controller", "mutate_then_fail", () => {
      world.ensureSessionForActor(
        session.id,
        session.actor,
        session.tokenClass,
        session.expiresAt + 60_000,
        "the_chatroom",
        undefined,
        session.started
      );
      world.markSessionClosed(session.id);
      throw wooError("E_TEST_SESSION_MUTATOR_ROLLBACK", "expected session mutator rollback");
    });

    const result = await world.directCall(
      "session-mutator-rollback",
      "$wiz",
      "session_mutator_controller",
      "mutate_then_fail",
      []
    );

    expect(result).toMatchObject({ op: "error", error: { code: "E_TEST_SESSION_MUTATOR_ROLLBACK" } });
    expect(world.exportWorld().sessions).toEqual(before);
    expect(world.sessions.has(session.id)).toBe(true);
  });

  it("keeps a caught inner savepoint provisional without leaking its recorder effects", async () => {
    const world = createWorld();
    world.createObject({ id: "nested_subject", name: "Nested subject", parent: "$thing", owner: "$wiz" });
    world.defineProperty("nested_subject", { name: "counter", defaultValue: 0, owner: "$wiz", perms: "rw", typeHint: "int" });
    addDirectNative(world, "nested_controller", "nested", (ctx) => {
      try {
        ctx.world.withMutationSavepoint(() => {
          ctx.world.createRuntimeObject("$thing", "$wiz", null, { progr: "$wiz", name: "Nested rollback leak" });
          throw wooError("E_INNER", "caught by outer behavior");
        });
      } catch {
        // The outer behavior deliberately recovers and commits another write.
      }
      ctx.world.setProp("nested_subject", "counter", 1);
      return true;
    });
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const result = await world.directCall("nested-rollback", "$wiz", "nested_controller", "nested", []);

    expect(result).toMatchObject({ op: "result", result: true });
    expect(Array.from(world.objects.values()).some((object) => object.name === "Nested rollback leak")).toBe(false);
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript.creates).toEqual([]);
    expect(transcript.writes).toContainEqual(expect.objectContaining({
      cell: { kind: "prop", object: "nested_subject", name: "counter" },
      value: 1
    }));
  });

  it("keeps only sequence allocation and one canonical error after sequenced behavior failure", async () => {
    const world = createWorld();
    const session = world.auth("guest:sequenced-native-rollback");
    const actor = session.actor;
    expect((await world.directCall("enter-sequenced-rollback", actor, actor, "moveto", ["the_dubspace"], { sessionId: session.id })).op).toBe("result");
    const beforeFeedback = world.getProp("delay_1", "feedback");
    const beforeVersion = world.object("delay_1").propertyVersions.get("feedback");
    const beforeSeq = world.getProp("the_dubspace", "next_seq");
    world.registerNativeHandler("test_sequenced_mutate_then_fail", (ctx) => {
      ctx.world.setProp("delay_1", "feedback", 77);
      ctx.observe?.({ type: "should_not_escape", source: "the_dubspace", value: 77 });
      ctx.world.recordScheduleRequest(ctx, "the_dubspace", "sequenced_mutate_then_fail", [], { delayMs: 60_000 });
      throw wooError("E_TEST_SEQUENCED_ROLLBACK", "expected sequenced rollback");
    });
    world.addVerb("the_dubspace", {
      ...nativeVerb("sequenced_mutate_then_fail", "test_sequenced_mutate_then_fail"),
      perms: "rx"
    });
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const frame = await world.call(
      "sequenced-rollback",
      session.id,
      "the_dubspace",
      message(actor, "the_dubspace", "sequenced_mutate_then_fail", [])
    );

    expect(frame.op).toBe("applied");
    if (frame.op === "applied") {
      expect(frame.observations).toEqual([
        expect.objectContaining({ type: "$error", code: "E_TEST_SEQUENCED_ROLLBACK" })
      ]);
    }
    expect(world.getProp("delay_1", "feedback")).toBe(beforeFeedback);
    expect(world.object("delay_1").propertyVersions.get("feedback")).toBe(beforeVersion);
    expect(world.getProp("the_dubspace", "next_seq")).toBe(Number(beforeSeq) + 1);

    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript.error?.code).toBe("E_TEST_SEQUENCED_ROLLBACK");
    expect(transcript.writes).toEqual([
      expect.objectContaining({
        cell: { kind: "prop", object: "the_dubspace", name: "next_seq" },
        value: Number(beforeSeq) + 1,
        op: "set"
      })
    ]);
    expect(transcript.creates).toEqual([]);
    expect(transcript.moves).toEqual([]);
    expect(transcript.sessionScopeTransition).toBeUndefined();
    expect(transcript.schedules ?? []).toEqual([]);
    expect(transcript.logicalInputs.filter((input) => input.name === "schedule.now")).toHaveLength(1);
    expect(recorder.turns[0].events).toContainEqual(expect.objectContaining({ kind: "dispatch" }));
    expect(transcript.observations).toEqual([
      expect.objectContaining({ type: "$error", code: "E_TEST_SEQUENCED_ROLLBACK" })
    ]);
  });

  it("keeps meSnapshot restore metadata outside a failed turn's effects", async () => {
    const world = createWorld();
    const session = world.auth("guest:failed-overlay");
    const actor = session.actor;
    await world.moveObjectChecked(actor, "the_dubspace");
    // Model a recoverable focus overlay: the session addresses the actor while
    // the actor's physical room remains the durable `here` projection.
    expect(world.migrationSetSessionState(session.id, { activeScope: actor })).toBe(true);
    addDirectNative(world, "overlay_controller", "move_then_fail", async (ctx) => {
      const internals = ctx.world as unknown as {
        movetoActorChecked(call: typeof ctx, movingActor: string, target: string): Promise<unknown>;
      };
      await internals.movetoActorChecked(ctx, actor, "the_chatroom");
      throw wooError("E_TEST_OVERLAY_ROLLBACK", "restore the session focus");
    });
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);

    const failed = await world.directCall(
      "failed-overlay",
      actor,
      "overlay_controller",
      "move_then_fail",
      [],
      { sessionId: session.id }
    );

    expect(failed).toMatchObject({ op: "error", error: { code: "E_TEST_OVERLAY_ROLLBACK" } });
    expect(world.activeScopeForSession(session.id)).toBe(actor);
    const me = await world.meSnapshot(world.sessions.get(session.id)!);
    expect(me.overlays).toEqual({
      active_scope: { subject: actor, surface: "default", restore: true }
    });
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    expect(transcript.sessionScopeTransition).toBeUndefined();
    expect(transcript.moves).toEqual([]);
  });
});
