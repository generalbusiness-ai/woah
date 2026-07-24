// Durable fanout — at-least-once, per-scope ordered, backoff, abandoned
// as named divergence, receiver no-op by seq (coherence.md CO2.7; ported
// from the v2 D1 gate semantics: ordering under burst, redelivery
// idempotency, backoff windows).
import { describe, expect, it } from "vitest";
import { CellStore, makeCell, type EpochStamp } from "../../src/net/cells";
import { applyFanout, defaultBackoffMs, Outbox, type FanoutBody } from "../../src/net/outbox";

const STAMP: EpochStamp = { scope_head: "h", catalog_epoch: "cat1" };

function body(seq: number, object = `#o${seq}`): FanoutBody {
  return {
    scope: "the_room",
    seq,
    cells: [makeCell({ kind: "object_live", object, value: { location: "the_room" }, provenance: "authoritative", stamp: STAMP })],
    observations: []
  };
}

describe("outbox drain (D1 semantics)", () => {
  it("delivers a 3-row burst per destination in ascending seq order", async () => {
    const outbox = new Outbox();
    outbox.enqueue("shard-1", body(2));
    outbox.enqueue("shard-1", body(1));
    outbox.enqueue("shard-1", body(3));
    const seen: number[] = [];
    const result = await outbox.drain(1000, async (row) => { seen.push(row.body.seq); });
    expect(seen).toEqual([1, 2, 3]);
    expect(result.delivered).toHaveLength(3);
    expect(outbox.pending()).toHaveLength(0);
  });

  it("halts a lane on failure, preserves order, retries after backoff", async () => {
    const outbox = new Outbox({ backoffMs: () => 500 });
    outbox.enqueue("shard-1", body(1));
    outbox.enqueue("shard-1", body(2));
    let fail = true;
    const deliver = async (row: { body: FanoutBody }) => {
      if (fail && row.body.seq === 1) throw new Error("transient");
    };
    const first = await outbox.drain(1000, deliver);
    expect(first.failed).toEqual(["shard-1/the_room/1"]);
    expect(first.delivered).toEqual([]); // seq 2 never jumps the queue

    // Inside the backoff window: the lane is skipped entirely.
    const early = await outbox.drain(1200, deliver);
    expect(early.skipped_backoff).toEqual(["shard-1/the_room/1"]);
    expect(early.delivered).toEqual([]);

    // Past the window: seq 1 then seq 2 deliver in order.
    fail = false;
    const late = await outbox.drain(1600, deliver);
    expect(late.delivered).toEqual(["shard-1/the_room/1", "shard-1/the_room/2"]);
  });

  it("failures in one destination lane do not block another", async () => {
    const outbox = new Outbox({ backoffMs: () => 500 });
    outbox.enqueue("shard-bad", body(1));
    outbox.enqueue("shard-good", body(1, "#other"));
    const result = await outbox.drain(1000, async (row) => {
      if (row.destination === "shard-bad") throw new Error("down");
    });
    expect(result.delivered).toEqual(["shard-good/the_room/1"]);
    expect(result.failed).toEqual(["shard-bad/the_room/1"]);
  });

  it("starts independent destination lanes concurrently while each lane remains ordered", async () => {
    const outbox = new Outbox();
    outbox.enqueue("shard-a", body(1));
    outbox.enqueue("shard-a", body(2));
    outbox.enqueue("shard-b", body(1, "#other"));
    const started: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const draining = outbox.drain(1000, async (row) => {
      started.push(`${row.destination}:${row.body.seq}`);
      if (row.body.seq === 1) await blocked;
    });

    // drain() reaches both lane-head callbacks synchronously before its
    // Promise.all yields. A serial lane loop would contain only shard-a
    // here and remain blocked forever waiting for release.
    expect(started).toEqual(["shard-a:1", "shard-b:1"]);
    release();
    const result = await draining;
    expect(started).toEqual(["shard-a:1", "shard-b:1", "shard-a:2"]);
    expect(result.delivered).toEqual([
      "shard-a/the_room/1",
      "shard-a/the_room/2",
      "shard-b/the_room/1"
    ]);
  });

  it("abandons a row after the attempt budget — named divergence, not silent loss", async () => {
    const outbox = new Outbox({ backoffMs: () => 0, maxAttempts: 3 });
    outbox.enqueue("shard-1", body(1));
    const failAll = async () => { throw new Error("down"); };
    await outbox.drain(1, failAll);
    await outbox.drain(2, failAll);
    const last = await outbox.drain(3, failAll);
    expect(last.abandoned).toEqual(["shard-1/the_room/1"]);
    expect(outbox.pending()).toHaveLength(0); // no zombie retries
  });

  it("re-enqueueing the same (destination, scope, seq) keeps the original row's state", async () => {
    const outbox = new Outbox({ backoffMs: () => 10_000 });
    outbox.enqueue("shard-1", body(1));
    await outbox.drain(1000, async () => { throw new Error("down"); });
    const again = outbox.enqueue("shard-1", body(1));
    expect(again.attempts).toBe(1); // crash-recovery re-enqueue is not a reset
  });

  it("preserves explicit durable identities for distinct facts at the same scope seq", () => {
    const outbox = new Outbox();
    const ordinary = outbox.enqueue("audit:0", body(1), { id: "audit:0/the_room/1" });
    const adoption = outbox.enqueue("audit:0", body(1), { id: "audit:0/the_room/1:adopt" });

    expect(ordinary.id).toBe("audit:0/the_room/1");
    expect(adoption.id).toBe("audit:0/the_room/1:adopt");
    expect(outbox.pending().map((row) => row.id)).toEqual([
      "audit:0/the_room/1",
      "audit:0/the_room/1:adopt"
    ]);
  });
});

