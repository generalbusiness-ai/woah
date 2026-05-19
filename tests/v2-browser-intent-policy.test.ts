import { describe, expect, it } from "vitest";

import { v2ServerAssistedIntentPolicy } from "../src/client/v2-browser-intent-policy";

describe("v2 browser intent fallback policy", () => {
  it("allows live turns through the server-assisted intent path", () => {
    expect(v2ServerAssistedIntentPolicy({ route: "direct", persistence: "live" })).toEqual({
      ok: true,
      reason: "live_turn"
    });
  });

  it("keeps selected durable intent behind an explicit compatibility flag", () => {
    expect(v2ServerAssistedIntentPolicy({
      route: "sequenced",
      persistence: "durable",
      selectedScopeAd: "node:commit-scope:the_dubspace:executor",
      allowSelectedDurableIntent: true
    })).toEqual({
      ok: true,
      reason: "scope_ad",
      selected_ad: "node:commit-scope:the_dubspace:executor"
    });
  });

  it("blocks bare durable server-assisted planning", () => {
    expect(v2ServerAssistedIntentPolicy({ route: "sequenced", persistence: "durable" })).toEqual({
      ok: false,
      reason: "server_assisted_durable_disabled"
    });
  });

  it("blocks selected durable server-assisted planning by default", () => {
    expect(v2ServerAssistedIntentPolicy({
      route: "sequenced",
      persistence: "durable",
      selectedScopeAd: "node:commit-scope:the_dubspace:executor"
    })).toEqual({
      ok: false,
      reason: "server_assisted_durable_disabled"
    });
  });
});
