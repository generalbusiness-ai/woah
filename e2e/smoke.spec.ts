import { test, expect, type APIRequestContext, type Locator } from "@playwright/test";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function boxKey(locator: Locator): Promise<string> {
  const box = await locator.boundingBox();
  return box ? `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}` : "";
}

async function authHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const response = await request.post("/api/auth", { data: { token: `guest:e2e-${crypto.randomUUID()}` } });
  const body = await response.json();
  return { authorization: `Session ${body.session}` };
}

test("loads shell and renders nav", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => consoleErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto("/");

  await expect(page.locator(".brand")).toHaveText("Woo");
  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pinboard" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dubspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Taskspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "IDE" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat" })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: "Enter" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Leave" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Look" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Who" })).toHaveCount(0);
  await expect(page.locator(".chat-form")).toBeHidden();

  // Wait for the websocket session to bind an actor — the actor field
  // starts as "connecting..." and updates once op:"session" arrives.
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });

  expect(consoleErrors, `console/page errors: ${consoleErrors.join(" | ")}`).toEqual([]);
});

test("chat route mounts bundled UI while state is still cold-starting", async ({ page }) => {
  let releaseState: (() => void) | undefined;
  let delayedState = false;
  const stateGate = new Promise<void>((resolve) => {
    releaseState = resolve;
  });
  await page.route("**/api/state", async (route) => {
    if (!delayedState) {
      delayedState = true;
      await stateGate;
    }
    await route.continue();
  });

  await page.goto("/objects/the_chatroom");
  await page.getByRole("button", { name: "Continue as guest" }).click({ timeout: 1_000 }).catch(() => undefined);
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });
  await expect(page.getByText("No chat UI is registered for this room.")).toHaveCount(0);
  await expect(page.locator("woo-chat-space[data-chat-space-host]")).toBeAttached();
  await expect(page.locator(".chat-empty-panel")).toBeVisible();
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("button", { name: "Leave" })).toBeVisible({ timeout: 5_000 });

  releaseState?.();
  await expect(page.locator("[data-chat-input]")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("No chat UI is registered for this room.")).toHaveCount(0);
});

test("browser worker receives initial v2 projection", async ({ page, request }) => {
  let v2ProjectionEvents = 0;
  await page.exposeFunction("recordV2ProjectionEvent", () => {
    v2ProjectionEvents += 1;
  });
  await page.addInitScript(() => {
    window.addEventListener("woo.v2.projection", () => {
      void (window as unknown as { recordV2ProjectionEvent: () => Promise<void> }).recordV2ProjectionEvent();
    });
  });

  const auth = await request.post("/api/auth", { data: { token: `guest:e2e-v2-browser-${crypto.randomUUID()}` } });
  const session = String((await auth.json())?.session ?? "");
  await page.goto("/");
  await page.evaluate((sessionId) => {
    localStorage.setItem("woo.session", sessionId);
  }, session);
  await page.goto("/objects/the_chatroom");
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });

  await expect.poll(() => v2ProjectionEvents, { timeout: 5_000 }).toBeGreaterThan(0);
});

test("chat boot uses /api/me and moves without /api/state", async ({ page }) => {
  const stateCalls: string[] = [];
  await page.route("**/api/state", async (route) => {
    stateCalls.push(route.request().url());
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "E_TEST", message: "/api/state should not be used by scoped chat" } })
    });
  });

  await page.goto("/objects/the_chatroom");
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });
  await expect(page.getByText("No chat UI is registered for this room.")).toHaveCount(0);
  await expect(page.locator("woo-chat-space[data-chat-space-host]")).toBeAttached();

  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("button", { name: "Leave" })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".toolbar h1")).toHaveText("Living Room");
  await expect(page.locator("[data-chat-input]")).toBeFocused();

  await page.locator("[data-chat-input]").fill("se");
  await page.locator("[data-chat-input]").press("Enter");
  await expect(page.locator(".toolbar h1")).toHaveText("Deck", { timeout: 5_000 });
  await expect(page.locator("[data-chat-input]")).toBeFocused();
  await expect(page.locator(".chat-feed")).toContainText("se");

  await page.locator("[data-chat-input]").fill("west");
  await page.locator("[data-chat-input]").press("Enter");
  await expect(page.locator(".toolbar h1")).toHaveText("Living Room", { timeout: 5_000 });
  await expect(page.locator("[data-chat-input]")).toBeFocused();
  expect(stateCalls).toEqual([]);
});

test("switches between tabs", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });

  await page.getByRole("button", { name: "Dubspace" }).click();
  await expect(page.getByRole("button", { name: "Dubspace" })).toHaveClass(/active/);

  await page.getByRole("button", { name: "Pinboard" }).click();
  await expect(page.getByRole("button", { name: "Pinboard" })).toHaveClass(/active/);
  await expect(page.locator(".pinboard-stage")).toBeVisible();

  await page.getByRole("button", { name: "Taskspace" }).click();
  await expect(page.getByRole("button", { name: "Taskspace" })).toHaveClass(/active/);

  await page.getByRole("button", { name: "IDE" }).click();
  await expect(page.getByRole("button", { name: "IDE" })).toHaveClass(/active/);

  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page.getByRole("button", { name: "Chat" })).toHaveClass(/active/);
});

