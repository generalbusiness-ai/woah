/**
 * Durable fanout outbox — coherence.md CO2.7.
 *
 * Committed effects reach every derived copy at-least-once, ordered per
 * scope, crash-safe. The contract (ported from the v2 D1 gates):
 *
 * - rows are enqueued durably BEFORE the commit reply returns (the caller
 *   sequences that; the outbox never loses an enqueued row);
 * - drain delivers per-destination in seq order and stops that
 *   destination's lane on the first failure (order is per-scope FIFO,
 *   never skip-ahead);
 * - failed rows wait out a backoff window keyed on their attempt count;
 * - rows exceeding the attempt budget are marked `abandoned` — a named,
 *   observable divergence event (the receiver reseeds via epoch check),
 *   never silent loss;
 * - redelivery is harmless: receivers no-op by scope seq (CO2.5), tested
 *   here via applyFanout.
 *
 * No wall-clock reads inside the module — `now` is always a parameter
 * (Host supplies it), which keeps drains deterministic in tests and
 * replayable in workflows.
 */
import { CellStore, type Cell } from "./cells";
import type { RelationDelta } from "./relations";

export type FanoutBody = {
  scope: string;
  seq: number;
  /** Monotonic position in this scope's lane for one subscriber. Authority
   * `seq` may legitimately skip when an event produces no row for that
   * subscriber, so it cannot diagnose outbox loss. New senders stamp this
   * value; receivers accept unstamped rows during rolling upgrades. */
  delivery_seq?: number;
  /** Authority cells for the receiver to install as derived copies —
   * already lineage-closed by serializeTransfer (CO7). */
  cells: Cell[];
  /** Authority cell keys deleted by this ordered event. Deletions must ride
   * the same per-scope high-water as replacements; otherwise a durable
   * derived gateway can retain a definition the catalog authority removed. */
  removed_cells?: string[];
  /** Observations for live delivery at the destination. */
  observations: unknown[];
  /** Trusted-internal replay key. Receiving gateways use it only to skip the
   * submitting session from peer fanout. It must never be copied onto a
   * client-visible frame: possession of this value can replay the recorded
   * commit reply. */
  submitter_turn_id?: string;
  /** One-way public correlation token derived from `submitter_turn_id`.
   * Browsers use it to dedupe an echo that beats the turn reply without
   * learning the replay credential. */
  echo_id?: string;
  /** CO13: relation deltas riding alongside cells — the LOCAL deltas of
   * the commit this body announces, or the applied deltas of a
   * /net/relate refan. `applyFanout` stays cell-only by design (relation
   * rows are not cells and never install into a CellStore); the gateway
   * SHELL mirrors these into its relation table under the same per-scope
   * seq high-water that gates the cells. */
  relations?: RelationDelta[];
};

export type FanoutRow = {
  id: string;
  destination: string;
  body: FanoutBody;
  status: "pending" | "delivered" | "abandoned";
  attempts: number;
  last_attempt_at_ms: number | null;
};

export type OutboxOptions = {
  /** Backoff before retrying a failed row, by attempt count (1-based).
   * The row id rides along so a backoff can jitter deterministically
   * per-row (the default does); implementations may ignore it. */
  backoffMs?: (attempt: number, id: string) => number;
  /** Attempts before a row is abandoned (named divergence, not loss). */
  maxAttempts?: number;
};

export type EnqueueOptions = {
  /**
   * Preserve the durable row identity when hydrating an Outbox from
   * storage. Some routes deliberately distinguish multiple facts at the
   * same (destination, scope, seq), so reconstructing the conventional
   * id would alias them and make the subsequent durable write-back target
   * the wrong row.
   */
  id?: string;
};

/** NC8 (review item 8): ±25% deterministic per-row jitter over the
 * exponential base, so retry herds de-synchronize — many scopes retrying
 * a dead subscriber must not thunder on one cadence. Deterministic BY
 * ROW (an FNV-1a of the id, no Math.random) to preserve the module's
 * replayable-drain contract: the same row backs off identically across
 * reruns; different rows spread. */
export function defaultBackoffMs(attempt: number, id: string): number {
  const base = Math.min(30_000, 250 * 2 ** (attempt - 1));
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const spread = Math.floor(base / 4);
  return base - spread + (hash % (2 * spread + 1));
}

export type DrainResult = {
  delivered: string[];
  failed: string[];
  abandoned: string[];
  skipped_backoff: string[];
  /** True when `shouldYield` halted at least one lane mid-quantum. Halted
   * rows were never attempted (no attempt count, no backoff): they stay
   * pending and the caller's retry alarm resumes them. */
  yielded?: boolean;
};

export class Outbox {
  private readonly rows = new Map<string, FanoutRow>();
  private readonly backoffMs: (attempt: number, id: string) => number;
  private readonly maxAttempts: number;

  constructor(options: OutboxOptions = {}) {
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
    this.maxAttempts = options.maxAttempts ?? 8;
  }

  /** Durable enqueue — call BEFORE returning the commit reply (CO2.7). */
  enqueue(destination: string, body: FanoutBody, options: EnqueueOptions = {}): FanoutRow {
    const row: FanoutRow = {
      id: options.id ?? `${destination}/${body.scope}/${body.seq}`,
      destination,
      body,
      status: "pending",
      attempts: 0,
      last_attempt_at_ms: null
    };
    // Same (destination, scope, seq) re-enqueued is the same fact; keep
    // the earlier row (attempts/backoff state included).
    if (!this.rows.has(row.id)) this.rows.set(row.id, row);
    return this.rows.get(row.id) as FanoutRow;
  }

