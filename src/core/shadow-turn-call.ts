import { createWorldFromSerialized } from "./bootstrap";
import { effectTranscriptFromRecordedTurn, type EffectTranscript } from "./effect-transcript";
import type { OrderedNeighborsQuery } from "./ordered-edge";
import type { PlanningWorld, PlanningWorldProvenance } from "./planning-world";
import type { SerializedWorld } from "./repository";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, Message, MetricEvent, ObjRef, WooValue } from "./types";
import { wooError } from "./types";
import {
  InMemoryTurnRecorder,
  type ActiveTurnRecorder,
  type RecordedTurn,
  type TurnRecorder,
  type TurnRecorderEvent,
  type TurnRoute,
  type TurnStart
} from "./turn-recorder";
import { shadowAtomHash, shadowReadCellPreimage, shadowWriteCellPreimage } from "./turn-key";
import type { WooWorld } from "./world";

export type ShadowTurnCall = {
  kind: "woo.turn_call.shadow.v1";
  id?: string;
  route: TurnRoute;
  scope: ObjRef;
  session?: string | null;
  actor: ObjRef;
  target: ObjRef;
  verb: string;
  args: WooValue[];
  body?: Record<string, WooValue>;
  /**
   * CO16.4/CO16.8 — set ONLY by the scheduler's dispatch path, never by any
   * client route. A client turn's fields are built one by one from parsed
   * parameters, so there is no path by which a request body reaches this;
   * that matters, because this marker relaxes the ingress check and presents
   * `caller = $system`.
   *
   * `direct_callable` is an INGRESS flag — "an outside client may invoke this
   * while bypassing sequencing" — and a scheduled turn is not outside. Left
   * unhandled, it made every scheduler-fired verb unreachable: the internals
   * are deliberately not direct_callable, so they answered E_DIRECT_DENIED,
   * and even past that they would have seen `caller = #-1` and refused their
   * own `$system` guard.
   */
  scheduled?: { id: string; at: number; fired_at: number };
};

export type ShadowTurnCallRun = {
  frame: AppliedFrame | DirectResultFrame | ErrorFrame;
  recorded: RecordedTurn;
  transcript: EffectTranscript;
  serializedAfter: SerializedWorld;
};

export type ShadowTurnCallTranscriptRun = Omit<ShadowTurnCallRun, "serializedAfter">;

export type ShadowTurnCallOptions = {
  allowed_atom_hashes?: Iterable<string>;
  // Net planning profile: install a no-op provisioning-audit sink so a
  // provisioning turn (promote/demote) does NOT write $system.wizard_actions —
  // a forbidden catalog mutation over the Net. The canonical Net audit is the
  // record minted from the committed transcript; only the in-memory/local
  // profile materializes into wizard_actions (audit.md AU1).
  suppress_provisioning_audit?: boolean;
  // CA11.2 occupancy-transition: the planning world's per-cell provenance, so the
  // movement-boundary check (world.movetoActorChecked) can tell whether a move
  // DESTINATION's lineage was admitted from an owner-authoritative row or from a
  // non-authoritative topology pre-seed (projection/cache/...). Only the sparse
  // gateway planning path supplies it; authoritative/diagnostic runs omit it and
  // the destination check is a no-op. It is the SAME map passed to
  // buildPlanningWorld for this turn.
  planning_cell_provenance?: PlanningWorldProvenance;
  // CA11.2: opt-in to the movement-destination owner-repair check. Set only by
  // the MCP gateway path (it has the force-owner `missing_state_repair` refresh);
  // the browser holder / REST relay attach provenance but leave this off so an
  // optimistic move into a derived row is not turned into an unrepairable error.
  enforce_movement_owner_repair?: boolean;
  // Sparse MCP gateway planning must not make command-resolution or visibility
  // decisions from a non-authoritative room `object_live` page. When enabled,
  // contents reads used by command matching, `visible_contents`, and `contents()`
  // raise repairable E_NEED_STATE for that container unless the planning
  // provenance says the live cell came from the owner. This is intentionally
  // separate from the movement check above: a stale contents cache can fail a
  // command before any movement boundary is reached.
  enforce_resolution_owner_repair?: boolean;
  // Optional forwarder for engine metric events. The ephemeral executor
  // world has no metrics hook by default, so events like `direct_call`,
  // `applied`, and `dispatch_resolved` get dropped on the v2 hot path
  // unless the caller threads its host's metric sink in here. Without
  // this, footprint-by-verb on /admin/ is permanently empty for v2
  // traffic. See notes/2026-05-18-v2-verb-metrics.md.
  onMetric?: (event: MetricEvent) => void;
  /** Transient compact owner projections; never persisted or exported. */
  room_rosters?: Array<{ room: string; rows: readonly Record<string, unknown>[] }>;
  /** Net's sparse planner must fail rather than derive a partial roster from
   * whichever session rows happened to materialize on this executor. */
  require_room_roster_projection?: boolean;
  /** Transient owner-computed ordered-children projections (one per
   * container/parent identity);
   * the ordering analogue of room_rosters. Never persisted or exported. */
  ordered_children?: Array<{ container: string; parent: string | null; rows: readonly Record<string, unknown>[] }>;
  /** Transient owner-answered bounded neighbour queries (P2.4) — one O(1)
   * `{count, index, before, after, child_index}` answer per exact query, so a
   * mutation under a wide parent never needs the full ordering above. */
  ordered_neighbors?: Array<{ container: string; query: OrderedNeighborsQuery; value: Record<string, unknown> }>;
  /** Net's sparse planner must fail rather than derive a partial ordering from
   * whichever edge cells happened to materialize (mirror of the roster flag).
   * Guards both ordered_children and ordered_neighbors reads. */
  require_ordered_children_projection?: boolean;
  /** Transient owner-served committed replay pages (sequenced-log.md SL4) —
   * one page per exact `(space, from, limit)` query, entries in the native
   * replay shape with SEMANTIC space identity. Never persisted or exported. */
  replay_pages?: Array<{ space: string; from: number; limit: number; entries: readonly Record<string, unknown>[] }>;
  /** Net's sparse planner must fail (repairable E_NEED_REPLAY_PAGE) rather
   * than answer a replay read from its intentionally-absent local log tail
   * (mirror of the roster/ordering flags). */
  require_replay_page_projection?: boolean;
  /** Net commits recorded cells rather than the ephemeral WooWorld. Enable
   * recorder events for runtime verb/property-definition authoring; legacy v2
   * execution keeps its existing materialization path until that stack is
   * removed. */
  record_authoring_cell_writes?: boolean;
};

