# UI problem framing

Status: problem framing, 2026-05-15. No solution proposals here — this
exists to constrain the work that follows (a written design-system /
shell-contract brief, then principles, then concrete refactors).

## Premise

The browser client has accumulated nine catalog UI modules plus a
substrate-owned shell, with one ongoing layering refactor
([2026-05-10-chat-display-contract](2026-05-10-chat-display-contract.md))
already pulling chat-formatting concerns out of `src/client/main.ts`.
Inside that accumulation are an accidental success
(`woo-space-chat-panel`'s collapsible mini-mode appearing in every
workspace) and several accidental incoherences (taskspace owning its own
toolbar, substrate hardcoding catalog-named filters, no shared token
vocabulary beyond color, no mobile interaction model).

The work to do is *not* a component library. Light-DOM cascading from
`src/client/styles.css` is the current rendering strategy and works.
What is missing is a written contract that names what the substrate
shell owns, what catalog UI owns, how they compose, and how that same
contract collapses to mobile.

## Problem statement

Catalog UIs in woo currently share no enforceable shell contract. Each
catalog reinvents toolbar, layout, scroll, and slotting conventions,
and the substrate compensates with catalog-specific code paths that
violate the layering discipline in `AGENTS.md`. There is no written
description of which conventions are load-bearing and which are
accidental, and no description of how the model adapts to mobile —
either within a catalog (focus on one workspace) or across catalogs
(switching between them).

The goal is a written brief that defines a **shell contract**: the small
set of conventions a catalog UI must satisfy to feel native, the
ambient companions the substrate provides (chat being the first
instance), and how the contract collapses for mobile. The brief should
make the existing chat-everywhere success reproducible and make
taskspace conform without inventing a new style.

## Validating the "shell contract" framing

The framing **fits the grain of the existing code**, with caveats. The
audit confirms:

- Three of three workspace catalogs (pinboard, taskspace, dubspace)
  already declare a `data-space-chat-shell` wrapper and a
  `data-tool-space-chat` slot
  (`catalogs/pinboard/ui/pinboard-board.ts:137`,
  `catalogs/taskspace/ui/taskspace-workspace.ts:61,75`,
  `catalogs/dubspace/ui/dubspace-workspace.ts`). The substrate then
  mounts `woo-space-chat-panel` into that slot via
  `renderSpaceChatPanel` in `src/client/main.ts:4263–4275`. This *is*
  an organic shell contract, by convention and not by name.
- `src/client/styles.css:6–105` already defines a token vocabulary —
  but only for color. There are no tokens for spacing, typography,
  sizing, motion, or elevation. Catalog files inline these values
  ad hoc.
- Light-DOM cascading from `styles.css` is the actual rendering model;
  no catalog uses shadow DOM. The contract therefore is enforced by
  documentation and code review, not by encapsulation.

But the framing also exposes real layering violations that the brief
will have to confront:

- `isChatObservation` / `isDubspaceObservation` / `isPinboardObservation`
  in `src/client/main.ts:3369–3403` hardcode catalog-named observation
  type lists in the substrate. The
  [chat-display-contract](2026-05-10-chat-display-contract.md) work is
  pulling the chat side of this into catalog-registered formatters,
  but the dubspace and pinboard branches remain.
- The navigation tab list in `src/client/main.ts:2812–2823` hardcodes
  `chat|dubspace|pinboard|taskspace|ide` — five catalog names baked
  into the substrate. A clean shell contract requires the catalog
  switcher be driven by catalog metadata, not a literal.
- The substrate does not currently surface anything resembling an
  identity badge, command surface, or catalog switcher distinct from
  the tab nav. The "shell" today is genuinely thin: shell grid +
  observations panel + a slot for one tab's content. If the contract
  is to mean anything, the substrate has to grow at least one or two
  more shell affordances (a unified command surface and a catalog
  switcher are the leading candidates), not just document what's there.

So: **the framing is correct but the existing shell is undercooked**.
The brief is not "stop catalogs from drifting" — it is "promote one
working convention (the `data-tool-space-chat` slot), retire the
layering leaks, and give the substrate the missing shell affordances
that make the contract teachable."

## Concrete fragmentation evidence

Findings that should appear, citation-and-all, in the eventual brief:

1. **Toolbar ownership is inconsistent.** Chat and dubspace let the
   substrate render the outer `<section class="toolbar">`; pinboard
   does the same; taskspace renders its own `task-toolbar` inside its
   element body (`catalogs/taskspace/ui/taskspace-workspace.ts:54–59`).
   Result: visually different headers, different scroll behavior,
   different empty-state placement.
2. **Class-naming convention is unwritten.** Pinboard, dubspace,
   weather use catalog-prefixed classes (`.pinboard-*`, `.dubspace-*`,
   `.weather-*`); taskspace uses generic names without a catalog
   prefix (`.inspector`, `.task-row`, `.children`). Nothing in
   `src/client/styles.css` has prefix discipline either way — it is a
   social convention five out of six catalogs follow and one does not.
