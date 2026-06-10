# Tool Space Movement Model

Date: 2026-06-10
Branch: `main`
Status: design note; implementation pending
Companion: [`2026-06-10-tool-space-exit-model.md`](2026-06-10-tool-space-exit-model.md)

## Summary

Tool spaces (pinboard, outliner, dubspace) run a second, ad-hoc movement
model that exists nowhere in the room graph. Rooms move by traversing exit
objects through `moveto`; tool spaces are entered by calling a public
`:enter` verb on the space and left by a public `:out`/`:leave` verb that
recomputes a destination inline. This note widens the exit-model note: the
fix is not just "delete `leave`" but "tool spaces join the one movement
model that already exists."

Two coupled misalignments:

1. **`:enter` is the same anti-pattern as `:leave`.** Both are public,
   space-side lifecycle verbs that duplicate what `moveto` + the room hooks
   (`acceptable`/`enterfunc`/`exitfunc`) already do. The exit-model note
   removes `leave` but keeps `enter` and the hand-rolled exit-destination
   logic, which leaves the divergent model half-standing.

2. **Per-actor state lives on the space and is maintained by the
   enter/leave lifecycle.** dubspace `operators`, outliner `focus_by_actor`
   and `last_undo` are written when the actor calls `:enter`/`:out`. Any
   move that does not pass through those exact verbs (a substrate `moveto`,
   a recycle, a future exit traversal, a browser tab switch) desyncs them.
   `operators` in particular is a hand-maintained copy of presence that
   gates authority — a class of bug we have already paid for in presence
   projections.

## Problem

### A second movement model

Tool spaces are not connected to the room exit graph. They carry a
`mount_room` back-pointer and are reached by calling the space's own
`:enter`, whose body is just `moveto(actor, this)` plus an observation:

- `chat` `$space:enter` — `catalogs/chat/manifest.json:827`
- `pinboard` `$pinboard:enter` — `catalogs/pinboard/manifest.json:214`
  (`moveto(actor, this)` + `pinboard_entered`)
- `dubspace` `$dubspace:enter` — `catalogs/dubspace/manifest.json:336`
- `outliner` `$outliner:enter` — `catalogs/outliner/manifest.json:166`

Leaving is the mirror image. `:out` (and dubspace's still-present
`:leave`) recompute the destination by hand —
`this.mount_room` → `actor.home` → `$nowhere` — then `moveto`:

- `dubspace` `:out` / `:leave` — `catalogs/dubspace/manifest.json:361,357`
- `pinboard` `:out`, `outliner` `:out` — same inline chain.

That `mount_room → home → nowhere` chain is `exit.dest` reimplemented, once
per catalog, in DSL, with no shared definition. There are no exit objects
linking a room to its mounted tool spaces (confirmed: none of the tool
catalogs define an `$exit` child). So the substrate has one faithful
LambdaMOO movement path — `go`/directional verb → exit `:invoke`/`:move`
→ `moveto`, with `leave_msg`/`arrive_msg`/`dest` on the exit object
(`catalogs/chat/manifest.json:495–519`) — and the tool spaces bypass it
entirely.

### Per-actor state on the space

dubspace `operators` (`catalogs/dubspace/manifest.json:286`) is appended in
`:enter` and filtered out in `:leave`, and every control verb authorizes on
`actor in this.operators` (`set_control` `:387`, `start_loop` `:424`,
`set_drum_step` `:450`, `set_tempo` `:467`, `start_transport` `:477`,
`save_scene` `:499`, `recall_scene` `:511`). It is therefore a hand-kept
duplicate of "who is present in this dubspace" that also gates writes. If
an actor reaches or leaves the dubspace by any path other than these two
verbs, `operators` and presence disagree and authority is wrong in one
direction or the other.

outliner `focus_by_actor` and `last_undo`
(`catalogs/outliner/manifest.json:117–118`) are per-actor maps on the
space, reset/cleared by the same lifecycle.

## LambdaMOO Reference

- Movement is actor-side `:moveto`, with destination policy enforced by
  room-side `:acceptable`, and arrival/departure side effects in
  `:enterfunc`/`:exitfunc`. There is no public `room:enter` or
  `room:leave` that a player calls to relocate themselves.
- The *destination* of leaving a place is an **exit object's `.dest`**,
  reached through `go`/`@go`/teleport, all of which resolve a destination
  and call `:moveto`. Destinations are data on exits, not a chain
  recomputed in each location's verbs.
- Per-player state lives on the **player**; per-room presence/rosters are
  **derived** from `.contents` and the entry/exit hooks, not stored as a
  separately authored list that a command verb must remember to update.

The lesson, identical to the exit-model note but applied to both halves:
participation in a place is movement plus room-side hooks. The tool surface
does not expose an enter/leave API, and the place does not keep a private
register of who is in it.

## Target Model

### One movement path

- Tool spaces are spaces reached by the same destination movement as any
  room. Delete the class-owned public `:enter`, `:out`, and `:leave` verbs
  from the tool-space classes. Keep inherited room `out` as the exit-backed
  way back.
- Entry side effects move to `enterfunc(actor)`; exit side effects move to
  `exitfunc(actor)`; entry policy (if any) moves to `acceptable(actor)`.
  These already exist on the tool-space classes and already fire from the
  substrate `moveto` chain.
