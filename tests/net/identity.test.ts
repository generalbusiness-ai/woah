// Identity export/import round-trip (cutover item B; §8-approved schema).
// The whole point of the carry-over: an apikey minted in the OLD world
// authenticates in a FRESHLY INSTALLED world after import — proven here
// end-to-end through world.auth, not by comparing maps.
import { describe, expect, it } from "vitest";
import { createWorld } from "../../src/core/bootstrap";
import { normalizeCustomerAttribution, PROP_CUSTOMER_OF } from "../../src/net/attribution";
import { exportIdentity, importIdentity, parseIdentityExport } from "../../src/net/identity";
import { netInstallEpoch, planNetInstall } from "../../src/net/install";
import { CATALOG_SCOPE } from "../../src/net/topology";

const KEY_ID = "carry-key";
const KEY_SECRET = "carry-secret-1";

/** A prod-like OLD world: a guest actor with an apikey, an account with
 * password/email, the actor bound to the account, plus world furniture
 * (a room and a note) that must NOT ride the export. */
function oldWorld() {
  const world = createWorld();
  const session = world.auth("guest:identity-old");
  const actor = session.actor;
  world.ensureApiKey("$wiz", actor, KEY_ID, KEY_SECRET, "carry test");
  world.createObject({ id: "acct_1", name: "Account One", parent: "$account", owner: actor });
  world.setProp("acct_1", "email", "one@example.com");
  world.setProp("acct_1", "password_salt", "salt-1");
  world.setProp("acct_1", "password_hash", "hash-1");
  world.setProp(actor, "account", "acct_1");
  world.createObject({ id: "furniture_room", name: "Furniture", parent: "$space", owner: actor });
  return { world, actor };
}

describe("identity export (§8 schema)", () => {
  it("exports api_keys verbatim and the reachable identity graph — nothing else", () => {
    const { world, actor } = oldWorld();
    const identity = exportIdentity(world.exportWorld());
    expect(identity.kind).toBe("woo.identity_export.v1");
    expect(Object.keys(identity.api_keys)).toEqual([KEY_ID]);
    const ids = identity.actors.map((entry) => entry.id);
    expect(ids).toContain(actor);
    expect(ids).toContain("acct_1");
    // World furniture and catalog classes never ride.
    expect(ids).not.toContain("furniture_room");
    expect(ids).not.toContain("$account");
    // Dependency order: the account precedes the actor that binds it.
    expect(ids.indexOf("acct_1")).toBeLessThan(ids.indexOf(actor));
    // The allow-list carries the login-critical props.
    const account = identity.actors.find((entry) => entry.id === "acct_1");
    expect(account?.props).toMatchObject({ email: "one@example.com", password_salt: "salt-1", password_hash: "hash-1" });
    // Round-trips through JSON + the shape check (the runbook moves the
    // file between machines).
    expect(parseIdentityExport(JSON.parse(JSON.stringify(identity))).actors).toHaveLength(identity.actors.length);
  });
});

