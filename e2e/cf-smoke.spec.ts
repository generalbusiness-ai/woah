// CF browser e2e smoke spec — Playwright against real workerd (wrangler dev).
//
// Run via `npm run e2e:cf` (scripts/e2e-cf-dev.ts), NOT via `npm test` or
// `playwright test` directly. The launch script manages workerd lifecycle,
// builds the SPA, and sets WOO_CF_E2E_BASE_URL so this config gets the right
// baseURL.
//
// This is the wave-1 deliverable for plan item D3a: a Playwright lane that
// exercises the real Cloudflare worker runtime with a real browser, not the
// vite dev server. The default e2e/ specs target the dev server only.
//
// What this spec covers:
//   1. A guest session connects, the room UI renders, and the user issues a
//      `say` command — the chat line appears in the browser.
//   2. A second browser context joins the same room and observes the first
//      user's say (cross-client delivery over the real workerd WS path).
//   3. The optimistic-render observability plumbing (the "woo.v2.render_frame"
//      marker added to src/client/main.ts) is exercised; wave-3 assertion is
//      marked expected-fail (test.fixme) until WOO_BROWSER_PROJECTION_HOLDER is
//      enabled and validated end-to-end.
//
// Architecture note — same-origin WS serving:
//   The client builds its WebSocket URL from window.location.host
//   (src/client/v2-browser-url.ts), so serving the SPA and the API/WS from the
//   same wrangler-dev port is the cleanest approach.  wrangler.cf-e2e.toml adds
//   [assets] pointing to ./dist with run_worker_first=true so API/WS routes are
//   not swallowed by the SPA fallback.  No proxy or CORS configuration is needed.

import { test, expect, type Page } from "@playwright/test";

// ── helpers ────────────────────────────────────────────────────────────────

// render_frame events emitted by src/client/main.ts receiveOptimisticResultFrame
// (committed=false) and receiveAppliedFrame (committed=true).
type RenderFrameEvent = { id: string; verb: string; committed: boolean; t: number };

// v2 scope projection event shape (detail of the woo.v2.projection CustomEvent).
// The `cached` field is true when the projection came from IndexedDB before the
// WS relay connected; false/absent when it came from a live state transfer.
type ProjectionEvent = { kind?: string; scope?: string; cached?: boolean };

// Install the render_frame listener. Must be called before any navigation
// (before openGuestPage) so addInitScript fires before the app's JS runs.
// Returns a function to collect received events from the test process.
async function installRenderFrameListener(page: Page): Promise<() => RenderFrameEvent[]> {
  const collected: RenderFrameEvent[] = [];
  const fnName = `_wooRenderFrame${Math.random().toString(36).slice(2)}`;
  await page.exposeFunction(fnName, (event: RenderFrameEvent) => {
    collected.push(event);
  });
  // addInitScript runs in the page context on every navigation, BEFORE any
  // page scripts execute, so the listener is always registered before the app
  // code fires its first event. Call installRenderFrameListener before
  // openGuestPage to ensure both navigations (root + target) are covered.
  await page.addInitScript((fn: string) => {
    window.addEventListener("woo.v2.render_frame", (e) => {
      const detail = (e as CustomEvent<RenderFrameEvent>).detail;
      void (window as unknown as Record<string, (v: unknown) => Promise<void>>)[fn](detail);
    });
  }, fnName);
  return () => collected;
}

// Install a turn_result verb listener. Must be called before openGuestPage
// so addInitScript fires before the app's JS runs.
async function installTurnResultListener(page: Page): Promise<() => string[]> {
  const verbs: string[] = [];
  const fnName = `_wooTurnResult${Math.random().toString(36).slice(2)}`;
  await page.exposeFunction(fnName, (verb: string) => { verbs.push(verb); });
  await page.addInitScript((fn: string) => {
    window.addEventListener("woo.v2.turn_result", (e) => {
      const detail = (e as CustomEvent<{ frame?: { command?: { verb?: string } } }>).detail;
      void (window as unknown as Record<string, (v: string) => Promise<void>>)[fn](String(detail?.frame?.command?.verb ?? ""));
    });
  }, fnName);
  return () => verbs;
}

