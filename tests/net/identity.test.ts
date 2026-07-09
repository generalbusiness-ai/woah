// Identity export/import round-trip (cutover item B; §8-approved schema).
// The whole point of the carry-over: an apikey minted in the OLD world
// authenticates in a FRESHLY INSTALLED world after import — proven here
// end-to-end through world.auth, not by comparing maps.
import { describe, expect, it } from "vitest";
import { createWorld } from "../../src/core/bootstrap";
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
    expect(again).toEqual({ actors: identity.actors.length, api_keys: 1 });
    expect(plan.world.auth(`apikey:${KEY_ID}:${KEY_SECRET}`).actor).toBe(actor);

    // The carried identity partitioned like any other world state: the
    // identity cell to the catalog scope, the actor to its cluster.
    expect(plan.partitions.get(CATALOG_SCOPE)?.some((cell) => cell.object === "$system" && cell.name === "api_keys")).toBe(true);
    expect([...plan.partitions.keys()]).toContain(`cluster:${actor}`);
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
