import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/smoke-metrics-history.mjs");

describe("smoke-metrics-history", () => {
  it("extracts chartable smoke, turn, reconstruction, repair, RPC, and byte metrics", () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-smoke-history-"));
    try {
      const root = join(dir, "measurements");
      const out = join(dir, "out");
      const run = join(root, "deploy-abc1234-deadbee-b7-tail-20260609T205833Z");
      writeRun(run, {
        smoke: smokeLog({ passed: 1, attempted: 2, failed: 1 }),
        tail: [
          tailEvent({
            entrypoint: "Worker",
            wallTime: 200,
            metrics: [
              {
                kind: "turn_phase_timing",
                total_ms: 1000,
                ensure_client_ms: 200,
                authority_ms: 300,
                serialize_ms: 10,
                plan_build_ms: 20,
                vm_ms: 30,
                submit_ms: 400,
                attempts: 2
              },
              { kind: "turn_repair_attempt", reason: "missing_state" },
              { kind: "shadow_commit_rejected", reason: "read_version_mismatch" },
              { kind: "authority_slice_reconstructed", reason: "warm_turn_refresh", trigger: "turn_commit", page_count: 7 },
              { kind: "authority_slice_reconstructed", reason: "cold_open", trigger: "owner_prefetch", page_count: 5 },
              { kind: "mcp_owner_prefetch", requested: 3, warm_local: 1, warm_donor: 1, residue: 1 },
              { kind: "v2_envelope", request_bytes: 2_097_152, reply_bytes: 4096, tail_rows_written: 2, tail_bytes_retained: 9000, projection_bytes: 128 },
              { kind: "authority_tail", tail_rows_written: 3, tail_bytes_retained: 12_000 },
              { kind: "cross_host_rpc", route: "/__internal/authority-slice", status: "timeout", ms: 5000 },
              { kind: "same_host_fallback", route: "/__internal/enumerate-tools" },
              { kind: "gateway_projection_cache_write", projection_bytes: 256 },
              { kind: "storage_full_save", rows: 10 },
              { kind: "storage_direct_write", rows: 4 }
            ]
          }),
          tailEvent({ entrypoint: "PersistentObjectDO", wallTime: 300, metrics: [] })
        ].join("\n")
      });

      const result = runScript(root, out);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("latest: deploy-abc1234-deadbee-b7-tail-20260609T205833Z");
      expect(existsSync(join(out, "summary.json"))).toBe(true);
      expect(existsSync(join(out, "summary.csv"))).toBe(true);
      expect(existsSync(join(out, "chart.svg"))).toBe(true);

      const json = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
      const row = json.runs[0];
      expect(row.smoke_passed).toBe(1);
      expect(row.smoke_failed).toBe(1);
      expect(row.worker_mcp_post_p95_ms).toBe(200);
      expect(row.do_mcp_post_p95_ms).toBe(300);
      expect(row.turn_total_p95_ms).toBe(1000);
      expect(row.turns_attempts_gt1).toBe(1);
      expect(row.repair_attempts).toBe(1);
      expect(row.recon_total).toBe(2);
      expect(row.recon_warm_turn_refresh).toBe(1);
      expect(row.recon_trigger_owner_prefetch).toBe(1);
      expect(row.owner_prefetch_residue).toBe(1);
      expect(row.cross_host_rpc_timeouts).toBe(1);
      expect(row.v2_request_bytes_p95).toBe(2_097_152);
      expect(row.projection_bytes).toBe(384);
      expect(row.tail_rows_written).toBe(5);
      expect(row.tail_bytes_retained_max).toBe(12_000);

      const csv = readFileSync(join(out, "summary.csv"), "utf8");
      expect(csv).toContain("recon_warm_turn_refresh");
      expect(csv).toContain("deploy-abc1234-deadbee-b7-tail-20260609T205833Z");
      expect(readFileSync(join(out, "chart.svg"), "utf8")).toContain("Cloudflare Smoke Metrics History");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers run directories and can limit output to the latest runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-smoke-history-limit-"));
    try {
      const root = join(dir, "measurements");
      const out = join(dir, "out");
      writeRun(join(root, "deploy-aaaaaaa-1111111-20260608T120000Z"), {
        smoke: smokeLog({ passed: 7, attempted: 10, failed: 3 }),
        tail: tailEvent({ wallTime: 100, metrics: [{ kind: "turn_phase_timing", total_ms: 100, attempts: 1 }] })
      });
      writeRun(join(root, "deploy-bbbbbbb-2222222-20260609T120000Z"), {
        smoke: smokeLog({ passed: 8, attempted: 10, failed: 2 }),
        tail: tailEvent({ wallTime: 200, metrics: [{ kind: "turn_phase_timing", total_ms: 200, attempts: 1 }] })
      });

      const result = runScript(root, out, "--limit", "1");
      expect(result.status).toBe(0);
      const json = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
      expect(json.runs).toHaveLength(1);
      expect(json.runs[0].run_id).toBe("deploy-bbbbbbb-2222222-20260609T120000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function runScript(root: string, out: string, ...extraArgs: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script, root, "--out", out, ...extraArgs], {
    cwd: resolve("."),
    encoding: "utf8"
  });
}

function writeRun(dir: string, files: { smoke: string; tail: string }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "smoke.log"), files.smoke);
  writeFileSync(join(dir, "tail.log"), files.tail);
}

function smokeLog({ passed, attempted, failed }: { passed: number; attempted: number; failed: number }): string {
  return [
    "started_at=2026-06-09T21:00:00Z",
    "  ok    first step (100ms)",
    failed > 0 ? "  FAIL  second step (200ms): expected failure" : "  ok    second step (200ms)",
    `summary: ${passed}/${attempted} steps attempted passed, ${failed} failed`,
    "finished_at=2026-06-09T21:01:00Z",
    ""
  ].join("\n");
}

function tailEvent({
  entrypoint = "Worker",
  wallTime = 100,
  metrics
}: {
  entrypoint?: string;
  wallTime?: number;
  metrics: Array<Record<string, unknown>>;
}): string {
  return JSON.stringify({
    eventTimestamp: 1,
    entrypoint,
    executionModel: entrypoint === "Worker" ? "stateless" : "durableObject",
    wallTime,
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
