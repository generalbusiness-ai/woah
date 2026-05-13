import { describe, expect, it } from "vitest";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import { encodeEnvelope } from "../src/core/shadow-envelope";
import { stableShadowJson } from "../src/core/shadow-cell-version";
import {
  applyShadowBrowserTransfer,
  buildShadowBrowserProjectionTransfer,
  createShadowBrowserNode,
  createShadowBrowserRelayShim,
  emitShadowBrowserLiveEvent,
  executeShadowBrowserTurn,
  handleShadowBrowserTurnExecEnvelope,
  openShadowBrowserScope,
  purgeShadowBrowserRelayHistory,
  receiveShadowBrowserEnvelope,
  receiveShadowBrowserEnvelopeReceipt,
  roundTripShadowBrowserEnvelope,
  setShadowBrowserSessionToken,
  shadowBrowserEnvelope,
  shadowBrowserTransportHello,
  unsubscribeShadowBrowserNode,
  type ShadowBrowserStateTransfer,
  type ShadowBrowserNode,
  type ShadowLiveEvent
} from "../src/core/shadow-browser-node";
import { hashSource } from "../src/core/source-hash";
import type { ObjRef, WooValue } from "../src/core/types";
import { runShadowTurnCall, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";

describe("shadow browser node shim", () => {
  it("opens a browser-style dubspace node and commits a real control action", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-dubspace");
    const opened = await openShadowBrowserScope(browser, { preseed_catalog_pages: true });

    const turn = await executeShadowBrowserTurn(browser, {
      id: "browser-dubspace-wet",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.44]
    });

    expect(opened.preseeded_objects).toBeGreaterThan(0);
    expect(turn.network.first).toMatchObject({ ok: false, reason: "missing_state", attempted: false });
    expect(turn.result).toMatchObject({
      ok: true,
      reply: { kind: "woo.turn.exec.reply.shadow.v1", ok: true },
      commit: { kind: "woo.commit.accepted.shadow.v1", position: { scope: "the_dubspace", seq: 1 } }
    });
    expect(browser.cache.pending_turns.size).toBe(0);
    expect(browser.cache.applied_frames).toHaveLength(1);
    expect(browser.cache.transcript_tail).toHaveLength(1);
    expect(browser.cache.transfers.length).toBeGreaterThanOrEqual(1);
    expect(worldFor(browser).getProp("delay_1", "wet")).toBe(0.44);
  });

  it("drives pinboard create, edit, layout, take, and drop actions through the browser shim", async () => {
    const { browser, actor } = await browserForScope("the_pinboard", "guest:browser-pinboard");
    await openShadowBrowserScope(browser, { preseed_catalog_pages: true });

    const add = await executeShadowBrowserTurn(browser, {
      id: "browser-pinboard-add",
      target: "the_pinboard",
      verb: "add_note",
      args: ["v2 browser note", "yellow", 20, 30, 210, 120]
    });
    expect(add.result).toMatchObject({ ok: true });
    if (!add.result.ok) throw new Error(`pinboard add failed: ${add.result.reason}`);
    const pin = observationObject(add, "note_added", "pin");
    let world = worldFor(browser);
    expect(world.getProp(pin, "text")).toBe("v2 browser note");
    expect(world.getProp(pin, "color")).toBe("yellow");

    const move = await executeShadowBrowserTurn(browser, {
      id: "browser-pinboard-move",
      target: "the_pinboard",
      verb: "move_pin",
      args: [pin, 88, 99]
    });
    expect(move.result).toMatchObject({ ok: true });
    world = worldFor(browser);
    const layout = world.getProp("the_pinboard", "layout") as Record<string, WooValue>;
    expect(layout[pin]).toMatchObject({ x: 88, y: 99 });

    const resize = await executeShadowBrowserTurn(browser, {
      id: "browser-pinboard-resize",
      target: "the_pinboard",
      verb: "resize_pin",
      args: [pin, 300, 180]
    });
    expect(resize.result).toMatchObject({ ok: true });

    const recolor = await executeShadowBrowserTurn(browser, {
      id: "browser-pinboard-recolor",
      target: pin,
      verb: "set_color",
      args: ["green"]
    });
    expect(recolor.result).toMatchObject({ ok: true });

    const edit = await executeShadowBrowserTurn(browser, {
      id: "browser-pinboard-edit",
      target: pin,
      verb: "set_text",
      args: ["browser-edited note"]
    });
    expect(edit.result).toMatchObject({ ok: true });

    const take = await executeShadowBrowserTurn(browser, {
      id: "browser-pinboard-take",
      target: "the_pinboard",
      verb: "take",
      args: [pin]
    });
    expect(take.result).toMatchObject({ ok: true });
    world = worldFor(browser);
    expect(world.object(pin).location).toBe(actor);
    expect((world.getProp("the_pinboard", "layout") as Record<string, WooValue>)[pin]).toBeUndefined();

    const drop = await executeShadowBrowserTurn(browser, {
      id: "browser-pinboard-drop",
      target: "the_pinboard",
      verb: "drop",
      args: ["sticky note"]
    });
    expect(drop.result).toMatchObject({ ok: true });
    world = worldFor(browser);
    const finalLayout = world.getProp("the_pinboard", "layout") as Record<string, WooValue>;
    expect(world.object(pin).location).toBe("the_pinboard");
    expect(world.getProp(pin, "text")).toBe("browser-edited note");
    expect(world.getProp(pin, "color")).toBe("green");
    expect(finalLayout[pin]).toMatchObject({ w: 180, h: 110 });
    expect(browser.cache.applied_frames).toHaveLength(7);
  });

  it("drives taskspace create, claim, and status actions through the browser shim", async () => {
    const { browser, actor } = await browserForScope("the_taskspace", "guest:browser-taskspace");
    await openShadowBrowserScope(browser, { preseed_catalog_pages: true });

    const create = await executeShadowBrowserTurn(browser, {
      id: "browser-task-create",
      target: "the_taskspace",
      verb: "create_task",
      args: ["Profile browser shim", "Prove taskspace works through v2."]
    });
    expect(create.result).toMatchObject({ ok: true });
    if (!create.result.ok) throw new Error(`task create failed: ${create.result.reason}`);
    const task = observationObject(create, "task_created", "task");
    let world = worldFor(browser);
    expect(world.getProp(task, "text")).toBe("Prove taskspace works through v2.");
    expect(world.getProp(task, "status")).toBe("open");

    const claim = await executeShadowBrowserTurn(browser, {
      id: "browser-task-claim",
      target: task,
      verb: "claim"
    });
    expect(claim.result).toMatchObject({ ok: true });

    const status = await executeShadowBrowserTurn(browser, {
      id: "browser-task-status",
      target: task,
      verb: "set_status",
      args: ["in_progress"]
    });
    expect(status.result).toMatchObject({ ok: true });
    world = worldFor(browser);
    expect(world.getProp(task, "assignee")).toBe(actor);
    expect(world.getProp(task, "status")).toBe("in_progress");
    expect(browser.cache.applied_frames).toHaveLength(3);
  });

  it("drives chat take and drop through the browser shim", async () => {
    const { browser, actor } = await browserForScope("the_chatroom", "guest:browser-chat");
    await openShadowBrowserScope(browser, { preseed_catalog_pages: true });

    const take = await executeShadowBrowserTurn(browser, {
      id: "browser-chat-take",
      target: "the_chatroom",
      verb: "take",
      args: ["mug"]
    });
    expect(take.result).toMatchObject({ ok: true });
    let world = worldFor(browser);
    expect(world.object("the_mug").location).toBe(actor);

    const drop = await executeShadowBrowserTurn(browser, {
      id: "browser-chat-drop",
      target: "the_chatroom",
      verb: "drop",
      args: ["mug"]
    });
    expect(drop.result).toMatchObject({ ok: true });
    world = worldFor(browser);
    expect(world.object("the_mug").location).toBe("the_chatroom");
    expect(browser.cache.applied_frames).toHaveLength(2);
  });

  it("fans out coalesced live events without advancing committed state", async () => {
    const anchor = createWorld();
    const firstSession = anchor.auth("guest:browser-live-a");
    const secondSession = anchor.auth("guest:browser-live-b");
    await anchor.directCall("browser-live-a-enter", firstSession.actor, "the_dubspace", "enter", [], { sessionId: firstSession.id });
    await anchor.directCall("browser-live-b-enter", secondSession.actor, "the_dubspace", "enter", [], { sessionId: secondSession.id });
    const relay = createShadowBrowserRelayShim({
      node: "browser-live-relay",
      scope: "the_dubspace",
      serialized: anchor.exportWorld()
    });
    const first = createShadowBrowserNode({
      node: "browser-live-a",
      scope: "the_dubspace",
      actor: firstSession.actor,
      session: firstSession.id,
      relay
    });
    const second = createShadowBrowserNode({
      node: "browser-live-b",
      scope: "the_dubspace",
      actor: secondSession.actor,
      session: secondSession.id,
      relay
    });
    await openShadowBrowserScope(first);
    await openShadowBrowserScope(second);

    const headBefore = structuredClone(relay.commit_scope.head);
    emitShadowBrowserLiveEvent(first, {
      id: "browser-live-preview-1",
      source: "delay_1",
      observation: { type: "control_preview", source: "delay_1", control: "wet", value: 0.25 },
      coalesce: "delay_1:wet"
    });
    emitShadowBrowserLiveEvent(first, {
      id: "browser-live-preview-2",
      source: "delay_1",
      observation: { type: "control_preview", source: "delay_1", control: "wet", value: 0.5 },
      coalesce: "delay_1:wet"
    });

    expect(relay.commit_scope.head).toEqual(headBefore);
    expect(relay.live_events).toHaveLength(2);
    expect(first.cache.live_events).toHaveLength(0);
    expect(second.cache.live_events).toHaveLength(1);
    expect(second.cache.live_events[0]).toMatchObject({
      id: "browser-live-preview-2",
      actor: firstSession.actor,
      observation: { type: "control_preview", source: "delay_1", control: "wet", value: 0.5 }
    });
    expect(first.cache.applied_frames).toHaveLength(0);
    expect(second.cache.applied_frames).toHaveLength(0);
  });

  it("delivers accepted commits to subscribed browser nodes as state-plane deltas", async () => {
    const anchor = createWorld();
    const firstSession = anchor.auth("guest:browser-state-a");
    const secondSession = anchor.auth("guest:browser-state-b");
    await anchor.directCall("browser-state-a-enter", firstSession.actor, "the_dubspace", "enter", [], { sessionId: firstSession.id });
    await anchor.directCall("browser-state-b-enter", secondSession.actor, "the_dubspace", "enter", [], { sessionId: secondSession.id });
    const relay = createShadowBrowserRelayShim({
      node: "browser-state-relay",
      scope: "the_dubspace",
      serialized: anchor.exportWorld()
    });
    const first = createShadowBrowserNode({
      node: "browser-state-a",
      scope: "the_dubspace",
      actor: firstSession.actor,
      session: firstSession.id,
      relay
    });
    const second = createShadowBrowserNode({
      node: "browser-state-b",
      scope: "the_dubspace",
      actor: secondSession.actor,
      session: secondSession.id,
      relay
    });
    const third = createShadowBrowserNode({
      node: "browser-state-unsubscribed",
      scope: "the_dubspace",
      actor: secondSession.actor,
      session: secondSession.id,
      relay
    });
    relay.browsers.set(third.node, third);
    await openShadowBrowserScope(first, { preseed_catalog_pages: true });
    await openShadowBrowserScope(second, { preseed_catalog_pages: true });

    const turn = await executeShadowBrowserTurn(first, {
      id: "browser-state-wet",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.91]
    });

    expect(turn.result).toMatchObject({ ok: true });
    expect(first.cache.applied_frames).toHaveLength(1);
    expect(second.cache.applied_frames).toHaveLength(1);
    expect(first.cache.transcript_tail).toHaveLength(1);
    expect(second.cache.transcript_tail).toHaveLength(1);
    expect(second.cache.transfers.some((transfer) => transfer.mode === "delta")).toBe(true);
    expect(third.cache.transfers.some((transfer) => transfer.mode === "delta")).toBe(false);
    expect(third.cache.applied_frames).toHaveLength(0);
    expect(second.cache.projections.get("the_dubspace")).toMatchObject({
      kind: "woo.scope_projection.shadow.v1",
      scope: "the_dubspace",
      seq: 1
    });
    expect(worldFor(first).getProp("delay_1", "wet")).toBe(0.91);
  });

  it("rejects tampered browser projection transfers", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-state-proof");
    const opened = await openShadowBrowserScope(browser);
    const transfer = browser.cache.transfers.find((item) => item.mode === "projection");
    expect(transfer).toBeDefined();
    if (!transfer || transfer.mode !== "projection") throw new Error("expected projection transfer");
    const tampered = structuredClone(transfer);
    tampered.projection = { ...(opened.projection as Record<string, WooValue>), seq: 999 };

    expect(() => applyShadowBrowserTransfer(browser, tampered)).toThrow(/proof root mismatch/);
  });

  it("rejects projection tampering even when the public root is rebuilt", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-state-rebuilt-proof");
    const opened = await openShadowBrowserScope(browser);
    const transfer = browser.cache.transfers.find((item) => item.mode === "projection");
    if (!transfer || transfer.mode !== "projection") throw new Error("expected projection transfer");
    const tampered = structuredClone(transfer);
    tampered.projection = { ...(opened.projection as Record<string, WooValue>), seq: 999 };
    tampered.proof.root = browserStateRootForTest(tampered);

    expect(() => applyShadowBrowserTransfer(browser, tampered)).toThrow(/signature mismatch/);
  });

  it("rejects tampered browser delta transfers", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-delta-proof");
    await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
    const turn = await executeShadowBrowserTurn(browser, {
      id: "browser-delta-proof-wet",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.93]
    });
    expect(turn.result).toMatchObject({ ok: true });
    const delta = browser.cache.transfers.find((item) => item.mode === "delta");
    if (!delta || delta.mode !== "delta") throw new Error("expected delta transfer");

    const tamperedProjection = structuredClone(delta);
    tamperedProjection.projection = { ...(delta.projection as Record<string, WooValue>), seq: 999 };
    expect(() => applyShadowBrowserTransfer(browser, tamperedProjection)).toThrow(/proof root mismatch/);

    const tamperedTranscript = structuredClone(delta);
    tamperedTranscript.transcript_tail[0] = {
      ...tamperedTranscript.transcript_tail[0],
      call: { ...tamperedTranscript.transcript_tail[0].call, verb: "tampered" }
    };
    expect(() => applyShadowBrowserTransfer(browser, tamperedTranscript)).toThrow(/transcript hash mismatch/);
  });

  it("validates session auth in the in-process relay shim", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-auth");
    await openShadowBrowserScope(browser);
    const live = {
      kind: "woo.live.event.shadow.v1" as const,
      id: "browser-auth-live",
      source: "delay_1",
      actor: browser.actor,
      scope: "the_dubspace",
      observation: { type: "control_preview", source: "delay_1", control: "wet", value: 0.22 },
      coalesce: "the_dubspace/delay_1/control/wet"
    };
    const bad = shadowBrowserEnvelope(browser, live.kind, live);
    bad.auth = { mode: "session", token: "shadow-session:missing" };

    expect(() => receiveShadowBrowserEnvelope(browser, encodeEnvelope(bad))).toThrow(/token is unknown/);
  });

  it("rejects deployment and rev-mismatched session tokens in the relay shim", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-auth-binding");

    const claims = browser.relay.session_auth.get(browser.session_token ?? "");
    if (!claims || !browser.session) throw new Error("expected test session claims");
    claims.deployment = "wrong-deployment";
    expect(() => shadowBrowserTransportHello(browser)).toThrow(/deployment mismatch/);

    claims.deployment = browser.relay.deployment;
    browser.relay.session_revs.set(browser.session, claims.rev + 1);
    expect(() => shadowBrowserTransportHello(browser)).toThrow(/rev mismatch/);
  });

  it("advertises the M4 idempotency window through transport hello", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-hello");
    const hello = shadowBrowserTransportHello(browser, 12345);
    const roundTripped = roundTripShadowBrowserEnvelope(browser, hello.kind, hello);

    expect(hello).toMatchObject({
      kind: "woo.transport.hello.v1",
      relay: "browser-relay",
      actor: browser.actor,
      session: browser.session,
      server_time: 12345,
      idempotency_window_ms: 300000,
      planes: ["execution", "commit", "state", "live"]
    });
    expect(roundTripped.body).toEqual(hello);
  });

  it("rejects live envelopes carrying durability-reserved fields", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-live-durable");
    await openShadowBrowserScope(browser);
    const live: ShadowLiveEvent & { writes: WooValue[] } = {
      kind: "woo.live.event.shadow.v1",
      id: "browser-live-durable",
      source: "delay_1",
      actor: browser.actor,
      scope: "the_dubspace",
      observation: { type: "control_preview", source: "delay_1", control: "wet", value: 0.22 },
      writes: []
    };
    const env = shadowBrowserEnvelope(browser, live.kind, live);

    expect(() => receiveShadowBrowserEnvelope(browser, encodeEnvelope(env))).toThrow(/durability-reserved field: writes/);
    expect(browser.relay.live_events).toHaveLength(0);
  });

  it("suppresses duplicate authority-bearing envelopes within the idempotency window", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-idempotent");
    await openShadowBrowserScope(browser);
    const live: ShadowLiveEvent = {
      kind: "woo.live.event.shadow.v1",
      id: "browser-idempotent-live",
      source: "delay_1",
      actor: browser.actor,
      scope: "the_dubspace",
      observation: { type: "control_preview", source: "delay_1", control: "wet", value: 0.22 }
    };
    const frame = encodeEnvelope(shadowBrowserEnvelope(browser, live.kind, live, "same-envelope-id"));

    receiveShadowBrowserEnvelope(browser, frame);
    receiveShadowBrowserEnvelope(browser, frame);

    expect(browser.relay.live_events).toHaveLength(1);
    expect(browser.relay.recently_seen.size).toBe(1);
    for (const key of browser.relay.recently_seen.keys()) {
      browser.relay.recently_seen.set(key, Date.now() - browser.relay.idempotency_window_ms - 1);
    }
    receiveShadowBrowserEnvelope(browser, frame);
    expect(browser.relay.live_events).toHaveLength(2);
  });

  it("keeps wire dispatch state across envelopes on the same browser", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-wire-state");
    await openShadowBrowserScope(browser);
    setShadowBrowserSessionToken(browser, "wire-token");
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "wire-state-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: browser.session,
      actor: browser.actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.61]
    };
    const planned = await runShadowTurnCall(browser.relay.commit_scope.serialized, call);
    const request = {
      kind: "woo.turn.exec.request.shadow.v1" as const,
      id: "wire-state-wet",
      call,
      key: shadowTurnKeyFromTranscript(planned.transcript),
      expected: browser.relay.commit_scope.head,
      auth: { mode: "shadow_local" as const, actor: browser.actor, session: browser.session },
      commit_policy: "execute_and_commit" as const
    };
    const encoded = encodeEnvelope(shadowBrowserEnvelope(browser, request.kind, request, "wire-env-1"));

    const first = receiveShadowBrowserEnvelopeReceipt(browser, encoded);
    const firstReply = await handleShadowBrowserTurnExecEnvelope(browser, first);
    const duplicate = receiveShadowBrowserEnvelopeReceipt(browser, encoded);
    const duplicateReply = await handleShadowBrowserTurnExecEnvelope(browser, duplicate);

    expect(first.fresh).toBe(true);
    expect(firstReply?.body).toMatchObject({ kind: "woo.turn.exec.reply.shadow.v1", ok: true });
    expect(duplicate.fresh).toBe(false);
    expect(duplicateReply).toBeNull();
    expect(browser.cache.applied_frames).toHaveLength(1);
    expect(browser.relay.accepted_frames).toHaveLength(1);
  });

  it("opens from a last-known head through delta catch-up when the relay has the tail", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-catchup-delta");
    const opened = await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
    const base = structuredClone(browser.relay.commit_scope.head);
    expect(opened.transfer_mode).toBe("projection");

    const turn = await executeShadowBrowserTurn(browser, {
      id: "browser-catchup-delta-wet",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.77]
    });
    expect(turn.result).toMatchObject({ ok: true });

    const reconnected = createShadowBrowserNode({
      node: "browser-catchup-delta-reconnect",
      scope: "the_dubspace",
      actor: browser.actor,
      session: browser.session,
      relay: browser.relay
    });
    const caughtUp = await openShadowBrowserScope(reconnected, { last_known_head: base });

    expect(caughtUp.transfer_mode).toBe("delta");
    expect(reconnected.cache.applied_frames).toHaveLength(1);
    expect(reconnected.cache.transcript_tail).toHaveLength(1);
    expect(reconnected.cache.projections.get("the_dubspace")).toMatchObject({ seq: 1 });
  });

  it("opens from a last-known head through a multi-frame delta catch-up", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-catchup-multi");
    await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
    const base = structuredClone(browser.relay.commit_scope.head);

    for (const [id, wet] of [["multi-1", 0.11], ["multi-2", 0.22], ["multi-3", 0.33]] as const) {
      const turn = await executeShadowBrowserTurn(browser, {
        id,
        target: "the_dubspace",
        verb: "set_control",
        args: ["delay_1", "wet", wet]
      });
      expect(turn.result).toMatchObject({ ok: true });
    }

    const reconnected = createShadowBrowserNode({
      node: "browser-catchup-multi-reconnect",
      scope: "the_dubspace",
      actor: browser.actor,
      session: browser.session,
      relay: browser.relay
    });
    const caughtUp = await openShadowBrowserScope(reconnected, { last_known_head: base });

    expect(caughtUp.transfer_mode).toBe("delta");
    expect(reconnected.cache.applied_frames.map((frame) => frame.position.seq)).toEqual([1, 2, 3]);
    expect(reconnected.cache.transcript_tail.map((transcript) => transcript.hash)).toEqual(
      reconnected.cache.applied_frames.map((frame) => frame.transcript_hash)
    );
    expect(reconnected.cache.projections.get("the_dubspace")).toMatchObject({ seq: 3 });
  });

  it("falls back to projection catch-up when the relay has no delta tail", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-catchup-projection");
    await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
    const base = structuredClone(browser.relay.commit_scope.head);
    const turn = await executeShadowBrowserTurn(browser, {
      id: "browser-catchup-projection-wet",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.79]
    });
    expect(turn.result).toMatchObject({ ok: true });
    purgeShadowBrowserRelayHistory(browser.relay, "the_dubspace");

    const reconnected = createShadowBrowserNode({
      node: "browser-catchup-projection-reconnect",
      scope: "the_dubspace",
      actor: browser.actor,
      session: browser.session,
      relay: browser.relay
    });
    const caughtUp = await openShadowBrowserScope(reconnected, { last_known_head: base });

    expect(caughtUp.transfer_mode).toBe("projection");
    expect(reconnected.cache.applied_frames).toHaveLength(0);
    expect(reconnected.cache.transfers.find((transfer) => transfer.mode === "projection")).toBeDefined();
    expect(reconnected.cache.projections.get("the_dubspace")).toMatchObject({ seq: 1 });
  });

  it("reconciles a same-browser stale cache after projection fallback", async () => {
    const anchor = createWorld();
    const firstSession = anchor.auth("guest:browser-catchup-stale-a");
    const secondSession = anchor.auth("guest:browser-catchup-stale-b");
    await anchor.directCall("browser-catchup-stale-a-enter", firstSession.actor, "the_dubspace", "enter", [], { sessionId: firstSession.id });
    await anchor.directCall("browser-catchup-stale-b-enter", secondSession.actor, "the_dubspace", "enter", [], { sessionId: secondSession.id });
    const relay = createShadowBrowserRelayShim({
      node: "browser-catchup-stale-relay",
      scope: "the_dubspace",
      serialized: anchor.exportWorld()
    });
    const stale = createShadowBrowserNode({
      node: "browser-catchup-stale-a",
      scope: "the_dubspace",
      actor: firstSession.actor,
      session: firstSession.id,
      relay
    });
    const committer = createShadowBrowserNode({
      node: "browser-catchup-stale-b",
      scope: "the_dubspace",
      actor: secondSession.actor,
      session: secondSession.id,
      relay
    });
    await openShadowBrowserScope(stale, { preseed_catalog_pages: true });
    await openShadowBrowserScope(committer, { preseed_catalog_pages: true });
    const firstTurn = await executeShadowBrowserTurn(stale, {
      id: "browser-catchup-stale-first",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.41]
    });
    expect(firstTurn.result).toMatchObject({ ok: true });
    const staleHead = structuredClone(stale.cache.applied_frames[0].position);
    unsubscribeShadowBrowserNode(stale);

    const missedTurn = await executeShadowBrowserTurn(committer, {
      id: "browser-catchup-stale-missed",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.42]
    });
    expect(missedTurn.result).toMatchObject({ ok: true });
    expect(stale.cache.applied_frames.map((frame) => frame.position.seq)).toEqual([1]);
    purgeShadowBrowserRelayHistory(relay, "the_dubspace");

    const caughtUp = await openShadowBrowserScope(stale, { last_known_head: staleHead });

    expect(caughtUp.transfer_mode).toBe("projection");
    expect(stale.cache.applied_frames).toHaveLength(0);
    expect(stale.cache.transcript_tail).toHaveLength(0);
    expect(stale.cache.pending_turns.size).toBe(0);
    expect(stale.cache.projections.get("the_dubspace")).toMatchObject({ seq: 2 });
  });

  it("multiplexes commit, state, and live planes through one in-process envelope channel", async () => {
    const anchor = createWorld();
    const firstSession = anchor.auth("guest:browser-mux-a");
    const secondSession = anchor.auth("guest:browser-mux-b");
    await anchor.directCall("browser-mux-a-enter", firstSession.actor, "the_dubspace", "enter", [], { sessionId: firstSession.id });
    await anchor.directCall("browser-mux-b-enter", secondSession.actor, "the_dubspace", "enter", [], { sessionId: secondSession.id });
    const relay = createShadowBrowserRelayShim({
      node: "browser-mux-relay",
      scope: "the_dubspace",
      serialized: anchor.exportWorld()
    });
    const sender = createShadowBrowserNode({
      node: "browser-mux-a",
      scope: "the_dubspace",
      actor: firstSession.actor,
      session: firstSession.id,
      relay
    });
    const receiver = createShadowBrowserNode({
      node: "browser-mux-b",
      scope: "the_dubspace",
      actor: secondSession.actor,
      session: secondSession.id,
      relay
    });
    await openShadowBrowserScope(sender, { preseed_catalog_pages: true });
    await openShadowBrowserScope(receiver, { preseed_catalog_pages: true });

    const turn = await executeShadowBrowserTurn(sender, {
      id: "browser-mux-wet",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.31]
    });
    if (!turn.result.ok || !turn.result.commit) throw new Error("expected committed mux turn");
    const projection = buildShadowBrowserProjectionTransfer(relay, "the_dubspace", receiver.node);
    const live = {
      kind: "woo.live.event.shadow.v1" as const,
      id: "browser-mux-preview",
      source: "delay_1",
      actor: sender.actor,
      scope: "the_dubspace",
      observation: { type: "control_preview", source: "delay_1", control: "wet", value: 0.32 },
      coalesce: "the_dubspace/delay_1/control/wet"
    };

    const conflict = {
      kind: "woo.commit.conflict.shadow.v1" as const,
      id: "browser-mux-conflict",
      scope: "the_dubspace",
      current: relay.commit_scope.head,
      reason: "stale_head" as const,
      errors: ["multiplex harness conflict frame"],
      receipt: turn.result.receipt
    };
    const channel = [
      { browser: receiver, frame: encodeEnvelope(shadowBrowserEnvelope(receiver, "woo.commit.conflict.shadow.v1", conflict, "mux-commit")) },
      { browser: receiver, frame: encodeEnvelope(shadowBrowserEnvelope(receiver, "woo.state.transfer.shadow.v1", projection, "mux-state")) },
      { browser: sender, frame: encodeEnvelope(shadowBrowserEnvelope(sender, live.kind, live, "mux-live")) }
    ];
    for (const item of channel) receiveShadowBrowserEnvelope(item.browser, item.frame);

    expect(receiver.cache.conflicts.some((frame) => frame.id === "browser-mux-conflict")).toBe(true);
    expect(receiver.cache.transfers.some((transfer) => transfer.mode === "projection")).toBe(true);
    expect(receiver.cache.live_events).toHaveLength(1);
  });
});

