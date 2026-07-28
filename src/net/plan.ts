/**
 * planTurn — the gateway planner (coherence.md CO1 GATEWAY, CO2.3, CO7;
 * kickoff step 8).
 *
 * One planning pass, engine-import-free (the VM enters via bridge.ts):
 *
 * 1. Assemble a sparse planning world from the gateway's derived view
 *    (CO5 copy #2) and run the turn on the ephemeral executor.
 * 2. **Version rule:** rewrite every recorded read version through the
 *    view's net cells. The ephemeral world's engine-recorded versions
 *    (prop/verb counters, structural hashes) are meaningless to net —
 *    the view's content addresses are what the scope validates against
 *    (CO2.4), so view-based rewrite preserves staleness detection and
 *    engine counters never leak into net.
 * 3. Select the commit scope from the write set (route.ts, CO2.3).
 * 4. Predict `post_state_version` by running the SAME applyTranscript
 *    the scope runs, against an authority-role scratch copy of the view
 *    (CellStore.scratchAuthorityFrom — planner parity only, discarded).
 *
 * Envelope bytes (CO7 ceilings) are NOT accounted here: the committing
 * scope validates read versions and attestations and never re-executes
 * bytecode, so no read state ships with a submit. The gateway measures
 * the ACTUAL serialized submit RPC body and enforces the ceiling
 * immediately before the RPC (scope.ts assertEnvelopeCeiling).
 *
 * The caller (gateway loop) submits the returned CommitSubmit; a
 * retryable rejection's `mismatched_reads` names exactly the view cells
 * to refresh before re-planning (the repair loop the CO12.4 differential
 * gate builds on).
 */
import {
  planningWorldFromCells,
  runShadowTurnCallTranscript,
  storeCells,
  type SerializedFromCellsOptions,
  type ShadowTurnCall
} from "./bridge";
import type { Principal } from "./attribution";
import { CellStore, cellKey, cellVersion, type Cell, type EpochStamp } from "./cells";
import type { TraceContext } from "./trace";
import { isNetError, netError, type NetError } from "./errors";
import { compactNetLiveAudience, type LiveAudience } from "./live";
import type { OrderedNeighborsQuery, OrderedNeighborsRequest, OrderedProjectionKey } from "./ordered-edges";
import { validReplayPageQuery, type ReplayPageQuery } from "./replay-pages";
import { selectCommitScope, type ScopeClassifier, type ScopeSelection } from "./route";
import { REPLAY_OUTPUT_BYTE_CAP, type CommitSubmit, type ScopeHead } from "./scope";
import { sessionWriter } from "./sessions";
import { applyTranscript, isSequencedAllocationCell, netCellKeyFor, type EffectTranscript, type TranscriptRead, type TranscriptWrite } from "./transcript";

export type PlanTurnInput = {
  call: ShadowTurnCall;
  /** AU3.2 principal, stamped by the gateway at the auth boundary. The
   * planner folds it into the transcript BODY so it participates in the
   * transcript hash and survives into the durable record. */
  principal?: Principal;
  /** AU2 trace context (adopted or minted at the gateway), folded into
   * the transcript body alongside the principal. */
  trace?: TraceContext;
  /** The gateway's derived planning view (CO5 copy #2). */
  view: CellStore;
  /** The scope the session plans in (the read-only/ride-along fallback). */
  planningScope: string;
  classifier: ScopeClassifier;
  /** The scope head the view was installed at — the base the submit
   * names, so a moved-on scope rejects stale_head (CO4). */
  base: ScopeHead;
  /** Caller-stable turn identity: a replayed submit returns the recorded
   * reply (CO2.5). */
  idempotencyKey: string;
  stamp: EpochStamp;
  /** World counters for the ephemeral planning world. Counters are host
   * state, not cells: a turn that CREATES must plan with the owning
   * scope's current objectCounter, or the planned id diverges from the
   * id the authority would allocate (ids are `obj_<scope>_<counter>` —
   * deterministic given the counter). Turns that do not create run fine
   * at the bridge defaults. */
  counters?: SerializedFromCellsOptions;
  /** The gateway has a COMPLETE copy of `scope` at the submit base head.
   * When selection stays on that scope, the base-head CAS covers every
   * same-scope read, so their per-cell entries may be omitted from the wire
   * transcript. Foreign/session reads remain explicit and attested. */
  compactOwnedReads?: { scope: string };
  /** Phase 1 (slice-based planning): when true, the planner runs the VM
   * against the turn's SEED SLICE (actor/session/target + their class
   * chain), slice-cloned per attempt from the live view's indexes and
   * grown on a sparse miss — so the WHOLE warm turn (clone, execution,
   * rewrite, scratch) costs O(read-set), not O(view) (blocker
   * #1). Genuinely-absent cells still escape as E_MISSING_STATE to the
   * gateway's pull path. Default (absent/false) plans against one full
   * view clone — byte-identical to the pre-slice path, so non-turn
   * callers (session mint, tests) are unaffected. */
  slicePlanning?: boolean;
  /** Objects the gateway has already repaired earlier in THIS turn (a
   * read-version-mismatch refresh or an E_MISSING_STATE pull). The
   * two-level retry rebuilds the seed slice from scratch on every
   * re-plan, so without this the slice would DROP the freshly-pulled
   * cells and the VM would re-read the same instance property at its
   * CLASS DEFAULT — stamping the read version "absent" and re-triggering
   * the identical mismatch, oscillating to E_BUDGET. (The canonical
   * trigger is a contents/sibling scan reading a sibling item's
   * non-default `parent`/`position`: the object is surfaced by the
   * contents projection but its own property cells were never seeded, so
   * the default read looks valid and never escapes as a miss.) Seeding
   * each repaired object's full view cell set makes the repair STICKY
   * across re-plans so the turn converges. Bounded to the read-set that
   * actually mismatched — never a whole-view or whole-room pull; a
   * genuinely-default read never mismatches, never refreshes, and so
   * never becomes sticky. */
  seedObjects?: ReadonlySet<string>;
  /** Bounded owner-derived rows needed by catalog reads that are not ordinary
   * authority cells in this gateway's cache (currently room presence). They
   * exist only in the ephemeral planning snapshot and never become gateway
   * state or a second write path. */
  planningProjectionCells?: readonly Cell[];
  /** One authority-read compact roster value, installed only in the
   * ephemeral execution world for generic room_roster(space) reads. */
  planningRoomRoster?: { room: string; rows: readonly Record<string, unknown>[] };
  /** Owner-computed ordered-children values (one per container + parent), installed only
   * in the ephemeral execution world for generic ordered_children(parent, container)
   * reads. The ordering analogue of planningRoomRoster; keeps sibling order
   * out of the O(N)-edge-cell read set. */
  planningOrderedChildren?: readonly { container: string; parent: string | null; scope: string; rows: readonly Record<string, unknown>[]; version: string }[];
  /** Owner-answered bounded neighbour queries (P2.4), installed only in the
   * ephemeral execution world for generic ordered_neighbors(parent, query, container)
   * reads. Each carries the SAME authority ordering `version` a full
   * projection would. `container` disambiguates null-root queries, so the attestation below serializes concurrent
   * same-parent mutations identically — the answer is just O(1) instead of
   * O(width). */
  planningOrderedNeighbors?: readonly { container: string; query: OrderedNeighborsQuery; scope: string; value: Record<string, unknown>; version: string }[];
  /** Owner-served committed replay pages (sequenced-log.md SL4), one per
   * exact `(space, from, limit)` query, installed only in the ephemeral
   * execution world for `space:replay(from, limit)` reads. `space` is the
   * SEMANTIC space id; `scope` is the owning authority the page was
   * fetched from; `version` is the page's authority content address (the
   * attestation below carries it, so a committed-log append between plan
   * and submit invalidates the read). `entries` are already in the
   * planning shape (no per-entry space key). */
  planningReplayPages?: readonly { space: string; from: number; limit: number; scope: string; entries: readonly Record<string, unknown>[]; version: string }[];
};

