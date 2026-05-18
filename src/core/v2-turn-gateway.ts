import type { SerializedAuthoritySlice, SerializedObject, SerializedSession, SerializedWorld } from "./repository";
import {
  buildShadowTurnExecEnvelope,
  buildShadowTurnIntentEnvelope
} from "./shadow-browser-node";
import { decodeEnvelope, encodeEnvelope, type ShadowEnvelope } from "./shadow-envelope";
import { runShadowTurnCallTranscript, type ShadowTurnCall, type ShadowTurnCallTranscriptRun } from "./shadow-turn-call";
import type { ShadowTurnExecReply, ShadowTurnExecRequest } from "./shadow-turn-exec";
import { type ShadowScopeHead } from "./shadow-commit-scope";
import { shadowTurnKeyFromTranscript } from "./turn-key";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, MetricEvent, ObjRef, WooValue } from "./types";
import type { WooWorld } from "./world";

export type V2TurnGatewayAuthorityPayload = {
  sessions: SerializedSession[];
  session_objects: SerializedObject[];
  authority: SerializedAuthoritySlice;
};

export type V2TurnGatewayCallInput = {
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

export type V2TurnGatewayEnvelopeBody = {
  scope: ObjRef;
  node: string;
  token: string;
  session: string;
  actor: ObjRef;
  sessions: SerializedSession[];
  session_objects: SerializedObject[];
  authority: SerializedAuthoritySlice;
  envelope: string;
};

export type V2TurnGatewayEnvelopeResult = {
  reply: string | null;
  head?: ShadowScopeHead;
};

export type SubmitTurnIntentResult<Client, Result extends V2TurnGatewayEnvelopeResult> =
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

export type SubmitTurnIntentOptions<Client, Result extends V2TurnGatewayEnvelopeResult> = {
  input: V2TurnGatewayCallInput;
  strategy: "intent" | "planned-exec";
  maxAttempts?: number;
  ensureClient(scope: ObjRef, attempt: number): Promise<Client>;
  clientNode(client: Client): string;
  clientHead?(client: Client): ShadowScopeHead;
  clientSerialized?(client: Client): SerializedWorld;
  nextTurnId(client: Client, attempt: number): string;
  envelopeId?(turnId: string, attempt: number): string;
  authorityPayload(scope: ObjRef, extraObjectIds: ObjRef[]): V2TurnGatewayAuthorityPayload;
  submitEnvelope(scope: ObjRef, body: V2TurnGatewayEnvelopeBody): Promise<Result>;
  authorityObjectIds?(input: V2TurnGatewayCallInput, commitScope: ObjRef): ObjRef[];
  shouldRetry?(reply: ShadowTurnExecReply): boolean;
  // Forwarder for engine metric events recorded during planning-phase
  // verb execution (the ephemeral world built from clientSerialized).
  // Lets host metric sinks see `direct_call`, `applied`,
  // `dispatch_resolved`, and `broadcast` events for v2 traffic; without
  // it those kinds never land in AE and footprint-by-verb is empty.
  onMetric?: (event: MetricEvent) => void;
};

export function v2TurnGatewayAuthorityPayload(
  world: WooWorld,
  extraObjectIds: Iterable<ObjRef> = []
): V2TurnGatewayAuthorityPayload {
  // Gateways must refresh bearer/session authority without exporting a full
  // world. Keep the payload shape identical for REST, MCP, WS, and Worker DO
  // callers so later cell-slice shrinking has one contract to change.
  const sessions = world.exportSessions();
  const authority = world.exportAuthoritySlice(sessions, extraObjectIds);
  return { sessions: authority.sessions, session_objects: authority.objects, authority };
}

export function mergeV2TurnGatewayAuthority(
  serialized: { sessions: SerializedSession[]; objects: SerializedObject[] },
  authority: Pick<SerializedAuthoritySlice, "sessions" | "objects">,
  options: { clone?: boolean } = {}
): void {
  serialized.sessions = options.clone
    ? structuredClone(authority.sessions) as SerializedSession[]
    : authority.sessions;
  const byId = new Map(serialized.objects.map((obj, index) => [obj.id, index] as const));
  for (const obj of authority.objects) {
    const next = options.clone ? structuredClone(obj) as SerializedObject : obj;
    const index = byId.get(next.id);
    if (index === undefined) {
      byId.set(next.id, serialized.objects.length);
      serialized.objects.push(next);
    } else {
      serialized.objects[index] = next;
    }
  }
}

export function v2TurnGatewayAuthorityObjectIds(
  input: { scope: ObjRef; target?: ObjRef | null; actor: ObjRef },
  commitScope: ObjRef = input.scope
): ObjRef[] {
  const ids: ObjRef[] = [];
  const seen = new Set<ObjRef>();
  const push = (id: ObjRef | null | undefined): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  push(commitScope);
  push(input.scope);
  push(input.target);
  push(input.actor);
  return ids;
}

export function v2TurnGatewayReplyNeedsRepair(reply: ShadowTurnExecReply): boolean {
  if (reply.ok === true) return false;
  if (reply.reason === "missing_state") return true;
  return reply.reason === "commit_rejected" && reply.commit?.reason === "stale_head";
}

export function v2TurnGatewayEnvelopeId(
  turnId: string,
  attempt: number,
  repairId: () => string
): string {
  // Commit scopes cache replies by envelope id. Repair retries keep the
  // caller-visible turn id but need a fresh envelope id to avoid replaying the
  // stale rejection.
  return attempt === 0 ? turnId : `${turnId}:repair:${repairId()}`;
}

export function buildV2TurnGatewayCall(input: V2TurnGatewayCallInput, id: string): ShadowTurnCall {
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

export function encodeV2TurnGatewayIntentEnvelope(input: {
  node: string;
  turn: V2TurnGatewayCallInput;
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

export function encodeV2TurnGatewayExecEnvelope(input: {
  node: string;
  turn: V2TurnGatewayCallInput;
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

export function v2TurnGatewayEnvelopeBody(input: {
  scope: ObjRef;
  node: string;
  turn: V2TurnGatewayCallInput;
  authority: V2TurnGatewayAuthorityPayload;
  envelope: string;
}): V2TurnGatewayEnvelopeBody {
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

export function decodeV2TurnGatewayReply(encoded: string | null): ShadowEnvelope<ShadowTurnExecReply> | null {
  return encoded ? decodeEnvelope<ShadowTurnExecReply>(encoded) : null;
}

export async function submitTurnIntent<Client, Result extends V2TurnGatewayEnvelopeResult>(
  options: SubmitTurnIntentOptions<Client, Result>
): Promise<SubmitTurnIntentResult<Client, Result>> {
  const maxAttempts = options.maxAttempts ?? 1;
  const shouldRetry = options.shouldRetry ?? v2TurnGatewayReplyNeedsRepair;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.strategy === "intent") {
      const client = await options.ensureClient(options.input.scope, attempt);
      const turnId = options.input.id ?? options.nextTurnId(client, attempt);
      const envelope = encodeV2TurnGatewayIntentEnvelope({
        node: options.clientNode(client),
        turn: options.input,
        turnId,
        envelopeId: options.envelopeId?.(turnId, attempt)
      });
      const authorityObjectIds = options.authorityObjectIds?.(options.input, options.input.scope)
        ?? v2TurnGatewayAuthorityObjectIds(options.input);
      const result = await options.submitEnvelope(options.input.scope, v2TurnGatewayEnvelopeBody({
        scope: options.input.scope,
        node: options.clientNode(client),
        turn: options.input,
        authority: options.authorityPayload(options.input.scope, authorityObjectIds),
        envelope
      }));
      const replyEnvelope = decodeV2TurnGatewayReply(result.reply);
      if (replyEnvelope?.body && attempt + 1 < maxAttempts && shouldRetry(replyEnvelope.body)) continue;
      return {
        kind: "submitted",
        scope: options.input.scope,
        commitScope: options.input.scope,
        client,
        result,
        replyEnvelope,
        reply: replyEnvelope?.body ?? null,
        call: buildV2TurnGatewayCall(options.input, turnId)
      };
    }

    const planningClient = await options.ensureClient(options.input.scope, attempt);
    const turnId = options.input.id ?? options.nextTurnId(planningClient, attempt);
    const call = buildV2TurnGatewayCall(options.input, turnId);
    const serialized = options.clientSerialized?.(planningClient);
    if (!serialized) throw new Error("planned v2 turn gateway submission requires clientSerialized");
    const planned = await runShadowTurnCallTranscript(serialized, call, { onMetric: options.onMetric });
    if (planned.frame.op === "error") return { kind: "local_frame", frame: planned.frame, call, planned };

    const key = shadowTurnKeyFromTranscript(planned.transcript);
    const commitScope = key.scope;
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
    const envelope = encodeV2TurnGatewayExecEnvelope({
      node: options.clientNode(commitClient),
      turn: options.input,
      turnId,
      envelopeId: options.envelopeId?.(turnId, attempt),
      request
    });
    const authorityObjectIds = options.authorityObjectIds?.(options.input, commitScope)
      ?? v2TurnGatewayAuthorityObjectIds(options.input, commitScope);
    const result = await options.submitEnvelope(commitScope, v2TurnGatewayEnvelopeBody({
      scope: commitScope,
      node: options.clientNode(commitClient),
      turn: options.input,
      authority: options.authorityPayload(commitScope, authorityObjectIds),
      envelope
    }));
    const replyEnvelope = decodeV2TurnGatewayReply(result.reply);
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