// Install a scope-projection listener. Must be called before any navigation.
// Collects woo.v2.projection events from the browser worker — these fire when
// the WS relay delivers a live state transfer (cached=false/absent) or when a
// cached IndexedDB projection is replayed (cached=true). Only live projections
// signal that the WS scope is fully open and the first turn can be sent and
// received promptly. Returns a function to retrieve all received events.
async function installProjectionListener(page: Page): Promise<() => ProjectionEvent[]> {
  const events: ProjectionEvent[] = [];
  const fnName = `_wooProjection${Math.random().toString(36).slice(2)}`;
  await page.exposeFunction(fnName, (event: ProjectionEvent) => {
    events.push(event);
  });
  await page.addInitScript((fn: string) => {
    window.addEventListener("woo.v2.projection", (e) => {
      const detail = (e as CustomEvent<ProjectionEvent>).detail;
      void (window as unknown as Record<string, (v: unknown) => Promise<void>>)[fn](detail);
    });
  }, fnName);
  return () => events;
}

// Auth a fresh guest via POST /api/auth and store the session id in localStorage
// before navigating, so the page loads already authenticated.
async function openGuestPage(page: Page, token: string, path = "/"): Promise<void> {
  // Fetch the auth token from the worker's /api/auth endpoint.
  const response = await page.request.post("/api/auth", {
    data: { token },
    headers: { "content-type": "application/json" }
  });
  expect(response.ok(), `auth failed for token ${token}: ${response.status()}`).toBe(true);
  const body = await response.json() as { session?: string };
  expect(body.session, "auth response missing session").toBeTruthy();
  const session = body.session as string;

  // Navigate to root first to establish the origin, then write the session into
  // localStorage, then navigate to the target path.
  await page.goto("/");
  await page.evaluate((sessionId) => {
    localStorage.setItem("woo.session", sessionId);
    localStorage.setItem("woo.authMethod", "guest");
  }, session);
  await page.goto(path);
}

// Wait for the actor indicator to stop showing "connecting..." (the WS is
// open and the projection has arrived at the REST level).
//
// NOTE: this gate fires as soon as state.actor is set (from the /api/me REST
// response), BEFORE the v2 browser worker's WebSocket scope is open. Callers
// that will issue turns immediately after should also call waitForScopeReady
// to ensure the WS relay has delivered at least one live projection for the
// target scope — otherwise the turn is saved to IndexedDB and replayed on the
// next WS reconnect, which can take tens of seconds on a cold world.
async function waitForConnected(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout });
}

// Wait for the v2 browser worker to deliver at least one LIVE projection for
// the given scope. A live projection (cached !== true) means the WS relay has
// opened, the scope's state transfer was received, and the first turn can be
// sent over the socket and get a timely response.
//
// Root-cause context (flake, 2026-06-09): waitForConnected fires when the REST
// /api/me response returns (state.actor set), but the browser worker's WS
// connection to the relay may still be in progress. On a cold world the scope
// DO can take 15–30 s to initialize, which means the first turn submitted right
// after waitForConnected lands in IDB without a live socket and is only replayed
// on the next reconnect. By waiting for a live projection we prove the WS scope
// is ready and eliminate the send-before-socket race.
async function waitForScopeReady(
  getProjections: () => ProjectionEvent[],
  scope: string,
  timeout = 60_000
): Promise<void> {
  await expect
    .poll(() => getProjections().some((e) => e.scope === scope && e.cached !== true), {
      timeout,
      message: `expected a live woo.v2.projection for scope ${scope}`
    })
    .toBe(true);
}

// ── spec 1: guest connects, room renders, say appears ──────────────────────

