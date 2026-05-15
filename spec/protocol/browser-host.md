---
date: 2026-04-30
status: legacy
---

# Browser host bootstrap

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**.

Historical v1 wire-level interaction between a player host and a browser tab
hosting transient objects. The current browser transport is
[v2-turn-network.md](v2-turn-network.md); browser-hosted execution nodes will be
respecified on that substrate before implementation.

---

## 18. Browser host bootstrapping

### 18.1 Connection lifecycle

1. Browser opens WebSocket to `wss://world.example/connect?session=...`.
2. Edge worker routes to the player's host (singleton per session).
3. Player host accepts WebSocket, sends `{op: "session", player: "#42"}`.
4. Player host walks `player.transient_widgets` (a list-typed property convention) and for each entry sends `{op: "host_install", ...}` with the compiled bytecode and current property values.
5. Browser instantiates each as a transient object in its local VM.

### 18.2 Host_install payload

```ts
{
  op: "host_install",
  id: "~3",                     // local-host-unique
  parent: "#100",               // schema parent (defines verb skeletons it might call)
  bytecode: Bytecode,           // optional; verbs can be installed lazily
  props: { ... },               // initial property values
}
```

### 18.3 Calling a transient verb

When server-side code calls `~3@#42:render(event)`:

1. Originating host sees target host = `#42` (the player host).
2. RPC to player host with the call envelope.
3. Player host holds an open websocket to the browser; sends `{op: "host_call", ...}` with the frame.
4. Browser VM runs the verb to completion; sends `{op: "host_return", ...}` or `host_raise`.
5. Player host returns to originating host via cross-host RPC.

### 18.4 Trust at the browser boundary

The abstract host trust rules in [hosts.md §3.3](hosts.md#33-trust-model-across-hosts) and the host RPC invariants in [§3.4](hosts.md#34-host-rpc-invariants) apply to this transport. The player host is the enforcement point: it strips identity-changing fields from browser returns and rejects any operation the browser attempts at higher than its player's permission level. Returned values are bounded in size and typed against the calling verb's return type when known.

### 18.5 Disconnect

On websocket close:
1. Player host marks all `~`-children dead in its session table.
2. Any in-flight RPCs targeting those refs reply with `E_GONE`.
3. Tasks that were `awaiting_read` on the player remain (player may reconnect within a grace period and resume).
4. After grace period (default 5 minutes), `awaiting_read` tasks are killed.
