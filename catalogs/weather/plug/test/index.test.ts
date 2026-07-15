import { describe, expect, it } from "vitest";
import { formatObservedAt, normalizeTimezone, normalizeTomorrowLocation, runWeatherTick, type WeatherPlugEnv } from "../src/index";

type Call = { url: string; method: string; body?: unknown };
type Reply = { status: number; body: unknown; headers?: Record<string, string> };

// Two-mode mock fetch:
//   - As an array of handlers, each handler responds to the i-th call.
//   - As a Map keyed by URL substring, each handler responds whenever the
//     incoming URL contains the key. The Map mode is used by tests that
//     fan out parallel tomorrow.io requests where Promise.all() ordering
//     is well-defined (insertion order of the Promise array) but easier
//     to assert when keyed by endpoint.
function makeFetch(handlers: Array<(call: Call) => Reply>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call: Call = { url, method, body };
    calls.push(call);
    const handler = handlers[i++];
    const reply: Reply = handler ? handler(call) : { status: 404, body: { error: { code: "E_NOMATCH" } } };
    const headers = new Headers(reply.headers ?? {});
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const env: WeatherPlugEnv = {
  WOO_BASE_URL: "https://woo.example",
  WOO_APIKEY: "apikey:abc:def",
  TOMORROW_IO_API_KEY: "tomorrow-secret",
  BLOCK_ID: "the_weather_block"
};

const propertyReply = (value: unknown): Reply => ({
  status: 200,
  body: { cell: { value: { value } } }
});

const turnReply = (result: unknown = null): Reply => ({
  status: 200,
  body: { reply: { status: "accepted" }, result, observations: [] }
});

// Minimal but representative tomorrow.io payloads. Hourly arrays are
// short — the rollup logic is exercised in tomorrow-io.test.ts; here
// we just check that the plug wires the response into a set_properties
// bundle with the right top-level shape.
const realtimeReply = (): Reply => ({
  status: 200,
  body: {
    data: {
      time: "2026-05-05T18:00:00Z",
      values: { temperature: 72.4, humidity: 60, weatherCode: 1000 }
    }
  }
});

const forecastReply: Reply = {
  status: 200,
  body: {
    timelines: {
      hourly: [
        { time: "2026-05-05T19:00:00Z", values: { temperature: 73, humidity: 58, precipitationProbability: 5, weatherCode: 1000 } },
        { time: "2026-05-05T20:00:00Z", values: { temperature: 71, humidity: 62, precipitationProbability: 10, weatherCode: 1100 } }
      ],
      daily: [
        { time: "2026-05-05T07:00:00Z", values: { temperatureMin: 60, temperatureMax: 76, temperatureAvg: 68, humidityAvg: 60, rainAccumulationSum: 0.0, weatherCodeMax: 1000 } },
        { time: "2026-05-06T07:00:00Z", values: { temperatureMin: 58, temperatureMax: 74, temperatureAvg: 66, humidityAvg: 62, rainAccumulationSum: 0.05, weatherCodeMax: 1100 } }
      ]
    }
  }
};

const historyReply: Reply = {
  status: 200,
  body: {
    timelines: {
      hourly: [
        { time: "2026-05-05T17:00:00Z", values: { temperature: 70, humidity: 65, weatherCode: 1000 } },
        { time: "2026-05-05T16:00:00Z", values: { temperature: 68, humidity: 67, weatherCode: 1000 } }
      ],
      daily: [
        // Single rain source on this day — no float-summation surprise.
        { time: "2026-05-04T07:00:00Z", values: { temperatureMin: 55, temperatureMax: 71, temperatureAvg: 63, humidityAvg: 70, rainAccumulationSum: 0.12, weatherCodeMax: 4000 } }
      ]
    }
  }
};

describe("runWeatherTick", () => {
  it("auths, reads place/units/timezone, reads priors for accumulation, fetches realtime+forecast+history in parallel, pushes a single set_properties bundle", async () => {
    const { fetchImpl, calls } = makeFetch([
      // 1: woo auth
      () => ({ status: 200, body: { actor: "the_weather_block", session: "sess_w", expires_at: null, token_class: "apikey" } }),
      // 2: get place
      () => ({ status: 200, body: { cell: { value: { value: "Mountain View, CA" } } } }),
      // 3: get units
      () => ({ status: 200, body: { cell: { value: { value: "imperial" } } } }),
      // 4: get timezone
      () => ({ status: 200, body: { cell: { value: { value: "America/Los_Angeles" } } } }),
      // 5-6: prior accumulated state (cold start: defaults)
      () => ({ status: 200, body: { cell: { value: { value: {} } } } }),
      () => ({ status: 200, body: { cell: { value: { value: [] } } } }),
      // 7-9: tomorrow.io endpoints — Promise.all evaluates the array in
      // source order, so realtime is invoked first, then forecast, then history.
      () => realtimeReply(),
      () => forecastReply,
      () => historyReply,
      // 10: set_properties on the block
      () => ({ status: 200, body: { reply: { status: "accepted" }, result: { ok: true }, observations: [] } })
    ]);

    // Keep the daily retention window anchored to the fixture dates. This
    // test must not start dropping May 2026 rows as wall-clock time advances.
    const result = await runWeatherTick(env, { fetchImpl, now: () => Date.parse("2026-05-05T18:00:00Z") });
    expect(result).toMatchObject({ block: "the_weather_block", place: "Mountain View, CA" });

    expect(calls[0].url).toBe("https://woo.example/net-api/session");
    expect(calls[1].url).toContain("/net-api/cell?");
    expect(calls[1].url).toContain("property_cell%3Athe_weather_block%3Aplace");
    expect(calls[2].url).toContain("property_cell%3Athe_weather_block%3Aunits");
    expect(calls[3].url).toContain("property_cell%3Athe_weather_block%3Atimezone");
    expect(calls[4].url).toContain("property_cell%3Athe_weather_block%3Atimeseries");
    expect(calls[5].url).toContain("property_cell%3Athe_weather_block%3Adaily");
    expect(calls[6].url).toContain("api.tomorrow.io/v4/weather/realtime");
    expect(calls[6].url).toContain("units=imperial");
    expect(new URL(calls[6].url).searchParams.get("location")).toBe("Mountain View, CA");
    expect(calls[7].url).toContain("api.tomorrow.io/v4/weather/forecast");
    expect(new URL(calls[7].url).searchParams.get("timesteps")).toBe("1h,1d");
    expect(calls[8].url).toContain("api.tomorrow.io/v4/weather/history/recent");
    expect(new URL(calls[8].url).searchParams.get("timesteps")).toBe("1h,1d");

    const setProps = calls[9];
    expect(setProps.url).toBe("https://woo.example/net-api/turn");
    expect(setProps.method).toBe("POST");
    expect(setProps.body).toMatchObject({ target: "the_weather_block", verb: "set_properties", session: "sess_w" });
    const props = (setProps.body as { args: [Record<string, unknown>] }).args[0];

    expect(props.last_error).toBeNull();
    expect(props.last_pushed_at).toEqual(expect.any(Number));
    expect(props.config_state).toMatchObject({
      status: "confirmed",
      place: "Mountain View, CA",
      timezone: "America/Los_Angeles",
      confirmed_at: expect.any(Number)
    });

    // current — flat scalar bundle. ms-epoch observed_at, plug-rendered text.
    // local_date is the calendar date in the configured timezone at the moment
    // of observation; woocode :ask uses it to resolve "today" against
    // daily[*].date without doing IANA TZ math in the VM.
    expect(props.current).toMatchObject({
      temperature: 72.4,
      temperature_unit: "°F",
      humidity: 60,
      weather_code: 1000,
      observed_at: Date.parse("2026-05-05T18:00:00Z"),
      observed_at_text: "May 5, 2026, 11:00 AM PDT",
      observed_timezone: "America/Los_Angeles",
      local_date: "2026-05-05"
    });

    // daily — date-keyed rollups, ordered ascending. Both endpoints
    // contribute their respective dates; the overlap day (2026-05-05)
    // takes the forecast's values (forecast is fed last).
    const daily = props.daily as Array<Record<string, any>>;
    expect(daily.map((d) => d.date)).toEqual(["2026-05-04", "2026-05-05", "2026-05-06"]);
    expect(daily[0]).toMatchObject({
      date: "2026-05-04",
      temperature: { min: 55, max: 71, mean: 63, unit: "°F" },
      humidity: { mean: 70 },
      precip_total: 0.12,
      precip_unit: "in",
      weather_code: 4000
    });
    expect(daily[1].temperature).toMatchObject({ min: 60, max: 76, mean: 68, unit: "°F" });

    // timeseries — column-major. anchor + t0 + step + per-field arrays.
    const ts = props.timeseries as { anchor: number; t0: number; step: number; units: string; fields: Record<string, any> };
    expect(ts.step).toBe(3_600_000);
    expect(ts.units).toBe("imperial");
    expect(ts.t0).toBe(Math.floor(ts.anchor / 3_600_000) * 3_600_000 - 168 * 3_600_000);
    expect(Object.keys(ts.fields).sort()).toEqual([
      "cloud_cover", "dew_point", "humidity", "precip_intensity", "precip_prob", "temperature", "temperature_apparent", "weather_code", "wind_speed"
    ]);
    expect(ts.fields.temperature.unit).toBe("°F");
    expect(ts.fields.temperature.agg).toBe("mean");
    expect(ts.fields.temperature.values).toHaveLength(336);
    // Forecast wrote temperature into the slot for 19:00Z; we won't know the
    // exact index without the test owning the anchor, so just check that the
    // fixture's hourly values landed somewhere in the array.
    expect(ts.fields.temperature.values).toContain(73);
    expect(ts.fields.temperature.values).toContain(70);
  });

  it("honors block-set units=metric (default) and emits °C", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => ({ status: 200, body: { actor: "the_weather_block", session: "sess_w", expires_at: null, token_class: "apikey" } }),
      () => propertyReply("Berlin"),
      () => propertyReply("metric"),
      () => propertyReply("Europe/Berlin"),
      () => propertyReply({}),     // prior timeseries (cold start)
      () => propertyReply([]),     // prior daily (cold start)
      () => ({ status: 200, body: { data: { time: "2026-05-05T18:00:00Z", values: { temperature: 22.4 } } } }),
      () => ({ status: 200, body: { timelines: { hourly: [], daily: [] } } }),
      () => ({ status: 200, body: { timelines: { hourly: [], daily: [] } } }),
      () => turnReply({})
    ]);
    await runWeatherTick(env, { fetchImpl });
    expect(calls[6].url).toContain("units=metric");
    const props = (calls[9].body as { args: [Record<string, any>] }).args[0];
    expect(props.current).toMatchObject({
      temperature: 22.4,
      temperature_unit: "°C",
      observed_at_text: "May 5, 2026, 8:00 PM GMT+2"
    });
    expect(props.timeseries.units).toBe("metric");
    expect(props.timeseries.fields.temperature.unit).toBe("°C");
  });

  it("writes last_error to the block when place is missing", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => ({ status: 200, body: { actor: "the_weather_block", session: "sess_w", expires_at: null, token_class: "apikey" } }),
      () => propertyReply(""),
      () => turnReply()
    ]);

    await expect(runWeatherTick(env, { fetchImpl })).rejects.toMatchObject({ code: "E_NO_PLACE" });
    expect(calls[2].url).toBe("https://woo.example/net-api/turn");
    expect(calls[2].body).toMatchObject({ target: "the_weather_block", verb: "set_properties" });
    const props = (calls[2].body as { args: [Record<string, any>] }).args[0];
    expect(props.last_error).toMatch(/owner has not configured `place`/);
    expect(props.config_state).toMatchObject({ status: "error", code: "E_NO_PLACE" });
  });

  it("writes a config error when timezone is not usable", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => ({ status: 200, body: { actor: "the_weather_block", session: "sess_w", expires_at: null, token_class: "apikey" } }),
      () => propertyReply("Mountain View, CA"),
      () => propertyReply("imperial"),
      () => propertyReply("not/a-zone"),
      () => turnReply()
    ]);

    await expect(runWeatherTick(env, { fetchImpl })).rejects.toMatchObject({ code: "E_BAD_TIMEZONE" });
    expect(calls).toHaveLength(5);
    expect(calls[4].url).toBe("https://woo.example/net-api/turn");
    expect(calls[4].body).toMatchObject({ target: "the_weather_block", verb: "set_properties" });
    const props = (calls[4].body as { args: [Record<string, any>] }).args[0];
    expect(props.last_error).toMatch(/valid timezone/);
    expect(props.config_state).toMatchObject({
      status: "error",
      code: "E_BAD_TIMEZONE",
      place: "Mountain View, CA",
      timezone: "not/a-zone"
    });
  });

  it("writes a clean auth-rejected last_error when tomorrow.io returns 401", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => ({ status: 200, body: { actor: "the_weather_block", session: "sess_w", expires_at: null, token_class: "apikey" } }),
      () => propertyReply("Mountain View, CA"),
      () => propertyReply("imperial"),
      () => propertyReply("America/Los_Angeles"),
      () => propertyReply({}),
      () => propertyReply([]),
      ({ url }) => url.includes("api.tomorrow.io") ? { status: 401, body: { error: "invalid api key" } } : { status: 200, body: {} },
      ({ url }) => url.includes("api.tomorrow.io") ? { status: 401, body: { error: "invalid api key" } } : { status: 200, body: {} },
      ({ url }) => url.includes("api.tomorrow.io") ? { status: 401, body: { error: "invalid api key" } } : { status: 200, body: {} },
      () => turnReply()
    ]);

    await expect(runWeatherTick(env, { fetchImpl })).rejects.toThrow();
    // After the three parallel API calls, the plug writes last_error. Find
    // that call (the only set_property) rather than asserting an index, since
    // Promise.all rejection can race with the outer flow.
    const errCall = calls.find((c) => (c.body as { verb?: string } | undefined)?.verb === "set_property");
    expect(errCall).toBeDefined();
    const args = (errCall!.body as { args: unknown[] }).args;
    expect(args[0]).toBe("last_error");
    expect(args[1]).toMatch(/rejected the API key/i);
    expect(args[1]).toMatch(/TOMORROW_IO_API_KEY/);
  });

  it("writes a clean rate-limit last_error when tomorrow.io returns 429", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => ({ status: 200, body: { actor: "the_weather_block", session: "sess_w", expires_at: null, token_class: "apikey" } }),
      () => propertyReply("Mountain View, CA"),
      () => propertyReply("imperial"),
      () => propertyReply("America/Los_Angeles"),
      () => propertyReply({}),
      () => propertyReply([]),
      ({ url }) => url.includes("api.tomorrow.io") ? { status: 429, body: { code: 429001, message: "rate limit exceeded" }, headers: { "Retry-After": "120" } } : { status: 200, body: {} },
      ({ url }) => url.includes("api.tomorrow.io") ? { status: 429, body: { code: 429001, message: "rate limit exceeded" }, headers: { "Retry-After": "120" } } : { status: 200, body: {} },
      ({ url }) => url.includes("api.tomorrow.io") ? { status: 429, body: { code: 429001, message: "rate limit exceeded" }, headers: { "Retry-After": "120" } } : { status: 200, body: {} },
      () => turnReply()
    ]);

    await expect(runWeatherTick(env, { fetchImpl })).rejects.toThrow();
    const errCall = calls.find((c) => (c.body as { verb?: string } | undefined)?.verb === "set_property");
    expect(errCall).toBeDefined();
    const args = (errCall!.body as { args: unknown[] }).args;
    expect(args[0]).toBe("last_error");
    expect(args[1]).toMatch(/rate-limited/i);
    expect(args[1]).toMatch(/retry after 120s/);
    expect(args[1]).toMatch(/25\/hour/);
  });

  it("writes a helpful last_error when tomorrow.io does not recognize the configured place", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => ({ status: 200, body: { actor: "the_weather_block", session: "sess_w", expires_at: null, token_class: "apikey" } }),
      () => propertyReply("Atlantis"),
      () => propertyReply("imperial"),
      () => propertyReply("America/Los_Angeles"),
      () => propertyReply({}),
      () => propertyReply([]),
      ({ url }) => url.includes("api.tomorrow.io") ? { status: 400, body: { message: "location not found" } } : { status: 200, body: {} },
      ({ url }) => url.includes("api.tomorrow.io") ? { status: 400, body: { message: "location not found" } } : { status: 200, body: {} },
      ({ url }) => url.includes("api.tomorrow.io") ? { status: 400, body: { message: "location not found" } } : { status: 200, body: {} },
      () => turnReply()
    ]);

    await expect(runWeatherTick(env, { fetchImpl })).rejects.toThrow();
    const apiCall = calls.find((c) => c.url.includes("api.tomorrow.io"));
    expect(new URL(apiCall!.url).searchParams.get("location")).toBe("Atlantis");
    const errCall = calls.find((c) => (c.body as any)?.verb === "set_properties" && (c.body as any)?.args?.[0]?.config_state?.status === "error");
    expect(errCall).toBeDefined();
    const props = (errCall!.body as { args: [Record<string, any>] }).args[0];
    expect(props.last_error).toBe('tomorrow.io could not fetch weather for "Atlantis" - set place to a town name or zip code it recognizes');
    expect(props.config_state).toMatchObject({
      status: "error",
      code: "E_BAD_PLACE",
      place: "Atlantis",
      timezone: "America/Los_Angeles"
    });
  });
});

describe("normalizeTomorrowLocation", () => {
  it("uses the owner-configured location text verbatim apart from surrounding whitespace", () => {
    expect(normalizeTomorrowLocation(" Mountain View, CA ")).toBe("Mountain View, CA");
    expect(normalizeTomorrowLocation("94043")).toBe("94043");
  });
});

describe("weather observation time formatting", () => {
  it("formats observed time in the configured location timezone", () => {
    const observedAt = Date.parse("2026-05-05T18:00:00Z");
    expect(normalizeTimezone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(formatObservedAt(observedAt, "America/Los_Angeles")).toBe("May 5, 2026, 11:00 AM PDT");
    expect(formatObservedAt(observedAt, null)).toBe("2026-05-05 18:00 UTC");
    expect(normalizeTimezone("Pacific")).toBeNull();
    expect(normalizeTimezone("not/a-zone")).toBeNull();
  });
});
