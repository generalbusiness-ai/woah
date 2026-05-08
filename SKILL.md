---
name: woocode-objects
description: Use when designing, writing, or reviewing woo catalogs, woocode object prototypes, manifest seed objects, verbs, properties, event schemas, command surfaces, or block/plug integrations in this repository. Provides an agent programmer's guide to current Woo DSL syntax, catalog shape, object organization patterns, and validation discipline.
---

# Woocode Objects

This skill is for authoring behavior in catalogs under `catalogs/`. Keep the substrate catalog-agnostic: user-visible behavior belongs in woocode manifests unless a generic runtime primitive is missing.

## Object Model

Objects are data plus behavior. A catalog "class" is just a prototype object named like `$note` or `$weather_block`; seeded instances are ordinary objects created from those prototypes.

- Single inheritance: use `parent` for the prototype chain.
- Feature classes: provide mixin behavior.
- `location` is containment; it is not inheritance.
- `owner` controls authority checks; verb execution authority is `progr`, the verb owner.
- `anchor` is an atomicity/placement scope set at creation; do not use it casually.
- Corenames like `$space`, `$thing`, `$player`, and catalog `$classes` resolve through installed objects.
- Cross-catalog parents use alias-qualified refs, for example `note:$note`.

Prefer subclassing when behavior must override an inherited verb. Use features only to add behavior that is absent from the parent chain.

Behavioral decisions should depend on an object's *class* more often than by *property*.

## Catalog Manifest Shape

Minimum shape:

```json
{
  "name": "example",
  "version": "0.1.0",
  "spec_version": "v1",
  "depends": ["@local:chat"],
  "classes": [],
  "features": [],
  "schemas": [],
  "seed_hooks": []
}
```

Class entries usually include:

```json
{
  "local_name": "$example",
  "parent": "$thing",
  "flags": { "fertile": true },
  "description": "What this prototype is for.",
  "properties": [
    { "name": "text", "type": "str", "default": "", "perms": "r" }
  ],
  "verbs": []
}
```

Seed hooks are deliberately small:

- `create_instance`: create a named object from a class.
- `attach_feature`: append a feature to an actor or space.
- `set_property`: set catalog registry/config data. Prefer `set_if_missing` or `append_unique` unless replacement is the explicit contract.
- `change_parent`: opt an existing object into a new class path, such as `$wiz` inheriting programmer tools.

For public catalogs, write portable `source` verbs. `implementation: {kind: "native"}` is trusted-local only and should be a temporary bridge to a missing generic primitive.

## Verb Source

Verb source is MOO-shaped:

```woo
verb :set_title(title) rx {
  if (typeof(title) != "string" || !str_trim(title)) {
    raise { code: "E_INVARG", message: "title must be a non-empty string", value: title };
  }
  this.title = str_trim(title);
  observe({ type: "title_changed", source: this, actor: actor, title: this.title, ts: now() });
  return this.title;
}
```

Useful frame globals:

- `this`: receiver.
- `actor` / `player`: calling actor.
- `caller`: previous frame's `this`.
- `progr`: current permission principal, derived from verb owner.
- `space`, `seq`, `message`, `args`, `verb`: current invocation context.

Syntax reminders:

- Lists are 1-indexed: `items[1]`.
- Maps use string keys: `entry["request"]`.
- Dynamic property access is `this.(name)`.
- `this:verb(args)` dispatches a verb and may cross hosts.
- `pass(args)` calls the next implementation in the inheritance chain.
- There is no `class`, `function`, `import`, `async`, `await`, or `eval`.
- Every `.` property access and `:` verb call can yield; write behavior as if reads may be remote.

Common builtins:

- Values: `typeof`, `length`, `keys`, `values`, `has`, `to_string`, `to_int`, `round`.
- Strings: `str_trim`, `str_lower`, `str_slice`, `str_split`, `str_join`.
- Objects: `create`, `moveto`, `move`, `recycle`, `chparent`, `isa`, `contents`, `location`, `has_flag`.
- Events and IO: `observe`, `observe_to_space`, `tell`, `set_presence`.
- Sessions: `is_connected`, `idle_seconds`, `current_session`, `current_location`.
- Dispatch: `dispatch(target, verb, args?, start_at?, max_chars?)`.

## Verb Metadata

Use metadata deliberately:

- `perms: "rx"`: readable and executable through normal verb dispatch.
- `perms: "rxd"` or `direct_callable: true`: direct REST/MCP/tool call is allowed. The persisted perms normalize away `d`.
- `skip_presence_check: true`: usable outside room presence. Use for configuration, block plug writes, and read-only helpers.
- `tool_exposed: true`: show as an agent tool. Only expose stable, bounded verbs with clear args.
- `arg_spec.args`: names programmatic arguments.
- `arg_spec.command`: command-parser contract. Existing examples use shapes like `{ "dobj": "this", "prep": "any", "iobj": "any", "args_from": ["dobj_prefix_rest"] }`.
- `pure: true`: only when the verb is read-only and the analyzer agrees.

