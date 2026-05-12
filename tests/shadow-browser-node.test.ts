import { describe, expect, it } from "vitest";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import {
  createShadowBrowserNode,
  createShadowBrowserRelayShim,
  executeShadowBrowserTurn,
  openShadowBrowserScope,
  type ShadowBrowserNode
} from "../src/core/shadow-browser-node";
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

  it("drives pinboard layout actions through the browser shim", async () => {
    const { browser, seed: pin } = await browserForScope("the_pinboard", "guest:browser-pinboard", async (anchor, session) => {
      const frame = await anchor.call("seed-pinboard-note", session.id, "the_pinboard", {
        actor: session.actor,
        target: "the_pinboard",
        verb: "add_note",
        args: ["seed browser note", "yellow", 20, 30, 210, 120]
      });
      return frameObservationObject(frame, "note_added", "pin");
    });
    await openShadowBrowserScope(browser, { preseed_catalog_pages: true });

    let world = worldFor(browser);
    expect(world.getProp(pin, "text")).toBe("seed browser note");
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
    expect(browser.cache.applied_frames).toHaveLength(1);
  });

  it("drives taskspace claim and status actions through the browser shim", async () => {
    const { browser, actor, seed: task } = await browserForScope("the_taskspace", "guest:browser-taskspace", async (anchor, session) => {
      const frame = await anchor.call("seed-browser-task", session.id, "the_taskspace", {
        actor: session.actor,
        target: "the_taskspace",
        verb: "create_task",
        args: ["Profile browser shim", "Prove taskspace works through v2."]
      });
      return frameObservationObject(frame, "task_created", "task");
    });
    await openShadowBrowserScope(browser, { preseed_catalog_pages: true });

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
    expect(browser.cache.applied_frames).toHaveLength(2);
  });

  it("records current catalog creation gaps through the browser shim", async () => {
    const { browser: pinboard } = await browserForScope("the_pinboard", "guest:browser-pinboard-create-gap");
    await openShadowBrowserScope(pinboard, { preseed_catalog_pages: true });

    const add = await executeShadowBrowserTurn(pinboard, {
      id: "browser-pinboard-add-gap",
      target: "the_pinboard",
      verb: "add_note",
      args: ["v2 browser note", "yellow", 20, 30, 210, 120]
    });
    expect(add.result).toMatchObject({
      ok: false,
      reason: "commit_rejected",
      commit: { kind: "woo.commit.conflict.shadow.v1" }
    });
    if (add.result.ok || add.result.reason !== "commit_rejected") throw new Error("expected pinboard add to reject as incomplete");
    expect(add.result.transcript.incompleteReasons).toEqual(expect.arrayContaining(["native:obj_the_pinboard_1:moveto"]));

    const { browser: taskspace } = await browserForScope("the_taskspace", "guest:browser-task-create-gap");
    await openShadowBrowserScope(taskspace, { preseed_catalog_pages: true });
    const create = await executeShadowBrowserTurn(taskspace, {
      id: "browser-task-create-gap",
      target: "the_taskspace",
      verb: "create_task",
      args: ["Creation gap", "Creation validation still blocks v2 commit."]
    });
    expect(create.result).toMatchObject({
      ok: false,
      reason: "commit_rejected",
      commit: { kind: "woo.commit.conflict.shadow.v1" }
    });
    if (create.result.ok || create.result.reason !== "commit_rejected") throw new Error("expected task create to reject at commit");
    expect(create.result.transcript.incompleteReasons).toEqual([]);
    expect(create.result.receipt.errors).toEqual(expect.arrayContaining([
      "post_state_mismatch create obj_the_taskspace_1: location",
      "permission_denied: no recorded authority can write obj_the_taskspace_1.name"
    ]));
  });

  it("records the current chat take native-completeness gap through the browser shim", async () => {
    const { browser } = await browserForScope("the_chatroom", "guest:browser-chat");
    await openShadowBrowserScope(browser, { preseed_catalog_pages: true });

    const take = await executeShadowBrowserTurn(browser, {
      id: "browser-chat-take",
      target: "the_chatroom",
      verb: "take",
      args: ["mug"]
    });
    expect(take.result).toMatchObject({
      ok: false,
      reason: "commit_rejected",
      commit: { kind: "woo.commit.conflict.shadow.v1", reason: "incomplete_transcript" }
    });
    if (take.result.ok || take.result.reason !== "commit_rejected") throw new Error("expected chat take to reject as incomplete");
    expect(take.result.transcript.incompleteReasons).toEqual(expect.arrayContaining([
      "native:$match:match_object",
      "native:the_mug:moveto"
    ]));
    expect(browser.cache.conflicts).toHaveLength(1);
    expect(browser.cache.applied_frames).toHaveLength(0);
    const world = worldFor(browser);
    expect(world.object("the_mug").location).toBe("the_chatroom");
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

function frameObservationObject(frame: { op: string; observations?: Array<Record<string, WooValue> & { type: string }> }, type: string, key: string): ObjRef {
  const observation = frame.observations?.find((item) => item.type === type);
  if (!observation) throw new Error(`expected ${type} frame observation`);
  const out = observation[key];
  if (typeof out !== "string") throw new Error(`expected ${type}.${key} object ref`);
  return out;
}
