// ScopeStore durability — hydrate round-trip, crash-sim idempotent
// replay, retryable-rejection non-persistence, tail bound (Plan 002
// Phase 3 step 1; coherence.md CO2.5, CO5 copy #1).
import { describe, expect, it } from "vitest";
import { CellStore } from "../../src/net/cells";
import { InMemoryScopeStore } from "../../src/net/scope-store";
import { ScopeSequencer, type CommitSubmit } from "../../src/net/scope";
import { applyTranscript, type EffectTranscript } from "../../src/net/transcript";

const SCOPE = "the_room";
const EPOCH = "cat1";
const WRITER = { progr: "#a", thisObj: "#t", verb: "v", definer: "$thing", caller: "#a", callerPerms: "#a" };

function transcript(hash: string, value: unknown): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    route: "sequenced",
    scope: SCOPE,
    seq: 1,
    call: { actor: "#a", target: "#t", verb: "v", args: [], body: undefined },
    reads: [],
    writes: [{ cell: { kind: "prop", object: "#t", name: "n" }, value: value as never, op: "set", writer: WRITER }],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash
  } as EffectTranscript;
}

function submitFor(seq: ScopeSequencer, t: EffectTranscript, key: string): CommitSubmit {
  const derived = applyTranscript(seq.store as CellStore, t, { scope_head: "x", catalog_epoch: EPOCH });
  return {
    kind: "woo.net.commit_submit.v1",
    scope: SCOPE,
    base: seq.head(),
    idempotency_key: key,
    transcript: t,
    post_state_version: derived.postStateVersion,
    stamp: { scope_head: "x", catalog_epoch: EPOCH }
  };
}

describe("hydrate round-trip (CO5 copy #1)", () => {
  it("a fresh sequencer over the same store is state-identical", () => {
    const store = new InMemoryScopeStore();
    const a = new ScopeSequencer(SCOPE, EPOCH, { durable: store });
    a.seed([{ kind: "object_lineage", object: "#t", value: { parent: null } }]);
    const r1 = a.submit(submitFor(a, transcript("t1", "one"), "k1"));
    const r2 = a.submit(submitFor(a, transcript("t2", "two"), "k2"));
    expect(r1.status).toBe("accepted");
    expect(r2.status).toBe("accepted");
    a.schedule({ id: "s1", at_logical_time: 99, call: { actor: "#a", target: "#t", verb: "tick", args: [] } }, 0);

    const b = new ScopeSequencer(SCOPE, EPOCH, { durable: store });
    expect(b.head()).toEqual(a.head());
    expect(b.store.get("property_cell:#t:n")?.value).toEqual({ value: "two" });
    expect(b.store.get("property_cell:#t:n")?.version).toBe(a.store.get("property_cell:#t:n")?.version);
    expect(b.store.get("object_lineage:#t")?.value).toEqual({ parent: null });
    expect(b.recoveryTail().map((e) => e.seq)).toEqual([1, 2]);
    expect(b.nextAlarmAt()).toBe(99);
    // Idempotent replay of a pre-eviction key returns the RECORDED reply.
    const replay = b.submit(submitFor(b, transcript("t2", "two"), "k2"));
    expect(replay).toEqual(r2);
    expect(b.head().seq).toBe(2); // no double-commit
  });

  it("dueTurns consumption persists — a fired turn never re-fires after eviction", () => {
    const store = new InMemoryScopeStore();
    const a = new ScopeSequencer(SCOPE, EPOCH, { durable: store });
    a.schedule({ id: "early", at_logical_time: 10, call: { actor: "#a", target: "#t", verb: "tick", args: [] } }, 0);
    a.schedule({ id: "late", at_logical_time: 30, call: { actor: "#a", target: "#t", verb: "tick", args: [] } }, 0);
    expect(a.dueTurns(15).map((t) => t.id)).toEqual(["early"]);

    const b = new ScopeSequencer(SCOPE, EPOCH, { durable: store });
    expect(b.nextAlarmAt()).toBe(30); // "early" is gone durably
    expect(b.dueTurns(15)).toEqual([]);
  });

  it("cancel persists", () => {
    const store = new InMemoryScopeStore();
    const a = new ScopeSequencer(SCOPE, EPOCH, { durable: store });
    a.schedule({ id: "x", at_logical_time: 50, call: { actor: "#a", target: "#t", verb: "tick", args: [] } }, 0);
    a.cancel("x");
    expect(new ScopeSequencer(SCOPE, EPOCH, { durable: store }).nextAlarmAt()).toBeNull();
  });
});

describe("crash-sim: the store is the truth (CO2.5)", () => {
  it("terminal rejections replay from the store; retryable ones do not persist", () => {
    const store = new InMemoryScopeStore();
    const a = new ScopeSequencer(SCOPE, EPOCH, { durable: store });
    // Terminal: scope mismatch — recorded and persisted.
    const terminal = a.submit({ ...submitFor(a, transcript("t1", "v"), "kt"), scope: "elsewhere" });
    expect(terminal.status === "rejected" && !terminal.retryable).toBe(true);
    // Retryable: stale epoch — NOT persisted (a repaired retry must get
    // fresh validation).
    const retryable = a.submit({ ...submitFor(a, transcript("t2", "v"), "kr"), stamp: { scope_head: "x", catalog_epoch: "old" } });
    expect(retryable.status === "rejected" && retryable.retryable).toBe(true);

    const b = new ScopeSequencer(SCOPE, EPOCH, { durable: store });
    // The terminal verdict replays identically.
    expect(b.submit({ ...submitFor(b, transcript("t1", "v"), "kt"), scope: "elsewhere" })).toEqual(terminal);
    // The retryable submit re-validates fresh — with a corrected stamp it
    // now succeeds instead of replaying the old rejection.
    const retried = b.submit(submitFor(b, transcript("t2", "v"), "kr"));
    expect(retried.status).toBe("accepted");
  });

  it("hydration refuses a foreign scope's store and a mismatched epoch", () => {
    const store = new InMemoryScopeStore();
    const a = new ScopeSequencer(SCOPE, EPOCH, { durable: store });
    a.submit(submitFor(a, transcript("t1", "v"), "k1"));
    expect(() => new ScopeSequencer("other_room", EPOCH, { durable: store })).toThrow(/hydration mismatch/);
    expect(() => new ScopeSequencer(SCOPE, "cat2", { durable: store })).toThrow(/epoch mismatch/);
  });
});

describe("tail bound holds durably", () => {
  it("the store never retains more than tailLimit entries", () => {
    const store = new InMemoryScopeStore();
    const a = new ScopeSequencer(SCOPE, EPOCH, { durable: store, tailLimit: 2 });
    for (let i = 0; i < 4; i += 1) {
      const reply = a.submit(submitFor(a, transcript(`t${i}`, `v${i}`), `k${i}`));
      expect(reply.status).toBe("accepted");
    }
    expect(store.readTail().map((e) => e.seq)).toEqual([3, 4]);
    const b = new ScopeSequencer(SCOPE, EPOCH, { durable: store, tailLimit: 2 });
    expect(b.recoveryTail().map((e) => e.seq)).toEqual([3, 4]);
  });
});

describe("no-store behavior unchanged", () => {
  it("a sequencer without durable works exactly as before", () => {
    const a = new ScopeSequencer(SCOPE, EPOCH);
    const reply = a.submit(submitFor(a, transcript("t1", "v"), "k1"));
    expect(reply.status).toBe("accepted");
    expect(a.head().seq).toBe(1);
  });
});
