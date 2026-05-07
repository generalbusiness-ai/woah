---
date: 2026-05-01
status: implemented
---

# Hosts and execution model

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**. Implementation specifics (Durable Objects, alarms, persistent storage schema) are in the [reference layer](../reference/cloudflare.md).

The abstract model of hosts: where verb code can run, how tasks move between hosts, the trust boundary classes.

---

## 3. Hosts and execution model

There are exactly three host classes. The VM bytecode and semantics are identical across all of them; only routing differs.

| Host | Lifetime | Hosts | Identifier sigil |
|---|---|---|---|
| **Edge** | Per-request worker isolate | Compiler, router, no objects | n/a |
| **Persistent** | Long-lived, hibernating actor | Persistent objects | `#` |
| **Transient** | Bounded by a client connection | Transient objects | `~` |

### 3.1 Async host RPC

Execution is task-oriented. A **task** is an activation stack owned by one host at a time. The ordinary operations that cross host boundaries are:

- **Property reads on a remote object** (`OP_GET_PROP`): the task yields, an RPC fetches the value, the task resumes with the result on its operand stack. The task does *not* migrate.
- **Property-value writes on a remote object** (`OP_SET_PROP`): the task yields, an RPC asks the owning host to check permissions and write the value, and the task resumes when that write succeeds or fails. The caller's local rollback scope does not include the remote write after it lands.
- **Verb dispatch onto a remote object** (`OP_CALL_VERB`): the caller awaits a routed dispatch RPC. The origin host keeps the caller's continuation; the receiver runs the callee frame under the caller's authority and returns `{result, observations}`. The origin resumes its own frame at the call site.

The opcode shape is symmetric across all three host classes. A verb call from a persistent host onto a transient-hosted object goes through the player's persistent host over the existing client connection; from the program's perspective it is the same `CALL_VERB` yield point.

### 3.2 Routing

