import { describe, expect, it, vi } from "vitest";
import { createHeartbeatCache, createSessionCache, createSystemPromptCache, horoscopeNoteName, runHoroscopeTick, type HoroscopePlugEnv } from "../src/index";
import type { HoroscopeAi } from "../src/horoscope";
import { WooClient, type WooSession } from "../src/woo-client";

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
  body: { reply: { status: "accepted" }, result, observations: [] }
});

const propertyReply = (value: unknown): Reply => ({
  status: 200,
  body: { cell: { value: { value } } }
});

describe("WooClient Net turn results", () => {
  it("raises an accepted transport's domain refusal", async () => {
    const { fetchImpl } = makeFetch([
      authReply,
      () => ({
        status: 200,
        body: {
          reply: { status: "accepted" },
          error: {
            code: "E_INVARG",
            message: "deliver requires the prepared artifact",
            detail: { order_id: "ord_1" }
          }
        }
      })
    ]);
    const client = new WooClient({ baseUrl: "https://woo.example", fetchImpl });
    await client.authenticate("apikey:abc:def");

    await expect(client.directCall("the_horoscope_block", "deliver", ["ord_1", "bad-note"]))
      .rejects.toMatchObject({
        code: "E_INVARG",
        message: "deliver requires the prepared artifact",
        value: { order_id: "ord_1" }
      });
  });
});

