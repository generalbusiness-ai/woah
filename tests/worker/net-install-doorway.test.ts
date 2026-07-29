// The /net-install doorway at the ROUTE level (review blocker 4): the
// production install conduit is the highest-risk trust boundary on the
// worker edge, so its guarantees are pinned against the REAL
// `worker.fetch` routing — signature gate, method/path allow-list, body
// cap, epoch-downgrade refusal, probe/install forwarding, and secret-safe
// error text — not against the DO handlers the route forwards to
// (tests/worker/net-install.test.ts covers those).
import { describe, expect, it } from "vitest";
import worker, { type NetOnlyEnv } from "../../src/worker/net-only-index";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { closeQuiescent, quiescentNetState, type QuiescentHost } from "./quiescent-do";

const SECRET = "net-install-doorway-secret";
const EPOCH = "cat-doorway-1";

function buildHarness() {
  const states: QuiescentHost[] = [];
  const scopeStates = new Map<string, QuiescentHost>();
  const scopeDOs = new Map<string, NetScopeDO>();
  const resolve = (destination: string) => {
    if (!destination.startsWith("scope:")) throw new Error(`unexpected destination ${destination}`);
    const name = destination.slice("scope:".length);
    let instance = scopeDOs.get(name);
    if (!instance) {
      const host = quiescentNetState(`scope-${name}`);
      states.push(host);
      scopeStates.set(name, host);
      instance = new NetScopeDO(host.state as NetScopeDurableState, { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve } as NetScopeEnv);
      scopeDOs.set(name, instance);
    }
    return instance;
  };
  const env = {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: resolve
  } as unknown as NetOnlyEnv;
  return {
    env,
    request: async (path: string, init?: RequestInit) => worker.fetch(new Request(`https://woo.test${path}`, init), env),
    signedRequest: async (path: string, init?: RequestInit) =>
      worker.fetch(await signInternalRequest({ WOO_INTERNAL_SECRET: SECRET }, new Request(`https://woo.test${path}`, init)), env),
    scopeStates,
    close: async () => closeQuiescent(states)
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
    const meta = catalog!.state.storage.sql.exec("SELECT body FROM net_scope_meta WHERE id = 'meta'").toArray();
    const cells = catalog!.state.storage.sql.exec("SELECT key FROM net_scope_cell").toArray();
    expect(meta).toEqual([]);
    expect(cells).toEqual([]);
    await h.close();
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
      h.env
    );
    expect(wrongSecret.status).toBe(401);
    // Refusal text never echoes the configured secret.
    for (const response of [unsigned, forged, wrongSecret]) {
      expect(await response.clone().text()).not.toContain(SECRET);
    }
    await h.close();
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
    const tampered = await worker.fetch(new Request(stale, { headers }), h.env);
    expect(tampered.status).toBe(401);
    // WITHIN the window, a byte-identical replay of a real seed is safe:
    // the M9 same-epoch guard makes it a no-op-shaped success (the
    // install pipeline's own retry posture), so replay confers nothing.
    const cells = [{ kind: "object_lineage", object: "replay_obj", value: { parent: null, owner: "replay_obj", name: "R", anchor: null, flags: {} } }];
    const original = await signInternalRequest(
      { WOO_INTERNAL_SECRET: SECRET },
      new Request("https://woo.test/net-install/scope/room%3Areplay/seed", seedBody("room:replay", EPOCH, cells))
    );
    const first = await worker.fetch(original.clone(), h.env);
    expect(first.status, await first.clone().text()).toBe(200);
    const replayed = await worker.fetch(original, h.env);
    expect(replayed.status).toBe(200);
    const head = await h.signedRequest("/net-install/scope/room%3Areplay/head");
    expect(((await head.json()) as { catalog_epoch?: string }).catalog_epoch).toBe(EPOCH);
    await h.close();
  });

  it("allow-lists probe (GET), scope install verbs, and no wider scope RPC surface", async () => {
    const h = buildHarness();
    // Wrong verb on a valid path shape.
    expect((await h.signedRequest("/net-install/scope/room%3Ax/subscribe", seedBody("room:x"))).status).toBe(404);
    expect((await h.signedRequest("/net-install/scope/room%3Ax/repair-verb-slot", seedBody("room:x"))).status).toBe(404);
    // Wrong method for the verb.
    expect((await h.signedRequest("/net-install/scope/room%3Ax/seed")).status).toBe(404);
    expect((await h.signedRequest("/net-install/scope/room%3Ax/head", seedBody("room:x"))).status).toBe(404);
    expect((await h.signedRequest("/net-install/probe", { method: "POST" })).status).toBe(404);
    // Wrong kind and truncated paths.
    expect((await h.signedRequest("/net-install/gateway/g1/seed", seedBody("room:x"))).status).toBe(404);
    expect((await h.signedRequest("/net-install/scope//seed", seedBody("room:x"))).status).toBe(404);
    expect((await h.signedRequest("/net-install/scope/room%3Ax/seed/extra", seedBody("room:x"))).status).toBe(404);
    await h.close();
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
    await h.close();
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
    await h.close();
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
    const rows = h.scopeStates.get("room:repair_room")!.state.storage.sql.exec("SELECT body FROM net_scope_relation").toArray();
    expect(rows).toHaveLength(1);
    await h.close();
  });

  it("repairs bootstrap definition pages at catalog authority and replays idempotently", async () => {
    const h = buildHarness();
    const playerLineage = {
      kind: "object_lineage",
      object: "$player",
      value: { parent: null, owner: "$wiz", name: "$player", anchor: null, flags: {} }
    };
    const original = {
      kind: "verb_bytecode",
      object: "$player",
      name: "ways",
      value: { name: "ways", bytecode: [{ op: "RETURN", value: "old" }], arg_spec: { args: ["room?"] } }
    };
    const retired = {
      kind: "verb_bytecode",
      object: "$player",
      name: "retired",
      value: { name: "retired", bytecode: [{ op: "RETURN", value: "legacy" }], arg_spec: { args: [] } }
    };
    const retiredProperty = {
      kind: "property_cell",
      object: "$player",
      name: "legacy_slot",
      value: {
        value: null,
        def: { name: "legacy_slot", defaultValue: null, typeHint: "obj|null", owner: "$wiz", perms: "r", version: 1 }
      }
    };
    const seeded = await h.signedRequest(
      "/net-install/scope/catalog/seed",
      seedBody("catalog", EPOCH, [playerLineage, original, retired, retiredProperty])
    );
    expect(seeded.status, await seeded.clone().text()).toBe(200);
    // Model an already-subscribed gateway without letting the fake resolve
    // drain it; the operator event must enter the same durable fanout lane as
    // ordinary catalog authority changes.
    //
    // `gateway:aged` is DELIBERATELY unresolvable: the assertion below reads
    // the retained `net_scope_outbox` row, which only survives because the
    // delivery fails. So this test emits one expected
    // `net_scope_outbox_delivery_failed` ("unexpected destination
    // gateway:aged") -- inside the test body, against live storage, not after
    // teardown. Do not confuse it with the post-close `database is not open`
    // family that tests/worker/quiescent-do.ts exists to eliminate.
    h.scopeStates.get("catalog")!.state.storage.sql.exec(
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
    const replacementProperty = {
      kind: "property_cell",
      object: "$player",
      name: "current_slot",
      value: {
        value: null,
        def: { name: "current_slot", defaultValue: null, typeHint: "obj|null", owner: "$wiz", perms: "r", version: 1 }
      }
    };
    const body = {
      method: "POST" as const,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cells: [replacement, replacementProperty],
        remove: [
          { kind: "verb_bytecode", object: "$player", name: "retired" },
          { kind: "property_cell", object: "$player", name: "legacy_slot" }
        ]
      })
    };

    expect((await h.request("/net-install/scope/catalog/repair-definitions", body)).status).toBe(401);
    const repaired = await h.signedRequest("/net-install/scope/catalog/repair-definitions", body);
    expect(repaired.status, await repaired.clone().text()).toBe(200);
    expect(await repaired.json()).toMatchObject({
      ok: true,
      scope: "catalog",
      status: "applied",
      head: { seq: 1 },
      changed: [
        "property_cell:$player:current_slot",
        "property_cell:$player:legacy_slot",
        "verb_bytecode:$player:retired",
        "verb_bytecode:$player:ways"
      ],
      removed: ["verb_bytecode:$player:retired", "property_cell:$player:legacy_slot"]
    });
    const replayed = await h.signedRequest("/net-install/scope/catalog/repair-definitions", body);
    expect(await replayed.json()).toMatchObject({ ok: true, status: "empty", head: { seq: 1 }, changed: [], removed: [] });
    const durable = h.scopeStates.get("catalog")!.state.storage.sql;
    const stored = durable.exec("SELECT body FROM net_scope_cell WHERE key = 'verb_bytecode:$player:ways'").toArray();
    expect(JSON.parse(String(stored[0]!.body))).toMatchObject({ value: replacement.value, stamp: { scope_head: expect.stringMatching(/^1:/) } });
    const storedProperty = durable.exec("SELECT body FROM net_scope_cell WHERE key = 'property_cell:$player:current_slot'").toArray();
    expect(JSON.parse(String(storedProperty[0]!.body))).toMatchObject({
      value: replacementProperty.value,
      stamp: { scope_head: expect.stringMatching(/^1:/) }
    });
    expect(durable.exec("SELECT body FROM net_scope_cell WHERE key = 'verb_bytecode:$player:retired'").toArray()).toHaveLength(0);
    expect(durable.exec("SELECT body FROM net_scope_cell WHERE key = 'property_cell:$player:legacy_slot'").toArray()).toHaveLength(0);
    expect(durable.exec("SELECT seq FROM net_scope_tail ORDER BY seq").toArray()).toEqual([{ seq: 1 }]);
    const fanout = durable.exec("SELECT body FROM net_scope_outbox WHERE route = '/fanout'").toArray();
    expect(JSON.parse(String(fanout[0]!.body))).toMatchObject({
      scope: "catalog",
      seq: 1,
      delivery_seq: 1,
      cells: [
        { key: "verb_bytecode:$player:ways", value: replacement.value },
        { key: "property_cell:$player:current_slot", value: replacementProperty.value }
      ],
      removed_cells: ["verb_bytecode:$player:retired", "property_cell:$player:legacy_slot"]
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
    expect((await h.signedRequest("/net-install/scope/catalog/repair-definitions", {
      ...body,
      body: JSON.stringify({
        cells: [replacement],
        remove: [{ kind: "verb_bytecode", object: "$player", name: "ways" }]
      })
    })).status).toBe(400);
    expect((await h.signedRequest("/net-install/scope/catalog/repair-definitions", {
      ...body,
      body: JSON.stringify({
        cells: [],
        remove: [{ kind: "verb_bytecode", object: "$missing_class", name: "retired" }]
      })
    })).status).toBe(400);
    await h.close();
  });

  it("gates and merges the seed-property repair: signed, owned, fingerprint-gated, idempotent", async () => {
    const h = buildHarness();
    const lineage = { kind: "object_lineage", object: "$helpdb", value: { parent: "$thing", owner: "$wiz" } };
    // The aged stored map: one superseded default, one operator edit, one
    // untouched entry; the shipped additions are absent.
    const agedCell = {
      kind: "property_cell",
      object: "$helpdb",
      name: "topics",
      value: { value: { stale: ["old text"], edited: ["operator text"], keep: ["kept"] } }
    };
    const seeded = await h.signedRequest("/net-install/scope/catalog/seed", seedBody("catalog", EPOCH, [lineage, agedCell]));
    expect(seeded.status, await seeded.clone().text()).toBe(200);

    const entries = [{
      object: "$helpdb",
      property: "topics",
      value: { stale: ["new text"], edited: ["shipped text"], added: ["brand new"] },
      supersedes: { stale: [["old text"]], edited: [["shipped default the operator replaced"]] }
    }];
    const body = {
      method: "POST" as const,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries })
    };

    // Signature gate, then a dry run that mutates nothing.
    expect((await h.request("/net-install/scope/catalog/repair-seed-properties", body)).status).toBe(401);
    const sized = await h.signedRequest("/net-install/scope/catalog/repair-seed-properties", {
      ...body,
      body: JSON.stringify({ entries, dry_run: true })
    });
    expect(sized.status, await sized.clone().text()).toBe(200);
    expect(await sized.json()).toMatchObject({ ok: true, status: "would_apply", dry_run: true, changed: ["property_cell:$helpdb:topics"] });

    const repaired = await h.signedRequest("/net-install/scope/catalog/repair-seed-properties", body);
    expect(repaired.status, await repaired.clone().text()).toBe(200);
    expect(await repaired.json()).toMatchObject({
      ok: true,
      scope: "catalog",
      status: "applied",
      head: { seq: 1 },
      changed: ["property_cell:$helpdb:topics"]
    });
    const durable = h.scopeStates.get("catalog")!.state.storage.sql;
    const stored = durable.exec("SELECT body FROM net_scope_cell WHERE key = 'property_cell:$helpdb:topics'").toArray();
    expect(JSON.parse(String(stored[0]!.body))).toMatchObject({
      value: {
        value: {
          stale: ["new text"],        // superseded default upgraded
          edited: ["operator text"],  // operator edit preserved
          keep: ["kept"],             // unrelated key untouched
          added: ["brand new"]        // shipped addition landed
        }
      },
      stamp: { scope_head: expect.stringMatching(/^1:/) }
    });

    // Replay is empty — after one merge every key is converged or edited.
    const replayed = await h.signedRequest("/net-install/scope/catalog/repair-seed-properties", body);
    expect(await replayed.json()).toMatchObject({ ok: true, status: "empty", changed: [], skipped: ["property_cell:$helpdb:topics"] });

    // Rejections: unowned object, non-$ object, malformed entries and bounds.
    const reject = async (payload: unknown) => {
      const response = await h.signedRequest("/net-install/scope/catalog/repair-seed-properties", {
        ...body,
        body: JSON.stringify(payload)
      });
      expect(response.status).toBe(400);
    };
    await reject({ entries: [{ ...entries[0], object: "$not_seeded_here" }] });
    await reject({ entries: [{ ...entries[0], object: "plainobj" }] });
    await reject({ entries: [{ ...entries[0], value: ["not", "a", "map"] }] });
    await reject({ entries: [{ ...entries[0], supersedes: { stale: "not-a-list" } }] });
    await reject({ entries: [] });
    await reject({ entries: Array.from({ length: 33 }, () => entries[0]) });
    await h.close();
  });

  // Aged-world verb-slot repair (CO4.7). Worlds authored before 2026-07-27 hold
  // objects whose verb pages share an ordinal, because the Net authoring path
  // could not see an object's other pages. This op renumbers them into the
  // order the system already resolves — slot then name — which is
  // behaviour-preserving; it does not try to recover an insertion order nothing
  // recorded.
  it("renumbers aged duplicate verb slots, leaves healthy gaps alone, and replays empty", async () => {
    const h = buildHarness();
    const verb = (object: string, name: string, slot: number | undefined) => ({
      kind: "verb_bytecode",
      object,
      name,
      value: { kind: "bytecode", name, aliases: ["x*"], owner: "$wiz", perms: "rx", version: 1, ...(slot === undefined ? {} : { slot }) }
    });
    const cells = [
      { kind: "object_lineage", object: "aged_box", value: { parent: "$thing", owner: "$wiz" } },
      // The aged shape: three pages, all claiming slot 1.
      verb("aged_box", "zulu", 1), verb("aged_box", "alpha", 1), verb("aged_box", "mike", 1),
      // A HEALTHY object with a legitimate gap (its slot-2 verb was deleted).
      // Renumbering it would invalidate live slot descriptors for no gain.
      { kind: "object_lineage", object: "gapped_box", value: { parent: "$thing", owner: "$wiz" } },
      verb("gapped_box", "one", 1), verb("gapped_box", "three", 3)
    ];
    expect((await h.signedRequest("/net-install/scope/room%3Aaged/seed", seedBody("room:aged", EPOCH, cells))).status).toBe(200);

    const body = { method: "POST" as const, headers: { "content-type": "application/json" }, body: JSON.stringify({}) };
    expect((await h.request("/net-install/scope/room%3Aaged/repair-verb-slots", body)).status).toBe(401);

    const dry = await h.signedRequest("/net-install/scope/room%3Aaged/repair-verb-slots", {
      ...body, body: JSON.stringify({ dry_run: true })
    });
    expect(dry.status, await dry.clone().text()).toBe(200);
    expect(await dry.json()).toMatchObject({
      ok: true, status: "would_apply", dry_run: true, objects: ["aged_box"], remaining: 0
    });

    const repaired = await h.signedRequest("/net-install/scope/room%3Aaged/repair-verb-slots", body);
    expect(repaired.status, await repaired.clone().text()).toBe(200);
    expect(await repaired.json()).toMatchObject({
      ok: true, scope: "room:aged", status: "applied", objects: ["aged_box"],
      // Only the two pages whose ordinal actually moves are rewritten; `alpha`
      // already sorts first and keeps slot 1.
      changed: ["verb_bytecode:aged_box:mike", "verb_bytecode:aged_box:zulu"]
    });

    const durable = h.scopeStates.get("room:aged")!.state.storage.sql;
    const slotOf = (key: string) => {
      const rows = durable.exec(`SELECT body FROM net_scope_cell WHERE key = '${key}'`).toArray();
      return (JSON.parse(String(rows[0]!.body)) as { value: { slot?: number } }).value.slot;
    };
    // The order (slot, then name) the unrepaired object already resolved in —
    // alpha, mike, zulu — made explicit. No name resolves differently.
    expect([slotOf("verb_bytecode:aged_box:alpha"), slotOf("verb_bytecode:aged_box:mike"), slotOf("verb_bytecode:aged_box:zulu")])
      .toEqual([1, 2, 3]);
    // The healthy gap is untouched.
    expect(slotOf("verb_bytecode:gapped_box:three")).toBe(3);

    // Idempotent: a second run finds a distinct ascending set and does nothing.
    expect(await (await h.signedRequest("/net-install/scope/room%3Aaged/repair-verb-slots", body)).json())
      .toMatchObject({ ok: true, status: "empty", changed: [], objects: [] });

    // Bounds and ownership.
    const reject = async (payload: unknown) =>
      expect((await h.signedRequest("/net-install/scope/room%3Aaged/repair-verb-slots", {
        ...body, body: JSON.stringify(payload)
      })).status).toBe(400);
    await reject({ objects: [] });
    await reject({ objects: Array.from({ length: 33 }, () => "aged_box") });
    // An object this scope does not own is reported, never repaired here.
    expect(await (await h.signedRequest("/net-install/scope/room%3Aaged/repair-verb-slots", {
      ...body, body: JSON.stringify({ objects: ["elsewhere_box"] })
    })).json()).toMatchObject({ ok: true, status: "empty", skipped: ["elsewhere_box"] });
    await h.close();
  });

  it("keeps a production-sized definition repair in one ordered event", async () => {
    const h = buildHarness();
    const lineage = {
      kind: "object_lineage",
      object: "$repair_fixture",
      value: { parent: null, owner: "$wiz", name: "$repair_fixture", anchor: null, flags: {} }
    };
    expect((await h.signedRequest(
      "/net-install/scope/catalog/seed",
      seedBody("catalog", EPOCH, [lineage])
    )).status).toBe(200);

    // The Outliner v1→v2 production repair has 18 changes. Keep that batch
    // below the route's bounded ceiling so it advances exactly one catalog
    // head instead of exposing a partially upgraded definition surface.
    const definitions = Array.from({ length: 18 }, (_, index) => ({
      kind: "property_cell",
      object: "$repair_fixture",
      name: `slot_${index}`,
      value: {
        value: null,
        def: { name: `slot_${index}`, defaultValue: null, typeHint: "obj|null", owner: "$wiz", perms: "r", version: 1 }
      }
    }));
    const repaired = await h.signedRequest("/net-install/scope/catalog/repair-definitions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cells: definitions })
    });
    expect(repaired.status, await repaired.clone().text()).toBe(200);
    const repairedBody = await repaired.json() as { status: string; head: { seq: number }; changed: string[] };
    expect(repairedBody).toMatchObject({ status: "applied", head: { seq: 1 } });
    expect(repairedBody.changed).toHaveLength(18);

    const oversized = Array.from({ length: 33 }, (_, index) => ({ ...definitions[0], name: `too_many_${index}` }));
    expect((await h.signedRequest("/net-install/scope/catalog/repair-definitions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cells: oversized })
    })).status).toBe(400);
    await h.close();
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
    await h.close();
  });
});
