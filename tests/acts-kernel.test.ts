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
async function boardView(w: SeqWorld, opts: Record<string, unknown> = {}) {
  const r = await w.world.directCall(`bv-${Math.random()}`, w.actor, "proof_case", "board", [opts as never], { sessionId: w.session.id });
  expect(r.op).toBe("result");
  return (r as unknown as { op: "result"; result: { page: Array<Record<string, unknown>>; at_seq: number; cursor: unknown; has_more: boolean } }).result;
}
// rebuild_from is incremental (resumes past at_seq/rebuild_scan_seq),
// idempotent, and bounded to one replay page per call — drive it to done.
async function rebuildAll(w: SeqWorld, projection: string) {
  for (let i = 0; i < 50; i++) {
    const r = await w.world.directCall(`rb-${projection}-${i}`, w.actor, projection, "rebuild_from", ["proof_case", 100], { sessionId: w.session.id });
    expect(r.op).toBe("result");
    if ((r as unknown as { result: { done: boolean } }).result.done) return;
  }
  throw new Error("rebuild did not converge in 50 pages");
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
    // rebuild_from is incremental and bounded per call: loop until done.
    w.world.createObject({ id: "proof_board2", name: "board2", parent: "$task_board", owner: w.actor, location: "proof_case" });
    await rebuildAll(w, "proof_board2");

    const live = await w.world.directCall("r-v1", w.actor, "proof_case", "board", [{}], { sessionId: w.session.id });
    const copy = await w.world.directCall("r-v2", w.actor, "proof_board2", "view", [{}], { sessionId: w.session.id });
    expect(live.op).toBe("result");
    expect(copy.op).toBe("result");
    const liveResult = (live as { op: "result"; result: unknown }).result;
    const copyResult = (copy as { op: "result"; result: unknown }).result;
    expect(copyResult).toEqual(liveResult);
  });
});

// ---------------------------------------------------------------------------
// Part 3 — the second surface (§8.2 tier B3): the $kind_lanes projection folds
// the same recorded tasks.* acts into per-kind lane counts, attached alongside
// the board with zero edits to domain verbs, existing folds, or schemas.
// ---------------------------------------------------------------------------

async function lanesCase(id: string) {
  // A proof case with the board (from :initialize) plus a $kind_lanes
  // projection co-anchored in the case (same anchor cluster, §2.3).
  const w = await proofCase();
  w.world.createObject({ id, name: "lanes", parent: "$kind_lanes", owner: w.actor, location: "proof_case" });
  w.world.setProp("proof_case", "projections", [w.board, id]);
  return w;
}

async function lanesView(w: SeqWorld, id: string) {
  const r = await w.world.directCall(`klv-${Math.random()}`, w.actor, id, "view", [{}], { sessionId: w.session.id });
  expect(r.op).toBe("result");
  return (r as unknown as { op: "result"; result: { page: Array<Record<string, unknown>>; at_seq: number } }).result;
}

describe("acts kernel proof: second surface — kind lanes (tier B3)", () => {
  it("folds per-kind lane counts live, alongside the board", async () => {
    const w = await lanesCase("proof_lanes");

    // Two tasks of one kind, one of another.
    const a1 = await seqCall(w, "open_task", ["alpha one", "", "kind:a", [], []], "kl-a1");
    expect(a1.op).toBe("applied");
    const t1 = (a1 as { op: "applied"; result: unknown }).result as string;
    expect((await seqCall(w, "open_task", ["alpha two", "", "kind:a", [], []], "kl-a2")).op).toBe("applied");
    expect((await seqCall(w, "open_task", ["beta one", "", "kind:b", [], []], "kl-b1")).op).toBe("applied");

    let v = await lanesView(w, "proof_lanes");
    expect(v.page).toEqual([
      { kind: "kind:a", open: 2, claimed: 0, closed: 0 },
      { kind: "kind:b", open: 1, claimed: 0, closed: 0 }
    ]);
    expect(typeof v.at_seq).toBe("number");

    // Claim one: it leaves the open lane for the claimed lane.
    expect((await seqCall(w, "claim", [t1], "kl-claim")).op).toBe("applied");
    v = await lanesView(w, "proof_lanes");
    expect(v.page[0]).toEqual({ kind: "kind:a", open: 1, claimed: 1, closed: 0 });

    // Close the held one: claimed lane drains into closed.
    expect((await seqCall(w, "close_task", [t1, "done"], "kl-close")).op).toBe("applied");
    v = await lanesView(w, "proof_lanes");
    expect(v.page).toEqual([
      { kind: "kind:a", open: 1, claimed: 0, closed: 1 },
      { kind: "kind:b", open: 1, claimed: 0, closed: 0 }
    ]);

    // The board folded the same acts, untouched (zero edits to existing folds).
    const bv = await boardView(w);
    expect(bv.page).toHaveLength(3);
    expect(bv.at_seq).toBe(v.at_seq);
  });

  it("rebuild_from recorded acts equals the live lanes view (gate 1)", async () => {
    const w = await lanesCase("proof_lanes");

    // Lifecycle exercising every consumed transition, including release
    // (claimed back to open) and close-from-open.
    const a1 = await seqCall(w, "open_task", ["alpha one", "", "kind:a", [], []], "kr-a1");
    const t1 = (a1 as { op: "applied"; result: unknown }).result as string;
    const b1 = await seqCall(w, "open_task", ["beta one", "", "kind:b", [], []], "kr-b1");
    const t2 = (b1 as { op: "applied"; result: unknown }).result as string;
    await seqCall(w, "claim", [t1], "kr-claim1");
    await seqCall(w, "release", [t1], "kr-rel1");
    await seqCall(w, "claim", [t2], "kr-claim2");
    await seqCall(w, "close_task", [t2, "done"], "kr-close2");
    await seqCall(w, "close_task", [t1, "wontfix"], "kr-close1");

    // A fresh projection, seeded empty, folded from the recorded log only.
    w.world.createObject({ id: "proof_lanes2", name: "lanes2", parent: "$kind_lanes", owner: w.actor, location: "proof_case" });
    await rebuildAll(w, "proof_lanes2");

    const live = await lanesView(w, "proof_lanes");
    const copy = await lanesView(w, "proof_lanes2");
    expect(copy).toEqual(live);

    // Review finding 2 (2026-07-21): rebuild is idempotent — running it
    // again on the SAME projection must not double-fold anything.
    await rebuildAll(w, "proof_lanes2");
    expect(await lanesView(w, "proof_lanes2")).toEqual(live);

    // Review finding 3: terminal eviction — every task in this scenario
    // is closed, so the auxiliary index must be empty (and bounded).
    expect(w.world.getProp("proof_lanes", "task_states")).toEqual({});
    // Sanity: the shared view is the fully drained lifecycle, not empty.
    expect(live.page).toEqual([
      { kind: "kind:a", open: 0, claimed: 0, closed: 1 },
      { kind: "kind:b", open: 0, claimed: 0, closed: 1 }
    ]);
    // The rebuild invariant quantifies over ALL fold-written projection
    // state, not just the viewed rows: the auxiliary task_states index
    // must reproduce too (this is the auxiliary-state contract question
    // the trial surfaced, answered affirmatively).
    expect(w.world.getProp("proof_lanes2", "task_states")).toEqual(w.world.getProp("proof_lanes", "task_states"));
    expect(w.world.getProp("proof_lanes2", "rows")).toEqual(w.world.getProp("proof_lanes", "rows"));
  });
});

