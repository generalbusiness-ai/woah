import { describe, expect, it, vi } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { BUILTIN_NAMES, runTinyVm } from "../src/core/tiny-vm";
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
    const entered = await world.directCall(`move-${requestId}`, sessionActor, sessionActor, "moveto", ["the_dubspace"], { sessionId });
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
});

describe("builtin index stability", () => {
  it("keeps every previously-published builtin at its original index", () => {
    // Persisted bytecode encodes builtins by INDEX. Inserting a name anywhere
    // but the end silently re-points every later builtin in an aged world's
    // stored verbs — which is exactly what the scheduling work did once, and
    // a green test suite said nothing. This freezes a prefix so the next
    // insert fails here instead of in someone's world.
    const frozen = [
      "length",
      "keys",
      "values",
      "has",
      "typeof",
      "to_string",
      "min",
      "max",
      "floor",
      "ceil",
      "round",
      "abs",
      "now",
      "create",
      "recycle",
      "move",
      "moveto",
      "chparent",
      "has_flag",
      "isa",
      "is_recycled",
      "directory_reconcile_corenames",
      "random",
      "contents",
      "location",
      "task_perms",
      "caller_perms",
      "set_task_perms",
      "set_presence",
      "observe_to_space",
      "tell",
      "current_location",
      "current_session",
      "session_location",
      "all_locations",
      "primary_session",
      "is_connected",
      "idle_seconds",
      "builder_create_object",
      "builder_chparent",
      "_dead_builder_set_property",
      "_dead_builder_inspect",
      "_dead_builder_search",
      "_dead_programmer_inspect",
      "_dead_programmer_resolve_verb",
      "_dead_programmer_list_verb",
      "_dead_programmer_search",
      "_dead_programmer_install_verb",
      "_dead_programmer_set_verb_info",
      "_dead_programmer_set_property_info",
      "_dead_programmer_trace",
      "editor_invoke",
      "editor_what",
      "editor_view",
      "editor_replace",
      "editor_insert",
      "editor_delete",
      "editor_dry_run",
      "editor_save",
      "editor_pause",
      "editor_abort",
      "str_trim",
      "str_lower",
      "str_starts",
      "str_index",
      "str_slice",
      "str_char",
      "dispatch",
      "execute_command_plan",
      "str_join",
      "collect_prop",
      "to_int",
      "to_float",
      "str_split",
      "programmer_eval",
      "parents",
      "children",
      "valid",
      "verbs",
      "verb_info",
      "verb_code",
      "add_verb",
      "delete_verb",
      "set_verb_info",
      "set_verb_code",
      "compile_verb",
      "properties",
      "property_info",
      "add_property",
      "delete_property",
      "set_property_info",
      "clear_property",
      "is_clear_property",
      "authoring_inspect",
      "authoring_search",
      "set_object_name",
      "is_remote_object",
      "presence_status",
      "_dead_room_look_projection",
      "_dead_room_who_projection",
      "_dead_player_listing_projection",
      "_dead_object_examine_projection",
      "_dead_help_topic_projection",
      "present_actors",
      "_dead_connected_players",
      "session_metadata",
      "visible_contents",
      "obvious_verbs",
      "remote_describe",
      "active_actors",
      "listinsert",
      "object_tree_rows",
      "_dead_object_siblings_ordered",
      "room_roster",
      "ordered_children",
      "rank_between",
      "ordered_neighbors",
      "event_schema",
      "schedule",
      "schedule_at",
      "cancel_schedule"
    ];
    // The ENTIRE published list, not a prefix: freezing only the first N
    // still lets an insert after position N renumber everything later.
    // Appending is fine — the assertion below pins the new tail explicitly,
    // so adding a builtin means consciously extending this list.
    expect(BUILTIN_NAMES).toEqual(frozen);
    // The scheduling builtins must be at the END, after everything else.
    expect(BUILTIN_NAMES.slice(-3)).toEqual(["schedule", "schedule_at", "cancel_schedule"]);
    // No duplicates: a duplicate would make one index unreachable.
    expect(new Set(BUILTIN_NAMES).size).toBe(BUILTIN_NAMES.length);
  });

  it("names the removal when aged bytecode still carries FORK/SUSPEND/READ", async () => {
    // Verbs persisted before the parked-task deletion still contain these
    // opcodes. A bare "unknown VM opcode" is a worse diagnosis than saying
    // what happened and where to go.
    const { world, actor } = authedWorld();
    for (const op of ["FORK", "SUSPEND", "READ"]) {
      const bytecode: TinyBytecode = {
        literals: [],
        num_locals: 0,
        max_stack: 4,
        version: 1,
        ops: [["PUSH_INT", 1], [op, 0], ["RETURN"]] as never
      };
      await expect(
        runTinyVm(vmCtx(world, actor, "delay_1", `aged_${op.toLowerCase()}`), freezeTinyBytecode(bytecode), [])
      ).rejects.toMatchObject({ code: "E_VERSION" });
    }
  });
});
