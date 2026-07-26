import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createWorld } from "../src/core/bootstrap";
import type { WooWorld } from "../src/core/world";

// The programmer environment composes the authoring surface onto an actor as a
// feature instead of reparenting it. These tests exercise the whole loop
// through the real dispatch path — provision, author, promote/demote — and pin
// the security invariants from the remediation plan §8.

type CallResult = { op: "result"; result: any } | { op: "error"; error: any };

async function provisionHuman(world: WooWorld, email: string): Promise<{ human: string; account: string }> {
  const start = await world.beginSignup(email, "password123");
  const verify = world.verifySignup(start.verification_token);
  const human = verify.actor as string;
  const account = world.propOrNull(human, "account") as string;
  // Grant programmer quota so promotion is allowed.
  world.setProp(account, "programmer_grant_quota", 10);
  return { human, account };
}

async function createAgent(world: WooWorld, human: string, name: string, programmer: boolean): Promise<string> {
  const res = (await world.directCall(`create-${name}`, human, human, "create_agent", [name, "", programmer])) as CallResult;
  if (res.op !== "result") throw new Error(`create_agent failed: ${JSON.stringify(res)}`);
  return res.result.actor_id as string;
}

describe("programmer surface (feature-composed)", () => {
  it("drops task perms to the actor in every surface-guarded prog wrapper (§8.8, no exceptions)", () => {
    const manifest = JSON.parse(readFileSync("catalogs/prog/manifest.json", "utf8"));
    const offenders: string[] = [];
    for (const cls of manifest.classes ?? []) {
      for (const verb of cls.verbs ?? []) {
        const source: string = verb.source ?? "";
        // A wrapper that gates on the surface (has_surface) runs $wiz-owned and
        // must drop to the actor before caller-controlled work. Wizard-only
        // verbs (no surface fallback) and pure listings are out of scope.
        if (!source.includes("has_surface(")) continue;
        if (!source.includes("set_task_perms(actor)")) offenders.push(`${cls.local_name}:${verb.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("provisions a programmer agent that keeps its $agent kind and gains the surface as a feature", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "kind@example.com");
    const agent = await createAgent(world, human, "kindbot", true);

    // Invariant §8.1: kind stays in ancestry; the surface is not in it.
    expect(world.isDescendantOf(agent, "$agent")).toBe(true);
    expect(world.isDescendantOf(agent, "$programmer")).toBe(false);
    expect(world.isDescendantOf(agent, "$builder")).toBe(false);
    // The surface is composed on as a feature and resolves for both surfaces.
    const features = world.getProp(agent, "features");
    expect(Array.isArray(features) && features.includes("$programmer")).toBe(true);
    expect(world.actorHasSurface(agent, "$programmer")).toBe(true);
    expect(world.actorHasSurface(agent, "$builder")).toBe(true);
    // Provisioning consumed programmer quota.
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);
    expect(world.object(agent).flags.programmer).toBe(true);
  });

  it("lets a feature-composed agent complete the authoring loop and attributes the work to the agent", async () => {
    const world = createWorld();
    const { human } = await provisionHuman(world, "loop@example.com");
    const agent = await createAgent(world, human, "loopbot", true);

    // Invariant §8.2: builder create works through the feature.
    const created = (await world.directCall("mk", agent, agent, "create", ["$thing", { name: "Widget" }])) as CallResult;
    expect(created.op).toBe("result");
    const widget = (created as any).result.id as string;
    // Invariant §8.7: the object is attributed to the agent, not $wiz.
    expect(world.object(widget).owner).toBe(agent);

    // Invariant §8.2: programmer verb install works through the feature.
    const installed = (await world.directCall("iv", agent, agent, "install_verb", [
      widget,
      "ping",
      "verb :ping() rxd { return \"pong\"; }",
      {}
    ])) as CallResult;
    expect(installed.op, JSON.stringify(installed)).toBe("result");

    // The installed verb is owned by the agent, not the catalog installer.
    const verbOwner = world.object(widget).verbs.find((v) => v.name === "ping")?.owner;
    expect(verbOwner).toBe(agent);

    // The new behaviour is reachable through its real route.
    const pong = (await world.directCall("pg", agent, widget, "ping", [])) as CallResult;
    expect(pong.op).toBe("result");
    expect((pong as any).result).toBe("pong");
  });

  it("places a new object in the author's inventory by default, and honours an explicit location (§6.4)", async () => {
    // LambdaMOO's @create puts the object in your inventory, and that placement
    // is what makes it REACHABLE: structural context (inventory / the room's
    // contents) is how a fresh object becomes visible to `look`, to the client,
    // and to an MCP session. An object created into no container exists only as
    // a returned id, so a verb installed on it can never become a tool.
    const world = createWorld();
    const { human } = await provisionHuman(world, "place@example.com");
    const agent = await createAgent(world, human, "placebot", true);

    const created = (await world.directCall("mk", agent, agent, "create", ["$thing", { name: "Carried" }])) as CallResult;
    expect(created.op, JSON.stringify(created)).toBe("result");
    const carried = (created as any).result.id as string;
    expect(world.object(carried).location).toBe(agent);
    expect((created as any).result.location).toBe(agent);
    expect(world.contentsOf(agent)).toContain(carried);

    // An explicit `location: null` is the escape hatch — deliberate nowhere.
    const loose = (await world.directCall("mk2", agent, agent, "create", ["$thing", { name: "Loose", location: null }])) as CallResult;
    expect(loose.op, JSON.stringify(loose)).toBe("result");
    expect(world.object((loose as any).result.id).location).toBeNull();

    // An explicit location still wins over the default.
    const room = world.object(agent).location as string;
    expect(room, "the agent must be somewhere for the explicit-location leg").toBeTruthy();
    const placed = (await world.directCall("mk3", agent, agent, "create", ["$thing", { name: "Placed", location: room }])) as CallResult;
    expect(placed.op, JSON.stringify(placed)).toBe("result");
    expect(world.object((placed as any).result.id).location).toBe(room);
  });

  it("refuses source mutation when the surface is attached but the programmer flag is absent (§8.3)", async () => {
    const world = createWorld();
    const { human } = await provisionHuman(world, "noflag@example.com");
    // A plain (non-programmer) agent; attach the surface with wizard authority
    // but never set the flag.
    const agent = await createAgent(world, human, "noflagbot", false);
    // Attach the surface directly (test fixture) but never set the flag. The
    // participant-facing attach path is covered separately in §8.6.
    world.setProp(agent, "features", ["$programmer"]);
    expect(world.actorHasSurface(agent, "$programmer")).toBe(true);
    expect(world.object(agent).flags.programmer ?? false).toBe(false);

    const created = (await world.directCall("mk", agent, agent, "create", ["$thing", { name: "Box" }])) as CallResult;
    expect(created.op).toBe("result"); // builder create needs surface only, no flag
    const box = (created as any).result.id as string;
    const res = (await world.directCall("iv", agent, agent, "install_verb", [
      box,
      "nope",
      "verb :nope() rxd { return 1; }",
      {}
    ])) as CallResult;
    expect(res.op).toBe("error");
    expect((res as any).error.code).toBe("E_PERM");
    expect((res as any).error.message).toContain("programmer flag");
  });

  it("exposes no authoring surface when the flag is set but no feature is attached (§8.4)", async () => {
    const world = createWorld();
    const { human } = await provisionHuman(world, "noface@example.com");
    const agent = await createAgent(world, human, "nofacebot", false);
    // Construct the flag-without-surface state directly. Normal paths keep flag
    // and surface consistent (setObjectFlags now reconciles the surface), so
    // this state is only reachable via legacy/corrupted data — which is exactly
    // what this invariant guards against.
    world.object(agent).flags.programmer = true;
    world.setProp(agent, "features", []);
    expect(world.object(agent).flags.programmer).toBe(true);
    expect(world.actorHasSurface(agent, "$programmer")).toBe(false);

    // The authoring verbs are simply not resolvable on the actor.
    const res = (await world.directCall("iv", agent, agent, "install_verb", [agent, "x", "verb :x() rxd { return 1; }", {}])) as CallResult;
    expect(res.op).toBe("error");
    expect((res as any).error.code).toBe("E_VERBNF");
  });

  it("cannot be used as a proxy by targeting the surface class directly (§8.5)", async () => {
    const world = createWorld();
    const { human } = await provisionHuman(world, "proxy@example.com");
    const agent = await createAgent(world, human, "proxybot", true);
    // Call install_verb with the surface class itself as the actor/target.
    const res = (await world.directCall("proxy", "$programmer", "$programmer", "install_verb", [
      "$programmer",
      "evil",
      "verb :evil() rxd { return 1; }",
      {}
    ])) as CallResult;
    expect(res.op).toBe("error");
    expect((res as any).error.code).toBe("E_PERM");
    // sanity: the real agent is unaffected
    expect(world.actorHasSurface(agent, "$programmer")).toBe(true);
  });

  it("cannot self-attach the surface through ordinary add_feature (§8.6)", async () => {
    const world = createWorld();
    const { human } = await provisionHuman(world, "self@example.com");
    const agent = await createAgent(world, human, "selfbot", false);
    // Even owning itself, a participant cannot reach an arbitrary feature
    // attach: the surface object is $wiz-owned and its default
    // :can_be_attached_by policy admits only the owner. The attach never lands
    // — whether it is refused at the direct-call boundary or by the policy, the
    // outcome is the same: no surface.
    world.object(agent).owner = agent;
    expect(world.object("$programmer").owner).toBe("$wiz");
    const res = (await world.directCall("af", agent, agent, "add_feature", ["$programmer"])) as CallResult;
    expect(res.op).toBe("error");
    expect(world.actorHasSurface(agent, "$programmer")).toBe(false);
  });

  it("promotes and demotes atomically across flag, feature, and quota (§8.10, §8.11)", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "promote@example.com");
    const agent = await createAgent(world, human, "promotebot", false);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(0);

    // Promote.
    const up = (await world.directCall("up", human, human, "promote_agent_to_programmer", [agent])) as CallResult;
    expect(up.op).toBe("result");
    expect(world.object(agent).flags.programmer).toBe(true);
    expect(world.actorHasSurface(agent, "$programmer")).toBe(true);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);

    // A post-promotion install works.
    const created = (await world.directCall("mk", agent, agent, "create", ["$thing", { name: "PB" }])) as CallResult;
    const obj = (created as any).result.id as string;
    const ok = (await world.directCall("iv", agent, agent, "install_verb", [obj, "hi", "verb :hi() rxd { return 1; }", {}])) as CallResult;
    expect(ok.op).toBe("result");

    // Demote.
    const down = (await world.directCall("down", human, human, "demote_agent_from_programmer", [agent])) as CallResult;
    expect(down.op).toBe("result");
    expect(world.object(agent).flags.programmer).toBe(false);
    expect(world.actorHasSurface(agent, "$programmer")).toBe(false);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(0);

    // Invariant §8.11: after demotion the authoring verbs no longer resolve.
    const gone = (await world.directCall("iv2", agent, agent, "install_verb", [obj, "hi2", "verb :hi2() rxd { return 1; }", {}])) as CallResult;
    expect(gone.op).toBe("error");
    expect((gone as any).error.code).toBe("E_VERBNF");
  });

  it("drops task perms to the actor so wrappers cannot retain $wiz authority (§8.8)", async () => {
    const world = createWorld();
    const { human } = await provisionHuman(world, "perms@example.com");
    const agent = await createAgent(world, human, "permsbot", true);

    // eval runs arbitrary DSL under the task's effective principal. The wrapper
    // is $wiz-owned, so without the actor drop this would run as $wiz. After the
    // drop, task_perms() must report the agent, not the wizard.
    const res = (await world.directCall("ev", agent, agent, "eval", ["task_perms()", {}])) as CallResult;
    expect(res.op).toBe("result");
    expect((res as any).result.ok).toBe(true);
    expect((res as any).result.value).toBe(agent);

    // And a foreign, wizard-owned object cannot be authored by the agent.
    world.createObject({ id: "foreign_box", name: "Foreign Box", parent: "$thing", owner: "$wiz" });
    const foreign = (await world.directCall("fw", agent, agent, "install_verb", [
      "foreign_box",
      "sneak",
      "verb :sneak() rxd { return 1; }",
      {}
    ])) as CallResult;
    expect(foreign.op).toBe("error");
    expect(world.object("foreign_box").verbs.find((v) => v.name === "sneak")).toBeUndefined();
  });

  it("repairs a legacy programmer agent (flag set, surface missing) on the next promote", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "legacy@example.com");
    const agent = await createAgent(world, human, "legacybot", false);
    // Simulate a pre-composition legacy agent: the flag was set but no surface
    // was ever attached, and the quota already counts it.
    world.object(agent).flags.programmer = true;
    world.setProp(agent, "features", []);
    world.setProp(account, "programmer_agent_count", 1);
    expect(world.actorHasSurface(agent, "$programmer")).toBe(false);

    // promote is idempotent and repairing: it attaches the surface without
    // double-counting the (already-counted) agent.
    const up = (await world.directCall("up", human, human, "promote_agent_to_programmer", [agent])) as CallResult;
    expect(up.op).toBe("result");
    expect(world.actorHasSurface(agent, "$programmer")).toBe(true);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);

    // §6: the repair is audited, with the human as principal and the agent as
    // subject (never the agent as its own acting principal).
    const audit = world.propOrNull("$system", "wizard_actions") as Array<Record<string, unknown>>;
    const repair = audit.find((a) => a.action === "programmer_surface_repaired");
    expect(repair, JSON.stringify(audit.slice(-3))).toMatchObject({ actor: human, target: agent, attached: true });

    // And the repaired agent can now author.
    const created = (await world.directCall("mk", agent, agent, "create", ["$thing", { name: "Rep" }])) as CallResult;
    expect(created.op).toBe("result");
  });

  it("attributes a promote audit to the human principal, not the agent", async () => {
    const world = createWorld();
    const { human } = await provisionHuman(world, "attrib@example.com");
    const agent = await createAgent(world, human, "attribbot", false);
    await world.directCall("up", human, human, "promote_agent_to_programmer", [agent]);
    const audit = world.propOrNull("$system", "wizard_actions") as Array<Record<string, unknown>>;
    const promote = audit.find((a) => a.action === "agent_promoted_to_programmer");
    expect(promote).toMatchObject({ actor: human, target: agent });
    expect(promote?.actor).not.toBe(agent);
  });

  it("removes a stranded surface when a raw flag-clear left the feature behind", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "stranded@example.com");
    const agent = await createAgent(world, human, "strandedbot", true);
    // Simulate an admin who cleared the flag directly on the object, leaving the
    // surface feature (and thus builder capability) behind.
    world.object(agent).flags.programmer = false;
    expect(world.actorHasSurface(agent, "$programmer")).toBe(true);

    const down = (await world.directCall("down", human, human, "demote_agent_from_programmer", [agent])) as CallResult;
    expect(down.op).toBe("result");
    expect(world.actorHasSurface(agent, "$programmer")).toBe(false);
  });

  it("keeps the wizard flag and the surface consistent through set_object_flags", async () => {
    const world = createWorld();
    const { human } = await provisionHuman(world, "adminflag@example.com");
    const agent = await createAgent(world, human, "adminflagbot", false);
    // Wizard grants programmer directly — surface follows the flag.
    world.setObjectFlags("$wiz", agent, { programmer: true });
    expect(world.actorHasSurface(agent, "$programmer")).toBe(true);
    // Wizard clears it — surface follows again.
    world.setObjectFlags("$wiz", agent, { programmer: false });
    expect(world.actorHasSurface(agent, "$programmer")).toBe(false);
  });

  it("refuses to compose the surface onto a kind that shadows a surface verb, leaving the flag false", async () => {
    const world = createWorld();
    // $block (isa $actor) defines its own set_property and look, which the
    // builder surface also defines. Composing the surface would silently shadow
    // them, so attachment must refuse — and set_object_flags must not have
    // half-applied the flag before the refusal.
    world.createObject({ id: "test_block", name: "Test Block", parent: "$block", owner: "$wiz" });
    expect(() => world.setObjectFlags("$wiz", "test_block", { programmer: true })).toThrow(/shadows surface verb/);
    expect(world.actorHasSurface("test_block", "$programmer")).toBe(false);
    expect(world.object("test_block").flags.programmer ?? false).toBe(false);
  });

  it("closes the add_feature bypass: the generic attach refuses the surface for a shadowing kind, and a bypassed surface is caught on flag-set", async () => {
    const world = createWorld();
    world.createObject({ id: "bypass_block", name: "Bypass Block", parent: "$block", owner: "$wiz" });
    // The generic addFeature path (even with wizard authority) must refuse the
    // programmer surface onto a shadowing kind — it is not a bypass around the
    // composability check.
    await expect((world as any).addFeature("bypass_block", "$programmer", "$wiz")).rejects.toMatchObject({ code: "E_INVARG" });
    expect(world.actorHasSurface("bypass_block", "$programmer")).toBe(false);

    // Even if a raw write plants the surface, setting the programmer flag
    // re-validates composability and refuses, leaving the flag false.
    world.setProp("bypass_block", "features", ["$programmer"]);
    expect(() => world.setObjectFlags("$wiz", "bypass_block", { programmer: true })).toThrow(/shadows surface verb/);
    expect(world.object("bypass_block").flags.programmer ?? false).toBe(false);
  });

  it("promote leaves flag, surface, quota, and audit unchanged when quota is exhausted (§8.10 atomicity)", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "quota@example.com");
    world.setProp(account, "programmer_grant_quota", 0); // no room
    const agent = await createAgent(world, human, "quotabot", false);
    const auditBefore = (world.propOrNull("$system", "wizard_actions") as unknown[]).length;

    const res = (await world.directCall("up", human, human, "promote_agent_to_programmer", [agent])) as CallResult;
    expect(res.op).toBe("error");
    expect((res as any).error.code).toBe("E_QUOTA_EXCEEDED");
    // Nothing moved.
    expect(world.object(agent).flags.programmer ?? false).toBe(false);
    expect(world.actorHasSurface(agent, "$programmer")).toBe(false);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(0);
    expect((world.propOrNull("$system", "wizard_actions") as unknown[]).length).toBe(auditBefore);
  });

  it("promote refuses across a host boundary with nothing mutated (§5.1 co-residency)", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "xhost@example.com");
    const agent = await createAgent(world, human, "xhostbot", false);
    const auditBefore = (world.propOrNull("$system", "wizard_actions") as unknown[]).length;
    // Force only the agent to look remote relative to the executing scope, so
    // ordinary dispatch still works but co-residency fails.
    const origRemote = (world as any).remoteHostForObject.bind(world);
    (world as any).remoteHostForObject = async (ref: string, memo: unknown) =>
      ref === agent ? "other-host" : origRemote(ref, memo);

    const res = (await world.directCall("up", human, human, "promote_agent_to_programmer", [agent])) as CallResult;
    expect(res.op).toBe("error");
    expect((res as any).error.code).toBe("E_CROSS_HOST_WRITE");
    expect(world.object(agent).flags.programmer ?? false).toBe(false);
    expect(world.actorHasSurface(agent, "$programmer")).toBe(false);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(0);
    expect((world.propOrNull("$system", "wizard_actions") as unknown[]).length).toBe(auditBefore);
  });

  it("rejects authoring search scope 'all' — no global object enumeration (§7)", async () => {
    const world = createWorld();
    const { human } = await provisionHuman(world, "scopeall@example.com");
    const agent = await createAgent(world, human, "scopebot", true);
    // The bounded scopes still work...
    const ok = (await world.directCall("s-ok", agent, agent, "search", ["x", { scope: "owned" }])) as CallResult;
    expect(ok.op).toBe("result");
    // ...but "all" (the removed global-enumeration scope) is refused.
    const res = (await world.directCall("s-all", agent, agent, "search", ["x", { scope: "all" }])) as CallResult;
    expect(res.op).toBe("error");
    expect((res as any).error.code).toBe("E_INVARG");
    expect((res as any).error.message).toContain("all");
  });

  it("leaves target state unchanged when a verb install hits a stale version (§8.9)", async () => {
    const world = createWorld();
    const { human } = await provisionHuman(world, "stale@example.com");
    const agent = await createAgent(world, human, "stalebot", true);
    const created = (await world.directCall("mk", agent, agent, "create", ["$thing", { name: "SV" }])) as CallResult;
    const obj = (created as any).result.id as string;
    await world.directCall("iv", agent, agent, "install_verb", [obj, "v", "verb :v() rxd { return 1; }", {}]);
    const before = world.object(obj).verbs.find((x) => x.name === "v")?.version;

    // Reinstall with a deliberately stale expected_version.
    const res = (await world.directCall("iv2", agent, agent, "install_verb", [
      obj,
      "v",
      "verb :v() rxd { return 2; }",
      { expected_version: 999 }
    ])) as CallResult;
    // Whether it surfaces as an error or a failure map, the stored verb must be
    // unchanged and still return 1.
    const after = world.object(obj).verbs.find((x) => x.name === "v")?.version;
    expect(after).toBe(before);
    const call = (await world.directCall("cv", agent, obj, "v", [])) as CallResult;
    expect((call as any).result).toBe(1);
  });

  it("commits the next version when a verb install names the CURRENT expected_version (§8.9)", async () => {
    const world = createWorld();
    const { human } = await provisionHuman(world, "cas@example.com");
    const agent = await createAgent(world, human, "casbot", true);
    const created = (await world.directCall("mk", agent, agent, "create", ["$thing", { name: "CAS" }])) as CallResult;
    const obj = (created as any).result.id as string;
    const v1 = (await world.directCall("iv", agent, agent, "install_verb", [obj, "v", "verb :v() rxd { return 1; }", {}])) as CallResult;
    expect((v1 as any).result.version).toBe(1);
    // Naming the current version (1) is a successful compare-and-swap → v2.
    const v2 = (await world.directCall("iv2", agent, agent, "install_verb", [
      obj, "v", "verb :v() rxd { return 2; }", { expected_version: 1 }
    ])) as CallResult;
    expect((v2 as any).result.ok, JSON.stringify(v2).slice(0, 300)).toBe(true);
    expect((v2 as any).result.version).toBe(2);
    const call = (await world.directCall("cv", agent, obj, "v", [])) as CallResult;
    expect((call as any).result).toBe(2);
  });
});
