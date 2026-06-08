import { authoritativePlanningWorld } from "../src/core/planning-world";
import { describe, expect, it } from "vitest";
import { authoritySliceObjectIds, buildSerializedAuthorityCellSlice, cellProvenanceFromAuthoritySlice, serializedWorldFromAuthoritySlice, withAuthorityPageProvenance } from "../src/core/authority-slice";
import { createWorld } from "../src/core/bootstrap";
import type { EffectTranscript } from "../src/core/effect-transcript";
import type { SerializedObject, SerializedSession, SerializedWorld } from "../src/core/repository";
import { decodeEnvelope, encodeEnvelope, type ShadowEnvelope } from "../src/core/shadow-envelope";
import type { ShadowScopeHead } from "../src/core/shadow-commit-scope";
import { runShadowTurnCall } from "../src/core/shadow-turn-call";
import type { ShadowStateTransfer, ShadowTurnExecReply, ShadowTurnExecRequest } from "../src/core/shadow-turn-exec";
import { shadowAtomHash, shadowTurnKeyFromCall } from "../src/core/turn-key";
import {
  mergeExecutorAuthority,
  submitTurnIntent,
  executorAuthorityPayload,
  executorEnvelopeId,
  executorAuthorityObjectIds,
  executorObjectIdsFromMissingState,
  executorReplyNeedsRepair,
  type ExecutorEnvelopeBody
} from "../src/core/executor";
import type { MetricEvent, ObjRef } from "../src/core/types";

