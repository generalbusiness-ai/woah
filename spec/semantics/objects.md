---
date: 2026-05-02
status: implemented
---

# Objects, identity, verb dispatch, properties

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

Covers the object model (§4), identity and addressing (§5), verb dispatch and inheritance (§9), and property definition/value/inheritance semantics (§10).

---

## 4. Object model

Every object has:

| Field | Type | Notes |
|---|---|---|
| `id` | objref | Stable, unique. Persistent: `#nnn`. Transient: `~nnn@host`. |
| `name` | str | Human-readable, not unique. |
| `parent` | objref \| `#-1` | Single inheritance. `#-1` = no parent. |
| `owner` | objref | The user object that controls this object. |
| `location` | objref \| `#-1` | The object's container. May be remote. May change at runtime (this is what "moving" means). |
| `anchor` | objref \| `null` | Atomicity scope. `null` (default) = no anchor cluster. Set = mutations to this object and to other objects sharing the anchor commit atomically together. **Immutable after creation.** Anchor does not by itself decide host placement — see §4.2. |
| `flags` | bitset | `wizard`, `programmer`, `fertile`. (See §11.) |
| `created`, `modified` | int (ms) | Audit. |

It additionally has tables of:

- **Verbs** defined locally as an ordered list of slots (slot, name, aliases,
  source, compiled bytecode, owner, perms, arg spec, version). Multiple local
  slots may share the same name; descriptors may refer to a verb by name or by
  1-based slot number.
- **Property values** locally (name, value, owner override, perms override).
- **Property definitions** locally (name, default value, type hint, owner, perms) — these introduce a new property visible to descendants.
- **Event schemas** declared locally (event-type → JSON-Schema-ish).
- **Children** (objects whose parent is this).
- **Contents** (objects whose location is this).

Behavior source may read selected object fields through property syntax where
that matches LambdaMOO/Core convention. In v1, `obj.owner` is a read-only core
field projection, not an ordinary property value and not user-writable through
`SET_PROP`.

Inheritance is **single-parent**. There is no multiple inheritance and no mixin support in v1.

`location` is a separate axis from `parent`. A `#sword` object's *parent* is `#weapon`; its *location* is `#room5` (it's lying on the floor). LambdaMOO conflated these in early versions; we don't.

### 4.1 Anchor and atomicity scope

`anchor` declares an atomicity cluster: a verb body that mutates objects sharing one anchor runs as a single atomic transaction. Cross-cluster mutations (a verb call from one cluster into another) are not atomic; partial failures are observable.

Anchor is a *consequence-of-placement* construct, not the placement primitive. When an anchor's root resolves to a self-hosted host (§4.2), every object in that cluster lives on that host as a side effect — that is what makes the cluster atomic. When the anchor's root is co-resident, the cluster is co-resident with it; atomicity then depends on every cluster member being co-resident in fact, which the runtime guarantees by stamping host placement at create time.

Constraints:

- `anchor` must be a persistent objref. Transients can't anchor anything; transients live on their player's host.
- Anchor relationships form a tree — no cycles. Anchoring places transitively: if `B.anchor = A` and `C.anchor = B`, then `C` shares an atomicity cluster with `A`.
- **`anchor` is set at creation time and cannot be changed.** Re-anchoring would be a recursive host migration with task drain, routing redirects, and an atomicity-scope shift. v1 does not provide it. If an object truly needs to live in a different cluster, the answer is: create a new object in the target cluster, copy state, recycle the old. Routine "move this object to that container" is a `location` update — that's free and unrelated to anchor.
- `anchor` is independent of `parent` (inheritance) and `location` (containment). The three axes don't constrain each other.
- **Self-hosted instances cannot be anchored.** If the resolved class is self-hosted (`instances_self_host = true`, §4.2), `create()` rejects a non-null `anchor` argument with `E_INVARG`. Self-hosting and anchoring are alternative ways to designate a host root; combining them would route the instance to its own DO (rule 1 in §4.2 routing precedence) while declaring it a member of another cluster, which would break the co-residency guarantee that anchor-cluster atomicity depends on. Concretely: the anchored-descendants check in [recycle.md §RC3](recycle.md#rc3-bookkeeping) pre-flight A3 relies on every transitive descendant of `obj` being on `obj`'s host; a self-hosted-with-anchor instance would violate that. If a class needs to be both self-hosting and atomically coordinated with another cluster, the correct shape is to nest the cluster under the self-hosted root, not to anchor the self-hosted instance outward.

Default: `anchor = null`. Use anchoring deliberately, when atomic coordination across a cluster is the design intent. The dubspace is the canonical example: `$mix`, `#delay`, `#channel`, `#scene` all anchor on `$mix`, share one host, and `$mix:call` mutates them atomically. Most objects in most worlds don't need an anchor.

### 4.2 Host placement

Where an object physically lives — which host owns its persistent storage — is determined at **creation time** by the object's class metadata, and never changes again. Two cases:

1. **Self-hosted instances.** A class whose `instances_self_host` property resolves to `true` (by normal inheritance lookup, §10.5) produces instances that each run as their own host. Every instance of such a class gets a dedicated persistent host (in the Cloudflare reference, a Durable Object) at creation, with its own storage, scheduling alarm, and hibernation lifecycle.

2. **Co-resident instances.** A class whose `instances_self_host` resolves to `false` (the default) produces instances that live on the host that ran the `create` call — the *executing host*, the persistent host whose verb body invoked `create`. Carryable objects — books, hats, notes — fall here. The instance's `location` may change freely at runtime as it is carried between containers (§10.2 location and contents); **host placement does not change with location**. A book created on a player's host stays on that host even after it has been put on a table in a different room. Lookups of the book through its container are resolved via Directory routing and per-host RPC (see [reference/cloudflare.md §R1](../reference/cloudflare.md#r1-host-mapping)).

The executing host is distinct from the verb's `progr`. `progr` is permission authority, set at compile time and carried in every frame; the executing host is the persistent host that physically runs the call. A wizard-owned helper verb invoked from a player's host runs on the player's host with `progr = $wiz`; objects it creates are co-resident with the player, not with the wizard. Catalog seeds and bootstrap fixtures, by construction, run on the gateway host; objects they create without an explicit placement are gateway-resident.

#### How `instances_self_host` is represented

`instances_self_host` is a regular property defined on `$root_object`:

- name: `instances_self_host`
- default value: `false`
- owner: `$wiz`
- perms: `r` (read-public, wizard-only writable)
- type hint: `bool`

Subclasses opt in by setting `instances_self_host = true` on the class itself. Resolution at `create()` is the standard inheritance lookup on the parent class — the value defined nearest in the parent chain wins, equivalent to a logical OR if no ancestor sets it back to `false`. (The runtime treats any explicit `false` between an instance and a `true`-declaring ancestor as the spec's monotone-class-lifetime rule violated, and rejects it as `E_INVARG` at create time; flipping the flag while extant instances exist would split the population across two policies.)

The runtime stamps the resolved decision onto the new instance as a runtime property `host_placement`:

- name: `host_placement`
- value: `"self"` for self-hosted instances; `null` for co-resident instances
- owner: `$wiz`, perms: `r`
- written by the runtime during `create()` and not user-writable thereafter

`host_placement` is the on-disk projection. `instances_self_host` is the class-level declaration.

The classes that declare `instances_self_host = true` in the baseline object graph and bundled catalogs:

- `$room` (and subclasses) — every room has its own log, subscribers, and fixtures, scaling independently of other rooms.
- `$player` (and subclasses including `$wiz`, `$guest`) — every player owns a host for sessions, attached connections, and inventory.
- Anchor spaces declared by catalogs that own coordination clusters — for example `$dubspace` and `$task_registry` from the bundled demo catalogs ([catalogs.md §CT15](../discovery/catalogs.md#ct15-bundled-catalogs-in-this-repo)). Any catalog whose top-level space owns its anchored objects sets `instances_self_host = true` on the class.
- The `$catalog_registry` and similar operational singletons.

Authority to instantiate self-hosting classes is narrower than ordinary `create()`. Because each instance reserves a real host resource, the `assertCanCreateObject` check requires wizard authority (or an explicit programmer capability grant); ordinary programmer-creates-own-fertile-parent authority is not sufficient. See [permissions.md §11.4](permissions.md#114-progr-and-actor) and [reference/cloudflare.md §R1.1](../reference/cloudflare.md#r11-routing).

#### Routing precedence

The implementation resolves an object id to a host in this order:

1. **Self-hosted.** If the object's `host_placement = "self"`, the id is its own host. Self-hosted instances always have `anchor = null` (per §4.1's create-time rejection rule); rules 1 and 2 are mutually exclusive by construction.
2. **Anchored to a self-hosted root.** Else if the object's `anchor` (transitively) resolves to a self-hosted host, route there.
3. **Directory record.** Else, the runtime stamps the executing host onto the object at `create()` and registers it in Directory; the route is fixed for the object's lifetime and does not vary with `location`.

`location` does not participate in routing. A book whose location is a self-hosted room continues to route to its creation host; rendering the room's contents resolves each member's host via Directory and dispatches `:title()` per-host. The catalog-installed pattern of `host_placement = "self"` on `the_dubspace` (with anchored controls under it) is the canonical example of (1) and (2).

### 4.3 Containment and cross-host invariants

`obj.location = container` and `container.contents includes obj` are bidirectional: every move updates both sides. In a single-host world this is one in-memory operation, persisted in a single transaction. Across hosts, the invariant becomes a distributed responsibility:

- The object's `location` field is the **source of truth**. It lives with the object on its own host; the move primitive writes it transactionally on the host that owns the object.
- Each container's `contents` is a **cache**: a set of object ids maintained on the container's host. When an object's `location` changes, the moving host RPCs the source container's host with `contents.delete(obj_id)` and the target container's host with `contents.add(obj_id)` immediately after writing `obj.location`. The container stores ids only; it does not cache titles, hosts, or other display data.
- **Rendering enriches at read time.** When a verb such as `:look` walks `contents`, it resolves each member's host via Directory and dispatches `:title()` (and any other display verbs) per-host. The dispatched titles are not stored on the container.
- The `contents` cache may drift if a push fails or an older projection bug persisted a partial row. Because `location` is the source of truth, a full host-local world may rebuild each local container's `contents` from the local object rows it can materialize: add every object whose `location` is that container, remove any member whose row is missing, and remove any member whose row says it is elsewhere. Sparse authority slices are different: absence from a slice does not prove absence from the host, so sparse-slice repair may add known moved members and prune contradicted members but must preserve unknown entries.
- **Sink exception: `$nowhere`.** The bidirectional invariant has one documented exception: `$nowhere.contents` is not maintained. Setting `obj.location = $nowhere` writes only the object's own `location`; no RPC is dispatched to update `$nowhere.contents`. See [bootstrap.md §B2.15](bootstrap.md#b215-nowhere) for the rationale (avoiding a global write hotspot on disconnect/recycle/reset paths).

The Directory tracks `id → host` only. Containment lives with the container; `location` is recorded on the object itself, not in Directory. See [reference/cloudflare.md §R1.1](../reference/cloudflare.md#r11-routing) for the wire-level mechanics.

---

## 5. Identity and addressing

### 5.1 Persistent refs

`#` followed by a 26-character Crockford base32 ULID, e.g. `#01HXYZAB12CDEFGH34JKMNPQRS`. ULIDs are time-ordered (sortable by creation time) and globally unique without central coordination.

Source code mostly refers to objects by corename (`$wiz`, `$room`); raw IDs appear at runtime and in serialized data.

Reserved:
- `#-1` — `NOTHING` / null reference.
- `#0` — `$system`, the bootstrap object. Renders as `#0` for ergonomics; internally a reserved ULID `#00000000000000000000000000`.

UUIDv7 is an acceptable alternative if RFC 9562 conformance matters more than ergonomics; the runtime treats both as opaque strings, picked per-world by configuration. Default: ULID.

### 5.2 Transient refs

`~nnn@#mmm` where `nnn` is unique within host `#mmm`'s session. Lifetime ends when host `#mmm`'s connection closes. Allocated by the host on instantiation; not coordinated globally.

Within source code on a host, the bare form `~nnn` resolves to the local host. Cross-host transient refs use the qualified form.

### 5.3 Corenames

`$foo` is shorthand for `#0.foo` (the `foo` property of `$system`). A typical bootstrap world has `$root_object`, `$player`, `$room`, `$thing`, `$wiz`, etc. Resolution is at compile time when possible (statically known property), falls back to runtime lookup otherwise.

### 5.3.1 Dynamic corenames

Most corenames are *static*: `$wiz`, `$root`, and any catalog-installed singleton (e.g., `$dubspace` if the demo is installed) are defined at boot and resolve to a fixed ULID via `$system.<name>` lookup. The resolver looks up the corename in a flat map and returns the same answer regardless of context.

A small reserved set of corenames are *dynamic*: their resolution depends on the calling context.

- **`$me`** — the actor making the current call. Resolves to the bearer's actor in REST requests ([rest.md §R9](../protocol/rest.md#r9-me-resolution)), to the frame's `actor` field in verb bodies, and is unset (raises `E_VARNF`) outside any call context. Equivalent to writing `actor` in a verb body; the dynamic corename gives the same identity a name in REST and tooling contexts.
- **`$peer`** — reserved for the calling peer in cross-world contexts ([federation-early.md](../deferred/federation-early.md)). Inactive in single-operator deployments.

Dynamic corenames may not be assigned via `set_corename`; the runtime owns their resolution. A wizard with the `impersonate` capability may override `$me` for a single call (public REST: request body `actor` field; trusted internal DO REST: `X-Woo-Impersonate-Actor: <ref>` header; verb code: `wiz:as_actor(...)`); the impersonation is logged as a wizard action.

### 5.4 Federated origins (reserved)

In federated contexts, refs are qualified by origin: `#42@world-a.example`. The unqualified form `#42` is shorthand for "the local world's origin." See [../deferred/federation.md §24.3](../deferred/federation.md#243-qualified-identity). v1 ships single-world; non-local origins raise `E_FED_DISABLED` at runtime, but the qualifier syntax is parsed and stored in the AST so v2 federation is a non-breaking change.

### 5.5 ID allocation

ULIDs are minted **locally** in the issuing host's process. There is no central allocator on the hot path:

1. A verb runs `create($room, $owner)` on some host H.
2. H mints a ULID locally (in-process, no RPC).
3. H references the new id; the persistence layer brings the new persistent host into existence on first access.
4. H updates its own `child` table if it is the parent, or notifies the parent.

This decouples object creation from any singleton bottleneck. Creation rate is bounded by the persistence layer's instantiation throughput.

Routing is implicit: the ULID *is* the persistent host's name. See [../reference/cloudflare.md §R1.1](../reference/cloudflare.md#r11-routing) for the v1 mapping.

### 5.6 The Directory

The Directory host is a singleton holding small, read-mostly tables:

- **Corename map**: `$system → ULID`, `$root_object → ULID`, `$wiz → ULID`, etc. Dozens of entries, edited only by wizards.
- **World metadata**: bootstrap state, schema version.

The Directory **is** the authoritative `id → host` route table (per §4.2 routing precedence step 3 and [reference/cloudflare.md §R1.1](../reference/cloudflare.md#r11-routing)), but it is read-cacheable and not on the create or dispatch hot path: hosts cache route lookups, self-hosted ids are computed without reading Directory, and most calls resolve from a local cache. Directory is **not** in the path of ID allocation. Route rows are immutable: the row written at creation persists for the lifetime of the world, including after the object is recycled — that is what lets stale refs continue to reach the tombstone host so the host can distinguish "recycled" from "never existed" (see [recycle.md §RC3](recycle.md#rc3-bookkeeping) step 9 and [reference/persistence.md §14.2.1](../reference/persistence.md#1421-tombstones)).

There is no global object registry, by design. "All instances of `$room`" is answered by walking `children($room)` recursively. Operations requiring host enumeration (cleanup, stats, dump) go via the runtime's management plane (see [../reference/cloudflare.md §R2](../reference/cloudflare.md#r2-singleton-dos)), not the runtime API.

---

## 9. Verb dispatch and inheritance

### 9.1 Lookup

Each object's local verbs are an ordered list, not a name-keyed map. The slot
number is the verb's 1-based index in that local list, matching LambdaMOO's
`verbs(obj)` / `@verb#` convention. Slot numbers are stable until a local verb is
inserted or deleted; deleting a slot compacts later slots.

Given `obj:name(args)`:

1. Start at `obj`. Scan local verb slots in slot order. The first slot whose
   canonical `name` matches wins.
2. If no canonical name matches locally, scan the same local slots in slot order
   for aliases matching `name`.
3. Else recurse to `obj.parent`, repeat.
4. If no ancestor defines `name` and `obj` is `$actor`- or `$space`-descended, search `obj.features` per [features.md §FT2](features.md#ft2-verb-lookup-with-features).
5. If still no match, raise `E_VERBNF`.

Aliases: a verb's `aliases` field is a list of patterns. Lookup matches the invocation name against the union of the verb's canonical `name` and its alias patterns. Patterns are compiled at `setVerb` time and cached.

**Pattern grammar:**

```
pattern  := segment ( '|' segment )*
segment  := literal | literal '*' | literal '@'
literal  := one or more characters from [a-zA-Z0-9_-], min length 1
```

- A bare `literal` matches the literal exactly: `look` matches only `"look"`.
- `literal@` matches the literal exactly *or* any prefix of it down to the literal's first character: `l@ook` matches `l`, `lo`, `loo`, `look` — i.e., `l@ook` is shorthand for "any prefix of `look` of length ≥ 1." This is the LambdaCore abbreviation convention. The `@` must immediately follow a literal segment.
- `literal*` is a legacy wildcard form: it matches `literal` followed by zero or more characters from `[a-zA-Z0-9_-]`: `ex*` matches `ex`, `exa`, `examine`, and also `extra`. It is **not** LambdaCore abbreviation syntax. First-party catalogs should use `@` for abbreviations; `*` is retained in v1 only for existing data and for deliberately broad wildcard aliases.
- `|` is segment union within one pattern: `look|l@ook` permits both `look` and any prefix.
- Patterns are case-sensitive. A space-separated string of patterns (`"look l@ examine"`) is parsed as a list of three patterns; do not confuse this with a single pattern containing spaces (which is invalid).

**Compatibility note.** A single trailing `*` with no `@` is easy to
misread as LambdaCore-style abbreviation. New source and catalog manifests
should prefer `@` (`ex@amine`, `sq@uawk`). A future catalog/install lint pass
should warn on trailing-`*` aliases that appear to be abbreviations.

**Resolution order.** When multiple patterns from different ancestors match the invocation name:

1. Walk ancestor chain from `this` upward (per §9.1 step 1–3).
2. The first ancestor with *any* matching local slot wins.
3. Within that ancestor, canonical names are tested before aliases, and slot
   order breaks ties.

**Forbidden.** Patterns with no literal characters (e.g., `*` alone, `@` alone), patterns containing whitespace or special shell characters, and patterns longer than 64 characters all raise `E_INVARG` at `setVerb` time.

### 9.2 Cache

The lookup result `(obj, name) → (definer, verb_version, bytecode)` is cached on the host running the call. Cache entry includes `definer`'s version counter; entries are invalidated by push from `definer` (see [../reference/persistence.md §15.3](../reference/persistence.md#153-invalidation)).

### 9.3 Pass

`pass(args)` resolves the next verb up the chain from the *current frame's* `definer`. It does *not* re-check from `this`. This makes overrides composable.

### 9.4 Permission check

A verb's `perms.x` must be set to be callable, OR the calling `progr` must own the verb, OR `progr` is a wizard.

### 9.5 No cross-world parents

A persistent object's parent must be in the same world. `chparent(obj, new_parent)` rejects qualified non-local parents with `E_FED_DISABLED`. Cross-world references remain valid for messaging (verb calls, events, property reads); only the inheritance edge is restricted. See [../deferred/federation.md §24.5](../deferred/federation.md#245-no-cross-world-inheritance).

---

## 10. Properties and inheritance

### 10.1 Lookup

Given `obj.name`:

1. If `obj` has a stored value for `name`, return it.
2. Else walk `obj.parent` chain. For each ancestor:
   - If the ancestor *defines* `name`, return its default value.
   - Else continue.
3. If no ancestor defines `name`, raise `E_PROPNF`.

Note the asymmetry: a property *definition* lives on one specific ancestor (with metadata: owner, perms, default). The *value* lives on any descendant that has set it. A descendant without an explicit value sees the default from the defining ancestor.

### 10.2 Setting

`obj.name = val`:

1. Find the defining ancestor (chain walk + cache).
2. Permission check: caller `progr` must have `w` on the prop, OR own the value owner, OR be a wizard.
3. Write the value into `obj`'s own `property_value` table. Does *not* propagate to descendants.

An implementation may carry ad hoc local property values that do not yet have a
formal property definition, usually from bootstrap or migration. These values are
readable but not public-writable by default; only the object's owner or a wizard
may create or update them through checked VM property operations. Publicly
writable extension points should be explicit property definitions with `w`.

### 10.3 Defining

`define_prop(obj, name, default, perms)` (compiled to `DEFINE_PROP`):

1. `obj` must not have `name` defined or visible from its chain.
2. `progr` must be `obj.owner` or a wizard.
3. Adds row to `obj`'s `property_def` table.
4. Children of `obj` that try to set this prop will write to their own `property_value` (no migration of existing data needed).

### 10.4 Clearing

`clear_prop(obj, name)`:

1. Removes any stored value on `obj`. Subsequent reads see the default.

### 10.5 `chparent`

Re-parents an object. Constraints:

1. New parent must not be a descendant of `obj` (no cycles).
2. Properties defined on the *old* parent chain that aren't on the *new* chain are dropped from `obj` (or its descendants); properties newly visible in the new chain take their defaults.
3. Verb cache on `obj` and all descendants is invalidated.

This is rarely called in practice but must be sound.

> **Open question (LATER):** "drop orphaned property values" is the current draft. "Preserve as orphan values readable via `obj.orphans["prop_name"]`" is also defensible — preserves user data on a misclick. Defer until use-case clarifies. See [LATER.md](../../LATER.md).
