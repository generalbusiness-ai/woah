// Ready-to-scale Phase 5 — the v1 durable/wire contract freeze
// (notes/2026-07-08-net-ready-to-scale-plan.md).
//
// Once a namespace holds data, two classes of drift become world-breaking
// and unmigratable-in-place:
//
// 1. **Serialization drift**: `cellVersion` is the content address every
//    read validation (CO2.4) and post-state digest (CO4 step 10) compares.
//    If canonicalJson changes shape for the SAME logical value on a
//    rolling deploy, every cross-version read becomes a non-converging
//    read_version_mismatch → a world-wide E_BUDGET storm. The golden
//    hashes below pin the address of representative values byte-for-byte.
//
// 2. **Field-name drift**: the `.v1` kind tags are decorative (no receiver
//    checks them), so evolution is ADD-ONLY: pinned names must keep
//    working forever; renames are forbidden. The shape pins assert the
//    pinned names are present (a rename fails; an added field passes).
//
// Plus the Phase-5 durable-format stamps (schema_version rows — the one
// branch point for future durable evolution) and the no-expiry session
// mint guard.
import { describe, expect, it, vi } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { cellVersion, makeCell, serializeTransfer } from "../../src/net/cells";
import { mintSessionSubmit } from "../../src/net/sessions";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";

const SECRET = "net-wire-contract-secret";

function netState(name: string) {
  const fake = new FakeDurableObjectState(name);
  const state: NetScopeDurableState & NetGatewayDurableState = {
    id: fake.id,
    waitUntil: () => {},
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: () => {},
      deleteAlarm: () => {}
    }
  };
  return { state, close: () => fake.close() };
}

describe("cellVersion golden hashes (canonicalJson freeze)", () => {
  // Regenerating these constants IS a breaking change: an existing world's
  // cells are addressed by the old values, and a rolling deploy would put
  // both addressings live at once. If a hash here changes, the fix is to
  // restore the serialization — never to update the constant — until a
  // spec-versioned migration walks deployed worlds forward.
  const GOLDENS: Array<[string, unknown, string]> = [
    [
      "property_cell value+def",
      { value: 42, def: { name: "counter", perms: "rw", typeHint: "int", defaultValue: 0 } },
      "46d66bc6215563bf74b1c260bcd3b0e996185e6eaceae48dc33c82963af8c63e"
    ],
    [
      "object_lineage",
      { parent: "$thing", owner: "#actor", name: "Box", anchor: "room_a", flags: { fixed: true } },
      "e458f9b4aadc0e67702e091e8494f247a92895db6546b5c2d7f56e23d0a5a9ab"
    ],
    ["object_live", { location: "room_a" }, "6e14ab3428f67bce6945149ca05aeec7a064428080d8a8d8155dfe10459d264f"],
    [
      "session row",
      { id: "s_abc", actor: "#actor", started: 1751980000000, expiresAt: 1751983600000, activeScope: "room:room_a" },
      "51d2e1e6402309215fcb30baeb8128ab9c920ef84510e073f3955e30961bfee9"
    ],
    [
      "unicode + nesting + numbers",
      { s: "héllo é本", arr: [1, 2.5, -0, [null, true]], nested: { b: 2, a: 1 } },
      "59863e121ed76f21a80bfb56224ea5d688dcbeecde49a1fb1287f873080734f7"
    ],
    ["empty object", {}, "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"],
    ["null", null, "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"]
  ];

  it("content addresses of representative cell values are frozen", () => {
    for (const [label, value, expected] of GOLDENS) {
      expect(cellVersion(value), label).toBe(expected);
    }
  });

  it("key order is canonicalized (the property the goldens rely on)", () => {
    expect(cellVersion({ a: 1, b: 2 })).toBe(cellVersion({ b: 2, a: 1 }));
  });
});

