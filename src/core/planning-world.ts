// PlanningWorld admission gate.
//
// The Tiny VM plans and executes against a world. Historically that world was a
// bare `SerializedWorld` that any code path could push objects into — including
// presentation stubs (`name === id`) synthesized to satisfy a dangling reference,
// or stale cross-host `cache` rows. When such a stub wins admission, the VM reads
// it as truth (e.g. `room_roster` rendering an actor's id instead of its name).
// See notes/2026-06-01-planning-world-admission.md for the originating bug class.
//
// This module makes that state structurally inadmissible. A `PlanningWorld` is a
// branded `SerializedWorld` paired with per-cell provenance; only the admission
// gate (`buildPlanningWorld`, landing in a later phase) may brand one, and the VM
// boundary accepts only a `PlanningWorld`. `assertPlanningWorldAdmissible` is the
// invariant: every tracked cell must be admissible or the world is rejected before
// it can reach the VM.
//
// The vocabulary mirrors the authority-slice provenance model (CA2 / A3 / VTN0):
// `authoritative` is the owner's truth; every other source is a derivation that
// MAY fill a gap but is never a write-authority source — and a presentation stub
// is never an admissible planning cell at all.

import type { SerializedObject, SerializedWorld } from "./repository";
import type { AuthorityPageProvenance, AuthorityPageSource, ShadowStatePage } from "./shadow-state-pages";
import { shadowAtomHash } from "./turn-key";
import { wooError } from "./types";
import type { ErrorValue } from "./types";

// A nominal brand so a raw `SerializedWorld` cannot be passed where a vetted
// planning world is required. The brand is a phantom field — it never exists at
// runtime; only `markPlanningWorld` (called by the admission gate) produces the
// type. Keeping it a `unique symbol` means no structural value can forge it.
declare const planningWorldBrand: unique symbol;
export type PlanningWorld = SerializedWorld & { readonly [planningWorldBrand]: true };

// Per-cell provenance for a planning world, keyed by `planningCellKey`. The
// admission gate populates this from the authority slice the world was built from;
// the VM-boundary check reads it. Absent entries mean "provenance unknown", which
// is conservatively treated as protected (an unknown cell is not assumed
// authoritative for the purpose of *being replaced*, but it IS flagged by the gate
// for the tracked identity cells, because an unprovenanced lineage row is exactly
// the leak this gate closes).
export type PlanningWorldProvenance = Map<string, AuthorityPageProvenance>;

// The cells whose provenance is load-bearing for planning correctness (the immediate
// slice — identity and live cells, matching the merge-layer scope). Property and
// verb cells are admitted without provenance enforcement for now; widening the set
// is a later increment that must only ever ADD page kinds.
export const PLANNING_TRACKED_PAGES: ReadonlySet<ShadowStatePage["page"]> = new Set(["object_lineage", "object_live"]);
const TRACKED_PAGES = PLANNING_TRACKED_PAGES;

// Key a tracked cell for the provenance map. Identity/live cells have no name
// component; property/verb cells (not yet tracked) would carry their name. Kept
// byte-identical to authority-slice's `authorityPageRefKey` so a provenance map
// built there can be consumed here without translation.
export function planningCellKey(object: string, page: ShadowStatePage["page"], name?: string): string {
  return `${object}:${page}:${name ?? ""}`;
}

export type PlanningAdmissibilityViolationKind =
  // A lineage cell whose `name` equals its object id and whose provenance is not
  // the owner's — i.e. a presentation stub masquerading as identity. The defect
  // class this gate exists to reject.
  | "presentation_stub_lineage"
  // A tracked cell with no recorded provenance reached the planning world. Under
  // the target architecture every admitted cell is provenance-tagged; an untagged
  // tracked cell means it bypassed the admission gate.
  | "missing_provenance";

export type PlanningAdmissibilityViolation = {
  kind: PlanningAdmissibilityViolationKind;
  object: string;
  page: ShadowStatePage["page"];
  detail: string;
};

export type PlanningAdmissibilityOptions = {
  // Cell keys (planningCellKey) that are KNOWN debt, allow-listed during the
  // ratchet so the gate can run before the whole surface routes through
  // `buildPlanningWorld`. This set may only SHRINK; when it empties the gate is
  // unconditional. Mirrors the gate:authority KNOWN_CI_DEBT_CELLS ratchet.
  allow?: ReadonlySet<string>;
  // Source assumed for a tracked cell that carries NO recorded provenance. An
  // authoritative caller (owner full-state, bootstrap snapshot) passes
  // "authoritative" so its untagged cells are trusted — never flagged
  // missing_provenance, and a legitimate `name===id` is not a stub. Sparse/
  // projection callers omit it: an untagged tracked cell is missing_provenance.
  defaultProvenanceSource?: AuthorityPageSource;
};

