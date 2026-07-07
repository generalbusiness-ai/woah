#!/usr/bin/env tsx
// net-smoke-workerd — the coherence layer's workerd proving lane (Plan 002
// Phase 3 step 4b; coherence.md CO12.5, CO10 structure gates).
//
// Boots the REAL worker entry in REAL workerd via `wrangler dev`
// (wrangler.smoke.toml — the net DO classes are bound there beside the v2
// ones) and drives NetGatewayDO/NetScopeDO through the /net-smoke doorway:
// real per-DO SQLite, real cross-DO RPC, real alarms.
//
// Topology is DERIVED (CO15, Phase 3.5 item 2): the world is split by
// partitionCells into room/cluster/catalog scope DOs, and the /net/turn
// requests carry NO anchors/shared/scopes — the gateway classifies from
// its view's lineage cells and routes by the `scope:<scopeName>`
// convention, in real workerd. Three runs:
//
//   run 1 (clean):   seed 4 partitions → subscribe → pull 4 → warm
//                    derived-topology turns (CO10 structure: attempt
//                    === 1, empty trace, envelope < 64 KB) → subscriber
//                    fanout lands over real cross-DO RPC → ride-along
//                    rider adoption at the actor's CLUSTER scope
//                    (/net/adopt) over real RPC → CO14 sessions:
//                    /net/session-open mints at the cluster, an
//                    engine-planned SEQUENCED turn folds the session
//                    transition, and the presence roster reads back via
//                    GET /net/relation → CO16 scheduled execution: the
//                    gateway subscribes as PLANNER, a REAL workerd alarm
//                    moves the due bump turn through the durable outbox
//                    to /net/plan-scheduled, the planner runs the normal
//                    turn machinery, and the effect lands in the room's
//                    authority (counter cell polled at the scope).
//   run 2 (latency): WOO_NET_FAULTS latency 100 ms on /submit — the warm
//                    turn still converges with attempt === 1 (latency is
//                    not divergence; the CO12.5 gate the v2 era lacked).
//   run 3 (error):   WOO_NET_FAULTS error on /closure — a stale-view turn
//                    exhausts its recoveries and surfaces E_BUDGET with a
//                    taxonomy attempt trace (CO6), never an unnamed error.
//
// HONEST LIMITS (smoke-discipline rule: never claim a lane catches what it
// cannot): workerd-local cannot force DO eviction mid-flight, so
// eviction-survival of parked tasks and replies stays gated by the fake
// lane's cold-restart tests (tests/worker/net-do.test.ts); this lane proves
// the alarm fires and the machinery runs under real workerd. Cross-colo
// latency is modeled by injected latency, not real distance.
//
// Exit: 0 all steps pass, 1 any step fails, 2 harness crash.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installVerb } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import { cellsFromSerialized, type NetCellInput, type ShadowTurnCall } from "../src/net/bridge";
import { CATALOG_SCOPE, partitionCells } from "../src/net/topology";
import { applyTranscript } from "../src/net/transcript";
import { ScopeSequencer, type CommitReply, type CommitSubmit, type ScopeHead } from "../src/net/scope";
import type { AttemptTraceEntry } from "../src/net/errors";

const EPOCH = "cat-net-lane-1";
// CO15 derived scope names: the DO namespace key IS the scope name.
const ROOM = "room:net_lane_room";
// The CO14 session turn transitions INTO this second room: a freshly
// minted session hydrates with activeScope = the actor's current location
// (world.ts hydrateSession), so entering the room the actor already
// occupies records no transition — the fold needs a real scope change.
const ANNEX = "room:net_lane_annex";
const GATEWAY = "lane-gw";

type StepResult = { name: string; ok: boolean; detail?: string };
const results: StepResult[] = [];
/** woo.metric lines parsed off workerd stdout. No step asserts on these
 * since CO16 made scheduled execution observable by its EFFECT (the
 * counter cell) instead of by metric; kept as the lane's diagnostics
 * channel — the readline consumer also keeps the child's stdout pipe
 * drained. */
