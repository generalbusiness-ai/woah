---
date: 2026-04-30
status: implemented
---

# Wire protocol

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**.

The JSON message format on the WebSocket between client and player host. Baseline scope: enough frames to drive a sequenced message dispatch loop, direct live interactions, durable task input, and their observations.

Browser bootstrap details (transient host installation, host-to-host RPC) are in [browser-host.md](browser-host.md). Cross-world federation frames are in [../deferred/federation.md §24](../deferred/federation.md#24-federation).

---

## 17. Wire protocol

WebSockets between client and player host. JSON frames. UTF-8. Values are encoded per [../semantics/values.md §V2](../semantics/values.md#v2-canonical-json-encoding).

### 17.1 Client → server

```ts
// Establish session.
// cursor is optional scoped-projection resume metadata from /api/me.
{ op: "auth", token: string, cursor?: ProjectionCursor }

// Make a sequenced call through a space.
//   id        — client-chosen correlation token; echoed in the reply
//   space     — the $space whose seq this call advances
//   message   — message map: { actor, target, verb, args, body? }
{ op: "call", id: string, space: ObjRef, message: Map }

// Make a direct call, not through a space.
// Allowed only for verbs annotated direct_callable:true; see core.md §C12.2.
// Live observations emitted by the verb are delivered as op:"event" frames.
//   id      — client-chosen correlation token; echoed in result/error
//   target  — object receiving the verb
//   verb    — verb name
//   args    — positional args
{ op: "direct", id: string, target: ObjRef, verb: string, args: Value[] }

// Execute natural-language text against a command surface.
// The server plans the command, then executes the resolved verb as direct or
// sequenced according to the resolved verb metadata. Direct command results
// return op:"result"; sequenced command results return op:"applied".
//   id      — client-chosen correlation token; echoed in result/error/applied
//   space   — active $space command surface
//   text    — text exactly as typed by the actor
{ op: "command", id: string, space: ObjRef, text: string }

The bound actor MUST be present in `space`; otherwise the host returns
`op:"error"` with `E_PERM` before planning. Command planning and execution
complete in one host task when the resolved target is on the planning host. In
distributed routing, the gateway may plan on one host and dispatch on another;
that cross-host plan→dispatch boundary is not atomic.

// Deliver input to the oldest task awaiting READ for this actor.
// Space-owned continuations resume as an applied $resume frame.
{ op: "input", id?: string, value: Value }

// Heartbeat. Clients should send this periodically while idle so transport
// failures are detected promptly; active attached sessions do not time out
// solely because no calls are being made.
{ op: "ping" }
```

That is the entire baseline plus durable-task client→server surface.

Reserved for transient hosts (see [browser-host.md](browser-host.md)):

```ts
{ op: "host_return", correlation_id: string, result: Value }
{ op: "host_raise",  correlation_id: string, error: ErrValue }
```

### 17.2 Server → client

```ts
// Session established; the client is bound to this actor.
// The client stores session and presents it as session:<id> on reconnect.
// resumed:false means the server did not use the supplied cursor and the
// client must hydrate from /api/me before replaying from the returned cursor.
{ op: "session", actor: ObjRef, session: string, resumed?: boolean }

// A sequenced call has been applied. Carries the canonical seq and any
// observations emitted during apply. Replayable: the same frame is reproduced
// by `space:replay`. Authoritative for state.
//   id            — present iff this client originated the call
//   space         — the $space that sequenced
//   seq           — assigned sequence number
//   message       — the message that was applied
//   observations  — list of observation maps emitted during apply (durable)
//   result        — verb return value; present only for the originating client
{ op: "applied", id?: string, space: ObjRef, seq: int, message: Map, observations: Map[], result?: Value }

// A direct call completed. Any observations emitted by that call are delivered
// separately as op:"event" frames to the call's live audience.
//   id      — matches the originating op:"direct" or direct op:"command"
//   result  — verb return value
//   command — optional resolved command descriptor for direct op:"command";
//             clients may use it for UI reactions, not for dispatch.
{ op: "result", id: string, result: Value, command?: Map }

// A live observation from a direct (non-sequenced) verb call. Not stored
// anywhere; not replayable; gone after delivery. See semantics/events.md §12.6.
//   source       — the object whose verb emitted (per observation shape)
//   observation  — the observation map ({type, source, ...})
{ op: "event", observation: Map }

// A call could not be applied, or a system error occurred.
//   id    — present iff associated with a specific call
//   error — err value per V7
{ op: "error", id?: string, error: ErrValue }

// Input was accepted or ignored without producing an applied frame.
// Space-owned READ resumes normally produce op:"applied" instead.
{ op: "input", id?: string, accepted: bool, task?: string, observations?: Map[] }

// Heartbeat.
{ op: "pong" }
```

That is the entire baseline plus durable-task server→client surface.

Reserved for transient hosts:

```ts
{ op: "host_install",   id: TRef, parent: ObjRef, bytecode: Bytecode, props: Map }
{ op: "host_uninstall", id: TRef }
{ op: "host_call",      correlation_id: string, target: TRef, verb: string, args: Value[], frame: Frame }
```

### 17.3 Framing

One JSON object per WebSocket message. No binary frames in v1.

### 17.3.1 Audience for live `event` frames

Direct-call results carry a per-observation audience, computed by the runtime that emitted them. The mechanism is normative in [../semantics/events.md §12.7](../semantics/events.md#127-observation-audience-and-direct-message-routing); the wire-level shape is:

- The REST/RPC `result` envelope for a direct call optionally includes `audience_actors: [actor, ...]` (the union audience for all observations), `observation_audiences: [[actor, ...], ...]` (one entry per observation, parallel to `observations`), `audience_sessions: [session, ...]`, and `observation_session_audiences: [[session, ...], ...]`.
- The host that fans out to attached WebSockets uses `observation_session_audiences[i]` first when present, then `audience_sessions`, then `observation_audiences[i]`, then `audience_actors`, to filter the `op: "event"` push for observation `i`. If absent, it falls back to "push to sessions present in the audience space."
- Directed observations (currently only `told`, per events.md §12.7.1) are routed by `to`/`from` even when `observation_audiences` is missing — this is the legacy fallback path.

Browsers do not see audience fields directly on pushed `event` frames; the host has already filtered. They appear in REST/RPC responses for clients that want to know who would have received each observation.

### 17.4 The `applied` push model

When an actor is connected, the player host sends `applied` frames for every sequenced call applied to spaces the actor is observing — including calls the actor itself originated.

- For the originator, `id` matches the `op: "call"` they sent. The frame may
  also carry `result`, the invoked verb's return value. They use this to pair
  the reply with their pending call, apply caller-scoped results such as
  `result.here`, run any reconcile logic (§17.6), and discard the optimistic
  prediction. The originator receives this frame even if the call changes their
  post-apply presence so they are no longer in the source space audience.
- For other observers, `id` and `result` are absent. They consume the applied
  frame as a state-update event.

There is no separate subscribe/unsubscribe frame in the baseline wire. Membership in a space (which determines whether the host pushes its `applied` stream to a given client) is a server-side decision driven by the session's relationship to the space — typically session presence (`session_subscribers`) or explicit ownership.

If a client's connection is interrupted and reconnects, gap recovery follows the pattern in [../semantics/events.md §12.8](../semantics/events.md#128-sequenced-calls-with-gap-recovery): the client tracks the highest `seq` per space it has applied, calls `space:replay(from, limit)` to backfill, then resumes the live stream.

**Idempotent retry.** The `id` field on `op: "call"` is a client-chosen correlation token. If a client retries a call with the same `id` (e.g., after a transient network failure or reconnect), the host returns the **same** `applied` frame — same `seq`, same `message`, same `observations`. No new sequence number is allocated; the call is not re-executed. This piggybacks on the host's correlation-id idempotency cache (see [hosts.md §3.4](hosts.md#34-host-rpc-invariants)), default TTL ~5 minutes. Beyond the TTL, the host has no memory of the original call and a retry would create a duplicate; clients should treat the cache as best-effort and rely on gap recovery (above) as the durable continuity mechanism.

### 17.5 Backpressure and rate limiting

**Outbound**: each player host maintains a bounded outbound queue (default 1024 frames). On overflow:
- `applied` frames are preserved (durable; the client treats loss as a gap and uses replay to recover) — when the queue is full of mostly-applied frames, the player receives an `error` frame with code `E_OVERFLOW` and a count of dropped frames.
- `event` frames (live observations) are dropped silently on backpressure — they have no replay path, and signaling overflow for them just adds noise. The receive-side coalescing rules in [events.md §12.6](../semantics/events.md#126-observation-durability-follows-invocation-route) keep this lossy delivery the contract.

**Inbound**: each WebSocket has a per-connection rate limit (default 50 ops/sec sustained, burst 100). Excess input frames are dropped with `error` (no `id`), code `E_RATE`. This protects the player host from a misbehaving or malicious client saturating its host's request budget.

Both limits are configurable per-world via `$server_options.connection_*`.

### 17.6 Optimistic local update + reconcile

Recommended UI pattern for low-latency interactive state (e.g., dragging a knob in the dubspace).

A client predicting the outcome of a sequenced call may apply the change locally *before* receiving the canonical `applied`:

1. User drags a knob to value V.
2. Client UI applies V locally and renders immediately.
3. Client sends `{op: "call", id, space, message}`.
4. When the corresponding `applied` arrives:
   - If the materialized value matches the optimistic prediction, do nothing (the prediction was right).
   - If it differs (a concurrent call won the race), snap the UI to the canonical value.

Pattern is purely client-side; the protocol does not need a special opcode for it. Mentioned here because it is the recommended way to keep gesture latency invisible without adding latency-hiding primitives to the wire format.

Optimistic prediction must be paired with sequenced calls and gap recovery — otherwise a missed `applied` frame leaves the UI showing a stale prediction indefinitely.

### 17.7 World-to-world variant (reserved)

Cross-world calls use a separate wire variant — HTTPS POST origin-to-origin, not WebSocket — specified in [../deferred/federation.md §24](../deferred/federation.md#24-federation). v1 implements neither an inbound peer endpoint nor an outbound peer client; the `origin` and `signature` reservations on the message and applied envelopes are documented in federation.md so the wire is forward-compatible.

### 17.8 Frames not in the baseline wire

The following frames may exist in later iterations but are deliberately not part of the baseline wire:

- `op: "subscribe"` / `"unsubscribe"` — explicit subscription management. The baseline wire derives subscription from actor-space presence; explicit subscribe is only needed when actors observe many spaces selectively.
- `op: "snapshot"` / `"history"` / `"sync"` — continuity mechanisms for fast reconnect. Replay via `space:replay` (§17.4) covers gap recovery without dedicated frames.

These are noted here so implementations don't accidentally re-derive them and so later wire revisions have a clean place to add them back.
