// Verb-slot allocation at the authority (CO4.7).
//
// A verb's `slot` is a durable per-object ordinal and the load-bearing key of
// the dispatcher's resolution order (spec/semantics/objects.md §9.1). Only the
// object's authority knows the whole set, so a planner — which under Net holds
// at most the turn's slice — can do no more than PROPOSE. These cases pin the
// owner's refusal rules, which are what makes the proposal safe:
//
//   1. a new page must take exactly the current allocation floor;
//   2. a write to an existing page must not move it.
//
// Rule 1 is also what serializes concurrent appends. Two turns planned against
// the same pre-state necessarily propose the same slot; without the check both
// would commit and the object would hold two verbs claiming one ordinal, which
// is precisely the state Net authoring shipped in (every authored verb on slot
// 1 — notes/2026-07-27-net-verb-slots.md).
import { describe, expect, it } from "vitest";
import { CellStore } from "../../src/net/cells";
import { applyTranscript, type EffectTranscript } from "../../src/net/transcript";
import { ScopeSequencer, type CommitSubmit } from "../../src/net/scope";

const SCOPE = "the_room";
const EPOCH = "cat1";
const OBJ = "#widget";

const WRITER = { progr: "#actor", thisObj: "#actor", verb: "install_verb", definer: "$programmer", caller: "#actor", callerPerms: "#actor" };

function transcript(partial: Partial<EffectTranscript>): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    route: "sequenced",
    scope: SCOPE,
    seq: 1,
    call: { actor: "#actor", target: "#actor", verb: "install_verb", args: [], body: undefined },
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

/** Planner parity: derive post_state_version the way plan.ts does, against
 * whatever authority state the sequencer holds RIGHT NOW. Capturing the submit
 * before a competing commit lands is how the concurrency case below reproduces
 * two turns planned from one pre-state. */
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

/** One verb-page write, in the shape world.ts records: the serialized VerbDef
 * minus line_map, so `slot` rides along. */
function verbWrite(name: string, slot: number | undefined, version = 1) {
  return {
    cell: { kind: "verb" as const, object: OBJ, name },
    value: { kind: "bytecode", name, aliases: [], owner: "#actor", perms: "rx", version, ...(slot === undefined ? {} : { slot }) } as never,
    op: "set" as const,
    writer: WRITER
  };
}

/** Seed `count` verb pages at slots 1..count, the way an installed catalog
 * leaves an object. Uses the same append path a turn would, one commit each. */
function seedVerbs(seq: ScopeSequencer, names: string[]): void {
  names.forEach((name, index) => {
    const reply = seq.submit(submitFor(seq, transcript({ writes: [verbWrite(name, index + 1)], hash: `seed-${name}` }), `seed-${name}`));
    expect(reply.status, `seeding ${name}: ${JSON.stringify(reply).slice(0, 200)}`).toBe("accepted");
  });
}

