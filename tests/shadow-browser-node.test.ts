import { describe, expect, it } from "vitest";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import { stableShadowJson } from "../src/core/shadow-cell-version";
import {
  applyShadowBrowserTransfer,
  createShadowBrowserNode,
  createShadowBrowserRelayShim,
  emitShadowBrowserLiveEvent,
  executeShadowBrowserTurn,
  openShadowBrowserScope,
  type ShadowBrowserStateTransfer,
  type ShadowBrowserNode
} from "../src/core/shadow-browser-node";
import { hashSource } from "../src/core/source-hash";
import type { ObjRef, WooValue } from "../src/core/types";

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
