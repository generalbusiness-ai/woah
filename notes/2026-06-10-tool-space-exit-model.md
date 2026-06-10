# Tool Space Exit Model

Date: 2026-06-10
Branch: `main`
Status: design note; implementation pending

## Summary

Tool-space navigation should be destination movement, not a paired
enter/leave lifecycle exposed to the user. Switching browser tabs moves the
actor to the destination space. It must not first ask the current space to
leave itself.

For space-type entities that need an explicit command to get back out, the
command is `out`. `out` is the user-visible exit from a mounted or focused
space. It is not a compatibility alias for `leave`; it is the canonical verb.

The `leave` verb should be removed from the tool/browser model. Do not keep a
runtime compatibility wrapper. If catalog release mechanics require a major
version bump, the bump records the deletion; it should not preserve `leave` as
an alias.

## Problem

The current bundled tool UIs expose Enter/Leave controls. This is unclear in a
browser:

- If a user switches to a tab, the destination is already known, so an explicit
  Enter button is redundant.
- If a user presses Leave, the destination is not obvious.
- A Leave button makes the old space look responsible for navigation, even
  though movement is a destination operation in the object model.

Current catalog code reinforces the wrong model. Pinboard, outliner, and
dubspace define `leave`, then implement `out` by calling `leave`. That makes
the named exit command a compatibility wrapper around the verb that should go
away.

## LambdaMOO Reference

LambdaMOO/LambdaCore does not model movement as a public enter/leave pair.
The useful analogue is `@go`, which is a player-class convenience command:

1. Resolve a destination name with `lookup_room`.
2. Call a teleport wrapper.
3. The wrapper calls `thing:moveto(dest)`.
4. Destination policy is enforced by room-side verbs such as `:acceptable`.

In the local LambdaCore copy:

- Frand's player class `@go` is at
  `/Users/hughpyle/play/LambdaCore/LambdaCore-latest.db:255788`.
- `lookup_room` is at
  `/Users/hughpyle/play/LambdaCore/LambdaCore-latest.db:255797`.
- `teleport` delegates to `thing:moveto(dest)` at
  `/Users/hughpyle/play/LambdaCore/LambdaCore-latest.db:255822`.
- `$room:acceptable` is at
  `/Users/hughpyle/play/LambdaCore/LambdaCore-latest.db:225565`.

The lesson for Woo is direct: user navigation should resolve a destination and
move there. The old location may observe or clean up through movement hooks,
but it is not a public "leave me" API.

## Target Model

### Browser Tabs

Browser tab changes are destination moves.

- Selecting a tool tab ensures the actor is in that tool space.
- Selecting another tab moves to that destination.
- The browser does not call the previous tab's `leave`.
- The browser does not call `out` during tab switching. `out` is an explicit
  user command, not a browser lifecycle hook.

### Catalog Verbs

For space-type entities:

- `enter` remains the destination-entry command where catalog command surfaces
  need it.
- `out` is the explicit command to exit the current space-type entity.
- `leave` is removed.

`out` resolves its destination consistently:

1. `this.mount_room`, if set.
2. `actor.home`, if valid/set.
3. `$nowhere`.

Then it moves the actor to that destination and emits the catalog's normal
"left this tool space" observations.

### Movement Hooks

State changes caused by movement out of a space should live in movement hooks
or be derived from canonical presence:

- `exitfunc(actor)` handles actor cleanup for the source space.
- `enterfunc(actor)` handles actor setup for the destination space.
- Presentation rosters should prefer canonical actor presence where possible.
- Catalog-owned state that authorizes writes, such as dubspace `.operators`,
  must be updated by movement hooks or by explicit entry/exit commands, not by
  browser tab lifecycle.

Item cleanup remains item cleanup. Existing note/card/item `exitfunc` and
`enterfunc` behavior is not part of this change except where it shares the same
verb body as actor cleanup.

## Current Code To Change

Client surfaces:

