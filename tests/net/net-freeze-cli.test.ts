import { describe, expect, it } from "vitest";
import { parseFreezeArgs, transitionFreeze } from "../../scripts/net-freeze";
import { verifyInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-freeze-cli-test-secret";

describe("net freeze operator CLI", () => {
  it("parses set and clear CAS transitions", () => {
    expect(parseFreezeArgs([
      "--base-url", "https://woo.test/",
      "--generation", "cutover-2026-07-12",
      "--expected-generation", "none"
    ])).toEqual({
      baseUrl: "https://woo.test",
      generation: "cutover-2026-07-12",
      expectedGeneration: null
    });
    expect(parseFreezeArgs([
      "--base-url", "https://woo.test",
      "--generation", "none",
      "--expected-generation", "cutover-2026-07-12"
    ])).toMatchObject({ generation: null, expectedGeneration: "cutover-2026-07-12" });
  });

  it("signs the exact transition body and verifies the echoed generation", async () => {
    const sent: Request[] = [];
    const result = await transitionFreeze(
      { baseUrl: "https://woo.test", generation: "g1", expectedGeneration: null },
      SECRET,
      async (input) => {
        expect(input).toBeInstanceOf(Request);
        const request = input as Request;
        sent.push(request.clone());
        await verifyInternalRequest({ WOO_INTERNAL_SECRET: SECRET }, request);
        expect(await request.json()).toEqual({ generation: "g1", expected_generation: null });
        return Response.json({ freeze_generation: "g1" });
      }
    );
    expect(sent).toHaveLength(1);
    expect(result).toEqual({ freeze_generation: "g1" });
  });
});