// The VM-execution boundary. Accepts ONLY a `PlanningWorld` — a SerializedWorld
// that has passed the admission gate via `buildPlanningWorld` /
// `authoritativePlanningWorld`. The brand makes "went through the gate" a
// compile-time fact: no path can run the VM against a raw SerializedWorld, so a
// presentation stub or untagged cell is refused (repair-routed) before it reaches
// the VM. Enforcement lives in the constructor, not here.
export async function runShadowTurnCall(
  world: PlanningWorld,
  call: ShadowTurnCall,
  options: ShadowTurnCallOptions = {}
): Promise<ShadowTurnCallRun> {
  const built = createWorldFromSerialized(world, { persist: false });
  for (const roster of options.room_rosters ?? []) built.installRoomRosterProjection(roster.room, roster.rows);
  if (options.require_room_roster_projection) built.setRequireRoomRosterProjection(true);
  for (const ordering of options.ordered_children ?? []) built.installOrderedChildrenProjection(ordering.container, ordering.parent, ordering.rows);
  for (const neighbors of options.ordered_neighbors ?? []) built.installOrderedNeighborsProjection(neighbors.container, neighbors.query, neighbors.value);
  if (options.require_ordered_children_projection) built.setRequireOrderedChildrenProjection(true);
  for (const page of options.replay_pages ?? []) built.installReplayPageProjection(page.space, page.from, page.limit, page.entries);
  if (options.require_replay_page_projection) built.setRequireReplayPageProjection(true);
  if (options.record_authoring_cell_writes) built.setRecordAuthoringCellWrites(true);
  built.setMetricsHook(options.onMetric ?? null);
  if (options.planning_cell_provenance) built.setPlanningCellProvenance(options.planning_cell_provenance);
  if (options.enforce_movement_owner_repair) built.setEnforceMovementOwnerRepair(true);
  if (options.enforce_resolution_owner_repair) built.setEnforceResolutionOwnerRepair(true);
  return await runShadowTurnCallOnWorld(built, call, options);
}

export async function runShadowTurnCallTranscript(
  world: PlanningWorld,
  call: ShadowTurnCall,
  options: ShadowTurnCallOptions = {}
): Promise<ShadowTurnCallTranscriptRun> {
  // Durable commit scopes apply transcripts authoritatively, so planning and
  // commit-scope execution should not pay for a full executor post-state export
  // unless a caller explicitly needs that snapshot.
  const built = createWorldFromSerialized(world, { persist: false });
  for (const roster of options.room_rosters ?? []) built.installRoomRosterProjection(roster.room, roster.rows);
  if (options.require_room_roster_projection) built.setRequireRoomRosterProjection(true);
  for (const ordering of options.ordered_children ?? []) built.installOrderedChildrenProjection(ordering.container, ordering.parent, ordering.rows);
  for (const neighbors of options.ordered_neighbors ?? []) built.installOrderedNeighborsProjection(neighbors.container, neighbors.query, neighbors.value);
  if (options.require_ordered_children_projection) built.setRequireOrderedChildrenProjection(true);
  for (const page of options.replay_pages ?? []) built.installReplayPageProjection(page.space, page.from, page.limit, page.entries);
  if (options.require_replay_page_projection) built.setRequireReplayPageProjection(true);
  if (options.record_authoring_cell_writes) built.setRecordAuthoringCellWrites(true);
  if (options.onMetric) built.setMetricsHook(options.onMetric);
  if (options.planning_cell_provenance) built.setPlanningCellProvenance(options.planning_cell_provenance);
  if (options.enforce_movement_owner_repair) built.setEnforceMovementOwnerRepair(true);
  if (options.enforce_resolution_owner_repair) built.setEnforceResolutionOwnerRepair(true);
  return await runShadowTurnCallOnWorldTranscript(built, call, options);
}