describe("identity import into a fresh install (item A + B)", () => {
  it("a carried apikey authenticates in the freshly installed world; the import is idempotent", async () => {
    const { world, actor } = oldWorld();
    const identity = exportIdentity(world.exportWorld());

    const plan = await planNetInstall({ graft: (fresh) => importIdentity(fresh, identity) });
    expect(plan.epoch).toBe(netInstallEpoch());

    // THE proof: the old key mints a session in the new world.
    const session = plan.world.auth(`apikey:${KEY_ID}:${KEY_SECRET}`);
    expect(session.actor).toBe(actor);
    // The binding survived, the actor rehomed (no carried location).
    expect(plan.world.propOrNull(actor, "account")).toBe("acct_1");

    // Idempotent re-import (the migration rule): same counts, no throw,
    // and the key still authenticates.
    const again = await importIdentity(plan.world, identity);
    expect(again).toEqual({ actors: identity.actors.length, api_keys: 1, unattributed: [] });
    expect(plan.world.auth(`apikey:${KEY_ID}:${KEY_SECRET}`).actor).toBe(actor);

    // The carried identity partitioned like any other world state: the
    // identity cell to the catalog scope, the actor to its cluster.
    expect(plan.partitions.get(CATALOG_SCOPE)?.some((cell) => cell.object === "$system" && cell.name === "api_keys")).toBe(true);
    expect([...plan.partitions.keys()]).toContain(`cluster:${actor}`);
  });

  it("carries an actor's composed programmer surface (features) across the cutover", async () => {
    const { world, actor } = oldWorld();
    // Compose the programmer surface onto the carried actor.
    world.setObjectFlags("$wiz", actor, { programmer: true });
    expect(world.actorHasSurface(actor, "$programmer")).toBe(true);

    const identity = exportIdentity(world.exportWorld());
    const carried = identity.actors.find((entry) => entry.id === actor);
    expect(carried?.props.features).toEqual(["$programmer"]);

    const plan = await planNetInstall({ graft: (fresh) => importIdentity(fresh, identity) });
    // The surface survives the graft: flag AND feature, not flag alone.
    expect(plan.world.object(actor).flags.programmer).toBe(true);
    expect(plan.world.actorHasSurface(actor, "$programmer")).toBe(true);
  });

  it("drops a carried feature ref that does not reinstall, keeping resolvable ones", async () => {
    const { world, actor } = oldWorld();
    // A custom feature (world furniture, not carried) alongside the bundled
    // programmer surface. Attach both directly.
    world.createObject({ id: "custom_feature", name: "Custom", parent: "$thing", owner: "$wiz" });
    world.setObjectFlags("$wiz", actor, { programmer: true }); // composes $programmer
    world.setProp(actor, "features", [...(world.getProp(actor, "features") as string[]), "custom_feature"]);
    expect(world.getProp(actor, "features")).toEqual(["$programmer", "custom_feature"]);

    const identity = exportIdentity(world.exportWorld());
    const plan = await planNetInstall({ graft: (fresh) => importIdentity(fresh, identity) });

    // $programmer reinstalled and resolves; custom_feature (not carried) is
    // dropped rather than left dangling.
    expect(plan.world.objects.has("custom_feature")).toBe(false);
    expect(plan.world.getProp(actor, "features")).toEqual(["$programmer"]);
    expect(plan.world.actorHasSurface(actor, "$programmer")).toBe(true);
  });

  it("carries the authority anchor so a co-located identity family lands in one cluster", async () => {
    const old = createWorld();
    const human = old.auth("guest:auth-human").actor;
    old.createObject({ id: "acct_auth", parent: "$account", owner: "$wiz", name: "auth" });
    old.setProp("acct_auth", "email", "auth@example.com" as never);
    old.setProp(human, "account", "acct_auth" as never);
    old.ensureApiKey("$wiz", human, "auth-human-key", "auth-human-secret", "human");
    const agent = old.createObject({ id: "agent_auth", parent: "$agent", owner: human, name: "agent" }).id;
    old.ensureApiKey("$wiz", agent, "auth-agent-key", "auth-agent-secret", "agent");
    // Anchor the account and the owned agent to the human authority root.
    old.object("acct_auth").anchor = human;
    old.object(agent).anchor = human;

    const identity = exportIdentity(old.exportWorld());
    // The anchor rides the export.
    expect(identity.actors.find((a) => a.id === "acct_auth")?.anchor).toBe(human);
    expect(identity.actors.find((a) => a.id === agent)?.anchor).toBe(human);

    const plan = await planNetInstall({ graft: (fresh) => importIdentity(fresh, identity) });
    // Human, account, and agent all partition into cluster:<human> — one
    // authoritative scope, so a promote/demote turn touching agent + account can
    // commit atomically without a catalog write.
    const scopeOf = (id: string): string | undefined =>
      [...plan.partitions.entries()].find(([, cells]) => cells.some((c) => c.object === id))?.[0];
    expect(scopeOf(human)).toBe(`cluster:${human}`);
    expect(scopeOf("acct_auth")).toBe(`cluster:${human}`);
    expect(scopeOf(agent)).toBe(`cluster:${human}`);
  });

  it("the real provisioning path anchors the account and agents to the human authority root", async () => {
    const world = createWorld();
    const start = await world.beginSignup("family@example.com", "password123");
    const verify = world.verifySignup(start.verification_token);
    const human = verify.actor as string;
    const account = world.propOrNull(human, "account") as string;
    world.setProp(account, "programmer_grant_quota", 10);
    // Signup recorded the authority root and anchored the account to it.
    expect(world.propOrNull(account, "authority_root")).toBe(human);
    expect(world.object(account).anchor).toBe(human);

    // create_agent anchors the new agent to the same root.
    const prov = (await world.directCall("prov", human, human, "create_agent", ["FamilyBot", "", true])) as unknown as {
      op: string; result: { actor_id: string };
    };
    const agent = prov.result.actor_id;
    expect(world.object(agent).anchor).toBe(human);

    // The whole family carries into cluster:<human>.
    const identity = exportIdentity(world.exportWorld());
    const plan = await planNetInstall({ graft: (fresh) => importIdentity(fresh, identity) });
    const scopeOf = (id: string): string | undefined =>
      [...plan.partitions.entries()].find(([, cells]) => cells.some((c) => c.object === id))?.[0];
    expect(scopeOf(human)).toBe(`cluster:${human}`);
    expect(scopeOf(account)).toBe(`cluster:${human}`);
    expect(scopeOf(agent)).toBe(`cluster:${human}`);
  });

  it("multi-actor accounts keep their ORIGINAL primary_actor across the carry (reviewer finding 3)", async () => {
    // The reviewer's repro shape: the primary is z_human, but an agent
    // whose id sorts FIRST is also bound — a rebuild-from-first-sorted
    // would hand password logins to the agent.
    const world = createWorld();
    world.createObject({ id: "z_human", name: "Zed", parent: "$human", owner: "$wiz" });
    world.createObject({ id: "a_agent", name: "Agent", parent: "$agent", owner: "z_human" });
    world.createObject({ id: "acct_multi", name: "Multi", parent: "$account", owner: "$wiz" });
    world.setProp("acct_multi", "email", "multi@example.com");
    world.setProp("acct_multi", "password_hash", "hash-multi");
    world.setProp("acct_multi", "primary_actor", "z_human");
    world.setProp("acct_multi", "actors", ["z_human", "a_agent"]);
    world.setProp("z_human", "account", "acct_multi");
    world.setProp("a_agent", "account", "acct_multi");
    const identity = exportIdentity(world.exportWorld());

    const account = identity.actors.find((entry) => entry.id === "acct_multi");
    expect(account?.props.primary_actor).toBe("z_human");
    expect(account?.props.actors).toEqual(["z_human", "a_agent"]);

    const plan = await planNetInstall({ graft: (fresh) => importIdentity(fresh, identity) });
    expect(plan.world.propOrNull("acct_multi", "primary_actor")).toBe("z_human");
    expect(plan.world.propOrNull("acct_multi", "actors")).toEqual(["z_human", "a_agent"]);
  });

  it("carries actor-owned credential authority and an aged re-import cannot resurrect revocation", async () => {
    const old = createWorld();
    old.createObject({
      id: "agent_owned_key",
      name: "Owned Key Agent",
      parent: "$agent",
      owner: "$wiz",
      location: "$nowhere"
    });
    const key = old.createApiKey("$wiz", "agent_owned_key", "carry routed authority");
    const identity = exportIdentity(old.exportWorld());

    expect(identity.api_keys).toEqual({});
    expect(identity.actors.map((actor) => actor.id)).toContain("agent_owned_key");
    expect(identity.actors.find((actor) => actor.id === "agent_owned_key")?.props.api_keys).toMatchObject({
      [key.id]: expect.objectContaining({ actor: "agent_owned_key", hash: expect.any(String), salt: expect.any(String) })
    });

    const fresh = createWorld();
    await importIdentity(fresh, identity);
    expect(fresh.auth(`apikey:${key.id}:${key.secret}`).actor).toBe("agent_owned_key");

    expect(fresh.revokeApiKey("$wiz", key.id)).toBe(true);
    const revoked = fresh.propOrNull("agent_owned_key", "api_keys") as Record<string, Record<string, unknown>>;
    expect(revoked[key.id]?.revoked_at).toEqual(expect.any(Number));

    // The carry file predates revocation. Existing authority wins per key.
    await importIdentity(fresh, identity);
    const after = fresh.propOrNull("agent_owned_key", "api_keys") as Record<string, Record<string, unknown>>;
    expect(after[key.id]?.revoked_at).toBe(revoked[key.id]?.revoked_at);
    expect(() => fresh.auth(`apikey:${key.id}:${key.secret}`)).toThrow(/not found or revoked/);
  });

  it("carries deactivated_at (reviewer finding 2) and rebuilds primary_actor only as the fallback", async () => {
    const world = createWorld();
    world.createObject({ id: "h_only", name: "H", parent: "$human", owner: "$wiz" });
    world.createObject({ id: "acct_fb", name: "FB", parent: "$account", owner: "$wiz" });
    world.setProp("acct_fb", "email", "fb@example.com");
    world.setProp("acct_fb", "password_hash", "hash-fb");
    world.setProp("acct_fb", "deactivated_at", 12345);
    // NO primary_actor in the old world: the import fallback rebuilds it
    // from the actor-side binding.
    world.setProp("h_only", "account", "acct_fb");
    const identity = exportIdentity(world.exportWorld());
    const plan = await planNetInstall({ graft: (fresh) => importIdentity(fresh, identity) });
    expect(plan.world.propOrNull("acct_fb", "deactivated_at")).toBe(12345);
    expect(plan.world.propOrNull("acct_fb", "primary_actor")).toBe("h_only");
  });

  it("aborts on dangling refs — an apikey pointing at an uncarried actor fails the import (§8: abort, not warn)", async () => {
    const { world } = oldWorld();
    const identity = exportIdentity(world.exportWorld());
    const broken = {
      ...identity,
      api_keys: { ...identity.api_keys, ghost: { hash: "h", salt: "s", actor: "obj_never_carried", label: null, created_at: 1 } }
    };
    await expect(planNetInstall({ graft: (fresh) => importIdentity(fresh, broken) })).rejects.toThrow(/dangling refs[\s\S]*obj_never_carried/);
  });
});