3. **Tokens are color-only.** `:root` in `src/client/styles.css:6–105`
   has ~30 color variables, including catalog-specific colors
   (`--color-board`, `--color-note-yellow`, `--color-dial-pointer`).
   There are zero spacing, typography, radius, motion, or elevation
   tokens. Every catalog re-decides those inline.
4. **No documented slot pattern.** The `data-tool-space-chat` slot is
   used by three catalogs and read by substrate code, but is not
   documented anywhere; new workspaces have no signpost telling them
   to adopt it.
5. **Substrate knows catalog names.** Beyond the `isXObservation`
   functions and the tab list, the substrate has direct
   `document.querySelector("[data-dubspace-workspace]")` and similar
   queries for at least three catalogs.
6. **No mobile interaction model.** Two breakpoints exist in
   `src/client/styles.css` (980px at line 1948, 520px at line 2082).
   They collapse the three-column shell to one and shrink controls.
   No catalog defines its own mobile rules; no touch-specific gesture
   wiring exists; the within-catalog focus vs cross-catalog switching
   distinction has no code expression.

## Scope

**In scope.** The browser client at `src/client/` and all catalog UI
modules under `catalogs/*/ui/`. The shell contract: what the substrate
renders, what slots it offers, how catalogs mount, what conventions
they must follow, how the substrate routes observations and commands.
The mobile interaction model that follows from the contract.

**Out of scope.** Server-side rendering changes. Non-browser clients
(MCP, future native shells) — though the contract should not preclude
them. New visual identity / brand work — the brief should establish
*structure* first; chrome can be reskinned later without changing the
contract. Per-catalog feature design (new observations, new commands)
unless required to demonstrate the contract.

**Adjacent but referenced, not redesigned.** The chat-display-contract
work already in flight stays in its own design note; the framing
brief just needs to point at it as the reference for how
substrate↔catalog contracts get retired.

## Constraints

- **Layering (`AGENTS.md`).** The substrate must not know catalog
  names, observation types, or class names. Anything that branches on
  those today must be retired or expressed as catalog-supplied
  metadata. The brief cannot ratify the existing hardcodes.
- **Big-world discipline.** No global enumeration. The catalog
  switcher cannot assume a known finite set of catalogs; it has to be
  driven by what the world is hosting.
- **Substrate is shipped TypeScript, superstructure is woocode.** UI
  for catalogs lives in `catalogs/<name>/ui/*.ts` and gets bundled
  through the same path as other catalog code. The contract has to be
  expressible there, not require shipping new substrate per catalog.
- **No shadow DOM (today).** The brief should not require it; the
  contract has to work under light-DOM cascading. If shadow DOM
  becomes desirable later, the contract should not foreclose it.
- **Chat-everywhere mini-mode is preserved.** The collapsible
  `woo-space-chat-panel` in workspaces is the working prototype of the
  ambient-companion pattern. The brief generalizes from it; it does
  not rewrite it.
- **Mobile-first thinking, desktop-graceful.** Existing code is
  desktop-first with two breakpoints. The brief should invert the
  default — define mobile first, treat desktop as the wider variant —
  without forcing a full CSS rewrite up front. Concretely: the
  contract specifies behaviors (focus mode, switcher, ambient
  collapse) and the desktop layout becomes one realization.
- **Taskspace must conform.** It is the canary. If the contract
  cannot accommodate the taskspace's tree+inspector layout without
  the current oddities, the contract is wrong.

## Stakeholders

- **Catalog authors.** Need a small, learnable set of rules: where to
  put a toolbar, what slot to declare, what class prefix to use,
  what observation contract to register. They pay the cost of
  conformance and earn coherent behavior in return.
- **Substrate maintainers.** Get to retire catalog-specific code
  paths (`isPinboardObservation`, hardcoded tabs, per-catalog
  selectors). They pay the cost of building the missing shell
  affordances (catalog switcher, command surface) and the cost of
  documenting and enforcing the contract.
- **End users (browser).** Get a coherent surface that does not
  surprise them when they switch catalogs, and a mobile experience
  that does not require a separate spec to be readable.
- **Future client authors (MCP-driven, native, embedded).** Should be
  able to reuse the contract conceptually even if their realization
  differs. The brief should not be browser-only by accident.

## Success criteria

A successful brief makes the following statements verifiable:

1. **Conformance is checkable.** Given a catalog UI module, a reviewer
   (or a lint) can answer "does this conform to the shell contract?"
   in under five minutes. The contract is specific enough to fail an
   audit, not just inspire one.
