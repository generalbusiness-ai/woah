#!/usr/bin/env tsx
// smoke-cf-dev — the local workerd smoke lane. Boots the REAL worker entry in
// REAL workerd via `wrangler dev` (wrangler.smoke.toml), with REAL per-Durable-
// Object storage and REAL cross-DO RPC, then runs the shared cross-actor
// scenario (scripts/smoke/scenario.ts) against it over MCP HTTP.
//
// This is the lane between the in-process fake DO (`smoke:cf-local`, fast but
// collapses every DO into one synchronous object sharing one world image) and
// the paid Cloudflare deploy smoke (`scripts/smoke-walkthrough.ts`). It exists
// because the fake cannot model the distributed substrate surface — cold start,
// per-DO storage isolation, cross-DO RPC, serialization boundaries — where the
// authority/lineage-propagation failures that historically passed cf-local and
// then failed on deploy actually live. See
// notes/2026-06-09-cf-smoke-unified-lanes.md.
//
// Usage:
//   npm run smoke:cf-dev -- [--port=<n>] [--run-id=<id>] [--verbose] [--keep]
//                          [--measure] [--passes=<n>]
//
// Default mode is the pass/fail deploy gate (one cold pass, 11 steps).
//
// `--measure` turns it into a perf bench: it runs the scenario N passes
// (default 2) against ONE persisted world — pass 1 cold-boots, pass 2+ hit a
// warm world / warm DOs / warm caches — captures the worker's turn_phase_timing
// and v2_envelope metrics off the wrangler stdout, buckets them per pass by
// time window, and prints a cold-vs-warm phase/bytes table. This is the
// before/after instrument for turn-path perf work (notes/2026-06-09-*).
//
// Exit status: 0 if every step passes, 1 if any step fails, 2 on harness crash
// (e.g. workerd never became ready).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { httpTransport, SmokeSession } from "./smoke/session";
import { runSmokeWalkthrough, type SmokeSessionPair, type StepContext } from "./smoke/scenario";

// `tracked` names the plan item (e.g. "→ A2") when a failure is expected on
// this lane until that item lands. Tracked failures are printed as TRACKED-FAIL
// (not FAIL) and are not counted toward `anyFailed`, so the gate stays green
// while the tracked item is outstanding. When a tracked step starts PASSING the
// gate loudly reports that it should be promoted to ENFORCED.
type StepResult = { name: string; ok: boolean; ms: number; detail?: string; tracked?: string };
type Metric = Record<string, unknown> & { kind?: string; ts?: number };
type PassWindow = { label: string; start: number; end: number; passed: number; total: number; trackedFailed: number };

// Steps whose failures are tracked (expected on this lane, not build-failing).
// Each entry: step name substring → plan item tag. Keep entries sorted.
// Remove an entry only when the plan item has landed and the step reliably passes.
const CF_DEV_TRACKED_FAIL_STEPS: ReadonlyMap<string, string> = new Map([
  // A2 landed (2026-06-10): carry-across-rooms was tracked → A2 because
  // propagateTranscriptToOtherScopes delivered transcript deltas without the
  // moved/created objects' class lineage, causing dangling_parent_ref and
  // E_VERBNF on the destination shard. A2 (mergeIncomingObjectLineageClosure)
  // fixes this by pre-merging the transitive parent chain of all incoming
  // objects into the destination relay before the delta frame. The step is now
  // ENFORCED (removed from this map). If it regresses, the gate exit code flips.
  //
  // tool-surface-after-move was initially tracked → A2 here, but the observed
  // cf-dev run PASSES it (TRACKED-OK promotion, 2026-06-09): workerd-local
  // serves the pinboard tool surface correctly after a cross-room enter. The
  // add_note E_VERBNF remains a DEPLOY-ONLY failure (lane-fidelity ladder,
  // AGENTS.md) until A2 lands, so the step is ENFORCED on this lane and the
  // deployed walkthrough carries the A2 signal.
]);

const args = parseArgs(process.argv.slice(2));

// How long to wait for `wrangler dev` to build + boot + first-light the demo
// world (auto-install of the bundled catalogs runs on the first cold request).
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 500;
// Generous step watchdog: cold workerd DO instantiation on first touch is real
// here (unlike the fake), so individual steps can run several seconds.
const STEP_TIMEOUT_MS = 60_000;
// Settle window for piped worker metrics to drain before teardown in --measure.
const METRIC_FLUSH_MS = 2000;

