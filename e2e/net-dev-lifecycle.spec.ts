// Default-localdev deletion gate (classic-to-Net matrix F6).
//
// This deliberately launches the public `npm run dev` command instead of
// importing startNetDevBackend or starting wrangler directly. The composition
// boundary is the feature: first-install, Vite proxying, the Net identity door,
// browser operation, process shutdown, and persisted workerd restart must work
// together before the classic dev host can be deleted.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

type DevProcess = {
  child: ChildProcess;
  output: string[];
};

function startDefaultDev(port: number, persistDir: string): DevProcess {
  const output: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    WOO_NET_DEV_PERSIST: persistDir,
    WOO_NET_DEV_APIKEY: "apikey:e2e-net-dev:e2e-net-dev-secret",
    WOO_INTERNAL_SECRET: "e2e-net-dev-internal-secret"
  };
  // These belong to the classic or externally-targeted Playwright
  // compositions. Inheriting one would make this gate depend on the caller's
  // shell instead of the documented default-localdev contract.
  delete env.WOO_DB;
  delete env.WOO_E2E_BASE_URL;
  delete env.WOO_AUTO_INSTALL_CATALOGS;

  const child = spawn("npm", ["run", "dev"], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const record = (chunk: unknown): void => {
    output.push(String(chunk));
    if (output.length > 200) output.splice(0, output.length - 200);
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  child.on("error", (error) => record(error.stack ?? error.message));
  return { child, output };
}

async function waitForDefaultDev(baseUrl: string, handle: DevProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      throw new Error(`npm run dev exited before readiness:\n${handle.output.join("").slice(-8_000)}`);
    }
    try {
      const health = await fetch(`${baseUrl}/healthz`);
      const shell = await fetch(`${baseUrl}/`);
      if (health.ok && shell.ok) return;
    } catch {
      // First install completes before Vite binds, so connection refusal is
      // expected while workerd and the catalog plan are coming up.
    }
    if (Date.now() >= deadline) {
      throw new Error(`npm run dev was not browser-ready within 120s:\n${handle.output.join("").slice(-8_000)}`);
    }
    await delay(250);
  }
}

async function stopDefaultDev(handle: DevProcess | null): Promise<void> {
  const child = handle?.child;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<boolean>((resolvePromise) => child.once("exit", () => resolvePromise(true)));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const graceful = await Promise.race([exited, delay(10_000).then(() => false)]);
  if (graceful) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await Promise.race([exited, delay(5_000)]);
}

function findFreePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPromise(new Error("could not allocate a default-localdev port"));
        return;
      }
      server.close(() => resolvePromise(address.port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

test("npm run dev installs for a fresh browser and preserves its world across restart", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tempRoot = mkdtempSync(join(tmpdir(), "woo-net-default-e2e-"));
  const persistDir = join(tempRoot, "world");
  const context = await browser.newContext();
  const page = await context.newPage();
  const legacyRequests: string[] = [];
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/connect" || pathname.startsWith("/api/") || pathname.startsWith("/v2/")) {
      legacyRequests.push(`${request.method()} ${pathname}`);
    }
  });
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  });

  let dev: DevProcess | null = null;
  try {
    // First launch: even the persistence directory is absent. The command must
    // create, install, and activate it before exposing the browser.
    dev = startDefaultDev(port, persistDir);
    await waitForDefaultDev(baseUrl, dev);
    await page.goto(`${baseUrl}/`);
    await expect(page.locator("[data-login-guest]")).toBeVisible({ timeout: 30_000 });
    await page.locator("[data-login-guest]").click();
    await expect(page.locator("[data-chat-input]")).toBeVisible({ timeout: 30_000 });

    // Commit a unique durable artifact through the real catalog UI. A visible
    // shell alone would not prove that the installed world can accept writes.
    await page.getByRole("button", { name: "Pinboard", exact: true }).click();
    await expect(page.locator("[data-pinboard-create]")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".toolbar h1")).toHaveText("Pinboard", { timeout: 30_000 });
    const noteText = `default-dev-restart-${Date.now().toString(36)}`;
    await page.locator("[data-pinboard-new-text]").fill(noteText);
    await page.locator("[data-pinboard-create] button").click();
    await expect(page.locator("[data-pin-note-text]")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator("[data-pin-note-text]")).toHaveValue(noteText);
    const firstRunScreenshot = testInfo.outputPath("default-dev-first-run.png");
    await page.screenshot({ path: firstRunScreenshot, fullPage: true });
    await testInfo.attach("default-dev-first-run", { path: firstRunScreenshot, contentType: "image/png" });

    // Stop the entire public composition, not just its worker child. The
    // second literal launch must accept the same catalog epoch and API key,
    // recover the DO namespace, and serve the existing browser identity.
    await stopDefaultDev(dev);
    dev = null;
    dev = startDefaultDev(port, persistDir);
    await waitForDefaultDev(baseUrl, dev);
    await page.goto(`${baseUrl}/`);
    await expect(page.locator("[data-chat-input]")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Pinboard", exact: true }).click();
    await expect(page.locator("[data-pinboard-create]")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".toolbar h1")).toHaveText("Pinboard", { timeout: 30_000 });
    await expect(page.locator("[data-pin-note-text]")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator("[data-pin-note-text]")).toHaveValue(noteText);

    expect(legacyRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(serverErrors).toEqual([]);
    const restartScreenshot = testInfo.outputPath("default-dev-persisted-restart.png");
    await page.screenshot({ path: restartScreenshot, fullPage: true });
    await testInfo.attach("default-dev-persisted-restart", { path: restartScreenshot, contentType: "image/png" });
  } finally {
    await stopDefaultDev(dev);
    await context.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
