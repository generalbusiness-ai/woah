// Horoscope vending-machine plug Worker.
//
// Cron-triggered every minute. Each tick:
//   1. Reuse a cached woo session if one is still warm in this isolate
//      and not within REAUTH_MARGIN_MS of expiry, otherwise authenticate
//      to woo with the actor-bound apikey for the block.
//   2. Read the block's `system_prompt` config through a short TTL cache.
//   3. Drain the queue: call :next_pending, run Workers AI, call :deliver,
//      repeat until the queue is empty or MAX_ORDERS_PER_TICK is reached.
//
// :deliver is idempotent on order_id (the block's verb removes the matching
// queue entry and creates a $note). Lost wakeups don't matter — the next
// tick catches up.
//
// Transport choice: net turns. The plug's calls are operational (queue drain,
// artifact production), not agent tool discovery. Authenticated net turns
// enforce woo permissions without going through MCP's `tool_exposed` gate,
// keeping :next_pending and :deliver hidden from agent tool listings. See
// `mcp-client.ts` for the long-lived MCP-attached variant kept for the
// day we want event-driven (`woo_wait`) drain instead of cron polling.

import { WooClient, WooError, type WooSession } from "./woo-client";
import { generateHoroscope, type HoroscopeAi } from "./horoscope";

export interface HoroscopePlugEnv {
  WOO_BASE_URL: string;
  WOO_APIKEY: string;
  BLOCK_ID: string;
  AI: HoroscopeAi;
  MAX_TOKENS?: string;
  MAX_ORDERS_PER_TICK?: string;
  SYSTEM_PROMPT_TTL_MS?: string;
  HEARTBEAT_INTERVAL_MS?: string;
  /** Required for the manual POST trigger. Caller must send
   * `Authorization: Bearer <TRIGGER_SECRET>`. Without it, anyone with the
   * Worker URL could drain the queue and burn Workers-AI quota. The cron
   * path is unaffected. */
  TRIGGER_SECRET?: string;
}

type PendingOrder = {
  order_id: string;
  requester: string;
  request: string;
  ts: number;
};

// Re-authenticate at least this long before the cached session would expire.
// woo issues 24h sessions for credential-class tokens (apikey/bearer); a one
// hour margin keeps us comfortably away from the boundary even if a cron
// tick is delayed or a single tick runs long.
const REAUTH_MARGIN_MS = 60 * 60 * 1000;
const DEFAULT_SYSTEM_PROMPT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export type SessionCache = {
  get(): WooSession | null;
  set(session: WooSession | null): void;
};

export type SystemPromptCache = {
  get(blockId: string, now: number, ttlMs: number): string | null;
  set(blockId: string, value: string, now: number): void;
};

export type HeartbeatCache = {
  get(blockId: string): number | null;
  set(blockId: string, pushedAt: number): void;
};

// Module-scope singleton cache. CF Workers reuse isolates between
// invocations when traffic is steady, so a `let` at module scope survives
// from one cron tick to the next as long as the isolate stays warm. Cold
// starts (eviction, redeploy, load shedding) reset us back to null and the
// next tick falls through to a fresh authenticate(). Tests pass their own
// SessionCache via `deps.sessionCache` to avoid leaking warm state across
// test cases — see test/index.test.ts.
let _moduleScopeSession: WooSession | null = null;
const moduleScopeSessionCache: SessionCache = {
  get: () => _moduleScopeSession,
  set: (session) => { _moduleScopeSession = session; }
};

const _moduleScopePrompts = new Map<string, { value: string; fetchedAt: number }>();
const moduleScopeSystemPromptCache: SystemPromptCache = {
  get(blockId, now, ttlMs) {
    const cached = _moduleScopePrompts.get(blockId);
    if (!cached || now - cached.fetchedAt >= ttlMs) return null;
    return cached.value;
  },
  set(blockId, value, now) {
    _moduleScopePrompts.set(blockId, { value, fetchedAt: now });
  }
};

