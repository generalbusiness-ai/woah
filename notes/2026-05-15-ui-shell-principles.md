# UI shell principles

Status: principles draft, 2026-05-15. Six enforceable rules that
constrain the design brief. Each one earns its slot by resolving a
trade-off seen in the audit. None of them ratifies an existing layering
leak. None of them makes sense only on desktop. A reviewer should be
able to flag a violation in five minutes.

Builds on [[2026-05-15-ui-problem-framing]]. The
[[2026-05-10-chat-display-contract]] note is the precedent — it is
literally Principle 1 applied to one slice of the substrate.

## How to read these principles

Principles are numbered. Lower numbers are foundational; higher numbers
assume the lower ones hold. When two principles appear to conflict in a
specific decision, the lower-numbered principle wins.

Each principle is structured the same way:

- **Statement** — the rule, as a hard claim.
- **Why** — which audit finding or layering rule it enforces.
- **How to apply** — what a catalog or substrate author does differently.
- **Tension resolved** — the tempting alternative this rules out.
- **Counter-example** — a real or plausible violation, so the rule is
  testable.
- **Code locations** — the file paths and line ranges this principle
  changes or governs.

## Principle 1 — Substrate is catalog-blind

**Statement.** The substrate renders no UI, branches on no value, and
queries no DOM that mentions a catalog by name. Every place the
substrate currently knows that "pinboard" or "dubspace" or "chat"
exists becomes catalog-supplied metadata: a manifest entry, a
registered handler, a typed contract. The shell can render *whatever
catalogs the world is hosting*, never *the catalogs we happen to
ship*.

**Why.** `AGENTS.md` layering discipline:

> Core must stay catalog-agnostic and client-agnostic. … User-visible
> behavior belongs in woocode catalogs. Verbs such as `look`, `examine`,
> `who`, `join`, … and command parser conventions are catalog/
> superstructure behavior, even when they currently need a native
> helper.

The shell is "core" for client purposes. Today it knows the literal
words `chat`, `dubspace`, `pinboard`, `taskspace`, `ide` in its tab
list and three `isXObservation` predicates. Each of those is the same
class of bug as a VM that branches on bootstrap class names — see the
layering note in `AGENTS.md`:

> The VM and runtime core must not branch on bootstrap object
> identities or class names to change behavior. If a behavior depends
> on an object's role, express that role as catalog data, properties,
> verb metadata, or an explicit generic builtin argument.

**How to apply.** Two recurring techniques:

- The substrate accepts a *registry*. Catalog UI modules register
  what they need (observation types they format, components they
  expose, slots they fill). The substrate iterates the registry; it
  does not iterate a hardcoded list. [[2026-05-10-chat-display-contract]]
  is the worked example: `ChatFormatterRegistry` replaces the
  hardcoded `isChatObservation`/`chatSystemText` branches.
- The substrate reads *manifest metadata*. A catalog declares its
  nav-item display name, its primary component tag, its ambient-slot
  declarations. The substrate's catalog switcher iterates whatever
  manifests are installed.

**Tension resolved.** Tempting to keep one or two hardcoded entries
"because we always ship them anyway." Resist: the principle is
fragile if it admits exceptions, and the exceptions are exactly where
the next layering bug lands. The discipline pays off only at zero
tolerance.

**Counter-example.** A new substrate function `isTaskObservation(obs)`
that returns `true` for `task_created` / `task_completed` /
`task_status_changed` would be a direct repeat of the
`isPinboardObservation` mistake. Even if the function lives in a
"helper" file, even if it has a comment "remove when taskspace
formatter ships," it ratifies the wrong layering. The catalog
registers; the substrate dispatches.

**Code locations.**
- `src/client/main.ts:2812–2823` — nav tab list (the five literal
  catalog names) becomes a metadata-driven loop.
- `src/client/main.ts:3369–3403` — `isChatObservation`,
  `isDubspaceObservation`, `isPinboardObservation` are retired per
  the chat-display-contract pattern.
- `src/client/main.ts:2825–2829` — the per-tab dispatch in the main
  region (`state.tab === "pinboard" ? renderPinboard() : ""`)
  becomes a single dispatch to a metadata-resolved component tag.

