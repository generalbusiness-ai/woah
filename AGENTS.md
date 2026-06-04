# Agent Instructions

Design documents (including historical drafts) are in `notes/` and `spec/`.  User documents are in `docs/`.

## Quality

- Be observant.  Check everything that you see in prompts and context.  Unexpected or unexplained behavior might be a bug.  Bugs must be investigated.  Investigations must identify the actual cause.
- Investigate thoroughly until the actual behavior is confirmed.  We have instrumentation and debug logging.  If those are not sufficient for debugging, then they must be improved.  Don't write new code until you have exhaused all other options.  When replacing old code, clean up thoroughly.
- Take ownership now.  When there is a problem, it must be skillfully resolved.  There are no "pre-existing issues".  The cavalry will not arrive.  Track and fix problems when they are observed.  "Bigger changes" must never be deferred.  Do hard things carefully.
- Take care now.  Code is not ready until it has been reviewed for security, performance, consistency and correctness.  Code is not ready until it has been thoroughly tested.  Features require tests that exercise the feature in full, and that will fail if the user-visible behavior breaks.  Code is not ready until the user docs are accurate.
- Comments are required.  Explain to the next reader, to make their work easier.

## Spec is the source of truth

The normative spec lives under `spec/`, indexed by [`SPEC.md`](SPEC.md).

Parts of the spec are draft, or partially implemented.  If the spec says
"implemented", it becomes the reference for behavior.  When developing,
keep the spec aligned with the actual implementation.

Implementation work begins only after the relevant section is explicit
enough to constrain what is being built.

## Substrate vs superstructure

The **substrate** is TypeScript under `src/`: an object model with single
inheritance, properties, and verbs; a Tiny VM that runs verb bytecode;
hosts that own objects and persist state, with three runtime modes:
in-memory (development/testing), local SQLite (small self-contained deployments),
and Cloudflare DOs (production profile with distributed hosts and full identity).
transports (MCP, WS, REST) that carry calls in and observations out;
a builtin set — *functions, not verbs* — that woocode invokes for operations
the DSL cannot or should not express. It runs for an empty world or for one
with arbitrary catalogs installed.

Spec: `spec/semantics/core.md`

The **superstructure** is woocode: classes, verbs, properties, schemas, and
seed_hooks, written in the Woo DSL.  This is deployed from local catalogs
under `catalogs/`, installed through the same path that any third-party
catalog uses. All user-visible behavior lives here.

Spec:  `spec/discovery/catalogs.md`

## Big-World discipline

This is a distributed system.  There will be millions of nodes, and any one
cannot be expected to have knowledge of all the others.  Global enumeration
must be avoided.  Synchronous dependencies must be avoided.  Singletons with
special roles are OK as long as scaling and performance are considered.

## Layering discipline

Core must stay catalog-agnostic and client-agnostic. TypeScript under `src/core`
may implement the object substrate, VM execution, persistence, transport-neutral
call mechanics, host routing, generic builtins, and catalog installation
machinery. It must not accumulate knowledge of bundled catalogs, client UI
shapes, command words, LambdaCore conveniences, or specific in-world objects
such as particular rooms, players, appliances, notes, boards, or editors.

User-visible behavior belongs in woocode catalogs. Verbs such as `look`,
`examine`, `who`, `join`, `help`, `say`, `take`, `drop`, and command parser
conventions are catalog/superstructure behavior, even when they currently need
a native helper because the DSL or VM cannot express part of the mechanism.
Native helpers should be generic primitives invoked by woocode, not hardcoded
implementations of particular user-facing verbs.

The VM and runtime core must not branch on bootstrap object identities or class
names to change behavior. If a behavior depends on an object's role, express
that role as catalog data, properties, verb metadata, or an explicit generic
builtin argument. Bootstrap objects may be seeded in `src/core/bootstrap.ts` to
make an empty world installable, but ordinary runtime semantics must not gain
special cases for those seed objects.

## The seed graph

