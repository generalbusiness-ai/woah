// Commit-scope selection — CA3 ride-along, B6 write-set rule,
// E_SCOPE_SPLIT (coherence.md CO2.3).
import { describe, expect, it } from "vitest";
import { isNetError } from "../../src/net/errors";
import { selectCommitScope, type ScopeClassifier } from "../../src/net/route";
import type { EffectTranscript } from "../../src/net/transcript";

// World shape: rooms are shared scopes; each actor is its own cluster and
// carries its items (actor-anchored, CA6).
const HOMES: Record<string, string> = {
  "#roomA-door": "roomA",
  "#roomB-sign": "roomB",
  "#alice": "cluster:alice",
  "#alice-bag": "cluster:alice",
  "#bob": "cluster:bob"
};
const classifier: ScopeClassifier = {
  scopeOf: (object) => HOMES[object] ?? "roomA",
  isShared: (scope) => scope.startsWith("room")
};

function t(partial: Partial<EffectTranscript>): EffectTranscript {
  return { writes: [], creates: [], moves: [], ...partial } as EffectTranscript;
}

const WRITER = { progr: "#alice", thisObj: "#alice", verb: "v", definer: "$thing", caller: "#alice", callerPerms: "#alice" };

describe("selectCommitScope (CO2.3)", () => {
  it("read-only turns commit at the planning scope", () => {
    expect(selectCommitScope(t({}), "roomA", classifier)).toEqual({ scope: "roomA", riders: [] });
  });

  it("pure movement commits at the moved object's home, off the room sequencer (CA3)", () => {
    const sel = selectCommitScope(t({ moves: [{ object: "#alice", from: "roomA", to: "roomB" }] }), "roomA", classifier);
    expect(sel).toEqual({ scope: "cluster:alice", riders: [] });
  });

  it("room-writing movement commits at the shared scope; the location write rides along (CA3 ride-along)", () => {
    const sel = selectCommitScope(t({
      moves: [{ object: "#alice", from: "roomA", to: "roomA" }],
      writes: [{ cell: { kind: "prop", object: "#roomA-door", name: "arrivals" }, value: 1 as never, op: "set", writer: WRITER }]
    }), "roomA", classifier);
    expect(sel).toEqual({ scope: "roomA", riders: ["cluster:alice"] });
  });

  it("a single foreign shared scope serializes its own cell", () => {
    const sel = selectCommitScope(t({
      writes: [{ cell: { kind: "prop", object: "#roomB-sign", name: "text" }, value: "hi" as never, op: "set", writer: WRITER }],
      moves: [{ object: "#alice", from: "roomA", to: "roomB" }]
    }), "roomA", classifier);
    expect(sel).toEqual({ scope: "roomB", riders: ["cluster:alice"] });
  });

  it("cross-cluster give with no shared writes rides along at the planning scope (B6)", () => {
    const sel = selectCommitScope(t({
      moves: [{ object: "#alice-bag", from: "#alice", to: "#bob" }],
      writes: [{ cell: { kind: "prop", object: "#bob", name: "received" }, value: 1 as never, op: "set", writer: WRITER }]
    }), "roomA", classifier);
    expect(sel).toEqual({ scope: "roomA", riders: ["cluster:alice", "cluster:bob"] });
  });

  it("contents writes never influence scope selection (CA4: projection)", () => {
    const sel = selectCommitScope(t({
      writes: [{ cell: { kind: "contents", object: "#roomB-sign" }, value: [] as never, op: "add", writer: WRITER }]
    }), "roomA", classifier);
    expect(sel).toEqual({ scope: "roomA", riders: [] });
  });

  it("two distinct shared scopes reject E_SCOPE_SPLIT (terminal, named)", () => {
    try {
      selectCommitScope(t({
        writes: [
          { cell: { kind: "prop", object: "#roomA-door", name: "a" }, value: 1 as never, op: "set", writer: WRITER },
          { cell: { kind: "prop", object: "#roomB-sign", name: "b" }, value: 2 as never, op: "set", writer: WRITER }
        ]
      }), "roomA", classifier);
      expect.unreachable("must throw E_SCOPE_SPLIT");
    } catch (err) {
      expect(isNetError(err) && err.code === "E_SCOPE_SPLIT").toBe(true);
      if (isNetError(err)) expect(err.detail.shared).toEqual(["roomA", "roomB"]);
    }
  });

  it("anchored creates land at their anchor's scope", () => {
    const sel = selectCommitScope(t({
      creates: [{ object: "#new", name: "n", parent: "$thing", owner: "#alice", anchor: "#alice", location: null, flags: {} }]
    }), "roomA", classifier);
    expect(sel).toEqual({ scope: "cluster:alice", riders: [] });
  });
});
