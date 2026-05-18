import { describe, expect, it } from "vitest";
import { wooError } from "../../src/core/types";
import { metricErrorFields } from "../../src/worker/metric-errors";

describe("metricErrorFields", () => {
  it("uses wooError codes unchanged", () => {
    expect(metricErrorFields(wooError("E_INVARG", "bad input"))).toEqual({ error: "E_INVARG" });
  });

  it("maps plain Error to E_INTERNAL with a bounded message detail", () => {
    expect(metricErrorFields(new Error("relay exploded while applying envelope"))).toEqual({
      error: "E_INTERNAL",
      error_detail: "relay exploded while applying envelope"
    });
  });

  it("does not report Error.name as the metric error code", () => {
    expect(metricErrorFields(new TypeError("wrong shape")).error).toBe("E_INTERNAL");
  });
});
