import { describe, expect, it } from "vitest";
import { summarizeWhoCheck, type WhoRosterInput } from "../../scripts/net-canary-load";

// Unit coverage for the pure partial-view summary used by the deployed-canary
// who_all check (net-cutover layering item 6). The LIVE partial view is a
// deploy-only signal (workerd-local collapses every DO into one world image so
// connected_players returns everyone), but the roster-diff LOGIC that turns
// per-shard who replies into a verdict is testable here against synthetic
// replies.

function reply(actor: string, shard: string | null, sees: string[]): WhoRosterInput {
  // A who reply is scanned for guest actor-id substrings; embed the visible
  // set in a JSON-ish haystack the way a real reply's result/observations do.
  return { actor, shard, reachable: true, haystack: JSON.stringify({ roster: sees }) };
}

describe("summarizeWhoCheck (who_all partial-view canary logic)", () => {
  it("is inconclusive with fewer than two guests", () => {
    const out = summarizeWhoCheck(["a"], ["0"], []);
    expect(out.ran).toBe(false);
    expect(out.reason).toMatch(/>=2 guests/);
  });

  it("is inconclusive when every guest landed on one shard", () => {
    const out = summarizeWhoCheck(["a", "b"], ["0", "0"], []);
    expect(out.ran).toBe(false);
    expect(out.reason).toMatch(/single shard/);
    expect(out.distinct_shards).toBe(1);
  });

  it("reports no partial view when every responder sees the full connected set", () => {
    const actors = ["actorA", "actorB", "actorC", "actorD"];
    const shards = ["0", "0", "1", "1"];
    const responders = actors.map((a, i) => reply(a, shards[i], actors));
    const out = summarizeWhoCheck(actors, shards, responders);
    expect(out.ran).toBe(true);
    expect(out.partial).toBe(false);
    expect(out.max_missing).toBe(0);
    expect(out.min_seen).toBe(4);
    expect(out.responders).toBe(4);
    expect(out.distinct_shards).toBe(2);
  });

  it("detects the sharded partial view when each responder sees only its own shard", () => {
    const actors = ["actorA", "actorB", "actorC", "actorD"];
    const shards = ["0", "0", "1", "1"];
    const responders: WhoRosterInput[] = [
      reply("actorA", "0", ["actorA", "actorB"]),
      reply("actorB", "0", ["actorA", "actorB"]),
      reply("actorC", "1", ["actorC", "actorD"]),
      reply("actorD", "1", ["actorC", "actorD"])
    ];
    const out = summarizeWhoCheck(actors, shards, responders);
    expect(out.ran).toBe(true);
    expect(out.partial).toBe(true);
    expect(out.max_missing).toBe(2); // each shard misses the other shard's 2
    expect(out.min_seen).toBe(2);
    expect(out.examples.length).toBeGreaterThan(0);
    expect(out.examples[0].missing.length).toBe(2);
  });

  it("counts a rejected who_all turn as unreachable and flags partial", () => {
    const actors = ["actorA", "actorB"];
    const shards = ["0", "1"];
    const responders: WhoRosterInput[] = [
      reply("actorA", "0", ["actorA", "actorB"]),
      { actor: "actorB", shard: "1", reachable: false, haystack: JSON.stringify({ status: 503 }) }
    ];
    const out = summarizeWhoCheck(actors, shards, responders);
    expect(out.ran).toBe(true);
    expect(out.unreachable).toBe(1);
    expect(out.partial).toBe(true);
    expect(out.responders).toBe(1);
  });
});
