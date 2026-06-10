# D3a browser CF lane — wave-1 build

Origin: 2026-06-09. Implements the lane-build half of plan item D3a from
[2026-06-09-cf-cross-scope-architecture-plan.md](2026-06-09-cf-cross-scope-architecture-plan.md).

## What was built

Wave-1 deliverables:

1. **`npm run e2e:cf`** — a full Playwright lane that: builds the SPA, boots
   `wrangler dev` with a fresh temp persist dir (hermetic cold boot), runs
   Playwright specs against the real workerd, then tears everything down.

2. **`e2e/cf-smoke.spec.ts`** — 3 live specs + 1 fixme:
   - Spec 1: guest connects, room renders, `say` appears in chat feed.
   - Spec 2: two browser contexts in same room — Alice says, Bob sees it (cross-client fanout over real workerd relay).
   - Spec 3: `woo.v2.render_frame` observability plumbing check — at least one committed event fires after `say`.
   - Spec 4 (fixme): optimistic-before-committed ordering — cannot pass without `WOO_BROWSER_PROJECTION_HOLDER`, marked `test.fixme`.

3. **Optimistic-render observability markers** added to `src/client/main.ts`:
   - `receiveOptimisticResultFrame`: fires `woo.v2.render_frame({ committed: false, ... })` at the `ui.applyOptimisticFrame` call site.
   - `receiveAppliedFrame`: fires `woo.v2.render_frame({ committed: true, ... })`.
   - `receiveDirectResultFrame`: fires `woo.v2.render_frame({ committed: true, ... })`. This covers the CF-without-holder case where live verbs (`say`) go through the direct result path, not through `receiveAppliedFrame`.

4. **`wrangler.cf-e2e.toml`** — variant of `wrangler.smoke.toml` with an
   `[assets]` block added. Same DO bindings/migrations (validated by
   `guard:smoke-wrangler`).

5. **`playwright.cf-e2e.config.ts`** — Playwright config for the CF lane.
   Only matches `e2e/cf-smoke.spec.ts`. No `webServer` block (workerd is already
   running when playwright starts).

6. **`scripts/guard-smoke-wrangler.mjs`** updated to also validate
   `wrangler.cf-e2e.toml`'s DO surface against `wrangler.toml`.

## Why same-origin serving

