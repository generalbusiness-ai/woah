// net-smoke-fixture — the HEAVY (engine-importing) half of the ONE shared
// net-lane fixture (Plan 002 Phase 4 item 5; smoke discipline: one
// scenario/fixture shared across lanes, never a per-lane copy). The light
// half — scenario constants, workerd lifecycle, /net-smoke doorway
// helpers — lives in scripts/net-smoke-harness.ts; see its header for WHY
// the split exists (Playwright's Node loader refuses the engine's
// attribute-less JSON manifest imports).
//
// Consumers:
//   - scripts/net-smoke-workerd.ts  (`npm run smoke:net-dev`) — imports
//     buildLaneFixture directly (tsx handles the JSON imports);
//   - e2e/net-feed.spec.ts          (`npm run e2e:net`) — runs this file
//     under tsx with --dump (see the main guard at the bottom) via the
//     harness's dumpLaneFixture(), receiving the serializable dump.

import { pathToFileURL } from "node:url";
import { installVerb } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import { cellsFromSerialized, type NetCellInput, type ShadowTurnCall } from "../src/net/bridge";
import { CATALOG_SCOPE, partitionCells } from "../src/net/topology";
import { applyTranscript } from "../src/net/transcript";
import { ScopeSequencer, type CommitSubmit, type ScopeHead } from "../src/net/scope";
import { ANNEX, EPOCH, ROOM, type FixtureDump } from "./net-smoke-harness";

export type LaneFixture = Awaited<ReturnType<typeof buildLaneFixture>>;

/** Engine-real fixture, SPLIT by partitionCells (CO15): a $space lane
 * room owning its anchored counter box (room partition), the annex room
 * with the welcome/wave verbs, TWO real client actors + their session
 * rows (one cluster partition each), and the class chain / seed
 * substrate (catalog partition). The gateway derives all topology from
 * these — turnRequest deliberately carries none. */
