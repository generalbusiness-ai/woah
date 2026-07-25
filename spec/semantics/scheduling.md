---
date: 2026-07-25
status: partial — SC2/SC3/SC4/SC9/SC10 implemented (builtins, clamping, namespaced ids, fork sugar, errors); SC5's fire-time context, SC7's idle-policy delivery filter, and SC11's catalog surface are specified and not yet built
---

# Scheduling

> Part of the [woah specification](../../SPEC.md). Layer: **semantics**.

The author-facing surface for deferred execution: `schedule`,
`schedule_at`, `cancel_schedule`, and the `fork` spelling retained from
LambdaMOO. The mechanism these compile to — the per-scope
pending queue, the alarm, the planner dispatch, the delivery envelope, and
the quotas — is normative in
[protocol/coherence.md §CO16](../protocol/coherence.md#co16-scheduled-turns).
This document specifies what an author writes and what they are promised.

Design rationale: `notes/2026-07-24-scheduled-events-design.md`.

---

## SC1. The one primitive

Woo offers exactly one way to make something happen later:

> Fire verb `V` on object `O` with args `A`, **once**, at a wall-clock
> instant `T`, as a committed turn in the current scope, on behalf of the
> current actor.

Everything else composes from that in woocode. A repeating behavior is a
verb that schedules itself again when it runs. A calendar rule is a
function that computes the next `T`. The substrate does not know about
recurrence, weekdays, business hours, or timezones, and should not: those
are catalog concerns with catalog-shaped disagreements about them.

## SC2. Signatures

```
schedule(target, verb, args, delay_ms, opts?)       -> schedule_id
schedule_at(target, verb, args, at_ms, opts?)       -> schedule_id
cancel_schedule(schedule_id)                        -> null
```

`opts` is a map. Both keys are optional:

| Key | Values | Default |
|---|---|---|
| `key` | string — the stable-key form (SC4); upserts | absent: turn-unique id |
| `idle_policy` | `"while_active"` \| `"always"` | `"while_active"` |

`idle_policy` is **always explicit or defaulted, never inferred**. An
earlier draft left it off the signature entirely and expected the runtime
to deduce it from whether a stable key was supplied; that does not work,
because a cancellable one-shot deadline uses a stable key for exactly the
same reason a repeating chain does. See SC7.

- `target` — an object in the **current scope**. Any object, not only
  `this`; the permission check at fire time is the ordinary one, so this
  grants nothing a live call would not. Scheduling into another scope is
  not available (SC8).
- `verb` — a string. Resolution happens at fire time, not now.
- `args` — a list of values. Values, not a closure: the arguments are
  serialized into a durable row, so they cannot capture locals, `this`, or
  anything else from the arming frame.
- `delay_ms` / `at_ms` — see SC3.

`schedule` returns the schedule id (SC4), which is what `cancel_schedule`
takes. The id is computed from values the turn already has, so it needs no
queue read.

**`cancel_schedule` returns nothing**, and there is deliberately **no
builtin that reads the queue**. Both omissions are the same point: the
pending queue is scope-owned state that the planner does not hold, so any
answer about it computed while planning can be falsified before the turn
commits — by a concurrent fire, an upsert, or another cancellation — with
nothing to catch it, because the turn read no cell to invalidate. An
idempotent instruction that reports nothing has no such window; a `bool`
return or a `schedules()` list would be a lie the system cannot detect.

Cancelling an id that is not there is a no-op, not an error. If your code
needs to know whether a deadline was met, record that in your own
properties, where the ordinary read-version rules apply.

To *see* what is pending, use the live introspection read (SC11) — outside
turn semantics, where a possibly-stale answer is honest and fine.

## SC3. Time

**All times are UTC epoch milliseconds.** `at_ms` is on the same clock
`now()` returns. `delay_ms` is added to the current turn's clock reading.

There is no timezone parameter and no local-time interpretation. A rule
like "every weekday at 09:00 in the user's timezone" is woocode that
computes the next UTC instant and arms a one-shot for it. Be aware of the
consequence: a chain that re-arms at a fixed offset drifts relative to
local wall time across a DST boundary. A chain that must hold to local
time recomputes its next instant from a timezone rule each time it fires.

**Determinism.** The clock reading comes from the same recorded logical
input `now()` uses, so the value is fixed when the turn is planned and
replayed identically at validation and on replay. A scheduled time is part
of the turn's committed effect, not a property of when some host happened
to execute it.

**Minimum lead time: 60 seconds.** A scheduled turn fires no sooner than
60 seconds after the turn that armed it. Ask for less and you get 60
seconds — the value is **clamped**, not rejected, so `schedule(this,
"tick", [], 5000)` arms a tick one minute out and no error is raised.

Note what this is not: it is not a rate limit between deliveries of the
same verb. It is a floor on every single delay. Since a repeating chain
re-arms only when it fires, a floor on each delay is also a ceiling of one
turn per minute on the chain — which is the property worth having, and it
is checkable from the turn itself with no durable last-delivery
bookkeeping anywhere.

This is not a tuning accident — every delivery is a full committed turn,
and the committed plane is not where animation belongs. Sub-minute
behavior goes on the live plane or in the browser.

**Maximum horizon: 365 days.** Beyond that, `E_QUOTA`.

## SC4. Schedule ids

The id is `<the scheduling object>:<key>` — the engine builds it; the
author supplies at most the `key` half. Two forms:

- **Turn-unique** (no `key` given): the key is derived from the turn id and
  a per-turn counter. Distinct for each call within a turn, identical on
  replay. Use for one-shots.
- **Stable key** (`key` given): the key is what you passed. Arming again
  with the same key **replaces** the pending entry rather than adding a
  second one. Use for periodic chains and for anything you intend to
  cancel later.

An object can only cancel its own ids. This is deliberate: without the
namespace, any verb in a room could cancel or silently overwrite any other
object's timer.

## SC5. What the fired verb sees

The scheduled turn is an ordinary committed turn with:

- `caller` = `$system` — it was woken, not called.
- the actor recorded when it was armed, with permissions checked **now**,
  against live state, by the ordinary permission kernel: `x` / verb-owner
  / wizard. `direct_callable` is not consulted — that flag gates what an
  outside client may invoke while bypassing sequencing, and a scheduled
  turn is neither outside nor unsequenced. **A scheduled turn is
  authorized exactly as a sequenced call by that actor would be**, which
  is the honest comparison for a turn that takes its own `seq`.
- no presence check: there is no session and nothing to be present on.
- programmer authority from the **fired verb's own owner**, exactly as on a
  live call. Arming a schedule stores no authority.
- a `scheduled` context block: `{id, at, fired_at}`. `at` is when it was
  supposed to run; `fired_at` is when it did. They differ after eviction,
  after a floor deferral, and after a busy scope defers a due batch.

**Missed intervals are not replayed.** An overdue entry fires once. A
scope that was evicted for a month wakes and fires each pending entry a
single time, not once per interval that elapsed. If the gap matters to
your verb, `fired_at - at` is how you find out.

**A failed scheduled turn is not retried.** The failure is recorded
durably in the scope and emitted as a `scheduled_turn_failed` observation,
and the entry is dropped. A chain that wants retry re-schedules explicitly
— which also means a chain whose verb is broken stops instead of failing
forever, and leaves a record saying why.

The recording matters more here than for a live call. Nobody is waiting on
a scheduled turn's reply: the actor has no session and may not even exist
any more. Without a durable record a broken deadline would fail in perfect
silence, which is the one thing a deadline must never do.

## SC6. Reporting results, and the silence

`tell(actor, ...)` is live, not durable. **A scheduled verb whose only
output is `tell` produces nothing at all if the actor is not connected
when it fires**, and neither the engine nor the compiler will warn you.

This is the sharpest edge in the whole surface, because "remind me in ten
minutes" is the first thing anyone writes, and a reminder is exactly the
case where the actor is likely to be away.

Scheduled work whose output matters MUST land it durably first — an act on
the scope's log, a note, a message object — and MAY `tell` in addition, for
the case where someone is there to see it. The `$scheduling` catalog verbs
do this in that order; hand-rolled scheduling should too.

## SC7. Idle policy, and who may arm an unattended timer

Every entry has an idle policy, passed explicitly in `opts` (SC2) or
defaulted to `while_active`. Nothing infers it: a stable key does not mean
"repeating chain", because a cancellable deadline uses one too.

- **`while_active`** — does not fire while the scope has no live session
  subscribers; parked, and re-armed by the next accepted turn in the
  scope. The default, available to ordinary catalog code. Correct for
  anything whose only purpose is to be seen: a playhead, a roster refresh,
  ambient behavior.

  "Live subscriber" means a session attached to the scope for delivery.
  Hidden-roster service sessions (`roster_visible:false`) count — a plug
  holding one is a real observer, just not a person in the room. Fanout
  and planner gateway registrations do **not** count; they are
  infrastructure, and a scope always has a planner when scheduling works
  at all.
- **`always`** — fires whether or not anyone is present. Necessary for
  deadlines, expiries, and pushes. **Arming one directly requires wizard
  authority.**

The reason for the gate is cost, not danger: a repeating `always` chain
runs forever in a scope nobody will ever visit again, in a world that
expects millions of scopes.

The gate is on *arming*, not on *use*. User-facing one-shots reach `always`
through wizard-owned catalog verbs — `$scheduling:remind_in`,
`$scheduling:deadline` — which arm on the caller's behalf under their own
owner's authority, the ordinary way a privileged builtin gets wrapped. So
the rule reads *no unattended timer without going through code a wizard
wrote*. It does not read *no reminders*.

## SC8. Scope

`schedule` is same-scope only. To make something happen later in a
different scope, schedule locally and have the fired verb submit an
ordinary call to the other scope — the same thing you would do to reach it
now.

This keeps the pending queue inside the authority that owns it, and keeps
the rule that no node needs knowledge of any other. See
[CO16.1](../protocol/coherence.md#co161-the-primitive).

## SC9. `fork` — the LambdaMOO spelling

```
fork(delay_seconds, target, verb, args...)   -> schedule_id
```

Sugar for `schedule(target, verb, [args...], delay_seconds * 1000)` with
default options — so `while_active`, and a turn-unique id. A `fork` cannot
arm an `always` entry or a stable key; reach for `schedule` when you want
either.

Three things to know:

1. **`fork` takes seconds; `schedule` takes milliseconds.** This is a wart
   kept on purpose — changing `fork`'s unit would defeat the point of
   keeping the name.
2. **The 60-second lead time still applies.** `fork(1, ...)` is a v1 reflex;
   the delay clamps to 60s and the call fires a minute later, silently.
   No error, because clamping is the specified behaviour (SC3).
3. **There is no block form.** LambdaMOO's `fork (5) ... endfork` captured
   the forking frame's variables; a woo schedule carries values in a
   durable row and captures nothing. Pass what the verb needs as `args`.

`suspend()` and `read()` have no equivalent and are not part of the
language: both fail at compile time with a pointer here. See
[tasks.md §16](tasks.md).

## SC10. Errors

| Code | Raised when |
|---|---|
| `E_PERM` | arming an `always` entry without wizard authority; cancelling an id outside the calling object's namespace |
| `E_QUOTA` | over the per-scope or per-object entry count, the per-entry or per-scope byte cap, the per-turn call cap, or the 365-day horizon (CO16.7) |
| `E_INVARG` | `target` outside the current scope; malformed `opts`; unknown `idle_policy` |
| `E_TYPE` | non-numeric delay or time |

A delay below the floor is **not** an error — it clamps (SC3). An `at_ms`
in the past clamps the same way, to now + the lead time; nothing about a
past instant is ambiguous enough to be worth failing a turn over.

`E_QUOTA` is pre-action per [failures.md](failures.md): the check runs
before the would-be allocation, and the whole turn is rejected rather than
half its schedules applied. Note the consequence — the byte caps mean a
verb can be rejected for *what* it scheduled, not just how much, so an
author passing a large `args` payload should pass a reference instead.

## SC11. Catalog surface

The builtins are the substrate. What authors and users should normally
touch is the `$scheduling` feature: `:remind_in`, `:deadline`,
`:start_ticking`, `:stop_ticking`, `:pending`. It is where the wizard gate
of SC7 is discharged and where the durable-landing discipline of SC6 is
already applied.

`:pending` is the introspection surface, and it is a **live** read, not a
committed one: it asks the scope what is queued and reports the answer.
That answer may be stale the moment it arrives — an entry may fire while
the reply is in flight — which is fine for "what does this room have
armed?" and is why no committed builtin offers the same thing (SC2).