test.describe("CF browser: single-user say", () => {
  test("guest connects and say line appears in chat", async ({ page }) => {
    test.setTimeout(90_000);

    const runId = `cf-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const token = `guest:${runId}-alice`;
    const speech = `hello from workerd ${runId}`;

    // Install ALL listeners BEFORE navigation so addInitScript fires before the
    // app's first event. The projection listener is required for waitForScopeReady.
    const getSayVerbs = await installTurnResultListener(page);
    const getProjections = await installProjectionListener(page);

    await openGuestPage(page, token, "/objects/the_chatroom");
    await waitForConnected(page);

    // Wait for the v2 browser worker to deliver a LIVE projection for this
    // scope. This proves the WS relay is open and the first turn will receive a
    // timely response rather than sitting in IDB waiting for a reconnect.
    await waitForScopeReady(getProjections, "the_chatroom");

    // The chat input must be present and visible once the scope is ready.
    await expect(page.locator("[data-chat-input]")).toBeVisible({ timeout: 10_000 });

    // Issue the say command.
    await page.locator("[data-chat-input]").fill(`say ${speech}`);
    await page.locator("[data-chat-input]").press("Enter");

    // The committed say result must arrive (workerd → relay → browser).
    await expect.poll(() => getSayVerbs(), { timeout: 30_000 }).toContain("say");

    // The speech text must appear in the chat feed.
    await expect(page.locator(".chat-feed")).toContainText(speech, { timeout: 15_000 });
  });
});

// ── spec 2: cross-client delivery ─────────────────────────────────────────

test.describe("CF browser: cross-client say delivery", () => {
  // Two browser contexts (alice + bob) connect to the same room. Alice says
  // something; bob's feed must contain it, proving cross-client WS fanout works
  // through the real workerd relay.
  test("second browser context receives first user say over workerd relay", async ({ browser }) => {
    test.setTimeout(90_000);

    const runId = `cf-e2e-cross-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const aliceToken = `guest:${runId}-alice`;
    const bobToken = `guest:${runId}-bob`;
    const speech = `cross-client delivery ${runId}`;

    // Open two independent browser contexts so each has its own session and WS.
    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alicePage = await aliceCtx.newPage();
    const bobPage = await bobCtx.newPage();

    try {
      // Install listeners before navigation so they fire from addInitScript.
      const getAliceSayVerbs = await installTurnResultListener(alicePage);
      const getAliceProjections = await installProjectionListener(alicePage);
      // Bob only needs the projection listener; we do not check his turn_result.
      const getBobProjections = await installProjectionListener(bobPage);

      // Connect both guests to the_chatroom.
      await openGuestPage(alicePage, aliceToken, "/objects/the_chatroom");
      await openGuestPage(bobPage, bobToken, "/objects/the_chatroom");
      await waitForConnected(alicePage);
      await waitForConnected(bobPage);

      // Wait for live projections on both sides before Alice sends. This ensures
      // both WS relay connections are open, so Alice's say reaches the server and
      // the server's fanout reaches Bob promptly.
      await waitForScopeReady(getAliceProjections, "the_chatroom");
      await waitForScopeReady(getBobProjections, "the_chatroom");

      // Alice sends a say command.
      await alicePage.locator("[data-chat-input]").fill(`say ${speech}`);
      await alicePage.locator("[data-chat-input]").press("Enter");

      // Alice's own committed result must arrive.
      await expect.poll(() => getAliceSayVerbs(), { timeout: 30_000 }).toContain("say");
      await expect(alicePage.locator(".chat-feed")).toContainText(speech, { timeout: 15_000 });

      // Bob's feed must show the same speech via the workerd relay fanout.
      await expect(bobPage.locator(".chat-feed")).toContainText(speech, { timeout: 30_000 });
    } finally {
      await Promise.allSettled([aliceCtx.close(), bobCtx.close()]);
    }
  });
});

// ── spec 3: optimistic-render observability (plumbing check) ────────────────

