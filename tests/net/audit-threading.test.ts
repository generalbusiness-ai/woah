/**
 * AU3.2/AU2 threading: the planner folds the gateway-stamped principal
 * and trace context into the hashed transcript body; the sequencer
 * validates the carried principal (internal consistency, actor match,
 * and — when it owns the actor's customer_of cell — the customer) and
 * folds violations into the CO14 unauthorized reject with a named
 * verdict.
 */
import { describe, expect, it } from "vitest";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { PROP_CUSTOMER_OF, type Principal } from "../../src/net/attribution";
import { cellsFromSerialized, storeCells, type ShadowTurnCall } from "../../src/net/bridge";
import { CellStore } from "../../src/net/cells";
import { planTurn } from "../../src/net/plan";
import type { ScopeClassifier } from "../../src/net/route";
import { ScopeSequencer } from "../../src/net/scope";
import { adoptOrMintTraceContext } from "../../src/net/trace";

const SCOPE = "home";
const EPOCH = "cat1";
const classifier: ScopeClassifier = {
  scopeOf: () => SCOPE,
  isShared: (scope) => scope === SCOPE
};

/** The plan.test.ts harness, plus a customer_of cell on the actor so the
 * authority can re-validate the principal's customer (AU3.2). */
function harness(tag: string, options: { attribute?: boolean } = {}) {
  const world = createWorld();
  const session = world.auth(`guest:audit-${tag}`);
  const actor = session.actor;
  world.createObject({ id: "audit_box", name: "Audit Box", parent: "$thing", owner: actor });
  world.defineProperty("audit_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  const installed = installVerb(
    world,
    "audit_box",
    "bump",
    `verb :bump() rxd {
      let before = this.counter;
      this.counter = before + 1;
      return this.counter;
    }`,
    null
  );
  expect(installed.ok).toBe(true);
  // The reserved property refuses ordinary setProp (AU3.1 write
  // contract); the identity pipeline's privileged setter is the writer.
  // `attribute: false` builds the unattributed-actor variant for the
  // customer_unverifiable case.
  if (options.attribute !== false) {
    world.setCustomerOf(actor, { customer: "acct_audit", derived_via: "account" });
  }

  // Single-scope harness: the sequencer owns every object (so ordinary
  // writes are local), which includes the actor's customer_of cell —
  // exactly the "committing scope is the actor's own cluster" case the
  // AU3.2 customer re-check fires in.
  const seq = new ScopeSequencer(SCOPE, EPOCH, { owns: () => true });
  seq.seed(cellsFromSerialized(world.exportWorld()));
  const view = new CellStore("derived");
  for (const cell of storeCells(seq.store)) view.install(cell);

  const call = (id: string): ShadowTurnCall => ({
    kind: "woo.turn_call.shadow.v1",
    id,
    route: "direct",
    scope: SCOPE,
    session: session.id,
    actor,
    target: "audit_box",
    verb: "bump",
    args: []
  });
  const principal = (over?: Partial<Principal>): Principal => ({
    attribution: "authenticated",
    customer: "acct_audit",
    actor,
    session: session.id,
    ...over
  });
  return { seq, view, call, actor, session, principal };
}

describe("planner fold (AU3.2/AU2)", () => {
  it("carries principal + trace inside the hashed transcript body; the commit accepts", async () => {
    const h = harness("fold");
    const trace = adoptOrMintTraceContext("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    const plan = await planTurn({
      call: h.call("t1"),
      principal: h.principal(),
      trace,
      view: h.view,
      planningScope: SCOPE,
      classifier,
      base: h.seq.head(),
      idempotencyKey: "k-fold",
      stamp: h.seq.stamp()
    });
    expect(plan.submit.transcript.principal).toEqual(h.principal());
    expect(plan.submit.transcript.trace).toEqual(trace);

    const bare = await planTurn({
      call: h.call("t1"),
      view: h.view,
      planningScope: SCOPE,
      classifier,
      base: h.seq.head(),
      idempotencyKey: "k-fold-bare",
      stamp: h.seq.stamp()
    });
    // The hash COVERS the audit fields (they are part of the body)...
    expect(plan.submit.transcript.hash).not.toBe(bare.submit.transcript.hash);
    // ...and a principal-less transcript hashes as before (present-only-
    // when-set), so this change cannot invalidate existing replies.
    expect(bare.submit.transcript.principal).toBeUndefined();

    const reply = h.seq.submit(plan.submit);
    expect(reply.status).toBe("accepted");
  });
});

