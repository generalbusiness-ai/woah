import { describe, expect, it } from "vitest";
import { runWeatherTick, type WeatherPlugEnv } from "../src/index";

type Call = { url: string; method: string; body?: unknown };
type Reply = { status: number; body: unknown; headers?: Record<string, string> };

function makeFetch(handlers: Array<(call: Call) => Reply>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
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
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const env: WeatherPlugEnv = {
  WOO_BASE_URL: "https://woo.example",
  WOO_APIKEY: "apikey:abc:def",
  TOMORROW_IO_API_KEY: "tomorrow-secret",
  BLOCK_ID: "the_weather_block",
  FORECAST_HOURS: "3"
};

describe("runWeatherTick", () => {
  it("auths, reads place/units/forecast_hours, fetches tomorrow.io, pushes set_properties", async () => {
    const { fetchImpl, calls } = makeFetch([
      // 1: auth
      () => ({
        status: 200,
        body: { actor: "the_weather_block", session: "sess_w", expires_at: null, token_class: "apikey" }
      }),
      // 2: get place
      () => ({ status: 200, body: { value: "Mountain View, CA" } }),
      // 3: get units
      () => ({ status: 200, body: { value: "imperial" } }),
      // 4: get forecast_hours
      () => ({ status: 200, body: { value: 3 } }),
      // 5: realtime
      () => ({
        status: 200,
        body: {
          data: {
            time: "2026-05-05T18:00:00Z",
            values: { temperature: 72.4 }
          }
        }
      }),
      // 6: forecast (3 hours)
      () => ({
        status: 200,
        body: {
          timelines: {
            hourly: [
              { time: "2026-05-05T19:00:00Z", values: { temperature: 73, precipitationProbability: 5, weatherCode: 1000 } },
              { time: "2026-05-05T20:00:00Z", values: { temperature: 71, precipitationProbability: 10, weatherCode: 1100 } },
              { time: "2026-05-05T21:00:00Z", values: { temperature: 68, precipitationProbability: 0, weatherCode: 1000 } }
            ]
          }
        }
      }),
      // 7: set_properties on the block
      () => ({ status: 200, body: { result: { ok: true }, observations: [] } })
    ]);

    const result = await runWeatherTick(env, { fetchImpl });
    expect(result).toMatchObject({
      block: "the_weather_block",
      place: "Mountain View, CA"
    });

    expect(calls[0].url).toBe("https://woo.example/api/auth");
    expect(calls[1].url).toBe("https://woo.example/api/objects/the_weather_block/properties/place");
    expect(calls[2].url).toBe("https://woo.example/api/objects/the_weather_block/properties/units");
    expect(calls[3].url).toBe("https://woo.example/api/objects/the_weather_block/properties/forecast_hours");
    expect(calls[4].url).toContain("api.tomorrow.io/v4/weather/realtime");
    expect(calls[4].url).toContain("units=imperial");
    expect(calls[5].url).toContain("api.tomorrow.io/v4/weather/forecast");
    expect(calls[5].url).toContain("units=imperial");

    const setProps = calls[6];
    expect(setProps.url).toBe("https://woo.example/api/objects/the_weather_block/calls/set_properties");
    expect(setProps.method).toBe("POST");
    const body = setProps.body as { args: [Record<string, unknown>] };
    const props = body.args[0];
    expect(props.last_error).toBeNull();
    expect(props.last_pushed_at).toEqual(expect.any(Number));
    expect(props.current).toMatchObject({ kind: "scalar", value: 72.4, unit: "°F" });
    expect(props.forecast).toMatchObject({
      kind: "series",
      series: [{ name: "temperature", unit: "°F", points: expect.any(Array) }]
    });
    const series = (props.forecast as any).series[0];
    expect(series.points).toHaveLength(3);
    expect(series.points[0]).toEqual(["2026-05-05T19:00:00Z", 73]);
  });

  it("honors block-set units=metric (default) and emits °C", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => ({ status: 200, body: { actor: "the_weather_block", session: "sess_w", expires_at: null, token_class: "apikey" } }),
      () => ({ status: 200, body: { value: "Berlin" } }),
      () => ({ status: 200, body: { value: "metric" } }),
      () => ({ status: 200, body: { value: 1 } }),
      () => ({ status: 200, body: { data: { time: "2026-05-05T18:00:00Z", values: { temperature: 22.4 } } } }),
      () => ({ status: 200, body: { timelines: { hourly: [{ time: "2026-05-05T19:00:00Z", values: { temperature: 23, precipitationProbability: 0, weatherCode: 1000 } }] } } }),
      () => ({ status: 200, body: { result: {}, observations: [] } })
    ]);
    await runWeatherTick(env, { fetchImpl });
    expect(calls[4].url).toContain("units=metric");
    const props = (calls[6].body as { args: [Record<string, any>] }).args[0];
    expect(props.current).toMatchObject({ kind: "scalar", unit: "°C" });
    expect(props.forecast.series[0]).toMatchObject({ unit: "°C" });
  });

  it("writes last_error to the block when place is missing", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => ({
        status: 200,
        body: { actor: "the_weather_block", session: "sess_w", expires_at: null, token_class: "apikey" }
      }),
      () => ({ status: 200, body: { value: "" } }),
      () => ({ status: 200, body: { result: null, observations: [] } })
    ]);

    await expect(runWeatherTick(env, { fetchImpl })).rejects.toMatchObject({ code: "E_NO_PLACE" });
    expect(calls[2].url).toBe("https://woo.example/api/objects/the_weather_block/calls/set_property");
    expect((calls[2].body as { args: unknown[] }).args[0]).toBe("last_error");
  });

  it("writes a clean auth-rejected last_error when tomorrow.io returns 401", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => ({
        status: 200,
        body: { actor: "the_weather_block", session: "sess_w", expires_at: null, token_class: "apikey" }
      }),
      () => ({ status: 200, body: { value: "Mountain View, CA" } }),
      () => ({ status: 200, body: { value: "imperial" } }),
      () => ({ status: 200, body: { value: 3 } }),
      () => ({ status: 401, body: { error: "invalid api key" } }),
      () => ({ status: 200, body: { result: null, observations: [] } })
    ]);

    await expect(runWeatherTick(env, { fetchImpl })).rejects.toThrow();
    const errCall = calls[5];
    expect(errCall.url).toBe("https://woo.example/api/objects/the_weather_block/calls/set_property");
    const args = (errCall.body as { args: unknown[] }).args;
    expect(args[0]).toBe("last_error");
    expect(args[1]).toMatch(/rejected the API key/i);
    expect(args[1]).toMatch(/TOMORROW_IO_API_KEY/);
  });

  it("writes a clean rate-limit last_error when tomorrow.io returns 429", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => ({
        status: 200,
        body: { actor: "the_weather_block", session: "sess_w", expires_at: null, token_class: "apikey" }
      }),
      () => ({ status: 200, body: { value: "Mountain View, CA" } }),
      () => ({ status: 200, body: { value: "imperial" } }),
      () => ({ status: 200, body: { value: 3 } }),
      ({ url }) => {
        if (url.includes("api.tomorrow.io")) {
          return {
            status: 429,
            body: { code: 429001, message: "rate limit exceeded" },
            headers: { "Retry-After": "120" }
          };
        }
        return { status: 200, body: {} };
      },
      () => ({ status: 200, body: { result: null, observations: [] } })
    ]);

    await expect(runWeatherTick(env, { fetchImpl })).rejects.toThrow();
    const errCall = calls[5];
    expect(errCall.url).toBe("https://woo.example/api/objects/the_weather_block/calls/set_property");
    const args = (errCall.body as { args: unknown[] }).args;
    expect(args[0]).toBe("last_error");
    expect(args[1]).toMatch(/rate-limited/i);
    expect(args[1]).toMatch(/retry after 120s/);
    expect(args[1]).toMatch(/25\/hour/);
  });
});
