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
 *       POST /net/turn    plan → submit → install accepted cells
 *                         (test-facing single attempt in step 2; the
 *                         CO6-taxonomy repair loop replaces the single
 *                         attempt in step 3 — structure, not surface,
 *                         changes there)
 *
 * The /net/turn classifier inputs (`anchors`, `shared`) ride on the
 * request in step 2 because the gateway does not yet derive anchoring
 * from lineage cells — that arrives with the step-3 gateway machinery.
 *
 * This class sits beside the v2 DO classes and shares nothing with them;
 * nothing routes production traffic here until Phase 5.
 */
import { CellStore, type Cell } from "../../net/cells";
import { isNetError } from "../../net/errors";
import { applyFanout, type FanoutBody } from "../../net/outbox";
import { planTurn, type PlanTurnInput } from "../../net/plan";
import type { ScopeClassifier } from "../../net/route";
import type { CommitReply, ScopeHead } from "../../net/scope";
import type { CellTransfer } from "../../net/cells";
import { verifyInternalRequest } from "../internal-auth";
import { WorkerdHost, type WorkerdHostEnv, type NetStub } from "./workerd-host";

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

/** Structural slice of a DurableObjectNamespace — enough to resolve a
 * name to a stub; satisfied by real bindings and the fake namespace. */
export type NetNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): NetStub;
};

export type NetGatewayEnv = WorkerdHostEnv & {
  /** Test override: resolve rpc destinations to stubs directly (the fake
   * harness wires this). When absent, destinations resolve through the
   * real bindings below: `scope:<name>` → SCOPE_NET, `gateway:<name>` →
   * GATEWAY_NET. */
  NET_RESOLVE?: (destination: string) => NetStub;
  SCOPE_NET?: NetNamespace;
  GATEWAY_NET?: NetNamespace;
};

/** destination = "<kind>:<name>" (kickoff RPC surface). */
function resolveFromBindings(env: NetGatewayEnv, destination: string): NetStub {
  if (env.NET_RESOLVE) return env.NET_RESOLVE(destination);
  const split = destination.indexOf(":");
  const kind = split === -1 ? destination : destination.slice(0, split);
  const name = split === -1 ? "" : destination.slice(split + 1);
  const namespace = kind === "scope" ? env.SCOPE_NET : kind === "gateway" ? env.GATEWAY_NET : undefined;
  if (!namespace || !name) {
    throw new Error(`NetGatewayDO: cannot resolve rpc destination ${destination}`);
  }
  return namespace.get(namespace.idFromName(name));
}

function sqlRows<T>(cursor: unknown): T[] {
  return (cursor as { toArray(): T[] }).toArray();
}

type ScopeRow = { seen_seq: number };

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
      resolve: (destination) => resolveFromBindings(this.env, destination),
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
        const transfer = (await this.host.rpc(body.destination, "/closure", {
          keys: ["*"],
          known: body.known ?? []
        })) as CellTransfer & { head: ScopeHead };
        const view = this.ensureView();
        this.state.storage.transactionSync(() => {
          for (const cell of transfer.cells) {
            view.install(cell);
            this.persistCell(view, cell.key);
          }
        });
        return json({ ok: true, installed: transfer.cells.length, head: transfer.head });
      }
      if (request.method === "POST" && url.pathname === "/net/turn") {
        return json(await this.turn((await request.json()) as TurnRequest));
      }
      return json({ error: `no such route: ${request.method} ${url.pathname}` }, 404);
    } catch (err) {
      if (isNetError(err)) {
        return json({ error: { code: err.code, message: err.message, detail: err.detail } }, 400);
      }
      return json({ error: String(err) }, 500);
    }
  }

  /**
   * Step-2 turn path: one plan, one submit, install-on-accept. The
   * selected scope's CURRENT head is fetched after planning (selection
   * is a function of the write set) and stamped into the submit —
   * `base` is an envelope field, not part of the transcript hash or the
   * post-state digest, so this is sound; a stale view still rejects on
   * read versions, which is the step-3 repair loop's input.
   */
  private async turn(request: TurnRequest): Promise<{
    reply: CommitReply;
    selection: { scope: string; riders: string[] };
    envelopeBytes: number;
  }> {
    const view = this.ensureView();
    const classifier: ScopeClassifier = {
      scopeOf: (object) => request.anchors?.[object] ?? request.planningScope,
      isShared: (scope) => (request.shared ?? [request.planningScope]).includes(scope)
    };
    const provisionalBase: ScopeHead = { seq: 0, hash: "provisional" };
    const planned = await planTurn({
      call: request.call,
      view,
      planningScope: request.planningScope,
      classifier,
      base: provisionalBase,
      idempotencyKey: request.idempotency_key,
      stamp: { scope_head: "gateway", catalog_epoch: request.catalog_epoch },
      ...(request.counters !== undefined ? { counters: request.counters } : {})
    });

    const destination = request.scopes[planned.selection.scope];
    if (!destination) {
      throw new Error(`no rpc destination for selected scope ${planned.selection.scope}`);
    }
    const headReply = (await this.host.rpc(destination, "/head")) as { head: ScopeHead };
    const submit = { ...planned.submit, base: headReply.head };

    const reply = (await this.host.rpc(destination, "/submit", submit)) as CommitReply;
    if (reply.status === "accepted" && reply.touched.length > 0) {
      // Warm cache-fill (CO7): the accepted cells become the view's
      // derived copies, so the next turn plans locally.
      const transfer = (await this.host.rpc(destination, "/closure", {
        keys: reply.touched,
        known: []
      })) as CellTransfer;
      const touched = new Set(reply.touched);
      this.state.storage.transactionSync(() => {
        for (const cell of transfer.cells) {
          view.install(cell);
          this.persistCell(view, cell.key);
        }
        // A touched key with no cell in the transfer was deleted at the
        // authority; mirror the deletion in the view.
        for (const key of touched) {
          if (!transfer.cells.some((cell) => cell.key === key)) {
            view.delete(key);
            this.persistCell(view, key);
          }
        }
      });
    }
    return { reply, selection: planned.selection, envelopeBytes: planned.envelopeBytes };
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
