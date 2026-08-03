# Plug-driven blocks

> Status: **implemented** by `catalogs/block` v0.2 and its bundled weather
> and horoscope descendants.

This specification defines the operational-health contract shared by anchored
`$block` appliances. Domain payloads remain subclass-owned; the base catalog
standardizes how a scheduled or disconnected plug reports whether those
payloads are being refreshed.

## BL1. Durable lifecycle facts

Every `$block` exposes these public-read properties:

| Property | Meaning |
|---|---|
| `last_attempt_at` | Epoch milliseconds when the latest plug run began. |
| `last_pushed_at` | Epoch milliseconds of the latest successful lifecycle write. |
| `last_failure_at` | Epoch milliseconds of the latest recorded failure; retained across recovery for diagnosis. |
| `consecutive_failures` | Failures since the latest recorded success. |
| `last_error` | Latest failure text, or `null` after recovery. |
| `plug_expected_interval_ms` | Declared normal cadence; `0` means unspecified. |
| `plug_stale_after_ms` | Freshness window; `0` disables automatic stale classification. |

The lifecycle fields are part of the conventional `writable_self` tier. A
subclass that overrides `writable_self` MUST repeat all five mutable lifecycle
names before adding its domain properties. Cadence and the human-facing
`plug_label` are class metadata, not plug-writable state.

## BL2. Derived status

`:plug_status()` is public-read, direct-callable, and tool-exposed. It derives
status at read time so a block can become stale without a timer mutating it.
Its result includes `state`, `message`, all lifecycle timestamps, `age_ms`,
both cadence fields, `consecutive_failures`, and `last_error`.

Absent a subclass hint, state precedence is:

1. `error` when `consecutive_failures > 0` or `last_error` is non-null;
2. `pending` when an attempt exists but no success exists;
3. `never` when neither an attempt nor a success exists;
4. `stale` when a success exists and its age exceeds a positive
   `plug_stale_after_ms`;
5. `healthy` otherwise.

Clock skew MUST NOT produce a negative `age_ms`; negative ages clamp to zero.
`:plug_last_success_at()` defaults to `last_pushed_at`. A subclass MAY override
it only to preserve a well-defined historical success timestamp. Weather uses
the observation time in a legacy reading when older worlds have no heartbeat.

`:plug_status_hint()` defaults to `null`. A subclass MAY return
`{state, message}` for domain configuration states that take precedence over
the generic derivation. The hint is for state interpretation, not a second set
of lifecycle counters.

## BL3. Atomic recording boundary

Only the block actor (the apikey-bound plug) or a wizard may call:

- `:record_plug_attempt(at?)` — records attempt start before external work;
- `:record_plug_success(values, at?)` — atomically writes the subclass payload
  plus attempt/success timestamps, clears the error, and resets failures;
- `:record_plug_failure(error_text, values, at?)` — atomically writes optional
  subclass error state plus attempt/failure timestamps, error text, and an
  incremented failure count.

`values` passes through the ordinary per-property writability gate before any
field changes. The lifecycle verb injects its reserved metadata after receiving
the map, so a plug cannot accidentally publish a payload paired with contrary
health facts. Plugs SHOULD call `record_plug_attempt` before configuration,
queue, or upstream I/O and finish with exactly one success or failure call when
the session remains usable.

## BL4. Transition-only room observations

A lifecycle write compares the derived state before and after mutation. When
the state changes and the block is in a `$space`, it emits:

```text
{ type: "plug_status_changed", block, from, to, text, ts }
```

Repeated attempts in `pending`, repeated failures in `error`, and ordinary
healthy heartbeats MUST NOT emit another status-change observation. The block
catalog owns the chat formatter, which renders the supplied `text` as a system
line. Per-property `block_data` observations remain available to structured
consumers and are not themselves health-transition messages.

Time-driven `healthy → stale` has no mutation at which to emit. It is reported
by the next `:look_self()` or `:plug_status()` read; a future scheduler-based
alert may add proactive stale notification without changing the state contract.

## BL5. Look surface

Base `:look_self()` includes the full `plug_status` result and appends its
message to the appliance description. Subclass look surfaces MUST include the
same structured key even when they retain legacy fields such as `connected`.
This makes in-world prose, browser clients, and MCP callers agree on one health
vocabulary.

## BL6. Distribution and recovery

Lifecycle state is ordinary block-owned state and follows the same Net turn,
authority, and persistence rules as the domain payload. There is no global plug
registry or global enumeration requirement. A gateway observation can be
missed; recovery is an exact read of the block's durable properties and a fresh
`:plug_status()` derivation.
