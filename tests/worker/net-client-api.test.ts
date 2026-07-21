// Phase-4 item 2: the /net-api client surface over fake-DO
// (coherence.md CO14 "credential authentication against identity cells
// in the catalog scope closure" + the Phase-4 sessions-required rule).
//
// The client gateway shard starts with an EMPTY view, so this exercises
// the pull-on-miss paths for real: the catalog identity cell
// (property_cell:$system:api_keys) pulls from the catalog scope on the
// first authenticated request, the actor's cluster pulls by the CO15
// `cluster:<actor>` convention before the mint, and the planning scope
// pulls by the `room:<space>` convention before the sessioned turn.
//
// Proves:
//   - named 401 refusals (missing/malformed/wrong credentials; the CO14
//     session_required rule; missing/actor-mismatched sessions);
//   - POST /net-api/session authenticates, derives the actor's cluster
//     from view lineage, mints via the existing machinery, and returns
//     {session, actor, expires_at};
//   - POST /net-api/turn validates the session cell, plans at the
//     location-derived scope, commits route:"sequenced" through the
//     normal /net/turn machinery, and returns the item-1
//     result/observations;
//   - catalog-qualified manifest references are rejected as invalid
//     runtime targets before target-scope pull or repair;
//   - client idempotency keys replay per the item-1 contract;
//   - the authenticated GET reads (cell probe, relation roster) serve.
import { describe, expect, it, vi } from "vitest";
import { FakeDurableObjectState } from "./fake-do";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetAuditDO } from "../../src/worker/net/audit-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { installVerb } from "../../src/core/authoring";
import { createWorld } from "../../src/core/bootstrap";
import { cellsFromSerialized } from "../../src/net/bridge";
import { netActivationCell, partitionInstallRelations } from "../../src/net/install";
import { CATALOG_SCOPE, partitionCells } from "../../src/net/topology";
import type { CommitReply } from "../../src/net/scope";

const SECRET = "net-client-api-test-secret";
const EPOCH = "cat-net-capi-1";
const KEY_ID = "capi-key";
const KEY_SECRET = "capi-secret";

function netState(name: string): {
  state: NetScopeDurableState & NetGatewayDurableState;
  settle: () => Promise<void>;
  close: () => void;
} {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const state = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => {
      deferred.push(promise);
    },
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: (_at: number) => {},
      deleteAlarm: () => {}
    }
  };
  return {
    state,
    settle: async () => {
      while (deferred.length > 0) await deferred.shift();
    },
    close: () => fake.close()
  };
}

/** Unsigned client request straight at the gateway DO — the /net-api
 * surface must never require internal signing. */
