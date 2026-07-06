/**
 * ScopeSequencer — the authority (coherence.md CO1 SCOPE role, CO2.3/2.4/
 * 2.5/2.8, CO4).
 *
 * One sequencer per commit scope: it owns the scope's authority cells
 * (copy #1 of the CO5 registry), orders accepted transcripts, validates in
 * the CO4 order, and re-derives post-state by applying recorded writes to
 * a clone — never by re-executing bytecode.
 *
 * Verdicts vs taxonomy: a rejection is a *reply* with a VTN8-style verdict
 * reason plus a retryable flag; the NetError taxonomy (CO6) is what the
 * layer *throws/surfaces*. The gateway maps retryable verdicts onto its
 * repair actions (refetch head, acquire closure, re-plan) and only
 * surfaces terminal codes to callers.
 *
 * Phase-2 scope notes (see notes/2026-07-05-net-phase2-kickoff.md):
 * - `authorize` and `writeAuthority` are injectable hooks; the real
 *   session/actor authority wiring arrives with plan.ts + Phase-3 hosts.
 * - Read validation is version-string equality against the authority
 *   store. Recorded v2 engine versions and net content-address versions
 *   meet in plan.ts (step 8), which records net versions when planning
 *   against a CellStore view.
 * - Scheduled turns / parked tasks (CO2.8) are a durable pending queue
 *   here with `nextAlarmAt()`; the Host alarm wiring lands in step 5.
 */
import { CellStore, type Cell, type EpochStamp } from "./cells";
import { netError } from "./errors";
import type { ScopeStore } from "./scope-store";
import { applyTranscript, netCellKeyFor, type EffectTranscript, type TranscriptCell } from "./transcript";
import { cellVersion } from "./cells";

export type ScopeHead = {
  seq: number;
  /** Rolling digest: hash(prev.hash, seq, transcript.hash). */
  hash: string;
};

export type CommitSubmit = {
  kind: "woo.net.commit_submit.v1";
  scope: string;
  /** The head the transcript was planned against. */
  base: ScopeHead;
  /** Caller-stable idempotency key: a replay returns the recorded reply. */
  idempotency_key: string;
  transcript: EffectTranscript;
  /** The planner's post-state digest (postStateVersion over touched cells);
   * the scope re-derives and compares (CO4 step 10). */
  post_state_version: string;
  stamp: EpochStamp;
};

export type RejectReason =
  | "unauthorized"        // step 1
  | "scope_mismatch"      // step 2/4
  | "stale_epoch"         // step 2
  | "stale_head"          // base behind current head
  | "incomplete_transcript" // step 4 — never short-circuited
  | "read_version_mismatch" // step 7
  | "write_unauthorized"  // step 9
  | "post_state_mismatch"; // step 10

const RETRYABLE_VERDICTS: ReadonlySet<RejectReason> = new Set([
  "stale_epoch",
  "stale_head",
  "read_version_mismatch",
  "post_state_mismatch"
]);

export type CommitReply =
  | {
      kind: "woo.net.commit_reply.v1";
      status: "accepted";
      scope: string;
      head: ScopeHead;
      /** Authority cells touched, for warm cache-fill (CO7 state transfer). */
      touched: string[];
      post_state_version: string;
    }
  | {
      kind: "woo.net.commit_reply.v1";
      status: "rejected";
      scope: string;
      reason: RejectReason;
      retryable: boolean;
      head: ScopeHead;
      /** Structured repair input: the cells whose reads mismatched, so the
       * gateway refreshes exactly those instead of grinding the budget. */
      mismatched_reads?: TranscriptCell[];
      detail?: Record<string, unknown>;
    };

export type ScheduledTurn = {
  id: string;
  at_logical_time: number;
  call: { actor: string; target: string; verb: string; args: unknown[] };
};

