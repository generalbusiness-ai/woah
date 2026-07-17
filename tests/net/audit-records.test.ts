/**
 * AU4/AU5 record minting: acting + dual attribution, adoption
 * resource-owner-only, gateway variant routing, shard stability, wire
 * guard.
 */
import { describe, expect, it } from "vitest";
import {
  auditShardFor,
  mintAdoptionAuditRecord,
  mintCommitAuditRecords,
  mintGatewayAuditRecord,
  normalizeRoutedAuditRecord,
  OPERATOR_CUSTOMER_ID
} from "../../src/net/audit";
import type { Principal } from "../../src/net/attribution";
import type { CommitSubmit } from "../../src/net/scope";

const PRINCIPAL: Principal = {
  attribution: "authenticated",
  customer: "acct_a",
  actor: "#actor",
  session: "s1"
};

function submitFixture(principal?: Principal): CommitSubmit {
  return {
    kind: "woo.net.commit_submit.v1",
    scope: "room:the_room",
    base: { seq: 0, hash: "genesis" },
    idempotency_key: "k1",
    transcript: {
      kind: "woo.effect_transcript.shadow.v1",
      id: "t1",
      route: "sequenced",
      scope: "room:the_room",
      seq: 0,
      session: "s1",
      call: { actor: "#actor", target: "#box", verb: "bump", args: [], body: undefined },
      reads: [],
      writes: [
        { cell: { kind: "prop", object: "#box", name: "counter" }, value: 1, op: "set", writer: undefined }
      ],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: "h1",
      ...(principal ? { principal } : {}),
      trace: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", origin: "adopted" }
    } as never,
    post_state_version: "psv",
    stamp: { scope_head: "gateway", catalog_epoch: "cat1" }
  };
}

const HEAD = { seq: 7, hash: "head7" };

describe("mintCommitAuditRecords (AU1.1/AU5)", () => {
  it("mints one acting record with the provenance citation and trace id", () => {
    const routed = mintCommitAuditRecords({
      submit: submitFixture(PRINCIPAL),
      head: HEAD,
      scopeAttribution: { customer: "acct_a", derived_via: "anchor_owner", stamped_at_epoch: "cat1" },
      now: 1000
    });
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({
      partition: "acct_a",
      record: {
        idempotency: "room:the_room:7",
        outcome: "ok",
        trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
        action: { kind: "commit", verb: "bump", target: "#box", scope: "room:the_room", seq: 7, head: "head7" },
        subjects: ["#box"]
      }
    });
  });

  it("dual-attributes when the scope's owner is a different customer — same record content", () => {
    const routed = mintCommitAuditRecords({
      submit: submitFixture(PRINCIPAL),
      head: HEAD,
      scopeAttribution: { customer: "acct_b", derived_via: "anchor_owner", stamped_at_epoch: "cat1" },
      now: 1000
    });
    expect(routed.map((r) => r.partition).sort()).toEqual(["acct_a", "acct_b"]);
    expect(routed[0]?.record).toBe(routed[1]?.record);
  });

  it("routes a principal-less commit to the operator partition as the named unattributed gap", () => {
    const routed = mintCommitAuditRecords({
      submit: submitFixture(),
      head: HEAD,
      scopeAttribution: null,
      now: 1000
    });
    expect(routed).toEqual([
      expect.objectContaining({ partition: OPERATOR_CUSTOMER_ID, record: expect.objectContaining({ outcome: "unattributed" }) })
    ]);
  });
});

