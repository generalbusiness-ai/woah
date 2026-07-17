---
date: 2026-05-02
updated: 2026-07-17
status: implemented
---

# MCP protocol

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**.

MCP lets one model inhabit one woo actor. The primary surface is a dynamic
tool list derived from the actor's current structural context. Moving between
spaces or moving an object into inventory changes which object verbs are
available; the gateway does not encode catalog names or command words.

This document specifies the initial Net MCP profile. The classic MCP host is a
rollback implementation and is not the reference for new behavior.

## M1. Connection and authentication

The Streamable HTTP endpoint is `POST /net-api/mcp`. `initialize` carries an
API-key credential in `Mcp-Token`, using the normal woo form
`apikey:<id>:<secret>`. The gateway authenticates the key, creates a Net
session, and returns its bearer in `Mcp-Session-Id`. Every later request must
carry that session id and is authorized as the session actor.

The initial Net profile accepts API keys only. Guest, account-bearer, and
wizard-bootstrap initialization are future credential carriers; adding one
must reuse the normal Net authentication path rather than add MCP-only
identity semantics.

`DELETE /net-api/mcp` with `Mcp-Session-Id` closes the Net session and drops
its local observation queue. A missing or already-expired session makes delete
an idempotent success.

One MCP session binds to one actor. MCP never changes `actor`, `progr`, verb
permissions, or the normal Net turn authority rules.

The stdio entry is a transport bridge. It forwards JSON-RPC messages to this
HTTP surface, retains the returned session id, and closes the session when
stdin closes. A pipelined pre-session prefix is ordered behind `initialize` so
every later request carries the returned session id. Once initialized,
independent requests are forwarded concurrently: a long `woo_wait` must not
head-of-line-block calls or MCP keepalive traffic. The bridge must not create an
in-process world or dispatch verbs through a second host.

## M2. Tool surface

Standard `tools/list` returns stable protocol controls followed by dynamic
object tools. It uses MCP cursor pagination and returns at most 128 tools per
page.

### M2.1 Stable controls

| Tool | Contract |
|---|---|
| `woo_list_reachable_tools(scope?, object?, query?, limit?, cursor?, include_schema?)` | Pages and filters descriptors from the same resolver used by `tools/list` and invocation. |
| `woo_call(object, verb, args?)` | Calls a currently reachable descriptor by canonical object and verb. `args` is a positional JSON list. |
| `woo_wait(timeout_ms?, limit?)` | Long-polls the session observation queue. |

These are protocol controls, not world verbs. `woo_call` is an escape hatch for
clients with stale dynamic metadata; it does not bypass structural context,
tool exposure, or verb permissions.

`woo_list_reachable_tools` returns:

```json
{
  "scope": "active",
  "object": null,
  "query": null,
  "limit": 64,
  "cursor": null,
  "next_cursor": null,
  "total": 12,
  "tools": []
}
```

`query` is a case-insensitive match over name, object, verb, aliases, and
description. `include_schema:true` adds `input_schema` to descriptor summaries.
Limits default to 64 and cap at 256.

The supported scopes change presentation, never authority:

| Scope | Selection |
|---|---|
| `active` | Actor, active space, active-space contents, and inventory. This is the default. |
| `here` | Active space and its direct contents. |
| `object` | One named object, only if it is already in structural context. |
| `space` | One contextual space (or the active space) and its direct contents. |
| `all` | The complete structural context; it never enumerates the world. |

### M2.2 Verb mapping

For each contextual object, the gateway walks the instance, parent chain, and
explicit feature chains in normal dispatch order. The first page for a verb
name wins; an unexposed override therefore hides an exposed inherited page.
Aliases do not become duplicate tools.

A page is advertised only when all of these hold:

- it is bytecode-backed; a native page has no portable Net execution body;
- `tool_exposed` is true, or the object is the active command surface (or one
  of its visible contents) and the verb has non-empty command metadata; and
- the actor passes the gateway's generic execute-permission prefilter.

The authoritative Net turn performs the permission check again. Exposure is a
discoverability decision, never an authority grant.

Names are deterministic within a listing. The base form is
`<sanitized-object>__<sanitized-verb>`; a numeric suffix resolves collisions.
Tools are sorted by canonical object then verb before collision assignment.
The description contains the first source comment paragraph and canonical call
form. `inputSchema` is derived from `arg_spec.args`/`params` and optional type
hints. When explicit hints are absent, the gateway preserves the stable JSON
shape implied by aligned `arg_spec.command.args_from` entries: parser text is a
string, resolved object slots are object-id strings, and `cmd` is an object.

Named invocation maps JSON object properties to positional verb arguments in
the declared order. Missing properties become `null`. `woo_call` accepts the
positional list directly.

## M3. Structural context and navigation

The dynamic context is exactly the union of:

1. the session actor;
2. the session's active space;
3. direct members of that space's `contents` relation; and
4. direct members of the actor's `contents` relation (inventory).

