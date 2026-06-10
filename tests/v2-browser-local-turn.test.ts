import { authoritativePlanningWorld } from "../src/core/planning-world";
import { describe, expect, it, vi } from "vitest";

import { planV2BrowserLocalTurn } from "../src/client/v2-browser-local-turn";
import { createV2BrowserAcceptedWriteCellTransfer, v2ExecutableTransferRecord } from "../src/client/v2-browser-execution-cache";
import { createWorld } from "../src/core/bootstrap";
import { stableShadowJson } from "../src/core/shadow-cell-version";
import { buildShadowBrowserOpenExecutableSeedTransfer, createShadowBrowserRelayShim } from "../src/core/shadow-browser-node";
import { buildShadowTurnExecAd, executeShadowTurnCallAcrossInProcessNetwork } from "../src/core/shadow-turn-network";
import { buildShadowCellPageTransfer, createShadowExecutionNode } from "../src/core/shadow-turn-exec";
import { runShadowTurnCall, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";
import { hashSource } from "../src/core/source-hash";
import type { EffectTranscript } from "../src/core/effect-transcript";
import type { WooValue } from "../src/core/types";

describe("v2 browser local turn planning", () => {
  it("matches server transcripts for representative committed browser surfaces", async () => {
    await expectLocalTranscriptToMatchServer({
      name: "chat carrying",
      scope: "the_chatroom",
      target: "the_chatroom",
      verb: "take",
      args: ["mug"],
      setup: async (world, session) => {
        await world.directCall("setup-chat-parity-enter", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
      }
    });
    await expectLocalTranscriptToMatchServer({
      name: "pinboard edit",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "add_note",
      args: ["parity pin", "yellow", 48, 48, 180, 110],
      setup: async (world, session) => {
        await world.directCall("setup-pinboard-parity-enter", session.actor, "the_pinboard", "enter", [], { sessionId: session.id });
      }
    });
    await expectLocalTranscriptToMatchServer({
      name: "taskboard kanban create",
      scope: "the_taskboard",
      target: "the_taskboard",
      verb: "create_task",
      args: ["task", "Parity task", "Verify browser transcript parity.", ["browser"], null],
      setup: async (world, session) => {
        world.setProp("the_taskboard", "roles", { doer: { description: "Does the work", owners: [session.actor] } });
        world.setProp("the_taskboard", "obligations", { "do:it": { role: "doer", criterion: "Done." } });
        world.setProp("the_taskboard", "policies", { task: ["do:it"] });
      }
    });
    await expectLocalTranscriptToMatchServer({
      name: "dubspace committed control",
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.42],
      setup: async (world, session) => {
        world.setProp("the_dubspace", "operators", [session.actor]);
      }
    });
  });

  it("builds a TurnExecRequest from a warmed browser execution cache", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-local-turn");
    anchor.setProp("the_dubspace", "operators", [session.actor]);
    const serialized = anchor.exportWorld();
    const call = dubspaceCall(session.id, session.actor, 0.42);
    const planned = await runShadowTurnCall(authoritativePlanningWorld(serialized), call);
    const key = shadowTurnKeyFromTranscript(planned.transcript);
    const actorNode = createShadowExecutionNode({ node: "browser:test", scope: key.scope });
    const routed = await executeShadowTurnCallAcrossInProcessNetwork({
      request: { kind: "woo.turn.exec.request.shadow.v1", call, key },
      nodes: [actorNode],
      ads: [buildShadowTurnExecAd({ node: "browser:test", scope: key.scope, key, factor: 0.1 })],
      anchor: { node: "stable-anchor", serialized }
    });
    const transfer = routed.transfers[0];
    if (!transfer || transfer.mode !== "cell_pages") throw new Error("expected cell-page cache-warming transfer");

    const local = await planV2BrowserLocalTurn({
      node: "browser:test",
      actor: session.actor,
      session: session.id,
      head: { kind: "woo.scope_head.shadow.v1", scope: "the_dubspace", epoch: 1, seq: 0, hash: "root" },
      id: "browser-local-set-control",
      route: "sequenced",
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.42],
      persistence: "durable",
      transfers: [v2ExecutableTransferRecord(transfer, 1)]
    });

    expect(local).toMatchObject({
      ok: true,
      request: {
        kind: "woo.turn.exec.request.shadow.v1",
        call: expect.objectContaining({ target: "the_dubspace", verb: "set_control" }),
        key: expect.objectContaining({ scope: "the_dubspace" })
      },
      transcript_hash: planned.transcript.hash
    });
  });

  it("reports no executable state before the browser has learned cell pages", async () => {
    const local = await planV2BrowserLocalTurn({
      node: "browser:test",
      actor: "guest_missing",
      session: "session-missing",
      head: { kind: "woo.scope_head.shadow.v1", scope: "the_dubspace", epoch: 1, seq: 0, hash: "root" },
      id: "browser-local-missing",
      route: "sequenced",
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.42],
      persistence: "durable",
      transfers: []
    });

    expect(local).toEqual({ ok: false, reason: "no_executable_state" });
  });

  it("plans cold read-side tool hydrations from the open executable seed and tentative presence", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-local-read-seed");
    const serialized = anchor.exportWorld();
    for (const [scope, verb, tentative] of [
      ["the_pinboard", "list_notes", true],
      ["the_outline", "list_items", false]
    ] as const) {
      const relay = createShadowBrowserRelayShim({
        node: `relay:${scope}`,
        scope,
        serialized
      });
      const transfer = buildShadowBrowserOpenExecutableSeedTransfer(relay, scope, `browser:${scope}`, session.actor);
      const tentative_transcripts = tentative
        ? [(await runShadowTurnCall(authoritativePlanningWorld(serialized), {
          kind: "woo.turn_call.shadow.v1",
          id: `${scope}:enter`,
          route: "sequenced",
          scope,
          session: session.id,
          actor: session.actor,
          target: scope,
          verb: "enter",
          args: []
        })).transcript]
        : [];
      const local = await planV2BrowserLocalTurn({
        node: `browser:${scope}`,
        actor: session.actor,
        session: session.id,
        head: { kind: "woo.scope_head.shadow.v1", scope, epoch: 1, seq: 0, hash: "root" },
        id: `${scope}:${verb}`,
        route: "direct",
        scope,
        target: scope,
        verb,
        args: [],
        persistence: "live",
        transfers: [v2ExecutableTransferRecord(transfer, 1)],
        tentative_transcripts
      });
      expect(local, `${scope}:${verb}`).toMatchObject({
        ok: true,
        request: { call: { target: scope, verb } }
      });
    }
  });

  it("plans a cold tool enter from the open executable seed", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-local-enter-seed");
    const serialized = anchor.exportWorld();
    const relay = createShadowBrowserRelayShim({
      node: "relay:pinboard-enter-seed",
      scope: "the_pinboard",
      serialized
    });
    const openTransfer = buildShadowBrowserOpenExecutableSeedTransfer(
      relay,
      "the_pinboard",
      "browser:pinboard-enter-seed",
      session.actor
    );
    const local = await planV2BrowserLocalTurn({
      node: "browser:pinboard-enter-seed",
      actor: session.actor,
      session: session.id,
      head: { kind: "woo.scope_head.shadow.v1", scope: "the_pinboard", epoch: 1, seq: 0, hash: "root" },
      id: "pinboard-enter-seed",
      route: "sequenced",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "enter",
      args: [],
      persistence: "durable",
      transfers: [v2ExecutableTransferRecord(openTransfer, 1)]
    });
    expect(local).toMatchObject({
      ok: true,
      request: { call: { target: "the_pinboard", verb: "enter" } },
      optimistic_frame: {
        op: "result",
        result: { room: "the_pinboard" }
      }
    });
  });

  it("plans cold command text from the open executable seed without parser repair", async () => {
    // the_mug is a $note in the chatroom. $note:match_names reads this.text during
    // command planning for any command that scans room contents. The plan_command
    // contract must seed "text" as a property name so the atom-guard accepts the
    // read (native-primitive-contract.ts object_property_names). This test exercises
    // that contract: if "text" is dropped from the seed contract, it will return
    // ok=false/missing_state for take mug (or any command matching room contents).
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-command-plan-seed");
    await anchor.directCall("setup-command-plan-seed-enter", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    const serialized = anchor.exportWorld();
    const relay = createShadowBrowserRelayShim({
      node: "relay:command-plan-seed",
      scope: "the_chatroom",
      serialized
    });
    const openTransfer = buildShadowBrowserOpenExecutableSeedTransfer(
      relay,
      "the_chatroom",
      "browser:command-plan-seed",
      session.actor
    );
    const local = await planV2BrowserLocalTurn({
      node: "browser:command-plan-seed",
      actor: session.actor,
      session: session.id,
      head: { kind: "woo.scope_head.shadow.v1", scope: "the_chatroom", epoch: 1, seq: 0, hash: "root" },
      id: "command-plan-seed-take",
      route: "direct",
      scope: "the_chatroom",
      target: "the_chatroom",
      verb: "command_plan",
      args: ["take mug"],
      persistence: "live",
      transfers: [v2ExecutableTransferRecord(openTransfer, 1)]
    });
    expect(local).toMatchObject({
      ok: true,
      optimistic_frame: {
        op: "result",
        result: {
          ok: true,
          route: "direct",
          target: "the_chatroom",
          verb: "take",
          args: ["mug"]
        }
      }
    });
  });

  it("open executable seed carries anchored exits and repairs cold room movement to a real move", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-exit-seed");
    const serialized = anchor.exportWorld();
    const relay = createShadowBrowserRelayShim({
      node: "relay:exit-seed",
      scope: "the_chatroom",
      serialized
    });
    const openTransfer = buildShadowBrowserOpenExecutableSeedTransfer(
      relay,
      "the_chatroom",
      "browser:exit-seed",
      session.actor
    );
    expect(openTransfer.mode).toBe("cell_pages");
    if (openTransfer.mode !== "cell_pages") throw new Error("expected cell_pages open seed");
    const pages = [...openTransfer.page_refs, ...openTransfer.inline_pages];
    const hasCell = (object: string, page: string, name?: string): boolean =>
      pages.some((p) => {
        const rec = p as { object?: string; page?: string; name?: string };
        return rec.object === object && rec.page === page && (name === undefined || rec.name === name);
      });
    for (const exit of ["exit_living_room_southeast", "exit_living_room_south"]) {
      expect(hasCell(exit, "object_lineage"), `${exit} lineage`).toBe(true);
    }
    expect(hasCell("exit_living_room_southeast", "property_cell", "source")).toBe(true);
    expect(hasCell("exit_living_room_southeast", "property_cell", "dest")).toBe(true);

    const common = {
      node: "browser:exit-seed",
      actor: session.actor,
      session: session.id,
      head: { kind: "woo.scope_head.shadow.v1" as const, scope: "the_chatroom", epoch: 1, seq: 0, hash: "root" },
      id: "browser-local-southeast",
      route: "direct" as const,
      scope: "the_chatroom",
      target: "the_chatroom",
      verb: "southeast",
      args: [],
      persistence: "durable" as const
    };
    const transfers = [v2ExecutableTransferRecord(openTransfer, 1)];
    let repaired = await planV2BrowserLocalTurn({ ...common, transfers });
    for (let attempt = 0; attempt < 8 && !repaired.ok; attempt += 1) {
      expect(repaired).toMatchObject({ reason: "missing_state" });
      if (!repaired.key) throw new Error("expected repairable southeast plan");
      const repairTransfer = buildShadowCellPageTransfer({
        serialized,
        key: repaired.key,
        atom_hashes: repaired.missing_atoms?.map((atom) => atom.hash),
        missing_atoms: repaired.missing_atoms
      });
      transfers.push(v2ExecutableTransferRecord(repairTransfer, attempt + 2));
      repaired = await planV2BrowserLocalTurn({ ...common, transfers });
    }
    expect(repaired).toMatchObject({
      ok: true,
      optimistic_frame: {
        op: "result",
        result: { room: "the_deck", from: "the_chatroom", exit: "southeast" }
      }
    });
    if (!repaired.ok) throw new Error("expected repaired southeast plan");
    expect(repaired.transcript.error).toBeUndefined();
    expect(repaired.transcript.moves).toContainEqual(expect.objectContaining({
      object: session.actor,
      from: "the_chatroom",
      to: "the_deck"
    }));
  });

  it("classifies local E_OBJNF as repairable missing state instead of a successful proposal", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-exit-miss");
    const serialized = {
      ...anchor.exportWorld(),
      objects: anchor.exportWorld().objects.filter((obj) => obj.id !== "exit_living_room_southeast")
    };
    const relay = createShadowBrowserRelayShim({
      node: "relay:exit-miss",
      scope: "the_chatroom",
      serialized
    });
    const openTransfer = buildShadowBrowserOpenExecutableSeedTransfer(
      relay,
      "the_chatroom",
      "browser:exit-miss",
      session.actor
    );
    const common = {
      node: "browser:exit-miss",
      actor: session.actor,
      session: session.id,
      head: { kind: "woo.scope_head.shadow.v1" as const, scope: "the_chatroom", epoch: 1, seq: 0, hash: "root" },
      id: "browser-local-southeast-missing-exit",
      route: "direct" as const,
      scope: "the_chatroom",
      target: "the_chatroom",
      verb: "southeast",
      args: [],
      persistence: "durable" as const
    };
    const first = await planV2BrowserLocalTurn({
      ...common,
      transfers: [v2ExecutableTransferRecord(openTransfer, 1)]
    });
    if (first.ok || !first.key) throw new Error("expected first southeast miss to need verb repair");
    const repairTransfer = buildShadowCellPageTransfer({
      serialized,
      key: first.key,
      atom_hashes: first.missing_atoms?.map((atom) => atom.hash),
      missing_atoms: first.missing_atoms
    });
    const repaired = await planV2BrowserLocalTurn({
      ...common,
      transfers: [v2ExecutableTransferRecord(openTransfer, 1), v2ExecutableTransferRecord(repairTransfer, 2)]
    });
    expect(repaired).toMatchObject({
      ok: false,
      reason: "missing_state",
      request: { call: { target: "the_chatroom", verb: "southeast" } }
    });
    if (repaired.ok) throw new Error("expected missing_state for absent exit object");
    expect(repaired.missing_atoms).toContainEqual(expect.objectContaining({
      preimage: "read:cell:lifecycle:exit_living_room_southeast"
    }));
  });

  it("preserves stale subscriber rows without authoring derived enter presence writes", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-local-outliner-scrub");
    anchor.setProp("the_outline", "session_subscribers", [{ session: "expired:test", actor: "stale_actor" }]);
    anchor.setProp("the_outline", "subscribers", ["stale_actor"]);
    const serialized = anchor.exportWorld();
    const relay = createShadowBrowserRelayShim({
      node: "relay:outline-enter-scrub",
      scope: "the_outline",
      serialized
    });
    const openTransfer = buildShadowBrowserOpenExecutableSeedTransfer(
      relay,
      "the_outline",
      "browser:outline-enter-scrub",
      session.actor
    );

    const local = await planV2BrowserLocalTurn({
      node: "browser:outline-enter-scrub",
      actor: session.actor,
      session: session.id,
      head: { kind: "woo.scope_head.shadow.v1", scope: "the_outline", epoch: 1, seq: 0, hash: "root" },
      id: "outline-enter-scrub",
      route: "sequenced",
      scope: "the_outline",
      target: "the_outline",
      verb: "enter",
      args: [],
      persistence: "durable",
      transfers: [v2ExecutableTransferRecord(openTransfer, 1)]
    });

    expect(local).toMatchObject({
      ok: true,
      request: { call: { target: "the_outline", verb: "enter" } },
      optimistic_frame: {
        op: "result",
        result: { room: "the_outline" }
      }
    });
    if (!local.ok) throw new Error("expected local outliner enter plan");
    expect(local.transcript.reads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        cell: { kind: "prop", object: "the_outline", name: "session_subscribers" },
        value: expect.arrayContaining([
          expect.objectContaining({ session: "expired:test", actor: "stale_actor" })
        ])
      }),
      expect.objectContaining({
        cell: { kind: "prop", object: "the_outline", name: "subscribers" },
        value: expect.arrayContaining(["stale_actor"])
      })
    ]));
    expect(local.transcript.writes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ cell: { kind: "prop", object: "the_outline", name: "session_subscribers" } }),
      expect.objectContaining({ cell: { kind: "prop", object: "the_outline", name: "subscribers" } })
    ]));
  });

  it("plans a local enter over an accepted peer enter transcript", async () => {
    const anchor = createWorld();
    const first = anchor.auth("guest:v2-browser-local-peer-enter-a");
    const second = anchor.auth("guest:v2-browser-local-peer-enter-b");
    const serialized = anchor.exportWorld();
    const firstEntered = await runShadowTurnCall(authoritativePlanningWorld(serialized), {
      kind: "woo.turn_call.shadow.v1",
      id: "pinboard-peer-enter-a",
      route: "sequenced",
      scope: "the_pinboard",
      session: first.id,
      actor: first.actor,
      target: "the_pinboard",
      verb: "enter",
      args: []
    });
    const relay = createShadowBrowserRelayShim({
      node: "relay:pinboard-peer-enter",
      scope: "the_pinboard",
      serialized
    });
    const openTransfer = buildShadowBrowserOpenExecutableSeedTransfer(
      relay,
      "the_pinboard",
      "browser:pinboard-peer-enter",
      second.actor
    );
    const promoted = createV2BrowserAcceptedWriteCellTransfer({
      node: "browser:pinboard-peer-enter",
      scope: "the_pinboard",
      records: [v2ExecutableTransferRecord(openTransfer, 1)],
      transcripts: [firstEntered.transcript],
      accepted_head: { kind: "woo.scope_head.shadow.v1", scope: "the_pinboard", epoch: 1, seq: 1, hash: "peer" }
    });
    if (!promoted) throw new Error("expected peer enter write-cell promotion");
    const planned = await planV2BrowserLocalTurn({
      node: "browser:pinboard-peer-enter",
      actor: second.actor,
      session: second.id,
      head: { kind: "woo.scope_head.shadow.v1", scope: "the_pinboard", epoch: 1, seq: 1, hash: "peer" },
      id: "pinboard-peer-enter-b",
      route: "sequenced",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "enter",
      args: [],
      persistence: "durable",
      transfers: [v2ExecutableTransferRecord(openTransfer, 1), promoted.record]
    });

    expect(planned).toMatchObject({
      ok: true,
      request: { call: { target: "the_pinboard", verb: "enter" } },
      optimistic_frame: {
        op: "result",
        result: { room: "the_pinboard" }
      }
    });
  });

  it("plans read-side hydrations against accepted write-cell transfers", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-local-read-tail");
    const serialized = anchor.exportWorld();
    const relay = createShadowBrowserRelayShim({
      node: "relay:pinboard-tail",
      scope: "the_pinboard",
      serialized
    });
    const transfer = buildShadowBrowserOpenExecutableSeedTransfer(relay, "the_pinboard", "browser:pinboard-tail", session.actor);
    const entered = await runShadowTurnCall(authoritativePlanningWorld(serialized), {
      kind: "woo.turn_call.shadow.v1",
      id: "pinboard-tail-enter",
      route: "sequenced",
      scope: "the_pinboard",
      session: session.id,
      actor: session.actor,
      target: "the_pinboard",
      verb: "enter",
      args: []
    });
    const added = await runShadowTurnCall(authoritativePlanningWorld(entered.serializedAfter), {
      kind: "woo.turn_call.shadow.v1",
      id: "pinboard-tail-add",
      route: "sequenced",
      scope: "the_pinboard",
      session: session.id,
      actor: session.actor,
      target: "the_pinboard",
      verb: "add_note",
      args: ["accepted tail note", "yellow", 48, 48, 180, 110]
    });
    const promoted = createV2BrowserAcceptedWriteCellTransfer({
      node: "browser:pinboard-tail",
      scope: "the_pinboard",
      records: [v2ExecutableTransferRecord(transfer, 1)],
      transcripts: [entered.transcript, added.transcript],
      accepted_head: { kind: "woo.scope_head.shadow.v1", scope: "the_pinboard", epoch: 1, seq: 2, hash: "tail" }
    });
    if (!promoted) throw new Error("expected pinboard write-cell promotion");

    const firstLocal = await planV2BrowserLocalTurn({
      node: "browser:pinboard-tail",
      actor: session.actor,
      session: session.id,
      head: { kind: "woo.scope_head.shadow.v1", scope: "the_pinboard", epoch: 1, seq: 2, hash: "tail" },
      id: "pinboard-tail-list",
      route: "direct",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "list_notes",
      args: [],
      persistence: "live",
      transfers: [v2ExecutableTransferRecord(transfer, 1), promoted.record]
    });
    expect(firstLocal).toMatchObject({
      ok: false,
      reason: "missing_state",
      request: { call: { target: "the_pinboard", verb: "list_notes" } }
    });
    if (firstLocal.ok || !firstLocal.key) throw new Error("expected repairable local list plan");

    const repairTransfer = buildShadowCellPageTransfer({
      serialized: added.serializedAfter,
      key: firstLocal.key
    });
    const local = await planV2BrowserLocalTurn({
      node: "browser:pinboard-tail",
      actor: session.actor,
      session: session.id,
      head: { kind: "woo.scope_head.shadow.v1", scope: "the_pinboard", epoch: 1, seq: 2, hash: "tail" },
      id: "pinboard-tail-list-repaired",
      route: "direct",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "list_notes",
      args: [],
      persistence: "live",
      transfers: [v2ExecutableTransferRecord(transfer, 1), promoted.record, v2ExecutableTransferRecord(repairTransfer, 3)]
    });

    expect(local).toMatchObject({
      ok: true,
      request: { call: { target: "the_pinboard", verb: "list_notes" } }
    });
    if (!local.ok) throw new Error("expected local list plan");
    expect(local.optimistic_frame.op).toBe("result");
    if (local.optimistic_frame.op !== "result") throw new Error("expected local list result frame");
    expect(JSON.stringify(local.optimistic_frame.result)).toContain("accepted tail note");
  });

  it("keeps later accepted outliner items visible from accepted write-cell transfers", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-outline-tail");
    const serialized = anchor.exportWorld();
    const relay = createShadowBrowserRelayShim({
      node: "relay:outline-tail",
      scope: "the_outline",
      serialized
    });
    const transfer = buildShadowBrowserOpenExecutableSeedTransfer(relay, "the_outline", "browser:outline-tail", session.actor);
    const entered = await runShadowTurnCall(authoritativePlanningWorld(serialized), {
      kind: "woo.turn_call.shadow.v1",
      id: "outline-tail-enter",
      route: "sequenced",
      scope: "the_outline",
      session: session.id,
      actor: session.actor,
      target: "the_outline",
      verb: "enter",
      args: []
    });
    const added = await runShadowTurnCall(authoritativePlanningWorld(entered.serializedAfter), {
      kind: "woo.turn_call.shadow.v1",
      id: "outline-tail-add",
      route: "sequenced",
      scope: "the_outline",
      session: session.id,
      actor: session.actor,
      target: "the_outline",
      verb: "add",
      args: ["accepted outline item"]
    });
    const promoted = createV2BrowserAcceptedWriteCellTransfer({
      node: "browser:outline-tail",
      scope: "the_outline",
      records: [v2ExecutableTransferRecord(transfer, 1)],
      transcripts: [entered.transcript, added.transcript],
      accepted_head: { kind: "woo.scope_head.shadow.v1", scope: "the_outline", epoch: 1, seq: 2, hash: "tail" }
    });
    if (!promoted) throw new Error("expected outliner write-cell promotion");
    const firstLocal = await planV2BrowserLocalTurn({
      node: "browser:outline-tail",
      actor: session.actor,
      session: session.id,
      head: { kind: "woo.scope_head.shadow.v1", scope: "the_outline", epoch: 1, seq: 2, hash: "tail" },
      id: "outline-tail-list",
      route: "direct",
      scope: "the_outline",
      target: "the_outline",
      verb: "list_items",
      args: [],
      persistence: "live",
      transfers: [v2ExecutableTransferRecord(transfer, 1), promoted.record]
    });
    expect(firstLocal).toMatchObject({
      ok: false,
      reason: "missing_state",
      request: { call: { target: "the_outline", verb: "list_items" } }
    });
    if (firstLocal.ok || !firstLocal.key) throw new Error("expected repairable local list plan");

    const repairTransfer = buildShadowCellPageTransfer({
      serialized: added.serializedAfter,
      key: firstLocal.key
    });
    const local = await planV2BrowserLocalTurn({
      node: "browser:outline-tail",
      actor: session.actor,
      session: session.id,
      head: { kind: "woo.scope_head.shadow.v1", scope: "the_outline", epoch: 1, seq: 2, hash: "tail" },
      id: "outline-tail-list-repaired",
      route: "direct",
      scope: "the_outline",
      target: "the_outline",
      verb: "list_items",
      args: [],
      persistence: "live",
      transfers: [
        v2ExecutableTransferRecord(transfer, 1),
        promoted.record,
        v2ExecutableTransferRecord(repairTransfer, 3)
      ]
    });

    expect(local).toMatchObject({
      ok: true,
      request: { call: { target: "the_outline", verb: "list_items" } }
    });
    if (!local.ok) throw new Error("expected local list plan");
    expect(local.optimistic_frame.op).toBe("result");
    if (local.optimistic_frame.op !== "result") throw new Error("expected local list result frame");
    expect(JSON.stringify(local.optimistic_frame.result)).toContain("accepted outline item");
  });

  it("keeps optimistic outliner item text visible in dependent local reads", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-outline-tentative-text");
    const serialized = anchor.exportWorld();
    const relay = createShadowBrowserRelayShim({
      node: "relay:outline-tentative-text",
      scope: "the_outline",
      serialized
    });
    const seed = buildShadowBrowserOpenExecutableSeedTransfer(relay, "the_outline", "browser:outline-tentative-text", session.actor);
    const entered = await runShadowTurnCall(authoritativePlanningWorld(serialized), {
      kind: "woo.turn_call.shadow.v1",
      id: "outline-tentative-enter-reference",
      route: "sequenced",
      scope: "the_outline",
      session: session.id,
      actor: session.actor,
      target: "the_outline",
      verb: "enter",
      args: []
    });
    const added = await runShadowTurnCall(authoritativePlanningWorld(entered.serializedAfter), {
      kind: "woo.turn_call.shadow.v1",
      id: "outline-tentative-add-reference",
      route: "sequenced",
      scope: "the_outline",
      session: session.id,
      actor: session.actor,
      target: "the_outline",
      verb: "add",
      args: ["tentative outline item"]
    });
    const addTransfer = buildShadowCellPageTransfer({
      serialized,
      key: shadowTurnKeyFromTranscript(added.transcript)
    });
    const transfers = [
      v2ExecutableTransferRecord(seed, 1),
      v2ExecutableTransferRecord(addTransfer, 2)
    ];
    const head = { kind: "woo.scope_head.shadow.v1" as const, scope: "the_outline", epoch: 1, seq: 0, hash: "root" };
    const localEnter = await planV2BrowserLocalTurn({
      node: "browser:outline-tentative-text",
      actor: session.actor,
      session: session.id,
      head,
      id: "outline-tentative-enter",
      route: "sequenced",
      scope: "the_outline",
      target: "the_outline",
      verb: "enter",
      args: [],
      persistence: "durable",
      transfers
    });
    expect(localEnter).toMatchObject({ ok: true, request: { call: { verb: "enter" } } });
    if (!localEnter.ok) throw new Error("expected local outliner enter");

    const localAdd = await planV2BrowserLocalTurn({
      node: "browser:outline-tentative-text",
      actor: session.actor,
      session: session.id,
      head,
      id: "outline-tentative-add",
      route: "sequenced",
      scope: "the_outline",
      target: "the_outline",
      verb: "add",
      args: ["tentative outline item"],
      persistence: "durable",
      transfers,
      tentative_transcripts: [localEnter.transcript]
    });
    expect(localAdd).toMatchObject({ ok: true, request: { call: { verb: "add" } } });
    if (!localAdd.ok) throw new Error("expected local outliner add");

    const firstList = await planV2BrowserLocalTurn({
      node: "browser:outline-tentative-text",
      actor: session.actor,
      session: session.id,
      head,
      id: "outline-tentative-list",
      route: "direct",
      scope: "the_outline",
      target: "the_outline",
      verb: "list_items",
      args: [],
      persistence: "live",
      transfers,
      tentative_transcripts: [localEnter.transcript, localAdd.transcript]
    });
    expect(firstList).toMatchObject({
      ok: false,
      reason: "missing_state",
      request: { call: { target: "the_outline", verb: "list_items" } }
    });
    if (firstList.ok || !firstList.key) throw new Error("expected repairable local list_items plan");

    const repairTransfer = buildShadowCellPageTransfer({
      serialized: added.serializedAfter,
      key: firstList.key
    });
    const localList = await planV2BrowserLocalTurn({
      node: "browser:outline-tentative-text",
      actor: session.actor,
      session: session.id,
      head,
      id: "outline-tentative-list-repaired",
      route: "direct",
      scope: "the_outline",
      target: "the_outline",
      verb: "list_items",
      args: [],
      persistence: "live",
      transfers: [...transfers, v2ExecutableTransferRecord(repairTransfer, 3)],
      tentative_transcripts: [localEnter.transcript, localAdd.transcript]
    });

    expect(localList).toMatchObject({
      ok: true,
      request: { call: { target: "the_outline", verb: "list_items" } }
    });
    if (!localList.ok) throw new Error("expected local list_items");
    expect(localList.optimistic_frame.op).toBe("result");
    if (localList.optimistic_frame.op !== "result") throw new Error("expected local result frame");
    expect(JSON.stringify(localList.optimistic_frame.result)).toContain("tentative outline item");
  });

  it("plans dependent durable turns against a tentative transcript chain", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-local-turn-journal");
    const serialized = anchor.exportWorld();
    const enterCall: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "pinboard-enter",
      route: "sequenced",
      scope: "the_pinboard",
      session: session.id,
      actor: session.actor,
      target: "the_pinboard",
      verb: "enter",
      args: []
    };
    const entered = await runShadowTurnCall(authoritativePlanningWorld(serialized), enterCall);
    const addCall: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "pinboard-add",
      route: "sequenced",
      scope: "the_pinboard",
      session: session.id,
      actor: session.actor,
      target: "the_pinboard",
      verb: "add_note",
      args: ["journal note", "yellow", 48, 48, 180, 110]
    };
    const added = await runShadowTurnCall(authoritativePlanningWorld(entered.serializedAfter), addCall);
    const enterKey = shadowTurnKeyFromTranscript(entered.transcript);
    const addKey = shadowTurnKeyFromTranscript(added.transcript);
    const enterTransfer = buildShadowCellPageTransfer({
      serialized,
      key: enterKey,
    });
    const addTransfer = buildShadowCellPageTransfer({ serialized, key: addKey });
    const relay = createShadowBrowserRelayShim({
      node: "relay:pinboard-journal",
      scope: "the_pinboard",
      serialized
    });
    const openTransfer = buildShadowBrowserOpenExecutableSeedTransfer(
      relay,
      "the_pinboard",
      "browser:test",
      session.actor
    );
    const transfers = [
      v2ExecutableTransferRecord(openTransfer, 1),
      v2ExecutableTransferRecord(enterTransfer, 2),
      v2ExecutableTransferRecord(addTransfer, 3)
    ];

    const localEnter = await planV2BrowserLocalTurn({
      node: "browser:test",
      actor: session.actor,
      session: session.id,
      head: { kind: "woo.scope_head.shadow.v1", scope: "the_pinboard", epoch: 1, seq: 0, hash: "root" },
      id: "pinboard-enter",
      route: "sequenced",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "enter",
      args: [],
      persistence: "durable",
      transfers
    });
    expect(localEnter).toMatchObject({ ok: true, request: { call: { verb: "enter" } } });
    if (!localEnter.ok) throw new Error("expected local enter plan");

    const localAdd = await planV2BrowserLocalTurn({
      node: "browser:test",
      actor: session.actor,
      session: session.id,
      head: { kind: "woo.scope_head.shadow.v1", scope: "the_pinboard", epoch: 1, seq: 0, hash: "root" },
      id: "pinboard-add",
      route: "sequenced",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "add_note",
      args: ["journal note", "yellow", 48, 48, 180, 110],
      persistence: "durable",
      transfers,
      tentative_transcripts: [localEnter.transcript]
    });

    expect(localAdd).toMatchObject({
      ok: true,
      request: { call: { verb: "add_note" } },
      optimistic_frame: { op: "result", result: expect.objectContaining({ text: "journal note" }) }
    });
  });

  it("repairs cold dependent tool creates in one transfer from the open executable seed", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-local-one-repair");
    const serialized = anchor.exportWorld();
    for (const scenario of [
      {
        scope: "the_pinboard",
        verb: "add_note",
        args: ["one-repair pin", "yellow", 48, 48, 180, 110],
        expected: "one-repair pin"
      },
      {
        scope: "the_outline",
        verb: "add",
        args: ["one-repair outline"],
        expected: "one-repair outline"
      }
    ] as const) {
      const relay = createShadowBrowserRelayShim({
        node: `relay:${scenario.scope}:one-repair`,
        scope: scenario.scope,
        serialized
      });
      const openTransfer = buildShadowBrowserOpenExecutableSeedTransfer(
        relay,
        scenario.scope,
        `browser:${scenario.scope}:one-repair`,
        session.actor
      );
      const entered = await runShadowTurnCall(authoritativePlanningWorld(serialized), {
        kind: "woo.turn_call.shadow.v1",
        id: `${scenario.scope}:one-repair-enter`,
        route: "sequenced",
        scope: scenario.scope,
        session: session.id,
        actor: session.actor,
        target: scenario.scope,
        verb: "enter",
        args: []
      });

      const first = await planV2BrowserLocalTurn({
        node: `browser:${scenario.scope}:one-repair`,
        actor: session.actor,
        session: session.id,
        head: { kind: "woo.scope_head.shadow.v1", scope: scenario.scope, epoch: 1, seq: 0, hash: "root" },
        id: `${scenario.scope}:one-repair-${scenario.verb}`,
        route: "sequenced",
        scope: scenario.scope,
        target: scenario.scope,
        verb: scenario.verb,
        args: [...scenario.args],
        persistence: "durable",
        transfers: [v2ExecutableTransferRecord(openTransfer, 1)],
        tentative_transcripts: [entered.transcript]
      });
      expect(first, `${scenario.scope}:${scenario.verb} should request one repair`).toMatchObject({
        ok: false,
        reason: "missing_state",
        request: { call: { target: scenario.scope, verb: scenario.verb } }
      });
      if (first.ok || !first.key) throw new Error(`expected repairable ${scenario.scope}:${scenario.verb} plan`);

      const repairTransfer = buildShadowCellPageTransfer({
        serialized: entered.serializedAfter,
        key: first.key,
        atom_hashes: first.missing_atoms?.map((atom) => atom.hash),
        missing_atoms: first.missing_atoms
      });
      const repaired = await planV2BrowserLocalTurn({
        node: `browser:${scenario.scope}:one-repair`,
        actor: session.actor,
        session: session.id,
        head: { kind: "woo.scope_head.shadow.v1", scope: scenario.scope, epoch: 1, seq: 0, hash: "root" },
        id: `${scenario.scope}:one-repair-${scenario.verb}:repaired`,
        route: "sequenced",
        scope: scenario.scope,
        target: scenario.scope,
        verb: scenario.verb,
        args: [...scenario.args],
        persistence: "durable",
        transfers: [v2ExecutableTransferRecord(openTransfer, 1), v2ExecutableTransferRecord(repairTransfer, 2)],
        tentative_transcripts: [entered.transcript]
      });
      expect(repaired, `${scenario.scope}:${scenario.verb} after one repair`).toMatchObject({
        ok: true,
        request: { call: { target: scenario.scope, verb: scenario.verb } }
      });
      if (!repaired.ok) throw new Error(`expected repaired ${scenario.scope}:${scenario.verb} plan`);
      expect(JSON.stringify(repaired.optimistic_frame)).toContain(scenario.expected);
    }
  });

  it("keeps a turn exec request available when local planning needs delegated state", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-local-turn-missing-state");
    anchor.setProp("the_dubspace", "operators", [session.actor]);
    const serialized = anchor.exportWorld();
    const call = dubspaceCall(session.id, session.actor, 0.57);
    const key = shadowTurnKeyFromTranscript((await runShadowTurnCall(authoritativePlanningWorld(serialized), call)).transcript);
    const relay = createShadowBrowserRelayShim({
      node: "relay:dubspace-missing-state",
      scope: "the_dubspace",
      serialized
    });
    const openTransfer = buildShadowBrowserOpenExecutableSeedTransfer(
      relay,
      "the_dubspace",
      "browser:test",
      session.actor
    );
    const omittedHash = key.atom_hashes.find((hash) => !openTransfer.atom_hashes.includes(hash));
    if (!omittedHash) throw new Error("expected a turn-specific atom outside the open executable seed");
    const partialTransfer = buildShadowCellPageTransfer({
      serialized,
      key,
      atom_hashes: key.atom_hashes.filter((hash) => hash !== omittedHash)
    });

    const local = await planV2BrowserLocalTurn({
      node: "browser:test",
      actor: session.actor,
      session: session.id,
      head: { kind: "woo.scope_head.shadow.v1", scope: "the_dubspace", epoch: 1, seq: 0, hash: "root" },
      id: "browser-local-set-control",
      route: "sequenced",
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.57],
      persistence: "durable",
      transfers: [
        v2ExecutableTransferRecord(openTransfer, 1),
        v2ExecutableTransferRecord(partialTransfer, 2)
      ]
    });

    expect(local).toMatchObject({
      ok: false,
      reason: "missing_state",
      request: {
        kind: "woo.turn.exec.request.shadow.v1",
        key: expect.objectContaining({ scope: "the_dubspace" })
      }
    });
    if (local.ok) throw new Error("expected missing_state");
    expect(local.missing_atoms?.map((atom) => atom.hash)).toContain(omittedHash);
  });
});