describe("mintAdoptionAuditRecord (AU1 single-count)", () => {
  const base = {
    ownerScope: "room:other",
    ownerSeq: 3,
    ownerHead: "oh3",
    principal: PRINCIPAL,
    trace: null,
    cause: { scope: "room:the_room", seq: 7 },
    subjects: ["#moved"],
    now: 2000
  };

  it("mints resource-owner-only with cause when customers differ", () => {
    const routed = mintAdoptionAuditRecord({
      ...base,
      ownerAttribution: { customer: "acct_b", derived_via: "anchor_owner", stamped_at_epoch: "cat1" }
    });
    expect(routed).toMatchObject({
      partition: "acct_b",
      record: { cause: { scope: "room:the_room", seq: 7 }, idempotency: "room:other:3:adopt" }
    });
  });

  it("mints nothing for same-customer adoption (the acting record covers it)", () => {
    expect(
      mintAdoptionAuditRecord({
        ...base,
        ownerAttribution: { customer: "acct_a", derived_via: "anchor_owner", stamped_at_epoch: "cat1" }
      })
    ).toBeNull();
  });

  it("an unstamped owner routes to operator, flagged", () => {
    const routed = mintAdoptionAuditRecord({ ...base, ownerAttribution: null });
    expect(routed).toMatchObject({
      partition: OPERATOR_CUSTOMER_ID,
      record: { detail: { resource_attribution: "unstamped" } }
    });
  });
});

describe("mintGatewayAuditRecord routing (AU3.2 variants)", () => {
  it("credentialed routes to the customer of record AND the operator", () => {
    const routed = mintGatewayAuditRecord({
      gateway: "gw-1",
      eventId: "e1",
      kind: "auth",
      principal: { attribution: "credentialed", credential: "key1", customer: "acct_a" },
      outcome: "unknown_or_revoked",
      now: 1
    });
    expect(routed.map((r) => r.partition).sort()).toEqual(["acct_a", OPERATOR_CUSTOMER_ID].sort());
  });

  it("anonymous routes to the operator only", () => {
    const routed = mintGatewayAuditRecord({
      gateway: "gw-1",
      eventId: "e2",
      kind: "auth",
      principal: { attribution: "anonymous" },
      outcome: "missing_credential",
      now: 1
    });
    expect(routed).toHaveLength(1);
    expect(routed[0]?.partition).toBe(OPERATOR_CUSTOMER_ID);
  });

  it("authenticated refusal routes to the customer only", () => {
    const routed = mintGatewayAuditRecord({
      gateway: "gw-1",
      eventId: "e3",
      kind: "refusal",
      principal: PRINCIPAL,
      outcome: "E_RATE",
      now: 1
    });
    expect(routed).toHaveLength(1);
    expect(routed[0]?.partition).toBe("acct_a");
  });
});

describe("auditShardFor", () => {
  it("is stable and bounded", () => {
    expect(auditShardFor("acct_a", 4)).toBe(auditShardFor("acct_a", 4));
    for (const partition of ["acct_a", "acct_b", "operator", "guest"]) {
      const shard = auditShardFor(partition, 4);
      expect(shard).toMatch(/^audit-[0-3]$/);
    }
    expect(auditShardFor("anything", 1)).toBe("audit-0");
  });
});

describe("normalizeRoutedAuditRecord", () => {
  it("round-trips a minted record", () => {
    const [routed] = mintCommitAuditRecords({
      submit: submitFixture(PRINCIPAL),
      head: HEAD,
      scopeAttribution: null,
      now: 1
    });
    expect(normalizeRoutedAuditRecord(JSON.parse(JSON.stringify(routed)))).toEqual(routed);
  });

  const bad: Array<[string, unknown]> = [
    ["null", null],
    ["no partition", { record: {} }],
    ["no idempotency", { partition: "p", record: { ts: 1, outcome: "ok", producer: { kind: "scope", name: "s" }, action: { kind: "commit" }, subjects: [] } }],
    ["bad producer", { partition: "p", record: { ts: 1, idempotency: "i", outcome: "ok", producer: { kind: "vibes", name: "s" }, action: { kind: "commit" }, subjects: [] } }]
  ];
  for (const [label, value] of bad) {
    it(`rejects ${label}`, () => {
      expect(normalizeRoutedAuditRecord(value)).toBeNull();
    });
  }
});