// TRUSTED execution-world capability (A3.2): runs the VM against an already-built
// WooWorld. This is POST-admission — every path that reaches it first admitted the
// source: the serialized-boundary runners above build from a branded PlanningWorld,
// and the executor (shadow-turn-exec `shadowExecutionWorld`) builds its WooWorld via
// buildPlanningWorld (sparse) or by the authoritative_state capability. Do NOT call
// these with a WooWorld assembled from un-admitted serialized state — that would
// reintroduce the bypass the brand exists to close.
export async function runShadowTurnCallOnWorld(
  world: WooWorld,
  call: ShadowTurnCall,
  options: ShadowTurnCallOptions = {}
): Promise<ShadowTurnCallRun> {
  const run = await runShadowTurnCallOnWorldTranscript(world, call, options);
  return {
    ...run,
    serializedAfter: world.exportWorld()
  };
}

export async function runShadowTurnCallOnWorldTranscript(
  world: WooWorld,
  call: ShadowTurnCall,
  options: ShadowTurnCallOptions = {}
): Promise<ShadowTurnCallTranscriptRun> {
  if (options.onMetric) world.setMetricsHook(options.onMetric);
  if (options.suppress_provisioning_audit) world.setProvisioningAuditSink(() => {});
  const recorder = new InMemoryTurnRecorder();
  const guarded = options.allowed_atom_hashes != null;
  world.setTurnRecorder(guarded
    ? new ShadowStateGuardTurnRecorder(recorder, new Set(options.allowed_atom_hashes))
    : recorder);

  // VTN10.1: arm the object-lookup materialization probe ONLY in guarded
  // mode (allowed_atom_hashes present). In this mode an `object(id)` miss
  // emits a lifecycle probe that the guard recorder rejects with
  // E_NEED_STATE, turning a missing-slice dereference into a repairable
  // missing_state instead of a semantic E_OBJNF. Authoritative/diagnostic
  // runs (no allowed set) leave the guard off so a genuine miss still
  // surfaces as E_OBJNF. The flag is always cleared in the finally below,
  // even on throw, so it never leaks into a later run on the same world.
  // The throw of E_NEED_STATE must propagate out (it becomes the recorded
  // turn's turn_finish error -> transcript.error -> repair); the finally
  // only clears the flag, it never swallows.
  if (guarded) world.setShadowExecutionGuard(true);

  let frame: AppliedFrame | DirectResultFrame | ErrorFrame;
  try {
    if (call.route === "direct") {
      frame = await world.directCall(call.id, call.actor, call.target, call.verb, call.args, {
        sessionId: call.session ?? null,
        ...(call.scheduled ? { scheduled: call.scheduled } : {})
      });
    } else {
      const message: Message = {
        actor: call.actor,
        target: call.target,
        verb: call.verb,
        args: call.args,
        body: call.body
      };
      frame = call.session
        ? await world.call(call.id, call.session, call.scope, message)
        : await world.applyCall(call.id, call.scope, message, null);
    }
  } finally {
    if (guarded) world.setShadowExecutionGuard(false);
  }

  const recorded = recorder.turns[0];
  if (!recorded) {
    // A repair guard can raise before the turn recorder opens: the VTN10.1
    // guarded preamble does this for missing materialization, and sparse MCP
    // planning can hit E_OBJNF/E_VERBNF before dispatch opens a recorder.
    // Preserve those structured repair signals so the executor can refresh
    // authority and retry, instead of burying them under an opaque
    // "no recording" error. Other no-recording errors still propagate as bugs.
    if (frame.op === "error" && preRecordingErrorIsRepairable(frame.error.code)) {
      throw frame.error;
    }
    const suffix = frame.op === "error" ? `: ${frame.error.code} ${frame.error.message}` : "";
    throw new Error(`fresh turn produced no recording: ${call.target}:${call.verb}${suffix}`);
  }
  if (recorder.turns.length !== 1) {
    throw wooError("E_SCOPE_SPLIT", "one call produced more than one recorded turn", {
      turns: recorder.turns.length
    });
  }
  const transcript = effectTranscriptFromRecordedTurn(recorded);
  return {
    frame,
    recorded,
    transcript
  };
}

