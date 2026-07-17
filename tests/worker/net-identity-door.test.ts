// The identity door (§8 "humans re-authenticate by password, agents by
// carried apikey"): password login, guest claim, and the session bearer
// over the REAL /net-api surface against an installed world — the last
// build item before the route switch. Fake-DO lane, engine-real fixture:
// the carried identity rides the actual §8 export/import (including the
// primary_actor rebuild the door depends on).
import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { FakeDurableObjectState } from "./fake-do";
import {
  createWorld,
  GUEST_RESET_OBJECT,
  GUEST_RESET_VERB,
  isCurrentGuestResetVerbPage
} from "../../src/core/bootstrap";
import { cellKey, type CellTransfer } from "../../src/net/cells";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { CLIENT_SESSION_TTL_DEFAULT_MS } from "../../src/net/client-session-policy";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-door-test-secret";
const EMAIL = "alice@example.com";
const PASSWORD = "correct horse battery staple";

function netState(name: string) {
  const fake = new FakeDurableObjectState(name);
  const pending = new Set<Promise<unknown>>();
  const state: NetScopeDurableState & NetGatewayDurableState = {
    id: fake.id,
    waitUntil: (promise) => {
      pending.add(promise);
      void promise.finally(() => pending.delete(promise));
    },
    storage: { sql: fake.storage.sql, transactionSync: fake.storage.transactionSync, setAlarm: () => {}, deleteAlarm: () => {} }
  };
  return {
    state,
    pending: () => [...pending],
    close: () => fake.close()
  };
}

async function settleStates(states: Array<ReturnType<typeof netState>>): Promise<void> {
  // One DO's drain calls another DO and can schedule work there after that
  // peer looked idle. Quiesce the whole fake namespace before closing any
  // database; per-DO concurrent teardown races the cross-DO outbox.
  while (true) {
    const pending = states.flatMap((state) => state.pending());
    if (pending.length === 0) break;
    await Promise.allSettled(pending);
  }
}

async function closeStates(states: Array<ReturnType<typeof netState>>): Promise<void> {
  await settleStates(states);
  for (const state of states) state.close();
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

async function buildDoorHarness(options: {
  omitGuestTemplate?: boolean;
  legacyGuestTemplate?: boolean;
  renamedGuestResetVerb?: string;
  staleGuestResetDefinition?: boolean;
  unknownGuestResetDefinition?: boolean;
} = {}) {
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
  const scopeStates = new Map<string, ReturnType<typeof netState>>();
  const resolve = (destination: string) => {
    if (destination.startsWith("scope:")) {
      const scope = destination.slice("scope:".length);
      let instance = scopeDOs.get(scope);
      if (!instance) {
        // Elastic guest actors intentionally select never-before-seen
        // cluster DOs; real idFromName creates them lazily, so the fake
        // namespace must do the same.
        const st = netState(`door-scope-${scope}`);
        states.push(st);
        scopeStates.set(scope, st);
        instance = new NetScopeDO(st.state, scopeEnv);
        scopeDOs.set(scope, instance);
      }
      return instance;
    }
    if (destination.startsWith("gateway:")) return gateway;
    throw new Error(`unresolvable ${destination}`);
  };
  const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
  for (const [scope, cells] of plan.partitions) {
    const st = netState(`door-scope-${scope}`);
    states.push(st);
    scopeStates.set(scope, st);
    const instance = new NetScopeDO(st.state, scopeEnv);
    const seededCells = cells
      .filter((cell) => !(options.omitGuestTemplate && cell.kind === "property_cell" && cell.object === "$system" && cell.name === "guest_template"))
      .map((cell) => {
        if (options.legacyGuestTemplate && cell.kind === "property_cell" && cell.object === "$system" && cell.name === "guest_template") {
          const payload = cell.value as { value?: Record<string, unknown> };
          const current = payload.value ?? {};
          return {
            ...cell,
            value: {
              ...payload,
              value: {
                version: 1,
                parent: current.parent,
                owner: current.owner,
                description: current.description,
                home: current.home,
                initial_room: current.initial_room
              }
            }
          };
        }
        if (options.renamedGuestResetVerb && cell.kind === "property_cell" && cell.object === "$system" && cell.name === "guest_template") {
          const payload = cell.value as { value?: Record<string, unknown> };
          return { ...cell, value: { ...payload, value: { ...payload.value, reset_verb: options.renamedGuestResetVerb } } };
        }
        if (options.renamedGuestResetVerb && cell.kind === "verb_bytecode" && cell.object === GUEST_RESET_OBJECT && cell.name === GUEST_RESET_VERB) {
          return {
            ...cell,
            name: options.renamedGuestResetVerb,
            value: { ...(cell.value as Record<string, unknown>), name: options.renamedGuestResetVerb }
          };
        }
        if ((!options.staleGuestResetDefinition && !options.unknownGuestResetDefinition) || cell.kind !== "verb_bytecode" ||
            cell.object !== GUEST_RESET_OBJECT || cell.name !== GUEST_RESET_VERB) return cell;
        return {
          ...cell,
          value: {
            ...(cell.value as Record<string, unknown>),
            arg_spec: { args: [] },
            source: "verb :on_disfunc() r { ... }",
            source_hash: "aged-guest-reset-source",
            direct_callable: false,
            ...(options.unknownGuestResetDefinition ? { native: "untrusted_guest_reset" } : {})
          }
        };
      });
    const request = new Request("https://do/net/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope,
        catalog_epoch: plan.epoch,
        cells: seededCells,
        relations: plan.relations.get(scope) ?? []
      })
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

  return {
    plan,
    human,
    api,
    catalogDefinition: async () => {
      const key = cellKey("verb_bytecode", GUEST_RESET_OBJECT, options.renamedGuestResetVerb ?? GUEST_RESET_VERB);
      const request = new Request("https://do/net/closure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: [key], known: [] })
      });
      const response = await scopeDOs.get("catalog")!.fetch(await signInternalRequest(scopeEnv, request));
      expect(response.status, await response.clone().text()).toBe(200);
      const transfer = await response.json() as CellTransfer;
      return transfer.cells.find((cell) => cell.key === key);
    },
    catalogTailSeqs: () => (scopeStates.get("catalog")!.state.storage.sql
      .exec("SELECT seq FROM net_scope_tail ORDER BY seq") as { toArray(): Array<{ seq: number }> }).toArray(),
    settle: async () => settleStates(states),
    close: async () => closeStates(states)
  };
}

