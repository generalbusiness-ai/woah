import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = join(process.cwd(), "scripts/task-time.mjs");
const tempDirs: string[] = [];

function makeTimingFile() {
  const dir = mkdtempSync(join(tmpdir(), "woo-task-time-"));
  tempDirs.push(dir);
  return join(dir, "task-times.tsv");
}

function runTiming(args: string[], timingFile: string) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      WOO_TASK_TIMING_FILE: timingFile,
    },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("task timing harness", () => {
  it("keeps one persistent row per task with development and test totals", () => {
    const timingFile = makeTimingFile();

    expect(runTiming(["start", "local dev carry/drop"], timingFile).status).toBe(0);
    expect(
      runTiming(["test", "--", process.execPath, "-e", "setTimeout(() => {}, 1)"], timingFile)
        .status,
    ).toBe(0);
    expect(runTiming(["stop"], timingFile).status).toBe(0);

    const logLines = readFileSync(timingFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"));
    expect(logLines).toHaveLength(1);

    const report = runTiming(["report", "--json"], timingFile);
    expect(report.status).toBe(0);
    const parsed = JSON.parse(report.stdout);
    expect(parsed.file).toBe(timingFile);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]).toMatchObject({
      task: "local dev carry/drop",
      test_runs: 1,
      active_since: "",
      last_test_status: "exit:0",
    });
    expect(parsed.tasks[0].develop_ms).toBeGreaterThanOrEqual(0);
    expect(parsed.tasks[0].test_ms).toBeGreaterThanOrEqual(0);
  });
});
