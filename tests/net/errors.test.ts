// CO6 divergence taxonomy — the error surface of src/net/ is a closed enum
// with defined recovery semantics (spec/protocol/coherence.md CO6, CO12.7).
import { describe, expect, it } from "vitest";
import {
  budgetExhausted,
  isNetError,
  isRetryable,
  NET_ERROR_RECOVERY,
  netError,
  nonconvergentRead,
  type NetErrorCode
} from "../../src/net/errors";

const ALL_CODES: NetErrorCode[] = [
  "E_STALE_HEAD",
  "E_STALE_EPOCH",
  "E_MISSING_STATE",
  "E_READ_VERSION",
  "E_SCOPE_SPLIT",
  "E_CATALOG_MUTATION",
  "E_LINEAGE",
  "E_BUDGET",
  "E_NONCONVERGENT_READ",
  "E_RPC_TIMEOUT",
  "E_SEED_LAG",
  "E_EPOCH_MISMATCH",
  "E_SEED_COMMITTED"
];

describe("net divergence taxonomy (CO6)", () => {
  it("every code has a defined recovery action", () => {
    for (const code of ALL_CODES) {
      expect(NET_ERROR_RECOVERY[code], code).toBeTruthy();
    }
    // The recovery table is exactly the taxonomy — no extra codes.
    expect(Object.keys(NET_ERROR_RECOVERY).sort()).toEqual([...ALL_CODES].sort());
  });

  it("retryable/terminal split matches CO6", () => {
    const retryable = ALL_CODES.filter((code) => isRetryable(netError(code, "x")));
    expect(retryable.sort()).toEqual(["E_MISSING_STATE", "E_READ_VERSION", "E_STALE_EPOCH", "E_STALE_HEAD"]);
    // Terminal + informational codes are not retryable turn mechanics.
    expect(isRetryable(netError("E_SCOPE_SPLIT", "x"))).toBe(false);
    expect(isRetryable(netError("E_CATALOG_MUTATION", "x"))).toBe(false);
    expect(isRetryable(netError("E_BUDGET", "x"))).toBe(false);
    // A read that cannot converge is a planner/catalog bug, not a turn
    // mechanic — terminal, so it surfaces named instead of retrying forever.
    expect(isRetryable(netError("E_NONCONVERGENT_READ", "x"))).toBe(false);
    expect(isRetryable(netError("E_RPC_TIMEOUT", "x"))).toBe(false);
    expect(isRetryable(netError("E_LINEAGE", "x"))).toBe(false);
    expect(isRetryable(netError("E_SEED_LAG", "x"))).toBe(false);
    // M9: a genuine durable-epoch disagreement is terminal — retrying it
    // is exactly the E_BUDGET treadmill the code exists to prevent.
    expect(isRetryable(netError("E_EPOCH_MISMATCH", "x"))).toBe(false);
    expect(isRetryable(netError("E_SEED_COMMITTED", "x"))).toBe(false);
  });

  it("carries structured detail and identifies via isNetError", () => {
    const err = netError("E_MISSING_STATE", "unmaterialized target", { scope: "the_room", missing: ["object_live:#12"] });
    expect(isNetError(err)).toBe(true);
    expect(err.code).toBe("E_MISSING_STATE");
    expect(err.detail.scope).toBe("the_room");
    expect(err.message).toContain("E_MISSING_STATE");
    expect(isNetError(new Error("plain"))).toBe(false);
  });

  it("E_BUDGET carries the per-attempt taxonomy trace (CO6)", () => {
    const err = budgetExhausted("repair budget exhausted", [
      { attempt: 1, code: "E_MISSING_STATE", missing: ["object_lineage:#9"], elapsed_ms: 120 },
      { attempt: 2, code: "E_STALE_HEAD", elapsed_ms: 310 }
    ], { scope: "the_room" });
    expect(err.code).toBe("E_BUDGET");
    expect(err.attempts).toHaveLength(2);
    expect(err.attempts?.[0].code).toBe("E_MISSING_STATE");
    expect(err.attempts?.[1].attempt).toBe(2);
  });

  it("E_NONCONVERGENT_READ carries the trace and names the stuck cell", () => {
    const err = nonconvergentRead("read cannot converge", [
      { attempt: 1, code: "E_READ_VERSION", missing: ["property_cell:the_outline:position"], elapsed_ms: 15 },
      { attempt: 2, code: "E_READ_VERSION", missing: ["property_cell:the_outline:position"], elapsed_ms: 31 }
    ], { stuck: [{ key: "property_cell:the_outline:position", authority_version: "v1", planned_version: "absent" }] });
    expect(err.code).toBe("E_NONCONVERGENT_READ");
    expect(err.attempts).toHaveLength(2);
    expect((err.detail.stuck as Array<{ key: string }>)[0].key).toBe("property_cell:the_outline:position");
  });
});
