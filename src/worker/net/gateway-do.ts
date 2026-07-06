/**
 * NetGatewayDO — the Durable Object shell for a gateway shard (Plan 002
 * Phase 3 step 2; coherence.md CO1 GATEWAY role, CO5 copy #2).
 *
 * Thin by design: planning lives in src/net/plan.ts, application in
 * src/net/{cells,outbox}.ts. This file provides
 *   - SQLite persistence for the derived view (copy #2: epoch-stamped
 *     cells) and the per-scope fanout high-water (CO2.5 receiver
 *     idempotency), hydrated lazily;
 *   - the internal-auth'd /net surface:
 *       POST /net/fanout  FanoutBody → install cells, advance seen seq
 *       POST /net/pull    {scope, destination} → CO7 state-transfer
 *                         cache-fill: fetch the scope's lineage-closed
 *                         closure and install it as derived
 *       POST /net/turn    the CO6-taxonomy repair loop: plan → submit,
 *                         with each retryable verdict mapped to its
 *                         defined recovery (refetch head / targeted
 *                         closure refresh / epoch reseed), bounded by
 *                         repair_budget_ms (CO10) and an attempt
 *                         ceiling; terminal verdicts and budget
 *                         exhaustion surface with the attempt trace
 *
 * The /net/turn classifier inputs (`anchors`, `shared`) ride on the
 * request in step 2 because the gateway does not yet derive anchoring
 * from lineage cells — that arrives with the step-3 gateway machinery.
 *
 * This class sits beside the v2 DO classes and shares nothing with them;
 * nothing routes production traffic here until Phase 5.
 */
import { CellStore, type Cell } from "../../net/cells";
import { budgetExhausted, isNetError, type AttemptTraceEntry, type NetErrorCode } from "../../net/errors";
import { applyFanout, type FanoutBody } from "../../net/outbox";
import { planTurn, type PlanTurnInput, type PlanTurnResult } from "../../net/plan";
import type { ScopeClassifier } from "../../net/route";
import type { CommitReply, CommitSubmit, RejectReason, ScopeHead } from "../../net/scope";
import { netCellKeyFor } from "../../net/transcript";
import type { CellTransfer } from "../../net/cells";
import { verifyInternalRequest } from "../internal-auth";
import { resolveNetDestination, WorkerdHost, type NetBindingsEnv } from "./workerd-host";

export type NetGatewayDurableState = {
  id: unknown;
  waitUntil?: (promise: Promise<unknown>) => void;
  storage: {
    sql: { exec(query: string, ...params: unknown[]): unknown };
    transactionSync<T>(callback: () => T): T;
    setAlarm(at: number): void | Promise<void>;
    deleteAlarm(): void | Promise<void>;
  };
};

export type NetGatewayEnv = NetBindingsEnv;

function sqlRows<T>(cursor: unknown): T[] {
  return (cursor as { toArray(): T[] }).toArray();
}

type ScopeRow = { seen_seq: number };

/** CO10: the ratified repair budget for one /net/turn. */
export const REPAIR_BUDGET_MS = 12_000;

/** Attempt ceiling inside the budget. Every defined recovery converges in
 * one round when its refresh succeeds; six rounds leaves room for a
 * recovery whose refresh itself fails transiently. More than that means
 * the recovery is not converging and burning budget will not help. */
export const MAX_TURN_ATTEMPTS = 6;

type TurnRequest = {
  call: PlanTurnInput["call"];
  planningScope: string;
  catalog_epoch: string;
  idempotency_key: string;
  /** scope → rpc destination (e.g. "scope:the_room"). */
  scopes: Record<string, string>;
  /** object → owning scope; objects absent here anchor to planningScope. */
  anchors?: Record<string, string>;
  /** which scopes are shared sequencers (rooms); others are clusters. */
  shared?: string[];
  counters?: PlanTurnInput["counters"];
};

/** /net/turn reply body. `trace` lists the failed rounds that preceded
 * the final verdict (empty on a first-try accept), so callers and tests
 * can see the convergence shape (CO6). */
type TurnResult = {
  reply: CommitReply;
  selection: { scope: string; riders: string[] };
  envelopeBytes: number;
  attempt: number;
  trace: AttemptTraceEntry[];
};

