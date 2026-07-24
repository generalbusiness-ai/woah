# Scheduled events and timers — design

> Work description, not a spec. The normative outcome of this note is a
> revision of [`spec/protocol/coherence.md` §CO16] plus a new semantics
> section for the `schedule` builtin; see §11 for the exact edit list.

## 1. Where we actually are

Three partly-built mechanisms exist for "make something happen later".
Only one of them works, and it is the one with no producer.

### A. v1 parked tasks — `fork()` / `suspend()` / `read()`. **Dead.**

- Spec: `spec/semantics/tasks.md` §16, marked `status: implemented`.
- VM: `FORK` / `SUSPEND` / `READ` opcodes exist (`src/core/tiny-vm.ts:736-752`),
  the DSL compiles `fork(...)` and `suspend(...)`
  (`src/core/dsl-compiler.ts:1142,1154`), and `world.ts` has the full
  park/resume machinery (`scheduleFork` 7283, `parkVmContinuation` 7317,
  `runDueTasks` 7399, `resumeContext` 10458).
- **Nothing wakes it.** `runDueTasks` has no caller anywhere in `src/`;
  the only callers are `tests/vm.test.ts`, `tests/persistence.test.ts`,
  `tests/core.test.ts`, `tests/conformance.test.ts`.
  `Repository.loadDueTasks` / `earliestResumeAt`
  (`src/core/repository.ts:351,362`) — the interface the spec says the
  "runtime's alarm handler loads these on alarm fire" — likewise have no
  runtime caller. The alarm handler that was supposed to call them lived
  in the classic stack, which NC9 deleted.
- **It cannot work on the net stack even with a waker.** A `fork()` inside
  a net turn runs in the *gateway's planning world*. It writes a
  `ParkedTaskRecord` there and the `EffectTranscript` has no field to carry
  it (`src/net/transcript.ts` — no `parked`). The record dies with the
  planning world; scope authority never hears about it.
- So today: woocode may write `fork(60) { ... }`, it compiles, it type-checks,
  it returns a task id, and **nothing ever happens**. Silent. No catalog
  uses it (`grep 'fork(' catalogs/*/manifest.json src/core/bootstrap.ts` →
  nothing), so nobody has been bitten yet. That is luck, not safety.

### B. CO16 scheduled turns. **Works, no producer.**

- Spec: `spec/protocol/coherence.md` §CO16 (adopted), designed in
  `spec/protocol/v2-turn-network.md` §VTN18 (proposed).
- Implemented and tested: durable per-scope `scheduled` row family with a
  due index (`src/net/scope-store.ts:76-89`), enqueue/cancel/peek/pop
  (`src/net/scope.ts:1645-1716`), the DO alarm that moves a **bounded batch**
  of due turns *atomically* from the scheduled family to `/plan-scheduled`
  outbox rows, a deterministically-chosen planner-role gateway that runs
  the turn through the normal `/net/turn` repair loop under idempotency key
  `sched:<id>:<at_logical_time>`, no-planner parking with a named metric,
  and drain-on-reactivation for the crash window.
  Six scope-side + one end-to-end case in `tests/worker/net-scheduled.test.ts`.
- **Nothing produces a schedule.** `POST /net/schedule`
  (`src/worker/net/scope-do.ts:1472`) has zero callers outside its own DO
  and its tests. There is no DSL builtin. CO16's last bullet says the
  engine-side `schedules`/`cancellations` transcript fields "remain deferred
  until the DSL exposes scheduling".

This is the good news: the hard half — durable, exactly-once, evictable,
alarm-driven, planner-executed delivery — is built and tested. What is
missing is the half that catalog authors touch.

### C. External cron plugs. **Works, operator-scale only.**

`catalogs/weather/plug` and `catalogs/horoscope/plug` are separate
Cloudflare Workers with `[triggers] crons = ["0 * * * *"]`. Each tick they
authenticate with an actor-bound apikey and push via a verb call.

