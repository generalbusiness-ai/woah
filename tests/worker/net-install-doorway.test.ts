// The /net-install doorway at the ROUTE level (review blocker 4): the
// production install conduit is the highest-risk trust boundary on the
// worker edge, so its guarantees are pinned against the REAL
// `worker.fetch` routing — signature gate, method/path allow-list, body
// cap, epoch-downgrade refusal, probe/install forwarding, and secret-safe
// error text — not against the DO handlers the route forwards to
// (tests/worker/net-install.test.ts covers those).
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { FakeDurableObjectState } from "./fake-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import type { Env } from "../../src/worker/persistent-object-do";

const SECRET = "net-install-doorway-secret";
const EPOCH = "cat-doorway-1";

function buildHarness() {
  const states: FakeDurableObjectState[] = [];
  const scopeStates = new Map<string, FakeDurableObjectState>();
  const scopeDOs = new Map<string, NetScopeDO>();
  const resolve = (destination: string) => {
    if (!destination.startsWith("scope:")) throw new Error(`unexpected destination ${destination}`);
    const name = destination.slice("scope:".length);
    let instance = scopeDOs.get(name);
    if (!instance) {
      const fake = new FakeDurableObjectState(`scope-${name}`);
      states.push(fake);
      scopeStates.set(name, fake);
      const state: NetScopeDurableState = {
        id: fake.id,
        waitUntil: () => {},
        storage: {
          sql: fake.storage.sql,
          transactionSync: fake.storage.transactionSync,
          setAlarm: () => {},
          deleteAlarm: () => {}
        }
      };
      instance = new NetScopeDO(state, { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve } as NetScopeEnv);
      scopeDOs.set(name, instance);
    }
    return instance;
  };
  const env = {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: resolve
  } as unknown as Env;
  return {
    env,
    request: async (path: string, init?: RequestInit) => worker.fetch(new Request(`https://woo.test${path}`, init), env, {} as never),
    signedRequest: async (path: string, init?: RequestInit) =>
      worker.fetch(await signInternalRequest({ WOO_INTERNAL_SECRET: SECRET }, new Request(`https://woo.test${path}`, init)), env, {} as never),
    scopeStates,
    close: () => states.forEach((state) => state.close())
  };
}

const seedBody = (scope: string, epoch = EPOCH, cells: unknown[] = []) =>
  ({
    method: "POST" as const,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope, catalog_epoch: epoch, cells })
  });

