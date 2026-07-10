// Cutover items B (export route) + C (write-freeze) over the whole v2
// worker in the fake-DO lane (notes/2026-07-08-net-cutover-tooling-plan.md).
//
// The §8 sequence this pins: flip WOO_WRITE_FREEZE → mutations and new
// sessions refuse with the named E_MAINTENANCE verdict while GET reads
// keep answering → the signed identity export STILL runs (internal
// traffic is exempt — "final identity-export from FROZEN old prod").
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { DirectoryDO } from "../../src/worker/directory-do";
import { PersistentObjectDO, type Env } from "../../src/worker/persistent-object-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { parseIdentityExport } from "../../src/net/identity";
import { FakeDurableObjectNamespace, FakeDurableObjectState } from "./fake-do";

const SECRET = "net-cutover-freeze-secret";

function buildHarness(vars: Record<string, string> = {}) {
  const states: FakeDurableObjectState[] = [];
  const directoryState = new FakeDurableObjectState("directory");
  states.push(directoryState);
  const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: SECRET });
  const wooObjects = new Map<string, PersistentObjectDO>();
  let env: Env;
  const wooNamespace = new FakeDurableObjectNamespace((name) => {
    let object = wooObjects.get(name);
    if (!object) {
      const state = new FakeDurableObjectState(name);
      states.push(state);
      object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
      wooObjects.set(name, object);
    }
    return object;
  });
  env = {
    WOO_INITIAL_WIZARD_TOKEN: "net-cutover-freeze-token",
    WOO_INTERNAL_SECRET: SECRET,
    ...vars,
    DIRECTORY: new FakeDurableObjectNamespace(() => directory),
    WOO: wooNamespace
  } as unknown as Env;
  return {
    env,
    request: async (path: string, init?: RequestInit) => worker.fetch(new Request(`https://woo.test${path}`, init), env, {} as never),
    signedRequest: async (path: string, init?: RequestInit) =>
      worker.fetch(await signInternalRequest({ WOO_INTERNAL_SECRET: SECRET }, new Request(`https://woo.test${path}`, init)), env, {} as never),
    acknowledgeFreeze: async (generation: string | null) => {
      const request = await signInternalRequest(
        { WOO_INTERNAL_SECRET: SECRET },
        new Request("https://woo.test/net-install/freeze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generation })
        })
      );
      return worker.fetch(request, env, {} as never);
    },
    close: () => states.forEach((state) => state.close())
  };
}

type ExportEnvelope = {
  frozen: boolean;
  freeze_generation: string | null;
  watermark: string;
  exported_at: number;
  identity: unknown;
};

describe("cutover item B: the identity-export doorway", () => {
  it("refuses unfrozen exports, honors the rehearsal override, and the watermark tracks mutations", async () => {
    const h = buildHarness();
    // A live session so the world has SOME identity-adjacent state.
    const auth = await h.request("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "guest:cutover-export" })
    });
    expect(auth.status, await auth.clone().text()).toBe(200);

    const unsigned = await h.request("/net-install/identity-export");
    expect(unsigned.status).toBe(401);

    // Freeze-first contract: a signed export against an UNFROZEN world
    // refuses — a cutover export taken while writes still land can lose
    // the mutations that follow it.
    const refused = await h.signedRequest("/net-install/identity-export");
    expect(refused.status, await refused.clone().text()).toBe(409);

    // The explicit rehearsal override returns the watermarked envelope.
    const response = await h.signedRequest("/net-install/identity-export?allow-unfrozen=1");
    expect(response.status, await response.clone().text()).toBe(200);
    const envelope = (await response.json()) as ExportEnvelope;
    expect(envelope.frozen).toBe(false);
    expect(envelope.watermark).toMatch(/^[0-9a-f]{64}$/);
    const identity = parseIdentityExport(envelope.identity);
    expect(identity.kind).toBe("woo.identity_export.v1");
    expect(typeof identity.api_keys).toBe("object");

    // Positive control for the quiescence proof: a mutation between two
    // exports MUST move the watermark (otherwise equal watermarks prove
    // nothing).
    const mutate = await h.request("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "guest:cutover-export-2" })
    });
    expect(mutate.status).toBe(200);
    const after = (await (await h.signedRequest("/net-install/identity-export?allow-unfrozen=1")).json()) as ExportEnvelope;
    expect(after.watermark).not.toBe(envelope.watermark);
    h.close();
  });
});

