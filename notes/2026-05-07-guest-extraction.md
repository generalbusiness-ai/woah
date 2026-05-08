# Extracting `$guest` from core

Date: 2026-05-07

Status: Design only. No code moves yet.

## Goal

A guest-free woo deployment is trivial: ship without the guest catalog and
anonymous auth is rejected. Removes `$guest`-shape coupling from `src/core/`,
in line with the rule that core does not branch on world-shape or bundled
catalog identities.

## Design

The auth path makes one decision: *for this request, which actor is the
session bound to?* It splits in two:

1. **Find the actor.** Identity-directory lookup keyed by claim. Pure data.
2. **Authenticate.** A `:authenticate(claim)` verb on the resolved actor.
   Pure woocode. Returns `this`, returns another objref (e.g. `$guest` swaps
   to a free pool sibling), or raises.

### Front door (native, transport)

Validates the wire and produces a typed claim. Two fast paths stay native
and skip the directory:

- `{ kind: "session", id }` — session-table lookup.
- `{ kind: "apikey", id, secret }` — HMAC against `$system.api_keys`.

Other shapes go through the binding layer:

- `{ kind: "oidc", iss, sub, ... }` — front door verifies the JWT.
- `{ kind: "anonymous" }` — no identity carried.

OIDC is the planned long-term front door; sessions live alongside it. OIDC
tokens are short-lived and shouldn't be re-validated per WS frame; the
session table holds live binding state (actor, attached sockets, MCP
session id, idle/grace timers, reap hook).

### Identity directory (core abstraction)

Single interface in core:

```ts
resolveIdentity(claimKind: string, identityKey: string): Promise<ObjRef | null>
```

The CF backing requires an internal HTTP hop, so the interface is async.
The in-memory and SQLite backings resolve synchronously and return an
already-resolved promise.

Backed by:

- **In-memory** Map for tests/dev-server.
- **Local SQLite** `identity_route` table for the standalone server.
- **Cloudflare** `identity_route` table on the existing Directory DO,
  proxied via the same internal HTTP surface as `object_route` and
  `session_route`.

Schema:

| Column | Type | Notes |
|---|---|---|
| `claim_kind` | TEXT | `oidc`, `anonymous` |
| `identity_key` | TEXT | `iss\|sub` for OIDC; `""` for anonymous |
| `actor` | TEXT | objref — instance for named identities, *class* for anonymous |
| `updated_at` | INT | ms epoch |

PK `(claim_kind, identity_key)`.

A directory miss is a reject. That is the entire policy for "is this
allowed."

In this refactor, rows are written only by catalog install seed-hooks.
Mutation remains worker-internal. Runtime in-world enrollment (e.g. OIDC
account-linking) is a separate, deferred design.

### Per-actor `:authenticate(claim)`

Generic verb on `$root`, default body raises `E_NOSESSION`. Catalog classes
override per their needs.

Returns:

- `this` — bind me.
- another objref — bind that one (the LambdaMOO swap; `$guest` uses this).
- raise — reject.

Per-class behavior, all woocode:

- `$root:authenticate(claim)` — default. Raises.
- `$player:authenticate(claim)` — for `kind = oidc`, accepts (front door
  verified the JWT, directory matched the player). Otherwise raises.
- `$guest:authenticate(claim)` — for `kind = anonymous`, picks a free
  member of `this.pool`, marks it busy, returns it.

#### Pre-auth dispatch context

Core has no actor when it makes this call. It synthesizes a complete
`CallContext` (per `src/core/world.ts:1882`) with these fixed values:

| Field | Value |
|---|---|
| `actor`, `player`, `task_perms`, `progr` | `$wiz` |
| `caller`, `callerPerms` | `#0` |
| `space` | `#-1` |
| `seq` | `-1` |
| `session` | the synthesized pre-auth session id (placeholder; no session row yet) |
| `thisObj`, `definer` | the directory-resolved actor or class |
| `verbName` | `"authenticate"` |
| `message` | `{ actor: $wiz, target: <resolved>, verb: "authenticate", args: [claim] }` |
| `observations` | empty list, discarded after the call |
| `hostMemo` | empty |

This matches LambdaMOO's `do_login_command` — the connection runs under
the system principal until login completes. It is not a new dispatch
surface; it is a documented invariant about the one case where core
synthesizes a calling actor. Observations emitted during `:authenticate`
are dropped (no space to broadcast to, no session to attach to).

Per `spec/discovery/catalogs.md` §CT13.2, every verb runs with
`progr = verb_owner_at_compile`. Catalogs that ship `:authenticate`
overrides must be installed by `$wiz`, otherwise their verbs run with the
installer's lower authority.

#### Serialization and rollback

The auth path mutates world state (`$guest:authenticate` marks a pool
member busy). It must therefore go through the host queue and be wrapped
in a behavior savepoint, the same as any other state-mutating verb call:

- `auth(claim)` enqueues onto `enqueueHostTask` (`src/core/world.ts:1762`)
  so two simultaneous anonymous auths cannot pick the same free guest.
