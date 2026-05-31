import { describe, expect, it } from "vitest";
import { createWorld, createWorldFromSerialized, mergeHostScopedSeedWithStatus, nonEmptyHostScopedWorld } from "../src/core/bootstrap";
import { buildShadowBrowserOpenExecutableSeedTransfer, createShadowBrowserRelayShim } from "../src/core/shadow-browser-node";
import type { ShadowPropertyCellPage } from "../src/core/shadow-state-pages";

let nextId = 1;
function makeActor(world: ReturnType<typeof createWorld>, parent: string = "$player"): string {
  const id = `obj_test_actor_${nextId++}`;
  world.createObject({ id, name: id, parent, owner: "$wiz", location: null });
  return id;
}

function expectError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err: unknown) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, got success`);
}

describe("auth credentials: $system:set_object_flags / mint_session_for / api keys", () => {
  it("keeps def-less values owner-only instead of synthesizing public read perms", () => {
    const world = createWorld({ catalogs: false });
    world.createObject({ id: "legacy_secret_box", name: "Legacy Secret Box", parent: "$thing", owner: "$wiz", location: null });
    world.setProp("legacy_secret_box", "legacy_secret", "sealed");
    const guest = world.auth("guest:legacy-secret-reader").actor;

    expect(world.propertyInfo("legacy_secret_box", "legacy_secret")).toMatchObject({ owner: "$wiz", perms: "" });
    expect(world.getPropForActor("$wiz", "legacy_secret_box", "legacy_secret")).toBe("sealed");
    expectError(() => world.getPropForActor(guest, "legacy_secret_box", "legacy_secret"), "E_PERM");
  });

  it("keeps $system credential maps unreadable to programmer-flagged non-wizards", () => {
    const world = createWorld({ catalogs: false });
    const programmer = world.auth("guest:credential-map-reader").actor;
    world.object(programmer).flags.programmer = true;
    world.createApiKey("$wiz", "$wiz", "system-map-test");

    expect(world.propertyInfo("$system", "api_keys")).toMatchObject({ owner: "$wiz", perms: "" });
    expect(world.propertyInfo("$system", "bearer_tokens")).toMatchObject({ owner: "$wiz", perms: "" });
    expectError(() => world.getPropForActor(programmer, "$system", "api_keys"), "E_PERM");
    expectError(() => world.getPropForActor(programmer, "$system", "bearer_tokens"), "E_PERM");
  });

  it("redacts $system credential map values from browser executable seeds", () => {
    const world = createWorld({ catalogs: false });
    world.setProp("$system", "api_keys", { leaked: { hash: "raw-api-secret", salt: "raw-api-salt" } });
    world.setProp("$system", "bearer_tokens", { "raw-bearer-token": { actor: "$wiz", expires_at: Date.now() + 60_000 } });
    const relay = createShadowBrowserRelayShim({
      node: "node:credential-seed-redaction",
      scope: "$nowhere",
      serialized: world.exportWorld()
    });

    const transfer = buildShadowBrowserOpenExecutableSeedTransfer(relay, "$nowhere", "browser:credential-seed-redaction", "$wiz", null);
    const encoded = JSON.stringify(transfer);
    const sensitivePages = transfer.inline_pages
      .filter((page): page is ShadowPropertyCellPage => page.object === "$system" && page.page === "property_cell" && (page.name === "api_keys" || page.name === "bearer_tokens"))
      .map((page) => ({ name: page.name, hasValue: page.has_value, value: page.value, version: page.version }));

    expect(encoded).not.toContain("raw-api-secret");
    expect(encoded).not.toContain("raw-api-salt");
    expect(encoded).not.toContain("raw-bearer-token");
    expect(sensitivePages).toEqual([
      { name: "api_keys", hasValue: false, value: undefined, version: 0 },
      { name: "bearer_tokens", hasValue: false, value: undefined, version: 0 }
    ]);
  });

  it("redacts signup invite codes from host seeds and browser executable seeds", () => {
    const world = createWorld();
    world.setProp("$system", "signup_invites", [{ code: "invite-secret", expires_at: Date.now() + 60_000, used_by: null }]);

    const hostSeed = world.buildHostSeedForDelivery("the_deck");
    const hostEncoded = JSON.stringify(hostSeed);
    const systemEntry = hostSeed.objects.find((obj) => obj.id === "$system");
    expect(hostEncoded).not.toContain("invite-secret");
    expect(systemEntry?.properties.map(([name]) => name)).not.toContain("signup_invites");
    expect(systemEntry?.propertyVersions.map(([name]) => name)).not.toContain("signup_invites");

    const relay = createShadowBrowserRelayShim({
      node: "node:invite-seed-redaction",
      scope: "the_deck",
      serialized: world.exportWorld()
    });
    const transfer = buildShadowBrowserOpenExecutableSeedTransfer(relay, "the_deck", "browser:invite-seed-redaction", "$wiz", null);
    const transferEncoded = JSON.stringify(transfer);
    const invitePages = transfer.inline_pages
      .filter((page): page is ShadowPropertyCellPage => page.object === "$system" && page.page === "property_cell" && page.name === "signup_invites")
      .map((page) => ({ hasValue: page.has_value, value: page.value, version: page.version }));

    expect(transferEncoded).not.toContain("invite-secret");
    expect(invitePages).toEqual([{ hasValue: false, value: undefined, version: 0 }]);
  });

  it("scrubs already-stored $system credential ledgers from satellite host slices", () => {
    const gateway = createWorld();
    const seed = gateway.buildHostSeedForDelivery("the_deck");
    const stored = createWorld();
    stored.setProp("$system", "api_keys", { copied: { hash: "stored-api-hash", salt: "stored-api-salt" } });
    stored.setProp("$system", "bearer_tokens", { "legacy-raw-bearer": { actor: "$wiz", expires_at: Date.now() + 60_000 } });
    stored.setProp("$system", "pending_email_verifications", [{ token_hash: "stored-verification-hash", account_id: "$account", expires_at: Date.now() + 60_000 }]);
    stored.setProp("$system", "signup_invites", [{ code: "stored-invite-code", expires_at: Date.now() + 60_000, used_by: null }]);
    stored.setProp("$system", "provision_state_nonces", [{ state_hash: "stored-state-hash", issued_at: Date.now() }]);
    const storedSlice = nonEmptyHostScopedWorld(stored.exportWorld(), "the_deck");
    expect(storedSlice).not.toBeNull();

    const merged = mergeHostScopedSeedWithStatus(storedSlice!, seed, "the_deck");
    const systemEntry = merged.world.objects.find((obj) => obj.id === "$system");
    const encoded = JSON.stringify(merged.world);

    expect(merged.changed).toBe(true);
    expect(encoded).not.toContain("stored-api-hash");
    expect(encoded).not.toContain("legacy-raw-bearer");
    expect(encoded).not.toContain("stored-verification-hash");
    expect(encoded).not.toContain("stored-invite-code");
    expect(encoded).not.toContain("stored-state-hash");
    expect(systemEntry?.properties.map(([name]) => name)).not.toEqual(expect.arrayContaining([
      "api_keys",
      "bearer_tokens",
      "pending_email_verifications",
      "signup_invites",
      "provision_state_nonces"
    ]));
    expect(systemEntry?.propertyVersions.map(([name]) => name)).not.toEqual(expect.arrayContaining([
      "api_keys",
      "bearer_tokens",
      "pending_email_verifications",
      "signup_invites",
      "provision_state_nonces"
    ]));
    expect(mergeHostScopedSeedWithStatus(merged.world, seed, "the_deck").changed).toBe(false);
  });

  it("sets and clears authority flags via the wizard-only mutator", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    expect(world.object(target).flags.wizard).toBeFalsy();
    const after = world.setObjectFlags("$wiz", target, { wizard: true, programmer: true });
    expect(after.wizard).toBe(true);
    expect(after.programmer).toBe(true);
    const reverted = world.setObjectFlags("$wiz", target, { wizard: false });
    expect(reverted.wizard).toBe(false);
    expect(reverted.programmer).toBe(true);
  });

  it("rejects flag mutation from a non-wizard actor", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const guest = world.auth("guest:nonwiz").actor;
    expectError(() => world.setObjectFlags(guest, target, { wizard: true }), "E_PERM");
    expect(world.object(target).flags.wizard).toBeFalsy();
  });

  it("rejects non-bool flag values with E_TYPE", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    expectError(() => world.setObjectFlags("$wiz", target, { wizard: "yes" as unknown as boolean }), "E_TYPE");
  });

  it("audits set_object_flags with target + per-flag from/to into wizard_actions", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    world.setProp("$system", "wizard_actions", []);
    world.setObjectFlags("$wiz", target, { wizard: true });
    const actions = world.getProp("$system", "wizard_actions") as Array<Record<string, unknown>>;
    const entry = actions[actions.length - 1];
    expect(entry.action).toBe("set_object_flags");
    expect(entry.target).toBe(target);
    expect((entry.changes as Record<string, { from: boolean; to: boolean }>).wizard).toEqual({ from: false, to: true });
  });

  it("mints a session bound to the target actor", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const sess = world.createSessionForActor(target, "bearer");
    expect(sess.actor).toBe(target);
    expect(sess.tokenClass).toBe("bearer");
    expect(sess.id).toMatch(/^session-[0-9a-f]{32}$/);
  });

  it("mints unguessable session ids instead of counter ids", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const first = world.createSessionForActor(target, "bearer");
    const second = world.createSessionForActor(target, "bearer");

    expect(first.id).toMatch(/^session-[0-9a-f]{32}$/);
    expect(second.id).toMatch(/^session-[0-9a-f]{32}$/);
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toMatch(/^session-\d+$/);
    expect(second.id).not.toMatch(/^session-\d+$/);
  });

  it("createApiKey enforces wizard authority and actor target type", () => {
    const world = createWorld({ catalogs: false });
    const guest = world.auth("guest:nonwiz").actor;
    const actorTarget = makeActor(world);
    expectError(() => world.createApiKey(guest, actorTarget, null), "E_PERM");
    const nonActorId = `obj_test_thing_${nextId++}`;
    world.createObject({ id: nonActorId, name: nonActorId, parent: "$thing", owner: "$wiz", location: null });
    expectError(() => world.createApiKey("$wiz", nonActorId, null), "E_TYPE");
    expectError(() => world.createApiKey("$wiz", "obj_does_not_exist", null), "E_OBJNF");
  });

  it("createApiKey returns a one-time secret and stores only a salted hash", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const result = world.createApiKey("$wiz", target, "test");
    expect(result.id).toMatch(/^[0-9a-f]{32}$/);
    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.actor).toBe(target);
    expect(result.label).toBe("test");
    const stored = world.getProp("$system", "api_keys") as Record<string, Record<string, unknown>>;
    expect(stored[result.id].actor).toBe(target);
    expect(typeof stored[result.id].hash).toBe("string");
    expect(typeof stored[result.id].salt).toBe("string");
    expect(stored[result.id].hash).not.toBe(result.secret);
    expect(JSON.stringify(stored[result.id])).not.toContain(result.secret);
  });

  it("authenticates via apikey:<id>:<secret> and binds the session to the recorded actor", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const key = world.createApiKey("$wiz", target, "primary");
    const sess = world.auth(`apikey:${key.id}:${key.secret}`);
    expect(sess.actor).toBe(target);
    expect(sess.tokenClass).toBe("apikey");
  });

  it("ensureApiKey creates a caller-specified key and is idempotent for the same secret", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const key = world.ensureApiKey("$wiz", target, "localdev", "local-secret", "localdev-test");
    expect(key).toMatchObject({ id: "localdev", secret: "local-secret", actor: target, label: "localdev-test", created: true });
    expect(world.auth("apikey:localdev:local-secret").actor).toBe(target);

    const again = world.ensureApiKey("$wiz", target, "localdev", "local-secret", "ignored-label");
    expect(again.created).toBe(false);
    expect(again.label).toBe("localdev-test");
    expect(world.auth("apikey:localdev:local-secret").actor).toBe(target);
  });

  it("ensureApiKey rejects conflicting ids and wrong presented secrets", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const other = makeActor(world);
    world.ensureApiKey("$wiz", target, "localdev-conflict", "local-secret", "localdev-test");
    expectError(() => world.ensureApiKey("$wiz", target, "localdev-conflict", "wrong-secret", "localdev-test"), "E_PERM");
    expectError(() => world.ensureApiKey("$wiz", other, "localdev-conflict", "local-secret", "localdev-test"), "E_PERM");
  });

  it("rejects unknown id and wrong secret with the same E_NOSESSION (no oracle)", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const key = world.createApiKey("$wiz", target, null);
    expectError(() => world.auth(`apikey:no_such_id:${key.secret}`), "E_NOSESSION");
    expectError(() => world.auth(`apikey:${key.id}:wrong_secret_value`), "E_NOSESSION");
    expectError(() => world.auth(`apikey:malformed`), "E_NOSESSION");
  });

  it("revokeApiKey blocks future auths and closes sessions minted from the key", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const key = world.createApiKey("$wiz", target, null);
    const sess = world.auth(`apikey:${key.id}:${key.secret}`);
    expect(sess.apikeyId).toBe(key.id);
    expect(world.revokeApiKey("$wiz", key.id)).toBe(true);
    // Already-revoked records report false to disambiguate from "never existed".
    expect(world.revokeApiKey("$wiz", key.id)).toBe(false);
    expectError(() => world.auth(`apikey:${key.id}:${key.secret}`), "E_NOSESSION");
    // The session minted under the revoked key is gone — resume fails.
    expectError(() => world.auth(`session:${sess.id}`), "E_NOSESSION");
  });

  it("only sessions for the revoked key are closed; sibling keys keep working", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const keyA = world.createApiKey("$wiz", target, "a");
    const keyB = world.createApiKey("$wiz", target, "b");
    const sessA = world.auth(`apikey:${keyA.id}:${keyA.secret}`);
    const sessB = world.auth(`apikey:${keyB.id}:${keyB.secret}`);
    world.revokeApiKey("$wiz", keyA.id);
    expectError(() => world.auth(`session:${sessA.id}`), "E_NOSESSION");
    expect(world.auth(`session:${sessB.id}`).id).toBe(sessB.id);
  });

  it("authApiKey writes last_seen_at on the key record", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const key = world.createApiKey("$wiz", target, null);
    const before = Date.now();
    world.auth(`apikey:${key.id}:${key.secret}`);
    const stored = world.getProp("$system", "api_keys") as Record<string, Record<string, unknown>>;
    expect(typeof stored[key.id].last_seen_at).toBe("number");
    expect(stored[key.id].last_seen_at as number).toBeGreaterThanOrEqual(before);
  });

  it("listApiKeys returns last_seen_at and revoked_at metadata, and is wizard-only", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const key = world.createApiKey("$wiz", target, "label-1");
    world.auth(`apikey:${key.id}:${key.secret}`);
    world.revokeApiKey("$wiz", key.id);
    const keys = world.listApiKeys("$wiz");
    expect(keys.find((k) => k.id === key.id)).toMatchObject({
      id: key.id,
      actor: target,
      label: "label-1",
      last_seen_at: expect.any(Number),
      revoked_at: expect.any(Number)
    });
    expect(JSON.stringify(keys)).not.toContain(key.secret);
    expect(JSON.stringify(keys)).not.toContain("hash");
    expect(JSON.stringify(keys)).not.toContain("salt");
    const guest = world.auth("guest:nonwiz").actor;
    expectError(() => world.listApiKeys(guest), "E_PERM");
  });

  describe("owner-scoped apikey ops (for $block:mint_apikey etc.)", () => {
    function makeOwnedActor(world: ReturnType<typeof createWorld>, owner: string): string {
      const id = `obj_test_owned_actor_${nextId++}`;
      world.createObject({ id, name: id, parent: "$player", owner, location: null });
      return id;
    }

    it("createApiKeyForOwner permits the owner of the target to mint", () => {
      const world = createWorld({ catalogs: false });
      const owner = world.auth("guest:block-owner").actor;
      const block = makeOwnedActor(world, owner);
      const key = world.createApiKeyForOwner(owner, block, "owner-mint");
      expect(key.actor).toBe(block);
      const sess = world.auth(`apikey:${key.id}:${key.secret}`);
      expect(sess.actor).toBe(block);
    });

    it("createApiKeyForOwner rejects when caller is not owner and not wizard", () => {
      const world = createWorld({ catalogs: false });
      const owner = world.auth("guest:owner-a").actor;
      const stranger = world.auth("guest:owner-b").actor;
      const block = makeOwnedActor(world, owner);
      expectError(() => world.createApiKeyForOwner(stranger, block, null), "E_PERM");
    });

    it("createApiKeyForOwner permits a wizard regardless of ownership", () => {
      const world = createWorld({ catalogs: false });
      const owner = world.auth("guest:owner-c").actor;
      const block = makeOwnedActor(world, owner);
      // Wizard bypasses; useful for admin reissue when an owner is gone.
      const key = world.createApiKeyForOwner("$wiz", block, "wizard-mint");
      expect(key.actor).toBe(block);
    });

    it("revokeApiKey allows the bound actor's owner (no wizard required)", () => {
      const world = createWorld({ catalogs: false });
      const owner = world.auth("guest:owner-d").actor;
      const block = makeOwnedActor(world, owner);
      const key = world.createApiKeyForOwner(owner, block, null);
      const sess = world.auth(`apikey:${key.id}:${key.secret}`);
      expect(world.revokeApiKey(owner, key.id)).toBe(true);
      expectError(() => world.auth(`session:${sess.id}`), "E_NOSESSION");
    });

    it("revokeApiKey rejects callers who are neither owner nor wizard", () => {
      const world = createWorld({ catalogs: false });
      const owner = world.auth("guest:owner-e").actor;
      const stranger = world.auth("guest:owner-f").actor;
      const block = makeOwnedActor(world, owner);
      const key = world.createApiKey("$wiz", block, null);
      expectError(() => world.revokeApiKey(stranger, key.id), "E_PERM");
    });

    it("listApiKeysForOwner returns only keys for actors the caller owns", () => {
      const world = createWorld({ catalogs: false });
      const ownerA = world.auth("guest:owner-g").actor;
      const ownerB = world.auth("guest:owner-h").actor;
      const blockA = makeOwnedActor(world, ownerA);
      const blockB = makeOwnedActor(world, ownerB);
      const keyA = world.createApiKeyForOwner(ownerA, blockA, "for-a");
      const keyB = world.createApiKeyForOwner(ownerB, blockB, "for-b");
      const seenByA = world.listApiKeysForOwner(ownerA).map((k) => k.id);
      expect(seenByA).toContain(keyA.id);
      expect(seenByA).not.toContain(keyB.id);
      // Wizard sees everything.
      const seenByWiz = world.listApiKeysForOwner("$wiz").map((k) => k.id);
      expect(seenByWiz).toContain(keyA.id);
      expect(seenByWiz).toContain(keyB.id);
    });
  });

  it("api keys persist across world serialize/reload", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const key = world.createApiKey("$wiz", target, "saved");
    const dump = world.exportWorld();
    const reloaded = createWorldFromSerialized(dump, { persist: false });
    const sess = reloaded.auth(`apikey:${key.id}:${key.secret}`);
    expect(sess.actor).toBe(target);
    expect(sess.tokenClass).toBe("apikey");
  });

  it("session.apikeyId survives serialize/hydrate so post-restart revoke still tears the session down", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const key = world.createApiKey("$wiz", target, "rehydrate");
    const sess = world.auth(`apikey:${key.id}:${key.secret}`);
    expect(sess.apikeyId).toBe(key.id);
    // Round-trip through full serialize/reload — emulates a DO restart.
    const dump = world.exportWorld();
    const reloaded = createWorldFromSerialized(dump, { persist: false });
    // The hydrated session must still know which apikey minted it, or the
    // revoke walk below would leave session:<id> usable until normal expiry.
    const hydrated = reloaded.sessions.get(sess.id);
    expect(hydrated?.apikeyId).toBe(key.id);
    expect(reloaded.revokeApiKey("$wiz", key.id)).toBe(true);
    expectError(() => reloaded.auth(`session:${sess.id}`), "E_NOSESSION");
  });
});
