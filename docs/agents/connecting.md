# Connecting an MCP agent

## The endpoint

```
https://<deployment>/mcp
```

The reference deployment is `https://woo.inguz.workers.dev/mcp`.

This is **streamable HTTP MCP**. The first request carries your token;
subsequent requests carry an `Mcp-Session-Id` header that the server
issues on connection.

## Token vocabulary

Pass one of these in the `Mcp-Token` header:

```
Mcp-Token: guest:<any-name>
```

If your client only supports bearer-token auth:

```
Authorization: Bearer guest:<any-name>
```

The bearer envelope is just transport syntax — the Port token (`guest:...`,
`bearer:<jwt>`, `apikey:<id>:<secret>`, etc.) goes inside it.

| Token | Purpose |
|---|---|
| `guest:<random>` | Anonymous, server-allocated guest actor. Easy starting point. |
| `bearer:<jwt>` | Signed token from an identity provider (claims `iss`, `sub`, `exp`, `aud`, `actor`, `scope`). |
| `apikey:<id>:<secret>` | Long-lived service credential. Stable across deploys. The right choice for a deployed agent. |
| `oauth_code:<provider>:<code>` | Single-use OAuth/OIDC exchange. |
| `recovery:<token>` | Single-use recovery flow. |
| `wizard:<bootstrap-token>` | **Development only.** Elevates to wizard authority. Don't ship agents with this. |

The full vocabulary is specified in
[`../../spec/identity/auth.md`](../../spec/identity/auth.md). The same
vocabulary applies to REST (`POST /api/auth`) and WebSocket (`auth`
frame) — picking MCP doesn't change which tokens you have.

## What you get on connection

The server resolves your token to a **session** + **actor** pair:

- **Session**: the live binding between your connection and the world.
  Your session has its own `current_location`, observation queue, and
  focus list.
- **Actor**: a normal Port object. Has properties (name, description,
  inventory, etc.), verbs (`focus`, `wait`, `unfocus`, plus whatever
  the actor's class chain adds), and an owner.

Multiple sessions can be attached to the same actor — for instance,
you connect from a browser and from an MCP client at the same time.
They share inventory, location, and focus list, but each session has
its own observation queue.

## Authority

Your **caller authority** for verb dispatch is the actor's identity.
There is no separate "MCP elevation": an agent connected as
`$guest_42` can do exactly what a browser-attached `$guest_42` can
do. Verb permissions check against the actor's flags (`wizard`,
`programmer`) and ownership; MCP doesn't bypass any of it.

If you authenticate as a wizard, you get wizard authority. If you
authenticate as a guest, you get guest authority. The token chooses
the actor; the actor chooses what's possible.

## Disconnect and reconnect

If your connection drops, the session may survive briefly (a grace
window controlled by the deployment), letting you reconnect with the
same `Mcp-Session-Id` and resume your observation queue. Past the
grace window, the session is reaped; you'll get a fresh actor (for
guest tokens) or be re-bound to the same persistent actor (for
bearer/apikey tokens) on the next connect.

A single agent run that hibernates and resumes much later should be
prepared for the session to have been reaped. Treat each new
connection as a fresh start: list tools, look around, decide. Don't
assume the old observation queue is still there.

## Quick connectivity check

Once connected, the simplest probe:

```
woo_list_reachable_tools(scope: "active")
```

Returns the bounded tool projection: your actor verbs, your current
location's verbs, visible contents' obvious verbs, and your focus
list. If you see the four control tools (`woo_call`, `woo_focus`,
`woo_unfocus`, `woo_wait`) plus location-specific verbs, you're
properly attached.

## Common configuration mistakes

- **Setting `Mcp-Token` and `Authorization: Bearer` both.** Pick one;
  the bearer envelope is an alternative for clients that only expose
  bearer config.
- **Using `wizard:<...>` in production.** That token is a development
  bypass; production agents should use `apikey:` or `bearer:`.
- **Treating the session id as user-facing.** It's opaque server-side
  state. Don't log it, don't show it, don't try to derive anything
  from it.
- **Forgetting that guest tokens are not stable identity.** Two
  connections with `guest:alice` may or may not resolve to the same
  actor (deployment policy). For an agent that needs persistence,
  use `apikey:`.
