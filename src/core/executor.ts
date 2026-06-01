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
import type { PlanningAdmissibilityViolation, PlanningWorldProvenance } from "./planning-world";
import type { ShadowMissingAtom, ShadowTurnExecReply, ShadowTurnExecRequest } from "./shadow-turn-exec";
import {
  shadowLocationCommitScopeForTranscript,
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
  // A3.2 PlanningWorld admission gate (discovery wiring): the planning client's
  // per-cell provenance for the world `clientSerialized` returns. When present,
  // the VM-boundary admissibility check runs and reports violations via
  // `onAdmissionViolation` (no throw yet — enforcement is the P4 flip).
  clientPlanningProvenance?(client: Client): PlanningWorldProvenance;
  onAdmissionViolation?(violations: PlanningAdmissibilityViolation[]): void;
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
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const planningScope = options.planningScope?.(options.input) ?? options.input.scope;
    const planningClient = await options.ensureClient(planningScope, attempt);
    const turnId = options.input.id ?? options.nextTurnId(planningClient, attempt);
    const call = buildExecutorCall(options.input, turnId);
    if (options.prePlanAuthority) {
      const prePlanAuthorityObjectIds = mergeExecutorObjectIds(
        options.authorityObjectIds?.(options.input, planningScope)
          ?? executorAuthorityObjectIds(options.input, planningScope),
        repairObjectIds
      );
      const prePlanAuthority = await options.authorityPayload(planningScope, prePlanAuthorityObjectIds, { phase: "pre_plan" });
      options.applyAuthority?.(planningClient, prePlanAuthority.authority);
    }
    const serialized = options.clientSerialized?.(planningClient);
    if (!serialized) throw new Error("planned v2 turn gateway submission requires clientSerialized");
    let planned: ShadowTurnCallTranscriptRun;
    try {
      const planningProvenance = options.clientPlanningProvenance?.(planningClient);
      planned = await runShadowTurnCallTranscript(serialized, call, {
        ...(options.onMetric ? { onMetric: options.onMetric } : {}),
        // Enforcement depends ONLY on planningProvenance. onAdmissionViolation is
        // optional observability; a caller that supplies provenance but no logger
        // still gets the runtime gate (it must not be silently skippable).
        ...(planningProvenance ? { planningProvenance } : {}),
        ...(options.onAdmissionViolation ? { onAdmissionViolation: options.onAdmissionViolation } : {})
      });
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
      return { kind: "local_frame", frame: planned.frame, call, planned };
    }

    const key = shadowTurnKeyFromTranscript(planned.transcript);
    // CA3 location-as-truth: a single-location move commits at the moved
    // object's location authority; everything else commits at the planned
    // turn-key scope. A differing commitScope drives the planned-transcript
    // commit path below so the authority replays the planned transcript rather
    // than re-running the verb in a foreign scope.
    const locationCommitScope = shadowLocationCommitScopeForTranscript(planned.transcript);
    const commitScope = locationCommitScope ?? key.scope;
    const commitClient = commitScope === planningScope
      ? planningClient
      : await options.ensureClient(commitScope, attempt);
    const authorityObjectIds = mergeExecutorObjectIds(
      options.authorityObjectIds?.(options.input, commitScope)
        ?? executorAuthorityObjectIds(options.input, commitScope),
      repairObjectIds,
      executorTranscriptObjectIds(planned.transcript)
    );
    const authority = await options.authorityPayload(commitScope, authorityObjectIds, { phase: "commit" });
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
    const result = await options.submitEnvelope(commitScope, executorEnvelopeBody({
      scope: commitScope,
      node: options.clientNode(commitClient),
      turn: options.input,
      authority,
      envelope,
      plannedTranscriptCommit: commitScope !== key.scope
    }));
    const replyEnvelope = decodeExecutorReply(result.reply);
    if (replyEnvelope?.body && attempt + 1 < maxAttempts && shouldRetry(replyEnvelope.body)) {
      repairObjectIds = mergeExecutorObjectIds(repairObjectIds, executorObjectIdsFromMissingState(replyEnvelope.body));
      continue;
    }
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
