# Flattening `command_plan`: LambdaMOO-shaped command dispatch

Date: 2026-05-05

Status: Phase 1 through the first browser-facing command execution slice are
partly implemented. Catalog installs preserve `arg_spec.command`, `$match`
exposes native-backed `match_command_verb` and `plan_command`,
`$conversational:command_plan` is a thin wrapper over the shared planner, and
dubspace no longer ships its own `command_plan`. The WebSocket wire now accepts
`op:"command"` so the server plans and executes direct/sequenced text commands;
the browser no longer executes plan descriptors for chat input. The huh-hook
chain and final removal of compatibility planner helpers remain open.

## Problem

`$chatroom:command_plan` has become a dense command compiler.
`$dubspace:command_plan` is a smaller copy with catalog-specific branches and
drifted speech syntax. The browser then interprets the returned descriptor and
re-decides how to execute it.

That is not the LambdaMOO shape. In LambdaMOO, the command parser resolves a
verb by `(verb name, dobj pattern, prep pattern, iobj pattern)` and invokes a
small verb on the matched object, room, or player. Rooms and objects do not
carry central parsers full of domain branches. They carry ordinary verbs.

The current woo shape is heavy because `command_plan` is doing four jobs:

- parse text;
- resolve target object and verb;
- choose direct vs sequenced transport;
- encode catalog-specific UI/control shortcuts.

Those jobs should not live in per-catalog room code.

## LambdaMOO observations

Checked against live LambdaMOO over MCP.

### Verbs are short leaves

Representative examples:

- `$room:say` has arg spec `any any any` and is about six lines: echo to
  player, announce to room.
- `$room:e east w west ...` has arg spec `none none none` and just matches an
  exit and invokes it.
- `$thing:g*et t*ake` has arg spec `this none none`. `take lamp` dispatches to
  the lamp's own verb.
- `$thing:d*rop th*row` has arg spec `this none none`. `drop lamp` dispatches
  to the carried object.
- `$thing:gi*ve ha*nd` has arg spec `this (at/to) any`. `give lamp to Pat`
  dispatches to the lamp; the verb resolves the recipient.
- `$player:wh*isper` has arg spec `any (at/to) this`. The recipient player
  owns the whisper behavior.
- `$room:l*ook` is a room verb that uses parser values and delegates to
  `thing:look_self()`.

The common pattern is: the parser selects the receiver and verb; the receiver
owns behavior.

### Huh is an extension chain

LambdaMOO's `$command_utils:do_huh` does not contain every command fallback.
It runs a small ordered chain:

1. `player:my_huh(verb, args)` — player/feature-specific parsing.
2. `caller:here_huh(verb, args)` — room-specific parsing.
3. `player:last_huh(verb, args)` — second player hook.
4. Generic ambiguity / "I don't understand that" reporting.

`$room:here_huh` is tiny: it catches bare exit names that have no matching
direction verb and invokes the exit. Feature dispatch is handled by
`$player:my_huh`, which asks feature objects whether they have a matching verb.

This is the hook shape woo should copy. Custom command behavior belongs in
small hooks or object verbs, not in one global `command_plan` branch list.

### Command utilities own errors

LambdaMOO centralizes match-failure wording in `$command_utils`, for example
`object_match_failed(result, string)` and `player_match_failed(...)`. Individual
verbs call those helpers instead of duplicating ambiguity/missing-object text.

Woo's `huh_plan` and chat error rendering are a partial equivalent, but the
messages are still often embedded in planner branches. That is another reason
the planner grows.

## What woo is missing

### 1. Command-pattern verb dispatch

`$match:match_verb(name, target)` currently mirrors runtime lookup by name and
aliases. It does not choose among command argument shapes.

LambdaMOO dispatch depends on the verb's command pattern:

```text
verb-name + dobj kind + prep kind + iobj kind
```

Woo needs an equivalent for chat-shaped text input. It does not need parser
globals, but it does need command metadata.

Proposed metadata extension:

