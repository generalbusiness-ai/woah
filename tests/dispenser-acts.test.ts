import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { installVerb } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import {
  installCatalogManifest,
  updateCatalogManifest,
  type CatalogManifest,
  type CatalogMigrationManifest
} from "../src/core/catalog-installer";
import { installLocalCatalogs } from "../src/core/local-catalogs";
import type { DirectResultFrame, ErrorFrame, WooValue } from "../src/core/types";
import { LocalSQLiteRepository } from "../src/server/sqlite-repository";

type World = ReturnType<typeof createWorld>;
type CallResult = DirectResultFrame | ErrorFrame;

function actorSession(world: World, actor: string): string {
  const session = Array.from(world.sessions.values()).find((candidate) => candidate.actor === actor);
  if (!session) throw new Error(`no session for ${actor}`);
  return session.id;
}

/** Dispenser mutations are anchored-actor Acts: the block composes while its
 * containing room owns the sequenced log. This is the production Net shape. */
async function mutate(
  world: World,
  requestId: string,
  actor: string,
  block: string,
  verb: "order" | "deliver" | "cancel",
  args: unknown[],
  logSpace = world.object(block).location!
): Promise<CallResult> {
  const frame = await world.call(requestId, actorSession(world, actor), logSpace, {
    actor,
    target: block,
    verb,
    args: args as WooValue[]
  });
  if (frame.op !== "applied") return frame as ErrorFrame;
  const observations = frame.observations ?? [];
  const error = observations.find((observation) => observation.type === "$error");
  if (error) return { op: "error", error: error as unknown as ErrorFrame["error"] };
  return { op: "result", result: frame.result ?? null, observations, audience: null };
}

function setup(id = "proof_dispenser") {
  const world = createWorld({ catalogs: false });
  installLocalCatalogs(world, ["dispenser"]);
  const room = `${id}_room`;
  world.createObject({ id: room, name: room, parent: "$space", owner: "$wiz", location: null });
  const ownerSession = world.auth(`guest:${id}-owner`);
  const requesterSession = world.auth(`guest:${id}-requester`);
  world.createObject({ id, name: "Proof Dispenser", parent: "$dispenser_block", owner: ownerSession.actor, location: room });
  world.setProp(id, "rate_limit_seconds", 0);
  world.setProp(id, "block_cooldown_seconds", 0);
  const key = world.createApiKey("$wiz", id, "proof-plug");
  const plugSession = world.auth(`apikey:${key.id}:${key.secret}`);
  return {
    world,
    room,
    block: id,
    owner: ownerSession.actor,
    requester: requesterSession.actor,
    plug: plugSession.actor
  };
}

function queueOf(world: World, block: string): string {
  const projections = world.getProp(block, "projections") as string[];
  expect(projections).toHaveLength(1);
  return projections[0]!;
}

async function order(ctx: ReturnType<typeof setup>, request: string, id: string) {
  const result = await mutate(ctx.world, id, ctx.requester, ctx.block, "order", [request]);
  expect(result.op, JSON.stringify(result)).toBe("result");
  if (result.op !== "result") throw new Error("order failed");
  return result;
}

async function prepare(
  ctx: ReturnType<typeof setup>,
  orderId: string,
  id: string,
  name: string,
  text: string,
  description: string | null = null
): Promise<string> {
  const result = await ctx.world.directCall(id, ctx.plug, ctx.block, "prepare_artifact", [
    orderId,
    name,
    text,
    description
  ]);
  expect(result.op).toBe("result");
  if (result.op !== "result") throw new Error("artifact preparation failed");
  const prepared = result.result as { prepared: boolean; note: string };
  expect(prepared.prepared).toBe(true);
  return prepared.note;
}

