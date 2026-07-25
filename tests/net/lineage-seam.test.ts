// The lineage-mutation seam (world.mutateLineage) records existing-object
// changes to the single object_lineage cell — flags, parent, name — in the net
// transcript. Before the seam, a create recorded its lineage but a later change
// to any of those fields recorded nothing, so Net promote/demote, @chparent, and
// @rename silently dropped their lineage writes. These gates prove the recorder,
// the apply, and their parity with the native engine, plus the two guards the
// design depends on: net-only lineage metadata survives a flag flip, and an
// UNcontracted flag native still marks its turn incomplete.
import { describe, expect, it } from "vitest";
import { installVerb } from "../../src/core/authoring";
import { createWorld, createWorldFromSerialized } from "../../src/core/bootstrap";
import { effectTranscriptFromRecordedTurn } from "../../src/core/effect-transcript";
import { InMemoryTurnRecorder } from "../../src/core/turn-recorder";
import { cellsFromSerialized, storeCells, type ShadowTurnCall } from "../../src/net/bridge";
import { CellStore, cellKey, cellVersion, makeCell, type EpochStamp } from "../../src/net/cells";
import { planTurn } from "../../src/net/plan";
import type { ScopeClassifier } from "../../src/net/route";
import { ScopeSequencer } from "../../src/net/scope";
import { applyTranscript } from "../../src/net/transcript";

const CONCURRENCY_SCOPE = "seam-scope";
// Phase-2 fixed assignment: one shared scope owns everything (differential idiom).
const oneScope: ScopeClassifier = { scopeOf: () => CONCURRENCY_SCOPE, isShared: (s) => s === CONCURRENCY_SCOPE };

const STAMP: EpochStamp = { scope_head: "seam-head", catalog_epoch: "seam-epoch" };

/** An authority CellStore seeded from a serialized world's net cells — the
 *  apply target applyTranscript requires (role "authority"). cellsFromSerialized
 *  returns key-less cells; makeCell re-derives the key + content version. */
function authorityFrom(serialized: ReturnType<ReturnType<typeof createWorld>["exportWorld"]>): CellStore {
  const view = new CellStore("derived");
  for (const c of cellsFromSerialized(serialized)) {
    view.install(makeCell({ kind: c.kind, object: c.object, name: c.name, value: c.value, provenance: "derived", stamp: STAMP }));
  }
  return CellStore.scratchAuthorityFrom(view);
}

/** Net cell content-addresses of a serialized world, keyed the canonical way
 *  (cellsFromSerialized cells carry no `.key`, so rebuild it). */
function versionMap(serialized: ReturnType<ReturnType<typeof createWorld>["exportWorld"]>): Map<string, string> {
  return new Map(cellsFromSerialized(serialized).map((c) => [cellKey(c.kind, c.object, c.name), cellVersion(c.value)] as const));
}

/** The object_lineage cell content-address for one object in a serialized world:
 *  the canonical value the bridge would seed, hashed. Parity between a
 *  transcript apply and this native reference is the differential assertion. */
function lineageVersion(serialized: ReturnType<ReturnType<typeof createWorld>["exportWorld"]>, object: string): string {
  const cell = cellsFromSerialized(serialized).find((c) => c.kind === "object_lineage" && c.object === object);
  if (!cell) throw new Error(`no object_lineage cell for ${object}`);
  return cellVersion(cell.value);
}

/** Run one direct-call turn on a fresh twin of `genesis`, capturing its
 *  transcript. The twin isolates the native mutation (side A: its own exported
 *  reference) from the transcript apply (side B), so the two are compared, never
 *  the same object mutated twice. */
async function turnTranscript(
  genesis: ReturnType<ReturnType<typeof createWorld>["exportWorld"]>,
  actor: string,
  target: string,
  verb: string,
  args: unknown[]
) {
  const world = createWorldFromSerialized(structuredClone(genesis), { persist: false });
  const recorder = new InMemoryTurnRecorder();
  world.setTurnRecorder(recorder);
  const frame = await world.directCall(`seam-${verb}`, actor, target, verb, args as never, { sessionId: null });
  const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
  return { world, frame, transcript };
}