describe("batched lane delivery (deliverLane — one request per lane prefix)", () => {
  const noRow = async () => {
    throw new Error("per-row deliver must not run in lane mode");
  };

  it("delivers the whole due prefix in one ordered call; success marks every row", async () => {
    const outbox = new Outbox();
    outbox.enqueue("shard-1", body(2));
    outbox.enqueue("shard-1", body(1));
    outbox.enqueue("shard-2", body(1));
    const calls: Array<{ destination: string; seqs: number[] }> = [];
    const result = await outbox.drain(1000, noRow, undefined, async (destination, rows) => {
      calls.push({ destination, seqs: rows.map((r) => r.body.seq) });
    });
    // One call per lane, rows in seq order inside each.
    expect(calls).toEqual([
      { destination: "shard-1", seqs: [1, 2] },
      { destination: "shard-2", seqs: [1] }
    ]);
    expect(result.delivered).toHaveLength(3);
    expect(outbox.pending()).toHaveLength(0);
  });

  it("a batch failure is prefix-atomic: every row keeps one attempt and retries whole after backoff", async () => {
    const outbox = new Outbox({ backoffMs: () => 500 });
    outbox.enqueue("shard-1", body(1));
    outbox.enqueue("shard-1", body(2));
    let fail = true;
    const lane = async () => {
      if (fail) throw new Error("destination down");
    };
    const first = await outbox.drain(1000, noRow, undefined, lane);
    expect(first.failed.sort()).toEqual(["shard-1/the_room/1", "shard-1/the_room/2"]);
    expect(first.delivered).toEqual([]);
    // Inside backoff: the lane head gates the WHOLE prefix.
    const early = await outbox.drain(1200, noRow, undefined, lane);
    expect(early.delivered).toEqual([]);
    expect(early.skipped_backoff).toEqual(["shard-1/the_room/1"]);
    // Past backoff: the prefix redelivers whole, in order (receiver seq
    // gate makes any duplicate a no-op — CO2.5).
    fail = false;
    const late = await outbox.drain(1600, noRow, undefined, lane);
    expect(late.delivered).toEqual(["shard-1/the_room/1", "shard-1/the_room/2"]);
  });

  it("a mid-backoff head halts the prefix and a yield defers the lane untouched", async () => {
    const outbox = new Outbox({ backoffMs: () => 500 });
    outbox.enqueue("shard-1", body(1));
    let fail = true;
    await outbox.drain(1000, noRow, undefined, async () => {
      if (fail) throw new Error("down");
    });
    fail = false;
    // Row 2 enqueued behind the mid-backoff head: nothing may deliver.
    outbox.enqueue("shard-1", body(2));
    const gated = await outbox.drain(1200, noRow, undefined, async () => {});
    expect(gated.delivered).toEqual([]);
    expect(gated.skipped_backoff).toEqual(["shard-1/the_room/1"]);
    // Yield before the batch: rows untouched (no attempt counted).
    const beforeAttempts = outbox.pending().map((r) => r.attempts);
    const yielded = await outbox.drain(1600, noRow, () => true, async () => {});
    expect(yielded.yielded).toBe(true);
    expect(yielded.delivered).toEqual([]);
    expect(outbox.pending().map((r) => r.attempts)).toEqual(beforeAttempts);
  });
});

