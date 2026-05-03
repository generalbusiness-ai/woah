import { compileWooSource } from "./dsl-compiler";
import { hashSource } from "./source-hash";
import type { CompileResult, InstallResult, ObjRef, TinyBytecode, TinyOp, WooValue } from "./types";
import { isErrorValue, wooError } from "./types";
import { normalizeVerbPerms } from "./verb-perms";
import type { WooWorld } from "./world";

type AuthoringOptions = {
  format?: "t0-source" | "woo-source" | "t0-json-bytecode";
};

type StackEffect = { requires: number; delta: number; exits?: boolean };

const BYTECODE_LIMITS = {
  ops: 10_000,
  literals: 4_096,
  literalBytes: 512 * 1024,
  locals: 1_024,
  stack: 4_096,
  ticks: 1_000_000,
  memory: 16 * 1024 * 1024,
  wallMs: 10_000
};

export function compileVerb(source: string, options: AuthoringOptions = {}): CompileResult {
  const format = options.format ?? inferFormat(source);
  if (format === "t0-json-bytecode") {
    try {
      const bytecode = JSON.parse(source) as TinyBytecode;
      verifyBytecode(bytecode);
      return { ok: true, diagnostics: [], bytecode, source_hash: hashSource(source) };
    } catch (err) {
      return {
        ok: false,
        diagnostics: [compileDiagnostic(err)]
      };
    }
  }
  const compiled = compileWooSource(source);
  if (!compiled.ok || !compiled.bytecode) return compiled;
  try {
    verifyBytecode(compiled.bytecode);
    return compiled;
  } catch (err) {
    return { ok: false, diagnostics: [compileDiagnostic(err)] };
  }
}

export function installVerb(world: WooWorld, obj: ObjRef, name: string, source: string, expectedVersion: number | null, options: AuthoringOptions = {}): InstallResult {
  const target = world.object(obj);
  return installVerbWithOwner(world, obj, name, source, expectedVersion, target.owner, options);
}

export function installVerbAs(world: WooWorld, actor: ObjRef, obj: ObjRef, name: string, source: string, expectedVersion: number | null, options: AuthoringOptions = {}): InstallResult {
  world.assertCanAuthorObject(actor, obj);
  return installVerbWithOwner(world, obj, name, source, expectedVersion, actor, options);
}

function installVerbWithOwner(world: WooWorld, obj: ObjRef, name: string, source: string, expectedVersion: number | null, owner: ObjRef, options: AuthoringOptions = {}): InstallResult {
  const target = world.object(obj);
  world.object(owner);
  const current = world.ownVerbExact(obj, name);
  if ((current?.version ?? null) !== expectedVersion) {
    throw wooError("E_VERSION", "verb version conflict", { expected: expectedVersion, actual: current?.version ?? null });
  }
  const compiled = compileVerb(source, options);
  if (!compiled.ok || !compiled.bytecode) return { ok: false, version: current?.version ?? 0, diagnostics: compiled.diagnostics };
  if (compiled.metadata?.name && compiled.metadata.name !== name) {
    return {
      ok: false,
      version: current?.version ?? 0,
      diagnostics: [{ severity: "error", code: "E_COMPILE", message: `verb header names :${compiled.metadata.name}, but install target is :${name}` }]
    };
  }
  const version = (current?.version ?? 0) + 1;
  const parsedPerms = normalizeVerbPerms(
    compiled.metadata?.perms ?? current?.perms ?? "rx",
    compiled.metadata?.perms ? false : current?.direct_callable === true
  );
  world.addVerb(obj, {
    kind: "bytecode",
    name,
    aliases: current?.aliases ?? [],
    owner,
    perms: parsedPerms.perms,
    arg_spec: compiled.metadata?.arg_spec ?? current?.arg_spec ?? {},
    direct_callable: parsedPerms.directCallable,
    skip_presence_check: current?.skip_presence_check,
    tool_exposed: current?.tool_exposed,
    source,
    source_hash: compiled.source_hash ?? hashSource(source),
    bytecode: { ...compiled.bytecode, version },
    version,
    line_map: compiled.line_map ?? {}
  });
  return { ok: true, version };
}

export function definePropertyVersioned(world: WooWorld, obj: ObjRef, name: string, defaultValue: WooValue, perms: string, expectedVersion: number | null, typeHint?: string) {
  const target = world.object(obj);
  return definePropertyVersionedWithOwner(world, obj, name, defaultValue, perms, expectedVersion, target.owner, typeHint);
}

