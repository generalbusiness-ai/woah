import { describe, expect, it } from "vitest";

import type { EffectTranscript } from "../src/core/effect-transcript";
import type { ShadowScopeHead } from "../src/core/shadow-commit-scope";
import {
  v2BrowserTentativeTurnRecord,
  v2TentativeTurnForInvalidation
} from "../src/client/v2-browser-journal";

describe("v2 browser tentative journal", () => {
  it("invalidates only the directly rejected Phase 1 tentative", () => {
    const first = v2BrowserTentativeTurnRecord({
      id: "turn-a",
      scope: "the_pinboard",
      actor: "guest_1",
      session: "session-1",
      base_head: head(),
      transcript: transcript("turn-a", "hash-a"),
      created_at: 1
    });
    const dependent = v2BrowserTentativeTurnRecord({
      id: "turn-b",
      scope: "the_pinboard",
      actor: "guest_1",
      session: "session-1",
      base_head: head(),
      transcript: transcript("turn-b", "hash-b"),
      created_at: 2
    });

    expect(v2TentativeTurnForInvalidation([first, dependent], ["turn-a"])?.id).toBe("turn-a");
    expect(v2TentativeTurnForInvalidation([first, dependent], ["reply"], "hash-b")?.id).toBe("turn-b");
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
    reads: [],
    writes: [],
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
