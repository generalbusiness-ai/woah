# Gap-0 native ports — status + execution-ready follow-up (2026-07-12)

Net-cutover layering item 3: port cold-path native verbs to compiled
woocode so the seeded world captures the behaviour instead of being pinned
to worker code. Review correction: native `VerbDef` pages DO ride the net
`verb_bytecode` cell kind, and an ephemeral planning `WooWorld` registers
the substrate native handlers before importing those pages. Native verbs
are therefore net-dispatchable while the matching worker capability exists;
`tests/net/bridge.test.ts` pins this with `$actor:focus_list` through the
cell round trip. Porting remains valuable because it drains superstructure
out of `world.ts`, makes behavior world-owned, and removes rolling-deploy
coupling. It is not, by itself, a cutover availability requirement.

## Done

**`catalog_registry_list`** — ported to a compiled `sourceVerb`
(`bootstrap.ts`): `verb :list() rxd { return this.installed_catalogs; }`.
The dead native handler was removed from `world.ts`. Test added
(`core.test.ts`): the verb carries bytecode and returns `installed_catalogs`.
The `install`/`update`/`migration_state` siblings stay native (they gate on
the wizard flag and drive catalog installation).

## Deferred (grounded; do test-driven, not rushed into the permanent seed)

These are all cold-path (not per-turn), so leaving them native is not a
cutover blocker. They should still be ported to reduce substrate/catalog
coupling. Each carries authoring risk best resolved against the existing
tests as the gate.

### features — `add_feature` / `remove_feature` / `has_feature` (on `$actor`, `$space`)
- Native: `world.ts` `addFeature` (9020–9038), `removeFeature` (9040–9051),
  dispatch registrations (10260–10262); helpers `featureList` (8921),
  `bumpFeaturesVersion` (8983), `canFeatureBeAttachedBy` (8988). Registered
  at `bootstrap.ts:1213–1217`.
- Gap-0 confirmed. DSL idioms verified: `has(list, item)` does list
  membership; `listinsert(l, length(l), x)` appends; `str_starts`, `dispatch`,
  `valid`, `has_flag` all present. Seeded defaults exist
  (`features=[]`, `features_version=0` on `$actor`/`$space`,
  `bootstrap.ts:1061–1062,1098–1099`), so no `E_PROPNF` risk.
- **RISK to resolve first:** the native pushes `feature_added` /
  `feature_removed` / `feature_already_added` onto the call's
  `ctx.observations` receipt, whereas DSL `observe(...)` routes through the
  audience model. Confirm the receipt vs audience delivery matches before
  landing — `tests/core.test.ts:2070–2071,2433–2488` assert the version bump,
  dedupe (no bump on duplicate add), and these observations, and are the gate.

### focus family — `focus` / `unfocus` / `focus_list` (on `$actor`)
- Native: `world.ts:10279–10305`, helper `focusListOf` (8754),
  `ACTOR_FOCUS_LIST_CAP = 32` (476). Registered `bootstrap.ts:1222–1233`.
- Gap-0. The `$block` reference is **safe** to keep in the ported DSL:
  `isDescendantOfChecked` returns false for an absent ancestor class, so
  `isa(target, $block)` is simply false in a `$block`-less world (correct:
  no appliances to focus) and resolves once the block catalog installs.
  Porting removes the `$block` core branch (`world.ts:10284`). The
  `canReadProperty(actor, target, "name")` check becomes
  `try { let _ = target.name; } except err { raise E_PERM }` under the
  actor's perms. Append with `listinsert`, cap by dropping the head when
  `length > 32`.
- Tests: `tests/mcp.test.ts` (self-only `E_PERM`, tool-list shape),
  `tests/core.test.ts:2262,2275` (`focus_list` set/cleared).

### help-db directives — `find_topics` / `get_topic` / `dump_topic` / `record_miss`
- The only catalog-level native façade: `catalogs/help/manifest.json:17–49`
  (4 native verbs on `$generic_help_db`); the `$player:help` dispatcher is
  already compiled (`PLAYER_HELP_SOURCE`, `bootstrap.ts:295`). The dialect
  interpreter is `world.ts:6296–6418` (`renderHelpTopic` 6361: `*index*` /
  `*pass*` / `*forward*` / `*objectdoc*` / `*verbdoc*`).
- Gap-0 (all builtins exist incl. `verb_code`, whose readability gate
  reproduces the `*verbdoc*` behaviour: `try { verb_code(obj, name) } except
  { "Verb source is not readable." }`). But it is ~120 lines of intricate
  directive/recursion logic — a focused, dedicated port. The layering
  review's own defer-list names "help-DB port".
- Tests (load-bearing): `tests/catalogs.test.ts:422–464` (routing,
  `record_miss` → `missed_topics`, every topic resolves) and `466–483` (the
  `*verbdoc*` readability gate: guest sees "not readable", wizard sees source).

### join_player (`@join`) — BLOCKED, not a mechanical port
- Native: `world.ts` `playerJoin` (10866–10905); registered
  `bootstrap.ts:1147`. It resolves the target via `matchPlayerForCommand`
  (10955), a **global enumeration of all objects** filtered to `$player`.
- There is no DSL builtin for a global player-name match, and adding one
  would introduce a global-enumeration primitive into woocode — a Big-World
  violation (the same class of problem as `connected_players`, item 6). So
  this is a design decision, not a port: either keep the current
  partial/global native behavior, or redefine
  `@join` with location/connected-scoped match semantics. Recommend keeping
  it native until the semantics are decided; do not add a global
  `match_player` builtin.

## Pattern for the ports (reference)
Convert `native(world, obj, name, handler, "...stub...", opts)` →
`sourceVerb(world, obj, name, SOURCE, opts)` (identical option signatures),
add the DSL `SOURCE` constant near `PLAYER_HELP_SOURCE`/`THING_LOOK_SOURCE`
in `bootstrap.ts`, and remove the now-dead `nativeHandlers.set(handler, ...)`
in `world.ts`. Worked example of a formerly-native verb calling generic
builtins: `PLAYER_HELP_SOURCE` (`bootstrap.ts:295`).
