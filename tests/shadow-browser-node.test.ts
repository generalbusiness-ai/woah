import { authoritativePlanningWorld, planningCellKey } from "../src/core/planning-world";
import { describe, expect, it, vi } from "vitest";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import { decodeEnvelope, encodeEnvelope } from "../src/core/shadow-envelope";
import { stableShadowJson } from "../src/core/shadow-cell-version";
import {
  applyAcceptedFrameToDerivedRelayCache,
  applyShadowBrowserTransfer,
  buildShadowBrowserSessionAuth,
  buildShadowBrowserOpenExecutableSeedTransfer,
  buildShadowBrowserProjectionTransfer,
  createShadowBrowserNode,
  createShadowBrowserRelayShim,
  shadowBrowserScopeExecutionAds,
  disposeShadowBrowserNode,
  emitShadowBrowserLiveEvent,
  executeShadowBrowserTurn,
  handleShadowBrowserStateTransferEnvelope,
  handleShadowBrowserTurnExecEnvelope,
  MAX_SHADOW_OPEN_EXECUTABLE_SEED_CACHE,
  markShadowBrowserRelaySerializedChanged,
  mergeShadowBrowserAuthoritySessionState,
  mergeShadowBrowserSessionState,
  openShadowBrowserScope,
  publishShadowBrowserAcceptedFrame,
  publishShadowBrowserLiveEvent,
  purgeShadowBrowserRelayHistory,
  receiveShadowBrowserEnvelope,
  receiveShadowBrowserEnvelopeReceipt,
  refreshShadowBrowserRelaySessionAuth,
  setShadowBrowserSessionToken,
  SHADOW_SCOPE_PROJECTION_PATCH_FIELDS,
  shadowLiveEventsForTranscript,
  shadowStateTransferCacheDigest,
  shadowBrowserEnvelope,
  shadowBrowserSessionBearer,
  shadowBrowserTransportHello,
  subscribeShadowBrowserNode,
  unsubscribeShadowBrowserNode,
  type ShadowBrowserStateTransfer,
  type ShadowBrowserNode,
  type ShadowLiveEvent
} from "../src/core/shadow-browser-node";
import { rankCapabilityAdsForScope } from "../src/core/capability-ad";
import { hashSource } from "../src/core/source-hash";
import type { MetricEvent, ObjRef, WooValue } from "../src/core/types";
import type { SerializedObject } from "../src/core/repository";
import { runShadowTurnCall, runShadowTurnCallTranscript, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";
import type { EffectTranscript } from "../src/core/effect-transcript";
import { serializedFor, submitShadowCommit, type ShadowCommitAccepted, type ShadowScopeHead } from "../src/core/shadow-commit-scope";
import { createShadowExecutionNode, type ShadowCellPageTransfer } from "../src/core/shadow-turn-exec";
import { mergeAuthorityIntoRelayCache } from "../src/core/shadow-relay-cache";
import {
  browserOpenSeedCommandSurfacePropertyNames,
  browserOpenSeedCommandSurfaceVerbLookupNames,
  browserOpenSeedCatalogPropertyNames,
  browserOpenSeedDispatchVerbNames,
  browserOpenSeedObjectPropertyNames,
  browserOpenSeedVerbLookups
} from "../src/core/browser-open-seed-contract";

async function moveActorToScope(world: ReturnType<typeof createWorld>, session: { id: string; actor: string }, scope: ObjRef, requestId: string): Promise<void> {
  const moved = await world.directCall(requestId, session.actor, session.actor, "moveto", [scope], { sessionId: session.id });
  expect(moved.op).toBe("result");
}

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
    expect(opened.ads).toEqual([
      expect.objectContaining({
        kind: "woo.exec_capability_ad.shadow.v1",
        node: "browser-relay:executor",
        scope: "the_dubspace",
        // CA10.1: `epoch` is the scope generation (a numeric string), `head` is
        // the value-head hash — distinct fields. (Previously the scope ad put the
        // head hash in `epoch`; that conflation is fixed.)
        epoch: expect.stringMatching(/^\d+$/),
        head: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    ]);
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

  it("uses an executable seed digest to avoid resending cached open pages", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-open-seed-cache");
    const opened = await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
    const digest = shadowStateTransferCacheDigest(opened.executable_transfer);
    expect(digest).toBeTruthy();
    expect(opened.executable_transfer_cache).toBe("miss");
    expect(opened.executable_transfer_inline_pages).toBeGreaterThan(0);

    const cached = await openShadowBrowserScope(browser, {
      preseed_catalog_pages: true,
      executable_seed_digest: digest ?? undefined
    });

    expect(cached.executable_transfer_cache).toBe("hit");
    expect(cached.executable_transfer_pages).toBe(0);
    expect(cached.executable_transfer_inline_pages).toBe(0);
    expect(cached.executable_transfer_bytes).toBeLessThan(opened.executable_transfer_bytes / 10);

    const turn = await executeShadowBrowserTurn(browser, {
      id: "browser-open-seed-cache-wet",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.54]
    });
    expect(turn.result).toMatchObject({ ok: true });
  });

  it("keeps browser open executable seeds focused on first-turn execution cells", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:browser-open-seed-budget");
    await anchor.directCall("browser-open-seed-budget-enter", session.actor, "the_chatroom", "enter", [], { sessionId: session.id });
    const relay = createShadowBrowserRelayShim({
      node: "browser-relay-open-seed-budget",
      scope: "the_chatroom",
      serialized: anchor.exportWorld()
    });
    const transfer = buildShadowBrowserOpenExecutableSeedTransfer(
      relay,
      "the_chatroom",
      "browser-open-seed-budget",
      session.actor,
      session.id
    );

    expect(stateTransferJsonBytes(transfer)).toBeLessThan(450_000);
    expect(pageBytesByKind(transfer).property_cell).toBeLessThan(80_000);
    expect(pageBytesByKind(transfer).verb_bytecode).toBeLessThan(190_000);
    expect(hasTransferPage(transfer, "$system", "property_cell", "catalog_migration_records")).toBe(false);
    expect(hasTransferPage(transfer, "$catalog_registry", "property_cell", "installed_catalogs")).toBe(false);
    expect(hasTransferPage(transfer, "$system", "verb_bytecode", "list_api_keys_for_owner")).toBe(false);
    expect(hasTransferPage(transfer, "$pinboard", "verb_bytecode", "exitfunc")).toBe(false);
    expect(hasTransferPage(transfer, "$match", "verb_bytecode", "plan_command")).toBe(true);
    expect(hasTransferPage(transfer, "$room", "verb_bytecode", "take")).toBe(true);
    expect(transfer.preimages).toContain("read:cell:prop:the_mug.name");
    expect(hasTransferPage(transfer, "the_mug", "property_cell", "aliases")).toBe(true);
    expect(transfer.preimages).toContain(`read:cell:contents:${session.actor}`);
    expect(transfer.preimages).toContain("read:cell:verb:the_chatroom:take");
    expect(transfer.preimages).not.toContain("read:cell:verb:$actor:title");
    expect(browserOpenSeedDispatchVerbNames()).toContain("command_plan");
    // "text" is included because catalog classes with match_names may read this.text
    // (see native-primitive-contract.ts plan_command.open_seed.object_property_names).
    expect(browserOpenSeedCommandSurfacePropertyNames()).toEqual(["aliases", "description", "name", "text"]);
    expect(browserOpenSeedCommandSurfaceVerbLookupNames()).toEqual(["match_names"]);
    expect(browserOpenSeedVerbLookups()).toEqual(expect.arrayContaining([
      expect.objectContaining({ receiver: "scope", names: expect.arrayContaining(["command_plan"]) }),
      expect.objectContaining({ receiver: "scope", names: expect.arrayContaining(["acceptable", "enterfunc"]) }),
      expect.objectContaining({ receiver: "actor_location", names: expect.arrayContaining(["exitfunc"]) })
    ]));
    expect(browserOpenSeedObjectPropertyNames()).toEqual(expect.arrayContaining(["name", "description", "aliases", "session_subscribers"]));
    expect(browserOpenSeedCatalogPropertyNames()).toEqual(expect.arrayContaining(["features", "features_version", "host_placement"]));
    expect(hasTransferPage(transfer, "the_chatroom", "property_cell", "session_subscribers")).toBe(true);
  });

  it("bounds the relay executable seed digest cache by least-recent use", async () => {
    const world = createWorld({ catalogs: false });
    const sessions = Array.from(
      { length: MAX_SHADOW_OPEN_EXECUTABLE_SEED_CACHE + 1 },
      (_, index) => world.auth(`guest:browser-open-seed-lru-${index}`)
    );
    const relay = createShadowBrowserRelayShim({
      node: "browser-relay-open-seed-lru",
      scope: "$system",
      serialized: world.exportWorld()
    });

    for (const [index, session] of sessions.entries()) {
      const browser = createShadowBrowserNode({
        node: `browser-open-seed-lru-${index}`,
        scope: "$system",
        actor: session.actor,
        session: session.id,
        relay
      });
      const opened = await openShadowBrowserScope(browser);
      expect(opened.executable_transfer_cache).toBe("miss");
    }

    const keys = Array.from(relay.open_executable_seed_cache.keys());
    expect(keys).toHaveLength(MAX_SHADOW_OPEN_EXECUTABLE_SEED_CACHE);
    expect(keys.some((key) => key.endsWith(`\u0000${sessions[0].actor}`))).toBe(false);
    expect(keys.some((key) => key.endsWith(`\u0000${sessions.at(-1)!.actor}`))).toBe(true);
  });

  it("uses an empty display delta when the browser already has the current projection head", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-open-current-cache");
    const opened = await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
    expect(opened.transfer.mode).toBe("projection");

    const current = await openShadowBrowserScope(browser, {
      preseed_catalog_pages: true,
      last_known_head: opened.transfer.to
    });
    expect(current.transfer).toMatchObject({
      mode: "delta",
      to: opened.transfer.to,
      applied: [],
      transcript_tail: []
    });
    expect("projection" in current.transfer).toBe(false);
    expect("projection_patch" in current.transfer).toBe(false);
    expect(current.projection).toEqual(opened.projection);

    const wrongHash = await openShadowBrowserScope(browser, {
      preseed_catalog_pages: true,
      last_known_head: { ...opened.transfer.to, hash: "not-current" }
    });
    expect(wrongHash.transfer.mode).toBe("projection");
  });

  it("resends the open executable seed when the cached digest is stale", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-open-seed-stale");
    const opened = await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
    const staleDigest = shadowStateTransferCacheDigest(opened.executable_transfer);
    expect(staleDigest).toBeTruthy();

    const turn = await executeShadowBrowserTurn(browser, {
      id: "browser-open-seed-stale-wet",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.55]
    });
    expect(turn.result).toMatchObject({ ok: true });

    const reopened = await openShadowBrowserScope(browser, {
      preseed_catalog_pages: true,
      executable_seed_digest: staleDigest ?? undefined
    });

    expect(reopened.executable_transfer_cache).toBe("miss");
    expect(reopened.executable_transfer_inline_pages).toBeGreaterThan(0);
    expect(reopened.executable_transfer_digest).not.toBe(staleDigest);
  });

  it("does not let live-persistence turns dirty the next durable dubspace turn", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:browser-dubspace-live-before-commit");
    await moveActorToScope(anchor, session, "the_dubspace", "browser-dubspace-live-before-commit-move");
    const relay = createShadowBrowserRelayShim({
      node: "browser-relay",
      scope: "the_dubspace",
      serialized: anchor.exportWorld()
    });
    const browser = createShadowBrowserNode({
      node: "browser-the_dubspace",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay
    });

    const live = await executeShadowBrowserTurn(browser, {
      id: "browser-dubspace-live-enter",
      route: "sequenced",
      target: session.actor,
      verb: "moveto",
      args: ["the_chatroom"],
      persistence: "live"
    });
    const committed = await executeShadowBrowserTurn(browser, {
      id: "browser-dubspace-committed-wet",
      route: "sequenced",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.51]
    });

    expect(live.result).toMatchObject({ ok: true, commit: undefined });
    expect(committed.result).toMatchObject({
      ok: true,
      commit: { kind: "woo.commit.accepted.shadow.v1", position: { scope: "the_dubspace", seq: 1 } }
    });
    expect(worldFor(browser).getProp("delay_1", "wet")).toBe(0.51);
  });

  it("opens with a catalog-neutral scope projection neighborhood", async () => {
    const { browser, actor } = await browserForScope("the_dubspace", "guest:browser-projection-neighborhood", async (world) => {
      world.defineProperty("the_dubspace", { name: "private_projection_probe", defaultValue: "sealed", owner: "$wiz", perms: "", typeHint: "str" });
    });
    const opened = await openShadowBrowserScope(browser);
    const projection = opened.projection as Record<string, any>;

    expect(projection).toMatchObject({
      kind: "woo.scope_projection.shadow.v1",
      scope: "the_dubspace",
      viewer: { actor },
      self: { id: actor },
      session: { actor, active_scope: "the_dubspace", current_location: "the_dubspace" },
      inventory: expect.any(Array),
      cursor: { spaces: { the_dubspace: { next_seq: expect.any(Number) } }, live: { resumable: false } },
      subject: { id: "the_dubspace", props: expect.any(Object) }
    });
    expect(projection.objects.map((item: any) => item.id)).toContain("the_dubspace");
    expect(projection.objects.map((item: any) => item.id)).toContain(actor);
    expect(projection.objects.every((item: any) => Array.isArray(item.ancestors))).toBe(true);
    expect(projection.subject.props.private_projection_probe).toBeUndefined();
  });

  it("keeps the projection patch field list aligned with projection shape", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-projection-patch-fields");
    const opened = await openShadowBrowserScope(browser);
    const projection = opened.projection as Record<string, unknown>;
    const nonPatchFields = ["kind", "scope", "objects", "inventory"];

    expect(Object.keys(projection).sort()).toEqual([...nonPatchFields, ...SHADOW_SCOPE_PROJECTION_PATCH_FIELDS].sort());
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

  it("keeps session location current after a committed pinboard enter", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:browser-pinboard-enter-then-add");
    const relay = createShadowBrowserRelayShim({
      node: "browser-relay",
      scope: "the_pinboard",
      serialized: anchor.exportWorld()
    });
    const browser = createShadowBrowserNode({
      node: "browser-the_pinboard",
      scope: "the_pinboard",
      actor: session.actor,
      session: session.id,
      relay
    });
    await openShadowBrowserScope(browser, { preseed_catalog_pages: true });

    const enter = await executeShadowBrowserTurn(browser, {
      id: "browser-pinboard-enter-then-add-enter",
      target: "the_pinboard",
      verb: "enter",
      args: []
    });
    expect(enter.result).toMatchObject({ ok: true });
    expect(worldFor(browser).activeScopeForSession(session.id)).toBe("the_pinboard");
    expect(worldFor(browser).object(session.actor).location).toBe("the_pinboard");

    const add = await executeShadowBrowserTurn(browser, {
      id: "browser-pinboard-enter-then-add-add",
      target: "the_pinboard",
      verb: "add_note",
      args: ["v2 entered note", "yellow", 20, 30, 210, 120]
    });
    expect(add.result).toMatchObject({ ok: true });
    expect(worldFor(browser).getProp(observationObject(add, "note_added", "pin"), "text")).toBe("v2 entered note");
  });

  it("keeps imported live sessions live across shadow commits", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const anchor = createWorld();
      const session = anchor.auth("guest:browser-pinboard-live-session-import");
      const relay = createShadowBrowserRelayShim({
        node: "browser-relay",
        scope: "the_pinboard",
        serialized: anchor.exportWorld()
      });
      const browser = createShadowBrowserNode({
        node: "browser-the_pinboard",
        scope: "the_pinboard",
        actor: session.actor,
        session: session.id,
        relay
      });
      await openShadowBrowserScope(browser, { preseed_catalog_pages: true });

      const enter = await executeShadowBrowserTurn(browser, {
        id: "browser-pinboard-live-session-enter",
        target: "the_pinboard",
        verb: "enter",
        args: []
      });
      expect(enter.result).toMatchObject({ ok: true });
      expect(serializedFor(relay.commit_scope).sessions.find((item) => item.id === session.id)?.lastDetachAt).toBeNull();

      vi.setSystemTime(1_000_000 + 61_000);
      const add = await executeShadowBrowserTurn(browser, {
        id: "browser-pinboard-live-session-add",
        target: "the_pinboard",
        verb: "add_note",
        args: ["still live after import", "yellow", 20, 30, 210, 120]
      });
      expect(add.result).toMatchObject({ ok: true });
      expect(worldFor(browser).getProp(observationObject(add, "note_added", "pin"), "text")).toBe("still live after import");
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges fresh session authority without dropping scope-known sessions", () => {
    const anchor = createWorld();
    const kept = anchor.auth("guest:browser-session-merge-kept");
    const fresh = anchor.auth("guest:browser-session-merge-fresh");
    const current = anchor.exportSessions().filter((session) => session.id === kept.id);
    current[0].activeScope = "the_pinboard";
    const merged = mergeShadowBrowserSessionState(current, anchor.exportSessions().filter((session) => session.id === fresh.id));

    expect(merged.map((session) => session.id).sort()).toEqual([fresh.id, kept.id].sort());
    expect(merged.find((session) => session.id === kept.id)?.activeScope).toBe("the_pinboard");
  });

  it("lets authority slices replace stale per-scope session locations", () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:browser-session-authority-location");
    const current = anchor.exportSessions();
    current[0].activeScope = "the_deck";
    const fresh = anchor.exportSessions();
    fresh[0].activeScope = "the_chatroom";

    const merged = mergeShadowBrowserAuthoritySessionState(current, fresh);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(session.id);
    expect(merged[0].activeScope).toBe("the_chatroom");
  });

  it("unsubscribes browser nodes without leaving stale relay auth entries", async () => {
    const { browser } = await browserForScope("the_pinboard", "guest:browser-unsubscribe-cleanup");
    await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
    const token = browser.session_token;
    const localBearer = browser.session && shadowBrowserSessionBearer({ id: browser.session, actor: browser.actor });

    expect(browser.relay.browsers.get(browser.node)).toBe(browser);
    if (token) expect(browser.relay.session_auth.has(token)).toBe(true);
    if (localBearer && localBearer !== token) expect(browser.relay.session_auth.has(localBearer)).toBe(false);

    disposeShadowBrowserNode(browser);

    expect(browser.relay.browsers.has(browser.node)).toBe(false);
    if (token) expect(browser.relay.session_auth.has(token)).toBe(false);
  });

  it("treats session token replacement as idempotent on reused relays", async () => {
    const { browser, actor } = await browserForScope("the_pinboard", "guest:browser-token-reconnect");
    const session = browser.session;
    if (!session) throw new Error("expected browser session");
    const localBearer = shadowBrowserSessionBearer({ id: session, actor });
    setShadowBrowserSessionToken(browser, "wire:browser-token-reconnect");
    expect(browser.relay.session_auth.has(localBearer)).toBe(false);
    expect(browser.relay.session_auth.has("wire:browser-token-reconnect")).toBe(true);

    const reconnect = createShadowBrowserNode({
      node: "browser-token-reconnect",
      scope: "the_pinboard",
      actor,
      session,
      relay: browser.relay
    });
    setShadowBrowserSessionToken(reconnect, "wire:browser-token-reconnect");

    expect(reconnect.session_token).toBe("wire:browser-token-reconnect");
    expect(browser.relay.session_auth.has(localBearer)).toBe(false);
    expect(browser.relay.session_auth.has("wire:browser-token-reconnect")).toBe(true);
  });

  it("refreshes a reused relay executor before planning a new session turn", async () => {
    const anchor = createWorld();
    const firstSession = anchor.auth("guest:browser-reused-executor-a");
    const relay = createShadowBrowserRelayShim({
      node: "browser-relay",
      scope: "the_pinboard",
      serialized: anchor.exportWorld()
    });
    const first = createShadowBrowserNode({
      node: "browser-reused-executor-a",
      scope: "the_pinboard",
      actor: firstSession.actor,
      session: firstSession.id,
      relay
    });
    await openShadowBrowserScope(first, { preseed_catalog_pages: true });
    const firstIntent = shadowBrowserEnvelope(first, "woo.turn.intent.request.shadow.v1", {
      kind: "woo.turn.intent.request.shadow.v1",
      id: "browser-reused-executor-first",
      route: "sequenced",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "enter",
      args: [],
      persistence: "durable"
    });
    const firstReply = await handleShadowBrowserTurnExecEnvelope(first, receiveShadowBrowserEnvelopeReceipt(first, encodeEnvelope(firstIntent)));
    expect(firstReply?.body).toMatchObject({ ok: true });
    expect(relay.executors).toHaveLength(1);

    const secondSession = anchor.auth("guest:browser-reused-executor-b");
    const auth = buildShadowBrowserSessionAuth({
      sessions: anchor.exportSessions(),
      scope: "the_pinboard",
      deployment: relay.deployment
    });
    relay.session_auth = auth.session_auth;
    relay.session_revs = auth.session_revs;
    const snapshot = serializedFor(relay.commit_scope);
    snapshot.sessions = mergeShadowBrowserSessionState(snapshot.sessions, anchor.exportSessions());
    const secondActor = anchor.exportWorld().objects.find((obj) => obj.id === secondSession.actor);
    if (!secondActor) throw new Error("expected second actor object");
    snapshot.objects.push(secondActor);
    snapshot.objects.sort((a, b) => a.id.localeCompare(b.id));
    markShadowBrowserRelaySerializedChanged(relay);
    const second = createShadowBrowserNode({
      node: "browser-reused-executor-b",
      scope: "the_pinboard",
      actor: secondSession.actor,
      session: secondSession.id,
      relay
    });
    await openShadowBrowserScope(second, { preseed_catalog_pages: true });
    const secondIntent = shadowBrowserEnvelope(second, "woo.turn.intent.request.shadow.v1", {
      kind: "woo.turn.intent.request.shadow.v1",
      id: "browser-reused-executor-second",
      route: "sequenced",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "enter",
      args: [],
      persistence: "durable"
    });
    const secondReply = await handleShadowBrowserTurnExecEnvelope(second, receiveShadowBrowserEnvelopeReceipt(second, encodeEnvelope(secondIntent)));

    expect(secondReply?.body).toMatchObject({ ok: true });
  });

  // The legacy taskspace browser-shim smoke covered the deleted taskspace
  // catalog (create_task / claim / set_status flow). The new tasks catalog
  // is a registry+workflow model with different verbs (transition_intent,
  // pass, handoff, release) and a seeded policy; its browser-shim coverage
  // should be added separately when the new flow is wired through the
  // browser path.

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
    await moveActorToScope(anchor, firstSession, "the_dubspace", "browser-live-a-move");
    await moveActorToScope(anchor, secondSession, "the_dubspace", "browser-live-b-move");
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

  it("shares one immutable live event clone across history and matching browser caches", () => {
    const relay = createShadowBrowserRelayShim({
      node: "browser-live-shared-relay",
      scope: "the_dubspace",
      serialized: createWorld().exportWorld()
    });
    const first = createShadowBrowserNode({
      node: "browser-live-shared-a",
      scope: "the_dubspace",
      actor: "guest_1",
      relay
    });
    const second = createShadowBrowserNode({
      node: "browser-live-shared-b",
      scope: "the_dubspace",
      actor: "guest_2",
      relay
    });
    const third = createShadowBrowserNode({
      node: "browser-live-shared-c",
      scope: "the_dubspace",
      actor: "guest_3",
      relay
    });
    subscribeShadowBrowserNode(first);
    subscribeShadowBrowserNode(second);
    subscribeShadowBrowserNode(third);

    const event: ShadowLiveEvent = {
      kind: "woo.live.event.shadow.v1",
      id: "browser-live-shared",
      source: "delay_1",
      actor: "guest_1",
      scope: "the_dubspace",
      observation: {
        type: "control_preview",
        source: "delay_1",
        control: "wet",
        value: 0.25,
        nested: { marker: "before" }
      }
    };
    const originalStructuredClone = globalThis.structuredClone;
    const cloneSpy = vi.spyOn(globalThis, "structuredClone").mockImplementation((value) => originalStructuredClone(value));
    try {
      publishShadowBrowserLiveEvent(relay, event);
      expect(cloneSpy).toHaveBeenCalledTimes(1);
    } finally {
      cloneSpy.mockRestore();
    }

    const shared = relay.live_events[0];
    expect(first.cache.live_events[0]).toBe(shared);
    expect(second.cache.live_events[0]).toBe(shared);
    expect(third.cache.live_events[0]).toBe(shared);
    expect(shared).not.toBe(event);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shared.observation)).toBe(true);
    expect(Object.isFrozen((shared.observation as Record<string, WooValue>).nested)).toBe(true);

    ((event.observation as Record<string, WooValue>).nested as Record<string, WooValue>).marker = "after-input";
    expect(((shared.observation as Record<string, WooValue>).nested as Record<string, WooValue>).marker).toBe("before");
  });

  it("routes movement transcript live events to each observation source room", () => {
    const anchor = createWorld();
    const moverSession = anchor.auth("guest:browser-move-source");
    const relay = createShadowBrowserRelayShim({
      node: "browser-move-relay",
      scope: "the_chatroom",
      serialized: anchor.exportWorld()
    });
    const mover = createShadowBrowserNode({
      node: "browser-move-source",
      scope: "the_chatroom",
      actor: moverSession.actor,
      session: moverSession.id,
      relay
    });
    const events = shadowLiveEventsForTranscript(mover, {
      hash: "browser-move-transcript",
      scope: "the_deck",
      call: { id: "browser-move-west", actor: moverSession.actor, target: "the_deck", verb: "west", args: [] },
      observations: [
        { type: "left", source: "the_deck", actor: moverSession.actor },
        { type: "entered", source: "the_chatroom", actor: moverSession.actor }
      ],
      creates: [],
      writes: [],
      log: []
    } as any);

    expect(events.map((event) => event.audience)).toEqual([{ scope: "the_deck" }, { scope: "the_chatroom" }]);
    expect(events.map((event) => event.scope)).toEqual(["the_deck", "the_deck"]);
  });

  it("delivers accepted commits to subscribed browser nodes as state-plane deltas", async () => {
    const anchor = createWorld();
    const firstSession = anchor.auth("guest:browser-state-a");
    const secondSession = anchor.auth("guest:browser-state-b");
    await moveActorToScope(anchor, firstSession, "the_dubspace", "browser-state-a-move");
    await moveActorToScope(anchor, secondSession, "the_dubspace", "browser-state-b-move");
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
    const secondDelta = second.cache.transfers.find((transfer) => transfer.mode === "delta");
    expect(secondDelta).toBeDefined();
    if (!secondDelta || secondDelta.mode !== "delta") throw new Error("expected second browser delta");
    expect(secondDelta.projection).toBeUndefined();
    expect(secondDelta.projection_patch).toMatchObject({
      kind: "woo.scope_projection_patch.shadow.v1",
      scope: "the_dubspace",
      base: { seq: 0 },
      to: { seq: 1 }
    });
    expect(third.cache.transfers.some((transfer) => transfer.mode === "delta")).toBe(false);
    expect(third.cache.applied_frames).toHaveLength(0);
    expect(second.cache.projections.get("the_dubspace")).toMatchObject({
      kind: "woo.scope_projection.shadow.v1",
      scope: "the_dubspace",
      seq: 1
    });
    expect(worldFor(first).getProp("delay_1", "wet")).toBe(0.91);
  });

  it("fans out accepted-frame projection patches without rebuilding a full projection per subscriber", async () => {
    const anchor = createWorld();
    for (let index = 0; index < 32; index += 1) {
      const id = `projection_fanout_item_${index}`;
      anchor.createObject({ id, name: `Projection fan-out item ${index}`, parent: "$thing", owner: "$wiz", location: "the_dubspace" });
      anchor.setProp(id, "description", `projection fan-out description ${index}`);
    }
    const sessions = await Promise.all(Array.from({ length: 4 }, async (_item, index) => {
      const session = anchor.auth(`guest:browser-projection-fanout-${index}`);
      await moveActorToScope(anchor, session, "the_dubspace", `browser-projection-fanout-move-${index}`);
      return session;
    }));
    const relay = createShadowBrowserRelayShim({
      node: "browser-projection-fanout-relay",
      scope: "the_dubspace",
      serialized: anchor.exportWorld()
    });
    const browsers = sessions.map((session, index) => createShadowBrowserNode({
      node: `browser-projection-fanout-${index}`,
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay
    }));
    for (const browser of browsers) await openShadowBrowserScope(browser, { preseed_catalog_pages: true });

    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "browser-projection-fanout-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: sessions[0].id,
      actor: sessions[0].actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.73]
    };
    const planned = await runShadowTurnCallTranscript(authoritativePlanningWorld(serializedFor(relay.commit_scope)), call);
    const accepted = submitShadowCommit(relay.commit_scope, {
      kind: "woo.commit.submit.shadow.v1",
      id: call.id,
      scope: call.scope,
      expected: relay.commit_scope.head,
      transcript: planned.transcript
    });
    if (accepted.kind !== "woo.commit.accepted.shadow.v1") throw new Error(`expected accepted commit: ${accepted.errors.join(", ")}`);

    const baseProjection = browsers[0].cache.projections.get("the_dubspace");
    if (!baseProjection || typeof baseProjection !== "object" || Array.isArray(baseProjection) || !("objects" in baseProjection) || !Array.isArray(baseProjection.objects)) {
      throw new Error("expected cached base projection");
    }
    const visibleObjects = baseProjection.objects.length;
    const originalStructuredClone = globalThis.structuredClone;
    const cloneSpy = vi.spyOn(globalThis, "structuredClone").mockImplementation((value) => originalStructuredClone(value));
    try {
      publishShadowBrowserAcceptedFrame(relay, accepted, planned.transcript);
    } finally {
      cloneSpy.mockRestore();
    }

    expect(cloneSpy.mock.calls.length).toBeLessThan(visibleObjects * browsers.length);
    for (const browser of browsers) {
      const delta = browser.cache.transfers.filter((transfer) => transfer.mode === "delta").at(-1);
      expect(delta).toBeDefined();
      if (!delta || delta.mode !== "delta") throw new Error("expected accepted-frame delta");
      expect(delta.projection).toBeUndefined();
      expect(delta.projection_patch?.objects.upsert.map((item) => item.id)).toEqual(["delay_1"]);
      expect(browser.cache.projections.get("the_dubspace")).toMatchObject({ seq: 1 });
    }
  });

  it("rejects tampered browser projection transfers", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-state-proof");
    const opened = await openShadowBrowserScope(browser);
    const transfer = browser.cache.transfers.find((item) => item.mode === "projection");
    expect(transfer).toBeDefined();
    if (!transfer || transfer.mode !== "projection") throw new Error("expected projection transfer");
    const tampered = structuredClone(transfer);
    tampered.projection = { ...(opened.projection as any), seq: 999 };

    expect(() => applyShadowBrowserTransfer(browser, tampered)).toThrow(/proof root mismatch/);
  });

  it("rejects projection tampering even when the public root is rebuilt", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-state-rebuilt-proof");
    const opened = await openShadowBrowserScope(browser);
    const transfer = browser.cache.transfers.find((item) => item.mode === "projection");
    if (!transfer || transfer.mode !== "projection") throw new Error("expected projection transfer");
    const tampered = structuredClone(transfer);
    tampered.projection = { ...(opened.projection as any), seq: 999 };
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
    if (tamperedProjection.projection_patch) tamperedProjection.projection_patch.fields.seq = 999;
    else tamperedProjection.projection = { ...(delta.projection as any), seq: 999 };
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

  it("refreshes reused relay session auth from the current gateway session", () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:browser-auth-refresh");
    const serialized = anchor.exportWorld();
    const serializedSession = serialized.sessions.find((item) => item.id === session.id);
    if (!serializedSession) throw new Error("expected serialized test session");
    serializedSession.started = Date.now() - 120_000;
    serializedSession.expiresAt = Date.now() - 60_000;
    const relay = createShadowBrowserRelayShim({
      node: "browser-relay-auth-refresh",
      scope: "the_dubspace",
      serialized
    });
    const browser = createShadowBrowserNode({
      node: "browser-auth-refresh",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay
    });
    const rev = relay.session_revs.get(session.id);

    expect(() => shadowBrowserTransportHello(browser)).toThrow(/token is expired/);

    const refreshed = refreshShadowBrowserRelaySessionAuth(relay, {
      id: session.id,
      actor: session.actor,
      started: session.started,
      expiresAt: Date.now() + 60_000
    }, "the_dubspace");

    expect(refreshed.rev).toBe(rev);
    expect(shadowBrowserTransportHello(browser)).toMatchObject({
      session: session.id,
      actor: session.actor
    });
  });

  it("advertises the M4 idempotency window through transport hello", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-hello");
    const hello = shadowBrowserTransportHello(browser, 12345);
    const roundTripped = decodeEnvelope(encodeEnvelope(shadowBrowserEnvelope(browser, hello.kind, hello)));

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

  it("replays cached replies for duplicate wire turn requests on the same browser", async () => {
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
    const planned = await runShadowTurnCall(authoritativePlanningWorld(serializedFor(browser.relay.commit_scope)), call);
    const request = {
      kind: "woo.turn.exec.request.shadow.v1" as const,
      id: "wire-state-wet",
      call,
      key: shadowTurnKeyFromTranscript(planned.transcript),
      expected: browser.relay.commit_scope.head,
      auth: { mode: "shadow_local" as const, actor: browser.actor, session: browser.session },
      persistence: "durable" as const
    };
    const encoded = encodeEnvelope(shadowBrowserEnvelope(browser, request.kind, request, "wire-env-1"));

    const first = receiveShadowBrowserEnvelopeReceipt(browser, encoded);
    const firstReply = await handleShadowBrowserTurnExecEnvelope(browser, first);
    const duplicate = receiveShadowBrowserEnvelopeReceipt(browser, encoded);
    const duplicateReply = await handleShadowBrowserTurnExecEnvelope(browser, duplicate);

    expect(first.fresh).toBe(true);
    expect(firstReply?.body).toMatchObject({ kind: "woo.turn.exec.reply.shadow.v1", ok: true });
    expect(duplicate.fresh).toBe(false);
    expect(duplicateReply?.body).toEqual(firstReply?.body);
    expect(duplicateReply?.reply_to).toBe("wire-env-1");
    expect(browser.cache.applied_frames).toHaveLength(1);
    expect(browser.relay.accepted_frames).toHaveLength(1);
  });

  it("plans browser turn intents on the relay and commits through the normal reply path", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-wire-intent");
    await openShadowBrowserScope(browser);
    const intent = {
      kind: "woo.turn.intent.request.shadow.v1" as const,
      id: "wire-intent-wet",
      route: "sequenced" as const,
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.72],
      persistence: "durable" as const
    };
    const encoded = encodeEnvelope(shadowBrowserEnvelope(browser, intent.kind, intent, "wire-intent-env-1"));

    const receipt = receiveShadowBrowserEnvelopeReceipt(browser, encoded);
    const reply = await handleShadowBrowserTurnExecEnvelope(browser, receipt);

    expect(reply?.reply_to).toBe("wire-intent-env-1");
    expect(reply?.body).toMatchObject({
      kind: "woo.turn.exec.reply.shadow.v1",
      ok: true,
      commit: { position: { scope: "the_dubspace", seq: 1 } }
    });
    expect(worldFor(browser).getProp("delay_1", "wet")).toBe(0.72);
  });

  it("forwards onMetric through intent-envelope planning and live-persistence paths", async () => {
    // Regression: CommitScopeDO (and any host wrapping the v2 envelope
    // surface) wires `onMetric` into handleShadowBrowserTurnExecEnvelope
    // so the ephemeral planning world's direct_call/applied events reach
    // AE. Without this threading, /admin/ footprint-by-verb stays empty
    // for every MCP and WS turn even though the worker emits metrics
    // around the turn. This test pins the threading on the two ephemeral
    // execution sites: shadowTurnExecRequestFromIntent (durable/sequenced
    // intent) and executeShadowBrowserLivePersistenceIntent (live).
    const { browser: durableBrowser } = await browserForScope("the_dubspace", "guest:browser-onmetric-durable");
    await openShadowBrowserScope(durableBrowser);
    const durableIntent = {
      kind: "woo.turn.intent.request.shadow.v1" as const,
      id: "onmetric-durable-wet",
      route: "sequenced" as const,
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.59],
      persistence: "durable" as const
    };
    const durableReceipt = receiveShadowBrowserEnvelopeReceipt(
      durableBrowser,
      encodeEnvelope(shadowBrowserEnvelope(durableBrowser, durableIntent.kind, durableIntent, "onmetric-durable-env"))
    );
    const durableEvents: Array<{ kind: string; verb?: string; space?: string; target?: string }> = [];
    const durableReply = await handleShadowBrowserTurnExecEnvelope(durableBrowser, durableReceipt, {
      onMetric: (event) => durableEvents.push({
        kind: event.kind,
        verb: (event as { verb?: string }).verb,
        space: (event as { space?: string }).space,
        target: (event as { target?: string }).target
      })
    });
    expect(durableReply?.body).toMatchObject({ kind: "woo.turn.exec.reply.shadow.v1", ok: true });
    // Sequenced route produces `applied` events (space + verb) from
    // the planning world, not `direct_call`. Either shape proves the
    // hook reached the ephemeral world.
    expect(
      durableEvents.some((e) => e.verb === "set_control" && (e.kind === "applied" || e.kind === "direct_call")),
      `expected an applied/direct_call set_control event; got ${JSON.stringify(durableEvents)}`
    ).toBe(true);

    const { browser: liveBrowser } = await browserForScope("the_dubspace", "guest:browser-onmetric-live");
    await openShadowBrowserScope(liveBrowser);
    const liveIntent = {
      kind: "woo.turn.intent.request.shadow.v1" as const,
      id: "onmetric-live-wet",
      route: "direct" as const,
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "enter",
      args: [] as WooValue[],
      persistence: "live" as const
    };
    const liveReceipt = receiveShadowBrowserEnvelopeReceipt(
      liveBrowser,
      encodeEnvelope(shadowBrowserEnvelope(liveBrowser, liveIntent.kind, liveIntent, "onmetric-live-env"))
    );
    const liveEvents: Array<{ kind: string; verb?: string; target?: string }> = [];
    const liveReply = await handleShadowBrowserTurnExecEnvelope(liveBrowser, liveReceipt, {
      onMetric: (event) => liveEvents.push({
        kind: event.kind,
        verb: (event as { verb?: string }).verb,
        target: (event as { target?: string }).target
      })
    });
    expect(liveReply?.body).toMatchObject({ kind: "woo.turn.exec.reply.shadow.v1", ok: true });
    expect(
      liveEvents.some((e) => e.verb === "enter" && e.target === "the_dubspace"),
      "expected at least one engine metric from the live-persistence intent's executor world"
    ).toBe(true);
  });

  it("chains live-persistence browser intents through per-session live state", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-wire-live-chain");
    await openShadowBrowserScope(browser);
    const observer = createShadowBrowserNode({
      node: "browser-wire-live-chain-observer",
      scope: "the_dubspace",
      actor: browser.actor,
      session: browser.session,
      relay: browser.relay
    });
    await openShadowBrowserScope(observer);
    const send = async (id: string, verb: string, args: WooValue[]) => {
      const intent = {
        kind: "woo.turn.intent.request.shadow.v1" as const,
        id,
        route: "direct" as const,
        scope: "the_dubspace",
        target: "the_dubspace",
        verb,
        args,
        persistence: "live" as const
      };
      const receipt = receiveShadowBrowserEnvelopeReceipt(browser, encodeEnvelope(shadowBrowserEnvelope(browser, intent.kind, intent, `${id}:env`)));
      return await handleShadowBrowserTurnExecEnvelope(browser, receipt);
    };

    await send("live-enter", "enter", []);
    await send("live-plan", "command_plan", ["`filter 500"]);
    const reply = await send("live-filter", "say_to", ["filter_1", "500"]);

    expect(reply?.body).toMatchObject({
      kind: "woo.turn.exec.reply.shadow.v1",
      ok: true
    });
    expect(reply?.body.ok === true ? reply.body.commit : undefined).toBeUndefined();
    expect(reply?.body.ok === true ? reply.body.transcript.call.verb : "").toBe("say_to");
    expect(reply?.body.ok === true ? reply.body.transcript.observations : []).toContainEqual(expect.objectContaining({
      type: "control_changed",
      target: "filter_1",
      name: "cutoff",
      value: 500
    }));
    expect(observer.cache.live_events).toContainEqual(expect.objectContaining({
      observation: expect.objectContaining({
        type: "control_changed",
        target: "filter_1",
        name: "cutoff",
        value: 500
      })
    }));
    expect(worldFor(browser).getProp("filter_1", "cutoff")).not.toBe(500);
  });

  it("keeps unmatched chat command feedback private in live fan-out", async () => {
    const anchor = createWorld();
    const firstSession = anchor.auth("guest:browser-huh-a");
    const secondSession = anchor.auth("guest:browser-huh-b");
    await anchor.directCall("browser-huh-a-enter", firstSession.actor, "the_chatroom", "enter", [], { sessionId: firstSession.id });
    await anchor.directCall("browser-huh-b-enter", secondSession.actor, "the_chatroom", "enter", [], { sessionId: secondSession.id });
    const relay = createShadowBrowserRelayShim({
      node: "browser-huh-relay",
      scope: "the_chatroom",
      serialized: anchor.exportWorld()
    });
    const first = createShadowBrowserNode({
      node: "browser-huh-a",
      scope: "the_chatroom",
      actor: firstSession.actor,
      session: firstSession.id,
      relay
    });
    const second = createShadowBrowserNode({
      node: "browser-huh-b",
      scope: "the_chatroom",
      actor: secondSession.actor,
      session: secondSession.id,
      relay
    });
    await openShadowBrowserScope(first);
    await openShadowBrowserScope(second);

    const intent = {
      kind: "woo.turn.intent.request.shadow.v1" as const,
      id: "browser-huh-unmatched",
      route: "direct" as const,
      scope: "the_chatroom",
      target: "the_chatroom",
      verb: "command_plan",
      args: ["foo"],
      persistence: "live" as const
    };
    const receipt = receiveShadowBrowserEnvelopeReceipt(first, encodeEnvelope(shadowBrowserEnvelope(first, intent.kind, intent, "browser-huh-unmatched:env")));
    const reply = await handleShadowBrowserTurnExecEnvelope(first, receipt);
    const body = reply?.body;
    if (!body || body.ok !== true) throw new Error("expected private huh reply");
    const transcriptHuh = body.transcript.observations.find((item) => item.type === "huh") as Record<string, unknown> | undefined;
    const liveHuh = relay.live_events.find((event) => event.observation.type === "huh");

    expect(body.commit).toBeUndefined();
    expect(transcriptHuh?._audience_override).toEqual([firstSession.actor]);
    expect(liveHuh?.audience).toEqual({ actors: [firstSession.actor] });
    expect((liveHuh?.observation as Record<string, unknown> | undefined)?._audience_override).toBeUndefined();
    expect(first.cache.live_events).toHaveLength(0);
    expect(second.cache.live_events).toHaveLength(0);
  });

  it("bounds remembered envelope ids and cached replies inside the idempotency window", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-idempotency-cap");
    await openShadowBrowserScope(browser);
    const maxEntries = 10_000;
    let firstKey = "";

    for (let i = 0; i < maxEntries + 5; i += 1) {
      const reply = {
        kind: "woo.turn.exec.reply.shadow.v1" as const,
        id: `cap-reply-${i}`,
        ok: false,
        reason: "missing_state" as const
      };
      const frame = encodeEnvelope(shadowBrowserEnvelope(browser, reply.kind, reply, `cap-envelope-${i}`));
      const receipt = receiveShadowBrowserEnvelopeReceipt(browser, frame);
      if (i === 0) {
        firstKey = receipt.idempotency_key;
        // Reply eviction must follow envelope-id eviction so retries cannot
        // leave old response bodies resident after their replay key is gone.
        browser.relay.recent_replies.set(firstKey, shadowBrowserEnvelope(browser, reply.kind, reply, "cached-cap-reply"));
      }
    }

    expect(browser.relay.recently_seen.size).toBe(maxEntries);
    expect(browser.relay.recently_seen.has(firstKey)).toBe(false);
    expect(browser.relay.recent_replies.has(firstKey)).toBe(false);
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

  it("falls back to projection when retained delta catch-up would exceed one envelope", async () => {
    const { browser } = await browserForScope("the_chatroom", "guest:browser-catchup-oversized");
    await openShadowBrowserScope(browser);
    const base = structuredClone(browser.relay.commit_scope.head);
    const largeText = "chat transcript padding ".repeat(4000);

    for (let seq = 1; seq <= 20; seq += 1) {
      const position: ShadowScopeHead = {
        kind: "woo.scope_head.shadow.v1",
        scope: "the_chatroom",
        epoch: browser.relay.commit_scope.head.epoch,
        seq,
        hash: `oversized-head-${seq}`
      };
      const transcriptHash = `oversized-transcript-${seq}`;
      const accepted: ShadowCommitAccepted = {
        kind: "woo.commit.accepted.shadow.v1",
        id: `oversized-frame-${seq}`,
        position,
        transcript_hash: transcriptHash,
        post_state_hash: `oversized-post-state-${seq}`,
        observations: [{ type: "said", actor: browser.actor, text: largeText, source: "the_chatroom" }],
        receipt: {
          kind: "woo.commit_receipt.shadow.v1",
          id: `oversized-frame-${seq}`,
          route: "sequenced",
          scope: "the_chatroom",
          seq,
          transcript_hash: transcriptHash,
          pre_state_hash: `oversized-pre-state-${seq}`,
          post_state_hash: `oversized-post-state-${seq}`,
          accepted: true,
          errors: []
        }
      };
      const transcript: EffectTranscript = {
        kind: "woo.effect_transcript.shadow.v1",
        id: `oversized-transcript-${seq}`,
        route: "sequenced",
        scope: "the_chatroom",
        seq,
        session: browser.session,
        call: { actor: browser.actor, target: "the_chatroom", verb: "say", args: [largeText] },
        reads: [],
        writes: [],
        creates: [],
        moves: [],
        observations: [{ type: "said", actor: browser.actor, text: largeText, source: "the_chatroom" }],
        logicalInputs: [],
        untrackedEffects: [],
        result: true,
        complete: true,
        incompleteReasons: [],
        hash: transcriptHash
      };
      browser.relay.accepted_frames.push(accepted);
      browser.relay.transcript_tail.push(transcript);
      browser.relay.commit_scope.head = position;
    }

    const reconnected = createShadowBrowserNode({
      node: "browser-catchup-oversized-reconnect",
      scope: "the_chatroom",
      actor: browser.actor,
      session: browser.session,
      relay: browser.relay
    });
    const caughtUp = await openShadowBrowserScope(reconnected, { last_known_head: base });

    expect(caughtUp.transfer_mode).toBe("projection");
    expect(reconnected.cache.applied_frames).toHaveLength(0);
    expect(reconnected.cache.projections.get("the_chatroom")).toMatchObject({ seq: 20 });
    expect(() => encodeEnvelope(
      shadowBrowserEnvelope(reconnected, "woo.state.transfer.shadow.v1", caughtUp.transfer, "oversized-catchup-transfer")
    )).not.toThrow();
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
    await moveActorToScope(anchor, firstSession, "the_dubspace", "browser-catchup-stale-a-move");
    await moveActorToScope(anchor, secondSession, "the_dubspace", "browser-catchup-stale-b-move");
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
    await moveActorToScope(anchor, firstSession, "the_dubspace", "browser-mux-a-move");
    await moveActorToScope(anchor, secondSession, "the_dubspace", "browser-mux-b-move");
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

  it("reuses the relay executor across committed turns at the current head", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-executor-reuse");
    await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
    const first = await submitIntentForTest(browser, {
      id: "browser-executor-reuse-first",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.21]
    });
    expect(first.body).toMatchObject({ ok: true });
    const executor = browser.relay.executors.find((node) => node.node === `${browser.relay.node}:executor`);
    expect(executor).toBeDefined();

    const second = await submitIntentForTest(browser, {
      id: "browser-executor-reuse-second",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.22]
    });

    expect(second.body).toMatchObject({ ok: true });
    expect(browser.relay.executors.find((node) => node.node === `${browser.relay.node}:executor`)).toBe(executor);
  });

  it("rebuilds the relay executor when serialized authority changes without a new head", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-executor-generation");
    await openShadowBrowserScope(browser, { preseed_catalog_pages: true });
    const first = await submitIntentForTest(browser, {
      id: "browser-executor-generation-first",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.23]
    });
    expect(first.body).toMatchObject({ ok: true });
    const executor = browser.relay.executors.find((node) => node.node === `${browser.relay.node}:executor`);
    expect(executor).toBeDefined();
    markShadowBrowserRelaySerializedChanged(browser.relay);

    const second = await submitIntentForTest(browser, {
      id: "browser-executor-generation-second",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.24]
    });

    expect(second.body).toMatchObject({ ok: true });
    expect(browser.relay.executors.find((node) => node.node === `${browser.relay.node}:executor`)).not.toBe(executor);
  });

  it("honors a selected delegated executor and replies with executable cache material", async () => {
    const { browser, actor } = await browserForScope("the_dubspace", "guest:browser-selected-executor", async (world, session) => {
    });
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "browser-selected-executor-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: browser.session,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.37]
    };
    const planned = await runShadowTurnCall(authoritativePlanningWorld(serializedFor(browser.relay.commit_scope)), call);
    const key = shadowTurnKeyFromTranscript(planned.transcript);
    browser.relay.executors.push(createShadowExecutionNode({
      node: "near-executor",
      scope: key.scope,
      serialized: serializedFor(browser.relay.commit_scope),
      atom_hashes: key.atom_hashes
    }));
    const request = {
      kind: "woo.turn.exec.request.shadow.v1" as const,
      id: call.id,
      call,
      key,
      expected: browser.relay.commit_scope.head,
      selected_ad: "near-executor",
      persistence: "durable" as const
    };
    const envelope = shadowBrowserEnvelope(browser, "woo.turn.exec.request.shadow.v1", request, "browser-selected-executor-env");

    const reply = await handleShadowBrowserTurnExecEnvelope(browser, receiveShadowBrowserEnvelopeReceipt(browser, encodeEnvelope(envelope)));

    expect(reply?.body).toMatchObject({
      ok: true,
      // B7 / VTN12.1: the delegated commit reply is a warm cache-fill and MUST
      // carry purpose accepted_write_cells — the browser worker's accepted-write
      // high-watermark keys on it. The capsule head is the post-commit head.
      state_transfer: {
        kind: "woo.state.transfer.shadow.v1",
        mode: "cell_pages",
        scope: "the_dubspace",
        purpose: "accepted_write_cells"
      },
      ads: [expect.objectContaining({ node: "near-executor" })]
    });
    const warm = reply?.body.ok ? reply.body.state_transfer : undefined;
    expect(warm?.mode === "cell_pages" ? warm.capsule?.head.scope : undefined).toBe("the_dubspace");
    expect(worldFor(browser).getProp("delay_1", "wet")).toBe(0.37);
  });

  it("executes default server-assisted intents through the guarded relay executor", async () => {
    const { browser } = await browserForScope("the_dubspace", "guest:browser-authoritative-intent", async (world, session) => {
    });
    const metrics: MetricEvent[] = [];
    const envelope = shadowBrowserEnvelope(browser, "woo.turn.intent.request.shadow.v1", {
      kind: "woo.turn.intent.request.shadow.v1" as const,
      id: "browser-authoritative-intent-wet",
      route: "sequenced" as const,
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.38],
      persistence: "durable" as const
    }, "browser-authoritative-intent-env");

    const reply = await handleShadowBrowserTurnExecEnvelope(
      browser,
      receiveShadowBrowserEnvelopeReceipt(browser, encodeEnvelope(envelope)),
      { onMetric: (event) => metrics.push(event) }
    );

    expect(reply?.body).toMatchObject({
      ok: true,
      commit: { kind: "woo.commit.accepted.shadow.v1", position: { scope: "the_dubspace", seq: 1 } },
      ads: [expect.objectContaining({ node: "browser-relay:executor" })]
    });
    expect(reply?.body.state_transfer).toBeUndefined();
    expect(metrics.filter((event) => event.kind === "applied" && event.verb === "set_control")).toHaveLength(1);
    expect(worldFor(browser).getProp("delay_1", "wet")).toBe(0.38);
  });

  it("reports a transitive object miss from default server-assisted intents as missing_state", async () => {
    const { browser, actor } = await browserForScope("the_deck", "guest:browser-guarded-intent-miss");
    const serialized = serializedFor(browser.relay.commit_scope);
    serialized.objects = serialized.objects.filter((obj) =>
      !["the_garden", "exit_garden_north", "exit_garden_south"].includes(obj.id)
    );
    markShadowBrowserRelaySerializedChanged(browser.relay);

    const envelope = shadowBrowserEnvelope(browser, "woo.turn.intent.request.shadow.v1", {
      kind: "woo.turn.intent.request.shadow.v1" as const,
      id: "browser-guarded-intent-south",
      route: "sequenced" as const,
      scope: "the_deck",
      target: "the_deck",
      verb: "south",
      args: [],
      persistence: "durable" as const
    }, "browser-guarded-intent-miss-env");

    const reply = await handleShadowBrowserTurnExecEnvelope(
      browser,
      receiveShadowBrowserEnvelopeReceipt(browser, encodeEnvelope(envelope))
    );

    expect(reply?.body).toMatchObject({
      kind: "woo.turn.exec.reply.shadow.v1",
      ok: false,
      reason: "missing_state"
    });
    const missing = reply?.body.ok === false ? reply.body.missing_atoms ?? [] : [];
    expect(missing.some((atom) => atom.preimage === "read:cell:lifecycle:the_garden")).toBe(true);
    expect(reply?.body.commit).toBeUndefined();
    expect(worldFor(browser).allLocationsForActor(actor)).toEqual(["the_deck"]);
  });

  it("carries selected delegated executors through server-assisted intent planning", async () => {
    const { browser, actor } = await browserForScope("the_dubspace", "guest:browser-selected-intent-executor", async (world, session) => {
    });
    const planningCall: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "browser-selected-intent-executor-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: browser.session,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.39]
    };
    const key = shadowTurnKeyFromTranscript((await runShadowTurnCall(authoritativePlanningWorld(serializedFor(browser.relay.commit_scope)), planningCall)).transcript);
    browser.relay.executors.push(createShadowExecutionNode({
      node: "near-intent-executor",
      scope: key.scope,
      serialized: serializedFor(browser.relay.commit_scope),
      atom_hashes: key.atom_hashes
    }));
    const envelope = shadowBrowserEnvelope(browser, "woo.turn.intent.request.shadow.v1", {
      kind: "woo.turn.intent.request.shadow.v1" as const,
      id: planningCall.id,
      route: "sequenced" as const,
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.39],
      selected_ad: "near-intent-executor",
      persistence: "durable" as const
    }, "browser-selected-intent-executor-env");

    const reply = await handleShadowBrowserTurnExecEnvelope(browser, receiveShadowBrowserEnvelopeReceipt(browser, encodeEnvelope(envelope)));

    expect(reply?.body).toMatchObject({
      ok: true,
      state_transfer: { kind: "woo.state.transfer.shadow.v1", mode: "cell_pages", scope: "the_dubspace" },
      ads: [expect.objectContaining({ node: "near-intent-executor" })]
    });
    expect(worldFor(browser).getProp("delay_1", "wet")).toBe(0.39);
  });

  it("serves executable state transfer requests without committing the turn", async () => {
    const { browser, actor } = await browserForScope("the_dubspace", "guest:browser-state-repair", async (world, session) => {
    });
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "browser-state-repair-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: browser.session,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.41]
    };
    const key = shadowTurnKeyFromTranscript((await runShadowTurnCall(authoritativePlanningWorld(serializedFor(browser.relay.commit_scope)), call)).transcript);
    const envelope = shadowBrowserEnvelope(browser, "woo.state.transfer.request.shadow.v1", {
      kind: "woo.state.transfer.request.shadow.v1" as const,
      id: "browser-state-repair-request",
      scope: "the_dubspace",
      key,
      atom_hashes: [key.atom_hashes[0]],
      mode: "cell_pages" as const
    }, "browser-state-repair-env");

    const reply = handleShadowBrowserStateTransferEnvelope(browser, receiveShadowBrowserEnvelopeReceipt(browser, encodeEnvelope(envelope)));

    expect(reply).toMatchObject({
      type: "woo.state.transfer.shadow.v1",
      reply_to: "browser-state-repair-env",
      body: {
        mode: "cell_pages",
        scope: "the_dubspace",
        atom_hashes: [key.atom_hashes[0]]
      }
    });
    expect(reply?.body.mode === "cell_pages" ? reply.body.inline_pages.length : 0).toBeGreaterThan(0);
    expect(browser.relay.commit_scope.head.seq).toBe(0);
  });

  it("compacts repeated executable state transfer known-page echoes behind a browser-held set token", async () => {
    const { browser, actor } = await browserForScope("the_dubspace", "guest:browser-known-pages", async (world, session) => {
    });
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "browser-known-pages-wet",
      route: "sequenced",
      scope: "the_dubspace",
      session: browser.session,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.52]
    };
    const key = shadowTurnKeyFromTranscript((await runShadowTurnCall(authoritativePlanningWorld(serializedFor(browser.relay.commit_scope)), call)).transcript);
    const first = handleShadowBrowserStateTransferEnvelope(browser, receiveShadowBrowserEnvelopeReceipt(browser, encodeEnvelope(shadowBrowserEnvelope(browser, "woo.state.transfer.request.shadow.v1", {
      kind: "woo.state.transfer.request.shadow.v1" as const,
      id: "browser-known-pages-first",
      scope: "the_dubspace",
      key,
      atom_hashes: [key.atom_hashes[0]],
      mode: "cell_pages" as const
    }, "browser-known-pages-first-env"))));
    if (!first || first.body.mode !== "cell_pages" || !first.body.known_page_cache) throw new Error("expected first cell-page transfer with known-page cache token");
    expect(first.body.inline_pages.length).toBeGreaterThan(0);
    expect(first.body.known_page_cache.count).toBe(first.body.page_refs.length);
    expect(browser.cache.known_page_sets.get(first.body.known_page_cache.token)).toHaveLength(first.body.page_refs.length);

    const compact = handleShadowBrowserStateTransferEnvelope(browser, receiveShadowBrowserEnvelopeReceipt(browser, encodeEnvelope(shadowBrowserEnvelope(browser, "woo.state.transfer.request.shadow.v1", {
      kind: "woo.state.transfer.request.shadow.v1" as const,
      id: "browser-known-pages-compact",
      scope: "the_dubspace",
      key,
      atom_hashes: [key.atom_hashes[0]],
      known_page_cache: first.body.known_page_cache,
      mode: "cell_pages" as const
    }, "browser-known-pages-compact-env"))));
    if (!compact || compact.body.mode !== "cell_pages") throw new Error("expected compact cell-page transfer");
    expect(compact.body.known_page_cache_status).toBe("hit");
    expect(compact.body.page_refs.length).toBe(first.body.page_refs.length);
    expect(compact.body.inline_pages).toHaveLength(0);
    expect(compact.body.page_refs.every((ref) => ref.inline === false)).toBe(true);
    expect(Array.from(browser.cache.known_page_sets.keys()).at(-1)).toBe(first.body.known_page_cache.token);

    const missIdentity = { ...first.body.known_page_cache, token: `${first.body.known_page_cache.token}:missing`, digest: `${first.body.known_page_cache.digest}:missing` };
    const fallback = handleShadowBrowserStateTransferEnvelope(browser, receiveShadowBrowserEnvelopeReceipt(browser, encodeEnvelope(shadowBrowserEnvelope(browser, "woo.state.transfer.request.shadow.v1", {
      kind: "woo.state.transfer.request.shadow.v1" as const,
      id: "browser-known-pages-miss",
      scope: "the_dubspace",
      key,
      atom_hashes: [key.atom_hashes[0]],
      known_page_cache: missIdentity,
      mode: "cell_pages" as const
    }, "browser-known-pages-miss-env"))));
    if (!fallback || fallback.body.mode !== "cell_pages") throw new Error("expected fallback cell-page transfer");
    expect(fallback.body.known_page_cache_status).toBe("miss");
    expect(fallback.body.inline_pages.length).toBeGreaterThan(0);
  });

  it("does not let a stale browser close remove replacement node auth", async () => {
    const anchor = createWorld();
    const session = anchor.auth("guest:browser-reload-auth");
    await moveActorToScope(anchor, session, "the_dubspace", "browser-reload-auth-move");
    const relay = createShadowBrowserRelayShim({
      node: "browser-relay",
      scope: "the_dubspace",
      serialized: anchor.exportWorld()
    });
    const token = `session:${session.id}`;
    const stale = createShadowBrowserNode({
      node: "browser-reload",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay
    });
    setShadowBrowserSessionToken(stale, token);
    await openShadowBrowserScope(stale, { preseed_catalog_pages: true });
    const replacement = createShadowBrowserNode({
      node: stale.node,
      scope: stale.scope,
      actor: stale.actor,
      session: stale.session,
      relay
    });
    setShadowBrowserSessionToken(replacement, token);
    await openShadowBrowserScope(replacement, { preseed_catalog_pages: true });

    disposeShadowBrowserNode(stale);

    expect(relay.browsers.get(stale.node)).toBe(replacement);
    expect(() => shadowBrowserEnvelope(replacement, "woo.turn.intent.request.shadow.v1", {
      kind: "woo.turn.intent.request.shadow.v1" as const,
      id: "browser-reload-auth-intent",
      route: "sequenced" as const,
      scope: replacement.scope,
      target: "the_dubspace",
      verb: "look",
      args: [],
      persistence: "durable" as const
    })).not.toThrow();
  });

  // B9 (VTN0 / VTN14): the browser is a narrow-authority node, NOT a divergent
  // holder. It may execute optimistically for its actor, but every durable
  // commit is server-validated and there is no second write path — its
  // authoritative view IS the server commit scope. Two browsers racing the same
  // cell converge to that single authority (no divergent holder state); the
  // browser advertises no broad ExecCapabilityAd.
  it("B9: browser commits are server-validated and converge to one authority (no divergent holder)", async () => {
    const anchor = createWorld();
    const sessionA = anchor.auth("guest:b9-a");
    const sessionB = anchor.auth("guest:b9-b");
    await moveActorToScope(anchor, sessionA, "the_dubspace", "b9-a-move");
    await moveActorToScope(anchor, sessionB, "the_dubspace", "b9-b-move");
    const relay = createShadowBrowserRelayShim({ node: "b9-relay", scope: "the_dubspace", serialized: anchor.exportWorld() });
    const a = createShadowBrowserNode({ node: "b9-a", scope: "the_dubspace", actor: sessionA.actor, session: sessionA.id, relay });
    const b = createShadowBrowserNode({ node: "b9-b", scope: "the_dubspace", actor: sessionB.actor, session: sessionB.id, relay });
    await openShadowBrowserScope(a, { preseed_catalog_pages: true });
    await openShadowBrowserScope(b, { preseed_catalog_pages: true });

    // The browser MUST NOT advertise a broad capability — only a narrow
    // session-local scope ad with empty coverage (VTN14: MUST NOT advertise
    // broad ExecCapabilityAds).
    for (const ad of shadowBrowserScopeExecutionAds(relay, "the_dubspace")) {
      expect(/^0*$/.test(ad.covers.bits_hex)).toBe(true);
      expect(/^0*$/.test(ad.accepts.bits_hex)).toBe(true);
    }

    const turnA = await executeShadowBrowserTurn(a, {
      id: "b9-a-set", target: "the_dubspace", verb: "set_control", args: ["delay_1", "wet", 0.41]
    });
    expect(turnA.result.ok).toBe(true);
    if (!turnA.result.ok) throw new Error(`A failed: ${turnA.result.reason}`);
    // Server-validated: the commit landed at the server commit scope, not a
    // browser-local authority.
    expect(turnA.result.commit?.position.scope).toBe("the_dubspace");

    const turnB = await executeShadowBrowserTurn(b, {
      id: "b9-b-set", target: "the_dubspace", verb: "set_control", args: ["delay_1", "wet", 0.42]
    });
    expect(turnB.result.ok).toBe(true);

    // No divergent holder: both browsers' authoritative view is the single server
    // commit scope, which holds the last committed value. There is no separate
    // browser-held committed state to diverge.
    expect(worldFor(a).getProp("delay_1", "wet")).toBe(0.42);
    expect(worldFor(b).getProp("delay_1", "wet")).toBe(0.42);
    expect(serializedFor(relay.commit_scope).objects.find((o) => o.id === "delay_1")
      ?.properties.find(([name]) => name === "wet")?.[1]).toBe(0.42);
  });

  // Regression: a scope ad is a cold-start routing hint that gets gossiped and
  // persisted, then read back via allExecutionAds() on the cold delegation
  // fallback. It MUST carry freshness — without issued_at_ms/ttl_ms a stale ad
  // (e.g. one naming an executor node id from a prior connection) stays
  // selectable indefinitely across reconnects, because capabilityAdExpired only
  // drops ads that stamp both fields. Pin that the emitter stamps a TTL in the
  // same Date.now() domain the routing reader uses, and that expiry is enforced.
  it("scope ad carries a TTL so a stale hint is dropped by the routing reader", () => {
    const relay = createShadowBrowserRelayShim({
      node: "ttl-relay", scope: "the_dubspace", serialized: createWorld().exportWorld()
    });
    const issuedAt = 1_000_000;
    const ads = shadowBrowserScopeExecutionAds(relay, "the_dubspace", issuedAt);
    expect(ads).toHaveLength(1);
    const [ad] = ads;
    // Freshness fields are present and stamped in the supplied clock domain.
    expect(ad.issued_at_ms).toBe(issuedAt);
    expect(ad.ttl_ms).toBeGreaterThan(0);

    // Fresh and just-before-expiry: the ad routes. Past issued_at_ms + ttl_ms:
    // the reader drops it (whereas before the fix, with no TTL, it never expired).
    const ttl = ad.ttl_ms!;
    expect(rankCapabilityAdsForScope(ads, "the_dubspace", { now: issuedAt }).map((a) => a.node)).toEqual([ad.node]);
    expect(rankCapabilityAdsForScope(ads, "the_dubspace", { now: issuedAt + ttl }).map((a) => a.node)).toEqual([ad.node]);
    expect(rankCapabilityAdsForScope(ads, "the_dubspace", { now: issuedAt + ttl + 1 }).map((a) => a.node)).toEqual([]);
  });
});

