// Relations — one write path for derived rows (coherence.md CO13/CO9):
// derivation from accepted transcripts, local/foreign partition, durable
// application at the sequencer, foreign application, and bounded rebuild.
import { describe, expect, it } from "vitest";
import {
  applyRelationDeltas,
  deriveRelationDeltas,
  rebuildContentsRelation,
  relationKey,
  type RelationRow
} from "../../src/net/relations";
import { InMemoryScopeStore } from "../../src/net/scope-store";
import { ScopeSequencer, type CommitSubmit } from "../../src/net/scope";
import { applyTranscript, type EffectTranscript } from "../../src/net/transcript";

const EPOCH = "cat-rel-1";
const WRITER = { progr: "#a", thisObj: "#t", verb: "v", definer: "$thing", caller: "#a", callerPerms: "#a" };

function transcript(partial: Partial<EffectTranscript>): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    route: "sequenced",
    scope: "room:hall",
    seq: 1,
    call: { actor: "#a", target: "#t", verb: "v", args: [], body: undefined },
    reads: [],
    writes: [],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: `rel-${JSON.stringify(partial).length}`,
    ...partial
  } as EffectTranscript;
}

const NO_WRITES = { projectionWrites: [] as never[] };

describe("deriveRelationDeltas (CO13)", () => {
  it("moves derive remove-at-source and add-at-destination contents deltas", () => {
    const t = transcript({ moves: [{ object: "#alice", from: "room:hall", to: "room:den" }] });
    const derived = deriveRelationDeltas(t, NO_WRITES, "room:hall");
    expect(derived.local.map((d) => `${d.op}:${d.row.owner}:${d.row.member}`).sort()).toEqual([
      "add:room:den:#alice",
      "remove:room:hall:#alice"
    ]);
  });

  it("contents projection writes derive membership deltas (arrays and scalars)", () => {
    const t = transcript({});
    const derived = deriveRelationDeltas(
      t,
      {
        projectionWrites: [
          { cell: { kind: "contents", object: "#chest" }, value: ["#coin", "#gem"], op: "add", writer: WRITER },
          { cell: { kind: "contents", object: "#chest" }, value: "#dust", op: "remove", writer: WRITER }
        ] as never
      },
      "room:hall"
    );
    expect(derived.local.map((d) => `${d.op}:${d.row.member}`).sort()).toEqual(["add:#coin", "add:#gem", "remove:#dust"]);
  });

  it("a move plus its contents echo dedupes to one delta per membership", () => {
    const t = transcript({ moves: [{ object: "#alice", from: null, to: "room:den" }] });
    const derived = deriveRelationDeltas(
      t,
      { projectionWrites: [{ cell: { kind: "contents", object: "room:den" }, value: "#alice", op: "add", writer: WRITER }] as never },
      "room:den"
    );
    expect(derived.local).toHaveLength(1);
  });

  it("session transitions derive presence deltas carrying the actor", () => {
    const t = transcript({ sessionScopeTransition: { session: "s1", actor: "#alice", from: "room:hall", to: "room:den" } });
    const derived = deriveRelationDeltas(t, NO_WRITES, "room:hall");
    const byOp = Object.fromEntries(derived.local.map((d) => [d.op, d]));
    expect(byOp.remove.row).toMatchObject({ relation: "session_presence", owner: "room:hall", member: "s1" });
    expect(byOp.add.row).toMatchObject({ relation: "session_presence", owner: "room:den", member: "s1", body: { actor: "#alice" } });
  });

  it("partitions deltas by the owner's anchor scope", () => {
    const t = transcript({ moves: [{ object: "#alice", from: "room:hall", to: "room:den" }] });
    const derived = deriveRelationDeltas(t, NO_WRITES, "room:hall", (owner) => (owner === "room:hall" ? "room:hall" : "room:den"));
    expect(derived.local.map((d) => d.op)).toEqual(["remove"]);
    expect(derived.foreign.get("room:den")?.map((d) => d.op)).toEqual(["add"]);
  });
});

