// Shared smoke scenario — the ordered two-actor cross-actor walkthrough,
// expressed ONCE and run by every lane. Each step asserts that an observation
// emitted by one actor lands in the other's MCP wait queue (or that a verb
// reply carries the expected shape). This is the cross-actor coverage the
// narrow single-call smoke does not provide: cross-scope moves, take/drop
// fanout, pinboard/outliner/tasks tool-space collaboration, and the dispenser
// order/cancel round on the_horoscope.
//
// The scenario is driver-agnostic: it operates on a mutable `SmokeSessionPair`
// and an injected `step` runner. The runner owns lane-specific policy — the
// deployed lane records results, resets sessions, and halts on a timeout
// cascade; the in-process fake lane simply throws to fail the vitest case. The
// scenario reads `pair.alice`/`pair.bob` fresh inside each step so a session
// reset between steps is transparent here.
//
// Four flags select the small differences between lanes:
//   - includeTakeDrop: the same-room mug take/drop step. ON for the deployed
//     and workerd lanes; OFF for the dangling-ref-gated fake lane (a take on a
//     $portable object emits dangling_parent_ref until $portable lineage reaches
//     the gateway-shard slice — see cf-local-walkthrough.test.ts).
//   - includeConcurrentMove: the B6 concurrent-through-shared-destination step.
//     ON for the fake lane (it pairs with that lane's coherence-invariant
//     ratchet); optional elsewhere.
//   - includeCarryAcrossRooms: C3 gate — take a $portable in room A, move to
//     room B, invoke a verb on it (testing the object's class lineage resolves
//     in the new scope), peer in room B sees the dropped item. This step passes
//     in the fake lane (single world image) but FAILS in cf-dev and deployed
//     until A2 (lineage-closed row installation) lands. TRACKED → A2.
//   - includeToolSurfaceAfterMove: C3 gate — after moving from chatroom to
//     the_deck and entering the_pinboard, assert add_note is reachable from the
//     new scope. The verb-on-carried-object test covers the lineage side; this
//     one covers the tool-surface enumeration side. TRACKED → A2.

import { isRecord, SmokeSession, waitObservationsOf } from "./session";

export type SmokeSessionPair = { alice: SmokeSession; bob: SmokeSession };

export type StepContext = { signal?: AbortSignal };

// A lane-provided step runner. It must run `body` (giving it a per-step signal
// when it enforces a watchdog) and decide what a failure means for the run.
export type StepRunner = (name: string, body: (ctx: StepContext) => Promise<void>) => Promise<void>;

export type SmokeScenarioOptions = {
  // Unique suffix for observation payloads so reruns never match stale events.
  runId: string;
  includeTakeDrop?: boolean;
  includeConcurrentMove?: boolean;
  // C3 gates — carry an object across a room boundary and verify the object's
  // class lineage is usable in the new scope. PASS in fake lane (shared world
  // image), FAIL in cf-dev/deployed until A2 (lineage-closed row installation).
  // See notes/2026-06-09-c2c3-gates-scenario.md for the per-lane status.
  includeCarryAcrossRooms?: boolean;
  // C3 gate — assert that the pinboard's add_note tool is reachable after
  // moving to the_deck from the_chatroom. Exercises the tool-surface
  // enumeration path that cross-scope lineage gaps break in cf-dev/deployed.
  // PASS in fake lane; FAIL in cf-dev/deployed until A2 lands. TRACKED → A2.
  includeToolSurfaceAfterMove?: boolean;
  // Dispenser step tuning. The deployed lane has a live competing consumer —
  // the production horoscope plug drains the same queue on a cron AND receives
  // a synchronous wakeup hint from `:order` — and runs each step under a
  // watchdog. Fresh-world lanes (workerd, fake) have neither, so they keep the
  // strict deterministic assertions.
  dispenserCompetingConsumer?: boolean;
  // Ceiling for the one bounded E_RATE_LIMIT admission wait. The lane runner
  // owns this policy because it knows its own step watchdog; the scenario
  // default covers the demo block's 60s requester window.
  dispenserAdmissionWaitMs?: number;
  // Per-assertion wait budget (the cross-actor fanout settle window).
  waitTimeoutMs?: number;
  drainBudgetMs?: number;
  drainPollMs?: number;
  // Optional verbose sink (received/drained observation types).
  log?: (message: string) => void;
};

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_DRAIN_BUDGET_MS = 3000;
const DEFAULT_DRAIN_POLL_MS = 500;

