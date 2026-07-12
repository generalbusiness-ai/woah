import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("net-only client build boundary", () => {
  it("compile-time removes the v2 browser worker constructor and checks output", () => {
    const main = readFileSync(new URL("../../src/client/main.ts", import.meta.url), "utf8");
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(main).toContain("if (__WOO_NET_ONLY__) return;");
    expect(pkg.scripts["build:net-only"]).toContain("check-net-only-build.mjs");
  });
});