The client builds its WebSocket URL from `window.location.host`
(src/client/v2-browser-url.ts):
```typescript
return `${protocol}//${input.location.host}/v2/turn-network/ws?${params}`;
```

So the browser's WS upgrade hits whatever origin served the HTML. The cleanest
approach is to serve the SPA from the same `wrangler dev` origin as the API/WS
routes. `wrangler.cf-e2e.toml` adds `[assets] directory = "./dist"` with
`run_worker_first = true`. The Worker entry (`src/worker/index.ts`) already calls
`env.ASSETS.fetch(request)` for non-API paths, so no proxy or CORS configuration
is needed. Static assets are served directly by wrangler's local asset handler;
API and WS routes are handled by the Worker first.

Alternative considered: a separate static server (vite preview) proxying WS to
wrangler. Rejected because it requires explicit origin configuration in the
client URL builder, CORS headers on the worker, and coordination between two
processes. Same-origin is simpler and higher-fidelity.

## How hermeticity works

`scripts/e2e-cf-dev.ts` creates a fresh temp dir via `mkdtempSync` on every run
and passes it as `--persist-to` to wrangler dev. This mirrors the approach in
`scripts/smoke-cf-dev.ts`. The persist dir is deleted after workerd exits, so
the next run starts from an empty world. Result: each run does a full cold boot
including catalog auto-install, DO migrations, and KV host-seed fill.

## CI weight and when to run

`e2e:cf` is NOT part of `npm test` (the default fast gate). It is a slow lane
(~30–60 s cold boot + ~5 s Playwright) registered in `package.json` alongside
`smoke:cf-dev`.

**Run `npm run e2e:cf` before:**
- CF deploys that touch `src/client/` (browser client changes)
- Changes to the WS path or turn network handshake (`src/worker/persistent-object-do.ts`)
- Changes to the optimistic-execution path (`v2-browser-worker.ts`,
  `v2-browser-local-turn.ts`)
- Enabling or changing `WOO_BROWSER_PROJECTION_HOLDER`

**Do NOT run as part of every commit gate** (it is slow; `npm test` covers the
fast vitest path, and the dev-server e2e covers most client UI behavior).

## Optimistic-render marker design

Added three dispatch sites in `src/client/main.ts`:
- `receiveOptimisticResultFrame` (committed=false): fires at the
  `ui.applyOptimisticFrame` call site, tight to the actual UI update.
- `receiveAppliedFrame` (committed=true): fires after `ui.ingestAppliedFrame`.
  This is the durable-verb path.
- `receiveDirectResultFrame` (committed=true): fires after
  `ui.completeOptimisticCall`. This is the live-verb path and the CF-without-holder
  fallback path.

Event shape: `{ id: string; verb: string; committed: boolean; t: number }`.
All three sites dispatch `woo.v2.render_frame` CustomEvent so Playwright can
observe optimistic-before-committed ordering for any verb on any path.

Production impact: zero behavior change. One `CustomEvent` per render path (2–4
per turn). Not gated on `v2TestHooksEnabled` because the events are lightweight
and the observability is useful in all environments (vs the verbose debug logging
which is gated).

## Flag-on reconnaissance (WOO_BROWSER_PROJECTION_HOLDER)

The flag is commented out in `wrangler.cf-e2e.toml`. The lane was run with the
flag OFF (default). Findings:

**With flag OFF** (default, both runs observed):
- `render_frame` events: 4 total, 2 optimistic (committed=false), 2 committed
- The 2 optimistic events are for `command_plan` and `say` — surprisingly, even
  without the flag, the `command_plan` verb fires an optimistic event. This is
  because `command_plan` is a pure-read planning verb that the browser executes
  locally via the optimistic path even when durable commits are server-side.
  `say` also fires optimistic because the local planner can tentatively plan it;
  the optimistic frame is retracted and replaced by the committed direct result.
- The spec 4 (fixme) would fail because the optimistic and committed events DO
  exist, but they don't share the same `id` (the optimistic event is for
  `command_plan` or a planning round, not the same turn id as the committed
  `say`). The fixme assertion looks for `frames.find((f) => f.committed &&
  f.id === optimistic.id)` — this would only find a pair if the same verb had
  both optimistic and committed events, which requires the holder to be enabled.

**Flag-on reconnaissance NOT attempted** (out of scope per plan rules: "the
debug-what-falls-out half of D3a is open-ended diagnosis, not a scoped task").
To run it: uncomment `WOO_BROWSER_PROJECTION_HOLDER = "1"` in
`wrangler.cf-e2e.toml`, remove the `test.fixme` wrapper in spec 4, and run
`npm run e2e:cf`. Expect: `local_turn_fallback` rate drops to near-zero for
same-scope verbs; the spec 4 optimistic-before-committed assertion may pass or
may hit the A2 lineage gap for cross-scope state. Record findings here.

## Flake root cause and fix (2026-06-09)

The lane had a ~33–50% failure rate on spec 1 ("guest connects and say line
appears in chat"). The failure shape was: `expect.poll(getSayVerbs)` timed out
after 30 s with an EMPTY array — no `woo.v2.turn_result` event with verb=say
ever fired. The Playwright page snapshot showed the sidebar rendered (actor name,
tab buttons) but the chat feed empty.

### Root cause 1: readiness race (`waitForConnected` fires before WS scope open)

`waitForConnected(page)` checks for the `.actor` DOM element to stop showing
"connecting...". This element is set by `connect()` in `src/client/main.ts`
(around line 537), which calls `refresh()` (REST `/api/me`) and then
asynchronously (NOT awaited) calls `syncV2BrowserWorkerScope()` to start the WS
scope connection. The `.actor` element is set from the REST response — the WS
scope handshake happens afterward.

The `say` command submitted right after `waitForConnected()` lands in
`sendV2TurnIntent()` in `src/client/v2-browser-worker.ts`. That function calls
`await connect()`, which resolves when the WS socket is OPEN. However, if the
socket was not yet OPEN when `sendChatInput()` checked, the call was dropped
before even reaching `sendV2TurnIntent()` (the `!space → return` guard at around
line 4039 of `main.ts`).

Even when the call does reach `sendV2TurnIntent()`, `putPending()` saves it to
IndexedDB and then `sendEncoded()` is called. The `sendEncoded()` function
(`src/client/v2-browser-worker.ts`, around line 1945) is a **silent NO-OP**
when `socket?.readyState !== WebSocket.OPEN`:

```typescript
// sendEncoded — silent drop if socket not OPEN (no error, no retry, no log)
if (socket?.readyState === WebSocket.OPEN) {
  socket.send(encoded);
}
// else: message is silently discarded; only replayPending() can recover it
```

When the turn is silently dropped this way, it is saved in IDB and can only be
recovered by `replayPending()`, which is called after the next state transfer
arrives (i.e., after the WS reconnects and the relay sends a new state
transfer). On a cold world, the scope DO initialization takes 15–30 s, so
the replay may not complete before the 30 s test poll timeout.

### Root cause 2: wrangler dev auto-reload on startup

wrangler dev reports "Ready on http://127.0.0.1:PORT" before it finishes its
initial TypeScript compilation. When compilation finishes (~1–2 s after "Ready"),
wrangler emits "Reloading local server…" and drops all active WebSocket
connections. A browser that connected during this window (which the test did,
right after `/healthz` returned OK) would have its WS dropped mid-test.

The browser worker reconnects and eventually `replayPending()` fires, but the
round-trip delay (reconnect + scope DO cold start + state transfer + replay)
pushed the say turn past the 30 s Playwright poll timeout in failing runs.

### Fix: `waitForScopeReady` and wrangler stability gate

Two changes were made:

**1. `e2e/cf-smoke.spec.ts`: `waitForScopeReady(getProjections, scope)`**

A new `installProjectionListener()` helper installs an `addInitScript` listener
for `woo.v2.projection` CustomEvents. A new `waitForScopeReady()` function polls
until at least one live (non-cached) projection event arrives for the target scope:

```typescript
await expect
  .poll(() => getProjections().some((e) => e.scope === scope && e.cached !== true), {
    timeout,
    message: `expected a live woo.v2.projection for scope ${scope}`
  })
  .toBe(true);