```json
{
  "name": "gi*ve ha*nd",
  "arg_spec": {
    "command": {
      "dobj": "this",
      "prep": ["to", "at"],
      "iobj": "any",
      "args_from": ["iobjstr"]
    }
  }
}
```

The runtime function should answer:

```text
match_command_verb(cmd, target) -> {target, verb, args}
```

The returned `args` are ordinary woo verb args. We do not need parser globals
inside every verb.

#### Command metadata details

`command` metadata is per verb definition, not per alias. LambdaMOO's
`gi*ve ha*nd` is one verb with multiple name globs and one pattern; woo should
keep that same rule. If an alias needs a different pattern, it is not an alias;
it is a separate verb definition.

Valid `dobj` / `iobj` pattern values for Phase 1:

| Value | Meaning |
|---|---|
| `none` | The parsed slot must be empty. |
| `this` | The parsed slot must resolve to the command receiver. |
| `any` | The parsed slot may be empty or non-empty. |
| `object` | The parsed slot must resolve to any object other than `$failed_match` / `$ambiguous_match`. |
| `player` | The parsed slot must resolve to a `$player` descendant. |
| `string` | The parsed slot text must be present; object resolution may fail. |

Valid `prep` pattern values for Phase 1:

| Value | Meaning |
|---|---|
| `none` | No preposition. |
| `any` | Any preposition or no preposition. |
| string | Exact normalized preposition, e.g. `"to"`, `"at"`, `"in front of"`. |
| list | Any one of the exact normalized prepositions in the list. |

Valid `args_from` tokens for Phase 1:

| Token | Value |
|---|---|
| `text` | Original input text. |
| `verb` | Parsed verb text. |
| `argstr` | Parsed argument string after the verb. |
| `prep` | Normalized preposition string, or `""`. |
| `dobj` | Resolved direct object, or the match sentinel. |
| `dobjstr` | Direct-object source text. |
| `dobj_prefix` | Longest matched object prefix in `argstr`, if any. |
| `dobj_prefix_rest` | Text after `dobj_prefix`. |
| `iobj` | Resolved indirect object, or the match sentinel. |
| `iobjstr` | Indirect-object source text. |
| `cmd` | The whole parsed command map. Escape hatch; use sparingly. |

Do not add unlisted tokens casually. Expanding this vocabulary is a command
metadata change and should land with tests.

Resolution uses the existing verb-lookup primitive. That means normal ancestry
and feature lookup are preserved within each candidate target. The command
matcher chooses target priority (`dobj`, `iobj`, `space`, then `actor`); verb
lookup inside a target stays exactly the runtime lookup rule.

### 2. A command execution entrypoint

General `dispatch(target, verb, args)` is a direct call primitive today.
Changing it to sometimes enqueue sequenced work would be surprising for
ordinary woocode.

Instead, add a command-specific entrypoint:

```text
execute_command(space, text) -> result or applied-frame result
```

or expose it as the implementation of:

```woo
verb $space:command(text) rxd { ... }
```

This entrypoint:

1. applies shared speech prefix lowering;
2. calls `$match:parse_command(text, actor, space)`;
3. finds the best command-pattern verb on `dobj`, `iobj`, `space`, then
   `actor`;
4. chooses direct vs sequenced from the resolved verb's `direct_callable`;
5. executes it;
6. falls through to the huh chain when no command matches.

The important part is that routing is decided after verb resolution, not by
catalog-specific planner branches and not by the browser.

If the resolved verb is sequenced and the target is not a `$space`, the command
is sequenced in the actor session's current location. This is the equivalent of
LambdaMOO dispatching `take lamp` to the lamp while the command still belongs
to the room where the actor typed it. If the actor has no current location,
the command fails with a clear `E_NOLOCATION`.