export type PlanTurnResult = {
  submit: CommitSubmit;
  selection: ScopeSelection;
  /** The submitted transcript (rewritten reads, commit-scope target). */
  transcript: EffectTranscript;
  /** True when the submitted transcript used complete-head read compaction. */
  ownedReadsCompacted: boolean;
  /** Phase 0 / CO10: the number of cells fed to `planningWorldFromCells`
   * — the planner's INPUT size, the thing that scales with view size on
   * the current (pre-slice) path and must stay ~read-set once planning is
   * slice-based (the `plan_cells` structural counter). Sourced from the
   * exact array so it measures the resident-view clone/rebuild CPU. */
  planCells: number;
  /** Phase 0 (honesty): cells in the fix-6 SNAPSHOT the settled attempt
   * planned against. Under slicePlanning this is the seed SLICE (the
   * clone, scratch and rewrite all operate on it), so it must
   * stay flat as the view grows — the load gate's blocker-#1 invariant.
   * On the default path it is the full `view.clone()`, O(view). */
  snapshotCells: number;
  /** Non-authoritative routing hints computed by the direct-call runtime.
   * They never enter the transcript/hash; a scope uses them only after it
   * validates an effect-free direct turn, then discards them after live
   * best-effort fanout. */
  liveAudience?: LiveAudience;
};

