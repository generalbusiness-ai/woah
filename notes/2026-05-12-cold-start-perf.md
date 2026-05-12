# Cold-start cost reductions

Origin: review of CF restart latency sources in May 2026. The review
identified six contributors; this pass landed the four that affect
user-visible restart delay. The remaining two (`/api/state` fan-out
projection and snapshot+replay log hydration) are scaling concerns and
deserve their own design pass.

## What landed

### `wrangler.toml`: documentation only

The intent was to flip the default `WOO_AUTO_INSTALL_CATALOGS` to
foundational-only for the ~4.2 s first-light win, but the public
deploy at `woo.hughpyle.workers.dev` runs from the checked-in
`wrangler.toml` with no separate deploy config, so flipping the
default would silently change behavior on any fresh/wiped production
deploy. Default stays at the full demo bundle. The comment block and
`DEPLOY.md §WOO_AUTO_INSTALL_CATALOGS` now spell out the trade
explicitly: operators wanting fast first-light can opt into
`"chat,help,note,prog"` before their own first deploy.

### `buildHostSeedForDelivery`: strip `verb.line_map`

Verb `line_map` dominated host-seed payload size on classes with many
compiled verbs (local sizing put the default-world seed JSON at roughly
half its size with `line_map` stripped). It's only consumed by
stack-trace formatting in `tiny-vm.ts:vmTraceFrame`, and the seed-merge
comparison (`bootstrap.ts:normalizeVerbForCompare`) already ignores it.
Delivery now ships verbs with `line_map: {}`.

Verbs from bundled local catalogs recompile their `line_map` via the
satellite's host-scoped catalog lifecycle, so stack traces from those
verbs are unaffected on the satellite. Verbs from non-bundled sources
(third-party taps, runtime authoring) accept the soft degradation —
line/column info is lost on the satellite, present on the gateway.

`verb.source` is kept (editor and diagnostic flows would need a lazy
fetch path to survive its removal). That's the obvious follow-up if
seed body size is still the bottleneck.

### Host-seed digest (groundwork only, no wire savings yet)

`buildHostSeedForDeliveryWithDigest` returns the seed plus a stable
SHA-256 digest of a canonicalized form. The wire body is left in its
existing layout (the merge contract assumes positional comparison on
some per-object arrays), so the canonical form is computed only for
digest purposes — `canonicalSeedForDigest` sorts the per-object arrays
and `canonicalJsonStringify` sorts object keys. Without this, mid-runtime
insertion-order Maps and post-hydration alphabetical SQL ORDER BY would
produce different digests for the same world content, defeating any
future optimization that compares digests across the gateway's own
eviction/reload.

The digest reaches receivers through:
- `/__internal/host-seed` adds an `x-woo-seed-digest` response header.
- `/__internal/apply-host-seed` accepts an optional `digest` field on
  the push path so receivers can store it after a successful merge.

Satellites persist `host_seed_digest` in `world_meta` after every
successful merge (cold-load + admin push). The cold-load path
**continues to fetch the full seed unconditionally**: a probe-then-skip
optimization on top of the digest is real future work, but it requires
either making `runHostScopedLocalCatalogLifecycle` gateway-authority-
aware (so foreign-hosted lifecycle writes — `$note` event schemas,
`$system` applied_migrations — don't survive a skip and diverge the
satellite) or caching the seed body locally so the post-lifecycle
merge can run without an RPC. The `persists cold-load host seed repairs
before a later refresh can consume them` test pinned down this
interaction. Until that lands, issuing a separate probe RPC ahead of
the same full fetch would be pure overhead, so the cold-load path
issues no probe and emits no skip metric.

What this pass ships is the durable digest plumbing — the header,
the persisted meta key, the canonical-form digest computation — so
the future skip path doesn't have to redesign it.

### Gateway route-set digest

`registerObjectRoutes` is the path the gateway runs on cold-restart to
re-publish all object routes to the Directory DO. Previously this fired
a signed RPC + Directory transaction on every cold-restart even when
the Directory was already current (the dedup filter only runs over the
in-memory `publishedRoutes` map, which is empty after eviction).

The gateway now hashes the current route set, compares against a
persisted `published_routes_digest`, and skips the RPC entirely on
digest match. The Directory's SQLite tables persist independently;
this assumes that persistence holds. An independently-wiped Directory
would silently degrade routing acceleration until any route mutation
triggers a fresh publish — that's an acceptable failure mode given the
common case wins (~one round-trip per cold gateway boot).

The new `directory_register_objects_skip` metric is the observable
signal for when the skip fires.

## Deferred

- `/api/state` vicinity-first projection (review item #1). Real benefit
  in active worlds; protocol surgery.
- Snapshot + replay-tail log hydration (review item #5). Speculative
  until log volume is actually paying back.
- Wiring the seed digest from groundwork into an actual probe-then-skip
  path. Needs lifecycle-authority-aware repair (or a locally cached
  seed body for the post-merge step), then it's basically free.
- Lazy-fetch path for `verb.source` (the other half of #3).
- Foundational-only `WOO_AUTO_INSTALL_CATALOGS` for the public deploy.
  Wants a separate deploy config (e.g. an `[env.foundational]` block)
  so the checked-in default can stay matched to woo.hughpyle.workers.dev.
