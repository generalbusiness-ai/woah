// The $scheduling catalog surface (spec/semantics/scheduling.md SC11).
//
// Producer-driven throughout: every case installs the real catalog, calls the
// real verb, and asserts on the transcript the VM actually produced or on the
// queue a real ScopeSequencer actually holds. Nothing here hand-builds a
// schedule entry — an earlier round of this feature shipped a producer and a
// validator that disagreed about a field name, behind fifteen green tests that
// asserted against a shape invented for them.
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { installLocalCatalogs } from "../src/core/local-catalogs";
import { installVerb, installVerbAs } from "../src/core/authoring";
import { InMemoryTurnRecorder } from "../src/core/turn-recorder";
import { effectTranscriptFromRecordedTurn } from "../src/core/effect-transcript";
import { applyTranscript, type EffectTranscript } from "../src/net/transcript";
import { CellStore } from "../src/net/cells";
import { cellsFromSerialized } from "../src/net/bridge";
import { ScopeSequencer, type CommitSubmit } from "../src/net/scope";
import { SCHEDULE_MIN_LEAD_MS } from "../src/core/scheduling";

const EPOCH = "cat-sched-catalog";

/** A world with the scheduling feature mounted on a plain thing. */
function schedulingWorld() {
  const world = createWorld();
  const session = world.auth("guest:scheduling-catalog");
  const actor = session.actor;
  installLocalCatalogs(world, ["chat", "note", "scheduling"]);
  // Features attach to $actor and $space descendants only (features.md FT1),
  // which is also the realistic mounting: a room that schedules things.
  world.createObject({ id: "the_widget", name: "Widget", parent: "$room", owner: actor });
  world.setProp("the_widget", "features", ["$scheduling"] as never);
  return { world, session, actor };
}

/** Put the actor in the room. Scheduling verbs are ordinary room verbs and
 * carry the ordinary presence check — you arrange things in a room you are
 * in — so every case has to enter first, exactly as a user would. */
async function enter(world: ReturnType<typeof createWorld>, session: { id: string; actor: string }) {
  const moved = await world.directCall("enter", session.actor, session.actor, "moveto", ["the_widget"] as never, {
    sessionId: session.id
  } as never);
  expect(moved.op).toBe("result");
}

/** Call a verb and return the transcript the VM produced for that turn. */
async function callAndRecord(
  world: ReturnType<typeof createWorld>,
  actor: string,
  target: string,
  verb: string,
  args: unknown[],
  id = "sched-catalog",
  sessionId?: string
) {
  const recorder = new InMemoryTurnRecorder();
  world.setTurnRecorder(recorder);
  const outcome = await world.directCall(id, actor, target, verb, args as never, { sessionId } as never);
  const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]) as unknown as EffectTranscript;
  world.setTurnRecorder(null as never);
  return { outcome, transcript };
}

/** Submit a produced transcript to a real sequencer seeded from the same
 * world, so the authority rules (namespace, actor binding, target locality,
 * the `always` gate, lead time, quotas) all run for real. Reads are dropped:
 * read validation is covered elsewhere and a post-hoc seed cannot reproduce
 * the exact verb-cell versions the turn read. */
function commit(world: ReturnType<typeof createWorld>, transcript: EffectTranscript, key = "c1") {
  const seq = new ScopeSequencer(transcript.scope, EPOCH);
  seq.seed(cellsFromSerialized(world.exportWorld()));
  const submitted = { ...transcript, reads: [] } as EffectTranscript;
  const derived = applyTranscript(seq.store as CellStore, submitted, { scope_head: "x", catalog_epoch: EPOCH });
  const submit: CommitSubmit = {
    kind: "woo.net.commit_submit.v1",
    scope: transcript.scope,
    base: seq.head(),
    idempotency_key: key,
    transcript: submitted,
    post_state_version: derived.postStateVersion,
    stamp: { scope_head: "x", catalog_epoch: EPOCH }
  };
  return { seq, reply: seq.submit(submit) };
}

