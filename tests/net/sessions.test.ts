// CO14 sessions — mint, authorize, transition folding (Plan 002 Phase 3.5
// item 4). Three layers under test:
//   1. the sessions library (sessionCellKey / validateSessionCell /
//      mintSessionSubmit / authorizeSessionSubmit) driving a real
//      ScopeSequencer wired the way the NetScopeDO shell wires it;
//   2. the CO2.3 composition: a foreign session validated via the
//      attestation the submit carries (session cells are just cells);
//   3. the plan-time fold (plan.ts): an ENGINE-planned sequenced turn with
//      a real world.auth session commits the session-cell write and the
//      presence relation rows from ONE turn (CO14's "no separate presence
//      write path" + CO13 presence).
import { describe, expect, it } from "vitest";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized, storeCells, type ShadowTurnCall } from "../../src/net/bridge";
import { CellStore, cellVersion } from "../../src/net/cells";
import { planTurn } from "../../src/net/plan";
import { relationKey } from "../../src/net/relations";
import type { ScopeClassifier } from "../../src/net/route";
import { ScopeSequencer, type CommitSubmit, type ScopeSequencerOptions } from "../../src/net/scope";
import {
  authorizeSessionSubmit,
  mintSessionSubmit,
  sessionCellKey,
  sessionWriter,
  validateSessionCell,
  type SessionCellValue
} from "../../src/net/sessions";
import { applyTranscript, type EffectTranscript } from "../../src/net/transcript";

const EPOCH = "cat-sessions-1";
const NOW = 1_000_000;

/** A sequencer wired the way NetScopeDO wires it: authorize =
 * authorizeSessionSubmit over the sequencer's own store (the ownership
 * witness is "holds the cell" — no rider residue in these fixtures). */
function sessionSequencer(scope: string, options: ScopeSequencerOptions = {}): ScopeSequencer {
  const seq: ScopeSequencer = new ScopeSequencer(scope, EPOCH, {
    ...options,
    authorize: (submit) =>
      authorizeSessionSubmit(submit, {
        ownsSession: (id) => seq.store.has(sessionCellKey(id)),
        readSession: (id) => seq.store.get(sessionCellKey(id)),
        now: () => NOW
      })
  });
  return seq;
}

/** Hand-built transcript around one prop write, optionally naming and/or
 * reading a session (the shapes authorize distinguishes). */
function transcriptWith(input: {
  scope: string;
  route?: "direct" | "sequenced";
  session?: string;
  reads?: EffectTranscript["reads"];
  writes?: EffectTranscript["writes"];
  hash: string;
}): EffectTranscript {
  return {
    kind: "woo.effect_transcript.shadow.v1",
    route: input.route ?? "sequenced",
    scope: input.scope,
    seq: 1,
    ...(input.session !== undefined ? { session: input.session } : {}),
    call: { actor: "#actor", target: "#thing", verb: "poke", args: [], body: undefined },
    reads: input.reads ?? [],
    writes:
      input.writes ??
      ([
        {
          cell: { kind: "prop", object: "#thing", name: "label" },
          value: "poked",
          op: "set",
          writer: sessionWriter("#actor", "poke")
        }
      ] as EffectTranscript["writes"]),
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: [],
    hash: input.hash
  };
}

/** Submit with planner-parity post-state derived over the sequencer's own
 * current store (applyTranscript clones; it never mutates). */
function submitFor(seq: ScopeSequencer, transcript: EffectTranscript, key: string, attestations?: CommitSubmit["attestations"]): CommitSubmit {
  const applied = applyTranscript(seq.store, transcript, { scope_head: "planner", catalog_epoch: EPOCH });
  return {
    kind: "woo.net.commit_submit.v1",
    scope: seq.scope,
    base: seq.head(),
    idempotency_key: key,
    transcript,
    post_state_version: applied.postStateVersion,
    stamp: { scope_head: "planner", catalog_epoch: EPOCH },
    ...(attestations !== undefined ? { attestations } : {})
  };
}

