#!/usr/bin/env tsx
// smoke-walkthrough — comprehensive two-actor walkthrough against a deployed
// woah worker over MCP HTTP. Each step asserts that an observation emitted by
// `alice` lands in `bob`'s MCP wait queue (or vice versa). This is the cross-
// actor coverage the narrow `smoke:mcp` test does not provide: room moves
// across scopes (Bug A regression bait), pinboard cross-actor (Bug C
// regression bait), outliner presence aside, and tasks `:enter` smoke.
//
// Usage:
//   npm run smoke:walkthrough -- [--base=<url>] [--run-id=<id>] [--verbose]
//
// Defaults:
//   --base    https://woah.generalbusiness.ai
//   --run-id  <timestamp>-<rand>
//
// Exit status: 0 if every step passes, 1 if any step fails. The script keeps
// going after a failed step so a single broken slice doesn't mask later
// problems.
//
// All 9 steps pass against the deployed worker. The walkthrough exercises:
//
//   - Same-scope chat say (baseline; broken cross-actor delivery would
//     surface as a regression here first).
//   - Cross-scope move out (alice southeast — bob in source room sees
//     `left`). Regression bait for Bug A's source-side gateway fan-out.
//   - Cross-scope move back (alice west — bob in destination room sees
//     `entered`). Regression bait for Bug A's destination-side fan-out
//     and Bug C's gateway-owned reachability post-hibernation.
//   - Pinboard cross-actor (alice add_note → bob sees note_added). Same
//     code path that silently failed on hibernated CommitScopeDOs.
//   - Outliner: roster row shape on :enter reply, then cross-actor
//     add_item delivery.
//   - Taskboard: cross-room `entered` reaches a peer already inside.
//
// Earlier investigation notes (kept for context — every issue listed in
// pre-fix versions of this header turned out to be either a smoke defect
// or a misread of the demoworld map; none was a real product bug):
//
//   - "Actor not in observation audience" was a script bug: the smoke was
//     using a hardcoded `actor-${label}` fallback because MCP's initialize
//     response doesn't carry an actor id. Fixed by resolving the actor
//     from the dynamic tool list at handshake time.
//   - "tool_exposed verbs unreachable" was the reachability gate working
//     as designed — verbs on `the_pinboard` / `the_taskboard` only enter
//     an actor's tool list once the actor is physically in the mount
//     room. `woo_focus` does not promote unreachable objects; it only
//     adds already-reachable ones to the working set.
//   - "the_garden:south" was a stale-manifest read on my part. In prod
//     the deck-south exit goes straight to the workshop registry, no
//     garden hop.

import { randomUUID } from "node:crypto";

type StepResult = { name: string; ok: boolean; ms: number; detail?: string };

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.base.replace(/\/+$/, "");
const runId = args.runId;
const verbose = args.verbose;

const results: StepResult[] = [];