describe("Dispenser Acts authority and concise facts", () => {
  it("records a concise order Act and keeps queue state projection-owned", async () => {
    const ctx = setup();
    const result = await order(ctx, "scorpio", "ordered");
    const orderId = (result.result as { order_id: string }).order_id;
    const act = result.observations.find((observation) => observation.type === "dispenser.ordered");
    expect(act).toMatchObject({
      type: "dispenser.ordered",
      version: 1,
      source: ctx.block,
      payload: {
        order_id: orderId,
        request: "scorpio",
        artifact: expect.any(String)
      }
    });
    const payload = (act as unknown as { payload: Record<string, unknown> }).payload;
    expect(Object.keys(payload).sort()).toEqual([
      "artifact",
      "order_id",
      "request"
    ]);
    expect(ctx.world.propOrNull(ctx.block, "pending_orders")).toBeNull();
    const queue = queueOf(ctx.world, ctx.block);
    expect(ctx.world.getProp(queue, "rows")).toMatchObject({
      [orderId]: {
        order_id: orderId,
        requester: ctx.requester,
        request: "scorpio",
        artifact: payload.artifact
      }
    });
    const artifact = payload.artifact as string;
    expect(ctx.world.object(artifact).location).toBe(ctx.block);
    expect(ctx.world.getProp(artifact, "produced_by")).toBe(ctx.block);
    expect(ctx.world.getProp(artifact, "order_id")).toBe(orderId);
    expect(ctx.world.getProp(artifact, "text")).toBe("");
    expect(ctx.world.object(queue).location).toBe(ctx.room);
    expect(ctx.world.getProp(queue, "source_space")).toBe(ctx.block);
    expect(ctx.world.getProp(queue, "log_space")).toBe(ctx.room);
  });

  it("refuses direct, wrong-log, internal-helper, fold, and property-write bypasses", async () => {
    const ctx = setup("authority_dispenser");
    const direct = await ctx.world.directCall("direct-order", ctx.requester, ctx.block, "order", ["bypass"]);
    expect(direct.op).toBe("error");

    const otherRoom = "authority_other_room";
    ctx.world.createObject({ id: otherRoom, name: otherRoom, parent: "$space", owner: "$wiz", location: null });
    const wrongLog = await mutate(ctx.world, "wrong-log", ctx.requester, ctx.block, "order", ["bypass"], otherRoom);
    expect(wrongLog.op).toBe("error");

    const internal = await ctx.world.call("internal-helper", actorSession(ctx.world, ctx.requester), ctx.room, {
      actor: ctx.requester,
      target: ctx.block,
      verb: "_ensure_acts",
      args: []
    });
    expect(internal.op).toBe("applied");
    if (internal.op !== "applied") throw new Error("internal helper did not reach sequenced dispatch");
    expect(internal.observations).toContainEqual(expect.objectContaining({ type: "$error", code: "E_PERM" }));
    const privileged = await ctx.world.call("owner-internal-helper", actorSession(ctx.world, ctx.owner), ctx.room, {
      actor: ctx.owner,
      target: ctx.block,
      verb: "_ensure_acts",
      args: []
    });
    expect(privileged.op).toBe("applied");
    if (privileged.op !== "applied") throw new Error("owner helper did not reach sequenced dispatch");
    expect(privileged.observations).toContainEqual(expect.objectContaining({ type: "$error", code: "E_PERM" }));

    const legitimate = await order(ctx, "legitimate", "legitimate-order");
    const orderId = (legitimate.result as { order_id: string }).order_id;
    const artifact = (
      legitimate.observations.find((observation) => observation.type === "dispenser.ordered") as unknown as
        { payload: { artifact: string } }
    ).payload.artifact;
    const queue = queueOf(ctx.world, ctx.block);
    const fold = await ctx.world.call("public-fold", actorSession(ctx.world, ctx.requester), ctx.room, {
      actor: ctx.requester,
      target: queue,
      verb: "fold",
      args: [{ type: "dispenser.genesis", version: 1, payload: { next_order_seq: 999 }, seq: 999, actor: ctx.requester, source: ctx.block }]
    });
    expect(fold.op).toBe("applied");
    if (fold.op !== "applied") throw new Error("fold bypass did not reach sequenced dispatch");
    expect(fold.observations).toContainEqual(expect.objectContaining({ type: "$error", code: "E_PERM" }));
    expect(ctx.world.getProp(queue, "next_order_seq")).toBe(2);

    const publicPrepare = await ctx.world.directCall(
      "public-prepare",
      ctx.requester,
      ctx.block,
      "prepare_artifact",
      [orderId, "stolen", "stolen text", null]
    );
    expect(publicPrepare.op).toBe("error");
    if (publicPrepare.op === "error") expect(publicPrepare.error.code).toBe("E_PERM");

    const sequencedPrepare = await ctx.world.call(
      "sequenced-prepare",
      actorSession(ctx.world, ctx.plug),
      ctx.room,
      {
        actor: ctx.plug,
        target: ctx.block,
        verb: "prepare_artifact",
        args: [orderId, "wrong route", "wrong route", null]
      }
    );
    expect(sequencedPrepare.op).toBe("applied");
    if (sequencedPrepare.op !== "applied") throw new Error("prepare did not reach sequenced dispatch");
    expect(sequencedPrepare.observations).toContainEqual(
      expect.objectContaining({ type: "$error", code: "E_INVARG" })
    );

    const stolenMove = await ctx.world.call(
      "move-pending-artifact",
      actorSession(ctx.world, ctx.requester),
      ctx.room,
      {
        actor: ctx.requester,
        target: artifact,
        verb: "moveto",
        args: [ctx.requester]
      }
    );
    expect(stolenMove.op).toBe("error");
    if (stolenMove.op === "error") expect(stolenMove.error.code).toBe("E_PERM");
    expect(ctx.world.object(artifact).location).toBe(ctx.block);

    const rehome = await ctx.world.directCall(
      "move-initialized-dispenser",
      "$wiz",
      ctx.block,
      "moveto",
      [otherRoom]
    );
    expect(rehome.op).toBe("error");
    if (rehome.op === "error") expect(rehome.error.code).toBe("E_INVARG");
    expect(ctx.world.object(ctx.block).location).toBe(ctx.room);
    expect(ctx.world.getProp(ctx.block, "projections")).toEqual([queue]);

    const write = await ctx.world.directCall("write-projections", ctx.plug, ctx.block, "set_property", ["projections", []]);
    expect(write.op).toBe("error");
    if (write.op === "error") expect(write.error.code).toBe("E_PERM");

    // Order ids are bearer-like coordination identifiers, not a public
    // existence oracle. An unrelated principal sees the same unknown answer
    // from both status and cancel, and cannot change the queue.
    const stranger = ctx.world.auth("guest:authority-stranger").actor;
    expect(await ctx.world.directCall("stranger-status", stranger, ctx.block, "status", [orderId]))
      .toMatchObject({ op: "result", result: { state: "unknown", order_id: orderId } });
    expect(await mutate(ctx.world, "stranger-cancel", stranger, ctx.block, "cancel", [orderId]))
      .toMatchObject({
        op: "result",
        result: { order_id: orderId, canceled: false, duplicate: false, reason: "unknown" }
      });
    expect(ctx.world.getProp(queue, "rows")).toHaveProperty(orderId);
  });
});