export async function buildLaneFixture() {
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
  // Phase-4 item 3 (WS observation push): an observing verb ON the annex
  // for sessions that have transitioned in — the wave's fanout carries
  // the observation the peer socket must receive. No presence skip: by
  // wave time the session HAS entered (that ordering is the point).
  world.defineProperty("net_lane_annex", { name: "waves", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  const waveInstalled = installVerb(
    world,
    "net_lane_annex",
    "wave",
    `verb :wave() rxd {
      this.waves = this.waves + 1;
      observe({ type: "waved", waves: this.waves });
      return this.waves;
    }`,
    null
  );
  if (!waveInstalled.ok) throw new Error(`fixture wave install failed: ${JSON.stringify(waveInstalled)}`);
  // Phase-4 client surface (/net-api): an apikey minted into
  // $system.api_keys via the same wizard path localdev bootstrap uses;
  // partitionCells carries the identity cell to the CATALOG partition
  // naturally ($-prefix rule), where the client gateway pulls it on miss.
  world.ensureApiKey("$wiz", actor, "lane-key", "lane-secret", "net-lane-client");
  // A dedicated ROOM-anchored target for the client turn. Engine
  // semantics (the CO14 hydration caveat): a sequenced move is a SESSION
  // transition, never an object_live write — so even after the lane's
  // session turn "enters" the annex on session lane-s2, the actor's
  // object_live location stays the genesis room, and the client's FRESH
  // session hydrates there. The client turn therefore targets a box in
  // the room, where its session actually is.
  world.createObject({ id: "lane_client_box", name: "Lane Client Box", parent: "$thing", owner: actor, anchor: "net_lane_room", location: "net_lane_room" });
  // The client actor STANDS in the room (realistic client scenario: you
  // click things where you are). Located-elsewhere targeting is a
  // Phase-4 non-goal; the recovery loop only probes scopes derivable
  // from the actor/session/conventions (Big-World: no scope scans).
  // moveObjectChecked is the PUBLIC authoring forced-move path (the lane
  // previously awaited the private sync moveObject, which only escaped
  // notice because scripts/ was outside the typechecked program).
  await world.moveObjectChecked(actor, "net_lane_room");
  world.defineProperty("lane_client_box", { name: "clicks", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  const clickInstalled = installVerb(
    world,
    "lane_client_box",
    "click",
    `verb :click() rxd {
      this.clicks = this.clicks + 1;
      observe({ type: "clicked", clicks: this.clicks });
      return this.clicks;
    }`,
    null
  );
  if (!clickInstalled.ok) throw new Error(`fixture click install failed: ${JSON.stringify(clickInstalled)}`);
  // Genesis placement: the actor occupies the lane room, so its presence
  // rows land in the room partition (genesis state, not under test).
  const placed = await world.directCall("lane-genesis-place", actor, actor, "moveto", ["net_lane_room"], { sessionId: session.id });
  if (placed.op !== "result") throw new Error(`fixture placement failed: ${JSON.stringify(placed)}`);

  // The SECOND client identity (the cross-user e2e's user B): its own
  // guest actor bound to CLIENT_KEY_B, standing in the same lane room —
  // the two-browser-context scenario needs two actors whose sessions can
  // both transition into the shared annex. Its cells partition into its
  // OWN cluster scope (cluster:<actorB>), seeded like every other
  // partition; the net-api shard pulls it on B's session mint.
  const sessionB = world.auth("guest:net-lane-b");
  const actorB = sessionB.actor;
  world.ensureApiKey("$wiz", actorB, "lane-key-b", "lane-secret-b", "net-lane-client-b");
  await world.moveObjectChecked(actorB, "net_lane_room");
  const placedB = await world.directCall("lane-genesis-place-b", actorB, actorB, "moveto", ["net_lane_room"], { sessionId: sessionB.id });
  if (placedB.op !== "result") throw new Error(`fixture placement B failed: ${JSON.stringify(placedB)}`);

  const cluster = `cluster:${actor}`;
  const clusterB = `cluster:${actorB}`;
  const allPartitions = partitionCells(cellsFromSerialized(world.exportWorld()));
  // The lanes drive exactly these partitions; the bundled world's other
  // partitions (other rooms/guests) are not part of the scenario.
  const partitions: Array<[string, NetCellInput[]]> = [ROOM, ANNEX, cluster, clusterB, CATALOG_SCOPE].map((scope) => {
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

  /** Direct scope mutation for the lane's run 3: bump the counter behind
   * the gateway's back so its pulled view goes stale. Twin-parity digest
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

  return {
    partitions,
    cluster,
    clusterB,
    actor,
    actorB,
    turnRequest,
    sessionTurnRequest,
    rideAlongSubmit,
    directBumpSubmit,
    crossScopeMoveSubmit
  };
}

// ---- --dump entry (the Playwright bridge) -----------------------------------
// `tsx scripts/net-smoke-fixture.ts --dump` prints the SERIALIZABLE part
// of the fixture as JSON (FixtureDump): the e2e spec cannot import this
// module (see the header), so the harness's dumpLaneFixture() runs it
// here — the same buildLaneFixture the smoke lane executes in-process.
const invokedAsMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain && process.argv.includes("--dump")) {
  buildLaneFixture()
    .then((fixture) => {
      const dump: FixtureDump = {
        partitions: fixture.partitions,
        actor: fixture.actor,
        actorB: fixture.actorB,
        cluster: fixture.cluster,
        clusterB: fixture.clusterB
      };
      // The dump is ~1MB and stdout is a non-blocking PIPE under
      // execFile: a bare write + process.exit truncates at the 64KB pipe
      // buffer, and fs.writeSync can partial-write on a non-blocking fd.
      // stdout.write's callback fires only after the full flush — exit
      // there (the world keeps timers alive, so exiting is required).
      process.stdout.write(JSON.stringify(dump), () => process.exit(0));
    })
    .catch((err) => {
      console.error("fixture dump failed:", err);
      process.exit(1);
    });
}