describe("cutover item C: the write-freeze", () => {
  it("mutations and new sessions refuse E_MAINTENANCE; reads and the signed export continue", async () => {
    const h = buildHarness({ WOO_WRITE_FREEZE: "1" });

    // Identity ops refuse (a session mint is a write).
    const auth = await h.request("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "guest:cutover-frozen" })
    });
    expect(auth.status).toBe(503);
    expect(((await auth.json()) as { error: { code: string } }).error.code).toBe("E_MAINTENANCE");

    // MCP tool calls refuse (mutation-capable surface).
    const mcp = await h.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    expect(mcp.status).toBe(503);

    // The WS upgrade refuses even as a GET — it opens a mutation channel.
    const ws = await h.request("/v2/turn-network/ws");
    expect(ws.status).toBe(503);

    // GET reads keep answering (healthz is the canary the runbook probes).
    const health = await h.request("/healthz");
    expect(health.status).toBe(200);

    // Finding 6: env-frozen alone is NOT the acknowledged fence — the
    // export refuses until the authority persists a generation.
    const unacknowledged = await h.signedRequest("/net-install/identity-export");
    expect(unacknowledged.status, await unacknowledged.clone().text()).toBe(409);
    const ack = await h.acknowledgeFreeze("gen-test-1");
    expect(ack.status, await ack.clone().text()).toBe(200);

    // THE §8 property: the signed export runs against the frozen world,
    // reports the acknowledged generation, and carries the watermark.
    const response = await h.signedRequest("/net-install/identity-export");
    expect(response.status, await response.clone().text()).toBe(200);
    const envelope = (await response.json()) as ExportEnvelope;
    expect(envelope.frozen).toBe(true);
    expect(envelope.freeze_generation).toBe("gen-test-1");
    expect(envelope.watermark).toMatch(/^[0-9a-f]{64}$/);
    expect(parseIdentityExport(envelope.identity).kind).toBe("woo.identity_export.v1");

    h.close();
  });

  it("the persisted generation freezes WITHOUT the env flag and survives until explicitly cleared (finding 6)", async () => {
    // The env-rollback shape: an operator clears WOO_WRITE_FREEZE but the
    // authority still holds the fence — mutations stay refused until the
    // explicit unfreeze, so a half-rolled-back deploy can never silently
    // reopen writes mid-cutover.
    const h = buildHarness(); // NO env flag
    const ack = await h.acknowledgeFreeze("gen-persist-1");
    expect(ack.status).toBe(200);

    const refused = await h.request("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "guest:fence-check" })
    });
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("E_MAINTENANCE");

    // Explicit unfreeze restores service.
    const clear = await h.acknowledgeFreeze(null);
    expect(clear.status).toBe(200);
    const restored = await h.request("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "guest:fence-clear" })
    });
    expect(restored.status, await restored.clone().text()).toBe(200);
    h.close();
  });

  it("race: writes arriving during the export window are refused and the watermark stays stable", async () => {
    // The reviewer-required cutover race: freeze on → export → a write
    // arrives mid-window → export again. The write must refuse, and the
    // two watermarks must be EQUAL — the quiescence verdict the operator
    // tool (scripts/identity-export.ts) enforces before the export file
    // may feed the install.
    const h = buildHarness({ WOO_WRITE_FREEZE: "1" });
    expect((await h.acknowledgeFreeze("gen-race-1")).status).toBe(200);

    // Warm-up: the FIRST warm fetch runs the once-per-epoch derived-
    // contents repair (§B2.15 — $nowhere is a sink; bootstrap leaves
    // members in its contents mirror), which legitimately moves the
    // image exactly once. A production world DO is long-warm so the
    // repair epoch is already recorded; this warm-up models that. The
    // operator tool covers the cold case by aborting on mismatch and
    // re-running.
    await h.signedRequest("/net-install/identity-export");

    const first = (await (await h.signedRequest("/net-install/identity-export")).json()) as ExportEnvelope;
    expect(first.watermark).toMatch(/^[0-9a-f]{64}$/);

    // The racing write: a session mint (the same mutation class the
    // positive control above proves WOULD move the watermark when
    // unfrozen).
    const racing = await h.request("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "guest:cutover-racer" })
    });
    expect(racing.status).toBe(503);
    expect(((await racing.json()) as { error: { code: string } }).error.code).toBe("E_MAINTENANCE");

    const second = (await (await h.signedRequest("/net-install/identity-export")).json()) as ExportEnvelope;
    expect(second.watermark).toBe(first.watermark);
    h.close();
  });

  it("without the flag, the same surfaces answer normally", async () => {
    const h = buildHarness();
    const auth = await h.request("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "guest:cutover-unfrozen" })
    });
    expect(auth.status, await auth.clone().text()).toBe(200);
    h.close();
  });
});
