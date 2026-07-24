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

### D7. The minimum interval floor is 60s, not 16ms

**Decided: 60 seconds.**

VTN18.5 proposes a 16ms floor, inherited from Croquet's frame budget.
Every one of those ticks here is a **full committed turn**: a sequencer
transaction, a fanout pass, an audit record, a projection fold. The NC8
envelope is p95 ≤ 750ms for submits. 60 committed turns per second per
scope is not a rate this system has, and offering it in the DSL invites
authors to build things that cannot work.

The floor is the minimum interval between consecutive deliveries of the
same `(target, verb)` pair in a scope. A world may **raise** it via
`$server_options`; lowering it is a substrate change, not a knob. The
consequence is deliberate and should be stated plainly to authors:
**the committed plane is not for animation.** A minute is the finest grain
a durable, ordered, audited, replayable turn is offered at. Sub-minute
behaviour belongs on the live plane or in the browser, and `VTN18.10`'s
live/committed table is the guidance to keep and promote.

This also disposes of a whole class of cost question. At a 60s floor the
worst case a single armed chain can impose is 1440 committed turns per
day, which is a rate a scope reaches from ordinary conversation. §10's
load-lane question shrinks from "does this change the AE gate" to
bookkeeping.

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

**Decided: arming an `always` entry requires wizard authority.** The
periodic `always` chain — a timer that bills forever in a scope nobody
visits — is the one shape here that can cost a world real money with no
user present, so it sits behind the flag that already means "this operator
accepted the consequences". Ordinary catalog code gets `while_active`,
which is what ambient behaviour actually wants.

Two things follow that need saying:

- The common one-shot — "remind me in 10 minutes", "auto-close in 24h" —
  *is* an `always` entry by D8's default, and users are not wizards. So
  the wiz-only rule must attach to **arming an `always` entry directly**,
  not to the shapes built on it: a wizard-owned catalog verb
  (`$scheduling:remind_in`, `:deadline`) arms `always` on the caller's
  behalf under its own owner's authority, exactly as any other privileged
  verb wraps a privileged builtin. That is the normal woo pattern, and it
  puts the quota and the sanity checks in one auditable place.
- Which means the rule's real effect is: *you cannot arm an unattended
  timer without going through code a wizard wrote.* That is the intent.
  It should be spelled out that way in the spec, or the first author to
  read "wiz-only" will conclude reminders are impossible.

Per-world counting of live `always` entries is a named metric.

### D9. Fired turns are session-less actor-authority DIRECT turns

Already the implemented posture (CO16 bullet 3) and it is right. The turn
carries `{actor, target, verb, args}` and no session. Context available to
the verb: `caller = $system`, plus a `scheduled: {id, at, fired_at}` block
so the verb can tell it was woken and how late.

**Consequence worth stating loudly:** `tell(actor, ...)` is live, not
durable. A reminder that fires while its actor is disconnected is *lost*.

**Decided: the substrate does not enforce durable landing.** A scheduled
verb may `tell` into the void, and does so silently. The reasons to accept
that: the substrate cannot tell a notification from a computation, so any
enforcement would be a heuristic on verb bodies; and a scheduled turn that
*legitimately* has no output (a state advance, a lease expiry) is the
common case, so "warn on tell-only" would be noise.

The cost is real and lands on catalog authors, so the mitigation has to be
in the surface rather than the check: `$scheduling:remind_in` writes a
durable act **and** tells, in that order, so the easy path is the correct
one and an author who hand-rolls `tell` has opted out deliberately. The
builtin's spec text carries the warning. See §9.

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