describe("$scheduling — reminders", () => {
  it("arms an always reminder for an ordinary, non-wizard actor", async () => {
    // The point of the whole feature. Arming `always` needs wizard authority
    // (CO16.6), the caller has none, and the catalog verb is $wiz-owned — so
    // the gate is discharged HERE rather than by making users wizards. If this
    // ever fails with E_PERM, the surface has stopped being usable.
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    expect(world.object(actor).flags.wizard).not.toBe(true);

    const { outcome, transcript } = await callAndRecord(world, actor, "the_widget", "remind_in", [600_000, "stand up"], session.id);
    expect(outcome.op).toBe("result");
    expect(transcript.schedules).toHaveLength(1);

    const armed = transcript.schedules![0];
    expect(armed.idlePolicy).toBe("always");
    expect(armed.call).toMatchObject({ target: "the_widget", verb: "_deliver_reminder", actor });
    expect(armed.call.args).toEqual([actor, "stand up"]);
    // Authority comes from the catalog verb's owner, not the caller.
    expect(armed.armed_by).toMatchObject({ progr: "$wiz", thisObj: "the_widget" });
  });

  it("is accepted by a real commit scope, gate and all", async () => {
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    const { transcript } = await callAndRecord(world, actor, "the_widget", "remind_in", [600_000, "stand up"], session.id);
    const { seq, reply } = commit(world, transcript);
    if (reply.status !== "accepted") throw new Error(`rejected: ${JSON.stringify(reply)}`);
    expect(seq.peekDue(Date.now() + 10 * 60_000)).toHaveLength(1);
    expect(seq.peekDue(Date.now() + 10 * 60_000)[0].idle_policy).toBe("always");
  });

  it("refuses a direct call to the delivery verb, before any turn is recorded", async () => {
    // SC6's other half. _deliver_reminder runs with the scheduler's identity
    // when fired; if it were reachable, anyone could mint a note in anyone
    // else's inventory. It is not direct_callable, so the refusal happens at
    // ingress and nothing is created.
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    const before = world.objects.size;
    const outcome = await world.directCall(
      "fire-1", actor, "the_widget", "_deliver_reminder", [actor, "forged"] as never, { sessionId: session.id } as never
    );
    expect(outcome.op).toBe("error");
    expect(JSON.stringify(outcome)).toMatch(/E_DIRECT_DENIED|E_PERM|E_VERBNF/);
    expect(world.objects.size).toBe(before);
  });

  it("refuses a reminder that is empty or oversized", async () => {
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    for (const [args, pattern] of [
      [[600_000, ""], /E_INVARG/],
      [[600_000, "x".repeat(4097)], /E_QUOTA/],
      [["soon", "text"], /E_TYPE/]
    ] as const) {
      const { outcome } = await callAndRecord(world, actor, "the_widget", "remind_in", args as never, `bad-${String(args[1]).slice(0, 4)}`, session.id);
      expect(JSON.stringify(outcome)).toMatch(pattern);
    }
  });
});