describe("shadow browser relay seed provenance (A3.2)", () => {
  // P1b (review): createShadowBrowserRelayShim is generic across holders and must NOT
  // impose a `cache` default — an authority-derived seed keeps its real per-cell
  // provenance, the browser-holder factory stamps cache, and a no-seed direct world
  // is left empty (unknown).
  function seedObjectId() {
    const serialized = createWorld().exportWorld();
    return { serialized, id: serialized.objects[0].id };
  }

  it("preserves an authority-derived seed's provenance instead of flattening to cache", () => {
    const { serialized, id } = seedObjectId();
    const seed = new Map([[planningCellKey(id, "object_lineage"), { source: "authoritative" as const }]]);
    const relay = createShadowBrowserRelayShim({ node: "n", scope: "$system", serialized, seedCellProvenance: seed });
    expect(relay.commit_scope.cellProvenance?.get(planningCellKey(id, "object_lineage"))).toEqual({ source: "authoritative" });
  });

  it("leaves seed provenance empty when no seed is declared (no constructor default)", () => {
    const { serialized } = seedObjectId();
    const relay = createShadowBrowserRelayShim({ node: "n", scope: "$system", serialized });
    expect(relay.commit_scope.cellProvenance === undefined || relay.commit_scope.cellProvenance.size === 0).toBe(true);
  });

  it("createShadowBrowserNode stamps cache for the holder's seed (derived view)", () => {
    const { serialized, id } = seedObjectId();
    const relay = createShadowBrowserRelayShim({ node: "n", scope: "$system", serialized });
    createShadowBrowserNode({ node: "browser", scope: "$system", actor: "$wiz", relay });
    expect(relay.commit_scope.cellProvenance?.get(planningCellKey(id, "object_lineage"))).toEqual({ source: "cache" });
  });

  it("createShadowBrowserNode does not downgrade an authority seed to cache (record-if-stronger)", () => {
    const { serialized, id } = seedObjectId();
    const seed = new Map([[planningCellKey(id, "object_lineage"), { source: "authoritative" as const }]]);
    const relay = createShadowBrowserRelayShim({ node: "n", scope: "$system", serialized, seedCellProvenance: seed });
    createShadowBrowserNode({ node: "browser", scope: "$system", actor: "$wiz", relay });
    expect(relay.commit_scope.cellProvenance?.get(planningCellKey(id, "object_lineage"))).toEqual({ source: "authoritative" });
  });

  it("prunes non-authoritative presentation stubs from the shared relay cache", () => {
    const serialized = createWorld().exportWorld();
    const room = serialized.objects.find((obj) => obj.id === "the_chatroom");
    expect(room).toBeDefined();
    const staleActor: SerializedObject = {
      id: "guest_249",
      name: "guest_249",
      parent: "$guest",
      anchor: null,
      owner: "guest_249",
      location: "the_chatroom",
      flags: {},
      created: 0,
      modified: 0,
      propertyDefs: [],
      properties: [],
      propertyVersions: [],
      verbs: [],
      children: [],
      contents: [],
      eventSchemas: []
    };
    serialized.objects.push(staleActor);
    room!.contents = [...room!.contents, staleActor.id].sort();
    serialized.sessions.push({
      id: "stale-session",
      actor: staleActor.id,
      started: 1,
      expiresAt: Date.now() + 60_000,
      lastDetachAt: null,
      tokenClass: "guest",
      activeScope: "the_chatroom"
    });
    const relay = createShadowBrowserRelayShim({
      node: "cache-prune",
      scope: "the_chatroom",
      serialized,
      seedCellProvenance: new Map([
        [planningCellKey(staleActor.id, "object_lineage"), { source: "cache" }],
        [planningCellKey(staleActor.id, "object_live"), { source: "cache" }]
      ])
    });

    const changed = mergeAuthorityIntoRelayCache(relay, {
      kind: "woo.authority_slice.cells.shadow.v1",
      sessions: [],
      page_refs: [],
      inline_pages: [],
      counters: { objectCounter: 1, parkedTaskCounter: 1, sessionCounter: 1 },
      tombstones: [],
      source_object_count: 0
    });
    const after = serializedFor(relay.commit_scope);

    expect(changed).toBe(true);
    expect(after.objects.some((obj) => obj.id === staleActor.id)).toBe(false);
    expect(after.sessions.some((session) => session.actor === staleActor.id)).toBe(false);
    expect(after.objects.find((obj) => obj.id === "the_chatroom")?.contents).not.toContain(staleActor.id);
    expect(relay.commit_scope.cellProvenance?.has(planningCellKey(staleActor.id, "object_lineage"))).toBe(false);
    expect(relay.commit_scope.cellProvenance?.has(planningCellKey(staleActor.id, "object_live"))).toBe(false);
  });

  // Finding 2 (review): the ONE shared derived-cache applier materializes the authority
  // projection_writes object rows (a moved object's real lineage/live), records their
  // provenance, and does NOT advance the relay head. Used by MCP/REST/browser alike.
  it("applyAcceptedFrameToDerivedRelayCache materializes projection rows + provenance, no head advance", () => {
    const { serialized } = seedObjectId();
    const relay = createShadowBrowserRelayShim({ node: "derived", scope: "room", serialized });
    const headBefore = relay.commit_scope.head.hash;
    const widget: SerializedObject = {
      id: "remote_widget", name: "Remote Widget", parent: "$thing", anchor: null, owner: "$wiz",
      location: "room", flags: {}, created: 0, modified: 0, propertyDefs: [], properties: [],
      propertyVersions: [], verbs: [], children: [], contents: [], eventSchemas: []
    };
    const accepted = {
      position: { kind: "woo.scope_head.shadow.v1", scope: "other", epoch: 1, seq: 1, hash: "h" },
      projection_writes: [{ table: "objects", op: "upsert", key: "remote_widget", row: widget }]
    } as unknown as ShadowCommitAccepted;
    const emptyTranscript: EffectTranscript = {
      kind: "woo.effect_transcript.shadow.v1", id: "f", route: "sequenced", scope: "room", seq: 0,
      session: "s", call: { actor: "a", target: "room", verb: "noop", args: [], body: undefined },
      reads: [], writes: [], creates: [], moves: [], observations: [], logicalInputs: [], untrackedEffects: [],
      complete: true, incompleteReasons: [], hash: "t:f"
    };

    applyAcceptedFrameToDerivedRelayCache(relay, accepted, emptyTranscript);
    expect(serializedFor(relay.commit_scope).objects.find((o) => o.id === "remote_widget")?.name).toBe("Remote Widget");
    expect(relay.commit_scope.cellProvenance?.get(planningCellKey("remote_widget", "object_lineage"))).toEqual({ source: "cache" });
    expect(relay.commit_scope.head.hash).toBe(headBefore);
  });
});

