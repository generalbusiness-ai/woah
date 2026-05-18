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
// Currently-known failures on prod (each is a real product gap to track, not a
// script defect):
//
//   1. move:southeast emits `left` to bob — alice's `the_chatroom:southeast`
//      MCP call returns without error but neither moves alice nor emits the
//      `left` observation bob is waiting for. The exit's :move verb is
//      direct_callable but not tool_exposed, and the catalog's obvious-verb
//      routing that resolves `room:<exit-name>` to the exit isn't wired
//      through MCP woo_call. This blocks any MCP-driven navigation.
//   2. move:west emits `entered` to bob — depends on #1 actually moving alice.
//   3. pinboard / tasks :enter — `reachable MCP tool not found` even after
//      woo_focus. The reachability gate keeps tool_exposed :enter verbs
//      hidden when the target's location isn't on the actor's reachable
//      neighborhood. Mounting and focus aren't enough; MCP needs an explicit
//      promotion path.
//   4. outliner:look_self — same gating reason. :look_self IS tool_exposed,
//      yet not reachable from inside the_outline scope. Probably the same
//      reachability gate bug as the others.
//
// The two baseline steps that PASS today (chat:say cross-actor, outliner:
// add_item cross-actor) are the regression bait for the presence/fanout work
// just landed. If either regresses, the rest of the suite is academic.

import { randomUUID } from "node:crypto";

type StepResult = { name: string; ok: boolean; ms: number; detail?: string };

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.base.replace(/\/+$/, "");
const runId = args.runId;
const verbose = args.verbose;

const results: StepResult[] = [];

async function main(): Promise<void> {
  console.log(`smoke-walkthrough base=${baseUrl} run=${runId}`);
  const alice = await McpSession.open(`guest:walkthrough-alice-${runId}`, "alice");
  const bob = await McpSession.open(`guest:walkthrough-bob-${runId}`, "bob");
  try {
    await runWalkthrough(alice, bob);
  } finally {
    await Promise.allSettled([alice.close(), bob.close()]);
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
    await waitFor(bob, (obs) => obs.type === "left" && obs.actor === alice.actor, 10_000);
  });

  // The other side of the move: alice is now in the_deck (her commit scope).
  // She moves back to the_chatroom. The commit happens in the_deck; bob's
  // session is still in the_chatroom. Before Bug A / Bug C this delivery
  // path returned nothing — the gateway-owned commit fan-out across affected
  // scopes is what makes it work.
  await step("move:west emits `entered` to bob (destination room)", async () => {
    await alice.call("the_deck", "west", []);
    await waitFor(bob, (obs) => obs.type === "entered" && obs.actor === alice.actor, 10_000);
  });

  // The remaining tool spaces (pinboard / outliner / tasks) live in
  // catalog-mounted scopes that the MCP reachability gate hides until the
  // actor `:woo_focus`-es on them. The focus tool promotes the target onto
  // the session's reachable set so `enter` / `add_note` / `add_item` become
  // dispatchable. Skipping focus reproduces the deployed "verb not found"
  // error rather than the actual smoke we're trying to catch.

  // Pinboard cross-actor. Both focus, both enter, alice adds a note, bob
  // waits for `note_added`. Before Bug C's fix this could silently fail
  // when the_pinboard's CommitScopeDO had hibernated between opens.
  await step("pinboard:add_note reaches peer", async () => {
    await Promise.all([
      alice.callTool("woo_focus", { target: "the_pinboard" }),
      bob.callTool("woo_focus", { target: "the_pinboard" })
    ]);
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

  // Outliner cross-actor: both focus + enter; alice adds an item; bob sees
  // the structural observation.
  await step("outliner:add_item reaches peer", async () => {
    await Promise.all([
      alice.callTool("woo_focus", { target: "the_outline" }),
      bob.callTool("woo_focus", { target: "the_outline" })
    ]);
    await alice.call("the_outline", "enter", []);
    await bob.call("the_outline", "enter", []);
    await drain(alice);
    await drain(bob);
    const text = `outline-${runId}`;
    await alice.call("the_outline", "add_item", [text]);
    await waitFor(bob, (obs) => obs.type === "outline_item_added" && obs.text === text, 10_000);
  });

  // :room_roster is direct-callable but not tool_exposed (intentional —
  // hidden from MCP agents). Use :look_self instead, which IS tool_exposed
  // and returns the roster as part of its summary result. Same coverage of
  // the row shape the outliner-presence aside renders.
  await step("outliner:look_self exposes a roster with both actors", async () => {
    const summary = unwrap(await alice.callRaw("the_outline", "look_self", []));
    if (!isRecord(summary) || !Array.isArray(summary.roster)) {
      throw new Error(`expected roster array on look_self result; got ${JSON.stringify(summary).slice(0, 200)}`);
    }
    const rows = summary.roster.filter(isRecord);
    const ids = new Set(rows.map((row) => String(row.id ?? "")));
    if (!ids.has(alice.actor) || !ids.has(bob.actor)) {
      throw new Error(`roster missing actor(s); ids=${[...ids].join(",")} expected alice=${alice.actor} bob=${bob.actor}`);
    }
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.name !== "string") {
        throw new Error(`row missing id/name shape: ${JSON.stringify(row)}`);
      }
    }
  });

  // Tasks: both focus, alice enters first, bob enters; alice (already in)
  // sees bob's `entered`. The `entered`/`left` observation is what the
  // kanban presence aside listens to.
  await step("tasks:enter emits `entered` to peer", async () => {
    await Promise.all([
      alice.callTool("woo_focus", { target: "the_taskboard" }),
      bob.callTool("woo_focus", { target: "the_taskboard" })
    ]);
    await alice.call("the_taskboard", "enter", []);
    await drain(alice);
    await drain(bob);
    await bob.call("the_taskboard", "enter", []);
    await waitFor(alice, (obs) => obs.type === "entered" && obs.actor === bob.actor, 10_000);
  });
}

