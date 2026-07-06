// ScopeSequencer — CO4 validation order, CO2.5 idempotency, CO2.8
// durable continuations. Assertions ported from the v2 validation corpus
// semantics (stale-head, read-version, post-state, replay) against the
// net sequencer.
import { describe, expect, it } from "vitest";
import { CellStore } from "../../src/net/cells";
import { applyTranscript, type EffectTranscript } from "../../src/net/transcript";
import { ScopeSequencer, type CommitSubmit } from "../../src/net/scope";

const SCOPE = "the_room";
const EPOCH = "cat1";

function transcript(partial: Partial<EffectTranscript>): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    route: "sequenced",
    scope: SCOPE,
    seq: 1,
    call: { actor: "#actor", target: "#thing", verb: "poke", args: [], body: undefined },
    reads: [],
    writes: [],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: `t-${Math.abs(JSON.stringify(partial).split("").reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7))}`,
    ...partial
  } as EffectTranscript;
}

const WRITER = { progr: "#actor", thisObj: "#thing", verb: "poke", definer: "$thing", caller: "#actor", callerPerms: "#actor" };

/** Planner parity: compute post_state_version the way plan.ts will —
 * by applying the transcript to a clone of current authority. */
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

function propWrite(value: unknown) {
  return { cell: { kind: "prop" as const, object: "#thing", name: "n" }, value: value as never, op: "set" as const, writer: WRITER };
}

