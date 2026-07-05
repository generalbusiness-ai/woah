/**
 * TurnEffects — the seam between the world engine and the distribution
 * layer (Plan 002 Phase 1; spec/protocol/coherence.md).
 *
 * The world engine (WooWorld: object model, verb dispatch, sessions)
 * records, versions, and applies turn effects through this interface
 * instead of importing the distribution modules directly. That keeps the
 * engine distribution-agnostic: today's v2 layer supplies the
 * implementation via `createV2TurnEffects()`, and the replacement
 * coherence layer (`src/net/`, Plan 002 Phase 2+) can supply its own
 * without touching engine code. A guard (`npm run guard:turn-effects`)
 * enforces that `world.ts` has no direct import of the modules wrapped
 * here.
 *
 * Method signatures are `typeof` the v2 functions on purpose: the v2
 * implementation must stay byte-for-byte identical through this seam
 * (Phase 1 is re-routing, not behavior change), and any drift in the
 * underlying signatures surfaces here as a type error instead of a
 * silent fork.
 */
import { buildSerializedAuthorityCellSlice } from "./authority-slice";
import { shadowOwnerCellVersion, shadowStructuralCellVersion } from "./shadow-cell-version";
import { shadowAtomHash } from "./turn-key";
import { planningCellKey } from "./planning-world";
import { objectCreateEvent } from "./turn-recorder";
import { remoteBridgeUntrackedEffect } from "./remote-bridge-transcript-policy";
import { applyPresenceProjectionRowDelta, sessionScopePresenceDeltas } from "./effect-transcript";
import {
  applyTranscriptContentsWriteRefs,
  applyTranscriptPropWrite,
  finalWritesByCell,
  mergeTranscriptLogEntry,
  nextObjectCounterForCreates,
  serializedObjectForTranscriptCreate,
  transcriptLogEntry,
  transcriptSessionActiveScope
} from "./shadow-commit-scope";
import { projectionRowBytes } from "./projection-delta";

/**
 * The operations the world engine needs from a distribution layer,
 * grouped by concern:
 * - cell identity/versioning (planning keys, atom hashes, cell versions);
 * - turn recording inputs (create events, untracked remote-bridge effects);
 * - transcript application (the apply-committed-transcript helpers);
 * - projection sizing and authority-slice assembly.
 */
export interface TurnEffects {
  // Cell identity and versioning.
  planningCellKey: typeof planningCellKey;
  shadowAtomHash: typeof shadowAtomHash;
  shadowOwnerCellVersion: typeof shadowOwnerCellVersion;
  shadowStructuralCellVersion: typeof shadowStructuralCellVersion;

  // Turn-recording inputs.
  objectCreateEvent: typeof objectCreateEvent;
  remoteBridgeUntrackedEffect: typeof remoteBridgeUntrackedEffect;

  // Committed-transcript application.
  applyPresenceProjectionRowDelta: typeof applyPresenceProjectionRowDelta;
  sessionScopePresenceDeltas: typeof sessionScopePresenceDeltas;
  applyTranscriptContentsWriteRefs: typeof applyTranscriptContentsWriteRefs;
  applyTranscriptPropWrite: typeof applyTranscriptPropWrite;
  finalWritesByCell: typeof finalWritesByCell;
  mergeTranscriptLogEntry: typeof mergeTranscriptLogEntry;
  nextObjectCounterForCreates: typeof nextObjectCounterForCreates;
  serializedObjectForTranscriptCreate: typeof serializedObjectForTranscriptCreate;
  transcriptLogEntry: typeof transcriptLogEntry;
  transcriptSessionActiveScope: typeof transcriptSessionActiveScope;

  // Projection sizing and authority assembly.
  projectionRowBytes: typeof projectionRowBytes;
  buildSerializedAuthorityCellSlice: typeof buildSerializedAuthorityCellSlice;
}

/** Today's implementation: delegate to the v2 modules unchanged. */
export function createV2TurnEffects(): TurnEffects {
  return {
    planningCellKey,
    shadowAtomHash,
    shadowOwnerCellVersion,
    shadowStructuralCellVersion,
    objectCreateEvent,
    remoteBridgeUntrackedEffect,
    applyPresenceProjectionRowDelta,
    sessionScopePresenceDeltas,
    applyTranscriptContentsWriteRefs,
    applyTranscriptPropWrite,
    finalWritesByCell,
    mergeTranscriptLogEntry,
    nextObjectCounterForCreates,
    serializedObjectForTranscriptCreate,
    transcriptLogEntry,
    transcriptSessionActiveScope,
    projectionRowBytes,
    buildSerializedAuthorityCellSlice
  };
}

// Type re-exports so the engine can name recorder/transcript shapes without
// importing the distribution modules directly. These are erased at runtime;
// they exist so the guard can hold world.ts to zero direct imports.
export type { ShadowStructuralCellKind } from "./shadow-cell-version";
export type { PlanningWorldProvenance } from "./planning-world";
export type {
  ActiveTurnRecorder,
  RecordedCell,
  RecordedWriteAuthority,
  TurnRecorder,
  TurnRecorderEvent,
  TurnStart
} from "./turn-recorder";
export type { EffectTranscript, TranscriptWrite } from "./effect-transcript";
export type { TranscriptPropTarget } from "./shadow-commit-scope";
export type { ProjectionWrite } from "./projection-delta";
