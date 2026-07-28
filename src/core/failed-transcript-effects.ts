import { isSequencedAllocationCell, type EffectTranscript } from "./effect-transcript";
import { stableShadowJson } from "./shadow-cell-version";
import type { ErrorValue, Observation, WooValue } from "./types";

/**
 * Capability generation for a producer that guarantees failed turns contain
 * no behavior effects.  Absence is the rolling-upgrade/legacy shape and is
 * deliberately observe-only: authorities must not turn today's ordinary
 * failed transcript into an availability incident before every producer has
 * the matching recorder rollback.
 */
export const FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION = 1 as const;
export type FailedTranscriptEffectsGeneration = typeof FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION;

export type FailedTranscriptEffectCategory =
  | "allocation_writes"
  | "behavior_writes"
  | "creates"
  | "moves"
  | "recycles"
  | "session_scope_transitions"
  | "projection_writes"
  | "schedules"
  | "cancellations"
  | "domain_observations"
  | "canonical_error_observations"
  | "untracked_effects"
  | "results";

export type FailedTranscriptEffectReason =
  | "behavior_writes"
  | "creates"
  | "moves"
  | "recycles"
  | "session_scope_transition"
  | "projection_writes"
  | "schedules"
  | "cancellations"
  | "domain_observations"
  | "untracked_effects"
  | "result_present"
  | "allocation_at_non_owner"
  | "allocation_count"
  | "allocation_shape"
  | "allocation_read"
  | "error_observation_count"
  | "error_observation_shape";

export type FailedTranscriptEffectsPolicy = "not_failed" | "observe" | "enforce";

/**
 * A fixed-vocabulary, payload-free report.  It is safe to put in structured
 * logs: counts reveal only effect kinds and `reasons` is bounded by the closed
 * reason union, never by attacker-controlled object ids, property names,
 * values, observations, or error strings.
 */
export type FailedTranscriptEffectsReport = {
  route: EffectTranscript["route"];
  policy: FailedTranscriptEffectsPolicy;
  generation: number | null;
  valid: boolean;
  counts: Record<FailedTranscriptEffectCategory, number>;
  reasons: FailedTranscriptEffectReason[];
};

export type FailedTranscriptEffectsOptions = {
  /** Whether this authority owns the semantic sequencing space. */
  ownsSequencingSpace: boolean;
};

/**
 * Exhaustive semantic ownership for every core transcript field. Adding a
 * field to EffectTranscript is therefore a compile error here until its
 * failed-turn semantics are chosen explicitly. This closes the otherwise easy
 * gap where a new effect array could silently bypass admission because the
 * classifier never mentioned it.
 */
export type FailedTranscriptFieldClass =
  | "envelope"
  | "proof"
  | "effect"
  | "outcome"
  | "integrity";

export const FAILED_TRANSCRIPT_FIELD_CLASSIFICATION = {
  kind: "envelope",
  failureEffectsGeneration: "integrity",
  id: "envelope",
  route: "envelope",
  scope: "envelope",
  space: "envelope",
  seq: "envelope",
  session: "envelope",
  call: "envelope",
  reads: "proof",
  stateProbes: "proof",
  writes: "effect",
  creates: "effect",
  moves: "effect",
  recycles: "effect",
  schedules: "effect",
  cancellations: "effect",
  sessionScopeTransition: "effect",
  projectionWrites: "effect",
  observations: "outcome",
  logicalInputs: "proof",
  untrackedEffects: "effect",
  result: "outcome",
  error: "outcome",
  complete: "integrity",
  incompleteReasons: "integrity",
  hash: "integrity"
} as const satisfies Record<keyof EffectTranscript, FailedTranscriptFieldClass>;

/**
 * Structural input shared by the core transcript and the net bridge's widened
 * session-cell vocabulary. Core must not import net merely to classify a
 * session write as a forbidden behavior effect.
 */
export type FailedTranscriptEffectsInput = Omit<
  EffectTranscript,
  "reads" | "writes" | "stateProbes"
> & {
  reads: Array<{
    cell: { kind: string; object: string; name?: string };
    version?: string;
    value: WooValue;
  }>;
  writes: Array<{
    cell: { kind: string; object: string; name?: string };
    value: WooValue;
    op: string;
  }>;
  stateProbes?: Array<{ kind: string; object: string; name?: string }>;
};

const CATEGORY_ORDER: readonly FailedTranscriptEffectCategory[] = [
  "allocation_writes",
  "behavior_writes",
  "creates",
  "moves",
  "recycles",
  "session_scope_transitions",
  "projection_writes",
  "schedules",
  "cancellations",
  "domain_observations",
  "canonical_error_observations",
  "untracked_effects",
  "results"
];

const REASON_ORDER: readonly FailedTranscriptEffectReason[] = [
  "behavior_writes",
  "creates",
  "moves",
  "recycles",
  "session_scope_transition",
  "projection_writes",
  "schedules",
  "cancellations",
  "domain_observations",
  "untracked_effects",
  "result_present",
  "allocation_at_non_owner",
  "allocation_count",
  "allocation_shape",
  "allocation_read",
  "error_observation_count",
  "error_observation_shape"
];

/**
 * Classify the authority-visible effects of a failed transcript.
 *
 * Reads, state probes, logical inputs, dispatch proofs (encoded as reads), and
 * audit/trace metadata are intentionally absent from this grammar: they prove
 * how the failed result was reached but do not mutate domain state.  Response
 * restore overlays (for example an MCP `meSnapshot`) are not transcript fields
 * and therefore also sit outside this admission rule.
 */
