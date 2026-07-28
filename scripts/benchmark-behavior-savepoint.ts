import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createWorld } from "../src/core/bootstrap";
import { wooError, type VerbDef } from "../src/core/types";
import type { NativeHandler, WooWorld } from "../src/core/world";
import { LocalSQLiteRepository } from "../src/server/sqlite-repository";

// Reproducible characterization for the direct behavior undo journal.
// It reports wall distribution, CPU/op, heap-growth/peak proxies, and captured
// mutation-category counts after warmup. The bridge records exact inverse
// operations at supported mutation seams; ordinary reads and scans allocate no
// authority-sized savepoint.
//
// Run three times to establish variance:
//   npx tsx scripts/benchmark-behavior-savepoint.ts
const sizes = [100, 1_000, 5_000];
const iterations = 120;
const warmup = 30;

function verb(name: string, native: string): VerbDef {
  return {
    kind: "native",
    name,
    aliases: [],
    owner: "$wiz",
    perms: "rxd",
    arg_spec: {},
    source: `verb :${name}() rxd { return true; }`,
    source_hash: `rollback-bench-${name}`,
    version: 1,
    line_map: {},
    native,
    direct_callable: true,
    skip_presence_check: true
  };
}

function addNative(world: WooWorld, target: string, name: string, handler: NativeHandler): void {
  const native = `rollback_bench_${name}`;
  world.registerNativeHandler(native, handler);
  world.addVerb(target, verb(name, native));
}

async function measure(
  shape: Record<string, string | number>,
  world: WooWorld,
  invoke: (iteration: number, warm: boolean) => Promise<unknown>,
  count = iterations
): Promise<void> {
  for (let i = 0; i < warmup; i += 1) await invoke(i, true);
  const samples: number[] = [];
  const cpuBefore = process.cpuUsage();
  const heapBefore = process.memoryUsage().heapUsed;
  let heapPeak = heapBefore;
  for (let i = 0; i < count; i += 1) {
    const started = performance.now();
    await invoke(i, false);
    samples.push(performance.now() - started);
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
  }
  const cpu = process.cpuUsage(cpuBefore);
  const heapAfter = process.memoryUsage().heapUsed;
  samples.sort((a, b) => a - b);
  const at = (fraction: number): number => samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))];
  console.log(JSON.stringify({
    ...shape,
    objects: world.objects.size,
    iterations: count,
    wall_p50_ms: Number(at(0.5).toFixed(3)),
    wall_p95_ms: Number(at(0.95).toFixed(3)),
    wall_max_ms: Number(samples.at(-1)!.toFixed(3)),
    cpu_ms_per_op: Number(((cpu.user + cpu.system) / 1_000 / count).toFixed(3)),
    heap_growth_kib: Number(((heapAfter - heapBefore) / 1_024).toFixed(1)),
    heap_peak_kib: Number(((heapPeak - heapBefore) / 1_024).toFixed(1)),
    undo_categories: world.behaviorUndoStatsForTesting()
  }));
}

function loadedWorld(size: number): WooWorld {
  const world = createWorld();
  for (let i = 0; i < size; i += 1) {
    const id = `rollback_bench_${i}`;
    world.createObject({ id, name: `Rollback bench ${i}`, parent: "$thing", owner: "$wiz" });
    if (i < 100) {
      world.defineProperty(id, { name: "value", defaultValue: 0, owner: "$wiz", perms: "rw", typeHint: "int" });
    }
  }
  world.createObject({ id: "rollback_bench_target", name: "Rollback bench target", parent: "$thing", owner: "$wiz" });
  world.defineProperty("rollback_bench_target", { name: "value", defaultValue: 0, owner: "$wiz", perms: "rw", typeHint: "int" });
  addNative(world, "rollback_bench_target", "noop", () => true);
  addNative(world, "rollback_bench_target", "write", (_ctx, args) => {
    world.setProp("rollback_bench_target", "value", args[0] ?? 0);
    return true;
  });
  addNative(world, "rollback_bench_target", "fail", () => {
    world.setProp("rollback_bench_target", "value", 999);
    throw wooError("E_BENCH", "intentional rollback benchmark failure");
  });
  addNative(world, "rollback_bench_target", "write_many", (_ctx, args) => {
    const touched = Number(args[0]);
    const salt = Number(args[1] ?? 0);
    for (let i = 0; i < touched; i += 1) world.setProp(`rollback_bench_${i}`, "value", salt + i + 1);
    return true;
  });
  addNative(world, "rollback_bench_target", "fail_many", (_ctx, args) => {
    const touched = Number(args[0]);
    const salt = Number(args[1] ?? 0);
    for (let i = 0; i < touched; i += 1) world.setProp(`rollback_bench_${i}`, "value", salt + i + 1);
    throw wooError("E_BENCH", "intentional multi-row rollback benchmark failure");
  });
  addNative(world, "rollback_bench_target", "scan_noop", () => {
    let found = false;
    for (const object of world.objects.values()) {
      if (object.id === `rollback_bench_${size - 1}`) found = true;
    }
    return found;
  });
  addNative(world, "rollback_bench_target", "scan_write", (_ctx, args) => {
    let found = false;
    for (const object of world.objects.values()) {
      if (object.id === `rollback_bench_${size - 1}`) found = true;
    }
    if (found) world.setProp("rollback_bench_target", "value", args[0] ?? 0);
    return found;
  });
  return world;
}

// Constant touched state while unrelated authority size grows.
for (const size of sizes) {
  const world = loadedWorld(size);
  for (const mode of ["noop", "write", "fail"] as const) {
    await measure(
      { family: "authority_size", mode, unrelated: size },
      world,
      async (i) => await world.directCall(`size-${size}-${mode}-${i}`, "$wiz", "rollback_bench_target", mode, mode === "write" ? [i] : [])
    );
  }
}