export function definePropertyVersionedAs(world: WooWorld, actor: ObjRef, obj: ObjRef, name: string, defaultValue: WooValue, perms: string, expectedVersion: number | null, typeHint?: string) {
  world.assertCanAuthorObject(actor, obj);
  return definePropertyVersionedWithOwner(world, obj, name, defaultValue, perms, expectedVersion, actor, typeHint);
}

function definePropertyVersionedWithOwner(world: WooWorld, obj: ObjRef, name: string, defaultValue: WooValue, perms: string, expectedVersion: number | null, owner: ObjRef, typeHint?: string) {
  const target = world.object(obj);
  const current = target.propertyDefs.get(name);
  if ((current?.version ?? null) !== expectedVersion) {
    throw wooError("E_VERSION", "property definition version conflict", { expected: expectedVersion, actual: current?.version ?? null });
  }
  return world.defineProperty(obj, {
    name,
    defaultValue,
    perms,
    owner,
    typeHint,
    version: (current?.version ?? 0) + 1
  });
}

export function setPropertyValueVersionedAs(world: WooWorld, actor: ObjRef, obj: ObjRef, name: string, value: WooValue, expectedVersion: number | null = null) {
  world.assertCanAuthorObject(actor, obj);
  const current = world.object(obj).propertyVersions.get(name) ?? null;
  if (expectedVersion !== null && current !== expectedVersion) {
    throw wooError("E_VERSION", "property value version conflict", { expected: expectedVersion, actual: current });
  }
  world.setProp(obj, name, value);
  return world.propertyInfo(obj, name);
}

function inferFormat(source: string): "t0-source" | "t0-json-bytecode" {
  return source.trim().startsWith("{") ? "t0-json-bytecode" : "t0-source";
}

