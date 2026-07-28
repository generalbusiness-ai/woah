import { describe, expect, it } from "vitest";

import {
  isTimeoutDetail,
  smokeMcpTokens,
  SmokeCascadeHalt,
  raceWithAbort
} from "../scripts/smoke-walkthrough";
import {
  dispenserCancelDisposition,
  ensureInChatroom,
  findDispenserFact,
  normalizeDispenserObservation,
  normalizeOutlinerObservation,
  rateLimitRetrySeconds,
  recoverDispenserOrderId,
  waitFor
} from "../scripts/smoke/scenario";
import { SmokeSession, type McpTransport } from "../scripts/smoke/session";

/** A real SmokeSession whose `woo_wait` returns the scripted batches in order
 * (and empty batches thereafter). Using the real session — not a duck-typed
 * stub — is the point: the observation-retention buffer under test lives on
 * SmokeSession, so a stub would prove nothing about it. */
async function scriptedSession(batches: readonly unknown[][]): Promise<SmokeSession> {
  let next = 0;
  const transport: McpTransport = async (request) => {
    const body = request.body ? JSON.parse(String(request.body)) : {};
    if (body.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-06-18", instructions: "You are woo actor scripted_bob." }
      }, { headers: { "mcp-session-id": "s_net-api-0_scripted" } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/call" && body.params?.name === "woo_wait") {
      const batch = batches[next] ?? [];
      next += 1;
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { structuredContent: { result: { observations: batch, gap: false } } }
      });
    }
    throw new Error(`unexpected MCP call ${JSON.stringify(body).slice(0, 200)}`);
  };
  return await SmokeSession.open(transport, { token: "apikey:key:secret", label: "bob", clientName: "retention-test" });
}

