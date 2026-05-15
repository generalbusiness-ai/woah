# UI shell-contract brief

Status: brief, 2026-05-15. Canonical reference for how the woo browser
client is shaped. Folds together
[[2026-05-15-ui-problem-framing]] (audit + scope) and
[[2026-05-15-ui-shell-principles]] (the six rules), and pins the
chrome-level decisions the principles deferred. This document is
intended to outlive its commit context: if it disagrees with the code,
the code is the bug.

## 1. Premise and audience

`woo` separates **substrate** (TypeScript under `src/`) from
**superstructure** (woocode catalogs under `catalogs/`). The substrate
provides the object model, VM, persistence, transports, and the
browser shell. Catalogs provide all user-visible behavior, including
their own UI modules under `catalogs/<name>/ui/*.ts`. Per `AGENTS.md`,
the substrate must stay catalog-agnostic; user-facing decisions live
in catalogs.

This brief is read by three audiences:

- **Catalog UI authors** — to know what the shell will provide and
  what their module must declare to feel native.
- **Substrate maintainers** — to know which catalog-named code paths
  are layering bugs and what replaces them.
- **Future-self** — to remember why the contract is shaped this way
  when the next catalog wants to bend a rule.

The brief commits to *structure*, not to *visual identity*. Chrome
(brand voice, illustration, motion choreography) is downstream of
what is written here and can be re-skinned without touching the
contract.

## 2. The shell contract

### 2.1 Shell regions

The browser shell is a fixed structural grid the substrate renders
into `#app`. Four regions exist; their substrate vs catalog ownership
is non-negotiable.

| Region | Substrate owns | Catalog supplies |
|---|---|---|
| **Identity** (top-left of nav) | The actor badge: avatar/initial + display label, click target for profile/sign-out. Reads `state.actor` and the substrate-owned actor session. | Nothing. (Presence — who else is here — belongs in the ambient companion, not in identity.) |
| **Catalog switcher** (nav body) | The list of installed catalogs as switchable entries; the gesture/keystroke that activates the switcher. Driven by catalog manifest metadata. | A `nav` descriptor in the manifest: `display_name`, `icon` (optional), `sort_hint`. |
| **Main content** (`<main class="main">`) | The outer container, the toolbar strip at the top of the content, and the ambient companion slot at the bottom. | A single custom element registered via `registerWooComponents`; a `toolbar` descriptor (title, actions, status); and an observation-handler / chat-formatter set. |
| **Ambient companion** (single slot at the bottom of content) | The slot, its collapsed-state handle, mounting logic. | The companion catalog (today: chat) registers a `space-mini` component the substrate mounts into the slot. Workspace catalogs declare the slot via `data-ambient-companion`. |
| **Observations panel** (right rail / bottom drawer on mobile) | The panel container, toggle, and rendering of structured observations. | Observation handlers register reducers; chat formatters register display text. Nothing else. |

### 2.2 Substrate-owned chrome (the "shell")

- Shell grid: `<div class="shell">` with three subregions (nav, main,
  observations). Current implementation:
  `src/client/main.ts:2810–2832`. The grid is the substrate's; nothing
  else may render at this level.
- Toolbar strip (`<section class="toolbar">`) immediately inside
  `<main>`. Substrate-rendered, catalog-fed.
- Ambient companion slot, today `data-tool-space-chat`, renamed to
  **`data-ambient-companion`** in this brief. Mounted by
  `renderSpaceChatPanel` (renamed `renderAmbientCompanion`) at
  `src/client/main.ts:4263–4275`.
- Identity affordance, today the unstyled brand+actor pair at
  `src/client/main.ts:2813–2814`, refit per §7.
- Catalog switcher, replacing the hardcoded `navButton(...)` calls at
  `src/client/main.ts:2815–2819`.
- Observations panel and its toggle (`renderObservationsPanel`).
- The `:root` token vocabulary in `src/client/styles.css:6–105`,
  expanded per §4.
