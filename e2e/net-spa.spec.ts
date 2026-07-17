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

async function openGuestSpa(page: Page): Promise<void> {
  trackLegacyRequests(page);
  await page.goto(`${base}/?net=1`);
  await expect(page.locator("[data-login-guest]")).toBeVisible({ timeout: 30_000 });
  await page.locator("[data-login-guest]").click();
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

test("the submitting browser renders take and drop acknowledgements exactly once", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  await openSpa(page, credentials.alice);

  const input = page.locator("[data-chat-input]");
  await input.fill("get mug");
  await input.press("Enter");
  await expect(page.getByText("You take Mug.", { exact: true })).toHaveCount(1, { timeout: 30_000 });
  await page.waitForTimeout(1_000);
  await expect(page.getByText("You take Mug.", { exact: true })).toHaveCount(1);

  await input.fill("drop mug");
  await input.press("Enter");
  await expect(page.getByText("You drop Mug.", { exact: true })).toHaveCount(1, { timeout: 30_000 });
  await page.waitForTimeout(1_000);
  await expect(page.getByText("You drop Mug.", { exact: true })).toHaveCount(1);
  expectNoLegacyRequests(page);
  const screenshot = testInfo.outputPath("take-drop-once-workerd.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("take-drop-once-workerd", { path: screenshot, contentType: "image/png" });
  await context.close();
});

test("entering Tasks keeps workspace and chat component surfaces separate and responsive", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  await openSpa(page, credentials.alice);

  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "Tasks" })).toHaveClass(/active/);
  await expect(page.locator("woo-tasks-kanban[data-tasks-board]")).toBeVisible({ timeout: 30_000 });
  // Presence proves the enter turn settled; the regression only occurred once
  // Chat rendered while the actor's live room was the task registry.
  await expect(page.locator("woo-space-chat-panel[data-space-chat-panel]")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.locator("woo-chat-space[data-chat-space-host]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("woo-tasks-kanban[data-chat-space-host]")).toHaveCount(0);
  // Tasks has no mount_room and pooled guests intentionally have $nowhere as
  // home. Switching surfaces therefore keeps taskboard presence; prove the
  // room anchor with an authoritative command rather than its cacheable title.
  const input = page.locator("[data-chat-input]");
  await input.fill("look");
  await input.press("Enter");
  await expect(page.locator(".chat-feed")).toContainText("registry that coordinates work items", { timeout: 30_000 });
  expect(pageErrors).toEqual([]);
  expectNoLegacyRequests(page);

  await context.close();
});

test("Outliner hydrates a complete nested tree in a fresh real-workerd session", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  });
  await openSpa(page, credentials.alice);

  await page.getByRole("button", { name: "Outliner" }).click();
  const tree = page.locator("woo-outliner-tree[data-outliner-tree]");
  await expect(tree).toBeVisible({ timeout: 30_000 });
  const suffix = Date.now();
  const parentText = `workerd-parent-${suffix}`;
  const childText = `workerd-child-${suffix}`;
  const addInput = tree.locator("[data-outliner-add] input[name=text]");
  await expect(addInput).toBeVisible({ timeout: 30_000 });
  // Entry intentionally retries companion-chat focus through 900 ms so a
  // freshly mounted custom element receives focus after its first renders.
  // Let that lifecycle settle before testing Enter in the item composer;
  // otherwise the delayed focus can move the keystroke into companion chat.
  await expect(tree.locator("woo-space-chat-panel[data-space-chat-panel]")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_000);
  await addInput.fill(parentText);
  await addInput.press("Enter");
  const parentRow = tree.locator("[data-outliner-row]").filter({ hasText: parentText }).first();
  await expect(parentRow).toBeVisible({ timeout: 30_000 });
  await parentRow.click();
  await parentRow.getByRole("button", { name: "add child" }).click();
  const childInput = tree.locator("[data-outliner-add-child] input[name=text]");
  await childInput.fill(childText);
  await childInput.press("Enter");
  const childRow = tree.locator("[data-outliner-row]").filter({ hasText: childText }).first();
  await expect(childRow).toBeVisible({ timeout: 30_000 });
  await expect(childRow).toHaveAttribute("style", /--indent:\s*20px/);

  // A separate principal starts with no browser projection/cache from the
  // creator. Its first mounted tree must still perform list_items and render the
  // whole authoritative hierarchy.
  const freshContext = await browser.newContext();
  const fresh = await freshContext.newPage();
  fresh.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  fresh.on("response", (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  });
  await openSpa(fresh, credentials.bob);
  await fresh.getByRole("button", { name: "Outliner" }).click();
  const freshTree = fresh.locator("woo-outliner-tree[data-outliner-tree]");
  await expect(freshTree).toBeVisible({ timeout: 30_000 });
  await expect(freshTree.locator("[data-outliner-row]").filter({ hasText: parentText })).toHaveCount(1, { timeout: 30_000 });
  const freshChild = freshTree.locator("[data-outliner-row]").filter({ hasText: childText }).first();
  await expect(freshChild).toBeVisible({ timeout: 30_000 });
  await expect(freshChild).toHaveAttribute("style", /--indent:\s*20px/);

  const panel = freshTree.locator("woo-space-chat-panel[data-space-chat-panel]");
  const input = panel.locator("[data-space-chat-input]");
  const countLines = panel.locator(".chat-line").filter({ hasText: /Outline has \d+ items?\./ });
  const previousCountLines = await countLines.count();
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill("look");
  await input.press("Enter");
  await expect(countLines).toHaveCount(previousCountLines + 1, { timeout: 30_000 });
  const renderedCount = await freshTree.locator("[data-outliner-row]").count();
  await expect.poll(async () => {
    const countText = await countLines.last().textContent();
    return Number(countText?.match(/Outline has (\d+) items?\./)?.[1] ?? -1);
  }, { timeout: 30_000 }).toBe(renderedCount);
  const authoritativeRoster = await freshTree.evaluate(async (element) => {
    const treeElement = element as HTMLElement & {
      subject?: string;
      woo?: { directCall: (subject: string, verb: string, args: unknown[], options?: { serverRead?: boolean }) => Promise<unknown> };
    };
    return treeElement.woo?.directCall(treeElement.subject ?? "", "room_roster", [], { serverRead: true });
  });
  expect(authoritativeRoster).toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]));
  await expect(freshTree.locator(".presence-list")).not.toContainText("No one is here.", { timeout: 30_000 });

  // Keep the original stale-bytecode contract check in this production-shaped
  // path as well.
  await expect(panel).not.toContainText("object_tree_rows expects");
  expect(pageErrors).toEqual([]);
  expect(serverErrors).toEqual([]);
  expectNoLegacyRequests(page, fresh);

  const screenshot = testInfo.outputPath("outliner-complete-nested-workerd.png");
  await fresh.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("outliner-complete-nested-workerd", { path: screenshot, contentType: "image/png" });
  await freshContext.close();
  await context.close();
});

