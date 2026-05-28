import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeIndexedDBFactory } from "./helpers/fake-indexeddb";
import { encodeEnvelope, decodeEnvelope, type ShadowEnvelope } from "../src/core/shadow-envelope";
import {
  buildShadowBrowserOpenExecutableSeedTransfer,
  createShadowBrowserClient,
  createShadowBrowserRelayShim,
  handleShadowBrowserStateTransferEnvelope,
  handleShadowBrowserTurnExecEnvelope,
  openShadowBrowserScope,
  receiveShadowBrowserEnvelopeReceipt,
  shadowBrowserTransportHello
} from "../src/core/shadow-browser-node";
import { createWorld } from "../src/core/bootstrap";
import type { EffectTranscript } from "../src/core/effect-transcript";
import type { BrowserObjectRow, BrowserProfile, ProjectionWrite } from "../src/core/projection-delta";
import { createShadowCommitScope, type ShadowCommitAccepted } from "../src/core/shadow-commit-scope";
import type { ShadowTurnExecReply } from "../src/core/shadow-turn-exec";

describe("v2 browser worker integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    FakeWebSocket.instances.length = 0;
  });

  it("waits for open executable state and submits the first durable turn as a browser-built exec request", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker",
      scope: "the_dubspace",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-1", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-1", opened.transfer.kind, opened.transfer)));
    await waitForMessage(posted, (message) => isBrowserMetricPhase(message, "frame_process"));
    await waitForMessage(posted, (message) => isBrowserMetricPhase(message, "idb_tx"));

    scope.dispatch({
      kind: "call",
      id: "cold-dubspace-control",
      route: "sequenced",
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.22],
      persistence: "durable"
    });
    await sleep(20);
    expect(socket.sent).toHaveLength(0);

    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-1", opened.executable_transfer.kind, opened.executable_transfer)));
    await sleep(20);
    expect(socket.sent).toHaveLength(0);

    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-1", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));
    const coldRequest = await waitForBrowserBuiltExecRequest(browser, socket);
    expect(coldRequest).toMatchObject({
      type: "woo.turn.exec.request.shadow.v1",
      body: {
        kind: "woo.turn.exec.request.shadow.v1",
        id: "cold-dubspace-control",
        call: {
          target: "the_dubspace",
          verb: "set_control"
        }
      }
    });
    expect((coldRequest.body as { selected_ad?: unknown }).selected_ad).toBeUndefined();
    const optimisticIndex = await waitForMessageIndex(posted, (message) => isOptimisticTurnResult(message, "cold-dubspace-control"));
    const proposalJournalIndex = await waitForMessageIndex(posted, (message) =>
      browserMetric(message)?.phase === "proposal_journal" &&
      browserMetric(message)?.path === "fire_and_forget"
    );
    expect(optimisticIndex).toBeLessThan(proposalJournalIndex);
    const beforeReplyStatusCursor = posted.filter((message) => isKind(message, "status")).length;
    scope.dispatch({ kind: "cache_status" });
    const beforeReplyStatus = await waitFor(() => posted.filter((message) => isKind(message, "status")).slice(beforeReplyStatusCursor)[0]);
    const transferCountBeforeReply = (beforeReplyStatus as { status?: { execution_transfers?: unknown } }).status?.execution_transfers;
    expect(typeof transferCountBeforeReply).toBe("number");

    const coldReply = await relayReply(browser, encodeEnvelope(coldRequest));
    socket.receive(encodeEnvelope(coldReply));
    await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "cold-dubspace-control"));
    await waitForMessage(posted, (message) => isKind(message, "applied_frame"));
    await waitForMessage(posted, (message) => isLocalTurnCommitted(message, "cold-dubspace-control"));
    expect(await waitForMessage(posted, (message) => isExecutionPromotionFor(message, "the_dubspace", "proposal_accept"))).toMatchObject({
      kind: "shadow_browser_execution_promotion",
      through_seq: 1,
      transcript_count: 1,
      proposal_id: "cold-dubspace-control"
    });
    const statusCursor = posted.filter((message) => isKind(message, "status")).length;
    scope.dispatch({ kind: "cache_status" });
    const afterReplyStatus = await waitFor(() => posted.filter((message) => isKind(message, "status")).slice(statusCursor)[0]);
    expect(afterReplyStatus).toMatchObject({
      status: {
        transcript_tail: 0,
        execution_checkpoints: 0,
        local_execution_ready: true
      }
    });
    expect(Number((afterReplyStatus as { status?: { execution_transfers?: unknown } }).status?.execution_transfers))
      .toBeGreaterThanOrEqual((transferCountBeforeReply as number) + 1);

    posted.length = 0;
    scope.dispatch({
      kind: "call",
      id: "warm-dubspace-control",
      route: "sequenced",
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.33],
      persistence: "durable"
    });

    const warmRequest = await waitForBrowserBuiltExecRequest(browser, socket);
    expect(await waitForMessage(posted, (message) => isComposeViewFor(message, "warm-dubspace-control"))).toMatchObject({
      kind: "shadow_browser_compose_view",
      committed_transcript_count: 0
    });
    expect(warmRequest).toMatchObject({
      type: "woo.turn.exec.request.shadow.v1",
      body: {
        kind: "woo.turn.exec.request.shadow.v1",
        id: "warm-dubspace-control",
        call: {
          target: "the_dubspace",
          verb: "set_control"
        }
      }
    });
    expect((warmRequest.body as { selected_ad?: unknown }).selected_ad).toBeUndefined();
    await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "warm-dubspace-control"));
  });

  it("rejects executable state-transfer replies that are not bound to a pending request", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-orphan-state");
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-orphan-state",
      scope: "the_dubspace",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-orphan-state",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-orphan-state"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-orphan-state",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-orphan-state", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-orphan-state", opened.transfer.kind, opened.transfer)));

    socket.receive(encodeEnvelope({
      ...relayEnvelope(browser, "exec-state-orphan", opened.executable_transfer.kind, opened.executable_transfer),
      reply_to: "missing-state-repair"
    }));

    const error = await waitForMessage(posted, (message) => isKind(message, "error"));
    expect((error as { error?: unknown }).error).toMatch(/no pending request/);
    expect(posted.some(isReadyStatus)).toBe(false);
    const idbMetricCursor = posted.filter((message) => browserMetric(message)?.phase === "idb_tx").length;
    socket.close();
    await waitForMessage(posted, (message) => browserMetric(message)?.phase === "connect_ready_wait" && browserMetric(message)?.reason === "close");
    await waitFor(() => posted.filter((message) => browserMetric(message)?.phase === "idb_tx").length > idbMetricCursor ? true : undefined);
  });

  it("rejects an open executable seed whose capsule is bound to another session", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-open-seed-capsule");
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-open-seed-capsule",
      scope: "the_dubspace",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-open-seed-capsule",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-open-seed-capsule"
    });
    const opened = await openShadowBrowserScope(browser);
    const wrongSessionSeed = buildShadowBrowserOpenExecutableSeedTransfer(
      browser.relay,
      browser.scope,
      browser.node,
      browser.actor,
      "wrong-session"
    );

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-open-seed-capsule",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-open-seed-capsule", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-open-seed-capsule", opened.transfer.kind, opened.transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-open-seed-capsule", wrongSessionSeed.kind, wrongSessionSeed)));

    const error = await waitForMessage(posted, (message) => isKind(message, "error"));
    expect((error as { error?: unknown }).error).toMatch(/session mismatch/);
    const idbMetricCursor = posted.filter((message) => browserMetric(message)?.phase === "idb_tx").length;
    socket.close();
    await waitForMessage(posted, (message) => browserMetric(message)?.phase === "connect_ready_wait" && browserMetric(message)?.reason === "close");
    await waitFor(() => posted.filter((message) => browserMetric(message)?.phase === "idb_tx").length > idbMetricCursor ? true : undefined);
    const statusCursor = posted.filter((message) => isKind(message, "status")).length;
    scope.dispatch({ kind: "cache_status" });
    expect(await waitFor(() => posted.filter((message) => isKind(message, "status")).slice(statusCursor)[0])).toMatchObject({
      status: {
        execution_transfers: 0,
        local_execution_ready: false
      }
    });
  });

  it("keeps an accepted reply when its bundled executable transfer fails capsule validation", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-bad-bundled-capsule");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-bad-bundled-capsule",
      scope: "the_dubspace",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-bad-bundled-capsule",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-bad-bundled-capsule"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-bad-bundled-capsule",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-bad-bundled-capsule", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-bad-bundled-capsule", opened.transfer.kind, opened.transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-bad-bundled-capsule", opened.executable_transfer.kind, opened.executable_transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-bad-bundled-capsule", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));
    await waitForMessage(posted, (message) => isReadyStatus(message));

    scope.dispatch({
      kind: "call",
      id: "bad-bundled-capsule-turn",
      route: "sequenced",
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.55],
      persistence: "durable"
    });
    const request = await waitForBrowserBuiltExecRequest(browser, socket, "set_control");
    await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "bad-bundled-capsule-turn"));
    const beforeStatusCursor = posted.filter((message) => isKind(message, "status")).length;
    scope.dispatch({ kind: "cache_status" });
    const beforeStatus = await waitFor(() => posted.filter((message) => isKind(message, "status")).slice(beforeStatusCursor)[0]);
    const transferCountBeforeReply = (beforeStatus as { status?: { execution_transfers?: unknown } }).status?.execution_transfers;
    expect(typeof transferCountBeforeReply).toBe("number");

    const reply = await relayReply(browser, encodeEnvelope(request));
    const badTransfer = buildShadowBrowserOpenExecutableSeedTransfer(
      browser.relay,
      browser.scope,
      browser.node,
      browser.actor,
      "wrong-session"
    );
    (reply.body as ShadowTurnExecReply).state_transfer = badTransfer;

    posted.length = 0;
    socket.receive(encodeEnvelope(reply));

    expect(await waitForMessage(posted, (message) => isKind(message, "applied_frame"))).toMatchObject({
      kind: "applied_frame"
    });
    expect(await waitForMessage(posted, (message) => isLocalTurnCommitted(message, "bad-bundled-capsule-turn"))).toMatchObject({
      kind: "local_turn_committed",
      ids: ["bad-bundled-capsule-turn"]
    });
    expect(await waitForMessage(posted, (message) => browserMetric(message)?.phase === "execution_capsule_validate")).toMatchObject({
      metric: {
        status: "error",
        error: "E_BROWSER_EXECUTION_CAPSULE"
      }
    });
    await waitForMessage(posted, (message) => isBrowserMetricPhase(message, "frame_process"));
    const statusCursor = posted.filter((message) => isKind(message, "status")).length;
    scope.dispatch({ kind: "cache_status" });
    expect(await waitFor(() => posted.filter((message) => isKind(message, "status")).slice(statusCursor)[0])).toMatchObject({
      status: {
        execution_transfers: (transferCountBeforeReply as number) + 1,
        local_execution_ready: true
      }
    });
    expect(posted.filter((message) => isLocalTurnCommitted(message, "bad-bundled-capsule-turn"))).toHaveLength(1);
  });

  it("replans a needs-replan proposal after a stale-head reply with a fresh envelope id", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-replan");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-replan",
      scope: "the_dubspace",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-replan",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-replan"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-replan",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-replan", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-replan", opened.transfer.kind, opened.transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-replan", opened.executable_transfer.kind, opened.executable_transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-replan", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));
    await waitForMessage(posted, (message) => isReadyStatus(message));

    scope.dispatch({
      kind: "call",
      id: "needs-replan-scene",
      route: "sequenced",
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "save_scene",
      args: ["Replan scene"],
      persistence: "durable"
    });
    const originalRequest = await waitForBrowserBuiltExecRequest(browser, socket, "save_scene");
    await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "needs-replan-scene"));

    const accepted = syntheticAccepted("the_dubspace", 1);
    const acceptedTranscript = syntheticPropTranscript(
      "the_dubspace",
      session.actor,
      session.id,
      1,
      "delay_1",
      "wet",
      0.48
    );
    socket.receive(encodeEnvelope(relayEnvelope(browser, "accepted-replan-interrupt", "woo.turn.exec.reply.shadow.v1", {
      kind: "woo.turn.exec.reply.shadow.v1",
      ok: true,
      id: acceptedTranscript.id,
      outcome: { result: null },
      transcript: acceptedTranscript,
      commit: accepted
    })));
    expect(await waitForMessage(posted, (message) => isLocalTurnNeedsReplan(message, "needs-replan-scene"))).toMatchObject({
      kind: "local_turn_needs_replan",
      ids: ["needs-replan-scene"],
      accepted_seq: 1
    });
    expect(await waitForMessage(posted, (message) => isExecutionPromotionFor(message, "the_dubspace", "accepted_transcript"))).toMatchObject({
      kind: "shadow_browser_execution_promotion",
      through_seq: 1,
      transcript_count: 1,
      reason: "accepted_transcript"
    });
    const statusCursor = posted.filter((message) => isKind(message, "status")).length;
    scope.dispatch({ kind: "cache_status" });
    expect(await waitFor(() => posted.filter((message) => isKind(message, "status")).slice(statusCursor)[0])).toMatchObject({
      status: {
        transcript_tail: 0
      }
    });

    const replanCursor = socket.sent.length;
    const replanMessageCursor = posted.length;
    socket.receive(encodeEnvelope({
      ...relayEnvelope(browser, "stale-replan-original", "woo.turn.exec.reply.shadow.v1", {
        kind: "woo.turn.exec.reply.shadow.v1",
        ok: false,
        id: "needs-replan-scene",
        reason: "commit_rejected",
        commit: syntheticStaleHeadConflict("needs-replan-scene", "the_dubspace", accepted.position)
      }),
      reply_to: originalRequest.id
    }));

    const replanned = await waitForMessage(posted, (message) => isKind(message, "local_turn_replanned"));
    expect(replanned).toMatchObject({
      kind: "local_turn_replanned",
      id: "needs-replan-scene",
      reason: "stale_head"
    });
    const replannedEnvelopeId = (replanned as { envelope_id?: unknown }).envelope_id;
    expect(typeof replannedEnvelopeId).toBe("string");
    expect(replannedEnvelopeId).not.toBe(originalRequest.id);
    expect(replannedEnvelopeId as string).toMatch(/^needs-replan-scene:replan:/);

    const replanRequest = await waitForBrowserBuiltExecRequest(browser, socket, "save_scene", undefined, replanCursor);
    expect(replanRequest.id).toBe(replannedEnvelopeId);
    expect(await waitForMessageFrom(posted, replanMessageCursor, (message) => isComposeViewFor(message, "needs-replan-scene"))).toMatchObject({
      kind: "shadow_browser_compose_view",
      committed_transcript_count: 0
    });
    expect(replanRequest.body).toMatchObject({
      kind: "woo.turn.exec.request.shadow.v1",
      id: "needs-replan-scene",
      call: {
        id: "needs-replan-scene",
        target: "the_dubspace",
        verb: "save_scene"
      }
    });
    expect(posted.filter((message) => isLocalTurnCommitted(message, "needs-replan-scene"))).toHaveLength(0);
  });

  it("opens from a checkpoint/tail transfer without requiring the legacy display transfer", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-checkpoint-tail");
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-checkpoint-tail",
      scope: "the_dubspace",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-checkpoint-tail",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-checkpoint-tail"
    });
    const serialized = world.exportWorld();
    const checkpointObjects = serialized.objects.filter((obj) => obj.id === "the_dubspace" || obj.id === session.actor);
    const head = relay.commit_scope.head;
    const snapshotRow = { space_id: "the_dubspace", seq: 1, ts: 1, state: { view: "checkpoint" }, hash: "snapshot-hash" };
    const parkedTaskRow = {
      id: "checkpoint-task",
      parked_on: "the_dubspace",
      state: "suspended",
      resume_at: null,
      awaiting_player: null,
      correlation_id: null,
      serialized: {},
      created: 1,
      origin: "the_dubspace"
    };
    const toolSurfaceRow = {
      kind: "woo.tool_surface_projection.v1",
      scope: "the_dubspace",
      object: "the_dubspace",
      head,
      verbs: [],
      source_rows: []
    };
    const checkpointTail = {
      kind: "woo.open.checkpoint_tail.v1",
      scope: "the_dubspace",
      head,
      transfer: {
        kind: "checkpoint",
        checkpoint: {
          kind: "woo.scope_checkpoint.v1",
          scope: "the_dubspace",
          head,
          checkpoint_hash: "checkpoint-tail-test",
          pages: [
            { kind: "woo.projection_page.v1", table: "objects", page: "objects", hash: "objects", rows: checkpointObjects },
            { kind: "woo.projection_page.v1", table: "sessions", page: "sessions", hash: "sessions", rows: serialized.sessions },
            {
              kind: "woo.projection_page.v1",
              table: "logs",
              page: "logs",
              hash: "logs",
              rows: serialized.logs.flatMap(([space, entries]) => entries.map((entry) => ({ space, entry })))
            },
            { kind: "woo.projection_page.v1", table: "snapshots", page: "snapshots", hash: "snapshots", rows: [snapshotRow] },
            { kind: "woo.projection_page.v1", table: "parked_tasks", page: "parked_tasks", hash: "parked_tasks", rows: [parkedTaskRow] },
            { kind: "woo.projection_page.v1", table: "tombstones", page: "tombstones", hash: "tombstones", rows: (serialized.tombstones ?? []).map((id) => ({ id })) },
            { kind: "woo.projection_page.v1", table: "tool_surfaces", page: "tool_surfaces", hash: "tool_surfaces", rows: [toolSurfaceRow] }
          ],
          frame_tail: []
        }
      },
      viewer: { actor: session.actor, session: session.id }
    };

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-checkpoint-tail",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-checkpoint-tail", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "checkpoint-tail-open", "woo.open.checkpoint_tail.v1", checkpointTail)));

    const projection = await waitForMessage(posted, (message) => isKind(message, "projection"));
    expect(projection).toMatchObject({
      kind: "projection",
      scope: "the_dubspace",
      head,
      projection: {
        kind: "woo.scope_projection.shadow.v1",
        scope: "the_dubspace",
        subject: { id: "the_dubspace" }
      }
    });
    expect(await waitForMessage(posted, (message) => isCheckpointTailOpenStatus(message))).toMatchObject({
      status: {
        connected: true,
        projections: 1,
        projection_rows: checkpointObjects.length + serialized.sessions.length + 3,
        execution_transfers: 0,
        local_execution_ready: false
      }
    });
  });

  it("does not satisfy local TurnKey reads from browser-profile projection rows", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-projection-boundary");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-projection-boundary",
      scope: "the_dubspace",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-projection-boundary",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-projection-boundary"
    });
    const head = relay.commit_scope.head;
    const browserRow: BrowserObjectRow = {
      kind: "woo.browser_object_row.v1",
      id: "the_dubspace",
      scope: "the_dubspace",
      head,
      name: "Display Only Dubspace",
      display: {
        id: "the_dubspace",
        name: "Display Only Dubspace",
        props: { description: "browser-safe display row" }
      },
      contents: []
    };
    const checkpointTail = {
      kind: "woo.open.checkpoint_tail.v1",
      scope: "the_dubspace",
      head,
      transfer: {
        kind: "checkpoint",
        checkpoint: {
          kind: "woo.scope_checkpoint.v1",
          scope: "the_dubspace",
          head,
          checkpoint_hash: "projection-boundary-checkpoint",
          pages: [{
            kind: "woo.projection_page.v1",
            table: "objects",
            page: "objects",
            hash: "projection-boundary-objects",
            rows: [browserRow]
          }],
          frame_tail: []
        }
      },
      viewer: { actor: session.actor, session: session.id }
    };

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-projection-boundary",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-projection-boundary", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "projection-boundary-open", "woo.open.checkpoint_tail.v1", checkpointTail)));

    expect(await waitForMessage(posted, (message) => isCheckpointTailOpenStatus(message))).toMatchObject({
      status: {
        connected: true,
        projections: 1,
        projection_rows: 1,
        execution_transfers: 0,
        local_execution_ready: false
      }
    });

    const sentCursor = socket.sent.length;
    scope.dispatch({
      kind: "call",
      id: "projection-row-boundary",
      route: "sequenced",
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.44],
      persistence: "durable"
    });

    expect(await waitForMessage(posted, (message) => browserMetric(message)?.phase === "local_turn_execution_cache" && browserMetric(message)?.path === "set_control")).toMatchObject({
      metric: {
        phase: "local_turn_execution_cache",
        records: 0,
        count: 0
      }
    });
    expect(await waitForMessage(posted, (message) => browserMetric(message)?.phase === "local_turn_plan" && browserMetric(message)?.path === "set_control")).toMatchObject({
      metric: {
        phase: "local_turn_plan",
        reason: "no_executable_state"
      }
    });
    expect(await waitForMessage(posted, (message) => isLocalTurnFallback(message, "projection-row-boundary"))).toMatchObject({
      kind: "local_turn_fallback",
      id: "projection-row-boundary"
    });
    await sleep(20);
    const sentTypes = socket.sent.slice(sentCursor).map((encoded) => decodeEnvelope(encoded).type);
    expect(sentTypes).not.toContain("woo.turn.exec.request.shadow.v1");
  });

  it("accumulates checkpoint continuation pages before marking checkpoint/tail open ready", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-checkpoint-continuation");
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-checkpoint-continuation",
      scope: "the_dubspace",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-checkpoint-continuation",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-checkpoint-continuation"
    });
    const serialized = world.exportWorld();
    const checkpointObjects = serialized.objects.filter((obj) => obj.id === "the_dubspace" || obj.id === session.actor);
    const head = relay.commit_scope.head;
    const continuation = {
      token: "checkpoint-continuation-token",
      export_id: "checkpoint-continuation-export",
      head,
      checkpoint_hash: "checkpoint-continuation-hash",
      expires_at_ms: Date.now() + 60_000
    };
    const firstChunk = {
      kind: "woo.open.checkpoint_tail.v1",
      scope: "the_dubspace",
      head,
      transfer: {
        kind: "checkpoint",
        checkpoint: {
          kind: "woo.scope_checkpoint.v1",
          scope: "the_dubspace",
          head,
          checkpoint_hash: "checkpoint-continuation-hash",
          pages: [{ kind: "woo.projection_page.v1", table: "objects", page: "000001", hash: "objects", rows: checkpointObjects }],
          frame_tail: []
        },
        continuation
      },
      viewer: { actor: session.actor, session: session.id }
    };
    const finalChunk = {
      kind: "woo.open.checkpoint_tail.v1",
      scope: "the_dubspace",
      head,
      transfer: {
        kind: "checkpoint",
        checkpoint: {
          kind: "woo.scope_checkpoint.v1",
          scope: "the_dubspace",
          head,
          checkpoint_hash: "checkpoint-continuation-hash",
          pages: [
            { kind: "woo.projection_page.v1", table: "sessions", page: "000002", hash: "sessions", rows: serialized.sessions },
            { kind: "woo.projection_page.v1", table: "tombstones", page: "000003", hash: "tombstones", rows: (serialized.tombstones ?? []).map((id) => ({ id })) }
          ],
          frame_tail: []
        }
      },
      viewer: { actor: session.actor, session: session.id }
    };

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-checkpoint-continuation",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-checkpoint-continuation", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    const frameProcessBefore = posted.filter((message) => isBrowserMetricPhase(message, "frame_process")).length;
    socket.receive(encodeEnvelope(relayEnvelope(browser, "checkpoint-continuation-first", "woo.open.checkpoint_tail.v1", firstChunk)));
    await waitFor(() => posted.filter((message) => isBrowserMetricPhase(message, "frame_process")).length >= frameProcessBefore + 1 ? true : undefined);
    expect(posted.some((message) => isKind(message, "projection"))).toBe(false);

    socket.receive(encodeEnvelope(relayEnvelope(browser, "checkpoint-continuation-final", "woo.open.checkpoint_tail.v1", finalChunk)));
    expect(await waitForMessage(posted, (message) => isKind(message, "projection"))).toMatchObject({
      kind: "projection",
      scope: "the_dubspace",
      head,
      projection: {
        kind: "woo.scope_projection.shadow.v1",
        scope: "the_dubspace",
        subject: { id: "the_dubspace" }
      }
    });
  });

  it("posts duplicate accepted frames to the page once per scope sequence", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-dedupe");
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-dedupe",
      scope: "the_pinboard",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-dedupe",
      scope: "the_pinboard",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-dedupe"
    });

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-dedupe",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-dedupe", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));

    const accepted = syntheticAccepted("the_pinboard", 1);
    const transcript = syntheticCheckpointTranscript("the_pinboard", session.actor, session.id, 1);
    const reply = {
      kind: "woo.turn.exec.reply.shadow.v1",
      ok: true,
      id: transcript.id,
      outcome: { result: null },
      transcript,
      commit: accepted
    };

    socket.receive(encodeEnvelope(relayEnvelope(browser, "accepted-dedupe-1", "woo.turn.exec.reply.shadow.v1", reply)));
    await waitForMessage(posted, (message) => isKind(message, "applied_frame"));
    await waitForMessage(posted, (message) => isBrowserMetricPhase(message, "frame_process"));
    await waitForMessage(posted, (message) => isKind(message, "status"));
    posted.length = 0;

    const frameProcessCount = () => posted.filter((message) => isBrowserMetricPhase(message, "frame_process")).length;
    const statusCount = () => posted.filter((message) => isKind(message, "status")).length;

    socket.receive(encodeEnvelope(relayEnvelope(browser, "accepted-dedupe-2", "woo.turn.exec.reply.shadow.v1", reply)));
    await waitFor(() => frameProcessCount() > 0);
    await waitFor(() => statusCount() > 0);
    expect(posted.filter((message) => isKind(message, "applied_frame"))).toHaveLength(0);
    await sleep(100);
  });

  it("installs browser-profile accepted projection writes from direct replies", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-browser-profile");
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-browser-profile",
      scope: "the_dubspace",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-browser-profile",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-browser-profile"
    });

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-browser-profile",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-browser-profile", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));

    const accepted = syntheticAccepted("the_dubspace", 1);
    const row: BrowserObjectRow = {
      kind: "woo.browser_object_row.v1",
      id: "the_dubspace",
      scope: "the_dubspace",
      head: accepted.position,
      name: "Browser Dubspace",
      display: {
        id: "the_dubspace",
        name: "Browser Dubspace",
        props: { description: "browser-safe projection" }
      },
      contents: []
    };
    const writes: ProjectionWrite<BrowserProfile>[] = [{
      table: "objects",
      key: "the_dubspace",
      op: "upsert",
      row,
      bytes: 10
    }];
    const transcript = syntheticCheckpointTranscript("the_dubspace", session.actor, session.id, 1);
    socket.receive(encodeEnvelope(relayEnvelope(browser, "accepted-browser-profile", "woo.turn.exec.reply.shadow.v1", {
      kind: "woo.turn.exec.reply.shadow.v1",
      ok: true,
      id: transcript.id,
      outcome: { result: null },
      transcript,
      commit: {
        ...accepted,
        projection_delta: { objects: [{ key: "the_dubspace", op: "upsert", bytes: 10 }], projection_bytes: 10 },
        projection_writes: writes
      } as unknown as ShadowCommitAccepted
    })));

    expect(await waitForMessage(posted, (message) => isKind(message, "projection"))).toMatchObject({
      kind: "projection",
      scope: "the_dubspace",
      projection: {
        kind: "woo.scope_projection.shadow.v1",
        title: "Browser Dubspace",
        subject: {
          id: "the_dubspace",
          props: { description: "browser-safe projection" }
        }
      }
    });
  });

  it("reads cached state pages for execution cache in one IndexedDB transaction", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-state-page-read");
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-state-page-read",
      scope: "the_dubspace",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-state-page-read",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-state-page-read"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-state-page-read",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-state-page-read", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-state-page-read", opened.transfer.kind, opened.transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-page-read", opened.executable_transfer.kind, opened.executable_transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-state-page-read", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));
    await waitForMessage(posted, (message) => isReadyStatus(message));

    posted.length = 0;
    scope.dispatch({ kind: "cache_status" });
    await waitForMessage(posted, (message) => isReadyStatus(message));

    const statePageReads = posted
      .map(browserMetric)
      .filter((metric): metric is Record<string, unknown> =>
        metric?.phase === "idb_tx" && metric.what === "state_pages" && metric.method === "readonly"
      );
    const cacheReads = statePageReads.filter((metric) => Number(metric.count) > 1);
    expect(cacheReads).toHaveLength(1);
    expect(Number(cacheReads[0]!.count)).toBeGreaterThan(1);
    // One bulk getAll for cached pages plus one count() for the status payload.
    expect(statePageReads).toHaveLength(2);
  });

  it("plans a same-actor durable chain from the tentative journal without waiting for authority", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-journal");
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-journal",
      scope: "the_pinboard",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-journal",
      scope: "the_pinboard",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-journal"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-journal",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-journal", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-journal", opened.transfer.kind, opened.transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-journal", opened.executable_transfer.kind, opened.executable_transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-journal", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));

    scope.dispatch({
      kind: "call",
      id: "pinboard-enter-journal",
      route: "sequenced",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "enter",
      args: [],
      persistence: "durable"
    });
    const enterRequest = await waitForBrowserBuiltExecRequest(browser, socket, "enter");
    expect(enterRequest).toMatchObject({
      type: "woo.turn.exec.request.shadow.v1",
      body: { call: { verb: "enter" } }
    });

    scope.dispatch({
      kind: "call",
      id: "pinboard-add-journal",
      route: "sequenced",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "add_note",
      args: ["journal worker note", "yellow", 48, 48, 180, 110],
      persistence: "durable"
    });
    const addRepairs = { stateTransferRequests: 0 };
    const addRequest = await waitForBrowserBuiltExecRequest(browser, socket, "add_note", addRepairs);
    expect(addRepairs.stateTransferRequests).toBeLessThanOrEqual(1);
    expect(addRequest).toMatchObject({
      type: "woo.turn.exec.request.shadow.v1",
      body: { call: { verb: "add_note" } }
    });
    await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "pinboard-add-journal"));

    socket.receive(encodeEnvelope(await relayReply(browser, encodeEnvelope(enterRequest))));
    await waitForMessage(posted, (message) => isKind(message, "applied_frame"));
    await waitForMessage(posted, (message) => isLocalTurnCommitted(message, "pinboard-enter-journal"));
    socket.receive(encodeEnvelope(await relayReply(browser, encodeEnvelope(addRequest))));
    await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "pinboard-enter-journal"));
    await waitForMessage(posted, (message) => isLocalTurnCommitted(message, "pinboard-add-journal"));
  });

  it("plans a cold outliner add from the tentative journal with one repair", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-outline-journal");
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-outline-journal",
      scope: "the_outline",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-outline-journal",
      scope: "the_outline",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-outline-journal"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-outline-journal",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-outline-journal", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-outline-journal", opened.transfer.kind, opened.transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-outline-journal", opened.executable_transfer.kind, opened.executable_transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-outline-journal", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));

    scope.dispatch({
      kind: "call",
      id: "outline-enter-journal",
      route: "sequenced",
      scope: "the_outline",
      target: "the_outline",
      verb: "enter",
      args: [],
      persistence: "durable"
    });
    await waitForBrowserBuiltExecRequest(browser, socket, "enter");

    scope.dispatch({
      kind: "call",
      id: "outline-add-journal",
      route: "sequenced",
      scope: "the_outline",
      target: "the_outline",
      verb: "add",
      args: ["journal worker outline"],
      persistence: "durable"
    });
    const addRepairs = { stateTransferRequests: 0 };
    const addRequest = await waitForBrowserBuiltExecRequest(browser, socket, "add", addRepairs);
    expect(addRepairs.stateTransferRequests).toBeLessThanOrEqual(1);
    expect(addRequest).toMatchObject({
      type: "woo.turn.exec.request.shadow.v1",
      body: { call: { verb: "add" } }
    });
    await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "outline-add-journal"));
  });

  it("routes read-only live turns to authority before publishing a canonical result", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-live-read");
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-live-read",
      scope: "the_pinboard",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-live-read",
      scope: "the_pinboard",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-live-read"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-live-read",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-live-read", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-live-read", opened.transfer.kind, opened.transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-live-read", opened.executable_transfer.kind, opened.executable_transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-live-read", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));

    // The browser's executable seed was opened from the empty board above.
    // Advance authority afterwards so a local-only list would incorrectly
    // finalize as empty, while the relay can return the durable note.
    const authoritativeText = "authority-only pinboard note";
    const entered = await world.call("seed-live-read-enter", session.id, "the_pinboard", {
      actor: session.actor,
      target: "the_pinboard",
      verb: "enter",
      args: []
    });
    expect(entered.op).toBe("applied");
    const added = await world.call("seed-live-read-note", session.id, "the_pinboard", {
      actor: session.actor,
      target: "the_pinboard",
      verb: "add_note",
      args: [authoritativeText, "yellow", 48, 48, 180, 110]
    });
    expect(added.op).toBe("applied");
    relay.commit_scope = createShadowCommitScope({
      node: relay.node,
      scope: "the_pinboard",
      serialized: world.exportWorld()
    });
    relay.executors.length = 0;
    relay.live_session_serialized.clear();
    relay.serialized_generation++;

    scope.dispatch({
      kind: "call",
      id: "pinboard-enter-before-local-list",
      route: "sequenced",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "enter",
      args: [],
      persistence: "durable"
    });
    await waitForBrowserBuiltExecRequest(browser, socket, "enter");
    const sentAfterEnter = socket.sent.length;

    scope.dispatch({
      kind: "call",
      id: "pinboard-authority-list",
      route: "direct",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "list_notes",
      args: [],
      persistence: "live"
    });

    const listRequest = await waitForBrowserBuiltExecRequest(browser, socket, "list_notes");
    expect(socket.sent.length).toBeGreaterThan(sentAfterEnter);
    expect(listRequest).toMatchObject({
      type: "woo.turn.exec.request.shadow.v1",
      body: { persistence: "live", call: { verb: "list_notes" } }
    });
    const optimisticResult = await waitForMessage(posted, (message) => {
      return isKind(message, "turn_result") &&
        (message as { frame?: { id?: unknown } }).frame?.id === "pinboard-authority-list" &&
        (message as { optimistic?: unknown }).optimistic === true;
    });
    expect(optimisticResult).toMatchObject({
      kind: "turn_result",
      frame: { op: "result", id: "pinboard-authority-list", result: [] },
      optimistic: true
    });
    const planned = await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "pinboard-authority-list"));
    expect(planned).toMatchObject({ result_known: true });
    expect((planned as { local_only?: unknown }).local_only).toBeUndefined();

    socket.receive(encodeEnvelope(await relayReply(browser, encodeEnvelope(listRequest))));
    const authoritativeResult = await waitForMessage(posted, (message) => {
      if (!isKind(message, "turn_result")) return false;
      const candidate = message as { optimistic?: unknown; frame?: { id?: unknown; result?: unknown } };
      return candidate.optimistic !== true &&
        candidate.frame?.id === "pinboard-authority-list" &&
        JSON.stringify(candidate.frame.result).includes(authoritativeText);
    });
    expect(authoritativeResult).toMatchObject({
      kind: "turn_result",
      frame: {
        op: "result",
        id: "pinboard-authority-list",
        result: [expect.objectContaining({ text: authoritativeText })]
      }
    });
  });

  it("keeps the verified executable seed across a full projection overlay reset", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-overlay-reset");
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-overlay-reset",
      scope: "the_pinboard",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-overlay-reset",
      scope: "the_pinboard",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-overlay-reset"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-overlay-reset",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-overlay-reset", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-overlay-reset-open", opened.transfer.kind, opened.transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-overlay-reset-open", opened.executable_transfer.kind, opened.executable_transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-overlay-reset-open", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));
    await waitForMessage(posted, (message) => isReadyStatus(message));

    posted.length = 0;
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-overlay-reset-boundary", opened.transfer.kind, opened.transfer)));
    expect(await waitForMessage(posted, (message) => isStatusWithExecutionTransfers(message, 1))).toMatchObject({
      status: { execution_transfers: 1, local_execution_ready: true }
    });

    scope.dispatch({
      kind: "call",
      id: "overlay-reset-enter",
      route: "sequenced",
      scope: "the_pinboard",
      target: "the_pinboard",
      verb: "enter",
      args: [],
      persistence: "durable"
    });
    await waitForBrowserBuiltExecRequest(browser, socket, "enter");
    expect(await waitForMessage(posted, (message) => isLocalTurnPlanned(message, "overlay-reset-enter"))).toMatchObject({
      kind: "local_turn_planned"
    });
  });

  it("drains out-of-order accepted transcripts into write-cell transfers before later local compose", async () => {
    const posted: unknown[] = [];
    const scope = new FakeWorkerScope();
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("indexedDB", new FakeIndexedDBFactory());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "woo.test" });

    await import("../src/client/v2-browser-worker");

    const world = createWorld();
    const session = world.auth("guest:v2-browser-worker-checkpoint");
    world.setProp("the_dubspace", "operators", [session.actor]);
    const relay = createShadowBrowserRelayShim({
      node: "relay:v2-worker-checkpoint",
      scope: "the_dubspace",
      serialized: world.exportWorld()
    });
    const browser = createShadowBrowserClient({
      node: "browser:v2-worker-checkpoint",
      scope: "the_dubspace",
      actor: session.actor,
      session: session.id,
      relay,
      token: "token:v2-worker-checkpoint"
    });
    const opened = await openShadowBrowserScope(browser);

    scope.dispatch({
      kind: "connect",
      token: "token:v2-worker-checkpoint",
      node: browser.node,
      scope: browser.scope,
      actor: browser.actor,
      session: session.id
    });
    const socket = await waitForSocket();
    socket.open();
    socket.receive(encodeEnvelope(relayEnvelope(browser, "hello-checkpoint", "woo.transport.hello.v1", shadowBrowserTransportHello(browser))));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "transfer-checkpoint", opened.transfer.kind, opened.transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "exec-state-checkpoint", opened.executable_transfer.kind, opened.executable_transfer)));
    socket.receive(encodeEnvelope(relayEnvelope(browser, "ad-checkpoint", "woo.exec_capability_ad.shadow.v1", opened.ads[0])));
    await waitForMessage(posted, (message) => isReadyStatus(message));

    for (const seq of [1, 3]) {
      const accepted = syntheticAccepted("the_dubspace", seq);
      const transcript = syntheticCheckpointTranscript("the_dubspace", session.actor, session.id, seq);
      socket.receive(encodeEnvelope(relayEnvelope(browser, `accepted-checkpoint-${seq}`, "woo.turn.exec.reply.shadow.v1", {
        kind: "woo.turn.exec.reply.shadow.v1",
        ok: true,
        id: transcript.id,
        outcome: { result: null },
        transcript,
        commit: accepted
      })));
    }
    const gapStatusCursor = posted.filter((message) => isKind(message, "status")).length;
    scope.dispatch({ kind: "cache_status" });
    expect(await waitForMessageFrom(posted, gapStatusCursor, (message) =>
      isKind(message, "status") &&
      (message as { status?: { transcript_tail?: unknown } }).status?.transcript_tail === 1
    )).toMatchObject({
      status: {
        transcript_tail: 1
      }
    });

    const accepted2 = syntheticAccepted("the_dubspace", 2);
    const transcript2 = syntheticCheckpointTranscript("the_dubspace", session.actor, session.id, 2);
    socket.receive(encodeEnvelope(relayEnvelope(browser, "accepted-checkpoint-2", "woo.turn.exec.reply.shadow.v1", {
      kind: "woo.turn.exec.reply.shadow.v1",
      ok: true,
      id: transcript2.id,
      outcome: { result: null },
      transcript: transcript2,
      commit: accepted2
    })));

    const promotion = await waitForMessage(posted, (message) =>
      isExecutionPromotionFor(message, "the_dubspace", "accepted_transcript") &&
      (message as { through_seq?: unknown }).through_seq === 3
    );
    expect(promotion).toMatchObject({
      kind: "shadow_browser_execution_promotion",
      scope: "the_dubspace",
      through_seq: 3,
      transcript_count: 1,
      reason: "accepted_transcript"
    });
    const statusCursor = posted.filter((message) => isKind(message, "status")).length;
    scope.dispatch({ kind: "cache_status" });
    expect(await waitFor(() => posted.filter((message) => isKind(message, "status")).slice(statusCursor)[0])).toMatchObject({
      status: {
        transcript_tail: 0
      }
    });

    scope.dispatch({
      kind: "call",
      id: "checkpoint-control-after",
      route: "sequenced",
      scope: "the_dubspace",
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.99],
      persistence: "durable"
    });
    await waitForBrowserBuiltExecRequest(browser, socket, "set_control");
    expect(await waitForMessage(posted, (message) => isComposeViewFor(message, "checkpoint-control-after"))).toMatchObject({
      kind: "shadow_browser_compose_view",
      committed_transcript_count: 0
    });
  });
});

