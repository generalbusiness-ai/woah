import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { CommitScopeDO } from "../../src/worker/commit-scope-do";
import { DirectoryDO } from "../../src/worker/directory-do";
import { MCP_GATEWAY_ACTOR_SUPPORT_ROOTS, PersistentObjectDO, type Env } from "../../src/worker/persistent-object-do";
import { createWorld } from "../../src/core/bootstrap";
import type { ObjRef } from "../../src/core/types";
import { FakeDurableObjectNamespace, FakeDurableObjectState } from "./fake-do";

// Derive the universal actor/thing lineage the gateway-shard support set MUST
// carry, the same way production does: the parent-closure of
// MCP_GATEWAY_ACTOR_SUPPORT_ROOTS over the bootstrap seed (no catalogs). Derived,
// not hardcoded, so the guard tracks the seed lineage if it changes.
function seedDerivedUniversalLineage(): Set<ObjRef> {
  const snapshot = createWorld({ catalogs: false }).exportWorld();
  const byId = new Map(snapshot.objects.map((obj) => [obj.id, obj] as const));
  const ids = new Set<ObjRef>();
  const subtree = [...MCP_GATEWAY_ACTOR_SUPPORT_ROOTS];
  while (subtree.length > 0) {
    const id = subtree.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const child of byId.get(id)?.children ?? []) subtree.push(child);
  }
  for (const root of MCP_GATEWAY_ACTOR_SUPPORT_ROOTS) {
    let current: ObjRef | null = byId.get(root)?.parent ?? null;
    while (current && !ids.has(current)) {
      ids.add(current);
      current = byId.get(current)?.parent ?? null;
    }
  }
  return ids;
}

vi.setConfig({ testTimeout: 180_000 });

const SHARDS = 4;
const RPC_TIMEOUT_MS = 20_000;
const STEP_TIMEOUT_MS = 60_000;
const DRAIN_TOTAL_BUDGET_MS = 3000;
const DRAIN_POLL_MS = 500;

class FakeKVNamespace {
  readonly values = new Map<string, string>();

  async get(key: string, _type?: "text"): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

class WaitUntilDurableObjectState extends FakeDurableObjectState {
  readonly waitUntilPromises: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.waitUntilPromises.push(Promise.resolve(promise));
  }

  async drainWaitUntil(): Promise<void> {
    await Promise.all(this.waitUntilPromises.splice(0));
  }
}

type CfSmokeHarness = {
  env: Env;
  request(path: string, init: RequestInit): Promise<Response>;
  close(): void;
};

