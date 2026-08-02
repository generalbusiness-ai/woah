# Dispenser design

## Purpose

Dispenser is the asynchronous “ticket, external work, artifact” pattern:

1. `order(request)` durably accepts bounded work and returns immediately.
2. An apikey-authenticated plug polls `next_pending()`.
3. The plug performs external work, fills the allocated artifact, then calls
   `deliver(...)` or `cancel(...)`.
4. Delivery places a `$dispensed_note` in the requester’s inventory.

A durable queue makes wakeups advisory. A missed hint or cold plug delays work;
it does not lose it.

## Authority

`order`, `deliver`, and `cancel` are the only queue-fact writers. They execute
on the block, but the block is an anchored actor: its containing room owns the
sequenced log. A queue mutation therefore requires:

```text
seq >= 1
space == location(block)
caller == block for the internal Act primitive
```

The plug invokes typed verbs; it never receives a raw Act or fold capability.
All helpers and projection operations omit public execute permission and check
their internal caller. Once genesis binds the projection, cross-space movement
is refused: queue relocation needs a future explicit two-authority migration.

The fixed fact vocabulary is:

```text
dispenser.genesis        {next_order_seq}
dispenser.legacy_ordered {order_id, requester, request, artifact}
dispenser.ordered        {order_id, request, artifact}
dispenser.delivered      {order_id, note}
dispenser.canceled       {order_id}
```

Composer source distinguishes several Dispensers on one room log. A normal
order’s requester comes from the log-envelope actor. The legacy form alone
carries `requester`, because a migration turn’s actor is not the historical
requester. Room, sequence, actor, timestamp, and invoked verb are never copied
into a normal payload.
`order` preallocates one empty room-anchored `$dispensed_note` and records its
reference as `artifact`. The authenticated plug fills that exact note through
direct `prepare_artifact`; `deliver(order_id, artifact)` sequences only the
reference. Generated name, description, and text therefore remain on the note
and never enter the room transcript or an Act.

## Projection

`$dispenser_queue < $projection` is the sole writer of:

- pending rows and their FIFO order;
- the next order and queue counters;
- block and per-requester admission sequence indexes; and
- terminal delivery/cancellation receipts.

The fold has no clock or foreign reads. It stores envelope sequence numbers;
admission and `next_pending` resolve the corresponding authority timestamp
from the room log when needed. Its only scans are over explicitly capped maps.

Hard bounds are part of the contract, not configuration defaults:

| State | Cap | Overflow |
|---|---:|---|
| pending rows | 50 | refuse `E_QUEUE_FULL` / `E_QUOTA` |
| inline request | 200 chars | refuse `E_INVARG` |
| artifact name / description / body | 256 / 4,096 / 262,144 chars | refuse `E_INVARG` |
| requester index | 50 | deterministic oldest-seq/key eviction |
| terminal receipts | 50 | deterministic oldest-seq/key eviction |

Owner settings can impose smaller limits. Zero selects the hard ceiling.

The v0 fields have one explicit disposition:

| v0 field | v1 authority |
|---|---|
| `pending_orders` | projection `rows` |
| `next_order_seq` | projection `next_order_seq` |
| `last_request_at` | capped `requester_index` of Act sequences |
| `last_order_at` | projection `last_order_seq` |
| row `ts` | owning room-log envelope timestamp |
| inherited plug lifecycle fields | unchanged external-health state |

## Atomicity and retry

Order allocates the note before emitting its Act. Delivery moves that note
before emitting its terminal Act. In either operation, schema validation,
every fold, artifact lifecycle, and log append share the outer behavior
savepoint. Any error must escape; nothing catches fold or lifecycle failures.

Artifact preparation is deliberately a direct object-authority write, not a
queue fact. It accepts only the block actor or wizard, validates the queued
order’s exact preallocated reference, and is one-shot. A retry returns the
same note without replacing its content. A pending artifact refuses movement
except from its producing block.

There are two idempotency layers:

- Net’s stable key proves a dropped-reply retry commits the turn at most once.
  A replay is marked `replayed` and may omit the application result because the
  gateway cannot prove its new plan reproduced the original output.
- The projection’s terminal receipt is the domain result. A later fresh-key
  retry returns the original note reference with `duplicate: true`.

`prepare_artifact` also has domain idempotency: after a lost direct reply, a
fresh-key retry returns the already-prepared reference. The stable key is
reserved for the sequenced `deliver`, whose single commit matters to the log.

