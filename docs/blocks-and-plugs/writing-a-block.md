# Writing a block

A block type defines the in-world half of an integration: its properties,
verbs, permission policy, observations, and any durable coordination
behavior. The external plug is a separate program. Keep that boundary
clear:

- the block owns the published Woo interface and Woo-owned workflow facts
- the plug owns access to the external system and mirrors its current data
- an apikey lets the plug act as one particular block instance

## Supported authoring path today

Reusable block types currently ship as catalogs. A catalog manifest
declares a class whose parent is `$block` (or another block class), its
properties, its verbs, and its writability tiers. The weather catalog is
the compact data-feed example; dispenser and horoscope show queued work
and artifact delivery.

For example, the relevant shape is:

```json
{
  "classes": [{
    "local_name": "$my_block",
    "parent": "$block",
    "flags": {"fertile": true},
    "properties": [
      {"name": "query", "type": "str", "default": "", "perms": "r"},
      {"name": "result", "type": "any", "default": null, "perms": "r"},
      {
        "name": "writable_owner",
        "type": "list<str>",
        "default": ["query"],
        "perms": "r"
      },
      {
        "name": "writable_self",
        "type": "list<str>",
        "default": ["result", "last_pushed_at", "last_error"],
        "perms": "r"
      }
    ],
    "verbs": []
  }]
}
```

The lists are class data, not substrate fields. A class may instead
override `:is_writable_by_property(who, name)` when its policy is richer
than two lists.

Catalog install and update are operator actions: they execute arbitrary
class code and are wizard-only and audited. Third-party catalogs use the
GitHub tap flow described in
[Catalogs](../designing/catalogs.md#adding-your-own-catalog). After an
instance is provisioned in a room, its owner calls
`:mint_apikey(label?)` and stores the one-time token in the plug's secret
manager. See [Writing a plug](writing-a-plug.md).

## What normal in-world programmers cannot do yet

The ordinary builder/programmer surface does not currently provide a
complete block deployment workflow:

- `$block` is deliberately non-fertile, so a programmer cannot derive a
  new type from it with ordinary `create`.
- `writable_owner` and `writable_self` are inherited read-only catalog
  properties. Their subclass values are installed from a manifest, not
  set by an instance owner.
- A block instance is self-hosted. Ordinary room placement is interpreted
  as anchoring during builder creation, but a self-hosted root cannot
  itself be anchored.
- A block rejects non-wizard movement after creation, so creating it
  unplaced and then moving it is not an owner deployment path.
- Defining properties on an already remote self-hosted object is not an
  atomic programmer operation.
- The spec refers to a capability grant for allocating self-hosted
  resources, but that delegated capability is not implemented yet.

Consequently, do not document `@create $block` or
`@create $my_block` as a complete owner provisioning recipe. Catalog
installation and seed/operator provisioning remain the supported path.

## Planned in-world path

The proposed path separates editable source from allocated runtime state:

1. A programmer creates a co-resident `$block_blueprint`.
2. They add ordinary properties and verbs to that owned object and mark
   each exported field as owner-configured, plug-written, or restricted.
3. `:validate()` reports permission, type, authority, and deployment
   errors without allocating a host.
4. `:deploy(room, options)` acts as the blueprint's self-factory. After
   checking a host-allocation grant or quota, it snapshots the blueprint
   into a new self-hosted `$block`, gives it an initial room location with
   `anchor = null`, and returns a durable deployment receipt.
5. The block owner separately mints the plug credential and starts the
   plug on any reachable infrastructure.

Edits to a blueprint affect future deployments only. Existing blocks keep
their recorded blueprint revision until an explicit, migration-aware
upgrade.

This is a design direction, not an implemented command surface. The
detailed implementation plan, including authority, placement,
idempotency, local-development behavior, migrations, and tests, is in
[the programmer block factory/deploy note](../../notes/2026-07-23-programmer-block-factory-deploy-plan.md).

## Design rules that apply in either path

- A plug credential must be bound to one block, never shared across
  integrations.
- Copied or installed programmer code must retain the programmer's
  authority; a factory must not turn it into wizard-owned code.
- Externally authoritative current values stay block properties. Typed
  Woo workflow facts go through the owning catalog's acts and
  projections.
- Observation fanout is best-effort. Consumers recover from current cells
  or durable projections.
- Block instantiation consumes a host resource and therefore needs a
  bounded, explicit deployment policy.
- Cloudflare is the default global host adapter, not part of the block or
  plug interface.
