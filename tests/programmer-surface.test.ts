import { describe, it, expect } from "vitest";
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
    // Grant the flag directly (wizard action) but attach no surface.
    world.setObjectFlags("$wiz", agent, { programmer: true });
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
});
