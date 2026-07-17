# Layering review: substrate ↔ catalogs ↔ client (2026-07-11)

Five-way parallel audit of the layering between builtin/VM features, catalog
objects and verbs, and the UI layer, against the doctrine in AGENTS.md and
`spec/semantics/core.md` C0. Line numbers verified against the current
working tree on main. This is a findings document — nothing was changed.

Overall verdict: the discipline is real and visibly working — structural role
detection, the native-primitive contract file, data-driven knobs
(`guest_initial_room`, `arg_spec.command.*`), guards that have already
evicted couplings from the MCP gateway, and a chat-formatter registry that
replaced the old client dual-list. The debt is concentrated in five clusters,
each with a clear remedy. Separately, the project's own maps (AGENTS.md
orientation, several "implemented"-status specs) have drifted behind the
code and are now actively misdirecting work.

---

## Cluster 1 — Chat/LambdaCore command machinery lives in core `world.ts`

The single largest mass of superstructure in the substrate. All of it is
user-visible behavior that AGENTS.md explicitly assigns to catalogs.

| Finding | Where | Detail |
|---|---|---|
| Speech-prefix grammar | `world.ts:11137–11200` | `"`, `:`, `/me`, `]`, `\|`, `<`, `;`, `;;`, backtick, `/tell`, `[style]` each mapped to catalog verb names (`say`, `emote`, `pose`, `quote`, `say_as`, `say_to`, `tell`, `eval`). Self-labeled "Transitional". |
| `drop` special case | `world.ts:11128` | `if (cmd.verb === "drop" && !cmd.argstr)` → hardcoded English "Drop what?" in the generic planner. |
| `look at` rewrite | `world.ts:11479` | Folds `look/l/examine/ex … at X` in the generic tokenizer. |
| Durable-verb list | `world.ts:12037–12044` | `COMMAND_PLAN_DEFAULT_DURABLE_VERBS` (enter/leave/go/north/…/take/drop/give) forces durable commits by verb name — exactly the "transport-layer knowledge of command words" that `cell-authority.md:735` forbids. Comment admits the compromise; no retirement ratchet. Only ONE manifest verb (`chat` `$conversational:enter`) declares `route`/`persistence`; its sibling `leave` works only via this fallback. The cross-scope `:enter` needs `route:"sequenced"` rule is folklore, spec'd nowhere. |
| `dullClasses` | `world.ts:10968` | `{"$root","$room","$player","$prog","$builder"}` — obvious-verbs surface filtered by catalog class names ($room=chat, $prog/$builder=prog). |
| `playerJoin` (@join) | `world.ts:10860–10899` | Complete native user-facing verb, LambdaCore-verbatim strings, core-emitted catalog-typed `left`/`entered`. Nothing in it needs native capability. |
| Help-DB engine | `world.ts:6295–6425` | Full LambdaCore help system: `*index*`/`*pass*`/`*forward*`/`*objectdoc*`/`*verbdoc*` directive dialect, English strings, `$system.help_dbs` chaining. `catalogs/help` is a pure façade (all 4 verbs native). |
| `$match` cluster | `world.ts:10345–10397`, `~11100–11500` | `match_object/match_verb/match_command_verb/plan_command/parse_command` — the whole text-command pipeline native; chat's wrappers are shims. Spec-acknowledged debt (match.md header), but now has a hard architectural cost (see Cluster 5 / net path). |
| Editor subsystem | `world.ts:5127–5300` | Full line-editor semantics (slots, dirty state, insert/delete, location restore) + 10 `editor_*` builtins in `tiny-vm.ts:1209–1238`. Role detection is structural (good), but "editors" are named in the layering rule as catalog territory. |

**Remedies:**
- Prefix→verb table as catalog data (e.g. a `$match.speech_prefixes`
  property) consulted generically by the planner; delete the `drop` special
  case (verb arg-spec mismatch / `huh` hook covers it); `look at` folding as
  verb metadata (e.g. `arg_spec.command.fold_prep: "at"`).
- Spec the durable-presence criterion in match.md; stamp
  `persistence`/`route` on all movement/handling verbs in the chat manifest;
  demote `COMMAND_PLAN_DEFAULT_DURABLE_VERBS` to a drift-warning guard.
- `dullClasses` → per-class flag (`command_surface_dull: true`) declared by
  the owning catalogs.
- Port `playerJoin` and the help-DB directive interpreter to woocode (both
  are expressible today — see Cluster 5 Gap 0/1); only cross-host topic
  reads need a generic primitive.
- `$match` port is gated on Gap 1 (list/string builtins) — highest-leverage
  VM work in the codebase.

