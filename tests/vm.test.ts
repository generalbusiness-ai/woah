import { describe, expect, it, vi } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { createSerializedTinyVmTask, runSerializedTinyVmTask, type SerializedVmTask } from "../src/core/tiny-vm";
import { freezeTinyBytecode, type Message, type TinyBytecode, type VerbDef } from "../src/core/types";

function message(actor: string, target: string, verb: string, args: unknown[] = []): Message {
  return { actor, target, verb, args: args as any[] };
}

function authedWorld() {
  const world = createWorld();
  const session = world.auth("guest:vm");
  return { world, session, actor: session.actor };
}

async function callInDubspace(
  world: ReturnType<typeof createWorld>,
  sessionId: string,
  requestId: string,
  request: Message
): Promise<ReturnType<typeof world.call>> {
  const sessionActor = world.sessions.get(sessionId)?.actor;
  if (sessionActor === request.actor && !world.hasPresence(sessionActor, "the_dubspace")) {
    const entered = await world.directCall(`enter-${requestId}`, sessionActor, "the_dubspace", "enter", []);
    if (entered.op === "error") return entered;
  }
  return world.call(requestId, sessionId, "the_dubspace", request);
}

function addBytecodeVerb(name: string, bytecode: TinyBytecode): VerbDef {
  return {
    kind: "bytecode",
    name,
    aliases: [],
    owner: "$wiz",
    perms: "rxd",
    arg_spec: {},
    source: `test ${name}`,
    source_hash: `test-${name}`,
    version: 1,
    line_map: {},
    bytecode
  };
}

function vmCtx(world: ReturnType<typeof createWorld>, actor: string, target: string, verb: string, args: unknown[] = []) {
  return {
    world,
    space: "the_dubspace",
    seq: 1000,
    session: null,
    actor,
    player: actor,
    caller: "#-1",
    callerPerms: "$wiz",
    progr: "$wiz",
    thisObj: target,
    verbName: verb,
    definer: target,
    message: message(actor, target, verb, args),
    observations: [],
    observe: () => {}
  };
}