test("Dubspace hydrates its persisted percussion pattern and repaints committed step changes", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  await openSpa(page, credentials.bob);

  await page.getByRole("button", { name: "Dubspace" }).click();
  const kickOne = page.getByRole("button", { name: "Kick step 1" });
  const kickTwo = page.getByRole("button", { name: "Kick step 2" });
  const hatOne = page.getByRole("button", { name: "Hat step 1" });
  await expect(kickOne).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await expect(kickTwo).toHaveAttribute("aria-pressed", "false");
  await expect(hatOne).toHaveAttribute("aria-pressed", "true");

  await kickTwo.click();
  await expect(kickTwo).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await kickTwo.click();
  await expect(kickTwo).toHaveAttribute("aria-pressed", "false", { timeout: 30_000 });
  expect(pageErrors).toEqual([]);
  expectNoLegacyRequests(page);

  await context.close();
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
  // A fresh gateway starts with only room-owned stubs. Exercise the complete
  // user-visible room model through the real browser/workerd path: the remote
  // self-hosted block and both nested tool spaces must survive that cold look.
  await guest.locator("[data-chat-input]").fill("look");
  await guest.locator("[data-chat-input]").press("Enter");
  await expect(guest.locator(".chat-feed")).toContainText("Weather for", { timeout: 20_000 });
  await expect(guest.getByRole("button", { name: "Dubspace", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(guest.getByRole("button", { name: "Outliner", exact: true })).toBeVisible({ timeout: 20_000 });
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

test("Chat returns from mounted nested tools to their parent room", async ({ browser }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  // Use a fresh door principal so this navigation gate measures its own turn
  // and read traffic rather than the earlier carried actors' cumulative rate
  // budget. One session also reproduces the hosted Dubspace → Chat → Outliner
  // → Chat sequence that originally exposed the intermittent projection gap.
  await openGuestSpa(page);

  for (const tool of [
    { name: "Dubspace", workspace: "woo-dubspace-workspace[data-dubspace-workspace]", settled: "woo-space-chat-panel[data-space-chat-panel]" },
    { name: "Outliner", workspace: "woo-outliner-tree[data-outliner-tree]", settled: "[data-outliner-add] input[name=text]" }
  ]) {
    await page.getByRole("button", { name: tool.name, exact: true }).click();
    const workspace = page.locator(tool.workspace);
    await expect(workspace).toBeVisible({ timeout: 30_000 });
    // Wait for the movement/presence turn to settle so background component
    // hydration is not deliberately abandoned mid-read by the navigation test.
    await expect(workspace.locator(tool.settled)).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page).toHaveURL(/\/objects\/the_chatroom$/, { timeout: 30_000 });
    await expect(page.locator("woo-chat-space[data-chat-space-host]")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".toolbar h1")).toHaveText("Living Room", { timeout: 30_000 });
    const chatInput = page.locator("[data-chat-input]");
    await expect(chatInput).toBeVisible({ timeout: 30_000 });
    // The client-origin turn limiter is deliberately burst-bounded. Keep this
    // navigation test about routing/projection convergence rather than issuing
    // the next human action inside the prior turn's one-second rate window.
    await page.waitForTimeout(1_100);
  }

  await expect(page.locator(".chat-feed .chat-line").filter({ hasText: /closes Outline\./ })).toHaveCount(1);
  const chatInput = page.locator("[data-chat-input]");
  await chatInput.fill("look");
  await chatInput.press("Enter");
  await expect(page.locator(".chat-feed")).toContainText("A bright, open living room", { timeout: 30_000 });
  expect(pageErrors).toEqual([]);
  expectNoLegacyRequests(page);
  await context.close();
});
