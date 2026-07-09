// SPA-over-net e2e (client-shell phase ii — the chat-first parity gate):
// the REAL production SPA (vite build of src/client/main.ts), served by
// real workerd, booted in net mode (?net=1 + a localStorage apikey),
// against the net-installed world. Two browsers prove the whole loop:
// alice types into the actual chat input; her own line renders from the
// turn reply's observations; bob's chat receives it via the presence-
// routed WS push. v2 is untouched — the same bundle serves both
// transports, selected per-page by the flag.
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { findFreePort, startWorkerd, stopWorkerd, waitReady } from "../scripts/net-smoke-harness";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..");

let base = "";
let child: ChildProcess | null = null;
let persistDir = "";
let credentials: { alice: string; bob: string } = { alice: "", bob: "" };

function exec(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) rejectPromise(new Error(`${command} ${args.join(" ")} failed: ${error.message}\n${stderr.slice(0, 2000)}`));
      else resolvePromise(stdout);
    });
  });
}

test.beforeAll(async () => {
  test.setTimeout(360_000);

  // 1. The REAL SPA bundle (what deploys serve): vite build → dist/.
  await exec("npx", ["--no-install", "vite", "build"]);

  // 2. Real workerd on the smoke config, serving dist from the same
  //    origin (asset paths never shadow /net-api routes).
  const port = await findFreePort();
  base = `http://127.0.0.1:${port}`;
  persistDir = mkdtempSync(join(tmpdir(), "woo-net-spa-e2e-"));
  child = startWorkerd(port, persistDir, {}, { extraArgs: ["--assets", join(ROOT, "dist")] });
  await waitReady(base);

  // 3. Install the world + carried identity through the production
  //    doorway (tsx subprocess — engine imports cannot load under the
  //    Playwright loader; see e2e/net-spa-fixture.ts).
  const stdout = await exec("npx", ["--no-install", "tsx", join(HERE, "net-spa-fixture.ts"), base]);
  credentials = JSON.parse(stdout.trim().split("\n").at(-1) as string) as { alice: string; bob: string };
  expect(credentials.alice).toContain("apikey:");
});

test.afterAll(async () => {
  if (child) await stopWorkerd(child);
  if (persistDir) {
    try {
      rmSync(persistDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

async function openSpa(page: Page, apiKey: string): Promise<void> {
  await page.addInitScript((key: string) => {
    localStorage.setItem("woo:net:apikey", key);
  }, apiKey);
  await page.goto(`${base}/?net=1`);
  // The chat input renders once the shell boots in net mode; sends
  // unlock when the feed reports open.
  await expect(page.locator("[data-chat-input]")).toBeVisible({ timeout: 30_000 });
}

test("the real SPA over the net path: alice's chat line reaches bob's browser", async ({ browser }) => {
  test.setTimeout(120_000);
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const alice = await contextA.newPage();
  const bob = await contextB.newPage();
  await openSpa(alice, credentials.alice);
  await openSpa(bob, credentials.bob);

  const text = `net-spa-hello-${Date.now().toString(36)}`;
  const input = alice.locator("[data-chat-input]");
  await input.click();
  await input.fill(`say ${text}`);
  await input.press("Enter");

  // Self view: the committed turn's own observations render her line.
  await expect(alice.locator(".chat-feed")).toContainText(text, { timeout: 20_000 });
  // Peer view: presence-routed WS push into bob's reducer-driven chat.
  await expect(bob.locator(".chat-feed")).toContainText(text, { timeout: 20_000 });

  await contextA.close();
  await contextB.close();
});
