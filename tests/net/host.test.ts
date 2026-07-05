// InProcessHost — deterministic clock/alarm/defer binding, plus the first
// scope+outbox integration: commit → durable enqueue → post-reply drain →
// receiver install; scheduled turn wakes via the scope alarm and survives
// "eviction" (rebuild from scope state), per coherence.md CO1/CO2.7/CO2.8.
import { describe, expect, it } from "vitest";
import { CellStore } from "../../src/net/cells";
import { InProcessHost } from "../../src/net/host";
import { applyFanout, Outbox } from "../../src/net/outbox";
import { ScopeSequencer } from "../../src/net/scope";
import { applyTranscript, type EffectTranscript } from "../../src/net/transcript";
import type { CommitSubmit } from "../../src/net/scope";

const EPOCH = "cat1";
const WRITER = { progr: "#a", thisObj: "#t", verb: "v", definer: "$thing", caller: "#a", callerPerms: "#a" };

function transcript(hash: string, value: string): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    route: "sequenced",
    scope: "the_room",
    seq: 1,
    call: { actor: "#a", target: "#t", verb: "v", args: [], body: undefined },
    reads: [],
    writes: [{ cell: { kind: "prop", object: "#t", name: "n" }, value: value as never, op: "set", writer: WRITER }],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash
  } as EffectTranscript;
}

function submitFor(seq: ScopeSequencer, t: EffectTranscript, key: string): CommitSubmit {
  const derived = applyTranscript(seq.store, t, { scope_head: "x", catalog_epoch: EPOCH });
  return { kind: "woo.net.commit_submit.v1", scope: "the_room", base: seq.head(), idempotency_key: key, transcript: t, post_state_version: derived.postStateVersion, stamp: { scope_head: "x", catalog_epoch: EPOCH } };
}

describe("InProcessHost determinism", () => {
  it("defer runs only on flush, in order, including nested defers", async () => {
    const host = new InProcessHost();
    const ran: string[] = [];
    host.defer(async () => {
      ran.push("a");
      host.defer(async () => { ran.push("a2"); });
    });
    host.defer(async () => { ran.push("b"); });
    expect(ran).toEqual([]);
    await host.flush();
    expect(ran).toEqual(["a", "b", "a2"]);
  });

  it("advance fires due alarms in time order and lets them re-arm", async () => {
    const host = new InProcessHost();
    const fired: number[] = [];
    host.setAlarm("scope", 10, async () => {
      fired.push(10);
      host.setAlarm("scope", 20, async () => { fired.push(20); });
    });
    await host.advance(15);
    expect(fired).toEqual([10]);
    expect(host.pendingAlarms()).toEqual([{ key: "scope", at: 20 }]);
    await host.advance(25);
    expect(fired).toEqual([10, 20]);
    expect(host.now()).toBe(25);
  });
});

describe("commit → fanout → receiver, off the reply path (CO2.7)", () => {
  it("enqueues durably before reply and delivers on the deferred drain", async () => {
    const host = new InProcessHost(1000);
    const scope = new ScopeSequencer("the_room", EPOCH);
    const outbox = new Outbox();
    const receiver = new CellStore("derived");
    const seen = new Map<string, number>();

    const reply = scope.submit(submitFor(scope, transcript("t1", "hello"), "k1"));
    expect(reply.status).toBe("accepted");
    if (reply.status !== "accepted") return;

    // Durable enqueue happens before the reply returns to the caller;
    // delivery is deferred (never on the reply path).
    const cells = reply.touched.map((key) => scope.store.get(key)).filter((c): c is NonNullable<typeof c> => Boolean(c));
    outbox.enqueue("shard-1", { scope: "the_room", seq: reply.head.seq, cells, observations: [] });
    host.defer(async () => {
      await outbox.drain(host.now(), async (row) => { applyFanout(receiver, seen, row.body); });
    });

    expect(receiver.size).toBe(0); // reply returned; nothing delivered yet
    await host.flush();
    expect(receiver.get("property_cell:#t:n")?.value).toBe("hello");
    expect(receiver.get("property_cell:#t:n")?.provenance).toBe("derived");
  });
});

describe("scheduled turns wake via the scope alarm and survive eviction (CO2.8)", () => {
  it("fires due turns at the alarm and re-arms for the remainder", async () => {
    const host = new InProcessHost();
    const scope = new ScopeSequencer("the_room", EPOCH);
    const fired: string[] = [];

    // The arming pattern a Host binding uses: read nextAlarmAt from scope
    // state, arm, and inside fire() pop due turns then re-arm.
    const arm = () => {
      host.setAlarm("the_room", scope.nextAlarmAt(), async () => {
        for (const turn of scope.dueTurns(host.now())) fired.push(turn.id);
        arm();
      });
    };
    scope.schedule({ id: "early", at_logical_time: 10, call: { actor: "#a", target: "#t", verb: "tick", args: [] } }, 0);
    scope.schedule({ id: "late", at_logical_time: 30, call: { actor: "#a", target: "#t", verb: "tick", args: [] } }, 0);
    arm();

    await host.advance(15);
    expect(fired).toEqual(["early"]);

    // "Eviction": a fresh Host loses in-memory alarms; re-arming from
    // scope state alone recovers the pending turn — the queue is scope
    // state, not host state.
    const rebuilt = new InProcessHost(15);
    const armRebuilt = () => {
      rebuilt.setAlarm("the_room", scope.nextAlarmAt(), async () => {
        for (const turn of scope.dueTurns(rebuilt.now())) fired.push(turn.id);
        armRebuilt();
      });
    };
    armRebuilt();
    await rebuilt.advance(35);
    expect(fired).toEqual(["early", "late"]);
    expect(scope.nextAlarmAt()).toBeNull();
  });
});