function verifyBytecode(bytecode: TinyBytecode): void {
  if (!bytecode || !Array.isArray(bytecode.ops) || !Array.isArray(bytecode.literals)) {
    throw wooError("E_COMPILE", "invalid TinyBytecode shape");
  }
  if (!isIntegerInRange(bytecode.version, 0, Number.MAX_SAFE_INTEGER)) throw wooError("E_COMPILE", "bytecode version must be a non-negative integer");
  if (!isIntegerInRange(bytecode.num_locals, 0, BYTECODE_LIMITS.locals)) throw wooError("E_COMPILE", `bytecode num_locals exceeds limit ${BYTECODE_LIMITS.locals}`);
  if (!isIntegerInRange(bytecode.max_stack, 0, BYTECODE_LIMITS.stack)) throw wooError("E_COMPILE", `bytecode max_stack exceeds limit ${BYTECODE_LIMITS.stack}`);
  if (bytecode.ops.length > BYTECODE_LIMITS.ops) throw wooError("E_COMPILE", `bytecode op count exceeds limit ${BYTECODE_LIMITS.ops}`);
  if (bytecode.ops.length === 0) throw wooError("E_COMPILE", "bytecode must contain at least one opcode");
  if (bytecode.literals.length > BYTECODE_LIMITS.literals) throw wooError("E_COMPILE", `bytecode literal count exceeds limit ${BYTECODE_LIMITS.literals}`);
  if (bytecode.max_ticks !== undefined && !isIntegerInRange(bytecode.max_ticks, 1, BYTECODE_LIMITS.ticks)) throw wooError("E_COMPILE", `bytecode max_ticks exceeds limit ${BYTECODE_LIMITS.ticks}`);
  if (bytecode.max_memory !== undefined && !isIntegerInRange(bytecode.max_memory, 1, BYTECODE_LIMITS.memory)) throw wooError("E_COMPILE", `bytecode max_memory exceeds limit ${BYTECODE_LIMITS.memory}`);
  if (bytecode.max_wall_ms !== undefined && !isIntegerInRange(bytecode.max_wall_ms, 1, BYTECODE_LIMITS.wallMs)) throw wooError("E_COMPILE", `bytecode max_wall_ms exceeds limit ${BYTECODE_LIMITS.wallMs}`);
  const literalBytes = new TextEncoder().encode(JSON.stringify(bytecode.literals)).byteLength;
  if (literalBytes > BYTECODE_LIMITS.literalBytes) throw wooError("E_COMPILE", `bytecode literals exceed ${BYTECODE_LIMITS.literalBytes} bytes`);
  for (let pc = 0; pc < bytecode.ops.length; pc++) {
    const item = bytecode.ops[pc];
    if (!Array.isArray(item) || typeof item[0] !== "string") throw wooError("E_COMPILE", "invalid opcode shape");
    const [op] = item;
    if (!VALID_OPS.has(op)) throw wooError("E_COMPILE", `unknown opcode ${op}`);
    verifyOpcodeShape(bytecode, pc, item);
  }
  verifyStackGraph(bytecode);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function compileDiagnostic(err: unknown): CompileResult["diagnostics"][number] {
  if (isErrorValue(err)) return { severity: "error", code: err.code, message: err.message ?? err.code };
  return { severity: "error", code: "E_COMPILE", message: err instanceof Error ? err.message : String(err) };
}

function verifyOpcodeShape(bytecode: TinyBytecode, pc: number, item: TinyOp): void {
  const [op] = item;
  expectArity(pc, item, opcodeArity(op));
  switch (op) {
    case "PUSH_LIT":
    case "TRY_PUSH":
      expectLiteral(bytecode, pc, item[op === "TRY_PUSH" ? 2 : 1]);
      if (op === "TRY_PUSH") {
        const errors = bytecode.literals[expectInteger(pc, item[2], "TRY_PUSH error literal")];
        if (!Array.isArray(errors) || !errors.every((value) => typeof value === "string")) {
          throw compileErrorAt(pc, "TRY_PUSH error literal must be a list of error-code strings");
        }
      }
      break;
    case "PUSH_LOCAL":
    case "POP_LOCAL":
    case "FOR_LIST_INIT":
    case "FOR_RANGE_INIT":
      expectLocal(bytecode, pc, item[1]);
      break;
    case "FOR_LIST_NEXT":
    case "FOR_RANGE_NEXT":
      expectLocal(bytecode, pc, item[1]);
      expectJumpTarget(bytecode, pc, item[2]);
      break;
    case "FOR_MAP_NEXT":
      expectLocal(bytecode, pc, item[1]);
      expectLocal(bytecode, pc, item[2]);
      expectJumpTarget(bytecode, pc, item[3]);
      break;
    case "PUSH_INT":
    case "PUSH_ARG":
    case "CALL_VERB":
    case "PASS":
    case "MAKE_MAP":
    case "MAKE_LIST":
    case "STR_CONCAT":
    case "STR_INTERP":
    case "FORK":
      expectNonNegativeInteger(pc, item[1], `${op} operand`);
      break;
    case "BUILTIN":
      if (typeof item[1] !== "string" || !VALID_BUILTINS.has(item[1])) throw compileErrorAt(pc, `unknown builtin ${String(item[1])}`);
      expectNonNegativeInteger(pc, item[2], "BUILTIN argc");
      break;
    case "JUMP":
    case "JUMP_IF_TRUE":
    case "JUMP_IF_FALSE":
    case "JUMP_IF_TRUE_KEEP":
    case "JUMP_IF_FALSE_KEEP":
      expectJumpTarget(bytecode, pc, item[1]);
      break;
    case "SPLAT":
      throw compileErrorAt(pc, "SPLAT is not accepted in installable bytecode until static stack verification supports variable stack effects");
  }
}

function verifyStackGraph(bytecode: TinyBytecode): void {
  const heights = new Map<number, number>();
  const work: Array<{ pc: number; height: number }> = [];
  const enqueue = (pc: number, height: number): void => {
    if (pc === bytecode.ops.length) return;
    if (pc < 0 || pc > bytecode.ops.length) throw compileErrorAt(pc, "control flow leaves bytecode bounds");
    const previous = heights.get(pc);
    if (previous !== undefined) {
      if (previous !== height) throw compileErrorAt(pc, `inconsistent stack height at control-flow join: ${previous} vs ${height}`);
      return;
    }
    heights.set(pc, height);
    work.push({ pc, height });
  };

  enqueue(0, 0);
  while (work.length > 0) {
    const { pc, height } = work.shift()!;
    const item = bytecode.ops[pc];
    const effect = stackEffect(pc, item);
    if (height < effect.requires) throw compileErrorAt(pc, `stack underflow for ${item[0]}`);
    const nextHeight = height + effect.delta;
    if (nextHeight < 0) throw compileErrorAt(pc, `stack underflow for ${item[0]}`);
    if (nextHeight > bytecode.max_stack) throw compileErrorAt(pc, `max_stack ${bytecode.max_stack} is too small for ${item[0]}`);

    if (item[0] === "TRY_PUSH") {
      const handlerHeight = nextHeight + 1;
      if (handlerHeight > bytecode.max_stack) throw compileErrorAt(pc, `max_stack ${bytecode.max_stack} cannot catch errors at this handler depth`);
      enqueue(jumpTarget(pc, item[1]), handlerHeight);
    }
    if (effect.exits) continue;
    for (const target of successors(bytecode, pc, item)) enqueue(target, nextHeight);
  }
}

function successors(bytecode: TinyBytecode, pc: number, item: TinyOp): number[] {
  const next = pc + 1;
  switch (item[0]) {
    case "JUMP":
      return [jumpTarget(pc, item[1])];
    case "JUMP_IF_TRUE":
    case "JUMP_IF_FALSE":
    case "JUMP_IF_TRUE_KEEP":
    case "JUMP_IF_FALSE_KEEP":
    case "FOR_LIST_NEXT":
    case "FOR_RANGE_NEXT":
      return [next, jumpTarget(pc, item[0].startsWith("FOR_") ? item[2] : item[1])];
    case "FOR_MAP_NEXT":
      return [next, jumpTarget(pc, item[3])];
    default:
      return next <= bytecode.ops.length ? [next] : [];
  }
}

function stackEffect(pc: number, item: TinyOp): StackEffect {
  const [op] = item;
  switch (op) {
    case "PUSH_LIT":
    case "PUSH_INT":
    case "PUSH_LOCAL":
    case "PUSH_THIS":
    case "PUSH_ACTOR":
    case "PUSH_PLAYER":
    case "PUSH_CALLER":
    case "PUSH_PROGR":
    case "PUSH_VERB":
    case "PUSH_ARGS":
    case "PUSH_SPACE":
    case "PUSH_SEQ":
    case "PUSH_MESSAGE":
    case "PUSH_ARG":
      return { requires: 0, delta: 1 };
    case "POP_LOCAL":
    case "POP":
    case "NEG":
    case "NOT":
      return { requires: 1, delta: op === "POP" || op === "POP_LOCAL" ? -1 : 0 };
    case "DUP":
      return { requires: 1, delta: 1 };
    case "SWAP":
      return { requires: 2, delta: 0 };
    case "ADD":
    case "SUB":
    case "MUL":
    case "DIV":
    case "MOD":
    case "EQ":
    case "NEQ":
    case "LT":
    case "LE":
    case "GT":
    case "GE":
    case "IN":
    case "GET_PROP":
    case "HAS_PROP":
    case "PROP_INFO":
    case "LIST_GET":
    case "LIST_APPEND":
    case "MAP_GET":
    case "INDEX_GET":
      return { requires: 2, delta: -1 };
    case "JUMP":
    case "YIELD":
    case "TRY_PUSH":
    case "TRY_POP":
      return { requires: 0, delta: 0 };
    case "JUMP_IF_TRUE":
    case "JUMP_IF_FALSE":
      return { requires: 1, delta: -1 };
    case "JUMP_IF_TRUE_KEEP":
    case "JUMP_IF_FALSE_KEEP":
      return { requires: 1, delta: 0 };
    case "FOR_LIST_INIT":
    case "FOR_MAP_INIT":
      return { requires: 1, delta: 1 };
    case "FOR_LIST_NEXT":
    case "FOR_RANGE_INIT":
    case "FOR_RANGE_NEXT":
    case "FOR_MAP_NEXT":
      return { requires: 2, delta: 0 };
    case "FOR_END":
    case "UNDEFINE_PROP":
    case "EMIT":
      return { requires: 2, delta: -2 };
    case "SET_PROP":
    case "SET_PROP_INFO":
    case "LIST_SET":
    case "MAP_SET":
    case "INDEX_SET":
      return { requires: 3, delta: op === "SET_PROP" || op === "SET_PROP_INFO" ? -3 : -2 };
    case "DEFINE_PROP":
      return { requires: 4, delta: -4 };
    case "CALL_VERB": {
      const argc = expectNonNegativeInteger(pc, item[1], "CALL_VERB argc");
      return { requires: argc + 2, delta: -argc - 1 };
    }
    case "PASS": {
      const argc = expectNonNegativeInteger(pc, item[1], "PASS argc");
      return { requires: argc, delta: -argc + 1 };
    }
    case "RETURN":
      return { requires: 1, delta: -1, exits: true };
    case "RAISE":
    case "FAIL":
      return { requires: 1, delta: -1, exits: true };
    case "BUILTIN": {
      const argc = expectNonNegativeInteger(pc, item[2], "BUILTIN argc");
      return { requires: argc, delta: -argc + 1 };
    }
    case "MAKE_MAP": {
      const count = expectNonNegativeInteger(pc, item[1], "MAKE_MAP count");
      return { requires: count * 2, delta: 1 - count * 2 };
    }
    case "MAKE_LIST":
    case "STR_CONCAT":
    case "STR_INTERP": {
      const count = expectNonNegativeInteger(pc, item[1], `${op} count`);
      return { requires: count, delta: 1 - count };
    }
    case "OBSERVE":
      return { requires: 1, delta: -1 };
    case "FORK": {
      const argc = expectNonNegativeInteger(pc, item[1], "FORK argc");
      return { requires: argc + 3, delta: -argc - 2 };
    }
    case "SUSPEND":
    case "READ":
      return { requires: 1, delta: 0 };
    default:
      throw compileErrorAt(pc, `unknown opcode ${op}`);
  }
}

function opcodeArity(op: string): number {
  if ([
    "PUSH_THIS", "PUSH_ACTOR", "PUSH_PLAYER", "PUSH_CALLER", "PUSH_PROGR", "PUSH_VERB", "PUSH_ARGS", "PUSH_SPACE", "PUSH_SEQ", "PUSH_MESSAGE",
    "POP", "DUP", "SWAP", "ADD", "SUB", "MUL", "DIV", "MOD", "NEG", "NOT", "EQ", "NEQ", "LT", "LE", "GT", "GE", "IN",
    "FOR_MAP_INIT", "FOR_END", "GET_PROP", "SET_PROP", "HAS_PROP", "DEFINE_PROP", "UNDEFINE_PROP", "PROP_INFO", "SET_PROP_INFO",
    "RETURN", "RAISE", "FAIL", "LIST_GET", "LIST_SET", "LIST_APPEND", "MAP_GET", "MAP_SET", "INDEX_GET", "INDEX_SET", "SPLAT",
    "OBSERVE", "EMIT", "YIELD", "SUSPEND", "READ", "TRY_POP"
  ].includes(op)) return 0;
  if ([
    "PUSH_LIT", "PUSH_INT", "PUSH_LOCAL", "POP_LOCAL", "PUSH_ARG", "JUMP", "JUMP_IF_TRUE", "JUMP_IF_FALSE", "JUMP_IF_TRUE_KEEP", "JUMP_IF_FALSE_KEEP",
    "FOR_LIST_INIT", "FOR_RANGE_INIT", "CALL_VERB", "PASS", "MAKE_MAP", "MAKE_LIST", "STR_CONCAT", "STR_INTERP", "FORK"
  ].includes(op)) return 1;
  if (["FOR_LIST_NEXT", "FOR_RANGE_NEXT", "BUILTIN", "TRY_PUSH"].includes(op)) return 2;
  if (op === "FOR_MAP_NEXT") return 3;
  throw wooError("E_COMPILE", `unknown opcode ${op}`);
}

function expectArity(pc: number, item: TinyOp, operands: number): void {
  if (item.length !== operands + 1) throw compileErrorAt(pc, `${item[0]} expects ${operands} operand(s), got ${item.length - 1}`);
}

function expectLiteral(bytecode: TinyBytecode, pc: number, value: WooValue | undefined): number {
  const index = expectNonNegativeInteger(pc, value, "literal index");
  if (index >= bytecode.literals.length) throw compileErrorAt(pc, `literal index out of range: ${index}`);
  return index;
}

function expectLocal(bytecode: TinyBytecode, pc: number, value: WooValue | undefined): number {
  const index = expectNonNegativeInteger(pc, value, "local index");
  if (index >= bytecode.num_locals) throw compileErrorAt(pc, `local index out of range: ${index}`);
  return index;
}

function expectJumpTarget(bytecode: TinyBytecode, pc: number, value: WooValue | undefined): number {
  const target = jumpTarget(pc, value);
  if (target < 0 || target > bytecode.ops.length) throw compileErrorAt(pc, `jump target out of range: ${target}`);
  return target;
}

function jumpTarget(pc: number, offset: WooValue | undefined): number {
  return pc + expectInteger(pc, offset, "jump offset") + 1;
}

function expectNonNegativeInteger(pc: number, value: WooValue | undefined, label: string): number {
  const number = expectInteger(pc, value, label);
  if (number < 0) throw compileErrorAt(pc, `${label} must be non-negative`);
  return number;
}

function expectInteger(pc: number, value: WooValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw compileErrorAt(pc, `${label} must be a safe integer`);
  }
  return value;
}

