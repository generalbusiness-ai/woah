import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import type { NativeHandler, WooWorld } from "../src/core/world";
import { nativeVerb } from "./core-support";

function addDirectNative(world: WooWorld, handler: NativeHandler): void {
  world.registerNativeHandler("test_savepoint_cost_noop", handler);
  world.addVerb("savepoint_cost_target", {
    ...nativeVerb("noop", "test_savepoint_cost_noop"),
    perms: "rxd",
    direct_callable: true,
    skip_presence_check: true
  });
}

async function measuredNoopP95Ms(unrelatedObjects: number): Promise<number> {
  const world = createWorld();
  for (let index = 0; index < unrelatedObjects; index += 1) {
    world.createObject({
      id: `savepoint_cost_unrelated_${index}`,
      name: `Savepoint cost unrelated ${index}`,
      parent: "$thing",
      owner: "$wiz"
    });
  }
  world.createObject({
    id: "savepoint_cost_target",
    name: "Savepoint cost target",
    parent: "$thing",
    owner: "$wiz"
  });
  addDirectNative(world, () => true);

  for (let index = 0; index < 30; index += 1) {
    await world.directCall(`savepoint-cost-warm-${index}`, "$wiz", "savepoint_cost_target", "noop", []);
  }
  const durations: number[] = [];
  for (let index = 0; index < 300; index += 1) {
    const started = performance.now();
    const frame = await world.directCall(
      `savepoint-cost-${unrelatedObjects}-${index}`,
      "$wiz",
      "savepoint_cost_target",
      "noop",
      []
    );
    if (frame.op !== "result") throw new Error(`savepoint cost probe failed: ${JSON.stringify(frame)}`);
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  return durations[Math.ceil(durations.length * 0.95) - 1]!;
}

describe("behavior savepoint wall-clock scaling", () => {
  it("keeps a no-op behavior independent of untouched authority size", async () => {
    const smallP95Ms = await measuredNoopP95Ms(100);
    const loadedP95Ms = await measuredNoopP95Ms(5_000);
    const detail = `small_p95=${smallP95Ms.toFixed(3)}ms loaded_p95=${loadedP95Ms.toFixed(3)}ms`;

    // The additive allowance absorbs timer/scheduler noise; the relative bound
    // catches a return to the former O(authority-size) eager snapshot without
    // turning unrelated machine contention into an absolute wall-time failure.
    expect(loadedP95Ms, detail).toBeLessThanOrEqual(smallP95Ms * 8 + 0.5);
  });
});