class FakeWorkerScope {
  private readonly listeners: Array<(event: MessageEvent) => void> = [];

  addEventListener(type: "message", listener: (event: MessageEvent) => void): void {
    if (type === "message") this.listeners.push(listener);
  }

  setTimeout(handler: () => void, timeout?: number): ReturnType<typeof setTimeout> {
    return setTimeout(handler, timeout);
  }

  clearTimeout(id: ReturnType<typeof setTimeout>): void {
    clearTimeout(id);
  }

  dispatch(data: unknown): void {
    for (const listener of this.listeners) listener({ data } as MessageEvent);
  }
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  constructor(readonly url: string, readonly protocol: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(encoded: string): void {
    this.sent.push(encoded);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  receive(data: string): void {
    this.emit("message", { data });
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function waitForSocket(): Promise<FakeWebSocket> {
  return await waitFor(() => FakeWebSocket.instances[0]);
}

async function waitForBrowserBuiltExecRequest(
  browser: ReturnType<typeof createShadowBrowserClient>,
  socket: FakeWebSocket,
  verb?: string,
  stats?: { stateTransferRequests: number },
  startCursor = socket.sent.length
): Promise<ShadowEnvelope> {
  let cursor = startCursor;
  for (;;) {
    await waitFor(() => socket.sent[cursor] ? true : undefined);
    const encoded = socket.sent[cursor++];
    const envelope = decodeEnvelope(encoded);
    if (envelope.type === "woo.state.transfer.request.shadow.v1") {
      if (stats) stats.stateTransferRequests++;
      const reply = handleShadowBrowserStateTransferEnvelope(browser, receiveShadowBrowserEnvelopeReceipt(browser, encoded));
      if (!reply) throw new Error("expected state transfer reply");
      socket.receive(encodeEnvelope(reply));
      continue;
    }
    if (verb && (envelope.body as { call?: { verb?: unknown } }).call?.verb !== verb) continue;
    return envelope;
  }
}

async function relayReply(browser: ReturnType<typeof createShadowBrowserClient>, encoded: string): Promise<ShadowEnvelope> {
  const receipt = receiveShadowBrowserEnvelopeReceipt(browser, encoded);
  const reply = await handleShadowBrowserTurnExecEnvelope(browser, receipt);
  if (!reply) throw new Error("expected relay turn reply");
  return reply;
}

function relayEnvelope<T>(
  browser: ReturnType<typeof createShadowBrowserClient>,
  id: string,
  type: string,
  body: T
): ShadowEnvelope<T> {
  return {
    v: 2,
    type,
    id,
    from: browser.relay.node,
    to: browser.node,
    actor: browser.actor,
    ...(browser.session ? { session: browser.session } : {}),
    auth: { mode: "session", token: browser.session_token ?? "" },
    body
  } as ShadowEnvelope<T>;
}

function syntheticAccepted(scope: string, seq: number): ShadowCommitAccepted {
  return {
    kind: "woo.commit.accepted.shadow.v1",
    id: `synthetic-checkpoint-${seq}`,
    position: {
      kind: "woo.scope_head.shadow.v1",
      scope,
      epoch: 1,
      seq,
      hash: `synthetic-head-${seq}`
    },
    receipt: {
      kind: "woo.commit_receipt.shadow.v1",
      id: `synthetic-checkpoint-${seq}`,
      route: "sequenced",
      scope,
      seq,
      transcript_hash: `synthetic-transcript-${seq}`,
      pre_state_hash: `synthetic-pre-${seq}`,
      post_state_hash: `synthetic-post-${seq}`,
      accepted: true,
      errors: []
    },
    transcript_hash: `synthetic-transcript-${seq}`,
    post_state_hash: `synthetic-post-${seq}`,
    observations: []
  };
}

function syntheticCheckpointTranscript(scope: string, actor: string, session: string, seq: number): EffectTranscript {
  const id = `synthetic-checkpoint-${seq}`;
  return {
    kind: "woo.effect_transcript.shadow.v1",
    id,
    route: "sequenced",
    scope,
    seq,
    session,
    call: {
      actor,
      target: scope,
      verb: "checkpoint_marker",
      args: [seq],
      body: undefined
    },
    reads: [],
    writes: [{
      cell: { kind: "prop", object: scope, name: "checkpoint_marker" },
      value: seq,
      op: "set",
      next: `checkpoint-marker:${seq}`
    }],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: `synthetic-transcript-${seq}`
  };
}

function syntheticPropTranscript(
  scope: string,
  actor: string,
  session: string,
  seq: number,
  object: string,
  prop: string,
  value: unknown
): EffectTranscript {
  const base = syntheticCheckpointTranscript(scope, actor, session, seq);
  return {
    ...base,
    call: {
      actor,
      target: scope,
      verb: "synthetic_prop_write",
      args: [object, prop, value],
      body: undefined
    },
    writes: [{
      cell: { kind: "prop", object, name: prop },
      value,
      op: "set",
      next: `synthetic:${object}.${prop}:${seq}`
    }]
  } as EffectTranscript;
}

function syntheticStaleHeadConflict(id: string, scope: string, current: ShadowCommitAccepted["position"]) {
  return {
    kind: "woo.commit.conflict.shadow.v1",
    id,
    scope,
    current,
    reason: "stale_head",
    errors: [`stale_head: current=${current.hash}@${current.seq}`],
    receipt: {
      kind: "woo.commit_receipt.shadow.v1",
      id,
      route: "sequenced",
      scope,
      seq: current.seq + 1,
      transcript_hash: `stale:${id}`,
      pre_state_hash: current.hash,
      post_state_hash: current.hash,
      accepted: false,
      errors: [`stale_head: current=${current.hash}@${current.seq}`]
    }
  };
}

function isKind(message: unknown, kind: string): boolean {
  return Boolean(message && typeof message === "object" && (message as { kind?: unknown }).kind === kind);
}

function isLocalTurnDelegated(message: unknown, id: string): boolean {
  return isKind(message, "local_turn_delegated") && (message as { id?: unknown }).id === id;
}

function isLocalTurnFallback(message: unknown, id: string): boolean {
  return isKind(message, "local_turn_fallback") && (message as { id?: unknown }).id === id;
}

function isLocalTurnPlanned(message: unknown, id: string): boolean {
  return isKind(message, "local_turn_planned") && (message as { id?: unknown }).id === id;
}

function isLocalTurnCommitted(message: unknown, id: string): boolean {
  return isKind(message, "local_turn_committed") &&
    Array.isArray((message as { ids?: unknown }).ids) &&
    ((message as { ids: unknown[] }).ids).includes(id);
}

function isLocalTurnNeedsReplan(message: unknown, id: string): boolean {
  return isKind(message, "local_turn_needs_replan") &&
    Array.isArray((message as { ids?: unknown }).ids) &&
    ((message as { ids: unknown[] }).ids).includes(id);
}

function isOptimisticTurnResult(message: unknown, id: string): boolean {
  return isKind(message, "turn_result") &&
    (message as { optimistic?: unknown }).optimistic === true &&
    (message as { frame?: { id?: unknown } }).frame?.id === id;
}

function isComposeViewFor(message: unknown, id: string): boolean {
  return isKind(message, "shadow_browser_compose_view") && (message as { id?: unknown }).id === id;
}

function isExecutionPromotionFor(message: unknown, scope: string, reason?: string): boolean {
  return isKind(message, "shadow_browser_execution_promotion") &&
    (message as { scope?: unknown }).scope === scope &&
    (reason === undefined || (message as { reason?: unknown }).reason === reason);
}

function isBrowserMetricPhase(message: unknown, phase: string): boolean {
  return isKind(message, "browser_metric") &&
    (message as { metric?: { phase?: unknown } }).metric?.phase === phase;
}

function browserMetric(message: unknown): Record<string, unknown> | undefined {
  if (!isKind(message, "browser_metric")) return undefined;
  const metric = (message as { metric?: unknown }).metric;
  return metric && typeof metric === "object" && !Array.isArray(metric) ? metric as Record<string, unknown> : undefined;
}

function isReadyStatus(message: unknown): boolean {
  return isKind(message, "status") && (message as { status?: { local_execution_ready?: unknown } }).status?.local_execution_ready === true;
}

function isStatusWithExecutionTransfers(message: unknown, count: number): boolean {
  return isKind(message, "status") &&
    (message as { status?: { execution_transfers?: unknown } }).status?.execution_transfers === count;
}

function isCheckpointTailOpenStatus(message: unknown): boolean {
  if (!isKind(message, "status")) return false;
  const status = (message as { status?: { connected?: unknown; projections?: unknown; projection_rows?: unknown; execution_transfers?: unknown } }).status;
  return status?.connected === true &&
    status.projections === 1 &&
    typeof status.projection_rows === "number" &&
    status.projection_rows > 0 &&
    status.execution_transfers === 0;
}

async function waitForMessage(messages: unknown[], predicate: (message: unknown) => boolean): Promise<unknown> {
  return await waitFor(() => messages.find(predicate));
}

async function waitForMessageFrom(messages: unknown[], cursor: number, predicate: (message: unknown) => boolean): Promise<unknown> {
  return await waitFor(() => messages.slice(cursor).find(predicate));
}

async function waitForMessageIndex(messages: unknown[], predicate: (message: unknown) => boolean): Promise<number> {
  return await waitFor(() => {
    const index = messages.findIndex(predicate);
    return index >= 0 ? index : undefined;
  });
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for v2 browser worker integration condition");
    await sleep(5);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