## Principle 2 — Class names are catalog-prefixed

**Statement.** Every CSS class name introduced by a catalog UI module
is prefixed with the catalog's short name: `.pinboard-*`, `.chat-*`,
`.taskspace-*`, `.dubspace-*`, `.weather-*`, `.block-*`. Generic class
names with no prefix (`.toolbar`, `.card`, `.split`, `.empty-state`,
`.pill`) belong exclusively to the substrate and represent the shell
contract surface. A catalog UI that defines `.inspector` or `.tree`
or `.row` is in violation.

**Why.** The audit shows five of six catalogs already follow this
convention spontaneously. Taskspace is the only outlier, with
`.inspector`, `.task-row`, `.children` defined without prefix. With
no shadow DOM, the catalog prefix is the *only* collision protection
between catalogs that grow class names independently. The principle
turns a social norm into a written rule.

It also encodes the substrate↔catalog boundary directly in the
stylesheet: a reader scanning CSS sees a `.chat-feed` rule and knows
the catalog owns it; a `.toolbar` rule and knows the shell owns it.

**How to apply.**

- Pick the catalog name (manifest `name`) as the prefix.
- All locally-declared classes use the prefix.
- Generic-looking selectors like `.toolbar`, `.card`, `.empty-state`,
  `.pill`, `.split` are *consumed*, not *redefined*, by catalog UIs.
  If you want a variant ("a board-specific card"), name it
  `.pinboard-card` and let it inherit from `.card`.
- Substrate stylesheet (`src/client/styles.css`) owns the unprefixed
  generics. Catalogs do not write to those selectors.

**Tension resolved.** Tempting to use short, "obvious" class names —
they read better locally. But they cost coherence when a second
catalog needs the same word for a different concept. The principle
trades local readability for global predictability.

**Counter-example.** Taskspace's `.inspector` panel
(`catalogs/taskspace/ui/taskspace-workspace.ts:73`) is the textbook
violation. Should be `.taskspace-inspector`. If the inspector pattern
is generic enough to be reused, lift it to the substrate as a
documented split layout primitive (`.split-detail`) — but the catalog
does not get to claim the unprefixed name on its own.

**Code locations.**
- `catalogs/taskspace/ui/taskspace-workspace.ts:53–77` — rename
  `.inspector`, `.task-toolbar`, `.task-summary`, `.task-tree-list`,
  `.task-create`, `.children`, `.tree` into `.taskspace-*` (or move
  to substrate if the pattern generalizes).
- `src/client/styles.css` — the generic unprefixed selectors
  (`.toolbar`, `.card`, `.split`, `.empty-state`, `.pill`, `.pill--*`)
  are declared canonical here and owned by the substrate.

## Principle 3 — Toolbar provenance is the substrate's

**Statement.** The toolbar — the horizontal header strip at the top
of a workspace, carrying title, status filters, and per-workspace
controls — is rendered by the substrate. Catalogs supply the
*content* of that strip (title, action chips, filter affordances)
through declarative metadata or a typed slot, not by rendering the
`<section class="toolbar">` themselves.

**Why.** Audit finding: chat, dubspace, pinboard delegate the
toolbar to substrate; taskspace renders its own `<section
class="toolbar task-toolbar">` inline at
`catalogs/taskspace/ui/taskspace-workspace.ts:54–59`. The result is
visually different headers, different scroll behavior, different
empty-state placement, and a different relationship between the
toolbar and the workspace's main content area.

When the substrate owns the toolbar, mobile collapse is one decision
made in one place. When five catalogs each render their own, mobile
collapse is five decisions.

**How to apply.** Catalog UI modules export (or declare in manifest)
a small descriptor:

```
toolbar: {
  title: string,
  actions: ToolbarAction[],  // pills, filters, buttons
  status?: StatusBadge,
}
```

The substrate renders the strip. The catalog renders only the body
below it.

Workspace content elements like `WooTaskspaceWorkspaceElement` shrink
to: render the tree, the inspector, and the slot for the ambient
companion. The toolbar markup leaves the element entirely.