test.describe("CF browser: render_frame observability", () => {
  // Verify the woo.v2.render_frame events are emitted for both optimistic
  // (committed=false, from receiveOptimisticResultFrame) and committed
  // (committed=true, from receiveAppliedFrame) paths. On CF without
  // WOO_BROWSER_PROJECTION_HOLDER, optimistic execution falls back to a direct
  // server round trip, so we may only see committed=true events. The test
  // asserts that AT LEAST the committed event is present (the plumbing works),
  // and separately records whether an optimistic event preceded it.
  test("render_frame committed event fires after say", async ({ page }) => {
    test.setTimeout(90_000);

    const runId = `cf-e2e-rf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const token = `guest:${runId}-user`;
    const speech = `render frame check ${runId}`;

    // Install listeners before navigation so addInitScript registers them.
    const getFrames = await installRenderFrameListener(page);
    const getSayVerbs = await installTurnResultListener(page);
    const getProjections = await installProjectionListener(page);

    await openGuestPage(page, token, "/objects/the_chatroom");
    await waitForConnected(page);
    // Wait for live WS projection before submitting (same race fix as specs 1+2).
    await waitForScopeReady(getProjections, "the_chatroom");
    await expect(page.locator("[data-chat-input]")).toBeVisible({ timeout: 10_000 });

    await page.locator("[data-chat-input]").fill(`say ${speech}`);
    await page.locator("[data-chat-input]").press("Enter");
    await expect.poll(() => getSayVerbs(), { timeout: 30_000 }).toContain("say");
    await expect(page.locator(".chat-feed")).toContainText(speech, { timeout: 15_000 });

    // At least one committed render_frame event must have fired. The say verb
    // goes through receiveAppliedFrame on CF (live verb, no optimistic path),
    // but other verbs (e.g. command_plan) may appear with committed=true too.
    const frames = getFrames();
    const committedFrames = frames.filter((f) => f.committed);
    expect(committedFrames.length, "at least one committed render_frame event expected").toBeGreaterThan(0);

    const optimisticFrames = frames.filter((f) => !f.committed);
    // On CF without WOO_BROWSER_PROJECTION_HOLDER, optimistic frames are not
    // expected (the browser falls back to local_turn_fallback). Record but do
    // not assert — this is a reconnaissance measurement.
    console.log(`render_frame events: ${frames.length} total, ${optimisticFrames.length} optimistic, ${committedFrames.length} committed`);
  });
});

// ── spec 4: optimistic-before-committed ordering (expected-fail / skip) ────

// This spec CANNOT pass until WOO_BROWSER_PROJECTION_HOLDER is enabled in
// wrangler.cf-e2e.toml (currently commented out). It is marked test.fixme so
// that:
//   a) It is visibly present as a planned assertion rather than absent.
//   b) It will fail with a clear message if someone accidentally enables the
//      flag without validating the full end-to-end behavior (see D3a wave-3).
//
// To run the reconnaissance variant (flag enabled), uncomment
// WOO_BROWSER_PROJECTION_HOLDER = "1" in wrangler.cf-e2e.toml and remove the
// test.fixme wrapper. Record what actually happens in
// notes/2026-06-09-d3a-browser-cf-lane.md §Flag-on reconnaissance.
test.fixme("optimistic render_frame precedes committed render_frame for same-scope say (requires WOO_BROWSER_PROJECTION_HOLDER)", async ({ page }) => {
  // When WOO_BROWSER_PROJECTION_HOLDER is on, the browser executes the turn
  // locally (optimistic) before the server confirms it. For a same-scope say,
  // the woo.v2.render_frame(committed=false) event MUST precede
  // woo.v2.render_frame(committed=true) for the same turn id.
  //
  // Without the flag, every turn falls back to local_turn_fallback (no local
  // plan) → only committed=true events fire → this assertion fails with
  // "no optimistic frame found".
  //
  // D3a wave-3 scope: once the flag is on and the browser-profile path is
  // validated for same-scope live verbs, promote this to a live assertion.
  // Note that durable verbs (movement) stay commit-confirmed by design
  // (v2TranscriptSupportsProposalProjectionOverlay requires moves to stay in
  // scope), so the say verb is the correct test subject here.

  test.setTimeout(90_000);

  const runId = `cf-e2e-opt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const token = `guest:${runId}-user`;
  const speech = `optimistic ordering check ${runId}`;

  const getFrames = await installRenderFrameListener(page);
  const getSayVerbs = await installTurnResultListener(page);
  const getProjections = await installProjectionListener(page);

  await openGuestPage(page, token, "/objects/the_chatroom");
  await waitForConnected(page);
  // Wait for live WS projection before submitting (same race fix as specs 1-3).
  await waitForScopeReady(getProjections, "the_chatroom");
  await expect(page.locator("[data-chat-input]")).toBeVisible({ timeout: 10_000 });

  await page.locator("[data-chat-input]").fill(`say ${speech}`);
  await page.locator("[data-chat-input]").press("Enter");
  await expect.poll(() => getSayVerbs(), { timeout: 30_000 }).toContain("say");
  await expect(page.locator(".chat-feed")).toContainText(speech, { timeout: 15_000 });

  const frames = getFrames();
  // Find matching optimistic + committed pair for the same turn id.
  const optimistic = frames.find((f) => !f.committed);
  const committed = optimistic ? frames.find((f) => f.committed && f.id === optimistic.id) : undefined;

  expect(optimistic, "optimistic render_frame event expected (WOO_BROWSER_PROJECTION_HOLDER must be enabled)").toBeDefined();
  expect(committed, "committed render_frame event expected for same turn id").toBeDefined();
  expect(optimistic!.t, "optimistic render must precede committed render (same turn id)").toBeLessThan(committed!.t);
});