export async function runSmokeWalkthrough(
  pair: SmokeSessionPair,
  step: StepRunner,
  options: SmokeScenarioOptions
): Promise<void> {
  const runId = options.runId;
  const waitMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const cfg = {
    drainBudgetMs: options.drainBudgetMs ?? DEFAULT_DRAIN_BUDGET_MS,
    drainPollMs: options.drainPollMs ?? DEFAULT_DRAIN_POLL_MS,
    log: options.log
  };

  // API-key actors persist between deployed runs. Establish the common start
  // room whether this is their first run or they already occupy the chatroom.
  await step("enter:chatroom (alice)", async (ctx) => {
    await ensureInChatroom(pair.alice, ctx.signal);
  });
  await step("enter:chatroom (bob)", async (ctx) => {
    await ensureInChatroom(pair.bob, ctx.signal);
  });
  await drain(pair.alice, cfg);
  await drain(pair.bob, cfg);

  // Same-scope durable verb. A regression here means the whole cross-actor path
  // is broken, so it stays the baseline.
  await step("chat:say reaches peer", async (ctx) => {
    const { alice, bob } = pair;
    const text = `walkthrough-say-${runId}`;
    await alice.call("the_chatroom", "say", [text], ctx.signal);
    await waitFor(bob, (obs) => obs.type === "said" && typeof obs.text === "string" && obs.text.includes(text), waitMs, ctx.signal, cfg);
  });

  // CO2.5 / §M4.2 — the OBSERVATION-ONLY half of retry safety, over the real
  // transport. `say` is `persistence:"live"`: it writes no authority cell, so
  // the scope classifies it as a pure read and would not cache it. A retry
  // therefore used to re-emit the line to every peer. What proves the fix is
  // the PEER's queue, which is why this step needs both actors — and why it
  // runs in the chatroom, immediately after the `chat:say reaches peer`
  // baseline: both actors are provably co-present there and that step
  // already establishes that one `say` reaches the peer exactly once.
  //
  // Room choice is load-bearing, and this cost a red run to learn: counting
  // `said` rows is only a proxy for "how many times did it execute" in a
  // room that emits ONE row per utterance. At `the_pinboard` a single say
  // emits TWO — same actor, same text, same `ts`, sources `the_pinboard` and
  // `the_deck` — because a tool space relays speech to the room it is
  // mounted in. That is one execution with two observations, by design, and
  // an assertion placed there fails while the mechanism is working.
  await step("retry safety: an observation-only act reaches the peer exactly once", async (ctx) => {
    const { alice, bob } = pair;
    const text = `walkthrough-idem-say-${runId}`;
    const args = { object: "the_chatroom", verb: "say", args: [text], operation_id: `smoke-idem-say-${runId}` };
    const first = await alice.callTool("woo_call", args, { signal: ctx.signal });
    if (first?.result?.isError) {
      throw new Error(`say refused: ${JSON.stringify(first?.result?.structuredContent).slice(0, 300)}`);
    }
    // Consume the first copy before retrying, so anything the peer sees
    // afterwards is unambiguously a SECOND emission.
    await waitFor(bob, (obs) =>
      obs.type === "said" && typeof obs.text === "string" && obs.text.includes(text),
    waitMs, ctx.signal, cfg);

    const retry = await alice.callTool("woo_call", args, { signal: ctx.signal });
    const retryBody = retry?.result?.structuredContent;
    if (retryBody?.replayed !== true) {
      throw new Error(`the retry was NOT deduplicated: ${JSON.stringify(retryBody).slice(0, 300)}`);
    }
    // Give a genuine second emission time to arrive before declaring none.
    await abortableDelay(750, ctx.signal);
    const echoes: Record<string, any>[] = [];
    try {
      echoes.push(await waitFor(bob, (obs) =>
        obs.type === "said" && typeof obs.text === "string" && obs.text.includes(text),
      750, ctx.signal, cfg));
    } catch {
      // A timeout here is the PASS: the peer heard the line only once.
    }
    if (echoes.length > 0) {
      throw new Error(`the peer heard the line twice — the retry re-emitted it: ${JSON.stringify(echoes[0]).slice(0, 300)}`);
    }
  });

  // B6 / CA14.3: two actors moving through the same destination concurrently
  // must both commit independently (each at its own actor-location authority,
  // off the room sequencer) and both retain membership — no lost destination
  // membership, no read_version_mismatch. Membership is intact iff each actor's
  // utterance reaches the other after the round trip.
  if (options.includeConcurrentMove) {
    await step("B6: concurrent move through shared destination keeps both memberships", async (ctx) => {
      const { alice, bob } = pair;
      await Promise.all([
        alice.call("the_chatroom", "southeast", [], ctx.signal),
        bob.call("the_chatroom", "southeast", [], ctx.signal)
      ]);
      await drain(alice, cfg);
      await drain(bob, cfg);
      const aliceAfterOut: string | null = alice.currentRoom;
      const bobAfterOut: string | null = bob.currentRoom;
      if (aliceAfterOut !== "the_deck" || bobAfterOut !== "the_deck") {
        throw new Error(`expected both on the_deck after concurrent move; alice=${aliceAfterOut} bob=${bobAfterOut}`);
      }
      await Promise.all([
        alice.call("the_deck", "west", [], ctx.signal),
        bob.call("the_deck", "west", [], ctx.signal)
      ]);
      await drain(alice, cfg);
      await drain(bob, cfg);
      const aliceBack: string | null = alice.currentRoom;
      const bobBack: string | null = bob.currentRoom;
      if (aliceBack !== "the_chatroom" || bobBack !== "the_chatroom") {
        throw new Error(`expected both back in the_chatroom; alice=${aliceBack} bob=${bobBack}`);
      }
      const aliceText = `b6-concurrent-alice-${runId}`;
      await alice.call("the_chatroom", "say", [aliceText], ctx.signal);
      await waitFor(bob, (obs) => obs.type === "said" && typeof obs.text === "string" && obs.text.includes(aliceText), waitMs, ctx.signal, cfg);
      const bobText = `b6-concurrent-bob-${runId}`;
      await bob.call("the_chatroom", "say", [bobText], ctx.signal);
      await waitFor(alice, (obs) => obs.type === "said" && typeof obs.text === "string" && obs.text.includes(bobText), waitMs, ctx.signal, cfg);
    });
  }

  // Cross-scope move out. Alice leaves the_chatroom for the_deck; Bob (still in
  // the_chatroom) must receive a `left`. Source side of the move — same scope as
  // the commit. The predicate pins the exact `left` from this move so a stale
  // departure from earlier navigation cannot satisfy it.
  await step("move:southeast emits `left` to bob (origin room)", async (ctx) => {
    const { alice, bob } = pair;
    await alice.call("the_chatroom", "southeast", [], ctx.signal);
    await waitFor(bob, (obs) =>
      obs.type === "left" &&
      obs.actor === alice.actor &&
      obs.source === "the_chatroom" &&
      obs.destination === "the_deck" &&
      obs.exit === "southeast",
    waitMs, ctx.signal, cfg);
  });

  // The other side: alice (now in the_deck, her commit scope) moves back to
  // the_chatroom. The commit happens in the_deck; bob's session is still in
  // the_chatroom. The gateway-owned commit fan-out across affected scopes is
  // what makes this destination-side delivery work.
  await step("move:west emits `entered` to bob (destination room)", async (ctx) => {
    const { alice, bob } = pair;
    await alice.call("the_deck", "west", [], ctx.signal);
    await waitFor(bob, (obs) =>
      obs.type === "entered" &&
      obs.actor === alice.actor &&
      obs.source === "the_chatroom" &&
      obs.origin === "the_deck" &&
      obs.exit === "west",
    waitMs, ctx.signal, cfg);
  });

  // take/drop with cross-actor fanout: alice takes the mug, then drops it; bob,
  // co-located in the_chatroom, must see both `taken` and `dropped` (the actor
  // is excluded from those room broadcasts, so a peer is the right observer).
  // Idempotent: the mug is taken from and dropped back into its home room and
  // neither actor moves, so reruns keep finding it here. Deliberately SAME-ROOM
  // — carrying an item across a boundary is not yet on the distributed path.
  if (options.includeTakeDrop) {
    await step("take/drop: alice takes then drops the mug; bob in the room sees `taken` and `dropped`", async (ctx) => {
      const { alice, bob } = pair;
      await alice.call("the_chatroom", "take", ["mug"], ctx.signal);
      await waitFor(bob, (obs) =>
        obs.type === "taken" && obs.actor === alice.actor && obs.item === "the_mug",
      waitMs, ctx.signal, cfg);
      await drain(bob, cfg, ctx.signal);
      await alice.call("the_chatroom", "drop", ["mug"], ctx.signal);
      await waitFor(bob, (obs) =>
        obs.type === "dropped" &&
        obs.actor === alice.actor &&
        obs.item === "the_mug" &&
        obs.room === "the_chatroom",
      waitMs, ctx.signal, cfg);
      await drain(alice, cfg, ctx.signal);
      await drain(bob, cfg, ctx.signal);
    });
  }

  // C3 gate: carry-across-rooms. Alice takes the mug from the_chatroom,
  // moves southeast to the_deck (carrying it), and invokes `read` on it.
  // `read` is defined on $note (note catalog) and is direct_callable — its
  // execution requires the class lineage ($note → $portable → $thing → $root)
  // to be present in the gateway shard's relay for the_deck.
  //
  // A2 gate: `read` must succeed. Without A2, the gateway shard's relay for
  // the_deck lacks $note/$portable lineage, causing E_VERBNF during the verb
  // dispatch (the relay's parentWalkLookup returns null). With A2
  // (mergeIncomingObjectLineageClosure), the lineage is pre-delivered to the
  // deck relay before the delta frame, so the read succeeds.
  //
  // WHY NOT DROP AT THE DECK: `the_deck:drop ["mug"]` uses `match_object("mug",
  // actor)` which looks up alice's contents in the planning relay snapshot. The
  // deck relay does NOT track alice's inventory (the take committed at the
  // chatroom scope, and the fanout only reaches scopes whose owners are spaces;
  // an actor-as-destination is not a space and receives no fanout). The drop
  // therefore fails with E_INVARG "not carrying mug" at the planning step —
  // this is a separate live-state gap, NOT the lineage gap A2 fixes. To avoid
  // conflating the two issues, we restore by walking alice back to chatroom
  // (still holding the mug) and dropping there, where the chatroom relay has
  // accurate alice.contents from the take commit.
  //
  // This step intentionally replaces the deliberate omission at scenario.ts
  // line ~160 ("Deliberately SAME-ROOM — carrying an item across a boundary
  // is not yet on the distributed path") that was hiding face #2 from every
  // pre-deploy lane. See notes/2026-06-09-cf-cross-scope-architecture-plan.md §A2.
  if (options.includeCarryAcrossRooms) {
    await step("carry-across-rooms: alice takes mug, moves to deck, reads it", async (ctx) => {
      const { alice, bob } = pair;
      // Precondition: alice in the_chatroom. Guard against prior steps leaving
      // her elsewhere — leaveIfIn + westward walk cover the common tail states.
      await alice.leaveIfIn("the_pinboard", ctx.signal);
      await alice.leaveIfIn("the_outline", ctx.signal);
      if (alice.currentRoom === "the_deck") await alice.call("the_deck", "west", [], ctx.signal);
      await drain(alice, cfg, ctx.signal);
      if (alice.currentRoom !== "the_chatroom") {
        throw new Error(`carry-across-rooms: alice expected in the_chatroom; at=${alice.currentRoom}`);
      }
      // Step 1: alice takes the mug ($note/$portable) from the_chatroom.
      await alice.call("the_chatroom", "take", ["mug"], ctx.signal);
      await drain(alice, cfg, ctx.signal);
      // Step 2: alice moves to the_deck while holding the mug. The mug's location
      // follows the actor, crossing the room authority boundary.
      await alice.call("the_chatroom", "southeast", [], ctx.signal);
      const aliceRoomAfterMove: string | null = alice.currentRoom;
      if (aliceRoomAfterMove !== "the_deck") {
        throw new Error(`carry-across-rooms: alice expected on the_deck after southeast; at=${aliceRoomAfterMove}`);
      }
      try {
        // Step 3: THE A2 GATE — alice invokes `read` on the mug directly.
        // `read` is defined on $note (direct_callable). In cf-dev without A2,
        // the gateway shard's relay lacks $note/$portable class lineage for the
        // deck scope, so the verb dispatch fails with E_VERBNF/dangling_parent_ref.
        // With A2 (mergeIncomingObjectLineageClosure), the lineage is
        // pre-delivered, the verb resolves successfully.
        await alice.call("the_mug", "read", [], ctx.signal);
        await drain(alice, cfg, ctx.signal);
      } finally {
        // Best-effort restoration: alice walks back to chatroom carrying the mug,
        // drops it there (chatroom relay has alice's accurate inventory state from
        // the take commit). Swallowed so cleanup failure cannot mask the step error.
        const tryCall = async (who: typeof alice, scope: string, verb: string, args: string[]) => {
          try { await who.call(scope, verb, args, ctx.signal); } catch { /* best-effort cleanup */ }
        };
        const aliceRoomCleanup: string | null = alice.currentRoom;
        if (aliceRoomCleanup === "the_deck") await tryCall(alice, "the_deck", "west", []);
        const aliceRoomAfterWest: string | null = alice.currentRoom;
        if (aliceRoomAfterWest === "the_chatroom") await tryCall(alice, "the_chatroom", "drop", ["mug"]);
        try { await drain(alice, cfg, ctx.signal); } catch { /* best-effort */ }
        // Bob's state is not touched by this step; he stays in his current room.
        void bob;
      }
    });
  }

  // C3 gate: tool-surface-after-move. After alice moves from the_chatroom to
  // the_deck and then moves into the_pinboard from the new scope, assert that the
  // pinboard's add_note tool is reachable. This exercises the tool-surface
  // enumeration path separately from the verb-on-carried-object test above.
  //
  // Smoke failure #1 in the b7-tail run ("the_pinboard:add_note not reachable")
  // is exactly this gap: the tool surface showed only 7 rows on the gateway
  // shard because $portable (and catalog class ancestors) lineage never reached
  // the destination shard's relay cache.
  //
  // In the fake lane: passes (shared world image, full lineage always present).
  // In cf-dev/deployed: FAILS until A2 lands. TRACKED → A2.
  if (options.includeToolSurfaceAfterMove) {
    await step("tool-surface-after-move: add_note reachable after moving into pinboard from new scope", async (ctx) => {
      const { alice } = pair;
      // Precondition: alice must be in the_deck before moving to the_pinboard.
      await alice.leaveIfIn("the_pinboard", ctx.signal);
      await alice.leaveIfIn("the_outline", ctx.signal);
      if (alice.currentRoom === "the_chatroom") await alice.call("the_chatroom", "southeast", [], ctx.signal);
      if (alice.currentRoom !== "the_deck") {
        throw new Error(`tool-surface-after-move: alice expected on the_deck; at=${alice.currentRoom}`);
      }
      // Assertion runs inside try/finally: whether it passes or (tracked-)fails,
      // alice must end back in the_chatroom — downstream steps (pinboard:add_note
      // reaches peer) set up with `the_chatroom:southeast` and fail E_PERM if a
      // gated step strands her on the_deck. State-neutrality is a requirement
      // for every optional scenario step.
      try {
        await alice.moveTo("the_pinboard", ctx.signal);
        await drain(alice, cfg, ctx.signal);
        // Assert add_note is reachable via the tool list. We use woo_list_reachable_tools
        // rather than calling the verb so that a missing tool-surface entry is
        // distinguishable from an argument/auth error. The minimum acceptance bar
        // is that add_note appears in the reachable-tools list at all — the existing
        // pinboard:add_note step (always run, not gated) covers functional correctness.
        const toolsResult = await alice.callTool("woo_list_reachable_tools", { scope: "active", limit: 200 }, { signal: ctx.signal });
        const toolsList: unknown[] = (toolsResult as any)?.result?.structuredContent?.result?.tools ?? [];
        const addNoteTool = toolsList.find((t: any) => isRecord(t) && t.object === "the_pinboard" && t.verb === "add_note");
        if (!addNoteTool) {
          const pinboardTools = toolsList
            .filter((t: any) => isRecord(t) && String(t.object ?? "").includes("pinboard"))
            .map((t: any) => String((t as any).verb ?? "?"));
          throw new Error(
            `tool-surface-after-move: the_pinboard:add_note not in reachable tools after scope-crossing movement; ` +
            `pinboard tools visible: [${pinboardTools.join(", ")}] (total reachable: ${toolsList.length})`
          );
        }
      } finally {
        // Best-effort restoration to the_chatroom; swallowed individually so a
        // cleanup failure never masks the assertion's real error.
        try { await alice.leaveIfIn("the_pinboard", ctx.signal); } catch { /* best-effort */ }
        const aliceRoomCleanup: string | null = alice.currentRoom;
        if (aliceRoomCleanup === "the_deck") {
          try { await alice.call("the_deck", "west", [], ctx.signal); } catch { /* best-effort */ }
        }
        try { await drain(alice, cfg, ctx.signal); } catch { /* best-effort */ }
      }
    });
  }

  // Tool spaces: each is mounted in a specific room. Browser tab switching now
  // moves the actor directly to the tool space; the smoke path mirrors that
  // movement instead of calling a tool-space `enter` verb. Pinboard is mounted
  // in the_deck.
  await step("pinboard:add_note reaches peer", async (ctx) => {
    const { alice, bob } = pair;
    await alice.call("the_chatroom", "southeast", [], ctx.signal);
    await bob.call("the_chatroom", "southeast", [], ctx.signal);
    await drain(alice, cfg, ctx.signal);
    await drain(bob, cfg, ctx.signal);
    await alice.moveTo("the_pinboard", ctx.signal);
    await bob.moveTo("the_pinboard", ctx.signal);
    await drain(alice, cfg, ctx.signal);
    await drain(bob, cfg, ctx.signal);
    const text = `pinboard-${runId}`;
    await alice.call("the_pinboard", "add_note", [text, "yellow", 32, 32, 200, 120], ctx.signal);
    await waitFor(bob, (obs) =>
      obs.type === "note_added" &&
      isRecord(obs.note) &&
      typeof obs.note.text === "string" &&
      obs.note.text.includes(text),
    waitMs, ctx.signal, cfg);
  });

  // CO2.5 / mcp.md §M4.2 — mutation retry safety over the REAL transport.
  //
  // The fake-DO lane proves exactly-once on world state; what only a real
  // lane can prove is that the carrier survives an actual HTTP round trip, a
  // real MCP session, and real cross-DO RPC. Both actors are still standing
  // at the pinboard from the step above, so this costs no movement.
  //
  // `add_note` is durable and MUTATING — the shape the operation id exists to
  // protect. The retry simulates a client whose response was lost: identical
  // call, identical operation id. `replayed:true` is the AUTHORITY's own
  // statement that this round committed nothing (it looked the key up), so a
  // second note was never minted, and the identical result proves the client
  // recovered the original outcome rather than an empty success.
  await step("retry safety: a repeated operation_id commits once and replays its outcome", async (ctx) => {
    const { alice } = pair;
    const args = {
      object: "the_pinboard",
      verb: "add_note",
      args: [`idem-${runId}`, "blue", 96, 96, 200, 120],
      operation_id: `smoke-idem-${runId}`
    };
    const first = await alice.callTool("woo_call", args, { signal: ctx.signal });
    const firstBody = first?.result?.structuredContent;
    if (first?.result?.isError) {
      throw new Error(`add_note refused: ${JSON.stringify(firstBody).slice(0, 300)}`);
    }
    if (firstBody?.replayed !== undefined) {
      throw new Error(`the first call must not be a replay: ${JSON.stringify(firstBody).slice(0, 300)}`);
    }
    const retry = await alice.callTool("woo_call", args, { signal: ctx.signal });
    const retryBody = retry?.result?.structuredContent;
    if (retry?.result?.isError) {
      throw new Error(`the retry must not fail: ${JSON.stringify(retryBody).slice(0, 300)}`);
    }
    if (retryBody?.replayed !== true) {
      throw new Error(`the retry was NOT deduplicated — it committed a second time: ${JSON.stringify(retryBody).slice(0, 300)}`);
    }
    if (retryBody?.replay_outcome !== "full") {
      throw new Error(`the retry could not recover the outcome: ${JSON.stringify(retryBody).slice(0, 300)}`);
    }
    if (JSON.stringify(retryBody?.result) !== JSON.stringify(firstBody?.result)) {
      throw new Error(
        `the replay returned a DIFFERENT outcome than the committed execution: `
        + `${JSON.stringify(firstBody?.result)} vs ${JSON.stringify(retryBody?.result)}`
      );
    }
  });

  // Dispenser: the Acts-kernel anchored-actor adopter (the_horoscope, standing
  // on the_deck). One order/cancel round proves the typed surface end-to-end in
  // every lane: sequenced admission (`order`), the recorded fact fanning out to
  // a co-present peer, the plug-only authority boundary refusing an ordinary
  // actor, and a terminal disposition with its own peer-visible fact. The
  // deliver half is deliberately absent: `next_pending`/`prepare_artifact`/
  // `deliver` accept only the block actor (the apikey plug) or a wizard
  // (catalogs/dispenser/DESIGN.md), so the right walkthrough assertion for an
  // ordinary credential is that they REFUSE; delivery mechanics are covered by
  // tests/dispenser-acts.test.ts and the plug's own suite.
  //
  // COMPETING CONSUMER (deployed lane): the production horoscope plug drains
  // this same queue — on a 15-minute cron AND promptly, because `:order` sends
  // the block a synchronous wakeup hint. A delivered-under-us order is
  // therefore a legitimate outcome there, not a failure: the plug racing us IS
  // the production loop working. In that mode the step cancels IMMEDIATELY
  // after ordering (narrowest possible window before real AI quota is spent),
  // accepts either terminal disposition, and asserts the matching terminal
  // fact. Fresh-world lanes have no plug, so they keep the strict
  // deterministic sequence (queued status read between order and cancel, and
  // exactly a canceled outcome).
  //
  // LEAK GUARD (best-effort by construction, with the residual case named):
  // an abandoned pending order would be drained by the plug within its poll
  // interval, spending quota and delivering an unwanted note. The finally
  // block therefore (a) runs its cleanup calls WITHOUT the step signal — a
  // fired watchdog must abort the assertions, not the cleanup, and each call
  // stays bounded by the session's own RPC deadline; (b) recovers a lost
  // order id when the order committed server-side but its reply timed out, by
  // scanning both sessions' observation queues for the ordered fact carrying
  // this run's unique request string; and (c) cancels whenever no terminal
  // reply was observed (`cancel` is idempotent: delivered → {duplicate,
  // reason:"delivered"}, already-canceled → {duplicate:true}). A lost
  // delivery race is cleaned up too: the terminal fact carries the note ref,
  // and dropping it by literal `#id` disperses it (a `$dispensed_note`
  // recycles on drop). The irreducible residual — the smoke process dying
  // mid-window — leaves at most one order, which the live plug itself settles
  // (delivery or plug-cancel) within its poll interval; that residual is
  // documented, not denied.
  //
  // Rolling v0→v1 contract: a runtime deploy does not rewrite an installed
  // world's catalog pages, so an aged world may still run the pre-Acts
  // dispenser page, which emits flat `order_placed`/`canceled`/`delivered`
  // observations instead of the `dispenser.*` Act envelopes. Accept both,
  // exactly like the Outliner steps below.
  await step("dispenser: order reaches peer, plug surface refuses, terminal fact lands", async (ctx) => {
    const { alice, bob } = pair;
    // Both actors to the_deck. The pinboard step normally leaves them inside
    // the_pinboard; the chatroom guard covers a recorded earlier failure.
    await alice.leaveIfIn("the_pinboard", ctx.signal);
    await bob.leaveIfIn("the_pinboard", ctx.signal);
    if (alice.currentRoom === "the_chatroom") await alice.call("the_chatroom", "southeast", [], ctx.signal);
    if (bob.currentRoom === "the_chatroom") await bob.call("the_chatroom", "southeast", [], ctx.signal);
    if (alice.currentRoom !== "the_deck" || bob.currentRoom !== "the_deck") {
      throw new Error(`dispenser: both actors expected on the_deck; alice=${alice.currentRoom} bob=${bob.currentRoom}`);
    }
    await drain(alice, cfg, ctx.signal);
    await drain(bob, cfg, ctx.signal);

    const competing = options.dispenserCompetingConsumer === true;
    const admissionWaitMs = options.dispenserAdmissionWaitMs ?? DEFAULT_ADMISSION_WAIT_MS;
    const request = `walkthrough-order-${runId}`;
    let orderAttempted = false;
    let orderId: string | null = null;
    let terminalReached = false;
    try {
      orderAttempted = true;
      const reply = await orderWithAdmissionRetry(alice, [bob], request, admissionWaitMs, ctx.signal, cfg);
      if (!isRecord(reply) || reply.queued !== true || typeof reply.order_id !== "string" || !reply.order_id) {
        throw new Error(`dispenser order should return {order_id, queued:true}; got ${JSON.stringify(reply).slice(0, 300)}`);
      }
      orderId = reply.order_id;

      // Which terminal facts we accept, and which we then observed.
      let expected: DispenserFactKind[];
      if (competing) {
        // Cancel first, before any assertion widens the race window. The
        // reply classifies the race but cannot always name the winner: a
        // pre-Acts page deletes the pending row both when the plug DELIVERS
        // and when the plug CANCELS (its prepare_artifact call E_VERBNFs on
        // that page and it cancels the order as permanent), and both read
        // back as `not_pending`. An ambiguous reply therefore accepts either
        // terminal fact and learns the outcome from whichever arrives.
        const canceled = await alice.call("the_horoscope", "cancel", [orderId], ctx.signal);
        const disposition = dispenserCancelDisposition(canceled);
        if (disposition === null) {
          throw new Error(`dispenser cancel for ${orderId} returned neither a cancellation nor a settled race; got ${JSON.stringify(canceled).slice(0, 300)}`);
        }
        terminalReached = true;
        expected = disposition === "canceled" ? ["canceled"]
          : disposition === "delivered" ? ["delivered"]
          : ["canceled", "delivered"];
      } else {
        // Strict fresh-world sequence: the queued status read is meaningful
        // only when nothing else can drain the queue underneath it.
        await waitFor(bob, (obs) => findDispenserFact(obs, ["ordered"], "the_horoscope", orderId!) !== null, waitMs, ctx.signal, cfg);
        const status = await alice.call("the_horoscope", "status", [orderId], ctx.signal);
        if (!isRecord(status) || status.state !== "queued") {
          throw new Error(`dispenser status for ${orderId} should be queued; got ${JSON.stringify(status).slice(0, 300)}`);
        }
        const canceled = await alice.call("the_horoscope", "cancel", [orderId], ctx.signal);
        if (!isRecord(canceled) || canceled.canceled !== true) {
          throw new Error(`dispenser cancel for ${orderId} should return canceled:true; got ${JSON.stringify(canceled).slice(0, 300)}`);
        }
        terminalReached = true;
        expected = ["canceled"];
      }

      // The recorded ordered fact reaches the co-present peer through the
      // room's ordinary observation fanout (retained in bob's queue whether or
      // not the cancel already committed).
      if (competing) {
        await waitFor(bob, (obs) => findDispenserFact(obs, ["ordered"], "the_horoscope", orderId!) !== null, waitMs, ctx.signal, cfg);
      }
      // ... and so does a terminal fact from the accepted set. The matched
      // observation names the actual outcome (and, for a delivery, the note).
      const terminalObs = await waitFor(
        bob,
        (obs) => findDispenserFact(obs, expected, "the_horoscope", orderId!) !== null,
        waitMs,
        ctx.signal,
        cfg
      );
      const terminal = findDispenserFact(terminalObs, expected, "the_horoscope", orderId)!;

      if (terminal.kind === "delivered") {
        // Race lost: a real note landed in alice's inventory. Disperse it —
        // the terminal fact carries the note ref, the room matcher resolves
        // literal `#id`, and a $dispensed_note recycles on drop. Best-effort:
        // a failed dispersal logs the residue instead of failing the step.
        const note = terminal.note;
        if (note) {
          try {
            await alice.call("the_deck", "drop", [`#${note}`], ctx.signal);
            cfg.log?.(`    [${alice.label}] dispenser race lost: ${orderId} was delivered before the cancel; dispersed the delivered note ${note}`);
          } catch {
            cfg.log?.(`    [${alice.label}] dispenser race lost AND dispersal failed: delivered note ${note} remains in ${alice.label}'s inventory (drop it to disperse)`);
          }
        } else {
          cfg.log?.(`    [${alice.label}] dispenser race lost: ${orderId} delivered; terminal fact carried no note ref, note remains in inventory`);
        }
      }

      // The terminal disposition is durably readable: whatever the outcome,
      // the order is no longer queued. (v1 keeps a terminal receipt; v0
      // removed the row, which reads as "unknown".)
      const settled = await alice.call("the_horoscope", "status", [orderId], ctx.signal);
      if (isRecord(settled) && settled.state === "queued") {
        throw new Error(`dispenser order ${orderId} still queued after its terminal disposition; got ${JSON.stringify(settled).slice(0, 300)}`);
      }

      // Authority boundary: the pending queue is plug-only. `next_pending` is
      // command-shaped and therefore reachable in the room's tool context, so
      // a refusal here is the verb's own E_PERM guard, not tool enumeration.
      let refusal: string | null = null;
      try {
        await bob.call("the_horoscope", "next_pending", [], ctx.signal);
      } catch (err) {
        refusal = err instanceof Error ? err.message : String(err);
      }
      if (!refusal || !refusal.includes("E_PERM")) {
        throw new Error(`the_horoscope:next_pending must refuse an ordinary actor with E_PERM; got ${refusal ?? "success"}`);
      }
    } finally {
      // The leak guard. Deliberately signal-free: a fired watchdog aborts the
      // assertions above, not this cleanup — each call is still bounded by
      // the session's own RPC deadline. Swallowed individually so cleanup can
      // never mask the step's real error.
      if (orderId === null && orderAttempted) {
        // The order may have committed server-side while its reply was lost.
        // The ordered fact carries this run's unique request string; scan
        // both sessions' observation queues for it to recover the id.
        orderId = await recoverDispenserOrderId([alice, bob], request, cfg);
      }
      if (orderId !== null && !terminalReached) {
        try {
          await alice.call("the_horoscope", "cancel", [orderId]);
          cfg.log?.(`    [${alice.label}] dispenser leak-guard canceled ${orderId}`);
        } catch {
          cfg.log?.(`    [${alice.label}] dispenser leak-guard cancel for ${orderId} failed; the live plug will settle it within its poll interval`);
        }
      }
      try { await drain(alice, cfg); } catch { /* best-effort */ }
      try { await drain(bob, cfg); } catch { /* best-effort */ }
    }
  });

  // Outliner is mounted in the_chatroom, so both actors come back west. Movement
  // into the outliner updates presence; assert the joined public `look` view
  // carries the roster shape assembled by the internal `look_self` helper.
  await step("outliner roster includes a row for alice after movement", async (ctx) => {
    const { alice, bob } = pair;
    // Only leave if actually in the pinboard; only walk west if actually on the
    // deck — guards keep a prior-step failure from cascading into a stale
    // E_VERBNF on a wrong-room verb that masks the real cause.
    await alice.leaveIfIn("the_pinboard", ctx.signal);
    await bob.leaveIfIn("the_pinboard", ctx.signal);
    if (alice.currentRoom === "the_deck") await alice.call("the_deck", "west", [], ctx.signal);
    if (bob.currentRoom === "the_deck") await bob.call("the_deck", "west", [], ctx.signal);
    await drain(alice, cfg, ctx.signal);
    await drain(bob, cfg, ctx.signal);
    await alice.moveTo("the_outline", ctx.signal);
    const aliceView = await alice.call("the_outline", "look", [], ctx.signal);
    if (!isRecord(aliceView) || !Array.isArray(aliceView.roster)) {
      throw new Error(`expected roster array on the_outline:look result; got ${JSON.stringify(aliceView).slice(0, 200)}`);
    }
    const rows = aliceView.roster.filter(isRecord);
    const ids = new Set(rows.map((row) => String(row.id ?? "")));
    if (!ids.has(alice.actor)) {
      throw new Error(
        `alice not in her own outliner roster; ids=${[...ids].join(",")} expected alice=${alice.actor}; ` +
        `currentRoom=${alice.currentRoom}; view=${JSON.stringify(aliceView).slice(0, 600)}`
      );
    }
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.name !== "string") {
        throw new Error(`row missing id/name shape: ${JSON.stringify(row)}`);
      }
    }
  });

  let outlineAnchor: string | null = null;
  let outlinerMode: OutlinerObservationMode | null = null;
  await step("outliner:add_item reaches peer", async (ctx) => {
    const { alice, bob } = pair;
    await bob.moveTo("the_outline", ctx.signal);
    await drain(alice, cfg, ctx.signal);
    await drain(bob, cfg, ctx.signal);
    const text = `outline-${runId}`;
    await alice.call("the_outline", "add_item", [text], ctx.signal);
    // A runtime deploy does not rewrite an installed world's catalog pages.
    // Production may therefore still emit the pre-v3 flat observation while a
    // freshly installed world emits the v3 Act envelope. The catalog migration
    // explicitly requires consumers to accept both during this interval.
    const added = await waitFor(
      bob,
      (obs) => obs.type === "outline_item_added",
      waitMs,
      ctx.signal,
      cfg
    );
    const normalized = normalizeOutlinerObservation(added);
    if (!normalized) {
      throw new Error(`expected a legacy or v1 outline_item_added observation; got ${JSON.stringify(added).slice(0, 600)}`);
    }
    const fact = normalized.fact;
    if (normalized.mode === "act") {
      // v3 deliberately keeps prose on the $outline_item artifact. Its Act
      // payload must stay the exact concise structural fact.
      const payloadKeys = Object.keys(fact).sort();
      const expectedKeys = ["index", "item", "parent_id"];
      if (JSON.stringify(payloadKeys) !== JSON.stringify(expectedKeys)) {
        throw new Error(`expected concise outline_item_added payload; got ${JSON.stringify(fact).slice(0, 600)}`);
      }
    }
    if (typeof fact.item !== "string" ||
        (fact.parent_id !== null && typeof fact.parent_id !== "string") ||
        !Number.isSafeInteger(fact.index)) {
      throw new Error(`expected a valid outline_item_added fact; got ${JSON.stringify(fact).slice(0, 600)}`);
    }
    outlinerMode = normalized.mode;
    await waitForOutlinerArtifact(bob, fact.item, text, normalized.mode, waitMs, ctx.signal);
    outlineAnchor = fact.item;
  });

  // The bake criterion is the whole structural vocabulary, not add alone.
  // Drive every composer through one actor and pin the peer's authoritative
  // tree after each Act; undo-remove intentionally restores a new artifact id.
  await step("outliner: reorder, move, hide, remove, and undo converge", async (ctx) => {
    const { alice, bob } = pair;
    const anchor = outlineAnchor;
    const mode = outlinerMode;
    if (!anchor || !mode) throw new Error("outliner lifecycle requires the preceding add_item artifact");

    const text = `outline-lifecycle-${runId}`;
    await alice.call("the_outline", "add_item", [text], ctx.signal);
    const added = await waitFor(
      bob,
      (obs) => matchesOutlinerFact(obs, "outline_item_added", (fact) => typeof fact.item === "string"),
      waitMs,
      ctx.signal,
      cfg
    );
    const addedFact = normalizeOutlinerObservation(added);
    if (!addedFact || addedFact.mode !== mode || typeof addedFact.fact.item !== "string") {
      throw new Error(`outliner observation shape changed during one walkthrough: ${JSON.stringify(added).slice(0, 600)}`);
    }
    const item = addedFact.fact.item;
    await waitForOutlinerArtifact(bob, item, text, mode, waitMs, ctx.signal);

    await alice.call("the_outline", "reorder_item", [item, 0], ctx.signal);
    await waitFor(
      bob,
      (obs) => matchesOutlinerFact(
        obs,
        "outline_item_reordered",
        (fact) => fact.item === item && fact.to_index === 0
      ),
      waitMs,
      ctx.signal,
      cfg
    );
    await waitForOutlinerState(
      bob,
      (items) => items.some((row) => row.id === item && row.parent_id === null && row.index === 0),
      `${item} reordered to root index 0`,
      mode,
      waitMs,
      ctx.signal
    );

    await alice.call("the_outline", "move_item", [item, anchor, 0], ctx.signal);
    await waitFor(
      bob,
      (obs) => matchesOutlinerFact(
        obs,
        "outline_item_moved",
        (fact) => fact.item === item && fact.to_parent === anchor && fact.to_index === 0
      ),
      waitMs,
      ctx.signal,
      cfg
    );
    await waitForOutlinerState(
      bob,
      (items) => items.some((row) => row.id === item && row.parent_id === anchor && row.index === 0),
      `${item} moved under ${anchor}`,
      mode,
      waitMs,
      ctx.signal
    );

    await alice.call("the_outline", "hide", [item, true], ctx.signal);
    await waitFor(
      bob,
      (obs) => matchesOutlinerFact(
        obs,
        "outline_item_hidden",
        (fact) => fact.item === item && fact.hidden === true
      ),
      waitMs,
      ctx.signal,
      cfg
    );
    await waitForOutlinerState(
      bob,
      (items) => items.some((row) => row.id === item && row.hidden === true),
      `${item} hidden`,
      mode,
      waitMs,
      ctx.signal
    );

    await alice.call("the_outline", "undo", [], ctx.signal);
    await waitFor(
      bob,
      (obs) => matchesOutlinerFact(
        obs,
        "outline_item_hidden",
        (fact) => fact.item === item && fact.hidden === false
      ),
      waitMs,
      ctx.signal,
      cfg
    );
    await waitForOutlinerState(
      bob,
      (items) => items.some((row) => row.id === item && row.hidden === false),
      `${item} unhidden by undo`,
      mode,
      waitMs,
      ctx.signal
    );

    await alice.call("the_outline", "remove_item", [item], ctx.signal);
    await waitFor(
      bob,
      (obs) => matchesOutlinerFact(obs, "outline_item_removed", (fact) => fact.item === item),
      waitMs,
      ctx.signal,
      cfg
    );
    await waitForOutlinerState(
      bob,
      (items) => items.every((row) => row.id !== item),
      `${item} absent after remove`,
      mode,
      waitMs,
      ctx.signal
    );

    const restored = await alice.call("the_outline", "undo", [], ctx.signal);
    if (typeof restored !== "string") {
      throw new Error(`remove undo should return the restored artifact id; got ${JSON.stringify(restored)}`);
    }
    if (mode === "act") {
      // v3 records the restoration as the same structural added Act used by a
      // normal add_item. This is the peer's precise invalidation signal.
      await waitFor(
        bob,
        (obs) => matchesOutlinerFact(
          obs,
          "outline_item_added",
          (fact) => fact.item === restored && fact.parent_id === anchor
        ),
        waitMs,
        ctx.signal,
        cfg
      );
    } else {
      // v2 restores the row before emitting its legacy outline_undone event;
      // it does not emit a second outline_item_added. The following bounded
      // list_items polls still prove the returned artifact and parent.
      await waitFor(
        bob,
        (obs) => obs.type === "outline_undone" && obs.actor === alice.actor && obs.outliner === "the_outline",
        waitMs,
        ctx.signal,
        cfg
      );
    }
    await waitForOutlinerArtifact(bob, restored, text, mode, waitMs, ctx.signal);
    await waitForOutlinerState(
      bob,
      (items) => items.some((row) => row.id === restored && row.parent_id === anchor),
      `${restored} restored under ${anchor}`,
      mode,
      waitMs,
      ctx.signal
    );
  });

  // Taskboard navigation: chatroom -> southeast -> the_deck -> south toward
  // the_taskboard, following the extra the_garden hop only when the first move
  // lands there (demoworld routes deck-south through the_garden).
  await step("tasks: cross-room `entered` reaches peer", async (ctx) => {
    const { alice, bob } = pair;
    await alice.leaveIfIn("the_outline", ctx.signal);
    await bob.leaveIfIn("the_outline", ctx.signal);
    if (alice.currentRoom === "the_chatroom") await alice.call("the_chatroom", "southeast", [], ctx.signal);
    if (bob.currentRoom === "the_chatroom") await bob.call("the_chatroom", "southeast", [], ctx.signal);
    await walkSouthToTaskboard(alice, ctx.signal);
    await drain(alice, cfg, ctx.signal);
    await drain(bob, cfg, ctx.signal);
    await walkSouthToTaskboard(bob, ctx.signal);
    await waitFor(alice, (obs) =>
      obs.type === "entered" &&
      obs.actor === bob.actor &&
      obs.source === "the_taskboard",
    waitMs, ctx.signal, cfg);
  });
}

