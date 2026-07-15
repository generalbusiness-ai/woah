// Relations — one write path for derived rows (coherence.md CO13/CO9):
// derivation from accepted transcripts, local/foreign partition, durable
// application at the sequencer, foreign application, and bounded rebuild.
import { describe, expect, it } from "vitest";
import {
  applyRelationDeltas,
  deriveRelationDeltas,
  observationsForRelationOwners,
  rebuildContentsRelation,
  relationKey,
  roomRosterRows,
  type RelationRow
} from "../../src/net/relations";
import { InMemoryScopeStore } from "../../src/net/scope-store";
import { ScopeSequencer, type CommitSubmit } from "../../src/net/scope";
import { applyTranscript, type EffectTranscript } from "../../src/net/transcript";
import { CellStore } from "../../src/net/cells";
import { ORDERED_EDGE_PROP } from "../../src/net/ordered-edges";

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
    expect(derived.local.filter((d) => d.row.relation === "contents").map((d) => `${d.op}:${d.row.owner}:${d.row.member}`).sort()).toEqual([
      "add:room:den:#alice",
      "remove:room:hall:#alice"
    ]);
    expect(derived.local.filter((d) => d.row.relation === "ordered_edge")).toEqual([]);
  });

  it("a moved-and-cleared edge retracts only its source relation", () => {
    const post = new CellStore("authority");
    const stamp = { scope_head: "cleared-edge", catalog_epoch: EPOCH };
    post.commit({ kind: "object_live", object: "#item", value: { location: "$nowhere" }, stamp });
    const t = transcript({
      moves: [{ object: "#item", from: "room:hall", to: "$nowhere" }],
      writes: [{ cell: { kind: "prop", object: "#item", name: ORDERED_EDGE_PROP }, value: null, op: "remove", writer: WRITER }]
    });
    const derived = deriveRelationDeltas(t, NO_WRITES, "room:hall", (owner) => owner, post);
    expect(derived.local.filter((d) => d.row.relation === "ordered_edge")).toEqual([
      { op: "remove", row: { relation: "ordered_edge", owner: "room:hall", member: "#item" } }
    ]);
    expect(derived.foreign.get("$nowhere")?.filter((d) => d.row.relation === "ordered_edge") ?? []).toEqual([]);
  });

  it("moves project a foreign-anchored authored edge into the destination ordering", () => {
    const post = new CellStore("authority");
    const stamp = { scope_head: "edge", catalog_epoch: EPOCH };
    post.commit({ kind: "object_live", object: "#alice", value: { location: "room:den" }, stamp });
    post.commit({
      kind: "property_cell",
      object: "#alice",
      name: ORDERED_EDGE_PROP,
      value: { value: { parent: null, rank: "V" } },
      stamp
    });
    const t = transcript({ moves: [{ object: "#alice", from: "room:hall", to: "room:den" }] });
    const derived = deriveRelationDeltas(t, NO_WRITES, "room:hall", (owner) => owner, post);
    expect(derived.local.filter((d) => d.row.relation === "ordered_edge")).toEqual([
      { op: "remove", row: { relation: "ordered_edge", owner: "room:hall", member: "#alice" } }
    ]);
    expect(derived.foreign.get("room:den")?.filter((d) => d.row.relation === "ordered_edge")).toEqual([
      {
        op: "add",
        row: { relation: "ordered_edge", owner: "room:den", member: "#alice", body: { parent: null, rank: "V" } }
      }
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

  it("refreshes an active actor's presence row when its display name changes", () => {
    const post = new CellStore("authority");
    const stamp = { scope_head: "rename", catalog_epoch: EPOCH };
    post.commit({ kind: "session", object: "s1", value: { id: "s1", actor: "#alice", activeScope: "room:hall", started: 10, expiresAt: 1000 }, stamp });
    post.commit({ kind: "property_cell", object: "#alice", name: "name", value: { value: "Renamed Alice" }, stamp });
    post.commit({ kind: "object_lineage", object: "#alice", value: { name: "Old Alice", parent: "$player" }, stamp });
    post.commit({ kind: "object_live", object: "#alice", value: { location: "room:hall" }, stamp });
    const t = transcript({
      session: "s1",
      call: { actor: "#alice", target: "#alice", verb: "rename", args: [], body: undefined },
      writes: [{ cell: { kind: "prop", object: "#alice", name: "name" }, value: "Renamed Alice", op: "set", writer: WRITER }]
    });
    const derived = deriveRelationDeltas(t, NO_WRITES, "cluster:#alice", (owner) => owner, post);
    expect(derived.foreign.get("room:hall")).toEqual([
      expect.objectContaining({
        op: "add",
        row: expect.objectContaining({
          relation: "session_presence",
          owner: "room:hall",
          member: "s1",
          body: expect.objectContaining({ actor: "#alice", name: "Renamed Alice" })
        })
      })
    ]);
  });

  it("partitions deltas by the owner's anchor scope", () => {
    const t = transcript({ moves: [{ object: "#alice", from: "room:hall", to: "room:den" }] });
    const derived = deriveRelationDeltas(t, NO_WRITES, "room:hall", (owner) => (owner === "room:hall" ? "room:hall" : "room:den"));
    expect(derived.local.filter((d) => d.row.relation === "contents").map((d) => d.op)).toEqual(["remove"]);
    expect(derived.foreign.get("room:den")?.filter((d) => d.row.relation === "contents").map((d) => d.op)).toEqual(["add"]);
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
    // Local: the remove at this room (carried on the reply for the
    // shell's fanout even when it changed nothing). Foreign: the add at
    // room:den.
    expect(seq.relations().size).toBe(0); // remove of an absent row = no row
    expect(reply.relations).toEqual([
      { op: "remove", row: { relation: "contents", owner: "room:hall", member: "#alice" } }
    ]);
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

  it("applyForeignRelationDeltas is owner-sequenced: one head advance per applied batch, tail names the fact, no-ops are empty", () => {
    const store = new InMemoryScopeStore();
    const seq = new ScopeSequencer("room:den", EPOCH, { durable: store });
    const add: Parameters<typeof seq.applyForeignRelationDeltas>[0] = [
      { op: "add", row: { relation: "contents", owner: "room:den", member: "#alice" } },
      { op: "add", row: { relation: "session_presence", owner: "room:den", member: "s1", body: { actor: "#alice" } } }
    ];
    const applied = seq.applyForeignRelationDeltas(add, { from_scope: "cluster:#alice", seq: 4 });
    // One head advance for the two-delta batch; the refan rides this seq.
    expect(applied.status).toBe("applied");
    expect(applied.head.seq).toBe(1);
    expect(seq.head()).toEqual(applied.head);
    expect(applied.changed.sort()).toEqual([
      relationKey("contents", "room:den", "#alice"),
      relationKey("session_presence", "room:den", "s1")
    ]);
    // The recovery tail names the relate fact (adopt-style legibility).
    expect(seq.recoveryTail()).toEqual([
      expect.objectContaining({ seq: 1, transcript_hash: "relate:cluster:#alice:4", touched: applied.changed.sort() })
    ]);
    // Re-applying identical adds changes nothing: empty, NO head advance
    // (an all-no-op relate must not fan a no-op to subscribers).
    const noop = seq.applyForeignRelationDeltas(add, { from_scope: "cluster:#alice", seq: 5 });
    expect(noop.status).toBe("empty");
    expect(noop.changed).toEqual([]);
    expect(seq.head().seq).toBe(1);
    // Head + rows survive rehydration together (meta written in the same
    // transaction as the rows).
    const rehydrated = new ScopeSequencer("room:den", EPOCH, { durable: store });
    expect(rehydrated.head().seq).toBe(1);
    expect(rehydrated.relations().size).toBe(2);
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

  it("rebuildRelations drops candidates owned by another scope (multi-scope: no second copy of a foreign row family)", () => {
    // A cluster scope holds the actor's live cell, whose LOCATION is a
    // foreign room. Its rebuild must not mint the room's contents row —
    // that row lives at the room (delivered there via /net/relate at
    // derivation time); a local copy would be the CO9 dual write.
    const seq = new ScopeSequencer("cluster:#alice", EPOCH, {
      scopeOf: (owner) => (owner.startsWith("room:") ? owner : "cluster:#alice")
    });
    seq.seed([
      { kind: "object_live", object: "#alice", value: { location: "room:hall" } },
      { kind: "object_live", object: "#satchel", value: { location: "#alice" } }
    ]);
    seq.rebuildRelations();
    // The carried item's row (owner #alice → this cluster) survives; the
    // room-owned row does not appear.
    expect([...seq.relations().keys()]).toEqual([relationKey("contents", "#alice", "#satchel")]);
  });
});

describe("primitives", () => {
  it("selects the same room-addressed observations for expedited and durable relation delivery", () => {
    const observations = [
      { type: "left", source: "room:x" },
      { type: "entered", room: "room:y" },
      { type: "said", source: "room:z" },
      { type: "direct", to: "#alice" }
    ];
    const deltas = [
      { op: "remove", row: { relation: "session_presence", owner: "room:x", member: "s1" } },
      { op: "add", row: { relation: "session_presence", owner: "room:y", member: "s1" } }
    ] as const;
    expect(observationsForRelationOwners(observations, deltas)).toEqual(observations.slice(0, 2));
  });

  it("reduces live presence to one row per actor and excludes expired residue", () => {
    const now = 100_000;
    const relations: RelationRow[] = [];
    for (let index = 0; index < 30; index += 1) {
      relations.push({
        relation: "session_presence",
        owner: "room:x",
        member: `live-${index}`,
        body: {
          actor: `actor-${index}`,
          name: `Actor ${index}`,
          session: { id: `live-${index}`, actor: `actor-${index}`, started: 90_000, expiresAt: 200_000, activeScope: "room:x" }
        }
      });
    }
    for (let index = 0; index < 90; index += 1) {
      relations.push({
        relation: "session_presence",
        owner: "room:x",
        member: `stale-${index}`,
        body: {
          actor: `stale-actor-${index}`,
          session: { id: `stale-${index}`, actor: `stale-actor-${index}`, started: 1, expiresAt: 2, activeScope: "room:x" }
        }
      });
    }
    const roster = roomRosterRows(relations, "room:x", "Room X", now);
    expect(roster).toHaveLength(30);
    expect(roster[0]).toMatchObject({ player: "actor-0", name: "Actor 0", location_name: "Room X" });
    expect(roster.some((row) => row.player.startsWith("stale-"))).toBe(false);
  });

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
