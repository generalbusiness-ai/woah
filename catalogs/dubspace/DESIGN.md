# Dubspace Demo

A tiny collaborative dub mix space: a shared, persistent control surface for
live sound gestures.

## Classes

| Class | Parent | Description |
|---|---|---|
| `$control` | `$root` | Base class for addressable controls in a sound surface. |
| `$loop_slot` | `$control` | Control for a loaded loop slot (loop id, playing state, gain). |
| `$channel` | `$control` | Control for mixer-channel state (gain). |
| `$filter` | `$control` | Control for filter state (cutoff). |
| `$delay` | `$control` | Control for delay-effect state (send, time, feedback, wet). |
| `$drum_loop` | `$control` | Control for an eight-step percussion loop (transport, tempo, pattern). |
| `$scene` | `$root` | Saved control snapshot for scene recall. |
| `$dubspace` | `$room` | Shared dub-mix space. Composes room sequencing/presence with sound-control verbs. |

## Goal

Show that Woo can host a mutable, multi-user world whose primary interface is
UI and sound, not chat.

Dubspace is also a mounted thing in the chat world. In the demo seed it lives
in the Living Room, can be matched by aliases like "dubspace" and "controls",
and has its own focused UI. Activating that UI moves the actor to the
controls through the normal movement path; the mounted room observes the
entry/exit activity from `enterfunc` / `exitfunc`.

The seeded `the_dubspace` instance also attaches ephemeral
`chat:$transparent`, so the focused Dubspace UI can include the same compact
space-local chat used by Pinboard and Taskspace while forwarding public speech
to its containing room. These utterances are live observations from
`the_dubspace`, separate from the sequenced control log.

## Core Requirement

The demo runs inside one minimal `$space`. The `$space` does only one thing:
accept calls/messages and assign them monotonically increasing sequence
numbers.

All coordinated mutations in the demo are caused by sequenced messages. Current
mix state is the materialized result of applying those messages, plus snapshots
for fast reload. No world-level clock is required for ordering.

## UI

The catalog declares `dubspace.workspace` as `<woo-dubspace-workspace>` in
`ui/dubspace-workspace.ts`. The component owns the workstation markup for loop
slots, filter, delay, percussion, room presence, and the embedded mini-chat
mount point. The SPA host supplies scoped projection data, audio services, and
transport callbacks; the component communicates back through `woo-dubspace-*`
custom events rather than private host DOM bindings.

The catalog-owned read-only `controls_view()` verb returns the persisted values
for the fixed demo controls and their semantic role map as one bounded result.
Clients that have authoritative installed-catalog metadata proving the view is
available use it directly. The explicit role map is required because the net
room projection does not enumerate the catalog's internal control objects.
Committed control observations then patch that same canonical projection and
repaint the active workspace.

The frame repeats that fixed role map and its demo seed defaults as declarative
UI state and declares the catalog module's `controls` hydration contract. The
generic shell supplies presence, call, cell-read, and projection capabilities;
the catalog module selects `controls_view` versus the aged-cell fallback,
validates completeness, and returns generic projection patches. No shell branch
names Dubspace or rebuilds the role map. A net world may
outlive the bundle that installed it, so clients connected to a pre-1.0.2
Dubspace cannot call `controls_view()`. When the net projection does not prove
the installed version, the client immediately uses the frame map to read the
same 27 public property cells; it must not wait behind speculative verb repair.
A proven view that nevertheless returns the named missing-verb or repair-budget
failure uses the same fallback. This bounded compatibility read starts from the
declared defaults because sparse net storage legitimately omits unchanged
values, then overlays every materialized cell. The reads are paced beneath the
shared client-operation rate and retry only the gateway's named, recoverable
`E_RATE`, so shell hydration cannot exhaust the burst and discard the whole
view. The compatibility reader and shared control vocabulary live with the
catalog UI under `catalogs/dubspace/ui/`; drift tests require every declared
default property and drum voice to remain represented by `controls_view()`.
The reader neither enumerates objects nor guesses control roles or values.

## Surface

- One shared space.
- Two connected players.
- Four loop slots.
- One filter.
- One delay.
- One eight-step percussion loop.
- One saved scene.
- A mounted-room relationship to the Living Room.
- Presence-derived control authority for actors currently at the controls.

Dubspace follows the workspace roster model. `room_roster()` adapts the
substrate's compact owner-authoritative projection into
`{id, name, presence, idle_seconds?}` rows without actor-cluster reads;
`live_audience(observation?)` is the separate delivery contract and delegates
to the substrate observation routing rules. Control authority is not stored in
a catalog-maintained operator list; verbs call `_require_present()`, which
authorizes actors whose current location is the dubspace, plus wizards.

## Persistent State

- Loaded loop per slot.
- Playing/stopped state per slot.
- Channel gain.
- Filter cutoff.
- Delay send, time, feedback, and wet level.
- Percussion transport (`playing`, `started_at`), tempo, and eight-step pattern.
- Scene name and saved control values.

## Live Slider Previews

Slider motion has two layers — two v2 routes for the same control surface:

