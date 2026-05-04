# Idle/awake presence — design

## Goal

Surface LambdaMOO-style "is awake and looks alert" / "is sleeping" /
"has been staring off into space for 5 minutes" status in `:look <player>`.
First-light-shaped: minimum primitives + a single `$player:look_self`
override on top of the substrate seed.

## LambdaMOO baseline

`#6:look_self` (`$player:look_self`) does exactly three things after the
generic root description prints:

```
if (!(this in connected_players()))
    "She is sleeping."
elseif (idle_seconds(this) < 60)
    "She is awake and looks alert."
else
    "She is awake, but has been staring off into space for <duration>."
endif
```

The two builtins are `connected_players()` (returns object list of
currently connected actors) and `idle_seconds(player)` (seconds since
that player's last input).

The semantic target for woo is the same; the mapping is below.

## Substrate primitives (woocode builtins)

Two new builtins, both pure reads against `world.sessions`:

- `is_connected(actor)` → bool. True iff any session for `actor` either
  has `attachedSockets.size > 0` **or** has had non-WS input within the
  live window (5 minutes). Without the second clause, REST/MCP-only
  callers that touch `lastInputAt` would still read as sleeping despite
  actively driving the world.
- `idle_seconds(actor)` → number (seconds since most recent input from
  any of `actor`'s sessions, regardless of socket attachment). Returns
  `null` only when `actor` has no session at all.

For multi-session actors (a real possibility once accounts land —
agent + browser + tablet), both functions roll across all sessions:

- `is_connected` is OR across sessions.
- `idle_seconds` uses the most recent `lastInputAt` (i.e. `min(idle)`
  across sessions). Aligns with "any device is currently active."

These don't go through `getPropChecked`, so they're not gated on
property perms. Idle/connected status is already public (LambdaMOO
exposes it the same way).

## Tracking `lastInputAt`

Add an in-memory field to `Session`:

```ts
type Session = {
  ...
  lastInputAt: number;   // ms since epoch; bumped on real input only
};
```

Not persisted. On DO restart / rehydrate, treat connected sessions as
just-active: set `lastInputAt = Date.now()` rather than restoring an
old value. (Otherwise a freshly-rehydrated DO shows huge idle for
everyone for no good reason.)

Bump points:

- **Session creation** (`createSessionForActor`, `ensureSessionForActor`):
  `lastInputAt = now`.
- **Socket attach** (`attachSocket` → reconnect): `lastInputAt = now`.
- **Authenticated input frames** at the WS handler — when a frame
  with `op: "call" | "direct" | "input"` is dispatched. *Not* on
  `op: "ping"`.
- **REST authenticated calls** at `/api/objects/<id>/calls/<verb>`
  and `/api/objects/<id>/direct/<verb>` — through a new
  `world.touchSessionInput(sessionId, now)` helper.

Explicitly **not** counted as input (so the UI cannot polling-keep
someone "alert"):

- WS pings.
- `/api/state` projections.
- Replay/catchup endpoints.
- Session resume / hydration on connect.
- Internal cross-host RPCs (these aren't user input).

`world.call(sessionId, ...)` already has `sessionId`, so it can call
`touchSessionInput` directly. `world.directCall(...)` does *not* —
many direct calls are internal/test/system. The right move is the
WS/REST ingress layer, not the dispatch layer.

## Verb placement

LambdaMOO has the idle conditional on `$player:look_self`, not
`$root` or `$actor`. We mirror that: a new `$player:look_self` seed
verb that uses `pass()` to inherit the existing `$actor:look_self`
output (title + description + carrying), then appends the idle line.

Putting it on `$actor` would make every actor-shaped object report
"sleeping" when nothing is connected, including bots and synthetic
actors that aren't tied to a session. `$player` is the right
boundary.

```
verb :look_self() rxd {
  let base = pass();
  let line = "";
  if (!is_connected(this)) {
    line = this.name + " is sleeping.";
  } else {
    let idle = idle_seconds(this);
    if (idle < 60) {
      line = this.name + " is awake and looks alert.";
    } else {
      line = this.name + " is awake, but has been staring off "
        + "into space for " + format_seconds(idle) + ".";
    }
  }
  base.description = base.description + " " + line;
  return base;
}
```

`format_seconds` is a helper — could be a builtin, or a tiny woocode
helper on `$root`. LambdaMOO uses `$string_utils:from_seconds`. For
first pass, an inline integer-to-readable conversion is enough; the
helper can be promoted later.

## Threshold

Fixed 60s for the alert/staring boundary, matching LambdaMOO. No
`$system.idle_thresholds` map yet — that lands cleanly later if we
want tunability without redeploys. A single literal in the verb is
smaller and easier to validate now.

## Builtin registration checklist

Adding a builtin touches more than the VM switch. Cover all of:

- `src/core/tiny-vm.ts`: builtin name list (line ~111) + the case
  handler in the dispatch switch.
- `src/core/dsl-compiler.ts`: builtin allowlist (line ~138).
- `src/core/authoring.ts`: if it mirrors the builtin namespace for
  compile-time validation, add there too.

Skip any one of these and the verb compiles fine in tests but won't
parse fresh on next install.

## Tests

In-memory world conformance:

- Fresh session → `is_connected(actor)` true, `idle_seconds(actor)`
  approximately 0.
- Detach all sockets → `is_connected(actor)` false. `idle_seconds`
  returns null. `:look` shows "sleeping".
- Two sessions for one actor, one detached one active → still
  "alert"; `idle_seconds` reflects the active one.
- Tick clock past 60s without input → `:look` shows "staring off."
- A `/api/state` poll while idle → does *not* reset idle (this is
  the "polling-keep-alert" regression to avoid).

## Out of scope for first pass

- `$system.idle_thresholds` map — fixed 60s for now.
- Surfacing idle in `:who` / `:look <room>` (LambdaMOO does this
  via `tell_contents` decorations). Add later if it feels missing.
- Account-level "last seen across all sessions" for offline display.
- Cross-host idle queries (the metric lives on the gateway today;
  a real cluster will need to roll across remote session tables).

## Open questions

- Should `format_seconds` be a substrate builtin (paralleling LM's
  `$string_utils:from_seconds`) or a woocode helper? Builtin is
  cheaper at runtime; helper is more idiomatic for woocode-ward
  drift. Lean: builtin, since string-formatting durations is
  generally useful.
- Where exactly does `lastInputAt` live for *cold* (rehydrated-from-
  storage) sessions where the original timestamp isn't recoverable?
  Proposal above: treat as "just active" on rehydrate. Fine for
  first pass; revisit if it produces visibly weird "everyone alert
  after deploy" for an unusable amount of time.
