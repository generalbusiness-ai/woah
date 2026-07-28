import { describe, expect, it } from "vitest";
import { installVerb } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import type { WooValue } from "../src/core/types";

function programmerActor(world: ReturnType<typeof createWorld>, id = "guest:eval") {
  const session = world.auth(id);
  const actor = session.actor;
  world.migrationSetObjectOwner(actor, actor);
  world.setCatalogObjectFlags(actor, { programmer: true });
  world.chparentAuthoredObject("$wiz", actor, "$programmer");
  return { session, actor };
}

function plainActor(world: ReturnType<typeof createWorld>, id = "guest:eval-plain") {
  const session = world.auth(id);
  const actor = session.actor;
  world.migrationSetObjectOwner(actor, actor);
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

  it("points an unknown identifier at the #objref literal, and names the object when the world knows it", async () => {
    // The walkthrough's finding: `create()` hands back a bare id
    // (`obj_human_2_1`), typing it into eval fails "unknown identifier", and
    // nothing anywhere documents that the callable form is `#obj_human_2_1`.
    const world = createWorld();
    const { actor } = programmerActor(world, "guest:eval-objref");
    world.createObject({ id: "eval_probe_widget", parent: "$thing", owner: actor, name: "Probe Widget" });

    // The world KNOWS this id, so the hint is the sharp "did you mean" form.
    const known = await callEval(world, actor, "eval_probe_widget.name");
    expect(known.ok).toBe(false);
    const knownDiag = (known.diagnostics as Array<Record<string, unknown>>)[0];
    expect(knownDiag.code).toBe("E_COMPILE");
    expect(knownDiag.message).toContain("unknown identifier: eval_probe_widget");
    expect(knownDiag.symbol).toBe("eval_probe_widget");
    expect(knownDiag.hint).toContain("#eval_probe_widget");
    expect(knownDiag.hint).toContain("did you mean");

    // And the objref literal the hint recommends actually works — including
    // for a property read. `.` terminates a ref token (language.md §7.3);
    // while it did not, `#obj.prop` and `$core.prop` compiled to a single
    // string literal and returned "eval_probe_widget.name" with no error.
    const viaObjref = await callEval(world, actor, "#eval_probe_widget.name");
    expect(viaObjref).toMatchObject({ ok: true, value: "Probe Widget" });
    const viaCoreref = await callEval(world, actor, "$programmer.name");
    expect(viaCoreref.ok, JSON.stringify(viaCoreref)).toBe(true);
    expect(typeof viaCoreref.value).toBe("string");
    expect(viaCoreref.value).not.toBe("$programmer.name");
    // Verb dispatch on a ref is unaffected.
    const viaVerb = await callEval(world, actor, "#eval_probe_widget:title()");
    expect(viaVerb.ok, JSON.stringify(viaVerb)).toBe(true);

    // An id the world does not know keeps the compiler's generic rule — the
    // hint must never claim knowledge a sparse view does not have.
    const unknown = await callEval(world, actor, "no_such_object_here.name");
    const unknownDiag = (unknown.diagnostics as Array<Record<string, unknown>>)[0];
    expect(unknownDiag.hint).toContain("#no_such_object_here");
    expect(unknownDiag.hint).not.toContain("did you mean");

    // The chat line carries the remediation too; a diagnostic nobody reads
    // is not a fix.
    const frame = await world.directCall(undefined, actor, actor, "eval", ["eval_probe_widget.name", {}]);
    expect(frame.op).toBe("result");
    if (frame.op !== "result") return;
    const told = frame.observations.find((o) => o.type === "text" && (o as { target?: string }).target === actor);
    expect((told as unknown as { text: string }).text).toContain("#eval_probe_widget");
  });

  it("reaches an object whose id holds a reserved character through the quoted objref form", async () => {
    // `.` terminating a bare ref token re-means `#foo.bar` from "object
    // foo.bar" to "property bar on object foo". Ids are opaque in storage and
    // on the wire, so a world minted before that rule (or by a third-party
    // catalog's local_name) can already hold a dotted id, and it must stay
    // addressable from source. The quoted form is that escape; without it the
    // object would be unreferenceable with no error and no migration.
    const world = createWorld();
    const { actor } = programmerActor(world, "guest:eval-quoted-ref");
    // `restoring` is the reconstruction path (identity import / world
    // adoption); it is exactly how a legacy dotted id enters a fresh world.
    world.createObject({ id: "legacy.dotted", parent: "$thing", owner: actor, name: "Legacy Dotted", restoring: true });
    world.setProp("legacy.dotted", "name", "Legacy Dotted");
    const installed = installVerb(world, "legacy.dotted", "ping", "verb :ping() rxd { return 7; }", null);
    expect(installed.ok).toBe(true);

    const read = await callEval(world, actor, `#"legacy.dotted".name`);
    expect(read).toMatchObject({ ok: true, value: "Legacy Dotted" });
    const called = await callEval(world, actor, `#"legacy.dotted":ping()`);
    expect(called).toMatchObject({ ok: true, value: 7 });
    // The bare form still means property access — the two spellings are
    // genuinely different references, which is the whole point. It compiles,
    // then fails at runtime looking for an object named `legacy`.
    const bare = await world.directCall(undefined, actor, actor, "eval", ["#legacy.dotted", {}]);
    expect(bare.op).toBe("error");
    if (bare.op === "error") expect(bare.error.code).toBe("E_OBJNF");
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
    world.migrationSetObjectOwner(actor, actor);
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
