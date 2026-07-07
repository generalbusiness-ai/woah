/**
 * ScopeStore — durability for the sequencer (Plan 002 Phase 3 step 1;
 * coherence.md CO5 copy #1: the scope authority, including the
 * parked-task/scheduled queue and the bounded recovery tail).
 *
 * The interface is SYNCHRONOUS by design: the production backing store is
 * DO SQLite, whose primitives are sync — the same contract rule as
 * `ObjectRepository` (src/core/repository.ts): cross-host awaits happen
 * above the storage interface, never inside it.
 *
 * Persistence model (fixed in notes/2026-07-06-net-phase3-kickoff.md):
 * the sequencer stays in-memory and WRITES THROUGH — after each accepted
 * submit (touched cells + head + reply + tail in one transaction), on
 * terminal-rejection reply recording, on seed, and on schedule/cancel/
 * dueTurns. A cold host hydrates a fresh ScopeSequencer entirely from the
 * store. There is no lazy partial hydration in Phase 3 (scopes are
 * room-sized; CA12.1 cell-keyed splitting is the deferred scale lever).
 */
import type { Cell } from "./cells";
import type { RelationRow } from "./relations";
import type { CommitReply, ScheduledTurn, ScopeHead } from "./scope";

export type ScopeMeta = {
  scope: string;
  catalog_epoch: string;
  head: ScopeHead;
};

export type TailEntry = {
  seq: number;
  transcript_hash: string;
  touched: string[];
};

/**
 * The five row families of a scope's durable state. Implementations must
 * make `transaction` atomic (all-or-nothing) so a crash between the
 * commit reply and the fanout drain can never leave head/cells/reply
 * disagreeing — that atomicity is what makes idempotent replay after
 * rehydration sound (CO2.5).
 */
export interface ScopeStore {
  /** Run `fn` atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T;

  readMeta(): ScopeMeta | null;
  writeMeta(meta: ScopeMeta): void;

  readCells(): Cell[];
  writeCell(cell: Cell): void;
  deleteCell(key: string): void;

  readReplies(): Array<{ key: string; reply: CommitReply }>;
  writeReply(key: string, reply: CommitReply): void;
  /** H2a: the reply cache is BOUNDED (see ScopeSequencer's prune rule);
   * pruned keys are deleted here in the same transaction as the commit
   * that pruned them, keeping memory and durable rows in lockstep. */
  deleteReply(key: string): void;

  readTail(): TailEntry[];
  appendTail(entry: TailEntry): void;
  /** Drop oldest entries beyond `limit` (the CO5 bounded recovery log). */
  trimTail(limit: number): void;

  readScheduled(): ScheduledTurn[];
  writeScheduled(turn: ScheduledTurn): void;
  deleteScheduled(id: string): void;

  /** Sixth row family (CO13): derived relation rows owned by this scope,
   * keyed by relationKey(relation, owner, member). Derived — always
   * rebuildable from authority cells — but persisted so hydration does
   * not pay a rebuild on every cold start. */
  readRelations(): RelationRow[];
  writeRelation(key: string, row: RelationRow): void;
  deleteRelation(key: string): void;
}

/** Reference implementation for tests and the in-process host. The
 * "transaction" is trivially atomic because everything is synchronous
 * single-threaded mutation; the SQLite implementation (NetScopeDO) maps
 * these to real statements inside `transactionSync`. */
export class InMemoryScopeStore implements ScopeStore {
  private meta: ScopeMeta | null = null;
  private readonly cells = new Map<string, Cell>();
  private readonly replies = new Map<string, CommitReply>();
  private tail: TailEntry[] = [];
  private readonly scheduled = new Map<string, ScheduledTurn>();
  private readonly relations = new Map<string, RelationRow>();

  transaction<T>(fn: () => T): T {
    return fn();
  }

  readMeta(): ScopeMeta | null {
    return this.meta ? structuredClone(this.meta) : null;
  }

  writeMeta(meta: ScopeMeta): void {
    this.meta = structuredClone(meta);
  }

  readCells(): Cell[] {
    return [...this.cells.values()].map((cell) => structuredClone(cell));
  }

  writeCell(cell: Cell): void {
    this.cells.set(cell.key, structuredClone(cell));
  }

  deleteCell(key: string): void {
    this.cells.delete(key);
  }

  readReplies(): Array<{ key: string; reply: CommitReply }> {
    return [...this.replies.entries()].map(([key, reply]) => ({ key, reply: structuredClone(reply) }));
  }

  writeReply(key: string, reply: CommitReply): void {
    this.replies.set(key, structuredClone(reply));
  }

  deleteReply(key: string): void {
    this.replies.delete(key);
  }

  readTail(): TailEntry[] {
    return this.tail.map((entry) => structuredClone(entry));
  }

  appendTail(entry: TailEntry): void {
    this.tail.push(structuredClone(entry));
  }

  trimTail(limit: number): void {
    if (this.tail.length > limit) this.tail = this.tail.slice(this.tail.length - limit);
  }

  readScheduled(): ScheduledTurn[] {
    return [...this.scheduled.values()].map((turn) => structuredClone(turn));
  }

  writeScheduled(turn: ScheduledTurn): void {
    this.scheduled.set(turn.id, structuredClone(turn));
  }

  deleteScheduled(id: string): void {
    this.scheduled.delete(id);
  }

  readRelations(): RelationRow[] {
    return [...this.relations.values()].map((row) => structuredClone(row));
  }

  writeRelation(key: string, row: RelationRow): void {
    this.relations.set(key, structuredClone(row));
  }

  deleteRelation(key: string): void {
    this.relations.delete(key);
  }
}