2. **Taskspace fits.** The taskspace workspace, refit per the
   contract, is no longer the canary case — its tree+inspector layout
   is one valid realization of a documented split pattern, with the
   same toolbar provenance as chat and pinboard.
3. **No new substrate code branches on catalog identity.** After the
   refactors implied by the contract, `src/client/main.ts` and
   `src/client/framework.ts` contain zero references to
   catalog-specific class names, observation types, or tab names. The
   tab list, the observation filters, and the mounting selectors are
   all driven by catalog-supplied metadata.
4. **Chat-everywhere generalizes.** The slot that today hosts chat
   can host at least one other ambient companion (candidate:
   presence, or a command surface) without rewriting the workspace
   catalogs. The brief names which companions exist and how they
   compose.
5. **Mobile is derivable.** The brief defines two interaction modes —
   within-catalog (content-focused, shell minimized) and
   between-catalog (shell foregrounded, catalogs as cards) — that
   collapse from the same contract. A reader can predict mobile
   behavior of a new catalog without reading its CSS.
6. **Tokens cover the recurring decisions.** The token vocabulary
   grows to cover spacing, typography, sizing, radius, and motion.
   Catalogs that follow the tokens render coherently; catalogs that
   override them stand out by design.

## Sub-problems, prioritized

P0 is highest priority. The numbering reflects what must be settled
first; later items depend on earlier ones.

- **P0 — Shell/content boundary.** Name precisely what the substrate
  owns vs what catalogs own. Retire all catalog-name and
  observation-type branching from substrate. This is the foundation;
  nothing else in the brief is enforceable without it. Builds on the
  chat-display-contract work already underway.
- **P1 — Ambient-companion slot pattern.** Formalize the
  `data-tool-space-chat` convention as a named slot mechanism that
  any workspace catalog declares and any ambient catalog can
  populate. Chat is the first user. Decide whether more than one
  ambient slot is needed (e.g. "leading" / "trailing" / "overlay"),
  driven by what the existing UIs actually need, not by speculation.
- **P2 — Catalog switcher and command surface.** Replace the
  hardcoded five-tab nav with a metadata-driven switcher. Decide
  whether there is a single substrate command surface (search,
  jumpwords, catalog actions) or whether commands are dispatched
  through chat as today.
- **P3 — Token vocabulary expansion.** Spacing, typography, sizing,
  radius, motion tokens added to `src/client/styles.css`. Existing
  catalog inline values audited and aligned. The token list is
  derived from what the UIs currently use, not invented.
- **P4 — Taskspace refit as proof.** Reshape the taskspace workspace
  to conform to the contract end-to-end. Its current anomalies
  (own toolbar, generic class names, inspector column without a
  shared split pattern) become the test cases that prove the
  contract is enforceable.
- **P5 — Mobile interaction model.** Define within-catalog focus mode
  and between-catalog switcher behavior. Express them as derivations
  of the shell contract, with the existing two breakpoints either
  validated or replaced.

## What this framing deliberately does not do

- It does not propose principles. That is the next skill
  (`/ux-strategy:design-principles`).
- It does not write the brief. That is the skill after
  (`/ux-strategy:design-brief`).
- It does not specify visual chrome, typography choices, or motion
  curves. Structural contract first; chrome later.
- It does not commit to a refactor sequence. The sub-problems are
  prioritized for *thinking* order; an implementation plan will pick
  its own sequence.

## Open questions for the next pass

These are the questions a reader of the brief should be able to
answer; the framing does not yet answer them.

- How many ambient companion slots are needed? One generalized slot,
  or named slots (chat / presence / command)?
- Is there a single substrate command surface, or do commands stay
  dispatched through chat?
- Where does identity live? In the shell (as a badge) or inside chat
  (as a presence affordance)?
- How does mobile switch between catalogs? Drawer, sheet, fullscreen
  switcher, gesture? The framing requires *a* model; the brief picks
  one.
- Is shadow DOM worth introducing later, and if so, what changes in
  the contract to leave room for it?

## References

- `AGENTS.md` — substrate/superstructure split and layering discipline.
- [2026-05-10-chat-display-contract.md](2026-05-10-chat-display-contract.md) —
  in-flight refactor of chat observation routing; the model for how
  the other catalog-named substrate branches should be retired.
- `src/client/main.ts:2810–2841` — shell grid construction.
- `src/client/main.ts:3369–3403` — `isChatObservation`,
  `isDubspaceObservation`, `isPinboardObservation` (layering violations).
- `src/client/main.ts:4263–4275` — `renderSpaceChatPanel`, the
  ambient-companion mount point.
- `src/client/styles.css:6–105` — current token vocabulary.
- `src/client/styles.css:1948,2082` — current breakpoints.
- `catalogs/chat/ui/chat-space.ts` — the chat-everywhere success.
- `catalogs/taskspace/ui/taskspace-workspace.ts` — the canary.