describe("the /net-install doorway (route level)", () => {
  it("probes the edge and catalog DO signing path without creating world authority", async () => {
    const h = buildHarness();
    const response = await h.signedRequest("/net-install/probe");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "net-scope" });

    const catalog = h.scopeStates.get("catalog");
    expect(catalog, "probe must route specifically to the catalog scope").toBeDefined();
    const meta = catalog!.storage.sql.exec("SELECT body FROM net_scope_meta WHERE id = 'meta'").toArray();
    const cells = catalog!.storage.sql.exec("SELECT key FROM net_scope_cell").toArray();
    expect(meta).toEqual([]);
    expect(cells).toEqual([]);
    h.close();
  });

  it("gates on the internal signature: unsigned, tampered, and header-injection callers are refused", async () => {
    const h = buildHarness();
    // Unsigned.
    const unsigned = await h.request("/net-install/scope/room%3Ax/seed", seedBody("room:x"));
    expect(unsigned.status).toBe(401);
    // A forged internal header on an unsigned request is STRIPPED by edge
    // sanitization before verification, never trusted.
    const forged = await h.request("/net-install/scope/room%3Ax/seed", {
      ...seedBody("room:x"),
      headers: { "content-type": "application/json", "x-woo-internal-signature": "sig-of-nothing" }
    });
    expect(forged.status).toBe(401);
    // A signature computed with the WRONG secret is refused.
    const wrongSecret = await worker.fetch(
      await signInternalRequest(
        { WOO_INTERNAL_SECRET: "not-the-secret" },
        new Request("https://woo.test/net-install/scope/room%3Ax/seed", seedBody("room:x"))
      ),
      h.env,
      {} as never
    );
    expect(wrongSecret.status).toBe(401);
    // Refusal text never echoes the configured secret.
    for (const response of [unsigned, forged, wrongSecret]) {
      expect(await response.clone().text()).not.toContain(SECRET);
    }
    h.close();
  });

  it("replay boundary: a stale-timestamped signature is refused; an in-window replay is idempotent by construction", async () => {
    const h = buildHarness();
    // The signature binds method+path+body-sha+timestamp with a ±5min
    // skew window (internal-auth.ts INTERNAL_SKEW_MS). Outside the
    // window a captured request is dead.
    const stale = await signInternalRequest(
      { WOO_INTERNAL_SECRET: SECRET },
      new Request("https://woo.test/net-install/scope/room%3Areplay/seed", seedBody("room:replay"))
    );
    const headers = new Headers(stale.headers);
    headers.set("x-woo-internal-ts", String(Date.now() - 10 * 60_000));
    // Re-stamping the ts breaks the HMAC too, but pin the WINDOW rule by
    // re-signing at the old timestamp via a fresh signed request whose
    // clock we shift: simplest honest probe is the tampered-ts refusal.
    const tampered = await worker.fetch(new Request(stale, { headers }), h.env, {} as never);
    expect(tampered.status).toBe(401);
    // WITHIN the window, a byte-identical replay of a real seed is safe:
    // the M9 same-epoch guard makes it a no-op-shaped success (the
    // install pipeline's own retry posture), so replay confers nothing.
    const cells = [{ kind: "object_lineage", object: "replay_obj", value: { parent: null, owner: "replay_obj", name: "R", anchor: null, flags: {} } }];
    const original = await signInternalRequest(
      { WOO_INTERNAL_SECRET: SECRET },
      new Request("https://woo.test/net-install/scope/room%3Areplay/seed", seedBody("room:replay", EPOCH, cells))
    );
    const first = await worker.fetch(original.clone(), h.env, {} as never);
    expect(first.status, await first.clone().text()).toBe(200);
    const replayed = await worker.fetch(original, h.env, {} as never);
    expect(replayed.status).toBe(200);
    const head = await h.signedRequest("/net-install/scope/room%3Areplay/head");
    expect(((await head.json()) as { catalog_epoch?: string }).catalog_epoch).toBe(EPOCH);
    h.close();
  });

  it("allow-lists probe (GET), scope install verbs, and no wider scope RPC surface", async () => {
    const h = buildHarness();
    // Wrong verb on a valid path shape.
    expect((await h.signedRequest("/net-install/scope/room%3Ax/subscribe", seedBody("room:x"))).status).toBe(404);
    // Wrong method for the verb.
    expect((await h.signedRequest("/net-install/scope/room%3Ax/seed")).status).toBe(404);
    expect((await h.signedRequest("/net-install/scope/room%3Ax/head", seedBody("room:x"))).status).toBe(404);
    expect((await h.signedRequest("/net-install/probe", { method: "POST" })).status).toBe(404);
    // Wrong kind and truncated paths.
    expect((await h.signedRequest("/net-install/gateway/g1/seed", seedBody("room:x"))).status).toBe(404);
    expect((await h.signedRequest("/net-install/scope//seed", seedBody("room:x"))).status).toBe(404);
    expect((await h.signedRequest("/net-install/scope/room%3Ax/seed/extra", seedBody("room:x"))).status).toBe(404);
    h.close();
  });

  it("bounds the request body: an over-cap seed is refused, not forwarded", async () => {
    const h = buildHarness();
    // 8MiB cap (NET_SMOKE_MAX_BODY_BYTES); the declared content-length
    // trips the guard before the body is read.
    const oversized = await h.signedRequest("/net-install/scope/room%3Ax/seed", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(9 * 1024 * 1024) },
      body: JSON.stringify({ scope: "room:x", catalog_epoch: EPOCH, cells: [] })
    });
    expect([413, 429]).toContain(oversized.status);
    h.close();
  });

  it("forwards seed and head faithfully, and surfaces the scope's epoch-downgrade refusal", async () => {
    const h = buildHarness();
    const cells = [{ kind: "object_lineage", object: "doorway_obj", value: { parent: null, owner: "doorway_obj", name: "Doorway", anchor: null, flags: {} } }];
    const seeded = await h.signedRequest("/net-install/scope/room%3Adoor/seed", seedBody("room:door", EPOCH, cells));
    expect(seeded.status, await seeded.clone().text()).toBe(200);
    expect((await seeded.json()) as object).toMatchObject({ ok: true, scope: "room:door" });

    const head = await h.signedRequest("/net-install/scope/room%3Adoor/head");
    expect(head.status).toBe(200);
    expect(((await head.json()) as { catalog_epoch?: string }).catalog_epoch).toBe(EPOCH);

    // M9 epoch guard, surfaced THROUGH the route: a different-epoch
    // re-seed refuses rather than silently mixing worlds — the doorway
    // must relay the named verdict, not wrap it.
    const downgraded = await h.signedRequest("/net-install/scope/room%3Adoor/seed", seedBody("room:door", "cat-older-0", cells));
    expect(downgraded.ok).toBe(false);
    expect(await downgraded.clone().text()).toContain("E_EPOCH_MISMATCH");
    h.close();
  });

  it("repairs initial contents rows through the signed add-only operator path", async () => {
    const h = buildHarness();
    const room = {
      kind: "object_lineage",
      object: "repair_room",
      value: { parent: "$space", owner: "$wiz", name: "Repair Room", anchor: null, flags: {} }
    };
    const seeded = await h.signedRequest("/net-install/scope/room%3Arepair_room/seed", seedBody("room:repair_room", EPOCH, [room]));
    expect(seeded.status, await seeded.clone().text()).toBe(200);
    const repairBody = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        relations: [{ relation: "contents", owner: "repair_room", member: "mounted_tool" }]
      })
    };
    const repaired = await h.signedRequest("/net-install/scope/room%3Arepair_room/repair-relations", repairBody);
    expect(repaired.status, await repaired.clone().text()).toBe(200);
    expect(await repaired.json()).toMatchObject({ ok: true, status: "applied", changed: ["relation:contents:repair_room:mounted_tool"] });
    const replayed = await h.signedRequest("/net-install/scope/room%3Arepair_room/repair-relations", repairBody);
    expect(await replayed.json()).toMatchObject({ ok: true, status: "empty", changed: [] });
    const rows = h.scopeStates.get("room:repair_room")!.storage.sql.exec("SELECT body FROM net_scope_relation").toArray();
    expect(rows).toHaveLength(1);
    h.close();
  });

  it("repairs only existing bootstrap verb pages at catalog authority and replays idempotently", async () => {
    const h = buildHarness();
    const original = {
      kind: "verb_bytecode",
      object: "$player",
      name: "ways",
      value: { name: "ways", bytecode: [{ op: "RETURN", value: "old" }], arg_spec: { args: ["room?"] } }
    };
    const seeded = await h.signedRequest("/net-install/scope/catalog/seed", seedBody("catalog", EPOCH, [original]));
    expect(seeded.status, await seeded.clone().text()).toBe(200);
    // Model an already-subscribed gateway without letting the fake resolve
    // drain it; the operator event must enter the same durable fanout lane as
    // ordinary catalog authority changes.
    h.scopeStates.get("catalog")!.storage.sql.exec(
      "INSERT INTO net_scope_subscribers (destination, role) VALUES ('gateway:aged', 'fanout')"
    );
    const replacement = {
      ...original,
      value: {
        name: "ways",
        bytecode: [{ op: "RETURN", value: "complete" }],
        arg_spec: { args: ["room?"], authority: { prefetch: ["scope", { path: ["scope", "exits"] }] } }
      }
    };
    const body = {
      method: "POST" as const,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cells: [replacement] })
    };

    expect((await h.request("/net-install/scope/catalog/repair-definitions", body)).status).toBe(401);
    const repaired = await h.signedRequest("/net-install/scope/catalog/repair-definitions", body);
    expect(repaired.status, await repaired.clone().text()).toBe(200);
    expect(await repaired.json()).toMatchObject({
      ok: true,
      scope: "catalog",
      status: "applied",
      head: { seq: 1 },
      changed: ["verb_bytecode:$player:ways"]
    });
    const replayed = await h.signedRequest("/net-install/scope/catalog/repair-definitions", body);
    expect(await replayed.json()).toMatchObject({ ok: true, status: "empty", head: { seq: 1 }, changed: [] });
    const durable = h.scopeStates.get("catalog")!.storage.sql;
    const stored = durable.exec("SELECT body FROM net_scope_cell WHERE key = 'verb_bytecode:$player:ways'").toArray();
    expect(JSON.parse(String(stored[0]!.body))).toMatchObject({ value: replacement.value, stamp: { scope_head: expect.stringMatching(/^1:/) } });
    expect(durable.exec("SELECT seq FROM net_scope_tail ORDER BY seq").toArray()).toEqual([{ seq: 1 }]);
    const fanout = durable.exec("SELECT body FROM net_scope_outbox WHERE route = '/fanout'").toArray();
    expect(JSON.parse(String(fanout[0]!.body))).toMatchObject({
      scope: "catalog",
      seq: 1,
      delivery_seq: 1,
      cells: [{ key: "verb_bytecode:$player:ways", value: replacement.value }]
    });

    const wrongScope = await h.signedRequest("/net-install/scope/room%3Ax/seed", seedBody("room:x", EPOCH, [original]));
    expect(wrongScope.status).toBe(200);
    expect((await h.signedRequest("/net-install/scope/room%3Ax/repair-definitions", body)).status).toBe(400);
    const missing = { ...replacement, name: "missing" };
    expect((await h.signedRequest("/net-install/scope/catalog/repair-definitions", {
      ...body,
      body: JSON.stringify({ cells: [missing] })
    })).status).toBe(400);
    const property = { kind: "property_cell", object: "$player", name: "ways", value: { value: "no" } };
    expect((await h.signedRequest("/net-install/scope/catalog/repair-definitions", {
      ...body,
      body: JSON.stringify({ cells: [property] })
    })).status).toBe(400);
    expect((await h.signedRequest("/net-install/scope/catalog/repair-definitions", {
      ...body,
      body: JSON.stringify({ cells: [null] })
    })).status).toBe(400);
    expect((await h.signedRequest("/net-install/scope/catalog/repair-definitions", {
      ...body,
      body: JSON.stringify({ cells: [{ ...replacement, value: { ...replacement.value, name: "not_ways" } }] })
    })).status).toBe(400);
    h.close();
  });

  it("malformed seed bodies surface as errors, not crashes or silent success", async () => {
    const h = buildHarness();
    const malformed = await h.signedRequest("/net-install/scope/room%3Abad/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json"
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.status).toBeLessThan(500 + 1); // any error verdict, never a hang
    // And the scope stays unseeded: its head reports no epoch adoption.
    const head = await h.signedRequest("/net-install/scope/room%3Abad/head");
    const headBody = (await head.json()) as { catalog_epoch?: string };
    expect(headBody.catalog_epoch).not.toBe(EPOCH);
    h.close();
  });
});
