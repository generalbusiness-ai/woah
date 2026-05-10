# Chat-display contract

Status: design draft, 2026-05-10.

## Problem

Three functions in `src/client/main.ts` decide how an observation appears
in the chat panel, and all three are hardcoded with catalog-specific names:

- `isChatObservation` (~line 2998): a 34-entry allow-list of observation
  types that are eligible to appear in chat. ~17 of those names belong to
  catalogs (`cockatoo_*`, `dubspace_*`, `pinboard_*`, `note_read`,
  `note_dispersed`).
- `chatLineKind` (~line 3390): branches on observation type to assign a
  `ChatLine.kind` of `"system"` for cockatoo / dubspace / pinboard
  observations; otherwise passes the type through.
- `chatSystemText` (~line 3398): when an observation has no `text:` field,
  generates display text from observation fields, with hardcoded narrative
  for cockatoo moods, dubspace activity, pinboard activity, taken/dropped,
  note_read, note_dispersed, blocked_exit.

Effect: a third-party catalog cannot emit observations that show up as
chat lines without modifying `main.ts`. This is the largest remaining
architectural barrier preventing drop-in catalogs from shipping
self-contained.

## Goal

A new catalog can declare which of its observations render in the chat
feed and how they format, without touching `src/client/`. The frame stays
catalog-agnostic.

## Non-goals

- Chat-line *layout* (avatar, timestamp, indent) stays in the chat
  catalog's `chat-space.ts` component. The contract here is just about
  observation → `ChatLine` translation.
- Per-actor preferences ("don't show me pinboard activity"). Today's
  allow-list is global; this design preserves that. Per-actor filtering
  is a separate problem.
- Fancy templating. Formatters are TS functions in the catalog UI module,
  not data templates.

## Design

### Contract

A catalog UI module that wants to contribute chat lines exports:

```ts
export function registerWooChatFormatters(registry: ChatFormatterRegistry): void;
```

The registry takes per-type formatter entries:

```ts
export type ChatFormatterContext = {
  // Resolve a subject id to its display label. Replaces the inline
  // `actorLabel(id)` calls in chatSystemText today.
  label(id: string | undefined): string;
  // The viewing actor's id, or undefined if the client has no actor yet.
  // Lets formatters distinguish doer-vs-bystander views (e.g. note_read
  // shows the full body to the reader and a short line to others) without
  // pushing that branching back into the frame.
  viewer: string | undefined;
};

export type ChatFormatterResult = {
  // ChatLine.kind. If omitted, the frame uses the observation type
  // (preserving today's behavior for typed lines like "said", "emoted").
  kind?: string;
  // Override for ChatLine.text. If omitted, the frame falls back to
  // observation.text (when present); if neither is set the line is
  // dropped from the feed.
  text?: string;
  // Optional overrides for fields the frame would otherwise read straight
  // off the observation. Used sparingly — most catalogs only set kind/text.
  actor?: string;
  style?: string;
  reason?: string;
};

export type ChatFormatter = {
  types: readonly string[];
  format: (observation: Record<string, unknown>, ctx: ChatFormatterContext) => ChatFormatterResult | undefined;
};

export type ChatFormatterRegistry = {
  formatter(entry: ChatFormatter): void;
};
```

Returning `undefined` from `format` means "this observation isn't a chat
line" — useful when one type sometimes is and sometimes isn't (e.g.
`note_read` shows the body to the reader and a brief line to bystanders).
The frame then drops the line.

### Manifest declaration

The manifest declares the types per module so the frame can build the
chat-eligibility allow-list at install time without invoking any code:

```json
"ui": {
  ...
  "chat_formatters": [
    {
      "module": "pinboard-ui",
      "types": ["pinboard_entered", "pinboard_left", "pinboard_activity"]
    }
  ]
}
```

This mirrors the existing `observation_handlers` block that the cleanup
established for projection reducers. A module may export both; they are
independent (a reducer may exist for a type that is not chat-displayed,
and vice versa).

### Framework changes

Three framework additions in `src/client/framework.ts`:

1. `ChatFormatterRegistry` (new class) — collects entries, builds a
   `Map<type, ChatFormatter[]>` for O(1) dispatch.