test("tool tabs load scoped overlays without /api/state", async ({ page }) => {
  const stateCalls: string[] = [];
  await page.route("**/api/state", async (route) => {
    stateCalls.push(route.request().url());
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "E_TEST", message: "/api/state should not be used by scoped overlays" } })
    });
  });

  await page.goto("/");
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });

  await page.getByRole("button", { name: "Dubspace" }).click();
  await expect(page.locator(".toolbar h1")).toHaveText("Dubspace", { timeout: 5_000 });
  try {
    await page.getByRole("button", { name: "Enter" }).click({ timeout: 1_000 });
  } catch {
    // Already at the controls.
  }
  await expect(page.getByRole("button", { name: "Leave" })).toBeVisible();
  await expect(page.locator("[data-space-chat-input]")).toBeVisible();
  const dubspaceMiniChat = page.locator("woo-space-chat-panel[data-space-chat-panel]");
  const initialMiniChatHeight = await dubspaceMiniChat.evaluate((element) => element.getBoundingClientRect().height);
  expect(initialMiniChatHeight).toBeGreaterThanOrEqual(220);
  await page.locator('[aria-label="Filter cutoff"]').evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "640";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator('[aria-label="Filter cutoff"]')).toHaveValue("640");
  const postFilterMiniChatHeight = await dubspaceMiniChat.evaluate((element) => element.getBoundingClientRect().height);
  expect(postFilterMiniChatHeight).toBeGreaterThanOrEqual(initialMiniChatHeight - 1);

  await page.getByRole("button", { name: "Pinboard" }).click();
  await expect(page.locator(".pinboard-stage")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "Leave" })).toBeVisible();

  await page.getByRole("button", { name: "Taskspace" }).click();
  await expect(page.getByRole("button", { name: "Taskspace" })).toHaveClass(/active/);
  await expect(page.locator(".task-create")).toBeVisible({ timeout: 5_000 });
  expect(stateCalls).toEqual([]);
});

test("dubspace cue keeps loop controls local", async ({ page, request }) => {
  const sentFrames: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", (frame) => sentFrames.push(String(frame.payload)));
  });

  await page.goto("/");
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });
  await page.getByRole("button", { name: "Dubspace" }).click();
  await expect(page.getByRole("button", { name: "Leave" })).toBeVisible();
  const miniChatInput = page.locator("[data-space-chat-input]");
  await expect(miniChatInput).toBeVisible();
  await expect(miniChatInput).toBeFocused();
  await expect(page.locator("woo-space-chat-panel .space-chat-head span")).toHaveText("Dubspace");
  await miniChatInput.fill("filter 500");
  await miniChatInput.press("Enter");
  await expect(page.locator("woo-space-chat-panel .chat-line.input")).toContainText("filter 500");
  await expect(page.locator('[aria-label="Filter cutoff"]')).toHaveValue("500");
  await expect(page.locator(".filter-strip [data-control-readout]")).toHaveText("500 Hz");
  await expect(page.locator(".dubspace-presence")).toContainText("Guest");
  await expect(page.locator("[data-audio]")).toHaveText("Audio Off");
  await page.locator("[data-audio]").click();
  await expect(page.locator("[data-audio]")).toHaveText("Audio On");
  await page.locator("[data-audio]").click();
  await expect(page.locator("[data-audio]")).toHaveText("Audio Off");
  await expect(page.locator(".loop-strip")).toHaveCount(4);
  await expect(page.locator(".vertical-fader")).toHaveCount(5);
  await expect(page.locator('[aria-label="Filter cutoff"]')).toBeVisible();

  const headers = await authHeaders(request);
  const before = await request.get("/api/state", { headers }).then((response) => response.json());
  const beforeSlot = before.objects.slot_1.props;
  const localSemitone = Number(beforeSlot.freq ?? 110) === 440 ? 25 : 24;
  const localFreq = Number((110 * Math.pow(2, localSemitone / 12)).toFixed(2));
  const localGain = Number(beforeSlot.gain ?? 0.75) === 0.11 ? 0.22 : 0.11;

  await page.locator('[data-cue-slot="slot_1"]').click();
  await expect(page.locator('[data-cue-slot="slot_1"]')).toHaveAttribute("aria-pressed", "true");
  sentFrames.length = 0;

  await expect(page.locator('[data-loop="slot_1"]')).toHaveText("Stop");
  await page.locator('[data-loop="slot_1"]').click();
  await expect(page.locator('[data-loop="slot_1"]')).toHaveText("Start");
  expect(sentFrames.some((frame) => frame.includes("start_loop") || frame.includes("stop_loop"))).toBe(false);

  await page.locator('[data-control][data-target="slot_1"][data-name="freq"]').evaluate((element, value) => {
    const input = element as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, localSemitone);
  await page.locator('[data-control][data-target="slot_1"][data-name="gain"]').evaluate((element, value) => {
    const input = element as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, localGain);
  await page.waitForTimeout(100);

  expect(sentFrames.some((frame) => frame.includes("preview_control") || frame.includes("set_control"))).toBe(false);
  const after = await request.get("/api/state", { headers }).then((response) => response.json());
  expect(after.objects.slot_1.props.freq ?? 110).toBe(beforeSlot.freq ?? 110);
  expect(after.objects.slot_1.props.gain).toBe(beforeSlot.gain);

  sentFrames.length = 0;
  await page.locator('[data-cue-slot="slot_1"]').click();
  await expect(page.locator('[data-cue-slot="slot_1"]')).toHaveAttribute("aria-pressed", "false");
  expect(sentFrames.some((frame) => frame.includes("set_control"))).toBe(true);
  await expect
    .poll(async () => {
      const current = await request.get("/api/state", { headers }).then((response) => response.json());
      return current.objects.slot_1.props;
    })
    .toMatchObject({ freq: localFreq, gain: localGain });

  await miniChatInput.fill("out");
  await miniChatInput.press("Enter");
  await expect(page).toHaveURL(/\/objects\/the_chatroom$/);
  await expect(page.locator(".toolbar h1")).toHaveText("Living Room");
  await expect(page.getByText("No chat UI is registered for this room.")).toHaveCount(0);
  await expect(page.locator("woo-chat-space .chat-line.separator")).toHaveCount(1);
});

