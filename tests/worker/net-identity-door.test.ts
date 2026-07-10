// The identity door (§8 "humans re-authenticate by password, agents by
// carried apikey"): password login, guest claim, and the session bearer
// over the REAL /net-api surface against an installed world — the last
// build item before the route switch. Fake-DO lane, engine-real fixture:
// the carried identity rides the actual §8 export/import (including the
// primary_actor rebuild the door depends on).
import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { FakeDurableObjectState } from "./fake-do";
import { createWorld } from "../../src/core/bootstrap";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-door-test-secret";
const EMAIL = "alice@example.com";
const PASSWORD = "correct horse battery staple";

function netState(name: string) {
  const fake = new FakeDurableObjectState(name);
  const state: NetScopeDurableState & NetGatewayDurableState = {
    id: fake.id,
    waitUntil: () => {},
    storage: { sql: fake.storage.sql, transactionSync: fake.storage.transactionSync, setAlarm: () => {}, deleteAlarm: () => {} }
  };
  return { state, close: () => fake.close() };
}

/** The EXACT core encoding (world.ts hashPassword): the test mints a real
 * carried credential, not a mock. 600k iterations ≈ 300ms, paid once. */
async function encodePassword(password: string): Promise<string> {
  const iterations = 600_000;
  const salt = "00112233445566778899aabbccddeeff";
  const saltBytes = new Uint8Array(salt.length / 2);
  for (let i = 0; i < saltBytes.length; i += 1) saltBytes[i] = Number.parseInt(salt.slice(i * 2, i * 2 + 2), 16);
  const keyMaterial = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits"
  ]);
  const bits = await webcrypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
    keyMaterial,
    256
  );
  const digest = [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `pbkdf2-sha256:${iterations}:${salt}:${digest}`;
}

async function buildDoorHarness() {
  // The OLD world: one human actor bound to an account with a REAL
  // password hash (actor-side binding only — primary_actor is NOT
  // carried by §8; the import must rebuild it), plus an apikey.
  const old = createWorld();
  const human = old.auth("guest:door-human").actor;
  old.createObject({ id: "acct_door", parent: "$account", owner: "$wiz", name: "door account" });
  old.setProp("acct_door", "email", EMAIL as never);
  old.setProp("acct_door", "password_hash", (await encodePassword(PASSWORD)) as never);
  old.setProp(human, "account", "acct_door" as never);
  old.ensureApiKey("$wiz", human, "door-key", "door-secret", "door test");
  const identity = exportIdentity(old.exportWorld());

  const plan = await planNetInstall({ graft: (fresh) => importIdentity(fresh, identity) });

  const states: Array<ReturnType<typeof netState>> = [];
  const scopeDOs = new Map<string, NetScopeDO>();
  const resolve = (destination: string) => {
    if (destination.startsWith("scope:")) {
      const instance = scopeDOs.get(destination.slice("scope:".length));
      if (instance) return instance;
    }
    if (destination.startsWith("gateway:")) return gateway;
    throw new Error(`unresolvable ${destination}`);
  };
  const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
  for (const [scope, cells] of plan.partitions) {
    const st = netState(`door-scope-${scope}`);
    states.push(st);
    const instance = new NetScopeDO(st.state, scopeEnv);
    const request = new Request("https://do/net/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, catalog_epoch: plan.epoch, cells })
    });
    const seeded = await instance.fetch(await signInternalRequest(scopeEnv, request));
    expect(seeded.ok, `seed ${scope}`).toBe(true);
    scopeDOs.set(scope, instance);
  }
  const gwState = netState("door-gateway");
  states.push(gwState);
  const gateway = new NetGatewayDO(gwState.state, { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve } as NetGatewayEnv);

  const api = async (
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {}
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const headers = new Headers();
    if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
    const request =
      method === "GET"
        ? new Request(`https://do${path}`, { headers })
        : new Request(`https://do${path}`, {
            method,
            headers: (headers.set("content-type", "application/json"), headers),
            body: JSON.stringify(opts.body ?? {})
          });
    const response = await gateway.fetch(request);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  return { plan, human, api, close: () => states.forEach((st) => st.close()) };
}

