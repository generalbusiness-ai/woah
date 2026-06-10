// Shared smoke scenario — the ordered two-actor cross-actor walkthrough,
// expressed ONCE and run by every lane. Each step asserts that an observation
// emitted by one actor lands in the other's MCP wait queue (or that a verb
// reply carries the expected shape). This is the cross-actor coverage the
// narrow single-call smoke does not provide: cross-scope moves, take/drop
// fanout, pinboard/outliner/tasks tool-space collaboration.
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

  // Both guests start in the_chatroom on the demo world. `:enter` is
  // defensively idempotent; an actor already there receives no observation.
  await step("enter:chatroom (alice)", async (ctx) => {
    await pair.alice.call("the_chatroom", "enter", [], ctx.signal);
  });
  await step("enter:chatroom (bob)", async (ctx) => {
    await pair.bob.call("the_chatroom", "enter", [], ctx.signal);
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
  // the_deck and enters the_pinboard from the new scope, assert that the
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
    await step("tool-surface-after-move: add_note reachable after entering pinboard from new scope", async (ctx) => {
      const { alice } = pair;
      // Precondition: alice must be in the_deck to enter the_pinboard.
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
        await alice.call("the_pinboard", "enter", [], ctx.signal);
        await drain(alice, cfg, ctx.signal);
        // Assert add_note is reachable via the tool list. We use woo_list_reachable_tools
        // rather than calling the verb so that a missing tool-surface entry is
        // distinguishable from an argument/auth error. The minimum acceptance bar
        // is that add_note appears in the reachable-tools list at all — the existing
        // pinboard:add_note step (always run, not gated) covers functional correctness.
        const toolsResult = await alice.callTool("woo_list_reachable_tools", { scope: "all", limit: 200 }, { signal: ctx.signal });
        const toolsList: unknown[] = (toolsResult as any)?.result?.structuredContent?.result?.tools ?? [];
        const addNoteTool = toolsList.find((t: any) => isRecord(t) && t.object === "the_pinboard" && t.verb === "add_note");
        if (!addNoteTool) {
          const pinboardTools = toolsList
            .filter((t: any) => isRecord(t) && String(t.object ?? "").includes("pinboard"))
            .map((t: any) => String((t as any).verb ?? "?"));
          throw new Error(
            `tool-surface-after-move: the_pinboard:add_note not in reachable tools after scope-crossing enter; ` +
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

  // Tool spaces: each is mounted in a specific room and the MCP reachability
  // gate hides its `enter` verb until the actor is physically in that room, so
  // we move both actors there before the assertion. Pinboard is mounted in
  // the_deck.
  await step("pinboard:add_note reaches peer", async (ctx) => {
    const { alice, bob } = pair;
    await alice.call("the_chatroom", "southeast", [], ctx.signal);
    await bob.call("the_chatroom", "southeast", [], ctx.signal);
    await drain(alice, cfg, ctx.signal);
    await drain(bob, cfg, ctx.signal);
    // `the_deck:enter the_pinboard` is the cross-room-enter form; tolerate it
    // failing (scope_mismatch on an unrouted session) as an opportunistic
    // route/manifest warm-up — the canonical `the_pinboard:enter` below is the
    // real assertion.
    try {
      await alice.call("the_deck", "enter", ["the_pinboard"], ctx.signal);
    } catch (err) {
      cfg.log?.(`alice deck:enter the_pinboard warm-up failed: ${(err as Error).message}`);
    }
    await alice.call("the_pinboard", "enter", [], ctx.signal);
    await bob.call("the_pinboard", "enter", [], ctx.signal);
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

  // Outliner is mounted in the_chatroom, so both actors come back west. The
  // `:enter` reply returns the roster directly, so we assert the row shape on
  // its result rather than calling :room_roster (direct_callable but not
  // tool_exposed).
  await step("outliner:enter result includes a roster row for alice", async (ctx) => {
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
    const aliceEnter = await alice.call("the_outline", "enter", [], ctx.signal);
    if (!isRecord(aliceEnter) || !Array.isArray(aliceEnter.roster)) {
      throw new Error(`expected roster array on the_outline:enter result; got ${JSON.stringify(aliceEnter).slice(0, 200)}`);
    }
    const rows = aliceEnter.roster.filter(isRecord);
    const ids = new Set(rows.map((row) => String(row.id ?? "")));
    if (!ids.has(alice.actor)) {
      throw new Error(`alice not in her own enter roster; ids=${[...ids].join(",")} expected alice=${alice.actor}`);
    }
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.name !== "string") {
        throw new Error(`row missing id/name shape: ${JSON.stringify(row)}`);
      }
    }
  });

  await step("outliner:add_item reaches peer", async (ctx) => {
    const { alice, bob } = pair;
    await bob.call("the_outline", "enter", [], ctx.signal);
    await drain(alice, cfg, ctx.signal);
    await drain(bob, cfg, ctx.signal);
    const text = `outline-${runId}`;
    await alice.call("the_outline", "add_item", [text], ctx.signal);
    await waitFor(bob, (obs) => obs.type === "outline_item_added" && obs.text === text, waitMs, ctx.signal, cfg);
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

// Drain pending observations from a session's wait queue so the next assertion
// only sees events emitted after this point. The deployed fan-out can take 1–2s
// at tail percentiles, so poll until the queue reports empty or the budget
// elapses. Best-effort cleanup — errors are swallowed and must not fail a step.
async function drain(session: SmokeSession, cfg: DrainConfig, signal?: AbortSignal): Promise<void> {
  const started = Date.now();
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
async function waitFor(
  session: SmokeSession,
  match: (obs: Record<string, any>) => boolean,
  totalTimeoutMs: number,
  signal: AbortSignal | undefined,
  cfg: DrainConfig
): Promise<Record<string, any>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < totalTimeoutMs) {
    throwIfAborted(signal);
    const remaining = totalTimeoutMs - (Date.now() - startedAt);
    const result = await session.callTool("woo_wait", { timeout_ms: Math.min(remaining, 1000), limit: 100 }, { signal });
    const observations = waitObservationsOf(result);
    if (observations.length) {
      cfg.log?.(`    [${session.label}] received ${observations.length} obs: ${observations.map((o: any) => o.type).join(",")}`);
    }
    for (const obs of observations) {
      if (isRecord(obs) && match(obs)) return obs;
    }
  }
  throw new Error(`timeout after ${totalTimeoutMs}ms waiting for matching observation`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("operation aborted");
}