describe("Dispenser Acts idempotency, atomicity, and rebuild", () => {
  it("returns the original artifact after a dropped reply without minting twice", async () => {
    const ctx = setup("receipt_dispenser");
    const ordered = await order(ctx, "leo", "receipt-order");
    const orderId = (ordered.result as { order_id: string }).order_id;
    const prepared = await prepare(
      ctx,
      orderId,
      "receipt-prepare",
      "Horoscope: Leo",
      "First and only body."
    );
    const preparedAgain = await ctx.world.directCall(
      "receipt-prepare-retry",
      ctx.plug,
      ctx.block,
      "prepare_artifact",
      [orderId, "Conflicting title", "Conflicting body", "Conflicting description"]
    );
    expect(preparedAgain).toMatchObject({
      op: "result",
      result: { prepared: true, duplicate: true, note: prepared }
    });
    expect(ctx.world.object(prepared).name).toBe("Horoscope: Leo");
    expect(ctx.world.getProp(prepared, "text")).toBe("First and only body.");
    const delivered = await mutate(ctx.world, "receipt-deliver", ctx.plug, ctx.block, "deliver", [
      orderId,
      prepared
    ]);
    expect(delivered.op).toBe("result");
    if (delivered.op !== "result") return;
    const note = (delivered.result as { note: string }).note;
    expect(delivered.observations.some((observation) => observation.type === "note_edited")).toBe(false);
    expect(JSON.stringify(delivered.observations)).not.toContain("First and only body.");

    const retry = await mutate(ctx.world, "receipt-retry", ctx.plug, ctx.block, "deliver", [
      orderId,
      prepared
    ]);
    expect(retry).toMatchObject({
      op: "result",
      result: { delivered: true, duplicate: true, note }
    });
    const produced = Array.from(ctx.world.objects.values()).filter(
      (object) => object.parent === "$dispensed_note" && ctx.world.propOrNull(object.id, "produced_by") === ctx.block
    );
    expect(produced.map((object) => object.id)).toEqual([note]);
    expect(ctx.world.getProp(note, "text")).toBe("First and only body.");
    const entry = ctx.world.replay(ctx.room, 1, 100).find(
      (candidate) => candidate.message.verb === "deliver"
    );
    expect(entry?.message.args).toEqual([orderId, prepared]);
    expect(JSON.stringify(entry)).not.toContain("First and only body.");
  });

  it("rolls back the preallocated artifact and queue fold when order projection fails", async () => {
    const ctx = setup("rollback_order_dispenser");
    const seed = await order(ctx, "seed", "rollback-order-seed");
    const seedId = (seed.result as { order_id: string }).order_id;
    expect((await mutate(ctx.world, "rollback-order-seed-cancel", ctx.plug, ctx.block, "cancel", [seedId])).op)
      .toBe("result");
    const queue = queueOf(ctx.world, ctx.block);
    const refusing = ctx.world.createRuntimeObject("$projection", "$wiz", ctx.room, {
      progr: "$wiz",
      location: ctx.room,
      name: "refusing order projection"
    });
    ctx.world.setProp(refusing, "source_space", ctx.block);
    ctx.world.setProp(refusing, "log_space", ctx.room);
    ctx.world.setProp(refusing, "consumes", ["dispenser.ordered"]);
    const installed = installVerb(
      ctx.world,
      refusing,
      "fold",
      'verb :fold(act) r { if (caller != this.source_space) { raise { code: "E_PERM", message: "bad caller" }; } raise { code: "E_TEST_DISPENSER_ORDER_FOLD", message: "refuse" }; }',
      null
    );
    expect(installed.ok).toBe(true);
    ctx.world.setProp(ctx.block, "projections", [queue, refusing]);
    const beforeRows = structuredClone(ctx.world.getProp(queue, "rows"));
    const beforeNext = ctx.world.getProp(queue, "next_order_seq");
    const beforeAt = ctx.world.getProp(queue, "at_seq");
    const beforeArtifacts = Array.from(ctx.world.objects.values())
      .filter((object) => object.parent === "$dispensed_note")
      .map((object) => object.id)
      .sort();

    const failed = await mutate(
      ctx.world,
      "rollback-order-refused",
      ctx.requester,
      ctx.block,
      "order",
      ["must not survive"]
    );
    expect(failed.op).toBe("error");
    if (failed.op === "error") expect(failed.error.code).toBe("E_TEST_DISPENSER_ORDER_FOLD");
    expect(ctx.world.getProp(queue, "rows")).toEqual(beforeRows);
    expect(ctx.world.getProp(queue, "next_order_seq")).toBe(beforeNext);
    expect(ctx.world.getProp(queue, "at_seq")).toBe(beforeAt);
    expect(
      Array.from(ctx.world.objects.values())
        .filter((object) => object.parent === "$dispensed_note")
        .map((object) => object.id)
        .sort()
    ).toEqual(beforeArtifacts);
    expect(ctx.world.replay(ctx.room, 1, 100).at(-1)).toMatchObject({
      applied_ok: false,
      observations: [expect.objectContaining({ type: "$error", code: "E_TEST_DISPENSER_ORDER_FOLD" })]
    });
  });

  it("rolls back artifact movement and the earlier queue fold when a later fold refuses", async () => {
    const ctx = setup("rollback_dispenser");
    const ordered = await order(ctx, "aries", "rollback-order");
    const orderId = (ordered.result as { order_id: string }).order_id;
    const queue = queueOf(ctx.world, ctx.block);
    const beforeRows = structuredClone(ctx.world.getProp(queue, "rows"));
    const beforeReceipts = structuredClone(ctx.world.getProp(queue, "receipts"));
    const beforeSeq = ctx.world.getProp(queue, "at_seq");
    const prepared = await prepare(
      ctx,
      orderId,
      "rollback-prepare",
      "Should stay pending",
      "prepared body"
    );

    const refusing = ctx.world.createRuntimeObject("$projection", "$wiz", ctx.room, {
      progr: "$wiz",
      location: ctx.room,
      name: "refusing delivery projection"
    });
    ctx.world.setProp(refusing, "source_space", ctx.block);
    ctx.world.setProp(refusing, "log_space", ctx.room);
    ctx.world.setProp(refusing, "consumes", ["dispenser.delivered"]);
    const installed = installVerb(
      ctx.world,
      refusing,
      "fold",
      'verb :fold(act) r { if (caller != this.source_space) { raise { code: "E_PERM", message: "bad caller" }; } raise { code: "E_TEST_DISPENSER_FOLD", message: "refuse" }; }',
      null
    );
    expect(installed.ok).toBe(true);
    ctx.world.setProp(ctx.block, "projections", [queue, refusing]);

    const failed = await mutate(ctx.world, "rollback-deliver", ctx.plug, ctx.block, "deliver", [
      orderId,
      prepared
    ]);
    expect(failed.op).toBe("error");
    if (failed.op === "error") expect(failed.error.code).toBe("E_TEST_DISPENSER_FOLD");
    expect(ctx.world.getProp(queue, "rows")).toEqual(beforeRows);
    expect(ctx.world.getProp(queue, "receipts")).toEqual(beforeReceipts);
    expect(ctx.world.getProp(queue, "at_seq")).toBe(beforeSeq);
    expect(ctx.world.object(prepared).location).toBe(ctx.block);
    expect(ctx.world.getProp(prepared, "text")).toBe("prepared body");
    const last = ctx.world.replay(ctx.room, 1, 100).at(-1);
    expect(last).toMatchObject({ applied_ok: false });
    expect(last?.observations).toEqual([expect.objectContaining({ type: "$error", code: "E_TEST_DISPENSER_FOLD" })]);
  });

  it("rebuilds every projection-owned field from a shared room log", async () => {
    const ctx = setup("rebuild_dispenser");
    const first = await order(ctx, "alpha", "rb-order-1");
    const firstId = (first.result as { order_id: string }).order_id;
    const firstArtifact = await prepare(ctx, firstId, "rb-prepare-1", "Alpha artifact", "alpha body");
    const delivered = await mutate(ctx.world, "rb-deliver-1", ctx.plug, ctx.block, "deliver", [
      firstId,
      firstArtifact
    ]);
    expect(delivered.op).toBe("result");
    const second = await order(ctx, "beta", "rb-order-2");
    const secondId = (second.result as { order_id: string }).order_id;
    expect((await mutate(ctx.world, "rb-cancel-2", ctx.requester, ctx.block, "cancel", [secondId])).op).toBe("result");
    await order(ctx, "gamma", "rb-order-3");

    // A second Dispenser shares the same room/log. Its Acts must be ignored
    // by this block's rebuild, even though the type names are identical.
    const otherOwner = ctx.world.auth("guest:rebuild-other-owner").actor;
    const otherRequester = ctx.world.auth("guest:rebuild-other-requester").actor;
    const other = "rebuild_other_dispenser";
    ctx.world.createObject({ id: other, name: other, parent: "$dispenser_block", owner: otherOwner, location: ctx.room });
    ctx.world.setProp(other, "rate_limit_seconds", 0);
    ctx.world.setProp(other, "block_cooldown_seconds", 0);
    expect((await mutate(ctx.world, "rb-other-order", otherRequester, other, "order", ["not mine"])).op).toBe("result");

    const live = queueOf(ctx.world, ctx.block);
    const copy = ctx.world.createRuntimeObject("$dispenser_queue", ctx.owner, ctx.room, {
      progr: "$wiz",
      location: ctx.room,
      name: "rebuilt queue"
    });
    ctx.world.setProp(copy, "source_space", ctx.block);
    ctx.world.setProp(copy, "log_space", ctx.room);
    for (let page = 0; page < 20; page++) {
      const rebuilt = await ctx.world.directCall(`rb-page-${page}`, ctx.owner, copy, "rebuild_from", [ctx.room, 100]);
      expect(rebuilt, JSON.stringify(rebuilt)).toMatchObject({ op: "result" });
      if (rebuilt.op === "result" && (rebuilt.result as { done: boolean }).done) break;
    }
    for (const property of [
      "rows",
      "next_order_seq",
      "next_queue_seq",
      "last_order_seq",
      "requester_index",
      "receipts",
      "genesis_seen",
      "at_seq"
    ]) {
      expect(ctx.world.getProp(copy, property), property).toEqual(ctx.world.getProp(live, property));
    }
  });
});

