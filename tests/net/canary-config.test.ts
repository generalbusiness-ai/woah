import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("net canary deployment isolation", () => {
  const config = readFileSync("wrangler.net-canary.template.toml", "utf8");

  it("is a standalone workers.dev worker with no production route surface", () => {
    expect(config).toContain('name = "woah-net-canary"');
    expect(config).toContain("workers_dev = true");
    expect(config).not.toMatch(/^routes\s*=/m);
    expect(config).not.toContain("custom_domain");
    expect(config).not.toMatch(/^\[env\.canary\]$/m);
  });

  it("cannot deploy accidentally with a shared KV and writes a dedicated AE dataset", () => {
    expect(config).toContain('id = "CANARY_HOST_SEED_KV_ID"');
    expect(config).toContain('dataset = "woo_v1_net_canary"');
    expect(config).toContain('WOO_AE_DATASET = "woo_v1_net_canary"');
  });
});
