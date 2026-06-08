#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const repoRoot = process.cwd();
const timingFile = resolve(process.env.WOO_TASK_TIMING_FILE ?? ".woo/task-times.tsv");
// The log is intentionally a summary table: one durable line per task, with
// active_since carrying the only open interval.
const columns = [
  "task",
  "develop_ms",
  "test_ms",
  "test_runs",
  "active_since",
  "created_at",
  "updated_at",
  "last_test_status",
];

function nowIso() {
  return new Date().toISOString();
}

function sanitizeField(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

function parseMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function ensureFileDir() {
  mkdirSync(dirname(timingFile), { recursive: true });
}

function emptyRow(task) {
  const ts = nowIso();
  return {
    task,
    develop_ms: 0,
    test_ms: 0,
    test_runs: 0,
    active_since: "",
    created_at: ts,
    updated_at: ts,
    last_test_status: "",
  };
}

function loadRows() {
  if (!existsSync(timingFile)) return new Map();
  const text = readFileSync(timingFile, "utf8");
  const rows = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split("\t");
    const row = {};
    for (let index = 0; index < columns.length; index += 1) {
      row[columns[index]] = fields[index] ?? "";
    }
    const task = sanitizeField(row.task);
    if (!task) continue;
    rows.set(task, {
      task,
      develop_ms: parseMs(row.develop_ms),
      test_ms: parseMs(row.test_ms),
      test_runs: parseMs(row.test_runs),
      active_since: sanitizeField(row.active_since),
      created_at: sanitizeField(row.created_at),
      updated_at: sanitizeField(row.updated_at),
      last_test_status: sanitizeField(row.last_test_status),
    });
  }
  return rows;
}

function saveRows(rows) {
  ensureFileDir();
  const orderedRows = [...rows.values()].sort((a, b) => a.task.localeCompare(b.task));
  const lines = [
    `# ${columns.join("\t")}`,
    ...orderedRows.map((row) =>
      columns
        .map((column) => sanitizeField(row[column]))
        .join("\t"),
    ),
  ];
  const tempPath = `${timingFile}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${lines.join("\n")}\n`, "utf8");
  renameSync(tempPath, timingFile);
}

function rowFor(rows, task) {
  const normalized = sanitizeField(task);
  if (!normalized) fail("Task name is required.");
  if (!rows.has(normalized)) rows.set(normalized, emptyRow(normalized));
  return rows.get(normalized);
}

function activeRows(rows) {
  return [...rows.values()].filter((row) => row.active_since);
}

function elapsedSince(iso, at = new Date()) {
  const start = Date.parse(iso);
  const end = at.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start;
}

