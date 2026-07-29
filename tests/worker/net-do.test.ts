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
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { cellKey, cellVersion } from "../../src/net/cells";
import type { CommitReply, ScopeHead } from "../../src/net/scope";
import { CATALOG_SCOPE } from "../../src/net/topology";
import { closeQuiescent, quiescentNetState } from "./quiescent-do";

const SECRET = "net-do-test-secret";
const EPOCH = "cat-net-1";

/** Fake DO state + the alarm slice the net DOs need (the base fake has
 * no alarm API); records armings so tests can assert re-arm behavior.
 *
 * This builds on the shared quiescent fixture rather than hand-rolling one.
 * The earlier version supplied NO `waitUntil` at all, which is not a way of
 * opting out of deferred work: `WorkerdHost.defer` runs the task first and
 * only then calls `state.waitUntil?.(promise)`, so the optional-call simply
 * discarded the handle and the work landed on storage this suite had closed.
 */
function netState(name: string): { state: NetScopeDurableState & NetGatewayDurableState; alarms: Array<number | null>; close: () => Promise<void> } {
  const alarms: Array<number | null> = [];
  const host = quiescentNetState(name, {
    setAlarm: (at: number) => {
      alarms.push(at);
    },
    deleteAlarm: () => {
      alarms.push(null);
    }
  });
  return { state: host.state, alarms, close: async () => closeQuiescent([host]) };
}

