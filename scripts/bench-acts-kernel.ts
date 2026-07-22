// Tier C first data for the acts kernel (kernel note §8.3), in-memory lane.
//
// Measures, per sequenced turn: bare chat baseline vs. act-emitting domain
// turns with one and with two attached projections; plus the storage cost
// curve of rows-as-one-map-prop at 10/100/1000 rows (the whole-map write
// amplification that motivates the per-row relation-storage substrate ask).
//
// FIRST RELATIVE INDICATORS ONLY (review 2026-07-22): single run per
// config, fixed order, no warmup, and `say` is not an artifact-creating
// control, so p99 moves materially between runs. Before recording a p99
// budget: repeated randomized runs, an equivalent no-act domain control
// (a verb that creates a $note without emitting), confidence ranges,
// and the workerd lane. In-memory numbers are RELATIVE indicators — no DO storage, no network, no
// serialization boundary. The workerd lane produces the budget numbers.
//
// Run: npx tsx scripts/bench-acts-kernel.ts
import { createWorld } from "../src/core/bootstrap";

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function timedTurns(label: string, n: number, run: (i: number) => Promise<unknown>) {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const frame = (await run(i)) as { op: string };
    const dt = performance.now() - t0;
    if (frame.op !== "applied") throw new Error(`${label} turn ${i}: ${frame.op}`);
    times.push(dt);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((s, x) => s + x, 0) / times.length;
  console.log(
    `${label.padEnd(34)} n=${n}  mean=${mean.toFixed(3)}ms  p50=${pct(times, 50).toFixed(3)}ms  p99=${pct(times, 99).toFixed(3)}ms`
  );
  return { mean, p50: pct(times, 50), p99: pct(times, 99) };
}

async function bench() {
  const N = 300;

  // Baseline: bare sequenced chat turn, no acts machinery.
  {
    const world = createWorld();
    const session = world.auth("guest:bench");
    const actor = session.actor;
    await world.directCall("m", actor, actor, "moveto", ["the_chatroom"], { sessionId: session.id });
    await timedTurns("baseline: say (no acts)", N, (i) =>
      world.call(`b-${i}`, session.id, "the_chatroom", { actor, target: "the_chatroom", verb: "say", args: [`hello ${i}`] })
    );
  }

  // Act-emitting lifecycle turns, board only vs board+lanes.
  for (const lanes of [false, true]) {
    const world = createWorld();
    const session = world.auth("guest:bench");
    const actor = session.actor;
    world.createObject({ id: "bench_case", name: "Bench", parent: "$case", owner: actor });
    await world.directCall("i", actor, "bench_case", "initialize", [100000], { sessionId: session.id });
    const projections = world.getProp("bench_case", "projections") as string[];
    if (lanes) {
      world.createObject({ id: "bench_lanes", name: "lanes", parent: "$kind_lanes", owner: actor, location: "bench_case" });
      world.setProp("bench_case", "projections", [...projections, "bench_lanes"]);
    }
    await world.directCall("m", actor, actor, "moveto", ["bench_case"], { sessionId: session.id });
    const label = lanes ? "open_task (board + lanes folds)" : "open_task (board fold only)";
    await timedTurns(label, N, (i) =>
      world.call(`o-${i}`, session.id, "bench_case", {
        actor, target: "bench_case", verb: "open_task",
        args: [`task ${i}`, "", `kind-${i % 5}`, [], ["a", "b"]]
      })
    );
    // claim/close cycle on one task for a mixed-shape sample.
    const opened = await world.call("ox", session.id, "bench_case", {
      actor, target: "bench_case", verb: "open_task", args: ["cycle", "", "k", [], []]
    });
    const task = (opened as { op: "applied"; result: unknown }).result as string;
    await timedTurns(label.replace("open_task", "claim+close pair"), 1, async () => {
      await world.call("c1", session.id, "bench_case", { actor, target: "bench_case", verb: "claim", args: [task] });
      return world.call("c2", session.id, "bench_case", { actor, target: "bench_case", verb: "close_task", args: [task, "done"] });
    });
  }

  // Storage curve: serialized rows size at 10/100/1000 board rows — this is
  // the per-act whole-map write amplification of the v1 map-prop shape.
  {
    const world = createWorld();
    const session = world.auth("guest:bench");
    const actor = session.actor;
    world.createObject({ id: "curve_case", name: "Curve", parent: "$case", owner: actor });
    await world.directCall("i", actor, "curve_case", "initialize", [100000], { sessionId: session.id });
    const board = (world.getProp("curve_case", "projections") as string[])[0];
    await world.directCall("m", actor, actor, "moveto", ["curve_case"], { sessionId: session.id });
    const marks = new Set([10, 100, 1000]);
    for (let i = 1; i <= 1000; i++) {
      const r = await world.call(`s-${i}`, session.id, "curve_case", {
        actor, target: "curve_case", verb: "open_task",
        args: [`t${i}`, "", `kind-${i % 5}`, ["label"], ["a", "b"]]
      });
      if ((r as { op: string }).op !== "applied") throw new Error(`storage curve open ${i} failed`);
      if (marks.has(i)) {
        const bytes = JSON.stringify(world.getProp(board, "rows")).length;
        console.log(`storage: board rows=${String(i).padEnd(4)} serialized=${bytes} bytes (${Math.round(bytes / i)} B/row; whole map rewritten per act)`);
      }
    }
  }
}

bench().then(() => console.log("done"), (e) => { console.error(e); process.exit(1); });
