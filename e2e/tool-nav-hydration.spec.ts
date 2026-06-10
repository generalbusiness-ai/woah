import { test, expect, type Page } from "@playwright/test";

// Regression for SPA tool-to-tool navigation within one live session. When a
// fresh actor (empty display cache) navigates to a tool as the SECOND tool, its
// existing notes' readable text must hydrate. The pinboard's text hydration is
// gated on actor presence; the one-shot trigger in refreshScopedProjection runs
// before the live-transition `enter` establishes presence, so without a retry on
// the render path the second tool showed structure but empty text. See
// notes/2026-06-09-note-content-hydration.md.

async function guest(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Continue as guest" }).click({ timeout: 1_500 }).catch(() => undefined);
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 10_000 });
}

async function seedBothTools(page: Page, outText: string, pinText: string): Promise<void> {
  await page.getByRole("button", { name: "Outliner" }).click();
  const tree = page.locator("woo-outliner-tree[data-outliner-tree]");
  await expect(tree.locator("[data-outliner-add] input[name=text]")).toBeVisible({ timeout: 10_000 });
  await tree.locator("[data-outliner-add] input[name=text]").fill(outText);
  await tree.locator("[data-outliner-add] input[name=text]").press("Enter");
  await expect(tree.locator(".outliner-row").filter({ hasText: outText })).toHaveCount(1, { timeout: 15_000 });
  await page.getByRole("button", { name: "Pinboard" }).click();
  await expect(page.locator(".pinboard-stage")).toBeVisible({ timeout: 10_000 });
  await page.locator("[data-pinboard-new-text]").fill(pinText);
  await page.locator("[data-pinboard-create]").getByRole("button", { name: "Add Note" }).click();
  await expect(page.locator(".pinboard-stage")).toContainText(pinText, { timeout: 10_000 });
}

test("fresh actor: pinboard note text hydrates when reached as the SECOND tool", async ({ browser }) => {
  test.setTimeout(120_000);
  const outText = "exist-out-" + Math.random().toString(36).slice(2, 7);
  const pinText = "exist-pin-" + Math.random().toString(36).slice(2, 7);

  // Context A seeds server-side content in both tools.
  const a = await browser.newContext();
  await seedBothTools(await a.newPage().then(async (p) => { await p.goto("/"); await guest(p); return p; }), outText, pinText);
  await a.close();

  // Context B is a different fresh guest (empty cache) — it must hydrate from server.
  const b = await browser.newContext();
  const pb = await b.newPage();
  await pb.goto("/");
  await guest(pb);

  // First tool: outliner (existing item text shows).
  await pb.getByRole("button", { name: "Outliner" }).click();
  await expect(pb.locator(".outliner-row").filter({ hasText: outText })).toHaveCount(1, { timeout: 15_000 });

  // Second tool: pinboard via live tab switch — THIS note's existing text must
  // hydrate. Match by content (the board is a shared singleton, so other notes
  // may be present); the assertion is that our note's text is non-empty/correct.
  await pb.getByRole("button", { name: "Pinboard" }).click();
  await expect(pb.locator(".pinboard-stage")).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => {
    return await pb.locator("[data-pin-note-text]").evaluateAll((tas) =>
      (tas as HTMLTextAreaElement[]).map((t) => t.value));
  }, { timeout: 20_000, message: "second-tool pinboard note text must hydrate" }).toContain(pinText);

  await b.close();
});
