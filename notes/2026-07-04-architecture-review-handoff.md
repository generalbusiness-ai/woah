# Architecture Review — Handoff for Prioritization

Date: 2026-07-04
Author: architecture survey (four parallel subsystem passes + current-state note review)
Audience: a reviewer who will set subsequent directions
Repo state: `main` @ `b8e55f9`; prod last known good rollback target `779ef147`
Scope: whole-system review — VM, catalogs, extensibility, deployment models —
and where the implementation diverges from the project's stated goals.

> How to read this: §1–§5 describe *what is built*. §6 is the honest variance
> ledger (goal vs reality). §7 is a proposed priority ordering; treat it as
> input, not decision. Every claim carries a `file:line` or spec anchor so you
> can verify without re-deriving.

> **Current-state addendum (2026-07-05):** the repo-state and §4 numbers below
> are a snapshot from the 07-04 survey and are now *historical*. As of
> 2026-07-05: `main` is at `b8e55f9` ("Repair MCP retry and outliner movement
> conflicts") and **the deployed baseline passed after the `b8e55f9` cycle**
> (owner review, 2026-07-05) — the "7/10 with three standing cross-scope
> failures" description in §4 records the deploy-#5 era, not the present.
> Keep §4 for the failure-class history it documents; do not cite it as
> active non-convergence. The prioritization question this handoff fed has
> since been decided: see `plans/002-simplest-deployable-system.md` and
> `notes/2026-07-04-simplest-system-plan.md` (rev 3).

---

## 0. One-paragraph orientation

woo (spec name "woah") is a modern LambdaMOO successor: persistent,
individually-addressable programmable objects with single-parent inheritance,
verbs run in a sandboxed bytecode VM, structured event/observation messaging,
and a globally-distributed production profile (Cloudflare Durable Objects,
one host per object/scope, no node holding the whole world). It splits cleanly
in the *design*: a **substrate** (TypeScript under `src/`: object model, Tiny
VM, hosts, transports, generic builtins, catalog installer) and a
**superstructure** (woocode: classes/verbs/properties authored in a DSL and
shipped as installable **catalogs**). The substrate is largely sound and the
catalog model is genuinely well-factored at its core. The load-bearing risk is
**not** the object model or the language — it is **distributed state
convergence on Cloudflare**, where the same logical world exists in ~seven
unmanaged materializations and cross-scope turns (movement, cross-room
observation) still ride an older "ship a snapshot, validate by re-execution,
repair on failure" mechanism that the cell-authority redesign was meant to
replace. Local/in-memory and SQLite are functionally green; deployed CF is
functional-but-not-yet-performant and intermittently non-convergent.

---

## 1. The substrate — object model & Tiny VM

### 1.1 Tiny VM (`src/core/tiny-vm.ts`, 1683 lines)

A stack VM over `TinyBytecode` (`ops: [op, operand, operand2, operand3][]`).
Execution is a flat array of `VmFrame`s (`tiny-vm.ts:24`), each carrying its own
stack, locals, handler stack, pc, and per-frame tick/memory/wall budgets. The
driver is `runVmFrames` (`:212`). Max call depth 128 (`E_CALL_DEPTH`).

- **Opcode set** (big switch `:325`): arithmetic/compare/jump, `FOR_LIST`/
  `RANGE`/`MAP` iterators, prop get/set/define, `CALL_VERB`/`PASS`/`RETURN`,
  `STR_CONCAT`/`INTERP`, `SPLAT`, and the substrate-specific
  `OBSERVE`/`EMIT`/`YIELD`/`FORK`/`SUSPEND`/`READ`/`TRY_PUSH`/`TRY_POP`.
- **`OBSERVE`/`EMIT`** (`:697`) pop a `{type,...}` event and call
  `ctx.observe(...)`; **all audience routing lives in world.ts**, not the VM —
  the VM is a pure emitter.
- **Builtin dispatch**: `BUILTIN` op (`:589`) → `tryFastBuiltin` → `callBuiltin`
  (`:823`). ⚠️ **`BUILTIN_NAMES` is an index-stable, append-only list** (`:110`):
  persisted bytecode encodes builtins by numeric index, so a mid-list insert
  silently misdispatches stored verbs. It already carries dead tombstones
  (`_dead_*`, `:131`) kept only to hold indices. This is a real
  forward-compat landmine — document it as a hard invariant or move to
  name-keyed dispatch with a compatibility table.
- **Metering**: per-op tick decrement (`:318`, weights `:1441`), wall-clock
  check, monotone memory accounting that **deliberately never refunds on pop**
  (`:242`). Defaults: 100k ticks, 4 MB, 10 s, 4096 stack.
- **Durable `SUSPEND`/`FORK`/`READ` are fully implemented, not stubbed** — they
  throw `VmSuspendSignal`/`VmReadSignal` carrying `serializeVmFrames(frames)`
  (`:720`); world.ts persists them as parked-task projection rows
  (`world.ts:831`) and rehydrates. This is the one complete durable-continuation
  path in the substrate and is a genuine strength.

**Design tension:** the VM is *not* self-contained. `callVerb` (`:276`) detours
native verbs and remote objects back through `world.dispatch` (`:295`), so
execution constantly re-enters the god object. That coupling is why the VM
can't be reasoned about (or scaled) independently of world.ts.

### 1.2 The DSL compiler (`src/core/dsl-compiler.ts`, 1293 lines)

Clean three-stage pipeline `compileWooSource` (`:169`): `Lexer` → `Parser` →
`Codegen`, returning bytecode + `line_map` + call-graph metadata (the `calls`
list drives purity analysis and the install-time static call check).

- **Expressible:** locals (`let`), arithmetic/logical/unary, `if/else`, `while`,
  `for` over list/range/map with break/continue, property + dynamic-property +
  index access, list/map literals, string interpolation, `:verb` calls,
  `try/except` → `TRY_PUSH`/`TRY_POP`.
- **Special-cased:** `observe()`/`emit()` and `pass`/`suspend`/`read`/`fork`
  compile to dedicated ops (`:990`, `:1121`); any other bare call must be in the
  fixed `BUILTINS` set or it's `E_COMPILE: unknown builtin`.
- **Not expressible** (⇒ why 42 verbs stay native): no closures/first-class
  functions, no host/IO, no raw session/credential/flag mutation, no
  wizard-authority primitives. Anything touching TS-side host maps (API keys,
  provisioning, catalog install, flag mutation) cannot be written in woocode.

### 1.3 Bootstrap seed graph (`src/core/bootstrap.ts`, 1438 lines)

Seed graph (`:992`): `$system` → `$root` → {`$actor`→`$player`→
{`$wiz`,`$guest`,`$human`,`$agent`}, `$account`, `$sequenced_log`→`$space`→
`$catalog_registry`, `$thing`→{`$catalog`,`$nowhere`}}. ~19 `sourceVerb`
(woocode) and **42 `native()`** verbs; every `native()` carries a Woo-signature
docstring recording the intended eventual woocode form (`native()` upsert at
`:1386`). The direction-of-travel is being honored — `help` has already moved
from native to `sourceVerb`. See §6.4 for the residual native debt.

### 1.4 `world.ts` — the god object (12,391 lines, ~591 methods)

**This is the single most important structural fact in the codebase.** It is
5× the next-largest core file and has *no section headers*; navigation is by
naming convention alone. It jams together at least seven distinct concerns on
one class over shared mutable state:

1. Object model / substrate (create, properties, verbs, inheritance, recycle).
2. An event-sourcing / shadow-persistence / projection-write engine
   (`recordTurn*`, `recordProjectionWrite:817`, `E_NEED_STATE` repair).
3. A full LambdaMOO-style command parser/matcher (`planCommand:3701`,
   `matchCommandVerbOnTarget:11197`, ~46 `Command*` methods).
4. Session / presence / directory management (~100 `Session*` methods; the one
   TODO in the file, `:10542 TODO(cross-host-session-gc)`).
5. Native-handler wiring (`registerNativeHandlers:9975`).
6. Catalog-registry lifecycle handlers (install/update/list/migration_state).
7. Observation audience routing (`observationAudienceActors:9149`).

Two hot paths worth knowing: `movetoChecked` (`:5816`) — receiver-driven move
chain that dispatches a user `:moveto`, guarded by a per-call `movetoStack`
marker to break recursion, then falls through to acceptable/exit/move/enter;
and `observationAudienceActors` (`:9149`) — the priority ladder deciding who
sees each event. The notes (`2026-06-11-state-epoch-legibility-plan.md:71`,
E4) already name `world.ts` as *where every fix collides* and call for
decomposition along real seams. **This is a top-tier direction.**

---

## 2. The superstructure — catalogs (woocode)

18 bundled catalogs under `catalogs/`, each `manifest.json` + `DESIGN.md` +
`README.md`. Roles (spec §CT15): foundational utilities (**help, chat, note,
prog, perm, core, block**), demo class libraries (**tasks, pinboard, outliner,
dubspace, weather, horoscope, dispenser**), and the demo seed sink
(**demoworld**, ~55 seed_hooks, sinks the dependency graph — nothing may depend
on it, enforced by `guard-catalog-layering.mjs`).

- **Manifest shape**: `{classes, features, schemas, seed_hooks, ui, depends}`.
  Classes/features carry `properties[]` and `verbs[]`; **each verb's DSL is an
  inline escaped-string `source` field** — there is *no separate `.woo` file*.
  `schemas` declare observation shapes (`{on,type,shape,live?}`); `seed_hooks`
  have a small deterministic vocabulary (create_instance / change_parent /
  set_property / attach_feature).
- **Install engine** (`src/core/catalog-installer.ts`, 2023 lines) is genuinely
  catalog-agnostic and is the model citizen of the layering discipline. Sequence
  (`installCatalogManifest:515`): resolve provenance → assert deps → create
  classes+compile verbs → define schemas → run seed_hooks → **static call-graph
  validation** (every `this:x()` must resolve) → record install.
- **Third-party path** taps a GitHub repo (`catalog-taps.ts`), dispatches a
  *sequenced* `$catalog_registry:install` (a native builtin seeded at
  `bootstrap.ts:1235`, handler `world.ts:10270`).

### 2.1 Extensibility — real but with a painful seam

Bundled and third-party installs share the same core function
(`installCatalogManifest`), so parity is *structural*. But it is **not
identical** — four bundled-only privileges: (1) bundled installs skip the
sequenced `$catalog_registry:call`; (2) `allowImplementationHints` defaults on
for `@local` (`catalog-installer.ts:519`), letting bundled catalogs use native
implementation hints a public tap cannot; (3) `adoptExisting` lets a bundled
install adopt colliding objects instead of failing `E_NAME_COLLISION`
(`local-catalogs.ts:318`); (4) bundled catalogs get a boot-migration repair lane
(§6.2) third parties don't.

**The authoring wart:** verb source is a single-line escaped JSON string inside
`manifest.json`. Editing `catalogs/prog/` or `catalogs/core/` means hand-editing
400+ char escaped strings; there is no `.woo` file, no formatter, and (spec
§CT10) **no export/publish tooling** — the "author your world into a manifest"
loop is deferred. Also deferred/incomplete: `uninstall` (returns
`E_NOT_IMPLEMENTED`), transitive dependency solving, install caching, migration
`transform` beyond a single `join` op, alias-scoped class allocation (§CT8),
private repos / signature verification. For a system whose thesis is
*programmable-at-runtime*, the authoring on-ramp is the weakest external-facing
surface.

---

## 3. Deployment models, transports, persistence

### 3.1 Three runtime modes + the host contract

Storage contract in `src/core/repository.ts`: `WorldRepository` (whole-world
`load/save`) and the intended per-object `ObjectRepository` (`:164`), which is
**synchronous by design** (SQLite primitives are sync; cross-host awaits happen
*above* the interface). Back ends: in-memory (`WooWorld` holds all state; tests
+ conformance), local SQLite (`LocalSQLiteRepository`, dev server), Cloudflare
(`CFObjectRepository` over DO SQLite).

**Where the contract leaks (important):** the perf-critical **v2 turn path does
not go through `ObjectRepository` at all**. `CommitScopeDO` owns its own
`v2_commit_scope_*` tables and commit machinery — a *parallel storage world*.
The `ObjectRepository` interface describes v1 per-object persistence; the live
hot path is a second, unreconciled storage model. Backends also still implement
*both* interfaces, so the "decompose the world into per-object rows" goal is
unfinished — whole-world `load/save` survives alongside per-object ops.

### 3.2 Cloudflare DO topology (`wrangler.toml`)

Three DO classes (all `new_sqlite_classes`) + KV + Analytics Engine:

| Binding | Class | Role |
|---|---|---|
| `WOO` | `PersistentObjectDO` (9183 lines) | gateway shard **and** per-host object home: MCP dispatch, REST turns, projection cache, fanout outbox |
| `DIRECTORY` | `DirectoryDO` (955) | routing/name service: `object_route`, `session_route`, tombstones; ~2.3 lookups/turn |
| `COMMIT_SCOPE` | `CommitScopeDO` (2836) | durable home of a v2 commit scope: validate/commit `/v2/envelope`, head, tail, checkpoints, reply idempotency |
| `HOST_SEED_KV` | KV | edge-cached cold-start seed / authority checkpoints |
| `METRICS` | Analytics Engine | deploy-only telemetry |

**Turn/commit path:** client → `/mcp` | `/api/objects/.../calls` | `/v2/turn-network/ws`
→ worker routes to gateway shard via `idFromName(host)` → `McpGateway.submitTurnIntent`
(`gateway.ts:999`) plans against a **sparse** gateway relay → `submitEnvelope`
(`gateway.ts:1170`) issues cross-scope RPC `/v2/envelope` into `CommitScopeDO`
→ scope validates, commits durably, replies → fanout decoupled onto durable
`v2_fanout_pending` outbox drained *after* reply (crash-safe via
drain-on-reactivation).

**A field of feature flags is band-aiding one seam:**
`WOO_V2_SLIM_WARM_ENVELOPE` (warm turns skip the ~3 MB authority slice; cold
replies `E_SNAPSHOT_REQUIRED` → gateway reseeds + retries full body),
`WOO_V2_READ_CLOSURE_ENVELOPE` (<256 KB planned-transcript envelopes),
`WOO_V2_KV_SEED_AUTHORITY` (cold-owner authority from KV ~10-50 ms vs ~5 s live
RPC), `WOO_V2_CHECKPOINT_BOUNDED`. All flag-gated for instant rollback — a
signal the design is still provisional (see §5).

### 3.3 Transport triplication (confirmed)

All three transports fulfill the same `RestProtocolHost.executeTurn` shape but
wire the `submitTurnIntent → submitEnvelope` sequence up independently at three
near-identical sites that drift:
1. Worker: `restV2Turn` (`persistent-object-do.ts:1703`, + `restV2TurnInProcess:6250`).
2. Dev REST: `devRestV2Turn` (`dev-server.ts:176`, + `devRestV2LiveTurn:691`).
3. Dev WS: `handleV2ShadowFrame` → `submitTurnIntent` (`dev-v2-helpers.ts:311`),
   which explicitly re-implements the worker's `/v2/envelope` sequence
   in-process (`dev-v2-helpers.ts:268`).
The codebase itself flags this for consolidation. Divergence here has bitten
before (dev-path-only regressions).

### 3.4 Smoke ladder (three lanes, increasing fidelity, one shared scenario)

- **cf-local** (`smoke:cf-local`, `tests/worker/fake-do.ts`): real DO classes,
  but `FakeDurableObjectNamespace.get()` collapses **every** DO into one
  in-process object graph — no isolation, no network boundary, different
  microtask ordering. Fast; run by `npm test`.
- **cf-dev** (`smoke:cf-dev`, `wrangler.smoke.toml`): real workerd, real per-DO
  storage + cross-DO RPC + host-seed merge. Catches storage/RPC/merge
  regressions the fake cannot. **Cannot** reproduce cross-colo latency/timeout.
- **deployed walkthrough** (`smoke:walkthrough`): the only lane with true
  cross-colo RPC + AE telemetry. Most expensive; the authority-timeout class is
  **deploy-only** until fault injection lands.

---

## 4. What actually works vs what doesn't (historical — see addendum above)

- **Local / in-memory / SQLite: functionally green.** `npm test` 592 tests,
  `test:worker` 300, workerd smoke 13/13
  (`notes/2026-06-29-functional-baseline-candidate.md`).
- **Deployed CF: functional-but-slow and intermittently non-convergent.**
  Post-cross-scope-plan, happy-path dropped 17-35 s → 2-8 s and the repair
  cascade became a bounded error, but deploy #5 (`2026-06-14`) still shows 7/10
  with three standing cross-scope failures: `E_NOSESSION` (destination-scope
  session presence), `E_OBJNF` (cross-room class/instance lineage absent from
  gateway shard), `E_REPAIR_BUDGET` (repair loop exhausts because the missing
  state can't be reconciled from the shard). These are not regressions — the
  capsule-head fix *unmasked* pre-existing cross-scope state gaps.

---

## 5. The central architectural tension — divergence among unmanaged state copies

The most important synthesis in the current notes
(`2026-06-11-state-epoch-legibility-plan.md`): the same logical world exists in
**~seven materializations** — world-host world, per-scope CommitScopeDO worlds
(snapshot + tail), gateway sparse worlds, gateway SQL projection cache, relay
caches, KV host seeds, browser relay/IDB — **and nothing states which copies
exist, what updates each, or what bounds their divergence.** Every production
failure of the recent cycles failed the same way: a change updated one copy and
production diverged in a copy outside the model. Two structural reasons cross-
scope stays broken:

1. **Cross-scope commits still ship full authority.** The slim/read-closure
   envelope flags only help *warm same-scope* turns; the cold/retry cross-scope
   commit still builds and ships the ~3 MB authority slice
   (`src/core/authority-slice.ts`), so movement turns pay the 3.8-7.2 s envelope
   RPC (submit ≈ 66% of turn wall).
2. **Derived-scope fanout installs rows without lineage closure.** The moved
   object's class chain never reaches the destination shard → `dangling_parent_ref`,
   `E_VERBNF`/`E_OBJNF` on anything cross-room.

The proposed remedy already sketched (do not re-derive it — evaluate it):
**epoch discipline** (every durable artifact stamps the catalog/input epoch that
produced it; every consumer checks; mismatch is a named self-healing reseed, not
silent divergence — E1), a **named divergence taxonomy** (E2), an **aged-world
test lane** (build a world *through history* in workerd, upgrade, run the
scenario — E3; this would have caught every deploy-only failure), **megafile
decomposition** (E4), and **one write path per fact** (relations derived off one
authoritative event stream — E5).

---

## 6. Variance ledger — implementation vs stated goals

The project's goals are explicit (AGENTS.md + SPEC.md). Here is where the code
diverges, most architecturally weighty first.

### 6.1 Layering discipline is enforced by guard — but the guard exempts the biggest offender
AGENTS.md: core "must not branch on bootstrap object identities or class names,"
nor know command words or in-world objects. Reality:
- `guard-layering.mjs:14` keeps a **blanket `legacyDebtFiles` allow-list** that
  exempts `world.ts`, `bootstrap.ts`, `tiny-vm.ts`, the catalog installers,
  `dsl-compiler.ts`, `local-catalogs.ts`, etc. Because `world.ts` (where every
  violation lives) is exempt, the guard catches **none** of the real violations —
  it only stops *new files* from adding object knowledge. No ratchet forces the
  exemption to shrink.
- Concrete violations in `world.ts`: `obviousCommandVerbs()` (`:10929`) branches
  on `$room`/`$prog`/`$builder` class names; fallback-space search (`:4432`)
  walks the chain hunting for `$room`; match enrichment (`:11561`) special-cases
  `$note` text. The transport-coupling half of the guard (`:34`) is a hardcoded
  5-string match in `mcp/gateway.ts` — brittle, silently bypassed by any rename.
- **The concentrated layering violation is `src/core/local-catalogs.ts`**: ~25
  boot-migration functions hardcode demo-catalog names and in-world object
  identities (`runPinboardV02RepairMigration:678` inspects verb source text for
  `create($pin`; `runWizProgrammerParentMigration:759`; cockatoo-specific
  migrations `:31`). The migration index (`:196`) dispatches keyed on catalog
  name — exactly the pattern §CT5.4 calls a bug. `guard-catalog-layering.mjs`
  does *not* guard object-name leakage into `src/core`, so this is unguarded.

**Recommendation:** convert `legacyDebtFiles` from a blanket exemption into a
per-file baseline count (like the vocabulary-baseline guard) so existing debt is
frozen and new references fail; then retire the `$room`/`$prog`/`$builder`
branches into catalog-driven verb/property metadata.

### 6.2 Spec drift — load-bearing specs still marked `draft`
"Spec is the source of truth; keep spec aligned with code." Yet:
- `spec/semantics/moveto.md:3` is `status: draft` while `movetoChecked` is a
  documented hot path and AGENTS.md cites M1-M10 as normative.
- `spec/semantics/distribution.md:3` is `draft` while `guard-vocabulary.mjs`
  *enforces* its §DT5 vocabulary against the whole codebase — a draft spec used
  as a normative CI gate.
- Production behavior is being built directly against **draft** protocol specs
  (`cell-authority.md`, `v2-turn-network.md`, `projection-cache.md`,
  `host-seeds.md`, `ui-component-model.md`). Acknowledged, but the "if spec says
  implemented it's the reference" contract is inverted here: code leads, spec
  lags. Recommend promoting moveto/distribution out of draft (or splitting the
  implemented core from the still-draft tail).

### 6.3 Big-World discipline — global enumeration is the *default* lookup
"Global enumeration must be avoided." Reality: full local-table scans filtered
by class are the default — `findPlayerByName` (`world.ts:10915`), `scope==="all"`
(`:5694`), `findAnchoredDescendants`, plus ~14 `for (const id of world.objects.keys())`
scans in `local-catalogs.ts`. These are bounded to the per-DO host image (not
literally cross-host), but they encode an enumerate-everything assumption that
does not survive one-host-doesn't-hold-all-players. LATER.md names the fix (an
edge/reverse-index table) but it is unbuilt. **Good news:** the memory-flagged
`/sessions-for-scopes` roster inflation is now *mitigated* — `directory-do.ts:655`
adds a presence-lease filter + scope cap (128) + pagination, so the Directory
singleton is bounded/leased (consistent with "singletons OK if scaling is
considered"). Update the stale memory note.

### 6.4 `native()` debt — one named user-facing verb still native
42 native verbs; most are legitimate substrate (credential/identity/catalog
machinery the DSL can't express). The clear woocode-ward debt: **`$player:join_player`**
(`bootstrap.ts:1147`) — `join` is explicitly in AGENTS.md's list of
catalog/superstructure verbs, and all its named peers (`look`, `who`, `say`,
`take`, `drop`, `examine`, `help`) have already migrated. It is the lone
straggler and an actionable next migration. `$player:moveto`/`$thing:moveto`
one-liners and the feature verbs (`add_feature`/`remove_feature`/`has_feature`)
are the next tier.

### 6.5 Test / doc-accuracy gaps
- `npm test` runs **44 of ~195** test files (documented curated gate). ~151
  files run only under `test:full`, and there's no mechanism promoting new files
  into the curated list — coverage can silently drift out of the default gate.
  This has bitten twice (dev-v2-commit staleness, shadow-browser-node changes).
- Conformance corpus is thin (~22 cases) and partly deferred; the "independent
  implementations testable against the spec" goal is aspirational.
- Two of five migration kinds (worktree schema/data "partial"; spec-version
  "deferred") are not yet fully testable despite the "idempotent + covered
  before landing" rule.

### 6.6 Client-side dual-maintenance hazard (documented, unguarded)
`src/client/main.ts` `isChatObservation` (~2989) and `chatSystemText` (~3367)
are hand-maintained parallel allow-lists — a new chat observation type must be
added to *both* or it silently lands in the wrong panel. AGENTS.md documents it;
nothing guards it.

---

## 7. Proposed priority ordering (input, not decision)

**Tier 1 — unblock deployed convergence (the thing that makes it usable):**
1. **Epoch discipline + named divergence taxonomy** (notes E1/E2). Directly
   targets the "seven unmanaged copies" root; the reseed machinery already
   exists.
2. **Bounded cross-scope commit** — read-closure envelopes for planned
   transcripts + lineage-closed fanout so cross-room turns stop shipping full
   authority and stop dangling parents. This is the ~66%-of-wall fix.
3. **Aged-world test lane** (E3) — the gate that would have caught every
   deploy-only failure. Without it, Tier-1 fixes remain unprovable pre-deploy.

**Tier 2 — structural debt that makes every fix collide:**
4. **Decompose `world.ts` and `persistent-object-do.ts`** along the named seams
   (scope-state store, turn pipeline, projection/relation pipeline, session
   lifecycle, fanout). Each module states its invariants in its header.
5. **Converge the three transport turn call sites** into one primitive
   (§3.3) — kills a recurring class of dev-only drift.
6. **Reconcile the dual storage worlds** — either route the v2 commit path
   through `ObjectRepository` or formally split and document the two.

**Tier 3 — discipline ratchets & external surface:**
7. **Ratchet the layering guard** onto `world.ts`/`local-catalogs.ts` (baseline
   counts, not blanket exemption); retire the class-name branches.
8. **Reconcile draft-vs-implemented spec status** (moveto, distribution).
9. **Catalog authoring on-ramp** — `.woo` source files + export/publish tooling;
   this is the weakest external-facing surface and gates real third-party use.
10. Migrate `$player:join_player` to woocode; guard the client observation
    dual-lists; promote new test files into the curated gate.

**One meta-observation for the reviewer:** the inline-TODO count across the
entire hot codebase is **near zero** (one `TODO` in `world.ts`, zero in
`src/worker`/`src/mcp`). Debt is *not* marked in code — it lives in `wrangler.toml`
flag comments, dense prose comments, and `notes/`. So a naïve "grep for TODO"
audit will conclude the codebase is clean; the real debt is structural and
documented narratively. Weight the notes accordingly.
