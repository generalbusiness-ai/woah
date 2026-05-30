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
  markShadowBrowserRelaySerializedChanged,
  mergeShadowBrowserAuthoritySessionState,
  receiveShadowBrowserEnvelopeReceipt,
  shadowBrowserEnvelope,
  shadowBrowserSessionBearer
} from "../src/core/shadow-browser-node";
import { encodeEnvelope } from "../src/core/shadow-envelope";
import { buildVerbThrewReplyEnvelope, decodeTurnIntentForRecovery, resolveTurnEnvelopeRouting, resolveTurnEnvelopeScope } from "../src/server/dev-v2-helpers";
import { v2BrowserCacheMutationsForEnvelope } from "../src/client/v2-browser-cache";
import { v2TurnResultMessageFromReply } from "../src/client/v2-browser-messages";
import { serializedFor } from "../src/core/shadow-commit-scope";
import type { ObjRef } from "../src/core/types";

function refreshRelaySessions(
  relay: ReturnType<typeof createShadowBrowserRelayShim>,
  sessions: Parameters<typeof mergeShadowBrowserAuthoritySessionState>[1]
): void {
  const snapshot = serializedFor(relay.commit_scope);
  snapshot.sessions = mergeShadowBrowserAuthoritySessionState(snapshot.sessions, sessions);
  markShadowBrowserRelaySerializedChanged(relay);
}

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
    refreshRelaySessions(relay, sessions);
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

  it("fences a chatroom-relay cross-scope durable move with a placement transaction", async () => {
    // Pins the lower-level guard beneath the dev WS router: a relay may accept
    // a cross-scope movement only when the executor auto-arms the placement
    // fence, never as an ordinary unfenced source-scope commit.
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
    refreshRelaySessions(relay, sessions);
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
    expect(reply?.body).toMatchObject({ ok: true });
    if (!reply || reply.body.ok !== true) return;
    expect(reply.body.commit?.transaction).toMatchObject({ kind: "placement" });
  });

  it("commits an outliner 'add' intent end-to-end through the same WS handler logic the SPA uses", async () => {
    // Reproduces the SPA's outliner Add button: the v2 browser worker is
    // connected to scope=the_outline and submits an intent with target=
    // the_outline, verb=add. The SPA was hanging on this call ("spinning
    // wait cursor") because mutating verbs hit $space's presence gate and
    // the SPA wasn't auto-entering the outliner on tab open. This test
    // exercises the post-fix flow: enter first, then add.
    const world = createWorld();
    const session = world.auth("guest:outliner-add");
    // Match the SPA's startup state: actor is logged in, has just entered
    // the chatroom (where they were before clicking the Outliner tab).
    await world.directCall("setup:enter-chatroom-add", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    // The SPA's `enterOutliner()` runs on Outliner-tab activation so
    // subsequent mutating intents pass the presence check.
    await world.directCall("setup:enter-the_outline-add", session.actor, "the_outline", "enter", [], { sessionId: session.id });
    const serialized = world.exportWorld();
    const sessions = world.exportSessions();
    const targetScope = "the_outline" as ObjRef;
    const relay = createShadowBrowserRelayShim({
      node: "browser-outliner-add",
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
    refreshRelaySessions(relay, sessions);
    const browser = createShadowBrowserClient({
      node: "browser-outliner-add",
      scope: targetScope,
      actor: session.actor,
      session: session.id,
      relay,
      token: shadowBrowserSessionBearer({ id: session.id, actor: session.actor })
    });

    const callId = "intent-outliner-add-hello";
    const intent = shadowBrowserEnvelope(browser, "woo.turn.intent.request.shadow.v1", {
      kind: "woo.turn.intent.request.shadow.v1",
      id: callId,
      route: "sequenced",
      scope: targetScope,
      target: targetScope,
      verb: "add",
      args: ["hello outliner"],
      persistence: "durable"
    });
    const reply = await handleShadowBrowserTurnExecEnvelope(
      browser,
      receiveShadowBrowserEnvelopeReceipt(browser, encodeEnvelope(intent))
    );
    expect(reply?.body).toMatchObject({ ok: true });
    if (!reply || reply.body.ok !== true) return;
    // The transcript must commit on the_outline; the reply.commit must
    // carry the same id the SPA submitted, because that's what the SPA's
    // optimistic-call tracker keys off when it clears the wait cursor.
    expect(reply.body.transcript?.scope).toBe(targetScope);
    expect(reply.body.commit).toMatchObject({ id: callId, position: { scope: targetScope } });
    expect(reply.body.transcript?.creates?.length ?? 0).toBeGreaterThan(0);
    expect(reply.body.transcript?.observations ?? []).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "outline_item_added", text: "hello outliner" })
    ]));
  });

  it("fails 'add' from outside the outliner — regression for the SPA's auto-enter on tab open", async () => {
    // Pins the failure mode that produced the spinning wait cursor: a user
    // who has not entered the_outline still submits an outliner mutation
    // because the SPA forgot to call enter on tab activation. The substrate
    // throws E_PERM (\"actor not present in <space>\") synchronously inside
    // the shadow turn recorder, which surfaces as a transport error in the
    // dev WS and never settles the optimistic call on the client.
    const world = createWorld();
    const session = world.auth("guest:outliner-add-no-presence");
    await world.directCall("setup:enter-chatroom-no-presence", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    const serialized = world.exportWorld();
    const sessions = world.exportSessions();
    const targetScope = "the_outline" as ObjRef;
    const relay = createShadowBrowserRelayShim({
      node: "browser-outliner-no-presence",
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
    refreshRelaySessions(relay, sessions);
    const browser = createShadowBrowserClient({
      node: "browser-outliner-no-presence",
      scope: targetScope,
      actor: session.actor,
      session: session.id,
      relay,
      token: shadowBrowserSessionBearer({ id: session.id, actor: session.actor })
    });

    const intent = shadowBrowserEnvelope(browser, "woo.turn.intent.request.shadow.v1", {
      kind: "woo.turn.intent.request.shadow.v1",
      id: "intent-outliner-add-no-presence",
      route: "sequenced",
      scope: targetScope,
      target: targetScope,
      verb: "add",
      args: ["hello"],
      persistence: "durable"
    });
    await expect(
      handleShadowBrowserTurnExecEnvelope(
        browser,
        receiveShadowBrowserEnvelopeReceipt(browser, encodeEnvelope(intent))
      )
    ).rejects.toThrow(/not present in the_outline/);
  });

  it("recovers a pre-recording substrate throw into a reply that drains the SPA's pending intent", () => {
    // Belt-and-braces for the wait cursor: even if a future regression
    // re-introduces an unentered-outliner mutation (or any other case where
    // the substrate throws before withTurnRecording starts), the dev WS
    // must emit a turn.exec.reply with reply_to set so the worker's
    // v2BrowserCacheMutationsForEnvelope produces pending_delete and the
    // main thread's v2TurnResultMessageFromReply produces an error frame
    // whose id matches the original intent — that's what
    // `completeV2TurnNetworkWait` keys off when it clears the cursor.
    const encodedIntent = encodeEnvelope({
      v: 2 as const,
      type: "woo.turn.intent.request.shadow.v1" as const,
      id: "intent-recovery-env-id",
      from: "browser-recovery",
      to: "node:dev:relay",
      actor: "$wiz" as ObjRef,
      auth: { mode: "session" as const, token: "session:t" },
      body: {
        kind: "woo.turn.intent.request.shadow.v1" as const,
        id: "intent-recovery-body-id",
        route: "sequenced" as const,
        scope: "the_outline" as ObjRef,
        target: "the_outline" as ObjRef,
        verb: "add",
        args: ["hello"],
        persistence: "durable" as const
      }
    });
    const intent = decodeTurnIntentForRecovery(encodedIntent);
    expect(intent).not.toBeNull();
    if (!intent) return;
    expect(intent).toMatchObject({
      id: "intent-recovery-body-id",
      envelope_id: "intent-recovery-env-id",
      scope: "the_outline",
      route: "sequenced"
    });
    const reply = buildVerbThrewReplyEnvelope({
      intent,
      error: { code: "E_PERM", message: "$wiz is not present in the_outline" },
      relayNode: "node:dev:relay",
      to: "browser-recovery",
      actor: "$wiz" as ObjRef,
      session: "session-recovery",
      auth: { mode: "session" as const, token: "session:t" }
    });
    expect(reply.reply_to).toBe("intent-recovery-env-id");
    expect(reply.body.ok).toBe(false);
    expect(reply.body.id).toBe("intent-recovery-body-id");

    // Worker-side cache: presence of reply_to gates the pending delete.
    const mutations = v2BrowserCacheMutationsForEnvelope(reply);
    expect(mutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "pending_delete", id: "intent-recovery-env-id" })
    ]));

    // Main-thread error frame: id MUST equal the original intent body id,
    // because that's the call id `trackV2TurnNetworkWait` registered.
    const turnResult = v2TurnResultMessageFromReply(reply.body, reply.reply_to);
    expect(turnResult).not.toBeUndefined();
    expect(turnResult).toMatchObject({
      kind: "turn_result",
      frame: { op: "error", id: "intent-recovery-body-id" }
    });
  });

  it("dispatches 'enter dubspace' end-to-end through the WS handler routing (regression: chat-issued enter)", async () => {
    // Mirrors the SPA exactly: the v2 browser worker is connected to the
    // chatroom, the chat command planner issues `the_dubspace:enter` from
    // that connection, and the dev WS handler must (1) resolve the
    // audience to the_dubspace, (2) construct a transient browser
    // anchored on the_dubspace relay with refreshed session_auth, and
    // (3) dispatch the turn there. If the routing helper is bypassed or
    // misconfigured, the chatroom-bound submit lands on the wrong relay
    // and the SPA sees `commit_rejected`.
    const world = createWorld();
    const session = world.auth("guest:enter-dubspace-routing-e2e");
    await world.directCall("setup:enter-chatroom-routing-e2e", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    const serialized = world.exportWorld();
    const sessions = world.exportSessions();
    const bearer = shadowBrowserSessionBearer({ id: session.id, actor: session.actor });

    // WS-bound relay + browser: scope=the_chatroom (the worker's connection).
    const chatroomRelay = createShadowBrowserRelayShim({
      node: "browser-enter-dubspace-routing-e2e",
      scope: "the_chatroom" as ObjRef,
      serialized,
      deployment: "local-dev"
    });
    const chatroomAuth = buildShadowBrowserSessionAuth({
      sessions,
      scope: "the_chatroom" as ObjRef,
      deployment: chatroomRelay.deployment
    });
    chatroomRelay.session_auth = chatroomAuth.session_auth;
    chatroomRelay.session_revs = chatroomAuth.session_revs;
    refreshRelaySessions(chatroomRelay, sessions);
    const chatroomBrowser = createShadowBrowserClient({
      node: "browser-enter-dubspace-routing-e2e",
      scope: "the_chatroom" as ObjRef,
      actor: session.actor,
      session: session.id,
      relay: chatroomRelay,
      token: bearer
    });

    // The SPA's chat-issued intent: chatroom scope + dubspace target. The
    // shadowBrowserEnvelope helper signs the envelope as the chatroom
    // browser; that bearer must still validate inside the dubspace relay
    // after the WS handler reroutes.
    const intent = shadowBrowserEnvelope(chatroomBrowser, "woo.turn.intent.request.shadow.v1", {
      kind: "woo.turn.intent.request.shadow.v1",
      id: "intent-enter-dubspace-routing-e2e",
      route: "direct",
      scope: "the_chatroom" as ObjRef,
      target: "the_dubspace" as ObjRef,
      verb: "enter",
      args: [],
      persistence: "live"
    });
    const encoded = encodeEnvelope(intent);

    // Replicate the dev WS handler's routing step verbatim. If this drifts
    // from `handleV2ShadowFrame`, update both.
    const callScope = resolveTurnEnvelopeScope(world, encoded);
    expect(callScope).toBe("the_dubspace");

    // Build the transient routed relay+browser exactly as the dev handler
    // does, including the session-auth refresh.
    const dubspaceRelay = createShadowBrowserRelayShim({
      node: "browser-enter-dubspace-routing-e2e",
      scope: "the_dubspace" as ObjRef,
      serialized,
      deployment: "local-dev"
    });
    const dubspaceAuth = buildShadowBrowserSessionAuth({
      sessions,
      scope: "the_dubspace" as ObjRef,
      deployment: dubspaceRelay.deployment
    });
    dubspaceRelay.session_auth = dubspaceAuth.session_auth;
    dubspaceRelay.session_revs = dubspaceAuth.session_revs;
    refreshRelaySessions(dubspaceRelay, sessions);
    const dubspaceBrowser = createShadowBrowserClient({
      node: "browser-enter-dubspace-routing-e2e",
      scope: "the_dubspace" as ObjRef,
      actor: session.actor,
      session: session.id,
      relay: dubspaceRelay,
      token: bearer
    });

    // The chatroom-signed envelope must still validate inside the dubspace
    // relay (different scope, same deployment). If this throws, the SPA
    // surfaces `commit_rejected` and the user sees a stuck chat line.
    const receipt = receiveShadowBrowserEnvelopeReceipt(dubspaceBrowser, encoded);
    const reply = await handleShadowBrowserTurnExecEnvelope(dubspaceBrowser, receipt);
    expect(reply?.body).toMatchObject({ ok: true });
    if (!reply || reply.body.ok !== true) return;
    expect(reply.body.transcript?.scope).toBe("the_dubspace");
    expect(reply.body.transcript?.call).toMatchObject({ target: "the_dubspace", verb: "enter" });
  });

  it("preserves the wire-token mapping on the transient relay when routing cross-scope (regression: refresh order)", async () => {
    // Pins the subtle order-of-operations bug that bit `enter dubspace` from
    // a chat-attached WS: `createShadowBrowserClient` installs the wire
    // token (e.g. `session:<id>`) into the destination relay's session_auth
    // via `setShadowBrowserSessionToken`, but a follow-on call to
    // `refreshDevV2RelaySessions` rebuilds the map from scratch and only
    // re-registers wire tokens for browsers tracked in `relay.browsers`.
    // The transient cross-scope browser is intentionally not subscribed
    // there, so refreshing AFTER createShadowBrowserClient wipes the wire
    // token and the next envelope fails with
    // `E_INTERNAL: shadow browser auth token is unknown`, which the WS
    // handler then surfaces to the SPA as `commit_rejected`.
    const world = createWorld();
    const session = world.auth("guest:cross-scope-refresh-order");
    await world.directCall("setup:enter-chatroom-refresh-order", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    const serialized = world.exportWorld();
    const wireToken = `session:${session.id}`;

    // Build the dubspace relay exactly as v2RelayForScope does the first
    // time it sees the scope: createShadowBrowserRelayShim with the live
    // world export. session_auth then has only the local shadow-session
    // bearer (no wire token yet).
    const dubspaceRelay = createShadowBrowserRelayShim({
      node: "browser-cross-scope-refresh-order",
      scope: "the_dubspace" as ObjRef,
      serialized,
      deployment: "local-dev"
    });

    // Create the transient browser the same way `v2ShadowBrowser` does:
    // createShadowBrowserClient internally calls
    // `setShadowBrowserSessionToken` which copies the local-bearer claims
    // to the wire token in session_auth and then deletes the local bearer.
    const dubspaceBrowser = createShadowBrowserClient({
      node: "browser-cross-scope-refresh-order",
      scope: "the_dubspace" as ObjRef,
      actor: session.actor,
      session: session.id,
      relay: dubspaceRelay,
      token: wireToken
    });
    expect(dubspaceRelay.session_auth.has(wireToken), "wire token registered after createShadowBrowserClient").toBe(true);

    // The SPA's envelope uses the wire token as auth.token (the worker
    // passes through `current.token` which is the page's session token,
    // not the shadow-local bearer).
    const intent = {
      v: 2 as const,
      type: "woo.turn.intent.request.shadow.v1" as const,
      id: "intent-refresh-order",
      from: dubspaceBrowser.node,
      to: dubspaceRelay.node,
      actor: session.actor as ObjRef,
      session: session.id,
      auth: { mode: "session" as const, token: wireToken },
      body: {
        kind: "woo.turn.intent.request.shadow.v1" as const,
        id: "intent-refresh-order",
        route: "direct" as const,
        scope: "the_chatroom" as ObjRef,
        target: "the_dubspace" as ObjRef,
        verb: "enter",
        args: [],
        persistence: "live" as const
      }
    };

    // No extra `refreshDevV2RelaySessions` after the createShadowBrowserClient
    // — this mirrors the fixed handler order. If a future change adds an
    // unconditional refresh here, this test fails with
    // "shadow browser auth token is unknown".
    const receipt = receiveShadowBrowserEnvelopeReceipt(dubspaceBrowser, encodeEnvelope(intent));
    const reply = await handleShadowBrowserTurnExecEnvelope(dubspaceBrowser, receipt);
    expect(reply?.body, "WS-style cross-scope enter must succeed").toMatchObject({ ok: true });
    if (!reply || reply.body.ok !== true) return;
    expect(reply.body.transcript?.scope).toBe("the_dubspace");
    expect(reply.body.transcript?.observations ?? []).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "dubspace_entered" })
    ]));
  });

  it("plans 'enter pinboard' with plan.space === target so the SPA does not submit on the chat room", async () => {
    // Regression for the chat command's plan/execute split: when the matched
    // verb's `arg_spec.command.route` is "sequenced" and the target is a
    // $space (`pinboard:enter`, `outliner:enter`), the substrate plans with
    // `space: target`. If the SPA ignores `plan.space` and uses the chat
    // room as the intent scope, the executed turn records `transcript.scope
    // = chat_room` while the dev WS routes to the target's relay → the
    // commit submits on the wrong scope and rejects as `scope_mismatch:
    // submit=<chat_room> transcript=<chat_room> scope=<target>`. This test
    // pins the substrate's plan shape so the SPA fix can rely on it.
    const world = createWorld();
    const session = world.auth("guest:enter-pinboard-plan-space");
    // Mirror the user's flow: enter the chatroom and walk to the deck so
    // the chat panel's space is the_deck when they type `enter pinboard`.
    await world.directCall("setup:enter-chatroom-pp", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    await world.directCall("setup:goto-deck-pp", session.actor, "exit_living_room_southeast", "move", [session.actor], { sessionId: session.id });

    const planFrame = await world.directCall(
      "plan-enter-pinboard",
      session.actor,
      "the_deck",
      "command_plan",
      ["enter pinboard"],
      { sessionId: session.id }
    );
    expect(planFrame.op).toBe("result");
    if (planFrame.op !== "result") return;
    const plan = planFrame.result as { ok?: boolean; route?: string; space?: string | null; target?: string; verb?: string };
    expect(plan).toMatchObject({
      ok: true,
      route: "sequenced",
      target: "the_pinboard",
      verb: "enter"
    });
    // The substrate's contract: sequenced commands on a $space target plan
    // with `space === target`. The SPA must use this as the intent scope.
    expect(plan.space).toBe("the_pinboard");
  });

  it("plans 'enter tub' (chatroom → chatroom) with plan.space === target so the SPA does not submit on the source room", async () => {
    // Regression for the user-visible bug: standing on the_deck, typing
    // `enter tub` in chat was returning `commit_rejected: scope_mismatch
    // submit=the_hot_tub transcript=the_hot_tub scope=the_deck`. Root cause:
    // chat:enter's arg_spec.command was missing `route: "sequenced"`, so the
    // planner defaulted route="direct" and left plan.space=null. The SPA
    // then submitted with intent.scope=the_deck (caller's chat room) while
    // the executor ran the verb body against the_hot_tub — the validator
    // saw submit.scope vs transcript.scope vs commitScope.scope all
    // disagree. Adding `route: sequenced` to chat:enter mirrors the fix
    // already in place for pinboard:enter and outliner:enter.
    const world = createWorld();
    const session = world.auth("guest:enter-tub-plan-space");
    await world.directCall("setup:enter-chatroom-tub", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    await world.directCall("setup:goto-deck-tub", session.actor, "exit_living_room_southeast", "move", [session.actor], { sessionId: session.id });

    const planFrame = await world.directCall(
      "plan-enter-tub",
      session.actor,
      "the_deck",
      "command_plan",
      ["enter tub"],
      { sessionId: session.id }
    );
    expect(planFrame.op).toBe("result");
    if (planFrame.op !== "result") return;
    const plan = planFrame.result as { ok?: boolean; route?: string; space?: string | null; target?: string; verb?: string };
    expect(plan).toMatchObject({
      ok: true,
      route: "sequenced",
      target: "the_hot_tub",
      verb: "enter"
    });
    expect(plan.space).toBe("the_hot_tub");
  });

  it("refreshes the destination relay's scope/target/actor rows when routing to a pre-existing cross-scope relay (regression: explicit-rows authority slice)", async () => {
    // Aligns the dev WS path with the explicit-rows authority-slice
    // contract the REST and MCP paths follow (`[input.scope, input.target,
    // input.actor]` in persistent-object-do.ts; `[scope, target]` in
    // mcp/gateway.ts). For an existing destination relay, `v2RelayForScope`
    // only refreshes session_auth — not the serialized target/scope/actor
    // rows — so the destination can plan against stale state if the dev
    // handler doesn't pass explicit rows.
    //
    // This test pins the routing-helper output that the handler feeds to
    // `refreshDevV2RelaySessions`. Specifically: for a cross-scope
    // pinboard:enter intent issued from the deck, the resolver must
    // return scope=the_pinboard AND target=the_pinboard so both rows are
    // refreshed before planning. If the helper drops `target` (or the
    // handler forgets to use it as an explicit row), the destination
    // relay's snapshot of the_pinboard would be the world-export from
    // first relay creation and would not reflect any later mutation —
    // exactly the divergence the reviewer flagged.
    const world = createWorld();
    const session = world.auth("guest:explicit-rows-cross-scope");
    await world.directCall("setup:enter-chatroom-rows", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    await world.directCall("setup:goto-deck-rows", session.actor, "exit_living_room_southeast", "move", [session.actor], { sessionId: session.id });

    // The SPA's chat-issued sequenced enter for pinboard. plan.space ===
    // target after the planner fix.
    const intent = {
      v: 2 as const,
      type: "woo.turn.intent.request.shadow.v1" as const,
      id: "intent-explicit-rows",
      from: "browser-explicit-rows",
      to: "node:dev:relay",
      actor: session.actor as ObjRef,
      session: session.id,
      auth: { mode: "session" as const, token: `session:${session.id}` },
      body: {
        kind: "woo.turn.intent.request.shadow.v1" as const,
        id: "intent-explicit-rows",
        route: "sequenced" as const,
        scope: "the_pinboard" as ObjRef,
        target: "the_pinboard" as ObjRef,
        verb: "enter",
        args: [],
        persistence: "durable" as const
      }
    };
    const routing = resolveTurnEnvelopeRouting(world, encodeEnvelope(intent));
    expect(routing).toMatchObject({ scope: "the_pinboard", target: "the_pinboard" });
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