export async function planTurn(input: PlanTurnInput): Promise<PlanTurnResult> {
  const { call, view, planningScope, classifier, base, idempotencyKey, stamp } = input;

  // ONE consistent snapshot per planning attempt, taken synchronously
  // (fix 6: the version-laundering window). The cells the ephemeral world
  // executes against, the versions the recorded reads are rewritten with,
  // and the post-state pre-image must all come
  // from the same instant: the VM run below yields the event loop, and a
  // concurrent fanout/refresh mutating the live view mid-plan would
  // otherwise stamp the reads with versions the execution never saw —
  // laundering a stale plan past the scope's read-version check.
  //
  // Default mode takes the snapshot ONCE, before the first await — the
  // full `view.clone()`, byte-identical to the pre-slice path. Slice mode
  // (Phase 1 / ready-to-scale blocker #1) instead clones ONLY the seed
  // slice's keys, re-cloned from the live view at the top of every
  // attempt: each clone is synchronous, so the fix-6 single-instant
  // property holds for the attempt that settles (its execution, rewrite
  // and scratch all read the SAME detached slice), while the copy
  // cost is O(read-set), never O(view).
  const sliceMode = input.slicePlanning === true;
  const snapshot = sliceMode ? null : view.clone();
  if (snapshot) for (const cell of input.planningProjectionCells ?? []) snapshot.install(cell);
  // Phase 1 seed: the actor/session/target dispatch closure, built from
  // the LIVE view's object/session indexes (O(seed)). A sparse miss grows
  // it below — in-memory, never an RPC — so a warm turn (its reads
  // resident) converges here with zero repair rounds and plan_cells ~
  // read-set. Only a cell genuinely absent from the view escapes as
  // E_MISSING_STATE to the gateway's pull path.
  const seed = sliceMode ? buildSeedSlice(view, call) : null;
  if (seed) {
    for (const cell of input.planningProjectionCells ?? []) {
      seed.add(cell.key);
      if (cell.kind === "object_lineage") {
        const parent = (cell.value as { parent?: unknown } | null)?.parent;
        if (typeof parent === "string" && parent) {
          for (const parentCell of view.cellsForObject(parent)) seed.add(parentCell.key);
        }
      }
    }
    // Sticky repairs (see PlanTurnInput.seedObjects): every cell the live
    // view holds for a previously-repaired object rides in the seed, so a
    // re-plan reads the authority's real property values instead of
    // re-defaulting them and re-triggering the same read-version mismatch.
    let seededRepair = false;
    for (const object of input.seedObjects ?? []) {
      for (const cell of view.cellsForObject(object)) {
        if (!seed.has(cell.key)) {
          seed.add(cell.key);
          seededRepair = true;
        }
      }
    }
    // A repaired cell may reference further objects (an item's parent, an
    // undo record's target); close over them the same way a grown miss does.
    if (seededRepair) expandObjRefs(seed, view);
  }
  // A mid-attempt view mutation can make an attempt retry without growing
  // the seed (the re-clone picks up the changed cells). Monotonic seed
  // growth bounds the growth rounds; this caps the retry-without-growth
  // tail so a pathological flap cannot spin the loop forever.
  let retriesWithoutGrowth = 0;
  const RETRY_WITHOUT_GROWTH_LIMIT = 8;
  let run: Awaited<ReturnType<typeof runShadowTurnCallTranscript>> | undefined;
  let planStore: CellStore | undefined;
  let planInput: Cell[] = [];
  for (;;) {
    // The attempt's fix-6 snapshot: the seed slice (slice mode) or the
    // one full snapshot (default — no extra copy).
    const attemptStore = sliceMode && seed ? view.cloneSlice(seed) : (snapshot as CellStore);
    if (sliceMode) {
      for (const cell of input.planningProjectionCells ?? []) {
        if (seed?.has(cell.key)) attemptStore.install(cell);
      }
    }
    planInput = storeCells(attemptStore);
    const world = planningWorldFromCells(planInput, input.counters);
    let attemptRun: Awaited<ReturnType<typeof runShadowTurnCallTranscript>>;
    try {
      attemptRun = await runShadowTurnCallTranscript(world, call, {
        require_room_roster_projection: true,
        require_ordered_children_projection: true,
        require_replay_page_projection: true,
        record_authoring_cell_writes: true,
        // Net profile: provisioning audit is the commit record, never a
        // catalog $system.wizard_actions write (audit.md AU1).
        suppress_provisioning_audit: true,
        ...(input.planningRoomRoster ? { room_rosters: [input.planningRoomRoster] } : {}),
        ...(input.planningOrderedChildren && input.planningOrderedChildren.length > 0
          ? { ordered_children: input.planningOrderedChildren.map((o) => ({ container: o.container, parent: o.parent, rows: o.rows })) }
          : {}),
        ...(input.planningOrderedNeighbors && input.planningOrderedNeighbors.length > 0
          ? { ordered_neighbors: input.planningOrderedNeighbors.map((n) => ({ container: n.container, query: n.query, value: n.value })) }
          : {}),
        ...(input.planningReplayPages && input.planningReplayPages.length > 0
          ? { replay_pages: input.planningReplayPages.map((p) => ({ space: p.space, from: p.from, limit: p.limit, entries: p.entries })) }
          : {})
      });
    } catch (err) {
      // An ordered-children projection miss escapes to the gateway's
      // ordered-children repair path (it fetches the named parent's owner
      // projection and re-plans) rather than the cell-pull path — there is
      // no cell to grow from the view. Defensive: the builtin miss is
      // normally RECORDED, handled just below the try; this covers the throw.
      const thrownOrdered = orderedChildrenMiss(err as { code?: unknown; value?: unknown } | null);
      if (thrownOrdered) throw orderedChildrenMissState(thrownOrdered);
      const thrownNeighbors = orderedNeighborsMiss(err as { code?: unknown; value?: unknown } | null);
      if (thrownNeighbors) throw orderedNeighborsMissState(thrownNeighbors);
      const thrownReplay = replayPageMiss(err as { code?: unknown; value?: unknown } | null);
      if (thrownReplay) throw replayPageMissState(thrownReplay);
      // A sparse miss vs the attempt's slice. Grow from the LIVE view and
      // re-run; if nothing is growable the cell is genuinely absent —
      // surface the miss against the VIEW so the gateway pulls exactly
      // those keys (CO2.6/VTN10.1: repairable E_MISSING_STATE, never a raw
      // engine E_OBJNF/E_VERBNF the repair loop cannot act on).
      const missVsAttempt = translateSparsePlanningThrow(err, attemptStore, call);
      if (!sliceMode || !seed) throw missVsAttempt;
      if (growSeedFromView(missVsAttempt, view, seed)) {
        expandObjRefs(seed, view); // a grown cell may carry obj-refs
        continue;
      }
      // No growth: either the keys are genuinely absent from the live view
      // (escape to the pull path) or they landed in the view mid-attempt
      // (already seeded — the next re-clone picks them up; bounded retry).
      if (missIsResidentNow(missVsAttempt, view) && retriesWithoutGrowth < RETRY_WITHOUT_GROWTH_LIMIT) {
        retriesWithoutGrowth += 1;
        continue;
      }
      throw translateSparsePlanningThrow(err, view, call);
    }
    // An ordered-children projection miss the engine RECORDED (the normal
    // path — the builtin throw is caught by dispatch and stored as the
    // transcript error). No cell to grow: escape immediately to the gateway's
    // ordered-children repair, naming the parent(s) whose projection to fetch.
    const recordedOrdered = orderedChildrenMiss(attemptRun.transcript.error as { code?: unknown; value?: unknown } | undefined);
    if (recordedOrdered) throw orderedChildrenMissState(recordedOrdered);
    const recordedNeighbors = orderedNeighborsMiss(attemptRun.transcript.error as { code?: unknown; value?: unknown } | undefined);
    if (recordedNeighbors) throw orderedNeighborsMissState(recordedNeighbors);
    const recordedReplay = replayPageMiss(attemptRun.transcript.error as { code?: unknown; value?: unknown } | undefined);
    if (recordedReplay) throw replayPageMissState(recordedReplay);
    // CO2.6 second half: the engine RECORDS a dispatch miss in the
    // transcript rather than throwing. Same grow-or-escape vs the slice.
    const recordedVsAttempt = sparseMissFromRecordedError(attemptRun.transcript, attemptStore);
    if (recordedVsAttempt) {
      if (!sliceMode || !seed) throw recordedVsAttempt;
      if (growSeedFromView(recordedVsAttempt, view, seed)) {
        expandObjRefs(seed, view);
        continue;
      }
      if (missIsResidentNow(recordedVsAttempt, view) && retriesWithoutGrowth < RETRY_WITHOUT_GROWTH_LIMIT) {
        retriesWithoutGrowth += 1;
        continue;
      }
      const recordedVsView = sparseMissFromRecordedError(attemptRun.transcript, view);
      if (recordedVsView) throw recordedVsView;
    }
    run = attemptRun;
    planStore = attemptStore;
    break;
  }
  // The loop only breaks after a successful, sparse-miss-free run.
  if (!run || !planStore) throw new Error("planner loop exited without a run (unreachable)");

  // CO14: every planned submit carries its session read (and a
  // transition-carrying turn folds the session-cell write) BEFORE scope
  // selection, so the folded write participates in the write-set routing.
  const withSession = foldSessionEffects(run.transcript, planStore, call);
  const selection = selectCommitScope(withSession, planningScope, classifier);
  // Sequenced seq-allocation ownership (SL1): the space's `next_seq`
  // advance can only apply — and serialize — at the scope that OWNS the
  // space, where the accepted turn also appends its committed log entry.
  // When the write set routes the commit elsewhere (CA3 pure movement at
  // the actor's cluster), the turn consumes NO seq: strip the allocation
  // read+write instead of shipping a foreign-cell rider, which would
  // CAS-collide with real allocations (a duplicate space seq) and chain
  // movement latency to the room's attestation freshness.
  const forSubmit = stripUnownedSequencedAllocation(withSession, selection.scope, classifier);
  const transcript = submitTranscript(forSubmit, planStore, selection.scope, {
    ...(input.principal ? { principal: input.principal } : {}),
    ...(input.trace ? { trace: input.trace } : {})
  });
  // P1.1: attest every ordered-children projection this plan was given (a read
  // can only resolve to a supplied projection — else it misses and repairs into
  // one), so the committing scope serializes concurrent same-parent inserts by
  // re-validating each ordering version. A supplied-but-unread projection is a
  // stable empty target ordering, so attesting it is harmless.
  // Bounded neighbour answers attest the SAME (scope, parent, version) a
  // full projection would — the authority re-derives one ordering version
  // per parent at submit either way. Dedupe identical triples; if the two
  // maps ever carried DIFFERENT versions for one parent (a mid-turn fetch
  // race), attest both — the authority check then rejects the stale one and
  // the turn re-plans, rather than a dedupe silently laundering it through.
  // The owning `scope` rides along (R3) so a cross-scope commit validates
  // foreign entries against that owner's attestation instead of skipping
  // them — and `parent: null` names exactly one scope's roots.
  const orderingReads = new Map<string, { container: string; parent: string | null; scope: string; version: string }>();
  for (const p of input.planningOrderedChildren ?? []) orderingReads.set(`${p.scope}\0${p.container}\0${p.parent ?? "\0root"}\0${p.version}`, { container: p.container, parent: p.parent, scope: p.scope, version: p.version });
  for (const n of input.planningOrderedNeighbors ?? []) orderingReads.set(`${n.scope}\0${n.container}\0${n.query.parent ?? "\0root"}\0${n.version}`, { container: n.container, parent: n.query.parent, scope: n.scope, version: n.version });
  if (orderingReads.size > 0) {
    transcript.orderingReads = [...orderingReads.values()];
  }
  // Replay pages attest identically (SL4): every page this plan was given
  // rides in `replayReads` with the authority content version it was
  // fetched at — a supplied-but-unread page is a stable window whose
  // attestation is harmless, and dual versions for one query (a mid-turn
  // fetch race) attest both so the authority rejects the stale one.
  const replayReads = new Map<string, { space: string; from: number; limit: number; scope: string; version: string }>();
  for (const p of input.planningReplayPages ?? []) {
    replayReads.set(`${p.scope}\0${p.space}\0${p.from}\0${p.limit}\0${p.version}`, { space: p.space, from: p.from, limit: p.limit, scope: p.scope, version: p.version });
  }
  if (replayReads.size > 0) {
    transcript.replayReads = [...replayReads.values()];
  }

  // Planner-parity post-state: same apply, same prior cells (the settled
  // attempt's store is a read-through of authority, and every write
  // preimage is slice-resident — a materialized object carries ALL its
  // view cells), so an honest plan predicts the digest the scope derives
  // at CO4 step 10 — `postStateVersion` digests TOUCHED cells only, so a
  // slice-sized scratch predicts the same value the full store would —
  // and a stale view is caught by the read-version check before
  // post-state ever disagrees.
  const applied = applyTranscript(CellStore.scratchAuthorityFrom(planStore), transcript, stamp);
  const ownedReadsCompacted = input.compactOwnedReads?.scope === selection.scope;
  const wireTranscript = compactTranscriptForSubmit(
    transcript,
    classifier,
    ownedReadsCompacted ? selection.scope : null
  );

  return {
    submit: {
      kind: "woo.net.commit_submit.v1",
      scope: selection.scope,
      base,
      idempotency_key: idempotencyKey,
      transcript: wireTranscript,
      post_state_version: applied.postStateVersion,
      stamp,
      ...(ownedReadsCompacted ? { owned_reads_compacted: true as const } : {}),
      ...replaySubmitOutput(transcript)
    },
    selection,
    transcript,
    ownedReadsCompacted,
    planCells: planInput.length,
    snapshotCells: planStore.size,
    ...(call.route === "direct" && run.frame.op === "result"
      ? {
          liveAudience: compactNetLiveAudience(run.frame)
        }
      : {})
  };
}

