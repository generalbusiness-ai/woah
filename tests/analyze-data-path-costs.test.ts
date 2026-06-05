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

  it("classifies MCP relocation prewarm metrics", () => {
    const result = runAnalyzer({
      kind: "mcp_relocation_prewarm",
      scope: "the_chatroom",
      commit_scope: "guest_1",
      target: "the_chatroom",
      verb: "enter",
      ms: 12,
      status: "ok"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("| mcp_relocation_prewarm | 1 | request_wall_time |");
  });

  it("classifies slim-envelope sizing and reseed metrics", () => {
    const result = runAnalyzer(
      {
        kind: "v2_envelope_bytes",
        scope: "the_chatroom",
        node: "mcp:test",
        relay_warmth: "snapshot",
        request_bytes: 50800,
        authority_bytes: 0,
        capsule_authority_bytes: 0,
        capsule_present: false,
        sessions_bytes: 300,
        session_objects_bytes: 0,
        envelope_bytes: 49000
      },
      {
        kind: "mcp_envelope_slim_reseed",
        scope: "the_chatroom",
        mode: "slim"
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("| v2_envelope_bytes | 1 | known_bytes |");
    expect(result.stdout).toContain("| mcp_envelope_slim_reseed | 1 | commit_request |");
  });

  it("classifies sampled browser metric logs as instrumentation volume", () => {
    const result = runAnalyzer({
      kind: "browser_metrics_log_sampled",
      suppressed: 12,
      ms_window: 1000,
      host_key: "mcp-gateway-1"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("| browser_metrics_log_sampled | 1 | browser_projection |");
  });

  it("counts gateway projection cache bytes in projection-byte rollups", () => {
    const result = runAnalyzer({
      kind: "gateway_projection_cache_write",
      scope: "the_chatroom",
      rows: 2,
      bytes: 512,
      projection_bytes: 512,
      gateway_projection_rows_written: 2,
      gateway_projection_bytes: 512,
      source: "fanout"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("observed projection bytes: 512 B (512 bytes");
    expect(result.stdout).toContain("| gateway_projection_cache_write | 1 | fanout_apply |");
  });

  it("reports tool-surface reverse-index sizing by scope", () => {
    const result = runAnalyzer(
      {
        kind: "gateway_tool_surface_source_rows",
        scope: "room_a",
        object: "widget_a",
        rows: 3,
        scope_rows: 3,
        shard_rows: 3,
        cap: 10000,
        shard_cap: 40000,
        saturated: false
      },
      {
        kind: "gateway_tool_surface_source_rows",
        scope: "room_b",
        object: "widget_b",
        rows: 2,
        scope_rows: 0,
        shard_rows: 3,
        cap: 1,
        shard_cap: 40000,
        saturated: true,
        saturation_reason: "scope"
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Tool-surface reverse-index sizing");
    expect(result.stdout).toContain("gateway_tool_surface_source_rows events: 2");
    expect(result.stdout).toContain("| room_a | 1 | 1 | 3 | 3 | 10000 | 3 | 40000 | 0 |  |");
    expect(result.stdout).toContain("| room_b | 1 | 1 | 2 | 0 | 1 | 3 | 40000 | 1 | scope |");
  });

  it("reports the success-criteria cost fields from observed metrics", () => {
    const result = runAnalyzer(
      {
        kind: "v2_envelope",
        scope: "the_chatroom",
        ms: 5,
        status: "ok",
        projection_bytes: 20,
        tail_rows_written: 2,
        tail_bytes_retained: 128
      },
      {
        kind: "authority_tail",
        scope: "the_chatroom",
        ms: 1,
        tail_rows_written: 3,
        tail_rows_pruned: 1,
        tail_bytes_retained: 256,
        accepted_frames_retained: 2,
        transcript_tail_retained: 2
      },
      {
        kind: "gateway_projection_apply",
        scope: "the_chatroom",
        rows: 4,
        projection_bytes: 40,
        source: "fanout"
      },
      {
        kind: "v2_host_apply_fanout",
        scope: "the_chatroom",
        hosts: 2,
        touched: 5,
        ms: 7,
        status: "ok"
      },
      {
        kind: "v2_open_step",
        phase: "gateway_send_checkpoint_tail_transfer",
        scope: "the_chatroom",
        ms: 3,
        status: "ok",
        bytes: 512,
        transfer_mode: "checkpoint_tail:frames"
      },
      {
        kind: "v2_open_step",
        phase: "checkpoint_build",
        scope: "the_chatroom",
        ms: 11,
        status: "ok"
      },
      {
        kind: "v2_open_step",
        phase: "checkpoint_tail_packaging",
        scope: "the_chatroom",
        ms: 13,
        status: "ok"
      },
      {
        kind: "same_host_fallback",
        route: "/__internal/enumerate-tools",
        host: "world",
        rows: 6,
        reason: "cache_hit"
      },
      {
        kind: "cross_host_rpc",
        route: "/__internal/enumerate-tools",
        host: "room-host",
        ms: 17,
        status: "timeout"
      },
      {
        kind: "cross_host_rpc",
        route: "/__internal/apply-v2-commit",
        host: "room-host",
        ms: 19,
        status: "ok"
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Success-criteria cost summary");
    expect(result.stdout).toContain("| projection rows touched | 9 |");
    expect(result.stdout).toContain("| projection bytes | 60 |");
    expect(result.stdout).toContain("| fanout rows touched | 9 |");
    expect(result.stdout).toContain("| checkpoint transfer bytes | 512 |");
    expect(result.stdout).toContain("| tail rows written | 5 |");
    expect(result.stdout).toContain("| tail bytes retained | 256 |");
    expect(result.stdout).toContain("| checkpoint build ms | 11 |");
    expect(result.stdout).toContain("| checkpoint packaging ms | 13 |");
    expect(result.stdout).toContain("| same-host fallback count | 1 |");
    expect(result.stdout).toContain("| remote owner refresh count | 1 |");
    expect(result.stdout).toContain("| cross-host round trips | 2 |");
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