describe("Dispenser hard bounds", () => {
  it("treats owner zero as the hard queue cap and evicts requester/receipt indexes deterministically", async () => {
    const ctx = setup("bounds_dispenser");
    const first = await order(ctx, "one", "bounds-one");
    const firstId = (first.result as { order_id: string }).order_id;
    const queue = queueOf(ctx.world, ctx.block);
    ctx.world.setProp(queue, "row_cap", 2);
    ctx.world.setProp(queue, "requester_cap", 2);
    ctx.world.setProp(queue, "receipt_cap", 2);
    ctx.world.setProp(ctx.block, "max_pending_orders", 0);

    const secondActor = ctx.world.auth("guest:bounds-second").actor;
    const second = await mutate(ctx.world, "bounds-two", secondActor, ctx.block, "order", ["two"]);
    expect(second.op).toBe("result");
    const thirdActor = ctx.world.auth("guest:bounds-third").actor;
    const full = await mutate(ctx.world, "bounds-full", thirdActor, ctx.block, "order", ["three"]);
    expect(full.op).toBe("error");
    if (full.op === "error") expect(full.error.code).toBe("E_QUEUE_FULL");
    expect(Object.keys(ctx.world.getProp(queue, "rows") as Record<string, unknown>)).toHaveLength(2);

    // Drain, then admit the third actor. The oldest requester entry (the
    // original requester) is evicted; actor-id order is the same-seq tie-break.
    expect((await mutate(ctx.world, "bounds-cancel-one", ctx.plug, ctx.block, "cancel", [firstId])).op).toBe("result");
    const third = await mutate(ctx.world, "bounds-three", thirdActor, ctx.block, "order", ["three"]);
    expect(third.op).toBe("result");
    expect(Object.keys(ctx.world.getProp(queue, "requester_index") as Record<string, unknown>).sort()).toEqual(
      [secondActor, thirdActor].sort()
    );

    const secondId = (second as DirectResultFrame).result as { order_id: string };
    expect((await mutate(ctx.world, "bounds-cancel-two", ctx.plug, ctx.block, "cancel", [secondId.order_id])).op).toBe("result");
    const thirdId = (third as DirectResultFrame).result as { order_id: string };
    expect((await mutate(ctx.world, "bounds-cancel-three", ctx.plug, ctx.block, "cancel", [thirdId.order_id])).op).toBe("result");
    const receiptKeys = Object.keys(ctx.world.getProp(queue, "receipts") as Record<string, unknown>).sort();
    expect(receiptKeys).toEqual([secondId.order_id, thirdId.order_id].sort());
  });

  it("refuses an oversized legacy row atomically instead of recording an unbounded genesis Act", async () => {
    const ctx = setup("legacy_bound_dispenser");
    ctx.world.setProp(ctx.block, "legacy_pending_orders", [
      { order_id: "ord_1", requester: ctx.requester, request: "x".repeat(201), ts: 1 }
    ]);
    ctx.world.setProp(ctx.block, "legacy_next_order_seq", 2);

    const refused = await mutate(ctx.world, "legacy-bound-order", ctx.requester, ctx.block, "order", ["new"]);
    expect(refused.op).toBe("error");
    if (refused.op === "error") expect(refused.error.code).toBe("E_QUOTA");
    expect(ctx.world.getProp(ctx.block, "projections")).toEqual([]);
    expect(ctx.world.getProp(ctx.block, "acts_initialized")).toBe(false);
    expect(ctx.world.getProp(ctx.block, "legacy_pending_orders")).toHaveLength(1);
    expect(ctx.world.replay(ctx.room, 1, 10).at(-1)).toMatchObject({
      applied_ok: false,
      observations: [expect.objectContaining({ type: "$error", code: "E_QUOTA" })]
    });
  });
});

