// Horoscope vending-machine plug Worker.
//
// Cron-triggered every minute. Each tick:
//   1. Authenticate to woo with the actor-bound apikey for the block.
//   2. Read the block's `system_prompt` config.
//   3. Drain the queue: call :next_pending, run Workers AI, call :deliver,
//      repeat until the queue is empty or MAX_ORDERS_PER_TICK is reached.
//
// :deliver is idempotent on order_id (the block's verb removes the matching
// queue entry and creates a $note). Lost wakeups don't matter — the next
// tick catches up.
//
// Transport choice: REST. The plug's calls are operational (queue drain,
// artifact production), not agent tool discovery. REST hits woo's perm
// system directly without going through MCP's `tool_exposed` gate, which
// keeps :next_pending and :deliver hidden from agent tool listings while
// the block's apikey-bound session can still call them. See
// `mcp-client.ts` for the long-lived MCP-attached variant kept for the
// day we want event-driven (`woo_wait`) drain instead of cron polling.

import { WooClient, WooError } from "./woo-client";
import { generateHoroscope, type HoroscopeAi } from "./horoscope";

export interface HoroscopePlugEnv {
  WOO_BASE_URL: string;
  WOO_APIKEY: string;
  BLOCK_ID: string;
  AI: HoroscopeAi;
  MAX_TOKENS?: string;
  MAX_ORDERS_PER_TICK?: string;
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
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {}
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
};

export async function runHoroscopeTick(
  env: HoroscopePlugEnv,
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {}
): Promise<HoroscopeTickResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? Date.now;
  const client = new WooClient({ baseUrl: env.WOO_BASE_URL, fetchImpl });
  await client.authenticate(env.WOO_APIKEY);

  const maxOrdersPerTick = numEnv(env.MAX_ORDERS_PER_TICK, 10);
  const maxTokens = numEnv(env.MAX_TOKENS, 350);

  // Read system_prompt once per tick. Owners change it rarely; the cost of
  // a one-tick lag is bounded.
  const promptValue = await client.getProperty(env.BLOCK_ID, "system_prompt");
  const systemPrompt = typeof promptValue === "string" ? promptValue : "";

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

    try {
      await client.directCall(env.BLOCK_ID, "deliver", [next.order_id, name, text]);
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
      if (err instanceof WooError && err.code === "E_NOSESSION") break;
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

  await client.directCall(env.BLOCK_ID, "set_properties", [
    {
      last_pushed_at: now(),
      last_error: lastErrorValue
    }
  ]);

  return { block: env.BLOCK_ID, delivered, errors };
}

// Verb-side rejections that won't change on retry. Anything outside this
// set is treated as transient and left on the queue for the next cron tick.
const PERMANENT_DELIVER_ERRORS: ReadonlySet<string> = new Set(["E_INVARG", "E_PERM", "E_VERBNF", "E_TYPE", "E_RANGE"]);

function numEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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
