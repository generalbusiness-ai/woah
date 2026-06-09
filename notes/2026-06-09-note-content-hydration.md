# Note/outliner content hydration delay (localdev/browser)

## Symptom
First-time browser load of pinboard/outliner: the row/structure renders fast,
but each item's readable **text** appears only after many seconds.

## Reproduction & baseline (measured)
`e2e/note-hydration-perf.spec.ts`: seed 10 outliner items, reload, time from
"rows visible" to "all text visible".
- **Baseline: ~4.9s** structure→text gap (items=10).

## Root cause (from dev-server `woo.metric` browser_activity during reload)
The UI renders structure from the thin room-contents projection (no `.text`),
then fires ONE `list_items`/`list_notes` directCall to fill text. That read goes
through the browser's **local-execution** path:
- `turn_connect_wait` ~1290ms (read waits for WS connect)
- `turn_intent ms≈3317 reason=local_exec`, composed of:
  - `local_turn_plan reason=missing_state` (needs ~22 atoms for note-text reads)
  - `state_transfer_request` (~230ms) + `local_turn_repair`
  - repeated `execution_cache_build` rebuilds (250/335/353/680ms each)

Yet the **server-side `direct_call` for `list_items` is 3–4ms**. The browser
burns ~3.3s pulling state + rebuilding its execution cache to run *locally* a
read the server answers in 3ms. Local execution exists for optimistic *writes*;
for a pure display read it is pure overhead — the result must arrive before
render regardless, so there is no optimism to preserve.

### Why local exec can't serve it cheaply
`tests/v2-browser-local-turn.test.ts:126` asserts `list_items`/`list_notes`
*should* plan locally `ok:true` from a complete open executable seed. In
practice, after add-items + reload, the seed/cache does NOT cover the note-text
atoms, so planning hits `missing_state` and pays the repair storm. Closing that
seed-coverage gap lives on the shared CF authoritative-transfer path (risky;
see b7_state_transfer_warmfill / divergent_session_state_race) — deliberately
NOT the lever here.

## Fix (this worktree)
Route read-only view-hydration directCalls (`list_items`, `list_notes`) straight
to the **server intent** path instead of attempting local execution.
- `v2ServerAssistedIntentPolicy` already returns `{ok:true, reason:"live_turn"}`
  for `direct`+`live`, so server intent needs no scope-ad and is fully supported.
- Server reads are authoritative (strictly more correct than optimistic local).
- Skips ALL execution_cache_build rebuilds + state_transfer + repair for the read.

Threaded via `ProjectionCallOptions.serverRead` → worker `call.read_only` →
`sendTurnIntent` skips `sendLocalTurnExec` when `read_only`.

## Fixes landed (this worktree)
Three were necessary to understand the gap; the cache is what closes it.

1. **serverRead routing** (`ProjectionCallOptions.serverRead` → worker `call.read_only`):
   read-only view hydrations (`list_items`/`list_notes`) skip the browser
   local-execution attempt and go straight to the authoritative server intent
   (`v2ServerAssistedIntentPolicy` admits `direct`+`live`). Kills the
   execution-cache-rebuild + state-transfer repair storm (~3.3s) for the read.
2. **socket-open wait** (`ensureSocketOpen` in the worker): a `read_only` intent
   waits only for the WebSocket to be OPEN, not the full display+executable+ad
   readiness `connect()` blocks on (~950ms saved on a cold reload).
3. **tool-scope-direct connect** (`desiredV2BrowserScope`): on a tool tab, resolve
   the tool's space directly instead of falling back to `the_chatroom`, so the
   worker connects straight to the tool scope instead of chatroom→reconnect (the
   reconnect dropped the in-flight hydration reply).

### The decisive insight
Even with 1–3, a *live read* is fundamentally capped by the relay scope-open
handshake on a cold reload (~3s), because structure paints instantly from the
browser cache (`postCachedProjection`, ~124ms) but text comes from a read the
relay can't answer until the scope is open. So the only way to paint text WITH
structure is to serve it from a cache too.

4. **localStorage display cache** (`outliner-tree.ts`): the component stashes the
   last-seen item text per outliner; on a cold reload `itemsFromProjection` paints
   that cached text for items whose projection text isn't present yet, while still
   queuing the authoritative hydration read (which overwrites it). Cache-then-
   refresh; live `note_edited` keeps it fresh. (The note `$note.text` is read-gated
   and catalog-defined, which is exactly why the generic projection omits it — the
   cached value is the value THIS actor already read authoritatively.)

5. **Pinboard parity**: the pinboard reads note text from a catalog overlay, not
   `props.text`, and its hydration trigger keys on `note.text === undefined`. So
   the cache attaches a separate `cachedText` field (filled in `pinboardModel` via
   `fillPinboardNotesFromTextCache`) that the component (`renderNote`) falls back
   to while `text` is undefined — leaving the hydration trigger untouched.
   `writePinboardTextCache` (called from `mountPinboardComponent` and the
   hydration apply, deduped, never writes an empty map) persists known text.
   Shared helpers `readDisplayTextCache`/`writeDisplayTextCache` live in
   `framework.ts`; the outliner now uses them too.