/** Put one persistent smoke actor in the chatroom and establish the driver's
 * room cursor. API-key actors retain their physical location between runs, and
 * the contextual MCP surface intentionally exposes only their current room.
 * Read its explicit `active_scope`, then walk the demo graph home;
 * this makes repeated and recovery runs state-independent without bypassing
 * the same public movement verbs that clients use. */
export async function ensureInChatroom(
  session: SmokeSession,
  signal?: AbortSignal
): Promise<void> {
  const listed = await session.callTool(
    "woo_list_reachable_tools",
    { scope: "active", limit: 200 },
    { signal }
  );
  // A REFUSED tool call and an actor genuinely nowhere both leave `page` empty,
  // and they need different fixes — report the refusal verbatim rather than
  // letting it read as "no active scope". (A validator change that retired an
  // argument this script still passed was diagnosed as a movement bug because
  // this branch swallowed the error text.)
  const failure = isRecord(listed) && isRecord(listed.result) && listed.result.isError === true
    ? JSON.stringify(listed.result.content ?? listed.result).slice(0, 400)
    : null;
  if (failure) {
    throw new Error(`woo_list_reachable_tools refused for ${session.label}: ${failure}`);
  }
  const page = isRecord(listed) &&
    isRecord(listed.result) &&
    isRecord(listed.result.structuredContent) &&
    isRecord(listed.result.structuredContent.result)
    ? listed.result.structuredContent.result
    : null;
  if (!page || typeof page.active_scope !== "string") {
    throw new Error(
      `cannot establish ${session.label} current room from reachable tools; ` +
      `active_scope=${JSON.stringify(page?.active_scope ?? null)}`
    );
  }
  session.currentRoom = page.active_scope;

  for (let hop = 0; hop < 4 && session.currentRoom !== "the_chatroom"; hop += 1) {
    const room = session.currentRoom;
    const exit =
      room === "the_taskboard" ? "out" :
      room === "the_garden" ? "north" :
      room === "the_deck" || room === "the_hot_tub" ? "west" :
      room === "the_outline" || room === "the_pinboard" || room === "the_dubspace" ? "out" :
      null;
    if (!exit) {
      throw new Error(`cannot route ${session.label} from ${room} to the_chatroom`);
    }
    await session.call(room, "go", [exit], signal);
  }
  if (session.currentRoom !== "the_chatroom") {
    throw new Error(`failed to route ${session.label} to the_chatroom; at=${session.currentRoom}`);
  }
}