test("narrow layout keeps nav tabs on one row", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto("/");
  await expect(page.locator(".actor")).toHaveCount(1);

  const nav = page.locator(".nav");
  const tabs = page.locator(".nav-button");
  await expect(tabs).toHaveCount(5);

  const metrics = await nav.evaluate((element) => {
    const navRect = element.getBoundingClientRect();
    const tabRects = Array.from(element.querySelectorAll(".nav-button")).map((tab) => tab.getBoundingClientRect());
    return {
      navHeight: navRect.height,
      sameRow: tabRects.every((rect) => Math.abs(rect.top - tabRects[0].top) < 2),
      withinWidth: tabRects[tabRects.length - 1].right <= navRect.right + 1
    };
  });

  expect(metrics.sameRow).toBe(true);
  expect(metrics.withinWidth).toBe(true);
  expect(metrics.navHeight).toBeLessThan(56);
});

test("pinboard supports shared text notes", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });

  await page.getByRole("button", { name: "Pinboard" }).click();
  await expect(page.getByRole("button", { name: "Pinboard" })).toHaveClass(/active/);
  await expect(page.locator(".pinboard-stage")).toBeVisible();
  await expect(page.locator("[data-pinboard-map]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Leave" })).toBeVisible();
  const firstPaintStageHeights = await page.locator(".pinboard-stage-panel").evaluate(async (panel) => {
    const samples: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(panel.getBoundingClientRect().height);
    }
    return samples;
  });
  expect(Math.min(...firstPaintStageHeights)).toBeGreaterThan(300);
  expect(Math.max(...firstPaintStageHeights) - Math.min(...firstPaintStageHeights)).toBeLessThan(80);
  const pinboardHeights = await page.locator(".pinboard-layout").evaluate((layout) => {
    const stage = layout.querySelector(".pinboard-stage-panel");
    const presence = layout.querySelector(".pinboard-presence");
    return {
      stage: stage?.getBoundingClientRect().height ?? 0,
      presence: presence?.getBoundingClientRect().height ?? 0
    };
  });
  expect(pinboardHeights.stage).toBeGreaterThan(300);
  expect(pinboardHeights.stage).toBeGreaterThan(pinboardHeights.presence * 0.85);
  await expect(page.locator("woo-space-chat-panel[data-space-chat-panel]")).toBeVisible();
  const miniChatInput = page.locator("[data-space-chat-input]");
  await expect(miniChatInput).toBeVisible();
  await expect(miniChatInput).toBeFocused();
  await expect(page.locator("woo-space-chat-panel .space-chat-head span")).toHaveText("Pinboard");
  await miniChatInput.fill("look");
  await miniChatInput.press("Enter");
  await expect(page.locator("woo-space-chat-panel .chat-line.input")).toContainText("look");

  await page.locator("[data-pinboard-new-text]").fill("Bring the towel to the hot tub");
  await page.locator("[data-pinboard-new-color]").selectOption("blue");
  await page.locator("[data-pinboard-create]").getByRole("button", { name: "Add Note" }).click();
  await expect(page.locator(".pin-note")).toHaveCount(1);
  await expect(page.locator(".pinboard-stage")).toContainText("Bring the towel to the hot tub");

  await page.locator("[data-pinboard-new-text]").fill("Bring the mug too");
  await page.locator("[data-pinboard-new-color]").selectOption("yellow");
  await page.locator("[data-pinboard-create]").getByRole("button", { name: "Add Note" }).click();
  await expect(page.locator(".pin-note")).toHaveCount(2);
  await expect(page.locator(".pinboard-stage")).toContainText("Bring the towel to the hot tub");
  await expect(page.locator(".pinboard-stage")).toContainText("Bring the mug too");

  await page.locator("[data-pin-note-text]").first().fill("Towel is ready");
  await page.locator("[data-pin-note-text]").first().blur();
  await expect(page.locator(".pinboard-stage")).toContainText("Towel is ready");
  await expect(page.locator(".pinboard-stage")).toContainText("Bring the mug too");
});