const _moduleScopeHeartbeats = new Map<string, number>();
const moduleScopeHeartbeatCache: HeartbeatCache = {
  get: (blockId) => _moduleScopeHeartbeats.get(blockId) ?? null,
  set: (blockId, pushedAt) => { _moduleScopeHeartbeats.set(blockId, pushedAt); }
};

/** Build a fresh in-memory SessionCache. Useful for tests so each case
 * starts from a known empty state, and for callers that want explicit
 * control over the cache lifetime. */
export function createSessionCache(): SessionCache {
  let cached: WooSession | null = null;
  return {
    get: () => cached,
    set: (session) => { cached = session; }
  };
}

export function createSystemPromptCache(): SystemPromptCache {
  const prompts = new Map<string, { value: string; fetchedAt: number }>();
  return {
    get(blockId, now, ttlMs) {
      const cached = prompts.get(blockId);
      if (!cached || now - cached.fetchedAt >= ttlMs) return null;
      return cached.value;
    },
    set(blockId, value, now) {
      prompts.set(blockId, { value, fetchedAt: now });
    }
  };
}

export function createHeartbeatCache(): HeartbeatCache {
  const pushedAt = new Map<string, number>();
  return {
    get: (blockId) => pushedAt.get(blockId) ?? null,
    set: (blockId, value) => { pushedAt.set(blockId, value); }
  };
}

export default {
  async scheduled(_event: ScheduledEvent, env: HoroscopePlugEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runLoggedHoroscopeTick(env, "cron"));
  },

  // Manual run: hit the Worker URL to drain the queue immediately. Useful for
  // first-light wiring and for "I just placed an order, deliver now" if the
  // user doesn't want to wait for the cron tick. Gated by TRIGGER_SECRET so
  // the Worker URL is not a public quota-burning hole.
  async fetch(request: Request, env: HoroscopePlugEnv): Promise<Response> {
    if (request.method !== "POST") return new Response("POST to drain queue", { status: 405 });
    const authError = checkTriggerAuth(request, env);
    if (authError) return authError;
    try {
      const result = await runLoggedHoroscopeTick(env, "fetch");
      return Response.json({ ok: true, ...result });
    } catch (err) {
      return errorResponse(err);
    }
  }
};

