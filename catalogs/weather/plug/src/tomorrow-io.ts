// Tomorrow.io v4 weather adapter. Three calls per snapshot — realtime,
// forecast (1h+1d), recent history (1h+1d) — assembled into the canonical
// $weather_block bundle: a flat scalar `current`, a per-day `daily`
// rollup, and a column-major ±7d hourly `timeseries`.
//
// Free tier (May 2026): 25 req/hour, 500 req/day, 3 req/sec. Three calls
// per cron tick at hourly cadence ≈ 72 calls/day per block, well inside
// the daily cap. 429 surfaces as `TomorrowIoError.isRateLimit` so the
// plug can degrade gracefully on Retry-After.

const ENDPOINT = "https://api.tomorrow.io/v4";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
const HOURS_BACK = 168;        // past 7 days
const HOURS_FORWARD = 168;     // next 7 days
const TOTAL_HOURS = HOURS_BACK + HOURS_FORWARD;

// One row per metric in the column-major hourly grid. `agg` records the
// rule the plug used to fold this metric into the daily rollup, so a
// generic UI can label the daily values without a hardcoded table.
//
// `source` may be a single tomorrow.io field key, or an array of keys
// whose values are summed (used for precipitation, which v4 splits into
// rain / snow / sleet / freezingRain intensity components).
type FieldDef = {
  name: string;
  source: string | readonly string[];
  unit: { metric: string; imperial: string };
  agg: AggRule;
};

type AggRule = "mean" | "max" | "sum" | "mode";

// Precipitation in tomorrow.io v4 is split by type. We sum the four
// intensity fields for "any precipitation happening this hour" and the
// four accumulation sums for "total precipitation this day".
const PRECIP_INTENSITY_SOURCES = ["rainIntensity", "snowIntensity", "sleetIntensity", "freezingRainIntensity"] as const;
const PRECIP_ACCUM_SUM_SOURCES = ["rainAccumulationSum", "snowAccumulationSum", "sleetAccumulationSum", "iceAccumulationSum"] as const;

const FIELDS: FieldDef[] = [
  { name: "temperature",          source: "temperature",               unit: { metric: "°C",    imperial: "°F"    }, agg: "mean" },
  { name: "temperature_apparent", source: "temperatureApparent",       unit: { metric: "°C",    imperial: "°F"    }, agg: "mean" },
  { name: "dew_point",            source: "dewPoint",                  unit: { metric: "°C",    imperial: "°F"    }, agg: "mean" },
  { name: "humidity",             source: "humidity",                  unit: { metric: "%",     imperial: "%"     }, agg: "mean" },
  { name: "cloud_cover",          source: "cloudCover",                unit: { metric: "%",     imperial: "%"     }, agg: "mean" },
  { name: "precip_prob",          source: "precipitationProbability",  unit: { metric: "%",     imperial: "%"     }, agg: "max"  },
  { name: "precip_intensity",     source: PRECIP_INTENSITY_SOURCES,    unit: { metric: "mm/hr", imperial: "in/hr" }, agg: "max"  },
  { name: "wind_speed",           source: "windSpeed",                 unit: { metric: "m/s",   imperial: "mph"   }, agg: "max"  },
  { name: "weather_code",         source: "weatherCode",               unit: { metric: "",      imperial: ""      }, agg: "mode" }
];

export type TomorrowUnits = "metric" | "imperial";

export type WeatherCurrent = {
  temperature: number | null;
  temperature_unit: string;
  humidity: number | null;
  weather_code: number | null;
  /** ms epoch (UTC). The index layer adds `observed_at_text` for chat verbs. */
  observed_at: number;
  observed_at_text?: string;
  observed_timezone?: string;
  /**
   * YYYY-MM-DD in the configured timezone, stamped at observation time by the
   * index layer (timezone is not known to `buildCurrent`). Lets woocode verbs
   * resolve "today" against `daily[*].date` without doing IANA TZ math in the
   * VM, which has no Intl access.
   */
  local_date?: string;
};

export type WeatherDailyEntry = {
  date: string;       // YYYY-MM-DD in the configured timezone
  /**
   * Lowercase 3-letter weekday ("mon".."sun") for the local calendar date
   * above. Computed from `date` deterministically so woocode verbs can match
   * "thursday" / "thu" without computing weekdays in pure DSL.
   */
  weekday: string;
  temperature: { min: number | null; max: number | null; mean: number | null; unit: string };
  humidity: { min: number | null; max: number | null; mean: number | null };
  precip_total: number | null;
  precip_unit: string;
  weather_code: number | null;
};

export type WeatherTimeseriesField = {
  unit: string;
  agg: AggRule;
  values: Array<number | null>;
};

