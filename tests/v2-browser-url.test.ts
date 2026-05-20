import { describe, expect, it } from "vitest";
import { v2BrowserWebSocketUrl } from "../src/client/v2-browser-url";
import type { ShadowScopeHead } from "../src/core/shadow-commit-scope";
import { isShadowScopeHead, parseShadowScopeHeadJson } from "../src/core/shadow-scope-head";

describe("v2 browser websocket URL", () => {
  it("includes the cached scope head as a reconnect catch-up cursor", () => {
    const head: ShadowScopeHead = {
      kind: "woo.scope_head.shadow.v1",
      scope: "#room",
      epoch: 1,
      seq: 12,
      hash: "hash-12"
    };
    const url = new URL(v2BrowserWebSocketUrl({
      location: { protocol: "https:", host: "woah.generalbusiness.ai" },
      token: "guest:token",
      node: "browser:test",
      scope: "#room",
      last_known_head: head,
      executable_seed_digest: "seed-digest-1"
    }));

    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/v2/turn-network/ws");
    expect(url.searchParams.get("scope")).toBe("#room");
    expect(url.searchParams.get("executable_seed_digest")).toBe("seed-digest-1");
    expect(JSON.parse(url.searchParams.get("last_known_head") ?? "")).toEqual(head);
  });

  it("recognizes only well-shaped shadow scope heads", () => {
    expect(isShadowScopeHead({
      kind: "woo.scope_head.shadow.v1",
      scope: "#room",
      epoch: 1,
      seq: 0,
      hash: "root"
    })).toBe(true);
    expect(isShadowScopeHead({ kind: "woo.scope_head.shadow.v1", scope: "#room", seq: 0, hash: "root" })).toBe(false);
    expect(isShadowScopeHead({ kind: "woo.scope_head.shadow.v1", scope: "#room", epoch: 1, seq: "0", hash: "root" })).toBe(false);
    expect(isShadowScopeHead({ kind: "old.head", scope: "#room", epoch: 1, seq: 0, hash: "root" })).toBe(false);
    expect(parseShadowScopeHeadJson(JSON.stringify({
      kind: "woo.scope_head.shadow.v1",
      scope: "#room",
      epoch: 1,
      seq: 0,
      hash: "root"
    }))).toEqual({
      kind: "woo.scope_head.shadow.v1",
      scope: "#room",
      epoch: 1,
      seq: 0,
      hash: "root"
    });
    expect(parseShadowScopeHeadJson("{")).toBeUndefined();
  });
});
