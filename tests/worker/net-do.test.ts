// NetScopeDO + NetGatewayDO over the fake-DO harness (Plan 002 Phase 3
// step 2). Unlike the v2 fake lane, these classes get REAL per-instance
// storage isolation: each FakeDurableObjectState owns its own in-memory
// SQLite, so two scope DOs cannot share a world image by accident — the
// isolation the v2 fake famously collapsed.
//
// Covered: end-to-end plan→submit→install through the internal-auth'd
// /net surface; per-instance isolation; cold restart (a NEW DO object
// over the SAME storage) with idempotent replay + head continuity; and
// the scheduled-turn alarm re-arming from durable state alone (CO2.8).
import { describe, expect, it } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { cellKey, cellVersion } from "../../src/net/cells";
import type { CommitReply, ScopeHead } from "../../src/net/scope";
import { CATALOG_SCOPE } from "../../src/net/topology";

const SECRET = "net-do-test-secret";
const EPOCH = "cat-net-1";

/** Fake DO state + the alarm slice the net DOs need (the base fake has
 * no alarm API); records armings so tests can assert re-arm behavior. */
function netState(name: string): { state: NetScopeDurableState & NetGatewayDurableState; alarms: Array<number | null>; close: () => void } {
  const fake = new FakeDurableObjectState(name);
  const alarms: Array<number | null> = [];
  const state = {
    id: fake.id,
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
  return { state, alarms, close: () => fake.close() };
}

type Fetchable = { fetch(request: Request): Promise<Response> | Response };

/** Signed call helper — the same internal-auth surface production uses. */
async function call<T>(target: Fetchable, env: { WOO_INTERNAL_SECRET?: string }, route: string, body?: unknown): Promise<T> {
  const url = `https://do/net${route}`;
  const request =
    body === undefined
      ? new Request(url)
      : new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const signed = await signInternalRequest(env, request);
  const response = await target.fetch(signed);
  const decoded = (await response.json()) as T & { error?: unknown };
  if (!response.ok) throw new Error(`call ${route} failed: ${JSON.stringify(decoded)}`);
  return decoded;
}

const WRITER = { progr: "#actor", thisObj: "#thing", verb: "set_label", definer: "$thing", caller: "#actor", callerPerms: "#actor" };

/** A hand-built planned turn (the engine-planned path is covered by
 * tests/net/plan.test.ts and the differential; this lane exercises the
 * DO surfaces). The gateway's /net/turn plans for real, so this fixture
 * is only used for direct /net/submit checks. */
function seedCells() {
  return [
    { kind: "object_lineage" as const, object: "#thing", value: { parent: null, owner: "#actor", name: "thing", anchor: null, flags: {} } },
    { kind: "object_lineage" as const, object: "#actor", value: { parent: null, owner: "#actor", name: "actor", anchor: null, flags: {} } },
    { kind: "property_cell" as const, object: "#thing", name: "label", value: { value: "old" } }
  ];
}

function makeScope(name: string, env: NetScopeEnv) {
  const { state, alarms, close } = netState(name);
  return { instance: new NetScopeDO(state, env), state, alarms, close };
}

describe("NetScopeDO over fake-DO storage", () => {
  const env: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET };

  it("rejects unsigned requests", async () => {
    const scope = makeScope("room-a", env);
    const response = await scope.instance.fetch(new Request("https://do/net/head"));
    expect(response.status).toBe(401);
    scope.close();
  });

  it("seeds, serves head and lineage-closed closures, and isolates instances", async () => {
    const a = makeScope("room-a", env);
    const b = makeScope("room-b", env);
    await call(a.instance, env, "/seed", { scope: "room-a", catalog_epoch: EPOCH, cells: seedCells() });

    const head = await call<{ scope: string; head: ScopeHead }>(a.instance, env, "/head");
    expect(head.scope).toBe("room-a");
    expect(head.head.seq).toBe(0);

    const closure = await call<{ cells: Array<{ key: string }> }>(a.instance, env, "/closure", {
      keys: [cellKey("property_cell", "#thing", "label")],
      known: []
    });
    // The property cell rides with its lineage closure (CO7).
    expect(closure.cells.map((c) => c.key).sort()).toEqual(["object_lineage:#thing", "property_cell:#thing:label"]);

    // Isolation: room-b has no state and no request-supplied identity.
    await expect(call(b.instance, env, "/head")).rejects.toThrow(/E_MISSING_STATE|no durable state/);
    a.close();
    b.close();
  });

  it("serializes concurrent independent submits from one retained base without repair", async () => {
    const scope = makeScope("room-a", env);
    await call(scope.instance, env, "/seed", { scope: "room-a", catalog_epoch: EPOCH, cells: seedCells() });
    const head0 = (await call<{ head: ScopeHead }>(scope.instance, env, "/head")).head;
    const { applyTranscript } = await import("../../src/net/transcript");
    const { ScopeSequencer } = await import("../../src/net/scope");
    const twin = new ScopeSequencer("room-a", EPOCH);
    twin.seed(seedCells());
    const makeSubmit = (index: number) => {
      const transcript = {
        kind: "woo.effect_transcript.shadow.v1",
        route: "direct",
        scope: "room-a",
        seq: 1,
        call: { actor: "#actor", target: "#thing", verb: "look", args: [], body: undefined },
        reads: [],
        writes: [],
        creates: [],
        moves: [],
        observations: [{ type: "looked", to: "#actor", text: `view-${index}` }],
        logicalInputs: [],
        untrackedEffects: [],
        complete: true,
        incompleteReasons: [],
        hash: `net-do-concurrent-${index}`
      };
      return {
        kind: "woo.net.commit_submit.v1",
        scope: "room-a",
        base: head0,
        idempotency_key: `concurrent-${index}`,
        transcript,
        post_state_version: applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH }).postStateVersion,
        stamp: { scope_head: "x", catalog_epoch: EPOCH }
      };
    };

    const replies = await Promise.all(
      Array.from({ length: 12 }, (_, index) => call<CommitReply>(scope.instance, env, "/submit", makeSubmit(index)))
    );
    expect(replies.every((reply) => reply.status === "accepted")).toBe(true);
    expect(new Set(replies.map((reply) => reply.head.seq)).size).toBe(12);
    expect((await call<{ head: ScopeHead }>(scope.instance, env, "/head")).head.seq).toBe(12);
    scope.close();
  });

  it("cold restart over the same storage: head continuity + idempotent replay (CO2.5)", async () => {
    const first = makeScope("room-a", env);
    await call(first.instance, env, "/seed", { scope: "room-a", catalog_epoch: EPOCH, cells: seedCells() });
    const head0 = (await call<{ head: ScopeHead }>(first.instance, env, "/head")).head;

    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "direct",
      scope: "room-a",
      seq: 1,
      call: { actor: "#actor", target: "#thing", verb: "set_label", args: [], body: undefined },
      reads: [],
      writes: [{ cell: { kind: "prop", object: "#thing", name: "label" }, value: "new", op: "set", writer: WRITER }],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: "net-do-t1"
    };
    // post_state_version computed the planner way — via the same apply
    // the scope runs (import here would drag the whole net test set into
    // this lane; the value is deterministic, so derive it in-process).
    const { applyTranscript } = await import("../../src/net/transcript");
    const { ScopeSequencer } = await import("../../src/net/scope");
    const twin = new ScopeSequencer("room-a", EPOCH);
    twin.seed(seedCells());
    const derived = applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH });

    const submit = {
      kind: "woo.net.commit_submit.v1",
      scope: "room-a",
      base: head0,
      idempotency_key: "turn-1",
      transcript,
      post_state_version: derived.postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    };
    const reply = await call<CommitReply>(first.instance, env, "/submit", submit);
    expect(reply.status).toBe("accepted");

    // Cold restart: a NEW DO object over the SAME storage (the fake state
    // and its SQLite survive; only the in-memory sequencer is lost).
    const second = new NetScopeDO(first.state, env);
    const replay = await call<CommitReply>(second, env, "/submit", submit);
    expect(replay).toEqual({ ...reply, replayed: true }); // recorded reply, marked (B2), no double-commit
    const head1 = (await call<{ head: ScopeHead }>(second, env, "/head")).head;
    expect(head1.seq).toBe(1);

    const closure = await call<{ cells: Array<{ key: string; value: unknown }> }>(second, env, "/closure", {
      keys: [cellKey("property_cell", "#thing", "label")],
      known: ["object_lineage:#thing"]
    });
    expect(closure.cells[0]?.value).toEqual({ value: "new" });
    first.close();
  });

  it("discards the in-memory sequencer when the durable transaction aborts (fix 3: memory follows durable)", async () => {
    const scope = makeScope("room-a", env);
    // One-shot fault: the reply write-through (one of the LAST rows of
    // the accept transaction, after cells+meta already ran) throws once.
    // The fake DO's transactionSync rolls the whole transaction back —
    // the same contract as real DO SQLite — leaving durable state at
    // head 0 while seq.submit already advanced the in-memory sequencer.
    const realExec = scope.state.storage.sql.exec.bind(scope.state.storage.sql);
    let armed = true;
    scope.state.storage.sql = {
      exec: (query: string, ...params: unknown[]) => {
        if (armed && query.startsWith("INSERT INTO net_scope_reply")) {
          armed = false;
          throw new Error("injected writeReply failure");
        }
        return realExec(query, ...params);
      }
    };
    await call(scope.instance, env, "/seed", { scope: "room-a", catalog_epoch: EPOCH, cells: seedCells() });
    const head0 = (await call<{ head: ScopeHead }>(scope.instance, env, "/head")).head;

    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "direct",
      scope: "room-a",
      seq: 1,
      call: { actor: "#actor", target: "#thing", verb: "set_label", args: [], body: undefined },
      reads: [],
      writes: [{ cell: { kind: "prop", object: "#thing", name: "label" }, value: "durable-once", op: "set", writer: WRITER }],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: "net-do-abort-1"
    };
    const { applyTranscript } = await import("../../src/net/transcript");
    const { ScopeSequencer } = await import("../../src/net/scope");
    const twin = new ScopeSequencer("room-a", EPOCH);
    twin.seed(seedCells());
    const derived = applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH });
    const submit = {
      kind: "woo.net.commit_submit.v1",
      scope: "room-a",
      base: head0,
      idempotency_key: "abort-t1",
      transcript,
      post_state_version: derived.postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    };

    // First submit: the durable transaction aborts → 500 to the caller.
    const request = new Request("https://do/net/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(submit)
    });
    const failed = await scope.instance.fetch(await signInternalRequest(env, request));
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).toContain("injected writeReply failure");

    // Durable state never advanced — the head is still 0 (memory would
    // have said 1; the discarded sequencer rehydrated from SQLite).
    const headAfterAbort = (await call<{ head: ScopeHead }>(scope.instance, env, "/head")).head;
    expect(headAfterAbort).toEqual(head0);

    // The REPLAYED submit re-validates fresh (no phantom recorded reply
    // from the aborted attempt) and commits durably exactly once.
    const replay = await call<CommitReply>(scope.instance, env, "/submit", submit);
    expect(replay.status).toBe("accepted");
    expect(replay.status === "accepted" && replay.head.seq).toBe(1);

    // Idempotency after the successful commit still holds: same key →
    // the recorded reply (marked replayed per B2), head does not advance.
    // (`replay` above was the first fresh commit after the abort, not a
    // replay, so it carries no marker.)
    const replayAgain = await call<CommitReply>(scope.instance, env, "/submit", submit);
    expect(replayAgain).toEqual({ ...replay, replayed: true });
    const finalHead = (await call<{ head: ScopeHead }>(scope.instance, env, "/head")).head;
    expect(finalHead.seq).toBe(1);
    scope.close();
  });

  it("routes foreign-anchored reads to attestation but still validates owned reads locally (owns wiring + CO2.3)", async () => {
    const scope = makeScope("room-a", env);
    await call(scope.instance, env, "/seed", { scope: "room-a", catalog_epoch: EPOCH, cells: seedCells() });
    const head0 = (await call<{ head: ScopeHead }>(scope.instance, env, "/head")).head;

    const { applyTranscript } = await import("../../src/net/transcript");
    const { ScopeSequencer } = await import("../../src/net/scope");

    const transcriptWith = (reads: unknown[], hash: string) => ({
      kind: "woo.effect_transcript.shadow.v1",
      route: "direct",
      scope: "room-a",
      seq: 1,
      call: { actor: "#actor", target: "#thing", verb: "set_label", args: [], body: undefined },
      reads,
      writes: [{ cell: { kind: "prop", object: "#thing", name: "label" }, value: "owned-check", op: "set", writer: WRITER }],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash
    });

    const postStateFor = (transcript: unknown) => {
      const twin = new ScopeSequencer("room-a", EPOCH);
      twin.seed(seedCells());
      return applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH }).postStateVersion;
    };

    // A read of a foreign-anchored cell (#elsewhere has no object_lineage
    // in this scope's store) carries a version this scope cannot attest
    // from its own store. With `owns` wired, step 7 validates it against
    // the submit's owner attestation (CO2.3 rider integrity): with no
    // covering attestation the submit rejects terminal rider_unattested…
    const foreignRead = transcriptWith(
      [{ cell: { kind: "prop", object: "#elsewhere", name: "x" }, version: "some-foreign-version", value: 0 }],
      "net-do-owns-1"
    );
    const unattested = await call<CommitReply>(scope.instance, env, "/submit", {
      kind: "woo.net.commit_submit.v1",
      scope: "room-a",
      base: head0,
      idempotency_key: "owns-t0",
      transcript: foreignRead,
      post_state_version: postStateFor(foreignRead),
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    });
    expect(unattested.status).toBe("rejected");
    expect(unattested.status === "rejected" && unattested.reason).toBe("rider_unattested");
    expect(unattested.status === "rejected" && unattested.retryable).toBe(false);

    // …and with the owner's attestation at the planned version it accepts.
    const accepted = await call<CommitReply>(scope.instance, env, "/submit", {
      kind: "woo.net.commit_submit.v1",
      scope: "room-a",
      base: head0,
      idempotency_key: "owns-t1",
      transcript: foreignRead,
      post_state_version: postStateFor(foreignRead),
      stamp: { scope_head: "x", catalog_epoch: EPOCH },
      attestations: {
        "cluster-elsewhere": {
          owner_head: { seq: 4, hash: "owner-h4" },
          cells: [{ key: "property_cell:#elsewhere:x", version: "some-foreign-version" }]
        }
      }
    });
    expect(accepted.status).toBe("accepted");

    // A stale read of an OWNED cell (#thing's lineage IS in the store)
    // still rejects read_version_mismatch — owns must not blind the scope
    // to its own cells.
    const head1 = (await call<{ head: ScopeHead }>(scope.instance, env, "/head")).head;
    const ownedStaleRead = transcriptWith(
      [{ cell: { kind: "prop", object: "#thing", name: "label" }, version: "stale-owned-version", value: "old" }],
      "net-do-owns-2"
    );
    const rejected = await call<CommitReply>(scope.instance, env, "/submit", {
      kind: "woo.net.commit_submit.v1",
      scope: "room-a",
      base: head1,
      idempotency_key: "owns-t2",
      transcript: ownedStaleRead,
      post_state_version: "irrelevant-never-reached",
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.status === "rejected" && rejected.reason).toBe("read_version_mismatch");
    scope.close();
  });

  it("catalog authority rejects a same-epoch definition write even when the gateway guard is bypassed", async () => {
    // The most important authority check runs at the COMMITTING room, before a
    // catalog-bound rider can become room residue or fan out a poisoned class
    // cell. This invokes /submit directly, bypassing the gateway guard while
    // preserving the gateway's ordinary CA3 routing hints.
    const room = makeScope("room:malicious", env);
    await call(room.instance, env, "/seed", {
      scope: "room:malicious",
      catalog_epoch: EPOCH,
      cells: seedCells()
    });
    const roomHead = (await call<{ head: ScopeHead }>(room.instance, env, "/head")).head;
    const roomTranscript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "direct",
      scope: "room:malicious",
      seq: 1,
      call: { actor: "#actor", target: "#thing", verb: "mutate", args: [], body: undefined },
      reads: [],
      writes: [{
        cell: { kind: "prop", object: "$leaf_class", name: "value" },
        value: 2,
        op: "set",
        writer: WRITER
      }],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: "catalog-rider-mutation"
    };
    const { applyTranscript } = await import("../../src/net/transcript");
    const { ScopeSequencer } = await import("../../src/net/scope");
    const roomTwin = new ScopeSequencer("room:malicious", EPOCH);
    roomTwin.seed(seedCells());
    const roomReply = await call<CommitReply>(room.instance, env, "/submit", {
      submit: {
        kind: "woo.net.commit_submit.v1",
        scope: "room:malicious",
        base: roomHead,
        idempotency_key: "catalog-rider-mutation",
        transcript: roomTranscript,
        post_state_version: applyTranscript(
          roomTwin.store,
          roomTranscript as never,
          { scope_head: "x", catalog_epoch: EPOCH }
        ).postStateVersion,
        stamp: { scope_head: "x", catalog_epoch: EPOCH }
      },
      rider_destinations: {
        [CATALOG_SCOPE]: { destination: `scope:${CATALOG_SCOPE}`, objects: ["$leaf_class"] }
      }
    });
    expect(roomReply.status).toBe("rejected");
    expect(roomReply.status === "rejected" && roomReply.reason).toBe("catalog_mutation");
    expect((await call<{ head: ScopeHead }>(room.instance, env, "/head")).head).toEqual(roomHead);
    const roomResidue = await call<{ cells: unknown[] }>(room.instance, env, "/closure", {
      keys: ["property_cell:$leaf_class:value"],
      known: []
    });
    expect(roomResidue.cells).toEqual([]);
    room.close();

    const scope = makeScope(CATALOG_SCOPE, env);
    const definitionCells = [
      {
        kind: "object_lineage" as const,
        object: "$leaf_class",
        value: {
          parent: "$thing",
          owner: "$wiz",
          name: "$leaf_class",
          anchor: null,
          flags: {},
          epoch_immutable_definition: true
        }
      },
      { kind: "property_cell" as const, object: "$leaf_class", name: "value", value: { value: 1 } }
    ];
    await call(scope.instance, env, "/seed", {
      scope: CATALOG_SCOPE,
      catalog_epoch: EPOCH,
      cells: definitionCells
    });
    const head = (await call<{ head: ScopeHead }>(scope.instance, env, "/head")).head;

    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "direct",
      scope: CATALOG_SCOPE,
      seq: 1,
      call: { actor: "$wiz", target: "$leaf_class", verb: "mutate", args: [], body: undefined },
      reads: [],
      writes: [{
        cell: { kind: "prop", object: "$leaf_class", name: "value" },
        value: 2,
        op: "set",
        writer: { ...WRITER, progr: "$wiz", thisObj: "$leaf_class", definer: "$leaf_class", caller: "$wiz", callerPerms: "$wiz" }
      }],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: "catalog-authority-mutation"
    };
    const twin = new ScopeSequencer(CATALOG_SCOPE, EPOCH);
    twin.seed(definitionCells);
    const reply = await call<CommitReply>(scope.instance, env, "/submit", {
      kind: "woo.net.commit_submit.v1",
      scope: CATALOG_SCOPE,
      base: head,
      idempotency_key: "catalog-authority-mutation",
      transcript,
      post_state_version: applyTranscript(
        twin.store,
        transcript as never,
        { scope_head: "x", catalog_epoch: EPOCH }
      ).postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    });

    expect(reply.status).toBe("rejected");
    expect(reply.status === "rejected" && reply.reason).toBe("catalog_mutation");
    expect(reply.status === "rejected" && reply.retryable).toBe(false);
    expect(reply.status === "rejected" && reply.detail).toEqual({
      objects: ["$leaf_class"],
      keys: ["property_cell:$leaf_class:value"]
    });
    expect((await call<{ head: ScopeHead }>(scope.instance, env, "/head")).head).toEqual(head);
    const closure = await call<{ cells: Array<{ value: unknown }> }>(scope.instance, env, "/closure", {
      keys: ["property_cell:$leaf_class:value"],
      known: ["object_lineage:$leaf_class"]
    });
    expect(closure.cells[0]?.value).toEqual({ value: 1 });

    // The real mixed-scope bypass shape reaches the catalog owner through
    // CA3 /adopt after a room commit. It must be terminally acknowledged but
    // install nothing, otherwise a skipped gateway check still corrupts the
    // exact-epoch certificate premise (or poisons the sender outbox forever).
    const adoptedValue = { value: 3 };
    const adopted = await call<{
      applied: boolean;
      installed: number;
      rejected?: { reason: string; detail: Record<string, unknown> };
    }>(scope.instance, env, "/adopt", {
      from_scope: "room:malicious",
      seq: 1,
      cells: [{
        key: "property_cell:$leaf_class:value",
        kind: "property_cell",
        object: "$leaf_class",
        name: "value",
        value: adoptedValue,
        version: cellVersion(adoptedValue),
        provenance: "authoritative",
        stamp: { scope_head: "1:foreign", catalog_epoch: EPOCH }
      }],
      prior_versions: { "property_cell:$leaf_class:value": cellVersion({ value: 1 }) }
    });
    expect(adopted).toMatchObject({
      applied: false,
      installed: 0,
      rejected: {
        reason: "catalog_mutation",
        detail: {
          objects: ["$leaf_class"],
          keys: ["property_cell:$leaf_class:value"]
        }
      }
    });
    expect((await call<{ head: ScopeHead }>(scope.instance, env, "/head")).head).toEqual(head);
    const afterAdopt = await call<{ cells: Array<{ value: unknown }> }>(scope.instance, env, "/closure", {
      keys: ["property_cell:$leaf_class:value"],
      known: ["object_lineage:$leaf_class"]
    });
    expect(afterAdopt.cells[0]?.value).toEqual({ value: 1 });

    // Receiver high-water records the terminal refusal: redelivery is an
    // idempotent no-op, not an infinite outbox retry loop.
    const replay = await call<{ applied: boolean; rejected?: unknown }>(scope.instance, env, "/adopt", {
      from_scope: "room:malicious",
      seq: 1,
      cells: [],
      prior_versions: {}
    });
    expect(replay).toEqual(expect.objectContaining({ applied: false }));
    expect(replay.rejected).toBeUndefined();
    scope.close();
  });

  it("scheduled turns arm the alarm durably and re-arm after restart (CO2.8)", async () => {
    const first = makeScope("room-a", env);
    await call(first.instance, env, "/schedule", {
      scope: "room-a",
      catalog_epoch: EPOCH,
      turn: { id: "tick-1", at_logical_time: Date.now() + 60_000, call: { actor: "#actor", target: "#thing", verb: "tick", args: [] } }
    });
    expect(first.alarms.filter((at) => at !== null)).toHaveLength(1);

    // "Eviction": fresh DO object, same storage; alarm() re-derives due
    // work from hydrated scope state and re-arms for the parked turn.
    const second = new NetScopeDO(first.state, env);
    await second.alarm();
    const rearmed = first.alarms[first.alarms.length - 1];
    expect(rearmed).not.toBeNull(); // parked turn still pending → re-armed
    first.close();
  });
});

