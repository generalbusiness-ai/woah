// NetFeed browser e2e — the coherence layer's client feed in REAL browsers
// against REAL workerd (Plan 002 Phase 4 item 5, the phase's exit gate;
// kickoff notes/2026-07-07-net-phase4-kickoff.md item 5; plan
// notes/2026-07-04-simplest-system-plan.md §Phase 4).
//
// THE CLASS UNDER TEST: cross-user sharing — the v2-era bug class where a
// peer's committed change never reached the other browser (the cross-user
// pinboard/outliner sharing break: the server fanned out correctly but the
// browser only reacted to the SELF actor, so user B never rendered user A's
// note_added). Here the NEW feed (src/client/net-feed.ts) is proven against
// that class end-to-end: two browser contexts, two apikeys bound to two
// actors, both transitioned into the shared annex room; A's state-changing
// turn (wave, with an observation) must arrive at B as a peer observation
// frame AND B's cell re-read must show the new state (the mirror path),
// while A sees its own result exactly once — then the reverse direction.
//
// MECHANISM (the honest minimal harness, per the kickoff decisions):
//   - Backend: real workerd — `wrangler dev -c wrangler.smoke.toml`, spawned
//     by beforeAll via the SHARED harness module scripts/net-smoke-harness.ts
//     (the same world, verbs, actors, and apikeys the smoke:net-dev lane
//     drives; one fixture, two lanes — never a per-lane copy). The world
//     fixture itself is built by a tsx SUBPROCESS (dumpLaneFixture →
//     scripts/net-smoke-fixture.ts --dump) because the engine's JSON
//     manifest imports don't load under Playwright's Node ESM loader.
//   - Seeding: the /net-smoke doorway, exactly like the lane script; the
//     ROOM and ANNEX scopes are subscribed to the `net-api` gateway shard so
//     its mirror serves the client reads and its fanout feeds the WS push.
//   - Page: a MINIMAL e2e-only static page (e2e/net-feed-page/) — esbuild
//     bundles entry.ts (which imports the real NetFeed) on the fly in
//     beforeAll, and `--assets <tmpdir>` serves it from the SAME origin as
//     /net-api, so no CORS, no proxy, and no dependency on `npm run dev` or
//     the SPA build. The full SPA integration is Phase 5 (cutover).
//
// Run via `npm run e2e:net` (playwright.net-e2e.config.ts). NOT part of
// npm test: browser-spawning lanes stay explicit, like e2e:cf.

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { build } from "esbuild";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import {
  CLIENT_KEY_A,
  CLIENT_KEY_B,
  dumpLaneFixture,
  findFreePort,
  seedPartitions,
  startWorkerd,
  stopWorkerd,
  waitReady
} from "../scripts/net-smoke-harness";

const HERE = dirname(fileURLToPath(import.meta.url));

// The annex room's waves cell — the authoritative state the wave turn
// writes; B's re-read of it is the mirror-path assertion.
const WAVES_CELL = "property_cell:net_lane_annex:waves";

let base = "";
let child: ChildProcess | null = null;
let persistDir = "";
let assetsDir = "";

test.beforeAll(async () => {
  // Workerd boot + seed can take a while on a cold machine; the per-test
  // timeout in playwright.net-e2e.config.ts covers only in-test latency.
  test.setTimeout(240_000);

  // 1. Bundle the test page: entry.ts (importing the real NetFeed) → one
  //    iife file beside a copy of index.html in a temp assets dir.
  assetsDir = mkdtempSync(join(tmpdir(), "woo-net-e2e-assets-"));
  await build({
    entryPoints: [join(HERE, "net-feed-page", "entry.ts")],
    bundle: true,
    format: "iife",
    sourcemap: "inline",
    outfile: join(assetsDir, "net-feed-page.js"),
    logLevel: "silent"
  });
  copyFileSync(join(HERE, "net-feed-page", "index.html"), join(assetsDir, "index.html"));

  // 2. Boot real workerd on the smoke config, serving the page from the
  //    same origin (--assets; asset paths never shadow /net-api routes).
  //    The fixture builds in a tsx subprocess (see the header MECHANISM).
  const fixture = await dumpLaneFixture();
  const port = await findFreePort();
  base = `http://127.0.0.1:${port}`;
  persistDir = mkdtempSync(join(tmpdir(), "woo-net-e2e-"));
  child = startWorkerd(port, persistDir, {}, { extraArgs: ["--assets", assetsDir] });
  await waitReady(base);

  // 3. Seed the derived partitions through the /net-smoke doorway (the
  //    shared fixture idiom). The client-facing `net-api` shard is NOT
  //    subscribed here: H1 self-subscribe registers it to the
  //    room/cluster scopes each client session touches (session-open +
  //    each turn's anchor — NetGatewayDO.selfSubscribe), so peer
  //    observation push and the contents/presence roster reads work
  //    without the manual doorway subscribe this used to need.
  await seedPartitions(base, fixture.partitions);
});