- The VM call to `:authenticate` runs inside a savepoint that covers
  the verb call *and* the subsequent session mint. If the session mint
  fails (persistence error, etc.), the savepoint rolls back the
  `free_to_use` flip so the guest returns to the pool.
- The session is persisted before the savepoint commits. The bind to
  the returned actor is therefore atomic with the pool-state change.

### Class-as-binding for anonymous

The directory entry for `(anonymous, "")` points at the *class* `$guest`,
not an instance. `$guest:authenticate` returns a free pool member. Core
calls `:authenticate` on whatever objref the directory returns; classes
are first-class objects so verb dispatch on them is identical to instance
dispatch. No "is this a class?" branch in core.

### Pool list

`$guest` has an own property `pool: list<obj>` holding objrefs of the pool
members. `$guest:authenticate` walks `this.pool`, filters by each member's
`free_to_use` property, picks one. The list is explicit because the woo
DSL has no `:descendants`/`:children`/`:leaves` builtin; adding one is a
reasonable separate proposal but not required here.

### Auth flow end-to-end

1. Token arrives at front door.
2. Front door classifies. `session:` and `apikey:` use existing fast paths.
   Other shapes produce a verified claim.
3. Core calls `resolveIdentity(claim.kind, claim.identity_key)`. Miss →
   `E_NOSESSION`. Hit → `actor_or_class`.
4. Core calls `actor_or_class:authenticate(claim)` via the VM under the
   pre-auth dispatch context.
5. Verb returns an actor or raises.
6. Core mints a session bound to the returned actor.

## Core changes

### `src/core/world.ts` — deletes

- `allocateGuest`, `placeAllocatedGuest`, `resetGuestOnDisconnect`,
  `releaseGuest`, `rebuildGuestPool`, `guestInventoryFallback`, the
  `guestFreePool` field, and call sites.
- `inheritsFrom(actor, "$guest")` checks at ~5295 and ~5342. TTL/grace
  policy stays native, keyed on `session.tokenClass`.
- The `guest_initial_room` carve-out in the snapshot/projection path.
- `guest_on_disfunc` and `return_guest` native handlers.

### `src/core/world.ts` — added (small)

- `auth(claim)` becomes async: directory lookup → VM call to
  `:authenticate(claim)` → session mint.
- A generic `:on_disfunc` invocation at session reap, applied to every
  actor (not just guests).

### Identity directory implementations

- `IdentityDirectory` interface is defined in `src/core/repository.ts`.
  Auth code calls only this interface.
- In-memory and SQLite implementations live in `src/core/` and
  `src/server/` respectively, alongside the existing repository
  backings.
- The CF-DO implementation lives in the worker/host adapter layer
  (`src/worker/`), since it depends on internal HTTP to the Directory
  DO. Core does not import worker modules.

### `src/worker/directory-do.ts` — added

- `identity_route` table; `register-identity` / `unregister-identity` /
  `resolve-identity` HTTP routes mirroring the object/session route
  surface. Existing internal-only auth header gates mutation.

### `src/core/bootstrap.ts`

Deletes:
- `$guest` create + describe (508, 532).
- `$guest:on_disfunc` native binding (637).
- `seedGuests` function (677–708) and its caller.

Adds:
- `:authenticate(claim)` verb on `$root` raising `E_NOSESSION` by default.
  Pure woocode. No new seed object.

### `src/core/catalog-installer.ts` — added

New seed-hook kind `register_identity`:

```ts
| { kind: "register_identity"; claim_kind: string; identity_key: string; actor: string }
```

This is the entire authoring contract for "make this actor (or class)
reachable as an identity binding."

#### Install/uninstall failure semantics

The identity directory in CF mode lives on a separate DO from the world.
Catalog install crosses that boundary, so ordering and idempotence matter:

- **Ordering on install.** Run all `register_identity` writes *after* the
  catalog's classes and instances are committed in the world, but
  *before* the `$catalog_registry` install record is written. If a
  Directory write fails, the world transaction rolls back; the catalog
  is not "installed" from the registry's view, and the operator can
  retry.
- **Ordering on uninstall.** Reverse: remove `register_identity` rows
  *before* removing world objects. If the directory delete succeeds but
  the world delete fails, anonymous claims start missing immediately and
  retry is safe.
- **Idempotence.** `register_identity` writes are
  `INSERT OR REPLACE` on `(claim_kind, identity_key)`; deletes are
  `DELETE … WHERE`. Re-running a partial install is a no-op for already-
  written rows.
- **Repair.** A divergence (Directory row exists, world has no
  installed-record; or vice versa) is detected by the same
  bundled-catalog adopt path that handles partial bootstraps
  (`spec/discovery/catalogs.md:289`). Cold-init reconciles by
  re-running the seed-hooks of any installed catalog whose registry
  record is missing the corresponding directory rows.

### Token-class label

`"guest" | "bearer" | "apikey"` in `types.ts`/`repository.ts`/
`sql-shape.ts`/`protocol.ts:64` stays — transport classification, not
class identity. The REST `/api/auth` accept-list keeps `guest:` so the
front door knows to construct an anonymous claim; it does not need
`$guest` to exist.