function compileErrorAt(pc: number, message: string): never {
  throw wooError("E_COMPILE", `bytecode pc ${pc}: ${message}`);
}

const VALID_OPS = new Set([
  "PUSH_LIT",
  "PUSH_INT",
  "PUSH_LOCAL",
  "POP_LOCAL",
  "PUSH_THIS",
  "PUSH_ACTOR",
  "PUSH_PLAYER",
  "PUSH_CALLER",
  "PUSH_PROGR",
  "PUSH_VERB",
  "PUSH_ARGS",
  "PUSH_SPACE",
  "PUSH_SEQ",
  "PUSH_MESSAGE",
  "PUSH_ARG",
  "POP",
  "DUP",
  "SWAP",
  "ADD",
  "SUB",
  "MUL",
  "DIV",
  "MOD",
  "NEG",
  "NOT",
  "EQ",
  "NEQ",
  "LT",
  "LE",
  "GT",
  "GE",
  "IN",
  "JUMP",
  "JUMP_IF_TRUE",
  "JUMP_IF_FALSE",
  "JUMP_IF_TRUE_KEEP",
  "JUMP_IF_FALSE_KEEP",
  "FOR_LIST_INIT",
  "FOR_LIST_NEXT",
  "FOR_RANGE_INIT",
  "FOR_RANGE_NEXT",
  "FOR_MAP_INIT",
  "FOR_MAP_NEXT",
  "FOR_END",
  "GET_PROP",
  "SET_PROP",
  "HAS_PROP",
  "DEFINE_PROP",
  "UNDEFINE_PROP",
  "PROP_INFO",
  "SET_PROP_INFO",
  "CALL_VERB",
  "PASS",
  "RETURN",
  "RAISE",
  "BUILTIN",
  "LIST_GET",
  "LIST_SET",
  "LIST_APPEND",
  "MAP_GET",
  "MAP_SET",
  "INDEX_GET",
  "INDEX_SET",
  "MAKE_MAP",
  "MAKE_LIST",
  "STR_CONCAT",
  "STR_INTERP",
  "SPLAT",
  "OBSERVE",
  "EMIT",
  "YIELD",
  "SUSPEND",
  "READ",
  "FORK",
  "TRY_PUSH",
  "TRY_POP",
  "FAIL"
]);