/** Retryable verdict → the CO6 taxonomy code its round is recorded as.
 * `post_state_mismatch` has no code of its own; its defined recovery is
 * the E_READ_VERSION one (re-plan against refreshed cells). */
const VERDICT_CODE: Partial<Record<RejectReason, NetErrorCode>> = {
  stale_head: "E_STALE_HEAD",
  stale_epoch: "E_STALE_EPOCH",
  read_version_mismatch: "E_READ_VERSION",
  post_state_mismatch: "E_READ_VERSION"
};

/** `<kind>:<object>[:<name>]` → object (object ids never contain ':'). */
function objectOfCellKey(key: string): string {
  return key.split(":")[1] ?? "";
}

export class NetGatewayDO {
  private readonly host: WorkerdHost;
  private view: CellStore | null = null;
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly state: NetGatewayDurableState,
    private readonly env: NetGatewayEnv
  ) {
    // CREATE IF NOT EXISTS on every construction — same idiom as
    // SqliteScopeStore: cheap, idempotent, no separate first-boot path.
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_gateway_cell (key TEXT PRIMARY KEY, body TEXT NOT NULL)");
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS net_gateway_scope (scope TEXT PRIMARY KEY, seen_seq INTEGER NOT NULL)");
    this.host = new WorkerdHost({
      resolve: (destination) => resolveNetDestination(this.env, destination),
      env,
      waitUntil: state.waitUntil?.bind(state),
      alarmStorage: state.storage
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await verifyInternalRequest(this.env, request);
    } catch (err) {
      return json({ error: String(err) }, 401);
    }
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/net/fanout") {
        const body = (await request.json()) as FanoutBody;
        return json({ applied: this.receiveFanout(body) });
      }
      if (request.method === "POST" && url.pathname === "/net/pull") {
        const body = (await request.json()) as { scope: string; destination: string; known?: string[] };
        const view = this.ensureView();
        const transfer = await this.reseedFromScope(view, body.destination, body.known ?? []);
        return json({ ok: true, installed: transfer.cells.length, head: transfer.head });
      }
      if (request.method === "POST" && url.pathname === "/net/turn") {
        return json(await this.turn((await request.json()) as TurnRequest));
      }
      return json({ error: `no such route: ${request.method} ${url.pathname}` }, 404);
    } catch (err) {
      if (isNetError(err)) {
        // E_BUDGET carries the per-attempt taxonomy trail; surface it in
        // the error reply so the failure explains itself (CO6).
        return json(
          {
            error: {
              code: err.code,
              message: err.message,
              detail: err.detail,
              ...(err.attempts ? { attempts: err.attempts } : {})
            }
          },
          400
        );
      }
      return json({ error: String(err) }, 500);
    }
  }

  /**
   * The CO6-taxonomy repair loop (Phase 3 step 3). Each round is one
   * plan → submit; every retryable failure is recorded as an
   * AttemptTraceEntry and mapped to its defined recovery:
   *
   * - planning E_MISSING_STATE (CO2.6 materialization miss) → fetch
   *   exactly the missing cell keys from their owning scopes, re-plan;
   * - stale_head → refetch the head; resubmit the SAME transcript only
   *   when the base was the whole story (head actually moved AND the
   *   scope reported no read mismatches) — otherwise re-plan;
   * - read_version_mismatch → refresh exactly `mismatched_reads`
   *   (mapped through netCellKeyFor) and RE-PLAN: a transcript planned
   *   against stale reads is never resubmitted;
   * - stale_epoch → drop stale-stamped view cells + full-closure reseed
   *   from the scope (the CO8 named reseed), re-plan;
   * - terminal verdicts return the reply immediately; terminal NetError
   *   codes and plain programming errors throw as-is.
   *
   * Bounded by repair_budget_ms (CO10) and MAX_TURN_ATTEMPTS; exhaustion
   * throws E_BUDGET carrying the trace, which the fetch handler surfaces
   * in the /net/turn error reply (CO6: the reply explains itself).
   *
   * The selected scope's CURRENT head is fetched after planning
   * (selection is a function of the write set) and stamped into the
   * submit — `base` is an envelope field, not part of the transcript
   * hash or the post-state digest, so patching it in is sound.
   */
  private async turn(request: TurnRequest): Promise<TurnResult> {
    const view = this.ensureView();
    const classifier: ScopeClassifier = {
      scopeOf: (object) => request.anchors?.[object] ?? request.planningScope,
      isShared: (scope) => (request.shared ?? [request.planningScope]).includes(scope)
    };
    const startedAt = this.host.now();
    const deadline = startedAt + REPAIR_BUDGET_MS;
    const trace: AttemptTraceEntry[] = [];
    // stale_head resubmit carry-over: when only the base was stale the
    // planned transcript is still valid — the next round submits it
    // against the fresh head instead of paying a re-plan.
    let resubmit: { planned: PlanTurnResult; base: ScopeHead } | null = null;

    for (let attempt = 1; attempt <= MAX_TURN_ATTEMPTS; attempt += 1) {
      // The budget bounds rounds two onward; the first attempt always
      // runs (a zero-attempt turn could never converge or explain itself).
      if (attempt > 1 && this.host.now() >= deadline) break;
      const elapsed = () => this.host.now() - startedAt;

      // ---- Plan (or adopt the stale_head resubmit).
      let planned: PlanTurnResult;
      let base: ScopeHead | null = null;
      if (resubmit) {
        planned = resubmit.planned;
        base = resubmit.base;
        resubmit = null;
      } else {
        try {
          planned = await this.planOnce(request, view, classifier);
        } catch (err) {
          if (isNetError(err) && err.code === "E_MISSING_STATE") {
            const missing = Array.isArray(err.detail.missing) ? (err.detail.missing as string[]) : [];
            trace.push({ attempt, code: "E_MISSING_STATE", missing, elapsed_ms: elapsed() });
            await this.tryRecovery(trace, () =>
              this.refreshCells(request, view, missing, request.scopes[request.planningScope])
            );
            continue;
          }
          // Terminal NetError codes and plain Errors (misplan bugs,
          // transport failures on the submit path) surface as-is.
          throw err;
        }
      }

      const destination = request.scopes[planned.selection.scope];
      if (!destination) {
        throw new Error(`no rpc destination for selected scope ${planned.selection.scope}`);
      }
      if (base === null) {
        base = ((await this.host.rpc(destination, "/head")) as { head: ScopeHead }).head;
      }
      const submit: CommitSubmit = { ...planned.submit, base };

      // The submit rides with its rider directions (CA3 forward): the
      // scope shell enqueues /net/adopt rows for the accepted rider
      // cells after commit. CommitSubmit itself is unchanged — riders
      // are an HTTP-body sibling, not sequencer input.
      const reply = (await this.host.rpc(destination, "/submit", {
        submit,
        rider_destinations: this.riderDestinationsFor(request, planned.selection.riders)
      })) as CommitReply;
      if (reply.status === "accepted") {
        if (reply.touched.length > 0) await this.installTouched(view, destination, reply.touched);
        return { reply, selection: planned.selection, envelopeBytes: planned.envelopeBytes, attempt, trace };
      }
      if (!reply.retryable) {
        // Terminal verdict: surface the scope's reply immediately (CO6).
        return { reply, selection: planned.selection, envelopeBytes: planned.envelopeBytes, attempt, trace };
      }

      // ---- Retryable verdict: record the round, run the defined recovery.
      const mismatchKeys = (reply.mismatched_reads ?? [])
        .map((cell) => netCellKeyFor(cell))
        .filter((key): key is string => key !== null);
      trace.push({
        attempt,
        code: VERDICT_CODE[reply.reason] ?? "E_READ_VERSION",
        ...(mismatchKeys.length > 0 ? { missing: mismatchKeys } : {}),
        elapsed_ms: elapsed()
      });

      switch (reply.reason) {
        case "stale_head": {
          const fresh = await this.tryRecovery(
            trace,
            async () => ((await this.host.rpc(destination, "/head")) as { head: ScopeHead }).head
          );
          const headMoved = fresh !== undefined && (fresh.seq !== submit.base.seq || fresh.hash !== submit.base.hash);
          if (fresh !== undefined && headMoved && !reply.mismatched_reads) {
            // The head moved and no reads were reported stale: the
            // transcript is still honest, resubmit it on the new base.
            resubmit = { planned, base: fresh };
          }
          // Otherwise re-plan next round: either the head did not
          // actually differ (something else is wrong) or reads were
          // flagged too (stale view — must re-plan).
          break;
        }
        case "read_version_mismatch":
        case "post_state_mismatch": {
          // Refresh exactly the named cells (or, for a post_state
          // disagreement naming nothing, reseed the scope's closure)
          // and re-plan.
          await this.tryRecovery(trace, async () => {
            if (mismatchKeys.length > 0) await this.refreshCells(request, view, mismatchKeys, destination);
            else await this.reseedFromScope(view, destination);
          });
          break;
        }
        case "stale_epoch": {
          await this.tryRecovery(trace, async () => {
            // CO8 named reseed: drop every cell stamped with another
            // epoch (mirrored into SQLite), pull the scope's full
            // closure back, re-plan.
            const stale = [...view.keys()].filter(
              (key) => view.get(key)?.stamp.catalog_epoch !== request.catalog_epoch
            );
            view.dropStaleEpoch({ catalog_epoch: request.catalog_epoch });
            this.state.storage.transactionSync(() => {
              for (const key of stale) this.persistCell(view, key);
            });
            await this.reseedFromScope(view, destination);
          });
          break;
        }
        default:
          // Retryable but with no defined gateway recovery — unreachable
          // while the verdict set stays closed; re-plan and let the
          // budget bound the loop.
          break;
      }
    }

    throw budgetExhausted("repair budget exhausted for /net/turn", trace, {
      planning_scope: request.planningScope,
      budget_ms: REPAIR_BUDGET_MS,
      max_attempts: MAX_TURN_ATTEMPTS,
      elapsed_ms: this.host.now() - startedAt
    });
  }

  /** Rider forwarding directions for the committing scope (CA3): for
   * each rider scope in the selection, its rpc destination plus the
   * objects the request anchors to it. The object list rides too because
   * only the gateway holds the anchor map — the scope shell must know
   * WHICH accepted cells are the rider's, and the sequencer itself never
   * learns rider topology (src/net/scope.ts types stay unchanged). */
  private riderDestinationsFor(
    request: TurnRequest,
    riders: string[]
  ): Record<string, { destination: string; objects: string[] }> {
    const out: Record<string, { destination: string; objects: string[] }> = {};
    for (const rider of riders) {
      const destination = request.scopes[rider];
      if (!destination) throw new Error(`no rpc destination for rider scope ${rider}`);
      const objects = Object.entries(request.anchors ?? {})
        .filter(([, scope]) => scope === rider)
        .map(([object]) => object);
      out[rider] = { destination, objects };
    }
    return out;
  }

  /** One planning pass against the current view. The provisional base is
   * patched after the head fetch — `base` is an envelope field, not part
   * of the transcript hash. */
  private async planOnce(request: TurnRequest, view: CellStore, classifier: ScopeClassifier): Promise<PlanTurnResult> {
    return planTurn({
      call: request.call,
      view,
      planningScope: request.planningScope,
      classifier,
      base: { seq: 0, hash: "provisional" },
      idempotencyKey: request.idempotency_key,
      stamp: { scope_head: "gateway", catalog_epoch: request.catalog_epoch },
      ...(request.counters !== undefined ? { counters: request.counters } : {})
    });
  }

  /** Run a recovery action; a failure (e.g. the closure fetch itself
   * dying) is recorded on the round's trace entry (`recovery_error`) and
   * the loop simply retries — the budget and attempt ceiling bound how
   * long, which is exactly the E_BUDGET path the trace then explains.
   * Returns the action's value, or undefined when it failed. */
  private async tryRecovery<T>(trace: AttemptTraceEntry[], action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch (err) {
      const last = trace[trace.length - 1] as (AttemptTraceEntry & { recovery_error?: string }) | undefined;
      if (last) last.recovery_error = String(err);
      return undefined;
    }
  }

  /** Warm cache-fill (CO7): accepted cells become the view's derived
   * copies, so the next turn plans locally. A touched key with no cell
   * in the transfer was deleted at the authority; mirror the deletion. */
  private async installTouched(view: CellStore, destination: string, touched: string[]): Promise<void> {
    const transfer = (await this.host.rpc(destination, "/closure", { keys: touched, known: [] })) as CellTransfer;
    const wanted = new Set(touched);
    this.state.storage.transactionSync(() => {
      for (const cell of transfer.cells) {
        view.install(cell);
        this.persistCell(view, cell.key);
        wanted.delete(cell.key);
      }
      for (const key of wanted) {
        view.delete(key);
        this.persistCell(view, key);
      }
    });
  }

  /** Targeted view refresh (the E_READ_VERSION / E_MISSING_STATE
   * recovery): fetch exactly `keys`, lineage-closed, from each key's
   * owning scope — `anchors` maps objects to scopes; unanchored objects
   * belong to the scope the turn was talking to (`fallback`). `known` is
   * the view's lineage keys, so the transfer never reships the class
   * chain (CO7). A requested key that comes back absent was deleted at
   * the authority. */
  private async refreshCells(
    request: TurnRequest,
    view: CellStore,
    keys: string[],
    fallback: string | undefined
  ): Promise<void> {
    if (keys.length === 0) return;
    const byDestination = new Map<string, string[]>();
    for (const key of keys) {
      const scope = request.anchors?.[objectOfCellKey(key)];
      const destination = (scope !== undefined ? request.scopes[scope] : undefined) ?? fallback;
      if (!destination) throw new Error(`no rpc destination to refresh ${key}`);
      byDestination.set(destination, [...(byDestination.get(destination) ?? []), key]);
    }
    const known = [...view.keys()].filter((key) => key.startsWith("object_lineage:"));
    for (const [destination, want] of byDestination) {
      const transfer = (await this.host.rpc(destination, "/closure", { keys: want, known })) as CellTransfer;
      const wanted = new Set(want);
      this.state.storage.transactionSync(() => {
        for (const cell of transfer.cells) {
          view.install(cell);
          this.persistCell(view, cell.key);
          wanted.delete(cell.key);
        }
        for (const key of wanted) {
          view.delete(key);
          this.persistCell(view, key);
        }
      });
    }
  }

  /** Full-closure install from the scope — the CO8 named reseed and the
   * /net/pull live path share this. */
  private async reseedFromScope(
    view: CellStore,
    destination: string,
    known: string[] = []
  ): Promise<CellTransfer & { head: ScopeHead; catalog_epoch: string }> {
    const transfer = (await this.host.rpc(destination, "/closure", { keys: ["*"], known })) as CellTransfer & {
      head: ScopeHead;
      catalog_epoch: string;
    };
    this.state.storage.transactionSync(() => {
      for (const cell of transfer.cells) {
        view.install(cell);
        this.persistCell(view, cell.key);
      }
    });
    return transfer;
  }

  /** CO2.5 receiver idempotency + copy-#2 persistence, one transaction. */
  private receiveFanout(body: FanoutBody): boolean {
    const view = this.ensureView();
    return this.state.storage.transactionSync(() => {
      const applied = applyFanout(view, this.seen, body);
      if (applied) {
        for (const cell of body.cells) this.persistCell(view, cell.key);
        this.state.storage.sql.exec(
          "INSERT INTO net_gateway_scope (scope, seen_seq) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET seen_seq = excluded.seen_seq",
          body.scope,
          body.seq
        );
      }
      return applied;
    });
  }

  /** Lazy hydration of the derived view + per-scope high-water. */
  private ensureView(): CellStore {
    if (this.view) return this.view;
    const view = new CellStore("derived");
    for (const row of sqlRows<{ body: string }>(this.state.storage.sql.exec("SELECT body FROM net_gateway_cell"))) {
      view.install(JSON.parse(row.body) as Cell);
    }
    for (const row of sqlRows<{ scope: string; seen_seq: number } & ScopeRow>(
      this.state.storage.sql.exec("SELECT scope, seen_seq FROM net_gateway_scope")
    )) {
      this.seen.set(row.scope, row.seen_seq);
    }
    this.view = view;
    return view;
  }

  /** Write-through for one view cell (installed or deleted). */
  private persistCell(view: CellStore, key: string): void {
    const cell = view.get(key);
    if (cell) {
      this.state.storage.sql.exec(
        "INSERT INTO net_gateway_cell (key, body) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body",
        key,
        JSON.stringify(cell)
      );
    } else {
      this.state.storage.sql.exec("DELETE FROM net_gateway_cell WHERE key = ?", key);
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
