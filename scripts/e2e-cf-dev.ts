#!/usr/bin/env tsx
// e2e-cf-dev — Playwright browser e2e lane against real workerd.
//
// Boots the REAL worker entry in REAL workerd via `wrangler dev`
// (wrangler.cf-e2e.toml, which adds [assets] to serve the pre-built SPA)
// then runs the Playwright spec e2e/cf-smoke.spec.ts against it.
//
// Unlike the smoke:cf-dev MCP lane, this lane connects a real browser (Playwright
// Chromium) to the worker over the same HTTP + WebSocket origin, so the client's
// `v2BrowserWebSocketUrl` resolves against window.location.host and lands on the
// real workerd process with no CORS or proxy.
//
// Serving design: wrangler.cf-e2e.toml adds [assets] binding pointing to ./dist.
// The Worker entry already calls env.ASSETS.fetch for non-API paths
// (src/worker/index.ts), so the built SPA is served from the same origin as the
// API/WS routes. run_worker_first=true ensures API routes are never swallowed by
// the SPA fallback.
//
// Usage:
//   npm run e2e:cf -- [--port=<n>] [--keep] [--verbose]
//
// The script:
//   1. Builds the SPA (npm run build) — always rebuilt so the lane never tests
//      a stale bundle.
//   2. Starts wrangler dev with a fresh temp persist dir (hermetic cold boot).
//   3. Waits for /healthz to become ready.
//   4. Runs `playwright test --config playwright.cf-e2e.config.ts`.
//   5. Tears down wrangler and removes the temp dir.
//
// Exit status: 0 all specs pass, 1 specs fail, 2 harness crash.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// How long to wait for `wrangler dev` to build + boot + first-light.
// Longer than smoke:cf-dev because the first request also triggers catalog
// auto-install AND wrangler must compile the worker with the ASSETS binding.
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 500;

const args = parseArgs(process.argv.slice(2));

async function main(): Promise<void> {
  const port = args.port ?? (await findFreePort());
  const baseUrl = `http://127.0.0.1:${port}`;

  // Step 1: build the SPA. Always build so the lane is never testing a stale
  // bundle. This is cheap relative to workerd boot + catalog auto-install.
  console.log("e2e:cf building SPA bundle (npm run build)...");
  await runCommand("npm", ["run", "build"], ROOT);
  console.log("  ok    SPA bundle built");

  // Step 2: per-run isolated persistence. A fresh temp dir forces a true cold
  // boot every run, so the lane never passes against a world bootstrapped by a
  // prior run. This mirrors the hermeticity guarantee in smoke:cf-dev.
  const persistDir = mkdtempSync(join(tmpdir(), "woo-e2e-cf-dev-"));
  console.log(`e2e:cf booting wrangler dev on ${baseUrl} (persist=${persistDir})`);

  const server = await startWorkerd(port, persistDir);
  let playwrightExitCode = 1;
  let crashed: unknown = null;

  try {
    await waitForHealthz(baseUrl);
    console.log(`  ok    workerd ready (${baseUrl}/healthz)`);

    // Step 3: run Playwright against the live workerd. Pass the worker's base
    // URL as WOO_CF_E2E_BASE_URL so the Playwright config can forward it to the
    // browser.
    playwrightExitCode = await runPlaywright(baseUrl, args.verbose);
  } catch (err) {
    crashed = err;
  } finally {
    if (!args.keep) {
      await stopWorkerd(server);
      try { rmSync(persistDir, { recursive: true, force: true }); } catch { /* best effort */ }
    } else {
      console.log(`  --keep set; leaving wrangler dev running on ${baseUrl} (pid ${server.pid}, persist=${persistDir})`);
    }
  }

  if (crashed) {
    console.error("e2e-cf-dev harness error:", crashed instanceof Error ? crashed.stack ?? crashed.message : crashed);
    process.exit(2);
  }
  process.exit(playwrightExitCode);
}

// Spawn `wrangler dev` using wrangler.cf-e2e.toml which adds the [assets] block.
// Same detached-process-group pattern as smoke-cf-dev.ts so teardown can kill
// the full tree (wrangler spawns a workerd child).
async function startWorkerd(port: number, persistDir: string): Promise<ChildProcess> {
  const child = spawn(
    "npx",
    [
      "--no-install", "wrangler", "dev",
      "-c", "wrangler.cf-e2e.toml",
      "--port", String(port),
      "--ip", "127.0.0.1",
      "--persist-to", persistDir
    ],
    {
      stdio: ["ignore", "pipe", "inherit"],
      detached: true,
      cwd: ROOT
    }
  );
  child.on("error", (err) => {
    console.error("failed to spawn wrangler dev:", err);
  });
  // Re-emit stdout so the operator can see wrangler build/boot messages.
  if (child.stdout) {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => process.stdout.write(`${line}\n`));
  }
  return child;
}

async function stopWorkerd(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
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

// Run `playwright test` with the CF-specific config, forwarding the workerd
// base URL as an env var so the Playwright config can pass it as baseURL.
async function runPlaywright(baseUrl: string, verbose: boolean): Promise<number> {
  const playwrightArgs = [
    "--no-install", "playwright", "test",
    "--config", "playwright.cf-e2e.config.ts"
  ];
  if (verbose) playwrightArgs.push("--reporter=list");
  console.log(`e2e:cf running playwright (baseUrl=${baseUrl})`);
  return new Promise<number>((resolve) => {
    const child = spawn("npx", playwrightArgs, {
      stdio: "inherit",
      cwd: ROOT,
      env: {
        ...process.env,
        // The Playwright config reads this to set baseURL and skip the webServer
        // block (workerd is already running; no vite dev server is needed).
        WOO_CF_E2E_BASE_URL: baseUrl
      }
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      console.error("playwright spawn error:", err);
      resolve(1);
    });
  });
}

// Run a command and resolve when it exits 0, reject on non-zero.
function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function parseArgs(argv: string[]): { port?: number; keep: boolean; verbose: boolean } {
  let port: number | undefined;
  let keep = false;
  let verbose = false;
  for (const arg of argv) {
    if (arg === "--keep") keep = true;
    else if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg.startsWith("--port=")) port = Number(arg.slice("--port=".length));
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: tsx scripts/e2e-cf-dev.ts [--port=<n>] [--keep] [--verbose]");
      process.exit(0);
    }
  }
  return { port, keep, verbose };
}

if (isMainModule()) {
  main().catch((err) => {
    console.error("e2e-cf-dev crashed:", err instanceof Error ? err.stack ?? err.message : err);
    process.exit(2);
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}