Speech-prefixed input intentionally bypasses object resolution. A line that
starts with `"`, `:`, `]`, `|`, `<`, `` ` ``, `/me`, `/tell`, or `[style]`
dispatches to the lowered speech verb on the active command surface. Those
prefixes are authoritative syntax, not object names.

### 3. A huh hook chain

Woo should add the LambdaMOO-shaped chain on `$actor` rather than only on
`$player`. Human players inherit it, and future non-player actors can customize
text interpretation without a second hook family.

```text
actor:my_huh(cmd)
space:here_huh(cmd)
actor:last_huh(cmd)
$command_utils:explain_huh(cmd)
```

For v1, these can be ordinary optional verbs:

- missing hook means "return false";
- returning true means "handled";
- generic failure remains centralized.

Dubspace-specific oddities should prefer object verbs. If a real syntax escape
remains, it belongs in `the_dubspace:here_huh(cmd)` or `$dubspace:command`
with `pass(cmd)`, not in a pasted copy of the whole command planner.

## Consequences for current catalogs

### Chat

The chat catalog should stop treating `command_plan` as a compiler. Its job
should become:

- provide speech verbs (`say`, `emote`, `pose`, `quote`, `self`, `say_to`);
- provide room/object verbs (`look`, `take`, `drop`, `give`, `inventory`,
  `home`, etc.);
- provide command metadata for those verbs;
- provide small `huh` helpers.

`$portable:give` is already LambdaMOO-shaped: the verb lives on the carried
object. The planner branch that recognizes `give X to Y` is a symptom that
command-pattern dispatch is missing.

### Dubspace

Dubspace should not need a `command_plan`.

Desired shape:

- `filter_1` has alias `filter`.
- `filter_1:on_say_to(text)` or a command verb handles `filter 500`.
- `$dubspace:bpm(value)` / `$dubspace:tempo(value)` is a normal verb or aliases
  to `:set_tempo`.
- `$dubspace:out()` is a normal verb.
- Shared speech syntax comes from the inherited command entrypoint.

Then `[style] hello`, `/tell`, `]pose`, `|quote`, and all future shared syntax
work in dubspace automatically. No re-paste.

### Client

The browser should not receive `{route, space, target, verb, args}` and then
decide how to execute it. It should send text to the active command surface:

```text
space:command(text)
```

The server resolves and executes. The client renders observations and applies
normal result reducers. The client may still have small post-result hooks for
UI navigation, for example "entering dubspace selects the Dubspace tab", but
those hooks are UI reactions, not command routing.

## Proposed target model

### `$match`

Add:

```woo
$match:match_command_verb(cmd, target)
```

It returns either:

```json
{ "target": obj, "verb": "give", "args": ["guest_2"], "direct_callable": true }
```

or `$failed_match`.

It uses:

- existing object matching from `parse_command`;
- existing verb lookup including features;
- new command-pattern metadata on verb definitions.

### `$command_utils`

Add or formalize:

- `:object_match_failed(result, string)`;
- `:player_match_failed(result, string)`;
- `:lower_speech_prefix(text, cmd)`;
- `:explain_huh(cmd)`;
- `:do_huh(cmd)`.

These are catalog/woocode utilities, not runtime primitives.

### `$space:command(text)`

One inherited command surface for all chat-shaped spaces.

Pseudo-shape:

```woo
verb :command(text) rxd {
  let cmd = $match:parse_command(text, actor, this);
  let lowered = $command_utils:lower_speech_prefix(text, cmd);
  if (lowered != null) {
    return execute_resolved_command(lowered);
  }

  let resolved = this:resolve_command(cmd);
  if (resolved != null) {
    return execute_resolved_command(resolved);
  }

  return $command_utils:do_huh(cmd);
}
```

`execute_resolved_command` is the only substrate-aware piece: it consults the
resolved verb's `direct_callable` and chooses direct vs sequenced execution.

Universals live in `$command_utils`, not in each `$space` subclass. A subclass
that needs extra syntax should add a small hook or ordinary object verb. It
should not override the shared prefix lowerer unless it is intentionally
changing the world's command language.

## Build plan

### Phase 1: command matching without behavior change

- Extend verb metadata with optional command pattern fields.
- Enumerate and validate `dobj` / `prep` / `iobj` / `args_from` vocabulary.
- Implement `$match:match_command_verb(cmd, target)`.
- Add tests that mirror LambdaMOO examples:
  - `take lamp` resolves to the lamp's take verb.
  - `drop lamp` resolves to the lamp's drop verb.
  - `give lamp to guest_2` resolves to the lamp's give verb with recipient
    text as the argument.
  - `` `guest_2 hi`` / `tell guest_2 hi` resolves through the existing
    `say_to` / `tell` directed-speech path; add `$player:whisper` later if we
    want the exact LambdaMOO spelling.
  - `look lamp` resolves through room/object look behavior.
