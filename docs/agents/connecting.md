# Connecting an MCP agent

## The Net endpoint

```
https://<deployment>/net-api/mcp
```

The reference deployment is
`https://woah1.generalbusiness.ai/net-api/mcp`. This is streamable HTTP MCP.
The `initialize` request carries an API key in `Mcp-Token`; the server returns
an opaque `Mcp-Session-Id` used by later requests.

```
Mcp-Token: apikey:<id>:<secret>
```

An operator must issue the API key for a persistent actor. Net MCP deliberately
does not accept `guest:<name>`, wizard, bearer, or OAuth credentials at this
endpoint: it reuses the Net client API-key verification and session-mint path.
Keep both the API key and returned session id secret.

## Local stdio

Start the production-shaped local Net composition:

```sh
npm run dev
```

Then configure an MCP client to spawn `npm run mcp:stdio` with:

```sh
WOO_MCP_TOKEN=apikey:local-dev:local-dev-secret
WOO_MCP_URL=http://127.0.0.1:5173/net-api/mcp
```

Optionally add `WOO_MCP_PROFILE=collapsed` to select the collapsed tool and
resource surface described in
[Tools and actions](tools-and-actions.md#the-collapsed-profile-opt-in). Leave
it unset for the default surface; nothing else about the bridge changes.

The stdio process is only a framing bridge. It forwards JSON-RPC to the HTTP
endpoint, remembers the returned session id, and closes the remote session on
EOF. It does not create an in-process world or dispatch verbs itself.

It also exits when you tell it to. Closing its stdin, or sending `SIGINT` or
`SIGTERM`, runs one bounded teardown and then exits — a couple of seconds at
worst, even if the Net endpoint has stopped answering. Requests still running
at that point are cancelled and answered with a JSON-RPC error, so your client
sees a reply instead of a truncated stream.

## What you get on connection

The API key resolves to a **session + actor** pair:

- The session is a live, expiring bearer with its own active scope and MCP
  observation queue.
- The actor is a normal world object with location, inventory, properties, and
  inherited verbs.

MCP adds no authority. Verb permissions are evaluated for the actor bound to
the API key, exactly as on the browser Net path.

The Net surface publishes dynamic named tools from the actor's current space,
its direct contents, and inventory. It also has three stable controls:

- `woo_list_reachable_tools` provides filtering, paging, schemas, and canonical
  object/verb descriptors.
- `woo_call` submits a call on any reachable object through the normal Net turn
  path — including verbs that are not advertised as tools.
- `woo_wait` long-polls the same presence-routed fanout used by WebSocket
  sessions, and reports whether delivery has been continuous.

MCP focus/unfocus wrappers are intentionally not part of reachability.
Net advertises `listChanged:true`. After the first tool list, navigation or a
containment-changing action sends `notifications/tools/list_changed` on the
session's Streamable HTTP GET/SSE channel. Treat it as a hint and re-list; the
new list remains the authoritative invocation surface.

## Disconnect and reconnect

Closing streamable HTTP MCP with `DELETE /net-api/mcp` and the session header
commits the same owner-sequenced close as browser logout. The stdio bridge sends
that DELETE when stdin closes or it is signalled — as a courtesy, not a
guarantee: it is bounded like every other shutdown step, and is skipped rather
than waited on if the endpoint is unresponsive. If a process disappears without
closing, the session expires and is reaped; reconnect with the API key and
rediscover tools.
The stdio bridge forwards GET/SSE list-change notifications as normal stdio
JSON-RPC messages.
If that long-lived stdio connection outlasts its remote Net session, the bridge
transparently mints and initializes one replacement, retries the explicitly
rejected request once, and resumes the notification carrier. Replacement loses
the old live observation queue and descriptor baseline, so the bridge emits
`notifications/woo/continuity_gap` followed by
`notifications/tools/list_changed`. Re-orient and re-list before relying on
prior state. A refused credential or any error other than an explicit
`E_NOSESSION` is not retried.
Undelivered `woo_wait` observations are live, at-most-once data and do not
survive gateway eviction. You are told when that happens: the next `woo_wait`
reply carries `gap: true`, meaning continuity could not be proven. Re-orient
with `look`/`who` rather than assuming an empty list means a quiet room. See
[observations.md](observations.md).

## Quick connectivity check

Use standard `tools/list`, or call:

```
woo_list_reachable_tools(limit: 200)
```

The result contains paged descriptors with tool name, object, verb, aliases,
arguments, and description. A development identity should see starting-room
tools and tools on contextual fixtures.

## Common configuration mistakes

- Using `/mcp` documentation from the classic stack instead of
  `/net-api/mcp`.
- Presenting `guest:<name>` instead of an issued `apikey:` credential.
- Sending the API key on every post-initialize request instead of the returned
  `Mcp-Session-Id`.
- Treating the session id as a durable identity or logging either bearer.
- Assuming observations are replayable after the live MCP queue is lost.

The normative target protocol is
[`../../spec/protocol/mcp.md`](../../spec/protocol/mcp.md); migration status is
tracked by [`../../spec/operations/net-cutover.md §NC9`](../../spec/operations/net-cutover.md#nc9-v2-stack-decommission).