```

The `woo.v2.projection` event is dispatched in `src/client/main.ts` (around
line 590) when the browser worker sends a `{kind: "projection"}` message. The
`cached` field is true when the projection came from IndexedDB before the WS
opened; false/absent when it came from a live WS state transfer. A live
projection proves: (1) the WS socket IS open, (2) the relay delivered a state
transfer, (3) if a wrangler reload happened, the reconnect and re-open
completed. Applied to all 4 specs (including spec 4 fixme).

**2. `scripts/e2e-cf-dev.ts`: wrangler stability gate and log tee**

After `/healthz` returns OK, the harness now calls `handle.waitForStable()`
before starting Playwright. `waitForStable()` watches for "Reloading local
server" lines in wrangler stdout/stderr and only resolves when
`STABLE_WINDOW_MS` (3 s) have elapsed without a reload signal (or
`STABLE_TIMEOUT_MS` = 60 s timeout). This ensures the initial compilation
reload happens before any browser connects.

Additionally, all wrangler stdout and stderr is now teed to `wrangler.log` in
the persist dir for post-mortem analysis on failure.

### Silent-drop product defect (confirmed, not fixed by this PR)

The silent-drop mechanism is a real product defect in `src/client/v2-browser-worker.ts`.
When the WS socket is not OPEN at the moment `sendEncoded()` is called, the turn
is discarded without any user-visible error, log line, or retry timer. The turn
is saved in IDB via `putPending()`, but the pending-turn timeout timer is not
started for turns silently dropped this way (the timer is armed by
`armPendingTurnReplyTimeoutsForCurrentSession()` which ran before the new turn
was added). The user sees: the chat input cleared (filled + Enter accepted), no
response, no error — a completely silent failure.

Recovery path: `replayPending()` is called when the WS reconnects and the next
state transfer arrives. On a warm world this is ~400 ms; on a cold world it can
take 15–120 s.

Fix direction (not implemented here): `sendEncoded()` should either (a) return a
boolean that causes `sendTurnIntent()` to start a recovery timer immediately, or
(b) `sendTurnIntent()` should check socket readiness before calling `putPending()`
and either queue the intent for when the socket opens or emit an error. The lane
fix (waitForScopeReady) avoids the race in test code, but does not fix the
product-level silent drop for real users who submit a turn during the brief
window between REST session open and WS scope ready.

### Validation results

After both fixes:
- `npm run typecheck`: clean (both tsconfigs)
- `npm test`: 510 tests, all passed (37 files)
- `npm run e2e:cf` × 5 consecutive: 3 passed / 1 skipped (spec 4 fixme) every run

## Known limitations

1. The lane boots a fresh world on every run. Spec 1 and 2 use unique run-id
   suffixes to avoid cross-run token collisions, but if multiple `e2e:cf`
   processes run simultaneously they will share DO storage (isolated by persist
   dir, but the port finder has a TOCTOU window). The `--port=<n>` flag pins
   the port if needed.
2. The cold world boot (catalog auto-install) takes ~15–30 s depending on
   hardware. The `READY_TIMEOUT_MS` is set to 180 s to be safe.
3. wrangler 4.92.0 (the version in package.json) is used. If wrangler changes
   the `[assets]` local serving behavior in a future version, the lane may need
   adjustment.
4. Spec 3's render_frame count (4 total, 2 optimistic, 2 committed without
   holder) is a consequence of the command_plan+say two-verb turn structure.
   If the turn structure changes, the count may change; the spec only asserts
   `committedFrames.length > 0`, not an exact count.
