/**
 * The audit trail — record shape and minting (audit.md AU1/AU4/AU5).
 *
 * An audit record is a DERIVED PROJECTION of an authoritative event,
 * never an independently written account of it (AU1 = CO9 applied to
 * audit). Exactly two producers:
 *
 * - a SCOPE, for everything that committed — the record is minted in
 *   the same transaction as the commit (scope-do.ts enqueueDeliveries),
 *   so a turn cannot commit without its record and the record cannot
 *   disagree with the turn;
 * - a GATEWAY, for attempts that never committed (auth/session/rate
 *   refusals, terminal rejections) — the only place that sees them.
 *
 * Adoption commits mint ONLY the resource-owner copy (AU1): the
 * originating commit already minted the acting record, and an audit
 * trail that double-counts an action is worse than useless.
 *
 * Routing (AU5) is a list of (partition, record) pairs — the partition
 * key is the customer id (or the distinguished `operator`), computed
 * here from data the producer already holds. No producer ever resolves
 * another party's account.
 */
import { GUEST_CUSTOMER_ID, OPERATOR_CUSTOMER_ID } from "../core/attribution";
import type { Principal, ScopeAttribution } from "./attribution";
import type { CommitSubmit } from "./scope";
import { parseTraceparent, type TraceContext } from "./trace";

export type AuditActionKind = "commit" | "auth" | "session" | "refusal" | "admin";

export type AuditRecord = {
  /** Producer clock, ms (Host.now — never a module-level Date.now). */
  ts: number;
  /** AU2 join keys; absent when the event carried no trace context. */
  trace_id?: string;
  principal?: Principal;
  producer: { kind: "scope" | "gateway"; name: string };
  /** Producer-scoped idempotency: scope records use `<scope>:<seq>[:r]`,
   * gateway records a caller-supplied event id. Redelivery no-ops on
   * (partition, idempotency) at the shard. */
  idempotency: string;
  action: {
    kind: AuditActionKind;
    verb?: string;
    target?: string;
    /** Committed turns: the provenance citation — independently
     * verifiable against the scope's hash-chained transcript stream. */
    scope?: string;
    seq?: number;
    head?: string;
  };
  /** "ok", a CO6/auth verdict, or the named "unattributed" gap. */
  outcome: string;
  /** Objects touched (write set + creates + moves). */
  subjects: string[];
  /** Adoption-minted records: the originating commit (AU1). */
  cause?: { scope: string; seq: number };
  /** Redaction-governed extras (AU9). Conservative default: minting
   * includes no argument or property VALUES — what was DONE is never
   * redacted; what was SAID is absent until the redaction policy lands. */
  detail?: Record<string, unknown>;
};

/** A record addressed to one customer partition. Dual attribution =
 * the same record under two partitions. */
export type RoutedAuditRecord = { partition: string; record: AuditRecord };

/** FNV-1a shard selection over the partition key — the same stable-hash
 * family the gateway shard router uses, kept dependency-free here. */
export function auditShardFor(partition: string, shardCount: number): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < partition.length; i += 1) {
    hash ^= partition.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const count = Math.max(1, Math.floor(shardCount));
  return `audit-${hash % count}`;
}

function traceIdOf(trace: TraceContext | undefined): string | undefined {
  if (!trace) return undefined;
  return parseTraceparent(trace.traceparent)?.traceId;
}

function subjectsOf(submit: CommitSubmit): string[] {
  const subjects = new Set<string>();
  for (const write of submit.transcript.writes) subjects.add(write.cell.object);
  for (const create of submit.transcript.creates ?? []) subjects.add(create.object);
  for (const move of submit.transcript.moves ?? []) subjects.add(move.object);
  return [...subjects].sort();
}

/**
 * Scope producer, accepted commit (AU1.1 + AU5): the acting-customer
 * record always (operator partition with outcome `unattributed` when the
 * turn carried no principal — a named gap, never a drop), plus the
 * resource-owner copy when the committing scope's stamped attribution
 * names a DIFFERENT customer. Same record content under both partitions.
 */
export function mintCommitAuditRecords(input: {
  submit: CommitSubmit;
  head: { seq: number; hash: string };
  scopeAttribution: ScopeAttribution | null;
  now: number;
}): RoutedAuditRecord[] {
  const { submit, head, scopeAttribution, now } = input;
  const principal = submit.transcript.principal;
  const record: AuditRecord = {
    ts: now,
    ...(traceIdOf(submit.transcript.trace) ? { trace_id: traceIdOf(submit.transcript.trace) } : {}),
    ...(principal ? { principal } : {}),
    producer: { kind: "scope", name: submit.scope },
    idempotency: `${submit.scope}:${head.seq}`,
    action: {
      kind: "commit",
      verb: submit.transcript.call.verb,
      target: submit.transcript.call.target,
      scope: submit.scope,
      seq: head.seq,
      head: head.hash
    },
    outcome: principal ? "ok" : "unattributed",
    subjects: subjectsOf(submit)
  };
  const routed: RoutedAuditRecord[] = [];
  const actingCustomer = principal?.customer ?? null;
  routed.push({ partition: actingCustomer ?? OPERATOR_CUSTOMER_ID, record });
  // Guest activity is operator business (AU3.1 rule 4) but `guest` is
  // its own partition key so the operator view can segregate it.
  if (principal?.on_behalf_of && principal.on_behalf_of !== actingCustomer) {
    routed.push({ partition: principal.on_behalf_of, record });
  }
  if (
    scopeAttribution !== null &&
    actingCustomer !== null &&
    scopeAttribution.customer !== actingCustomer
  ) {
    routed.push({ partition: scopeAttribution.customer, record });
  }
  return routed;
}