async function walkSouthToTaskboard(session: SmokeSession, signal?: AbortSignal): Promise<void> {
  if (session.currentRoom !== "the_deck") {
    throw new Error(`${session.label} expected on the_deck before south; at=${session.currentRoom}`);
  }
  await session.call("the_deck", "south", [], signal);
  // Read into a widened local: `currentRoom` is mutated inside `call`, but TS
  // flow-narrows it to "the_deck" from the guard above and would otherwise flag
  // the comparisons below as impossible.
  const afterFirstMove: string | null = session.currentRoom;
  if (afterFirstMove === "the_garden") {
    await session.call("the_garden", "south", [], signal);
  }
  const afterSouthPath: string | null = session.currentRoom;
  if (afterSouthPath !== "the_taskboard") {
    throw new Error(`${session.label} expected on the_taskboard after south path; at=${session.currentRoom}`);
  }
}

type DrainConfig = { drainBudgetMs: number; drainPollMs: number; log?: (message: string) => void };

export type OutlinerObservationMode = "act" | "legacy";

/** Normalize the two shapes allowed by the Outliner v2→v3 rolling contract.
 * A partial/malformed Act never falls back to legacy: once either envelope
 * field is present, both the exact version and a map payload are required. */
export function normalizeOutlinerObservation(
  observation: unknown
): { mode: OutlinerObservationMode; fact: Record<string, any> } | null {
  if (!isRecord(observation) || typeof observation.type !== "string" ||
      !observation.type.startsWith("outline_item_")) {
    return null;
  }
  if ("version" in observation || "payload" in observation) {
    if (observation.version !== 1 || !isRecord(observation.payload)) return null;
    return { mode: "act", fact: observation.payload };
  }
  return { mode: "legacy", fact: observation };
}

