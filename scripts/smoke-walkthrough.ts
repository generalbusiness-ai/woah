#!/usr/bin/env tsx
// smoke-walkthrough — comprehensive two-actor walkthrough against a deployed
// woah worker over MCP HTTP. The ordered steps and their cross-actor
// assertions live in the shared scenario (scripts/smoke/scenario.ts); this file
// owns only the DEPLOYED-LANE policy: HTTP sessions, a step runner with a
// watchdog + result recording + session reset, and a timeout-cascade halt.
//
// The same scenario also runs against the in-process fake DO
// (tests/worker/cf-local-walkthrough.test.ts) and against a local `wrangler dev`
// workerd (scripts/smoke-cf-dev.ts). One scenario, three transports — so the
// local lanes provably cover exactly what this deployed lane covers.
//
// Usage:
//   npm run smoke:walkthrough -- [--base=<url>] [--run-id=<id>] [--verbose]
//
// Defaults:
//   --base    https://woah1.generalbusiness.ai (or $WOO_SMOKE_BASE_URL)
//   --run-id  <timestamp>-<rand>
//
// Exit status: 0 if every step passes, 1 if any step fails. The run keeps going
// after a failed step (resetting sessions) so a single broken slice doesn't mask
// later problems, but halts after a sustained timeout cascade.

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { httpTransport, SmokeSession } from "./smoke/session";
import { runSmokeWalkthrough, type SmokeSessionPair, type StepContext } from "./smoke/scenario";

type StepResult = { name: string; ok: boolean; ms: number; detail?: string };
type SessionPair = SmokeSessionPair & { generation: number };

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.base.replace(/\/+$/, "");
const runId = args.runId;
const verbose = args.verbose;
const transport = httpTransport(baseUrl);

const results: StepResult[] = [];

// Once the gateway is timeout-saturated, every subsequent step times out and so
// does its session reset, polluting the run with misleading secondary errors.
// Halt after this many CONSECUTIVE timeout-class step failures so the run
// isolates the primary wall. A single cold-start transient is tolerated.
const CASCADE_HALT_THRESHOLD = 2;
let consecutiveTimeouts = 0;

// A failure whose message indicates a deadline/abort rather than a real protocol
// error — the signature of gateway saturation.
export function isTimeoutDetail(detail: string | undefined): boolean {
  if (!detail) return false;
  return /timed out after|exceeded \d+ms|watchdog|deadline|aborted/i.test(detail);
}

// Thrown to abort the remaining walkthrough once the timeout cascade threshold
// is reached. Caught in main so the summary still prints.
export class SmokeCascadeHalt extends Error {
  constructor(public readonly count: number) {
    super(`halted after ${count} consecutive timeout-class failures`);
    this.name = "SmokeCascadeHalt";
  }
}

