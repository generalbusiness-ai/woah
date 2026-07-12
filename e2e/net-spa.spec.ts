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
const legacyRequests = new WeakMap<Page, string[]>();

/** Net-mode deletion gate: a successful UI assertion is insufficient when
 * failed v2 fetches are caught as best-effort hydration. Record every legacy
 * request so each browser proves the net shell is actually v2-independent. */
function trackLegacyRequests(page: Page): void {
  const seen: string[] = [];
  legacyRequests.set(page, seen);
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/connect" || pathname.startsWith("/api/") || pathname.startsWith("/v2/")) seen.push(`${request.method()} ${pathname}`);
  });
}

function expectNoLegacyRequests(...pages: Page[]): void {
  for (const page of pages) expect(legacyRequests.get(page) ?? []).toEqual([]);
}

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
  // WOO_NET_DEFAULT: the deployment-controlled transport default
  // (reviewer finding 4) — the bare-/ door test depends on it; the
  // explicit ?net=1 tests are unaffected by it.
  child = startWorkerd(port, persistDir, { WOO_NET_DEFAULT: "1" }, { extraArgs: ["--assets", join(ROOT, "dist")] });
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
  trackLegacyRequests(page);
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
  expectNoLegacyRequests(alice, bob);

  await contextA.close();
  await contextB.close();
});

test("the route switch selects the net client: bare `/` with empty storage reaches the door (finding 4)", async ({ browser }) => {
  test.setTimeout(60_000);
  // The exact first-time-user shape after DNS movement: no query flag,
  // no localStorage — the deployment default (WOO_NET_DEFAULT) must
  // boot the NET client, whose unauthenticated state is the door (the
  // v2 shell would instead try /api/me and its own guest flow).
  const context = await browser.newContext();
  const page = await context.newPage();
  trackLegacyRequests(page);
  await page.goto(`${base}/`);
  await expect(page.locator("[data-login-guest]")).toBeVisible({ timeout: 30_000 });
  // Prove it is the NET door, end-to-end: the guest button claims a pool
  // seat through /net-api/guest and chat boots on the session bearer.
  await page.locator("[data-login-guest]").click();
  await expect(page.locator("[data-chat-input]")).toBeVisible({ timeout: 30_000 });
  expectNoLegacyRequests(page);
  await context.close();
});

test("the identity door: guest entry and password sign-in in real browsers, no stored apikey", async ({ browser }) => {
  test.setTimeout(120_000);

  // GUEST: a fresh context with NO credential lands on the login card;
  // "Continue as guest" claims a pool seat through /net-api/guest and
  // the chat shell boots on the minted session bearer.
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  trackLegacyRequests(guest);
  await guest.goto(`${base}/?net=1`);
  await expect(guest.locator("[data-login-guest]")).toBeVisible({ timeout: 30_000 });
  await guest.locator("[data-login-guest]").click();
  await expect(guest.locator("[data-chat-input]")).toBeVisible({ timeout: 30_000 });
  const guestLine = `door-guest-${Date.now().toString(36)}`;
  await guest.locator("[data-chat-input]").fill(`say ${guestLine}`);
  await guest.locator("[data-chat-input]").press("Enter");
  await expect(guest.locator(".chat-feed")).toContainText(guestLine, { timeout: 20_000 });

  // PASSWORD: carol signs in with her carried email/password (the §8
  // human path — PBKDF2 verify at the gateway, primary_actor rebuilt by
  // the import) and her chat works on the door session.
  const carolContext = await browser.newContext();
  const carol = await carolContext.newPage();
  trackLegacyRequests(carol);
  await carol.goto(`${base}/?net=1`);
  await expect(carol.locator('[data-login-form] input[name="username"]')).toBeVisible({ timeout: 30_000 });
  await carol.locator('[data-login-form] input[name="username"]').fill("carol@example.com");
  await carol.locator('[data-login-form] input[name="password"]').fill("carols-real-password");
  await carol.locator(".login-submit").click();
  await expect(carol.locator("[data-chat-input]")).toBeVisible({ timeout: 30_000 });
  const carolLine = `door-carol-${Date.now().toString(36)}`;
  await carol.locator("[data-chat-input]").fill(`say ${carolLine}`);
  await carol.locator("[data-chat-input]").press("Enter");
  await expect(carol.locator(".chat-feed")).toContainText(carolLine, { timeout: 20_000 });

  // A WRONG password stays on the card with the fail-closed message.
  const malloryContext = await browser.newContext();
  const mallory = await malloryContext.newPage();
  trackLegacyRequests(mallory);
  await mallory.goto(`${base}/?net=1`);
  await expect(mallory.locator('[data-login-form] input[name="username"]')).toBeVisible({ timeout: 30_000 });
  await mallory.locator('[data-login-form] input[name="username"]').fill("carol@example.com");
  await mallory.locator('[data-login-form] input[name="password"]').fill("not-her-password");
  await mallory.locator(".login-submit").click();
  await expect(mallory.locator(".login-error")).toContainText("invalid email or password", { timeout: 20_000 });
  expectNoLegacyRequests(guest, carol, mallory);

  await guestContext.close();
  await carolContext.close();
  await malloryContext.close();
});

test("tool-space panels over net: alice's pinboard note renders on bob's board (phase iii)", async ({ browser }) => {
  test.setTimeout(120_000);
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const alice = await contextA.newPage();
  const bob = await contextB.newPage();
  await openSpa(alice, credentials.alice);
  await openSpa(bob, credentials.bob);

  // Opening the tab moves the actor into the board over the net turn
  // path (enterPinboard → moveActorToToolSpace → netTurn); the create
  // form is presence-gated, so its appearance proves the move committed
  // AND the presence observation reduced into the projection.
  for (const page of [alice, bob]) {
    await page.locator('[data-tab="pinboard"]').click();
    await expect(page.locator("[data-pinboard-create]")).toBeVisible({ timeout: 30_000 });
  }

  const text = `net-pin-${Date.now().toString(36)}`;
  await alice.locator("[data-pinboard-new-text]").fill(text);
  await alice.locator("[data-pinboard-create] button").click();

  // Self view: the turn reply's note_added reduces through wireNetFeed.
  await expect(alice.locator(".pin-note textarea")).toHaveValue(text, { timeout: 20_000 });
  // Peer view: the presence-routed fanout frame reduces on bob's board —
  // the cross-user tool-space class that motivated phase iii.
  await expect(bob.locator(".pin-note textarea")).toHaveValue(text, { timeout: 20_000 });
  expectNoLegacyRequests(alice, bob);

  await contextA.close();
  await contextB.close();
});