const thingCells = [
  { kind: "object_lineage" as const, object: "#thing", value: { parent: null, owner: "#actor", name: "thing", anchor: null, flags: {} } },
  { kind: "object_lineage" as const, object: "#actor", value: { parent: null, owner: "#actor", name: "actor", anchor: null, flags: {} } },
  { kind: "property_cell" as const, object: "#thing", name: "label", value: { value: "old" } }
];

const sessionRow = (over: Partial<SessionCellValue> = {}): SessionCellValue =>
  ({ id: "s1", actor: "#actor", started: NOW - 1000, expiresAt: NOW + 60_000, ...over }) as SessionCellValue;

describe("validateSessionCell", () => {
  it("names the four verdicts", () => {
    expect(validateSessionCell(undefined, NOW)).toBe("missing");
    expect(validateSessionCell({ value: null }, NOW)).toBe("missing");
    expect(validateSessionCell({ value: sessionRow() }, NOW, "#actor")).toBe("ok");
    expect(validateSessionCell({ value: sessionRow() }, NOW, "#other")).toBe("actor_mismatch");
    expect(validateSessionCell({ value: sessionRow({ expiresAt: NOW - 1 }) }, NOW, "#actor")).toBe("expired");
    // No expiresAt → never expires (SerializedSession optionality).
    const eternal = sessionRow();
    delete (eternal as Partial<SessionCellValue>).expiresAt;
    expect(validateSessionCell({ value: eternal }, NOW)).toBe("ok");
  });
});

describe("mintSessionSubmit → accepted at the cluster scope (CO14)", () => {
  it("mints the session cell as an ordinary commit, idempotently", () => {
    const seq = sessionSequencer("cluster:#actor");
    const { submit, value } = mintSessionSubmit({
      session: "s1",
      actor: "#actor",
      ttl_ms: 60_000,
      now: NOW,
      base: seq.head(),
      epoch: EPOCH,
      clusterScope: "cluster:#actor"
    });
    const reply = seq.submit(submit);
    expect(reply.status, JSON.stringify(reply)).toBe("accepted");
    const cell = seq.store.get(sessionCellKey("s1"));
    expect(cell?.value).toEqual(value);
    expect(cell?.provenance).toBe("authoritative");
    expect(validateSessionCell(cell, NOW, "#actor")).toBe("ok");
    // The session cell IS the bridge shape: expiry/creation ride the
    // SerializedSession field names.
    expect(value).toMatchObject({ id: "s1", actor: "#actor", started: NOW, expiresAt: NOW + 60_000 });
    // CO2.5: a replayed open returns the recorded reply (marked replayed
    // per B2), no double commit.
    expect(seq.submit(submit)).toEqual({ ...reply, replayed: true });
    expect(seq.head().seq).toBe(1);
  });

  it("refuses a mint whose written value binds another actor", () => {
    const seq = sessionSequencer("cluster:#actor");
    const { submit } = mintSessionSubmit({
      session: "s1",
      actor: "#actor",
      ttl_ms: 60_000,
      now: NOW,
      base: seq.head(),
      epoch: EPOCH,
      clusterScope: "cluster:#actor"
    });
    // Forge the written row's actor without touching the call.
    const write = submit.transcript.writes[0];
    write.value = { ...(write.value as SessionCellValue), actor: "#mallory" } as never;
    const reply = seq.submit(submit);
    expect(reply.status).toBe("rejected");
    if (reply.status !== "rejected") return;
    expect(reply.reason).toBe("unauthorized");
    expect(reply.retryable).toBe(false);
    expect(reply.detail).toMatchObject({ session: "s1", session_verdict: "actor_mismatch", source: "mint_write" });
  });

  it("authorizes a close from the live owned row after its replacement expiry has elapsed", () => {
    const seq = sessionSequencer("cluster:#actor");
    seq.seed([{ kind: "session", object: "s1", value: sessionRow({ activeScope: "room:r1" }) }]);
    // Model >250ms of real gateway -> scope latency: at authorization
    // time NOW, the proposed close row is already expired, while the
    // authority's current session remains live and actor-bound.
    const { submit, value } = mintSessionSubmit({
      session: "s1",
      actor: "#actor",
      ttl_ms: 0,
      now: NOW - 1_000,
      base: seq.head(),
      epoch: EPOCH,
      clusterScope: "cluster:#actor",
      closing: { priorActiveScope: "room:r1" }
    });
    expect(submit.transcript.sessionClose).toBe(true);
    expect(value.expiresAt).toBeLessThan(NOW);
    const reply = seq.submit(submit);
    expect(reply.status, JSON.stringify(reply)).toBe("accepted");
    expect(validateSessionCell(seq.store.get(sessionCellKey("s1")), NOW, "#actor")).toBe("expired");
  });

  it("refuses a sessionClose marker that attempts to refresh instead", () => {
    const seq = sessionSequencer("cluster:#actor");
    seq.seed([{ kind: "session", object: "s1", value: sessionRow({ activeScope: "room:r1" }) }]);
    const { submit } = mintSessionSubmit({
      session: "s1",
      actor: "#actor",
      ttl_ms: 0,
      now: NOW,
      base: seq.head(),
      epoch: EPOCH,
      clusterScope: "cluster:#actor",
      closing: { priorActiveScope: "room:r1" }
    });
    submit.transcript.writes[0].value = {
      ...(submit.transcript.writes[0].value as SessionCellValue),
      expiresAt: NOW + 60_000,
      activeScope: "room:r1"
    } as never;
    const reply = seq.submit(submit);
    expect(reply.status).toBe("rejected");
    if (reply.status !== "rejected") return;
    expect(reply.reason).toBe("unauthorized");
    expect(reply.detail).toMatchObject({ session: "s1", session_verdict: "close_invalid", source: "close_write" });
  });
});

