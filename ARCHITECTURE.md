# Port — architecture

Strong layering rules. **Read this before adding to core or worker code.**
The spec proper lives under `spec/`; this file is the operating-instruction
distillation that keeps the layers from rotting into each other.

The shape, top to bottom:

```
┌──────────────────────────────────────────────────────────────┐
│  UI (src/client, browser, MCP clients, REST clients)         │   wiring only
├──────────────────────────────────────────────────────────────┤
│  Catalogs (catalogs/*)                                       │   all behavior
│   - classes, verbs, properties, schemas, seed_hooks          │
├──────────────────────────────────────────────────────────────┤
│  Protocols (src/mcp, src/core/protocol.ts, src/server)       │   transport
│   - MCP, WebSocket, REST. No verb logic.                     │
├──────────────────────────────────────────────────────────────┤
│  Engine (src/core)                                           │   primitives
│   - World, VM, dispatcher, builtins, host bridge contract,   │
│     observation routing, audience computation                │
├──────────────────────────────────────────────────────────────┤
│  Hosts (src/worker, src/server/dev-server.ts)                │   execution
│   - Durable Objects + decentralized routing on CF;           │
│     SQLite/JSON folders locally. Pluggable by interface.     │
├──────────────────────────────────────────────────────────────┤
│  Storage (CFObjectRepository, LocalSQLite*, InMemory*)       │   persistence
└──────────────────────────────────────────────────────────────┘
```

## Hard rules

1. **The world is functional without any UI.** Every catalog, every verb, every
   primitive must be exercisable through MCP / REST / WS / direct world API.
   The browser SPA is one renderer. If a feature only works because the SPA
   does something special, that feature is incomplete.

2. **Behavior lives in catalogs, not core.** If you find yourself adding a
   native handler that names `pinboard`, `dubspace`, `tasks`, `the_chatroom`,
   `operators`, `mount_room`, or any other catalog vocabulary in `src/core/` or
   `src/worker/`, stop. Add a builtin or a generic primitive instead, and let
   the catalog source verb call it. The two acid tests:
   - Could a third-party catalog with no shared code reach the same effect?
   - Is the name in core a category (`$space`, `$actor`) or a specific instance
     (`the_chatroom`)? Categories are fine; instances are a smell.

3. **Lean LambdaCore.** The default class hierarchy and verb conventions
   (`$root_object`, `$thing`, `$container`, `$room`/`$space`, `$player`,
   `$actor`, `:look`, `:look_self`, `:title`, `:enter`, `:leave`, `pass()`
   for inheritance) follow LambdaMOO's LambdaCore unless we have a specific
   reason to diverge. When in doubt, do what LambdaCore did. Don't reinvent
   the conventions; document the divergences.

4. **Core exposes primitives; catalogs compose them.** When the engine grows
   a new capability (cross-host audience override, presence updates, mounted
   spaces, etc.), it lands as either a `WooWorld` method called by source via
   a builtin (see `set_presence`, `observe_to_space`) or a `HostBridge`
   contract method. **Not** as a native verb handler tied to one catalog's
   class.

5. **Hosts are pluggable.** `WooWorld` knows nothing about Cloudflare. The CF
   worker (`src/worker/persistent-object-do.ts`) implements the `HostBridge`
   interface; the dev server (`src/server/dev-server.ts`) does the same with
   in-process wiring; tests use `LocalHostBridge` (`tests/conformance.test.ts`,
   `tests/core.test.ts`). New hosts implement the bridge; they don't fork the
   engine. Storage is the same: `ObjectRepository` is the only contract.

6. **Routing is decentralized, not catalog-aware.** Routing knows about
   `host_placement: self`, anchors, and the directory. It does not know what
   a chatroom is. If a routing decision starts to feel catalog-specific, the
   catalog is leaking — fix the catalog or extend the routing primitive
   generically.

7. **Cross-host calls are explicit and bounded.** Any synchronous host RPC
   participates in the wait-for graph in `spec/protocol/hosts.md §3.5`. New
   internal routes get a `route_class` (`read`, `dispatch`, `owner_mutation`,
   `mirror`, `broadcast`) and respect the no-cycle rule. Owner mutations
   return enough state for the originator to apply local mirrors (see
   `moveObject` returning `{old_location, location}` and the
   `suppressMirrorHost` pattern). Cross-host I/O on a hot path is a defect
   to flatten, not a feature to accept.

8. **Permissions are per-frame, not per-protocol.** A verb's `progr` (verb
   owner) and the calling actor's identity reach the engine the same way
   regardless of whether the call came in via MCP, WS, or REST. The protocol
   layers map their own auth to a session/actor pair and hand off; they
   never inject `progr` or special-case permissions.

## Layer responsibilities

### `src/core` — engine

Owns: object model, properties, verbs, parent/feature lookup, the Tiny VM,
sequenced and direct call dispatch, host bridge contract, observation
routing, audience computation, presence updates, host-scoped world
import/export, catalog install/repair, bootstrap, bytecode + DSL compiler.

Does *not*: know any catalog name, persistence backend, or transport. May
not import from `src/worker` or `src/client`.

### `src/mcp`, `src/core/protocol.ts`, `src/server`

