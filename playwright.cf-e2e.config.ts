// Playwright config for the browser-against-workerd CF e2e lane (npm run e2e:cf).
//
// Invoked by scripts/e2e-cf-dev.ts, which:
//   1. Builds the SPA (npm run build).
//   2. Boots wrangler dev with wrangler.cf-e2e.toml (real workerd + assets).
//   3. Waits for /healthz, then runs playwright with this config.
//   4. Tears down workerd and the temp persist dir.
//
// The base URL is forwarded as WOO_CF_E2E_BASE_URL by the launch script.
// No webServer block: workerd is already running when playwright starts.
//
// This config is NOT part of npm test (the default fast gate). It is a slow
// lane registered alongside smoke:cf-dev; run it before CF deploys that touch
// the browser client, the WS path, or the optimistic-execution path.
// When to run: see notes/2026-06-09-d3a-browser-cf-lane.md §When to run.

import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.WOO_CF_E2E_BASE_URL;
if (!BASE_URL) {
  throw new Error(
    "playwright.cf-e2e.config.ts: WOO_CF_E2E_BASE_URL is not set.\n" +
    "Run via `npm run e2e:cf` (scripts/e2e-cf-dev.ts) which sets this from the workerd port.\n" +
    "Do not invoke this config directly — the launch script manages the workerd lifecycle."
  );
}

export default defineConfig({
  // Only the CF smoke spec. The default e2e/ specs target the vite dev server
  // and must NOT run here (they would try to hit the vite server, which is not
  // running in this lane).
  testDir: "./e2e",
  testMatch: "**/cf-smoke.spec.ts",
  // Cold workerd boot + catalog auto-install can take tens of seconds; give
  // individual tests enough headroom. The launch script already ensured
  // /healthz is ready before playwright starts, so this timeout covers the
  // first test's within-workerd latency only.
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  ]
  // No webServer block: the workerd is already running (managed by e2e-cf-dev.ts).
});
