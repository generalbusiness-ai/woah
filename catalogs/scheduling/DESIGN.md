# scheduling — the author-facing timer surface

`schedule()` (spec/semantics/scheduling.md) is one primitive: fire a verb
once, at a wall-clock instant, as a committed turn in this scope. This
catalog is the surface over it. It exists because two rules in CO16 need a
place to be *discharged* rather than merely stated.

## Why the verbs are catalog-owned

Arming an unattended (`always`) timer requires wizard authority (CO16.6),
because a repeating `always` chain bills a world forever in a scope nobody
will visit again. But the common one-shots — "remind me in ten minutes",
"close this if nobody claims it" — *are* `always` entries, and users are
not wizards.

The gate is therefore on **arming directly**, not on the shapes built over
it. Catalog verbs are `$wiz`-owned, so `progr` is a wizard when they run,
and an ordinary caller reaches `always` through them and only through them.
The rule reads *no unattended timer without going through code a wizard
wrote* — not *no reminders*. Move these verbs to a non-wizard owner and the
whole surface stops working; that is the design, not an accident.

## Why `:remind_in` writes before it tells

`tell` is live-only. A scheduled turn is precisely the case where the actor
is likely disconnected — it has no session, and the actor may not exist any
more. A reminder that only told would vanish exactly when it mattered.

So `_deliver_reminder` mints a durable `$note` in the actor's inventory
first and tells second. The substrate does not enforce this (SC6 explains
why it cannot), which is why the catalog has to.

## Why tick chains keep no state

There is no `ticking` property and no `tick_ms` property. The rate rides in
the schedule's own arguments and the stable key IS the chain:

- `start_ticking(rate)` arms `_tick(rate)` under key `tick`;
- `_tick` calls the consumer's `:tick` and re-arms itself with the same rate;
- `stop_ticking()` cancels that key.

Starting twice re-arms one entry instead of racing two, because the stable
key upserts (CO16.2). Stopping is cancelling. Nothing can drift out of sync
with the queue because the queue is the only copy.

This fell out of a constraint — the DSL has no `define_prop`, so a feature
cannot add state to its consumer — and turned out better than the
property-backed design it replaced.

## Why `_tick` re-arms in the same turn as the work

`_tick` calls `:tick` and then re-arms, both in one committed turn. If
`:tick` raises, the re-arm rolls back with it and the chain stops. That is
the intended failure mode: a broken chain halts and leaves one recorded
reason (CO16.8) instead of failing forever, once a minute, until someone
notices.

## Why the internals refuse their own callers

`_deliver_reminder`, `_fire_deadline` and `_tick` run with the scheduler's
identity when fired. They are not `direct_callable`, which stops external
ingress — but any verb on the same object can `dispatch()` to them, which
ingress never sees. Hence the `caller != $system` guard in each. Both
defences are needed and both are tested; removing the guard alone leaves
the ingress test green.

## Why `:deadline` carries `verb_args`

A deadline that cannot say what it is about can only fire object-wide
verbs. The first real consumer (casework escalation) needed "escalate THIS
task" and could not express it, so the subject is now carried. The
parameter is `verb_args`, not `args`, because `args` is a verb-body global
and a parameter of that name does not compile.

## What is missing

`:pending` — "what does this room have armed?" — is not here. Introspection
must be a live read, since a committed queue read would need a versioned
read proof the queue cannot give (SC2), and the CO16.9 live route is
unbuilt. Authors and operators currently have no supported way to see
pending entries. That is the largest known gap in this surface.
