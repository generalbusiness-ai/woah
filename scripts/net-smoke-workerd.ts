#!/usr/bin/env tsx
// net-smoke-workerd — the coherence layer's workerd proving lane (Plan 002
// Phase 3 step 4b; coherence.md CO12.5, CO10 structure gates).
//
// Boots the REAL worker entry in REAL workerd via `wrangler dev`
// (wrangler.smoke.toml — the net DO classes are bound there beside the v2
// ones) and drives NetGatewayDO/NetScopeDO through the /net-smoke doorway:
// real per-DO SQLite, real cross-DO RPC, real alarms.
//
// The fixture and the workerd plumbing are SHARED with the Playwright e2e
// lane (e2e/net-feed.spec.ts): scripts/net-smoke-fixture.ts holds the
// engine-real world, scripts/net-smoke-harness.ts the lifecycle/doorway
// helpers — one scenario, one fixture, per the smoke discipline. This
// script is the Node HTTP/WS lane over that fixture.
//
// Topology is DERIVED (CO15, Phase 3.5 item 2): the world is split by
// partitionCells into room/cluster/catalog scope DOs, and the /net/turn
// requests carry NO anchors/shared/scopes — the gateway classifies from
// its view's lineage cells and routes by the `scope:<scopeName>`
// convention, in real workerd. Three runs:
//
//   run 1 (clean):   seed the derived partitions → subscribe → pull → warm
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

import {
  ANNEX,
  EPOCH,
  ROOM,
  get,
  poll,
  post,
  postRaw,
  seedPartitions,
  sleep,
  withWorkerd
} from "./net-smoke-harness";
import { buildLaneFixture } from "./net-smoke-fixture";
import type { CommitReply, ScopeHead } from "../src/net/scope";
import type { AttemptTraceEntry } from "../src/net/errors";

const GATEWAY = "lane-gw";

type StepResult = { name: string; ok: boolean; detail?: string };
const results: StepResult[] = [];
/** woo.metric lines parsed off workerd stdout. No step asserts on these
 * since CO16 made scheduled execution observable by its EFFECT (the
 * counter cell) instead of by metric; kept as the lane's diagnostics
 * channel. */
const metrics: Array<Record<string, unknown>> = [];
const laneWorkerdOptions = {
  onLine: (line: string): void => {
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
  }
};