async function step(name: string, body: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  try {
    await body();
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

// Drain pending observations from a session's wait queue so the next assertion
// only sees events emitted after this point. Best-effort; a short timeout is
// enough — anything older that hasn't landed in ~250ms isn't going to.
async function drain(session: McpSession): Promise<void> {
  await session.callTool("woo_wait", { timeout_ms: 250, limit: 100 }).catch(() => undefined);
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

  private constructor(
    readonly sessionId: string,
    readonly actor: string,
    readonly label: string
  ) {}

  static async open(token: string, label: string): Promise<McpSession> {
    const response = await mcpFetch({
      method: "POST",
      headers: { "mcp-token": token },
      body: rpc(1, "initialize", initializeParams(`smoke-walkthrough-${label}`))
    });
    if (!response.ok) throw new Error(`MCP initialize failed: ${response.status} ${await response.text().catch(() => "")}`);
    const sessionId = response.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("MCP initialize response missing mcp-session-id");
    // Drain the initialize result envelope (and confirm it parses) before
    // emitting notifications/initialized, mirroring the SDK handshake order.
    const init = await parseMcpResponse(response);
    const actor = String(init?.result?.serverInfo?.actor ?? init?.result?.actor ?? "");

    const session = new McpSession(sessionId, actor || `actor-${label}`, label);
    await mcpFetch({
      method: "POST",
      headers: { "mcp-session-id": sessionId },
      body: notification("notifications/initialized")
    });
    // Resolve actor via /api/me-style probe: ask describe self on $system,
    // which returns the calling actor's id. The initialize response shape
    // does not include actor on the deployed worker. Best-effort; if this
    // fails, the label-based fallback above is still useful for diagnostics.
    if (!actor) {
      const probe = await session.callTool("woo_call", {
        object: "$system",
        verb: "describe",
        args: []
      }).catch(() => null);
      const result = (probe as any)?.result?.structuredContent?.result;
      if (isRecord(result) && typeof result.actor === "string") {
        (session as { actor: string }).actor = result.actor;
      }
    }
    return session;
  }

  async call(object: string, verb: string, verbArgs: unknown[]): Promise<unknown> {
    return unwrap(await this.callRaw(object, verb, verbArgs));
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
    return await parseMcpResponse(response);
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

async function mcpFetch(input: {
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
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
  return await fetch(`${baseUrl}/mcp`, {
    method: input.method,
    headers,
    body,
    signal: input.signal
  });
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