describe("$scheduling — one user cannot touch another's timer", () => {
  it("scopes a reminder's id to the actor who armed it", async () => {
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    const { transcript } = await callAndRecord(world, actor, "the_widget", "remind_in", [600_000, "mine", "t"], "r1", session.id);
    // The caller is IN the id, so there is no id another caller could spell.
    expect(transcript.schedules![0].id).toBe(`the_widget:remind:${actor}:t`);
  });

  it("refuses one actor cancelling another actor's reminder", async () => {
    // The bug: cancel_reminder took a raw id, and because the catalog verb is
    // $wiz-owned the kernel's cross-namespace check saw a wizard `progr` and
    // allowed it — for anyone. Both halves are fixed: the verb rebuilds the
    // id from the caller, and the kernel keys the bypass on the ACTOR.
    const { world, session: s1 } = schedulingWorld();
    await enter(world, s1);
    const s2 = world.auth("guest:scheduling-intruder");
    const moved = await world.directCall("enter2", s2.actor, s2.actor, "moveto", ["the_widget"] as never, {
      sessionId: s2.id
    } as never);
    expect(moved.op).toBe("result");

    const armed = await callAndRecord(world, s1.actor, "the_widget", "remind_in", [600_000, "mine", "t"], "r-own", s1.id);
    const victimId = armed.transcript.schedules![0].id;
    const { seq } = commit(world, armed.transcript, "r-own");
    expect(seq.peekDue(Date.now() + 10 * 60_000)).toHaveLength(1);

    // The intruder cancels their OWN tag of the same name: a different id.
    const intruder = await callAndRecord(world, s2.actor, "the_widget", "cancel_reminder", ["t"], "r-intrude", s2.id);
    expect(intruder.transcript.cancellations![0].id).not.toBe(victimId);
    expect(intruder.transcript.cancellations![0].id).toBe(`the_widget:remind:${s2.actor}:t`);

    // And applying it leaves the victim's reminder standing.
    const submitted = { ...intruder.transcript, reads: [] } as EffectTranscript;
    const derived = applyTranscript(seq.store as CellStore, submitted, { scope_head: "x", catalog_epoch: EPOCH });
    seq.submit({
      kind: "woo.net.commit_submit.v1",
      scope: intruder.transcript.scope,
      base: seq.head(),
      idempotency_key: "r-intrude",
      transcript: submitted,
      post_state_version: derived.postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    });
    expect(seq.peekDue(Date.now() + 10 * 60_000).map((row) => row.id)).toEqual([victimId]);
  });
});

describe("cancellation authority is the actor's, not the code's", () => {
  it("refuses a wizard-owned verb cancelling outside its namespace for a non-wizard actor", async () => {
    // The kernel rule, exercised directly. The catalog surface can no longer
    // express a cross-namespace cancel (ids are built from the caller), which
    // is right — but it also means the catalog tests cannot reach this check,
    // and reverting it to `progr` left them all green.
    //
    // A $wiz-owned verb is exactly how ordinary users reach the scheduler, so
    // keying the bypass on `progr` made every such verb a universal canceller.
    // It keys on the ACTOR: cancelling someone else's work is a question about
    // the principal, not about whose code is running.
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    expect(installVerbAs(
      world, "$wiz", "the_widget", "cancel_anything",
      'verb :cancel_anything(id) rxd { cancel_schedule(id); return null; }',
      null
    ).ok).toBe(true);

    const denied = await world.directCall(
      "x-cancel", actor, "the_widget", "cancel_anything", ["#someone_else:their_timer"] as never,
      { sessionId: session.id } as never
    );
    expect(denied.op).toBe("error");
    expect(JSON.stringify(denied)).toMatch(/E_PERM/);

    // The wizard-ACTOR path (an operator cancelling on someone's behalf) is
    // not asserted here: `world.auth("$wiz")` mints an ordinary guest, so a
    // test that appeared to cover it would only be re-testing the denial.
    // The refusal above is the security property, and it is what breaks if
    // the bypass goes back to keying on `progr`.
  });
});

