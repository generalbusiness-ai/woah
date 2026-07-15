---
name: block
version: 0.1.0
spec_version: v1
license: MIT
description: Anchored, plug-driven data display actor — base class for surfacing outside-world data inside woo.
keywords:
  - block
  - plug
  - actor
  - data
---

# block

Base class for **plug-driven** data display objects.

A `$block` is an anchored actor that bridges woo to an outside-world data
source. An external "plug" process authenticates as the block's actor (via
an apikey credential) and pushes property values into the block's
`writable_self` surface; the block's owner sets configuration via the
`writable_owner` surface; everyone else is read-only. Wizard always
bypasses.

The catalog publishes the *shape*; the plug owns the *data*. Subclasses
specialize for concrete domains (weather, ticker, dispenser).

See [DESIGN.md](DESIGN.md) for the full pattern, including:

- writability tiers (`writable_owner`, `writable_self`) as ordinary
  class properties
- live `block_data` observation route (no sequencing, no replay)
- credential management (mint/revoke/list apikeys via the block)
- summary-vs-detail tier filtering for `RoomSnapshot`

## Quick reference

`$block` properties:

| Name | Tier | Notes |
|---|---|---|
| `last_pushed_at` | `writable_self` | epoch ms of last plug push |
| `last_error` | `writable_self` | most recent failure (string or null) |
| `summary_props` | wizard-only | class metadata: which prop names ride in the look summary |

`$block` verbs:

| Verb | Perms | Notes |
|---|---|---|
| `:set_property(name, value)` | tier-gated | Single property write; emits `block_data`. |
| `:set_properties(values)` | tier-gated | Bulk; atomic permission gate, one observation per name. |
| `:get_data(name)` | rxd | Read a property by name; respects normal `r` perms. |
| `:look()` / `:look_self()` | rxd | Returns `{id, title, description, last_pushed_at, last_error, summary, location}`. `:look` also emits the caller-private `looked` observation, and is command-shaped so it appears in `@examine` / MCP obvious affordances. |
| `:moveto(target)` | wizard | Block is anchored; non-wizard raises `E_PERM`. |
| `:acceptable(object)` | rxd | Always false (nothing enters a block). |
| `:mint_apikey(label?)` | owner/wizard | Mints an apikey bound to this block's actor. |
| `:revoke_apikey(id)` | owner/wizard | Revokes a key (closes any sessions minted from it). |
| `:list_apikeys()` | rxd | Returns the apikey records for this block. |

After minting, store the returned credential as the full token string:
`apikey:<id>:<secret>`. The id is part of the credential, not just
metadata; `apikey:<secret>` is not the documented token form. Validate
the full token before putting it into a plug's secret store:

```bash
export WOO_BASE_URL="https://woo.example.com"
export WOO_APIKEY="apikey:<id>:<secret>"

curl -fsS "$WOO_BASE_URL/net-api/session" \
  -H "Authorization: Bearer $WOO_APIKEY" \
  -H "content-type: application/json" \
  --data '{}'
```

A valid block key returns JSON with `actor` equal to the block id and a net
`session`. `E_NOSESSION` means the id/secret pair is wrong,
unknown, or revoked.

## Subclassing

Concrete block classes set their own `writable_owner` (config knobs) and
extend `writable_self` (data fields). Tier lists are inherited via the
property-def chain. They are catalog data, not special substrate fields.
