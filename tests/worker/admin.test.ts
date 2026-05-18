import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAdmin } from "../../src/worker/admin";
import type { Env } from "../../src/worker/persistent-object-do";

// Tiny stub Env. Tests only set what each case needs.
function envOf(overrides: Partial<Env>): Env {
  return {
    WOO: {} as unknown as DurableObjectNamespace,
    DIRECTORY: {} as unknown as DurableObjectNamespace,
    ...overrides
  } as Env;
}

function basicAuthHeader(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

async function call(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(`https://woah.example${path}`);
  const request = new Request(url.toString(), init);
  return handleAdmin(request, env, url);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin auth gate", () => {
  it("returns 503 when ADMIN_PASSWORD is unset — the panel fails closed", async () => {
    const res = await call(envOf({}), "/admin/");
    expect(res.status).toBe(503);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("E_ADMIN_DISABLED");
  });

  it("returns 401 with WWW-Authenticate when there's no credential", async () => {
    const res = await call(envOf({ ADMIN_PASSWORD: "hunter2" }), "/admin/");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")?.toLowerCase()).toContain("basic");
  });

  it("returns 401 when the password is wrong", async () => {
    const res = await call(envOf({ ADMIN_PASSWORD: "hunter2" }), "/admin/", {
      headers: { authorization: basicAuthHeader("admin", "nope") }
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the username is wrong, even with the right password", async () => {
    const res = await call(envOf({ ADMIN_PASSWORD: "hunter2" }), "/admin/", {
      headers: { authorization: basicAuthHeader("operator", "hunter2") }
    });
    expect(res.status).toBe(401);
  });

  it("serves the HTML page when auth is correct", async () => {
    const res = await call(envOf({ ADMIN_PASSWORD: "hunter2" }), "/admin/", {
      headers: { authorization: basicAuthHeader("admin", "hunter2") }
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("<title>woah admin</title>");
  });

  it("returns 404 for an unknown /admin/ subpath", async () => {
    const res = await call(envOf({ ADMIN_PASSWORD: "hunter2" }), "/admin/unknown", {
      headers: { authorization: basicAuthHeader("admin", "hunter2") }
    });
    expect(res.status).toBe(404);
  });
});

describe("/admin/series", () => {
  const authHeaders = { authorization: basicAuthHeader("admin", "hunter2") };
  const baseEnv = (extras: Partial<Env> = {}): Env =>
    envOf({ ADMIN_PASSWORD: "hunter2", CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: "acct", ...extras });

  it("returns 503 when CF_ANALYTICS_TOKEN or CF_ACCOUNT_ID is unset", async () => {
    const res = await call(envOf({ ADMIN_PASSWORD: "hunter2" }), "/admin/series", { headers: authHeaders });
    expect(res.status).toBe(503);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("E_AE_NOT_CONFIGURED");
  });

  it("rejects unknown bucket", async () => {
    const res = await call(baseEnv(), "/admin/series?bucket=99m", { headers: authHeaders });
    expect(res.status).toBe(400);
  });

  it("rejects unknown groupBy", async () => {
    const res = await call(baseEnv(), "/admin/series?groupBy=nonsense", { headers: authHeaders });
    expect(res.status).toBe(400);
  });

  it("rejects unknown metric", async () => {
    const res = await call(baseEnv(), "/admin/series?metric=mean", { headers: authHeaders });
    expect(res.status).toBe(400);
  });

  it("rejects from >= to", async () => {
    const res = await call(baseEnv(), "/admin/series?from=200&to=100", { headers: authHeaders });
    expect(res.status).toBe(400);
  });

  it("rejects windows wider than 14 days", async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await call(baseEnv(), `/admin/series?from=${now - 31 * 24 * 3600}&to=${now}`, { headers: authHeaders });
    expect(res.status).toBe(400);
  });

  it("happy path: proxies AE SQL and groups by key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: [
        { t: 1000, k: "the_chatroom", v: 50 },
        { t: 1060, k: "the_chatroom", v: 30 },
        { t: 1000, k: "world", v: 5 }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const res = await call(baseEnv(), "/admin/series?groupBy=host_key&metric=count&bucket=1m", { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json() as { metric: string; groupBy: string; series: Array<{ key: string; points: Array<[number, number]> }> };
    expect(body.metric).toBe("count");
    expect(body.groupBy).toBe("host_key");
    expect(body.series).toHaveLength(2);
    // Series are sorted by total descending.
    expect(body.series[0]!.key).toBe("the_chatroom");
    expect(body.series[0]!.points).toEqual([[1000, 50], [1060, 30]]);
    expect(body.series[1]!.key).toBe("world");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [aeUrl, init] = fetchSpy.mock.calls[0]!;
    expect(String(aeUrl)).toBe("https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql");
    expect(init?.method).toBe("POST");
    const sql = String(init?.body);
    expect(sql).toContain("FROM woo_v1_prod");
    // host_key uses the AE index column (index1), not a blob.
    expect(sql).toContain("index1 AS k");
    // count metric multiplies both sample-interval factors so totals
    // reconstruct from sampled points.
    expect(sql).toContain("SUM(_sample_interval * double2)");
    // 1m bucket = 60s.
    expect(sql).toContain("intDiv(toUInt32(timestamp), 60) * 60 AS t");
  });

  it("escapes single-quotes in filter values to defend the SQL string boundary", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } }));

    const url = `/admin/series?groupBy=host_key&filter.scope=${encodeURIComponent("the' OR 1=1 --")}`;
    const res = await call(baseEnv(), url, { headers: authHeaders });
    expect(res.status).toBe(200);

    const sql = String(fetchSpy.mock.calls[0]![1]?.body);
    expect(sql).toContain("blob2 = 'the\\' OR 1=1 --'");
    // No unescaped single quote that closes the literal early.
    expect(sql).not.toMatch(/blob2 = 'the' OR/);
  });

  it("uses the dataset from WOO_AE_DATASET when set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const env = baseEnv({ WOO_AE_DATASET: "woo_v1_staging" });
    await call(env, "/admin/series", { headers: authHeaders });
    const sql = String(fetchSpy.mock.calls[0]![1]?.body);
    expect(sql).toContain("FROM woo_v1_staging");
  });

  it("returns 502 when the AE SQL API errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("oops", { status: 500 }));
    const res = await call(baseEnv(), "/admin/series", { headers: authHeaders });
    expect(res.status).toBe(502);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe("E_AE_QUERY_FAILED");
  });
});