**Tension resolved.** Tempting to let the catalog render the toolbar
because "it knows its data best." It does — but the *layout role* of
the toolbar is a shell concern (where it lives on the screen, how it
collapses on mobile, how its scroll relates to the body). The
catalog supplies values; the substrate supplies layout.

**Counter-example.** A new dispenser workspace that, on its first
render, emits `<section class="toolbar dispenser-toolbar">` to show
"Dispenser • 3 pending orders" is the same mistake as taskspace.
Even if the toolbar markup is identical to the substrate's, the
ownership is wrong: any later change to toolbar layout has to chase
every catalog.

**Code locations.**
- `catalogs/taskspace/ui/taskspace-workspace.ts:53–60` — the inline
  toolbar moves into a `toolbar` descriptor; the rendered element
  body starts at the split layout.
- `src/client/main.ts` (currently renders the toolbar inline in
  per-tab render functions like `renderPinboard`, `renderTaskspace`,
  `renderChat`) — these collapse into one toolbar renderer that
  reads catalog metadata.

## Principle 4 — One ambient slot, declared by the workspace

**Statement.** A workspace catalog declares exactly one slot for an
ambient companion using a stable, documented data attribute. The
substrate decides which catalog fills it. Chat is the first user.
Additional ambient slots ("leading," "overlay," "trailing") are not
introduced until a second companion exists and a workspace
demonstrably needs both at once.

**Why.** Three of three workspace catalogs already declare
`<div data-tool-space-chat>` and the substrate mounts
`woo-space-chat-panel` into it via `renderSpaceChatPanel`
(`src/client/main.ts:4263–4275`). The convention works. The mistake
would be to formalize it as a permissive multi-slot framework
("leading / trailing / overlay") before any catalog has asked for a
second slot.

The chat-everywhere mini-mode is the working prototype: ambient
content lives in a known location, collapses to a handle, follows
the user across workspaces. Generalize from one slot. Add slots when
the cost of not having them is concrete.

**How to apply.**

- Rename the data attribute to something not chat-specific (proposal:
  `data-ambient-companion`) and document it in the spec.
- Workspace catalogs declare the slot once, near the bottom of their
  layout.
- The substrate's catalog registry resolves "which ambient companion
  is mounted for this space?" — defaults to chat; can be overridden
  by world configuration (e.g. a dispenser-only world might mount a
  dispenser-status companion instead).
- Catalogs *not* shaped like workspaces (badge-style: weather)
  declare no slot and receive no ambient companion. Workspace-ness
  is the trigger.

**Tension resolved.** Tempting to design the slot framework
ambitiously ("leading / trailing / overlay / floating") to "leave
room." Resist: design space left open is design space someone fills
with the wrong thing. Add the second slot when the second companion
appears.

**Counter-example.** A future presence companion that wants to live
*alongside* chat in every workspace would be the right moment to
introduce a second slot. Until that companion exists, the slot
remains singular.

**Code locations.**
- `src/client/main.ts:4263–4275` — `renderSpaceChatPanel` becomes
  `renderAmbientCompanion(space)`, parameterized by the registry.
- `catalogs/pinboard/ui/pinboard-board.ts:137`,
  `catalogs/taskspace/ui/taskspace-workspace.ts:61,75`,
  `catalogs/dubspace/ui/dubspace-workspace.ts` — `data-tool-space-chat`
  attribute renamed; the wrapping `data-space-chat-shell` likewise.

## Principle 5 — Tokens, not values

**Statement.** Every recurring visual decision — spacing, typography,
sizing, radius, motion, color — is a CSS custom property declared on
`:root` in `src/client/styles.css`. Catalog UI modules reference
tokens. Literal pixel values, hex colors, font sizes, and durations
inline in catalog code are code smells; a recurring literal is a
missing token.

**Why.** The audit found 30+ color variables (some of them
catalog-specific, like `--color-board` and `--color-dial-pointer`,
which is itself a layering-leak smell — see Principle 1) but
*zero* spacing, typography, radius, or motion tokens. Every catalog
re-decides those inline. The result is drift that no one notices
until two catalogs end up next to each other in mobile collapse.

Tokenization also makes themability and accessibility variants
tractable: a high-contrast mode or a denser layout is a token swap,
not a per-catalog audit.

**How to apply.**

