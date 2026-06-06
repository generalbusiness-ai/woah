// Executor protocol — the home of the "Execute" role described in
// spec/semantics/distribution.md §DT1. Any node holding sufficient state to
// step a verb is an executor; this module defines what executors do and how
// they submit their results to a scope sequencer for ordering.
//
// The role has four operations:
//
//   currentHead() — the head the executor last played forward to.
//   playTo(head)  — apply accepted frames up through `head`.
//   execute(intent) — step the verb against current state; produce a
//                     transcript proposal annotated with the head it ran
//                     against.
//   signEnvelope(envelope) — produce an envelope signed by this executor's
//                            identity; the sequencer accepts proposals
//                            from any registered signer regardless of
//                            which executor produced them.
//
// `submitTurnIntent` below is the current submission glue that wraps
// `execute` + `signEnvelope` and posts to the scope sequencer. The three
// implementations (hosted DO, browser, MCP) reach `submitTurnIntent`
// through their own adapters — see `src/worker/persistent-object-do.ts`,
// `src/core/shadow-browser-node.ts`, and `src/mcp/gateway.ts`. They do
// not yet share a single `Executor` class; this module is the role's
// home and the place future symmetrization should live.

import type { SerializedAuthoritySlice, SerializedObject, SerializedSession, SerializedWorld } from "./repository";
import { mergeSerializedAuthoritySlice, type MergeSerializedAuthorityInput, type MergeSerializedAuthorityOptions } from "./authority-slice";
import {
  buildShadowTurnExecEnvelope,
  buildShadowTurnIntentEnvelope
} from "./shadow-browser-node";
import { decodeEnvelope, encodeEnvelope, type ShadowEnvelope } from "./shadow-envelope";
import { runShadowTurnCallTranscript, type ShadowTurnCall, type ShadowTurnCallTranscriptRun } from "./shadow-turn-call";
import { buildPlanningWorld, type PlanningAdmissibilityViolation, type PlanningWorldProvenance } from "./planning-world";
import type { ShadowMissingAtom, ShadowStateTransfer, ShadowTurnExecReply, ShadowTurnExecRequest } from "./shadow-turn-exec";
import {
  selectCommitScopeForTranscript,
  transcriptTouchedObjectIds,
  type ShadowScopeHead
} from "./shadow-commit-scope";
import { shadowTurnKeyFromTranscript } from "./turn-key";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, MetricEvent, ObjRef, WooValue } from "./types";
import type { WooWorld } from "./world";

export const V2_COMMIT_SCOPE_SNAPSHOT_REQUIRED = "E_SNAPSHOT_REQUIRED";

export type ExecutorAuthorityPayload = {
  sessions: SerializedSession[];
  /** Legacy fallback for pre-authority callers. Authority-bearing payloads MUST leave this empty. */
  session_objects: SerializedObject[];
  authority: SerializedAuthoritySlice;
  /** Internal planning metadata; executorEnvelopeBody deliberately does not serialize it. */
  staleFallbackCount?: number;
};

export type ExecutionCapsule = {
  kind: "woo.execution_capsule.v1";
  scope: ObjRef;
  head: ShadowScopeHead;
  actor: ObjRef;
  session: string;
  target: ObjRef;
  verb: string;
  expires_at_ms: number;
};
// NB: the capsule deliberately carries NO authority slice. The CommitScopeDO
// validates a capsule by head/scope/actor/session metadata only
// (validateExecutionCapsule) and never reads an embedded slice; a cold scope
// with a capsule throws E_SNAPSHOT_REQUIRED and is re-seeded from the request's
// top-level authority via the gateway retry. Carrying the ~3MB slice here only
// doubled the envelope on capsule turns (measured 6.1MB) for bytes nothing reads.

export type ExecutorCallInput = {
  id?: string;
  route: ShadowTurnCall["route"];
  scope: ObjRef;
  session: string;
  actor: ObjRef;
  target: ObjRef;
  verb: string;
  args: WooValue[];
  body?: Record<string, WooValue>;
  persistence: ShadowTurnExecRequest["persistence"];
  token: string;
};

export type ExecutorEnvelopeBody = {
  scope: ObjRef;
  node: string;
  token: string;
  session: string;
  actor: ObjRef;
  sessions: SerializedSession[];
  /** Legacy fallback for pre-authority callers. Authority-bearing payloads MUST leave this empty. */
  session_objects: SerializedObject[];
  authority: SerializedAuthoritySlice;
  envelope: string;
  execution_capsule?: ExecutionCapsule;
  planned_transcript_commit?: boolean;
};

export type ExecutorEnvelopeResult = {
  reply: string | null;
  head?: ShadowScopeHead;
};

