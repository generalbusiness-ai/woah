// The aged-world lane (coherence.md CO12.6, CO8) — Plan 002 Phase 3
// step 5. A world is built THROUGH history at catalog epoch cat-v1
// (real planned turns, head advanced, versions moved), then upgraded to
// cat-v2, then replayed through a gateway view still stamped cat-v1.
// The lane's claim: convergence after a catalog upgrade happens only
// via the NAMED reseed events —
//   1. the `stale_epoch` verdict (the CO8 E_STALE_EPOCH consumer signal
//      surfaced as a retryable CO4 step-2 rejection), and
//   2. the `dropStaleEpoch` reseed of the stamped copy (CO5 copy #2)
// — and via ZERO unnamed divergence: no other rejection reason, no
// thrown error, anywhere in the scenario. A never-aged control world
// then proves the replayed state is VALUE-identical to a world that was
// born at cat-v2 (the CO12.6 "reseeds appear as named CO6/CO8 events,
// never as failures" convergence check).
import { describe, expect, it } from "vitest";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized, storeCells } from "../../src/net/bridge";
import { CellStore } from "../../src/net/cells";
import { planTurn } from "../../src/net/plan";
import type { ScopeClassifier } from "../../src/net/route";
import { ScopeSequencer } from "../../src/net/scope";
import { InMemoryScopeStore } from "../../src/net/scope-store";
import type { CommitReply } from "../../src/net/scope";

const SCOPE = "aged_room";
const EPOCH_V1 = "cat-v1";
const EPOCH_V2 = "cat-v2";
const COUNTER_KEY = "property_cell:aged_box:counter";

// Fixed assignment: the one shared scope owns everything (the Phase-2
// harness shape; route.ts selection still runs for real).
const classifier: ScopeClassifier = {
  scopeOf: () => SCOPE,
  isShared: (scope) => scope === SCOPE
};

/** One genesis for the aged lane AND the never-aged control: bootstrap
 * world + a PURE read-modify-write counter verb (the plan.test.ts
 * shape). Deliberately no `create` in the verb: creates thread host
 * objectCounter state through every plan, and the control comparison
 * wants the two histories to differ ONLY in when the epoch bump
 * happened — a pure RMW verb keeps turn parity trivial. */
function genesis() {
  const world = createWorld();
  const session = world.auth("guest:aged-world");
  const actor = session.actor;
  world.createObject({ id: "aged_box", name: "Aged Box", parent: "$thing", owner: actor });
  world.defineProperty("aged_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  const installed = installVerb(
    world,
    "aged_box",
    "bump",
    `verb :bump() rxd {
      let before = this.counter;
      this.counter = before + 1;
      return this.counter;
    }`,
    null
  );
  expect(installed.ok).toBe(true);
  return { serialized: world.exportWorld(), actor, session: session.id };
}

/** One warm-loop turn, exactly as the gateway runs it: plan on the
 * derived view at the sequencer's current head/stamp, submit, and on
 * accept install the reply's touched cells back into the view (warm
 * cache-fill, CO7). Every reply is recorded into `replies` so the
 * zero-unnamed-divergence sweep at the end sees the whole scenario. */
async function bumpTurn(input: {
  seq: ScopeSequencer;
  view: CellStore;
  id: string;
  actor: string;
  session: string;
  replies: CommitReply[];
}): Promise<CommitReply> {
  const { seq, view } = input;
  const plan = await planTurn({
    call: {
      kind: "woo.turn_call.shadow.v1",
      id: input.id,
      route: "direct",
      scope: SCOPE,
      session: input.session,
      actor: input.actor,
      target: "aged_box",
      verb: "bump",
      args: []
    },
    view,
    planningScope: SCOPE,
    classifier,
    base: seq.head(),
    idempotencyKey: input.id,
    stamp: seq.stamp()
  });
  const reply = seq.submit(plan.submit);
  input.replies.push(reply);
  if (reply.status === "accepted") {
    for (const key of reply.touched) {
      const cell = seq.store.get(key);
      if (cell) view.install(cell);
      else view.delete(key);
    }
  }
  return reply;
}