describe("sequencer principal validation (AU3.2 → CO14 unauthorized)", () => {
  async function plannedWith(h: ReturnType<typeof harness>, p: Principal, key: string) {
    return planTurn({
      call: h.call(key),
      principal: p,
      view: h.view,
      planningScope: SCOPE,
      classifier,
      base: h.seq.head(),
      idempotencyKey: key,
      stamp: h.seq.stamp()
    });
  }

  it("rejects actor_mismatch when the principal names a different actor", async () => {
    const h = harness("mismatch");
    const plan = await plannedWith(h, h.principal({ actor: "someone_else" }), "k-actor");
    const reply = h.seq.submit(plan.submit);
    expect(reply).toMatchObject({
      status: "rejected",
      reason: "unauthorized",
      detail: { principal_verdict: "actor_mismatch" }
    });
  });

  it("rejects customer_mismatch against the owned customer_of cell", async () => {
    const h = harness("customer");
    const plan = await plannedWith(h, h.principal({ customer: "acct_wrong" }), "k-cust");
    const reply = h.seq.submit(plan.submit);
    expect(reply).toMatchObject({
      status: "rejected",
      reason: "unauthorized",
      detail: {
        principal_verdict: "customer_mismatch",
        authoritative_customer: "acct_audit"
      }
    });
  });

  it("rejects a malformed principal (authenticated without customer)", async () => {
    const h = harness("malformed");
    const plan = await plannedWith(h, h.principal(), "k-malformed");
    // Simulate a tampered/buggy sender: strip the customer after planning.
    const tampered = {
      ...plan.submit,
      transcript: { ...plan.submit.transcript, principal: { attribution: "authenticated", actor: h.actor } }
    };
    const reply = h.seq.submit(tampered as never);
    expect(reply).toMatchObject({
      status: "rejected",
      reason: "unauthorized",
      detail: { principal_verdict: "malformed_principal" }
    });
  });

  it("accepts a matching principal against the owned cell (round-trip)", async () => {
    const h = harness("ok");
    const plan = await plannedWith(h, h.principal(), "k-ok");
    const reply = h.seq.submit(plan.submit);
    expect(reply.status).toBe("accepted");
  });
});

describe("review fixes: strict principal states on commits (AU3.2)", () => {
  it("rejects a non-authenticated principal on a committed turn", async () => {
    const h = harness("edgeform");
    const plan = await planTurn({
      call: h.call("k-cred"),
      principal: { attribution: "credentialed", credential: "key1", customer: "acct_audit" },
      view: h.view,
      planningScope: SCOPE,
      classifier,
      base: h.seq.head(),
      idempotencyKey: "k-cred",
      stamp: h.seq.stamp()
    });
    expect(h.seq.submit(plan.submit)).toMatchObject({
      status: "rejected",
      reason: "unauthorized",
      detail: { principal_verdict: "not_authenticated" }
    });
  });

  it("rejects customer_unverifiable when the owned cell is absent but a customer is claimed", async () => {
    // A harness WITHOUT the customer_of cell: the committing scope owns
    // the actor, so an edge-claimed customer with no durable backing is
    // refused rather than trusted.
    const h = harness("unverif", { attribute: false });
    const plan = await planTurn({
      call: h.call("k-unverif"),
      principal: h.principal({ customer: "acct_invented" }),
      view: h.view,
      planningScope: SCOPE,
      classifier,
      base: h.seq.head(),
      idempotencyKey: "k-unverif",
      stamp: h.seq.stamp()
    });
    expect(h.seq.submit(plan.submit)).toMatchObject({
      status: "rejected",
      reason: "unauthorized",
      detail: { principal_verdict: "customer_unverifiable" }
    });
  });
});
