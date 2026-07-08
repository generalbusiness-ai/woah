// Ready-to-scale Phase 3 — bounded outbox drain + bounded scheduled
// bursts (notes/2026-07-08-net-ready-to-scale-plan.md). Fake-DO lane over
// real per-instance SQLite.
//
// The removed small-world assumptions, each pinned by a test here:
// - a drain pass reads a bounded LANE PREFIX per due destination (never
//   the whole backlog), and only attempted rows are written back;
// - a stuck destination cannot starve other destinations' lanes, and its
//   backlog taxes a pass by at most one head probe + one bounded read;
// - CO2.7 per-lane (scope, seq) order survives the bounding (nothing
//   behind a failed head delivers);
// - the retry alarm arms at the earliest LANE-HEAD due-time (a due row
//   parked behind a mid-backoff head must not busy-loop the alarm);
// - one alarm firing moves a bounded batch of due scheduled turns and
//   re-arms immediately while more are due (a burst cannot balloon one
//   alarm transaction);
// - the Phase-3 columns/indexes/lane-directory backfill idempotently on
//   construction over a pre-column (legacy) table.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import type { ScheduledTurn } from "../../src/net/scope";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import type { NetStub } from "../../src/worker/net/workerd-host";

const SECRET = "net-outbox-bounded-secret";
const EPOCH = "cat-net-bounded-1";
const SCOPE = "room-bounded";

function netState(name: string) {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const alarms: Array<number | null> = [];
  const state: NetScopeDurableState = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => {
      deferred.push(promise);
    },
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: (at: number) => {
        alarms.push(at);
      },
      deleteAlarm: () => {
        alarms.push(null);
      }
    }
  };
  return {
    state,
    alarms,
    settle: async () => {
      while (deferred.length > 0) await deferred.shift();
    },
    close: () => fake.close()
  };
}

type Fetchable = { fetch(request: Request): Promise<Response> | Response };

async function call<T>(target: Fetchable, env: { WOO_INTERNAL_SECRET?: string }, route: string, body?: unknown): Promise<T> {
  const url = `https://do/net${route}`;
  const request =
    body === undefined
      ? new Request(url)
      : new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const signed = await signInternalRequest(env, request);
  const response = await target.fetch(signed);
  const decoded = (await response.json()) as T;
  if (!response.ok) throw new Error(`call ${route} failed: ${JSON.stringify(decoded)}`);
  return decoded;
}

/** Any authenticated request kicks drain-on-reactivation; the route may
 * 404 — deferPendingDrain has already run by then. */
async function kick(target: Fetchable, env: { WOO_INTERNAL_SECRET?: string }): Promise<void> {
  const signed = await signInternalRequest(env, new Request("https://do/net/kick-drain"));
  await target.fetch(signed);
}

