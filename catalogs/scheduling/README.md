---
name: scheduling
version: 0.1.0
spec_version: v1
license: MIT
description: The $scheduling feature — the author-facing surface over the schedule() primitive. Mount it on a space or actor for one-shot reminders that land durably, cancellable escalation deadlines, and a presence-gated tick chain. It is where two CO16 rules are discharged rather than merely stated - the wizard gate on unattended timers, and the rule that a scheduled turn's output must survive its actor being gone.
depends:
  - @local:note
keywords:
  - scheduling
  - timers
  - reminders
  - deadlines
---

# scheduling

The author-facing surface over `schedule()` (see [DESIGN.md](DESIGN.md) for
why it is shaped this way, and
[spec/semantics/scheduling.md](../../spec/semantics/scheduling.md) for the
normative contract).

The substrate offers exactly one deferred-execution primitive: fire a verb
once, at a wall-clock instant, as a committed turn in this scope. This
catalog is what makes that usable.

## Mounting

`$scheduling` is a feature, so it attaches to `$actor` and `$space`
descendants — typically a room:

```
this:add_feature($scheduling);
```

A catalog that wants it on a class declares an `attach_feature` seed hook,
which is also what lets the installer resolve `this:deadline(...)` in its
static call-graph check.

## Surface

| Verb | Who may call it |
|---|---|
| `:remind_in(delay_ms, text, tag)` | any actor — scoped to the caller |
| `:cancel_reminder(tag)` | any actor — cancels only their own |
| `:start_ticking(rate_ms)` | the object's owner, or a wizard |
| `:stop_ticking()` | the object's owner, or a wizard |
| `:deadline(delay_ms, verb_name, verb_args, key)` | **internal** — `this:` only |
| `:cancel_deadline(key)` | **internal** — `this:` only |

Three more verbs (`_deliver_reminder`, `_fire_deadline`, `_tick`) are fired
by the scheduler and refuse every other caller.

## Three things that will surprise you

**The minimum delay is 60 seconds, and a shorter one is silently clamped.**
Every delivery is a full committed turn; the committed plane is not for
animation. `fork(1, ...)` fires a minute later, not a second later.

**Two untagged reminders replace each other.** `tag` defaults to
`"default"`, and a stable key upserts. Pass distinct tags for concurrent
reminders.

**A reminder that only `tell`s is lost.** `tell` is live-only, and a
scheduled turn is exactly when its actor is likely disconnected —
`:remind_in` mints a durable note *before* it tells, and anything you build
here should do the same.

## Worked example

`catalogs/casework` uses the deadline surface for task escalation:
`open_task` arms one keyed to the task it just minted, `claim` cancels it,
and `escalate_task` re-checks that the task is still unclaimed before
recording the fact — cancellation is best-effort, so a race can still
deliver the timer after the work was taken.

## Not here

`:pending` — "what does this room have armed?" — is deliberately absent. A
verb runs inside a turn, and a committed read of the pending queue could not
carry a versioned read proof, so any answer it computed could be falsified
before commit. Introspection is the live `GET /net-api/schedules?scope=`
read instead.
