import { describe, expect, it } from "vitest";
import { v2AppliedFrameMessageFromFrame, v2ProjectionMessageFromRow, v2ProjectionSnapshotFromMessage, v2TurnResultMessageFromReply, v2TurnResultRoute } from "../src/client/v2-browser-messages";

describe("v2 browser worker messages", () => {
  it("builds projection messages only from well-shaped cached rows", () => {
    const row = {
      scope: "#room",
      head: {
        kind: "woo.scope_head.shadow.v1",
        scope: "#room",
        epoch: 1,
        seq: 3,
        hash: "head-3"
      },
      projection: {
        kind: "woo.scope_projection.shadow.v1",
        scope: "#room",
        contents: [],
        cursor: { spaces: { "#room": { next_seq: 4 } } },
        subject: { id: "#room", name: "Room" },
        objects: [{ id: "#room", name: "Room" }, { id: "#note", name: "Note" }, "bad"]
      }
    };

    expect(v2ProjectionMessageFromRow(row, { cached: true })).toEqual({
      kind: "projection",
      scope: "#room",
      head: row.head,
      projection: row.projection,
      cached: true
    });
    expect(v2ProjectionMessageFromRow({ ...row, head: { seq: "3" } })).toBeUndefined();
    expect(v2ProjectionMessageFromRow({ ...row, scope: 123 })).toBeUndefined();
  });

  it("extracts catalog-neutral objects from v2 projection messages", () => {
    const message = v2ProjectionMessageFromRow({
      scope: "#room",
      head: {
        kind: "woo.scope_head.shadow.v1",
        scope: "#room",
        epoch: 1,
        seq: 3,
        hash: "head-3"
      },
      projection: {
        kind: "woo.scope_projection.shadow.v1",
        scope: "#room",
        cursor: { spaces: { "#room": { next_seq: 4 } } },
        subject: { id: "#room", name: "Room" },
        objects: [{ id: "#room", name: "Room" }, { id: "#note", name: "Note" }, { name: "missing id" }]
      }
    });

    expect(message).toBeDefined();
    expect(message ? v2ProjectionSnapshotFromMessage(message) : undefined).toEqual({
      scope: "#room",
      cursor: { spaces: { "#room": { next_seq: 4 } } },
      subject: { id: "#room", name: "Room" },
      objects: [{ id: "#room", name: "Room" }, { id: "#note", name: "Note" }]
    });
  });

  it("builds typed applied-frame worker messages", () => {
    const frame = {
      kind: "woo.commit.accepted.shadow.v1",
      id: "accepted-1",
      position: {
        kind: "woo.scope_head.shadow.v1",
        scope: "#room",
        epoch: 1,
        seq: 7,
        hash: "head-7"
      },
      expected: {
        kind: "woo.scope_head.shadow.v1",
        scope: "#room",
        epoch: 1,
        seq: 6,
        hash: "head-6"
      },
      transcript_hash: "transcript-7",
      post_state_hash: "post-7",
      receipt: { ok: true, writes: [] },
      observations: []
    } as any;

    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      id: "accepted-1",
      route: { kind: "local" },
      scope: "#room",
      seq: 7,
      call: { actor: "#actor", target: "#room", verb: "say", args: ["hi"] },
      reads: [],
      writes: [],
      creates: [],
      moves: [],
      observations: [{ type: "said", text: "hi" }],
      logicalInputs: [],
      untrackedEffects: [],
      result: { ok: true },
      complete: true,
      incompleteReasons: [],
      hash: "transcript-7"
    } as any;

    expect(v2AppliedFrameMessageFromFrame(frame, transcript)).toEqual({
      kind: "applied_frame",
      scope: "#room",
      seq: 7,
      frame,
      transcript,
      applied: {
        op: "applied",
        id: "accepted-1",
        space: "#room",
        seq: 7,
        ts: 0,
        message: { actor: "#actor", target: "#room", verb: "say", args: ["hi"] },
        observations: [{ type: "said", text: "hi" }],
        result: { ok: true }
      }
    });
  });

  it("converts non-committing v2 replies into direct result frames", () => {
    const reply = {
      kind: "woo.turn.exec.reply.shadow.v1",
      ok: true,
      id: "preview-1",
      outcome: { result: 0.42 },
      transcript: {
        kind: "woo.effect_transcript.shadow.v1",
        id: "preview-1",
        route: "direct",
        scope: "#room",
        seq: 0,
        call: { actor: "#actor", target: "#room", verb: "preview_control", args: ["#delay", "wet", 0.42] },
        reads: [],
        writes: [],
        creates: [],
        moves: [],
        observations: [{ type: "gesture_progress", target: "#delay", name: "wet", value: 0.42 }],
        logicalInputs: [],
        untrackedEffects: [],
        result: 0.42,
        complete: true,
        incompleteReasons: [],
        hash: "transcript-preview"
      }
    } as any;

    expect(v2TurnResultMessageFromReply(reply, "preview-envelope")).toEqual({
      kind: "turn_result",
      frame: {
        op: "result",
        id: "preview-1",
        command: { actor: "#actor", target: "#room", verb: "preview_control", args: ["#delay", "wet", 0.42] },
        result: 0.42,
        observations: [{ type: "gesture_progress", target: "#delay", name: "wet", value: 0.42 }],
        audience: null
      }
    });
  });

  it("routes optimistic error frames separately from final errors", () => {
    expect(v2TurnResultRoute({
      kind: "turn_result",
      optimistic: true,
      frame: {
        op: "error",
        id: "drop-1",
        error: { code: "E_OBJNF", message: "object not found: the_towel" }
      }
    })).toBe("optimistic_error");

    expect(v2TurnResultRoute({
      kind: "turn_result",
      frame: {
        op: "error",
        id: "drop-1",
        error: { code: "E_OBJNF", message: "object not found: the_towel" }
      }
    })).toBe("final_error");

    expect(v2TurnResultRoute({
      kind: "turn_result",
      optimistic: true,
      frame: {
        op: "result",
        id: "drop-1",
        command: { actor: "me", target: "the_towel", verb: "drop", args: [] },
        result: null,
        observations: [],
        audience: null
      }
    })).toBe("optimistic_result");
  });
});