/**
 * CO2.5: carry the verb's return value to the authority as an unhashed
 * sibling, so a replayed submit can return the outcome of the execution that
 * actually committed instead of an empty success.
 *
 * Two deliberate withholdings, both reported rather than silent:
 *
 * - **Non-mutating turns.** A turn with no write, create, or move changed
 *   nothing, so re-issuing it under a fresh key is safe and costs the caller
 *   only a round trip. Read results are also the LARGE ones (a room listing,
 *   an ordered page), and every read envelope must keep its exact former size
 *   against the CO7 ceiling — this rule is what guarantees no existing turn
 *   moves closer to E_ENVELOPE.
 * - **Oversized results**, against REPLAY_OUTPUT_BYTE_CAP.
 *
 * In both cases `replay_result_omitted` marks that a value existed, so the
 * replay says "not retained" rather than reporting `null`.
 */
function replaySubmitOutput(
  transcript: EffectTranscript
): { replay_result?: unknown; replay_result_omitted?: true } {
  if (transcript.result === undefined) return {};
  const mutating =
    transcript.writes.length > 0 || transcript.creates.length > 0 || transcript.moves.length > 0;
  if (!mutating) return { replay_result_omitted: true };
  const encoded = JSON.stringify(transcript.result);
  // `undefined` here means "not JSON-representable" — retaining it would
  // record a value the replay could not return faithfully.
  if (encoded === undefined || encoded.length > REPLAY_OUTPUT_BYTE_CAP) {
    return { replay_result_omitted: true };
  }
  return { replay_result: transcript.result };
}

/**
 * The scope never executes bytecode and never consumes a successful return
 * value or state-probe closure. Keep those on the gateway for the client
 * response. When the gateway proves its whole owner copy is at the submit's
 * base head, the scope's existing stale-head check validates every owned read
 * as one generation; only foreign/session/allocation reads must still ride.
 */