// Gate the manual fetch trigger on a shared secret. See the weather plug
// for the same shape; the two are independent only because catalogs/plugs
// are independently deployed.
export function checkTriggerAuth(request: Request, env: HoroscopePlugEnv): Response | null {
  const expected = env.TRIGGER_SECRET ?? "";
  if (!expected) {
    return Response.json(
      { ok: false, code: "E_NOT_CONFIGURED", message: "manual trigger disabled — set TRIGGER_SECRET to enable" },
      { status: 403 }
    );
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const presented = match ? match[1] : "";
  if (!constantTimeEqual(presented, expected)) {
    return Response.json(
      { ok: false, code: "E_NOSESSION", message: "manual trigger requires Authorization: Bearer <TRIGGER_SECRET>" },
      { status: 401 }
    );
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type HoroscopeTriggerLabel = "cron" | "fetch";

// Tick wrapper: emits structured `tick_start` / `tick_ok` / `tick_error`
// log lines around runHoroscopeTick. Per-order events are emitted from
// inside runHoroscopeTick (see `order_delivered` / `order_error`).
export async function runLoggedHoroscopeTick(
  env: HoroscopePlugEnv,
  trigger: HoroscopeTriggerLabel,
  deps: HoroscopeTickDeps = {}
): Promise<HoroscopeTickResult> {
  const now = deps.now ?? Date.now;
  const start = now();
  logEvent({ event: "tick_start", trigger, block: env.BLOCK_ID });
  try {
    const result = await runHoroscopeTick(env, deps);
    logEvent({
      event: "tick_ok",
      trigger,
      block: result.block,
      delivered: result.delivered,
      errors: result.errors.length,
      auth: result.authMode,
      duration_ms: now() - start
    });
    return result;
  } catch (err) {
    logEvent({
      event: "tick_error",
      trigger,
      block: env.BLOCK_ID,
      duration_ms: now() - start,
      ...errorBreadcrumb(err)
    });
    throw err;
  }
}

export type HoroscopeTickResult = {
  block: string;
  delivered: number;
  errors: Array<{ order_id: string; message: string }>;
  /** "warm" when the session cache hit and skipped /net-api/session, "cold"
   * when we authenticated. Surfaced in the `tick_ok` log so dashboards can
   * compute a cache hit rate from `wrangler tail`. */
  authMode: "warm" | "cold";
};

export type HoroscopeTickDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sessionCache?: SessionCache;
  systemPromptCache?: SystemPromptCache;
  heartbeatCache?: HeartbeatCache;
};

export async function runHoroscopeTick(
  env: HoroscopePlugEnv,
  deps: HoroscopeTickDeps = {}
): Promise<HoroscopeTickResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? Date.now;
  const sessionCache = deps.sessionCache ?? moduleScopeSessionCache;
  const systemPromptCache = deps.systemPromptCache ?? (deps.fetchImpl ? createSystemPromptCache() : moduleScopeSystemPromptCache);
  const heartbeatCache = deps.heartbeatCache ?? (deps.fetchImpl ? createHeartbeatCache() : moduleScopeHeartbeatCache);
  const client = new WooClient({ baseUrl: env.WOO_BASE_URL, fetchImpl });

  // Warm-path reuse: an apikey-class session minted on a prior tick is
  // still good for ~24h. Skipping /net-api/session here is the point of
  // the cache — each fresh authenticate() commits a new presence session.
  // Re-auth only when
  // we'd otherwise be running into the expiry boundary mid-tick.
  const cached = sessionCache.get();
  let authMode: "warm" | "cold";
  if (cached && cached.expiresAt !== null && cached.expiresAt - now() > REAUTH_MARGIN_MS) {
    client.adoptSession(cached, env.WOO_APIKEY);
    authMode = "warm";
  } else {
    const fresh = await client.authenticate(env.WOO_APIKEY);
    sessionCache.set(fresh);
    authMode = "cold";
  }

  const maxOrdersPerTick = numEnv(env.MAX_ORDERS_PER_TICK, 10);
  const maxTokens = numEnv(env.MAX_TOKENS, 350);
  const systemPromptTtlMs = durationEnv(env.SYSTEM_PROMPT_TTL_MS, DEFAULT_SYSTEM_PROMPT_TTL_MS);
  const heartbeatIntervalMs = durationEnv(env.HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_INTERVAL_MS);

  // Anything from here on that throws E_NOSESSION must invalidate the
  // session cache before bubbling up — otherwise the next tick adopts the
  // same dead session and fails identically. The deliver inner-catch does
  // its own invalidation; this outer catch covers getProperty,
  // next_pending, and the closing set_properties heartbeat (all of which
  // currently propagate). Any non-E_NOSESSION error is rethrown unchanged
  // and surfaces as `tick_error` upstream.
  try {

  const tickNow = now();
  let systemPrompt = systemPromptCache.get(env.BLOCK_ID, tickNow, systemPromptTtlMs);
  if (systemPrompt === null) {
    // Owners change system_prompt rarely, while cron reads it every minute.
    // A short TTL removes the steady-state cold-object read without making
    // configuration changes wait longer than a few ticks.
    const promptValue = await client.getProperty(env.BLOCK_ID, "system_prompt");
    systemPrompt = typeof promptValue === "string" ? promptValue : "";
    systemPromptCache.set(env.BLOCK_ID, systemPrompt, tickNow);
  }

  const errors: HoroscopeTickResult["errors"] = [];
  const aiFallbacks: Array<{ order_id: string; message: string }> = [];
  let delivered = 0;

  let lastSeenOrderId: string | null = null;
  for (let i = 0; i < maxOrdersPerTick; i++) {
    const next = (await client.directCall(env.BLOCK_ID, "next_pending")) as PendingOrder | null;
    if (!next || typeof next !== "object" || !next.order_id) break;

    // :next_pending peeks (it does not pop). If we see the same head twice
    // in a row, the previous iteration left it on the queue (transient
    // :deliver failure), so re-attempting now would just re-fail. Stop the
    // tick and let the next cron retry rather than spin.
    if (lastSeenOrderId === next.order_id) break;
    lastSeenOrderId = next.order_id;

    const request = typeof next.request === "string" ? next.request : "";
    const name = horoscopeNoteName(request);
    let text = "";
    let textOrigin: "ai" | "fallback" = "ai";
    let aiError: unknown = null;
    try {
      const generated = await generateHoroscope(env.AI, { systemPrompt, request, maxTokens });
      // belt-and-braces against an unexpected AI binding return shape:
      // the verb rejects non-string text with E_INVARG, which previously
      // poisoned the queue head and stalled every following order.
      text = typeof generated === "string" ? generated.trim() : "";
    } catch (err) {
      aiError = err;
      logEvent({
        event: "ai_fallback",
        block: env.BLOCK_ID,
        order_id: next.order_id,
        requester: next.requester,
        ...errorBreadcrumb(err)
      });
    }
    if (!text) {
      textOrigin = "fallback";
      text = "The horoscope machine paused — it couldn't compose a reading just now. Try again in a moment.";
      const fallbackMessage = aiError instanceof Error
        ? aiError.message
        : aiError != null ? String(aiError) : "ai produced no text";
      aiFallbacks.push({ order_id: next.order_id, message: fallbackMessage });
    }

    const description = horoscopeNoteDescription(request);
    try {
      await client.directCall(env.BLOCK_ID, "deliver", [next.order_id, name, text, description]);
      delivered++;
      logEvent({
        event: "order_delivered",
        block: env.BLOCK_ID,
        order_id: next.order_id,
        requester: next.requester,
        text_chars: text.length,
        text_origin: textOrigin
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ order_id: next.order_id, message });
      logEvent({
        event: "order_error",
        block: env.BLOCK_ID,
        order_id: next.order_id,
        requester: next.requester,
        ...errorBreadcrumb(err)
      });
      // E_NOSESSION → re-auth issue, every subsequent call will hit the
      // same wall this tick. Stop and let the next tick re-authenticate.
      // Invalidate the warm-session cache so the next tick goes cold
      // rather than re-adopting the same rejected session and looping.
      if (err instanceof WooError && err.code === "E_NOSESSION") {
        sessionCache.set(null);
        break;
      }
      // Permanent verb-side rejections (bad args, perm, missing verb)
      // mean retrying with the same data will keep failing. Cancel so the
      // queue drains; the user gets nothing for this order, but at least
      // every order behind it isn't blocked. last_error keeps the trail.
      // Anything else (E_TIMEOUT / E_INTERNAL / E_GATEWAY / 5xx /
      // transport failure / unmapped runtime errors) is treated as
      // potentially transient — leave the order on the queue and stop
      // the tick so the next cron retries. Better to spin a few cron
      // ticks than silently drop a user's order on a flaky network.
      if (err instanceof WooError && PERMANENT_DELIVER_ERRORS.has(err.code)) {
        try {
          await client.directCall(env.BLOCK_ID, "cancel", [next.order_id]);
          logEvent({
            event: "order_canceled_by_plug",
            block: env.BLOCK_ID,
            order_id: next.order_id,
            requester: next.requester,
            code: err.code,
            reason: message
          });
        } catch (cancelErr) {
          logEvent({
            event: "order_cancel_failed",
            block: env.BLOCK_ID,
            order_id: next.order_id,
            ...errorBreadcrumb(cancelErr)
          });
          break;
        }
      } else {
        // Transient: leave on queue, stop the tick. The lastSeenOrderId
        // guard would also catch this on next iter, but breaking here
        // makes the intent explicit and avoids a wasted next_pending RPC.
        break;
      }
    }
  }

  // Surface AI-degraded delivery in last_error even when no :deliver call
  // failed, so look_self / status reports reflect that the block is only
  // shipping fallback notes (per catalogs/horoscope/DESIGN.md). Genuine
  // :deliver errors take precedence — they're more actionable.
  let lastErrorValue: string | null = null;
  if (errors.length > 0) lastErrorValue = errors[errors.length - 1].message;
  else if (aiFallbacks.length > 0) lastErrorValue = `ai fallback: ${aiFallbacks[aiFallbacks.length - 1].message}`;

  const heartbeatAt = now();
  const previousHeartbeatAt = heartbeatCache.get(env.BLOCK_ID);
  const heartbeatDue = previousHeartbeatAt === null || heartbeatAt - previousHeartbeatAt >= heartbeatIntervalMs;
  if (delivered > 0 || lastErrorValue !== null || heartbeatDue) {
    await client.directCall(env.BLOCK_ID, "set_properties", [
      {
        last_pushed_at: heartbeatAt,
        last_error: lastErrorValue
      }
    ]);
    heartbeatCache.set(env.BLOCK_ID, heartbeatAt);
  }

  return { block: env.BLOCK_ID, delivered, errors, authMode };

  } catch (err) {
    if (err instanceof WooError && err.code === "E_NOSESSION") sessionCache.set(null);
    throw err;
  }
}

// Verb-side rejections that won't change on retry. Anything outside this
// set is treated as transient and left on the queue for the next cron tick.
const PERMANENT_DELIVER_ERRORS: ReadonlySet<string> = new Set(["E_INVARG", "E_PERM", "E_VERBNF", "E_TYPE", "E_RANGE"]);

function numEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function durationEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

// Build the inventory listing name for a delivered horoscope from the
// requester's order text. Most requests are a sign or short topic; we
// title-case them and prefix with "Horoscope:" so an inventory line reads
// "Horoscope: Capricorn" instead of leaking body content into the title.
export function horoscopeNoteName(request: string): string {
  const trimmed = (request ?? "").trim();
  if (!trimmed) return "Horoscope reading";
  const head = trimmed.split(/\s+/).slice(0, 4).join(" ");
  const truncated = head.length > 40 ? head.slice(0, 40).trimEnd() : head;
  const titled = truncated.replace(
    /\b([a-z])([a-z']*)/gi,
    (_, first: string, rest: string) => first.toUpperCase() + rest.toLowerCase()
  );
  return `Horoscope: ${titled}`;
}

// Build the cosmetic look-at description for a delivered horoscope. Per
// LambdaCore $note convention, .description is what `look` shows (a one-
// line flavour) while .text holds the body shown by `read`. We keep the
// description short and focused on provenance so a player who types
// `look giraffe` learns it's a horoscope reading and can `read` it.
export function horoscopeNoteDescription(request: string): string {
  const trimmed = (request ?? "").trim();
  if (!trimmed) return "A horoscope reading from the machine. Try `read` to see what it says.";
  const subject = trimmed.length > 60 ? trimmed.slice(0, 60).trimEnd() + "..." : trimmed;
  return `A horoscope reading the machine produced for "${subject}". Try \`read\` to see what it says.`;
}

// Single line of JSON to console — CF Workers' Logs tab parses it
// structurally, and `wrangler tail --format pretty` prints it human-readably.
type LogRecord = Record<string, unknown> & { event: string };

function logEvent(record: LogRecord): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...record }));
}

// Categorize errors so a tail-grep can answer "which way did it break?"
// without parsing free-text messages.
type ErrorBreadcrumb = { category: string; code?: string; message: string; status?: number };

function errorBreadcrumb(err: unknown): ErrorBreadcrumb {
  if (err instanceof WooError) {
    return { category: `woo:${err.code}`, code: err.code, status: err.status, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  // AI-call failures arrive as plain Error from `generateHoroscope`. Tag them
  // distinctly so operators can grep "ai:" lines apart from "woo:" lines.
  if (err instanceof Error) {
    return { category: "ai", message };
  }
  return { category: "unknown", message };
}

function errorResponse(err: unknown): Response {
  if (err instanceof WooError) {
    return Response.json(
      { ok: false, code: err.code, message: err.message, value: err.value },
      { status: err.status >= 400 && err.status < 600 ? err.status : 500 }
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ ok: false, code: "E_INTERNAL", message }, { status: 500 });
}