test("pinboard supports local zoom and pan without resetting on updates", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });

  await page.getByRole("button", { name: "Pinboard" }).click();
  await expect(page.getByRole("button", { name: "Pinboard" })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: "Leave" })).toBeVisible();
  await expect(page.locator("[data-pinboard-zoom-label]")).toHaveText("100%");
  const stagePanelGap = await page.locator(".pinboard-stage-panel").evaluate((panel) => {
    const stage = panel.querySelector(".pinboard-stage");
    if (!stage) return Number.POSITIVE_INFINITY;
    const panelRect = panel.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    return Math.abs(panelRect.bottom - stageRect.bottom);
  });
  expect(stagePanelGap).toBeLessThan(2);
  const initialGrid = await page.locator("[data-pinboard-stage]").evaluate((element) => ({
    size: getComputedStyle(element).backgroundSize,
    position: getComputedStyle(element).backgroundPosition
  }));

  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.locator("[data-pinboard-canvas]")).toHaveClass(/viewport-animating/);
  await expect(page.locator("[data-pinboard-zoom-label]")).toHaveText("120%");
  await expect(page.locator("[data-pinboard-canvas]")).not.toHaveClass(/viewport-animating/);
  const zoomedTransform = await page.locator("[data-pinboard-canvas]").evaluate((element) => getComputedStyle(element).transform);
  const zoomedGrid = await page.locator("[data-pinboard-stage]").evaluate((element) => ({
    size: getComputedStyle(element).backgroundSize,
    position: getComputedStyle(element).backgroundPosition
  }));
  expect(zoomedGrid.size).not.toBe(initialGrid.size);

  await page.locator(".pinboard-stage").hover();
  await page.mouse.wheel(80, 48);
  const pannedTransform = await page.locator("[data-pinboard-canvas]").evaluate((element) => getComputedStyle(element).transform);
  const pannedGrid = await page.locator("[data-pinboard-stage]").evaluate((element) => getComputedStyle(element).backgroundPosition);
  expect(pannedTransform).not.toBe(zoomedTransform);
  expect(pannedGrid).not.toBe(zoomedGrid.position);

  const mapBox = await page.locator("[data-pinboard-map]").boundingBox();
  if (!mapBox) throw new Error("pinboard overview missing");
  await page.mouse.click(mapBox.x + mapBox.width * 0.78, mapBox.y + mapBox.height * 0.22);
  await expect(page.locator("[data-pinboard-canvas]")).toHaveClass(/viewport-animating/);
  await expect.poll(async () => page.locator("[data-pinboard-canvas]").evaluate((element) => getComputedStyle(element).transform)).not.toBe(pannedTransform);
  await expect(page.locator("[data-pinboard-canvas]")).not.toHaveClass(/viewport-animating/);
  const mapCenteredTransform = await page.locator("[data-pinboard-canvas]").evaluate((element) => getComputedStyle(element).transform);

  const centeredText = `Viewport stable ${Date.now()}`;
  await page.locator("[data-pinboard-new-text]").fill(centeredText);
  await page.locator("[data-pinboard-create]").getByRole("button", { name: "Add Note" }).click();
  await expect(page.locator("[data-pinboard-zoom-label]")).toHaveText("120%");
  await expect.poll(async () => page.locator("[data-pinboard-canvas]").evaluate((element) => getComputedStyle(element).transform)).toBe(mapCenteredTransform);
  const centeredNote = page.locator(".pin-note").filter({ hasText: centeredText }).first();
  await expect(centeredNote).toBeVisible();
  const centeredDelta = await centeredNote.evaluate((note) => {
    const stage = note.closest(".pinboard-stage");
    if (!stage) return Number.POSITIVE_INFINITY;
    const noteRect = note.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const dx = Math.abs(noteRect.left + noteRect.width / 2 - (stageRect.left + stageRect.width / 2));
    const dy = Math.abs(noteRect.top + noteRect.height / 2 - (stageRect.top + stageRect.height / 2));
    return Math.max(dx, dy);
  });
  expect(centeredDelta).toBeLessThan(8);

  const handle = centeredNote.locator("[data-pin-note-drag]");
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("pin note drag handle missing");
  const beforeX = Number(await centeredNote.getAttribute("data-x"));
  const beforeY = Number(await centeredNote.getAttribute("data-y"));
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 - (beforeX + 160) * 1.2, handleBox.y + handleBox.height / 2 - (beforeY + 120) * 1.2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Number(await centeredNote.getAttribute("data-x"))).toBeLessThan(0);
  await expect.poll(async () => Number(await centeredNote.getAttribute("data-y"))).toBeLessThan(0);
});