This exists because of **egress**, not because of timing: the plug holds a
`tomorrow.io` key and makes outbound HTTP, which a committed turn must not
do. That justification survives. What does not survive is using a deployed
Worker plus a provisioned secret as the way to say "every hour". Nothing
in-world can create one, one broke this week on credentials, and it does
not compose.

## 2. What we are designing for

Concrete demand, in rough order of value:

| Case | Shape | Where the answer lives today |
|---|---|---|
| "Remind me in 10 minutes" | one-shot, user actor | nothing |
| "Auto-close this case after 24h" | one-shot deadline, no observer | nothing (`spec/operations/workflows.md:188` explicitly defers it) |
| "Refresh the weather hourly" | periodic + egress | external plug |
| "Escalate if unacknowledged in 15m" | one-shot, cancelled by the ack | nothing |
| "Advance the dubspace playhead" | high-rate periodic | nothing (live plane candidate) |
| "Expire this lease / retire this session" | substrate housekeeping | ad-hoc DO alarms |

Note the split in the third column: everything a *user or catalog author*
would want is missing, and the substrate has been solving its own timing
needs with private alarms.

## 3. The shape

**One primitive. One plane. Everything else composes in woocode.**

The substrate offers exactly one thing:

> Fire verb `V` on object `O` with args `A`, once, at wall-clock time `T`,
> as a committed turn in this scope, on behalf of actor `X`.

Not recurrence. Not cron expressions. Not calendars, timezones, or
"every second Tuesday". Those are woocode: a periodic chain is a verb that
re-schedules itself; a cron expression is a woocode function that computes
the next `T`. This is the layering rule (`AGENTS.md`: native helpers are
generic primitives invoked by woocode) and it is also just correct — the
substrate has no business knowing about weekdays.

Delivery is B's existing machinery, unchanged. The new work is the
producer, the safety envelope, and the catalog surface.

## 4. Decisions

### D1. Schedules are transcript effects, not a side channel

`schedule()` and `cancel_schedule()` record entries in the turn's
`EffectTranscript` — the `schedules` / `cancellations` arrays that CO3
already declares as the target shape — and the commit scope applies them
**atomically with the turn's writes**, inside `post_state_hash`.

Rationale: CO9, one write path per fact. A timer set by a turn that was
then rejected must not exist. A turn replayed must set the same timer.
The acceptance receipt the client already gets is then also the answer to
"did my reminder get set?". An out-of-band `POST /net/schedule` from the
gateway could not give any of that.

`/net/schedule` survives as a substrate/operator surface (seeding, repair,
tests) and is documented as such. It is not the woocode path.

### D2. Time is wall-clock milliseconds, sampled as a recorded logical input

The stored field is named `at_logical_time` and is compared against
`host.now()` (`src/worker/net/scope-do.ts:1481`, `src/net/scope.ts:1650`) —
i.e. it is already epoch milliseconds. VTN18.4's story that logical time
is a per-turn monotonic counter *and* that you add `delay_ms` to it is
incoherent and was never implemented. Settle it the honest way:

- **Order** is the sequenced log's `seq`. That is what "logical time" was
  reaching for and the log already provides it.
- **Due-time** is wall-clock epoch ms. Users mean minutes; alarms are
  wall-clock; the durable rows are wall-clock.
- Determinism is preserved because the builtin computes
  `at = now() + delay` from `world.logicalNow()`
  (`src/core/world.ts:1403`), which is a **recorded, replayed logical
  input**. The gateway's plan and the scope's validation see the same
  number; replay reproduces it. No new determinism machinery.

Keep the wire/row field name `at_logical_time` (renaming costs a store
migration for zero behavioural gain) but **redefine it in the spec** as
"the scope clock, denominated in epoch milliseconds", and name the DSL
parameter `delay_ms` / `at_ms` so authors are never told a falsehood.

### D3. No stored programmer authority

