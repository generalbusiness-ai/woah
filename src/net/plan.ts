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
 * 5. Account the read-closure envelope bytes (CO7 ceilings). A breach is
 *    a plain Error: the planner built an oversized closure — a misplan
 *    bug to fix, not a divergence to repair (never a NetError code).
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
import { CellStore, cellKey, cellVersion, serializeTransfer, type Cell, type EpochStamp } from "./cells";
import { isNetError, netError } from "./errors";
import { selectCommitScope, type ScopeClassifier, type ScopeSelection } from "./route";
import type { CommitSubmit, ScopeHead } from "./scope";
import { sessionWriter } from "./sessions";
import { applyTranscript, netCellKeyFor, type EffectTranscript, type TranscriptRead, type TranscriptWrite } from "./transcript";

/** CO7/CO10 envelope byte ceilings, enforced at plan time. */
export const WARM_ENVELOPE_BYTE_LIMIT = 64 * 1024;
export const CROSS_SCOPE_ENVELOPE_BYTE_LIMIT = 256 * 1024;

export type PlanTurnInput = {
  call: ShadowTurnCall;
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
  /** Lineage keys the receiver universally holds (CO15: the catalog
   * scope's closure is receiver-known in every transfer — class chains
   * never reship). The read closure omits these cells and declares them
   * `assumes_known` instead; only `object_lineage:*` keys belong here.
   * The function form is invoked with the PLANNING STORE (the seed slice
   * under slicePlanning) once the run settles, so a caller can classify
   * just the lineage keys the plan can actually reference instead of
   * scanning its whole view per turn (ready-to-scale blocker #1). */
  receiverKnown?: ReadonlySet<string> | ((planStore: CellStore) => ReadonlySet<string>);
  /** Phase 1 (slice-based planning): when true, the planner runs the VM
   * against the turn's SEED SLICE (actor/session/target + their class
   * chain), slice-cloned per attempt from the live view's indexes and
   * grown on a sparse miss — so the WHOLE warm turn (clone, execution,
   * rewrite, scratch, closure) costs O(read-set), not O(view) (blocker
   * #1). Genuinely-absent cells still escape as E_MISSING_STATE to the
   * gateway's pull path. Default (absent/false) plans against one full
   * view clone — byte-identical to the pre-slice path, so non-turn
   * callers (session mint, tests) are unaffected. */
  slicePlanning?: boolean;
  /** Bounded owner-derived rows needed by catalog reads that are not ordinary
   * authority cells in this gateway's cache (currently room presence). They
   * exist only in the ephemeral planning snapshot and never become gateway
   * state or a second write path. */
  planningProjectionCells?: readonly Cell[];
  /** One authority-read compact roster value, installed only in the
   * ephemeral execution world for generic room_roster(space) reads. */
  planningRoomRoster?: { room: string; rows: readonly Record<string, unknown>[] };
};

export type PlanTurnResult = {
  submit: CommitSubmit;
  selection: ScopeSelection;
  /** UTF-8 bytes of the full CO7 envelope (transcript + read-closure). */
  envelopeBytes: number;
  /** The submitted transcript (rewritten reads, commit-scope target). */
  transcript: EffectTranscript;
  /** Phase 0 / CO10: the number of cells fed to `planningWorldFromCells`
   * — the planner's INPUT size, the thing that scales with view size on
   * the current (pre-slice) path and must stay ~read-set once planning is
   * slice-based (the `plan_cells` structural counter). Sourced from the
   * exact array so it measures the resident-view clone/rebuild CPU, not
   * the post-hoc read closure. */
  planCells: number;
  /** Phase 0 (honesty): cells in the fix-6 SNAPSHOT the settled attempt
   * planned against. Under slicePlanning this is the seed SLICE (the
   * clone, scratch, rewrite and closure all operate on it), so it must
   * stay flat as the view grows — the load gate's blocker-#1 invariant.
   * On the default path it is the full `view.clone()`, O(view). */
  snapshotCells: number;
};

