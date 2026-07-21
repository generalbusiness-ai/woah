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
import { validateSessionCell } from "./sessions";
import { applyRelationDeltas, deriveRelationDeltas, rebuildContentsRelation, relationKey, SESSION_PRESENCE_RELATION, type RelationDelta, type RelationRow } from "./relations";
import {
  ORDERED_EDGE_RELATION,
  orderedChildrenForContainer,
  orderedChildrenVersion,
  orderedProjectionKey,
  type OrderedChildRow
} from "./ordered-edges";
import {
  customerOfCellKey,
  normalizeCustomerAttribution,
  normalizePrincipal,
  type Principal,
  type ScopeAttribution
} from "./attribution";
import type { TraceContext } from "./trace";
import type { ScopeMeta, ScopeStore, TailEntry } from "./scope-store";
import { applyTranscript, netCellKeyFor, type EffectTranscript, type TranscriptCell } from "./transcript";
import { cellKey, cellVersion } from "./cells";

export type ScopeHead = {
  seq: number;
  /** Rolling digest: hash(prev.hash, seq, transcript.hash). */
  hash: string;
};

export type OperatorDefinitionRepair = {
  status: "applied" | "empty";
  head: ScopeHead;
  cells: Cell[];
  removed: string[];
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
  /** CO2.3 rider integrity (rule 1): owner attestations for the
   * transcript's FOREIGN-anchored reads, keyed by owning scope. The
   * gateway fetches these at plan time (`POST /net/attest` — one async
   * RPC per owner, off the validation path); the committing scope
   * validates each rider read against the attested version instead of
   * skipping it. Only consulted when `owns` is wired (multi-scope
   * topologies); single-scope sequencers validate every read locally
   * and ignore this field. */
  attestations?: Record<string, {
    owner_head: ScopeHead;
    cells: Array<{ key: string; version: string }>;
    /** R3: the owner's CURRENT ordering version per attested parent, taken
     * at the same /net/attest freshness point as the cell versions, so a
     * foreign ordering read validates exactly like a foreign cell read. */
    orderings?: Array<{ container: string; parent: string | null; version: string }>;
  }>;
};

export type RejectReason =
  | "unauthorized"        // step 1
  | "scope_mismatch"      // step 2/4
  | "stale_epoch"         // step 2
  | "stale_head"          // base behind current head
  | "incomplete_transcript" // step 4 — never short-circuited
  | "read_version_mismatch" // step 7
  | "rider_unattested"    // step 7 — foreign read with no owner attestation (CO2.3); terminal
  | "catalog_mutation"    // step 5 — epoch-immutable definition write without an epoch transition
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
      /** CO13: the LOCAL relation deltas this commit derived and applied
       * to the scope's own relation family — the shell includes them in
       * FanoutBody.relations so subscriber gateways mirror rosters
       * push-fashion (never a second derivation at the receiver). */
      relations?: RelationDelta[];
      /** CO13: relation deltas whose owner is anchored to ANOTHER scope —
       * the shell delivers them to the owning scope via the durable
       * outbox (/net/relate). Local deltas were already applied here. */
      relations_foreign?: Array<{ scope: string; deltas: RelationDelta[] }>;
      /** CO2.5: set only when this reply is a RECORDED reply returned to an
       * idempotent resubmit — this round committed nothing. The gateway
       * MUST NOT present a freshly-planned result/observations as the
       * committed output when this is true (they would describe an
       * execution that never happened — acute for now()/random() turns).
       * Stamped on a copy at return time; the cached reply never carries
       * it, so replay-of-a-replay stays stable. */
      replayed?: boolean;
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
  /** AU3.2: attribution captured at SCHEDULE time, so the session-less
   * scheduled turn stays attributable when it eventually runs. This is
   * attribution only — CO16's deferred engine-side authority field is a
   * separate concern, and the captured principal never widens authority
   * (the turn still runs as an actor-authority direct-route turn). */
  principal?: Principal;
  /** AU2: the scheduling turn's trace context, carried in the durable
   * row so the eventual dispatch joins the originating trace. */
  trace?: TraceContext;
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
   * validates reads of foreign-anchored cells against the submit's
   * owner `attestations` (CO2.3 rider integrity) — matching versions
   * pass, differing versions reject `read_version_mismatch`, and a
   * foreign read with no covering attestation rejects terminal
   * `rider_unattested`. WRITES are never filtered: a CA3 rider write to
   * a foreign-anchored cell rides along atomically at this scope by
   * design. Single-scope deployments omit this and validate every read
   * locally (attestations are ignored). */
  owns?: (object: string) => boolean;
  /** CO13: the anchor-derived scope of an object (topology.ts). Used to
   * partition derived relation deltas into local rows vs rows owned by
   * another scope. Absent → every delta is local (single-scope). */
  scopeOf?: (object: string) => string;
  /** CO15 authority enforcement. The shell classifies direct catalog commits and
   * catalog-bound riders before submit. Ordinary submits have no epoch-
   * transition operation, so lifecycle/property/verb writes to those objects
   * refuse terminally; the catalog install/upgrade path changes definitions
   * outside ordinary submit while publishing a new epoch. */
  catalogMutationForbidden?: (object: string) => boolean;
  /** Bounded recovery tail length (the scope's own log — CO5 note). */
  tailLimit?: number;
  /** H2a: reply-cache bound — the TOTAL number of recorded replies the
   * cache holds (default REPLY_CACHE_CAP). Within-window replies (still
   * covered by the recovery tail) are never pruned but DO count toward
   * this cap, so the number retained beyond the window is this cap minus
   * the in-window count, not this cap itself. See pruneReplies. */
  replyLimit?: number;
  /** Durability (Phase 3): when provided, the sequencer hydrates from the
   * store at construction and writes through on every state change (CO5
   * copy #1). Without it, behavior is identical to the in-memory Phase-2
   * sequencer. Type-only import: no runtime cycle with scope-store. */
  durable?: ScopeStore;
};

/** H2a default: the TOTAL reply-cache cap. Sized so a busy scope's recent
 * idempotent retries always replay, while the table stops growing one row
 * per turn forever. The recovery-tail window is never pruned, so the count
 * retained BEYOND the window is this cap minus the in-window replies. */
export const REPLY_CACHE_CAP = 1024;

