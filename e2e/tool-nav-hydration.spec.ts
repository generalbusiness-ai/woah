import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

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

async function expectJson(response: Awaited<ReturnType<APIRequestContext["post"]>>, context: string): Promise<any> {
  const body = await response.json();
  expect(response.ok(), `${context}: ${JSON.stringify(body)}`).toBe(true);
  return body;
}

async function seedBothTools(request: APIRequestContext, outText: string, pinText: string): Promise<void> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const auth = await expectJson(await request.post("/api/auth", { data: { token: `guest:tool-nav-seed-${suffix}` } }), "seed auth");
  const headers = { Authorization: `Session ${auth.session}` };

  await expectJson(await request.post("/api/objects/the_outline/calls/enter", {
    headers,
    data: { id: `seed-outline-enter-${suffix}`, space: "the_outline", args: [] }
  }), "seed outline enter");
  await expectJson(await request.post("/api/objects/the_outline/calls/add", {
    headers,
    data: { id: `seed-outline-add-${suffix}`, space: "the_outline", args: [outText] }
  }), "seed outline add");
  const listedOutline = await expectJson(await request.post("/api/objects/the_outline/calls/list_items", {
    headers,
    data: { args: [] }
  }), "seed outline list");
  expect(listedOutline.result.some((row: { text?: string }) => row.text === outText), "seeded outline item text").toBe(true);

  await expectJson(await request.post("/api/objects/the_pinboard/calls/enter", {
    headers,
    data: { id: `seed-pinboard-enter-${suffix}`, space: "the_pinboard", args: [] }
  }), "seed pinboard enter");
  await expectJson(await request.post("/api/objects/the_pinboard/calls/add_note", {
    headers,
    data: { id: `seed-pinboard-add-${suffix}`, space: "the_pinboard", args: [pinText, "yellow"] }
  }), "seed pinboard add");
  const listedPins = await expectJson(await request.post("/api/objects/the_pinboard/calls/list_notes", {
    headers,
    data: { args: [] }
  }), "seed pinboard list");
  expect(listedPins.result.some((note: { text?: string }) => note.text === pinText), "seeded pinboard note text").toBe(true);
}

test("fresh actor: pinboard note text hydrates when reached as the SECOND tool", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const outText = "exist-out-" + Math.random().toString(36).slice(2, 7);
  const pinText = "exist-pin-" + Math.random().toString(36).slice(2, 7);

  // Seed server-side content in both tools before opening the fresh browser.
  await seedBothTools(request, outText, pinText);

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
