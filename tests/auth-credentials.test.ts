import { describe, expect, it } from "vitest";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";

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
    expect(sess.id).toMatch(/^session-/);
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

  it("rejects unknown id and wrong secret with the same E_NOSESSION (no oracle)", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const key = world.createApiKey("$wiz", target, null);
    expectError(() => world.auth(`apikey:no_such_id:${key.secret}`), "E_NOSESSION");
    expectError(() => world.auth(`apikey:${key.id}:wrong_secret_value`), "E_NOSESSION");
    expectError(() => world.auth(`apikey:malformed`), "E_NOSESSION");
  });

  it("revokeApiKey blocks future auths but does not invalidate existing sessions", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const key = world.createApiKey("$wiz", target, null);
    const sess = world.auth(`apikey:${key.id}:${key.secret}`);
    expect(world.revokeApiKey("$wiz", key.id)).toBe(true);
    expect(world.revokeApiKey("$wiz", key.id)).toBe(false);
    expectError(() => world.auth(`apikey:${key.id}:${key.secret}`), "E_NOSESSION");
    const resumed = world.auth(`session:${sess.id}`);
    expect(resumed.id).toBe(sess.id);
  });

  it("listApiKeys returns metadata only and is wizard-only", () => {
    const world = createWorld({ catalogs: false });
    const target = makeActor(world);
    const key = world.createApiKey("$wiz", target, "label-1");
    const keys = world.listApiKeys("$wiz");
    expect(keys.find((k) => k.id === key.id)).toMatchObject({ id: key.id, actor: target, label: "label-1" });
    expect(JSON.stringify(keys)).not.toContain(key.secret);
    expect(JSON.stringify(keys)).not.toContain("hash");
    expect(JSON.stringify(keys)).not.toContain("salt");
    const guest = world.auth("guest:nonwiz").actor;
    expectError(() => world.listApiKeys(guest), "E_PERM");
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
});