- `src/client/main.ts` has `ToolDefinition.leave` and `leaveRoomToolSpace`.
- `setTab()` calls the current tool definition's `leave` before switching.
- Pinboard, outliner, and dubspace UI components render Enter/Leave or Enter
  controls.
- `docs/reference/tool-ui.md` documents Enter/Leave controls as the default.

Catalog surfaces:

- `catalogs/pinboard/manifest.json` defines `leave` and implements `out` as
  `return this:leave();`.
- `catalogs/outliner/manifest.json` defines `leave` and implements `out` as
  `return this:leave();`.
- `catalogs/dubspace/manifest.json` defines `leave` and implements `out` as
  `return this:leave();`.
- `catalogs/chat/manifest.json` also has a `leave` verb. Ordinary room command
  behavior needs separate review because `$conversational:out` currently means
  "take the room exit named out" through `go("out")`, not "exit a mounted tool
  space."

## Implementation Plan

1. Remove browser Leave lifecycle.
   - Delete `ToolDefinition.leave`.
   - Delete `leaveRoomToolSpace`.
   - Change `setTab()` so it never invokes the current tab's leave handler.
   - Keep or rename the destination entry helper so tab selection still ensures
     presence in the selected tool space.

2. Remove Enter/Leave controls from tool components.
   - Pinboard toolbar should no longer render Enter/Leave.
   - Outliner toolbar should no longer render its presence toggle.
   - Dubspace should no longer render a standalone Enter gate.
   - Tool controls should render based on actual presence/readiness, with the
     host responsible for moving the actor into the selected tab.

3. Make `out` canonical in space-type catalogs.
   - Move each current `leave` implementation into `out`.
   - Delete `leave`.
   - Ensure `out` uses the shared destination order: `mount_room`,
     `actor.home`, `$nowhere`.
   - Preserve existing observations (`pinboard_left`, `outliner_left`,
     `dubspace_left`) from `out`.

4. Move actor cleanup into movement hooks where appropriate.
   - Dubspace: remove the actor from `.operators` when the actor exits the
     dubspace, not because the browser switched tabs.
   - Outliner: clear/prune per-actor `last_undo` and `focus_by_actor` on actor
     exit; keep actor entry reset on actor entry.
   - Pinboard: actor exit currently has no layout cleanup; keep note cleanup in
     note `exitfunc`.

5. Update docs and specs after code shape is fixed.
   - Rewrite `docs/reference/tool-ui.md` to describe destination movement and
     no Enter/Leave controls.
   - Update catalog design docs that list `enter / leave / out`.
   - If the behavior is promoted from design note to normative behavior, align
     the relevant spec section before merge.

## Validation Gates

Targeted tests should cover both behavior and absence of the old surface:

- Catalog behavior:
  - `out` exits pinboard/outliner/dubspace to `mount_room`, then home, then
    `$nowhere`.
  - `out` emits the existing left/activity observations.
  - Dubspace `.operators` is cleared when an actor exits or moves elsewhere.
  - Outliner per-actor undo/focus is cleared on exit and reset on entry.

- Browser behavior:
  - Switching between tool tabs moves to the destination and never sends
    `leave` or `out` for the previous tab.
  - Tool UIs do not render Enter/Leave controls.
  - Generic `space-workspace` views are auto-entered just like named tool tabs.

- Guards/docs:
  - Add or extend a guard so bundled `space-workspace` tool components cannot
    reintroduce `data-*-leave` controls or documentation suggesting Enter/Leave
    as the default tool pattern.

Run the focused files first, then the normal local gate:

```sh
npm run test:files -- tests/catalogs.test.ts tests/outliner.test.ts tests/catalog-ui-components.test.ts
npm test
```

Broader browser or worker lanes should be selected if the implementation
touches v2 tab routing, scoped projection, or worker-side command planning.

## Non-Goals

- Do not add a compatibility `leave` alias.
- Do not make browser tab switching call `out`.
- Do not change ordinary room topology where `out` is a directional exit name.
- Do not move generic movement semantics into catalog-specific client code.