2. New types in `ModuleExports`: `registerWooChatFormatters?: (registry: ChatFormatterRegistry) => void;`. Loaded the same way as
   `registerWooObservationHandlers` in `loadModule` /
   `registerModuleExports`.
3. Manifest type extension: `CatalogUiManifest.chat_formatters?: UiObservationHandlerDecl[]` (same shape as
   `observation_handlers`).

The registry exposes:

```ts
class ChatFormatterRegistry {
  formatter(entry: ChatFormatter): void;
  isChatType(type: string): boolean;
  format(observation: Record<string, unknown>, ctx: ChatFormatterContext): ChatFormatterResult | undefined;
}
```

`format` walks the formatter list for the given type in registration
order, returns the first non-undefined result.

### Frame changes

In `main.ts`:

- `isChatObservation(obs)` → `ui.chatFormatters.isChatType(obs.type)`.
- `chatSystemText(obs)` → `ui.chatFormatters.format(obs, ctx)`. The
  result's `text` overrides the line's text; the result's `kind`
  overrides the rendered `ChatLine.kind` only.
- `chatLineKind` is **not** simply replaced. Today its return value is
  also read in `applyChatObservation` (~line 3251) for upstream side
  effects — presence-list adoption (`looked` / `who`), present-set
  updates (`entered` / `left`), self-suppression (`taken` / `dropped`
  / `entered` / `left`), and the `note_read` reader/bystander branch.
  Those upstream branches stay keyed on `observation.type`, not on the
  formatter-supplied `kind`. The formatter's `kind` only feeds the
  rendered line.
- After every observation type currently in `isChatObservation` /
  `chatSystemText` has a registered formatter, the three legacy
  functions can be deleted. `chatLineKind` collapses to "use the
  formatter's `kind`, fall back to `observation.type`."

`pushChatLine` is unchanged. The shape of `ChatLine` is unchanged.

The frame retains its observation.type-keyed branches because they
encode chat-routing semantics (who's in the room, who emitted, did the
viewer do this) rather than catalog-display semantics. Pulling them
into formatters would require giving formatters write access to client
state, which broadens the contract beyond display.

### Per-catalog formatters to add

Each existing observation type currently in `isChatObservation` /
`chatSystemText` / `chatLineKind` moves to the right catalog:

| Catalog | Types |
|---|---|
| chat | `said`, `said_to`, `said_as`, `emoted`, `posed`, `quoted`, `self_pointed`, `told`, `entered`, `left`, `looked`, `who`, `blocked_exit`, `huh`, `text`, `taken`, `dropped` |
| note | `note_read` |
| dispenser | `note_dispersed` |
| pinboard | `pinboard_entered`, `pinboard_left`, `pinboard_activity` |
| dubspace | `dubspace_entered`, `dubspace_left`, `dubspace_activity` |
| demoworld | `cockatoo_squawk`, `cockatoo_muffled`, `cockatoo_taught`, `cockatoo_gagged`, `cockatoo_ungagged`, `cockatoo_fed`, `cockatoo_pluck`, `cockatoo_shake`, `cockatoo_seen` |

`taken`/`dropped` go in chat (rather than note or core) because chat is
the only catalog that meaningfully shapes their display today.

Catalogs `note`, `dispenser`, and `demoworld` need a UI module each
(they currently have none — `installBundledCatalogUi` in `main.ts`
~line 2667 only registers chat / dubspace / pinboard / taskspace /
weather). The module is small — just the formatter export, no
components, no observation handlers. The manifest gains:

```json
"ui": {
  "abi": "woo-ui/v1",
  "modules": [{ "id": "note-chat", "entry": "ui/note-chat.ts" }],
  "chat_formatters": [{ "module": "note-chat", "types": ["note_read"] }]
}
```

Each new module also needs a corresponding entry in
`installBundledCatalogUi` (static import + `registerModuleExports`).
Without that wiring the manifest declaration loads no code and the
formatter never registers, so the design depends on extending the
bundled-catalog list at the same step the manifests change.

Remote (non-bundled) catalogs that ship `chat_formatters` are out of
scope for this design — `installCatalogUi` (the framework method)
installs only the manifest, not the modules. Loading remote modules is
a separate concern in `spec/discovery/catalogs.md`; once that path
exists, `chat_formatters` rides on it for free.

### Subtleties

