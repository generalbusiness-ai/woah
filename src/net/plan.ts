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
import { selectCommitScope, type ScopeClassifier, type ScopeSelection } from "./route";
import type { CommitSubmit, ScopeHead } from "./scope";
import { applyTranscript, netCellKeyFor, type EffectTranscript } from "./transcript";

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
  const run = await runShadowTurnCallTranscript(world, call);

  const selection = selectCommitScope(run.transcript, planningScope, classifier);
  const transcript = submitTranscript(run.transcript, snapshot, selection.scope);

  // Planner-parity post-state: same apply, same prior cells (the snapshot
  // is a read-through of authority), so an honest plan predicts the
  // digest the scope derives at CO4 step 10 — and a stale view is caught
  // by the read-version check before post-state ever disagrees.
  const applied = applyTranscript(CellStore.scratchAuthorityFrom(snapshot), transcript, stamp);

  const closure = serializeTransfer(readClosureCells(snapshot, transcript, call));
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
 * `serializeTransfer` then asserts the closure (E_LINEAGE = planner bug).
 */
function readClosureCells(view: CellStore, transcript: EffectTranscript, call: ShadowTurnCall): Cell[] {
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
    keys.add(lineage.key);
    const parent = (lineage.value as { parent?: unknown }).parent;
    if (typeof parent === "string") pending.push(parent);
  }

  return [...keys].sort().map((key) => view.get(key) as Cell);
}