describe("smoke walkthrough harness", () => {
  it("uses the authenticated Net actor from initialize without probing removed native tools", async () => {
    const methods: string[] = [];
    const transport: McpTransport = async (request) => {
      const body = request.body ? JSON.parse(String(request.body)) : {};
      methods.push(body.method);
      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-06-18",
            instructions: "You are woo actor carried_alice. Dynamic tools follow your context."
          }
        }, { headers: { "mcp-session-id": "s_net-api-0_walkthrough" } });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      throw new Error(`unexpected MCP method ${String(body.method)}`);
    };

    const session = await SmokeSession.open(transport, {
      token: "apikey:key:secret",
      label: "alice",
      clientName: "smoke-session-test"
    });

    expect(session.actor).toBe("carried_alice");
    expect(methods).toEqual(["initialize", "notifications/initialized"]);
  });

  it("requires two explicit API keys for the deployed Net MCP walkthrough", () => {
    expect(smokeMcpTokens({
      WOO_SMOKE_ALICE_APIKEY: "apikey:alice:secret-a",
      WOO_SMOKE_BOB_APIKEY: "apikey:bob:secret-b"
    })).toEqual({
      alice: "apikey:alice:secret-a",
      bob: "apikey:bob:secret-b"
    });
    expect(() => smokeMcpTokens({})).toThrow("WOO_SMOKE_ALICE_APIKEY");
    expect(() => smokeMcpTokens({
      WOO_SMOKE_ALICE_APIKEY: "session:s_alice",
      WOO_SMOKE_BOB_APIKEY: "apikey:bob:secret-b"
    })).toThrow("apikey:<id>:<secret>");
  });

  it("routes a persistent taskboard actor back to the chatroom through public exits", async () => {
    const calls: string[] = [];
    const sessionStub: {
      currentRoom: string | null;
      label: string;
      callTool(): Promise<unknown>;
      call(object: string, verb: string, args: string[]): Promise<unknown>;
    } = {
      currentRoom: null,
      label: "bob",
      async callTool(): Promise<unknown> {
        return {
          result: {
            structuredContent: {
              result: {
                active_scope: "the_taskboard",
                tools: [
                  { object: "the_taskboard", verb: "look" },
                  { object: "the_taskboard", verb: "go" }
                ]
              }
            }
          }
        };
      },
      async call(object: string, verb: string, args: string[]): Promise<unknown> {
        calls.push(`${object}:${verb}:${args[0]}`);
        const next =
          object === "the_taskboard" ? "the_garden" :
          object === "the_garden" ? "the_deck" :
          "the_chatroom";
        sessionStub.currentRoom = next;
        return { room: next };
      }
    };
    const session = sessionStub as unknown as SmokeSession;

    await ensureInChatroom(session);

    expect(calls).toEqual([
      "the_taskboard:go:out",
      "the_garden:go:north",
      "the_deck:go:west"
    ]);
    expect(session.currentRoom).toBe("the_chatroom");
  });

  it("fails closed when the reachable surface does not identify one current room", async () => {
    const session = {
      currentRoom: null,
      label: "bob",
      async callTool(): Promise<unknown> {
        return { result: { structuredContent: { result: { tools: [] } } } };
      }
    } as unknown as SmokeSession;

    await expect(ensureInChatroom(session)).rejects.toThrow("active_scope=null");
  });

  it("normalizes both allowed Outliner rolling-upgrade observation shapes", () => {
    expect(normalizeOutlinerObservation({
      type: "outline_item_added",
      version: 1,
      payload: { item: "item_1", parent_id: null, index: 2 },
      source: "the_outline"
    })).toEqual({
      mode: "act",
      fact: { item: "item_1", parent_id: null, index: 2 }
    });
    const legacy = {
      type: "outline_item_added",
      item: "item_1",
      parent_id: null,
      index: 2,
      text: "legacy prose",
      source: "the_outline"
    };
    expect(normalizeOutlinerObservation(legacy)).toEqual({ mode: "legacy", fact: legacy });
  });

  it("does not reinterpret malformed Act envelopes as legacy observations", () => {
    expect(normalizeOutlinerObservation({
      type: "outline_item_added",
      version: 2,
      payload: { item: "item_1" }
    })).toBeNull();
    expect(normalizeOutlinerObservation({
      type: "outline_item_added",
      version: 1,
      item: "item_1"
    })).toBeNull();
    expect(normalizeOutlinerObservation({ type: "said", item: "item_1" })).toBeNull();
  });

  it("normalizes both allowed dispenser rolling-upgrade observation shapes", () => {
    expect(normalizeDispenserObservation({
      type: "dispenser.ordered",
      version: 1,
      payload: { order_id: "ord_9", request: "walkthrough", artifact: "o_note" },
      source: "the_horoscope"
    }, "ordered", "the_horoscope")).toEqual({ mode: "act", orderId: "ord_9", note: null });
    expect(normalizeDispenserObservation({
      type: "dispenser.canceled",
      version: 1,
      payload: { order_id: "ord_9" },
      source: "the_horoscope"
    }, "canceled", "the_horoscope")).toEqual({ mode: "act", orderId: "ord_9", note: null });
    // Pre-Acts flat shapes from an aged installed catalog page.
    expect(normalizeDispenserObservation({
      type: "order_placed",
      block: "the_horoscope",
      order_id: "ord_9",
      requester: "guest_a"
    }, "ordered", "the_horoscope")).toEqual({ mode: "legacy", orderId: "ord_9", note: null });
    expect(normalizeDispenserObservation({
      type: "canceled",
      block: "the_horoscope",
      order_id: "ord_9"
    }, "canceled", "the_horoscope")).toEqual({ mode: "legacy", orderId: "ord_9", note: null });
  });

  it("does not match malformed dispenser Acts or another block's observations", () => {
    // A partial Act envelope never falls back to legacy.
    expect(normalizeDispenserObservation({
      type: "dispenser.ordered",
      version: 2,
      payload: { order_id: "ord_9" },
      source: "the_horoscope"
    }, "ordered", "the_horoscope")).toBeNull();
    expect(normalizeDispenserObservation({
      type: "dispenser.ordered",
      version: 1,
      order_id: "ord_9",
      source: "the_horoscope"
    }, "ordered", "the_horoscope")).toBeNull();
    // Both shapes must name the emitting block: the legacy `canceled` type is a
    // generic word and must not match another catalog's observation.
    expect(normalizeDispenserObservation({
      type: "dispenser.ordered",
      version: 1,
      payload: { order_id: "ord_9" },
      source: "other_block"
    }, "ordered", "the_horoscope")).toBeNull();
    expect(normalizeDispenserObservation({
      type: "canceled",
      order_id: "ord_9"
    }, "canceled", "the_horoscope")).toBeNull();
  });

  it("recognizes a delivered fact, with its note ref, in both rolling-contract shapes", () => {
    expect(normalizeDispenserObservation({
      type: "dispenser.delivered",
      version: 1,
      payload: { order_id: "ord_9", note: "o_note" },
      source: "the_horoscope"
    }, "delivered", "the_horoscope")).toEqual({ mode: "act", orderId: "ord_9", note: "o_note" });
    expect(normalizeDispenserObservation({
      type: "delivered",
      block: "the_horoscope",
      order_id: "ord_9",
      note: "o_note"
    }, "delivered", "the_horoscope")).toEqual({ mode: "legacy", orderId: "ord_9", note: "o_note" });
    expect(normalizeDispenserObservation({
      type: "delivered",
      order_id: "ord_9"
    }, "delivered", "the_horoscope")).toBeNull();
  });

  it("finds a terminal fact from an accepted set and names the actual outcome", () => {
    const canceledFact = { type: "dispenser.canceled", version: 1, payload: { order_id: "ord_9" }, source: "the_horoscope" };
    const deliveredFact = { type: "delivered", block: "the_horoscope", order_id: "ord_9", note: "o_note" };
    // A settled race accepts either kind and learns which one arrived.
    expect(findDispenserFact(canceledFact, ["canceled", "delivered"], "the_horoscope", "ord_9"))
      .toEqual({ kind: "canceled", note: null });
    expect(findDispenserFact(deliveredFact, ["canceled", "delivered"], "the_horoscope", "ord_9"))
      .toEqual({ kind: "delivered", note: "o_note" });
    // A different order's fact never matches.
    expect(findDispenserFact(canceledFact, ["canceled", "delivered"], "the_horoscope", "ord_8")).toBeNull();
  });

  it("classifies cancel replies for an order this run just placed", () => {
    // Normal cancellation.
    expect(dispenserCancelDisposition({ order_id: "ord_9", canceled: true, duplicate: false })).toBe("canceled");
    // v1 lost race: the plug delivered before the cancel committed.
    expect(dispenserCancelDisposition({ order_id: "ord_9", canceled: false, duplicate: true, reason: "delivered" })).toBe("delivered");
    // Pre-Acts settled race: the row is gone, but that page deletes it both
    // for plug delivery AND plug cancel (prepare_artifact E_VERBNFs there and
    // the plug cancels as permanent) — so it is only "raced", never assumed
    // delivered; the caller accepts either terminal fact.
    expect(dispenserCancelDisposition({ order_id: "ord_9", canceled: false, reason: "not_pending" })).toBe("raced");
    // A genuinely unknown order is a real failure, not a race.
    expect(dispenserCancelDisposition({ order_id: "ord_9", canceled: false, duplicate: false, reason: "unknown" })).toBeNull();
    expect(dispenserCancelDisposition("nope")).toBeNull();
  });

  it("recovers a lost order id from the ordered fact by unique request", async () => {
    // `takeRetainedObservations` is part of the contract recoverDispenserOrderId
    // now uses: a failed assertion leaves the ordered fact in the retention
    // buffer, and the leak guard must look there before spending polls.
    const makeSession = (
      batches: unknown[][],
      retained: Record<string, any>[] = []
    ): { label: string; calls: number; callTool(): Promise<unknown>; takeRetainedObservations(): Record<string, any>[] } => ({
      label: "alice",
      calls: 0,
      takeRetainedObservations(): Record<string, any>[] {
        const held = retained.slice();
        retained.length = 0;
        return held;
      },
      async callTool(): Promise<unknown> {
        const batch = batches[this.calls] ?? [];
        this.calls += 1;
        return { result: { structuredContent: { result: { observations: batch } } } };
      }
    });
    const cfg = { drainBudgetMs: 100, drainPollMs: 10 };

    const hit = makeSession([[
      { type: "said", text: "noise" },
      { type: "dispenser.ordered", version: 1, payload: { order_id: "ord_7", request: "walkthrough-order-run1", artifact: "o_a" }, source: "the_horoscope" }
    ]]);
    await expect(recoverDispenserOrderId([hit as any], "walkthrough-order-run1", cfg)).resolves.toBe("ord_7");

    // A different run's order never matches; an erroring session is skipped.
    const miss = makeSession([[
      { type: "order_placed", block: "the_horoscope", order_id: "ord_6", request: "walkthrough-order-run0" }
    ]]);
    const broken = {
      label: "bob",
      takeRetainedObservations: (): Record<string, any>[] => [],
      async callTool(): Promise<unknown> { throw new Error("session reset"); }
    };
    await expect(recoverDispenserOrderId([broken as any, miss as any], "walkthrough-order-run1", cfg)).resolves.toBeNull();

    // The retained-buffer path: the fact never comes back from a poll (every
    // batch is empty), so recovery can only succeed by reading what a failed
    // assertion already consumed.
    const held = makeSession([[], [], []], [
      { type: "order_placed", block: "the_horoscope", order_id: "ord_8", request: "walkthrough-order-run2" }
    ]);
    await expect(recoverDispenserOrderId([held as any], "walkthrough-order-run2", cfg)).resolves.toBe("ord_8");
  });

  // Deployed-lane regression (defect: "dispenser: order reaches peer ..." failed
  // deterministically on a WARM prod gateway while every other cross-actor step
  // passed). `woo_wait` is at-most-once: a drained batch is gone from the
  // gateway queue. When the ordered and terminal dispenser facts commit close
  // enough together, the warm gateway returns BOTH in one reply — verified on
  // https://woah1.generalbusiness.ai, where the verbose run logged
  // "[bob] received 2 obs: order_placed,canceled" and the very next assertion
  // reported "saw no observations". The old waitFor matched the first row and
  // threw the rest of the batch away.
  it("retains the rest of a woo_wait batch so a following assertion can still see it", async () => {
    const cfg = { drainBudgetMs: 100, drainPollMs: 10 };
    const ordered = { type: "order_placed", block: "the_horoscope", order_id: "ord_9", request: "walkthrough-order-runX" };
    const canceled = { type: "canceled", block: "the_horoscope", order_id: "ord_9" };
    // ONE batch carrying both facts, then nothing — exactly the warm-gateway
    // shape. Any further poll returns empty, so a lost `canceled` can only
    // time out.
    const session = await scriptedSession([[ordered, canceled]]);

    const first = await waitFor(
      session,
      (obs) => findDispenserFact(obs, ["ordered"], "the_horoscope", "ord_9") !== null,
      1000,
      undefined,
      cfg
    );
    expect(first).toMatchObject({ type: "order_placed", order_id: "ord_9" });

    const terminal = await waitFor(
      session,
      (obs) => findDispenserFact(obs, ["canceled", "delivered"], "the_horoscope", "ord_9") !== null,
      1000,
      undefined,
      cfg
    );
    expect(terminal).toMatchObject({ type: "canceled", order_id: "ord_9" });
  });

  it("keeps unmatched rows in arrival order across several waits, and drops them on drain", async () => {
    const cfg = { drainBudgetMs: 100, drainPollMs: 10 };
    const said = { type: "said", actor: "guest_1", text: "hello" };
    const entered = { type: "entered", actor: "guest_1", room: "the_deck" };
    const taken = { type: "taken", actor: "guest_1", object: "the_mug" };
    // A single batch delivering three unrelated facts. Asserting them in an
    // order DIFFERENT from arrival order proves rows before the match survive
    // too, not just the tail of the batch.
    const session = await scriptedSession([[said, entered, taken]]);

    expect(await waitFor(session, (o) => o.type === "taken", 1000, undefined, cfg)).toMatchObject({ type: "taken" });
    expect(await waitFor(session, (o) => o.type === "said", 1000, undefined, cfg)).toMatchObject({ type: "said" });
    expect(await waitFor(session, (o) => o.type === "entered", 1000, undefined, cfg)).toMatchObject({ type: "entered" });

    // Retention must not outlive a drain: "everything before now is stale"
    // has to cover rows the client is holding, or a later step could be
    // satisfied by an earlier step's observation.
    const stale = await scriptedSession([[said], []]);
    await expect(waitFor(stale, (o) => o.type === "entered", 50, undefined, cfg))
      .rejects.toThrow(/waiting for matching observation/);
    stale.clearRetainedObservations();
    expect(stale.takeRetainedObservations()).toEqual([]);
  });

  it("parses the admission-window wait only out of E_RATE_LIMIT refusals", () => {
    expect(rateLimitRetrySeconds(
      'MCP tool error: {"code":"E_RATE_LIMIT","message":"too many orders from this requester; try again later",' +
      '"value":{"retry_in_seconds":12.3,"scope":"requester","rate_limit_seconds":60}}'
    )).toBe(13);
    // A rate refusal with an unparseable detail still gets the demo default.
    expect(rateLimitRetrySeconds('MCP tool error: {"code":"E_RATE_LIMIT","message":"cooldown"}')).toBe(60);
    // Non-rate errors are not retried.
    expect(rateLimitRetrySeconds('MCP tool error: {"code":"E_QUEUE_FULL","message":"too many pending orders"}')).toBeNull();
    expect(rateLimitRetrySeconds("I don't see \"mug\" here.")).toBeNull();
  });

  it("aborts the in-flight step body when the watchdog fires", async () => {
    let observedAbort = false;
    const startedAt = Date.now();

    await expect(raceWithAbort(async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        }, { once: true });
      });
    }, 10, "step deadline")).rejects.toThrow("step deadline");

    expect(observedAbort).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("does not abort work that finishes before the watchdog", async () => {
    let observedAbort = false;

    const result = await raceWithAbort(async (signal) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
      }, { once: true });
      return 42;
    }, 1000, "step deadline");

    expect(result).toBe(42);
    expect(observedAbort).toBe(false);
  });

  it("classifies gateway-saturation timeouts but not real protocol errors", () => {
    // These are the failure messages that should drive the cascade halt: a
    // saturated gateway times out the MCP POST, the per-RPC deadline, or the
    // step watchdog.
    expect(isTimeoutDetail("MCP POST https://woah1.generalbusiness.ai/mcp timed out after 20000ms")).toBe(true);
    expect(isTimeoutDetail("MCP request exceeded 20000ms deadline")).toBe(true);
    expect(isTimeoutDetail('step "enter:chatroom" exceeded 60000ms watchdog')).toBe(true);

    // Real protocol / content failures must NOT count — they are genuine
    // assertion failures, not gateway saturation, and should be reported
    // individually rather than triggering a halt. In particular a waitFor
    // "timeout after Nms waiting for matching observation" is a fanout/delivery
    // gap (the call succeeded; the expected observation never arrived), so it
    // must not be misread as a saturation timeout.
    expect(isTimeoutDetail("timeout after 5000ms waiting for matching observation")).toBe(false);
    expect(isTimeoutDetail('I don\'t see "mug" here.')).toBe(false);
    expect(isTimeoutDetail("reachable MCP tool not found: the_outline:add_item")).toBe(false);
    expect(isTimeoutDetail("MCP session not found; reinitialize")).toBe(false);
    expect(isTimeoutDetail(undefined)).toBe(false);
  });

  it("carries the consecutive-timeout count on the cascade-halt error", () => {
    const halt = new SmokeCascadeHalt(2);
    expect(halt).toBeInstanceOf(Error);
    expect(halt.name).toBe("SmokeCascadeHalt");
    expect(halt.count).toBe(2);
    expect(halt.message).toContain("2 consecutive timeout-class failures");
  });
});