async function main(): Promise<void> {
  console.log(`smoke-walkthrough base=${baseUrl} run=${runId}`);
  // Filter wrangler tail with: `wrangler tail --search=smoke-walkthrough/${runId}`
  // — `clientInfo.name` carries the run id and lands in MCP request logs as
  // `client_info.name`, so a tail can scope to exactly this invocation.
  console.log(`wrangler tail filter: clientInfo name = smoke-walkthrough/${runId}/<actor>`);

  // Open sessions inside try/finally so a partial open still runs cleanup on
  // whatever did succeed. Without this, a failing bob.open() leaks alice's
  // session for the remainder of the MCP idle timeout.
  let alice: McpSession | null = null;
  let bob: McpSession | null = null;
  try {
    alice = await McpSession.open(`guest:walkthrough-alice-${runId}`, "alice");
    bob = await McpSession.open(`guest:walkthrough-bob-${runId}`, "bob");
    await runWalkthrough(alice, bob);
  } finally {
    await Promise.allSettled([alice?.close(), bob?.close()]);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log();
  console.log(`summary: ${passed}/${results.length} steps passed${failed ? `, ${failed} failed` : ""}`);
  if (failed > 0) {
    for (const r of results.filter((r) => !r.ok)) console.error(`  FAIL ${r.name}: ${r.detail ?? "(no detail)"}`);
    process.exit(1);
  }
}

async function runWalkthrough(alice: McpSession, bob: McpSession): Promise<void> {
  // Both guests start in the_chatroom on the deployed demo world. Calling
  // :enter is defensively idempotent; an actor already there receives no
  // observation, an actor elsewhere is moved in.
  await step("enter:chatroom (alice)", async () => {
    await alice.call("the_chatroom", "enter", []);
  });
  await step("enter:chatroom (bob)", async () => {
    await bob.call("the_chatroom", "enter", []);
  });
  await drain(alice);
  await drain(bob);

  // Same-scope durable verb. Pre-presence-work this was the only thing
  // smoke:mcp asserted; we keep it as a baseline because a regression here
  // means the whole cross-actor path is broken.
  await step("chat:say reaches peer", async () => {
    const text = `walkthrough-say-${runId}`;
    await alice.call("the_chatroom", "say", [text]);
    await waitFor(bob, (obs) => obs.type === "said" && typeof obs.text === "string" && obs.text.includes(text));
  });

  // Cross-scope move out. Alice leaves the_chatroom for the_deck; Bob (still
  // in the_chatroom) must receive a `left` observation. Source side of the
  // move — same scope as the commit. The room navigation verb is the exit's
  // `:move` reached via the catalog's obvious-verb wiring; MCP dispatches it
  // when the actor is in the source room. Latency in prod can run several
  // seconds for the durable round-trip, so we widen the wait.
  await step("move:southeast emits `left` to bob (origin room)", async () => {
    await alice.call("the_chatroom", "southeast", []);
    // Tighter predicate: only the `left` that actually came from this move.
    // A loose `type === "left"` would also satisfy itself with a stale
    // departure event from earlier navigation or a peer in this scope.
    await waitFor(bob, (obs) =>
      obs.type === "left" &&
      obs.actor === alice.actor &&
      obs.source === "the_chatroom" &&
      obs.destination === "the_deck" &&
      obs.exit === "southeast",
    10_000);
  });

  // The other side of the move: alice is now in the_deck (her commit scope).
  // She moves back to the_chatroom. The commit happens in the_deck; bob's
  // session is still in the_chatroom. Before Bug A / Bug C this delivery
  // path returned nothing — the gateway-owned commit fan-out across affected
  // scopes is what makes it work.
  await step("move:west emits `entered` to bob (destination room)", async () => {
    await alice.call("the_deck", "west", []);
    await waitFor(bob, (obs) =>
      obs.type === "entered" &&
      obs.actor === alice.actor &&
      obs.source === "the_chatroom" &&
      obs.origin === "the_deck" &&
      obs.exit === "west",
    10_000);
  });

  // Tool-space tests: each tool space (pinboard, outliner, taskboard) is
  // mounted in a specific room. The MCP reachability gate hides the tool's
  // `enter` verb until the actor is physically in that room — `woo_focus`
  // is *not* a global escape hatch, only a working-set promotion for things
  // already reachable. So we move both actors there before the assertion.

  // Pinboard is mounted in the_deck. Bring bob alongside alice (alice came
  // back to the_chatroom after the `entered` step) and walk both into the
  // pinboard.
  await step("pinboard:add_note reaches peer", async () => {
    await alice.call("the_chatroom", "southeast", []);
    await bob.call("the_chatroom", "southeast", []);
    await drain(alice);
    await drain(bob);
    // `the_deck:enter the_pinboard` is the cross-room-enter form; it can
    // fail with scope_mismatch if the actor's session isn't routed for the
    // sequenced enter (see memory: cross_scope_enter_route_sequenced).
    // The `pinboard:enter` below is the canonical entry, so we tolerate
    // this opportunistic warm-up failing but log it instead of swallowing.
    try {
      await alice.call("the_deck", "enter", ["the_pinboard"]);
    } catch (err) {
      console.warn(`alice deck:enter the_pinboard warm-up failed: ${(err as Error).message}`);
    }
    await alice.call("the_pinboard", "enter", []);
    await bob.call("the_pinboard", "enter", []);
    await drain(alice);
    await drain(bob);
    const text = `pinboard-${runId}`;
    await alice.call("the_pinboard", "add_note", [text, "yellow", 32, 32, 200, 120]);
    await waitFor(bob, (obs) =>
      obs.type === "note_added" &&
      isRecord(obs.note) &&
      typeof obs.note.text === "string" &&
      obs.note.text.includes(text),
      10_000
    );
  });

  // Outliner is mounted in the_chatroom, so both actors come back west
  // (deck → chatroom). The `:enter` reply returns the roster directly, so
  // we assert the row shape on its result rather than calling :room_roster
  // (which is direct_callable but intentionally not tool_exposed).
  await step("outliner:enter result includes a roster row for alice", async () => {
    // Only call leave if the actor is actually in the pinboard right now —
    // see McpSession.leaveIfIn. If the upstream `pinboard:enter` failed,
    // they're not in the pinboard, and calling leave from the wrong room
    // (silently swallowed by the old .catch) masked a real E_VERBNF.
    await alice.leaveIfIn("the_pinboard");
    await bob.leaveIfIn("the_pinboard");
    // Similarly: only walk west if we're actually on the deck. If we never
    // made it onto the deck, we're (probably) still in the chatroom — skip
    // the move so the smoke doesn't generate a stale E_VERBNF here.
    if (alice.currentRoom === "the_deck") await alice.call("the_deck", "west", []);
    if (bob.currentRoom === "the_deck") await bob.call("the_deck", "west", []);
    await drain(alice);
    await drain(bob);
    const aliceEnter = await alice.call("the_outline", "enter", []);
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

  await step("outliner:add_item reaches peer", async () => {
    await bob.call("the_outline", "enter", []);
    await drain(alice);
    await drain(bob);
    const text = `outline-${runId}`;
    await alice.call("the_outline", "add_item", [text]);
    await waitFor(bob, (obs) => obs.type === "outline_item_added" && obs.text === text, 10_000);
  });

  // Taskboard navigation: chatroom -> southeast -> the_deck -> south toward
  // the_taskboard. Local demoworld still routes deck south through
  // the_garden, while production may route directly to the workshop registry.
  // The helper follows the extra garden hop only when the first move lands
  // there, then asserts the actor reached the taskboard.
  await step("tasks: cross-room `entered` reaches peer", async () => {
    // Same guard pattern as outliner:enter — only leave if we're in the
    // outline; only southeast if we're in the chatroom. Without these
    // guards a transient failure in the previous step cascades into
    // E_VERBNF on the wrong-room verb here, which masks the real cause.
    await alice.leaveIfIn("the_outline");
    await bob.leaveIfIn("the_outline");
    if (alice.currentRoom === "the_chatroom") await alice.call("the_chatroom", "southeast", []);
    if (bob.currentRoom === "the_chatroom") await bob.call("the_chatroom", "southeast", []);
    await walkSouthToTaskboard(alice);
    await drain(alice);
    await drain(bob);
    await walkSouthToTaskboard(bob);
    await waitFor(alice, (obs) =>
      obs.type === "entered" &&
      obs.actor === bob.actor &&
      obs.source === "the_taskboard",
    10_000);
  });
}

async function walkSouthToTaskboard(session: McpSession): Promise<void> {
  if (session.currentRoom !== "the_deck") {
    throw new Error(`${session.label} expected on the_deck before south; at=${session.currentRoom}`);
  }
  await session.call("the_deck", "south", []);
  if (session.currentRoom === "the_garden") {
    await session.call("the_garden", "south", []);
  }
  if (session.currentRoom !== "the_taskboard") {
    throw new Error(`${session.label} expected on the_taskboard after south path; at=${session.currentRoom}`);
  }
}

// Step-level watchdog. Even if every per-RPC fetch has a deadline, a step
// that loops over many short calls could still drift long. The watchdog is
// the hard upper bound and aborts the body if the step itself is stuck.
const STEP_TIMEOUT_MS = 60_000;
async function step(name: string, body: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  try {
    await raceWithTimeout(
      body(),
      STEP_TIMEOUT_MS,
      `step "${name}" exceeded ${STEP_TIMEOUT_MS}ms watchdog`
    );
    const ms = Date.now() - startedAt;
    results.push({ name, ok: true, ms });
    console.log(`  ok    ${name} (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - startedAt;
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, ms, detail });
    console.error(`  FAIL  ${name} (${ms}ms): ${detail}`);
  }
}

function raceWithTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (handle) clearTimeout(handle);
  });
}

// Drain pending observations from a session's wait queue so the next
// assertion only sees events emitted after this point. The deployed fan-out
// can take 1–2 seconds in tail percentiles, so a single 250ms poll is too
// optimistic — keep polling until either the queue reports empty (zero
// observations) or a bounded budget elapses. Errors are swallowed; drain is
// best-effort cleanup and must not fail a step.
const DRAIN_TOTAL_BUDGET_MS = 3000;
const DRAIN_POLL_MS = 500;
async function drain(session: McpSession): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < DRAIN_TOTAL_BUDGET_MS) {
    try {
      const result = await session.callTool("woo_wait", { timeout_ms: DRAIN_POLL_MS, limit: 100 });
      const obs = waitObservationsOf(result);
      if (obs.length === 0) return;
      if (verbose) console.log(`    [${session.label}] drained ${obs.length} stale obs: ${obs.map((o: any) => o.type).join(",")}`);
    } catch {
      return;
    }
  }
}

// Poll `woo_wait` until `match` returns true for one of the observations, or
// the cumulative timeout elapses. The deployed wait queue holds observations
// briefly, so we poll in short increments and re-check rather than blocking
// on one long wait — keeps the script responsive when the run is healthy.
async function waitFor(
  session: McpSession,
  match: (obs: Record<string, any>) => boolean,
  totalTimeoutMs = 5000
): Promise<Record<string, any>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < totalTimeoutMs) {
    const remaining = totalTimeoutMs - (Date.now() - startedAt);
    const result = await session.callTool("woo_wait", { timeout_ms: Math.min(remaining, 1000), limit: 100 });
    const observations = waitObservationsOf(result);
    if (verbose && observations.length) {
      console.log(`    [${session.label}] received ${observations.length} obs: ${observations.map((o: any) => o.type).join(",")}`);
    }
    for (const obs of observations) {
      if (isRecord(obs) && match(obs)) return obs;
    }
  }
  throw new Error(`timeout after ${totalTimeoutMs}ms waiting for matching observation`);
}

class McpSession {
  private nextId = 2;
  // Tracked client-side from every move-style response that carries a `room`
  // field in its structuredContent.result. The smoke walkthrough used to
  // silently `.catch(() => undefined)` the leave verbs that close out one
  // tool space before walking somewhere else; when the underlying enter had
  // failed earlier (cold-start transient, slice timeout, etc.), the leave
  // was a no-op, the *next* directional verb was issued from the wrong
  // assumed room, and the server returned E_VERBNF — a false negative that
  // masked the real failure. Track the last-known room so the smoke can
  // gate its leaves on actually being there.
  currentRoom: string | null = null;

  private constructor(
    readonly sessionId: string,
    readonly actor: string,
    readonly label: string
  ) {}

  static async open(token: string, label: string): Promise<McpSession> {
    // `clientInfo.name` is logged server-side as `client_info.name` on every
    // MCP request, so encoding the runId here lets a wrangler tail filter
    // narrow to exactly this invocation: `--search smoke-walkthrough/<runId>`.
    const response = await mcpFetch({
      method: "POST",
      headers: { "mcp-token": token },
      body: rpc(1, "initialize", initializeParams(`smoke-walkthrough/${runId}/${label}`))
    });
    if (!response.ok) throw new Error(`MCP initialize failed: ${response.status} ${await response.text().catch(() => "")}`);
    const sessionId = response.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("MCP initialize response missing mcp-session-id");
    // Drain the initialize result envelope (and confirm it parses) before
    // emitting notifications/initialized, mirroring the SDK handshake order.
    await parseMcpResponse(response);

    // Actor id is not in the initialize response shape; resolve it from the
    // dynamic tool list, where every actor-control tool is prefixed
    // `${actor.id}:`. The first match is enough — they all share the prefix.
    // The reachability gate guarantees `${actor}:focus_list` (and friends)
    // are always present, so this is a stable resolver.
    const session = new McpSession(sessionId, "", label);
    await mcpFetch({
      method: "POST",
      headers: { "mcp-session-id": sessionId },
      body: notification("notifications/initialized")
    });
    const tools = await session.callTool("woo_list_reachable_tools", {
      scope: "all",
      limit: 200
    });
    const list = (tools as any)?.result?.structuredContent?.result?.tools ?? [];
    const selfTool = list.find((t: any) => typeof t?.object === "string" && /^guest_/.test(t.object) && (t.verb === "focus_list" || t.verb === "focus" || t.verb === "wait"));
    if (!selfTool || typeof selfTool.object !== "string") {
      throw new Error(`could not resolve actor for ${label} from tool list (saw ${list.length} tools)`);
    }
    (session as { actor: string }).actor = selfTool.object;
    return session;
  }

  async call(object: string, verb: string, verbArgs: unknown[]): Promise<unknown> {
    const result = unwrap(await this.callRaw(object, verb, verbArgs));
    // Move/enter/leave responses carry `room` in structuredContent.result.
    // Update tracked room from every successful call so guarded helpers
    // below can avoid calling leave/direction verbs from the wrong room.
    if (isRecord(result) && typeof result.room === "string") this.currentRoom = result.room;
    return result;
  }

  // Call `verb` on `space` only if our tracked location matches `space`.
  // Used to close out a tool space (`pinboard:leave`, `outline:leave`) where
  // an earlier `enter` may have failed; calling the leave verb from a room
  // we never reached generates a confusing E_VERBNF that masks the real
  // upstream failure. Returns true if the leave actually fired.
  async leaveIfIn(space: string): Promise<boolean> {
    if (this.currentRoom !== space) return false;
    try {
      await this.call(space, "leave", []);
      return true;
    } catch (err) {
      // Surface (don't swallow) — a leave that fails despite our location
      // tracking saying we're there is a real signal, not noise.
      console.warn(`leave ${space} failed for ${this.label} at ${this.currentRoom}: ${(err as Error).message}`);
      return false;
    }
  }

  async callRaw(object: string, verb: string, verbArgs: unknown[]): Promise<any> {
    return await this.callTool("woo_call", { object, verb, args: verbArgs });
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<any> {
    const response = await mcpFetch({
      method: "POST",
      headers: { "mcp-session-id": this.sessionId },
      body: rpc(this.nextId++, "tools/call", { name, arguments: params })
    });
    if (!response.ok) throw new Error(`tools/call ${name} ${response.status}: ${await response.text().catch(() => "")}`);
    const body = await parseMcpResponse(response);
    // JSON-RPC envelope errors (transport / protocol level — e.g. unknown
    // session, malformed request) surface as `body.error` and would otherwise
    // be swallowed: parseMcpResponse returns the envelope, every caller
    // reaches into `result.*` and finds undefined. Make it loud here.
    if (body && typeof body === "object" && "error" in body && body.error) {
      const err = body.error as any;
      throw new Error(`tools/call ${name} JSON-RPC error: ${JSON.stringify(err)}`);
    }
    return body;
  }

  async close(): Promise<void> {
    await mcpFetch({
      method: "DELETE",
      headers: { "mcp-session-id": this.sessionId }
    }).catch(() => undefined);
  }
}

function unwrap(body: any): unknown {
  if (body?.result?.isError) {
    const sc = body.result.structuredContent;
    throw new Error(`MCP tool error: ${JSON.stringify(sc ?? body.result, null, 2)}`);
  }
  return body?.result?.structuredContent?.result;
}

function waitObservationsOf(body: any): unknown[] {
  return body?.result?.structuredContent?.result?.observations ?? [];
}

// Hard per-RPC deadline. The worker should normally respond in under a
// second; the only reason to wait longer is the woo_wait long-poll, which
// peaks around 1000ms. 20s leaves multiple seconds of headroom even for
// p99 fanout latency and ensures a stuck connection cannot strand the
// step watchdog (which has its own 60s envelope).
const RPC_TIMEOUT_MS = 20_000;

async function mcpFetch(input: {
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<Response> {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    ...input.headers
  });
  let body: BodyInit | undefined;
  if (input.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(input.body);
  }

  // Compose the caller's optional signal with our timeout signal so either
  // an explicit abort or the deadline tears the request down promptly.
  const timeoutMs = input.timeoutMs ?? RPC_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error(`MCP request exceeded ${timeoutMs}ms deadline`)), timeoutMs);
  const signal = mergeSignals(input.signal, timeoutController.signal);

  try {
    return await fetch(`${baseUrl}/mcp`, {
      method: input.method,
      headers,
      body,
      signal
    });
  } catch (err) {
    if (timeoutController.signal.aborted) {
      throw new Error(`MCP ${input.method} ${baseUrl}/mcp timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  // AbortSignal.any is widely available on modern Node, but fall back to a
  // manual relay if the runtime is older — the script targets tsx so this
  // should never trip in CI, but the fallback keeps developer machines safe.
  const anyImpl = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyImpl === "function") return anyImpl([a, b]);
  const merged = new AbortController();
  const relay = () => merged.abort();
  if (a.aborted) merged.abort();
  else a.addEventListener("abort", relay, { once: true });
  if (b.aborted) merged.abort();
  else b.addEventListener("abort", relay, { once: true });
  return merged.signal;
}

async function parseMcpResponse(response: Response): Promise<any> {
  if (response.status === 202 || response.status === 204) return null;
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!text) return null;
  if (contentType.includes("text/event-stream")) {
    const data = text.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice("data:".length).trim();
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(text);
}

function initializeParams(name: string): Record<string, unknown> {
  return {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name, version: "0.0.0" }
  };
}

function rpc(id: number, method: string, params?: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params })
  };
}

function notification(method: string, params?: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method,
    ...(params === undefined ? {} : { params })
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseArgs(argv: string[]): { base: string; runId: string; verbose: boolean } {
  let base = process.env.WOO_SMOKE_BASE_URL ?? "https://woah.generalbusiness.ai";
  let runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  let verbose = false;
  for (const arg of argv) {
    if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg.startsWith("--base=")) base = arg.slice("--base=".length);
    else if (arg.startsWith("--run-id=")) runId = arg.slice("--run-id=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: tsx scripts/smoke-walkthrough.ts [--base=<url>] [--run-id=<id>] [--verbose]");
      process.exit(0);
    }
  }
  return { base, runId, verbose };
}

main().catch((err) => {
  console.error("walkthrough crashed:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(2);
});
