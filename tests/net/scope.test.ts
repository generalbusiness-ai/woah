// ScopeSequencer — CO4 validation order, CO2.5 idempotency, CO2.8
// durable continuations. Assertions ported from the v2 validation corpus
// semantics (stale-head, read-version, post-state, replay) against the
// net sequencer.
import { describe, expect, it } from "vitest";
import { CellStore, cellVersion } from "../../src/net/cells";
import { applyTranscript, type EffectTranscript } from "../../src/net/transcript";
import { ScopeSequencer, type CommitSubmit } from "../../src/net/scope";
import { InMemoryScopeStore } from "../../src/net/scope-store";

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

  it("refuses a seed once the scope has committed turns (reviewer finding 1: the destructive-reseed guard)", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed([{ kind: "property_cell", object: "#thing", name: "n", value: { value: 1 } }]);
    // Pre-traffic re-seed stays the crash-recovery story.
    seq.seed([{ kind: "property_cell", object: "#thing", name: "n", value: { value: 1 } }]);

    const reply = seq.submit(submitFor(seq, transcript({ writes: [propWrite(2)] }), "k-seeded"));
    expect(reply.status).toBe("accepted");
    const headAfterCommit = seq.head();
    expect(seq.store.get("property_cell:#thing:n")?.value).toEqual({ value: 2 });

    // The reviewer's repro: a same-epoch re-seed would have silently
    // reset the committed value to 1 UNDER AN UNCHANGED HEAD. It must
    // refuse terminally instead, leaving state and head untouched.
    expect(() => seq.seed([{ kind: "property_cell", object: "#thing", name: "n", value: { value: 1 } }])).toThrowError(
      /E_SEED_COMMITTED/
    );
    expect(seq.store.get("property_cell:#thing:n")?.value).toEqual({ value: 2 });
    expect(seq.head()).toEqual(headAfterCommit);

    // The activation state machine stays available AFTER commits — it is
    // a dedicated operator op, never a seed.
    seq.operatorActivationWrite({ kind: "property_cell", object: "$system", name: "net_active_epoch", value: { value: null } });
    expect(seq.store.get("property_cell:$system:net_active_epoch")?.value).toEqual({ value: null });
    expect(seq.head()).toEqual(headAfterCommit);
  });

  it("owns predicate routes foreign reads to attestation; without it every read validates locally (CO2.4/CO2.3)", () => {
    // Multi-scope topology: this sequencer owns #thing but not #elsewhere.
    // A transcript read of #elsewhere carries the planning view's version;
    // a scope that cannot attest the cell from its own store validates it
    // against the submit's owner attestation instead (CO2.3 rider
    // integrity — see the dedicated describe below). Without `owns`
    // (single-scope deployment) the same submit validates every read
    // against the local store, attestations ignored.
    const foreignRead = {
      reads: [{ cell: { kind: "prop" as const, object: "#elsewhere", name: "x" }, version: "view-version", value: null as never }],
      writes: [propWrite("v1")]
    };
    const owning = new ScopeSequencer(SCOPE, EPOCH, { owns: (object) => object === "#thing" });
    const attested = {
      ...submitFor(owning, transcript(foreignRead), "k1"),
      attestations: { the_cluster: { owner_head: { seq: 3, hash: "h3" }, cells: [{ key: "property_cell:#elsewhere:x", version: "view-version" }] } }
    };
    expect(owning.submit(attested).status).toBe("accepted");
    const single = new ScopeSequencer(SCOPE, EPOCH);
    // The single-scope sequencer ignores the attestation: #elsewhere is
    // absent from its store, so the "view-version" read mismatches.
    const reply = single.submit({ ...submitFor(single, transcript(foreignRead), "k1"), attestations: attested.attestations });
    expect(reply.status === "rejected" && reply.reason === "read_version_mismatch").toBe(true);
  });

  it("replayed idempotency key returns the recorded reply marked replayed (CO2.5, B2)", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const submit = submitFor(seq, transcript({ writes: [propWrite("v1")] }), "k1");
    const first = seq.submit(submit);
    expect(first.status === "accepted" && first.replayed).toBeUndefined(); // fresh accept is not a replay
    const replay = seq.submit(submit);
    expect(seq.head().seq).toBe(1); // no double-commit
    // The replay is a COPY marked replayed — never the cached object (so a
    // later reader of the cache can't observe the stamp), same verdict/
    // head otherwise. The B2 signal: the gateway learns "committed
    // nothing" authoritatively instead of guessing by digest.
    expect(replay).not.toBe(first);
    expect(replay.status === "accepted" && replay.replayed).toBe(true);
    expect(replay.head).toEqual(first.head);
    // Replay-of-a-replay is still stable (the cache never gained the stamp).
    const replay2 = seq.submit(submit);
    expect(replay2.status === "accepted" && replay2.replayed).toBe(true);
    expect(replay2.head).toEqual(first.head);
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

// CO2.3 rider integrity, rule 1 (spec/protocol/coherence.md amendment
// 2026-07-06): a committing scope validates FOREIGN-anchored reads against
// the owner attestation the submit carries — matching versions accept,
// differing versions repair as read_version_mismatch (the gateway
// re-attests + re-plans), and a rider read with no covering attestation
// rejects terminal rider_unattested (never silently skipped).
describe("rider read attestation (CO2.3)", () => {
  const RIDER_KEY = "property_cell:#elsewhere:x";

  /** Ride-along shape: one owned write plus a read of a cell anchored at
   * another scope, planned at `readVersion` through the gateway view. */
  function riderReadTranscript(readVersion: string) {
    return transcript({
      reads: [{ cell: { kind: "prop" as const, object: "#elsewhere", name: "x" }, version: readVersion, value: null as never }],
      writes: [propWrite("v1")]
    });
  }

  function owningSequencer(): ScopeSequencer {
    return new ScopeSequencer(SCOPE, EPOCH, { owns: (object) => object === "#thing" });
  }

  function attestationAt(version: string): CommitSubmit["attestations"] {
    return { the_cluster: { owner_head: { seq: 7, hash: "owner-h7" }, cells: [{ key: RIDER_KEY, version }] } };
  }

  it("a rider read matching its owner attestation accepts", () => {
    const seq = owningSequencer();
    const submit = { ...submitFor(seq, riderReadTranscript("owner-v1"), "k1"), attestations: attestationAt("owner-v1") };
    expect(seq.submit(submit).status).toBe("accepted");
  });

  it("a stale attestation rejects retryable read_version_mismatch naming the rider cell", () => {
    // The owner moved between the view's install and the attest fetch:
    // the plan read owner-v1, the owner attests owner-v2. Retryable — the
    // gateway refreshes the cell from its owner, re-attests, re-plans.
    const seq = owningSequencer();
    const submit = { ...submitFor(seq, riderReadTranscript("owner-v1"), "k1"), attestations: attestationAt("owner-v2") };
    const reply = seq.submit(submit);
    expect(reply.status).toBe("rejected");
    if (reply.status === "rejected") {
      expect(reply.reason).toBe("read_version_mismatch");
      expect(reply.retryable).toBe(true);
      expect(reply.mismatched_reads).toEqual([{ kind: "prop", object: "#elsewhere", name: "x" }]);
    }
    expect(seq.head().seq).toBe(0); // nothing committed
  });

  it("a rider read with no covering attestation rejects terminal rider_unattested", () => {
    const seq = owningSequencer();
    // No attestations at all…
    const bare = seq.submit(submitFor(seq, riderReadTranscript("owner-v1"), "k1"));
    expect(bare.status).toBe("rejected");
    if (bare.status === "rejected") {
      expect(bare.reason).toBe("rider_unattested");
      expect(bare.retryable).toBe(false);
      expect(bare.detail).toEqual({ key: RIDER_KEY });
    }
    // …and an attestation that covers a DIFFERENT cell is equally not
    // proof for this one.
    const wrongCell = {
      ...submitFor(seq, riderReadTranscript("owner-v1"), "k2"),
      attestations: { the_cluster: { owner_head: { seq: 7, hash: "owner-h7" }, cells: [{ key: "property_cell:#elsewhere:other", version: "v" }] } }
    };
    const reply = seq.submit(wrongCell);
    expect(reply.status === "rejected" && reply.reason === "rider_unattested" && !reply.retryable).toBe(true);
  });

  it("owns absent (single-scope): every read validates locally, attestations ignored", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed([{ kind: "property_cell", object: "#elsewhere", name: "x", value: { value: "here" } }]);
    const version = seq.store.get(RIDER_KEY)?.version as string;
    // Local validation passes on the store's version even though the
    // attached attestation names a different one — the field is only
    // consulted when `owns` is wired.
    const submit = { ...submitFor(seq, riderReadTranscript(version), "k1"), attestations: attestationAt("some-other-version") };
    expect(seq.submit(submit).status).toBe("accepted");
  });
});

