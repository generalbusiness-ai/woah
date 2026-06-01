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
import type { AuthorityPageProvenance, ShadowStatePage } from "./shadow-state-pages";

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
const TRACKED_PAGES: ReadonlySet<ShadowStatePage["page"]> = new Set(["object_lineage", "object_live"]);

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
};

// Is this object's lineage a presentation stub — `name === id` — rather than a
// real identity? Bootstrap/support objects legitimately have `name === id`
// (e.g. "$player"), so this predicate is only a *signal*; the gate treats it as a
// violation solely when the cell's provenance is not authoritative.
function isStubLineage(obj: SerializedObject): boolean {
  return obj.name === obj.id;
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
  const violations: PlanningAdmissibilityViolation[] = [];
  for (const obj of serialized.objects) {
    const lineageKey = planningCellKey(obj.id, "object_lineage");
    if (allow.has(lineageKey)) continue;
    const lineageProv = provenance.get(lineageKey);
    if (!lineageProv) {
      violations.push({
        kind: "missing_provenance",
        object: obj.id,
        page: "object_lineage",
        detail: `object_lineage for ${obj.id} reached the planning world without provenance`
      });
      continue;
    }
    if (isStubLineage(obj) && lineageProv.source !== "authoritative") {
      violations.push({
        kind: "presentation_stub_lineage",
        object: obj.id,
        page: "object_lineage",
        detail: `name===id stub for ${obj.id} admitted as planning lineage with source=${lineageProv.source} (not authoritative)`
      });
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

// Brand a vetted SerializedWorld as a PlanningWorld. ONLY the admission gate calls
// this; everything else receives the branded type and cannot reconstruct it. The
// cast is the single sanctioned widening — it is the type-system seam where
// "admissible" is asserted.
export function markPlanningWorld(serialized: SerializedWorld): PlanningWorld {
  return serialized as PlanningWorld;
}
