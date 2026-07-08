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
import { describe, expect, it } from "vitest";
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

  it("gateway construction stamps net_gateway_meta schema_version v1, once", () => {
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
    expect(JSON.parse(rows[0].body)).toEqual({ v: 1 });
    gw.close();
  });
});
