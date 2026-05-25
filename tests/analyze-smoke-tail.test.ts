import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/analyze-smoke-tail.mjs");

describe("analyze-smoke-tail", () => {
  it("counts timeout metrics as failed RPCs", () => {
    const result = runAnalyzer({
      kind: "cross_host_rpc",
      route: "/__internal/enumerate-tools",
      host: "the_outline",
      status: "timeout",
      ms: 5000
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("timeout cross_host_rpc//__internal/enumerate-tools");
    expect(result.stdout).toMatch(/\/__internal\/enumerate-tools.*the_outline\s+1\s+1/);
  });
});

function runAnalyzer(...metrics: Array<Record<string, unknown>>): ReturnType<typeof spawnSync> {
  const dir = mkdtempSync(join(tmpdir(), "woo-tail-time-"));
  try {
    const path = join(dir, "tail.log");
    writeFileSync(path, tailEvent(...metrics));
    return spawnSync(process.execPath, [script, path], {
      cwd: resolve("."),
      encoding: "utf8"
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function tailEvent(...metrics: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    eventTimestamp: 1,
    wallTime: 1,
    cpuTime: 1,
    event: {
      request: { method: "POST", url: "https://example.test/mcp" },
      response: { status: 200 }
    },
    logs: metrics.map((metric) => ({
      timestamp: 1,
      message: ["woo.metric", JSON.stringify(metric)]
    }))
  }, null, 2);
}