function matchesOutlinerFact(
  observation: Record<string, any>,
  type: string,
  matches: (fact: Record<string, any>) => boolean
): boolean {
  if (observation.type !== type) return false;
  const normalized = normalizeOutlinerObservation(observation);
  return normalized !== null && matches(normalized.fact);
}

export type DispenserFactKind = "ordered" | "canceled" | "delivered";

const DISPENSER_LEGACY_TYPES: Record<DispenserFactKind, string> = {
  ordered: "order_placed",
  canceled: "canceled",
  delivered: "delivered"
};

/** Normalize the two shapes allowed by the dispenser v0→v1 rolling contract:
 * the v1 Act envelope (`dispenser.ordered`/`.canceled`/`.delivered`,
 * `version: 1`, `payload.order_id`, composer in `source`) and the pre-Acts
 * flat observation (`order_placed`/`canceled`/`delivered` with a top-level
 * `order_id` and `block`). Both shapes must name the emitting block: the
 * legacy words are generic and must not match another catalog's observation.
 * A partial/malformed Act never falls back to legacy — once the `dispenser.`
 * type is present, the exact envelope is required, mirroring the Outliner
 * normalizer above. A delivered fact also surfaces its note ref (both shapes
 * carry it) so the walkthrough can disperse a race-delivered note. */
