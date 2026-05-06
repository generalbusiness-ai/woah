# block — design notes

## Concept

A `$block` is an anchored actor that surfaces outside-world data through
the woo object graph. It owns the *shape* (properties, verbs, perms,
observations); the *data* originates in an external "plug" process that
authenticates as the block's actor via an apikey credential.

The substrate primitives that make this work:

- **Writability tiers** (`writable_owner`, `writable_self`) declared as
  ordinary class properties in woocode catalogs. The catalog's
  `:set_property` body checks `this:is_writable_by_property(actor, name)`;
  the default implementation grants wizard bypass, then consults those
  lists with `actor == this` for plug-owned data writes and
  `actor == this.owner` for owner config.
- **LambdaMOO-style permission helpers.** `$block` depends on the
  `perm` catalog and uses `"the_perm":controls(who, this)` as the
  owner-or-wizard baseline. Subclasses can override
  `:is_readable_by`, `:is_writable_by`, or
  `:is_writable_by_property` without substrate changes.
- **Apikey credential bound to the block's actor.** The block's owner
  mints a key via `:mint_apikey(label)` (substrate native
  `$system:create_api_key_for_owner`), pastes the secret into the plug's
  secret store, and the plug authenticates as the block. Revoke closes
  any session minted from the key.
- **Live observation route.** Property writes emit a `block_data`
  observation to `location(this)`. The substrate does not log
  `block_data`; reconnects re-read current values via `:get_data`.

## Anchored

A `$block` instance has:

- `:moveto(target)` — raises `E_PERM` for non-wizards. Builder-style
  movement is denied; wizard can still relocate via the substrate
  `moveto()` primitive.
- `:acceptable(object)` — false except for wizard. Nothing enters a
  block as content. Subclasses that produce notes (`$dispenser_block`)
  emit those notes into the *requester's* inventory, not the block's.

## Property writability

| Tier | Who writes | Use |
|---|---|---|
| `writable_owner` | block's owner (or wizard) | configuration: where to fetch, what to display |
| `writable_self` | block's actor (the plug) | data: pushed values, freshness, error state |
| (other) | wizard only | intrinsic / restricted |

`:set_property(name, value)` is the single entry point; it consults
`:is_writable_by_property(actor, name)` on `this`. The base
implementation grants wizard bypass, then reads the tier lists on
`this`, which inherit through the class property chain.
`:set_properties(values)` bulk-writes with an atomic permission gate
(validate all names first, then write all).

`writable_owner` and `writable_self` are not substrate fields. They are
public-read class properties installed by the catalog like any other
property, and instance reads inherit via the normal property-def
`defaultValue` walk. Subclass declarations *should* extend the parent's
lists explicitly — manifest authoring convention, not a substrate
guarantee.

## Observation route

```
observe_to_space(location(this), {
  type: "block_data", block: this, name, value, ts: now()
});
```

`$block` is an actor, not a space — `observe()` alone reaches nobody.
`observe_to_space(location(this), ...)` routes to the containing room's
audience. Live route: not in the space log, not sequenced, no replay.

Subclasses that need replay (e.g. `$dispenser_block` events) emit
sequenced observations from their own verbs; the base class is
deliberately log-free.

## Credential surface

The block exposes apikey ops as verbs so the owner can manage credentials
without `$system` access:

- `:mint_apikey(label?)` — calls `$system:create_api_key_for_owner(this, label)`.
  Owner or wizard. The secret is in the result and is shown ONCE.
- `:revoke_apikey(id)` — calls `$system:revoke_api_key(id)`. Owner of
  the bound actor or wizard. Marks `revoked_at` (record kept for audit)
  and closes any in-memory sessions minted from the key.
- `:list_apikeys()` — calls `$system:list_api_keys_for_owner()` and
  filters to keys bound to this block. Returns
  `{id, label, created_at, last_seen_at, revoked_at}` records.

## Look surface

`:look_self()` returns `{id, title, description, last_pushed_at,
last_error, summary, location}`. The `summary` is built by reading each
name in `this.summary_props`. Subclasses set `summary_props` to the small
set of values that should always ride in the look output (e.g. for
weather: `["current"]`).

Detail-tier properties stay accessible via `:get_data(name)` —
direct-callable; the UI mounts the block surface and fetches detail when
needed.

## What this catalog does NOT include

- Subclasses (`$weather_block`, `$dispenser_block`, `$horoscope_block`)
  ship in their own catalogs.
- The plug process itself — that's an external CF Worker (or any
  WS/REST client) deployed independently.
- Ephemeral property tier (in-memory, skip-storage). Deferred until a
  workload genuinely needs it.

See [`notes/2026-05-05-block-and-plug.md`](../../notes/2026-05-05-block-and-plug.md)
in the woo repo for the full pattern, scaling tradeoffs, and rationale.
