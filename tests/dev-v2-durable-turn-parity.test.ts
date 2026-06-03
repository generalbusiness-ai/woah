import { describe, expect, it } from "vitest";

import { authoritativePlanningWorld } from "../src/core/planning-world";
import { installVerb } from "../src/core/authoring";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import { buildShadowTurnIntentEnvelope, createShadowBrowserClient, createShadowBrowserRelayShim, handleShadowBrowserTurnExecEnvelope, receiveShadowBrowserEnvelopeReceipt, shadowBrowserEnvelope, shadowBrowserSessionBearer } from "../src/core/shadow-browser-node";
import { encodeEnvelope } from "../src/core/shadow-envelope";
import { serializedFor } from "../src/core/shadow-commit-scope";
import { runShadowTurnCall, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import { encodeExecutorIntentEnvelope } from "../src/core/executor";
import { decodeTurnIntentCall, devV2BrowserProfileTurnReply, executeDevV2DurableTurnFrame, executeDevV2DurableTurnWsReply, executeInProcessV2DurableTurn } from "../src/server/dev-v2-helpers";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";
import type { ExecutorCallInput } from "../src/core/executor";
import type { ShadowRelayCache } from "../src/core/shadow-relay-cache";
import type { ObjRef } from "../src/core/types";

// The dev primitive is scope-aware (matching CF's per-scope ensureRestV2Relay /
// v2CommitScopePost): it resolves the gateway/commit relay for whatever scope
// submitTurnIntent asks for. For a same-scope turn the resolvers return the one
// fixed pair and assert no other scope is requested. A B6 relocation turn (see
// the relocation case below) plans in one scope and commits in another, so it
// uses `makeDevResolvers`, which mints a sparse-gateway + full-commit relay per
// scope on demand — exactly as the live dev server caches one relay per scope.
function fixedResolvers(scope: ObjRef, gatewayRelay: ShadowRelayCache, commitRelay: ShadowRelayCache): {
  gatewayRelayForScope: (s: ObjRef) => ShadowRelayCache;
  commitRelayForScope: (s: ObjRef) => ShadowRelayCache;
} {
  return {
    gatewayRelayForScope: (s) => {
      if (s !== scope) throw new Error(`unexpected gateway scope ${s} (fixed=${scope})`);
      return gatewayRelay;
    },
    commitRelayForScope: (s) => {
      if (s !== scope) throw new Error(`unexpected commit scope ${s} (fixed=${scope})`);
      return commitRelay;
    }
  };
}

function makeDevResolvers(world: ReturnType<typeof createWorld>, tag: string): {
  gatewayRelayForScope: (s: ObjRef) => ShadowRelayCache;
  commitRelayForScope: (s: ObjRef) => ShadowRelayCache;
  gatewayFor: (s: ObjRef) => ShadowRelayCache | undefined;
  commitFor: (s: ObjRef) => ShadowRelayCache | undefined;
} {
  const gateways = new Map<ObjRef, ShadowRelayCache>();
  const commits = new Map<ObjRef, ShadowRelayCache>();
  const sparseSeed = createWorld({ catalogs: false }).exportWorld();
  return {
    gatewayRelayForScope: (s) => {
      let relay = gateways.get(s);
      if (!relay) {
        relay = createShadowBrowserRelayShim({ node: `dev:gw-${tag}-${s}`, scope: s, serialized: sparseSeed, deployment: "local-dev" });
        gateways.set(s, relay);
      }
      return relay;
    },
    commitRelayForScope: (s) => {
      let relay = commits.get(s);
      if (!relay) {
        relay = createShadowBrowserRelayShim({ node: `dev:commit-${tag}-${s}`, scope: s, serialized: world.exportWorld(), deployment: "local-dev" });
        commits.set(s, relay);
      }
      return relay;
    },
    gatewayFor: (s) => gateways.get(s),
    commitFor: (s) => commits.get(s)
  };
}

// #1 localdev↔CF drift: dev durable turns must use the SAME contract as CF —
// submitTurnIntent → sparse planning + admission gate + authority repair loop →
// commit-scope envelope → accepted commit. The previous dev path ran the
// browser-relay shortcut on a FULL-WORLD relay, so the sparse/repair machinery
// never fired. These cases pin the converged primitive: the repair loop fires on
// a sparse gateway, the result matches the direct authoritative path, and a
// genuinely cold gateway with no authority source cannot fabricate state.
describe("dev v2 durable turn — CF contract parity", () => {
  function setControl(scope: ObjRef, session: string, actor: ObjRef, wet: number, id: string): ExecutorCallInput {
    return {
      id,
      route: "sequenced",
      scope,
      session,
      actor,
      target: scope,
      verb: "set_control",
      args: ["delay_1", "wet", wet],
      persistence: "durable",
      token: shadowBrowserSessionBearer({ id: session, actor })
    };
  }

  it("plans on a sparse gateway (repair loop fires) and commits via the authoritative relay", async () => {
    const world = createWorld();
    const session = world.auth("guest:dev-parity");
    world.setProp("the_dubspace", "operators", [session.actor]);

    // Sparse gateway: bootstrap-only seed (NO the_dubspace / delay_1). The
    // authoritative commit relay holds the full world.
    const sparseSeed = createWorld({ catalogs: false }).exportWorld();
    const gatewayRelay = createShadowBrowserRelayShim({ node: "dev:gw", scope: "the_dubspace", serialized: sparseSeed, deployment: "local-dev" });
    const commitRelay = createShadowBrowserRelayShim({ node: "dev:commit", scope: "the_dubspace", serialized: world.exportWorld(), deployment: "local-dev" });

    // Sanity: the gateway is genuinely sparse — it does NOT hold delay_1.
    expect(serializedFor(gatewayRelay.commit_scope).objects.some((o) => o.id === "delay_1")).toBe(false);

    const submitted = await executeInProcessV2DurableTurn({
      world,
      ...fixedResolvers("the_dubspace", gatewayRelay, commitRelay),
      node: "dev:gw",
      call: setControl("the_dubspace", session.id, session.actor, 0.42, "dev-parity-1")
    });

    expect(submitted.kind).toBe("submitted");
    if (submitted.kind !== "submitted") throw new Error(`expected submitted, got ${submitted.kind}`);
    expect(submitted.reply?.ok).toBe(true);
    if (!submitted.reply?.ok) throw new Error("expected accepted reply");
    expect(submitted.reply.commit?.position.scope).toBe("the_dubspace");

    // The repair loop FIRED: planning hit missing state for delay_1 on the sparse
    // gateway, submitTurnIntent repaired it from `world` authority, and the
    // gateway relay now holds delay_1.
    expect(serializedFor(gatewayRelay.commit_scope).objects.some((o) => o.id === "delay_1")).toBe(true);

    // Result parity with the direct authoritative path: same control_changed
    // observation and committed post-state value.
    const direct = await runShadowTurnCall(
      authoritativePlanningWorld(world.exportWorld()),
      setControlAsTurnCall("the_dubspace", session.id, session.actor, 0.42, "dev-parity-direct")
    );
    expect(submitted.reply.transcript?.observations).toContainEqual(
      expect.objectContaining({ type: "control_changed", target: "delay_1", name: "wet", value: 0.42 })
    );
    expect(direct.transcript.observations).toContainEqual(
      expect.objectContaining({ type: "control_changed", target: "delay_1", name: "wet", value: 0.42 })
    );
    const committed = createWorldFromSerialized(serializedFor(commitRelay.commit_scope), { persist: false });
    expect(committed.getProp("delay_1", "wet")).toBe(0.42);
  });

  it("executeDevV2DurableTurnFrame applies the commit to the dev world and returns an applied frame", async () => {
    const world = createWorld();
    const session = world.auth("guest:dev-frame");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const sparseSeed = createWorld({ catalogs: false }).exportWorld();
    const gatewayRelay = createShadowBrowserRelayShim({ node: "dev:gw-frame", scope: "the_dubspace", serialized: sparseSeed, deployment: "local-dev" });
    const commitRelay = createShadowBrowserRelayShim({ node: "dev:commit-frame", scope: "the_dubspace", serialized: world.exportWorld(), deployment: "local-dev" });

    const { frame } = await executeDevV2DurableTurnFrame({
      world,
      ...fixedResolvers("the_dubspace", gatewayRelay, commitRelay),
      node: "dev:gw-frame",
      call: setControl("the_dubspace", session.id, session.actor, 0.37, "dev-frame-1")
    });

    expect(frame.op).toBe("applied");
    if (frame.op !== "applied") throw new Error("expected applied frame");
    expect(frame.space).toBe("the_dubspace");
    // Write-through: the accepted transcript was materialized into the dev world.
    expect(world.getProp("delay_1", "wet")).toBe(0.37);
  });

  it("executeDevV2DurableTurnFrame throws a turn error when the verb raises (parity with the legacy REST contract)", async () => {
    const world = createWorld();
    const session = world.auth("guest:dev-frame-err");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const sparseSeed = createWorld({ catalogs: false }).exportWorld();
    const gatewayRelay = createShadowBrowserRelayShim({ node: "dev:gw-err", scope: "the_dubspace", serialized: sparseSeed, deployment: "local-dev" });
    const commitRelay = createShadowBrowserRelayShim({ node: "dev:commit-err", scope: "the_dubspace", serialized: world.exportWorld(), deployment: "local-dev" });

    // A verb that does not exist on the target raises during planning → the
    // wrapper THROWS the turn error rather than returning an error frame
    // (matching restFrameFromTurnReply / the legacy dev REST path).
    const badCall = {
      id: "dev-frame-err-1",
      route: "sequenced" as const,
      scope: "the_dubspace" as ObjRef,
      session: session.id,
      actor: session.actor,
      target: "the_dubspace" as ObjRef,
      verb: "__parity_no_such_verb__",
      args: [],
      persistence: "durable" as const,
      token: shadowBrowserSessionBearer({ id: session.id, actor: session.actor })
    };
    await expect(executeDevV2DurableTurnFrame({
      world,
      ...fixedResolvers("the_dubspace", gatewayRelay, commitRelay),
      node: "dev:gw-err",
      call: badCall
    })).rejects.toBeTruthy();
  });

  it("reuses warm gateway + commit relays across turns (live dev-server relay-reuse path)", async () => {
    // Mirrors the live dev server, which caches one gateway relay + one commit
    // relay per scope and runs many turns through them: turn 1 repairs the cold
    // gateway, turn 2 is warm (no new repair) and commits at the advanced head.
    const world = createWorld();
    const session = world.auth("guest:dev-warm");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const gatewayRelay = createShadowBrowserRelayShim({ node: "dev:gw-warm", scope: "the_dubspace", serialized: createWorld({ catalogs: false }).exportWorld(), deployment: "local-dev" });
    const commitRelay = createShadowBrowserRelayShim({ node: "dev:commit-warm", scope: "the_dubspace", serialized: world.exportWorld(), deployment: "local-dev" });

    const first = await executeDevV2DurableTurnFrame({
      world, ...fixedResolvers("the_dubspace", gatewayRelay, commitRelay), node: "dev:gw-warm",
      call: setControl("the_dubspace", session.id, session.actor, 0.11, "dev-warm-1")
    });
    expect(first.frame.op).toBe("applied");
    expect(world.getProp("delay_1", "wet")).toBe(0.11);
    const headAfterFirst = commitRelay.commit_scope.head.seq;

    const second = await executeDevV2DurableTurnFrame({
      world, ...fixedResolvers("the_dubspace", gatewayRelay, commitRelay), node: "dev:gw-warm",
      call: setControl("the_dubspace", session.id, session.actor, 0.22, "dev-warm-2")
    });
    expect(second.frame.op).toBe("applied");
    expect(world.getProp("delay_1", "wet")).toBe(0.22);
    // The commit head advanced (the warm gateway committed at the new head, not a stale one).
    expect(commitRelay.commit_scope.head.seq).toBeGreaterThan(headAfterFirst);
  });

  it("scope-aware: a B6 relocation turn commits at the moved object's scope, not the planning scope", async () => {
    // A pure single-object move (`:go(dest)` → moveto(actor, dest)) is the CA3
    // relocation case: the only authoritative write is the actor's own
    // location, so B6 selects the ACTOR's scope as the commit scope — distinct
    // from the planning scope (the source room). CF routes this commit to the
    // actor-scope CommitScopeDO via v2CommitScopePost(actorScope, ...); the
    // dev primitive must likewise resolve the actor-scope commit relay and land
    // the commit THERE. The previous single-commit-relay dev primitive ignored
    // the requested scope and would have committed on the planning-scope relay,
    // masking exactly the plan-here / commit-there divergence shared executor
    // tests already prove. This case fails against that old shape.
    const world = createWorld();
    world.createObject({ id: "reloc_src", name: "reloc_src", parent: "$space", owner: "$wiz" });
    world.createObject({ id: "reloc_dest", name: "reloc_dest", parent: "$space", owner: "$wiz" });
    for (const room of ["reloc_src", "reloc_dest"]) {
      const installed = installVerb(world, room, "go", "verb :go(dest) rxd {\n      moveto(actor, dest);\n    }", null);
      expect(installed.ok).toBe(true);
    }
    const session = world.auth("guest:dev-reloc");
    // Place the actor in the source room (the planning scope for the turn).
    const actorObj = world.object(session.actor);
    if (actorObj.location) world.object(actorObj.location).contents.delete(session.actor);
    actorObj.location = "reloc_src";
    world.object("reloc_src").contents.add(session.actor);
    const row = world.sessions.get(session.id);
    if (row) row.activeScope = "reloc_src";

    const resolvers = makeDevResolvers(world, "reloc");
    const submitted = await executeInProcessV2DurableTurn({
      world,
      gatewayRelayForScope: resolvers.gatewayRelayForScope,
      commitRelayForScope: resolvers.commitRelayForScope,
      node: "dev:gw-reloc",
      call: {
        id: "dev-reloc-1", route: "sequenced", scope: "reloc_src",
        session: session.id, actor: session.actor, target: "reloc_src",
        verb: "go", args: ["reloc_dest"], persistence: "durable",
        token: shadowBrowserSessionBearer({ id: session.id, actor: session.actor })
      }
    });

    expect(submitted.kind).toBe("submitted");
    if (submitted.kind !== "submitted") throw new Error(`expected submitted, got ${submitted.kind}`);
    expect(submitted.reply?.ok).toBe(true);
    if (!submitted.reply?.ok) throw new Error("expected accepted reply");

    // The commit landed at the ACTOR's scope (B6 relocation), NOT the planning
    // scope (reloc_src). This is the property the scope-aware refactor adds.
    expect(submitted.reply.commit?.position.scope).toBe(session.actor);

    // The commit advanced the actor-scope relay's head; the planning-scope
    // relay (minted only to read its head during planning) never received a
    // commit, so its head is still at seq 0. A non-scope-aware primitive would
    // have advanced reloc_src instead.
    const actorCommit = resolvers.commitFor(session.actor);
    const planningCommit = resolvers.commitFor("reloc_src");
    expect(actorCommit?.commit_scope.head.seq).toBeGreaterThan(0);
    expect(planningCommit?.commit_scope.head.seq ?? 0).toBe(0);
    const committed = createWorldFromSerialized(serializedFor(actorCommit!.commit_scope), { persist: false });
    expect(committed.allLocationsForActor(session.actor)).toEqual(["reloc_dest"]);
  });

  // WS drain contract: the socket reply MUST be addressed to the WS client and
  // carry reply_to = the original intent envelope id, or the SPA's pending-turn
  // set never drains (the wait cursor spins forever). True for BOTH a committed
  // turn and a verb that raised.
  function wsReplyHarness(actorAllowed: boolean, verb: string, id: string) {
    const world = createWorld();
    const session = world.auth(`guest:dev-ws-${id}`);
    if (actorAllowed) world.setProp("the_dubspace", "operators", [session.actor]);
    const gatewayRelay = createShadowBrowserRelayShim({ node: `dev:gw-ws-${id}`, scope: "the_dubspace", serialized: createWorld({ catalogs: false }).exportWorld(), deployment: "local-dev" });
    const commitRelay = createShadowBrowserRelayShim({ node: `dev:commit-ws-${id}`, scope: "the_dubspace", serialized: world.exportWorld(), deployment: "local-dev" });
    const token = shadowBrowserSessionBearer({ id: session.id, actor: session.actor });
    const wsBrowser = createShadowBrowserClient({ node: `browser:ws-${id}`, scope: "the_dubspace", actor: session.actor, session: session.id, relay: commitRelay, token });
    const call = {
      id, route: "sequenced" as const, scope: "the_dubspace" as ObjRef, session: session.id, actor: session.actor,
      target: "the_dubspace" as ObjRef, verb, args: verb === "set_control" ? ["delay_1", "wet", 0.27] : [], persistence: "durable" as const, token
    };
    const encoded = encodeExecutorIntentEnvelope({ node: wsBrowser.node, turn: { ...call }, turnId: id });
    const receipt = receiveShadowBrowserEnvelopeReceipt(wsBrowser, encoded);
    return { world, gatewayRelay, commitRelay, wsBrowser, receipt, call };
  }

  it("WS durable success reply is socket-addressed and drains (reply_to = intent id, ok)", async () => {
    const h = wsReplyHarness(true, "set_control", "dev-ws-ok");
    const { reply } = await executeDevV2DurableTurnWsReply({
      world: h.world, ...fixedResolvers("the_dubspace", h.gatewayRelay, h.commitRelay),
      browser: h.wsBrowser, receipt: h.receipt, call: h.call, node: `dev:exec-${h.call.id}`
    });
    expect(reply.reply_to).toBe(h.receipt.envelope.id);   // SPA drains on this
    expect(reply.to).toBe(h.wsBrowser.node);               // addressed to the WS client
    expect(reply.body.ok).toBe(true);
    if (reply.body.ok !== true) throw new Error("expected ok reply");
    expect(reply.body.commit).toBeTruthy();
    const objectWrites = reply.body.commit?.projection_writes?.filter((write) => write.table === "objects" && write.op === "upsert") ?? [];
    expect(objectWrites.length).toBeGreaterThan(0);
    expect(objectWrites.every((write) => (write.row as { kind?: unknown }).kind === "woo.browser_object_row.v1")).toBe(true);
    expect(h.world.getProp("delay_1", "wet")).toBe(0.27);  // write-through happened
  });

  it("dev browser-profile conversion also covers legacy WS exec replies", async () => {
    const h = wsReplyHarness(true, "set_control", "dev-ws-legacy-profile");
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: h.call.id,
      route: "sequenced",
      scope: "the_dubspace",
      session: h.wsBrowser.session,
      actor: h.wsBrowser.actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.31]
    };
    const planned = await runShadowTurnCall(authoritativePlanningWorld(serializedFor(h.commitRelay.commit_scope)), call);
    const request = {
      kind: "woo.turn.exec.request.shadow.v1" as const,
      id: h.call.id,
      call,
      key: shadowTurnKeyFromTranscript(planned.transcript),
      expected: h.commitRelay.commit_scope.head,
      auth: { mode: "shadow_local" as const, actor: h.wsBrowser.actor, session: h.wsBrowser.session },
      persistence: "durable" as const
    };
    const envelope = shadowBrowserEnvelope(h.wsBrowser, request.kind, request, "dev-ws-legacy-profile-env");
    const reply = await handleShadowBrowserTurnExecEnvelope(
      h.wsBrowser,
      receiveShadowBrowserEnvelopeReceipt(h.wsBrowser, encodeEnvelope(envelope))
    );
    expect(reply?.body.ok).toBe(true);
    if (!reply || reply.body.ok !== true) throw new Error("expected accepted legacy reply");

    const converted = devV2BrowserProfileTurnReply({
      reply: reply.body,
      browser: h.wsBrowser,
      commitRelayForScope: (scope) => {
        if (scope !== "the_dubspace") throw new Error(`unexpected commit scope ${scope}`);
        return h.commitRelay;
      }
    });
    expect(converted.ok).toBe(true);
    if (converted.ok !== true) throw new Error("expected converted accepted reply");
    const objectWrites = converted.commit?.projection_writes?.filter((write) => write.table === "objects" && write.op === "upsert") ?? [];
    expect(objectWrites.length).toBeGreaterThan(0);
    expect(objectWrites.every((write) => (write.row as { kind?: unknown }).kind === "woo.browser_object_row.v1")).toBe(true);
  });

  it("WS durable verb-error reply STILL drains (reply_to = intent id, ok:false) instead of throwing", async () => {
    const h = wsReplyHarness(true, "__parity_no_such_verb__", "dev-ws-err");
    const { reply } = await executeDevV2DurableTurnWsReply({
      world: h.world, ...fixedResolvers("the_dubspace", h.gatewayRelay, h.commitRelay),
      browser: h.wsBrowser, receipt: h.receipt, call: h.call, node: `dev:exec-${h.call.id}`
    });
    // Unlike the REST wrapper, the WS path never throws — the SPA must get a
    // drainable reply even on error.
    expect(reply.reply_to).toBe(h.receipt.envelope.id);
    expect(reply.to).toBe(h.wsBrowser.node);
    expect(reply.body.ok).toBe(false);
  });

  it("WS durable reply is idempotent: a replayed intent does NOT re-execute (no double commit)", async () => {
    const h = wsReplyHarness(true, "set_control", "dev-ws-idem");
    const args = {
      world: h.world, ...fixedResolvers("the_dubspace", h.gatewayRelay, h.commitRelay),
      browser: h.wsBrowser, call: h.call, node: "dev:exec-idem"
    };
    const first = await executeDevV2DurableTurnWsReply({ ...args, receipt: h.receipt });
    expect(first.reply.body.ok).toBe(true);
    const headAfterFirst = h.commitRelay.commit_scope.head.seq;
    expect(h.world.getProp("delay_1", "wet")).toBe(0.27);

    // Replay the SAME intent envelope: the second receipt is not fresh, so the
    // cached reply is returned without re-executing.
    const replayEncoded = encodeExecutorIntentEnvelope({ node: h.wsBrowser.node, turn: { ...h.call }, turnId: h.call.id });
    const replayReceipt = receiveShadowBrowserEnvelopeReceipt(h.wsBrowser, replayEncoded);
    expect(replayReceipt.fresh).toBe(false);
    const second = await executeDevV2DurableTurnWsReply({ ...args, receipt: replayReceipt });
    expect(second.reply.body.ok).toBe(true);
    // No second commit: the scope head did not advance again.
    expect(h.commitRelay.commit_scope.head.seq).toBe(headAfterFirst);
  });

  it("decodeTurnIntentCall extracts the call and preserves live vs durable", () => {
    const session = "s:decode";
    const token = "t:decode";
    const durable = encodeExecutorIntentEnvelope({
      node: "n", turnId: "d1",
      turn: { id: "d1", route: "sequenced", scope: "the_dubspace" as ObjRef, session, actor: "#a" as ObjRef, target: "the_dubspace" as ObjRef, verb: "set_control", args: ["delay_1", "wet", 0.3], persistence: "durable", token }
    });
    const call = decodeTurnIntentCall(durable, session, token);
    expect(call).toMatchObject({ verb: "set_control", scope: "the_dubspace", actor: "#a", target: "the_dubspace", persistence: "durable", session });
    expect(call?.args).toEqual(["delay_1", "wet", 0.3]);

    const live = encodeExecutorIntentEnvelope({
      node: "n", turnId: "l1",
      turn: { id: "l1", route: "direct", scope: "the_dubspace" as ObjRef, session, actor: "#a" as ObjRef, target: "the_dubspace" as ObjRef, verb: "look", args: [], persistence: "live", token }
    });
    expect(decodeTurnIntentCall(live, session, token)?.persistence).toBe("live");
  });

  it("decodeTurnIntentCall leaves a selected-ad (B8 delegation) intent on the legacy path (returns null)", () => {
    // A selected-ad intent carries a pre-selected executor on the wire body
    // (B8 gossip routing). The sparse-gateway primitive plans the turn locally
    // and has no notion of a pre-selected ad, so flattening such an intent into
    // an ExecutorCallInput would silently DROP the delegation. decodeTurnIntentCall
    // must return null for it, so the dev WS handler routes it to the legacy
    // handleShadowBrowserTurnExecEnvelope path (which honors selected_ad) —
    // exactly as CF forwards the original encoded envelope to the CommitScopeDO.
    const session = "s:ad";
    const token = "t:ad";
    const base = {
      node: "n", actor: "#a" as ObjRef, session, token,
      route: "sequenced" as const, scope: "the_dubspace" as ObjRef, target: "the_dubspace" as ObjRef,
      verb: "set_control", args: ["delay_1", "wet", 0.3] as const, persistence: "durable" as const
    };
    // A plain durable intent (no selected_ad) decodes into a call as usual.
    const plain = encodeEnvelope(buildShadowTurnIntentEnvelope({ ...base, id: "ad-plain", args: ["delay_1", "wet", 0.3] }));
    expect(decodeTurnIntentCall(plain, session, token)).not.toBeNull();

    // The SAME intent WITH a selected_ad must NOT be decoded — null routes it
    // to the legacy delegation-preserving path.
    const withAd = encodeEnvelope(buildShadowTurnIntentEnvelope({ ...base, id: "ad-deleg", args: ["delay_1", "wet", 0.3], selected_ad: "node:executor:remote-1" }));
    expect(decodeTurnIntentCall(withAd, session, token)).toBeNull();
  });

  it("a cold gateway whose authority source lacks the target cannot fabricate state (sparseness is real)", async () => {
    // The authority SOURCE is the sparse bootstrap world (no the_dubspace), so the
    // repair loop has nothing to fill the missing closure with — the turn must
    // fail rather than silently plan against a hidden full world.
    const sparseWorld = createWorld({ catalogs: false });
    const session = sparseWorld.auth("guest:dev-parity-cold");
    const sparseSeed = sparseWorld.exportWorld();
    const gatewayRelay = createShadowBrowserRelayShim({ node: "dev:gw-cold", scope: "the_dubspace", serialized: sparseSeed, deployment: "local-dev" });
    const commitRelay = createShadowBrowserRelayShim({ node: "dev:commit-cold", scope: "the_dubspace", serialized: sparseSeed, deployment: "local-dev" });

    await expect(executeInProcessV2DurableTurn({
      world: sparseWorld,
      ...fixedResolvers("the_dubspace", gatewayRelay, commitRelay),
      node: "dev:gw-cold",
      maxAttempts: 3,
      call: setControl("the_dubspace", session.id, session.actor, 0.5, "dev-parity-cold-1")
    })).rejects.toThrow();
  });
});

function setControlAsTurnCall(scope: ObjRef, session: string, actor: ObjRef, wet: number, id: string): ShadowTurnCall {
  return {
    kind: "woo.turn_call.shadow.v1",
    id,
    route: "sequenced",
    scope,
    session,
    actor,
    target: scope,
    verb: "set_control",
    args: ["delay_1", "wet", wet]
  };
}