export type ScopeSequencerOptions = {
  /** Step 1: envelope/actor/session authority. Default accepts (in-process
   * trust); Phase-3 hosts inject the real check. Throw NetError to refuse. */
  authorize?: (submit: CommitSubmit) => void;
  /** Step 9: per-write authority. Default requires each authority-cell
   * write to name its recording VM frame (`writer`), per CO3: never the
   * union of verb owners. */
  writeAuthorized?: (submit: CommitSubmit) => boolean;
  /** Cell ownership for multi-scope topologies. A scope can only attest
   * (CO2.4) the cells it is the authority for; when provided, step 7
   * skips reads of foreign-anchored cells — their freshness is the
   * gateway's cross-scope repair concern at the owning scope (Phase 3).
   * WRITES are never filtered: a CA3 rider write to a foreign-anchored
   * cell rides along atomically at this scope by design. Single-scope
   * deployments omit this and validate every read. */
  owns?: (object: string) => boolean;
  /** Bounded recovery tail length (the scope's own log — CO5 note). */
  tailLimit?: number;
  /** Durability (Phase 3): when provided, the sequencer hydrates from the
   * store at construction and writes through on every state change (CO5
   * copy #1). Without it, behavior is identical to the in-memory Phase-2
   * sequencer. Type-only import: no runtime cycle with scope-store. */
  durable?: ScopeStore;
};

export class ScopeSequencer {
  readonly scope: string;
  readonly catalogEpoch: string;
  readonly store: CellStore;
  private headState: ScopeHead;
  private readonly replies = new Map<string, CommitReply>();
  private readonly tail: Array<{ seq: number; transcript_hash: string; touched: string[] }> = [];
  private readonly scheduled = new Map<string, ScheduledTurn>();
  private readonly options: Required<Pick<ScopeSequencerOptions, "tailLimit">> & ScopeSequencerOptions;

  constructor(scope: string, catalogEpoch: string, options: ScopeSequencerOptions = {}) {
    this.scope = scope;
    this.catalogEpoch = catalogEpoch;
    this.store = new CellStore("authority");
    this.headState = { seq: 0, hash: cellVersion(["genesis", scope]) };
    this.options = { tailLimit: options.tailLimit ?? 256, ...options };

    // Hydrate from the durable store (cold start / post-eviction). The
    // store is the truth for everything the sequencer holds in memory.
    // Meta may legitimately be absent (a scope that has only scheduled
    // turns, never a seed or commit) — validate it when present, but load
    // every row family unconditionally.
    const durable = this.options.durable;
    if (durable) {
      const meta = durable.readMeta();
      if (meta) {
        if (meta.scope !== scope) {
          // Wrong storage wired to this sequencer — deployment bug, not
          // divergence; refuse loudly rather than adopt foreign state.
          throw new Error(`scope-store hydration mismatch: store is for ${meta.scope}, sequencer is ${scope}`);
        }
        if (meta.catalog_epoch !== catalogEpoch) {
          // A catalog upgrade over durable scope state is an explicit
          // migration concern (aged-world lane, Phase 3 step 5) — not a
          // silent adoption. Refuse until that path exists.
          throw new Error(`scope-store epoch mismatch: store ${meta.catalog_epoch}, runtime ${catalogEpoch}`);
        }
        this.headState = meta.head;
      }
      for (const cell of durable.readCells()) this.store.install(cell);
      for (const { key, reply } of durable.readReplies()) this.replies.set(key, reply);
      for (const entry of durable.readTail()) this.tail.push(entry);
      for (const turn of durable.readScheduled()) this.scheduled.set(turn.id, turn);
    }
  }

  head(): ScopeHead {
    return this.headState;
  }

  stamp(): EpochStamp {
    return { scope_head: `${this.headState.seq}:${this.headState.hash}`, catalog_epoch: this.catalogEpoch };
  }

  /** Seed authoritative cells outside a turn (bootstrap/install path). */
  seed(cells: Array<Pick<Cell, "kind" | "object" | "name" | "value">>): void {
    const seeded: Cell[] = [];
    for (const cell of cells) {
      seeded.push(this.store.commit({ kind: cell.kind, object: cell.object, ...(cell.name !== undefined ? { name: cell.name } : {}), value: cell.value, stamp: this.stamp() }));
    }
    const durable = this.options.durable;
    if (durable) {
      durable.transaction(() => {
        for (const cell of seeded) durable.writeCell(cell);
        // Meta is written on seed too, so a seeded-but-never-committed
        // scope still hydrates with its head and epoch.
        durable.writeMeta({ scope: this.scope, catalog_epoch: this.catalogEpoch, head: this.headState });
      });
    }
  }

