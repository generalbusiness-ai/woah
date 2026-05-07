---
date: 2026-04-30
status: implemented
---

# REST API

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**.

An HTTP+SSE alternative to the WebSocket wire ([wire.md](wire.md)), exposing the same call/applied/observe semantics in a request-response shape that agents and integrations can consume natively.

The two wire formats target the same model. WebSocket is the right shape for clients that maintain long-lived presence and want push observations. REST is the right shape for agents and tooling that operate in iterations, scripts that want a single request-response, and integrations behind HTTP gateways. Either or both may be exposed by an implementation.

---

## R1. Endpoints

```
POST  /api/auth
DELETE /api/session
GET   /api/state
GET   /api/me
GET   /api/catalogs/ui
GET   /api/objects/{id-or-name}
GET   /api/objects/{id-or-name}/summary
GET   /api/objects/{id-or-name}/ui-snapshot?surface=S
GET   /api/objects/{id-or-name}/properties/{name}
POST  /api/objects/{id-or-name}/calls/{verb}
GET   /api/objects/{id-or-name}/log?from=N&limit=M
GET   /api/objects/{id-or-name}/stream
```

Twelve endpoints. Everything is an object; identifiers are object refs,
corenames, or implementation-local object ids.

---

## R2. Identifiers

The path segment `{id-or-name}` accepts:

- A ULID with `#` sigil: `#01HXYZAB...` (URL-encode the `#` as `%23`).
- A corename: `$wiz`, `$dubspace`, `$me`. The `$` is URL-safe; no encoding needed.
- A transient ref: `~3@%23<host-ulid>` (URL-encode the qualifier).
- An implementation-local object id already present in the world, such
  as a bundled seed/runtime id (`the_pinboard`, `obj_pin_3`). These are
  deployment-local compatibility ids, not portable object refs.

Static corenames resolve via `$system.<name>` lookup; dynamic corenames (`$me`) resolve per-request — see R8.

If the identifier doesn't resolve, the response is `404 { error: { code: "E_OBJNF", ... } }`.

---

## R3. Auth

```
POST /api/auth
body:    { token: string }
returns: { actor: ObjRef, session: string }
```

