import { describe, expect, it, vi } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { installVerb } from "../src/core/authoring";
import { BUILTIN_NAMES, runTinyVm } from "../src/core/tiny-vm";
import { dataKeyedMap, freezeTinyBytecode, hasOwnMapKey, type Message, type TinyBytecode, type VerbDef } from "../src/core/types";

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
      "has_surface",
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

// values.md §V6: a Woo map is DATA, never a host-language namespace. `key in
// map` and `map[key]` in TypeScript answer for the host prototype chain, so
// before this an empty Woo map claimed to contain `constructor`, `__proto__`
// and every other Object.prototype name — and reading one handed back a
// JavaScript function or a bare object, neither of which is a Woo value.
describe("map reads are own-key only (values.md §V6)", () => {
  async function evalBody(world: ReturnType<typeof createWorld>, actor: string, name: string, body: string) {
    const installed = installVerb(world, actor, name, `verb :${name}() rxd { ${body} }`, null);
    expect(installed.ok, JSON.stringify(installed.diagnostics)).toBe(true);
    return await world.directCall(undefined, actor, actor, name, []);
  }

  function programmerWorld(seed: string) {
    const world = createWorld();
    const session = world.auth(seed);
    world.object(session.actor).owner = session.actor;
    return { world, actor: session.actor };
  }

  it("treats every inherited host name as absent on an empty map", async () => {
    const { world, actor } = programmerWorld("guest:vm-own-key-miss");
    // Reads: absent is absent, and the miss is the SAME E_PROPNF an ordinary
    // missing key has always raised — this is a correctness fix, not a new
    // error vocabulary.
    for (const [index, key] of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"].entries()) {
      const frame = await evalBody(world, actor, `miss_get_${index}`, `let m = {}; return m[${JSON.stringify(key)}];`);
      expect(frame.op, `${key} did not raise`).toBe("error");
      if (frame.op === "error") expect(frame.error.code, `${key} raised the wrong code`).toBe("E_PROPNF");
    }
    // Membership agrees with the reads. `in` and `has` are the same question
    // asked two ways and must never disagree with each other or with a get.
    for (const [index, key] of ["constructor", "__proto__", "toString"].entries()) {
      const inFrame = await evalBody(world, actor, `miss_in_${index}`, `let m = {}; return ${JSON.stringify(key)} in m;`);
      expect(inFrame.op).toBe("result");
      if (inFrame.op === "result") expect(inFrame.result, `"${key}" in {}`).toBe(false);
      const hasFrame = await evalBody(world, actor, `miss_has_${index}`, `let m = {}; return has(m, ${JSON.stringify(key)});`);
      expect(hasFrame.op).toBe("result");
      if (hasFrame.op === "result") expect(hasFrame.result, `has({}, "${key}")`).toBe(false);
    }
  });

  it("round-trips a map that genuinely holds a reserved-looking key", async () => {
    // The negative of the rule: `constructor` as DATA is unremarkable and must
    // survive get, index-set, in, has, keys and iteration. A fix that made
    // these keys unusable would be as wrong as the leak.
    const { world, actor } = programmerWorld("guest:vm-own-key-hit");
    const read = await evalBody(world, actor, "own_get", `let m = {"constructor": 3}; return m["constructor"];`);
    expect(read.op === "result" && read.result).toBe(3);

    const membership = await evalBody(world, actor, "own_in", `let m = {"constructor": 3}; return ["constructor" in m, has(m, "constructor")];`);
    expect(membership.op === "result" && membership.result).toEqual([true, true]);

    const enumerated = await evalBody(world, actor, "own_keys", `let m = {"constructor": 3, "b": 4}; let out = []; for k, v in m { out = out + [k, v]; } return [keys(m), length(m), out];`);
    expect(enumerated.op === "result" && enumerated.result).toEqual([["constructor", "b"], 2, ["constructor", 3, "b", 4]]);

    const written = await evalBody(world, actor, "own_set", `let m = {}; m["constructor"] = 9; return [keys(m), m["constructor"], has(m, "constructor")];`);
    expect(written.op === "result" && written.result).toEqual([["constructor"], 9, true]);
  });

  it("still reads ordinary keys and still misses ordinary absent ones", async () => {
    // Guard against the fix over-reaching into normal map behavior.
    const { world, actor } = programmerWorld("guest:vm-own-key-ordinary");
    const hit = await evalBody(world, actor, "plain_hit", `let m = {"a": 1, "": 2}; return [m["a"], m[""], "a" in m, "" in m, has(m, "a")];`);
    expect(hit.op === "result" && hit.result).toEqual([1, 2, true, true, true]);
    const miss = await evalBody(world, actor, "plain_miss", `let m = {"a": 1}; return m["zz"];`);
    expect(miss.op).toBe("error");
    if (miss.op === "error") expect(miss.error.code).toBe("E_PROPNF");
    const missIn = await evalBody(world, actor, "plain_miss_in", `let m = {"a": 1}; return ["zz" in m, has(m, "zz")];`);
    expect(missIn.op === "result" && missIn.result).toEqual([false, false]);
  });

  it("carries a __proto__ key through the VM as ordinary map data", async () => {
    // The end-to-end half of the own-key rule, and it takes BOTH halves of the
    // §V6 work to pass: the read ops must ask own-key (this file's fix), and
    // clonePlainData — which every value crosses on its way onto the VM stack —
    // must write own-property rather than through the inherited __proto__
    // setter. Until the latter landed, a `__proto__` key could not reach the VM
    // as data at all and this could only be asserted at unit level below.
    const { world, actor } = programmerWorld("guest:vm-proto-data");
    const listed = await evalBody(world, actor, "proto_keys", `return keys({"__proto__": 5, "constructor": 7});`);
    expect(listed.op === "result" && listed.result).toEqual(["__proto__", "constructor"]);
    const read = await evalBody(world, actor, "proto_get", `let m = {"__proto__": 5}; return [m["__proto__"], "__proto__" in m, has(m, "__proto__")];`);
    expect(read.op === "result" && read.result).toEqual([5, true, true]);
    // …and the same key is still absent from a map that never held it.
    const bare = await evalBody(world, actor, "proto_absent", `return ["__proto__" in {}, has({}, "__proto__")];`);
    expect(bare.op === "result" && bare.result).toEqual([false, false]);
  });

  it("hasOwnMapKey is the one distinction, including for a key named __proto__", async () => {
    const own = Object.fromEntries([["__proto__", 5], ["constructor", 7]]);
    expect(hasOwnMapKey(own, "__proto__")).toBe(true);
    expect(hasOwnMapKey(own, "constructor")).toBe(true);
    expect(hasOwnMapKey({}, "__proto__")).toBe(false);
    expect(hasOwnMapKey({}, "constructor")).toBe(false);
    expect(hasOwnMapKey({}, "toString")).toBe(false);
    // A null-prototype map has nothing inherited to confuse it either.
    const bare = dataKeyedMap<number>();
    bare.a = 1;
    expect(hasOwnMapKey(bare, "a")).toBe(true);
    expect(hasOwnMapKey(bare, "constructor")).toBe(false);
  });
});

describe("maps keyed by data use a null prototype (values.md §V6)", () => {
  it("keeps an object legitimately named __proto__ in an id-keyed summary map", async () => {
    // Object ids are a DATA key space. `out[objRef] = summary` on a plain
    // object turns an id of `__proto__` into the map's prototype: hasOwn is
    // false, Object.keys is empty, and the object silently disappears from
    // every look/describe that reads this map. `__proto__` remains a legal
    // object id — the mint reservation only covers `.`.
    const world = createWorld();
    const session = world.auth("guest:vm-proto-id");
    const actor = session.actor;
    world.object(actor).owner = actor;
    world.createObject({ id: "__proto__", parent: "$thing", owner: actor, name: "Proto Thing", location: "$nowhere" });

    const summaries = await world.scopedObjectSummaries(actor, ["__proto__"]);
    expect(Object.getPrototypeOf(summaries)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(summaries, "__proto__")).toBe(true);
    expect(Object.keys(summaries)).toEqual(["__proto__"]);
    expect(summaries["__proto__"]?.id).toBe("__proto__");
  });
});
