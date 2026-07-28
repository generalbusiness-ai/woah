---
date: 2026-07-19
status: draft
---

# Catalog export

> Part of the [woo specification](../../SPEC.md). Layer: **discovery**.

How in-world content becomes a portable catalog artifact. This is the
authoring→publish loop that [catalogs.md §CT10](catalogs.md#ct10-whats-deferred)
deferred: a builder makes classes and verbs *inside* a world (the `prog`
surface), then exports them as a catalog bundle that any world can install
through the ordinary catalog path.

Export is the dual of install. Everything a catalog means on the way *in*
([catalogs.md §CT5](catalogs.md#ct5-install), §CT13) constrains what export
may produce on the way *out* — including the parts of the bundle that are
not the manifest.

**Not backups.** A world export ([backups.md §B2](../operations/backups.md#b2-world-export-format))
is a *state* snapshot — every object, full property values, space logs,
bytecode — for restoring the same world. A catalog export is a
*source-shaped* artifact: definitions and verb source, no live state, meant
to be recompiled into a different world under a different installer's
authority. The two share nothing but the word "export."

---

## EX1. Purpose and scope

Export serves three consumers with one artifact:

1. **Publication** — a builder shares what they made: commit the bundle to a
   GitHub repo and it is installable as a catalog by any world (§CT4/§CT5).
2. **World seeding** — the bundle joins a seed bundle when a new world
   (including a future private world, whatever shape that takes) is created.
   Export is deliberately neutral to the private-world shape decision.
3. **Portability/backup of authored code** — a builder keeps their own work
   independent of any one deployment's lifetime.

v1 exports **classes and feature objects with their verbs, property
definitions, and schemas**, from an explicitly named object list (§EX3).
Instance export is explicit opt-in via generated seed hooks (§EX7). Remote
UI modules, migrations, and `agent_manifest.json` generation are deferred
(§EX10).

## EX2. The artifact is a bundle

A catalog is not a bare manifest. The install path
(`src/core/catalog-taps.ts`) fetches and validates a *directory*: a
`manifest.json` **and** a `README.md` whose YAML frontmatter must carry
`name`, `version`, `spec_version`, and `license`, each matching the
manifest, or the install refuses `E_CATALOG`. Export therefore produces a
deterministic file bundle:

```
<name>/
├── manifest.json      — exactly the §CT5.5 shape
├── README.md          — frontmatter (name, version, spec_version, license)
│                        matching the manifest, plus body text
└── provenance.json    — attribution sidecar (§EX8), not read by install
```

**Identity metadata is caller-supplied, never inferred.** The export request
must include `name`, `version` (semantic), `license`, and `description`;
`spec_version` is stamped from the exporting world. README body text is
caller-supplied, with a generated stub (class list + blurbs) as the default.
An export request missing identity fields refuses `E_INVARG` naming them.

Consequences:

- **Source, not bytecode.** Every exported verb ships DSL source; the
  importing world recompiles (§CT5.5's recompile discipline). Bytecode never
  crosses worlds through this path.
- The bundle round-trips: installing an exported bundle and re-exporting the
  same definitions is well-defined, and the export of an installed catalog's
  classes plus local overrides is itself a valid fork (§CT10 forking
  conventions apply).
- `implementation` hints (`native` / `fixture`) are **never** emitted; they
  are trusted-local only (§CT5.5).

## EX3. Export set: explicit, validated, permission-checked

The export request names the **complete list** of objects to export (class
and feature objects). The exporter does not discover members.

> *Why explicit:* automatic owned-descendant closure needs an authoritative
> reverse-lineage index. Net has none — `children` is a projection
> recomputed from whichever lineage cells are present in a planning image
> (`src/net/bridge.ts`), which proves membership, never completeness. A
> bounded, paginated owner/reverse-lineage relation maintained on
> create/reparent/recycle would enable discovery later (§EX10); until it
> exists, claiming closure from a sparse view would silently drop classes.

Validation of the named set:

1. **Ownership** — the requester owns every named object, or is a wizard
   (`E_PERM` naming the offender).
2. **Parent closure** — every named object's parent is itself named, a
   resolvable dependency, or a universal/bootstrap class (§EX4). Anything
   else refuses `E_EXPORT_DANGLING` naming the object, so the requester
   extends the list or reparents.
3. **Per-verb source read permission** — ownership of the containing object
   is not the source-read contract. Each verb's source must be readable by
   the requester under the verb's own perms; a named object carrying a verb
   the requester cannot read refuses `E_PERM` naming the verb.

Each named object exports its **definitions**: property *definitions* (name,
default, perms, declared metadata) and verbs (source, normalized perms,
`direct_callable`, metadata). Per-instance property values appear only via
§EX7.

## EX4. Reference classification

Portable output requires classifying **every reference in every exported
position** — not just `parent` links. References occur in: raw `#objref` and
`$coreref` tokens embedded in verb source (the DSL parses object literals;
`src/core/dsl-compiler.ts` `ref()`), property-definition defaults, schema
shapes and metadata, and seed-hook values, anchors, and consumers (§EX7).
The exporter runs one recursive classification pass over all of them —
token/AST-aware for verb source, structural for values. Outcomes:

| Reference | Result |
|---|---|
| Object in the export set | rewrite to its `local_name` |
| Universal/bootstrap corename (`$thing`, `$space`, …) | preserve; no `depends` entry |
| Object provenanced to an installed *portable* catalog | qualify as `<tap>:<catalog>:$name` (§CT3.1 reversed) + add `depends` |
| Object provenanced to a bundled `@local` catalog | no portable identity exists: require a caller-supplied mapping to a portable identity, else refuse `E_EXPORT_UNPORTABLE_DEP` |
| Any other world-local object | refuse `E_EXPORT_DANGLING`, naming the reference and where it occurs |

`local_name`s come from corenames where present, else a sanitized `.name`;
collisions refuse `E_INVARG` (the requester renames and retries). Export
never emits a raw source-world id: a bundle that passes classification
contains no `#objref` tokens and no unresolvable corenames, and this is a
verifiable property of the output (§EX8's determinism makes it testable).

## EX5. Source retention

A verb is exportable iff its stored definition includes DSL source. This
holds for catalog-installed verbs and for verbs authored through
`install_verb` / the editors (source is the canonical stored form; the
source header carries perms). Verbs without source — `native()` seed verbs,
fixture experiments — refuse export with `E_EXPORT_NO_SOURCE` listing the
offending verbs. There is no bytecode-decompilation fallback.

Normative consequence for the substrate: **verb source is retained state**,
not a compile-time transient. Any authoring path that stored bytecode
without source would silently break export and is non-conforming.

## EX6. Redaction and portability

The bundle must be installable into a world that shares nothing with the
source world except the spec. Structural exclusions (these are shape rules,
not value filters): no `owner`, `location`, anchoring, session or connection
state; no live or derived state (space logs, projection rows, caches);
property *defaults* come from definitions — an instance value never becomes
a class default.

For the values that *can* flow (defaults, and §EX7 instance hooks), the v1
sensitive-data policy is stated exactly as strong as the implementation can
make it:

- The mandatory classifier of `src/core/sensitive-serialization.ts` (the
  `$system` property set plus credential field names such as
  `password_hash`, `oauth_identities`) applies to every exported value
  position; a match refuses the export naming the position — refusal, never
  a placeholder that could mask the omission.
- Instance property values export **only** via the explicit per-property
  allowlist in the request (§EX7). Nothing is swept in.

There is no per-property "sensitive" definition flag today — `PropertyDef`
carries none — so this spec does not pretend flag-based redaction exists.
Durable sensitive-property metadata (declared in catalogs, honored by
export, backups, and the audit trail alike) is the upgrade path (§EX10);
when it lands, it tightens this section rather than changing its shape.

## EX7. Instances as seed hooks (opt-in)

The requester may name specific owned instances to carry as `seed_hooks`:
each becomes `create_instance` (class must be in the export set) plus
`set_property` hooks for **explicitly listed** plain-value properties, and
`attach_feature` for attachments among exported objects. Hook values pass
the same §EX4 classification and §EX6 policy as everything else; values
referencing objects outside the export set refuse `E_EXPORT_DANGLING`.
Whole-cluster instance graphs, `change_parent` emission, and registry
(`append_unique`) hooks are deferred — hand-author those in the repo after
export, as catalog authors do today.

## EX8. Determinism, provenance, integrity

Two exports of the same definitions with the same request metadata produce
byte-identical bundles: entries sorted by `local_name`, properties by name,
V2-canonical value encoding, no timestamps in `manifest.json` or `README.md`.

**Verbs are ordered by SLOT, not by name.** A definer's slot order is the
dispatcher's tie-breaker between two verbs whose alias patterns overlap
([../semantics/objects.md §9.1](../semantics/objects.md#91-lookup)), and install
assigns slots from manifest order — so name-sorting a class's verbs on export
would silently change which verb an alias reaches in every world that installs
the bundle. Slot order is total and deterministic, so it satisfies the
byte-identical requirement on its own. Provenance is a detached sidecar — attribution travels with the
bundle but is not part of the installable identity and is ignored by the
install path:

```jsonc
{
  "exported_from": "<deployment id>",
  "exported_by": "<actor ref>",       // requester; NOT a principal downstream
  "exported_at": "2026-07-19T00:00:00Z",
  "export_set": ["$my_class", ...],
  "manifest_sha256": "...",
  "readme_sha256": "..."
}
```

**Export does not launder trust.** The importing world treats the bundle
exactly as a GitHub-sourced catalog: inspected before install, recompiled
from source, running with the *installer's* authority (§CT13.2). The
provenance block is attribution, not authorization.

## EX9. Authority, surfaces, and cost

Export itself **commits nothing**: it is a bounded computation over
committed reads of the explicitly named set — no global enumeration, no
epoch machinery, no catalog-scope coordination. Output size is bounded;
oversized export sets refuse with the bound in the error.

Surfaces:

- **`POST /net-api/catalogs/export`** — JSON request (export set, identity
  metadata, instance/property allowlists), bounded bundle response. POST is
  deliberate for a large computed read; there is no mutation. The legacy
  `/api/*` tree is retired with 410 on the Net router
  (`src/worker/net-only-index.ts`) and gains nothing new. Wizard-or-owner
  authenticated session, checked before any work.
- **In-world**: a bounded `$programmer` surface for small sets (returning
  the manifest as a value is subject to ordinary VM result/size budgets and
  refuses beyond them, pointing at the REST surface).
- **Minting an in-world artifact** (e.g. the bundle as a `$note` document)
  is a *separate, ordinary mutating operation* — committed, quota-charged
  ([quotas.md §R5](../reference/quotas.md)) — layered on top of export, not
  part of its contract.

## EX10. Deferred

- **Automatic owned-descendant discovery** — pending a bounded, paginated
  owner/reverse-lineage relation maintained on create, reparent, and
  recycle (see §EX3). The generic projection/relation pipeline is the
  intended substrate for it.
- **Durable sensitive-property definition metadata** (see §EX6).
- Publish-to-GitHub automation (commit/PR from the world).
- Remote UI module export and integrity-pinned delivery.
- Migration-manifest generation for re-export of a changed catalog
  (version-bump diffing against a prior bundle).
- `agent_manifest.json` generation from verb signatures.
- Whole-cluster instance-graph export (see §EX7).
- Import of exported bundles by any path other than the existing catalog
  install surfaces.