describe("authorizeSessionSubmit at the owning scope (CO4 step 1)", () => {
  it("a sequenced submit carrying a valid owned session passes authorize", () => {
    const seq = sessionSequencer("cluster:#actor");
    seq.seed([...thingCells, { kind: "session", object: "s1", value: sessionRow() }]);
    const sessionCell = seq.store.get(sessionCellKey("s1"));
    const transcript = transcriptWith({
      scope: seq.scope,
      session: "s1",
      reads: [
        { cell: { kind: "session", object: "s1" }, version: sessionCell?.version, value: sessionCell?.value as never }
      ],
      hash: "sess-ok-1"
    });
    const reply = seq.submit(submitFor(seq, transcript, "sess-ok-1"));
    expect(reply.status, JSON.stringify(reply)).toBe("accepted");
  });

  it("expired, mismatched, and missing sessions reject unauthorized with the named detail", () => {
    // Expired (owned cell).
    const expired = sessionSequencer("cluster:#actor");
    expired.seed([...thingCells, { kind: "session", object: "s1", value: sessionRow({ expiresAt: NOW - 1 }) }]);
    const expiredReply = expired.submit(
      submitFor(expired, transcriptWith({ scope: expired.scope, session: "s1", hash: "sess-exp-1" }), "sess-exp-1")
    );
    expect(expiredReply.status).toBe("rejected");
    if (expiredReply.status === "rejected") {
      expect(expiredReply.reason).toBe("unauthorized");
      expect(expiredReply.retryable).toBe(false);
      expect(expiredReply.detail).toMatchObject({ session: "s1", session_verdict: "expired", source: "owned_cell" });
    }

    // Actor mismatch (owned cell bound to someone else).
    const mismatched = sessionSequencer("cluster:#actor");
    mismatched.seed([...thingCells, { kind: "session", object: "s1", value: sessionRow({ actor: "#other" }) }]);
    const mismatchReply = mismatched.submit(
      submitFor(mismatched, transcriptWith({ scope: mismatched.scope, session: "s1", hash: "sess-mis-1" }), "sess-mis-1")
    );
    expect(mismatchReply.status).toBe("rejected");
    if (mismatchReply.status === "rejected") {
      expect(mismatchReply.detail).toMatchObject({ session: "s1", session_verdict: "actor_mismatch" });
    }

    // Missing: a foreign session whose owner attests ABSENT at the read's
    // own "absent" version — proven absent, semantically missing.
    const missing = sessionSequencer("room:r1", { owns: (object) => object === "#thing" || object === "#actor" });
    missing.seed(thingCells);
    const missingTranscript = transcriptWith({
      scope: missing.scope,
      session: "s-ghost",
      reads: [{ cell: { kind: "session", object: "s-ghost" }, version: "absent", value: null as never }],
      hash: "sess-gone-1"
    });
    const missingReply = missing.submit(
      submitFor(missing, missingTranscript, "sess-gone-1", {
        "cluster:#actor": { owner_head: { seq: 3, hash: "h3" }, cells: [{ key: sessionCellKey("s-ghost"), version: "absent" }] }
      })
    );
    expect(missingReply.status).toBe("rejected");
    if (missingReply.status === "rejected") {
      expect(missingReply.reason).toBe("unauthorized");
      expect(missingReply.detail).toMatchObject({ session: "s-ghost", session_verdict: "missing", source: "attested_read" });
    }

    // Sequenced turn naming no session at all: refused (direct-route
    // tooling turns remain allowed until Phase-4 transports).
    const bare = sessionSequencer("cluster:#actor");
    bare.seed(thingCells);
    const bareReply = bare.submit(
      submitFor(bare, transcriptWith({ scope: bare.scope, route: "sequenced", hash: "sess-bare-1" }), "sess-bare-1")
    );
    expect(bareReply.status).toBe("rejected");
    if (bareReply.status === "rejected") {
      expect(bareReply.detail).toMatchObject({ session_verdict: "session_required" });
    }
    const directReply = bare.submit(
      submitFor(bare, transcriptWith({ scope: bare.scope, route: "direct", hash: "sess-direct-1" }), "sess-direct-1")
    );
    expect(directReply.status).toBe("accepted");
  });

  it("foreign-session validation composes the CO2.3 attestation machinery", () => {
    // The committing scope (a room) does not own the session; the actor's
    // cluster does. The submit carries the session READ (value + version)
    // and the cluster's attestation; content addressing makes the read
    // value trustworthy exactly when the versions match.
    const cluster = sessionSequencer("cluster:#actor");
    cluster.seed([{ kind: "session", object: "s1", value: sessionRow() }]);
    const sessionCell = cluster.store.get(sessionCellKey("s1"));

    const room = sessionSequencer("room:r1", { owns: (object) => object === "#thing" || object === "#actor" });
    room.seed(thingCells);
    const transcript = transcriptWith({
      scope: room.scope,
      session: "s1",
      reads: [
        { cell: { kind: "session", object: "s1" }, version: sessionCell?.version, value: sessionCell?.value as never }
      ],
      hash: "sess-foreign-1"
    });
    const attest = (version: string): NonNullable<CommitSubmit["attestations"]> => ({
      "cluster:#actor": { owner_head: cluster.head(), cells: [{ key: sessionCellKey("s1"), version }] }
    });

    // No attestation → terminal unauthorized (protocol violation).
    const unattested = room.submit(submitFor(room, transcript, "sess-foreign-un"));
    expect(unattested.status).toBe("rejected");
    if (unattested.status === "rejected") {
      expect(unattested.reason).toBe("unauthorized");
      expect(unattested.detail).toMatchObject({ session: "s1", session_verdict: "session_unattested" });
    }

    // Attested at a DIFFERENT version → NOT an auth verdict: the stale
    // view repairs via read_version_mismatch (retryable, CO4 step 7).
    const stale = room.submit(submitFor(room, transcript, "sess-foreign-stale", attest("some-newer-version")));
    expect(stale.status).toBe("rejected");
    if (stale.status === "rejected") {
      expect(stale.reason).toBe("read_version_mismatch");
      expect(stale.retryable).toBe(true);
    }

    // Attested at the read's version → authorize validates the proven
    // value and the commit lands.
    const accepted = room.submit(
      submitFor(room, transcript, "sess-foreign-ok", attest(sessionCell?.version as string))
    );
    expect(accepted.status, JSON.stringify(accepted)).toBe("accepted");
  });
});