export type WeatherTimeseries = {
  anchor: number;
  t0: number;
  step: number;
  units: TomorrowUnits;
  fields: Record<string, WeatherTimeseriesField>;
};

export type WeatherSnapshot = {
  current: WeatherCurrent;
  daily: WeatherDailyEntry[];
  timeseries: WeatherTimeseries;
  fetched_at: number;
};

export type TomorrowFetchOptions = {
  apiKey: string;
  place: string;
  /** IANA timezone — used for daily date bucketing in `daily[*].date`. */
  timezone: string;
  units?: TomorrowUnits;
  fetchImpl?: typeof fetch;
  /** Override "now" for tests. Defaults to Date.now. */
  now?: () => number;
};

export async function fetchWeather(options: TomorrowFetchOptions): Promise<WeatherSnapshot> {
  const { apiKey, place, timezone } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const units: TomorrowUnits = options.units === "imperial" ? "imperial" : "metric";
  const now = options.now ?? Date.now;
  const fetchedAt = now();

  // The three GETs are independent and well within the 3-req/sec cap, so
  // we issue them in parallel to halve wall-clock latency on cold starts.
  // Promise.all rejects on the first failure; in-flight callees still
  // hit the upstream but their results are discarded — that costs the
  // quota a few extra calls in failure cases, which is acceptable.
  const [realtime, forecast, history] = await Promise.all([
    getJson(fetchImpl, `${ENDPOINT}/weather/realtime`, {
      location: place, apikey: apiKey, units
    }),
    getJson(fetchImpl, `${ENDPOINT}/weather/forecast`, {
      location: place, apikey: apiKey, timesteps: "1h,1d", units
    }),
    getJson(fetchImpl, `${ENDPOINT}/weather/history/recent`, {
      location: place, apikey: apiKey, timesteps: "1h,1d", units
    })
  ]);

  return {
    current: buildCurrent(realtime, units, fetchedAt),
    daily: buildDaily(forecast, history, units, timezone),
    timeseries: buildTimeseries(forecast, history, fetchedAt, units),
    fetched_at: fetchedAt
  };
}

export function buildCurrent(realtime: any, units: TomorrowUnits, fallbackAt: number): WeatherCurrent {
  const v = realtime?.data?.values ?? {};
  const observedISO = realtime?.data?.time;
  const observedAt = typeof observedISO === "string" ? Date.parse(observedISO) : NaN;
  return {
    temperature: numberOrNull(v.temperature),
    temperature_unit: units === "imperial" ? "°F" : "°C",
    humidity: numberOrNull(v.humidity),
    weather_code: numberOrNull(v.weatherCode),
    observed_at: Number.isFinite(observedAt) ? observedAt : fallbackAt
  };
}

export function buildTimeseries(forecast: any, history: any, anchor: number, units: TomorrowUnits): WeatherTimeseries {
  // Anchor snaps to top-of-hour so points line up with the hourly cron
  // cadence and adjacent ticks produce comparable t0s.
  const anchorHour = Math.floor(anchor / HOUR_MS) * HOUR_MS;
  const t0 = anchorHour - HOURS_BACK * HOUR_MS;

  const fields: Record<string, WeatherTimeseriesField> = {};
  for (const f of FIELDS) {
    fields[f.name] = {
      unit: f.unit[units],
      agg: f.agg,
      // null for gaps: d3.line()'s .defined() skips them cleanly.
      values: new Array(TOTAL_HOURS).fill(null)
    };
  }

  // History fills the back half; forecast fills the front half. If the
  // upstream returns the current hour in both, forecast wins (because it
  // is fed last) — that's the right preference for "now".
  fillHourly(extractHourly(history), fields, t0);
  fillHourly(extractHourly(forecast), fields, t0);

  return { anchor, t0, step: HOUR_MS, units, fields };
}

function fillHourly(entries: any[] | null, fields: Record<string, WeatherTimeseriesField>, t0: number): void {
  if (!entries) return;
  for (const entry of entries) {
    const ts = parseEntryTime(entry);
    if (!Number.isFinite(ts)) continue;
    const idx = Math.round((ts - t0) / HOUR_MS);
    if (idx < 0 || idx >= TOTAL_HOURS) continue;
    const v = entry?.values ?? {};
    for (const f of FIELDS) {
      const value = readSourceValue(v, f.source);
      if (value !== null) fields[f.name].values[idx] = value;
    }
  }
}