export function normalizeDispenserObservation(
  observation: unknown,
  kind: DispenserFactKind,
  block: string
): { mode: "act" | "legacy"; orderId: string; note: string | null } | null {
  if (!isRecord(observation) || typeof observation.type !== "string") return null;
  if (observation.type === `dispenser.${kind}`) {
    if (observation.version !== 1 || observation.source !== block) return null;
    if (!isRecord(observation.payload) || typeof observation.payload.order_id !== "string") return null;
    const actNote = observation.payload.note;
    return { mode: "act", orderId: observation.payload.order_id, note: typeof actNote === "string" && actNote ? actNote : null };
  }
  if (observation.type !== DISPENSER_LEGACY_TYPES[kind]) return null;
  if (observation.block !== block || typeof observation.order_id !== "string") return null;
  const legacyNote = observation.note;
  return { mode: "legacy", orderId: observation.order_id, note: typeof legacyNote === "string" && legacyNote ? legacyNote : null };
}

/** Match one observation against a set of acceptable dispenser fact kinds for
 * a specific order, returning which kind matched (and the note ref, when the
 * shape carries one). The set form exists because a settled race cannot
 * always be classified from the cancel reply alone (see
 * dispenserCancelDisposition): the caller accepts either terminal fact and
 * learns the outcome from whichever arrives. */