const metrics: Array<Record<string, unknown>> = [];

function step(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<number> {
  const fixture = await buildFixture();
  const CLUSTER = fixture.cluster;

  /** Seed the four derived partitions (CO15 partitionCells) and pull
   * each into the gateway's view: planning needs the room + annex cells,
   * the actor's cluster (actor + session rows), and the catalog class
   * chain. FOUR /closure pulls — run 3's skip_first counts them. */
  const seedAndPull = async (base: string): Promise<void> => {
    for (const [scope, cells] of fixture.partitions) {
      await post(base, "scope", scope, "seed", { scope, catalog_epoch: EPOCH, cells });
    }
    for (const [scope] of fixture.partitions) {
      await post(base, "gateway", GATEWAY, "pull", { scope, destination: `scope:${scope}` });
    }
  };

  // ---- run 1: clean -----------------------------------------------------
  console.log("run 1: clean lane (derived topology: room/cluster/catalog)");
  await withWorkerd({}, async (base) => {
    await seedAndPull(base);
    await post(base, "scope", ROOM, "subscribe", { destination: `gateway:${GATEWAY}` });
    // The annex refans the CO14 presence delta (delivered via /net/relate)
    // to ITS subscribers — the gateway must subscribe there too.
    await post(base, "scope", ANNEX, "subscribe", { destination: `gateway:${GATEWAY}` });
    step("seed 4 partitions + subscribe room/annex + pull 4", true);

    // Warm derived-topology turns: the CO10 structure gate at lane
    // level. The request carries NO anchors/shared/scopes — the
    // classifier comes from view lineage and the destinations from the
    // scope:<scopeName> convention, exercised in real workerd.
    const turn1 = await post<TurnBody>(base, "gateway", GATEWAY, "turn", fixture.turnRequest("lane-t1"));
    step(
      "derived-topology warm turn 1 accepted, attempt 1, envelope < 64KB",
      turn1.reply.status === "accepted" && turn1.attempt === 1 && turn1.trace.length === 0 && turn1.envelopeBytes < 65536,
      `attempt=${turn1.attempt} envelope=${turn1.envelopeBytes}B`
    );
    const turn2 = await post<TurnBody>(base, "gateway", GATEWAY, "turn", fixture.turnRequest("lane-t2"));
    step(
      "warm turn 2 stays warm (install-on-accept refreshed the view)",
      turn2.reply.status === "accepted" && turn2.attempt === 1,
      `attempt=${turn2.attempt}`
    );

    // Subscriber fanout over REAL cross-DO RPC: the counter cell reaches
    // the gateway's derived view via /net/fanout, not via install-on-accept
    // alone — poll the probe until the fanout drain lands.
    const fanned = await poll(async () => {
      const probe = await get<{ cell: { value?: { value?: number } ; provenance?: string } | null }>(
        base, "gateway", GATEWAY, `cell?key=${encodeURIComponent("property_cell:lane_box:counter")}`
      );
      return probe.cell?.provenance === "derived" && probe.cell?.value?.value === 2 ? probe : null;
    });
    step("subscriber fanout landed (real cross-DO RPC)", fanned !== null, fanned ? "counter=2 derived" : "timed out");

    // Ride-along rider adoption across two real scope DOs (/net/adopt):
    // the rider is the REAL actor's derived cluster scope.
    const roomHead = (await get<{ head: ScopeHead }>(base, "scope", ROOM, "head")).head;
    const rideAlong = fixture.rideAlongSubmit(roomHead);
    // NB the nested {submit, rider_destinations} shape — spreading the
    // submit into the body root silently drops the riders (found the hard
    // way: the DO treats a body without a `submit` key as a bare submit).
    const rideReply = await post<CommitReply>(base, "scope", ROOM, "submit", {
      submit: rideAlong,
      rider_destinations: { [CLUSTER]: { destination: `scope:${CLUSTER}`, objects: [fixture.actor] } }
    });
    const adopted = rideReply.status === "accepted"
      ? await poll(async () => {
          const closure = await post<{ cells: Array<{ key: string; value: unknown }> }>(base, "scope", CLUSTER, "closure", {
            keys: [`property_cell:${fixture.actor}:greeted`],
            known: [`object_lineage:${fixture.actor}`]
          });
          return closure.cells.length === 1 ? closure : null;
        })
      : null;
    step("ride-along rider adopted at the actor's cluster scope (/net/adopt over real RPC)", adopted !== null,
      rideReply.status !== "accepted" ? `submit ${JSON.stringify(rideReply)}` : undefined);

    // CO13 relations across two real scope DOs: a cross-scope move
    // commits at the actor's CLUSTER; the ROOM — the foreign owner of
    // the contents row — receives /net/relate through the durable
    // outbox, applies it owner-sequenced, and refans it to its
    // subscriber. The gateway's GET /net/relation (the who/contents
    // client-read primitive) then serves the roster, proving the whole
    // relate→apply→refan→mirror chain over real cross-DO RPC.
    const clusterHead = (await get<{ head: ScopeHead }>(base, "scope", CLUSTER, "head")).head;
    const moveReply = await post<CommitReply>(base, "scope", CLUSTER, "submit", {
      submit: fixture.crossScopeMoveSubmit(clusterHead),
      relate_destinations: { [ROOM]: { destination: `scope:${ROOM}`, objects: ["net_lane_room"] } }
    });
    const roster = moveReply.status === "accepted"
      ? await poll(async () => {
          const read = await get<{ members: Array<{ member: string }> }>(
            base, "gateway", GATEWAY, `relation?relation=contents&owner=${encodeURIComponent("net_lane_room")}`
          );
          return read.members.some((m) => m.member === fixture.actor) ? read : null;
        })
      : null;
    step("cross-scope move relates to the room and the gateway roster shows it (GET /net/relation)", roster !== null,
      moveReply.status !== "accepted" ? `submit ${JSON.stringify(moveReply)}` : undefined);

    // CO14 sessions end-to-end over real cross-DO RPC: the gateway mints
    // a session cell at the actor's CLUSTER (/net/session-open), then an
    // ENGINE-PLANNED sequenced turn carrying that session enters the
    // ANNEX — the plan-time fold turns the recorded sessionScopeTransition
    // into the session-cell write (committed at the cluster, the turn's
    // only authority write), the presence deltas reach the annex via
    // /net/relate, and the subscriber gateway's roster read shows them.
    const opened = await post<{ reply: CommitReply; scope: string }>(base, "gateway", GATEWAY, "session-open", {
      session: "lane-s2",
      actor: fixture.actor,
      ttl_ms: 600_000,
      catalog_epoch: EPOCH,
      cluster_destination: `scope:${CLUSTER}`
    });
    step(
      "session-open minted the session cell at the cluster scope (CO14)",
      opened.reply.status === "accepted" && opened.scope === CLUSTER,
      opened.reply.status !== "accepted" ? JSON.stringify(opened.reply) : undefined
    );
    const sessionTurn = await post<TurnBody>(base, "gateway", GATEWAY, "turn", fixture.sessionTurnRequest("lane-sess-1", "lane-s2"));
    const presenceRoster = sessionTurn.reply.status === "accepted"
      ? await poll(async () => {
          const read = await get<{ members: Array<{ member: string; body?: { actor?: string } }> }>(
            base, "gateway", GATEWAY, `relation?relation=session_presence&owner=${encodeURIComponent("net_lane_annex")}`
          );
          const row = read.members.find((m) => m.member === "lane-s2");
          return row && row.body?.actor === fixture.actor ? read : null;
        })
      : null;
    step(
      "sequenced session turn folds the transition; presence roster shows the session (GET /net/relation)",
      presenceRoster !== null,
      sessionTurn.reply.status !== "accepted"
        ? `turn ${JSON.stringify(sessionTurn.reply)}`
        : presenceRoster !== null
          ? "annex session_presence has lane-s2"
          : "roster poll timed out"
    );
    // The folded session-cell write committed at the session's cluster
    // authority: its copy now carries activeScope = the annex.
    const transitionedSession = await poll(async () => {
      const closure = await post<{ cells: Array<{ key: string; value: { activeScope?: string } }> }>(
        base, "scope", CLUSTER, "closure", { keys: ["session:lane-s2"], known: [] }
      );
      return closure.cells.length === 1 && closure.cells[0].value.activeScope === "net_lane_annex" ? closure : null;
    });
    step("session cell committed at its cluster authority with the transitioned scope", transitionedSession !== null);

    // CO16 scheduled-turn execution end-to-end via a REAL workerd alarm:
    // the gateway registers as PLANNER on the room; the alarm moves the
    // due bump turn through the durable outbox to /net/plan-scheduled;
    // the planner runs the normal turn machinery (idempotency key
    // sched:<id>:<at_logical_time>); the effect lands in the ROOM's
    // authority — polled off the scope's counter cell, which turns 1+2
    // bumped to 2 (the full path, not the Phase-3 metric-only peek).
    await post(base, "scope", ROOM, "subscribe", { destination: `gateway:${GATEWAY}`, role: "planner" });
    await post(base, "scope", ROOM, "schedule", {
      scope: ROOM,
      catalog_epoch: EPOCH,
      turn: { id: "lane-tick", at_logical_time: Date.now() + 2000, call: { actor: fixture.actor, target: "lane_box", verb: "bump", args: [] } }
    });
    const bumped = await poll(async () => {
      const closure = await post<{ cells: Array<{ value?: { value?: number } }> }>(base, "scope", ROOM, "closure", {
        keys: ["property_cell:lane_box:counter"],
        known: ["object_lineage:lane_box"]
      });
      return closure.cells[0]?.value?.value === 3 ? closure : null;
    }, 15_000);
    step("scheduled turn executed by the planner gateway via real workerd alarm (counter 2→3)", bumped !== null);
  });

  // ---- run 2: injected submit latency ------------------------------------
  console.log("run 2: 100ms /submit latency (latency is not divergence)");
  await withWorkerd({ WOO_NET_FAULTS: JSON.stringify({ "/submit": { latency_ms: 100 } }) }, async (base) => {
    await seedAndPull(base);
    const turn = await post<TurnBody>(base, "gateway", GATEWAY, "turn", fixture.turnRequest("lane-lat-1"));
    step(
      "latency-faulted warm turn: accepted with attempt === 1",
      turn.reply.status === "accepted" && turn.attempt === 1,
      `attempt=${turn.attempt}`
    );
  });

  // ---- run 3: /closure error → E_BUDGET with taxonomy trace ---------------
  console.log("run 3: /closure fault → E_BUDGET with attempt trace");
  // skip_first spares the FOUR clean partition pulls (each pull rides
  // /closure); every later closure call — the repair loop's refreshes —
  // faults.
  await withWorkerd({ WOO_NET_FAULTS: JSON.stringify({ "/closure": { error: "lane closure fault", skip_first: 4 } }) }, async (base) => {
    await seedAndPull(base);
    // Stale the view: mutate the scope directly, bypassing the gateway.
    const head = (await get<{ head: ScopeHead }>(base, "scope", ROOM, "head")).head;
    await post(base, "scope", ROOM, "submit", fixture.directBumpSubmit(head));
    // The gateway plans on its stale view; read_version_mismatch repair
    // hits the faulted /closure every round -> E_BUDGET with the trace.
    const outcome = await postRaw(base, "gateway", GATEWAY, "turn", fixture.turnRequest("lane-err-1"));
    const error = (outcome.body as { error?: { code?: string; attempts?: AttemptTraceEntry[] } }).error;
    const trace = error?.attempts ?? [];
    step(
      "faulted closure exhausts to E_BUDGET with taxonomy trace",
      outcome.status === 400 && error?.code === "E_BUDGET" && trace.length >= 1 &&
        trace.every((entry) => typeof entry.code === "string" && entry.code.startsWith("E_")),
      `code=${error?.code} trace=${trace.map((t) => t.code).join(",")}`
    );
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nsummary[net-smoke]: ${results.length - failed.length}/${results.length} steps passed`);
  return failed.length === 0 ? 0 : 1;
}

// ---- fixture --------------------------------------------------------------

/** Engine-real fixture, SPLIT by partitionCells (CO15): a $space lane
 * room owning its anchored counter box (room partition), the real actor
 * + its session rows (cluster partition), and the class chain / seed
 * substrate (catalog partition). The gateway derives all topology from
 * these — turnRequest deliberately carries none. */
async function buildFixture() {
  const world = createWorld();
  const session = world.auth("guest:net-lane");
  const actor = session.actor;
  world.createObject({ id: "net_lane_room", name: "Lane Room", parent: "$space", owner: actor });
  world.createObject({ id: "lane_box", name: "Lane Box", parent: "$thing", owner: actor, anchor: "net_lane_room", location: "net_lane_room" });
  world.defineProperty("lane_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  const installed = installVerb(
    world,
    "lane_box",
    "bump",
    `verb :bump() rxd {
      let before = this.counter;
      this.counter = before + 1;
      return this.counter;
    }`,
    null
  );
  if (!installed.ok) throw new Error(`fixture verb install failed: ${JSON.stringify(installed)}`);
  // CO14 lane room + verb: the session turn transitions into the ANNEX (a
  // second room — see the ANNEX const note: entering the genesis room
  // would record no transition). Entry verbs skip the presence gate (the
  // catalog `enter` idiom) — a sequenced call into a room the session has
  // not entered yet IS the entering.
  world.createObject({ id: "net_lane_annex", name: "Lane Annex", parent: "$space", owner: actor });
  const welcomeInstalled = installVerb(
    world,
    "net_lane_annex",
    "welcome",
    `verb :welcome() rxd {
      moveto(actor, this);
      return 1;
    }`,
    null
  );
  if (!welcomeInstalled.ok) throw new Error(`fixture welcome install failed: ${JSON.stringify(welcomeInstalled)}`);
  const welcomeVerb = world.object("net_lane_annex").verbs.find((verb) => verb.name === "welcome");
  if (!welcomeVerb) throw new Error("fixture welcome verb missing after install");
  welcomeVerb.skip_presence_check = true;
  // Genesis placement: the actor occupies the lane room, so its presence
  // rows land in the room partition (genesis state, not under test).
  const placed = await world.directCall("lane-genesis-place", actor, actor, "moveto", ["net_lane_room"], { sessionId: session.id });
  if (placed.op !== "result") throw new Error(`fixture placement failed: ${JSON.stringify(placed)}`);

  const cluster = `cluster:${actor}`;
  const allPartitions = partitionCells(cellsFromSerialized(world.exportWorld()));
  // The lane drives exactly these three partitions; the bundled world's
  // other partitions (other rooms/guests) are not part of the scenario.
  const partitions: Array<[string, NetCellInput[]]> = [ROOM, ANNEX, cluster, CATALOG_SCOPE].map((scope) => {
    const cells = allPartitions.get(scope);
    if (!cells || cells.length === 0) throw new Error(`fixture partition ${scope} is empty`);
    return [scope, cells];
  });
  const roomCells = allPartitions.get(ROOM) as NetCellInput[];
  const clusterCells = allPartitions.get(cluster) as NetCellInput[];

  const bump = (id: string): ShadowTurnCall => ({
    kind: "woo.turn_call.shadow.v1",
    id,
    route: "direct",
    scope: ROOM,
    session: session.id,
    actor,
    target: "lane_box",
    verb: "bump",
    args: []
  });

  // NO anchors/shared/scopes: the gateway must derive the classifier
  // from view lineage and the destinations from scope:<scopeName>.
  const turnRequest = (key: string) => ({
    call: bump(key),
    planningScope: ROOM,
    catalog_epoch: EPOCH,
    idempotency_key: key
  });

  /** CO14 lane turn: an engine-planned SEQUENCED call carrying `sid` into
   * the ANNEX's :welcome (moveto(actor, this)). The minted session
   * hydrates at the actor's genesis room, so moving to the annex records
   * a sessionScopeTransition → the plan-time fold emits the session-cell
   * write. The turn's only authority write IS that session cell, so
   * route.ts retargets the commit to the actor's CLUSTER (CA3 pure
   * session movement); the presence deltas are the two rooms' rows,
   * delivered to them via /net/relate (CO13). */
  const sessionTurnRequest = (key: string, sid: string) => ({
    call: {
      kind: "woo.turn_call.shadow.v1",
      id: key,
      route: "sequenced",
      scope: "net_lane_annex",
      session: sid,
      actor,
      target: "net_lane_annex",
      verb: "welcome",
      args: []
    } satisfies ShadowTurnCall,
    planningScope: ROOM,
    catalog_epoch: EPOCH,
    idempotency_key: key
  });

  /** Hand-built ride-along (room write + REAL-actor rider write), with
   * the planner-parity post-state computed the same way the tests do.
   * The rider write is blind (no read, no attestation), so adoption at
   * the cluster applies it owner-ordered — the design-C allowance. */
  const rideAlongSubmit = (base: ScopeHead): CommitSubmit => {
    const writer = { progr: actor, thisObj: actor, verb: "greet", definer: "$thing", caller: actor, callerPerms: actor };
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "direct",
      scope: ROOM,
      seq: 1,
      call: { actor, target: ROOM, verb: "greet", args: [], body: undefined },
      reads: [],
      writes: [
        { cell: { kind: "prop", object: "lane_box", name: "visits" }, value: 1, op: "set", writer },
        { cell: { kind: "prop", object: actor, name: "greeted" }, value: true, op: "set", writer }
      ],
      creates: [],
      moves: [],
      observations: [{ type: "greeted", actor }],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: "lane-ride-1"
    };
    const twin = new ScopeSequencer(ROOM, EPOCH);
    twin.seed(roomCells as never);
    const derived = applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH });
    return {
      kind: "woo.net.commit_submit.v1",
      scope: ROOM,
      base,
      idempotency_key: "lane-ride-1",
      transcript: transcript as never,
      post_state_version: derived.postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    };
  };

  /** Direct scope mutation for run 3: bump the counter behind the
   * gateway's back so its pulled view goes stale. Twin-parity digest
   * over the ROOM PARTITION (the same cells the room DO was seeded
   * with), same as rideAlongSubmit. */
  const directBumpSubmit = (base: ScopeHead): CommitSubmit => {
    const writer = { progr: actor, thisObj: "lane_box", verb: "bump", definer: "lane_box", caller: actor, callerPerms: actor };
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "direct",
      scope: ROOM,
      seq: 1,
      call: { actor, target: "lane_box", verb: "bump", args: [], body: undefined },
      reads: [],
      writes: [{ cell: { kind: "prop", object: "lane_box", name: "counter" }, value: 99, op: "set", writer }],
      creates: [],
      moves: [],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: "lane-direct-bump"
    };
    const twin = new ScopeSequencer(ROOM, EPOCH);
    twin.seed(roomCells as never);
    const derived = applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH });
    return {
      kind: "woo.net.commit_submit.v1",
      scope: ROOM,
      base,
      idempotency_key: "lane-direct-bump",
      transcript: transcript as never,
      post_state_version: derived.postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    };
  };

  /** CO13 cross-scope move: the actor (cluster-anchored, so the single
   * authoritative movement write commits at ITS cluster — CA3) moves
   * into the lane room. The contents/presence rows this derives are the
   * ROOM's rows; the relate_destinations sibling names the room as their
   * owner, and the room learns of them via /net/relate. `from: null`
   * matches genesis (the placement already located the actor there), so
   * the twin post-state is a same-value live-cell write — the step
   * exercises relation delivery, not movement mechanics. */
  const crossScopeMoveSubmit = (base: ScopeHead): CommitSubmit => {
    const transcript = {
      kind: "woo.effect_transcript.shadow.v1",
      route: "sequenced",
      scope: cluster,
      seq: 1,
      session: session.id,
      call: { actor, target: actor, verb: "moveto", args: ["net_lane_room"], body: undefined },
      reads: [],
      writes: [],
      creates: [],
      moves: [{ object: actor, from: null, to: "net_lane_room" }],
      observations: [],
      logicalInputs: [],
      untrackedEffects: [],
      complete: true,
      incompleteReasons: [],
      hash: "lane-relate-move-1"
    };
    const twin = new ScopeSequencer(cluster, EPOCH);
    twin.seed(clusterCells as never);
    const derived = applyTranscript(twin.store, transcript as never, { scope_head: "x", catalog_epoch: EPOCH });
    return {
      kind: "woo.net.commit_submit.v1",
      scope: cluster,
      base,
      idempotency_key: "lane-relate-move-1",
      transcript: transcript as never,
      post_state_version: derived.postStateVersion,
      stamp: { scope_head: "x", catalog_epoch: EPOCH }
    };
  };

  return { partitions, cluster, actor, turnRequest, sessionTurnRequest, rideAlongSubmit, directBumpSubmit, crossScopeMoveSubmit };
}

// ---- lane plumbing ---------------------------------------------------------

type TurnBody = { reply: CommitReply; attempt: number; trace: AttemptTraceEntry[]; envelopeBytes: number };

async function withWorkerd(vars: Record<string, string>, body: (base: string) => Promise<void>): Promise<void> {
  const port = await findFreePort();
  const base = `http://127.0.0.1:${port}`;
  const persistDir = mkdtempSync(join(tmpdir(), "woo-net-smoke-"));
  const child = startWorkerd(port, persistDir, vars);
  try {
    await waitReady(base);
    await body(base);
  } finally {
    await stopWorkerd(child);
    rmSync(persistDir, { recursive: true, force: true });
  }
}

function startWorkerd(port: number, persistDir: string, vars: Record<string, string>): ChildProcess {
  const varArgs = Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`]);
  const child = spawn(
    "npx",
    ["--no-install", "wrangler", "dev", "-c", "wrangler.smoke.toml", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persistDir, ...varArgs],
    { stdio: ["ignore", "pipe", "inherit"], detached: true }
  );
  child.on("error", (err) => console.error("failed to spawn wrangler dev:", err));
  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const at = line.indexOf("woo.metric ");
      if (at >= 0) {
        const brace = line.indexOf("{", at);
        if (brace >= 0) {
          try {
            metrics.push(JSON.parse(line.slice(brace)) as Record<string, unknown>);
          } catch {
            /* not a metric line */
          }
        }
      }
    });
  }
  return child;
}

async function stopWorkerd(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  await Promise.race([exited, sleep(5000)]);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

async function waitReady(base: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("workerd never became ready");
    await sleep(500);
  }
}

async function postRaw(base: string, kind: string, name: string, route: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}/net-smoke/${kind}/${name}/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function post<T>(base: string, kind: string, name: string, route: string, body: unknown): Promise<T> {
  const { status, body: decoded } = await postRaw(base, kind, name, route, body);
  if (status !== 200) throw new Error(`POST /net-smoke/${kind}/${name}/${route} failed: ${status} ${JSON.stringify(decoded)}`);
  return decoded as T;
}

async function get<T>(base: string, kind: string, name: string, route: string): Promise<T> {
  const response = await fetch(`${base}/net-smoke/${kind}/${name}/${route}`);
  const decoded = (await response.json()) as T;
  if (!response.ok) throw new Error(`GET /net-smoke/${kind}/${name}/${route} failed: ${response.status}`);
  return decoded;
}

async function poll<T>(probe: () => Promise<T | null>, timeoutMs = 10_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value !== null) return value;
    if (Date.now() > deadline) return null;
    await sleep(300);
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("no port")));
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("net-smoke harness crash:", err);
    process.exit(2);
  });