describe("CF-local smoke walkthrough", () => {
  it("covers cross-shard MCP movement and tool-space fanout through Worker Durable Object shape", async () => {
    const harness = createCfSmokeHarness();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runId = `cf-local-${Date.now()}-${randomUUID().slice(0, 8)}`;
    let alice: LocalMcpSession | null = null;
    let bob: LocalMcpSession | null = null;
    try {
      alice = await LocalMcpSession.open(harness, `guest:cf-local-alice-${runId}`, "alice", runId);
      bob = await openOnDifferentShard(harness, alice, runId);
      await runWalkthrough(alice, bob);
      // Regression guard for the gateway-shard lineage gap (perf-plan steps
      // 1-2): MCP planning must never run against a sparse relay snapshot that
      // dangles either universal actor support ($system/$guest/...) or
      // scope/catalog classes ($chatroom/$note/...). Those rows must be present
      // before local VM planning, or the turn fails locally before authority
      // repair can act.
      const danglingParentRefs = logSpy.mock.calls
        .map((args) => args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))
        .filter((line) => line.includes("dangling_parent_ref"))
        .map((line) => ({
          start: /"start":"([^"]+)"/.exec(line)?.[1] ?? null,
          missing: /"missing":"([^"]+)"/.exec(line)?.[1] ?? null
        }));
      expect(
        danglingParentRefs.length,
        `gateway-shard planning emitted dangling_parent_ref after pre-plan authority repair: ${JSON.stringify(danglingParentRefs.slice(0, 5))}`
      ).toBe(0);

      // A1 — coherence-invariant (CI) gate for the mobile-heap target.
      // VTN0.Conformance: every node's derived view of a touched cell must equal
      // the committed authority at the same head; no two copies of a cell may be
      // mutated by independent write paths. A CI violation surfaces as a commit
      // rejection logged by CommitScopeDO ("woo.commit_rejected.errors", each
      // error naming the diverged `<object>.<cell>`). The step-level walkthrough
      // MASKS these: the turn retries and eventually succeeds, so the step passes
      // while a derived view silently disagreed with authority. This assertion is
      // the structural teeth VTN0 promises — it fails on "two copies disagreed"
      // by signature, even when retry papers over the symptom.
      //
      // RATCHET, not zero-tolerance-yet. The current base has ONE known CI-debt
      // class: the presence/containment PROJECTION cells (`subscribers`,
      // `session_subscribers`, `contents`) still sit on the commit-validation
      // path, so a cross-room turn can plan them stale and get rejected (e.g.
      // `the_outline:leave` rejecting on `the_chatroom.subscribers`). Step A4
      // (contents/presence-as-projection, off the validation path) RETIRES this
      // class; when A4 lands, KNOWN_CI_DEBT_CELLS empties and this becomes
      // zero-tolerance. Until then the gate fails on ANY OTHER rejection error —
      // a real authoritative cell (a property value, lineage, location), a verb
      // cell (`$tool:look`), a write-prior mismatch, a post_state_mismatch, or an
      // incomplete_transcript — so it cannot be used to launder NEW
      // multiplication. The allow-list MUST only ever shrink.
      const KNOWN_CI_DEBT_CELLS = new Set<string>([
        "subscribers",
        "session_subscribers",
        "contents"
      ]);
      // VTN0 conformance: parse the STRUCTURED commit-rejection log rather than
      // string-scanning the joined diagnostics. CommitScopeDO logs every
      // rejection as `console.log("woo.commit_rejected.errors", JSON)` whose
      // `errors` array carries one string per diverged cell (effect-transcript /
      // shadow-commit-scope `cellLabel`: `<object>.<cell>` for property/location/
      // contents/lifecycle, `<object>:<verb>` for verb cells). The gate fails on
      // EVERY error except a read/write-version mismatch on an allow-listed
      // projection cell — so write-prior mismatches, verb-cell divergence,
      // post_state_mismatch, incomplete_transcript, and any unrecognized error
      // string can no longer slip through a dot-form regex.
      const isAllowlistedProjectionMismatch = (error: string): boolean => {
        // Only read/write version/value mismatches name a cell as
        // `<object>.<cell>` with a dot. post_state_mismatch, incomplete_transcript,
        // and verb-cell (`<object>:<verb>`) errors never match this shape and so
        // are never excused. The object id carries no dot or colon, so the first
        // dot delimits the cell name.
        const m = /^(?:read (?:version|value) mismatch|write prior mismatch) [^\s:]+\.([A-Za-z0-9_]+)(?::|$)/.exec(error);
        return m !== null && KNOWN_CI_DEBT_CELLS.has(m[1]);
      };
      const ciOffenders: string[] = [];
      for (const call of logSpy.mock.calls) {
        if (call[0] !== "woo.commit_rejected.errors" || typeof call[1] !== "string") continue;
        let parsed: { errors?: unknown; scope?: unknown; verb?: unknown; target?: unknown; actor?: unknown };
        try {
          parsed = JSON.parse(call[1]) as typeof parsed;
        } catch {
          // A rejection line the gate cannot read is itself a failure: never let
          // an unparseable commit_rejected entry pass silently.
          ciOffenders.push(`unparseable woo.commit_rejected.errors: ${call[1].slice(0, 240)}`);
          continue;
        }
        const errors = Array.isArray(parsed.errors)
          ? parsed.errors.filter((entry): entry is string => typeof entry === "string")
          : [];
        const context = `${String(parsed.verb ?? "?")} ${String(parsed.target ?? "?")} @ ${String(parsed.scope ?? "?")}`;
        for (const error of errors) {
          if (!isAllowlistedProjectionMismatch(error)) ciOffenders.push(`${error} :: ${context}`);
        }
      }
      expect(
        ciOffenders.length,
        `coherence-invariant violation during cross-shard walkthrough (VTN0): a commit rejection reported an error that is NOT an allow-listed A4 projection-cell mismatch. ` +
        `This is new multiplication / a masked rejection and must be fixed, not allow-listed. First offenders:\n${ciOffenders.slice(0, 3).join("\n")}`
      ).toBe(0);
    } finally {
      await Promise.allSettled([alice?.close(), bob?.close()]);
      warnSpy.mockRestore();
      logSpy.mockRestore();
      harness.close();
    }
  });

  it("gateway-shard support roots carry actor/thing lineage but never scope/catalog classes", () => {
    // The universal support set exists for actor/thing lineage only. Scope/room
    // class lineage ($space and catalog scope classes like $chatroom) stays owner
    // authority and must arrive via the room's authority slice (perf-plan step 2).
    // This guards against "fixing" a scope-lineage dangle by broadening the
    // universal support roots — which would re-import the sparse-stub-overwrites-
    // real-scope hazard the support set deliberately avoids.
    const lineage = seedDerivedUniversalLineage();
    // Positive: the actor/thing chain to the top is fully covered.
    for (const id of ["$system", "$root", "$actor", "$player", "$guest", "$human", "$agent", "$thing"]) {
      expect(lineage.has(id as ObjRef), `universal lineage must include ${id}`).toBe(true);
    }
    // Negative: roots and derived closure exclude scope/catalog lineage.
    for (const id of ["$space", "$chatroom", "$sequenced_log"]) {
      expect(MCP_GATEWAY_ACTOR_SUPPORT_ROOTS, `roots must not include scope class ${id}`).not.toContain(id);
      expect(lineage.has(id as ObjRef), `universal lineage must not include scope class ${id}`).toBe(false);
    }
  });
});