**Baseline token vocabulary** matches [identity.md §I3](../semantics/identity.md#i3-auth-guest-baseline):

- `guest:<random>` — server-allocated guest actor.
- `session:<id>` — resume an existing live session.

Subsequent requests carry the session id as `Authorization: Session <id>`. The session id is opaque server-side state — no signing, no claims, no expiry beyond the session timeout — so baseline REST has no JWT machinery requirement.

`DELETE /api/session` ends the presented session immediately and returns
`{ ok: true, session }`. Implementations MUST remove the session from their
local session store before returning. Distributed implementations SHOULD also
remove any session-routing record used for cross-host dispatch; stale best-effort
routes must fail closed through the normal session validation path.

`GET /api/state` is the legacy full-world debug projection. It is wizard-only.
It returns the actor-readable world projection plus
`session: { id, actor, current_location }` for the presented session. The
projection's object graph may include compatibility presence mirrors, but
ordinary clients MUST NOT use it for boot, movement, route resolution, or live
updates. Use `/api/me`, `/api/objects/{id-or-name}/summary`, and overlay
snapshots instead.

`GET /api/me` returns the scoped browser projection for the presented session:
`{ server_time, cursor, self, session, here, inventory }`. It is the ordinary
client-boot and reconnect endpoint. It MUST NOT serialize the full world object
map. `cursor.spaces[space].next_seq` is the first sequenced frame to request
after applying the snapshot. Cursor spaces are the union of
`session.current_location`, `here.id`, and every overlay subject. Cursor
metadata is a system-scoped read, not a user property read; an actor may be
entitled to replay observations from a space whose internal `next_seq` property
is not readable by that actor. A space appears in the cursor only when it
exposes a numeric `next_seq`; live-only state is reasserted by hydration rather
than replay. `session.current_location` is the acting location for the
presented session; `here` is a shallow, actor-filtered room snapshot for that
location or `null`. Object summaries include `ancestors` so clients can resolve
UI frames without reading a global class graph. Distributed implementations
route `here` reads to the host that owns the current room.

Object summary `props` are actor-filtered by property read permissions. Identity
fields (`id`, `name`, `parent`, `ancestors`, `features`, `owner`, `location`)
are summary fields, not ordinary property reads; v1 treats them as public to a
client that is already entitled to receive the object summary. Access control
is therefore on whether the object is in the scoped projection, not on masking
individual identity fields.

`GET /api/catalogs/ui` returns installed catalog UI declarations and module
metadata only. It is cacheable by catalog version/ETag and is separate from
actor/session state. Implementations SHOULD return an `ETag`, honor
`If-None-Match` with `304`, and include a revalidation cache policy. v1 exposes
bundled/local catalog UI only; remote catalog UI requires a separate module URL
and integrity policy. `objects` and `seeds` entries are catalog-install metadata
for resolution/debugging and are not a stable contract for choosing runtime
subjects.

`GET /api/objects/{id-or-name}/ui-snapshot?surface=S` returns a scoped overlay
snapshot for a tool/component subject. The response shape is
`{ surface, subject, cursor, room, objects }`: `room` is a shallow
`RoomSnapshot` when the subject is a space-like object, `objects` is the
permission-filtered object-summary set needed to render that overlay, and
`cursor` covers the overlay subject's sequenced stream. This endpoint is the
overlay counterpart to `/api/me`; it MUST NOT serialize the full world object
map.

`GET /api/objects/{id-or-name}/summary` returns the single
permission-filtered object summary used by scoped projections. It includes the
same identity fields and actor-filtered `props` as `/api/me` summaries,
including `ancestors` for client-side UI frame resolution. It is the narrow
route/debug lookup for one object; clients MUST NOT use `/api/state` merely to
resolve a route target's display name or class chain.

Credentialed auth extends the vocabulary per [auth.md §A3](../identity/auth.md#a3-token-vocabulary-extended): `bearer:<jwt>`, `apikey:<id>:<secret>`, `oauth_code:<provider>:<code>`, `recovery:<token>`. Bearer tokens use `Authorization: Bearer <jwt>` with signature/claims validation. The endpoint shape is unchanged; only the accepted vocabulary expands.

An implementation that doesn't ship credentialed auth returns `400 E_INVARG` for `bearer:`/`apikey:`/`oauth_code:` tokens. An implementation that ships credentialed auth accepts both vocabularies.

---

## R4. Describe

```
GET /api/objects/{id-or-name}
returns: { id, name, parent, owner, location, anchor, flags, modified,
           properties, verbs, schemas, children, contents }
```

Calls `:describe()` on the target. See [introspection.md](../semantics/introspection.md). Permission-filtered: a caller without read permission on a property sees the property name in `properties` but cannot fetch its value (R5 returns `403`).

---

## R5. Property reads

```
GET /api/objects/{id-or-name}/properties/{name}
returns: { name, value, version, defined_on, owner, perms }
```

The value is V2-encoded ([values.md §V2](../semantics/values.md#v2-canonical-json-encoding)).

- `403 E_PERM` if the caller can't read.
- `404 E_PROPNF` if the property doesn't exist.

Property *writes* are not exposed as REST. Mutations go through verb calls (R6). Same discipline as the WebSocket wire: properties are read-only at the API; verbs are how mutation happens.

---

## R6. Verb calls

```
POST /api/objects/{id-or-name}/calls/{verb}
body:    { args: [...], space?: ObjRef, actor?: "$me", id?: string, body?: { ... } }
returns: applied frame (sequenced) OR direct verb result
```

The body-level `space` field determines whether the call is sequenced — this is the load-bearing distinction:

- **`space` is set** → sequenced through that `$space`. The runtime constructs the message `{ actor, target: id-or-name, verb, args }` and dispatches it through `space:call`. Returns `{ space, seq, message, observations, ts, result }`.
- **`space` is null** → direct dispatch on the target. Allowed only for verbs annotated `direct_callable: true` (§R12). For verbs without this annotation, returns `403 E_DIRECT_DENIED`. Returns `{ result, observations }`.

The natural agent shape is sequenced: `POST /api/objects/$task_42/calls/transition` with body `{ args: ["design-review"], space: "$taskspace" }`. The same call without `space` is rejected because `:transition` is not direct-callable. This makes "mutate through a space" the obvious path, not something callers must remember to wrap.

For backward compatibility with the wire format, calling `:call` directly on a `$space`-descended object (`POST /api/objects/$taskspace/calls/call` with body `{ args: [{target, verb, args}] }`) is also sequenced — equivalent to setting `space` on the body of the inner target. The body-level `space` form is preferred in agent code.

In both cases:
- `actor` defaults to `$me`. Wizards may pass a different actor (logged); regular callers presenting an actor different from their session's binding get `403 E_PERM`.
- `id` is a client-chosen correlation token; idempotent retry returns the same response within the cache window (5 min, per [wire.md §17.4](wire.md#174-the-applied-push-model)).
- `body` is an optional map carrying additional named arguments per the verb's `arg_spec`.

Movement/entry verbs that return an object-shaped `{ room, here_request: true,
... }` result also include `here`, a shallow room snapshot in the same shape as
`/api/me.here`. This applies to both direct and sequenced calls; for WebSocket
sequenced calls, the result is delivered only to the originating client. Older
clients may continue to use `room` and `look_deferred`; scoped clients can
hydrate the destination without a follow-up `:look` call. `look_deferred` is
legacy and does not itself request snapshot enrichment.

When move execution defers cross-host presence writes, the returned `here`
snapshot must still include the moving actor if the presented session's current
location resolves to that `here` room. Implementations may satisfy this by
flushing the relevant host effects before reading the snapshot, or by patching
the actor into the move-result snapshot deterministically.

**Pre-sequence vs sequenced errors.** REST distinguishes the two cases [space.md §S3](../semantics/space.md#s3-failure-rules-normative) requires:

- **Pre-sequence errors** (validation, authorization, missing target, workflow gate failures) return non-2xx HTTP with the err in the response body. **No seq is allocated.**
- `E_TIMEOUT` maps to HTTP `504 Gateway Timeout`. A distributed host may return it for semantic cross-host reads or calls that cannot safely degrade.
- **Sequenced behavior failures** (verb body raises during execution) return `200` with an applied frame whose `observations` include a `$error` observation. The seq has been allocated; the message is durably in the log.

Workflow gate failures (`E_TRANSITION*`) are pre-sequence: the gate runs before the verb body, so no seq advances and the response is `4xx`, not an applied frame.

Errors:

| Status | Code | Meaning |
|---|---|---|
| 400 | `E_INVARG` | Malformed request. |
| 403 | `E_PERM` | Actor not authorized. |
| 403 | `E_DIRECT_DENIED` | Verb requires sequencing (`space` field is null and verb is not `direct_callable`). |
| 404 | `E_OBJNF` / `E_VERBNF` | Target or verb missing. |
| 409 | `E_CONFLICT` | Domain-level conflict (e.g., task already claimed). |
| 422 | `E_TRANSITION` | Workflow gate: no transition rule from `from` to `to`. |
| 422 | `E_TRANSITION_ROLE_UNSET` | Workflow gate: required role property on the target is null. |
| 422 | `E_TRANSITION_REQUIRES` | Workflow gate: entrance condition failed (`value` carries which predicate failed). |
| 429 | `E_RATE` | Rate-limited. |
| 500 | `E_INTERNAL` | Runtime error not classified above. |

---

## R7. Log

```
GET /api/objects/{id-or-name}/log?from=N&limit=M
returns: { messages: [...], next_seq, has_more }
```

If `{id-or-name}` is a `$space`-descended object, returns the message log per [events.md §12.8](../semantics/events.md#128-sequenced-calls-with-gap-recovery). Each entry carries the accepted message, final outcome, and applied observations so an HTTP/SSE client can reconstruct the same applied frames it would have received live. Pagination via `from` (default 1) and `limit` (default 100, max 1000).

If the target is not a space, returns `404 E_NOTAPPLICABLE`.

---

## R8. Stream (SSE)

```
GET /api/objects/{id-or-name}/stream
returns: text/event-stream
```

Server-sent events. Two SSE event types are emitted:

- **`event: applied`** — a sequenced applied frame. Replayable; carries `seq`. JSON body has the same shape as wire.md `op: "applied"`.
- **`event: event`** — a live observation from a direct call. Not replayable; no `seq`. JSON body is `{observation: Map}` per wire.md `op: "event"`. Per [events.md §12.6](../semantics/events.md#126-observation-durability-follows-invocation-route), these are best-effort: rate-limited, coalesced, dropped on backpressure.

Stream semantics:

- For a `$space`: applied frames + live observations the requesting actor is authorized to see (presence-derived, per [wire.md §17.4](wire.md#174-the-applied-push-model)).
- For a `$player` (or `$actor`): observations where the object appears as `source` or `target`, including applied frames of spaces the player is observing.
- For `$me`: the calling actor's full observation feed across all observed spaces.

The SSE event id is `<space-id>:<seq>` for applied frames; live `event` SSE entries omit the id (they have no resume point — by design, they are not replayable). **`Last-Event-ID` resume is supported only for single-space streams** (`/objects/{space}/stream`) and only resumes the applied stream. Live observations between disconnect and reconnect are lost; they are live-only by contract. The server resumes applied from the requested seq, or returns `410 E_SSE_TOO_OLD` directing the client to use `/log` for backfill before restarting.

For multi-space streams (`/objects/$me/stream` and any `/objects/{actor}/stream`), `Last-Event-ID` is ignored on reconnect — a single id cannot encode cursors across N spaces. A reconnecting multi-space client must fetch `/log` per space it cares about (using locally tracked per-space `last_seq` values) before resuming the live stream. This trades resume convenience for correctness; per-space gap recovery is the right granularity anyway.

A future variant may define a cursor-map header (e.g., `X-Woo-Cursors: <base64-encoded {space: seq} map>`) for multi-space resume; not part of the baseline REST contract.

---

## R9. `$me` resolution

`$me` is a *dynamic* corename: it resolves per-request based on the bearer's actor binding.

- In REST: `$me` = the actor in the bearer token's `actor` claim.
- In verb bodies (the wire's call path): `$me` = the calling frame's `actor` field. Equivalent to writing `actor` directly in source.
- A wizard with the `impersonate` capability may override `$me` for a single call (via `X-Woo-Impersonate-Actor: <ref>` header on REST or `wiz:as_actor(...)` in user code); the impersonation is logged as a wizard action.

`$me` is reserved alongside the static corename namespace. See [objects.md §5.3.1](../semantics/objects.md#531-dynamic-corenames).

`$peer` is reserved for the calling peer in cross-world contexts ([federation-early.md](../deferred/federation-early.md)). It is inactive in single-operator deployments.

---

## R10. REST placement

REST is a foundational runtime protocol, not an operational add-on. It runs alongside WebSocket, exposes the same model, uses the same auth, and counts toward the same conformance suite.

An implementation must support REST. WebSocket is recommended but optional in resource-constrained deployments. The conformance suite ([conformance.md §CF3](../tooling/conformance.md#cf3-required-categories)) tests both.

---

## R11. What's not in REST

- **Authoring operations** (`compile_verb`, `set_verb_code`, `define_property`). The minimal IDE ([authoring/minimal-ide.md](../authoring/minimal-ide.md)) goes through dedicated authoring endpoints with their own auth requirements; not the runtime REST verb-call shape.
- **Worktree operations.** Same — authoring-side, separate endpoints.
- **Cross-world calls.** The early federation design ([federation-early.md](../deferred/federation-early.md)) defines its own HTTPS POST surface (`/.woo/api/call` with mTLS) distinct from this REST API.

These are intentional. REST here is the runtime API for actors and agents; authoring and federation have different security boundaries and warrant their own surfaces.

---

## R12. Direct vs sequenced: the `direct_callable` annotation

Most verbs that mutate persistent state must be invoked through a space (R6 with `space` set). Reads and inherently-self-contained operations may be invoked directly. The normative external-ingress gate is [core.md §C12.2](../semantics/core.md#c122-external-direct-call-gate); this section gives the REST shape.

A verb's metadata gains a `direct_callable: bool` field, default `false`. Verbs annotated `direct_callable: true` may be invoked via REST without a `space`; verbs without it return `403 E_DIRECT_DENIED` on direct invocation.

Conventions:

- **Always direct.** `:describe()` on `$root` and the standard introspection set, property reads via `/properties/{name}`, listing verbs (`:list_*`, `:tasks_in_state`, `:items_unfilled`, etc.) — these are inherently read-only and ship as `direct_callable: true` from the seed graph.
- **Default not direct.** Mutating verbs (`:claim`, `:transition`, `:set_*`, `:add_*`) are `direct_callable: false` unless the author explicitly opts in. The default makes "must mutate through a space" the safe path.
- **Cross-world annotation is independent.** [federation-early.md §FE3](../deferred/federation-early.md#fe3-verb-annotation-cross-world-callability) defines `cross_world_callable: bool` with the same default-deny shape but for a different boundary. A verb may have neither, either, or both flags.

Direct calls **do not produce sequenced messages**; their observations are returned in the response and are not logged in any space's history. Correct for read-only ops; for mutating ops, the rule "mutate through a space" preserves sequencing and audit.

Wizards may override `direct_callable: false` via the `X-Woo-Force-Direct: 1` header. The override is logged as a wizard action and is intended for operational repair, not as a casual escape hatch.