- Responsive layout-mode switching per §5 (the substrate's job to
  decide between within-catalog and between-catalog modes).

### 2.3 Catalog-supplied UI

A catalog UI module under `catalogs/<name>/ui/<entry>.ts` may export:

- `registerWooComponents(ctx)` — register custom elements for the
  catalog's content surfaces. The element is mounted by the substrate
  into the main content region based on manifest metadata.
- `registerWooObservationHandlers(registry)` — reduce observations
  into client state (already in use; see `framework.ts`).
- `registerWooChatFormatters(registry)` — provide display text for
  chat lines (per [[2026-05-10-chat-display-contract]]).
- `getToolbarDescriptor(state) -> ToolbarDescriptor` (new) — return
  `{ title, actions, status }` for the substrate-rendered toolbar.
  Reactive to client state; substrate re-invokes on relevant changes.

The catalog **does not** render:

- The outer `<section class="toolbar">` strip (substrate's).
- The catalog switcher entry for itself (substrate's, fed by
  manifest).
- The ambient companion slot's frame (substrate's). The catalog
  declares the slot with `<div data-ambient-companion></div>`.
- Identity, presence-in-shell, or sign-out affordances.
- Mobile-specific layout. Cross-cutting breakpoints are the
  substrate's; per-catalog `@media` rules are violations.

### 2.4 Catalog manifest metadata

Catalog `manifest.json` `ui` block grows two declarations beyond
what exists today:

```json
"ui": {
  "abi": "woo-ui/v1",
  "modules": [{ "id": "taskspace-ui", "entry": "ui/taskspace-workspace.ts" }],
  "nav": {
    "display_name": "Taskspace",
    "sort_hint": 30
  },
  "components": [
    { "tag": "woo-taskspace-workspace", "role": "workspace", "primary": true }
  ],
  "observation_handlers": [...],
  "chat_formatters": [...]
}
```

- `nav` — drives the catalog switcher entry. Sort-hint is advisory;
  the substrate decides the final order.
- `components[].role` — declares the component's structural role.
  `"workspace"` content elements declare the ambient companion slot
  and are eligible for primary-content mounting; `"badge"` elements
  appear inline in the shell (weather-style); `"ambient-companion"`
  elements register to fill ambient slots in other workspaces.

This metadata replaces all references in `src/client/main.ts` to
specific catalog names — particularly the `navButton` block at
2815–2819 and the per-tab dispatch at 2825–2829.

### 2.5 Class-name discipline

Substrate owns these unprefixed class names; catalogs do not redefine
them:

- Structure: `.shell`, `.nav`, `.main`, `.split`, `.card`,
  `.empty-state`, `.observations-collapsed`.
- Affordances: `.toolbar`, `.pill`, `.pill--*`, `.actor`, `.brand`.
- Modifiers: `.is-active`, `.is-collapsed`, `.is-hidden`, `.is-busy`.

Catalogs prefix every class they introduce with the catalog name:
`.pinboard-*`, `.chat-*`, `.taskspace-*`, `.dubspace-*`,
`.weather-*`, `.block-*`. A variant of a substrate generic gets a
prefixed name: `.pinboard-card` (not `.card.is-pinboard`). Generic
class names declared by a catalog are violations.

### 2.6 Data-attribute vocabulary

Stable data attributes the substrate writes or reads. Catalogs do
not invent variants.

| Attribute | Owner | Purpose |
|---|---|---|
| `data-ambient-companion` | Catalog declares, substrate fills | The slot for the ambient companion in a workspace. **Renamed from `data-tool-space-chat`.** |
| `data-ambient-companion-shell` | Catalog declares | The wrapper around the workspace's layout + ambient companion slot. **Renamed from `data-space-chat-shell`.** |
| `data-catalog` | Substrate | Identifies the mounted catalog on the main content element. Used by the switcher for highlight + by analytics. |
| `data-shell-mode` | Substrate, on `<div class="shell">` | One of `within-catalog` \| `between-catalog`. See §5. |
| `data-identity-action` | Substrate | Click targets in the identity surface (`profile`, `sign-out`). |
| `data-observations-toggle` | Substrate | Existing; preserved. |