function createCfSmokeHarness(): CfSmokeHarness {
  const directoryState = new FakeDurableObjectState("directory");
  const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-local-smoke-secret" });
  const wooStates = new Map<string, WaitUntilDurableObjectState>();
  const wooObjects = new Map<string, PersistentObjectDO>();
  const commitStates = new Map<string, FakeDurableObjectState>();
  const commitObjects = new Map<string, CommitScopeDO>();
  let env: Env;

  const wooNamespace = new FakeDurableObjectNamespace((name) => {
    let object = wooObjects.get(name);
    if (!object) {
      let state = wooStates.get(name);
      if (!state) {
        state = new WaitUntilDurableObjectState(name);
        wooStates.set(name, state);
      }
      object = new PersistentObjectDO(state as unknown as DurableObjectState, env);
      wooObjects.set(name, object);
    }
    return object;
  });

  const commitNamespace = new FakeDurableObjectNamespace((name) => {
    let object = commitObjects.get(name);
    if (!object) {
      let state = commitStates.get(name);
      if (!state) {
        state = new FakeDurableObjectState(name);
        commitStates.set(name, state);
      }
      object = new CommitScopeDO(state as unknown as DurableObjectState, { WOO_INTERNAL_SECRET: "cf-local-smoke-secret" });
      commitObjects.set(name, object);
    }
    return object;
  });

  env = {
    WOO_INITIAL_WIZARD_TOKEN: "cf-local-smoke-token",
    WOO_INTERNAL_SECRET: "cf-local-smoke-secret",
    WOO_AUTO_INSTALL_CATALOGS: "chat,demoworld,note,blocks-demo",
    WOO_MCP_GATEWAY_SHARDS: String(SHARDS),
    DIRECTORY: new FakeDurableObjectNamespace((name) => {
      if (name !== "directory") throw new Error(`unexpected Directory DO ${name}`);
      return directory;
    }),
    WOO: wooNamespace,
    COMMIT_SCOPE: commitNamespace,
    HOST_SEED_KV: new FakeKVNamespace() as unknown as KVNamespace
  } as unknown as Env;

  return {
    env,
    request: async (path, init) => await worker.fetch(new Request(`https://woo.test${path}`, init), env, {}),
    close: () => {
      directoryState.close();
      for (const state of wooStates.values()) state.close();
      for (const state of commitStates.values()) state.close();
    }
  };
}

async function openOnDifferentShard(harness: CfSmokeHarness, alice: LocalMcpSession, runId: string): Promise<LocalMcpSession> {
  const aliceShard = mcpShardHost(alice.sessionId);
  for (let i = 0; i < 16; i += 1) {
    const candidate = await LocalMcpSession.open(harness, `guest:cf-local-bob-${runId}-${i}`, "bob", runId);
    if (mcpShardHost(candidate.sessionId) !== aliceShard) return candidate;
    await candidate.close();
  }
  throw new Error(`could not find bob session on a different MCP shard than ${aliceShard}`);
}