test("pinboard animates note movement from another user", async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  try {
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    await Promise.all([first.goto("/"), second.goto("/")]);
    await expect(first.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });
    await expect(second.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });

    await first.getByRole("button", { name: "Pinboard" }).click();
    await second.getByRole("button", { name: "Pinboard" }).click();
    await expect(first.getByRole("button", { name: "Leave" })).toBeVisible();
    await expect(second.getByRole("button", { name: "Leave" })).toBeVisible();

    const text = `Slide this note ${Date.now()}`;
    const beforeCount = await second.locator(".pin-note").count();
    await first.locator("[data-pinboard-new-text]").fill(text);
    await first.locator("[data-pinboard-create]").getByRole("button", { name: "Add Note" }).click();
    await expect(second.locator(".pin-note")).toHaveCount(beforeCount + 1);
    const firstNote = first.locator(".pin-note").filter({ hasText: text }).first();
    const secondNote = second.locator(".pin-note").filter({ hasText: text }).first();
    await expect(secondNote).toBeVisible();
    const beforeX = Number(await secondNote.getAttribute("data-x"));

    const handle = firstNote.locator("[data-pin-note-drag]");
    const box = await handle.boundingBox();
    if (!box) throw new Error("pin note drag handle missing");
    await first.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await first.mouse.down();
    await first.mouse.move(box.x + box.width / 2 + 96, box.y + box.height / 2 + 54, { steps: 4 });
    await first.mouse.up();

    await expect(second.locator(".pin-note-animating").filter({ hasText: text })).toHaveCount(1);
    await expect.poll(async () => Number(await secondNote.getAttribute("data-x"))).toBeGreaterThan(beforeX);
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test("pinboard shares viewport presence overlays", async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  try {
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    await Promise.all([first.goto("/"), second.goto("/")]);
    await expect(first.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });
    await expect(second.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });
    const firstActor = (await first.locator(".actor").textContent())?.trim() ?? "";

    await first.getByRole("button", { name: "Pinboard" }).click();
    await second.getByRole("button", { name: "Pinboard" }).click();
    await expect(first.getByRole("button", { name: "Leave" })).toBeVisible();
    await expect(second.getByRole("button", { name: "Leave" })).toBeVisible();

    await first.getByRole("button", { name: "Zoom in" }).click();
    const overlay = second.locator(`[data-pinboard-viewport="${firstActor}"]`);
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveAttribute("title", /Guest|guest_/);
    await expect.poll(async () => boxKey(overlay)).not.toBe("");
    const before = await boxKey(overlay);
    await overlay.evaluate((element) => { (element as HTMLElement).dataset.stableMarker = "kept"; });

    await first.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(async () => boxKey(overlay)).not.toBe(before);
    await expect.poll(async () => overlay.evaluate((element) => (element as HTMLElement).dataset.stableMarker ?? "")).toBe("kept");

    await first.getByRole("button", { name: "Leave" }).click();
    await expect(overlay).toHaveCount(0);
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test("chat controls follow room membership", async ({ page }) => {
  await page.goto("/?api=state");
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });
  const actor = (await page.locator(".actor").textContent())?.trim() ?? "";

  await expect(page.locator(".toolbar h1")).toHaveText("Living Room");
  await expect(page.getByRole("button", { name: "Enter" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enter" })).toBeEnabled();
  await expect(page.locator(".chat-form")).toBeHidden();

  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("button", { name: "Leave" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Look" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Who" })).toHaveCount(0);
  await expect(page.locator(".chat-form")).toBeVisible();
  await expect(page.locator(".presence-list")).toContainText(actor);
  await expect(page.locator("[data-chat-input]")).toBeFocused();

  const chatFitsViewport = await page.locator(".chat-layout").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom <= window.innerHeight + 1 && rect.height > 0;
  });
  expect(chatFitsViewport).toBe(true);

  await page.locator("[data-chat-input]").fill("draft text");
  await page.getByRole("button", { name: "Look" }).click();
  await expect(page.locator("[data-chat-input]")).toBeFocused();
  await expect(page.locator("[data-chat-input]")).toHaveValue("draft text");

  await page.locator("[data-chat-input]").fill("take foo");
  await page.locator("[data-chat-input]").press("Enter");
  await expect(page.locator(".chat-feed")).toContainText("I don't see \"foo\" here.");
  await expect(page.locator("[data-chat-input]")).toBeFocused();

  await page.locator("[data-chat-input]").fill("se");
  await page.locator("[data-chat-input]").press("Enter");
  await expect(page.locator(".toolbar h1")).toHaveText("Deck", { timeout: 5_000 });
  await expect(page.locator("[data-chat-input]")).toBeFocused();
  await expect(page.locator(".chat-feed")).toContainText("wooden deck");
  await expect(page.locator(".chat-feed")).not.toContainText("You go to");

  await page.getByRole("button", { name: "Leave" }).click();
  await expect(page.getByRole("button", { name: "Enter" })).toBeVisible();
  await expect(page.locator(".chat-form")).toBeHidden();
  await expect(page.getByRole("button", { name: "Who" })).toHaveCount(0);
});