Catalog-specific data attributes (`data-pinboard-*`, `data-task-*`,
etc.) remain catalog-internal and are not read by the substrate.

## 3. Conformance checklist

A reviewer with the catalog UI module open should be able to answer
each of the following in under five minutes. Each item maps to a
principle (P1–P6) from [[2026-05-15-ui-shell-principles]].

- [ ] **C1 (P1).** The catalog's manifest `ui` block contains its
  `nav`, `components`, `observation_handlers`, and (if applicable)
  `chat_formatters`. The substrate never has to be edited to ship
  this catalog.
- [ ] **C2 (P1).** No code in `src/client/` references this catalog
  by name. If a substrate function would need to branch on this
  catalog's name, the contract is missing a slot — fix the contract,
  not the substrate.
- [ ] **C3 (P3).** The catalog UI element does not render its own
  `<section class="toolbar">`. It exposes a `getToolbarDescriptor()`
  function (or static manifest field for non-reactive toolbars). The
  rendered element body begins at the content split.
- [ ] **C4 (P4).** If the element is a workspace, it declares
  exactly one `<div data-ambient-companion>` slot at the bottom of
  its layout and a `<section data-ambient-companion-shell>` wrapper
  around the layout. It does not mount anything into the slot.
- [ ] **C5 (P2).** Every CSS class name introduced is prefixed with
  the catalog's short name. The element body contains zero
  references to unprefixed structural classes other than the
  substrate generics listed in §2.5.
- [ ] **C6 (P2).** No CSS rule in the catalog targets a substrate
  generic class. `.toolbar`, `.card`, etc. are read-only from the
  catalog's perspective.
- [ ] **C7 (P5).** Inline `padding`, `margin`, `gap`, `font-size`,
  `border-radius`, `transition`, `box-shadow` values reference
  tokens (§4). Literal values in catalog code are a code smell;
  recurring literals are missing tokens.
- [ ] **C8 (P5).** Color tokens consumed by the catalog are either
  generic semantic names (`--color-surface-2`, `--color-accent`) or
  tokens declared in the catalog's own stylesheet. The catalog does
  not introduce catalog-named tokens into the substrate's `:root`.
- [ ] **C9 (P6).** The catalog contains zero `@media` queries
  unless they govern content-internal scale (e.g. pinboard zoom
  level). Cross-cutting layout breakpoints are forbidden in catalog
  code.
- [ ] **C10 (P6).** The catalog UI works in *both* shell modes
  (`within-catalog` and `between-catalog`) without
  catalog-specific scripting. It reads `data-shell-mode` if it
  needs to (rarely).
- [ ] **C11 (P1, P4).** Chat lines emitted by this catalog go
  through a registered `ChatFormatter`, not through a substrate
  branch. (See [[2026-05-10-chat-display-contract]].)
- [ ] **C12 (P3).** The toolbar descriptor's `actions` are declared
  as data, not as inline HTML. The substrate renders them.
- [ ] **C13 (general).** All catalog UI is keyboard-reachable. Focus
  ring uses the substrate's `--color-input-focus-border` token. Tab
  order matches reading order.

A catalog that passes all 13 items is conformant. The current
catalogs pass roughly: chat ~12, pinboard ~10, dubspace ~10,
weather ~11, block ~12, taskspace ~6. Taskspace's gap is the conformance
proof for the brief (see §8 — P4 refit).

## 4. Token vocabulary

Tokens are declared on `:root` in `src/client/styles.css`. The
proposed scales below were derived by auditing the current
catalog UI files and styles.css for inline literals (counts in
parentheses are uses of the dominant value; raw audit numbers are
in the section after each table).