describe("verb-slot allocation (CO4.7)", () => {
  it("accepts an append at the allocation floor and refuses one below it", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seedVerbs(seq, ["alpha", "bravo", "charlie"]);

    // The floor is 4. A planner whose slice held no verb pages proposes 1 —
    // the exact failure the sparse planning world produced for every verb
    // authored over Net.
    const blind = seq.submit(submitFor(seq, transcript({ writes: [verbWrite("delta", 1)], hash: "blind" }), "blind"));
    expect(blind.status).toBe("rejected");
    if (blind.status !== "rejected") return;
    expect(blind.reason).toBe("read_version_mismatch");
    expect(blind.retryable).toBe(true);
    expect((blind.detail as { verb_slot_stale?: unknown }).verb_slot_stale).toEqual({ object: OBJ, verb: "delta", floor: 4, proposed: 1 });
    // The refusal names every page the planner needed, so ONE repair round
    // installs the whole set and the re-plan allocates correctly.
    expect((blind.mismatched_reads ?? []).map((cell) => (cell as { name?: string }).name).sort())
      .toEqual(["alpha", "bravo", "charlie"]);

    const repaired = seq.submit(submitFor(seq, transcript({ writes: [verbWrite("delta", 4)], hash: "repaired" }), "repaired"));
    expect(repaired.status, JSON.stringify(repaired).slice(0, 300)).toBe("accepted");
    expect((seq.store.get("verb_bytecode:#widget:delta")?.value as { slot?: number }).slot).toBe(4);
  });

  it("serializes two concurrent appends: they cannot both take one slot", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seedVerbs(seq, ["alpha", "bravo"]);

    // Both turns plan against the SAME pre-state, so both honestly compute
    // floor 3 — captured before either commits.
    const first = submitFor(seq, transcript({ writes: [verbWrite("charlie", 3)], hash: "c" }), "c");
    const second = submitFor(seq, transcript({ writes: [verbWrite("delta", 3)], hash: "d" }), "d");

    expect(seq.submit(first).status).toBe("accepted");
    const loser = seq.submit(second);
    expect(loser.status, "two concurrent appends both took slot 3").toBe("rejected");
    if (loser.status !== "rejected") return;
    expect(loser.reason).toBe("read_version_mismatch");
    expect((loser.detail as { verb_slot_stale?: { floor?: number } }).verb_slot_stale?.floor).toBe(4);

    // The loser replans against the winner's state and lands on the next
    // ordinal. Every page now holds a distinct slot.
    const replanned = seq.submit(submitFor(seq, transcript({ writes: [verbWrite("delta", 4)], hash: "d2" }), "d2"));
    expect(replanned.status, JSON.stringify(replanned).slice(0, 300)).toBe("accepted");
    const slots = ["alpha", "bravo", "charlie", "delta"]
      .map((name) => (seq.store.get(`verb_bytecode:#widget:${name}`)?.value as { slot?: number }).slot);
    expect(slots).toEqual([1, 2, 3, 4]);
  });

  it("refuses a rewrite that would MOVE an existing verb", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seedVerbs(seq, ["alpha", "bravo", "charlie"]);

    // A metadata edit planned from a slice that held only `charlie` used to
    // re-densify it to slot 1, colliding with `alpha` and inverting the two
    // verbs' resolution order for any alias they shared.
    const moved = seq.submit(submitFor(seq, transcript({ writes: [verbWrite("charlie", 1, 2)], hash: "move" }), "move"));
    expect(moved.status).toBe("rejected");
    if (moved.status !== "rejected") return;
    expect(moved.reason).toBe("read_version_mismatch");
    expect((moved.detail as { verb_slot_moved?: unknown }).verb_slot_moved)
      .toEqual({ object: OBJ, verb: "charlie", held: 3, proposed: 1 });
    expect((moved.mismatched_reads ?? []).map((cell) => (cell as { name?: string }).name)).toEqual(["charlie"]);

    // The same edit at the page's real slot is an ordinary accepted update.
    const kept = seq.submit(submitFor(seq, transcript({ writes: [verbWrite("charlie", 3, 2)], hash: "keep" }), "keep"));
    expect(kept.status, JSON.stringify(kept).slice(0, 300)).toBe("accepted");
  });

  it("lets a rename keep the verb's ordinal", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    seedVerbs(seq, ["alpha", "bravo", "charlie"]);

    // set_verb_info's rename is a remove + a set under the new name in ONE
    // transcript. It is the same verb, so it must stay at slot 2 — the
    // new-page rule has to recognize the ordinal this turn vacates, or the
    // owner refuses forever and the turn grinds to E_NONCONVERGENT_READ.
    const renamed = seq.submit(submitFor(seq, transcript({
      writes: [
        { cell: { kind: "verb" as const, object: OBJ, name: "bravo" }, value: null as never, op: "remove" as const, writer: WRITER },
        verbWrite("bravissimo", 2, 2)
      ],
      hash: "rename"
    }), "rename"));
    expect(renamed.status, JSON.stringify(renamed).slice(0, 300)).toBe("accepted");
    expect((seq.store.get("verb_bytecode:#widget:bravissimo")?.value as { slot?: number }).slot).toBe(2);
    expect(seq.store.get("verb_bytecode:#widget:bravo")).toBeUndefined();

    // A rename may not use the exemption to land on someone ELSE's ordinal.
    const stolen = seq.submit(submitFor(seq, transcript({
      writes: [
        { cell: { kind: "verb" as const, object: OBJ, name: "charlie" }, value: null as never, op: "remove" as const, writer: WRITER },
        verbWrite("interloper", 1, 2)
      ],
      hash: "steal"
    }), "steal"));
    expect(stolen.status, "a rename took an ordinal it did not vacate").toBe("rejected");
  });

  it("does not enforce against slotless legacy pages, so an unrepaired world keeps working", () => {
    const seq = new ScopeSequencer(SCOPE, EPOCH);
    // A page written before slots were persisted carries none.
    expect(seq.submit(submitFor(seq, transcript({ writes: [verbWrite("legacy", undefined)], hash: "l" }), "l")).status).toBe("accepted");
    // Rewriting it is unconstrained (there is no held ordinal to preserve)…
    expect(seq.submit(submitFor(seq, transcript({ writes: [verbWrite("legacy", 7, 2)], hash: "l2" }), "l2")).status).toBe("accepted");
    // …and it still raises the floor for the next append, so a repaired page
    // and an unrepaired one cannot collide.
    expect(seq.submit(submitFor(seq, transcript({ writes: [verbWrite("fresh", 8)], hash: "f" }), "f")).status).toBe("accepted");
  });
});
