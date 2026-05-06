import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { handleRestProtocolRequest, handleWsProtocolFrame, type RestProtocolRequest } from "../src/core/protocol";
import { publicAppliedFrame, type ObjRef, type Session } from "../src/core/types";
import type { DeferredHostEffect, WooWorld } from "../src/core/world";
import { LocalHostBridge } from "./core-support";

function get(pathname: string, headers: Record<string, string> = {}): RestProtocolRequest {
  return {
    method: "GET",
    pathname,
    query: () => null,
    header: (name) => headers[name.toLowerCase()] ?? null,
    readJson: async () => ({})
  };
}

function getWithQuery(pathname: string, query: Record<string, string>, headers: Record<string, string> = {}): RestProtocolRequest {
  return {
    method: "GET",
    pathname,
    query: (name) => query[name] ?? null,
    header: (name) => headers[name.toLowerCase()] ?? null,
    readJson: async () => ({})
  };
}

async function apiMe(world: WooWorld, session: Session) {
  const result = await handleRestProtocolRequest(get("/api/me"), {
    world,
    requireSession: () => session,
    authenticateToken: () => session,
    state: () => {
      throw new Error("/api/me must not call full world state");
    },
    broadcastApplied: async () => undefined,
    broadcastLiveEvents: async () => undefined
  });
  expect(result.handled).toBe(true);
  if (!result.handled || "raw" in result) throw new Error("unexpected raw protocol result");
  expect(result.status).toBe(200);
  return result.body as Record<string, any>;
}

