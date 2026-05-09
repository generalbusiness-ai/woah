// Weather plug Worker.
//
// Cron-triggered. Each tick:
//   1. Authenticate to woo with the actor-bound apikey for the weather block.
//   2. Read the block's owner-set `place`, `units`, `timezone` properties.
//   3. Fetch tomorrow.io (realtime + forecast 1h+1d + history 1h+1d).
//   4. Push the {current, daily, timeseries, last_pushed_at, last_error,
//      config_state} bundle via :set_properties in a single call.
//
// Disconnects between ticks. The block keeps last-set values across plug
// downtime; the SPA renders "stale, last seen ..." from `last_pushed_at` and
// the block-side freshness window.

import { WooClient, WooError } from "./woo-client";
import {
  fetchWeather,
  formatLocalDate,
  mergeDaily,
  mergeTimeseries,
  TomorrowIoError,
  type TomorrowUnits,
  type WeatherCurrent,
  type WeatherDailyEntry,
  type WeatherSnapshot,
  type WeatherTimeseries
} from "./tomorrow-io";

export interface WeatherPlugEnv {
  WOO_BASE_URL: string;
  WOO_APIKEY: string;
  TOMORROW_IO_API_KEY: string;
  BLOCK_ID: string;
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

export class WeatherConfigError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly value?: unknown
  ) {
    super(message);
    this.name = "WeatherConfigError";
  }
}

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
    const message = "owner has not configured `place`; set it to a town name or zip code";
    await writeConfigError(client, env.BLOCK_ID, "E_NO_PLACE", message, { place: placeValue });
    throw new WeatherConfigError("E_NO_PLACE", message, 400, { place: placeValue });
  }

  // Owner-set knobs ride writable_owner on the block. The plug honors them
  // verbatim — this is the "config props are owner-writable" half of the
  // $block contract.
  const unitsRaw = await client.getProperty(env.BLOCK_ID, "units");
  const units: TomorrowUnits = unitsRaw === "imperial" ? "imperial" : "metric";
  const timezoneRaw = await getOptionalProperty(client, env.BLOCK_ID, "timezone");
  const timezone = normalizeTimezone(timezoneRaw);
  if (!timezone) {
    const message = "owner has not configured a valid timezone; use an IANA timezone such as America/Los_Angeles";
    await writeConfigError(client, env.BLOCK_ID, "E_BAD_TIMEZONE", message, { place, timezone: timezoneRaw });
    throw new WeatherConfigError("E_BAD_TIMEZONE", message, 400, { place, timezone: timezoneRaw });
  }
  const tomorrowPlace = normalizeTomorrowLocation(place);

  // Read what the plug has previously written so we can accumulate past
  // observations beyond tomorrow.io's free-tier window (24 h hourly /
  // 2 d daily). Cold start: both come back as `{}` / `[]` defaults; the
  // merge functions handle that. The cost is two extra woo REST calls
  // per tick — no tomorrow.io quota impact.
  const priorTimeseries = coerceTimeseries(await getOptionalProperty(client, env.BLOCK_ID, "timeseries"));
  const priorDaily = coerceDaily(await getOptionalProperty(client, env.BLOCK_ID, "daily"));

  let snapshot: WeatherSnapshot;
  try {
    snapshot = await fetchWeather({
      apiKey: env.TOMORROW_IO_API_KEY,
      place: tomorrowPlace,
      timezone,
      units,
      fetchImpl
    });
  } catch (err) {
    const message = formatLastError(err, place);
    if (isConfigSourceError(err)) {
      await writeConfigError(client, env.BLOCK_ID, errorConfigCode(err), message, { place, timezone });
    } else {
      await client.directCall(env.BLOCK_ID, "set_property", ["last_error", message]);
    }
    throw err;
  }

  const mergedTimeseries = mergeTimeseries(priorTimeseries, snapshot.timeseries);
  const mergedDaily = mergeDaily(priorDaily, snapshot.daily, snapshot.fetched_at, timezone);

  // Single-bundle write so a reader never observes a torn snapshot
  // (e.g. a fresh `current` paired with a stale `daily`).
  await client.directCall(env.BLOCK_ID, "set_properties", [
    {
      current: withLocalObservationTime(snapshot.current, timezone),
      daily: mergedDaily,
      timeseries: mergedTimeseries,
      last_pushed_at: snapshot.fetched_at,
      last_error: null,
      config_state: {
        status: "confirmed",
        message: "weather plug confirmed location and timezone",
        place,
        timezone,
        confirmed_at: snapshot.fetched_at
      }
    }
  ]);

  return { block: env.BLOCK_ID, place, fetched_at: snapshot.fetched_at };
}