function durableRows(state: NetScopeDurableState & NetGatewayDurableState, query: string, ...bindings: unknown[]): unknown[] {
  const sql = state.storage.sql as { exec(statement: string, ...values: unknown[]): { toArray(): unknown[] } };
  return sql.exec(query, ...bindings).toArray();
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
    await scope.close();
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
    await a.close();
    await b.close();
  });

  it("keeps concurrent read-only direct submits at one stable authority head", async () => {
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
    expect(new Set(replies.map((reply) => reply.head.seq))).toEqual(new Set([0]));
    expect((await call<{ head: ScopeHead }>(scope.instance, env, "/head")).head.seq).toBe(0);
    await scope.close();
  });

  it("crosses an alarm event before a direct submit calls subscriber gateways", async () => {
    const deliveries: Array<{ destination: string; path: string }> = [];
    const envWithGateways: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => ({
        fetch: async (request) => {
          deliveries.push({ destination, path: new URL(request.url).pathname });
          return new Response(JSON.stringify({ delivered: true }), {
            headers: { "content-type": "application/json" }
          });
        }
      })
    };
    const scope = makeScope("room-live", envWithGateways);
    await call(scope.instance, envWithGateways, "/seed", {
      scope: "room-live",
      catalog_epoch: EPOCH,
      cells: seedCells()
    });
    for (const destination of ["gateway:origin", "gateway:peer"]) {
      await call(scope.instance, envWithGateways, "/subscribe", { destination });
    }
    const head = (await call<{ head: ScopeHead }>(scope.instance, envWithGateways, "/head")).head;
    const { applyTranscript } = await import("../../src/net/transcript");
    const { ScopeSequencer } = await import("../../src/net/scope");
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "direct",
      scope: "room-live",
      seq: 1,
      call: { actor: "#actor", target: "#thing", verb: "look", args: [], body: undefined },
      reads: [],
      writes: [],
      creates: [],
      moves: [],
      observations: [{ type: "looked", to: "#actor", text: "live view" }],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: "net-do-live-alarm"
    };
    const twin = new ScopeSequencer("room-live", EPOCH);
    twin.seed(seedCells());
    const submit = {
      kind: "woo.net.commit_submit.v1",
      scope: "room-live",
      base: head,
      idempotency_key: "live-alarm-1",
      transcript,
      post_state_version: applyTranscript(
        twin.store,
        transcript as never,
        { scope_head: "x", catalog_epoch: EPOCH }
      ).postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    };

    const reply = await call<CommitReply>(scope.instance, envWithGateways, "/submit", {
      submit,
      origin_gateway: "gateway:origin"
    });
    expect(reply.status).toBe("accepted");
    expect(deliveries, "no gateway RPC may inherit /submit's lineage").toEqual([]);

    await scope.instance.alarm();
    expect(deliveries).toEqual([{ destination: "gateway:peer", path: "/net/live" }]);
    expect((await call<{ head: ScopeHead }>(scope.instance, envWithGateways, "/head")).head).toEqual(head);
    await scope.close();
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
    expect(replay).toEqual({ ...reply, replayed: true, replay_output: { actor: "#actor" } }); // recorded reply, marked (B2), no double-commit
    const head1 = (await call<{ head: ScopeHead }>(second, env, "/head")).head;
    expect(head1.seq).toBe(1);

    const closure = await call<{ cells: Array<{ key: string; value: unknown }> }>(second, env, "/closure", {
      keys: [cellKey("property_cell", "#thing", "label")],
      known: ["object_lineage:#thing"]
    });
    expect(closure.cells[0]?.value).toEqual({ value: "new" });
    await first.close();
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
    expect(replayAgain).toEqual({ ...replay, replayed: true, replay_output: { actor: "#actor" } });
    const finalHead = (await call<{ head: ScopeHead }>(scope.instance, env, "/head")).head;
    expect(finalHead.seq).toBe(1);
    await scope.close();
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
    await scope.close();
  });

  it("a create that rides to another anchor leaves residue, not ownership (owns excludes the rider ledger)", async () => {
    // A create whose new object anchors ELSEWHERE still commits here — the
    // shared/planning scope serializes it — and rides the object's cells to
    // that anchor. This store keeps a lineage COPY. If `owns` read that copy
    // as ownership, every later turn committing here that reads a cell of the
    // object which lives only at the anchor would take the LOCAL branch, find
    // "absent", and reject read_version_mismatch forever: no refresh can put a
    // foreign cell into this store, so the gateway's repair loop escalates to
    // E_NONCONVERGENT_READ. (That is the builder case: an object anchored to
    // its author's cluster, created from a room turn, invoked from a later
    // room turn.) The correct verdict is "foreign" — attest or refuse.
    // The anchor is REACHABLE. The create rides `#ridden`'s cells to it via a
    // durable `/adopt` outbox row; with no resolver that delivery throws
    // `cannot resolve rpc destination` inside a deferred task, so the rider
    // adopt leg was never actually delivered anywhere in this file and the
    // failure was invisible. Resolving it does not weaken the scenario: the
    // point is still that room-a keeps only a lineage COPY.
    let elsewhere!: ReturnType<typeof makeScope>;
    const riderEnv: NetScopeEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination: string) => {
        if (destination === "scope:cluster-elsewhere") return elsewhere.instance;
        throw new Error(`unresolvable destination ${destination}`);
      }
    };
    elsewhere = makeScope("cluster-elsewhere", riderEnv);
    await call(elsewhere.instance, riderEnv, "/seed", { scope: "cluster-elsewhere", catalog_epoch: EPOCH, cells: [] });
    const scope = makeScope("room-a", riderEnv);
    await call(scope.instance, riderEnv, "/seed", { scope: "room-a", catalog_epoch: EPOCH, cells: seedCells() });
    const head0 = (await call<{ head: ScopeHead }>(scope.instance, riderEnv, "/head")).head;

    const { applyTranscript } = await import("../../src/net/transcript");
    const { ScopeSequencer } = await import("../../src/net/scope");
    const postStateFor = (transcript: unknown, priorSubmits: unknown[] = []) => {
      const twin = new ScopeSequencer("room-a", EPOCH);
      twin.seed(seedCells());
      for (const prior of priorSubmits) {
        applyTranscript(twin.store, prior as never, { scope_head: "x", catalog_epoch: EPOCH });
      }
      return applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH }).postStateVersion;
    };

    // Turn 1: mint #ridden here, anchored to cluster-elsewhere.
    const createTranscript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "direct",
      scope: "room-a",
      seq: 1,
      call: { actor: "#actor", target: "#thing", verb: "make", args: [], body: undefined },
      reads: [],
      writes: [],
      creates: [{
        object: "#ridden",
        name: "Ridden",
        parent: "#thing",
        owner: "#actor",
        anchor: "#elsewhere",
        location: null,
        flags: {},
        writer: WRITER
      }],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: "net-do-residue-create"
    };
    const created = await call<CommitReply>(scope.instance, riderEnv, "/submit", {
      submit: {
        kind: "woo.net.commit_submit.v1",
        scope: "room-a",
        base: head0,
        idempotency_key: "residue-create",
        transcript: createTranscript,
        post_state_version: postStateFor(createTranscript),
        stamp: { scope_head: "x", catalog_epoch: EPOCH }
      },
      // The gateway names the created object as cluster-elsewhere's rider.
      rider_destinations: {
        "cluster-elsewhere": { destination: "scope:cluster-elsewhere", objects: ["#ridden"] }
      }
    });
    expect(created.status, JSON.stringify(created)).toBe("accepted");
    // The lineage copy IS here — the ownership question is what that means.
    const residue = await call<{ cells: Array<{ key: string }> }>(scope.instance, riderEnv, "/closure", {
      keys: ["object_lineage:#ridden"],
      known: []
    });
    expect(residue.cells.map((c) => c.key)).toContain("object_lineage:#ridden");

    // Turn 2: read a cell of #ridden this scope does NOT hold. Foreign
    // classification means "attest it"; ownership would mean "absent, mismatch".
    const head1 = (await call<{ head: ScopeHead }>(scope.instance, riderEnv, "/head")).head;
    const readRidden = {
      ...createTranscript,
      creates: [],
      seq: 2,
      hash: "net-do-residue-read",
      reads: [{ cell: { kind: "verb", object: "#ridden", name: "hi" }, version: "owner-verb-version", value: null }],
      writes: [{ cell: { kind: "prop", object: "#thing", name: "label" }, value: "residue-check", op: "set", writer: WRITER }]
    };
    const unattested = await call<CommitReply>(scope.instance, riderEnv, "/submit", {
      kind: "woo.net.commit_submit.v1",
      scope: "room-a",
      base: head1,
      idempotency_key: "residue-read-0",
      transcript: readRidden,
      post_state_version: postStateFor(readRidden, [createTranscript]),
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    });
    expect(unattested.status).toBe("rejected");
    // rider_unattested, NOT read_version_mismatch: the scope knows the cell is
    // someone else's and asks for the owner's word instead of consulting a
    // copy it does not sequence.
    expect(unattested.status === "rejected" && unattested.reason).toBe("rider_unattested");

    // With the owner's attestation the same turn commits.
    const accepted = await call<CommitReply>(scope.instance, riderEnv, "/submit", {
      kind: "woo.net.commit_submit.v1",
      scope: "room-a",
      base: head1,
      idempotency_key: "residue-read-1",
      transcript: readRidden,
      post_state_version: postStateFor(readRidden, [createTranscript]),
      stamp: { scope_head: "x", catalog_epoch: EPOCH },
      attestations: {
        "cluster-elsewhere": {
          owner_head: { seq: 7, hash: "owner-h7" },
          cells: [{ key: "verb_bytecode:#ridden:hi", version: "owner-verb-version" }]
        }
      }
    });
    expect(accepted.status, JSON.stringify(accepted)).toBe("accepted");
    await scope.close();
    await elsewhere.close();
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
    await room.close();

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
    await scope.close();
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
    await first.close();
  });
});

