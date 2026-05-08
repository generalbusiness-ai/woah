import { describe, expect, it, vi } from "vitest";
import { horoscopeNoteName, runHoroscopeTick, type HoroscopePlugEnv } from "../src/index";
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

describe("runHoroscopeTick", () => {
  it("auths, reads system_prompt, drains the queue, calls AI per order, delivers each", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: "destiny calls." }) };
    const env = makeEnv(ai);

    const { fetchImpl, calls } = makeFetch([
      authReply,
      () => propertyReply("You are a mystical oracle."),
      () => callReply({ order_id: "ord_1", requester: "guest_5", request: "scorpio", ts: 1700000000000 }),
      () => callReply({ ok: true, note: "note_1" }),
      () => callReply({ order_id: "ord_2", requester: "guest_6", request: "leo", ts: 1700000000001 }),
      () => callReply({ ok: true, note: "note_2" }),
      () => callReply(null),
      () => callReply({ ok: true })
    ]);

    const result = await runHoroscopeTick(env, { fetchImpl });
    expect(result).toEqual({ block: env.BLOCK_ID, delivered: 2, errors: [] });

    expect(ai.run).toHaveBeenCalledTimes(2);
    const aiCall0 = ai.run.mock.calls[0][1] as { messages: Array<{ role: string; content: string }>; max_tokens: number };
    expect(aiCall0.messages[0]).toEqual({ role: "system", content: "You are a mystical oracle." });
    expect(aiCall0.messages[1]).toEqual({ role: "user", content: "scorpio" });
    expect(aiCall0.max_tokens).toBe(200);

    expect(calls[0].url).toBe("https://woo.example/api/auth");
    expect(calls[1].url).toBe("https://woo.example/api/objects/the_horoscope_block/properties/system_prompt");
    expect(calls[2].url).toBe("https://woo.example/api/objects/the_horoscope_block/calls/next_pending");

    const deliver1 = calls[3];
    expect(deliver1.url).toBe("https://woo.example/api/objects/the_horoscope_block/calls/deliver");
    expect((deliver1.body as { args: unknown[] }).args).toEqual(["ord_1", "Horoscope: Scorpio", "destiny calls."]);

    const deliver2 = calls[5];
    expect((deliver2.body as { args: unknown[] }).args).toEqual(["ord_2", "Horoscope: Leo", "destiny calls."]);
    const heartbeat = calls[7];
    expect(heartbeat.url).toBe("https://woo.example/api/objects/the_horoscope_block/calls/set_properties");
    expect((heartbeat.body as { args: [Record<string, unknown>] }).args[0]).toMatchObject({ last_pushed_at: expect.any(Number), last_error: null });
  });

  it("respects MAX_ORDERS_PER_TICK", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: "yes." }) };
    const env = makeEnv(ai, { MAX_ORDERS_PER_TICK: "2" });

    const { fetchImpl } = makeFetch([
      authReply,
      () => propertyReply("p"),
      () => callReply({ order_id: "ord_1", requester: "g", request: "x", ts: 1 }),
      () => callReply({ ok: true }),
      () => callReply({ order_id: "ord_2", requester: "g", request: "x", ts: 2 }),
      () => callReply({ ok: true }),
      () => callReply({ ok: true })
    ]);

    const result = await runHoroscopeTick(env, { fetchImpl });
    expect(result.delivered).toBe(2);
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("leaves the order on the queue and reports the error when AI fails", async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error("model timeout")) };
    const env = makeEnv(ai);

    const { fetchImpl, calls } = makeFetch([
      authReply,
      () => propertyReply("p"),
      () => callReply({ order_id: "ord_1", requester: "g", request: "x", ts: 1 }),
      () => callReply({ ok: true })
    ]);

    const result = await runHoroscopeTick(env, { fetchImpl });
    expect(result).toEqual({
      block: env.BLOCK_ID,
      delivered: 0,
      errors: [{ order_id: "ord_1", message: "model timeout" }]
    });
    // Plug never called :deliver.
    expect(calls.find((c) => c.url.includes("/calls/deliver"))).toBeUndefined();
    const heartbeat = calls.find((c) => c.url.includes("/calls/set_properties"));
    expect((heartbeat?.body as { args: [Record<string, unknown>] }).args[0].last_error).toBe("model timeout");
  });

  it("does nothing if the queue is empty", async () => {
    const ai = { run: vi.fn() };
    const env = makeEnv(ai);

    const { fetchImpl } = makeFetch([
      authReply,
      () => propertyReply("p"),
      () => callReply(null),
      () => callReply({ ok: true })
    ]);

    const result = await runHoroscopeTick(env, { fetchImpl });
    expect(result).toEqual({ block: env.BLOCK_ID, delivered: 0, errors: [] });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("works when system_prompt is unset (uses the default)", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: "x" }) };
    const env = makeEnv(ai);

    const { fetchImpl } = makeFetch([
      authReply,
      () => propertyReply(null),
      () => callReply({ order_id: "ord_1", requester: "g", request: "scorpio", ts: 1 }),
      () => callReply({ ok: true }),
      () => callReply(null),
      () => callReply({ ok: true })
    ]);

    const result = await runHoroscopeTick(env, { fetchImpl });
    expect(result.delivered).toBe(1);
    const aiCall = ai.run.mock.calls[0][1] as { messages: Array<{ role: string; content: string }> };
    expect(aiCall.messages[0].content).toMatch(/horoscope/i);
  });
});

describe("horoscopeNoteName", () => {
  it("title-cases a single-word zodiac sign", () => {
    expect(horoscopeNoteName("scorpio")).toBe("Horoscope: Scorpio");
    expect(horoscopeNoteName("LEO")).toBe("Horoscope: Leo");
  });

  it("falls back to a generic label when the request is empty", () => {
    expect(horoscopeNoteName("")).toBe("Horoscope reading");
    expect(horoscopeNoteName("   ")).toBe("Horoscope reading");
  });

  it("clips long requests to a sensible label", () => {
    const long = "scorpio rising with cancer moon and aquarius midheaven aspecting jupiter";
    expect(horoscopeNoteName(long).length).toBeLessThanOrEqual("Horoscope: ".length + 40);
    expect(horoscopeNoteName(long).startsWith("Horoscope: ")).toBe(true);
  });
});
