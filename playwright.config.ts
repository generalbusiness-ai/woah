import { defineConfig, devices } from "@playwright/test";

// Default to a port that is NOT the interactive dev server's 5173. With
// `reuseExistingServer` enabled, an e2e run on 5173 silently attaches to
// whatever long-running dev server (and stale sqlite world) happens to be
// listening there — reporting failures/passes against the wrong code
// entirely. A dedicated default port keeps `npm run test:e2e` hermetic:
// playwright boots its own dev server with a fresh per-run database. Point
// at a specific server explicitly with PORT or WOO_E2E_BASE_URL.
const PORT = Number(process.env.PORT ?? 5273);
const BASE_URL = process.env.WOO_E2E_BASE_URL ?? `http://localhost:${PORT}`;
const E2E_DB = process.env.WOO_DB ?? `.woo/e2e-${Date.now()}-${process.pid}.sqlite`;
const useExternalBaseUrl = Boolean(process.env.WOO_E2E_BASE_URL);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
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
  ],
  webServer: useExternalBaseUrl
    ? undefined
    : {
        command: "npm run dev",
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PORT: String(PORT),
          WOO_DB: E2E_DB,
          WOO_INITIAL_WIZARD_TOKEN: process.env.WOO_INITIAL_WIZARD_TOKEN ?? "e2e-wizard",
          VITE_HMR_PORT: process.env.VITE_HMR_PORT ?? String(PORT + 10_000)
        }
      }
});