describe("customer attribution seeding (audit.md AU3.1)", () => {
  it("derives customer_of for every imported actor and partitions it to the actor's cluster", async () => {
    const { world, actor } = oldWorld();
    const identity = exportIdentity(world.exportWorld());
    const plan = await planNetInstall({ graft: (fresh) => importIdentity(fresh, identity) });

    // The account-bound actor attributes to its account (rule 1)...
    const attr = normalizeCustomerAttribution(plan.world.propOrNull(actor, PROP_CUSTOMER_OF));
    expect(attr).toEqual({ customer: "acct_1", derived_via: "account" });

    // ...and the cell partitions to the actor's OWN cluster scope, the
    // same home as its session cells (AU3.1: gateway warm serves it).
    const cluster = plan.partitions.get(`cluster:${actor}`) ?? [];
    const cell = cluster.find(
      (c) => c.kind === "property_cell" && c.object === actor && c.name === PROP_CUSTOMER_OF
    );
    expect(cell).toBeDefined();
    expect(normalizeCustomerAttribution(cell?.value)).toEqual({ customer: "acct_1", derived_via: "account" });
  });

  it("reports uncovered actors as unattributed instead of guessing or aborting", async () => {
    // A synthetic plain $actor: no account, no wizard flag, not a guest —
    // no AU3.1 rule covers it. Self-owned so the ref inventory verifies.
    const identity = {
      kind: "woo.identity_export.v1" as const,
      exported_at: 0,
      api_keys: {},
      actors: [
        {
          id: "plain_actor_1",
          parent: "$actor",
          name: "Plain",
          owner: "plain_actor_1",
          flags: {},
          props: {}
        }
      ]
    };
    const result = await importIdentity(createWorld(), identity);
    expect(result.unattributed).toEqual(["plain_actor_1"]);
  });

  it("re-import is idempotent for attribution (no value churn)", async () => {
    const { world } = oldWorld();
    const identity = exportIdentity(world.exportWorld());
    const fresh = createWorld();
    const first = await importIdentity(fresh, identity);
    const again = await importIdentity(fresh, identity);
    expect(again.unattributed).toEqual(first.unattributed);
  });
});

describe("scope attribution at install (AU3.3)", () => {
  it("stamps the catalog scope to operator and each cluster to its actor's customer", async () => {
    const { world, actor } = oldWorld();
    const identity = exportIdentity(world.exportWorld());
    const plan = await planNetInstall({ graft: (fresh) => importIdentity(fresh, identity) });
    expect(plan.attributions.get(CATALOG_SCOPE)).toMatchObject({
      customer: "operator",
      derived_via: "operator",
      stamped_at_epoch: plan.epoch
    });
    expect(plan.attributions.get(`cluster:${actor}`)).toMatchObject({
      customer: "acct_1",
      derived_via: "cluster_actor"
    });
    // Wizard-owned rooms in the bundled world attribute to operator.
    for (const [scope, attr] of plan.attributions) {
      if (scope.startsWith("room:")) {
        expect(attr.customer.length).toBeGreaterThan(0);
      }
    }
  });
});
