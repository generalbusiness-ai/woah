# Acts and projections

> Status: **implemented kernel**. The `acts` catalog, schema validation,
> fail-closed same-anchor folds, recorded-observation rebuild, Outliner’s
> relation checkpoint, and Dispenser’s anchored-actor queue implement ACT1–ACT9.
> Dynamic attachment, fold replacement,
> cross-space emission, and public actor emission are deferred. A catalog-owned
> anchored actor may compose facts on its containing space's log under ACT3;
> this is not a public actor-emission surface.

Acts are typed domain facts recorded on a room's sequenced log. Projections
derive bounded coordination views from those facts in the same atomic turn.
This section governs the generic kernel and every catalog that adopts it.

## ACT1. Record and identity

An Act has exactly three semantic fields:

```json
{"type":"tasks.claimed","version":1,"payload":{"task":"task-1"}}
```

The generic observation carrier adds its standard `source` routing field,
naming the composer. That field is not part of the Act body or payload schema.
The containing [`SpaceLogEntry`](sequenced-log.md) is the Act's authority
envelope: space, sequence, actor, timestamp, and invoked verb. Catalogs MUST NOT
repeat those fields in the payload. An Act's durable identity is
`(space, seq, index)`, where `index` is its position among Act observations in
that committed entry. The body has no separate timestamp, ordinal, trust label,
or source-room field.

## ACT2. Payload boundary and schema

Every Act type and immutable version has a closed event schema resolved through
the emitting room's ordinary class-then-feature lookup. Every declared field is
required, undeclared fields are refused, `obj` requires a live object reference,
and `str` refuses live object references. Supported v1 tags are `obj`, `str`,
`bool`, `int`, `float`, `num`, `list`, `map`, `null`, and unions of those tags.

The payload contains only the smallest stable domain fact. It references
artifact objects instead of copying their name, text, description, or other
unbounded prose. It is not widened for a particular projection; a projection
that needs historical context keeps bounded fold-private state under ACT4.

## ACT3. Emission authority

The `$acts:act(type, payload)` primitive is internal catalog machinery. It MUST
refuse unless all of these hold:

1. the current turn is sequenced (`seq >= 1`);
2. the receiver is either the current sequenced space or an anchored actor
   whose current location is that space;
3. the caller is the receiver; and
4. the receiver resolves a schema for `(type, version)` and the payload validates.

The anchored-actor form exists for catalog authorities such as a Dispenser
block: the block's typed domain verbs compose the fact, while the containing
space remains the sequenced log authority. Moving the actor to another space
changes the eligible log; an attached projection bound to the old log then
refuses the turn. This is deliberately narrower than public actor emission:
the primitive remains non-executable to callers, requires `caller ==
receiver`, and accepts no caller-selected log.

Internal machinery MUST NOT carry public execute permission. An underscore name
and `direct_callable:false` are not authority boundaries: a sequenced external
call bypasses the direct-call gate and still executes any verb with `x`.
Internal helpers therefore omit `x` and validate `caller` even when that seems
redundant. The caller check protects privileged ingress and future internal
callers; the permission bit prevents ordinary principals from entering at all.

Contained objects delegate transitions to a room domain verb; they are not
given a general Act-emission capability. Program configuration—schemas,
features, and the projection list—is catalog state, not self-projected domain
state.

## ACT4. Projection contract

A v1 projection is a trusted catalog object in the log space's anchor cluster.
Its non-public, perms-empty `source_space` property binds it to exactly one
composer authority when created. (`source_space` is the retained v1 property
name; the value may be an anchored actor.) Its non-public `log_space` binds the
sequenced log. For a space composer both bindings name the same object; for an
anchored actor composer, `log_space == location(source_space)` at emission.
The live fold path MUST reject a projection whose composer or log binding does
not match the emission. It declares consumed Act types, a row cap,
projection-owned state, and these operations:

- `fold(act)` is deterministic from `(projection state, act)`, is the sole
  writer of all projection-owned state, performs no scan beyond the Act payload
  and explicitly declared fixed caps, makes no foreign reads, uses no wall
  clock or randomness, and sets `at_seq` from the injected `act["seq"]`.
  Besides the semantic body, live emission and rebuild inject the same recorded
  envelope metadata as `act["seq"]`, `act["actor"]`, and composer
  `act["source"]`; catalogs MUST use those values instead of duplicating them
  in payloads. The fold has no public execute permission and accepts only
  `caller == source_space`, live or during rebuild;
- `view(opts)` is the authoritative bounded read and returns a completeness
  watermark; and
- `rebuild_from(log_space, page_budget)` incrementally folds recorded
  observations after `max(at_seq, rebuild_scan_seq)`. It is
  owner/wizard-gated, refuses unless the argument equals the bound `log_space`,
  and asks the composer to replay that log and call the fold. The projection
  cannot self-fold or supply rebuild input.

Auxiliary fold state is permitted when later Acts omit context needed by the
projection. Every auxiliary structure MUST have its own cap and safe retention
rule, MUST be written only by `fold`, and is part of the rebuild invariant.
Overflow policy is refusal, normally `E_QUOTA`; silently dropping rows is not
allowed.

## ACT5. Fail-closed atomicity

Every domain mutation, every projection fold, and Act observation recording
occur inside the sequenced behavior savepoint. Any schema or fold failure MUST
escape to that savepoint. The turn commits as `applied_ok:false` with its error
outcome, while domain effects, all fold writes, and Act observations roll back.

