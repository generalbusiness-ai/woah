# Tool Space Exit Model

Date: 2026-06-10
Branch: `tool-space-exit-model`
Status: implemented in this branch

## Summary

Tool-space navigation should be destination movement, not a paired
enter/leave lifecycle exposed to the user. Switching browser tabs moves the
actor to the destination space. It must not first ask the current space to
leave itself.

For space-type entities that need an explicit command to get back out, the
command is `out`. `out` is the user-visible exit from a mounted or focused
space. It is not a compatibility alias for `leave`; it is the canonical verb.

The `leave` verb is removed from the tool/browser model. There is no runtime
compatibility wrapper. Catalog major-version migrations record the deletion so
already-installed worlds do not keep stale verbs.

## Problem

The previous bundled tool UIs exposed Enter/Leave controls. This was unclear
in a browser:

- If a user switches to a tab, the destination is already known, so an explicit
  Enter button is redundant.
- If a user presses Leave, the destination is not obvious.
- A Leave button makes the old space look responsible for navigation, even
  though movement is a destination operation in the object model.

Catalog code reinforced the wrong model. Pinboard, outliner, and dubspace
defined `leave`, then implemented `out` by calling `leave`. That made the
named exit command a compatibility wrapper around the verb that needed to go
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

The lesson for Woo is direct: user navigation resolves a destination and moves
there. The old location may observe or clean up through movement hooks, but it
is not a public "leave me" API.

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

State changes caused by movement out of a space live in movement hooks or are
derived from canonical presence:

- `exitfunc(actor)` handles actor cleanup for the source space.
- `enterfunc(actor)` handles actor setup for the destination space.
- Presentation rosters should prefer canonical actor presence where possible.
- Catalog-owned state that authorizes writes, such as dubspace `.operators`,
  must be updated by movement hooks or by explicit entry/exit commands, not by
  browser tab lifecycle.

Item cleanup remains item cleanup. Existing note/card/item `exitfunc` and
`enterfunc` behavior is not part of this change except where it shares the same
verb body as actor cleanup.

## Implementation

- The browser no longer has a tool `leave` lifecycle. Tab changes ensure
  destination presence and do not synthesize `out`.
- Pinboard, outliner, and dubspace no longer render Enter/Leave controls.
- Pinboard, outliner, and dubspace implement `out` directly and remove
  `leave`.
- Dubspace operator cleanup moved to actor `enterfunc`/`exitfunc`.
- Outliner visit-scoped focus and undo cleanup moved to actor
  `enterfunc`/`exitfunc`.
- Each affected catalog is bumped to `1.0.0` and ships a v0-to-v1
  `drop_verb` migration for the removed `leave` verb.

## Non-Goals

- Do not add a compatibility `leave` alias.
- Do not make browser tab switching call `out`.
- Do not change ordinary room topology where `out` is a directional exit name.
- Do not move generic movement semantics into catalog-specific client code.