function compactTranscriptForSubmit(
  transcript: EffectTranscript,
  classifier: ScopeClassifier,
  compactScope: string | null
): EffectTranscript {
  const retainedReads = compactScope === null
    ? transcript.reads
    : transcript.reads.filter((read) => {
        // Session authorization consumes the value, and sequenced allocation
        // consumes both version and claimed logical value. Never compact them.
        if (read.cell.kind === "session" || isSequencedAllocationCell(transcript, read.cell)) return true;
        try {
          return classifier.scopeOf(read.cell.object) !== compactScope;
        } catch {
          return true;
        }
      });
  // A read is a proof of one exact cell value/version, not a record of how
  // many times bytecode happened to consult that value. Repeated dispatches
  // can read the same immutable catalog verb thousands of times while
  // rendering one collection; keeping one byte-identical proof preserves
  // validation and prevents execution shape from amplifying the wire proof.
  // Distinct versions or values remain distinct and therefore still expose a
  // mid-turn authority change to the sequencer.
  const seenReads = new Set<string>();
  const reads = retainedReads.filter((read) => {
    const identity = cellVersion(read);
    if (seenReads.has(identity)) return false;
    seenReads.add(identity);
    return true;
  });
  const { hash: _hash, result: _result, stateProbes: _stateProbes, ...rest } = transcript;
  const body = { ...rest, reads };
  return { ...body, hash: cellVersion(body) } as EffectTranscript;
}

/**
 * CO14 session effects, folded in at plan time (before scope selection —
 * a folded write participates in write-set routing):
 *
 * 1. **Every planned submit carries its session read.** The engine
 *    recorder cannot emit session-kind cells (the vocabulary is net-only
 *    — transcript.ts), so when the call names a session and the recorded
 *    transcript lacks its read, append one versioned/valued from the plan
 *    snapshot. The scope's authorize step (CO4 step 1) validates it —
 *    owned or CO2.3-attested — and step 7 pins its freshness like any
 *    other read.
 * 2. **A session-scope transition folds into a session-cell write** (the
 *    CA8 lesson carried into net; CO14 "no separate presence write
 *    path"): value = the snapshot's prior session row merged with
 *    `activeScope: transition.to`, written by the actor's own frame. The
 *    committed cell is then the single source presence (CO13) derives
 *    from, in the SAME turn. Prior-row freshness is pinned by the folded
 *    read (rule 1 — a transition turn always names its session).
 */
function foldSessionEffects(recorded: EffectTranscript, snapshot: CellStore, call: ShadowTurnCall): EffectTranscript {
  const session = call.session ?? (typeof recorded.session === "string" ? recorded.session : null);
  if (!session) return recorded;
  const key = cellKey("session", session);
  const prior = snapshot.get(key);

  const reads = [...recorded.reads];
  if (!reads.some((read) => read.cell.kind === "session" && read.cell.object === session)) {
    reads.push({
      cell: { kind: "session", object: session },
      // submitTranscript rewrites this through the same snapshot; recorded
      // here too so the transcript is honest even before the rewrite.
      version: prior?.version ?? "absent",
      value: (prior?.value ?? null) as TranscriptRead["value"]
    });
  }

  const writes = [...recorded.writes];
  const transition = recorded.sessionScopeTransition;
  const transitionLineage = transition && transition.session === session
    ? snapshot.get(cellKey("object_lineage", transition.actor))?.value as { name?: unknown } | undefined
    : undefined;
  const priorRow = (prior?.value ?? {}) as Record<string, unknown>;
  if (transition && transition.session === session) {
    const value = { ...priorRow, id: session, actor: transition.actor, activeScope: transition.to };
    writes.push({
      cell: { kind: "session", object: session },
      value: value as TranscriptWrite["value"],
      op: "set",
      writer: sessionWriter(transition.actor, "session_transition")
    });
  }
  return {
    ...recorded,
    reads,
    writes,
    ...(transition && transition.session === session
      ? {
          sessionScopeTransition: {
            ...transition,
            ...(typeof transitionLineage?.name === "string" ? { actorName: transitionLineage.name } : {}),
            ...(priorRow.rosterVisible === false ? { rosterVisible: false as const } : {})
          }
        }
      : {})
  };
}

/**
 * Sequenced seq-allocation ownership (see the call site): keep the
 * engine-folded `next_seq` read+write only when the SELECTED commit scope
 * owns the sequencing space; otherwise remove both. Selection already
 * ignores the allocation (route.ts), so this never changes the chosen
 * scope — it only keeps the submitted write set honest about where a seq
 * was actually consumed. The classifier throw-fallback assumes the
 * production shape (a sequenced turn plans at its space's own scope).
 */
function stripUnownedSequencedAllocation(
  recorded: EffectTranscript,
  selectedScope: string,
  classifier: ScopeClassifier
): EffectTranscript {
  const allocation = recorded.writes.some((write) => isSequencedAllocationCell(recorded, write.cell));
  if (!allocation) return recorded;
  const space = recorded.space ?? recorded.scope;
  let spaceScope: string;
  try {
    spaceScope = classifier.scopeOf(space);
  } catch {
    spaceScope = selectedScope;
  }
  if (spaceScope === selectedScope) return recorded;
  return {
    ...recorded,
    reads: recorded.reads.filter((read) => !isSequencedAllocationCell(recorded, read.cell)),
    writes: recorded.writes.filter((write) => !isSequencedAllocationCell(recorded, write.cell))
  };
}

/**
 * The transcript the gateway submits: recorded reads re-versioned through
 * the view (the version rule), retargeted at the selected commit scope,
 * and re-content-addressed. `view` is the plan-time SNAPSHOT (fix 6),
 * never the live store — the rewrite must carry the versions the
 * execution actually saw.
 *
 * - Scope: the executor records the transport's audience placeholder for
 *   direct routes; CO2.3 makes the write set the scope authority
 *   (route.ts) and CO4 step 4 requires the submitted transcript to
 *   target the commit scope, so the planner stamps the selection in.
 * - Hash: the engine hash covered engine read versions; after the
 *   rewrite the hash must content-address what is actually submitted
 *   (the scope folds it into its head digest), so re-address canonically.
 */
