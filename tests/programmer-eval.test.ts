import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import type { WooValue } from "../src/core/types";

function programmerActor(world: ReturnType<typeof createWorld>, id = "guest:eval") {
  const session = world.auth(id);
  const actor = session.actor;
  const obj = world.object(actor);
  obj.owner = actor;
  obj.flags.programmer = true;
  world.chparentAuthoredObject("$wiz", actor, "$programmer");
  return { session, actor };
}

function plainActor(world: ReturnType<typeof createWorld>, id = "guest:eval-plain") {
  const session = world.auth(id);
  const actor = session.actor;
  world.object(actor).owner = actor;
  return { session, actor };
}

async function callEval(world: ReturnType<typeof createWorld>, actor: string, source: string, opts: { [k: string]: WooValue } = {}) {
  const frame = await world.directCall(undefined, actor, actor, "eval", [source, opts]);
  if (frame.op === "error") throw new Error(`eval call errored: ${frame.error.code} ${frame.error.message}`);
  return frame.result as Record<string, unknown>;
}

describe("$programmer:eval", () => {
  it("evaluates a simple expression and returns the value", async () => {
    const world = createWorld();
    const { actor } = programmerActor(world);
    const result = await callEval(world, actor, "1 + 2 * 3");
    expect(result).toMatchObject({ ok: true, dry_run: false, value: 7 });
  });

  it("echoes the result to the actor via tell() so it shows in chat", async () => {
    // Without this, `;1+4` in chat is silent — the verb returns the result
    // map but the chat panel only renders observations on its allow-list,
    // not direct-call return values.
    const world = createWorld();
    const { actor } = programmerActor(world, "guest:eval-tell");
    const frame = await world.directCall(undefined, actor, actor, "eval", ["1 + 4", {}]);
    expect(frame.op).toBe("result");
    if (frame.op !== "result") return;
    const textObs = frame.observations.find((o) => o.type === "text" && (o as { target?: string }).target === actor);
    expect(textObs).toBeDefined();
    expect((textObs as unknown as { text: string }).text).toBe("=> 5");
  });

  it("dispatches to the actor's eval through the chat ; prefix", async () => {
    const world = createWorld();
    const { actor, session } = programmerActor(world, "guest:eval-chat");
    await world.directCall(undefined, actor, "the_chatroom", "enter", []);
    const frame = await world.command(undefined, session.id, "the_chatroom", ";40 + 2");
    expect(frame.op).toBe("result");
    if (frame.op !== "result") return;
    const result = frame.result as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, value: 42 });
  });

  it("dispatches as the typed `eval ...` command (LambdaCore command word)", async () => {
    const world = createWorld();
    const { actor, session } = programmerActor(world, "guest:eval-cmd");
    await world.directCall(undefined, actor, "the_chatroom", "enter", []);
    const frame = await world.command(undefined, session.id, "the_chatroom", "eval 1 + 5");
    expect(frame.op).toBe("result");
    if (frame.op !== "result") return;
    const result = frame.result as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, value: 6 });
  });

  it("runs a multi-statement block under mode=stmts (chat ;;)", async () => {
    const world = createWorld();
    const { actor } = programmerActor(world, "guest:eval-stmts");
    const result = await callEval(world, actor, "let x = 0; for i in [1, 2, 3, 4] { x = x + i; } return x;", { mode: "stmts" });
    expect(result).toMatchObject({ ok: true, value: 10 });
  });

  it("returns compile diagnostics for malformed source instead of throwing", async () => {
    const world = createWorld();
    const { actor } = programmerActor(world, "guest:eval-compile-err");
    const result = await callEval(world, actor, "this is not woo");
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.diagnostics)).toBe(true);
    expect((result.diagnostics as unknown[]).length).toBeGreaterThan(0);
  });

  it("propagates runtime errors as a thrown error frame", async () => {
    const world = createWorld();
    const { actor } = programmerActor(world, "guest:eval-runtime-err");
    const frame = await world.directCall(undefined, actor, actor, "eval", ["1 / 0", {}]);
    expect(frame.op).toBe("error");
    if (frame.op === "error") expect(frame.error.code).toBe("E_DIV");
  });

  it("rolls back partial mutations when the eval body fails", async () => {
    // Catching the runtime error inside the verb wrapper would commit the
    // create() before the 1/0 fails. The substrate must let the error escape
    // so the outer direct-call transaction rolls back.
    const world = createWorld();
    const { actor } = programmerActor(world, "guest:eval-rollback");
    const before = world.objects.size;
    const frame = await world.directCall(
      undefined,
      actor,
      actor,
      "eval",
      ['let o = create("$thing", {name: "Temp Eval Leak"}); return 1 / 0;', { mode: "stmts" }]
    );
    expect(frame.op).toBe("error");
    expect(world.objects.size).toBe(before);
    const leaked = Array.from(world.objects.values()).some((obj) => obj.name === "Temp Eval Leak");
    expect(leaked).toBe(false);
  });

  it("compiles but does not execute when dry_run=true", async () => {
    const world = createWorld();
    const { actor } = programmerActor(world, "guest:eval-dry");
    const result = await callEval(world, actor, "1 + 1", { dry_run: true });
    expect(result).toMatchObject({ ok: true, dry_run: true });
    expect(result.value).toBeUndefined();
  });

  it("plain players have no eval verb at all (E_VERBNF, not E_PERM)", async () => {
    const world = createWorld();
    const { actor } = plainActor(world, "guest:eval-no-prog");
    const frame = await world.directCall(undefined, actor, actor, "eval", ["1 + 1", {}]);
    expect(frame.op).toBe("error");
    if (frame.op === "error") expect(frame.error.code).toBe("E_VERBNF");
  });

  it("rejects $programmer descendants that lack the programmer flag", async () => {
    // assertProgrammerActor requires wizard OR ($programmer ancestry AND progbit).
    // Reparenting alone exposes the verb but the substrate builtin denies the call.
    const world = createWorld();
    const session = world.auth("guest:eval-no-progbit");
    const actor = session.actor;
    world.object(actor).owner = actor;
    world.chparentAuthoredObject("$wiz", actor, "$programmer");
    // Note: no `flags.programmer = true`.
    const frame = await world.directCall(undefined, actor, actor, "eval", ["1 + 1", {}]);
    expect(frame.op).toBe("error");
    if (frame.op === "error") expect(frame.error.code).toBe("E_PERM");
  });

  it("runs eval body under the actor's progr, not the catalog installer's", async () => {
    // The eval verb is owned by $wiz (the catalog installer). If progr were
    // taken from the wrapper verb, then `task_perms()` inside eval would
    // surface $wiz; the substrate builtin must rebind progr to the caller.
    const world = createWorld();
    const { actor } = programmerActor(world, "guest:eval-progr");
    const result = await callEval(world, actor, "task_perms()");
    expect(result).toMatchObject({ ok: true, value: actor });
  });

  it("eval can call any reachable verb (woo_call replacement)", async () => {
    const world = createWorld();
    const { actor } = programmerActor(world, "guest:eval-callverb");
    const target = world.createAuthoredObject(actor, { parent: "$thing", name: "Eval Target" });
    const result = await callEval(world, actor, `"${target}".name`);
    expect(result).toMatchObject({ ok: true, value: "Eval Target" });
  });
});