describe("scoped client projection", () => {
  it("serves installed bundled catalog UI declarations without a world snapshot", async () => {
    const world = createWorld();
    const session = world.auth("guest:catalog-ui");
    const result = await handleRestProtocolRequest(get("/api/catalogs/ui"), {
      world,
      requireSession: () => session,
      authenticateToken: () => session,
      state: () => {
        throw new Error("/api/catalogs/ui must not call full world state");
      },
      broadcastApplied: async () => undefined,
      broadcastLiveEvents: async () => undefined
    });
    expect(result.handled).toBe(true);
    if (!result.handled || "raw" in result) throw new Error("unexpected raw protocol result");
    expect(result.headers?.etag).toMatch(/^"catalog-ui-/);
    expect(result.headers?.["cache-control"]).toContain("must-revalidate");
    const body = result.body as Record<string, any>;
    const chat = body.catalogs.find((catalog: { alias?: string }) => catalog.alias === "chat");
    expect(chat.ui.abi).toBe("woo-ui/v1");
    expect(chat.ui.components.some((component: { id?: string }) => component.id === "chat.space")).toBe(true);

    const cached = await handleRestProtocolRequest(get("/api/catalogs/ui", { "if-none-match": result.headers!.etag }), {
      world,
      requireSession: () => session,
      authenticateToken: () => session,
      state: () => {
        throw new Error("/api/catalogs/ui must not call full world state");
      },
      broadcastApplied: async () => undefined,
      broadcastLiveEvents: async () => undefined
    });
    expect(cached.handled).toBe(true);
    if (!cached.handled || "raw" in cached) throw new Error("unexpected raw protocol result");
    expect(cached.status).toBe(304);
  });

  it("accepts a scoped replay cursor on websocket auth but requires hydrate in v1", async () => {
    const world = createWorld();
    const session = world.auth("guest:scoped-ws-cursor");
    const sent: any[] = [];
    await handleWsProtocolFrame("conn", {
      op: "auth",
      token: `session:${session.id}`,
      cursor: { spaces: { the_chatroom: { next_seq: 3 } }, live: { resumable: false } }
    }, {
      authenticate: () => session,
      attach: () => undefined,
      session: () => null,
      send: (_connection, frame) => sent.push(frame),
      call: async () => { throw new Error("unexpected call"); },
      direct: async () => { throw new Error("unexpected direct"); },
      replay: async () => { throw new Error("unexpected replay"); },
      deliverInput: async () => null,
      broadcastApplied: async () => undefined,
      broadcastTaskResult: async () => undefined,
      broadcastLiveEvents: async () => undefined
    });

    expect(sent[0]).toMatchObject({ op: "session", actor: session.actor, session: session.id, resumed: false });
  });

  it("routes websocket command frames through the host command executor", async () => {
    const world = createWorld();
    const session = world.auth("guest:ws-command");
    const sent: any[] = [];
    const live: any[] = [];
    await handleWsProtocolFrame("conn", {
      op: "command",
      id: "ws-command-1",
      space: "the_chatroom",
      text: "hello"
    }, {
      authenticate: () => session,
      attach: () => undefined,
      session: () => ({ sessionId: session.id, actor: session.actor }),
      send: (_connection, frame) => sent.push(frame),
      call: async () => { throw new Error("unexpected call"); },
      command: async (frameId, wsSession, space, text) => {
        expect(frameId).toBe("ws-command-1");
        expect(wsSession).toMatchObject({ sessionId: session.id, actor: session.actor });
        expect(space).toBe("the_chatroom");
        expect(text).toBe("hello");
        return {
          op: "result",
          id: frameId,
          result: true,
          observations: [{ type: "said", source: space, actor: session.actor, text }],
          audience: space,
          command: { route: "direct", target: space, verb: "say", args: [text] }
        } as any;
      },
      direct: async () => { throw new Error("unexpected direct"); },
      replay: async () => { throw new Error("unexpected replay"); },
      deliverInput: async () => null,
      broadcastApplied: async () => { throw new Error("unexpected applied"); },
      broadcastTaskResult: async () => undefined,
      broadcastLiveEvents: async (result) => { live.push(result); }
    });

    expect(sent[0]).toMatchObject({
      op: "result",
      id: "ws-command-1",
      result: true,
      command: { route: "direct", target: "the_chatroom", verb: "say", args: ["hello"] }
    });
    expect(live).toHaveLength(1);
  });

  it("returns websocket command errors from invalid command spaces", async () => {
    const world = createWorld();
    const session = world.auth("guest:ws-command-bad-space");
    const sent: any[] = [];
    await handleWsProtocolFrame("conn", {
      op: "command",
      id: "ws-command-bad-space",
      space: "the_lamp",
      text: "hello"
    }, {
      authenticate: () => session,
      attach: () => undefined,
      session: () => ({ sessionId: session.id, actor: session.actor }),
      send: (_connection, frame) => sent.push(frame),
      call: async () => { throw new Error("unexpected call"); },
      command: (frameId, wsSession, space, text) => world.command(frameId, wsSession.sessionId, space, text),
      direct: async () => { throw new Error("unexpected direct"); },
      replay: async () => { throw new Error("unexpected replay"); },
      deliverInput: async () => null,
      broadcastApplied: async () => { throw new Error("unexpected applied"); },
      broadcastTaskResult: async () => undefined,
      broadcastLiveEvents: async () => { throw new Error("unexpected live"); }
    });

    expect(sent[0]).toMatchObject({
      op: "error",
      id: "ws-command-bad-space",
      error: { code: "E_TYPE" }
    });
  });

  it("includes enriched movement results on sequenced applied frames", async () => {
    const world = createWorld();
    const session = world.auth("guest:scoped-sequenced-move");
    const entered = await world.directCall("enter-for-sequenced-move", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    expect(entered.op).toBe("result");

    const frame = await world.call("sequenced-move-with-here", session.id, "the_chatroom", {
      actor: session.actor,
      target: "exit_living_room_southeast",
      verb: "move",
      args: [session.actor]
    });

    expect(frame.op).toBe("applied");
    if (frame.op !== "applied") throw new Error("expected applied frame");
    expect(frame.result).toMatchObject({
      room: "the_deck",
      here: {
        id: "the_deck",
        name: "Deck"
      }
    });
    const here = (frame.result as Record<string, any>).here;
    expect(here.present_actors.map((actor: { id: string }) => actor.id)).toContain(session.actor);
    expect(here.exits.some((exit: { direction?: string }) => exit.direction === "west")).toBe(true);
  });

  it("strips caller-only id and result from public applied frames", async () => {
    const world = createWorld();
    const session = world.auth("guest:public-applied-frame");
    const entered = await world.directCall("enter-public-applied-frame", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    expect(entered.op).toBe("result");
    const frame = await world.call("move-public-applied-frame", session.id, "the_chatroom", {
      actor: session.actor,
      target: "exit_living_room_southeast",
      verb: "move",
      args: [session.actor]
    });

    expect(frame.op).toBe("applied");
    if (frame.op !== "applied") throw new Error("expected applied frame");
    expect(frame.id).toBe("move-public-applied-frame");
    expect(frame.result).toBeDefined();
    const publicFrame = publicAppliedFrame(frame);
    expect(publicFrame.id).toBeUndefined();
    expect(publicFrame.result).toBeUndefined();
    expect(publicFrame.observations).toEqual(frame.observations);
  });

  it("returns null here when the session has no room or space context", async () => {
    const world = createWorld();
    const session = world.auth("guest:scoped-nowhere");

    const body = await apiMe(world, session);
    expect(body.session.current_location).toBe("$nowhere");
    expect(body.here).toBeNull();
    expect(body.cursor.spaces).toEqual({});
  });

  it("serves /api/me as a scoped self, session, here, and inventory snapshot", async () => {
    const world = createWorld();
    const session = world.auth("guest:scoped-me");
    world.defineProperty("the_chatroom", {
      name: "secret_room_note",
      defaultValue: "classified",
      owner: "$wiz",
      perms: "w",
      typeHint: "str"
    });
    world.setProp("the_chatroom", "secret_room_note", "classified");
    await world.setPropertyInfoChecked("$wiz", "the_chatroom", "next_seq", { perms: "w" });
    const entered = await world.directCall("scoped-me-enter", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    expect(entered.op).toBe("result");

    const body = await apiMe(world, session);
    expect(body.objects).toBeUndefined();
    expect(body.self).toMatchObject({ id: session.actor, parent: "$guest" });
    expect(body.self.ancestors).toEqual(expect.arrayContaining(["$actor", "$player", "$guest"]));
    expect(body.self.ancestors.at(-1)).toBe("$guest");
    expect(body.session).toMatchObject({
      id: session.id,
      actor: session.actor,
      current_location: "the_chatroom"
    });
    expect(body.cursor.spaces.the_chatroom.next_seq).toBe(1);
    expect(body.cursor.live).toEqual({ resumable: false });
    expect(body.here).toMatchObject({
      id: "the_chatroom",
      name: "Living Room"
    });
    expect(body.here.present_actors.map((actor: { id: string }) => actor.id)).toContain(session.actor);
    expect(body.here.exits.some((exit: { direction?: string }) => exit.direction === "south")).toBe(true);
    expect(new Set(body.here.exits.map((exit: { id: string }) => exit.id)).size).toBe(body.here.exits.length);
    expect(body.here.props.secret_room_note).toBeNull();
    expect(body.here.props.session_subscribers).toBeUndefined();
    expect(body.here.present_actors.every((actor: { props?: unknown }) => actor.props === undefined)).toBe(true);
    expect(Array.isArray(body.inventory)).toBe(true);
  });

  it("keeps nested room snapshot summaries thin", async () => {
    const world = createWorld();
    const session = world.auth("guest:scoped-thin-contents");
    const entered = await world.directCall("scoped-thin-enter", session.actor, "the_deck", "enter", [], { sessionId: session.id });
    expect(entered.op).toBe("result");

    const body = await apiMe(world, session);
    expect(body.here.id).toBe("the_deck");
    expect(new Set(body.here.exits.map((exit: { id: string }) => exit.id)).size).toBe(body.here.exits.length);
    expect(body.here.props.session_subscribers).toBeUndefined();
    const pinboard = body.here.contents.find((item: { id?: string }) => item.id === "the_pinboard");
    expect(pinboard).toBeDefined();
    expect(pinboard.props).toBeUndefined();
  });

  it("serves scoped overlay snapshots without reading the full world state", async () => {
    const world = createWorld();
    const session = world.auth("guest:overlay-snapshot");
    const result = await handleRestProtocolRequest(getWithQuery("/api/objects/the_pinboard/ui-snapshot", { surface: "pinboard" }), {
      world,
      requireSession: () => session,
      authenticateToken: () => session,
      state: () => {
        throw new Error("overlay snapshots must not call full world state");
      },
      broadcastApplied: async () => undefined,
      broadcastLiveEvents: async () => undefined
    });

    expect(result.handled).toBe(true);
    if (!result.handled || "raw" in result) throw new Error("unexpected raw protocol result");
    expect(result.status).toBe(200);
    const body = result.body as Record<string, any>;
    expect(body).toMatchObject({
      surface: "pinboard",
      subject: "the_pinboard",
      room: { id: "the_pinboard", name: "Pinboard" }
    });
    expect(body.cursor.spaces.the_pinboard.next_seq).toEqual(expect.any(Number));
    expect(body.objects.some((object: { id?: string }) => object.id === "the_pinboard")).toBe(true);
  });

  it("adds here to direct move and enter results while preserving legacy fields", async () => {
    const world = createWorld();
    const session = world.auth("guest:move-result-here");
    const entered = await world.directCall("move-result-enter", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    expect(entered.op).toBe("result");
    if (entered.op !== "result") return;
    expect(entered.result).toMatchObject({
      room: "the_chatroom",
      here_request: true,
      look_deferred: true,
      here: { id: "the_chatroom", name: "Living Room" }
    });

    const moved = await world.directCall("move-result-deck", session.actor, "the_chatroom", "southeast", [], { sessionId: session.id });
    expect(moved.op).toBe("result");
    if (moved.op !== "result") return;
    expect(moved.result).toMatchObject({
      room: "the_deck",
      from: "the_chatroom",
      here_request: true,
      look_deferred: true,
      here: { id: "the_deck", name: "Deck" }
    });
  });

  it("adds containing-room here to feature-space enter results", async () => {
    const world = createWorld();
    const session = world.auth("guest:feature-move-result");
    const entered = await world.directCall("feature-move-result-enter", session.actor, "the_pinboard", "enter", [], { sessionId: session.id });
    expect(entered.op).toBe("result");
    if (entered.op !== "result") return;
    expect(entered.result).toMatchObject({
      room: "the_pinboard",
      here_request: true,
      look_deferred: true,
      here: { id: "the_deck", name: "Deck" }
    });
  });

  it("adds here to feature-space leave results", async () => {
    const world = createWorld();
    const session = world.auth("guest:feature-leave-result");
    await world.directCall("feature-leave-result-enter", session.actor, "the_dubspace", "enter", [], { sessionId: session.id });
    const left = await world.directCall("feature-leave-result-out", session.actor, "the_dubspace", "out", [], { sessionId: session.id });
    expect(left.op).toBe("result");
    if (left.op !== "result") return;
    expect(left.result).toMatchObject({
      room: "the_chatroom",
      here_request: true,
      look_deferred: true,
      here: { id: "the_chatroom", name: "Living Room" }
    });
  });

  it("keeps the moving actor in cross-host move-result snapshots before deferred effects apply", async () => {
    const home = createWorld();
    const roomA = createWorld();
    const roomB = createWorld();
    const session = home.auth("guest:pending-cross-host-here");
    const actor = session.actor;
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["room-a", roomA],
      ["room-b", roomB]
    ]);
    const routes = new Map<ObjRef, string>([
      [actor, "home"],
      ["the_chatroom", "room-a"],
      ["the_deck", "room-b"]
    ]);
    home.setHostBridge(new LocalHostBridge("home", worlds, routes));
    roomA.setHostBridge(new LocalHostBridge("room-a", worlds, routes));
    roomB.setHostBridge(new LocalHostBridge("room-b", worlds, routes));
    roomA.createObject({ id: actor, name: home.object(actor).name, parent: "$guest", owner: "$wiz" });
    home.sessions.get(session.id)!.currentLocation = "the_chatroom";
    roomA.ensureSessionForActor(session.id, actor, session.tokenClass, session.expiresAt, "the_chatroom");
    home.setActorPresence(actor, "the_chatroom", true, session.id);
    roomA.setActorPresence(actor, "the_chatroom", true, session.id);
    roomA.setSpaceSubscriber("the_chatroom", actor, true, session.id);

    const effects: DeferredHostEffect[] = [];
    const moved = await roomA.directCall("pending-cross-host-here", actor, "the_chatroom", "southeast", [], {
      sessionId: session.id,
      deferHostEffect: (effect) => effects.push(effect)
    });

    expect(moved.op).toBe("result");
    if (moved.op !== "result") return;
    expect(roomB.getProp("the_deck", "subscribers")).not.toContain(actor);
    expect((moved.result as any).here.present_actors.map((item: { id: string }) => item.id)).toContain(actor);
    expect(effects.map((effect) => effect.kind)).toContain("space_subscriber");
  });

  it("routes /api/me here snapshots to a remote current room host", async () => {
    const home = createWorld();
    const remote = createWorld();
    const session = home.auth("guest:remote-scoped-me");
    if (!remote.objects.has(session.actor)) {
      remote.createObject({ id: session.actor, name: home.object(session.actor).name, parent: "$player", owner: session.actor });
    }
    remote.ensureSessionForActor(session.id, session.actor, session.tokenClass, session.expiresAt, "the_deck");
    remote.setSpaceSubscriber("the_deck", session.actor, true, session.id);
    remote.setActorPresence(session.actor, "the_deck", true, session.id);
    home.sessions.get(session.id)!.currentLocation = "the_deck";
    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["deck-host", remote]
    ]);
    const routes = new Map<ObjRef, string>([
      ["the_deck", "deck-host"]
    ]);
    home.setHostBridge(new LocalHostBridge("home", worlds, routes));
    remote.setHostBridge(new LocalHostBridge("deck-host", worlds, routes));

    const body = await apiMe(home, session);
    expect(body.objects).toBeUndefined();
    expect(body.session.current_location).toBe("the_deck");
    expect(body.cursor.spaces.the_deck.next_seq).toBe(1);
    expect(body.here).toMatchObject({ id: "the_deck", name: "Deck" });
    expect(body.here.present_actors.map((actor: { id: string }) => actor.id)).toContain(session.actor);
  });

  it("batches remote object summaries while building room contents", async () => {
    const home = createWorld();
    const roomHost = createWorld();
    const itemHost = createWorld();
    const session = home.auth("guest:remote-summary-batch");
    const badge = "remote_badge" as ObjRef;
    itemHost.createObject({ id: badge, name: "Remote Badge", parent: "$thing", owner: "$wiz", location: "the_deck" });
    roomHost.mirrorContents("the_deck", badge, true);
    if (!roomHost.objects.has(session.actor)) {
      roomHost.createObject({ id: session.actor, name: home.object(session.actor).name, parent: "$player", owner: session.actor });
    }
    roomHost.ensureSessionForActor(session.id, session.actor, session.tokenClass, session.expiresAt, "the_deck");
    roomHost.setSpaceSubscriber("the_deck", session.actor, true, session.id);
    roomHost.setActorPresence(session.actor, "the_deck", true, session.id);
    home.sessions.get(session.id)!.currentLocation = "the_deck";

    const worlds = new Map<string, WooWorld>([
      ["home", home],
      ["room-host", roomHost],
      ["item-host", itemHost]
    ]);
    const routes = new Map<ObjRef, string>([
      ["the_deck", "room-host"],
      [badge, "item-host"]
    ]);
    const homeBridge = new LocalHostBridge("home", worlds, routes);
    const roomBridge = new LocalHostBridge("room-host", worlds, routes);
    home.setHostBridge(homeBridge);
    roomHost.setHostBridge(roomBridge);
    itemHost.setHostBridge(new LocalHostBridge("item-host", worlds, routes));

    const body = await apiMe(home, session);
    expect(body.here.contents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: badge, name: "Remote Badge" })
    ]));
    expect(roomBridge.objectSummaryManyCalls).toContainEqual([badge]);
  });

  it("keeps here on the containing room when current_location is a feature space", async () => {
    const world = createWorld();
    const session = world.auth("guest:feature-space-here");
    const entered = await world.directCall("feature-here-enter", session.actor, "the_pinboard", "enter", [], { sessionId: session.id });
    expect(entered.op).toBe("result");

    const body = await apiMe(world, session);
    expect(body.session.current_location).toBe("the_pinboard");
    expect(body.here).toMatchObject({ id: "the_deck", name: "Deck" });
    expect(body.overlays.current_location).toMatchObject({ subject: "the_pinboard", restore: true });
  });
});