export function findDispenserFact(
  observation: unknown,
  kinds: readonly DispenserFactKind[],
  block: string,
  orderId: string
): { kind: DispenserFactKind; note: string | null } | null {
  for (const kind of kinds) {
    const normalized = normalizeDispenserObservation(observation, kind, block);
    if (normalized !== null && normalized.orderId === orderId) {
      return { kind, note: normalized.note };
    }
  }
  return null;
}

/** Classify a cancel reply for an order this run just placed. `canceled:true`
 * is the normal outcome. The v1 duplicate/delivered receipt names a lost
 * delivery race explicitly. `reason: "not_pending"` (pre-Acts page) only
 * proves the order settled WITHOUT us: that page deletes the pending row both
 * when the plug delivers and when the plug cancels (its `prepare_artifact`
 * call E_VERBNFs there and the plug cancels the order as permanent) — so it
 * classifies as "raced", and the caller must accept either terminal fact.
 * Anything else (including `reason: "unknown"`) is a real failure. */
export function dispenserCancelDisposition(reply: unknown): "canceled" | "delivered" | "raced" | null {
  if (!isRecord(reply)) return null;
  if (reply.canceled === true) return "canceled";
  if (reply.duplicate === true && reply.reason === "delivered") return "delivered";
  if (reply.reason === "not_pending") return "raced";
  return null;
}

/** Recover a committed order's id when the order reply was lost (server-side
 * commit, client-side timeout): the ordered fact carries the run's unique
 * request string and fans out to every co-present session. Scans a few
 * bounded `woo_wait` polls per session, signal-free — this runs from cleanup
 * paths where the step signal may already be aborted. */
export async function recoverDispenserOrderId(
  sessions: readonly SmokeSession[],
  request: string,
  cfg: DrainConfig
): Promise<string | null> {
  for (const session of sessions) {
    // The ordered fact may already be in this session's retention buffer: a
    // failed assertion earlier in the step consumed the batch it rode in on
    // (waitFor keeps what it did not match). Check that before spending polls.
    let observations: unknown[] = session.takeRetainedObservations();
    for (let poll = 0; poll < 3; poll += 1) {
      if (poll > 0 || observations.length === 0) {
        try {
          const result = await session.callTool("woo_wait", { timeout_ms: cfg.drainPollMs, limit: 100 });
          observations = waitObservationsOf(result);
        } catch {
          break; // this session is unusable (reset/closed); try the next one
        }
      }
      for (const obs of observations) {
        if (!isRecord(obs)) continue;
        const normalized = normalizeDispenserObservation(obs, "ordered", "the_horoscope");
        if (normalized === null) continue;
        const observedRequest = normalized.mode === "act"
          ? (isRecord(obs.payload) ? obs.payload.request : undefined)
          : obs.request;
        if (observedRequest === request) {
          cfg.log?.(`    [${session.label}] recovered lost dispenser order id ${normalized.orderId} from the ordered fact`);
          return normalized.orderId;
        }
      }
      if (observations.length === 0) break;
    }
  }
  return null;
}

/** Extract the admission-window wait from a thrown E_RATE_LIMIT refusal. The
 * dispenser's refusal detail carries `retry_in_seconds`; a rate refusal whose
 * detail cannot be parsed still gets the demo block's 60s default window.
 * Returns null when the message is not a rate refusal at all. */
export function rateLimitRetrySeconds(message: string): number | null {
  if (!message.includes("E_RATE_LIMIT")) return null;
  const match = message.match(/"retry_in_seconds"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
  const parsed = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return 60;
  return Math.ceil(parsed);
}

// Default ceiling for the one bounded admission wait: the demo block's 60s
// requester window plus scheduling slack. A lane with a step watchdog should
// pass its own `dispenserAdmissionWaitMs` computed to reserve time for the
// calls that follow the wait — the scenario cannot see the watchdog.
const DEFAULT_ADMISSION_WAIT_MS = 66_000;

// Persistent deployed actors keep dispenser admission state between runs, so a
// rerun inside the requester rate window is refused E_RATE_LIMIT with a stated
// retry_in_seconds. Honor that one bounded wait rather than failing — the retry
// proves the admission contract's own recovery path. A stated window above the
// lane's ceiling means either an operator widened the block's config or the
// lane has no room to wait; the walkthrough says so rather than stalling into
// its watchdog.
/** Sleep while keeping the given sessions' observation queues alive.
 *
 * `woo_wait` delivery is at-most-once and the queue is gateway-LOCAL live
 * state (spec/protocol/mcp.md §M5), so a session that stops asking stops
 * hearing: measured against the deployed worker, a gateway shard idle for
 * ~10s is evicted and every observation fanned out to a session it held is
 * dropped on the floor. A conforming polling client therefore keeps a wait
 * in flight; an in-flight request is what holds the shard up (verified: a
 * session parked across a 15s window heard the peer's line, the same session
 * merely sleeping 15s did not, and its next reply carried `gap:true`).
 *
 * The walkthrough's admission window is the one place it goes quiet for tens
 * of seconds, and it is the PEER — not the sleeping caller — whose ear has to
 * stay open for the assertions that follow. Anything these polls collect goes
 * into the session's retention buffer, so keeping the ear open cannot cost an
 * observation the step is about to assert on.
 */
async function sleepWithOpenEars(
  totalMs: number,
  sessions: readonly SmokeSession[],
  signal: AbortSignal | undefined
): Promise<void> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const slice = Math.min(2000, deadline - Date.now());
    // One short parked wait per session per slice, in parallel: the request
    // itself is the keep-alive, and the reply's rows are retained, not lost.
    await Promise.all(sessions.map(async (session) => {
      try {
        const result = await session.callTool("woo_wait", { timeout_ms: slice, limit: 100 }, { signal });
        const observations = waitObservationsOf(result).filter(isRecord);
        session.retainObservations(observations);
      } catch {
        // A keep-alive poll is best-effort; the assertions below own the
        // real failure reporting.
      }
    }));
    if (sessions.length === 0) await abortableDelay(slice, signal);
  }
}

