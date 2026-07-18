// Browser acceptance for the literal default local composition. The spec owns
// two `npm run dev` lifecycles because persisted restart is the behavior under
// test; a Playwright webServer block cannot express that boundary honestly.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/net-dev-lifecycle.spec.ts",
  timeout: 300_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