### Apikey is not in `identity_route`

`apikey:` keeps its current native fast path (`world.authApiKey` against
`$system.api_keys`). Routing it through the directory adds a cross-DO hop
to every auth without improving correctness or layering. Revisit when OIDC
lands.

## Guest catalog

In `classes`:

- `$guest`, parent `$player`, owner `$wiz`.
  - `pool: list<obj>` (default `[]`).
  - `free_to_use: int` (default 1).
  - `:authenticate(claim)` — for `kind = anonymous`, returns a free pool
    member.
  - `:on_disfunc()` — overrides generic reap; runs reset, sets
    `free_to_use = 1`.
  - `:do_reset()`, `:eject(...)` — helpers.

In `seed_hooks`:

- `create_instance` for each pool member `guest_1..N` from `$guest`.
- `set_property` (`append_unique`) on `$guest.pool` per member.
- `register_identity` `(anonymous, "", $guest)`.
- Optional: a guest-local config property replacing today's
  `$system.guest_initial_room`.

A no-guest deployment ships without this catalog: no `(anonymous, "")`
row, anonymous claims miss, core rejects. No `$guest` class to find.

## Spec edits

These are implemented specs that codify the current design and must be
updated before any code moves:

- **`spec/semantics/bootstrap.md`** — drop `$guest` from §B2 universal
  seed inventory; drop §B1 step 6 (guest pool seeding); reframe `$nowhere`
  rationale without mentioning guests; add `:authenticate(claim)` default
  to the `$root` verb inventory.
- **`spec/semantics/identity.md`** — rewrite §I3 around the
  identification/binding split: directory lookup as the binding step,
  `:authenticate(claim)` as the per-actor policy hook, anonymous handling
  as catalog-supplied. Reframe scope from "guest baseline" to
  "identity baseline."
- **`spec/discovery/catalogs.md`** — remove `$guest` from §CT3.1
  universal-corename list; add the `register_identity` seed-hook kind.
  Manifests referencing `$guest` must use `<alias>:$guest` once it lives
  in a catalog. Third-party catalogs that referenced `$guest` unqualified
  will break and need a major-version bump — call this out.
- **`spec/semantics/permissions.md`** + **`spec/semantics/identity.md`** —
  document the synthesized pre-auth dispatch context
  (`actor = $wiz, task_perms = $wiz, caller = #0`) and the requirement
  that auth-policy catalogs install as `$wiz`.
- **`spec/reference/persistence.md`** — document `identity_route`
  alongside `object_route` and `session_route`.

Audit bundled catalog manifests for unqualified `$guest` references
(probably none — `$guest` isn't used by the demo catalogs — but verify).

## Adopt migration for existing worlds

Already-deployed worlds have `$guest` and `guest_1..8` from the current
bootstrap. After the refactor, fresh boots no longer seed them, and the
guest catalog would try to create them and collide
(`src/core/catalog-installer.ts:1717`).

The bundled-catalog adopt path already exists for exactly this case
(`spec/discovery/catalogs.md:289`). Plan:

- Ship the new `guest` catalog as bundled `@local`.
- Ship a local-boot migration entry per
  `spec/discovery/catalogs.md` §CT5.4.1: classify existing `$guest` and
  `guest_<N>` as catalog-managed, write the installed-record into
  `$catalog_registry`, repair verb shape from the manifest, run
  seed-hooks (including `register_identity`).
- Ship a Directory migration that creates the `identity_route` table.
- Public/runtime catalog installs continue to reject collisions; the
  adopt path is bundled-catalog cold-init only.
- Idempotent on second boot. Test on a local SQLite woo before merge.

Fresh-boot worlds see ordinary catalog install — no objects to adopt.

## Open questions

- **Async ripple beyond `auth()`.** Reap-time `:on_disfunc` makes the reap
  path async. Affects `reapExpiredSessions` (`src/core/world.ts:5272`),
  `reapSession` (5349), `endSession` (1540), `sessionAlive` (1531), and
  apikey-revoke. Test fallout expected in `tests/persistence.test.ts`,
  `tests/mcp.test.ts`, `tests/auth-credentials.test.ts`,
  `tests/core.test.ts`.
- **VM-during-reap re-entrancy.** If `:on_disfunc` suspends, the reap
  must commit partial state safely. Lean: synchronous-only at first.
- **Directory hop on auth in CF mode.** `oidc` and `anonymous` claims
  pay a cross-DO RPC. Add a per-host LRU keyed on
  `(claim_kind, identity_key)`, invalidated on `register-identity` writes
  — same pattern as `object_route` caching. The anonymous row is static
  after install, so it's a near-trivial cache target.
- **Runtime in-world identity enrollment.** Deferred. When it lands, it
  needs a wizard-only builtin or system verb that writes `identity_route`
  with defined permissions, idempotence, unregister semantics, and
  interaction with the Directory's internal HTTP surface.
- **OIDC discovery / IdP config storage.** Worker config / wrangler
  secrets, not the world. Pin down before OIDC implementation.