- Persistent objects are addressed by `#id`. The id is also the persistent host's name; resolution is direct, no intermediate lookup. (See [../reference/cloudflare.md §R1.1](../reference/cloudflare.md#r11-routing) for the v1 mapping.)
- Transient objects are addressed by `~id` *qualified by* a host ref, e.g. `~3@#42` (transient #3 hosted on persistent #42's session). The `@` qualifier is implicit when the ref is constructed via the host's own client; written form uses the qualified syntax.
- A transient ref is invalidated when its host's connection closes. Calls to invalidated refs raise `E_GONE`.

### 3.3 Trust model across hosts

- Persistent hosts within the same deployment trust one another only after the transport adapter authenticates the internal envelope. The Cloudflare reference signs gateway/Directory/cluster-host requests with `WOO_INTERNAL_SECRET`; other deployments need an equivalent same-deployment authentication layer before accepting forwarded `actor`, `session`, `progr`, or mutation data. v1 uses timestamp freshness for this envelope, not nonce replay protection; the threat model assumes same-deployment internal traffic is not observable. If that assumption changes, reuse the `correlation_id`/recent-replies cache pattern from §3.4.
- Persistent hosts do **not** trust transient hosts. Any call into a transient host must have its return value validated at the trust boundary. State stored in transient objects is not authoritative.
- A task's effective permission is the verb owner's permission (`progr`), set at compile time and carried in every frame. A transient host cannot elevate `progr`; the originating persistent host retains the canonical task identity and treats browser output as untrusted return data.

When a persistent host receives a same-deployment call envelope for an actor it
has not materialized locally, it may create a minimal **actor stub** for that
objref. The stub exists only so local permission checks, presence filters, and
object references can name the actor while the call runs on this host. It must
not grant new flags, session credentials, inventory authority, or ownership
claims; those remain authoritative on the actor's home host.

### 3.4 Host RPC invariants

The protocol-level invariants that make cross-host execution sound:

**1. Origin owns the continuation.** A task's caller continuation stays on the origin host while a remote dispatch is in flight. The receiver owns only the callee frame it was asked to run and returns a value plus observations. The wait-for-cycle rule in §3.5 is the corollary: while host A awaits host B, B must not synchronously call back into A.

**2. Idempotency via correlation id.** Every cross-host RPC carries a `correlation_id`. Receivers maintain a recent-replies cache (TTL ~5 minutes) keyed by correlation id. A duplicate request returns the cached reply rather than re-executing. Transient network failures with retries are therefore safe.

**3. Originator authoritative for transient-host returns.** A task that called into a transient host has its identity fields (`progr`, `player`, `caller`, `task_id`) retained by the originator. Returned values are inputs to the originator, not authoritative state.

**4. Bytecode versioning on serialized tasks.** Every serialized task carries `vm_version`, and each frame carries the `(definer, verb, version)` triple of its running bytecode. On resume, if the running VM rejects the version, the task raises `E_VERSION` and aborts cleanly — never silently runs against incompatible code.

**5. Mid-task host crash.** A task whose host crashes mid-execution is lost if not yet checkpointed. Tasks in the host's persistent task table (`suspended`, `awaiting_read`) survive the crash; tasks running in memory or awaiting an in-flight RPC do not. Authors of long-running mutations should checkpoint via `suspend(0)` periodically.

**6. Failure-mode summary.**

| Mode | Behavior |
|---|---|
| Originator crashes or hibernates mid-RPC | The uncheckpointed in-memory task is lost; the caller retries if needed. |
| Receiver crashes before replying | Originator times out (`E_TIMEOUT`). Work on receiver was either uncommitted (lost cleanly) or partially committed (next access sees torn state — author's responsibility to bound). |
| Network partition | Same as receiver crash from originator's view. |
| Duplicate reply | Originator drops the duplicate (correlation id seen). |
| Version skew | `E_VERSION` raised; task aborts cleanly. |

**7. No synchronous host cycles.** A host must not issue an awaited RPC that
would cause the current request's host wait-for graph to contain a cycle. This
includes the trivial same-host case: a behavior turn may not enqueue another
behavior turn on its own host and then wait for it. See §3.5.

### 3.5 Host wait-for graph and reentrancy

This is the guardrail that preserves the LambdaMOO execution model after the
world is split across hosts.

In LambdaMOO, a running task owns one database turn until it returns or
explicitly suspends. In woo, the database is distributed, but the same
programming rule remains: while a behavior turn is open, awaited host RPC must
form an acyclic wait chain. A host already waiting for another host cannot be
re-entered by that same request.

#### 3.5.1 Definitions

- A **behavior turn** is a queued execution of user-visible behavior on a host:
  direct verb dispatch, sequenced `$space:call` behavior, parked-task resume, or
  VM continuation resume.
- A **synchronous host RPC** is an RPC whose caller cannot complete the current
  behavior turn until the callee returns.
- A **wait edge** `A -> B` exists while host `A` is awaiting a synchronous RPC
  response from host `B`.
- A **host cycle** exists if adding `A -> B` would make any host reachable from
  itself. The most common cycle is `A -> B -> A`; same-host self-enqueue is
  `A -> A`.

Every synchronous host RPC carries:

```ts
type HostRouteClass =
  | "read"
  | "dispatch"
  | "owner_mutation"
  | "mirror"
  | "broadcast";

{
  correlation_id: string,
  host_chain: string[],       // hosts already entered by this request, oldest first
  route_class: HostRouteClass // see §3.5.3
}
```

Before a host issues a synchronous RPC to `target_host`, it must check
`host_chain`. If `target_host` is already present, the runtime must reject the
operation with `E_HOST_CYCLE` before issuing the RPC. It must not wait for the
platform to time out, hit a subrequest-depth limit, or deadlock an in-memory
queue.

The receiving host appends itself to `host_chain` while processing the request.
The chain is diagnostic as well as protective; logs and traces should include
it whenever an RPC fails.

#### 3.5.2 Same-host reentrancy

The host queue is not a recursive lock. A behavior turn already running on host
`H` may call helper code directly, and may dispatch another verb frame through
the VM's ordinary in-process dispatch path. It may not call the public
host-entry path for `H` and await the result.

Examples:

- OK: `CALL_VERB` resolves to a local object and the runtime enters
  `dispatch()` directly, extending the current activation stack.
- Not OK: native behavior calls `directCall()` or `$space:call()` on the same
  host through the external queue, then awaits it. That is `H -> H` and must
  fail with `E_HOST_CYCLE` or use a local dispatch primitive instead.
- OK: behavior schedules a later message (`FORK`, alarm, or sequenced message)
  and returns. The later turn is a new request, not a reentrant wait.

#### 3.5.3 Route classes

Host RPC routes must be classified so implementers know which routes can be
used inside behavior and which are only post-turn effects.

| Route class | Examples | May enqueue behavior? | May mutate authoritative state? | Cycle rule |
|---|---|---:|---:|---|
| `read` | remote property read, contents read, object-description fetch, verb-metadata lookup for command planning | No | No | Acyclic synchronous RPC only |
| `dispatch` | remote `CALL_VERB`, direct verb call routed to object host | Yes | Yes, on callee host | Acyclic synchronous RPC only |
| `owner_mutation` | move object's authoritative `location`, recycle owned object | No user behavior | Yes, on owner host | Acyclic; must not callback into any host in chain |
| `mirror` | update `container.contents`, subscriber cache, presence mirror | No | Cache only | One-way; if target host is in chain, caller applies locally or defers |
| `broadcast` | WS/SSE/MCP fanout, metrics, live observation delivery | No | No correctness state | Best-effort; outside behavior correctness path |

No route may be left unclassified. A new internal route without a route class is
a spec violation because it hides whether it can participate in a wait cycle.

#### 3.5.4 Owner mutation returns deltas

The safe pattern for cross-host mutation is:

1. Caller asks the authoritative owner host to perform one mutation.
2. Owner writes its local source-of-truth state.
3. Owner returns facts/deltas needed by other hosts.
4. Caller applies any cache updates it owns, and forwards or defers other
   one-way cache updates.

The owner must not synchronously call back into a host already present in
`host_chain`. This rule is stronger than "avoid deadlock": it keeps the
direction of authority clear. The owner owns the authoritative write; containers
and observers own non-authoritative mirrors.

Canonical example: moving an object.

```ts
// request to object owner
moveObject(obj, target, { suppress_mirror_hosts: host_chain })

// owner writes:
obj.location = target

// owner returns:
{ old_location, location: target, mirror_deltas: [...] }
```

If `old_location` or `target` is hosted by the caller, the caller applies the
contents-mirror update locally after the owner write succeeds. If a different
host owns one of those containers and is not in the chain, the caller or owner
may send a one-way `mirror` RPC to that host. If delivery fails, the cache may
drift; routing and source-of-truth state are still correct.

#### 3.5.5 Author implications

Object authors do not get arbitrary synchronous cross-host I/O. They get the
ordinary language primitives:

- local `CALL_VERB` composes activation frames on the same host;
- remote `CALL_VERB` is an awaited `dispatch` RPC and may raise
  `E_HOST_CYCLE` if it would re-enter the wait chain;
- remote property-value writes are awaited host RPCs to the owning object host;
- property definition, property metadata, and lifecycle writes remain
  `E_CROSS_HOST_WRITE` when they would cross hosts;
- long-running cross-host coordination is expressed as messages, parked tasks,
  or sequenced calls, not as callbacks inside an open behavior turn.

Native handlers and host primitives are held to the same rule. They must not
hide synchronous callbacks behind "convenience" helpers. If a helper would call
back into the origin host, return a delta or schedule a later message instead.

Room movement is the canonical UI-facing example, but the host protocol does
not know about rooms. Chat woocode follows the LambdaCore pattern: the exit verb
orchestrates movement, the source room emits the departure through
`observe_to_space(source_room, ...)`, and the destination room emits arrival
through `observe_to_space(destination_room, ...)`. If those calls require actor
presence or object-location writes on another host, the runtime returns generic
deferred effects (`actor_presence`, `space_subscriber`, `move_object`) to the
origin host and applies them after the open cross-host behavior turn unwinds.
The result carries `here_request: true` and legacy `look_deferred: true`.
Scoped clients receive an enriched `here` snapshot; old clients or agents may
still ask the destination room for `:look()` in a separate direct call so
destination-room composition runs on the destination host.

#### 3.5.6 Observability and conformance

Every rejected cycle emits a structured `host_cycle_rejected` log event with:

- `correlation_id`
- `route_class`
- `from_host`
- `target_host`
- `host_chain`
- `actor`, when known
- `target` / `verb`, when applicable

The conformance suite must include:

1. `A -> B -> A` owner-mutation mirror suppression.
2. `A -> A` same-host queued self-call rejection.
3. Acyclic `A -> B -> C` RPC succeeds when each route class permits it.
4. `E_HOST_CYCLE` surfaces as a behavior failure if attempted from inside a
   sequenced call and as a direct error if attempted from a direct call.
