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

## Status
- [x] serverRead routing + socket-open + tool-scope-direct connect
- [x] localStorage display cache (outliner + pinboard) via shared framework helpers
- [x] re-measured: outliner 25ms / pinboard 17ms (~99% reduction)
- [x] tests + regression gates added