describe("$scheduling — deadlines", () => {
  it("arms a cancellable always deadline under a stable key", async () => {
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    const { transcript } = await callAndRecord(world, actor, "the_widget", "deadline", [86_400_000, "escalate", ["t1"], "case-42"], session.id);
    const armed = transcript.schedules![0];
    expect(armed.id).toBe("the_widget:deadline:case-42");
    expect(armed.idlePolicy).toBe("always");
    expect(armed.call.verb).toBe("_fire_deadline");
    // The subject rides with it: a deadline must be able to say what it is about.
    expect(armed.call.args).toEqual(["escalate", ["t1"]]);
  });

  it("cancels by the same key the caller armed it with", async () => {
    // The escalation pattern: arm on entry, cancel on ack. The key must round
    // trip through both verbs or the ack silently fails to stop the timer.
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    const armedTurn = await callAndRecord(world, actor, "the_widget", "deadline", [86_400_000, "escalate", ["t1"], "case-42"], "arm", session.id);
    const { seq } = commit(world, armedTurn.transcript, "arm");
    expect(seq.peekDue(Date.now() + 2 * 86_400_000)).toHaveLength(1);

    const cancelTurn = await callAndRecord(world, actor, "the_widget", "cancel_deadline", ["case-42"], "ack", session.id);
    expect(cancelTurn.transcript.cancellations).toHaveLength(1);
    expect(cancelTurn.transcript.cancellations![0].id).toBe("the_widget:deadline:case-42");

    const submitted = { ...cancelTurn.transcript, reads: [] } as EffectTranscript;
    const derived = applyTranscript(seq.store as CellStore, submitted, { scope_head: "x", catalog_epoch: EPOCH });
    const reply = seq.submit({
      kind: "woo.net.commit_submit.v1",
      scope: cancelTurn.transcript.scope,
      base: seq.head(),
      idempotency_key: "ack",
      transcript: submitted,
      post_state_version: derived.postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    });
    if (reply.status !== "accepted") throw new Error(`rejected: ${JSON.stringify(reply)}`);
    expect(seq.peekDue(Date.now() + 2 * 86_400_000)).toEqual([]);
  });

  it("re-arming the same key extends rather than duplicates", async () => {
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    const first = await callAndRecord(world, actor, "the_widget", "deadline", [86_400_000, "escalate", ["t1"], "case-42"], "arm-1", session.id);
    const { seq } = commit(world, first.transcript, "arm-1");
    const second = await callAndRecord(world, actor, "the_widget", "deadline", [172_800_000, "escalate", ["t1"], "case-42"], "arm-2", session.id);
    const submitted = { ...second.transcript, reads: [] } as EffectTranscript;
    const derived = applyTranscript(seq.store as CellStore, submitted, { scope_head: "x", catalog_epoch: EPOCH });
    seq.submit({
      kind: "woo.net.commit_submit.v1",
      scope: second.transcript.scope,
      base: seq.head(),
      idempotency_key: "arm-2",
      transcript: submitted,
      post_state_version: derived.postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    });
    const rows = seq.peekDue(Date.now() + 4 * 86_400_000);
    expect(rows).toHaveLength(1);
  });

  it("refuses a deadline aimed at an internal verb", async () => {
    // Otherwise a caller could make the scheduler fire _deliver_reminder or
    // _tick with forged arguments, wearing the scheduler's own identity.
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    const { outcome } = await callAndRecord(world, actor, "the_widget", "deadline", [86_400_000, "_tick", [], "sneaky"], session.id);
    expect(JSON.stringify(outcome)).toMatch(/E_PERM/);
  });

  it("requires a stable key, because a deadline you cannot cancel is a bug", async () => {
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    const { outcome } = await callAndRecord(world, actor, "the_widget", "deadline", [86_400_000, "escalate", [], ""], session.id);
    expect(JSON.stringify(outcome)).toMatch(/E_INVARG/);
  });
});