export function classifyFailedTranscriptEffects(
  transcript: FailedTranscriptEffectsInput,
  options: FailedTranscriptEffectsOptions
): FailedTranscriptEffectsReport {
  const generation = runtimeGeneration(transcript.failureEffectsGeneration);
  const policy: FailedTranscriptEffectsPolicy =
    transcript.error === undefined
      ? "not_failed"
      : generation === FAILED_TRANSCRIPT_EFFECTS_CLEAN_GENERATION
        ? "enforce"
        : "observe";
  const counts = emptyCounts();
  if (transcript.error === undefined) {
    return { route: transcript.route, policy, generation, valid: true, counts, reasons: [] };
  }

  const reasons = new Set<FailedTranscriptEffectReason>();
  const allocationWrites = transcript.writes.filter((write) =>
    isSequencedAllocationCell(transcript, write.cell)
  );
  const behaviorWrites = transcript.writes.length - allocationWrites.length;
  counts.allocation_writes = allocationWrites.length;
  counts.behavior_writes = behaviorWrites;
  counts.creates = transcript.creates.length;
  counts.moves = transcript.moves.length;
  counts.recycles = transcript.recycles?.length ?? 0;
  counts.session_scope_transitions = transcript.sessionScopeTransition === undefined ? 0 : 1;
  counts.projection_writes = transcript.projectionWrites?.length ?? 0;
  counts.schedules = transcript.schedules?.length ?? 0;
  counts.cancellations = transcript.cancellations?.length ?? 0;
  counts.untracked_effects = transcript.untrackedEffects.length;
  counts.results = transcript.result === undefined ? 0 : 1;

  if (behaviorWrites > 0) reasons.add("behavior_writes");
  if (counts.creates > 0) reasons.add("creates");
  if (counts.moves > 0) reasons.add("moves");
  if (counts.recycles > 0) reasons.add("recycles");
  if (counts.session_scope_transitions > 0) reasons.add("session_scope_transition");
  if (counts.projection_writes > 0) reasons.add("projection_writes");
  if (counts.schedules > 0) reasons.add("schedules");
  if (counts.cancellations > 0) reasons.add("cancellations");
  if (counts.untracked_effects > 0) reasons.add("untracked_effects");
  if (counts.results > 0) reasons.add("result_present");

  classifyAllocation(transcript, allocationWrites, options, reasons);
  classifyObservations(transcript.error, transcript.route, transcript.observations, counts, reasons);

  const orderedReasons = REASON_ORDER.filter((reason) => reasons.has(reason));
  return {
    route: transcript.route,
    policy,
    generation,
    valid: orderedReasons.length === 0,
    counts,
    reasons: orderedReasons
  };
}

function classifyAllocation(
  transcript: FailedTranscriptEffectsInput,
  allocationWrites: FailedTranscriptEffectsInput["writes"],
  options: FailedTranscriptEffectsOptions,
  reasons: Set<FailedTranscriptEffectReason>
): void {
  if (transcript.route !== "sequenced") return;
  if (!options.ownsSequencingSpace) {
    if (allocationWrites.length > 0) reasons.add("allocation_at_non_owner");
    return;
  }
  if (allocationWrites.length !== 1) {
    reasons.add("allocation_count");
    return;
  }
  const write = allocationWrites[0];
  if (
    !Number.isInteger(transcript.seq) ||
    transcript.seq < 1 ||
    write.op !== "set" ||
    write.value !== transcript.seq + 1
  ) {
    reasons.add("allocation_shape");
  }
  const matchingReads = transcript.reads.filter((read) =>
    isSequencedAllocationCell(transcript, read.cell) &&
    read.value === transcript.seq &&
    read.version !== undefined
  );
  if (matchingReads.length !== 1) reasons.add("allocation_read");
}

function classifyObservations(
  error: ErrorValue,
  route: FailedTranscriptEffectsInput["route"],
  observations: Observation[],
  counts: Record<FailedTranscriptEffectCategory, number>,
  reasons: Set<FailedTranscriptEffectReason>
): void {
  const canonical = observations.filter((observation) => isCanonicalErrorObservation(error, observation));
  counts.canonical_error_observations = canonical.length;
  counts.domain_observations = observations.length - canonical.length;
  if (counts.domain_observations > 0) reasons.add("domain_observations");

  // Only a sequenced turn has a durable error outcome in its applied log.
  // Direct failures return through their call envelope and carry no committed
  // observation effect.
  const expected = route === "sequenced" ? 1 : 0;
  if (observations.length !== expected) reasons.add("error_observation_count");
  if (route === "sequenced" && canonical.length !== 1) reasons.add("error_observation_shape");
}

function isCanonicalErrorObservation(error: ErrorValue, observation: Observation): boolean {
  const expected: Observation = {
    type: "$error",
    code: error.code,
    message: error.message ?? error.code,
    value: error.value ?? null,
    trace: error.trace ?? []
  };
  return stableShadowJson(observation as WooValue) === stableShadowJson(expected as WooValue);
}

function runtimeGeneration(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function emptyCounts(): Record<FailedTranscriptEffectCategory, number> {
  return Object.fromEntries(CATEGORY_ORDER.map((category) => [category, 0])) as Record<
    FailedTranscriptEffectCategory,
    number
  >;
}