- **Preview** (v2 direct intent): while a player drags a slider, the client submits a `preview_control(target, name, value)` direct intent with `live`. The verb body emits a `gesture_progress` observation; per [events.md §12.6](../../spec/semantics/events.md#126-observation-durability-follows-invocation-route), the observation is live-only because the call is direct. Not sequenced, not logged, not replayed.
- **Commit** (v2 sequenced intent): when the drag ends, the client submits `set_control(target, name, value)` through the v2 commit-scope path. The value becomes materialized persistent state and is replayable.

The preview layer exists so continuous gestures feel live without filling the `$space` log with every pointer sample. It is the same control surface called via a different route, not a second source of truth.

Every tab observing the dubspace applies these projected control changes to its
local audio engine. That is intentional shared-mix behavior: a non-originating
present actor hears loop, transport, scene, and control changes when the room state
changes.

All Dubspace verbs are catalog-authored Woo source. `:set_control` uses dynamic
property access (`target.(name) = value`); scenes snapshot the demo's seeded
controls explicitly from the catalog rather than through core-native handlers.
Committed control verbs set `skip_presence_check` because they run on the
dubspace object rather than on a carried object. Their bodies explicitly
authorize by `_require_present()`, then check that the target control is
contained by the dubspace and that the property name is in the catalog's
explicit allow-list.
Any Dubspace verb with `skip_presence_check: true` MUST gate every write in
the verb body. For dynamic control writes that means `target in contents(this)`
and `name in allowed`; adding a new control property requires updating that
allow-list and the catalog authorization tests.

## Command Surface

The dubspace inherits the shared `$conversational` command parser. Control-room
shortcuts are declared as ordinary command metadata on the relevant verbs
rather than as branches in a dubspace-specific `:command_plan`.

`filter 500` resolves to the filter control's `:on_say_to("500")` command
shape, so the same object verb handles plain control input and directed
backtick input such as `` `filter 500 ``. `bpm 144` resolves to the sequenced
`the_dubspace:set_tempo(144)` path so tempo changes remain replayable. `out`
routes through the inherited room/exit command path. Explicit speech remains
available through `say ...`, `"..."`, `/tell`, and the other chat speech forms;
bare unmatched text is a private actor-owned `huh`, not implicit room speech.

BPM command shortcuts accept only integer values in the UI tempo range, 60
through 200; the lower-level `:set_tempo` verb remains tolerant and clamps
direct callers.

## Observation Schemas

Each observation the dubspace emits has a defined payload shape. UI and agents consume these as the canonical contract.

| Observation | Payload | When emitted |
|---|---|---|
| `dubspace_entered` | `{source: obj, actor: obj, space: obj, text: str}` | Actor moves into the dubspace and is present at the controls. |
| `dubspace_left` | `{source: obj, actor: obj, space: obj, text: str}` | Actor moves out of the dubspace and is no longer present at the controls. |
| `dubspace_activity` | `{actor: obj, space: obj, text: str}` | Room-visible mounted-object activity, sourced from the containing room. |
| `loop_started` | `{slot: obj, loop_id: str}` | `:start_loop` applied. |
| `loop_stopped` | `{slot: obj}` | `:stop_loop` applied. |
| `control_changed` | `{target: obj, name: str, value: any}` | `:set_control` applied. |
| `scene_saved` | `{scene: obj, name: str}` | `:save_scene` applied. |
| `scene_recalled` | `{scene: obj, controls: map}` | `:recall_scene` applied. `controls` is the full scene control snapshot, keyed by control object; it is intentionally not a delta. |
| `drum_step_changed` | `{target: obj, voice: str, step: int, enabled: bool, pattern: map}` | `:set_drum_step` applied. `pattern` is the resulting full drum pattern. |
| `tempo_changed` | `{target: obj, bpm: int}` | `:set_tempo` applied. |
| `transport_started` | `{target: obj, started_at: int, bpm: int}` | `:start_transport` applied. |
| `transport_stopped` | `{target: obj}` | `:stop_transport` applied. |
| `gesture_progress` | `{actor: obj, target: obj, name: str, value: any}` | Direct call: in-flight slider drag preview. Live-only. |
| `cursor` | `{actor: obj, x: float, y: float}` | Direct call: pointer position. Live-only. |

All observations include `type` (the table key) and `source` (the dubspace itself, unless noted otherwise). `dubspace_activity` is sourced from the mounted room so actors present in the room see the step up/away messages. Observations from sequenced v2 intents (`:set_control`, `:start_loop`, etc.) become part of the resulting applied frame and are replayable. Observations from direct v2 intents (`:preview_control`, `:cursor`) are live-only — see [events.md §12.6](../../spec/semantics/events.md#126-observation-durability-follows-invocation-route). Movement observations are produced by the substrate move chain through `enterfunc` / `exitfunc`.

## Live Events

- Actor entered or left the controls.
- Loop started or stopped.
- Control changed.
- Percussion step, tempo, and transport changed.
- Gesture began, moved, ended.
- Scene saved or recalled.

Gesture previews go through v2 direct intents (live-only); actor entry/exit hints come from the movement hooks; gesture commits that affect the shared mix go through v2 sequenced intents. The latest committed control values are persistent materialized state.

## Minimal Interactions

- Start or stop a loop.
- Drag a knob or fader and see/hear the shared change.
- Toggle an 8-step percussion pattern and start/stop the shared transport.
- Save the current controls as one scene.
- Reload and recover the persisted mix state.

## Not In This Demo

- Chat as the primary interface.
- Inventory or spatial navigation inside the dubspace UI.
- User-authored code.
- Sample upload.
- Audio recording.
- Federation.
- Permissions beyond "connected players can perform."