### 4.1 Spacing

The audit found `gap`/`padding`/`margin` values clustered around
0.25rem, 0.45rem (the most common gap, 8 uses), 0.55rem, 0.75rem,
1rem (the most common padding, 5 uses), 1.5–2rem. A 6-step scale
captures these with minimal rounding drift:

```css
--space-0: 0;
--space-1: 0.25rem;   /* xs gaps, tight chip padding */
--space-2: 0.5rem;    /* dominant gap; replaces 0.45/0.5/0.55 */
--space-3: 0.75rem;   /* mid; replaces 0.7/0.75/0.8 */
--space-4: 1rem;      /* dominant card padding */
--space-5: 1.5rem;    /* section spacing */
--space-6: 2rem;      /* large surface padding */
```

Migration: 0.45rem and 0.55rem round to `--space-2`; 0.7–0.8 round
to `--space-3`; 1.75/2rem round to `--space-6`. Visual drift is
within 0.1rem in all cases — invisible at body type size.

### 4.2 Typography

`--font-body` and `--font-mono` already exist
(`src/client/styles.css:110–111`); the brief preserves them. The
type scale is missing. The audit found font-size literals
clustered around 0.72rem (xs, 13 uses), 0.82rem (sm, 18 uses), 1rem
(body), 1.4rem (lg, 3 uses), 1.5rem (xl, 3 uses); plus one
catalog-specific 5.5rem for the weather temperature.

```css
--text-xs: 0.72rem;   /* meta, captions, status pills */
--text-sm: 0.82rem;   /* dominant secondary text */
--text-md: 1rem;      /* body */
--text-lg: 1.25rem;   /* subheadings */
--text-xl: 1.5rem;    /* page headings */
```

