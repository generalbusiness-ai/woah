import { describe, expect, it } from "vitest";
import { netGatewayShardName, parseNetGatewayShardCount, routeNetGateway } from "../../src/worker/net/gateway-routing";
import { sessionIdWithShardHint, ticketIdWithShardHint } from "../../src/net/session-id";

function route(input: Partial<Parameters<typeof routeNetGateway>[0]> = {}): string {
  return routeNetGateway({
    pathname: "/net-api/guest",
    searchParams: new URLSearchParams(),
    headers: new Headers(),
    shardCount: 8,
    anonymousKey: "anon-a",
    ...input
  });
}

describe("net gateway edge routing", () => {
  it("keeps one-shard deployments compatible and bounds configuration", () => {
    expect(parseNetGatewayShardCount(undefined)).toBe(1);
    expect(parseNetGatewayShardCount("0")).toBe(1);
    expect(parseNetGatewayShardCount("999")).toBe(64);
    expect(netGatewayShardName(0, 1)).toBe("net-api");
  });

  it("routes every session carrier back to the minting shard", () => {
    const session = sessionIdWithShardHint("net-api-3", "abc");
    expect(route({ headers: new Headers({ authorization: `Bearer session:${session}` }) })).toBe("net-api-3");
    expect(route({ headers: new Headers({ "mcp-session-id": session }) })).toBe("net-api-3");
    expect(route({ bodyText: JSON.stringify({ session }) })).toBe("net-api-3");
    expect(route({ searchParams: new URLSearchParams({ session }) })).toBe("net-api-3");
  });

  it("routes WebSocket tickets to their durable shard", () => {
    const ticket = ticketIdWithShardHint("net-api-6", "xyz");
    expect(route({ pathname: "/net-api/ws", searchParams: new URLSearchParams({ ticket }) })).toBe("net-api-6");
  });

  it("ignores forged hints outside the configured set", () => {
    const session = sessionIdWithShardHint("net-api-63", "abc");
    expect(route({ headers: new Headers({ authorization: `Bearer session:${session}` }) })).not.toBe("net-api-63");
  });

  it("spreads anonymous requests and keeps credential routes stable", () => {
    const shards = new Set(Array.from({ length: 64 }, (_, i) => route({ anonymousKey: `anon-${i}` })));
    expect(shards.size).toBeGreaterThan(4);
    const headers = new Headers({ authorization: "Bearer apikey:key-1:secret" });
    expect(route({ pathname: "/net-api/session", headers, anonymousKey: "a" })).toBe(
      route({ pathname: "/net-api/session", headers, anonymousKey: "b" })
    );
  });
});