- The "way back out" is modelled as an exit whose `.dest` is the mount
  room, so the user-facing `out` command is `go("out")` — the same exit
  traversal every room uses — not a space-side verb that recomputes a
  destination. `mount_room` becomes the seed for that return exit's
  `.dest` (or is consumed by one shared helper), not an inline chain
  duplicated per catalog.
- Browser tab selection ensures presence by moving the actor to the
  destination space (see the exit-model note); it never calls a
  space-side lifecycle verb.

This supersedes two decisions in
[`2026-06-10-tool-space-exit-model.md`](2026-06-10-tool-space-exit-model.md):
that note keeps `enter` as a destination-entry verb and keeps the
`mount_room → home → nowhere` order inside `out`. Under this note both are
folded into the exit/movement path. The notes should land together; where
they disagree, this one is the later decision.

### Per-actor state follows movement, never the lifecycle verb

- **dubspace `operators`: delete the list; derive operator authority from
  presence.** "You may operate this dubspace" is "you are present in this
  dubspace." Replace `actor in this.operators` with a presence check
  (`location(actor) == this`, or the canonical presence/audience helper)
  in `set_control`, `start_loop`, `stop_loop`, `set_drum_step`,
  `set_tempo`, `start_transport`, `stop_transport`, `save_scene`,
  `recall_scene`. This removes the desync class entirely — there is no
  second copy of presence to drift. (If a future requirement needs a
  subset of present actors to hold control — a "take the desk" handoff —
  that is an explicit grant relation, still keyed off presence, not a list
  appended by `:enter`.)
- **outliner `focus_by_actor` / `last_undo`: maintain in movement hooks.**
  Initialise the actor's entry in `enterfunc(actor)`; prune it in
  `exitfunc(actor)`. No public verb writes them on the way in or out.
- General rule: per-actor state attached to a space is set up in
  `enterfunc` and torn down in `exitfunc`, or derived from presence at read
  time. It is never written by an enter/leave/out command or a browser tab
  handler.

## Current Code To Change

Catalog surfaces:

- `catalogs/chat/manifest.json` — generic `$space:enter` / `$space:leave`
  remain compatibility behavior for conversational rooms; tool-space classes
  suppress inherited `enter` / `leave` from the MCP tool surface.
- `catalogs/pinboard/manifest.json` — remove `:enter` (`:214`) and `:out`;
  move entry/exit side effects into `enterfunc`/`exitfunc`.
- `catalogs/dubspace/manifest.json` — remove `:enter` (`:336`), `:out`,
  and `:leave` (`:357`); delete `operators` (`:286`) and reauthorize all
  nine control verbs on presence.
- `catalogs/outliner/manifest.json` — remove `:enter` (`:166`), `:out`,
  `:leave`; move `focus_by_actor`/`last_undo` setup/teardown into
  `enterfunc`/`exitfunc`.
- Reinterpret `mount_room` (`pinboard:145`, `dubspace:292`, and the
  `demoworld` seeds at `:692,732,760`) as a return-exit destination rather
  than an inline `out` target.

Substrate/helper:

- One shared destination-movement entry (the existing `go`/exit path)
  should serve tool spaces; do not add a parallel helper.

## Implementation Plan

1. Confirm the substrate `moveto` chain fires `acceptable`/`enterfunc`/
   `exitfunc` for tool-space classes today (it does, per
   `world.ts:movetoChecked`) so removing the public verbs loses no side
   effect that isn't relocatable to a hook.
2. Move each tool space's `:enter` body into `enterfunc(actor)` and each
   `:out`/`:leave` body into `exitfunc(actor)`, keeping the structured
   observations (see the observation-model note for the text question).
3. Model the return path as an exit with `.dest` seeded from `mount_room`;
   route the user-facing `out` through `go`.
4. Suppress inherited `enter` / `leave` from tool discovery while leaving
   inherited room `out` visible.
5. dubspace: delete `operators`; reauthorize control verbs on presence; add
   a test that a present non-operator can operate and a departed operator
   cannot — without any `:enter`/`:leave` call in between (move via
   substrate `moveto`).
6. outliner: relocate `focus_by_actor`/`last_undo` lifecycle into the
   hooks; test that focus/undo survive entry and are pruned on exit through
   a plain move.
7. Update catalog `DESIGN.md` and any spec section that documents tool-space
   entry as a verb call.

## Validation Gates

- Moving an actor into/out of a tool space by substrate `moveto` (not by a
  named verb) fires the same entry/exit side effects and presence as the
  old `:enter`/`:out` calls.
- dubspace control authority tracks presence exactly: present ⇒ allowed,
  absent ⇒ `E_PERM`, with no `operators` property in the world image.
- outliner per-actor focus/undo is established on entry and gone on exit,
  regardless of the move path.
- No tool-space class defines its own public `enter`, `leave`, or `out`
  lifecycle verb. MCP tool discovery suppresses inherited `enter`/`leave`
  for these spaces and keeps inherited `out`.
- Add/extend a guard so a bundled `$space` subclass cannot reintroduce a
  public `enter`/`leave`/`out` movement verb or an `operators`-style
  presence-duplicate list.

```sh
npm run test:files -- tests/catalogs.test.ts tests/outliner.test.ts tests/catalog-ui-components.test.ts
npm run guard:tool-workspace-ui
npm test
```

## Non-Goals

- Do not invent a new movement primitive; reuse the exit/`moveto` path.
- Do not keep `mount_room` as an inline destination chain in `out`.
- Do not preserve `operators` as a compatibility list shadowing presence.
- Do not change conversational `$room` exit topology, where `out` is an
  ordinary directional exit name.