// CO2.3 rider integrity, rule 2: adoption is an owner-sequenced commit —
// per-cell prior-version CAS (owner-wins on mismatch, named conflicts),
// ONE head advance per applied batch, adopted cells stamped with the new
// head, and a tail entry naming the adoption fact.
describe("owner-sequenced adoption (CO2.3)", () => {
  const GREETED = "property_cell:#actor:greeted";
  const LIVE = "object_live:#actor";

  function ownerWith(greeted: unknown): ScopeSequencer {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed([{ kind: "property_cell", object: "#actor", name: "greeted", value: greeted }]);
    return seq;
  }

  /** An incoming adopted cell as the committing scope ships it (its own
   * stamp; the version is the value's content address either way). */
  function incoming(key: string, kind: "property_cell" | "object_live", name: string | undefined, value: unknown) {
    return {
      key,
      kind,
      object: "#actor",
      ...(name !== undefined ? { name } : {}),
      value,
      version: cellVersion(value),
      provenance: "authoritative" as const,
      stamp: { scope_head: "9:committing-scope-head", catalog_epoch: EPOCH }
    };
  }

  it("applies a matching batch as ONE owner commit: head advances once, cells stamp the new head, tail names the adoption", () => {
    const seq = ownerWith({ value: 0 });
    const prior = seq.store.get(GREETED)?.version as string;
    const result = seq.adopt({
      from_scope: "room_w",
      seq: 5,
      cells: [
        incoming(GREETED, "property_cell", "greeted", { value: 1 }),
        incoming(LIVE, "object_live", undefined, { location: "room_w" })
      ],
      priors: { [GREETED]: prior } // LIVE ships no prior: a blind write, applied owner-ordered
    });
    expect(result.status).toBe("applied");
    expect(result.applied).toEqual([LIVE, GREETED].sort());
    expect(result.conflicts).toEqual([]);
    // One head advance for the two-cell batch.
    expect(seq.head().seq).toBe(1);
    expect(result.head).toEqual(seq.head());
    // Adopted cells are authoritative AT THE NEW HEAD (CO8): the owner
    // minted the stamp; the committing scope's stamp does not survive.
    for (const key of result.applied) {
      const cell = seq.store.get(key);
      expect(cell?.provenance).toBe("authoritative");
      expect(cell?.stamp.scope_head).toBe(`${seq.head().seq}:${seq.head().hash}`);
    }
    expect(seq.store.get(GREETED)?.value).toEqual({ value: 1 });
    // The recovery tail names the adoption fact in transcript_hash form.
    expect(seq.recoveryTail()).toEqual([{ seq: 1, transcript_hash: "adopt:room_w:5", touched: result.applied }]);
  });

  it("owner-wins on a prior mismatch: the conflict is named, applied cells still land, the head still advances", () => {
    const seq = ownerWith({ value: 42 }); // the owner moved inside the window
    const result = seq.adopt({
      from_scope: "room_w",
      seq: 6,
      cells: [
        incoming(GREETED, "property_cell", "greeted", { value: 1 }),
        incoming(LIVE, "object_live", undefined, { location: "room_w" })
      ],
      priors: { [GREETED]: cellVersion({ value: 0 }) } // the committing turn observed the OLD value
    });
    expect(result.status).toBe("applied"); // the blind LIVE cell applied
    expect(result.applied).toEqual([LIVE]);
    expect(result.conflicts).toEqual([{ key: GREETED, ours: cellVersion({ value: 42 }), theirs: cellVersion({ value: 1 }) }]);
    expect(seq.store.get(GREETED)?.value).toEqual({ value: 42 }); // owner survived
    expect(seq.head().seq).toBe(1); // the applied cell is an owner event
  });

  it("an all-conflict adoption is empty: no head advance, no tail entry, conflicts surfaced", () => {
    const seq = ownerWith({ value: 42 });
    const result = seq.adopt({
      from_scope: "room_w",
      seq: 7,
      cells: [incoming(GREETED, "property_cell", "greeted", { value: 1 })],
      priors: { [GREETED]: cellVersion({ value: 0 }) }
    });
    expect(result.status).toBe("empty");
    expect(result.applied).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(seq.head().seq).toBe(0);
    expect(seq.recoveryTail()).toEqual([]);
    expect(seq.store.get(GREETED)?.value).toEqual({ value: 42 });
  });

  it('a prior of "absent" CASes against a missing cell (first ride-along write)', () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH); // no greeted cell at all
    const result = seq.adopt({
      from_scope: "room_w",
      seq: 1,
      cells: [incoming(GREETED, "property_cell", "greeted", { value: 1 })],
      priors: { [GREETED]: "absent" }
    });
    expect(result.status).toBe("applied");
    expect(seq.store.get(GREETED)?.value).toEqual({ value: 1 });
    expect(seq.head().seq).toBe(1);
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

describe("reply-cache boundedness (H2a)", () => {
  it("prunes old replies past the tail window + recent set, memory and durable rows in lockstep", () => {
    const store = new InMemoryScopeStore();
    const seq = new ScopeSequencer(SCOPE, EPOCH, { durable: store, tailLimit: 4, replyLimit: 8 });
    // Keep the FIRST submit verbatim: replaying it after its reply prunes
    // must re-validate (and safely reject stale_head), never re-commit.
    let firstSubmit: CommitSubmit | null = null;
    for (let i = 0; i < 40; i += 1) {
      const submit = submitFor(seq, transcript({ writes: [propWrite(`v${i}`)], hash: `h2a-${i}` }), `h2a-key-${i}`);
      if (i === 0) firstSubmit = submit;
      const reply = seq.submit(submit);
      expect(reply.status, `commit ${i}`).toBe("accepted");
    }
    // Bounded: 40 commits, at most replyLimit retained — durably too.
    expect(store.readReplies().length).toBeLessThanOrEqual(8);
    const keys = store.readReplies().map((row) => row.key);
    expect(keys).toContain("h2a-key-39");
    expect(keys).not.toContain("h2a-key-0");

    // A RECENT key still replays (recorded reply, marked).
    const replay = seq.submit(submitFor(seq, transcript({ writes: [propWrite("again")], hash: "h2a-replay" }), "h2a-key-39"));
    expect(replay.status).toBe("accepted");
    expect(replay.status === "accepted" && replay.replayed).toBe(true);

    // A PRUNED key's late replay re-validates instead of replaying — and
    // its ancient base rejects stale_head. Safe: it can never silently
    // re-commit (committing needs the current head + fresh reads).
    const headBefore = seq.head().seq;
    const late = seq.submit(firstSubmit as CommitSubmit);
    expect(late.status).toBe("rejected");
    expect(late.status === "rejected" && late.reason).toBe("stale_head");
    expect(seq.head().seq).toBe(headBefore);

    // Rehydration sees the bounded set, not a resurrected unbounded one.
    const rehydrated = new ScopeSequencer(SCOPE, EPOCH, { durable: store, tailLimit: 4, replyLimit: 8 });
    const rereplay = rehydrated.submit(submitFor(rehydrated, transcript({ writes: [propWrite("again2")], hash: "h2a-re" }), "h2a-key-39"));
    expect(rereplay.status === "accepted" && rereplay.replayed).toBe(true);
  });

  it("never prunes a reply whose turn is still within the recovery-tail window", () => {
    // tailLimit LARGER than the commit count: every reply stays within
    // the window, so even a tiny replyLimit must not prune any of them.
    const store = new InMemoryScopeStore();
    const seq = new ScopeSequencer(SCOPE, EPOCH, { durable: store, tailLimit: 64, replyLimit: 2 });
    for (let i = 0; i < 10; i += 1) {
      const reply = seq.submit(submitFor(seq, transcript({ writes: [propWrite(`w${i}`)], hash: `h2aw-${i}` }), `h2aw-key-${i}`));
      expect(reply.status).toBe("accepted");
    }
    expect(store.readReplies().length).toBe(10);
  });
});

describe("creates over net: the allocation counter + collision guard (client-shell phase i)", () => {
  it("objectCounter derives from lineage ids, advances on accepted creates, and re-derives after seed", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed([
      { kind: "object_lineage", object: "#thing", value: { parent: null } },
      { kind: "object_lineage", object: `obj_${SCOPE}_5`, value: { parent: "#thing" } },
      { kind: "property_cell", object: "#thing", name: "label", value: { value: "x" } }
    ]);
    expect(seq.objectCounter()).toBe(6);

    // An accepted create advances the counter past its id suffix.
    const create = transcript({
      creates: [{ object: `obj_${SCOPE}_6`, name: "fresh", parent: "#thing", owner: "#actor", anchor: null, location: null, flags: {} }],
      hash: "counter-c1"
    });
    const reply = seq.submit(submitFor(seq, create, "counter-k1"));
    expect(reply.status).toBe("accepted");
    expect(seq.objectCounter()).toBe(7);
  });

  it("a create colliding with an existing id rejects as a read-version mismatch naming the lineage cell (repair installs the object; the re-plan skips the id)", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed([
      { kind: "object_lineage", object: "#thing", value: { parent: null } },
      { kind: "object_lineage", object: `obj_${SCOPE}_3`, value: { parent: "#thing" } }
    ]);
    // A plan whose slice never saw obj_<scope>_3 (a stale counter) tries
    // to create it again — the authority must never silently overwrite.
    const colliding = transcript({
      creates: [{ object: `obj_${SCOPE}_3`, name: "dupe", parent: "#thing", owner: "#actor", anchor: null, location: null, flags: {} }],
      hash: "counter-c2"
    });
    const reply = seq.submit(submitFor(seq, colliding, "counter-k2"));
    expect(reply.status).toBe("rejected");
    if (reply.status !== "rejected") return;
    expect(reply.reason).toBe("read_version_mismatch");
    expect(reply.retryable).toBe(true);
    expect(reply.mismatched_reads).toEqual([{ kind: "lifecycle", object: `obj_${SCOPE}_3` }]);
    // The existing object is untouched.
    expect(seq.store.get(`object_lineage:obj_${SCOPE}_3`)?.value).toMatchObject({ parent: "#thing" });
  });
});
