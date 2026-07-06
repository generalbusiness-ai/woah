// Durable fanout — at-least-once, per-scope ordered, backoff, abandoned
// as named divergence, receiver no-op by seq (coherence.md CO2.7; ported
// from the v2 D1 gate semantics: ordering under burst, redelivery
// idempotency, backoff windows).
import { describe, expect, it } from "vitest";
import { CellStore, makeCell, type EpochStamp } from "../../src/net/cells";
import { applyFanout, Outbox, type FanoutBody } from "../../src/net/outbox";

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
});