const VALID_BUILTINS = new Set([
  "length",
  "keys",
  "values",
  "has",
  "typeof",
  "to_string",
  "tostr",
  "min",
  "max",
  "floor",
  "ceil",
  "round",
  "abs",
  "str_trim",
  "str_lower",
  "str_starts",
  "str_index",
  "str_slice",
  "str_char",
  "str_join",
  "now",
  "create",
  "move",
  "moveto",
  "chparent",
  "has_flag",
  "isa",
  "random",
  "contents",
  "location",
  "task_perms",
  "caller_perms",
  "set_task_perms",
  "set_presence",
  "observe_to_space",
  "tell",
  "dispatch",
  "collect_prop",
  "builder_create_object",
  "builder_chparent",
  "builder_recycle",
  "builder_set_property",
  "builder_inspect",
  "builder_search",
  "programmer_inspect",
  "programmer_resolve_verb",
  "programmer_list_verb",
  "programmer_search",
  "programmer_install_verb",
  "programmer_set_verb_info",
  "programmer_set_property_info",
  "programmer_trace",
  "editor_invoke",
  "editor_what",
  "editor_view",
  "editor_replace",
  "editor_insert",
  "editor_delete",
  "editor_dry_run",
  "editor_save",
  "editor_pause",
  "editor_abort"
]);