## Cluster 2 — Observation routing: one contract split across five places

The audience/routing contract for observation types is duplicated and
partially undeclared:

1. `world.ts:9197` — `looked`/`who` to-only routing (type names hardcoded).
2. `src/core/shadow-browser-node.ts:1439` — same rule, second copy.
3. `src/worker/persistent-object-do.ts:9060` — same rule, third copy
   (`mcpObservationActorTargets`); actor-exclusion for
   `entered/left/taken/dropped` duplicated at `world.ts:9217` and
   `persistent-object-do.ts:9071`.
4. `src/core/types.ts:94` — `DIRECTED_OBSERVATION_TYPES = {"told","text"}` in
   the foundational types module.
5. Client: routing is now registry-driven (`ChatFormatterRegistry`,
   `framework.ts:883`) — good — but the manifest
   `ui.observation_handlers`/`ui.chat_formatters` declarations are **dead**
   (declared in manifests, typed at `framework.ts:287–303`, read by nothing;
   modules register whatever they like, unlike component tags which ARE
   validated via `allowedTagsForModule`, `framework.ts:442–449`).

Meanwhile the manifest `schemas` block — the natural home for this contract —
is installed server-side (`catalog-installer.ts:545–548` →
`world.defineEventSchema`) but consumed by **nothing**: no emission
validation, no routing, zero client reads. And the spec is behind the code:
`events.md §12.7` (status: implemented) declares a closed 4-rule audience
set, but `world.ts:9193–9203` runs two undocumented rules first
(`_audience_override`, and generic `target`-is-actor private routing beyond
the spec'd `text`-only case). `persistent-conversation.md:377` cites
"events.md §13" for `_audience_override`; events.md never defines it.

**Remedy (highest-leverage single move in this review):** make the manifest
`schemas` block the one routing contract.
- Add routing attributes to schema entries: e.g. `audience: "to"`,
  `audience_excludes_actor: true`, `channel: "chat"`, `render: {text_field}`.
- Key all three server routers on schema metadata and converge them into one
  shared function; retire `DIRECTED_OBSERVATION_TYPES`.
- Enforce `ui.observation_handlers`/`chat_formatters` decls at registration
  the way `defineTag` enforces tags; add a guard diffing
  decls ↔ `schemas` ↔ actual emissions (the diff table below would then be
  mechanically maintained).
- Amend events.md §12.7 with the two real rules; fix the dangling §13 ref.

### Observation-type ledger anomalies (from the full diff)

- **Ghost vocabulary:** `note_moved`, `note_resized`, `note_color_changed`,
  `note_deleted`, `notes_cleared` — handled in pinboard UI + main.ts,
  emitted by nothing, declared nowhere.
- **Dead declarations:** `help` schema types (help manifest contains no
  `observe()` at all), `editor_entered`/`editor_saved` (prog).
- **Undeclared but emitted:** `text` (chat's most basic type — missing from
  chat's schemas), `weather_open` (weather has no schemas block),
  `property_changed`/`value_changed` (substrate types, declared nowhere).
- **No consumer (generic panel only):** dispenser `order_placed`/`delivered`/
  `canceled`, dubspace `scene_saved`/`cursor`, prog `builder_*`/
  `programmer_*`, pinboard `pin_added` (UI module has no reducer for it).
- **Catalog vocabulary reduced in client core** (`framework.ts:1225–1322`):
  `taken`/`dropped` (chat), `note_edited`/`note_writers_changed` (note),
  `block_data` (block), `control_changed`/`gesture_progress` (dubspace).
  Only `property_changed`/`value_changed` belong there. Move the rest into
  the owning catalogs' UI modules (mechanism exists; pinboard/outliner/tasks
  already use it).

## Cluster 3 — Client: catalog UI is statically compiled in

- `src/client/main.ts:2–19` statically imports 9 catalog manifests + 9 UI
  modules by literal path; `installBundledCatalogUi()` (main.ts:2985–3015)
  registers them from a hardcoded array. The generic dynamic path —
  `CatalogUiRegistry.loadModule` (framework.ts:458, `import(/* @vite-ignore */)`)
  — has **zero call sites**. `GET /api/catalogs/ui` skips non-`@local` taps
  (`local-catalogs.ts:414`). Manifest `ui.modules[].entry` is a repo-relative
  TS path, not a servable artifact; catalog UI modules import framework types
  by relative source path. **Consequence: third-party catalogs cannot ship
  UI.** The `abi: "woo-ui/v1"` and `UiModuleDecl.sha256` fields already
  anticipate the fix.
- `main.ts` carries whole subsystems for specific catalogs: `class DubAudio`
  (main.ts:5565, a Web Audio synth for dubspace), pinboard map/animation
  machinery (~429 pinboard-matching lines of 5743), hardcoded
  `TOOL_TAB_DEFINITIONS` (main.ts:225–287) duplicating what `ui.frames` +
  `resolveFrame` (framework.ts:490) already model, and per-catalog
  type-guard functions (`isDubspaceObservation` etc., main.ts:3298–3316)
  that Cluster 2's schema `channel` attribute would retire.
- `framework.ts:530–545` (`ingestWorld`) special-cases `world.dubspace` /
  `world.pinboard.notes` payload shapes; pinboard's field list lives at
  framework.ts:1496–1502.

**Remedies:** wire `loadModule` as the only path (served, hashed JS artifacts
from the catalog install record; publish the framework contract as a
versioned package); drive tool tabs from installed `ui.frames`; evict
DubAudio, pinboard map/animation, and catalog reducers into their catalogs'
UI modules.

Status note: the "pinboard peer note_added not rendering" bug from earlier
memory is **fixed on main** (reducer moved to
`catalogs/pinboard/ui/pinboard-board.ts:453–472`, no actor filter).

## Cluster 4 — Class-identity and object-identity branches in runtime core

- `movetoChecked` (`world.ts:5855`) branches on `inheritsFrom(objRef,
  "$actor")` into `movetoActorChecked` (5913), which **skips the step-1
  virtual `obj:moveto` dispatch entirely** and adds session/CA11/presence
  machinery. This contradicts `spec/semantics/moveto.md` M2 (status:
  implemented, one chain for all objects, no actor case) — the worst
  spec-vs-code contradiction found. Either spec the actor path (cross-ref
  CA8/CA11) or restore the dispatch; today a `$player:moveto` override is
  silently bypassed for actors.
- `$block` (block catalog) branched on in core (`actor_focus`,
  `world.ts:~10278`) and MCP host (`src/mcp/host.ts:507, 1224, 1228`).
  Remedy: role flag (e.g. `appliance: true`) declared by the catalog.
- `$failed_match`/`$ambiguous_match` (chat) sentinels known to core
  (`world.ts:10364–10385, 11364–11368, 11702–11703`). Remedy: sentinel refs
  as `$system` config set at catalog install, or structured return values.
- `$room` (chat) in `primaryRoomForLocation` (`world.ts:4471`). Remedy:
  `primary_scope: true` class property or the existing space-like probe.
- `directAudience` (`world.ts:9051`) re-aims audience `if verbName ===
  "moveto"` — ad-hoc verb-name branch outside the declared chain. Remedy:
  verb-metadata audience attribute.
- `guest_` id-prefix regexes (`world.ts:3436, 8562`;
  `persistent-object-do.ts:8901, 8998`) instead of class descent.
- `connectHermes` (`world.ts:2843–2871`): a named external product's
  provisioning flow in core. Generalize to `provision_agent(kind, profile,
  return_url)`.
- `directory_reconcile_corenames` builtin hard-codes `$system`
  (tiny-vm.ts:1031); `builder_create_object`/`builder_chparent`
  (tiny-vm.ts:1186) are self-documented auth bypasses with a named fix.
- `browser-open-seed-contract.ts:19–25` labels `mount_room`/`last_undo` as
  "substrate" properties; they're defined by dubspace/outliner/pinboard.
  Remedy: catalogs declare open-seed property needs in manifests.

## Cluster 5 — Native verbs, VM capability gaps, and the net-path blocker

Correction to prior working notes: `look`, `who_all`, `help`,
`examine_detailed`, `inventory`, `home`, `ways` are **compiled sourceVerbs**
now, not natives. The net-planner blocker (natives have no `verb_bytecode`
pages → `src/net/plan.ts:585–614` pull loops to E_BUDGET) is the remaining
native set: the `$match` cluster (every parsed command), `help_db_*`,
`space_live_audience`, the moveto/focus/feature natives, and the auth suite.

`native()` (`bootstrap.ts:1386`) writes `kind:"native"`, no bytecode — 21 of
44 natives carry only a `{ ... }` stub doc-string (letter of the AGENTS rule,
not its spirit).

**Ranked capability gaps (by natives unblocked):**
- **Gap 0 — no gap (12 natives):** movable today with existing builtins:
  `thing_moveto` (its doc-string IS the code), `player_moveto`,
  `join_player`, `can_be_attached_by`, `player_on_disfunc`,
  `catalog_registry_list` (one property read!), `migration_state`,
  `actor_focus/unfocus/focus_list` (also removes the `$block` core branch),
  `has/add/remove_feature`, `promote/demote_agent` (via existing
  `set_actor_flag`).
- **Gap 1 — list/string machinery (9+, all hot-path net blockers):** DSL
  list-append is O(n) copy with monotone memory accounting
  (tiny-vm.ts:240–247); no `sort`, `str_replace`, pattern matching. Stated
  reason `object_tree_rows`/`object_siblings_ordered` exist; practical
  reason `match_*`/`plan_command`/`parse_command`/`help_db_*` stay native.
- **Gap 2 — generic session/log reads (2 verbs, 4 catalogs):**
  `space_live_audience` = "sessions whose activeScope == space" relation
  read; `$space:replay` needs `log_entries(space, from, limit)`. Fits the
  projection/relation-pipeline direction.
- **Gap 3 — credential primitives (~10 of 16 auth natives):**
  `mint_secret()`, `close_sessions(actor)`, `audit(action, map)`; the
  flag/quota arithmetic around them is ordinary woocode.
- **Gaps 4/5:** wait-for-observation signal (`actor_wait`); guest-pool
  primitive (keep `return_guest` native, move choreography to woocode).
- **Compiler ceiling (general):** no functions/lambdas, no `finally`
  (dsl-compiler.ts:527), no nested assignment targets (857–888), builtin
  additions need three-way compiler/VM/spec sync, `BUILTIN_NAMES` is
  index-encoded and permanently uncompactable (`_dead_*` tombstones).
- **VM builtins carrying superstructure:** `describe_object`,
  `visible_contents`, `obvious_verbs`, `remote_describe` (presentation);
  `connected_players` (**global enumeration — Big-World violation**, sole
  consumer `who_all`); `editor_*` ×10; `object_tree_rows` hard-codes prop
  names `"hidden"`/`"name"`/`"owner"`/`"writers"`; `location` builtin
  special-cases `ctx.actor` (session activeScope) — undocumented.

For the net cutover specifically: **Gap 0 + Gap 1 + Gap 2 cover every
per-turn native** except auth/catalog-install, which net turns don't
normally dispatch.

## Cluster 6 — Catalog-side duplication and internals leakage

- `room_roster` byte-identical ×3 (dubspace/outliner/pinboard, md5
  d69f52af) + a 4th inline copy in chat `$room:look_self`. Missing shared
  roster feature on `$space` (or generic builtin).
- `catalogs/perm` exists but only block+prog use it; ~62 inline
  `has_flag(x,"wizard")` checks across 11 catalogs; `$note` reinvents
  `is_readable_by`/`is_writable_by`.
- `weather` hand-rolls `zpad2`/`parse_md`/date logic (~3.1KB woocode)
  because there are no date/format builtins and it doesn't depend on `core`
  catalog's `$string_utils`.
- `live_audience` woocode fallbacks iterate raw `session_subscribers` rows,
  knowing the `{session, actor}` row shape (substrate projection internals).
- `demoworld` seeds hand-copied `next_seq/subscribers/last_snapshot_seq`
  (redundant with `$space` defaults).
- Presentation split is inconsistent: some pinboard observations carry
  pre-rendered English `text` composed in DSL (manifest.json:265,275),
  others rely on client formatters; the per-type convention is undocumented.
  The pinboard `:viewport` geometry contract is half in DSL, half in client
  clamp constants (main.ts:335–341).

## Cluster 7 — Guards and documentation drift (meta-layer)

The guards that should hold the line have blind spots, and the maps lie:

- `scripts/guard-layering.mjs` wholesale-exempts `world.ts`, `mcp/host.ts`,
  `tiny-vm.ts`, `local-catalogs.ts` as "legacy debt" with **no per-file
  ratchet count**, and scans only `src/core` + `src/mcp` — never
  `src/worker`, `src/server`, `src/net`. Remedy: baseline counts that must
  monotonically decrease; extend scan roots.
- `src/core/local-catalogs.ts` (2045 lines, ~133 `$`-literals, references a
  specific room instance `"the_garden"`) is sanctioned CT5.4.1 machinery but
  is the fastest-growing pile of catalog knowledge in core. Remedy: move
  payloads to `catalogs/<name>/migration-*.json`; shrink to a generic applier.
- **AGENTS.md orientation is stale and misdirects work:** `chatSystemText`
  no longer exists; `isChatObservation` (now main.ts:3294) delegates to the
  formatter registry; the "add to BOTH lists" rule is now "register a
  ChatFormatter in the catalog's ui module". Line anchors drifted
  (~5821→9188, ~3894→5855).
- Spec updates needed (all spec-side unless noted):
  - `events.md §12.7`: add `_audience_override` + generic target routing;
    fix `persistent-conversation.md:377` dangling ref.
  - `moveto.md`: actor path (or code fix — decide), stale line refs.
  - `match.md MA7`: speech-prefix grammar, verb lowering, huh text,
    durable-verb list are undocumented substrate policy in an
    "implemented" spec.
  - `catalogs.md CT2/CT5.5`: "chat/tasks/dubspace install from source
    alone" is false (chat=6 native hints, dubspace=1; only tasks is clean).
  - `catalogs.md CT5.5`: schema `live:` flag spec'd but dropped by the
    installer, zero consumers — mark deferred or implement.
  - `catalogs.md CT12`: claims tasks has no UI and the framework doesn't
    exist; both false. `ui-component-model.md` is substantially implemented
    but still "draft" — under the repo's own rule the implemented UCM
    machinery has no normative reference.
  - `catalogs.md CT15` + `bootstrap.md B1/B6`: bundled-catalog inventory
    omits block, blocks-demo, core, dispenser, perm (some are dependencies
    of listed catalogs).
  - `bootstrap.md B2.16`: `$thing:look` missing from the verbs table.
  - `builtins.md §19`: `authoring_inspect`/`authoring_search` undocumented.
  - Doctrine decision needed: core's type-name routing for
    `looked/who/entered/left/taken/dropped` is sanctioned by events.md but
    in tension with core.md C0 — either bless it explicitly in C0 or adopt
    the schema-attribute remedy (Cluster 2) and close the tension.

---

## Prioritized program

1. **Schema-attribute observation routing** (Cluster 2). One contract in the
   manifest `schemas` block; converge the three server routers; enforce
   client UI decls; add the decl↔schema↔emission guard. Kills the largest
   duplication and the doctrine tension in one move.
2. **Gap-0 native ports + Gap-1 builtins → `$match`/help-db woocode ports**
   (Clusters 1, 5). Direct unblock for the net cutover (every per-turn
   native), and it drains the biggest superstructure mass out of world.ts.
3. **Client dynamic UI loading** (Cluster 3). Wire `loadModule`, served
   artifacts + sha256, versioned framework package; retire the static import
   block, `TOOL_TAB_DEFINITIONS`, and evict DubAudio/pinboard machinery.
4. **Class-identity flags** (Cluster 4): dull/appliance/primary-scope
   properties, sentinel config, moveto actor-path spec decision.
5. **Guard ratchets** (Cluster 7): baseline counts, worker/server/net scan
   roots — so clusters 1–4 shrink monotonically instead of regrowing.
6. **Spec + AGENTS.md refresh** (Cluster 7 list). Cheap, and it stops the
   stale maps from misdirecting the next task.

---

## Net-cutover sequencing (added 2026-07-12)

The §8 cutover installs a fresh net namespace from the catalog bundle and
**refuses re-seed after the first commit** (`E_SEED_COMMITTED`); catalog
updates over the net path are unproven. So the install is a one-time free
window for anything that changes *installed world shape*. Also verified:
the net gateway fanout (`net-cutover` branch, `gateway-do.ts:2913–2921`)
is structural (`to:` field + turn-id dedupe, no type-name lists) — the
type-name routing copies are all v2-side.

**Before the freeze/export/install:**
1. Stamp `route`/`persistence` on chat movement/handling verbs + spec the
   criterion (retires reliance on `COMMAND_PLAN_DEFAULT_DURABLE_VERBS`).
2. Schema ledger hygiene + routing attributes — manifest half only
   (declare `text` etc., delete ghost/dead types, add audience/channel
   attrs). Router convergence in TS can follow post-cutover.
3. Gap-0 cold-path native ports (`join_player`, focus family, features,
   `catalog_registry_list`, help directives) — makes the seeded world
   self-describing instead of pinned to worker code. NOT the moveto
   family (hot path; don't churn pre-deploy).
4. Sentinel refs as `$system` config; drop demoworld's hand-copied seq
   seed state.
5. Decide + spec the moveto actor path (spec-only) so net movement has a
   normative reference during the bake.
6. Verify/bound global-enumeration builtins (`connected_players` behind
   `who`) under sharded partial views — workerd lanes structurally cannot
   catch this class.
Caution: any actor-adjacent property changes must be re-checked against
the identity export closed prop allow-list (`src/net/identity.ts`).

**Defer past cutover:** $match/help-DB port + Gap-1 builtins (hottest
path, maximal pre-deploy blast radius), all client-side work, editor
port, perm/roster dedup. Guard ratchets + doc refresh gate nothing — do
anytime. These items are additional to, not a substitute for, the NC8
pre-switch blockers (sharding, RPC deadlines, elastic guests, metrics).
