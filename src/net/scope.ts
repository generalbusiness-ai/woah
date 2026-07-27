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
import {
  SCHEDULE_CLOCK_INPUT,
  SCHEDULE_MAX_ENTRY_BYTES,
  SCHEDULE_MAX_HORIZON_MS,
  SCHEDULE_MAX_PER_OBJECT,
  SCHEDULE_MAX_PER_SCOPE,
  SCHEDULE_MAX_PER_TURN,
  SCHEDULE_MAX_SCOPE_BYTES,
  SCHEDULE_MIN_LEAD_MS
} from "../core/scheduling";
import { netError } from "./errors";
import { validateSessionCell } from "./sessions";
import {
  applyRelationDeltas,
  deriveRelationDeltas,
  rebuildContentsRelation,
  relationKey,
  SESSION_PRESENCE_RELATION,
  type RelationDelta,
  type RelationRow
} from "./relations";
import {
  ACTOR_API_KEYS_PROPERTY,
  apiKeyVerifierKey,
  apiKeyVerifierRowsForActor,
  rebuildApiKeyVerifierIndex,
  type ApiKeyVerifierRow
} from "./api-key-index";
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
import { replayPageVersion, type ReplayLogEntry } from "./replay-pages";
import type { ScopeMeta, ScopeStore, TailEntry } from "./scope-store";
import { applyTranscript, isSequencedAllocationCell, netCellKeyFor, type EffectTranscript, type TranscriptCell } from "./transcript";
import { cellKey, cellVersion } from "./cells";
import { parseRoutedApiKeyId, routedApiKeyScope } from "../core/api-key-id";

export type ScopeHead = {
  seq: number;
  /** Rolling digest: hash(prev.hash, seq, transcript.hash). */
  hash: string;
  /** Monotonic authority generation. Unlike `seq`, this also advances for
   * head-stable seed and activation writes, closing ABA for complete reads. */
  generation?: number;
};

export type OperatorDefinitionRepair = {
  status: "applied" | "empty";
  head: ScopeHead;
  cells: Cell[];
  removed: string[];
};

export type OperatorCredentialEnsure = {
  status: "applied" | "empty";
  head: ScopeHead;
  cell: Cell;
  verifier: ApiKeyVerifierRow;
};

/** CO7/CO10 envelope byte ceilings. Enforced by the gateway on the ACTUAL
 * serialized submit RPC body ({submit, rider/relation destinations}),
 * measured immediately before the submit RPC — never on a modeled shape. */
export const WARM_ENVELOPE_BYTE_LIMIT = 64 * 1024;
export const CROSS_SCOPE_ENVELOPE_BYTE_LIMIT = 256 * 1024;

/** UTF-8 byte size of a submit RPC body as serialized on the wire. */
export function submitEnvelopeBytes(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).byteLength;
}

/** CO7 ceiling gate. A breach is a plain Error (misplan bug — the planner
 * built an envelope the protocol refuses; fix the plan, never raise the
 * ceiling), not a NetError the repair loop could grind on. */
export function assertEnvelopeCeiling(envelopeBytes: number, warm: boolean): void {
  const limit = warm ? WARM_ENVELOPE_BYTE_LIMIT : CROSS_SCOPE_ENVELOPE_BYTE_LIMIT;
  if (envelopeBytes > limit) {
    throw new Error(
      `oversized ${warm ? "warm" : "cross-scope"} envelope: ${envelopeBytes} bytes > ${limit} (misplan bug — shrink the transcript, do not raise the ceiling)`
    );
  }
}

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
  /** Same-scope reads were replaced by the exact complete base generation.
   * Such a submit may not use retained-head rebasing. */
  owned_reads_compacted?: true;
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
    /** The owner's CURRENT replay-page version per attested `(space, from,
     * limit)` query (sequenced-log.md SL4), taken at the same /net/attest
     * freshness point — a foreign committed-log read validates exactly
     * like a foreign cell or ordering read. */
    replays?: Array<{ space: string; from: number; limit: number; version: string }>;
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
  | "schedule_unauthorized" // CO16.2 — schedule/cancel effect failed provenance, namespace, authority, or quota; terminal
  | "post_state_mismatch"; // step 10

/** CO16.6/CO16.7 — the scheduling envelope. Defined in core (both ends
 * enforce it and the dependency runs core → net); re-exported here so
 * net-layer consumers and tests keep one import site. */
export {
  SCHEDULE_CLOCK_INPUT,
  SCHEDULE_MIN_LEAD_MS,
  SCHEDULE_MAX_HORIZON_MS,
  SCHEDULE_MAX_PER_SCOPE,
  SCHEDULE_MAX_PER_OBJECT,
  SCHEDULE_MAX_PER_TURN,
  SCHEDULE_MAX_ENTRY_BYTES,
  SCHEDULE_MAX_SCOPE_BYTES
} from "../core/scheduling";

/** Serialized size of a pending row, measured over what the scope stores. */
const SCHEDULE_BYTE_ENCODER = new TextEncoder();