Expansion is one level only. It does not recursively traverse containers or
catalog registries and it never performs global enumeration.

Another live presence actor in the active space is social context, not an
object-tool target. Agents interact with people through the space's social
verbs. A self-hosted object marked by the generic
`host_placement: "self"` role remains an ordinary tool target even when it has
a live session. This distinction is structural and contains no catalog or
class-name special case.

The in-world `$actor:focus`, `$actor:unfocus`, and `$actor:focus_list` behavior
is not an MCP control plane. It does not broaden this context. Navigation is
therefore a single clean path: call an available movement verb, then re-list.
A task in the current task board exposes `claim`; once claimed into inventory,
its lifecycle verbs follow the actor without a focus/re-list/unfocus sequence.

Woo object references are runtime strings and verbs do not yet declare result
schemas. A gateway must not infer capabilities from returned string shapes or
field names. A future returned-reference extension requires explicit typed
result metadata and a separately bounded session context.

### M3.1 Cold contextual objects

The relation mirror can know that an object is contextual before the gateway
holds that object's lineage and verb pages. A `contents` relation row therefore
carries optional `member_scope`, the member object's immutable authority
scope. This is routing metadata, not object truth and not a client-visible
field. Install planning, relation derivation, and bounded relation rebuilds
populate it.

Before listing or invoking, the gateway groups contextual members by
`member_scope` and performs one full targeted object pull. A lineage row alone
does not prove that a sparse transfer included the object's own verb pages.
Completed pulls have a bounded success memo; missing or dangling members use
exponential retry backoff capped at 30 seconds and a bounded failure memo. The
gateway considers at most 128 members per request. Repeated model renders or
`tools/list` calls must not create a read storm.

Legacy rows without `member_scope` fall back to the relation owner's scope.
That is exact for ordinary room-owned contents and actor-owned inventory. A
foreign-anchored legacy inventory row becomes fully routable when its next
normal relation mutation refreshes the row. Operators upgrading an aged world
that requires immediate completeness for such inventory must refresh those
derived rows before declaring MCP parity; runtime global lookup is forbidden.

## M4. Invocation and results

Dynamic-name calls and `woo_call` resolve through the same current descriptor
set. A globally known but non-contextual object is refused. A canonical target
must also pass the concrete runtime-object-id validator before it can consume
turn planning or repair budget.

Every accepted invocation enters the normal Net client-turn path with a fresh
idempotency key. MCP does not choose a classic direct/sequenced route and does
not run a private VM.

Successful `tools/call` results use:

```json
{
  "content": [{"type": "text", "text": "<JSON result>"}],
  "structuredContent": {"result": null},
  "isError": false
}
```

World or Net failures use the same MCP tool-result envelope with
`isError:true` and `structuredContent.error`. JSON-RPC protocol errors such as
an unknown tool name use a JSON-RPC error object. A missing, expired, or
malformed MCP session is rejected before discovery or invocation.

The gateway records the submitting turn echo id and suppresses the actor's own
committed echo from `woo_wait`, so a call result and the observation queue do
not duplicate the same action.

## M5. Observation queue

`woo_wait` drains a gateway-local, per-session FIFO fed by the same
presence-routed fanout as WebSocket clients. It accepts `timeout_ms` from 0 to
25,000 and `limit` from 1 to 256 (default 64). It returns
`{observations:[...]}`.

The queue holds at most 256 observations and drops the oldest on overflow.
It is intentionally live and at-most-once: Durable Object eviction or session
close drops undelivered observations. Durable observation recovery is a
separate protocol feature and must not be implied by this queue.

Multiple parked waits may wake together, but draining uses prefix removal so
an observation is returned to at most one waiter.

## M6. Dynamic-list lifecycle

The initial Net profile advertises `capabilities.tools.listChanged:false`.
Clients must re-list after navigation or a containment-changing call. The
`initialize.instructions` string states this explicitly and names the bound
actor.

`notifications/tools/list_changed` is deferred lifecycle work. When added, it
must be session-specific and a hint only; the current structural resolver
remains the freshness and authorization boundary. No temporary result field
substitutes for the standard notification.

## M7. Security and scaling invariants

- API-key authentication happens before session creation.
- Every non-initialize method validates `Mcp-Session-Id` and its expiry.
- Other actors' session bearers never appear in tools, relation results, or
  observations.
- Dynamic listing and dynamic invocation use one authoritative resolver.
- Tool exposure does not bypass execute permissions.
- Context work is proportional to the bounded actor/space context, never the
  installed world or all sessions.
- Catalog identities, command words, and UI shapes do not enter the gateway.

## M8. Deferred extensions

- `notifications/tools/list_changed` and durable observation delivery;
- additional credential carriers;
- explicit typed returned-object references;
- MCP resources such as `woo://here` or `woo://object/{id}`;
- multi-actor multiplexing and streaming progress.

Each is additive. None requires reviving MCP focus wrappers or a second
execution stack.