const LEGACY_DISPENSER: CatalogManifest = {
  name: "dispenser",
  version: "0.2.3",
  spec_version: "v1",
  license: "MIT",
  depends: ["@local:block", "@local:note"],
  classes: [
    {
      local_name: "$dispensed_note",
      parent: "$note",
      properties: [
        { name: "produced_by", type: "obj", default: null },
        { name: "produced_at", type: "int", default: 0 }
      ]
    },
    {
      local_name: "$dispenser_block",
      parent: "$block",
      properties: [
        { name: "system_prompt", type: "str", default: "" },
        { name: "rate_limit_seconds", type: "int", default: 60 },
        { name: "block_cooldown_seconds", type: "int", default: 5 },
        { name: "max_pending_orders", type: "int", default: 50 },
        { name: "max_request_chars", type: "int", default: 200 },
        { name: "pending_orders", type: "list", default: [] },
        { name: "next_order_seq", type: "int", default: 1 },
        { name: "last_request_at", type: "map", default: {} },
        { name: "last_order_at", type: "int", default: 0 }
      ]
    }
  ]
} as CatalogManifest;

function currentDispenser(): CatalogManifest {
  return JSON.parse(readFileSync(join(__dirname, "..", "catalogs", "dispenser", "manifest.json"), "utf8"));
}