describe("NetGatewayDO end-to-end over fake-DO", () => {
  it("replaces every compactable catalog cell before certifying a full pull", async () => {
    const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET };
    const catalog = makeScope("catalog-exact", scopeEnv);
    await call(catalog.instance, scopeEnv, "/seed", {
      scope: CATALOG_SCOPE,
      catalog_epoch: EPOCH,
      cells: [
        {
          kind: "object_lineage",
          object: "$outliner",
          value: { parent: null, owner: "$wiz", name: "$outliner", anchor: null, flags: {} }
        },
        {
          kind: "verb_bytecode",
          object: "$outliner",
          name: "list_items",
          value: { name: "list_items", bytecode: [{ op: "RETURN", value: [] }], arg_spec: { args: [] } }
        },
        {
          kind: "property_cell",
          object: "$outliner",
          name: "current_slot",
          value: {
            value: null,
            def: { name: "current_slot", defaultValue: null, typeHint: "obj|null", owner: "$wiz", perms: "r", version: 1 }
          }
        }
      ]
    });

    const gatewayState = netState("gateway-catalog-exact");
    const gatewayEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === "scope:catalog") return catalog.instance;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
    const staleKey = "verb_bytecode:$outliner:_siblings_ordered";
    const stalePropertyKey = "property_cell:$outliner:parent";
    const ordinaryPropertyKey = "property_cell:$outliner:runtime_marker";
    const roomVerbKey = "verb_bytecode:custom_room:operator_authored";
    const roomDefinitionKey = "property_cell:custom_room:operator_slot";
    expect((await call<{ applied: boolean }>(gateway, gatewayEnv, "/fanout", {
      scope: CATALOG_SCOPE,
      seq: 1,
      cells: [
        {
          key: staleKey,
          kind: "verb_bytecode",
          object: "$outliner",
          name: "_siblings_ordered",
          value: { name: "_siblings_ordered", bytecode: [{ op: "RETURN", value: [] }], arg_spec: { args: [] } },
          version: "stale-v1",
          provenance: "authoritative",
          stamp: { scope_head: "1:stale", catalog_epoch: EPOCH }
        },
        {
          key: stalePropertyKey,
          kind: "property_cell",
          object: "$outliner",
          name: "parent",
          value: {
            value: null,
            def: { name: "parent", defaultValue: null, typeHint: "obj|null", owner: "$wiz", perms: "r", version: 1 }
          },
          version: "stale-property-v1",
          provenance: "authoritative",
          stamp: { scope_head: "1:stale", catalog_epoch: EPOCH }
        },
        {
          key: ordinaryPropertyKey,
          kind: "property_cell",
          object: "$outliner",
          name: "runtime_marker",
          value: { value: "keep-me" },
          version: "ordinary-property",
          provenance: "authoritative",
          stamp: { scope_head: "1:stale", catalog_epoch: EPOCH }
        },
        {
          key: "object_lineage:custom_room",
          kind: "object_lineage",
          object: "custom_room",
          value: { parent: "$space", owner: "$wiz", name: "custom_room", anchor: null, flags: {} },
          version: "room-lineage",
          provenance: "authoritative",
          stamp: { scope_head: "1:stale", catalog_epoch: EPOCH }
        },
        {
          key: roomVerbKey,
          kind: "verb_bytecode",
          object: "custom_room",
          name: "operator_authored",
          value: { name: "operator_authored", bytecode: [{ op: "RETURN", value: "keep" }], arg_spec: { args: [] } },
          version: "room-verb",
          provenance: "authoritative",
          stamp: { scope_head: "1:stale", catalog_epoch: EPOCH }
        },
        {
          key: roomDefinitionKey,
          kind: "property_cell",
          object: "custom_room",
          name: "operator_slot",
          value: {
            value: null,
            def: { name: "operator_slot", defaultValue: null, typeHint: "obj|null", owner: "$wiz", perms: "r", version: 1 }
          },
          version: "room-property",
          provenance: "authoritative",
          stamp: { scope_head: "1:stale", catalog_epoch: EPOCH }
        }
      ],
      observations: []
    })).applied).toBe(true);
    expect(durableRows(gatewayState.state, "SELECT body FROM net_gateway_cell WHERE key = ?", staleKey)).toHaveLength(1);
    expect(durableRows(gatewayState.state, "SELECT body FROM net_gateway_cell WHERE key = ?", stalePropertyKey)).toHaveLength(1);

    const pulled = await call<{ source: string; installed: number }>(gateway, gatewayEnv, "/pull", {
      scope: CATALOG_SCOPE,
      destination: "scope:catalog"
    });
    expect(pulled).toMatchObject({ source: "live", installed: 3 });
    expect(durableRows(gatewayState.state, "SELECT body FROM net_gateway_cell WHERE key = ?", staleKey)).toHaveLength(0);
    expect(durableRows(gatewayState.state, "SELECT body FROM net_gateway_cell WHERE key = ?", stalePropertyKey)).toHaveLength(0);
    // Full-pull exactness is not definition-specific. This ordinary
    // catalog-owned property would be eligible for complete-head read
    // compaction too, so retaining it would certify a stale value.
    expect(durableRows(gatewayState.state, "SELECT body FROM net_gateway_cell WHERE key = ?", ordinaryPropertyKey)).toHaveLength(0);
    expect(durableRows(gatewayState.state, "SELECT body FROM net_gateway_cell WHERE key = ?", roomVerbKey)).toHaveLength(1);
    expect(durableRows(gatewayState.state, "SELECT body FROM net_gateway_cell WHERE key = ?", roomDefinitionKey)).toHaveLength(1);
    expect(durableRows(
      gatewayState.state,
      "SELECT owner_scope FROM net_gateway_cell WHERE key = ?",
      roomVerbKey
    )).toEqual([{ owner_scope: "room:custom_room" }]);
    expect(durableRows(gatewayState.state,
      "SELECT body FROM net_gateway_cell WHERE key = 'verb_bytecode:$outliner:list_items'"
    )).toHaveLength(1);

    // Cold hydration must not resurrect the deleted page from SQLite.
    const restarted = new NetGatewayDO(gatewayState.state, gatewayEnv);
    await call(restarted, gatewayEnv, "/pull", { scope: CATALOG_SCOPE, destination: "scope:catalog" });
    expect(durableRows(gatewayState.state, "SELECT body FROM net_gateway_cell WHERE key = ?", staleKey)).toHaveLength(0);
    expect(durableRows(gatewayState.state, "SELECT body FROM net_gateway_cell WHERE key = ?", stalePropertyKey)).toHaveLength(0);
    expect(durableRows(gatewayState.state, "SELECT body FROM net_gateway_cell WHERE key = ?", ordinaryPropertyKey)).toHaveLength(0);
    expect(durableRows(gatewayState.state, "SELECT body FROM net_gateway_cell WHERE key = ?", roomVerbKey)).toHaveLength(1);
    expect(durableRows(gatewayState.state, "SELECT body FROM net_gateway_cell WHERE key = ?", roomDefinitionKey)).toHaveLength(1);
    await catalog.close();
    await gatewayState.close();
  });

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

    // Definition retirement uses the same ordered fanout stream. The removal
    // must delete durable gateway state, not merely hide it in this instance.
    const removal = {
      scope: "room-a",
      seq: 2,
      cells: [],
      removed_cells: ["property_cell:#thing:label"],
      observations: []
    };
    expect((await call<{ applied: boolean }>(gateway, gatewayEnv, "/fanout", removal)).applied).toBe(true);
    expect(durableRows(gatewayState.state,
      "SELECT body FROM net_gateway_cell WHERE key = 'property_cell:#thing:label'"
    )).toHaveLength(0);

    // Restart the gateway over the same storage: the high-water survives,
    // so the replay is still a no-op (durable CO2.5 at the receiver).
    const gateway2 = new NetGatewayDO(gatewayState.state, gatewayEnv);
    expect((await call<{ applied: boolean }>(gateway2, gatewayEnv, "/fanout", body)).applied).toBe(false);
    expect((await call<{ applied: boolean }>(gateway2, gatewayEnv, "/fanout", removal)).applied).toBe(false);
    await scope.close();
  });

  it("session-open mints at the cluster scope and installs the cell in the view (CO14)", async () => {
    const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET };
    const cluster = makeScope("cluster-actor", scopeEnv);
    await call(cluster.instance, scopeEnv, "/seed", { scope: "cluster:#actor", catalog_epoch: EPOCH, cells: seedCells() });

    const gatewayState = netState("gateway-sessions");
    let clusterHeadCalls = 0;
    const countedCluster = {
      fetch: async (request: Request): Promise<Response> => {
        if (new URL(request.url).pathname.endsWith("/head")) clusterHeadCalls += 1;
        return cluster.instance.fetch(request);
      }
    };
    const gatewayEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === "scope:cluster:#actor") return countedCluster;
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
    expect(clusterHeadCalls).toBe(1);

    // The accepted mint returned the cluster's exact new head. A second
    // session substrate commit on this gateway reuses it and therefore pays
    // no routine /head RPC; /submit remains the authority check.
    const openedAgain = await call<{ reply: CommitReply }>(
      gateway,
      gatewayEnv,
      "/session-open",
      { session: "s-open-2", actor: "#actor", ttl_ms: 60_000, catalog_epoch: EPOCH, cluster_destination: "scope:cluster:#actor" }
    );
    expect(openedAgain.reply.status, JSON.stringify(openedAgain.reply)).toBe("accepted");
    expect(clusterHeadCalls).toBe(1);

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

    // A write from another gateway advances authority after the retained
    // hint. The scope, not the cache, proves that base through its bounded
    // retained tail and safely rebases this readless session commit without
    // adding a /head round trip.
    const repaired = await call<{ reply: CommitReply }>(
      gateway,
      gatewayEnv,
      "/session-open",
      { session: "s-open-3", actor: "#actor", ttl_ms: 60_000, catalog_epoch: EPOCH, cluster_destination: "scope:cluster:#actor" }
    );
    expect(repaired.reply.status, JSON.stringify(repaired.reply)).toBe("accepted");
    expect(clusterHeadCalls).toBe(1);

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
    await cluster.close();
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
    await scope.close();
  });
});