describe("runHoroscopeTick", () => {
  it("auths, reads system_prompt, drains the queue, calls AI per order, delivers each", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: "destiny calls." }) };
    const env = makeEnv(ai);

    const { fetchImpl, calls } = makeFetch([
      authReply,
      () => propertyReply("You are a mystical oracle."),
      () => callReply({ order_id: "ord_1", requester: "guest_5", request: "scorpio", ts: 1700000000000 }),
      () => callReply({ prepared: true, note: "note_1" }),
      () => callReply({ delivered: true, note: "note_1" }),
      () => callReply({ order_id: "ord_2", requester: "guest_6", request: "leo", ts: 1700000000001 }),
      () => callReply({ prepared: true, note: "note_2" }),
      () => callReply({ delivered: true, note: "note_2" }),
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

    expect(calls[0].url).toBe("https://woo.example/net-api/session");
    expect(calls[0].body).toEqual({ roster_visible: false });
    expect(calls[1].url).toContain("/net-api/cell?");
    expect(calls[1].url).toContain("property_cell%3Athe_horoscope_block%3Asystem_prompt");
    expect(calls[2].url).toBe("https://woo.example/net-api/turn");
    expect(calls[2].body).toMatchObject({ target: "the_horoscope_block", verb: "next_pending", session: "sess_h" });

    const prepare1 = calls[3];
    expect(prepare1.url).toBe("https://woo.example/net-api/turn");
    expect(prepare1.body).toMatchObject({
      target: "the_horoscope_block",
      verb: "prepare_artifact",
      route: "direct"
    });
    expect((prepare1.body as { args: unknown[] }).args).toEqual([
      "ord_1",
      "Horoscope: Scorpio",
      "destiny calls.",
      expect.stringContaining("scorpio")
    ]);

    const deliver1 = calls[4];
    expect(deliver1.url).toBe("https://woo.example/net-api/turn");
    expect(deliver1.body).toMatchObject({
      target: "the_horoscope_block",
      verb: "deliver",
      route: "sequenced",
      idempotency_key: "plug:deliver:the_horoscope_block:ord_1"
    });
    expect((deliver1.body as { args: unknown[] }).args).toEqual(["ord_1", "note_1"]);

    const prepare2 = calls[6];
    expect(prepare2.body).toMatchObject({ verb: "prepare_artifact", route: "direct" });
    expect((prepare2.body as { args: unknown[] }).args).toEqual([
      "ord_2",
      "Horoscope: Leo",
      "destiny calls.",
      expect.stringContaining("leo")
    ]);
    const deliver2 = calls[7];
    expect(deliver2.body).toMatchObject({
      idempotency_key: "plug:deliver:the_horoscope_block:ord_2"
    });
    expect((deliver2.body as { args: unknown[] }).args).toEqual(["ord_2", "note_2"]);
    const heartbeat = calls[9];
    expect(heartbeat.url).toBe("https://woo.example/net-api/turn");
    expect(heartbeat.body).toMatchObject({ target: "the_horoscope_block", verb: "set_properties" });
    expect((heartbeat.body as { args: [Record<string, unknown>] }).args[0]).toMatchObject({ last_pushed_at: expect.any(Number), last_error: null });
  });

  it("respects MAX_ORDERS_PER_TICK", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: "yes." }) };
    const env = makeEnv(ai, { MAX_ORDERS_PER_TICK: "2" });

    const { fetchImpl } = makeFetch([
      authReply,
      () => propertyReply("p"),
      () => callReply({ order_id: "ord_1", requester: "g", request: "x", ts: 1 }),
      () => callReply({ prepared: true, note: "note_1" }),
      () => callReply({ delivered: true, note: "note_1" }),
      () => callReply({ order_id: "ord_2", requester: "g", request: "x", ts: 2 }),
      () => callReply({ prepared: true, note: "note_2" }),
      () => callReply({ delivered: true, note: "note_2" }),
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
      () => callReply({ prepared: true, note: "note_1" }),
      () => callReply({ delivered: true, note: "note_1" }),
      () => callReply(null),
      () => callReply({ ok: true })
    ]);

    const result = await runHoroscopeTick(env, { fetchImpl });
    expect(result).toEqual({ block: env.BLOCK_ID, delivered: 1, errors: [], authMode: "cold" });
    // The fallback prose is written only by the direct artifact-authority
    // call. The sequenced delivery carries the resulting note reference.
    const prepare = calls.find((c) => (c.body as { verb?: string } | undefined)?.verb === "prepare_artifact");
    expect(prepare).toBeDefined();
    const args = (prepare!.body as { args: unknown[] }).args;
    expect(args[0]).toBe("ord_1");
    expect(typeof args[2]).toBe("string");
    expect((args[2] as string).length).toBeGreaterThan(0);
    // Description is passed even on fallback so `look <note>` shows the
    // LambdaCore-style flavour line and the player learns to `read`.
    expect(typeof args[3]).toBe("string");
    expect((args[3] as string).length).toBeGreaterThan(0);
    const deliver = calls.find((c) => (c.body as { verb?: string } | undefined)?.verb === "deliver");
    expect((deliver!.body as { args: unknown[] }).args).toEqual(["ord_1", "note_1"]);
    // Fallback delivery is degraded service — last_error must surface that
    // so :look_self / status reports don't show a healthy block while the
    // user is silently receiving placeholder text.
    const heartbeat = calls.find((c) => (c.body as { verb?: string } | undefined)?.verb === "set_properties");
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
    expect(calls.filter((c) => c.url.includes("property_cell%3Athe_horoscope_block%3Asystem_prompt"))).toHaveLength(1);
    expect(calls.filter((c) => (c.body as { verb?: string } | undefined)?.verb === "set_properties")).toHaveLength(1);
    expect(calls.filter((c) => (c.body as { verb?: string } | undefined)?.verb === "next_pending")).toHaveLength(2);
  });

  it("works when system_prompt is unset (uses the default)", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: "x" }) };
    const env = makeEnv(ai);

    const { fetchImpl } = makeFetch([
      authReply,
      () => propertyReply(null),
      () => callReply({ order_id: "ord_1", requester: "g", request: "scorpio", ts: 1 }),
      () => callReply({ prepared: true, note: "note_1" }),
      () => callReply({ delivered: true, note: "note_1" }),
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

  it("warm cache hits skip /net-api/session and reuse the cached session", async () => {
    const ai = { run: vi.fn().mockResolvedValue({ response: "ok" }) };
    const env = makeEnv(ai);
    const sessionCache = createSessionCache();
    sessionCache.set(farFuture());

    // No authReply: a warm hit must not POST to /net-api/session.
    const { fetchImpl, calls } = makeFetch([
      () => propertyReply("p"),
      () => callReply({ order_id: "ord_1", requester: "g", request: "x", ts: 1 }),
      () => callReply({ prepared: true, note: "note_1" }),
      () => callReply({ delivered: true, note: "note_1" }),
      () => callReply(null),
      () => callReply({ ok: true })
    ]);

    const result = await runHoroscopeTick(env, { fetchImpl, sessionCache, now: () => T_NOW });
    // authMode === "warm" + delivered:1 (which requires an authenticated
    // call into :next_pending and :deliver) + the absence of a session mint in
    // the request log is the three-way proof that the cached session was
    // actually used. WooClient throws E_NOSESSION before issuing any
    // request when no session is set, so completing the tick proves the
    // adopted session reached the wire.
    expect(result.authMode).toBe("warm");
    expect(result.delivered).toBe(1);
    expect(calls.find((c) => c.url === "https://woo.example/net-api/session")).toBeUndefined();
    expect(calls[0].url).toContain("/net-api/cell?");
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
    expect(calls[0].url).toBe("https://woo.example/net-api/session");
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
    expect(calls[0].url).toBe("https://woo.example/net-api/session");
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

  it("invalidates the cache when a net property-cell read returns E_NOSESSION", async () => {
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
      () => callReply({ prepared: true, note: "note_1" }),
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