export type SubmitTurnIntentResult<Client, Result extends ExecutorEnvelopeResult> =
  | {
      kind: "local_frame";
      frame: AppliedFrame | DirectResultFrame | ErrorFrame;
      call: ShadowTurnCall;
      planned: ShadowTurnCallTranscriptRun;
    }
  | {
      kind: "submitted";
      scope: ObjRef;
      commitScope: ObjRef;
      client: Client;
      result: Result;
      replyEnvelope: ShadowEnvelope<ShadowTurnExecReply> | null;
      reply: ShadowTurnExecReply | null;
      call: ShadowTurnCall;
      planned?: ShadowTurnCallTranscriptRun;
    };

export type SubmitTurnTimedPhase = "ensure_client" | "submit";

export type SubmitTurnPhaseTimer = {
  add(phase: SubmitTurnTimedPhase, label: string, ms: number): void;
  time<T>(phase: SubmitTurnTimedPhase, label: string, body: () => T | Promise<T>): Promise<T>;
};

export type SubmitTurnIntentOptions<Client, Result extends ExecutorEnvelopeResult> = {
  input: ExecutorCallInput;
  maxAttempts?: number;
  ensureClient(
    scope: ObjRef,
    attempt: number,
    context: {
      phase: "planning" | "commit";
      planningScope: ObjRef;
      plannedTranscriptCommit: boolean;
      timing: SubmitTurnPhaseTimer;
    }
  ): Promise<Client>;
  clientNode(client: Client): string;
  clientHead?(client: Client): ShadowScopeHead;
  clientSerialized?(client: Client): SerializedWorld;
  // PlanningWorld admission gate — the guarded-executor policy. The planning world
  // returned by `clientSerialized` is admitted through `buildPlanningWorld` before
  // it reaches the VM (see submitTurnIntent below). These options thread the per-cell
  // provenance the gate consumes:
  //   - `clientPlanningProvenance` supplies the planning client's per-cell provenance.
  //     A presentation stub (name===id lineage that is not authoritative) is ALWAYS
  //     fatal-by-repair: the gate raises a repairable `E_NEED_STATE`, caught and
  //     retried locally. When omitted, provenance defaults to empty (the gate still
  //     runs; the stub class is still enforced).
  //   - `onAdmissionViolation` is an observability sink for every violation, fatal or
  //     not. It never changes enforcement — it is logging only.
  clientPlanningProvenance?(client: Client): PlanningWorldProvenance;
  onAdmissionViolation?(violations: PlanningAdmissibilityViolation[]): void;
  // Opt IN to fatal missing_provenance enforcement. A caller sets this only on a
  // sparse-planning path whose planning worlds are universally per-cell
  // provenance-tagged (gateway/REST/browser, which record provenance on every
  // authority merge, seed, and accepted-frame application). Off by default so callers
  // planning against authoritative/untagged worlds are unaffected.
  enforceMissingProvenance?: boolean;
  // CA11.2: opt IN to the movement-destination owner-repair check. A caller sets
  // this only on a path that ALSO drives a force-owner repair refresh (the MCP
  // gateway's `missing_state_repair` authority pass). The browser holder / REST
  // relay leave it off: they attach provenance but plan optimistically against
  // derived rows, so a move into one must not become an unrepairable E_NEED_STATE.
  enforceMovementOwnerRepair?: boolean;
  // Opt IN to owner repair for resolution-critical contents reads. Sparse MCP
  // gateways enable this so object matching, `visible_contents`, and `contents()`
  // do not treat gateway projection cache membership as final execution truth.
  // The VM raises E_NEED_STATE for the container, and the same repair loop
  // refreshes its owner authority before retrying. Other holders leave it off
  // unless they can perform that repair.
  enforceResolutionOwnerRepair?: boolean;
  nextTurnId(client: Client, attempt: number): string;
  envelopeId?(turnId: string, attempt: number): string;
  authorityPayload(
    scope: ObjRef,
    extraObjectIds: ObjRef[],
    // `repair` is set on a pre-plan refresh driven by a repairable planning
    // failure (E_NEED_STATE / E_OBJNF from the VM or admission gate), as opposed
    // to the first speculative pre-plan refresh. The gateway uses it to request a
    // missing_state_repair authority refresh that force-fetches owner authority
    // for the named ids (CA11.2 occupancy transition), displacing any local
    // topology pre-seed. Absent / false on the first pre-plan and commit phases.
    context?: { phase: "intent" | "pre_plan" | "commit"; repair?: boolean }
  ): ExecutorAuthorityPayload | Promise<ExecutorAuthorityPayload>;
  // `planned-exec` normally plans from the caller's cached relay view, then
  // refreshes authority for commit. Sparse gateway shards need the reverse for
  // local planning: repair/merge the known authority first so catalog lineage
  // and transitive refs are present before the VM can fail locally.
  prePlanAuthority?: boolean;
  // B7 warm-cache-first callers do not pay the unconditional pre-plan refresh on
  // every turn. They still need the same local planning repair when the
  // admission gate or VM proves a missing object/cell (`E_NEED_STATE`/`E_OBJNF`)
  // or sparse class/verb lineage (`E_VERBNF`).
  // This keeps warm turns local while preserving bounded cold-miss repair.
  repairPlanningAuthority?: boolean;
  submitEnvelope(scope: ObjRef, body: ExecutorEnvelopeBody, context: { timing: SubmitTurnPhaseTimer }): Promise<Result>;
  applyAuthority?(client: Client, authority: SerializedAuthoritySlice): void;
  // Adopt the authority's reported current head after a stale-head/version
  // conflict, so the next attempt plans + submits against the right head instead
  // of re-submitting the same stale `expected`. Without this, a distributed
  // caller (gateway/REST) whose executor is a partial relay shard cannot use the
  // in-process convergence in executeShadowTurnNetwork (which bails for
  // non-authoritative executors) and grinds the full retry budget on every
  // contended/first-turn-on-scope commit. See the conflict's `commit.current`.
  applyHead?(client: Client, head: ShadowScopeHead): void;
  // Install a cell-page transfer carried on a read-version-mismatch conflict
  // reply into the caller's planning cache before the next repair attempt
  // (DESIGN A layer-2). The committing scope already validated against its
  // CURRENT cells and serves exactly the mismatched ones, stamped
  // authoritative; installing them lets the next attempt plan against fresh
  // versions and converge — instead of re-planning the same stale rows and
  // grinding the retry budget. Distributed callers (gateway/REST/dev) wire this
  // to their relay-cache install; a caller that omits it falls back to the
  // pre-fix authority-refetch path (slower, may still loop).
  applyStateTransfer?(client: Client, transfer: ShadowStateTransfer): void;
  authorityObjectIds?(input: ExecutorCallInput, commitScope: ObjRef): ObjRef[];
  planningScope?(input: ExecutorCallInput): ObjRef;
  shouldRetry?(reply: ShadowTurnExecReply): boolean;
  // Forwarder for engine metric events recorded during planning-phase
  // verb execution (the ephemeral world built from clientSerialized).
  // Lets host metric sinks see `direct_call`, `applied`,
  // `dispatch_resolved`, and `broadcast` events for v2 traffic; without
  // it those kinds never land in AE and footprint-by-verb is empty.
  onMetric?: (event: MetricEvent) => void;
};

