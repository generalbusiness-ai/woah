import { test, expect, type Locator, type Page } from "@playwright/test";

// Focused measurement for the "structure renders fast, text renders slow"
// complaint: on a cold load of an outliner/pinboard the row/structure is
// visible quickly but each item's readable text lags by many seconds while
// the catalog view hydrator fetches it via a list_items/list_notes verb read.
//
// This spec quantifies that gap so we can prove an 80% improvement. It prints the
// timings and asserts a loose regression bound on the cached path.
//
// Run serially: these are timing-sensitive measurements that all drive the same
// singleton the_outline/the_pinboard through one dev server. Running them
// concurrently makes them contend for the server and each other's shared objects,
// which skews the timings and, under load, can exhaust the single dev server.
test.describe.configure({ mode: "serial" });

async function continueAsGuestIfPrompted(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Continue as guest" }).click({ timeout: 1_000 }).catch(() => undefined);
}

function cssAttrValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

// Number of items to seed. More items widen the per-item text-state closure the
// hydrating verb read must pull, which is what makes the delay observable.
const ITEM_COUNT = 10;

test("MEASURE: outliner reload structure-to-text delay", async ({ page }) => {
  test.setTimeout(120_000);
  const tag = `perf${Math.random().toString(36).slice(2, 7)}`;
  await page.goto("/");
  await continueAsGuestIfPrompted(page);
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 10_000 });
  await page.getByRole("button", { name: "Outliner" }).click();
  await expect(page.getByRole("button", { name: "Outliner" })).toHaveClass(/active/);
  const tree = page.locator("woo-outliner-tree[data-outliner-tree]");
  await expect(tree).toBeVisible();
  await expect(tree.locator("[data-outliner-add] input[name=text]")).toBeVisible({ timeout: 10_000 });

  const addInput = tree.locator("[data-outliner-add] input[name=text]");
  // Track only the rows THIS run creates (by data-id) so the measurement is
  // robust to items left behind by earlier runs sharing the dev DB.
  const texts: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < ITEM_COUNT; i++) {
    const itemText = `${tag}-item-${i}-some-readable-note-content`;
    texts.push(itemText);
    await addInput.fill(itemText);
    await addInput.press("Enter");
    const row = tree.locator(".outliner-row").filter({ hasText: itemText });
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    const id = await row.first().getAttribute("data-id");
    expect(id, `row id for ${itemText}`).toBeTruthy();
    ids.push(String(id));
  }

  // --- The measurement: reload (cold load) and time structure vs text. ---
  await page.reload();
  const tReload = await page.evaluate(() => performance.now());
  const wallReload = await page.evaluate(() => Date.now());
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Outliner" })).toHaveClass(/active/);
  const reloaded = page.locator("woo-outliner-tree[data-outliner-tree]");
  await expect(reloaded).toBeVisible({ timeout: 10_000 });

  // t0: when the structure (this run's rows) is on screen.
  for (const id of ids) {
    await expect(reloaded.locator(`[data-outliner-row][data-id="${cssAttrValue(id)}"]`)).toHaveCount(1, { timeout: 15_000 });
  }
  const tStructure = await page.evaluate(() => performance.now());

  // t1: when every one of this run's rows shows its readable text.
  for (let i = 0; i < ids.length; i++) {
    await expect.poll(async () => {
      return await reloaded.locator(`[data-outliner-row][data-id="${cssAttrValue(ids[i])}"] .outliner-text`).textContent();
    }, { timeout: 30_000 }).toBe(texts[i]);
  }
  const tText = await page.evaluate(() => performance.now());

  const delayMs = Math.round(tText - tStructure);
  // eslint-disable-next-line no-console
  console.log(`NOTE_HYDRATION_DELAY outliner items=${ITEM_COUNT} structure_to_text_ms=${delayMs} reload_to_structure_ms=${Math.round(tStructure - tReload)} reload_to_text_ms=${Math.round(tText - tReload)} wall_reload_epoch=${wallReload}`);
  // Regression gate. The pre-fix baseline was ~4.9s (text trailed the structure
  // while a list_items hydration was gated by the relay scope-open handshake).
  // With the localStorage display cache the text paints with the structure; this
  // bound is ~5x below the old baseline so any reintroduction of the cold-read
  // gating on this path fails the test. See notes/2026-06-09-note-content-hydration.md.
  expect(delayMs, "outliner reload structure->text delay regressed").toBeLessThan(1000);
});