describe("commit acceptance (CO4)", () => {
  it("accepts a valid turn, advances head, exposes touched cells", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const reply = seq.submit(submitFor(seq, transcript({ writes: [propWrite("v1")] }), "k1"));
    expect(reply.status).toBe("accepted");
    if (reply.status === "accepted") {
      expect(reply.head.seq).toBe(1);
      expect(reply.touched).toEqual(["property_cell:#thing:n"]);
    }
    expect(seq.store.get("property_cell:#thing:n")?.value).toEqual({ value: "v1" });
    expect(seq.store.get("property_cell:#thing:n")?.provenance).toBe("authoritative");
  });

  it("accepted cells stamp the actual head — `seq:hash` — per CO8", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    for (let i = 0; i < 2; i += 1) {
      const reply = seq.submit(submitFor(seq, transcript({ writes: [propWrite(`v${i}`)], hash: `t${i}` }), `k${i}`));
      expect(reply.status).toBe("accepted");
      if (reply.status !== "accepted") return;
      // Post-accept invariant: every touched cell's stamp names the head
      // the commit produced (the full seq:hash form stamp() uses, never a
      // bare counter), so epoch checks (CO8) compare real heads.
      const head = seq.head();
      expect(reply.head).toEqual(head);
      for (const key of reply.touched) {
        const cell = seq.store.get(key);
        expect(cell?.stamp.scope_head).toBe(`${head.seq}:${head.hash}`);
        expect(cell?.stamp.catalog_epoch).toBe(EPOCH);
      }
    }
  });

  it("owns predicate skips foreign-anchored reads; without it every read validates (CO2.4)", () => {
    // Multi-scope topology: this sequencer owns #thing but not #elsewhere.
    // A transcript read of #elsewhere carries the planning view's version;
    // a scope that cannot attest the cell must not reject on it — its
    // freshness is the gateway's cross-scope repair concern at the owning
    // scope. Without `owns` (single-scope deployment) the same submit
    // rejects, which is the surfaced Phase-2 gap the option closes.
    const foreignRead = {
      reads: [{ cell: { kind: "prop" as const, object: "#elsewhere", name: "x" }, version: "view-version", value: null as never }],
      writes: [propWrite("v1")]
    };
    const owning = new ScopeSequencer(SCOPE, EPOCH, { owns: (object) => object === "#thing" });
    expect(owning.submit(submitFor(owning, transcript(foreignRead), "k1")).status).toBe("accepted");
    const single = new ScopeSequencer(SCOPE, EPOCH);
    const reply = single.submit(submitFor(single, transcript(foreignRead), "k1"));
    expect(reply.status === "rejected" && reply.reason === "read_version_mismatch").toBe(true);
  });

  it("replayed idempotency key returns the recorded reply (CO2.5)", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const submit = submitFor(seq, transcript({ writes: [propWrite("v1")] }), "k1");
    const first = seq.submit(submit);
    const replay = seq.submit(submit);
    expect(replay).toBe(first);
    expect(seq.head().seq).toBe(1); // no double-commit
  });

  it("stale base rejects retryable stale_head", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const stale = submitFor(seq, transcript({ writes: [propWrite("a")] }), "k1");
    seq.submit(submitFor(seq, transcript({ writes: [propWrite("b")], hash: "other" }), "k2"));
    const reply = seq.submit(stale);
    expect(reply.status).toBe("rejected");
    if (reply.status === "rejected") {
      expect(reply.reason).toBe("stale_head");
      expect(reply.retryable).toBe(true);
      expect(reply.head.seq).toBe(1);
    }
  });

  it("epoch mismatch rejects retryable stale_epoch (CO8)", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const submit = { ...submitFor(seq, transcript({}), "k1"), stamp: { scope_head: "x", catalog_epoch: "old" } };
    const reply = seq.submit(submit);
    expect(reply.status === "rejected" && reply.reason === "stale_epoch" && reply.retryable).toBe(true);
  });

  it("scope mismatch rejects terminally", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const reply = seq.submit({ ...submitFor(seq, transcript({}), "k1"), scope: "elsewhere" });
    expect(reply.status === "rejected" && reply.reason === "scope_mismatch" && !reply.retryable).toBe(true);
  });

  it("incomplete transcripts are rejected and never relabelled (CO4)", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    // Also stale-able: base is current but reads would mismatch — the
    // incomplete verdict must win because it is checked first and never
    // short-circuited into another reason.
    const t = transcript({ complete: false, incompleteReasons: ["untracked native effect"], reads: [{ cell: { kind: "prop", object: "#thing", name: "n" }, version: "nope", value: null as never }] });
    const reply = seq.submit(submitFor(seq, t, "k1"));
    expect(reply.status === "rejected" && reply.reason === "incomplete_transcript").toBe(true);
  });

  it("read-version mismatch rejects retryable with the mismatched cells (repair input)", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    // Seed with the canonical `{value}` property payload (transcript.ts
    // PropertyCellPayload) so seeded and apply-produced cells share versions.
    seq.seed([{ kind: "property_cell", object: "#thing", name: "n", value: { value: "current" } }]);
    const t = transcript({ reads: [{ cell: { kind: "prop", object: "#thing", name: "n" }, version: "stale-version", value: "old" as never }] });
    const reply = seq.submit(submitFor(seq, t, "k1"));
    expect(reply.status).toBe("rejected");
    if (reply.status === "rejected") {
      expect(reply.reason).toBe("read_version_mismatch");
      expect(reply.retryable).toBe(true);
      expect(reply.mismatched_reads).toEqual([{ kind: "prop", object: "#thing", name: "n" }]);
    }
  });

  it("reads at the current authority version validate", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    // Seed with the canonical `{value}` property payload (transcript.ts
    // PropertyCellPayload) so seeded and apply-produced cells share versions.
    seq.seed([{ kind: "property_cell", object: "#thing", name: "n", value: { value: "current" } }]);
    const version = seq.store.get("property_cell:#thing:n")?.version as string;
    const t = transcript({
      reads: [{ cell: { kind: "prop", object: "#thing", name: "n" }, version, value: "current" as never }],
      writes: [propWrite("next")]
    });
    expect(seq.submit(submitFor(seq, t, "k1")).status).toBe("accepted");
  });

  it("authority-cell writes must name their recording VM frame (CO3)", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const t = transcript({ writes: [{ cell: { kind: "prop", object: "#thing", name: "n" }, value: "v" as never, op: "set" }] }); // no writer
    const reply = seq.submit(submitFor(seq, t, "k1"));
    expect(reply.status === "rejected" && reply.reason === "write_unauthorized").toBe(true);
  });

  it("post-state divergence rejects retryable post_state_mismatch (CO4.10)", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const submit = { ...submitFor(seq, transcript({ writes: [propWrite("v")] }), "k1"), post_state_version: "wrong-digest" };
    const reply = seq.submit(submit);
    expect(reply.status === "rejected" && reply.reason === "post_state_mismatch" && reply.retryable).toBe(true);
    expect(seq.head().seq).toBe(0); // nothing committed
  });

  it("keeps a bounded recovery tail", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH, { tailLimit: 2 });
    for (let i = 0; i < 4; i += 1) {
      seq.submit(submitFor(seq, transcript({ writes: [propWrite(`v${i}`)], hash: `t${i}` }), `k${i}`));
    }
    expect(seq.head().seq).toBe(4);
    expect(seq.recoveryTail().map((e) => e.seq)).toEqual([3, 4]);
  });
});

describe("durable continuations (CO2.8)", () => {
  it("orders due turns and computes the next alarm", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.schedule({ id: "b", at_logical_time: 20, call: { actor: "#a", target: "#t", verb: "tick", args: [] } }, 0);
    seq.schedule({ id: "a", at_logical_time: 10, call: { actor: "#a", target: "#t", verb: "tick", args: [] } }, 0);
    expect(seq.nextAlarmAt()).toBe(10);
    const due = seq.dueTurns(15);
    expect(due.map((t) => t.id)).toEqual(["a"]);
    expect(seq.nextAlarmAt()).toBe(20);
    // Popped turns do not re-fire (queue is consumed, alarm advances).
    expect(seq.dueTurns(15)).toEqual([]);
  });

  it("refuses past-time schedules and supports cancellation", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    expect(() => seq.schedule({ id: "x", at_logical_time: 5, call: { actor: "#a", target: "#t", verb: "tick", args: [] } }, 10)).toThrow(/future logical time/);
    seq.schedule({ id: "y", at_logical_time: 30, call: { actor: "#a", target: "#t", verb: "tick", args: [] } }, 0);
    expect(seq.cancel("y")).toBe(true);
    expect(seq.nextAlarmAt()).toBeNull();
  });
});