async function main(): Promise<void> {
  console.log(`smoke-walkthrough base=${baseUrl} run=${runId}`);
  // `clientInfo.name` carries the run id and lands in MCP request logs as
  // `client_info.name`, so a tail can scope to exactly this invocation:
  console.log(`wrangler tail filter: clientInfo name = smoke-walkthrough/${runId}/<actor>`);

  let sessions: SessionPair | null = null;
  let halted: SmokeCascadeHalt | null = null;
  try {
    sessions = await openSessionPair(0);
    await runSmokeWalkthrough(sessions, makeStepRunner(sessions), {
      runId,
      includeTakeDrop: true,
      waitTimeoutMs: 10_000,
      log: verbose ? (msg) => console.log(msg) : undefined
    });
  } catch (err) {
    // A cascade halt is an intentional early stop, not a harness crash.
    if (err instanceof SmokeCascadeHalt) {
      halted = err;
      console.error(`  HALT  ${err.message}; remaining steps not attempted (gateway timeout-saturated)`);
    } else {
      throw err;
    }
  } finally {
    await closeSessionPair(sessions);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log();
  const haltNote = halted ? ` (HALTED after ${halted.count} consecutive timeouts; remaining steps not attempted)` : "";
  console.log(`summary: ${passed}/${results.length} steps attempted passed${failed ? `, ${failed} failed` : ""}${haltNote}`);
  if (failed > 0) {
    for (const r of results.filter((r) => !r.ok)) console.error(`  FAIL ${r.name}: ${r.detail ?? "(no detail)"}`);
    process.exit(1);
  }
}

// Build the deployed-lane step runner: watchdog-bounded, result-recording, with
// session reset + cascade halt on failure. The scenario invokes this for every
// step and reads `sessions.alice/bob` fresh, so a reset between steps is
// transparent to the scenario.
function makeStepRunner(sessions: SessionPair) {
  return async (name: string, body: (ctx: StepContext) => Promise<void>): Promise<void> => {
    const ok = await runStep(name, (signal) => body({ signal }));
    if (ok) {
      consecutiveTimeouts = 0;
      return;
    }
    const last = results[results.length - 1];
    let timeoutFailure = isTimeoutDetail(last?.detail);
    try {
      await resetSessionPair(sessions, name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  WARN  session reset after "${name}" failed: ${msg}`);
      if (isTimeoutDetail(msg)) timeoutFailure = true;
    }
    consecutiveTimeouts = timeoutFailure ? consecutiveTimeouts + 1 : 0;
    if (consecutiveTimeouts >= CASCADE_HALT_THRESHOLD) {
      throw new SmokeCascadeHalt(consecutiveTimeouts);
    }
  };
}

async function openSessionPair(generation: number): Promise<SessionPair> {
  const suffix = generation === 0 ? "" : `-recovery-${generation}`;
  let alice: SmokeSession | null = null;
  let bob: SmokeSession | null = null;
  try {
    alice = await SmokeSession.open(transport, {
      token: `guest:walkthrough-alice-${runId}${suffix}`,
      label: `alice${suffix}`,
      clientName: `smoke-walkthrough/${runId}/alice${suffix}`
    });
    bob = await SmokeSession.open(transport, {
      token: `guest:walkthrough-bob-${runId}${suffix}`,
      label: `bob${suffix}`,
      clientName: `smoke-walkthrough/${runId}/bob${suffix}`
    });
    return { alice, bob, generation };
  } catch (err) {
    await Promise.allSettled([alice?.close(), bob?.close()]);
    throw err;
  }
}

async function closeSessionPair(pair: SessionPair | null): Promise<void> {
  if (!pair) return;
  await Promise.allSettled([pair.alice.close(), pair.bob.close()]);
}

// Replace both sessions after a failed step and re-enter the chatroom so the
// next step starts from a known room. Mutates `pair` in place — the scenario
// holds the same reference and reads the new sessions on its next step.
async function resetSessionPair(pair: SessionPair, failedStep: string): Promise<void> {
  const nextGeneration = pair.generation + 1;
  console.warn(`  WARN  resetting MCP sessions after failed step "${failedStep}"`);
  await closeSessionPair(pair);
  const next = await openSessionPair(nextGeneration);
  pair.alice = next.alice;
  pair.bob = next.bob;
  pair.generation = nextGeneration;
  try {
    await pair.alice.call("the_chatroom", "enter", []);
    await pair.bob.call("the_chatroom", "enter", []);
  } catch (err) {
    await closeSessionPair(pair);
    throw err;
  }
}

// Step-level watchdog. Even with a per-RPC deadline, a step that loops over many
// short calls could drift long. Deployed setup steps bundle several cross-shard
// movement/entry calls, so the envelope is larger than the 20s per-RPC guard.
const STEP_TIMEOUT_MS = positiveIntEnv("WOO_SMOKE_STEP_TIMEOUT_MS", 120_000);
async function runStep(name: string, body: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
  const startedAt = Date.now();
  try {
    await raceWithAbort(body, STEP_TIMEOUT_MS, `step "${name}" exceeded ${STEP_TIMEOUT_MS}ms watchdog`);
    const ms = Date.now() - startedAt;
    results.push({ name, ok: true, ms });
    console.log(`  ok    ${name} (${ms}ms)`);
    return true;
  } catch (err) {
    const ms = Date.now() - startedAt;
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, ms, detail });
    console.error(`  FAIL  ${name} (${ms}ms): ${detail}`);
    return false;
  }
}

export async function raceWithAbort<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const workPromise = work(controller.signal);
  workPromise.catch(() => undefined);
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      const err = new Error(message);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  return await Promise.race([workPromise, timeout]).finally(() => {
    if (handle) clearTimeout(handle);
  });
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseArgs(argv: string[]): { base: string; runId: string; verbose: boolean } {
  let base = process.env.WOO_SMOKE_BASE_URL ?? "https://woah1.generalbusiness.ai";
  let runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  let verbose = false;
  for (const arg of argv) {
    if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg.startsWith("--base=")) base = arg.slice("--base=".length);
    else if (arg.startsWith("--run-id=")) runId = arg.slice("--run-id=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: tsx scripts/smoke-walkthrough.ts [--base=<url>] [--run-id=<id>] [--verbose]");
      process.exit(0);
    }
  }
  return { base, runId, verbose };
}

if (isMainModule()) {
  main().catch((err) => {
    console.error("walkthrough crashed:", err instanceof Error ? err.stack ?? err.message : err);
    process.exit(2);
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}
