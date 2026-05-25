import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/analyze-data-path-costs.mjs");

describe("analyze-data-path-costs", () => {
  it("accepts classified metric kinds", () => {
    const result = runAnalyzer({
      kind: "direct_call",
      target: "the_chatroom",
      verb: "enter",
      observations: 1,
      status: "ok"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Observed metric-kind coverage");
    expect(result.stdout).toContain("| direct_call | 1 | vm_execution |");
  });

  it("fails when a smoke-tail metric kind is unclassified", () => {
    const result = runAnalyzer({
      kind: "new_unclassified_metric",
      status: "ok"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unclassified metric kinds: new_unclassified_metric");
  });

  it("accepts planned reply replay metrics", () => {
    const result = runAnalyzer({
      kind: "commit_reply_replay",
      mode: "cached_sql",
      scope: "the_chatroom",
      ms: 1,
      bytes: 256
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("| commit_reply_replay | 1 | idempotency |");
  });

  it("classifies every current MetricEvent kind", () => {
    const kinds = metricKindsFromTypes();
    const result = runAnalyzer(...kinds.map((kind) => ({ kind })));

    expect(result.status).toBe(0);
    for (const kind of kinds) {
      expect(result.stdout).toContain(`| ${kind} | 1 |`);
    }
  });
});

function runAnalyzer(...metrics: Array<Record<string, unknown>>): ReturnType<typeof spawnSync> {
  const dir = mkdtempSync(join(tmpdir(), "woo-tail-cost-"));
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
    logs: metrics.map((metric) => ({
      timestamp: 1,
      message: ["woo.metric", JSON.stringify(metric)]
    }))
  }, null, 2);
}

function metricKindsFromTypes(): string[] {
  const text = readFileSync(resolve("src/core/types.ts"), "utf8");
  const start = text.indexOf("export type MetricEvent =");
  const end = text.indexOf("export type SequencedMessage", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const metricEvent = text.slice(start, end);
  return [...new Set([...metricEvent.matchAll(/kind: "([^"]+)"/g)].map((match) => match[1]))].sort();
}