fork(delay_seconds, target, verb, args...)              -> schedule_id   (sugar)
```

- **`fork` is retained as sugar** (decided). It compiles to `schedule`,
  keeping the LambdaMOO spelling that authors and the `notes/lambdamoo-*`
  reference material use. Three things are not negotiable about the sugar
  and must be documented at the call site:
  - `fork` takes **seconds**, `schedule` takes **milliseconds**. The sugar
    multiplies. Do not "harmonise" this by changing `fork` — the v1
    spelling is the whole point of keeping it.
  - `fork(1, ...)` is floored to 60s by D7, silently. A v1 author's
    instinct for `fork` is sub-second; the compile-time error or the doc
    line has to catch that instinct, because the runtime will not.
  - There is **no block form**. `fork(60) { ... }` implied a closure over
    the forking frame's locals; a scheduled entry carries values in a
    durable row, not a captured frame. The DSL as it stands compiles
    `fork(seconds, obj, verb, args...)` and never had the block form, so
    nothing is lost — but `language.md:79` shows the block form and must
    be corrected.
- `target` must be in the calling scope. Any object, not just `this`: the
  fire-time permission check is the ordinary one, so this grants nothing
  a live call would not.
- **Absolute times are UTC epoch milliseconds** (decided). No timezone
  parameter, no local-time interpretation, no calendar. `schedule_at`
  takes the same clock `now()` returns.
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

## 8. Retire the parked-task path; keep `fork` as a spelling

The v1 machinery is unreachable (§1A), unused by any catalog, and it
describes a single-host execution model this system no longer has. Leaving
it compilable is a trap: the next author to reach for a timer will find it
in `language.md:79`, use it, and ship something that silently does nothing.

What survives is the **word** `fork`, not the mechanism behind it.

Plan:

1. `fork(delay_seconds, target, verb, args...)` becomes sugar over
   `schedule` (decided; see §5). The DSL keyword stays; the `FORK` opcode
   and everything under it goes. `language.md:79`'s block form
   `fork(60) { player:tell(...) }` is corrected, not preserved — the DSL
   compiler never implemented a block form
   (`src/core/dsl-compiler.ts:1154` compiles the argument form), so the
   spec example has been wrong independently of all this.
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

**`$scheduling` feature (core catalog)** — the wrapper is not a
convenience, it is where the wiz-only rule from D8 is discharged. These
verbs are wizard-owned and arm `always` entries under their own owner's
authority on an ordinary caller's behalf:

```
verb :remind_in(delay_ms, text)   — one-shot; writes the durable act, THEN tells (D9)
verb :deadline(at_ms, verb, args) — one-shot always, cancellable by key
verb :start_ticking(rate_ms)      — stable-key chain, while_active (D8); not wiz-only
verb :stop_ticking()
verb :pending()                   — what this object has armed, for humans
```

`:remind_in` doing the durable write before the `tell` is the whole
mitigation for D9's decided silence. It should be a comment in the source,
not folklore.

**Deadlines in workflows.** `spec/operations/workflows.md:188` says
"after 24h, auto-cancel ... Not built-in." This makes it built-in, and the
workflow spec should gain the transition-on-deadline shape.

**Reminders in the note/tasks catalogs.** `:remind_in` lands an act on the
log, which the acts model already knows how to project. A scheduled fire
is itself a natural act type with provenance pointing at the scheduling
act — the composition lever we already use for room content.

**No calendars in v1** (decided). Absolute times are UTC epoch
milliseconds; there is no timezone parameter and no recurrence syntax.
"Every weekday at 9am Pacific" is a woocode function that computes the next
UTC instant and a chain that re-arms to it — buildable on day one by
whoever needs it, and it needs a timezone database this world does not
have. Note the consequence honestly: a daily chain armed at a fixed offset
will drift across DST for anyone who thinks in local time. That is the
correct place for the seam, but it should be written down rather than
discovered.

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

Settled by D7 and D8 together. At a 60s floor, the worst an armed chain can
do is 1440 committed turns per day — below the traffic a single
conversational room generates — and `always` chains, the only ones that
run unattended, are wiz-only. There is no load-lane question left to answer
before implementation; the metric that counts live `always` entries per
world is the ongoing check.

## 11. Spec edits implied

| File | Change |
|---|---|
| `spec/protocol/coherence.md` §CO16 | Add the transcript-carried producer (D1), the settled time model (D2), authority without stored progr (D3), id namespacing (D4), epoch survival (D5), no-catch-up (D6), the floor (D7), idle policy (D8), quotas (§6), lifecycle (§7). Remove the "deferred until the DSL exposes scheduling" bullet. |
| `spec/protocol/coherence.md` §CO17 | Add pending-schedule cancellation to scope retirement. |
| `spec/protocol/coherence.md` §CO3 | `schedules` / `cancellations` graduate from "target shape" to implemented; drop `caller_perms` from the referenced request type. |
| `spec/semantics/` (new or in `core.md`) | The `schedule` / `cancel_schedule` / `schedules` builtins: signature, determinism rule, namespacing, quotas, errors. |
| `spec/semantics/tasks.md` | Rewrite per §8.4; fix the false `status: implemented`. |
| `spec/semantics/language.md` | Drop `suspend`; correct the `fork` example from the never-implemented block form to the argument form, in seconds, with the floor noted. |
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
   per-turn call cap, and the `fork` sugar in `dsl-compiler.ts` — which
   lands in the same commit as the builtins it desugars to, so `fork` is
   never briefly unresolvable.
4. **Delivery envelope**: floor, idle policy, no-catch-up, fire-time
   context block, error-frame-and-drop on failure.
5. **`$scheduling` feature + one real user**: the casework escalation timer
   or the workflow deadline, end to end, with a test that fails if the
   user-visible behaviour breaks.
6. **Lanes**: workerd `smoke:net-dev` case that arms a short timer and
   observes it fire across a DO eviction; the 24h+ durability question
   from `tasks.md:50` (alarms across multi-day boundaries) is still
   unanswered and is deploy-only.

## 13. Decisions taken (2026-07-24)

The five open questions are closed:

1. **Delivery floor: 60s.** One minute is the finest grain the committed
   plane offers. Worlds may raise it; lowering is a substrate change.
   (D7 rewritten.)
2. **`fork` stays as sugar** over `schedule`, seconds-denominated, no block
   form. The parked-task mechanism underneath it is still deleted. (§5, §8.)
3. **`always` entries are wizard-only to arm directly**; user-facing
   one-shots reach them through wizard-owned `$scheduling` verbs. (D8.)
4. **No substrate enforcement of durable landing** — a scheduled `tell` into
   the void is silent. Mitigated in the catalog surface, not the engine.
   (D9, §9.)
5. **UTC epoch milliseconds and delays only.** No timezones, no calendars,
   no recurrence syntax in v1; DST drift for local-time chains is a known
   and documented consequence. (§5, §9.)

Nothing here blocks the spec edits in §11.

## 14. Still unanswered (not blocking)

- **Multi-day alarm durability.** `tasks.md:50`'s open question — that
  alarms set across multi-day boundaries fire reliably and that hibernated
  state is fully reconstructible from durable storage alone — has never
  been tested, and the workerd lane cannot answer it (`AGENTS.md`:
  fidelity is a ladder). It is deploy-only, and the 365-day horizon in §6
  rests on it. First real `always` deadline in production is the test.
- **Planner failover.** CO16 addresses one deterministically-chosen planner
  and calls multi-planner election out of scope; a scope whose planner is
  persistently down abandons its outbox lane, which is the named
  divergence. Scheduled turns make that path load-bearing for the first
  time — abandonment now means "the deadline silently never fired".
  Worth a metric and an alert before the first `always` user ships.
