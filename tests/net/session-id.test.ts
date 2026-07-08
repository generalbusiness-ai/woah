// Phase 6 — session-id shard hint (ready-to-scale plan): a session id
// minted on any shard must resolve back to that shard after /net-api
// gains shards, without breaking the `:`-delimited cell-key parse or the
// id's own `_`-delimited parse.
import { describe, expect, it } from "vitest";
import { sessionIdWithShardHint, sessionShardHint } from "../../src/net/session-id";
import { sessionCellKey } from "../../src/net/sessions";

describe("session-id shard hint (Phase 6)", () => {
  it("roundtrips the minting shard", () => {
    const id = sessionIdWithShardHint("net-api", "abc123");
    expect(id).toBe("s_net-api_abc123");
    expect(sessionShardHint(id)).toBe("net-api");
  });

  it("null shard mints the hint-less legacy form, which parses to null (default shard)", () => {
    const id = sessionIdWithShardHint(null, "abc123");
    expect(id).toBe("s_abc123");
    expect(sessionShardHint(id)).toBeNull();
    // Pre-hint ids already in the wild behave the same way.
    expect(sessionShardHint("s_0123456789abcdef")).toBeNull();
  });

  it("sanitizes delimiter-hostile shard names: ':' (cell keys) and '_' (the id parse) never enter the id", () => {
    const id = sessionIdWithShardHint("gateway:net_api.2", "abc123");
    expect(id).toBe("s_gateway-net-api-2_abc123");
    expect(id).not.toContain(":");
    expect(id.split("_")).toHaveLength(3);
    expect(sessionShardHint(id)).toBe("gateway-net-api-2");
  });

  it("malformed ids parse to null rather than a wrong shard", () => {
    expect(sessionShardHint("")).toBeNull();
    expect(sessionShardHint("wst_abc_def")).toBeNull(); // ws ticket, not a session
    expect(sessionShardHint("s__abc")).toBeNull(); // empty hint token
    expect(sessionShardHint("s_a_b_c")).toBeNull(); // four tokens: not the minted shape
  });

  it("a hinted id survives the `:`-delimited cell-key parse (objectOfCellKey's contract)", () => {
    const id = sessionIdWithShardHint("net-api", "abc123");
    const key = sessionCellKey(id);
    expect(key).toBe(`session:${id}`);
    // The gateway's objectOfCellKey rule: `<kind>:<object>[:<name>]` —
    // object ids never contain ':', so split(':')[1] recovers the id.
    expect(key.split(":")[1]).toBe(id);
  });
});