test.afterAll(async () => {
  if (child) await stopWorkerd(child);
  for (const dir of [persistDir, assetsDir]) {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
});

// ---- helpers ---------------------------------------------------------------

/** Open the test page authenticated as `apiKey` and wait for the feed's
 * WebSocket to be OPEN (not just the session mint): peer delivery needs
 * the socket registered at the gateway before any peer turn commits. */
async function openFeedPage(context: BrowserContext, apiKey: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${base}/?key=${encodeURIComponent(apiKey)}`);
  await expect(page.locator("#state")).toHaveAttribute("data-connection", "open", { timeout: 30_000 });
  await expect(page.locator("#state")).not.toHaveAttribute("data-session", "");
  return page;
}

/** Drive one turn through the page's real NetFeed (window.wooTurn renders
 * the settled result into #results — the on-page visibility gate). */
async function runTurn(
  page: Page,
  target: string,
  verb: string
): Promise<{ status: string; result?: unknown; observations: Record<string, unknown>[] }> {
  return page.evaluate(
    ([t, v]) => window.wooTurn(t, v),
    [target, verb] as [string, string]
  );
}

/** Both sessions must appear in the annex's session_presence mirror at the
 * net-api shard BEFORE the wave: the mirror rows are the push audience. */
async function waitForAnnexPresence(sessions: string[]): Promise<void> {
  await expect
    .poll(
      async () => {
        // B1: the roster read carries a session present in the annex —
        // sessions[0] is user A's, which entered the annex above.
        const res = await fetch(
          `${base}/net-api/relation?session=${encodeURIComponent(sessions[0])}&relation=session_presence&owner=${encodeURIComponent("net_lane_annex")}`,
          { headers: { authorization: `Bearer ${CLIENT_KEY_A}` } }
        );
        if (res.status !== 200) return false;
        const body = (await res.json()) as { members?: Array<{ member: string }> };
        const members = (body.members ?? []).map((m) => m.member);
        return sessions.every((s) => members.includes(s));
      },
      { timeout: 20_000, message: "annex session_presence mirror never showed both sessions" }
    )
    .toBe(true);
}

// ---- chunk 1 gate: one context, one committed turn, visible on the page ----

test("single browser context: NetFeed opens a session and commits a turn", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await openFeedPage(context, CLIENT_KEY_A);

    const outcome = await runTurn(page, "lane_client_box", "click");
    expect(outcome.status).toBe("accepted");
    // clicks is a monotonically increasing counter shared across tests
    // and retries within one workerd boot — assert shape, not a fixed 1.
    expect(typeof outcome.result).toBe("number");
    expect(outcome.observations.some((o) => o.type === "clicked")).toBe(true);

    // The committed result is VISIBLE ON THE PAGE (the chunk-1 gate): the
    // settled turn rendered into #results, and the reply's observation
    // rendered into #events as source:"self".
    await expect(page.locator('#results li[data-status="accepted"][data-verb="click"]')).toHaveCount(1);
    await expect(page.locator('#results li[data-verb="click"]')).toContainText(`"result":${outcome.result}`);
    await expect(page.locator('#events li[data-source="self"][data-type="clicked"]')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

// ---- chunk 2: the cross-user sharing class, both directions ----------------

test("cross-user: peer observation frame + mirror re-read, both directions", async ({ browser }) => {
  // Two INDEPENDENT browser contexts — two users with their own apikeys,
  // actors, sessions, and WebSockets (the pinboard/outliner sharing shape).
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const pageA = await openFeedPage(contextA, CLIENT_KEY_A);
    const pageB = await openFeedPage(contextB, CLIENT_KEY_B);
    const actorA = await pageA.locator("#state").getAttribute("data-actor");
    const actorB = await pageB.locator("#state").getAttribute("data-actor");
    expect(actorA).toBeTruthy();
    expect(actorB).toBeTruthy();
    expect(actorA).not.toBe(actorB); // two credentials, two ACTORS

    // Both users transition into the shared annex (sequenced :welcome
    // turns — entering IS the presence transition, per the lane), then
    // wait for both presence rows to reach the net-api mirror: those rows
    // are the WS push audience for the annex's fanout.
    const enterA = await runTurn(pageA, "net_lane_annex", "welcome");
    const enterB = await runTurn(pageB, "net_lane_annex", "welcome");
    expect(enterA.status).toBe("accepted");
    expect(enterB.status).toBe("accepted");
    const sessionA = (await pageA.locator("#state").getAttribute("data-session")) as string;
    const sessionB = (await pageB.locator("#state").getAttribute("data-session")) as string;
    await waitForAnnexPresence([sessionA, sessionB]);

    // ---- direction 1: A acts, B sees --------------------------------------
    const waveA = await runTurn(pageA, "net_lane_annex", "wave");
    expect(waveA.status).toBe("accepted");
    const wavesAfterA = waveA.result as number;
    expect(typeof wavesAfterA).toBe("number");

    // B receives the PEER observation frame (fanout → gateway push → WS →
    // NetFeed → the page's #events list) — the exact delivery the v2
    // browser dropped for pinboard/outliner peers.
    const peerAtB = pageB.locator('#events li[data-source="peer"][data-type="waved"]');
    await expect(peerAtB).toHaveCount(1, { timeout: 20_000 });
    await expect(peerAtB).toContainText(`"waves":${wavesAfterA}`);

    // B's re-read shows the new state (the mirror path): the peer frame
    // invalidated the feed's read cache, and receiveFanout applied the
    // cells to the mirror BEFORE pushing the frame, so this read is fresh.
    const cellAtB = (await pageB.evaluate((key) => window.wooCell(key), WAVES_CELL)) as {
      value?: { value?: number };
    } | null;
    expect(cellAtB?.value?.value).toBe(wavesAfterA);

    // A sees its own result WITHOUT duplication: exactly one waved entry
    // (the reply's source:"self"), no peer frame for its own turn. B's
    // receipt above proves the fanout landed; give a stray echo a beat.
    await pageA.waitForTimeout(500);
    await expect(pageA.locator('#events li[data-type="waved"]')).toHaveCount(1);
    await expect(pageA.locator('#events li[data-source="self"][data-type="waved"]')).toContainText(
      `"waves":${wavesAfterA}`
    );

    // ---- direction 2 (the REVERSE): B acts, A sees ------------------------
    const waveB = await runTurn(pageB, "net_lane_annex", "wave");
    expect(waveB.status).toBe("accepted");
    const wavesAfterB = waveB.result as number;
    expect(wavesAfterB).toBe(wavesAfterA + 1); // sequenced on one authority

    const peerAtA = pageA.locator('#events li[data-source="peer"][data-type="waved"]');
    await expect(peerAtA).toHaveCount(1, { timeout: 20_000 });
    await expect(peerAtA).toContainText(`"waves":${wavesAfterB}`);

    const cellAtA = (await pageA.evaluate((key) => window.wooCell(key), WAVES_CELL)) as {
      value?: { value?: number };
    } | null;
    expect(cellAtA?.value?.value).toBe(wavesAfterB);

    // B without duplication: its own wave arrived as source:"self" only —
    // B now shows exactly two waved entries (A's as peer, its own as self).
    await pageB.waitForTimeout(500);
    await expect(pageB.locator('#events li[data-type="waved"]')).toHaveCount(2);
    await expect(pageB.locator('#events li[data-source="self"][data-type="waved"]')).toContainText(
      `"waves":${wavesAfterB}`
    );
  } finally {
    await Promise.allSettled([contextA.close(), contextB.close()]);
  }
});
