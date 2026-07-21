// Acts kernel proof (notes/2026-07-21-acts-projection-model.md).
//
// Part 1 — the two generic core read seams the kernel note names (§2.2, §2.3):
//   - event_schema(obj, type): declared shape via class-then-features
//     precedence, defensive copy, null when undeclared (gate 2).
//   - $space:replay() results include the persisted entry `ts` without
//     changing pagination (gate 2).
//
// Later parts (same file, added with the acts catalog): emission authority,
// fail-closed atomicity, rebuild invariant, board parity.
import { describe, expect, it } from "vitest";
import { installVerb } from "../src/core/authoring";
import { authedWorld, moveActorTo } from "./core-support";

describe("event_schema builtin (core seam 1)", () => {
  it("resolves through the class chain with feature fallback, in declared order", async () => {
    const { world, session, actor } = authedWorld();
    world.createObject({ id: "es_base", name: "es_base", parent: "$space", owner: "$wiz" });
    world.createObject({ id: "es_room", name: "es_room", parent: "es_base", owner: "$wiz" });
    world.createObject({ id: "es_feature_a", name: "es_feature_a", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "es_feature_b", name: "es_feature_b", parent: "$thing", owner: "$wiz" });

    // Chain declaration on the base class; feature declares the same type
    // with a different shape — the chain must win (verb-dispatch precedence).
    world.defineEventSchema("es_base", "proof.chained", { key: "str" });
    world.defineEventSchema("es_feature_a", "proof.chained", { wrong: "obj" });
    // Feature-only type: first feature in list order wins.
    world.defineEventSchema("es_feature_a", "proof.featured", { a: "int" });
    world.defineEventSchema("es_feature_b", "proof.featured", { b: "int" });
    world.setProp("es_room", "features", ["es_feature_a", "es_feature_b"]);

    expect(world.eventSchemaFor("es_room", "proof.chained")).toEqual({ key: "str" });
    expect(world.eventSchemaFor("es_room", "proof.featured")).toEqual({ a: "int" });
    expect(world.eventSchemaFor("es_room", "proof.absent")).toBeNull();

    // Defensive copy: mutating the returned shape must not touch the world.
    const copy = world.eventSchemaFor("es_room", "proof.chained")!;
    (copy as Record<string, unknown>).key = "tampered";
    expect(world.eventSchemaFor("es_room", "proof.chained")).toEqual({ key: "str" });

    // Same answers through the DSL builtin.
    expect(installVerb(world, actor, "es_probe", `verb :es_probe() rxd {
      return {
        chained: event_schema("es_room", "proof.chained"),
        featured: event_schema("es_room", "proof.featured"),
        absent: event_schema("es_room", "proof.absent")
      };
    }`, null).ok).toBe(true);
    const probed = await world.directCall("es-probe", actor, actor, "es_probe", [], { sessionId: session.id });
    expect(probed.op).toBe("result");
    if (probed.op !== "result") return;
    expect(probed.result).toEqual({
      chained: { key: "str" },
      featured: { a: "int" },
      absent: null
    });
  });
});