- Keep existing `command_plan` intact during this phase.

### Phase 2: inherited command entrypoint

- Implement `$space:command(text)` or a substrate-backed equivalent.
- It should use the new command matcher but still be callable directly by old
  clients.
- After this phase, every `$space` descendant has a working `:command(text)`
  whether or not its `command_plan` has been migrated.
- Add the huh hook chain with no-op defaults.
- Add shared speech-prefix lowering once in `$command_utils`.
- Add tests for the full shared speech family in chatroom and dubspace.
- Add at least one test that exercises `my_huh` or `here_huh`, so the hook
  chain does not ship untested.

### Phase 3: route by resolved verb metadata

- Add a command execution helper that receives `{target, verb, args}` and
  chooses direct vs sequenced from the resolved verb metadata.
- Do not change the semantics of general-purpose `dispatch()` until there is a
  separate spec decision.
- Tests:
  - direct command returns a direct result;
  - sequenced command creates an applied frame;
  - `$error` observations from a sequenced command route still surface to the
    issuing chat panel by the applied-frame error path introduced for the
    drop-towel fix;
  - route choice is not visible to catalog code.

### Phase 4: migrate chat catalog

- Annotate existing chat verbs with command patterns.
- Move branch-specific planner logic into object/room/player verbs.
- Make `command_plan` a compatibility wrapper around the new resolver, or leave
  it as a thin adapter for one release.
- Keep `huh`, object-match failure wording, and player-match failure wording in
  shared command utilities.

### Phase 5: migrate dubspace

- Delete duplicated speech-prefix logic.
- Express `filter 500` through object alias + object verb.
- Express `bpm 144` / `tempo 144` as ordinary `$dubspace` or `drum_1` command
  verbs.
- Keep any truly unusual syntax in a tiny override that calls `pass()`.
- Add regression tests proving chatroom and dubspace accept the same shared
  speech syntax.

### Phase 6: client cleanup

- Replace `command_plan` + `executeChatPlan` with wire `op:"command"` or a
  future `:command(text)` equivalent that can return direct or applied frames.
- Remove route/space/target/verb/args plan interpretation from the browser.
- Keep UI-only post-result reducers for tab changes and overlay focus.
- Once no catalog/client reads the descriptor, remove the plan descriptor
  format.

The next major move after the current compatibility slice is the huh hook chain
plus retiring compatibility planner helpers once old surfaces no longer call
`command_plan`.

## Conditions of satisfaction

- No space catalog needs to paste shared speech parsing.
- Adding a new object command means adding a verb/alias/command pattern to the
  object, not editing a room parser.
- `filter 500` and `bpm 144` work in dubspace without `$dubspace:command_plan`
  knowing literal object ids like `filter_1`.
- Chatroom and dubspace share the same speech syntax automatically.
- The browser no longer decides direct vs sequenced routing for text commands.
- Huh/error messages are centralized in command utilities, with player/room
  hooks for special cases.
- At least one demo path exercises `my_huh` or `here_huh`.

## What not to do

- Do not add more branches to `$dubspace:command_plan`.
- Do not make every catalog define its own text parser.
- Do not use the client as the command compiler.
- Do not treat `:command(text)` as a replacement for structured verb calls or
  per-verb MCP exposure. It is additive: natural-language input uses
  `:command`, agents and tools may still call specific verbs directly.
- Do not make generic `dispatch()` secretly sequence calls until that is
  separately specified; use a command-specific execution helper first.