async function main(): Promise<void> {
  const port = args.port ?? (await findFreePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const runId = args.runId;
  const passCount = args.passes;
  // Worker metrics captured off wrangler stdout, used by --measure to attribute
  // per-pass turn cost. Collected even in gate mode (cheap); only printed when
  // measuring.
  const metrics: Metric[] = [];

  // Per-run, isolated persistence. `wrangler dev` otherwise reuses its default
  // .wrangler/state, so the gate could pass against a world bootstrapped by an
  // earlier run and SKIP the cold first-light path (catalog auto-install, KV
  // host-seed, DO migrations) — exactly the regressions this lane exists to
  // catch. A fresh temp dir per run forces a true cold boot every time. In
  // --measure mode the dir is NOT wiped between passes, so pass 2+ run warm.
  const persistDir = mkdtempSync(join(tmpdir(), "woo-smoke-cf-dev-"));
  console.log(`smoke-cf-dev booting wrangler dev on ${baseUrl} (run=${runId}, persist=${persistDir}${args.measure ? `, measure passes=${passCount}` : ""})`);
  const server = await startWorkerd(port, persistDir, (m) => metrics.push(m));
  const passWindows: PassWindow[] = [];
  let crashed: unknown = null;
  try {
    await waitForHealthz(baseUrl);
    console.log(`  ok    workerd ready (${baseUrl}/healthz)`);

    const transport = httpTransport(baseUrl);
    for (let pass = 1; pass <= passCount; pass += 1) {
      const passLabel = passCount > 1 ? (pass === 1 ? "cold" : `warm${pass > 2 ? pass - 1 : ""}`) : "run";
      const passRunId = passCount > 1 ? `${runId}-p${pass}` : runId;
      if (passCount > 1) console.log(`\n--- pass ${pass}/${passCount} (${passLabel}) ---`);
      const results: StepResult[] = [];
      const start = Date.now();
      const pair = await openSessionPair(transport, passRunId);
      try {
        await runSmokeWalkthrough(pair, makeStepRunner(results), {
          runId: passRunId,
          // The workerd lane is a faithful local CF, so it runs the FULL coverage:
          // take/drop fanout AND the concurrent-through-shared-destination step.
          // (Unlike the fake lane, it has no dangling_parent_ref==0 ratchet, so
          // take/drop on a $portable object is fine here.)
          includeTakeDrop: true,
          includeConcurrentMove: true,
          // C3 gates: run both new cross-scope steps. They are expected to fail on
          // this lane until A2 lands — see CF_DEV_TRACKED_FAIL_STEPS above.
          includeCarryAcrossRooms: true,
          includeToolSurfaceAfterMove: true,
          waitTimeoutMs: 10_000,
          log: args.verbose ? (msg) => console.log(msg) : undefined
        });
      } finally {
        await Promise.allSettled([pair.alice.close(), pair.bob.close()]);
      }
      passWindows.push({
        label: passLabel,
        start,
        end: Date.now(),
        passed: results.filter((r) => r.ok).length,
        total: results.length,
        trackedFailed: results.filter((r) => !r.ok && r.tracked !== undefined).length
      });
    }
    // Metrics arrive asynchronously via the piped wrangler stdout; the last
    // pass's lines can still be in the pipe when its window closes. Let them
    // drain before teardown SIGTERMs wrangler (which would drop buffered output),
    // so the final pass is not under-counted in the measurement table.
    if (args.measure) await sleep(METRIC_FLUSH_MS);
  } catch (err) {
    crashed = err;
  } finally {
    if (!args.keep) {
      await stopWorkerd(server);
      // Remove the cold-boot state only after workerd has exited and released
      // its file handles, so the next run starts cold again.
      try { rmSync(persistDir, { recursive: true, force: true }); } catch { /* best effort */ }
    } else {
      console.log(`  --keep set; leaving wrangler dev running on ${baseUrl} (pid ${server.pid}, persist=${persistDir})`);
    }
  }

  console.log();
  // Unexpected failures: real bugs; tracked failures: expected until the named
  // plan item lands. When a tracked step starts passing, the gate should be
  // promoted to ENFORCED — that transition is reported loudly here.
  let anyFailed = false;
  for (const w of passWindows) {
    const failed = w.total - w.passed;
    const unexpected = failed - (w.trackedFailed ?? 0);
    if (unexpected > 0) anyFailed = true;
    const summary = `${w.passed}/${w.total} steps passed` +
      (unexpected > 0 ? `, ${unexpected} unexpected failures` : "") +
      (w.trackedFailed ? `, ${w.trackedFailed} tracked-fail (expected; see CF_DEV_TRACKED_FAIL_STEPS)` : "");
    console.log(`summary[${w.label}]: ${summary}`);
  }
  if (args.measure) printMeasurement(metrics, passWindows);
  if (crashed) {
    console.error("smoke-cf-dev harness error:", crashed instanceof Error ? crashed.stack ?? crashed.message : crashed);
    process.exit(2);
  }
  process.exit(anyFailed ? 1 : 0);
}

// Aggregate turn_phase_timing + v2_envelope metrics into per-pass buckets (by
// time window) and print a cold-vs-warm table. This is the directional perf
// instrument: phase ms are real workerd CPU/RPC time, and request_bytes /
// authority_calls are transport-independent structural costs that map directly
// to prod latency (count/bytes x cross-colo RTT).
function printMeasurement(metrics: Metric[], windows: PassWindow[]): void {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const inWindow = (ts: unknown, w: PassWindow) => typeof ts === "number" && ts >= w.start && ts <= w.end;

  const PHASES = ["total_ms", "ensure_client_ms", "authority_ms", "submit_ms", "vm_ms", "serialize_ms", "plan_build_ms"] as const;
  // ensure_detail / submit_detail subkeys worth surfacing (the authority-assembly
  // hot spots this perf work targets).
  const DETAIL = [
    "planning.seed_authority",
    "planning.initial.open_rpc",
    "planning.owner_prefetch_authority",
    "commit.seed_authority"
  ];

  console.log("\n=== perf measurement (per pass) ===");
  const cols = windows.map((w) => w.label.padStart(10));
  console.log(`  ${"metric".padEnd(34)}${cols.join("")}`);
  const row = (label: string, values: number[], fmt = (n: number) => String(Math.round(n))) =>
    console.log(`  ${label.padEnd(34)}${values.map((v) => fmt(v).padStart(10)).join("")}`);

  const perPassTurns = windows.map((w) => metrics.filter((m) => m.kind === "turn_phase_timing" && inWindow(m.ts, w)));
  row("turns", perPassTurns.map((t) => t.length));
  for (const p of PHASES) row(p, perPassTurns.map((turns) => turns.reduce((a, t) => a + num((t as any)[p]), 0)));
  for (const key of DETAIL) {
    row(`  ${key}`, perPassTurns.map((turns) => turns.reduce((a, t) => a + num((t.ensure_detail_ms as any)?.[key] ?? (t.submit_detail_ms as any)?.[key]), 0)));
  }
  row("authority_calls", perPassTurns.map((turns) => turns.reduce((a, t) => a + num(t.authority_calls), 0)));
  row("repair turns (attempts!=1)", perPassTurns.map((turns) => turns.filter((t) => num(t.attempts) !== 1).length));

  // The actual perf levers (per-turn detail shows repeat turns on a warm scope
  // are already ~free; cost concentrates here):
  //  - first-touch turns: a scope seeded for the first time on this session
  //    (ensure_client > 0) — pays a full authority-slice reconstruction;
  //  - warm_turn_refresh reconstructions: owner_prefetch on movement verbs
  //    rebuilds a full slice just to prefetch the destination. Target = 0
  //    (notes/2026-06-09-warm-turn-bounded-commit.md).
  row("first-touch turns (ensure>0)", perPassTurns.map((turns) => turns.filter((t) => num(t.ensure_client_ms) > 0).length));
  row("warm-repeat turns (ensure==0)", perPassTurns.map((turns) => turns.filter((t) => num(t.ensure_client_ms) === 0).length));
  const perPassRecon = windows.map((w) => metrics.filter((m) => m.kind === "authority_slice_reconstructed" && inWindow(m.ts, w)));
  row("slice reconstructions (total)", perPassRecon.map((r) => r.length));
  row("  reason=warm_turn_refresh", perPassRecon.map((r) => r.filter((m) => m.reason === "warm_turn_refresh").length));
  // B7 attribution: split reconstructions by the requesting call path (the
  // `trigger` field). The union of triggers seen across all passes keeps the
  // table stable as triggers come and go between runs.
  const triggers = Array.from(new Set(perPassRecon.flat().map((m) => String(m.trigger ?? m.reason ?? "untagged")))).sort();
  for (const trigger of triggers) {
    row(`  trigger=${trigger}`, perPassRecon.map((r) => r.filter((m) => String(m.trigger ?? m.reason ?? "untagged") === trigger).length));
  }

  const perPassEnv = windows.map((w) => metrics.filter((m) => m.kind === "v2_envelope" && inWindow(m.ts, w)));
  row("envelope request_bytes (sum)", perPassEnv.map((env) => env.reduce((a, e) => a + num(e.request_bytes), 0)));
  row("envelope request_bytes (max)", perPassEnv.map((env) => env.reduce((a, e) => Math.max(a, num(e.request_bytes)), 0)));

  console.log("\n  levers: shrink first-touch seed_authority (full slice per scope/session) and drive");
  console.log("          warm_turn_refresh reconstructions toward 0. Repeat turns on a warm scope are");
  console.log("          already ~free (ensure==0). Phase ms is a single-process floor, not a prod number;");
  console.log("          request_bytes & reconstruction counts are the transport-independent levers.");
}

// Continue-on-failure step runner: record every step, never reset sessions
// (local workerd is deterministic — a failure is a real bug to surface, not a
// flake to recover from), and watchdog-bound each step.
//
// Steps whose names match a key substring in CF_DEV_TRACKED_FAIL_STEPS are
// allowed to fail without affecting the exit code; they are logged as TRACKED-FAIL
// and counted separately. When a tracked step passes, it is logged as
// TRACKED-OK: promote the step from tracked to enforced when that happens.
function makeStepRunner(results: StepResult[]) {
  return async (name: string, body: (ctx: StepContext) => Promise<void>): Promise<void> => {
    const startedAt = Date.now();
    // Look up the tracked tag before executing so we can print it clearly
    // whether the step passes or fails.
    let trackedTag: string | undefined;
    for (const [key, tag] of CF_DEV_TRACKED_FAIL_STEPS) {
      if (name.includes(key)) { trackedTag = tag; break; }
    }
    try {
      await raceWithAbort((signal) => body({ signal }), STEP_TIMEOUT_MS, `step "${name}" exceeded ${STEP_TIMEOUT_MS}ms watchdog`);
      const ms = Date.now() - startedAt;
      results.push({ name, ok: true, ms, tracked: trackedTag });
      if (trackedTag) {
        // A previously-tracked step now passes: promote it to ENFORCED.
        console.log(`  TRACKED-OK (promote to ENFORCED) ${name} (${ms}ms) [${trackedTag}]`);
      } else {
        console.log(`  ok    ${name} (${ms}ms)`);
      }
    } catch (err) {
      const ms = Date.now() - startedAt;
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ name, ok: false, ms, detail, tracked: trackedTag });
      if (trackedTag) {
        // Expected failure on this lane: log with TRACKED-FAIL, not FAIL.
        console.error(`  TRACKED-FAIL [${trackedTag}] ${name} (${ms}ms): ${detail}`);
      } else {
        console.error(`  FAIL  ${name} (${ms}ms): ${detail}`);
      }
      // Swallow: the scenario is sequential and later steps assume room state
      // from earlier ones, but we still attempt them so the operator sees the
      // full failure surface. Without rethrowing, runSmokeWalkthrough proceeds.
    }
  };
}

