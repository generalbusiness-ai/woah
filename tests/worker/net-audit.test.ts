/**
 * AU6/AU10 — the audit lane end-to-end on the fake-DO lane:
 * commit → records minted in the commit transaction → durable /audit
 * outbox → shard append (idempotent) → partition query → hash-chain
 * verify. Gates covered: AU10.1 completeness + dual attribution,
 * AU10.2 idempotent redelivery, AU10.6 lane independence (a dead audit
 * sink never blocks commits; records deliver after it heals).
 */
import { describe, expect, it, vi } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import type { Principal } from "../../src/net/attribution";
import { cellsFromSerialized, storeCells, type ShadowTurnCall } from "../../src/net/bridge";
import { CellStore } from "../../src/net/cells";
import { planTurn } from "../../src/net/plan";
import type { ScopeClassifier } from "../../src/net/route";
import { NetAuditDO, type NetAuditEnv } from "../../src/worker/net/audit-do";
import { NetGatewayDO, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "net-audit-test-secret";
const SCOPE = "home";
const EPOCH = "cat-audit-1";
const classifier: ScopeClassifier = { scopeOf: () => SCOPE, isShared: (scope) => scope === SCOPE };

function doState(name: string) {
  const fake = new FakeDurableObjectState(name);
  return {
    state: {
      id: fake.id,
      waitUntil: () => {},
      storage: {
        sql: fake.storage.sql,
        transactionSync: fake.storage.transactionSync,
        setAlarm: () => {},
        deleteAlarm: () => {}
      }
    },
    close: () => fake.close()
  };
}

async function call(instance: NetScopeDO | NetAuditDO, env: { WOO_INTERNAL_SECRET?: string }, path: string, body?: unknown) {
  const request =
    body === undefined
      ? new Request(`https://do${path}`)
      : new Request(`https://do${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
  return (instance as { fetch(r: Request): Promise<Response> }).fetch(await signInternalRequest(env, request));
}

/** Wait for deferred drains (host.defer runs detached). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

function worldFixture(tag: string) {
  const world = createWorld();
  const session = world.auth(`guest:audit-lane-${tag}`);
  const actor = session.actor;
  world.createObject({ id: "lane_box", name: "Lane Box", parent: "$thing", owner: actor });
  world.defineProperty("lane_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  expect(
    installVerb(world, "lane_box", "bump", `verb :bump() rxd { this.counter = this.counter + 1; return this.counter; }`, null).ok
  ).toBe(true);
  world.setCustomerOf(actor, { customer: "acct_acting", derived_via: "account" });
  return { world, session, actor };
}

function harness(tag: string, options: { failAudit?: { failing: boolean } } = {}) {
  const audit = doState(`audit-${tag}`);
  const auditEnv: NetAuditEnv = { WOO_INTERNAL_SECRET: SECRET, NET_AUDIT_SEGMENT_ROWS: "2" };
  const auditDO = new NetAuditDO(audit.state, auditEnv);
  const resolve = (destination: string) => {
    if (destination === "audit:audit-0") {
      if (options.failAudit?.failing) throw new Error("audit sink down");
      return auditDO;
    }
    throw new Error(`unresolvable destination ${destination}`);
  };
  const scope = doState(`scope-${tag}`);
  const scopeEnv: NetScopeEnv = {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: resolve,
    NET_AUDIT_SHARDS: "1"
  };
  const scopeDO = new NetScopeDO(scope.state as never, scopeEnv);
  return { auditDO, auditEnv, scopeDO, scopeEnv, scopeState: scope.state, close: () => (audit.close(), scope.close()) };
}

async function planBump(fixture: ReturnType<typeof worldFixture>, principal: Principal, key: string, base: { seq: number; hash: string }) {
  const authority = new CellStore("authority");
  for (const cell of cellsFromSerialized(fixture.world.exportWorld())) {
    authority.commit({ ...cell, stamp: { scope_head: "seed", catalog_epoch: EPOCH } } as never);
  }
  const view = new CellStore("derived");
  for (const cell of storeCells(authority)) view.install(cell);
  const call_: ShadowTurnCall = {
    kind: "woo.turn_call.shadow.v1",
    id: key,
    route: "direct",
    scope: SCOPE,
    session: fixture.session.id,
    actor: fixture.actor,
    target: "lane_box",
    verb: "bump",
    args: []
  };
  return planTurn({
    call: call_,
    principal,
    trace: { traceparent: "00-aaaabbbbccccddddeeeeffff00001111-1234567890abcdef-01", origin: "adopted" },
    view,
    planningScope: SCOPE,
    classifier,
    base,
    idempotencyKey: key,
    stamp: { scope_head: "gateway", catalog_epoch: EPOCH }
  });
}

const PRINCIPAL = (fixture: ReturnType<typeof worldFixture>): Principal => ({
  attribution: "authenticated",
  customer: "acct_acting",
  actor: fixture.actor,
  session: fixture.session.id
});

describe("audit lane end-to-end (AU6, fake-DO)", () => {
  it("deletes a delivered adoption-suffixed row by its durable identity", async () => {
    const h = harness("adoption-row-id");
    const destination = "audit:audit-0";
    const id = `${destination}/${SCOPE}/7:adopt`;
    const body = {
      scope: SCOPE,
      seq: 7,
      cells: [],
      observations: [],
      audit_records: [
        {
          partition: "acct_owner",
          record: {
            ts: 7,
            idempotency: `${SCOPE}:7:adopt`,
            outcome: "ok",
            producer: { kind: "scope", name: SCOPE },
            action: { kind: "commit", scope: SCOPE, seq: 7, head: "head-7" },
            subjects: ["lane_box"],
            cause: { scope: "origin", seq: 3 }
          }
        }
      ]
    };
    h.scopeState.storage.sql.exec(
      "INSERT INTO net_scope_outbox (route, id, destination, body, status, attempts, last_attempt_at_ms, scope, seq, next_attempt_at_ms) VALUES ('/audit', ?, ?, ?, 'pending', 0, NULL, ?, ?, 0)",
      id,
      destination,
      JSON.stringify(body),
      SCOPE,
      7
    );
    h.scopeState.storage.sql.exec(
      "INSERT INTO net_scope_outbox_lane (route, destination) VALUES ('/audit', ?)",
      destination
    );

    // Any ordinary request kicks the detached durable drain. Before the
    // regression fix, hydration rebuilt the unsuffixed id: delivery
    // succeeded, but DELETE targeted a nonexistent row and left this one
    // pending forever.
    await call(h.scopeDO, h.scopeEnv, "/net/head");
    await settle();
    const delivered = (await (
      await call(h.auditDO, h.auditEnv, "/net/audit-query", { partition: "acct_owner" })
    ).json()) as { records: unknown[] };
    expect(delivered.records).toHaveLength(1);
    const pending = (
      h.scopeState.storage.sql.exec("SELECT id FROM net_scope_outbox WHERE route = '/audit'") as unknown as {
        toArray(): Array<{ id: string }>;
      }
    ).toArray();
    expect(pending).toEqual([]);

    // A second drain cannot redeliver a zombie row.
    await call(h.scopeDO, h.scopeEnv, "/net/head");
    await settle();
    const after = (await (
      await call(h.auditDO, h.auditEnv, "/net/audit-query", { partition: "acct_owner" })
    ).json()) as { records: unknown[] };
    expect(after.records).toHaveLength(1);
    h.close();
  });

  it("a committed turn yields the acting record AND the resource-owner copy; citation verifies; replay adds nothing", async () => {
    const fixture = worldFixture("e2e");
    const h = harness("e2e");
    // Seed with a DIFFERENT owning customer → dual attribution.
    const seeded = await call(h.scopeDO, h.scopeEnv, "/net/seed", {
      scope: SCOPE,
      catalog_epoch: EPOCH,
      cells: cellsFromSerialized(fixture.world.exportWorld()),
      attribution: { customer: "acct_owner", derived_via: "anchor_owner", stamped_at_epoch: EPOCH }
    });
    expect(seeded.ok).toBe(true);
    const head = (await (await call(h.scopeDO, h.scopeEnv, "/net/head")).json()) as { head: { seq: number; hash: string } };

    const plan = await planBump(fixture, PRINCIPAL(fixture), "k-lane-1", head.head);
    const submitted = await call(h.scopeDO, h.scopeEnv, "/net/submit", plan.submit);
    const reply = (await submitted.json()) as { status: string; head: { seq: number; hash: string } };
    expect(reply.status).toBe("accepted");
    // Submits continue their drains through a fresh alarm event (the CF
    // subrequest-depth rule); the fake harness has no alarms, so an
    // ordinary request kicks the pending drain.
    await call(h.scopeDO, h.scopeEnv, "/net/head");
    await settle();

    // AU10.1: exactly one acting record, and the dual copy — same content.
    for (const partition of ["acct_acting", "acct_owner"]) {
      const res = (await (
        await call(h.auditDO, h.auditEnv, "/net/audit-query", { partition })
      ).json()) as { records: Array<Record<string, unknown>> };
      expect(res.records, partition).toHaveLength(1);
      expect(res.records[0]).toMatchObject({
        outcome: "ok",
        idempotency: `${SCOPE}:${reply.head.seq}`,
        trace_id: "aaaabbbbccccddddeeeeffff00001111",
        action: { kind: "commit", verb: "bump", scope: SCOPE, seq: reply.head.seq, head: reply.head.hash }
      });
    }

    // AU10.2: an idempotent RESUBMIT (same key) commits nothing new and
    // mints nothing new.
    const replayed = (await (await call(h.scopeDO, h.scopeEnv, "/net/submit", plan.submit)).json()) as {
      status: string;
      replayed?: boolean;
    };
    expect(replayed).toMatchObject({ status: "accepted", replayed: true });
    await call(h.scopeDO, h.scopeEnv, "/net/head");
    await settle();
    const after = (await (
      await call(h.auditDO, h.auditEnv, "/net/audit-query", { partition: "acct_acting" })
    ).json()) as { records: unknown[] };
    expect(after.records).toHaveLength(1);

    // AU10.2: raw redelivery no-ops at the shard.
    const again = (await (
      await call(h.auditDO, h.auditEnv, "/net/audit-append", {
        from_scope: SCOPE,
        seq: reply.head.seq,
        records: [
          {
            partition: "acct_acting",
            record: {
              ts: 1,
              idempotency: `${SCOPE}:${reply.head.seq}`,
              outcome: "ok",
              producer: { kind: "scope", name: SCOPE },
              action: { kind: "commit" },
              subjects: []
            }
          }
        ]
      })
    ).json()) as { appended: number; duplicates: number };
    expect(again).toMatchObject({ appended: 0, duplicates: 1 });
    h.close();
  });

  it("AU10.6 lane independence: commits accept while the audit sink is down; records deliver after it heals", async () => {
    const fixture = worldFixture("fault");
    const failAudit = { failing: true };
    const h = harness("fault", { failAudit });
    await call(h.scopeDO, h.scopeEnv, "/net/seed", {
      scope: SCOPE,
      catalog_epoch: EPOCH,
      cells: cellsFromSerialized(fixture.world.exportWorld())
    });
    const head = (await (await call(h.scopeDO, h.scopeEnv, "/net/head")).json()) as { head: { seq: number; hash: string } };
    const plan = await planBump(fixture, PRINCIPAL(fixture), "k-fault-1", head.head);
    const reply = (await (await call(h.scopeDO, h.scopeEnv, "/net/submit", plan.submit)).json()) as { status: string };
    expect(reply.status).toBe("accepted"); // the dead sink never blocked the commit
    await settle();
    const during = (await (
      await call(h.auditDO, h.auditEnv, "/net/audit-query", { partition: "acct_acting" })
    ).json()) as { records: unknown[] };
    expect(during.records).toHaveLength(0);

    // Heal, then kick a drain with an ordinary request.
    failAudit.failing = false;
    await call(h.scopeDO, h.scopeEnv, "/net/head");
    await settle();
    const after = (await (
      await call(h.auditDO, h.auditEnv, "/net/audit-query", { partition: "acct_acting" })
    ).json()) as { records: unknown[] };
    expect(after.records).toHaveLength(1);
    h.close();
  });
});

describe("gateway edge-audit lane (AU1.2/AU6.1) — fresh-lineage continuation", () => {
  it("a refusal enqueues durably, delivers only from the alarm event, and a dead shard re-arms", async () => {
    // Recording audit stub that can be toggled unhealthy — the AU10.6
    // posture for the edge lane.
    const received: unknown[] = [];
    let healthy = true;
    const auditStub = {
      fetch: async (request: Request) => {
        if (!healthy) return new Response("audit shard down", { status: 500 });
        received.push(await request.json());
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
    };
    const fake = new FakeDurableObjectState("edge-audit-gateway");
    const alarms: Array<number | null> = [];
    const state = {
      id: fake.id,
      waitUntil: () => {},
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
    const env: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_AUDIT_SHARDS: "1",
      NET_RESOLVE: (destination: string) => {
        if (destination.startsWith("audit:")) return auditStub;
        throw new Error(`edge-audit test resolved unexpected destination ${destination}`);
      }
    } as NetGatewayEnv;
    const gateway = new NetGatewayDO(state as never, env);

    // A credential-less client call refuses at the edge and mints the
    // audit record in the same isolate write.
    const refused = await gateway.fetch(new Request("https://do/net-api/cell?key=object_live:someone"));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const outboxCount = () =>
      Number(
        (fake.storage.sql.exec("SELECT COUNT(*) AS n FROM net_gateway_audit_outbox") as unknown as { toArray(): Array<{ n: number }> }).toArray()[0]!.n
      );
    expect(outboxCount()).toBeGreaterThan(0);
    await settle();
    // CO2.7: NOTHING delivered from the request lineage — a deferred
    // (waitUntil) append inherits the request's subrequest chain, which
    // compounded to "Subrequest depth limit exceeded" in production. The
    // request only ARMS the alarm; the alarm event delivers.
    expect(received).toHaveLength(0);
    expect(alarms.some((at) => at !== null)).toBe(true);

    // Dead shard: the alarm drain fails, rows stay, a retry alarm arms.
    healthy = false;
    const armedBefore = alarms.length;
    await gateway.alarm();
    expect(received).toHaveLength(0);
    expect(outboxCount()).toBeGreaterThan(0);
    expect(alarms.slice(armedBefore).some((at) => at !== null)).toBe(true);

    // Healed: the next alarm delivers and clears the outbox.
    healthy = true;
    await gateway.alarm();
    expect(received).toHaveLength(1);
    expect(outboxCount()).toBe(0);
    fake.close();
  });
});

describe("NetAuditDO segments and verification (AU6.3/AU7)", () => {
  function record(partition: string, id: string, ts: number, over: Record<string, unknown> = {}) {
    return {
      partition,
      record: {
        ts,
        idempotency: id,
        outcome: "ok",
        producer: { kind: "scope", name: "s" },
        action: { kind: "commit", verb: "v" },
        subjects: [],
        principal: { attribution: "authenticated", customer: partition, actor: "#a" },
        ...over
      }
    };
  }

  it("seals hash-chained segments at the threshold and verifies the chain; malformed records are counted, not lost", async () => {
    const st = doState("seal");
    const env: NetAuditEnv = { WOO_INTERNAL_SECRET: SECRET, NET_AUDIT_SEGMENT_ROWS: "2" };
    const audit = new NetAuditDO(st.state, env);
    const appended = (await (
      await call(audit, env, "/net/audit-append", {
        from_scope: "s",
        seq: 1,
        records: [record("acct_x", "s:1", 10), record("acct_x", "s:2", 20), "garbage"]
      })
    ).json()) as Record<string, unknown>;
    expect(appended).toMatchObject({ appended: 2, malformed: 1, sealed: 1 });
    // Second segment chains onto the first.
    await call(audit, env, "/net/audit-append", {
      from_scope: "s",
      seq: 2,
      records: [record("acct_x", "s:3", 30), record("acct_x", "s:4", 40)]
    });
    const verify = (await (await call(audit, env, "/net/audit-verify", { partition: "acct_x" })).json()) as Record<string, unknown>;
    expect(verify).toEqual({ ok: true, segments: 2 });

    // Records remain queryable after sealing, filters apply, isolation holds.
    const q = (await (
      await call(audit, env, "/net/audit-query", { partition: "acct_x", from_ts: 15, to_ts: 35 })
    ).json()) as { records: Array<{ idempotency: string }> };
    expect(q.records.map((r) => r.idempotency).sort()).toEqual(["s:2", "s:3"]);
    const other = (await (
      await call(audit, env, "/net/audit-query", { partition: "acct_y" })
    ).json()) as { records: unknown[] };
    expect(other.records).toHaveLength(0);
    st.close();
  });
});

describe("submit span honesty (review finding 3)", () => {
  it("fresh acceptance emits net.commit; replays and rejections emit net.scope.submit", async () => {
    const fixture = worldFixture("spans");
    const h = harness("spans");
    await call(h.scopeDO, h.scopeEnv, "/net/seed", {
      scope: SCOPE,
      catalog_epoch: EPOCH,
      cells: cellsFromSerialized(fixture.world.exportWorld())
    });
    const head = (await (await call(h.scopeDO, h.scopeEnv, "/net/head")).json()) as { head: { seq: number; hash: string } };
    const plan = await planBump(fixture, PRINCIPAL(fixture), "k-span-1", head.head);

    const spans: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      if (args[0] === "woo.span" && typeof args[1] === "string") spans.push(JSON.parse(args[1]) as Record<string, unknown>);
    });
    try {
      // Fresh acceptance → net.commit with the new seq.
      const fresh = (await (await call(h.scopeDO, h.scopeEnv, "/net/submit", plan.submit)).json()) as {
        status: string;
        head: { seq: number };
      };
      expect(fresh.status).toBe("accepted");
      expect(spans.map((s) => s.name)).toEqual(["net.commit"]);
      expect((spans[0]?.attributes as Record<string, unknown>)["woo.seq"]).toBe(fresh.head.seq);

      // Idempotent replay → net.scope.submit, marked, NO manufactured commit.
      spans.length = 0;
      const replayed = (await (await call(h.scopeDO, h.scopeEnv, "/net/submit", plan.submit)).json()) as {
        replayed?: boolean;
      };
      expect(replayed.replayed).toBe(true);
      expect(spans.map((s) => s.name)).toEqual(["net.scope.submit"]);
      expect((spans[0]?.attributes as Record<string, unknown>)["woo.replayed"]).toBe("true");
      expect((spans[0]?.attributes as Record<string, unknown>)["woo.seq"]).toBeUndefined();

      // Rejection (stale base under a new key) → net.scope.submit with the verdict.
      spans.length = 0;
      const stale = await planBump(fixture, PRINCIPAL(fixture), "k-span-2", head.head);
      const rejected = (await (
        await call(h.scopeDO, h.scopeEnv, "/net/submit", { ...stale.submit, base: { seq: 999, hash: "future" } })
      ).json()) as { status: string };
      expect(rejected.status).toBe("rejected");
      expect(spans.map((s) => s.name)).toEqual(["net.scope.submit"]);
      expect((spans[0]?.attributes as Record<string, unknown>)["woo.reason"]).toBeDefined();
      expect(spans[0]?.status).toBe("error");
    } finally {
      spy.mockRestore();
    }
    h.close();
  });
});