// ---------------------------------------------------------------------------
// Part 4 — 2026-07-21 review fixes: the domain state machine, exact str
// typing, and view paging with a continuation cursor.
// ---------------------------------------------------------------------------

describe("acts kernel review fixes: domain state machine (finding 1)", () => {
  it("refuses close→claim, double close, and post-close release", async () => {
    const w = await proofCase();
    const opened = await seqCall(w, "open_task", ["once", "", "k", [], []], "sm-open");
    const task = (opened as { op: "applied"; result: unknown }).result as string;
    expect((await seqCall(w, "close_task", [task, "done"], "sm-close")).op).toBe("applied");

    // close_task returned the task home physically — but the board row is
    // terminal, and every lifecycle verb validates against the row.
    for (const [verb, args, id] of [
      ["claim", [task], "sm-reclaim"],
      ["close_task", [task, "again"], "sm-reclose"],
      ["release", [task], "sm-rerelease"],
      ["pass_obligation", [task, "x"], "sm-repass"]
    ] as const) {
      const refused = await seqCall(w, verb, [...args], id);
      expect(refused.op).toBe("applied");
      const obs = (refused as { op: "applied"; observations?: Array<Record<string, unknown>> }).observations ?? [];
      expect(obs).toHaveLength(1);
      expect(obs[0]).toMatchObject({ type: "$error", code: "E_TRANSITION" });
    }

    // The board still shows exactly one closed, unclaimed task.
    const view = await boardView(w);
    expect(view.page).toHaveLength(1);
    expect(view.page[0]).toMatchObject({ phase: "closed", claimed: false, holder: null });
  });
});

describe("acts kernel review fixes: exact str typing (qualification)", () => {
  it("a live object ref is refused in a str payload field, fail-closed", async () => {
    const w = await proofCase();
    const opened = await seqCall(w, "open_task", ["typed", "", "k", [], []], "ty-open");
    const task = (opened as { op: "applied"; result: unknown }).result as string;

    // outcome_code is declared "str"; passing the task ref itself must
    // refuse (obj refs are strings at the VM level — exact typing keeps
    // an object out of a code/label field), and the refusal is fail-closed:
    // the task stays open and closable.
    const refused = await seqCall(w, "close_task", [task, task], "ty-close-ref");
    expect(refused.op).toBe("applied");
    const obs = (refused as { op: "applied"; observations?: Array<Record<string, unknown>> }).observations ?? [];
    expect(obs[0]).toMatchObject({ type: "$error", code: "E_INVARG" });
    let view = await boardView(w);
    expect(view.page[0]).toMatchObject({ phase: "active" });

    expect((await seqCall(w, "close_task", [task, "done"], "ty-close-ok")).op).toBe("applied");
    view = await boardView(w);
    expect(view.page[0]).toMatchObject({ phase: "closed" });
  });
});

describe("acts kernel review fixes: view continuation cursor (qualification)", () => {
  it("pages beyond the first page via opts.after", async () => {
    const w = await proofCase();
    const ids: string[] = [];
    for (const n of ["p1", "p2", "p3"]) {
      const opened = await seqCall(w, "open_task", [n, "", "k", [], []], `pg-${n}`);
      ids.push((opened as { op: "applied"; result: unknown }).result as string);
    }
    const first = await boardView(w, { limit: 2 });
    expect(first.page).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect(first.cursor).toBeTruthy();

    const second = await boardView(w, { limit: 2, after: first.cursor });
    expect(second.page).toHaveLength(1);
    expect(second.has_more).toBe(false);

    const seen = [...first.page, ...second.page].map((r) => r.task);
    expect(seen.sort()).toEqual([...ids].sort());
  });
});