async function openSessionPair(transport: ReturnType<typeof httpTransport>, runId: string): Promise<SmokeSessionPair> {
  let alice: SmokeSession | null = null;
  let bob: SmokeSession | null = null;
  try {
    alice = await SmokeSession.open(transport, {
      token: `guest:cf-dev-alice-${runId}`,
      label: "alice",
      clientName: `smoke-cf-dev/${runId}/alice`
    });
    bob = await SmokeSession.open(transport, {
      token: `guest:cf-dev-bob-${runId}`,
      label: "bob",
      clientName: `smoke-cf-dev/${runId}/bob`
    });
    return { alice, bob };
  } catch (err) {
    await Promise.allSettled([alice?.close(), bob?.close()]);
    throw err;
  }
}

// Spawn `wrangler dev` in its own process group so teardown can kill the whole
// tree (wrangler spawns a workerd child that a plain SIGTERM to wrangler does
// not always reap — observed during the lane's bring-up).
async function startWorkerd(port: number, persistDir: string, onMetric: (m: Metric) => void): Promise<ChildProcess> {
  const child = spawn(
    "npx",
    [
      "--no-install", "wrangler", "dev",
      "-c", "wrangler.smoke.toml",
      "--port", String(port),
      "--ip", "127.0.0.1",
      // Isolate (and reset, via the temp dir) all local DO/KV/cache state.
      "--persist-to", persistDir
    ],
    // stdout is piped so we can parse `woo.metric {json}` lines (then re-emit
    // them so the operator's view is unchanged); stderr stays inherited so the
    // wrangler banner / [wrangler:info] / worker warnings flow through normally.
    { stdio: ["ignore", "pipe", "inherit"], detached: true }
  );
  child.on("error", (err) => {
    console.error("failed to spawn wrangler dev:", err);
  });
  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      process.stdout.write(`${line}\n`);
      const marker = "woo.metric ";
      const at = line.indexOf(marker);
      if (at < 0) return;
      const brace = line.indexOf("{", at);
      if (brace < 0) return;
      try { onMetric(JSON.parse(line.slice(brace)) as Metric); } catch { /* not a metric line */ }
    });
  }
  return child;
}

