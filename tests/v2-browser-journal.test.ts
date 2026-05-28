import { describe, expect, it } from "vitest";

import type { EffectTranscript } from "../src/core/effect-transcript";
import type { ShadowScopeHead } from "../src/core/shadow-commit-scope";
import {
  selectV2PendingTurnProposals,
  type V2BrowserTurnProposalRecord,
  v2BrowserTurnProposalRecord,
  v2TurnProposalForInvalidation
} from "../src/client/v2-browser-journal";

describe("v2 browser tentative journal", () => {
  it("records explicit proposal dependencies and write cells from the transcript", () => {
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
    expect(proposal.write_cells).toEqual([
      { cell: { kind: "contents", object: "the_pinboard" }, op: "add", prior: "v-contents", next: "v-contents-next" }
    ]);
    expect(proposal.state_probe_cells).toEqual([{ kind: "verb", object: "the_pinboard", name: "add_note" }]);
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
    expect(selected[0]!.write_cells).toEqual([
      { cell: { kind: "contents", object: "the_pinboard" }, op: "add", prior: "v-contents", next: "v-contents-next" }
    ]);
    expect(selected[0]!.state_probe_cells).toEqual([{ kind: "verb", object: "the_pinboard", name: "add_note" }]);
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
});

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