Catalog-specific display sizes (weather's 5.5rem) stay inline as
catalog code; they are by-definition one-offs and don't deserve a
shared name.

Font weight (audit: 600 dominant with 5 uses, 700 secondary with 2,
650 one outlier to retire):

```css
--weight-regular: 400;
--weight-medium: 600;
--weight-bold: 700;
```

Line height (audit: 1, 1.25, 1.45):

```css
--leading-tight: 1;     /* buttons, icons, single-line chips */
--leading-snug: 1.25;   /* headings */
--leading-relaxed: 1.45; /* body */
```

### 4.3 Radius

Audit: 4px (4 uses), 6px (8 uses, dominant), 10px (2 uses), 999px
(3 uses, for pills), 50% (2 uses, for circles).

```css
--radius-sm: 4px;     /* inputs, small chips */
--radius-md: 6px;     /* cards, dominant */
--radius-lg: 10px;    /* panels */
--radius-pill: 999px; /* pill buttons */
--radius-circle: 50%; /* avatars, dots */
```

### 4.4 Motion

Audit: 120ms with `ease` (3 uses, dominant); 360ms and 480ms with
`cubic-bezier(0.16, 1, 0.3, 1)` (1 use each, decelerate curve for
spatial transitions).

```css
--motion-fast: 120ms;
--motion-medium: 240ms;
--motion-slow: 480ms;

--ease-default: ease;
--ease-decelerate: cubic-bezier(0.16, 1, 0.3, 1);
```

Usage: state transitions (hover, focus, active) use
`--motion-fast --ease-default`; layout/position transitions use
`--motion-slow --ease-decelerate`. The 240ms middle step is
provided for the cases neither workhorse fits (modal fade-in,
toast drift).

### 4.5 Elevation

Four tokens already exist
(`src/client/styles.css:114–117`): `--shadow-card`, `--shadow-pin`,
`--shadow-tooltip`, `--shadow-zoom`. The brief preserves three and
retires the catalog-named one:

```css
--shadow-card: 0 8px 24px rgba(0, 0, 0, 0.55);     /* resting cards */
--shadow-tooltip: 0 6px 16px rgba(0, 0, 0, 0.6);   /* tooltips, popovers */
--shadow-zoom: 0 4px 12px rgba(0, 0, 0, 0.5);      /* focus/active emphasis */
```

`--shadow-pin` (currently in substrate, pinboard-named) moves into
`catalogs/pinboard/ui/` as catalog-local CSS, or is renamed
`--shadow-resting` if it generalizes. The decision is the
pinboard catalog's at refit time.

### 4.6 Color migration

The substrate already has ~30 color tokens at
`src/client/styles.css:6–105`. The semantic ones
(`--color-bg`, `--color-surface`, `--color-text`,
`--color-accent`, etc.) are preserved. The catalog-named ones are
moved out:

| Current substrate token | Disposition |
|---|---|
| `--color-board`, `--color-board-grid`, `--color-board-border`, `--color-board-map`, `--color-board-empty` | Move to `catalogs/pinboard/` stylesheet. |
| `--color-note-yellow`, `--color-note-blue`, `--color-note-green`, `--color-note-pink`, `--color-note-white`, `--color-note-text`, `--color-note-border`, `--color-note-shadow`, `--color-note-tooltip-bg`, `--color-note-tooltip-border`, `--color-note-meta-bg` | Move to `catalogs/note/` (or pinboard, depending on which catalog actually consumes them). |
| `--color-dial-border`, `--color-dial-center`, `--color-dial-pointer`, `--color-dial-band-1..4` | Move to `catalogs/dubspace/` stylesheet. |

Move mechanism: each catalog gains a `ui/<catalog>.css` file
referenced from its manifest. Substrate `styles.css` loses
catalog-specific entries. This is mechanically straightforward;
the principle-1 win is that the substrate stops naming catalogs in
its variable list.

## 5. Mobile model

Two shell modes; the substrate switches between them based on
viewport, gesture, and explicit catalog-switch requests. The mode
is exposed as `data-shell-mode` on `<div class="shell">` so
catalogs can read it without depending on viewport math.

### 5.1 Within-catalog (focus mode) — the default

The active catalog's main content occupies the full content
region. The ambient companion is collapsed to a single-row handle
at the bottom, expandable by tap. The catalog switcher is dismissed
(see 5.2). The observations panel is hidden behind an explicit
toggle on mobile and side-rail on desktop.

This mode applies on every viewport. The difference between
desktop and mobile is *how aggressively* the regions around the
main content collapse — not whether the user is "in" the catalog.

### 5.2 Between-catalog (switcher mode)

The catalog switcher is foregrounded. Catalogs are presented as
cards or a list (a single decision the substrate makes — the brief
picks **cards**, two columns on mobile, three to four on desktop,
each card showing the catalog's `display_name`, optional icon, and
a one-line live indicator if the catalog supplies one).

Between-catalog mode is **modal**: it overlays the previous content
and dismisses on selection or backdrop tap. The previously active
catalog is restored when the mode is dismissed without a switch.

### 5.3 Switcher mechanic — pinned

**Decision: fullscreen overlay invoked from a persistent corner
control.**

The corner control sits at the top-left on mobile (replacing the
collapsed nav) and at the top of the persistent nav rail on
desktop. Tap or click opens the switcher overlay; tap on a card or
press Escape closes it.

Argument for fullscreen overlay over alternatives:

- **vs. bottom-sheet drawer.** A bottom-sheet drawer requires
  swipe-up affordance that mobile users learn unreliably and
  conflicts with content-area scroll gestures (especially in
  pinboard pan/zoom). The overlay separates intent from content
  gestures cleanly.
- **vs. hamburger nav drawer (left-edge).** A side drawer
  competes with browser-back gestures on iOS Safari and Chrome
  Android. The overlay's invocation is button-only.
- **vs. swipe-between-catalogs gesture.** A horizontal swipe to
  change catalogs sounds elegant but assumes a totally-ordered
  catalog list, fights pinboard pan, and is invisible to keyboard
  users. The brief rejects it.

The overlay's visual treatment is chrome (deferred to a later
visual pass). The mechanic — control → overlay → card → dismiss —
is fixed by this brief.