VTN18.2 captures `caller_perms: ObjRef` — the scheduling frame's `progr` —
in the pending entry. That is a stored capability with an unbounded
lifetime, and it is not needed: when the turn fires, the verb dispatches
normally and takes programmer authority from **its own owner**, exactly as
it would on a live call. Only the **actor** is captured, because the actor
is who the turn acts for and who the permission check at fire time runs
against.

Drop `caller_perms` from the request shape. This is a change from the
VTN18 draft.

Permission is checked at **delivery** against live state (VTN18.8 is right
about this): a demoted, deleted, or moved actor produces an error frame and
the entry is dropped. Scheduling grants nothing you could not do now, and
holds nothing you later lose.

### D4. Schedule ids are namespaced to the scheduling object

VTN18.3's stable-key form lets a verb supply any id, and `cancel_schedule(id)`
takes any id. As drafted, one object can silently overwrite or cancel
another object's timer — a same-scope denial-of-service with no audit
signal.

Fix: the stored id is `<scheduling object ref>:<key>`, constructed by the
builtin, not by the author. `cancel_schedule` may only name ids in the
calling object's namespace; wizards may cancel any id in the scope through
an explicit builtin/verb, which is auditable. The turn-unique form is
`<obj>:<hash(turn_id, counter)>` — same namespace rule, stable across
replay.

Upsert-by-id within the namespace stays: it is what makes `start_ticking`
idempotent.

### D5. Epoch change does not cancel schedules

VTN18.6 cancels every pending entry whose epoch is stale. That means
**every catalog upgrade silently stops every timer in the world**, and the
recovery story is a `scope_resumed` observation type that VTN18.11 admits
does not exist. Silent mass-cancellation on a routine operation is the
wrong default.

Instead: entries carry the epoch they were created under for attribution,
but survive the fence. At fire time the turn is planned against the
**current** epoch. If the verb no longer exists, or its signature no longer
accepts the args, the turn fails loudly with an error frame and the entry
is dropped — one visible failure per broken timer, not a silent world-wide
stop. Catalog migrations that rename a ticking verb must re-arm; that is
the same obligation as any other migration and the migration doc is where
it belongs.

This is a change from the VTN18 draft.

### D6. No catch-up; overdue fires once

A scope evicted for a week wakes with overdue entries. Rule: an overdue
entry fires **once**, at its first opportunity, and the verb receives both
the intended `at` and the actual `fired_at` so it can decide what a
seven-day gap means. Periodic chains skip missed ticks rather than
replaying them; a chain only re-arms after it fires, so this falls out of
the upsert semantics for free.

Croquet catches up because it is simulating shared computation. A
persistent world with month-scale eviction must not wake up and execute
604,800 ticks.

### D7. The minimum interval floor is ~1s, not 16ms

VTN18.5 proposes a 16ms floor, inherited from Croquet's frame budget.
Every one of those ticks here is a **full committed turn**: a sequencer
transaction, a fanout pass, an audit record, a projection fold. The NC8
envelope is p95 ≤ 750ms for submits. 60 committed turns per second per
scope is not a rate this system has, and offering it in the DSL invites
authors to build things that cannot work.

Proposed: default floor **1000ms**, world-configurable down to **250ms**,
hard floor **100ms**. Faster than that belongs on the live plane or in the
browser, and `VTN18.10`'s live/committed table is the right guidance to
keep and promote.

The floor is applied at delivery (deferring the entry), not at recording,
so a chain asking for faster than the floor gets the floor rather than an
error — VTN18.5's behaviour, at a rate that reflects the actual system.

### D8. Idle scopes stop ticking

A self-perpetuating chain costs money forever, including in the millions of
scopes that nobody will ever visit again. Big-world discipline demands a
rule, so each entry declares an idle policy:

- **`while_active`** (default for periodic chains): the scope does not fire
  it while it has no live subscribers. The entry stays parked; the next
  accepted turn in the scope re-arms it. Correct for anything whose only
  purpose is to be observed — playheads, roster refreshes, ambient
  behaviour.
