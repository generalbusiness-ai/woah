# Extensibility, export, and the repositioning of taps

Origin: the 2026-07-19 review of porting GitHub taps to the Net runtime,
followed by a functional redesign discussion. This note is the work plan;
the normative drafts are [spec/discovery/export.md](../spec/discovery/export.md)
and [spec/catalogs/library.md](../spec/catalogs/library.md).

## Decision summary

The tap port review found that a live `/net-api/tap/install` needs a certified
catalog-epoch transition with lazy scope adoption — the hardest distributed
work on the table — because Net definitions are epoch-immutable (CO15,
`src/net/scope.ts` submit step 5) and Net today supports only fresh seeding
plus operator same-epoch definition repair.

The functional re-examination changed the priority, not the findings:

- A tap is world-global by construction. On a shared world it is an operator
  act, not a user feature. Its legitimate user-facing form is for **private
  worlds**, which do not exist yet.
- In-world extensibility (the `prog` catalog: `$builder` / `$programmer`)
  already exists, and on Net **user-owned classes and verbs are ordinary
  object state** committed through normal scopes — CO15 guards
  *catalog-scope-owned definitions*, and catalog placement is
  anchor/ownership-derived (`src/net/topology.ts`), not a `$`-name test.
  The epoch problem is a cost of *global catalog publication*, not of
  extensibility.
- The missing piece of the creative loop is **export**: there is no
  world-to-manifest path anywhere (`world.exportObjects` is an internal
  authority-transfer snapshot; backups §B2 is a state archive, not a
  source-shaped artifact). Catalogs.md §CT10 already names this gap
  ("Authoring → publish loop") as deferred.

So the order is: **(1) harden in-world extensibility over Net, (2) build
export, (3) in-world sharing/discoverability** — then taps return later as
*seed-time bundle composition* for private worlds, and live epoch transition
is built when the operator need arrives (first meaningful bundled-catalog
upgrade on a world we cannot re-seed).

**Private-world shape is deliberately unbound.** It might be a new DO
namespace per world, a scaled-up single server, or something else. Nothing
in workstreams 1–3 may assume a shape; the export artifact is the
shape-neutral seam (any future world form consumes the same manifest).

## Workstream 1 — in-world extensibility, proven over Net

The `prog` surface predates the net cutover. The claim "user verb/class
authoring commits through ordinary scopes" is architecturally true and
empirically unproven. Tasks:

1. **Net authoring conformance test** (workerd lane, extend or sibling the
   smoke scenario): a programmer actor over Net
   - `create`s a fertile class, `install_verb`s a verb on it,
   - a *second* actor subclasses it, creates an instance, invokes the verb,
   - `edit_verb` round-trips source, `expected_version` conflict path fires,
   - and the catalog-mutation boundary is asserted **both ways**: a
     non-wizard programmer's write to a catalog class refuses `E_PERM`
     (ownership fires before CO15), and an *otherwise-authorized* wizard
     ordinary write refuses `E_CATALOG_MUTATION` (extending the existing
     coverage at `tests/worker/net-topology-turn.test.ts:414`).
   Any friction found here is a bug to root-cause, not a scope cut.
2. **Storage quota**: implement the **rewritten**
   [spec/reference/quotas.md §R5](../spec/reference/quotas.md) (revised
   2026-07-19 — the prior singleton that walked every owner was a Big-World
   violation and is superseded). Charging is generic over committed positive
   storage deltas measured from the effect transcript — so every growth
   path (create, `SET_PROP`, verb installs, property definitions, notes) is
   charged by construction, not via surface-specific checks — delivered to
   per-owner accounting rows (sharded by owner, no enumeration), admitted
   against a cached standing with `E_QUOTA`, reconciled one owner at a time.
   It becomes load-bearing the moment non-wizards build freely. (Agent and
   programmer-grant quotas already exist and are enforced; this is the
   storage leg.)
3. **Progbit policy**: confirm the provisioning path for granting
   `programmer` to ordinary accounts (per-account `programmer_grant_quota`
   exists) and document the operator stance for the shared world.

Exit criterion: a non-wizard programmer can build and share a working class
on the deployed Net stack, within quota, and the conformance test guards it.

## Workstream 2 — export (subtree → catalog artifact)

Normative draft: [spec/discovery/export.md](../spec/discovery/export.md)
(EX1–EX10). Essence:

