import { describe, expect, it } from "vitest";
import { WooClient, WooError } from "../src/woo-client";

type Recorded = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

function makeFetch(responses: Array<{ status: number; body: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k] = h[k];
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, headers, body });
    const next = responses[i++] ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("WooClient", () => {
  it("authenticates with apikey and stores the session", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: {
          actor: "the_weather_block",
          session: "sess_abc",
          expires_at: 1234567890,
          scope: "cluster:the_weather_block"
        }
      }
    ]);
    const client = new WooClient({ baseUrl: "https://woo.example.com/", fetchImpl });
    const session = await client.authenticate("apikey:abc:def");

    expect(session).toEqual({
      actor: "the_weather_block",
      session: "sess_abc",
      expiresAt: 1234567890,
      tokenClass: "apikey"
    });
    expect(client.currentSession?.session).toBe("sess_abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://woo.example.com/net-api/session",
      method: "POST",
      headers: { Authorization: "Bearer apikey:abc:def", "Content-Type": "application/json" },
      body: {}
    });
  });

  it("getProperty issues a GET to the property route with the session header", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: { actor: "x", session: "sess_xyz", expires_at: null, token_class: "apikey" }
      },
      {
        status: 200,
        body: { cell: { value: { value: "Mountain View, CA" }, version: 7 } }
      }
    ]);
    const client = new WooClient({ baseUrl: "https://w.example", fetchImpl });
    await client.authenticate("apikey:a:b");
    const place = await client.getProperty("the_weather_block", "place");

    expect(place).toBe("Mountain View, CA");
    expect(calls[1]).toMatchObject({
      url: "https://w.example/net-api/cell?session=sess_xyz&key=property_cell%3Athe_weather_block%3Aplace",
      method: "GET",
      headers: { Authorization: "Bearer apikey:a:b" }
    });
  });

  it("directCall posts to /calls/<verb> with args and returns result", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body: { actor: "x", session: "sess_q", expires_at: null, token_class: "apikey" }
      },
      {
        status: 200,
        body: { reply: { status: "accepted" }, result: { ok: true }, observations: [] }
      }
    ]);
    const client = new WooClient({ baseUrl: "https://w", fetchImpl });
    await client.authenticate("apikey:a:b");
    const result = await client.directCall("the_weather_block", "set_properties", [
      { current: { value: 72 }, last_pushed_at: 1700000000000 }
    ]);

    expect(result).toEqual({ ok: true });
    expect(calls[1]).toMatchObject({
      url: "https://w/net-api/turn",
      method: "POST",
      headers: { Authorization: "Bearer apikey:a:b", "Content-Type": "application/json" }
    });
    expect(calls[1].body).toMatchObject({
      target: "the_weather_block",
      verb: "set_properties",
      args: [{ current: { value: 72 }, last_pushed_at: 1700000000000 }],
      session: "sess_q",
      idempotency_key: expect.stringMatching(/^plug:/)
    });
  });

  it("throws WooError with the server's code/message on a 4xx", async () => {
    const { fetchImpl } = makeFetch([
      {
        status: 200,
        body: { actor: "x", session: "sess", expires_at: null, token_class: "apikey" }
      },
      {
        status: 403,
        body: { error: { code: "E_PERM", message: "writable_self denied", value: { name: "home" } } }
      }
    ]);
    const client = new WooClient({ baseUrl: "https://w", fetchImpl });
    await client.authenticate("apikey:a:b");

    await expect(client.directCall("the_weather_block", "set_property", ["home", "elsewhere"])).rejects.toMatchObject({
      name: "WooError",
      code: "E_PERM",
      status: 403,
      message: "writable_self denied"
    });
  });

  it("refuses to call before authenticate()", async () => {
    const { fetchImpl } = makeFetch([]);
    const client = new WooClient({ baseUrl: "https://w", fetchImpl });
    await expect(client.directCall("foo", "bar")).rejects.toBeInstanceOf(WooError);
  });
});