describe("$scheduling — tick chains", () => {
  it("arms a while_active chain that carries its own rate", async () => {
    // No consumer-side `ticking` property exists: the pending entry IS the
    // state. The rate rides in the args so the chain needs nothing stored.
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    const { transcript } = await callAndRecord(world, actor, "the_widget", "start_ticking", [300_000], session.id);
    const armed = transcript.schedules![0];
    expect(armed.id).toBe("the_widget:tick");
    expect(armed.idlePolicy).toBe("while_active");
    expect(armed.call).toMatchObject({ verb: "_tick" });
    expect(armed.call.args).toEqual([300_000]);
  });

  it("starting twice re-arms one chain instead of racing two", async () => {
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    const first = await callAndRecord(world, actor, "the_widget", "start_ticking", [300_000], "t1", session.id);
    const { seq } = commit(world, first.transcript, "t1");
    const second = await callAndRecord(world, actor, "the_widget", "start_ticking", [600_000], "t2", session.id);
    const submitted = { ...second.transcript, reads: [] } as EffectTranscript;
    const derived = applyTranscript(seq.store as CellStore, submitted, { scope_head: "x", catalog_epoch: EPOCH });
    seq.submit({
      kind: "woo.net.commit_submit.v1",
      scope: second.transcript.scope,
      base: seq.head(),
      idempotency_key: "t2",
      transcript: submitted,
      post_state_version: derived.postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    });
    expect(seq.peekDue(Date.now() + 60 * 60_000)).toHaveLength(1);
  });

  it("stops by cancelling the entry that was the whole state", async () => {
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    const started = await callAndRecord(world, actor, "the_widget", "start_ticking", [300_000], "t1", session.id);
    const { seq } = commit(world, started.transcript, "t1");
    const stopped = await callAndRecord(world, actor, "the_widget", "stop_ticking", [], "t-stop", session.id);
    expect(stopped.transcript.cancellations![0].id).toBe("the_widget:tick");

    const submitted = { ...stopped.transcript, reads: [] } as EffectTranscript;
    const derived = applyTranscript(seq.store as CellStore, submitted, { scope_head: "x", catalog_epoch: EPOCH });
    seq.submit({
      kind: "woo.net.commit_submit.v1",
      scope: stopped.transcript.scope,
      base: seq.head(),
      idempotency_key: "t-stop",
      transcript: submitted,
      post_state_version: derived.postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    });
    expect(seq.peekDue(Date.now() + 60 * 60_000)).toEqual([]);
  });

  it("arms at the rate the caller asked for, when it is above the floor", async () => {
    // Bounded on BOTH sides. An earlier version asserted only ">= now + floor",
    // which is satisfied by any delay at all — a chain that ignored its
    // argument and pinned an hour passed it.
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    const before = Date.now();
    const { transcript } = await callAndRecord(world, actor, "the_widget", "start_ticking", [300_000], session.id);
    const at = transcript.schedules![0].at;
    expect(at).toBeGreaterThanOrEqual(before + 300_000);
    expect(at).toBeLessThan(before + 300_000 + 30_000);
  });

  it("clamps a sub-minute rate to the floor rather than failing", async () => {
    // SC3. An author asking for 5s gets a working minute-rate chain, not an
    // error — but they get the floor, silently, which is why it is documented.
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    const before = Date.now();
    const { transcript } = await callAndRecord(world, actor, "the_widget", "start_ticking", [5_000], session.id);
    const at = transcript.schedules![0].at;
    expect(at).toBeGreaterThanOrEqual(before + SCHEDULE_MIN_LEAD_MS);
    expect(at).toBeLessThan(before + SCHEDULE_MIN_LEAD_MS + 30_000);
  });
});