function step(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<number> {
  const fixture = await buildLaneFixture();
  const CLUSTER = fixture.cluster;
  // Every partition seed is followed by a gateway pull, and each pull
  // rides one /closure — run 3's skip_first counts them (dynamic: the
  // fixture grows partitions, the fault window follows).
  const pullCount = fixture.partitions.length;

  /** Seed the derived partitions (CO15 partitionCells) and pull each
   * into the gateway's view: planning needs the room + annex cells, the
   * actors' clusters (actor + session rows), and the catalog class
   * chain. */
  const seedAndPull = async (base: string): Promise<void> => {
    await seedPartitions(base, fixture.partitions);
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
    // to ITS subscribers — the internal lane gateway must subscribe there
    // too. (The CLIENT-surface `net-api` shard no longer subscribes here:
    // H1 self-subscribe now registers it to the room/cluster scopes each
    // client session touches — see NetGatewayDO.selfSubscribe. This lane
    // is the proof that the manual client-shard subscribe is retired.)
    await post(base, "scope", ANNEX, "subscribe", { destination: `gateway:${GATEWAY}` });
    step(`seed ${pullCount} partitions + subscribe room/annex + pull ${pullCount}`, true);

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

    // ---- Phase-4 client surface: /net-api over the WORKER ENTRY (not
    // the /net-smoke doorway — no internal signing anywhere on this
    // path). Apikey auth against the catalog identity cell (pulled on
    // miss by the fresh `net-api` shard), session mint, a sessioned turn
    // returning the item-1 result/observations, and the authenticated
    // roster read served from the shard's fanout-fed mirror.
    const clientHeaders = { "content-type": "application/json", authorization: "Bearer apikey:lane-key:lane-secret" };
    const authFail = await fetch(`${base}/net-api/session`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer apikey:lane-key:wrong" },
      body: "{}"
    });
    step("client surface refuses a bad apikey secret (401 E_NOSESSION)", authFail.status === 401, `status=${authFail.status}`);
    const mintRes = await fetch(`${base}/net-api/session`, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ ttl_ms: 600_000 })
    });
    const mintBody = (await mintRes.json()) as { session?: string; actor?: string };
    step(
      "client session minted over /net-api",
      mintRes.status === 200 && typeof mintBody.session === "string" && mintBody.actor === fixture.actor,
      `status=${mintRes.status}`
    );
    const noSession = await fetch(`${base}/net-api/turn`, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ target: "lane_client_box", verb: "click" })
    });
    step("session-less client turn refused (CO14 session_required)", noSession.status === 401, `status=${noSession.status}`);
    const clickRes = await fetch(`${base}/net-api/turn`, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ target: "lane_client_box", verb: "click", session: mintBody.session })
    });
    const clickBody = (await clickRes.json()) as {
      reply?: { status?: string };
      result?: unknown;
      observations?: Array<{ type?: string }>;
    };
    step(
      "sessioned client turn commits with result + observations on the reply",
      clickRes.status === 200 &&
        clickBody.reply?.status === "accepted" &&
        clickBody.result === 1 &&
        (clickBody.observations ?? []).some((o) => o.type === "clicked"),
      `status=${clickRes.status} body=${JSON.stringify({ reply: clickBody.reply?.status, result: clickBody.result, error: (clickBody as { error?: unknown }).error })}`
    );
    // The cross-scope move step related the actor into the room's
    // contents; that row reaches the `net-api` shard either by refan
    // (subscribed above) or riding the client turn's warm pull (full
    // closures carry relation rows — the CO13 pull coherence rule), so
    // the authenticated roster read shows it.
    const clientRoster = await poll(async () => {
      const res = await fetch(`${base}/net-api/relation?session=${mintBody.session}&relation=contents&owner=${encodeURIComponent("net_lane_room")}`, {
        headers: { authorization: "Bearer apikey:lane-key:lane-secret" }
      });
      if (res.status !== 200) return null;
      const body = (await res.json()) as { members?: Array<{ member: string }> };
      return body.members?.some((m) => m.member === fixture.actor) ? body : null;
    });
    step("authenticated roster read over /net-api shows the room contents", clientRoster !== null);

    // ---- Phase-4 item 3: WS transport + observation push over REAL
    // workerd, driven with Node's NATIVE WebSocket client (the browser
    // API shape — it cannot set request headers, which is exactly why the
    // upgrade authenticates by a single-use TICKET (B3), minted over HTTP;
    // the apikey never rides the URL.
    // Two fresh client sessions transition into the ANNEX via sequenced
    // :welcome turns (a mint records no presence — entering IS the
    // transition), then A waves over its socket: the observation arrives
    // on A's turn_result frame ONLY (turn-id echo dedupe), while B's
    // socket receives the {type:"observations"} push from the annex
    // fanout routed through the CO13 session_presence mirror.
    const wsBase = base.replace(/^http/, "ws");
    const wsToken = "apikey:lane-key:lane-secret";
    const refused = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${wsBase}/net-api/ws?ticket=wst_nope`); // invalid ticket
      ws.addEventListener("open", () => {
        ws.close();
        resolve(false);
      });
      ws.addEventListener("error", () => resolve(true));
    });
    step("WS upgrade without a credential is refused", refused);

    const mintClient = async (): Promise<string> => {
      const res = await fetch(`${base}/net-api/session`, {
        method: "POST",
        headers: clientHeaders,
        body: JSON.stringify({ ttl_ms: 600_000 })
      });
      const body = (await res.json()) as { session?: string };
      if (res.status !== 200 || typeof body.session !== "string") {
        throw new Error(`ws-pass session mint failed: ${res.status} ${JSON.stringify(body)}`);
      }
      return body.session;
    };
    const enterAnnex = async (sid: string, key: string): Promise<boolean> => {
      const res = await fetch(`${base}/net-api/turn`, {
        method: "POST",
        headers: clientHeaders,
        body: JSON.stringify({ target: "net_lane_annex", verb: "welcome", session: sid, idempotency_key: key })
      });
      const body = (await res.json()) as { reply?: { status?: string } };
      return res.status === 200 && body.reply?.status === "accepted";
    };
    const sA = await mintClient();
    const sB = await mintClient();
    const enteredA = await enterAnnex(sA, "lane-ws-enter-a");
    const enteredB = await enterAnnex(sB, "lane-ws-enter-b");
    step("two client sessions enter the annex (sequenced transitions)", enteredA && enteredB);
    // The presence rows are the push audience — they must reach the
    // client shard's mirror (via the annex refan) before the wave.
    const wsPresence = await poll(async () => {
      const res = await fetch(
        `${base}/net-api/relation?session=${sA}&relation=session_presence&owner=${encodeURIComponent("net_lane_annex")}`,
        { headers: { authorization: `Bearer ${wsToken}` } }
      );
      if (res.status !== 200) return null;
      const body = (await res.json()) as { members?: Array<{ member: string }> };
      const members = (body.members ?? []).map((m) => m.member);
      return members.includes(sA) && members.includes(sB) ? body : null;
    });
    step("client sessions' presence rows reach the net-api mirror", wsPresence !== null);

    const openSocket = async (sid: string): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>> }> => {
      // B3: mint a single-use ticket over authenticated HTTP, then connect
      // with ?ticket= — the apikey never rides the WS URL.
      const ticketRes = await fetch(`${base}/net-api/ws-ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${wsToken}`, "content-type": "application/json" },
        body: JSON.stringify({ session: sid })
      });
      const ticket = ((await ticketRes.json()) as { ticket?: string }).ticket ?? "";
      return new Promise((resolve, reject) => {
        const collected: Array<Record<string, unknown>> = [];
        const ws = new WebSocket(`${wsBase}/net-api/ws?ticket=${encodeURIComponent(ticket)}`);
        ws.addEventListener("message", (event) => {
          try {
            collected.push(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
          } catch {
            /* non-JSON frame: not expected; leave it out of the tally */
          }
        });
        ws.addEventListener("open", () => resolve({ ws, frames: collected }));
        ws.addEventListener("error", () => reject(new Error(`ws open failed for ${sid}`)));
      });
    };
    const socketA = await openSocket(sA);
    const socketB = await openSocket(sB);
    try {
      socketA.ws.send(JSON.stringify({ type: "ping", id: "lp1" }));
      const pong = await poll(async () => socketA.frames.find((f) => f.type === "pong" && f.id === "lp1") ?? null, 5000);
      step("WS ping/pong over real workerd", pong !== null);

      socketA.ws.send(
        JSON.stringify({ type: "turn", id: "lw1", target: "net_lane_annex", verb: "wave", idempotency_key: "lane-ws-wave-1" })
      );
      const waveResult = (await poll(
        async () => socketA.frames.find((f) => f.type === "turn_result" && f.id === "lw1") ?? null
      )) as { status?: number; reply?: { status?: string }; observations?: Array<{ type?: string }> } | null;
      step(
        "turn over WS commits with result + observations on the turn_result frame",
        waveResult?.status === 200 &&
          waveResult.reply?.status === "accepted" &&
          (waveResult.observations ?? []).some((o) => o.type === "waved"),
        waveResult ? `status=${waveResult.status} reply=${waveResult.reply?.status}` : "timed out"
      );
      const pushed = (await poll(async () => socketB.frames.find((f) => f.type === "observations") ?? null)) as {
        scope?: string;
        observations?: Array<{ type?: string }>;
      } | null;
      step(
        "peer socket receives the observations push from the annex fanout",
        pushed !== null && pushed.scope === ANNEX && (pushed.observations ?? []).some((o) => o.type === "waved"),
        pushed ? `scope=${pushed.scope}` : "timed out"
      );
      // Echo dedupe: the peer's push above proves the fanout landed;
      // give any stray duplicate a beat, then assert the submitter saw
      // the observation ONLY on its turn_result frame.
      await sleep(500);
      step(
        "submitter socket receives no duplicate observations push (turn-id dedupe)",
        !socketA.frames.some((f) => f.type === "observations")
      );
    } finally {
      socketA.ws.close();
      socketB.ws.close();
    }

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
  }, laneWorkerdOptions);

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
  }, laneWorkerdOptions);

  // ---- run 3: /closure error → E_BUDGET with taxonomy trace ---------------
  console.log("run 3: /closure fault → E_BUDGET with attempt trace");
  // skip_first spares the clean partition pulls (each pull rides
  // /closure — pullCount of them); every later closure call — the repair
  // loop's refreshes — faults.
  await withWorkerd({ WOO_NET_FAULTS: JSON.stringify({ "/closure": { error: "lane closure fault", skip_first: pullCount } }) }, async (base) => {
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
  }, laneWorkerdOptions);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nsummary[net-smoke]: ${results.length - failed.length}/${results.length} steps passed`);
  return failed.length === 0 ? 0 : 1;
}

// ---- lane types -------------------------------------------------------------

type TurnBody = { reply: CommitReply; attempt: number; trace: AttemptTraceEntry[]; envelopeBytes: number };

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("net-smoke harness crash:", err);
    process.exit(2);
  });
