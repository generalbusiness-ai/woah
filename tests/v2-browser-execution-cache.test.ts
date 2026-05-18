import { describe, expect, it } from "vitest";

import { createV2BrowserExecutionNodeFromTransfers, v2ExecutableTransferRecord } from "../src/client/v2-browser-execution-cache";
import type { SerializedObject, SerializedWorld } from "../src/core/repository";
import { buildShadowClosureTransfer } from "../src/core/shadow-turn-exec";
import { shadowAtomHash, type ShadowTurnKey } from "../src/core/turn-key";

describe("v2 browser executable cache", () => {
  it("reconstructs an execution node from persisted executable transfers", () => {
    const key = turnKey("#room");
    const transfer = buildShadowClosureTransfer({ serialized: serializedWorld(), key });
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
    const transfer = buildShadowClosureTransfer({ serialized: serializedWorld("#other"), key });
    const record = v2ExecutableTransferRecord(transfer, 100);

    const node = createV2BrowserExecutionNodeFromTransfers({
      node: "browser:test",
      scope: "#room",
      records: [record]
    });

    expect(node.serialized).toBeUndefined();
    expect(node.atom_hashes.size).toBe(0);
  });
});

function turnKey(scope: string): ShadowTurnKey {
  const preimages = [`scope:${scope}`];
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