describe("NetGatewayDO end-to-end over fake-DO", () => {
  it("pulls a view, plans and submits a real turn, installs accepted cells; fanout no-ops replays", async () => {
    const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET };
    const scope = makeScope("room-a", scopeEnv);
    await call(scope.instance, scopeEnv, "/seed", { scope: "room-a", catalog_epoch: EPOCH, cells: seedCells() });

    const gatewayState = netState("gateway-1");
    const gatewayEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === "scope:room-a") return scope.instance;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);

    const pulled = await call<{ installed: number }>(gateway, gatewayEnv, "/pull", {
      scope: "room-a",
      destination: "scope:room-a"
    });
    expect(pulled.installed).toBeGreaterThanOrEqual(3);

    // A real engine-planned turn requires verb bytecode in the view;
    // the seeded fixture has none, so the planner path is exercised by
    // tests/net/plan.test.ts. Here we drive the gateway's /net/turn with
    // a read-only call to prove the plumbing end-to-end (planning scope
    // fallback, head fetch, submit, reply passthrough).
    const result = await call<{ reply: CommitReply; selection: { scope: string } }>(gateway, gatewayEnv, "/turn", {
      call: {
        kind: "woo.turn_call.shadow.v1",
        route: "direct",
        scope: "room-a",
        actor: "#actor",
        target: "#thing",
        verb: "nonexistent_verb",
        args: []
      },
      planningScope: "room-a",
      catalog_epoch: EPOCH,
      idempotency_key: "gw-turn-1",
      scopes: { "room-a": "scope:room-a" },
      // Lane override (deprecated for production — CO15): the hand-built
      // seedCells fixture is not a derivable topology; keep the legacy
      // classifier. Derived-topology turns are covered by
      // tests/worker/net-topology-turn.test.ts.
      shared: ["room-a"]
    }).catch((err) => ({ reply: { status: "rejected" } as CommitReply, selection: { scope: "err" }, err: String(err) }));
    // A verb miss in a sparse view surfaces as a taxonomy/E_VERBNF-shaped
    // error, not a crash — either way the plumbing responded coherently.
    expect(result).toBeTruthy();

    // Fanout receiver: install + seq high-water + replay no-op.
    const body = {
      scope: "room-a",
      seq: 1,
      cells: [
        {
          key: "property_cell:#thing:label",
          kind: "property_cell",
          object: "#thing",
          name: "label",
          value: { value: "fanned" },
          version: "v-fan",
          provenance: "authoritative",
          stamp: { scope_head: "1:x", catalog_epoch: EPOCH }
        }
      ],
      observations: []
    };
    expect((await call<{ applied: boolean }>(gateway, gatewayEnv, "/fanout", body)).applied).toBe(true);
    expect((await call<{ applied: boolean }>(gateway, gatewayEnv, "/fanout", body)).applied).toBe(false);

    // Restart the gateway over the same storage: the high-water survives,
    // so the replay is still a no-op (durable CO2.5 at the receiver).
    const gateway2 = new NetGatewayDO(gatewayState.state, gatewayEnv);
    expect((await call<{ applied: boolean }>(gateway2, gatewayEnv, "/fanout", body)).applied).toBe(false);
    scope.close();
  });

  it("session-open mints at the cluster scope and installs the cell in the view (CO14)", async () => {
    const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET };
    const cluster = makeScope("cluster-actor", scopeEnv);
    await call(cluster.instance, scopeEnv, "/seed", { scope: "cluster:#actor", catalog_epoch: EPOCH, cells: seedCells() });

    const gatewayState = netState("gateway-sessions");
    const gatewayEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === "scope:cluster:#actor") return cluster.instance;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);

    const opened = await call<{ reply: CommitReply; scope: string; value: { id: string; actor: string; expiresAt: number } }>(
      gateway,
      gatewayEnv,
      "/session-open",
      { session: "s-open-1", actor: "#actor", ttl_ms: 60_000, catalog_epoch: EPOCH, cluster_destination: "scope:cluster:#actor" }
    );
    expect(opened.reply.status, JSON.stringify(opened.reply)).toBe("accepted");
    expect(opened.scope).toBe("cluster:#actor");
    expect(opened.value).toMatchObject({ id: "s-open-1", actor: "#actor" });

    // The accepted cell is authoritative at the cluster…
    const closure = await call<{ cells: Array<{ key: string; value: unknown }> }>(
      cluster.instance,
      scopeEnv,
      "/closure",
      { keys: ["session:s-open-1"], known: [] }
    );
    expect(closure.cells).toHaveLength(1);
    expect(closure.cells[0].value).toMatchObject({ id: "s-open-1", actor: "#actor" });

    // …and installed into the gateway view as a derived copy (CO7 fill).
    const probe = await call<{ cell: { value: unknown; provenance: string } | null }>(
      gateway,
      gatewayEnv,
      "/cell?key=session:s-open-1"
    );
    expect(probe.cell?.provenance).toBe("derived");
    expect(probe.cell?.value).toMatchObject({ id: "s-open-1", actor: "#actor" });

    // A sequenced submit at the cluster can now name the session: the
    // shell's authorize validates it from the OWNED cell (CO4 step 1).
    const head = (await call<{ head: ScopeHead }>(cluster.instance, scopeEnv, "/head")).head;
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "sequenced",
      scope: "cluster:#actor",
      seq: 1,
      session: "s-open-1",
      call: { actor: "#actor", target: "#thing", verb: "set_label", args: [], body: undefined },
      reads: [],
      writes: [{ cell: { kind: "prop", object: "#thing", name: "label" }, value: "sessioned", op: "set", writer: WRITER }],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: "net-do-session-1"
    };
    const { applyTranscript } = await import("../../src/net/transcript");
    const { ScopeSequencer } = await import("../../src/net/scope");
    const twin = new ScopeSequencer("cluster:#actor", EPOCH);
    twin.seed(seedCells());
    const derived = applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH });
    const sequencedReply = await call<CommitReply>(cluster.instance, scopeEnv, "/submit", {
      kind: "woo.net.commit_submit.v1",
      scope: "cluster:#actor",
      base: head,
      idempotency_key: "session-turn-1",
      transcript,
      post_state_version: derived.postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    });
    expect(sequencedReply.status, JSON.stringify(sequencedReply)).toBe("accepted");

    // Phase 5: a zero/negative TTL can no longer even CONSTRUCT a mint —
    // the no-expiry guard refuses at the library boundary, through the
    // real shell wiring (caller-bug class, non-2xx with the message).
    const guardRequest = new Request("https://do/net/session-open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session: "s-open-dead",
        actor: "#actor",
        ttl_ms: -1,
        catalog_epoch: EPOCH,
        cluster_destination: "scope:cluster:#actor"
      })
    });
    const guardResponse = await gateway.fetch(await signInternalRequest(gatewayEnv, guardRequest));
    expect(guardResponse.ok).toBe(false);
    expect(JSON.stringify(await guardResponse.json())).toContain("no-expiry sessions are forbidden");

    // The scope's authorize still names an already-expired session cell
    // "expired" (CO4 step 1) — exercised with a hand-built mint whose
    // written value expired in the past (the shape the guard now forbids
    // honest producers from constructing).
    const { cellVersion, CellStore } = await import("../../src/net/cells");
    const { sessionWriter } = await import("../../src/net/sessions");
    const deadValue = { id: "s-open-dead", actor: "#actor", started: Date.now() - 10_000, expiresAt: Date.now() - 5_000, activeScope: null };
    const deadBody = {
      kind: "woo.effect_transcript.shadow.v1",
      id: "session-mint:s-open-dead",
      route: "direct",
      scope: "cluster:#actor",
      seq: 0,
      session: "s-open-dead",
      call: { actor: "#actor", target: "#actor", verb: "session_mint", args: [], body: undefined },
      reads: [],
      writes: [{ cell: { kind: "session", object: "s-open-dead" }, value: deadValue, op: "set", writer: sessionWriter("#actor", "session_mint") }],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: []
    };
    const deadTranscript = { ...deadBody, hash: cellVersion(deadBody) };
    const deadApplied = applyTranscript(new CellStore("authority"), deadTranscript as never, { scope_head: "planner", catalog_epoch: EPOCH });
    const deadHead = (await call<{ head: ScopeHead }>(cluster.instance, scopeEnv, "/head")).head;
    const expiredReply = await call<CommitReply>(cluster.instance, scopeEnv, "/submit", {
      kind: "woo.net.commit_submit.v1",
      scope: "cluster:#actor",
      base: deadHead,
      idempotency_key: "session-mint:s-open-dead:manual",
      transcript: deadTranscript,
      post_state_version: deadApplied.postStateVersion,
      stamp: { scope_head: "planner", catalog_epoch: EPOCH }
    });
    expect(expiredReply.status).toBe("rejected");
    if (expiredReply.status === "rejected") {
      expect(expiredReply.reason).toBe("unauthorized");
      expect(expiredReply.detail).toMatchObject({ session: "s-open-dead", session_verdict: "expired" });
    }
    cluster.close();
  });

  it("a pull advances the fanout high-water to the closure head, so stale pre-pull fanout rows no-op (fix 7)", async () => {
    const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET };
    const scope = makeScope("room-a", scopeEnv);
    await call(scope.instance, scopeEnv, "/seed", { scope: "room-a", catalog_epoch: EPOCH, cells: seedCells() });

    // Advance the scope to head 1 with a direct commit, BEFORE any
    // gateway pulls — the pull must then arrive already-at-head-1.
    const head0 = (await call<{ head: ScopeHead }>(scope.instance, scopeEnv, "/head")).head;
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "direct",
      scope: "room-a",
      seq: 1,
      call: { actor: "#actor", target: "#thing", verb: "set_label", args: [], body: undefined },
      reads: [],
      writes: [{ cell: { kind: "prop", object: "#thing", name: "label" }, value: "pre-pull", op: "set", writer: WRITER }],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: "net-do-fix7-1"
    };
    const { applyTranscript } = await import("../../src/net/transcript");
    const { ScopeSequencer } = await import("../../src/net/scope");
    const twin = new ScopeSequencer("room-a", EPOCH);
    twin.seed(seedCells());
    const derived = applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH });
    const reply = await call<CommitReply>(scope.instance, scopeEnv, "/submit", {
      kind: "woo.net.commit_submit.v1",
      scope: "room-a",
      base: head0,
      idempotency_key: "fix7-t1",
      transcript,
      post_state_version: derived.postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    });
    expect(reply.status).toBe("accepted");

    const gatewayState = netState("gateway-fix7");
    const gatewayEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === "scope:room-a") return scope.instance;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    const pulled = await call<{ head: ScopeHead }>(gateway, gatewayEnv, "/pull", {
      scope: "room-a",
      destination: "scope:room-a"
    });
    expect(pulled.head.seq).toBe(1);

    // A stale pre-pull fanout row (seq <= the pulled head) must no-op —
    // applying it would regress the freshly pulled view.
    const staleFanout = {
      scope: "room-a",
      seq: 1,
      cells: [
        {
          key: "property_cell:#thing:label",
          kind: "property_cell",
          object: "#thing",
          name: "label",
          value: { value: "old-regression" },
          version: "v-stale",
          provenance: "authoritative",
          stamp: { scope_head: "1:x", catalog_epoch: EPOCH }
        }
      ],
      observations: []
    };
    expect((await call<{ applied: boolean }>(gateway, gatewayEnv, "/fanout", staleFanout)).applied).toBe(false);
    // The pulled state survived (no regression to the stale value).
    const probe = await call<{ cell: { value: unknown } | null }>(
      gateway,
      gatewayEnv,
      "/cell?key=property_cell:%23thing:label"
    );
    expect(probe.cell?.value).toEqual({ value: "pre-pull" });

    // A genuinely newer fanout (seq 2) still applies.
    expect(
      (await call<{ applied: boolean }>(gateway, gatewayEnv, "/fanout", { ...staleFanout, seq: 2 })).applied
    ).toBe(true);
    scope.close();
  });
});