Transport adapters. Translate inbound frames (MCP tools/list+tools/call,
WS ops, REST routes) into `WooWorld` calls. Map results back. No verb logic.
The MCP host owns the per-session tool list and observation queue but does
not curate the world's behavior; tools are derived from `tool_exposed`
verbs the actor can reach.

### `src/worker` — Cloudflare host

Implements `HostBridge` over Durable Object subrequests, `ObjectRepository`
over DO storage, and the directory routing (`DirectoryDO`) that maps object
ids to host ids. Adds the deployment-specific concerns: subrequest depth
budget, internal-auth signing, host-scoped seed merge on cold start,
hibernation/WS rehydration. **All of this is invisible to verbs.**

### `src/client` — browser SPA

Renders the world. Subscribes via WS, presents chat / pinboard / tasks /
dubspace UIs. Sends standard direct or sequenced calls; never speaks
catalog-private wire formats. UI state (zoom, scroll position, focus,
chat draft) lives in the client. World state mutates only through verbs.

### `catalogs/*`

The world. Each catalog is a manifest plus its own design doc. Classes,
verbs, properties, schemas, and seed_hooks. Verbs are written in woocode
(compiled by `src/core/dsl-compiler.ts` to Tiny VM bytecode). Catalogs
declare dependencies on each other (`@local:chat`) and resolve through the
same install path that a federated tap would.

## Anti-patterns to refuse

- A native handler in `src/core/world.ts` that pattern-matches on a
  catalog's class name or property name. Use a builtin instead.
- A worker route that knows about `the_chatroom`/`the_pinboard`/etc. by id.
- A client tab that bypasses verbs and writes to repository state.
- A catalog migration that re-implements something already in core.
- A wire frame format unique to one catalog. Use `observe`/`emit` with
  the catalog's schema; rendering is a UI concern.
- A `if (catalog === "chat")` branch anywhere outside `catalogs/chat/`.

## Migrations

A live deploy can't drop the world and re-seed; existing actors, sessions,
notes, tasks, drum patterns, and presence lists must survive. Migrations
are how a catalog evolves its classes/verbs/seeds against worlds that were
installed against an earlier shape. The discipline:

1. **Manifest schema sync is autodetected.** Routine bundled-catalog source,
   verb metadata, property-def, schema, and seed-hook drift is detected by
   comparing the current manifest against stored state. The gateway repairs
   from the manifest and records a content-derived
   `local-catalog-schema:<catalog>:<hash>` marker. Do not add a hand-written
   migration id just to reapply the current manifest.

2. **One-shot boot migrations are for non-inferable changes.** Data
   conversions and compatibility repairs that cannot be derived from manifest
   drift still use stable ids in `src/core/local-catalogs.ts` (date + slug,
   usually with `only: "<catalog>"`). Once such an id is in
   `$system.applied_migrations`, it never re-runs on that world. Don't rename,
   reorder, or recycle those ids — past worlds remember them.

3. **Stored runtime state survives reseeding.** `mergeSeedObject` keeps
   the stored property value when its `propertyVersions[name]` is `>=`
   the seed's. That's why pinboard notes, dubspace operators, and chat
   subscribers don't get wiped on every deploy. A catalog that genuinely
   wants the seed default to overwrite the stored value bumps the
   manifest property's default-value version. State that is *always*
   stored-side-of-truth (`subscribers`, `operators`, `presence_in`,
   `next_seq`, `last_snapshot_seq`, `applied_migrations`,
   `catalog_migration_records`, `bootstrap_token_used`, `wizard_actions`,
   `installed_catalogs`) is on
   the `DYNAMIC_HOST_SEED_PROPERTIES` allowlist in `src/core/bootstrap.ts`
   and never takes a seed value.

4. **Schema sync runs on the gateway; data conversions run where data lives.**
   `installLocalCatalogs` runs at `createWorld` time on the gateway's
   `WORLD_HOST`. Cluster DOs (`host_placement: self`) pick up repaired
   verbs/classes from a fresh gateway host seed. A new host DO records the
   host-scoped content-addressed schema plan as covered by that seed; a host
   with stored state verifies/applies the scoped plan locally before recording
   it. Host lifecycle is not allowed to run opaque repair over a partial slice.
   Idempotent data plans run on the host that owns the data.

5. **A migration belongs to exactly one catalog.** Cross-catalog
   migrations bind catalog vocabulary in core. If two catalogs both need
   a related change, write two migrations. The `only:` filter enforces
   this at the call site.

## When you must touch core

The check, every time:

1. Could the same effect ship as a builtin + a catalog source verb?
2. Could the same effect ship as a `HostBridge` method + a host
   implementation?
3. Could the same effect ship as a routing/bootstrap primitive that any
   catalog would benefit from?

If the answer to all three is no, write the smallest possible engine
change with a clear name, document it in `spec/semantics/`, and add
conformance coverage.

## See also

- `SPEC.md` — the actual specification, with stable section numbers.
- `spec/protocol/hosts.md §3.5` — wait-for graph, route classes, no-cycle
  rule, owner-mutation deltas.
- `spec/protocol/mcp.md` — agent surface; reachability and stable control
  tools.
- `spec/semantics/builtins.md` — the engine builtin set catalogs may call.
- `catalogs/README.md` — the catalogs index and the per-catalog DESIGN
  docs that explain what the world *does*.