function dispenserMigration(): CatalogMigrationManifest {
  return JSON.parse(readFileSync(join(__dirname, "..", "catalogs", "dispenser", "migration-v0-to-v1.json"), "utf8"));
}

function installManifestFile(world: World, name: string): void {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, "..", "catalogs", name, "manifest.json"), "utf8")
  ) as CatalogManifest;
  installCatalogManifest(world, manifest, {
    tap: "@local",
    alias: name,
    actor: "$wiz",
    allowImplementationHints: true
  });
}

describe("Dispenser v0 to v1 migration", () => {
  it("runs on SQLite and turns every legacy row into a deterministic genesis Act", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-dispenser-migration-"));
    const path = join(dir, "world.sqlite");
    try {
      const seedRepo = new LocalSQLiteRepository(path);
      const seed = createWorld({ repository: seedRepo, catalogs: false });
      for (const dependency of ["acts", "help", "chat", "note", "perm", "block"]) {
        installManifestFile(seed, dependency);
      }
      installCatalogManifest(seed, LEGACY_DISPENSER, { tap: "@local", alias: "dispenser" });
      seed.createObject({ id: "legacy_room", name: "legacy_room", parent: "$space", owner: "$wiz", location: null });
      const owner = seed.auth("guest:legacy-owner").actor;
      const alice = seed.auth("guest:legacy-alice").actor;
      const bob = seed.auth("guest:legacy-bob").actor;
      seed.createObject({ id: "legacy_block", name: "legacy", parent: "$dispenser_block", owner, location: "legacy_room" });
      seed.setProp("legacy_block", "pending_orders", [
        { order_id: "ord_4", requester: alice, request: "old alpha", ts: 100 },
        { order_id: "ord_7", requester: bob, request: "old beta", ts: 200 }
      ]);
      seed.setProp("legacy_block", "next_order_seq", 9);
      seedRepo.close();

      const upgradeRepo = new LocalSQLiteRepository(path);
      const world = createWorld({ repository: upgradeRepo, catalogs: false });
      const record = upgradeRepo.transaction(() =>
        updateCatalogManifest(world, currentDispenser(), {
          tap: "@local",
          alias: "dispenser",
          actor: "$wiz",
          allowImplementationHints: true,
          acceptMajor: true,
          migration: dispenserMigration()
        })
      );
      expect(record.migration_state).toMatchObject({ status: "completed", to_version: "1.0.0" });
      expect(world.getProp("legacy_block", "legacy_pending_orders")).toHaveLength(2);
      expect(world.getProp("legacy_block", "legacy_next_order_seq")).toBe(9);
      expect(world.propOrNull("legacy_block", "pending_orders")).toBeNull();

      const requester = world.auth("guest:legacy-new").actor;
      world.setProp("legacy_block", "rate_limit_seconds", 0);
      world.setProp("legacy_block", "block_cooldown_seconds", 0);
      const upgraded = await mutate(world, "legacy-cutover", requester, "legacy_block", "order", ["new gamma"]);
      expect(upgraded.op).toBe("result");
      if (upgraded.op !== "result") throw new Error("legacy cutover failed");
      expect(upgraded).toMatchObject({ result: { order_id: "ord_9" } });
      expect(upgraded.observations.filter((observation) => observation.type === "dispenser.genesis")).toHaveLength(1);
      expect(upgraded.observations.filter((observation) => observation.type === "dispenser.legacy_ordered")).toHaveLength(2);
      expect(upgraded.observations.filter((observation) => observation.type === "dispenser.ordered")).toHaveLength(1);
      expect(world.getProp("legacy_block", "legacy_pending_orders")).toEqual([]);

      const key = world.createApiKey("$wiz", "legacy_block", "legacy-plug");
      world.auth(`apikey:${key.id}:${key.secret}`);
      const head = await world.directCall("legacy-head", "legacy_block", "legacy_block", "next_pending", []);
      expect(head).toMatchObject({ op: "result", result: { order_id: "ord_4", request: "old alpha" } });
      const queue = queueOf(world, "legacy_block");
      expect(world.getProp(queue, "next_order_seq")).toBe(10);
      const rows = world.getProp(queue, "rows") as Record<string, { artifact: string }>;
      expect(Object.keys(rows)).toEqual(["ord_4", "ord_7", "ord_9"]);
      for (const [orderId, row] of Object.entries(rows)) {
        expect(world.object(row.artifact).location, orderId).toBe("legacy_block");
        expect(world.getProp(row.artifact, "order_id"), orderId).toBe(orderId);
      }
      upgradeRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
