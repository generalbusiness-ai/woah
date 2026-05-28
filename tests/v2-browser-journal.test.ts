import { describe, expect, it } from "vitest";

import type { EffectTranscript } from "../src/core/effect-transcript";
import type { ShadowScopeHead } from "../src/core/shadow-commit-scope";
import {
  selectV2PendingTurnProposals,
  type V2BrowserTurnProposalRecord,
  v2BrowserTurnProposalRecord,
  v2ProposalProjectionOverlayForTranscript,
  v2ReconcileTurnProposalsWithAcceptedFrame,
  v2TranscriptSupportsProposalProjectionOverlay,
  v2TurnProposalAcceptedFrameMatch,
  v2TurnProposalForInvalidation,
  v2TurnProposalNeedsReplanAfterTranscript,
  v2TurnProposalNeedsReplanRecord
} from "../src/client/v2-browser-journal";

describe("v2 browser tentative journal", () => {
  it("records explicit proposal dependencies from the transcript", () => {
    const proposal = v2BrowserTurnProposalRecord({
      id: "turn-proposal",
      scope: "the_pinboard",
      actor: "guest_1",
      session: "session-1",
      base_head: head(),
      transcript: transcript("turn-proposal", "hash-proposal"),
      predicted_overlay: {
        kind: "woo.proposal_projection_overlay.v1",
        id: "turn-proposal",
        scope: "the_pinboard",
        result_known: true,
        authoritative_projection: false
      },
      created_at: 1
    });

    expect(proposal).toMatchObject({
      kind: "woo.turn_proposal.v1",
      id: "turn-proposal",
      transcript_hash: "hash-proposal",
      status: "pending",
      predicted_overlay: {
        kind: "woo.proposal_projection_overlay.v1",
        authoritative_projection: false
      }
    });
    expect(proposal.depends_on).toEqual([
      { cell: { kind: "prop", object: "the_pinboard", name: "title" }, version: "v-title" },
      { cell: { kind: "verb", object: "the_pinboard", name: "add_note" } }
    ]);
  });

  it("creates proposal projection overlays only for locally bounded transcripts", () => {
    const localWrite = transcript("local-write", "hash-local-write");
    const localCreate = {
      ...transcript("local-create", "hash-local-create"),
      moves: [{
        object: "pin_note_1",
        from: null,
        to: "the_pinboard"
      }]
    };
    const crossScopeMove = {
      ...transcript("cross-scope", "hash-cross-scope"),
      moves: [{
        object: "guest_1",
        from: "the_chatroom",
        to: "the_pinboard"
      }]
    };
    const untracked = {
      ...transcript("untracked", "hash-untracked"),
      untrackedEffects: [{ name: "side_channel", detail: null }]
    };

    expect(v2ProposalProjectionOverlayForTranscript({
      id: "local-write",
      scope: "the_pinboard",
      transcript: localWrite,
      result_known: true
    })).toMatchObject({
      kind: "woo.proposal_projection_overlay.v1",
      authoritative_projection: false
    });
    expect(v2TranscriptSupportsProposalProjectionOverlay(localCreate, "the_pinboard")).toBe(true);
    expect(v2TranscriptSupportsProposalProjectionOverlay(crossScopeMove, "the_pinboard")).toBe(false);
    expect(v2ProposalProjectionOverlayForTranscript({
      id: "untracked",
      scope: "the_pinboard",
      transcript: untracked,
      result_known: true
    })).toBeNull();
  });

  it("normalizes legacy tentative rows into proposal records on read", () => {
    const legacy = {
      id: "legacy-turn",
      scope: "the_pinboard",
      actor: "guest_1",
      session: "session-1",
      base_head: head(),
      transcript_hash: "legacy-hash",
      transcript: transcript("legacy-turn", "legacy-hash"),
      status: "pending",
      created_at: 1
    } as unknown as V2BrowserTurnProposalRecord;

    const selected = selectV2PendingTurnProposals([legacy], {
      scope: "the_pinboard",
      actor: "guest_1",
      session: "session-1"
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      kind: "woo.turn_proposal.v1",
      id: "legacy-turn",
      transcript_hash: "legacy-hash",
      predicted_overlay: null,
      status: "pending"
    });
    expect(selected[0]!.depends_on).toEqual([
      { cell: { kind: "prop", object: "the_pinboard", name: "title" }, version: "v-title" },
      { cell: { kind: "verb", object: "the_pinboard", name: "add_note" } }
    ]);
  });

  it("invalidates only the directly rejected Phase 1 tentative", () => {
    const first = v2BrowserTurnProposalRecord({
      id: "turn-a",
      scope: "the_pinboard",
      actor: "guest_1",
      session: "session-1",
      base_head: head(),
      transcript: transcript("turn-a", "hash-a"),
      created_at: 1
    });
    const dependent = v2BrowserTurnProposalRecord({
      id: "turn-b",
      scope: "the_pinboard",
      actor: "guest_1",
      session: "session-1",
      base_head: head(),
      transcript: transcript("turn-b", "hash-b"),
      created_at: 2
    });

    expect(v2TurnProposalForInvalidation([first, dependent], ["turn-a"])?.id).toBe("turn-a");
    expect(v2TurnProposalForInvalidation([first, dependent], ["reply"], "hash-b")?.id).toBe("turn-b");
  });

  it("matches accepted frames by hash before falling back to turn id", () => {
    const proposal = v2BrowserTurnProposalRecord({
      id: "turn-a",
      scope: "the_pinboard",
      actor: "guest_1",
      session: "session-1",
      base_head: head(),
      transcript: transcript("turn-a", "hash-a"),
      created_at: 1
    });

    expect(v2TurnProposalAcceptedFrameMatch(proposal, { id: "other", transcript_hash: "hash-a" })).toBe("hash");
    expect(v2TurnProposalAcceptedFrameMatch(proposal, { id: "turn-a", transcript_hash: "server-rerun" })).toBe("id");
    expect(v2TurnProposalAcceptedFrameMatch(proposal, { id: "other", transcript_hash: "server-rerun" })).toBeNull();
  });

  it("marks proposals for replan when an accepted transcript touches dependencies", () => {
    const proposal = v2BrowserTurnProposalRecord({
      id: "turn-b",
      scope: "the_pinboard",
      actor: "guest_1",
      session: "session-1",
      base_head: head(),
      transcript: transcript("turn-b", "hash-b"),
      created_at: 2
    });
    const changedRead = {
      ...transcript("remote", "hash-remote"),
      reads: [],
      stateProbes: [],
      writes: [{
        cell: { kind: "prop" as const, object: "the_pinboard", name: "title" },
        value: "New title",
        op: "set" as const,
        prior: "v-title",
        next: "v-title-next"
      }]
    };
    const independent = {
      ...changedRead,
      writes: [{
        cell: { kind: "prop" as const, object: "other_object", name: "title" },
        value: "Other",
        op: "set" as const,
        prior: "v-other",
        next: "v-other-next"
      }]
    };

    expect(v2TurnProposalNeedsReplanAfterTranscript(proposal, changedRead)).toBe(true);
    expect(v2TurnProposalNeedsReplanAfterTranscript(proposal, independent)).toBe(false);
    expect(selectV2PendingTurnProposals([v2TurnProposalNeedsReplanRecord(proposal)], {
      scope: "the_pinboard",
      actor: "guest_1",
      session: "session-1"
    })).toEqual([]);
  });

  it("promotes hash-matched proposals from frame-only acceptance and replans only independent stale reads", () => {
    const first = v2BrowserTurnProposalRecord({
      id: "turn-a",
      scope: "the_pinboard",
      actor: "guest_1",
      session: "session-1",
      base_head: head(),
      transcript: transcript("turn-a", "hash-a"),
      created_at: 1
    });
    const dependent = v2BrowserTurnProposalRecord({
      id: "turn-b",
      scope: "the_pinboard",
      actor: "guest_1",
      session: "session-1",
      base_head: head(),
      transcript: transcript("turn-b", "hash-b"),
      created_at: 2
    });
    const frame = { id: "turn-a", position: { ...head(), seq: 1 }, transcript_hash: "hash-a" };

    expect(v2ReconcileTurnProposalsWithAcceptedFrame([first, dependent], selector(), frame)).toMatchObject({
      matched: [{ id: "turn-a" }],
      promote: [{ id: "turn-a" }],
      replan: []
    });

    const remote = {
      ...transcript("remote", "hash-remote"),
      reads: [],
      stateProbes: [],
      writes: [{
        cell: { kind: "prop" as const, object: "the_pinboard", name: "title" },
        value: "Remote title",
        op: "set" as const,
        prior: "v-title",
        next: "v-title-next"
      }]
    };
    expect(v2ReconcileTurnProposalsWithAcceptedFrame([first, dependent], selector(), {
      id: "remote",
      position: { ...head(), seq: 1 },
      transcript_hash: "hash-remote"
    }, remote)).toMatchObject({
      matched: [],
      promote: [],
      replan: [{ id: "turn-a" }, { id: "turn-b" }]
    });
  });
});

function selector() {
  return {
    scope: "the_pinboard",
    actor: "guest_1",
    session: "session-1"
  };
}

function head(): ShadowScopeHead {
  return {
    kind: "woo.scope_head.shadow.v1",
    scope: "the_pinboard",
    epoch: 1,
    seq: 0,
    hash: "head"
  };
}

function transcript(id: string, hash: string): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    id,
    route: "sequenced",
    scope: "the_pinboard",
    seq: 0,
    session: "session-1",
    call: {
      actor: "guest_1",
      target: "the_pinboard",
      verb: "noop",
      args: [],
      body: undefined
    },
    reads: [{
      cell: { kind: "prop", object: "the_pinboard", name: "title" },
      version: "v-title",
      value: "Pinboard"
    }],
    stateProbes: [{ kind: "verb", object: "the_pinboard", name: "add_note" }],
    writes: [{
      cell: { kind: "contents", object: "the_pinboard" },
      prior: "v-contents",
      next: "v-contents-next",
      value: ["note_1"],
      op: "add"
    }],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash
  };
}
