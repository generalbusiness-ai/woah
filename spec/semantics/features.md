---
date: 2026-04-29
status: implemented
---

# Features

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

A **feature object** contributes verbs to a consumer object without being in the consumer's parent chain. Features are LambdaMOO's answer to "I need orthogonal capabilities" under single-parent inheritance: a player who is also a mail-recipient and an editor and a gendered-object composes those capabilities by attaching feature objects, not by reparenting.

woo adopts the pattern with two narrow rules:
- Only `$actor` and `$space` descendants carry features (many objects don't need them).
- A feature's own `features` list is **not** searched — feature lookup is one level deep.

This keeps the dispatch rule small and the verb cache predictable while preserving the mixin-style composition vehicle that real MOO worlds depend on.

---

## FT1. The `features` property

Defined on `$actor` and `$space` only:

| Property | Type | Default | Notes |
|---|---|---|---|
| `features` | list<obj> | `[]` | Ordered list of feature objects whose verbs are looked up after the parent chain. |
| `features_version` | int | 0 | Monotonic counter; incremented on every modification. Used by the verb-lookup cache. |

Other classes (`$thing`, `$root` directly) do not carry the property. Calls to `:add_feature` on a non-`$actor`/`$space` object raise `E_NOTAPPLICABLE`. This is by design: most objects don't need composition, and limiting the surface keeps verb-lookup predictable.

---

## FT2. Verb lookup with features

The lookup rule from [objects.md §9.1](objects.md#91-lookup) extends:

Given `obj:name(args)`:

1. Walk `obj`'s parent chain upward. If `name` is defined on any ancestor, use it. `definer` = the matching ancestor. **Done.**
2. If no parent-chain match **and** `obj` is `$actor`- or `$space`-descended:
   - For each `f` in `obj.features` in list order:
     - Walk `f`'s parent chain upward. If `name` is defined, use it. `definer` = the matching ancestor (within the feature's chain). **Done.**
3. If still no match, raise `E_VERBNF`.

**Conflict resolution.** Parent chain always wins over features. Within features, the first feature in list order whose chain defines `name` wins.

**No nested feature search.** A feature's own `features` list is not consulted. Lookup goes one level deep into features and stops.

---

## FT3. Frame state inside a feature verb

When a feature verb is invoked through consumer `obj`:

| Frame field | Value |
|---|---|
| `this` | `obj` — the original consumer. Property reads/writes target the consumer's state. |
| `definer` | The ancestor in the feature's chain where the verb was defined. `pass()` resolves up from here, along the feature's own parent chain. |
| `progr` | The feature verb's owner at compile time. (Same `progr` rule as parent-chain lookup; the verb's authority is the feature author's, not the consumer's.) |
| `caller` | Previous frame's `this`. |
| `actor`, `player` | Task-sticky as always (see [vm.md §8.1.1](vm.md#811-task-globals-visible-in-verb-bodies)). |

**`pass()` semantics.** Resolves up the feature's parent chain from `definer`. It does *not* fall back to the consumer's parent chain or to other features. If no ancestor in the feature's chain defines the verb, `pass()` raises `E_VERBNF`.

This is the same MOO discipline: `pass` is "next definition up *my* inheritance," and a feature's "my" is its own chain.

---

## FT4. Property access from feature verbs

Inside a feature verb body:

- `this.x` reads/writes the consumer's property `x`. Feature verbs operate on consumer state.
- `definer.x` reads/writes the feature's own property `x`. Useful for feature-private state (configuration, caches).
- `this.feature_arg` is a convention: a feature that needs per-consumer config reads from a property on the consumer (e.g., `$gendered_object` reads `this.gender`). The convention is documented per feature; the runtime imposes nothing.

Features are typically **stateless** — they contribute behavior, not state. When a feature needs state, the convention is to define a property on `$root` or on the consumer's class so `this.x` works, rather than carrying state on the feature itself.

---

## FT5. Adding and removing features

Three verbs on `$actor` and `$space`:

| Verb | Args | Permission | Purpose |
|---|---|---|---|
| `:add_feature(f)` | obj | wizard **OR** (owner of `this` **AND** `f:can_be_attached_by(actor)` returns true) | Append `f` to `features` if not already present. Increment `features_version`. Idempotent. |
| `:remove_feature(f)` | obj | wizard **OR** owner of `this` | Remove `f` from `features`. Increment `features_version`. Silent if not present. |
| `:has_feature(f)` | obj | unrestricted | Return true iff `f` is in `features`. |

The two-sided check on `:add_feature` is deliberate. Owner-of-`this` controls *consumer mutation* — only someone authorized to alter the consumer's state may extend its verb table. The feature's `:can_be_attached_by` controls *attach policy* — feature authors decide who is allowed to install their behavior. Neither side alone is enough; both sides must consent (wizards bypass).

**The `:can_be_attached_by(actor)` policy verb.** Defined on the feature class. Default body returns true iff `actor == this.owner` (only the feature's owner can install it). Feature authors override to widen:

```woo
verb $public_feature:can_be_attached_by(actor) rxd {
  return true;  // anyone may install
}

verb $team_feature:can_be_attached_by(actor) rxd {
  return $teams:is_member(actor, this.team) || actor == this.owner;
}
```

The verb is rxd (direct-callable) so it can be checked without sequencing.

**Authority through attachment is real.** A feature's verbs run with `progr = feature_verb_owner`, regardless of who attached them or who calls them through the consumer. Attaching a wizard-owned feature gives the consumer those verbs at wizard authority — design feature catalogs accordingly.

**Forbidden additions:**

- Cycles: `:add_feature(this)` raises `E_RECMOVE` (consumer adding itself).
- Wrong type: feature `f` must be persistent, not transient — features have to outlive the consumer's call. `E_INVARG` if `f` is `~`-prefixed.
- Same `f` twice: idempotent no-op; observation `feature_already_added`.

---

## FT6. Cache impact

Verb-lookup cache keys ([objects.md §9.2](objects.md#92-cache)) extend:

```
key = (obj_id, name)
value = (definer_id, definer_version, features_version_at_lookup)
```

When `obj.features` changes, `obj.features_version` increments. Cached entries with stale `features_version_at_lookup` are invalidated on next access.

Cache hit cost is unchanged; cache invalidation is one extra integer comparison.

---

## FT7. What features cannot do

- **Be added to non-`$actor`/`$space` objects.** `E_NOTAPPLICABLE`.
- **Define properties on the consumer.** Features contribute verbs, not properties. A feature that needs the consumer to declare a property documents that requirement; the consumer (or the catalog that ships the feature) defines the property explicitly.
- **Override parent-chain verbs.** If a verb is defined on the parent chain, the feature cannot shadow it. Use a subclass to override; use a feature to add.
- **See other features through nesting.** A feature's `features` list is ignored.
- **Modify the consumer's `features` list inside their own verb body.** Allowed mechanically but discouraged; if a feature's verb needs to detach itself or attach others, it should call the appropriate `:remove_feature` / `:add_feature` and document why.

---

## FT8. Patterns

| Pattern | Sketch |
|---|---|
| **Capability mixin** | A feature with verbs the consumer needs (`$mail_recipient` adds `:@mail`, `:@send`). |
| **Default behavior** | A feature providing reasonable defaults (`$verbose_describe` adds an opinionated `:describe`). |
| **Authority delegation** | A wizard-owned feature whose verbs run with wizard authority; attaching it to a non-wizard object grants it specific elevated capabilities. Use carefully. |
| **Trait composition** | Multiple small features attached together: `[$conversational, $gendered, $mail_recipient]`. Lookup walks them in order. |
| **Surface composition (dual-use class)** | A persistent *class* object serves double duty: it is the ancestor for legacy descendants **and** an attachable feature that composes its verbs onto an actor of a different kind. The prog catalog's `$programmer` is attached to an `$agent` so the agent gains the authoring surface without being reparented out of `$agent` — see [provisioning.md AP4](../identity/provisioning.md#ap4-class-model-normative). Any persistent object is a legal feature (FT5); a class object is permitted here, avoiding a second copy of every wrapper verb. Because parent-chain lookup wins over features (FT2), the class's own verbs never shadow the consumer's kind behavior, and a surface verb is reachable only when the consumer's kind does not already define that name. |

---

## FT9. Errors

| Code | Meaning |
|---|---|
| `E_NOTAPPLICABLE` | `:add_feature` / `:remove_feature` called on a non-`$actor`/`$space` object. |
| `E_RECMOVE` | Consumer tried to add itself as a feature. |
| `E_INVARG` | Feature is transient, or argument is not an object. |
| `E_VERBNF` | (Inside `pass()`) no further definition in the feature's chain. |

---

## FT10. Conformance

The conformance suite ([conformance.md §CF3](../tooling/conformance.md#cf3-required-categories)) covers:

- Lookup precedence: parent chain beats features; first feature in list order beats later features.
- Frame state: `this` is consumer, `definer` is the feature ancestor, `progr` is feature-verb-owner.
- `pass()` walks the feature's chain, not the consumer's.
- Cache invalidation on `:add_feature` / `:remove_feature`.
- `E_NOTAPPLICABLE` on `$thing`.
- No-nested-features: `feat_a.features = [feat_b]` is ignored when looking up through a consumer that has `feat_a`.
- Idempotent re-add and silent re-remove.
