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
// Two flags select the small differences between lanes:
//   - includeTakeDrop: the same-room mug take/drop step. ON for the deployed
//     and workerd lanes; OFF for the dangling-ref-gated fake lane (a take on a
//     $portable object emits dangling_parent_ref until $portable lineage reaches
//     the gateway-shard slice — see cf-local-walkthrough.test.ts).
//   - includeConcurrentMove: the B6 concurrent-through-shared-destination step.
//     ON for the fake lane (it pairs with that lane's coherence-invariant
//     ratchet); optional elsewhere.

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
