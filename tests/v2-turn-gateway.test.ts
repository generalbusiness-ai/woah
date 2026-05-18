import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import type { EffectTranscript } from "../src/core/effect-transcript";
import type { SerializedWorld } from "../src/core/repository";
import { decodeEnvelope, encodeEnvelope, type ShadowEnvelope } from "../src/core/shadow-envelope";
import type { ShadowScopeHead } from "../src/core/shadow-commit-scope";
import type { ShadowTurnExecReply, ShadowTurnExecRequest } from "../src/core/shadow-turn-exec";
import {
  mergeV2TurnGatewayAuthority,
  submitTurnIntent,
  v2TurnGatewayEnvelopeId,
  v2TurnGatewayReplyNeedsRepair,
  type V2TurnGatewayEnvelopeBody
} from "../src/core/v2-turn-gateway";
import type { ObjRef } from "../src/core/types";

describe("v2 turn gateway", () => {
  it("classifies only state-repair replies as retryable", () => {
    expect(v2TurnGatewayReplyNeedsRepair({
      kind: "woo.turn.exec.reply.shadow.v1",
      ok: false,
      reason: "missing_state"
    })).toBe(true);
    expect(v2TurnGatewayReplyNeedsRepair({
      kind: "woo.turn.exec.reply.shadow.v1",
      ok: false,
      reason: "commit_rejected",
      commit: {
        kind: "woo.commit.conflict.shadow.v1",
        id: "turn",
        scope: "$room",
        current: { kind: "woo.scope_head.shadow.v1", scope: "$room", epoch: 1, seq: 1, hash: "h" },
        reason: "stale_head",
        errors: [],
        receipt: receipt(false)
      }
    })).toBe(true);
    expect(v2TurnGatewayReplyNeedsRepair(okReply("turn"))).toBe(false);
  });

  it("merges authority rows into serialized state without duplicating objects", () => {
    const serialized = {
      sessions: [{ id: "old", actor: "$old" as ObjRef, started: 1, lastDetachAt: null, tokenClass: "guest" as const, activeScope: "$old-room" as ObjRef }],
      objects: [
        serializedObject("$one", "one", 1),
        serializedObject("$two", "two", 1)
      ]
    };
    mergeV2TurnGatewayAuthority(serialized, {
      sessions: [{ id: "new", actor: "$actor" as ObjRef, started: 2, lastDetachAt: null, tokenClass: "guest" as const, activeScope: "$room" as ObjRef }],
      objects: [
        { ...serialized.objects[1], name: "two updated" },
        serializedObject("$three", "three", 3)
      ]
    });

    expect(serialized.sessions.map((session) => session.id)).toEqual(["new"]);
    expect(serialized.objects.map((object) => [object.id, object.name])).toEqual([
      ["$one", "one"],
      ["$two", "two updated"],
      ["$three", "three"]
    ]);
  });

  it("submits intent turns through one retry loop with refreshed authority", async () => {
    const envelopes: V2TurnGatewayEnvelopeBody[] = [];
    const attempts: number[] = [];
    const result = await submitTurnIntent({
      input: {
        id: "turn-1",
        route: "direct",
        scope: "$room" as ObjRef,
        session: "s1",
        actor: "$actor" as ObjRef,
        target: "$target" as ObjRef,
        verb: "look",
        args: [],
        persistence: "durable",
        token: "token"
      },
      strategy: "intent",
      maxAttempts: 2,
      ensureClient: async (_scope, attempt) => {
        attempts.push(attempt);
        return { node: `client-${attempt}` };
      },
      clientNode: (client) => client.node,
      nextTurnId: () => { throw new Error("explicit test turn id should be reused"); },
      envelopeId: (turnId, attempt) => v2TurnGatewayEnvelopeId(turnId, attempt, () => "retry"),
      authorityPayload: (_scope, extraObjectIds) => ({
        sessions: [],
        session_objects: [],
        authority: { kind: "woo.authority_slice.shadow.v1", sessions: [], objects: extraObjectIds.map((id) => serializedObject(id, id, 0)) }
      }),
      submitEnvelope: async (_scope, body) => {
        envelopes.push(body);
        return { reply: encodeEnvelope(replyEnvelope(envelopes.length === 1 ? missingStateReply("turn-1") : okReply("turn-1"))) };
      }
    });

    expect(result.kind).toBe("submitted");
    if (result.kind !== "submitted") throw new Error("expected submitted result");
    expect(result.reply?.ok).toBe(true);
    expect(attempts).toEqual([0, 1]);
    expect(envelopes.map((body) => body.node)).toEqual(["client-0", "client-1"]);
    expect(envelopes.map((body) => body.authority.objects.map((object) => object.id))).toEqual([
      ["$room", "$target", "$actor"],
      ["$room", "$target", "$actor"]
    ]);
  });

  it("plans and submits a durable exec request through the planned-exec strategy", async () => {
    const world = createWorld();
    const session = world.auth("guest:v2-gateway-planned");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const harness = makePlannedExecHarness(world.exportWorld());

    const result = await submitTurnIntent({
      input: {
        id: "planned-set-control",
        route: "sequenced",
        scope: "the_dubspace",
        session: session.id,
        actor: session.actor,
        target: "the_dubspace",
        verb: "set_control",
        args: ["delay_1", "wet", 0.25],
        persistence: "durable",
        token: "token"
      },
      strategy: "planned-exec",
      maxAttempts: 1,
      ...harness.options
    });

    expect(result.kind).toBe("submitted");
    if (result.kind !== "submitted") throw new Error("expected planned submission");
    expect(result.commitScope).toBe("the_dubspace");
    expect(result.planned?.frame).toMatchObject({ op: "applied", space: "the_dubspace", result: 0.25 });
    expect(harness.ensureScopes).toEqual(["the_dubspace"]);
    expect(harness.submissions).toHaveLength(1);
    const submitted = harness.submissions[0];
    expect(submitted.scope).toBe("the_dubspace");
    expect(submitted.body.scope).toBe("the_dubspace");
    expect(submitted.body.node).toBe("node:the_dubspace");
    expect(submitted.request).toMatchObject({
      kind: "woo.turn.exec.request.shadow.v1",
      id: "planned-set-control",
      call: {
        route: "sequenced",
        scope: "the_dubspace",
        target: "the_dubspace",
        verb: "set_control"
      },
      key: { scope: "the_dubspace" },
      expected: scopeHead("the_dubspace"),
      auth: { mode: "shadow_local", actor: session.actor, session: session.id },
      persistence: "durable"
    });
    expect(submitted.body.authority.objects.map((object) => object.id)).toEqual(["the_dubspace", session.actor]);
    expect(result.reply?.ok).toBe(true);
  });

  it("routes planned-exec submission to the transcript commit scope, not the caller scope", async () => {
    const world = createWorld();
    const session = world.auth("guest:v2-gateway-cross-scope");
    await world.directCall("setup:enter-chatroom", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    const harness = makePlannedExecHarness(world.exportWorld());

    const result = await submitTurnIntent({
      input: {
        id: "planned-enter-dubspace",
        route: "direct",
        scope: "the_chatroom",
        session: session.id,
        actor: session.actor,
        target: "the_dubspace",
        verb: "enter",
        args: [],
        persistence: "durable",
        token: "token"
      },
      strategy: "planned-exec",
      maxAttempts: 1,
      ...harness.options
    });

    expect(result.kind).toBe("submitted");
    if (result.kind !== "submitted") throw new Error("expected planned submission");
    expect(result.scope).toBe("the_chatroom");
    expect(result.commitScope).toBe("the_dubspace");
    expect(result.planned?.transcript.scope).toBe("the_dubspace");
    expect(harness.ensureScopes).toEqual(["the_chatroom", "the_dubspace"]);
    expect(harness.submissions).toHaveLength(1);
    const submitted = harness.submissions[0];
    expect(submitted.scope).toBe("the_dubspace");
    expect(submitted.body.scope).toBe("the_dubspace");
    expect(submitted.body.node).toBe("node:the_dubspace");
    expect(submitted.request).toMatchObject({
      kind: "woo.turn.exec.request.shadow.v1",
      id: "planned-enter-dubspace",
      call: {
        route: "direct",
        scope: "the_chatroom",
        target: "the_dubspace",
        verb: "enter"
      },
      key: { scope: "the_dubspace" },
      expected: scopeHead("the_dubspace"),
      auth: { mode: "shadow_local", actor: session.actor, session: session.id }
    });
    expect(submitted.body.authority.objects.map((object) => object.id)).toEqual([
      "the_dubspace",
      "the_chatroom",
      session.actor
    ]);
    expect(result.reply?.ok).toBe(true);
  });
});

type PlannedGatewayClient = {
  scope: ObjRef;
  node: string;
  head: ShadowScopeHead;
  serialized: SerializedWorld;
};

type PlannedGatewaySubmission = {
  scope: ObjRef;
  body: V2TurnGatewayEnvelopeBody;
  envelope: ShadowEnvelope<ShadowTurnExecRequest>;
  request: ShadowTurnExecRequest;
};

function makePlannedExecHarness(serialized: SerializedWorld) {
  const clients = new Map<ObjRef, PlannedGatewayClient>();
  const ensureScopes: ObjRef[] = [];
  const submissions: PlannedGatewaySubmission[] = [];
  const clientFor = (scope: ObjRef): PlannedGatewayClient => {
    let client = clients.get(scope);
    if (!client) {
      client = { scope, node: `node:${scope}`, head: scopeHead(scope), serialized };
      clients.set(scope, client);
    }
    return client;
  };

  return {
    ensureScopes,
    submissions,
    options: {
      ensureClient: async (scope: ObjRef) => {
        ensureScopes.push(scope);
        return clientFor(scope);
      },
      clientNode: (client: PlannedGatewayClient) => client.node,
      clientHead: (client: PlannedGatewayClient) => client.head,
      clientSerialized: (client: PlannedGatewayClient) => client.serialized,
      nextTurnId: () => { throw new Error("planned gateway tests use explicit ids"); },
      authorityPayload: (_scope: ObjRef, extraObjectIds: ObjRef[]) => ({
        sessions: [],
        session_objects: [],
        authority: {
          kind: "woo.authority_slice.shadow.v1" as const,
          sessions: [],
          objects: extraObjectIds.map((id, index) => serializedObject(id, id, index))
        }
      }),
      submitEnvelope: async (scope: ObjRef, body: V2TurnGatewayEnvelopeBody) => {
        const envelope = decodeEnvelope<ShadowTurnExecRequest>(body.envelope);
        submissions.push({ scope, body, envelope, request: envelope.body });
        return { reply: encodeEnvelope(replyEnvelope(okReplyForExecRequest(envelope.body))) };
      }
    }
  };
}

function scopeHead(scope: ObjRef, seq = 0): ShadowScopeHead {
  return {
    kind: "woo.scope_head.shadow.v1",
    scope,
    epoch: 1,
    seq,
    hash: `head:${scope}:${seq}`
  };
}

function serializedObject(id: string, name: string, ts: number) {
  return {
    id: id as ObjRef,
    name,
    parent: null,
    owner: "$wiz" as ObjRef,
    location: null,
    anchor: null,
    flags: {},
    created: ts,
    modified: ts,
    propertyDefs: [],
    properties: [],
    propertyVersions: [],
    verbs: [],
    children: [],
    contents: [],
    eventSchemas: []
  };
}

function receipt(accepted: boolean) {
  return {
    kind: "woo.commit_receipt.shadow.v1" as const,
    route: "direct" as const,
    scope: "$room" as ObjRef,
    seq: 1,
    transcript_hash: "t",
    pre_state_hash: "pre",
    post_state_hash: "post",
    accepted,
    errors: []
  };
}

function missingStateReply(id: string): ShadowTurnExecReply {
  return {
    kind: "woo.turn.exec.reply.shadow.v1",
    ok: false,
    id,
    reason: "missing_state"
  };
}

function okReply(id: string): Extract<ShadowTurnExecReply, { ok: true }> {
  return {
    kind: "woo.turn.exec.reply.shadow.v1",
    ok: true,
    id,
    outcome: { result: "ok" },
    transcript: transcript(id)
  };
}

function okReplyForExecRequest(request: ShadowTurnExecRequest): Extract<ShadowTurnExecReply, { ok: true }> {
  const id = request.id ?? "turn";
  return {
    kind: "woo.turn.exec.reply.shadow.v1",
    ok: true,
    id,
    outcome: { result: "ok" },
    transcript: transcriptFromExecRequest(id, request)
  };
}

function replyEnvelope(body: ShadowTurnExecReply): ShadowEnvelope<ShadowTurnExecReply> {
  return {
    v: 2,
    type: body.kind,
    id: `reply:${body.id ?? "unknown"}`,
    from: "relay",
    to: "client",
    actor: "$actor",
    session: "s1",
    auth: { mode: "session", token: "token" },
    body
  };
}

function transcript(id: string): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    id,
    route: "direct",
    scope: "$room",
    seq: 1,
    session: "s1",
    call: { actor: "$actor", target: "$target", verb: "look", args: [] },
    reads: [],
    writes: [],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    result: "ok",
    complete: true,
    incompleteReasons: [],
    hash: `hash:${id}`
  };
}

function transcriptFromExecRequest(id: string, request: ShadowTurnExecRequest): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    id,
    route: request.call.route,
    scope: request.key.scope,
    seq: 1,
    session: request.call.session,
    call: {
      actor: request.call.actor,
      target: request.call.target,
      verb: request.call.verb,
      args: request.call.args
    },
    reads: [],
    writes: [],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    result: "ok",
    complete: true,
    incompleteReasons: [],
    hash: `hash:${id}:${request.key.scope}`
  };
}