describe("v0.5 in-memory VM", () => {
  it("runs range loops and arithmetic", async () => {
    const { world, session, actor } = authedWorld();
    world.addVerb(
      "delay_1",
      addBytecodeVerb("sum_to", {
        literals: [],
        num_locals: 2,
        max_stack: 4,
        version: 1,
        ops: [
          ["PUSH_INT", 0],
          ["POP_LOCAL", 1],
          ["PUSH_ARG", 0],
          ["PUSH_INT", 1],
          ["FOR_RANGE_INIT", 0],
          ["FOR_RANGE_NEXT", 0, 5],
          ["PUSH_LOCAL", 1],
          ["PUSH_LOCAL", 0],
          ["ADD"],
          ["POP_LOCAL", 1],
          ["JUMP", -6],
          ["FOR_END"],
          ["PUSH_LOCAL", 1],
          ["RETURN"]
        ]
      })
    );

    const applied = await callInDubspace(world, session.id, "sum", message(actor, "delay_1", "sum_to", [5]));
    expect(applied.op).toBe("applied");
    if (applied.op === "applied") expect(applied.observations).toEqual([]);
    expect(await world.dispatch(
      {
          world,
          space: "the_dubspace",
          seq: 99,
          session: null,
          actor,
        player: actor,
        caller: "#-1",
        callerPerms: actor,
        progr: actor,
        thisObj: "delay_1",
        verbName: "sum_to",
        definer: "delay_1",
        message: message(actor, "delay_1", "sum_to", [5]),
        observations: [],
        observe: () => {}
      },
      "delay_1",
      "sum_to",
      [5]
    )).toBe(15);
  });

  it("executes on frozen (shared) bytecode without mutating its literal source", async () => {
    // Bytecode is shared by reference across worlds and deep-frozen. The VM's
    // safety depends on PUSH_LIT cloning each literal (via cloneValue) before it
    // reaches the stack, so a verb that mutates a list built from a literal must
    // (a) not throw against the frozen literal and (b) leave the frozen source
    // untouched. If PUSH_LIT ever stopped cloning, LIST_APPEND would try to
    // mutate the frozen literal in place and throw — this test pins that.
    const { world, actor } = authedWorld();
    const bytecode = freezeTinyBytecode({
      literals: [["seed"], "added"],
      num_locals: 0,
      max_stack: 4,
      version: 1,
      ops: [
        ["PUSH_LIT", 0],
        ["PUSH_LIT", 1],
        ["LIST_APPEND"],
        ["RETURN"]
      ]
    });
    expect(Object.isFrozen(bytecode)).toBe(true);
    world.addVerb("delay_1", addBytecodeVerb("append_to_literal", bytecode));

    const result = await world.dispatch(
      vmCtx(world, actor, "delay_1", "append_to_literal"),
      "delay_1",
      "append_to_literal",
      []
    );

    expect(result).toEqual(["seed", "added"]);
    // The frozen literal source is intact: the VM mutated a per-run clone, not
    // the shared bytecode.
    expect(bytecode.literals[0]).toEqual(["seed"]);
    expect(Object.isFrozen(bytecode.literals[0])).toBe(true);
  });

  it("runs nested CALL_VERB and inherited PASS", async () => {
    const { world, session, actor } = authedWorld();
    world.createObject({ id: "base_counter", name: "Base Counter", parent: "$thing", owner: "$wiz" });
    world.createObject({ id: "child_counter", name: "Child Counter", parent: "base_counter", owner: "$wiz" });
    world.addVerb(
      "base_counter",
      addBytecodeVerb("value", {
        literals: [],
        num_locals: 0,
        max_stack: 1,
        version: 1,
        ops: [["PUSH_INT", 10], ["RETURN"]]
      })
    );
    world.addVerb(
      "child_counter",
      addBytecodeVerb("value", {
        literals: [],
        num_locals: 0,
        max_stack: 2,
        version: 1,
        ops: [["PASS", 0], ["PUSH_INT", 5], ["ADD"], ["RETURN"]]
      })
    );
    world.addVerb(
      "delay_1",
      addBytecodeVerb("call_counter", {
        literals: ["child_counter", "value"],
        num_locals: 0,
        max_stack: 3,
        version: 1,
        ops: [["PUSH_LIT", 0], ["PUSH_LIT", 1], ["CALL_VERB", 0], ["RETURN"]]
      })
    );

    const applied = await callInDubspace(world, session.id, "call-counter", message(actor, "delay_1", "call_counter", []));
    expect(applied.op).toBe("applied");
    expect(await world.dispatch(
      {
          world,
          space: "the_dubspace",
          seq: 100,
          session: null,
          actor,
        player: actor,
        caller: "#-1",
        callerPerms: actor,
        progr: actor,
        thisObj: "delay_1",
        verbName: "call_counter",
        definer: "delay_1",
        message: message(actor, "delay_1", "call_counter", []),
        observations: [],
        observe: () => {}
      },
      "delay_1",
      "call_counter",
      []
    )).toBe(15);
  });

  it("turns excessive recursive CALL_VERB into E_CALL_DEPTH", async () => {
    const { world, session, actor } = authedWorld();
    world.addVerb(
      "delay_1",
      addBytecodeVerb("recurse", {
        literals: ["recurse"],
        num_locals: 0,
        max_stack: 2,
        version: 1,
        ops: [["PUSH_THIS"], ["PUSH_LIT", 0], ["CALL_VERB", 0], ["RETURN"]]
      })
    );

    const applied = await callInDubspace(world, session.id, "depth", message(actor, "delay_1", "recurse", []));
    expect(applied.op).toBe("applied");
    if (applied.op === "applied") {
      expect(applied.observations[0].type).toBe("$error");
      expect(applied.observations[0].code).toBe("E_CALL_DEPTH");
    }
  });

  it("catches raised VM errors with TRY handlers", async () => {
    const { world, session, actor } = authedWorld();
    world.addVerb(
      "delay_1",
      addBytecodeVerb("catch_div", {
        literals: [["E_DIV"], "code"],
        num_locals: 0,
        max_stack: 3,
        version: 1,
        ops: [
          ["TRY_PUSH", 4, 0],
          ["PUSH_INT", 1],
          ["PUSH_INT", 0],
          ["DIV"],
          ["TRY_POP"],
          ["PUSH_LIT", 1],
          ["MAP_GET"],
          ["RETURN"]
        ]
      })
    );

    expect(await world.dispatch(
      {
          world,
          space: "the_dubspace",
          seq: 101,
          session: null,
          actor,
        player: actor,
        caller: "#-1",
        callerPerms: actor,
        progr: actor,
        thisObj: "delay_1",
        verbName: "catch_div",
        definer: "delay_1",
        message: message(actor, "delay_1", "catch_div", []),
        observations: [],
        observe: () => {}
      },
      "delay_1",
      "catch_div",
      []
    )).toBe("E_DIV");
    const applied = await callInDubspace(world, session.id, "catch-div", message(actor, "delay_1", "catch_div", []));
    expect(applied.op).toBe("applied");
  });

  it("unwinds nested bytecode CALL_VERB errors into caller handlers", async () => {
    const { world, actor } = authedWorld();
    world.addVerb(
      "delay_1",
      addBytecodeVerb("explode", {
        literals: ["E_BOOM"],
        num_locals: 0,
        max_stack: 1,
        version: 1,
        ops: [["PUSH_LIT", 0], ["RAISE"], ["PUSH_INT", 0], ["RETURN"]]
      })
    );
    world.addVerb(
      "delay_1",
      addBytecodeVerb("catch_nested", {
        literals: [["E_BOOM"], "explode", "code"],
        num_locals: 0,
        max_stack: 3,
        version: 1,
        ops: [["TRY_PUSH", 4, 0], ["PUSH_THIS"], ["PUSH_LIT", 1], ["CALL_VERB", 0], ["TRY_POP"], ["PUSH_LIT", 2], ["MAP_GET"], ["RETURN"]]
      })
    );

    expect(
      await world.dispatch(
        {
            world,
            space: "the_dubspace",
            seq: 104,
            session: null,
            actor,
          player: actor,
          caller: "#-1",
          callerPerms: actor,
          progr: actor,
          thisObj: "delay_1",
          verbName: "catch_nested",
          definer: "delay_1",
          message: message(actor, "delay_1", "catch_nested", []),
          observations: [],
          observe: () => {}
        },
        "delay_1",
        "catch_nested",
        []
      )
    ).toBe("E_BOOM");
  });

  it("hydrates a serialized VM call stack and resumes execution", async () => {
    const { world, actor } = authedWorld();
    const callerBytecode: TinyBytecode = {
      literals: [],
      num_locals: 0,
      max_stack: 2,
      version: 1,
      ops: [["PUSH_INT", 5], ["ADD"], ["RETURN"]]
    };
    const calleeBytecode: TinyBytecode = {
      literals: [],
      num_locals: 0,
      max_stack: 1,
      version: 1,
      ops: [["PUSH_INT", 7], ["RETURN"]]
    };
    const task: SerializedVmTask = {
      version: 1,
      frames: [
        createSerializedTinyVmTask(vmCtx(world, actor, "delay_1", "caller"), callerBytecode, []).frames[0],
        createSerializedTinyVmTask(vmCtx(world, actor, "delay_1", "callee"), calleeBytecode, []).frames[0]
      ]
    };

    expect((await runSerializedTinyVmTask(world, task)).result).toBe(12);
  });

  it("turns tick exhaustion into a sequenced behavior failure", async () => {
    const { world, session, actor } = authedWorld();
    world.addVerb(
      "delay_1",
      addBytecodeVerb("burn_ticks", {
        literals: [],
        num_locals: 0,
        max_stack: 2,
        max_ticks: 3,
        version: 1,
        ops: [["PUSH_INT", 1], ["PUSH_INT", 2], ["ADD"], ["RETURN"]]
      })
    );

    const applied = await callInDubspace(world, session.id, "ticks", message(actor, "delay_1", "burn_ticks", []));
    expect(applied.op).toBe("applied");
    if (applied.op === "applied") {
      expect(applied.observations[0].type).toBe("$error");
      expect(applied.observations[0].code).toBe("E_TICKS");
    }
  });

  it("turns wall-time exhaustion into a VM failure", async () => {
    const { world, actor } = authedWorld();
    world.addVerb(
      "delay_1",
      addBytecodeVerb("timeout", {
        literals: [],
        num_locals: 0,
        max_stack: 2,
        max_wall_ms: 5,
        version: 1,
        ops: [["PUSH_INT", 1], ["PUSH_INT", 2], ["ADD"], ["RETURN"]]
      })
    );
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(10);
    try {
      await expect(
        world.dispatch(
          {
              world,
              space: "the_dubspace",
              seq: 102,
              session: null,
              actor,
            player: actor,
            caller: "#-1",
            callerPerms: actor,
            progr: actor,
            thisObj: "delay_1",
            verbName: "timeout",
            definer: "delay_1",
            message: message(actor, "delay_1", "timeout", []),
            observations: [],
            observe: () => {}
          },
          "delay_1",
          "timeout",
          []
        )
      ).rejects.toMatchObject({ code: "E_TIMEOUT" });
    } finally {
      now.mockRestore();
    }
  });

  it("runs collection hot-path opcodes and STR_INTERP", async () => {
    const { world, actor } = authedWorld();
    world.addVerb(
      "delay_1",
      addBytecodeVerb("collections", {
        literals: ["hello ", "world", "length"],
        num_locals: 0,
        max_stack: 4,
        version: 1,
        ops: [
          ["PUSH_INT", 1],
          ["PUSH_INT", 2],
          ["MAKE_LIST", 2],
          ["PUSH_INT", 3],
          ["LIST_APPEND"],
          ["BUILTIN", "length", 1],
          ["PUSH_LIT", 0],
          ["PUSH_LIT", 1],
          ["STR_INTERP", 2],
          ["BUILTIN", "length", 1],
          ["ADD"],
          ["RETURN"]
        ]
      })
    );
    expect(
      await world.dispatch(
        {
            world,
            space: "the_dubspace",
            seq: 103,
            session: null,
            actor,
          player: actor,
          caller: "#-1",
          callerPerms: actor,
          progr: actor,
          thisObj: "delay_1",
          verbName: "collections",
          definer: "delay_1",
          message: message(actor, "delay_1", "collections", []),
          observations: [],
          observe: () => {}
        },
        "delay_1",
        "collections",
        []
      )
    ).toBe(14);
  });

  it("schedules delayed FORK tasks through the durable task queue", async () => {
    const { world, session, actor } = authedWorld();
    world.addVerb(
      "delay_1",
      addBytecodeVerb("mark", {
        literals: ["forked", "type", "fork_ran", "value", null],
        num_locals: 0,
        max_stack: 6,
        version: 1,
        ops: [
          ["PUSH_THIS"],
          ["PUSH_LIT", 0],
          ["PUSH_ARG", 0],
          ["SET_PROP"],
          ["PUSH_LIT", 1],
          ["PUSH_LIT", 2],
          ["PUSH_LIT", 3],
          ["PUSH_ARG", 0],
          ["MAKE_MAP", 2],
          ["OBSERVE"],
          ["PUSH_LIT", 4],
          ["RETURN"]
        ]
      })
    );
    world.addVerb(
      "delay_1",
      addBytecodeVerb("schedule_mark", {
        literals: ["mark"],
        num_locals: 0,
        max_stack: 5,
        version: 1,
        ops: [["PUSH_INT", 0], ["PUSH_THIS"], ["PUSH_LIT", 0], ["PUSH_ARG", 0], ["FORK", 1], ["RETURN"]]
      })
    );

    const scheduled = await callInDubspace(world, session.id, "fork", message(actor, "delay_1", "schedule_mark", ["later"]));
    expect(scheduled.op).toBe("applied");
    expect(world.parkedTasks.size).toBe(1);
    expect(world.propOrNull("delay_1", "forked")).toBeNull();
    const ran = await world.runDueTasks(Date.now() + 1);
    expect(ran).toHaveLength(1);
    expect(ran[0].frame?.op).toBe("applied");
    if (ran[0].frame?.op === "applied") {
      expect(ran[0].frame.seq).toBe(2);
      expect(ran[0].frame.observations[0].type).toBe("fork_ran");
      expect(ran[0].frame.message.verb).toBe("mark");
    }
    expect(world.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["schedule_mark", "mark"]);
    expect(world.getProp("delay_1", "forked")).toBe("later");
    expect(world.parkedTasks.size).toBe(0);
  });

  it("parks SUSPEND continuations and resumes them through a sequenced frame", async () => {
    const { world, session, actor } = authedWorld();
    world.addVerb(
      "delay_1",
      addBytecodeVerb("suspend_then_mark", {
        literals: ["after_suspend", "type", "resumed_after_suspend", null],
        num_locals: 0,
        max_stack: 6,
        version: 1,
        ops: [
          ["PUSH_INT", 0],
          ["SUSPEND"],
          ["POP"],
          ["PUSH_THIS"],
          ["PUSH_LIT", 0],
          ["PUSH_ARG", 0],
          ["SET_PROP"],
          ["PUSH_LIT", 1],
          ["PUSH_LIT", 2],
          ["MAKE_MAP", 1],
          ["OBSERVE"],
          ["PUSH_LIT", 3],
          ["RETURN"]
        ]
      })
    );

    const applied = await callInDubspace(world, session.id, "suspend", message(actor, "delay_1", "suspend_then_mark", ["ok"]));
    expect(applied.op).toBe("applied");
    if (applied.op === "applied") {
      expect(applied.observations[0].type).toBe("task_suspended");
    }
    expect(world.parkedTasks.size).toBe(1);
    expect(world.propOrNull("delay_1", "after_suspend")).toBeNull();
    const ran = await world.runDueTasks(Date.now() + 1);
    expect(ran).toHaveLength(1);
    expect(ran[0].frame?.op).toBe("applied");
    if (ran[0].frame?.op === "applied") {
      expect(ran[0].frame.seq).toBe(2);
      expect(ran[0].frame.message.verb).toBe("$resume");
      expect(ran[0].frame.observations.map((obs) => obs.type)).toContain("resumed_after_suspend");
    }
    expect(world.getProp("delay_1", "after_suspend")).toBe("ok");
    expect(world.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["suspend_then_mark", "$resume"]);
    expect(world.parkedTasks.size).toBe(0);
  });

  it("serializes observations that exist when a VM continuation parks", async () => {
    const { world, session, actor } = authedWorld();
    world.addVerb(
      "delay_1",
      addBytecodeVerb("observe_then_suspend", {
        literals: ["type", "before_suspend", null],
        num_locals: 0,
        max_stack: 4,
        version: 1,
        ops: [["PUSH_LIT", 0], ["PUSH_LIT", 1], ["MAKE_MAP", 1], ["OBSERVE"], ["PUSH_INT", 0], ["SUSPEND"], ["PUSH_LIT", 2], ["RETURN"]]
      })
    );

    const applied = await callInDubspace(world, session.id, "observe-suspend", message(actor, "delay_1", "observe_then_suspend", []));
    expect(applied.op).toBe("applied");
    if (applied.op === "applied") expect(applied.observations.map((obs) => obs.type)).toEqual(["before_suspend", "task_suspended"]);
    const parked = Array.from(world.parkedTasks.values())[0]?.serialized as any;
    expect(parked?.task?.frames?.[0]?.ctx?.observations?.map((obs: any) => obs.type)).toEqual(["before_suspend"]);
  });

  it("does not count suspended wall time against resumed VM continuations", async () => {
    const { world, session, actor } = authedWorld();
    world.addVerb(
      "delay_1",
      addBytecodeVerb("short_wall_suspend", {
        literals: ["after_wall_suspend", null],
        num_locals: 0,
        max_stack: 4,
        max_wall_ms: 5,
        version: 1,
        ops: [["PUSH_INT", 0], ["SUSPEND"], ["POP"], ["PUSH_THIS"], ["PUSH_LIT", 0], ["PUSH_ARG", 0], ["SET_PROP"], ["PUSH_LIT", 1], ["RETURN"]]
      })
    );

    const applied = await callInDubspace(world, session.id, "wall-suspend", message(actor, "delay_1", "short_wall_suspend", ["ok"]));
    expect(applied.op).toBe("applied");
    const parked = Array.from(world.parkedTasks.values())[0]?.serialized as any;
    parked.task.frames[0].startedAt = Date.now() - 60_000;
    parked.task.frames[0].activeWallMs = 0;

    const ran = await world.runDueTasks(Date.now() + 1);
    expect(ran).toHaveLength(1);
    expect(ran[0].frame?.op).toBe("applied");
    expect(world.getProp("delay_1", "after_wall_suspend")).toBe("ok");
  });

  it("parks READ continuations and resumes them through a sequenced input frame", async () => {
    const { world, session, actor } = authedWorld();
    world.addVerb(
      "delay_1",
      addBytecodeVerb("read_then_mark", {
        literals: ["read_value", "type", "read_resumed", "value", null],
        num_locals: 1,
        max_stack: 6,
        version: 1,
        ops: [
          ["PUSH_ACTOR"],
          ["READ"],
          ["POP_LOCAL", 0],
          ["PUSH_THIS"],
          ["PUSH_LIT", 0],
          ["PUSH_LOCAL", 0],
          ["SET_PROP"],
          ["PUSH_LIT", 1],
          ["PUSH_LIT", 2],
          ["PUSH_LIT", 3],
          ["PUSH_LOCAL", 0],
          ["MAKE_MAP", 2],
          ["OBSERVE"],
          ["PUSH_LIT", 4],
          ["RETURN"]
        ]
      })
    );

    const applied = await callInDubspace(world, session.id, "read", message(actor, "delay_1", "read_then_mark", []));
    expect(applied.op).toBe("applied");
    if (applied.op === "applied") expect(applied.observations[0].type).toBe("task_awaiting_read");
    expect(world.parkedTasks.size).toBe(1);
    expect(world.propOrNull("delay_1", "read_value")).toBeNull();

    const noTask = await world.deliverInput("guest_999", "ignored");
    expect(noTask).toBeNull();

    const ran = await world.deliverInput(actor, "typed text");
    expect(ran?.frame?.op).toBe("applied");
    if (ran?.frame?.op === "applied") {
      expect(ran.frame.seq).toBe(2);
      expect(ran.frame.message.verb).toBe("$resume");
      expect(ran.frame.message.body?.kind).toBe("vm_read");
      expect(ran.frame.message.body?.input).toBe("typed text");
      expect(ran.frame.observations.map((obs) => obs.type)).toContain("read_resumed");
    }
    expect(world.getProp("delay_1", "read_value")).toBe("typed text");
    expect(world.replay("the_dubspace", 1, 10).map((entry) => entry.message.verb)).toEqual(["read_then_mark", "$resume"]);
    expect(world.parkedTasks.size).toBe(0);
  });
});