- Audit existing catalog UIs for recurring literals (pixel values,
  font-size declarations, transition durations, border radii). Each
  recurring literal becomes a named token.
- Catalog-specific colors that currently live in `:root`
  (`--color-board`, `--color-note-yellow`, `--color-dial-pointer`)
  migrate into the catalog's own stylesheet *or* are renamed as
  generic semantic tokens (`--color-surface-cork`,
  `--color-accent-warm`) the catalog references. Either way, the
  substrate token list stops naming catalogs.
- New visual decisions are added to the token vocabulary first,
  then consumed by catalogs.

**Tension resolved.** Tempting to inline "just this one value." But
the principle's value is precisely that it applies on the margin —
the next inline value is the one that creates drift.

**Counter-example.** A catalog that declares `padding: 12px` in
several places without referencing a `--spacing-3` token (or
whatever the agreed name is) is in violation. The number 12 itself
isn't the problem; the absence of a shared name for it is.

**Code locations.**
- `src/client/styles.css:6–105` — the token vocabulary expands to
  cover spacing, typography, radius, motion, elevation.
- `src/client/styles.css:6–105` — the existing catalog-specific
  color tokens (`--color-board`, `--color-note-yellow`,
  `--color-dial-pointer`) are renamed to be generic or moved out of
  the substrate's `:root`.
- All `catalogs/*/ui/*.ts` files — inline literal values audited and
  swapped for token references.

## Principle 6 — One contract, two layouts

**Statement.** A catalog satisfies the shell contract once; the
substrate produces both mobile and desktop layouts from that single
satisfaction. Catalogs do not ship their own breakpoints or
mobile-specific markup by default. The two interaction modes are
named and orthogonal:

- **Within-catalog** (focus mode): content area dominates; ambient
  companion is collapsed to a handle; switcher is dismissed.
- **Between-catalog** (switcher mode): the catalog switcher is
  foregrounded; whatever was on screen recedes.

Both modes apply equally on mobile and desktop — the difference is
how aggressively the layout collapses, not which catalogs are
visible.

**Why.** The framing's constraint: *mobile-first thinking,
desktop-graceful.* Today the model is the reverse — desktop-first,
two breakpoints that shrink the layout (`src/client/styles.css:1948,
2082`), no catalog mobile rules, no within-catalog vs between-catalog
distinction in code. That is exactly the kind of state where
fragmentation reappears the moment someone adds a third breakpoint
"just for taskspace."

If the contract requires the substrate to produce two layouts from
one catalog declaration, catalogs are forced to declare cleanly
enough that the substrate *can* derive both. The discipline goes
back upstream into the contract, where it belongs.

**How to apply.**

- The substrate's responsive primitives expand from "two
  breakpoints that shrink things" to "named layout modes the shell
  switches between." The two modes above are the starting set.
- A catalog UI element declares its content area and (if a
  workspace) its ambient slot. The substrate decides whether the
  ambient slot is sibling-rendered, overlay-rendered, or
  bottom-sheet-rendered based on viewport width.
- Catalog-local breakpoints are a violation unless they are
  *content-internal* (e.g. a pinboard zoom level changes at a viewport
  width). Cross-cutting layout breakpoints belong to the substrate.
- Catalog switchers are reachable from every catalog at every
  viewport; the switcher invocation gesture is the same everywhere
  (proposal: a corner control on mobile, the persistent nav on
  desktop).

**Tension resolved.** Tempting to define a "mobile spec" alongside
the desktop one — two documents, two layouts, two sets of
breakpoints. Resist: that bifurcation is the source of the
fragmentation in the first place. One contract; the substrate
derives.

