// The deployment switch is the cutover routing mechanism. These tests use
// marker DO stubs to prove the public endpoint reaches the intended namespace;
// they do not duplicate either MCP implementation.
import { describe, expect, it } from "vitest";
import worker, { netDefaultEnabled } from "../../src/worker/index";

function namespace(label: string) {
  return {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: async (request: Request) => new Response(JSON.stringify({ label, id, path: new URL(request.url).pathname }))
    })
  };
}

function env(netDefault?: string, frozen?: string) {
  return {
    WOO_INTERNAL_SECRET: "cutover-routing-test-secret",
    WOO_NET_DEFAULT: netDefault,
    WOO_WRITE_FREEZE: frozen,
    WOO: namespace("v2"),
    GATEWAY_NET: namespace("net")
  } as unknown as Parameters<typeof worker.fetch>[1];
}

describe("net cutover public routing", () => {
  it("parses the Wrangler string switch explicitly", () => {
    expect(netDefaultEnabled(undefined)).toBe(false);
    expect(netDefaultEnabled("0")).toBe(false);
    expect(netDefaultEnabled("false")).toBe(false);
    expect(netDefaultEnabled("1")).toBe(true);
    expect(netDefaultEnabled("TRUE")).toBe(true);
    expect(netDefaultEnabled("on")).toBe(true);
  });

  it("uses the same switch for client-config and public MCP", async () => {
    const selected = env("1");
    const config = await worker.fetch(new Request("https://woo.test/client-config"), selected, undefined);
    expect(await config.json()).toEqual({ net: true });
    expect(config.headers.get("cache-control")).toBe("no-store");

    const mcp = await worker.fetch(new Request("https://woo.test/mcp", { method: "POST", body: "{}" }), selected, undefined);
    expect(await mcp.json()).toMatchObject({ label: "net", path: "/net-api/mcp" });
  });

  it("leaves MCP on v2 when the switch is absent or false", async () => {
    for (const value of [undefined, "0", "false"]) {
      const response = await worker.fetch(new Request("https://woo.test/mcp", { method: "POST", body: "{}" }), env(value), undefined);
      expect(await response.json()).toMatchObject({ label: "v2", path: "/mcp" });
    }
  });

  it("allows the net MCP alias through while the old world is frozen", async () => {
    const response = await worker.fetch(
      new Request("https://woo.test/mcp", { method: "POST", body: "{}" }),
      env("true", "1"),
      undefined
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ label: "net", path: "/net-api/mcp" });
  });

  it("does not resolve the classic world for the retired Net guest purge", async () => {
    let classicTouched = false;
    const selected = {
      ...env("true"),
      ADMIN_PASSWORD: "hunter2",
      WOO: {
        idFromName: () => {
          classicTouched = true;
          throw new Error("Net-default admin traffic reached the classic world");
        }
      }
    } as unknown as Parameters<typeof worker.fetch>[1];
    const authorization = `Basic ${Buffer.from("admin:hunter2").toString("base64")}`;

    const response = await worker.fetch(
      new Request("https://woo.test/admin/purge-inactive-guests", {
        method: "POST",
        headers: { authorization }
      }),
      selected,
      undefined
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      error: { code: "E_GONE", detail: { net: true, lifecycle: "automatic" } }
    });
    expect(classicTouched).toBe(false);
  });

  it("authenticates the retired Net guest purge before revealing its lifecycle", async () => {
    const response = await worker.fetch(
      new Request("https://woo.test/admin/purge-inactive-guests", { method: "POST" }),
      {
        ...env("true"),
        ADMIN_PASSWORD: "hunter2"
      } as unknown as Parameters<typeof worker.fetch>[1],
      undefined
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")?.toLowerCase()).toContain("basic");
  });
});