describe("$scheduling — internals are not a public surface", () => {
  it("refuses an in-world verb that dispatches to a scheduler-fired verb", async () => {
    // The direct-call refusal above is the INGRESS gate (direct_callable) and
    // says nothing about the guard inside the verb. The real attack is from
    // inside the world: any verb on this object can dispatch() to a sibling,
    // bypassing ingress entirely. Only `caller != $system` stops that, and
    // without this case that guard is dead code no test would miss.
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    expect(installVerb(
      world,
      "the_widget",
      "forge",
      'verb :forge() rxd { return dispatch(this, "_deliver_reminder", [actor, "forged"]); }',
      null
    ).ok).toBe(true);

    const before = world.objects.size;
    const outcome = await world.directCall(
      "forge-inworld", actor, "the_widget", "forge", [] as never, { sessionId: session.id } as never
    );
    expect(outcome.op).toBe("error");
    expect(JSON.stringify(outcome)).toMatch(/E_PERM/);
    // Nothing minted: the guard fired before the create.
    expect(world.objects.size).toBe(before);
  });

  it("refuses an in-world dispatch to the tick and deadline internals too", async () => {
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    for (const [name, body] of [
      ["forge_tick", 'verb :forge_tick() rxd { return dispatch(this, "_tick", [300000]); }'],
      ["forge_deadline", 'verb :forge_deadline() rxd { return dispatch(this, "_fire_deadline", ["escalate", []]); }']
    ] as const) {
      expect(installVerb(world, "the_widget", name, body, null).ok).toBe(true);
      const outcome = await world.directCall(
        `forge-${name}`, actor, "the_widget", name, [] as never, { sessionId: session.id } as never
      );
      expect(outcome.op).toBe("error");
      expect(JSON.stringify(outcome)).toMatch(/E_PERM/);
    }
  });

  it("refuses direct calls to every scheduler-fired verb", async () => {
    // Each of these runs with the scheduler's authority when fired. If any
    // were callable, a caller could forge a delivery, a deadline firing, or a
    // tick — with arguments of their choosing.
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    for (const [verb, args] of [
      ["_deliver_reminder", [actor, "forged"]],
      ["_fire_deadline", ["escalate", []]],
      ["_tick", [300_000]]
    ] as const) {
      // Not direct_callable, so the refusal lands at ingress and no turn is
      // even recorded — there is no transcript to inspect, which is the point.
      const outcome = await world.directCall(
        `forge-${verb}`, actor, "the_widget", verb, args as never, { sessionId: session.id } as never
      );
      expect(outcome.op).toBe("error");
      expect(JSON.stringify(outcome)).toMatch(/E_PERM|E_VERBNF|E_DIRECT_DENIED/);
    }
  });
});