async function browserForScope<T = undefined>(
  scope: ObjRef,
  token: string,
  setup?: (anchor: ReturnType<typeof createWorld>, session: ReturnType<ReturnType<typeof createWorld>["auth"]>) => Promise<T>
): Promise<{ browser: ShadowBrowserNode; actor: ObjRef; seed: T }> {
  const anchor = createWorld();
  const session = anchor.auth(token);
  await moveActorToScope(anchor, session, scope, `${token}:move:${scope}`);
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
  return createWorldFromSerialized(serializedFor(browser.relay.commit_scope), { persist: false });
}

function stateTransferJsonBytes(transfer: ShadowCellPageTransfer): number {
  return new TextEncoder().encode(JSON.stringify(transfer)).length;
}

function pageBytesByKind(transfer: ShadowCellPageTransfer): Record<string, number> {
  const out: Record<string, number> = {};
  for (const page of transfer.inline_pages) {
    out[page.page] = (out[page.page] ?? 0) + new TextEncoder().encode(JSON.stringify(page)).length;
  }
  return out;
}

function hasTransferPage(
  transfer: ShadowCellPageTransfer,
  object: string,
  page: string,
  name?: string
): boolean {
  return transfer.inline_pages.some((item) =>
    item.object === object &&
    item.page === page &&
    (name === undefined || ("name" in item && item.name === name))
  );
}

async function submitIntentForTest(
  browser: ShadowBrowserNode,
  input: { id: string; target: ObjRef; verb: string; args?: WooValue[] }
): Promise<{ body: NonNullable<Awaited<ReturnType<typeof handleShadowBrowserTurnExecEnvelope>>>["body"] }> {
  const envelope = shadowBrowserEnvelope(browser, "woo.turn.intent.request.shadow.v1", {
    kind: "woo.turn.intent.request.shadow.v1" as const,
    id: input.id,
    route: "sequenced" as const,
    scope: browser.scope,
    target: input.target,
    verb: input.verb,
    args: input.args ?? [],
    persistence: "durable" as const
  });
  const reply = await handleShadowBrowserTurnExecEnvelope(browser, receiveShadowBrowserEnvelopeReceipt(browser, encodeEnvelope(envelope)));
  if (!reply) throw new Error(`expected intent reply for ${input.id}`);
  return { body: reply.body };
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
    projection: transfer.projection ?? null,
    projection_patch: transfer.mode === "delta" ? transfer.projection_patch ?? null : null,
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