function preRecordingErrorIsRepairable(code: string): boolean {
  return code === "E_NEED_STATE" || code === "E_OBJNF" || code === "E_VERBNF" || code === "E_NOSESSION";
}

class ShadowStateGuardTurnRecorder implements TurnRecorder {
  constructor(
    private readonly inner: TurnRecorder,
    private readonly allowedAtomHashes: Set<string>
  ) {}

  startTurn(turn: TurnStart): ActiveTurnRecorder {
    const active = this.inner.startTurn(turn);
    // Created-object exemptions belong to this turn and to the behavior scope
    // that produced them. Keeping them on the TurnRecorder leaked exemptions
    // across turns; keeping them after an abort lets later events claim atoms
    // for an object whose creation was rolled back.
    let createdObjects = new Set<ObjRef>();
    const createdObjectScopes: Set<ObjRef>[] = [];
    return {
      event: (event) => {
        const missing = missingAtomsForRecorderEvent(event, this.allowedAtomHashes, createdObjects);
        if (missing.length > 0) {
          throw wooError("E_NEED_STATE", "shadow turn touched state outside the materialized atom set", {
            missing_atoms: missing
          });
        }
        active.event(event);
        if (event.kind === "object_create") createdObjects.add(event.object);
      },
      beginBehaviorScope: () => {
        active.beginBehaviorScope();
        createdObjectScopes.push(new Set(createdObjects));
      },
      commitBehaviorScope: () => {
        if (createdObjectScopes.length === 0) throw new Error("shadow guard behavior-scope commit without begin");
        active.commitBehaviorScope();
        createdObjectScopes.pop();
      },
      abortBehaviorScope: () => {
        const before = createdObjectScopes.pop();
        if (!before) throw new Error("shadow guard behavior-scope abort without begin");
        active.abortBehaviorScope();
        createdObjects = before;
      },
      currentBehaviorEvents: () => active.currentBehaviorEvents(),
      discardTurn: () => active.discardTurn()
    };
  }
}

function missingAtomsForRecorderEvent(
  event: TurnRecorderEvent,
  allowedAtomHashes: Set<string>,
  createdObjects: ReadonlySet<ObjRef> = new Set()
): Array<{ hash: string; preimage: string }> {
  if (event.kind === "object_create") return [];
  const preimages = shadowAtomPreimagesForRecorderEvent(event);
  const missing: Array<{ hash: string; preimage: string }> = [];
  for (const preimage of preimages) {
    if (createdObjectOwnsRecorderAtom(preimage, createdObjects)) continue;
    const hash = shadowAtomHash(preimage);
    if (!allowedAtomHashes.has(hash)) missing.push({ hash, preimage });
  }
  return missing;
}

function createdObjectOwnsRecorderAtom(preimage: string, createdObjects: ReadonlySet<ObjRef>): boolean {
  if (createdObjects.size === 0) return false;
  const cell = preimage.replace(/^(?:read|write):/, "");
  for (const prefix of ["cell:location:", "cell:contents:", "cell:lifecycle:"]) {
    if (cell.startsWith(prefix)) return createdObjects.has(cell.slice(prefix.length) as ObjRef);
  }
  if (cell.startsWith("cell:prop:")) {
    const rest = cell.slice("cell:prop:".length);
    const split = rest.lastIndexOf(".");
    return split > 0 && createdObjects.has(rest.slice(0, split) as ObjRef);
  }
  if (cell.startsWith("cell:verb:")) {
    const rest = cell.slice("cell:verb:".length);
    const split = rest.lastIndexOf(":");
    return split > 0 && createdObjects.has(rest.slice(0, split) as ObjRef);
  }
  return false;
}

function shadowAtomPreimagesForRecorderEvent(event: TurnRecorderEvent): string[] {
  switch (event.kind) {
    case "cell_read":
    case "state_probe":
      return [shadowReadCellPreimage(event.cell)];
    case "cell_write":
      return [shadowWriteCellPreimage(event.cell)];
    case "prop_read":
      return [shadowReadCellPreimage({ kind: "prop", object: event.object, name: event.name })];
    case "prop_write":
      return [shadowWriteCellPreimage({ kind: "prop", object: event.object, name: event.name })];
    case "dispatch":
      return [shadowReadCellPreimage({ kind: "verb", object: event.definer, name: event.verb })];
    case "object_create":
      return [shadowWriteCellPreimage({ kind: "lifecycle", object: event.object })];
    case "object_move":
      return [shadowWriteCellPreimage({ kind: "location", object: event.object })];
    default:
      return [];
  }
}