// Is this object's lineage a presentation stub — `name === id` synthesized because
// the real display name was unknown — rather than a real identity? Substrate refs
// (the `$`-prefixed namespace: system singletons, catalog classes) are named by
// their ref *by convention*, so `name === id` there is legitimate, not a stub; the
// gate excludes that whole namespace rather than branch on any specific bootstrap
// object (which would violate core's catalog-agnostic layering). For ordinary
// objects (actors, instances) `name === id` means identity was never resolved.
// Even then this is only a *signal*: the gate treats it as a violation solely when
// the cell's provenance is not authoritative (an owner may legitimately set such a
// name; a derived copy may not).
function isStubLineage(obj: SerializedObject): boolean {
  return obj.name === obj.id && !obj.id.startsWith("$");
}

// Collect every admissibility violation in a world+provenance pair. Pure and
// side-effect free, so it can run in discovery mode (collect, log, allow-list) or
// behind `assertPlanningWorldAdmissible` (collect, then throw on the first
// non-allow-listed entry). Only the tracked identity/live cells are inspected.
export function collectPlanningWorldViolations(
  serialized: Pick<SerializedWorld, "objects">,
  provenance: PlanningWorldProvenance,
  options: PlanningAdmissibilityOptions = {}
): PlanningAdmissibilityViolation[] {
  const allow = options.allow ?? EMPTY_ALLOW;
  const fallbackProv: AuthorityPageProvenance | undefined = options.defaultProvenanceSource
    ? { source: options.defaultProvenanceSource }
    : undefined;
  const violations: PlanningAdmissibilityViolation[] = [];
  for (const obj of serialized.objects) {
    // Every tracked page is inspected for missing provenance — not lineage alone.
    // The presentation-stub classification is lineage-only (it is about identity),
    // but provenance coverage is required on each tracked cell (e.g. object_live's
    // location/contents) or the cell silently bypassed the admission gate.
    for (const page of TRACKED_PAGES) {
      const key = planningCellKey(obj.id, page);
      if (allow.has(key)) continue;
      const prov = provenance.get(key) ?? fallbackProv;
      // Stub-ness is classified INDEPENDENTLY of provenance, on the lineage cell
      // only: a `name===id` lineage (outside the `$`-namespace) is a presentation
      // stub unless it is the owner's authoritative row — whether its provenance is
      // recorded non-authoritative OR absent. An absent-provenance stub must still
      // enter repair (the id-as-name leak), so it is presentation_stub_lineage, NOT
      // demoted to non-fatal missing_provenance.
      if (page === "object_lineage" && isStubLineage(obj) && prov?.source !== "authoritative") {
        violations.push({
          kind: "presentation_stub_lineage",
          object: obj.id,
          page,
          detail: `name===id stub for ${obj.id} admitted as planning lineage with source=${prov?.source ?? "<absent>"} (not authoritative)`
        });
        continue;
      }
      // missing_provenance: a tracked cell with no recorded (or defaulted) provenance.
      if (!prov) {
        violations.push({
          kind: "missing_provenance",
          object: obj.id,
          page,
          detail: `${page} for ${obj.id} reached the planning world without provenance`
        });
      }
    }
  }
  return violations;
}

const EMPTY_ALLOW: ReadonlySet<string> = new Set<string>();

// The invariant. Throws if any tracked cell is inadmissible and not allow-listed.
// `where` names the call-site for diagnostics (e.g. "runShadowTurnCallTranscript").
export function assertPlanningWorldAdmissible(
  serialized: Pick<SerializedWorld, "objects">,
  provenance: PlanningWorldProvenance,
  where: string,
  options: PlanningAdmissibilityOptions = {}
): void {
  const violations = collectPlanningWorldViolations(serialized, provenance, options);
  if (violations.length === 0) return;
  const summary = violations
    .slice(0, 8)
    .map((v) => `${v.kind} ${v.object}:${v.page}`)
    .join(", ");
  throw new Error(
    `planning world inadmissible at ${where}: ${violations.length} violation(s) [${summary}${violations.length > 8 ? ", …" : ""}]`
  );
}

