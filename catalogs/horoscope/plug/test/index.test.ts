import { describe, expect, it, vi } from "vitest";
import { createHeartbeatCache, createSessionCache, createSystemPromptCache, horoscopeNoteName, runHoroscopeTick, type HoroscopePlugEnv } from "../src/index";
import type { HoroscopeAi } from "../src/horoscope";
import type { WooSession } from "../src/woo-client";

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
    expect(result).toEqual({ block: env.BLOCK_ID, delivered: 2, errors: [], authMode: "cold" });

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
    expect((deliver1.body as { args: unknown[] }).args).toEqual([
      "ord_1",
      "Horoscope: Scorpio",
      "destiny calls.",
      expect.stringContaining("scorpio")
    ]);

    const deliver2 = calls[5];
    expect((deliver2.body as { args: unknown[] }).args).toEqual([
      "ord_2",
      "Horoscope: Leo",
      "destiny calls.",
      expect.stringContaining("leo")
    ]);
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

  it("delivers a fallback note when the AI fails so the queue still drains", async () => {
    const ai = { run: vi.fn().mockRejectedValue(new Error("model timeout")) };
    const env = makeEnv(ai);

    const { fetchImpl, calls } = makeFetch([
      authReply,
      () => propertyReply("p"),
      () => callReply({ order_id: "ord_1", requester: "g", request: "x", ts: 1 }),
      () => callReply({ ok: true }),
      () => callReply(null),
      () => callReply({ ok: true })
    ]);

    const result = await runHoroscopeTick(env, { fetchImpl });
    expect(result).toEqual({ block: env.BLOCK_ID, delivered: 1, errors: [], authMode: "cold" });
    // The plug now calls :deliver with a non-empty placeholder string instead
    // of leaving the order at the queue head where it would block every
    // following request.
    const deliver = calls.find((c) => c.url.includes("/calls/deliver"));
    expect(deliver).toBeDefined();
    const args = (deliver!.body as { args: unknown[] }).args;
    expect(args[0]).toBe("ord_1");
    expect(typeof args[2]).toBe("string");
    expect((args[2] as string).length).toBeGreaterThan(0);
    // Description is passed even on fallback so `look <note>` shows the
    // LambdaCore-style flavour line and the player learns to `read`.
    expect(typeof args[3]).toBe("string");
    expect((args[3] as string).length).toBeGreaterThan(0);
    // Fallback delivery is degraded service — last_error must surface that
    // so :look_self / status reports don't show a healthy block while the
    // user is silently receiving placeholder text.
    const heartbeat = calls.find((c) => c.url.includes("/calls/set_properties"));
    const recordedError = (heartbeat?.body as { args: [Record<string, unknown>] }).args[0].last_error;
    expect(typeof recordedError).toBe("string");
    expect(recordedError as string).toContain("ai fallback");
    expect(recordedError as string).toContain("model timeout");
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
    expect(result).toEqual({ block: env.BLOCK_ID, delivered: 0, errors: [], authMode: "cold" });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("reuses cached system_prompt and skips empty heartbeat inside the throttle window", async () => {
    const ai = { run: vi.fn() };
    const env = makeEnv(ai, { HEARTBEAT_INTERVAL_MS: "300000" });
    const systemPromptCache = createSystemPromptCache();
    const heartbeatCache = createHeartbeatCache();
    let tick = 1_700_000_000_000;

    const { fetchImpl, calls } = makeFetch([
      authReply,
      () => propertyReply("cached prompt"),
      () => callReply(null),
      () => callReply({ ok: true }),
      authReply,
      () => callReply(null)
    ]);

    const first = await runHoroscopeTick(env, { fetchImpl, systemPromptCache, heartbeatCache, now: () => tick });
    tick += 60_000;
    const second = await runHoroscopeTick(env, { fetchImpl, systemPromptCache, heartbeatCache, now: () => tick });

    expect(first.delivered).toBe(0);
    expect(second.delivered).toBe(0);
    expect(calls.filter((c) => c.url.includes("/properties/system_prompt"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/calls/set_properties"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("/calls/next_pending"))).toHaveLength(2);
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

describe("runHoroscopeTick session cache", () => {
  const T_NOW = 1_700_000_000_000;
  const farFuture = (): WooSession => ({
    actor: "the_horoscope_block",
    session: "sess_warm",
    // 23h ahead — well above the 1h REAUTH_MARGIN_MS gate.
    expiresAt: T_NOW + 23 * 60 * 60 * 1000,
    tokenClass: "apikey"
  });

  it("warm cache hits skip /api/auth and reuse the cached session header", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: "ok" }) };
    const env = makeEnv(ai);
    const sessionCache = createSessionCache();
    sessionCache.set(farFuture());

    // No authReply: a warm hit must not POST to /api/auth.
    const { fetchImpl, calls } = makeFetch([
      () => propertyReply("p"),
      () => callReply({ order_id: "ord_1", requester: "g", request: "x", ts: 1 }),
      () => callReply({ ok: true }),
      () => callReply(null),
      () => callReply({ ok: true })
    ]);

    const result = await runHoroscopeTick(env, { fetchImpl, sessionCache, now: () => T_NOW });
    // authMode === "warm" + delivered:1 (which requires an authenticated
    // call into :next_pending and :deliver) + the absence of /api/auth in
    // the request log is the three-way proof that the cached session was
    // actually used. WooClient throws E_NOSESSION before issuing any
    // request when no session is set, so completing the tick proves the
    // adopted session reached the wire.
    expect(result.authMode).toBe("warm");
    expect(result.delivered).toBe(1);
    expect(calls.find((c) => c.url === "https://woo.example/api/auth")).toBeUndefined();
    expect(calls[0].url).toBe("https://woo.example/api/objects/the_horoscope_block/properties/system_prompt");
  });

  it("re-authenticates when the cached session is within REAUTH_MARGIN_MS of expiry", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: "ok" }) };
    const env = makeEnv(ai);
    const sessionCache = createSessionCache();
    sessionCache.set({
      actor: "the_horoscope_block",
      session: "sess_stale",
      // 30 min ahead — inside the 1h margin, so we must re-auth.
      expiresAt: T_NOW + 30 * 60 * 1000,
      tokenClass: "apikey"
    });

    const { fetchImpl, calls } = makeFetch([
      authReply,
      () => propertyReply("p"),
      () => callReply(null),
      () => callReply({ ok: true })
    ]);

    const result = await runHoroscopeTick(env, { fetchImpl, sessionCache, now: () => T_NOW });
    expect(result.authMode).toBe("cold");
    expect(calls[0].url).toBe("https://woo.example/api/auth");
  });

  it("re-authenticates when the cached session has unknown expiresAt", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: "ok" }) };
    const env = makeEnv(ai);
    const sessionCache = createSessionCache();
    sessionCache.set({ ...farFuture(), expiresAt: null });

    const { fetchImpl, calls } = makeFetch([
      authReply,
      () => propertyReply("p"),
      () => callReply(null),
      () => callReply({ ok: true })
    ]);

    const result = await runHoroscopeTick(env, { fetchImpl, sessionCache, now: () => T_NOW });
    expect(result.authMode).toBe("cold");
    expect(calls[0].url).toBe("https://woo.example/api/auth");
  });

  it("populates the cache after a cold auth so the next tick can warm-hit", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: "ok" }) };
    const env = makeEnv(ai);
    const sessionCache = createSessionCache();
    expect(sessionCache.get()).toBeNull();

    const futureExpiry = T_NOW + 24 * 60 * 60 * 1000;
    const { fetchImpl } = makeFetch([
      () => ({ status: 200, body: { actor: "the_horoscope_block", session: "sess_minted", expires_at: futureExpiry, token_class: "apikey" } }),
      () => propertyReply("p"),
      () => callReply(null),
      () => callReply({ ok: true })
    ]);

    const result = await runHoroscopeTick(env, { fetchImpl, sessionCache, now: () => T_NOW });
    expect(result.authMode).toBe("cold");

    const cached = sessionCache.get();
    expect(cached).toMatchObject({ session: "sess_minted", expiresAt: futureExpiry, tokenClass: "apikey" });
  });

  it("invalidates the cache when /api/objects/.../properties returns E_NOSESSION", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: "ok" }) };
    const env = makeEnv(ai);
    const sessionCache = createSessionCache();
    sessionCache.set(farFuture());

    const { fetchImpl } = makeFetch([
      () => ({ status: 401, body: { error: { code: "E_NOSESSION", message: "session expired" } } })
    ]);

    await expect(runHoroscopeTick(env, { fetchImpl, sessionCache, now: () => T_NOW })).rejects.toMatchObject({ code: "E_NOSESSION" });
    expect(sessionCache.get()).toBeNull();
  });

  it("invalidates the cache when the deliver call returns E_NOSESSION", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: "ok" }) };
    const env = makeEnv(ai);
    const sessionCache = createSessionCache();
    sessionCache.set(farFuture());

    const { fetchImpl } = makeFetch([
      () => propertyReply("p"),
      () => callReply({ order_id: "ord_1", requester: "g", request: "x", ts: 1 }),
      () => ({ status: 401, body: { error: { code: "E_NOSESSION", message: "session expired" } } }),
      () => callReply({ ok: true }) // heartbeat at the end
    ]);

    const result = await runHoroscopeTick(env, { fetchImpl, sessionCache, now: () => T_NOW });
    expect(result.delivered).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(sessionCache.get()).toBeNull();
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