// Resolves a FieldDef.source against a values object. A string source is
// a direct lookup; an array source is the sum of all numeric variants
// found (used for typed precipitation that v4 splits across rain/snow/
// sleet/freezing-rain). Returns null when no source had a numeric value
// — important for column-major nulls so d3.line().defined() can skip them.
function readSourceValue(values: Record<string, unknown>, source: string | readonly string[]): number | null {
  if (typeof source === "string") {
    const raw = values[source];
    if (raw === undefined || raw === null) return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  }
  let total = 0;
  let any = false;
  for (const key of source) {
    const raw = values[key];
    if (raw === undefined || raw === null) continue;
    const num = Number(raw);
    if (!Number.isFinite(num)) continue;
    total += num;
    any = true;
  }
  return any ? total : null;
}

export function buildDaily(forecast: any, history: any, units: TomorrowUnits, timezone: string): WeatherDailyEntry[] {
  const tempUnit = units === "imperial" ? "°F" : "°C";
  const precipUnit = units === "imperial" ? "in" : "mm";

  // History first so future-side forecast values overwrite the overlapping
  // "today" entry — forecast carries the day's tail, history only its head.
  const byDate = new Map<string, any>();
  for (const entry of extractDaily(history) ?? []) {
    const date = bucketDate(entry, timezone);
    if (date) byDate.set(date, entry?.values ?? {});
  }
  for (const entry of extractDaily(forecast) ?? []) {
    const date = bucketDate(entry, timezone);
    if (date) byDate.set(date, entry?.values ?? {});
  }

  return Array.from(byDate.keys())
    .sort()
    .map((date) => {
      const v = byDate.get(date) ?? {};
      return {
        date,
        weekday: weekdayFromDate(date),
        temperature: {
          min:  numberOrNull(v.temperatureMin),
          max:  numberOrNull(v.temperatureMax),
          mean: numberOrNull(v.temperatureAvg ?? v.temperatureMean),
          unit: tempUnit
        },
        humidity: {
          min:  numberOrNull(v.humidityMin),
          max:  numberOrNull(v.humidityMax),
          mean: numberOrNull(v.humidityAvg ?? v.humidityMean)
        },
        precip_total: readSourceValue(v, PRECIP_ACCUM_SUM_SOURCES),
        precip_unit:  precipUnit,
        // weatherCode in v4's daily envelope is split across Avg/Max/Min;
        // we use Max as a heuristic for "most severe condition of the day"
        // (codes are ordered roughly by severity). Some older envelopes
        // returned weatherCode instead — accept both.
        weather_code: numberOrNull(v.weatherCodeMax ?? v.weatherCode)
      };
    });
}

// Merge a freshly-built timeseries with the prior accumulated state from
// the block. Free-tier tomorrow.io only returns 24 h of hourly history
// per fetch, so the chart's past-week half stays sparse without this
// merge. The plug runs hourly, retains what it has fetched before, and
// fills any null in `next` from the corresponding *absolute timestamp*
// in `prev` — anchor shifts ~1 hour per tick, so slot indices are not
// directly comparable across calls.
//
// New values always win when present (the API is authoritative for the
// last 24 h and re-issued forecasts revise future slots). Prior values
// only fill gaps where the API returned nothing — typically slots older
// than 24 h that the plug has accumulated since cold start.
export function mergeTimeseries(prev: WeatherTimeseries | null | undefined, next: WeatherTimeseries): WeatherTimeseries {
  if (!isUsableTimeseries(prev)) return next;
  // Different step shapes can't be aligned by absolute timestamp at
  // hourly precision; bail rather than risk silently wrong data.
  if (prev.step !== next.step) return next;
  const merged: WeatherTimeseries = { ...next, fields: {} };
  for (const [name, nextField] of Object.entries(next.fields)) {
    const prevField = prev.fields?.[name];
    if (!prevField || !Array.isArray(prevField.values)) {
      merged.fields[name] = nextField;
      continue;
    }
    const values = nextField.values.slice();
    for (let i = 0; i < values.length; i++) {
      if (values[i] !== null) continue;
      const ts = next.t0 + i * next.step;
      const prevIdx = Math.round((ts - prev.t0) / prev.step);
      if (prevIdx < 0 || prevIdx >= prevField.values.length) continue;
      const prevValue = prevField.values[prevIdx];
      if (prevValue !== null && prevValue !== undefined) values[i] = prevValue;
    }
    merged.fields[name] = { ...nextField, values };
  }
  return merged;
}

function isUsableTimeseries(value: unknown): value is WeatherTimeseries {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.t0 === "number" && typeof v.step === "number" && v.fields !== null && typeof v.fields === "object";
}