describe("aged-world lane (CO12.6): upgrade converges via named CO8 reseeds only", () => {
  it("age at cat-v1, upgrade to cat-v2, replay through the stale view, match the never-aged control", async () => {
    const { serialized, actor, session } = genesis();
    const replies: CommitReply[] = [];
    // The named-reseed ledger the lane asserts on: exactly these two
    // events, and nothing else, carry the world across the upgrade.
    let staleEpochVerdicts = 0;
    let dropStaleEpochCalls = 0;

    // ---- 1. AGE the world at cat-v1: durable authority seeded from
    // genesis, a derived gateway view, and several REAL planned turns
    // through the warm loop so the aged state has history.
    const agedStore = new InMemoryScopeStore();
    const agedSeq = new ScopeSequencer(SCOPE, EPOCH_V1, { durable: agedStore });
    agedSeq.seed(cellsFromSerialized(serialized));
    const view = new CellStore("derived");
    for (const cell of storeCells(agedSeq.store)) view.install(cell);
    const genesisCounterVersion = view.get(COUNTER_KEY)?.version;

    const AGED_TURNS = 3;
    for (let i = 1; i <= AGED_TURNS; i += 1) {
      const reply = await bumpTurn({ seq: agedSeq, view, id: `aged-turn-${i}`, actor, session, replies });
      expect(reply.status, `aging turn ${i}`).toBe("accepted");
    }
    // Real history: the head advanced and the touched cell's version
    // moved on from genesis (the view followed via the warm loop).
    expect(agedSeq.head().seq).toBe(AGED_TURNS);
    expect(agedSeq.store.get(COUNTER_KEY)?.value).toMatchObject({ value: AGED_TURNS });
    expect(view.get(COUNTER_KEY)?.version).not.toBe(genesisCounterVersion);
    expect(view.get(COUNTER_KEY)?.stamp.catalog_epoch).toBe(EPOCH_V1);

    // ---- 2. UPGRADE to cat-v2. The step-1 hydration refusal IS the
    // migration boundary: a catalog upgrade over durable scope state is
    // an explicit reinstall/migration (the Phase-5 model), never a
    // silent adoption of old-epoch rows — so wiring the cat-v1 store to
    // a cat-v2 sequencer must throw, and that throw is a named
    // boundary, not divergence.
    // Phase 5 made the refusal a NAMED terminal (E_EPOCH_MISMATCH), so
    // operators see the CO6 code instead of a bare Error string.
    expect(() => new ScopeSequencer(SCOPE, EPOCH_V2, { durable: agedStore })).toThrow(/E_EPOCH_MISMATCH/);

    // The reinstall: a FRESH sequencer + fresh durable store at cat-v2,
    // seeded from the AGED world's exported cells (iterate the aged
    // store — storeCells walks keys()/get) as the migration input. seed
    // re-commits each {kind, object, name, value} at the new epoch's
    // stamp; the VALUES are the aged world's, the stamps are cat-v2.
    const v2Store = new InMemoryScopeStore();
    const v2Seq = new ScopeSequencer(SCOPE, EPOCH_V2, { durable: v2Store });
    v2Seq.seed(storeCells(agedSeq.store).map((cell) => ({
      kind: cell.kind,
      object: cell.object,
      ...(cell.name !== undefined ? { name: cell.name } : {}),
      value: cell.value
    })));
    expect(v2Seq.store.get(COUNTER_KEY)?.value).toMatchObject({ value: AGED_TURNS });
    expect(v2Seq.store.get(COUNTER_KEY)?.stamp.catalog_epoch).toBe(EPOCH_V2);

    // ---- 3. REPLAY through the aged gateway view — its cells are
    // still stamped cat-v1. The gateway stamps the submit from what its
    // copy attests (CO8: every consumer checks the stamp), so the
    // honest submit carries the view's OWN old epoch. Base is the new
    // sequencer's head so the epoch is the ONLY mismatch in the submit:
    // the rejection below is the named CO8 event, not a head race.
    const staleStamp = view.get(COUNTER_KEY)?.stamp;
    expect(staleStamp?.catalog_epoch).toBe(EPOCH_V1);
    const stalePlan = await planTurn({
      call: {
        kind: "woo.turn_call.shadow.v1",
        id: "replay-turn-stale",
        route: "direct",
        scope: SCOPE,
        session,
        actor,
        target: "aged_box",
        verb: "bump",
        args: []
      },
      view,
      planningScope: SCOPE,
      classifier,
      base: v2Seq.head(),
      idempotencyKey: "replay-turn",
      stamp: staleStamp as NonNullable<typeof staleStamp>
    });
    const rejected = v2Seq.submit(stalePlan.submit);
    replies.push(rejected);
    expect(rejected.status).toBe("rejected");
    if (rejected.status !== "rejected") return;
    // The named CO8 event: stale_epoch, retryable — reseed and retry,
    // never a terminal failure (CO12.6's exact demand).
    expect(rejected.reason).toBe("stale_epoch");
    expect(rejected.retryable).toBe(true);
    staleEpochVerdicts += 1;

    // Recover exactly as the gateway does (CO8 reseed): drop every cell
    // stamped with the old epoch, then reinstall from the new
    // authority. Every view cell was produced at cat-v1, so the drop
    // must clear real state.
    const dropped = view.dropStaleEpoch({ catalog_epoch: EPOCH_V2 });
    dropStaleEpochCalls += 1;
    expect(dropped).toBeGreaterThan(0);
    expect(view.has(COUNTER_KEY)).toBe(false);
    for (const cell of storeCells(v2Seq.store)) view.install(cell);
    expect(view.get(COUNTER_KEY)?.stamp.catalog_epoch).toBe(EPOCH_V2);

    // Retry the SAME turn (same idempotency key — the retryable
    // rejection was not recorded, CO2.5) against the reseeded view.
    const replayed = await bumpTurn({ seq: v2Seq, view, id: "replay-turn", actor, session, replies });
    expect(replayed.status).toBe("accepted");
    if (replayed.status !== "accepted") return;
    expect(v2Seq.store.get(COUNTER_KEY)?.value).toMatchObject({ value: AGED_TURNS + 1 });

    // ---- Zero unnamed divergence: across the WHOLE scenario, exactly
    // one stale_epoch verdict and one dropStaleEpoch reseed carried the
    // upgrade; every other submit was accepted, and nothing threw (a
    // throw would have failed the test — the one expected throw above
    // is the named hydration/migration boundary, asserted as such).
    expect(staleEpochVerdicts).toBe(1);
    expect(dropStaleEpochCalls).toBe(1);
    const rejections = replies.filter((reply) => reply.status === "rejected");
    expect(rejections).toHaveLength(1);
    expect(rejections[0].status === "rejected" && rejections[0].reason).toBe("stale_epoch");
    expect(replies.filter((reply) => reply.status === "accepted")).toHaveLength(AGED_TURNS + 1);

    // ---- 4. CONTROL: a never-aged world born at cat-v2 from the SAME
    // genesis, running the SAME turn sequence (all AGED_TURNS + the
    // post-upgrade turn — pure-RMW verb, so no create-counter parity to
    // thread). The replayed world's touched cells must match it by
    // VALUE: the comparison is value JSON, because stamps differ by
    // construction across the two histories (the control's cells are
    // stamped at its own heads). cellVersion covers the value only —
    // never the stamp — so version equality holds too, and we assert
    // it: content-address equality IS canonical value equality.
    const controlSeq = new ScopeSequencer(SCOPE, EPOCH_V2);
    controlSeq.seed(cellsFromSerialized(serialized));
    const controlView = new CellStore("derived");
    for (const cell of storeCells(controlSeq.store)) controlView.install(cell);
    const controlReplies: CommitReply[] = [];
    for (let i = 1; i <= AGED_TURNS + 1; i += 1) {
      const reply = await bumpTurn({ seq: controlSeq, view: controlView, id: `control-turn-${i}`, actor, session, replies: controlReplies });
      expect(reply.status, `control turn ${i}`).toBe("accepted");
    }

    // The post-upgrade turn's touched cells, replayed vs control.
    expect(replayed.touched.length).toBeGreaterThan(0);
    for (const key of replayed.touched) {
      const replayedCell = v2Seq.store.get(key);
      const controlCell = controlSeq.store.get(key);
      expect(controlCell, `${key}: touched by the replayed turn, absent from the control`).toBeDefined();
      expect(JSON.stringify(replayedCell?.value), `${key}: replayed value diverged from the never-aged control`)
        .toBe(JSON.stringify(controlCell?.value));
      expect(replayedCell?.version, `${key}: content address diverged (version covers value only)`)
        .toBe(controlCell?.version);
    }

    // Stronger convergence sweep: EVERY cell in the replayed authority
    // value-matches the control (same genesis + same logical turn
    // history ⇒ identical values, epoch bump notwithstanding). Session
    // cells are compared too — both stores seeded them from the one
    // genesis export and no turn wrote them.
    const diffs: string[] = [];
    for (const cell of storeCells(v2Seq.store)) {
      const control = controlSeq.store.get(cell.key);
      if (control === undefined) diffs.push(`${cell.key}: present after replay, absent from control`);
      else if (control.version !== cell.version) diffs.push(`${cell.key}: replayed=${cell.version} control=${control.version}`);
    }
    expect(diffs, `aged-world divergence vs never-aged control:\n${diffs.join("\n")}`).toEqual([]);
  });
});