export function executorAuthorityPayload(
  world: WooWorld,
  extraObjectIds: Iterable<ObjRef> = []
): ExecutorAuthorityPayload {
  // Gateways must refresh bearer/session authority without exporting a full
  // world. Keep the payload shape identical for REST, MCP, WS, and Worker DO
  // callers so later cell-slice shrinking has one contract to change.
  const sessions = world.exportSessions();
  const authority = world.exportAuthoritySlice(sessions, extraObjectIds);
  return {
    sessions: authority.sessions,
    session_objects: [],
    authority
  };
}

export function buildExecutionCapsule(input: {
  scope: ObjRef;
  head: ShadowScopeHead;
  actor: ObjRef;
  session: string;
  target: ObjRef;
  verb: string;
  now?: number;
  ttlMs?: number;
}): ExecutionCapsule {
  return {
    kind: "woo.execution_capsule.v1",
    scope: input.scope,
    head: structuredClone(input.head) as ShadowScopeHead,
    actor: input.actor,
    session: input.session,
    target: input.target,
    verb: input.verb,
    expires_at_ms: (input.now ?? Date.now()) + Math.max(1, input.ttlMs ?? 30_000)
  };
}

export function mergeExecutorAuthority(
  serialized: { sessions: SerializedSession[]; objects: SerializedObject[] },
  authority: MergeSerializedAuthorityInput,
  options: MergeSerializedAuthorityOptions = {}
): void {
  mergeSerializedAuthoritySlice(serialized, authority, options);
}