The receipt is bounded. After deterministic eviction, the honest answer is
`unknown`; the system never guesses or creates a replacement for an already
terminal order.

## Legacy genesis

The v0 catalog stored `pending_orders`, `next_order_seq`,
`last_request_at`, and `last_order_at` directly on the block. The v1 migration
renames them to private inputs. On the first sequenced mutation, one fail-closed
turn:

1. creates and binds the projection;
2. emits `dispenser.genesis` with the preserved counter;
3. preallocates one empty artifact and emits one
   `dispenser.legacy_ordered` per pending row, in list order;
4. performs the requested v1 mutation; and
5. clears the inputs and marks genesis complete.

Until then, read-only plug/status operations may inspect the legacy queue.
Historical rate-limit timestamps expire deliberately: preserving them would
copy wall-clock policy state into the new fold without a corresponding fact.

The new bounded contract cannot silently absorb formerly unbounded data.
Cutover refuses atomically if a legacy queue exceeds 50 rows or a request
exceeds 200 characters. Operator repair is explicit; truncation and
behind-the-fold seeding are forbidden.

The 50-row/200-character ceiling is also a wire bound, not an arbitrary
product default. A Net regression fills all 50 rows, then cancels all 50 into
terminal receipts, and asserts every production-shaped envelope remains below
64 KiB; the saturated order measured about 48.3 KiB in the proof lane.

Rebuild starts from declared empty state and reproduces rows, counters,
indexes, receipts, genesis status, and `at_seq` from recorded observations.
Composer source filters Acts for another Dispenser on the same room log.

## Coverage

`tests/dispenser-acts.test.ts` proves the queue contract (emission authority,
fail-closed folds, dropped-reply idempotency, legacy genesis, rebuild,
eviction, caps). The shared walkthrough (`scripts/smoke/scenario.ts`, run by
the workerd and deployed lanes) drives the cross-actor half on
`the_horoscope`: a sequenced `order` whose recorded fact reaches a co-present
peer, an ordinary actor's `next_pending` refused `E_PERM`, and a terminal
disposition whose fact reaches the peer. On fresh-world lanes the step is
strict (queued `status` read, then `cancel`). On the deployed lane the
production plug is a live competing consumer of the same queue — `:order`
sends it a synchronous wakeup — so the step cancels immediately after
ordering and accepts a settled race: the pre-Acts page deletes the pending
row both for plug delivery and for plug cancel (its `prepare_artifact`
E_VERBNFs there), so an ambiguous cancel reply accepts either terminal fact
and learns the outcome from whichever arrives. Cleanup is best-effort by
construction with the residual named: `finally` runs signal-free (a fired
watchdog aborts assertions, not cleanup), recovers a lost order id from the
ordered fact's unique request string when the reply timed out after a
server-side commit, cancels when no terminal reply was observed, and
disperses a race-delivered note via a literal-`#id` drop. The irreducible
residual — the smoke process dying mid-window — is at most one order, which
the live plug itself settles within its poll interval. The
walkthrough accepts both rolling-contract observation shapes (v1 Act envelope
and the pre-Acts flat `order_placed`/`canceled`/`delivered`) because a runtime
deploy does not rewrite an installed world's catalog pages. The plug's deliver
half is deliberately absent from the walkthrough — those verbs accept only the
block actor or a wizard, and the walkthrough's job is to prove they refuse
ordinary credentials.

`tests/worker/net-outliner-converge.test.ts` also models the pre-Acts authority
topology directly: the anchored block writes only cluster-owned state while its
recorded fact retains the room call-space audience. The gateway regression and
the affected-owner shell regression in `tests/worker/net-relations.test.ts`
prove that this observations-only event is durably handed to the room owner,
refanned to room subscribers, and deduplicated on source redelivery. Both run
in the guarded Acts release gate; the guarded deploy additionally runs the
shared MCP walkthrough against real workerd before building.

## Deliberate exclusions

- Note content and physical location retain artifact authority; the queue
  records only the allocated/delivered reference.
- Plug attempt, heartbeat, and error diagnostics remain ordinary `$block`
  lifecycle data; they are health signals, not queue facts.
- The base catalog has no approval, failure, TTL, or dead-letter transition.
  Those facts should be added only when a real domain policy earns them.
- Dropping a dispensed note is artifact lifecycle, not queue state.
