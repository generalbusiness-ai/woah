import { describe, expect, it } from "vitest";

import { planV2BrowserLocalTurn } from "../src/client/v2-browser-local-turn";
import { v2ExecutableTransferRecord } from "../src/client/v2-browser-execution-cache";
import { createWorld } from "../src/core/bootstrap";
import { buildShadowBrowserOpenExecutableSeedTransfer, createShadowBrowserRelayShim } from "../src/core/shadow-browser-node";
import { buildShadowTurnExecAd, executeShadowTurnCallAcrossInProcessNetwork } from "../src/core/shadow-turn-network";
import { buildShadowCellPageTransfer, buildShadowClosureTransfer, createShadowExecutionNode } from "../src/core/shadow-turn-exec";
import { runShadowTurnCall, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";

describe("v2 browser local turn planning", () => {
  it("builds a TurnExecRequest from a warmed browser execution cache", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-local-turn");
    anchor.setProp("the_dubspace", "operators", [session.actor]);
    const serialized = anchor.exportWorld();
    const call = dubspaceCall(session.id, session.actor, 0.42);
    const planned = await runShadowTurnCall(serialized, call);
    const key = shadowTurnKeyFromTranscript(planned.transcript);
    const actorNode = createShadowExecutionNode({ node: "browser:test", scope: key.scope });
    const routed = await executeShadowTurnCallAcrossInProcessNetwork({
      request: { kind: "woo.turn.exec.request.shadow.v1", call, key },
      nodes: [actorNode],
      ads: [buildShadowTurnExecAd({ node: "browser:test", scope: key.scope, key, factor: 0.1 })],
      anchor: { node: "stable-anchor", serialized }
    });
    const transfer = routed.transfers[0];
    if (!transfer) throw new Error("expected cache-warming transfer");

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

  it("reports no executable state before the browser has learned a closure", async () => {
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
        ? [(await runShadowTurnCall(serialized, {
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
      request: { call: { target: "the_pinboard", verb: "enter" } }
    });
  });

  it("plans a local enter over an accepted peer enter transcript", async () => {
    const anchor = createWorld();
    const first = anchor.auth("guest:v2-browser-local-peer-enter-a");
    const second = anchor.auth("guest:v2-browser-local-peer-enter-b");
    const serialized = anchor.exportWorld();
    const firstEntered = await runShadowTurnCall(serialized, {
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
      transfers: [v2ExecutableTransferRecord(openTransfer, 1)],
      committed_transcripts: [firstEntered.transcript]
    });

    expect(planned).toMatchObject({
      ok: true,
      request: { call: { target: "the_pinboard", verb: "enter" } }
    });
  });

  it("plans read-side hydrations against accepted transcript tails", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-local-read-tail");
    const serialized = anchor.exportWorld();
    const relay = createShadowBrowserRelayShim({
      node: "relay:pinboard-tail",
      scope: "the_pinboard",
      serialized
    });
    const transfer = buildShadowBrowserOpenExecutableSeedTransfer(relay, "the_pinboard", "browser:pinboard-tail", session.actor);
    const entered = await runShadowTurnCall(serialized, {
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
    const added = await runShadowTurnCall(entered.serializedAfter, {
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
    const addTransfer = buildShadowClosureTransfer({
      serialized,
      key: shadowTurnKeyFromTranscript(added.transcript)
    });

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
      transfers: [v2ExecutableTransferRecord(transfer, 1), v2ExecutableTransferRecord(addTransfer, 2)],
      committed_transcripts: [entered.transcript, added.transcript]
    });
    expect(firstLocal).toMatchObject({
      ok: false,
      reason: "missing_state",
      request: { call: { target: "the_pinboard", verb: "list_notes" } }
    });
    if (firstLocal.ok || !firstLocal.key) throw new Error("expected repairable local list plan");

    const repairTransfer = buildShadowClosureTransfer({
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
      transfers: [v2ExecutableTransferRecord(transfer, 1), v2ExecutableTransferRecord(addTransfer, 2), v2ExecutableTransferRecord(repairTransfer, 3)],
      committed_transcripts: [entered.transcript, added.transcript]
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

  it("keeps later accepted outliner items visible when older transcripts are replayed", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:v2-browser-outline-tail");
    const serialized = anchor.exportWorld();
    const relay = createShadowBrowserRelayShim({
      node: "relay:outline-tail",
      scope: "the_outline",
      serialized
    });
    const transfer = buildShadowBrowserOpenExecutableSeedTransfer(relay, "the_outline", "browser:outline-tail", session.actor);
    const entered = await runShadowTurnCall(serialized, {
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
    const added = await runShadowTurnCall(entered.serializedAfter, {
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
    const addTransfer = buildShadowClosureTransfer({
      serialized,
      key: shadowTurnKeyFromTranscript(added.transcript)
    });
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
      transfers: [v2ExecutableTransferRecord(transfer, 1), v2ExecutableTransferRecord(addTransfer, 2)],
      committed_transcripts: [entered.transcript, added.transcript]
    });
    expect(firstLocal).toMatchObject({
      ok: false,
      reason: "missing_state",
      request: { call: { target: "the_outline", verb: "list_items" } }
    });
    if (firstLocal.ok || !firstLocal.key) throw new Error("expected repairable local list plan");

    const repairTransfer = buildShadowClosureTransfer({
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
        v2ExecutableTransferRecord(addTransfer, 2),
        v2ExecutableTransferRecord(repairTransfer, 3)
      ],
      committed_transcripts: [entered.transcript, added.transcript]
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
    const entered = await runShadowTurnCall(serialized, enterCall);
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
    const added = await runShadowTurnCall(entered.serializedAfter, addCall);
    const enterKey = shadowTurnKeyFromTranscript(entered.transcript);
    const addKey = shadowTurnKeyFromTranscript(added.transcript);
    const enterTransfer = buildShadowClosureTransfer({
      serialized,
      key: enterKey,
    });
    const addTransfer = buildShadowClosureTransfer({ serialized, key: addKey });
    const transfers = [v2ExecutableTransferRecord(enterTransfer, 1), v2ExecutableTransferRecord(addTransfer, 2)];

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
      const entered = await runShadowTurnCall(serialized, {
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
    const key = shadowTurnKeyFromTranscript((await runShadowTurnCall(serialized, call)).transcript);
    const partialTransfer = buildShadowClosureTransfer({
      serialized,
      key,
      atom_hashes: key.atom_hashes.slice(1)
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
      transfers: [v2ExecutableTransferRecord(partialTransfer, 1)]
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
    expect(local.missing_atoms?.map((atom) => atom.hash)).toContain(key.atom_hashes[0]);
  });
});

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