- **`always`** (default for one-shots): fires with nobody watching.
  Required for deadlines, expiries, and pushes. Costs one turn, once.

A periodic `always` chain is the expensive case and should require the
scope owner's authority, plus a metric that makes them countable per world.

### D9. Fired turns are session-less actor-authority DIRECT turns

Already the implemented posture (CO16 bullet 3) and it is right. The turn
carries `{actor, target, verb, args}` and no session. Context available to
the verb: `caller = $system`, plus a `scheduled: {id, at, fired_at}` block
so the verb can tell it was woken and how late.

**Consequence worth stating loudly:** `tell(actor, ...)` is live, not
durable. A reminder that fires while its actor is disconnected is *lost*.
Reminders must land as durable acts on the scope log (a note, an act, a
message object), and the catalog surface in §9 must make the durable path
the easy one.

### D10. Cross-scope scheduling is not a primitive

Same-scope only, as VTN18.3 has it. Waking another scope is a normal
committed turn submitted by the fired verb through the normal path. This
keeps the queue inside the authority that owns it, and keeps the
big-world rule that no node needs knowledge of others.

## 5. The DSL surface

```
schedule(target, verb, args, delay_ms)                  -> schedule_id
schedule(target, verb, args, delay_ms, key)             -> schedule_id  (upsert)
schedule_at(target, verb, args, at_ms [, key])          -> schedule_id
cancel_schedule(schedule_id)                            -> bool
schedules()                                             -> list of pending entries for `this`
```

- `target` must be in the calling scope. Any object, not just `this`: the
  fire-time permission check is the ordinary one, so this grants nothing
  a live call would not.
- `schedules()` is not decoration. Invisible timers are unmaintainable;
  an author needs to see what a room has armed, and an operator needs it
  more. Bounded by the per-object cap, so no enumeration concern.
- Four-registry lockstep applies to every one of these:
  `BUILTIN_NAMES` (append-only) + the `tiny-vm.ts` switch +
  `dsl-compiler.ts` `BUILTINS` + `authoring.ts` `VALID_BUILTINS`.
  Missing one produces a different symptom per registry.

## 6. Quotas and the abuse envelope

Scheduling is the cheapest way to buy someone else's compute, so the caps
are part of the design, not a follow-up.

| Bound | Proposed | Enforced at |
|---|---|---|
| Pending entries per scope | 1000 | scope, on transcript apply |
| Pending entries per object | 32 | scope, on transcript apply |
| `schedule` calls per turn | 16 | VM |
| Minimum delay | floor per D7 | scope, at delivery |
| Maximum horizon | 365 days | VM + scope |
| Due batch per alarm | already bounded + re-arm | scope (implemented) |

Over-cap raises `E_QUOTA` at commit validation with the usual pre-action
semantics (`spec/semantics/failures.md`: which quota, current vs limit).
The turn is rejected whole — a partially-applied schedule set is exactly
the kind of split state CO2.2 forbids.

`spec/reference/quotas.md:71` currently says task limits are out of scope
for storage accounting. That stays true; these are scope-local caps on a
scope-local row family, not owner storage.

## 7. Lifecycle

- **Target recycled** → cancel its entries. The scope's queue is bounded by
  the per-scope cap, so this is a bounded scan, not an index.
- **Target moved out of scope** → the entry fires, the turn cannot resolve
  the target, error frame, entry dropped. Loud is correct here; silently
  following an object across scopes would be the cross-scope primitive D10
  declines to build.
- **Actor recycled or demoted** → fire-time permission check fails, error
  frame, entry dropped (D3).
- **Epoch fence** → entries survive (D5).
- **Scope retirement (CO17)** → pending schedules must be part of the
  retirement checklist: a retiring scope cancels its queue and clears its
  alarm, and the CO17 draft needs the bullet. `spec/semantics/recycle.md`
  §RC11.3 step 3 already drops alarms on host teardown; the scope-level
  rule is the one that is missing.
