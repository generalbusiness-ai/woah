# AGENTS.md

woo is an object database substrate plus application superstructure.

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

## The seed graph

Some seed objects in woocode are delivered by `src/core/bootstrap.ts`.
These sit in the substrate for three reasons: catalogs need
ancestors before they can install, the engine itself relies on these
contracts, and several universal verbs are still `native()` because the
DSL or VM cannot yet express them efficiently. Each `native()` call
carries a doc-string of the equivalent Woo verb signature; the direction
of travel is woocode-ward, not native-ward.

## Development Process

Implementation notes are not formal specs or commitments, and do not
reflect the current status; they are just descriptions of work while
it is being done, and other reference material.

Work descriptions in `notes/` must be named by their origin date,
e.g. "2026-05-03-perf-hotspots.md".  Reference material in `notes/`
has undated filenames.

Use Git worktrees for isolation.

**DO NOT commit or deploy** without explicit instruction.

**Before a commit or merge to main:**
- Ensure that the specs and other documentation are aligned with the code.
  Update the specs where necessary.  Double-check that all affected specs
  are consistent.
- Ensure that tests cover the functionality.  Update where there are gaps.
- Ensure that dead code and obsolete descriptions are removed.
- Are migrations needed?  Use the decision table below.
- If migrations are used, they must be test-run on a local Sqlite woo.

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
- `npm test` — vitest (runs `catalog:index` + `guard:object-names` + `guard:catalog-migrations` first).
- `npm run typecheck` — both tsconfigs.
- `npm run dev` — local dev server at `http://localhost:5173`.
- `npm run cf:migrations:check` — wrangler DO migrations in sync.
