import { describe, expect, it } from "vitest";

import { installVerb } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import {
  readTranscriptCellFromSerializedWorld,
  type EffectTranscript
} from "../src/core/effect-transcript";
import { installLocalCatalogs } from "../src/core/local-catalogs";
import { authoritativePlanningWorld } from "../src/core/planning-world";
import {
  parseShadowLifecycleCellValue,
  stableShadowJson
} from "../src/core/shadow-cell-version";
import {
  applyAcceptedShadowFrame,
  applyTranscriptWriteToSerializedObject,
  createShadowCommitScope,
  serializedFor,
  submitShadowCommit
} from "../src/core/shadow-commit-scope";
import { runShadowTurnCallTranscript, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import { hashSource } from "../src/core/source-hash";
import type { WooValue } from "../src/core/types";
import { cellsFromSerialized, storeCells } from "../src/net/bridge";
import { CellStore, cellKey } from "../src/net/cells";
import { planTurn } from "../src/net/plan";
import type { ScopeClassifier } from "../src/net/route";
import { ScopeSequencer } from "../src/net/scope";

const PROGRAMMER = "lineage_programmer";

function rehashTranscript(transcript: EffectTranscript): EffectTranscript {
  const { hash: _prior, ...body } = transcript;
  return {
    ...body,
    hash: hashSource(stableShadowJson(body as unknown as WooValue))
  };
}

function lineageWorld() {
  const world = createWorld();
  world.createObject({
    id: PROGRAMMER,
    name: "Lineage programmer",
    parent: "$player",
    owner: PROGRAMMER,
    flags: { programmer: true }
  });
  world.createObject({
    id: "lineage_kind_a",
    name: "Lineage kind A",
    parent: "$thing",
    owner: PROGRAMMER,
    flags: { fertile: true }
  });
  world.createObject({
    id: "lineage_kind_b",
    name: "Lineage kind B",
    parent: "$thing",
    owner: PROGRAMMER,
    flags: { fertile: true }
  });
  world.createObject({
    id: "lineage_subject",
    name: "Lineage subject",
    parent: "lineage_kind_a",
    owner: PROGRAMMER
  });
  world.createObject({
    id: "lineage_descendant",
    name: "Lineage descendant",
    parent: "lineage_subject",
    owner: PROGRAMMER
  });
  world.defineProperty("lineage_kind_a", {
    name: "inherited_value",
    defaultValue: 1,
    owner: PROGRAMMER,
    perms: "r",
    typeHint: "int"
  });
  world.defineProperty("lineage_kind_b", {
    name: "inherited_value",
    defaultValue: 99,
    owner: PROGRAMMER,
    perms: "r",
    typeHint: "int"
  });
  const installed = installVerb(
    world,
    "lineage_subject",
    "rekind",
    "verb :rekind(parent) rxd { chparent(this, parent); return this; }",
    null
  );
  if (!installed.ok) throw new Error(JSON.stringify(installed));
  const readInstalled = installVerb(
    world,
    "lineage_subject",
    "rekind_and_read",
    "verb :rekind_and_read(parent) rxd { chparent(this, parent); return this.inherited_value; }",
    null
  );
  if (!readInstalled.ok) throw new Error(JSON.stringify(readInstalled));
  const descendantReadInstalled = installVerb(
    world,
    "lineage_descendant",
    "rekind_ancestor_and_read",
    [
      "verb :rekind_ancestor_and_read(ancestor, parent) rxd {",
      "  chparent(ancestor, parent);",
      "  return this.inherited_value;",
      "}"
    ].join("\n"),
    null
  );
  if (!descendantReadInstalled.ok) throw new Error(JSON.stringify(descendantReadInstalled));
  const renameInstalled = installVerb(
    world,
    "lineage_subject",
    "relabel",
    "verb :relabel(name) rxd { set_object_name(this, name); return this.name; }",
    null
  );
  if (!renameInstalled.ok) throw new Error(JSON.stringify(renameInstalled));
  return world;
}

async function lineageTurn(
  world: ReturnType<typeof createWorld>,
  input: Pick<ShadowTurnCall, "id" | "target" | "verb" | "args">
) {
  const serialized = world.exportWorld();
  const call: ShadowTurnCall = {
    kind: "woo.turn_call.shadow.v1",
    route: "direct",
    scope: "#-1",
    session: null,
    actor: PROGRAMMER,
    ...input
  };
  const run = await runShadowTurnCallTranscript(authoritativePlanningWorld(serialized), call);
  const scope = createShadowCommitScope({
    node: "lineage-authority",
    scope: call.scope,
    serialized
  });
  const result = submitShadowCommit(scope, {
    kind: "woo.commit.submit.shadow.v1",
    id: call.id,
    scope: call.scope,
    expected: scope.head,
    transcript: run.transcript
  });
  return { run, result, scope, before: serialized, call };
}

describe("shadow lineage commit authority", () => {
  it("accepts create followed by a lifecycle replacement in both authorities", async () => {
    const world = lineageWorld();
    const installed = installVerb(
      world,
      PROGRAMMER,
      "spawn_rekind",
      'verb :spawn_rekind(parent) rxd { let child = create($thing, { owner: actor, name: "Fresh lineage child", location: null }); chparent(child, parent); return child; }',
      null
    );
    if (!installed.ok) throw new Error(JSON.stringify(installed));
    const before = world.exportWorld();
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "lineage-create-then-chparent",
      route: "direct",
      scope: "#-1",
      session: null,
      actor: PROGRAMMER,
      target: PROGRAMMER,
      verb: "spawn_rekind",
      args: ["lineage_kind_b"]
    };
    const shadowRun = await runShadowTurnCallTranscript(authoritativePlanningWorld(before), call);
    expect(shadowRun.frame).toMatchObject({ op: "result" });
    const shadowTranscript = shadowRun.transcript;
    const created = shadowTranscript.creates[0];
    expect(created).toBeDefined();
    if (!created) return;
    expect(shadowTranscript.reads).toContainEqual(expect.objectContaining({
      cell: { kind: "lifecycle", object: created.object },
      value: {
        parent: "$thing",
        owner: PROGRAMMER,
        name: "Fresh lineage child",
        anchor: null,
        flags: {}
      }
    }));
    expect(shadowTranscript.writes).toContainEqual(expect.objectContaining({
      cell: { kind: "lifecycle", object: created.object },
      op: "set",
      value: expect.objectContaining({ parent: "lineage_kind_b" })
    }));

    const shadow = createShadowCommitScope({
      node: "lineage-create-shadow-authority",
      scope: call.scope,
      serialized: before
    });
    const shadowResult = submitShadowCommit(shadow, {
      kind: "woo.commit.submit.shadow.v1",
      id: call.id,
      scope: call.scope,
      expected: shadow.head,
      transcript: shadowTranscript
    });
    expect(shadowResult.kind, JSON.stringify(shadowResult)).toBe("woo.commit.accepted.shadow.v1");
    expect(serializedFor(shadow).objects.find((row) => row.id === created.object)?.parent).toBe("lineage_kind_b");

    const net = new ScopeSequencer(call.scope, "lineage-create-epoch");
    net.seed(cellsFromSerialized(before));
    const view = new CellStore("derived");
    for (const cell of storeCells(net.store)) view.install(cell);
    const classifier: ScopeClassifier = {
      scopeOf: () => call.scope,
      isShared: (scope) => scope === call.scope
    };
    const plan = await planTurn({
      call,
      view,
      planningScope: call.scope,
      classifier,
      base: net.head(),
      idempotencyKey: call.id,
      stamp: net.stamp()
    });
    const transcript = plan.submit.transcript;
    const netCreated = transcript.creates[0];
    expect(netCreated).toBeDefined();
    if (!netCreated) return;
    expect(transcript.reads).toContainEqual(expect.objectContaining({
      cell: { kind: "lifecycle", object: netCreated.object },
      value: {
        parent: "$thing",
        owner: PROGRAMMER,
        name: "Fresh lineage child",
        anchor: null,
        flags: {}
      }
    }));
    expect(transcript.writes).toContainEqual(expect.objectContaining({
      cell: { kind: "lifecycle", object: netCreated.object },
      op: "set",
      value: expect.objectContaining({ parent: "lineage_kind_b" })
    }));

    const netResult = net.submit(plan.submit);
    expect(netResult.status, JSON.stringify(netResult)).toBe("accepted");
    expect(
      (net.store.get(cellKey("object_lineage", netCreated.object))?.value as { parent?: string } | undefined)?.parent
    ).toBe("lineage_kind_b");
  });

  it("accepts non-programmer builder-surface create and chparent turns", async () => {
    const world = createWorld({ catalogs: false });
    installLocalCatalogs(world, ["chat", "prog"]);
    const builder = "lineage_builder";
    world.createObject({
      id: builder,
      name: "Lineage builder",
      parent: "$builder",
      owner: builder
    });
    world.createObject({
      id: "lineage_builder_parent",
      name: "Builder parent",
      parent: "$thing",
      owner: builder
    });
    world.createObject({
      id: "lineage_builder_subject",
      name: "Builder subject",
      parent: "$thing",
      owner: builder
    });
    world.createObject({
      id: "lineage_builder_outsider",
      name: "Builder outsider",
      parent: "$player",
      owner: "lineage_builder_outsider"
    });
    expect(world.object(builder).flags.programmer).not.toBe(true);
    const before = world.exportWorld();
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "lineage-builder-create",
      route: "direct",
      scope: "#-1",
      session: null,
      actor: builder,
      target: builder,
      verb: "create",
      args: ["$thing", { name: "Builder child", location: null }]
    };
    const run = await runShadowTurnCallTranscript(authoritativePlanningWorld(before), call);
    expect(run.frame).toMatchObject({
      op: "result",
      result: { ok: true, parent: "$thing", owner: builder }
    });
    expect(run.transcript.creates).toHaveLength(1);
    expect(run.transcript.creates[0]?.writer?.progr).toBe(builder);
    expect(run.transcript.creates[0]?.authority).toBe("builder_surface");

    const scope = createShadowCommitScope({
      node: "lineage-builder-authority",
      scope: call.scope,
      serialized: before
    });
    const result = submitShadowCommit(scope, {
      kind: "woo.commit.submit.shadow.v1",
      id: call.id,
      scope: call.scope,
      expected: scope.head,
      transcript: run.transcript
    });
    expect(result.kind, JSON.stringify(result)).toBe("woo.commit.accepted.shadow.v1");
    const created = run.transcript.creates[0]!;
    expect(serializedFor(scope).objects).toContainEqual(expect.objectContaining({
      id: created.object,
      parent: "$thing",
      owner: builder
    }));
    const unmarked = structuredClone(run.transcript);
    unmarked.id = "lineage-builder-unmarked-create";
    unmarked.creates = unmarked.creates.map(({ authority: _authority, ...entry }) => entry);
    unmarked.writes = unmarked.writes.map(({ authority: _authority, ...write }) => write);
    const unmarkedTranscript = rehashTranscript(unmarked);
    const unmarkedScope = createShadowCommitScope({
      node: "lineage-builder-unmarked-authority",
      scope: unmarkedTranscript.scope,
      serialized: before
    });
    const unmarkedResult = submitShadowCommit(unmarkedScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: unmarkedTranscript.id,
      scope: unmarkedTranscript.scope,
      expected: unmarkedScope.head,
      transcript: unmarkedTranscript
    });
    expect(unmarkedResult).toMatchObject({
      kind: "woo.commit.conflict.shadow.v1",
      reason: "permission_denied"
    });
    expect(serializedFor(unmarkedScope)).toEqual(before);

    const chparentCall: ShadowTurnCall = {
      ...call,
      id: "lineage-builder-chparent",
      verb: "chparent",
      args: ["lineage_builder_subject", "lineage_builder_parent", {}]
    };
    const chparentRun = await runShadowTurnCallTranscript(
      authoritativePlanningWorld(before),
      chparentCall
    );
    expect(chparentRun.frame).toMatchObject({
      op: "result",
      result: {
        ok: true,
        id: "lineage_builder_subject",
        parent: "lineage_builder_parent"
      }
    });
    expect(chparentRun.transcript.writes).toContainEqual(expect.objectContaining({
      cell: { kind: "lifecycle", object: "lineage_builder_subject" },
      op: "set",
      authority: "builder_surface"
    }));
    const chparentScope = createShadowCommitScope({
      node: "lineage-builder-chparent-authority",
      scope: chparentCall.scope,
      serialized: before
    });
    const chparentResult = submitShadowCommit(chparentScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: chparentCall.id,
      scope: chparentCall.scope,
      expected: chparentScope.head,
      transcript: chparentRun.transcript
    });
    expect(chparentResult.kind, JSON.stringify(chparentResult)).toBe("woo.commit.accepted.shadow.v1");
    expect(
      serializedFor(chparentScope).objects.find((row) => row.id === "lineage_builder_subject")?.parent
    ).toBe("lineage_builder_parent");

    // The executor marker is not itself a capability. Rebind the otherwise
    // genuine frame to an actor that does not carry its recorded surface: the
    // authority must refuse even though object policy beneath $thing is fertile.
    const outsider = "lineage_builder_outsider";
    const forged = structuredClone(run.transcript);
    forged.id = "lineage-builder-forged-surface";
    forged.call.actor = outsider;
    forged.call.target = outsider;
    forged.creates = forged.creates.map((entry) => ({
      ...entry,
      owner: outsider,
      anchor: outsider,
      writer: entry.writer ? {
        ...entry.writer,
        progr: outsider,
        thisObj: outsider,
        callerPerms: outsider
      } : undefined
    }));
    forged.writes = forged.writes.map((write) => ({
      ...write,
      writer: write.writer ? {
        ...write.writer,
        progr: outsider,
        thisObj: outsider,
        callerPerms: outsider
      } : undefined
    }));
    const forgedTranscript = rehashTranscript(forged);
    const forgedScope = createShadowCommitScope({
      node: "lineage-builder-forged-authority",
      scope: forgedTranscript.scope,
      serialized: before
    });
    const forgedResult = submitShadowCommit(forgedScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: forgedTranscript.id,
      scope: forgedTranscript.scope,
      expected: forgedScope.head,
      transcript: forgedTranscript
    });
    expect(forgedResult).toMatchObject({
      kind: "woo.commit.conflict.shadow.v1",
      reason: "permission_denied"
    });
    expect(serializedFor(forgedScope)).toEqual(before);
  });

  it("accepts and materializes a successful chparent turn", async () => {
    const { run, result, scope, before, call } = await lineageTurn(lineageWorld(), {
      id: "lineage-chparent",
      target: "lineage_subject",
      verb: "rekind",
      args: ["lineage_kind_b"]
    });

    expect(run.frame).toMatchObject({ op: "result", result: "lineage_subject" });
    expect(run.transcript.writes).toContainEqual(expect.objectContaining({
      cell: { kind: "lifecycle", object: "lineage_subject" },
      op: "set"
    }));
    expect(readTranscriptCellFromSerializedWorld(before, {
      kind: "lifecycle",
      object: "lineage_subject"
    })).toMatchObject({
      ok: true,
      value: {
        parent: "lineage_kind_a",
        owner: PROGRAMMER,
        name: "Lineage subject",
        anchor: null,
        flags: {}
      }
    });
    expect(result.kind, JSON.stringify(result)).toBe("woo.commit.accepted.shadow.v1");
    const committed = serializedFor(scope);
    expect(committed.objects.find((obj) => obj.id === "lineage_subject")?.parent).toBe("lineage_kind_b");
    expect(committed.objects.find((obj) => obj.id === "lineage_kind_a")?.children).not.toContain("lineage_subject");
    expect(committed.objects.find((obj) => obj.id === "lineage_kind_b")?.children).toContain("lineage_subject");

    // The same accepted transcript is a pure function of the same authority
    // pre-state. A second authority reaches byte-identical state/head, and a
    // receiver applying the accepted frame reaches the same materialization.
    const twin = createShadowCommitScope({ node: "lineage-twin", scope: call.scope, serialized: before });
    const twinResult = submitShadowCommit(twin, {
      kind: "woo.commit.submit.shadow.v1",
      id: call.id,
      scope: call.scope,
      expected: twin.head,
      transcript: run.transcript
    });
    expect(twinResult.kind).toBe("woo.commit.accepted.shadow.v1");
    expect(serializedFor(twin)).toEqual(committed);
    expect(twin.head).toEqual(scope.head);

    if (result.kind !== "woo.commit.accepted.shadow.v1") throw new Error(JSON.stringify(result));
    const receiver = createShadowCommitScope({ node: "lineage-receiver", scope: call.scope, serialized: before });
    applyAcceptedShadowFrame(receiver, result, run.transcript);
    expect(serializedFor(receiver)).toEqual(committed);
    const cold = createShadowCommitScope({
      node: "lineage-cold",
      scope: call.scope,
      serialized: structuredClone(committed)
    });
    expect(serializedFor(cold).objects.find((obj) => obj.id === "lineage_subject")?.parent).toBe("lineage_kind_b");
  });

  it("accepts an inherited read resolved through the same-turn parent", async () => {
    const { run, result, scope, before, call } = await lineageTurn(lineageWorld(), {
      id: "lineage-chparent-derived-read",
      target: "lineage_subject",
      verb: "rekind_and_read",
      args: ["lineage_kind_b"]
    });

    expect(run.frame).toMatchObject({ op: "result", result: 99 });
    expect(run.transcript.reads).toContainEqual(expect.objectContaining({
      cell: {
        kind: "prop",
        object: "lineage_subject",
        name: "inherited_value"
      },
      value: 99
    }));
    expect(result.kind, JSON.stringify(result)).toBe("woo.commit.accepted.shadow.v1");
    expect(serializedFor(scope).objects.find((obj) => obj.id === "lineage_subject")?.parent)
      .toBe("lineage_kind_b");

    // The lineage write is the bounded explanation for this proof. Removing
    // it leaves no alternate topology and must restore the ordinary stale-read
    // refusal rather than making post-write validation generic.
    const noLineageWrite = structuredClone(run.transcript);
    noLineageWrite.id = "lineage-derived-read-without-write";
    noLineageWrite.writes = noLineageWrite.writes.filter((write) =>
      write.cell.kind !== "lifecycle" || write.cell.object !== "lineage_subject"
    );
    const noLineageTranscript = rehashTranscript(noLineageWrite);
    const noLineageScope = createShadowCommitScope({
      node: "lineage-no-write-authority",
      scope: call.scope,
      serialized: before
    });
    const noLineageResult = submitShadowCommit(noLineageScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: noLineageTranscript.id,
      scope: call.scope,
      expected: noLineageScope.head,
      transcript: noLineageTranscript
    });
    expect(noLineageResult).toMatchObject({
      kind: "woo.commit.conflict.shadow.v1",
      reason: "read_version_mismatch"
    });
    expect(serializedFor(noLineageScope)).toEqual(before);

    // Even an authorized lineage view cannot hide a stale CAS on the lineage
    // mutation that produced it.
    const staleLineage = structuredClone(run.transcript);
    staleLineage.id = "lineage-derived-read-stale-write";
    staleLineage.writes = staleLineage.writes.map((write) =>
      write.cell.kind === "lifecycle" && write.cell.object === "lineage_subject"
        ? { ...write, prior: "stale-lineage-version" }
        : write
    );
    const staleTranscript = rehashTranscript(staleLineage);
    const staleScope = createShadowCommitScope({
      node: "lineage-stale-write-authority",
      scope: call.scope,
      serialized: before
    });
    const staleResult = submitShadowCommit(staleScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: staleTranscript.id,
      scope: call.scope,
      expected: staleScope.head,
      transcript: staleTranscript
    });
    expect(staleResult.kind).toBe("woo.commit.conflict.shadow.v1");
    if (staleResult.kind !== "woo.commit.conflict.shadow.v1") {
      throw new Error(JSON.stringify(staleResult));
    }
    expect(staleResult.errors).toContainEqual(expect.stringContaining(
      "write prior mismatch lineage_subject.lifecycle"
    ));
    expect(serializedFor(staleScope)).toEqual(before);

    // The overlay is conditional on independently valid recorded writers.
    // A forged principal gets neither mutation authority nor the derived-read
    // exception.
    const unauthorized = structuredClone(run.transcript);
    unauthorized.id = "lineage-derived-read-unauthorized";
    unauthorized.writes = unauthorized.writes.map((write) => ({
      ...write,
      writer: write.writer
        ? { ...write.writer, progr: "lineage_missing_principal" }
        : undefined
    }));
    const unauthorizedTranscript = rehashTranscript(unauthorized);
    const unauthorizedScope = createShadowCommitScope({
      node: "lineage-unauthorized-derived-read",
      scope: call.scope,
      serialized: before
    });
    const unauthorizedResult = submitShadowCommit(unauthorizedScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: unauthorizedTranscript.id,
      scope: call.scope,
      expected: unauthorizedScope.head,
      transcript: unauthorizedTranscript
    });
    expect(unauthorizedResult).toMatchObject({
      kind: "woo.commit.conflict.shadow.v1",
      reason: "permission_denied"
    });
    if (unauthorizedResult.kind !== "woo.commit.conflict.shadow.v1") {
      throw new Error(JSON.stringify(unauthorizedResult));
    }
    expect(unauthorizedResult.errors).toContain(
      "read value mismatch lineage_subject.inherited_value"
    );
    expect(serializedFor(unauthorizedScope)).toEqual(before);
  });

  it("resolves same-turn lineage reads through descendants of the reparented object", async () => {
    const { run, result, scope } = await lineageTurn(lineageWorld(), {
      id: "lineage-descendant-derived-read",
      target: "lineage_descendant",
      verb: "rekind_ancestor_and_read",
      args: ["lineage_subject", "lineage_kind_b"]
    });

    expect(run.frame).toMatchObject({ op: "result", result: 99 });
    expect(run.transcript.reads).toContainEqual(expect.objectContaining({
      cell: {
        kind: "prop",
        object: "lineage_descendant",
        name: "inherited_value"
      },
      value: 99
    }));
    expect(result.kind, JSON.stringify(result)).toBe("woo.commit.accepted.shadow.v1");
    expect(serializedFor(scope).objects.find((obj) => obj.id === "lineage_subject")?.parent)
      .toBe("lineage_kind_b");
  });

  it("accepts rename and flag turns through the same lifecycle vocabulary", async () => {
    const renamed = await lineageTurn(lineageWorld(), {
      id: "lineage-rename",
      target: "lineage_subject",
      verb: "relabel",
      args: ["Renamed lineage subject"]
    });
    expect(renamed.result.kind, JSON.stringify(renamed.result)).toBe("woo.commit.accepted.shadow.v1");
    const renamedObject = serializedFor(renamed.scope).objects.find((obj) => obj.id === "lineage_subject");
    expect(renamedObject?.name).toBe("Renamed lineage subject");
    expect(renamedObject?.properties).toContainEqual(["name", "Renamed lineage subject"]);

    const flagWorld = createWorld();
    const signup = await flagWorld.beginSignup("shadow-lineage@woo.dev", "password123");
    const verified = flagWorld.verifySignup(signup.verification_token);
    const human = verified.actor;
    const account = flagWorld.propOrNull(human, "account") as string;
    flagWorld.setProp(account, "programmer_grant_quota", 1);
    const provisioned = await flagWorld.directCall(
      "lineage-provision-agent",
      human,
      human,
      "create_agent",
      ["Lineage agent", "", false]
    );
    if (provisioned.op !== "result") throw new Error(JSON.stringify(provisioned));
    const agent = (provisioned.result as { actor_id: string }).actor_id;
    const before = flagWorld.exportWorld();
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "lineage-flag",
      route: "direct",
      scope: "#-1",
      session: null,
      actor: human,
      target: human,
      verb: "promote_agent_to_programmer",
      args: [agent]
    };
    const run = await runShadowTurnCallTranscript(authoritativePlanningWorld(before), call);
    expect(run.transcript.complete, run.transcript.incompleteReasons.join(",")).toBe(true);
    expect(run.transcript.writes).toContainEqual(expect.objectContaining({
      cell: { kind: "lifecycle", object: agent },
      op: "set"
    }));
    const scope = createShadowCommitScope({ node: "lineage-flag-authority", scope: call.scope, serialized: before });
    const result = submitShadowCommit(scope, {
      kind: "woo.commit.submit.shadow.v1",
      id: call.id,
      scope: call.scope,
      expected: scope.head,
      transcript: run.transcript
    });
    expect(result.kind, JSON.stringify(result)).toBe("woo.commit.accepted.shadow.v1");
    expect(serializedFor(scope).objects.find((obj) => obj.id === agent)?.flags.programmer).toBe(true);
  });

  it("applies the complete lineage payload but refuses open or unauthorized replacements", async () => {
    const original = await lineageTurn(lineageWorld(), {
      id: "lineage-authority-probe",
      target: "lineage_subject",
      verb: "rekind",
      args: ["lineage_kind_b"]
    });
    const lifecycleWrite = original.run.transcript.writes.find((write) =>
      write.cell.kind === "lifecycle" && write.cell.object === "lineage_subject" && write.op === "set"
    );
    if (!lifecycleWrite) throw new Error("missing lifecycle replacement");

    // Catalog-owned lineage updates use the same applier and may change every
    // semantic field. Host-only row material is retained because it is not in
    // the transcript namespace.
    const row = structuredClone(original.before.objects.find((obj) => obj.id === "lineage_subject")!);
    row.eventSchemas = [["retained", { value: "int" }]];
    applyTranscriptWriteToSerializedObject(row, {
      ...lifecycleWrite,
      value: {
        parent: "lineage_kind_b",
        owner: "$wiz",
        name: "Catalog replacement",
        anchor: "lineage_kind_b",
        flags: { fertile: true, programmer: false }
      }
    }, original.run.transcript);
    expect(row).toMatchObject({
      parent: "lineage_kind_b",
      owner: "$wiz",
      name: "Catalog replacement",
      anchor: "lineage_kind_b",
      flags: { fertile: true, programmer: false },
      eventSchemas: [["retained", { value: "int" }]]
    });
    expect(parseShadowLifecycleCellValue({
      parent: "lineage_kind_b",
      owner: "$wiz",
      name: "Bad namespace",
      anchor: null,
      flags: {},
      host_private: true
    })).toBeNull();
    const inheritedOwner = Object.assign(Object.create({ owner: "$wiz" }), {
      parent: "lineage_kind_b",
      name: "Inherited authority",
      anchor: null,
      flags: {}
    }) as WooValue;
    expect(parseShadowLifecycleCellValue(inheritedOwner)).toBeNull();

    // A programmer-owned frame may reparent/rename its object, but it cannot
    // smuggle a privilege flag into that otherwise-valid replacement.
    const forged = structuredClone(original.run.transcript);
    forged.id = "lineage-forged-flag";
    forged.writes = forged.writes.map((write) => {
      if (write.cell.kind !== "lifecycle" || write.cell.object !== "lineage_subject" || write.op !== "set") return write;
      return {
        ...write,
        value: {
          ...(write.value as Record<string, WooValue>),
          flags: { programmer: true }
        }
      };
    });
    const forgedTranscript = rehashTranscript(forged);
    const forgedScope = createShadowCommitScope({
      node: "lineage-forged-authority",
      scope: forgedTranscript.scope,
      serialized: original.before
    });
    const forgedResult = submitShadowCommit(forgedScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: forgedTranscript.id,
      scope: forgedTranscript.scope,
      expected: forgedScope.head,
      transcript: forgedTranscript
    });
    expect(forgedResult).toMatchObject({
      kind: "woo.commit.conflict.shadow.v1",
      reason: "permission_denied"
    });
    if (forgedResult.kind !== "woo.commit.conflict.shadow.v1") throw new Error(JSON.stringify(forgedResult));
    expect(forgedResult.errors).toContain("permission_denied: no recorded authority can replace lineage_subject.lifecycle");
    expect(serializedFor(forgedScope)).toEqual(original.before);

    // Authority follows lineage writes in transcript order. Two individually
    // plausible reparentings cannot be combined to synthesize a recursive
    // graph that the runtime's second chparent would have refused.
    const forgedCycle = structuredClone(original.run.transcript);
    forgedCycle.id = "lineage-forged-cycle";
    forgedCycle.writes.push({
      ...lifecycleWrite,
      cell: { kind: "lifecycle", object: "lineage_kind_b" },
      value: {
        parent: "lineage_subject",
        owner: PROGRAMMER,
        name: "Lineage kind B",
        anchor: null,
        flags: { fertile: true }
      }
    });
    const cycleTranscript = rehashTranscript(forgedCycle);
    const cycleScope = createShadowCommitScope({
      node: "lineage-cycle-authority",
      scope: cycleTranscript.scope,
      serialized: original.before
    });
    const cycleResult = submitShadowCommit(cycleScope, {
      kind: "woo.commit.submit.shadow.v1",
      id: cycleTranscript.id,
      scope: cycleTranscript.scope,
      expected: cycleScope.head,
      transcript: cycleTranscript
    });
    expect(cycleResult).toMatchObject({
      kind: "woo.commit.conflict.shadow.v1",
      reason: "permission_denied"
    });
    expect(serializedFor(cycleScope)).toEqual(original.before);
  });
});