### 5.4 Breakpoints

The two current substrate breakpoints
(`src/client/styles.css:1948,2082`) are kept as the *fallback*
behavior — they handle the layout-collapse mechanics within
within-catalog mode (three-column → single-column, control sizing).
The shell-mode switching is layered on top.

No new breakpoints. The two modes carry all the cross-cutting
responsive behavior.

## 6. Shell-level command surface

**Decision: do not add a generic command palette.** The catalog
switcher (§5) absorbs the only shell-level command that exists
today. World-level commands stay in chat, parsed by the chat
catalog's parser. This is consistent with the layering rule: the
substrate must not host a parser; the parser is in superstructure.

Revisit conditions: a generic shell-level command palette becomes
worth its weight when there are ≥3 shell-level commands beyond
catalog-switch. Candidates the brief acknowledges but does not
adopt: jump-to-space search, recent-spaces list, sign-out, theme
toggle. Two or fewer is not enough to justify a new surface.

Until then, the catalog switcher's overlay (§5.3) is the place a
fourth shell-level command would land first — likely as a search
field at the top of the overlay.

## 7. Identity surface

The current implementation at `src/client/main.ts:2813–2814` shows
the actor label and the raw actor id in a `.brand` + `.actor` div
pair, unstyled and not interactive. The brief replaces it with a
proper identity surface owned by the substrate.

### 7.1 What it shows

- The actor's display label (rendered via `actorLabel()`).
- An avatar: initial + deterministic color (no avatar upload in
  this brief). The color is derived from the actor id; the
  substrate provides the derivation.
- The raw actor id is hidden in normal display, surfaced on click.

### 7.2 What it does on click

A small popover with:

- Actor id (copyable).
- "Sign out" action (`data-identity-action="sign-out"`).
- "Settings" action if the substrate has any user-scoped settings
  (default: none in this brief; placeholder for future).

### 7.3 What it does *not* consume

