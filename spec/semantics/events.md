---
date: 2026-05-02
status: implemented
---

# Events and schemas

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.
>
> **Terminology note.** `core.md` calls these *observations* (to distinguish from messages and mutations). This document calls them *events* — same concept, different name. The distinction `core.md` draws (message → mutation → observation) is real and useful; we use "event" here because the API and wire surface (`emit`, `op: "event"`, `event_schema`) named it that way first. Treat the terms as synonyms.

Covers `emit` semantics, event reception via `:on_<type>`, and per-object event-type schema declaration.

---

## 12. Events and messaging

### 12.1 Primitive

```
emit(target, event)
```

- `target`: an `obj`, a `list` of objs, or the result of an audience builder (`$audience.in(room)`, etc.).
- `event`: a `map` with at least a `type: str` field. Other fields per-schema.

Delivery is fire-and-forget. `emit` does not return a value; failures (target not reachable) become events on a dead-letter object owned by the emitter, so wizards can audit.

### 12.2 Reception

An object receives events via verbs whose names match `:on_<type>` or generic `:on_event`. Dispatch:

1. Look up `:on_<type>` on the target. If found, call with `(event)`.
2. Else look up `:on_event`. Call with `(event)`.
3. Else silently drop.

Receiver verbs are dispatched as forked tasks (not joined to the emitter's task) so emit is asynchronous from the emitter's view.

### 12.3 Sticky vs transient targets

`emit` to a persistent obj routes to that DO. To a transient ref, routes through the host player DO over the websocket. Cross-host event delivery is just a verb call across hosts.

### 12.4 Strings as degenerate events

`tell(player, s...)` and `$player:tell(s...)` are shorthand for:

```
emit(player, { type: "text", body: join(s), target: player, source: caller });
```

LambdaCore-style `:announce_all`, `:announce_all_but` are ordinary room
verbs, not core event primitives. The bundled `$room` catalog implements them
by iterating room subscribers and calling `tell(listener, text)`.

### 12.5 Ordering

Events emitted by a single task are delivered in emit order to each target. Events from different tasks have no guaranteed ordering relative to each other.

### 12.6 Observation durability follows invocation route

Observation durability is not a per-event flag. It is determined by the **invocation route** of the verb that called `emit`. There is one `emit` primitive; its delivery contract is read from the call context.

- **`emit` during a `$space:call`.** Observations are captured into the resulting `applied` frame's `observations` list ([space.md §S2](space.md#s2-the-call-lifecycle) step 9). Replay-visible because the sequenced call itself is replay-visible — replaying the message re-runs the verb body and re-emits the observation, or an implementation may persist/cache applied frames as an optimization. Audit-visible as part of the applied result. The observation is not a separate event-log entry and has no independent seq.
- **`emit` during a direct call.** Observations are pushed live to the targeted session audience and not stored anywhere. No seq, no replay, no gap recovery. If a recipient session wasn't connected when the call happened, the observation is lost.

Same opcode, same emit shape, two delivery contracts — but the contract is an automatic consequence of where the emit ran, not a flag the author sets.

> **Schemas describe shape, not durability.** A schema (§13) is advisory typing; it does not pick the delivery contract. To make an observation durable, route the call that emits it through `$space:call`. To keep it live-only, call directly.

**The bad pattern this rules out.** A sequenced state mutation that also emits transient side-chatter is mixing two routes in one body. Don't piggyback typing indicators on `:set_status`; emit them from a separate `:typing` direct call. The discipline keeps "what gets logged" predictable from the call site alone.

**Delivery policy for live (direct-call) observations.** These are best-effort by construction:

- Per-source rate limit (default 60 obs/sec per `(source, type)`); excess dropped at the emitter's host before fanout.
- Receiver-side coalescing by `(source, type)`: queued observations with the same key may collapse to the latest before delivery.
- TTL: observations older than ~1 second on receipt are dropped.
- Drop-oldest under backpressure; live observations are silently dropped (no `system_overflow` notification). Sequenced applied frames queue normally.
- Recommended payload < 1 KiB; hard cap 4 KiB.
- Required `source: obj` (so receivers can index for coalescing) and `type: str`. A `seq` field on a live observation is rejected at emit time with `E_INVARG` — `seq` belongs to applied frames only.

**Receiver discipline.**

- Handlers for live observations should be side-effect-free: no `SET_PROP` on persistent state, no `emit` of would-be-sequenced observations, no `FORK`/`SUSPEND`. Violating this leaks non-replayable mutations into persistent state — the same anti-pattern as a log-handler that mutates behind the log's back.
- Receivers should not persist live observations. Doing so makes a non-replayable observation durable; reload won't reproduce it.

### 12.7 Observation audience and direct-message routing

Live observations (from direct calls, §12.6) are not broadcast to *every* subscriber of the audience space; they're routed by an **audience set** computed per-observation by the runtime that emitted them. Wire transports (WS, REST/SSE, internal RPC fan-out) honor this set to filter their pushes; receivers don't see observations they're not in the audience for.

A direct-call result carries two optional fields alongside `observations`:

```
{
    result, observations,
    audience_actors:        [actor, ...],     // union of all per-observation audiences
    observation_audiences:  [[actor, ...], ...], // one entry per observation, parallel array
    audience_sessions:     [session, ...],
    observation_session_audiences: [[session, ...], ...]
  }
  ```

These are advisory hints to transports. If the session fields are present,
session-scoped transports filter by session first; this is what keeps two tabs
for the same actor in different spaces from receiving each other's room events.
If only actor fields are present, transports filter by actor. If absent, a
transport falls back to the original presence-based filter ("push to anyone with
presence in the audience space").

**How the audience is computed.** For each observation:

1. **Self-addressed.** If the observation is `looked` or `who` and has a `to: obj` field, the audience is `[to]`. (The look's structured payload is for the looker; bystanders don't see another player's look output.)
2. **Directed.** If the observation's `type` appears in the canonical *directed observation type set* (§12.7.1), the audience is `[to, from]` (whichever are present and are valid object refs). The `told`/`whisper`/`page` family is the v1 use.
3. **Self-suppressing.** If the observation is `entered`, `left`, `taken`, or `dropped` and has an `actor: obj` field, the audience is everyone with presence in the source/audience space *except* that actor — the actor's own command output is delivered through the call result or a `text` observation; the room broadcasts to bystanders.
4. **Default.** Otherwise the audience is everyone with presence in the audience space (the source space if `observation.source` is a `$space` descendant, else the call's space argument).

#### 12.7.1 Directed observation types (v1)

The set of types treated as direct messages is **closed and explicit** in v1 — adding to it is a spec change, not a per-catalog choice:

| Type | Routing fields | Meaning |
|---|---|---|
| `told` | `to`, `from` | Whisper / private message from one actor to another (the LambdaCore `:tell` shape). |
| `text` | `target` (recipient only — no echo to `actor`) | The substrate `tell()` primitive's emission. Targeted text delivered straight to one player's connection — independent of whether the calling verb has a space audience. Required so verbs running off any `$space` (e.g. `$portable:give`, `$player:inventory` invoked on a player) still reach their recipient. The `actor` field carries the sender for display, not for routing; verbs that want the sender to also see the line emit their own `tell(actor, …)` (the `:give` / `:take` / `:drop` pattern). |

Future additions (`whispered`, `paged`, `pm`) require a spec amendment so all transports update in lockstep. Catalogs that want directed semantics for a non-listed type today should set `to`/`from` and use the `told` type; otherwise the observation broadcasts to the audience space's full session audience.

> **Sequenced-call caveat (v1).** Directed observations are routed to recipients only when they flow through a *direct* call's live-event broadcast path. Observations embedded in an `applied` frame from a sequenced call are broadcast to the space's audience as a unit, so a directed observation inside one would leak to the full room session audience. In practice no v1 catalog verb emits directed observations (`text`, `told`) inside a sequenced call — all `tell()`-style chat affordances (`:take`, `:drop`, `:give`, `:inventory`, `:home`, `:set_description`) are direct. New sequenced verbs that need directed text should `dispatch(target, "tell", [text])` rather than emit `text` observations themselves; if a future feature requires both sequencing *and* directed observations, the broadcast layer needs a separate filter to split directed observations out of the applied frame before fan-out.

#### 12.7.2 Receiver behavior

The audience fields are **filtering hints**, not authority claims. Transports use
them to avoid pushing irrelevant observations; permission checks (verb-x at
emit, read perms at observe) still run independently. A misbehaving runtime that
omitted these fields would over-broadcast but not leak privileged data —
emit-time perms already gate what gets observed in the first place.

### 12.8 Sequenced calls with gap recovery

The pattern an event-sourced object uses to give observing sessions a totally-ordered stream they can replay over. See [space.md](space.md) for the full normative behavior of `$space:call`; this section is the *consumer-facing* sequencing pattern.

**Producer side** (the object that owns the log):

```
verb $space:call(message) {
  this.next_seq = this.next_seq + 1;
  let seq = this.next_seq;
  // append to log + apply to materialized state (omitted)
  // host fans out the applied frame to this.session_subscribers
  return seq;
}

verb $space:replay(from_seq, limit) rxd {
  // returns up to `limit` messages with seq >= from_seq, paged
  let upper = min(this.next_seq, from_seq + limit - 1);
  return {
    messages: list_slice(this.log, from_seq, upper),
    next_seq: upper + 1,
    has_more: upper < this.next_seq
  };
}
```

**Consumer side** (each subscriber):

```
// kept on the subscriber: last_seq starts at 0
verb player:on_applied(event) {
  if (event.seq == this.last_seq + 1) {
    this.last_seq = event.seq;
    this:render(event);
  } else if (event.seq > this.last_seq + 1) {
    // gap detected; page through replay
    let from = this.last_seq + 1;
    while (true) {
      let r = event.source:replay(from, 100);
      for m in r.messages { this:render(m); }
      if (!r.has_more) break;
      from = r.next_seq;
    }
    this.last_seq = event.seq;
  }
  // event.seq <= last_seq is a stale duplicate; ignore.
}
```

This composes existing `emit`, properties, and verbs — no new primitive. Named here because every event-sourced object in woo will use this shape, and tooling can recognize the convention.

Snapshots compose with replay: a periodic `$space:snapshot()` writes the materialized state plus the seq it represents; reload is `load_snapshot() + replay(from: snapshot_seq + 1, limit)`.

If a subscriber's gap is unbounded (its `last_seq` is older than the oldest snapshot, or paging would take longer than reloading), it should drop its materialized state, fetch the latest snapshot, and resume tail replay from the snapshot's seq. Reasonable threshold: if the gap exceeds twice the snapshot interval, reload.

Live observations from direct calls (§12.6) are explicitly *not* sequenced — they carry no `seq` field and have no replay path. The applied-frame replay loop above is for sequenced `$space:call` traffic only.

---

## 13. Schemas

Objects may declare event schemas:

```
declare_event #room "say" {
  source: obj,
  body: str,
  body_to_self?: str
};

declare_event $space "cursor" {
  source: obj,
  x: float,
  y: float
};
```

This is sugar for storing a JSON-Schema-shaped map under the `event_schema` table on the declaring object.

Schemas describe **shape only** — required fields, field types, optional fields. They do not pick a delivery contract; durability is determined by the invocation route (§12.6), not by the schema.

Schemas are **advisory in v1**: introspectable (`event_schema(obj, type)` builtin) but not enforced at `emit` time. Tooling and agents use them to construct valid events. Phase-2 may add enforcement as an opt-in flag.

Inheritance: schemas declared on an ancestor are visible to descendants (chain walk). Descendants may *extend* (add optional fields) but not *redefine* (change required field types).

Base objects ship a small core schema set — `text`, `say`, `emote`, `enter`, `leave`, `look`, `take`, `drop`, `cursor`, `presence:hover`, `presence:idle`. Whether any of these reach a subscriber as part of an applied frame or as a live observation depends on whether the verb that emitted it was sequenced. New event types are open-world; objects don't have to declare a schema to emit one.

### 13.1 Movement observation vocabulary is per-catalog

Movement is the canonical example of catalog-extensible observation
vocabulary. **The substrate does not guarantee a uniform shape for
"the actor moved" events**; what comes out depends on the verb the
catalog chose to invoke.

Three observed shapes from the bundled catalogs:

| Verb path | Observations |
|---|---|
| `the_chatroom:southeast → the_deck` | `left`, `entered` (chat catalog's room/exit baseline). |
| `the_deck:east → the_hot_tub` | `text`, `left`, `entered` — exits may add flavor text via an extra `text` observation alongside the standard pair. |
| actor `moveto(the_dubspace)` | `dubspace_entered`, `dubspace_activity` — catalog-specific types because dubspace entry has its own semantics (presence-derived control authority, mount-room announcement). |

Clients MUST treat the movement observation surface as open: catalogs
can introduce new types and extra observations, and the same logical
event ("actor changed scope") can produce different observation
sequences depending on whose verb composed the move. The `left`/
`entered` core schemas (§13 list above) describe the *common* fields
that bundled rooms emit, but catalogs are free to additionally emit
their own typed observations from `:enter`, `:leave`, `:moveto`, or
exit verbs as long as they declare the schemas. Clients that need a
single canonical "moved" event should derive it themselves from
`session.active_scope` rather than relying on a fixed observation
type — see [identity.md](identity.md) for the session-state model.