test("chat room transitions broadcast through source and destination rooms", async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  try {
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();

    await Promise.all([first.goto("/"), second.goto("/")]);
    await expect(first.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });
    await expect(second.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });
    const firstActor = (await first.locator(".actor").textContent())?.trim() ?? "";
    const secondActor = (await second.locator(".actor").textContent())?.trim() ?? "";
    const firstName = firstActor.replace(/^guest_(\d+)$/, "Guest $1");
    const secondName = secondActor.replace(/^guest_(\d+)$/, "Guest $1");

    await first.getByRole("button", { name: "Enter" }).click();
    await expect(first.getByRole("button", { name: "Leave" })).toBeVisible();
    await second.getByRole("button", { name: "Enter" }).click();
    await expect(second.getByRole("button", { name: "Leave" })).toBeVisible();
    await expect(second.locator(`[data-chat-recipient="${firstActor}"]`)).toBeVisible();
    await expect(second.locator(`[data-chat-recipient="${secondActor}"]`)).toBeVisible();

    await second.locator("[data-chat-input]").fill("se");
    await second.locator("[data-chat-input]").press("Enter");
    await expect(second.locator(".toolbar h1")).toHaveText("Deck", { timeout: 5_000 });
    await expect(second.locator(".chat-feed")).toContainText("wooden deck");
    await expect(second.locator(".chat-feed")).not.toContainText("You go to");
    await expect(first.locator(".chat-feed")).toContainText(`${secondName} goes southeast.`);
    await expect(first.locator(`[data-chat-recipient="${secondActor}"]`)).toHaveCount(0);

    await second.locator("[data-chat-input]").fill("west");
    await second.locator("[data-chat-input]").press("Enter");
    await expect(second.locator(".toolbar h1")).toHaveText("Living Room", { timeout: 5_000 });
    await expect(second.locator(".chat-feed")).toContainText("bright, open living room");
    await expect(first.locator(".chat-feed")).toContainText(`${secondName} has arrived.`);
    await expect(first.locator(`[data-chat-recipient="${secondActor}"]`)).toBeVisible();

    await first.getByRole("button", { name: "Leave" }).click();
    await expect(first.getByRole("button", { name: "Enter" })).toBeVisible();
    await expect(second.locator(".chat-feed")).toContainText(`${firstName} left.`);
    await expect(second.locator(`[data-chat-recipient="${firstActor}"]`)).toHaveCount(0);
    await expect(second.locator(`[data-chat-recipient="${secondActor}"]`)).toBeVisible();
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test("dubspace controls advertise operators to the living room", async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  try {
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();

    await Promise.all([first.goto("/"), second.goto("/")]);
    await expect(first.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });
    await expect(second.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });
    const secondActor = (await second.locator(".actor").textContent())?.trim() ?? "";
    const secondName = secondActor.replace(/^guest_(\d+)$/, "Guest $1");

    await first.getByRole("button", { name: "Enter" }).click();
    await expect(first.getByRole("button", { name: "Leave" })).toBeVisible();
    await second.getByRole("button", { name: "Enter" }).click();
    await expect(second.getByRole("button", { name: "Leave" })).toBeVisible();

    await second.getByRole("button", { name: "Dubspace" }).click();
    await expect(second.locator(".dubspace-presence")).toContainText(secondActor);
    await expect(first.locator(".chat-feed")).toContainText(`${secondName} steps up to Dubspace.`);

    await second.getByRole("button", { name: "Chat" }).click();
    await expect(first.locator(".chat-feed")).toContainText(`${secondName} steps away from Dubspace.`);
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test("chat command enters dubspace UI", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });
  await expect(page.getByRole("button", { name: "Enter" })).toBeVisible();
  const actor = (await page.locator(".actor").textContent())?.trim() ?? "";

  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("button", { name: "Leave" })).toBeVisible();
  await page.locator("[data-chat-input]").fill("enter dubspace");
  await page.locator("[data-chat-input]").press("Enter");

  await expect(page.getByRole("button", { name: "Dubspace" })).toHaveClass(/active/);
  await expect(page.locator(".dubspace-presence")).toContainText(actor);
  await expect(page.getByRole("button", { name: "Leave" })).toBeVisible();
});