// Merge a fresh daily array with the prior accumulated state. Keyed by
// `date` (YYYY-MM-DD in the configured timezone): new entries overwrite
// prior values for the overlapping window (forecast revises), prior
// entries survive for dates outside the API's coverage window. Trimmed
// to ±7 d around the anchor so the array never grows unbounded.
export function mergeDaily(prev: WeatherDailyEntry[] | null | undefined, next: WeatherDailyEntry[], anchor: number, timezone: string): WeatherDailyEntry[] {
  const byDate = new Map<string, WeatherDailyEntry>();
  if (Array.isArray(prev)) {
    for (const e of prev) {
      if (e && typeof e.date === "string") byDate.set(e.date, normalizeDailyEntry(e));
    }
  }
  for (const e of next) {
    if (e && typeof e.date === "string") byDate.set(e.date, normalizeDailyEntry(e));
  }
  // YYYY-MM-DD strings sort the same lexically as chronologically.
  const minDate = formatLocalDate(anchor - 7 * DAY_MS, timezone);
  const maxDate = formatLocalDate(anchor + 7 * DAY_MS, timezone);
  return Array.from(byDate.values())
    .filter((e) => e.date >= minDate && e.date <= maxDate)
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

// Backfill weekday on entries minted by older plug versions (pre-1.1) that
// the block has been carrying forward across ticks. Without this,
// $weather_block:ask "thursday" would silently miss any prev-side entry that
// the upstream API no longer covers, until the next forecast/history fetch
// happens to overwrite it. Cheap to do at every merge — `weekdayFromDate`
// is a single Date parse, and the entry shape is otherwise unchanged.
function normalizeDailyEntry(entry: WeatherDailyEntry): WeatherDailyEntry {
  if (typeof entry.weekday === "string" && entry.weekday) return entry;
  return { ...entry, weekday: weekdayFromDate(entry.date) };
}

// Tomorrow.io's response shape varies between endpoints and SDK versions:
// some return `{timelines: {hourly: [...], daily: [...]}}` keyed by step,
// others `{data: {timelines: [{timestep, intervals}, ...]}}`. Accept both
// to stay resilient to upstream churn.
function extractHourly(payload: any): any[] | null {
  return extractTimeline(payload, "hourly", "1h");
}
function extractDaily(payload: any): any[] | null {
  return extractTimeline(payload, "daily", "1d");
}
function extractTimeline(payload: any, key: string, step: string): any[] | null {
  const keyed = payload?.timelines?.[key] ?? payload?.data?.timelines?.[key];
  if (Array.isArray(keyed)) return keyed;
  const arr = payload?.data?.timelines;
  if (Array.isArray(arr)) {
    const t = arr.find((tl: any) => tl?.timestep === step);
    return Array.isArray(t?.intervals) ? t.intervals : null;
  }
  return null;
}

function parseEntryTime(entry: any): number {
  const t = entry?.time ?? entry?.startTime;
  return typeof t === "string" ? Date.parse(t) : NaN;
}

function bucketDate(entry: any, timezone: string): string | null {
  const ts = parseEntryTime(entry);
  if (!Number.isFinite(ts)) return null;
  return formatLocalDate(ts, timezone);
}

// Exported so index.ts can stamp current.local_date with the same formatter
// that buckets daily[*].date — guarantees "today" matches a daily entry by
// string equality.
export function formatLocalDate(ts: number, timezone: string): string {
  // en-CA emits ISO YYYY-MM-DD across V8 / SpiderMonkey / Workers.
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

// "YYYY-MM-DD" → "mon".."sun". Parsing as UTC midnight and reading getUTCDay
// is correct here because the input is already a calendar date in the block's
// timezone — we just need to know which weekday that calendar date falls on,
// not anything about wall-clock time. Returns "" for malformed input so a
// faulty entry can't crash the build.
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export function weekdayFromDate(date: string): string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const d = new Date(`${date}T00:00:00Z`);
  const i = d.getUTCDay();
  return Number.isFinite(i) && i >= 0 && i <= 6 ? WEEKDAY_NAMES[i] : "";
}

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class TomorrowIoError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly retryAfter: number | null,
    public readonly bodyExcerpt: string
  ) {
    const reason = status === 429 ? "rate limited"
      : status === 401 || status === 403 ? "auth rejected"
      : `${status} ${statusText}`;
    super(`tomorrow.io ${reason}${bodyExcerpt ? `: ${bodyExcerpt}` : ""}`);
    this.name = "TomorrowIoError";
  }

  get isRateLimit(): boolean { return this.status === 429; }
  get isAuth(): boolean      { return this.status === 401 || this.status === 403; }
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  query: Record<string, string>
): Promise<any> {
  const params = new URLSearchParams(query);
  const response = await fetchImpl(`${url}?${params.toString()}`);
  if (!response.ok) {
    const text = await response.text();
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfter = retryAfterHeader ? parseRetryAfter(retryAfterHeader) : null;
    throw new TomorrowIoError(response.status, response.statusText, retryAfter, text.slice(0, 200));
  }
  return response.json();
}

function parseRetryAfter(value: string): number | null {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, Math.floor((date - Date.now()) / 1000));
}