function submitTranscript(
  recorded: EffectTranscript,
  view: CellStore,
  scope: string,
  audit?: { principal?: Principal; trace?: TraceContext }
): EffectTranscript {
  const reads = recorded.reads.map((read) => {
    const key = netCellKeyFor(read.cell);
    // Projection reads (contents, CA4) keep their recorded version: they
    // are never authority cells and the scope skips them at step 7.
    if (key === null) return read;
    return { ...read, version: view.get(key)?.version ?? "absent" };
  });
  const { hash: _engineHash, ...body } = {
    ...recorded,
    reads,
    scope: scope as EffectTranscript["scope"],
    // Semantic/authority identity split (sequenced-log.md SL4): the scope
    // rewrite above retargets the transcript at the commit AUTHORITY
    // ADDRESS, so a sequenced turn preserves its SEMANTIC sequencing space
    // here — the identity the authority's committed log entry keys on.
    // The engine recorded it as the pre-rewrite scope (the space the call
    // dispatched on). Present-only-for-sequenced keeps direct-route
    // transcript hashes unchanged.
    ...(recorded.route === "sequenced" ? { space: recorded.scope } : {}),
    // AU3.2/AU2: attribution and trace ride the hashed body (present-
    // only-when-set keeps principal-less transcript hashes unchanged).
    ...(audit?.principal ? { principal: audit.principal } : {}),
    ...(audit?.trace ? { trace: audit.trace } : {})
  };
  return { ...body, hash: cellVersion(body) };
}

/**
 * CO2.6/VTN10.1 translation for sparse planning (see the call site): an
 * engine throw whose subject object is simply not materialized in the
 * planning view becomes repairable E_MISSING_STATE naming the missing
 * lineage/live keys, so the gateway repair loop fetches the closure and
 * re-plans. A view that HOLDS the subject's lineage lets the engine
 * verdict stand (semantic absence), rethrown as a legible Error carrying
 * the engine code — never as an opaque [object Object].
 */
/**
 * Phase 1: the turn's SEED SLICE — the cells a warm turn's dispatch needs
 * before it reads anything object-specific, so the common case converges
 * with no growth round. Fixed-point over the actor's and target's class
 * chain (`lineageClosureKeys` is one-hop; the parent walk here is
 * transitive), plus every cell the view holds for each object in that
 * chain (live, lineage, property defs, verb pages — inherited dispatch
 * resolves locally) and the call's session cell. O(chain), never O(view):
 * the per-object and per-actor lookups ride the CellStore indexes
 * (blocker #1). Built synchronously from the LIVE view; planTurn's loop
 * then slice-clones the seed keys per attempt and grows on a miss.
 */
function buildSeedSlice(view: CellStore, call: ShadowTurnCall): Set<string> {
  const seed = new Set<string>();
  if (typeof call.session === "string" && call.session) seed.add(cellKey("session", call.session));
  // Seed the actor's OTHER session cells too. The move chain's body-move
  // decision (isPrimary / primarySessionForActor) ENUMERATES the planning
  // world's sessions — it is not a cell read the growth loop can catch —
  // so a slice holding only the CALLING session would mis-designate it as
  // the actor's primary and relocate the shared physical body. A sequenced
  // session transition must NOT write object_live (the actor's location is
  // the primary session's; a non-primary session's move is presence-only).
  // The session index makes this O(the actor's own sessions).
  if (typeof call.actor === "string" && call.actor) {
    for (const cell of view.sessionCellsForActor(call.actor)) seed.add(cell.key);
  }
  const chain = new Set<string>();
  for (const ref of [call.actor, call.target]) {
    if (typeof ref === "string" && ref) chain.add(ref);
  }
  for (;;) {
    let added = false;
    for (const object of [...chain]) {
      const lineage = view.get(cellKey("object_lineage", object));
      const parent =
        lineage && typeof lineage.value === "object" && lineage.value
          ? (lineage.value as { parent?: unknown }).parent
          : undefined;
      if (typeof parent === "string" && parent && !chain.has(parent)) {
        chain.add(parent);
        added = true;
      }
    }
    if (!added) break;
  }
  for (const object of chain) {
    for (const cell of view.cellsForObject(object)) seed.add(cell.key);
  }
  // ROSTER footprint (client-shell phase i): a room-verb turn matches
  // names against the room's CONTENTS, and the planning world recomputes
  // contents from slice-resident live cells — an absent member is
  // silently unmatchable (no miss the growth loop could catch). Seed
  // each named space's members MINIMALLY: lineage (the name), live (the
  // projection membership), and the aliases property (match vocabulary).
  // Full member cells enter only when the turn actually touches one
  // (growth/refresh), so the slice stays ~read-set + O(room roster) —
  // room-sized by design (CO11.1), never O(view).
  for (const space of [...chain]) {
    for (const member of view.membersAt(space)) {
      for (const suffix of [`object_lineage:${member}`, `object_live:${member}`, `property_cell:${member}:aliases`]) {
        if (view.has(suffix)) seed.add(suffix);
      }
    }
  }
  // Object refs named in the call's ARGUMENTS get their full cell set, the
  // same treatment `expandObjRefs` gives a ref found inside a cell value.
  //
  // Without this an argument object arrives with only the cells a NAMED miss
  // could ask for — lineage + live, plus the one verb page an E_VERBNF
  // identified — because the sparse repair loop can only grow around a key
  // some throw spelled out. There is no cell whose absence means "this object
  // has other verbs", so a turn that enumerates or APPENDS to an argument
  // object's verb list saw an empty list and could not tell that apart from an
  // object with no verbs. `verbs(id)` answered `[]` for a three-verb object,
  // and every verb authored over Net landed on slot 1
  // (notes/2026-07-27-net-verb-slots.md). Verb-slot allocation is still
  // authority-checked at commit (scope.ts §CO4 verb-slot rules) — this seeding
  // is what makes the common case converge in ONE round instead of a repair
  // cycle per verb.
  //
  // Every string ANYWHERE in the argument payload is a candidate ref (an id
  // nested in an options map is as much a subject as a positional one), and
  // only view-resident objects are seeded, so the cost is bounded by
  // (argument payload × that object's own cells) — the turn's own read-set
  // shape, never a scan of the view.
  const argRefs = new Set<string>();
  collectStrings(call.args ?? [], argRefs);
  for (const ref of argRefs) {
    if (!view.has(cellKey("object_lineage", ref))) continue; // not a resident object
    for (const cell of view.cellsForObject(ref)) seed.add(cell.key);
  }
  // Resolve object-valued properties so obj-ref reads land on materialized
  // objects: an unmaterialized ref target makes the engine attribute the
  // downstream property miss to the frame's OWN `this` (not the ref
  // target), which growth cannot then identify. One hop here; deeper refs
  // resolve as growth re-expands (planTurn's loop).
  expandObjRefs(seed, view);
  return seed;
}