/** 200-replying stub recording each delivered body. */
function okStub(): { stub: NetStub; received: unknown[] } {
  const received: unknown[] = [];
  return {
    received,
    stub: {
      fetch: async (request: Request) => {
        received.push(request.method === "POST" ? await request.json() : undefined);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
  };
}

/** 500-replying stub (host.rpc throws on !ok) recording attempts. */
function downStub(): { stub: NetStub; received: unknown[] } {
  const received: unknown[] = [];
  return {
    received,
    stub: {
      fetch: async (request: Request) => {
        received.push(request.method === "POST" ? await request.json() : undefined);
        return new Response("destination down", { status: 500 });
      }
    }
  };
}

/** Insert a pending /fanout row the way persistOutboxRow does (the tests
 * build backlogs directly — driving 100 committed turns through the
 * sequencer would test the sequencer, not the drain). */
function insertRow(state: NetScopeDurableState, destination: string, seq: number): void {
  const body = JSON.stringify({ scope: SCOPE, seq, cells: [], observations: [] });
  state.storage.sql.exec(
    "INSERT INTO net_scope_outbox (route, id, destination, body, status, attempts, last_attempt_at_ms, scope, seq, next_attempt_at_ms) VALUES ('/fanout', ?, ?, ?, 'pending', 0, NULL, ?, ?, 0)",
    `${destination}/${SCOPE}/${seq}`,
    destination,
    body,
    SCOPE,
    seq
  );
  state.storage.sql.exec(
    "INSERT OR IGNORE INTO net_scope_outbox_lane (route, destination) VALUES ('/fanout', ?)",
    destination
  );
}

function pendingRows(state: NetScopeDurableState): Array<{ destination: string; seq: number; attempts: number }> {
  return (
    state.storage.sql.exec(
      "SELECT destination, seq, attempts FROM net_scope_outbox WHERE status = 'pending' ORDER BY destination, seq"
    ) as { toArray(): Array<{ destination: string; seq: number; attempts: number }> }
  ).toArray();
}

function laneRows(state: NetScopeDurableState): Array<{ route: string; destination: string }> {
  return (
    state.storage.sql.exec("SELECT route, destination FROM net_scope_outbox_lane ORDER BY route, destination") as {
      toArray(): Array<{ route: string; destination: string }>;
    }
  ).toArray();
}

/** Parse the pass metrics a drain emitted (Phase-0 observability for the
 * bounded-pass invariant). */
function drainPassMetrics(lines: string[]): Array<{ considered: number; delivered: number }> {
  return lines
    .filter((line) => line.includes("net_scope_outbox_drain_pass"))
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { considered: number; delivered: number });
}

function tick(id: string, atMs: number): ScheduledTurn {
  return { id, at_logical_time: atMs, call: { actor: "#actor", target: "#thing", verb: "tick", args: [] } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Phase 3 — bounded outbox drain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a large healthy backlog fully delivers through bounded passes (rows/pass flat as the backlog grows)", async () => {
    const metricLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      metricLines.push(args.map(String).join(" "));
    });
    const healthy = okStub();
    const scope = netState("bounded-healthy");
    const env: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: () => healthy.stub };
    const scopeDO = new NetScopeDO(scope.state, env);
    const BACKLOG = 100;
    for (let seq = 1; seq <= BACKLOG; seq++) insertRow(scope.state, "gateway:mirror", seq);

    await kick(scopeDO, env);
    await scope.settle();

    // Everything delivered, in seq order, via multiple bounded passes.
    expect(pendingRows(scope.state)).toEqual([]);
    expect(healthy.received).toHaveLength(BACKLOG);
    expect((healthy.received as Array<{ seq: number }>).map((b) => b.seq)).toEqual(
      Array.from({ length: BACKLOG }, (_, i) => i + 1)
    );
    const passes = drainPassMetrics(metricLines);
    expect(passes.length).toBeGreaterThan(1); // the bound forced multiple passes
    // THE INVARIANT: no single pass considered more than the lane bound.
    for (const pass of passes) expect(pass.considered).toBeLessThanOrEqual(32);
    // The emptied lane left no directory residue.
    expect(laneRows(scope.state)).toEqual([]);
  });

  it("one drain invocation is budgeted: a catch-up backlog yields to the alarm continuation instead of consuming the invocation (review #2)", async () => {
    const healthy = okStub();
    const scope = netState("bounded-budget");
    const env: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: () => healthy.stub };
    const scopeDO = new NetScopeDO(scope.state, env);
    // More than PASSES_PER_DRAIN × ROWS_PER_LANE (8 × 32 = 256) rows in
    // one lane: the first kick must stop at the budget and arm an
    // immediate alarm; the alarm's fresh invocation finishes the job.
    const BACKLOG = 300;
    for (let seq = 1; seq <= BACKLOG; seq++) insertRow(scope.state, "gateway:mirror", seq);

    const before = Date.now();
    await kick(scopeDO, env);
    await scope.settle();
    expect(healthy.received).toHaveLength(256); // exactly the budget
    expect(pendingRows(scope.state)).toHaveLength(BACKLOG - 256);
    // The continuation: the retry alarm armed at ~now (due work remains).
    const armed = scope.alarms.filter((at): at is number => at !== null);
    expect(armed.length).toBeGreaterThanOrEqual(1);
    expect(armed[armed.length - 1]).toBeLessThanOrEqual(Date.now() + 5);
    expect(armed[armed.length - 1]).toBeGreaterThanOrEqual(before - 5);

    // The next invocation (the fake's alarms never self-fire — kick
    // stands in for the alarm's deferPendingDrain) finishes the backlog
    // in order.
    await kick(scopeDO, env);
    await scope.settle();
    expect(pendingRows(scope.state)).toEqual([]);
    expect((healthy.received as Array<{ seq: number }>).map((b) => b.seq)).toEqual(
      Array.from({ length: BACKLOG }, (_, i) => i + 1)
    );
  });

  it("a stuck destination attempts only its lane head, never starves a healthy lane, and arms the alarm at the head's retry — not a spin", async () => {
    const metricLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      metricLines.push(args.map(String).join(" "));
    });
    const healthy = okStub();
    const down = downStub();
    const scope = netState("bounded-stuck");
    const env: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => (destination === "gateway:down" ? down.stub : healthy.stub)
    };
    const scopeDO = new NetScopeDO(scope.state, env);
    // A deep stuck backlog plus a healthy lane. Destination "gateway:down"
    // sorts BEFORE "gateway:up", so starvation would hit the healthy lane.
    for (let seq = 1; seq <= 80; seq++) insertRow(scope.state, "gateway:down", seq);
    for (let seq = 1; seq <= 3; seq++) insertRow(scope.state, "gateway:up", seq);

    const before = Date.now();
    await kick(scopeDO, env);
    await scope.settle();

    // Healthy lane delivered fully despite the stuck neighbor.
    expect(healthy.received).toHaveLength(3);
    // The stuck lane attempted ONLY its head (CO2.7: nothing may pass a
    // failed head), exactly once this drain; the other 79 rows were
    // never rewritten (attempts stay 0).
    expect(down.received).toHaveLength(1);
    expect((down.received[0] as { seq: number }).seq).toBe(1);
    const stuck = pendingRows(scope.state).filter((row) => row.destination === "gateway:down");
    expect(stuck).toHaveLength(80);
    expect(stuck.filter((row) => row.attempts > 0)).toHaveLength(1);
    expect(stuck[0].attempts).toBe(1); // head, seq 1
    // The drain terminated (this line being reached proves no fresh-row
    // spin) and armed the retry alarm at the HEAD's due-time: strictly
    // after the attempt, i.e. a real backoff window — never "now" derived
    // from the 79 due-but-blocked rows behind it.
    const armed = scope.alarms.filter((at): at is number => at !== null);
    expect(armed.length).toBeGreaterThanOrEqual(1);
    expect(armed[armed.length - 1]).toBeGreaterThanOrEqual(before + 250); // backoff(1)
  });

  it("legacy outbox and scheduled tables backfill the Phase-3 columns and lane directory idempotently", async () => {
    const scope = netState("bounded-migrate");
    // Pre-Phase-3 shapes: outbox without scope/seq/next_attempt_at_ms,
    // scheduled without due_at.
    scope.state.storage.sql.exec(
      "CREATE TABLE net_scope_outbox (route TEXT NOT NULL, id TEXT NOT NULL, destination TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, last_attempt_at_ms INTEGER, PRIMARY KEY (route, id))"
    );
    const legacyBody = JSON.stringify({ scope: SCOPE, seq: 7, cells: [], observations: [] });
    scope.state.storage.sql.exec(
      "INSERT INTO net_scope_outbox (route, id, destination, body, status, attempts, last_attempt_at_ms) VALUES ('/fanout', ?, 'gateway:legacy', ?, 'pending', 2, 1000)",
      `gateway:legacy/${SCOPE}/7`,
      legacyBody
    );
    scope.state.storage.sql.exec("CREATE TABLE net_scope_scheduled (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    scope.state.storage.sql.exec(
      "INSERT INTO net_scope_scheduled (id, body) VALUES ('sched-legacy', ?)",
      JSON.stringify(tick("sched-legacy", 123456))
    );

    const healthy = okStub();
    const env: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: () => healthy.stub };
    // Construction migrates; a second construction over the same storage
    // must be a no-op (idempotent).
    new NetScopeDO(scope.state, env);
    const scopeDO = new NetScopeDO(scope.state, env);

    const migrated = (
      scope.state.storage.sql.exec(
        "SELECT scope, seq, next_attempt_at_ms FROM net_scope_outbox WHERE id = ?",
        `gateway:legacy/${SCOPE}/7`
      ) as { toArray(): Array<{ scope: string; seq: number; next_attempt_at_ms: number }> }
    ).toArray();
    expect(migrated).toEqual([{ scope: SCOPE, seq: 7, next_attempt_at_ms: 1000 + 500 }]); // last_attempt + backoff(2)
    expect(laneRows(scope.state)).toEqual([{ route: "/fanout", destination: "gateway:legacy" }]);
    // Review #3: the backfills are marker-gated one-time migrations — a
    // cold construction over an already-migrated store never re-scans
    // the backlog. The markers land in net_scope_meta.
    const markers = (
      scope.state.storage.sql.exec(
        "SELECT id FROM net_scope_meta WHERE id IN ('migrated_outbox_lane_directory', 'migrated_scheduled_due_at') ORDER BY id"
      ) as { toArray(): Array<{ id: string }> }
    ).toArray();
    expect(markers.map((row) => row.id)).toEqual(["migrated_outbox_lane_directory", "migrated_scheduled_due_at"]);
    const scheduled = (
      scope.state.storage.sql.exec("SELECT due_at FROM net_scope_scheduled WHERE id = 'sched-legacy'") as {
        toArray(): Array<{ due_at: number }>;
      }
    ).toArray();
    expect(scheduled).toEqual([{ due_at: 123456 }]);

    // The migrated row is past its backoff window (wall clock is far
    // beyond 1500ms) — a kick delivers it and prunes the lane.
    await kick(scopeDO, env);
    await scope.settle();
    expect(pendingRows(scope.state)).toEqual([]);
    expect(healthy.received).toHaveLength(1);
    expect(laneRows(scope.state)).toEqual([]);
  });
});