describe("lineage-mutation seam: recorder, apply, and parity", () => {
  // ---- Genesis: a human, its account (with programmer quota), and one owned,
  // not-yet-programmer agent. The human calls promote/demote/@rename on the
  // agent; all three objects are co-resident (single-host in-memory world).
  async function genesis() {
    const world = createWorld();
    const start = await world.beginSignup("seam@woo.dev", "password123");
    const verify = world.verifySignup(start.verification_token);
    const human = verify.actor as string;
    const account = world.propOrNull(human, "account") as string;
    world.setProp(account, "programmer_grant_quota", 10);
    return { world, human, account };
  }

  async function seededGenesis() {
    const g = await genesis();
    const prov = (await g.world.directCall("seam-prov", g.human, g.human, "create_agent", ["ProbeBot", "", false])) as unknown as {
      result: { actor_id: string };
    };
    const agent = prov.result.actor_id;
    return { serialized: g.world.exportWorld(), human: g.human, account: g.account, agent };
  }

  it("gate 1/4: promote applies the flag, features, features_version, and account count with post-state parity", async () => {
    const { serialized, human, agent, account } = await seededGenesis();

    // Side A: the native mutation, exported as the reference.
    const a = createWorldFromSerialized(structuredClone(serialized), { persist: false });
    const resA = (await a.directCall("ref-promote", human, human, "promote_agent_to_programmer", [agent])) as {
      op: string;
    };
    expect(resA.op).toBe("result");
    expect(a.object(agent).flags.programmer).toBe(true);
    const refWorld = a.exportWorld();

    // Side B: apply the recorded transcript to a seeded authority store.
    const { transcript } = await turnTranscript(serialized, human, human, "promote_agent_to_programmer", [agent]);
    expect(transcript.complete, `promote incomplete: ${transcript.incompleteReasons.join(", ")}`).toBe(true);
    // All four writes present, none dropped (gate 4: all-or-none is one turn).
    // Transcript cell kinds ("lifecycle"/"prop") differ from store CellKinds;
    // match on kind+object+name directly.
    const hasWrite = (kind: string, object: string, name?: string): boolean =>
      transcript.writes.some((w) => w.cell.kind === kind && w.cell.object === object && (name === undefined || (w.cell as { name?: string }).name === name));
    expect(hasWrite("lifecycle", agent), "lifecycle (flag) write").toBe(true);
    expect(hasWrite("prop", agent, "features"), "features write").toBe(true);
    expect(hasWrite("prop", agent, "features_version"), "features_version write").toBe(true);
    expect(hasWrite("prop", account, "programmer_agent_count"), "account count write").toBe(true);
    // The seam records a READ of the prior lineage version — the CAS basis that
    // makes a concurrent lineage change reject the stale plan (gate 2).
    expect(transcript.reads.some((r) => r.cell.kind === "lifecycle" && r.cell.object === agent), "lineage read recorded").toBe(true);

    const applied = applyTranscript(authorityFrom(serialized), transcript, STAMP);
    // Post-state parity: the applied object_lineage cell content-addresses
    // exactly the way a native mutation's fresh export would.
    expect(applied.post.get(cellKey("object_lineage", agent))?.version).toBe(lineageVersion(refWorld, agent));
    // And the property cells match the native reference too.
    const refCells = versionMap(refWorld);
    for (const name of ["features", "features_version"]) {
      const key = cellKey("property_cell", agent, name);
      expect(applied.post.get(key)?.version, `${name} parity`).toBe(refCells.get(key));
    }
    expect(applied.post.get(cellKey("property_cell", account, "programmer_agent_count"))?.version).toBe(
      refCells.get(cellKey("property_cell", account, "programmer_agent_count"))
    );
  });

  it("gate 6: @rename records and applies the lineage name change with parity", async () => {
    const { serialized, human, agent } = await seededGenesis();
    // A tiny authored rename verb on the agent's class surface is overkill;
    // set_object_name is the core rename primitive. Drive it through a verb the
    // agent's owner can call: install a rename verb on the agent itself.
    const base = createWorldFromSerialized(structuredClone(serialized), { persist: false });
    const installed = installVerb(base, agent, "relabel", `verb :relabel(name) rxd { set_object_name(this, name); return this.name; }`, null);
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    const withVerb = base.exportWorld();

    // Side A reference.
    const a = createWorldFromSerialized(structuredClone(withVerb), { persist: false });
    await a.directCall("ref-rename", human, agent, "relabel", ["Renamed"]);
    expect(a.object(agent).name).toBe("Renamed");
    const refWorld = a.exportWorld();

    // Side B transcript apply.
    const { transcript } = await turnTranscript(withVerb, human, agent, "relabel", ["Renamed"]);
    expect(transcript.complete, `rename incomplete: ${transcript.incompleteReasons.join(", ")}`).toBe(true);
    const written = new Set(transcript.writes.map((w) => w.cell.kind));
    expect(written, "rename must record the lineage (name) write, not only the property write").toContain("lifecycle");
    const applied = applyTranscript(authorityFrom(withVerb), transcript, STAMP);
    expect(applied.post.get(cellKey("object_lineage", agent))?.version).toBe(lineageVersion(refWorld, agent));
  });

  it("gate 6: @chparent records and applies the lineage parent change with parity", async () => {
    const { serialized, human, agent } = await seededGenesis();
    // Two sibling classes the agent can be reparented between. The owner drives
    // the reparent through an authored verb calling the chparent builtin.
    const base = createWorldFromSerialized(structuredClone(serialized), { persist: false });
    base.object(human).flags.programmer = true; // chparent is a programmer builtin
    base.createObject({ id: "seam_kindA", name: "KindA", parent: "$thing", owner: human });
    base.createObject({ id: "seam_kindB", name: "KindB", parent: "$thing", owner: human });
    base.createObject({ id: "seam_item", name: "Item", parent: "seam_kindA", owner: human });
    const installed = installVerb(base, "seam_item", "rekind", `verb :rekind(cls) rxd { chparent(this, cls); return 1; }`, null);
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    const withVerb = base.exportWorld();

    const a = createWorldFromSerialized(structuredClone(withVerb), { persist: false });
    await a.directCall("ref-chparent", human, "seam_item", "rekind", ["seam_kindB"]);
    expect(a.object("seam_item").parent).toBe("seam_kindB");
    const refWorld = a.exportWorld();

    const { transcript } = await turnTranscript(withVerb, human, "seam_item", "rekind", ["seam_kindB"]);
    expect(transcript.complete, `chparent incomplete: ${transcript.incompleteReasons.join(", ")}`).toBe(true);
    const lifecycleWrite = transcript.writes.find((w) => w.cell.kind === "lifecycle" && w.cell.object === "seam_item");
    expect(lifecycleWrite, "chparent must record the lineage (parent) write").toBeDefined();
    const applied = applyTranscript(authorityFrom(withVerb), transcript, STAMP);
    expect(applied.post.get(cellKey("object_lineage", "seam_item"))?.version).toBe(lineageVersion(refWorld, "seam_item"));
  });

  it("gate 3: a flag flip preserves net-only lineage metadata (eventSchemas, epoch_immutable_definition)", async () => {
    const { serialized, human, agent } = await seededGenesis();
    const { transcript } = await turnTranscript(serialized, human, human, "promote_agent_to_programmer", [agent]);
    expect(transcript.complete).toBe(true);

    // Seed the authority store, then decorate the agent's lineage cell with the
    // two net-only metadata fields the apply must preserve across a flag flip.
    const authority = authorityFrom(serialized);
    const key = cellKey("object_lineage", agent);
    const prior = authority.get(key)!.value as Record<string, unknown>;
    const decorated = {
      ...prior,
      eventSchemas: { poked: { count: "int" } },
      epoch_immutable_definition: true
    };
    authority.commit(makeCell({ kind: "object_lineage", object: agent, value: decorated, provenance: "authoritative", stamp: STAMP }));

    const applied = applyTranscript(authority, transcript, STAMP);
    const result = applied.post.get(key)!.value as Record<string, unknown>;
    // The flag flipped...
    expect((result.flags as Record<string, boolean>).programmer).toBe(true);
    // ...and the untouched net-only metadata survived (not clobbered by the
    // semantic-fields-only replacement).
    expect(result.eventSchemas).toEqual({ poked: { count: "int" } });
    expect(result.epoch_immutable_definition).toBe(true);
  });

  it("gate 7: an UNcontracted flag native (set_object_flags) still marks the turn incomplete", async () => {
    // set_object_flags is the deliberate wizard-only flag primitive. It routes
    // its write through the seam (so the write IS recorded), but it is NOT a
    // tracked native contract — so its dispatch must still mark the transcript
    // incomplete, and a Net turn invoking it rejects. Adding it to CONTRACTS
    // would make a raw flag-bypass silently commit over Net; this guards that.
    const g = await genesis();
    // A wizard actor to invoke the $system native.
    g.world.object(g.human).flags.wizard = true;
    const prov = (await g.world.directCall("seam-prov", g.human, g.human, "create_agent", ["FlagBot", "", false])) as unknown as {
      result: { actor_id: string };
    };
    const agent = prov.result.actor_id;
    const serialized = g.world.exportWorld();

    const { transcript } = await turnTranscript(serialized, g.human, "$system", "set_object_flags", [agent, { programmer: true }]);
    // The flag write IS recorded (the seam ran)...
    expect(transcript.writes.some((w) => w.cell.kind === "lifecycle" && w.cell.object === agent)).toBe(true);
    // ...but the turn is INCOMPLETE: the native is uncontracted.
    expect(transcript.complete).toBe(false);
    expect(transcript.incompleteReasons.some((r) => r.includes("set_object_flags"))).toBe(true);
  });

  it("gate 2: two concurrent lineage mutations serialize — the stale one rejects, replans, and both survive", async () => {
    const { serialized, human, agent } = await seededGenesis();
    // Install a rename verb on the agent so turn B is an INDEPENDENT lineage
    // (name) mutation racing turn A's promote (flag) mutation on the same cell.
    const base = createWorldFromSerialized(structuredClone(serialized), { persist: false });
    const installed = installVerb(base, agent, "relabel", `verb :relabel(name) rxd { set_object_name(this, name); return this.name; }`, null);
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    const genesisWorld = base.exportWorld();

    const seq = new ScopeSequencer(CONCURRENCY_SCOPE, "seam-epoch");
    seq.seed(cellsFromSerialized(genesisWorld));
    const view = new CellStore("derived");
    for (const cell of storeCells(seq.store)) view.install(cell);
    const refreshView = (touched: string[]): void => {
      for (const key of touched) {
        const cell = seq.store.get(key);
        if (cell) view.install(cell);
        else view.delete(key);
      }
    };

    const planAt = (id: string, target: string, verb: string, args: unknown[]) =>
      planTurn({
        call: { kind: "woo.turn_call.shadow.v1", id, route: "direct", scope: CONCURRENCY_SCOPE, session: null, actor: human, target, verb, args } as ShadowTurnCall,
        view,
        planningScope: CONCURRENCY_SCOPE,
        classifier: oneScope,
        base: seq.head(),
        idempotencyKey: id,
        stamp: seq.stamp()
      });

    // Both plan against the SAME base head (concurrent): A promotes, B renames.
    const planA = await planAt("concurrent-promote", human, "promote_agent_to_programmer", [agent]);
    const planB = await planAt("concurrent-rename", agent, "relabel", ["Renamed"]);

    // B commits first, advancing the head and bumping the agent lineage version.
    const replyB = seq.submit(planB.submit);
    expect(replyB.status, JSON.stringify(replyB)).toBe("accepted");
    if (replyB.status !== "accepted") return;
    refreshView(replyB.touched);

    // A's submit was planned at the now-stale head with a stale lineage read.
    // The scope rejects it — a concurrency guard fired (stale_head or the
    // lineage read-version CAS), never a silent double-apply.
    const staleReplyA = seq.submit(planA.submit);
    expect(staleReplyA.status).toBe("rejected");
    if (staleReplyA.status !== "rejected") return;
    expect(["stale_head", "read_version_mismatch"]).toContain(staleReplyA.reason);

    // Replan A against the refreshed view + current head: it now reads the
    // renamed agent, flips the flag on top, and converges.
    const replanA = await planAt("concurrent-promote-2", human, "promote_agent_to_programmer", [agent]);
    const replyA = seq.submit(replanA.submit);
    expect(replyA.status, JSON.stringify(replyA)).toBe("accepted");
    if (replyA.status !== "accepted") return;
    refreshView(replyA.touched);

    // Both mutations survive: the agent is renamed AND a programmer.
    const lineage = seq.store.get(cellKey("object_lineage", agent))?.value as { name?: string; flags?: Record<string, boolean> };
    expect(lineage?.name, "rename survived the concurrent promote").toBe("Renamed");
    expect(lineage?.flags?.programmer, "promote applied on top of the rename").toBe(true);
  });
});
