// ScopeSequencer — CO4 validation order, CO2.5 idempotency, CO2.8
// durable continuations. Assertions ported from the v2 validation corpus
// semantics (stale-head, read-version, post-state, replay) against the
// net sequencer.
import { describe, expect, it } from "vitest";
import { CellStore, cellVersion } from "../../src/net/cells";
import { applyTranscript, type EffectTranscript } from "../../src/net/transcript";
import { ScopeSequencer, type CommitSubmit } from "../../src/net/scope";
import { SCHEDULE_CLOCK_INPUT } from "../../src/core/scheduling";
import { InMemoryScopeStore } from "../../src/net/scope-store";
import { replayPageVersion } from "../../src/net/replay-pages";

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
    seq.operatorActivationWrite(null);
    expect(seq.store.get("property_cell:$system:net_active_epoch")?.value).toEqual({ value: null });
    expect(seq.head()).toMatchObject({ seq: headAfterCommit.seq, hash: headAfterCommit.hash });
    expect(seq.head().generation).toBe((headAfterCommit.generation ?? 0) + 1);
  });

  it("preserves seeded relations when a legacy same-epoch re-seed omits the relation field", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const cells = [{ kind: "object_lineage" as const, object: "#thing", value: { parent: null } }];
    const row = { relation: "contents", owner: "#room", member: "#thing" };

    seq.seed(cells, [row]);
    seq.seed(cells);
    expect([...seq.relations().values()]).toEqual([row]);

    // Presence of [] remains an explicit complete empty relation family.
    seq.seed(cells, []);
    expect(seq.relations().size).toBe(0);
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

  it("validates pure direct reads without advancing or caching the authority head", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed([{ kind: "property_cell", object: "#thing", name: "n", value: { value: "stable" } }]);
    const cell = seq.store.get("property_cell:#thing:n");
    const read = transcript({
      route: "direct",
      seq: -1,
      reads: [{
        cell: { kind: "prop", object: "#thing", name: "n" },
        version: cell?.version,
        value: "stable" as never
      }]
    });
    const before = seq.head();
    const first = seq.submit(submitFor(seq, read, "pure-read"));
    const second = seq.submit(submitFor(seq, read, "pure-read"));

    expect(first).toMatchObject({ status: "accepted", head: before, touched: [] });
    expect(second).toMatchObject({ status: "accepted", head: before, touched: [] });
    expect(first.status === "accepted" && first.replayed).toBeUndefined();
    expect(second.status === "accepted" && second.replayed).toBeUndefined();
    expect(seq.head()).toEqual(before);
  });

  it("refuses complete-head compaction across a head-stable activation generation", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const compacted = {
      ...submitFor(seq, transcript({ route: "direct", seq: -1 }), "compacted-before-activation"),
      owned_reads_compacted: true as const
    };
    const before = seq.head();
    seq.operatorActivationWrite(null);
    expect(seq.head()).toMatchObject({ seq: before.seq, hash: before.hash });
    expect(seq.head().generation).toBe((before.generation ?? before.seq) + 1);

    const reply = seq.submit(compacted);
    expect(reply.status).toBe("rejected");
    expect(reply.status === "rejected" && reply.reason).toBe("stale_head");
  });

  it("rebases independent turns from the same retained head", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const first = submitFor(seq, transcript({ hash: "concurrent-a", observations: [{ type: "said", text: "a" }] }), "k1");
    const second = submitFor(seq, transcript({ hash: "concurrent-b", observations: [{ type: "said", text: "b" }] }), "k2");
    expect(seq.submit(first).status).toBe("accepted");
    const reply = seq.submit(second);
    expect(reply.status).toBe("accepted");
    expect(seq.head().seq).toBe(2);
  });

  it("retained-head rebase still rejects a true read/write conflict", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.seed([{ kind: "property_cell", object: "#thing", name: "n", value: { value: "before" } }]);
    const version = seq.store.get("property_cell:#thing:n")?.version;
    const read = { cell: { kind: "prop" as const, object: "#thing", name: "n" }, version, value: { value: "before" } as never };
    const first = submitFor(seq, transcript({ reads: [read], writes: [propWrite("a")], hash: "conflict-a" }), "k1");
    const second = submitFor(seq, transcript({ reads: [read], writes: [propWrite("b")], hash: "conflict-b" }), "k2");
    expect(seq.submit(first).status).toBe("accepted");
    const reply = seq.submit(second);
    expect(reply.status).toBe("rejected");
    if (reply.status === "rejected") {
      expect(reply.reason).toBe("read_version_mismatch");
      expect(reply.mismatched_reads).toEqual([{ kind: "prop", object: "#thing", name: "n" }]);
    }
    expect(seq.store.get("property_cell:#thing:n")?.value).toEqual({ value: "a" });
  });

  it("rejects a stale base whose hash is not proved by the retained tail", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const stale = submitFor(seq, transcript({ hash: "forged-stale" }), "k1");
    expect(seq.submit(submitFor(seq, transcript({ hash: "advance" }), "k2")).status).toBe("accepted");
    stale.base = { ...stale.base, hash: "not-an-authority-head" };
    const reply = seq.submit(stale);
    expect(reply.status).toBe("rejected");
    if (reply.status === "rejected") {
      expect(reply.reason).toBe("stale_head");
      expect(reply.retryable).toBe(true);
      expect(reply.head.seq).toBe(1);
    }
  });

  it("hydrates retained-head proofs and rebases after a cold start", () => {
    const store = new InMemoryScopeStore();
    const warm = new ScopeSequencer(SCOPE, EPOCH, { durable: store });
    const first = submitFor(warm, transcript({ hash: "cold-a" }), "cold-k1");
    const second = submitFor(warm, transcript({ hash: "cold-b" }), "cold-k2");
    expect(warm.submit(first).status).toBe("accepted");

    const cold = new ScopeSequencer(SCOPE, EPOCH, { durable: store });
    expect(cold.submit(second).status).toBe("accepted");
    expect(cold.head().seq).toBe(2);
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

describe("replay-page read attestation (SL4/CO2.4)", () => {
  const foreignRead = { space: "other_room", from: 1, limit: 100, scope: "room:other_room", version: "page-v1" };

  function replayReadTranscript(read = foreignRead): EffectTranscript {
    return transcript({ writes: [propWrite("v1")], replayReads: [read] });
  }

  it("requires a foreign page attestation and rejects a changed version retryably", () => {
    const missingOwner = new ScopeSequencer(SCOPE, EPOCH, { owns: (object) => object === "#thing" });
    const missing = missingOwner.submit(submitFor(missingOwner, replayReadTranscript(), "replay-missing"));
    expect(missing).toMatchObject({ status: "rejected", reason: "rider_unattested", retryable: false });

    const staleOwner = new ScopeSequencer(SCOPE, EPOCH, { owns: (object) => object === "#thing" });
    const stale = staleOwner.submit({
      ...submitFor(staleOwner, replayReadTranscript(), "replay-stale"),
      attestations: {
        [foreignRead.scope]: {
          owner_head: { seq: 3, hash: "owner-h3" },
          cells: [],
          replays: [{ space: foreignRead.space, from: foreignRead.from, limit: foreignRead.limit, version: "page-v2" }]
        }
      }
    });
    expect(stale).toMatchObject({
      status: "rejected",
      reason: "read_version_mismatch",
      retryable: true,
      detail: { replay_conflicts: [{ scope: foreignRead.scope, space: foreignRead.space, from: 1, limit: 100 }] }
    });
  });

  it("accepts matching foreign and locally re-derived empty page versions", () => {
    const foreignOwner = new ScopeSequencer(SCOPE, EPOCH, { owns: (object) => object === "#thing" });
    const foreign = foreignOwner.submit({
      ...submitFor(foreignOwner, replayReadTranscript(), "replay-foreign-ok"),
      attestations: {
        [foreignRead.scope]: {
          owner_head: { seq: 3, hash: "owner-h3" },
          cells: [],
          replays: [{ space: foreignRead.space, from: 1, limit: 100, version: foreignRead.version }]
        }
      }
    });
    expect(foreign.status).toBe("accepted");

    const localOwner = new ScopeSequencer(SCOPE, EPOCH);
    const localRead = { space: SCOPE, from: 1, limit: 100, scope: SCOPE, version: replayPageVersion([]) };
    expect(localOwner.submit(submitFor(localOwner, replayReadTranscript(localRead), "replay-local-ok")).status).toBe("accepted");
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
    expect(seq.recoveryTail()).toEqual([
      expect.objectContaining({ seq: 1, transcript_hash: "adopt:room_w:5", touched: result.applied })
    ]);
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

// CO16.2 — schedule/cancellation effects. These are authority-bearing but are
// NOT writes: they carry their own provenance and their own validation path,
// and the scope checks every rule itself rather than trusting the submitter.
// Each case below is one a compromised or buggy planner could otherwise win.
describe("scheduled-turn effects (CO16.2)", () => {
  const NOW = 1_700_000_000_000;
  const LEAD = 60_000;

  /** Materialize a wizard-flagged object through an ordinary accepted turn,
   * so the `always` gate reads the same authority cells everything else does
   * rather than a hand-installed row. */
  function seedWizard(seq: ScopeSequencer, ref: string): void {
    const reply = seq.submit(submitFor(seq, transcript({
      creates: [{
        object: ref,
        name: ref,
        parent: "$root",
        owner: ref,
        anchor: null,
        location: null,
        flags: { wizard: true },
        writer: WRITER
      }]
    }), `seed-${ref}`));
    expect(reply.status).toBe("accepted");
  }

  function armed(overrides: Record<string, unknown> = {}) {
    return {
      id: "#thing:tick",
      at: NOW + LEAD,
      idlePolicy: "while_active" as const,
      call: { actor: "#actor", target: "#thing", verb: "tick", args: [] },
      armed_by: WRITER,
      ...overrides
    };
  }

  /** Materialize the schedule target in this scope. CO16.1 is same-scope
   * only, and the scope proves that by holding the target itself rather than
   * trusting a routing hint — so a target it has never seen is refused. */
  const seededTargets = new WeakSet<ScopeSequencer>();
  function seedTarget(seq: ScopeSequencer): void {
    if (seededTargets.has(seq)) return;
    seededTargets.add(seq);
    const reply = seq.submit(submitFor(seq, transcript({
      creates: [{
        object: "#thing",
        name: "Thing",
        parent: "$thing",
        owner: "#actor",
        anchor: null,
        location: null,
        flags: {},
        writer: WRITER
      }]
    }), "seed-thing"));
    expect(reply.status).toBe("accepted");
  }

  function armingTurn(seq: ScopeSequencer, partial: Partial<EffectTranscript>, key: string) {
    seedTarget(seq);
    // Use the SHARED constant, never a literal: the producer and the validator
    // disagreeing on this name is exactly the bug these tests missed once.
    return submitFor(seq, transcript({ logicalInputs: [{ name: SCHEDULE_CLOCK_INPUT, value: NOW }], ...partial }), key);
  }

  it("accepts a well-formed schedule and lands it in the pending queue", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const reply = seq.submit(armingTurn(seq, { schedules: [armed()] }, "s1"));
    expect(reply.status).toBe("accepted");
    expect(seq.peekDue(NOW + LEAD).map((row) => row.id)).toEqual(["#thing:tick"]);
    expect(seq.peekDue(NOW + LEAD)[0].idle_policy).toBe("while_active");
  });

  it("discards arming-frame provenance rather than storing it (CO16.4)", () => {
    // The whole point of validating `armed_by` and then dropping it: nothing
    // about the arming frame's authority may survive into the fired turn.
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.submit(armingTurn(seq, { schedules: [armed()] }, "s1"));
    const row = seq.peekDue(NOW + LEAD)[0];
    expect(JSON.stringify(row)).not.toContain("progr");
    expect(JSON.stringify(row)).not.toContain("callerPerms");
  });

  it("refuses a schedule with no arming-frame provenance", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const reply = seq.submit(armingTurn(seq, { schedules: [armed({ armed_by: undefined })] }, "s1"));
    expect(reply.status).toBe("rejected");
    if (reply.status !== "rejected") return;
    expect(reply.reason).toBe("schedule_unauthorized");
    expect(reply.retryable).toBe(false);
    expect(seq.peekDue(NOW + LEAD)).toEqual([]);
  });

  it("refuses an id outside the arming object's namespace (CO16.3)", () => {
    // Without this rule, any verb in the scope could upsert over — or cancel —
    // another object's timer: a same-scope DoS with no audit signal.
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const reply = seq.submit(armingTurn(seq, { schedules: [armed({ id: "#victim:tick" })] }, "s1"));
    expect(reply.status).toBe("rejected");
    if (reply.status !== "rejected") return;
    expect(reply.reason).toBe("schedule_unauthorized");
    expect(String(reply.detail?.schedule)).toMatch(/namespace/);
  });

  it("gates idle_policy \"always\" on the arming frame's wizard authority (CO16.6)", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const denied = seq.submit(armingTurn(seq, { schedules: [armed({ idlePolicy: "always" })] }, "s1"));
    expect(denied.status).toBe("rejected");
    if (denied.status === "rejected") expect(String(denied.detail?.schedule)).toMatch(/always/);

    // The same effect from a wizard-owned frame is exactly how a user-facing
    // one-shot reaches `always` through a $scheduling verb.
    const wizSeq = new ScopeSequencer(SCOPE, EPOCH);
    seedWizard(wizSeq, "$scheduling");
    const allowed = wizSeq.submit(armingTurn(wizSeq, {
      schedules: [armed({ idlePolicy: "always", armed_by: { ...WRITER, progr: "$scheduling" } })]
    }, "s2"));
    expect(allowed.status).toBe("accepted");
    expect(wizSeq.peekDue(NOW + LEAD)[0].idle_policy).toBe("always");
  });

  it("enforces the 60s minimum lead time against the turn's own recorded clock", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const reply = seq.submit(armingTurn(seq, { schedules: [armed({ at: NOW + 5_000 })] }, "s1"));
    expect(reply.status).toBe("rejected");
    if (reply.status === "rejected") expect(String(reply.detail?.schedule)).toMatch(/lead time/);
  });

  it("fails closed when the arming turn recorded no clock reading", () => {
    // No recorded `now` means the lead time cannot be checked against what the
    // planner computed against. Unvalidatable is not the same as valid.
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const reply = seq.submit(submitFor(seq, transcript({ schedules: [armed()] }), "s1"));
    expect(reply.status).toBe("rejected");
    if (reply.status === "rejected") expect(String(reply.detail?.schedule)).toMatch(/clock reading/);
  });

  it("refuses times beyond the 365-day horizon", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const beyond = NOW + 366 * 24 * 60 * 60 * 1000;
    const reply = seq.submit(armingTurn(seq, { schedules: [armed({ at: beyond })] }, "s1"));
    expect(reply.status).toBe("rejected");
    if (reply.status === "rejected") expect(String(reply.detail?.schedule)).toMatch(/horizon/);
  });

  it("upserts a stable key instead of accumulating duplicates", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.submit(armingTurn(seq, { schedules: [armed()] }, "s1"));
    seq.submit(armingTurn(seq, { schedules: [armed({ at: NOW + LEAD + 1_000 })] }, "s2"));
    const rows = seq.peekDue(NOW + LEAD + 5_000);
    expect(rows).toHaveLength(1);
    expect(rows[0].at_logical_time).toBe(NOW + LEAD + 1_000);
  });

  it("applies cancellations atomically with the turn, and only within the caller's namespace", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.submit(armingTurn(seq, { schedules: [armed()] }, "s1"));

    const foreign = seq.submit(armingTurn(seq, {
      cancellations: [{ id: "#thing:tick", armed_by: { ...WRITER, thisObj: "#other" } }]
    }, "s2"));
    expect(foreign.status).toBe("rejected");
    expect(seq.peekDue(NOW + LEAD)).toHaveLength(1);

    const own = seq.submit(armingTurn(seq, { cancellations: [{ id: "#thing:tick", armed_by: WRITER }] }, "s3"));
    expect(own.status).toBe("accepted");
    expect(seq.peekDue(NOW + LEAD)).toEqual([]);
  });

  it("refuses an id that appears in both schedules and cancellations", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const reply = seq.submit(armingTurn(seq, {
      schedules: [armed()],
      cancellations: [{ id: "#thing:tick", armed_by: WRITER }]
    }, "s1"));
    expect(reply.status).toBe("rejected");
    if (reply.status === "rejected") expect(String(reply.detail?.schedule)).toMatch(/both/);
  });

  it("arms nothing when the turn is rejected for an unrelated reason", () => {
    // CO16.2's atomicity claim, from the other side: a schedule recorded by a
    // turn that does not commit must not exist.
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const submit = armingTurn(seq, { schedules: [armed()] }, "s1");
    const stale = { ...submit, base: { seq: 99, hash: "nope", generation: 99 } };
    const reply = seq.submit(stale);
    expect(reply.status).toBe("rejected");
    expect(seq.peekDue(NOW + LEAD)).toEqual([]);
  });

  it("bounds the queue by per-object count and by serialized bytes (CO16.7)", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    // 32 entries for one object is the cap; the 33rd is refused.
    for (let i = 0; i < 32; i += 1) {
      const reply = seq.submit(armingTurn(seq, { schedules: [armed({ id: `#thing:t${i}` })] }, `fill-${i}`));
      expect(reply.status).toBe("accepted");
    }
    const overCount = seq.submit(armingTurn(seq, { schedules: [armed({ id: "#thing:t32" })] }, "over"));
    expect(overCount.status).toBe("rejected");
    if (overCount.status === "rejected") expect(String(overCount.detail?.schedule)).toMatch(/per-object cap/);

    // Counts alone would not bound storage: args are author-supplied.
    const fat = new ScopeSequencer(SCOPE, EPOCH);
    const huge = seq.submit(armingTurn(fat, {
      schedules: [armed({ call: { actor: "#actor", target: "#thing", verb: "tick", args: ["x".repeat(9000)] } })]
    }, "fat"));
    expect(huge.status).toBe("rejected");
    if (huge.status === "rejected") expect(String(huge.detail?.schedule)).toMatch(/per-entry cap/);
  });

  it("applies and bounds the queue the same way on a durable store", () => {
    // The in-memory sequencer keeps the queue in a Map; a durable scope keeps
    // it in the store's own row family. Both paths must enforce and apply
    // identically, or the caps would be a development-only fiction.
    const store = new InMemoryScopeStore();
    const seq = new ScopeSequencer(SCOPE, EPOCH, { durable: store });
    const ok = seq.submit(armingTurn(seq, { schedules: [armed()] }, "d1"));
    expect(ok.status).toBe("accepted");
    expect(store.readScheduled().map((row) => row.id)).toEqual(["#thing:tick"]);

    const foreign = seq.submit(armingTurn(seq, { schedules: [armed({ id: "#victim:tick" })] }, "d2"));
    expect(foreign.status).toBe("rejected");
    expect(store.readScheduled()).toHaveLength(1);

    const cancelled = seq.submit(armingTurn(seq, { cancellations: [{ id: "#thing:tick", armed_by: WRITER }] }, "d3"));
    expect(cancelled.status).toBe("accepted");
    expect(store.readScheduled()).toEqual([]);
  });

  it("defers while_active entries in an unattended scope, and never drops them (CO16.6)", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    // An empty session_subscribers list is the scope saying "nobody is here".
    seq.submit(submitFor(seq, transcript({
      writes: [{ cell: { kind: "prop" as const, object: SCOPE, name: "session_subscribers" }, value: [] as never, op: "set" as const, writer: WRITER }]
    }), "empty-room"));
    seq.submit(armingTurn(seq, { schedules: [armed()] }, "s1"));

    const idle = seq.deliverableDue(NOW + LEAD);
    expect(idle.deliverable).toEqual([]);
    expect(idle.parked.map((row) => row.id)).toEqual(["#thing:tick"]);
    // Deferred, not discarded: the entry is still queued for when someone
    // arrives. Dropping it would be the silent failure this design removes.
    expect(seq.peekDue(NOW + LEAD)).toHaveLength(1);

    // Someone attaches; the same entry becomes deliverable.
    seq.submit(submitFor(seq, transcript({
      writes: [{ cell: { kind: "prop" as const, object: SCOPE, name: "session_subscribers" }, value: [{ session: "s", actor: "#actor" }] as never, op: "set" as const, writer: WRITER }]
    }), "someone-here"));
    expect(seq.deliverableDue(NOW + LEAD).deliverable.map((row) => row.id)).toEqual(["#thing:tick"]);
  });

  it("fires always entries into an unattended scope — that is what they are for", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seedWizard(seq, "$scheduling");
    seq.submit(submitFor(seq, transcript({
      writes: [{ cell: { kind: "prop" as const, object: SCOPE, name: "session_subscribers" }, value: [] as never, op: "set" as const, writer: WRITER }]
    }), "empty-room"));
    seq.submit(armingTurn(seq, {
      schedules: [armed({ idlePolicy: "always", armed_by: { ...WRITER, progr: "$scheduling" } })]
    }, "s1"));
    const due = seq.deliverableDue(NOW + LEAD);
    expect(due.deliverable.map((row) => row.id)).toEqual(["#thing:tick"]);
    expect(due.parked).toEqual([]);
  });

  it("fails OPEN when the scope publishes no audience", () => {
    // An absent session_subscribers cell means "this scope does not publish an
    // audience", not "nobody is present". Firing when nobody is watching costs
    // one turn; never firing is the failure mode worth avoiding.
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seq.submit(armingTurn(seq, { schedules: [armed()] }, "s1"));
    expect(seq.deliverableDue(NOW + LEAD).deliverable).toHaveLength(1);
  });

  it("pops only the deliverable set, leaving idle-parked entries queued", () => {
    // dueTurns is destructive. Popping everything due and filtering afterwards
    // would silently discard exactly the entries the idle policy defers.
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seedWizard(seq, "$scheduling");
    seq.submit(submitFor(seq, transcript({
      writes: [{ cell: { kind: "prop" as const, object: SCOPE, name: "session_subscribers" }, value: [] as never, op: "set" as const, writer: WRITER }]
    }), "empty-room"));
    seq.submit(armingTurn(seq, { schedules: [armed({ id: "#thing:idle" })] }, "s1"));
    seq.submit(armingTurn(seq, {
      schedules: [armed({ id: "#thing:always", idlePolicy: "always", armed_by: { ...WRITER, progr: "$scheduling" } })]
    }, "s2"));

    const { deliverable } = seq.deliverableDue(NOW + LEAD);
    const popped = seq.dueTurns(NOW + LEAD, undefined, new Set(deliverable.map((row) => row.id)));
    expect(popped.map((row) => row.id)).toEqual(["#thing:always"]);
    expect(seq.peekDue(NOW + LEAD).map((row) => row.id)).toEqual(["#thing:idle"]);
  });

  it("refuses a target created in this turn but anchored outside, under production's own classifier", () => {
    // PRODUCTION's scopeOf is `hints.get(object) ?? this.scope` — it answers
    // "local" for everything it has no routing hint for, and create anchors
    // are never hinted. So a check that asks it whether a foreign anchor is
    // foreign gets "no". The previous version of this test supplied a
    // classifier that returned the foreign scope, which production does not
    // have, and the hole shipped behind a green test.
    const productionLikeScopeOf = (_object: string) => SCOPE;
    const seq = new ScopeSequencer(SCOPE, EPOCH, { scopeOf: productionLikeScopeOf });
    const reply = seq.submit(armingTurn(seq, {
      creates: [{
        object: "#foreign",
        name: "Foreign",
        parent: "$thing",
        owner: "#actor",
        // An anchor this scope has never seen and does not hold.
        anchor: "#elsewhere",
        location: null,
        flags: {},
        writer: WRITER
      }],
      schedules: [armed({
        id: "#thing:foreign",
        call: { actor: "#actor", target: "#foreign", verb: "tick", args: [] }
      })]
    }, "s1"));
    expect(reply.status).toBe("rejected");
    if (reply.status === "rejected") expect(String(reply.detail?.schedule)).toMatch(/anchored outside/);
    expect(seq.peekDue(NOW + LEAD)).toEqual([]);
  });

  it("allows an unanchored create — it lands wherever it commits", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH, { scopeOf: (_object: string) => SCOPE });
    const reply = seq.submit(armingTurn(seq, {
      creates: [{
        object: "#fresh", name: "Fresh", parent: "$thing", owner: "#actor",
        anchor: null, location: null, flags: {}, writer: WRITER
      }],
      schedules: [armed({ id: "#thing:fresh", call: { actor: "#actor", target: "#fresh", verb: "tick", args: [] } })]
    }, "s1"));
    expect(reply.status).toBe("accepted");
    expect(seq.peekDue(NOW + LEAD).map((row) => row.id)).toEqual(["#thing:fresh"]);
  });

  it("allows a create anchored to an object this scope actually holds", () => {
    // #thing is materialized here by the harness, so anchoring to it is local
    // by authoritative evidence rather than by a classifier's default.
    const seq = new ScopeSequencer(SCOPE, EPOCH, { scopeOf: (_object: string) => SCOPE });
    const reply = seq.submit(armingTurn(seq, {
      creates: [{
        object: "#child", name: "Child", parent: "$thing", owner: "#actor",
        anchor: "#thing", location: null, flags: {}, writer: WRITER
      }],
      schedules: [armed({ id: "#thing:child", call: { actor: "#actor", target: "#child", verb: "tick", args: [] } })]
    }, "s1"));
    expect(reply.status).toBe("accepted");
  });

  it("follows a same-turn anchor chain, and terminates on a cycle", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH, { scopeOf: (_object: string) => SCOPE });
    // #a anchors to #b, #b is unanchored: the chain resolves here.
    const chained = seq.submit(armingTurn(seq, {
      creates: [
        { object: "#a", name: "A", parent: "$thing", owner: "#actor", anchor: "#b", location: null, flags: {}, writer: WRITER },
        { object: "#b", name: "B", parent: "$thing", owner: "#actor", anchor: null, location: null, flags: {}, writer: WRITER }
      ],
      schedules: [armed({ id: "#thing:a", call: { actor: "#actor", target: "#a", verb: "tick", args: [] } })]
    }, "chain"));
    expect(chained.status).toBe("accepted");

    // #x anchors to #y and #y back to #x: no local evidence anywhere, and the
    // walk must terminate rather than spin.
    const cyclic = seq.submit(armingTurn(seq, {
      creates: [
        { object: "#x", name: "X", parent: "$thing", owner: "#actor", anchor: "#y", location: null, flags: {}, writer: WRITER },
        { object: "#y", name: "Y", parent: "$thing", owner: "#actor", anchor: "#x", location: null, flags: {}, writer: WRITER }
      ],
      schedules: [armed({ id: "#thing:x", call: { actor: "#actor", target: "#x", verb: "tick", args: [] } })]
    }, "cycle"));
    expect(cyclic.status).toBe("rejected");
    if (cyclic.status === "rejected") expect(String(cyclic.detail?.schedule)).toMatch(/anchored outside/);
  });

  it("cancels a recycled object's pending entries, in both directions (CO16.8)", () => {
    // The scope does this because only the scope holds the queue: woocode
    // cannot enumerate pending entries, so a recycling verb cannot cancel
    // what it cannot see. Both directions matter — an entry that would FIRE
    // at the tombstone, and an entry the dead object ARMED on something else
    // and can no longer cancel.
    const seq = new ScopeSequencer(SCOPE, EPOCH, { scopeOf: () => SCOPE });
    seedTarget(seq);
    seq.submit(submitFor(seq, transcript({
      creates: [{ object: "#doomed", name: "Doomed", parent: "$thing", owner: "#actor", anchor: null, location: null, flags: {}, writer: WRITER }]
    }), "make-doomed"));

    // (a) armed BY #thing, firing AT #doomed.
    seq.submit(armingTurn(seq, {
      schedules: [armed({ id: "#thing:at-doomed", call: { actor: "#actor", target: "#doomed", verb: "tick", args: [] } })]
    }, "s1"));
    // (b) armed BY #doomed, firing AT #thing.
    seq.submit(armingTurn(seq, {
      schedules: [armed({ id: "#doomed:from-doomed", armed_by: { ...WRITER, thisObj: "#doomed" }, call: { actor: "#actor", target: "#thing", verb: "tick", args: [] } })]
    }, "s2"));
    // (c) unrelated to #doomed — must survive.
    seq.submit(armingTurn(seq, { schedules: [armed({ id: "#thing:survivor" })] }, "s3"));
    expect(seq.peekDue(NOW + LEAD)).toHaveLength(3);

    const reply = seq.submit(submitFor(seq, transcript({
      recycles: [{ object: "#doomed" }]
    }), "recycle"));
    expect(reply.status).toBe("accepted");

    expect(seq.peekDue(NOW + LEAD).map((row) => row.id)).toEqual(["#thing:survivor"]);
  });

  it("refuses arming work for an object the same turn recycles", () => {
    // Lifecycle cleanup scans the queue BEFORE this turn's schedules are
    // inserted, so recycle-plus-schedule in one transcript used to leave a
    // pending entry aimed at a tombstone. The earlier test only covered
    // entries armed in previous turns.
    const seq = new ScopeSequencer(SCOPE, EPOCH, { scopeOf: () => SCOPE });
    seedTarget(seq);
    const reply = seq.submit(armingTurn(seq, {
      recycles: [{ object: "#thing" }],
      schedules: [armed({ id: "#thing:doomed" })]
    }, "s1"));
    expect(reply.status).toBe("rejected");
    if (reply.status === "rejected") expect(String(reply.detail?.schedule)).toMatch(/same turn recycles/);
    expect(seq.peekDue(NOW + LEAD)).toEqual([]);
  });

  it("refuses more schedules in one turn than the per-turn cap", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    const many = Array.from({ length: 17 }, (_, i) => armed({ id: `#thing:many${i}` }));
    const reply = seq.submit(armingTurn(seq, { schedules: many }, "s1"));
    expect(reply.status).toBe("rejected");
    if (reply.status === "rejected") expect(String(reply.detail?.schedule)).toMatch(/per-turn cap/);
  });
});