  /**
   * CO4 validation order. Steps 1–9 are pre-state-only; the doomed-round
   * short-circuit is honored implicitly by ordering (stale head / scope /
   * unauthorized / read-version reject before the apply). Completeness
   * (step 4) is checked before any short-circuitable step so an
   * incomplete transcript is never relabelled (CO4 clarification).
   */
  submit(submit: CommitSubmit): CommitReply {
    // Step 3 first for replays: an idempotent resubmit must return the
    // recorded reply even if the world moved on (CO2.5).
    const recorded = this.replies.get(submit.idempotency_key);
    if (recorded) return recorded;

    // Step 1: envelope/actor/session authority.
    try {
      this.options.authorize?.(submit);
    } catch (err) {
      return this.reject(submit, "unauthorized", { error: String(err) });
    }

    // Step 2: scope and epoch.
    if (submit.scope !== this.scope || submit.transcript.scope !== this.scope) {
      return this.reject(submit, "scope_mismatch", { submitted: submit.scope, transcript: submit.transcript.scope });
    }
    if (submit.stamp.catalog_epoch !== this.catalogEpoch) {
      return this.reject(submit, "stale_epoch", { submitted: submit.stamp.catalog_epoch, current: this.catalogEpoch });
    }

    // Step 4: completeness — never short-circuited or relabelled.
    if (!submit.transcript.complete) {
      return this.reject(submit, "incomplete_transcript", { reasons: submit.transcript.incompleteReasons });
    }

    // Head freshness: a transcript planned against an older head must
    // re-plan (the gateway treats this as E_STALE_HEAD repair).
    if (submit.base.seq !== this.headState.seq || submit.base.hash !== this.headState.hash) {
      return this.reject(submit, "stale_head", { base: submit.base, head: this.headState });
    }

    // Step 7: read versions against current authority cells. A cell read
    // more than once in the turn is named ONCE in the repair input — the
    // gateway refreshes cells, not read events.
    const mismatched = new Map<string, TranscriptCell>();
    for (const read of submit.transcript.reads) {
      if (read.version === undefined) continue; // negative/probe read
      const key = netCellKeyFor(read.cell);
      if (key === null) continue; // contents reads are projection reads (CA4)
      // Foreign-anchored reads are not attestable here (see options.owns).
      if (this.options.owns && !this.options.owns(read.cell.object)) continue;
      const current = this.store.get(key)?.version ?? "absent";
      if (current !== String(read.version)) mismatched.set(key, read.cell);
    }
    if (mismatched.size > 0) {
      return this.reject(submit, "read_version_mismatch", {}, [...mismatched.values()]);
    }

    // Step 9: per-write authority (recorded VM frame, never owner union).
    const writesAuthorized = this.options.writeAuthorized
      ? this.options.writeAuthorized(submit)
      : submit.transcript.writes.every((write) => netCellKeyFor(write.cell) === null || write.writer !== undefined);
    if (!writesAuthorized) {
      return this.reject(submit, "write_unauthorized", {});
    }

    // The head this acceptance WILL have is computable before the apply
    // (rolling digest over prior hash + next seq + transcript hash), so
    // applied cells are stamped with the actual `(scope_head,
    // catalog_epoch)` per CO8 — one computation, adopted below on accept.
    // The stamp never affects step-10 parity: postStateVersion digests
    // cell VALUES only, so the planner (stamping with its own view's
    // epoch) derives the same digest.
    const nextHead: ScopeHead = {
      seq: this.headState.seq + 1,
      hash: cellVersion([this.headState.hash, this.headState.seq + 1, submit.transcript.hash])
    };
    const nextStamp: EpochStamp = { scope_head: `${nextHead.seq}:${nextHead.hash}`, catalog_epoch: this.catalogEpoch };

    // Step 10: re-derive post-state on a clone and compare digests.
    const applied = applyTranscript(this.store, submit.transcript, nextStamp);
    if (applied.postStateVersion !== submit.post_state_version) {
      return this.reject(submit, "post_state_mismatch", {
        derived: applied.postStateVersion,
        submitted: submit.post_state_version
      });
    }

    // Accept: adopt the applied clone as authority, advance head, record
    // the tail entry and the reply (step 11).
    for (const key of applied.touched) {
      const cell = applied.post.get(key);
      if (cell) this.store.install(cell);
      else this.store.delete(key);
    }
    this.headState = nextHead;
    const tailEntry = { seq: nextHead.seq, transcript_hash: submit.transcript.hash, touched: applied.touched };
    this.tail.push(tailEntry);
    if (this.tail.length > this.options.tailLimit) this.tail.splice(0, this.tail.length - this.options.tailLimit);

    const reply: CommitReply = {
      kind: "woo.net.commit_reply.v1",
      status: "accepted",
      scope: this.scope,
      head: this.headState,
      touched: applied.touched,
      post_state_version: applied.postStateVersion
    };
    this.replies.set(submit.idempotency_key, reply);

    // Write-through (CO5 copy #1): one atomic transaction covering cells,
    // head, reply, and tail — a crash between the reply and the fanout
    // drain can never leave them disagreeing, which is what makes
    // idempotent replay after rehydration sound (CO2.5).
    const durable = this.options.durable;
    if (durable) {
      durable.transaction(() => {
        for (const key of applied.touched) {
          const cell = this.store.get(key);
          if (cell) durable.writeCell(cell);
          else durable.deleteCell(key);
        }
        durable.writeMeta({ scope: this.scope, catalog_epoch: this.catalogEpoch, head: this.headState });
        durable.writeReply(submit.idempotency_key, reply);
        durable.appendTail(tailEntry);
        durable.trimTail(this.options.tailLimit);
      });
    }
    return reply;
  }