/** Collect every string appearing anywhere in a cell value (property refs,
 * incl. object-valued defaults, live-location ids, etc.). */
function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

/** Seed the FULL cells of every RESIDENT object reachable through an
 * object-valued property in the seed, to a fixed point. A ref target needs
 * all its cells (not just lineage+live): the engine attributes a property
 * miss to the executing frame's OWN `this`, so a read of `ref.prop` whose
 * cell is absent mis-reports as `this.prop` and cannot be grown — the only
 * safe cure is to have the ref target's cells present before the VM reads
 * them. Bounded by the turn's reachable object graph (only view-resident
 * objects; unrelated objects are never referenced, so the slice stays
 * independent of view size — the Phase-0 invariant). A lineage payload's
 * `parent`/`owner` are strings too, so each seeded object's class chain
 * closes transitively here — dispatch through inherited verbs depends on
 * the whole chain being slice-resident. */
function expandObjRefs(seed: Set<string>, view: CellStore): void {
  for (;;) {
    const strings = new Set<string>();
    for (const key of seed) {
      const cell = view.get(key);
      if (cell) collectStrings(cell.value, strings);
    }
    let added = false;
    for (const ref of strings) {
      if (!view.has(cellKey("object_lineage", ref))) continue; // not a resident object
      for (const cell of view.cellsForObject(ref)) {
        if (!seed.has(cell.key)) {
          seed.add(cell.key);
          added = true;
        }
      }
    }
    if (!added) break;
  }
}

/**
 * Phase 1: promote a sparse miss's cells from the live view into the seed.
 * Returns true iff the seed grew (at least one missing key was resident in
 * the view and newly added) — the planTurn loop then re-clones the enlarged
 * slice with no RPC. A miss whose keys are all absent from the view returns
 * false, so the caller escapes to the pull path. The seed only ever grows,
 * so growth rounds are bounded by the turn's reachable key set.
 */
function growSeedFromView(miss: unknown, view: CellStore, seed: Set<string>): boolean {
  if (!isNetError(miss) || miss.code !== "E_MISSING_STATE") return false;
  const missing = Array.isArray(miss.detail.missing) ? (miss.detail.missing as string[]) : [];
  let grew = false;
  for (const key of missing) {
    if (view.has(key) && !seed.has(key)) {
      seed.add(key);
      grew = true;
    }
  }
  return grew;
}

/** True when every key a sparse miss names is resident in the live view
 * (planTurn's growthless-retry guard): the cells must have landed AFTER
 * the attempt's slice-clone (fanout/refresh interleaving with the VM's
 * awaits), so re-cloning — not pulling — is the correct next step. */
function missIsResidentNow(miss: unknown, view: CellStore): boolean {
  if (!isNetError(miss) || miss.code !== "E_MISSING_STATE") return false;
  const missing = Array.isArray(miss.detail.missing) ? (miss.detail.missing as string[]) : [];
  return missing.length > 0 && missing.every((key) => view.has(key));
}

/**
 * The parent(s) named by an ordered-children projection miss, or null if
 * `errorish` is not one. The world's require-getter throws
 * `E_NEED_ORDERED_CHILDREN` with `value = { parent }` when a verb reads a
 * parent's ordering that the sparse planning world does not hold; both the
 * thrown and the recorded (transcript.error) forms carry the same shape.
 */
function orderedChildrenMiss(errorish: { code?: unknown; value?: unknown } | null | undefined): OrderedProjectionKey[] | null {
  if (!errorish || errorish.code !== "E_NEED_ORDERED_CHILDREN") return null;
  const value = errorish.value as { container?: unknown; parent?: unknown } | null | undefined;
  const container = value && typeof value === "object" ? value.container : undefined;
  const parent = value && typeof value === "object" ? (value as { parent?: unknown }).parent : undefined;
  if (typeof container === "string" && container && (parent === null || typeof parent === "string")) return [{ container, parent }];
  return null; // malformed value — treat as a non-miss (terminal)
}

/** Package an ordered-children miss as the repairable escape the gateway's
 * turn loop recovers: a distinct `missing_ordered_children` detail keeps it
 * off the cell-pull path (which reads `detail.missing`). */
function orderedChildrenMissState(orderings: OrderedProjectionKey[]): NetError {
  return netError(
    "E_MISSING_STATE",
    `sparse planning ordered-children projection not yet fetched: ${orderings.map((o) => `${o.container}:${o.parent ?? "<root>"}`).join(", ")}`,
    { missing_ordered_children: orderings }
  );
}

/**
 * The bounded neighbour query named by an ordered-neighbours miss (P2.4), or
 * null if `errorish` is not one. The world's require-getter throws
 * `E_NEED_ORDERED_NEIGHBORS` with the FULL query in `value` when a mutation
 * reads a slot the sparse planning world cannot answer; both the thrown and
 * the recorded (transcript.error) forms carry the same shape.
 */
function orderedNeighborsMiss(errorish: { code?: unknown; value?: unknown } | null | undefined): OrderedNeighborsRequest | null {
  if (!errorish || errorish.code !== "E_NEED_ORDERED_NEIGHBORS") return null;
  const value = errorish.value as { container?: unknown; parent?: unknown; index?: unknown; exclude?: unknown; child?: unknown } | null | undefined;
  if (!value || typeof value !== "object") return null; // malformed — terminal
  if (typeof value.container !== "string" || !value.container) return null;
  const parent = value.parent === null || typeof value.parent === "string" ? value.parent : undefined;
  if (parent === undefined) return null;
  return {
    container: value.container,
    query: {
      parent,
      index: typeof value.index === "number" ? value.index : null,
      exclude: typeof value.exclude === "string" ? value.exclude : null,
      child: typeof value.child === "string" ? value.child : null
    }
  };
}

/** Package an ordered-neighbours miss as the repairable escape the gateway's
 * turn loop recovers with ONE O(1) authority fetch: a distinct
 * `missing_ordered_neighbors` detail keeps it off both the cell-pull path
 * (`detail.missing`) and the full-projection path (`missing_ordered_children`). */
function orderedNeighborsMissState(request: OrderedNeighborsRequest): NetError {
  return netError(
    "E_MISSING_STATE",
    `sparse planning ordered-neighbours answer not yet fetched for ${request.container}:${request.query.parent ?? "<root>"}`,
    { missing_ordered_neighbors: [request] }
  );
}