describe("the identity door (/net-api/login, /net-api/guest, session bearers)", () => {
  it("dispatches the template-declared reset verb rather than a worker command literal", async () => {
    const h = await buildDoorHarness({ renamedGuestResetVerb: "restore_pool_identity" });
    const claimed = await h.api("POST", "/net-api/guest", { body: {} });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect((await h.catalogDefinition())?.value).toMatchObject({
      name: "restore_pool_identity",
      native: "guest_on_disfunc"
    });
    await h.close();
  }, 30_000);

  it("derives the reset contract for a version-1 template without worker identity literals", async () => {
    const h = await buildDoorHarness({ legacyGuestTemplate: true });
    const claimed = await h.api("POST", "/net-api/guest", { body: {} });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    // The current definition needs no repair; compatibility is a bounded
    // lookup on the template's declared parent, not catalog-wide discovery.
    expect(h.catalogTailSeqs()).toEqual([]);
    await h.close();
  }, 30_000);

  it("repairs a recognized aged guest-reset definition before allocating a session", async () => {
    const h = await buildDoorHarness({ staleGuestResetDefinition: true });
    expect(isCurrentGuestResetVerbPage((await h.catalogDefinition())?.value)).toBe(false);

    const claimId = `g1.${Date.now().toString(36)}.${CLIENT_SESSION_TTL_DEFAULT_MS.toString(36)}.e68f08f0-33c8-4f87-8168-619f0ed09e76`;
    const claimed = await h.api("POST", "/net-api/guest", { body: { claim_id: claimId } });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(isCurrentGuestResetVerbPage((await h.catalogDefinition())?.value)).toBe(true);
    expect(h.catalogTailSeqs()).toEqual([{ seq: 1 }]);

    // The deterministic replay uses the repaired gateway page and must not
    // append another catalog event.
    const replay = await h.api("POST", "/net-api/guest", { body: { claim_id: claimId } });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({ actor: claimed.body.actor, session: claimed.body.session });
    expect(h.catalogTailSeqs()).toEqual([{ seq: 1 }]);
    await h.close();
  }, 30_000);

  it("refuses an unrecognized guest-reset definition without mutating catalog authority", async () => {
    const h = await buildDoorHarness({ unknownGuestResetDefinition: true });
    const before = await h.catalogDefinition();
    expect((before?.value as { native?: string }).native).toBe("untrusted_guest_reset");

    const claim = await h.api("POST", "/net-api/guest", { body: {} });
    expect(claim.status).toBe(503);
    expect(claim.body).toMatchObject({
      error: { code: "E_RETRY", detail: { reason: "guest_reset_definition" } }
    });
    expect((await h.catalogDefinition())?.value).toEqual(before?.value);
    expect(h.catalogTailSeqs()).toEqual([]);
    await h.close();
  }, 30_000);

  it("fails guest admission closed when the install-owned reset template is absent", async () => {
    const h = await buildDoorHarness({ omitGuestTemplate: true });

    const claim = await h.api("POST", "/net-api/guest", { body: {} });
    expect(claim.status).toBe(503);
    expect(claim.body).toMatchObject({
      error: { code: "E_RETRY", detail: { reason: "guest_template_missing" } }
    });
    // A fresh install already matches the shared contract; the verification
    // itself must not create catalog churn.
    expect(h.catalogTailSeqs()).toEqual([]);

    await h.close();
  }, 30_000);

  it("renders every installed non-presence room member on a cold guest gateway", async () => {
    const h = await buildDoorHarness();
    const claim = await h.api("POST", "/net-api/guest", { body: {} });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);

    const turn = await h.api("POST", "/net-api/turn", {
      token: `session:${claim.body.session as string}`,
      body: { target: "the_chatroom", verb: "look", args: [], idempotency_key: "cold-room-look" }
    });
    expect(turn.status, JSON.stringify(turn.body).slice(0, 500)).toBe(200);
    expect(turn.body.result).toMatchObject({
      id: "the_chatroom",
      contents: expect.arrayContaining([
        expect.objectContaining({ id: "the_dubspace" }),
        expect.objectContaining({ id: "the_outline" }),
        expect.objectContaining({ id: "the_weather", title: expect.stringContaining("Weather for") })
      ])
    });
    expect((turn.body.structure as { attempt?: number }).attempt).toBe(1);
    expect((turn.body.structure as { sync_rpc?: number }).sync_rpc).toBeLessThanOrEqual(24);

    // Offline pooled actors were classified during the cold expansion but
    // never admitted into the room presentation read set. The isolate memo
    // keeps the next look on the warm path instead of probing every seat again.
    const warm = await h.api("POST", "/net-api/turn", {
      token: `session:${claim.body.session as string}`,
      body: { target: "the_chatroom", verb: "look", args: [], idempotency_key: "warm-room-look" }
    });
    expect(warm.status, JSON.stringify(warm.body).slice(0, 500)).toBe(200);
    expect((warm.body.structure as { sync_rpc?: number }).sync_rpc).toBeLessThanOrEqual(10);

    await h.close();
  }, 30_000);

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

    await h.close();
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
        body: JSON.stringify({ scope, catalog_epoch: plan.epoch, cells, relations: plan.relations.get(scope) ?? [] })
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
    await closeStates(states);
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
    await h.close();
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
        body: JSON.stringify({ scope, catalog_epoch: plan.epoch, cells, relations: plan.relations.get(scope) ?? [] })
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
    await closeStates(states);
  }, 30_000);

  it("guest claims are exclusive and overflow provisions a fresh owner-sequenced actor", async () => {
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
      expect(claim.body.active_scope).toBe("the_chatroom");
    }

    // The pool is full: provision a fresh actor + first session as one
    // commit at cluster:<actor>, then use its bearer immediately.
    const claimId = `g1.${Date.now().toString(36)}.${CLIENT_SESSION_TTL_DEFAULT_MS.toString(36)}.8c43df90-7989-46ef-a29b-947f5d1fc130`;
    const elastic = await h.api("POST", "/net-api/guest", { body: { claim_id: claimId } });
    expect(elastic.status, JSON.stringify(elastic.body).slice(0, 300)).toBe(200);
    expect(elastic.body.elastic).toBe(true);
    expect(elastic.body.actor).toMatch(/^guest_net_[0-9a-f]{32}$/);
    expect(elastic.body.active_scope).toBe("the_chatroom");
    expect(claimed.has(elastic.body.actor as string)).toBe(false);
    const replay = await h.api("POST", "/net-api/guest", { body: { claim_id: claimId } });
    expect(replay.status, JSON.stringify(replay.body).slice(0, 300)).toBe(200);
    expect(replay.body).toMatchObject({ actor: elastic.body.actor, session: elastic.body.session, elastic: true });
    const turn = await h.api("POST", "/net-api/turn", {
      token: `session:${elastic.body.session as string}`,
      body: { target: "the_chatroom", verb: "say", args: ["elastic hello"], idempotency_key: "elastic-door-turn" }
    });
    expect(turn.status, JSON.stringify(turn.body).slice(0, 300)).toBe(200);
    expect((turn.body.reply as { status?: string }).status).toBe("accepted");

    await h.close();
  }, 30_000);

  it("retries an accepted claim on its existing pool seat after an earlier seat becomes free", async () => {
    const h = await buildDoorHarness();
    const occupied = await h.api("POST", "/net-api/guest", { body: {} });
    expect(occupied.status).toBe(200);

    const claimId = `g1.${Date.now().toString(36)}.${CLIENT_SESSION_TTL_DEFAULT_MS.toString(36)}.5aa81e0e-8d5c-4b2c-bde2-da3d35c720d6`;
    const claimed = await h.api("POST", "/net-api/guest", { body: { claim_id: claimId } });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body.actor).not.toBe(occupied.body.actor);

    const released = await h.api("DELETE", "/net-api/session", {
      token: `session:${occupied.body.session as string}`
    });
    expect(released.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const replay = await h.api("POST", "/net-api/guest", { body: { claim_id: claimId } });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({ actor: claimed.body.actor, session: claimed.body.session });
    await h.close();
  }, 30_000);

  it("fails closed on malformed or expired guest claim bearers", async () => {
    const h = await buildDoorHarness();
    const malformed = await h.api("POST", "/net-api/guest", { body: { claim_id: "not-a-claim" } });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatchObject({ code: "E_PERM", detail: { reason: "guest_claim_invalid" } });

    const mismatched = await h.api("POST", "/net-api/guest", {
      body: {
        ttl_ms: 60_000,
        claim_id: `g1.${Date.now().toString(36)}.${(120_000).toString(36)}.8c43df90-7989-46ef-a29b-947f5d1fc130`
      }
    });
    expect(mismatched.status).toBe(400);
    expect(mismatched.body.error).toMatchObject({ code: "E_PERM", detail: { reason: "guest_claim_invalid" } });

    const expiredAt = Date.now() - 2 * 60_000;
    const expired = await h.api("POST", "/net-api/guest", {
      body: {
        ttl_ms: 60_000,
        claim_id: `g1.${expiredAt.toString(36)}.${(60_000).toString(36)}.8c43df90-7989-46ef-a29b-947f5d1fc130`
      }
    });
    expect(expired.status).toBe(409);
    expect(expired.body.error).toMatchObject({ code: "E_PERM", detail: { reason: "guest_claim_expired" } });
    await h.close();
  }, 30_000);

  it("logout releases the seat (finding 12): close → the SAME seat is claimable again", async () => {
    const h = await buildDoorHarness();
    const first = await h.api("POST", "/net-api/guest", { body: {} });
    expect(first.status, JSON.stringify(first.body).slice(0, 200)).toBe(200);
    const seat = first.body.actor as string;
    const session = first.body.session as string;

    // Leave durable actor state somewhere other than the install-declared
    // guest room. Closing releases only the session row; the next claim must
    // normalize this reused seat before exposing it to a different person.
    const moved = await h.api("POST", "/net-api/turn", {
      token: `session:${session}`,
      body: {
        target: "the_chatroom",
        verb: "southeast",
        args: [],
        idempotency_key: "door-reused-seat-move"
      }
    });
    expect(moved.status, JSON.stringify(moved.body).slice(0, 300)).toBe(200);
    expect((moved.body.reply as { status?: string }).status).toBe("accepted");
    expect((moved.body.result as { room?: string }).room).toBe("the_deck");
    const described = await h.api("POST", "/net-api/turn", {
      token: `session:${session}`,
      body: {
        target: seat,
        verb: "set_description",
        args: ["private prior-user description"],
        idempotency_key: "door-reused-seat-description"
      }
    });
    expect(described.status, JSON.stringify(described.body).slice(0, 300)).toBe(200);
    expect((described.body.reply as { status?: string }).status).toBe("accepted");

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
    expect(reclaimed.body.active_scope).toBe("the_chatroom");
    await h.settle();
    const reclaimedLive = await h.api("GET", `/net-api/cell?key=object_live:${seat}`, {
      token: `session:${reclaimed.body.session as string}`
    });
    expect(reclaimedLive.status, JSON.stringify(reclaimedLive.body).slice(0, 300)).toBe(200);
    expect((reclaimedLive.body.cell as { value?: { location?: string } }).value?.location).toBe("the_chatroom");
    const reclaimedDescription = await h.api("GET", `/net-api/cell?key=property_cell:${seat}:description`, {
      token: `session:${reclaimed.body.session as string}`
    });
    expect(reclaimedDescription.status, JSON.stringify(reclaimedDescription.body).slice(0, 300)).toBe(200);
    expect((reclaimedDescription.body.cell as { value?: { value?: string } }).value?.value).toBe("");

    // The closed session's bearer is dead — named refusal, not a zombie.
    const zombie = await h.api("POST", "/net-api/turn", {
      token: `session:${session}`,
      body: { target: "the_chatroom", verb: "say", args: ["boo"], idempotency_key: "door-zombie-1" }
    });
    expect(zombie.status).toBe(401);
    await h.close();
  }, 30_000);
});