test("MEASURE: pinboard reload structure-to-text delay", async ({ page }) => {
  test.setTimeout(120_000);
  const tag = `pinperf${Math.random().toString(36).slice(2, 7)}`;
  await page.goto("/");
  await continueAsGuestIfPrompted(page);
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 10_000 });
  await page.getByRole("button", { name: "Pinboard" }).click();
  await expect(page.getByRole("button", { name: "Pinboard" })).toHaveClass(/active/);
  await expect(page.locator(".pinboard-stage")).toBeVisible({ timeout: 10_000 });

  const NOTE_COUNT = 8;
  const texts: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < NOTE_COUNT; i++) {
    const noteText = `${tag}-note-${i}-readable-pin-content`;
    texts.push(noteText);
    await page.locator("[data-pinboard-new-text]").fill(noteText);
    await page.locator("[data-pinboard-create]").getByRole("button", { name: "Add Note" }).click();
    await expect(page.locator(".pinboard-stage")).toContainText(noteText, { timeout: 10_000 });
    const id = await page.locator("[data-pin-note]").evaluateAll((notes, text) => {
      for (const note of notes) {
        const input = note.querySelector<HTMLTextAreaElement>("[data-pin-note-text]");
        if (input?.value === text) return note.getAttribute("data-pin-note");
      }
      return null;
    }, noteText);
    expect(id, `note id for ${noteText}`).toBeTruthy();
    ids.push(String(id));
  }

  // --- Reload and time structure (note exists) vs text (textarea value). ---
  await page.reload();
  const tReload = await page.evaluate(() => performance.now());
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Pinboard" })).toHaveClass(/active/);
  await expect(page.locator(".pinboard-stage")).toBeVisible({ timeout: 10_000 });

  for (const id of ids) {
    await expect(page.locator(`[data-pin-note="${cssAttrValue(id)}"]`)).toHaveCount(1, { timeout: 15_000 });
  }
  const tStructure = await page.evaluate(() => performance.now());

  for (let i = 0; i < ids.length; i++) {
    await expect.poll(async () => {
      return await page.locator(`[data-pin-note-text="${cssAttrValue(ids[i])}"]`).inputValue().catch(() => "");
    }, { timeout: 30_000 }).toBe(texts[i]);
  }
  const tText = await page.evaluate(() => performance.now());

  const delayMs = Math.round(tText - tStructure);
  // eslint-disable-next-line no-console
  console.log(`NOTE_HYDRATION_DELAY pinboard items=${NOTE_COUNT} structure_to_text_ms=${delayMs} reload_to_structure_ms=${Math.round(tStructure - tReload)} reload_to_text_ms=${Math.round(tText - tReload)} wall_reload_epoch=${await page.evaluate(() => Date.now())}`);
  expect(delayMs, "pinboard reload structure->text delay regressed").toBeLessThan(1000);
});

// Genuine first-ever visit: the data exists on the server but THIS browser has
// never cached it (empty localStorage — incognito / first load / different
// device). The display cache cannot help here; this measures the routing-fix
// path (serverRead + socket-open + tool-scope-direct connect) alone, so we know
// honestly what a true first-time visitor sees. No tight gate — this is a probe.
test("MEASURE: outliner cold load with EMPTY cache (true first visit)", async ({ page }) => {
  test.setTimeout(120_000);
  const tag = `nocache${Math.random().toString(36).slice(2, 7)}`;
  await page.goto("/");
  await continueAsGuestIfPrompted(page);
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 10_000 });
  await page.getByRole("button", { name: "Outliner" }).click();
  await expect(page.getByRole("button", { name: "Outliner" })).toHaveClass(/active/);
  const tree = page.locator("woo-outliner-tree[data-outliner-tree]");
  await expect(tree).toBeVisible();
  await expect(tree.locator("[data-outliner-add] input[name=text]")).toBeVisible({ timeout: 10_000 });

  const addInput = tree.locator("[data-outliner-add] input[name=text]");
  const texts: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < ITEM_COUNT; i++) {
    const itemText = `${tag}-item-${i}-readable`;
    texts.push(itemText);
    await addInput.fill(itemText);
    await addInput.press("Enter");
    const row = tree.locator(".outliner-row").filter({ hasText: itemText });
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    ids.push(String(await row.first().getAttribute("data-id")));
  }

  // Wipe browser-side caches so the reload is a genuine cold first visit: the
  // display-text cache (localStorage `woo.*.text.*`) AND IndexedDB (worker
  // projection/exec caches that paint the structure). Preserve the session token
  // (woo.session) — a real first-time visitor is still logged in; only their
  // caches are empty. Forces structure AND text to come from a fresh open.
  await page.evaluate(async () => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("woo.outliner.text.") || key.startsWith("woo.pinboard.text.")) localStorage.removeItem(key);
    }
    for (const db of (await indexedDB.databases?.()) ?? []) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
  });

  await page.reload();
  const tReload = await page.evaluate(() => performance.now());
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Outliner" })).toHaveClass(/active/);
  const reloaded = page.locator("woo-outliner-tree[data-outliner-tree]");
  await expect(reloaded).toBeVisible({ timeout: 10_000 });

  for (const id of ids) {
    await expect(reloaded.locator(`[data-outliner-row][data-id="${cssAttrValue(id)}"]`)).toHaveCount(1, { timeout: 20_000 });
  }
  const tStructure = await page.evaluate(() => performance.now());
  for (let i = 0; i < ids.length; i++) {
    await expect.poll(async () =>
      await reloaded.locator(`[data-outliner-row][data-id="${cssAttrValue(ids[i])}"] .outliner-text`).textContent(),
    { timeout: 30_000 }).toBe(texts[i]);
  }
  const tText = await page.evaluate(() => performance.now());
  // eslint-disable-next-line no-console
  console.log(`NOTE_HYDRATION_DELAY outliner-NOCACHE items=${ITEM_COUNT} structure_to_text_ms=${Math.round(tText - tStructure)} reload_to_structure_ms=${Math.round(tStructure - tReload)} reload_to_text_ms=${Math.round(tText - tReload)}`);
  expect(tText).toBeGreaterThanOrEqual(tStructure);
});