- **No planner registered** → entries stay parked with the named metric
  (implemented); a later planner subscription arms an immediate wake
  (implemented).

## 8. Retire `fork` / `suspend`

They are unreachable (§1A), unused by any catalog, and they describe a
single-host execution model this system no longer has. Leaving them
compilable is a trap: the next author to reach for a timer will find them
in `language.md:79`, use them, and ship something that silently does
nothing.

Plan:

1. `fork(seconds) { ... }` in the DSL compiles to a `schedule()` of a
   synthesized verb, or is removed outright. Removal is cleaner — the
   block form implies a closure over locals that scheduled turns
   deliberately do not have (args are values in a durable row, not a
   captured frame).
2. `suspend()` and `read()` have no replacement and should be removed.
   `suspend` was a "checkpoint a long mutation" tool
   (`spec/protocol/hosts.md:65`); the coherence layer's turn atomicity
   replaced that problem, not solved it — a long mutation is now a
   sequence of committed turns.
3. Remove `FORK`/`SUSPEND`/`READ` opcodes, `scheduleFork`,
   `parkVmContinuation`, `parkReadContinuation`, `runDueTasks`, the
   `ParkedTaskRecord` family, `Repository.loadDueTasks` /
   `loadAwaitingReadTasks` / `earliestResumeAt`, `parkedTaskCounter`,
   and the `parkedTasks` plumbing through `shadow-turn-exec.ts`.
   `BUILTIN_NAMES` is append-only, so the opcode names stay reserved.
4. `spec/semantics/tasks.md` §16 is rewritten: §16.1/16.3/16.4 (states,
   cross-host RPC, kill) survive; §16.2/16.5/16.6/16.7 are replaced by a
   pointer to the scheduled-turn section. Its `status: implemented`
   header is currently false and must not stay.
5. `spec/semantics/language.md:79-80` loses the `fork`/`suspend` examples.
6. `spec/semantics/tiny-vm.md:39` ("No `suspend`, `fork`, or `read`")
   becomes unremarkable rather than a subset limitation.

This is a deletion of ~600 lines of live-looking dead code. It should land
as its own commit, before the new surface, so the diff that adds
scheduling is not tangled with the diff that removes the thing it replaces.

## 9. What catalog authors and users get

The substrate primitive is not the deliverable; these are.

**`$scheduling` feature (core catalog)** — thin wrapper making the three
shapes obvious:

```
verb :remind_in(delay_ms, text) — one-shot, durable landing (D9)
verb :start_ticking(rate_ms)    — stable-key chain, while_active (D8)
verb :stop_ticking()
verb :deadline(at_ms, verb, args) — one-shot, always, cancellable by key
```

**Deadlines in workflows.** `spec/operations/workflows.md:188` says
"after 24h, auto-cancel ... Not built-in." This makes it built-in, and the
workflow spec should gain the transition-on-deadline shape.

**Reminders in the note/tasks catalogs.** The durable-landing rule from D9
means a reminder is an act on the log, which the acts model already knows
how to project. A scheduled fire is itself a natural act type with
provenance pointing at the scheduling act — the composition lever we
already use for room content.

**Escalation timers in casework.** "Escalate if unacknowledged in 15m" is
`schedule` + `cancel_schedule` on the ack path, with a stable key per case.
This is the case-room design's missing time dimension.

**The external plugs stay, with a narrower charter.** A plug is an
*egress actuator*: it exists because a committed turn cannot make an
outbound HTTP call. Where the plug's cron is doing nothing but keeping
time, the schedule should move in-world and the plug should be woken by
the fired turn. Where the plug genuinely needs to poll an external API on
its own schedule, its cron stays. The weather plug is the second kind
today and can stay as-is; the design doc for plugs should state the test.

## 10. Rate reality check

