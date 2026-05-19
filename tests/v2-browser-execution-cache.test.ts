import { describe, expect, it } from "vitest";

import { createWorld } from "../src/core/bootstrap";
import type { SerializedObject, SerializedWorld } from "../src/core/repository";
import { runShadowTurnCall, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import { buildShadowCellPageTransfer, buildShadowClosureTransfer, createShadowExecutionNode, installShadowStateTransfer } from "../src/core/shadow-turn-exec";
import { shadowAtomHash, shadowTurnKeyFromTranscript, type ShadowTurnKey } from "../src/core/turn-key";
import { createV2BrowserExecutionNodeFromTransfers, v2ExecutableTransferRecord } from "../src/client/v2-browser-execution-cache";

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