describe("Phase 3 — bounded scheduled bursts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a due burst dispatches in bounded batches with an immediate re-arm; every turn reaches the planner exactly once", async () => {
    const planner = okStub();
    const scope = netState("bounded-burst");
    const env: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === "gateway:planner-b") return planner.stub;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const scopeDO = new NetScopeDO(scope.state, env);
    await call(scopeDO, env, "/subscribe", { destination: "gateway:planner-b", role: "planner" });
    const BURST = 80;
    const dueAt = Date.now() + 30;
    for (let i = 0; i < BURST; i++) {
      await call(scopeDO, env, "/schedule", { scope: SCOPE, catalog_epoch: EPOCH, turn: tick(`burst-${String(i).padStart(3, "0")}`, dueAt + (i % 7)) });
    }
    await sleep(60);

    // First firing: at most one batch (32) leaves the scheduled family;
    // the leftover due turns arm an immediate wake.
    const beforeAlarm = Date.now();
    await scopeDO.alarm();
    const parkedAfterFirst = (
      scope.state.storage.sql.exec("SELECT COUNT(*) AS n FROM net_scope_scheduled") as { toArray(): Array<{ n: number }> }
    ).toArray()[0].n;
    expect(Number(parkedAfterFirst)).toBe(BURST - 32);
    const armed = scope.alarms.filter((at): at is number => at !== null);
    expect(armed.length).toBeGreaterThanOrEqual(1);
    // Immediate re-arm: the scope alarm landed at "now", not at some
    // future turn (there are none) and not cleared.
    expect(Math.min(...armed.slice(-3))).toBeLessThanOrEqual(Date.now());
    expect(Math.min(...armed.slice(-3))).toBeGreaterThanOrEqual(beforeAlarm - 5);

    // Firing the wake repeatedly drains the burst in batches.
    await scopeDO.alarm();
    await scopeDO.alarm();
    await scope.settle();
    const parkedAfterAll = (
      scope.state.storage.sql.exec("SELECT COUNT(*) AS n FROM net_scope_scheduled") as { toArray(): Array<{ n: number }> }
    ).toArray()[0].n;
    expect(Number(parkedAfterAll)).toBe(0);

    // Exactly once, all 80, at the planner.
    const ids = (planner.received as Array<{ scheduled_turn: ScheduledTurn }>).map((b) => b.scheduled_turn.id).sort();
    expect(ids).toHaveLength(BURST);
    expect(new Set(ids).size).toBe(BURST);
  });
});
