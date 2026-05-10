import { test, expect, type APIRequestContext, type Locator } from "@playwright/test";

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
  await expect(page.getByRole("button", { name: "Tasks" })).toBeVisible();
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

  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "Tasks" })).toHaveClass(/active/);

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

  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "Tasks" })).toHaveClass(/active/);
  await expect(page.locator(".woo-tasks-kanban")).toBeVisible({ timeout: 5_000 });
  expect(stateCalls).toEqual([]);
});

test("page header h1 aligns across tools", async ({ page, request }) => {
  const response = await request.post("/api/auth", { data: { token: "guest:e2e-header-alignment" } });
  expect(response.ok()).toBe(true);
  const payload = await response.json() as { session?: string };
  expect(payload.session).toBeTruthy();
  const session = payload.session ?? "";
  await page.addInitScript((nextSession: string) => {
    localStorage.setItem("woo.session", nextSession);
    sessionStorage.setItem("woo.session", nextSession);
  }, session);
  const measureH1 = async (target: string) => {
    await page.goto(target);
    await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 10_000 });
    const h1 = page.locator("main.main h1").first();
    await expect(h1).toBeVisible({ timeout: 5_000 });
    // h1 may render before the registry name arrives; wait for non-empty.
    await expect(h1).not.toHaveText("", { timeout: 5_000 });
    return h1.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const styles = getComputedStyle(el);
      return {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        fontSize: styles.fontSize
      };
    });
  };
  const headers = [
    { tab: "Pinboard", m: await measureH1("/objects/the_pinboard") },
    { tab: "Dubspace", m: await measureH1("/objects/the_dubspace") },
    { tab: "Taskboard", m: await measureH1("/objects/the_taskboard") }
  ];
  const tops = headers.map((h) => h.m.top);
  const lefts = headers.map((h) => h.m.left);
  const sizes = new Set(headers.map((h) => h.m.fontSize));
  expect(Math.max(...tops) - Math.min(...tops), `h1 top mismatch: ${JSON.stringify(headers)}`).toBeLessThanOrEqual(2);
  expect(Math.max(...lefts) - Math.min(...lefts), `h1 left mismatch: ${JSON.stringify(headers)}`).toBeLessThanOrEqual(2);
  expect(sizes.size, `h1 font-size mismatch: ${JSON.stringify(headers)}`).toBe(1);
});

