// H1(b): the /net-smoke lane doorway must NEVER be an unauthenticated
// seeding/admin surface on a reachable deploy. Before this fix it 404'd
// ONLY when WOO_AE_DATASET was set; an environment that merely lacked
// that var exposed /net/seed and friends to anyone. Now the doorway also
// requires the internal signature (verifyInternalRequest) — the local
// lanes hold WOO_INTERNAL_SECRET and sign; nobody else can.
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-smoke-doorway-secret";

/** A minimal net stub answering /head, wired through NET_RESOLVE so a
 * SIGNED request can prove it reaches past the auth gate. */
const fakeEnv = () =>
  ({
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: () => ({
      fetch: async () => new Response(JSON.stringify({ scope: "x", head: { seq: 0, hash: "h" } }), { status: 200 })
    })
  }) as unknown as Parameters<typeof worker.fetch>[1];

const url = "https://woah1.generalbusiness.ai/net-smoke/scope/x/head";

describe("net-smoke doorway hardening (H1b)", () => {
  it("refuses an UNSIGNED request (401), even with WOO_AE_DATASET unset", async () => {
    const response = await worker.fetch(new Request(url), fakeEnv(), undefined);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("E_NOSESSION");
  });

  it("accepts a SIGNED request (the lane's posture) — past the auth gate", async () => {
    const signed = await signInternalRequest({ WOO_INTERNAL_SECRET: SECRET }, new Request(url));
    const response = await worker.fetch(signed, fakeEnv(), undefined);
    // Past the gate: the fake stub answers /head. Not a 401/404.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { head?: { seq?: number } };
    expect(body.head?.seq).toBe(0);
  });

  it("still 404s on the deploy profile (WOO_AE_DATASET set), signed or not", async () => {
    const deployEnv = { ...(fakeEnv() as unknown as Record<string, unknown>), WOO_AE_DATASET: "woo_v1_prod" } as unknown as Parameters<
      typeof worker.fetch
    >[1];
    const unsigned = await worker.fetch(new Request(url), deployEnv, undefined);
    expect(unsigned.status).toBe(404);
    const signed = await signInternalRequest({ WOO_INTERNAL_SECRET: SECRET }, new Request(url));
    const signedResponse = await worker.fetch(signed, deployEnv, undefined);
    expect(signedResponse.status).toBe(404);
  });
});