// Light shape guards at the woo-REST boundary. The block defaults
// `timeseries` to `{}` and `daily` to `[]`, so a cold-start tick sees
// "empty but not null" — coerce to `null` so the merge code can take
// the simple "no prior" branch.
function coerceTimeseries(raw: unknown): WeatherTimeseries | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.t0 !== "number" || typeof v.step !== "number" || !v.fields) return null;
  return raw as WeatherTimeseries;
}
function coerceDaily(raw: unknown): WeatherDailyEntry[] | null {
  return Array.isArray(raw) && raw.length > 0 ? raw as WeatherDailyEntry[] : null;
}

export function normalizeTomorrowLocation(place: string): string {
  return place.trim();
}

async function getOptionalProperty(client: WooClient, blockId: string, name: string): Promise<unknown> {
  try {
    return await client.getProperty(blockId, name);
  } catch (err) {
    if (err instanceof WooError && (err.code === "E_PROPNF" || err.status === 404)) return null;
    throw err;
  }
}

export function normalizeTimezone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timezone = value.trim();
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch {
    return null;
  }
}

export function withLocalObservationTime(current: WeatherCurrent, timezone: string | null): WeatherCurrent {
  // local_date stamps the calendar date (in the configured timezone) at the
  // moment of observation, so woocode verbs can resolve "today" by string
  // equality against daily[*].date — the VM has no Intl/TZ math, so this
  // lookup must be done by the plug at push time.
  const localDate = timezone && Number.isFinite(current.observed_at)
    ? formatLocalDate(current.observed_at, timezone)
    : undefined;
  return {
    ...current,
    observed_at_text: formatObservedAt(current.observed_at, timezone),
    observed_timezone: timezone ?? "UTC",
    ...(localDate ? { local_date: localDate } : {})
  };
}

export function formatObservedAt(observedAt: number, timezone: string | null): string {
  if (!Number.isFinite(observedAt)) return "an unknown time";
  if (!timezone) return formatUtcMinute(observedAt);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(new Date(observedAt));
  } catch {
    return formatUtcMinute(observedAt);
  }
}

function formatUtcMinute(at: number): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
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
  if (err instanceof WeatherConfigError) {
    return { category: `weather_config:${err.code}`, code: err.code, status: err.status, message: err.message };
  }
  if (err instanceof WooError) {
    return { category: `woo:${err.code}`, code: err.code, status: err.status, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { category: "unknown", message };
}

function formatLastError(err: unknown, place?: string): string {
  if (err instanceof TomorrowIoError) {
    if (err.isRateLimit) {
      const wait = err.retryAfter ? ` (retry after ${err.retryAfter}s)` : "";
      return `tomorrow.io rate-limited${wait} - free plan caps 25/hour, 500/day`;
    }
    if (err.isAuth) {
      return "tomorrow.io rejected the API key - check TOMORROW_IO_API_KEY";
    }
    if (err.status === 400 || err.status === 404) {
      const configured = place?.trim() ? ` "${place.trim()}"` : "";
      return `tomorrow.io could not fetch weather for${configured} - set place to a town name or zip code it recognizes`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

async function writeConfigError(client: WooClient, blockId: string, code: string, message: string, value: Record<string, unknown>): Promise<void> {
  await client.directCall(blockId, "set_properties", [
    {
      last_error: message,
      config_state: {
        status: "error",
        code,
        message,
        ...value,
        checked_at: Date.now()
      }
    }
  ]);
}

function isConfigSourceError(err: unknown): boolean {
  return err instanceof TomorrowIoError && (err.status === 400 || err.status === 404);
}

function errorConfigCode(err: unknown): string {
  if (err instanceof TomorrowIoError && err.status === 404) return "E_UNKNOWN_PLACE";
  return "E_BAD_PLACE";
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
  if (err instanceof WeatherConfigError) {
    return Response.json(
      { ok: false, code: err.code, message: err.message, value: err.value },
      { status: err.status >= 400 && err.status < 600 ? err.status : 500 }
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ ok: false, code: "E_INTERNAL", message }, { status: 500 });
}