describe("sequencer relation application (durable, one transaction)", () => {
  function bumpSubmit(seq: ScopeSequencer, moves: EffectTranscript["moves"], key: string): CommitSubmit {
    const t = transcript({ scope: seq.scope, moves, hash: key });
    const derived = applyTranscript(seq.store, t, { scope_head: "x", catalog_epoch: EPOCH });
    return {
      kind: "woo.net.commit_submit.v1",
      scope: seq.scope,
      base: seq.head(),
      idempotency_key: key,
      transcript: t,
      post_state_version: derived.postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    };
  }

  it("local deltas apply on accept, survive hydration, and foreign deltas ride the reply", () => {
    const store = new InMemoryScopeStore();
    const seq = new ScopeSequencer("room:hall", EPOCH, {
      durable: store,
      scopeOf: (owner) => (owner.startsWith("room:") ? owner : "room:hall")
    });
    seq.seed([{ kind: "object_lineage", object: "#alice", value: { parent: null } }]);
    const reply = seq.submit(bumpSubmit(seq, [{ object: "#alice", from: "room:hall", to: "room:den" }], "k1"));
    expect(reply.status).toBe("accepted");
    if (reply.status !== "accepted") return;
    // Local: the remove at this room. Foreign: the add at room:den.
    expect(seq.relations().size).toBe(0); // remove of an absent row = no row
    expect(reply.relations_foreign).toEqual([
      { scope: "room:den", deltas: [{ op: "add", row: { relation: "contents", owner: "room:den", member: "#alice" } }] }
    ]);

    // The foreign owner applies the delivered deltas durably.
    const denStore = new InMemoryScopeStore();
    const den = new ScopeSequencer("room:den", EPOCH, { durable: denStore });
    den.applyForeignRelationDeltas(reply.relations_foreign![0].deltas);
    expect(den.relations().get(relationKey("contents", "room:den", "#alice"))).toMatchObject({ member: "#alice" });
    const denRehydrated = new ScopeSequencer("room:den", EPOCH, { durable: denStore });
    expect(denRehydrated.relations().size).toBe(1);
  });

  it("rebuildRelations recomputes contents from live cells and preserves presence", () => {
    const store = new InMemoryScopeStore();
    const seq = new ScopeSequencer("room:hall", EPOCH, { durable: store });
    seq.seed([
      { kind: "object_live", object: "#alice", value: { location: "room:hall" } },
      { kind: "object_live", object: "#bob", value: { location: "room:hall" } }
    ]);
    seq.applyForeignRelationDeltas([
      { op: "add", row: { relation: "session_presence", owner: "room:hall", member: "s9", body: { actor: "#bob" } } },
      { op: "add", row: { relation: "contents", owner: "room:hall", member: "#stale-ghost" } }
    ]);
    seq.rebuildRelations();
    const keys = [...seq.relations().keys()].sort();
    expect(keys).toEqual([
      relationKey("contents", "room:hall", "#alice"),
      relationKey("contents", "room:hall", "#bob"),
      relationKey("session_presence", "room:hall", "s9")
    ]);
    // Durable state matches the rebuild.
    expect(store.readRelations().length).toBe(3);
  });
});

describe("primitives", () => {
  it("applyRelationDeltas reports changed keys and skips no-op removes", () => {
    const rows = new Map<string, RelationRow>();
    const changed = applyRelationDeltas(rows, [
      { op: "add", row: { relation: "contents", owner: "o", member: "m" } },
      { op: "remove", row: { relation: "contents", owner: "o", member: "absent" } }
    ]);
    expect(changed).toEqual([relationKey("contents", "o", "m")]);
  });

  it("rebuildContentsRelation derives rows from live cells only", () => {
    const rows = rebuildContentsRelation([
      { key: "object_live:#a", kind: "object_live", object: "#a", value: { location: "room:x" }, version: "v", provenance: "authoritative", stamp: { scope_head: "h", catalog_epoch: EPOCH } },
      { key: "object_lineage:#a", kind: "object_lineage", object: "#a", value: { parent: null }, version: "v", provenance: "authoritative", stamp: { scope_head: "h", catalog_epoch: EPOCH } }
    ]);
    expect([...rows.keys()]).toEqual([relationKey("contents", "room:x", "#a")]);
  });
});
