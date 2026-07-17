# Pre-Net stack retirement plan

Date: 2026-07-17. Status: active implementation plan for NC9 preparation.

The public browser and MCP default are Net, but deleting the classic stack
still has three concrete blockers. They must be cleared in this order because
the first is live production routing, the second preserves the development
inner loop, and the third preserves behavior coverage while the implementation
is removed.

The shared substrate is not part of this deletion. `src/core`, `WooWorld`, the
Tiny VM, DSL/compiler, object semantics, and their roughly eighty test files are
used by Net and stay. “Classic” below means the pre-Net transport, host,
repository, and Durable Object compositions around that substrate.

## 1. Retire the live admin dependency

`POST /admin/purge-inactive-guests` was the only default-path server route that
unconditionally resolved `WOO` while `WOO_NET_DEFAULT` selected Net. The
classic operation owns a WORLD session/socket heuristic and Directory cleanup;
it is not a generic guest primitive.

A literal Net port would be incorrect:

- Net session cells expire at their actor-cluster authority and the scope alarm
  reaps the cell plus local/foreign presence rows.
- Elastic guests carry `ephemeralActor`; the same reaper retires their live
  placement after the last session.
- A pooled guest is exclusively claimed before the install-declared reset verb
  runs, so its durable inventory/profile/location is normalized before a new
  bearer is exposed.
- Net does not persist classic socket attachment state. Adding it only to
  reproduce the five-minute detached-session cutoff would create a second
  session-liveness authority.

Decision: with `WOO_NET_DEFAULT` enabled, the authenticated admin POST returns
`410 E_OBJNF` without resolving `WOO`. Selector-off rollback deployments retain
the existing signed WORLD/Directory purge. The edge-routing regression must
fail if the Net-default request touches the classic namespace.

This removes the live dependency; it does not delete the classic implementation
until the rollback contract is renounced under NC9.

## 2. Replace local development and stdio

Current default commands are classic compositions:

- `npm run dev` starts `src/server/dev-server.ts`,
  `LocalSQLiteRepository`, `McpGateway`, `shadow-browser-node`, and the v2 turn
  network WebSocket.
- `npm run mcp:stdio` starts the in-memory classic `McpHost`.

Before deleting `src/server/*` or `src/mcp/gateway.ts`, provide interactive Net
compositions using the same `src/net` pipeline as production:

1. A local persistent Host binding and bootstrap/install path suitable for the
   browser dev server.
2. Net HTTP/WS routes behind the existing Vite-facing origin, with the normal
   Net client configuration selected by default.
3. A stdio adapter over the Net MCP/session surface, not a second command or
   execution implementation.
4. State reset, deterministic fixtures, and operator diagnostics at least as
   usable as the current inner loop.
5. Browser-local smoke before workerd, followed by the existing workerd lane.

Only after parity is demonstrated should `npm run dev` and `npm run mcp:stdio`
change defaults. If rollback tools remain during the NC8 bake, name them
explicitly (`dev:classic`, `mcp:stdio:classic`) so they cannot masquerade as the
primary architecture.

## 3. Re-home classic transport coverage

The default suite intentionally contains many classic consumers. Deletion must
classify tests by contract, not by import name:

1. **Keep unchanged:** shared object/VM/DSL/semantics tests under `src/core`.
2. **Port to Net:** unique guarantees for persistence across restart, session
   lifecycle, sequenced cross-scope commit, fanout/replay, browser-local turns,
   and public MCP/WS envelopes.
3. **Keep temporarily as rollback tests:** assertions needed while classic
   routing remains deployable during the bake.
4. **Delete only with evidence:** tests whose exact contract is already covered
   by a named Net fake-DO/workerd/browser scenario.

Maintain a contract matrix while moving files: classic test, behavior asserted,
Net replacement, lane, and deletion commit. Counts alone are not evidence of
coverage. The fake-DO lane is fast but cannot replace workerd checks for durable
storage isolation, serialization, cold starts, or cross-DO RPC.

## Exit gates

NC9 class deletion remains separately gated by the normative order in
`spec/operations/net-cutover.md`: a full zero-traffic bake, code/binding removal
and redeploy, verified final backup, then a `deleted_classes` migration. This
plan clears dependencies; it does not authorize class deletion, merge, push, or
deploy by itself.
