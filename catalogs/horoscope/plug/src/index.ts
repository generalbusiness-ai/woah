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
  let delivered = 0;

  for (let i = 0; i < maxOrdersPerTick; i++) {
    const next = (await client.directCall(env.BLOCK_ID, "next_pending")) as PendingOrder | null;
    if (!next || typeof next !== "object" || !next.order_id) break;

    try {
      const body = await generateHoroscope(env.AI, {
        systemPrompt,
        request: next.request,
        maxTokens
      });
      await client.directCall(env.BLOCK_ID, "deliver", [next.order_id, body]);
      delivered++;
      logEvent({
        event: "order_delivered",
        block: env.BLOCK_ID,
        order_id: next.order_id,
        requester: next.requester,
        body_chars: body.length
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
      // Don't drop the order — leave it on the queue. The block's TTL
      // handles abandoned entries; transient errors retry next tick.
      break;
    }
  }

  await client.directCall(env.BLOCK_ID, "set_properties", [
    {
      last_pushed_at: now(),
      last_error: errors.length > 0 ? errors[errors.length - 1].message : null
    }
  ]);

  return { block: env.BLOCK_ID, delivered, errors };
}

function numEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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