test("taskspace supports hierarchical task workflow", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 5_000 });
  const actor = (await page.locator(".actor").textContent())?.trim() ?? "";
  const actorName = actor.replace(/^guest_(\d+)$/, "Guest $1");
  const actorText = new RegExp(`${escapeRegex(actor)}|${escapeRegex(actorName)}`);
  const suffix = Date.now();
  const rootTitle = `E2E root ${suffix}`;
  const subTitle = `E2E sub ${suffix}`;
  const requirement = `E2E requirement ${suffix}`;
  const message = `E2E message ${suffix}`;
  const artifact = `https://example.com/e2e-${suffix}`;

  await page.getByRole("button", { name: "Taskspace" }).click();
  await expect(page.locator('[data-task-status="open"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-task-status="done"]')).toHaveAttribute("aria-pressed", "false");
  await page.getByPlaceholder("Root task title").fill(rootTitle);
  await page.locator(".task-create").getByPlaceholder("Description").fill("Root task from browser smoke");
  await page.locator(".task-create").getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".inspector h2")).toHaveText(rootTitle, { timeout: 5_000 });

  const inspector = page.locator(".inspector");
  await inspector.getByRole("button", { name: "Claim" }).click();
  await expect(inspector).toContainText(actorText);
  await inspector.getByRole("button", { name: "In Progress" }).click();
  await expect(inspector.locator(".status-pill").first()).toContainText("in progress");

  const session = await page.evaluate(() => localStorage.getItem("woo.session"));
  expect(session).toBeTruthy();
  await inspector.getByPlaceholder("Subtask title").fill(`${subTitle} draft`);
  await expect(inspector.getByPlaceholder("Subtask title")).toBeFocused();
  await request.post("/api/objects/the_taskspace/calls/create_task", {
    headers: { authorization: `Session ${session}` },
    data: { space: "the_taskspace", args: [`E2E focus churn ${suffix}`, "external refresh while editing"] }
  });
  await expect(inspector.getByPlaceholder("Subtask title")).toHaveValue(`${subTitle} draft`);
  await expect(inspector.getByPlaceholder("Subtask title")).toBeFocused();

  await inspector.getByPlaceholder("Subtask title").fill(subTitle);
  await inspector.getByPlaceholder("Description").fill("Subtask from browser smoke");
  await inspector.getByRole("button", { name: "Add" }).first().click();
  await expect(page.locator(".tree")).toContainText(subTitle);
  await expect(page.locator(".inspector h2")).toHaveText(subTitle);

  await inspector.getByPlaceholder("Requirement").fill(requirement);
  await page.locator("[data-add-requirement]").click();
  await expect(inspector.locator(".checklist")).toContainText(requirement);
  await inspector.getByLabel(requirement).check();
  await expect(inspector.getByLabel(requirement)).toBeChecked();
  await expect(inspector).toContainText("1/1");

  await inspector.getByPlaceholder("Message").fill(message);
  await page.locator("[data-add-message]").click();
  await expect(inspector.locator(".activity-list")).toContainText(message);

  await inspector.getByPlaceholder("https://example.com/artifact").fill(artifact);
  await page.locator("[data-add-artifact]").click();
  await expect(inspector.locator(".artifact-list")).toContainText(artifact);

  await inspector.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".tree")).not.toContainText(subTitle);
  await page.locator('[data-task-status="done"]').click();
  await expect(page.locator(".tree")).toContainText(subTitle);
});