async function clientFetch(
  gateway: NetGatewayDO,
  method: string,
  path: string,
  opts: { token?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  const request =
    method === "GET"
      ? new Request(`https://do${path}`, { headers })
      : new Request(`https://do${path}`, {
          method,
          headers: (headers.set("content-type", "application/json"), headers),
          body: JSON.stringify(opts.body ?? {})
        });
  const response = await gateway.fetch(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

type TurnBody = {
  reply: CommitReply;
  attempt: number;
  result?: unknown;
  observations?: Array<Record<string, unknown>>;
  replayed?: boolean;
};

async function buildHarness() {
  // ---- Engine-real fixture: a room, a room-anchored box with a bump
  // verb (returns + observes), the actor placed in the room, and an
  // apikey minted into $system.api_keys via the same wizard path
  // localdev bootstrap uses — partitionCells then carries the identity
  // cell to the catalog scope naturally ($-prefix rule, CO15).
  const world = createWorld();
  const session = world.auth("guest:net-client-api");
  const actor = session.actor;
  world.createObject({ id: "capi_room", name: "Client Room", parent: "$space", owner: actor });
  world.createObject({ id: "capi_box", name: "Client Box", parent: "$thing", owner: actor, anchor: "capi_room", location: "capi_room" });
  world.defineProperty("capi_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
  const installed = installVerb(
    world,
    "capi_box",
    "bump",
    `verb :bump() rxd {
      this.counter = this.counter + 1;
      observe({ type: "bumped", counter: this.counter });
      return this.counter;
    }`,
    null
  );
  expect(installed.ok).toBe(true);
  expect(installVerb(
    world,
    "capi_box",
    "probe_target",
    "verb :probe_target(target) rxd { return target; }",
    null
  ).ok).toBe(true);
  const placed = await world.directCall("capi-genesis-place", actor, actor, "moveto", ["capi_room"], { sessionId: session.id });
  expect(placed.op).toBe("result");
  world.ensureApiKey("$wiz", actor, KEY_ID, KEY_SECRET, "net-client-api-test");
  world.setCustomerOf(actor, { customer: "acct_capi", derived_via: "account" });
  world.setProp("$catalog_registry", "installed_catalogs", [{
    alias: "dubspace",
    catalog: "dubspace",
    version: "1.0.4",
    provenance: "bundled",
    owner: "$wiz",
    objects: { room: "capi_room" }
  }]);
  // A second authenticated identity for the actor_mismatch case.
  const other = world.auth("guest:net-client-api-2").actor;
  world.ensureApiKey("$wiz", other, "capi-key-2", "capi-secret-2", "net-client-api-test-2");
  world.setCustomerOf(other, { customer: "acct_other", derived_via: "account" });

  const installCells = cellsFromSerialized(world.exportWorld());
  const partitions = partitionCells(installCells);
  const relations = partitionInstallRelations(installCells);
  // Activation barrier: the fixture installs a pre-verified world, so it
  // self-activates with the catalog partition.
  partitions.set(CATALOG_SCOPE, [...(partitions.get(CATALOG_SCOPE) ?? []), netActivationCell(EPOCH)]);
  const roomScope = "room:capi_room";
  const clusterScope = `cluster:${actor}`;
  expect([...partitions.keys()]).toEqual(expect.arrayContaining([roomScope, clusterScope, CATALOG_SCOPE]));

  const states: Array<ReturnType<typeof netState>> = [];
  const scopeDOs = new Map<string, NetScopeDO>();
  const gateways = new Map<string, NetGatewayDO>();
  // Record actual DO crossings so boundary regressions can distinguish a
  // prompt input refusal from the repair loop that an invalid target used to
  // trigger. Direct fixture seeding intentionally does not enter this log.
  const resolvedDestinations: string[] = [];
  const resolve = (destination: string) => {
    resolvedDestinations.push(destination);
    if (destination.startsWith("scope:")) {
      const instance = scopeDOs.get(destination.slice("scope:".length));
      if (!instance) throw new Error(`unresolvable destination ${destination}`);
      return instance;
    }
    if (destination.startsWith("gateway:")) {
      const instance = gateways.get(destination.slice("gateway:".length));
      if (!instance) throw new Error(`unresolvable destination ${destination}`);
      return instance;
    }
    if (destination === "audit:audit-0") return auditDO;
    throw new Error(`unresolvable destination ${destination}`);
  };
  const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve, NET_AUDIT_SHARDS: "1" };
  const auditState = netState("audit-0");
  const auditDO = new NetAuditDO(auditState.state, { WOO_INTERNAL_SECRET: SECRET });
  const { signInternalRequest } = await import("../../src/worker/internal-auth");
  const signedTo = async (instance: NetScopeDO | NetGatewayDO, path: string, body: unknown) => {
    const req = new Request(`https://do${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return instance.fetch(await signInternalRequest(scopeEnv, req));
  };
  for (const scope of [roomScope, clusterScope, CATALOG_SCOPE, `cluster:${other}`]) {
    const st = netState(`scope-${scope}`);
    const instance = new NetScopeDO(st.state, scopeEnv);
    const seeded = await signedTo(instance, "/net/seed", {
      scope,
      catalog_epoch: EPOCH,
      cells: partitions.get(scope) ?? [],
      relations: relations.get(scope) ?? []
    });
    expect(seeded.ok).toBe(true);
    states.push(st);
    scopeDOs.set(scope, instance);
  }

  // The client gateway shard: EMPTY view — every warm-up is pull-on-miss.
  const gatewayState = netState("gateway-net-api");
  const metricPoints: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
  const gatewayEnv: NetGatewayEnv = {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: resolve,
    NET_AUDIT_SHARDS: "1",
    METRICS: { writeDataPoint: (point) => metricPoints.push(point) }
  };
  const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);
  gateways.set("net-api", gateway);
  states.push(gatewayState);

  states.push(auditState);
  return { gateway, actor, other, roomScope, resolvedDestinations, metricPoints, auditDO, scopeEnv, close: () => states.forEach((st) => st.close()) };
}

describe("/net-api client surface (Phase 4 item 2, CO14)", () => {
  it("an unseeded namespace refuses with the named E_NOT_INSTALLED verdict, not a 500 (cutover item D)", async () => {
    // The pre-install condition every fresh deploy sits in: the catalog
    // scope DO exists but holds NO durable state. An authenticated
    // request must surface a verdict clients and the install pipeline's
    // verification probes can interpret.
    const catalogState = netState("scope-catalog-empty");
    const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET };
    const emptyCatalog = new NetScopeDO(catalogState.state, scopeEnv);
    const gatewayState = netState("gateway-not-installed");
    const gatewayEnv: NetGatewayEnv = {
      WOO_INTERNAL_SECRET: SECRET,
      NET_RESOLVE: (destination) => {
        if (destination === `scope:${CATALOG_SCOPE}`) return emptyCatalog;
        throw new Error(`unexpected destination ${destination}`);
      }
    };
    const gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);

    const refused = await clientFetch(gateway, "POST", "/net-api/session", { token: "apikey:any:any", body: {} });
    expect(refused.status).toBe(503);
    expect(refused.body.error).toMatchObject({ code: "E_NOT_INSTALLED", detail: { reason: "not_installed" } });

    catalogState.close();
    gatewayState.close();
  });

  it("authenticates apikeys against the catalog identity cell and refuses namedly", async () => {
    const h = await buildHarness();

    // Missing credential entirely.
    const missing = await clientFetch(h.gateway, "GET", "/net-api/cell?key=object_live:capi_box");
    expect(missing.status).toBe(401);
    expect(missing.body.error).toMatchObject({ code: "E_NOSESSION", detail: { reason: "missing_credential" } });

    // A bearer token of another class is refused, not misparsed.
    const wrongClass = await clientFetch(h.gateway, "GET", "/net-api/cell?key=x", { token: "sess-123" });
    expect(wrongClass.status).toBe(401);
    expect(wrongClass.body.error).toMatchObject({ code: "E_NOSESSION", detail: { reason: "unsupported_token_class" } });

    // Wrong secret (constant-time compare path).
    const badSecret = await clientFetch(h.gateway, "GET", "/net-api/cell?key=x", { token: `apikey:${KEY_ID}:nope` });
    expect(badSecret.status).toBe(401);
    expect(badSecret.body.error).toMatchObject({ code: "E_NOSESSION", detail: { reason: "secret_rejected" } });

    // Unknown key id.
    const unknown = await clientFetch(h.gateway, "GET", "/net-api/cell?key=x", { token: "apikey:who:ever" });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toMatchObject({ code: "E_NOSESSION", detail: { reason: "unknown_or_revoked" } });

    // The x-woo-api-key carrier authenticates (prefix optional): the
    // request gets PAST auth to the B1 session check — proven by the
    // session_required verdict (not missing_credential), i.e. the
    // credential was accepted.
    const viaHeader = await clientFetch(h.gateway, "GET", "/net-api/cell?key=object_live:capi_box", {
      headers: { "x-woo-api-key": `${KEY_ID}:${KEY_SECRET}` }
    });
    expect(viaHeader.status).toBe(401);
    expect(viaHeader.body.error).toMatchObject({ code: "E_NOSESSION", detail: { reason: "session_required" } });

    h.close();
  });

  it("authorizes reads by presence and denies credential/foreign cells (B1)", async () => {
    const h = await buildHarness();
    const token = `apikey:${KEY_ID}:${KEY_SECRET}`;
    const minted = await clientFetch(h.gateway, "POST", "/net-api/session", { token, body: { ttl_ms: 600_000 } });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    const sid = minted.body.session as string;
    const catalogs = await clientFetch(h.gateway, "GET", `/net-api/catalogs?session=${sid}`, { token });
    expect(catalogs.status, JSON.stringify(catalogs.body)).toBe(200);
    expect(catalogs.body.catalogs).toEqual([expect.objectContaining({ alias: "dubspace", version: "1.0.4" })]);
    // A bump turn pulls capi_room into the gateway view; the caller is
    // present where its actor stands (capi_room, from genesis placement),
    // so its own-room cells/relation are readable with no transition.
    const bumped = await clientFetch(h.gateway, "POST", "/net-api/turn", {
      token,
      body: { target: "capi_box", verb: "bump", session: sid }
    });
    expect(bumped.status, JSON.stringify(bumped.body)).toBe(200);

    // DENY: the credential cell — the acute case (auth pulled it into the
    // view, so without B1 any key could read the salted-hash records).
    const creds = await clientFetch(h.gateway, "GET", `/net-api/cell?session=${sid}&key=${encodeURIComponent("property_cell:$system:api_keys")}`, { token });
    expect(creds.status).toBe(403);
    expect(creds.body.error).toMatchObject({ code: "E_PERM" });

    // DENY: verb bytecode (no client reason to read it).
    const bytecode = await clientFetch(h.gateway, "GET", `/net-api/cell?session=${sid}&key=${encodeURIComponent("verb_bytecode:capi_box:bump")}`, { token });
    expect(bytecode.status).toBe(403);

    // ALLOW: the caller's own actor cell.
    const own = await clientFetch(h.gateway, "GET", `/net-api/cell?session=${sid}&key=${encodeURIComponent("object_live:" + h.actor)}`, { token });
    expect(own.status, JSON.stringify(own.body)).toBe(200);

    // ALLOW: an object that lives in the caller's room.
    const boxCell = await clientFetch(h.gateway, "GET", `/net-api/cell?session=${sid}&key=object_live:capi_box`, { token });
    expect(boxCell.status, JSON.stringify(boxCell.body)).toBe(200);

    // ALLOW: the room's contents relation (a room the caller is in).
    const roster = await clientFetch(h.gateway, "GET", `/net-api/relation?session=${sid}&relation=contents&owner=capi_room`, { token });
    expect(roster.status, JSON.stringify(roster.body)).toBe(200);
    expect((roster.body.members as Array<{ member?: string }>).map((row) => row.member)).toContain("capi_box");

    // DENY: a relation whose owner is a scope the caller is not present in.
    const foreign = await clientFetch(h.gateway, "GET", `/net-api/relation?session=${sid}&relation=contents&owner=room:elsewhere`, { token });
    expect(foreign.status).toBe(403);

    // DENY: reads without a session (the presence anchor).
    const noSession = await clientFetch(h.gateway, "GET", "/net-api/cell?key=object_live:capi_box", { token });
    expect(noSession.status).toBe(401);
    expect(noSession.body.error).toMatchObject({ detail: { reason: "session_required" } });

    h.close();
  });

  it("accepts bounded browser diagnostics on the net namespace without trusting payload identity", async () => {
    const h = await buildHarness();
    const token = `apikey:${KEY_ID}:${KEY_SECRET}`;
    const minted = await clientFetch(h.gateway, "POST", "/net-api/session", { token, body: { ttl_ms: 600_000 } });
    const sid = minted.body.session as string;
    const reported = await clientFetch(h.gateway, "POST", "/net-api/browser-metrics", {
      token,
      body: {
        session: sid,
        metrics: [{ kind: "browser_activity", source: "main", phase: "net_room_projection", ms: 12, status: "ok", actor: "spoofed" }]
      }
    });
    expect(reported.status, JSON.stringify(reported.body)).toBe(200);
    expect(reported.body).toMatchObject({ ok: true, accepted: 1, sampled: 0 });
    const point = h.metricPoints.find((item) => item.blobs?.[0] === "browser_activity");
    expect(point?.blobs?.[5]).toBe("net_room_projection");
    expect(point?.blobs?.[13]).toBe(h.actor);

    const missingSession = await clientFetch(h.gateway, "POST", "/net-api/browser-metrics", {
      token,
      body: { metrics: [] }
    });
    expect(missingSession.status).toBe(401);
    h.close();
  });

  it("mints a session, requires sessions on turns (CO14), and returns result/observations on the sessioned turn", async () => {
    const h = await buildHarness();
    const token = `apikey:${KEY_ID}:${KEY_SECRET}`;

    // The CO14 Phase-4 rule: a client turn with no session is refused
    // with the named verdict BEFORE any planning happens.
    const sessionless = await clientFetch(h.gateway, "POST", "/net-api/turn", {
      token,
      body: { target: "capi_box", verb: "bump" }
    });
    expect(sessionless.status).toBe(401);
    expect(sessionless.body.error).toMatchObject({
      code: "E_NOSESSION",
      detail: { session_verdict: "session_required" }
    });

    // A session id the cluster never minted: verdict "missing".
    const bogus = await clientFetch(h.gateway, "POST", "/net-api/turn", {
      token,
      body: { target: "capi_box", verb: "bump", session: "s_forged" }
    });
    expect(bogus.status).toBe(401);
    expect(bogus.body.error).toMatchObject({ code: "E_NOSESSION", detail: { session_verdict: "missing" } });

    // Mint: authenticates, pulls the cluster by convention, derives the
    // cluster scope from view lineage, session-opens.
    const before = Date.now();
    const minted = await clientFetch(h.gateway, "POST", "/net-api/session", { token, body: { ttl_ms: 600_000 } });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    expect(minted.body.actor).toBe(h.actor);
    const sid = minted.body.session as string;
    expect(sid).toMatch(/^s_/);
    expect(minted.body.expires_at as number).toBeGreaterThanOrEqual(before + 600_000);
    expect(minted.body.active_scope).toBe("capi_room");

    // Another authenticated identity presenting THIS actor's session:
    // the actor binding refuses it (actor_mismatch).
    const stolen = await clientFetch(h.gateway, "POST", "/net-api/turn", {
      token: "apikey:capi-key-2:capi-secret-2",
      body: { target: "capi_box", verb: "bump", session: sid }
    });
    expect(stolen.status).toBe(401);
    expect(stolen.body.error).toMatchObject({ code: "E_NOSESSION", detail: { session_verdict: "actor_mismatch" } });

    // The sessioned turn: planning scope derives from the session cell
    // (activeScope null after mint → the actor's live location → the
    // room), commits sequenced through the normal machinery, and the
    // reply carries the item-1 result/observations.
    const turn = await clientFetch(h.gateway, "POST", "/net-api/turn", {
      token,
      body: { target: "capi_box", verb: "bump", session: sid, idempotency_key: "capi-t1" }
    });
    expect(turn.status, JSON.stringify(turn.body)).toBe(200);
    const turnBody = turn.body as unknown as TurnBody;
    expect(turnBody.reply.status, JSON.stringify(turnBody.reply)).toBe("accepted");
    expect(turnBody.result).toBe(1);
    expect(turnBody.observations?.map((o) => o.type)).toContain("bumped");

    // Client-supplied idempotency key replays per the item-1 contract:
    // the recorded reply comes back marked, without an invented result.
    const replay = await clientFetch(h.gateway, "POST", "/net-api/turn", {
      token,
      body: { target: "capi_box", verb: "bump", session: sid, idempotency_key: "capi-t1" }
    });
    expect(replay.status).toBe(200);
    const replayBody = replay.body as unknown as TurnBody;
    expect(replayBody.reply.status).toBe("accepted");
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.result).toBeUndefined();

    // Authenticated reads: the committed counter is in the view
    // (install-on-accept), and the relation roster read serves from the
    // mirror (content is proven in the workerd lane, where fanout
    // subscription feeds it; here the mirror is empty but the surface
    // answers).
    // B1: reads carry the caller's session; the caller is present where its
    // actor stands (capi_room), so both its box cell and the room roster
    // are readable.
    const probe = await clientFetch(h.gateway, "GET", `/net-api/cell?session=${sid}&key=property_cell:capi_box:counter`, { token });
    expect(probe.status, JSON.stringify(probe.body)).toBe(200);
    expect((probe.body.cell as { value?: { value?: number } })?.value?.value).toBe(1);
    const roster = await clientFetch(h.gateway, "GET", `/net-api/relation?session=${sid}&relation=contents&owner=capi_room`, { token });
    expect(roster.status).toBe(200);
    expect(Array.isArray(roster.body.members)).toBe(true);

    h.close();
  });

  it("rejects a catalog-qualified target before target-scope pull or repair", async () => {
    const h = await buildHarness();
    const token = `apikey:${KEY_ID}:${KEY_SECRET}`;
    const minted = await clientFetch(h.gateway, "POST", "/net-api/session", { token, body: { ttl_ms: 600_000 } });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    const sid = minted.body.session as string;

    // Catalog manifests may spell this shape as `alias:seed`, but the
    // installer must replace it with the seed's concrete id. Before this
    // boundary check, the colon-bearing value entered missing-state repair
    // and surfaced as 503 E_BUDGET after six fruitless attempts.
    h.resolvedDestinations.length = 0;
    const invalid = await clientFetch(h.gateway, "POST", "/net-api/turn", {
      token,
      body: { target: "tasks:the_taskboard", verb: "listing", session: sid }
    });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatchObject({
      code: "E_INVARG",
      detail: { field: "target", reason: "invalid_object_id" }
    });
    // Credential authentication still consults the catalog scope. Nothing
    // else — especially the room planning scope — may be contacted for this
    // malformed target.
    expect(h.resolvedDestinations.filter((destination) => destination !== `scope:${CATALOG_SCOPE}`)).toEqual([]);

    const invalidVerb = await clientFetch(h.gateway, "POST", "/net-api/turn", {
      token,
      body: { target: "capi_box", verb: "catalog:probe_target", args: [], session: sid }
    });
    expect(invalidVerb.status).toBe(400);
    expect(invalidVerb.body.error).toMatchObject({
      code: "E_INVARG",
      detail: { field: "verb", reason: "invalid_verb_name" }
    });

    const invalidArg = await clientFetch(h.gateway, "POST", "/net-api/turn", {
      token,
      body: { target: "capi_box", verb: "probe_target", args: ["catalog:capi_room"], session: sid }
    });
    expect(invalidArg.status).toBe(400);
    expect(invalidArg.body.error).toMatchObject({
      code: "E_INVARG",
      detail: { field: "args[0]", reason: "invalid_object_id" }
    });

    h.close();
  });

  it("v1 client-surface field names are pinned (Phase 5 contract freeze: add-only, never rename)", async () => {
    // The .v1 kind tags are decorative — no receiver checks them — so the
    // ONLY thing protecting deployed clients from a silent break is that
    // these names keep answering. Subset assertions: adding a field
    // passes; renaming one fails.
    const h = await buildHarness();
    const token = `apikey:${KEY_ID}:${KEY_SECRET}`;
    const minted = await clientFetch(h.gateway, "POST", "/net-api/session", { token, body: { ttl_ms: 600_000 } });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    for (const key of ["session", "actor", "expires_at", "active_scope"]) {
      expect(Object.keys(minted.body), `session.${key}`).toContain(key);
    }
    const sid = minted.body.session as string;

    const turn = await clientFetch(h.gateway, "POST", "/net-api/turn", {
      token,
      body: { target: "capi_box", verb: "bump", session: sid, idempotency_key: "capi-pin-1" }
    });
    expect(turn.status, JSON.stringify(turn.body)).toBe(200);
    for (const key of ["reply", "result", "observations"]) {
      expect(Object.keys(turn.body), `turn.${key}`).toContain(key);
    }
    const reply = turn.body.reply as Record<string, unknown>;
    for (const key of ["status", "scope", "head", "post_state_version"]) {
      expect(Object.keys(reply), `turn.reply.${key}`).toContain(key);
    }

    const probe = await clientFetch(h.gateway, "GET", `/net-api/cell?session=${sid}&key=property_cell:capi_box:counter`, { token });
    expect(probe.status).toBe(200);
    for (const key of ["key", "cell"]) expect(Object.keys(probe.body), `cell.${key}`).toContain(key);

    const roster = await clientFetch(h.gateway, "GET", `/net-api/relation?session=${sid}&relation=contents&owner=capi_room`, { token });
    expect(roster.status).toBe(200);
    for (const key of ["relation", "owner", "members"]) expect(Object.keys(roster.body), `relation.${key}`).toContain(key);

    h.close();
  });

  it("rate-limits /net-api per authenticated actor: burst 100, named 429 E_RATE, refills (H4)", async () => {
    const h = await buildHarness();
    const token = `apikey:${KEY_ID}:${KEY_SECRET}`;

    // Exhaust the standard bucket with cheap reads (each consumes ONE
    // token after auth; the 401 session_required they return is
    // irrelevant to the budget — rate limiting runs before dispatch).
    for (let i = 0; i < 100; i += 1) {
      const res = await clientFetch(h.gateway, "GET", "/net-api/cell?key=object_live:capi_box", { token });
      expect(res.status, `op ${i}`).toBe(401); // session_required, NOT rate limited
    }
    const throttled = await clientFetch(h.gateway, "GET", "/net-api/cell?key=object_live:capi_box", { token });
    expect(throttled.status).toBe(429);
    expect(throttled.body.error).toMatchObject({ code: "E_RATE", detail: { reason: "rate_limited" } });

    // The bucket refills on the clock (50/s): after ~150ms at least a few
    // tokens are back and the same request passes rate limiting again.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const recovered = await clientFetch(h.gateway, "GET", "/net-api/cell?key=object_live:capi_box", { token });
    expect(recovered.status).toBe(401); // back to session_required — not 429

    h.close();
  });

  it("gives session mint + ws-ticket a tighter shared bucket (H4 amplifier rule)", async () => {
    const h = await buildHarness();
    const token = `apikey:${KEY_ID}:${KEY_SECRET}`;

    // One real mint (amplifier token 1) provides the session the ticket
    // mints below need.
    const minted = await clientFetch(h.gateway, "POST", "/net-api/session", { token, body: { ttl_ms: 600_000 } });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    const sid = minted.body.session as string;

    // ws-ticket mints share the amplifier bucket (burst 20, refill 5/s).
    // Fire rapid ticket mints until the bucket refuses: the loop issues
    // far faster than the refill rate, so within 40 attempts a named
    // 429 E_RATE MUST occur (refill can stretch the burst by at most a
    // couple of tokens over the loop's wall time — timing-robust).
    let throttled: { status: number; body: Record<string, unknown> } | null = null;
    for (let i = 0; i < 40 && throttled === null; i += 1) {
      const res = await clientFetch(h.gateway, "POST", "/net-api/ws-ticket", { token, body: { session: sid } });
      if (res.status === 429) throttled = res;
      else expect(res.status, `ticket ${i}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    expect(throttled, "amplifier bucket never throttled in 40 rapid mints").not.toBeNull();
    expect(throttled?.body.error).toMatchObject({ code: "E_RATE" });

    // The STANDARD bucket is untouched by amplifier exhaustion: a plain
    // read still authenticates and dispatches (401 session_required).
    const read = await clientFetch(h.gateway, "GET", "/net-api/cell?key=object_live:capi_box", { token });
    expect(read.status).toBe(401);

    h.close();
  });
});

describe("/net-api/audit — the customer query surface (audit.md AU7/AU10.5)", () => {
  it("a customer sees exactly their partition; naming another partition is a named refusal; the operator may name any", async () => {
    const h = await buildHarness();
    // Mint a session and commit one turn so the acting partition has a record.
    const session = await clientFetch(h.gateway, "POST", "/net-api/session", {
      token: `apikey:${KEY_ID}:${KEY_SECRET}`,
      body: {}
    });
    expect(session.status).toBe(200);
    const turn = await clientFetch(h.gateway, "POST", "/net-api/turn", {
      token: `apikey:${KEY_ID}:${KEY_SECRET}`,
      body: { target: "capi_box", verb: "bump", session: (session.body as { session?: string }).session }
    });
    expect(turn.status).toBe(200);
    // Kick pending scope drains (fake lane: no alarms), then settle.
    await clientFetch(h.gateway, "POST", "/net-api/turn", {
      token: `apikey:${KEY_ID}:${KEY_SECRET}`,
      body: { target: "capi_box", verb: "bump", session: (session.body as { session?: string }).session }
    });
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));

    // AU10.5: the caller's own partition is implicit and populated...
    const mine = await clientFetch(h.gateway, "POST", "/net-api/audit", {
      token: `apikey:${KEY_ID}:${KEY_SECRET}`,
      body: {}
    });
    expect(mine.status).toBe(200);
    expect(mine.body.partition).toBe("acct_capi");
    const records = mine.body.records as Array<{ outcome: string; action: { verb?: string } }>;
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.outcome === "ok")).toBe(true);

    // ...naming someone else's partition is refused at identity level...
    const stolen = await clientFetch(h.gateway, "POST", "/net-api/audit", {
      token: `apikey:${KEY_ID}:${KEY_SECRET}`,
      body: { partition: "acct_other" }
    });
    expect(stolen.status).toBe(403);

    // ...and the other customer's partition holds none of these records.
    const theirs = await clientFetch(h.gateway, "POST", "/net-api/audit", {
      token: "apikey:capi-key-2:capi-secret-2",
      body: {}
    });
    expect(theirs.status).toBe(200);
    expect(theirs.body.partition).toBe("acct_other");
    expect(theirs.body.records).toEqual([]);
    h.close();
  });

  it("a refused credential lands as a gateway edge record in the operator partition (AU1.2)", async () => {
    const h = await buildHarness();
    const refused = await clientFetch(h.gateway, "GET", "/net-api/cell?key=object_live:capi_box", {
      token: "apikey:no-such-key:nope"
    });
    expect(refused.status).toBe(401);
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const { signInternalRequest } = await import("../../src/worker/internal-auth");
    const req = new Request("https://do/net/audit-query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partition: "operator", outcome: "unknown_or_revoked" })
    });
    const res = (await (await h.auditDO.fetch(await signInternalRequest(h.scopeEnv, req))).json()) as {
      records: Array<{ principal?: { attribution?: string; credential?: string } }>;
    };
    expect(res.records.length).toBeGreaterThan(0);
    expect(res.records[0]?.principal).toMatchObject({ attribution: "credentialed", credential: "no-such-key" });
    h.close();
  });
});