- **`note_read` two-mode display.** Today the verb emits `text:` carrying
  the full body; the bystander branch in `applyChatObservation` overrides
  with the short "X reads Y." line. The note formatter receives the
  viewer in `ctx.viewer` and decides itself: when
  `ctx.viewer === observation.actor` it returns the body, otherwise the
  short line. The frame's existing `note_read` branch goes away entirely
  — it was the last `note_*`-named string in `applyChatObservation`.

- **Multiple catalogs claim the same type.** First registered wins.
  Registration order is the install order of catalogs, which matches
  manifest dependency order. If two catalogs claim the same type and
  the order matters, the spec assumption is that whichever catalog
  *defines* the verb that emits the observation also owns its display —
  so this should not arise in practice. Promotions / overrides are not
  supported in this design; if a use case appears, add an explicit
  priority field then.

- **Fallback when no formatter.** If a chat-eligible type has no
  formatter (declared in manifest but no entry registered), the frame
  uses `observation.text` if present, else drops the line. Same as the
  current `chatSystemText` returning `undefined` path.

- **`actorLabel` injection.** `actorLabel` lives in `main.ts` today; the
  formatter context exposes a `label` function so catalogs don't have to
  reach into the frame. Once the duplication audit's `actorLabel` helper
  lands in framework, the context just delegates.

## Migration

Sequence-friendly so each step compiles and tests pass. The order is
designed so chat lines are never silently dropped: gating predicates and
text generators stay live until the registry path is in place, then
each catalog moves over with its eligibility list intact.

1. **Add the contract.** New types in `framework.ts`, new
   `ChatFormatterRegistry` class, plumbing in `loadModule` /
   `registerModuleExports`. Add `note`, `dispenser`, and `demoworld` to
   the bundled-catalog list in `installBundledCatalogUi` with empty UI
   modules (entry files that export nothing yet). Frame still uses the
   old hardcoded functions; nothing observable changes.
2. **Re-route the call sites first.** `isChatObservation`,
   `chatLineKind`, `chatSystemText` become **unions** of legacy and
   registry: legacy list ∪ registry types for eligibility; registry
   format result ?? legacy text generator for output. This keeps every
   chat line live throughout the catalog migration.
3. **Wire each catalog one at a time.** For each catalog in the table
   above:
   - Add `chat_formatters` to manifest.
   - Add `registerWooChatFormatters` export.
   - Remove the corresponding entries from
     `isChatObservation` / `chatLineKind` / `chatSystemText` (now safe
     because the registry path picks them up).
   - Run tests after each catalog to keep regressions localized.
   Step 3 can be done as separate commits per catalog.
4. **Delete the hardcoded functions.** Once `isChatObservation` and
   `chatSystemText` are empty (only the legacy union shims remain),
   delete them. `chatLineKind` collapses to "use formatter `kind` else
   `observation.type`".

The union-during-transition (step 2) is the crucial difference from a
naïve "remove from old list before registering new formatter" sequence,
which would silently drop chat lines for any catalog whose migration
hadn't yet landed.

## Testing

- Unit tests for `ChatFormatterRegistry`: registration, type lookup,
  multiple formatters for same type, fallthrough on undefined.
- Integration tests: each catalog's formatter exercised with realistic
  observation shapes (today's `chatSystemText` cases become per-catalog
  test cases).
- Existing `chat-ui-components.test.ts` continues to assert end-to-end
  rendering. Update it to register catalog formatters via the same
  test wrapper pattern established for observation handlers.

## Estimated scope

- `src/client/framework.ts`: +90 lines (registry + types + plumbing).
- `src/client/main.ts`: −80 lines (delete the three hardcoded functions
  and inline call sites simplify).
- Per catalog: +20–40 lines for the formatter export (mostly the body
  text strings moved verbatim from `chatSystemText`).
- `note` and `dispenser` catalogs: +1 small UI module each.
- Manifest blocks: +5–10 lines per catalog.

Net: about 50 lines of growth in catalogs, 80 lines of shrinkage in
`main.ts`, the chat-display contract becomes declarative and
extensible.

## Spec impact

`spec/protocol/ui-component-model.md` already documents observation
handlers (§ on `registerWooObservationHandlers`). Add a parallel section
for `registerWooChatFormatters` and the `chat_formatters` manifest block.
