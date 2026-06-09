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
//
// Exit status: 0 if every step passes, 1 if any step fails, 2 on harness crash
// (e.g. workerd never became ready).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { httpTransport, SmokeSession } from "./smoke/session";
import { runSmokeWalkthrough, type SmokeSessionPair, type StepContext } from "./smoke/scenario";

type StepResult = { name: string; ok: boolean; ms: number; detail?: string };

const args = parseArgs(process.argv.slice(2));

// How long to wait for `wrangler dev` to build + boot + first-light the demo
// world (auto-install of the bundled catalogs runs on the first cold request).
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 500;
// Generous step watchdog: cold workerd DO instantiation on first touch is real
// here (unlike the fake), so individual steps can run several seconds.
const STEP_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const port = args.port ?? (await findFreePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const runId = args.runId;
  const results: StepResult[] = [];

  // Per-run, isolated persistence. `wrangler dev` otherwise reuses its default
  // .wrangler/state, so the gate could pass against a world bootstrapped by an
  // earlier run and SKIP the cold first-light path (catalog auto-install, KV
  // host-seed, DO migrations) — exactly the regressions this lane exists to
  // catch. A fresh temp dir per run forces a true cold boot every time.
  const persistDir = mkdtempSync(join(tmpdir(), "woo-smoke-cf-dev-"));
  console.log(`smoke-cf-dev booting wrangler dev on ${baseUrl} (run=${runId}, persist=${persistDir})`);
  const server = await startWorkerd(port, persistDir);
  let crashed: unknown = null;
  try {
    await waitForHealthz(baseUrl);
    console.log(`  ok    workerd ready (${baseUrl}/healthz)`);

    const transport = httpTransport(baseUrl);
    const pair = await openSessionPair(transport, runId);
    try {
      await runSmokeWalkthrough(pair, makeStepRunner(results), {
        runId,
        // The workerd lane is a faithful local CF, so it runs the FULL coverage:
        // take/drop fanout AND the concurrent-through-shared-destination step.
        // (Unlike the fake lane, it has no dangling_parent_ref==0 ratchet, so
        // take/drop on a $portable object is fine here.)
        includeTakeDrop: true,
        includeConcurrentMove: true,
        waitTimeoutMs: 10_000,
        log: args.verbose ? (msg) => console.log(msg) : undefined
      });
    } finally {
      await Promise.allSettled([pair.alice.close(), pair.bob.close()]);
    }
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

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log();
  console.log(`summary: ${passed}/${results.length} steps passed${failed ? `, ${failed} failed` : ""}`);
  for (const r of results.filter((r) => !r.ok)) console.error(`  FAIL ${r.name}: ${r.detail ?? "(no detail)"}`);
  if (crashed) {
    console.error("smoke-cf-dev harness error:", crashed instanceof Error ? crashed.stack ?? crashed.message : crashed);
    process.exit(2);
  }
  process.exit(failed > 0 ? 1 : 0);
}

// Continue-on-failure step runner: record every step, never reset sessions
// (local workerd is deterministic — a failure is a real bug to surface, not a
// flake to recover from), and watchdog-bound each step.
function makeStepRunner(results: StepResult[]) {
  return async (name: string, body: (ctx: StepContext) => Promise<void>): Promise<void> => {
    const startedAt = Date.now();
    try {
      await raceWithAbort((signal) => body({ signal }), STEP_TIMEOUT_MS, `step "${name}" exceeded ${STEP_TIMEOUT_MS}ms watchdog`);
      const ms = Date.now() - startedAt;
      results.push({ name, ok: true, ms });
      console.log(`  ok    ${name} (${ms}ms)`);
    } catch (err) {
      const ms = Date.now() - startedAt;
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ name, ok: false, ms, detail });
      console.error(`  FAIL  ${name} (${ms}ms): ${detail}`);
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
async function startWorkerd(port: number, persistDir: string): Promise<ChildProcess> {
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
    { stdio: ["ignore", "inherit", "inherit"], detached: true }
  );
  child.on("error", (err) => {
    console.error("failed to spawn wrangler dev:", err);
  });
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

function parseArgs(argv: string[]): { port?: number; runId: string; verbose: boolean; keep: boolean } {
  let port: number | undefined;
  const envPort = process.env.WOO_SMOKE_CF_DEV_PORT;
  if (envPort && Number.isFinite(Number(envPort))) port = Number(envPort);
  let runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  let verbose = false;
  let keep = false;
  for (const arg of argv) {
    if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg === "--keep") keep = true;
    else if (arg.startsWith("--port=")) port = Number(arg.slice("--port=".length));
    else if (arg.startsWith("--run-id=")) runId = arg.slice("--run-id=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: tsx scripts/smoke-cf-dev.ts [--port=<n>] [--run-id=<id>] [--verbose] [--keep]");
      process.exit(0);
    }
  }
  return { port, runId, verbose, keep };
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
