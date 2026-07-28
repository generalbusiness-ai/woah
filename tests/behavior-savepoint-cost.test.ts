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

async function measuredNoopMsPerCall(unrelatedObjects: number): Promise<number> {
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
  const batches: number[] = [];
  for (let batch = 0; batch < 3; batch += 1) {
    const started = performance.now();
    for (let index = 0; index < 100; index += 1) {
      const frame = await world.directCall(
        `savepoint-cost-${unrelatedObjects}-${batch}-${index}`,
        "$wiz",
        "savepoint_cost_target",
        "noop",
        []
      );
      if (frame.op !== "result") throw new Error(`savepoint cost probe failed: ${JSON.stringify(frame)}`);
    }
    batches.push((performance.now() - started) / 100);
  }
  batches.sort((left, right) => left - right);
  return batches[1]!;
}

describe("behavior savepoint wall-clock scaling", () => {
  it("keeps a no-op behavior independent of untouched authority size", async () => {
    const smallMs = await measuredNoopMsPerCall(100);
    const loadedMs = await measuredNoopMsPerCall(5_000);
    const detail = `small=${smallMs.toFixed(3)}ms loaded=${loadedMs.toFixed(3)}ms`;

    // The additive allowance absorbs timer/scheduler noise; the multiplicative
    // bound catches a return to the former O(authority-size) eager snapshot.
    expect(loadedMs, detail).toBeLessThanOrEqual(smallMs * 8 + 0.25);
    expect(loadedMs, detail).toBeLessThan(10);
  });
});
