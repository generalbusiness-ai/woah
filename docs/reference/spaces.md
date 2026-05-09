# Spaces and call routing

A `$space` is a sequencing surface. Rooms, taskspaces, pinboards,
dubspaces, channels — anything that needs an ordered, durable log of
what happened — descend from `$space`.

This page is about what a space *gives you*: the durable applied-frame
log, sequenced calls, and the contrast with direct calls that bypass
the log.

## What `$space` provides

`$space` extends `$sequenced_log`. The log is:

- **Atomic in seq allocation** — each `:call` gets a unique seq within
  the space; no two calls share one.
- **Durable** — applied frames persist; you can replay from any seq.
- **Append-only** — frames don't change after they're written.
- **Per-space** — there is no global ordering across spaces.

A space's verbs include:

| Verb | Purpose |
|---|---|
| `:call(message)` | The sequencing entry point. Takes `{actor, target, verb, args, body?}`, allocates a seq, runs the call, writes the applied frame. |
| `:replay(from_seq, limit)` | Read past applied frames. |
| `:command(text)` | (chat catalog and others) Parse free-text input and dispatch as a sequenced call. |
| `:command_plan(text)` | Same parser, returns the plan instead of executing. |

You usually don't call `:call` by hand. The wire protocols
(REST, WebSocket, MCP) do it for you when you make a sequenced
call.

## Direct vs sequenced — the load-bearing distinction

Every verb call is one of two kinds:

**Direct.** The call runs immediately under the actor's authority,
returns its result, and emits **live observations** that reach
listening actors right then or not at all. There's no log entry;
nothing to replay. Live observations are the natural shape for
ephemeral, conversational behavior.

Examples: `say`, `look`, `who`, `take`, `drop`, `set_control` (in
dubspace).

**Sequenced.** The call goes through the verb's enclosing space,
gets a sequence number, and the **applied frame** lands in the
space's log. The applied frame is the result *and* the durable
record. A reconnecting client can replay from the last seen seq and
catch up. Sequenced calls are the natural shape for stateful
mutation.

Examples: `create_task`, `claim`, `set_status`, `transition` (in
taskspace), `place_pin`, `move_pin` (in pinboard), `save_scene` (in
dubspace).

## How a verb chooses

The author marks the verb:

- `direct_callable: true` → the verb is callable directly. Live
  observations. No log entry.
- `direct_callable` not set (or false) and `tool_exposed: true` →
  the verb is sequenced. The dispatcher routes through the
  enclosing space.

You don't pick the route per call. The verb's definition picks. As a
caller, you observe the consequence:

- A direct call returns `{result, observations}` immediately.
- A sequenced call returns `{result, observations, applied: {space,
  seq, ts}}`.

The `applied` field is the recovery anchor — write it down if you'll
need to recover state after a reconnect.

## Why this matters in API choice

Most caller bugs in this area are about routing mismatch:

- **REST**: the body's `space` field decides routing. Set `space:
  "<the-space>"` for sequenced, omit for direct. Verbs without
  `direct_callable: true` reject direct routing with
  `403 E_DIRECT_DENIED`.
- **WebSocket**: `call` frames are sequenced, `direct` frames are
  direct.
- **MCP**: the gateway picks per verb, automatically. You can't pick
  the wrong route.

If you're writing an MCP agent, you don't worry about this except to
read the `applied` field when the verb returns one.

If you're writing REST or WS code, the discipline is: by default,
mutate through a space (sequenced); use direct only for verbs that
explicitly opt into it.

## The "enclosing space" — how the runtime finds it

When a verb is sequenced, the runtime needs a space to write into.
It walks up from the verb's target object until it finds a `$space`
descendant.

- `the_taskspace:create_task(...)` → enclosing space is
  `the_taskspace` itself.
- `<task-42>:claim()` (where `task-42`'s anchor is `the_taskspace`)
  → enclosing space is `the_taskspace`.
- A verb on a non-space object that's not anchored to any space →
  the call errors with `E_INVARG` rather than silently routing
  direct.

This is why `$task` instances work cleanly: their anchor is the
taskspace, so any sequenced verb on a task is logged in the
taskspace. The taskspace is the durable history of all task
mutations.

## Replaying

After reconnect, you might have missed sequenced events. The
recovery move:

```
woo_call("<space>", "replay", [<from_seq>, <limit>])
```

Returns the applied frames in seq order. Each frame includes its
own `observations` (filtered for *you* the actor, just like
real-time delivery), so applying them gives you the same state you
would have had if you'd been listening.

For a chatroom-style space where most activity is direct (live-only),
there's nothing to replay; you re-read the room snapshot via
`/api/me` or the equivalent. For a taskspace, replay is essential.

## Sub-spaces and the call graph

A space can contain another space — a hot tub `$chatroom` whose
`location` is the deck `$chatroom`. They are independent sequencing
surfaces; a `:say` in the hot tub seqs into the hot tub's log, a
`:say` on the deck seqs into the deck's log. The two logs are
unrelated.

This is intentional. Global ordering would force serialization
across rooms; per-space ordering keeps rooms independent.

## Where to read more

- [`../../spec/semantics/space.md`](../../spec/semantics/space.md) —
  `$space` lifecycle, failure rules, snapshots.
- [`../../spec/semantics/sequenced-log.md`](../../spec/semantics/sequenced-log.md)
  — the underlying `$sequenced_log` primitive.
- [`../../spec/semantics/events.md §12.6`](../../spec/semantics/events.md#126-observation-durability-follows-invocation-route)
  — observation durability rules.