describe("v1 field-name pins (add-only, never rename)", () => {
  const STAMP = { scope_head: "h1", catalog_epoch: "cat1" };

  it("Cell carries the pinned v1 field names", () => {
    const cell = makeCell({ kind: "property_cell", object: "#box", name: "counter", value: { value: 1 }, provenance: "derived", stamp: STAMP });
    for (const key of ["key", "kind", "object", "name", "value", "version", "provenance", "stamp"]) {
      expect(Object.keys(cell), `Cell.${key}`).toContain(key);
    }
    expect(Object.keys(cell.stamp).sort()).toEqual(["catalog_epoch", "scope_head"]);
  });

  it("CellTransfer carries the pinned v1 field names and kind tag", () => {
    const lineage = makeCell({ kind: "object_lineage", object: "#box", value: { parent: null }, provenance: "authoritative", stamp: STAMP });
    const transfer = serializeTransfer([lineage]);
    expect(transfer.kind).toBe("woo.net.cell_transfer.v1");
    for (const key of ["kind", "cells", "assumes_known"]) expect(Object.keys(transfer)).toContain(key);
  });

  it("CommitSubmit and its transcript carry the pinned v1 field names", () => {
    const { submit } = mintSessionSubmit({
      session: "s_pin",
      actor: "#actor",
      ttl_ms: 60_000,
      now: 1751980000000,
      base: { seq: 0, hash: "genesis" },
      epoch: "cat1",
      clusterScope: "cluster_a"
    });
    expect(submit.kind).toBe("woo.net.commit_submit.v1");
    for (const key of ["kind", "scope", "base", "idempotency_key", "transcript", "post_state_version", "stamp"]) {
      expect(Object.keys(submit), `CommitSubmit.${key}`).toContain(key);
    }
    for (const key of ["kind", "route", "scope", "call", "reads", "writes", "creates", "moves", "observations", "hash"]) {
      expect(Object.keys(submit.transcript), `EffectTranscript.${key}`).toContain(key);
    }
    expect(Object.keys(submit.base).sort()).toEqual(["hash", "seq"]);
  });
});

describe("no-expiry session cells are forbidden at mint (Phase 5)", () => {
  const base = { seq: 0, hash: "genesis" };
  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])("ttl_ms=%p refuses", (ttl) => {
    expect(() =>
      mintSessionSubmit({ session: "s_bad", actor: "#actor", ttl_ms: ttl as number, now: 1, base, epoch: "cat1", clusterScope: "c" })
    ).toThrow(/no-expiry sessions are forbidden/);
  });
});

