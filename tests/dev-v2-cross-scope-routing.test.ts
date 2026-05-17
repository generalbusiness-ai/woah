// Smoke test for the dev WebSocket cross-scope routing fix. A v2 browser
// worker only keeps one WS open at a time, but a single page can issue turns
// to multiple commit scopes — most importantly, a chat command from the
// chatroom that targets a $space-typed object (e.g. `enter dubspace`,
// `enter pinboard`) is re-audienced by the substrate to the target's scope.
// Submitting that turn against the WS-bound relay rejects with
// `scope_mismatch`. This test pins the routing decision and the end-to-end
// success path so the dev path doesn't silently regress.
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import {
  buildShadowBrowserSessionAuth,
  createShadowBrowserClient,
  createShadowBrowserRelayShim,
  handleShadowBrowserTurnExecEnvelope,
  mergeShadowBrowserAuthoritySessionState,
  receiveShadowBrowserEnvelopeReceipt,
  shadowBrowserEnvelope,
  shadowBrowserSessionBearer
} from "../src/core/shadow-browser-node";
import { encodeEnvelope } from "../src/core/shadow-envelope";
import { resolveTurnEnvelopeScope } from "../src/server/dev-v2-routing";
import type { ObjRef } from "../src/core/types";

describe("dev v2 cross-scope WS routing", () => {
  it("routes a chat-style 'enter <space>' intent to the target's scope, not the chatroom scope", async () => {
    const world = createWorld();
    const session = world.auth("guest:cross-scope-enter-routing");
    // Drop the actor in the chatroom — same starting state the SPA's chat
    // panel produces before the user types `enter dubspace`.
    await world.directCall("setup:enter-chatroom", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });

    const intentEnvelope = {
      v: 2 as const,
      type: "woo.turn.intent.request.shadow.v1" as const,
      id: "intent-cross-scope-enter-dubspace",
      from: "browser-cross-scope",
      to: "node:dev:relay",
      actor: session.actor,
      session: session.id,
      auth: { mode: "session" as const, token: shadowBrowserSessionBearer({ id: session.id, actor: session.actor }) },
      body: {
        kind: "woo.turn.intent.request.shadow.v1" as const,
        id: "intent-cross-scope-enter-dubspace",
        route: "direct" as const,
        // The browser worker is connected to the chatroom (where the user is
        // typing); the call target is a $space sibling.
        scope: "the_chatroom" as ObjRef,
        target: "the_dubspace" as ObjRef,
        verb: "enter",
        args: [],
        persistence: "live" as const
      }
    };
    const encoded = encodeEnvelope(intentEnvelope);

    // The dev WS handler must route this envelope to `the_dubspace`. Routing
    // by the intent's declared scope (`the_chatroom`) would hit a relay
    // whose commit_scope does not match the transcript the planner will
    // produce.
    expect(resolveTurnEnvelopeScope(world, encoded)).toBe("the_dubspace");
  });

  it("dispatches a chatroom-issued 'enter dubspace' on the dubspace relay without commit_rejected", async () => {
    const world = createWorld();
    const session = world.auth("guest:cross-scope-enter-dispatch");
    await world.directCall("setup:enter-chatroom", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    const serialized = world.exportWorld();
    const sessions = world.exportSessions();
    // Resolve where the envelope should be submitted exactly as the dev
    // server does, then build a browser anchored to that relay.
    const targetScope = "the_dubspace" as ObjRef;
    const relay = createShadowBrowserRelayShim({
      node: "browser-cross-scope-dispatch",
      scope: targetScope,
      serialized,
      deployment: "local-dev"
    });
    const sessionAuth = buildShadowBrowserSessionAuth({
      sessions,
      scope: targetScope,
      deployment: relay.deployment
    });
    relay.session_auth = sessionAuth.session_auth;
    relay.session_revs = sessionAuth.session_revs;
    relay.commit_scope.serialized.sessions = mergeShadowBrowserAuthoritySessionState(
      relay.commit_scope.serialized.sessions,
      sessions
    );
    const browser = createShadowBrowserClient({
      node: "browser-cross-scope-dispatch",
      scope: targetScope,
      actor: session.actor,
      session: session.id,
      relay,
      token: shadowBrowserSessionBearer({ id: session.id, actor: session.actor })
    });

    const intent = shadowBrowserEnvelope(browser, "woo.turn.intent.request.shadow.v1", {
      kind: "woo.turn.intent.request.shadow.v1",
      id: "intent-cross-scope-dispatch-enter",
      route: "direct",
      scope: "the_chatroom" as ObjRef,
      target: targetScope,
      verb: "enter",
      args: [],
      persistence: "live"
    });
    const reply = await handleShadowBrowserTurnExecEnvelope(
      browser,
      receiveShadowBrowserEnvelopeReceipt(browser, encodeEnvelope(intent))
    );
    expect(reply?.body).toMatchObject({ ok: true });
    if (!reply || reply.body.ok !== true) return;
    expect(reply.body.transcript?.scope).toBe(targetScope);
    expect(reply.body.transcript?.call).toMatchObject({ target: targetScope, verb: "enter" });
  });

  it("would be rejected by the chatroom relay without routing — regression guard", async () => {
    // Pins the failure mode the routing fix exists to avoid: if the dev WS
    // submits a chat-issued `enter dubspace` against the WS-bound chatroom
    // relay (instead of routing to the dubspace relay), the commit comes
    // back as `commit_rejected` with `scope_mismatch`. If this test starts
    // returning `ok: true`, the routing fix is no longer needed and the WS
    // handler can simplify; if it changes shape, the routing helper must
    // be updated to match.
    const world = createWorld();
    const session = world.auth("guest:cross-scope-regression");
    await world.directCall("setup:enter-chatroom-regression", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    const serialized = world.exportWorld();
    const sessions = world.exportSessions();
    const chatroomScope = "the_chatroom" as ObjRef;
    const relay = createShadowBrowserRelayShim({
      node: "browser-cross-scope-regression",
      scope: chatroomScope,
      serialized,
      deployment: "local-dev"
    });
    const sessionAuth = buildShadowBrowserSessionAuth({
      sessions,
      scope: chatroomScope,
      deployment: relay.deployment
    });
    relay.session_auth = sessionAuth.session_auth;
    relay.session_revs = sessionAuth.session_revs;
    relay.commit_scope.serialized.sessions = mergeShadowBrowserAuthoritySessionState(
      relay.commit_scope.serialized.sessions,
      sessions
    );
    const browser = createShadowBrowserClient({
      node: "browser-cross-scope-regression",
      scope: chatroomScope,
      actor: session.actor,
      session: session.id,
      relay,
      token: shadowBrowserSessionBearer({ id: session.id, actor: session.actor })
    });

    const intent = shadowBrowserEnvelope(browser, "woo.turn.intent.request.shadow.v1", {
      kind: "woo.turn.intent.request.shadow.v1",
      id: "intent-cross-scope-regression",
      route: "direct",
      scope: chatroomScope,
      target: "the_dubspace" as ObjRef,
      verb: "enter",
      args: [],
      persistence: "durable"
    });
    const reply = await handleShadowBrowserTurnExecEnvelope(
      browser,
      receiveShadowBrowserEnvelopeReceipt(browser, encodeEnvelope(intent))
    );
    expect(reply?.body).toMatchObject({ ok: false, reason: "commit_rejected" });
    if (!reply || reply.body.ok !== false) return;
    expect(reply.body.commit?.errors ?? []).toEqual(expect.arrayContaining([expect.stringContaining("scope_mismatch")]));
  });

  it("falls back to the intent's declared scope when the target has no $space audience", () => {
    const world = createWorld();
    const intentEnvelope = {
      v: 2 as const,
      type: "woo.turn.intent.request.shadow.v1" as const,
      id: "intent-cross-scope-fallback",
      from: "browser-cross-scope-fallback",
      to: "node:dev:relay",
      actor: "$wiz" as ObjRef,
      auth: { mode: "session" as const, token: "session:fallback" },
      body: {
        kind: "woo.turn.intent.request.shadow.v1" as const,
        id: "intent-cross-scope-fallback",
        route: "direct" as const,
        scope: "the_chatroom" as ObjRef,
        // $wiz is the wizard, which is not a $space and is not anchored or
        // located in one — so the audience falls through to the declared
        // intent scope.
        target: "$wiz" as ObjRef,
        verb: "help",
        args: [],
        persistence: "live" as const
      }
    };
    expect(resolveTurnEnvelopeScope(world, encodeEnvelope(intentEnvelope))).toBe("the_chatroom");
  });
});