export class ScopeSequencer {
  readonly scope: string;
  readonly catalogEpoch: string;
  readonly store: CellStore;
  private headState: ScopeHead;
  /** Lazily derived next-object allocation counter (client-shell phase i:
   * creates over net). Null = derive from the store on next read; an
   * accepted create advances it. See objectCounter(). */
  private nextObjectCounter: number | null = null;
  private readonly replies = new Map<string, CommitReply>();
  private readonly tail: TailEntry[] = [];
  /** AU3.3 scope attribution, hydrated from meta and stamped at seed.
   * Held here so every meta rewrite (commit, adopt, schedule) carries it
   * forward — a fresh {scope, epoch, head} row must never drop it. */
  private attribution: ScopeAttribution | null = null;
  private readonly scheduled = new Map<string, ScheduledTurn>();
  private readonly relationRows = new Map<string, RelationRow>();
  /** CO13 ordered-edge relation buckets, maintained in (rank, child) order
   * when rows change. Relation rows are keyed by member, so the reverse map
   * lets an overwrite/reparent remove the old bucket entry before adding the
   * new one. Reads therefore touch only one parent width, never every relation
   * in a room scope. */
  private readonly orderedRelationsByProjection = new Map<string, OrderedChildRow[]>();
  private readonly orderedRelationLocationByKey = new Map<string, { projection: string; child: string; rank: string }>();
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
          // DECIDED (ready-to-scale Phase 5): REFUSE, never reseed. The
          // durable store is the authority — silently adopting the
          // runtime's epoch (or wiping authority state to "reseed" it)
          // would destroy the one authoritative copy over a config skew.
          // A catalog upgrade over durable scope state is an explicit
          // migration concern (CT14 / spec-version walk); until that path
          // exists this surfaces as the M9 terminal code so operators see
          // a named epoch disagreement, not a 500.
          throw netError("E_EPOCH_MISMATCH", "scope-store epoch disagrees with the runtime's catalog epoch", {
            scope,
            store_epoch: meta.catalog_epoch,
            runtime_epoch: catalogEpoch
          });
        }
        this.headState = meta.head;
        this.attribution = meta.attribution ?? null;
      }
      for (const cell of durable.readCells()) this.store.install(cell);
      for (const { key, reply } of durable.readReplies()) this.replies.set(key, reply);
      for (const entry of durable.readTail()) this.tail.push(entry);
      // The scheduled family deliberately does NOT hydrate (review #1):
      // a parked queue can outnumber a scope's live cells without bound,
      // and every consumer question is a due-time question the store
      // answers off its due index (peekDue/dueTurns/nextAlarmAt
      // delegate). The in-memory map serves only durable-less
      // sequencers.
      for (const row of durable.readRelations()) this.relationRows.set(relationKey(row.relation, row.owner, row.member), row);
      this.syncOrderedRelationIndex(this.relationRows.keys());
    }
  }

  head(): ScopeHead {
    return this.headState;
  }

  /**
   * The next-object allocation counter this authority's state implies
   * (client-shell phase i: creates over net). The engine allocates
   * `obj_<scope>_<n>` and SKIPS ids present in its world — but a sliced
   * planning world only sees the slice, so the planner must START from a
   * counter that is ≥ every id this authority has ever allocated, or a
   * non-resident id could be re-minted and silently overwrite. Derived
   * lazily from the store's lineage keys (numeric id suffixes), advanced
   * by accepted creates; recycled ids may be re-used after a rehydrate —
   * the same semantics as the engine's own has()-skip allocator. Served
   * on /net/head so the gateway threads it into planning.
   */
  objectCounter(): number {
    if (this.nextObjectCounter === null) {
      let max = 0;
      for (const key of this.store.keys()) {
        if (!key.startsWith("object_lineage:obj_")) continue;
        const match = /_(\d+)$/.exec(key);
        if (match) max = Math.max(max, Number(match[1]));
      }
      this.nextObjectCounter = max + 1;
    }
    return this.nextObjectCounter;
  }

  stamp(): EpochStamp {
    return { scope_head: `${this.headState.seq}:${this.headState.hash}`, catalog_epoch: this.catalogEpoch };
  }

  /** Seed authoritative cells outside a turn (bootstrap/install path).
   *
   * Reviewer finding 1 (destructive reseed): a seed may only land on a
   * scope with NO committed turns. Same-epoch re-seed of a PRE-TRAFFIC
   * scope stays the documented crash-recovery story (install cells
   * overwriting install cells at head.seq 0); once ANY turn has
   * committed, a re-seed would silently reset authoritative state under
   * an unchanged head — invisible to every version check — so it
   * refuses terminally. Activation-state changes ride the dedicated
   * operator op (operatorActivationWrite), never a seed. */
  /** The complete durable meta row. Centralized so no write site can
   * construct a partial row that drops the stamped attribution. */
  private metaRow(): ScopeMeta {
    return {
      scope: this.scope,
      catalog_epoch: this.catalogEpoch,
      head: this.headState,
      ...(this.attribution !== null ? { attribution: this.attribution } : {})
    };
  }

  /** AU3.3: the stamped owning customer of this scope's anchor, or null
   * when unstamped (pre-attribution seeds; record minting attributes
   * unstamped scopes to the operator and flags them). */
  scopeAttribution(): ScopeAttribution | null {
    return this.attribution;
  }

  seed(
    cells: Array<Pick<Cell, "kind" | "object" | "name" | "value">>,
    relations?: RelationRow[],
    attribution?: ScopeAttribution
  ): void {
    if (this.headState.seq > 0) {
      throw netError("E_SEED_COMMITTED", "scope has committed turns; a re-seed would reset authoritative state", {
        scope: this.scope,
        head_seq: this.headState.seq
      });
    }
    this.nextObjectCounter = null; // re-derive over the seeded store
    // Same-epoch idempotent re-seed may re-stamp (same pipeline, same
    // value); an omitted field on a re-seed preserves the prior stamp
    // (legacy-caller posture, mirroring the relations rule below).
    if (attribution !== undefined) this.attribution = attribution;
    const seeded: Cell[] = [];
    for (const cell of cells) {
      seeded.push(this.store.commit({ kind: cell.kind, object: cell.object, ...(cell.name !== undefined ? { name: cell.name } : {}), value: cell.value, stamp: this.stamp() }));
    }
    // A present relation field is the COMPLETE initial family and replaces a
    // partial first attempt. Legacy seed callers omitted the field entirely;
    // omission must preserve their already-seeded rows, not silently mean an
    // explicit empty family on a same-epoch retry.
    if (relations !== undefined) {
      this.relationRows.clear();
      this.orderedRelationsByProjection.clear();
      this.orderedRelationLocationByKey.clear();
      for (const row of relations) this.relationRows.set(relationKey(row.relation, row.owner, row.member), row);
      this.syncOrderedRelationIndex(this.relationRows.keys());
    }
    const durable = this.options.durable;
    if (durable) {
      durable.transaction(() => {
        for (const cell of seeded) durable.writeCell(cell);
        if (relations !== undefined) {
          for (const row of durable.readRelations()) durable.deleteRelation(relationKey(row.relation, row.owner, row.member));
          for (const [key, row] of this.relationRows) durable.writeRelation(key, row);
        }
        // Meta is written on seed too, so a seeded-but-never-committed
        // scope still hydrates with its head and epoch.
        durable.writeMeta(this.metaRow());
      });
    }
  }

  /**
   * The activation state-machine write (spec/operations/net-cutover.md
   * NC1; reviewer finding 1's "dedicated operation"): sets the ONE
   * activation cell — never a general seed, so it stays legal after the
   * scope has committed turns (deactivation happens post-verification,
   * which is post-mint on the carried actor's cluster... and epoch
   * bumps at the CATALOG scope, whose head never advances by client
   * turns). Durable like a seed write; the head is untouched (the cell's
   * own content-address version is what consumers check).
   */
  operatorActivationWrite(activeEpoch: string | null): void {
    const committed = this.store.commit({
      kind: "property_cell",
      object: "$system",
      name: "net_active_epoch",
      value: { value: activeEpoch },
      stamp: this.stamp()
    });
    const durable = this.options.durable;
    if (durable) {
      durable.transaction(() => {
        durable.writeCell(committed);
        durable.writeMeta(this.metaRow());
      });
    }
  }

  /** Signed operator migration for already-installed bootstrap definition
   * pages. Ordinary turns may never mutate catalog definitions (CO15); this
   * explicit path advances the catalog owner head, stamps the replacement
   * pages authoritatively, and records a tail entry so fanout/catch-up observe
   * one ordered migration event. The Worker shell restricts inputs to bundled
   * `$`-object verb/property definition pages before calling this method. */
  operatorRepairDefinitions(
    cells: Array<Pick<Cell, "kind" | "object" | "name" | "value">>,
    removals: Array<Pick<Cell, "kind" | "object" | "name">> = []
  ): OperatorDefinitionRepair {
    const changed = cells.filter((cell) => {
      const existing = this.store.get(cellKey(cell.kind, cell.object, cell.name));
      return existing?.version !== cellVersion(cell.value);
    });
    const removed = removals
      .map((cell) => cellKey(cell.kind, cell.object, cell.name))
      .filter((key) => this.store.has(key));
    if (changed.length === 0 && removed.length === 0) {
      return { status: "empty", head: this.headState, cells: [], removed: [] };
    }

    const marker = `operator_definition_repair:${cellVersion({
      replacements: changed.map((cell) => [cell.kind, cell.object, cell.name ?? null, cell.value]),
      removals: removed
    })}`;
    const priorHead = this.headState;
    const nextHead: ScopeHead = {
      seq: priorHead.seq + 1,
      hash: cellVersion([priorHead.hash, priorHead.seq + 1, marker])
    };
    const nextStamp: EpochStamp = { scope_head: `${nextHead.seq}:${nextHead.hash}`, catalog_epoch: this.catalogEpoch };
    const committed = changed.map((cell) => this.store.commit({
      kind: cell.kind,
      object: cell.object,
      ...(cell.name !== undefined ? { name: cell.name } : {}),
      value: cell.value,
      stamp: nextStamp
    }));
    for (const key of removed) this.store.delete(key);
    const touched = [...committed.map((cell) => cell.key), ...removed].sort();
    this.headState = nextHead;
    const tailEntry: TailEntry = {
      seq: nextHead.seq,
      transcript_hash: marker,
      touched,
      base_hash: priorHead.hash,
      head_hash: nextHead.hash
    };
    this.tail.push(tailEntry);
    if (this.tail.length > this.options.tailLimit) this.tail.splice(0, this.tail.length - this.options.tailLimit);
    const durable = this.options.durable;
    if (durable) {
      durable.transaction(() => {
        for (const cell of committed) durable.writeCell(cell);
        for (const key of removed) durable.deleteCell(key);
        durable.writeMeta(this.metaRow());
        durable.appendTail(tailEntry);
        durable.trimTail(this.options.tailLimit);
      });
    }
    return { status: "applied", head: this.headState, cells: committed, removed };
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
    // recorded reply even if the world moved on (CO2.5). Return it with
    // `replayed: true` STAMPED ON A COPY (never mutating the cache) so the
    // gateway knows authoritatively that this round committed nothing and
    // must not fabricate output. The stored reply's own `replayed` stays
    // unset, so replay-of-a-replay remains stable.
    const recorded = this.replies.get(submit.idempotency_key);
    if (recorded) return recorded.status === "accepted" ? { ...recorded, replayed: true } : recorded;

    // Step 1: envelope/actor/session authority (CO14: the shell wires
    // authorizeSessionSubmit here). A thrown error carrying a structured
    // `detail` object (SessionAuthError) folds it into the reject reply,
    // so an unauthorized refusal names its verdict (expired / missing /
    // actor_mismatch / session_unattested / session_required) instead of
    // burying it in prose.
    try {
      this.options.authorize?.(submit);
    } catch (err) {
      const structured =
        err && typeof err === "object" && "detail" in err && err.detail && typeof err.detail === "object"
          ? (err.detail as Record<string, unknown>)
          : {};
      return this.reject(submit, "unauthorized", { error: String(err), ...structured });
    }

    // Step 1b (audit.md AU3.2): a carried principal must agree with the
    // transcript it rides. The gateway is the authenticating edge — the
    // scope validates the attestation's internal consistency, and, when
    // it OWNS the actor's customer_of cell (the actor's own cluster),
    // re-validates the customer against durable authority. Both checks
    // fold into the CO14 unauthorized reject with a named verdict.
    const principal = submit.transcript.principal;
    if (principal !== undefined) {
      if (normalizePrincipal(principal) === null) {
        return this.reject(submit, "unauthorized", { principal_verdict: "malformed_principal" });
      }
      // AU3.2: a COMMITTED turn only ever carries the authenticated form.
      // `credentialed`/`anonymous` are gateway edge-record shapes; on a
      // submit they are a stamping bug or a forgery, never acceptable.
      if (principal.attribution !== "authenticated") {
        return this.reject(submit, "unauthorized", {
          principal_verdict: "not_authenticated",
          attribution: principal.attribution
        });
      }
      if (principal.actor !== submit.transcript.call.actor) {
        return this.reject(submit, "unauthorized", {
          principal_verdict: "actor_mismatch",
          principal_actor: principal.actor,
          transcript_actor: submit.transcript.call.actor
        });
      }
      if (principal.actor !== undefined && this.options.owns?.(principal.actor) === true) {
        // The committing scope IS the actor's home: the claimed customer
        // must be durably checkable. An absent cell with a claimed
        // customer is refused — trusting the edge here would let a buggy
        // or compromised gateway invent attribution for an actor whose
        // durable authority holds none. (A turn with NO principal still
        // commits: unattributed is a named gap, not a forgery.)
        const owned = normalizeCustomerAttribution(
          this.store.get(customerOfCellKey(principal.actor))?.value
        );
        if (owned === null) {
          return this.reject(submit, "unauthorized", {
            principal_verdict: "customer_unverifiable",
            principal_customer: principal.customer
          });
        }
        if (owned.customer !== principal.customer) {
          return this.reject(submit, "unauthorized", {
            principal_verdict: "customer_mismatch",
            principal_customer: principal.customer,
            authoritative_customer: owned.customer
          });
        }
      }
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

    // Step 5 / CO15: the durable owner independently enforces the premise
    // behind exact-epoch catalog certificates. This check uses authoritative
    // pre-state through the shell-provided predicate, so a stale or modified
    // gateway cannot bypass it. Ordinary submits cannot carry an epoch bump;
    // catalog installation uses the dedicated seed/upgrade path instead.
    const catalogMutationKeys = new Map<string, string[]>();
    if (this.options.catalogMutationForbidden) {
      for (const write of submit.transcript.writes) {
        if (write.cell.kind !== "lifecycle" && write.cell.kind !== "prop" && write.cell.kind !== "verb") continue;
        if (!this.options.catalogMutationForbidden(write.cell.object)) continue;
        const key = netCellKeyFor(write.cell);
        if (key === null) continue;
        const keys = catalogMutationKeys.get(write.cell.object) ?? [];
        keys.push(key);
        catalogMutationKeys.set(write.cell.object, keys);
      }
    }
    if (catalogMutationKeys.size > 0) {
      const objects = [...catalogMutationKeys.keys()].sort();
      return this.reject(submit, "catalog_mutation", {
        objects,
        keys: objects.flatMap((object) => catalogMutationKeys.get(object) ?? []).sort()
      });
    }

    // CO4 retained-head rebase: exact-current submits proceed as before;
    // a behind base proceeds only when this authority's bounded recovery
    // tail proves the exact (seq, hash) as an ancestor. Current read
    // versions and post-state are still validated below, so independent
    // concurrent turns serialize without retries while true conflicts do
    // not. Old tail rows lack hash proofs by design and fail closed.
    if (!this.baseIsCurrentOrRetained(submit.base)) {
      return this.reject(submit, "stale_head", { base: submit.base, head: this.headState });
    }

    // Step 7: read versions against current authority cells. A cell read
    // more than once in the turn is named ONCE in the repair input — the
    // gateway refreshes cells, not read events.
    //
    // CO2.3 rider integrity (rule 1): when `owns` is wired (multi-scope),
    // a FOREIGN-anchored read is validated against the owner attestation
    // the submit carries — never skipped, never checked against this
    // scope's own store (which cannot attest cells it does not hold).
    // Attested versions are flattened across owner entries: a cell's key
    // is globally unique, so which owner attested it is provenance detail
    // the validation itself does not need.
    const attested = new Map<string, string>();
    for (const entry of Object.values(submit.attestations ?? {})) {
      for (const cell of entry.cells) attested.set(cell.key, cell.version);
    }
    const mismatched = new Map<string, TranscriptCell>();
    // Reads of objects THIS transcript creates validate locally: the
    // owner cannot attest a cell that does not exist there yet, and the
    // planner honestly recorded such reads against pre-create absence —
    // absent == absent below. (The v2 twin of this rule was the
    // sameTurnRead fix; without it every create-then-read turn rejects
    // terminal rider_unattested at a cross-scope commit.)
    const createdHere = new Set((submit.transcript.creates ?? []).map((create) => create.object));
    for (const read of submit.transcript.reads) {
      if (read.version === undefined) continue; // negative/probe read
      const key = netCellKeyFor(read.cell);
      if (key === null) continue; // contents reads are projection reads (CA4)
      if (this.options.owns && !this.options.owns(read.cell.object) && !createdHere.has(read.cell.object)) {
        const attestedVersion = attested.get(key);
        if (attestedVersion === undefined) {
          // A rider read nobody attested is a protocol violation by the
          // submitter (the gateway attests every foreign read at plan
          // time), not a stale-view condition — terminal, named (the
          // pre-amendment behavior silently skipped these reads, which
          // is the CO2.4 gap this closes; notes/2026-07-06-rider-read-
          // integrity.md).
          return this.reject(submit, "rider_unattested", { key });
        }
        // Attested-vs-planned mismatch repairs exactly like an owned
        // stale read: the gateway refreshes the cell (from its owner,
        // via the anchors routing), re-attests, and re-plans.
        if (attestedVersion !== String(read.version)) mismatched.set(key, read.cell);
        continue;
      }
      const current = this.store.get(key)?.version ?? "absent";
      if (current !== String(read.version)) mismatched.set(key, read.cell);
    }
    if (mismatched.size > 0) {
      return this.reject(submit, "read_version_mismatch", {}, [...mismatched.values()]);
    }

    // Step 7b (P1.1): validate ordering projection reads. Each names a
    // parent, the OWNING scope the answer came from, and the authority
    // content `version` the plan read. An entry THIS scope owns re-derives
    // from its current edge cells; a FOREIGN entry validates against the
    // owner's ordering attestation carried by the submit (R3 — the exact
    // mirror of foreign cell reads above: never skipped, never checked
    // against a store that does not hold the edges). This is what
    // serializes concurrent same-parent inserts, in-scope or cross-scope —
    // the ordering is a read the transcript carries, so an insert that
    // landed between plan and submit invalidates the read behind the rank.
    const attestedOrderings = new Map<string, string>();
    for (const [owner, entry] of Object.entries(submit.attestations ?? {})) {
      for (const ordering of entry.orderings ?? []) {
        attestedOrderings.set(`${owner}\0${ordering.container}\0${ordering.parent ?? "\0root"}`, ordering.version);
      }
    }
    const orderingConflicts: Array<{ scope: string; container: string; parent: string | null }> = [];
    for (const read of submit.transcript.orderingReads ?? []) {
      if (read.scope !== this.scope) {
        const attested = attestedOrderings.get(`${read.scope}\0${read.container}\0${read.parent ?? "\0root"}`);
        if (attested === undefined) {
          // A foreign ordering read nobody attested is a protocol violation
          // by the submitter, not a stale-view condition — terminal, named
          // (the pre-R3 behavior silently skipped these reads).
          return this.reject(submit, "rider_unattested", { ordering_parent: read.parent, ordering_scope: read.scope });
        }
        if (attested !== read.version) orderingConflicts.push({ scope: read.scope, container: read.container, parent: read.parent });
        continue;
      }
      const current = orderedChildrenVersion(this.orderedChildren(read.container, read.parent));
      if (current !== read.version) orderingConflicts.push({ scope: read.scope, container: read.container, parent: read.parent });
    }
    if (orderingConflicts.length > 0) {
      // Retryable: the gateway re-fetches the named (scope,parent)
      // projections and re-plans. Scope is part of the identity because two
      // independent root orderings can both have `parent: null` in one turn.
      return this.reject(submit, "read_version_mismatch", { ordering_conflicts: orderingConflicts });
    }

    // Step 9: per-write authority (recorded VM frame, never owner union).
    const writesAuthorized = this.options.writeAuthorized
      ? this.options.writeAuthorized(submit)
      : submit.transcript.writes.every((write) => netCellKeyFor(write.cell) === null || write.writer !== undefined);
    if (!writesAuthorized) {
      return this.reject(submit, "write_unauthorized", {});
    }

    // Create-collision guard (client-shell phase i): a planned create
    // whose id ALREADY exists here means the planner allocated against a
    // slice that lacked the object (its counter or slice was stale).
    // Reject as a read-version mismatch NAMING THE LINEAGE CELL: the
    // plan effectively read that object's absence. The gateway's repair
    // refreshes exactly that cell — installing the existing object into
    // its view — and the re-plan's allocator then SKIPS the id (the
    // engine's own has()-skip rule), so the loop converges instead of
    // silently overwriting an object the planner never saw.
    for (const create of submit.transcript.creates ?? []) {
      if (this.store.get(cellKey("object_lineage", create.object)) !== undefined) {
        return this.reject(submit, "read_version_mismatch", { create_collision: create.object }, [
          // "lifecycle" is the transcript kind that keys object_lineage
          // (netCellKeyFor) — the refresh then pulls the existing
          // object's lineage into the planner's view.
          { kind: "lifecycle", object: create.object } as TranscriptCell
        ]);
      }
    }

    // The head this acceptance WILL have is computable before the apply
    // (rolling digest over prior hash + next seq + transcript hash), so
    // applied cells are stamped with the actual `(scope_head,
    // catalog_epoch)` per CO8 — one computation, adopted below on accept.
    // The stamp never affects step-10 parity: postStateVersion digests
    // cell VALUES only, so the planner (stamping with its own view's
    // epoch) derives the same digest.
    const priorHead = this.headState;
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
    // Advance the allocation counter past every accepted create (phase i;
    // no-op when the counter has not been derived yet — derivation reads
    // the store, which now holds these ids).
    if (this.nextObjectCounter !== null) {
      for (const create of submit.transcript.creates ?? []) {
        const match = /_(\d+)$/.exec(create.object);
        if (match) this.nextObjectCounter = Math.max(this.nextObjectCounter, Number(match[1]) + 1);
      }
    }
    const tailEntry: TailEntry = {
      seq: nextHead.seq,
      transcript_hash: submit.transcript.hash,
      touched: applied.touched,
      base_hash: priorHead.hash,
      head_hash: nextHead.hash
    };
    this.tail.push(tailEntry);
    if (this.tail.length > this.options.tailLimit) this.tail.splice(0, this.tail.length - this.options.tailLimit);

    // CO13: derive relation deltas from the accepted transcript — the
    // single write path for contents/presence rows. Local rows apply here
    // (durably, in the same transaction below); foreign rows ride the
    // reply for the shell's /net/relate delivery.
    const derived = deriveRelationDeltas(submit.transcript, applied, this.scope, this.options.scopeOf, applied.post);
    const changedRelationKeys = applyRelationDeltas(this.relationRows, derived.local);
    this.syncOrderedRelationIndex(changedRelationKeys);
    const relationsForeign = [...derived.foreign.entries()].map(([scope, deltas]) => ({ scope, deltas }));

    const reply: CommitReply = {
      kind: "woo.net.commit_reply.v1",
      status: "accepted",
      scope: this.scope,
      head: this.headState,
      touched: applied.touched,
      post_state_version: applied.postStateVersion,
      ...(derived.local.length > 0 ? { relations: derived.local } : {}),
      ...(relationsForeign.length > 0 ? { relations_foreign: relationsForeign } : {})
    };
    this.replies.set(submit.idempotency_key, reply);
    // H2a: bound the reply cache on each accepted commit (memory and the
    // durable rows prune in lockstep inside the transaction below).
    const prunedReplies = this.pruneReplies();

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
        durable.writeMeta(this.metaRow());
        durable.writeReply(submit.idempotency_key, reply);
        durable.appendTail(tailEntry);
        durable.trimTail(this.options.tailLimit);
        for (const key of prunedReplies) durable.deleteReply(key);
        for (const key of changedRelationKeys) {
          const row = this.relationRows.get(key);
          if (row) durable.writeRelation(key, row);
          else durable.deleteRelation(key);
        }
      });
    }
    return reply;
  }

  /**
   * CA3 rider adoption as an OWNER-SEQUENCED commit (CO2.3 rider
   * integrity, rule 2). Cells committed via ride-along at another scope
   * arrive here to be applied as owner-ordered events:
   *
   * - Per cell, CAS this authority's current version (absent hashes as
   *   "absent") against `priors[key]` — the version the committing turn
   *   observed (the attested version for attested cells). Match →
   *   applied. Mismatch → the owner moved inside the attestation window:
   *   OWNER WINS, the cell is not applied, and the conflict is returned
   *   for the caller to name and count (`net_adopt_conflict`) — never a
   *   silent overwrite. A cell with NO prior claimed (a blind "stamp the
   *   actor" write that read nothing) applies owner-ordered: with no
   *   read there is no stale read to launder (the design-C allowance).
   *   Conflicts never block the applied cells.
   * - A non-empty applied set is ONE owner commit: the head advances
   *   once for the batch, the applied cells commit through the store
   *   with the NEW head stamp (authoritative provenance — this IS an
   *   owner-ordered event, so observers and catch-up see a real
   *   owner-head advance with CO8-correct stamps), a tail entry is
   *   appended, and the durable write-through covers cells + meta + tail
   *   in one transaction exactly like submit's accept path.
   * - Adoption does NOT rerun ordinary CO4 validation: the writes were already
   *   validated at the committing scope against this owner's plan-time
   *   attestations (CO2.3 rule 1); re-validating here would make two
   *   validation authorities disagree about one turn. The exception is CO15's
   *   catalog-definition boundary: the catalog owner MUST refuse ordinary
   *   definition cells even when a stale gateway let them ride through another
   *   scope. Sender idempotency
   *   — the (from_scope, seq) high-water — is the SHELL's job
   *   (NetScopeDO), which is why this method must be called exactly once
   *   per adoption fact.
   */
  adopt(input: { from_scope: string; seq: number; cells: Cell[]; priors: Record<string, string> }): {
    status: "applied" | "empty" | "rejected";
    head: ScopeHead;
    applied: string[];
    conflicts: Array<{ key: string; ours: string; theirs: string }>;
    reason?: "catalog_mutation";
    detail?: { objects: string[]; keys: string[] };
  } {
    const catalogMutationKeys = new Map<string, string[]>();
    if (this.options.catalogMutationForbidden) {
      for (const cell of input.cells) {
        if (cell.kind !== "object_lineage" && cell.kind !== "property_cell" && cell.kind !== "verb_bytecode") continue;
        if (!this.options.catalogMutationForbidden(cell.object)) continue;
        const keys = catalogMutationKeys.get(cell.object) ?? [];
        keys.push(cell.key);
        catalogMutationKeys.set(cell.object, keys);
      }
    }
    if (catalogMutationKeys.size > 0) {
      const objects = [...catalogMutationKeys.keys()].sort();
      return {
        status: "rejected",
        reason: "catalog_mutation",
        detail: {
          objects,
          keys: objects.flatMap((object) => catalogMutationKeys.get(object) ?? []).sort()
        },
        head: this.headState,
        applied: [],
        conflicts: []
      };
    }

    const accepted: Cell[] = [];
    const conflicts: Array<{ key: string; ours: string; theirs: string }> = [];
    for (const cell of input.cells) {
      const ours = this.store.get(cell.key)?.version ?? "absent";
      const prior = input.priors[cell.key];
      if (prior !== undefined && prior !== ours) {
        conflicts.push({ key: cell.key, ours, theirs: cell.version });
        continue;
      }
      accepted.push(cell);
    }
    if (accepted.length === 0) {
      // Nothing applied: the head does not advance (an all-conflict
      // adoption changes no owner state, so minting an owner event for
      // it would fan out a no-op), but the conflicts still surface for
      // the caller to count.
      return { status: "empty", head: this.headState, applied: [], conflicts };
    }

    // One head advance for the batch. The digest marker names the
    // adoption fact — the committing scope and ITS seq — so the rolling
    // hash is deterministic and the tail entry stays legible in the
    // recovery log (`adopt:<from_scope>:<from_seq>` in place of a
    // transcript hash: adoptions have no transcript of their own).
    const marker = `adopt:${input.from_scope}:${input.seq}`;
    const priorHead = this.headState;
    const nextHead: ScopeHead = {
      seq: this.headState.seq + 1,
      hash: cellVersion([this.headState.hash, this.headState.seq + 1, marker])
    };
    const nextStamp: EpochStamp = { scope_head: `${nextHead.seq}:${nextHead.hash}`, catalog_epoch: this.catalogEpoch };
    const appliedKeys: string[] = [];
    for (const cell of accepted) {
      // Re-commit through the store (never a raw install): the value is
      // the committing scope's, but the authority stamp — provenance +
      // the NEW owner head — is minted here, because from this moment
      // the owner is the cell's one authority (CO2.1).
      const committed = this.store.commit({
        kind: cell.kind,
        object: cell.object,
        ...(cell.name !== undefined ? { name: cell.name } : {}),
        value: cell.value,
        stamp: nextStamp
      });
      appliedKeys.push(committed.key);
    }
    appliedKeys.sort();
    this.headState = nextHead;
    const tailEntry: TailEntry = {
      seq: nextHead.seq,
      transcript_hash: marker,
      touched: appliedKeys,
      base_hash: priorHead.hash,
      head_hash: nextHead.hash
    };
    this.tail.push(tailEntry);
    if (this.tail.length > this.options.tailLimit) this.tail.splice(0, this.tail.length - this.options.tailLimit);

    // Write-through (CO5 copy #1): identical discipline to submit's
    // accept path — cells, head, and tail in ONE transaction, so a crash
    // between the adopt reply and the owner's own fanout drain can never
    // leave them disagreeing.
    const durable = this.options.durable;
    if (durable) {
      durable.transaction(() => {
        for (const key of appliedKeys) {
          const cell = this.store.get(key);
          if (cell) durable.writeCell(cell);
        }
        durable.writeMeta(this.metaRow());
        durable.appendTail(tailEntry);
        durable.trimTail(this.options.tailLimit);
      });
    }
    return { status: "applied", head: this.headState, applied: appliedKeys, conflicts };
  }

  /** Derived relation rows this scope owns (CO13). Read surface for the
   * shell's /net/relate application and for roster queries. */
  relations(): ReadonlyMap<string, RelationRow> {
    return this.relationRows;
  }

  /** Owner-complete ordering for exactly one `(container, parent)` bucket.
   * Local authored cells and foreign relation projections are both already
   * write-time indexed; the merge is O(children-of-parent). */
  orderedChildren(container: string, parent: string | null): OrderedChildRow[] {
    const projected = this.orderedRelationsByProjection.get(orderedProjectionKey(container, parent)) ?? [];
    return orderedChildrenForContainer(this.store, projected, container, parent);
  }

  /**
   * H2b: reap EXPIRED session cells this scope owns, as ONE
   * owner-sequenced cleanup event (the coherent path, chosen over a
   * synthetic cleanup *turn*: a reap is a substrate fact with no verb to
   * execute, exactly the session-mint precedent — driving the planner
   * would need a phantom verb in every world, and the owner-sequenced
   * batch already gives observers a real head advance with CO8-correct
   * ordering, the adopt()/relate() discipline).
   *
   * - Only OWNED cells reap (`ownsSession` — the shell's witness, which
   *   excludes rider residue: a cached copy of another scope's session
   *   is that owner's to reap; ours self-expires by VALUE on every
   *   validate, so keeping it costs nothing but bytes until the next
   *   transfer refresh).
   * - The batch advances the head ONCE with a deterministic marker, the
   *   deleted keys land in the tail entry, and the durable write-through
   *   covers cells + meta + tail + relation rows in one transaction —
   *   submit/adopt's exact crash discipline.
   * - LOCAL session_presence rows naming a reaped session are removed
   *   here (returned as `localRemovals` so the shell refans them);
   *   rows owned by OTHER scopes are the shell's delivery concern (it
   *   knows the CO15 naming convention; the sequencer never learns
   *   topology) — `reaped[].activeScope` names each session's last
   *   presence room for that.
   * - Cell DELETIONS deliberately do not fan out: FanoutBody carries
   *   installs only (applyFanout semantics), and a derived copy of an
   *   expired session cell already validates "expired" by VALUE at
   *   every consumer, so the stale copy is inert until a transfer
   *   refresh drops it.
   */
  reapExpiredSessions(
    now: number,
    ownsSession: (id: string) => boolean
  ): {
    status: "applied" | "empty";
    head: ScopeHead;
    reaped: Array<{ session: string; actor: string | null; activeScope: string | null; retiredActor: boolean }>;
    localRemovals: RelationDelta[];
  } {
    const reaped: Array<{ session: string; actor: string | null; activeScope: string | null; retiredActor: boolean }> = [];
    const deletedKeys: string[] = [];
    const liveActors = new Set<string>();
    for (const key of this.store.keys()) {
      if (!key.startsWith("session:")) continue;
      const cell = this.store.get(key);
      const value = cell?.value as { actor?: unknown } | null | undefined;
      if (cell && validateSessionCell(cell, now) === "ok" && typeof value?.actor === "string") liveActors.add(value.actor);
    }
    for (const key of [...this.store.keys()].sort()) {
      if (!key.startsWith("session:")) continue;
      const cell = this.store.get(key);
      if (!cell || !ownsSession(cell.object)) continue;
      if (validateSessionCell(cell, now) !== "expired") continue;
      const value = cell.value as { actor?: unknown; activeScope?: unknown; ephemeralActor?: unknown; retireFromScope?: unknown } | null;
      const actor = typeof value?.actor === "string" ? value.actor : null;
      const activeScope = typeof value?.activeScope === "string" && value.activeScope
        ? value.activeScope
        : typeof value?.retireFromScope === "string" && value.retireFromScope
          ? value.retireFromScope
          : null;
      reaped.push({
        session: cell.object,
        actor,
        activeScope,
        retiredActor: value?.ephemeralActor === true && actor !== null && !liveActors.has(actor)
      });
      deletedKeys.push(key);
    }
    if (reaped.length === 0) {
      return { status: "empty", head: this.headState, reaped: [], localRemovals: [] };
    }

    // One head advance for the batch; the marker digests the reaped ids
    // so the rolling hash is deterministic and the tail stays legible.
    const marker = `session_reap:${cellVersion(reaped.map((entry) => entry.session))}`;
    const priorHead = this.headState;
    const nextHead: ScopeHead = {
      seq: this.headState.seq + 1,
      hash: cellVersion([this.headState.hash, this.headState.seq + 1, marker])
    };
    for (const key of deletedKeys) this.store.delete(key);
    this.headState = nextHead;
    const retiredLiveKeys: string[] = [];
    for (const entry of reaped) {
      if (!entry.retiredActor || entry.actor === null) continue;
      const key = cellKey("object_live", entry.actor);
      const live = this.store.get(key);
      if (!live) continue;
      const prior = (live.value ?? {}) as Record<string, unknown>;
      this.store.commit({
        kind: "object_live",
        object: entry.actor,
        value: { ...prior, location: "$nowhere" },
        stamp: this.stamp()
      });
      retiredLiveKeys.push(key);
    }
    const tailEntry: TailEntry = {
      seq: nextHead.seq,
      transcript_hash: marker,
      touched: [...deletedKeys, ...retiredLiveKeys].sort(),
      base_hash: priorHead.hash,
      head_hash: nextHead.hash
    };
    this.tail.push(tailEntry);
    if (this.tail.length > this.options.tailLimit) this.tail.splice(0, this.tail.length - this.options.tailLimit);

    // Local presence rows naming a reaped session: remove and report.
    const reapedIds = new Set(reaped.map((entry) => entry.session));
    const retiredContents = new Set(
      reaped
        .filter((entry) => entry.retiredActor && entry.actor !== null && entry.activeScope !== null)
        .map((entry) => relationKey("contents", entry.activeScope as string, entry.actor as string))
    );
    const localRemovals: RelationDelta[] = [];
    for (const row of this.relationRows.values()) {
      if (
        (row.relation === SESSION_PRESENCE_RELATION && reapedIds.has(row.member)) ||
        (row.relation === "contents" && retiredContents.has(relationKey(row.relation, row.owner, row.member)))
      ) {
        localRemovals.push({ op: "remove", row });
      }
    }
    const changedRelationKeys = applyRelationDeltas(this.relationRows, localRemovals);
    this.syncOrderedRelationIndex(changedRelationKeys);

    const durable = this.options.durable;
    if (durable) {
      durable.transaction(() => {
        for (const key of deletedKeys) durable.deleteCell(key);
        for (const key of retiredLiveKeys) {
          const cell = this.store.get(key);
          if (cell) durable.writeCell(cell);
        }
        durable.writeMeta(this.metaRow());
        durable.appendTail(tailEntry);
        durable.trimTail(this.options.tailLimit);
        for (const key of changedRelationKeys) {
          const row = this.relationRows.get(key);
          if (row) durable.writeRelation(key, row);
          else durable.deleteRelation(key);
        }
      });
    }
    return { status: "applied", head: this.headState, reaped, localRemovals };
  }

  /**
   * Apply externally delivered relation deltas (the /net/relate path —
   * rows derived at ANOTHER scope whose owner objects anchor here) as an
   * OWNER-SEQUENCED event, mirroring adopt():
   *
   * - A non-empty applied batch advances the head ONCE, with a tail
   *   entry naming the relate fact (`relate:<from_scope>:<from_seq>`).
   *   The advance is what gives the shell's refan a REAL seq: subscriber
   *   gateways gate every FanoutBody by per-scope seq (CO2.5), so a
   *   refan at an unadvanced head would no-op at any subscriber that
   *   already saw that seq and the roster delta would be silently lost.
   * - An all-no-op batch (adds of identical rows, removes of absent
   *   rows) is `empty`: no head advance, nothing to refan — but the
   *   caller's (from_scope, seq) high-water still advances at the shell,
   *   exactly like an all-conflict adoption (the fact WAS processed).
   * - Durable write-through covers rows + meta + tail in one transaction
   *   (CO5 copy #1 discipline, same as submit/adopt).
   *
   * Sender idempotency — the (from_scope, seq) high-water — is the
   * SHELL's job (NetScopeDO /net/relate), which is why this method must
   * be called exactly once per relate fact. `from` is optional so tests
   * and single-process hosts can apply deltas directly (the marker then
   * names the local scope itself).
   */
  applyForeignRelationDeltas(
    deltas: RelationDelta[],
    from?: { from_scope: string; seq: number }
  ): { status: "applied" | "empty"; head: ScopeHead; changed: string[] } {
    const changed = applyRelationDeltas(this.relationRows, deltas);
    this.syncOrderedRelationIndex(changed);
    if (changed.length === 0) {
      return { status: "empty", head: this.headState, changed: [] };
    }
    // One head advance for the batch — the same rolling-digest shape as
    // adopt(), keeping the recovery tail legible (relates have no
    // transcript of their own).
    const marker = `relate:${from?.from_scope ?? this.scope}:${from?.seq ?? 0}`;
    const priorHead = this.headState;
    const nextHead: ScopeHead = {
      seq: this.headState.seq + 1,
      hash: cellVersion([this.headState.hash, this.headState.seq + 1, marker])
    };
    this.headState = nextHead;
    const tailEntry: TailEntry = {
      seq: nextHead.seq,
      transcript_hash: marker,
      touched: [...changed].sort(),
      base_hash: priorHead.hash,
      head_hash: nextHead.hash
    };
    this.tail.push(tailEntry);
    if (this.tail.length > this.options.tailLimit) this.tail.splice(0, this.tail.length - this.options.tailLimit);
    const durable = this.options.durable;
    if (durable) {
      durable.transaction(() => {
        for (const key of changed) {
          const row = this.relationRows.get(key);
          if (row) durable.writeRelation(key, row);
          else durable.deleteRelation(key);
        }
        durable.writeMeta(this.metaRow());
        durable.appendTail(tailEntry);
        durable.trimTail(this.options.tailLimit);
      });
    }
    return { status: "applied", head: this.headState, changed };
  }

  /** Synchronize changed relation-map keys into the write-time-sorted ordered
   * projection index. This is the single index mutation path for hydration,
   * local derivation, reaping, and foreign `/net/relate` delivery. */
  private syncOrderedRelationIndex(keys: Iterable<string>): void {
    for (const key of keys) {
      const prior = this.orderedRelationLocationByKey.get(key);
      if (prior) {
        const bucket = this.orderedRelationsByProjection.get(prior.projection);
        if (bucket) {
          const at = ScopeSequencer.orderedRelationSlot(bucket, prior.rank, prior.child);
          if (at < bucket.length && bucket[at].child === prior.child && bucket[at].rank === prior.rank) bucket.splice(at, 1);
          if (bucket.length === 0) this.orderedRelationsByProjection.delete(prior.projection);
        }
        this.orderedRelationLocationByKey.delete(key);
      }

      const row = this.relationRows.get(key);
      if (!row || row.relation !== ORDERED_EDGE_RELATION) continue;
      const body = row.body as { parent?: unknown; rank?: unknown } | undefined;
      if (!body || (body.parent !== null && typeof body.parent !== "string") || typeof body.rank !== "string" || !body.rank) continue;
      const projection = orderedProjectionKey(row.owner, body.parent as string | null);
      const bucket = this.orderedRelationsByProjection.get(projection) ?? [];
      const at = ScopeSequencer.orderedRelationSlot(bucket, body.rank, row.member);
      bucket.splice(at, 0, { child: row.member, rank: body.rank });
      this.orderedRelationsByProjection.set(projection, bucket);
      this.orderedRelationLocationByKey.set(key, { projection, child: row.member, rank: body.rank });
    }
  }

  /** Lower-bound locator in the total `(rank, child)` order. */
  private static orderedRelationSlot(rows: readonly OrderedChildRow[], rank: string, child: string): number {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const row = rows[mid];
      if (row.rank < rank || (row.rank === rank && row.child < child)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** CO13 bounded repair: recompute the locally knowable contents relation
   * from authority live cells. Presence and ordered-edge rows are preserved:
   * their defining cells may live at foreign immutable anchors, so they repair
   * only through their single transcript-derivation + `/net/relate` path.
   * Replaces contents rows in memory and durably.
   *
   * When `scopeOf` is wired (multi-scope), candidates whose OWNER is
   * anchored elsewhere are dropped: those rows belong at the owning
   * scope (they were delivered there via /net/relate at derivation
   * time), and rebuilding them here would mint a second copy of another
   * scope's row family — the CO9 dual-write this module exists to
   * prevent. Single-scope contents rebuilds keep everything. */
  rebuildRelations(): void {
    const rebuilt = rebuildContentsRelation(
      [...this.store.keys()].map((key) => this.store.get(key)).filter((c): c is Cell => Boolean(c)),
      this.scope
    );
    if (this.options.scopeOf) {
      for (const [key, row] of [...rebuilt]) {
        if (this.options.scopeOf(row.owner) !== this.scope) rebuilt.delete(key);
      }
    }
    for (const [key, row] of [...this.relationRows]) {
      if (row.relation === "contents" && !rebuilt.has(key)) this.relationRows.delete(key);
    }
    for (const [key, row] of rebuilt) this.relationRows.set(key, row);
    const durable = this.options.durable;
    if (durable) {
      durable.transaction(() => {
        for (const row of durable.readRelations()) {
          if (row.relation === "contents") durable.deleteRelation(relationKey(row.relation, row.owner, row.member));
        }
        for (const [key, row] of rebuilt) durable.writeRelation(key, row);
      });
    }
  }

  /** The scope's bounded recovery log (CO5: read by the scope alone). */
  recoveryTail(): ReadonlyArray<TailEntry> {
    return this.tail;
  }

  // ---- Durable continuations (CO2.8) ----------------------------------

  /** Enqueue a scheduled turn; validated exactly like a live submission
   * when it fires (the firing path goes back through submit()). With a
   * durable store the queue lives THERE (see peekDue); the in-memory map
   * serves only the durable-less sequencer. */
  schedule(turn: ScheduledTurn, nowLogical: number): void {
    if (turn.at_logical_time <= nowLogical) {
      throw netError("E_MISSING_STATE", "scheduled turn must target a future logical time", { id: turn.id, at: turn.at_logical_time, now: nowLogical });
    }
    const durable = this.options.durable;
    if (durable) durable.writeScheduled(turn);
    else this.scheduled.set(turn.id, turn);
  }

  cancel(scheduleId: string): boolean {
    const durable = this.options.durable;
    if (durable) {
      const existed = durable.hasScheduled(scheduleId);
      if (existed) durable.deleteScheduled(scheduleId);
      return existed;
    }
    return this.scheduled.delete(scheduleId);
  }

  /** Earliest pending logical time, or null — the Host sets its alarm to
   * this (CO2.8: the scope wakes itself; a parked task survives eviction
   * because the queue is scope state). One indexed lookup on a durable
   * store (logical times are wall-clock ms, always > 0). */
  nextAlarmAt(): number | null {
    const durable = this.options.durable;
    if (durable) return durable.nextScheduledAfter(0);
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
   * consuming form for the executor that actually runs the turns.
   * `limit` bounds the batch to the FIRST n due turns in firing order
   * (ready-to-scale Phase 3: an alarm processes a bounded batch and
   * re-arms, so a due burst can never balloon one alarm transaction).
   * On a durable store this is one indexed due query — the scheduled
   * family is never hydrated or scanned wholesale (review #1: the batch
   * limit must bound rows SCANNED, not just rows moved). */
  peekDue(nowLogical: number, limit?: number): ScheduledTurn[] {
    const durable = this.options.durable;
    if (durable) return durable.readScheduledDue(nowLogical, limit ?? Number.MAX_SAFE_INTEGER);
    const due = [...this.scheduled.values()]
      .filter((turn) => turn.at_logical_time <= nowLogical)
      .sort((a, b) => a.at_logical_time - b.at_logical_time || a.id.localeCompare(b.id));
    return limit === undefined ? due : due.slice(0, limit);
  }

  /** Pop the turns due at or before `nowLogical`, in time order —
   * bounded to the first `limit` when given (see peekDue). */
  dueTurns(nowLogical: number, limit?: number): ScheduledTurn[] {
    const due = this.peekDue(nowLogical, limit);
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

  /**
   * H2a: bound the reply cache. Every recorded reply carries the head it
   * was recorded AT (`reply.head.seq` — accepted replies advance to it,
   * terminal rejections record the head they rejected against), so age
   * is derivable from content with no schema change. Two retention
   * guarantees, both honored:
   *
   * - **never prune within the tail window** — a reply whose seq is
   *   still covered by the retained recovery tail (seq > head - tail
   *   limit) is never a candidate, so recovery-tail replay always finds
   *   its replies;
   * - **a bounded TOTAL cache** — outside the window, the OLDEST replies
   *   prune until the whole cache is back within `replyLimit` (default
   *   REPLY_CACHE_CAP); in-window replies are never candidates but do
   *   count toward the cap.
   *
   * Consequence, documented: a replay arriving AFTER its reply pruned
   * (a client retrying a turn from thousands of commits ago) re-enters
   * validation instead of replaying — which is SAFE: its base is
   * ancient, so stale_head (or read_version_mismatch after a repair
   * re-plan) rejects it; the one thing it can never do is silently
   * re-commit, because committing requires the current head and fresh
   * read versions, at which point it IS a new turn by any observable
   * measure.
   *
   * Returns the pruned keys so the caller deletes the durable rows in
   * the same transaction (memory-follows-durable in lockstep).
   */
  private pruneReplies(): string[] {
    const limit = this.options.replyLimit ?? REPLY_CACHE_CAP;
    if (this.replies.size <= limit) return [];
    const cutoff = this.headState.seq - this.options.tailLimit;
    const candidates = [...this.replies.entries()]
      .map(([key, reply]) => ({ key, seq: reply.head.seq }))
      .filter((entry) => entry.seq <= cutoff)
      .sort((a, b) => a.seq - b.seq);
    const pruned: string[] = [];
    for (const entry of candidates) {
      if (this.replies.size <= limit) break;
      this.replies.delete(entry.key);
      pruned.push(entry.key);
    }
    return pruned;
  }

  /** Whether `base` is the current head or an exact ancestor proven by
   * the retained authority tail. Each new entry proves both sides of its
   * edge, which includes the pre-upgrade/current head on the first commit
   * after rollout. Missing optional fields on aged rows are intentionally
   * not inferred: unverifiable history takes the stale-head repair path. */
  private baseIsCurrentOrRetained(base: ScopeHead): boolean {
    if (base.seq === this.headState.seq) return base.hash === this.headState.hash;
    if (base.seq < 0 || base.seq > this.headState.seq) return false;
    for (let i = this.tail.length - 1; i >= 0; i -= 1) {
      const entry = this.tail[i];
      if (entry.seq === base.seq && entry.head_hash === base.hash) return true;
      if (entry.seq === base.seq + 1 && entry.base_hash === base.hash) return true;
      if (entry.seq < base.seq) break;
    }
    return false;
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