- **Presence.** Who else is in this room/board/space is not the
  identity surface's concern. Presence is catalog-supplied and lives
  inside the ambient companion (today: chat's roster).
- **Catalog state.** The identity surface does not know which
  catalog is active; it is shell, not content.
- **Per-catalog actor metadata.** If a catalog wants to display
  "you have 3 unread notes," it does so via its own toolbar
  descriptor, not by feeding data into the identity surface.

### 7.4 Where it lives in the shell grid

Top-left of the nav rail on desktop, replacing the unstyled
brand/actor block. On mobile, in the top bar adjacent to the
catalog-switcher control (per §5.3).

## 8. Conformance migration sequence

A shape-of-the-work overview, mapping the framing's P0–P5
sub-problems to concrete file changes. Sizes are rough estimates
to set expectations; an implementation plan is a separate
document.

| Sub-problem | Files touched | Rough size | Depends on |
|---|---|---|---|
| **P0 — Shell/content boundary** | `src/client/main.ts:2812–2829, 3369–3403`; `src/client/framework.ts`; per-catalog `manifest.json` (add `nav`, `components.role`) | ~+150/-200 lines, ~9 manifests | [[2026-05-10-chat-display-contract]] landing first; this generalizes its registry pattern. |
| **P1 — Ambient-companion slot** | Rename `data-tool-space-chat` → `data-ambient-companion` across the three workspace catalogs + `src/client/main.ts:4263–4275`; rename `renderSpaceChatPanel` → `renderAmbientCompanion`. | ~+0/-0 net (rename + small registry shim) | P0 (registry-driven mounting). |
| **P2 — Catalog switcher** | `src/client/main.ts:2812–2823` (nav rewrite); new switcher overlay component in substrate; per-catalog manifest `nav` block. | ~+250/-50 in `main.ts`, ~+5 lines per catalog manifest | P0. |
| **P3 — Token vocabulary** | `src/client/styles.css:6–117` (token expansion); audit + replace inline literals across all `catalogs/*/ui/*.ts` and rule blocks. | ~+50 lines in `styles.css`; ~50-100 literal replacements across catalogs | None — can be done in parallel with P0. |
| **P4 — Taskspace refit** | `catalogs/taskspace/ui/taskspace-workspace.ts:53–77` (toolbar extraction, class renaming, slot rename); `catalogs/taskspace/manifest.json` (nav, components, toolbar descriptor). | ~+50/-40 lines in element; ~+10 lines manifest | P0, P1, P3. |
| **P5 — Mobile model** | `src/client/main.ts` (shell-mode switching, switcher overlay invocation, gesture wiring); `src/client/styles.css` (shell-mode rules at the two existing breakpoints). | ~+200 in `main.ts`, ~+100 in `styles.css` | P0, P2. |

Total rough scope: ~600-800 lines of substrate change, ~150–250
lines of catalog change, ~9 manifest updates. The work distributes
across P0–P5 over weeks of effort, not days. P0 is the long pole.

## 9. What this brief does not cover

- **Visual identity / brand.** Logo, illustration, voice, copy
  tone. The brief commits to *structure*; chrome is a separate
  pass.
- **Motion choreography.** The brief specifies duration and easing
  tokens; it does not specify which transitions exist or how they
  compose. Motion design is a separate pass.
- **Iconography.** The catalog switcher supports an optional icon
  per catalog; the icon set is not specified.
- **Accessibility audit.** WCAG-conformance, screen-reader
  semantics, focus order beyond the conformance checklist's C13
  item, color-contrast review. Separate work.
- **Non-browser clients.** MCP-driven shells, native shells,
  embedded surfaces. The contract should not preclude them, but
  this brief is browser-specific.
- **Catalog-author tooling.** Lints for class-name prefix or
  inline-literal detection, manifest validators. Implementation
  detail of how to *enforce* the contract; this brief defines
  *what* to enforce.

## 10. References

- [[2026-05-15-ui-problem-framing]] — audit, validated framing,
  constraints, prioritized sub-problems.
- [[2026-05-15-ui-shell-principles]] — six enforceable rules and
  the six open-questions answered.
- [[2026-05-10-chat-display-contract]] — the in-flight refactor
  whose pattern this brief generalizes to nav/components/toolbar.
- `AGENTS.md` — substrate/superstructure split, layering
  discipline, big-world principles.
- `src/client/main.ts:2810–2832` — shell grid construction (§2.1).
- `src/client/main.ts:2812–2823` — nav and identity, refit by
  §2.4, §7.
- `src/client/main.ts:2825–2829` — per-tab dispatch, retired by
  §2.4.
- `src/client/main.ts:3369–3403` — `isXObservation` predicates,
  retired by P0 / Principle 1.
- `src/client/main.ts:4263–4275` — `renderSpaceChatPanel`, renamed
  by P1 / §2.6.
- `src/client/styles.css:6–117` — token vocabulary (§4).
- `src/client/styles.css:68–94` — catalog-named color tokens
  migrating to catalog stylesheets (§4.6).
- `src/client/styles.css:1948,2082` — existing breakpoints
  preserved as fallback behavior (§5.4).
- `catalogs/taskspace/ui/taskspace-workspace.ts:53–77` — the
  conformance proof; refit per P4 (§8).
- `catalogs/pinboard/ui/pinboard-board.ts:137` — ambient companion
  slot declaration; renamed per §2.6.
- `catalogs/dubspace/ui/dubspace-workspace.ts` — same.
- `catalogs/chat/ui/chat-space.ts` — the ambient companion's
  current realization (registered as `chat.space-mini`); unchanged
  by this brief.
