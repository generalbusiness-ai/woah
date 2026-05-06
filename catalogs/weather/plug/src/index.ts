// Weather plug Worker.
//
// Cron-triggered. Each tick:
//   1. Authenticate to woo with the actor-bound apikey for the weather block.
//   2. Read the block's owner-set `place` property.
//   3. Fetch tomorrow.io for that place.
//   4. Push current/forecast/last_pushed_at via :set_properties.
//
// Disconnects between ticks. The block keeps last-set values across plug
// downtime; the SPA renders "stale, last seen ..." from `last_pushed_at` and
// the block-side freshness window.

import { WooClient, WooError } from "./woo-client";
import { fetchWeather, TomorrowIoError, type TomorrowUnits, type WeatherSnapshot } from "./tomorrow-io";

export interface WeatherPlugEnv {
  WOO_BASE_URL: string;
  WOO_APIKEY: string;
  TOMORROW_IO_API_KEY: string;
  BLOCK_ID: string;
  /** Optional override for the block's forecast_hours when the block has
   * not been configured by an owner. The block's writable_owner value
   * always wins when present. */
  FORECAST_HOURS?: string;
  /** Required for the manual POST trigger. Caller must send
   * `Authorization: Bearer <TRIGGER_SECRET>`. Without it, anyone with the
   * Worker URL could burn tomorrow.io quota and force block writes. The
   * cron path is unaffected. */
  TRIGGER_SECRET?: string;
}

export default {
  async scheduled(_event: ScheduledEvent, env: WeatherPlugEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runLoggedWeatherTick(env, "cron"));
  },

  // Manual run: hit the Worker URL to push immediately. Useful for first-light
  // wiring and for the "I just changed the place, refresh now" case. Gated
  // by TRIGGER_SECRET so the Worker URL is not a public quota-burning hole.
  async fetch(request: Request, env: WeatherPlugEnv): Promise<Response> {
    if (request.method !== "POST") return new Response("POST to trigger", { status: 405 });
    const authError = checkTriggerAuth(request, env);
    if (authError) return authError;
    try {
      const result = await runLoggedWeatherTick(env, "fetch");
      return Response.json({ ok: true, ...result });
    } catch (err) {
      return errorResponse(err);
    }
  }
};

// Trigger label distinguishes scheduled invocations from manual ones in logs,
// and could later carry "retry" / "test" labels if we add those.
export type WeatherTriggerLabel = "cron" | "fetch";

// Tick wrapper: emits structured `tick_start` / `tick_ok` / `tick_error`
// log lines around runWeatherTick. Re-throws so the runtime still records the
// failure in CF Workers Analytics. Exported for test coverage.
export async function runLoggedWeatherTick(
  env: WeatherPlugEnv,
  trigger: WeatherTriggerLabel,
  deps: { fetchImpl?: typeof fetch; now?: () => number } = {}
): Promise<WeatherTickResult> {
  const now = deps.now ?? Date.now;
  const start = now();
  logEvent({ event: "tick_start", trigger, block: env.BLOCK_ID });
  try {
    const result = await runWeatherTick(env, deps);
    logEvent({
      event: "tick_ok",
      trigger,
      block: result.block,
      place: result.place,
      fetched_at: result.fetched_at,
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

export type WeatherTickResult = {
  block: string;
  place: string;
  fetched_at: number;
};

export async function runWeatherTick(
  env: WeatherPlugEnv,
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<WeatherTickResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const client = new WooClient({ baseUrl: env.WOO_BASE_URL, fetchImpl });
  await client.authenticate(env.WOO_APIKEY);

  const placeValue = await client.getProperty(env.BLOCK_ID, "place");
  const place = typeof placeValue === "string" && placeValue.trim() ? placeValue : null;
  if (!place) {
    await client.directCall(env.BLOCK_ID, "set_property", [
      "last_error",
      "owner has not configured `place` on this block"
    ]);
    throw new WooError("E_NO_PLACE", "owner has not configured `place` on this block", 400);
  }

  // Owner-set knobs ride writable_owner on the block. The plug honors them
  // verbatim — falling back to env (deploy-time) only when the block hasn't
  // been configured. This is the "config props are owner-writable" half of
  // the $block contract.
  const unitsRaw = await client.getProperty(env.BLOCK_ID, "units");
  const units: TomorrowUnits = unitsRaw === "imperial" ? "imperial" : "metric";
  const forecastHoursRaw = await client.getProperty(env.BLOCK_ID, "forecast_hours");
  const forecastHours = pickForecastHours(forecastHoursRaw, env.FORECAST_HOURS);
  const tomorrowPlace = normalizeTomorrowLocation(place);

  let snapshot: WeatherSnapshot;
  try {
    snapshot = await fetchWeather({
      apiKey: env.TOMORROW_IO_API_KEY,
      place: tomorrowPlace,
      units,
      forecastHours,
      fetchImpl
    });
  } catch (err) {
    await client.directCall(env.BLOCK_ID, "set_property", ["last_error", formatLastError(err)]);
    throw err;
  }

  await client.directCall(env.BLOCK_ID, "set_properties", [
    {
      current: snapshot.current,
      forecast: snapshot.forecast,
      last_pushed_at: snapshot.fetched_at,
      last_error: null
    }
  ]);

  return { block: env.BLOCK_ID, place, fetched_at: snapshot.fetched_at };
}

export function normalizeTomorrowLocation(place: string): string {
  const trimmed = place.trim();
  if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  return trimmed.replace(/,\s*/g, " ");
}

function pickForecastHours(blockValue: unknown, envValue: string | undefined): number | undefined {
  if (typeof blockValue === "number" && Number.isFinite(blockValue) && blockValue > 0) return Math.floor(blockValue);
  if (envValue !== undefined && envValue !== "") {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

// Single line of JSON to console — CF Workers' Logs tab parses it
// structurally, and `wrangler tail --format pretty` prints it human-readably.
// We never `console.error` for "expected" failures; CF Analytics already
// counts the failed scheduled invocation. The breadcrumb is the diagnostic.
type LogRecord = Record<string, unknown> & { event: string };

function logEvent(record: LogRecord): void {
  // ISO timestamp lets a tail across multiple Workers stay sortable.
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...record }));
}

// Categorize errors so a tail-grep can answer "which way did it break?"
// without parsing free-text messages.
type ErrorBreadcrumb = { category: string; code?: string; message: string; status?: number };

function errorBreadcrumb(err: unknown): ErrorBreadcrumb {
  if (err instanceof TomorrowIoError) {
    const category = err.isRateLimit ? "tomorrow:rate_limit"
      : err.isAuth ? "tomorrow:auth"
      : `tomorrow:${err.status}`;
    return { category, status: err.status, message: err.message };
  }
  if (err instanceof WooError) {
    return { category: `woo:${err.code}`, code: err.code, status: err.status, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { category: "unknown", message };
}

function formatLastError(err: unknown): string {
  if (err instanceof TomorrowIoError) {
    if (err.isRateLimit) {
      const wait = err.retryAfter ? ` (retry after ${err.retryAfter}s)` : "";
      return `tomorrow.io rate-limited${wait} — free plan caps 25/hour, 500/day`;
    }
    if (err.isAuth) {
      return "tomorrow.io rejected the API key — check TOMORROW_IO_API_KEY";
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

// Gate the manual fetch trigger on a shared secret. Constant-time-ish
// comparison via byte-by-byte XOR over equal-length strings; we only need
// to defeat trivial brute-force tools, not a state-level adversary.
export function checkTriggerAuth(request: Request, env: WeatherPlugEnv): Response | null {
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
