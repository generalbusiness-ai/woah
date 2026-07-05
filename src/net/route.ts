/**
 * Commit-scope selection by write set — coherence.md CO2.3 (CA3
 * ride-along; B6 write-set rule; E_SCOPE_SPLIT).
 *
 * The commit scope is the smallest ordering authority that makes the
 * turn's writes atomic:
 *
 * - no authority writes            → the planning scope (read-only turn);
 * - all writes in one scope        → that scope (includes CA3 pure
 *                                     movement at the moved object's home,
 *                                     off the room sequencer);
 * - one shared scope + rider
 *   (anchor-cluster) scopes        → the shared scope serializes; the
 *                                     rider writes ride along atomically
 *                                     (CA3);
 * - riders only, several clusters  → the planning scope serializes the
 *                                     ride-along (B6's landed rule);
 * - two distinct shared scopes     → E_SCOPE_SPLIT, terminal (CO2.3) —
 *                                     the honest tightening of v2's
 *                                     metric-only commit_scope_multi;
 *                                     lifted by CA10 route migration.
 *
 * Scope selection is a pure function of the transcript's write set plus a
 * classifier; `route.ts` isolates it so CA10 migration slots in without
 * touching the pipeline (plan risk R5).
 */
import { netError } from "./errors";
import { netCellKeyFor, type EffectTranscript } from "./transcript";

export type ScopeClassifier = {
  /** The scope that owns an object's authority cells (its anchor/home). */
  scopeOf(object: string): string;
  /** Shared sequencer scopes ($space-like: rooms, boards) vs private
   * anchor clusters (an actor and what it carries). */
  isShared(scope: string): boolean;
};

export type ScopeSelection = {
  scope: string;
  /** Non-selected scopes whose writes ride along atomically (CA3). */
  riders: string[];
};

export function selectCommitScope(
  transcript: EffectTranscript,
  planningScope: string,
  classifier: ScopeClassifier
): ScopeSelection {
  const written = new Set<string>();
  for (const write of transcript.writes) {
    if (netCellKeyFor(write.cell) === null) continue; // contents → projection, not authority (CA4)
    written.add(classifier.scopeOf(write.cell.object));
  }
  for (const create of transcript.creates ?? []) {
    // A create's cells land at its anchor if declared, else with the turn.
    written.add(create.anchor ? classifier.scopeOf(create.anchor) : planningScope);
  }
  for (const move of transcript.moves ?? []) {
    // CA3: the single authoritative movement write is the moved object's
    // own live cell, at that object's home.
    written.add(classifier.scopeOf(move.object));
  }

  if (written.size === 0) return { scope: planningScope, riders: [] };
  if (written.size === 1) {
    const only = [...written][0];
    return { scope: only, riders: [] };
  }

  const shared = [...written].filter((scope) => classifier.isShared(scope)).sort();
  if (shared.length > 1) {
    throw netError("E_SCOPE_SPLIT", "write set spans two distinct shared scopes", {
      shared,
      written: [...written].sort(),
      planning: planningScope
    });
  }
  const anchor = shared.length === 1 ? shared[0] : planningScope;
  const riders = [...written].filter((scope) => scope !== anchor).sort();
  return { scope: anchor, riders };
}
