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
import type { ShadowMissingAtom, ShadowTurnExecReply, ShadowTurnExecRequest } from "./shadow-turn-exec";
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
  authority: SerializedAuthoritySlice;
  expires_at_ms: number;
};

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

export type SubmitTurnIntentOptions<Client, Result extends ExecutorEnvelopeResult> = {
  input: ExecutorCallInput;
  maxAttempts?: number;
  ensureClient(scope: ObjRef, attempt: number): Promise<Client>;
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
  nextTurnId(client: Client, attempt: number): string;
  envelopeId?(turnId: string, attempt: number): string;
  authorityPayload(
    scope: ObjRef,
    extraObjectIds: ObjRef[],
    context?: { phase: "intent" | "pre_plan" | "commit" }
  ): ExecutorAuthorityPayload | Promise<ExecutorAuthorityPayload>;
  // `planned-exec` normally plans from the caller's cached relay view, then
  // refreshes authority for commit. Sparse gateway shards need the reverse for
  // local planning: repair/merge the known authority first so catalog lineage
  // and transitive refs are present before the VM can fail locally.
  prePlanAuthority?: boolean;
  submitEnvelope(scope: ObjRef, body: ExecutorEnvelopeBody): Promise<Result>;
  applyAuthority?(client: Client, authority: SerializedAuthoritySlice): void;
  // Adopt the authority's reported current head after a stale-head/version
  // conflict, so the next attempt plans + submits against the right head instead
  // of re-submitting the same stale `expected`. Without this, a distributed
  // caller (gateway/REST) whose executor is a partial relay shard cannot use the
  // in-process convergence in executeShadowTurnNetwork (which bails for
  // non-authoritative executors) and grinds the full retry budget on every
  // contended/first-turn-on-scope commit. See the conflict's `commit.current`.
  applyHead?(client: Client, head: ShadowScopeHead): void;
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
  authority: SerializedAuthoritySlice;
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
    authority: input.authority,
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
  let phaseOutcome: "submitted" | "local_frame" | "error" = "error";
  let phaseCommitScope: ObjRef | null = null;
  const emitPhaseTiming = (): void => {
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
      submit_ms: submitMs
    });
  };
  try {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    phaseAttempts = attempt + 1;
    const planningScope = options.planningScope?.(options.input) ?? options.input.scope;
    const ensureClientStartedAt = Date.now();
    const planningClient = await options.ensureClient(planningScope, attempt);
    ensureClientMs += Date.now() - ensureClientStartedAt;
    const turnId = options.input.id ?? options.nextTurnId(planningClient, attempt);
    const call = buildExecutorCall(options.input, turnId);
    if (options.prePlanAuthority) {
      const prePlanAuthorityObjectIds = mergeExecutorObjectIds(
        options.authorityObjectIds?.(options.input, planningScope)
          ?? executorAuthorityObjectIds(options.input, planningScope),
        repairObjectIds
      );
      const prePlanAuthorityStartedAt = Date.now();
      const prePlanAuthority = await options.authorityPayload(planningScope, prePlanAuthorityObjectIds, { phase: "pre_plan" });
      authorityMs += Date.now() - prePlanAuthorityStartedAt;
      authorityCalls += 1;
      options.applyAuthority?.(planningClient, prePlanAuthority.authority);
    }
    const serializeStartedAt = Date.now();
    const serialized = options.clientSerialized?.(planningClient);
    serializeMs += Date.now() - serializeStartedAt;
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
      const planBuildStartedAt = Date.now();
      const planningWorld = buildPlanningWorld(serialized, planningProvenance, {
        ...(options.onAdmissionViolation ? { onViolation: options.onAdmissionViolation } : {}),
        ...(options.enforceMissingProvenance ? { enforceMissingProvenance: true } : {})
      });
      planBuildMs += Date.now() - planBuildStartedAt;
      const vmStartedAt = Date.now();
      planned = await runShadowTurnCallTranscript(planningWorld, call, {
        ...(options.onMetric ? { onMetric: options.onMetric } : {})
      });
      vmMs += Date.now() - vmStartedAt;
    } catch (err) {
      // Sparse MCP planning can discover a transitive object before the commit
      // executor sees it; repair that materialization miss and rerun the turn.
      const missingObjectIds = options.prePlanAuthority
        ? executorObjectIdsFromLocalPlanningError(err)
        : [];
      const nextRepairObjectIds = mergeExecutorObjectIds(repairObjectIds, missingObjectIds);
      if (attempt + 1 < maxAttempts && nextRepairObjectIds.length > repairObjectIds.length) {
        repairObjectIds = nextRepairObjectIds;
        continue;
      }
      throw err;
    }
    if (planned.frame.op === "error") {
      // Catalog code may wrap the same materialization miss into a local error
      // frame. Treat it like guarded execution, but only for pre-plan repair.
      const missingObjectIds = options.prePlanAuthority
        ? executorObjectIdsFromLocalPlanningFrame(planned.frame)
        : [];
      const nextRepairObjectIds = mergeExecutorObjectIds(repairObjectIds, missingObjectIds);
      if (attempt + 1 < maxAttempts && nextRepairObjectIds.length > repairObjectIds.length) {
        repairObjectIds = nextRepairObjectIds;
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
    let commitClient: Client;
    if (commitScope === planningScope) {
      commitClient = planningClient;
    } else {
      const commitEnsureStartedAt = Date.now();
      commitClient = await options.ensureClient(commitScope, attempt);
      ensureClientMs += Date.now() - commitEnsureStartedAt;
    }
    const authorityObjectIds = mergeExecutorObjectIds(
      options.authorityObjectIds?.(options.input, commitScope)
        ?? executorAuthorityObjectIds(options.input, commitScope),
      repairObjectIds,
      executorTranscriptObjectIds(planned.transcript)
    );
    const commitAuthorityStartedAt = Date.now();
    const authority = await options.authorityPayload(commitScope, authorityObjectIds, { phase: "commit" });
    authorityMs += Date.now() - commitAuthorityStartedAt;
    authorityCalls += 1;
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
      ...(commitScope !== key.scope ? {
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
    const submitStartedAt = Date.now();
    const result = await options.submitEnvelope(commitScope, executorEnvelopeBody({
      scope: commitScope,
      node: options.clientNode(commitClient),
      turn: options.input,
      authority,
      envelope,
      plannedTranscriptCommit: commitScope !== key.scope
    }));
    submitMs += Date.now() - submitStartedAt;
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
