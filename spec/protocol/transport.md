# Substrate transport — the Host seam and its bindings (TR1–TR9)

> Status: TR1–TR6 and TR8 are **adopted** — they describe the implemented
> `Host` seam (`src/net/host.ts`) and constrain every binding. TR7.1 is the
> **implemented** production binding. TR7.2 (platform-native RPC) is
> **draft — the target binding** for the Cloudflare profile. TR7.3 is
> **reserved** for a future non-DO distributed infrastructure.
>
> Scope: cross-node calls *inside one deployment* of the coherence layer
> ([coherence.md](coherence.md)) — gateway ↔ scope, scope ↔ scope, and the
> edge worker's internal calls. The client wire is [wire.md](wire.md); the
> legacy v2 host RPC surface is [hosts.md §3](hosts.md) and
> [reference/cloudflare.md §R5](../reference/cloudflare.md#r5-cross-do-rpc-surface)
> (frozen for retirement, see [net-cutover.md §NC9](../operations/net-cutover.md#nc9-v2-stack-decommission)).

## TR1. The Host seam

All platform effects available to the coherence layer pass through one
interface, `Host` (`src/net/host.ts`):

```ts
interface Host {
  now(): number;
  defer(task: () => Promise<void>): void;          // post-reply work
  setAlarm(key: string, at: number | null, fire: () => Promise<void>): void;
  rpc(destination: string, route: string, body?: unknown): Promise<unknown>;
}
```

`src/net/` MUST NOT import platform primitives (DO stubs, namespaces,
storage handles, `fetch`); the shell that composes a node injects a `Host`.
`rpc` is **the single cross-node choke point**: every cross-authority call
in the layer flows through it, which is what makes fault injection (TR8),
metrics, deadline enforcement, and — the point of this spec — **transport
substitution** one-place changes instead of scattered ones.

The normative consequence: *a transport is swapped by providing a new
`Host` binding and nothing else.* Any design that would require coherence
logic to know which binding carries its calls is non-conforming.

## TR2. Destinations

A destination is a stable logical name, `"<kind>:<name>"`. Kinds in v1:

| Kind | Authority | Cloudflare binding |
|---|---|---|
| `scope:<name>` | a commit scope (CO2.3; names per CO15 — `room:<space>`, `cluster:<actor>`, catalog) | `SCOPE_NET` DO namespace |
| `gateway:<name>` | a gateway shard | `GATEWAY_NET` DO namespace |

[operations/audit.md §AU6](../operations/audit.md#au6-the-delivery-pipeline)
reserves a third kind, `audit:<shard>`, for audit-trail delivery.

Resolution of a destination to a reachable endpoint is binding-owned
(`resolveNetDestination` in the workerd binding; `NET_RESOLVE` in test
harnesses). The contract is only: the same destination name reaches the
same authority for the life of an epoch. Under TR7.3 the resolver becomes
a directory/discovery concern; destination names do not change.

## TR3. Routes and payloads — the data-only rule

A call is `(destination, route, body) → reply`. Routes are short strings
(`/head`, `/submit`, `/closure`, `/fanout`, `/adopt`, `/relate`,
`/plan-scheduled`, …); request and reply bodies are **plain,
JSON-serializable data**. Normatively:

- **No platform references may cross the seam.** Not stubs, not streams,
  not functions/callbacks, not capability objects, not binding-specific
  error types. A payload that cannot round-trip through
  `JSON.parse(JSON.stringify(x))` is non-conforming *even on a binding
  whose native serialization could carry it* (structured clone, Workers
  RPC `RpcTarget`s). This is the load-bearing rule for TR7.3: the contract
  must be satisfiable by any message transport.
- **Type safety comes from a shared route map, not transport method
  signatures.** `src/net/` owns a compile-time table mapping each route to
  its request/reply types (bounded by a `JsonValue` type). Both ends check
  against the same table; the transport carries opaque data.
- Route dispatch lives in the receiving node's shell (its existing route
  table), never in per-route transport methods — adding a route must not
  change the transport surface.

## TR4. Delivery semantics

The seam provides **single-attempt, ambiguous-on-timeout** delivery:

- One `rpc()` call is one attempt. The binding MUST NOT retry internally.
- A timeout (TR5) means *unknown outcome* — the destination may have
  committed. Recovery is protocol logic, above the seam: every mutating
  route carries an idempotency key (CO2.5), and an ambiguous submit is
  disambiguated by one same-key replay. Read routes are side-effect-free
  and freely repeatable.
- Retry/backoff policy (outbox `next_attempt_at_ms`, the gateway's
  one-replay rule) is caller logic and MUST stay above the seam, so that
  changing bindings never changes retry behavior.

## TR5. Deadlines

Every `rpc()` is bounded by a caller-side deadline (`NET_RPC_TIMEOUT_MS`,
default 5 000 ms, clamped [10, 30 000]). On expiry the binding throws
`E_RPC_TIMEOUT` (CO6) with `{destination, route, timeout_ms}` and emits
the `net_rpc` timeout metric. Cancellation of the remote work is
**best-effort and binding-specific** (an HTTP fetch abort cancels the
subrequest; a platform RPC race may leave the remote call running).
Correctness MUST NOT depend on remote cancellation — the destination
either commits durably and idempotently or not at all (CO2.2), so an
orphaned remote attempt is harmless by construction.

## TR6. Failure surface

Everything the seam can throw is one of:

1. `E_RPC_TIMEOUT` (TR5), or
2. a transport rejection (unreachable destination, non-OK status,
   undecodable reply) thrown as an ordinary error, or
3. a protocol-level CO6 code decoded from a well-formed reply body.

Callers classify 1–2 as retryable-with-idempotency-key (the gateway maps
them to 503/`E_BUDGET`-style backpressure); 3 follows the CO6 recovery
column. A binding MAY observe richer platform signals (Workers RPC
`.retryable` / `.overloaded`) but MUST fold them into this same
classification at the seam — binding-specific error types never escape
into `src/net/`.

## TR7. Bindings

### TR7.1 Signed HTTP over stub fetch (implemented — current production)

`WorkerdHost` (`src/worker/net/workerd-host.ts`): resolves the destination
to a DO stub, signs the request with the internal HMAC
(`signInternalRequest` / `WOO_INTERNAL_SECRET`), issues `stub.fetch()`
against the receiving DO's `fetch()` handler, decodes JSON.

Known structural hazard, accepted for v1 and the reason TR7.2 exists: the
internal route surface and any client-facing route surface share one
`fetch()` dispatch, distinguished only by path matching and per-route
guards. Guard-enumeration gaps on that shared surface are an observed
security bug class. The HMAC secret is deployment-wide state that must be
rotated on suspicion of exposure.

### TR7.2 Platform-native RPC (draft — target for the Cloudflare profile)

The net DO classes (`NetScopeDO`, `NetGatewayDO`) extend `DurableObject`
and expose **exactly one** generic RPC entrypoint:

```ts
async netCall(route: string, body?: JsonValue): Promise<JsonValue>
```

`WorkerdHost.rpc` invokes `stub.netCall(route, body)` instead of a signed
fetch, racing the returned promise against the TR5 deadline. Everything
else is unchanged: the receiving shell dispatches `route` through the same
route table that `fetch()` used, TR3's data-only rule still binds (no
`RpcTarget`s, no stub or callback arguments, JSON-safe payloads only), and
TR4/TR6 semantics are identical.

What this buys, in order of importance:

1. **The internal call surface leaves the network.** DO RPC methods are
   reachable only through a stub held by code with the namespace binding —
   never from an external request. The `/net/*` internal routes are then
   **removed from `fetch()` dispatch entirely** (an internal route
   arriving via fetch answers 404, fail-closed), which eliminates the
   TR7.1 guard-enumeration bug class rather than patching instances of
   it. The internal HMAC is retired for DO-to-DO calls.
2. Structured-clone serialization and typed envelopes at the seam.
3. Platform failure signals (`.retryable`, `.overloaded`) folded into
   TR6's classification.

`fetch()` survives on these DOs only for what the platform requires it
for: the WebSocket upgrade on the gateway, and nothing else.

Deliberately rejected: per-route typed RPC methods on the DO classes
(`stub.submit(...)`, `stub.head(...)`). They read better in isolation but
move the route contract into platform stub types — exactly the
hard-reliance on DO-native RPC that TR7.3 forbids. The one-method envelope
keeps the transport a dumb pipe.

### TR7.3 Non-DO transport (reserved)

A future distributed infrastructure (self-hosted mesh, mTLS peers per
[deferred/federation-early.md](../deferred/federation-early.md), or any
message transport) conforms by implementing `Host` for its nodes:
`rpc` carries `(destination, route, JsonValue)` with TR4–TR6 semantics;
destination resolution moves to its discovery layer. Because of TR1
(one seam), TR3 (data-only payloads), and TR7.2's one-method discipline,
this is a new `Host` class plus a resolver — no changes in `src/net/`,
no changes to routes, envelopes, idempotency, or retry logic.

## TR8. Fault injection

`WOO_NET_FAULTS` applies faults (latency, timeout, pre-call error,
kill-after-commit) **at the seam and only at the seam**, keyed by route
suffix. It is test-lane-only (refuses to arm when `WOO_AE_DATASET` marks a
deployed environment) and binding-independent: every binding MUST honor
the same fault contract so the fault lane (CO12.5) is transport-portable.

## TR9. Conformance

1. The shared smoke scenario passes on an in-process `Host` binding and
   the workerd binding (existing lanes) — and on every future binding
   before it carries traffic.
2. The CO12.7 taxonomy gate covers the seam: nothing escapes `rpc()`
   outside TR6's surface.
3. Type/grep gate: `src/net/` imports nothing from `src/worker/`; route
   map payload types are `JsonValue`-bounded.
4. After TR7.2 lands: a gate asserting the net DOs' `fetch()` handlers
   serve **no** `/net/*` internal route (the fail-closed 404), and that no
   code path signs internal requests on the DO-to-DO path.
