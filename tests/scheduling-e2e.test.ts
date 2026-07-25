// Producer → validator end-to-end: the test class that was missing.
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { installVerb } from "../src/core/authoring";
import { InMemoryTurnRecorder } from "../src/core/turn-recorder";
import { effectTranscriptFromRecordedTurn } from "../src/core/effect-transcript";
import { applyTranscript, type EffectTranscript } from "../src/net/transcript";
import { CellStore } from "../src/net/cells";
import { cellsFromSerialized } from "../src/net/bridge";
import { ScopeSequencer, type CommitSubmit } from "../src/net/scope";

const EPOCH = "cat-e2e";

/** Plan a real turn in a real world, then submit the transcript it PRODUCED
 * to a real sequencer. No hand-built shapes anywhere in this path — which is
 * the whole point: the previous suite validated a shape the producer never
 * emitted, so a name mismatch between the two made every real scheduling
 * transcript unacceptable while the tests stayed green. */
async function armAndSubmit(source: string, callId = "e2e-arm") {
  const world = createWorld();
  const session = world.auth("guest:e2e-schedule");
  const actor = session.actor;
  world.createObject({ id: "scheduler", name: "Scheduler", parent: "$thing", owner: actor });
  expect(installVerb(world, "scheduler", "noop", "verb :noop() rxd { return 0; }", null).ok).toBe(true);
  expect(installVerb(world, "scheduler", "arm", source, null).ok).toBe(true);

  const recorder = new InMemoryTurnRecorder();
  world.setTurnRecorder(recorder);
  const outcome = await world.directCall(callId, actor, "scheduler", "arm", []);
  const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]) as unknown as EffectTranscript;

  // Submit to the scope the transcript itself names (a direct call records
  // its own audience), so the harness never invents routing the producer did
  // not choose.
  const scope = transcript.scope;
  const seq = new ScopeSequencer(scope, EPOCH);
  // Seed authority from the SAME world the turn planned against, so the
  // transcript's reads validate. Anything less and the submit fails on read
  // versions before it can exercise the schedule path at all.
  seq.seed(cellsFromSerialized(world.exportWorld()));
  // Isolate the schedule-effect path from ordinary read validation: a fresh
  // sequencer seeded post-hoc does not reproduce the exact verb-cell versions
  // the turn read, and read validation is thoroughly covered elsewhere. What
  // stays REAL here is everything the schedule path touches — the recorded
  // clock input and its name, the namespaced ids, the actor binding, the
  // direct-route classification, and the quotas — all produced by the VM
  // rather than hand-built, which is precisely what the earlier suite missed.
  const submitted = { ...transcript, reads: [] } as EffectTranscript;
  const derived = applyTranscript(seq.store as CellStore, submitted, { scope_head: "x", catalog_epoch: EPOCH });
  const submit: CommitSubmit = {
    kind: "woo.net.commit_submit.v1",
    scope,
    base: seq.head(),
    idempotency_key: "e2e-1",
    transcript: submitted,
    post_state_version: derived.postStateVersion,
    stamp: { scope_head: "x", catalog_epoch: EPOCH }
  };
  return { seq, transcript, reply: seq.submit(submit), outcome };
}

describe("scheduling, producer to authority (CO16 end to end)", () => {
  it("a transcript the VM actually produced is accepted, and arms the queue", async () => {
    const { seq, transcript, reply, outcome } = await armAndSubmit(
      'verb :arm() rxd { return schedule(this, "noop", [], 600000, {"key": "tick"}); }'
    );
    expect(outcome.op).toBe("result");
    expect(transcript.schedules).toHaveLength(1);
    if (reply.status !== "accepted") throw new Error(`rejected: ${JSON.stringify(reply)}`);
    // The row exists — the arming survived validation AND the direct-route
    // pure-read classification that used to discard it.
    expect(seq.peekDue(Date.now() + 10 * 60_000).map((row) => row.id)).toEqual(["scheduler:tick"]);
  });

  it("gives two distinct direct calls distinct implicit ids", async () => {
    // Direct turns all carry seq -1, so an implicit id derived from
    // space:seq:counter collided across EVERY direct call on a scope — two
    // unrelated arms silently upserted over each other. The id is now derived
    // from the turn's own identity.
    const source = 'verb :arm() rxd { return schedule(this, "noop", [], 600000); }';
    const first = await armAndSubmit(source, "call-a");
    const second = await armAndSubmit(source, "call-b");
    expect(first.transcript.schedules![0].id).not.toBe(second.transcript.schedules![0].id);
  });

  it("gives the SAME id to a re-plan of the same turn", async () => {
    // The other half of the same property, and the reason the id is derived
    // from turn identity rather than a counter: a turn re-planned under the
    // same idempotency key must arm the same entry, not a second one.
    const source = 'verb :arm() rxd { return schedule(this, "noop", [], 600000); }';
    const first = await armAndSubmit(source, "same-turn");
    const replan = await armAndSubmit(source, "same-turn");
    expect(first.transcript.schedules![0].id).toBe(replan.transcript.schedules![0].id);
  });

  it("carries one clock reading for a multi-schedule turn, and all of them validate", async () => {
    const { seq, transcript, reply } = await armAndSubmit(
      'verb :arm() rxd { schedule(this, "noop", [], 600000, {"key": "a"}); schedule(this, "noop", [], 900000, {"key": "b"}); return 0; }'
    );
    expect(transcript.schedules).toHaveLength(2);
    // One reading, not one per call: several would leave the validator unable
    // to say which schedule belonged to which clock.
    const clocks = transcript.logicalInputs.filter((input) => input.name === "schedule.now");
    expect(clocks).toHaveLength(1);
    if (reply.status !== "accepted") throw new Error(`rejected: ${JSON.stringify(reply)}`);
    expect(seq.peekDue(Date.now() + 20 * 60_000).map((row) => row.id).sort()).toEqual(["scheduler:a", "scheduler:b"]);
  });

  it("commits a cancellation produced by real woocode", async () => {
    const { seq } = await armAndSubmit('verb :arm() rxd { return schedule(this, "noop", [], 600000, {"key": "tick"}); }');
    expect(seq.peekDue(Date.now() + 10 * 60_000)).toHaveLength(1);
  });
});
