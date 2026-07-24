---
date: 2026-07-24
status: draft — specified, not yet implemented
---

# Scheduling

> Part of the [woah specification](../../SPEC.md). Layer: **semantics**.

The author-facing surface for deferred execution: `schedule`,
`schedule_at`, `cancel_schedule`, `schedules`, and the `fork` spelling
retained from LambdaMOO. The mechanism these compile to — the per-scope
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
schedule(target, verb, args, delay_ms)              -> schedule_id
schedule(target, verb, args, delay_ms, key)         -> schedule_id   (upsert)
schedule_at(target, verb, args, at_ms)              -> schedule_id
schedule_at(target, verb, args, at_ms, key)         -> schedule_id   (upsert)
cancel_schedule(schedule_id)                        -> bool
schedules()                                         -> list
```

- `target` — an object in the **current scope**. Any object, not only
  `this`; the permission check at fire time is the ordinary one, so this
  grants nothing a live call would not. Scheduling into another scope is
  not available (SC8).
- `verb` — a string. Resolution happens at fire time, not now.
- `args` — a list of values. Values, not a closure: the arguments are
  serialized into a durable row, so they cannot capture locals, `this`, or
  anything else from the arming frame.
- `delay_ms` / `at_ms` — see SC3.
- `key` — the stable-key form; see SC4.
- `schedules()` returns the pending entries armed **by this object**, each
  `{id, at, target, verb, args, idle_policy}`. Bounded by the per-object
  quota, so this is not enumeration.

Return value is the schedule id (SC4), which is what `cancel_schedule`
takes. `cancel_schedule` returns whether an entry was removed; cancelling
something that is not there is a no-op, not an error.

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

**Minimum interval: 60 seconds.** Consecutive deliveries of the same
`(target, verb)` pair in a scope are spaced at least this far apart. A
request for less does not fail; it is delivered at the floor. This is not
a tuning accident — every delivery is a full committed turn, and the
committed plane is not where animation belongs. Sub-minute behavior goes
on the live plane or in the browser.

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
  against live state.
- programmer authority from the **fired verb's own owner**, exactly as on a
  live call. Arming a schedule stores no authority.
- a `scheduled` context block: `{id, at, fired_at}`. `at` is when it was
  supposed to run; `fired_at` is when it did. They differ after eviction,
  after a floor deferral, and after a busy scope defers a due batch.

**Missed intervals are not replayed.** An overdue entry fires once. A
scope that was evicted for a month wakes and fires each pending entry a
single time, not once per interval that elapsed. If the gap matters to
your verb, `fired_at - at` is how you find out.

**A failed scheduled turn is not retried.** It produces an error frame and
the entry is dropped. A chain that wants retry re-schedules explicitly —
which also means a chain whose verb is broken stops instead of failing
forever.

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

Every entry has an idle policy.

- **`while_active`** — does not fire while the scope has no live
  subscribers; parked, and re-armed by the next accepted turn in the
  scope. Available to ordinary catalog code, and the default for repeating
  chains. Correct for anything whose only purpose is to be seen: a
  playhead, a roster refresh, ambient behavior.
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

Sugar for `schedule(target, verb, [args...], delay_seconds * 1000)`.
Retained because it is the spelling LambdaMOO authors reach for and the
one the reference material uses.

Three things to know:

1. **`fork` takes seconds; `schedule` takes milliseconds.** This is a wart
   kept on purpose — changing `fork`'s unit would defeat the point of
   keeping the name.
2. **The 60-second floor still applies.** `fork(1, ...)` is a v1 reflex and
   it will be delivered a minute later, not a second later.
3. **There is no block form.** LambdaMOO's `fork (5) ... endfork` captured
   the forking frame's variables; a woo schedule carries values in a
   durable row and captures nothing. Pass what the verb needs as `args`.

`suspend()` and `read()` have no equivalent and are not part of the
language. See [tasks.md §16](tasks.md).

## SC10. Errors

| Code | Raised when |
|---|---|
| `E_PERM` | arming an `always` entry without wizard authority; cancelling an id outside the calling object's namespace |
| `E_QUOTA` | over the per-scope, per-object, per-turn, or horizon bound (CO16.7) |
| `E_INVARG` | `at_ms` in the past; `target` outside the current scope; malformed args |
| `E_TYPE` | non-numeric delay or time |

`E_QUOTA` is pre-action per [failures.md](failures.md): the check runs
before the would-be allocation, and the whole turn is rejected rather than
half its schedules applied.

## SC11. Catalog surface

The builtins are the substrate. What authors and users should normally
touch is the `$scheduling` feature: `:remind_in`, `:deadline`,
`:start_ticking`, `:stop_ticking`, `:pending`. It is where the wizard gate
of SC7 is discharged and where the durable-landing discipline of SC6 is
already applied.