export async function planTurn(input: PlanTurnInput): Promise<PlanTurnResult> {
  const { call, view, planningScope, classifier, base, idempotencyKey, stamp } = input;

  // ONE consistent snapshot per planning attempt, taken synchronously
  // (fix 6: the version-laundering window). The cells the ephemeral world
  // executes against, the versions the recorded reads are rewritten with,
  // the post-state pre-image, and the read-closure bytes must all come
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
  // property holds for the attempt that settles (its execution, rewrite,
  // scratch and closure all read the SAME detached slice), while the copy
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
        record_authoring_cell_writes: true,
        ...(input.planningRoomRoster ? { room_rosters: [input.planningRoomRoster] } : {})
      });
    } catch (err) {
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
  const transcript = submitTranscript(withSession, planStore, selection.scope);

  // Planner-parity post-state: same apply, same prior cells (the settled
  // attempt's store is a read-through of authority, and every write
  // preimage is slice-resident — a materialized object carries ALL its
  // view cells), so an honest plan predicts the digest the scope derives
  // at CO4 step 10 — `postStateVersion` digests TOUCHED cells only, so a
  // slice-sized scratch predicts the same value the full store would —
  // and a stale view is caught by the read-version check before
  // post-state ever disagrees.
  const applied = applyTranscript(CellStore.scratchAuthorityFrom(planStore), transcript, stamp);

  // The function form classifies just the settled store's lineage keys
  // (O(slice)) instead of a per-turn whole-view scan (blocker #1).
  const receiverKnown =
    typeof input.receiverKnown === "function" ? input.receiverKnown(planStore) : input.receiverKnown ?? new Set<string>();
  const closure = serializeTransfer(readClosureCells(planStore, transcript, call, receiverKnown), receiverKnown);
  // The CO7 envelope is the transcript plus its read-closure; measure the
  // whole shape that would go on the wire.
  const envelopeBytes = new TextEncoder().encode(JSON.stringify({ transcript, closure })).byteLength;
  const warm = selection.scope === planningScope && selection.riders.length === 0;
  const limit = warm ? WARM_ENVELOPE_BYTE_LIMIT : CROSS_SCOPE_ENVELOPE_BYTE_LIMIT;
  if (envelopeBytes > limit) {
    throw new Error(
      `planner built an oversized ${warm ? "warm" : "cross-scope"} envelope: ${envelopeBytes} bytes > ${limit} (misplan bug — shrink the read closure, do not raise the ceiling)`
    );
  }

  return {
    submit: {
      kind: "woo.net.commit_submit.v1",
      scope: selection.scope,
      base,
      idempotency_key: idempotencyKey,
      transcript,
      post_state_version: applied.postStateVersion,
      stamp
    },
    selection,
    envelopeBytes,
    transcript,
    planCells: planInput.length,
    snapshotCells: planStore.size
  };
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
  if (transition && transition.session === session) {
    const priorRow = (prior?.value ?? {}) as Record<string, unknown>;
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
    ...(transition && transition.session === session && typeof transitionLineage?.name === "string"
      ? { sessionScopeTransition: { ...transition, actorName: transitionLineage.name } }
      : {})
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
function submitTranscript(recorded: EffectTranscript, view: CellStore, scope: string): EffectTranscript {
  const reads = recorded.reads.map((read) => {
    const key = netCellKeyFor(read.cell);
    // Projection reads (contents, CA4) keep their recorded version: they
    // are never authority cells and the scope skips them at step 7.
    if (key === null) return read;
    return { ...read, version: view.get(key)?.version ?? "absent" };
  });
  const { hash: _engineHash, ...body } = { ...recorded, reads, scope: scope as EffectTranscript["scope"] };
  return { ...body, hash: cellVersion(body) };
}

/**
 * The read-closure cell set (CO7): the actor row, the session row, every
 * read-set cell and write preimage present in the view, closed over
 * lineage (each referenced object's `object_lineage` plus its transitive
 * parent chain). Cells absent from the view ship nothing — their
 * absence is already encoded in the transcript's "absent" read versions.
 * Receiver-known lineage keys (CO15: the catalog closure) are walked for
 * their parents but never shipped — that is how class chains stay off
 * the wire. `serializeTransfer` then asserts the closure (E_LINEAGE =
 * planner bug).
 */
function readClosureCells(
  view: CellStore,
  transcript: EffectTranscript,
  call: ShadowTurnCall,
  receiverKnown: ReadonlySet<string>
): Cell[] {
  const keys = new Set<string>();
  const objects = new Set<string>();
  const add = (key: string | null, object?: string): void => {
    if (object !== undefined) objects.add(object);
    if (key !== null && view.has(key)) keys.add(key);
  };

  for (const read of transcript.reads) add(netCellKeyFor(read.cell), read.cell.object);
  for (const write of transcript.writes) add(netCellKeyFor(write.cell), write.cell.object);
  for (const move of transcript.moves) add(cellKey("object_live", move.object), move.object);
  for (const create of transcript.creates ?? []) {
    // A create ships no preimage (the object does not exist yet) but its
    // parent/destination must be resolvable at the receiver.
    if (create.parent) objects.add(create.parent);
    if (create.location) objects.add(create.location);
  }
  // CO7: the actor row and session rows ride in every envelope.
  add(cellKey("object_live", call.actor), call.actor);
  if (call.session) add(cellKey("session", call.session));

  // Lineage closure: walk each referenced object's parent chain through
  // the view. A parent missing from the view is caught by
  // serializeTransfer's assert if any of its cells are present.
  const pending = [...objects];
  const walked = new Set<string>();
  while (pending.length > 0) {
    const object = pending.pop() as string;
    if (walked.has(object)) continue;
    walked.add(object);
    const lineage = view.get(cellKey("object_lineage", object));
    if (!lineage) continue;
    // Receiver-known lineage never ships (CO15) but its parent chain is
    // still walked: a shipped child may hang below a known ancestor whose
    // OWN parent is not known and must therefore ride.
    if (!receiverKnown.has(lineage.key)) keys.add(lineage.key);
    const parent = (lineage.value as { parent?: unknown }).parent;
    if (typeof parent === "string") pending.push(parent);
  }

  return [...keys].sort().map((key) => view.get(key) as Cell);
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
 * closes transitively here — the read-closure walk and serializeTransfer's
 * dangle assert both depend on that. */
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

/** Missing-cell derivation shared by the thrown and recorded paths:
 * lineage+live for unmaterialized subjects; the specific verb page for a
 * verb miss whose object IS materialized (dispatch found the object but
 * not the page — inherited verbs resolve through the class chain, which
 * is receiver-known catalog closure and already in view). */
function sparseMissingKeys(
  code: string,
  value: unknown,
  view: CellStore,
  call: { target?: string; actor?: string }
): string[] {
  const missing = new Set<string>();
  const verbMiss = value as { obj?: unknown; name?: unknown } | null;
  if (code === "E_VERBNF" && typeof verbMiss?.obj === "string" && typeof verbMiss?.name === "string") {
    if (!view.has(cellKey("verb_bytecode", verbMiss.obj, verbMiss.name))) {
      missing.add(cellKey("verb_bytecode", verbMiss.obj, verbMiss.name));
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
    if (!view.has(cellKey("object_lineage", ref))) {
      missing.add(cellKey("object_lineage", ref));
      missing.add(cellKey("object_live", ref));
    }
  }
  return [...missing];
}