// Brand a vetted SerializedWorld as a PlanningWorld. INTERNAL — only the
// constructors below call it. The cast is the single sanctioned widening: the
// type-system seam where "admissible" is asserted. Callers cannot reconstruct the
// brand, so the only way to obtain a PlanningWorld is through a constructor that
// ran the gate.
function markPlanningWorld(serialized: SerializedWorld): PlanningWorld {
  return serialized as PlanningWorld;
}

// Build the repairable missing-state error for inadmissible cells. The repair loop
// (`submitTurnIntent`) extracts the named objects from the `cell:lifecycle:<id>`
// preimages, refreshes their authority, and re-plans against the named identity.
// A caller without a repair loop propagates this as a turn failure — the correct
// loud signal that an identity is genuinely unresolvable, never an id-as-name.
function planningInadmissibleNeedState(violations: readonly PlanningAdmissibilityViolation[]): ErrorValue {
  return wooError("E_NEED_STATE", "planning world admitted an inadmissible cell; repair identity", {
    missing_atoms: violations.map((v) => {
      const preimage = `read:cell:lifecycle:${v.object}`;
      return { hash: shadowAtomHash(preimage), preimage };
    })
  });
}

export type BuildPlanningWorldOptions = {
  allow?: ReadonlySet<string>;
  // Untagged tracked cells are treated as this source (see
  // PlanningAdmissibilityOptions.defaultProvenanceSource).
  defaultProvenanceSource?: AuthorityPageSource;
  // When true, an untagged tracked cell (missing_provenance) is fatal-by-repair too,
  // not only reported. Presentation stubs are always fatal-by-repair regardless.
  enforceMissingProvenance?: boolean;
  // Optional observability sink for every violation (fatal or not). Independent of
  // enforcement — enforcement depends on the violation kinds + flags above, never on
  // whether this is supplied.
  onViolation?: (violations: PlanningAdmissibilityViolation[]) => void;
};

// THE admission point. Every SerializedWorld that will reach the VM boundary
// (`runShadowTurnCallTranscript` / `runShadowTurnCall`) MUST pass through here (or
// `authoritativePlanningWorld`). It runs the gate, raises a repairable
// `E_NEED_STATE` for inadmissible cells, and returns the branded world. The brand
// makes "went through the gate" a type-level fact: the boundary cannot be called
// with a raw SerializedWorld.
export function buildPlanningWorld(
  serialized: SerializedWorld,
  provenance: PlanningWorldProvenance,
  options: BuildPlanningWorldOptions = {}
): PlanningWorld {
  const violations = collectPlanningWorldViolations(serialized, provenance, {
    ...(options.allow ? { allow: options.allow } : {}),
    ...(options.defaultProvenanceSource ? { defaultProvenanceSource: options.defaultProvenanceSource } : {})
  });
  if (violations.length > 0) {
    options.onViolation?.(violations);
    // Presentation stubs are ALWAYS fatal-by-repair (the bug class — enforced on
    // every gated path). missing_provenance is fatal-by-repair only when a caller
    // opts IN (enforceMissingProvenance: true) — the #11 flip, which is correct only
    // on a path whose per-cell provenance recording is universal. It stays OFF by
    // default because coverage is not yet universal (the browser holder relay
    // materializes from accepted frames without provenance, and not every gateway
    // planning world is fully tagged), so a blanket flip would reject valid untagged
    // cold-load cells. Authoritative paths never reach here with a missing cell
    // (defaultProvenanceSource tags them).
    const enforceMissing = options.enforceMissingProvenance === true;
    const fatal = violations.filter((v) =>
      v.kind === "presentation_stub_lineage" ||
      (enforceMissing && v.kind === "missing_provenance"));
    if (fatal.length > 0) throw planningInadmissibleNeedState(fatal);
  }
  return markPlanningWorld(serialized);
}

// Admission for an AUTHORITATIVE world: the owner's full state, a bootstrap
// snapshot, or any materialization that is authoritative by construction. Every
// untagged cell is trusted (`defaultProvenanceSource: "authoritative"`), so no
// cell is flagged missing_provenance and a legitimate `name===id` is not a stub.
// This is the type-safe way for an owner/authoritative path to reach the VM
// boundary without threading per-cell provenance it does not need.
export function authoritativePlanningWorld(serialized: SerializedWorld): PlanningWorld {
  return buildPlanningWorld(serialized, EMPTY_PROVENANCE, { defaultProvenanceSource: "authoritative" });
}

const EMPTY_PROVENANCE: PlanningWorldProvenance = new Map();
