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

The stdio process is only a framing bridge. It forwards JSON-RPC to the HTTP
endpoint, remembers the returned session id, and closes the remote session on
EOF. It does not create an in-process world or dispatch verbs itself.

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
- `woo_call` submits one of those calls through the normal Net turn path.
- `woo_wait` long-polls the same presence-routed fanout used by WebSocket
  sessions.

MCP focus/unfocus wrappers are intentionally not part of reachability.
`notifications/tools/list_changed` is not yet implemented; re-list after
navigation or a containment-changing action.

## Disconnect and reconnect

Closing streamable HTTP MCP with `DELETE /net-api/mcp` and the session header
commits the same owner-sequenced close as browser logout. The stdio bridge sends
that DELETE when stdin closes. If a process disappears without closing, the
session expires and is reaped; reconnect with the API key and rediscover tools.
Undelivered `woo_wait` observations are live, at-most-once data and do not
survive gateway eviction.

## Quick connectivity check

Use standard `tools/list`, or call:

```
woo_list_reachable_tools(scope: "all", limit: 200)
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