type LocalTranscriptParityScenario = {
  name: string;
  scope: string;
  target: string;
  verb: string;
  args: WooValue[];
  setup?: (world: ReturnType<typeof createWorld>, session: { id: string; actor: string }) => Promise<void> | void;
};

async function expectLocalTranscriptToMatchServer(scenario: LocalTranscriptParityScenario): Promise<void> {
  const anchor = createWorld();
  const session = anchor.auth(`guest:v2-browser-local-parity-${scenario.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`);
  await scenario.setup?.(anchor, session);
  const serialized = anchor.exportWorld();
  const turnId = `browser-local-parity-${scenario.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  const call: ShadowTurnCall = {
    kind: "woo.turn_call.shadow.v1",
    id: turnId,
    route: "sequenced",
    scope: scenario.scope,
    session: session.id,
    actor: session.actor,
    target: scenario.target,
    verb: scenario.verb,
    args: scenario.args
  };
  const server = await runShadowTurnCall(authoritativePlanningWorld(serialized), call);
  const key = shadowTurnKeyFromTranscript(server.transcript);
  // The open executable seed carries shared runtime objects such as $wiz; the
  // turn-specific transfer carries the exact cells selected for this call.
  const relay = createShadowBrowserRelayShim({
    node: `relay:parity:${scenario.scope}`,
    scope: scenario.scope,
    serialized
  });
  const openTransfer = buildShadowBrowserOpenExecutableSeedTransfer(
    relay,
    scenario.scope,
    `browser:parity:${scenario.scope}`,
    session.actor
  );
  const transfer = buildShadowCellPageTransfer({ serialized, key });
  const local = await planV2BrowserLocalTurn({
    node: `browser:parity:${scenario.scope}`,
    actor: session.actor,
    session: session.id,
    head: { kind: "woo.scope_head.shadow.v1", scope: scenario.scope, epoch: 1, seq: 0, hash: "root" },
    id: turnId,
    route: "sequenced",
    scope: scenario.scope,
    target: scenario.target,
    verb: scenario.verb,
    args: scenario.args,
    persistence: "durable",
    transfers: [v2ExecutableTransferRecord(openTransfer, 1), v2ExecutableTransferRecord(transfer, 2)]
  });

  expect(local, scenario.name).toMatchObject({ ok: true });
  if (!local.ok) throw new Error(`expected local transcript for ${scenario.name}`);
  expect(local.transcript.error, scenario.name).toBeUndefined();
  const normalizedServer = normalizeLogicalClockTranscript(server.transcript);
  const normalizedLocal = normalizeLogicalClockTranscript(local.transcript);
  expect(normalizedLocal, scenario.name).toEqual(normalizedServer);
  expect(normalizedLocal.hash, scenario.name).toBe(normalizedServer.hash);
}

function normalizeLogicalClockTranscript(transcript: EffectTranscript): EffectTranscript {
  const clockValues = new Set<number>();
  const withNamedLogicalInputs: EffectTranscript = structuredClone(transcript);
  withNamedLogicalInputs.logicalInputs = transcript.logicalInputs.map((input, index) => {
    if (typeof input.value === "number") clockValues.add(input.value);
    return { ...input, value: `__logical_input_${index}_${input.name}__` };
  });
  const normalized = replaceLogicalClockValues(withNamedLogicalInputs, clockValues) as EffectTranscript;
  const withoutHash = { ...normalized } as Record<string, unknown>;
  delete withoutHash.hash;
  return {
    ...normalized,
    hash: hashSource(stableShadowJson(withoutHash as WooValue))
  };
}

function replaceLogicalClockValues(value: unknown, clockValues: ReadonlySet<number>): unknown {
  if (typeof value === "number" && clockValues.has(value)) return "__logical_clock_value__";
  if (Array.isArray(value)) return value.map((item) => replaceLogicalClockValues(item, clockValues));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = replaceLogicalClockValues(item, clockValues);
    return out;
  }
  return value;
}

function dubspaceCall(session: string, actor: string, value: number): ShadowTurnCall {
  return {
    kind: "woo.turn_call.shadow.v1",
    id: "browser-local-set-control",
    route: "sequenced",
    scope: "the_dubspace",
    session,
    actor,
    target: "the_dubspace",
    verb: "set_control",
    args: ["delay_1", "wet", value]
  };
}
