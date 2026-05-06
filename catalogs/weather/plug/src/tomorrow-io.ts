// Tomorrow.io v4 weather adapter. Translates the API response into the
// canonical shapes a `$block` exposes: scalar (current temp), table-shaped
// historical and forecast series.
//
// Free tier: realtime + forecast endpoints. Historical requires a paid plan;
// for the demo we keep `history` populated from the last N hourly forecasts
// the plug has fetched (rolling buffer in the block's prop) — i.e. the plug
// always pushes forecast, and the block-side `history` is a function of
// previously-pushed `current` values. Implementing that rolling buffer is
// out of scope for this initial plug; for v1 we ship `current` and
// `forecast`, leave `history` empty.

const ENDPOINT = "https://api.tomorrow.io/v4";

export type WeatherCurrent = {
  kind: "scalar";
  value: number;
  unit: string;
  label: string;
  observed_at: string;
};

export type WeatherForecastPoint = {
  time: string;
  temperature: number;
  precipitation_probability: number;
  weather_code: number;
};

export type WeatherForecast = {
  kind: "series";
  series: [
    {
      name: "temperature";
      unit: string;
      points: Array<[string, number]>;
    }
  ];
  hourly: WeatherForecastPoint[];
};

export type WeatherSnapshot = {
  current: WeatherCurrent;
  forecast: WeatherForecast;
  fetched_at: number;
};

export type TomorrowUnits = "metric" | "imperial";

export type TomorrowFetchOptions = {
  apiKey: string;
  place: string;
  forecastHours?: number;
  /** "metric" → °C; "imperial" → °F. Tomorrow.io's `units` param expects the
   * same vocabulary, so the value flows through unchanged. Defaults to
   * "metric" to match $weather_block's manifest default. */
  units?: TomorrowUnits;
  fetchImpl?: typeof fetch;
};

export async function fetchWeather(options: TomorrowFetchOptions): Promise<WeatherSnapshot> {
  const { apiKey, place } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const forecastHours = options.forecastHours ?? 24;
  const units: TomorrowUnits = options.units === "imperial" ? "imperial" : "metric";
  const tempUnit = units === "imperial" ? "°F" : "°C";

  const realtime = await getJson(fetchImpl, ENDPOINT + "/weather/realtime", {
    location: place,
    apikey: apiKey,
    units
  });

  const forecast = await getJson(fetchImpl, ENDPOINT + "/weather/forecast", {
    location: place,
    apikey: apiKey,
    timesteps: "1h",
    units
  });

  const realtimeValues = realtime?.data?.values ?? {};
  const realtimeTime = String(realtime?.data?.time ?? new Date().toISOString());
  const current: WeatherCurrent = {
    kind: "scalar",
    value: Number(realtimeValues.temperature ?? 0),
    unit: tempUnit,
    label: "current_temperature",
    observed_at: realtimeTime
  };

  const hourly = (forecast?.timelines?.hourly ?? [])
    .slice(0, forecastHours)
    .map((entry: any): WeatherForecastPoint => ({
      time: String(entry.time),
      temperature: Number(entry.values?.temperature ?? 0),
      precipitation_probability: Number(entry.values?.precipitationProbability ?? 0),
      weather_code: Number(entry.values?.weatherCode ?? 0)
    }));

  const series: [string, number][] = hourly.map((p: WeatherForecastPoint) => [p.time, p.temperature]);

  const forecastShape: WeatherForecast = {
    kind: "series",
    series: [
      {
        name: "temperature",
        unit: tempUnit,
        points: series
      }
    ],
    hourly
  };

  return {
    current,
    forecast: forecastShape,
    fetched_at: Date.now()
  };
}

// Free plan: 25 requests / hour, 500 / day, 3 / second. The hourly cron runs
// 2 calls per tick (realtime + forecast), so one block fits comfortably; a
// dozen blocks sharing one API key will start hitting the daily ceiling.
// 429s are surfaced with the API key intact so the plug retries next tick.

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

  get isRateLimit(): boolean {
    return this.status === 429;
  }
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
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