Some seed objects in woocode are delivered by `src/core/bootstrap.ts`.
These sit in the substrate for three reasons: catalogs need
ancestors before they can install, the engine itself relies on these
contracts, and several universal verbs are still `native()` because the
DSL or VM cannot yet express them efficiently. Each `native()` call
carries a doc-string of the equivalent Woo verb signature; the direction
of travel is woocode-ward, not native-ward.

## Orientation: where things live

A pragmatic map for navigating the codebase quickly. Spec is still the
source of truth — this just points at the implementation.

**Catalogs (`catalogs/<name>/manifest.json`)** are the woocode. Each class
entry has inline DSL `source` strings for verbs. To change a verb's
behavior, edit the `source` literal — there is no separate `.woo` file.
`DESIGN.md` next to the manifest carries the rationale; `migration-v*.json`
ships with major-version bumps. The `manifest.json` `schemas` block declares
observation shapes the catalog emits.

**Substrate runtime (`src/core/`):**
- `world.ts` — the world object. Hot paths to know:
  - `movetoChecked` (~3894): receiver-driven move chain — dispatches
    `obj:moveto(target)` if defined, then `target:acceptable`, then
    `oldLocation:exitfunc`, physical move, `target:enterfunc`. Recursive
    `moveto(this, target)` from inside `:moveto` falls through via a
    per-call marker set, so a verb can decorate the move and still let
    the default chain finish it.
  - `observationAudienceActors` (~5821): who receives an `observe()`.
    Order: `_audience_override` → typed routing for `looked`/`who`
    (`to`-only) → directed recipients (`to`/`from`) → `observation.source`
    if it's a $space → fallback to the call's audience. `entered`/`left`/
    `taken`/`dropped` exclude the actor from the room broadcast (the
    actor's own `tell(...)` line covers their view).
- `tiny-vm.ts` — verb bytecode interpreter. `OBSERVE`/`EMIT` ops invoke
  `ctx.observe(...)`; `recycle`/`moveto`/`create`/`isa` etc. are builtins
  in the big switch around line 1000.
- `dsl-compiler.ts` — DSL → bytecode. `observe(...)` and `emit(...)`
  are special-cased to OBSERVE/EMIT ops.
- `bootstrap.ts` — seed graph delivered before any catalog installs.

**Client (`src/client/`):**
- `main.ts` `isChatObservation` (~2989) is the *allow-list* of observation
  types that route to the chat panel; `chatSystemText` (~3367) supplies
  the rendered line when the observation lacks a `text:` field, or wraps
  the raw `text:` field for known types. **A new observation type that
  should appear in chat must be added to BOTH lists.** Otherwise it lands
  in the generic observations panel and the user sees "the observation
  shows up but not in chat."
- `framework.ts` `registerCoreObservationHandlers` reduces structured
  observations into client state (e.g. `taken`/`dropped` patches an
  object's `location`).

**Common patterns:**
- `observe(event)` — catalog code emits to whoever the audience model
  selects (usually the calling space).
- `observe_to_space(space, event)` — explicit space-targeted broadcast,
  sequenced when reached via `$space:call`.
- `tell(actor, text)` — direct line to one actor (live, not durable).
- `$note` three-slot rule: `.name` is the listing label, `.description`
  is the cosmetic look-at flavour, `.text` is the markdown payload.
  Inventory uses name; `look` uses description; `read` uses text. Never
  mix them.
- Dispenser pattern: `:order` enqueues, an external plug drains the queue
  and calls `:deliver(order_id, name, text, description)` to mint a
  `$dispensed_note` into the requester's inventory. See
  `catalogs/dispenser/DESIGN.md`.

## Development Process

Implementation notes are not formal specs or commitments, and do not
reflect the current status; they are just descriptions of work while
it is being done, and other reference material.

Work descriptions in `notes/` must be named by their origin date,
e.g. "2026-05-03-perf-hotspots.md".  Reference material in `notes/`
has undated filenames.

Use Git worktrees for isolation.  Every subagent must work in .claude/worktrees/<task>/

**DO NOT commit to main, or deploy** without explicit instruction.

**Before a commit or merge to main:**
- Ensure that the specs and other documentation are aligned with the code.
  Update the specs where necessary.  Double-check that all affected specs
  are consistent.
- Ensure that tests cover the functionality.  Update where there are gaps.
- Ensure that dead code and obsolete descriptions are removed.
- Are migrations needed?  Use the decision table below.
- If migrations are used, they must be test-run on a local Sqlite woo.

Commit to *worktree* after every major task, inlcuding a description
of the change and its effects on the system.

Commit messages must include a title that summarizes the change,
and a body that describes the motivation and any key implementaion details.

**Smoke-test discipline**

Cloudflare full smoke-test is *the most expensive* validation step.
Maintain local dirty-state regression tests and run `npm run smoke:cf-local`
before CF.  If a smoke-test fails: stop, inspect tail/metrics, and only
re-run when strong new signals will be available.

**Test selection discipline**

Use targeted Vitest files for the code just changed (`npm run test:files --
tests/path.test.ts`), then run `npm test` as the fast guarded local gate. `npm
test` is intentionally not the entire Vitest corpus; it keeps the default
validation loop bounded. Run `npm run test:worker` for Worker/Cloudflare-shape
changes, and reserve `npm run test:full` for an explicit slow all-files sweep
before broad merges or when a targeted signal is not enough.

## Migrations

woo has several distinct migration kinds. Pick by the *kind of state* the
change rewrites; "behavior change" alone is not the question.

| Kind | When you need one | Authoring doc | Tested by |
|---|---|---|---|
| **Worktree schema / data** | Changing a live class's property shape, type, or value convention in an already-installed world (rename, retype, restructure) | [spec/operations/migrations.md §M3–M5](spec/operations/migrations.md#m3-schema-changes) | partial — runtime support landing; sandbox-driven |
| **Catalog version migration** | Publishing a major-version bump of a catalog (`vN.x.x` → `v(N+1).0.0`) | [spec/discovery/catalogs.md §CT14](spec/discovery/catalogs.md#ct14-migrations); ship `catalogs/<name>/migration-vN-to-v(N+1).json` next to `manifest.json` | `tests/catalogs.test.ts` |
| **Spec-version (`$system.spec_version`)** | Runtime change that requires walking older deployed worlds forward | [spec/operations/migrations.md §M6](spec/operations/migrations.md#m6-world-level-spec-versioning) | deferred — `from → to` catalog not yet wired |
| **Cloudflare DO class** | Adding, renaming, or removing a Durable Object class binding in `wrangler.toml` | [spec/reference/cloudflare.md §R14.6](spec/reference/cloudflare.md#r146-first-deploy-and-upgrade-discipline); run `npm run cf:migrations` to append a `cf-do-NNNN` tag | `tests/cf-do-migrations.test.ts`; build gate `npm run cf:migrations:check` (run by `npm test` and `npm run deploy`) |
| **Bootstrap local-boot** | Cold-init repair of seed or bundled-catalog state recorded in `$system.applied_migrations` | [spec/discovery/catalogs.md §CT5.4.1](spec/discovery/catalogs.md#ct541-local-boot-migrations); ledger documented in [bootstrap.md](spec/semantics/bootstrap.md) | `tests/catalogs.test.ts` |

Same rule for all kinds: **migrations must be idempotent** so reruns and
partial-failure recovery are safe. Migration code without automated coverage
must include a vitest case before it lands.

## Commands

- `npm run guard:object-names` enforces a subset of the naming rule.
- `npm run guard:catalog-migrations` requires a `migration-v(N-1)-to-vN.json` for every bundled catalog at major version N.
- `npm test` — fast guarded Vitest gate (runs `catalog:index` and all guards first).
- `npm run test:guards` — catalog index/check plus all local guard scripts.
- `npm run test:files -- tests/name.test.ts` — targeted Vitest files for the code just changed.
- `npm run test:worker` — slow Worker/Cloudflare-shape and MCP smoke Vitest lane.
- `npm run test:full` — slow all-files Vitest sweep; run deliberately, not as the default inner loop.
- `npm run typecheck` — both tsconfigs.
- `npm run dev` — local dev server at `http://localhost:5173`.
- `npm run cf:migrations:check` — wrangler DO migrations in sync.