- The artifact is a **bundle**, not a bare manifest: `manifest.json` +
  `README.md` (frontmatter name/version/spec_version/license, matching the
  manifest — the install path validates this) + `provenance.json` sidecar.
  Identity metadata (name, version, license, description) is
  caller-supplied, never inferred. Source, not bytecode, so the
  recompile-in-importing-world discipline (CT13) holds.
- The export set is an **explicit complete object list**, validated for
  ownership, parent closure, and per-verb source-read permission. No
  automatic descendant discovery in v1: Net has no authoritative
  reverse-lineage index (`children` is recomputed from sparse planning-image
  lineage cells, `src/net/bridge.ts`); a bounded owner/reverse-lineage
  relation is the deferred enabler.
- One recursive **reference-classification pass** over every exported
  position — including raw `#objref`/`$coreref` tokens in verb source
  (token/AST-aware), property defaults, schemas, seed-hook values:
  in-set → `local_name`; universal → preserve; portable installed
  dependency → qualify + `depends`; bundled `@local` dependency → caller
  mapping or refuse; anything else → `E_EXPORT_DANGLING`.
- Verb **source retention** required; sourceless (`native`) verbs refuse.
- Redaction states only what the implementation provides: structural
  exclusion of owners/locations/live state, the mandatory
  `sensitive-serialization` classifier over all value positions
  (refuse-not-placeholder), and explicit per-property allowlisting for
  instance hooks. A durable per-property sensitive flag does not exist yet
  and is named as the upgrade path, not assumed.
- Deterministic byte-identical bundles + sha-256 provenance sidecar; export
  does not launder trust — importing anywhere runs under the installer's
  authority exactly as CT13 specifies for GitHub-sourced catalogs.

Implementation seam: a bounded computation over committed reads of the named
set — no global enumeration, no epoch involvement. Surface is
`POST /net-api/catalogs/export` (the legacy `/api/*` tree is retired with
410 on the Net router) plus a size-bounded in-world `$programmer` surface;
minting the bundle as an in-world `$note` is a separate, ordinary
quota-charged mutation, not part of export.

## Workstream 3 — in-world sharing and discoverability

Normative draft: [spec/catalogs/library.md](../spec/catalogs/library.md)
(LB1–LB8). A `library` catalog — pure woocode, zero core changes — where
builders register their fertile classes and features for others to find,
browse, and subclass. This is the LambdaMOO sharing model: within one world,
sharing needs no artifacts at all, only fertility + discoverability.

Scale and trust are designed in from the start: one library-owned
`$library_entry` object per registration (no monolithic registry cell), an
ordered membership relation with cursor-paginated `catalog()`, browse
rendered from registration-time snapshots (live cross-scope introspection
only in `examine(one_entry)`), feature shareability as a *declared* datum
with `:can_be_attached_by(actor)` evaluated at examine/attach time (never
statically inferred), and explicit surfacing that entries are **live
mutable code** — per-verb owners, source hashes diffed against the
registration snapshot, and the fork/export path for consumers who want a
pinned artifact. Library entries are also the natural roots for export.

## Later — repositioned taps and live publication

Not in workstreams 1–3; recorded so the review's findings stay actionable.

- **Seed-time taps for private worlds**: when a private-world shape is
  chosen, "install a tap" becomes *bundle composition at world creation* —
  assemble bundled catalogs plus external SHA-pinned artifacts (the review's
  `CatalogSource` layer: explicit ref, hash-checked, behavior-only) and feed
  the fresh-install path (`src/net/install.ts`) that already works. No live
  epoch transition needed.
- **Live catalog publication** (the full review architecture —
  `CatalogSource` / `CatalogPlanner` / `CatalogPublisher`, content-derived
  epoch hash chain, durable idempotent catalog-scope coordinator, lazy scope
  adoption, catalog-generation invalidation signal): build when a live world
  accumulates state we cannot re-seed and the bundle must change. The
  2026-07-19 review is the design record; its test list (idempotent retries,
  concurrent shard installs, no partial visibility, cold-gateway adoption,
  coalesced `tools/list_changed`, unsupported-feature rejection, injected
  GitHub fixture) transfers intact.
- **Remote catalog UI** stays out until pinned artifact delivery with
  client-side SHA-256 verification exists (`framework.ts` currently
  dynamic-imports without checking the declared digest).

## Non-goals for this phase

- No `/net-api/tap/*` endpoints.
- No epoch-transition machinery.
- No binding of the private-world shape.
- No remote-UI loading changes.