async function browserForScope<T = undefined>(
  scope: ObjRef,
  token: string,
  setup?: (anchor: ReturnType<typeof createWorld>, session: ReturnType<ReturnType<typeof createWorld>["auth"]>) => Promise<T>
): Promise<{ browser: ShadowBrowserNode; actor: ObjRef; seed: T }> {
  const anchor = createWorld();
  const session = anchor.auth(token);
  await anchor.directCall(`${token}:enter:${scope}`, session.actor, scope, "enter", [], { sessionId: session.id });
  const seed = await setup?.(anchor, session) as T;
  const relay = createShadowBrowserRelayShim({
    node: "browser-relay",
    scope,
    serialized: anchor.exportWorld()
  });
  const browser = createShadowBrowserNode({
    node: `browser-${scope}`,
    scope,
    actor: session.actor,
    session: session.id,
    relay
  });
  return { browser, actor: session.actor, seed };
}

function worldFor(browser: ShadowBrowserNode): ReturnType<typeof createWorldFromSerialized> {
  return createWorldFromSerialized(browser.relay.commit_scope.serialized, { persist: false });
}

function observationObject(turn: { result: { transcript?: { observations: Array<Record<string, WooValue> & { type: string }> } } }, type: string, key: string): ObjRef {
  const observation = turn.result.transcript?.observations.find((item) => item.type === type);
  if (!observation) throw new Error(`expected ${type} observation`);
  const out = observation[key];
  if (typeof out !== "string") throw new Error(`expected ${type}.${key} object ref`);
  return out;
}

function browserStateRootForTest(transfer: Extract<ShadowBrowserStateTransfer, { mode: "projection" | "delta" }>): string {
  const material = {
    kind: "woo.browser_state_proof_material.shadow.v1",
    mode: transfer.mode,
    scope: transfer.scope,
    recipient: transfer.proof.recipient,
    head: transfer.to,
    projection: transfer.projection,
    applied: transfer.mode === "delta" ? transfer.applied.map((frame) => ({
      id: frame.id,
      position: frame.position,
      transcript_hash: frame.transcript_hash,
      post_state_hash: frame.post_state_hash
    })) : [],
    transcript_hashes: transfer.mode === "delta" ? transfer.transcript_tail.map((transcript) => transcript.hash) : []
  };
  return hashSource(stableShadowJson(material as unknown as WooValue));
}
