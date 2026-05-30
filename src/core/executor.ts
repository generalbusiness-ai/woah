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
import { mergeSerializedAuthoritySlice, type MergeSerializedAuthorityInput } from "./authority-slice";
import {
  buildShadowTurnExecEnvelope,
  buildShadowTurnIntentEnvelope
} from "./shadow-browser-node";
import { decodeEnvelope, encodeEnvelope, type ShadowEnvelope } from "./shadow-envelope";
import { runShadowTurnCallTranscript, type ShadowTurnCall, type ShadowTurnCallTranscriptRun } from "./shadow-turn-call";
import type { ShadowTurnExecReply, ShadowTurnExecRequest } from "./shadow-turn-exec";
import {
  shadowPlacementTransactionForTranscript,
  type ShadowCommitTransaction,
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
  strategy: "intent" | "planned-exec";
  maxAttempts?: number;
  ensureClient(scope: ObjRef, attempt: number): Promise<Client>;
  clientNode(client: Client): string;
  clientHead?(client: Client): ShadowScopeHead;
  clientSerialized?(client: Client): SerializedWorld;
  nextTurnId(client: Client, attempt: number): string;
  envelopeId?(turnId: string, attempt: number): string;
  authorityPayload(scope: ObjRef, extraObjectIds: ObjRef[]): ExecutorAuthorityPayload | Promise<ExecutorAuthorityPayload>;
  submitEnvelope(scope: ObjRef, body: ExecutorEnvelopeBody): Promise<Result>;
  authorityObjectIds?(input: ExecutorCallInput, commitScope: ObjRef): ObjRef[];
  transactionScopeForTranscript?(input: {
    turn: ExecutorCallInput;
    planned: ShadowTurnCallTranscriptRun;
    transaction: ShadowCommitTransaction;
  }): ObjRef | null | undefined;
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
  options: { clone?: boolean } = {}
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

export function executorTransactionObjectIds(transaction: ShadowCommitTransaction | null | undefined): ObjRef[] {
  if (!transaction) return [];
  const ids: ObjRef[] = [];
  const seen = new Set<ObjRef>();
  for (const cell of transaction.cells) {
    if (seen.has(cell.object)) continue;
    seen.add(cell.object);
    ids.push(cell.object);
  }
  return ids;
}

export function executorReplyNeedsRepair(reply: ShadowTurnExecReply): boolean {
  if (reply.ok === true) return false;
  if (reply.reason === "missing_state") return true;
  return reply.reason === "commit_rejected" && reply.commit?.reason === "stale_head";
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
    envelope: input.envelope
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
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.strategy === "intent") {
      const client = await options.ensureClient(options.input.scope, attempt);
      const turnId = options.input.id ?? options.nextTurnId(client, attempt);
      const envelope = encodeExecutorIntentEnvelope({
        node: options.clientNode(client),
        turn: options.input,
        turnId,
        envelopeId: options.envelopeId?.(turnId, attempt)
      });
      const authorityObjectIds = options.authorityObjectIds?.(options.input, options.input.scope)
        ?? executorAuthorityObjectIds(options.input);
      const authority = await options.authorityPayload(options.input.scope, authorityObjectIds);
      const result = await options.submitEnvelope(options.input.scope, executorEnvelopeBody({
        scope: options.input.scope,
        node: options.clientNode(client),
        turn: options.input,
        authority,
        envelope
      }));
      const replyEnvelope = decodeExecutorReply(result.reply);
      if (replyEnvelope?.body && attempt + 1 < maxAttempts && shouldRetry(replyEnvelope.body)) continue;
      return {
        kind: "submitted",
        scope: options.input.scope,
        commitScope: options.input.scope,
        client,
        result,
        replyEnvelope,
        reply: replyEnvelope?.body ?? null,
        call: buildExecutorCall(options.input, turnId)
      };
    }

    const planningClient = await options.ensureClient(options.input.scope, attempt);
    const turnId = options.input.id ?? options.nextTurnId(planningClient, attempt);
    const call = buildExecutorCall(options.input, turnId);
    const serialized = options.clientSerialized?.(planningClient);
    if (!serialized) throw new Error("planned v2 turn gateway submission requires clientSerialized");
    const planned = await runShadowTurnCallTranscript(serialized, call, { onMetric: options.onMetric });
    if (planned.frame.op === "error") return { kind: "local_frame", frame: planned.frame, call, planned };

    const key = shadowTurnKeyFromTranscript(planned.transcript);
    const transaction = shadowPlacementTransactionForTranscript(planned.transcript);
    const transactionScope = transaction
      ? options.transactionScopeForTranscript?.({ turn: options.input, planned, transaction }) ?? null
      : null;
    const commitScope = transactionScope ?? key.scope;
    const commitClient = commitScope === options.input.scope
      ? planningClient
      : await options.ensureClient(commitScope, attempt);
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
      persistence: options.input.persistence
    };
    const envelope = encodeExecutorExecEnvelope({
      node: options.clientNode(commitClient),
      turn: options.input,
      turnId,
      envelopeId: options.envelopeId?.(turnId, attempt),
      request
    });
    const authorityObjectIds = mergeExecutorObjectIds(
      options.authorityObjectIds?.(options.input, commitScope)
        ?? executorAuthorityObjectIds(options.input, commitScope),
      executorTransactionObjectIds(transactionScope ? transaction : null)
    );
    const authority = await options.authorityPayload(commitScope, authorityObjectIds);
    const result = await options.submitEnvelope(commitScope, executorEnvelopeBody({
      scope: commitScope,
      node: options.clientNode(commitClient),
      turn: options.input,
      authority,
      envelope
    }));
    const replyEnvelope = decodeExecutorReply(result.reply);
    if (replyEnvelope?.body && attempt + 1 < maxAttempts && shouldRetry(replyEnvelope.body)) continue;
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
