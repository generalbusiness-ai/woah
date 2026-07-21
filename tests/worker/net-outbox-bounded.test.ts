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
import { NetScopeDO, withDeliverySeq, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
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

/** 200-replying stub whose deliveries block on a gate until released —
 * the interleaving harness for mid-drain races (concurrent enqueue,
 * submit arrival). `firstArrived` resolves when the first request REACHES
 * the stub (before the gate), so tests can act inside the await window. */
function gatedStub(): {
  stub: NetStub;
  received: unknown[];
  release: () => void;
  firstArrived: Promise<void>;
} {
  const received: unknown[] = [];
  let releaseFn!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  let arrivedFn!: () => void;
  const firstArrived = new Promise<void>((resolve) => {
    arrivedFn = resolve;
  });
  return {
    received,
    release: releaseFn,
    firstArrived,
    stub: {
      fetch: async (request: Request) => {
        arrivedFn();
        await gate;
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
function drainPassMetrics(
  lines: string[]
): Array<{ considered: number; delivered: number; ms: number; rpc_ms: number; sql_ms: number }> {
  return lines
    .filter((line) => line.includes("net_scope_outbox_drain_pass"))
    .map(
      (line) =>
        JSON.parse(line.slice(line.indexOf("{"))) as {
          considered: number;
          delivered: number;
          ms: number;
          rpc_ms: number;
          sql_ms: number;
        }
    );
}

/** All emitted metric events of one kind, parsed off the console mirror. */
function metricsOfKind(lines: string[], kind: string): Array<Record<string, unknown>> {
  return lines
    .filter((line) => line.startsWith("woo.metric") && line.includes(`"kind":"${kind}"`))
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>);
}

function tick(id: string, atMs: number): ScheduledTurn {
  return { id, at_logical_time: atMs, call: { actor: "#actor", target: "#thing", verb: "tick", args: [] } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withDeliverySeq — single-stringify fanout bodies", () => {
  it("splices delivery_seq byte-equivalently to a full re-stringify", () => {
    const base = {
      scope: "room:x",
      seq: 42,
      cells: [{ key: "k", value: { v: 'quote"and{brace}' } }],
      observations: [{ text: "nested } tail" }]
    };
    const spliced = withDeliverySeq(JSON.stringify(base), 9);
    expect(spliced).toBe(JSON.stringify({ ...base, delivery_seq: 9 }));
  });
});

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

    // One invocation intentionally yields after four rows. Repeated fresh
    // invocations (standing in for immediate alarm events) drain the whole
    // backlog without any one event monopolizing the authority.
    for (let i = 0; i < BACKLOG / 4; i += 1) {
      await kick(scopeDO, env);
      await scope.settle();
    }

    // Everything delivered, in seq order, via multiple bounded passes.
    expect(pendingRows(scope.state)).toEqual([]);
    expect(healthy.received).toHaveLength(BACKLOG);
    expect((healthy.received as Array<{ seq: number }>).map((b) => b.seq)).toEqual(
      Array.from({ length: BACKLOG }, (_, i) => i + 1)
    );
    const passes = drainPassMetrics(metricLines);
    expect(passes.length).toBeGreaterThan(1); // the bound forced multiple passes
    // THE INVARIANT: no single pass considered more than the lane bound.
    for (const pass of passes) expect(pass.considered).toBeLessThanOrEqual(4);
    // The emptied lane left no directory residue.
    expect(laneRows(scope.state)).toEqual([]);
  });

  it("stamps wake, hydration, and drain-pass durations (2026-07-20 hot-room stall attribution)", async () => {
    const metricLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      metricLines.push(args.map(String).join(" "));
    });
    const healthy = okStub();
    const scope = netState("bounded-durations");
    const env: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: () => healthy.stub };
    const scopeDO = new NetScopeDO(scope.state, env);

    // The wake stamp comes from the constructor itself — a mid-run
    // eviction shows up as a fresh do_constructor next to the stall.
    const wakes = metricsOfKind(metricLines, "do_constructor");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.class).toBe("NetScopeDO");
    expect(typeof wakes[0]!.ms).toBe("number");

    // Seeding builds the sequencer: exactly one hydration event per DO
    // lifetime, carrying its cost and its distance from the wake.
    await call(scopeDO, env, "/seed", { scope: SCOPE, catalog_epoch: EPOCH, cells: [], relations: [] });
    const hydrations = metricsOfKind(metricLines, "net_scope_hydrated");
    expect(hydrations).toHaveLength(1);
    expect(hydrations[0]!.scope).toBe(SCOPE);
    expect(typeof hydrations[0]!.ms).toBe("number");
    expect(typeof hydrations[0]!.since_construct_ms).toBe("number");

    // A drain pass reports how long it occupied the authority.
    insertRow(scope.state, "gateway:mirror", 1);
    await kick(scopeDO, env);
    await scope.settle();
    const passes = drainPassMetrics(metricLines);
    expect(passes.length).toBeGreaterThanOrEqual(1);
    for (const pass of passes) {
      expect(typeof pass.ms).toBe("number");
      expect(pass.ms).toBeGreaterThanOrEqual(0);
    }
    // Hydration stays once-per-lifetime: the drain did not rebuild it.
    expect(metricsOfKind(metricLines, "net_scope_hydrated")).toHaveLength(1);
    scope.close();
  });

  it("delivers /fanout rows as their exact stored bytes and splits pass duration into rpc_ms/sql_ms", async () => {
    const metricLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      metricLines.push(args.map(String).join(" "));
    });
    const healthy = okStub();
    const scope = netState("bounded-raw-bytes");
    const env: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: () => healthy.stub };
    const scopeDO = new NetScopeDO(scope.state, env);
    // A body with fields the drain itself never reads: raw pass-through
    // must deliver them byte-faithfully without a parse/re-stringify trip.
    const body = { scope: SCOPE, seq: 7, cells: [], observations: [{ type: "said", text: "raw ✓" }], delivery_seq: 3 };
    scope.state.storage.sql.exec(
      "INSERT INTO net_scope_outbox (route, id, destination, body, status, attempts, last_attempt_at_ms, scope, seq, next_attempt_at_ms) VALUES ('/fanout', ?, ?, ?, 'pending', 0, NULL, ?, ?, 0)",
      `gateway:mirror/${SCOPE}/7`,
      "gateway:mirror",
      JSON.stringify(body),
      SCOPE,
      7
    );
    scope.state.storage.sql.exec(
      "INSERT OR IGNORE INTO net_scope_outbox_lane (route, destination) VALUES ('/fanout', ?)",
      "gateway:mirror"
    );
    await kick(scopeDO, env);
    await scope.settle();

    expect(healthy.received).toHaveLength(1);
    expect(healthy.received[0]).toEqual(body);
    expect(pendingRows(scope.state)).toEqual([]);
    // Provable-empty prune: one lane, one row, delivered — the directory
    // row is gone without needing the EXISTS probe branch.
    expect(laneRows(scope.state)).toEqual([]);
    const passes = drainPassMetrics(metricLines);
    expect(passes).toHaveLength(1);
    expect(typeof passes[0]!.rpc_ms).toBe("number");
    expect(typeof passes[0]!.sql_ms).toBe("number");
    // The two halves partition the pass: neither may exceed the total.
    expect(passes[0]!.rpc_ms).toBeLessThanOrEqual(passes[0]!.ms);
    expect(passes[0]!.sql_ms).toBeLessThanOrEqual(passes[0]!.ms);
    scope.close();
  });

  it("a drain invocation yields to an in-flight submit and the retry alarm resumes it", async () => {
    const metricLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      metricLines.push(args.map(String).join(" "));
    });
    const healthy = okStub();
    const scope = netState("bounded-submit-priority");
    const env: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: () => healthy.stub };
    const scopeDO = new NetScopeDO(scope.state, env);
    insertRow(scope.state, "gateway:mirror", 1);

    // Simulate a commit executing on this DO (the fetch path uses these
    // methods around /net/submit; driving a full CommitSubmit here would
    // test the sequencer, not the scheduling edge).
    const submitOccupancy = scopeDO as unknown as { startSubmit(): void; finishSubmit(): void };
    submitOccupancy.startSubmit();
    await kick(scopeDO, env);
    await scope.settle();
    // Nothing delivered — the invocation gave way before any route pass —
    // and, critically, no due-now alarm is armed while the submit remains
    // active (that would spin alarm invocations until it finishes).
    expect(healthy.received).toHaveLength(0);
    expect(pendingRows(scope.state)).toHaveLength(1);
    expect(scope.alarms).toEqual([]);

    // The last submit completion arms exactly one continuation; its fresh
    // invocation then drains normally.
    submitOccupancy.finishSubmit();
    expect(scope.alarms.filter((at) => at !== null)).toHaveLength(1);
    await kick(scopeDO, env);
    await scope.settle();
    expect(healthy.received).toHaveLength(1);
    expect(pendingRows(scope.state)).toEqual([]);
    scope.close();
  });

  it("a row enqueued into a lane during the delivery await survives the prune and is delivered (at-least-once)", async () => {
    const gated = gatedStub();
    const scope = netState("bounded-concurrent-enqueue");
    const env: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: () => gated.stub };
    const scopeDO = new NetScopeDO(scope.state, env);
    insertRow(scope.state, "gateway:mirror", 1);

    // Start the drain; row 1's delivery parks on the gate.
    await kick(scopeDO, env);
    await gated.firstArrived;
    // A commit lands mid-await: its outbox row INSERTs and the lane
    // directory INSERT OR IGNORE no-ops against the still-present row —
    // exactly the window where a selection-time "provably empty" prune
    // would orphan it. (Direct SQL stands in for persistOutboxRow; the
    // durable rows are identical.)
    insertRow(scope.state, "gateway:mirror", 2);
    gated.release();
    await scope.settle();

    // Row 1 delivered; row 2 still pending AND still discoverable: the
    // guarded delete must have kept the lane directory row.
    expect(gated.received).toHaveLength(1);
    expect(pendingRows(scope.state).map((r) => r.seq)).toEqual([2]);
    expect(laneRows(scope.state)).toEqual([{ route: "/fanout", destination: "gateway:mirror" }]);

    // The next drain finds and delivers it — nothing stranded.
    await kick(scopeDO, env);
    await scope.settle();
    expect(gated.received).toHaveLength(2);
    expect(pendingRows(scope.state)).toEqual([]);
    expect(laneRows(scope.state)).toEqual([]);
    scope.close();
  });

  it("a submit arriving during a lane's delivery await halts the quantum between rows", async () => {
    const metricLines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      metricLines.push(args.map(String).join(" "));
    });
    const gated = gatedStub();
    const scope = netState("bounded-midlane-yield");
    const env: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: () => gated.stub };
    const scopeDO = new NetScopeDO(scope.state, env);
    for (let seq = 1; seq <= 3; seq += 1) insertRow(scope.state, "gateway:mirror", seq);

    // Row 1's delivery is in flight when the submit arrives. The lane must
    // finish that row (it was already attempted) and then stop — rows 2-3
    // untouched, no attempt counted — instead of pinning the drain for the
    // rest of the quantum.
    await kick(scopeDO, env);
    await gated.firstArrived;
    const submitOccupancy = scopeDO as unknown as { startSubmit(): void; finishSubmit(): void };
    submitOccupancy.startSubmit();
    gated.release();
    await scope.settle();

    expect(gated.received).toHaveLength(1);
    const remaining = pendingRows(scope.state);
    expect(remaining.map((r) => r.seq)).toEqual([2, 3]);
    expect(remaining.every((r) => r.attempts === 0)).toBe(true);
    expect(metricsOfKind(metricLines, "net_scope_drain_yield").some((m) => m.phase === "lane")).toBe(true);
    expect(scope.alarms).toEqual([]);

    // Submit done: one continuation is armed and delivery resumes in order.
    submitOccupancy.finishSubmit();
    expect(scope.alarms.filter((at) => at !== null)).toHaveLength(1);
    await kick(scopeDO, env);
    await scope.settle();
    expect(gated.received).toHaveLength(3);
    expect(pendingRows(scope.state)).toEqual([]);
    scope.close();
  });

  it("one drain invocation is budgeted: a catch-up backlog yields to the alarm continuation instead of consuming the invocation (review #2)", async () => {
    const healthy = okStub();
    const scope = netState("bounded-budget");
    const env: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: () => healthy.stub };
    const scopeDO = new NetScopeDO(scope.state, env);
    // More than PASSES_PER_DRAIN × ROWS_PER_LANE (1 × 4 = 4) rows in
    // one lane: the first kick must stop at the budget and arm an
    // immediate alarm; the alarm's fresh invocation finishes the job.
    const BACKLOG = 10;
    for (let seq = 1; seq <= BACKLOG; seq++) insertRow(scope.state, "gateway:mirror", seq);

    const before = Date.now();
    await kick(scopeDO, env);
    await scope.settle();
    expect(healthy.received).toHaveLength(4); // exactly the budget
    expect(pendingRows(scope.state)).toHaveLength(BACKLOG - 4);
    // The continuation: the retry alarm armed at ~now (due work remains).
    const armed = scope.alarms.filter((at): at is number => at !== null);
    expect(armed.length).toBeGreaterThanOrEqual(1);
    expect(armed[armed.length - 1]).toBeLessThanOrEqual(Date.now() + 5);
    expect(armed[armed.length - 1]).toBeGreaterThanOrEqual(before - 5);

    // Two more invocations (the fake's alarms never self-fire — kick
    // stands in for the alarm's deferPendingDrain) finish the backlog.
    for (let i = 0; i < 2; i += 1) {
      await kick(scopeDO, env);
      await scope.settle();
    }
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
    // Keep scheduling time deterministic. Serially inserting the full burst
    // can exceed a short real-time deadline under full-suite CPU contention,
    // which correctly makes /schedule reject the last rows as non-future.
    let logicalNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => logicalNow);
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
    logicalNow = dueAt + 10;

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

    // Firing the scheduled wake repeatedly moves all three 32-row
    // scheduled batches. Each alarm drain intentionally delivers only
    // four planner rows, so continue through fresh alarm events until the
    // 80-row outbox is empty as well.
    await scope.settle();
    for (let i = 0; i < 2; i += 1) {
      await scopeDO.alarm();
      await scope.settle();
    }
    const parkedAfterAll = (
      scope.state.storage.sql.exec("SELECT COUNT(*) AS n FROM net_scope_scheduled") as { toArray(): Array<{ n: number }> }
    ).toArray()[0].n;
    expect(Number(parkedAfterAll)).toBe(0);
    for (let i = 0; i < 17; i += 1) {
      await scopeDO.alarm();
      await scope.settle();
    }

    // Exactly once, all 80, at the planner.
    const ids = (planner.received as Array<{ scheduled_turn: ScheduledTurn }>).map((b) => b.scheduled_turn.id).sort();
    expect(ids).toHaveLength(BURST);
    expect(new Set(ids).size).toBe(BURST);
  });
});