  pending(): FanoutRow[] {
    return [...this.rows.values()].filter((row) => row.status === "pending");
  }

  /**
   * Deliver pending rows: per destination, in (scope, seq) order, halting
   * that destination's lane on the first failure so order is preserved.
   * Rows inside their backoff window are skipped (and halt their lane —
   * delivering seq+1 before seq would break per-scope order). Distinct
   * destinations have no ordering dependency, so their lanes run
   * concurrently; serializing them would make one slow subscriber add its
   * latency to every other subscriber's delivery.
   *
   * `shouldYield` makes the lane quantum interruptible: it is consulted
   * before each row, and a true answer halts the lane exactly like
   * end-of-lane — remaining rows untouched (pending, no attempt), order
   * preserved. The caller uses it for submit priority: without it, a lane
   * of slow deliveries pins the drain for rows × RPC-timeout after a
   * commit has arrived.
   */
  async drain(
    now: number,
    deliver: (row: FanoutRow) => Promise<void>,
    shouldYield?: () => boolean,
    deliverLane?: (destination: string, rows: FanoutRow[]) => Promise<void>
  ): Promise<DrainResult> {
    const lanes = new Map<string, FanoutRow[]>();
    for (const row of this.pending()) {
      const lane = lanes.get(row.destination) ?? [];
      lane.push(row);
      lanes.set(row.destination, lane);
    }
    let yielded = false;
    const drainLane = async (lane: FanoutRow[]): Promise<DrainResult> => {
      const result: DrainResult = { delivered: [], failed: [], abandoned: [], skipped_backoff: [] };
      lane.sort((a, b) => a.body.scope.localeCompare(b.body.scope) || a.body.seq - b.body.seq);
      // Batched lane delivery: ONE call carries the lane's deliverable
      // prefix (halting at a backoff head or a yield exactly like the
      // per-row loop — never skip-ahead, CO2.7). Order is preserved
      // trivially — the prefix rides a single request and the receiver
      // applies it serially. Outcome is prefix-atomic: success delivers
      // every row; a throw counts one attempt against every row (a batch
      // failure is destination-level — network, 5xx — and the receiver's
      // per-scope seq gate makes redelivered rows no-op, so retrying the
      // whole prefix is safe).
      if (deliverLane) {
        if (shouldYield?.()) {
          yielded = true;
          return result;
        }
        const prefix: FanoutRow[] = [];
        for (const row of lane) {
          if (row.last_attempt_at_ms !== null && now < row.last_attempt_at_ms + this.backoffMs(row.attempts, row.id)) {
            result.skipped_backoff.push(row.id);
            break; // preserve order: nothing later in this lane may jump the queue
          }
          prefix.push(row);
        }
        if (prefix.length === 0) return result;
        for (const row of prefix) {
          row.attempts += 1;
          row.last_attempt_at_ms = now;
        }
        try {
          await deliverLane(prefix[0]!.destination, prefix);
          for (const row of prefix) {
            row.status = "delivered";
            result.delivered.push(row.id);
          }
        } catch {
          for (const row of prefix) {
            if (row.attempts >= this.maxAttempts) {
              row.status = "abandoned";
              result.abandoned.push(row.id);
            } else {
              result.failed.push(row.id);
            }
          }
        }
        return result;
      }
      for (const row of lane) {
        if (shouldYield?.()) {
          yielded = true;
          break; // untouched rows stay pending; the retry alarm resumes them
        }
        if (row.last_attempt_at_ms !== null && now < row.last_attempt_at_ms + this.backoffMs(row.attempts, row.id)) {
          result.skipped_backoff.push(row.id);
          break; // preserve order: nothing later in this lane may jump the queue
        }
        row.attempts += 1;
        row.last_attempt_at_ms = now;
        try {
          await deliver(row);
          row.status = "delivered";
          result.delivered.push(row.id);
        } catch {
          if (row.attempts >= this.maxAttempts) {
            row.status = "abandoned";
            result.abandoned.push(row.id);
          } else {
            result.failed.push(row.id);
          }
          break; // halt the lane; retry after backoff
        }
      }
      return result;
    };

    // Promise.all starts every independent lane before awaiting any one of
    // them. Merge in Map insertion order afterward so callers and metrics
    // retain deterministic result arrays despite concurrent delivery.
    const laneResults = await Promise.all([...lanes.values()].map(drainLane));
    const result: DrainResult = { delivered: [], failed: [], abandoned: [], skipped_backoff: [] };
    for (const lane of laneResults) {
      result.delivered.push(...lane.delivered);
      result.failed.push(...lane.failed);
      result.abandoned.push(...lane.abandoned);
      result.skipped_backoff.push(...lane.skipped_backoff);
    }
    if (yielded) result.yielded = true;
    return result;
  }
}

/**
 * Receiver application: install the body's cells into a derived store,
 * no-op'ing redeliveries by scope seq (CO2.5). Returns whether the body
 * advanced the receiver. `seen` is the receiver's durable per-scope
 * high-water map.
 */
export function applyFanout(store: CellStore, seen: Map<string, number>, body: FanoutBody): boolean {
  const last = seen.get(body.scope) ?? 0;
  if (body.seq <= last) return false; // redelivery — harmless no-op
  for (const cell of body.cells) store.install(cell);
  for (const key of body.removed_cells ?? []) store.delete(key);
  seen.set(body.scope, body.seq);
  return true;
}