// Real scan-heavy shapes (representative of account lookup/listing helpers)
// pay for their own O(authority) enumeration, but journal state remains tied
// to the zero or one row actually mutated.
for (const size of sizes) {
  const world = loadedWorld(size);
  for (const mode of ["scan_noop", "scan_write"] as const) {
    await measure(
      { family: "scan_authority", mode, unrelated: size },
      world,
      async (i) => await world.directCall(`scan-${size}-${mode}-${i}`, "$wiz", "rollback_bench_target", mode, [i]),
      60
    );
  }
}

// Unsupported raw bulk mutation refuses before copying the authoritative set.
// This catches an easy accidental regression where Set.clear snapshots all
// tombstones before noticing that the native did not use a permitted seam.
for (const tombstones of [100, 10_000, 100_000]) {
  const world = loadedWorld(100);
  for (let i = 0; i < tombstones; i += 1) {
    world.migrationSetTombstone(`rollback_bench_tombstone_${i}`, true);
  }
  addNative(world, "rollback_bench_target", "raw_tombstone_clear", () => {
    world.tombstones.clear();
    return true;
  });
  await measure(
    { family: "loaded_set_refusal", mode: "raw_clear", tombstones },
    world,
    async (i) => await world.directCall(
      `loaded-set-${tombstones}-${i}`,
      "$wiz",
      "rollback_bench_target",
      "raw_tombstone_clear",
      []
    ),
    60
  );
}

// Increasing touched rows at constant total authority size.
{
  const world = loadedWorld(5_000);
  for (const touched of [1, 10, 100]) {
    for (const mode of ["write_many", "fail_many"] as const) {
      await measure(
        { family: "touched_rows", mode, touched },
        world,
        async (i, warming) => await world.directCall(
          `touched-${touched}-${mode}-${warming ? "warm" : "measure"}-${i}`,
          "$wiz",
          "rollback_bench_target",
          mode,
          [
            touched,
            warming
              ? -(i + 1)
              : mode === "fail_many"
                ? 1_000_000 + i
                : i + 1
          ]
        )
      );
    }
  }
}

// One abort exercises create/counter, recycle/tombstone, lineage, placement,
// session/guest-pool, snapshot, schedule, observation, and persistence-dirty
// bookkeeping together. Every iteration starts from the same state by design.
{
  const world = loadedWorld(1_000);
  world.createObject({ id: "rollback_bench_room_a", name: "Room A", parent: "$thing", owner: "$wiz", location: "$nowhere" });
  world.createObject({ id: "rollback_bench_room_b", name: "Room B", parent: "$thing", owner: "$wiz", location: "$nowhere" });
  world.createObject({ id: "rollback_bench_move", name: "Move", parent: "$thing", owner: "$wiz", location: "rollback_bench_room_a" });
  world.createObject({ id: "rollback_bench_recycle", name: "Recycle", parent: "$thing", owner: "$wiz" });
  const session = world.auth("guest:rollback-bench-compound");
  addNative(world, "rollback_bench_target", "compound_fail", async (ctx) => {
    world.setObjectFlags("$wiz", "rollback_bench_target", { fertile: true });
    world.createRuntimeObject("$thing", "$wiz", null, { progr: "$wiz", name: "Rolled back create" });
    world.moveObject("rollback_bench_move", "rollback_bench_room_b");
    await world.recycleChecked("$wiz", "$wiz", "rollback_bench_recycle", { force: true }, ctx);
    world.saveSnapshot("the_dubspace");
    world.recordScheduleRequest(ctx, "rollback_bench_target", "noop", [], { delayMs: 60_000 });
    world.endSession(session.id);
    ctx.observe?.({ type: "rollback_bench", source: "rollback_bench_target" });
    throw wooError("E_BENCH", "intentional compound rollback benchmark failure");
  });
  await measure(
    { family: "representative", mode: "compound_fail" },
    world,
    async (i) => {
      const result = await world.directCall(`compound-${i}`, "$wiz", "rollback_bench_target", "compound_fail", []);
      if (result.op !== "error" || result.error.code !== "E_BENCH") throw new Error(`compound benchmark stopped at ${result.op}`);
      return result;
    },
    60
  );
}

// Repository-backed abort: verifies the same in-memory journal carries only
// bounded inverse operations while force-persisting session/snapshot paths are
// deferred until acceptance.
{
  const dir = mkdtempSync(join(tmpdir(), "woo-savepoint-bench-"));
  const path = join(dir, "world.sqlite");
  try {
    const repository = new LocalSQLiteRepository(path);
    const world = createWorld({ repository });
    const session = world.auth("guest:rollback-bench-sqlite");
    world.createObject({ id: "rollback_bench_sqlite", name: "SQLite target", parent: "$thing", owner: "$wiz" });
    world.defineProperty("rollback_bench_sqlite", { name: "value", defaultValue: 0, owner: "$wiz", perms: "rw", typeHint: "int" });
    addNative(world, "rollback_bench_sqlite", "sqlite_fail", () => {
      world.setProp("rollback_bench_sqlite", "value", 1);
      world.saveSnapshot("the_dubspace");
      world.endSession(session.id);
      throw wooError("E_BENCH", "intentional SQLite rollback benchmark failure");
    });
    await measure(
      { family: "persistence", mode: "sqlite_fail" },
      world,
      async (i) => {
        const result = await world.directCall(`sqlite-${i}`, "$wiz", "rollback_bench_sqlite", "sqlite_fail", []);
        if (result.op !== "error" || result.error.code !== "E_BENCH") throw new Error(`SQLite benchmark stopped at ${result.op}`);
        return result;
      },
      30
    );
    repository.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