test("REST runtime API supports auth, calls, properties, and logs", async ({ request }) => {
  const suffix = Date.now();
  const auth = await request.post("/api/auth", { data: { token: `guest:rest-${suffix}` } });
  expect(auth.ok()).toBe(true);
  const session = await auth.json();
  expect(session.actor).toMatch(/^guest_/);
  expect(session.session).toMatch(/^session-/);
  const headers = { Authorization: `Session ${session.session}` };
  const wizardAuth = await request.post("/api/auth", { data: { token: `wizard:${process.env.WOO_INITIAL_WIZARD_TOKEN ?? "e2e-wizard"}` } });
  expect(wizardAuth.ok()).toBe(true);
  const wizardSession = await wizardAuth.json();
  const wizardHeaders = { Authorization: `Session ${wizardSession.session}` };

  const describe = await request.get("/api/objects/the_taskspace", { headers });
  expect(describe.ok()).toBe(true);
  const described = await describe.json();
  expect(described.id).toBe("the_taskspace");
  expect(described.verbs).toContain("create_task");

  const roots = await request.get("/api/objects/the_taskspace/properties/root_tasks", { headers });
  expect(roots.ok()).toBe(true);
  const rootProperty = await roots.json();
  expect(rootProperty.name).toBe("root_tasks");
  expect(Array.isArray(rootProperty.value)).toBe(true);

  const privateName = `private_rest_${suffix}`;
  const definePrivate = await request.post("/api/property", {
    headers: wizardHeaders,
    data: {
      object: "the_taskspace",
      name: privateName,
      default: "classified",
      perms: "w",
      expected_version: null,
      type_hint: "str"
    }
  });
  expect(definePrivate.ok()).toBe(true);
  const privateDescribe = await request.get("/api/objects/the_taskspace", { headers });
  expect((await privateDescribe.json()).properties).toContain(privateName);
  const privateRead = await request.get(`/api/objects/the_taskspace/properties/${privateName}`, { headers });
  expect(privateRead.status()).toBe(403);
  expect((await privateRead.json()).error.code).toBe("E_PERM");

  const denied = await request.post("/api/objects/the_taskspace/calls/create_task", {
    headers,
    data: { args: [`REST denied ${suffix}`, "missing space"] }
  });
  expect(denied.status()).toBe(403);
  expect((await denied.json()).error.code).toBe("E_DIRECT_DENIED");

  const forceDenied = await request.post("/api/objects/the_taskspace/calls/create_task", {
    headers: { ...headers, "X-Woo-Force-Direct": "1" },
    data: { args: [`REST force denied ${suffix}`, "non-wizard force"] }
  });
  expect(forceDenied.status()).toBe(403);
  expect((await forceDenied.json()).error.code).toBe("E_PERM");

  const create = await request.post("/api/objects/the_taskspace/calls/create_task", {
    headers,
    data: {
      id: `rest-create-${suffix}`,
      space: "the_taskspace",
      args: [`REST root ${suffix}`, "created through REST"]
    }
  });
  expect(create.ok()).toBe(true);
  const frame = await create.json();
  expect(frame.op).toBe("applied");
  expect(frame.space).toBe("the_taskspace");
  expect(frame.message.actor).toBe(session.actor);
  expect(frame.message.verb).toBe("create_task");
  expect(frame.observations[0].type).toBe("task_created");

  const retry = await request.post("/api/objects/the_taskspace/calls/create_task", {
    headers,
    data: {
      id: `rest-create-${suffix}`,
      space: "the_taskspace",
      args: [`REST root ${suffix}`, "created through REST"]
    }
  });
  expect(await retry.json()).toEqual(frame);

  const log = await request.get(`/api/objects/the_taskspace/log?from=${frame.seq}&limit=1`, { headers });
  expect(log.ok()).toBe(true);
  const logged = await log.json();
  expect(logged.messages).toHaveLength(1);
  expect(logged.messages[0].seq).toBe(frame.seq);
  expect(logged.messages[0].message.verb).toBe("create_task");
  expect(logged.messages[0].observations[0].type).toBe("task_created");

  const compat = await request.post("/api/objects/the_taskspace/calls/call", {
    headers,
    data: {
      id: `rest-compat-${suffix}`,
      args: [{ target: "the_taskspace", verb: "create_task", args: [`REST compat ${suffix}`, "created through $space:call route"] }]
    }
  });
  expect(compat.ok()).toBe(true);
  const compatFrame = await compat.json();
  expect(compatFrame.op).toBe("applied");
  expect(compatFrame.space).toBe("the_taskspace");
  expect(compatFrame.message.verb).toBe("create_task");

  const enter = await request.post("/api/objects/the_chatroom/calls/enter", { headers, data: { args: [] } });
  expect(enter.ok()).toBe(true);
  const direct = await enter.json();
  expect(direct.observations[0].type).toBe("entered");

  const me = await request.get("/api/objects/%24me", { headers });
  expect(me.ok()).toBe(true);
  expect((await me.json()).id).toBe(session.actor);
});

test("REST SSE stream receives sequenced applied frames", async ({ request }) => {
  const suffix = Date.now();
  const auth = await request.post("/api/auth", { data: { token: `guest:sse-${suffix}` } });
  expect(auth.ok()).toBe(true);
  const session = await auth.json();
  const headers = { Authorization: `Session ${session.session}` };
  const baseUrl = `http://localhost:${process.env.PORT ?? 5173}`;

  const stream = await fetch(`${baseUrl}/api/objects/the_taskspace/stream`, { headers });
  expect(stream.status).toBe(200);
  expect(stream.body).not.toBeNull();
  const reader = stream.body!.getReader();
  const streamText = readSseUntil(reader, "event: applied", 5_000);

  const create = await request.post("/api/objects/the_taskspace/calls/create_task", {
    headers,
    data: {
      id: `rest-sse-${suffix}`,
      space: "the_taskspace",
      args: [`REST SSE ${suffix}`, "created while streaming"]
    }
  });
  expect(create.ok()).toBe(true);
  const frame = await create.json();
  const text = await streamText;
  await reader.cancel();

  expect(text).toContain(`id: the_taskspace:${frame.seq}`);
  expect(text).toContain("event: applied");
  expect(text).toContain(`REST SSE ${suffix}`);

  const replay = await fetch(`${baseUrl}/api/objects/the_taskspace/stream`, { headers: { ...headers, "Last-Event-ID": `the_taskspace:${frame.seq - 1}` } });
  expect(replay.status).toBe(200);
  expect(replay.body).not.toBeNull();
  const replayReader = replay.body!.getReader();
  const replayText = await readSseUntil(replayReader, `id: the_taskspace:${frame.seq}`, 5_000);
  await replayReader.cancel();
  expect(replayText).toContain("event: applied");
  expect(replayText).toContain("task_created");
});

async function readSseUntil(reader: ReadableStreamDefaultReader<Uint8Array>, pattern: string, timeoutMs: number): Promise<string> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => setTimeout(() => reject(new Error("SSE read timed out")), remaining))
    ]);
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
    if (text.includes(pattern)) return text;
  }
  throw new Error(`Timed out waiting for SSE pattern ${pattern}. Received: ${text}`);
}