describe("replay ts (core seam 2)", () => {
  it("includes the persisted entry timestamp without changing pagination", async () => {
    const { world, session, actor } = authedWorld();
    await moveActorTo(world, actor, "the_chatroom", { sessionId: session.id });

    const before = Date.now();
    const applied = await world.call("acts-seam-say", session.id, "the_chatroom", {
      actor,
      target: "the_chatroom",
      verb: "say",
      args: ["seam two"]
    });
    expect(applied.op).toBe("applied");
    if (applied.op !== "applied") return;

    const replayed = await world.directCall("acts-seam-replay", actor, "the_chatroom", "replay", [applied.seq, 1], { sessionId: session.id });
    expect(replayed.op).toBe("result");
    if (replayed.op !== "result") return;
    const entries = replayed.result as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0].seq).toBe(applied.seq);
    expect(typeof entries[0].ts).toBe("number");
    expect(entries[0].ts as number).toBeGreaterThanOrEqual(before);
    expect(entries[0].message).toBeDefined();
    expect(entries[0].observations).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the kernel proof: emission authority, fail-closed atomicity,
// the board lifecycle, journal-as-log-read, and the rebuild invariant.
// ---------------------------------------------------------------------------

async function proofCase(rowCap: number | null = null) {
  const { world, session, actor } = authedWorld();
  world.createObject({ id: "proof_case", name: "Proof Case", parent: "$case", owner: actor });
  const init = await world.directCall("case-init", actor, "proof_case", "initialize", [rowCap], { sessionId: session.id });
  expect(init.op).toBe("result");
  const board = (init as { op: "result"; result: unknown }).result as string;
  await moveActorTo(world, actor, "proof_case", { sessionId: session.id });
  return { world, session, actor, board };
}

type SeqWorld = Awaited<ReturnType<typeof proofCase>>;
async function seqCall(w: SeqWorld, verb: string, args: unknown[], id: string) {
  return w.world.call(id, w.session.id, "proof_case", { actor: w.actor, target: "proof_case", verb, args: args as never[] });
}
async function boardView(w: SeqWorld) {
  const r = await w.world.directCall(`bv-${Math.random()}`, w.actor, "proof_case", "board", [{}], { sessionId: w.session.id });
  expect(r.op).toBe("result");
  return (r as unknown as { op: "result"; result: { page: Array<Record<string, unknown>>; at_seq: number } }).result;
}

describe("acts kernel proof: lifecycle on the board", () => {
  it("open/claim/pass/close folds rows; joins come from view time; journal is the log", async () => {
    const w = await proofCase();
    const opened = await seqCall(w, "open_task", ["triage the alert", "look into it", "do:it", ["p1"], ["investigate", "write-up"]], "t-open");
    expect(opened.op).toBe("applied");
    const task = (opened as { op: "applied"; result: unknown }).result as string;

    let view = await boardView(w);
    expect(view.page).toHaveLength(1);
    expect(view.page[0]).toMatchObject({
      task, name: "triage the alert", kind: "do:it", phase: "active",
      claimed: false, holder: null, cursor: "investigate",
      obligations_met: 0, obligations_total: 2
    });
    expect(typeof view.page[0].opened_seq).toBe("number");

    expect((await seqCall(w, "claim", [task], "t-claim")).op).toBe("applied");
    view = await boardView(w);
    expect(view.page[0]).toMatchObject({ claimed: true, holder: w.actor, phase: "active" });

    expect((await seqCall(w, "pass_obligation", [task, "investigate"], "t-pass")).op).toBe("applied");
    view = await boardView(w);
    expect(view.page[0]).toMatchObject({ cursor: "write-up", obligations_met: 1 });

    expect((await seqCall(w, "close_task", [task, "done"], "t-close")).op).toBe("applied");
    view = await boardView(w);
    expect(view.page[0]).toMatchObject({ phase: "closed", claimed: false, holder: null });

    // Journal = paged log read of act observations, each with envelope seq/ts.
    const j = await w.world.directCall("t-journal", w.actor, "proof_case", "journal", [1, 100], { sessionId: w.session.id });
    expect(j.op).toBe("result");
    const acts = (j as { op: "result"; result: Array<Record<string, unknown>> }).result;
    expect(acts.map((a) => a.type)).toEqual(["tasks.opened", "tasks.claimed", "tasks.passed", "tasks.closed"]);
    for (const a of acts) expect(typeof a.ts).toBe("number");
  });
});

describe("acts kernel proof: emission authority (gate 3)", () => {
  it("refuses direct, foreign-caller, unknown-type, and undeclared-key emission", async () => {
    const w = await proofCase();

    // Direct route: seq == -1, no log entry — refused.
    const direct = await w.world.directCall("t-direct-act", w.actor, "proof_case", "act",
      ["tasks.released", { task: "proof_case" }], { sessionId: w.session.id });
    expect(direct.op).toBe("error");

    // A refusal reached through a sequenced call remains as a failed entry
    // containing only its error outcome (kernel gate 3): the frame reports
    // applied, the entry records applied_ok:false, and the only observation
    // is the $error — no act observation, no row.
    function expectRefusedTurn(frame: unknown, code: string) {
      const f = frame as { op: string; observations?: Array<Record<string, unknown>> };
      expect(f.op).toBe("applied");
      const obs = f.observations ?? [];
      expect(obs).toHaveLength(1);
      expect(obs[0]).toMatchObject({ type: "$error", code });
    }

    // Sequenced call targeting :act — caller is the actor, not the room.
    const forged = await seqCall(w, "act", ["tasks.released", { task: "proof_case" }], "t-forge");
    expectRefusedTurn(forged, "E_PERM");

    // Unknown type and undeclared payload key, emitted from room verbs
    // (test-installed on the instance so caller == this holds).
    expect(installVerb(w.world, "proof_case", "emit_bogus",
      `verb :emit_bogus() rxd { return this:act("bogus.type", {}); }`, null).ok).toBe(true);
    expect(installVerb(w.world, "proof_case", "emit_badkey",
      `verb :emit_badkey() rxd { return this:act("tasks.released", { "task": this, "extra": 1 }); }`, null).ok).toBe(true);
    expectRefusedTurn(await seqCall(w, "emit_bogus", [], "t-bogus"), "E_INVARG");
    expectRefusedTurn(await seqCall(w, "emit_badkey", [], "t-badkey"), "E_INVARG");

    // Every refused entry is recorded applied_ok:false; none left a row.
    const failed = w.world.replay("proof_case", 1, 100).filter((e) => !e.applied_ok);
    expect(failed.length).toBe(3);
    const view = await boardView(w);
    expect(view.page).toHaveLength(0);
  });
});

describe("acts kernel proof: fail-closed atomicity (gate 4)", () => {
  it("a refusing fold aborts the whole turn including the artifact mint", async () => {
    const w = await proofCase(2);
    expect((await seqCall(w, "open_task", ["one", "", "k", [], []], "t-a")).op).toBe("applied");
    expect((await seqCall(w, "open_task", ["two", "", "k", [], []], "t-b")).op).toBe("applied");

    // Snapshot the case's physical contents before the refused turn: the
    // fail-closed claim is that the refused turn adds nothing — not the row,
    // not the minted $note artifact.
    const contentsBefore = w.world.contentsOf("proof_case");

    const refused = await seqCall(w, "open_task", ["three", "", "k", [], []], "t-c");
    expect(refused.op).toBe("applied");
    const robs = (refused as { op: "applied"; observations?: Array<Record<string, unknown>> }).observations ?? [];
    expect(robs).toHaveLength(1);
    expect(robs[0]).toMatchObject({ type: "$error", code: "E_QUOTA" });

    // The entry is recorded, failed, with only its error outcome (SL2: the
    // outer savepoint rolled back fold writes AND the domain verb's mint).
    const entries = w.world.replay("proof_case", 1, 100);
    const failedEntry = entries.find((e) => !e.applied_ok);
    expect(failedEntry).toBeDefined();

    const view = await boardView(w);
    expect(view.page).toHaveLength(2);
    expect(w.world.contentsOf("proof_case")).toEqual(contentsBefore);
    const journal = await w.world.directCall("t-j2", w.actor, "proof_case", "journal", [1, 100], { sessionId: w.session.id });
    expect((journal as { op: "result"; result: Array<Record<string, unknown>> }).result).toHaveLength(2);
  });
});

describe("acts kernel proof: rebuild invariant (gate 1)", () => {
  it("fold(recorded acts) reproduces the live rows exactly", async () => {
    const w = await proofCase();
    const opened = await seqCall(w, "open_task", ["rebuild me", "", "do:it", ["l"], ["a", "b"]], "r-open");
    const task = (opened as { op: "applied"; result: unknown }).result as string;
    await seqCall(w, "claim", [task], "r-claim");
    await seqCall(w, "pass_obligation", [task, "a"], "r-pass");
    await seqCall(w, "release", [task], "r-rel");

    // A fresh projection, seeded empty, folded from the recorded log only.
    w.world.createObject({ id: "proof_board2", name: "board2", parent: "$task_board", owner: w.actor, location: "proof_case" });
    const rebuilt = await w.world.directCall("r-rebuild", w.actor, "proof_board2", "rebuild_from", ["proof_case", 1], { sessionId: w.session.id });
    expect(rebuilt.op).toBe("result");

    const live = await w.world.directCall("r-v1", w.actor, "proof_case", "board", [{}], { sessionId: w.session.id });
    const copy = await w.world.directCall("r-v2", w.actor, "proof_board2", "view", [{}], { sessionId: w.session.id });
    expect(live.op).toBe("result");
    expect(copy.op).toBe("result");
    const liveResult = (live as { op: "result"; result: unknown }).result;
    const copyResult = (copy as { op: "result"; result: unknown }).result;
    expect(copyResult).toEqual(liveResult);
  });
});
