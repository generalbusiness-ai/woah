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