describe("v2 turn gateway", () => {
  it("refreshes room contents and support classes in authority slices for stale direct-look scopes", async () => {
    const world = createWorld();
    const session = world.auth("guest:v2-authority-room-contents");
    await world.directCall("authority-look-enter", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });

    const serialized = world.exportWorld();
    serialized.objects = serialized.objects.filter((obj) => !["the_outline", "$outliner"].includes(obj.id));
    const payload = executorAuthorityPayload(world, ["the_chatroom", session.actor]);
    expect(payload.authority.kind).toBe("woo.authority_slice.cells.shadow.v1");
    expect(payload.session_objects).toEqual([]);
    mergeExecutorAuthority(
      serialized,
      payload.authority,
      { clone: true }
    );

    const ids = new Set(serialized.objects.map((obj) => obj.id));
    for (const id of ["the_chatroom", "$room", "$conversational", "the_outline", "$outliner"]) {
      expect(ids.has(id)).toBe(true);
    }

    const look = await runShadowTurnCall(authoritativePlanningWorld(serialized), {
      kind: "woo.turn_call.shadow.v1",
      id: "authority-look-room",
      route: "direct",
      scope: "the_chatroom",
      session: session.id,
      actor: session.actor,
      target: "the_chatroom",
      verb: "look",
      args: []
    });
    expect(look.frame.op).toBe("result");
    if (look.frame.op !== "result") return;
    expect(look.frame.result).toMatchObject({
      id: "the_chatroom",
      contents: expect.arrayContaining([expect.objectContaining({ id: "the_outline" })])
    });

    const lookOutline = await runShadowTurnCall(authoritativePlanningWorld(serialized), {
      kind: "woo.turn_call.shadow.v1",
      id: "authority-look-outline",
      route: "direct",
      scope: "the_chatroom",
      session: session.id,
      actor: session.actor,
      target: "the_chatroom",
      verb: "look_at",
      args: ["the_outline"]
    });
    expect(lookOutline.frame.op).toBe("result");
    if (lookOutline.frame.op !== "result") return;
    expect(lookOutline.frame.result).toMatchObject({ id: "the_outline", summary: "Outline has 0 items." });
  });

  it("classifies only state-repair replies as retryable", () => {
    expect(executorReplyNeedsRepair({
      kind: "woo.turn.exec.reply.shadow.v1",
      ok: false,
      reason: "missing_state"
    })).toBe(true);
    expect(executorReplyNeedsRepair({
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
    expect(executorReplyNeedsRepair(okReply("turn"))).toBe(false);
  });

  it("builds static intent keys from only routing and acceptance atoms", () => {
    const key = shadowTurnKeyFromCall({
      scope: "$room" as ObjRef,
      actor: "$actor" as ObjRef,
      target: "$target" as ObjRef,
      verb: "look"
    });

    expect(key.scope).toBe("$room");
    expect(key.preimages).toEqual([
      "actor:$actor",
      "call:$target:look",
      "scope:$room",
      "target:$target"
    ]);
    expect(key.read_preimages).toEqual([]);
    expect(key.write_preimages).toEqual([]);
    expect(key.accept_preimages).toEqual([
      "call:$target:look",
      "scope:$room",
      "target:$target"
    ]);
  });

  it("extracts object ids from missing-state atom preimages for authority repair", () => {
    expect(executorObjectIdsFromMissingState(missingStateReply("turn", [
      "read:cell:lifecycle:$missing",
      "write:cell:contents:$room",
      "read:cell:prop:$thing.name",
      "read:cell:verb:$tool:use",
      "scope:$scope",
      "call:$target:look"
    ]))).toEqual(["$missing", "$room", "$thing", "$tool", "$scope", "$target"]);
  });

  it("merges versioned authority cells into serialized state without duplicating objects", () => {
    const serialized = {
      sessions: [{ id: "old", actor: "$old" as ObjRef, started: 1, lastDetachAt: null, tokenClass: "guest" as const, activeScope: "$old-room" as ObjRef }],
      objects: [
        serializedObject("$one", "one", 1),
        serializedObject("$two", "two", 1)
      ]
    };
    const authority = buildSerializedAuthorityCellSlice({
      sessions: [{ id: "new", actor: "$actor" as ObjRef, started: 2, lastDetachAt: null, tokenClass: "guest" as const, activeScope: "$room" as ObjRef }],
      objects: [
        { ...serialized.objects[1], name: "two updated", properties: [["value", 2]], propertyVersions: [["value", 2]] },
        serializedObject("$actor", "actor", 3),
        serializedObject("$three", "three", 3)
      ],
      counters: { objectCounter: 44, parkedTaskCounter: 1, sessionCounter: 9 },
      tombstones: ["$gone" as ObjRef],
      pageProvenance: () => ({ source: "authoritative" as const })
    });
    mergeExecutorAuthority(serialized, authority);

    expect(serialized.sessions.map((session) => session.id)).toEqual(["new"]);
    expect(new Map(serialized.objects.map((object) => [object.id, object.name]))).toEqual(new Map([
      ["$actor", "actor"],
      ["$one", "one"],
      ["$two", "two updated"],
      ["$three", "three"]
    ]));
    expect(serialized.objects.find((object) => object.id === "$two")?.properties).toEqual([["value", 2]]);
  });

  it("drops authority session rows whose actor object is absent after merge", () => {
    const serialized = {
      sessions: [{ id: "stale", actor: "$stale_actor" as ObjRef, started: 1, lastDetachAt: null, tokenClass: "guest" as const, activeScope: "$room" as ObjRef }],
      objects: [
        serializedObject("$room", "room", 1),
        serializedObject("$kept_actor", "kept", 1)
      ]
    };
    const authority = buildSerializedAuthorityCellSlice({
      sessions: [
        { id: "stale", actor: "$stale_actor" as ObjRef, started: 1, lastDetachAt: null, tokenClass: "guest" as const, activeScope: "$room" as ObjRef },
        { id: "kept", actor: "$kept_actor" as ObjRef, started: 2, lastDetachAt: null, tokenClass: "guest" as const, activeScope: "$room" as ObjRef }
      ],
      objects: [serializedObject("$room", "room", 2)],
      counters: { objectCounter: 44, parkedTaskCounter: 1, sessionCounter: 9 },
      pageProvenance: () => ({ source: "authoritative" as const })
    });

    mergeExecutorAuthority(serialized, authority);

    expect(serialized.sessions.map((session) => session.id)).toEqual(["kept"]);
  });

  it("does not duplicate legacy object-row authority through session_objects", () => {
    const world = createWorld();
    const session = world.auth("guest:v2-authority-no-session-object-echo");
    const actor = world.exportObjects([session.actor])[0];
    const payload = executorAuthorityPayload({
      exportSessions: () => [session],
      exportAuthoritySlice: (sessions: SerializedSession[]) => ({
        kind: "woo.authority_slice.shadow.v1",
        sessions,
        objects: [actor]
      })
    } as never, [session.actor]);

    expect(payload.authority.kind).toBe("woo.authority_slice.shadow.v1");
    expect(payload.authority).toMatchObject({ objects: [actor] });
    expect(payload.session_objects).toEqual([]);
  });

  it("includes argument and body strings in explicit authority roots", () => {
    expect(executorAuthorityObjectIds({
      scope: "$room" as ObjRef,
      target: "$tool" as ObjRef,
      actor: "$actor" as ObjRef,
      args: ["$arg_obj", ["plain text", "$nested_arg"]],
      body: { selected: "$body_obj", refs: ["$nested_body"] }
    })).toEqual(["$room", "$tool", "$actor", "$arg_obj", "plain text", "$nested_arg", "$body_obj", "$nested_body"]);
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
    expect(authorityObjectIds(submitted.body.authority)).toEqual(["the_dubspace", session.actor, "delay_1"]);
    expect(result.reply?.ok).toBe(true);
  });

  it("repairs non-authoritative room contents before resolving a take target", async () => {
    const owner = createWorld();
    const session = owner.auth("guest:v2-resolution-owner-repair");
    await owner.directCall("resolution-repair-enter", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    expect(owner.contentsOf("the_chatroom")).toContain("the_mug");

    const stale = owner.exportWorld();
    const staleRoom = stale.objects.find((obj) => obj.id === "the_chatroom");
    expect(staleRoom).toBeDefined();
    staleRoom!.contents = staleRoom!.contents
      .filter((id) => id !== "the_mug")
      .concat("guest_999" as ObjRef)
      .sort();
    const projectionAuthority = buildSerializedAuthorityCellSlice({
      sessions: stale.sessions,
      objects: stale.objects,
      counters: {
        objectCounter: stale.objectCounter,
        parkedTaskCounter: stale.parkedTaskCounter,
        sessionCounter: stale.sessionCounter
      },
      tombstones: stale.tombstones,
      pageProvenance: () => ({ source: "projection", source_host: "mcp-gateway-0" })
    });
    const client = {
      scope: "the_chatroom" as ObjRef,
      node: "mcp:test-resolution-repair",
      head: scopeHead("the_chatroom"),
      serialized: serializedWorldFromAuthoritySlice(projectionAuthority),
      cellProvenance: cellProvenanceFromAuthoritySlice(projectionAuthority)
    };
    const authorityCalls: Array<{ ids: ObjRef[]; phase?: string; repair?: boolean }> = [];
    const submissions: ShadowTurnExecRequest[] = [];
    const events: MetricEvent[] = [];

    const result = await submitTurnIntent({
      input: {
        id: "take-mug-repairs-room-contents",
        route: "direct",
        scope: "the_chatroom",
        session: session.id,
        actor: session.actor,
        target: "the_chatroom",
        verb: "take",
        args: ["mug"],
        persistence: "durable",
        token: "token"
      },
      maxAttempts: 3,
      repairPlanningAuthority: true,
      ensureClient: async () => client,
      clientNode: () => client.node,
      clientHead: () => client.head,
      clientSerialized: () => client.serialized,
      clientPlanningProvenance: () => client.cellProvenance,
      enforceMissingProvenance: true,
      enforceResolutionOwnerRepair: true,
      onMetric: (event) => { events.push(event); },
      nextTurnId: () => { throw new Error("test uses explicit id"); },
      authorityPayload: (_scope, extraObjectIds, context) => {
        authorityCalls.push({ ids: [...extraObjectIds], phase: context?.phase, repair: context?.repair });
        const payload = executorAuthorityPayload(owner, extraObjectIds);
        return {
          ...payload,
          authority: withAuthorityPageProvenance(payload.authority, () => ({ source: "authoritative", source_host: "the_chatroom" }))
        };
      },
      applyAuthority: (_client, authority) => {
        mergeExecutorAuthority(client.serialized, authority, { clone: true, cellProvenance: client.cellProvenance });
      },
      submitEnvelope: async (_scope, body) => {
        const envelope = decodeEnvelope<ShadowTurnExecRequest>(body.envelope);
        submissions.push(envelope.body);
        return { reply: encodeEnvelope(replyEnvelope(okReplyForExecRequest(envelope.body))) };
      }
    });

    expect(result.kind).toBe("submitted");
    expect(authorityCalls).toContainEqual(expect.objectContaining({
      phase: "pre_plan",
      repair: true,
      ids: expect.arrayContaining(["the_chatroom"])
    }));
    expect(submissions).toHaveLength(1);
    expect(result.planned?.frame).toMatchObject({
      op: "result",
      result: expect.objectContaining({ item: "the_mug" })
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: "turn_repair_attempt",
      scope: "the_chatroom",
      target: "the_chatroom",
      verb: "take",
      route: "direct",
      attempt: 1,
      source: "planning_throw",
      reason: "missing_state",
      objects: ["the_chatroom"],
      atoms: ["read:cell:contents:the_chatroom"]
    }));
  });

  it("emits a turn_phase_timing metric attributing the turn's phases (Slice 1)", async () => {
    const world = createWorld();
    const session = world.auth("guest:v2-gateway-phase-timing");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const harness = makePlannedExecHarness(world.exportWorld());

    const events: Array<Record<string, unknown>> = [];
    const result = await submitTurnIntent({
      input: {
        id: "phase-timing-set-control",
        route: "sequenced",
        scope: "the_dubspace",
        session: session.id,
        actor: session.actor,
        target: "the_dubspace",
        verb: "set_control",
        args: ["delay_1", "wet", 0.5],
        persistence: "durable",
        token: "token"
      },
      maxAttempts: 1,
      ...harness.options,
      // onMetric is threaded by the gateway in production; assert the executor
      // emits exactly one phase-timing summary per turn with the expected shape.
      onMetric: (event) => events.push(event as Record<string, unknown>)
    });

    expect(result.kind).toBe("submitted");
    const timing = events.filter((e) => e.kind === "turn_phase_timing");
    expect(timing).toHaveLength(1);
    const t = timing[0];
    expect(t).toMatchObject({
      kind: "turn_phase_timing",
      scope: "the_dubspace",
      commit_scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      route: "sequenced",
      attempts: 1,
      outcome: "submitted"
    });
    // Every phase field is present and numeric, and at least one authority
    // payload call (pre-plan + commit) was charged.
    for (const field of ["total_ms", "ensure_client_ms", "authority_ms", "serialize_ms", "plan_build_ms", "vm_ms", "submit_ms"]) {
      expect(typeof t[field]).toBe("number");
      expect(t[field] as number).toBeGreaterThanOrEqual(0);
    }
    expect(t.authority_calls as number).toBeGreaterThanOrEqual(1);
  });

  it("adopts the authority's current head on a stale-head conflict and converges next attempt", async () => {
    // Regression for the prod 8-attempt grind: a fresh commit-scope relay plans
    // against head @0 while the authority is advanced, so every commit
    // stale-head-rejects. The fix adopts the conflict's reported `current` head
    // before retry, so the next attempt submits against the right head instead
    // of burning the whole retry budget.
    const world = createWorld();
    const session = world.auth("guest:v2-gateway-stale-head");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const harness = makePlannedExecHarness(world.exportWorld());

    const authorityCurrentHead = scopeHead("the_dubspace", 5); // authority is at seq 5; relay starts at @0
    let submitCount = 0;

    const result = await submitTurnIntent({
      input: {
        id: "stale-head-turn",
        route: "sequenced",
        scope: "the_dubspace",
        session: session.id,
        actor: session.actor,
        target: "the_dubspace",
        verb: "set_control",
        args: ["delay_1", "wet", 0.3],
        persistence: "durable",
        token: "token"
      },
      maxAttempts: 8,
      ...harness.options,
      applyHead: (client: PlannedGatewayClient, head: ShadowScopeHead) => { client.head = head; },
      submitEnvelope: async (scope: ObjRef, body: ExecutorEnvelopeBody) => {
        const envelope = decodeEnvelope<ShadowTurnExecRequest>(body.envelope);
        harness.submissions.push({ scope, body, envelope, request: envelope.body });
        submitCount += 1;
        if (submitCount === 1) {
          // First attempt planned against the relay's stale @0 head.
          return { reply: encodeEnvelope(replyEnvelope({
            kind: "woo.turn.exec.reply.shadow.v1",
            ok: false,
            id: envelope.body.id,
            reason: "commit_rejected",
            commit: {
              kind: "woo.commit.conflict.shadow.v1",
              id: envelope.body.id ?? "turn",
              scope: "the_dubspace",
              current: authorityCurrentHead,
              reason: "stale_head",
              errors: ["stale_head: expected=h@0 current=head:the_dubspace:5@5"],
              receipt: receipt(false)
            }
          })) };
        }
        return { reply: encodeEnvelope(replyEnvelope(okReplyForExecRequest(envelope.body))) };
      }
    });

    expect(result.kind).toBe("submitted");
    // Converged on the SECOND attempt, not the 8-attempt ceiling.
    expect(submitCount).toBe(2);
    // The second submission must carry the adopted current head as `expected`.
    const second = harness.submissions[1];
    expect(second.request.expected).toBeDefined();
    expect(second.request.expected?.seq).toBe(5);
    expect(second.request.expected?.hash).toBe(authorityCurrentHead.hash);
  });

  it("installs a read-version-mismatch repair transfer and converges on the next attempt", async () => {
    // DESIGN A layer-2: a read-version-mismatch conflict carries a cell-page
    // transfer of the committing scope's CURRENT mismatched cells. submitTurnIntent
    // must install it (applyStateTransfer) before re-plan so the caller refreshes
    // its stale cells (e.g. a self-certified actor stub) and converges — instead
    // of re-submitting the same stale rows and grinding the retry budget.
    const world = createWorld();
    const session = world.auth("guest:v2-gateway-version-mismatch");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const harness = makePlannedExecHarness(world.exportWorld());

    // Minimal transfer; the executor only checks presence and forwards it to
    // applyStateTransfer (the relay-cache install is exercised by integration/
    // worker tests). Cast avoids constructing the full cell-page envelope here.
    const repairTransfer = {
      kind: "woo.state.transfer.shadow.v1",
      mode: "cell_pages",
      scope: "the_dubspace",
      purpose: "version_mismatch_repair_cells"
    } as unknown as ShadowStateTransfer;
    const installed: ShadowStateTransfer[] = [];
    let submitCount = 0;

    const result = await submitTurnIntent({
      input: {
        id: "version-mismatch-turn",
        route: "sequenced",
        scope: "the_dubspace",
        session: session.id,
        actor: session.actor,
        target: "the_dubspace",
        verb: "set_control",
        args: ["delay_1", "wet", 0.6],
        persistence: "durable",
        token: "token"
      },
      maxAttempts: 8,
      ...harness.options,
      applyStateTransfer: (_client: PlannedGatewayClient, transfer: ShadowStateTransfer) => { installed.push(transfer); },
      submitEnvelope: async (scope: ObjRef, body: ExecutorEnvelopeBody) => {
        const envelope = decodeEnvelope<ShadowTurnExecRequest>(body.envelope);
        harness.submissions.push({ scope, body, envelope, request: envelope.body });
        submitCount += 1;
        if (submitCount === 1) {
          return { reply: encodeEnvelope(replyEnvelope({
            kind: "woo.turn.exec.reply.shadow.v1",
            ok: false,
            id: envelope.body.id,
            reason: "commit_rejected",
            commit: {
              kind: "woo.commit.conflict.shadow.v1",
              id: envelope.body.id ?? "turn",
              scope: "the_dubspace",
              current: scopeHead("the_dubspace", 3),
              reason: "read_version_mismatch",
              errors: ["read version mismatch delay_1.wet: transcript=0 actual=1"],
              receipt: receipt(false)
            },
            state_transfer: repairTransfer
          })) };
        }
        return { reply: encodeEnvelope(replyEnvelope(okReplyForExecRequest(envelope.body))) };
      }
    });

    expect(result.kind).toBe("submitted");
    expect(submitCount).toBe(2); // converged after one repair, not the 8-attempt ceiling
    expect(installed).toHaveLength(1);
    // The transfer round-trips through the reply envelope, so compare by value.
    expect(installed[0]).toEqual(repairTransfer);
  });

  it("charges a throwing phase and still emits turn_phase_timing with error outcome", async () => {
    // Regression: phase timers must record elapsed even when the awaited phase
    // THROWS, or the failure-path diagnosis this metric exists for under-reports
    // exactly the phase that broke. Here submitEnvelope spends time then throws;
    // the turn_phase_timing must still emit (finally) with submit_ms charged and
    // outcome "error".
    const world = createWorld();
    const session = world.auth("guest:v2-gateway-throwing-phase");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const harness = makePlannedExecHarness(world.exportWorld());

    const events: Array<Record<string, unknown>> = [];
    await expect(submitTurnIntent({
      input: {
        id: "throwing-submit-turn",
        route: "sequenced",
        scope: "the_dubspace",
        session: session.id,
        actor: session.actor,
        target: "the_dubspace",
        verb: "set_control",
        args: ["delay_1", "wet", 0.4],
        persistence: "durable",
        token: "token"
      },
      maxAttempts: 1,
      ...harness.options,
      onMetric: (event) => events.push(event as Record<string, unknown>),
      submitEnvelope: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        throw new Error("submit boom");
      }
    })).rejects.toThrow("submit boom");

    const timing = events.filter((e) => e.kind === "turn_phase_timing");
    expect(timing).toHaveLength(1);
    expect(timing[0]!.outcome).toBe("error");
    // The throwing submit phase is charged, not left at 0.
    expect(timing[0]!.submit_ms as number).toBeGreaterThan(0);
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
    expect(authorityObjectIds(submitted.body.authority)).toEqual([
      "the_dubspace",
      "the_chatroom",
      session.actor
    ]);
    expect(result.reply?.ok).toBe(true);
  });

  it("routes planned movement to the moved object's location authority", async () => {
    const world = createWorld();
    const session = world.auth("guest:v2-placement-planned");
    const entered = await world.call("placement-enter", session.id, "the_chatroom", {
      actor: session.actor,
      target: "the_chatroom",
      verb: "enter",
      args: []
    });
    expect(entered.op).toBe("applied");
    const harness = makePlannedExecHarness(world.exportWorld());

    const result = await submitTurnIntent({
      input: {
        id: "planned-placement-southeast",
        route: "sequenced",
        scope: "the_chatroom",
        session: session.id,
        actor: session.actor,
        target: "the_chatroom",
        verb: "southeast",
        args: [],
        persistence: "durable",
        token: "token"
      },
      maxAttempts: 1,
      ...harness.options
    });

    expect(result.kind).toBe("submitted");
    if (result.kind !== "submitted") throw new Error("expected planned submission");
    expect(result.scope).toBe("the_chatroom");
    expect(result.commitScope).toBe(session.actor);
    expect(harness.ensureScopes).toEqual(["the_chatroom", session.actor]);
    expect(harness.submissions).toHaveLength(1);
    const submitted = harness.submissions[0];
    expect(submitted.scope).toBe(session.actor);
    expect(submitted.body.scope).toBe(session.actor);
    expect(submitted.body.node).toBe(`node:${session.actor}`);
    expect(submitted.request.key.scope).toBe("the_chatroom");
    expect(submitted.request.expected).toEqual(scopeHead(session.actor));
    expect(harness.authorityRequests.at(-1)).toEqual(expect.arrayContaining([
      session.actor,
      "the_chatroom",
      "the_deck"
    ]));
    expect(authorityObjectIds(submitted.body.authority)).toEqual(expect.arrayContaining([
      "the_chatroom",
      "the_deck",
      session.actor
    ]));
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
  body: ExecutorEnvelopeBody;
  envelope: ShadowEnvelope<ShadowTurnExecRequest>;
  request: ShadowTurnExecRequest;
};

function makePlannedExecHarness(serialized: SerializedWorld) {
  const clients = new Map<ObjRef, PlannedGatewayClient>();
  const ensureScopes: ObjRef[] = [];
  const submissions: PlannedGatewaySubmission[] = [];
  const authorityRequests: ObjRef[][] = [];
  const knownObjectIds = new Set(serialized.objects.map((obj) => obj.id));
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
    authorityRequests,
    options: {
      ensureClient: async (scope: ObjRef) => {
        ensureScopes.push(scope);
        return clientFor(scope);
      },
      clientNode: (client: PlannedGatewayClient) => client.node,
      clientHead: (client: PlannedGatewayClient) => client.head,
      clientSerialized: (client: PlannedGatewayClient) => client.serialized,
      nextTurnId: () => { throw new Error("planned gateway tests use explicit ids"); },
      authorityPayload: (_scope: ObjRef, extraObjectIds: ObjRef[]) => {
        authorityRequests.push(extraObjectIds);
        return {
          sessions: [],
          session_objects: [],
          authority: {
            kind: "woo.authority_slice.shadow.v1" as const,
            sessions: [],
            objects: extraObjectIds
              .filter((id) => knownObjectIds.has(id))
              .map((id, index) => serializedObject(id, id, index))
          }
        };
      },
      submitEnvelope: async (scope: ObjRef, body: ExecutorEnvelopeBody) => {
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

function serializedObject(id: string, name: string, ts: number): SerializedObject {
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

function authorityObjectIds(authority: ExecutorEnvelopeBody["authority"]): ObjRef[] {
  return Array.from(authoritySliceObjectIds(authority));
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

function missingStateReply(id: string, missingPreimages: string[] = []): ShadowTurnExecReply {
  return {
    kind: "woo.turn.exec.reply.shadow.v1",
    ok: false,
    id,
    reason: "missing_state",
    ...(missingPreimages.length > 0 ? {
      missing_atoms: missingPreimages.map((preimage) => ({ hash: shadowAtomHash(preimage), preimage }))
    } : {})
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