export function executorAuthorityObjectIds(
  input: { scope: ObjRef; target?: ObjRef | null; actor: ObjRef; args?: readonly WooValue[]; body?: Record<string, WooValue> },
  commitScope: ObjRef = input.scope
): ObjRef[] {
  const ids: ObjRef[] = [];
  const seen = new Set<ObjRef>();
  const push = (id: ObjRef | null | undefined): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  const pushValueRefs = (value: unknown): void => {
    if (typeof value === "string") {
      push(value as ObjRef);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) pushValueRefs(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) pushValueRefs(item);
    }
  };
  push(commitScope);
  push(input.scope);
  push(input.target);
  push(input.actor);
  pushValueRefs(input.args ?? []);
  pushValueRefs(input.body ?? {});
  return ids;
}

function executorTranscriptObjectIds(transcript: ShadowTurnCallTranscriptRun["transcript"]): ObjRef[] {
  return Array.from(transcriptTouchedObjectIds(transcript)).sort();
}

export function executorReplyNeedsRepair(reply: ShadowTurnExecReply): boolean {
  if (reply.ok === true) return false;
  if (reply.reason === "missing_state") return true;
  if (reply.reason !== "commit_rejected") return false;
  return reply.commit?.reason === "stale_head" ||
    reply.commit?.reason === "read_version_mismatch" ||
    reply.commit?.reason === "nondeterministic";
}

export function executorObjectIdsFromMissingState(reply: ShadowTurnExecReply): ObjRef[] {
  if (reply.ok || reply.reason !== "missing_state") return [];
  const ids: ObjRef[] = [];
  const seen = new Set<ObjRef>();
  const push = (id: ObjRef | null): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const atom of reply.missing_atoms ?? []) push(executorObjectIdFromMissingAtom(atom));
  return ids;
}

function executorObjectIdsFromNeedStateError(err: unknown): ObjRef[] {
  const error = err as { code?: string; value?: WooValue } | null;
  return error?.code === "E_NEED_STATE"
    ? executorObjectIdsFromNeedStateValue(error.value)
    : [];
}

function executorObjectIdsFromNeedStateFrame(frame: ErrorFrame): ObjRef[] {
  return frame.error.code === "E_NEED_STATE"
    ? executorObjectIdsFromNeedStateValue(frame.error.value)
    : [];
}

function executorObjectIdsFromObjectNotFoundError(err: unknown): ObjRef[] {
  const error = err as { code?: string; value?: WooValue } | null;
  return error?.code === "E_OBJNF" && typeof error.value === "string"
    ? [error.value]
    : [];
}

function executorObjectIdsFromObjectNotFoundFrame(frame: ErrorFrame): ObjRef[] {
  return frame.error.code === "E_OBJNF" && typeof frame.error.value === "string"
    ? [frame.error.value]
    : [];
}

function executorObjectIdsFromLocalPlanningError(err: unknown): ObjRef[] {
  return mergeExecutorObjectIds(
    executorObjectIdsFromNeedStateError(err),
    executorObjectIdsFromObjectNotFoundError(err)
  );
}

function executorObjectIdsFromLocalPlanningFrame(frame: ErrorFrame): ObjRef[] {
  return mergeExecutorObjectIds(
    executorObjectIdsFromNeedStateFrame(frame),
    executorObjectIdsFromObjectNotFoundFrame(frame)
  );
}

function isRepairableLocalPlanningLookupError(err: unknown): boolean {
  const coded = err as { code?: unknown; message?: unknown } | null;
  if (coded?.code === "E_VERBNF") return true;
  const message = err instanceof Error
    ? err.message
    : typeof coded?.message === "string"
    ? coded.message
    : "";
  return message.includes("E_VERBNF");
}

function isRepairableLocalPlanningLookupFrame(frame: ErrorFrame): boolean {
  return frame.error.code === "E_VERBNF" ||
    (frame.error.code === "E_INTERNAL" && (frame.error.message ?? "").includes("E_VERBNF"));
}

function executorObjectIdsFromNeedStateValue(raw: WooValue | undefined): ObjRef[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const missing = (raw as Record<string, WooValue>).missing_atoms;
  if (!Array.isArray(missing)) return [];
  const ids: ObjRef[] = [];
  const seen = new Set<ObjRef>();
  const push = (id: ObjRef | null): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const item of missing) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const map = item as Record<string, WooValue>;
    if (typeof map.hash !== "string") continue;
    push(executorObjectIdFromMissingAtom({
      hash: map.hash,
      ...(typeof map.preimage === "string" ? { preimage: map.preimage } : {})
    }));
  }
  return ids;
}