describe("backoff jitter (NC8, review item 8)", () => {
  it("is deterministic per row, bounded to ±25%, and spreads across rows", () => {
    // Deterministic: the same row backs off identically across reruns
    // (the module's replayable-drain contract).
    expect(defaultBackoffMs(3, "shard-1/the_room/7")).toBe(defaultBackoffMs(3, "shard-1/the_room/7"));
    // Bounded: every value inside ±25% of the exponential base.
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const base = Math.min(30_000, 250 * 2 ** (attempt - 1));
      for (let i = 0; i < 32; i += 1) {
        const value = defaultBackoffMs(attempt, `dest-${i}/scope/${i}`);
        expect(value).toBeGreaterThanOrEqual(base - Math.floor(base / 4));
        expect(value).toBeLessThanOrEqual(base + Math.floor(base / 4));
      }
    }
    // Spread: a herd of distinct rows must NOT share one retry instant.
    const herd = new Set<number>();
    for (let i = 0; i < 64; i += 1) herd.add(defaultBackoffMs(5, `dest-${i}/scope/${i}`));
    expect(herd.size).toBeGreaterThan(16);
  });
});

describe("receiver idempotency (CO2.5)", () => {
  it("installs first delivery, no-ops redelivery, rejects regressions", () => {
    const store = new CellStore("derived");
    const seen = new Map<string, number>();
    expect(applyFanout(store, seen, body(1))).toBe(true);
    expect(store.get("object_live:#o1")?.provenance).toBe("derived");
    // Redelivery of the same seq: harmless no-op.
    expect(applyFanout(store, seen, body(1))).toBe(false);
    // Later seq advances; earlier seq after it is a no-op.
    expect(applyFanout(store, seen, body(3))).toBe(true);
    expect(applyFanout(store, seen, body(2))).toBe(false);
    expect(seen.get("the_room")).toBe(3);
  });

  it("removes retired cells under the same durable sequence high-water", () => {
    const store = new CellStore("derived");
    const seen = new Map<string, number>();
    expect(applyFanout(store, seen, body(1))).toBe(true);
    expect(store.get("object_live:#o1")).toBeDefined();

    const removal: FanoutBody = {
      scope: "the_room",
      seq: 2,
      cells: [],
      removed_cells: ["object_live:#o1"],
      observations: []
    };
    expect(applyFanout(store, seen, removal)).toBe(true);
    expect(store.get("object_live:#o1")).toBeUndefined();
    expect(applyFanout(store, seen, removal)).toBe(false);
    expect(seen.get("the_room")).toBe(2);
  });
});
