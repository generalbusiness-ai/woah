---
date: 2026-05-01
status: implemented
---

# Identity, sessions, and actors

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

The contract for who is connected, what an actor is, and how a session binds a client to an actor.

Baseline scope: enough to support guest connections to a space; enough to specify reconnect, two-tab, and disconnect behavior. **Out of scope** here: account creation with credentials, multi-character users, recovery flows, federated identity. Those live in the credentialed identity and deferred federation specs.

---

## I1. Actor

An **actor** is an object that can make calls (per [core.md §C5](core.md#c5-actors)). The runtime treats an actor as a principal:

- has identity (an objref that persists across sessions)
- has authority used in `progr` checks (see [permissions.md §11](permissions.md#11-permissions-and-security))
- is the value of `message.actor` on calls it originates

`$actor` is the conventional base class. `$player` extends `$actor` for actors with attached client sessions.

Not every object is an actor. The runtime decides whether to permit a given object as `message.actor` based on its parent chain (must inherit from `$actor`) and any policy the world layers on top.

---

## I2. Three layers: actor, session, connection

The runtime distinguishes three things that look similar but have different lifetimes. Conflating them is the source of most identity bugs (guest pool exhaustion, ghost presence, audit confusion).

| Layer | Concept | Lifetime | Persisted? | Identifier |
|---|---|---|---|---|
| **Actor** | A `$player` (or other `$actor`-descended) object in the world. The principal that authors calls and is checked for `progr`. | Indefinite — lives in the world. Guests are recycled, not deleted. | **Yes**, in object storage. | objref / ULID |
| **Session** | A reconnect credential bound to an actor. Lets a client re-attach without re-auth. | Live while one or more connections are attached; then bounded by grace/TTL after the last connection detaches. | Credential metadata and session-scoped command focus (id, actor, active_scope, expires_at, last_detach_at). **Not** the list of attached sockets. | unguessable random id, at least 128 bits |
| **Connection** | A live transport attachment — one websocket, or one in-flight REST request. | Open-to-close of the transport. | **No** — in-memory only on the player host. Lost on host restart by design. | host-local socket id |

Concretely:

- An actor exists whether anyone is connected to it. A guest sitting in the pool is still a `$player` in the world.
- A session exists from `op: "auth"` until reap. Across that window, zero or more connections may be attached.
- A connection exists from socket-open to socket-close. One session may have multiple concurrent connections (one per browser tab); see §I5.

**`is_connected(actor)`** is derived: "any live connection has `actor_ref == actor`." Not a stored property. Implementations may cache it, but the truth is the connection registry.

The persisted session record carries:

| Field | Meaning |
|---|---|
| `session_id` | opaque, unguessable random identifier; the client uses this to reconnect |
| `actor` | objref of the bound actor |
| `started_at` | ms timestamp |
| `active_scope` | objref of this session's command focus. Cross-host call envelopes carry this field so the receiving host can evaluate `location(this)` and `origin`-shaped observations against the caller's active session scope before deferred host effects reconcile. Older storage rows and transitional wire payloads may also expose the legacy alias `current_location`. |
| `expires_at` | deadline for an unattached/resumable session. Active websocket connections keep the session attached; implementations may renew or extend `expires_at` while attached. |
| `last_detach_at` | ms timestamp of the most recent connection close (null while connected). Drives the grace-period reap path. |

It does **not** carry a list of attached sockets — those live in the in-memory connection registry on the player host. Persisting socket ids creates the failure mode where a server restart leaves orphaned "attached" entries that never clear.

---

## I3. Auth (guest baseline)

Guest auth is intentionally minimal:

```
client → server: { op: "auth", token: string }
server → client: { op: "session", actor: ObjRef }
```

The token is a string; the server interprets it. Guest-baseline vocabulary:

- **`guest:<random>`** — server creates a fresh `$player` (or pulls one from a pre-seeded guest pool), binds it to a new session, and returns the actor's objref. Guest actors persist for the session and the guest grace period after the last connection detaches (defaults in §I6.2).
- **`session:<session_id>`** — if the session is alive in the server's session table, auth resumes it. If expired, the server replies with `op: "error"` code `E_NOSESSION`; the client must establish a new session.
- **`bearer:<...>`** — reserved for credentialed auth.

The token vocabulary is server policy; the wire format is `string`. The contract is "the server tells the client what token to present next" — typically by surfacing a `session:<id>` token in the initial `op: "session"` frame's payload (when this is added) or via a side channel.

---

## I4. Reconnect

A client that loses its websocket reconnects with the same `session:<session_id>` token. If the session is alive:

- Actor binding is restored.
- Client receives a fresh `op: "session"`.
- Server resumes pushing `applied` frames for the spaces the actor is observing.
- Client uses gap recovery ([events.md §12.8](events.md#128-sequenced-calls-with-gap-recovery)) to backfill missed seqs per space.

If the session has expired or its guest actor has been recycled, reconnect produces a different actor identity. The client treats this as a fresh login.

---

## I5. Two tabs, one actor

A client may open multiple tabs and present the same `session:<id>` token from each. Default policy:

**Multi-attach.** Each tab gets its own websocket; all bound to the same session and actor. `applied` frames fan out to every attached websocket. Calls from any tab are equally authorized as the actor.

This matches the principle that an actor is an actor regardless of how many UIs render it. Boot-prior (LambdaMOO's `boot_player` model — second connection bumps the first) is a deferred policy choice.

---

## I6. Disconnect and reap lifecycle

The lifecycle has three steps, in this order:

### I6.1 Connection close

1. The connection record is dropped from the host's in-memory registry.
2. If other connections remain on the same session, broadcast continues to them; the session stays *attached*.
3. If this was the last connection: set `session.last_detach_at = now`, and ensure `expires_at` is no earlier than `now + grace`. The session enters *detached* state. No reap yet.

`READ` tasks waiting for input from this player ([tasks.md §16.6](tasks.md#166-read-tasks)) continue to wait — they belong to the actor, not the connection. They are killed at session reap (§I6.3), not connection close.

### I6.2 Grace period

A reattach during grace re-binds the new connection to the existing session and clears `last_detach_at`. The actor is unchanged, presence is preserved, the client can resume by gap-recovering applied frames per space.

Grace defaults are token-class dependent:

| Token class | Default grace | Default total session TTL |
|---|---|---|
| `guest:` | 60 seconds | 5 minutes while unattached; active connections keep the session alive |
| `session:` (renewing) | inherits from underlying token class | unchanged on resume |
| `bearer:` / `apikey:` (credentialed) | 5 minutes | 24 hours rolling while attached |

Operators may override per world via `$server_options.session_*`.

### I6.3 Reap

While at least one live connection is attached, the session is not reaped for ordinary timeout. When no live connections are attached and either `session.last_detach_at + grace < now` or `now > session.expires_at`, the runtime reaps:

1. Kill any `READ` tasks for this actor (`E_INTRPT`).
2. Remove this session from every space's `session_subscribers` list. The runtime derives the `space.subscribers` actor set from remaining live session entries. In hosted deployments, the actor and space can live on different hosts; if a remote subscriber cleanup fails, later authoritative reads of the space audience may confirm stale entries and lazily remove them.
3. Call `actor:on_disfunc()` if defined. This is where guest reset happens (§I6.4). Errors are caught and logged; reap continues.
4. Delete the session record.

After reap, the *actor* may persist or not depending on its class:

- **Guest actors** (`$guest`-descended): the disfunc returns the guest to the free pool. The objref persists; a future connection can bind to the same objref.
- **Credentialed actors** (`$player` non-guest): the disfunc resets per-session state if any. The actor stays in the world. A new auth establishes a new session.

### I6.4 Guest reset (the `:on_disfunc` convention)

Guests accumulate state during their session — they may have moved rooms, picked up artifacts, set their description, attached features. None of that should leak to the next user of that guest objref.

The convention is `:on_disfunc()` on `$guest`:

```woo
verb $guest:on_disfunc() {
  let where = this.location;       // room at disconnect time, if valid
  for item in this.contents {      // eject everything held
    item:moveto(item.home || where || this.home);
  }
  this:moveto(this.home);          // back to $nowhere
  this.description = "";           // wipe self-description
  this.aliases = [];               // wipe aliases
  this.features = [];              // detach all features
  // re-add to the free pool so the next auth can bind here
  $system:return_guest(this);
}
```

This is the LambdaCore `@disfunc` pattern under a clearer name. Guest inventory is ejected before the guest is moved home: an item with its own valid `home` returns there, otherwise it falls back to the disconnect room, then the guest's home. The guest `home` property is conventionally `$nowhere` (a seeded `$thing`; see [bootstrap.md §B6](bootstrap.md#b6-demo-instances)); operators may override per-guest if they want named lounges.

The disfunc runs with `progr = this.owner` (typically `$wiz`), so it has authority to reset state regardless of what permission flips occurred during the session.

---

## I7. Baseline permissions

For bundled demos, the default policy is "any authenticated guest with a live session present in the space can call." Concretely:

- `$space:call` accepts any actor/session pair recorded in the space's `session_subscribers` set, with `space.subscribers` maintained as a compatibility actor projection.
- A presence record is created by explicit movement (`:enter`, exit movement, or another `moveto(actor, space)` path), not merely by session establishment.
- No per-verb perm gating beyond presence.

This is the simplest possible policy. It works for the dubspace demo (every connected actor can wiggle every knob) and is *almost* enough for the taskspace demo, with one obvious refinement.

### I7.1 The per-claimer-update pattern

Taskspace surfaces the first natural sharpening of the open policy: once an actor has *claimed* a task, only that claimer (or a wizard) should be able to mark the task done. This is a five-line check inside the relevant verb:

```
verb #task:set_status(status) {
  if (this.assignee != null
      && progr != this.assignee
      && !is_wizard(progr)) {
    raise(E_PERM);
  }
  this.status = status;
  emit(this.space, { type: "status_changed", source: this, status: status });
}
```

This uses the existing [permissions.md §11.4](permissions.md#114-effective-permission) `progr` discipline — no new machinery. The pattern is "verb-body checks property-stored ownership against `progr`," and it generalizes to "only the assignee can…", "only members can…", "only the owner can…" without per-verb perm bits or capability tokens.

The baseline open policy and this per-claimer pattern between them cover the demo cases. Richer policies (role hierarchies, capability delegation, time-bound permissions) build on the same `progr` mechanism and live in credentialed/operational identity.

**The pattern is the generic role mechanism.** A "role" in woo is just an actor-typed property on an object; enforcement is just a verb-body check that `progr` matches that property. It scales to N roles by adding more properties and more checks: `task.reviewer` gates `task:review`, `project.approvers` (a list) gates `project:promote`, `project.requestor` (set once, audit-only) is read but never enforced. The runtime prescribes no role taxonomy — pick whatever roles fit the work, and put the gating in the verbs.

---

## I8. What's deferred

- Account creation with passwords or external IdP (OAuth/OIDC).
- Multi-character users (one human, multiple actors, switchable per session).
- Recovery flows (lost token, lost session, account migration).
- Identity federation (cross-world actor refs; reserved at [federation.md §24.2](../deferred/federation.md#242-the-trust-model)).
- Per-verb perm gating beyond presence (hooks exist; policy is deferred).
- Audit / wizard view of session-actor history.

All deferred to LATER.