describe("plan-time session effects (CO14 fold; chunk 2)", () => {
  it("an engine-planned sequenced turn folds the session-cell write and derives presence from the same commit", async () => {
    // Real world, real world.auth session; a room verb moves the actor
    // in, which records sessionScopeTransition (CA8) — the fold turns it
    // into the session-cell write, and the sequencer's applier derives
    // the presence relation row from the SAME accepted turn (CO13).
    const world = createWorld();
    const session = world.auth("guest:sessions-fold");
    const actor = session.actor;
    world.object(actor).flags.programmer = true;
    world.createObject({ id: "sess_room", name: "Session Room", parent: "$space", owner: actor });
    const installed = installVerb(
      world,
      "sess_room",
      "welcome",
      `verb :welcome() rxd {
        moveto(actor, this);
        return 1;
      }`,
      null
    );
    expect(installed.ok).toBe(true);
    // Entry verbs skip the presence gate (the catalog `enter` idiom —
    // catalogs/chat `skip_presence_check: true`): a sequenced call into a
    // room the actor has not entered yet IS the entering.
    const welcome = world.object("sess_room").verbs.find((verb) => verb.name === "welcome");
    expect(welcome).toBeDefined();
    if (welcome) welcome.skip_presence_check = true;

    const SCOPE = "home";
    const classifier: ScopeClassifier = { scopeOf: () => SCOPE, isShared: (scope) => scope === SCOPE };
    const seq = sessionSequencer(SCOPE);
    seq.seed(cellsFromSerialized(world.exportWorld()));
    const view = new CellStore("derived");
    for (const cell of storeCells(seq.store)) view.install(cell);
    const priorSessionVersion = seq.store.get(sessionCellKey(session.id))?.version;
    expect(priorSessionVersion).toBeDefined();

    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "sess-fold-1",
      route: "sequenced",
      scope: "sess_room",
      session: session.id,
      actor,
      target: "sess_room",
      verb: "welcome",
      args: []
    };
    const plan = await planTurn({
      call,
      view,
      planningScope: SCOPE,
      classifier,
      base: seq.head(),
      idempotencyKey: "sess-fold-1",
      stamp: seq.stamp()
    });

    // The engine recorded the transition; the fold emitted BOTH the
    // session read (freshness pin) and the session-cell write.
    const transition = plan.transcript.sessionScopeTransition;
    expect(transition).toMatchObject({ session: session.id, actor, to: "sess_room" });
    const sessionReads = plan.transcript.reads.filter((read) => read.cell.kind === "session");
    expect(sessionReads).toHaveLength(1);
    expect(sessionReads[0].version).toBe(priorSessionVersion);
    const sessionWrites = plan.transcript.writes.filter((write) => write.cell.kind === "session");
    expect(sessionWrites).toHaveLength(1);
    expect(sessionWrites[0].value).toMatchObject({ id: session.id, actor, activeScope: "sess_room" });
    // The folded value MERGES the prior row (expiry survives).
    expect((sessionWrites[0].value as SessionCellValue).expiresAt).toBe(session.expiresAt);

    // Post-state parity holds through the shared applyTranscript: the
    // scope re-derives the identical digest and accepts (CO4 step 10).
    const reply = seq.submit(plan.submit);
    expect(reply.status, JSON.stringify(reply)).toBe("accepted");

    // ONE committed turn produced both facts: the session cell moved…
    const committed = seq.store.get(sessionCellKey(session.id));
    expect((committed?.value as SessionCellValue).activeScope).toBe("sess_room");
    // …and the presence relation row derived from it (CO13).
    const presence = seq.relations().get(relationKey("session_presence", "sess_room", session.id));
    expect(presence).toBeDefined();
    expect(presence?.body).toEqual({ actor });
  });
});

describe("session transcript hashing", () => {
  it("session cells participate in the canonical transcript hash", () => {
    // Guard: a folded session write must change the content address the
    // scope folds into its head digest (cellVersion over the body).
    const base = transcriptWith({ scope: "cluster:#actor", session: "s1", hash: "x" });
    const { hash: _h1, ...bodyA } = base;
    const withWrite = {
      ...base,
      writes: [
        ...base.writes,
        {
          cell: { kind: "session" as const, object: "s1" },
          value: sessionRow() as never,
          op: "set" as const,
          writer: sessionWriter("#actor", "session_transition")
        }
      ]
    };
    const { hash: _h2, ...bodyB } = withWrite;
    expect(cellVersion(bodyA)).not.toBe(cellVersion(bodyB));
  });
});
