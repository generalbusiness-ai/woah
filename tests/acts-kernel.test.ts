// Acts kernel proof (notes/2026-07-21-acts-projection-model.md).
//
// Part 1 — the two generic core read seams the kernel note names (§2.2, §2.3):
//   - event_schema(obj, type): declared shape via class-then-features
//     precedence, defensive copy, null when undeclared (gate 2).
//   - $space:replay() results include the persisted entry `ts` without
//     changing pagination (gate 2).
//
// Later parts (same file, added with the acts catalog): emission authority,
// fail-closed atomicity, rebuild invariant, board parity.
import { describe, expect, it } from "vitest";
import { installVerb } from "../src/core/authoring";
import { authedWorld, moveActorTo } from "./core-support";

describe("event_schema builtin (core seam 1)", () => {
  it("resolves through the class chain with feature fallback, in declared order", async () => {
    const { world, session, actor } = authedWorld();
    world.createObject({ id: "es_base", name: "es_base", parent: "$space", owner: "$wiz" });
    world.createObject({ id: "es_room", name: "es_room", parent: "es_base", owner: "$wiz" });
    world.createObject({ id: "es_feature_a", name: "es_feature_a", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "es_feature_b", name: "es_feature_b", parent: "$thing", owner: "$wiz" });

    // Chain declaration on the base class; feature declares the same type
    // with a different shape — the chain must win (verb-dispatch precedence).
    world.defineEventSchema("es_base", "proof.chained", { key: "str" });
    world.defineEventSchema("es_feature_a", "proof.chained", { wrong: "obj" });
    // Feature-only type: first feature in list order wins.
    world.defineEventSchema("es_feature_a", "proof.featured", { a: "int" });
    world.defineEventSchema("es_feature_b", "proof.featured", { b: "int" });
    world.setProp("es_room", "features", ["es_feature_a", "es_feature_b"]);

    expect(world.eventSchemaFor("es_room", "proof.chained")).toEqual({ key: "str" });
    expect(world.eventSchemaFor("es_room", "proof.featured")).toEqual({ a: "int" });
    expect(world.eventSchemaFor("es_room", "proof.absent")).toBeNull();

    // Defensive copy: mutating the returned shape must not touch the world.
    const copy = world.eventSchemaFor("es_room", "proof.chained")!;
    (copy as Record<string, unknown>).key = "tampered";
    expect(world.eventSchemaFor("es_room", "proof.chained")).toEqual({ key: "str" });

    // Same answers through the DSL builtin.
    expect(installVerb(world, actor, "es_probe", `verb :es_probe() rxd {
      return {
        chained: event_schema("es_room", "proof.chained"),
        featured: event_schema("es_room", "proof.featured"),
        absent: event_schema("es_room", "proof.absent")
      };
    }`, null).ok).toBe(true);
    const probed = await world.directCall("es-probe", actor, actor, "es_probe", [], { sessionId: session.id });
    expect(probed.op).toBe("result");
    if (probed.op !== "result") return;
    expect(probed.result).toEqual({
      chained: { key: "str" },
      featured: { a: "int" },
      absent: null
    });
  });
});

describe("replay ts (core seam 2)", () => {
  it("includes the persisted entry timestamp without changing pagination", async () => {
    const { world, session, actor } = authedWorld();
    await moveActorTo(world, actor, "the_chatroom", { sessionId: session.id });

    const before = Date.now();
    const applied = await world.call("acts-seam-say", session.id, "the_chatroom", {
      actor,
      target: "the_chatroom",
      verb: "say",
      args: ["seam two"]
    });
    expect(applied.op).toBe("applied");
    if (applied.op !== "applied") return;

    const replayed = await world.directCall("acts-seam-replay", actor, "the_chatroom", "replay", [applied.seq, 1], { sessionId: session.id });
    expect(replayed.op).toBe("result");
    if (replayed.op !== "result") return;
    const entries = replayed.result as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0].seq).toBe(applied.seq);
    expect(typeof entries[0].ts).toBe("number");
    expect(entries[0].ts as number).toBeGreaterThanOrEqual(before);
    expect(entries[0].message).toBeDefined();
    expect(entries[0].observations).toBeDefined();
  });
});