function executorObjectIdFromMissingAtom(atom: ShadowMissingAtom): ObjRef | null {
  const preimage = atom.preimage;
  if (typeof preimage !== "string" || preimage.length === 0) return null;
  if (preimage.startsWith("actor:")) return preimage.slice("actor:".length) as ObjRef;
  if (preimage.startsWith("target:")) return preimage.slice("target:".length) as ObjRef;
  if (preimage.startsWith("scope:")) return preimage.slice("scope:".length) as ObjRef;
  if (preimage.startsWith("call:")) {
    const rest = preimage.slice("call:".length);
    const split = rest.lastIndexOf(":");
    return (split > 0 ? rest.slice(0, split) : rest) as ObjRef;
  }

  const cell = preimage.replace(/^(?:read|write):/, "");
  for (const prefix of ["cell:location:", "cell:contents:", "cell:lifecycle:"]) {
    if (cell.startsWith(prefix)) return cell.slice(prefix.length) as ObjRef;
  }
  if (cell.startsWith("cell:prop:")) {
    const rest = cell.slice("cell:prop:".length);
    const split = rest.lastIndexOf(".");
    return (split > 0 ? rest.slice(0, split) : rest) as ObjRef;
  }
  if (cell.startsWith("cell:verb:")) {
    const rest = cell.slice("cell:verb:".length);
    const split = rest.lastIndexOf(":");
    return (split > 0 ? rest.slice(0, split) : rest) as ObjRef;
  }
  return null;
}

export function executorEnvelopeId(
  turnId: string,
  attempt: number,
  repairId: () => string
): string {
  // Commit scopes cache replies by envelope id. Repair retries keep the
  // caller-visible turn id but need a fresh envelope id to avoid replaying the
  // stale rejection.
  return attempt === 0 ? turnId : `${turnId}:repair:${repairId()}`;
}

export function buildExecutorCall(input: ExecutorCallInput, id: string): ShadowTurnCall {
  return {
    kind: "woo.turn_call.shadow.v1",
    id,
    route: input.route,
    scope: input.scope,
    session: input.session,
    actor: input.actor,
    target: input.target,
    verb: input.verb,
    args: input.args,
    body: input.body
  };
}

export function encodeExecutorIntentEnvelope(input: {
  node: string;
  turn: ExecutorCallInput;
  turnId?: string;
  envelopeId?: string;
}): string {
  return encodeEnvelope(buildShadowTurnIntentEnvelope({
    node: input.node,
    actor: input.turn.actor,
    session: input.turn.session,
    token: input.turn.token,
    id: input.turnId,
    envelopeId: input.envelopeId,
    route: input.turn.route,
    scope: input.turn.scope,
    target: input.turn.target,
    verb: input.turn.verb,
    args: input.turn.args,
    body: input.turn.body,
    persistence: input.turn.persistence
  }));
}

export function encodeExecutorExecEnvelope(input: {
  node: string;
  turn: ExecutorCallInput;
  turnId: string;
  envelopeId?: string;
  request: ShadowTurnExecRequest;
}): string {
  return encodeEnvelope(buildShadowTurnExecEnvelope({
    node: input.node,
    actor: input.turn.actor,
    session: input.turn.session,
    token: input.turn.token,
    id: input.turnId,
    envelopeId: input.envelopeId,
    body: input.request
  }));
}

export function executorEnvelopeBody(input: {
  scope: ObjRef;
  node: string;
  turn: ExecutorCallInput;
  authority: ExecutorAuthorityPayload;
  envelope: string;
  plannedTranscriptCommit?: boolean;
}): ExecutorEnvelopeBody {
  return {
    scope: input.scope,
    node: input.node,
    token: input.turn.token,
    session: input.turn.session,
    actor: input.turn.actor,
    sessions: input.authority.sessions,
    session_objects: input.authority.session_objects,
    authority: input.authority.authority,
    envelope: input.envelope,
    ...(input.plannedTranscriptCommit ? { planned_transcript_commit: true } : {})
  };
}

export function decodeExecutorReply(encoded: string | null): ShadowEnvelope<ShadowTurnExecReply> | null {
  return encoded ? decodeEnvelope<ShadowTurnExecReply>(encoded) : null;
}