async function runWalkthrough(alice: LocalMcpSession, bob: LocalMcpSession): Promise<void> {
  await step("enter:chatroom (alice)", async () => {
    await alice.call("the_chatroom", "enter", []);
  });
  await step("enter:chatroom (bob)", async () => {
    await bob.call("the_chatroom", "enter", []);
  });
  await drain(alice);
  await drain(bob);

  await step("chat:say reaches peer", async () => {
    const text = `walkthrough-say-${alice.runId}`;
    await alice.call("the_chatroom", "say", [text]);
    await waitFor(bob, (obs) => obs.type === "said" && typeof obs.text === "string" && obs.text.includes(text));
  });

  await step("move:southeast emits `left` to bob (origin room)", async () => {
    await alice.call("the_chatroom", "southeast", []);
    await waitFor(bob, (obs) =>
      obs.type === "left" &&
      obs.actor === alice.actor &&
      obs.source === "the_chatroom" &&
      obs.destination === "the_deck" &&
      obs.exit === "southeast",
    10_000);
  });

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

  await step("pinboard:add_note reaches peer", async () => {
    await alice.call("the_chatroom", "southeast", []);
    await bob.call("the_chatroom", "southeast", []);
    await drain(alice);
    await drain(bob);
    try {
      await alice.call("the_deck", "enter", ["the_pinboard"]);
    } catch {
      // The canonical entry below is the real assertion; the deck command is
      // retained as an opportunistic route/manifest warm-up because prod smoke
      // has failed here when the deck scope held stale executable state.
    }
    await alice.call("the_pinboard", "enter", []);
    await bob.call("the_pinboard", "enter", []);
    await drain(alice);
    await drain(bob);
    const text = `pinboard-${alice.runId}`;
    await alice.call("the_pinboard", "add_note", [text, "yellow", 32, 32, 200, 120]);
    await waitFor(bob, (obs) =>
      obs.type === "note_added" &&
      isRecord(obs.note) &&
      typeof obs.note.text === "string" &&
      obs.note.text.includes(text),
    10_000);
  });

  await step("outliner:enter result includes a roster row for alice", async () => {
    await alice.leaveIfIn("the_pinboard");
    await bob.leaveIfIn("the_pinboard");
    if (alice.currentRoom === "the_deck") await alice.call("the_deck", "west", []);
    if (bob.currentRoom === "the_deck") await bob.call("the_deck", "west", []);
    await drain(alice);
    await drain(bob);
    const aliceEnter = await alice.call("the_outline", "enter", []);
    if (!isRecord(aliceEnter) || !Array.isArray(aliceEnter.roster)) {
      throw new Error(`expected roster array on the_outline:enter result; got ${JSON.stringify(aliceEnter).slice(0, 200)}`);
    }
    const ids = new Set(aliceEnter.roster.filter(isRecord).map((row) => String(row.id ?? "")));
    if (!ids.has(alice.actor)) {
      throw new Error(`alice not in her own enter roster; ids=${[...ids].join(",")} expected alice=${alice.actor}`);
    }
  });

  await step("outliner:add_item reaches peer", async () => {
    await bob.call("the_outline", "enter", []);
    await drain(alice);
    await drain(bob);
    const text = `outline-${alice.runId}`;
    await alice.call("the_outline", "add_item", [text]);
    await waitFor(bob, (obs) => obs.type === "outline_item_added" && obs.text === text, 10_000);
  });

  await step("tasks: cross-room `entered` reaches peer", async () => {
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

async function walkSouthToTaskboard(session: LocalMcpSession): Promise<void> {
  if (session.currentRoom !== "the_deck") {
    throw new Error(`${session.label} expected on the_deck before south; at=${session.currentRoom}`);
  }
  await session.call("the_deck", "south", []);
  const afterFirstMove = session.currentRoom as string | null;
  if (afterFirstMove === "the_garden") await session.call("the_garden", "south", []);
  const afterSouthPath = session.currentRoom as string | null;
  if (afterSouthPath !== "the_taskboard") {
    throw new Error(`${session.label} expected on the_taskboard after south path; at=${session.currentRoom}`);
  }
}

async function step(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await raceWithTimeout(body(), STEP_TIMEOUT_MS, `step "${name}" exceeded ${STEP_TIMEOUT_MS}ms watchdog`);
  } catch (err) {
    throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function drain(session: LocalMcpSession): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < DRAIN_TOTAL_BUDGET_MS) {
    try {
      const result = await session.callTool("woo_wait", { timeout_ms: DRAIN_POLL_MS, limit: 100 });
      if (waitObservationsOf(result).length === 0) return;
    } catch {
      return;
    }
  }
}

async function waitFor(
  session: LocalMcpSession,
  match: (obs: Record<string, any>) => boolean,
  totalTimeoutMs = 5000
): Promise<Record<string, any>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < totalTimeoutMs) {
    const remaining = totalTimeoutMs - (Date.now() - startedAt);
    const result = await session.callTool("woo_wait", { timeout_ms: Math.min(remaining, 1000), limit: 100 });
    for (const obs of waitObservationsOf(result)) {
      if (isRecord(obs) && match(obs)) return obs;
    }
  }
  throw new Error(`timeout after ${totalTimeoutMs}ms waiting for matching observation`);
}