function stopRow(row, at = new Date()) {
  if (!row.active_since) return 0;
  const elapsed = elapsedSince(row.active_since, at);
  row.develop_ms += elapsed;
  row.active_since = "";
  row.updated_at = at.toISOString();
  return elapsed;
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function printTable(rows) {
  const at = new Date();
  const reportRows = [...rows.values()].sort((a, b) => a.task.localeCompare(b.task));
  const rendered = reportRows.map((row) => {
    const activeExtra = row.active_since ? elapsedSince(row.active_since, at) : 0;
    return {
      task: row.task,
      develop: formatDuration(row.develop_ms + activeExtra),
      tests: formatDuration(row.test_ms),
      runs: String(row.test_runs),
      active: row.active_since ? `yes since ${row.active_since}` : "",
      updated: row.updated_at,
      status: row.last_test_status,
    };
  });
  const widths = {
    task: Math.max(4, ...rendered.map((row) => row.task.length)),
    develop: Math.max(7, ...rendered.map((row) => row.develop.length)),
    tests: Math.max(5, ...rendered.map((row) => row.tests.length)),
    runs: Math.max(4, ...rendered.map((row) => row.runs.length)),
    active: Math.max(6, ...rendered.map((row) => row.active.length)),
    status: Math.max(6, ...rendered.map((row) => row.status.length)),
  };
  console.log(`Task timing file: ${timingFile}`);
  if (rendered.length === 0) {
    console.log("No task timing rows yet.");
    return;
  }
  console.log(
    [
      "Task".padEnd(widths.task),
      "Develop".padStart(widths.develop),
      "Tests".padStart(widths.tests),
      "Runs".padStart(widths.runs),
      "Active".padEnd(widths.active),
      "Status".padEnd(widths.status),
    ].join("  "),
  );
  for (const row of rendered) {
    console.log(
      [
        row.task.padEnd(widths.task),
        row.develop.padStart(widths.develop),
        row.tests.padStart(widths.tests),
        row.runs.padStart(widths.runs),
        row.active.padEnd(widths.active),
        row.status.padEnd(widths.status),
      ].join("  "),
    );
  }
}

function reportJson(rows) {
  const at = new Date();
  return {
    file: timingFile,
    generated_at: at.toISOString(),
    tasks: [...rows.values()]
      .sort((a, b) => a.task.localeCompare(b.task))
      .map((row) => ({
        task: row.task,
        develop_ms: row.develop_ms + (row.active_since ? elapsedSince(row.active_since, at) : 0),
        test_ms: row.test_ms,
        test_runs: row.test_runs,
        active_since: row.active_since,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_test_status: row.last_test_status,
      })),
  };
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function usage() {
  console.log(`Usage:
  npm run task:time -- start <task name>
  npm run task:time -- stop [task name]
  npm run task:time -- status
  npm run task:time -- report [--json]
  npm run task:time -- test [--task <task name>] -- <command> [args...]

The log is a single TSV file with one line per task.
Default: ${timingFile}
Override: WOO_TASK_TIMING_FILE=/path/to/task-times.tsv
`);
}

function commandStart(args) {
  const task = sanitizeField(args.join(" "));
  const rows = loadRows();
  const at = new Date();
  for (const row of activeRows(rows)) {
    if (row.task !== task) stopRow(row, at);
  }
  const row = rowFor(rows, task);
  if (!row.active_since) {
    row.active_since = at.toISOString();
    row.updated_at = row.active_since;
  }
  saveRows(rows);
  console.log(`Timing development for "${row.task}" in ${timingFile}`);
}

function commandStop(args) {
  const rows = loadRows();
  const task = sanitizeField(args.join(" "));
  const candidates = task ? [rows.get(task)].filter(Boolean) : activeRows(rows);
  if (candidates.length === 0) fail("No active task timer.");
  const at = new Date();
  for (const row of candidates) {
    const elapsed = stopRow(row, at);
    console.log(`Stopped "${row.task}" (+${formatDuration(elapsed)} develop).`);
  }
  saveRows(rows);
}

function commandStatus() {
  const rows = loadRows();
  const active = activeRows(rows);
  if (active.length === 0) {
    console.log("No active task timer.");
    return;
  }
  const at = new Date();
  for (const row of active) {
    console.log(
      `"${row.task}" active for ${formatDuration(elapsedSince(row.active_since, at))} since ${row.active_since}`,
    );
  }
}

function parseTestArgs(args) {
  let task = "";
  const command = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--task") {
      task = sanitizeField(args[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (arg === "--") {
      command.push(...args.slice(index + 1));
      break;
    }
    command.push(arg);
  }
  return { task, command };
}

async function runChild(command) {
  const start = performance.now();
  const child = spawn(command[0], command.slice(1), {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const forwardSigint = () => forwardSignal("SIGINT");
  const forwardSigterm = () => forwardSignal("SIGTERM");
  process.once("SIGINT", forwardSigint);
  process.once("SIGTERM", forwardSigterm);
  return await new Promise((resolve) => {
    child.on("error", (error) => {
      resolve({
        duration_ms: Math.round(performance.now() - start),
        exit_code: 1,
        signal: "",
        status: `spawn_error:${error.code ?? error.name}`,
      });
    });
    child.on("close", (exitCode, signal) => {
      process.removeListener("SIGINT", forwardSigint);
      process.removeListener("SIGTERM", forwardSigterm);
      const status = signal ? `signal:${signal}` : `exit:${exitCode ?? 0}`;
      resolve({
        duration_ms: Math.round(performance.now() - start),
        exit_code: exitCode ?? (signal ? 1 : 0),
        signal: signal ?? "",
        status,
      });
    });
  });
}

async function commandTest(args) {
  const { task: explicitTask, command } = parseTestArgs(args);
  if (command.length === 0) fail("Test command is required after `test --`.");
  const rows = loadRows();
  const active = activeRows(rows);
  const task = explicitTask || (active.length === 1 ? active[0].task : "");
  if (!task) fail("Use --task <task name>, or start exactly one active task first.");
  const row = rowFor(rows, task);
  const atStart = new Date();
  const resumeAfter = Boolean(row.active_since);
  if (resumeAfter) stopRow(row, atStart);
  saveRows(rows);

  const result = await runChild(command);

  const latestRows = loadRows();
  const latestRow = rowFor(latestRows, task);
  latestRow.test_ms += result.duration_ms;
  latestRow.test_runs += 1;
  latestRow.updated_at = nowIso();
  latestRow.last_test_status = result.status;
  if (resumeAfter) latestRow.active_since = latestRow.updated_at;
  saveRows(latestRows);
  console.log(
    `Recorded "${task}" test run: ${formatDuration(result.duration_ms)} (${result.status}).`,
  );
  process.exit(result.exit_code);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "start") return commandStart(args);
  if (command === "stop") return commandStop(args);
  if (command === "status") return commandStatus();
  if (command === "report") {
    const rows = loadRows();
    if (args.includes("--json")) console.log(JSON.stringify(reportJson(rows), null, 2));
    else printTable(rows);
    return;
  }
  if (command === "test") return await commandTest(args);
  fail(`Unknown task timing command: ${command}`);
}

await main();