export async function submitTurnIntent<Client, Result extends ExecutorEnvelopeResult>(
  options: SubmitTurnIntentOptions<Client, Result>
): Promise<SubmitTurnIntentResult<Client, Result>> {
  const maxAttempts = options.maxAttempts ?? 1;
  const shouldRetry = options.shouldRetry ?? executorReplyNeedsRepair;
  let repairObjectIds: ObjRef[] = [];
  // Slice 1 phase attribution: charge the turn's wall time to the loop's
  // phases (client open, authority reconstruction/fan-in, local serialize,
  // planning-world build, VM run, commit-envelope RPC) so a slow turn can be
  // diagnosed without guessing. All *_ms sum across repair attempts; one
  // turn_phase_timing metric is emitted on every exit (commit, local frame, or
  // throw). Cheap (a handful of Date.now() reads) and generic — every
  // submitTurnIntent caller (MCP, dev, browser) gets the same breakdown.
  const turnStartedAt = Date.now();
  let phaseAttempts = 0;
  let ensureClientMs = 0;
  let authorityMs = 0;
  let authorityCalls = 0;
  let serializeMs = 0;
  let planBuildMs = 0;
  let vmMs = 0;
  let submitMs = 0;
  const ensureDetailMs = new Map<string, number>();
  const submitDetailMs = new Map<string, number>();
  let phaseOutcome: "submitted" | "local_frame" | "error" = "error";
  let phaseCommitScope: ObjRef | null = null;
  const addDetailMs = (map: Map<string, number>, label: string, ms: number): void => {
    if (!label) return;
    map.set(label, (map.get(label) ?? 0) + Math.max(0, Math.round(ms)));
  };
  const detailRecord = (map: Map<string, number>): Record<string, number> | undefined => {
    if (map.size === 0) return undefined;
    return Object.fromEntries(Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b)));
  };
  const timing: SubmitTurnPhaseTimer = {
    add: (phase, label, ms) => {
      addDetailMs(phase === "ensure_client" ? ensureDetailMs : submitDetailMs, label, ms);
    },
    time: async <T>(phase: SubmitTurnTimedPhase, label: string, body: () => T | Promise<T>): Promise<T> => {
      const startedAt = Date.now();
      try {
        return await body();
      } finally {
        timing.add(phase, label, Date.now() - startedAt);
      }
    }
  };
  const repairPlanningAuthority = options.repairPlanningAuthority ?? options.prePlanAuthority === true;
  const emitPhaseTiming = (): void => {
    const ensureDetail = detailRecord(ensureDetailMs);
    const submitDetail = detailRecord(submitDetailMs);
    options.onMetric?.({
      kind: "turn_phase_timing",
      scope: options.input.scope,
      commit_scope: phaseCommitScope,
      target: options.input.target,
      verb: options.input.verb,
      route: options.input.route,
      attempts: phaseAttempts,
      outcome: phaseOutcome,
      total_ms: Date.now() - turnStartedAt,
      ensure_client_ms: ensureClientMs,
      authority_ms: authorityMs,
      authority_calls: authorityCalls,
      serialize_ms: serializeMs,
      plan_build_ms: planBuildMs,
      vm_ms: vmMs,
      submit_ms: submitMs,
      ...(ensureDetail ? { ensure_detail_ms: ensureDetail } : {}),
      ...(submitDetail ? { submit_detail_ms: submitDetail } : {})
    });
  };
  // Time a phase and charge its elapsed wall time even when it THROWS — a
  // throwing authority/VM/submit must show its real cost so the failure-path
  // diagnosis this metric exists for is not under-reported. `add` accumulates
  // into the right phase total; works for sync or async phase bodies.
  const timePhase = async <T>(add: (ms: number) => void, body: () => T | Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await body();
    } finally {
      add(Date.now() - startedAt);
    }
  };
  const basePlanningAuthorityObjectIds = (planningScope: ObjRef): ObjRef[] =>
    options.authorityObjectIds?.(options.input, planningScope)
      ?? executorAuthorityObjectIds(options.input, planningScope);
  const planningAuthorityObjectIds = (planningScope: ObjRef): ObjRef[] => mergeExecutorObjectIds(
    basePlanningAuthorityObjectIds(planningScope),
    repairObjectIds
  );
  const refreshPlanningAuthority = async (planningScope: ObjRef, planningClient: Client, repair = false): Promise<void> => {
    authorityCalls += 1;
    const authority = await timePhase((ms) => { authorityMs += ms; }, () => options.authorityPayload(planningScope, planningAuthorityObjectIds(planningScope), { phase: "pre_plan", repair }));
    options.applyAuthority?.(planningClient, authority.authority);
  };
  try {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    phaseAttempts = attempt + 1;
    const planningScope = options.planningScope?.(options.input) ?? options.input.scope;
    const planningClient = await timePhase((ms) => { ensureClientMs += ms; }, () => options.ensureClient(planningScope, attempt, {
      phase: "planning",
      planningScope,
      plannedTranscriptCommit: false,
      timing
    }));
    const turnId = options.input.id ?? options.nextTurnId(planningClient, attempt);
    const call = buildExecutorCall(options.input, turnId);
    if (options.prePlanAuthority) {
      await refreshPlanningAuthority(planningScope, planningClient);
    }
    const serialized = await timePhase((ms) => { serializeMs += ms; }, () => options.clientSerialized?.(planningClient));
    if (!serialized) throw new Error("planned v2 turn gateway submission requires clientSerialized");
    let planned: ShadowTurnCallTranscriptRun;
    try {
      // Admit the planning world through the gate, then run the VM against the
      // branded result. A presentation stub (or, where enforced, an untagged cell)
      // raises a repairable E_NEED_STATE here — caught by this try's repair branch,
      // which refreshes the named object's authority and retries. Sparse planning
      // always passes through the gate; provenance defaults to empty when a caller
      // does not thread it (still enforced — onAdmissionViolation is only logging).
      const planningProvenance = options.clientPlanningProvenance?.(planningClient) ?? new Map();
      const planningWorld = await timePhase((ms) => { planBuildMs += ms; }, () => buildPlanningWorld(serialized, planningProvenance, {
        ...(options.onAdmissionViolation ? { onViolation: options.onAdmissionViolation } : {}),
        ...(options.enforceMissingProvenance ? { enforceMissingProvenance: true } : {})
      }));
      planned = await timePhase((ms) => { vmMs += ms; }, () => runShadowTurnCallTranscript(planningWorld, call, {
        // CA11.2 occupancy transition: thread the same per-cell provenance the
        // admission gate used, so the movement-boundary check can recognise a move
        // DESTINATION served only as a non-authoritative topology pre-seed and
        // force an owner-authority repair before commit.
        ...(planningProvenance.size > 0 ? { planning_cell_provenance: planningProvenance } : {}),
        ...(options.enforceMovementOwnerRepair ? { enforce_movement_owner_repair: true } : {}),
        ...(options.enforceResolutionOwnerRepair ? { enforce_resolution_owner_repair: true } : {}),
        ...(options.onMetric ? { onMetric: options.onMetric } : {})
      }));
    } catch (err) {
      // Sparse MCP planning can discover a transitive object before the commit
      // executor sees it; repair that materialization miss and rerun the turn.
      const missingObjectIds = repairPlanningAuthority
        ? executorObjectIdsFromLocalPlanningError(err)
        : [];
      const repairIds = missingObjectIds.length > 0
        ? missingObjectIds
        : repairPlanningAuthority && isRepairableLocalPlanningLookupError(err)
        ? basePlanningAuthorityObjectIds(planningScope)
        : [];
      const nextRepairObjectIds = mergeExecutorObjectIds(repairObjectIds, repairIds);
      if (attempt + 1 < maxAttempts && nextRepairObjectIds.length > repairObjectIds.length) {
        repairObjectIds = nextRepairObjectIds;
        if (!options.prePlanAuthority) await refreshPlanningAuthority(planningScope, planningClient, true);
        continue;
      }
      throw err;
    }
    if (planned.frame.op === "error") {
      // Catalog code may wrap the same materialization miss into a local error
      // frame. Treat it like guarded execution, but only for pre-plan repair.
      const missingObjectIds = repairPlanningAuthority
        ? executorObjectIdsFromLocalPlanningFrame(planned.frame)
        : [];
      const repairIds = missingObjectIds.length > 0
        ? missingObjectIds
        : repairPlanningAuthority && isRepairableLocalPlanningLookupFrame(planned.frame)
        ? basePlanningAuthorityObjectIds(planningScope)
        : [];
      const nextRepairObjectIds = mergeExecutorObjectIds(repairObjectIds, repairIds);
      if (attempt + 1 < maxAttempts && nextRepairObjectIds.length > repairObjectIds.length) {
        repairObjectIds = nextRepairObjectIds;
        if (!options.prePlanAuthority) await refreshPlanningAuthority(planningScope, planningClient, true);
        continue;
      }
      phaseOutcome = "local_frame";
      return { kind: "local_frame", frame: planned.frame, call, planned };
    }

    const key = shadowTurnKeyFromTranscript(planned.transcript);
    // B6: the commit scope is chosen by the turn's write set (VTN0 claim 3 /
    // VTN8.2). A "relocation" turn commits at the moved object's location
    // authority (CA3, off the room sequencer); everything else commits at the
    // planning/turn-key scope, which already serializes the shared cells the
    // turn touches. A "multi" turn (>=2 distinct non-planning owners) keeps the
    // planning-scope commit for now and is flagged for observability. A
    // differing commitScope drives the planned-transcript commit path below so
    // the authority replays the planned transcript rather than re-running the
    // verb in a foreign scope.
    const commitSelection = selectCommitScopeForTranscript(planned.transcript, key.scope, options.onMetric);
    const commitScope = commitSelection.scope;
    phaseCommitScope = commitScope;
    const plannedTranscriptCommit = commitScope !== key.scope;
    const commitClient = commitScope === planningScope && !plannedTranscriptCommit
      ? planningClient
      : await timePhase((ms) => { ensureClientMs += ms; }, () => options.ensureClient(commitScope, attempt, {
        phase: "commit",
        planningScope,
        plannedTranscriptCommit,
        timing
      }));
    const authorityObjectIds = mergeExecutorObjectIds(
      options.authorityObjectIds?.(options.input, commitScope)
        ?? executorAuthorityObjectIds(options.input, commitScope),
      repairObjectIds,
      executorTranscriptObjectIds(planned.transcript)
    );
    authorityCalls += 1;
    const authority = await timePhase((ms) => { authorityMs += ms; }, () => options.authorityPayload(commitScope, authorityObjectIds, { phase: "commit" }));
    options.applyAuthority?.(commitClient, authority.authority);
    if (commitClient !== planningClient) options.applyAuthority?.(planningClient, authority.authority);
    const head = options.clientHead?.(commitClient);
    if (!head) throw new Error("planned v2 turn gateway submission requires clientHead");
    const request: ShadowTurnExecRequest = {
      kind: "woo.turn.exec.request.shadow.v1",
      id: turnId,
      call,
      key,
      expected: head,
      auth: {
        mode: "shadow_local",
        actor: options.input.actor,
        session: options.input.session
      },
      persistence: options.input.persistence,
      // Cross-scope commits (commitScope differs from the planned turn-key
      // scope) carry the planned transcript + frame so the location authority
      // commits the browser-planned result instead of re-running the verb.
      ...(plannedTranscriptCommit ? {
        planned_transcript: planned.transcript,
        planned_frame: planned.frame
      } : {})
    };
    const envelope = encodeExecutorExecEnvelope({
      node: options.clientNode(commitClient),
      turn: options.input,
      turnId,
      envelopeId: options.envelopeId?.(turnId, attempt),
      request
    });
    const result = await timePhase((ms) => { submitMs += ms; }, () => options.submitEnvelope(commitScope, executorEnvelopeBody({
      scope: commitScope,
      node: options.clientNode(commitClient),
      turn: options.input,
      authority,
      envelope,
      plannedTranscriptCommit
    }), { timing }));
    const replyEnvelope = decodeExecutorReply(result.reply);
    if (replyEnvelope?.body && attempt + 1 < maxAttempts && shouldRetry(replyEnvelope.body)) {
      const body = replyEnvelope.body;
      // A stale-head / read-version conflict reports the authority's CURRENT
      // head. Adopt it (mirrors executeShadowTurnNetwork's authoritative-executor
      // convergence) and re-fetch authority for everything this turn touched, so
      // the next attempt plans + commits against the right head AND fresh cell
      // versions — instead of re-submitting the same stale `expected` and burning
      // the whole retry budget. Without this, a first-turn-on-scope commit whose
      // relay head is still @0 grinds all maxAttempts and returns an error.
      if (body.ok === false && body.commit?.current) {
        options.applyHead?.(commitClient, body.commit.current);
        if (commitClient !== planningClient) options.applyHead?.(planningClient, body.commit.current);
      }
      // DESIGN A layer-2: a read-version-mismatch conflict carries a cell-page
      // transfer of the mismatched cells at the committing scope's CURRENT
      // versions. Install it into the planning cache so the next attempt plans
      // against the fresh cells and converges — the head adoption above is not
      // enough on its own when the stale row is a cell value/version (e.g. a
      // self-certified actor stub) rather than the scope head. Install on the
      // commit client and, when distinct, the planning client (the planner is
      // what re-runs the verb next round).
      if (body.ok === false && body.state_transfer) {
        options.applyStateTransfer?.(commitClient, body.state_transfer);
        if (commitClient !== planningClient) options.applyStateTransfer?.(planningClient, body.state_transfer);
      }
      repairObjectIds = mergeExecutorObjectIds(
        repairObjectIds,
        executorObjectIdsFromMissingState(body),
        executorTranscriptObjectIds(planned.transcript)
      );
      continue;
    }
    phaseOutcome = "submitted";
    return {
      kind: "submitted",
      scope: options.input.scope,
      commitScope,
      client: commitClient,
      result,
      replyEnvelope,
      reply: replyEnvelope?.body ?? null,
      call,
      planned
    };
  }
  throw new Error("v2 turn gateway retry loop exhausted");
  } finally {
    emitPhaseTiming();
  }
}

function mergeExecutorObjectIds(...lists: ObjRef[][]): ObjRef[] {
  const ids: ObjRef[] = [];
  const seen = new Set<ObjRef>();
  for (const list of lists) {
    for (const id of list) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
