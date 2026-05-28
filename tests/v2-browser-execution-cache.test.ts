import { describe, expect, it } from "vitest";

import { createWorld } from "../src/core/bootstrap";
import type { EffectTranscript } from "../src/core/effect-transcript";
import type { SerializedObject, SerializedWorld } from "../src/core/repository";
import { runShadowTurnCall, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import { buildShadowCellPageTransfer, createShadowExecutionNode, installShadowStateTransfer } from "../src/core/shadow-turn-exec";
import { shadowAtomHash, shadowTurnKeyFromTranscript, type ShadowTurnKey } from "../src/core/turn-key";
import {
  createV2BrowserAcceptedWriteCellTransfer,
  createV2BrowserExecutionNodeFromTransfers,
  v2ExecutableTransferRecord
} from "../src/client/v2-browser-execution-cache";

describe("v2 browser executable cache", () => {
  it("reconstructs an execution node from persisted executable transfers", () => {
    const key = turnKey("#room");
    const transfer = buildShadowCellPageTransfer({ serialized: serializedWorld(), key });
    const record = v2ExecutableTransferRecord(transfer, 100);

    const node = createV2BrowserExecutionNodeFromTransfers({
      node: "browser:test",
      scope: "#room",
      records: [record]
    });

    expect(node.scope).toBe("#room");
    expect(node.serialized?.objects.map((obj) => obj.id).sort()).toEqual(["#actor", "#room"]);
    expect(node.atom_hashes.has(key.atom_hashes[0])).toBe(true);
  });

  it("ignores executable transfers for other scopes", () => {
    const key = turnKey("#other");
    const transfer = buildShadowCellPageTransfer({ serialized: serializedWorld("#other"), key });
    const record = v2ExecutableTransferRecord(transfer, 100);

    const node = createV2BrowserExecutionNodeFromTransfers({
      node: "browser:test",
      scope: "#room",
      records: [record]
    });

    expect(node.serialized).toBeUndefined();
    expect(node.atom_hashes.size).toBe(0);
  });

  it("rebuilds executable state from compact transfer refs plus cached pages", async () => {
    const world = createWorld();
    const session = world.auth("guest:v2-browser-execution-cache");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const serialized = world.exportWorld();
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "v2-browser-cache-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor: session.actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.42]
    };
    const planned = await runShadowTurnCall(serialized, call);
    const key = shadowTurnKeyFromTranscript(planned.transcript);
    const fullTransfer = buildShadowCellPageTransfer({ serialized, key, session: session.id });
    const compactTransfer = buildShadowCellPageTransfer({
      serialized,
      key,
      known_page_hashes: fullTransfer.page_refs.map((ref) => ref.hash),
      session: session.id
    });
    expect(compactTransfer.inline_pages).toEqual([]);

    const coldNode = createShadowExecutionNode({ node: "browser:v2-cache", scope: "the_dubspace" });
    expect(() => installShadowStateTransfer(coldNode, compactTransfer)).toThrow(/missing cached shadow state page/);

    const rebuilt = createV2BrowserExecutionNodeFromTransfers({
      node: "browser:v2-cache",
      scope: "the_dubspace",
      records: [v2ExecutableTransferRecord(compactTransfer)],
      cached_pages: fullTransfer.inline_pages
    });
    expect(rebuilt.serialized?.objects.find((object) => object.id === "the_dubspace")).toBeTruthy();
  });

  it("promotes accepted transcript write cells into executable page transfers", () => {
    const key = turnKey("#room");
    const base = buildShadowCellPageTransfer({ serialized: serializedWorld(), key, recipient: "browser:test" });
    const oldRecord = v2ExecutableTransferRecord(base, 100);
    const transcript = propTranscript("turn-1", 1, "promoted");

    const promoted = createV2BrowserAcceptedWriteCellTransfer({
      node: "browser:test",
      scope: "#room",
      records: [oldRecord],
      transcripts: [transcript],
      accepted_head: {
        kind: "woo.scope_head.shadow.v1",
        scope: "#room",
        epoch: 1,
        seq: 1,
        hash: "head:1"
      },
      received_at: 200
    });
    expect(promoted).toBeTruthy();
    expect(promoted?.record.transfer.mode).toBe("cell_pages");
    expect(promoted?.record.transfer.mode === "cell_pages" ? promoted.record.transfer.purpose : undefined).toBe("accepted_write_cells");
    expect(promoted?.pages.length).toBeGreaterThan(0);

    const composed = createV2BrowserExecutionNodeFromTransfers({
      node: "browser:test",
      scope: "#room",
      records: [oldRecord, promoted!.record],
      cached_pages: promoted!.pages.map((row) => row.page)
    });
    const room = composed.serialized?.objects.find((object) => object.id === "#room");
    expect(room?.properties).toContainEqual(["marker", "promoted"]);
    expect(composed.atom_hashes.has(shadowAtomHash("read:cell:prop:#room.marker"))).toBe(true);
  });
});

function turnKey(scope: string): ShadowTurnKey {
  const preimages = [`actor:#actor`, `scope:${scope}`, `target:${scope}`];
  return {
    kind: "woo.turn_key.shadow.v1",
    scope,
    actor: "#actor",
    target: scope,
    verb: "look",
    preimages,
    atom_hashes: preimages.map(shadowAtomHash),
    read_preimages: preimages,
    read_atom_hashes: preimages.map(shadowAtomHash),
    write_preimages: [],
    write_atom_hashes: [],
    accept_preimages: preimages,
    accept_atom_hashes: preimages.map(shadowAtomHash)
  };
}

function serializedWorld(room = "#room"): SerializedWorld {
  return {
    version: 1,
    objectCounter: 1,
    parkedTaskCounter: 1,
    sessionCounter: 1,
    objects: [objectRecord(room, room, null), objectRecord("#actor", "actor", room)],
    sessions: [{ id: "session-1", actor: "#actor", started: 1, activeScope: room }],
    logs: [],
    snapshots: [],
    parkedTasks: [],
    tombstones: []
  };
}

function objectRecord(id: string, name: string, location: string | null): SerializedObject {
  return {
    id,
    name,
    parent: null,
    owner: "$wiz",
    location,
    anchor: null,
    flags: {},
    created: 1,
    modified: 1,
    propertyDefs: [],
    properties: [],
    propertyVersions: [],
    verbs: [],
    children: [],
    contents: [],
    eventSchemas: []
  };
}

function propTranscript(id: string, seq: number, value: string): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    id,
    route: "sequenced",
    scope: "#room",
    seq,
    session: "session-1",
    call: {
      actor: "#actor",
      target: "#room",
      verb: "set_marker",
      args: [value],
      body: undefined
    },
    reads: [],
    writes: [{
      cell: { kind: "prop", object: "#room", name: "marker" },
      value,
      op: "set",
      next: `marker:${seq}`
    }],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: `hash:${id}`
  };
}
