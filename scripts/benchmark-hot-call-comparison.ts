import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

// Compare the direct-call hot path against another checkout without copying
// benchmark code into that checkout. This deliberately uses only public world
// methods that exist on both sides of the behavior-journal change.
//
//   npx tsx scripts/benchmark-hot-call-comparison.ts .
//   npx tsx scripts/benchmark-hot-call-comparison.ts /path/to/base-checkout
const root = resolve(process.argv[2] ?? ".");
const bootstrapUrl = pathToFileURL(resolve(root, "src/core/bootstrap.ts")).href;
const typesUrl = pathToFileURL(resolve(root, "src/core/types.ts")).href;
const [{ createWorld }, { wooError }] = await Promise.all([
  import(bootstrapUrl),
  import(typesUrl)
]);

const sizes = [100, 1_000, 5_000];
const warmup = 50;
const iterations = 300;

function addNative(world: any, name: string, handler: (...args: any[]) => unknown): void {
  const native = `hot_call_comparison_${name}`;
  world.registerNativeHandler(native, handler);
  world.addVerb("hot_call_comparison_target", {
    kind: "native",
    name,
    aliases: [],
    owner: "$wiz",
    perms: "rxd",
    arg_spec: {},
    source: `verb :${name}() rxd { return true; }`,
    source_hash: `hot-call-comparison-${name}`,
    version: 1,
    line_map: {},
    native,
    direct_callable: true,
    skip_presence_check: true
  });
}

function loadedWorld(size: number): any {
  const world = createWorld();
  for (let i = 0; i < size; i += 1) {
    world.createObject({
      id: `hot_call_comparison_${i}`,
      name: `Hot-call comparison ${i}`,
      parent: "$thing",
      owner: "$wiz"
    });
  }
  world.createObject({
    id: "hot_call_comparison_target",
    name: "Hot-call comparison target",
    parent: "$thing",
    owner: "$wiz"
  });
  world.defineProperty("hot_call_comparison_target", {
    name: "value",
    defaultValue: 0,
    owner: "$wiz",
    perms: "rw",
    typeHint: "int"
  });
  addNative(world, "noop", () => true);
  addNative(world, "write", (_ctx, args) => {
    world.setProp("hot_call_comparison_target", "value", args[0]);
    return true;
  });
  addNative(world, "fail", () => {
    world.setProp("hot_call_comparison_target", "value", 999);
    throw wooError("E_BENCH", "intentional hot-call comparison failure");
  });
  return world;
}

async function measure(world: any, size: number, mode: "noop" | "write" | "fail"): Promise<void> {
  for (let i = 0; i < warmup; i += 1) {
    await world.directCall(`warm-${size}-${mode}-${i}`, "$wiz", "hot_call_comparison_target", mode, [i]);
  }
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    await world.directCall(`measure-${size}-${mode}-${i}`, "$wiz", "hot_call_comparison_target", mode, [i]);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const percentile = (fraction: number): number =>
    samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))];
  console.log(JSON.stringify({
    root,
    unrelated: size,
    mode,
    iterations,
    wall_p50_ms: Number(percentile(0.5).toFixed(3)),
    wall_p95_ms: Number(percentile(0.95).toFixed(3))
  }));
}

for (const size of sizes) {
  const world = loadedWorld(size);
  for (const mode of ["noop", "write", "fail"] as const) {
    await measure(world, size, mode);
  }
}