class LocalMcpSession {
  private nextId = 2;
  currentRoom: string | null = null;

  private constructor(
    private readonly harness: CfSmokeHarness,
    readonly sessionId: string,
    readonly actor: string,
    readonly label: string,
    readonly runId: string
  ) {}

  static async open(harness: CfSmokeHarness, token: string, label: string, runId: string): Promise<LocalMcpSession> {
    const response = await mcpFetch(harness, {
      method: "POST",
      headers: { "mcp-token": token },
      body: rpc(1, "initialize", initializeParams(`cf-local-smoke/${runId}/${label}`))
    });
    expect(response.ok, await response.clone().text()).toBe(true);
    const sessionId = response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    await parseMcpResponse(response);

    const probing = new LocalMcpSession(harness, sessionId!, "", label, runId);
    const notified = await mcpFetch(harness, {
      method: "POST",
      headers: { "mcp-session-id": sessionId! },
      body: notification("notifications/initialized")
    });
    expect(notified.status).toBe(202);
    const tools = await probing.callTool("woo_list_reachable_tools", { scope: "all", limit: 200 });
    const list = tools?.result?.structuredContent?.result?.tools ?? [];
    const selfTool = list.find((tool: any) =>
      typeof tool?.object === "string" &&
      /^guest_/.test(tool.object) &&
      (tool.verb === "focus_list" || tool.verb === "focus" || tool.verb === "wait")
    );
    if (!selfTool || typeof selfTool.object !== "string") {
      throw new Error(`could not resolve actor for ${label} from tool list (saw ${list.length} tools)`);
    }
    return new LocalMcpSession(harness, sessionId!, selfTool.object, label, runId);
  }

  async call(object: string, verb: string, args: unknown[]): Promise<unknown> {
    const result = unwrap(await this.callTool("woo_call", { object, verb, args }));
    if (isRecord(result) && typeof result.room === "string") this.currentRoom = result.room;
    return result;
  }

  async leaveIfIn(space: string): Promise<boolean> {
    if (this.currentRoom !== space) return false;
    await this.call(space, "leave", []);
    return true;
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<any> {
    const response = await mcpFetch(this.harness, {
      method: "POST",
      headers: { "mcp-session-id": this.sessionId },
      body: rpc(this.nextId++, "tools/call", { name, arguments: params })
    });
    expect(response.ok, await response.clone().text()).toBe(true);
    const body = await parseMcpResponse(response);
    if (body && typeof body === "object" && "error" in body && body.error) {
      throw new Error(`tools/call ${name} JSON-RPC error: ${JSON.stringify(body.error)}`);
    }
    return body;
  }

  async close(): Promise<void> {
    await mcpFetch(this.harness, {
      method: "DELETE",
      headers: { "mcp-session-id": this.sessionId }
    }).catch(() => undefined);
  }
}

async function mcpFetch(
  harness: CfSmokeHarness,
  input: { method: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number }
): Promise<Response> {
  const headers = new Headers({ accept: "application/json, text/event-stream", ...input.headers });
  let body: BodyInit | undefined;
  if (input.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(input.body);
  }
  return await raceWithTimeout(
    harness.request("/mcp", { method: input.method, headers, body }),
    input.timeoutMs ?? RPC_TIMEOUT_MS,
    `MCP ${input.method} /mcp timed out after ${input.timeoutMs ?? RPC_TIMEOUT_MS}ms`
  );
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

async function parseMcpResponse(response: Response): Promise<any> {
  if (response.status === 202 || response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const data = text.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice("data:".length).trim();
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(text);
}

function unwrap(body: any): unknown {
  if (body?.result?.isError) {
    throw new Error(`MCP tool error: ${JSON.stringify(body.result.structuredContent ?? body.result, null, 2)}`);
  }
  return body?.result?.structuredContent?.result;
}

function waitObservationsOf(body: any): unknown[] {
  return body?.result?.structuredContent?.result?.observations ?? [];
}

function initializeParams(name: string): Record<string, unknown> {
  return {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name, version: "0.0.0" }
  };
}

function rpc(id: number, method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function notification(method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mcpShardHost(sessionId: string): string {
  return `mcp-gateway-${stableHash(sessionId) % SHARDS}`;
}

function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