**Counter-example.** A catalog that ships its own `@media (max-width:
600px)` block to rearrange its toolbar and content area is in
violation: the toolbar is owned by the substrate (Principle 3) and
the layout mode is owned by the substrate (Principle 6). If the
catalog needs to *behave* differently on mobile, it does so by
declaring metadata (e.g. "this action should collapse into the
overflow menu first") rather than by rewriting layout.

**Code locations.**
- `src/client/styles.css:1948,2082` — the existing breakpoints are
  validated, replaced, or supplemented by named layout modes; no
  catalog file gains a new breakpoint.
- `src/client/main.ts` — the shell renderer learns to switch between
  within-catalog and between-catalog modes; the gesture or control
  that triggers between-catalog mode is added as a substrate
  affordance.

## Applied to the six open questions

The framing left six open questions for principles to answer.

**Q1 — How many ambient companion slots?** *Answered.* Principle 4:
**one.** A single slot, declared by workspace catalogs as
`data-ambient-companion` (or successor name), filled by the
substrate. Multi-slot is deferred to the brief if and only if a
second companion catalog appears with a concrete use case.

**Q2 — Single substrate command surface, or commands through chat?**
*Partially answered; remainder deferred.* World-level commands (verbs
the user issues to the world, parsed by the chat catalog's parser)
stay in chat — that is superstructure and Principle 1 prevents
moving the parser into the substrate. *Shell-level* commands
(catalog switch, search, jumpwords, settings) are substrate
concerns and need a substrate-owned affordance separate from the
chat input. Whether that affordance is a command palette, a
keystroke-only surface, or absorbed into the catalog switcher itself
is **deferred to the brief** — the deciding factor is whether
shell-level commands beyond catalog-switch will accumulate, and the
audit found none today besides switch.

**Q3 — Where does identity live?** *Answered.* Shell, not chat. The
nav already shows `actorLabel(state.actor)` at
`src/client/main.ts:2813` — identity is substrate-owned because the
actor session is substrate state, not chat state. Presence (who else
is in this room) is catalog-supplied because it depends on
catalog-defined audience semantics. The brief should clean up the
nav's brand/actor rendering into a proper identity surface; this is
not a separate companion catalog.

**Q4 — Mobile catalog-switch mechanic?** *Partial; deferred to brief
for the chrome.* Principle 6 establishes that the catalog switcher
is a substrate affordance reachable from every viewport. The
*mechanic* — fullscreen overlay invoked from a corner control vs
bottom-sheet drawer vs gesture — is brief-detail and depends on
chrome decisions that come after structure. The principle's
non-negotiable: whatever the mechanic is, it is the same in every
catalog and produced by the substrate, not by the catalog being
left.

**Q5 — Shadow DOM later?** *Deferred.* Principles 2 (class prefixes)
and 5 (tokens) are precisely what makes a future shadow-DOM
transition cheap, because today's catalog stylesheets already act
*as if* they were encapsulated. The contract does not require
shadow DOM and does not foreclose it. The deciding factor — whether
a remote catalog needs to ship CSS the substrate can't see — is not
present today; revisit when it is.

**Q6 — Class-naming prefix convention.** *Answered.* Principle 2:
**required**, not recommended. Catalog name as prefix
(`.pinboard-*`, `.chat-*`, …); unprefixed names reserved for the
substrate's shell contract.

## What this principles pass deliberately does not do

- It does not write the brief. The brief is the next skill
  (`/ux-strategy:design-brief`).
- It does not specify chrome — typography choices, motion curves,
  color palette adjustments, switcher gesture details.
- It does not commit to a refactor sequence. The framing's P0–P5
  sub-problems remain the thinking order; an implementation plan
  picks the doing order.
- It does not enumerate every token the vocabulary will eventually
  carry. The brief will list tokens; the principle just says they
  must exist.

## References

- [[2026-05-15-ui-problem-framing]] — the framing this builds on.
- [[2026-05-10-chat-display-contract]] — Principle 1 applied to one
  slice of the substrate; the model for the rest.
- `AGENTS.md` — substrate/superstructure split, layering discipline.
- `src/client/main.ts:2812–2823` — nav tab list (Principle 1).
- `src/client/main.ts:3369–3403` — `isXObservation` predicates
  (Principle 1).
- `src/client/main.ts:4263–4275` — `renderSpaceChatPanel`
  (Principle 4).
- `src/client/styles.css:6–105` — current token vocabulary
  (Principle 5).
- `src/client/styles.css:1948,2082` — current breakpoints
  (Principle 6).
- `catalogs/taskspace/ui/taskspace-workspace.ts:53–77` — Principles
  2, 3, and 4 all change something here. The taskspace refit is the
  conformance proof.
