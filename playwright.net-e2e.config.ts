// Playwright config for the NetFeed browser e2e lane (npm run e2e:net;
// Plan 002 Phase 4 item 5).
//
// UNLIKE playwright.cf-e2e.config.ts there is no launch script and no
// webServer block: e2e/net-feed.spec.ts manages its OWN wrangler-dev
// lifecycle in beforeAll/afterAll (the scripts/net-smoke-harness.ts
// spawn/ready/teardown idioms), binding a free port at runtime — so no
// baseURL exists at config time and the spec navigates by absolute URL.
//
// This lane is NOT part of npm test (browser-spawning lanes are explicit,
// like e2e:cf and test:e2e). The default playwright.config.ts ignores
// net-feed.spec.ts for the same reason.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["**/net-feed.spec.ts", "**/net-spa.spec.ts"],
  // Covers in-test workerd latency only; the expensive boot + seed happens
  // in beforeAll, which sets its own timeout.
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