Catalog code MUST NOT catch an error from `act`, `fold`, or an inverse/domain
operation that can reach them. There is no nested Woo savepoint: catching such
an error would commit partial state. Acts MUST NOT be emitted from `enterfunc`,
`exitfunc`, `recycle`, or another lifecycle hook whose errors the substrate
catches. A lifecycle transition that belongs to the domain must call a normal
sequenced domain operation before entering the non-vetoable hook.

## ACT6. Rebuild

For every projection, starting from its declared genesis state:

```text
fold(successful recorded Acts in (seq, index) order)
  == all projection-owned state
```

Rebuild folds recorded observations; it never re-executes verbs. It skips
failed entries, injects the recorded envelope sequence, actor, and composer
source, is incremental, idempotent, and bounded per call, and reports both
consumed and scanned progress. Rebuild covers rows and every auxiliary fold
structure. It does not reconstruct state that ACT7 assigns to another
authority.

## ACT7. One authority per fact

Projection rows MUST NOT mirror facts already owned by another single writer:

1. artifact content remains on the artifact;
2. physical containment remains in the substrate location relation; and
3. substrate-owned relations such as Outliner's `__ordered_edge` remain on that
   relation.

A **relation-checkpoint projection** may fold the semantic transitions for such
a relation into a watermark and bounded indexes, while its read joins the live
relation. Rebuild then reproduces the checkpoint, not the relation. The Act log
is complete for the catalog's accepted domain operations; it is not a backup of
substrate state.

Catalogs MUST name any state outside their adopted domain fact set. Transient or
visit-scoped interaction state—such as cursor focus or a one-step undo slot—may
remain direct object state when it is not a shared work-surface fact. Raw
operator lifecycle actions may also sit outside the domain log, but they MUST
be documented as out-of-band, MUST NOT emit a misleading Act, and MUST NOT be a
normal user path. A lifecycle hook MUST NOT silently provide an alternative
writer for an adopted domain relation. When the substrate requires such a hook
to remain executable, it MUST validate the substrate-provided moving-object
caller before touching state or emitting; this is the narrow exception to
ACT3's non-`x` rule for internal catalog machinery.

For Outliner v3 specifically, `__ordered_edge` is the tree authority;
`$outline_meta` checkpoints its five sequenced structural domain operations;
`focus_by_actor` and `last_undo` are visit-scoped interaction state; raw
substrate recycle is an out-of-band destructive repair path; and cross-outliner
movement is refused until one routed operation can record both authorities.
`$outline_item:moveto` is not public and has no `$nowhere` exception: successful
remove/eject reaches substrate recycle only after the acted detach, while raw
operator recycle invokes the guarded lifecycle callback. Outliner's
`enterfunc` and `exitfunc` likewise require `caller == object`; they may update
only the explicitly excluded visit state and lifecycle observations.

For Dispenser v1 specifically, the anchored `$dispenser_block` is the composer
and its containing room is `log_space`. `$dispenser_queue` owns pending
membership, the next-order counter, admission indexes, and bounded terminal
receipts. `dispenser.ordered` preallocates and records one room-anchored
artifact reference; its requester comes from the envelope actor, and the
composer comes from carrier source. The authenticated plug may fill only that
note through a direct, one-shot artifact-authority write; sequenced `deliver`
carries only `order_id` and the reference. Generated prose therefore appears
in neither the room transcript nor an Act. Plug heartbeat/configuration fields
and the lazy Acts/genesis attachment marker are program state outside the queue
fact set. A block outside a space cannot order, deliver, or cancel. Once
genesis binds the queue, moving the block to a different log space is refused.

## ACT8. Watermarks and reads

`at_seq` is the sequence of the last Act that a projection consumed, not the
room head. Two projections may therefore expose different watermarks. A
relation checkpoint names the covered fact explicitly (Outliner exposes
`structure_at_seq`). Content edits and other excluded facts do not advance a
structural watermark; a client cache needs its own read generation for them.

Reads MUST be paged, domain-capped, or constrained by an explicit measured
working-set envelope. A whole-collection read does not imply unbounded scale:
the catalog MUST state the tested row count, response-byte budget, latency
budget, and concurrent-view count, and MUST add paging or an enforced cap before
claiming a larger envelope. In-memory fold microbenchmarks do not establish read
or fanout scalability.

Outliner v3's current whole-tree pilot envelope is 1,000 rows and eight
concurrent viewers. Its workerd/Net gate requires a response below 512 KiB,
warm-read p95 below 1.5 s, and eight-view invalidation-wave p95 below 5 s. This
is a bounded pilot claim, not a claim that an unpaged tree scales without limit.

## ACT9. Conformance

An adopting catalog's tests MUST cover:

1. emission-authority and closed-schema refusals;
2. a later projection refusing after an earlier projection wrote, proving
   rollback of domain state, every projection, Act observations, and inverse
   bookkeeping;
3. rebuild equality over all projection-owned state and failed-entry skipping;
4. exact payload keys, including absence of envelope identity and artifact
   prose;
5. every normal domain path that changes an adopted fact, including undo;
6. documented exclusions and refused lifecycle bypasses, including
   authenticated sequenced calls to every internal helper and adopted-fact
   mutator; the same calls under a privileged `progr` MUST prove the explicit
   caller guards rather than only the missing `x` bit; and
7. bounded read latency, response bytes, and concurrent-view fanout on the
   production-shaped runtime before a scalability claim is made.
