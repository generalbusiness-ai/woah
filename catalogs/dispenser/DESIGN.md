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
| `last_pushed_at`, `last_error` | unchanged plug-health state |

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

## Deliberate exclusions

- Note content and physical location retain artifact authority; the queue
  records only the allocated/delivered reference.
- Plug heartbeat and error diagnostics remain ordinary `$block` data; they are
  health signals, not queue facts.
- The base catalog has no approval, failure, TTL, or dead-letter transition.
  Those facts should be added only when a real domain policy earns them.
- Dropping a dispensed note is artifact lifecycle, not queue state.