export function scheduledTurnBytes(turn: ScheduledTurn): number {
  // UTF-8 bytes. `.length` counts UTF-16 code units and undercounts non-ASCII
  // payloads by up to ~4x against a byte cap the spec states in bytes.
  return SCHEDULE_BYTE_ENCODER.encode(JSON.stringify(turn)).length;
}

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
  /** CO16.6. `while_active` entries do not fire while the scope has no live
   * session subscribers; `always` entries fire unattended and cost a world
   * money in scopes nobody visits, which is why arming one needs wizard
   * authority. Absent on rows written before the policy existed — those
   * read as `always`, the pre-existing behaviour. */
  idle_policy?: "while_active" | "always";
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
   * trust); Phase-3 hosts inject the real check. Throw NetError to refuse.
   * The returned versions are foreign reads proved by a projection this
   * scope owns; step 7 compares them exactly like owner attestations. */
  authorize?: (submit: CommitSubmit) => ReadonlyMap<string, string> | void;
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
  /** Clock for the committed-log acceptance timestamp (CO2.5: accepted
   * frames carry the authority's acceptance time). Default Date.now; the
   * DO shell injects host.now so tests and workerd agree on the source. */
  now?: () => number;
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
  /** Private O(1) authentication index derived from actor api_keys cells.
   * This is not relation state and has no transfer/fanout/public surface. */
  private readonly apiKeyVerifiers = new Map<string, ApiKeyVerifierRow>();
  /** CO13 ordered-edge relation buckets, maintained in (rank, child) order
   * when rows change. Relation rows are keyed by member, so the reverse map
   * lets an overwrite/reparent remove the old bucket entry before adding the
   * new one. Reads therefore touch only one parent width, never every relation
   * in a room scope. */
  private readonly orderedRelationsByProjection = new Map<string, OrderedChildRow[]>();
  private readonly orderedRelationLocationByKey = new Map<string, { projection: string; child: string; rank: string }>();
  /** Committed sequenced-log rows for DURABLE-LESS sequencers only (unit
   * tests / in-process fixtures): space → (seq → entry). With a durable
   * store the log is never held in memory — it is the one row family
   * besides `scheduled` that can outgrow the live cell set without bound,
   * so pages are read from the store on demand (scope-store.ts). */
  private readonly memoryLogRows = new Map<string, Map<number, ReplayLogEntry>>();
  private readonly options: Required<Pick<ScopeSequencerOptions, "tailLimit">> & ScopeSequencerOptions;

  constructor(scope: string, catalogEpoch: string, options: ScopeSequencerOptions = {}) {
    this.scope = scope;
    this.catalogEpoch = catalogEpoch;
    this.store = new CellStore("authority");
    this.headState = { seq: 0, hash: cellVersion(["genesis", scope]), generation: 0 };
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
        this.headState = { ...meta.head, generation: meta.head.generation ?? meta.head.seq };
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
      for (const row of durable.readApiKeyVerifiers()) {
        this.apiKeyVerifiers.set(apiKeyVerifierKey(row.actor, row.id), row);
      }
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
    this.headState = {
      ...this.headState,
      generation: (this.headState.generation ?? this.headState.seq) + 1
    };
    // Same-epoch idempotent re-seed may re-stamp (same pipeline, same
    // value); an omitted field on a re-seed preserves the prior stamp
    // (legacy-caller posture, mirroring the relations rule below).
    if (attribution !== undefined) this.attribution = attribution;
    const seeded: Cell[] = [];
    for (const cell of cells) {
      seeded.push(this.store.commit({ kind: cell.kind, object: cell.object, ...(cell.name !== undefined ? { name: cell.name } : {}), value: cell.value, stamp: this.stamp() }));
    }
    // Seed carries the complete authority cell image, so rebuild the private
    // verifier index directly from it. The index never rides the public
    // `relations` argument.
    this.apiKeyVerifiers.clear();
    for (const [key, row] of rebuildApiKeyVerifierIndex(seeded)) this.apiKeyVerifiers.set(key, row);
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
        for (const row of durable.readApiKeyVerifiers()) {
          durable.deleteApiKeyVerifier(apiKeyVerifierKey(row.actor, row.id));
        }
        for (const [key, row] of this.apiKeyVerifiers) durable.writeApiKeyVerifier(key, row);
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
   * turns). Durable like a seed write; sequenced `(seq, hash)` stays stable
   * while the mutation-complete authority generation advances.
   */
  operatorActivationWrite(activeEpoch: string | null): void {
    this.headState = {
      ...this.headState,
      generation: (this.headState.generation ?? this.headState.seq) + 1
    };
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
    return this.orderedOperatorRepair("operator_definition_repair", cells, removals);
  }

  /** Signed operator migration for seeded property VALUES (the data twin of
   * `operatorRepairDefinitions`). The Worker shell computes each replacement
   * by merging the bundled manifest's `merge_map` seed hook into the stored
   * cell (src/core/seed-property-merge.ts) before calling this method, so an
   * operator-edited entry never reaches this commit — only cells whose merge
   * actually changed something arrive here. Same ordered-event contract:
   * head advance, authoritative stamp, one tail entry for fanout/catch-up. */
  operatorRepairSeedProperties(
    cells: Array<Pick<Cell, "kind" | "object" | "name" | "value">>
  ): OperatorDefinitionRepair {
    return this.orderedOperatorRepair("operator_seed_property_repair", cells, []);
  }

  /** Shared ordered-commit body for the signed operator repair family:
   * idempotency marker from the change set, one head advance, authoritative
   * stamps, one tail entry, one durable transaction. Unchanged replay returns
   * `{status: "empty"}` without touching the head. */
  private orderedOperatorRepair(
    markerLabel: string,
    cells: Array<Pick<Cell, "kind" | "object" | "name" | "value">>,
    removals: Array<Pick<Cell, "kind" | "object" | "name">>
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

    const marker = `${markerLabel}:${cellVersion({
      replacements: changed.map((cell) => [cell.kind, cell.object, cell.name ?? null, cell.value]),
      removals: removed
    })}`;
    const priorHead = this.headState;
    const nextHead: ScopeHead = {
      seq: priorHead.seq + 1,
      hash: cellVersion([priorHead.hash, priorHead.seq + 1, marker]),
      generation: (priorHead.generation ?? priorHead.seq) + 1
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

  /** Internal-signed bootstrap of one actor-owned API-key verifier.
   *
   * The operator generates the id, secret, and salt locally and sends only the
   * non-replayable verifier record here. Exact replay is empty success;
   * disagreement at an existing id is a collision. The actor cell, private
   * verifier index, head, and recovery tail advance in one transaction.
   */
  operatorEnsureCredential(
    actor: string,
    id: string,
    record: Record<string, unknown>
  ): OperatorCredentialEnsure {
    const routed = parseRoutedApiKeyId(id);
    const routedScope = routedApiKeyScope(id);
    const recordKeys = Object.keys(record).sort();
    const closedRecord =
      recordKeys.length === 5 &&
      recordKeys.every((key) => ["actor", "created_at", "hash", "label", "salt"].includes(key));
    if (
      !routed ||
      routed.actor !== actor ||
      routedScope !== this.scope ||
      !closedRecord ||
      record.actor !== actor ||
      typeof record.hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.hash) ||
      typeof record.salt !== "string" ||
      !/^[0-9a-f]{32}$/.test(record.salt) ||
      !Number.isSafeInteger(record.created_at) ||
      Number(record.created_at) < 0 ||
      (record.label !== null &&
        (typeof record.label !== "string" || new TextEncoder().encode(record.label).byteLength > 256))
    ) {
      throw netError("E_INVARG", "credential ensure record or routing hint is invalid", {
        actor,
        id,
        scope: this.scope
      });
    }
    if (!this.store.has(cellKey("object_lineage", actor))) {
      throw netError("E_MISSING_STATE", "credential actor is not authoritative at this scope", {
        actor,
        scope: this.scope
      });
    }
    if (this.options.scopeOf && this.options.scopeOf(actor) !== this.scope) {
      throw netError("E_INVARG", "credential actor belongs to a different authority scope", {
        actor,
        scope: this.scope,
        actual: this.options.scopeOf(actor)
      });
    }

    const key = cellKey("property_cell", actor, ACTOR_API_KEYS_PROPERTY);
    const priorCell = this.store.get(key);
    const priorPayload =
      priorCell?.value && typeof priorCell.value === "object" && !Array.isArray(priorCell.value)
        ? priorCell.value as { value?: unknown; def?: unknown }
        : {};
    const priorMap =
      priorPayload.value && typeof priorPayload.value === "object" && !Array.isArray(priorPayload.value)
        ? priorPayload.value as Record<string, unknown>
        : {};
    const existing = priorMap[id];
    if (existing !== undefined && cellVersion(existing) !== cellVersion(record)) {
      throw netError("E_INVARG", "credential id is already bound to a different verifier", {
        actor,
        id
      });
    }
    const verifier: ApiKeyVerifierRow = { actor, id, record };
    const verifierId = apiKeyVerifierKey(actor, id);
    const existingVerifier = this.apiKeyVerifiers.get(verifierId);
    if (existing !== undefined && existingVerifier && cellVersion(existingVerifier) === cellVersion(verifier)) {
      if (!priorCell) throw netError("E_MISSING_STATE", "credential record exists without its authority cell", { actor, id });
      return { status: "empty", head: this.headState, cell: priorCell, verifier };
    }

    const marker = `operator_credential_ensure:${cellVersion({ actor, id, record })}`;
    const priorHead = this.headState;
    const nextHead: ScopeHead = {
      seq: priorHead.seq + 1,
      hash: cellVersion([priorHead.hash, priorHead.seq + 1, marker]),
      generation: (priorHead.generation ?? priorHead.seq) + 1
    };
    const nextStamp: EpochStamp = {
      scope_head: `${nextHead.seq}:${nextHead.hash}`,
      catalog_epoch: this.catalogEpoch
    };
    const cell = this.store.commit({
      kind: "property_cell",
      object: actor,
      name: ACTOR_API_KEYS_PROPERTY,
      value: {
        ...("def" in priorPayload ? { def: priorPayload.def } : {}),
        value: { ...priorMap, [id]: record }
      },
      stamp: nextStamp
    });
    this.apiKeyVerifiers.set(verifierId, verifier);
    this.headState = nextHead;
    const tailEntry: TailEntry = {
      seq: nextHead.seq,
      transcript_hash: marker,
      touched: [cell.key],
      base_hash: priorHead.hash,
      head_hash: nextHead.hash
    };
    this.tail.push(tailEntry);
    if (this.tail.length > this.options.tailLimit) this.tail.splice(0, this.tail.length - this.options.tailLimit);

    const durable = this.options.durable;
    if (durable) {
      durable.transaction(() => {
        durable.writeCell(cell);
        durable.writeApiKeyVerifier(verifierId, verifier);
        durable.writeMeta(this.metaRow());
        durable.appendTail(tailEntry);
        durable.trimTail(this.options.tailLimit);
      });
    }
    return { status: "applied", head: this.headState, cell, verifier };
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
    let locallyProvedReads: ReadonlyMap<string, string> = new Map();
    try {
      locallyProvedReads = this.options.authorize?.(submit) ?? locallyProvedReads;
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

    // SL1/CO2.3: new net-planned sequenced transcripts preserve their
    // semantic space explicitly. When this scope owns that space, the
    // reserved next_seq allocation must be exactly one honest pre-state
    // read plus one `seq + 1` write. The write bypasses ordinary VM-frame
    // authority because it is sequencer bookkeeping, so this structural
    // check is its equivalent authority proof. A commit away from the
    // space (CA3 pure movement) must carry no allocation at all. Transcripts
    // without `space` are the rolling-upgrade/legacy shape and retain the
    // old out-of-band sequencer behavior.
    const allocationError = this.sequencedAllocationError(submit.transcript);
    if (allocationError !== null) {
      return this.reject(submit, "write_unauthorized", { sequenced_allocation: allocationError });
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
      for (const recycle of submit.transcript.recycles ?? []) {
        if (!this.options.catalogMutationForbidden(recycle.object)) continue;
        const keys = catalogMutationKeys.get(recycle.object) ?? [];
        keys.push(cellKey("object_tombstone", recycle.object));
        catalogMutationKeys.set(recycle.object, keys);
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
    if (
      (submit.owned_reads_compacted === true && !this.baseIsExactCurrent(submit.base)) ||
      (submit.owned_reads_compacted !== true && !this.baseIsCurrentOrRetained(submit.base))
    ) {
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
        const provedVersion = locallyProvedReads.get(key) ?? attested.get(key);
        if (provedVersion === undefined) {
          // A rider read with neither an owner attestation nor a local
          // projection proof is a protocol violation by the submitter,
          // not a stale-view condition — terminal, named (the
          // pre-amendment behavior silently skipped these reads, which
          // is the CO2.4 gap this closes; notes/2026-07-06-rider-read-
          // integrity.md).
          return this.reject(submit, "rider_unattested", { key });
        }
        // Attested-vs-planned mismatch repairs exactly like an owned
        // stale read: the gateway refreshes the cell (from its owner,
        // via the anchors routing), re-attests, and re-plans.
        if (provedVersion !== String(read.version)) mismatched.set(key, read.cell);
        continue;
      }
      const current = this.store.get(key)?.version ?? "absent";
      if (current !== String(read.version)) mismatched.set(key, read.cell);
    }
    if (mismatched.size > 0) {
      return this.reject(submit, "read_version_mismatch", {}, [...mismatched.values()]);
    }

    // The allocation's version has now passed the normal retryable CAS
    // check. Only at this point compare its claimed logical value with the
    // authority value: doing this before step 7 would turn an ordinary
    // concurrent allocation into a terminal write_unauthorized refusal
    // instead of the expected refresh/replan.
    const allocationValueError = this.sequencedAllocationAuthorityValueError(submit.transcript);
    if (allocationValueError !== null) {
      return this.reject(submit, "write_unauthorized", { sequenced_allocation: allocationValueError });
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

    // A tombstone is terminal authority, not an absent object page. A stale
    // gateway may still submit a write/create/move planned from old lineage;
    // reject it as the lifecycle read conflict it is so the repair path pulls
    // the tombstone and replans to E_OBJNF. Recycles themselves must execute
    // at the object's owner and against a live lineage page.
    const lifecycleObjects = new Set<string>();
    for (const write of submit.transcript.writes) lifecycleObjects.add(write.cell.object);
    for (const create of submit.transcript.creates ?? []) lifecycleObjects.add(create.object);
    for (const move of submit.transcript.moves ?? []) lifecycleObjects.add(move.object);
    for (const recycle of submit.transcript.recycles ?? []) lifecycleObjects.add(recycle.object);
    for (const object of lifecycleObjects) {
      if (!this.store.has(cellKey("object_tombstone", object))) continue;
      return this.reject(submit, "read_version_mismatch", { tombstoned_object: object }, [
        { kind: "lifecycle", object } as TranscriptCell
      ]);
    }
    for (const recycle of submit.transcript.recycles ?? []) {
      if (
        (this.options.owns && !this.options.owns(recycle.object)) ||
        !this.store.has(cellKey("object_lineage", recycle.object))
      ) {
        return this.reject(submit, "write_unauthorized", {
          recycle: recycle.object,
          reason: "recycle target is not a live object owned by this scope"
        });
      }
    }

    // Step 7c (sequenced-log.md SL4): validate replay-page reads exactly
    // like ordering reads. An entry THIS scope owns re-derives its page
    // from the durable committed log — an append landing inside the window
    // between plan and submit changes the page's content version and the
    // stale read rejects retryable (the gateway re-fetches the page and
    // re-plans). A FOREIGN entry validates against the owner's `replays`
    // attestation carried by the submit; one with no attestation is a
    // submitter protocol violation (terminal rider_unattested, the R3
    // mirror). Validation runs BEFORE this turn's own log append below, so
    // a sequenced turn reading its own space's log never self-invalidates.
    const attestedReplays = new Map<string, string>();
    for (const [owner, entry] of Object.entries(submit.attestations ?? {})) {
      for (const page of entry.replays ?? []) {
        attestedReplays.set(`${owner}\0${page.space}\0${page.from}\0${page.limit}`, page.version);
      }
    }
    const replayConflicts: Array<{ scope: string; space: string; from: number; limit: number }> = [];
    for (const read of submit.transcript.replayReads ?? []) {
      if (read.scope !== this.scope) {
        const attested = attestedReplays.get(`${read.scope}\0${read.space}\0${read.from}\0${read.limit}`);
        if (attested === undefined) {
          return this.reject(submit, "rider_unattested", {
            replay_space: read.space,
            replay_scope: read.scope
          });
        }
        if (attested !== read.version) replayConflicts.push({ scope: read.scope, space: read.space, from: read.from, limit: read.limit });
        continue;
      }
      const current = replayPageVersion(this.replayPage(read.space, read.from, read.limit));
      if (current !== read.version) replayConflicts.push({ scope: read.scope, space: read.space, from: read.from, limit: read.limit });
    }
    if (replayConflicts.length > 0) {
      // Retryable: the gateway drops its cached pages for the named
      // queries, re-fetches, and re-plans (the ordering-conflict shape).
      return this.reject(submit, "read_version_mismatch", { replay_conflicts: replayConflicts });
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
      if (
        this.store.get(cellKey("object_lineage", create.object)) !== undefined ||
        this.store.get(cellKey("object_tombstone", create.object)) !== undefined
      ) {
        return this.reject(submit, "read_version_mismatch", { create_collision: create.object }, [
          // "lifecycle" is the transcript kind that keys object_lineage
          // (netCellKeyFor) — the refresh then pulls the existing
          // object's lineage into the planner's view.
          { kind: "lifecycle", object: create.object } as TranscriptCell
        ]);
      }
    }

    // CO16.2: schedule/cancellation effects are validated by the SCOPE, on
    // provenance the transcript carries, before anything is applied. Terminal:
    // a namespace claim, an authority claim, or a quota breach does not become
    // valid on retry.
    const scheduleError = this.scheduleEffectsError(submit);
    if (scheduleError !== null) {
      return this.reject(submit, "schedule_unauthorized", { schedule: scheduleError });
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
      hash: cellVersion([this.headState.hash, this.headState.seq + 1, submit.transcript.hash]),
      generation: (this.headState.generation ?? this.headState.seq) + 1
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

    // A complete direct transcript with no durable or projection effects is
    // an authority-validated read, not a commit. Returning it at the current
    // head avoids turning V concurrent semantic-view refreshes into V writes
    // that contend on an otherwise unchanged scope. Do not cache the reply:
    // a transport retry may safely re-read newer authority, and the gateway
    // owns the successful result (the scope never receives it on the wire).
    const pureDirectRead =
      submit.transcript.route === "direct" &&
      applied.touched.length === 0 &&
      applied.projectionWrites.length === 0 &&
      (submit.transcript.projectionWrites?.length ?? 0) === 0 &&
      submit.transcript.sessionScopeTransition === undefined &&
      // Queue effects are effects. Without these two clauses a direct turn
      // that ONLY armed or cancelled a schedule was classified as a read and
      // returned early, discarding the arming silently — the exact failure
      // mode this whole design exists to remove.
      (submit.transcript.schedules?.length ?? 0) === 0 &&
      (submit.transcript.cancellations?.length ?? 0) === 0 &&
      submit.transcript.untrackedEffects.length === 0;
    if (pureDirectRead) {
      return {
        kind: "woo.net.commit_reply.v1",
        status: "accepted",
        scope: this.scope,
        head: this.headState,
        touched: [],
        post_state_version: applied.postStateVersion
      };
    }

    // Accept: adopt the applied clone as authority, advance head, record
    // the tail entry and the reply (step 11).
    for (const key of applied.touched) {
      const cell = applied.post.get(key);
      if (cell) this.store.install(cell);
      else this.store.delete(key);
    }
    this.headState = nextHead;
    // CO16.8 lifecycle: a recycled object's pending entries go with it, in
    // this same transaction. The SCOPE does this rather than the recycling
    // verb because only the scope holds the queue — woocode cannot enumerate
    // it and so cannot cancel what it cannot see. Both directions are covered:
    // entries that would FIRE at the object, and entries the object ARMED on
    // something else. Leaving either behind means a timer that wakes a
    // tombstone, or one that outlives the only thing that could cancel it.
    for (const recycle of submit.transcript.recycles ?? []) {
      for (const row of this.pendingScheduleRows()) {
        const separator = row.id.indexOf(":");
        const owner = separator < 0 ? "" : row.id.slice(0, separator);
        if (row.call.target === recycle.object || owner === recycle.object) this.cancel(row.id);
      }
    }
    // CO16.2: apply the queue effects ATOMICALLY with the turn's writes.
    // Cancellations run before schedules so a turn that cancels one id and
    // arms another in the same breath cannot have the cancel clobber a fresh
    // entry; an id in both arrays was already rejected above.
    for (const entry of submit.transcript.cancellations ?? []) this.cancel(entry.id);
    for (const request of submit.transcript.schedules ?? []) {
      const row = this.scheduledTurnFromRequest(request, this.scheduleAttribution(submit));
      const durable = this.options.durable;
      // Upsert straight into the queue rather than going through schedule():
      // that helper re-checks "future time" against a live clock, which would
      // reject a validly-armed row if the commit lands slowly. The lead-time
      // rule was already enforced against the turn's recorded clock.
      if (durable) durable.writeScheduled(row);
      else this.scheduled.set(row.id, row);
    }
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

    // Committed sequenced log (sequenced-log.md SL1/SL4): every accepted
    // SEQUENCED transcript that consumed this space's seq appends one
    // durable entry under its SEMANTIC
    // space id and space-log seq — the row `$space:replay(from, limit)`
    // pages read through /net/replay-page. `ts` is minted HERE, once, as
    // the authority acceptance time (CO2.5), so page content versions are
    // stable across re-reads. Failed turns append with applied_ok: false
    // (a refused verb still consumed its seq); direct-route commits and
    // adoption never log. The idempotent-replay early return above means
    // this runs at most once per turn.
    const logEntry = this.committedLogEntry(submit.transcript);
    if (logEntry && !this.options.durable) {
      const rows = this.memoryLogRows.get(logEntry.space) ?? new Map<number, ReplayLogEntry>();
      rows.set(logEntry.seq, logEntry);
      this.memoryLogRows.set(logEntry.space, rows);
    }

    // Re-index actor-owned verifier maps inside the authority transaction.
    // This state is intentionally absent from CommitReply: it is neither a
    // public relation delta nor gateway fanout material.
    const changedVerifierKeys = new Set<string>();
    const credentialActors = new Set(
      submit.transcript.writes
        .filter((write) =>
          write.cell.kind === "prop" &&
          write.cell.name === ACTOR_API_KEYS_PROPERTY &&
          write.cell.object !== "$system"
        )
        .map((write) => write.cell.object)
    );
    for (const actor of credentialActors) {
      if (this.options.scopeOf && this.options.scopeOf(actor) !== this.scope) continue;
      const cell = applied.post.get(cellKey("property_cell", actor, ACTOR_API_KEYS_PROPERTY));
      for (const key of this.replaceApiKeyVerifiersForActor(actor, cell?.value)) changedVerifierKeys.add(key);
    }

    // CO13: derive relation deltas from the accepted transcript — the
    // single write path for contents/presence rows. Local rows apply here
    // (durably, in the same transaction below); foreign rows ride the
    // reply for the shell's /net/relate delivery.
    const derived = deriveRelationDeltas(
      submit.transcript,
      applied,
      this.scope,
      this.options.scopeOf,
      applied.post
    );
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
        if (logEntry) durable.appendLogEntry(logEntry);
        for (const key of prunedReplies) durable.deleteReply(key);
        for (const key of changedRelationKeys) {
          const row = this.relationRows.get(key);
          if (row) durable.writeRelation(key, row);
          else durable.deleteRelation(key);
        }
        for (const key of changedVerifierKeys) {
          const row = this.apiKeyVerifiers.get(key);
          if (row) durable.writeApiKeyVerifier(key, row);
          else durable.deleteApiKeyVerifier(key);
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
   *   once for the batch, replacement cells and removals commit through
   *   the store
   *   with the NEW head stamp (authoritative provenance — this IS an
   *   owner-ordered event, so observers and catch-up see a real
   *   owner-head advance with CO8-correct stamps), a tail entry is
   *   appended, and the durable write-through covers cells/removals +
   *   meta + tail
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
  adopt(input: {
    from_scope: string;
    seq: number;
    cells: Cell[];
    removed?: string[];
    priors: Record<string, string>;
  }): {
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
      for (const key of input.removed ?? []) {
        const object = key.split(":")[1] ?? "";
        if (!object || !this.options.catalogMutationForbidden(object)) continue;
        const keys = catalogMutationKeys.get(object) ?? [];
        keys.push(key);
        catalogMutationKeys.set(object, keys);
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
    const acceptedRemovals: string[] = [];
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
    for (const key of input.removed ?? []) {
      const ours = this.store.get(key)?.version ?? "absent";
      const prior = input.priors[key];
      if (prior !== undefined && prior !== ours) {
        conflicts.push({ key, ours, theirs: "absent" });
        continue;
      }
      // Deleting an already-absent key is an idempotent no-op, not an owner
      // event. The sender high-water still advances in the shell.
      if (ours !== "absent") acceptedRemovals.push(key);
    }
    if (accepted.length === 0 && acceptedRemovals.length === 0) {
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
      hash: cellVersion([this.headState.hash, this.headState.seq + 1, marker]),
      generation: (this.headState.generation ?? this.headState.seq) + 1
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
    for (const key of acceptedRemovals) {
      this.store.delete(key);
      appliedKeys.push(key);
    }
    appliedKeys.sort();
    const changedVerifierKeys = new Set<string>();
    const credentialActors = new Set<string>();
    for (const cell of accepted) {
      if (
        cell.kind === "property_cell" &&
        cell.name === ACTOR_API_KEYS_PROPERTY &&
        cell.object !== "$system"
      ) credentialActors.add(cell.object);
    }
    const credentialSuffix = `:${ACTOR_API_KEYS_PROPERTY}`;
    for (const key of acceptedRemovals) {
      if (!key.startsWith("property_cell:") || !key.endsWith(credentialSuffix)) continue;
      const actor = key.slice("property_cell:".length, -credentialSuffix.length);
      if (actor && actor !== "$system") credentialActors.add(actor);
    }
    for (const actor of credentialActors) {
      const cell = this.store.get(cellKey("property_cell", actor, ACTOR_API_KEYS_PROPERTY));
      for (const key of this.replaceApiKeyVerifiersForActor(actor, cell?.value)) changedVerifierKeys.add(key);
    }
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
          else durable.deleteCell(key);
        }
        durable.writeMeta(this.metaRow());
        durable.appendTail(tailEntry);
        durable.trimTail(this.options.tailLimit);
        for (const key of changedVerifierKeys) {
          const row = this.apiKeyVerifiers.get(key);
          if (row) durable.writeApiKeyVerifier(key, row);
          else durable.deleteApiKeyVerifier(key);
        }
      });
    }
    return { status: "applied", head: this.headState, applied: appliedKeys, conflicts };
  }

  /** Derived relation rows this scope owns (CO13). Read surface for the
   * shell's /net/relate application and for roster queries. */
  relations(): ReadonlyMap<string, RelationRow> {
    return this.relationRows;
  }

  /** Exact authority-private lookup used only by the signed credential
   * endpoint. Returning the record, rather than the index row, keeps actor/id
   * routing metadata out of the verifier shape. */
  apiKeyVerifier(actor: string, id: string): Record<string, unknown> | null {
    return this.apiKeyVerifiers.get(apiKeyVerifierKey(actor, id))?.record ?? null;
  }

  private replaceApiKeyVerifiersForActor(actor: string, value: unknown): string[] {
    const desired = apiKeyVerifierRowsForActor(actor, value);
    const changed = new Set<string>();
    for (const [key, row] of [...this.apiKeyVerifiers]) {
      if (row.actor !== actor || desired.has(key)) continue;
      this.apiKeyVerifiers.delete(key);
      changed.add(key);
    }
    for (const [key, row] of desired) {
      const existing = this.apiKeyVerifiers.get(key);
      if (existing && cellVersion(existing) === cellVersion(row)) continue;
      this.apiKeyVerifiers.set(key, row);
      changed.add(key);
    }
    return [...changed].sort();
  }

  /** Owner-complete ordering for exactly one `(container, parent)` bucket.
   * Local authored cells and foreign relation projections are both already
   * write-time indexed; the merge is O(children-of-parent). */
  orderedChildren(container: string, parent: string | null): OrderedChildRow[] {
    const projected = this.orderedRelationsByProjection.get(orderedProjectionKey(container, parent)) ?? [];
    return orderedChildrenForContainer(this.store, projected, container, parent);
  }

  /**
   * One committed replay page of a space this authority owns
   * (sequenced-log.md SL2 window semantics: entries with `seq >= from`,
   * at most `limit`, in seq order). `space` is the SEMANTIC space id.
   * Served from the durable log family on demand — never hydrated — or
   * from the in-memory rows on a durable-less test sequencer. A space
   * with no committed entries (or one this scope does not own) yields
   * the empty page, whose version is still well-defined and attestable.
   */
  replayPage(space: string, from: number, limit: number): ReplayLogEntry[] {
    const durable = this.options.durable;
    if (durable) return durable.readLogPage(space, from, limit);
    const rows = this.memoryLogRows.get(space);
    if (!rows) return [];
    return [...rows.values()]
      .filter((entry) => entry.seq >= from)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((entry) => structuredClone(entry));
  }

  /** Validate the explicit SL1 allocation carried by the new net transcript
   * shape. See the submit call site for the compatibility boundary. */
  private sequencedAllocationError(transcript: EffectTranscript): string | null {
    if (transcript.route !== "sequenced" || transcript.space === undefined) return null;
    const space = transcript.space;
    const writes = transcript.writes.filter((write) => isSequencedAllocationCell(transcript, write.cell));
    // Omitting `owns` means a single-scope authority (the same convention
    // step 7 uses for ordinary reads), so it owns every object in its store
    // even when the transport scope name differs from the semantic space id.
    // Multi-scope hosts always provide the predicate and therefore still
    // reject/strip allocations committed away from the room owner.
    const ownedHere = this.options.owns ? this.options.owns(space) : true;
    if (!ownedHere) return writes.length === 0 ? null : "foreign commit carried the space allocation";
    if (!Number.isInteger(transcript.seq) || transcript.seq < 1) return "seq must be a positive integer";
    if (writes.length !== 1) return `expected one next_seq write, got ${writes.length}`;
    const write = writes[0];
    if (write.op !== "set" || write.value !== transcript.seq + 1) return "next_seq write must set seq + 1";
    // submitTranscript re-versions READS against the authority view, while
    // write.prior/next retain the ephemeral world's local counters. The
    // serialized authority CAS is therefore the read version, not equality
    // between those two version domains.
    const matchingReads = transcript.reads.filter((read) =>
      isSequencedAllocationCell(transcript, read.cell)
      && read.value === transcript.seq
      && read.version !== undefined
    );
    return matchingReads.length === 1 ? null : `expected one matching next_seq pre-read, got ${matchingReads.length}`;
  }

  /** After the allocation read's version passes step 7, prove its claimed
   * logical value is the authority's actual allocator value. This closes the
   * forged-value/current-version gap without relabelling honest concurrency
   * as a terminal refusal. */
  private sequencedAllocationAuthorityValueError(transcript: EffectTranscript): string | null {
    if (transcript.route !== "sequenced" || transcript.space === undefined) return null;
    const write = transcript.writes.find((candidate) => isSequencedAllocationCell(transcript, candidate.cell));
    if (!write) return null; // legitimate off-space CA3 commit
    const current = this.store.get(netCellKeyFor(write.cell) ?? "");
    const currentPayload = current?.value as { value?: unknown } | undefined;
    // A never-used space may inherit `$sequenced_log.next_seq == 1` and
    // therefore have no instance property cell yet. The first accepted Net
    // turn materializes it; every later allocation reads the stored value.
    const authorityNextSeq = current === undefined ? 1 : currentPayload?.value;
    return authorityNextSeq === transcript.seq ? null : "seq must equal the authority next_seq value";
  }

  /** The committed-log row an accepted transcript appends, or null for
   * routes that never log (direct commits, adoption, session mints). The
   * SEMANTIC space rides in `transcript.space` (preserved by the planner
   * when it retargets `scope` at this authority's address); an engine-
   * shaped transcript without the field logs under its `scope`, which IS
   * the semantic space there. */
  private committedLogEntry(transcript: EffectTranscript): ReplayLogEntry | null {
    if (transcript.route !== "sequenced") return null;
    const space = transcript.space ?? transcript.scope;
    if (typeof space !== "string" || space.length === 0 || typeof transcript.seq !== "number") return null;
    // Only a turn that actually CONSUMED a seq here logs: the planner keeps
    // the space's `next_seq` allocation write exactly when the commit scope
    // owns the space (plan.ts stripUnownedSequencedAllocation), so this
    // guard both prevents a foreign scope from minting rows for a space it
    // does not own and keeps the (space, seq) key collision-free — a
    // CA3 pure-movement turn commits at the actor's cluster with the
    // allocation stripped and appends nothing.
    const consumedSeq = transcript.writes.some(
      (write) => write.cell.kind === "prop" && write.cell.object === space && write.cell.name === "next_seq"
    );
    if (!consumedSeq) return null;
    return {
      space,
      seq: transcript.seq,
      ts: (this.options.now ?? Date.now)(),
      actor: transcript.call.actor,
      message: structuredClone({
        actor: transcript.call.actor,
        target: transcript.call.target,
        verb: transcript.call.verb,
        args: transcript.call.args
      }),
      observations: structuredClone(transcript.observations) as unknown[],
      applied_ok: transcript.error === undefined,
      ...(transcript.error !== undefined ? { error: structuredClone(transcript.error) } : {})
    };
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
      hash: cellVersion([this.headState.hash, this.headState.seq + 1, marker]),
      generation: (this.headState.generation ?? this.headState.seq) + 1
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
   *   rows) is `empty`: no head advance, nothing to refan — unless the
   *   same owner delivery carries observations. Those recorded facts still
   *   require one owner-sequenced refan, so `recordEvent` advances the head
   *   even with zero changed relation rows. The caller's (from_scope, seq)
   *   high-water advances at the shell in either case.
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
    from?: { from_scope: string; seq: number },
    options: { recordEvent?: boolean } = {}
  ): { status: "applied" | "empty"; head: ScopeHead; changed: string[] } {
    const changed = applyRelationDeltas(this.relationRows, deltas);
    this.syncOrderedRelationIndex(changed);
    if (changed.length === 0 && options.recordEvent !== true) {
      return { status: "empty", head: this.headState, changed: [] };
    }
    // One head advance for the batch — the same rolling-digest shape as
    // adopt(), keeping the recovery tail legible (relates have no
    // transcript of their own).
    const marker = `${changed.length > 0 ? "relate" : "observe"}:${from?.from_scope ?? this.scope}:${from?.seq ?? 0}`;
    const priorHead = this.headState;
    const nextHead: ScopeHead = {
      seq: this.headState.seq + 1,
      hash: cellVersion([this.headState.hash, this.headState.seq + 1, marker]),
      generation: (this.headState.generation ?? this.headState.seq) + 1
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

  /** CO13 bounded repair: recompute locally knowable contents relations and
   * the separate authority-private credential index from authority cells.
   * Presence and ordered-edge rows are preserved:
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
    const cells = [...this.store.keys()].map((key) => this.store.get(key)).filter((c): c is Cell => Boolean(c));
    const rebuilt = rebuildContentsRelation(
      cells,
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
    this.apiKeyVerifiers.clear();
    for (const [key, row] of rebuildApiKeyVerifierIndex(cells)) this.apiKeyVerifiers.set(key, row);
    const durable = this.options.durable;
    if (durable) {
      durable.transaction(() => {
        for (const row of durable.readRelations()) {
          if (row.relation === "contents") {
            durable.deleteRelation(relationKey(row.relation, row.owner, row.member));
          }
        }
        for (const [key, row] of rebuilt) durable.writeRelation(key, row);
        for (const row of durable.readApiKeyVerifiers()) {
          durable.deleteApiKeyVerifier(apiKeyVerifierKey(row.actor, row.id));
        }
        for (const [key, row] of this.apiKeyVerifiers) durable.writeApiKeyVerifier(key, row);
      });
    }
  }

  /** The scope's bounded recovery log (CO5: read by the scope alone). */
  recoveryTail(): ReadonlyArray<TailEntry> {
    return this.tail;
  }


  /**
   * CO16.2 validation for `schedules` / `cancellations`. Runs before the
   * apply, so a violation rejects the whole turn: a partially-applied
   * schedule set is exactly the split state CO2.2 forbids.
   *
   * The scope checks these ITSELF rather than trusting the submitter. Every
   * rule below is one a compromised or buggy planner could otherwise defeat:
   * claim another object's namespace, arm `always` without wizard authority,
   * back-date a delay under the floor, or grow the queue without bound.
   */
  private scheduleEffectsError(submit: CommitSubmit): string | null {
    const transcript = submit.transcript;
    const schedules = transcript.schedules ?? [];
    const cancellations = transcript.cancellations ?? [];
    if (schedules.length === 0 && cancellations.length === 0) return null;

    if (schedules.length > SCHEDULE_MAX_PER_TURN) {
      return `turn armed ${schedules.length} schedules; per-turn cap is ${SCHEDULE_MAX_PER_TURN}`;
    }

    // An id in both arrays is rejected outright (CO16.2): "cancel then re-arm
    // the same key in one turn" is ambiguous about which wins, and the upsert
    // form already expresses re-arming.
    const cancelledIds = new Set(cancellations.map((entry) => entry.id));
    for (const request of schedules) {
      if (cancelledIds.has(request.id)) return `schedule id ${request.id} appears in both schedules and cancellations`;
    }

    // The reference clock is the turn's own recorded `now` logical input, not
    // a fresh read: it is what the planner computed against and what replay
    // reproduces. A turn that armed a schedule without ever reading the clock
    // cannot have its lead time validated, so it fails closed.
    let recordedNow: number | null = null;
    for (const input of transcript.logicalInputs ?? []) {
      if (input.name === SCHEDULE_CLOCK_INPUT && typeof input.value === "number") {
        recordedNow = input.value;
        break;
      }
    }

    for (const request of schedules) {
      const armedBy = request.armed_by;
      if (!armedBy) return `schedule ${request.id} carries no arming-frame provenance`;

      // The fired turn runs as this actor. Binding it to the arming turn's
      // own actor is what stops a planner substituting a different (or
      // future, or more privileged) principal into a durable row that will
      // execute long after anyone is looking.
      if (request.call.actor !== submit.transcript.call.actor) {
        return `schedule ${request.id} names actor ${request.call.actor}, not the arming turn's actor ${submit.transcript.call.actor}`;
      }

      // CO16.3: the id namespace IS the arming object. This single check is
      // the whole enforcement — without it any verb could upsert over another
      // object's timer, a same-scope denial of service with no audit signal.
      // Split on the FIRST colon: the namespace is the arming object, whose
      // ref never contains one, while a caller-supplied stable key may. A
      // lastIndexOf split terminally rejected every legitimate key with a
      // colon in it.
      const separator = request.id.indexOf(":");
      const namespace = separator < 0 ? "" : request.id.slice(0, separator);
      if (namespace !== armedBy.thisObj) {
        return `schedule ${request.id} is outside the arming object's namespace (${armedBy.thisObj})`;
      }

      const policy = request.idlePolicy;
      if (policy !== "while_active" && policy !== "always") {
        return `schedule ${request.id} has unknown idle_policy ${String(policy)}`;
      }
      // CO16.6: `always` is the shape that bills a world forever in a scope
      // nobody visits. The gate is on the ARMING FRAME's programmer authority,
      // so ordinary one-shots reach it through wizard-owned catalog verbs.
      if (policy === "always" && !this.isWizardRef(armedBy.progr)) {
        return `schedule ${request.id} requests idle_policy "always" without wizard authority (${armedBy.progr})`;
      }

      if (typeof request.at !== "number" || !Number.isFinite(request.at)) {
        return `schedule ${request.id} has a non-finite delivery time`;
      }
      if (recordedNow === null) {
        return `schedule ${request.id} cannot be validated: the arming turn recorded no clock reading`;
      }
      if (request.at < recordedNow + SCHEDULE_MIN_LEAD_MS) {
        return `schedule ${request.id} fires in ${request.at - recordedNow}ms; the minimum lead time is ${SCHEDULE_MIN_LEAD_MS}ms`;
      }
      if (request.at > recordedNow + SCHEDULE_MAX_HORIZON_MS) {
        return `schedule ${request.id} is beyond the ${SCHEDULE_MAX_HORIZON_MS}ms horizon`;
      }

      // Same-scope only (CO16.1). `scopeOf` alone does not establish this:
      // the Scope DO answers "this scope" for every target it has no routing
      // hint for, and gateway routing never contributes schedule targets, so
      // a foreign target read as local. Require instead that this scope HOLDS
      // the target — a fact it can check against its own authority, with no
      // hint and no trust in the submitter.
      if (this.options.scopeOf) {
        const targetScope = this.options.scopeOf(request.call.target);
        if (targetScope !== null && targetScope !== this.scope) {
          return `schedule ${request.id} targets ${request.call.target} in scope ${targetScope}, not ${this.scope}`;
        }
      }
      // ...and MUST NOT be one this same turn destroys. Lifecycle cleanup
      // scans the queue before these entries are inserted, so a recycle and a
      // schedule in one transcript left a pending entry aimed at a tombstone.
      // Refusing is better than ordering the cleanup after the insert: arming
      // work for an object you are destroying in the same breath is a bug in
      // the caller, and silently dropping it would hide that.
      // BOTH directions, matching the queue cleanup: an entry aimed at a
      // recycled object, and one ARMED BY a recycled object. The second is
      // easy to miss and just as broken — the entry outlives the only object
      // whose namespace could cancel it, so nothing can ever reach it again.
      const recycledHere = new Set((submit.transcript.recycles ?? []).map((entry) => entry.object));
      if (recycledHere.has(request.call.target)) {
        return `schedule ${request.id} targets ${request.call.target}, which this same turn recycles`;
      }
      if (recycledHere.has(armedBy.thisObj)) {
        return `schedule ${request.id} is armed by ${armedBy.thisObj}, which this same turn recycles`;
      }

      // A target created by THIS turn is schedulable — but only if the create
      // actually lands here. Created cells route by the create's ANCHOR, so an
      // object anchored under something in another scope belongs to that
      // scope, and merely appearing in this transcript proves nothing. The
      // earlier check accepted any created id and armed foreign targets.
      const createdHere = (submit.transcript.creates ?? []).find((create) => create.object === request.call.target);
      const createLandsHere = createdHere !== undefined && this.createResolvesToThisScope(createdHere, transcript);
      const targetKnownHere =
        this.store.get(cellKey("object_lineage", request.call.target)) !== undefined || createLandsHere;
      if (!targetKnownHere) {
        return createdHere !== undefined
          ? `schedule ${request.id} targets ${request.call.target}, created in this turn but anchored outside ${this.scope}`
          : `schedule ${request.id} targets ${request.call.target}, which this scope does not hold`;
      }

      const bytes = scheduledTurnBytes(this.scheduledTurnFromRequest(request, this.scheduleAttribution(submit)));
      if (bytes > SCHEDULE_MAX_ENTRY_BYTES) {
        return `schedule ${request.id} serializes to ${bytes} bytes; the per-entry cap is ${SCHEDULE_MAX_ENTRY_BYTES}`;
      }
    }

    for (const entry of cancellations) {
      const armedBy = entry.armed_by;
      if (!armedBy) return `cancellation ${entry.id} carries no arming-frame provenance`;
      const separator = entry.id.indexOf(":");
      const namespace = separator < 0 ? "" : entry.id.slice(0, separator);
      if (namespace !== armedBy.thisObj && !this.isWizardRef(armedBy.progr)) {
        return `cancellation ${entry.id} is outside the calling object's namespace (${armedBy.thisObj})`;
      }
    }

    // Queue-level caps are checked against the POST-apply queue, so a turn
    // that replaces existing entries (the upsert form) is not charged twice.
    if (schedules.length > 0) {
      const pending = this.pendingScheduleSummary();
      const perObject = new Map(pending.perObject);
      let count = pending.count;
      let bytes = pending.bytes;
      for (const request of schedules) {
        const row = this.scheduledTurnFromRequest(request, this.scheduleAttribution(submit));
        const existing = pending.byId.get(request.id);
        if (existing !== undefined) {
          bytes -= existing.bytes;
          perObject.set(existing.owner, (perObject.get(existing.owner) ?? 1) - 1);
        } else {
          count += 1;
        }
        bytes += scheduledTurnBytes(row);
        const owner = request.armed_by?.thisObj ?? "";
        perObject.set(owner, (perObject.get(owner) ?? 0) + 1);
      }
      for (const entry of cancellations) {
        const existing = pending.byId.get(entry.id);
        if (!existing) continue;
        count -= 1;
        bytes -= existing.bytes;
        perObject.set(existing.owner, (perObject.get(existing.owner) ?? 1) - 1);
      }
      if (count > SCHEDULE_MAX_PER_SCOPE) {
        return `scope would hold ${count} pending schedules; the cap is ${SCHEDULE_MAX_PER_SCOPE}`;
      }
      if (bytes > SCHEDULE_MAX_SCOPE_BYTES) {
        return `scope schedule queue would hold ${bytes} bytes; the cap is ${SCHEDULE_MAX_SCOPE_BYTES}`;
      }
      for (const [owner, owned] of perObject) {
        if (owned > SCHEDULE_MAX_PER_OBJECT) {
          return `object ${owner} would hold ${owned} pending schedules; the per-object cap is ${SCHEDULE_MAX_PER_OBJECT}`;
        }
      }
    }

    return null;
  }

  /** The durable row for a validated request. Provenance is deliberately NOT
   * carried across: `armed_by` is validated above and discarded, so nothing
   * about the arming frame's authority survives into the fired turn (CO16.4). */
  private scheduledTurnFromRequest(
    request: NonNullable<EffectTranscript["schedules"]>[number],
    attribution?: { principal?: Principal; trace?: TraceContext }
  ): ScheduledTurn {
    return {
      id: request.id,
      at_logical_time: request.at,
      idle_policy: request.idlePolicy,
      call: {
        actor: request.call.actor,
        target: request.call.target,
        verb: request.call.verb,
        args: request.call.args as unknown[]
      },
      // AU3.2/AU2: attribution and trace are captured at ARMING time and ride
      // the durable row, so a turn that fires days later is still attributable
      // and still joins the originating trace. This is attribution only — it
      // never widens authority (CO16.4), and it is measured by the byte caps
      // because it is part of the stored row.
      ...(attribution?.principal !== undefined ? { principal: attribution.principal } : {}),
      ...(attribution?.trace !== undefined ? { trace: attribution.trace } : {})
    };
  }

  /**
   * Does a create in this transcript actually land in THIS scope?
   *
   * Creates route by anchor (the gateway classifies a created cell by the
   * anchor's scope), so the question is where the anchor lives — not whether
   * the id appears in the transcript. An unanchored create is self-hosted and
   * lands here; an anchored one lands wherever its anchor is classified,
   * which may be another scope entirely. Unknown anchors fail CLOSED: this is
   * the check that keeps a foreign object out of the local queue.
   */
  private createResolvesToThisScope(
    create: NonNullable<EffectTranscript["creates"]>[number],
    transcript: EffectTranscript,
    seen: ReadonlySet<string> = new Set()
  ): boolean {
    const anchor = create.anchor;
    // Unanchored creates are self-hosted: they land wherever they are
    // committed, which is here.
    if (anchor === null || anchor === undefined) return true;

    // Deliberately NOT `scopeOf`. That classifier answers with the
    // committing scope for anything it holds no routing hint for, and
    // create anchors are never added to those hints — so asking it whether
    // a foreign anchor is foreign returns "no" in production, which is how
    // the previous version of this check passed a test and shipped a hole.
    // Only authoritative local evidence counts.
    if (this.store.get(cellKey("object_lineage", anchor)) !== undefined) return true;

    // An anchor created by this same turn is legitimate if THAT create
    // itself lands here. Recursive, with a visited set so a cyclic anchor
    // chain terminates as "not local" rather than spinning.
    if (seen.has(anchor)) return false;
    const anchorCreate = (transcript.creates ?? []).find((entry) => entry.object === anchor);
    if (anchorCreate === undefined) return false;
    return this.createResolvesToThisScope(anchorCreate, transcript, new Set([...seen, anchor]));
  }

  /** Attribution captured from the ARMING turn, for the durable row. */
  private scheduleAttribution(submit: CommitSubmit): { principal?: Principal; trace?: TraceContext } {
    return {
      ...(submit.transcript.principal !== undefined ? { principal: submit.transcript.principal } : {}),
      ...(submit.transcript.trace !== undefined ? { trace: submit.transcript.trace } : {})
    };
  }

  /** Every pending row, in id order. The CO16.9 live introspection read
   * (`GET /net/schedules`) surfaces this; it is a live answer and may be
   * stale the instant it is returned. */
  pendingRows(): ScheduledTurn[] {
    return this.pendingScheduleRows().slice().sort((a, b) => a.at_logical_time - b.at_logical_time || a.id.localeCompare(b.id));
  }

  /** Every pending row. Bounded by the per-scope cap (CO16.7), so this is a
   * bounded read rather than an unbounded scan — which is what lets recycle
   * cancellation be a scan and need no secondary index. */
  private pendingScheduleRows(): ScheduledTurn[] {
    return this.options.durable ? this.options.durable.readScheduled() : [...this.scheduled.values()];
  }

  /** Current queue shape for the CO16.7 caps. Bounded by the per-scope cap,
   * so this is a bounded read, not an unbounded scan. */
  private pendingScheduleSummary(): {
    count: number;
    bytes: number;
    perObject: Map<string, number>;
    byId: Map<string, { bytes: number; owner: string }>;
  } {
    const rows = this.pendingScheduleRows();
    const perObject = new Map<string, number>();
    const byId = new Map<string, { bytes: number; owner: string }>();
    let bytes = 0;
    for (const row of rows) {
      const separator = row.id.indexOf(":");
      const owner = separator < 0 ? "" : row.id.slice(0, separator);
      const rowBytes = scheduledTurnBytes(row);
      bytes += rowBytes;
      perObject.set(owner, (perObject.get(owner) ?? 0) + 1);
      byId.set(row.id, { bytes: rowBytes, owner });
    }
    return { count: rows.length, bytes, perObject, byId };
  }

  /** Wizard test for an arming frame's programmer. Uses the same authority
   * cells the rest of validation reads, so it works on a sparse scope that
   * holds the object's lifecycle cell. Absent lineage fails CLOSED. */
  private isWizardRef(ref: string): boolean {
    const cell = this.store.get(cellKey("object_lineage", ref));
    const value = cell?.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const flags = (value as Record<string, unknown>).flags;
    if (!flags || typeof flags !== "object" || Array.isArray(flags)) return false;
    return (flags as Record<string, unknown>).wizard === true;
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


  /**
   * CO16.6 — does this scope have a live session subscriber?
   *
   * `while_active` entries do not fire while nobody is attached, which is what
   * keeps an ambient chain from billing a world forever in a room no one will
   * visit again. The test is a DELIVERY question, so it reads the space's
   * `session_subscribers` — the live audience — and deliberately not the
   * fanout/planner subscriber registry: a scope always has a planner
   * registered when scheduling works at all, so counting one would make
   * `while_active` a synonym for `always`.
   *
   * Hidden-roster service sessions count. They are absent from the social
   * projection but present for delivery, and something attached that will
   * receive the observation is exactly what this asks about.
   *
   * Unknown fails OPEN — an absent cell means "this scope does not publish an
   * audience here", not "nobody is present". Firing when nobody is watching
   * costs one turn; silently never firing is the failure mode this whole
   * design exists to remove.
   */
  hasLiveSubscribers(): boolean {
    const space = this.scope.startsWith("room:") ? this.scope.slice("room:".length) : this.scope;
    const cell = this.store.get(cellKey("property_cell", space, "session_subscribers"));
    if (!cell) return true;
    const payload = cell.value;
    const raw = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).value
      : payload;
    if (!Array.isArray(raw)) return true;
    return raw.length > 0;
  }

  /** Due turns this scope may deliver right now: everything due, minus
   * `while_active` entries in a scope with nobody attached. Parked entries
   * stay in the queue and the next accepted turn re-arms the alarm. */
  deliverableDue(nowLogical: number, limit?: number): { deliverable: ScheduledTurn[]; parked: ScheduledTurn[] } {
    const due = this.peekDue(nowLogical, limit);
    if (due.length === 0) return { deliverable: [], parked: [] };
    if (this.hasLiveSubscribers()) return { deliverable: due, parked: [] };
    const deliverable: ScheduledTurn[] = [];
    const parked: ScheduledTurn[] = [];
    for (const turn of due) {
      // Rows written before idle_policy existed read as `always`, which is
      // the behaviour they already had.
      if ((turn.idle_policy ?? "always") === "always") deliverable.push(turn);
      else parked.push(turn);
    }
    return { deliverable, parked };
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
  dueTurns(nowLogical: number, limit?: number, onlyIds?: ReadonlySet<string>): ScheduledTurn[] {
    // `onlyIds` exists for the CO16.6 idle filter: an entry that is DUE but
    // not DELIVERABLE (a `while_active` chain in an unattended scope) must
    // stay in the queue. Popping everything due and filtering afterwards
    // would silently drop exactly the entries the policy means to defer.
    const due = this.peekDue(nowLogical, limit).filter((turn) => onlyIds === undefined || onlyIds.has(turn.id));
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
    if (base.seq === this.headState.seq) {
      return base.hash === this.headState.hash && (
        base.generation === undefined ||
        this.headState.generation === undefined ||
        base.generation === this.headState.generation
      );
    }
    if (base.seq < 0 || base.seq > this.headState.seq) return false;
    for (let i = this.tail.length - 1; i >= 0; i -= 1) {
      const entry = this.tail[i];
      if (entry.seq === base.seq && entry.head_hash === base.hash) return true;
      if (entry.seq === base.seq + 1 && entry.base_hash === base.hash) return true;
      if (entry.seq < base.seq) break;
    }
    return false;
  }

  /** Exact generation equality is stronger than ordinary rolling-upgrade
   * head compatibility: complete-read compaction depends on seed/activation
   * mutations being visible even while `(seq, hash)` stays unchanged. */
  private baseIsExactCurrent(base: ScopeHead): boolean {
    return base.seq === this.headState.seq &&
      base.hash === this.headState.hash &&
      base.generation !== undefined &&
      this.headState.generation !== undefined &&
      base.generation === this.headState.generation;
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