At the D7 floor of 1s, one `always` chain per scope across a large world is
a permanent per-scope cost with no user present. D8 exists precisely to
make that impossible by default. Before implementation, the load lane
should answer: what does a scope with an armed 1s `always` chain cost per
day in DO wall-time and requests, and how many such chains can one world
carry before the AE gate moves? That number, not taste, sets whether the
default floor is 1s or 10s.

## 11. Spec edits implied

| File | Change |
|---|---|
| `spec/protocol/coherence.md` §CO16 | Add the transcript-carried producer (D1), the settled time model (D2), authority without stored progr (D3), id namespacing (D4), epoch survival (D5), no-catch-up (D6), the floor (D7), idle policy (D8), quotas (§6), lifecycle (§7). Remove the "deferred until the DSL exposes scheduling" bullet. |
| `spec/protocol/coherence.md` §CO17 | Add pending-schedule cancellation to scope retirement. |
| `spec/protocol/coherence.md` §CO3 | `schedules` / `cancellations` graduate from "target shape" to implemented; drop `caller_perms` from the referenced request type. |
| `spec/semantics/` (new or in `core.md`) | The `schedule` / `cancel_schedule` / `schedules` builtins: signature, determinism rule, namespacing, quotas, errors. |
| `spec/semantics/tasks.md` | Rewrite per §8.4; fix the false `status: implemented`. |
| `spec/semantics/language.md` | Drop `fork`/`suspend` from the examples. |
| `spec/semantics/recycle.md` | Cancel-on-recycle for a recycled target's entries. |
| `spec/protocol/v2-turn-network.md` §VTN18 | Mark superseded-by CO16 for the carried parts; the draft's VTN18.5/18.6/18.8 are corrected by D7/D5/D3 and must not read as current. |
| `spec/operations/workflows.md` | Deadline transitions stop being deferred. |
| `spec/reference/quotas.md` | Cross-reference the scope-local caps. |

## 12. Implementation phases

1. **Delete the dead path** (§8). Own commit. Tests that exercise
   `runDueTasks` go with it.
2. **Transcript arrays + scope apply.** `schedules`/`cancellations` in the
   shadow transcript and `src/net/transcript.ts`, applied atomically in
   `ScopeSequencer` alongside writes, inside `post_state_hash`. Quotas and
   id namespacing enforced at validation. Tests at the `src/net` unit lane
   and the fake-DO lane.
3. **VM builtins** (four-registry lockstep), determinism via `logicalNow`,
   per-turn call cap.
4. **Delivery envelope**: floor, idle policy, no-catch-up, fire-time
   context block, error-frame-and-drop on failure.
5. **`$scheduling` feature + one real user**: the casework escalation timer
   or the workflow deadline, end to end, with a test that fails if the
   user-visible behaviour breaks.
6. **Lanes**: workerd `smoke:net-dev` case that arms a short timer and
   observes it fire across a DO eviction; the 24h+ durability question
   from `tasks.md:50` (alarms across multi-day boundaries) is still
   unanswered and is deploy-only.

## 13. Open questions

Real forks, not rhetorical:

1. **Floor.** Is 1s the right default, or should the first release ship 10s
   and lower it once §10 has numbers? Shipping too fast is unrecoverable —
   authors build on it.
2. **`fork` removal vs. redirect.** Delete the DSL surface, or keep
   `fork(delay) target:verb(args)` as sugar over `schedule`? Sugar keeps
   LambdaMOO muscle memory; deletion keeps one obvious way.
3. **`always` chains: who may arm one?** Scope owner, wizard, or anyone
   within quota? This is the main recurring-cost lever in a big world.
4. **Reminder landing.** Should the substrate refuse `tell`-only scheduled
   verbs, or is the durable-landing rule (D9) guidance for catalog authors
   only? Enforcement is hard; silence is a bad user experience.
5. **Timezones.** "Every weekday at 9am local" needs a timezone and a
   calendar in woocode. Is that in scope for the first catalog surface, or
   does v1 ship delays and absolute times only?
