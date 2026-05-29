# 2026-05-28 — owner-side tool-surface verb cache (Cause B fix)

## Why

Prod cross-actor MCP smoke after the 2026-05-28 deploy (version
`bdae5388…`) failed with `the_outline:enter` resolving `not_reachable`
/ `E_VERBNF`. Root cause (see the review thread): `/__internal/enumerate-tools`
burned p95 CPU 6.9s and `the_outline` timed out 4/4 at the 5s host read-RPC
budget (`HOST_READ_RPC_TIMEOUT_MS`). On owner timeout with no cached rows the
scope contributes **zero** tools, so the verb the actor wants is never listed
and `enter` can't resolve — a downstream cascade, not a parser bug.

The cost is in `McpHost.enumerateLocalToolDescriptors`: for a `$space` with
`expandContents`, it iterates the space's **entire `contents`** and recomputes
the obvious/tooled verb surface per child via `obviousCommandVerbs` /
`computeTooledVerbs` (full ancestry + feature-chain walk, `canExecuteVerb` per
verb, `formatCommandSyntax` per verb). `the_outline` is an `$outliner < $space`
whose every node `moveto`s into the space's contents, so the surface scaled with
the whole outline tree: `O(items × ancestry × verbs)`. No owner-side cache
existed — every enumerate recomputed from scratch.

## What changed (`src/mcp/host.ts`)

The obvious/tooled verb surface for an object is fully determined by
`(projection, actor, the object's class lineage + its own verbs/features)` —
identical for same-class items. `formatCommandSyntax` only substitutes the
object *name* into display text; it never changes which verbs are included.
`canExecuteVerb(actor, verb)` depends on `verb.perms`, `verb.owner === actor`,
and `canBypassPerms(actor)` — so the cache keys on the actor.

- Added `verbSurfaceCache`, keyed by a class-identity string
  (`verbSurfaceClassKey`: projection | actor | immediate parent | own-verb
  identity | own `features` value | tools-projection block/self discriminators).
  Under single inheritance the immediate parent fully determines the inherited
  ancestry and feature list, so same-parent siblings with no own definitions
  collapse to one key.
- Own-verb keying: an object that defines its OWN verbs gets an object-unique
  key (`self:<id>`), never shared. Own verbs contribute per-object content
  (arg_spec, source, perms, owner, exposure flags), not just names — keying them
  by name alone aliased two same-parent objects that each define `:zap`, so the
  second was emitted with the first's schema/source and source_rows (caught in
  review; regression test added). Own-verb-free siblings (the hot outline case)
  still collapse via the `shared` marker.
- Invalidation uses the existing `world.mutationVersion()` epoch idiom (same as
  `world.hostSeedCache`): the whole cache is dropped when the global mutation
  version advances. Any verb/perm/feature/actor edit bumps it (verb installs go
  through `addVerb` → `bumpMutationVersion`), so an entry is only ever read
  within the epoch that produced it. **No per-entry staleness is possible.**
  `obj.modified` was rejected as the signal because `addVerb` does not bump it.
- `obviousVerbsFor`/`tooledVerbsFor` now consult the cache for the expensive
  walk; `computeTooledVerbs` holds the original walk. The per-object `owner`
  default for the obvious projection (`verb.owner ?? id`, which feeds
  `toolSurfaceSourceRows`) is re-applied on each call and **never** baked into
  the cached array, so siblings don't inherit the first item's id.

Within one synchronous enumerate (no mutation occurs mid-call) the version is
fixed, so the per-call collapse — the actual timeout fix — always holds. Across
calls the cache also holds until the next world mutation.

## Result

`enumerateLocalToolDescriptors` over a same-class space goes from
`O(items × ancestry × verbs)` to one verb walk per distinct class plus
`O(items)` cheap per-object work (visibility check, 1-step enclosing-space walk,
per-object source rows).

## Tests

`tests/mcp.test.ts` — two new cases:

1. "collapses the obvious verb surface across same-class space contents and
   invalidates on edit": 60 same-class items in a space, asserts (a) per-object
   descriptor correctness incl. `source_rows.authority_scope`, (b) exactly one
   `obviousCommandVerbs` walk for 60 items (collapse), (c) zero walks on a second
   mutation-free enumerate (cross-call hold), (d) recompute + new verb visible on
   every item after a class verb edit (invalidation).
2. "does not alias same-named instance-owned verbs across same-parent objects":
   two same-parent objects each define their own `:zap` with different
   params/bodies; asserts under both the tools and obvious-contents projections
   that each keeps its own `source`, a distinct `arg_spec`, and own-object
   `source_rows`. Verified red against the name-only key before the `self:<id>`
   fix.

All 61 mcp tests + v2-mcp-e2e + gateway-projection-cache + catalogs (128) pass;
`npm test` (229), both typechecks, and all guards green.

## Not in scope / follow-ups

- B3 (don't yield zero tools on owner timeout): already mitigated by the
  existing `sessionManifestDescriptors` stale fallback in
  `enumerateToolsForScope`; with the timeout cause removed it rarely triggers.
  Hardening the no-manifest degradation path is a separate behavior decision.
- Cause A (cold-load whole-world materialization on the MCP critical path,
  `mcp_gateway_snapshot_fetch` 12–18s): unchanged here. That is the init-timeout
  driver and needs lazy bytecode hydration / gateway-slice snapshot — separate
  work.
- Spec: behavior (which descriptors are emitted) is unchanged, so no normative
  spec edit. The observability note for `/__internal/enumerate-tools` timing
  remains accurate.
