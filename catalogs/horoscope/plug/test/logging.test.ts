import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLoggedHoroscopeTick, type HoroscopePlugEnv } from "../src/index";
import type { HoroscopeAi } from "../src/horoscope";

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

function makeEnv(ai: HoroscopeAi, overrides: Partial<HoroscopePlugEnv> = {}): HoroscopePlugEnv {
  return {
    WOO_BASE_URL: "https://woo.example",
    WOO_APIKEY: "apikey:abc:def",
    BLOCK_ID: "the_horoscope_block",
    AI: ai,
    MAX_TOKENS: "200",
    MAX_ORDERS_PER_TICK: "5",
    ...overrides
  };
}

const authReply = (): Reply => ({
  status: 200,
  body: { actor: "the_horoscope_block", session: "sess_h", expires_at: null, token_class: "apikey" }
});

const callReply = (result: unknown): Reply => ({
  status: 200,
  body: { result, observations: [] }
});

const propertyReply = (value: unknown): Reply => ({
  status: 200,
  body: { value }
});

describe("runLoggedHoroscopeTick", () => {
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

  it("emits tick_start, order_delivered per order, then tick_ok with delivered count", async () => {
    const ai: HoroscopeAi = { run: vi.fn().mockResolvedValue({ response: "destiny calls." }) };
    const env = makeEnv(ai);

    const { fetchImpl } = makeFetch([
      authReply,
      () => propertyReply("You are a mystical oracle."),
      () => callReply({ order_id: "ord_1", requester: "guest_5", request: "scorpio", ts: 1 }),
      () => callReply({ ok: true, note: "note_1" }),
      () => callReply({ order_id: "ord_2", requester: "guest_6", request: "leo", ts: 2 }),
      () => callReply({ ok: true, note: "note_2" }),
      () => callReply(null),
      () => callReply({ ok: true })
    ]);

    let tick = 1000;
    const now = () => (tick += 100);

    const result = await runLoggedHoroscopeTick(env, "cron", { fetchImpl, now });
    expect(result).toEqual({ block: "the_horoscope_block", delivered: 2, errors: [], authMode: "cold" });

    const events = lines.map((l) => l.event);
    expect(events).toEqual(["tick_start", "order_delivered", "order_delivered", "tick_ok"]);

    expect(lines[0]).toMatchObject({ event: "tick_start", trigger: "cron", block: "the_horoscope_block" });
    expect(lines[1]).toMatchObject({
      event: "order_delivered",
      block: "the_horoscope_block",
      order_id: "ord_1",
      requester: "guest_5",
      text_chars: "destiny calls.".length
    });
    expect(lines[2]).toMatchObject({
      event: "order_delivered",
      order_id: "ord_2",
      requester: "guest_6"
    });
    expect(lines[3]).toMatchObject({
      event: "tick_ok",
      trigger: "cron",
      block: "the_horoscope_block",
      delivered: 2,
      errors: 0,
      duration_ms: expect.any(Number)
    });
    expect(lines[3].duration_ms).toBeGreaterThan(0);
  });

  it("emits ai_fallback then order_delivered when generateHoroscope throws", async () => {
    const ai: HoroscopeAi = { run: vi.fn().mockRejectedValue(new Error("model timeout")) };
    const env = makeEnv(ai);

    const { fetchImpl } = makeFetch([
      authReply,
      () => propertyReply("p"),
      () => callReply({ order_id: "ord_1", requester: "guest_x", request: "x", ts: 1 }),
      () => callReply({ ok: true }),
      () => callReply(null),
      () => callReply({ ok: true })
    ]);

    const result = await runLoggedHoroscopeTick(env, "cron", { fetchImpl });
    expect(result.delivered).toBe(1);
    expect(result.errors).toEqual([]);

    const events = lines.map((l) => l.event);
    expect(events).toEqual(["tick_start", "ai_fallback", "order_delivered", "tick_ok"]);
    expect(lines[1]).toMatchObject({
      event: "ai_fallback",
      order_id: "ord_1",
      requester: "guest_x",
      category: "ai",
      message: "model timeout"
    });
    expect(lines[2]).toMatchObject({
      event: "order_delivered",
      order_id: "ord_1",
      text_origin: "fallback"
    });
    expect(lines[3]).toMatchObject({ event: "tick_ok", delivered: 1, errors: 0 });
  });

  it("cancels and continues on a permanent :deliver error (E_INVARG)", async () => {
    const ai: HoroscopeAi = { run: vi.fn().mockResolvedValue({ response: "ok" }) };
    const env = makeEnv(ai);

    const { fetchImpl } = makeFetch([
      authReply,
      () => propertyReply("p"),
      () => callReply({ order_id: "ord_1", requester: "g", request: "x", ts: 1 }),
      () => ({ status: 400, body: { error: { code: "E_INVARG", message: "deliver requires a text string" } } }),
      () => callReply({ order_id: "ord_1", canceled: true }),
      () => callReply(null),
      () => callReply({ ok: true })
    ]);

    const result = await runLoggedHoroscopeTick(env, "cron", { fetchImpl });
    expect(result.errors).toHaveLength(1);

    const errLine = lines.find((l) => l.event === "order_error");
    expect(errLine).toMatchObject({
      category: "woo:E_INVARG",
      code: "E_INVARG",
      order_id: "ord_1"
    });
    const cancelLine = lines.find((l) => l.event === "order_canceled_by_plug");
    expect(cancelLine).toMatchObject({
      order_id: "ord_1",
      code: "E_INVARG",
      reason: "deliver requires a text string"
    });
  });

  it("leaves the order on the queue and stops the tick on a transient :deliver error", async () => {
    const ai: HoroscopeAi = { run: vi.fn().mockResolvedValue({ response: "ok" }) };
    const env = makeEnv(ai);

    const { fetchImpl, calls } = makeFetch([
      authReply,
      () => propertyReply("p"),
      () => callReply({ order_id: "ord_1", requester: "g", request: "x", ts: 1 }),
      () => ({ status: 504, body: { error: { code: "E_GATEWAY", message: "upstream timed out" } } }),
      () => callReply({ ok: true })
    ]);

    const result = await runLoggedHoroscopeTick(env, "cron", { fetchImpl });
    expect(result.delivered).toBe(0);
    expect(result.errors).toEqual([{ order_id: "ord_1", message: "upstream timed out" }]);
    // No :cancel was attempted — transient errors leave the order alone so a
    // momentary upstream blip doesn't silently drop a user's request.
    expect(calls.find((c) => c.url.includes("/calls/cancel"))).toBeUndefined();
    // The tick still wraps up with set_properties so last_error is recorded.
    const heartbeat = calls.find((c) => c.url.includes("/calls/set_properties"));
    expect((heartbeat?.body as { args: [Record<string, unknown>] }).args[0].last_error).toBe("upstream timed out");
    const events = lines.map((l) => l.event);
    expect(events).toContain("order_error");
    expect(events).not.toContain("order_canceled_by_plug");
  });

  it("emits tick_start then tick_ok with delivered=0 when the queue is empty", async () => {
    const ai: HoroscopeAi = { run: vi.fn() };
    const env = makeEnv(ai);

    const { fetchImpl } = makeFetch([
      authReply,
      () => propertyReply("p"),
      () => callReply(null),
      () => callReply({ ok: true })
    ]);

    const result = await runLoggedHoroscopeTick(env, "cron", { fetchImpl });
    expect(result.delivered).toBe(0);

    const events = lines.map((l) => l.event);
    expect(events).toEqual(["tick_start", "tick_ok"]);
    expect(lines[1]).toMatchObject({ event: "tick_ok", delivered: 0, errors: 0 });
  });

  it("emits tick_error with category=woo:E_NOSESSION when auth fails", async () => {
    const ai: HoroscopeAi = { run: vi.fn() };
    const env = makeEnv(ai);

    const { fetchImpl } = makeFetch([
      () => ({ status: 401, body: { error: { code: "E_NOSESSION", message: "apikey rejected" } } })
    ]);

    await expect(runLoggedHoroscopeTick(env, "cron", { fetchImpl })).rejects.toMatchObject({ code: "E_NOSESSION" });

    const events = lines.map((l) => l.event);
    expect(events).toEqual(["tick_start", "tick_error"]);
    expect(lines[1]).toMatchObject({
      event: "tick_error",
      category: "woo:E_NOSESSION",
      code: "E_NOSESSION"
    });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("includes an ISO ts on every line", async () => {
    const ai: HoroscopeAi = { run: vi.fn() };
    const env = makeEnv(ai);

    const { fetchImpl } = makeFetch([
      authReply,
      () => propertyReply("p"),
      () => callReply(null),
      () => callReply({ ok: true })
    ]);

    await runLoggedHoroscopeTick(env, "cron", { fetchImpl });
    for (const line of lines) {
      expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });
});
