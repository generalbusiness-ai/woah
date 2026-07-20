import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertNetDevCatalogEpoch, NET_DEV_PROXY_ROUTES, parseNetDevApiKey } from "../../src/server/net-dev";
import { netDevCredentialGraft } from "../../src/server/net-dev";
import { planNetInstall } from "../../src/net/install";

describe("Net-default local development composition", () => {
  it("makes Net the only local development composition", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.dev).toBe("tsx src/server/net-dev.ts");
    expect(pkg.scripts["mcp:stdio"]).toBe("tsx src/mcp/net-stdio.ts");
    expect(pkg.scripts["e2e:net-dev"]).toBe("playwright test --config playwright.net-dev-e2e.config.ts");
    // v2 rollback is renounced: the classic dev/stdio commands are removed, not
    // retained.
    expect(pkg.scripts["dev:classic"]).toBeUndefined();
    expect(pkg.scripts["mcp:stdio:classic"]).toBeUndefined();
  });

  it("removes the classic transport test lanes; the gate is Net-only", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    // The classic quarantine lanes are gone with the classic stack.
    expect(pkg.scripts["test:classic"]).toBeUndefined();
    expect(pkg.scripts["test:worker:classic"]).toBeUndefined();
    expect(pkg.scripts["test:worker:all"]).toBeUndefined();
    // The fast gate keeps the Net MCP coverage and holds no classic transport test.
    expect(pkg.scripts.test).toContain("tests/worker/net-mcp.test.ts");
    expect(pkg.scripts.test).not.toMatch(/v2-browser|shadow-|tests\/mcp\.test|session-lifecycle|tests\/executor\.test/);
    expect(pkg.scripts["test:worker"]).toContain("tests/worker/net-*.test.ts");
    expect(pkg.scripts["test:worker"]).not.toMatch(/cf-repository|v2-mcp-e2e|rpc-fault-inject|metric-errors|net-cutover-freeze/);
  });

  it("uses the Net-only Worker entry and no classic Durable Object binding", () => {
    const config = readFileSync("wrangler.net-dev.toml", "utf8");
    expect(config).toContain('main = "src/worker/net-only-index.ts"');
    expect(config).toContain('class_name = "NetGatewayDO"');
    expect(config).toContain('class_name = "NetScopeDO"');
    expect(config).not.toMatch(/PersistentObjectDO|CommitScopeDO|DirectoryDO/);
  });

  it("proxies every browser-facing Net route, including WebSocket upgrades", () => {
    expect(NET_DEV_PROXY_ROUTES).toEqual([
      "/client-config",
      "/healthz",
      "/mcp",
      "/net-api",
      "/net-install"
    ]);
  });

  it("accepts only the complete apikey form used by the Net identity surface", () => {
    expect(parseNetDevApiKey("apikey:local-dev:secret")).toEqual({
      token: "apikey:local-dev:secret",
      id: "local-dev",
      secret: "secret"
    });
    expect(() => parseNetDevApiKey("guest:old-local-token")).toThrow(/apikey:<id>:<secret>/);
  });

  it("requires an explicit reset or migration when persisted catalogs are stale", () => {
    expect(() => assertNetDevCatalogEpoch("cat-old", "cat-current")).toThrow(
      /persisted Net dev world.*cat-old.*expects cat-current.*--reset/
    );
    expect(() => assertNetDevCatalogEpoch(undefined, "cat-current")).toThrow(/epoch missing/);
    expect(() => assertNetDevCatalogEpoch("cat-current", "cat-current")).not.toThrow();
  });

  it("carries the dev credential on a real actor cluster, never on catalog-scoped $wiz", async () => {
    const credential = parseNetDevApiKey("apikey:local-dev:secret");
    const plan = await planNetInstall({ catalogs: ["chat"], graft: netDevCredentialGraft(credential) });
    const session = plan.world.auth(credential.token);
    expect(session.actor).toMatch(/^guest_/);
    expect(plan.partitions.has(`cluster:${session.actor}`)).toBe(true);
    expect(plan.partitions.has("cluster:$wiz")).toBe(false);
  });
});