describe("the identity door (/net-api/login, /net-api/guest, session bearers)", () => {
  it("a carried account password logs in, the session is a bearer for the whole surface, and failures share one message", async () => {
    const h = await buildDoorHarness();

    // The import rebuilt the account→actor binding (§8 carries only the
    // actor side): password login resolves THROUGH primary_actor.
    expect(h.plan.world.propOrNull("acct_door", "primary_actor")).toBe(h.human);

    // The door: a real PBKDF2 verify against the carried cells.
    const login = await h.api("POST", "/net-api/login", { body: { email: EMAIL, password: PASSWORD } });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.actor).toBe(h.human);
    const session = login.body.session as string;
    expect(session).toMatch(/^s_/);

    // The minted session IS the credential (Bearer session:<id>): a turn
    // with no body.session (the bearer defaults it) commits end-to-end.
    const turn = await h.api("POST", "/net-api/turn", {
      token: `session:${session}`,
      body: { target: "the_chatroom", verb: "say", args: ["door hello"], idempotency_key: "door-turn-1" }
    });
    expect(turn.status, JSON.stringify(turn.body).slice(0, 300)).toBe(200);
    expect((turn.body.reply as { status?: string }).status).toBe("accepted");

    // Reads ride the bearer too (?session defaults to it).
    const cell = await h.api("GET", `/net-api/cell?key=object_live:${h.human}`, { token: `session:${session}` });
    expect(cell.status).toBe(200);

    // A session bearer cannot mint sessions — re-auth is the door's job.
    const remint = await h.api("POST", "/net-api/session", { token: `session:${session}` });
    expect(remint.status).toBe(403);
    expect((remint.body.error as { detail?: { reason?: string } }).detail?.reason).toBe("session_bearer_mint");

    // Fail-closed parity: wrong password, unknown email, and a garbage
    // bearer all refuse namedly; the first two share ONE message.
    const wrong = await h.api("POST", "/net-api/login", { body: { email: EMAIL, password: "nope" } });
    expect(wrong.status).toBe(401);
    expect((wrong.body.error as { message?: string }).message).toBe("invalid email or password");
    const unknown = await h.api("POST", "/net-api/login", { body: { email: "who@example.com", password: PASSWORD } });
    expect(unknown.status).toBe(401);
    expect((unknown.body.error as { message?: string }).message).toBe("invalid email or password");
    const badBearer = await h.api("GET", `/net-api/cell?key=object_live:${h.human}`, { token: "session:s_bogus" });
    expect(badBearer.status).toBe(401);
    expect((badBearer.body.error as { detail?: { reason?: string } }).detail?.reason).toBe("session_bearer_rejected");

    h.close();
  }, 30_000);

  it("deactivated identities STAY deactivated across the carry (reviewer finding 2): password and apikey both refuse", async () => {
    const old = createWorld();
    const human = old.auth("guest:door-deactivated").actor;
    old.createObject({ id: "acct_gone", parent: "$account", owner: "$wiz", name: "gone" });
    old.setProp("acct_gone", "email", "gone@example.com" as never);
    old.setProp("acct_gone", "password_hash", (await encodePassword(PASSWORD)) as never);
    old.setProp("acct_gone", "deactivated_at", Date.now() as never);
    old.setProp(human, "account", "acct_gone" as never);
    old.ensureApiKey("$wiz", human, "gone-key", "gone-secret", "deactivated identity");
    const identity = exportIdentity(old.exportWorld());

    // The carry preserves the lifecycle verdict (the reviewer's repro
    // was this import nulling deactivated_at).
    const plan = await planNetInstall({ graft: (fresh) => importIdentity(fresh, identity) });
    expect(plan.world.propOrNull("acct_gone", "deactivated_at")).not.toBeNull();

    const states: Array<ReturnType<typeof netState>> = [];
    const scopeDOs = new Map<string, NetScopeDO>();
    const resolve = (destination: string) => {
      if (destination.startsWith("scope:")) {
        const instance = scopeDOs.get(destination.slice("scope:".length));
        if (instance) return instance;
      }
      if (destination.startsWith("gateway:")) return gateway;
      throw new Error(`unresolvable ${destination}`);
    };
    const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
    for (const [scope, cells] of plan.partitions) {
      const st = netState(`deact-scope-${scope}`);
      states.push(st);
      const instance = new NetScopeDO(st.state, scopeEnv);
      const request = new Request("https://do/net/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, catalog_epoch: plan.epoch, cells })
      });
      const seeded = await instance.fetch(await signInternalRequest(scopeEnv, request));
      expect(seeded.ok).toBe(true);
      scopeDOs.set(scope, instance);
    }
    const gwState = netState("deact-gateway");
    states.push(gwState);
    const gateway = new NetGatewayDO(gwState.state, { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve } as NetGatewayEnv);

    // Password: fail-closed shared message.
    const login = await gateway.fetch(
      new Request("https://do/net-api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "gone@example.com", password: PASSWORD })
      })
    );
    expect(login.status).toBe(401);
    expect(((await login.json()) as { error: { message: string } }).error.message).toBe("invalid email or password");

    // Apikey: authentication succeeds but the MINT refuses — the
    // eligibility gate every credential path passes.
    const mint = await gateway.fetch(
      new Request("https://do/net-api/session", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer apikey:gone-key:gone-secret" },
        body: JSON.stringify({ ttl_ms: 60_000 })
      })
    );
    expect(mint.status).toBe(403);
    expect(((await mint.json()) as { error: { detail?: { reason?: string } } }).error.detail?.reason).toBe(
      "identity_deactivated"
    );
    states.forEach((st) => st.close());
  }, 30_000);

  it("V3 finding 7: oversized credentials refuse before any derivation, and an over-ceiling hash never verifies", async () => {
    const { verifyPasswordCredential } = await import("../../src/worker/net/client-auth");
    const h = await buildDoorHarness();
    // A 300-byte email exceeds MAX_EMAIL_BYTES (254): refused with the
    // fail-closed message, no derivation paid.
    const bigEmail = await h.api("POST", "/net-api/login", { body: { email: "a".repeat(300) + "@x.com", password: PASSWORD } });
    expect(bigEmail.status).toBe(401);
    expect((bigEmail.body.error as { message?: string }).message).toBe("invalid email or password");
    // A hash encoding an absurd iteration count never verifies (the
    // upper ceiling, mirroring the lower floor — fail closed).
    const overCeiling = `pbkdf2-sha256:99000000:${"0".repeat(32)}:${"0".repeat(64)}`;
    expect(await verifyPasswordCredential("whatever", overCeiling)).toBe(false);
    h.close();
  }, 30_000);

  it("V3 finding 3: mint mirrors core actorCanAuthenticate — deactivated ACTOR and deactivated AGENT-OWNER both refuse", async () => {
    const old = createWorld();
    // A human whose ACCOUNT is live but whose primary ACTOR is
    // deactivated (the reviewer's "live account, deactivated primary").
    const human = old.auth("guest:v3-human").actor;
    old.createObject({ id: "acct_v3", parent: "$account", owner: "$wiz", name: "v3" });
    old.setProp("acct_v3", "email", "v3@example.com" as never);
    old.setProp(human, "account", "acct_v3" as never);
    old.setProp(human, "deactivated_at", Date.now() as never);
    old.ensureApiKey("$wiz", human, "v3-human-key", "v3-human-secret", "deactivated actor");
    // An AGENT owned by a deactivated owner (the reviewer's "apikey for a
    // deactivated agent" — here via the owner chain).
    const owner = old.auth("guest:v3-owner").actor;
    old.setProp(owner, "deactivated_at", Date.now() as never);
    const agent = old.createObject({ id: "agent_v3", parent: "$agent", owner, name: "agent" }).id;
    old.ensureApiKey("$wiz", agent, "v3-agent-key", "v3-agent-secret", "agent of deactivated owner");
    const identity = exportIdentity(old.exportWorld());

    const plan = await planNetInstall({ graft: (fresh) => importIdentity(fresh, identity) });
    const states: Array<ReturnType<typeof netState>> = [];
    const scopeDOs = new Map<string, NetScopeDO>();
    const resolve = (destination: string) => {
      if (destination.startsWith("scope:")) {
        const instance = scopeDOs.get(destination.slice("scope:".length));
        if (instance) return instance;
      }
      if (destination.startsWith("gateway:")) return gateway;
      throw new Error(`unresolvable ${destination}`);
    };
    const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
    for (const [scope, cells] of plan.partitions) {
      const st = netState(`v3-scope-${scope}`);
      states.push(st);
      const instance = new NetScopeDO(st.state, scopeEnv);
      const request = new Request("https://do/net/seed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, catalog_epoch: plan.epoch, cells })
      });
      const seeded = await instance.fetch(await signInternalRequest(scopeEnv, request));
      expect(seeded.ok, `seed ${scope}`).toBe(true);
      scopeDOs.set(scope, instance);
    }
    const gwState = netState("v3-gateway");
    states.push(gwState);
    const gateway = new NetGatewayDO(gwState.state, { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve } as NetGatewayEnv);
    const mint = async (token: string) =>
      gateway.fetch(
        new Request("https://do/net-api/session", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ ttl_ms: 60_000 })
        })
      );

    const deactivatedActor = await mint("apikey:v3-human-key:v3-human-secret");
    expect(deactivatedActor.status).toBe(403);
    expect(((await deactivatedActor.json()) as { error: { detail?: { reason?: string } } }).error.detail?.reason).toBe(
      "identity_deactivated"
    );
    const deactivatedOwner = await mint("apikey:v3-agent-key:v3-agent-secret");
    expect(deactivatedOwner.status).toBe(403);
    expect(((await deactivatedOwner.json()) as { error: { detail?: { reason?: string } } }).error.detail?.reason).toBe(
      "identity_deactivated"
    );
    states.forEach((st) => st.close());
  }, 30_000);

  it("guest claims are exclusive: distinct actors per claim, occupied seats skipped, exhaustion refuses namedly", async () => {
    const h = await buildDoorHarness();

    // The install seeded the pool (stock guests, minus the carried
    // human's guest id — it is account-bound now) and PLACED the seats.
    const pool = h.plan.world.propOrNull("$system", "guest_pool");
    expect(Array.isArray(pool)).toBe(true);
    const seats = (pool as string[]).length;
    expect(seats).toBeGreaterThanOrEqual(2);
    expect(pool as string[]).not.toContain(h.human);
    for (const seat of pool as string[]) {
      expect(h.plan.world.object(seat).location).toBe("the_chatroom");
    }

    // Claim every seat: each claim lands a DIFFERENT actor (the
    // exclusive mint refuses occupied seats and the door walks on).
    const claimed = new Set<string>();
    for (let i = 0; i < seats; i += 1) {
      const claim = await h.api("POST", "/net-api/guest", { body: {} });
      expect(claim.status, JSON.stringify(claim.body).slice(0, 300)).toBe(200);
      const actor = claim.body.actor as string;
      expect(claimed.has(actor), `duplicate seat ${actor}`).toBe(false);
      claimed.add(actor);
      // Guest sessions are born PRESENT in the start room (the install
      // placed the seats), so observations reach them immediately.
      expect(claim.body.session).toMatch(/^s_/);
    }

    // The pool is full: a NAMED capacity refusal, never a hang or a
    // shared seat.
    const exhausted = await h.api("POST", "/net-api/guest", { body: {} });
    expect(exhausted.status).toBe(503);
    expect((exhausted.body.error as { detail?: { reason?: string } }).detail?.reason).toBe("guest_pool_exhausted");

    h.close();
  }, 30_000);

  it("logout releases the seat (finding 12): close → the SAME seat is claimable again", async () => {
    const h = await buildDoorHarness();
    const first = await h.api("POST", "/net-api/guest", { body: {} });
    expect(first.status, JSON.stringify(first.body).slice(0, 200)).toBe(200);
    const seat = first.body.actor as string;
    const session = first.body.session as string;

    // Occupied while held: the exclusive guard hands the NEXT claim a
    // different seat.
    const second = await h.api("POST", "/net-api/guest", { body: {} });
    expect(second.status).toBe(200);
    expect(second.body.actor).not.toBe(seat);

    // RELEASE via the session bearer (the SPA's logout path), then wait
    // out the close grace (the 250ms immediate-expiry rewrite).
    const closed = await h.api("DELETE", "/net-api/session", { token: `session:${session}` });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.closed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The first-in-pool-order seat is free again — the next claim gets it.
    const reclaimed = await h.api("POST", "/net-api/guest", { body: {} });
    expect(reclaimed.status, JSON.stringify(reclaimed.body).slice(0, 200)).toBe(200);
    expect(reclaimed.body.actor).toBe(seat);

    // The closed session's bearer is dead — named refusal, not a zombie.
    const zombie = await h.api("POST", "/net-api/turn", {
      token: `session:${session}`,
      body: { target: "the_chatroom", verb: "say", args: ["boo"], idempotency_key: "door-zombie-1" }
    });
    expect(zombie.status).toBe(401);
    h.close();
  }, 30_000);
});
