import { describe, expect, it } from "vitest";

import { planV2BrowserLocalTurn } from "../src/client/v2-browser-local-turn";
import { v2ExecutableTransferRecord } from "../src/client/v2-browser-execution-cache";
import { createWorld } from "../src/core/bootstrap";
import { buildShadowTurnExecAd, executeShadowTurnCallAcrossInProcessNetwork } from "../src/core/shadow-turn-network";
import { buildShadowClosureTransfer, createShadowExecutionNode } from "../src/core/shadow-turn-exec";
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