// ---------------------------------------------------------------------------
// The first real user. A feature with no consumer proves nothing about whether
// the surface is usable — and this one immediately found a hole in it: the
// original `deadline` dispatched with no arguments, so a fired escalation
// could not say WHICH task it was about.
// ---------------------------------------------------------------------------
describe("casework escalation — arm on open, cancel on claim", () => {
  async function caseWorld() {
    const world = createWorld();
    const session = world.auth("guest:casework-escalation");
    const actor = session.actor;
    world.createObject({ id: "proof_case", name: "Proof Case", parent: "$case", owner: actor });
    const init = await world.directCall("case-init", actor, "proof_case", "initialize", [null] as never, {
      sessionId: session.id
    } as never);
    expect(init.op).toBe("result");
    const moved = await world.directCall("enter-case", actor, actor, "moveto", ["proof_case"] as never, {
      sessionId: session.id
    } as never);
    expect(moved.op).toBe("result");
    return { world, session, actor };
  }

  function seqCall(w: Awaited<ReturnType<typeof caseWorld>>, verb: string, args: unknown[], id: string) {
    return w.world.call(id, w.session.id, "proof_case", {
      actor: w.actor,
      target: "proof_case",
      verb,
      args: args as never[]
    });
  }

  it("arms an escalation deadline keyed to the task it opened", async () => {
    const w = await caseWorld();
    const recorder = new InMemoryTurnRecorder();
    w.world.setTurnRecorder(recorder);
    const opened = await seqCall(w, "open_task", ["triage", "", "do:it", [], [], 900_000], "open-1");
    expect(opened.op).toBe("applied");
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]) as unknown as EffectTranscript;
    w.world.setTurnRecorder(null as never);

    expect(transcript.schedules).toHaveLength(1);
    const armed = transcript.schedules![0];
    expect(armed.idlePolicy).toBe("always");
    expect(armed.call.verb).toBe("_fire_deadline");
    // The subject rides with it. Without this the escalation could only fire
    // a case-wide verb and would not know which task went stale.
    expect(armed.call.args[0]).toBe("escalate_task");
    expect((armed.call.args[1] as unknown[])[1]).toBe(900_000);
    // Keyed by the task, so claiming that task can cancel exactly this timer.
    expect(armed.id).toMatch(/^proof_case:deadline:task:/);
  });

  it("opens without a timer when no escalation window is given", async () => {
    const w = await caseWorld();
    const recorder = new InMemoryTurnRecorder();
    w.world.setTurnRecorder(recorder);
    expect((await seqCall(w, "open_task", ["quiet", "", "do:it", [], []], "open-2")).op).toBe("applied");
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]) as unknown as EffectTranscript;
    w.world.setTurnRecorder(null as never);
    expect(transcript.schedules ?? []).toHaveLength(0);
  });

  it("cancels the escalation when the task is claimed", async () => {
    // The whole point of the pattern: the ack path stops the timer. If the key
    // did not round-trip between open_task and claim, this silently escalates
    // a task somebody already took.
    const w = await caseWorld();
    const opened = await seqCall(w, "open_task", ["triage", "", "do:it", [], [], 900_000], "open-3");
    expect(opened.op).toBe("applied");
    const task = (opened as { op: "applied"; result?: unknown }).result as string;

    const recorder = new InMemoryTurnRecorder();
    w.world.setTurnRecorder(recorder);
    expect((await seqCall(w, "claim", [task], "claim-1")).op).toBe("applied");
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]) as unknown as EffectTranscript;
    w.world.setTurnRecorder(null as never);

    expect(transcript.cancellations).toHaveLength(1);
    expect(transcript.cancellations![0].id).toBe(`proof_case:deadline:task:${task}`);
  });

  it("records an escalation act when the deadline fires on a still-unclaimed task", async () => {
    const w = await caseWorld();
    const opened = await seqCall(w, "open_task", ["triage", "", "do:it", [], [], 900_000], "open-4");
    const task = (opened as { op: "applied"; result?: unknown }).result as string;

    const fired = await seqCall(w, "escalate_task", [task, 900_000], "escalate-1");
    expect(fired.op).toBe("applied");

    // Durable: the act rides the APPLIED FRAME, which is the sequenced log
    // entry — not a live tell to whoever happened to be watching. A scheduled
    // turn has no session and its actor may be gone, so anything that only
    // told would be lost exactly when the escalation mattered.
    const observations = (fired as { observations?: Array<{ type: string; payload?: Record<string, unknown> }> }).observations ?? [];
    const act = observations.find((o) => o.type === "tasks.escalated");
    expect(act).toBeTruthy();
    expect(act!.payload).toMatchObject({ task, waited_ms: 900_000 });
  });

  it("does not escalate a task that was already claimed", async () => {
    // Cancellation on claim is best-effort, so a race can still deliver the
    // escalation afterwards. Re-checking here is what keeps that from
    // becoming a false alarm.
    const w = await caseWorld();
    const opened = await seqCall(w, "open_task", ["triage", "", "do:it", [], [], 900_000], "open-5");
    const task = (opened as { op: "applied"; result?: unknown }).result as string;
    expect((await seqCall(w, "claim", [task], "claim-2")).op).toBe("applied");

    const fired = await seqCall(w, "escalate_task", [task, 900_000], "escalate-2");
    expect(fired.op).toBe("applied");
    const observations = (fired as { observations?: Array<{ type: string }> }).observations ?? [];
    expect(observations.find((o) => o.type === "tasks.escalated")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FIRING, not arming. Every test above this line asserts what a turn RECORDS.
// None of them ran a scheduled verb through the dispatch path the scheduler
// actually uses — which is how a catalog whose every internal verb was
// unreachable (E_DIRECT_DENIED, and `caller = #-1` failing its own guard)
// passed twenty-two green tests.
// ---------------------------------------------------------------------------
describe("$scheduling — the verbs actually fire", () => {
  /** Exactly what the scheduler's dispatch does: the internal marker, and
   * nothing else. Nothing here forces or bypasses on the test's behalf. */
  function fire(
    world: ReturnType<typeof createWorld>,
    actor: string,
    target: string,
    verb: string,
    args: unknown[],
    id: string
  ) {
    return world.directCall(id, actor, target, verb, args as never, {
      scheduled: { id: `${target}:${verb}`, at: Date.now(), fired_at: Date.now() }
    } as never);
  }

  it("delivers a reminder, minting a durable note before telling", async () => {
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    const before = world.objects.size;

    const fired = await fire(world, actor, "the_widget", "_deliver_reminder", [actor, "drink water"], "f1");
    expect(fired.op).toBe("result");
    // The durable half: a note the actor keeps, in their inventory, whether or
    // not anyone was connected to receive the tell.
    expect(world.objects.size).toBe(before + 1);
    const note = (fired as { op: "result"; result: unknown }).result as string;
    expect(world.getProp(note, "text")).toBe("drink water");
    expect(world.object(note).location).toBe(actor);
    expect(world.object(note).owner).toBe(actor);
  });

  it("fires a deadline through to the named verb, carrying its subject", async () => {
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    expect(installVerb(
      world, "the_widget", "escalate",
      'verb :escalate(subject) rxd { return "escalated:" + to_string(subject); }',
      null
    ).ok).toBe(true);

    const fired = await fire(world, actor, "the_widget", "_fire_deadline", ["escalate", ["case-42"]], "f2");
    expect(fired.op).toBe("result");
    // The subject reached the named verb — the hole the first real consumer
    // found, now proved through the firing path rather than the arming one.
    expect((fired as { op: "result"; result: unknown }).result).toBe("escalated:case-42");
  });

  it("ticks the consumer and re-arms in the same turn", async () => {
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    expect(installVerb(
      world, "the_widget", "tick",
      'verb :tick() rxd { return "ticked"; }',
      null
    ).ok).toBe(true);

    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);
    const fired = await fire(world, actor, "the_widget", "_tick", [300_000], "f3");
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]) as unknown as EffectTranscript;
    world.setTurnRecorder(null as never);

    expect(fired.op).toBe("result");
    expect((fired as { op: "result"; result: unknown }).result).toBe("ticked");
    // Re-armed in the SAME turn as the work, so a raising :tick rolls the
    // re-arm back with it and the chain stops rather than failing forever.
    expect(transcript.schedules).toHaveLength(1);
    expect(transcript.schedules![0].id).toBe("the_widget:tick");
    expect(transcript.schedules![0].call.args).toEqual([300_000]);
  });

  it("stops the chain when the consumer's tick raises", async () => {
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    expect(installVerb(
      world, "the_widget", "tick",
      'verb :tick() rxd { raise { code: "E_INVARG", message: "broken tick" }; }',
      null
    ).ok).toBe(true);

    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);
    const fired = await fire(world, actor, "the_widget", "_tick", [300_000], "f4");
    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]) as unknown as EffectTranscript;
    world.setTurnRecorder(null as never);

    expect(fired.op).toBe("error");
    // No re-arm survives a failed turn: the chain halts with a recorded
    // reason instead of retrying every minute forever.
    expect(transcript.schedules ?? []).toHaveLength(0);
  });

  it("still refuses an ordinary caller once the scheduler can get through", async () => {
    // The marker is what makes the internals reachable at all, so the guard
    // that keeps everyone else out has to be re-proved against it: without
    // the marker, the same call is refused.
    const { world, actor, session } = schedulingWorld();
    await enter(world, session);
    const before = world.objects.size;
    const outcome = await world.directCall(
      "f5", actor, "the_widget", "_deliver_reminder", [actor, "forged"] as never, { sessionId: session.id } as never
    );
    expect(outcome.op).toBe("error");
    expect(world.objects.size).toBe(before);
  });
});