## Permissions

Put policy in small verbs and call them from mutators.

Patterns:

- `catalogs/perm`: singleton helper `the_perm:controls(who, what)`.
- `catalogs/note`: `:is_readable_by(actor_obj)` and `:is_writable_by(actor_obj)`.
- `catalogs/block`: `:is_writable_by_property(who, name)` gates all state mutation through `:set_property` / `:set_properties`.
- Concrete blocks add `:assert_configurable()` so owner/wizard config checks stay local and readable.

Do not write direct property mutation from every public verb. Route writes through a policy gate unless the object is intentionally owner-only and tiny.

## Capabilities

Model capabilities as ordinary object behavior:

- Inheritance capabilities: put shared verbs/properties on a prototype and subclass it, as `$weather_block` subclasses `$block`.
- Feature capabilities: attach additive verbs to `$actor` or `$space` descendants when parent-chain override is not needed.
- Helper capabilities: seed a singleton such as `the_perm` and call its verbs from catalog code.
- Tool capabilities: mark stable verbs `tool_exposed: true` with clear `arg_spec.args`; avoid exposing high-cardinality, destructive, or ambiguous verbs.
- Plug capabilities: mint an apikey bound to a block actor, then let the plug act as that object and write only self-writable fields.
- Wizard capabilities: keep them explicit, audited, and narrow. Do not hide wizard power in broad catalog hooks or features.

## Observations

State-changing verbs should emit observations with stable event names and enough data for clients to update projections:

```woo
observe({ type: "note_edited", actor: actor, note: this, text: body, ts: now() });
```

Use `observe_to_space(space, event)` when an object is visible in a containing room or mounted space and the room audience should see the event. Add schemas under `schemas` for event types that clients or tests consume.

Return structured data as well as emitting observations. A good mutator both changes state and returns the new meaningful state or ticket.

## Organization Patterns

### Prototype Plus Seeded Instance

Use this for helpers and world fixtures. `catalogs/perm` defines `$perm`, then seeds `the_perm`. Verbs call `"the_perm":controls(...)` rather than treating the prototype as the singleton.

### Artifact Object

Use this for portable things in inventories and rooms. `catalogs/note` defines `$note` with text, permission hooks, `:title`, `:look_self`, read/write verbs, and edit observations.

### Space With Child Records

Use this for coordinated apps. `catalogs/taskspace` defines `$taskspace` as a `$space`, creates `$task` children, stores root ordering on the space, and emits task lifecycle observations.

### Feature/Mixin

Use features for additive capabilities on `$actor` or `$space` descendants. Parent-chain verbs win; features cannot override inherited verbs. In feature verbs, `this` is the consumer and `definer` is the feature object.

### Block/Plug

Use this when an external process pushes data into woo.

- `$block` is a placement-stable actor with `writable_owner` and `writable_self`.
- The owner configures fields through owner-writable verbs.
- The external plug authenticates with an apikey bound to the block actor, so `actor == this` and it may update self-writable data fields.
- All plug writes go through `:set_property` or `:set_properties`, which emit `block_data`.
- `:mint_apikey`, `:list_apikeys`, and `:revoke_apikey` belong on the block surface, not in the plug.

`weather` is the direct data-display example. It subclasses `$block`, declares config and data properties, owner config verbs, display helpers, and UI metadata.

### Dispenser Queue

Use this when a public request produces an artifact later.

- Public `:order(request)` validates caps, appends `pending_orders`, returns a ticket, observes `order_placed`, and tells the block actor.
- Plug polls `:next_pending()` as the block actor.
- Plug calls `:deliver(order_id, body)`, which removes the queue entry, creates a note, moves it to the requester, and observes delivery.
- Subclasses override `:default_note_class`, `:default_note_name`, and configuration verbs.

`horoscope` is the concrete pattern: `$horoscope_block` subclasses `$dispenser_block`; `$horoscope_note` subclasses `$dispensed_note` and overrides `:moveto` / `:recycle` for self-destruction when dropped into a space.

## Review Checklist

Before finishing a woocode change:

- Does behavior belong in a catalog rather than `src/core`?
- Is the relevant spec explicit enough, and does it need updating?
- Are property defaults and type hints correct for already-installed worlds?
- Are writes permission-gated through local policy verbs?
- Are observations named, structured, and schema-covered when clients consume them?
- Are public returns bounded and structured?
- Are `direct_callable`, `skip_presence_check`, and `tool_exposed` justified?
- Are seed hooks idempotent and conservative with existing operator state?
- Do catalog version/migration rules apply?
- Run focused tests, then `npm test` when behavior or manifest shape changes broadly.
