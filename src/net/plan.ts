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
   * `assumes_known` instead; only `object_lineage:*` keys belong here. */
  receiverKnown?: ReadonlySet<string>;
};

export type PlanTurnResult = {
  submit: CommitSubmit;
  selection: ScopeSelection;
  /** UTF-8 bytes of the full CO7 envelope (transcript + read-closure). */
  envelopeBytes: number;
  /** The submitted transcript (rewritten reads, commit-scope target). */
  transcript: EffectTranscript;
};

export async function planTurn(input: PlanTurnInput): Promise<PlanTurnResult> {
  const { call, view, planningScope, classifier, base, idempotencyKey, stamp } = input;

  // ONE consistent snapshot, taken synchronously BEFORE the first await
  // (fix 6: the version-laundering window). The cells the ephemeral world
  // executes against, the versions the recorded reads are rewritten with,
  // the post-state pre-image, and the read-closure bytes must all come
  // from the same instant: the VM run below yields the event loop, and a
  // concurrent fanout/refresh mutating the live view mid-plan would
  // otherwise stamp the reads with versions the execution never saw —
  // laundering a stale plan past the scope's read-version check.
  const snapshot = view.clone();

  // Sparse execution against the snapshot's cells only (plus the caller's
  // counters for creates — see PlanTurnInput.counters).
  const world = planningWorldFromCells(storeCells(snapshot), input.counters);
  let run;
  try {
    run = await runShadowTurnCallTranscript(world, call);
  } catch (err) {
    // CO2.6/VTN10.1 at the planner boundary: under SPARSE execution a
    // lookup miss for an object the view simply does not hold must
    // surface as repairable E_MISSING_STATE, never as the engine's
    // semantic E_OBJNF/E_VERBNF (plain thrown objects that no repair
    // loop can act on). Only a view that HOLDS the object's lineage may
    // report semantic absence — then the engine's verdict stands.
    throw translateSparsePlanningThrow(err, snapshot, call);
  }

  // CO2.6 second half: the engine RECORDS dispatch failures in the
  // transcript (error field) rather than throwing — a recorded
  // E_OBJNF/E_VERBNF whose subject cells are absent from the view is the
  // same sparse miss as a thrown one, and submitting it would durably
  // commit a failed turn the repair loop could have converged. Only when
  // the view HOLDS the named page is the failure semantic (a real
  // verb-not-found is a legitimate committed outcome).
  const recordedMiss = sparseMissFromRecordedError(run.transcript, snapshot);
  if (recordedMiss) throw recordedMiss;

  // CO14: every planned submit carries its session read (and a
  // transition-carrying turn folds the session-cell write) BEFORE scope
  // selection, so the folded write participates in the write-set routing.
  const withSession = foldSessionEffects(run.transcript, snapshot, call);
  const selection = selectCommitScope(withSession, planningScope, classifier);
  const transcript = submitTranscript(withSession, snapshot, selection.scope);

  // Planner-parity post-state: same apply, same prior cells (the snapshot
  // is a read-through of authority), so an honest plan predicts the
  // digest the scope derives at CO4 step 10 — and a stale view is caught
  // by the read-version check before post-state ever disagrees.
  const applied = applyTranscript(CellStore.scratchAuthorityFrom(snapshot), transcript, stamp);

  const receiverKnown = input.receiverKnown ?? new Set<string>();
  const closure = serializeTransfer(readClosureCells(snapshot, transcript, call, receiverKnown), receiverKnown);
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
    transcript
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
  return { ...recorded, reads, writes };
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