## Result (measured, e2e/note-hydration-perf.spec.ts)
- Baseline: **~4918ms** structure→text (outliner, 10 items).
- After fixes: **outliner ~25ms**, **pinboard ~17ms** structure→text.
- **~99% reduction** (target was 80%). Regression gates assert < 1000ms for both.

## Validation
- typecheck clean (both tsconfigs); no byte corruption.
- Full vitest: 1543 passed / 0 failed (97 files). npm test gate: 384.
- Outliner unit: 65 (incl. new cache-fill test). Worker integration + planner: 44.
- e2e: outliner perf, pinboard perf, existing outliner display + pinboard tests — pass.

## Review fixes (round 2)
Three findings from review, all fixed:

- **P1 — read-gated text cached without principal isolation.** The cache is now
  keyed by the viewing actor: `displayTextCacheKey(ns, actor, subject)` →
  `woo.<ns>.text.<actor>.<subject>`, and refuses to produce a key without an
  actor (cache disabled for an unknown principal). `pruneDisplayTextCaches(actor)`
  runs in `refresh()` once the principal is known, dropping every OTHER principal's
  cache (isolation + disk hygiene) while keeping the current actor's (which must
  survive the reload). Explicit logout already wipes all `woo.*` via
  `clearAccountScopedStorage`. NOTE: do NOT purge in `clearSession()` — it fires on
  transient `E_NOSESSION` blips during a normal guest reload, followed by a
  same-guest re-login, so purging there would defeat the cache (this was a real bug
  caught while fixing P1). Tested in `tests/client-framework.test.ts`.
- **P2 — pinboard cache resurrected cleared text.** `writePinboardTextCache` now
  records genuinely-empty text (`""`) instead of dropping it, so a cleared note
  overwrites its old cached text; the fill skips falsy values so an empty cached
  string paints nothing. It still never writes until at least one note's text is
  known, so a pre-hydration render can't clobber a good cache. The outliner got the
  same treatment plus an **empty-model guard** — its first sync after a reload runs
  before the projection loads any rows, and writing an empty map there was deleting
  the actor's own cache (empty map == clear). That self-wipe was the bug that made
  the outliner reload measure ~2.9s in review. Regression test added.
- **P3 — perf e2e unstable as a gate.** The instability was a downstream symptom of
  the P2 self-wipe (outliner reload fell back to the ~3s hydration path, tripping
  timeouts and cascading ERR_CONNECTION). With that fixed the spec is stable (3/3
  clean full runs); additionally marked `test.describe.configure({ mode: "serial" })`
  so these timing-sensitive probes don't contend for the single dev server.

## Tab-navigation finding (round 3) — pre-existing, fixed
User report: navigating tool→tool within one live session (no reload), the SECOND
tool shows structure but no readable text (and pinboard "chat never shows").

Investigated in-browser, two contexts (a fresh actor B reads content actor A made):
- **The chat-panel report was a test-selector false alarm** — the companion mounts
  and is visible on the live transition (verified `ambient-companion-shell` parent).
- **Pinboard-second no-text is a real PRE-EXISTING bug** (reproduced on `main`,
  commit 8c6f667). The pinboard note-text hydration is gated on actor presence, and
  the one-shot trigger in `refreshScopedProjection` runs BEFORE the live-transition
  `enter` establishes presence, then never retries → the second tool's existing
  notes render with empty text. Fix: also call the (idempotent, deduped)
  `hydratePinboardNotesTextIfNeeded` from `mountPinboardComponent`, so it retries on
  the render that follows presence landing. Verified: a fresh actor now sees the
  existing note text on the second tool. Regression: `e2e/tool-nav-hydration.spec.ts`.
- **Outliner-second** is NOT presence-gated; for a fresh actor its text loads via the
  normal hydration (slower, scope-open-bound) and for a returning actor the display
  cache paints it instantly — no hard failure, just first-visit latency.

## Result (measured, e2e/note-hydration-perf.spec.ts)
- Baseline: **~4918ms** structure→text (outliner, 10 items).
- After fixes: **outliner ~24ms**, **pinboard ~24ms** structure→text; stable across
  3 consecutive full runs. Genuine cold first-visit (caches wiped): ~25–385ms.
- **~99% reduction** (target was 80%). Regression gates assert < 1000ms.

## Validation
- typecheck clean (both tsconfigs); no byte/control-char corruption.
- npm test gate: 384. Worker integration: 28. Outliner unit: 17 (incl. cache-fill,
  principal-isolation, no-wipe regression tests). Framework: principal-isolation +
  prune tests. Full vitest earlier: 1543 / 0 failed.
- e2e: outliner/pinboard/cold-visit perf + existing outliner display + pinboard
  tests — all pass.

## Status
- [x] serverRead routing + socket-open + tool-scope-direct connect
- [x] localStorage display cache (outliner + pinboard) via shared framework helpers
- [x] P1 principal-namespaced keys + prune-on-establish; P2 cleared-text + empty-model
      guards; P3 stable + serial
- [x] re-measured: outliner 24ms / pinboard 24ms (~99% reduction)
- [x] tests + regression gates added