describe("AU10.3 join gate: one trace id across gateway span, scope span, and audit record", () => {
  it("an adopted sampled traceparent joins net.turn, net.commit, and the audit record", async () => {
    const h = await buildHarness();
    const TRACEPARENT = "00-feedfacefeedfacefeedfacefeedface-a1b2c3d4e5f60718-01";
    const spanLines: Array<Record<string, unknown>> = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      if (args[0] === "woo.span" && typeof args[1] === "string") {
        spanLines.push(JSON.parse(args[1]) as Record<string, unknown>);
      }
    });
    try {
      const session = await clientFetch(h.gateway, "POST", "/net-api/session", {
        token: `apikey:${KEY_ID}:${KEY_SECRET}`,
        body: {}
      });
      const turn = await clientFetch(h.gateway, "POST", "/net-api/turn", {
        token: `apikey:${KEY_ID}:${KEY_SECRET}`,
        headers: { traceparent: TRACEPARENT },
        body: { target: "capi_box", verb: "bump", session: (session.body as { session?: string }).session }
      });
      expect(turn.status).toBe(200);
    } finally {
      // Deterministic settle: poll the audit partition (each query's
      // cluster warm also kicks the scope's pending drains) until the
      // record lands — no arbitrary sleeps.
      logSpy.mockRestore();
    }

    const traceId = "feedfacefeedfacefeedfacefeedface";
    let records: Array<{
      outcome: string;
      idempotency: string;
      trace_id?: string;
      principal?: { customer?: string };
      action: { kind: string; verb?: string; scope?: string; seq?: number };
    }> = [];
    for (let attempt = 0; attempt < 40 && records.length === 0; attempt += 1) {
      const mine = await clientFetch(h.gateway, "POST", "/net-api/audit", {
        token: `apikey:${KEY_ID}:${KEY_SECRET}`,
        body: { trace_id: traceId }
      });
      expect(mine.status).toBe(200);
      records = mine.body.records as typeof records;
      if (records.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Exact record: THE committed turn, attributed and cited.
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toMatchObject({
      outcome: "ok",
      trace_id: traceId,
      principal: { customer: "acct_capi" },
      action: { kind: "commit", verb: "bump" }
    });
    expect(record.idempotency).toBe(`${record.action.scope}:${record.action.seq}`);

    // Exact span relationships: the fresh commit span is net.commit (a
    // replay would be net.scope.submit), and BOTH spans hang under the
    // adopted caller's span id — one connected trace.
    const traced = spanLines.filter((s) => s.trace_id === traceId);
    const turnSpan = traced.find((s) => s.name === "net.turn");
    const commitSpan = traced.find((s) => s.name === "net.commit");
    expect(turnSpan?.parent_span_id).toBe("a1b2c3d4e5f60718");
    expect(commitSpan?.parent_span_id).toBe("a1b2c3d4e5f60718");
    expect((commitSpan?.attributes as Record<string, unknown>)?.["woo.seq"]).toBe(record.action.seq);
    // Structural validity (review finding 1): children contained in roots.
    for (const span of traced) {
      expect((span.end_ms as number) >= (span.start_ms as number)).toBe(true);
    }
    const rootSpan = turnSpan as { span_id?: string; start_ms?: number; end_ms?: number };
    for (const child of traced.filter((s) => s.parent_span_id === rootSpan.span_id)) {
      expect(child.start_ms as number).toBeGreaterThanOrEqual(rootSpan.start_ms as number);
      expect(child.end_ms as number).toBeLessThanOrEqual(rootSpan.end_ms as number);
    }
    h.close();
  });
});