test("space chat panel bottoms are visually aligned", async ({ page, request }) => {
  const response = await request.post("/api/auth", { data: { token: "guest:e2e-chat-alignment" } });
  expect(response.ok()).toBe(true);
  const payload = await response.json() as { session?: string };
  expect(payload.session).toBeTruthy();
  const session = payload.session ?? "";
  await page.addInitScript((nextSession: string) => {
    localStorage.setItem("woo.session", nextSession);
    sessionStorage.setItem("woo.session", nextSession);
  }, session);
  const measureBottom = async (target: string) => {
    await page.goto(target);
    const panel = page.locator("woo-space-chat-panel[data-space-chat-panel]");
    await expect(panel).toBeVisible({ timeout: 5_000 });
    return panel.evaluate((element) => Math.round(element.getBoundingClientRect().bottom));
  };
  const chatBottoms: Array<{ space: string; bottom: number }> = [
    { space: "Dubspace", bottom: await measureBottom("/objects/the_dubspace") },
    { space: "Pinboard", bottom: await measureBottom("/objects/the_pinboard") },
    { space: "Taskboard", bottom: await measureBottom("/objects/the_taskboard") }
  ];

  const bottoms = chatBottoms.map((entry) => entry.bottom);
  const max = Math.max(...bottoms);
  const min = Math.min(...bottoms);
  expect(max - min, `chat bottom mismatch: ${JSON.stringify(chatBottoms)}`).toBeLessThanOrEqual(2);
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

test("tasks tab enters with chat focus", async ({ page }) => {
  await page.goto("/");
  const continueAsGuest = page.getByRole("button", { name: "Continue as guest" });
  if (await continueAsGuest.isVisible()) {
    await continueAsGuest.click();
  }
  await expect(page.locator(".actor")).not.toHaveText("connecting...", { timeout: 10_000 });
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.locator("[data-space-chat-input]")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("[data-space-chat-input]")).toBeFocused();
});

// The legacy "hierarchical task workflow" smoke covered the deleted
// taskspace catalog (root_tasks / subtasks / checklist / artifacts /
// status pills). The new tasks catalog is a registry+kanban model with
// roles, steps, workflows; its UI mechanics are covered by the kanban
// component tests in tests/catalog-ui-components.test.ts and the
// registry verb behavior is exercised by tests/catalogs.test.ts. A
// browser smoke for the new flow is worth adding (open registry → seed
// policy → create task → claim → pass through workflow) but isn't a
// merge-blocker; tracked as a follow-up.

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

  // Seed a minimal workflow ("task" → "do:it" → role "doer") so guest's
  // create_task calls below have a known kind to use. seed_minimal_policy
  // raises E_INVARG once the registry is populated, so tolerate that for
  // re-runs against a long-lived dev server.
  const seed = await request.post("/api/objects/the_taskboard/calls/seed_minimal_policy", {
    headers: wizardHeaders,
    data: { space: "the_taskboard", args: [wizardSession.actor] }
  });
  if (!seed.ok()) {
    const err = await seed.json();
    expect(err.error?.code === "E_INVARG" || err.error?.code === undefined, JSON.stringify(err)).toBe(true);
  }

  const describe = await request.get("/api/objects/the_taskboard", { headers });
  expect(describe.ok()).toBe(true);
  const described = await describe.json();
  expect(described.id).toBe("the_taskboard");
  expect(described.verbs).toContain("create_task");

  // _tracked_tasks is the registry's list of every minted task — the
  // closest analogue to the deprecated taskspace `root_tasks`.
  const tracked = await request.get("/api/objects/the_taskboard/properties/_tracked_tasks", { headers });
  expect(tracked.ok()).toBe(true);
  const trackedProperty = await tracked.json();
  expect(trackedProperty.name).toBe("_tracked_tasks");
  expect(Array.isArray(trackedProperty.value)).toBe(true);

  const privateName = `private_rest_${suffix}`;
  const definePrivate = await request.post("/api/property", {
    headers: wizardHeaders,
    data: {
      object: "the_taskboard",
      name: privateName,
      default: "classified",
      perms: "w",
      expected_version: null,
      type_hint: "str"
    }
  });
  expect(definePrivate.ok()).toBe(true);
  const privateDescribe = await request.get("/api/objects/the_taskboard", { headers });
  expect((await privateDescribe.json()).properties).toContain(privateName);
  const privateRead = await request.get(`/api/objects/the_taskboard/properties/${privateName}`, { headers });
  expect(privateRead.status()).toBe(403);
  expect((await privateRead.json()).error.code).toBe("E_PERM");

  // X-Woo-Force-Direct is wizard-only; a guest sending it must be denied
  // by the REST middleware regardless of the verb's own perms.
  const forceDenied = await request.post("/api/objects/the_taskboard/calls/create_task", {
    headers: { ...headers, "X-Woo-Force-Direct": "1" },
    data: { args: ["task", `REST force denied ${suffix}`, "non-wizard force", [], null] }
  });
  expect(forceDenied.status()).toBe(403);
  expect((await forceDenied.json()).error.code).toBe("E_PERM");

  const create = await request.post("/api/objects/the_taskboard/calls/create_task", {
    headers,
    data: {
      id: `rest-create-${suffix}`,
      space: "the_taskboard",
      args: ["task", `REST root ${suffix}`, "created through REST", [], null]
    }
  });
  expect(create.ok()).toBe(true);
  const frame = await create.json();
  expect(frame.op).toBe("applied");
  expect(frame.space).toBe("the_taskboard");
  expect(frame.message.actor).toBe(session.actor);
  expect(frame.message.verb).toBe("create_task");
  expect(frame.observations[0].type).toBe("task_created");

  const retry = await request.post("/api/objects/the_taskboard/calls/create_task", {
    headers,
    data: {
      id: `rest-create-${suffix}`,
      space: "the_taskboard",
      args: ["task", `REST root ${suffix}`, "created through REST", [], null]
    }
  });
  expect(await retry.json()).toEqual(frame);

  const log = await request.get(`/api/objects/the_taskboard/log?from=${frame.seq}&limit=1`, { headers });
  expect(log.ok()).toBe(true);
  const logged = await log.json();
  expect(logged.messages).toHaveLength(1);
  expect(logged.messages[0].seq).toBe(frame.seq);
  expect(logged.messages[0].message.verb).toBe("create_task");
  expect(logged.messages[0].observations[0].type).toBe("task_created");

  const compat = await request.post("/api/objects/the_taskboard/calls/call", {
    headers,
    data: {
      id: `rest-compat-${suffix}`,
      args: [{ target: "the_taskboard", verb: "create_task", args: ["task", `REST compat ${suffix}`, "created through $space:call route", [], null] }]
    }
  });
  expect(compat.ok()).toBe(true);
  const compatFrame = await compat.json();
  expect(compatFrame.op).toBe("applied");
  expect(compatFrame.space).toBe("the_taskboard");
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
  const wizardAuth = await request.post("/api/auth", { data: { token: `wizard:${process.env.WOO_INITIAL_WIZARD_TOKEN ?? "e2e-wizard"}` } });
  const wizardSession = await wizardAuth.json();
  const wizardHeaders = { Authorization: `Session ${wizardSession.session}` };
  // Tolerate "already populated" — the REST runtime test above may have
  // already seeded this registry on the same dev server instance.
  const seed = await request.post("/api/objects/the_taskboard/calls/seed_minimal_policy", {
    headers: wizardHeaders,
    data: { space: "the_taskboard", args: [wizardSession.actor] }
  });
  if (!seed.ok()) {
    const err = await seed.json();
    expect(err.error?.code === "E_INVARG" || err.error?.code === undefined, JSON.stringify(err)).toBe(true);
  }
  const baseUrl = `http://localhost:${process.env.PORT ?? 5173}`;

  const stream = await fetch(`${baseUrl}/api/objects/the_taskboard/stream`, { headers });
  expect(stream.status).toBe(200);
  expect(stream.body).not.toBeNull();
  const reader = stream.body!.getReader();
  const streamText = readSseUntil(reader, "event: applied", 5_000);

  const create = await request.post("/api/objects/the_taskboard/calls/create_task", {
    headers,
    data: {
      id: `rest-sse-${suffix}`,
      space: "the_taskboard",
      args: ["task", `REST SSE ${suffix}`, "created while streaming", [], null]
    }
  });
  expect(create.ok()).toBe(true);
  const frame = await create.json();
  const text = await streamText;
  await reader.cancel();

  expect(text).toContain(`id: the_taskboard:${frame.seq}`);
  expect(text).toContain("event: applied");
  expect(text).toContain(`REST SSE ${suffix}`);

  const replay = await fetch(`${baseUrl}/api/objects/the_taskboard/stream`, { headers: { ...headers, "Last-Event-ID": `the_taskboard:${frame.seq - 1}` } });
  expect(replay.status).toBe(200);
  expect(replay.body).not.toBeNull();
  const replayReader = replay.body!.getReader();
  const replayText = await readSseUntil(replayReader, `id: the_taskboard:${frame.seq}`, 5_000);
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
