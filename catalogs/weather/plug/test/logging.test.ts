import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLoggedWeatherTick, type WeatherPlugEnv } from "../src/index";

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

describe("runLoggedWeatherTick", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let lines: any[];

  beforeEach(() => {
    lines = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(typeof line === "string" ? JSON.parse(line) : line);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits tick_start then tick_ok for a successful run, with duration_ms and place", async () => {
    const { fetchImpl } = makeFetch([
      () => ({ status: 200, body: { actor: "the_weather_block", session: "sess", expires_at: null, token_class: "apikey" } }),
      () => ({ status: 200, body: { value: "Mountain View, CA" } }),
      () => ({ status: 200, body: { value: "imperial" } }),
      () => ({ status: 200, body: { value: "America/Los_Angeles" } }),
      () => ({ status: 200, body: { value: {} } }),     // prior timeseries (cold start)
      () => ({ status: 200, body: { value: [] } }),     // prior daily (cold start)
      () => ({ status: 200, body: { data: { time: "2026-05-05T18:00:00Z", values: { temperature: 70 } } } }),
      () => ({ status: 200, body: { timelines: { hourly: [], daily: [] } } }),
      () => ({ status: 200, body: { timelines: { hourly: [], daily: [] } } }),
      () => ({ status: 200, body: { result: { ok: true }, observations: [] } })
    ]);

    let tick = 1000;
    const now = () => (tick += 250);

    const result = await runLoggedWeatherTick(env, "cron", { fetchImpl, now });
    expect(result.place).toBe("Mountain View, CA");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: "tick_start", trigger: "cron", block: "the_weather_block" });
    expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lines[1]).toMatchObject({
      event: "tick_ok",
      trigger: "cron",
      block: "the_weather_block",
      place: "Mountain View, CA",
      duration_ms: expect.any(Number)
    });
    expect(lines[1].duration_ms).toBeGreaterThan(0);
  });

  it("emits tick_error with category=woo:E_NOSESSION when woo auth fails", async () => {
    const { fetchImpl } = makeFetch([
      () => ({ status: 401, body: { error: { code: "E_NOSESSION", message: "apikey rejected" } } })
    ]);

    await expect(runLoggedWeatherTick(env, "cron", { fetchImpl })).rejects.toMatchObject({ code: "E_NOSESSION" });

    const errLine = lines.find((l) => l.event === "tick_error");
    expect(errLine).toMatchObject({
      event: "tick_error",
      trigger: "cron",
      block: "the_weather_block",
      category: "woo:E_NOSESSION",
      code: "E_NOSESSION"
    });
  });

  it("emits tick_error with category=weather_config:E_NO_PLACE when the owner hasn't set place", async () => {
    const { fetchImpl } = makeFetch([
      () => ({ status: 200, body: { actor: "the_weather_block", session: "sess", expires_at: null, token_class: "apikey" } }),
      () => ({ status: 200, body: { value: "" } }),
      () => ({ status: 200, body: { result: null, observations: [] } })
    ]);

    await expect(runLoggedWeatherTick(env, "fetch", { fetchImpl })).rejects.toMatchObject({ code: "E_NO_PLACE" });
    const errLine = lines.find((l) => l.event === "tick_error");
    expect(errLine).toMatchObject({
      category: "weather_config:E_NO_PLACE",
      code: "E_NO_PLACE",
      trigger: "fetch"
    });
  });

  it("emits tick_error with category=tomorrow:rate_limit on 429", async () => {
    const { fetchImpl } = makeFetch([
      () => ({ status: 200, body: { actor: "the_weather_block", session: "sess", expires_at: null, token_class: "apikey" } }),
      () => ({ status: 200, body: { value: "Mountain View, CA" } }),
      () => ({ status: 200, body: { value: "imperial" } }),
      () => ({ status: 200, body: { value: "America/Los_Angeles" } }),
      () => ({ status: 200, body: { value: {} } }),
      () => ({ status: 200, body: { value: [] } }),
      ({ url }) => url.includes("api.tomorrow.io")
        ? { status: 429, body: { code: 429001, message: "rate limit" }, headers: { "Retry-After": "60" } }
        : { status: 200, body: {} },
      ({ url }) => url.includes("api.tomorrow.io")
        ? { status: 429, body: { code: 429001, message: "rate limit" }, headers: { "Retry-After": "60" } }
        : { status: 200, body: {} },
      ({ url }) => url.includes("api.tomorrow.io")
        ? { status: 429, body: { code: 429001, message: "rate limit" }, headers: { "Retry-After": "60" } }
        : { status: 200, body: {} },
      () => ({ status: 200, body: { result: null, observations: [] } })
    ]);

    await expect(runLoggedWeatherTick(env, "cron", { fetchImpl })).rejects.toThrow();
    const errLine = lines.find((l) => l.event === "tick_error");
    expect(errLine).toMatchObject({
      category: "tomorrow:rate_limit",
      status: 429
    });
  });

  it("emits tick_error with category=tomorrow:auth on 401 from tomorrow.io", async () => {
    const { fetchImpl } = makeFetch([
      () => ({ status: 200, body: { actor: "the_weather_block", session: "sess", expires_at: null, token_class: "apikey" } }),
      () => ({ status: 200, body: { value: "Mountain View, CA" } }),
      () => ({ status: 200, body: { value: "imperial" } }),
      () => ({ status: 200, body: { value: "America/Los_Angeles" } }),
      () => ({ status: 200, body: { value: {} } }),
      () => ({ status: 200, body: { value: [] } }),
      ({ url }) => url.includes("api.tomorrow.io")
        ? { status: 401, body: { error: "bad key" } }
        : { status: 200, body: {} },
      ({ url }) => url.includes("api.tomorrow.io")
        ? { status: 401, body: { error: "bad key" } }
        : { status: 200, body: {} },
      ({ url }) => url.includes("api.tomorrow.io")
        ? { status: 401, body: { error: "bad key" } }
        : { status: 200, body: {} },
      () => ({ status: 200, body: { result: null, observations: [] } })
    ]);

    await expect(runLoggedWeatherTick(env, "cron", { fetchImpl })).rejects.toThrow();
    const errLine = lines.find((l) => l.event === "tick_error");
    expect(errLine).toMatchObject({
      category: "tomorrow:auth",
      status: 401
    });
  });
});
