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

## Commands

- `npm run guard:object-names` enforces a subset of the naming rule.
- `npm test` — vitest (runs `catalog:index` + `guard:object-names` first).
- `npm run typecheck` — both tsconfigs.
- `npm run dev` — local dev server at `http://localhost:5173`.
- `npm run cf:migrations:check` — wrangler DO migrations in sync.