/**
 * The exact page query named by a replay-page miss (SL4), or null if
 * `errorish` is not one. The world's require-getter throws
 * `E_NEED_REPLAY_PAGE` with `value = {space, from, limit}` when a verb
 * reads a committed-log window the sparse planning world does not hold;
 * both the thrown and the recorded (transcript.error) forms carry the same
 * shape. Bounds are re-validated here so a malformed value is terminal,
 * never a fetch the authority would refuse.
 */
function replayPageMiss(errorish: { code?: unknown; value?: unknown } | null | undefined): ReplayPageQuery | null {
  if (!errorish || errorish.code !== "E_NEED_REPLAY_PAGE") return null;
  return validReplayPageQuery(errorish.value) ? { space: errorish.value.space, from: errorish.value.from, limit: errorish.value.limit } : null;
}

/** Package a replay-page miss as the repairable escape the gateway's turn
 * loop recovers with one authority page fetch: a distinct
 * `missing_replay_pages` detail keeps it off the cell-pull path. */
function replayPageMissState(query: ReplayPageQuery): NetError {
  return netError(
    "E_MISSING_STATE",
    `sparse planning replay page not yet fetched for ${query.space} from ${query.from} limit ${query.limit}`,
    { missing_replay_pages: [query] }
  );
}

function translateSparsePlanningThrow(err: unknown, view: CellStore, call: ShadowTurnCall): unknown {
  if (isNetError(err)) return err;
  const woo = err as { code?: unknown; message?: unknown; value?: unknown } | null;
  const code = typeof woo?.code === "string" ? woo.code : null;
  if (code === "E_OBJNF" || code === "E_VERBNF" || code === "E_NEED_STATE") {
    const missing = sparseMissingKeys(code, woo?.value, view, call);
    if (missing.length > 0) {
      return netError("E_MISSING_STATE", `sparse planning miss (${code}) — view lacks the subject's cells`, {
        engine_code: code,
        missing
      });
    }
  }
  if (code) {
    // Semantic absence (or an engine failure) with the subject present:
    // terminal, but legible — the engine code and message survive.
    return new Error(`planning failed: ${code}${typeof woo?.message === "string" ? ` ${woo.message}` : ""}`);
  }
  return err instanceof Error ? err : new Error(`planning failed: ${JSON.stringify(err)}`);
}

/** The recorded-error twin of translateSparsePlanningThrow (see the call
 * site): a completed transcript whose error names cells the view lacks. */
function sparseMissFromRecordedError(transcript: EffectTranscript, view: CellStore): unknown | null {
  const error = transcript.error as { code?: unknown; value?: unknown; trace?: Array<{ obj?: unknown }> } | undefined;
  const code = typeof error?.code === "string" ? error.code : null;
  if (code !== "E_OBJNF" && code !== "E_VERBNF" && code !== "E_PROPNF") return null;
  // E_PROPNF's value is the property NAME; the failing frame's `obj`
  // rides in the trace — reshape into the {obj, name} form the shared
  // derivation understands.
  const value =
    code === "E_PROPNF" && typeof error?.value === "string" && typeof error?.trace?.[0]?.obj === "string"
      ? { obj: error.trace[0].obj, name: error.value }
      : error?.value;
  const missing = sparseMissingKeys(code, value, view, transcript.call as { target?: string; actor?: string });
  if (missing.length === 0) return null;
  return netError("E_MISSING_STATE", `sparse planning miss (recorded ${code}) — view lacks the subject's cells`, {
    engine_code: code,
    missing
  });
}

/** The verb NAME an E_VERBNF value identifies, whatever key the raiser spelled
 * it under. The engine's canonical shape is `{ obj, name }` (world.ts
 * ownVerbResolve), but woocode `raise` sites and older natives have also used
 * `descriptor` and `verb`. Accepting all three keeps a spelling divergence a
 * repairable miss instead of a terminal E_VERBNF: naming no cell here makes the
 * planner treat a slice-absent verb page as semantic absence, which is how a
 * verb read on a NON-TARGET object (`set_verb_info(other, "hi", …)`) used to die
 * over Net even though the page was resident in the gateway view. A numeric slot
 * descriptor names no page and is deliberately not resolvable here. */
function verbMissName(value: { name?: unknown; descriptor?: unknown; verb?: unknown } | null): string | null {
  for (const candidate of [value?.name, value?.descriptor, value?.verb]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

/** Missing-cell derivation shared by the thrown and recorded paths:
 * lineage+live for unmaterialized subjects; the specific verb page for a
 * verb miss whose object IS materialized (dispatch found the object but
 * not the page — inherited verbs resolve through the class chain, which
 * is already resident in the view). */
function sparseMissingKeys(
  code: string,
  value: unknown,
  view: CellStore,
  call: { target?: string; actor?: string }
): string[] {
  const missing = new Set<string>();
  const verbMiss = value as { obj?: unknown; name?: unknown; descriptor?: unknown; verb?: unknown } | null;
  const verbName = code === "E_VERBNF" ? verbMissName(verbMiss) : null;
  if (verbName !== null && typeof verbMiss?.obj === "string") {
    if (!view.has(cellKey("verb_bytecode", verbMiss.obj, verbName))) {
      missing.add(cellKey("verb_bytecode", verbMiss.obj, verbName));
    }
  }
  if (code === "E_PROPNF" && typeof verbMiss?.obj === "string" && typeof verbMiss?.name === "string") {
    if (!view.has(cellKey("property_cell", verbMiss.obj, verbMiss.name))) {
      missing.add(cellKey("property_cell", verbMiss.obj, verbMiss.name));
    }
  }
  const refs = [
    typeof value === "string" ? value : null,
    typeof verbMiss?.obj === "string" ? verbMiss.obj : null,
    call.target ?? null,
    call.actor ?? null
  ].filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
  for (const ref of refs) {
    // A tombstone is a complete terminal answer, not missing lineage.
    // Re-requesting lineage after authority supplied the tombstone would turn
    // an honest E_OBJNF into a non-convergent repair loop.
    if (
      !view.has(cellKey("object_lineage", ref)) &&
      !view.has(cellKey("object_tombstone", ref))
    ) {
      missing.add(cellKey("object_lineage", ref));
      missing.add(cellKey("object_live", ref));
    }
  }
  return [...missing];
}