async function orderWithAdmissionRetry(
  session: SmokeSession,
  peers: readonly SmokeSession[],
  request: string,
  ceilingMs: number,
  signal: AbortSignal | undefined,
  cfg: DrainConfig
): Promise<unknown> {
  try {
    return await session.call("the_horoscope", "order", [request], signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retrySeconds = rateLimitRetrySeconds(message);
    if (retrySeconds === null) throw err;
    const waitMs = (retrySeconds + 1) * 1000;
    if (waitMs > ceilingMs) {
      throw new Error(`dispenser admission window (${retrySeconds}s) exceeds this lane's ${Math.floor(ceilingMs / 1000)}s wait ceiling: ${message.slice(0, 200)}`);
    }
    cfg.log?.(`    [${session.label}] dispenser admission window active; waiting ${retrySeconds + 1}s for the one retry`);
    // The peers keep polling through the window. Going silent here used to
    // cost their gateway shard (and with it their queue), so the order's
    // fanout landed on a shard holding nothing for them and the terminal-fact
    // assertion below failed with "saw no observations" — a transport
    // eviction misreported as a dispenser fanout failure.
    await sleepWithOpenEars(waitMs, [session, ...peers], signal);
    return await session.call("the_horoscope", "order", [request], signal);
  }
}


// Drain pending observations from a session's wait queue so the next assertion
// only sees events emitted after this point. The deployed fan-out can take 1–2s
// at tail percentiles, so poll until the queue reports empty or the budget
// elapses. Best-effort cleanup — errors are swallowed and must not fail a step.
async function drain(session: SmokeSession, cfg: DrainConfig, signal?: AbortSignal): Promise<void> {
  const started = Date.now();
  // Draining means "everything up to now is stale". That has to include rows
  // a previous waitFor pulled but did not match and is still holding, or the
  // retention buffer would let a later step's assertion be satisfied by an
  // earlier step's observation.
  session.clearRetainedObservations();
  while (Date.now() - started < cfg.drainBudgetMs) {
    try {
      throwIfAborted(signal);
      const result = await session.callTool("woo_wait", { timeout_ms: cfg.drainPollMs, limit: 100 }, { signal });
      const obs = waitObservationsOf(result);
      if (obs.length === 0) return;
      cfg.log?.(`    [${session.label}] drained ${obs.length} stale obs: ${obs.map((o: any) => o.type).join(",")}`);
    } catch {
      throwIfAborted(signal);
      return;
    }
  }
}

// Poll `woo_wait` until `match` returns true for one of the observations, or the
// cumulative timeout elapses. Polls in short increments so it stays responsive
// when the run is healthy rather than blocking on one long wait.
//
// NON-MATCHING OBSERVATIONS ARE RETAINED, NOT DISCARDED. `woo_wait` is
// at-most-once: whatever this call drains is gone from the gateway queue. A
// step that asserts two facts in sequence (dispenser: the ordered fact, then
// the terminal fact) reads one observation STREAM, and the server is free to
// batch both facts into one reply — which a warm deployed gateway does. The
// pre-retention version matched the first fact, threw the rest of the batch
// away, and the following waitFor then timed out with "saw no observations".
// Handing the remainder back to the session makes the assertion sequence
// independent of how the transport batches. See SmokeSession.retained.
export async function waitFor(
  session: SmokeSession,
  match: (obs: Record<string, any>) => boolean,
  totalTimeoutMs: number,
  signal: AbortSignal | undefined,
  cfg: DrainConfig
): Promise<Record<string, any>> {
  const startedAt = Date.now();
  const seen: string[] = [];
  // Rows this call took off the queue (or carried in from an earlier call)
  // that this predicate rejected. Handed back to the session on every exit,
  // match or timeout — they were consumed from the server either way.
  const unmatched: Record<string, any>[] = [];
  // Scan one batch in arrival order. On a match, the rest of the batch —
  // before AND after the matched row — survives: a row this predicate
  // rejected may be exactly what the NEXT waitFor is looking for.
  const scan = (observations: readonly unknown[]): Record<string, any> | null => {
    const records = observations.filter(isRecord);
    for (let index = 0; index < records.length; index += 1) {
      const obs = records[index];
      if (match(obs)) {
        unmatched.push(...records.slice(index + 1));
        return obs;
      }
      seen.push(observationSummary(obs));
      unmatched.push(obs);
    }
    return null;
  };
  const settle = <T>(value: T): T => {
    session.retainObservations(unmatched);
    return value;
  };

  // Rows an earlier waitFor pulled but did not consume come first: they are
  // older than anything the next poll can return.
  const carried = scan(session.takeRetainedObservations());
  if (carried) return settle(carried);

  while (Date.now() - startedAt < totalTimeoutMs) {
    throwIfAborted(signal);
    const remaining = totalTimeoutMs - (Date.now() - startedAt);
    const result = await session.callTool("woo_wait", { timeout_ms: Math.min(remaining, 1000), limit: 100 }, { signal });
    const observations = waitObservationsOf(result);
    if (observations.length) {
      cfg.log?.(`    [${session.label}] received ${observations.length} obs: ${observations.map((o: any) => o.type).join(",")}`);
    }
    const matched = scan(observations);
    if (matched) return settle(matched);
  }
  settle(null);
  const suffix = seen.length ? `; saw ${seen.slice(-12).join("; ")}` : "; saw no observations";
  throw new Error(`timeout after ${totalTimeoutMs}ms waiting for matching observation${suffix}`);
}

// An Act proves that a structural mutation committed, but its concise payload
// intentionally does not duplicate note prose. Follow the artifact reference
// through the consumer's authoritative tree read; polling covers the bounded
// interval in which live Act fanout can arrive just before the refreshed scope
// image is visible at that gateway.
async function waitForOutlinerArtifact(
  session: SmokeSession,
  item: string,
  expectedText: string,
  mode: OutlinerObservationMode,
  totalTimeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  const startedAt = Date.now();
  let lastView = "no authoritative outliner result";
  while (Date.now() - startedAt < totalTimeoutMs) {
    throwIfAborted(signal);
    const items = await readOutlinerItems(session, mode, signal);
    const row = items.find((candidate: unknown) => isRecord(candidate) && candidate.id === item);
    if (isRecord(row) && row.text === expectedText) return;
    lastView = JSON.stringify(items).slice(0, 1000);
    const remaining = totalTimeoutMs - (Date.now() - startedAt);
    if (remaining > 0) await abortableDelay(Math.min(100, remaining), signal);
  }
  throw new Error(
    `timeout after ${totalTimeoutMs}ms waiting for outliner artifact ${item} ` +
    `with text ${JSON.stringify(expectedText)}; last view=${lastView}`
  );
}

async function waitForOutlinerState(
  session: SmokeSession,
  matches: (items: Array<Record<string, any>>) => boolean,
  expected: string,
  mode: OutlinerObservationMode,
  totalTimeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  const startedAt = Date.now();
  let lastView = "no authoritative outliner result";
  while (Date.now() - startedAt < totalTimeoutMs) {
    throwIfAborted(signal);
    const items = (await readOutlinerItems(session, mode, signal)).filter(isRecord);
    if (matches(items)) return;
    lastView = JSON.stringify(items).slice(0, 1000);
    const remaining = totalTimeoutMs - (Date.now() - startedAt);
    if (remaining > 0) await abortableDelay(Math.min(100, remaining), signal);
  }
  throw new Error(`timeout after ${totalTimeoutMs}ms waiting for outliner state ${expected}; last view=${lastView}`);
}

/** v3 couples rows to a structural Act watermark through tree_view. An aged v2
 * catalog has no tree_view verb, so its authoritative list_items read is the
 * corresponding source of truth. Select from the observed catalog shape
 * instead of catching arbitrary read failures and silently weakening a v3 run. */
async function readOutlinerItems(
  session: SmokeSession,
  mode: OutlinerObservationMode,
  signal?: AbortSignal
): Promise<unknown[]> {
  if (mode === "legacy") {
    const rows = await session.call("the_outline", "list_items", [], signal);
    if (!Array.isArray(rows)) {
      throw new Error(`list_items returned an invalid authoritative shape: ${JSON.stringify(rows).slice(0, 600)}`);
    }
    return rows;
  }
  const view = await session.call("the_outline", "tree_view", [], signal);
  if (!isRecord(view) || !Array.isArray(view.items) || !Number.isSafeInteger(view.structure_at_seq)) {
    throw new Error(`tree_view returned an invalid authoritative shape: ${JSON.stringify(view).slice(0, 600)}`);
  }
  return view.items;
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("operation aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("operation aborted");
}

function observationSummary(obs: Record<string, any>): string {
  const fields = ["type", "actor", "source", "room", "origin", "destination", "exit", "target"]
    .map((key) => obs[key] === undefined ? null : `${key}=${String(obs[key])}`)
    .filter((item): item is string => item !== null);
  return `{${fields.join(",")}}`;
}