describe("schema_version durable stamps (Phase 5)", () => {
  it("scope construction stamps net_scope_meta schema_version v1, once", () => {
    const scope = netState("wire-scope");
    const env: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET };
    new NetScopeDO(scope.state, env);
    new NetScopeDO(scope.state, env); // idempotent: keeps the created-at version
    const rows = (
      scope.state.storage.sql.exec("SELECT body FROM net_scope_meta WHERE id = 'schema_version'") as {
        toArray(): Array<{ body: string }>;
      }
    ).toArray();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].body)).toEqual({ v: 1 });
    scope.close();
  });

  // The pin lease columns are added to a LIVE table on already-deployed
  // shards, so the migration has to be resumable from its own halfway state.
  // Gating both ALTERs on the presence of the first one was not: an
  // interruption between them left `expires_at` present and `guaranteed`
  // absent, and every later boot skipped the block and then failed building an
  // index on the missing column — a shard that can never initialize again.
  it("resumes a PARTIAL pin migration: a table with only expires_at still initializes", () => {
    const gw = netState("wire-gateway-partial");
    const env = { WOO_INTERNAL_SECRET: SECRET, NET_GATEWAY_SELF: "gateway:partial" } as NetGatewayEnv;
    // Exactly the state an interruption between the two ALTERs leaves behind,
    // with a live pin row already in it.
    gw.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS net_gateway_pin (idempotency_key TEXT PRIMARY KEY, scope TEXT NOT NULL)"
    );
    gw.state.storage.sql.exec("ALTER TABLE net_gateway_pin ADD COLUMN expires_at INTEGER");
    gw.state.storage.sql.exec(
      "INSERT INTO net_gateway_pin (idempotency_key, scope) VALUES ('half-migrated', 'room:somewhere')"
    );

    expect(() => new NetGatewayDO(gw.state, env)).not.toThrow();
    // And again: the repair is idempotent, not a one-shot that leaves the next
    // boot in a different state.
    expect(() => new NetGatewayDO(gw.state, env)).not.toThrow();

    const columns = (
      gw.state.storage.sql.exec("PRAGMA table_info(net_gateway_pin)") as {
        toArray(): Array<{ name: string }>;
      }
    ).toArray().map((row) => row.name);
    expect(columns).toContain("expires_at");
    expect(columns).toContain("guaranteed");

    // The row that survived the halt is dated and classed, not left undateable.
    const row = (
      gw.state.storage.sql.exec(
        "SELECT expires_at, guaranteed FROM net_gateway_pin WHERE idempotency_key = 'half-migrated'"
      ) as { toArray(): Array<{ expires_at: number | null; guaranteed: number | null }> }
    ).toArray()[0];
    expect(row?.expires_at, "a halted migration must not leave an undated pin").not.toBeNull();
    expect(Number(row?.guaranteed)).toBe(1);
    gw.close();
  });

  it("gateway construction stamps net_gateway_meta schema_version v3, once", () => {
    const gw = netState("wire-gateway");
    const env: NetGatewayEnv = { WOO_INTERNAL_SECRET: SECRET };
    new NetGatewayDO(gw.state, env);
    new NetGatewayDO(gw.state, env);
    const rows = (
      gw.state.storage.sql.exec("SELECT body FROM net_gateway_meta WHERE id = 'schema_version'") as {
        toArray(): Array<{ body: string }>;
      }
    ).toArray();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].body)).toEqual({ v: 3 });
    gw.close();
  });

  it("gateway v1 migration clears derived cells, relations, and high-waters together", () => {
    const gw = netState("wire-gateway-v1");
    const sql = gw.state.storage.sql;
    sql.exec("CREATE TABLE net_gateway_meta (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    sql.exec(
      "INSERT INTO net_gateway_meta (id, body) VALUES ('schema_version', ?)",
      JSON.stringify({ v: 1 })
    );
    sql.exec("CREATE TABLE net_gateway_cell (key TEXT PRIMARY KEY, body TEXT NOT NULL)");
    sql.exec(
      "INSERT INTO net_gateway_cell (key, body) VALUES (?, ?)",
      "property_cell:old:deleted",
      JSON.stringify({ stale: true })
    );
    sql.exec(
      "CREATE TABLE net_gateway_relation (key TEXT PRIMARY KEY, relation TEXT NOT NULL, owner TEXT NOT NULL, member TEXT NOT NULL, body TEXT, owner_scope TEXT)"
    );
    sql.exec(
      "INSERT INTO net_gateway_relation (key, relation, owner, member, body, owner_scope) VALUES (?, ?, ?, ?, NULL, ?)",
      "session_presence\u0000old\u0000departed",
      "session_presence",
      "old",
      "departed",
      "room:old"
    );
    sql.exec(
      "CREATE TABLE net_gateway_scope (scope TEXT PRIMARY KEY, seen_seq INTEGER NOT NULL, delivery_seen_seq INTEGER NOT NULL DEFAULT 0)"
    );
    sql.exec(
      "INSERT INTO net_gateway_scope (scope, seen_seq, delivery_seen_seq) VALUES (?, ?, ?)",
      "room:old",
      9,
      9
    );

    const env: NetGatewayEnv = { WOO_INTERNAL_SECRET: SECRET };
    new NetGatewayDO(gw.state, env);
    const count = (table: string): number =>
      (sql.exec(`SELECT COUNT(*) AS n FROM ${table}`) as { toArray(): Array<{ n: number }> }).toArray()[0].n;
    expect(count("net_gateway_cell")).toBe(0);
    expect(count("net_gateway_relation")).toBe(0);
    expect(count("net_gateway_scope")).toBe(0);
    const cellColumns = (sql.exec("PRAGMA table_info(net_gateway_cell)") as {
      toArray(): Array<{ name: string }>;
    }).toArray();
    expect(cellColumns.some((column) => column.name === "owner_scope")).toBe(true);
    expect(
      (sql.exec("PRAGMA index_list(net_gateway_cell)") as {
        toArray(): Array<{ name: string }>;
      }).toArray().some((index) => index.name === "net_gateway_cell_scope")
    ).toBe(true);
    const version = (sql.exec("SELECT body FROM net_gateway_meta WHERE id = 'schema_version'") as {
      toArray(): Array<{ body: string }>;
    }).toArray();
    expect(JSON.parse(version[0].body)).toEqual({ v: 3 });

    // The reset is the v1→v2 migration, not a construction side effect.
    // Once stamped v3, a later hibernation/wake must preserve rebuilt rows.
    sql.exec(
      "INSERT INTO net_gateway_cell (key, body, owner_scope) VALUES (?, ?, ?)",
      "object_lineage:rebuilt",
      JSON.stringify({ rebuilt: true }),
      "room:rebuilt"
    );
    new NetGatewayDO(gw.state, env);
    expect(count("net_gateway_cell")).toBe(1);
    gw.close();
  });

  it("gateway v2-to-v3 migration preserves derived cache rows and adds exact-read floors", () => {
    const gw = netState("wire-gateway-v2");
    const sql = gw.state.storage.sql;
    sql.exec("CREATE TABLE net_gateway_meta (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
    sql.exec(
      "INSERT INTO net_gateway_meta (id, body) VALUES ('schema_version', ?)",
      JSON.stringify({ v: 2 })
    );
    sql.exec("CREATE TABLE net_gateway_cell (key TEXT PRIMARY KEY, body TEXT NOT NULL, owner_scope TEXT)");
    sql.exec(
      "INSERT INTO net_gateway_cell (key, body, owner_scope) VALUES (?, ?, ?)",
      "object_lineage:rebuilt",
      JSON.stringify({ rebuilt: true }),
      "room:rebuilt"
    );

    new NetGatewayDO(gw.state, { WOO_INTERNAL_SECRET: SECRET });
    const version = (sql.exec("SELECT body FROM net_gateway_meta WHERE id = 'schema_version'") as {
      toArray(): Array<{ body: string }>;
    }).toArray();
    expect(JSON.parse(version[0].body)).toEqual({ v: 3 });
    const cached = (sql.exec("SELECT COUNT(*) AS n FROM net_gateway_cell") as {
      toArray(): Array<{ n: number }>;
    }).toArray()[0];
    expect(Number(cached.n)).toBe(1);
    const floorColumns = (sql.exec("PRAGMA table_info(net_gateway_cell_floor)") as {
      toArray(): Array<{ name: string }>;
    }).toArray().map((column) => column.name);
    expect(floorColumns).toEqual(expect.arrayContaining(["key", "owner_scope", "authority_seq"]));
    gw.close();
  });

  it("resets a moved key's floor to the new scope sequence and survives a restart", () => {
    const gw = netState("wire-gateway-floor-scope-change");
    const sql = gw.state.storage.sql;
    const first = new NetGatewayDO(gw.state, { WOO_INTERNAL_SECRET: SECRET });
    const firstInternals = first as unknown as {
      ensureView(): { install(cell: unknown): void };
      persistCell(view: unknown, key: string, ownerScope: string): void;
      recordCellAuthorityFloor(key: string, scope: string, seq: number): void;
    };
    const key = "property_cell:moved:value";
    const view = firstInternals.ensureView();
    view.install(makeCell({
      kind: "property_cell",
      object: "moved",
      name: "value",
      value: { value: "fresh-in-b" },
      provenance: "derived",
      stamp: { scope_head: "b3", catalog_epoch: "cat1" }
    }));
    firstInternals.persistCell(view, key, "room:B");
    firstInternals.recordCellAuthorityFloor(key, "room:A", 50_000);
    firstInternals.recordCellAuthorityFloor(key, "room:B", 3);

    const persisted = (sql.exec(
      "SELECT owner_scope, authority_seq FROM net_gateway_cell_floor WHERE key = ?",
      key
    ) as { toArray(): Array<{ owner_scope: string; authority_seq: number }> }).toArray()[0];
    expect(persisted).toEqual({ owner_scope: "room:B", authority_seq: 3 });

    const rawSqlSpy = vi.spyOn(sql, "exec");
    firstInternals.recordCellAuthorityFloor(key, "room:B", 3);
    expect(rawSqlSpy.mock.calls.filter(([query]) => String(query).includes("net_gateway_cell_floor"))).toHaveLength(0);
    rawSqlSpy.mockRestore();

    // Reconstruct the DO from SQL, then prove B/4 removes the cell. The old
    // corrupt row (B/50000) would filter this removal indefinitely.
    const restarted = new NetGatewayDO(gw.state, { WOO_INTERNAL_SECRET: SECRET });
    const restartedInternals = restarted as unknown as {
      ensureView(): { get(key: string): unknown };
      seen: Map<string, number>;
      receiveFanout(body: unknown): boolean;
    };
    const restartedView = restartedInternals.ensureView();
    restartedInternals.seen.set("room:B", 0);
    expect(restartedInternals.receiveFanout({
      scope: "room:B",
      seq: 4,
      cells: [],
      removed_cells: [key],
      observations: [],
      relations: []
    })).toBe(true);
    expect(restartedView.get(key)).toBeUndefined();
    expect((sql.exec(
      "SELECT COUNT(*) AS n FROM net_gateway_cell_floor WHERE key = ?",
      key
    ) as { toArray(): Array<{ n: number }> }).toArray()[0].n).toBe(0);
    gw.close();
  });

  it("bounds durable authority floors and retains the newest exact reads", () => {
    const gw = netState("wire-gateway-floor-retention");
    const sql = gw.state.storage.sql;
    new NetGatewayDO(gw.state, { WOO_INTERNAL_SECRET: SECRET });
    sql.exec(
      "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < 4097) " +
        "INSERT INTO net_gateway_cell_floor (key, owner_scope, authority_seq) " +
        "SELECT 'old:' || n, 'room:old', n FROM seq"
    );

    const gateway = new NetGatewayDO(gw.state, { WOO_INTERNAL_SECRET: SECRET });
    const internals = gateway as unknown as {
      ensureView(): unknown;
      cellAuthorityFloorWrites: number;
      recordCellAuthorityFloor(key: string, scope: string, seq: number): void;
    };
    internals.ensureView();
    internals.cellAuthorityFloorWrites = 255;
    internals.recordCellAuthorityFloor("newest", "room:new", 1);

    const count = (sql.exec("SELECT COUNT(*) AS n FROM net_gateway_cell_floor") as {
      toArray(): Array<{ n: number }>;
    }).toArray()[0].n;
    expect(count).toBe(4096);
    expect((sql.exec("SELECT key FROM net_gateway_cell_floor WHERE key = 'old:1'") as {
      toArray(): Array<{ key: string }>;
    }).toArray()).toEqual([]);
    expect((sql.exec("SELECT key FROM net_gateway_cell_floor WHERE key = 'newest'") as {
      toArray(): Array<{ key: string }>;
    }).toArray()).toEqual([{ key: "newest" }]);
    gw.close();
  });
});