/**
 * Scope producer, adoption commit (AU1): resource-owner record ONLY,
 * citing the originating commit. Never an acting record. Minted when the
 * adopting owner's stamped customer differs from the carried principal's
 * (an unstamped owner attributes to the operator, flagged).
 */
export function mintAdoptionAuditRecord(input: {
  ownerScope: string;
  ownerAttribution: ScopeAttribution | null;
  ownerSeq: number;
  ownerHead: string;
  principal: Principal | null;
  trace: TraceContext | null;
  cause: { scope: string; seq: number };
  subjects: string[];
  now: number;
}): RoutedAuditRecord | null {
  const actingCustomer = input.principal?.customer ?? null;
  const ownerCustomer = input.ownerAttribution?.customer ?? OPERATOR_CUSTOMER_ID;
  // Same-customer adoption needs no copy: the acting record (minted at
  // the originating scope) already covers the customer's view.
  if (actingCustomer !== null && actingCustomer === ownerCustomer) return null;
  const traceId = input.trace ? parseTraceparent(input.trace.traceparent)?.traceId : undefined;
  return {
    partition: ownerCustomer,
    record: {
      ts: input.now,
      ...(traceId ? { trace_id: traceId } : {}),
      ...(input.principal ? { principal: input.principal } : {}),
      producer: { kind: "scope", name: input.ownerScope },
      idempotency: `${input.ownerScope}:${input.ownerSeq}:adopt`,
      action: { kind: "commit", scope: input.ownerScope, seq: input.ownerSeq, head: input.ownerHead },
      outcome: input.principal ? "ok" : "unattributed",
      subjects: input.subjects,
      cause: input.cause,
      ...(input.ownerAttribution === null ? { detail: { resource_attribution: "unstamped" } } : {})
    }
  };
}

/**
 * Gateway producer (AU1.2): attempts that never committed. Routing by
 * the AU3.2 principal variant: `authenticated` → the customer;
 * `credentialed` → the credential's customer of record AND the operator;
 * `anonymous` → the operator only. Guest-attributed records go to the
 * guest partition (operator business, segregated).
 */
export function mintGatewayAuditRecord(input: {
  gateway: string;
  eventId: string;
  kind: Exclude<AuditActionKind, "commit">;
  principal: Principal;
  outcome: string;
  verb?: string;
  target?: string;
  trace?: TraceContext;
  now: number;
}): RoutedAuditRecord[] {
  const traceId = traceIdOf(input.trace);
  const record: AuditRecord = {
    ts: input.now,
    ...(traceId ? { trace_id: traceId } : {}),
    principal: input.principal,
    producer: { kind: "gateway", name: input.gateway },
    idempotency: input.eventId,
    action: {
      kind: input.kind,
      ...(input.verb ? { verb: input.verb } : {}),
      ...(input.target ? { target: input.target } : {})
    },
    outcome: input.outcome,
    subjects: input.principal.actor ? [input.principal.actor] : []
  };
  const partitions = new Set<string>();
  if (input.principal.customer) partitions.add(input.principal.customer);
  if (input.principal.attribution !== "authenticated" || !input.principal.customer) {
    partitions.add(OPERATOR_CUSTOMER_ID);
  }
  return [...partitions].map((partition) => ({ partition, record }));
}

/** Read guard for records crossing the wire (shard append). */
export function normalizeRoutedAuditRecord(raw: unknown): RoutedAuditRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.partition !== "string" || v.partition.length === 0) return null;
  const r = v.record;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return null;
  const rec = r as Record<string, unknown>;
  if (typeof rec.ts !== "number" || !Number.isFinite(rec.ts)) return null;
  if (typeof rec.idempotency !== "string" || rec.idempotency.length === 0) return null;
  if (typeof rec.outcome !== "string" || rec.outcome.length === 0) return null;
  const producer = rec.producer as Record<string, unknown> | null;
  if (
    !producer ||
    typeof producer !== "object" ||
    (producer.kind !== "scope" && producer.kind !== "gateway") ||
    typeof producer.name !== "string"
  ) {
    return null;
  }
  const action = rec.action as Record<string, unknown> | null;
  if (!action || typeof action !== "object" || typeof action.kind !== "string") return null;
  if (!Array.isArray(rec.subjects) || rec.subjects.some((s) => typeof s !== "string")) return null;
  return { partition: v.partition, record: rec as unknown as AuditRecord };
}

export { GUEST_CUSTOMER_ID, OPERATOR_CUSTOMER_ID };