  /** The scope's bounded recovery log (CO5: read by the scope alone). */
  recoveryTail(): ReadonlyArray<{ seq: number; transcript_hash: string; touched: string[] }> {
    return this.tail;
  }

  // ---- Durable continuations (CO2.8) ----------------------------------

  /** Enqueue a scheduled turn; validated exactly like a live submission
   * when it fires (the firing path goes back through submit()). */
  schedule(turn: ScheduledTurn, nowLogical: number): void {
    if (turn.at_logical_time <= nowLogical) {
      throw netError("E_MISSING_STATE", "scheduled turn must target a future logical time", { id: turn.id, at: turn.at_logical_time, now: nowLogical });
    }
    this.scheduled.set(turn.id, turn);
    this.options.durable?.writeScheduled(turn);
  }

  cancel(scheduleId: string): boolean {
    const removed = this.scheduled.delete(scheduleId);
    if (removed) this.options.durable?.deleteScheduled(scheduleId);
    return removed;
  }

  /** Earliest pending logical time, or null — the Host sets its alarm to
   * this (CO2.8: the scope wakes itself; a parked task survives eviction
   * because the queue is scope state). */
  nextAlarmAt(): number | null {
    let min: number | null = null;
    for (const turn of this.scheduled.values()) {
      if (min === null || turn.at_logical_time < min) min = turn.at_logical_time;
    }
    return min;
  }

  /** Non-consuming view of the turns due at or before `nowLogical`, in
   * firing order (fix 8a). The Phase-3 shell OBSERVES due turns at alarm
   * time but cannot yet execute them (the turn executor arrives with
   * Phase 3.5); peeking leaves the rows parked instead of destructively
   * popping work that would then be lost (CO2.8). `dueTurns` remains the
   * consuming form for the executor that actually runs the turns. */
  peekDue(nowLogical: number): ScheduledTurn[] {
    return [...this.scheduled.values()]
      .filter((turn) => turn.at_logical_time <= nowLogical)
      .sort((a, b) => a.at_logical_time - b.at_logical_time || a.id.localeCompare(b.id));
  }

  /** Pop every turn due at or before `nowLogical`, in time order. */
  dueTurns(nowLogical: number): ScheduledTurn[] {
    const due = this.peekDue(nowLogical);
    const durable = this.options.durable;
    const pop = () => {
      for (const turn of due) {
        this.scheduled.delete(turn.id);
        durable?.deleteScheduled(turn.id);
      }
    };
    if (durable) durable.transaction(pop);
    else pop();
    return due;
  }

  private reject(submit: CommitSubmit, reason: RejectReason, detail: Record<string, unknown>, mismatched?: TranscriptCell[]): CommitReply {
    const reply: CommitReply = {
      kind: "woo.net.commit_reply.v1",
      status: "rejected",
      scope: this.scope,
      reason,
      retryable: RETRYABLE_VERDICTS.has(reason),
      head: this.headState,
      ...(mismatched && mismatched.length > 0 ? { mismatched_reads: mismatched } : {}),
      ...(Object.keys(detail).length > 0 ? { detail } : {})
    };
    // Terminal rejections are idempotency-recorded so replays cannot flap
    // between verdicts; retryable ones are not, because the entire point
    // of a retry is a fresh validation against repaired state. The same
    // rule holds durably: only recorded replies are persisted.
    if (!RETRYABLE_VERDICTS.has(reason)) {
      this.replies.set(submit.idempotency_key, reply);
      this.options.durable?.writeReply(submit.idempotency_key, reply);
    }
    return reply;
  }
}