async function stopWorkerd(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    // Negative pid targets the whole process group (detached spawn above).
    process.kill(-pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  // Escalate to SIGKILL if it does not exit promptly.
  const killed = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000))
  ]);
  if (!killed) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
  }
}

async function waitForHealthz(baseUrl: string): Promise<void> {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    try {
      const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(READY_POLL_MS * 4) });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        if (body && (body as { ok?: boolean }).ok) return;
        lastError = `healthz not ok: ${JSON.stringify(body)}`;
      } else {
        lastError = `healthz ${response.status}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(READY_POLL_MS);
  }
  throw new Error(`workerd did not become ready within ${READY_TIMEOUT_MS}ms (last: ${lastError})`);
}

// Race a step body against a watchdog, aborting the body when the deadline fires.
function raceWithAbort<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, message: string): Promise<T> {
  const controller = new AbortController();
  let handle: ReturnType<typeof setTimeout> | undefined;
  const workPromise = work(controller.signal);
  workPromise.catch(() => undefined);
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      const err = new Error(message);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  return Promise.race([workPromise, timeout]).finally(() => {
    if (handle) clearTimeout(handle);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bind an ephemeral port, read it back, release it. Small TOCTOU window, but the
// lane is single-tenant local dev so a collision is unlikely; --port pins it.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not find a free port"))));
    });
  });
}

function parseArgs(argv: string[]): { port?: number; runId: string; verbose: boolean; keep: boolean; measure: boolean; passes: number } {
  let port: number | undefined;
  const envPort = process.env.WOO_SMOKE_CF_DEV_PORT;
  if (envPort && Number.isFinite(Number(envPort))) port = Number(envPort);
  let runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  let verbose = false;
  let keep = false;
  let measure = false;
  let passes: number | undefined;
  for (const arg of argv) {
    if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg === "--keep") keep = true;
    else if (arg === "--measure") measure = true;
    else if (arg.startsWith("--passes=")) passes = Number(arg.slice("--passes=".length));
    else if (arg.startsWith("--port=")) port = Number(arg.slice("--port=".length));
    else if (arg.startsWith("--run-id=")) runId = arg.slice("--run-id=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: tsx scripts/smoke-cf-dev.ts [--port=<n>] [--run-id=<id>] [--verbose] [--keep] [--measure] [--passes=<n>]");
      process.exit(0);
    }
  }
  // --measure defaults to 2 passes (cold then warm); an explicit --passes wins.
  // Without --measure it is always a single gate pass.
  const resolvedPasses = measure ? (passes && passes > 0 ? Math.floor(passes) : 2) : 1;
  return { port, runId, verbose, keep, measure, passes: resolvedPasses };
}

if (isMainModule()) {
  main().catch((err) => {
    console.error("smoke-cf-dev crashed:", err instanceof Error ? err.stack ?? err.message : err);
    process.exit(2);
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}
